// Testes das recompensas (Prisma e Iris): node --test worker/test/recompensas.test.mjs (Node 22.13+).
// Sem rede: Mercado Pago e Discord são simulados. Regras e valores abaixo são DADOS DE TESTE, não política.
import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {readFileSync} from "node:fs";
import {criarD1} from "./d1-sqlite.mjs";
import {handle, tarefas, hmacHex, sha256hex, agora} from "../loja.mjs";

const PASTA = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "loja");
const CONFIG_IRIS = readFileSync(new URL("../config/recompensas-iris.sql", import.meta.url), "utf8");
const BASE = "https://astral-loja.example";
const ORIGEM = "https://astralmc.online";
const WH = "segredo-webhook-de-teste";
const SRV = "segredo-do-servidor-de-teste-com-32-caracteres-ou-mais";
const RECEBEDOR = "123456789";
const UUID_JOGADOR = "def0e0f3-e4d0-42cf-8ce5-7afb44fd7e97";

// ---------- Mercado Pago simulado ----------

function mercadoPago() {
  const pagamentos = new Map();
  const assinaturas = new Map();
  const cobrancas = [];
  const chamadas = [];
  let falhar = false;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    chamadas.push({metodo: init.method || "GET", caminho: u.pathname + u.search, corpo: init.body ? JSON.parse(init.body) : null, headers: init.headers});
    if (falhar) return new Response("{}", {status: 503});
    if (u.pathname === "/checkout/preferences" && init.method === "POST") {
      return Response.json({id: "pref-" + chamadas.length, init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-" + chamadas.length});
    }
    let m;
    if ((m = /^\/v1\/payments\/(\d+)$/.exec(u.pathname))) {
      const p = pagamentos.get(m[1]);
      return p ? Response.json(p) : new Response("{}", {status: 404});
    }
    if (u.pathname === "/preapproval" && init.method === "POST") {
      const corpo = JSON.parse(init.body);
      const id = "pre" + (assinaturas.size + 1);
      assinaturas.set(id, {id, status: "pending", collector_id: Number(RECEBEDOR), external_reference: corpo.external_reference, auto_recurring: corpo.auto_recurring,
        init_point: `https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=${id}`});
      return Response.json(assinaturas.get(id));
    }
    if ((m = /^\/preapproval\/(\w+)$/.exec(u.pathname))) {
      const a = assinaturas.get(m[1]);
      if (!a) return new Response("{}", {status: 404});
      if (init.method === "PUT") Object.assign(a, JSON.parse(init.body));
      return Response.json(a);
    }
    if (u.pathname === "/authorized_payments/search") {
      return Response.json({results: cobrancas.filter(c => c.preapproval_id === u.searchParams.get("preapproval_id"))});
    }
    if ((m = /^\/authorized_payments\/(\d+)$/.exec(u.pathname))) {
      const c = cobrancas.find(x => String(x.id) === m[1]);
      return c ? Response.json(c) : new Response("{}", {status: 404});
    }
    if (u.pathname === "/v1/payments/search") {
      const ref = u.searchParams.get("external_reference");
      return Response.json({results: [...pagamentos.values()].filter(p => p.external_reference === ref)});
    }
    return new Response("{}", {status: 404});
  };
  return {
    pagamentos, chamadas, fetch, assinaturas, cobrancas,
    /** Um mês cobrado da assinatura: authorized_payment + pagamento com a referência da assinatura. */
    cobrar(cobrancaId, preId, pagamentoId, extra = {}) {
      const a = assinaturas.get(preId);
      cobrancas.push({id: Number(cobrancaId), preapproval_id: preId, payment: {id: Number(pagamentoId), status: "approved"}, external_reference: a.external_reference});
      return this.pagar(pagamentoId, a.external_reference, {transaction_amount: a.auto_recurring.transaction_amount, payment_type_id: "credit_card", ...extra});
    },
    set falhar(v) { falhar = v; },
    pagar(id, pedidoId, extra = {}) {
      const p = {id: Number(id), status: "approved", status_detail: "accredited", external_reference: pedidoId, currency_id: "BRL",
        transaction_amount: 1.0, transaction_amount_refunded: 0, collector_id: Number(RECEBEDOR), live_mode: false, payment_type_id: "bank_transfer", ...extra};
      pagamentos.set(String(id), p);
      return p;
    },
  };
}

function ambiente(extra = {}) {
  const mp = mercadoPago();
  globalThis.fetch = mp.fetch;
  return {
    mp,
    env: {
      DB: criarD1(PASTA), LOJA_MODO: "teste", LOJA_VENDAS_REAIS: "nao", MP_ACCESS_TOKEN: "TEST-token", MP_WEBHOOK_SECRET: WH,
      MP_RECEBEDOR_ID: RECEBEDOR, SERVIDOR_SEGREDO: SRV, IP_SAL: "sal", SITE_URL: ORIGEM, ALLOWED_ORIGINS: ORIGEM, ...extra,
    },
  };
}

// ---------- chamadas ----------

async function site(env, metodo, caminho, corpo, headers = {}) {
  const r = await handle(new Request(BASE + caminho, {
    method: metodo, headers: {Origin: ORIGEM, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers},
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  }), env);
  return {status: r.status, dados: await r.json(), headers: r.headers};
}

let contadorNonce = 0;
async function servidor(env, metodo, caminho, corpo, {segredo = SRV, nonce, ts, contrato = "2", assinadoCom = contrato} = {}) {
  const texto = corpo === undefined ? "" : JSON.stringify(corpo);
  const t = String(ts ?? agora());
  const n = nonce ?? `nonce-de-teste-${++contadorNonce}-${Math.random().toString(36).slice(2)}`;
  // Contrato 2: o cabeçalho X-Astral-Contrato entra na assinatura (linha extra "contrato:2"). contrato = null simula o plugin legado.
  const canonico = `${metodo}\n${caminho}\n${t}\n${n}\n${await sha256hex(texto)}` + (assinadoCom != null ? `\ncontrato:${assinadoCom}` : "");
  const assinatura = await hmacHex(segredo, canonico);
  const cabecalhos = {"X-Astral-Ts": t, "X-Astral-Nonce": n, "X-Astral-Assinatura": assinatura, "Content-Type": "application/json"};
  if (contrato != null) cabecalhos["X-Astral-Contrato"] = contrato;
  const r = await handle(new Request(BASE + caminho, {method: metodo, headers: cabecalhos, body: metodo === "GET" ? undefined : texto}), env);
  return {status: r.status, dados: await r.json()};
}

async function notificar(env, id, {segredo = WH, tipo = "payment", requestId = crypto.randomUUID(), adulterarId} = {}) {
  const ts = String(Date.now());
  const v1 = await hmacHex(segredo, `id:${id};request-id:${requestId};ts:${ts};`);
  const r = await handle(new Request(`${BASE}/webhooks/mercadopago?data.id=${adulterarId ?? id}&type=${tipo}`, {
    method: "POST", headers: {"x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId, "Content-Type": "application/json"},
    body: JSON.stringify({type: tipo, action: "payment.updated", data: {id: String(id)}}),
  }), env);
  return {status: r.status, dados: await r.json()};
}

/** Vincula a conta como o jogador faria: site pede, plugin mostra o código no jogo, jogador digita no site. */
async function vincular(env, nome = "dvdiso", uuid = UUID_JOGADOR) {
  const inicio = await site(env, "POST", "/api/vinculos", {nome});
  assert.equal(inicio.status, 200);
  const pend = await servidor(env, "GET", "/servidor/vinculos");
  const pedido = pend.dados.vinculos.find(v => v.id === inicio.dados.id);
  assert.ok(pedido, "o plugin vê o pedido de vinculação");
  const codigo = "K7PQ4X";
  assert.equal((await servidor(env, "POST", `/servidor/vinculos/${pedido.id}/codigo`, {uuid, nome, codigo})).status, 200);
  const conf = await site(env, "POST", `/api/vinculos/${pedido.id}/confirmar`, {codigo: "k7p-q4x"}, {"X-Vinculo-Segredo": inicio.dados.segredo});
  assert.equal(conf.status, 200, JSON.stringify(conf.dados));
  return conf.dados.token;
}


async function comprarGato(env, token) {
  const r = await site(env, "POST", "/api/pedidos", {produto_id: "pet_gato"}, {Authorization: `Bearer ${token}`});
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  return r.dados.pedido_id;
}

const linhas = (env, sql, ...a) => env.DB.sqlite.prepare(sql).all(...a).map(r => ({...r}));
const linha = (env, sql, ...a) => linhas(env, sql, ...a)[0];

const UUID_B = "11111111-2222-4333-8444-555555555555";
const DC_A = "100000000000000001", DC_B = "100000000000000002", CANAL = "200000000000000001";

function ambienteRec(extra = {}) {
  const a = ambiente({RECOMPENSAS_ATIVO: "sim", PRISMA_ATIVO: "sim", PRISMA_GASTOS_ATIVO: "sim", ...extra});
  const mpFetch = globalThis.fetch;
  a.discord = {mensagens: new Map(), chamadas: [], falhar: false};
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://discord.com/api/v10/")) return mpFetch(url, init);
    a.discord.chamadas.push({url: String(url), auth: init?.headers?.Authorization});
    if (a.discord.falhar) return new Response("{}", {status: 503});
    const m = /channels\/(\d+)\/messages\/(\d+)$/.exec(String(url));
    const msg = a.discord.mensagens.get(`${m[1]}:${m[2]}`);
    return msg ? Response.json(msg) : new Response("{}", {status: 404});
  };
  return a;
}

/** Cria uma regra de TESTE (valores arbitrários só para exercitar o motor). */
function regra(env, id, campos = {}) {
  const r = {fonte: "tempo_jogado", moeda: "prisma", quantidade: 7, max_unidades_por_chamada: 1, max_unidades_dia: 3,
    max_unidades_dia_global: null, max_unidades_total: null, intervalo_minimo_segundos: 0, verificar_discord: 0, idade_maxima_segundos: null, advancement_id: null, ativo: 1, ...campos};
  env.DB.sqlite.prepare(
    `INSERT INTO recompensa_regras (id, fonte, moeda, quantidade, max_unidades_por_chamada, max_unidades_dia, max_unidades_dia_global, max_unidades_total,
       intervalo_minimo_segundos, verificar_discord, idade_maxima_segundos, advancement_id, ativo, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`)
    .run(id, r.fonte, r.moeda, r.quantidade, r.max_unidades_por_chamada, r.max_unidades_dia, r.max_unidades_dia_global, r.max_unidades_total,
      r.intervalo_minimo_segundos, r.verificar_discord, r.idade_maxima_segundos, r.advancement_id, r.ativo);
}

/** Libera canais para uma regra de Discord (allowlist). */
function canais(env, regraId, ...ids) {
  for (const id of ids) env.DB.sqlite.prepare("INSERT INTO recompensa_canais (regra_id, canal_id, criado_em) VALUES (?, ?, 1)").run(regraId, id);
}

const conceder = (env, corpo) => servidor(env, "POST", "/servidor/recompensas/conceder", {uuid: UUID_JOGADOR, nome: "dvdiso", regra: "tempo_teste", chave: "tempo:teste:0001", ...corpo});
const saldoPrisma = (env, uuid = UUID_JOGADOR) => linha(env, "SELECT COALESCE(SUM(quantidade), 0) AS s FROM prisma_lancamentos WHERE uuid = ?", uuid).s;
const recusas = (env, regraId, motivo) => linha(env, "SELECT contagem FROM recompensa_recusas WHERE regra_id = ? AND motivo = ?", regraId, motivo)?.contagem ?? 0;

test("migração: nenhuma regra, valor ou concessão de fábrica", () => {
  const {env} = ambienteRec();
  assert.equal(linhas(env, "SELECT * FROM recompensa_regras").length, 0);
  assert.equal(linhas(env, "SELECT * FROM concessoes").length, 0);
});

test("configuração Iris aprovada: inativa, 80/dia por tempo e 10/dia no Discord com intervalo e allowlist", async () => {
  const {env} = ambienteRec({RECOMPENSAS_ATIVO: undefined});
  env.DB.sqlite.exec(CONFIG_IRIS);
  env.DB.sqlite.exec(CONFIG_IRIS); // reaplicar não duplica nem muda o estado
  assert.deepEqual(linhas(env, "SELECT id, quantidade, max_unidades_dia, ativo FROM recompensa_regras WHERE fonte != 'conquista' ORDER BY id"), [
    {id: "iris_discord_mensagem", quantidade: 2, max_unidades_dia: 5, ativo: 0},
    {id: "iris_tempo_ativo", quantidade: 10, max_unidades_dia: 8, ativo: 0},
  ]);
  assert.equal((await conceder(env, {regra: "iris_tempo_ativo"})).status, 404);
  env.RECOMPENSAS_ATIVO = "sim"; // ativação SOMENTE nesta base de teste
  assert.equal((await conceder(env, {regra: "iris_tempo_ativo"})).dados.motivo, "regra_inativa");
  env.DB.sqlite.exec("UPDATE recompensa_regras SET ativo = 1");
  for (let i = 0; i < 8; i++) {
    const r = await conceder(env, {regra: "iris_tempo_ativo", chave: `tempo:ativo:${i}`});
    assert.equal(r.dados.quantidade, 10);
  }
  assert.equal((await conceder(env, {regra: "iris_tempo_ativo", chave: "tempo:ativo:extra"})).dados.motivo, "teto_diario_jogador");
  assert.equal((await conceder(env, {regra: "iris_tempo_ativo", chave: "tempo:ativo:0"})).dados.repetido, true);
  const dc = i => conceder(env, {regra: "iris_discord_mensagem", chave: `discord:${CANAL}:30000000000000000${i}`,
    evidencia: {discord_user_id: DC_A, canal_id: CANAL, mensagem_id: `30000000000000000${i}`}});
  assert.equal((await dc(0)).dados.motivo, "canal_nao_permitido");
  canais(env, "iris_discord_mensagem", CANAL);
  assert.equal((await dc(0)).dados.quantidade, 2);
  assert.equal((await dc(1)).dados.motivo, "intervalo_minimo");
  for (let i = 1; i < 5; i++) {
    env.DB.sqlite.exec("UPDATE concessoes SET criado_em = criado_em - 301 WHERE regra_id = 'iris_discord_mensagem'");
    assert.equal((await dc(i)).dados.quantidade, 2);
  }
  assert.equal((await dc(5)).dados.motivo, "teto_diario_jogador");
  assert.deepEqual(linhas(env, "SELECT regra_id, SUM(quantidade) AS total FROM concessoes GROUP BY regra_id ORDER BY regra_id"), [
    {regra_id: "iris_discord_mensagem", total: 10}, {regra_id: "iris_tempo_ativo", total: 80},
  ]);
  assert.equal(linhas(env, "SELECT * FROM recompensa_tetos_moeda").length, 0);
  assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos").length, 0);
});

const iniciarIris = (env, concluidas = [], uuid = UUID_JOGADOR, nome = "dvdiso") => servidor(env, "POST", "/servidor/recompensas/conquistas/inicializar", {uuid, nome, concluidas});
const eventoConquista = (regra, advancement, uuid = UUID_JOGADOR) => ({regra, chave: `conquista:${uuid}:${advancement}`, uuid, nome: "dvdiso", ocorrido_em: agora()});

function configurarIris(env, mensal = false) {
  env.DB.sqlite.exec(CONFIG_IRIS);
  env.DB.sqlite.exec("UPDATE recompensa_regras SET ativo = 1"); // apenas teste
  env.DB.sqlite.exec("UPDATE iris_conquistas_config SET ativo = 1");
  if (mensal) env.DB.sqlite.exec("UPDATE iris_mensal_config SET ativo = 1");
}

test("catálogo Keroppi: 15 IDs completos, 6/6/3 tiers, total 240 Iris, tudo inativo", () => {
  const {env} = ambienteRec();
  env.DB.sqlite.exec(CONFIG_IRIS);
  const catalogo = linhas(env, "SELECT * FROM recompensa_regras WHERE fonte = 'conquista'");
  assert.equal(catalogo.length, 15);
  assert.equal(new Set(catalogo.map(r => r.advancement_id)).size, 15);
  assert.ok(catalogo.every(r => r.advancement_id.startsWith("minecraft:") && !r.advancement_id.includes("recipes/") && r.ativo === 0 && r.max_unidades_total === 1));
  assert.deepEqual([5, 15, 40].map(q => catalogo.filter(r => r.quantidade === q).length), [6, 6, 3]);
  assert.equal(catalogo.reduce((s, r) => s + r.quantidade, 0), 240);
  const esperados = [
    ['husbandry/plant_seed', 5], ['husbandry/breed_an_animal', 5], ['husbandry/tame_an_animal', 5],
    ['husbandry/fishy_business', 5], ['adventure/shoot_arrow', 5], ['story/deflect_arrow', 5],
    ['story/enchant_item', 15], ['story/cure_zombie_villager', 15], ['adventure/summon_iron_golem', 15],
    ['nether/find_fortress', 15], ['nether/find_bastion', 15], ['nether/return_to_sender', 15],
    ['end/kill_dragon', 40], ['nether/explore_nether', 40], ['husbandry/bred_all_animals', 40],
  ].map(([id, q]) => [`minecraft:${id}`, q]).sort();
  assert.deepEqual(catalogo.map(r => [r.advancement_id, r.quantidade]).sort(), esperados);
  assert.deepEqual(linha(env, "SELECT * FROM iris_conquistas_config"), {id: 1, ativo: 0, nao_retroativo: 1});
  assert.equal(linha(env, "SELECT ativo FROM iris_mensal_config").ativo, 0);
});

test("conquistas: identidade UUID+ID integral resiste a outra regra, tier, mundo, nome e chave; outro UUID recebe", async () => {
  const {env} = ambienteRec();
  configurarIris(env);
  await iniciarIris(env);
  await iniciarIris(env, [], UUID_B, "outro");
  const catalogo = linhas(env, "SELECT * FROM recompensa_regras WHERE fonte = 'conquista'");
  for (const r of catalogo) {
    const corpo = eventoConquista(r.id, r.advancement_id);
    assert.equal((await conceder(env, corpo)).dados.quantidade, r.quantidade);
    assert.equal((await conceder(env, {...corpo, nome: "outroNick"})).dados.repetido, true);
    assert.equal((await conceder(env, {...corpo, chave: corpo.chave + ":mundo2"})).status, 400);
    assert.equal((await conceder(env, eventoConquista(r.id, r.advancement_id, UUID_B))).dados.quantidade, r.quantidade);
  }
  const r = catalogo[0];
  regra(env, "conquista_outro_tier", {fonte: "conquista", moeda: "iris", quantidade: 999, advancement_id: r.advancement_id});
  assert.equal((await conceder(env, eventoConquista("conquista_outro_tier", r.advancement_id))).dados.motivo, "conquista_ja_recompensada");
  env.DB.sqlite.exec("UPDATE recompensa_regras SET quantidade = 999 WHERE fonte = 'conquista'");
  assert.equal((await conceder(env, eventoConquista(r.id, r.advancement_id))).dados.quantidade, r.quantidade);
  assert.deepEqual(linhas(env, "SELECT uuid, SUM(quantidade) AS total FROM concessoes GROUP BY uuid ORDER BY uuid").map(r => r.total), [240, 240]);
  assert.throws(() => env.DB.sqlite.exec(`INSERT INTO concessoes (id, regra_id, uuid, chave, moeda, unidades, quantidade, estado, dia, criado_em, advancement_id)
    SELECT id || 'nova', regra_id, uuid, chave || 'nova', moeda, unidades, quantidade, estado, dia + 1, criado_em, advancement_id FROM concessoes LIMIT 1`), /UNIQUE/);
});

test("não retroatividade proposta: gate desligado, snapshot único, pré-existentes e eventos anteriores não pagam", async () => {
  const {env} = ambienteRec();
  env.DB.sqlite.exec(CONFIG_IRIS);
  env.DB.sqlite.exec("UPDATE recompensa_regras SET ativo = 1");
  const corpo = eventoConquista("iris_conq_plant_seed", "minecraft:husbandry/plant_seed");
  assert.equal((await conceder(env, corpo)).dados.motivo, "conquistas_desativadas");
  env.DB.sqlite.exec("UPDATE iris_conquistas_config SET ativo = 1");
  assert.equal((await conceder(env, corpo)).dados.motivo, "conquistas_nao_inicializadas");
  const inicio = await iniciarIris(env, ["minecraft:husbandry/plant_seed"]);
  assert.equal(inicio.dados.repetido, false);
  assert.equal((await iniciarIris(env, ["minecraft:story/enchant_item"])).dados.repetido, true);
  assert.deepEqual(linhas(env, "SELECT advancement_id FROM iris_conquistas_preexistentes"), [{advancement_id: "minecraft:husbandry/plant_seed"}]);
  assert.equal((await conceder(env, {...corpo, ocorrido_em: inicio.dados.iniciado_em})).dados.motivo, "conquista_preexistente");
  const nova = eventoConquista("iris_conq_enchant_item", "minecraft:story/enchant_item");
  assert.equal((await conceder(env, {...nova, ocorrido_em: inicio.dados.iniciado_em - 1})).dados.motivo, "evento_pre_lancamento");
  assert.equal((await conceder(env, {...nova, ocorrido_em: undefined})).dados.erro, "ocorrido_em_obrigatorio");
  assert.equal((await conceder(env, nova)).dados.quantidade, 15);
  const semHmac = await handle(new Request(BASE + "/servidor/recompensas/conquistas/inicializar", {method: "POST", body: "{}"}), env);
  assert.equal(semHmac.status, 401);
  for (const concluidas of [null, ["sem_namespace"], [7], "texto"]) {
    assert.equal((await iniciarIris(env, concluidas)).status, 400);
  }
});

test("snapshot persistido: atraso de entrega preserva o início capturado e os eventos posteriores", async () => {
  const {env} = ambienteRec();
  configurarIris(env);
  const capturadoEm = agora() - 3600;
  const inicio = await servidor(env, "POST", "/servidor/recompensas/conquistas/inicializar", {uuid: UUID_JOGADOR, nome: "dvdiso", concluidas: [], capturado_em: capturadoEm});
  assert.equal(inicio.dados.iniciado_em, capturadoEm);
  const corpo = eventoConquista("iris_conq_enchant_item", "minecraft:story/enchant_item");
  assert.equal((await conceder(env, {...corpo, ocorrido_em: capturadoEm + 60})).dados.quantidade, 15);
  for (const t of [0, 1.5, "100", agora() + 301]) {
    const r = await servidor(env, "POST", "/servidor/recompensas/conquistas/inicializar", {uuid: UUID_B, nome: "outro", concluidas: [], capturado_em: t});
    assert.deepEqual([r.status, r.dados.erro], [400, "capturado_em_invalido"]);
  }
});

test("conquistas concorrentes em regras distintas e concessão legada canônica não duplicam UUID+ID", async () => {
  const {env} = ambienteRec();
  configurarIris(env);
  await iniciarIris(env);
  const adv = "minecraft:story/enchant_item";
  regra(env, "tier_alterado", {fonte: "conquista", moeda: "iris", quantidade: 40, advancement_id: adv});
  const rs = await Promise.all(["tier_alterado", "iris_conq_enchant_item"].map(id => conceder(env, eventoConquista(id, adv))));
  assert.equal(rs.filter(r => r.dados.concedida).length, 1);
  assert.equal(rs.find(r => !r.dados.concedida).dados.motivo, "conquista_ja_recompensada");
  regra(env, "legado_canonico", {fonte: "conquista", moeda: "iris"});
  await conceder(env, eventoConquista("legado_canonico", "minecraft:husbandry/plant_seed"));
  assert.equal((await conceder(env, eventoConquista("iris_conq_plant_seed", "minecraft:husbandry/plant_seed"))).dados.motivo, "conquista_ja_recompensada");
});

test("regressão Keroppi: novo → legado sequencial, corrida concorrente e intercalamento entre pré-checagem e batch pagam uma única vez", async () => {
  const {env} = ambienteRec();
  configurarIris(env);
  await iniciarIris(env);
  regra(env, "legado_ativo", {fonte: "conquista", moeda: "iris", quantidade: 5, max_unidades_dia: 10, max_unidades_total: 10});

  // 1) Sequencial novo → legado (antes pagava 5 + 5 = 10 para o mesmo UUID+advancement).
  const advSeq = "minecraft:husbandry/plant_seed";
  const evNovo = eventoConquista("iris_conq_plant_seed", advSeq);
  assert.equal((await conceder(env, evNovo)).dados.quantidade, 5);
  const posLegado = await conceder(env, {...evNovo, regra: "legado_ativo"});
  assert.deepEqual(posLegado.dados, {concedida: false, motivo: "conquista_ja_recompensada"});
  assert.deepEqual(linha(env, "SELECT COUNT(*) AS n, SUM(quantidade) AS total FROM concessoes WHERE uuid = ? AND chave = ?", UUID_JOGADOR, evNovo.chave), {n: 1, total: 5});

  // 2) Concorrência direta entre regra nova e regra legada ativa.
  const advPar = "minecraft:husbandry/breed_an_animal";
  const par = await Promise.all([
    conceder(env, eventoConquista("iris_conq_breed_an_animal", advPar)),
    conceder(env, eventoConquista("legado_ativo", advPar)),
  ]);
  assert.equal(par.filter(r => r.dados.concedida).length, 1);
  assert.equal(par.find(r => !r.dados.concedida).dados.motivo, "conquista_ja_recompensada");
  assert.equal(linha(env, "SELECT COUNT(*) AS n FROM concessoes WHERE uuid = ? AND chave = ?", UUID_JOGADOR, `conquista:${UUID_JOGADOR}:${advPar}`).n, 1);

  // 3) Intercalamento determinístico: concessão legada NULL entra depois da pré-checagem e antes do batch da regra nova.
  const advRace = "minecraft:husbandry/tame_an_animal";
  const chaveRace = `conquista:${UUID_JOGADOR}:${advRace}`;
  const batchOriginal = env.DB.batch.bind(env.DB);
  let intercalou = false;
  env.DB.batch = async statements => {
    if (!intercalou) {
      intercalou = true;
      env.DB.sqlite.prepare(
        `INSERT INTO concessoes (id, regra_id, uuid, chave, moeda, unidades, quantidade, estado, dia, criado_em, advancement_id)
         VALUES ('legado-corrida', 'legado_ativo', ?, ?, 'iris', 1, 5, 'autorizada', 1, ?, NULL)`
      ).run(UUID_JOGADOR, chaveRace, agora());
    }
    return batchOriginal(statements);
  };
  const rRace = await conceder(env, eventoConquista("iris_conq_tame_an_animal", advRace));
  env.DB.batch = batchOriginal;
  assert.deepEqual(rRace.dados, {concedida: false, motivo: "conquista_ja_recompensada"});
  assert.deepEqual(linha(env, "SELECT COUNT(*) AS n, SUM(quantidade) AS total FROM concessoes WHERE uuid = ? AND chave = ?", UUID_JOGADOR, chaveRace), {n: 1, total: 5});

  // 4) Intercalamento no banco: índice único barra mesmo um INSERT direto duplicado sem advancement_id.
  assert.throws(() => env.DB.sqlite.prepare(
    `INSERT INTO concessoes (id, regra_id, uuid, chave, moeda, unidades, quantidade, estado, dia, criado_em, advancement_id)
     VALUES ('legado-dup-sql', 'legado_ativo', ?, ?, 'iris', 1, 5, 'autorizada', 1, ?, NULL)`
  ).run(UUID_JOGADOR, evNovo.chave, agora()), /UNIQUE/);

  // 5) Com o catálogo novo ativo, chave legada fora do formato canônico UUID+ID é recusada; e GET /regras oculta regras legadas NULL.
  assert.equal((await conceder(env, {regra: "legado_ativo", chave: "conquista:def0:mine_diamond"})).dados.motivo, "conquista_legada_desativada");
  const idsAnunciados = (await servidor(env, "GET", "/servidor/recompensas/regras")).dados.regras.map(r => r.id);
  assert.equal(idsAnunciados.includes("legado_ativo"), false);
});

test("mensal proporcional: meses 28/29/30/31 dias, UUID único e reserva fixa antes do primeiro crédito", async () => {
  const relogio = Date.now;
  try {
    for (const [ano, mes, dias] of [[2027, 1, 28], [2028, 1, 29], [2026, 10, 30], [2026, 11, 31]]) {
      Date.now = () => Date.UTC(ano, mes, 15, 12);
      const {env} = ambienteRec();
      configurarIris(env, true);
      assert.equal((await conceder(env, {regra: "iris_tempo_ativo"})).dados.motivo, "conquistas_nao_inicializadas");
      assert.equal(linhas(env, "SELECT * FROM iris_participantes_mes").length, 0);
      await iniciarIris(env);
      assert.equal((await conceder(env, eventoConquista("iris_conq_plant_seed", "minecraft:husbandry/plant_seed"))).dados.quantidade, 5);
      assert.equal(linha(env, "SELECT reserva_conquistas FROM iris_participantes_mes").reserva_conquistas, 240, "inclui o prêmio da primeira concessão na fotografia");
      await conceder(env, {regra: "iris_tempo_ativo", chave: "tempo:mensal:0001"});
      assert.equal(linhas(env, "SELECT * FROM iris_participantes_mes").length, 1);
      assert.equal(linha(env, "SELECT COUNT(*) * ? + SUM(reserva_conquistas) AS teto FROM iris_participantes_mes", 90 * dias).teto, 90 * dias + 240);
      assert.equal(linha(env, "SELECT reserva_conquistas FROM iris_participantes_mes").reserva_conquistas, 240, "pagar não reduz a reserva mensal");
      assert.equal(linhas(env, "SELECT * FROM recompensa_tetos_moeda").length, 0, "não preenche teto estático");
      Date.now = () => Date.UTC(ano, mes + 1, 1, 3);
      await conceder(env, {regra: "iris_tempo_ativo", chave: "tempo:outromes:0001"});
      assert.equal(linha(env, "SELECT reserva_conquistas FROM iris_participantes_mes ORDER BY inicio_mes DESC LIMIT 1").reserva_conquistas, 235, "prêmio vitalício pago não entra na reserva do mês seguinte");
    }
  } finally { Date.now = relogio; }
});

test("mensal proporcional: teto atômico, novo UUID entra antes do crédito, tentativa recusada não infla N", async () => {
  const relogio = Date.now;
  try {
    Date.now = () => Date.UTC(2026, 10, 15, 12); // novembro: 30 dias
    const {env} = ambienteRec();
    configurarIris(env, true);
    await iniciarIris(env);
    // Fonte SINTÉTICA de teste: exceder os tetos individuais reais para exercitar o disjuntor.
    regra(env, "emissao_sintetica", {moeda: "iris", quantidade: 1470, max_unidades_dia: 100});
    const rs = await Promise.all([0, 1, 2, 3].map(i => conceder(env, {regra: "emissao_sintetica", chave: `teste:mensal:${i}`})));
    assert.equal(rs.filter(r => r.dados.concedida).length, 2, JSON.stringify(rs.map(r => r.dados)));
    assert.ok(rs.filter(r => !r.dados.concedida).every(r => r.dados.motivo === "teto_mensal_emissao"));
    assert.equal(linha(env, "SELECT SUM(quantidade) AS soma FROM concessoes").soma, 2940);
    assert.equal(linhas(env, "SELECT * FROM iris_participantes_mes").length, 1);
    // Segundo UUID sem reserva de conquistas: todas pré-existentes no snapshot.
    const ids = linhas(env, "SELECT advancement_id FROM recompensa_regras WHERE fonte = 'conquista'").map(r => r.advancement_id);
    await iniciarIris(env, ids, UUID_B, "outro");
    regra(env, "emissao_grande", {moeda: "iris", quantidade: 2701, max_unidades_dia: 100});
    assert.equal((await conceder(env, {regra: "emissao_grande", chave: "teste:grande:novo", uuid: UUID_B, nome: "outro"})).dados.motivo, "teto_mensal_emissao");
    assert.equal(linhas(env, "SELECT * FROM iris_participantes_mes").length, 1, "recusa não cadastra participante novo");
    assert.equal((await conceder(env, {regra: "iris_tempo_ativo", chave: "tempo:novo:0001", uuid: UUID_B, nome: "outro"})).dados.quantidade, 10);
    assert.equal(linhas(env, "SELECT * FROM iris_participantes_mes").length, 2);
    assert.equal(linha(env, "SELECT reserva_conquistas FROM iris_participantes_mes WHERE uuid = ?", UUID_B).reserva_conquistas, 0);
    assert.equal(linha(env, "SELECT COUNT(*) * 2700 + SUM(reserva_conquistas) AS teto FROM iris_participantes_mes").teto, 5640);
    // Voltar ao mês seguinte recria a fotografia: o índice não mistura participantes de meses diferentes.
    Date.now = () => Date.UTC(2026, 11, 1, 3); // 00h de Brasília
    assert.equal((await conceder(env, {regra: "iris_tempo_ativo", chave: "tempo:dezembro:0001"})).dados.quantidade, 10);
    assert.equal(linhas(env, "SELECT * FROM iris_participantes_mes").length, 3);
    assert.equal(linha(env, "SELECT COUNT(DISTINCT inicio_mes) AS meses FROM iris_participantes_mes").meses, 2);
  } finally { Date.now = relogio; }
});

test("sem RECOMPENSAS_ATIVO as rotas respondem 404", async () => {
  const {env} = ambienteRec({RECOMPENSAS_ATIVO: undefined});
  regra(env, "tempo_teste");
  for (const [m, c] of [["POST", "/servidor/recompensas/conceder"], ["POST", "/servidor/recompensas/confirmar"], ["GET", "/servidor/recompensas/pendentes"], ["GET", "/servidor/recompensas/regras"]]) {
    const r = await servidor(env, m, c, m === "POST" ? {} : undefined);
    assert.deepEqual([r.status, r.dados.erro], [404, "recompensas_desativadas"], c);
  }
  assert.equal(linhas(env, "SELECT * FROM concessoes").length, 0);
});

test("Prisma: concede, credita no livro-razão e o mesmo evento nunca paga duas vezes", async () => {
  const {env} = ambienteRec();
  regra(env, "tempo_teste", {max_unidades_por_chamada: 3});
  const a = await conceder(env, {unidades: 2});
  assert.deepEqual([a.status, a.dados.concedida, a.dados.repetido, a.dados.estado, a.dados.quantidade, a.dados.saldo], [200, true, false, "aplicada", 14, 14]);
  for (let i = 0; i < 3; i++) {
    const r = await conceder(env, {unidades: 2});
    assert.deepEqual([r.dados.concedida, r.dados.repetido, r.dados.saldo], [true, true, 14]);
  }
  // Mudar a regra depois não altera o que já foi decidido para aquele evento.
  env.DB.sqlite.exec("UPDATE recompensa_regras SET quantidade = 999");
  assert.equal((await conceder(env, {unidades: 2})).dados.quantidade, 14);
  assert.equal(saldoPrisma(env), 14);
  assert.equal(linhas(env, "SELECT * FROM concessoes").length, 1);
  const l = linha(env, "SELECT tipo, quantidade, ref, concessao_id FROM prisma_lancamentos");
  assert.deepEqual([l.tipo, l.quantidade], ["recompensa", 14]);
  assert.equal(l.ref, `recompensa:${l.concessao_id}`);
  // Mesma chave de outro jogador é erro, não pagamento.
  assert.equal((await conceder(env, {uuid: UUID_B, nome: "outro"})).dados.erro, "chave_em_uso");
  // Prisma ganho é gastável e aparece no feed de avisos.
  assert.equal((await servidor(env, "POST", "/servidor/prisma/gastar", {uuid: UUID_JOGADOR, quantidade: 10, ref: "evento-0001-abc", item: "asas_teste"})).dados.saldo, 4);
  assert.deepEqual((await servidor(env, "GET", "/servidor/prisma/novos?apos=0")).dados.lancamentos.map(x => [x.tipo, x.quantidade]), [["recompensa", 14]]);
});

test("eventos simultâneos com a mesma chave geram uma concessão só", async () => {
  const {env} = ambienteRec();
  regra(env, "tempo_teste");
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => conceder(env, {})));
  assert.ok(rs.every(r => r.status === 200 && r.dados.concedida));
  assert.equal(rs.filter(r => !r.dados.repetido).length, 1);
  assert.equal(saldoPrisma(env), 7);
});

