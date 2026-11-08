// Efeitos dos NOVOS apoios no mesmo prisma_lancamentos usado pelo jogo.
// Todas as decisões de saldo são SELECTs dentro de INSERTs na MESMA transação D1.batch.
// Não há read/modify/write em JS, saldo paralelo, chamadas remotas ou concessão para snapshot zero.
export async function aplicarPrismaDoApoio(env, pedido, pagamento, estado, t) {
  const id = String(pagamento.id);
  const versao = pagamento.date_last_updated ? Date.parse(pagamento.date_last_updated) : 0;
  if (!Number.isFinite(versao)) throw new Error("data_do_pagamento_invalida");
  const parcial = estado === "pago" && Number(pagamento.transaction_amount_refunded) > 0;
  const reversao = ["em_disputa", "reembolsado", "contestado", "cancelado"].includes(estado);
  const tipoCaso = {em_disputa: "contestacao", reembolsado: "reembolso", contestado: "chargeback", cancelado: "cancelamento"}[estado];
  // Só o primeiro pagamento aprovado pode controlar o pedido; eventos de outro pagamento não o sobrescrevem.
  // date_last_updated do MP evita que uma leitura antiga termine depois de um reembolso mais recente.
  const stmts = [env.DB.prepare(
    `UPDATE pedidos SET estado = ?1, pagamento_id = COALESCE(pagamento_id, CASE WHEN ?1 = 'pago' THEN ?2 END),
       apoio_mp_atualizado_em = ?3, atualizado_em = ?4, conferido_em = ?4
     WHERE id = ?5 AND (pagamento_id IS NULL OR (pagamento_id = ?2 AND apoio_mp_atualizado_em <= ?3))
       AND NOT EXISTS (SELECT 1 FROM pagamentos pg WHERE pg.id = ?2 AND pg.mp_atualizado_em > ?3)`)
    .bind(estado, id, versao, t, pedido.id)];
  // Revalida o dono/estado/versão dentro da transação, não usa o pedido lido antes dela como lock.
  const elegivel = `p.id = ?1 AND p.estado = ?2 AND p.pagamento_id = ?3 AND p.apoio_mp_atualizado_em = ?4 AND p.prisma_quantidade > 0
    AND NOT EXISTS (SELECT 1 FROM pagamentos pg WHERE pg.id = ?3 AND pg.mp_atualizado_em > ?4)`;
  const args = [pedido.id, estado, id, versao, t];
  const liquido = `(SELECT COALESCE(SUM(l.quantidade), 0) FROM prisma_lancamentos l WHERE l.apoio_pedido_id = p.id)`;
  const saldo = `(SELECT COALESCE(SUM(s.quantidade), 0) FROM prisma_lancamentos s WHERE s.uuid = p.uuid)`;
  const ref = `'apoio:' || p.id || ':' || (SELECT COUNT(*) + 1 FROM prisma_lancamentos n WHERE n.apoio_pedido_id = p.id)`;
  stmts.push(env.DB.prepare(
    `INSERT OR IGNORE INTO apoio_prisma_efeitos (pedido_id) SELECT p.id FROM pedidos p WHERE ${elegivel}`).bind(...args.slice(0, 4)));
  if (estado === "pago") {
    stmts.push(env.DB.prepare(
      `INSERT INTO prisma_lancamentos (uuid, tipo, quantidade, ref, apoio_pedido_id, detalhe, criado_em)
       SELECT p.uuid, CASE WHEN ${liquido} = 0 AND NOT EXISTS (SELECT 1 FROM prisma_lancamentos WHERE apoio_pedido_id = p.id)
         THEN 'credito' ELSE 'liberacao' END, p.prisma_quantidade - ${liquido}, ${ref}, p.id, 'apoio pago ' || ?3, ?5
       FROM pedidos p WHERE ${elegivel} AND p.prisma_quantidade > ${liquido}`).bind(...args));
    stmts.push(env.DB.prepare(
      `UPDATE apoio_prisma_efeitos SET acao_aplicada = 0 WHERE pedido_id IN (SELECT p.id FROM pedidos p WHERE ${elegivel})`).bind(...args.slice(0, 4)));
    stmts.push(env.DB.prepare(
      `UPDATE apoio_prisma_casos SET acao_aplicada = 0, estado = 'resolvido', resolucao = 'voltou_a_pago', resolvido_em = ?5, atualizado_em = ?5
       WHERE tipo <> 'reembolso_parcial' AND pedido_id IN (SELECT p.id FROM pedidos p WHERE ${elegivel})`).bind(...args));
    if (parcial) stmts.push(env.DB.prepare(
      `INSERT INTO apoio_prisma_casos (pedido_id, uuid, tipo, quantidade_pedido, nota, criado_em, atualizado_em)
       SELECT p.id, p.uuid, 'reembolso_parcial', p.prisma_quantidade, 'reembolso parcial: manter Prisma; revisão humana', ?5, ?5
       FROM pedidos p WHERE ${elegivel}
       ON CONFLICT (pedido_id) DO UPDATE SET tipo = 'reembolso_parcial', quantidade_revertida = 0,
         quantidade_pendente = 0, acao_aplicada = 0, estado = 'aberto', resolucao = NULL, resolvido_em = NULL,
         nota = excluded.nota, atualizado_em = excluded.atualizado_em WHERE apoio_prisma_casos.tipo <> 'reembolso_parcial'`).bind(...args));
  } else if (reversao) {
    // MIN e saldo são calculados na escrita, não antes dela. Gastos simultâneos não criam dívida.
    stmts.push(env.DB.prepare(
      `INSERT INTO prisma_lancamentos (uuid, tipo, quantidade, ref, apoio_pedido_id, detalhe, criado_em)
       SELECT p.uuid, ?6, -MIN(${liquido}, MAX(0, ${saldo})), ${ref}, p.id, 'apoio ' || ?2 || ' ' || ?3, ?5
       FROM pedidos p JOIN apoio_prisma_efeitos e ON e.pedido_id = p.id
       WHERE ${elegivel} AND e.acao_aplicada = 0 AND ${liquido} > 0 AND ${saldo} > 0`)
      .bind(...args, estado === "em_disputa" ? "retencao" : "reversao"));
    // Registra até reversão integral: o marcador e o caso são atômicos com o débito.
    stmts.push(env.DB.prepare(
      `INSERT INTO apoio_prisma_casos (pedido_id, uuid, tipo, quantidade_pedido, quantidade_revertida, quantidade_pendente,
          acao_aplicada, estado, resolucao, criado_em, atualizado_em, resolvido_em)
       SELECT p.id, p.uuid, ?6, p.prisma_quantidade, p.prisma_quantidade - ${liquido}, ${liquido}, 1,
         CASE WHEN ${liquido} > 0 THEN 'aberto' ELSE 'resolvido' END,
         CASE WHEN ${liquido} = 0 THEN 'saldo_revertido' END, ?5, ?5, CASE WHEN ${liquido} = 0 THEN ?5 END
       FROM pedidos p JOIN apoio_prisma_efeitos e ON e.pedido_id = p.id WHERE ${elegivel} AND e.acao_aplicada = 0
         AND EXISTS (SELECT 1 FROM prisma_lancamentos WHERE apoio_pedido_id = p.id)
       ON CONFLICT (pedido_id) DO UPDATE SET tipo = excluded.tipo, quantidade_revertida = excluded.quantidade_revertida,
         quantidade_pendente = excluded.quantidade_pendente, acao_aplicada = 1, estado = excluded.estado,
         resolucao = excluded.resolucao, atualizado_em = excluded.atualizado_em, resolvido_em = excluded.resolvido_em`).bind(...args, tipoCaso));
    // Escala contestação para chargeback sem debitar outra vez nem cobrar créditos futuros.
    stmts.push(env.DB.prepare(
      `UPDATE apoio_prisma_casos SET tipo = ?5, atualizado_em = ?6,
         estado = CASE WHEN quantidade_pendente > 0 AND tipo <> ?5 THEN 'aberto' ELSE estado END
       WHERE pedido_id IN (SELECT p.id FROM pedidos p WHERE ${elegivel}) AND tipo <> ?5`)
      .bind(...args.slice(0, 4), tipoCaso, t));
    stmts.push(env.DB.prepare(
      `UPDATE apoio_prisma_efeitos SET acao_aplicada = 1 WHERE pedido_id IN (SELECT p.id FROM pedidos p WHERE ${elegivel})`).bind(...args.slice(0, 4)));
  }
  const r = await env.DB.batch(stmts);
  return {aplicado: r[0].meta.changes === 1};
}
