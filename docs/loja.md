# Loja de pets e apoios do Astral

## Revisão local de apoios com Prisma (2026-11-07)

Implementação preparada no workspace, **sem migração remota, deploy, publicação nem alteração de assinaturas em produção**. As instruções de implantação abaixo são históricas, não registro de execução desta revisão.

| Apoio avulso | Pagamento inteiro | Prisma por novo pedido pago |
| --- | --- | --- |
| Estrela (`apoio_20`) | R$ 20 | 200 |
| Constelação (`apoio_50`) | R$ 50 | 600 |
| Galáxia (`apoio_100`) | R$ 100 | 1200 |

- Cargos, ícone, acesso e mural continuam seguindo a soma dos pagamentos. A quantidade de Prisma do tier superior **não se soma** à dos anteriores numa compra inteira. Não há item sob medida nem personagem como benefício novo; direitos/pedidos antigos não são apagados.
- **Upgrade:** paga o que falta na soma em reais e recebe a quantidade do tier alvo menos a do maior tier já alcançado. Estrela → Constelação: R$ 30 e **400**, não 600 Prisma. Constelação → Galáxia: R$ 50 e 600 Prisma. Sem tier anterior: quantidade inteira. Saldos gastos e recompensas não entram no cálculo. Se a soma estiver entre tiers (ex.: cobranças antigas), a base em Prisma é a do maior tier alcançado, não uma proporção inventada em reais.
- **Repetição:** tier já alcançado custa o valor inteiro e concede a quantidade inteira a cada novo pedido pago, sem carência de um mês. Continua somando para os cargos; atingir outro tier por acúmulo não cria outro crédito além do snapshot do pedido.
- `produtos.prisma_quantidade` é o catálogo D1. `pedidos.prisma_quantidade` e `prisma_base_quantidade` são snapshots no checkout, inclusive para upgrades. Reaproveitar checkout exige mesmo valor, quantidade e base. Mudar o catálogo não muda pedidos já criados.
- A migração **aditiva `0007_apoio_prisma.sql`** não recria tabelas. Pedidos anteriores mantêm quantidade **zero**, mesmo que pagos depois: nenhuma concessão retroativa automática. Cobranças de assinaturas antigas também nascem com zero; continuam somando financeiramente sem conceder Prisma.
- `POST /api/assinaturas` responde `403 novas_assinaturas_encerradas` sem chamar Mercado Pago nem alterar assinatura antiga. O catálogo omite mensais e `/api/pedidos` também recusa produto mensal, mesmo se alguém o reativar por SQL. Consulta da conta, cancelamento, webhooks de assinatura/cobrança e conciliação continuam funcionando. Nenhuma assinatura existente é cancelada automaticamente.
- A página conserva a gestão da assinatura mesmo sem tiers ativos. API antiga sem quantidade de Prisma deixa os novos botões fechados, sem reapresentar descrições de item/personagem. A resposta de um pedido antigo não afirma crédito de Prisma.
- O saldo continua sendo **apenas `SUM(prisma_lancamentos.quantidade)`**. Não existe saldo de apoio paralelo. `apoio_pedido_id` liga os lançamentos aos pedidos sem quebrar a FK `pedido_id` dos pacotes. `apoio_prisma_efeitos` guarda só o marcador de reversão do ciclo, nunca saldo.
- `worker/apoio-prisma.mjs` aplica estado financeiro, vínculo do primeiro pagamento aprovado, crédito/reversão e caso humano num **`DB.batch` atômico**. Cálculos de saldo são feitos no próprio `INSERT … SELECT`. Notificações e pagamentos duplicados, concorrência com gastos, retry e queda antes/depois do commit não duplicam crédito nem criam dívida. Refund ou disputa sem crédito anterior não toma posse do checkout: outro pagamento aprovado e conferido pode ser processado; o watermark de cada pagamento impede reativar uma leitura antiga dele.
- **Direitos e recuperação durável:** triggers da migração registram `apoio_recalculos` na mesma transação da alteração financeira, também para mensal/legados e reembolso parcial. O recálculo lê a soma atual e grava direitos, histórico, entregas e confirmação da versão numa única transação, sem soma velha em JS. O cron recupera versões pendentes antes de consultar o MP, mesmo sem token, sem limite de idade e com o pedido reembolsado, contestado ou cancelado. Se uma etapa cair, a pendência não é confirmada e o cron termina a recuperação sem conceder Prisma retroativa.
- A quantidade efetiva desta compra aparece junto ao botão, além do tooltip, com base no catálogo recebido. No upgrade Estrela → Constelação: **R$ 30 e 400 Prisma**. Catálogo incompleto não inventa quantidade nem habilita checkout.
- O MP continua sendo relido e conferido pelo fluxo existente, incluindo valor, moeda, recebedor, referência e `live_mode`. `date_last_updated`, quando fornecido pela API, impede que uma leitura antiga sobrescreva estado/saldo ou o reembolso registrado mais recente. Notificações não são autorização financeira por si só.
- **Disputa:** retém no máximo o saldo disponível até o efeito líquido do pedido. **Refund integral, chargeback ou cancelamento após aprovação:** reverte da mesma forma. O que já foi gasto abre caso humano; nunca há débito automático de crédito futuro, saldo negativo ou remoção de cosméticos. Vitória da loja libera só o que havia sido retido. Reembolso parcial mantém Prisma e abre caso; o dinheiro devolvido continua descontado da soma financeira dos tiers, como antes.
- Casos ficam em `apoio_prisma_casos`, sem alterar FKs dos casos antigos. `GET /servidor/prisma/casos?apos=0&apos_apoio=0` preserva `casos` e acrescenta `casos_apoio`, com cursor independente. Para gerir um caso de apoio, envie `origem: "apoio"` em `/servidor/prisma/casos/atualizar`; a gestão não altera saldo/cosméticos. Requer o mesmo HMAC e `PRISMA_ATIVO` das rotas existentes.
- **Pacotes standalone e compras de pets com Prisma continuam fechados.** Esta migração não ativa `prisma_pacotes`, `prisma_precos` ou `PRISMA_GASTOS_ATIVO`. O crédito de um apoio válido não depende do interruptor das ofertas standalone; consultar o saldo no jogo continua exigindo `PRISMA_ATIVO`.

