import { newId, randomToken, sha256Hex, otpCode } from "../lib/crypto.js";
import { json, fail, readJson } from "../lib/respond.js";
import { currentAccount, revokeAll } from "../lib/session.js";
import { accountProfile, audit } from "../lib/accounts.js";
import { providerStatus } from "./oidc.js";

/** GET /me — who am I, and what do you hold about me.
 *
 *  This doubles as the data-subject-access response. If a person asks "what
 *  do you have on me", the honest answer should be this endpoint's output,
 *  and if it ever isn't, the schema has grown something it shouldn't have. */
export async function me(request, env) {
  const who = await currentAccount(env, request);
  if (!who) return json({ signedIn: false, providers: providerStatus(env) });
  return json({
    signedIn: true,
    account: { id: who.account_id },
    // The client needs this to derive timeline handles. It goes to the
    // owner's own browser over TLS and nowhere else, and it is the one
    // secret in the system whose loss is recoverable by rotating it.
    surfaceSalt: who.surface_salt,
    ...(await accountProfile(env, who.account_id)),
  });
}

/** POST /me/pair — mint a short code the Mac app can carry across.
 *
 *  Deliberately short-lived and single-use. The code is typed by hand, so
 *  it cannot be long; the compensating control is that it lives for minutes
 *  and dies on first claim. */
export async function startPairing(request, env) {
  const who = await currentAccount(env, request);
  if (!who) return fail(401, "signed_out", "sign in first");

  const code = `${otpCode()}-${otpCode()}`;    // 12 digits, hyphenated to read
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO pairing (code_hash, account_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`)
    .bind(await sha256Hex(code), who.account_id, now, now + 600)
    .run();
  await audit(env, { accountId: who.account_id, action: "device.pair.start",
                     outcome: "ok" });
  return json({ code, expiresIn: 600 });
}

/** POST /pair/claim — { code, label }  (called BY the Mac, unauthenticated)
 *
 *  The only unauthenticated route that hands out a credential, so it is the
 *  one to read carefully. What protects it is that the code is 12 random
 *  digits with a ten-minute life, claimed exactly once, and rate-limited by
 *  IP upstream. What it grants is a device token scoped to one account —
 *  never a session, so a claimed code cannot be turned into a web login. */
export async function claimPairing(request, env) {
  const body = await readJson(request);
  const code = String(body?.code ?? "").trim();
  if (!/^\d{6}-\d{6}$/.test(code)) {
    return fail(400, "bad_code", "that pairing code doesn't look right");
  }
  const now = Math.floor(Date.now() / 1000);

  // Conditional UPDATE, then check `changes` — the same single-use race
  // discipline as the sign-in challenge. Two Macs racing one code: one wins.
  const claimed = await env.DB.prepare(
    `UPDATE pairing SET claimed_at = ?
      WHERE code_hash = ? AND claimed_at IS NULL AND expires_at > ?`)
    .bind(now, await sha256Hex(code), now).run();
  if (!claimed.meta?.changes) {
    return fail(401, "bad_code", "that code has expired or has already been used");
  }

  const row = await env.DB.prepare(
    `SELECT account_id FROM pairing WHERE code_hash = ?`)
    .bind(await sha256Hex(code)).first();

  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO device (id, account_id, label, token_hash, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(newId(), row.account_id,
          String(body?.label ?? "a Mac").slice(0, 60),
          await sha256Hex(token), now, now)
    .run();
  await audit(env, { accountId: row.account_id, action: "device.pair.claim",
                     outcome: "ok" });
  return json({ ok: true, deviceToken: token });
}

/** DELETE /me — close the account.
 *
 *  ON DELETE CASCADE takes identities, sessions, devices and annotations
 *  with it, so this really is a delete and not a flag. The audit rows
 *  survive on purpose: they hold no address and no body, and "an account
 *  was closed at this time" is exactly the record an auditor needs to see
 *  that deletion requests are honoured. */
export async function closeAccount(request, env) {
  const who = await currentAccount(env, request);
  if (!who) return fail(401, "signed_out", "sign in first");

  const body = await readJson(request);
  // A destructive verb gets the same two-tap covenant the app uses
  // everywhere else — here, an explicit confirmation in the payload.
  if (body?.confirm !== "close my account") {
    return fail(400, "confirm",
      'send { "confirm": "close my account" } to go through with it');
  }

  await revokeAll(env, who.account_id);
  await env.DB.prepare(`DELETE FROM account WHERE id = ?`)
    .bind(who.account_id).run();
  await audit(env, { accountId: null, action: "account.close", outcome: "ok" });
  return json({ ok: true }, 200,
    { "Set-Cookie": "zettel_session=; Path=/; Max-Age=0; HttpOnly; Secure" });
}
