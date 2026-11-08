// Testes da loja: node --test worker/test/loja.test.mjs (Node 22.13+). Sem rede: o Mercado Pago é simulado.
import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {criarD1} from "./d1-sqlite.mjs";
import {handle, tarefas, sincronizarPagamento, assinaturaMercadoPagoValida, hmacHex, sha256hex, agora, conferirPagamento} from "../loja.mjs";

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
async function servidor(env, metodo, caminho, corpo, {segredo = SRV, nonce, ts} = {}) {
  const texto = corpo === undefined ? "" : JSON.stringify(corpo);
  const t = String(ts ?? agora());
  const n = nonce ?? `nonce-de-teste-${++contadorNonce}-${Math.random().toString(36).slice(2)}`;
  const assinatura = await hmacHex(segredo, `${metodo}\n${caminho}\n${t}\n${n}\n${await sha256hex(texto)}`);
  const r = await handle(new Request(BASE + caminho, {
    method: metodo, headers: {"X-Astral-Ts": t, "X-Astral-Nonce": n, "X-Astral-Assinatura": assinatura, "Content-Type": "application/json"},
    body: metodo === "GET" ? undefined : texto,
  }), env);
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

// ---------- assinatura ----------

test("assinatura do webhook: aceita a correta e recusa segredo, id, cabeçalho ou horário errados", async () => {
  const ts = "1742505638";
  const v1 = await hmacHex(WH, `id:123;request-id:abc;ts:${ts};`);
  const base = {xSignature: `ts=${ts},v1=${v1}`, xRequestId: "abc", dataId: "123", segredo: WH};
  assert.equal((await assinaturaMercadoPagoValida(base)).ok, true);
  assert.equal((await assinaturaMercadoPagoValida({...base, segredo: "outro"})).ok, false);
  assert.equal((await assinaturaMercadoPagoValida({...base, dataId: "124"})).ok, false);
  assert.equal((await assinaturaMercadoPagoValida({...base, xRequestId: "xyz"})).ok, false);
  assert.equal((await assinaturaMercadoPagoValida({...base, xSignature: null})).ok, false);
  assert.equal((await assinaturaMercadoPagoValida({...base, xSignature: `v1=${v1}`})).ok, false);
  assert.equal((await assinaturaMercadoPagoValida({...base, segredo: ""})).ok, false);
  // Janela de horário opcional (ts em segundos ou ms).
  const agoraMs = Number(ts) * 1000;
  assert.equal((await assinaturaMercadoPagoValida({...base, toleranciaSegundos: 600, agoraMs: agoraMs + 60_000})).ok, true);
  assert.equal((await assinaturaMercadoPagoValida({...base, toleranciaSegundos: 600, agoraMs: agoraMs + 3_600_000})).motivo, "fora_da_janela");
  // Pares ausentes saem do manifest, como no SDK oficial.
  const semId = await hmacHex(WH, `request-id:abc;ts:${ts};`);
  assert.equal((await assinaturaMercadoPagoValida({...base, dataId: null, xSignature: `ts=${ts},v1=${semId}`})).ok, true);
});

// ---------- fluxo completo ----------

test("compra do gato: vínculo pelo código do jogo, checkout, webhook verificado, direito e entrega únicos", async () => {
  const {env, mp} = ambiente();
  const token = await vincular(env);
  const pedidoId = await comprarGato(env, token);

  // A preferência leva o preço do banco, referência do pedido e só Pix/cartão.
  const pref = mp.chamadas.find(c => c.caminho === "/checkout/preferences").corpo;
  assert.equal(pref.items[0].unit_price, 1);
  assert.equal(pref.items[0].currency_id, "BRL");
  assert.equal(pref.external_reference, pedidoId);
  assert.deepEqual(pref.payment_methods.excluded_payment_types.map(t => t.id), ["ticket", "atm"]);
  assert.equal(mp.chamadas.find(c => c.caminho === "/checkout/preferences").headers["X-Idempotency-Key"], `pedido-${pedidoId}`);

  // Antes do pagamento, a página de retorno só mostra estado; nada liberado.
  const antes = await site(env, "GET", `/api/pedidos/${pedidoId}`, undefined, {Authorization: `Bearer ${token}`});
  assert.equal(antes.dados.estado, "aguardando_pagamento");
  assert.equal(antes.dados.direito, null);

  mp.pagar(1001, pedidoId);
  // Notificação com assinatura falsa: 401, nada muda, fica registrada.
  assert.equal((await notificar(env, 1001, {segredo: "falso"})).status, 401);
  assert.equal(linhas(env, "SELECT * FROM direitos").length, 0);
  assert.equal(linha(env, "SELECT assinatura_ok FROM notificacoes").assinatura_ok, 0);

  // Notificação verdadeira, repetida três vezes (o Mercado Pago reenvia): um direito, uma entrega.
  for (let i = 0; i < 3; i++) assert.equal((await notificar(env, 1001)).status, 200);
  const d = linhas(env, "SELECT * FROM direitos");
  assert.equal(d.length, 1);
  assert.equal(d[0].estado, "ativo");
  assert.equal(d[0].versao, 1);
  assert.equal(linhas(env, "SELECT * FROM entregas").length, 1);
  assert.equal(linha(env, "SELECT estado FROM pedidos").estado, "pago");

  // O plugin pega a entrega, ela fica reservada, e a confirmação fecha.
  const e1 = await servidor(env, "POST", "/servidor/entregas");
  assert.equal(e1.dados.entregas.length, 1);
  assert.deepEqual({acao: e1.dados.entregas[0].acao, produto: e1.dados.entregas[0].produto_id, uuid: e1.dados.entregas[0].uuid, versao: e1.dados.entregas[0].versao},
    {acao: "liberar", produto: "pet_gato", uuid: UUID_JOGADOR, versao: 1});
  assert.equal((await servidor(env, "POST", "/servidor/entregas")).dados.entregas.length, 0, "reservada não sai de novo na hora");
  await servidor(env, "POST", "/servidor/entregas/confirmar", {entregas: [{id: e1.dados.entregas[0].id, resultado: "aplicado"}]});
  assert.equal(linha(env, "SELECT estado FROM entregas").estado, "entregue");

  // Mais uma notificação depois de entregue não cria nada novo.
  await notificar(env, 1001);
  assert.equal(linhas(env, "SELECT * FROM entregas").length, 1);

  // Já possui: não deixa comprar de novo.
  const outra = await site(env, "POST", "/api/pedidos", {produto_id: "pet_gato"}, {Authorization: `Bearer ${token}`});
  assert.equal(outra.status, 409);
  assert.equal(outra.dados.erro, "ja_possui");

  const c = await site(env, "GET", "/api/conta", undefined, {Authorization: `Bearer ${token}`});
  assert.equal(c.dados.jogador.nome, "dvdiso");
  assert.equal(c.dados.direitos[0].estado, "ativo");
});

test("valor, moeda, conta recebedora ou modo errados não liberam", async () => {
  for (const [extra, problema] of [
    [{transaction_amount: 0.5}, "valor"],
    [{currency_id: "USD"}, "moeda"],
    [{status: "approved", collector_id: 999}, "conta_recebedora"],
  ]) {
    const {env, mp} = ambiente();
    const pedidoId = await comprarGato(env, await vincular(env));
    mp.pagar(2001, pedidoId, extra);
    assert.equal((await notificar(env, 2001)).status, 200);
    assert.equal(linhas(env, "SELECT * FROM direitos").length, 0, problema);
    assert.equal(linhas(env, "SELECT * FROM entregas").length, 0, problema);
    assert.match(linha(env, "SELECT conferencia FROM pagamentos").conferencia, new RegExp(problema));
  }
  // Pedido real exige live_mode.
  assert.deepEqual(conferirPagamento({collector_id: 1, external_reference: "p", currency_id: "BRL", transaction_amount: 1, live_mode: false},
    {id: "p", moeda: "BRL", valor_centavos: 100, modo: "real"}, {MP_RECEBEDOR_ID: "1"}), ["modo_teste_em_pedido_real"]);
});

test("pagamento de outro pedido ou referência desconhecida não libera", async () => {
  const {env, mp} = ambiente();
  await comprarGato(env, await vincular(env));
  mp.pagar(2101, "00000000-0000-4000-8000-000000000000");
  assert.equal((await notificar(env, 2101)).status, 200);
  assert.equal(linhas(env, "SELECT * FROM direitos").length, 0);
  assert.equal(linha(env, "SELECT conferencia FROM pagamentos").conferencia, "pedido_desconhecido");
});

test("webhook: tipo diferente é ignorado, id fora da query é recusado, falha da API pede reenvio", async () => {
  const {env, mp} = ambiente();
  const pedidoId = await comprarGato(env, await vincular(env));
  assert.deepEqual((await notificar(env, 3001, {tipo: "merchant_order"})).dados, {ok: true, ignorado: "merchant_order"});
  // Assinado para um id, mas a query traz outro: a assinatura não bate.
  assert.equal((await notificar(env, 3001, {adulterarId: 3002})).status, 401);

  mp.pagar(3001, pedidoId);
  mp.falhar = true;
  assert.equal((await notificar(env, 3001)).status, 500, "Mercado Pago fora: responde erro para ser reenviado");
  assert.equal(linhas(env, "SELECT * FROM direitos").length, 0);
  mp.falhar = false;
  assert.equal((await notificar(env, 3001)).status, 200);
  assert.equal(linha(env, "SELECT estado FROM direitos").estado, "ativo");
});

test("jogador offline / servidor fora: a entrega fica na fila e volta com intervalo crescente até ser confirmada", async () => {
  const {env, mp} = ambiente();
  const pedidoId = await comprarGato(env, await vincular(env));
  mp.pagar(4001, pedidoId);
  await notificar(env, 4001);
  const intervalos = [];
  for (let i = 0; i < 4; i++) {
    const r = await servidor(env, "POST", "/servidor/entregas");
    assert.equal(r.dados.entregas.length, 1, `tentativa ${i + 1}`);
    // Servidor caiu antes de confirmar: simula o tempo passando até a próxima tentativa.
    const e = linha(env, "SELECT * FROM entregas");
    intervalos.push(e.proxima_tentativa_em - e.reservada_ate);
    env.DB.sqlite.prepare("UPDATE entregas SET proxima_tentativa_em = ?").run(agora() - 1);
  }
  assert.deepEqual(intervalos, [60, 60, 120, 240]);
  // Erro relatado pelo plugin não fecha a entrega.
  const r = await servidor(env, "POST", "/servidor/entregas");
  await servidor(env, "POST", "/servidor/entregas/confirmar", {entregas: [{id: r.dados.entregas[0].id, resultado: "erro", erro: "falha ao salvar"}]});
  assert.equal(linha(env, "SELECT estado, ultimo_erro FROM entregas").estado, "pendente");
  env.DB.sqlite.prepare("UPDATE entregas SET proxima_tentativa_em = ?").run(agora() - 1);
  const r2 = await servidor(env, "POST", "/servidor/entregas");
  await servidor(env, "POST", "/servidor/entregas/confirmar", {entregas: [{id: r2.dados.entregas[0].id, resultado: "aplicado"}]});
  assert.equal(linha(env, "SELECT estado FROM entregas").estado, "entregue");
  // O retrato dos direitos permite ao plugin recuperar tudo após reinício.
  assert.deepEqual((await servidor(env, "GET", "/servidor/direitos")).dados.direitos, [{uuid: UUID_JOGADOR, produto_id: "pet_gato", estado: "ativo", versao: 1}]);
});

test("reembolso revoga; contestação suspende e, se resolvida a favor, reativa; chargeback revoga", async () => {
  const {env, mp} = ambiente();
  const token = await vincular(env);
  const pedidoId = await comprarGato(env, token);
  const p = mp.pagar(5001, pedidoId);
  await notificar(env, 5001);

  p.status = "in_mediation";
  await notificar(env, 5001);
  assert.deepEqual(linha(env, "SELECT estado, versao FROM direitos"), {estado: "suspenso", versao: 2});
  assert.equal(linha(env, "SELECT estado FROM pedidos").estado, "em_disputa");

  p.status = "approved"; // disputa resolvida a favor do vendedor
  await notificar(env, 5001);
  assert.deepEqual(linha(env, "SELECT estado, versao FROM direitos"), {estado: "ativo", versao: 3});

  // Reembolso parcial: mantém (política) e registra.
  p.transaction_amount_refunded = 0.3;
  await notificar(env, 5001);
  assert.equal(linha(env, "SELECT estado FROM direitos").estado, "ativo");
  assert.ok(linhas(env, "SELECT detalhe FROM eventos_pagamento").some(e => /reembolso_parcial/.test(e.detalhe)));

  p.status = "refunded";
  p.transaction_amount_refunded = 1;
  await notificar(env, 5001);
  await notificar(env, 5001); // repetida
  assert.deepEqual(linha(env, "SELECT estado, versao FROM direitos"), {estado: "revogado", versao: 4});
  assert.equal(linha(env, "SELECT estado FROM pedidos").estado, "reembolsado");

  // Só a entrega da versão mais nova segue pendente; as antigas foram substituídas.
  const fila = linhas(env, "SELECT acao, versao, estado FROM entregas ORDER BY versao");
  assert.deepEqual(fila.map(e => `${e.versao}:${e.acao}:${e.estado}`), ["1:liberar:substituida", "2:suspender:substituida", "3:liberar:substituida", "4:revogar:pendente"]);
  assert.equal(linhas(env, "SELECT * FROM historico_direitos").length, 4);

  // Recompra depois do reembolso: novo pedido, direito reativado (versão 5) e ligado ao pedido novo.
  const novo = await comprarGato(env, token);
  mp.pagar(5002, novo);
  await notificar(env, 5002);
  assert.deepEqual(linha(env, "SELECT estado, versao, pedido_id FROM direitos"), {estado: "ativo", versao: 5, pedido_id: novo});
  // Um evento atrasado do pedido antigo (reembolsado) não derruba a compra nova.
  await notificar(env, 5001);
  assert.equal(linha(env, "SELECT estado FROM direitos").estado, "ativo");
});

test("chargeback revoga e uma tentativa recusada de outro pagamento não mexe num pedido pago", async () => {
  const {env, mp} = ambiente();
  const pedidoId = await comprarGato(env, await vincular(env));
  mp.pagar(6000, pedidoId, {status: "rejected"});
  await notificar(env, 6000);
  assert.equal(linha(env, "SELECT estado FROM pedidos").estado, "recusado");
  const ok = mp.pagar(6001, pedidoId);
  await notificar(env, 6001);
  assert.equal(linha(env, "SELECT estado FROM pedidos").estado, "pago");
  await notificar(env, 6000); // a recusada chega atrasada
  assert.equal(linha(env, "SELECT estado FROM pedidos").estado, "pago");
  assert.equal(linha(env, "SELECT estado FROM direitos").estado, "ativo");
  ok.status = "charged_back";
  await notificar(env, 6001);
  assert.equal(linha(env, "SELECT estado FROM direitos").estado, "revogado");
  assert.equal(linha(env, "SELECT estado FROM pedidos").estado, "contestado");
});

test("conciliação agendada recupera um pagamento cuja notificação se perdeu", async () => {
  const {env, mp} = ambiente();
  const pedidoId = await comprarGato(env, await vincular(env));
  mp.pagar(7001, pedidoId);
  await tarefas(env);
  assert.equal(linha(env, "SELECT estado FROM direitos").estado, "ativo");
  assert.equal(linha(env, "SELECT origem FROM eventos_pagamento WHERE pagamento_id = '7001'").origem, "conciliacao");
});

test("vendas reais ficam bloqueadas até ligar a chave e confirmar o preço", async () => {
  const {env} = ambiente({LOJA_MODO: "real"});
  const token = await vincular(env);
  const r = await site(env, "POST", "/api/pedidos", {produto_id: "pet_gato"}, {Authorization: `Bearer ${token}`});
  assert.deepEqual([r.status, r.dados.erro], [403, "vendas_reais_desativadas"]);
  env.LOJA_VENDAS_REAIS = "sim";
  const r2 = await site(env, "POST", "/api/pedidos", {produto_id: "pet_gato"}, {Authorization: `Bearer ${token}`});
  assert.deepEqual([r2.status, r2.dados.erro], [403, "preco_nao_confirmado"]);
  // Produto desativado e inexistente.
  const r3 = await site(env, "POST", "/api/pedidos", {produto_id: "pet_raposa"}, {Authorization: `Bearer ${token}`});
  assert.equal(r3.dados.erro, "produto_indisponivel");
  const r4 = await site(env, "POST", "/api/pedidos", {produto_id: "pet_dragao"}, {Authorization: `Bearer ${token}`});
  assert.equal(r4.status, 404);
  // O catálogo mostra o preço como de teste.
  const cat = await site(env, "GET", "/api/catalogo");
  const gato = cat.dados.produtos.find(p => p.id === "pet_gato");
  assert.equal(gato.preco_de_teste, true);
  assert.equal(gato.a_venda, false);
  // O cliente não consegue mandar preço: o corpo só aceita o id.
  env.LOJA_MODO = "teste";
  const r5 = await site(env, "POST", "/api/pedidos", {produto_id: "pet_gato", preco_centavos: 1, moeda: "USD"}, {Authorization: `Bearer ${token}`});
  assert.equal(r5.status, 200);
  assert.deepEqual(linha(env, "SELECT valor_centavos, moeda FROM pedidos WHERE id = ?", r5.dados.pedido_id), {valor_centavos: 100, moeda: "BRL"});
});

test("chamadas do servidor: recusa assinatura errada, horário velho e repetição de nonce", async () => {
  const {env} = ambiente();
  assert.equal((await servidor(env, "GET", "/servidor/direitos", undefined, {segredo: "x".repeat(40)})).status, 401);
  assert.equal((await servidor(env, "GET", "/servidor/direitos", undefined, {ts: agora() - 3600})).dados.erro, "horario_invalido");
  assert.equal((await servidor(env, "GET", "/servidor/direitos", undefined, {nonce: "mesmo-nonce-123456"})).status, 200);
  assert.equal((await servidor(env, "GET", "/servidor/direitos", undefined, {nonce: "mesmo-nonce-123456"})).dados.erro, "repeticao");
  const sem = ambiente({SERVIDOR_SEGREDO: ""}).env;
  assert.equal((await servidor(sem, "GET", "/servidor/direitos")).status, 503);
});

test("vinculação: código errado esgota tentativas, nome diferente não recebe código, segredo do navegador é exigido", async () => {
  const {env} = ambiente();
  const inicio = await site(env, "POST", "/api/vinculos", {nome: "Alguem_1"});
  const id = inicio.dados.id;
  // O plugin não pode registrar o código para outro nick.
  assert.equal((await servidor(env, "POST", `/servidor/vinculos/${id}/codigo`, {uuid: UUID_JOGADOR, nome: "outro", codigo: "AAAAAA"})).status, 409);
  assert.equal((await servidor(env, "POST", `/servidor/vinculos/${id}/codigo`, {uuid: UUID_JOGADOR, nome: "alguem_1", codigo: "ABCDEF"})).status, 200);
  assert.equal((await site(env, "GET", `/api/vinculos/${id}`, undefined, {"X-Vinculo-Segredo": "errado"})).status, 404);
  assert.equal((await site(env, "GET", `/api/vinculos/${id}`, undefined, {"X-Vinculo-Segredo": inicio.dados.segredo})).dados.estado, "codigo_exibido");
  for (let i = 4; i >= 0; i--) {
    const r = await site(env, "POST", `/api/vinculos/${id}/confirmar`, {codigo: "ZZZZZZ"}, {"X-Vinculo-Segredo": inicio.dados.segredo});
    assert.equal(r.dados.restantes, i);
  }
  const certo = await site(env, "POST", `/api/vinculos/${id}/confirmar`, {codigo: "ABCDEF"}, {"X-Vinculo-Segredo": inicio.dados.segredo});
  assert.equal(certo.dados.erro, "vinculo_bloqueado");
  // "Não fui eu" no jogo recusa o pedido.
  const outro = await site(env, "POST", "/api/vinculos", {nome: "Terceiro"});
  await servidor(env, "POST", `/servidor/vinculos/${outro.dados.id}/recusar`, {});
  assert.equal((await site(env, "GET", `/api/vinculos/${outro.dados.id}`, undefined, {"X-Vinculo-Segredo": outro.dados.segredo})).dados.estado, "recusado");
  // Nick inválido e limite por nick.
  assert.equal((await site(env, "POST", "/api/vinculos", {nome: "a b"})).status, 400);
  for (let i = 0; i < 2; i++) await site(env, "POST", "/api/vinculos", {nome: "Spam"});
  assert.equal((await site(env, "POST", "/api/vinculos", {nome: "Spam"})).status, 200);
  assert.equal((await site(env, "POST", "/api/vinculos", {nome: "Spam"})).status, 429);
});

test("CORS só para o site; sem sessão não há conta nem pedido", async () => {
  const {env} = ambiente();
  const r = await handle(new Request(BASE + "/api/catalogo", {headers: {Origin: "https://malicioso.example"}}), env);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
  const ok = await site(env, "GET", "/api/catalogo");
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), ORIGEM);
  assert.equal((await site(env, "GET", "/api/conta")).status, 401);
  assert.equal((await site(env, "POST", "/api/pedidos", {produto_id: "pet_gato"}, {Authorization: "Bearer " + "x".repeat(43)})).status, 401);
});

