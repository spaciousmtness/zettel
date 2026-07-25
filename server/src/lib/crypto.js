// Every secret in this system is generated here and compared here.
//
// Two rules the rest of the code depends on:
//   1. A secret is generated from the CSPRNG and handed out exactly once.
//      What we keep is its SHA-256. A dump of the database is not a set of
//      working credentials.
//   2. A secret is compared in constant time. String === leaks the length
//      of the matching prefix, which is enough to walk a token out of a
//      server one byte at a time given enough attempts.
//
// WebCrypto only — the same code runs on Workers and under `node --test`,
// so the thing the tests exercise is the thing that ships.

const enc = new TextEncoder();

/** Raw bytes from the CSPRNG. */
export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** base64url, no padding — safe in a URL, a cookie, and a header. */
export function b64url(bytes) {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A bearer secret: 32 bytes of entropy. Session cookies, device tokens,
 *  magic-link secrets. 256 bits is not a place to economise. */
export function randomToken() {
  return b64url(randomBytes(32));
}

/** A sortable, collision-resistant id: 48 bits of time, 80 bits of random.
 *  Time-ordered so primary-key inserts stay sequential and an id sorts
 *  chronologically without a second column. */
export function newId() {
  const t = Date.now();
  const time = new Uint8Array(6);
  for (let i = 5; i >= 0; i--) time[i] = (t / 2 ** (8 * (5 - i))) & 0xff;
  const out = new Uint8Array(16);
  out.set(time, 0);
  out.set(randomBytes(10), 6);
  return b64url(out);
}

/** A six-digit code a person can read off a screen and type on a phone.
 *
 *  Rejection sampling, NOT `% 1000000`. A 32-bit value modulo a million is
 *  measurably biased toward low codes — the first 4,967,296 values of the
 *  range cover 000000..967295 twice. It is a small bias and it is also
 *  free to avoid, and "we did the biased thing because it was easier" is a
 *  bad sentence to have to say to an auditor. */
export function otpCode() {
  const limit = 4294000000;   // largest multiple of 1e6 under 2^32
  const view = new Uint32Array(1);
  let n;
  do {
    crypto.getRandomValues(view);
    n = view[0];
  } while (n >= limit);
  return String(n % 1000000).padStart(6, "0");
}

async function digest(algorithm, key, message) {
  if (algorithm === "SHA-256") {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(message)));
  }
  const k = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

function hex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** What we store instead of a secret. */
export async function sha256Hex(value) {
  return hex(await digest("SHA-256", null, String(value)));
}

/** Keyed hash — used to derive a timeline handle from a thread identifier
 *  when the client cannot do it (it should; this is the fallback path). */
export async function hmacHex(key, message) {
  return hex(await digest("HMAC", key, String(message)));
}

/** Constant-time string comparison.
 *
 *  Compares the full length of BOTH inputs regardless of where they differ.
 *  An early length check would reintroduce the leak this exists to close,
 *  so unequal lengths still walk the longer of the two. */
export function timingSafeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}
