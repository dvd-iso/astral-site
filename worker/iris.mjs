// Propostas de lançamento e disjuntor Iris; configurações nascem desligadas.
const ADVANCEMENT_RE = /^[a-z0-9_.-]+:[a-z0-9_/.-]+$/;

export function criarIris({Erro, agora}) {
  async function inicializar(env, {uuid, nome, concluidas, capturado_em: capturadoEm}, validarJogador) {
    validarJogador(uuid, nome);
    if (!Array.isArray(concluidas) || concluidas.length > 1000
      || concluidas.some(a => typeof a !== 'string' || a.length > 72 || !ADVANCEMENT_RE.test(a))) {
      throw new Erro(400, 'conquistas_invalidas');
    }
    // Snapshot e instante devem ser persistidos juntos no plugin. Recebimento tardio
    // não transforma eventos ocorridos durante a indisponibilidade em pré-lançamento.
    const t = capturadoEm === undefined ? agora() : capturadoEm;
    if (!Number.isInteger(t) || t < 1 || t > agora() + 300) throw new Erro(400, 'capturado_em_invalido');
    const ref = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO jogadores (uuid, nome, criado_em, atualizado_em) VALUES (?1, ?2, ?3, ?3)
        ON CONFLICT (uuid) DO UPDATE SET nome = excluded.nome, atualizado_em = excluded.atualizado_em`).bind(uuid, nome, t),
      env.DB.prepare(`INSERT INTO iris_conquistas_inicios (uuid, ref, iniciado_em) VALUES (?, ?, ?)
        ON CONFLICT (uuid) DO NOTHING`).bind(uuid, ref, t),
      env.DB.prepare(`INSERT OR IGNORE INTO iris_conquistas_preexistentes (uuid, advancement_id, registrado_em)
        SELECT ?1, value, ?3 FROM json_each(?4)
        WHERE EXISTS (SELECT 1 FROM iris_conquistas_inicios WHERE uuid = ?1 AND ref = ?2)`)
        .bind(uuid, ref, t, JSON.stringify([...new Set(concluidas)])),
    ]);
    const inicio = await env.DB.prepare('SELECT ref, iniciado_em FROM iris_conquistas_inicios WHERE uuid = ?').bind(uuid).first();
    return {ok: true, repetido: inicio.ref !== ref, iniciado_em: inicio.iniciado_em};
  }

  function idConquista(regra, uuid, chave) {
    if (regra.advancement_id) {
      if (regra.fonte !== 'conquista' || regra.moeda !== 'iris' || !ADVANCEMENT_RE.test(regra.advancement_id)) {
        throw new Erro(400, 'conquista_regra_invalida');
      }
      if (chave !== `conquista:${uuid}:${regra.advancement_id}`) throw new Erro(400, 'chave_invalida');
      return regra.advancement_id;
    }
    if (regra.fonte !== 'conquista' || regra.moeda !== 'iris') return null;
    const prefixo = `conquista:${uuid}:`;
    if (chave.startsWith(prefixo)) {
      const id = chave.slice(prefixo.length);
      if (id.length <= 72 && ADVANCEMENT_RE.test(id)) return id;
    }
    return null;
  }

  async function verificarConquista(env, regra, {uuid, chave, unidades, ocorridoEm}) {
    const id = idConquista(regra, uuid, chave);
    if (!id) {
      // Sem advancement_id e sem chave canônica `conquista:<uuid>:<namespace>:<caminho>`:
      // só passa enquanto o catálogo novo de conquistas Iris continuar desligado (compatibilidade legada).
      if (regra.fonte === 'conquista' && regra.moeda === 'iris') {
        const config = await env.DB.prepare('SELECT ativo FROM iris_conquistas_config WHERE id = 1').first();
        if (config?.ativo) return 'conquista_legada_desativada';
      }
      return null;
    }
    if (unidades !== 1) throw new Erro(400, 'unidades_invalidas');
    if (await jaPaga(env, uuid, id)) return 'conquista_ja_recompensada';
    if (!regra.advancement_id) {
      const config = await env.DB.prepare('SELECT * FROM iris_conquistas_config WHERE id = 1').first();
      if (config?.ativo && config.nao_retroativo) {
        const inicio = await env.DB.prepare('SELECT iniciado_em FROM iris_conquistas_inicios WHERE uuid = ?').bind(uuid).first();
        if (inicio) {
          if (Number.isInteger(ocorridoEm) && ocorridoEm < inicio.iniciado_em) return 'evento_pre_lancamento';
          if (await env.DB.prepare('SELECT 1 AS x FROM iris_conquistas_preexistentes WHERE uuid = ? AND advancement_id = ?')
            .bind(uuid, id).first()) return 'conquista_preexistente';
        }
      }
      return null;
    }
    const config = await env.DB.prepare('SELECT * FROM iris_conquistas_config WHERE id = 1').first();
    if (!config.ativo) return 'conquistas_desativadas';
    if (config.nao_retroativo) {
      const inicio = await env.DB.prepare('SELECT iniciado_em FROM iris_conquistas_inicios WHERE uuid = ?').bind(uuid).first();
      if (!inicio) return 'conquistas_nao_inicializadas';
      if (!Number.isInteger(ocorridoEm)) throw new Erro(400, 'ocorrido_em_obrigatorio');
      if (ocorridoEm < inicio.iniciado_em) return 'evento_pre_lancamento';
      if (await env.DB.prepare('SELECT 1 AS x FROM iris_conquistas_preexistentes WHERE uuid = ? AND advancement_id = ?')
        .bind(uuid, id).first()) return 'conquista_preexistente';
    }
    return null;
  }

  const jaPaga = (env, uuid, id) => env.DB.prepare(`SELECT 1 AS x FROM concessoes WHERE uuid = ?1
    AND (advancement_id = ?2 OR (advancement_id IS NULL AND chave = 'conquista:' || ?1 || ':' || ?2))`).bind(uuid, id).first();

  async function mensal(env, regra, uuid, mes, t, ref) {
    if (regra.moeda !== 'iris' || !(await env.DB.prepare('SELECT ativo FROM iris_mensal_config WHERE id = 1').first('ativo'))) return null;
    // Sem snapshot não há como saber a reserva elegível. Falha fechada até o plugin inicializar.
    if (!(await env.DB.prepare('SELECT 1 AS x FROM iris_conquistas_inicios WHERE uuid = ?').bind(uuid).first())) {
      return {motivo: 'conquistas_nao_inicializadas'};
    }
    return {
      recorrente: 90 * ((mes.fim - mes.inicio) / 86400),
      // O SQL é parte do mesmo batch da concessão. Primeiro participante entra antes do teste de teto.
      inscrever: env.DB.prepare(`INSERT INTO iris_participantes_mes (inicio_mes, uuid, reserva_conquistas, criado_em, ref)
        SELECT ?1, ?2, COALESCE((SELECT SUM(r.quantidade) FROM (
          SELECT advancement_id, MAX(quantidade) AS quantidade FROM recompensa_regras
          WHERE fonte = 'conquista' AND moeda = 'iris' AND ativo = 1 AND advancement_id IS NOT NULL
            AND (SELECT ativo FROM iris_conquistas_config WHERE id = 1) = 1
          GROUP BY advancement_id
        ) r WHERE NOT EXISTS (SELECT 1 FROM concessoes c WHERE c.uuid = ?2 AND
          (c.advancement_id = r.advancement_id OR (c.advancement_id IS NULL AND c.chave = 'conquista:' || ?2 || ':' || r.advancement_id)))
          AND ((SELECT nao_retroativo FROM iris_conquistas_config WHERE id = 1) = 0
            OR NOT EXISTS (SELECT 1 FROM iris_conquistas_preexistentes p WHERE p.uuid = ?2 AND p.advancement_id = r.advancement_id))), 0), ?3, ?4
        ON CONFLICT (inicio_mes, uuid) DO NOTHING`).bind(mes.inicio, uuid, t, ref),
      // Tentativa recusada não faz uma conta nova inflar N. A inscrição é provisória
      // até a concessão entrar e não fica visível fora da transação.
      limparRecusada: env.DB.prepare(`DELETE FROM iris_participantes_mes WHERE inicio_mes = ?1 AND uuid = ?2 AND ref = ?3
        AND NOT EXISTS (SELECT 1 FROM concessoes WHERE id = ?3)`).bind(mes.inicio, uuid, ref),
    };
  }

  async function tetoMensal(env, mes, recorrente) {
    return env.DB.prepare(`SELECT COUNT(*) * ?2 + COALESCE(SUM(reserva_conquistas), 0) AS teto
      FROM iris_participantes_mes WHERE inicio_mes = ?1`).bind(mes.inicio, recorrente).first('teto');
  }

  return {inicializar, idConquista, verificarConquista, jaPaga, mensal, tetoMensal};
}
