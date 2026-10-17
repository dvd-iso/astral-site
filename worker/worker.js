// ============================================================
//  Astral — intermediário anti-spam para o webhook do Fluxer
//  Roda como Cloudflare Worker. O site manda o pedido para cá,
//  este código valida tudo e só então repassa ao Fluxer.
//
//  Variáveis/segredos (Settings → Variables no painel do Worker):
//    FLUXER_WEBHOOK_URL  (segredo)  URL do webhook do Fluxer
//    TURNSTILE_SECRET    (segredo)  chave secreta do Turnstile
//    ALLOWED_ORIGINS     (texto)    ex: https://astralmc.online,https://dvd-iso.github.io
//    SERVER_NAME         (texto)    ex: Astral (opcional)
//    MAX_PER_HOUR        (texto)    limite global por hora (opcional, padrão 30)
//  Binding KV:
//    RATE_KV             namespace KV usado para os limites
//
//  Sem FLUXER_WEBHOOK_URL, TURNSTILE_SECRET ou RATE_KV o Worker recusa
//  todos os pedidos (falha fechada), em vez de rodar sem proteção.
// ============================================================

const IP_COOLDOWN_S = 10 * 60;   // 1 pedido a cada 10 min por IP
const NICK_COOLDOWN_S = 24 * 3600; // 1 pedido por dia por nick
const MAX_BODY_BYTES = 8 * 1024;

export default {
  async fetch(req, env) {
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
      "X-Content-Type-Options": "nosniff",
    };
    const reply = (status, data) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
      });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return reply(405, { error: "Método não permitido." });
    if (!allowed.includes(origin)) return reply(403, { error: "Origem não permitida." });
    if (!(req.headers.get("Content-Type") || "").startsWith("application/json")) return reply(415, { error: "Pedido inválido." });
    if (!env.FLUXER_WEBHOOK_URL || !env.TURNSTILE_SECRET || !env.RATE_KV) {
      return reply(503, { error: "O envio de pedidos ainda não foi configurado." });
    }

    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return reply(413, { error: "Pedido grande demais." });

    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: "Pedido inválido." }); }
    if (!body || typeof body !== "object") return reply(400, { error: "Pedido inválido." });

    // Honeypot: bots preenchem o campo invisível. Finge sucesso e descarta.
    if (body.website) return reply(200, { ok: true });

    const nick = String(body.nick || "").trim();
    const contato = String(body.contato || "").trim().slice(0, 64);
    const motivo = String(body.motivo || "").trim();
    const estilos = (Array.isArray(body.estilos) ? body.estilos : [])
      .map((s) => String(s).trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 10);

    if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) return reply(400, { error: "Nick inválido." });
    if (!estilos.length) return reply(400, { error: "Escolha pelo menos um estilo de jogo." });
    if (motivo.length < 20 || motivo.length > 1000) return reply(400, { error: "O motivo precisa ter entre 20 e 1000 caracteres." });

    const ip = req.headers.get("CF-Connecting-IP") || "unknown";

    // Captcha (Cloudflare Turnstile): o token vale uma vez só e precisa ter sido gerado no nosso site
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", String(body.turnstile || "").slice(0, 2048));
    form.append("remoteip", ip);
    const check = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const result = await check.json().catch(() => ({}));
    const hosts = allowed.map((o) => { try { return new URL(o).hostname; } catch { return ""; } });
    if (!result.success || !hosts.includes(result.hostname)) {
      return reply(403, { error: "Verificação anti-robô falhou. Recarregue a página e tente de novo." });
    }

    // Limites de envio
    const kv = env.RATE_KV;
    const hourKey = `global:${new Date().toISOString().slice(0, 13)}`;
    if (await kv.get(`ip:${ip}`)) return reply(429, { error: "Você já enviou um pedido há pouco. Aguarde alguns minutos." });
    if (await kv.get(`nick:${nick.toLowerCase()}`)) return reply(429, { error: "Já recebemos um pedido para esse nick hoje. Aguarde a análise da equipe." });
    const count = Number((await kv.get(hourKey)) || 0);
    if (count >= Number(env.MAX_PER_HOUR || 30)) return reply(429, { error: "Muitos pedidos agora. Tente de novo mais tarde." });

    const name = env.SERVER_NAME || "Astral";
    // Texto do usuário não pode mencionar ninguém (@everyone, <@id>, <#canal>), virar link nem quebrar a formatação
    const safe = (s) =>
      s.replace(/@/g, "@​").replace(/<#/g, "<​#").replace(/:\/\//g, ":​//").replace(/`/g, "ˋ");

    const embedPayload = {
      username: `${name} Whitelist`,
      allowed_mentions: { parse: [] },
      embeds: [{
        title: "📝 Novo pedido de whitelist",
        color: 0xa78bfa,
        thumbnail: { url: `https://mc-heads.net/avatar/${nick}/64` },
        fields: [
          { name: "Nick", value: safe(nick), inline: true },
          ...(contato ? [{ name: "Fluxer", value: safe(contato), inline: true }] : []),
          { name: "Estilo de jogo", value: estilos.map(safe).join(", ") },
          { name: "Por que quer jogar", value: safe(motivo).slice(0, 1024) },
        ],
        footer: { text: `/whitelist add ${nick}` },
        timestamp: new Date().toISOString(),
      }],
    };
    const textPayload = {
      username: `${name} Whitelist`,
      allowed_mentions: { parse: [] },
      content: (
        `📝 **Novo pedido de whitelist — ${name}**\n` +
        `**Nick:** ${safe(nick)}\n` +
        (contato ? `**Fluxer:** ${safe(contato)}\n` : "") +
        `**Estilo de jogo:** ${estilos.map(safe).join(", ")}\n` +
        `**Por que quer jogar:**\n>>> ${safe(motivo)}`
      ).slice(0, 2000),
    };

    const post = (payload) =>
      fetch(env.FLUXER_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

    let res = await post(embedPayload);
    // Se o Fluxer recusar o embed (400), manda como texto simples
    if (res.status === 400) res = await post(textPayload);
    if (!res.ok) return reply(502, { error: "Não foi possível enviar agora. Tente novamente em instantes." });

    await Promise.all([
      kv.put(`ip:${ip}`, "1", { expirationTtl: IP_COOLDOWN_S }),
      kv.put(`nick:${nick.toLowerCase()}`, "1", { expirationTtl: NICK_COOLDOWN_S }),
      kv.put(hourKey, String(count + 1), { expirationTtl: 3600 }),
    ]);

    return reply(200, { ok: true });
  },
};
