-- Loja do Astral: pedidos, pagamentos, direitos de acesso e entregas ao servidor.
-- Datas são segundos Unix (UTC). Valores em centavos inteiros: nunca ponto flutuante.
-- Aplicar: npx wrangler d1 migrations apply astral-loja -c worker/wrangler.loja.jsonc --remote

-- Catálogo. O preço vale SÓ daqui: o site e o checkout nunca escolhem valor nem moeda.
-- preco_confirmado = 0 marca preço provisório de teste; o Worker recusa venda real nesse estado.
CREATE TABLE produtos (
  id               TEXT PRIMARY KEY,
  tipo             TEXT NOT NULL CHECK (tipo IN ('pet')),
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

-- Identidade persistente: UUID da conta Mojang (servidor em online-mode, sem proxy e sem Bedrock).
CREATE TABLE jogadores (
  uuid          TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  criado_em     INTEGER NOT NULL,
  atualizado_em INTEGER NOT NULL
);

-- Vinculação site ↔ conta do jogo. O código nasce no plugin e só aparece dentro do jogo;
-- aqui fica apenas o hash. O navegador prova que é o mesmo que pediu com o segredo (hash também).
CREATE TABLE vinculos (
  id               TEXT PRIMARY KEY,
  nome_pedido      TEXT NOT NULL,
  nome_normalizado TEXT NOT NULL,
  segredo_hash     TEXT NOT NULL,
  estado           TEXT NOT NULL CHECK (estado IN ('aguardando_jogo', 'codigo_exibido', 'confirmado', 'recusado', 'expirado', 'bloqueado')),
  uuid             TEXT,
  nome_jogo        TEXT,
  codigo_hash      TEXT,
  tentativas       INTEGER NOT NULL DEFAULT 0,
  ip_hash          TEXT,
  criado_em        INTEGER NOT NULL,
  expira_em        INTEGER NOT NULL,
  atualizado_em    INTEGER NOT NULL
);
CREATE INDEX vinculos_estado ON vinculos (estado, expira_em);
CREATE INDEX vinculos_nome ON vinculos (nome_normalizado, estado);

CREATE TABLE sessoes (
  token_hash TEXT PRIMARY KEY,
  uuid       TEXT NOT NULL REFERENCES jogadores (uuid),
  criado_em  INTEGER NOT NULL,
  expira_em  INTEGER NOT NULL,
  revogada   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessoes_uuid ON sessoes (uuid);

-- Um pedido = uma preferência do Checkout Pro. external_reference = pedidos.id.
CREATE TABLE pedidos (
  id                TEXT PRIMARY KEY,
  uuid              TEXT NOT NULL REFERENCES jogadores (uuid),
  produto_id        TEXT NOT NULL REFERENCES produtos (id),
  valor_centavos    INTEGER NOT NULL CHECK (valor_centavos > 0),
  moeda             TEXT NOT NULL,
  modo              TEXT NOT NULL CHECK (modo IN ('teste', 'real')),
  estado            TEXT NOT NULL CHECK (estado IN ('criado', 'aguardando_pagamento', 'pago', 'recusado', 'cancelado',
                                                    'expirado', 'divergente', 'em_disputa', 'reembolsado', 'contestado')),
  preferencia_id    TEXT,
  checkout_url      TEXT,
  pagamento_id      TEXT,
  criado_em         INTEGER NOT NULL,
  atualizado_em     INTEGER NOT NULL,
  expira_em         INTEGER NOT NULL,
  conferido_em      INTEGER
);
CREATE INDEX pedidos_uuid ON pedidos (uuid, produto_id, estado);
CREATE INDEX pedidos_estado ON pedidos (estado, conferido_em);

-- Último estado conhecido de cada pagamento, sempre lido da API do Mercado Pago (nunca do corpo da notificação).
CREATE TABLE pagamentos (
  id                    TEXT PRIMARY KEY,
  pedido_id             TEXT REFERENCES pedidos (id),
  status                TEXT NOT NULL,
  status_detalhe        TEXT,
  valor_centavos        INTEGER,
  reembolsado_centavos  INTEGER NOT NULL DEFAULT 0,
  moeda                 TEXT,
  recebedor_id          TEXT,
  live_mode             INTEGER,
  tipo_pagamento        TEXT,
  conferencia           TEXT NOT NULL,   -- 'ok' ou a lista de divergências
  atualizado_em         INTEGER NOT NULL
);
CREATE INDEX pagamentos_pedido ON pagamentos (pedido_id);

-- Histórico (só cresce): cada consulta que mudou algo, com a origem (webhook, conciliação, admin).
CREATE TABLE eventos_pagamento (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pagamento_id TEXT,
  pedido_id    TEXT,
  status       TEXT,
  origem       TEXT NOT NULL,
  detalhe      TEXT,
  criado_em    INTEGER NOT NULL
);
CREATE INDEX eventos_pedido ON eventos_pagamento (pedido_id);

-- Notificações recebidas (deduplicadas por x-request-id), inclusive as recusadas, para auditoria.
CREATE TABLE notificacoes (
  request_id    TEXT PRIMARY KEY,
  tipo          TEXT,
  recurso_id    TEXT,
  assinatura_ok INTEGER NOT NULL,
  resultado     TEXT,
  recebida_em   INTEGER NOT NULL
);

-- Direito de acesso: um por jogador e produto. versao cresce a cada mudança de estado e ordena as entregas.
CREATE TABLE direitos (
  id            TEXT PRIMARY KEY,
  uuid          TEXT NOT NULL REFERENCES jogadores (uuid),
  produto_id    TEXT NOT NULL REFERENCES produtos (id),
  estado        TEXT NOT NULL CHECK (estado IN ('ativo', 'suspenso', 'revogado')),
  pedido_id     TEXT NOT NULL REFERENCES pedidos (id),
  versao        INTEGER NOT NULL DEFAULT 1,
  motivo        TEXT NOT NULL,
  criado_em     INTEGER NOT NULL,
  atualizado_em INTEGER NOT NULL,
  UNIQUE (uuid, produto_id)
);

CREATE TABLE historico_direitos (
  direito_id TEXT NOT NULL REFERENCES direitos (id),
  versao     INTEGER NOT NULL,
  estado     TEXT NOT NULL,
  pedido_id  TEXT NOT NULL,
  motivo     TEXT NOT NULL,
  criado_em  INTEGER NOT NULL,
  PRIMARY KEY (direito_id, versao)
);

-- Fila de entregas ao servidor. Uma por versão do direito: UNIQUE impede entrega duplicada.
-- acao é uma de três ações fechadas; o plugin só conhece produtos do próprio config.
CREATE TABLE entregas (
  id                   TEXT PRIMARY KEY,
  direito_id           TEXT NOT NULL REFERENCES direitos (id),
  uuid                 TEXT NOT NULL,
  produto_id           TEXT NOT NULL,
  acao                 TEXT NOT NULL CHECK (acao IN ('liberar', 'suspender', 'revogar')),
  versao               INTEGER NOT NULL,
  estado               TEXT NOT NULL CHECK (estado IN ('pendente', 'entregue', 'substituida')),
  tentativas           INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em INTEGER NOT NULL,
  reservada_ate        INTEGER,
  ultimo_erro          TEXT,
  criado_em            INTEGER NOT NULL,
  entregue_em          INTEGER,
  UNIQUE (direito_id, versao)
);
CREATE INDEX entregas_fila ON entregas (estado, proxima_tentativa_em);

-- Nonces das chamadas assinadas do servidor (anti-repetição) e limites de taxa do site.
CREATE TABLE nonces (
  nonce     TEXT PRIMARY KEY,
  expira_em INTEGER NOT NULL
);
CREATE TABLE limites (
  chave         TEXT PRIMARY KEY,
  contagem      INTEGER NOT NULL,
  janela_inicio INTEGER NOT NULL
);

-- Catálogo previsto. Só o gato fica ativo para o primeiro teste. R$ 1,00 é PREÇO DE TESTE
-- (preco_confirmado = 0): o Worker não vende de verdade até o dono definir o preço final.
INSERT INTO produtos (id, tipo, nome, descricao, preco_centavos, moeda, preco_confirmado, ativo, ordem, criado_em, atualizado_em) VALUES
  ('pet_gato',    'pet', 'Gato',    'Um gato que segue você pelo mundo. Só companhia: não luta, não coleta e não dá vantagens.', 100, 'BRL', 0, 1, 1, unixepoch(), unixepoch()),
  ('pet_raposa',  'pet', 'Raposa',  'Em breve.', 100, 'BRL', 0, 0, 2, unixepoch(), unixepoch()),
  ('pet_axolote', 'pet', 'Axolote', 'Em breve.', 100, 'BRL', 0, 0, 3, unixepoch(), unixepoch()),
  ('pet_allay',   'pet', 'Allay',   'Em breve.', 100, 'BRL', 0, 0, 4, unixepoch(), unixepoch()),
  ('pet_abelha',  'pet', 'Abelha',  'Em breve.', 100, 'BRL', 0, 0, 5, unixepoch(), unixepoch()),
  ('pet_sapo',    'pet', 'Sapo',    'Em breve.', 100, 'BRL', 0, 0, 6, unixepoch(), unixepoch()),
  ('pet_coelho',  'pet', 'Coelho',  'Em breve.', 100, 'BRL', 0, 0, 7, unixepoch(), unixepoch());
