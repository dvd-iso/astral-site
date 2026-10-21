(() => {
  const launchers = new Map([
    ["prism", "Prism Launcher"],
    ["sklauncher", "SKlauncher"],
    ["modrinth", "Modrinth App"],
  ]);
  const url = new URL(location.href);
  const launcher = url.searchParams.get("launcher");
  const name = launchers.get(launcher);
  const downloadRequested = url.searchParams.get("download") === "1";

  // Consome o pedido antes de baixar: recarregar ou voltar não repete o download.
  if (url.searchParams.has("download")) {
    url.searchParams.delete("download");
    history.replaceState(history.state, "", url);
  }
  if (!name) return;

  document.title = `Instalar no ${name} — ${window.ASTRAL_CONFIG.serverName}`;
  document.querySelector("[data-launcher-name]").textContent = `no ${name}.`;
  document.querySelectorAll("[data-launcher-guide]").forEach((guide) => {
    guide.hidden = guide.dataset.launcherGuide !== launcher;
  });
  document.querySelectorAll("[data-launcher-tab]").forEach((link) => {
    if (link.dataset.launcherTab === launcher) link.setAttribute("aria-current", "page");
  });

  // O arquivo é servido no mesmo domínio; o atributo download mantém o guia aberto.
  // O botão fica disponível para repetir a tentativa se o navegador bloquear.
  if (downloadRequested) {
    document.getElementById("downloadStatus").textContent = "O download do modpack foi solicitado. Se não começar, clique em Baixar modpack.";
    document.querySelector("[data-modpack-download]").click();
  }
})();
