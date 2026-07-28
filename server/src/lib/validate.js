// Normalising an identifier is a security control, not a formatting nicety.
//
// `identity` has UNIQUE (kind, value). If "+1 555 000 0000" and
// "+15550000000" normalise differently they become two accounts for one
// person, and the Z layer splits in half — which is the exact failure the
// app already documents on the client side ("one person is many chat rows").
// Worse, an attacker who can produce a second spelling of an address you
// already own gets a second, unlinked account with your name on it.

/** Lowercased, trimmed. The local part is technically case-sensitive per
 *  RFC 5321, and in practice no provider on earth honours that — treating
 *  it as case-sensitive would mean Melissa@ and melissa@ are two people.
 *  We do NOT strip Gmail dots or +tags: those are real, deliverable
 *  addresses, and collapsing them decides on the user's behalf that two
 *  addresses they may have deliberately kept apart are the same account. */
export function normalizeEmail(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value.length > 254) return null;
  // one @, something either side, a dot in the domain, no whitespace
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(value)) return null;
  return value;
}

/** E.164, or null.
 *
 *  Deliberately refuses to guess a country. A bare "5550000137" could be
 *  US, and could equally be a local number in a dozen other places; the
 *  README's own note about truncating to ten digits colliding +1 and +91
 *  is the same bug from the other end. If it does not carry a country
 *  code, we ask for one rather than inventing it.
 *
 *  Accepts a leading 00 as an alias for + (common outside North America),
 *  and strips the spaces, dashes and brackets people actually type. */
export function normalizePhone(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith("00")) value = "+" + value.slice(2);
  if (!value.startsWith("+")) return null;
  const digits = value.slice(1).replace(/[\s\-().]/g, "");
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;   // E.164: 8..15, no leading 0
  return "+" + digits;
}

/** A timeline handle from the client. Opaque to us by design, so the only
 *  thing to check is that it LOOKS opaque: if someone hands us a raw phone
 *  number here, we refuse it rather than quietly storing it. That refusal
 *  is what keeps the boundary honest when a future client is careless. */
export function normalizeTimeline(raw) {
  const value = String(raw ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(value)) return null;    // sha256/hmac hex
  return value;
}

/** Annotation kinds the schema will accept. Mirrors the CHECK constraint —
 *  better a 400 with a readable message than a database error. */
export const ANNOTATION_KINDS =
  new Set(["ink", "note", "mark", "chapter", "reading"]);

/** The Z layer's coordinate, validated.
 *
 *  t0/t1 are unix seconds and MUST be finite and ordered. `y` is the
 *  normalised height on the sheet and is only meaningful for ink. Rejecting
 *  a non-finite anchor here is what stops a NaN reaching the sync index and
 *  making a row that can never be selected again. */
export function normalizeAnchor(body) {
  const t0 = Number(body?.t0);
  const t1 = Number(body?.t1 ?? body?.t0);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  // ~1970..2100. A timestamp outside this is a unit error (milliseconds
  // passed as seconds is the usual one) and silently storing it puts a
  // mark 50,000 years into the future where no view will ever show it.
  if (t0 < 0 || t0 > 4102444800 || t1 < 0 || t1 > 4102444800) return null;
  const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  let y = body?.y === undefined || body?.y === null ? null : Number(body.y);
  if (y !== null) {
    if (!Number.isFinite(y)) return null;
    y = Math.max(0, Math.min(1, y));
  }
  return { t0: lo, t1: hi, y };
}