test("regra inativa, desconhecida ou acima do limite por chamada: recusa e conta, sem linha por tentativa", async () => {
  const {env} = ambienteRec();
  regra(env, "tempo_teste", {ativo: 0});
  regra(env, "outra_regra", {max_unidades_por_chamada: 2});
  for (let i = 0; i < 3; i++) assert.deepEqual((await conceder(env, {chave: `tempo:teste:00${i}x`})).dados, {concedida: false, motivo: "regra_inativa"});
  assert.equal(recusas(env, "tempo_teste", "regra_inativa"), 3);
  assert.equal((await conceder(env, {regra: "nao_existe"})).status, 404);
  assert.equal((await conceder(env, {regra: "outra_regra", unidades: 3})).dados.motivo, "unidades_acima_do_permitido");
  assert.equal(linhas(env, "SELECT * FROM concessoes").length, 0);
  assert.equal(saldoPrisma(env), 0);
});

test("tetos: jogador/dia, global/dia, total e intervalo mínimo; o dia seguinte reabre só o diário", async () => {
  const {env} = ambienteRec();
  regra(env, "tempo_teste", {max_unidades_dia: 2});
  assert.equal((await conceder(env, {chave: "tempo:teste:0001"})).dados.concedida, true);
  assert.equal((await conceder(env, {chave: "tempo:teste:0002"})).dados.concedida, true);
  assert.equal((await conceder(env, {chave: "tempo:teste:0003"})).dados.motivo, "teto_diario_jogador");
  assert.equal(saldoPrisma(env), 14);
  env.DB.sqlite.exec("UPDATE concessoes SET dia = dia - 1, criado_em = criado_em - 86400");   // passou um dia
  assert.equal((await conceder(env, {chave: "tempo:teste:0003"})).dados.concedida, true);

  regra(env, "global_teste", {max_unidades_dia: 5, max_unidades_dia_global: 2});
  const g = (uuid, nome, n) => conceder(env, {uuid, nome, regra: "global_teste", chave: `global:teste:${n}`});
  assert.equal((await g(UUID_JOGADOR, "dvdiso", 1)).dados.concedida, true);
  assert.equal((await g(UUID_B, "outro", 2)).dados.concedida, true);
  assert.equal((await g(UUID_B, "outro", 3)).dados.motivo, "teto_diario_global");

  regra(env, "total_teste", {max_unidades_dia: 5, max_unidades_total: 2});
  await conceder(env, {regra: "total_teste", chave: "total:teste:0001"});
  await conceder(env, {regra: "total_teste", chave: "total:teste:0002"});
  env.DB.sqlite.exec("UPDATE concessoes SET dia = dia - 1 WHERE regra_id = 'total_teste'");
  assert.equal((await conceder(env, {regra: "total_teste", chave: "total:teste:0003"})).dados.motivo, "teto_total_jogador");

  regra(env, "intervalo_teste", {max_unidades_dia: 5, intervalo_minimo_segundos: 600});
  assert.equal((await conceder(env, {regra: "intervalo_teste", chave: "int:teste:0001"})).dados.concedida, true);
  assert.equal((await conceder(env, {regra: "intervalo_teste", chave: "int:teste:0002"})).dados.motivo, "intervalo_minimo");
  env.DB.sqlite.exec("UPDATE concessoes SET criado_em = criado_em - 601 WHERE regra_id = 'intervalo_teste'");
  assert.equal((await conceder(env, {regra: "intervalo_teste", chave: "int:teste:0002"})).dados.concedida, true);
});

