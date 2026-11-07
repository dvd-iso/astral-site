-- Catálogo aprovado de pacotes de Prisma (decisão do usuário em 2026-11-07, escolha de UI 31f12332).
-- Só dados: nenhuma estrutura nova. Preço e quantidade valem SÓ daqui (o navegador manda apenas o id do pacote).
-- Os pacotes nascem com ativo = 0: só vendem depois de `UPDATE prisma_pacotes SET ativo = 1 ...` E PRISMA_ATIVO = "sim".
-- Preço aprovado = preco_confirmado 1. O custo dos cosméticos em Prisma NÃO está aprovado: o gasto fica atrás de
-- PRISMA_GASTOS_ATIVO (ausente = /servidor/prisma/gastar recusa). Veja docs/prisma.md.
-- Desfazer (antes de qualquer pedido): DELETE FROM prisma_pacotes WHERE id IN ('prisma_100', 'prisma_275', 'prisma_600');
INSERT INTO prisma_pacotes (id, nome, quantidade, preco_centavos, moeda, preco_confirmado, ativo, ordem, criado_em, atualizado_em) VALUES
  ('prisma_100', '100 Prisma', 100,  990, 'BRL', 1, 0, 1, unixepoch(), unixepoch()),
  ('prisma_275', '275 Prisma', 275, 2490, 'BRL', 1, 0, 2, unixepoch(), unixepoch()),
  ('prisma_600', '600 Prisma', 600, 4990, 'BRL', 1, 0, 3, unixepoch(), unixepoch());
