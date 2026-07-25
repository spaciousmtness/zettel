import { randomToken, sha256Hex, b64url, randomBytes, timingSafeEqual }
  from "../lib/crypto.js";
import { normalizeEmail } from "../lib/validate.js";
import { fail } from "../lib/respond.js";
import { accountForIdentity, audit } from "../lib/accounts.js";
import { createSession, sessionCookie } from "../lib/session.js";

// Google and Apple, authorization-code flow with PKCE.
//
// WHY WE DON'T VERIFY THE ID TOKEN SIGNATURE. The id_token here does not
// arrive via the browser — we exchange the code for it ourselves, server to
// server, over TLS, against a pinned issuer host. Google's own integration
// guidance says signature verification may be skipped on that path, because
// TLS to the token endpoint already establishes who said it. The claims we
// DO check (iss, aud, exp, nonce) are the ones that still matter on a
// trusted channel, and skipping them is what turns this into a hole.
//
// If the flow ever changes to response_mode=fragment or an implicit id_token
// reaching the browser, this comment stops being true and JWKS verification
// becomes mandatory. That is the one thing to re-read before changing it.

const PROVIDERS = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    scope: "openid email",
    responseMode: null,
  },
  apple: {
    authorize: "https://appleid.apple.com/auth/authorize",
    token: "https://appleid.apple.com/auth/token",
    issuers: ["https://appleid.apple.com"],
    scope: "openid email",
    // Apple posts the callback back as a cross-site form. That is why the
    // state cookie below has to be SameSite=None for this provider: a Lax
    // cookie is not attached to a cross-site POST, and the flow would fail
    // its own CSRF check every time.
    responseMode: "form_post",
  },
};

const STATE_COOKIE = "zettel_oidc";
const STATE_TTL = 10 * 60;

function configured(env, provider) {
  if (provider === "google") return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  if (provider === "apple") {
    return !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID &&
              env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);
  }
  return false;
}

/** GET /auth/:provider/start */
export async function oidcStart(request, env, provider) {
  const spec = PROVIDERS[provider];
  if (!spec) return fail(404, "no_provider", "unknown provider");
  if (!configured(env, provider)) {
    // The landing page hides an unconfigured provider entirely; this is the
    // matching server-side answer for anyone who reaches the URL directly.
    return fail(503, "not_configured",
      "that way in isn't open yet — use email or phone");
  }

  // Two independent secrets doing two different jobs:
  //   state  — binds the callback to THIS browser (login CSRF)
  //   nonce  — binds the id_token to THIS request (token replay)
  // A flow with only one of them is broken in a way that is hard to see.
  const state = randomToken();
  const nonce = randomToken();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

  await env.RATE.put(`oidc:${await sha256Hex(state)}`,
    JSON.stringify({ provider, nonce, verifier }),
    { expirationTtl: STATE_TTL });

  const url = new URL(spec.authorize);
  url.searchParams.set("client_id", clientId(env, provider));
  url.searchParams.set("redirect_uri", `${env.PUBLIC_ORIGIN}/auth/${provider}/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", spec.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (spec.responseMode) url.searchParams.set("response_mode", spec.responseMode);

  const sameSite = spec.responseMode === "form_post" ? "None" : "Lax";
  return new Response(null, {
    status: 303,
    headers: {
      Location: url.toString(),
      "Cache-Control": "no-store",
      "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/auth; HttpOnly; Secure; ` +
                    `SameSite=${sameSite}; Max-Age=${STATE_TTL}`,
    },
  });
}