test("teto não passa sob concorrência: 8 eventos distintos com teto 3", async () => {
  const {env} = ambienteRec();
  regra(env, "tempo_teste", {max_unidades_dia: 3});
  const rs = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(i => conceder(env, {chave: `tempo:teste:par${i}x`})));
  assert.equal(rs.filter(r => r.dados.concedida).length, 3);
  assert.equal(saldoPrisma(env), 21);
});

test("Iris: o Worker só autoriza e audita; o plugin confirma; nada entra no livro de Prisma", async () => {
  const {env} = ambienteRec();
  regra(env, "iris_teste", {moeda: "iris", fonte: "conquista", quantidade: 5});
  const a = await conceder(env, {regra: "iris_teste", chave: "conquista:def0:mine_diamond", unidades: 1});
  assert.deepEqual([a.dados.concedida, a.dados.estado, a.dados.moeda, a.dados.quantidade, "saldo" in a.dados], [true, "autorizada", "iris", 5, false]);
  assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos").length, 0);
  assert.equal((await servidor(env, "GET", "/servidor/recompensas/pendentes")).dados.pendentes.length, 0, "recém-autorizada ainda não é pendente");
  env.DB.sqlite.exec("UPDATE concessoes SET criado_em = criado_em - 60");
  const p = await servidor(env, "GET", "/servidor/recompensas/pendentes");
  assert.deepEqual(p.dados.pendentes, [{regra: "iris_teste", chave: "conquista:def0:mine_diamond", uuid: UUID_JOGADOR, moeda: "iris", quantidade: 5}]);
  assert.equal((await conceder(env, {regra: "iris_teste", chave: "conquista:def0:mine_diamond"})).dados.estado, "autorizada", "repetir devolve a mesma autorização");
  const c = await servidor(env, "POST", "/servidor/recompensas/confirmar", {regra: "iris_teste", chave: "conquista:def0:mine_diamond"});
  assert.deepEqual([c.status, c.dados.repetido], [200, false]);
  assert.equal((await servidor(env, "POST", "/servidor/recompensas/confirmar", {regra: "iris_teste", chave: "conquista:def0:mine_diamond"})).dados.repetido, true);
  assert.equal((await servidor(env, "GET", "/servidor/recompensas/pendentes")).dados.pendentes.length, 0);
  assert.equal((await servidor(env, "POST", "/servidor/recompensas/confirmar", {regra: "iris_teste", chave: "conquista:nunca:existiu"})).status, 404);
});

