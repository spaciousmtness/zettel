import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { makeEnv, get, cookieFrom, setCookies } from "./harness.js";

// There was no OIDC test at all, which is exactly why a Set-Cookie header
// that deletes the session it just created reached a commit. These walk the
// whole flow with the token endpoint stubbed.

const GOOGLE = {
  GOOGLE_CLIENT_ID: "client-123.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "secret-abc",
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** An id_token as Google's token endpoint would hand one back. Unsigned on
 *  purpose — the flow deliberately trusts the TLS channel to the token
 *  endpoint rather than the signature, and this asserts the claim checks
 *  that remain load-bearing under that decision. */
function idToken(claims) {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;
}

/** Drive /auth/google/start and read back what the browser would hold. */
async function begin(env) {
  const res = await worker.fetch(get("/auth/google/start"), env);
  assert.equal(res.status, 303);
  const authorize = new URL(res.headers.get("Location"));
  const state = authorize.searchParams.get("state");
  const nonce = authorize.searchParams.get("nonce");
  const cookie = cookieFrom(res, "zettel_oidc");
  return { authorize, state, nonce, cookie, res };
}

/** Stub the token endpoint for one call. */
function withToken(claims, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ id_token: idToken(claims) }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  return run().finally(() => { globalThis.fetch = real; });
}

const claimsFor = (nonce, over = {}) => ({
  iss: "https://accounts.google.com",
  aud: GOOGLE.GOOGLE_CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 300,
  sub: "google-subject-0001",
  nonce,
  email: "melissa@example.com",
  email_verified: true,
  ...over,
});

