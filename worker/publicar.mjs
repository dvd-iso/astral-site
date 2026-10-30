// Publicação do modpack: o /astral update gera um link assinado (válido por poucos minutos e de uso único) e esta
// página envia o .mrpack como release "modpack-…" do astral-installer. O workflow "Publicar modpack" de lá limpa o
// pack, confere os downloads e atualiza o canal; os jogadores recebem "Atualizar agora" na tela de título.
//
// Segurança: só UUIDs da lista DONOS publicam. O link é um HMAC (segredo PUBLICAR_SEGREDO, o mesmo do arquivo
// plugins/Astral/publicar-segredo.txt), expira e é queimado no KV USOS na primeira abertura, que vira uma sessão
// presa a um cookie HttpOnly. O GITHUB_TOKEN nunca sai daqui e só é usado para releases de modpack.
// Com ACCESS_EQUIPE/ACCESS_AUD definidos, toda página exige também o login do Cloudflare Access (código por e-mail)
// de um e-mail da lista EMAILS: o Worker confere a assinatura do Access, então desligar o Access não abre a porta.
// DISCORD_WEBHOOK (segredo) recebe um aviso a cada link aberto, tentativa de reuso, publicação e reversão.

const REPO = "dvd-iso/astral-installer";
const WORKFLOW = "modpack.yml";
const COOKIE = "astral_publicar";
const SESSAO_SEGUNDOS = 3600;
const LIMITE_BYTES = 95 * 1024 * 1024;
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src https://astralmc.online; connect-src 'self'; "
  + "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text) {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

function iguais(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmac(segredo, texto) {
  const key = await crypto.subtle.importKey("raw", enc.encode(segredo), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(texto)));
}

function donos(env) {
  return String(env.DONOS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Confere o link do /astral update: formato "<payload base64url>.<hmac base64url>". Devolve o payload ou null. */
export async function verificarLink(token, env, agora = Date.now()) {
  if (typeof token !== "string" || token.length > 600 || !env.PUBLICAR_SEGREDO) return null;
  const partes = token.split(".");
  if (partes.length !== 2) return null;
  let assinatura;
  try { assinatura = fromB64url(partes[1]); } catch { return null; }
  if (!iguais(assinatura, await hmac(env.PUBLICAR_SEGREDO, partes[0]))) return null;
  let dados;
  try { dados = JSON.parse(new TextDecoder().decode(fromB64url(partes[0]))); } catch { return null; }
  if (!dados || typeof dados.u !== "string" || typeof dados.r !== "string" || typeof dados.e !== "number") return null;
  if (dados.e * 1000 < agora) return null;
  if (!donos(env).includes(dados.u.toLowerCase())) return null;
  return dados;
}

// ---------- Cloudflare Access ----------
let chavesAccess = null;

async function chaves(env, fetcher, renovar = false) {
  if (!renovar && chavesAccess && chavesAccess.equipe === env.ACCESS_EQUIPE && Date.now() - chavesAccess.em < 3600_000) return chavesAccess.keys;
  const r = await fetcher(`https://${env.ACCESS_EQUIPE}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`certificados do Access: HTTP ${r.status}`);
  chavesAccess = {equipe: env.ACCESS_EQUIPE, em: Date.now(), keys: (await r.json()).keys || []};
  return chavesAccess.keys;
}

function cookieChamado(request, nome) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${nome}=([^;]+)`));
  return m ? m[1] : null;
}

/** Confere o JWT do Cloudflare Access. Sem ACCESS_EQUIPE configurado, o Access ainda não está ligado e nada é exigido. */
export async function verificarAccess(request, env, fetcher = fetch, agora = Date.now()) {
  if (!env.ACCESS_EQUIPE) return {ok: true, email: null};
  if (!env.ACCESS_AUD || !emails(env).length) return {ok: false};
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion") || cookieChamado(request, "CF_Authorization");
  if (!jwt || jwt.split(".").length !== 3) return {ok: false};
  const [h, p, assinatura] = jwt.split(".");
  let cab, dados;
  try {
    cab = JSON.parse(new TextDecoder().decode(fromB64url(h)));
    dados = JSON.parse(new TextDecoder().decode(fromB64url(p)));
  } catch {
    return {ok: false};
  }
  if (cab.alg !== "RS256") return {ok: false};
  let jwk = (await chaves(env, fetcher)).find(k => k.kid === cab.kid);
  if (!jwk) jwk = (await chaves(env, fetcher, true)).find(k => k.kid === cab.kid);
  if (!jwk) return {ok: false};
  const key = await crypto.subtle.importKey("jwk", jwk, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["verify"]);
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(assinatura), enc.encode(`${h}.${p}`))) return {ok: false};
  const aud = Array.isArray(dados.aud) ? dados.aud : [dados.aud];
  if (dados.iss !== `https://${env.ACCESS_EQUIPE}` || !aud.includes(env.ACCESS_AUD)) return {ok: false};
  if (typeof dados.exp !== "number" || dados.exp * 1000 < agora) return {ok: false};
  const email = String(dados.email || "").toLowerCase();
  return emails(env).includes(email) ? {ok: true, email} : {ok: false};
}

