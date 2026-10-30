import assert from "node:assert/strict";
import test from "node:test";
import {handle, tagPara, verificarLink} from "../publicar.mjs";

const DONO = "def0e0f3-e4d0-42cf-8ce5-7afb44fd7e97";
const SEGREDO = "segredo-de-teste";
// Mesmo vetor do teste do plugin (PublishLinkTest): payload fixo, expira em 2100.
const VETOR = "eyJ1IjoiZGVmMGUwZjMtZTRkMC00MmNmLThjZTUtN2FmYjQ0ZmQ3ZTk3IiwibiI6ImR2ZGlzbyIsImUiOjQxMDI0NDQ4MDAsInIiOiJub25jZS1maXhvLTEyMyJ9"
  + ".9Od07-AIR1vYnY0pstMAUDo-JUAcA1e7sfAiRU81mgY";
const base = "https://astral-publicar.example";

function kv() {
  const m = new Map();
  return {
    m,
    async get(k, tipo) { const v = m.get(k); return v === undefined ? null : tipo === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
  };
}

function ambiente(extra = {}) {
  return {PUBLICAR_SEGREDO: SEGREDO, DONOS: DONO, GITHUB_TOKEN: "ghp_teste", USOS: kv(), ...extra};
}

async function link(payload, segredo = SEGREDO) {
  const b = x => Buffer.from(x).toString("base64url");
  const p = b(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return `${p}.${b(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(p))))}`;
}

const futuro = () => Math.floor(Date.now() / 1000) + 600;

test("aceita o vetor fixo assinado pelo plugin", async () => {
  const d = await verificarLink(VETOR, ambiente());
  assert.equal(d.u, DONO);
  assert.equal(d.n, "dvdiso");
});

test("recusa link expirado, adulterado, com outro segredo ou de quem não é dono", async () => {
  const env = ambiente();
  assert.equal(await verificarLink(await link({u: DONO, n: "x", e: 1000, r: "a"}), env), null);
  assert.equal(await verificarLink(await link({u: DONO, n: "x", e: futuro(), r: "a"}, "outro"), env), null);
  assert.equal(await verificarLink(await link({u: "00000000-0000-0000-0000-000000000000", n: "x", e: futuro(), r: "a"}), env), null);
  const [p, s] = VETOR.split(".");
  assert.equal(await verificarLink(`${p}x.${s}`, env), null);
  assert.equal(await verificarLink(VETOR, ambiente({PUBLICAR_SEGREDO: ""})), null);
  assert.equal(await verificarLink(VETOR, ambiente({DONOS: ""})), null);
});

test("o link abre uma vez só e vira uma sessão com cookie HttpOnly", async () => {
  const env = ambiente();
  const t = await link({u: DONO, n: "dvdiso", e: futuro(), r: "n1"});
  const r1 = await handle(new Request(`${base}/?t=${t}`), env);
  assert.equal(r1.status, 303);
  assert.equal(r1.headers.get("Location"), "/publicar");
  const set = r1.headers.get("Set-Cookie");
  assert.match(set, /HttpOnly; Secure; SameSite=Lax/);
  const r2 = await handle(new Request(`${base}/?t=${t}`), env);
  assert.equal(r2.status, 403);
  assert.match(await r2.text(), /já foi usado/);
  const cookie = set.split(";")[0];
  const pagina = await handle(new Request(`${base}/publicar`, {headers: {Cookie: cookie}}), env);
  assert.equal(pagina.status, 200);
  assert.match(await pagina.text(), /Sessão de dvdiso/);
  const sem = await handle(new Request(`${base}/publicar`), env);
  assert.equal(sem.status, 403);
  const api = await handle(new Request(`${base}/api/canal`), env);
  assert.equal(api.status, 401);
});

test("publica: release em rascunho, anexo e só então publicada; a sessão não publica duas vezes", async () => {
  const env = ambiente();
  const t = await link({u: DONO, n: "dvdiso", e: futuro(), r: "n2"});
  const cookie = (await handle(new Request(`${base}/?t=${t}`), env)).headers.get("Set-Cookie").split(";")[0];
  const chamadas = [];
  const fetcher = async (url, opcoes = {}) => {
    chamadas.push(`${opcoes.method || "GET"} ${url.replace(/\?.*/, "")}`);
    assert.equal(opcoes.headers.Authorization, "Bearer ghp_teste");
    if (url.includes("/releases/tags/")) return new Response("{}", {status: 404});
    if (url.endsWith("/releases") && opcoes.method === "POST") {
      const corpo = JSON.parse(opcoes.body);
      assert.equal(corpo.draft, true);
      assert.match(corpo.tag_name, /^modpack-\d{8}-\d{4}$/);
      assert.equal(corpo.name, "Astral 2.6: Céu Novo");
      assert.equal(corpo.body, "Notas\ncom acento: ç");
      return Response.json({id: 77, html_url: "https://github.com/x"});
    }
    if (url.startsWith("https://uploads.github.com/")) {
      assert.match(url, /name=Astral-2\.6\.mrpack/);
      assert.equal(opcoes.headers["Content-Length"], "4");
      return Response.json({id: 1});
    }
    if (url.endsWith("/releases/77") && opcoes.method === "PATCH") {
      assert.equal(JSON.parse(opcoes.body).draft, false);
      return Response.json({});
    }
    throw new Error(`inesperado: ${url}`);
  };
  const meta = Buffer.from(JSON.stringify({versao: "2.6", titulo: "Céu Novo", notas: "Notas\ncom acento: ç"})).toString("base64");
  const pedido = () => new Request(`${base}/api/publicar`, {
    method: "POST", body: new Uint8Array([0x50, 0x4b, 3, 4]), duplex: "half",
    headers: {Cookie: cookie, "X-Astral": "publicar", "X-Astral-Meta": meta, "Content-Length": "4"},
  });
  const r = await handle(pedido(), env, fetcher);
  assert.equal(r.status, 200, await r.clone().text());
  assert.match((await r.json()).tag, /^modpack-/);
  assert.deepEqual(chamadas.map(c => c.split(" ")[0]), ["GET", "POST", "POST", "PATCH"]);
  const de_novo = await handle(pedido(), env, fetcher);
  assert.equal(de_novo.status, 409);
});

test("sem o cabeçalho próprio o envio é recusado (proteção contra CSRF)", async () => {
  const env = ambiente();
  const t = await link({u: DONO, n: "dvdiso", e: futuro(), r: "n3"});
  const cookie = (await handle(new Request(`${base}/?t=${t}`), env)).headers.get("Set-Cookie").split(";")[0];
  const r = await handle(new Request(`${base}/api/publicar`, {method: "POST", body: "x", headers: {Cookie: cookie}}), env, async () => {
    throw new Error("não deveria chamar o GitHub");
  });
  assert.equal(r.status, 403);
});

test("tag no formato das anteriores, na hora de Brasília", () => {
  assert.equal(tagPara(new Date("2026-10-30T00:18:00Z")), "modpack-20261029-2118");
});

// ---------- Cloudflare Access ----------
import {verificarAccess} from "../publicar.mjs";

const EQUIPE = "astral.cloudflareaccess.com";
const AUD = "aud-de-teste";
const EMAIL = "3237049369557647@tutamail.com";

async function chavesRsa() {
  const par = await crypto.subtle.generateKey({name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"}, true, ["sign", "verify"]);
  const publica = {...await crypto.subtle.exportKey("jwk", par.publicKey), kid: "k1"};
  return {privada: par.privateKey, publica};
}

async function jwt(privada, dados, kid = "k1") {
  const b = x => Buffer.from(JSON.stringify(x)).toString("base64url");
  const corpo = `${b({alg: "RS256", kid})}.${b(dados)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privada, new TextEncoder().encode(corpo));
  return `${corpo}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
}

function comAccess(extra = {}) {
  return ambiente({ACCESS_EQUIPE: EQUIPE, ACCESS_AUD: AUD, EMAILS: EMAIL, ...extra});
}

test("Access: só passa JWT assinado pela equipe, com a audiência certa, no prazo e do e-mail do dono", async () => {
  const {privada, publica} = await chavesRsa();
  const outra = await chavesRsa();
  const certs = async url => {
    assert.equal(url, `https://${EQUIPE}/cdn-cgi/access/certs`);
    return Response.json({keys: [publica]});
  };
  const agora = Math.floor(Date.now() / 1000);
  const bom = {iss: `https://${EQUIPE}`, aud: [AUD], email: EMAIL, exp: agora + 600};
  const req = t => new Request(`${base}/`, {headers: {"Cf-Access-Jwt-Assertion": t}});
  const env = comAccess();
  assert.equal((await verificarAccess(req(await jwt(privada, bom)), env, certs)).email, EMAIL);
  assert.equal((await verificarAccess(new Request(`${base}/`, {headers: {Cookie: `CF_Authorization=${await jwt(privada, bom)}`}}), env, certs)).ok, true);
  for (const ruim of [
    {...bom, email: "outra@pessoa.com"},
    {...bom, aud: ["outra-aud"]},
    {...bom, iss: "https://outra.cloudflareaccess.com"},
    {...bom, exp: agora - 10},
  ]) assert.equal((await verificarAccess(req(await jwt(privada, ruim)), env, certs)).ok, false, JSON.stringify(ruim));
  assert.equal((await verificarAccess(req(await jwt(outra.privada, bom)), env, certs)).ok, false, "chave de outra equipe");
  assert.equal((await verificarAccess(new Request(`${base}/`), env, certs)).ok, false, "sem JWT");
  assert.equal((await verificarAccess(req(await jwt(privada, bom)), comAccess({ACCESS_AUD: ""}), certs)).ok, false, "configuração incompleta fecha a porta");
  assert.equal((await verificarAccess(new Request(`${base}/`), ambiente(), certs)).ok, true, "Access ainda não configurado");
});

test("Access ligado: link válido sem login do Access é recusado e avisado no Discord", async () => {
  const avisos = [];
  const fetcher = async (url, opcoes) => {
    if (url.endsWith("/cdn-cgi/access/certs")) return Response.json({keys: []});
    if (url === "https://discord.example/webhook") { avisos.push(JSON.parse(opcoes.body).embeds[0].title); return new Response(null, {status: 204}); }
    throw new Error(url);
  };
  const env = comAccess({DISCORD_WEBHOOK: "https://discord.example/webhook"});
  const t = await link({u: DONO, n: "dvdiso", e: futuro(), r: "a1"});
  const r = await handle(new Request(`${base}/?t=${t}`), env, fetcher);
  assert.equal(r.status, 403);
  assert.deepEqual(avisos, ["Link aberto sem o login do Cloudflare Access"]);
  assert.equal(env.USOS.m.size, 0, "o link não foi queimado");
});

test("avisa no Discord quando o link abre e quando alguém tenta reabrir", async () => {
  const avisos = [];
  const fetcher = async (url, opcoes) => {
    avisos.push(JSON.parse(opcoes.body).embeds[0]);
    return new Response(null, {status: 204});
  };
  const env = ambiente({DISCORD_WEBHOOK: "https://discord.example/webhook"});
  const t = await link({u: DONO, n: "dvdiso", e: futuro(), r: "a2"});
  const pedido = () => new Request(`${base}/?t=${t}`, {headers: {"CF-Connecting-IP": "203.0.113.9"}});
  await handle(pedido(), env, fetcher);
  await handle(pedido(), env, fetcher);
  assert.deepEqual(avisos.map(a => a.title), ["Link de publicação aberto", "Tentativa de reabrir um link já usado"]);
  assert.match(avisos[1].description, /203\.0\.113\.9/);
});

test("voltar: republica a release anterior à do canal, e só ela", async () => {
  const env = ambiente();
  const t = await link({u: DONO, n: "dvdiso", e: futuro(), r: "a3"});
  const cookie = (await handle(new Request(`${base}/?t=${t}`), env)).headers.get("Set-Cookie").split(";")[0];
  const rel = (tag, dia) => ({tag_name: tag, name: tag, draft: false, published_at: `2026-10-${dia}T00:00:00Z`, assets: [{name: "Astral.mrpack"}]});
  let disparo = null;
  const fetcher = async (url, opcoes = {}) => {
    if (url.includes("/releases?per_page")) return Response.json([rel("modpack-20261026-1322", 26), rel("modpack-20261030-1000", 30), rel("modpack-20261029-2034", 29),
      {tag_name: "v1.4.0", name: "app", draft: false, published_at: "2026-10-25T00:00:00Z", assets: []}]);
    if (url.includes("/contents/channel/stable.json")) return Response.json({name: "X", version: "2.6", pack: {url: "https://github.com/r/releases/download/modpack-20261030-1000/A.mrpack"}});
    if (url.endsWith("/actions/workflows/modpack.yml/dispatches")) { disparo = JSON.parse(opcoes.body); return new Response(null, {status: 204}); }
    throw new Error(url);
  };
  const ant = await (await handle(new Request(`${base}/api/anterior`, {headers: {Cookie: cookie}}), env, fetcher)).json();
  assert.equal(ant.atual.tag, "modpack-20261030-1000");
  assert.equal(ant.anterior.tag, "modpack-20261029-2034");
  const pedir = tag => new Request(`${base}/api/desfazer`, {method: "POST", body: JSON.stringify({tag}), headers: {Cookie: cookie, "X-Astral": "desfazer"}});
  assert.equal((await handle(pedir("modpack-20261026-1322"), env, fetcher)).status, 409, "só a imediatamente anterior");
  assert.equal(disparo, null);
  const r = await handle(pedir("modpack-20261029-2034"), env, fetcher);
  assert.equal(r.status, 200);
  assert.deepEqual(disparo, {ref: "main", inputs: {tag: "modpack-20261029-2034"}});
  const sem = await handle(new Request(`${base}/api/desfazer`, {method: "POST", body: "{}", headers: {Cookie: cookie}}), env, fetcher);
  assert.equal(sem.status, 403);
});
