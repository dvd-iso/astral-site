// Prisma: moeda premium comprável do Astral, usada só em cosméticos. NÃO é a Iris (moeda local entre jogadores).
// Módulo isolado do caminho de pagamentos de pets e apoios: só entra em ação com PRISMA_ATIVO = "sim" e usa tabelas
// próprias (migração 0003). Sem a variável, todas as rotas respondem 404 e o Worker se comporta como antes.
//
// Regras que este arquivo garante (detalhes e decisões em docs/prisma.md):
// - Saldo = soma do livro-razão `prisma_lancamentos` (só cresce). Não existe saldo guardado que possa divergir.
// - Crédito só nasce de pagamento lido na API do Mercado Pago e conferido (conta, referência, moeda, valor, live_mode).
// - Gasto é atômico e idempotente: um INSERT condicionado ao saldo; repetir a mesma `ref` não gasta de novo.
// - Prisma não sai do jogador: não há transferência, saque nem conversão para Iris em nenhuma rota.
// - Quantidade e preço do pacote são copiados para o pedido; o navegador manda só o id do pacote.
//
// As dependências do loja.mjs chegam por injeção (criarPrisma) para evitar importação circular.

const PEDIDO_SEGUNDOS = 24 * 3600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF_RE = /^[A-Za-z0-9_:.-]{8,80}$/;          // chave de idempotência escolhida pelo plugin
const ITEM_RE = /^[a-z0-9_]{2,48}$/;               // id do cosmético
const GASTO_MAXIMO = 100000;
const PEDIDO_ID_RE = /^[0-9a-f-]{36}$/;

const ESTADO_DO_PEDIDO = {
  approved: "pago", authorized: "aguardando_pagamento", pending: "aguardando_pagamento", in_process: "aguardando_pagamento",
  in_mediation: "em_disputa", rejected: "recusado", cancelled: "cancelado", refunded: "reembolsado", charged_back: "contestado",
};

export const prismaAtivo = env => env.PRISMA_ATIVO === "sim";
export const prismaGastosAtivos = env => env.PRISMA_GASTOS_ATIVO === "sim";