function emails(env) {
  return String(env.EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

// ---------- Avisos no Discord ----------
function origem(request) {
  const cf = request.cf || {};
  const lugar = [cf.city, cf.region, cf.country].filter(Boolean).join(", ");
  return `${request.headers.get("CF-Connecting-IP") || "IP desconhecido"}${lugar ? ` · ${lugar}` : ""}`;
}

export async function avisar(env, fetcher, titulo, linhas, cor = 0x8b6cf6) {
  if (!env.DISCORD_WEBHOOK) return;
  try {
    await fetcher(env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        username: "Astral · publicação do modpack",
        allowed_mentions: {parse: []},
        embeds: [{title: titulo.slice(0, 250), description: linhas.filter(Boolean).join("\n").slice(0, 3900), color: cor, timestamp: new Date().toISOString()}],
      }),
    });
  } catch {
    // O aviso nunca impede a publicação.
  }
}

function cabecalhos(extra = {}) {
  return new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  });
}

function json(status, corpo) {
  return new Response(JSON.stringify(corpo), {status, headers: cabecalhos({"Content-Type": "application/json; charset=utf-8"})});
}

function cookie(request) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,80})`));
  return m ? m[1] : null;
}

async function sessao(request, env) {
  const id = cookie(request);
  if (!id) return null;
  const dados = await env.USOS.get(`sessao:${id}`, "json");
  return dados && donos(env).includes(String(dados.u).toLowerCase()) ? {id, ...dados} : null;
}

function github(env, caminho, opcoes = {}, fetcher = fetch) {
  const url = caminho.startsWith("https://") ? caminho : `https://api.github.com${caminho}`;
  return fetcher(url, {
    ...opcoes,
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "astral-publicar",
      ...(opcoes.headers || {}),
    },
  });
}

async function githubJson(env, caminho, opcoes, fetcher) {
  const r = await github(env, caminho, opcoes, fetcher);
  const texto = await r.text();
  if (!r.ok) throw new Error(`GitHub ${r.status} em ${caminho.split("?")[0]}: ${texto.slice(0, 200)}`);
  return texto ? JSON.parse(texto) : null;
}

async function canalAtual(env, fetcher) {
  const r = await github(env, `/repos/${REPO}/contents/channel/stable.json?ref=main`, {headers: {"Accept": "application/vnd.github.raw+json"}}, fetcher);
  if (!r.ok) return null;
  const c = await r.json();
  return {nome: c.name, versao: c.version, url: c.pack?.url || "", publicadoEm: c.publishedAt || null};
}

