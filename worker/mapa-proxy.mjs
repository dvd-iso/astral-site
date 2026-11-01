const ROUTE = /^\/(?:|index\.html|settings\.json|(?:assets|lang|maps)\/[A-Za-z0-9._\/-]+)$/;
const SITE = "https://astralmc.online";
const CSP = `frame-ancestors ${SITE}; object-src 'none'; base-uri 'self'`;
const TIMEOUT = 30000;

function secure(headers) {
  headers.set("Content-Security-Policy", CSP);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.delete("Set-Cookie");
  headers.delete("Server");
  return headers;
}

function page(status, title, description) {
  const headers = secure(new Headers({"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, max-age=0"}));
  return new Response(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Astral</title><style>html{background:#050508}body{margin:0;min-height:100vh;display:grid;place-content:center;gap:8px;padding:16px;box-sizing:border-box;text-align:center;font:14px/1.7 ui-monospace,monospace;color:#e6e3f0}h1{margin:0;color:#f2d58c;font-size:22px}p{margin:0;color:#a19cb5}</style><h1>${title}</h1><p>${description}</p></html>`, {status, headers});
}

/** Proxy HTTPS do BlueMap: só leitura, sem cookies e sem expor o resto da porta. */
export async function handle(request, env, fetcher = fetch) {
  const incoming = new URL(request.url);
  if (!ROUTE.test(incoming.pathname) || incoming.pathname.includes("..")) return page(404, "Não encontrado", "Volte ao mapa em astralmc.online/mapa.");
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = page(405, "Acesso inválido", "O mapa aceita somente leitura.");
    response.headers.set("Allow", "GET, HEAD");
    return response;
  }
  const target = new URL(env.MAPA_ORIGIN);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  // A conexão ao vivo do BlueMap fica aberta enquanto o mapa estiver na tela.
  const live = incoming.pathname.endsWith("/live/sse");
  const forwarded = new Headers({"User-Agent": "Astral-Mapa/1.0"});
  for (const name of ["Accept", "Accept-Encoding", "If-Modified-Since", "If-None-Match"]) {
    const value = request.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  try {
    const upstream = await fetcher(target.href, {
      method: request.method, headers: forwarded, redirect: "manual",
      ...(live ? {} : {signal: AbortSignal.timeout(TIMEOUT)}),
    });
    if (upstream.status >= 500) return page(503, "Mapa indisponível", "O servidor está reiniciando. Tente de novo em instantes.");
    return new Response(upstream.body, {status: upstream.status, statusText: upstream.statusText, headers: secure(new Headers(upstream.headers))});
  } catch {
    return page(503, "Mapa indisponível", "O servidor está reiniciando. Tente de novo em instantes.");
  }
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