// ---------- apoio ----------

test("apoio: tiers começam desligados, upgrade cobra e credita só a diferença; novo apoio pode se repetir", async () => {
  const {env, mp} = ambiente();
  const token = await vincular(env);
  const auth = {Authorization: `Bearer ${token}`};
  const pedir = id => site(env, "POST", "/api/pedidos", {produto_id: id}, auth);
  assert.equal((await pedir("apoio_20")).dados.erro, "produto_indisponivel", "nasce inativo");
  env.DB.sqlite.exec("UPDATE produtos SET ativo = 1 WHERE tipo = 'apoio'");
  // A migração manteve os pets e as chaves estrangeiras.
  assert.equal(linhas(env, "SELECT id FROM produtos WHERE tipo = 'pet'").length, 7);

  const p20 = await pedir("apoio_20");
  assert.equal(p20.status, 200);
  const pref20 = mp.chamadas.filter(c => c.caminho === "/checkout/preferences").at(-1).corpo;
  assert.equal(pref20.items[0].unit_price, 20);
  assert.match(pref20.items[0].title, /Apoio/);
  mp.pagar(2001, p20.dados.pedido_id, {transaction_amount: 20});
  await notificar(env, 2001);
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'apoio_20'").estado, "ativo");

  assert.equal((await pedir("apoio_20")).status, 200);
  assert.equal(linha(env, "SELECT SUM(quantidade) AS s FROM prisma_lancamentos").s, 200);
  const p50 = await pedir("apoio_50");
  assert.equal(p50.status, 200);
  assert.equal(linha(env, "SELECT valor_centavos FROM pedidos WHERE id = ?", p50.dados.pedido_id).valor_centavos, 3000, "só a diferença");
  assert.equal(mp.chamadas.filter(c => c.caminho === "/checkout/preferences").at(-1).corpo.items[0].unit_price, 30);
  // Pagar o valor cheio num pedido de diferença é divergência: não libera.
  mp.pagar(2002, p50.dados.pedido_id, {transaction_amount: 50});
  await notificar(env, 2002);
  assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", p50.dados.pedido_id).estado, "divergente");
  mp.pagar(2003, p50.dados.pedido_id, {transaction_amount: 30});
  await notificar(env, 2003);
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'apoio_50'").estado, "ativo");
  assert.equal(linha(env, "SELECT SUM(quantidade) AS s FROM prisma_lancamentos").s, 600, "200 + 400, não 200 + 600");

  // Ter o 50 permite novo apoio integral; o upgrade para 100 sai por 50.
  assert.equal((await pedir("apoio_20")).status, 200);
  assert.equal((await pedir("apoio_50")).status, 200);
  const p100 = await pedir("apoio_100");
  assert.equal(linha(env, "SELECT valor_centavos FROM pedidos WHERE id = ?", p100.dados.pedido_id).valor_centavos, 5000);

  // Contestação aberta em um tier: nenhum apoio é vendido até acabar.
  mp.pagar(2003, p50.dados.pedido_id, {transaction_amount: 30, status: "in_mediation"});
  await notificar(env, 2003);
  assert.equal((await pedir("apoio_100")).dados.erro, "apoio_em_disputa");

  // As entregas do apoio vão para o plugin como as dos pets.
  const e = await servidor(env, "POST", "/servidor/entregas");
  assert.deepEqual(e.dados.entregas.map(x => `${x.produto_id}:${x.acao}`).sort(), ["apoio_20:liberar", "apoio_50:suspender"]);
});

