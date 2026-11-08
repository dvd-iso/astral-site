// Mural de apoiadores da página inicial: nicks agrupados pelo tier, do maior para o menor.
// Lista pública do Worker astral-loja (/api/apoiadores); quem escolheu se esconder na loja não aparece.
(() => {
  "use strict";
  const cfg = (window.ASTRAL_CONFIG && window.ASTRAL_CONFIG.loja) || {};
  const API = String(cfg.apiUrl || "").replace(/\/$/, "");
  const secao = document.querySelector("[data-supporters]");
  const lista = document.querySelector("[data-supporters-list]");
  const status = document.querySelector("[data-supporters-status]");
  const tentar = document.querySelector("[data-supporters-retry]");
  if (!secao || !lista || !status || !tentar) return;
  secao.hidden = false;
  let carregando = false;

  async function carregar() {
    if (carregando) return;
    carregando = true;
    secao.setAttribute("aria-busy", "true");
    status.textContent = "Carregando apoiadores…";
    lista.replaceChildren(); // Não conserva nicks de uma consulta anterior (alguém pode ter optado por se esconder).
    tentar.hidden = true;
    tentar.disabled = true;
    const abortar = new AbortController();
    const limite = setTimeout(() => abortar.abort(), 12000);
    try {
      if (!API) throw new Error("api_indisponivel");
      const r = await fetch(`${API}/api/apoiadores`, {credentials: "omit", cache: "no-store", signal: abortar.signal});
      if (!r.ok) throw new Error("mural_indisponivel");
      const {apoiadores} = await r.json();
      if (!Array.isArray(apoiadores) || apoiadores.some(a => !a || typeof a.nome !== "string" || !a.nome || typeof a.tier !== "string" || !a.tier)) {
        throw new Error("resposta_invalida");
      }
      if (!apoiadores.length) {
        status.textContent = "Ainda não há apoiadores públicos no mural.";
        return;
      }
      // Somente a lista pública recebida do Worker. Nada de fallback fictício, total privado ou cache local.
      const grupos = new Map();
      for (const a of apoiadores) {
        if (!grupos.has(a.tier)) grupos.set(a.tier, []);
        grupos.get(a.tier).push(a.nome);
      }
      let posicao = 0;
      for (const [tier, nomes] of grupos) {
        const grupo = document.createElement("div");
        grupo.className = `supporters-tier supporters-tier-${++posicao}`;
        const h = document.createElement("h3");
        h.innerHTML = '<svg class="pixel-star" aria-hidden="true"><use href="#star" /></svg>';
        h.append(document.createTextNode(`${tier} · ${nomes.length}`));
        const ul = document.createElement("ul");
        for (const nome of nomes) {
          const li = document.createElement("li");
          li.textContent = nome;
          ul.append(li);
        }
        grupo.append(h, ul);
        lista.append(grupo);
      }
      status.textContent = `${apoiadores.length} ${apoiadores.length === 1 ? "apoiador público" : "apoiadores públicos"} no mural.`;
    } catch {
      lista.replaceChildren();
      status.textContent = "Não foi possível carregar o mural agora. Tente novamente.";
      tentar.hidden = false;
    } finally {
      clearTimeout(limite);
      secao.setAttribute("aria-busy", "false");
      tentar.disabled = false;
      carregando = false;
    }
  }

  tentar.addEventListener("click", carregar);
  carregar();
})();