/** Tag no mesmo formato das anteriores (modpack-AAAAMMDD-HHMM, hora de Brasília). */
export function tagPara(data) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(data).map(x => [x.type, x.value]));
  return `modpack-${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}

function limpo(texto, max) {
  return String(texto || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

/** Metadados da versão no cabeçalho X-Astral-Meta (JSON em base64): o corpo do pedido é só o .mrpack. */
function lerMeta(request) {
  try {
    const texto = new TextDecoder().decode(Uint8Array.from(atob(request.headers.get("X-Astral-Meta") || ""), c => c.charCodeAt(0)));
    const m = JSON.parse(texto);
    return {versao: limpo(m.versao, 40), titulo: limpo(m.titulo, 80), notas: limpo(m.notas, 4000)};
  } catch {
    return null;
  }
}

async function publicar(request, env, s, fetcher) {
  if (request.headers.get("X-Astral") !== "publicar") return json(403, {erro: "Pedido recusado."});
  if (s.publicado) return json(409, {erro: "Esta sessão já publicou. Use /astral update de novo para outra versão.", tag: s.publicado});
  const tamanho = Number(request.headers.get("Content-Length") || 0);
  if (!tamanho || !request.body) return json(411, {erro: "Envie o .mrpack."});
  if (tamanho > LIMITE_BYTES) return json(413, {erro: "Arquivo grande demais (limite de 95 MB)."});
  const meta = lerMeta(request);
  if (!meta || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(meta.versao)) return json(400, {erro: "Versão inválida no .mrpack."});
  const {versao, titulo, notas} = meta;

  let tag = tagPara(new Date());
  const existe = await github(env, `/repos/${REPO}/releases/tags/${tag}`, {}, fetcher);
  if (existe.ok) tag += `-${String(new Date().getUTCSeconds()).padStart(2, "0")}`;
  const nome = titulo ? `Astral ${versao}: ${titulo}` : `Astral ${versao}`;
  const release = await githubJson(env, `/repos/${REPO}/releases`, {
    method: "POST",
    body: JSON.stringify({tag_name: tag, target_commitish: "main", name: nome, body: notas, draft: true}),
  }, fetcher);
  try {
    const arquivoNome = `Astral-${versao.replace(/[^0-9A-Za-z._-]+/g, "-")}.mrpack`;
    // O arquivo passa direto, sem ser montado na memória: no plano gratuito o Worker tem pouca CPU.
    let corpo = request.body;
    if (typeof FixedLengthStream === "function") {
      const fixo = new FixedLengthStream(tamanho);
      request.body.pipeTo(fixo.writable);
      corpo = fixo.readable;
    }
    await githubJson(env, `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(arquivoNome)}`, {
      method: "POST", body: corpo, duplex: "half", headers: {"Content-Type": "application/zip", "Content-Length": String(tamanho)},
    }, fetcher);
    // Publicar só depois do anexo: o workflow dispara com o .mrpack já presente.
    await githubJson(env, `/repos/${REPO}/releases/${release.id}`, {
      method: "PATCH", body: JSON.stringify({draft: false, make_latest: "true"}),
    }, fetcher);
  } catch (erro) {
    await github(env, `/repos/${REPO}/releases/${release.id}`, {method: "DELETE"}, fetcher).catch(() => {});
    await github(env, `/repos/${REPO}/git/refs/tags/${tag}`, {method: "DELETE"}, fetcher).catch(() => {});
    throw erro;
  }
  const {id, ...resto} = s;
  await env.USOS.put(`sessao:${id}`, JSON.stringify({...resto, publicado: tag, publicadoEm: Date.now()}), {expirationTtl: SESSAO_SEGUNDOS});
  await avisar(env, fetcher, `Publicação enviada: ${nome}`, [
    `Por ${s.n || "?"}${s.email ? ` (${s.email})` : ""} · ${origem(request)}`,
    `Tag ${tag} · ${(tamanho / 1048576).toFixed(1)} MB`,
    notas ? `> ${notas.slice(0, 600).replace(/\n/g, "\n> ")}` : "",
    "Não foi você? Use /astral update → **Voltar para a versão anterior** e troque o segredo.",
  ], 0xf2c94c);
  return json(200, {tag, nome, release: release.html_url});
}

async function estado(url, env, fetcher) {
  const tag = url.searchParams.get("tag") || "";
  if (!/^modpack-[0-9]{8}-[0-9]{4}(?:-[0-9]{2})?$/.test(tag)) return json(400, {erro: "Tag inválida."});
  const desfazer = url.searchParams.get("modo") === "desfazer";
  const release = await githubJson(env, `/repos/${REPO}/releases/tags/${tag}`, {}, fetcher);
  const desde = desfazer ? Number(url.searchParams.get("desde") || 0) - 60_000 : Date.parse(release.published_at || release.created_at) - 60_000;
  const runs = await githubJson(env, `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?event=${desfazer ? "workflow_dispatch" : "release"}&per_page=10`, {}, fetcher);
  const run = (runs.workflow_runs || []).filter(r => (desfazer || r.display_title === release.name) && Date.parse(r.created_at) >= desde)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  const canal = await canalAtual(env, fetcher);
  const publicado = Boolean(canal && canal.url.includes(`/download/${tag}/`));
  const falhou = Boolean(run && run.status === "completed" && run.conclusion !== "success");
  if ((publicado || falhou) && !await env.USOS.get(`aviso:${tag}:${desfazer ? "d" : "p"}`)) {
    await env.USOS.put(`aviso:${tag}:${desfazer ? "d" : "p"}`, "1", {expirationTtl: 30 * 86400});
    if (publicado) await avisar(env, fetcher, desfazer ? `Versão anterior de volta: ${release.name}` : `No ar: ${release.name}`,
      [desfazer ? "Os jogadores vão receber esta versão em \"Atualizar agora\"." : "Os jogadores já veem \"Atualizar agora\".", run ? run.html_url : ""], 0x8fbd90);
    else await avisar(env, fetcher, `A conferência falhou: ${release.name}`, ["O canal não mudou; nada chegou aos jogadores.", run.html_url], 0xf87171);
  }
  return json(200, {
    workflow: run ? {status: run.status, conclusao: run.conclusion, url: run.html_url} : null,
    publicado,
    canal,
  });
}

/** A release de modpack publicada no canal agora e a anterior a ela (a que "Voltar" republica). */
async function anterior(env, fetcher) {
  const lista = (await githubJson(env, `/repos/${REPO}/releases?per_page=40`, {}, fetcher) || [])
    .filter(r => !r.draft && /^modpack-/.test(r.tag_name) && (r.assets || []).some(a => /\.mrpack$/i.test(a.name)))
    .sort((a, b) => Date.parse(b.published_at || b.created_at) - Date.parse(a.published_at || a.created_at));
  const canal = await canalAtual(env, fetcher);
  const i = lista.findIndex(r => canal && canal.url.includes(`/download/${r.tag_name}/`));
  const resumo = r => r ? {tag: r.tag_name, nome: r.name || r.tag_name, em: r.published_at} : null;
  return {atual: resumo(lista[i]), anterior: i >= 0 ? resumo(lista[i + 1]) : null};
}

async function desfazer(request, env, s, fetcher) {
  if (request.headers.get("X-Astral") !== "desfazer") return json(403, {erro: "Pedido recusado."});
  let pedido;
  try { pedido = await request.json(); } catch { return json(400, {erro: "Pedido inválido."}); }
  const {atual, anterior: alvo} = await anterior(env, fetcher);
  if (!alvo || pedido.tag !== alvo.tag) return json(409, {erro: "A versão publicada mudou. Recarregue a página."});
  const r = await github(env, `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST", body: JSON.stringify({ref: "main", inputs: {tag: alvo.tag}}),
  }, fetcher);
  if (!r.ok) return json(502, {erro: `O GitHub recusou (${r.status}). O token precisa de Actions: leitura e escrita.`});
  await avisar(env, fetcher, `Voltando para ${alvo.nome}`, [
    `Pedido por ${s.n || "?"}${s.email ? ` (${s.email})` : ""} · ${origem(request)}`,
    `Sai: ${atual ? atual.nome : "?"} · volta: ${alvo.nome} (${alvo.tag})`,
  ], 0xe8a13a);
  return json(200, {tag: alvo.tag, nome: alvo.nome, desde: Date.now()});
}