test("apoio: repetir sem carência cobra valor cheio, concede quantidade cheia e soma para o tier", async () => {
  const {env, mp} = ambiente();
  const token = await vincular(env);
  const auth = {Authorization: `Bearer ${token}`};
  const pedir = id => site(env, "POST", "/api/pedidos", {produto_id: id}, auth);
  env.DB.sqlite.exec("UPDATE produtos SET ativo = 1 WHERE tipo = 'apoio'");
  const p50 = await pedir("apoio_50");
  mp.pagar(3001, p50.dados.pedido_id, {transaction_amount: 50});
  await notificar(env, 3001);

  assert.equal((await site(env, "GET", "/api/conta", undefined, auth)).dados.apoio_liberado_em, 1, "compatibilidade com página antiga: truthy e no passado, sem carência");
  const de20 = await pedir("apoio_20");
  assert.equal(de20.status, 200);
  assert.equal(linha(env, "SELECT valor_centavos FROM pedidos WHERE id = ?", de20.dados.pedido_id).valor_centavos, 2000, "valor cheio");
  const de50 = await pedir("apoio_50");
  assert.equal(linha(env, "SELECT valor_centavos FROM pedidos WHERE id = ?", de50.dados.pedido_id).valor_centavos, 5000);
  // Subir continua custando só a diferença.
  const de100 = await pedir("apoio_100");
  assert.equal(linha(env, "SELECT valor_centavos FROM pedidos WHERE id = ?", de100.dados.pedido_id).valor_centavos, 5000);

  // Pagar o 50 de novo soma: 50 + 50 = 100 chega à Galáxia, sem crédito extra pelo tier acumulado.
  mp.pagar(3002, de50.dados.pedido_id, {transaction_amount: 50});
  await notificar(env, 3002);
  assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", de50.dados.pedido_id).estado, "pago");
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'apoio_100'").estado, "ativo");
  assert.equal(linha(env, "SELECT SUM(quantidade) AS s FROM prisma_lancamentos").s, 1200);
  assert.equal((await pedir("apoio_20")).status, 200);
});

