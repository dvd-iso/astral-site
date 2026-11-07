-- Preço em Prisma dos direitos do catálogo atual (pets). Decisão do usuário: pets equiparáveis a R$ 9,90 = 100 Prisma
-- (o pacote de 100 Prisma custa R$ 9,90). Preço vale SÓ daqui; o cliente nunca manda valor.
-- Os preços nascem ativo = 0 e a compra ainda exige PRISMA_GASTOS_ATIVO = "sim". Pet continua comprável em reais.
-- Tabela separada de `produtos` (cujo CHECK de tipo e as chaves estrangeiras não devem ser tocados).
-- Desfazer: DROP TABLE prisma_precos;
CREATE TABLE prisma_precos (
  produto_id    TEXT PRIMARY KEY REFERENCES produtos (id),
  preco_prisma  INTEGER NOT NULL CHECK (preco_prisma > 0 AND preco_prisma <= 100000),
  ativo         INTEGER NOT NULL DEFAULT 0 CHECK (ativo IN (0, 1)),
  criado_em     INTEGER NOT NULL,
  atualizado_em INTEGER NOT NULL
);
INSERT INTO prisma_precos (produto_id, preco_prisma, ativo, criado_em, atualizado_em)
  SELECT id, 100, 0, unixepoch(), unixepoch() FROM produtos WHERE tipo = 'pet';
