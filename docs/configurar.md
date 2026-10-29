# Configurar e publicar o site

[← Voltar ao README](../README.md)

Site estático em HTML/CSS/JavaScript, publicado no **GitHub Pages**.

- Apresentação do mundo, da comunidade e do RPG.
- Regras e instruções de acesso direto ao Minecraft.
- Endereço para copiar e status ao vivo via [mcsrvstat.us](https://mcsrvstat.us).
- Link para a comunidade no Discord.
- Astral Installer para Windows, macOS e Linux, que instala e atualiza o modpack no Minecraft Launcher, SKlauncher 4, Prism ou Modrinth App.

## Páginas

| Página | Arquivo | Conteúdo |
|---|---|---|
| Início | `index.html` | apresentação curta, vídeo, status e versão |
| Sobre | `sobre.html` | proposta, RPG, progressão narrativa e comunidade |
| Regras | `regras.html` | combinados ilustrados com cenas 8-bit |
| Ajuda de acesso | `jogar.html` | instruções para links diretos e guias da comunidade |
| Instalar o modpack | `instalar.html` | comando de instalação para o sistema do visitante e passo a passo |
| Privacidade | `privacidade.html` | política de privacidade do site, do servidor e do instalador |

Todas usam `style.css`, `config.js` e `app.js`. A barra superior reúne Início,
Sobre e Regras. **Jogar abre uma janela para baixar o Astral Installer**, com o
botão principal já apontando para o sistema detectado
e o link para os outros sistemas. Não há opção de seguir sem o modpack na janela
nem na página de instalação. Ao clicar no download, a janela mostra os próximos passos.
A janela fecha pelo botão de fechar, Escape ou clique fora, e devolve o foco ao
link que a abriu. No celular, o botão Jogar permanece visível; os links da
navegação ficam no menu compacto, e a janela orienta abrir a página no computador.

## Configuração

Edite `config.js`:

| Campo | Conteúdo |
|---|---|
| `serverName` | nome do servidor |
| `serverAddress` | endereço do Minecraft |
| `serverVersion` | edição e versão exibidas |
| `modpack` | URL direta, nome do arquivo e versões do modpack, Minecraft e loader |
| `installer` | canal do modpack (versões e link do `.mrpack`) |
| `discordInviteUrl` | convite da comunidade no Discord, opcional |
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

- O modpack é instalado por um comando no terminal, que abre o instalador do
  Astral: `irm https://astralmc.online/instalar.ps1 | iex` no Windows e
  `curl -fsSL https://astralmc.online/instalar.sh | sh` no macOS e no Linux.
  O código, os builds e o canal de atualização estão em
  [dvd-iso/astral-installer](https://github.com/dvd-iso/astral-installer).
- `instalar.sh` e `instalar.ps1`, na raiz do site, são **cópias** dos arquivos do
  repositório do instalador. Ao mudar um deles lá, copie-o para cá. O CI do
  instalador confere que a cópia do site está igual. No `.ps1`, os textos ficam
  só em ASCII.
- `app.js` detecta o sistema pelo navegador e mostra o comando correspondente,
  com o botão **Copiar**, em `instalar.html` e no diálogo **Jogar**. Sem
  JavaScript, `instalar.html` mostra os três comandos.
- Novas versões do modpack são publicadas no repositório do instalador, anexando o
  `.mrpack` a uma release (veja o README dele). A página de instalação lê do canal
  (`installer.channelUrl`) as versões do pack e o link do `.mrpack` atual; os
  valores de `modpack` em `config.js` ficam como reserva se o canal não responder.
- `downloads/Astral.mrpack` continua sendo a cópia de distribuição do Astral 2.0.
  `modpack` em `config.js` guarda as versões de reserva da página; confira esses
  valores no `modrinth.index.json` ao substituir o pacote.
- Sem JavaScript, Jogar leva à página de acesso e `instalar.html` mostra os três comandos.
- Os logotipos dos launchers ficam em `marca/launchers/`, com as fontes e os
  créditos no README desse diretório.
- O último passo do tutorial orienta a entrar pelo botão Jogar do próprio modpack.

## Lore e movimento

A página Sobre apresenta a sobrevivência com base vanilla, o foco social, o RPG
e a progressão narrativa, com o livro interativo dos fragmentos da lore.

As nove ilustrações das regras ficam em **`artes/regras-8bit.svg`**. São cenas
locais em grade de 96 × 72, com paleta limitada e bordas de pixel. O campo `art`
de cada item de `ruleCards` corresponde ao ID de um símbolo desse SVG. O texto
completo de cada regra permanece em `rules`, também lido pelos guias do bot.

- `lore` e `memoryFragments` ficam em `config.js`.
- `style.css` cuida das animações e microinterações.
- A janela do instalador abre com fade e escala suaves, com o conteúdo entrando
  em sequência. A animação é repetida ao reabrir e respeita a opção de pausar
  animações e a preferência de movimento reduzido do sistema.
- `app.js` cuida do céu, do livro, das regras ilustradas, da cópia do IP e da
  preferência de movimento, além da janela de download do instalador.
- **Pausar animações**, no rodapé, guarda a escolha entre as páginas.
- A preferência de movimento reduzido do sistema é respeitada.
- O conteúdo principal continua visível com JavaScript desativado.

Os links relativos funcionam no domínio próprio e em `/astral-site/`. Os atalhos
`#sobre` e `#regras` na página inicial levam às páginas correspondentes;
`#status` permanece na página inicial. O link de outros sistemas abre a página de
instalação do Astral Installer.

## Publicação

No GitHub, configure **Settings → Pages → Deploy from a branch → `main` /
`(root)`**. As páginas são servidas diretamente, sem etapa de build.

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
ficam no repositório privado `dvd-iso/astral-plugin`, em `construcoes/` e
`marca/`. A imagem `marca/fluxer-icon.png` é usada nas anotações de
`docs/anotacoes.md`; os textos públicos da lore ficam em `config.js`.

A fonte [Monocraft](https://github.com/IdreesInc/Monocraft), de Idrees Hassan,
usa a SIL Open Font License 1.1, disponível em `fonts/OFL.txt`.