### Validação e implantação futura

`node --test worker/test/` inclui backend, migração sobre banco legado, concorrência, falhas transacionais, disputa/refund/chargeback, legado mensal e o frontend real executado num DOM mínimo (`loja-frontend.test.mjs`). Não é teste visual nem pagamento real.

Conferência adicional local em 2026-11-07: 120 testes Node passaram; `WorkerRealIT` do Astral Economic, contra este Worker e D1 em memória, passou 9/9 (nenhuma rede de produção). A página foi aberta no Chromium com catálogo simulado extraído da migração: três cards com 200/600/1200 Prisma, sem seletor mensal e sem overflow horizontal no viewport testado. Não houve checkout nem pagamento real.

Correções posteriores à revisão independente, ainda locais: os testes adicionais reproduzem aprovação atrasada após refund, rollback antes do commit, crash após commit e no meio dos direitos, recuperação de refund/chargeback/cancelamento antigos pelo cron sem MP, snapshots zero/novos e outro pagamento válido após refund/disputa sem crédito. O frontend mostra preço e Prisma efetivos junto ao botão, sem depender de hover.

Validação final após essas correções e os pedidos de pets/mural: `node --test worker/test/` passou **130/130**. `ASTRAL_WORKER_DIR=/Users/dvd/Projects/astral/astral-site mvn -o -Dtest='*Test,WorkerRealIT' test` no Economic passou **102/102**, incluindo 6 de variantes e 9 de integração com Worker/D1 locais. `git diff --check` limpo nos dois repositórios. Nenhum jar foi empacotado nem enviado.

### Fotos dos pets e mural público

- As imagens em `artes/pets/` não foram alteradas. O contrato local do Astral Economic fixa gato `minecraft:red`, raposa `RED`, axolote `LUCY`, coelho `BROWN`, sapo `minecraft:temperate`, Allay/abelha padrão, também com config antigo. Outros produtos personalizados não mudam. Veja `../astral-economic/docs/pets-foto.md` e o fragmento de migração `../astral-economic/ferramentas/pets-foto.yml`; nenhuma configuração da host foi lida/escrita. Idade e mecânicas não mudaram. A nova copy de aparência só corresponde ao runtime depois de uma futura instalação/reinício autorizados do plugin atualizado.
- `#apoiadores` agora existe visível desde o HTML, com link junto ao apoio da home. `mural.js` diferencia carregando, nenhum apoiador público e falha, com retry e timeout. Usa só a lista pública, sem dados fictícios, cache local de nicks, credenciais ou logs pessoais; a opção de ocultar o nick continua filtrada no Worker. Agrupamento e contagens consideram somente os dados públicos recebidos.
- Os testes DOM do mural cobrem região estável/âncora, agrupamento, zero públicos, HTTP/rede/payload inválido, retry e timeout. Os testes de variantes cobrem defaults/fragmento, config antigo, UUIDs distintos, catálogo customizado e enums Paper. Isso não substitui conferência visual em um cliente do jogo; não houve pagamento ou validação visual nova em produção.