test("regra de Prisma recusa se o módulo Prisma está desligado; Iris segue", async () => {
  const {env} = ambienteRec({PRISMA_ATIVO: undefined});
  regra(env, "tempo_teste");
  regra(env, "iris_teste", {moeda: "iris"});
  assert.equal((await conceder(env, {})).dados.motivo, "prisma_desativado");
  assert.equal((await conceder(env, {regra: "iris_teste", chave: "iris:teste:0001"})).dados.concedida, true);
  assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos").length, 0);
});

function mensagemDiscord(extra = {}) {
  return {id: "300000000000000001", channel_id: CANAL, author: {id: DC_A, bot: false}, timestamp: new Date().toISOString(), ...extra};
}
const evDiscord = (msg = "300000000000000001", usuario = DC_A) => ({chave: `discord:${CANAL}:${msg}`, evidencia: {discord_user_id: usuario, canal_id: CANAL, mensagem_id: msg}});

test("Discord: evidência com ids obrigatória e a chave É a mensagem (não dá para burlar o dedupe)", async () => {
  const {env} = ambienteRec();
  regra(env, "discord_teste", {fonte: "discord_mensagem", max_unidades_dia: 5});
  canais(env, "discord_teste", CANAL);
  const base = {regra: "discord_teste"};
  assert.equal((await conceder(env, {...base, chave: "discord:avulso:001"})).dados.erro, "evidencia_invalida");
  assert.equal((await conceder(env, {...base, chave: "qualquer-chave-1", evidencia: evDiscord().evidencia})).dados.erro, "chave_invalida");
  assert.equal((await conceder(env, {...base, ...evDiscord(), evidencia: {...evDiscord().evidencia, mensagem_id: "abc"}})).dados.erro, "evidencia_invalida");
  assert.equal((await conceder(env, {...base, ...evDiscord(), evidencia: {...evDiscord().evidencia, texto: "oi"}})).dados.erro, "evidencia_invalida", "campo fora do combinado (conteúdo de mensagem) não passa");
  const ok = await conceder(env, {...base, ...evDiscord()});
  assert.equal(ok.dados.concedida, true);
  assert.equal(linha(env, "SELECT discord_id, evidencia FROM concessoes").discord_id, DC_A);
  assert.deepEqual(JSON.parse(linha(env, "SELECT evidencia FROM concessoes").evidencia), evDiscord().evidencia);
  assert.equal((await conceder(env, {...base, ...evDiscord()})).dados.repetido, true, "a mesma mensagem não paga de novo");
});

