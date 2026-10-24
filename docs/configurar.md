# Astral — site do servidor de Minecraft

Site estático em HTML/CSS/JavaScript, publicado no **GitHub Pages**.

- Apresentação do mundo, da comunidade e do RPG.
- Regras e instruções de acesso direto ao Minecraft.
- Endereço para copiar e status ao vivo via [mcsrvstat.us](https://mcsrvstat.us).
- Link para a comunidade no Fluxer.
- Download do modpack e tutoriais para Prism Launcher, SKlauncher e Modrinth App.

## Páginas

| Página | Arquivo | Conteúdo |
|---|---|---|
| Início | `index.html` | apresentação curta, vídeo, status e versão |
| Sobre | `sobre.html` | proposta, RPG, progressão narrativa e comunidade |
| Regras | `regras.html` | combinados ilustrados com cenas 8-bit |
| Ajuda de acesso | `jogar.html` | instruções para links diretos e guias da comunidade |
| Instalar o modpack | `instalar.html?launcher=prism` | guia do Prism; também aceita `sklauncher` e `modrinth` |

Todas usam `style.css`, `config.js` e `app.js`. A barra superior reúne Início,
Sobre e Regras. **Jogar abre uma janela para escolher o launcher**, com as três
opções e o link discreto **Continuar sem baixar o modpack**. Ao escolher um
launcher, o visitante abre seu tutorial e o navegador recebe o pedido de download.
A janela fecha pelo botão de fechar, Escape ou clique fora, e devolve o foco ao
link que a abriu. No celular, o botão Jogar permanece visível; os links da
navegação ficam no menu compacto. O IP e o botão de copiar aparecem na página
de acesso para quem escolhe continuar sem o modpack, com confirmação acessível.

## Configuração

Edite `config.js`:

| Campo | Conteúdo |
|---|---|
| `serverName` | nome do servidor |
| `serverAddress` | endereço do Minecraft |
| `serverVersion` | edição e versão exibidas |
| `modpack` | URL direta, nome do arquivo e versões do modpack, Minecraft e loader |
| `fluxerInviteUrl` | convite da comunidade, opcional |
| `rules` | regras da página Regras |
| `ruleCards` | título e ID da arte de cada regra, na mesma ordem de `rules` |
| `lore` | fragmentos da história e suas fontes |
| `memoryFragments` | trechos do livro interativo de Sobre |

A página Jogar explica o acesso para contas originais e para jogadores sem conta
premium. O cadastro e a autenticação são feitos pela **interface do nLogin dentro
do Minecraft**, seguindo as orientações exibidas na tela. As contas originais
reconhecidas têm acesso automático. O plugin é configurado no servidor Minecraft.

## Vídeo da página inicial

O filme **Astral - apenas começando** aparece entre a apresentação e o status,
com capa do YouTube, moldura nas cores do site e botão de play em pixel art.
O player é responsivo em 16:9 e só carrega o YouTube ao clicar na capa, usando
`youtube-nocookie.com`. O link **Ver no YouTube** fica sempre disponível; sem
JavaScript, a própria capa também abre o vídeo no YouTube.

Para trocar o vídeo, atualize o ID em `data-video-id`, o título em
`data-video-title`, a imagem da capa e os dois links em `index.html`.
A política de conteúdo dessa página permite o iframe de `youtube-nocookie.com`
e a capa de `i.ytimg.com`.

## Modpack e instalação

- `downloads/Astral.mrpack` é a cópia de distribuição do pacote de cliente.
  Mantém mods, configurações e recursos do pack, sem caches de execução,
  históricos, dados do jogador nem lista pessoal de servidores.
- `modpack` em `config.js` concentra `downloadUrl`, `fileName`, `version`,
  `minecraftVersion`, `loader` e `loaderVersion`. Confira esses valores no
  `modrinth.index.json` ao substituir o pacote.
- Os três launchers recebem o mesmo arquivo. `instalar.js` seleciona o guia
  conforme `?launcher=prism`, `?launcher=sklauncher` ou `?launcher=modrinth`.
  Sem uma escolha válida, a página mostra todos os guias.
- Os links da janela acrescentam `&download=1`. O tutorial consome esse parâmetro
  antes de solicitar o download, para que recarregar ou voltar não baixe novamente.
  Abrir um guia diretamente ou trocar de guia não dispara downloads.
- O arquivo é servido no próprio site e o link usa o atributo `download`, para
  manter o tutorial aberto. Se o navegador bloquear o início automático, o botão
  **Baixar modpack** permite repetir a tentativa.
- O guia do SKlauncher usa **4.0 beta**, cuja importação permite arrastar o
  `.mrpack` para a janela. Prism e Modrinth App pedem uma conta Microsoft com
  Minecraft Java; os respectivos passos informam isso.
- Sem JavaScript, Jogar leva à página de acesso; o download manual e todos os
  passos de instalação continuam disponíveis.
- Os logotipos oficiais dos launchers ficam em `marca/launchers/`, com as fontes
  e os créditos no README desse diretório. São imagens SVG locais, exibidas com
  suas proporções originais na janela de escolha e nos links dos guias.
- O último passo do tutorial orienta a entrar pelo botão Jogar do próprio
  modpack. O endereço fica em `jogar.html#conectar`, acessível pelo link para
  continuar sem baixar o pacote.

## Lore e movimento

A página Sobre apresenta a sobrevivência com base vanilla, o foco social, o RPG
e a progressão narrativa, com o livro interativo dos fragmentos da lore.

As nove ilustrações das regras ficam em **`artes/regras-8bit.svg`**. São cenas
locais em grade de 96 × 72, com paleta limitada e bordas de pixel. O campo `art`
de cada item de `ruleCards` corresponde ao ID de um símbolo desse SVG. O texto
completo de cada regra permanece em `rules`, também lido pelos guias do bot.

- `lore` e `memoryFragments` ficam em `config.js`.
- `style.css` cuida das animações e microinterações.
- A janela de launchers abre com fade e escala suaves, com os cartões entrando
  em sequência. A animação é repetida ao reabrir e respeita a opção de pausar
  animações e a preferência de movimento reduzido do sistema.
- `app.js` cuida do céu, do livro, das regras ilustradas, da cópia do IP e da
  preferência de movimento, além da janela de escolha do launcher.
- **Pausar animações**, no rodapé, guarda a escolha entre as páginas.
- A preferência de movimento reduzido do sistema é respeitada.
- O conteúdo principal continua visível com JavaScript desativado.

Os links relativos funcionam no domínio próprio e em `/astral-site/`. Os atalhos
`#sobre` e `#regras` na página inicial levam às páginas correspondentes;
`#status` permanece na página inicial. A escolha de launcher abre a página de
instalação; o link para continuar sem baixar leva a `jogar.html#conectar`.

## Publicação

No GitHub, configure **Settings → Pages → Deploy from a branch → `main` /
`(root)`**. As cinco páginas são servidas diretamente, sem etapa de build.

O arquivo `CNAME` configura o domínio **astralmc.online**. Registros DNS:

| Tipo | Nome | Valor |
|---|---|---|
| A | `@` | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` |
| AAAA | `@` | `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` |
| CNAME | `www` | `dvd-iso.github.io` |
| SRV | `_minecraft._tcp` | `0 5 25500 sp-13.magnohost.com.br` |

O SRV é usado pelo Minecraft. Depois da propagação do DNS, mantenha **Enforce
HTTPS** habilitado no GitHub Pages.

## Conteúdo do jogo e créditos

Construções, schematics, datapacks, itens, modelos, texturas, regiões e MOTDs
ficam no [AtlasHistoria](https://github.com/dvd-iso/AtlasHistoria), em
`construcoes/` e `marca/`. A imagem `marca/fluxer-icon.png` é usada pelo README
deste site; os textos públicos da lore ficam em `config.js`.

A fonte [Monocraft](https://github.com/IdreesInc/Monocraft), de Idrees Hassan,
usa a SIL Open Font License 1.1, disponível em `fonts/OFL.txt`.