test("apoio mensal legado: novas assinaturas bloqueadas; meses somam, reembolso e cancelamento preservados", async () => {
  const {env, mp} = ambiente();
  const token = await vincular(env);
  const auth = {Authorization: `Bearer ${token}`};
  env.DB.sqlite.exec("UPDATE produtos SET ativo = 1 WHERE tipo IN ('apoio', 'apoio_mensal')");
  for (const corpo of [{produto_id: "apoio_mensal_20", email: "fulano@example.com"}, {}, {email: "sem-arroba"}]) {
    const bloqueada = await site(env, "POST", "/api/assinaturas", corpo, auth);
    assert.equal(bloqueada.status, 403);
    assert.equal(bloqueada.dados.erro, "novas_assinaturas_encerradas");
  }
  assert.equal((await site(env, "POST", "/api/pedidos", {produto_id: "apoio_mensal_20"}, auth)).dados.erro, "novas_assinaturas_encerradas", "API antiga não contorna a rota bloqueada");
  assert.ok(!(await site(env, "GET", "/api/catalogo")).dados.produtos.some(p => p.tipo === "apoio_mensal"));
  assert.ok(!mp.chamadas.some(c => c.caminho === "/preapproval"));
  // Fixture de assinatura já existente, nunca criada pela API nova.
  const assinaturaId = crypto.randomUUID();
  env.DB.sqlite.prepare(`INSERT INTO assinaturas (id, uuid, produto_id, valor_centavos, modo, estado, preapproval_id, criado_em, atualizado_em)
    VALUES (?, ?, 'apoio_mensal_20', 2000, 'teste', 'pendente', 'pre1', ?, ?)`).run(assinaturaId, UUID_JOGADOR, agora(), agora());
  mp.assinaturas.set("pre1", {id: "pre1", status: "pending", collector_id: Number(RECEBEDOR), external_reference: `assinatura:${assinaturaId}`, auto_recurring: {transaction_amount: 20}});

  // Autorizada no checkout.
  mp.assinaturas.get("pre1").status = "authorized";
  const n1 = await notificar(env, "pre1", {tipo: "subscription_preapproval"});
  assert.equal(n1.status, 200);
  assert.equal(linha(env, "SELECT estado FROM assinaturas").estado, "autorizada");
  assert.equal((await site(env, "POST", "/api/assinaturas", {produto_id: "apoio_mensal_50", email: "fulano@example.com"}, auth)).dados.erro, "novas_assinaturas_encerradas");
  assert.equal(linha(env, "SELECT estado FROM assinaturas").estado, "autorizada", "tentativa nova não cancela a antiga");

  // Mês 1 pela notificação da cobrança: Estrela.
  mp.cobrar(7001, "pre1", 8001);
  await notificar(env, 7001, {tipo: "subscription_authorized_payment"});
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'apoio_20'").estado, "ativo");
  // A notificação do pagamento em si (mesmo pagamento) não duplica.
  await notificar(env, 8001);
  assert.equal(linhas(env, "SELECT * FROM cobrancas").length, 1);

  // Meses 2 e 3 sem notificação nenhuma: a conciliação acha pela busca de cobranças.
  mp.cobrar(7002, "pre1", 8002);
  mp.cobrar(7003, "pre1", 8003);
  env.DB.sqlite.exec("UPDATE assinaturas SET conferido_em = 1");
  await tarefas(env);
  assert.equal(linhas(env, "SELECT * FROM cobrancas").length, 3);
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'apoio_50'").estado, "ativo", "R$ 60 somados: Constelação");
  const c = await site(env, "GET", "/api/conta", undefined, auth);
  assert.equal(c.dados.apoio_total, 6000);
  assert.equal(c.dados.assinatura.estado, "autorizada");
  assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos").length, 0, "mensal legado não recebe Prisma automaticamente");
  // Avulso para a Galáxia cobra só o que falta: 100 − 60.
  const falta = await site(env, "POST", "/api/pedidos", {produto_id: "apoio_100"}, auth);
  assert.equal(linha(env, "SELECT valor_centavos FROM pedidos WHERE id = ?", falta.dados.pedido_id).valor_centavos, 4000);

  // Cobrança de valor diferente do combinado não soma.
  mp.cobrar(7004, "pre1", 8004, {transaction_amount: 5});
  await notificar(env, 7004, {tipo: "subscription_authorized_payment"});
  assert.equal(linha(env, "SELECT p.estado FROM pedidos p JOIN cobrancas c ON c.pedido_id = p.id WHERE c.pagamento_id = '8004'").estado, "divergente");

  // Reembolso do mês 3: soma cai para 40, Constelação sai, Estrela fica.
  mp.pagamentos.get("8003").status = "refunded";
  await notificar(env, 8003);
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'apoio_50'").estado, "revogado");
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'apoio_20'").estado, "ativo");

  // Cancelar pelo site cancela no Mercado Pago. O tier alcançado fica.
  const cancelar = await site(env, "POST", `/api/assinaturas/${assinaturaId}/cancelar`, {}, auth);
  assert.equal(cancelar.status, 200);
  assert.equal(mp.assinaturas.get("pre1").status, "cancelled");
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'apoio_20'").estado, "ativo");
});

