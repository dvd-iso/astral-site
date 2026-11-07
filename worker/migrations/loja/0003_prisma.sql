-- Prisma: moeda premium comprável OU ganha por recompensas, só para cosméticos. NÃO é a Iris (moeda local entre jogadores;
-- o Worker nunca guarda saldo de Iris: para a Iris ele só decide, limita e audita a concessão, e o plugin aplica).
-- Migração SÓ ADICIONA tabelas novas: não altera produtos, pedidos, direitos nem entregas (compras atuais intactas).
-- Reversão: DROP TABLE recompensa_canais, prisma_casos, prisma_lancamentos, concessoes, recompensa_recusas, recompensa_tetos_moeda, recompensa_regras, prisma_pedidos, prisma_pacotes
-- (nessa ordem; só antes de qualquer venda ou concessão). Veja docs/prisma.md.
-- Nada daqui vende sem PRISMA_ATIVO = "sim" E um pacote com ativo = 1 e preco_confirmado = 1; nada concede sem
-- RECOMPENSAS_ATIVO = "sim" E uma regra com ativo = 1.
-- Preços, quantidades e regras NÃO são definidos aqui: prisma_pacotes e recompensa_regras nascem VAZIAS (política pendente).

-- Catálogo de pacotes de Prisma. O preço vale SÓ daqui (o navegador manda só o id do pacote).
CREATE TABLE prisma_pacotes (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'prisma_[a-z0-9_]*'),
  nome             TEXT NOT NULL,
  quantidade       INTEGER NOT NULL CHECK (quantidade > 0 AND quantidade <= 1000000),   -- Prisma entregue
  preco_centavos   INTEGER NOT NULL CHECK (preco_centavos > 0),
  moeda            TEXT NOT NULL DEFAULT 'BRL' CHECK (moeda = 'BRL'),
  preco_confirmado INTEGER NOT NULL DEFAULT 0 CHECK (preco_confirmado IN (0, 1)),
  ativo            INTEGER NOT NULL DEFAULT 0 CHECK (ativo IN (0, 1)),
  ordem            INTEGER NOT NULL DEFAULT 0,
  criado_em        INTEGER NOT NULL,
  atualizado_em    INTEGER NOT NULL
);

