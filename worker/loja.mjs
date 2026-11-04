// Loja do Astral (pets cosméticos): vinculação da conta do jogo, pedidos, Checkout Pro do Mercado Pago,
// webhook verificado, direitos de acesso e a fila de entregas que o plugin AstralLoja consulta por HTTPS assinado.
//
// Regras que este arquivo garante:
// - Preço, moeda e produto vêm só da tabela produtos. O navegador manda apenas o id do produto.
// - Nada é liberado pela página de retorno: só pelo pagamento lido na API do Mercado Pago (webhook ou conciliação),
//   conferindo status, conta recebedora, referência do pedido, moeda e valor.
// - Direitos e entregas são idempotentes: UNIQUE (uuid, produto) e UNIQUE (direito, versão).
// - O servidor do jogo recebe só ações fechadas (liberar, suspender, revogar) de produtos cadastrados.
// - Vendas reais exigem LOJA_MODO=real, LOJA_VENDAS_REAIS=sim e preco_confirmado=1 no produto.

const enc = new TextEncoder();
const MP_API = "https://api.mercadopago.com";
const LIMITE_CORPO = 16 * 1024;
const VINCULO_SEGUNDOS = 10 * 60;
const SESSAO_SEGUNDOS = 30 * 24 * 3600;
const PEDIDO_SEGUNDOS = 24 * 3600;
const TENTATIVAS_CODIGO = 5;
const APOIO_DE_NOVO_SEGUNDOS = 30 * 86400; // depois de um mês do último apoio pago, pode apoiar de novo
const ALFABETO_CODIGO = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOME_RE = /^[A-Za-z0-9_]{3,16}$/;

export const agora = () => Math.floor(Date.now() / 1000);

// ---------- utilidades de criptografia ----------

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

export async function sha256hex(texto) {
  return hex(await crypto.subtle.digest("SHA-256", typeof texto === "string" ? enc.encode(texto) : texto));
}

