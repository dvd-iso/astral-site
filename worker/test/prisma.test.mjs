// Testes do Prisma (moeda premium comprável, só cosméticos): node --test worker/test/prisma.test.mjs (Node 22.13+).
// Sem rede: o Mercado Pago é simulado. Pacotes e valores abaixo são DADOS DE TESTE, não política de preço.
import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {criarD1} from "./d1-sqlite.mjs";
import {handle, tarefas, hmacHex, sha256hex, agora} from "../loja.mjs";

const PASTA = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "loja");
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

// ---------- específicos do Prisma ----------

/** Ambiente com Prisma ligado e dois pacotes de TESTE (100 Prisma por R$ 5,00 e 500 por R$ 20,00). */
function ambientePrisma(extra = {}) {
  const a = ambiente({PRISMA_ATIVO: "sim", PRISMA_GASTOS_ATIVO: "sim", ...extra});
  const t = agora();
  a.env.DB.sqlite.exec(`INSERT INTO prisma_pacotes (id, nome, quantidade, preco_centavos, preco_confirmado, ativo, ordem, criado_em, atualizado_em) VALUES
    ('prisma_teste_100', 'Teste 100', 100, 500, 1, 1, 1, ${t}, ${t}),
    ('prisma_teste_500', 'Teste 500', 500, 2000, 1, 1, 2, ${t}, ${t}),
    ('prisma_teste_off', 'Teste inativo', 10, 100, 1, 0, 3, ${t}, ${t})`);
  return a;
}

const auth = token => ({Authorization: `Bearer ${token}`});

async function comprarPacote(env, token, pacote = "prisma_teste_100") {
  const r = await site(env, "POST", "/api/prisma/pedidos", {pacote_id: pacote}, auth(token));
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  return r.dados.pedido_id;
}

/** Compra, paga e processa o webhook; devolve o id do pedido. */
async function creditar(env, mp, token, pagamentoId = 5001, pacote = "prisma_teste_100", valor = 5) {
  const pedidoId = await comprarPacote(env, token, pacote);
  mp.pagar(pagamentoId, `prisma:${pedidoId}`, {transaction_amount: valor});
  assert.equal((await notificar(env, pagamentoId)).status, 200);
  return pedidoId;
}

const saldo = (env, uuid = UUID_JOGADOR) => linha(env, "SELECT COALESCE(SUM(quantidade), 0) AS s FROM prisma_lancamentos WHERE uuid = ?", uuid).s;
const gastar = (env, corpo) => servidor(env, "POST", "/servidor/prisma/gastar", {uuid: UUID_JOGADOR, quantidade: 30, ref: "evento-0001-abc", item: "asas_arcoiris", ...corpo});

test("migrações 0003/0004: catálogo aprovado nasce inativo e as tabelas antigas seguem intactas", () => {
  const {env} = ambiente();
  assert.deepEqual(linhas(env, "SELECT id, nome, quantidade, preco_centavos, moeda, preco_confirmado, ativo FROM prisma_pacotes ORDER BY ordem"), [
    {id: "prisma_100", nome: "100 Prisma", quantidade: 100, preco_centavos: 990, moeda: "BRL", preco_confirmado: 1, ativo: 0},
    {id: "prisma_275", nome: "275 Prisma", quantidade: 275, preco_centavos: 2490, moeda: "BRL", preco_confirmado: 1, ativo: 0},
    {id: "prisma_600", nome: "600 Prisma", quantidade: 600, preco_centavos: 4990, moeda: "BRL", preco_confirmado: 1, ativo: 0},
  ]);
  assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos").length, 0);
  assert.equal(linhas(env, "SELECT id FROM produtos WHERE tipo = 'pet'").length, 7);
  assert.equal(linhas(env, "SELECT id FROM produtos WHERE tipo = 'apoio'").length, 3);
});

/** Ambiente em modo REAL com os pacotes aprovados ativados (o que a equipe faria por SQL no dia da abertura). */
function ambienteAprovado(extra = {}) {
  const a = ambiente({PRISMA_ATIVO: "sim", PRISMA_GASTOS_ATIVO: "sim", LOJA_MODO: "real", LOJA_VENDAS_REAIS: "sim", ...extra});
  a.env.DB.sqlite.exec("UPDATE prisma_pacotes SET ativo = 1");
  return a;
}

