<div align="center">

<img src="favicon.svg" width="80" alt="Estrela do Astral">

# Astral — site oficial

**O site do servidor de Minecraft [Astral](https://astralmc.online): apresentação, regras, como entrar e o instalador do modpack.**

[![Site](https://img.shields.io/website?url=https%3A%2F%2Fastralmc.online&label=astralmc.online&up_message=no%20ar&down_message=fora%20do%20ar)](https://astralmc.online)
![HTML · CSS · JS](https://img.shields.io/badge/HTML%20%C2%B7%20CSS%20%C2%B7%20JS-sem%20build-8b5cf6)
[![Licença MIT](https://img.shields.io/badge/c%C3%B3digo-MIT-blue)](LICENSE)

[**Acessar o site**](https://astralmc.online) · [Páginas](#-páginas) · [Rodar localmente](#-rodar-localmente) · [Configurar](#%EF%B8%8F-configurar) · [Privacidade](https://astralmc.online/privacidade.html)

</div>

---

## 🌌 O que é

Um site **estático** (HTML, CSS e JavaScript puros, sem etapa de build), publicado no **GitHub Pages** em [astralmc.online](https://astralmc.online).

- Apresenta o mundo, a comunidade e o RPG do Astral.
- Mostra o **status do servidor ao vivo** e o endereço para copiar.
- Mostra o comando de instalação do **[modpack](https://github.com/dvd-iso/astral-installer)**, que prepara o Astral no launcher do jogador.
- Funciona sem JavaScript, respeita **movimento reduzido** e é responsivo.

## 📄 Páginas

| Página | Arquivo | Conteúdo |
| --- | --- | --- |
| Início | `index.html` | Apresentação, vídeo, status e versão |
| Sobre | `sobre.html` | Proposta, RPG, progressão e o livro de fragmentos da lore |
| Regras | `regras.html` | Os combinados, ilustrados em cenas 8-bit |
| Como entrar | `jogar.html` | Endereço do servidor e login pelo nLogin |
| Instalar | `instalar.html` | Comando de instalação para o sistema do visitante e passo a passo |
| Privacidade | `privacidade.html` | Política de privacidade do site, do servidor e do instalador |
| Publicar modpack | `publicar-modpack.html` | Atalho da equipe para lançar uma versão nova do pack |

## 💻 Rodar localmente

Não há dependências. Sirva a pasta com qualquer servidor estático:

```sh
python3 -m http.server 8000
```

E abra <http://localhost:8000>.

## ⚙️ Configurar

Quase tudo se ajusta em **`config.js`**: nome e endereço do servidor, versão, canal do modpack, Discord, regras e trechos da lore.

| Campo | Para |
| --- | --- |
| `serverName`, `serverAddress`, `serverVersion` | Nome, endereço e versão exibidos |
| `installer` | Canal do modpack, de onde vêm as versões e o link do `.mrpack` |
| `modpack` | Valores de reserva do modpack, caso o canal do instalador não responda |
| `discordInviteUrl` | Convite do Discord (`""` esconde os botões) |
| `rules`, `ruleCards` | Texto e arte de cada regra |
| `lore`, `memoryFragments` | Fragmentos da história |

O guia completo — vídeo, modpack, animações, domínio e DNS — está em **[docs/configurar.md](docs/configurar.md)**.

## 🗂️ Estrutura

```text
*.html           Páginas
style.css        Visual e animações
app.js           Céu estrelado, status, livro, regras, cópia do IP e janela do instalador
config.js        Configuração do site
artes/           Ilustrações 8-bit das regras
fonts/           Fonte Monocraft (OFL)
marca/           Ícones e logotipos dos launchers
downloads/       Cópia de distribuição do modpack
docs/            Guias
```

## 🚀 Publicação

Todo push na `main` é publicado automaticamente pelo GitHub Pages (**Settings → Pages → Deploy from a branch → `main` / `(root)`**). O arquivo `CNAME` aponta para **astralmc.online**.

## 🔒 Privacidade

O site **não usa cookies, rastreamento nem anúncios**. Ele só consulta o status do servidor no mcsrvstat.us e carrega o YouTube quando o visitante clica no vídeo. A política completa — que também cobre o servidor e o instalador — está em **[astralmc.online/privacidade.html](https://astralmc.online/privacidade.html)**.

## 📜 Licença

- **Código** (HTML, CSS e JavaScript): [licença MIT](LICENSE).
- **Conteúdo e marca** — nome e logotipo do Astral, textos, lore, regras e ilustrações em `artes/` e `marca/`: todos os direitos reservados. Não reutilize sem autorização.
- **Fonte** [Monocraft](https://github.com/IdreesInc/Monocraft), de Idrees Hassan: SIL Open Font License 1.1 (`fonts/OFL.txt`).
- **Logotipos dos launchers** pertencem aos seus titulares; créditos em [`marca/launchers/README.md`](marca/launchers/README.md).

<sub>Minecraft é marca da Mojang/Microsoft. O Astral não é afiliado à Mojang nem à Microsoft.</sub>

<div align="center"><sub><a href="docs/anotacoes.md">·</a></sub></div>
