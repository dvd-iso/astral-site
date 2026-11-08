// DOM mínimo para executar o JS real sem dependências; não substitui inspeção visual em navegador.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const js = readFileSync(new URL("../../loja.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../loja.html", import.meta.url), "utf8");
class Elemento {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.listeners = {}; this.hidden = false; this.dataset = {}; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(evento, fn) { this.listeners[evento] = fn; }
  remove() {}
}
const tiers = () => [
  {id: "apoio_20", nome: "Estrela", preco_centavos: 2000, prisma_quantidade: 200},
  {id: "apoio_50", nome: "Constelação", preco_centavos: 5000, prisma_quantidade: 600},
  {id: "apoio_100", nome: "Galáxia", preco_centavos: 10000, prisma_quantidade: 1200},
].map(p => ({...p, tipo: "apoio", ativo: true, a_venda: true, descricao: `${p.prisma_quantidade} Prisma a cada novo apoio pago. Cargo e mural.`}));

async function carregar({produtos = tiers(), total = 2000, assinatura = null, pedido = null, query = "", falhaCatalogo = false} = {}) {
  const elementos = new Map();
  const el = s => { if (!elementos.has(s)) elementos.set(s, new Elemento()); return elementos.get(s); };
  const chamadas = [];
  const conta = {jogador: {nome: "dvdiso"}, direitos: [{produto_id: "apoio_20", estado: "ativo"}], apoio_total: total, assinatura};
  const storage = new Map([["astral-loja-sessao", "sessao-teste"]]);
  runInNewContext(js, {
    window: {ASTRAL_CONFIG: {loja: {apiUrl: "https://loja.example"}}},
    document: {querySelector: el, querySelectorAll: () => [], createElement: tag => new Elemento(tag)},
    localStorage: {getItem: k => storage.get(k), removeItem: k => storage.delete(k)},
    sessionStorage: {getItem: () => null}, location: {search: query, assign: () => {}}, URL, URLSearchParams,
    setTimeout: () => {}, clearTimeout: () => {},
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      chamadas.push({path, init});
      if (path === "/api/catalogo") return falhaCatalogo ? Response.json({}, {status: 503}) : Response.json({produtos});
      if (path === "/api/conta") return Response.json(conta);
      if (path.endsWith("/cancelar")) { conta.assinatura = null; return Response.json({ok: true}); }
      if (pedido && path.startsWith("/api/pedidos/")) return Response.json(pedido);
      return Response.json({erro: "checkout_indisponivel"}, {status: 502});
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return {el, chamadas};
}
const botao = (el, index) => el("[data-apoio]").children[index].children.at(-1);

test("frontend apoio: HTML só oferece avulso; tooltip de upgrade e repetição usa diferenças corretas", async () => {
  assert.doesNotMatch(html, /data-apoio-email|data-modo="mensal"|Todo mês \(cartão\)/);
  assert.match(html, /200 Prisma/);
  assert.match(html, /600 Prisma/);
  assert.match(html, /1200 Prisma/);
  const {el} = await carregar();
  assert.equal(botao(el, 0).textContent, "Apoiar de novo");
  assert.match(botao(el, 0).title, /200 Prisma novamente/);
  assert.match(botao(el, 1).textContent, /30,00/);
  assert.match(botao(el, 1).title, /400 Prisma.*diferença/);
  assert.match(botao(el, 2).title, /1000 Prisma/);
  const efetivo = index => el("[data-apoio]").children[index].children.find(c => c.className === "tiny tier-effective");
  assert.match(efetivo(0).textContent, /20,00 e 200 Prisma/);
  assert.match(efetivo(1).textContent, /30,00 e 400 Prisma/);
  assert.match(efetivo(2).textContent, /80,00 e 1000 Prisma/);
  assert.equal(efetivo(1).hidden, false, "quantidade aparece em texto visível, não só em title");
  assert.doesNotMatch(html, /Itens sob medida e personagens na lore não são benefícios/);
  assert.match(html, /Seu pet tem a mesma aparência da foto/);
  assert.doesNotMatch(html, /a do seu pet é escolhida pela sua conta|pode ser diferente da foto/);
});

test("frontend apoio: quantidade efetiva visível acompanha catálogo e não inventa base ausente", async () => {
  const produtos = tiers();
  produtos[1].prisma_quantidade = 650;
  const {el} = await carregar({produtos});
  const card = el("[data-apoio]").children[1];
  assert.match(card.children.find(c => c.className === "tiny tier-effective").textContent, /30,00 e 450 Prisma/);
  delete produtos[0].prisma_quantidade;
  const incompleto = await carregar({produtos});
  assert.equal(botao(incompleto.el, 1).disabled, true);
  assert.equal(incompleto.el("[data-apoio]").children[1].children.filter(c => c.className === "tiny tier-effective").length, 0);
});

test("frontend apoio: API antiga não oferece mensal nem promete benefícios removidos; avulso sem snapshot fica fechado", async () => {
  const produtos = tiers().map(({prisma_quantidade, ...p}) => ({...p, descricao: "Um item especial. Um personagem na lore."}));
  produtos.push({tipo: "apoio_mensal", ativo: true, a_venda: true, preco_centavos: 2000, id: "apoio_mensal_20"});
  const {el, chamadas} = await carregar({produtos});
  assert.equal(el("[data-apoio]").children.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(botao(el, i).disabled, true);
    assert.equal(botao(el, i).textContent, "Oferta em atualização");
    const perks = el("[data-apoio]").children[i].children[2].children.map(c => c.textContent).join(" ");
    assert.doesNotMatch(perks, /item especial|personagem/);
  }
  assert.ok(!chamadas.some(c => c.path === "/api/assinaturas"));
});

test("frontend apoio: gestão/cancelamento legado visível mesmo sem catálogo de tiers ativos", async () => {
  const assinatura = {id: "legado", nome: "Apoio mensal de R$ 20", estado: "autorizada"};
  const {el, chamadas} = await carregar({produtos: [], assinatura});
  assert.equal(el("[data-apoio-secao]").hidden, false);
  assert.equal(el("[data-assinatura]").hidden, false);
  assert.match(el("[data-assinatura-texto]").textContent, /ativa/);
  const btn = el("[data-assinatura-cancelar]");
  await btn.listeners.click({currentTarget: btn});
  assert.ok(chamadas.some(c => c.path === "/api/assinaturas/legado/cancelar" && c.init.method === "POST"));
  const falha = await carregar({falhaCatalogo: true, assinatura});
  assert.equal(falha.el("[data-assinatura]").hidden, false, "falha de catálogo não esconde gestão financeira legada");
});

test("frontend apoio: retorno usa a quantidade do pedido, não catálogo; pedido antigo não promete crédito", async () => {
  const query = "?pedido=11111111-2222-4333-8444-555555555555";
  const pedido = {produto_id: "apoio_50", produto: "Constelação", valor_centavos: 3000, estado: "pago", prisma_quantidade: 400};
  let r = await carregar({pedido, query});
  assert.match(r.el("[data-order-status]").textContent, /400 Prisma creditada/);
  assert.doesNotMatch(r.el("[data-order-status]").textContent, /equipe vai falar|item ou personagem/);
  delete pedido.prisma_quantidade;
  r = await carregar({pedido, query});
  assert.doesNotMatch(r.el("[data-order-status]").textContent, /Prisma creditada/);
  pedido.estado = "reembolsado";
  r = await carregar({pedido, query});
  assert.doesNotMatch(r.el("[data-order-status]").textContent, /Prisma/);
});

test("frontend apoio: falha ao abrir checkout preserva texto do botão de apoio", async () => {
  const {el} = await carregar();
  const btn = botao(el, 1);
  const antes = btn.textContent;
  await btn.listeners.click();
  assert.equal(btn.textContent, antes);
  assert.equal(btn.disabled, false);
});