test("Discord: duas contas do jogo ligadas à mesma conta Discord dividem o teto diário", async () => {
  const {env} = ambienteRec();
  regra(env, "discord_teste", {fonte: "discord_mensagem", max_unidades_dia: 2});
  canais(env, "discord_teste", CANAL);
  const d = (uuid, nome, msg) => conceder(env, {uuid, nome, regra: "discord_teste", ...evDiscord(msg)});
  assert.equal((await d(UUID_JOGADOR, "dvdiso", "300000000000000001")).dados.concedida, true);
  assert.equal((await d(UUID_B, "alternativa", "300000000000000002")).dados.concedida, true);
  assert.equal((await d(UUID_B, "alternativa", "300000000000000003")).dados.motivo, "teto_diario_conta_discord");
  assert.equal((await d(UUID_JOGADOR, "dvdiso", "300000000000000004")).dados.motivo, "teto_diario_conta_discord");
  // Outra conta Discord tem o próprio teto.
  assert.equal((await conceder(env, {uuid: UUID_B, nome: "alternativa", regra: "discord_teste", ...evDiscord("300000000000000005", DC_B)})).dados.concedida, true);
});

test("Discord: com verificar_discord o Worker relê a mensagem; autor, bot, canal, idade e inexistente são recusados", async () => {
  const a = ambienteRec({DISCORD_BOT_TOKEN: "token-de-teste"});
  const {env, discord} = a;
  regra(env, "discord_teste", {fonte: "discord_mensagem", max_unidades_dia: 20, verificar_discord: 1});
  canais(env, "discord_teste", CANAL);
  const tentar = async (msg, cadastrar, usuario = DC_A) => {
    if (cadastrar) discord.mensagens.set(`${CANAL}:${msg}`, cadastrar);
    return (await conceder(env, {regra: "discord_teste", ...evDiscord(msg, usuario)})).dados;
  };
  assert.equal((await tentar("300000000000000001", mensagemDiscord())).concedida, true);
  assert.equal(discord.chamadas[0].auth, "Bot token-de-teste");
  assert.equal((await tentar("300000000000000002", mensagemDiscord({author: {id: DC_B, bot: false}}))).motivo, "autor_divergente");
  assert.equal((await tentar("300000000000000003", mensagemDiscord({author: {id: DC_A, bot: true}}))).motivo, "autor_bot");
  assert.equal((await tentar("300000000000000004", mensagemDiscord({channel_id: "999999999999999999"}))).motivo, "canal_divergente");
  assert.equal((await tentar("300000000000000005", mensagemDiscord({timestamp: new Date(Date.now() - 3600_000).toISOString()}))).motivo, "evento_antigo");
  assert.equal((await tentar("300000000000000006", null)).motivo, "evento_inexistente");
  const antes = discord.chamadas.length;
  assert.equal((await tentar("300000000000000001", null)).repetido, true);
  assert.equal(discord.chamadas.length, antes, "evento já pago não consulta o Discord de novo");
  discord.falhar = true;
  const falha = await conceder(env, {regra: "discord_teste", ...evDiscord("300000000000000007")});
  assert.deepEqual([falha.status, falha.dados.erro], [502, "discord_indisponivel"]);
  assert.equal(linhas(env, "SELECT * FROM concessoes").length, 1, "falha do Discord não paga nem queima a chave");
  // Sem o token do bot a verificação pedida não é contornada.
  const b = ambienteRec();
  regra(b.env, "discord_teste", {fonte: "discord_mensagem", verificar_discord: 1});
  canais(b.env, "discord_teste", CANAL);
  assert.equal((await conceder(b.env, {regra: "discord_teste", ...evDiscord()})).dados.motivo, "verificacao_indisponivel");
});

