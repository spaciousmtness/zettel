// Every response leaves through here, so the headers cannot be forgotten on
// the one route that needed them.

// A JSON API that never renders HTML still gets a CSP: it is what turns a
// reflected-content mistake into a blocked frame instead of an exploit, and
// it costs one header. `frame-ancestors 'none'` is the one that matters —
// it stops this origin being framed for a clickjacked state-changing POST.
const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...extra },
  });
}

/** An error the caller is allowed to read.
 *
 *  `code` is stable and machine-readable; `message` is for a human and is
 *  written to be true without being useful to someone probing. Notably we
 *  never say "no account with that email" — see routes/auth.js. */
export function fail(status, code, message, extra = {}) {
  return json({ error: { code, message } }, status, extra);
}

/** CORS, deliberately narrow.
 *
 *  Credentials ride in a cookie, so `*` is not an option — the browser
 *  refuses it with credentials anyway, and a reflected Origin with
 *  Allow-Credentials is the classic way to turn a CORS header into an
 *  account-takeover. Only origins named in config are ever echoed. */
export function cors(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Vary": "Origin",
  };
}

/** Parse a JSON body without letting a malformed one become a 500, and
 *  without letting an enormous one become a memory bill. */
export async function readJson(request, maxBytes = 64 * 1024) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) return null;
  let text;
  try { text = await request.text(); } catch { return null; }
  if (text.length > maxBytes) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value : null;
  } catch { return null; }
}