export async function handle(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const acesso = await verificarAccess(request, env, fetcher);
  if (!acesso.ok) {
    if (url.searchParams.has("t")) await avisar(env, fetcher, "Link aberto sem o login do Cloudflare Access", [
      `${origem(request)}`, "O Worker recusou. Confira se o Access continua ligado no workers.dev do astral-publicar.",
    ], 0xf87171);
    return pagina(403, "Acesso negado", "Esta página exige o login do Cloudflare Access com o e-mail do dono.");
  }
  if (request.method === "GET" && url.pathname === "/") {
    const dados = await verificarLink(url.searchParams.get("t"), env);
    if (!dados) return pagina(403, "Link inválido ou expirado", "Gere outro com <strong>/astral update</strong> no jogo.");
    const usado = `link:${dados.r}`;
    if (await env.USOS.get(usado)) {
      await avisar(env, fetcher, "Tentativa de reabrir um link já usado", [`${origem(request)}`, acesso.email ? `Login do Access: ${acesso.email}` : "",
        "Se você não abriu o mesmo link duas vezes, alguém viu o seu link."], 0xf87171);
      return pagina(403, "Este link já foi usado",
        "Cada link abre uma vez só. Se não foi você quem abriu, gere outro com <strong>/astral update</strong> e avise a equipe.");
    }
    await env.USOS.put(usado, "1", {expirationTtl: 86400});
    const id = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.USOS.put(`sessao:${id}`, JSON.stringify({u: dados.u, n: dados.n || "", email: acesso.email}), {expirationTtl: SESSAO_SEGUNDOS});
    await avisar(env, fetcher, "Link de publicação aberto", [`Por ${dados.n || "?"}${acesso.email ? ` (${acesso.email})` : ""}`, origem(request),
      "Não foi você? A sessão dura 1 hora; troque o segredo e confira as publicações."]);
    return new Response(null, {status: 303, headers: cabecalhos({
      "Location": "/publicar",
      "Set-Cookie": `${COOKIE}=${id}; Path=/; Max-Age=${SESSAO_SEGUNDOS}; HttpOnly; Secure; SameSite=Lax`,
    })});
  }
  const s = await sessao(request, env);
  if (url.pathname === "/publicar" && request.method === "GET") {
    if (!s) return pagina(403, "Sessão expirada", "Gere um link novo com <strong>/astral update</strong> no jogo.");
    return new Response(PAGINA.replace("{{NOME}}", escapar(s.n || "Sonhador")), {headers: cabecalhos({"Content-Type": "text/html; charset=utf-8"})});
  }
  if (!url.pathname.startsWith("/api/")) return pagina(404, "Página não encontrada", "");
  if (!s) return json(401, {erro: "Sessão expirada. Gere um link novo com /astral update."});
  try {
    if (url.pathname === "/api/canal" && request.method === "GET") return json(200, {canal: await canalAtual(env, fetcher), publicado: s.publicado || null});
    if (url.pathname === "/api/publicar" && request.method === "POST") return await publicar(request, env, s, fetcher);
    if (url.pathname === "/api/estado" && request.method === "GET") return await estado(url, env, fetcher);
    if (url.pathname === "/api/anterior" && request.method === "GET") return json(200, await anterior(env, fetcher));
    if (url.pathname === "/api/desfazer" && request.method === "POST") return await desfazer(request, env, s, fetcher);
  } catch (erro) {
    return json(502, {erro: String(erro.message || erro)});
  }
  return json(404, {erro: "Não encontrado."});
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};