test("mural: mostra o nick e o maior tier, do maior para o menor; o jogador pode se esconder", async () => {
  const {env, mp} = ambiente();
  env.DB.sqlite.exec("UPDATE produtos SET ativo = 1 WHERE tipo = 'apoio'");
  const pagar = async (token, produto, pid, valor) => {
    const p = await site(env, "POST", "/api/pedidos", {produto_id: produto}, {Authorization: `Bearer ${token}`});
    mp.pagar(pid, p.dados.pedido_id, {transaction_amount: valor});
    await notificar(env, pid);
  };
  const a = await vincular(env, "dvdiso", UUID_JOGADOR);
  const b = await vincular(env, "Fulano_", "11111111-2222-4333-8444-555555555555");
  await pagar(a, "apoio_20", 9001, 20);
  await pagar(b, "apoio_100", 9002, 100);
  const m = await site(env, "GET", "/api/apoiadores");
  assert.deepEqual(m.dados.apoiadores, [{nome: "Fulano_", tier: "Galáxia"}, {nome: "dvdiso", tier: "Estrela"}]);
  assert.match(m.headers.get("Cache-Control"), /max-age/);
  assert.equal((await site(env, "POST", "/api/mural", {visivel: false}, {Authorization: `Bearer ${b}`})).status, 200);
  assert.deepEqual((await site(env, "GET", "/api/apoiadores")).dados.apoiadores, [{nome: "dvdiso", tier: "Estrela"}]);
  assert.equal((await site(env, "GET", "/api/conta", undefined, {Authorization: `Bearer ${b}`})).dados.mural_visivel, false);
});

// ---------- apoio com Prisma (mesmo saldo do jogo, MP simulado) ----------

const saldoPrisma = env => linha(env, "SELECT COALESCE(SUM(quantidade), 0) AS saldo FROM prisma_lancamentos WHERE uuid = ?", UUID_JOGADOR).saldo;
async function apoioNovo(extra = {}, produto = "apoio_20") {
  const a = ambiente({PRISMA_ATIVO: "sim", ...extra});
  a.env.DB.sqlite.exec("UPDATE produtos SET ativo = 1 WHERE tipo = 'apoio'");
  a.token = await vincular(a.env);
  a.auth = {Authorization: `Bearer ${a.token}`};
  a.pedir = id => site(a.env, "POST", "/api/pedidos", {produto_id: id}, a.auth);
  const r = await a.pedir(produto);
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  a.pedidoId = r.dados.pedido_id;
  return a;
}

test("apoio Prisma: snapshots de catálogo, upgrade e recompra; retorno e preço do cliente não concedem", async () => {
  const {env, mp, pedidoId, pedir, auth} = await apoioNovo();
  assert.equal(saldoPrisma(env), 0);
  assert.deepEqual(linha(env, "SELECT prisma_quantidade, prisma_base_quantidade FROM pedidos WHERE id = ?", pedidoId), {prisma_quantidade: 200, prisma_base_quantidade: 0});
  await site(env, "GET", `/api/pedidos/${pedidoId}`, undefined, auth);
  assert.equal(saldoPrisma(env), 0, "retorno nunca credita");
  mp.pagar(10001, pedidoId, {transaction_amount: 20});
  await notificar(env, 10001);
  const upgrade = await pedir("apoio_50");
  assert.deepEqual(linha(env, "SELECT valor_centavos, prisma_quantidade, prisma_base_quantidade FROM pedidos WHERE id = ?", upgrade.dados.pedido_id),
    {valor_centavos: 3000, prisma_quantidade: 400, prisma_base_quantidade: 200});
  env.DB.sqlite.exec("UPDATE produtos SET prisma_quantidade = 9999 WHERE id = 'apoio_50'");
  mp.pagar(10002, upgrade.dados.pedido_id, {transaction_amount: 30});
  for (let i = 0; i < 3; i++) await notificar(env, 10002);
  assert.equal(saldoPrisma(env), 600, "editar tabela depois do pedido não muda seu crédito");
  env.DB.sqlite.exec("UPDATE produtos SET prisma_quantidade = 600 WHERE id = 'apoio_50'");
  const novo = await site(env, "POST", "/api/pedidos", {produto_id: "apoio_50", prisma_quantidade: 900000, valor_centavos: 1}, auth);
  assert.deepEqual(linha(env, "SELECT valor_centavos, prisma_quantidade FROM pedidos WHERE id = ?", novo.dados.pedido_id), {valor_centavos: 5000, prisma_quantidade: 600});
  mp.pagar(10003, novo.dados.pedido_id, {transaction_amount: 50});
  await notificar(env, 10003);
  assert.equal(saldoPrisma(env), 1200, "repetição concede 600 novamente, não zero nem só diferença");
  const cat = await site(env, "GET", "/api/catalogo");
  assert.deepEqual(cat.dados.produtos.filter(p => p.tipo === "apoio").map(p => p.prisma_quantidade), [200, 600, 1200]);
  assert.ok(cat.dados.produtos.filter(p => p.tipo === "apoio").every(p => !/item especial|personagem/i.test(p.descricao)));
});