test("catálogo aprovado: pacotes inativos não vendem nem aparecem; ativados, a rota pública lista os três em ordem", async () => {
  const {env} = ambiente({PRISMA_ATIVO: "sim", LOJA_MODO: "real", LOJA_VENDAS_REAIS: "sim"});
  const token = await vincular(env);
  assert.deepEqual((await site(env, "GET", "/api/prisma/pacotes")).dados.pacotes, [], "sem sessão, nada ativo");
  assert.equal((await site(env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_100"}, auth(token))).dados.erro, "produto_indisponivel");
  env.DB.sqlite.exec("UPDATE prisma_pacotes SET ativo = 1");
  const r = await site(env, "GET", "/api/prisma/pacotes");           // público: sem Authorization
  assert.equal(r.status, 200);
  assert.deepEqual(r.dados.pacotes.map(p => [p.id, p.quantidade, p.preco_centavos, p.a_venda, p.preco_de_teste]), [
    ["prisma_100", 100, 990, true, false], ["prisma_275", 275, 2490, true, false], ["prisma_600", 600, 4990, true, false]]);
  assert.equal(r.dados.gastos_ativos, false, "gasto de cosméticos ainda desligado");
  const semFlag = ambiente({});
  assert.equal((await site(semFlag.env, "GET", "/api/prisma/pacotes")).dados.erro, "prisma_desativado");
});

test("checkout dos três pacotes aprovados em modo real: preço do banco, crédito exato e valor errado não credita", async () => {
  for (const [id, quantidade, centavosPacote] of [["prisma_100", 100, 990], ["prisma_275", 275, 2490], ["prisma_600", 600, 4990]]) {
    const {env, mp} = ambienteAprovado();
    const token = await vincular(env);
    const pedidoId = await comprarPacote(env, token, id);
    const pref = mp.chamadas.find(c => c.caminho === "/checkout/preferences").corpo;
    assert.equal(pref.items[0].unit_price, centavosPacote / 100, id);
    assert.equal(pref.items[0].currency_id, "BRL");
    assert.equal(pref.items[0].title, `Astral · ${quantidade} Prisma`);
    assert.equal(pref.external_reference, `prisma:${pedidoId}`);
    assert.equal(linha(env, "SELECT quantidade, valor_centavos, modo FROM prisma_pedidos").modo, "real");
    // Pagamento de outro valor (ex.: o do pacote menor) nunca credita este pedido.
    mp.pagar(7001, `prisma:${pedidoId}`, {transaction_amount: id === "prisma_100" ? 24.9 : 9.9, live_mode: true});
    await notificar(env, 7001);
    assert.equal(saldo(env), 0, `${id}: valor divergente`);
    // Pagamento correto, ao vivo.
    mp.pagar(7002, `prisma:${pedidoId}`, {transaction_amount: centavosPacote / 100, live_mode: true});
    await notificar(env, 7002);
    await notificar(env, 7002);
    assert.equal(saldo(env), quantidade, id);
    assert.equal(linha(env, "SELECT estado FROM prisma_pedidos").estado, "pago");
    assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos").length, 1);
  }
});

test("pacote aprovado não vende em modo real sem LOJA_VENDAS_REAIS nem com loja pausada", async () => {
  const a = ambienteAprovado({LOJA_VENDAS_REAIS: "nao"});
  const token = await vincular(a.env);
  assert.equal((await site(a.env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_100"}, auth(token))).dados.erro, "vendas_reais_desativadas");
  const b = ambienteAprovado({LOJA_PAUSADA: "sim"});
  const t2 = await vincular(b.env);
  assert.equal((await site(b.env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_100"}, auth(t2))).dados.erro, "loja_pausada");
});

test("gasto de cosméticos fica desligado até PRISMA_GASTOS_ATIVO; comprar e ver o saldo continuam", async () => {
  const {env, mp} = ambientePrisma({PRISMA_GASTOS_ATIVO: undefined});
  const token = await vincular(env);
  await creditar(env, mp, token);
  const r = await gastar(env, {});
  assert.deepEqual([r.status, r.dados.erro], [403, "gastos_desativados"]);
  assert.equal(saldo(env), 100);
  assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos WHERE tipo = 'gasto'").length, 0);
  assert.equal((await servidor(env, "GET", `/servidor/prisma/jogador/${UUID_JOGADOR}`)).dados.saldo, 100);
  assert.equal((await site(env, "GET", "/api/prisma", undefined, auth(token))).dados.gastos_ativos, false);
});

test("sem PRISMA_ATIVO tudo responde 404 e a compra de pet segue igual", async () => {
  const {env, mp} = ambiente();           // sem PRISMA_ATIVO
  const token = await vincular(env);
  assert.equal((await site(env, "GET", "/api/prisma", undefined, auth(token))).dados.erro, "prisma_desativado");
  assert.equal((await site(env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_teste_100"}, auth(token))).status, 404);
  assert.equal((await servidor(env, "POST", "/servidor/prisma/gastar", {})).status, 404);
  assert.equal((await servidor(env, "GET", `/servidor/prisma/jogador/${UUID_JOGADOR}`)).status, 404);
  // Um pagamento com referência prisma: não libera nada e não quebra o webhook.
  mp.pagar(9001, "prisma:" + crypto.randomUUID());
  assert.equal((await notificar(env, 9001)).status, 200);
  assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos").length, 0);
  // Compra do gato intacta.
  const pedidoId = await comprarGato(env, token);
  mp.pagar(9002, pedidoId);
  assert.equal((await notificar(env, 9002)).status, 200);
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'pet_gato'").estado, "ativo");
  assert.equal(linhas(env, "SELECT * FROM entregas").length, 1);
});

test("compra de pacote: preço e quantidade do banco, crédito único mesmo com webhook repetido", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  const pedidoId = await comprarPacote(env, token);
  const chamada = mp.chamadas.find(c => c.caminho === "/checkout/preferences");
  assert.equal(chamada.corpo.items[0].unit_price, 5);
  assert.equal(chamada.corpo.external_reference, `prisma:${pedidoId}`);
  assert.equal(chamada.headers["X-Idempotency-Key"], `prisma-${pedidoId}`);
  assert.deepEqual(chamada.corpo.payment_methods.excluded_payment_types.map(t => t.id), ["ticket", "atm"]);
  assert.equal(saldo(env), 0, "nada creditado antes do pagamento");

  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5});
  assert.equal((await notificar(env, 5001, {segredo: "falso"})).status, 401);
  assert.equal(saldo(env), 0);
  for (let i = 0; i < 3; i++) assert.equal((await notificar(env, 5001)).status, 200);
  assert.equal(saldo(env), 100);
  assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos").length, 1);
  assert.equal(linha(env, "SELECT estado, pagamento_id FROM prisma_pedidos").estado, "pago");
  assert.equal(linhas(env, "SELECT * FROM pedidos").length, 0, "não mistura com os pedidos de pets e apoios");
  assert.equal(linhas(env, "SELECT * FROM entregas").length, 0, "Prisma não usa a fila de entregas de direitos");

  const painel = await site(env, "GET", "/api/prisma", undefined, auth(token));
  assert.equal(painel.dados.saldo, 100);
  assert.deepEqual(painel.dados.pacotes.map(p => p.id), ["prisma_teste_100", "prisma_teste_500"], "pacote inativo não aparece");
  const ver = await site(env, "GET", `/api/prisma/pedidos/${pedidoId}`, undefined, auth(token));
  assert.equal(ver.dados.estado, "pago");
  assert.equal(ver.dados.saldo, 100);
});

test("pedido: pacote inativo, inexistente ou preço enviado pelo cliente não valem; sem sessão não compra", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  assert.equal((await site(env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_teste_off"}, auth(token))).status, 403);
  assert.equal((await site(env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_nao_existe"}, auth(token))).status, 404);
  assert.equal((await site(env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_teste_100"})).status, 401);
  const r = await site(env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_teste_100", preco_centavos: 1, quantidade: 999999, valor: 0.01}, auth(token));
  assert.equal(r.status, 200);
  assert.equal(mp.chamadas.at(-1).corpo.items[0].unit_price, 5);
  assert.equal(linha(env, "SELECT quantidade, valor_centavos FROM prisma_pedidos").quantidade, 100);
  // Pedido aberto igual é reaproveitado.
  assert.equal((await site(env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_teste_100"}, auth(token))).dados.reaproveitado, true);
});

test("venda real exige LOJA_VENDAS_REAIS e preço confirmado; loja pausada bloqueia", async () => {
  const real = ambientePrisma({LOJA_MODO: "real", LOJA_VENDAS_REAIS: "nao"});
  const token = await vincular(real.env);
  assert.equal((await site(real.env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_teste_100"}, auth(token))).dados.erro, "vendas_reais_desativadas");
  const pausada = ambientePrisma({LOJA_PAUSADA: "sim"});
  const t2 = await vincular(pausada.env);
  assert.equal((await site(pausada.env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_teste_100"}, auth(t2))).dados.erro, "loja_pausada");
  const a = ambientePrisma({LOJA_MODO: "real", LOJA_VENDAS_REAIS: "sim"});
  a.env.DB.sqlite.exec("UPDATE prisma_pacotes SET preco_confirmado = 0");
  const t3 = await vincular(a.env);
  assert.equal((await site(a.env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_teste_100"}, auth(t3))).dados.erro, "preco_nao_confirmado");
});

test("divergências (valor, conta, modo real com pagamento de teste) não creditam", async () => {
  for (const [extra, motivo, ambExtra] of [
    [{transaction_amount: 1}, "valor", {}],
    [{collector_id: 999}, "conta_recebedora", {}],
    [{live_mode: false, transaction_amount: 5}, "modo_teste_em_pedido_real", {LOJA_MODO: "real", LOJA_VENDAS_REAIS: "sim"}],
  ]) {
    const {env, mp} = ambientePrisma(ambExtra);
    const token = await vincular(env);
    const pedidoId = await comprarPacote(env, token);
    mp.pagar(5002, `prisma:${pedidoId}`, {transaction_amount: 5, ...extra});
    await notificar(env, 5002);
    assert.equal(saldo(env), 0, motivo);
    if (motivo !== "conta_recebedora") assert.match(linha(env, "SELECT conferencia FROM pagamentos").conferencia, new RegExp(motivo));
  }
});

test("pagamento duplicado do mesmo pedido não credita duas vezes", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  const pedidoId = await creditar(env, mp, token, 5001);
  mp.pagar(5003, `prisma:${pedidoId}`, {transaction_amount: 5});
  await notificar(env, 5003);
  assert.equal(saldo(env), 100);
  assert.match(linha(env, "SELECT detalhe FROM eventos_pagamento WHERE pagamento_id = '5003'").detalhe, /reembolsar_manual/);
});

test("gasto: debita, é idempotente, recusa saldo insuficiente e ref reaproveitada com dados diferentes", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  await creditar(env, mp, token);
  const g = await gastar(env, {});
  assert.deepEqual([g.status, g.dados.ok, g.dados.repetido, g.dados.saldo], [200, true, false, 70]);
  const repetido = await gastar(env, {});
  assert.deepEqual([repetido.status, repetido.dados.repetido, repetido.dados.saldo], [200, true, 70], "repetir não gasta de novo");
  assert.equal(saldo(env), 70);
  assert.equal((await gastar(env, {quantidade: 31})).dados.erro, "ref_em_uso");
  assert.equal((await gastar(env, {item: "outro_item"})).dados.erro, "ref_em_uso");
  const caro = await gastar(env, {ref: "evento-0002-abc", quantidade: 71});
  assert.deepEqual([caro.status, caro.dados.erro, caro.dados.saldo], [409, "saldo_insuficiente", 70]);
  assert.equal(saldo(env), 70);
  // Gastos simultâneos com refs diferentes nunca passam do saldo (70): só dois de 30 cabem.
  const rs = await Promise.all([1, 2, 3, 4, 5].map(i => gastar(env, {ref: `evento-par-${i}-abc`, item: `item_${i}`})));
  assert.equal(rs.filter(r => r.status === 200).length, 2);
  assert.equal(saldo(env), 10);
  const j = await servidor(env, "GET", `/servidor/prisma/jogador/${UUID_JOGADOR}`);
  assert.equal(j.dados.saldo, 10);
  assert.equal(j.dados.itens.length, 3);
  assert.deepEqual(j.dados.itens[0], {item_id: "asas_arcoiris", preco: 30, ref: "evento-0001-abc", criado_em: j.dados.itens[0].criado_em});
});

test("gasto: entradas inválidas e jogador sem saldo", async () => {
  const {env} = ambientePrisma();
  for (const [corpo, erro] of [
    [{uuid: "x"}, "uuid_invalido"], [{quantidade: 0}, "quantidade_invalida"], [{quantidade: -5}, "quantidade_invalida"],
    [{quantidade: 1.5}, "quantidade_invalida"], [{quantidade: "30"}, "quantidade_invalida"], [{quantidade: 100001}, "quantidade_invalida"],
    [{ref: "curta"}, "ref_invalida"], [{ref: "tem espaço aqui!"}, "ref_invalida"], [{item: "Item Ruim"}, "item_invalido"], [{item: undefined}, "item_invalido"],
  ]) {
    const r = await gastar(env, corpo);
    assert.equal(r.dados.erro, erro, JSON.stringify(corpo));
    assert.equal(r.status, 400);
  }
  assert.equal((await gastar(env, {})).dados.erro, "saldo_insuficiente", "jogador que nunca comprou");
  assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos").length, 0);
});

test("estorno: devolve o gasto uma só vez, some dos itens e libera nova tentativa com ref nova", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  await creditar(env, mp, token);
  await gastar(env, {});
  const e = await servidor(env, "POST", "/servidor/prisma/estornar", {ref: "evento-0001-abc"});
  assert.deepEqual([e.status, e.dados.repetido, e.dados.saldo], [200, false, 100]);
  const e2 = await servidor(env, "POST", "/servidor/prisma/estornar", {ref: "evento-0001-abc"});
  assert.deepEqual([e2.dados.repetido, e2.dados.saldo], [true, 100]);
  assert.equal((await servidor(env, "POST", "/servidor/prisma/estornar", {ref: "evento-nunca-existiu"})).status, 404);
  assert.equal((await servidor(env, "GET", `/servidor/prisma/jogador/${UUID_JOGADOR}`)).dados.itens.length, 0);
  assert.equal((await gastar(env, {})).dados.erro, "ref_estornada", "ref estornada não vira um gasto de novo");
  assert.equal((await gastar(env, {ref: "evento-0003-abc"})).status, 200);
  assert.equal(saldo(env), 70);
});

const casos = env => linhas(env, "SELECT * FROM prisma_casos ORDER BY id");
const lanc = env => linhas(env, "SELECT tipo, quantidade FROM prisma_lancamentos ORDER BY id").map(l => `${l.tipo}:${l.quantidade}`);

test("reembolso total depois do gasto: retira só o que resta, abre caso, nunca deixa saldo negativo nem cobra depois", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  const pedidoId = await creditar(env, mp, token);
  await gastar(env, {quantidade: 80});
  assert.equal(saldo(env), 20);
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5, status: "refunded", transaction_amount_refunded: 5});
  await notificar(env, 5001);
  assert.equal(saldo(env), 0, "retirou os 20 que sobravam e parou em zero");
  assert.deepEqual(lanc(env), ["credito:100", "gasto:-80", "reversao:-20"]);
  assert.equal(linha(env, "SELECT estado FROM prisma_pedidos").estado, "reembolsado");
  const [c] = casos(env);
  assert.deepEqual([c.tipo, c.quantidade_pedido, c.quantidade_revertida, c.quantidade_pendente, c.acao_aplicada, c.estado], ["reembolso", 100, 20, 80, 1, "aberto"]);
  assert.match(linha(env, "SELECT detalhe FROM eventos_pagamento ORDER BY id DESC").detalhe, /caso_aberto:reembolso:pendente=80/);
  await notificar(env, 5001);
  assert.equal(casos(env).length, 1);
  assert.equal(saldo(env), 0, "repetir não reverte nem cobra de novo");
  // Prisma nova depois do caso NÃO é confiscada para quitar o pendente: cobrar é decisão humana.
  env.DB.sqlite.exec(`INSERT INTO prisma_lancamentos (uuid, tipo, quantidade, ref, detalhe, criado_em) VALUES ('${UUID_JOGADOR}', 'recompensa', 50, 'recompensa:x1', 'teste', ${agora()})`);
  await tarefas(env);
  await notificar(env, 5001);
  assert.equal(saldo(env), 50);
  assert.equal(linha(env, "SELECT quantidade_pendente AS p FROM prisma_casos").p, 80);
  // Os cosméticos continuam do jogador: nada revoga ou estorna item.
  assert.equal((await servidor(env, "GET", `/servidor/prisma/jogador/${UUID_JOGADOR}`)).dados.itens.length, 1);
});

test("reembolso total com saldo cheio: reverte tudo e não abre caso", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  const pedidoId = await creditar(env, mp, token);
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5, status: "refunded", transaction_amount_refunded: 5});
  await notificar(env, 5001);
  assert.equal(saldo(env), 0);
  assert.equal(casos(env).length, 0);
});

test("saldo vindo de outras fontes (recompensa) não é confiscado além do pedido", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  const pedidoId = await creditar(env, mp, token);
  env.DB.sqlite.exec(`INSERT INTO prisma_lancamentos (uuid, tipo, quantidade, ref, detalhe, criado_em) VALUES ('${UUID_JOGADOR}', 'recompensa', 40, 'recompensa:x2', 't', ${agora()})`);
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5, status: "charged_back"});
  await notificar(env, 5001);
  assert.equal(saldo(env), 40, "só os 100 do pedido saíram");
  assert.equal(casos(env).length, 0);
});

test("contestação retém o que existe; o gasto vira caso; resolvida a favor da loja libera; chargeback reverte e escala o caso", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  const pedidoId = await creditar(env, mp, token);
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5, status: "in_mediation"});
  await notificar(env, 5001);
  assert.equal(saldo(env), 0);
  assert.equal(linha(env, "SELECT estado FROM prisma_pedidos").estado, "em_disputa");
  assert.equal((await gastar(env, {quantidade: 1})).dados.erro, "saldo_insuficiente", "retido não se gasta");
  assert.equal(casos(env).length, 0, "retenção total não deixa pendência");
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5});
  await notificar(env, 5001);
  assert.equal(saldo(env), 100);
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5, status: "charged_back"});
  await notificar(env, 5001);
  assert.equal(saldo(env), 0);
  assert.equal(linha(env, "SELECT estado FROM prisma_pedidos").estado, "contestado");
  assert.deepEqual(linhas(env, "SELECT tipo FROM prisma_lancamentos ORDER BY id").map(l => l.tipo), ["credito", "retencao", "liberacao", "reversao"]);
});

test("contestação com Prisma já gasta: retém o resto, abre caso; chargeback depois só escala o caso; vitória da loja encerra", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  const pedidoId = await creditar(env, mp, token);
  await gastar(env, {quantidade: 70});
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5, status: "in_mediation"});
  await notificar(env, 5001);
  assert.equal(saldo(env), 0);
  let [c] = casos(env);
  assert.deepEqual([c.tipo, c.quantidade_revertida, c.quantidade_pendente, c.estado], ["contestacao", 30, 70, "aberto"]);
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5, status: "charged_back"});
  await notificar(env, 5001);
  [c] = casos(env);
  assert.deepEqual([c.tipo, c.quantidade_pendente, c.estado], ["chargeback", 70, "aberto"], "escala sem nova cobrança");
  assert.equal(saldo(env), 0);
  assert.deepEqual(lanc(env), ["credito:100", "gasto:-70", "retencao:-30"]);
  // A loja vence a disputa e o pagamento volta a approved: o Worker devolve o retido e fecha o caso.
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5});
  await notificar(env, 5001);
  assert.equal(saldo(env), 30);
  [c] = casos(env);
  assert.deepEqual([c.estado, c.resolucao], ["resolvido", "voltou_a_pago"]);
});

test("reembolso parcial mantém o crédito e abre caso de revisão sem mexer no saldo", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  const pedidoId = await creditar(env, mp, token);
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5, transaction_amount_refunded: 2});
  await notificar(env, 5001);
  assert.equal(saldo(env), 100);
  assert.match(linha(env, "SELECT detalhe FROM eventos_pagamento ORDER BY id DESC").detalhe, /reembolso_parcial:200/);
  const [c] = casos(env);
  assert.deepEqual([c.tipo, c.acao_aplicada, c.estado, c.nota], ["reembolso_parcial", 0, "aberto", "reembolsado_centavos=200"]);
  await notificar(env, 5001);
  assert.equal(casos(env).length, 1, "um caso por pedido");
});

test("casos para revisão: o plugin lista (com itens e saldo) e a equipe só muda o andamento, sem efeito no saldo", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  const pedidoId = await creditar(env, mp, token);
  await gastar(env, {quantidade: 80});
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5, status: "refunded", transaction_amount_refunded: 5});
  await notificar(env, 5001);
  const lista = await servidor(env, "GET", "/servidor/prisma/casos?apos=0");
  assert.equal(lista.status, 200);
  assert.equal(lista.dados.casos.length, 1);
  const c = lista.dados.casos[0];
  assert.deepEqual([c.uuid, c.tipo, c.quantidade_pendente, c.saldo, c.itens.map(i => i.item_id)], [UUID_JOGADOR, "reembolso", 80, 0, ["asas_arcoiris"]]);
  assert.equal((await servidor(env, "GET", "/servidor/prisma/casos?apos=x")).dados.erro, "cursor_invalido");
  assert.equal((await servidor(env, "GET", `/servidor/prisma/casos?apos=${c.id}`)).dados.casos.length, 0);
  const at = (corpo) => servidor(env, "POST", "/servidor/prisma/casos/atualizar", corpo);
  assert.equal((await at({id: c.id, estado: "em_analise", nota: "falando com o jogador"})).status, 200);
  assert.equal(linha(env, "SELECT estado, nota FROM prisma_casos").estado, "em_analise");
  assert.equal((await at({id: c.id, estado: "resolvido"})).dados.erro, "resolucao_obrigatoria");
  assert.equal((await at({id: c.id, estado: "feito"})).dados.erro, "estado_invalido");
  assert.equal((await at({id: 999, estado: "aberto"})).dados.erro, "caso_inexistente");
  assert.equal((await at({id: c.id, estado: "resolvido", resolucao: "perdoado"})).status, 200);
  assert.equal((await servidor(env, "GET", "/servidor/prisma/casos?apos=0")).dados.casos.length, 0, "resolvido sai da lista");
  assert.equal(saldo(env), 0, "atualizar caso nunca mexe no saldo");
  assert.equal(lanc(env).length, 3);
  const semFlag = ambiente({});
  assert.equal((await servidor(semFlag.env, "GET", "/servidor/prisma/casos?apos=0")).dados.erro, "prisma_desativado");
});

