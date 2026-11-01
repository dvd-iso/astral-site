import assert from "node:assert/strict";
import test from "node:test";
import worker, {handle} from "../mapa-proxy.mjs";

const env = {MAPA_ORIGIN: "http://sp-13.magnohost.com.br:25529"};
const base = "https://astral-mapa.example";

test("encaminha o mapa sem cookies e permite o quadro só no site", async () => {
  let captured;
  const response = await handle(new Request(`${base}/maps/world/tiles/0/x1/z2.prbm`, {
    headers: {Cookie: "privado=1", Authorization: "Bearer privado", "Accept-Encoding": "gzip"},
  }), env, async (url, options) => {
    captured = {url, options};
    return new Response("tile", {headers: {"Set-Cookie": "a=1", "Cache-Control": "public, max-age=86400"}});
  });
  assert.equal(captured.url, `${env.MAPA_ORIGIN}/maps/world/tiles/0/x1/z2.prbm`);
  assert.equal(captured.options.headers.get("Cookie"), null);
  assert.equal(captured.options.headers.get("Authorization"), null);
  assert.equal(captured.options.headers.get("Accept-Encoding"), "gzip");
  assert.ok(captured.options.signal);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=86400");
  assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors https:\/\/astralmc\.online/);
  assert.equal(await response.text(), "tile");
});

test("a conexão ao vivo não tem tempo limite", async () => {
  let captured;
  await handle(new Request(`${base}/maps/world/live/sse`), env, async (url, options) => {
    captured = options;
    return new Response("data: {}\n\n", {headers: {"Content-Type": "text/event-stream"}});
  });
  assert.equal(captured.signal, undefined);
});

test("recusa escrita, sql.php e caminhos fora do mapa", async () => {
  const never = async () => assert.fail("não deveria chamar o servidor");
  assert.equal((await handle(new Request(`${base}/sql.php`), env, never)).status, 404);
  assert.equal((await handle(new Request(`${base}/maps/../sql.php`.replace("/../", "/%2e%2e/")), env, never)).status, 404);
  assert.equal((await handle(new Request(`${base}/maps/a/../../x`.replace(/\.\./g, "..%2f")), env, never)).status, 404);
  assert.equal((await handle(new Request(`${base}/`, {method: "POST", body: "x"}), env, never)).status, 405);
});

test("avisa quando o servidor está fora", async () => {
  const fora = await handle(new Request(`${base}/`), env, async () => { throw new Error("recusada"); });
  assert.equal(fora.status, 503);
  assert.match(await fora.text(), /Mapa indisponível/);
  const erro = await handle(new Request(`${base}/settings.json`), env, async () => new Response("x", {status: 500}));
  assert.equal(erro.status, 503);
});

test("o handler de produção não recebe o contexto como fetch", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("ok"));
  const response = await worker.fetch(new Request(`${base}/`), env, {waitUntil() {}});
  assert.equal(await response.text(), "ok");
});
