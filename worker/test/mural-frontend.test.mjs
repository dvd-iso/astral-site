import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const js = readFileSync(new URL("../../mural.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
class Elemento {
  constructor() { this.children = []; this.listeners = {}; this.attributes = {}; this.hidden = false; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(tipo, fn) { this.listeners[tipo] = fn; }
  setAttribute(nome, valor) { this.attributes[nome] = valor; }
}
function carregar(respostas, {api = "https://loja.example"} = {}) {
  const elementos = new Map(), chamadas = [], timers = new Map();
  const el = s => { if (!elementos.has(s)) elementos.set(s, new Elemento()); return elementos.get(s); };
  let n = 0;
  runInNewContext(js, {
    window: {ASTRAL_CONFIG: {loja: {apiUrl: api}}},
    document: {querySelector: el, createElement: () => new Elemento(), createTextNode: textContent => ({textContent})},
    AbortController,
    setTimeout: fn => { timers.set(++n, fn); return n; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, init) => {
      chamadas.push({url, init});
      const r = respostas.shift();
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r(init) : Response.json(r?.dados ?? {apoiadores: []}, {status: r?.status ?? 200});
    },
    console: {log: () => { throw new Error("Não registrar nicks do mural"); }},
  });
  return {el, chamadas, timers, esperar: () => new Promise(resolve => setImmediate(resolve))};
}

test("mural: região/âncora estáveis no HTML, carregamento visível antes da resposta", async () => {
  assert.doesNotMatch(html.match(/<section[^>]*id="apoiadores"[^>]*>/)[0], /\bhidden\b/);
  assert.match(html, /href="#apoiadores"/);
  assert.match(html, /role="status"[^>]*data-supporters-status/);
  let responder;
  const r = carregar([() => new Promise(resolve => { responder = resolve; })]);
  assert.equal(r.el("[data-supporters]").hidden, false);
  assert.equal(r.el("[data-supporters]").attributes["aria-busy"], "true");
  assert.match(r.el("[data-supporters-status]").textContent, /Carregando/);
  responder(Response.json({apoiadores: []}));
  await r.esperar();
  assert.equal(r.el("[data-supporters]").attributes["aria-busy"], "false");
});

test("mural: agrupa apenas a lista pública em ordem e não consulta conta nem usa credenciais", async () => {
  const r = carregar([{dados: {apoiadores: [{nome: "TesteA", tier: "Galáxia"}, {nome: "TesteB", tier: "Estrela"}, {nome: "TesteC", tier: "Estrela"}]}}]);
  await r.esperar();
  const grupos = r.el("[data-supporters-list]").children;
  assert.equal(grupos.length, 2);
  assert.equal(grupos[0].children[0].children[0].textContent, "Galáxia · 1");
  assert.equal(grupos[1].children[0].children[0].textContent, "Estrela · 2");
  assert.deepEqual(grupos[1].children[1].children.map(li => li.textContent), ["TesteB", "TesteC"]);
  assert.match(r.el("[data-supporters-status]").textContent, /3 apoiadores públicos/);
  assert.equal(r.chamadas.length, 1);
  assert.equal(r.chamadas[0].url, "https://loja.example/api/apoiadores");
  assert.equal(r.chamadas[0].init.credentials, "omit");
  assert.equal(r.chamadas[0].init.cache, "no-store");
  assert.equal(r.el("[data-supporters-retry]").hidden, true);
});

test("mural: zero públicos não desaparece nem cria nomes ou revela quantidade privada", async () => {
  const r = carregar([{dados: {apoiadores: []}}]);
  await r.esperar();
  assert.equal(r.el("[data-supporters]").hidden, false);
  assert.match(r.el("[data-supporters-status]").textContent, /Ainda não há apoiadores públicos/);
  assert.equal(r.el("[data-supporters-list]").children.length, 0);
});

test("mural: HTTP, rede e payload inválido mostram erro e retry recupera sem duplicar grupos", async () => {
  for (const erro of [{status: 503}, new Error("rede indisponível"), {dados: {}}, {dados: {apoiadores: [{}]}}]) {
    const r = carregar([erro, {dados: {apoiadores: [{nome: "TesteA", tier: "Estrela"}]}}]);
    await r.esperar();
    assert.equal(r.el("[data-supporters]").hidden, false);
    assert.match(r.el("[data-supporters-status]").textContent, /Não foi possível/);
    assert.equal(r.el("[data-supporters-list]").children.length, 0);
    assert.equal(r.el("[data-supporters-retry]").hidden, false);
    await r.el("[data-supporters-retry]").listeners.click();
    assert.match(r.el("[data-supporters-status]").textContent, /1 apoiador público/);
    assert.equal(r.el("[data-supporters-list]").children.length, 1);
    assert.equal(r.el("[data-supporters-retry]").hidden, true);
  }
});

test("mural: timeout libera retry; chamadas concorrentes não duplicam consulta e sem API há erro explícito", async () => {
  const r = carregar([({signal}) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout"))))]);
  await r.el("[data-supporters-retry]").listeners.click();
  assert.equal(r.chamadas.length, 1);
  [...r.timers.values()][0]();
  await r.esperar();
  assert.match(r.el("[data-supporters-status]").textContent, /Não foi possível/);
  assert.equal(r.el("[data-supporters-retry]").disabled, false);
  const semApi = carregar([], {api: ""});
  await semApi.esperar();
  assert.equal(semApi.chamadas.length, 0);
  assert.equal(semApi.el("[data-supporters]").hidden, false);
  assert.match(semApi.el("[data-supporters-status]").textContent, /Não foi possível/);
});
