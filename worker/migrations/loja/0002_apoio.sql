-- Apoio: tiers por SOMA do que o jogador já apoiou (avulso por Pix/cartão ou mensal no cartão).
-- Cada pagamento aprovado vira um pedido pago; o tier é o maior cujo valor cabe na soma, e fica para sempre
-- (só cai se o dinheiro voltar: reembolso ou contestação).
-- O SQLite não altera CHECK: a tabela produtos é recriada (troca de nomes, sem apagar a tabela pai com filhos).
PRAGMA defer_foreign_keys = on;
-- Copia, apaga e recria com o MESMO nome. Ao apagar, pedidos/direitos ficam sem pai por um instante (contado como
-- pendência adiada); reinserir cada produto na tabela nova resolve a pendência. Renomear não serviria: com chaves
-- estrangeiras ligadas o SQLite reescreve as referências para o nome antigo.
CREATE TABLE produtos_copia AS SELECT * FROM produtos;
DROP TABLE produtos;
CREATE TABLE produtos (
  id               TEXT PRIMARY KEY,
  tipo             TEXT NOT NULL CHECK (tipo IN ('pet', 'apoio', 'apoio_mensal')),
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
INSERT INTO produtos SELECT id, tipo, nome, descricao, preco_centavos, moeda, preco_confirmado, ativo, ordem, criado_em, atualizado_em FROM produtos_copia;
DROP TABLE produtos_copia;

-- Tiers: cada um inclui os anteriores. O avulso cobra só o que falta para chegar ao tier (regra no Worker).
-- Começam inativos: o dono liga depois de conferir (UPDATE produtos SET ativo = 1 WHERE tipo = 'apoio').
INSERT INTO produtos (id, tipo, nome, descricao, preco_centavos, moeda, preco_confirmado, ativo, ordem, criado_em, atualizado_em) VALUES
  ('apoio_20',  'apoio', 'Estrela',      'Cargo exclusivo no Discord. Ícone especial no servidor. Acesso a uma categoria exclusiva do Discord.', 2000, 'BRL', 1, 0, 101, unixepoch(), unixepoch()),
  ('apoio_50',  'apoio', 'Constelação', 'Tudo da Estrela. Um item especial na lore, feito sob medida para o seu personagem.', 5000, 'BRL', 1, 0, 102, unixepoch(), unixepoch()),
  ('apoio_100', 'apoio', 'Galáxia',     'Tudo da Constelação. Um personagem seu na lore do Astral.', 10000, 'BRL', 1, 0, 103, unixepoch(), unixepoch());

-- Apoio mensal (Assinaturas do Mercado Pago, cartão). Cada mês cobrado soma para o tier.
INSERT INTO produtos (id, tipo, nome, descricao, preco_centavos, moeda, preco_confirmado, ativo, ordem, criado_em, atualizado_em) VALUES
  ('apoio_mensal_20',  'apoio_mensal', 'Apoio mensal de R$ 20',  'Cobrado todo mês no cartão. Cada mês soma para o seu tier.', 2000, 'BRL', 1, 0, 111, unixepoch(), unixepoch()),
  ('apoio_mensal_50',  'apoio_mensal', 'Apoio mensal de R$ 50',  'Cobrado todo mês no cartão. Cada mês soma para o seu tier.', 5000, 'BRL', 1, 0, 112, unixepoch(), unixepoch()),
  ('apoio_mensal_100', 'apoio_mensal', 'Apoio mensal de R$ 100', 'Cobrado todo mês no cartão. Cada mês soma para o seu tier.', 10000, 'BRL', 1, 0, 113, unixepoch(), unixepoch());

-- Uma assinatura (preapproval) por linha. O e-mail do pagador vai só para o Mercado Pago: não é gravado aqui.
CREATE TABLE assinaturas (
  id             TEXT PRIMARY KEY,
  uuid           TEXT NOT NULL REFERENCES jogadores (uuid),
  produto_id     TEXT NOT NULL REFERENCES produtos (id),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  modo           TEXT NOT NULL CHECK (modo IN ('teste', 'real')),
  estado         TEXT NOT NULL CHECK (estado IN ('criada', 'pendente', 'autorizada', 'pausada', 'cancelada')),
  preapproval_id TEXT UNIQUE,
  checkout_url   TEXT,
  criado_em      INTEGER NOT NULL,
  atualizado_em  INTEGER NOT NULL,
  conferido_em   INTEGER
);
CREATE INDEX assinaturas_uuid ON assinaturas (uuid, estado);

-- Cada cobrança mensal aprovada vira um pedido (para reaproveitar conferência, reembolso e contestação).
CREATE TABLE cobrancas (
  pagamento_id  TEXT PRIMARY KEY,
  assinatura_id TEXT NOT NULL REFERENCES assinaturas (id),
  pedido_id     TEXT NOT NULL UNIQUE REFERENCES pedidos (id),
  criado_em     INTEGER NOT NULL
);

-- Mural de apoiadores na página inicial: aparece por padrão; o jogador pode esconder o nick pela loja.
CREATE TABLE mural (
  uuid          TEXT PRIMARY KEY REFERENCES jogadores (uuid),
  visivel       INTEGER NOT NULL CHECK (visivel IN (0, 1)),
  atualizado_em INTEGER NOT NULL
);