Ordem para uma **futura operação autorizada**: manter novas vendas pausadas durante a janela, aplicar `0007` antes de publicar o Worker que a exige, publicar Worker e depois HTML/JS (`loja.js?v=8`). Antes da copy que garante a aparência da foto, instalar a futura atualização autorizada do Economic com o contrato de variantes e conferir os pets após reinício. Conferir catálogo/checkout em sandbox e só então reabrir a oferta. O código antigo pode criar snapshots zero durante a janela se as vendas não forem pausadas. Não reescrever pedidos legados para conceder Prisma e não remover assinaturas.

As seções seguintes documentam a implantação original da loja de pets.

Primeira versão: só o **gato**, em **modo de teste**. Nenhuma venda real acontece até você mudar três coisas de propósito (veja [Abrir vendas reais](#abrir-vendas-reais)).

## Como funciona

```
Site (loja.html, GitHub Pages)
   │  1. nick → pedido de vinculação          4. código digitado → sessão
   ▼                                          ▲
Worker astral-loja (Cloudflare) + D1 ◀───────┘
   │  2. plugin vê o pedido (HTTPS assinado)   3. plugin gera o código e mostra SÓ no jogo
   │  5. pedido → preferência Checkout Pro → jogador paga no Mercado Pago
   │  6. webhook assinado → Worker relê o pagamento na API → confere → direito + entrega
   ▼
Plugin AstralLoja (Paper) — busca entregas a cada 10 s, aplica, grava e confirma
```

- **Identidade:** o servidor roda em `online-mode=true`, sem proxy (BungeeCord e Velocity desligados), sem Geyser/Floodgate. Por isso só entram contas originais, e o pedido fica no **UUID da conta Microsoft/Mojang**. O nick é só o ponto de partida: quem prova que é dono da conta é o código, que aparece apenas na tela do jogo, para quem está conectado com aquele nick.
- **Nada é liberado pela página de retorno.** Só o pagamento lido na API (`GET /v1/payments/{id}`), com conferência de status, conta recebedora (`collector_id`), referência (`external_reference` = id do pedido), moeda e valor. Em pedido real, também exige `live_mode`.
- **Idempotência:** um direito por jogador e produto (`UNIQUE`). Cada mudança de estado gera uma versão nova e uma entrega única por versão. O plugin ignora versões que já aplicou. Notificação repetida, entrega repetida ou fora de ordem não causam efeito.
- **Offline e reinícios:** o pedido fica no D1 até o plugin confirmar. O plugin grava `direitos.json` antes de confirmar. Na volta, ele também lê o retrato completo dos direitos (a cada 30 min e no início). Se a rede falhar, espera 5 s, 10 s, 20 s… até 5 min. No Worker, uma entrega não confirmada volta à fila em 1, 1, 2, 4… até 60 min.
- **Ações fechadas:** o Worker só manda `liberar`, `suspender` ou `revogar` de um produto que o plugin conhece pelo `config.yml`. Não há comandos.
- **Threads:** rede só em tarefas assíncronas; tudo que mexe no jogo roda na thread principal (`callSyncMethod`/`runTask`).

### Política (implementada no código)

| Situação no Mercado Pago | Pedido | Pet |
| --- | --- | --- |
| `approved` e tudo confere | `pago` | liberado (ativado sozinho se o jogador não tiver outro) |
| `approved` com valor, moeda, conta ou modo divergente | `divergente` | **não** liberado; fica no histórico para a equipe |
| `pending` / `in_process` / `authorized` | `aguardando_pagamento` | nada |
| `rejected` / `cancelled` antes de aprovar | `recusado` / `cancelado` | nada |
| `in_mediation` (contestação aberta) | `em_disputa` | **suspenso** (some do jogo) |
| volta a `approved` depois da disputa | `pago` | reativado |
| `refunded` (total) ou `cancelled` depois de aprovado | `reembolsado` / `cancelado` | **revogado** |
| `charged_back` | `contestado` | **revogado** |
| reembolso parcial | `pago` | mantido; evento `reembolso_parcial` para a equipe decidir |
| segundo pagamento aprovado do mesmo pedido, ou pet já possuído por outro pedido | sem mudança | evento `reembolsar_manual` |

Reembolso ou estorno de um pedido **antigo** não derruba uma recompra feita depois (só o pedido que liberou o direito pode suspendê-lo ou revogá-lo). Tudo fica em `eventos_pagamento` e `historico_direitos`.

## Arquivos

| Onde | O quê |
| --- | --- |
| `astral-site/loja.html`, `loja.js`, `style.css` (fim), `config.js` (`loja.apiUrl`) | página da loja (fora do menu e com `noindex` até abrir) |
| `astral-site/worker/loja.mjs`, `wrangler.loja.jsonc` | Worker |
| `astral-site/worker/migrations/loja/0001_inicial.sql` | banco D1 (tabelas e catálogo com preço **de teste**) |
| `astral-site/worker/test/loja.test.mjs`, `d1-sqlite.mjs` | testes (D1 simulado com `node:sqlite`) |
| `Astral/loja/` | plugin `AstralLoja` (Maven, Paper 26.3-178, Java 25) |

## Testes

```sh
node --test worker/test/loja.test.mjs        # Node 22.13 ou mais novo; sem rede, sem npm
cd ../Astral/loja && mvn package              # 9 testes JUnit + jar em target/AstralLoja-0.1.0.jar
```

Cobertos: assinatura inválida, ausente, de outro id ou de outro segredo. Valor, moeda ou conta recebedora errados. Referência desconhecida. Notificação repetida 3×. Mercado Pago fora do ar (responde 500 para o reenvio). Jogador ou servidor offline com recuo crescente. Erro relatado pelo plugin. Reembolso, contestação aberta e resolvida, chargeback e recompra. Tentativa recusada atrasada. Conciliação agendada. Bloqueio de venda real. Preço vindo do cliente ignorado. HMAC, nonce repetido e horário velho do servidor. Limites de tentativa da vinculação. CORS. No plugin: o vetor HMAC é idêntico ao do Worker, entregas repetidas ou fora de ordem, um pet ativo, persistência e reinício, recuo e alfabeto do código.

Também foi testado de ponta a ponta numa cópia local: Paper 26.3-178 + plugin, Worker em Node com SQLite e Mercado Pago simulado. O jogador offline recebeu o pet com notificação em dobro (1 entrega). Com o Worker fora do ar, o plugin recuou e se recuperou. O reembolso revogou. O reinício do Paper não reaplicou nada. No navegador, o fluxo vincular → código → comprar → retorno → "pagamento confirmado" funcionou.

## Hospedagem do backend

Proposta: **Cloudflare Workers + D1**, na mesma conta que já roda `astral-discord`, `astral-publicar` e `astral-mapa`. Não exige servidor próprio e já tem HTTPS.

Limites conferidos em 2026-11-04 (developers.cloudflare.com):

| | Workers Free (US$ 0) | Workers Paid (US$ 5/mês por conta) |
| --- | --- | --- |
| Requisições | 100 mil/dia | 10 milhões/mês inclusos |
| CPU por requisição | 10 ms | até 5 min (30 s padrão) |
| D1 leituras / escritas | 5 milhões / 100 mil por dia | 25 bilhões / 50 milhões por mês |
| D1 armazenamento | 5 GB | 5 GB inclusos |
| Backup D1 (Time Travel) | 7 dias | 30 dias |

Uso estimado: o plugin faz 2 a 3 chamadas a cada 10 s (cerca de 26 mil requisições e 26 mil escritas de nonce por dia), mais o cron a cada 10 min (144 por dia) e o tráfego do site. Isso cabe no plano gratuito.

Limitações:
- No Free, passar do limite diário de D1 faz as consultas falharem até 00:00 UTC. Nesse caso, o webhook responde 500 e o Mercado Pago reenvia depois, e a conciliação também recupera os pedidos.
- Não medi o CPU real em produção. HMAC e SQL simples devem caber em 10 ms, mas confira em Workers → Métricas.
- **Recomendação:** começar os testes no Free e passar para o Paid (US$ 5/mês) antes de abrir vendas reais, pelos 30 dias de backup e para não depender de cota diária.
- Não verifiquei quantos Cron Triggers o plano Free permite por conta. Confira se o deploy reclamar.

## Configuração (passo a passo, modo de teste)

> Segredos **nunca** vão para o chat, o Git, o `config.yml` ou o site. Digite-os direto nos comandos abaixo, que perguntam o valor de forma interativa.

### 1. Mercado Pago (painel de desenvolvedor)

1. Em <https://www.mercadopago.com.br/developers/panel/app>, crie uma aplicação "Astral Loja", do tipo **Checkout Pro**.
2. Em **Contas de teste**, crie uma conta **vendedora** e uma **compradora**.
3. Entre no painel de desenvolvedor com a conta **vendedora de teste** e copie o **Access Token** das credenciais. Esse é o token de teste. Anote também o **User ID** dessa conta, que vai em `MP_RECEBEDOR_ID`.
4. Em **Webhooks → Configurar notificações**:
   - URL (modo de teste e produção): `https://astral-loja.3237049369557647.workers.dev/webhooks/mercadopago`
   - Evento: **Pagamentos**. Os outros eventos são aceitos e ignorados; reembolso e contestação chegam como atualização do pagamento.
   - Salve e copie a **assinatura secreta**, que vai em `MP_WEBHOOK_SECRET`.
   - O botão "Simular" do painel serve para conferir se a assinatura chega. A simulação usa um id que não existe, então o Worker responde 200 e registra `nao_encontrado`.

### 2. Cloudflare (no Mac, dentro de `astral-site/`)

```sh
npx wrangler d1 create astral-loja                       # copie o database_id para worker/wrangler.loja.jsonc
npx wrangler d1 migrations apply astral-loja -c worker/wrangler.loja.jsonc --remote
# em worker/wrangler.loja.jsonc: preencha MP_RECEBEDOR_ID com o User ID do vendedor de teste
npx wrangler secret put MP_ACCESS_TOKEN   -c worker/wrangler.loja.jsonc
npx wrangler secret put MP_WEBHOOK_SECRET -c worker/wrangler.loja.jsonc
openssl rand -hex 32                                     # gera o SERVIDOR_SEGREDO (copie, não cole em chat)
npx wrangler secret put SERVIDOR_SEGREDO  -c worker/wrangler.loja.jsonc
openssl rand -hex 16 | npx wrangler secret put IP_SAL -c worker/wrangler.loja.jsonc
npx wrangler deploy -c worker/wrangler.loja.jsonc
```

Depois do deploy, `https://astral-loja.3237049369557647.workers.dev/api/catalogo` deve listar os 7 pets, só o gato ativo e com `preco_de_teste: true`.

### 3. Site

Em `config.js`, defina `loja.apiUrl: "https://astral-loja.3237049369557647.workers.dev"`. Se o endereço for outro, troque também o `connect-src` do CSP em `loja.html`. A página **não** está no menu e tem `noindex`. Para testar em produção do Pages, basta abrir `astralmc.online/loja.html`.

### 4. Servidor na MagnoHost (pelo painel)

1. **Arquivos → plugins/**: envie `AstralLoja-0.1.0.jar` (gerado em `Astral/loja/target/`).
2. Reinicie pelo painel. O plugin cria `plugins/AstralLoja/config.yml` e avisa no console que está "sem conexão", o que é esperado.
3. Edite `plugins/AstralLoja/config.yml`: `api.url: "https://astral-loja.3237049369557647.workers.dev"`. Para os testes de teleporte sem pagar, deixe `permitir-teste-local: true` temporariamente.
4. Crie `plugins/AstralLoja/segredo.txt` com o **mesmo** valor do `SERVIDOR_SEGREDO`, numa linha só.
5. Reinicie. O console deve mostrar `Loja conectada a https://…`. `/loja estado` (equipe) mostra a última consulta.

O plugin é separado do `Astral` de propósito: pagamentos ficam isolados, ele atualiza e reinicia sem mexer no jar principal, e não depende da reconciliação pendente do repositório `Astral`. Se quiser, ele pode virar um módulo depois.

## Roteiro de teste ponta a ponta (modo de teste, gato)

Use uma conta original no jogo e a **compradora de teste** do Mercado Pago (aba anônima).

1. **Catálogo:** abra `astralmc.online/loja.html`. Deve aparecer a faixa "modo de teste", o gato a R$ 1,00 com "preço de teste" e os outros pets como "Em breve".
2. **Vinculação:** digite seu nick e entre no servidor. Em até 10 s aparece a janela "Loja" com o código, que também vai para o seu chat. Digite o código no site e veja "Conta vinculada".
   - Variações: código errado 5× (bloqueia); "Não fui eu" (o site mostra "recusado"); outro nick (o código não aparece para você).
3. **Compra:** clique em "Comprar" e pague com a compradora de teste: primeiro **Pix**, depois repita com outra conta usando **cartão de teste** (os cartões estão na documentação do Checkout Pro).
4. **Retorno:** a página mostra "Pagamento confirmado" só depois do webhook. Confira que **fechar a aba antes do retorno** não impede a entrega.
5. **Entrega online:** em até 10 s chega o aviso "Seu pet Gato chegou!" com [Meus pets], e o gato aparece atrás de você.
6. **Entrega offline:** saia do jogo, faça outra compra com outra conta vinculada (ou reembolse e recompre) e entre de novo. O pet deve estar lá.
7. **Comportamento cosmético:** tente alimentar, nomear, prender na guia, montar, bater, empurrar para o barco e levar ao portal; nada deve funcionar. Pise numa placa de pressão ou num sensor sculk com o gato junto: nada aciona. Com um creeper perto, ele não foge do gato. À noite, com phantoms, o gato some e volta quando eles vão embora.
8. **Seguir:** ande, corra e voe. Use teleporte da equipe e as magias de TPA e casas, entre e saia do Nether e do End, morra e renasça, entre em modo espectador e volte, saia e entre de novo. O gato deve sempre reaparecer ao seu lado, e só um.
9. **Trocar/guardar:** agache e clique no gato → "Guardar pet". Ao entrar de novo, aparece "Seus pets estão guardados [Meus pets]".
10. **Reinício:** reinicie o servidor pelo painel. O pet volta sem nova entrega (`/loja jogador <nick>` mostra a mesma versão), e não sobra gato no chão onde você estava.
11. **Servidor desligado:** desligue o servidor, pague um pedido e ligue de novo. A entrega chega depois do início.
12. **Reembolso:** no painel do vendedor de teste, reembolse o pagamento. O gato some do jogo e o site mostra "reembolsado". Faça uma nova compra e o pet volta.
13. **Notificação falsa:** `curl -X POST "https://…/webhooks/mercadopago?data.id=1&type=payment"` deve responder 401.

Consultas úteis: `npx wrangler d1 execute astral-loja -c worker/wrangler.loja.jsonc --remote --command "SELECT * FROM eventos_pagamento ORDER BY id DESC LIMIT 20"`.

## Abrir vendas reais

Só faça depois do roteiro acima passar:

1. Defina o preço: `UPDATE produtos SET preco_centavos = <valor>, preco_confirmado = 1, atualizado_em = unixepoch() WHERE id = 'pet_gato';`
2. Troque `MP_ACCESS_TOKEN` pelo token de **produção** da sua conta e `MP_RECEBEDOR_ID` pelo **seu** User ID.
3. No `wrangler.loja.jsonc`: `LOJA_MODO: "real"` e `LOJA_VENDAS_REAIS: "sim"`. Faça o deploy.
4. Revise o texto de "Como funciona" (reembolso em 7 dias, contestação) e ponha "Loja" no menu.

Para pausar sem desligar nada: `LOJA_PAUSADA: "sim"`, que bloqueia pedidos novos. Webhooks e entregas continuam funcionando.

## Pets futuros

O catálogo já tem raposa, axolote, Allay, abelha, sapo e coelho, desativados. Cada um precisa de código próprio no plugin antes de ativar, porque cada espécie tem comportamentos que dariam vantagem e precisam ser neutralizados:
- **Allay:** coleta itens.
- **Abelha:** poliniza plantações e ferroa.
- **Sapo:** come slimes e magma cubes e gera froglights.
- **Raposa:** pega itens e caça.
- **Axolote:** luta e precisa de água.
- **Coelho:** come cenouras.

O plugin recusa espécies não implementadas: a entrega volta com erro `produto_desconhecido_no_servidor` e fica na fila.
