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

/** The per-destination cap, counted in SQL rather than KV.
 *
 *  This one has to be EXACT, and KV cannot be. A `get` may be served from the
 *  colo cache for up to 60 seconds after a `put`, so with a one-hour window
 *  and a limit of five, every request in the first minute reads the same
 *  stale count. A script pointed at one victim's number for thirty seconds
 *  sails past the cap and Twilio sends thousands of messages — the precise
 *  attack the limiter exists to stop, and the in-memory test KV could never
 *  have shown it.
 *
 *  D1 is strongly consistent, and we are already writing a `challenge` row
 *  per send, so the count is free and correct: the evidence of the sends IS
 *  the rate limit. */
export async function sentRecently(env, kind, value, windowSec) {
  if (!env.DB) return 0;
  const since = Math.floor(Date.now() / 1000) - windowSec;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM challenge
      WHERE kind = ? AND value = ? AND created_at > ?`)
    .bind(kind, value, since).first();
  return Number(row?.n) || 0;
}

/** Two limits on every credential-sending route.
 *
 *  Per DESTINATION — exact, counted in D1 by the caller, because approximate
 *  is not good enough when the failure mode is somebody's phone ringing all
 *  night and a bill.
 *
 *  Per SOURCE — approximate is fine, and KV is the cheap way to get it: this
 *  only has to make spraying the whole address space from one host expensive,
 *  and a few extra attempts at a window boundary cost nothing. */
export async function guardSend(env, request) {
  return rateLimit(env, `ip:${clientIp(request)}`, { limit: 30, windowSec: 3600 });
}