test("apoio Prisma: concorrência do mesmo e de dois pagamentos aprova um crédito e preserva dono", async () => {
  const {env, mp, pedidoId} = await apoioNovo();
  const a = mp.pagar(11001, pedidoId, {transaction_amount: 20});
  const b = mp.pagar(11002, pedidoId, {transaction_amount: 20});
  await Promise.all(Array.from({length: 8}, (_, i) => sincronizarPagamento(env, String(i % 2 ? a.id : b.id), "teste")));
  assert.equal(saldoPrisma(env), 200);
  assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos WHERE apoio_pedido_id = ?", pedidoId).length, 1);
  const dono = linha(env, "SELECT pagamento_id FROM pedidos WHERE id = ?", pedidoId).pagamento_id;
  const outro = dono === "11001" ? b : a;
  outro.status = "refunded";
  await notificar(env, outro.id);
  assert.equal(saldoPrisma(env), 200, "outro pagamento não pode estornar o crédito");
  assert.equal(linha(env, "SELECT pagamento_id FROM pedidos WHERE id = ?", pedidoId).pagamento_id, dono);
});

test("apoio Prisma: divergências não creditam nem revertem, inclusive moeda, valor, conta e live_mode", async () => {
  for (const extra of [{transaction_amount: 19}, {currency_id: "USD"}, {collector_id: 999}, {live_mode: false}]) {
    const {env, mp, pedidoId} = await apoioNovo();
    env.DB.sqlite.prepare("UPDATE pedidos SET modo = 'real' WHERE id = ?").run(pedidoId);
    mp.pagar(12001, pedidoId, {transaction_amount: 20, live_mode: true, ...extra});
    await notificar(env, 12001);
    assert.equal(saldoPrisma(env), 0);
    mp.pagar(12001, pedidoId, {transaction_amount: 20, live_mode: true});
    await notificar(env, 12001);
    assert.equal(saldoPrisma(env), 200);
    mp.pagar(12001, pedidoId, {status: "refunded", transaction_amount: 20, live_mode: true, ...extra});
    await notificar(env, 12001);
    assert.equal(saldoPrisma(env), 200, "reversão também exige conferência integral");
  }
});

test("apoio Prisma: falha no meio do batch reverte tudo; crash depois do batch, retry e cron não duplicam", async () => {
  const {env, mp, pedidoId} = await apoioNovo();
  mp.pagar(13001, pedidoId, {transaction_amount: 20});
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = lista => batch([...lista.slice(0, 3), env.DB.prepare("INSERT INTO tabela_inexistente VALUES (1)")]);
  assert.equal((await notificar(env, 13001)).status, 500);
  assert.equal(saldoPrisma(env), 0);
  assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", pedidoId).estado, "aguardando_pagamento");
  // Simula término do processo/erro de resposta DEPOIS do commit do saldo, antes do recálculo dos cargos.
  env.DB.batch = async lista => { await batch(lista); throw new Error("crash_simulado_apos_commit"); };
  assert.equal((await notificar(env, 13001)).status, 500);
  assert.equal(saldoPrisma(env), 200);
  env.DB.batch = batch;
  env.DB.sqlite.exec("UPDATE pedidos SET conferido_em = 0");
  await tarefas(env);
  assert.equal(linha(env, "SELECT estado FROM direitos WHERE produto_id = 'apoio_20'").estado, "ativo");
  await notificar(env, 13001);
  assert.equal(saldoPrisma(env), 200);
});

test("apoio Prisma: refund após gasto abre caso, não cobra crédito futuro nem remove cosmético; revisão via API existente", async () => {
  const {env, mp, pedidoId, pedir} = await apoioNovo({PRISMA_GASTOS_ATIVO: "sim"});
  const p = mp.pagar(14001, pedidoId, {transaction_amount: 20});
  await notificar(env, 14001);
  assert.equal((await servidor(env, "POST", "/servidor/prisma/gastar", {uuid: UUID_JOGADOR, quantidade: 150, ref: "apoio-gasto-0001", item: "asas"})).status, 200);
  p.status = "refunded";
  await Promise.all(Array.from({length: 4}, () => sincronizarPagamento(env, "14001", "teste")));
  assert.equal(saldoPrisma(env), 0);
  assert.deepEqual(linha(env, "SELECT quantidade_revertida, quantidade_pendente FROM apoio_prisma_casos"), {quantidade_revertida: 50, quantidade_pendente: 150});
  const novo = await pedir("apoio_20");
  mp.pagar(14002, novo.dados.pedido_id, {transaction_amount: 20});
  await notificar(env, 14002);
  await notificar(env, 14001);
  assert.equal(saldoPrisma(env), 200, "nenhuma cobrança automática de pendência antiga");
  const casos = await servidor(env, "GET", "/servidor/prisma/casos");
  assert.equal(casos.dados.casos_apoio.length, 1);
  const caso = casos.dados.casos_apoio[0];
  assert.equal(caso.itens[0].item_id, "asas", "cosmético comprado permanece intacto");
  assert.equal((await servidor(env, "POST", "/servidor/prisma/casos/atualizar", {origem: "apoio", id: caso.id, estado: "resolvido", resolucao: "manter cosmético"})).status, 200);
  assert.equal(saldoPrisma(env), 200, "gestão do caso não mexe no saldo");
});

test("apoio Prisma: disputa, chargeback e vitória da loja; parcial mantém crédito e total aprovado com refund integral reverte", async () => {
  const {env, mp, pedidoId} = await apoioNovo({PRISMA_GASTOS_ATIVO: "sim"});
  const p = mp.pagar(15001, pedidoId, {transaction_amount: 20});
  await notificar(env, 15001);
  p.transaction_amount_refunded = 5;
  await notificar(env, 15001);
  assert.equal(saldoPrisma(env), 200);
  assert.equal(linha(env, "SELECT tipo FROM apoio_prisma_casos").tipo, "reembolso_parcial");
  await servidor(env, "POST", "/servidor/prisma/gastar", {uuid: UUID_JOGADOR, quantidade: 150, ref: "apoio-gasto-0002", item: "asas"});
  p.status = "in_mediation";
  await notificar(env, 15001);
  assert.equal(saldoPrisma(env), 0);
  assert.equal(linha(env, "SELECT quantidade_pendente FROM apoio_prisma_casos").quantidade_pendente, 150);
  p.status = "charged_back";
  await notificar(env, 15001);
  assert.equal(saldoPrisma(env), 0);
  assert.equal(linha(env, "SELECT tipo FROM apoio_prisma_casos").tipo, "chargeback");
  p.status = "approved";
  p.transaction_amount_refunded = 0;
  await notificar(env, 15001);
  assert.equal(saldoPrisma(env), 50, "libera só a retenção, não recria o que foi gasto");
  assert.equal(linha(env, "SELECT estado FROM apoio_prisma_casos").estado, "resolvido");
  p.transaction_amount_refunded = 20;
  await notificar(env, 15001);
  assert.equal(saldoPrisma(env), 0);
  assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", pedidoId).estado, "reembolsado");
});

test("apoio Prisma: disputa integral é reentrante e leituras MP antigas não revertem o estado mais novo", async () => {
  const {env, mp, pedidoId} = await apoioNovo();
  const p = mp.pagar(16001, pedidoId, {transaction_amount: 20, date_last_updated: "2026-11-07T10:00:00Z"});
  await notificar(env, 16001);
  const antigo = {...p};
  Object.assign(p, {status: "in_mediation", date_last_updated: "2026-11-07T11:00:00Z"});
  await notificar(env, 16001);
  assert.equal(saldoPrisma(env), 0);
  await sincronizarPagamento(env, "16001", "teste_atrasado", antigo);
  assert.equal(saldoPrisma(env), 0);
  assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", pedidoId).estado, "em_disputa");
  Object.assign(p, {status: "approved", date_last_updated: "2026-11-07T12:00:00Z"});
  await notificar(env, 16001);
  await notificar(env, 16001);
  assert.equal(saldoPrisma(env), 200);
  Object.assign(p, {status: "cancelled", date_last_updated: "2026-11-07T13:00:00Z"});
  await notificar(env, 16001);
  assert.equal(saldoPrisma(env), 0);
});

