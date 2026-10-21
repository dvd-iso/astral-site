# Astral — site do servidor de Minecraft

Site estático em HTML/CSS/JavaScript, publicado no **GitHub Pages**.

- Apresentação do mundo, da comunidade e do RPG.
- Regras e instruções de acesso direto ao Minecraft.
- Endereço para copiar e status ao vivo via [mcsrvstat.us](https://mcsrvstat.us).
- Link para a comunidade no Fluxer.

## Páginas

| Página | Arquivo | Conteúdo |
|---|---|---|
| Início | `index.html` | apresentação curta, status e versão |
| Sobre | `sobre.html` | proposta, RPG, progressão narrativa e comunidade |
| Regras | `regras.html` | combinados ilustrados com cenas 8-bit |
| Ajuda de acesso | `jogar.html` | instruções para links diretos e guias da comunidade |

Todas usam `style.css`, `config.js` e `app.js`. A barra superior reúne Início,
Sobre e Regras. **Jogar é um botão de copiar o IP**: no desktop, revela o endereço
ao receber hover ou foco pelo teclado. No celular, o botão Jogar permanece
visível e copia com um toque; Início, Sobre, Regras e Fluxer ficam no menu
compacto. O menu fecha ao escolher um link, tocar fora ou usar Escape. A
confirmação da cópia aparece no botão e em um aviso acessível. A página de ajuda
continua disponível para os links dos guias.

## Configuração

Edite `config.js`:

| Campo | Conteúdo |
|---|---|
| `serverName` | nome do servidor |
| `serverAddress` | endereço do Minecraft |
| `serverVersion` | edição e versão exibidas |
| `fluxerInviteUrl` | convite da comunidade, opcional |
| `rules` | regras da página Regras |
| `ruleCards` | título e ID da arte de cada regra, na mesma ordem de `rules` |
| `lore` | fragmentos da história e suas fontes |
| `memoryFragments` | trechos do livro interativo de Sobre |

A página Jogar explica o acesso para contas originais e para jogadores sem conta
premium. O nLogin é instalado e configurado no servidor Minecraft.

## Lore e movimento

A página Sobre apresenta a sobrevivência com base vanilla, o foco social, o RPG
e a progressão narrativa, com o livro interativo dos fragmentos da lore.

As nove ilustrações das regras ficam em **`artes/regras-8bit.svg`**. São cenas
locais em grade de 96 × 72, com paleta limitada e bordas de pixel. O campo `art`
de cada item de `ruleCards` corresponde ao ID de um símbolo desse SVG. O texto
completo de cada regra permanece em `rules`, também lido pelos guias do bot.

- `lore` e `memoryFragments` ficam em `config.js`.
- `style.css` cuida das animações e microinterações.
- `app.js` cuida do céu, do livro, das regras ilustradas, da cópia do IP e da
  preferência de movimento.
- **Pausar animações**, no rodapé, guarda a escolha entre as páginas.
- A preferência de movimento reduzido do sistema é respeitada.
- O conteúdo principal continua visível com JavaScript desativado.

Os links relativos funcionam no domínio próprio e em `/astral-site/`. Os atalhos
`#sobre` e `#regras` na página inicial levam às páginas correspondentes;
`#status` permanece na página inicial. O botão Jogar não troca de página.

## Publicação

No GitHub, configure **Settings → Pages → Deploy from a branch → `main` /
`(root)`**. As quatro páginas são servidas diretamente, sem etapa de build.

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