test("conciliação agendada recupera pagamento sem webhook e reconfere reembolso", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  const pedidoId = await comprarPacote(env, token);
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5});
  await tarefas(env);                       // nenhuma notificação chegou
  assert.equal(saldo(env), 100);
  await tarefas(env);
  assert.equal(saldo(env), 100, "idempotente");
  // Reembolso sem webhook: a reconferência (a cada 6 h) pega.
  mp.pagar(5001, `prisma:${pedidoId}`, {transaction_amount: 5, status: "refunded", transaction_amount_refunded: 5});
  env.DB.sqlite.exec(`UPDATE prisma_pedidos SET conferido_em = ${agora() - 7 * 3600}`);
  await tarefas(env);
  assert.equal(saldo(env), 0);
});

test("rotas do servidor exigem HMAC; o site não alcança /servidor/prisma", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  await creditar(env, mp, token);
  const semAssinatura = await handle(new Request(`${BASE}/servidor/prisma/gastar`, {method: "POST", body: JSON.stringify({uuid: UUID_JOGADOR, quantidade: 1, ref: "evento-0001-abc", item: "x_y"})}), env);
  assert.equal(semAssinatura.status, 401);
  const errado = await servidor(env, "POST", "/servidor/prisma/gastar", {uuid: UUID_JOGADOR, quantidade: 1, ref: "evento-0001-abc", item: "x_y"}, {segredo: "outro-segredo-qualquer-com-32-caracteres-ou-mais"});
  assert.equal(errado.status, 401);
  const comSessao = await site(env, "POST", "/servidor/prisma/gastar", {uuid: UUID_JOGADOR, quantidade: 1, ref: "evento-0001-abc", item: "x_y"}, auth(token));
  assert.equal(comSessao.status, 401);
  assert.equal(saldo(env), 100);
});

