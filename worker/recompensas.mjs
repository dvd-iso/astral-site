// Recompensas: motor de concessões configurável, idempotente e auditável para Prisma (que o Worker guarda) e Iris
// (cujo saldo é local do plugin; aqui o Worker só decide, limita e audita). Módulo isolado: exige RECOMPENSAS_ATIVO = "sim"
// e uma regra ativa em `recompensa_regras`. NENHUM valor, preço ou regra de conversão vem de fábrica: a tabela nasce vazia.
//
// Garantias:
// - Idempotência: UNIQUE (regra_id, chave). O mesmo evento (mensagem do Discord, conquista, janela de tempo) paga uma vez.
// - Tetos aplicados DENTRO do INSERT (atômico): por jogador/dia, por conta Discord/dia (contra contas alternativas),
//   global/dia, por jogador/total, intervalo mínimo e, por moeda, o disjuntor de emissão mensal (recompensa_tetos_moeda,
//   todas as regras somadas). Concorrência não passa do teto.
// - Prisma: a concessão e o lançamento no livro-razão entram na mesma transação. Iris: nasce "autorizada" e o plugin
//   confirma depois de creditar no saldo local; autorizações sem confirmação aparecem em /pendentes.
// - Recusas não viram linha (spam não amplifica escritas): só um contador por regra, dia e motivo.
// - Discord: o evento precisa dos ids (usuário, canal, mensagem) e a chave é derivada da mensagem. Opcionalmente
//   (regra.verificar_discord = 1 e DISCORD_BOT_TOKEN) o Worker relê a mensagem na API do Discord antes de pagar.
//   Allowlist de canais por regra (recompensa_canais): fora da lista, ou sem lista, a regra de Discord recusa `canal_nao_permitido`.
//   O Gateway usa só metadados (autor, tipo, bot/webhook, canal); não há MESSAGE_CONTENT nem filtro de texto.

import {criarIris} from './iris.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOME_RE = /^[A-Za-z0-9_]{3,16}$/;
const REGRA_RE = /^[a-z][a-z0-9_]{2,39}$/;
const CHAVE_RE = /^[A-Za-z0-9_:.\/-]{8,120}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const DISCORD_API = "https://discord.com/api/v10";
const IDADE_MAXIMA_EVENTO_SEGUNDOS = 15 * 60;
const RELOGIO_FOLGA_SEGUNDOS = 300;               // `ocorrido_em` no futuro além disso é rejeitado
const FUSO_SEGUNDOS = 3 * 3600;                    // dia de Brasília (UTC-3, sem horário de verão desde 2019)

export const recompensasAtivas = env => env.RECOMPENSAS_ATIVO === "sim";
export const diaDeBrasilia = t => Math.floor((t - FUSO_SEGUNDOS) / 86400);
/** Início (inclusive) e fim (exclusivo) do mês de Brasília que contém t, em segundos Unix. */
export function mesDeBrasilia(t) {
  const d = new Date((t - FUSO_SEGUNDOS) * 1000);
  const ini = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 + FUSO_SEGUNDOS;
  const fim = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000 + FUSO_SEGUNDOS;
  return {inicio: ini, fim};
}