test("start sends PKCE, state and nonce, and stores the flow", async () => {
  const env = makeEnv(GOOGLE);
  const { authorize, state, cookie } = await begin(env);

  assert.equal(authorize.origin + authorize.pathname,
    "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorize.searchParams.get("code_challenge"));
  // the redirect_uri must resolve on the WORKER, not the front end
  assert.equal(authorize.searchParams.get("redirect_uri"),
    "https://api.zettel.test/auth/google/callback");
  assert.ok(state);
  assert.equal(cookie, state, "the browser has to carry the same state");
});

test("the callback sets TWO Set-Cookie headers, never one joined by a comma", async () => {
  // RFC 6265 splits only on ";". Comma-joining two values yields ONE cookie
  // named zettel_session whose trailing attributes are `Path=/auth;
  // Max-Age=0` — a delete instruction for the session just created. Google
  // and Apple sign-in looped forever; email was fine because it sets one.
  const env = makeEnv(GOOGLE);
  const { state, nonce, cookie } = await begin(env);

  const landed = await withToken(claimsFor(nonce), () =>
    worker.fetch(get(`/auth/google/callback?code=abc&state=${state}`,
      { Cookie: `zettel_oidc=${cookie}` }), env));

  const cookies = setCookies(landed);
  assert.equal(cookies.length, 2, "one header per cookie");
  assert.ok(cookies.some((c) => c.startsWith("zettel_session=")));
  assert.ok(cookies.some((c) => c.startsWith("zettel_oidc=")));
  for (const line of cookies) {
    assert.ok(!line.includes(","),
      `a Set-Cookie value must not contain a comma: ${line}`);
  }
});

test("the session the callback issues actually works", async () => {
  const env = makeEnv(GOOGLE);
  const { state, nonce, cookie } = await begin(env);
  const landed = await withToken(claimsFor(nonce), () =>
    worker.fetch(get(`/auth/google/callback?code=abc&state=${state}`,
      { Cookie: `zettel_oidc=${cookie}` }), env));

  assert.equal(landed.status, 303);
  assert.equal(landed.headers.get("Location"), "https://zettel.test/app/",
    "the landing resolves on the front end");

  const session = cookieFrom(landed, "zettel_session");
  assert.ok(session);
  const me = await worker.fetch(
    get("/me", { Cookie: `zettel_session=${session}` }), env);
  assert.equal((await me.json()).signedIn, true);
});

test("a verified email is linked as a second identity on the same account", async () => {
  const env = makeEnv(GOOGLE);
  const { state, nonce, cookie } = await begin(env);
  await withToken(claimsFor(nonce), () =>
    worker.fetch(get(`/auth/google/callback?code=abc&state=${state}`,
      { Cookie: `zettel_oidc=${cookie}` }), env));

  const kinds = env.DB._raw.prepare("SELECT kind FROM identity ORDER BY kind")
    .all().map((r) => r.kind);
  assert.deepEqual(kinds, ["email", "google"]);
  const accounts = env.DB._raw.prepare("SELECT COUNT(*) AS n FROM account").all()[0];
  assert.equal(accounts.n, 1, "one person, one account, two ways in");
});

test("an unverified email is NOT linked", async () => {
  const env = makeEnv(GOOGLE);
  const { state, nonce, cookie } = await begin(env);
  await withToken(claimsFor(nonce, { email_verified: false }), () =>
    worker.fetch(get(`/auth/google/callback?code=abc&state=${state}`,
      { Cookie: `zettel_oidc=${cookie}` }), env));

  const kinds = env.DB._raw.prepare("SELECT kind FROM identity").all()
    .map((r) => r.kind);
  assert.deepEqual(kinds, ["google"]);
});

test("a provider's email cannot take over an account that already owns it", async () => {
  // The classic OIDC account-linking hole: anyone who can make a provider
  // assert an address you already use walks into your account.
  const env = makeEnv(GOOGLE);
  env.DB._raw.prepare(
    `INSERT INTO account (id, created_at, status, surface_salt)
     VALUES ('victim', 1, 'active', 'salt')`).run();
  env.DB._raw.prepare(
    `INSERT INTO identity (id, account_id, kind, value, verified_at, created_at)
     VALUES ('vid', 'victim', 'email', 'melissa@example.com', 1, 1)`).run();

  const { state, nonce, cookie } = await begin(env);
  await withToken(claimsFor(nonce), () =>
    worker.fetch(get(`/auth/google/callback?code=abc&state=${state}`,
      { Cookie: `zettel_oidc=${cookie}` }), env));

  const owner = env.DB._raw.prepare(
    "SELECT account_id FROM identity WHERE kind='email' AND value=?")
    .all("melissa@example.com")[0];
  assert.equal(owner.account_id, "victim", "the address must not change hands");
  const accounts = env.DB._raw.prepare("SELECT COUNT(*) AS n FROM account").all()[0];
  assert.equal(accounts.n, 2, "the google sub gets its own account instead");
});

// ---- the checks that are load-bearing because the signature is not --------

test("a callback without the browser's state cookie is refused", async () => {
  const env = makeEnv(GOOGLE);
  const { state, nonce } = await begin(env);
  const res = await withToken(claimsFor(nonce), () =>
    worker.fetch(get(`/auth/google/callback?code=abc&state=${state}`), env));
  assert.match(res.headers.get("Location"), /signin=state/);
  assert.equal(cookieFrom(res, "zettel_session"), null);
});

test("a state that was never issued is refused", async () => {
  const env = makeEnv(GOOGLE);
  await begin(env);
  const res = await worker.fetch(
    get("/auth/google/callback?code=abc&state=forged",
      { Cookie: "zettel_oidc=forged" }), env);
  assert.match(res.headers.get("Location"), /signin=state/);
});

test("a state is single use", async () => {
  const env = makeEnv(GOOGLE);
  const { state, nonce, cookie } = await begin(env);
  const headers = { Cookie: `zettel_oidc=${cookie}` };
  const url = `/auth/google/callback?code=abc&state=${state}`;

  const first = await withToken(claimsFor(nonce), () =>
    worker.fetch(get(url, headers), env));
  assert.ok(cookieFrom(first, "zettel_session"));

  const replay = await withToken(claimsFor(nonce), () =>
    worker.fetch(get(url, headers), env));
  assert.match(replay.headers.get("Location"), /signin=state/);
});

test("a mismatched nonce is refused", async () => {
  const env = makeEnv(GOOGLE);
  const { state, cookie } = await begin(env);
  const res = await withToken(claimsFor("some-other-nonce"), () =>
    worker.fetch(get(`/auth/google/callback?code=abc&state=${state}`,
      { Cookie: `zettel_oidc=${cookie}` }), env));
  assert.match(res.headers.get("Location"), /signin=claims/);
});

test("a wrong issuer, audience or expiry is refused", async () => {
  for (const [name, over] of [
    ["issuer",   { iss: "https://evil.example" }],
    ["audience", { aud: "someone-elses-client-id" }],
    ["expiry",   { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["subject",  { sub: undefined }],
  ]) {
    const env = makeEnv(GOOGLE);
    const { state, nonce, cookie } = await begin(env);
    const res = await withToken(claimsFor(nonce, over), () =>
      worker.fetch(get(`/auth/google/callback?code=abc&state=${state}`,
        { Cookie: `zettel_oidc=${cookie}` }), env));
    assert.match(res.headers.get("Location"), /signin=claims/, `${name} check`);
    assert.equal(cookieFrom(res, "zettel_session"), null, `${name} issued a session`);
  }
});

test("Apple's state cookie is SameSite=None because Apple form-posts", async () => {
  // A Lax cookie is not attached to a cross-site POST, so the flow would fail
  // its own CSRF check on every Apple sign-in.
  const env = makeEnv({
    APPLE_CLIENT_ID: "ink.zettel.app", APPLE_TEAM_ID: "TEAM",
    APPLE_KEY_ID: "KEY", APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
  });
  const res = await worker.fetch(get("/auth/apple/start"), env);
  assert.equal(res.status, 303);
  assert.match(res.headers.get("Set-Cookie"), /SameSite=None/);
  assert.match(new URL(res.headers.get("Location")).searchParams.get("response_mode"),
    /form_post/);
});

test("an unconfigured provider refuses at the server too", async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(get("/auth/google/start"), env)).status, 503);
  assert.equal((await worker.fetch(get("/auth/apple/start"), env)).status, 503);
});