test("novos lançamentos: cursor para o plugin avisar créditos a quem está online", async () => {
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  await creditar(env, mp, token);
  await gastar(env, {});
  const todos = await servidor(env, "GET", "/servidor/prisma/novos?apos=0");
  assert.deepEqual(todos.dados.lancamentos.map(l => [l.tipo, l.quantidade]), [["credito", 100]], "gastos não entram no feed");
  const depois = await servidor(env, "GET", `/servidor/prisma/novos?apos=${todos.dados.lancamentos[0].id}`);
  assert.equal(depois.dados.lancamentos.length, 0);
  assert.equal((await servidor(env, "GET", "/servidor/prisma/novos?apos=abc")).dados.erro, "cursor_invalido");
});

test("o livro-razão recusa sinal errado e referência repetida", () => {
  const {env} = ambientePrisma();
  env.DB.sqlite.exec(`INSERT INTO jogadores (uuid, nome, criado_em, atualizado_em) VALUES ('${UUID_JOGADOR}', 'dvdiso', 1, 1)`);
  const ins = (tipo, q, ref, item = "null") => env.DB.sqlite.exec(`INSERT INTO prisma_lancamentos (uuid, tipo, quantidade, ref, item_id, criado_em) VALUES ('${UUID_JOGADOR}', '${tipo}', ${q}, '${ref}', ${item === "null" ? "NULL" : `'${item}'`}, 1)`);
  assert.throws(() => ins("credito", -5, "a1"), /CHECK/);
  assert.throws(() => ins("gasto", 5, "a2", "x_y"), /CHECK/);
  assert.throws(() => ins("gasto", -5, "a3"), /CHECK/, "gasto exige item");
  assert.throws(() => ins("credito", 0, "a4"), /CHECK/);
  ins("credito", 5, "a5");
  assert.throws(() => ins("credito", 5, "a5"), /UNIQUE/);
});