function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
}

const ESTILO = `@font-face{font-family:Monocraft;src:url(https://astralmc.online/fonts/Monocraft.woff2) format("woff2");font-display:swap}
@font-face{font-family:Monocraft;font-weight:700;src:url(https://astralmc.online/fonts/Monocraft-Bold.woff2) format("woff2");font-display:swap}
*{box-sizing:border-box}html{background:#050508}
body{margin:0;min-height:100vh;font:14px/1.7 Monocraft,ui-monospace,monospace;color:#e6e3f0;background:radial-gradient(60vw 50vh at 8% 0%,rgba(139,108,246,.09),transparent 70%),radial-gradient(60vw 50vh at 95% 100%,rgba(91,147,247,.07),transparent 70%),#050508;background-attachment:fixed}
header{max-width:760px;margin:0 auto;padding:20px 16px;border-bottom:1px solid #1d1c2b;display:flex;justify-content:space-between;align-items:center;gap:12px}
.logo{display:inline-flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase}.logo svg{width:30px;height:30px;shape-rendering:crispEdges}
.quem{color:#a19cb5;font-size:12px}main{max-width:760px;margin:0 auto;padding:36px 16px 72px}
.eyebrow{margin:0 0 10px;color:#f2c94c;font-size:12px;letter-spacing:.15em;text-transform:uppercase}h1{margin:0 0 6px;color:#f2d58c;font-size:clamp(22px,5vw,30px);line-height:1.3}
.muted{color:#a19cb5;font-size:12px}.card{border:1.5px solid #2c2a40;background:#0d0d16;padding:18px;margin:18px 0}
#zona{border:2px dashed #2c2a40;padding:34px 16px;text-align:center;cursor:pointer;transition:border-color .2s,background .2s}
#zona.sobre,#zona:hover{border-color:#f2c94c;background:rgba(242,201,76,.05)}#zona b{color:#f2d58c}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:0}dt{color:#f2c94c;font-size:12px;text-transform:uppercase;letter-spacing:.1em}dd{margin:0}
label{display:block;margin:14px 0 6px;color:#f2c94c;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
input,textarea{width:100%;font:inherit;color:#e6e3f0;background:#050508;border:1.5px solid #2c2a40;padding:10px}textarea{min-height:110px;resize:vertical}
input:focus,textarea:focus{outline:none;border-color:#8b6cf6}
button{font:inherit;font-weight:700;padding:11px 22px;border:2px solid #0b0a06;outline:2px solid #f2c94c;outline-offset:-4px;background:#f2c94c;color:#0b0a06;cursor:pointer;box-shadow:inset 0 -4px 0 rgba(0,0,0,.22)}
button:disabled{opacity:.45;cursor:not-allowed}.aviso{border-left:3px solid #f87171;background:rgba(248,113,113,.07);padding:10px 14px;margin:14px 0}
.ok{border-left-color:#8fbd90;background:rgba(143,189,144,.07)}.barra{height:10px;background:#1d1c2b;margin:12px 0}.barra i{display:block;height:100%;width:0;background:linear-gradient(90deg,#8b6cf6,#f2c94c);transition:width .2s}
ol.passos{list-style:none;padding:0;margin:0}ol.passos li{padding:6px 0 6px 28px;position:relative;color:#a19cb5}ol.passos li:before{content:"";position:absolute;left:4px;top:13px;width:10px;height:10px;background:#2c2a40}
ol.passos li.feito{color:#e6e3f0}ol.passos li.feito:before{background:#8fbd90}ol.passos li.agora{color:#f2d58c}ol.passos li.agora:before{background:#f2c94c;animation:pisca 1s steps(2) infinite}
ol.passos li.erro{color:#f87171}ol.passos li.erro:before{background:#f87171}@keyframes pisca{50%{opacity:.3}}a{color:#5b93f7}[hidden]{display:none!important}`;

