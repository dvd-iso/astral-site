// Abre o formulário de release do instalador com uma tag nova e válida já preenchida.
(() => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const tag = `modpack-${date}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const url = new URL("https://github.com/dvd-iso/astral-installer/releases/new");
  url.searchParams.set("tag", tag);
  url.searchParams.set("title", `Modpack ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`);
  const link = document.getElementById("abrirGithub");
  link.href = url.href;
  document.getElementById("tagModpack").textContent = tag;
  location.replace(url.href);
})();
