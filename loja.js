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
    novas_assinaturas_encerradas: "Novos apoios são de pagamento único. Assinaturas antigas continuam disponíveis para gestão e cancelamento.",
    mercado_pago_indisponivel: "O Mercado Pago não respondeu. Tente de novo em instantes.",
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
    if (!grade) return;
    grade.replaceChildren();
    const atual = apoioAtual();
    const total = conta?.apoio_total || 0;
    const temSuspenso = (conta?.direitos || []).some(d => d.estado === "suspenso" && String(d.produto_id).startsWith("apoio_"));
    const tiers = catalogo.filter(p => p.tipo === "apoio" && p.ativo).sort((a, b) => a.preco_centavos - b.preco_centavos);
    // A gestão da assinatura antiga não depende de existirem tiers novos à venda.
    $("[data-apoio-secao]").hidden = !tiers.length && !conta?.assinatura;

    // Resumo da conta: quanto já apoiou, próximo tier, assinatura e mural.
    const resumo = $("[data-apoio-resumo]");
    resumo.hidden = !conta;
    if (conta) {
      const proximo = tiers.find(t => t.preco_centavos > total);
      $("[data-apoio-total]").textContent = total
        ? `Você já apoiou ${reais(total)}${atual ? ` e é ${atual.nome}` : ""}.` + (proximo ? ` Faltam ${reais(proximo.preco_centavos - total)} para ${proximo.nome}.` : " Você chegou ao maior tier. Obrigado!")
        : "Você ainda não apoiou. Tudo o que você apoiar soma para o tier.";
      const a = conta.assinatura;
      const caixa = $("[data-assinatura]");
      caixa.hidden = !a;
      if (a) {
        const estados = {pendente: "aguardando a autorização no Mercado Pago", autorizada: "ativa", pausada: "pausada"};
        $("[data-assinatura-texto]").textContent = `${a.nome}: ${estados[a.estado] || a.estado}.`;
      }
      $("[data-mural]").checked = conta.mural_visivel !== false;
    }

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
      const ofertaPrisma = Number.isInteger(p.prisma_quantidade) && p.prisma_quantidade > 0;
      const descricao = ofertaPrisma ? p.descricao : "A oferta de apoio está em atualização. Aguarde o novo catálogo.";
      for (const linha of String(descricao).split(/\.\s+|\.$/).filter(Boolean)) {
        const li = document.createElement("li");
        li.textContent = linha.trim() + ".";
        lista.append(li);
      }
      card.append(topo, h, lista);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      const falta = p.preco_centavos - total;
      const tierBase = falta > 0 ? catalogo.filter(t => t.tipo === "apoio" && t.preco_centavos <= total)
        .sort((a, b) => b.preco_centavos - a.preco_centavos)[0] : null;
      const base = tierBase ? tierBase.prisma_quantidade : 0;
      const quantidade = p.prisma_quantidade - base;
      const ofertaCalculavel = ofertaPrisma && Number.isInteger(base) && base >= 0 && Number.isInteger(quantidade) && quantidade > 0;
      if (temSuspenso) { btn.textContent = "Em análise"; btn.disabled = true; }
      else if (!ofertaCalculavel) { btn.textContent = "Oferta em atualização"; btn.disabled = true; }
      else if (!p.a_venda) { btn.textContent = "Indisponível"; btn.disabled = true; }
      else if (!conta) { btn.textContent = "Vincule a conta"; btn.disabled = true; }
      else {
        btn.textContent = falta <= 0 ? "Apoiar de novo" : total ? `Completar com ${reais(falta)}` : "Apoiar";
        btn.title = falta <= 0
          ? `Novo pagamento único de ${reais(p.preco_centavos)}: recebe ${quantidade} Prisma novamente e soma para o tier.`
          : `Pagamento único de ${reais(falta)}: recebe ${quantidade} Prisma${base ? " (diferença entre os tiers)" : ""} após confirmação.`;
        btn.addEventListener("click", () => comprar(p.id, btn));
      }
      if (conta && ofertaCalculavel) {
        const efetivo = document.createElement("p");
        efetivo.className = "tiny tier-effective";
        efetivo.textContent = `Neste pagamento: ${reais(falta > 0 ? falta : p.preco_centavos)} e ${quantidade} Prisma após confirmação.`;
        card.append(efetivo);
      }
      card.append(btn);
      grade.append(card);
    }
  }

  async function cancelarAssinatura(btn) {
    if (!conta?.assinatura) return;
    erro(null);
    btn.disabled = true;
    try {
      await api(`/api/assinaturas/${conta.assinatura.id}/cancelar`, {metodo: "POST", corpo: {}});
      await carregarConta(); mostrarConta(); desenharCatalogo();
    } catch (e) { erro(e.codigo || "mercado_pago_indisponivel"); }
    btn.disabled = false;
  }

  function desenharCatalogo() {
    desenharApoio();
    const grade = $("[data-catalog]");
    if (catalogoFalhou) return; // mantém a mensagem de erro
    grade.replaceChildren();
    const meus = new Set((conta?.direitos || []).filter(d => d.estado === "ativo").map(d => d.produto_id));
    for (const p of catalogo.filter(p => p.tipo === "pet")) {
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
    const textoAnterior = btn.textContent;
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
      btn.textContent = textoAnterior;
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
    pago: "Pagamento confirmado! Obrigado por apoiar o Astral. O cargo é atualizado no Discord da conta vinculada.",
    em_disputa: "O pagamento está em contestação; o tier pode ficar suspenso. A Prisma disponível deste apoio é retida, sem dívida nem remoção de cosméticos; valores já gastos passam por análise da equipe.",
    reembolsado: "O pagamento foi reembolsado e saiu da soma do apoio. A Prisma disponível deste pedido é revertida; o que já foi gasto vai para análise, sem dívida automática nem remoção de cosméticos.",
    contestado: "O pagamento foi estornado e saiu da soma do apoio. A Prisma disponível deste pedido é revertida; o que já foi gasto vai para análise, sem dívida automática nem remoção de cosméticos.",
    cancelado: "O pedido foi cancelado. Se já estava pago, a Prisma disponível é revertida e valores gastos passam por análise, sem dívida automática nem remoção de cosméticos.",
  };
  const ESTADOS_APOIO_LEGADO = {
    ...ESTADOS_APOIO,
    em_disputa: "O pagamento está em contestação; o tier pode ficar suspenso até a decisão.",
    reembolsado: "O pagamento foi reembolsado e saiu da soma do apoio. O tier é atualizado conforme o total restante.",
    contestado: "O pagamento foi estornado e saiu da soma do apoio. O tier é atualizado conforme o total restante.",
    cancelado: "O pedido foi cancelado. Se já estava pago, o valor sai da soma do apoio.",
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
      const textos = String(p.produto_id).startsWith("apoio_")
        ? {...ESTADOS, ...(p.prisma_quantidade > 0 ? ESTADOS_APOIO : ESTADOS_APOIO_LEGADO)} : ESTADOS;
      status.textContent = `${p.produto} · ${reais(p.valor_centavos)} — ${textos[p.estado] || p.estado}`;
      if (p.estado === "pago" && p.prisma_quantidade > 0) status.textContent += ` ${p.prisma_quantidade} Prisma creditada na sua conta. Reembolso parcial mantém a Prisma e passa por análise.`;
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
    const assinatura = new URLSearchParams(location.search).get("assinatura");
    if (assinatura && /^[0-9a-f-]{36}$/.test(assinatura)) {
      $("[data-shop-order]").hidden = false;
      $("[data-order-status]").textContent = "Novas assinaturas foram encerradas. Se você já tinha uma, as cobranças continuam somando para o tier e podem ser geridas ou canceladas na sua conta. Nenhuma assinatura antiga foi cancelada automaticamente.";
    }
  }

  $("[data-assinatura-cancelar]").addEventListener("click", ev => cancelarAssinatura(ev.currentTarget));
  $("[data-mural]").addEventListener("change", async ev => {
    const caixa = ev.currentTarget;
    caixa.disabled = true;
    try { await api("/api/mural", {metodo: "POST", corpo: {visivel: caixa.checked}}); if (conta) conta.mural_visivel = caixa.checked; }
    catch (e) { caixa.checked = !caixa.checked; erro(e.codigo); }
    caixa.disabled = false;
  });

  iniciar();
})();