export function criarPrisma(h) {
  const {Erro, lerJson, lerCorpo, limitar, mp, salvarPagamento, registrarEvento, conferirPagamento, centavos, modoDaLoja, bloqueioDeVenda, agora, sessao, aplicarDireito} = h;

  const exigirAtivo = env => { if (!prismaAtivo(env)) throw new Erro(404, "prisma_desativado"); };

  // ---------- livro-razão ----------

  async function saldoDe(env, uuid) {
    return (await env.DB.prepare("SELECT COALESCE(SUM(quantidade), 0) AS saldo FROM prisma_lancamentos WHERE uuid = ?").bind(uuid).first("saldo")) || 0;
  }

  /** Cosméticos comprados e não estornados. A ref é a do plugin (sem o prefixo 'gasto:'). */
  async function itensDe(env, uuid) {
    const {results} = await env.DB.prepare(
      `SELECT g.item_id, -g.quantidade AS preco, substr(g.ref, 7) AS ref, g.criado_em
       FROM prisma_lancamentos g
       WHERE g.uuid = ? AND g.tipo = 'gasto'
         AND NOT EXISTS (SELECT 1 FROM prisma_lancamentos e WHERE e.ref = 'estorno:' || substr(g.ref, 7))
       ORDER BY g.id`).bind(uuid).all();
    return results;
  }

  /**
   * Gasta Prisma num cosmético. Um único INSERT condicionado ao saldo (atômico no D1) e protegido por UNIQUE (ref):
   * duas chamadas simultâneas nunca gastam além do saldo, e repetir a mesma chamada devolve o mesmo resultado.
   */
  async function gastar(env, {uuid, quantidade, ref, item}) {
    // O custo dos cosméticos em Prisma ainda não foi aprovado: gastar só com PRISMA_GASTOS_ATIVO = "sim".
    if (env.PRISMA_GASTOS_ATIVO !== "sim") throw new Erro(403, "gastos_desativados");
    if (typeof uuid !== "string" || !UUID_RE.test(uuid)) throw new Erro(400, "uuid_invalido");
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > GASTO_MAXIMO) throw new Erro(400, "quantidade_invalida");
    if (typeof ref !== "string" || !REF_RE.test(ref)) throw new Erro(400, "ref_invalida");
    if (typeof item !== "string" || !ITEM_RE.test(item)) throw new Erro(400, "item_invalido");
    const chave = `gasto:${ref}`;
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO prisma_lancamentos (uuid, tipo, quantidade, ref, item_id, detalhe, criado_em)
       SELECT ?1, 'gasto', -?2, ?3, ?4, NULL, ?5
       WHERE (SELECT COALESCE(SUM(quantidade), 0) FROM prisma_lancamentos WHERE uuid = ?1) >= ?2`)
      .bind(uuid, quantidade, chave, item, agora()).run();
    if (r.meta.changes === 1) return {ok: true, repetido: false, saldo: await saldoDe(env, uuid)};
    const antigo = await env.DB.prepare("SELECT uuid, quantidade, item_id FROM prisma_lancamentos WHERE ref = ?").bind(chave).first();
    if (!antigo) throw new Erro(409, "saldo_insuficiente", {saldo: await saldoDe(env, uuid)});
    if (antigo.uuid !== uuid || antigo.quantidade !== -quantidade || antigo.item_id !== item) throw new Erro(409, "ref_em_uso");
    if (await env.DB.prepare("SELECT 1 AS x FROM prisma_lancamentos WHERE ref = ?").bind(`estorno:${ref}`).first()) throw new Erro(409, "ref_estornada");
    return {ok: true, repetido: true, saldo: await saldoDe(env, uuid)};
  }

  /** Desfaz um gasto cujo cosmético não pôde ser aplicado no jogo. Idempotente. */
  async function estornar(env, {ref}) {
    if (typeof ref !== "string" || !REF_RE.test(ref)) throw new Erro(400, "ref_invalida");
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO prisma_lancamentos (uuid, tipo, quantidade, ref, item_id, detalhe, criado_em)
       SELECT uuid, 'estorno', -quantidade, 'estorno:' || ?1, item_id, 'estorno_do_gasto', ?2
       FROM prisma_lancamentos WHERE ref = 'gasto:' || ?1 AND tipo = 'gasto'`).bind(ref, agora()).run();
    const gasto = await env.DB.prepare("SELECT uuid FROM prisma_lancamentos WHERE ref = ?").bind(`gasto:${ref}`).first();
    if (!gasto) throw new Erro(404, "gasto_inexistente");
    return {ok: true, repetido: r.meta.changes !== 1, saldo: await saldoDe(env, gasto.uuid)};
  }

  /**
   * Efeito de um pedido de pacote no saldo. Política (decisão do usuário): reembolso, contestação e chargeback são analisados
   * caso a caso; o Worker NUNCA cria dívida nem revoga cosmético. Modos:
   * - "creditar": leva o efeito do pedido a `quantidade` (crédito ou liberação) e encerra casos de contestação/reversão.
   * - "reter" / "reverter": retira do saldo SÓ o que ainda existe (min(efeito do pedido, saldo disponível)). O que já foi
   *   gasto fica como `quantidade_pendente` num caso em `prisma_casos` para revisão da equipe, uma vez por pedido: o Worker não
   *   tenta cobrar o pendente depois (nem quando entrar Prisma nova), para a cobrança nunca ser automática.
   * ref = <pedido>:<n>: duas sincronizações simultâneas calculam o mesmo n e o UNIQUE descarta a segunda.
   */
  async function ajustarPedido(env, pedido, modo, tipoCaso = null) {
    const {liquido, n} = await env.DB.prepare(
      "SELECT COALESCE(SUM(quantidade), 0) AS liquido, COUNT(*) AS n FROM prisma_lancamentos WHERE pedido_id = ?").bind(pedido.id).first();
    const t = agora();
    const inserir = async (tipo, quantidade) => (await env.DB.prepare(
      `INSERT OR IGNORE INTO prisma_lancamentos (uuid, tipo, quantidade, ref, pedido_id, detalhe, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(pedido.uuid, tipo, quantidade, `${pedido.id}:${n + 1}`, pedido.id, pedido.pagamento_id ? `pagamento ${pedido.pagamento_id}` : null, t).run()).meta.changes === 1;

    if (modo === "creditar") {
      const diff = pedido.quantidade - liquido;
      const mudou = diff > 0 ? await inserir(n === 0 ? "credito" : "liberacao", diff) : false;
      await env.DB.prepare(
        `UPDATE prisma_casos SET acao_aplicada = 0, estado = 'resolvido', resolucao = 'voltou_a_pago', resolvido_em = ?1, atualizado_em = ?1
         WHERE pedido_id = ?2 AND tipo <> 'reembolso_parcial' AND estado <> 'resolvido'`).bind(t, pedido.id).run();
      return {mudou, tipo: mudou ? (n === 0 ? "credito" : "liberacao") : null, caso: null};
    }

    const caso = await env.DB.prepare("SELECT * FROM prisma_casos WHERE pedido_id = ?").bind(pedido.id).first();
    if (caso && caso.acao_aplicada === 1) {
      // Já agimos neste ciclo (ex.: contestação e depois chargeback): só escala o tipo e reabre para revisão; nada de nova cobrança.
      if (caso.tipo !== tipoCaso) {
        await env.DB.prepare("UPDATE prisma_casos SET tipo = ?, estado = CASE WHEN estado = 'resolvido' THEN 'aberto' ELSE estado END, atualizado_em = ? WHERE pedido_id = ?")
          .bind(tipoCaso, t, pedido.id).run();
        return {mudou: false, tipo: null, caso: {tipo: tipoCaso, pendente: caso.quantidade_pendente, novo: false, escalado: true}};
      }
      return {mudou: false, tipo: null, caso: null};
    }
    const disponivel = Math.max(await saldoDe(env, pedido.uuid), 0);
    const remover = Math.min(liquido, disponivel);
    let mudou = false;
    if (remover > 0) mudou = await inserir(modo === "reter" ? "retencao" : "reversao", -remover);
    const pendente = liquido - remover;
    if (liquido > 0 && pendente > 0) {
      await env.DB.prepare(
        `INSERT INTO prisma_casos (pedido_id, uuid, tipo, quantidade_pedido, quantidade_revertida, quantidade_pendente, acao_aplicada, estado, criado_em, atualizado_em)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'aberto', ?7, ?7)
         ON CONFLICT (pedido_id) DO UPDATE SET tipo = excluded.tipo, quantidade_revertida = excluded.quantidade_revertida,
           quantidade_pendente = excluded.quantidade_pendente, acao_aplicada = 1,
           estado = CASE WHEN prisma_casos.estado = 'resolvido' THEN 'aberto' ELSE prisma_casos.estado END, resolucao = NULL, atualizado_em = excluded.atualizado_em`)
        .bind(pedido.id, pedido.uuid, tipoCaso, pedido.quantidade, pedido.quantidade - pendente, pendente, t).run();
    } else if (caso) {
      // Tudo foi retirado do saldo: nada sobra para revisar (o caso de reembolso parcial anterior, se houver, é atualizado).
      await env.DB.prepare(
        `UPDATE prisma_casos SET tipo = ?1, quantidade_revertida = ?2, quantidade_pendente = 0, acao_aplicada = 1, atualizado_em = ?3 WHERE pedido_id = ?4`)
        .bind(tipoCaso, pedido.quantidade, t, pedido.id).run();
    }
    return {mudou, tipo: mudou ? (modo === "reter" ? "retencao" : "reversao") : null, caso: pendente > 0 && liquido > 0 ? {tipo: tipoCaso, pendente, novo: true, escalado: false} : null};
  }

  /** Reembolso parcial: mantém o saldo e abre (uma vez) um caso de revisão, sem mexer em nada. */
  async function abrirCasoParcial(env, pedido, reembolsadoCentavos) {
    const t = agora();
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO prisma_casos (pedido_id, uuid, tipo, quantidade_pedido, quantidade_revertida, quantidade_pendente, acao_aplicada, estado, nota, criado_em, atualizado_em)
       VALUES (?, ?, 'reembolso_parcial', ?, 0, 0, 0, 'aberto', ?, ?, ?)`)
      .bind(pedido.id, pedido.uuid, pedido.quantidade, `reembolsado_centavos=${reembolsadoCentavos}`, t, t).run();
    return r.meta.changes === 1;
  }

  // ---------- compra de pet com Prisma ----------

  /** Preço em Prisma de um pet à venda (tabela prisma_precos ativa + produto ativo), ou null. */
  async function precoDoPet(env, produtoId) {
    return env.DB.prepare(
      `SELECT pp.produto_id, pp.preco_prisma, p.nome FROM prisma_precos pp JOIN produtos p ON p.id = pp.produto_id
       WHERE pp.produto_id = ? AND pp.ativo = 1 AND p.ativo = 1 AND p.tipo = 'pet'`).bind(produtoId).first();
  }

  /**
   * Compra um pet com Prisma e cria o direito pelo MESMO caminho da compra em reais (direitos + entregas), então o plugin
   * recebe a ação `liberar` como em qualquer pet. Ordem, para nunca perder nem duplicar saldo:
   *  A) uma transação atômica: débito condicionado ao saldo (e o jogador ainda não ter o pet) + pedido `pp-<ref>` (moeda PRISMA);
   *  B) aplicar o direito (reentrante: roda só enquanto o pedido não tem histórico de direito). Se outro pedido já
   *     tem o pet (corrida com a compra em reais), o débito é estornado e o pedido cancelado.
   * Repetir a mesma `ref` devolve o mesmo resultado e, se B tinha ficado pela metade, completa.
   */
  async function comprar(env, {uuid, produto_id: produtoId, ref, preco_esperado: precoEsperado}) {
    if (!prismaGastosAtivos(env)) throw new Erro(403, "gastos_desativados");
    if (typeof uuid !== "string" || !UUID_RE.test(uuid)) throw new Erro(400, "uuid_invalido");
    if (typeof ref !== "string" || !REF_RE.test(ref)) throw new Erro(400, "ref_invalida");
    if (typeof produtoId !== "string" || !ITEM_RE.test(produtoId)) throw new Erro(400, "produto_invalido");
    if (precoEsperado !== undefined && (!Number.isInteger(precoEsperado) || precoEsperado < 1 || precoEsperado > GASTO_MAXIMO)) throw new Erro(400, "preco_esperado_invalido");
    if (env.LOJA_PAUSADA === "sim") throw new Erro(403, "loja_pausada");
    const pedidoId = `pp-${ref}`;
    const chave = `compra:${ref}`;
    let pedido = await env.DB.prepare("SELECT id, uuid, produto_id, valor_centavos, moeda, estado FROM pedidos WHERE id = ?").bind(pedidoId).first();
    let preco;
    let repetido = false;
    if (pedido) {
      if (pedido.uuid !== uuid || pedido.produto_id !== produtoId || pedido.moeda !== "PRISMA") throw new Erro(409, "ref_em_uso");
      if (pedido.estado === "cancelado") throw new Erro(409, "ja_possui");
      preco = pedido.valor_centavos;
      repetido = true;
    } else {
      const item = await precoDoPet(env, produtoId);
      if (!item) throw new Erro(404, "produto_sem_preco");
      preco = item.preco_prisma;
      // O plugin mostrou um preço ao jogador: se o banco mudou desde então, não cobra um valor que o jogador não viu.
      if (precoEsperado !== undefined && precoEsperado !== preco) throw new Erro(409, "preco_divergente", {preco});
      const dono = await env.DB.prepare("SELECT estado FROM direitos WHERE uuid = ? AND produto_id = ?").bind(uuid, produtoId).first();
      if (dono && (dono.estado === "ativo" || dono.estado === "suspenso")) throw new Erro(409, "ja_possui");
      const t = agora();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO prisma_lancamentos (uuid, tipo, quantidade, ref, item_id, detalhe, criado_em)
           SELECT ?1, 'compra', -?2, ?3, ?4, ?5, ?6
           WHERE (SELECT COALESCE(SUM(quantidade), 0) FROM prisma_lancamentos WHERE uuid = ?1) >= ?2
             AND NOT EXISTS (SELECT 1 FROM direitos WHERE uuid = ?1 AND produto_id = ?4 AND estado IN ('ativo', 'suspenso'))`)
          .bind(uuid, preco, chave, produtoId, pedidoId, t),
        env.DB.prepare(
          `INSERT OR IGNORE INTO pedidos (id, uuid, produto_id, valor_centavos, moeda, modo, estado, criado_em, atualizado_em, expira_em)
           SELECT ?1, ?2, ?3, ?4, 'PRISMA', ?5, 'pago', ?6, ?6, ?6
           WHERE EXISTS (SELECT 1 FROM prisma_lancamentos WHERE ref = ?7 AND uuid = ?2 AND item_id = ?3 AND tipo = 'compra')`)
          .bind(pedidoId, uuid, produtoId, preco, modoDaLoja(env), t, chave),
      ]);
      pedido = await env.DB.prepare("SELECT id, uuid, produto_id, valor_centavos, moeda, estado FROM pedidos WHERE id = ?").bind(pedidoId).first();
      if (!pedido) {
        const antigo = await env.DB.prepare("SELECT uuid, item_id FROM prisma_lancamentos WHERE ref = ?").bind(chave).first();
        if (antigo && (antigo.uuid !== uuid || antigo.item_id !== produtoId)) throw new Erro(409, "ref_em_uso");
        const dono2 = await env.DB.prepare("SELECT estado FROM direitos WHERE uuid = ? AND produto_id = ?").bind(uuid, produtoId).first();
        if (dono2 && (dono2.estado === "ativo" || dono2.estado === "suspenso")) throw new Erro(409, "ja_possui");
        throw new Erro(409, "saldo_insuficiente", {saldo: await saldoDe(env, uuid), preco});
      }
    }
    // B) direito + entrega. Só se este pedido ainda não deixou histórico de direito.
    const feito = await env.DB.prepare("SELECT 1 AS x FROM historico_direitos WHERE pedido_id = ?").bind(pedidoId).first();
    if (!feito) {
      await aplicarDireito(env, {uuid, produtoId, pedidoId, estado: "ativo", motivo: `compra com Prisma ${ref}`});
      const d = await env.DB.prepare("SELECT pedido_id, estado FROM direitos WHERE uuid = ? AND produto_id = ?").bind(uuid, produtoId).first();
      if (!d || d.pedido_id !== pedidoId || d.estado !== "ativo") {
        // Perdeu a corrida (o pet entrou por outro pedido): devolve o Prisma e cancela, sem tocar no direito do outro pedido.
        await env.DB.batch([
          env.DB.prepare(
            `INSERT OR IGNORE INTO prisma_lancamentos (uuid, tipo, quantidade, ref, item_id, detalhe, criado_em)
             VALUES (?, 'estorno', ?, ?, ?, 'compra_duplicada', ?)`).bind(uuid, preco, `estorno-compra:${ref}`, produtoId, agora()),
          env.DB.prepare("UPDATE pedidos SET estado = 'cancelado', atualizado_em = ? WHERE id = ?").bind(agora(), pedidoId),
        ]);
        await registrarEvento(env, {pedidoId, origem: "prisma", detalhe: "compra_prisma:perdeu_corrida:estornada"});
        throw new Erro(409, "ja_possui");
      }
      await registrarEvento(env, {pedidoId, origem: "prisma", detalhe: `compra_prisma:${produtoId}:${preco}`});
    }
    return {ok: true, repetido, saldo: await saldoDe(env, uuid), preco, produto_id: produtoId};
  }

  /** Cron: compra que debitou e criou o pedido, mas parou antes de criar o direito (queda entre A e B). Completa. */
  async function concluirCompras(env) {
    const t = agora();
    const {results} = await env.DB.prepare(
      `SELECT pe.id, pe.uuid, pe.produto_id FROM pedidos pe
       WHERE pe.moeda = 'PRISMA' AND pe.estado = 'pago' AND pe.criado_em < ?
         AND NOT EXISTS (SELECT 1 FROM historico_direitos h WHERE h.pedido_id = pe.id) LIMIT 5`).bind(t - 120).all();
    let n = 0;
    for (const p of results) {
      try { await comprar(env, {uuid: p.uuid, produto_id: p.produto_id, ref: p.id.slice(3)}); n++; }
      catch (e) { console.log("conclusão de compra prisma falhou", p.id, e.codigo || e.message); }
    }
    return n;
  }

  // ---------- casos de reembolso/contestação (revisão humana) ----------

  /** Casos abertos ou em análise, com os cosméticos que o jogador comprou, para a equipe decidir caso a caso. */
  async function listarCasos(env, apos, aposApoio = 0) {
    const {results} = await env.DB.prepare(
      `SELECT id, pedido_id, uuid, tipo, quantidade_pedido, quantidade_revertida, quantidade_pendente, acao_aplicada, estado, nota, criado_em, atualizado_em
       FROM prisma_casos WHERE id > ? AND estado <> 'resolvido' ORDER BY id LIMIT 50`).bind(apos).all();
    const casos = [];
    for (const c of results) casos.push({...c, saldo: await saldoDe(env, c.uuid), itens: await itensDe(env, c.uuid)});
    const apoio = await env.DB.prepare(
      `SELECT * FROM apoio_prisma_casos WHERE id > ? AND estado <> 'resolvido' ORDER BY id LIMIT 50`).bind(aposApoio).all();
    const casosApoio = [];
    for (const c of apoio.results) casosApoio.push({...c, origem: "apoio", saldo: await saldoDe(env, c.uuid), itens: await itensDe(env, c.uuid)});
    // Cursor separado: IDs dos casos antigos não mudam e clientes legados podem ignorar o campo novo.
    return {casos, casos_apoio: casosApoio};
  }

  /** Só muda o andamento do caso (não mexe em saldo nem em cosmético): correção de saldo é `ajuste` manual da equipe. */
  async function atualizarCaso(env, {id, estado, resolucao, nota, origem}) {
    if (origem !== undefined && origem !== "apoio") throw new Erro(400, "origem_invalida");
    const tabela = origem === "apoio" ? "apoio_prisma_casos" : "prisma_casos";
    if (!Number.isInteger(id) || id < 1) throw new Erro(400, "caso_invalido");
    if (!["aberto", "em_analise", "resolvido"].includes(estado)) throw new Erro(400, "estado_invalido");
    for (const v of [resolucao, nota]) if (v !== undefined && (typeof v !== "string" || v.length > 500)) throw new Erro(400, "texto_invalido");
    if (estado === "resolvido" && !resolucao) throw new Erro(400, "resolucao_obrigatoria");
    const t = agora();
    const r = await env.DB.prepare(
      `UPDATE ${tabela} SET estado = ?1, resolucao = COALESCE(?2, resolucao), nota = COALESCE(?3, nota), atualizado_em = ?4,
         resolvido_em = CASE WHEN ?1 = 'resolvido' THEN ?4 ELSE NULL END WHERE id = ?5`)
      .bind(estado, resolucao ?? null, nota ?? null, t, id).run();
    if (r.meta.changes !== 1) throw new Erro(404, "caso_inexistente");
    return {ok: true};
  }

  // ---------- pagamento ----------

  /**
   * Chamado pelo loja.mjs quando o pagamento lido na API tem external_reference "prisma:<pedido>".
   * Mesma política dos pets: approved conferido credita; contestação aberta retém; reembolso total, chargeback ou
   * cancelamento depois de aprovado revertem; reembolso parcial mantém e avisa a equipe; pagamento duplicado não credita.
   */
  async function sincronizarPagamento(env, p, origem) {
    const id = String(p.id);
    const t = agora();
    const pedidoId = String(p.external_reference ?? "").slice(7);
    const pedido = PEDIDO_ID_RE.test(pedidoId) ? await env.DB.prepare("SELECT * FROM prisma_pedidos WHERE id = ?").bind(pedidoId).first() : null;
    if (!pedido || String(p.collector_id ?? "") !== String(env.MP_RECEBEDOR_ID ?? "")) {
      const conferencia = !pedido ? "pedido_desconhecido" : "conta_recebedora";
      await salvarPagamento(env, p, null, conferencia, t);
      await registrarEvento(env, {pagamentoId: id, pedidoId: pedido ? `prisma:${pedido.id}` : null, origem, status: p.status, detalhe: `prisma:${conferencia}`});
      return {resultado: conferencia};
    }
    const problemas = conferirPagamento(p, {id: `prisma:${pedido.id}`, moeda: pedido.moeda, valor_centavos: pedido.valor_centavos, modo: pedido.modo}, env);
    const total = centavos(p.transaction_amount);
    const reembolsado = centavos(p.transaction_amount_refunded || 0) || 0;
    let status = String(p.status || "");
    if (status === "approved" && total > 0 && reembolsado >= total) status = "refunded";
    const conferencia = problemas.length ? problemas.join(",") : "ok";
    await salvarPagamento(env, p, null, conferencia, t);

    const controla = !pedido.pagamento_id || pedido.pagamento_id === id;
    let novoEstado = ESTADO_DO_PEDIDO[status] ?? pedido.estado;
    const detalhes = [];
    let mov = {mudou: false, tipo: null};
    if (status === "approved") {
      if (problemas.length) {
        novoEstado = controla ? "divergente" : pedido.estado;
        detalhes.push(`nao_creditado:${conferencia}`);
      } else if (controla) {
        mov = await ajustarPedido(env, {...pedido, pagamento_id: id}, "creditar");
        if (reembolsado > 0) {
          detalhes.push(`reembolso_parcial:${reembolsado}:mantido_pela_politica`);
          if (await abrirCasoParcial(env, pedido, reembolsado)) detalhes.push("caso_aberto:reembolso_parcial");
        }
      } else {
        detalhes.push("pagamento_em_duplicidade:reembolsar_manual");
        novoEstado = pedido.estado;
      }
    } else if (controla && status === "in_mediation") {
      mov = await ajustarPedido(env, pedido, "reter", "contestacao");
    } else if (controla && ["refunded", "charged_back", "cancelled"].includes(status)) {
      mov = await ajustarPedido(env, pedido, "reverter", status === "charged_back" ? "chargeback" : status === "refunded" ? "reembolso" : "cancelamento");
    } else if (!controla) {
      novoEstado = pedido.estado;
    }
    const pagamentoDoPedido = status === "approved" && !problemas.length && controla ? id : pedido.pagamento_id;
    await env.DB.prepare("UPDATE prisma_pedidos SET estado = ?, pagamento_id = ?, atualizado_em = ?, conferido_em = ? WHERE id = ?")
      .bind(novoEstado, pagamentoDoPedido ?? null, t, t, pedido.id).run();
    if (novoEstado !== pedido.estado || mov.mudou || mov.caso || detalhes.length) {
      await registrarEvento(env, {pagamentoId: id, pedidoId: `prisma:${pedido.id}`, origem, status: p.status,
        detalhe: [`prisma_pedido:${pedido.estado}->${novoEstado}`, mov.mudou ? `lancamento:${mov.tipo}` : null, mov.caso ? `caso_${mov.caso.escalado ? "escalado" : "aberto"}:${mov.caso.tipo}:pendente=${mov.caso.pendente}` : null, ...detalhes].filter(Boolean).join(" ")});
    }
    return {resultado: "processado", pedido: novoEstado, lancamento: mov.mudou ? mov.tipo : null, problemas};
  }

  // ---------- rotas do site ----------

  function pacoteVisivel(env, p) {
    return {
      id: p.id, nome: p.nome, quantidade: p.quantidade, preco_centavos: p.preco_centavos, moeda: p.moeda,
      preco_de_teste: p.preco_confirmado !== 1, a_venda: bloqueioDeVenda(env, p) === null,
    };
  }

  /** Pets com preço em Prisma (ativos). `possui` só quando há sessão. */
  async function petsEmPrisma(env, uuid) {
    const {results} = await env.DB.prepare(
      `SELECT p.id AS produto_id, p.nome, pp.preco_prisma,
              (SELECT d.estado FROM direitos d WHERE d.uuid = ?1 AND d.produto_id = p.id) AS direito
       FROM prisma_precos pp JOIN produtos p ON p.id = pp.produto_id
       WHERE pp.ativo = 1 AND p.ativo = 1 AND p.tipo = 'pet' ORDER BY p.ordem`).bind(uuid ?? "").all();
    return results.map(r => ({produto_id: r.produto_id, nome: r.nome, preco_prisma: r.preco_prisma, possui: r.direito === "ativo" || r.direito === "suspenso"}));
  }

  async function painel(env, s) {
    const pacotes = await env.DB.prepare("SELECT * FROM prisma_pacotes WHERE ativo = 1 ORDER BY ordem, preco_centavos").all();
    const extrato = await env.DB.prepare(
      "SELECT tipo, quantidade, item_id, criado_em FROM prisma_lancamentos WHERE uuid = ? ORDER BY id DESC LIMIT 20").bind(s.uuid).all();
    return {modo: modoDaLoja(env), gastos_ativos: prismaGastosAtivos(env), saldo: await saldoDe(env, s.uuid), pacotes: pacotes.results.map(p => pacoteVisivel(env, p)), pets: await petsEmPrisma(env, s.uuid), extrato: extrato.results};
  }

  async function criarPedido(req, env, s) {
    const {pacote_id: pacoteId} = lerJson(await lerCorpo(req));
    if (typeof pacoteId !== "string") throw new Erro(400, "pacote_invalido");
    await limitar(env, `prisma:pedido:${s.uuid}`, 10, 3600);
    const pacote = await env.DB.prepare("SELECT * FROM prisma_pacotes WHERE id = ?").bind(pacoteId).first();
    const bloqueio = bloqueioDeVenda(env, pacote);
    if (bloqueio) throw new Erro(pacote ? 403 : 404, bloqueio);
    const t = agora();
    const modo = modoDaLoja(env);
    const aberto = await env.DB.prepare(
      `SELECT id, checkout_url FROM prisma_pedidos WHERE uuid = ? AND pacote_id = ? AND estado = 'aguardando_pagamento' AND modo = ?
         AND valor_centavos = ? AND quantidade = ? AND expira_em > ? AND checkout_url IS NOT NULL ORDER BY criado_em DESC LIMIT 1`)
      .bind(s.uuid, pacote.id, modo, pacote.preco_centavos, pacote.quantidade, t + 600).first();
    if (aberto) return {pedido_id: aberto.id, checkout_url: aberto.checkout_url, reaproveitado: true};

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO prisma_pedidos (id, uuid, pacote_id, quantidade, valor_centavos, moeda, modo, estado, criado_em, atualizado_em, expira_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'criado', ?, ?, ?)`)
      .bind(id, s.uuid, pacote.id, pacote.quantidade, pacote.preco_centavos, pacote.moeda, modo, t, t, t + PEDIDO_SEGUNDOS).run();
    const site = String(env.SITE_URL || "https://astralmc.online").replace(/\/$/, "");
    const volta = `${site}/loja.html?prisma=${id}`;
    const preferencia = {
      items: [{id: pacote.id, title: `Astral · ${pacote.quantidade} Prisma`, quantity: 1, currency_id: pacote.moeda, unit_price: pacote.preco_centavos / 100,
        description: "Moeda do servidor Astral, só para cosméticos (não transferível e sem vantagem de jogo)"}],
      external_reference: `prisma:${id}`,
      metadata: {prisma_pedido_id: id, pacote_id: pacote.id},
      back_urls: {success: volta, pending: volta, failure: volta},
      auto_return: "approved",
      expires: true,
      expiration_date_from: new Date(t * 1000).toISOString(),
      expiration_date_to: new Date((t + PEDIDO_SEGUNDOS) * 1000).toISOString(),
      payment_methods: {excluded_payment_types: [{id: "ticket"}, {id: "atm"}], installments: 1},
      statement_descriptor: "ASTRALMC",
    };
    if (env.MP_NOTIFICATION_URL) preferencia.notification_url = env.MP_NOTIFICATION_URL;
    const r = await mp(env, "POST", "/checkout/preferences", preferencia, `prisma-${id}`);
    if (!r.ok) {
      await env.DB.prepare("UPDATE prisma_pedidos SET estado = 'cancelado', atualizado_em = ? WHERE id = ?").bind(agora(), id).run();
      await registrarEvento(env, {pedidoId: `prisma:${id}`, origem: "checkout", detalhe: `preferencia_falhou:${r.status}`});
      throw new Erro(502, "checkout_indisponivel");
    }
    const pref = await r.json();
    const url = modo === "teste" && env.MP_USAR_SANDBOX_INIT_POINT === "sim" && pref.sandbox_init_point ? pref.sandbox_init_point : pref.init_point;
    if (!url || !/^https:\/\/([a-z0-9-]+\.)*mercadopago\.com(\.br)?\//.test(url)) throw new Erro(502, "checkout_indisponivel");
    await env.DB.prepare("UPDATE prisma_pedidos SET estado = 'aguardando_pagamento', preferencia_id = ?, checkout_url = ?, atualizado_em = ? WHERE id = ?")
      .bind(String(pref.id), url, agora(), id).run();
    return {pedido_id: id, checkout_url: url};
  }

  async function verPedido(env, s, id) {
    const p = await env.DB.prepare(
      "SELECT id, pacote_id, quantidade, valor_centavos, moeda, modo, estado, criado_em FROM prisma_pedidos WHERE id = ? AND uuid = ?").bind(id, s.uuid).first();
    if (!p) throw new Erro(404, "pedido_nao_encontrado");
    return {...p, saldo: await saldoDe(env, s.uuid)};
  }

  /** Catálogo público (sem sessão), para a página mostrar os pacotes antes de vincular a conta. */
  async function pacotesPublicos(env) {
    const {results} = await env.DB.prepare("SELECT * FROM prisma_pacotes WHERE ativo = 1 ORDER BY ordem, preco_centavos").all();
    return {modo: modoDaLoja(env), gastos_ativos: prismaGastosAtivos(env), pacotes: results.map(p => pacoteVisivel(env, p)), pets: await petsEmPrisma(env, null)};
  }

  async function rotaSite(req, env, caminho) {
    exigirAtivo(env);
    let m;
    if (caminho === "/api/prisma/pacotes" && req.method === "GET") return pacotesPublicos(env);
    if (caminho === "/api/prisma" && req.method === "GET") return painel(env, await sessao(req, env));
    if (caminho === "/api/prisma/pedidos" && req.method === "POST") return criarPedido(req, env, await sessao(req, env));
    if (caminho === "/api/prisma/comprar-pet" && req.method === "POST") {
      const sess = await sessao(req, env);
      const {produto_id: produtoId, preco_esperado: precoEsperado} = lerJson(await lerCorpo(req));
      if (typeof produtoId !== "string" || !ITEM_RE.test(produtoId)) throw new Erro(400, "produto_invalido");
      await limitar(env, `prisma:comprar:${sess.uuid}`, 20, 3600);
      // ref gerada no servidor: um clique = uma compra. Repetir o clique cria outra ref, mas ja_possui/saldo protegem.
      return comprar(env, {uuid: sess.uuid, produto_id: produtoId, ref: `site-${crypto.randomUUID()}`, preco_esperado: precoEsperado});
    }
    if ((m = /^\/api\/prisma\/pedidos\/([0-9a-f-]{36})$/.exec(caminho)) && req.method === "GET") return verPedido(env, await sessao(req, env), m[1]);
    throw new Erro(404, "rota_inexistente");
  }

  // ---------- rotas do servidor do jogo (já autenticadas por HMAC no loja.mjs) ----------

  async function rotaServidor(req, env, caminho, corpo) {
    exigirAtivo(env);
    let m;
    if ((m = /^\/servidor\/prisma\/jogador\/([0-9a-f-]{36})$/.exec(caminho)) && req.method === "GET") {
      if (!UUID_RE.test(m[1])) throw new Erro(400, "uuid_invalido");
      return {uuid: m[1], saldo: await saldoDe(env, m[1]), itens: await itensDe(env, m[1])};
    }
    if (caminho === "/servidor/prisma/gastar" && req.method === "POST") return gastar(env, lerJson(corpo));
    if (caminho === "/servidor/prisma/estornar" && req.method === "POST") return estornar(env, lerJson(corpo));
    if (caminho === "/servidor/prisma/comprar" && req.method === "POST") return comprar(env, lerJson(corpo));
    if (caminho === "/servidor/prisma/precos" && req.method === "GET") return {gastos_ativos: prismaGastosAtivos(env), pets: await petsEmPrisma(env, null)};
    if (caminho === "/servidor/prisma/casos" && req.method === "GET") {
      const apos = Number(new URL(req.url).searchParams.get("apos") || 0);
      const aposApoio = Number(new URL(req.url).searchParams.get("apos_apoio") || 0);
      if (!Number.isInteger(apos) || apos < 0 || !Number.isInteger(aposApoio) || aposApoio < 0) throw new Erro(400, "cursor_invalido");
      return listarCasos(env, apos, aposApoio);
    }
    if (caminho === "/servidor/prisma/casos/atualizar" && req.method === "POST") return atualizarCaso(env, lerJson(corpo));
    if (caminho === "/servidor/prisma/novos" && req.method === "GET") {
      // Créditos, retenções e reversões novos, para o plugin avisar quem está online. Cursor = id do último visto.
      const apos = Number(new URL(req.url).searchParams.get("apos") || 0);
      if (!Number.isInteger(apos) || apos < 0) throw new Erro(400, "cursor_invalido");
      const {results} = await env.DB.prepare(
        `SELECT id, uuid, tipo, quantidade FROM prisma_lancamentos WHERE id > ? AND tipo IN ('credito', 'recompensa', 'liberacao', 'retencao', 'reversao', 'ajuste')
         ORDER BY id LIMIT 100`).bind(apos).all();
      return {lancamentos: results};
    }
    throw new Erro(404, "rota_inexistente");
  }

  // ---------- tarefas agendadas (conciliação) ----------

  async function tarefas(env) {
    if (!prismaAtivo(env)) return {conciliados: 0};
    let compras = 0;
    if (prismaGastosAtivos(env)) { try { compras = await concluirCompras(env); } catch (e) { console.log("compras prisma falharam", e.codigo || e.message); } }
    if (!env.MP_ACCESS_TOKEN) return {conciliados: 0, compras};
    const t = agora();
    let conciliados = 0;
    const abertos = await env.DB.prepare(
      `SELECT id FROM prisma_pedidos WHERE estado IN ('criado', 'aguardando_pagamento', 'recusado', 'divergente') AND criado_em > ?
         AND (conferido_em IS NULL OR conferido_em < ?) ORDER BY conferido_em IS NOT NULL, conferido_em LIMIT 5`).bind(t - 3 * 86400, t - 600).all();
    for (const {id} of abertos.results) {
      try {
        const r = await mp(env, "GET", `/v1/payments/search?external_reference=${encodeURIComponent(`prisma:${id}`)}&sort=date_created&criteria=desc&limit=10`);
        if (!r.ok) continue;
        const {results = []} = await r.json();
        for (const p of results) { await sincronizarPagamento(env, p, "conciliacao"); conciliados++; }
        await env.DB.prepare("UPDATE prisma_pedidos SET conferido_em = ? WHERE id = ?").bind(t, id).run();
      } catch (e) { console.log("conciliação prisma falhou", id, e.codigo || e.message); }
    }
    const pagos = await env.DB.prepare(
      `SELECT id, pagamento_id FROM prisma_pedidos WHERE estado IN ('pago', 'em_disputa') AND pagamento_id IS NOT NULL AND criado_em > ?
         AND (conferido_em IS NULL OR conferido_em < ?) ORDER BY conferido_em LIMIT 3`).bind(t - 200 * 86400, t - 6 * 3600).all();
    for (const {pagamento_id: pid} of pagos.results) {
      try {
        const r = await mp(env, "GET", `/v1/payments/${encodeURIComponent(pid)}`);
        if (r.ok) { await sincronizarPagamento(env, await r.json(), "reconferencia"); conciliados++; }
      } catch (e) { console.log("reconferência prisma falhou", pid, e.codigo || e.message); }
    }
    await env.DB.prepare("UPDATE prisma_pedidos SET estado = 'expirado', atualizado_em = ? WHERE estado IN ('criado', 'aguardando_pagamento') AND expira_em < ?")
      .bind(t, t - 2 * 86400).run();
    return {conciliados, compras};
  }

  return {saldoDe, itensDe, gastar, estornar, comprar, listarCasos, atualizarCaso, sincronizarPagamento, rotaSite, rotaServidor, tarefas};
}
