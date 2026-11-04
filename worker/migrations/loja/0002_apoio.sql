-- Tiers de apoio (pagamento único, benefícios permanentes) no mesmo fluxo de pedidos dos pets.
-- O SQLite não altera CHECK: a tabela produtos é recriada. defer_foreign_keys deixa pedidos/direitos
-- apontando para "produtos" durante a troca; as chaves são conferidas no fim da transação.
PRAGMA defer_foreign_keys = on;

CREATE TABLE produtos_novo (
  id               TEXT PRIMARY KEY,
  tipo             TEXT NOT NULL CHECK (tipo IN ('pet', 'apoio')),
  nome             TEXT NOT NULL,
  descricao        TEXT NOT NULL,
  preco_centavos   INTEGER NOT NULL CHECK (preco_centavos > 0),
  moeda            TEXT NOT NULL DEFAULT 'BRL' CHECK (moeda = 'BRL'),
  preco_confirmado INTEGER NOT NULL DEFAULT 0 CHECK (preco_confirmado IN (0, 1)),
  ativo            INTEGER NOT NULL DEFAULT 0 CHECK (ativo IN (0, 1)),
  ordem            INTEGER NOT NULL DEFAULT 0,
  criado_em        INTEGER NOT NULL,
  atualizado_em    INTEGER NOT NULL
);
INSERT INTO produtos_novo SELECT id, tipo, nome, descricao, preco_centavos, moeda, preco_confirmado, ativo, ordem, criado_em, atualizado_em FROM produtos;
DROP TABLE produtos;
ALTER TABLE produtos_novo RENAME TO produtos;

-- Tiers: cada um inclui os anteriores. Quem já tem um tier paga só a diferença para subir (regra no Worker).
-- Começam inativos: o dono liga depois de conferir (UPDATE produtos SET ativo = 1 WHERE tipo = 'apoio').
INSERT INTO produtos (id, tipo, nome, descricao, preco_centavos, moeda, preco_confirmado, ativo, ordem, criado_em, atualizado_em) VALUES
  ('apoio_20',  'apoio', 'Estrela',      'Cargo exclusivo no Discord. Ícone especial no servidor. Acesso a uma categoria exclusiva do Discord.', 2000, 'BRL', 1, 0, 101, unixepoch(), unixepoch()),
  ('apoio_50',  'apoio', 'Constelação', 'Tudo da Estrela. Um item especial na lore, feito sob medida para o seu personagem.', 5000, 'BRL', 1, 0, 102, unixepoch(), unixepoch()),
  ('apoio_100', 'apoio', 'Galáxia',     'Tudo da Constelação. Um personagem seu na lore do Astral.', 10000, 'BRL', 1, 0, 103, unixepoch(), unixepoch());