// ---------- compra de pet com Prisma ----------

/** Pets de TESTE: pet_gato (já ativo no catálogo) a 100 Prisma, ativo; pet_raposa sem preço ativo. */
function ambientePets(extra = {}) {
  const a = ambientePrisma(extra);
  a.env.DB.sqlite.exec("UPDATE prisma_precos SET ativo = 1 WHERE produto_id = 'pet_gato'; UPDATE produtos SET ativo = 1 WHERE id = 'pet_raposa'");
  return a;
}
const comprarPet = (env, corpo) => servidor(env, "POST", "/servidor/prisma/comprar", {uuid: UUID_JOGADOR, produto_id: "pet_gato", ref: "compra-0001-abc", ...corpo});

test("migração 0005: sete pets a 100 Prisma, todos inativos", () => {
  const {env} = ambiente();
  const r = linhas(env, "SELECT produto_id, preco_prisma, ativo FROM prisma_precos ORDER BY produto_id");
  assert.equal(r.length, 7);
  assert.ok(r.every(x => x.preco_prisma === 100 && x.ativo === 0));
});

test("pet com Prisma: debita, cria pedido PRISMA, direito ativo e entrega 'liberar' pelo mesmo caminho dos pets em reais", async () => {
  const {env, mp} = ambientePets();
  const token = await vincular(env);
  await creditar(env, mp, token, 5001, "prisma_teste_500", 20);
  assert.equal(saldo(env), 500);
  const r = await comprarPet(env, {});
  assert.deepEqual([r.status, r.dados.ok, r.dados.repetido, r.dados.saldo, r.dados.preco], [200, true, false, 400, 100]);
  assert.deepEqual(linha(env, "SELECT moeda, valor_centavos, estado, pagamento_id FROM pedidos"), {moeda: "PRISMA", valor_centavos: 100, estado: "pago", pagamento_id: null});
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'pet_gato'").estado, "ativo");
  assert.deepEqual(linha(env, "SELECT acao, estado FROM entregas"), {acao: "liberar", estado: "pendente"});
  const fila = (await servidor(env, "POST", "/servidor/entregas")).dados.entregas;
  assert.deepEqual(fila.map(e => [e.uuid, e.produto_id, e.acao]), [[UUID_JOGADOR, "pet_gato", "liberar"]], "o plugin recebe a entrega como em qualquer pet");
  assert.deepEqual(lanc(env).at(-1), "compra:-100");
  // Não aparece como gasto de cosmético (itens) nem na lista de pedidos em reais do site.
  assert.equal((await servidor(env, "GET", `/servidor/prisma/jogador/${UUID_JOGADOR}`)).dados.itens.length, 0);
  assert.equal((await site(env, "GET", "/api/conta", undefined, auth(token))).dados.pedidos.length, 0);
  // Idempotente: repetir a mesma ref não gasta nem cria nada de novo.
  const rep = await comprarPet(env, {});
  assert.deepEqual([rep.status, rep.dados.repetido, rep.dados.saldo], [200, true, 400]);
  assert.equal(saldo(env), 400);
  assert.equal(linhas(env, "SELECT * FROM entregas").length, 1);
  assert.equal(linhas(env, "SELECT * FROM historico_direitos").length, 1);
});

