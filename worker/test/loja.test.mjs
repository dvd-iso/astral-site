// Testes da loja: node --test worker/test/loja.test.mjs (Node 22.13+). Sem rede: o Mercado Pago é simulado.
import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {criarD1} from "./d1-sqlite.mjs";
import {handle, tarefas, assinaturaMercadoPagoValida, hmacHex, sha256hex, agora, conferirPagamento} from "../loja.mjs";

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
    if (u.pathname === "/v1/payments/search") {
      const ref = u.searchParams.get("external_reference");
      return Response.json({results: [...pagamentos.values()].filter(p => p.external_reference === ref)});
    }
    return new Response("{}", {status: 404});
  };
  return {
    pagamentos, chamadas, fetch,
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
