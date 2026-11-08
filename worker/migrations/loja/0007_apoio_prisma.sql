-- Aditiva: não recria tabelas, não cancela assinaturas e não altera direitos/pedidos existentes.
-- Zero nos pedidos antigos é deliberado: nenhum crédito retroativo, mesmo se pago depois da migração.
ALTER TABLE produtos ADD COLUMN prisma_quantidade INTEGER NOT NULL DEFAULT 0 CHECK (prisma_quantidade >= 0);
ALTER TABLE pedidos ADD COLUMN prisma_quantidade INTEGER NOT NULL DEFAULT 0 CHECK (prisma_quantidade >= 0);
ALTER TABLE pedidos ADD COLUMN prisma_base_quantidade INTEGER NOT NULL DEFAULT 0 CHECK (prisma_base_quantidade >= 0);
ALTER TABLE pedidos ADD COLUMN apoio_mp_atualizado_em INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pagamentos ADD COLUMN mp_atualizado_em INTEGER NOT NULL DEFAULT 0;

UPDATE produtos SET preco_centavos = 2000, preco_confirmado = 1, prisma_quantidade = 200,
  descricao = '200 Prisma a cada novo apoio pago. Cargo exclusivo no Discord. Ícone especial no servidor. Acesso a uma categoria exclusiva do Discord.',
  atualizado_em = unixepoch() WHERE id = 'apoio_20';
UPDATE produtos SET preco_centavos = 5000, preco_confirmado = 1, prisma_quantidade = 600,
  descricao = '600 Prisma a cada novo apoio pago. Benefícios de cargo, ícone e acesso da Estrela. No upgrade, recebe apenas a diferença de Prisma entre os tiers.',
  atualizado_em = unixepoch() WHERE id = 'apoio_50';
UPDATE produtos SET preco_centavos = 10000, preco_confirmado = 1, prisma_quantidade = 1200,
  descricao = '1200 Prisma a cada novo apoio pago. Benefícios de cargo, ícone e acesso dos tiers anteriores. No upgrade, recebe apenas a diferença de Prisma entre os tiers.',
  atualizado_em = unixepoch() WHERE id = 'apoio_100';
-- Só fecha a oferta; cobranças e cancelamento de assinaturas existentes seguem funcionando.
UPDATE produtos SET ativo = 0, atualizado_em = unixepoch() WHERE tipo = 'apoio_mensal';

-- Mesmo livro-razão e mesma soma de saldo. pedido_id original continua exclusivo dos pacotes antigos.
ALTER TABLE prisma_lancamentos ADD COLUMN apoio_pedido_id TEXT REFERENCES pedidos (id);
CREATE INDEX prisma_lanc_apoio ON prisma_lancamentos (apoio_pedido_id);

-- Marcador de ciclo, NÃO outro saldo. Impede cobrar o que já foi gasto quando entrar crédito novo.
CREATE TABLE apoio_prisma_efeitos (
  pedido_id TEXT PRIMARY KEY REFERENCES pedidos (id),
  acao_aplicada INTEGER NOT NULL DEFAULT 0 CHECK (acao_aplicada IN (0, 1))
);

-- A FK dos casos antigos aponta para prisma_pedidos: não a quebra nem inventa pacote para um apoio.
CREATE TABLE apoio_prisma_casos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id TEXT NOT NULL UNIQUE REFERENCES pedidos (id),
  uuid TEXT NOT NULL REFERENCES jogadores (uuid),
  tipo TEXT NOT NULL CHECK (tipo IN ('reembolso_parcial', 'contestacao', 'cancelamento', 'reembolso', 'chargeback')),
  quantidade_pedido INTEGER NOT NULL,
  quantidade_revertida INTEGER NOT NULL DEFAULT 0,
  quantidade_pendente INTEGER NOT NULL DEFAULT 0,
  acao_aplicada INTEGER NOT NULL DEFAULT 0 CHECK (acao_aplicada IN (0, 1)),
  estado TEXT NOT NULL DEFAULT 'aberto' CHECK (estado IN ('aberto', 'em_analise', 'resolvido')),
  resolucao TEXT,
  nota TEXT,
  criado_em INTEGER NOT NULL,
  atualizado_em INTEGER NOT NULL,
  resolvido_em INTEGER
);
CREATE INDEX apoio_prisma_casos_estado ON apoio_prisma_casos (estado, id);

-- Outbox local de recálculo de direitos. O estado financeiro e a pendência mudam na MESMA
-- transação, inclusive no caminho legado. Não depende do pedido continuar pago para o cron recuperar.
CREATE TABLE apoio_recalculos (
  uuid TEXT PRIMARY KEY REFERENCES jogadores (uuid),
  pedido_id TEXT NOT NULL REFERENCES pedidos (id),
  versao INTEGER NOT NULL DEFAULT 1,
  aplicada_versao INTEGER NOT NULL DEFAULT 0,
  motivo TEXT NOT NULL,
  atualizado_em INTEGER NOT NULL
);
CREATE TRIGGER apoio_recalcular_pedido_inserido AFTER INSERT ON pedidos
WHEN NEW.estado IN ('pago', 'em_disputa', 'reembolsado', 'contestado', 'cancelado')
  AND EXISTS (SELECT 1 FROM produtos WHERE id = NEW.produto_id AND tipo IN ('apoio', 'apoio_mensal'))
BEGIN
  INSERT INTO apoio_recalculos (uuid, pedido_id, motivo, atualizado_em)
  VALUES (NEW.uuid, NEW.id, 'pedido inserido ' || NEW.estado, unixepoch())
  ON CONFLICT (uuid) DO UPDATE SET pedido_id = excluded.pedido_id, versao = versao + 1,
    motivo = excluded.motivo, atualizado_em = excluded.atualizado_em;
END;
CREATE TRIGGER apoio_recalcular_pedido_alterado AFTER UPDATE OF estado, pagamento_id ON pedidos
WHEN (NEW.estado <> OLD.estado OR COALESCE(NEW.pagamento_id, '') <> COALESCE(OLD.pagamento_id, ''))
  AND EXISTS (SELECT 1 FROM produtos WHERE id = NEW.produto_id AND tipo IN ('apoio', 'apoio_mensal'))
BEGIN
  INSERT INTO apoio_recalculos (uuid, pedido_id, motivo, atualizado_em)
  VALUES (NEW.uuid, NEW.id, 'pedido alterado ' || NEW.estado, unixepoch())
  ON CONFLICT (uuid) DO UPDATE SET pedido_id = excluded.pedido_id, versao = versao + 1,
    motivo = excluded.motivo, atualizado_em = excluded.atualizado_em;
END;
CREATE TRIGGER apoio_recalcular_reembolso_parcial AFTER UPDATE OF reembolsado_centavos ON pagamentos
WHEN NEW.reembolsado_centavos <> OLD.reembolsado_centavos
BEGIN
  INSERT INTO apoio_recalculos (uuid, pedido_id, motivo, atualizado_em)
  SELECT p.uuid, p.id, 'reembolso atualizado', unixepoch() FROM pedidos p JOIN produtos pr ON pr.id = p.produto_id
  WHERE p.pagamento_id = NEW.id AND pr.tipo IN ('apoio', 'apoio_mensal')
  ON CONFLICT (uuid) DO UPDATE SET pedido_id = excluded.pedido_id, versao = versao + 1,
    motivo = excluded.motivo, atualizado_em = excluded.atualizado_em;
END;