test("pet com Prisma: recusas (gate, preço, jogador já tem, saldo, ref reaproveitada, entradas inválidas)", async () => {
  const semGasto = ambientePets({PRISMA_GASTOS_ATIVO: "nao"});
  assert.equal((await comprarPet(semGasto.env, {})).dados.erro, "gastos_desativados");
  const {env, mp} = ambientePets();
  const token = await vincular(env);
  assert.equal((await comprarPet(env, {})).dados.erro, "saldo_insuficiente", "sem saldo");
  assert.equal(linhas(env, "SELECT * FROM pedidos").length, 0);
  await creditar(env, mp, token, 5001, "prisma_teste_500", 20);
  assert.equal((await comprarPet(env, {produto_id: "pet_axolote"})).dados.erro, "produto_sem_preco", "preço inativo");
  assert.equal((await comprarPet(env, {produto_id: "apoio_20"})).dados.erro, "produto_sem_preco", "só pets");
  env.DB.sqlite.exec("UPDATE prisma_precos SET ativo = 1 WHERE produto_id = 'pet_axolote'");
  assert.equal((await comprarPet(env, {produto_id: "pet_axolote"})).dados.erro, "produto_sem_preco", "produto inativo no catálogo");
  for (const [corpo, erro] of [[{uuid: "x"}, "uuid_invalido"], [{ref: "curta"}, "ref_invalida"], [{produto_id: "Pet Ruim"}, "produto_invalido"]]) {
    assert.equal((await comprarPet(env, corpo)).dados.erro, erro);
  }
  assert.equal((await comprarPet(env, {})).status, 200);
  assert.equal((await comprarPet(env, {ref: "compra-0002-abc"})).dados.erro, "ja_possui", "mesmo pet com outra ref");
  assert.equal((await comprarPet(env, {produto_id: "pet_raposa"})).dados.erro, "ref_em_uso", "mesma ref, outro produto");
  assert.equal(saldo(env), 400, "recusas não gastam");
  env.DB.sqlite.exec(`UPDATE prisma_precos SET preco_prisma = 450 WHERE produto_id = 'pet_raposa'; UPDATE prisma_precos SET ativo = 1 WHERE produto_id = 'pet_raposa'`);
  const caro = await comprarPet(env, {produto_id: "pet_raposa", ref: "compra-0003-abc"});
  assert.deepEqual([caro.status, caro.dados.erro, caro.dados.saldo], [409, "saldo_insuficiente", 400]);
  env.DB.sqlite.exec("UPDATE prisma_precos SET preco_prisma = 100 WHERE produto_id = 'pet_raposa'");
  env.LOJA_PAUSADA = "sim";
  assert.equal((await comprarPet(env, {produto_id: "pet_raposa", ref: "compra-0004-abc"})).dados.erro, "loja_pausada");
});

test("pet com Prisma: GET precos e preco_esperado (não cobra valor que o jogador não viu)", async () => {
  const {env, mp} = ambientePets();
  const token = await vincular(env);
  await creditar(env, mp, token);
  const precos = await servidor(env, "GET", "/servidor/prisma/precos");
  assert.deepEqual([precos.status, precos.dados.gastos_ativos, precos.dados.pets], [200, true, [{produto_id: "pet_gato", nome: "Gato", preco_prisma: 100, possui: false}]]);
  env.DB.sqlite.exec("UPDATE prisma_precos SET preco_prisma = 90 WHERE produto_id = 'pet_gato'");
  const div = await comprarPet(env, {preco_esperado: 100});
  assert.deepEqual([div.status, div.dados.erro, div.dados.preco], [409, "preco_divergente", 90]);
  assert.equal(saldo(env), 100, "nada foi cobrado");
  assert.equal(linhas(env, "SELECT * FROM pedidos WHERE moeda = 'PRISMA'").length, 0);
  for (const v of [0, -1, 1.5, "100"]) assert.equal((await comprarPet(env, {preco_esperado: v})).dados.erro, "preco_esperado_invalido");
  const ok = await comprarPet(env, {preco_esperado: 90});
  assert.deepEqual([ok.status, ok.dados.preco, ok.dados.saldo], [200, 90, 10]);
  // Repetição depois do sucesso devolve o resultado, mesmo que o preço mude ou a expectativa seja outra.
  env.DB.sqlite.exec("UPDATE prisma_precos SET preco_prisma = 120 WHERE produto_id = 'pet_gato'");
  const rep = await comprarPet(env, {preco_esperado: 100});
  assert.deepEqual([rep.status, rep.dados.repetido, rep.dados.preco, rep.dados.saldo], [200, true, 90, 10]);
  const semGasto = ambientePets({PRISMA_GASTOS_ATIVO: "nao"});
  assert.equal((await servidor(semGasto.env, "GET", "/servidor/prisma/precos")).dados.gastos_ativos, false);
});

test("preços de pets: leitura HMAC e site usam o mesmo D1, ocultam inativos e preservam canal BRL", async () => {
  const {env} = ambientePets();
  const token = await vincular(env);
  const semHmac = await handle(new Request(BASE + "/servidor/prisma/precos"), env);
  assert.equal(semHmac.status, 401);
  assert.equal((await site(env, "GET", "/servidor/prisma/precos", undefined, auth(token))).status, 401);
  const ler = async () => {
    const plugin = (await servidor(env, "GET", "/servidor/prisma/precos")).dados;
    const publico = (await site(env, "GET", "/api/prisma/pacotes")).dados;
    const painel = (await site(env, "GET", "/api/prisma", undefined, auth(token))).dados;
    assert.deepEqual(publico.pets, plugin.pets);
    assert.deepEqual(painel.pets, plugin.pets);
    return plugin;
  };
  const catalogoBrl = (await site(env, "GET", "/api/catalogo")).dados;
  env.DB.sqlite.exec("UPDATE prisma_precos SET preco_prisma = 135 WHERE produto_id = 'pet_gato'");
  assert.equal((await ler()).pets[0].preco_prisma, 135, "preço vem do D1, sem fallback fixo de 100");
  assert.deepEqual((await site(env, "GET", "/api/catalogo")).dados, catalogoBrl, "preço em Prisma não altera catálogo em reais");
  env.DB.sqlite.exec("UPDATE produtos SET ativo = 0 WHERE id = 'pet_gato'");
  assert.deepEqual((await ler()).pets, []);
  env.DB.sqlite.exec("UPDATE produtos SET ativo = 1 WHERE id = 'pet_gato'");
  env.DB.sqlite.exec("UPDATE prisma_precos SET ativo = 0 WHERE produto_id = 'pet_gato'");
  assert.deepEqual((await ler()).pets, []);
  env.PRISMA_ATIVO = undefined;
  assert.equal((await servidor(env, "GET", "/servidor/prisma/precos")).status, 404);
});

