// Lista della Spesa — Cloudflare Worker
// Stack: KV per lo stato + token HMAC-SHA256 (scadenza 30 giorni), come le altre app.
// Serve il frontend statico (public/) e gestisce /api/*.

const TOKEN_TTL = 30 * 24 * 60 * 60; // 30 giorni in secondi

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// ---- HMAC token ----
function b64url(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
async function sign(payloadObj, secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(payloadObj)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(sig)}`;
}
async function verify(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlToBytes(sig),
    new TextEncoder().encode(payload)
  );
  if (!ok) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

const EMPTY_STATE = { version: 0, products: [], cards: [], deleted: {} };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      // --- login ---
      if (path === "/api/login" && request.method === "POST") {
        const { password } = await request.json().catch(() => ({}));
        if (!password || password !== env.APP_PASSWORD) {
          return json({ error: "Password errata" }, 401);
        }
        const token = await sign(
          { exp: Math.floor(Date.now() / 1000) + TOKEN_TTL },
          env.AUTH_SECRET
        );
        return json({ token });
      }

      // tutte le altre /api richiedono token valido
      const auth = await verify(bearer(request), env.AUTH_SECRET);
      if (!auth) return json({ error: "Non autorizzato" }, 401);

      if (path === "/api/state") {
        if (request.method === "GET") {
          const raw = await env.SPESA.get("state");
          return json(raw ? JSON.parse(raw) : EMPTY_STATE);
        }
        if (request.method === "PUT") {
          const body = await request.json().catch(() => null);
          if (!body || !Array.isArray(body.products) || !Array.isArray(body.cards)) {
            return json({ error: "Stato non valido" }, 400);
          }
          // last-write-wins sulla versione (timestamp client)
          const raw = await env.SPESA.get("state");
          const current = raw ? JSON.parse(raw) : EMPTY_STATE;
          if ((body.version || 0) < (current.version || 0)) {
            // il server è più recente: rispondo con lo stato attuale, il client si riallinea
            return json({ conflict: true, state: current }, 409);
          }
          const toStore = {
            version: body.version || Date.now(),
            products: body.products,
            cards: body.cards,
            // lapidi delle cancellazioni: servono al client per fondere due telefoni
            deleted: body.deleted && typeof body.deleted === "object" ? body.deleted : {},
          };
          await env.SPESA.put("state", JSON.stringify(toStore));
          return json({ ok: true, version: toStore.version });
        }
      }

      return json({ error: "Not found" }, 404);
    }

    // frontend statico
    return env.ASSETS.fetch(request);
  },
};