-- Um pedido de pacote = uma preferência do Checkout Pro. external_reference = 'prisma:' || id.
-- Tabela separada de `pedidos` de propósito: produtos.tipo tem CHECK fechado e recriar produtos mexeria no caminho
-- de pagamentos que já vende de verdade. Quantidade e preço são COPIADOS do pacote no momento do pedido.
CREATE TABLE prisma_pedidos (
  id                TEXT PRIMARY KEY,
  uuid              TEXT NOT NULL REFERENCES jogadores (uuid),
  pacote_id         TEXT NOT NULL REFERENCES prisma_pacotes (id),
  quantidade        INTEGER NOT NULL CHECK (quantidade > 0),
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
CREATE INDEX prisma_pedidos_uuid ON prisma_pedidos (uuid, estado);
CREATE INDEX prisma_pedidos_estado ON prisma_pedidos (estado, conferido_em);

-- Regras de recompensa, configuráveis por SQL sem redeploy. Nasce VAZIA e toda regra nasce inativa; max_unidades_dia é
-- obrigatório de propósito (nenhuma regra sem teto). `quantidade` é por unidade; o plugin pede `unidades` por chamada.
-- fonte: de onde vem o evento (ex.: tempo_jogado, conquista, discord_mensagem). Os valores reais são decisão do dono.
CREATE TABLE recompensa_regras (
  id                        TEXT PRIMARY KEY CHECK (id GLOB '[a-z]*' AND length(id) BETWEEN 3 AND 40),
  fonte                     TEXT NOT NULL CHECK (fonte GLOB '[a-z]*' AND length(fonte) BETWEEN 3 AND 40),
  moeda                     TEXT NOT NULL CHECK (moeda IN ('prisma', 'iris')),
  quantidade                INTEGER NOT NULL CHECK (quantidade > 0 AND quantidade <= 100000),
  max_unidades_por_chamada  INTEGER NOT NULL DEFAULT 1 CHECK (max_unidades_por_chamada >= 1),
  max_unidades_dia          INTEGER NOT NULL CHECK (max_unidades_dia >= 1),        -- por jogador (e por conta Discord), dia de Brasília
  max_unidades_dia_global   INTEGER CHECK (max_unidades_dia_global IS NULL OR max_unidades_dia_global >= 1),   -- todos os jogadores
  max_unidades_total        INTEGER CHECK (max_unidades_total IS NULL OR max_unidades_total >= 1),             -- por jogador, vida toda
  intervalo_minimo_segundos INTEGER NOT NULL DEFAULT 0 CHECK (intervalo_minimo_segundos >= 0),
  verificar_discord         INTEGER NOT NULL DEFAULT 0 CHECK (verificar_discord IN (0, 1)),   -- 1 = relê a mensagem na API do Discord
  idade_maxima_segundos     INTEGER CHECK (idade_maxima_segundos IS NULL OR idade_maxima_segundos >= 60),   -- NULL = sem limite; vale se o conceder trouxer `ocorrido_em`
  descricao                 TEXT,
  ativo                     INTEGER NOT NULL DEFAULT 0 CHECK (ativo IN (0, 1)),
  criado_em                 INTEGER NOT NULL,
  atualizado_em             INTEGER NOT NULL
);

-- Cada concessão = um evento recompensado. UNIQUE (regra_id, chave) é a idempotência: o mesmo evento nunca paga duas vezes.
-- Prisma nasce 'aplicada' (o Worker credita na mesma transação). Iris nasce 'autorizada' e vira 'aplicada' quando o plugin
-- confirma que creditou no saldo local. Recusas NÃO viram linha (evita amplificar spam em escritas): só contador.
CREATE TABLE concessoes (
  id          TEXT PRIMARY KEY,
  regra_id    TEXT NOT NULL REFERENCES recompensa_regras (id),
  uuid        TEXT NOT NULL REFERENCES jogadores (uuid),
  chave       TEXT NOT NULL,
  moeda       TEXT NOT NULL CHECK (moeda IN ('prisma', 'iris')),
  unidades    INTEGER NOT NULL CHECK (unidades >= 1),
  quantidade  INTEGER NOT NULL CHECK (quantidade >= 1),     -- total concedido (unidades × quantidade da regra NA HORA)
  estado      TEXT NOT NULL CHECK (estado IN ('autorizada', 'aplicada')),
  discord_id  TEXT,                                          -- conta Discord do evento (teto por conta, contra contas alternativas)
  evidencia   TEXT,                                          -- JSON curto com ids verificáveis (nunca conteúdo de mensagem)
  dia         INTEGER NOT NULL,                              -- dia de Brasília (dias desde 1970), para os tetos diários
  criado_em   INTEGER NOT NULL,
  aplicada_em INTEGER,
  UNIQUE (regra_id, chave)
);
CREATE INDEX concessoes_jogador_dia ON concessoes (regra_id, uuid, dia);
CREATE INDEX concessoes_discord_dia ON concessoes (regra_id, discord_id, dia);
CREATE INDEX concessoes_dia ON concessoes (regra_id, dia);
CREATE INDEX concessoes_estado ON concessoes (estado, criado_em);

-- Disjuntor de emissão: teto GLOBAL por moeda e por mês (de Brasília), somando todas as regras. Vazio = sem teto (o valor
-- é decisão do dono). Conta `quantidade` (moeda emitida), inclusive Iris ainda "autorizada". Ex. de uso, depois de decidir:
--   INSERT INTO recompensa_tetos_moeda (moeda, max_quantidade_mes, atualizado_em) VALUES ('<prisma|iris>', <teto>, unixepoch())
--   ON CONFLICT (moeda) DO UPDATE SET max_quantidade_mes = excluded.max_quantidade_mes, atualizado_em = excluded.atualizado_em;
CREATE TABLE recompensa_tetos_moeda (
  moeda              TEXT PRIMARY KEY CHECK (moeda IN ('prisma', 'iris')),
  max_quantidade_mes INTEGER NOT NULL CHECK (max_quantidade_mes >= 1),
  atualizado_em      INTEGER NOT NULL
);
CREATE INDEX concessoes_moeda_tempo ON concessoes (moeda, criado_em);

-- Lista de canais do Discord permitidos por regra (allowlist). Vale para regras com fonte 'discord*': SEM nenhum canal
-- cadastrado a regra não paga nada (falha fechada: uma regra de Discord ativa por engano não paga mensagens de qualquer
-- canal). Regras de outras fontes ignoram a tabela. Cadastro por SQL, ex.:
--   INSERT INTO recompensa_canais (regra_id, canal_id, criado_em) VALUES ('<regra>', '<id do canal>', unixepoch());
CREATE TABLE recompensa_canais (
  regra_id  TEXT NOT NULL REFERENCES recompensa_regras (id),
  canal_id  TEXT NOT NULL CHECK (length(canal_id) BETWEEN 17 AND 20 AND canal_id NOT GLOB '*[^0-9]*'),   -- snowflake do Discord
  criado_em INTEGER NOT NULL,
  PRIMARY KEY (regra_id, canal_id)
);

-- Contagem de recusas por regra, dia e motivo (auditoria de spam sem uma linha por tentativa).
CREATE TABLE recompensa_recusas (
  regra_id TEXT NOT NULL,
  dia      INTEGER NOT NULL,
  motivo   TEXT NOT NULL,
  contagem INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (regra_id, dia, motivo)
);

-- Livro-razão: SÓ CRESCE (nunca UPDATE/DELETE). O saldo é a soma de `quantidade` do jogador: não há saldo guardado
-- que possa divergir. `ref` é a chave de idempotência global: repetir a mesma operação não duplica nada.
--   credito    + pagamento aprovado e conferido (ref = <pedido>:<seq>)
--   recompensa + concessão por tempo jogado, conquista, Discord... (ref = 'recompensa:' || concessoes.id)
--   retencao   - contestação aberta: segura o crédito do pedido
--   liberacao  + contestação resolvida a favor da loja
--   reversao   - reembolso total / chargeback / cancelamento depois de aprovado (só o que ainda existe no saldo; o resto vira caso)
--   gasto      - cosmético comprado no jogo (ref = 'gasto:' || ref do plugin); o plugin concede o item
--   compra     - direito do catálogo (pet) comprado com Prisma (ref = 'compra:' || ref); o Worker cria o direito
--   estorno    + desfaz um gasto cujo cosmético não pôde ser aplicado no jogo (ref = 'estorno:' || ref do plugin)
--              ou uma compra de pet que perdeu a corrida contra outra forma de pagamento (ref = 'estorno-compra:' || ref)
--   ajuste     +/- correção manual da equipe (precisa de detalhe)
CREATE TABLE prisma_lancamentos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid       TEXT NOT NULL REFERENCES jogadores (uuid),
  tipo       TEXT NOT NULL CHECK (tipo IN ('credito', 'recompensa', 'retencao', 'liberacao', 'reversao', 'gasto', 'compra', 'estorno', 'ajuste')),
  quantidade INTEGER NOT NULL CHECK (quantidade <> 0),
  ref        TEXT NOT NULL UNIQUE,
  pedido_id  TEXT REFERENCES prisma_pedidos (id),
  concessao_id TEXT REFERENCES concessoes (id),
  item_id    TEXT,                                  -- cosmético (gasto/estorno)
  detalhe    TEXT,
  criado_em  INTEGER NOT NULL,
  -- sinal coerente com o tipo: um lançamento de tipo errado não entra
  CHECK ((tipo IN ('credito', 'recompensa', 'liberacao', 'estorno') AND quantidade > 0)
      OR (tipo IN ('retencao', 'reversao', 'gasto', 'compra') AND quantidade < 0)
      OR tipo = 'ajuste'),
  CHECK (tipo NOT IN ('gasto', 'compra', 'estorno') OR item_id IS NOT NULL)
);
CREATE INDEX prisma_lanc_uuid ON prisma_lancamentos (uuid, id);
CREATE INDEX prisma_lanc_pedido ON prisma_lancamentos (pedido_id);

