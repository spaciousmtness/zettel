import { newId } from "../lib/crypto.js";
import { json, fail, readJson } from "../lib/respond.js";
import { normalizeEmail, normalizePhone } from "../lib/validate.js";
import { guardSend } from "../lib/ratelimit.js";
import { audit } from "../lib/accounts.js";

/** POST /access — the landing page's door.
 *
 *  Answers the same way whether the address is new or already on the list.
 *  Two reasons: it is one fewer enumeration oracle, and it means somebody
 *  who forgot they signed up is not told "you already did this" in a tone
 *  that reads as a rejection. */
export async function requestAccess(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!email) return fail(400, "bad_email", "that address doesn't look complete");

  // Optional field: a number that fails to parse is DROPPED, not fatal.
  // Refusing the whole signup over an optional field is how you lose the
  // person who typed their number without a country code.
  const phone = normalizePhone(body?.phone);

  const gate = await guardSend(env, request);
  if (!gate.ok) {
    return fail(429, "slow_down", "too many requests — try again shortly",
      { "Retry-After": String(gate.retryAfter || 60) });
  }

  const source = String(body?.source ?? "").slice(0, 64) || "landing";
  await env.DB.prepare(
    `INSERT INTO access_request (id, email, phone, source, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       phone = COALESCE(excluded.phone, access_request.phone)`)
    .bind(newId(), email, phone, source, Math.floor(Date.now() / 1000))
    .run();

  await audit(env, { action: "access.request", outcome: "ok",
                     meta: { source, phone: !!phone } });
  return json({ ok: true, message: "you're on the list" });
}
