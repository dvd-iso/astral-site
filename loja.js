// Loja de pets: vinculação pelo código do jogo, catálogo e ida ao Checkout Pro.
// Preço e produto são decididos pelo Worker; esta página só manda o id do produto.
// Nada aqui libera pet: a volta do Mercado Pago apenas mostra o andamento do pedido.
(() => {
  "use strict";
  const cfg = (window.ASTRAL_CONFIG && window.ASTRAL_CONFIG.loja) || {};
  const API = String(cfg.apiUrl || "").replace(/\/$/, "");
  const $ = s => document.querySelector(s);
  const passos = [...document.querySelectorAll("[data-step]")];
  const erroEl = $("[data-error]");
  const CHAVE_SESSAO = "astral-loja-sessao";
  const CHAVE_VINCULO = "astral-loja-vinculo";
  let catalogo = [];
  let catalogoFalhou = false;
  let conta = null;
  let espera = null;

  const MENSAGENS = {
    nome_invalido: "Nick inválido: use de 3 a 16 letras, números ou _.",
    muitas_tentativas: "Muitas tentativas. Espere alguns minutos e tente de novo.",
    codigo_incorreto: "Código incorreto.",
    vinculo_bloqueado: "Código errado vezes demais. Comece de novo.",
    vinculo_expirado: "O pedido expirou. Comece de novo.",
    vinculo_recusado: "O pedido foi recusado dentro do jogo.",
    ja_possui: "Você já tem este item.",
    apoio_em_disputa: "Um apoio seu está em contestação. Espere a decisão para subir de tier.",
    vendas_reais_desativadas: "As vendas ainda não estão abertas.",
    preco_nao_confirmado: "As vendas ainda não estão abertas.",
    loja_pausada: "A loja está pausada no momento.",
    loja_nao_configurada: "A loja está em preparação.",
    produto_indisponivel: "Este pet ainda não está disponível.",
    checkout_indisponivel: "Não foi possível abrir o pagamento agora. Tente de novo em instantes.",
    sessao_invalida: "Sua sessão expirou. Vincule a conta de novo.",
  };

  function mostrar(passo) { passos.forEach(p => { p.hidden = p.dataset.step !== passo; }); }

  function erro(codigo, extra) {
    if (!codigo) { erroEl.hidden = true; erroEl.textContent = ""; return; }
    let t = MENSAGENS[codigo] || "Algo deu errado. Tente de novo.";
    if (codigo === "codigo_incorreto" && extra && typeof extra.restantes === "number") t += ` Restam ${extra.restantes} tentativa(s).`;
    erroEl.textContent = t;
    erroEl.hidden = false;
  }

  async function api(caminho, {metodo = "GET", corpo, headers = {}} = {}) {
    const sessao = localStorage.getItem(CHAVE_SESSAO);
    const h = {...headers};
    if (sessao) h.Authorization = `Bearer ${sessao}`;
    if (corpo) h["Content-Type"] = "application/json";
    const r = await fetch(API + caminho, {method: metodo, headers: h, body: corpo ? JSON.stringify(corpo) : undefined, credentials: "omit"});
    let dados = {};
    try { dados = await r.json(); } catch { /* sem corpo */ }
    if (!r.ok) {
      if (r.status === 401 && sessao) { localStorage.removeItem(CHAVE_SESSAO); conta = null; }
      const e = new Error(dados.erro || `http_${r.status}`);
      e.codigo = dados.erro; e.dados = dados;
      throw e;
    }
    return dados;
  }

  const reais = c => (c / 100).toLocaleString("pt-BR", {style: "currency", currency: "BRL"});

  /** O maior tier de apoio ativo da conta (cada tier inclui os anteriores), ou null. */
  function apoioAtual() {
    const ativos = new Set((conta?.direitos || []).filter(d => d.estado === "ativo").map(d => d.produto_id));
    return catalogo.filter(p => p.tipo === "apoio" && ativos.has(p.id)).sort((a, b) => b.preco_centavos - a.preco_centavos)[0] || null;
  }

  function desenharApoio() {
    const grade = $("[data-apoio]");
    if (!grade || catalogoFalhou) return;
    grade.replaceChildren();
    const atual = apoioAtual();
    const temSuspenso = (conta?.direitos || []).some(d => d.estado === "suspenso" && String(d.produto_id).startsWith("apoio_"));
    const tiers = catalogo.filter(p => p.tipo === "apoio" && p.ativo);
    $("[data-apoio-secao]").hidden = !tiers.length;
    for (const p of tiers) {
      const card = document.createElement("article");
      card.className = "feature shop-card tier-card" + (atual && atual.id === p.id ? " is-mine" : "");
      const topo = document.createElement("div");
      topo.className = "tier-top";
      topo.innerHTML = '<svg class="pixel-star tier-star" aria-hidden="true"><use href="#star" /></svg>';
      const valor = document.createElement("p");
      valor.className = "tier-value";
      valor.textContent = reais(p.preco_centavos);
      topo.append(valor);
      const h = document.createElement("h3");
      h.textContent = p.nome;
      const lista = document.createElement("ul");
      lista.className = "tier-perks";
      for (const linha of String(p.descricao).split(/\.\s+|\.$/).filter(Boolean)) {
        const li = document.createElement("li");
        li.textContent = linha.trim() + ".";
        lista.append(li);
      }
      card.append(topo, h, lista);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      const jaTem = atual ? atual.preco_centavos : 0;
      if (atual && jaTem >= p.preco_centavos) { btn.textContent = atual.id === p.id ? "Seu tier" : "Incluído no seu"; btn.disabled = true; }
      else if (temSuspenso) { btn.textContent = "Em análise"; btn.disabled = true; }
      else if (!p.a_venda) { btn.textContent = "Indisponível"; btn.disabled = true; }
      else if (!conta) { btn.textContent = "Vincule a conta"; btn.disabled = true; }
      else {
        btn.textContent = jaTem ? `Subir por ${reais(p.preco_centavos - jaTem)}` : "Apoiar";
        btn.addEventListener("click", () => comprar(p.id, btn));
      }
      card.append(btn);
      grade.append(card);
    }
  }

  function desenharCatalogo() {
    desenharApoio();
    const grade = $("[data-catalog]");
    if (catalogoFalhou) return; // mantém a mensagem de erro
    grade.replaceChildren();
    const meus = new Set((conta?.direitos || []).filter(d => d.estado === "ativo").map(d => d.produto_id));
    for (const p of catalogo.filter(p => p.tipo !== "apoio")) {
      const card = document.createElement("article");
      card.className = "feature shop-card" + (p.ativo ? "" : " is-soon");
      const foto = document.createElement("div");
      foto.className = "shop-pet";
      const img = document.createElement("img");
      img.src = `artes/pets/${p.id}.png`;
      img.alt = `${p.nome} em 3D`;
      img.width = 512; img.height = 512;
      img.loading = "lazy"; img.decoding = "async";
      img.addEventListener("error", () => foto.remove());
      foto.append(img);
      card.append(foto);
      const h = document.createElement("h3");
      h.textContent = p.nome;
      const d = document.createElement("p");
      d.textContent = p.descricao;
      const preco = document.createElement("p");
      preco.className = "shop-price";
      preco.textContent = p.ativo ? reais(p.preco_centavos) : "Em breve";
      if (p.ativo && p.preco_de_teste) {
        const b = document.createElement("span");
        b.className = "badge";
        b.textContent = "preço de teste";
        preco.append(" ", b);
      }
      card.append(h, d, preco);
      if (p.ativo) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn";
        if (meus.has(p.id)) { btn.textContent = "Já é seu"; btn.disabled = true; }
        else if (!p.a_venda) { btn.textContent = "Indisponível"; btn.disabled = true; }
        else if (!conta) { btn.textContent = "Vincule a conta"; btn.disabled = true; }
        else { btn.textContent = "Comprar"; btn.addEventListener("click", () => comprar(p.id, btn)); }
        card.append(btn);
      }
      grade.append(card);
    }
  }

  async function comprar(produtoId, btn) {
    erro(null);
    btn.disabled = true;
    btn.textContent = "Abrindo pagamento…";
    try {
      const r = await api("/api/pedidos", {metodo: "POST", corpo: {produto_id: produtoId}});
      const url = new URL(r.checkout_url);
      if (url.protocol !== "https:" || !/(^|\.)mercadopago\.com(\.br)?$/.test(url.hostname)) throw new Error("checkout_indisponivel");
      location.assign(url.href);
    } catch (e) {
      erro(e.codigo || "checkout_indisponivel");
      btn.disabled = false;
      btn.textContent = "Comprar";
    }
  }

  async function carregarConta() {
    if (!localStorage.getItem(CHAVE_SESSAO)) { conta = null; return; }
    try { conta = await api("/api/conta"); } catch { conta = null; }
  }

  function mostrarConta() {
    if (conta) {
      $("[data-account-name]").textContent = conta.jogador.nome;
      const ehApoio = d => String(d.produto_id).startsWith("apoio_");
      const meus = conta.direitos.filter(d => d.estado === "ativo" && !ehApoio(d)).map(d => d.nome);
      const tier = apoioAtual();
      const suspensos = conta.direitos.filter(d => d.estado === "suspenso").map(d => d.nome);
      $("[data-owned]").textContent = (meus.length ? `Seus pets: ${meus.join(", ")}.` : "Você ainda não tem pets.")
        + (tier ? ` Apoio: ${tier.nome}.` : "")
        + (suspensos.length ? ` Suspensos por contestação: ${suspensos.join(", ")}.` : "");
      mostrar("conta");
    } else if (sessionStorage.getItem(CHAVE_VINCULO)) {
      retomarVinculo();
    } else {
      mostrar("nick");
    }
  }

  // ---------- vinculação ----------

  function pararEspera() { if (espera) { clearTimeout(espera); espera = null; } }

  function vinculoAtual() {
    try { return JSON.parse(sessionStorage.getItem(CHAVE_VINCULO) || "null"); } catch { return null; }
  }

  function cancelarVinculo() {
    pararEspera();
    sessionStorage.removeItem(CHAVE_VINCULO);
    erro(null);
    mostrar("nick");
  }

  async function retomarVinculo() {
    const v = vinculoAtual();
    if (!v) return mostrar("nick");
    $("[data-nick]").textContent = v.nome;
    try {
      const r = await api(`/api/vinculos/${v.id}`, {headers: {"X-Vinculo-Segredo": v.segredo}});
      if (r.estado === "aguardando_jogo") { mostrar("aguardando"); espera = setTimeout(retomarVinculo, 3000); }
      else if (r.estado === "codigo_exibido") { if ($("[data-step=codigo]").hidden) { mostrar("codigo"); $("#shopCode").focus(); } }
      else { cancelarVinculo(); erro("vinculo_" + r.estado); }
    } catch (e) {
      cancelarVinculo();
      erro(e.codigo || "vinculo_expirado");
    }
  }

  $("[data-step=nick]").addEventListener("submit", async ev => {
    ev.preventDefault();
    erro(null);
    const nome = $("#shopNick").value.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nome)) return erro("nome_invalido");
    try {
      const r = await api("/api/vinculos", {metodo: "POST", corpo: {nome}});
      sessionStorage.setItem(CHAVE_VINCULO, JSON.stringify({id: r.id, segredo: r.segredo, nome}));
      retomarVinculo();
    } catch (e) { erro(e.codigo); }
  });

  $("[data-step=codigo]").addEventListener("submit", async ev => {
    ev.preventDefault();
    erro(null);
    const v = vinculoAtual();
    if (!v) return cancelarVinculo();
    try {
      const r = await api(`/api/vinculos/${v.id}/confirmar`, {metodo: "POST", corpo: {codigo: $("#shopCode").value}, headers: {"X-Vinculo-Segredo": v.segredo}});
      localStorage.setItem(CHAVE_SESSAO, r.token);
      sessionStorage.removeItem(CHAVE_VINCULO);
      await carregarConta();
      mostrarConta();
      desenharCatalogo();
    } catch (e) {
      erro(e.codigo, e.dados);
      if (e.codigo === "vinculo_bloqueado" || /^vinculo_/.test(e.codigo || "")) cancelarVinculo();
    }
  });

  document.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", cancelarVinculo));

  $("[data-logout]").addEventListener("click", async () => {
    try { await api("/api/sair", {metodo: "POST"}); } catch { /* sai mesmo assim */ }
    localStorage.removeItem(CHAVE_SESSAO);
    conta = null;
    mostrarConta();
    desenharCatalogo();
  });

  // ---------- andamento do pedido (volta do checkout) ----------

  const ESTADOS_APOIO = {
    pago: "Pagamento confirmado! Obrigado por apoiar o Astral. O cargo chega no Discord em instantes; se o seu tier tem item ou personagem, a equipe vai falar com você por lá.",
    em_disputa: "O pagamento está em contestação; os benefícios ficam suspensos até a decisão.",
    reembolsado: "O pagamento foi reembolsado e os benefícios deste tier foram removidos.",
    contestado: "O pagamento foi estornado e os benefícios deste tier foram removidos.",
  };
  const ESTADOS = {
    criado: "Aguardando o pagamento.",
    aguardando_pagamento: "Aguardando a confirmação do Mercado Pago. Pix costuma levar segundos.",
    pago: "Pagamento confirmado! Seu pet chega no jogo em instantes (se você estiver fora, ele espera por você).",
    recusado: "O pagamento foi recusado. Você pode tentar de novo.",
    cancelado: "O pedido foi cancelado.",
    expirado: "O pedido expirou sem pagamento.",
    divergente: "Recebemos um pagamento que não confere com o pedido. A equipe vai analisar; fale conosco no Discord.",
    em_disputa: "O pagamento está em contestação; o pet fica suspenso até a decisão.",
    reembolsado: "O pagamento foi reembolsado e o pet foi removido.",
    contestado: "O pagamento foi estornado e o pet foi removido.",
  };

  async function acompanharPedido(id, tentativas = 0) {
    const caixa = $("[data-shop-order]");
    caixa.hidden = false;
    const status = $("[data-order-status]");
    if (!localStorage.getItem(CHAVE_SESSAO)) { status.textContent = "Vincule a conta para ver o pedido. Se você pagou, tudo será liberado mesmo assim."; return; }
    try {
      const p = await api(`/api/pedidos/${id}`);
      const textos = String(p.produto_id).startsWith("apoio_") ? {...ESTADOS, ...ESTADOS_APOIO} : ESTADOS;
      status.textContent = `${p.produto} · ${reais(p.valor_centavos)} — ${textos[p.estado] || p.estado}`;
      if (["criado", "aguardando_pagamento"].includes(p.estado) && tentativas < 40) setTimeout(() => acompanharPedido(id, tentativas + 1), 4000);
      if (p.estado === "pago") { await carregarConta(); mostrarConta(); desenharCatalogo(); }
    } catch {
      status.textContent = "Não foi possível consultar o pedido agora. Se você pagou, tudo será liberado mesmo assim.";
    }
  }

  // ---------- início ----------

  async function iniciar() {
    if (!API) { mostrar("sem-api"); $("[data-catalog]").replaceChildren(); return; }
    try {
      const c = await api("/api/catalogo");
      catalogo = c.produtos;
      if (c.modo === "teste") {
        const b = $("[data-shop-mode]");
        b.textContent = "Loja em modo de teste: nenhum pagamento real é cobrado.";
        b.hidden = false;
      }
    } catch {
      catalogoFalhou = true;
      $("[data-catalog]").replaceChildren(Object.assign(document.createElement("p"), {className: "muted", textContent: "Não foi possível carregar a loja agora."}));
    }
    await carregarConta();
    mostrarConta();
    desenharCatalogo();
    const pedido = new URLSearchParams(location.search).get("pedido");
    if (pedido && /^[0-9a-f-]{36}$/.test(pedido)) acompanharPedido(pedido);
  }

  iniciar();
})();
