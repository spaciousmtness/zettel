import { newId, otpCode, randomToken, sha256Hex, timingSafeEqual }
  from "../lib/crypto.js";
import { normalizeEmail, normalizePhone } from "../lib/validate.js";
import { guardSend } from "../lib/ratelimit.js";
import { json, fail, readJson } from "../lib/respond.js";
import { accountForIdentity, audit } from "../lib/accounts.js";
import { createSession, sessionCookie, currentAccount } from "../lib/session.js";
import { sendEmail, sendSms } from "../lib/deliver.js";

const CODE_TTL = 10 * 60;        // a code you have to go and find on a phone
const LINK_TTL = 15 * 60;
const MAX_ATTEMPTS = 5;

// The same answer whether or not the address exists.
//
// "no account with that email" is a free account-enumeration oracle, and it
// is worth more to an attacker than it sounds: it turns a breach dump from
// another service into a list of confirmed Zettel users, which is exactly
// the population worth phishing. The cost of closing it is that a typo'd
// address looks like a success — which is why the copy says "if that
// address is one we can reach" rather than "sent".
const SENT = { ok: true, message: "if we can reach that, a code is on its way" };

/** POST /auth/email/start — { email } */
export async function emailStart(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!email) return fail(400, "bad_email", "that address doesn't look complete");

  const gate = await guardSend(env, request, `email:${email}`);
  if (!gate.ok) {
    await audit(env, { action: "signin.email.start", outcome: "denied",
                       meta: { reason: "rate" } });
    return fail(429, "slow_down", "too many requests — try again shortly",
      { "Retry-After": String(gate.retryAfter || 60) });
  }

  const secret = randomToken();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO challenge
       (id, kind, value, secret_hash, created_at, expires_at)
     VALUES (?, 'email', ?, ?, ?, ?)`)
    .bind(newId(), email, await sha256Hex(secret), now, now + LINK_TTL)
    .run();

  const link = `${env.PUBLIC_ORIGIN}/auth/email/callback` +
    `?t=${encodeURIComponent(secret)}&e=${encodeURIComponent(email)}`;
  await sendEmail(env, email, link);
  await audit(env, { action: "signin.email.start", outcome: "ok" });
  return json(SENT);
}

/** GET /auth/email/callback?t=&e= — the click.
 *
 *  A GET that changes state is normally a smell, but a link in an inbox can
 *  only ever be a GET. What makes it safe is that the secret is single-use
 *  and short-lived, and that the thing it grants is a session for the
 *  address the secret was minted for — an attacker who replays it gets
 *  nothing they did not already have. */
export async function emailCallback(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("t") || "";
  const email = normalizeEmail(url.searchParams.get("e"));
  if (!secret || !email) return redirectTo(env, "/?signin=bad");

  const consumed = await consumeChallenge(env, "email", email, secret);
  if (!consumed.ok) {
    await audit(env, { action: "signin.email.verify", outcome: "denied",
                       meta: { reason: consumed.reason } });
    return redirectTo(env, `/?signin=${consumed.reason}`);
  }

  const { accountId, created } = await accountForIdentity(env,
    { kind: "email", value: email });
  const token = await createSession(env, accountId, request);
  await audit(env, { accountId, action: "signin.email.verify", outcome: "ok",
                     meta: { created } });
  return redirectTo(env, "/app/", { "Set-Cookie": sessionCookie(token) });
}

/** POST /auth/phone/start — { phone } */
export async function phoneStart(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  if (!phone) {
    return fail(400, "bad_phone",
      "that number needs a country code — like +1 555 000 0000");
  }

  const gate = await guardSend(env, request, `phone:${phone}`);
  if (!gate.ok) {
    await audit(env, { action: "signin.phone.start", outcome: "denied",
                       meta: { reason: "rate" } });
    return fail(429, "slow_down", "too many requests — try again shortly",
      { "Retry-After": String(gate.retryAfter || 60) });
  }

  const code = otpCode();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO challenge
       (id, kind, value, secret_hash, created_at, expires_at)
     VALUES (?, 'phone', ?, ?, ?, ?)`)
    .bind(newId(), phone, await sha256Hex(code), now, now + CODE_TTL)
    .run();

  await sendSms(env, phone, code);
  await audit(env, { action: "signin.phone.start", outcome: "ok" });
  return json(SENT);
}

