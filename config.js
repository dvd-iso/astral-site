// ============================================================
//  CONFIGURAÇÃO DO SITE DO ASTRAL — edite só este arquivo
// ============================================================
window.ASTRAL_CONFIG = {
  // Nome exibido no site
  serverName: "Astral",

  // IP/endereço do servidor (com porta se não for 25565, ex: "jogar.astral.com:25570")
  serverAddress: "astralmc.online",

  // Versão exibida no site
  serverVersion: "Java 26.3",

  // Pacote compartilhado pelos launchers e pelo Astral Installer.
  // Ao trocar o arquivo, atualize também as versões conforme modrinth.index.json.
  modpack: {
    downloadUrl: "downloads/Astral.mrpack?v=2.0",
    fileName: "Astral 2.0.mrpack",
    version: "1.0.0",
    minecraftVersion: "26.3",
    loader: "Fabric",
    loaderVersion: "0.19.5",
  },

  // Atualize estes dois valores quando publicar uma nova versão do aplicativo.
  // Atualizações do modpack são publicadas no channel/stable.json do instalador.
  installer: {
    version: "1.2.2",
    downloadBaseUrl: "https://github.com/dvd-iso/astral-installer/releases/download/v1.2.2/",
    releasesUrl: "https://github.com/dvd-iso/astral-installer/releases/latest",
  },

  // Link de convite da comunidade no Fluxer (opcional, deixe "" para esconder o botão)
  fluxerInviteUrl: "https://fluxer.gg/9LVGkUy6",

  // Fragmentos da lore usados nas páginas e no livro interativo.
  // "fonte" é opcional.
  lore: [
    { texto: "Um novo Sonhador desperta. O mundo se lembra de você agora.", fonte: "a Invocação" },
    { texto: "Antes de você existir, alguém doou um pouco de si. Você é feito da memória de outros Sonhadores.", fonte: "um sonho" },
    { texto: "Só os Sonhadores podem moldar a realidade. Que história você vai deixar no mundo?", fonte: "um sonho" },
    { texto: "O fluxo de magia está instável. O portal não responde." },
  ],

  // Fragmentos do livro interativo em Sobre, retirados da lore já usada no servidor.
  // A troca é manual: o visitante escolhe quando descobrir outro fragmento.
  memoryFragments: [
    { texto: "Alguém adoraria ver o que você vai construir.", fonte: "um sonho" },
    { texto: "Uma pequena luz azul canta perto de você. Ela se lembra de alguém que foi bom.", fonte: "um sonho" },
    { texto: "Uma vila se lembra de quem a protegeu.", fonte: "lembrança das vilas" },
    { texto: "Um novo Sonhador desperta. O mundo se lembra de você agora.", fonte: "a Invocação" },
  ],

  // Regras mostradas na página Regras (uma por linha, na ordem)
  rules: [
    "Respeito acima de tudo: nada de ofensas, preconceito ou assédio, no jogo e no Fluxer.",
    "Nada de grief, roubo ou destruir o que é dos outros sem combinar antes.",
    "Proibido hack, x-ray, auto-clicker ou qualquer mod que dê vantagem. Mods visuais e de desempenho podem.",
    "Não use bugs nem duplicação de itens. Achou um? Avise a staff.",
    "Respeite o espaço dos outros: construa a uma boa distância das bases alheias.",
    "PvP só com o consentimento dos dois lados ou dentro de eventos.",
    "Seu personagem pode fazer escolhas boas ou ruins. Conflitos de RPG com outros jogadores exigem acordo prévio e respeito às regras da comunidade.",
    "Sem spam, propaganda ou divulgação de outros servidores.",
    "A palavra final é da staff. Algum problema? Fale com a gente no Fluxer.",
  ],

  // Títulos e cenas 8-bit, na mesma ordem das regras acima.
  ruleCards: [
    { title: "Respeito vem primeiro", art: "respeito" },
    { title: "Cuide do que é dos outros", art: "construcoes" },
    { title: "Jogue limpo", art: "jogo-justo" },
    { title: "Encontrou um bug? Avise", art: "bugs" },
    { title: "Dê espaço para as bases", art: "espaco" },
    { title: "PvP só combinado", art: "pvp" },
    { title: "Interprete com respeito", art: "rpg" },
    { title: "Conversa sem spam", art: "spam" },
    { title: "Conte com a equipe", art: "equipe" },
  ],
};
