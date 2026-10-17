# Astral — site do servidor de Minecraft (instruções técnicas)

Site estático (HTML/CSS/JS puro) feito para rodar no **GitHub Pages**.

- Status ao vivo: online/offline, jogadores online, vagas e lista de quem está jogando (via [mcsrvstat.us](https://mcsrvstat.us)).
- Formulário de whitelist (nick, estilo de jogo, motivo), enviado para um canal do **Fluxer** por webhook, passando por um Cloudflare Worker que esconde o webhook e bloqueia spam.

## Páginas do site

| Página | Arquivo | Conteúdo |
|---|---|---|
| Início | `index.html` | apresentação, IP para copiar, status do servidor e atalhos |
| Sobre | `sobre.html` | base vanilla, RPG, progressão narrativa e comunidade |
| Regras | `regras.html` | lista completa de regras definida no `config.js` |
| Whitelist | `whitelist.html` | formulário de pedido de entrada |

Todas compartilham o visual de `style.css`, as configurações de `config.js` e o código comum de `app.js`.
O formulário e o captcha ficam em `whitelist.js`, carregado apenas na página de whitelist.
O menu indica a página atual e permanece acessível no celular.

A página **Sobre** apresenta a proposta do Astral: sobrevivência com base vanilla, foco social, RPG e
progressão narrativa. Explica os personagens interpretados ao vivo pela equipe, o Nether inicialmente
selado e as particularidades de Remendo e dos golens de ferro, para orientar também os projetos técnicos.
A paisagem em pixel art é uma ilustração dessa proposta, desenhada em SVG no próprio HTML; o botão
permite alternar entre noite e amanhecer.

### Lore e movimento

- Os fragmentos do site ficam em `lore` no `config.js` e devem se apoiar na história do servidor.
- O fragmento do rodapé descreve o Nether inicialmente selado; revise-o quando a história avançar.
- `memoryFragments` define o pequeno livro interativo de Sobre. Os textos foram selecionados dos
  fragmentos existentes e do `marca/motd-lore.txt`, agora no repositório
  [AtlasHistoria](https://github.com/dvd-iso/AtlasHistoria/blob/main/marca/motd-lore.txt);
  a troca acontece quando o visitante pede outro trecho.
- As anotações de contexto do mundo estão no `README.md`. O texto de apresentação não precisa revelar
  todos os acontecimentos da lore para comunicar a identidade do servidor.
- `style.css` cuida das órbitas, da paisagem, das entradas de seções e das microinterações.
- `app.js` cuida do céu, das estrelas cadentes, do livro, do amanhecer e do controle de movimento.
- **Pausar animações**, no rodapé, guarda a escolha para as outras páginas. A preferência de movimento
  reduzido do sistema também é respeitada. Com JavaScript desativado, o conteúdo continua visível.
- O céu limita a quantidade de estrelas, a resolução e a frequência de desenho, e para de animar quando
  a aba fica em segundo plano. O site usa apenas os recursos locais e as integrações já configuradas.

Os links são relativos, compatíveis tanto com o domínio próprio quanto com `/astral-site/` no GitHub Pages.
Links antigos para `#sobre`, `#regras` e `#whitelist` na página inicial levam às novas páginas;
`#status` continua apontando para o status no Início.
No formulário, as regras abrem em outra aba para preservar as respostas em preenchimento.

Para alterar o conteúdo de apresentação ou os menus, edite os arquivos HTML correspondentes.
Para mudar as regras, os dados do servidor ou as opções do formulário, continue usando `config.js`.

## 1. Configurar

Edite só o `config.js`:

| Campo | O que é |
|---|---|
| `serverAddress` | IP/endereço do servidor (ex: `jogar.astral.com`) |
| `serverVersion` | versão exibida (ex: `Java 26.3`) |
| `workerUrl` | URL do Cloudflare Worker (veja a seção 3) |
| `turnstileSiteKey` | Site key do captcha Turnstile (veja a seção 3) |
| `fluxerInviteUrl` | convite da comunidade (opcional) |
| `rules` | regras mostradas na página Regras |
| `lore` | fragmentos da lore espalhados pelo site (texto + fonte opcional) |
| `memoryFragments` | trechos do livro interativo na página Sobre |
| `playStyles` | opções de estilo de jogo |

> ⚠️ **Nunca coloque a URL do webhook no site.** Tudo que está no repositório e no GitHub Pages é público,
> e quem tem a URL pode mandar mensagens no canal à vontade. Ela fica só nos segredos do Worker.

### Criando o webhook no Fluxer
1. Crie um canal privado para a staff, ex: `#pedidos-whitelist`.
2. Configurações do canal → **Webhooks** → criar webhook (precisa da permissão *Gerenciar Webhooks*).
3. Copie a URL do webhook e guarde para o passo 6 da seção 3.

## 2. Publicar no GitHub Pages
1. Crie um repositório no GitHub (ex: `astral-site`) e envie estes arquivos.
2. No repositório: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**.
3. Em ~1 minuto o site fica em `https://SEU-USUARIO.github.io/astral-site/`.

O GitHub Pages serve os quatro arquivos HTML diretamente, sem etapa de build.

### Domínio próprio (astralmc.online)
O arquivo `CNAME` na raiz diz ao GitHub Pages que o site responde em `astralmc.online`
(o endereço `dvd-iso.github.io/astral-site` passa a redirecionar para lá). No DNS do domínio (Hostinger):

| Tipo | Nome | Valor |
|---|---|---|
| A | `@` | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (um registro para cada) |
| AAAA | `@` | `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` |
| CNAME | `www` | `dvd-iso.github.io` |
| SRV | `_minecraft._tcp` | `0 5 25500 sp-13.magnohost.com.br` (o do Minecraft; não mexa) |

Depois que o DNS propagar, marque **Enforce HTTPS** em Settings → Pages. O domínio também precisa estar em
`ALLOWED_ORIGINS` do Worker e na lista de domínios do widget do Turnstile.

## 3. Proteção anti-spam (Cloudflare Worker + captcha)

Num site estático, qualquer pessoa vê a URL do webhook no código e pode mandar spam.
A pasta `worker/` tem um intermediário que roda grátis na Cloudflare e:

- **esconde o webhook**: ele fica só na Cloudflare, nunca no site;
- verifica um **captcha** (Cloudflare Turnstile);
- limita a **1 pedido a cada 10 min por IP** e **1 pedido por dia por nick**;
- limita o total a **30 pedidos por hora** (ajustável);
- só aceita pedidos vindos do seu site, valida todos os campos e bloqueia `@everyone`, menções e links;
- se faltar algum segredo ou o KV, recusa tudo em vez de rodar sem proteção.

### Passo a passo
1. **Crie a conta:** crie uma conta grátis em https://dash.cloudflare.com.
2. **Crie o Worker:** vá em **Workers & Pages → Create → Create Worker**, dê o nome `astral-whitelist` e clique em **Deploy**. Depois clique em **Edit code**, apague o código de exemplo, cole o conteúdo de `worker/worker.js` e clique em **Deploy**. Anote a URL do Worker (ex: `https://astral-whitelist.SEU-USUARIO.workers.dev`).
3. **Crie o KV (memória dos limites):** em **Storage & Databases → KV → Create**, crie o namespace `astral-rate`. Depois, no Worker, vá em **Settings → Bindings → Add → KV namespace**, coloque o nome de variável `RATE_KV` e escolha `astral-rate`.
4. **Configure o captcha:** em **Turnstile → Add widget**, use os domínios `astralmc.online` e `dvd-iso.github.io` no modo *Managed*. Anote a **Site key** e a **Secret key**.
5. **Troque o webhook no Fluxer:** apague o webhook antigo (a URL dele ficou pública no histórico do GitHub) e crie um novo.
6. **Configure as variáveis do Worker:** em **Settings → Variables and Secrets**, adicione:

   | Nome | Tipo | Valor |
   |---|---|---|
   | `FLUXER_WEBHOOK_URL` | Secret | a URL do webhook **novo** |
   | `TURNSTILE_SECRET` | Secret | a Secret key do Turnstile |
   | `ALLOWED_ORIGINS` | Text | `https://astralmc.online,https://dvd-iso.github.io` |
   | `SERVER_NAME` | Text | `Astral` (opcional) |
   | `MAX_PER_HOUR` | Text | `30` (opcional) |

7. **Atualize o site:** no `config.js`, preencha `workerUrl` com a URL do Worker e `turnstileSiteKey` com a Site key.

Enquanto `workerUrl` e `turnstileSiteKey` estiverem vazios, o formulário avisa que o envio não foi configurado.

## Créditos

Fonte [Monocraft](https://github.com/IdreesInc/Monocraft), de Idrees Hassan, sob a SIL Open Font License 1.1 (`../fonts/OFL.txt`). Os arquivos em `fonts/` são um recorte com só os caracteres usados em português.

## Conteúdo do jogo

Construções, schematics, datapacks, itens, modelos, texturas, regiões do WorldGuard e os materiais de
MOTD ficam no [AtlasHistoria](https://github.com/dvd-iso/AtlasHistoria), em `construcoes/` e `marca/`.
As instruções e a origem da migração estão em
[docs/conteudo-servidor.md](https://github.com/dvd-iso/AtlasHistoria/blob/main/docs/conteudo-servidor.md).

Neste repositório, `marca/fluxer-icon.png` é a imagem usada pelo README. Os textos públicos da lore
exibidos pelo site são definidos no `config.js`.