-- Casos para revisão humana: reembolso, contestação ou chargeback de um pacote cuja Prisma já foi (em parte) gasta.
-- Política (decisão do usuário): analisar caso a caso; NUNCA revogar cosmético nem criar dívida automática. O Worker só
-- retira do saldo o que ainda existe (quantidade_revertida) e registra o que não deu (quantidade_pendente) aqui, uma vez por
-- pedido (UNIQUE), e não tenta cobrar o pendente depois. Resolver (manter, ajustar com `ajuste`, perdoar) é decisão da equipe.
CREATE TABLE prisma_casos (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id            TEXT NOT NULL UNIQUE REFERENCES prisma_pedidos (id),
  uuid                 TEXT NOT NULL REFERENCES jogadores (uuid),
  tipo                 TEXT NOT NULL CHECK (tipo IN ('reembolso_parcial', 'contestacao', 'cancelamento', 'reembolso', 'chargeback')),
  quantidade_pedido    INTEGER NOT NULL,
  quantidade_revertida INTEGER NOT NULL DEFAULT 0,
  quantidade_pendente  INTEGER NOT NULL DEFAULT 0,
  acao_aplicada        INTEGER NOT NULL DEFAULT 0 CHECK (acao_aplicada IN (0, 1)),   -- 1 = o Worker já agiu sobre o saldo neste ciclo
  estado               TEXT NOT NULL DEFAULT 'aberto' CHECK (estado IN ('aberto', 'em_analise', 'resolvido')),
  resolucao            TEXT,
  nota                 TEXT,
  criado_em            INTEGER NOT NULL,
  atualizado_em        INTEGER NOT NULL,
  resolvido_em         INTEGER
);
CREATE INDEX prisma_casos_estado ON prisma_casos (estado, id);
