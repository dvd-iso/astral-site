-- Preparação LOCAL da proposta Keroppi (2026-11-07); nenhuma política é ativada.
-- Identidade vitalícia independe do id/tier da regra, nome, mundo e versão.
ALTER TABLE recompensa_regras ADD COLUMN advancement_id TEXT;
ALTER TABLE concessoes ADD COLUMN advancement_id TEXT;
CREATE UNIQUE INDEX concessoes_conquista_uuid_id ON concessoes (uuid, advancement_id)
  WHERE advancement_id IS NOT NULL;
-- Identidade vitalícia também para concessões Iris históricas NULL cuja chave
-- canônica é `conquista:<uuid>:<namespace>:<caminho>`. Se o histórico já tiver
-- duplicação, o CREATE UNIQUE falha (reconciliar manualmente antes de migrar).
CREATE UNIQUE INDEX concessoes_iris_identidade_vitalicia ON concessoes (
  uuid, COALESCE(advancement_id, substr(chave, length(uuid) + 12))
)
WHERE moeda = 'iris' AND (
  advancement_id IS NOT NULL OR (
    substr(chave, 1, length(uuid) + 11) = 'conquista:' || uuid || ':'
    AND instr(substr(chave, length(uuid) + 12), ':') > 1
  )
);

CREATE TABLE iris_conquistas_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ativo INTEGER NOT NULL DEFAULT 0 CHECK (ativo IN (0, 1)),
  nao_retroativo INTEGER NOT NULL DEFAULT 1 CHECK (nao_retroativo IN (0, 1))
);
INSERT INTO iris_conquistas_config (id) VALUES (1);

-- Snapshot único por UUID antes de começar a emitir; reenvio nunca acrescenta
-- conquistas ao snapshot inicial. Só metadados de conclusão, sem critérios parciais.
CREATE TABLE iris_conquistas_inicios (
  uuid TEXT PRIMARY KEY REFERENCES jogadores (uuid),
  ref TEXT NOT NULL UNIQUE,
  iniciado_em INTEGER NOT NULL
);
CREATE TABLE iris_conquistas_preexistentes (
  uuid TEXT NOT NULL REFERENCES iris_conquistas_inicios (uuid),
  advancement_id TEXT NOT NULL,
  registrado_em INTEGER NOT NULL,
  PRIMARY KEY (uuid, advancement_id)
);

-- Disjuntor proposto, desligado: C_m = 90 * dias_mes * UUIDs + reserva.
-- Um participante entra junto da sua primeira concessão aceita, na mesma transação;
-- reserva é fotografada uma vez/mês e nunca reduz após pagar uma conquista.
CREATE TABLE iris_mensal_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ativo INTEGER NOT NULL DEFAULT 0 CHECK (ativo IN (0, 1))
);
INSERT INTO iris_mensal_config (id) VALUES (1);
CREATE TABLE iris_participantes_mes (
  inicio_mes INTEGER NOT NULL,
  uuid TEXT NOT NULL REFERENCES jogadores (uuid),
  reserva_conquistas INTEGER NOT NULL CHECK (reserva_conquistas >= 0),
  ref TEXT NOT NULL,
  criado_em INTEGER NOT NULL,
  PRIMARY KEY (inicio_mes, uuid)
);