test("Discord: allowlist de canais por regra; sem lista ou canal fora dela não paga nem consulta o Discord", async () => {
  const a = ambienteRec({DISCORD_BOT_TOKEN: "token-de-teste"});
  const {env, discord} = a;
  const OUTRO = "200000000000000002";
  regra(env, "discord_teste", {fonte: "discord_mensagem", max_unidades_dia: 20, verificar_discord: 1});
  regra(env, "discord_outra", {fonte: "discord_reacao", max_unidades_dia: 20});
  const msg = (canal, id) => ({chave: `discord:${canal}:${id}`, evidencia: {discord_user_id: DC_A, canal_id: canal, mensagem_id: id}});
  discord.mensagens.set(`${CANAL}:300000000000000001`, mensagemDiscord());
  discord.mensagens.set(`${OUTRO}:300000000000000002`, mensagemDiscord({id: "300000000000000002", channel_id: OUTRO}));
  // Falha fechada: regra de Discord ativa sem nenhum canal cadastrado não paga.
  const sem = await conceder(env, {regra: "discord_teste", ...msg(CANAL, "300000000000000001")});
  assert.deepEqual([sem.dados.concedida, sem.dados.motivo], [false, "canal_nao_permitido"]);
  assert.equal(saldoPrisma(env), 0);
  canais(env, "discord_teste", CANAL);
  const fora = await conceder(env, {regra: "discord_teste", ...msg(OUTRO, "300000000000000002")});
  assert.equal(fora.dados.motivo, "canal_nao_permitido", "canal que não está na lista da regra");
  assert.equal(discord.chamadas.length, 0, "recusa antes de consultar o Discord");
  assert.equal(recusas(env, "discord_teste", "canal_nao_permitido"), 2);
  assert.equal((await conceder(env, {regra: "discord_teste", ...msg(CANAL, "300000000000000001")})).dados.concedida, true);
  // A lista é por regra: o canal liberado numa regra não vale para outra.
  assert.equal((await conceder(env, {regra: "discord_outra", ...msg(CANAL, "300000000000000003")})).dados.motivo, "canal_nao_permitido");
  // Canal removido da lista volta a ser recusado; evento já pago segue idempotente.
  env.DB.sqlite.exec("DELETE FROM recompensa_canais");
  assert.equal((await conceder(env, {regra: "discord_teste", ...msg(CANAL, "300000000000000001")})).dados.repetido, true);
  assert.equal((await conceder(env, {regra: "discord_teste", ...msg(CANAL, "300000000000000004")})).dados.motivo, "canal_nao_permitido");
  // Regras de outras fontes ignoram a lista.
  regra(env, "tempo_livre");
  assert.equal((await conceder(env, {regra: "tempo_livre", chave: "tempo:teste:0099"})).dados.concedida, true);
  // GET regras informa os canais para o plugin filtrar antes de enviar.
  canais(env, "discord_teste", CANAL, OUTRO);
  const regras = (await servidor(env, "GET", "/servidor/recompensas/regras")).dados.regras;
  assert.deepEqual(regras.map(r => [r.id, r.canais]), [["discord_outra", []], ["discord_teste", [CANAL, OUTRO]], ["tempo_livre", []]]);
});