/** GET|POST /auth/:provider/callback */
export async function oidcCallback(request, env, provider) {
  const spec = PROVIDERS[provider];
  if (!spec || !configured(env, provider)) return bounce(env, "bad");

  // Apple form-posts; Google comes back on the query string.
  let code, state;
  if (request.method === "POST") {
    const form = await request.formData();
    code = form.get("code");
    state = form.get("state");
  } else {
    const url = new URL(request.url);
    code = url.searchParams.get("code");
    state = url.searchParams.get("state");
  }
  if (!code || !state) return bounce(env, "bad");

  // The state must match BOTH what we stored and what this browser carries.
  // KV alone proves the flow is ours; the cookie proves it is the same
  // browser that started it. Without the cookie half, anyone can complete a
  // login into someone else's session.
  const cookie = (request.headers.get("Cookie") || "")
    .split(";").map((s) => s.trim())
    .find((s) => s.startsWith(`${STATE_COOKIE}=`))?.split("=")[1];
  if (!cookie || !timingSafeEqual(cookie, state)) return bounce(env, "state");

  const slot = `oidc:${await sha256Hex(state)}`;
  const raw = await env.RATE.get(slot);
  if (!raw) return bounce(env, "state");
  await env.RATE.delete(slot);           // single use, always
  const saved = JSON.parse(raw);
  if (saved.provider !== provider) return bounce(env, "state");

  let claims;
  try {
    claims = await exchange(env, provider, spec, code, saved.verifier);
  } catch {
    await audit(env, { action: `signin.${provider}`, outcome: "error" });
    return bounce(env, "exchange");
  }

  if (!spec.issuers.includes(claims.iss)) return bounce(env, "claims");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId(env, provider))) return bounce(env, "claims");
  if (!claims.exp || claims.exp * 1000 < Date.now()) return bounce(env, "claims");
  if (!claims.nonce || !timingSafeEqual(claims.nonce, saved.nonce)) {
    return bounce(env, "claims");
  }
  if (!claims.sub) return bounce(env, "claims");

  // We key the identity on the provider's SUBJECT, never on the email.
  //
  // The email is a convenience and providers do change it; the sub is
  // stable and is the thing the provider actually asserts. Keying on email
  // is how you build an account-takeover: anyone who can get a provider to
  // assert an address you already use walks straight into your account. We
  // only record the email as a SEPARATE identity when the provider says it
  // verified it, and even then only for an account that has no other owner.
  const { accountId, created } = await accountForIdentity(env,
    { kind: provider, value: String(claims.sub) });

  const email = normalizeEmail(claims.email);
  if (email && claims.email_verified === true) {
    const taken = await env.DB.prepare(
      `SELECT account_id FROM identity WHERE kind = 'email' AND value = ?`)
      .bind(email).first();
    if (!taken) {
      await accountForIdentity(env,
        { kind: "email", value: email, linkTo: accountId });
    }
  }

  const token = await createSession(env, accountId, request);
  await audit(env, { accountId, action: `signin.${provider}`, outcome: "ok",
                     meta: { created } });
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${env.PUBLIC_ORIGIN}/app/`,
      "Cache-Control": "no-store",
      "Set-Cookie": [sessionCookie(token),
                     `${STATE_COOKIE}=; Path=/auth; Max-Age=0`].join(", "),
    },
  });
}

async function exchange(env, provider, spec, code, verifier) {
  const secret = provider === "apple"
    ? await appleClientSecret(env)
    : env.GOOGLE_CLIENT_SECRET;

  const res = await fetch(spec.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${env.PUBLIC_ORIGIN}/auth/${provider}/callback`,
      client_id: clientId(env, provider),
      client_secret: secret,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  const payload = await res.json();
  if (!payload.id_token) throw new Error("no id_token");
  return decodeJwtPayload(payload.id_token);
}

function clientId(env, provider) {
  return provider === "apple" ? env.APPLE_CLIENT_ID : env.GOOGLE_CLIENT_ID;
}

/** Read the claims WITHOUT verifying — safe only because of where this
 *  token came from. See the note at the top of the file. */
function decodeJwtPayload(jwt) {
  const part = String(jwt).split(".")[1];
  if (!part) throw new Error("malformed id_token");
  const padded = part.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(new TextDecoder().decode(
    Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))));
}

/** Apple does not issue a static client secret. It wants a short-lived
 *  ES256 JWT signed with the .p8 key from the developer console, which
 *  means the "secret" has to be minted per exchange. */
async function appleClientSecret(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: env.APPLE_KEY_ID, typ: "JWT" };
  const claims = {
    iss: env.APPLE_TEAM_ID,
    iat: now,
    exp: now + 300,               // minutes: this secret has no reason to live
    aud: "https://appleid.apple.com",
    sub: env.APPLE_CLIENT_ID,
  };
  const encode = (obj) =>
    b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signing = `${encode(header)}.${encode(claims)}`;

  const pem = String(env.APPLE_PRIVATE_KEY)
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key,
    new TextEncoder().encode(signing)));
  return `${signing}.${b64url(signature)}`;
}

function bounce(env, why) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${env.PUBLIC_ORIGIN}/?signin=${why}`,
      "Cache-Control": "no-store",
      "Set-Cookie": `${STATE_COOKIE}=; Path=/auth; Max-Age=0`,
    },
  });
}

/** Which providers a client should actually offer. The landing page asks
 *  this and renders nothing for the ones that answer false — absent, not
 *  inert, the same rule the app uses for its own controls. */
export function providerStatus(env) {
  return { google: configured(env, "google"), apple: configured(env, "apple") };
}