test("apoio Prisma: refund e gasto concorrentes nunca deixam saldo negativo", async () => {
  const {env, mp, pedidoId} = await apoioNovo({PRISMA_GASTOS_ATIVO: "sim"});
  const p = mp.pagar(17001, pedidoId, {transaction_amount: 20});
  await notificar(env, 17001);
  p.status = "refunded";
  await Promise.all([
    sincronizarPagamento(env, "17001", "teste"),
    servidor(env, "POST", "/servidor/prisma/gastar", {uuid: UUID_JOGADOR, quantidade: 200, ref: "apoio-gasto-0003", item: "asas"}),
  ]);
  assert.equal(saldoPrisma(env), 0);
  assert.ok(linha(env, "SELECT quantidade_pendente FROM apoio_prisma_casos").quantidade_pendente >= 0);
});

test("apoio Prisma: tentativa recusada mais nova não impede outro pagamento válido mais antigo", async () => {
  const {env, mp, pedidoId} = await apoioNovo();
  mp.pagar(17501, pedidoId, {status: "rejected", transaction_amount: 20, date_last_updated: "2026-11-07T11:00:00Z"});
  await notificar(env, 17501);
  mp.pagar(17502, pedidoId, {transaction_amount: 20, date_last_updated: "2026-11-07T10:00:00Z"});
  await notificar(env, 17502);
  assert.equal(saldoPrisma(env), 200);
  await notificar(env, 17501);
  assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", pedidoId).estado, "pago");
});

test("apoio Prisma: refund recebido antes do aprovado não cria crédito nem caso fictício", async () => {
  const {env, mp, pedidoId} = await apoioNovo();
  mp.pagar(17601, pedidoId, {status: "refunded", transaction_amount: 20, date_last_updated: "2026-11-07T11:00:00Z"});
  await notificar(env, 17601);
  assert.equal(saldoPrisma(env), 0);
  assert.equal(linhas(env, "SELECT * FROM apoio_prisma_casos").length, 0);
  await sincronizarPagamento(env, "17601", "atrasado", {...mp.pagamentos.get("17601"), status: "approved", date_last_updated: "2026-11-07T10:00:00Z"});
  assert.equal(saldoPrisma(env), 0);
  assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", pedidoId).estado, "reembolsado");
});

test("migração 0007: não há crédito retroativo, nem reutilização de checkout legado; assinaturas/direitos preservados", async () => {
  const db = criarD1(PASTA, "0006_iris_conquistas.sql");
  db.sqlite.prepare("INSERT INTO jogadores (uuid, nome, criado_em, atualizado_em) VALUES (?, 'dvdiso', 1, 1)").run(UUID_JOGADOR);
  const pago = crypto.randomUUID(), aberto = crypto.randomUUID();
  for (const [id, estado] of [[pago, "pago"], [aberto, "aguardando_pagamento"]]) db.sqlite.prepare(
    `INSERT INTO pedidos (id, uuid, produto_id, valor_centavos, moeda, modo, estado, checkout_url, criado_em, atualizado_em, expira_em)
     VALUES (?, ?, 'apoio_20', 2000, 'BRL', 'teste', ?, 'https://www.mercadopago.com.br/checkout/legado', ?, ?, ?)`)
    .run(id, UUID_JOGADOR, estado, agora(), agora(), agora() + 86400);
  const assinaturaId = crypto.randomUUID();
  db.sqlite.prepare(`INSERT INTO assinaturas (id, uuid, produto_id, valor_centavos, modo, estado, criado_em, atualizado_em)
    VALUES (?, ?, 'apoio_mensal_20', 2000, 'teste', 'autorizada', 1, 1)`).run(assinaturaId, UUID_JOGADOR);
  db.sqlite.prepare(`INSERT INTO direitos (id, uuid, produto_id, estado, pedido_id, versao, motivo, criado_em, atualizado_em)
    VALUES (?, ?, 'apoio_20', 'ativo', ?, 1, 'legado', 1, 1)`).run(crypto.randomUUID(), UUID_JOGADOR, pago);
  db.sqlite.exec(readFileSync(join(PASTA, "0007_apoio_prisma.sql"), "utf8"));
  const {env, mp} = ambiente({DB: db});
  assert.equal(saldoPrisma(env), 0);
  assert.equal(linha(env, "SELECT estado FROM assinaturas").estado, "autorizada");
  assert.equal(linha(env, "SELECT estado FROM direitos").estado, "ativo");
  for (const [id, pid] of [[pago, 18001], [aberto, 18002]]) {
    mp.pagar(pid, id, {transaction_amount: 20});
    await notificar(env, pid);
  }
  assert.equal(saldoPrisma(env), 0, "pedidos antigos pagos antes ou depois não recebem Prisma");
  env.DB.sqlite.exec("UPDATE produtos SET ativo = 1 WHERE tipo = 'apoio'");
  const token = await vincular(env);
  const novo = await site(env, "POST", "/api/pedidos", {produto_id: "apoio_20"}, {Authorization: `Bearer ${token}`});
  assert.notEqual(novo.dados.pedido_id, aberto);
  assert.equal(linha(env, "SELECT prisma_quantidade FROM pedidos WHERE id = ?", novo.dados.pedido_id).prisma_quantidade, 200);
  assert.equal(linhas(env, "PRAGMA foreign_key_check").length, 0);
});

test("apoio Prisma: a oferta não abre pacotes standalone nem gastos de pets; crédito não depende do gate de venda", async () => {
  const {env, mp, pedidoId, auth} = await apoioNovo({PRISMA_ATIVO: undefined});
  mp.pagar(19001, pedidoId, {transaction_amount: 20});
  await notificar(env, 19001);
  assert.equal(saldoPrisma(env), 200);
  env.PRISMA_ATIVO = "sim";
  assert.deepEqual((await site(env, "GET", "/api/prisma/pacotes")).dados.pacotes, []);
  assert.equal((await site(env, "POST", "/api/prisma/pedidos", {pacote_id: "prisma_100"}, auth)).dados.erro, "produto_indisponivel");
  assert.equal((await site(env, "POST", "/api/prisma/comprar-pet", {produto_id: "pet_gato"}, auth)).dados.erro, "gastos_desativados");
  assert.equal(linhas(env, "SELECT produto_id FROM prisma_precos WHERE ativo = 1").length, 0);
});

const batchDeRecalculo = lista => lista.some(s => /WITH soma AS/.test(s.sql));
const batchFinanceiro = lista => /UPDATE pedidos SET estado/.test(lista[0].sql) && /apoio_mp_atualizado_em/.test(lista[0].sql);
const pendenciaApoio = env => linha(env, "SELECT versao, aplicada_versao FROM apoio_recalculos WHERE uuid = ?", UUID_JOGADOR);

