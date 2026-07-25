import { newId, randomToken, sha256Hex } from "./crypto.js";

// Sessions live in an httpOnly cookie, which means JavaScript on the page
// cannot read them — an XSS on the front end can still ACT as the user, but
// it cannot exfiltrate a token that keeps working after the tab closes.
//
// SameSite=Lax is the CSRF control: the browser will not attach this cookie
// to a cross-site POST, so a form on someone else's page cannot drive a
// state change here. It still rides on a top-level GET navigation, which is
// what makes the magic-link click work.
const COOKIE = "zettel_session";
const TTL_SEC = 60 * 60 * 24 * 30;

export function sessionCookie(token, { maxAge = TTL_SEC } = {}) {
  const parts = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  return parts.join("; ");
}

export function clearCookie() {
  return sessionCookie("", { maxAge: 0 });
}

export function readCookie(request) {
  const header = request.headers.get("Cookie") || "";
  for (const piece of header.split(";")) {
    const [name, ...rest] = piece.trim().split("=");
    if (name === COOKIE) return rest.join("=") || null;
  }
  return null;
}

export async function createSession(env, accountId, request) {
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO session
       (id, account_id, token_hash, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId(), accountId, await sha256Hex(token), now, now + TTL_SEC, now,
          (request.headers.get("User-Agent") || "").slice(0, 200))
    .run();
  return token;
}

/** The account behind this request, or null.
 *
 *  Looks up by HASH — the token itself is never stored, so this is also the
 *  only way it COULD work. Expiry and revocation are checked in SQL rather
 *  than in JS so a row that has been revoked on another device cannot be
 *  used by a stale read here. */
export async function currentAccount(env, request) {
  const token = readCookie(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, a.id AS account_id, a.status, a.surface_salt
       FROM session s
       JOIN account a ON a.id = s.account_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?`)
    .bind(await sha256Hex(token), Math.floor(Date.now() / 1000))
    .first();
  if (!row || row.status !== "active") return null;
  return row;
}

/** Sign out everywhere. Revoking rather than deleting keeps the audit trail
 *  intact — "when did this session end" is a question an incident response
 *  needs to answer. */
export async function revokeAll(env, accountId) {
  await env.DB.prepare(
    `UPDATE session SET revoked_at = ?
      WHERE account_id = ? AND revoked_at IS NULL`)
    .bind(Math.floor(Date.now() / 1000), accountId)
    .run();
}

export async function revokeOne(env, sessionId) {
  await env.DB.prepare(
    `UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(Math.floor(Date.now() / 1000), sessionId)
    .run();
}