const ESTRELA = '<svg viewBox="0 0 17 17" aria-hidden="true"><path fill="#f2c94c" d="M8 0h1v2h-1zM8 15h1v2h-1zM0 8h2v1h-2zM15 8h2v1h-2zM7 2h1v3h-1zM9 2h1v3h-1zM7 12h1v3h-1zM9 12h1v3h-1zM2 7h3v1h-3zM12 7h3v1h-3zM2 9h3v1h-3zM12 9h3v1h-3zM4 4h2v1h-2zM11 4h2v1h-2zM4 12h2v1h-2zM11 12h2v1h-2zM4 5h1v1h-1zM12 5h1v1h-1zM4 11h1v1h-1zM12 11h1v1h-1zM6 5h1v1h-1zM10 5h1v1h-1zM6 11h1v1h-1zM10 11h1v1h-1zM5 6h1v1h-1zM11 6h1v1h-1zM5 10h1v1h-1zM11 10h1v1h-1z"/><path fill="#fff4c2" d="M8 7h1v1h-1zM7 8h3v1h-3zM8 9h1v1h-1z"/></svg>';

function pagina(status, titulo, texto) {
  return new Response(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo} · Astral</title><style>${ESTILO}</style><header><span class="logo">${ESTRELA}Astral</span></header><main><p class="eyebrow">Publicar modpack</p><h1>${titulo}</h1><p>${texto}</p></main></html>`,
    {status, headers: cabecalhos({"Content-Type": "text/html; charset=utf-8"})});
}

const PAGINA = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Publicar modpack · Astral</title><style>${ESTILO}</style>
<header><span class="logo">${ESTRELA}Astral</span><span class="quem">Sessão de {{NOME}}</span></header>
<main>
<p class="eyebrow">Publicar modpack</p><h1>Nova versão do Astral</h1>
<p class="muted" id="atual">Lendo a versão publicada…</p>
<div class="card" id="voltar" hidden><p class="muted" id="voltarTexto" style="margin:0 0 12px"></p><button id="desfazer" style="background:#0d0d16;color:#e6e3f0;outline-color:#e8a13a">Voltar para a versão anterior</button></div>
<section id="escolher">
  <div class="card" id="zona" tabindex="0"><b>Arraste o .mrpack aqui</b><br><span class="muted">ou clique para escolher. No Prism: botão direito na instância → Exportar → Modrinth (.mrpack).</span></div>
  <input type="file" id="arquivo" accept=".mrpack" hidden>
</section>
<section id="detalhes" hidden>
  <div class="card"><dl id="info"></dl></div>
  <div class="aviso" id="alerta" hidden></div>
  <label for="titulo">Título da versão</label><input id="titulo" maxlength="80" placeholder="Ex.: Look and Feel">
  <label for="notas">O que mudou (aparece para os jogadores)</label><textarea id="notas" maxlength="4000" placeholder="Ex.: novos mods de decoração e ajustes de desempenho."></textarea>
  <p><button id="publicar">Publicar para os jogadores</button> <button id="trocar" style="background:#0d0d16;color:#e6e3f0;outline-color:#2c2a40">Trocar arquivo</button></p>
</section>
<section id="andamento" hidden>
  <div class="card"><div class="barra"><i id="progresso"></i></div>
  <ol class="passos" id="passos">
    <li data-p="envio">Enviando o arquivo</li><li data-p="release">Release criada no GitHub</li>
    <li data-p="workflow">Conferindo o pack e os downloads</li><li data-p="canal">Canal atualizado: os jogadores já veem “Atualizar agora”</li>
  </ol><p class="muted" id="detalhe"></p></div>
</section>
</main>
<script>
const $ = id => document.getElementById(id);
let escolhido = null, meta = null, atual = null;
fetch("/api/canal").then(r => r.json()).then(d => {
  atual = d.canal;
  $("atual").textContent = atual ? "Publicada agora: " + atual.nome + " · versão " + atual.versao : "Não consegui ler a versão publicada.";
  if (d.publicado) { $("escolher").hidden = true; $("voltar").dataset.off = "1"; $("voltar").hidden = true; mostrarAndamento(); acompanhar(d.publicado); }
});
fetch("/api/anterior").then(r => r.json()).then(d => {
  if (!d.anterior || $("voltar").dataset.off) return;
  $("voltarTexto").textContent = "Se a versão publicada deu problema, dá para voltar para " + d.anterior.nome + " (" + d.anterior.tag + "). Os jogadores recebem essa versão em Atualizar agora.";
  $("voltar").hidden = false;
  $("desfazer").onclick = async () => {
    if (!confirm("Voltar todos os jogadores para " + d.anterior.nome + "?")) return;
    $("desfazer").disabled = true;
    const r = await fetch("/api/desfazer", {method: "POST", headers: {"X-Astral": "desfazer", "Content-Type": "application/json"}, body: JSON.stringify({tag: d.anterior.tag})});
    const x = await r.json().catch(() => ({}));
    if (!r.ok) { alert(x.erro || "Não deu para voltar (" + r.status + ")."); $("desfazer").disabled = false; return; }
    $("escolher").hidden = true; $("voltar").hidden = true;
    document.querySelector('[data-p="envio"]').textContent = "Pedido de volta enviado";
    document.querySelector('[data-p="release"]').textContent = "Versão escolhida: " + x.nome;
    mostrarAndamento(); acompanhar(x.tag, "&modo=desfazer&desde=" + x.desde);
  };
});
$("zona").onclick = () => $("arquivo").click();
$("zona").onkeydown = e => { if (e.key === "Enter" || e.key === " ") $("arquivo").click(); };
$("arquivo").onchange = () => $("arquivo").files[0] && escolher($("arquivo").files[0]);
["dragenter", "dragover"].forEach(t => $("zona").addEventListener(t, e => { e.preventDefault(); $("zona").classList.add("sobre"); }));
["dragleave", "drop"].forEach(t => $("zona").addEventListener(t, e => { e.preventDefault(); $("zona").classList.remove("sobre"); }));
$("zona").addEventListener("drop", e => e.dataTransfer.files[0] && escolher(e.dataTransfer.files[0]));
$("trocar").onclick = () => { $("detalhes").hidden = true; $("escolher").hidden = false; escolhido = meta = null; };

// Lê o modrinth.index.json de dentro do .mrpack (zip) sem bibliotecas.
async function lerIndice(file) {
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
  let fim = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { fim = i; break; }
  if (fim < 0) throw new Error("O arquivo não é um zip válido.");
  let p = dv.getUint32(fim + 16, true); const total = dv.getUint16(fim + 10, true);
  for (let n = 0; n < total; n++) {
    const metodo = dv.getUint16(p + 10, true), comp = dv.getUint32(p + 20, true), lenNome = dv.getUint16(p + 28, true);
    const extra = dv.getUint16(p + 30, true), coment = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    const nome = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + lenNome));
    if (nome === "modrinth.index.json") {
      const ini = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      let dados = buf.subarray(ini, ini + comp);
      if (metodo === 8) dados = new Uint8Array(await new Response(new Blob([dados]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      return JSON.parse(new TextDecoder().decode(dados));
    }
    p += 46 + lenNome + extra + coment;
  }
  throw new Error("Não achei o modrinth.index.json: exporte como Modrinth (.mrpack).");
}

function comparar(a, b) {
  const pa = String(a).split(/[.-]/), pb = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] || "0", 10), y = parseInt(pb[i] || "0", 10);
    if (x !== y) return x - y;
  }
  return 0;
}

async function escolher(file) {
  try {
    if (!/\\.mrpack$/i.test(file.name)) throw new Error("Escolha um arquivo .mrpack.");
    meta = await lerIndice(file); escolhido = file;
  } catch (e) { alert(e.message); return; }
  const d = meta.dependencies || {};
  const linhas = [["Nome", meta.name], ["Versão", meta.versionId], ["Minecraft", d.minecraft || "?"], ["Fabric", d["fabric-loader"] || "?"],
    ["Mods baixados", (meta.files || []).length], ["Tamanho", (file.size / 1048576).toFixed(1) + " MB"]];
  $("info").innerHTML = "";
  for (const [k, v] of linhas) { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; $("info").append(dt, dd); }
  $("titulo").value = String(meta.name || "").replace(/^Astral[-\\s]*/i, "").replace(/-/g, " ").trim();
  const avisos = [];
  if (!meta.versionId) avisos.push("O .mrpack não tem versão. No export do Prism, preencha o campo Versão.");
  if (atual && meta.versionId && comparar(meta.versionId, atual.versao) <= 0) avisos.push("A versão " + meta.versionId + " não é maior que a publicada (" + atual.versao + "). Os jogadores só são avisados quando o conteúdo muda, mas é melhor subir o número.");
  $("alerta").hidden = !avisos.length; $("alerta").textContent = avisos.join(" ");
  $("publicar").disabled = !meta.versionId;
  $("escolher").hidden = true; $("detalhes").hidden = false;
}

function mostrarAndamento() { $("detalhes").hidden = true; $("andamento").hidden = false; }
function passo(nome, classe) {
  const lista = [...document.querySelectorAll("#passos li")], i = lista.findIndex(li => li.dataset.p === nome);
  lista.forEach((li, j) => { li.className = j < i ? "feito" : j === i ? classe : ""; });
}

$("publicar").onclick = () => {
  if (!escolhido || !confirm("Publicar " + meta.name + " " + meta.versionId + " para todos os jogadores?")) return;
  mostrarAndamento(); passo("envio", "agora");
  const dados = JSON.stringify({versao: meta.versionId, titulo: $("titulo").value, notas: $("notas").value});
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/publicar"); xhr.setRequestHeader("X-Astral", "publicar");
  xhr.setRequestHeader("X-Astral-Meta", btoa(String.fromCharCode(...new TextEncoder().encode(dados))));
  xhr.setRequestHeader("Content-Type", "application/octet-stream");
  xhr.upload.onprogress = e => { if (e.lengthComputable) $("progresso").style.width = (e.loaded / e.total * 100).toFixed(0) + "%"; };
  xhr.onload = () => {
    let d = {}; try { d = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status !== 200) { passo("envio", "erro"); $("detalhe").textContent = d.erro || "Falha no envio (" + xhr.status + ")."; return; }
    $("progresso").style.width = "100%"; acompanhar(d.tag);
  };
  xhr.onerror = () => { passo("envio", "erro"); $("detalhe").textContent = "A conexão caiu durante o envio. Gere outro link e tente de novo."; };
  xhr.send(escolhido);
};

function acompanhar(tag, extra) {
  passo("workflow", "agora"); $("progresso").style.width = "100%";
  const vez = async () => {
    let d;
    try { d = await (await fetch("/api/estado?tag=" + encodeURIComponent(tag) + (extra || ""))).json(); } catch { return setTimeout(vez, 8000); }
    if (d.publicado) { passo("canal", "feito"); document.querySelectorAll("#passos li").forEach(li => li.className = "feito");
      $("detalhe").textContent = "Pronto: " + d.canal.nome + " " + d.canal.versao + " está no ar."; return; }
    if (d.workflow && d.workflow.status === "completed" && d.workflow.conclusao !== "success") {
      passo("workflow", "erro"); $("detalhe").innerHTML = 'A conferência falhou. <a target="_blank" rel="noopener" href="' + d.workflow.url + '">Ver o que aconteceu</a>.'; return; }
    if (d.workflow && d.workflow.status === "completed") passo("canal", "agora");
    $("detalhe").textContent = d.workflow ? "O GitHub está conferindo o pack (leva 1 a 3 minutos)…" : "Esperando o GitHub começar a conferência…";
    setTimeout(vez, 6000);
  };
  vez();
}
</script></html>`;