test("pet com Prisma: compras simultâneas do mesmo pet (refs diferentes) debitam uma vez só", async () => {
  const {env, mp} = ambientePets();
  const token = await vincular(env);
  await creditar(env, mp, token, 5001, "prisma_teste_500", 20);
  const rs = await Promise.all([1, 2, 3, 4].map(i => comprarPet(env, {ref: `compra-par-${i}-abc`})));
  assert.equal(rs.filter(r => r.status === 200).length, 1, JSON.stringify(rs.map(r => r.dados)));
  assert.ok(rs.filter(r => r.status !== 200).every(r => r.dados.erro === "ja_possui"));
  assert.equal(saldo(env), 400);
  assert.equal(linhas(env, "SELECT * FROM direitos").length, 1);
});

test("pet com Prisma: saldo exato e compras simultâneas de pets diferentes não passam do saldo", async () => {
  const {env, mp} = ambientePets();
  const token = await vincular(env);
  await creditar(env, mp, token);                     // 100 Prisma
  env.DB.sqlite.exec("UPDATE prisma_precos SET ativo = 1 WHERE produto_id = 'pet_raposa'");
  const rs = await Promise.all([comprarPet(env, {ref: "compra-a-abcdef"}), comprarPet(env, {produto_id: "pet_raposa", ref: "compra-b-abcdef"})]);
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(saldo(env), 0);
});

test("pet com Prisma: se o pet entrou por outro pedido (corrida com a compra em reais), o Prisma é devolvido", async () => {
  const {env, mp} = ambientePets();
  const token = await vincular(env);
  await creditar(env, mp, token);
  // Simula a corrida: o direito aparece (compra em reais aprovada) entre a verificação e a aplicação do direito.
  const original = env.DB.batch.bind(env.DB);
  env.DB.batch = async (l) => {
    const r = await original(l);
    if (!env.__feito) {
      env.__feito = true;
      env.DB.sqlite.exec(`INSERT INTO pedidos (id, uuid, produto_id, valor_centavos, moeda, modo, estado, criado_em, atualizado_em, expira_em) VALUES ('brl-1', '${UUID_JOGADOR}', 'pet_gato', 100, 'BRL', 'teste', 'pago', 1, 1, 1);
        INSERT INTO direitos (id, uuid, produto_id, estado, pedido_id, versao, motivo, criado_em, atualizado_em) VALUES ('d1', '${UUID_JOGADOR}', 'pet_gato', 'ativo', 'brl-1', 1, 'x', 1, 1)`);
    }
    return r;
  };
  const r = await comprarPet(env, {});
  assert.deepEqual([r.status, r.dados.erro], [409, "ja_possui"]);
  assert.equal(saldo(env), 100, "devolvido");
  assert.deepEqual(lanc(env), ["credito:100", "compra:-100", "estorno:100"]);
  assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id LIKE 'pp-%'").estado, "cancelado");
  assert.equal(linha(env, "SELECT pedido_id FROM direitos").pedido_id, "brl-1", "o direito do outro pedido não foi tocado");
  assert.equal((await comprarPet(env, {})).dados.erro, "ja_possui", "repetir a ref estornada não gasta de novo");
  assert.equal(saldo(env), 100);
});

test("pet com Prisma: se o pet aparece entre a verificação e o débito, o débito nem acontece", async () => {
  const {env, mp} = ambientePets();
  const token = await vincular(env);
  await creditar(env, mp, token);
  const original = env.DB.batch.bind(env.DB);
  env.DB.batch = async (l) => {
    env.DB.sqlite.exec(`INSERT INTO pedidos (id, uuid, produto_id, valor_centavos, moeda, modo, estado, criado_em, atualizado_em, expira_em) VALUES ('brl-1', '${UUID_JOGADOR}', 'pet_gato', 100, 'BRL', 'teste', 'pago', 1, 1, 1);
      INSERT INTO direitos (id, uuid, produto_id, estado, pedido_id, versao, motivo, criado_em, atualizado_em) VALUES ('d1', '${UUID_JOGADOR}', 'pet_gato', 'ativo', 'brl-1', 1, 'x', 1, 1)`);
    return original(l);
  };
  assert.equal((await comprarPet(env, {})).dados.erro, "ja_possui");
  assert.deepEqual(lanc(env), ["credito:100"], "sem débito e sem estorno");
  assert.equal(linhas(env, "SELECT * FROM pedidos WHERE moeda = 'PRISMA'").length, 0);
});

test("pet com Prisma: queda entre o débito e o direito é completada pela repetição e pela tarefa agendada", async () => {
  const {env, mp} = ambientePets();
  const token = await vincular(env);
  await creditar(env, mp, token);
  // Estado deixado por uma queda: débito + pedido gravados, direito não.
  const t = agora() - 600;
  env.DB.sqlite.exec(`INSERT INTO prisma_lancamentos (uuid, tipo, quantidade, ref, item_id, detalhe, criado_em) VALUES ('${UUID_JOGADOR}', 'compra', -100, 'compra:compra-0001-abc', 'pet_gato', 'pp-compra-0001-abc', ${t});
    INSERT INTO pedidos (id, uuid, produto_id, valor_centavos, moeda, modo, estado, criado_em, atualizado_em, expira_em) VALUES ('pp-compra-0001-abc', '${UUID_JOGADOR}', 'pet_gato', 100, 'PRISMA', 'teste', 'pago', ${t}, ${t}, ${t})`);
  assert.equal(linhas(env, "SELECT * FROM direitos").length, 0);
  const cron = await tarefas(env);
  assert.equal(linha(env, "SELECT estado FROM direitos").estado, "ativo");
  assert.equal(saldo(env), 0, "sem novo débito");
  const rep = await comprarPet(env, {});
  assert.deepEqual([rep.status, rep.dados.repetido, rep.dados.saldo], [200, true, 0]);
  assert.equal(linhas(env, "SELECT * FROM entregas").length, 1);
});

test("pet com Prisma: a compra em reais continua funcionando e Prisma não a bloqueia", async () => {
  const {env, mp} = ambientePets();
  const token = await vincular(env);
  const pedidoId = await comprarGato(env, token);
  mp.pagar(7001, pedidoId, {transaction_amount: 1});
  assert.equal((await notificar(env, 7001)).status, 200);
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'pet_gato'").estado, "ativo");
  await creditar(env, mp, token);
  assert.equal((await comprarPet(env, {})).dados.erro, "ja_possui", "quem já tem o pet em reais não paga de novo");
  assert.equal(saldo(env), 100);
});

