// A fixed-window counter in KV.
//
// Not a token bucket and not exact: two requests landing in the same
// millisecond on two edge locations can both read the same count and both
// write count+1, so a determined caller gets a handful of extra attempts at
// a window boundary. That is an acceptable trade here, because this is not
// the thing standing between an attacker and an account — the six-digit
// code has its OWN per-challenge attempt counter in SQL, which is exact and
// transactional. This layer exists to stop the cheap, loud attacks: someone
// pointing a script at /auth/phone/start to burn your SMS budget, or
// enumerating addresses at volume.
//
// If that ever stops being enough, the upgrade is a Durable Object, which
// gives real serialisation. It is deliberately not that yet.

/** Returns { ok, remaining, retryAfter }. Never throws: a rate limiter that
 *  goes down must not take authentication down with it — it FAILS OPEN and
 *  says so on the response, rather than locking every user out because KV
 *  had a bad minute. */
export async function rateLimit(env, key, { limit, windowSec }) {
  if (!env.RATE) return { ok: true, remaining: limit, degraded: true };
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSec);
  const slot = `rl:${key}:${window}`;
  try {
    const current = Number(await env.RATE.get(slot)) || 0;
    if (current >= limit) {
      return { ok: false, remaining: 0, retryAfter: (window + 1) * windowSec - now };
    }
    // expirationTtl gives us cleanup for free; without it these keys
    // accumulate forever and the bill is the bug.
    await env.RATE.put(slot, String(current + 1),
      { expirationTtl: Math.max(60, windowSec * 2) });
    return { ok: true, remaining: limit - current - 1 };
  } catch {
    return { ok: true, remaining: limit, degraded: true };
  }
}

/** The caller's address, as seen by Cloudflare. `CF-Connecting-IP` is set by
 *  the edge and cannot be spoofed by the client; X-Forwarded-For CAN be, so
 *  it is only consulted as a last resort and never trusted for anything
 *  that matters. */
export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Real-IP")
    || "unknown";
}

/** Two limits on every credential-sending route: one per destination (you
 *  cannot be spammed with codes) and one per source (a script cannot spray
 *  the whole address space from one host). Both must pass. */
export async function guardSend(env, request, destination) {
  const ip = clientIp(request);
  const perDestination = await rateLimit(env, `dst:${destination}`,
    { limit: 5, windowSec: 3600 });
  if (!perDestination.ok) return perDestination;
  return rateLimit(env, `ip:${ip}`, { limit: 30, windowSec: 3600 });
}
