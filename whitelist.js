(() => {
  const cfg = window.ASTRAL_CONFIG;
  const $ = (id) => document.getElementById(id);

  // ---------- Formulário de whitelist ----------
  const form = $("wlForm");
  const msg = $("formMsg");
  const chips = $("styleChips");
  const COOLDOWN_KEY = "astral_wl_sent";
  const COOLDOWN_MS = 10 * 60 * 1000;

  cfg.playStyles.forEach((style) => {
    const label = document.createElement("label");
    label.className = "chip";
    label.innerHTML = `<input type="checkbox" name="estilo"><span></span>`;
    label.querySelector("input").value = style;
    label.querySelector("span").textContent = style;
    chips.append(label);
  });

  // Pré-visualização da skin
  let skinTimer;
  $("nick").addEventListener("input", (e) => {
    const nick = e.target.value.trim();
    clearTimeout(skinTimer);
    e.target.classList.remove("invalid");
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) return ($("skinPreview").hidden = true);
    skinTimer = setTimeout(() => {
      $("skinImg").src = `https://mc-heads.net/avatar/${encodeURIComponent(nick)}/48`;
      $("skinName").textContent = `Olá, ${nick}!`;
      $("skinPreview").hidden = false;
    }, 400);
  });

  $("motivo").addEventListener("input", (e) => {
    $("motivoCount").textContent = e.target.value.length;
    e.target.classList.remove("invalid");
  });
  chips.addEventListener("change", () => chips.classList.remove("invalid"));

  function showMsg(text, type) {
    msg.textContent = text;
    msg.className = `form-msg ${type}`;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const nick = (fd.get("nick") || "").trim();
    const contato = (fd.get("contato") || "").trim();
    const estilos = fd.getAll("estilo");
    const motivo = (fd.get("motivo") || "").trim();

    // Bot caiu no honeypot: finge sucesso e não envia nada
    if (fd.get("website")) return showMsg("Pedido enviado! ✓", "ok");

    let ok = true;
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) { $("nick").classList.add("invalid"); ok = false; }
    if (!estilos.length) { chips.classList.add("invalid"); ok = false; }
    if (motivo.length < 20) { $("motivo").classList.add("invalid"); ok = false; }
    if (!fd.get("regras")) ok = false;
    if (!ok) return showMsg("Preencha todos os campos obrigatórios (*) e aceite as regras.", "err");

    try {
      const last = Number(localStorage.getItem(COOLDOWN_KEY) || 0);
      if (Date.now() - last < COOLDOWN_MS) {
        return showMsg("Você já enviou um pedido há pouco. Aguarde alguns minutos.", "err");
      }
    } catch {}

    if (!cfg.workerUrl || !cfg.turnstileSiteKey) {
      return showMsg("O envio de pedidos ainda não foi configurado (config.js).", "err");
    }

    const btn = $("submitBtn");
    btn.disabled = true;
    btn.textContent = "Enviando…";

    try {
      // O captcha roda escondido; se a Cloudflare pedir interação, ele aparece acima do botão
      if (!captcha.token) showMsg("Verificando que você não é um robô…", "info");
      const turnstileToken = await captcha.wait(60_000);
      if (!turnstileToken) throw new Error("Não foi possível confirmar que você não é um robô. Recarregue a página e tente de novo.");
      showMsg("", "");

      // O Worker valida, aplica os limites e repassa ao Fluxer (o webhook fica escondido lá)
      const res = await fetch(cfg.workerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nick, contato, estilos, motivo, turnstile: turnstileToken, website: fd.get("website") || "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Não foi possível enviar agora. Tente novamente em instantes.");

      try { localStorage.setItem(COOLDOWN_KEY, String(Date.now())); } catch {}
      form.reset();
      chips.querySelectorAll("input").forEach((i) => (i.checked = false));
      $("skinPreview").hidden = true;
      $("motivoCount").textContent = "0";
      showMsg(`Pedido enviado, ${nick}! A equipe vai analisar em breve. ✦`, "ok");
    } catch (err) {
      console.error(err);
      const generic = "Não foi possível enviar agora. Tente novamente em instantes.";
      showMsg(err instanceof TypeError ? generic : err.message || generic, "err");
    } finally {
      captcha.reset();
      btn.disabled = false;
      btn.textContent = "Enviar pedido";
    }
  });

  // Captcha (Cloudflare Turnstile). Com appearance "interaction-only" ele resolve sozinho
  // em segundo plano e só aparece na tela quando a Cloudflare precisa que a pessoa clique.
  const captcha = {
    id: undefined,
    token: "",
    waiters: [],
    set(token) {
      this.token = token;
      if (token) this.waiters.splice(0).forEach((resolve) => resolve(token));
    },
    wait(ms) {
      if (this.token) return Promise.resolve(this.token);
      return new Promise((resolve) => {
        this.waiters.push(resolve);
        setTimeout(() => resolve(this.token), ms);
      });
    },
    reset() {
      this.token = "";
      if (this.id !== undefined) window.turnstile?.reset(this.id);
    },
  };
  if (cfg.workerUrl && cfg.turnstileSiteKey) {
    window.onTurnstileLoad = () => {
      captcha.id = window.turnstile.render("#turnstile", {
        sitekey: cfg.turnstileSiteKey,
        theme: "dark",
        language: "pt-br",
        appearance: "interaction-only",
        callback: (token) => captcha.set(token),
        "expired-callback": () => captcha.set(""),
        "error-callback": () => { captcha.set(""); },
        "before-interactive-callback": () => {
          if ($("submitBtn").disabled) showMsg("Confirme a verificação acima para enviar.", "info");
        },
      });
    };
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad";
    s.async = true;
    document.head.append(s);
  }
})();