export function criarRecompensas(h) {
  const {Erro, lerJson, agora, saldoDe, prismaAtivo} = h;
  const iris = criarIris({Erro, agora});
  const validarJogador = (uuid, nome) => {
    if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) throw new Erro(400, 'uuid_invalido');
    if (typeof nome !== 'string' || !NOME_RE.test(nome)) throw new Erro(400, 'nome_invalido');
  };

  const exigirAtivo = env => { if (!recompensasAtivas(env)) throw new Erro(404, "recompensas_desativadas"); };

  const contar = (env, regraId, dia, motivo) => env.DB.prepare(
    `INSERT INTO recompensa_recusas (regra_id, dia, motivo, contagem) VALUES (?, ?, ?, 1)
     ON CONFLICT (regra_id, dia, motivo) DO UPDATE SET contagem = contagem + 1`).bind(regraId, dia, motivo).run();

  const recusar = async (env, regraId, dia, motivo) => {
    await contar(env, regraId, dia, motivo);
    return {concedida: false, motivo};
  };

  /** Evidência: só ids curtos e verificáveis, nunca conteúdo de mensagem. */
  function validarEvidencia(regra, evidencia, chave) {
    const ehDiscord = regra.fonte.startsWith("discord");
    if (!ehDiscord && (evidencia === undefined || evidencia === null)) return {json: null, discordId: null};
    if (!evidencia || typeof evidencia !== "object" || Array.isArray(evidencia)) throw new Erro(400, "evidencia_invalida");
    const chaves = Object.keys(evidencia);
    if (chaves.length > 6) throw new Erro(400, "evidencia_invalida");
    for (const k of chaves) {
      const v = evidencia[k];
      if (!/^[a-z_]{2,32}$/.test(k) || typeof v !== "string" || !/^[A-Za-z0-9_:.\/-]{1,64}$/.test(v)) throw new Erro(400, "evidencia_invalida");
    }
    if (!ehDiscord) return {json: JSON.stringify(evidencia), discordId: null};
    if (chaves.some(k => !["discord_user_id", "canal_id", "mensagem_id"].includes(k))) throw new Erro(400, "evidencia_invalida"); // nada de conteúdo
    const {discord_user_id: usuario, canal_id: canal, mensagem_id: mensagem} = evidencia;
    if (![usuario, canal, mensagem].every(v => typeof v === "string" && SNOWFLAKE_RE.test(v))) throw new Erro(400, "evidencia_invalida");
    if (chave !== `discord:${canal}:${mensagem}`) throw new Erro(400, "chave_invalida"); // a chave É a mensagem: não dá para burlar o dedupe
    return {json: JSON.stringify({discord_user_id: usuario, canal_id: canal, mensagem_id: mensagem}), discordId: usuario};
  }

  /** Relê a mensagem no Discord. Devolve null se confere, ou o motivo da recusa. Falha de rede = erro (o plugin tenta de novo). */
  async function verificarDiscord(env, {discordId, canalId, mensagemId}) {
    if (!env.DISCORD_BOT_TOKEN) return "verificacao_indisponivel";
    const r = await fetch(`${env.DISCORD_API || DISCORD_API}/channels/${canalId}/messages/${mensagemId}`, {headers: {Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`}});
    if (r.status === 404) return "evento_inexistente";
    if (!r.ok) throw new Erro(502, "discord_indisponivel", {status: r.status});
    const m = await r.json();
    if (String(m.channel_id) !== canalId) return "canal_divergente";
    if (String(m.author?.id) !== discordId) return "autor_divergente";
    if (m.author?.bot) return "autor_bot";
    const idade = agora() - Math.floor(Date.parse(m.timestamp) / 1000);
    if (!Number.isFinite(idade) || idade > IDADE_MAXIMA_EVENTO_SEGUNDOS || idade < -60) return "evento_antigo";
    return null;
  }

  /** Por que o teto barrou (mesma ordem do INSERT). Só diagnóstico: quem decide é o INSERT atômico. */
  async function motivoDoTeto(env, regra, {uuid, advancementId, discordId, dia, unidades, t, quantidade, tetoMes, mes, mensal}) {
    if (advancementId && await iris.jaPaga(env, uuid, advancementId)) return 'conquista_ja_recompensada';
    const soma = async (extra, ...args) => (await env.DB.prepare(`SELECT COALESCE(SUM(unidades), 0) AS s FROM concessoes WHERE regra_id = ? ${extra}`).bind(regra.id, ...args).first("s")) || 0;
    if (await soma("AND uuid = ? AND dia = ?", uuid, dia) + unidades > regra.max_unidades_dia) return "teto_diario_jogador";
    if (discordId && await soma("AND discord_id = ? AND dia = ?", discordId, dia) + unidades > regra.max_unidades_dia) return "teto_diario_conta_discord";
    if (regra.max_unidades_dia_global != null && await soma("AND dia = ?", dia) + unidades > regra.max_unidades_dia_global) return "teto_diario_global";
    if (regra.max_unidades_total != null && await soma("AND uuid = ?", uuid) + unidades > regra.max_unidades_total) return "teto_total_jogador";
    if (regra.intervalo_minimo_segundos > 0
      && await env.DB.prepare("SELECT 1 AS x FROM concessoes WHERE regra_id = ? AND uuid = ? AND criado_em > ? LIMIT 1").bind(regra.id, uuid, t - regra.intervalo_minimo_segundos).first()) return "intervalo_minimo";
    if (tetoMes != null && await env.DB.prepare("SELECT COALESCE(SUM(quantidade), 0) AS s FROM concessoes WHERE moeda = ? AND criado_em >= ? AND criado_em < ?").bind(regra.moeda, mes.inicio, mes.fim).first("s") + quantidade > tetoMes) return "teto_mensal_emissao";
    if (mensal && await env.DB.prepare("SELECT COALESCE(SUM(quantidade), 0) AS s FROM concessoes WHERE moeda = 'iris' AND criado_em >= ? AND criado_em < ?")
      .bind(mes.inicio, mes.fim).first('s') + quantidade > await iris.tetoMensal(env, mes, mensal.recorrente)) return 'teto_mensal_emissao';
    return "limite";
  }

  const resposta = async (env, c, regra, repetido) => ({
    concedida: true, repetido, estado: c.estado, moeda: c.moeda, unidades: c.unidades, quantidade: c.quantidade, concessao_id: c.id,
    ...(c.moeda === "prisma" ? {saldo: await saldoDe(env, c.uuid)} : {}),
  });

  async function conceder(env, corpo) {
    const {uuid, nome, regra: regraId, chave, evidencia} = corpo;
    const unidades = corpo.unidades === undefined ? 1 : corpo.unidades;
    validarJogador(uuid, nome);
    if (typeof regraId !== "string" || !REGRA_RE.test(regraId)) throw new Erro(400, "regra_invalida");
    if (typeof chave !== "string" || !CHAVE_RE.test(chave)) throw new Erro(400, "chave_invalida");
    if (!Number.isInteger(unidades) || unidades < 1 || unidades > 100000) throw new Erro(400, "unidades_invalidas");
    // Momento (segundos Unix) em que o plugin gravou o evento; opcional. No futuro além da folga de relógio = inválido.
    const ocorridoEm = corpo.ocorrido_em;
    if (ocorridoEm !== undefined && ocorridoEm !== null && (!Number.isInteger(ocorridoEm) || ocorridoEm < 1 || ocorridoEm > agora() + RELOGIO_FOLGA_SEGUNDOS)) throw new Erro(400, "ocorrido_em_invalido");
    const regra = await env.DB.prepare("SELECT * FROM recompensa_regras WHERE id = ?").bind(regraId).first();
    if (!regra) throw new Erro(404, "regra_desconhecida");
    const t = agora();
    const dia = diaDeBrasilia(t);

    // Mesmo evento de novo: devolve o que já foi decidido (nunca paga de novo), mesmo se a regra mudou depois.
    const existente = await env.DB.prepare("SELECT * FROM concessoes WHERE regra_id = ? AND chave = ?").bind(regraId, chave).first();
    if (existente) {
      if (existente.uuid !== uuid) throw new Erro(409, "chave_em_uso");
      return resposta(env, existente, regra, true);
    }
    if (!regra.ativo) return recusar(env, regraId, dia, "regra_inativa");
    const conquistaRecusa = await iris.verificarConquista(env, regra, {uuid, chave, unidades, ocorridoEm});
    if (conquistaRecusa) return recusar(env, regraId, dia, conquistaRecusa);
    const advancementId = iris.idConquista(regra, uuid, chave);
    if (regra.moeda === "prisma" && !prismaAtivo(env)) return recusar(env, regraId, dia, "prisma_desativado");
    if (unidades > regra.max_unidades_por_chamada) return recusar(env, regraId, dia, "unidades_acima_do_permitido");
    // Idade máxima do evento por regra (NULL = sem limite). Sem `ocorrido_em` o Worker não tem como julgar e aceita, como antes.
    if (regra.idade_maxima_segundos !== null && regra.idade_maxima_segundos !== undefined && Number.isInteger(ocorridoEm) && t - ocorridoEm > regra.idade_maxima_segundos) {
      return recusar(env, regraId, dia, "evento_antigo");
    }
    const ev = validarEvidencia(regra, evidencia, chave);
    // Allowlist de canais: regra de Discord só paga mensagem de canal cadastrado (sem canal cadastrado, não paga). Antes de
    // qualquer chamada ao Discord, para canal fora da lista não gastar a API nem a cota.
    if (ev.discordId && !(await env.DB.prepare("SELECT 1 AS x FROM recompensa_canais WHERE regra_id = ? AND canal_id = ?").bind(regraId, evidencia.canal_id).first())) {
      return recusar(env, regraId, dia, "canal_nao_permitido");
    }
    if (regra.verificar_discord && ev.discordId) {
      const motivo = await verificarDiscord(env, {discordId: ev.discordId, canalId: evidencia.canal_id, mensagemId: evidencia.mensagem_id});
      if (motivo) return recusar(env, regraId, dia, motivo);
    }

    const id = crypto.randomUUID();
    const quantidade = regra.quantidade * unidades;
    // Disjuntor de emissão da moeda no mês (todas as regras somadas). Sem linha em recompensa_tetos_moeda = sem teto.
    const mes = mesDeBrasilia(t);
    const mensal = await iris.mensal(env, regra, uuid, mes, t, id);
    if (mensal?.motivo) return recusar(env, regraId, dia, mensal.motivo);
    const tetoMes = (await env.DB.prepare("SELECT max_quantidade_mes FROM recompensa_tetos_moeda WHERE moeda = ?").bind(regra.moeda).first("max_quantidade_mes")) ?? null;
    const estado = regra.moeda === "prisma" ? "aplicada" : "autorizada";
    const indiceConcessao = mensal ? 2 : 1;
    const lote = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO jogadores (uuid, nome, criado_em, atualizado_em) VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT (uuid) DO UPDATE SET nome = excluded.nome, atualizado_em = excluded.atualizado_em`).bind(uuid, nome, t),
      ...(mensal ? [mensal.inscrever] : []),
      env.DB.prepare(
        `INSERT OR IGNORE INTO concessoes (id, regra_id, uuid, chave, moeda, unidades, quantidade, estado, discord_id, evidencia, dia, criado_em, aplicada_em, advancement_id)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?21
         WHERE (?21 IS NULL OR NOT EXISTS (SELECT 1 FROM concessoes WHERE uuid = ?3
             AND (advancement_id = ?21 OR (advancement_id IS NULL AND chave = 'conquista:' || ?3 || ':' || ?21))))
           AND (SELECT COALESCE(SUM(unidades), 0) FROM concessoes WHERE regra_id = ?2 AND uuid = ?3 AND dia = ?11) + ?6 <= ?14
           AND (?9 IS NULL OR (SELECT COALESCE(SUM(unidades), 0) FROM concessoes WHERE regra_id = ?2 AND discord_id = ?9 AND dia = ?11) + ?6 <= ?14)
           AND (?15 IS NULL OR (SELECT COALESCE(SUM(unidades), 0) FROM concessoes WHERE regra_id = ?2 AND dia = ?11) + ?6 <= ?15)
           AND (?16 IS NULL OR (SELECT COALESCE(SUM(unidades), 0) FROM concessoes WHERE regra_id = ?2 AND uuid = ?3) + ?6 <= ?16)
           AND (?17 = 0 OR NOT EXISTS (SELECT 1 FROM concessoes WHERE regra_id = ?2 AND uuid = ?3 AND criado_em > ?12 - ?17))
           AND (?18 IS NULL OR (SELECT COALESCE(SUM(quantidade), 0) FROM concessoes WHERE moeda = ?5 AND criado_em >= ?19 AND criado_em < ?20) + ?7 <= ?18)
           AND (?22 = 0 OR (SELECT COALESCE(SUM(quantidade), 0) FROM concessoes WHERE moeda = 'iris' AND criado_em >= ?19 AND criado_em < ?20) + ?7
             <= (SELECT COUNT(*) * ?23 + COALESCE(SUM(reserva_conquistas), 0) FROM iris_participantes_mes WHERE inicio_mes = ?19))`)
        .bind(id, regraId, uuid, chave, regra.moeda, unidades, quantidade, estado, ev.discordId, ev.json, dia, t, estado === "aplicada" ? t : null,
          regra.max_unidades_dia, regra.max_unidades_dia_global, regra.max_unidades_total, regra.intervalo_minimo_segundos, tetoMes, mes.inicio, mes.fim,
          advancementId, mensal ? 1 : 0, mensal?.recorrente ?? 0),
      // Só entra se a concessão acima entrou (o id só existe nesse caso).
      env.DB.prepare(
        `INSERT INTO prisma_lancamentos (uuid, tipo, quantidade, ref, concessao_id, detalhe, criado_em)
         SELECT uuid, 'recompensa', quantidade, 'recompensa:' || id, id, regra_id || ' ' || chave, ?2 FROM concessoes WHERE id = ?1 AND moeda = 'prisma'`).bind(id, t),
      ...(mensal ? [mensal.limparRecusada] : []),
    ]);
    if (lote[indiceConcessao].meta.changes === 1) {
      return resposta(env, {id, uuid, moeda: regra.moeda, unidades, quantidade, estado}, regra, false);
    }
    // Não entrou: ou o mesmo evento chegou em paralelo (idempotente) ou um teto barrou.
    const paralelo = await env.DB.prepare("SELECT * FROM concessoes WHERE regra_id = ? AND chave = ?").bind(regraId, chave).first();
    if (paralelo) {
      if (paralelo.uuid !== uuid) throw new Erro(409, "chave_em_uso");
      return resposta(env, paralelo, regra, true);
    }
    return recusar(env, regraId, dia, await motivoDoTeto(env, regra, {uuid, advancementId, discordId: ev.discordId, dia, unidades, t, quantidade, tetoMes, mes, mensal}));
  }

  /** O plugin confirma que creditou a Iris no saldo local. Idempotente. */
  async function confirmar(env, {regra, chave}) {
    if (typeof regra !== "string" || !REGRA_RE.test(regra)) throw new Erro(400, "regra_invalida");
    if (typeof chave !== "string" || !CHAVE_RE.test(chave)) throw new Erro(400, "chave_invalida");
    const c = await env.DB.prepare("SELECT estado FROM concessoes WHERE regra_id = ? AND chave = ?").bind(regra, chave).first();
    if (!c) throw new Erro(404, "concessao_inexistente");
    if (c.estado === "aplicada") return {ok: true, repetido: true};
    await env.DB.prepare("UPDATE concessoes SET estado = 'aplicada', aplicada_em = ? WHERE regra_id = ? AND chave = ? AND estado = 'autorizada'").bind(agora(), regra, chave).run();
    return {ok: true, repetido: false};
  }

  async function rotaServidor(req, env, caminho, corpo) {
    exigirAtivo(env);
    if (caminho === '/servidor/recompensas/conquistas/inicializar' && req.method === 'POST') return iris.inicializar(env, lerJson(corpo), validarJogador);
    if (caminho === "/servidor/recompensas/conceder" && req.method === "POST") return conceder(env, lerJson(corpo));
    if (caminho === "/servidor/recompensas/confirmar" && req.method === "POST") return confirmar(env, lerJson(corpo));
    if (caminho === "/servidor/recompensas/pendentes" && req.method === "GET") {
      // Iris autorizada e ainda não confirmada há mais de 30 s: o plugin cai no meio e retoma daqui.
      const {results} = await env.DB.prepare(
        `SELECT regra_id AS regra, chave, uuid, moeda, quantidade FROM concessoes WHERE estado = 'autorizada' AND criado_em < ? ORDER BY criado_em LIMIT 50`)
        .bind(agora() - 30).all();
      return {pendentes: results};
    }
    if (caminho === "/servidor/recompensas/regras" && req.method === "GET") {
      // O plugin lê as regras ativas (quantidades e tetos) em vez de ter valores fixos no código.
      const {results} = await env.DB.prepare(
        `SELECT id, fonte, moeda, quantidade, max_unidades_por_chamada, max_unidades_dia, intervalo_minimo_segundos, verificar_discord, idade_maxima_segundos, advancement_id
         FROM recompensa_regras WHERE ativo = 1
           AND NOT (fonte = 'conquista' AND moeda = 'iris' AND advancement_id IS NULL
             AND (SELECT ativo FROM iris_conquistas_config WHERE id = 1) = 1) ORDER BY id`).all();
      // Canais permitidos de cada regra de Discord: o plugin já descarta, antes de enviar, o que o Worker recusaria.
      const canais = (await env.DB.prepare(
        "SELECT c.regra_id, c.canal_id FROM recompensa_canais c JOIN recompensa_regras r ON r.id = c.regra_id WHERE r.ativo = 1 ORDER BY c.regra_id, c.canal_id").all()).results;
      return {regras: results.map(r => ({...r, canais: canais.filter(c => c.regra_id === r.id).map(c => c.canal_id)}))};
    }
    throw new Erro(404, "rota_inexistente");
  }

  return {conceder, confirmar, rotaServidor};
}
