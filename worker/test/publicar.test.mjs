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