test("banco: canal da allowlist precisa ser um id do Discord e a regra precisa existir", () => {
  const {env} = ambienteRec();
  regra(env, "discord_teste", {fonte: "discord_mensagem"});
  const ins = (r, c) => env.DB.sqlite.exec(`INSERT INTO recompensa_canais (regra_id, canal_id, criado_em) VALUES ('${r}', '${c}', 1)`);
  assert.throws(() => ins("discord_teste", "geral"), /CHECK/);
  assert.throws(() => ins("discord_teste", "123"), /CHECK/);
  assert.throws(() => ins("discord_teste", "2000000000000000x1"), /CHECK/);
  assert.throws(() => ins("nao_existe", CANAL), /FOREIGN/);
  ins("discord_teste", CANAL);
  assert.throws(() => ins("discord_teste", CANAL), /UNIQUE|PRIMARY/);
});

test("idade máxima do evento por regra: ocorrido_em antigo é recusado; sem limite, sem campo ou dentro do prazo passa", async () => {
  const {env} = ambienteRec();
  regra(env, "tempo_teste", {max_unidades_dia: 50, idade_maxima_segundos: 3600});
  regra(env, "sem_limite", {max_unidades_dia: 50});
  const t = agora();
  const c = (regraId, chave, ocorrido_em) => conceder(env, {regra: regraId, chave, ...(ocorrido_em === undefined ? {} : {ocorrido_em})});
  assert.equal((await c("tempo_teste", "tempo:teste:a001", t - 600)).dados.concedida, true, "dentro do prazo");
  const velho = await c("tempo_teste", "tempo:teste:a002", t - 7200);
  assert.deepEqual([velho.status, velho.dados.concedida, velho.dados.motivo], [200, false, "evento_antigo"]);
  assert.equal(recusas(env, "tempo_teste", "evento_antigo"), 1);
  assert.equal(linhas(env, "SELECT * FROM concessoes WHERE chave = 'tempo:teste:a002'").length, 0, "recusa não grava concessão nem queima a chave");
  assert.equal((await c("tempo_teste", "tempo:teste:a003")).dados.concedida, true, "sem o campo: aceita como antes");
  assert.equal((await c("sem_limite", "tempo:teste:a004", t - 90 * 86400)).dados.concedida, true, "regra sem limite aceita qualquer idade");
  assert.equal((await c("tempo_teste", "tempo:teste:a001", t - 7200)).dados.repetido, true, "evento já pago continua idempotente");
  // Folga de relógio: pequeno futuro passa; futuro grande, zero, negativo, decimal e texto são 400.
  assert.equal((await c("tempo_teste", "tempo:teste:a005", t + 60)).dados.concedida, true);
  for (const v of [t + 3600, 0, -5, 1.5, String(t)]) assert.equal((await c("tempo_teste", "tempo:teste:a006", v)).dados.erro, "ocorrido_em_invalido", String(v));
  // O limite chega ao plugin no GET regras; o banco recusa limites menores que 60 s.
  const regras = (await servidor(env, "GET", "/servidor/recompensas/regras")).dados.regras;
  assert.deepEqual(regras.map(r => [r.id, r.idade_maxima_segundos]), [["sem_limite", null], ["tempo_teste", 3600]]);
  assert.throws(() => regra(env, "limite_curto", {idade_maxima_segundos: 5}), /CHECK/);
});