export async function hmacHex(segredo, mensagem) {
  const chave = await crypto.subtle.importKey("raw", enc.encode(segredo), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", chave, enc.encode(mensagem)));
}

// Comparação em tempo constante para strings do mesmo alfabeto (hex).
export function iguais(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function tokenAleatorio(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const centavos = valor => {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

// ---------- assinatura do Mercado Pago ----------

/**
 * Valida o cabeçalho x-signature como o SDK oficial (mercadopago/sdk-nodejs, utils/webhook):
 * manifest "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" (pares ausentes são omitidos), HMAC-SHA256 em hex
 * com a assinatura secreta do painel. data.id vem da query string; a documentação pede minúsculas se for alfanumérico.
 * toleranciaSegundos = 0 desliga a checagem de horário (o pagamento é sempre relido na API, então repetir uma
 * notificação válida não libera nada novo).
 */
export async function assinaturaMercadoPagoValida({xSignature, xRequestId, dataId, segredo, toleranciaSegundos = 0, agoraMs = Date.now()}) {
  if (!segredo || !xSignature) return {ok: false, motivo: "sem_assinatura"};
  let ts, v1;
  for (const parte of String(xSignature).split(",")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    const k = parte.slice(0, i).trim().toLowerCase(), v = parte.slice(i + 1).trim();
    if (k === "ts") ts = v;
    else if (k === "v1") v1 = v.toLowerCase();
  }
  if (!ts || !/^\d+$/.test(ts) || !v1) return {ok: false, motivo: "assinatura_malformada"};
  const id = dataId ? (/^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId) : null;
  const partes = [];
  if (id) partes.push(`id:${id}`);
  if (xRequestId) partes.push(`request-id:${xRequestId}`);
  partes.push(`ts:${ts}`);
  const esperado = await hmacHex(segredo, partes.join(";") + ";");
  if (!iguais(esperado, v1)) return {ok: false, motivo: "assinatura_divergente"};
  if (toleranciaSegundos > 0) {
    const n = Number(ts);
    const tsMs = n > 1e11 ? n : n * 1000; // a documentação fala em ms e o SDK em segundos: aceita os dois
    if (Math.abs(agoraMs - tsMs) / 1000 > toleranciaSegundos) return {ok: false, motivo: "fora_da_janela"};
  }
  return {ok: true};
}

// ---------- respostas e CORS ----------

function origensPermitidas(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
}

function cabecalhosCors(req, env) {
  const origem = req.headers.get("Origin");
  if (!origem || !origensPermitidas(env).includes(origem)) return {};
  return {
    "Access-Control-Allow-Origin": origem,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Vinculo-Segredo",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function json(dados, status = 200, extra = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra},
  });
}

class Erro extends Error {
  constructor(status, codigo, extra = {}) { super(codigo); this.status = status; this.codigo = codigo; this.extra = extra; }
}

async function lerCorpo(req) {
  const texto = await req.text();
  if (texto.length > LIMITE_CORPO) throw new Erro(413, "corpo_grande");
  return texto;
}

function lerJson(texto) {
  if (!texto) return {};
  try {
    const v = JSON.parse(texto);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch { /* cai no erro abaixo */ }
  throw new Erro(400, "json_invalido");
}

// ---------- configuração ----------

export function modoDaLoja(env) {
  return env.LOJA_MODO === "real" ? "real" : "teste";
}

/** Retorna null quando o produto pode ser vendido agora, ou o motivo do bloqueio. */
export function bloqueioDeVenda(env, produto) {
  if (!produto || produto.ativo !== 1) return "produto_indisponivel";
  if (env.LOJA_PAUSADA === "sim") return "loja_pausada";
  if (!env.MP_ACCESS_TOKEN || !env.MP_RECEBEDOR_ID || !env.MP_WEBHOOK_SECRET) return "loja_nao_configurada";
  if (modoDaLoja(env) === "real") {
    if (env.LOJA_VENDAS_REAIS !== "sim") return "vendas_reais_desativadas";
    if (produto.preco_confirmado !== 1) return "preco_nao_confirmado";
  }
  return null;
}

// ---------- banco ----------

async function limitar(env, chave, maximo, janela) {
  const t = agora();
  const r = await env.DB.prepare(
    `INSERT INTO limites (chave, contagem, janela_inicio) VALUES (?1, 1, ?2)
     ON CONFLICT (chave) DO UPDATE SET
       contagem = CASE WHEN limites.janela_inicio <= ?2 - ?3 THEN 1 ELSE limites.contagem + 1 END,
       janela_inicio = CASE WHEN limites.janela_inicio <= ?2 - ?3 THEN ?2 ELSE limites.janela_inicio END
     RETURNING contagem`).bind(chave, t, janela).first();
  if (r.contagem > maximo) throw new Erro(429, "muitas_tentativas");
}

async function ipHash(req, env) {
  return sha256hex(`${env.IP_SAL || "astral"}|${req.headers.get("CF-Connecting-IP") || "?"}`);
}

async function sessao(req, env) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(req.headers.get("Authorization") || "");
  if (!m) throw new Erro(401, "sem_sessao");
  const s = await env.DB.prepare(
    `SELECT s.uuid, j.nome FROM sessoes s JOIN jogadores j ON j.uuid = s.uuid
     WHERE s.token_hash = ? AND s.revogada = 0 AND s.expira_em > ?`).bind(await sha256hex(m[1]), agora()).first();
  if (!s) throw new Erro(401, "sessao_invalida");
  return {...s, tokenHash: await sha256hex(m[1])};
}

/**
 * Muda o estado do direito (uuid, produto) e enfileira a entrega da nova versão, tudo numa transação.
 * - ativo: cria, ou reativa se estava revogado, ou se estava suspenso pelo MESMO pedido.
 * - suspenso/revogado: só se o direito veio deste pedido (um reembolso antigo não derruba uma compra nova).
 * Repetir a chamada não muda nada: a versão só cresce quando o estado muda, e a entrega é UNIQUE por versão.
 */
export async function aplicarDireito(env, {uuid, produtoId, pedidoId, estado, motivo}) {
  const t = agora();
  const antes = await env.DB.prepare("SELECT versao, estado FROM direitos WHERE uuid = ? AND produto_id = ?").bind(uuid, produtoId).first();
  const mudar = estado === "ativo"
    ? env.DB.prepare(
      `INSERT INTO direitos (id, uuid, produto_id, estado, pedido_id, versao, motivo, criado_em, atualizado_em)
       VALUES (?1, ?2, ?3, 'ativo', ?4, 1, ?5, ?6, ?6)
       ON CONFLICT (uuid, produto_id) DO UPDATE SET estado = 'ativo', pedido_id = excluded.pedido_id,
         versao = direitos.versao + 1, motivo = excluded.motivo, atualizado_em = excluded.atualizado_em
       WHERE direitos.estado = 'revogado' OR (direitos.estado = 'suspenso' AND direitos.pedido_id = excluded.pedido_id)`)
      .bind(crypto.randomUUID(), uuid, produtoId, pedidoId, motivo, t)
    : env.DB.prepare(
      `UPDATE direitos SET estado = ?1, versao = versao + 1, motivo = ?2, atualizado_em = ?3
       WHERE uuid = ?4 AND produto_id = ?5 AND pedido_id = ?6 AND estado <> ?1`)
      .bind(estado, motivo, t, uuid, produtoId, pedidoId);
  await env.DB.batch([
    mudar,
    env.DB.prepare(
      `INSERT OR IGNORE INTO historico_direitos (direito_id, versao, estado, pedido_id, motivo, criado_em)
       SELECT id, versao, estado, pedido_id, motivo, ?1 FROM direitos WHERE uuid = ?2 AND produto_id = ?3`).bind(t, uuid, produtoId),
    env.DB.prepare(
      `UPDATE entregas SET estado = 'substituida'
       WHERE estado = 'pendente' AND direito_id IN (SELECT id FROM direitos WHERE uuid = ?1 AND produto_id = ?2)
         AND versao < (SELECT versao FROM direitos WHERE uuid = ?1 AND produto_id = ?2)`).bind(uuid, produtoId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO entregas (id, direito_id, uuid, produto_id, acao, versao, estado, tentativas, proxima_tentativa_em, criado_em)
       SELECT ?1, id, uuid, produto_id,
              CASE estado WHEN 'ativo' THEN 'liberar' WHEN 'suspenso' THEN 'suspender' ELSE 'revogar' END,
              versao, 'pendente', 0, ?2, ?2
       FROM direitos WHERE uuid = ?3 AND produto_id = ?4`).bind(crypto.randomUUID(), t, uuid, produtoId),
  ]);
  const depois = await env.DB.prepare("SELECT versao, estado FROM direitos WHERE uuid = ? AND produto_id = ?").bind(uuid, produtoId).first();
  return {mudou: !!depois && (!antes || antes.versao !== depois.versao), estado: depois?.estado ?? null};
}

// ---------- Mercado Pago ----------

async function mp(env, metodo, caminho, corpo, idempotencia) {
  const headers = {Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, Accept: "application/json"};
  if (corpo) headers["Content-Type"] = "application/json";
  if (idempotencia) headers["X-Idempotency-Key"] = idempotencia;
  return fetch(`${env.MP_API || MP_API}${caminho}`, {method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined});
}

/** Conferência do pagamento lido na API contra o pedido. Lista vazia = pode liberar. */
export function conferirPagamento(pagamento, pedido, env) {
  const problemas = [];
  if (String(pagamento.collector_id ?? "") !== String(env.MP_RECEBEDOR_ID ?? "")) problemas.push("conta_recebedora");
  if (String(pagamento.external_reference ?? "") !== pedido.id) problemas.push("referencia");
  if (pagamento.currency_id !== pedido.moeda) problemas.push("moeda");
  if (centavos(pagamento.transaction_amount) !== pedido.valor_centavos) problemas.push("valor");
  if (pedido.modo === "real" && pagamento.live_mode !== true) problemas.push("modo_teste_em_pedido_real");
  return problemas;
}

const ESTADO_DO_PEDIDO = {
  approved: "pago", authorized: "aguardando_pagamento", pending: "aguardando_pagamento", in_process: "aguardando_pagamento",
  in_mediation: "em_disputa", rejected: "recusado", cancelled: "cancelado", refunded: "reembolsado", charged_back: "contestado",
};

/**
 * Lê o pagamento na API (ou usa o já lido pela busca da conciliação) e aplica os efeitos. Idempotente.
 * Política (veja docs/loja.md):
 * - approved conferido → direito ativo. Reembolso parcial mantém o pet e fica registrado para a equipe.
 * - in_mediation (contestação aberta) → direito suspenso enquanto durar.
 * - refunded, charged_back ou cancelled depois de aprovado → direito revogado.
 * - approved que volta depois de disputa (decisão a favor do vendedor) → direito reativado.
 */
export async function sincronizarPagamento(env, pagamentoId, origem, jaLido = null) {
  let p = jaLido;
  if (!p) {
    const r = await mp(env, "GET", `/v1/payments/${encodeURIComponent(pagamentoId)}`);
    if (r.status === 404) {
      await registrarEvento(env, {pagamentoId, origem, status: null, detalhe: "pagamento_nao_encontrado"});
      return {resultado: "nao_encontrado"};
    }
    if (!r.ok) throw new Erro(502, "mercado_pago_indisponivel", {status: r.status});
    p = await r.json();
  }
  const id = String(p.id ?? pagamentoId);
  const t = agora();
  const ref = String(p.external_reference ?? "");
  const pedido = ref ? await env.DB.prepare("SELECT * FROM pedidos WHERE id = ?").bind(ref).first() : null;

  // Sem pedido nosso ou de outra conta: só registra, nunca libera nem revoga.
  if (!pedido || String(p.collector_id ?? "") !== String(env.MP_RECEBEDOR_ID ?? "")) {
    const conferencia = !pedido ? "pedido_desconhecido" : "conta_recebedora";
    await salvarPagamento(env, p, null, conferencia, t);
    await registrarEvento(env, {pagamentoId: id, pedidoId: pedido?.id ?? null, origem, status: p.status, detalhe: conferencia});
    return {resultado: conferencia};
  }

  const problemas = conferirPagamento(p, pedido, env);
  const total = centavos(p.transaction_amount);
  const reembolsado = centavos(p.transaction_amount_refunded || 0) || 0;
  let status = String(p.status || "");
  if (status === "approved" && total > 0 && reembolsado >= total) status = "refunded";
  const conferencia = problemas.length ? problemas.join(",") : "ok";
  await salvarPagamento(env, p, pedido.id, conferencia, t);

  const controla = !pedido.pagamento_id || pedido.pagamento_id === id; // este pagamento é o que liberou (ou o primeiro)
  let novoEstado = ESTADO_DO_PEDIDO[status] ?? pedido.estado;
  let direito = null;
  const detalhes = [];

  if (status === "approved") {
    if (problemas.length) {
      novoEstado = controla ? "divergente" : pedido.estado;
      detalhes.push(`nao_liberado:${conferencia}`);
    } else if (controla) {
      direito = await aplicarDireito(env, {uuid: pedido.uuid, produtoId: pedido.produto_id, pedidoId: pedido.id, estado: "ativo", motivo: `pagamento ${id} aprovado`});
      if (!direito.mudou && direito.estado === "ativo") {
        const dono = await env.DB.prepare("SELECT pedido_id FROM direitos WHERE uuid = ? AND produto_id = ?").bind(pedido.uuid, pedido.produto_id).first();
        const tipo = await env.DB.prepare("SELECT tipo FROM produtos WHERE id = ?").bind(pedido.produto_id).first("tipo");
        if (dono && dono.pedido_id !== pedido.id) detalhes.push(tipo === "apoio" ? "apoio_repetido" : "ja_possuia_por_outro_pedido:reembolsar_manual");
      }
      if (reembolsado > 0) detalhes.push(`reembolso_parcial:${reembolsado}:mantido_pela_politica`);
    } else {
      detalhes.push("pagamento_em_duplicidade:reembolsar_manual");
      novoEstado = pedido.estado;
    }
  } else if (controla && (status === "in_mediation")) {
    direito = await aplicarDireito(env, {uuid: pedido.uuid, produtoId: pedido.produto_id, pedidoId: pedido.id, estado: "suspenso", motivo: `pagamento ${id} em disputa`});
  } else if (controla && ["refunded", "charged_back", "cancelled"].includes(status)) {
    direito = await aplicarDireito(env, {uuid: pedido.uuid, produtoId: pedido.produto_id, pedidoId: pedido.id, estado: "revogado", motivo: `pagamento ${id} ${status}`});
  } else if (!controla) {
    novoEstado = pedido.estado; // tentativa recusada ou pendente de outro pagamento não muda um pedido já pago
  }

  const pagamentoDoPedido = status === "approved" && !problemas.length && controla ? id : pedido.pagamento_id;
  await env.DB.prepare("UPDATE pedidos SET estado = ?, pagamento_id = ?, atualizado_em = ?, conferido_em = ? WHERE id = ?")
    .bind(novoEstado, pagamentoDoPedido ?? null, t, t, pedido.id).run();
  if (novoEstado !== pedido.estado || direito?.mudou || detalhes.length) {
    await registrarEvento(env, {pagamentoId: id, pedidoId: pedido.id, origem, status: p.status,
      detalhe: [`pedido:${pedido.estado}->${novoEstado}`, direito?.mudou ? `direito:${direito.estado}` : null, ...detalhes].filter(Boolean).join(" ")});
  }
  return {resultado: "processado", pedido: novoEstado, direito: direito?.estado ?? null, problemas};
}

async function salvarPagamento(env, p, pedidoId, conferencia, t) {
  await env.DB.prepare(
    `INSERT INTO pagamentos (id, pedido_id, status, status_detalhe, valor_centavos, reembolsado_centavos, moeda, recebedor_id, live_mode, tipo_pagamento, conferencia, atualizado_em)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT (id) DO UPDATE SET pedido_id = excluded.pedido_id, status = excluded.status, status_detalhe = excluded.status_detalhe,
       valor_centavos = excluded.valor_centavos, reembolsado_centavos = excluded.reembolsado_centavos, moeda = excluded.moeda,
       recebedor_id = excluded.recebedor_id, live_mode = excluded.live_mode, tipo_pagamento = excluded.tipo_pagamento,
       conferencia = excluded.conferencia, atualizado_em = excluded.atualizado_em`)
    .bind(String(p.id), pedidoId, String(p.status || "desconhecido"), p.status_detail ?? null,
      Number.isFinite(centavos(p.transaction_amount)) ? centavos(p.transaction_amount) : null,
      centavos(p.transaction_amount_refunded || 0) || 0, p.currency_id ?? null, p.collector_id != null ? String(p.collector_id) : null,
      p.live_mode === true ? 1 : p.live_mode === false ? 0 : null, p.payment_type_id ?? null, conferencia, t).run();
}

async function registrarEvento(env, {pagamentoId = null, pedidoId = null, origem, status = null, detalhe = null}) {
  await env.DB.prepare("INSERT INTO eventos_pagamento (pagamento_id, pedido_id, status, origem, detalhe, criado_em) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(pagamentoId, pedidoId, status, origem, detalhe, agora()).run();
}

// ---------- rotas do site ----------

async function catalogo(env) {
  const {results} = await env.DB.prepare(
    "SELECT id, tipo, nome, descricao, preco_centavos, moeda, preco_confirmado, ativo FROM produtos ORDER BY ordem").all();
  return {
    modo: modoDaLoja(env),
    produtos: results.map(p => ({
      id: p.id, tipo: p.tipo, nome: p.nome, descricao: p.descricao, ativo: p.ativo === 1,
      preco_centavos: p.preco_centavos, moeda: p.moeda, preco_de_teste: p.preco_confirmado !== 1,
      a_venda: bloqueioDeVenda(env, p) === null,
    })),
  };
}

async function iniciarVinculo(req, env) {
  const {nome} = lerJson(await lerCorpo(req));
  if (typeof nome !== "string" || !NOME_RE.test(nome)) throw new Erro(400, "nome_invalido");
  const normalizado = nome.toLowerCase();
  const ip = await ipHash(req, env);
  await limitar(env, `vinculo:ip:${ip}`, 6, 600);
  await limitar(env, `vinculo:nome:${normalizado}`, 3, 600);
  const t = agora();
  const id = crypto.randomUUID();
  const segredo = tokenAleatorio();
  await env.DB.batch([
    env.DB.prepare("UPDATE vinculos SET estado = 'expirado', atualizado_em = ? WHERE nome_normalizado = ? AND estado IN ('aguardando_jogo', 'codigo_exibido')")
      .bind(t, normalizado),
    env.DB.prepare(
      `INSERT INTO vinculos (id, nome_pedido, nome_normalizado, segredo_hash, estado, ip_hash, criado_em, expira_em, atualizado_em)
       VALUES (?, ?, ?, ?, 'aguardando_jogo', ?, ?, ?, ?)`).bind(id, nome, normalizado, await sha256hex(segredo), ip, t, t + VINCULO_SEGUNDOS, t),
  ]);
  return {id, segredo, expira_em: t + VINCULO_SEGUNDOS};
}

async function carregarVinculo(req, env, id) {
  const segredo = req.headers.get("X-Vinculo-Segredo") || "";
  const v = await env.DB.prepare("SELECT * FROM vinculos WHERE id = ?").bind(id).first();
  if (!v || !segredo || !iguais(await sha256hex(segredo), v.segredo_hash)) throw new Erro(404, "vinculo_nao_encontrado");
  if (["aguardando_jogo", "codigo_exibido"].includes(v.estado) && v.expira_em <= agora()) {
    await env.DB.prepare("UPDATE vinculos SET estado = 'expirado', atualizado_em = ? WHERE id = ?").bind(agora(), id).run();
    v.estado = "expirado";
  }
  return v;
}

async function confirmarVinculo(req, env, id) {
  const v = await carregarVinculo(req, env, id);
  const {codigo} = lerJson(await lerCorpo(req));
  if (v.estado !== "codigo_exibido") throw new Erro(409, "vinculo_" + v.estado);
  const limpo = String(codigo || "").toUpperCase().replace(/[\s-]/g, "");
  const t = agora();
  if (!ALFABETO_CODIGO.test(limpo) || !iguais(await sha256hex(`${id}:${limpo}`), v.codigo_hash)) {
    const tentativas = v.tentativas + 1;
    await env.DB.prepare("UPDATE vinculos SET tentativas = ?, estado = ?, atualizado_em = ? WHERE id = ?")
      .bind(tentativas, tentativas >= TENTATIVAS_CODIGO ? "bloqueado" : v.estado, t, id).run();
    throw new Erro(400, "codigo_incorreto", {restantes: Math.max(0, TENTATIVAS_CODIGO - tentativas)});
  }
  const token = tokenAleatorio();
  const ok = await env.DB.batch([
    env.DB.prepare("UPDATE vinculos SET estado = 'confirmado', atualizado_em = ? WHERE id = ? AND estado = 'codigo_exibido'").bind(t, id),
    env.DB.prepare(
      `INSERT INTO jogadores (uuid, nome, criado_em, atualizado_em) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (uuid) DO UPDATE SET nome = excluded.nome, atualizado_em = excluded.atualizado_em`).bind(v.uuid, v.nome_jogo, t),
    env.DB.prepare("INSERT INTO sessoes (token_hash, uuid, criado_em, expira_em) VALUES (?, ?, ?, ?)")
      .bind(await sha256hex(token), v.uuid, t, t + SESSAO_SEGUNDOS),
  ]);
  if (ok[0].meta.changes !== 1) throw new Erro(409, "vinculo_alterado");
  return {token, jogador: {uuid: v.uuid, nome: v.nome_jogo}};
}

async function conta(env, s) {
  const direitos = await env.DB.prepare(
    `SELECT d.produto_id, p.nome, d.estado, d.atualizado_em FROM direitos d JOIN produtos p ON p.id = d.produto_id WHERE d.uuid = ? ORDER BY p.ordem`)
    .bind(s.uuid).all();
  const pedidos = await env.DB.prepare(
    `SELECT id, produto_id, valor_centavos, moeda, modo, estado, criado_em FROM pedidos WHERE uuid = ? ORDER BY criado_em DESC LIMIT 10`)
    .bind(s.uuid).all();
  return {jogador: {uuid: s.uuid, nome: s.nome}, direitos: direitos.results, pedidos: pedidos.results,
    apoio_liberado_em: await apoioLiberadoEm(env, s.uuid), agora: agora()};
}

async function criarPedido(req, env, s) {
  const {produto_id: produtoId} = lerJson(await lerCorpo(req));
  if (typeof produtoId !== "string") throw new Erro(400, "produto_invalido");
  await limitar(env, `pedido:${s.uuid}`, 10, 3600);
  const produto = await env.DB.prepare("SELECT * FROM produtos WHERE id = ?").bind(produtoId).first();
  const bloqueio = bloqueioDeVenda(env, produto);
  if (bloqueio) throw new Erro(produto ? 403 : 404, bloqueio);
  const possui = produto.tipo === "apoio" ? null
    : await env.DB.prepare("SELECT estado FROM direitos WHERE uuid = ? AND produto_id = ? AND estado IN ('ativo', 'suspenso')")
      .bind(s.uuid, produtoId).first();
  if (possui) throw new Erro(409, "ja_possui");
  const valor = produto.tipo === "apoio" ? await valorDoApoio(env, s.uuid, produto) : produto.preco_centavos;
  const t = agora();
  const modo = modoDaLoja(env);
  const aberto = await env.DB.prepare(
    `SELECT id, checkout_url FROM pedidos WHERE uuid = ? AND produto_id = ? AND estado = 'aguardando_pagamento' AND modo = ?
       AND valor_centavos = ? AND expira_em > ? AND checkout_url IS NOT NULL ORDER BY criado_em DESC LIMIT 1`)
    .bind(s.uuid, produtoId, modo, valor, t + 600).first();
  if (aberto) return {pedido_id: aberto.id, checkout_url: aberto.checkout_url, reaproveitado: true};

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO pedidos (id, uuid, produto_id, valor_centavos, moeda, modo, estado, criado_em, atualizado_em, expira_em)
     VALUES (?, ?, ?, ?, ?, ?, 'criado', ?, ?, ?)`).bind(id, s.uuid, produtoId, valor, produto.moeda, modo, t, t, t + PEDIDO_SEGUNDOS).run();

  const site = String(env.SITE_URL || "https://astralmc.online").replace(/\/$/, "");
  const volta = `${site}/loja.html?pedido=${id}`;
  const preferencia = {
    items: [produto.tipo === "apoio"
      ? {id: produto.id, title: `Astral · Apoio ${produto.nome}`, description: valor < produto.preco_centavos
          ? "Apoio ao servidor Astral (diferença para subir de tier, pagamento único)" : "Apoio ao servidor Astral (pagamento único)",
        quantity: 1, currency_id: produto.moeda, unit_price: valor / 100}
      : {id: produto.id, title: `Astral · Pet ${produto.nome}`, description: "Pet cosmético do servidor Astral (compra única)",
        quantity: 1, currency_id: produto.moeda, unit_price: valor / 100}],
    external_reference: id,
    metadata: {pedido_id: id, produto_id: produto.id},
    back_urls: {success: volta, pending: volta, failure: volta},
    auto_return: "approved",
    expires: true,
    expiration_date_from: new Date(t * 1000).toISOString(),
    expiration_date_to: new Date((t + PEDIDO_SEGUNDOS) * 1000).toISOString(),
    // Pix e cartão. Boleto e lotérica ficam de fora: compensam em dias e o pedido expira em 24 h.
    payment_methods: {excluded_payment_types: [{id: "ticket"}, {id: "atm"}], installments: 1},
    statement_descriptor: "ASTRALMC",
  };
  if (env.MP_NOTIFICATION_URL) preferencia.notification_url = env.MP_NOTIFICATION_URL;
  const r = await mp(env, "POST", "/checkout/preferences", preferencia, `pedido-${id}`);
  if (!r.ok) {
    await env.DB.prepare("UPDATE pedidos SET estado = 'cancelado', atualizado_em = ? WHERE id = ?").bind(agora(), id).run();
    await registrarEvento(env, {pedidoId: id, origem: "checkout", detalhe: `preferencia_falhou:${r.status}`});
    throw new Erro(502, "checkout_indisponivel");
  }
  const pref = await r.json();
  const url = modo === "teste" && env.MP_USAR_SANDBOX_INIT_POINT === "sim" && pref.sandbox_init_point ? pref.sandbox_init_point : pref.init_point;
  if (!url || !/^https:\/\/([a-z0-9-]+\.)*mercadopago\.com(\.br)?\//.test(url)) throw new Erro(502, "checkout_indisponivel");
  await env.DB.prepare("UPDATE pedidos SET estado = 'aguardando_pagamento', preferencia_id = ?, checkout_url = ?, atualizado_em = ? WHERE id = ?")
    .bind(String(pref.id), url, agora(), id).run();
  return {pedido_id: id, checkout_url: url};
}

/** Quando o jogador pode apoiar de novo (um mês depois do último apoio pago), ou null se nunca apoiou. */
async function apoioLiberadoEm(env, uuid) {
  const r = await env.DB.prepare(
    `SELECT MAX(pe.criado_em) AS ultimo FROM pedidos pe JOIN produtos p ON p.id = pe.produto_id
     WHERE pe.uuid = ? AND p.tipo = 'apoio' AND pe.estado = 'pago'`).bind(uuid).first();
  return r?.ultimo ? r.ultimo + APOIO_DE_NOVO_SEGUNDOS : null;
}

/**
 * Preço de um tier de apoio para este jogador: quem já tem um tier menor paga só a diferença.
 * Cada tier inclui os anteriores, então um tier igual ou menor ao que ele já tem só pode ser pago de novo
 * um mês depois do último apoio, pelo valor cheio e sem benefício novo (item e personagem são um por jogador).
 * Com um apoio em contestação, nada de apoio é vendido até a disputa acabar.
 */
export async function valorDoApoio(env, uuid, produto) {
  const r = await env.DB.prepare(
    `SELECT MAX(CASE WHEN d.estado = 'ativo' THEN p.preco_centavos END) AS maior, SUM(d.estado = 'suspenso') AS suspensos
     FROM direitos d JOIN produtos p ON p.id = d.produto_id WHERE d.uuid = ? AND p.tipo = 'apoio' AND d.estado IN ('ativo', 'suspenso')`)
    .bind(uuid).first();
  if (r?.suspensos > 0) throw new Erro(409, "apoio_em_disputa");
  const maior = r?.maior || 0;
  if (maior >= produto.preco_centavos) {
    const liberado = await apoioLiberadoEm(env, uuid);
    if (liberado && liberado <= agora()) return produto.preco_centavos;
    throw new Erro(409, "apoio_recente", {liberado_em: liberado});
  }
  return produto.preco_centavos - maior;
}

async function verPedido(env, s, id) {
  const p = await env.DB.prepare(
    `SELECT p.id, p.produto_id, pr.nome AS produto, p.valor_centavos, p.moeda, p.modo, p.estado, p.criado_em,
            (SELECT estado FROM direitos d WHERE d.uuid = p.uuid AND d.produto_id = p.produto_id AND d.pedido_id = p.id) AS direito
     FROM pedidos p JOIN produtos pr ON pr.id = p.produto_id WHERE p.id = ? AND p.uuid = ?`).bind(id, s.uuid).first();
  if (!p) throw new Erro(404, "pedido_nao_encontrado");
  return p;
}

// ---------- webhook ----------

async function webhook(req, env, url) {
  const corpo = await lerCorpo(req);
  let dados = {};
  try { dados = JSON.parse(corpo || "{}"); } catch { /* corpo é só informativo; a assinatura cobre a query */ }
  const dataId = url.searchParams.get("data.id");
  const xRequestId = req.headers.get("x-request-id");
  const tipo = url.searchParams.get("type") || dados.type || url.searchParams.get("topic") || "";
  const assinatura = await assinaturaMercadoPagoValida({
    xSignature: req.headers.get("x-signature"), xRequestId, dataId, segredo: env.MP_WEBHOOK_SECRET,
    toleranciaSegundos: Number(env.MP_TOLERANCIA_SEGUNDOS || 0),
  });
  const registrar = (ok, resultado) => env.DB.prepare(
    `INSERT INTO notificacoes (request_id, tipo, recurso_id, assinatura_ok, resultado, recebida_em) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (request_id) DO UPDATE SET assinatura_ok = excluded.assinatura_ok, resultado = excluded.resultado, recebida_em = excluded.recebida_em`)
    .bind(xRequestId || `sem-id-${crypto.randomUUID()}`, String(tipo).slice(0, 60), dataId ? String(dataId).slice(0, 64) : null, ok ? 1 : 0, resultado, agora()).run();
  if (!assinatura.ok) {
    await registrar(false, assinatura.motivo);
    return json({erro: "assinatura_invalida"}, 401);
  }
  if (tipo !== "payment") {
    await registrar(true, "tipo_ignorado");
    return json({ok: true, ignorado: tipo});
  }
  // Só o id assinado (query) é usado; o corpo não decide nada.
  if (!dataId || !/^\d{1,20}$/.test(dataId)) {
    await registrar(true, "id_invalido");
    return json({erro: "id_invalido"}, 400);
  }
  try {
    const r = await sincronizarPagamento(env, dataId, "webhook");
    await registrar(true, r.resultado);
    return json({ok: true});
  } catch (e) {
    await registrar(true, `erro:${e.codigo || "interno"}`);
    return json({erro: "tente_novamente"}, 500); // o Mercado Pago reenvia
  }
}

// ---------- rotas do servidor do jogo (HMAC + nonce) ----------

export async function autenticarServidor(req, env, corpo) {
  const segredo = env.SERVIDOR_SEGREDO;
  const ts = req.headers.get("X-Astral-Ts") || "";
  const nonce = req.headers.get("X-Astral-Nonce") || "";
  const assinatura = (req.headers.get("X-Astral-Assinatura") || "").toLowerCase();
  if (!segredo || segredo.length < 32) throw new Erro(503, "servidor_nao_configurado");
  if (!/^\d{9,11}$/.test(ts) || Math.abs(agora() - Number(ts)) > 300) throw new Erro(401, "horario_invalido");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new Erro(401, "nonce_invalido");
  const url = new URL(req.url);
  const canonico = `${req.method}\n${url.pathname}${url.search}\n${ts}\n${nonce}\n${await sha256hex(corpo)}`;
  if (!iguais(await hmacHex(segredo, canonico), assinatura)) throw new Erro(401, "assinatura_invalida");
  const r = await env.DB.prepare("INSERT OR IGNORE INTO nonces (nonce, expira_em) VALUES (?, ?)").bind(nonce, agora() + 600).run();
  if (r.meta.changes !== 1) throw new Erro(401, "repeticao");
}

async function vinculosPendentes(env) {
  const {results} = await env.DB.prepare(
    "SELECT id, nome_pedido AS nome FROM vinculos WHERE estado = 'aguardando_jogo' AND expira_em > ? ORDER BY criado_em LIMIT 50")
    .bind(agora()).all();
  return {vinculos: results};
}

async function registrarCodigo(env, id, corpo) {
  const {uuid, nome, codigo} = lerJson(corpo);
  if (typeof uuid !== "string" || !UUID_RE.test(uuid)) throw new Erro(400, "uuid_invalido");
  if (typeof nome !== "string" || !NOME_RE.test(nome)) throw new Erro(400, "nome_invalido");
  if (typeof codigo !== "string" || !ALFABETO_CODIGO.test(codigo)) throw new Erro(400, "codigo_invalido");
  const t = agora();
  const r = await env.DB.prepare(
    `UPDATE vinculos SET estado = 'codigo_exibido', uuid = ?, nome_jogo = ?, codigo_hash = ?, expira_em = MAX(expira_em, ?), atualizado_em = ?
     WHERE id = ? AND estado = 'aguardando_jogo' AND expira_em > ? AND nome_normalizado = ?`)
    .bind(uuid, nome, await sha256hex(`${id}:${codigo}`), t + 300, t, id, t, nome.toLowerCase()).run();
  if (r.meta.changes !== 1) throw new Erro(409, "vinculo_indisponivel");
  return {ok: true};
}

async function recusarVinculo(env, id) {
  await env.DB.prepare("UPDATE vinculos SET estado = 'recusado', atualizado_em = ? WHERE id = ? AND estado IN ('aguardando_jogo', 'codigo_exibido')")
    .bind(agora(), id).run();
  return {ok: true};
}

async function reservarEntregas(env) {
  const t = agora();
  // A própria próxima tentativa funciona como reserva: só volta à fila se não for confirmada até lá.
  const {results} = await env.DB.prepare(
    `UPDATE entregas SET tentativas = tentativas + 1, reservada_ate = ?1,
       proxima_tentativa_em = ?1 + MAX(60, MIN(3600, 30 * (1 << MIN(tentativas, 7))))
     WHERE id IN (SELECT id FROM entregas WHERE estado = 'pendente' AND proxima_tentativa_em <= ?1 ORDER BY criado_em LIMIT 50)
     RETURNING id, uuid, produto_id, acao, versao, tentativas`).bind(t).all();
  return {entregas: results};
}

async function confirmarEntregas(env, corpo) {
  const {entregas} = lerJson(corpo);
  if (!Array.isArray(entregas) || entregas.length > 100) throw new Erro(400, "lista_invalida");
  const t = agora();
  const stmts = [];
  for (const e of entregas) {
    if (!e || typeof e.id !== "string" || !UUID_RE.test(e.id)) continue;
    if (e.resultado === "aplicado") {
      stmts.push(env.DB.prepare("UPDATE entregas SET estado = 'entregue', entregue_em = ?, ultimo_erro = NULL WHERE id = ? AND estado = 'pendente'").bind(t, e.id));
    } else {
      stmts.push(env.DB.prepare("UPDATE entregas SET ultimo_erro = ? WHERE id = ?").bind(String(e.erro || e.resultado || "erro").slice(0, 200), e.id));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return {ok: true, processadas: stmts.length};
}

async function direitosAtuais(env) {
  const {results} = await env.DB.prepare("SELECT uuid, produto_id, estado, versao FROM direitos").all();
  return {direitos: results};
}

// ---------- tarefas agendadas ----------

export async function tarefas(env) {
  const t = agora();
  await env.DB.batch([
    env.DB.prepare("UPDATE vinculos SET estado = 'expirado', atualizado_em = ? WHERE estado IN ('aguardando_jogo', 'codigo_exibido') AND expira_em <= ?").bind(t, t),
    env.DB.prepare("DELETE FROM vinculos WHERE criado_em < ?").bind(t - 30 * 86400),
    env.DB.prepare("DELETE FROM nonces WHERE expira_em < ?").bind(t),
    env.DB.prepare("DELETE FROM limites WHERE janela_inicio < ?").bind(t - 86400),
    env.DB.prepare("DELETE FROM sessoes WHERE expira_em < ?").bind(t),
  ]);
  if (!env.MP_ACCESS_TOKEN) return {conciliados: 0};
  let conciliados = 0;
  // 1) Pedidos sem pagamento confirmado: busca por external_reference (recupera notificações perdidas).
  const abertos = await env.DB.prepare(
    `SELECT id FROM pedidos WHERE estado IN ('criado', 'aguardando_pagamento', 'recusado', 'divergente') AND criado_em > ?
       AND (conferido_em IS NULL OR conferido_em < ?) ORDER BY conferido_em IS NOT NULL, conferido_em LIMIT 10`)
    .bind(t - 3 * 86400, t - 600).all();
  for (const {id} of abertos.results) {
    try {
      const r = await mp(env, "GET", `/v1/payments/search?external_reference=${encodeURIComponent(id)}&sort=date_created&criteria=desc&limit=10`);
      if (!r.ok) continue;
      const {results = []} = await r.json();
      for (const p of results) { await sincronizarPagamento(env, String(p.id), "conciliacao", p); conciliados++; }
      await env.DB.prepare("UPDATE pedidos SET conferido_em = ? WHERE id = ?").bind(t, id).run();
    } catch (e) { console.log("conciliação falhou", id, e.codigo || e.message); }
  }
  // 2) Pedidos pagos: relê o pagamento de tempos em tempos (pega reembolso/contestação sem notificação).
  const pagos = await env.DB.prepare(
    `SELECT id, pagamento_id FROM pedidos WHERE estado IN ('pago', 'em_disputa') AND pagamento_id IS NOT NULL AND criado_em > ?
       AND (conferido_em IS NULL OR conferido_em < ?) ORDER BY conferido_em LIMIT 5`).bind(t - 200 * 86400, t - 6 * 3600).all();
  for (const {pagamento_id: pid} of pagos.results) {
    try { await sincronizarPagamento(env, pid, "reconferencia"); conciliados++; } catch (e) { console.log("reconferência falhou", pid, e.codigo || e.message); }
  }
  // 3) Pedidos abandonados há mais de 3 dias viram expirados (um pagamento tardio ainda libera pelo webhook).
  await env.DB.prepare("UPDATE pedidos SET estado = 'expirado', atualizado_em = ? WHERE estado IN ('criado', 'aguardando_pagamento') AND expira_em < ?")
    .bind(t, t - 2 * 86400).run();
  return {conciliados};
}

// ---------- roteador ----------

export async function handle(req, env) {
  const url = new URL(req.url);
  const caminho = url.pathname;
  const cors = caminho.startsWith("/api/") ? cabecalhosCors(req, env) : {};
  if (req.method === "OPTIONS") return new Response(null, {status: cors["Access-Control-Allow-Origin"] ? 204 : 403, headers: cors});
  try {
    let m;
    let r;
    if (caminho === "/api/catalogo" && req.method === "GET") r = await catalogo(env);
    else if (caminho === "/api/vinculos" && req.method === "POST") r = await iniciarVinculo(req, env);
    else if ((m = /^\/api\/vinculos\/([0-9a-f-]{36})$/.exec(caminho)) && req.method === "GET") {
      const v = await carregarVinculo(req, env, m[1]);
      r = {estado: v.estado, expira_em: v.expira_em, tentativas_restantes: Math.max(0, TENTATIVAS_CODIGO - v.tentativas)};
    } else if ((m = /^\/api\/vinculos\/([0-9a-f-]{36})\/confirmar$/.exec(caminho)) && req.method === "POST") r = await confirmarVinculo(req, env, m[1]);
    else if (caminho === "/api/conta" && req.method === "GET") r = await conta(env, await sessao(req, env));
    else if (caminho === "/api/sair" && req.method === "POST") {
      const s = await sessao(req, env);
      await env.DB.prepare("UPDATE sessoes SET revogada = 1 WHERE token_hash = ?").bind(s.tokenHash).run();
      r = {ok: true};
    } else if (caminho === "/api/pedidos" && req.method === "POST") r = await criarPedido(req, env, await sessao(req, env));
    else if ((m = /^\/api\/pedidos\/([0-9a-f-]{36})$/.exec(caminho)) && req.method === "GET") r = await verPedido(env, await sessao(req, env), m[1]);
    else if (caminho === "/webhooks/mercadopago" && req.method === "POST") return await webhook(req, env, url);
    else if (caminho.startsWith("/servidor/")) {
      const corpo = await lerCorpo(req);
      await autenticarServidor(req, env, corpo);
      if (caminho === "/servidor/vinculos" && req.method === "GET") r = await vinculosPendentes(env);
      else if ((m = /^\/servidor\/vinculos\/([0-9a-f-]{36})\/codigo$/.exec(caminho)) && req.method === "POST") r = await registrarCodigo(env, m[1], corpo);
      else if ((m = /^\/servidor\/vinculos\/([0-9a-f-]{36})\/recusar$/.exec(caminho)) && req.method === "POST") r = await recusarVinculo(env, m[1]);
      else if (caminho === "/servidor/entregas" && req.method === "POST") r = await reservarEntregas(env);
      else if (caminho === "/servidor/entregas/confirmar" && req.method === "POST") r = await confirmarEntregas(env, corpo);
      else if (caminho === "/servidor/direitos" && req.method === "GET") r = await direitosAtuais(env);
      else throw new Erro(404, "rota_inexistente");
    } else throw new Erro(404, "rota_inexistente");
    return json(r, 200, cors);
  } catch (e) {
    if (e instanceof Erro) return json({erro: e.codigo, ...e.extra}, e.status, cors);
    console.log("erro interno", e && e.stack || e);
    return json({erro: "interno"}, 500, cors);
  }
}

export default {
  fetch: (req, env) => handle(req, env),
  scheduled: (evento, env, ctx) => ctx.waitUntil(tarefas(env)),
};
