# Modpack do Astral

`Astral.mrpack` é a cópia de distribuição do **Astral 2.0**, usada pelos três
guias de instalação e baixada como `Astral 2.0.mrpack`.

O **[Astral Installer](https://github.com/dvd-iso/astral-installer)** também usa
esse pacote para instalar e atualizar o modpack no Minecraft Launcher oficial.
O canal dele fica em `channel/stable.json` no repositório do instalador. Ao trocar
o pacote, publique o novo arquivo e atualize também esse canal com
`npm run pack:publish`; tamanho e SHA-512 precisam corresponder ao download.

- Versão no manifesto do pack: **1.0.0**.
- Minecraft: **26.3**.
- Fabric Loader: **0.19.5**.
- A cópia de distribuição mantém o manifesto dos mods, as configurações, os
  resource packs, as opções e o ícone. Caches de execução, dados do jogador,
  históricos, backups e a lista pessoal de servidores ficam fora do download.

Ao publicar uma nova versão, substitua o arquivo e atualize `modpack` em
`../config.js`. Atualize também o parâmetro de versão da URL e o link em
`../instalar.html` para evitar o download de uma cópia antiga em cache. Mantenha
a URL no próprio site para que o download possa começar sem tirar o visitante
do tutorial.