test("pet com Prisma pelo site: lista preços, compra com a sessão e só com o gate ligado", async () => {
  const {env, mp} = ambientePets();
  const token = await vincular(env);
  await creditar(env, mp, token);
  const pub = await site(env, "GET", "/api/prisma/pacotes");
  assert.deepEqual(pub.dados.pets.map(p => [p.produto_id, p.preco_prisma, p.possui]), [["pet_gato", 100, false]]);
  assert.equal((await site(env, "POST", "/api/prisma/comprar-pet", {produto_id: "pet_gato"})).status, 401, "exige sessão");
  assert.equal((await site(env, "POST", "/api/prisma/comprar-pet", {produto_id: 7}, auth(token))).dados.erro, "produto_invalido");
  const divergente = await site(env, "POST", "/api/prisma/comprar-pet", {produto_id: "pet_gato", preco_esperado: 90}, auth(token));
  assert.deepEqual([divergente.status, divergente.dados.erro, divergente.dados.preco, saldo(env)], [409, "preco_divergente", 100, 100]);
  assert.equal(linhas(env, "SELECT * FROM pedidos WHERE moeda = 'PRISMA'").length, 0);
  assert.equal((await site(env, "POST", "/api/prisma/comprar-pet", {produto_id: "pet_gato", preco_esperado: "100"}, auth(token))).dados.erro, "preco_esperado_invalido");
  const r = await site(env, "POST", "/api/prisma/comprar-pet", {produto_id: "pet_gato", uuid: "00000000-0000-4000-8000-000000000000", valor: 1}, auth(token));
  assert.deepEqual([r.status, r.dados.saldo, r.dados.preco], [200, 0, 100], "o navegador só escolhe o produto: preço e jogador vêm do servidor");
  const painel = await site(env, "GET", "/api/prisma", undefined, auth(token));
  assert.deepEqual(painel.dados.pets.map(p => [p.produto_id, p.possui]), [["pet_gato", true]]);
  assert.equal(linha(env, "SELECT uuid FROM pedidos WHERE moeda = 'PRISMA'").uuid, UUID_JOGADOR);
  const off = ambientePets({PRISMA_GASTOS_ATIVO: "nao"});
  const t2 = await vincular(off.env);
  assert.equal((await site(off.env, "POST", "/api/prisma/comprar-pet", {produto_id: "pet_gato"}, auth(t2))).dados.erro, "gastos_desativados");
});

// ---------- contrato plugin ↔ Worker (X-Astral-Contrato) ----------

import {acoesEntregaveis, CONTRATO_ATUAL} from "../loja.mjs";

test("contrato: o cabeçalho é opcional; legado e contrato 2 usam as mesmas rotas, sem 426", async () => {
  const {env} = ambientePrisma();
  const c = `/servidor/prisma/jogador/${UUID_JOGADOR}`;
  for (const contrato of [null, "2"]) {
    assert.equal((await servidor(env, "GET", c, undefined, {contrato})).status, 200, `Prisma, contrato ${contrato}`);
    assert.equal((await servidor(env, "GET", "/servidor/recompensas/regras", undefined, {contrato})).status, 404, "módulo desligado, não 426");
    assert.equal((await servidor(env, "GET", "/servidor/direitos", undefined, {contrato})).status, 200);
    assert.equal((await servidor(env, "POST", "/servidor/entregas", {}, {contrato})).status, 200);
    assert.equal((await servidor(env, "GET", "/servidor/vinculos", undefined, {contrato})).status, 200);
  }
});

test("contrato 2: o cabeçalho não pode ser removido, acrescentado nem trocado sem invalidar a assinatura", async () => {
  const {env} = ambientePrisma();
  const c = `/servidor/prisma/jogador/${UUID_JOGADOR}`;
  assert.equal((await servidor(env, "GET", c, undefined, {contrato: null, assinadoCom: "2"})).dados.erro, "assinatura_invalida", "removido (downgrade)");
  assert.equal((await servidor(env, "GET", c, undefined, {contrato: "2", assinadoCom: null})).dados.erro, "assinatura_invalida", "acrescentado a uma chamada legada");
  assert.equal((await servidor(env, "GET", c, undefined, {contrato: "9", assinadoCom: "2"})).dados.erro, "assinatura_invalida", "valor trocado");
  for (const ruim of ["abc", "0", "02", "1000", ""]) {
    const r = await servidor(env, "GET", c, undefined, {contrato: ruim});
    assert.deepEqual([r.status, r.dados.erro], [400, "contrato_invalido"], JSON.stringify(ruim));
  }
  assert.equal((await servidor(env, "GET", c, undefined, {contrato: "2"})).status, 200);
  // Contrato futuro (3) de um plugin mais novo passa como ≥ 2.
  assert.equal((await servidor(env, "GET", c, undefined, {contrato: "3"})).status, 200);
});

test("GET /servidor/contrato informa a versão e os interruptores", async () => {
  const a = ambientePrisma({RECOMPENSAS_ATIVO: "sim"});
  assert.deepEqual((await servidor(a.env, "GET", "/servidor/contrato")).dados, {contrato: 2, contrato_atual: 2, prisma: true, prisma_gastos: true, recompensas: true});
  const b = ambiente({});
  assert.deepEqual((await servidor(b.env, "GET", "/servidor/contrato", undefined, {contrato: null})).dados, {contrato: 1, contrato_atual: 2, prisma: false, prisma_gastos: false, recompensas: false});
});

test("entregas: ação fora da tabela de contratos nunca é entregue, e as atuais vão para contrato 1 e 2", async () => {
  assert.deepEqual(acoesEntregaveis(1), ["liberar", "suspender", "revogar"]);
  assert.deepEqual(acoesEntregaveis(2), ["liberar", "suspender", "revogar"]);
  assert.deepEqual(acoesEntregaveis(0), []);
  const {env, mp} = ambientePrisma();
  const token = await vincular(env);
  const pedidoId = await comprarGato(env, token);
  mp.pagar(8001, pedidoId);
  await notificar(env, 8001);
  // Uma ação "do futuro" (sem registro na tabela) fica pendente e intacta para qualquer contrato.
  env.DB.sqlite.exec("PRAGMA ignore_check_constraints = ON");
  env.DB.sqlite.exec(`INSERT INTO entregas (id, direito_id, uuid, produto_id, acao, versao, estado, tentativas, proxima_tentativa_em, criado_em)
    SELECT '${crypto.randomUUID()}', direito_id, uuid, produto_id, 'creditar_futuro', 99, 'pendente', 0, 0, 0 FROM entregas LIMIT 1`);
  env.DB.sqlite.exec("PRAGMA ignore_check_constraints = OFF");
  for (const contrato of [null, "2"]) {
    const r = await servidor(env, "POST", "/servidor/entregas", {}, {contrato});
    assert.equal(r.status, 200);
    assert.ok(r.dados.entregas.every(e => ["liberar", "suspender", "revogar"].includes(e.acao)), `contrato ${contrato}`);
  }
  const futura = linha(env, "SELECT estado, tentativas FROM entregas WHERE acao = 'creditar_futuro'");
  assert.deepEqual(futura, {estado: "pendente", tentativas: 0});
  assert.equal(linhas(env, "SELECT * FROM entregas WHERE acao = 'liberar'").length, 1, "a entrega do gato foi reservada normalmente");
  assert.ok(linha(env, "SELECT tentativas FROM entregas WHERE acao = 'liberar'").tentativas >= 1);
});