test("entradas inválidas e HMAC", async () => {
  const {env} = ambienteRec();
  regra(env, "tempo_teste");
  for (const [corpo, erro] of [
    [{uuid: "x"}, "uuid_invalido"], [{nome: "a"}, "nome_invalido"], [{regra: "Regra Ruim"}, "regra_invalida"], [{chave: "curta"}, "chave_invalida"],
    [{chave: "tem espaço aqui"}, "chave_invalida"], [{unidades: 0}, "unidades_invalidas"], [{unidades: 1.5}, "unidades_invalidas"], [{unidades: "2"}, "unidades_invalidas"],
  ]) {
    const r = await conceder(env, corpo);
    assert.deepEqual([r.status, r.dados.erro], [400, erro], JSON.stringify(corpo));
  }
  const semAssinatura = await handle(new Request(`${BASE}/servidor/recompensas/conceder`, {method: "POST", body: "{}"}), env);
  assert.equal(semAssinatura.status, 401);
  assert.equal((await site(env, "POST", "/servidor/recompensas/conceder", {}, {Authorization: "Bearer x".padEnd(40, "x")})).status, 401);
  assert.equal(linhas(env, "SELECT * FROM concessoes").length, 0);
});

test("GET regras: só as ativas, com tetos, para o plugin sincronizar", async () => {
  const {env} = ambienteRec();
  regra(env, "tempo_teste");
  regra(env, "desligada", {ativo: 0});
  const r = await servidor(env, "GET", "/servidor/recompensas/regras");
  assert.deepEqual(r.dados.regras.map(x => x.id), ["tempo_teste"]);
  assert.deepEqual(Object.keys(r.dados.regras[0]).sort(), ["advancement_id", "canais", "fonte", "id", "idade_maxima_segundos", "intervalo_minimo_segundos", "max_unidades_dia", "max_unidades_por_chamada", "moeda", "quantidade", "verificar_discord"]);
});

test("banco: regra sem teto diário, moeda inválida e teto zero são recusadas", () => {
  const {env} = ambienteRec();
  const ins = (id, moeda, teto) => env.DB.sqlite.exec(`INSERT INTO recompensa_regras (id, fonte, moeda, quantidade, max_unidades_dia, criado_em, atualizado_em) VALUES ('${id}', 'tempo_jogado', '${moeda}', 1, ${teto}, 1, 1)`);
  assert.throws(() => env.DB.sqlite.exec("INSERT INTO recompensa_regras (id, fonte, moeda, quantidade, criado_em, atualizado_em) VALUES ('sem_teto', 'tempo_jogado', 'prisma', 1, 1, 1)"), /NOT NULL/);
  assert.throws(() => ins("moeda_ruim", "ouro", 5), /CHECK/);
  assert.throws(() => ins("teto_zero", "iris", 0), /CHECK/);
});

test("disjuntor de emissão mensal por moeda: soma todas as regras (tiers), separa Prisma de Iris e reabre no mês seguinte", async () => {
  const {env} = ambienteRec();
  regra(env, "conquista_t1", {fonte: "conquista", quantidade: 7, max_unidades_dia: 50});
  regra(env, "conquista_t2", {fonte: "conquista", quantidade: 7, max_unidades_dia: 50});
  regra(env, "iris_teste", {moeda: "iris", quantidade: 7, max_unidades_dia: 50});
  // Sem linha em recompensa_tetos_moeda não há teto.
  assert.equal((await conceder(env, {regra: "conquista_t1", chave: "conquista:a:0001xx"})).dados.concedida, true);
  env.DB.sqlite.exec(`INSERT INTO recompensa_tetos_moeda (moeda, max_quantidade_mes, atualizado_em) VALUES ('prisma', 20, 1)`);
  assert.equal((await conceder(env, {regra: "conquista_t2", chave: "conquista:a:0002xx"})).dados.concedida, true);   // 7 + 7 = 14
  const barrado = await conceder(env, {regra: "conquista_t1", chave: "conquista:a:0003xx"});                          // 21 > 20
  assert.deepEqual(barrado.dados, {concedida: false, motivo: "teto_mensal_emissao"});
  assert.equal((await conceder(env, {regra: "conquista_t2", chave: "conquista:a:0004xx", uuid: UUID_B, nome: "outro"})).dados.motivo, "teto_mensal_emissao", "vale para todos os jogadores");
  assert.equal(saldoPrisma(env), 14);
  assert.equal(recusas(env, "conquista_t1", "teto_mensal_emissao"), 1);
  // A Iris tem teto próprio (aqui, sem teto): não é afetada pelo da Prisma.
  assert.equal((await conceder(env, {regra: "iris_teste", chave: "iris:teste:0001"})).dados.concedida, true);
  // Mês seguinte: o que foi emitido no mês passado não conta.
  env.DB.sqlite.exec("UPDATE concessoes SET criado_em = criado_em - 40 * 86400, dia = dia - 40");
  assert.equal((await conceder(env, {regra: "conquista_t1", chave: "conquista:a:0003xx"})).dados.concedida, true);
});

test("disjuntor mensal não passa do teto sob concorrência", async () => {
  const {env} = ambienteRec();
  regra(env, "tempo_teste", {max_unidades_dia: 50, max_unidades_por_chamada: 5});
  env.DB.sqlite.exec(`INSERT INTO recompensa_tetos_moeda (moeda, max_quantidade_mes, atualizado_em) VALUES ('prisma', 30, 1)`);
  const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(i => conceder(env, {chave: `tempo:teste:mes${i}xx`, unidades: 1})));
  assert.equal(rs.filter(r => r.dados.concedida).length, 4);      // 4 x 7 = 28 <= 30
  assert.equal(saldoPrisma(env), 28);
});

test("teto mensal inválido é recusado pelo banco", () => {
  const {env} = ambienteRec();
  assert.throws(() => env.DB.sqlite.exec("INSERT INTO recompensa_tetos_moeda (moeda, max_quantidade_mes, atualizado_em) VALUES ('prisma', 0, 1)"), /CHECK/);
  assert.throws(() => env.DB.sqlite.exec("INSERT INTO recompensa_tetos_moeda (moeda, max_quantidade_mes, atualizado_em) VALUES ('ouro', 5, 1)"), /CHECK/);
});
