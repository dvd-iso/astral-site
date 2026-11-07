-- Configuração LOCAL: decisão do usuário, bloco 9f8e5a81 (2026-11-07).
-- Aplicar só em base isolada após as migrações. NÃO executa deploy nem liga interruptores.
-- Reaplicar não altera regras existentes. RECOMPENSAS_ATIVO continua ausente.
-- 1 unidade de tempo = 1800 segundos ATIVOS medidos pelo plugin; AFK não conta.
-- Os limites são em unidades: 8 x 10 = 80 Iris/dia; 5 x 2 = 10 Iris/dia.
INSERT INTO recompensa_regras
  (id, fonte, moeda, quantidade, max_unidades_por_chamada, max_unidades_dia,
   intervalo_minimo_segundos, verificar_discord, descricao, ativo, criado_em, atualizado_em)
VALUES
  ('iris_tempo_ativo', 'tempo_jogado', 'iris', 10, 1, 8, 0, 0,
   '10 Iris por 1800 segundos ativos; AFK excluído pelo plugin; máximo 80 Iris/dia', 0, unixepoch(), unixepoch()),
  ('iris_discord_mensagem', 'discord_mensagem', 'iris', 2, 1, 5, 300, 0,
   '2 Iris por mensagem; máximo 10 Iris/dia; intervalo técnico 300 s; somente metadados e canais permitidos', 0, unixepoch(), unixepoch())
ON CONFLICT (id) DO NOTHING;

-- Conquistas: 5/15/40 por dificuldade, cada advancement UMA vez por jogador.
-- Catálogo aprovado pelo usuário (proposta Keroppi): 15 IDs completos, 240 Iris/UUID na vida toda.
-- Permanece INATIVO por padrão (ativo = 0) até autorização de deploy/ativação.
-- Cada objeto tem {id, advancement, tier}, com id único de regra
-- (3–40 caracteres), advancement completo e tier 1/2/3. Uma regra por advancement;
-- nunca duplicar o mesmo advancement em tiers diferentes. O plugin usa essa mesma
-- associação e a chave conquista:<uuid>:<advancement>. max_unidades_total = 1
-- impede novo pagamento com outra chave para a mesma conquista; dia = 1 é redundante.
WITH tiers(tier, quantidade) AS (VALUES (1, 5), (2, 15), (3, 40)),
conquistas AS (
  SELECT json_extract(value, '$.id') AS id,
         json_extract(value, '$.advancement') AS advancement,
         json_extract(value, '$.tier') AS tier
  FROM json_each('[
  {
    "id": "iris_conq_plant_seed",
    "advancement": "minecraft:husbandry/plant_seed",
    "tier": 1
  },
  {
    "id": "iris_conq_breed_an_animal",
    "advancement": "minecraft:husbandry/breed_an_animal",
    "tier": 1
  },
  {
    "id": "iris_conq_tame_an_animal",
    "advancement": "minecraft:husbandry/tame_an_animal",
    "tier": 1
  },
  {
    "id": "iris_conq_fishy_business",
    "advancement": "minecraft:husbandry/fishy_business",
    "tier": 1
  },
  {
    "id": "iris_conq_shoot_arrow",
    "advancement": "minecraft:adventure/shoot_arrow",
    "tier": 1
  },
  {
    "id": "iris_conq_deflect_arrow",
    "advancement": "minecraft:story/deflect_arrow",
    "tier": 1
  },
  {
    "id": "iris_conq_enchant_item",
    "advancement": "minecraft:story/enchant_item",
    "tier": 2
  },
  {
    "id": "iris_conq_cure_zombie_villager",
    "advancement": "minecraft:story/cure_zombie_villager",
    "tier": 2
  },
  {
    "id": "iris_conq_summon_iron_golem",
    "advancement": "minecraft:adventure/summon_iron_golem",
    "tier": 2
  },
  {
    "id": "iris_conq_find_fortress",
    "advancement": "minecraft:nether/find_fortress",
    "tier": 2
  },
  {
    "id": "iris_conq_find_bastion",
    "advancement": "minecraft:nether/find_bastion",
    "tier": 2
  },
  {
    "id": "iris_conq_return_to_sender",
    "advancement": "minecraft:nether/return_to_sender",
    "tier": 2
  },
  {
    "id": "iris_conq_kill_dragon",
    "advancement": "minecraft:end/kill_dragon",
    "tier": 3
  },
  {
    "id": "iris_conq_explore_nether",
    "advancement": "minecraft:nether/explore_nether",
    "tier": 3
  },
  {
    "id": "iris_conq_bred_all_animals",
    "advancement": "minecraft:husbandry/bred_all_animals",
    "tier": 3
  }
]')
)
INSERT INTO recompensa_regras
  (id, fonte, moeda, quantidade, max_unidades_por_chamada, max_unidades_dia,
   max_unidades_total, descricao, advancement_id, ativo, criado_em, atualizado_em)
SELECT c.id, 'conquista', 'iris', t.quantidade, 1, 1, 1,
       c.advancement, c.advancement, 0, unixepoch(), unixepoch()
FROM conquistas c JOIN tiers t ON t.tier = c.tier
WHERE true
ON CONFLICT (id) DO NOTHING;

-- Não cadastrar canais sem os ids aprovados: recompensa_canais permanece vazia.
-- Disjuntor mensal proporcional (C = 90 * dias * N + R) e não retroatividade aprovados pelo usuário (migração 0006), ambos inativos até autorização de deploy/ativação.
-- Não definir teto estático ou idade máxima: valores ainda sem decisão.
-- Iris transferida fica no plugin: SEM limite diário, SEM taxa, com confirmação
-- e idempotência. Este SQL só configura EMISSÃO; não limita transferências.
