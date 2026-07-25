import { newId, randomToken } from "./crypto.js";

/** Write an audit row. Never throws — an audit failure must not fail the
 *  request it is describing, or the log becomes a denial-of-service surface
 *  on the whole product. `meta` is small JSON and is checked at every call
 *  site to hold no address, no body and no token. */
export async function audit(env, { accountId = null, action, outcome, meta }) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit (id, at, account_id, action, outcome, meta)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(newId(), Math.floor(Date.now() / 1000), accountId, action, outcome,
            meta ? JSON.stringify(meta).slice(0, 512) : null)
      .run();
  } catch { /* the log is evidence, not a dependency */ }
}

/** Resolve a verified identity to an account, creating one if this is the
 *  first time we have seen it.
 *
 *  This is the join point for "signed up by phone, came back with Google".
 *  It is ONLY ever called with an identifier the caller has already
 *  verified — a code that matched, or a token whose signature checked out.
 *  Calling it with an unverified address would let anyone claim any
 *  account, so there is no code path that does.
 *
 *  `linkTo` merges a new identity into an EXISTING signed-in account. That
 *  is the safe direction. The unsafe direction — auto-merging two accounts
 *  because a provider asserts the same email — is deliberately not
 *  implemented: it lets a provider that mis-verifies an address take over
 *  an account, and it is the classic OIDC account-linking hole. */
export async function accountForIdentity(env, { kind, value, linkTo = null }) {
  const now = Math.floor(Date.now() / 1000);

  const existing = await env.DB.prepare(
    `SELECT account_id FROM identity WHERE kind = ? AND value = ?`)
    .bind(kind, value)
    .first();

  if (existing) {
    await env.DB.prepare(
      `UPDATE identity SET verified_at = ? WHERE kind = ? AND value = ?`)
      .bind(now, kind, value).run();
    return { accountId: existing.account_id, created: false };
  }

  if (linkTo) {
    await env.DB.prepare(
      `INSERT INTO identity (id, account_id, kind, value, verified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(newId(), linkTo, kind, value, now, now).run();
    return { accountId: linkTo, created: false };
  }

  const accountId = newId();
  // The surface salt never leaves with a response body except once, to the
  // owner's own client, which needs it to derive timeline handles. Rotating
  // it is the delete button for every annotation on this account.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO account (id, created_at, status, surface_salt)
       VALUES (?, ?, 'active', ?)`)
      .bind(accountId, now, randomToken()),
    env.DB.prepare(
      `INSERT INTO identity (id, account_id, kind, value, verified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(newId(), accountId, kind, value, now, now),
  ]);
  return { accountId, created: true };
}

/** Everything we hold about a person, for the account screen and for a
 *  data-subject request. If this function cannot show it, we should not
 *  have it — that is the test to run against this file when the schema
 *  changes. */
export async function accountProfile(env, accountId) {
  const identities = await env.DB.prepare(
    `SELECT kind, value, verified_at FROM identity
      WHERE account_id = ? ORDER BY created_at`)
    .bind(accountId).all();
  const devices = await env.DB.prepare(
    `SELECT id, label, created_at, last_seen_at FROM device
      WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at`)
    .bind(accountId).all();
  const counted = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM annotation
      WHERE account_id = ? AND deleted_at IS NULL`)
    .bind(accountId).first();
  return {
    identities: (identities.results || []).map((r) => ({
      kind: r.kind,
      // the last four of a phone, the domain of an email: enough to
      // recognise which of your addresses this is, not enough to be a
      // useful leak if the response is ever logged somewhere it shouldn't
      hint: r.kind === "phone" ? `••••${r.value.slice(-4)}`
          : r.kind === "email" ? r.value.replace(/^(.).*(@.*)$/, "$1•••$2")
          : "linked",
      verified: !!r.verified_at,
    })),
    devices: devices.results || [],
    annotations: counted?.n ?? 0,
  };
}
