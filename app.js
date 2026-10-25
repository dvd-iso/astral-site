(() => {
  const cfg = window.ASTRAL_CONFIG;
  const $ = (id) => document.getElementById(id);

  function createPixelIcon(name, className = "") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", `pixel-icon ${className}`.trim());
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `icons.svg#${name}`);
    svg.append(use);
    return svg;
  }

  // Mantém funcionando os links da antiga página única, inclusive com /astral-site/.
  if (document.body.dataset.page === "inicio") {
    const legacyPages = { "#sobre": "sobre.html", "#regras": "regras.html" };
    const redirectLegacyLink = () => {
      const page = legacyPages[location.hash];
      if (!page) return false;
      location.replace(new URL(page, location.href).href);
      return true;
    };
    if (redirectLegacyLink()) return;
    addEventListener("hashchange", redirectLegacyLink);
  }

  // ---------- Navegação compacta no celular ----------
  const navToggle = $("navToggle");
  const siteNavigation = $("siteNavigation");
  if (navToggle && siteNavigation) {
    const header = navToggle.closest(".nav");
    const mobileNavigation = matchMedia("(max-width: 840px)");
    function setMenu(open) {
      const expanded = mobileNavigation.matches && open;
      navToggle.hidden = !mobileNavigation.matches;
      navToggle.setAttribute("aria-expanded", String(expanded));
      navToggle.setAttribute("aria-label", expanded ? "Fechar menu" : "Abrir menu");
      siteNavigation.hidden = mobileNavigation.matches && !expanded;
    }
    setMenu(false);
    navToggle.addEventListener("click", (event) => {
      const open = navToggle.getAttribute("aria-expanded") !== "true";
      setMenu(open);
      if (open && mobileNavigation.matches && event.detail === 0) {
        siteNavigation.querySelector("a")?.focus({ preventScroll: true });
      }
    });
    siteNavigation.addEventListener("click", (event) => {
      if (event.target.closest("a")) setMenu(false);
    });
    document.addEventListener("click", (event) => {
      if (!header.contains(event.target)) setMenu(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && navToggle.getAttribute("aria-expanded") === "true") {
        setMenu(false);
        navToggle.focus({ preventScroll: true });
      }
    });
    mobileNavigation.addEventListener("change", () => setMenu(false));
  }

  // ---------- Preferência de movimento compartilhada entre as páginas ----------
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const motionListeners = new Set();
  let motionPaused = false;
  let motionEnabled = false;
  try { motionPaused = localStorage.getItem("astral_motion") === "paused"; } catch {}
  const motionButtons = document.querySelectorAll("[data-motion-toggle]");
  function updateMotion() {
    motionEnabled = !motionQuery.matches && !motionPaused;
    document.documentElement.dataset.motion = motionEnabled ? "on" : "off";
    motionButtons.forEach((button) => {
      button.hidden = false;
      button.disabled = motionQuery.matches;
      button.setAttribute("aria-pressed", String(!motionEnabled));
      button.querySelector("[data-motion-label]").textContent = motionQuery.matches
        ? "Movimento reduzido pelo sistema"
        : motionEnabled ? "Pausar animações" : "Ativar animações";
    });
    motionListeners.forEach((listener) => listener());
  }
  motionButtons.forEach((button) => button.addEventListener("click", () => {
    motionPaused = !motionPaused;
    try { localStorage.setItem("astral_motion", motionPaused ? "paused" : "on"); } catch {}
    updateMotion();
  }));
  motionQuery.addEventListener("change", updateMotion);
  updateMotion();

  // ---------- Textos dinâmicos ----------
  document.querySelectorAll("[data-name]").forEach((el) => (el.textContent = cfg.serverName));
  document.querySelectorAll("[data-version]").forEach((el) => (el.textContent = cfg.serverVersion));
  document.title = `${document.body.dataset.pageTitle} — ${cfg.serverName}`;
  document.querySelectorAll("[data-server-address]").forEach((el) => (el.textContent = cfg.serverAddress));

  const modpack = cfg.modpack;
  if (modpack) {
    const packLabels = {
      "data-modpack-file": modpack.fileName,
      "data-modpack-version": modpack.version,
      "data-modpack-minecraft": modpack.minecraftVersion,
      "data-modpack-loader": `${modpack.loader} ${modpack.loaderVersion}`,
    };
    Object.entries(packLabels).forEach(([attribute, text]) => {
      document.querySelectorAll(`[${attribute}]`).forEach((element) => (element.textContent = text));
    });
    document.querySelectorAll("[data-modpack-download]").forEach((link) => {
      link.href = modpack.downloadUrl;
      link.download = modpack.fileName;
    });
  }

  // ---------- Astral Installer: download para o sistema do visitante ----------
  const installerPlatforms = {
    "win-x64": "Windows",
    "mac-arm64": "macOS · Apple Silicon",
    "mac-x64": "macOS · Intel",
    "linux-x86_64": "Linux · x64",
    "linux-arm64": "Linux · ARM64",
  };
  function installerUrl(platform) {
    const extension = platform.startsWith("win-") ? "exe" : platform.startsWith("mac-") ? "dmg" : "AppImage";
    return `${cfg.installer.downloadBaseUrl}Astral-Installer-${cfg.installer.version}-${platform}.${extension}`;
  }
  // Palpite inicial pelo user agent; Safari e Firefox no Mac não informam a arquitetura, então Apple Silicon é o padrão.
  let installerPlatform = (() => {
    const agent = navigator.userAgent;
    const platform = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""}`;
    if (navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(agent) || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return null;
    if (/Win/i.test(platform) || /Windows/i.test(agent)) return "win-x64";
    if (/Mac/i.test(platform) || /Mac OS X/i.test(agent)) return "mac-arm64";
    if (/Linux|X11|CrOS/i.test(platform + agent)) return /aarch64|arm64|armv8/i.test(platform + agent) ? "linux-arm64" : "linux-x86_64";
    return null;
  })();
  function applyInstallerPlatform() {
    if (!cfg.installer) return;
    document.querySelectorAll("[data-installer-download]").forEach((link) => {
      link.href = installerUrl(link.dataset.installerDownload);
      link.classList.toggle("is-detected", link.dataset.installerDownload === installerPlatform);
    });
    document.querySelectorAll("[data-installer-primary]").forEach((link) => {
      link.href = installerPlatform ? installerUrl(installerPlatform) : "instalar.html#sistemas";
      link.querySelector("[data-installer-primary-label]").textContent = installerPlatform ? `Baixar para ${installerPlatforms[installerPlatform]}` : "Escolher meu sistema";
    });
    document.querySelectorAll("[data-installer-detected]").forEach((element) => {
      element.textContent = installerPlatform
        ? `Astral Installer ${cfg.installer.version} · detectamos ${installerPlatforms[installerPlatform]}. Não é o seu? Veja os outros sistemas.`
        : "O Astral é jogado no computador. Abra esta página no PC onde você joga Minecraft Java, ou escolha o sistema.";
    });
    document.querySelectorAll("[data-installer-releases]").forEach((link) => (link.href = cfg.installer.releasesUrl));
  }
  applyInstallerPlatform();
  if (installerPlatform && installerPlatform !== "win-x64" && navigator.userAgentData?.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(["architecture"]).then(({ architecture }) => {
      const arm = architecture === "arm";
      installerPlatform = installerPlatform.startsWith("mac-") ? (arm ? "mac-arm64" : "mac-x64") : (arm ? "linux-arm64" : "linux-x86_64");
      applyInstallerPlatform();
    }).catch(() => {});
  }
  // GitHub entrega o arquivo como anexo: a página continua aberta e mostra os próximos passos.
  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-installer-primary], [data-installer-download]");
    if (!link || !link.href.includes("/releases/download/")) return;
    document.querySelectorAll("[data-installer-next]").forEach((element) => (element.hidden = false));
  });

  // Botões/links para a comunidade no Fluxer
  if (cfg.fluxerInviteUrl) {
    document.querySelectorAll("[data-fluxer]").forEach((a) => {
      a.href = cfg.fluxerInviteUrl;
      a.hidden = false;
    });
  }

  // ---------- Filme: carrega o player do YouTube somente ao dar play ----------
  document.querySelectorAll("[data-video-player]").forEach((player) => {
    const cover = player.querySelector(".video-cover");
    if (!cover) return;
    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = cover.className;
    playButton.setAttribute("aria-label", `Reproduzir ${player.dataset.videoTitle}`);
    playButton.append(...cover.childNodes);
    cover.replaceWith(playButton);
    playButton.addEventListener("click", () => {
      const iframe = document.createElement("iframe");
      iframe.src = `https://www.youtube-nocookie.com/embed/${player.dataset.videoId}?autoplay=1&rel=0&playsinline=1`;
      iframe.title = player.dataset.videoTitle;
      iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen; web-share";
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      player.replaceChildren(iframe);
      iframe.focus({ preventScroll: true });
    }, { once: true });
  });

  // ---------- Fragmentos da lore ----------
  document.querySelectorAll("[data-lore]").forEach((el) => {
    const item = (cfg.lore || [])[Number(el.dataset.lore)];
    if (!item) return el.remove();
    if (el.tagName !== "BLOCKQUOTE") return (el.textContent = `“${item.texto}”`);
    const p = document.createElement("p");
    p.textContent = `“${item.texto}”`;
    el.append(p);
    if (item.fonte) {
      const cite = document.createElement("cite");
      cite.textContent = `— ${item.fonte}`;
      el.append(cite);
    }
  });

  // ---------- Pequenas descobertas na página Sobre ----------
  const fragmentCopy = document.querySelector("[data-fragment-copy]");
  const nextFragment = document.querySelector("[data-next-fragment]");
  const fragmentProgress = document.querySelector("[data-fragment-progress]");
  const fragments = cfg.memoryFragments || [];
  if (fragmentCopy && nextFragment && fragmentProgress && fragments.length) {
    let fragmentIndex = 0;
    function showFragment() {
      const fragment = fragments[fragmentIndex];
      fragmentCopy.querySelector("[data-fragment-text]").textContent = `“${fragment.texto}”`;
      fragmentCopy.querySelector("[data-fragment-source]").textContent = fragment.fonte ? `— ${fragment.fonte}` : "";
      fragmentProgress.setAttribute("aria-label", `Fragmento ${fragmentIndex + 1} de ${fragments.length}`);
      fragmentProgress.replaceChildren(...fragments.map((_, index) => createPixelIcon("spark", index === fragmentIndex ? "is-current" : "")));
    }
    showFragment();
    nextFragment.hidden = fragments.length < 2;
    nextFragment.addEventListener("click", () => {
      fragmentIndex = (fragmentIndex + 1) % fragments.length;
      fragmentCopy.getAnimations().forEach((animation) => animation.cancel());
      showFragment();
      if (motionEnabled) fragmentCopy.animate(
        [{ opacity: .2, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 350, easing: "ease-out" },
      );
    });
    motionListeners.add(() => {
      if (!motionEnabled) fragmentCopy.getAnimations().forEach((animation) => animation.cancel());
    });
  }
  // ---------- Regras (somente na página de regras) ----------
  const rulesList = $("rulesList");
  if (rulesList) {
    (cfg.rules || []).forEach((rule, index) => {
      const details = cfg.ruleCards?.[index] || { title: `Regra ${index + 1}`, art: "equipe" };
      const li = document.createElement("li");
      li.className = "rule-card";
      const illustration = document.createElement("div");
      illustration.className = "rule-illustration";
      const art = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      art.setAttribute("viewBox", "0 0 96 72");
      art.setAttribute("class", "rule-art");
      art.setAttribute("aria-hidden", "true");
      art.setAttribute("focusable", "false");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", `artes/regras-8bit.svg?v=13#${details.art}`);
      art.append(use);
      illustration.append(art);
      const copy = document.createElement("div");
      copy.className = "rule-copy";
      const number = document.createElement("span");
      number.className = "rule-number";
      number.setAttribute("aria-hidden", "true");
      number.textContent = String(index + 1).padStart(2, "0");
      const title = document.createElement("h3");
      title.textContent = details.title;
      const text = document.createElement("p");
      text.textContent = rule;
      copy.append(number, title, text);
      li.append(illustration, copy);
      rulesList.append(li);
    });
  }

  // ---------- Jogar: baixar o Astral Installer para o sistema do visitante ----------
  const playLinks = document.querySelectorAll("[data-play]");
  if (playLinks.length && typeof HTMLDialogElement !== "undefined" && "showModal" in HTMLDialogElement.prototype) {
    const dialog = document.createElement("dialog");
    dialog.id = "playDialog";
    dialog.className = "play-dialog";
    dialog.setAttribute("aria-labelledby", "playDialogTitle");
    dialog.setAttribute("aria-describedby", "playDialogDescription");
    dialog.innerHTML = `
      <button type="button" class="dialog-close" aria-label="Fechar">×</button>
      <p class="eyebrow"><svg class="pixel-icon" aria-hidden="true" focusable="false"><use href="icons.svg#spark" /></svg>Seu próximo capítulo</p>
      <h2 id="playDialogTitle" tabindex="-1" autofocus>Você gostaria de ter<br><span class="text-accent">a experiência completa?</span></h2>
      <p id="playDialogDescription" class="muted">Baixe o Astral Installer. Ele instala e atualiza o modpack do <span data-pack-name></span> no seu launcher, com os mods e as configurações prontos para você.</p>
      <div class="installer-offer">
        <a class="btn installer-primary" href="instalar.html#sistemas" data-installer-primary><span data-installer-primary-label>Baixar Astral Installer</span> <span aria-hidden="true">↓</span></a>
        <p class="tiny muted" data-installer-detected></p>
      </div>
      <div class="installer-next" data-installer-next hidden>
        <p class="eyebrow">Download iniciado</p>
        <ol>
          <li>Abra o <strong>Astral Installer</strong> que você baixou.</li>
          <li>Clique no cartão do seu launcher e depois em <strong>Instalar Astral</strong>.</li>
          <li>Abra o launcher, selecione <strong>Astral</strong> e jogue.</li>
        </ol>
      </div>
      <ul class="installer-launchers" aria-label="Launchers compatíveis">
        <li class="launcher-official"><img class="launcher-logo" src="marca/launchers/minecraft.svg" width="28" height="28" alt="" aria-hidden="true" />Minecraft Launcher</li>
        <li class="launcher-sklauncher"><img class="launcher-logo" src="marca/launchers/sklauncher.svg" width="28" height="28" alt="" aria-hidden="true" />SKlauncher 4</li>
        <li class="launcher-prism"><img class="launcher-logo" src="marca/launchers/prism.svg" width="28" height="28" alt="" aria-hidden="true" />Prism Launcher</li>
      </ul>
      <a class="installer-more" href="instalar.html">Outros sistemas e passo a passo <span aria-hidden="true">→</span></a>
    `;
    dialog.querySelector("[data-pack-name]").textContent = cfg.serverName;
    document.body.append(dialog);
    applyInstallerPlatform();
    let playTrigger;
    playLinks.forEach((link) => {
      link.setAttribute("aria-haspopup", "dialog");
      link.setAttribute("aria-controls", dialog.id);
      link.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (dialog.open) return;
        if (navToggle?.getAttribute("aria-expanded") === "true") navToggle.click();
        playTrigger = link;
        dialog.showModal();
        document.documentElement.classList.add("play-dialog-open");
      });
    });
    dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll("a[href], button:not([disabled])")];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    dialog.addEventListener("close", () => {
      document.documentElement.classList.remove("play-dialog-open");
      playTrigger?.focus({ preventScroll: true });
    });
  }

  // ---------- Copiar IP ----------
  const copyButtons = document.querySelectorAll("[data-copy-ip]");
  if (copyButtons.length) {
    const toast = document.createElement("div");
    toast.className = "copy-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.setAttribute("aria-atomic", "true");
    document.body.append(toast);
    const restoreTimers = new WeakMap();
    let toastTimer;

    function copyWithSelection() {
      const field = document.createElement("textarea");
      field.className = "clipboard-fallback";
      field.value = cfg.serverAddress;
      field.readOnly = true;
      field.tabIndex = -1;
      field.setAttribute("aria-hidden", "true");
      const focused = document.activeElement;
      document.body.append(field);
      let copied = false;
      try {
        field.select();
        copied = document.execCommand("copy");
      } catch {}
      field.remove();
      focused?.focus({ preventScroll: true });
      return copied;
    }

    copyButtons.forEach((button) => {
      button.title = `Copiar ${cfg.serverAddress}`;
      button.setAttribute("aria-label", `Copiar o endereço do ${cfg.serverName}: ${cfg.serverAddress}`);
      button.addEventListener("click", async () => {
        let copied;
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(cfg.serverAddress);
            copied = true;
          } else copied = copyWithSelection();
        } catch { copied = copyWithSelection(); }
        clearTimeout(restoreTimers.get(button));
        button.dataset.copyState = copied ? "copied" : "error";
        const feedback = button.querySelector("[data-copy-feedback]");
        if (feedback) feedback.textContent = copied ? "IP copiado!" : "Copie o IP";
        const hint = button.querySelector("[data-copy-hint]");
        if (hint) hint.textContent = copied ? "IP copiado!" : cfg.serverAddress;
        toast.textContent = copied ? `${cfg.serverAddress} copiado!` : `Copie este endereço: ${cfg.serverAddress}`;
        toast.classList.add("is-visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove("is-visible"), copied ? 2600 : 7000);
        restoreTimers.set(button, setTimeout(() => {
          delete button.dataset.copyState;
          if (hint) hint.textContent = "clique para copiar";
        }, 2200));
      });
    });
  }

  // ---------- Status do servidor (api.mcsrvstat.us) ----------
  async function loadStatus() {
    const badge = $("statusBadge");
    try {
      const res = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(cfg.serverAddress)}`);
      if (!res.ok) throw new Error("Status indisponível");
      const data = await res.json();

      if (!data.online) {
        badge.className = "badge off";
        badge.querySelector("b").textContent = "offline";
        $("playersOnline").textContent = "0";
        $("playersMax").textContent = "–";
        $("version").textContent = cfg.serverVersion;
      } else {
        badge.className = "badge on";
        badge.querySelector("b").textContent = "online";
        $("playersOnline").textContent = data.players?.online ?? 0;
        $("playersMax").textContent = data.players?.max ?? "–";
        $("version").textContent = cfg.serverVersion || data.version || "–";
      }
      $("updated").textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR")}`;
    } catch {
      badge.className = "badge off";
      badge.querySelector("b").textContent = "indisponível";
      $("updated").textContent = "Não foi possível consultar o status agora.";
    }
  }
  if ($("statusBadge")) {
    loadStatus();
    setInterval(loadStatus, 60_000);
  }

  // ---------- Seções reveladas ao explorar a página ----------
  const revealElements = [...document.querySelectorAll("[data-reveal]")];
  if (motionEnabled && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: .06, rootMargin: "0px 0px -24px 0px" });
    revealElements.forEach((element) => {
      const siblings = [...element.parentElement.children].filter((child) => child.hasAttribute("data-reveal"));
      element.style.setProperty("--reveal-delay", `${Math.min(siblings.indexOf(element), 3) * .08}s`);
      element.classList.add("reveal-ready");
      observer.observe(element);
    });
    motionListeners.add(() => {
      if (motionEnabled) return;
      revealElements.forEach((element) => element.classList.add("is-visible"));
      observer.disconnect();
    });
  }

  // A linha do menu acompanha a leitura sem interceptar a navegação.
  let progressFrame = 0;
  function updateReadingProgress() {
    progressFrame = 0;
    const distance = document.documentElement.scrollHeight - innerHeight;
    document.documentElement.style.setProperty("--reading-progress", distance > 0 ? String(Math.min(1, Math.max(0, scrollY / distance))) : "0");
  }
  const scheduleReadingProgress = () => {
    if (!progressFrame) progressFrame = requestAnimationFrame(updateReadingProgress);
  };
  addEventListener("scroll", scheduleReadingProgress, { passive: true });
  addEventListener("resize", scheduleReadingProgress);
  document.fonts.ready.then(scheduleReadingProgress);
  updateReadingProgress();

  // ---------- Céu vivo: estrelas, profundidade e estrelas cadentes ----------
  const canvas = $("stars");
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;
  let stars = [];
  let width = 0;
  let height = 0;
  let frame = 0;
  let lastDraw = 0;
  let nextMeteor = 0;
  let meteor = null;
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
  function resizeSky() {
    width = innerWidth;
    height = innerHeight;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const colors = ["#f2c94c", "#5b93f7", "#b19aef", "#ffffff", "#ffffff", "#ffffff", "#ffffff"];
    stars = Array.from({ length: Math.min(180, Math.max(30, Math.floor(width * height / 7000))) }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      size: Math.random() > .85 ? 2 : 1,
      phase: Math.random() * Math.PI * 2,
      speed: .4 + Math.random() * .7,
      depth: .2 + Math.random() * .8,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    syncSky();
  }
  function drawSky(now) {
    ctx.clearRect(0, 0, width, height);
    pointer.x = motionEnabled ? pointer.x + (pointer.targetX - pointer.x) * .04 : 0;
    pointer.y = motionEnabled ? pointer.y + (pointer.targetY - pointer.y) * .04 : 0;
    stars.forEach((star) => {
      ctx.globalAlpha = motionEnabled ? .3 + Math.sin(now * .001 * star.speed + star.phase) * .2 : .5;
      ctx.fillStyle = star.color;
      ctx.fillRect(star.x + pointer.x * star.depth, star.y + pointer.y * star.depth, star.size, star.size);
    });
    if (motionEnabled && now >= nextMeteor) {
      meteor = { x: width * (.15 + Math.random() * .5), y: height * Math.random() * .25, start: now };
      nextMeteor = now + 9000 + Math.random() * 7000;
    }
    if (meteor && motionEnabled) {
      const progress = (now - meteor.start) / 1200;
      if (progress >= 1) meteor = null;
      else {
        const x = meteor.x + progress * 220;
        const y = meteor.y + progress * 140;
        const trail = ctx.createLinearGradient(x - 65, y - 40, x, y);
        trail.addColorStop(0, "rgba(139, 108, 246, 0)");
        trail.addColorStop(1, "#eadcfb");
        ctx.globalAlpha = Math.sin(progress * Math.PI) * .7;
        ctx.strokeStyle = trail;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - 65, y - 40);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
  function animateSky(now) {
    frame = 0;
    if (!motionEnabled || document.hidden) return;
    if (now - lastDraw >= 1000 / 30) {
      drawSky(now);
      lastDraw = now;
    }
    frame = requestAnimationFrame(animateSky);
  }
  function syncSky() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    meteor = null;
    const now = performance.now();
    nextMeteor = now + 7000;
    drawSky(now);
    if (motionEnabled && !document.hidden) frame = requestAnimationFrame(animateSky);
  }
  motionListeners.add(syncSky);
  addEventListener("resize", resizeSky);
  document.addEventListener("visibilitychange", syncSky);
  addEventListener("pointermove", (event) => {
    if (!motionEnabled || event.pointerType !== "mouse") return;
    pointer.targetX = (event.clientX / width - .5) * 12;
    pointer.targetY = (event.clientY / height - .5) * 12;
  }, { passive: true });
  document.addEventListener("pointerleave", () => { pointer.targetX = 0; pointer.targetY = 0; });
  resizeSky();
})();