/** POST /auth/phone/verify — { phone, code } */
export async function phoneVerify(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  const code = String(body?.code ?? "").trim();
  if (!phone || !/^\d{6}$/.test(code)) {
    return fail(400, "bad_code", "that code doesn't look right");
  }

  const consumed = await consumeChallenge(env, "phone", phone, code);
  if (!consumed.ok) {
    await audit(env, { action: "signin.phone.verify", outcome: "denied",
                       meta: { reason: consumed.reason } });
    return fail(consumed.reason === "attempts" ? 429 : 401, consumed.reason,
      consumed.reason === "attempts"
        ? "too many tries — ask for a new code"
        : "that code has expired or has already been used");
  }

  const { accountId, created } = await accountForIdentity(env,
    { kind: "phone", value: phone });
  const token = await createSession(env, accountId, request);
  await audit(env, { accountId, action: "signin.phone.verify", outcome: "ok",
                     meta: { created } });
  return json({ ok: true, created }, 200, { "Set-Cookie": sessionCookie(token) });
}

/** The one place a challenge is spent.
 *
 *  Three things have to be true and all three are enforced here rather than
 *  at the call sites, because a verifier that is right in three places and
 *  wrong in a fourth is the same as being wrong:
 *
 *    - the secret matches, compared in constant time
 *    - it has not expired and has not already been spent
 *    - it has not been guessed at more than MAX_ATTEMPTS times
 *
 *  Consumption is a conditional UPDATE, and we check how many rows it
 *  actually changed. Two requests racing with the same valid code both read
 *  the row as unconsumed; only one of them gets `changes === 1`. Checking
 *  in JS after a SELECT would let both through. */
async function consumeChallenge(env, kind, value, secret) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT id, secret_hash, attempts FROM challenge
      WHERE kind = ? AND value = ? AND consumed_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`)
    .bind(kind, value, now)
    .first();
  if (!row) return { ok: false, reason: "expired" };

  if (row.attempts >= MAX_ATTEMPTS) {
    // burn it: a code that has been guessed at five times is not a code
    // anyone should still be able to use, including its rightful owner
    await env.DB.prepare(`UPDATE challenge SET consumed_at = ? WHERE id = ?`)
      .bind(now, row.id).run();
    return { ok: false, reason: "attempts" };
  }

  const presented = await sha256Hex(secret);
  if (!timingSafeEqual(presented, row.secret_hash)) {
    await env.DB.prepare(
      `UPDATE challenge SET attempts = attempts + 1 WHERE id = ?`)
      .bind(row.id).run();
    return { ok: false, reason: "expired" };   // same word as a miss: no oracle
  }

  const spent = await env.DB.prepare(
    `UPDATE challenge SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL`)
    .bind(now, row.id).run();
  if (!spent.meta?.changes) return { ok: false, reason: "expired" };
  return { ok: true };
}

function redirectTo(env, path, extra = {}) {
  return new Response(null, {
    status: 303,
    headers: { Location: `${env.PUBLIC_ORIGIN}${path}`,
               "Cache-Control": "no-store", ...extra },
  });
}

/** POST /auth/signout */
export async function signOut(request, env) {
  const who = await currentAccount(env, request);
  if (who) {
    await env.DB.prepare(`UPDATE session SET revoked_at = ? WHERE id = ?`)
      .bind(Math.floor(Date.now() / 1000), who.session_id).run();
    await audit(env, { accountId: who.account_id, action: "signout",
                       outcome: "ok" });
  }
  return json({ ok: true }, 200,
    { "Set-Cookie": sessionCookie("", { maxAge: 0 }) });
}