test("regressão: aprovação atrasada após refund não reativa direito com soma velha", {timeout: 3000}, async () => {
  const {env, mp, pedidoId} = await apoioNovo();
  const p = mp.pagar(20001, pedidoId, {transaction_amount: 20, date_last_updated: "2026-11-07T10:00:00Z"});
  await notificar(env, 20001);
  const batch = env.DB.batch.bind(env.DB);
  let parar, continuar;
  const parou = new Promise(resolve => { parar = resolve; });
  const espera = new Promise(resolve => { continuar = resolve; });
  let interceptou = false;
  env.DB.batch = async lista => {
    if (batchDeRecalculo(lista) && !interceptou) {
      interceptou = true;
      parar();
      await espera; // aprovação já commitou, mas ainda não fez a transação dos direitos
    }
    return batch(lista);
  };
  const aprovacao = sincronizarPagamento(env, "20001", "aprovacao_atrasada");
  try {
    await parou;
    assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", pedidoId).estado, "pago");
    assert.equal(saldoPrisma(env), 200);
    Object.assign(p, {status: "refunded", date_last_updated: "2026-11-07T11:00:00Z"});
    await sincronizarPagamento(env, "20001", "refund_no_meio");
    assert.equal(saldoPrisma(env), 0);
  } finally { continuar(); }
  await aprovacao;
  assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", pedidoId).estado, "reembolsado");
  assert.equal(linhas(env, "SELECT * FROM direitos WHERE estado = 'ativo'").length, 0);
  assert.equal(linha(env, "SELECT estado FROM direitos").estado, "revogado");
  assert.equal(linhas(env, "SELECT * FROM entregas WHERE estado = 'pendente' AND acao = 'liberar'").length, 0);
  assert.equal(pendenciaApoio(env).versao, pendenciaApoio(env).aplicada_versao);
});

test("regressão: crash antes/depois do commit financeiro conserva outbox; cron recupera terminais antigos sem MP", async () => {
  for (const snapshot of [600, 0]) for (const status of ["refunded", "charged_back", "cancelled"]) {
    const {env, mp, pedidoId} = await apoioNovo({}, "apoio_50");
    env.DB.sqlite.prepare("UPDATE pedidos SET prisma_quantidade = ? WHERE id = ?").run(snapshot, pedidoId);
    const p = mp.pagar(20101, pedidoId, {transaction_amount: 50});
    await notificar(env, 20101);
    assert.equal(linhas(env, "SELECT * FROM direitos WHERE estado = 'ativo'").length, 2);
    const antes = pendenciaApoio(env);
    const batch = env.DB.batch.bind(env.DB);
    p.status = status;
    // Falha dentro da transação financeira: estado, reversão e versão da outbox fazem rollback juntos.
    env.DB.batch = lista => batchFinanceiro(lista)
      ? batch([...lista, env.DB.prepare("INSERT INTO tabela_inexistente VALUES (1)")]) : batch(lista);
    assert.equal((await notificar(env, 20101)).status, 500);
    assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", pedidoId).estado, "pago");
    assert.equal(saldoPrisma(env), snapshot);
    assert.deepEqual(pendenciaApoio(env), antes);
    // Reinício depois do commit financeiro, antes do recálculo: estado terminal e saldo já persistiram.
    env.DB.batch = async lista => {
      const r = await batch(lista);
      if (batchFinanceiro(lista)) throw new Error("crash_apos_financeiro_antes_direitos");
      return r;
    };
    assert.equal((await notificar(env, 20101)).status, 500);
    const terminal = {refunded: "reembolsado", charged_back: "contestado", cancelled: "cancelado"}[status];
    assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", pedidoId).estado, terminal);
    assert.equal(saldoPrisma(env), 0);
    assert.equal(linhas(env, "SELECT * FROM direitos WHERE estado = 'ativo'").length, 2, "estado transitório capturado pela outbox");
    assert.ok(pendenciaApoio(env).versao > pendenciaApoio(env).aplicada_versao);
    // Nada de depender de reconferência de pagos, idade do pedido, mutação do catálogo ou API financeira.
    env.DB.batch = batch;
    env.DB.sqlite.exec(`UPDATE pedidos SET criado_em = criado_em - ${400 * 86400}; UPDATE produtos SET prisma_quantidade = 9999 WHERE tipo = 'apoio'`);
    delete env.MP_ACCESS_TOKEN;
    const chamadas = mp.chamadas.length;
    const r = await tarefas(env);
    assert.equal(r.apoios_recalculados, 1);
    assert.equal(mp.chamadas.length, chamadas);
    assert.equal(linhas(env, "SELECT * FROM direitos WHERE estado = 'ativo'").length, 0);
    assert.equal(linhas(env, "SELECT * FROM entregas WHERE estado = 'pendente' AND acao = 'revogar'").length, 2);
    assert.equal(pendenciaApoio(env).versao, pendenciaApoio(env).aplicada_versao);
    assert.equal(linha(env, "SELECT prisma_quantidade FROM pedidos WHERE id = ?", pedidoId).prisma_quantidade, snapshot);
    assert.equal(saldoPrisma(env), 0);
  }
});

test("regressão: crash no meio do recálculo não confirma a versão; cron conclui histórico e entregas", async () => {
  const {env, mp, pedidoId} = await apoioNovo();
  const p = mp.pagar(20201, pedidoId, {transaction_amount: 20});
  await notificar(env, 20201);
  p.status = "refunded";
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = lista => batchDeRecalculo(lista)
    ? batch([...lista.slice(0, 2), env.DB.prepare("INSERT INTO tabela_inexistente VALUES (1)")]) : batch(lista);
  assert.equal((await notificar(env, 20201)).status, 500);
  assert.equal(saldoPrisma(env), 0);
  assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", pedidoId).estado, "reembolsado");
  assert.equal(linha(env, "SELECT estado FROM direitos").estado, "ativo", "UPDATE do direito também sofreu rollback");
  assert.ok(pendenciaApoio(env).versao > pendenciaApoio(env).aplicada_versao);
  env.DB.batch = batch;
  delete env.MP_ACCESS_TOKEN;
  await tarefas(env);
  assert.equal(linha(env, "SELECT estado, versao FROM direitos").estado, "revogado");
  assert.equal(linhas(env, "SELECT * FROM historico_direitos").length, 2);
  assert.equal(linha(env, "SELECT acao FROM entregas WHERE estado = 'pendente'").acao, "revogar");
  assert.equal(pendenciaApoio(env).versao, pendenciaApoio(env).aplicada_versao);
  await tarefas(env);
  assert.equal(linhas(env, "SELECT * FROM historico_direitos").length, 2, "cron repetido não duplica versões");
});

test("regressão: refund/disputa sem crédito não toma posse do checkout; outro approved válido é processado", async () => {
  for (const status of ["refunded", "in_mediation", "charged_back"]) {
    const {env, mp, pedidoId} = await apoioNovo();
    mp.pagar(20301, pedidoId, {status, transaction_amount: 20, date_last_updated: "2026-11-07T11:00:00Z"});
    await notificar(env, 20301);
    assert.equal(linha(env, "SELECT pagamento_id FROM pedidos WHERE id = ?", pedidoId).pagamento_id, null);
    assert.equal(saldoPrisma(env), 0);
    mp.pagar(20302, pedidoId, {transaction_amount: 20, date_last_updated: "2026-11-07T10:00:00Z"});
    await notificar(env, 20302);
    assert.equal(linha(env, "SELECT pagamento_id FROM pedidos WHERE id = ?", pedidoId).pagamento_id, "20302");
    assert.equal(saldoPrisma(env), 200);
    await notificar(env, 20301);
    assert.equal(linha(env, "SELECT estado FROM pedidos WHERE id = ?", pedidoId).estado, "pago");
    assert.equal(linha(env, "SELECT estado FROM direitos").estado, "ativo");
    assert.equal(saldoPrisma(env), 200);
    assert.equal(linhas(env, "SELECT * FROM prisma_lancamentos WHERE apoio_pedido_id = ?", pedidoId).length, 1);
  }
});
