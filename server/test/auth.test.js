import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { makeEnv, post, get, cookieFrom, captureConsole } from "./harness.js";

/** Run the phone flow to a session cookie. */
async function signInByPhone(env, phone = "+15550000137") {
  const cap = captureConsole();
  try {
    const started = await worker.fetch(post("/auth/phone/start", { phone }), env);
    assert.equal(started.status, 200);
    const code = cap.lastSecret();
    assert.match(code || "", /^\d{6}$/);
    const verified = await worker.fetch(
      post("/auth/phone/verify", { phone, code }), env);
    assert.equal(verified.status, 200);
    return { cookie: cookieFrom(verified, "zettel_session"), code, verified };
  } finally { cap.restore(); }
}

test("phone: start, verify, and land signed in", async () => {
  const env = makeEnv();
  const { cookie } = await signInByPhone(env);
  assert.ok(cookie, "a session cookie should be set");

  const who = await worker.fetch(get("/me", { Cookie: `zettel_session=${cookie}` }), env);
  const body = await who.json();
  assert.equal(body.signedIn, true);
  assert.equal(body.identities[0].kind, "phone");
  assert.equal(body.identities[0].hint, "••••0137");
  assert.ok(body.surfaceSalt, "the client needs the salt to derive handles");
});

test("phone: the same number twice is one account, not two", async () => {
  const env = makeEnv();
  await signInByPhone(env);
  await signInByPhone(env);
  const count = env.DB._raw.prepare("SELECT COUNT(*) AS n FROM account").all()[0];
  assert.equal(count.n, 1);
});

test("phone: spelling variants land on the same account", async () => {
  const env = makeEnv();
  await signInByPhone(env, "+15550000137");
  await signInByPhone(env, "+1 (555) 000-0137");
  const count = env.DB._raw.prepare("SELECT COUNT(*) AS n FROM account").all()[0];
  assert.equal(count.n, 1, "normalisation is what keeps one person one account");
});

test("phone: a wrong code is refused and counted", async () => {
  const env = makeEnv();
  const phone = "+15550000137";
  const cap = captureConsole();
  await worker.fetch(post("/auth/phone/start", { phone }), env);
  cap.restore();

  const bad = await worker.fetch(
    post("/auth/phone/verify", { phone, code: "000000" }), env);
  assert.equal(bad.status, 401);
  assert.equal(cookieFrom(bad, "zettel_session"), null);

  const row = env.DB._raw.prepare("SELECT attempts FROM challenge").all()[0];
  assert.equal(row.attempts, 1);
});

test("phone: the code burns after five wrong guesses", async () => {
  const env = makeEnv();
  const phone = "+15550000137";
  const cap = captureConsole();
  await worker.fetch(post("/auth/phone/start", { phone }), env);
  const real = cap.lastSecret();
  cap.restore();

  for (let i = 0; i < 5; i++) {
    await worker.fetch(post("/auth/phone/verify", { phone, code: "000001" }), env);
  }
  const locked = await worker.fetch(
    post("/auth/phone/verify", { phone, code: "000001" }), env);
  assert.equal(locked.status, 429);

  // and the REAL code is dead too — five guesses means the code is burned,
  // not merely that the guesser is slowed down
  const withReal = await worker.fetch(
    post("/auth/phone/verify", { phone, code: real }), env);
  assert.notEqual(withReal.status, 200);
});

test("phone: a code works exactly once", async () => {
  const env = makeEnv();
  const phone = "+15550000137";
  const { code } = await signInByPhone(env, phone);
  const replay = await worker.fetch(post("/auth/phone/verify", { phone, code }), env);
  assert.equal(replay.status, 401);
});

test("phone: a code minted for one number cannot verify another", async () => {
  const env = makeEnv();
  const cap = captureConsole();
  await worker.fetch(post("/auth/phone/start", { phone: "+15550000137" }), env);
  const code = cap.lastSecret();
  cap.restore();

  const stolen = await worker.fetch(
    post("/auth/phone/verify", { phone: "+15550000188", code }), env);
  assert.equal(stolen.status, 401);
});

test("phone: a number without a country code is refused, not guessed", async () => {
  const env = makeEnv();
  const res = await worker.fetch(post("/auth/phone/start", { phone: "5550000137" }), env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /country code/);
});

test("email: the magic link signs you in and redirects", async () => {
  const env = makeEnv();
  const cap = captureConsole();
  const started = await worker.fetch(
    post("/auth/email/start", { email: "Melissa@Example.com" }), env);
  assert.equal(started.status, 200);
  const secret = cap.lastSecret();
  cap.restore();
  assert.ok(secret);

  const landed = await worker.fetch(
    get(`/auth/email/callback?t=${encodeURIComponent(secret)}` +
        `&e=${encodeURIComponent("melissa@example.com")}`), env);
  assert.equal(landed.status, 303);
  assert.equal(landed.headers.get("Location"), "https://zettel.test/app/");
  assert.ok(cookieFrom(landed, "zettel_session"));
});

test("email: the link works exactly once", async () => {
  const env = makeEnv();
  const cap = captureConsole();
  await worker.fetch(post("/auth/email/start", { email: "a@example.com" }), env);
  const secret = cap.lastSecret();
  cap.restore();

  const url = `/auth/email/callback?t=${encodeURIComponent(secret)}&e=a%40example.com`;
  const first = await worker.fetch(get(url), env);
  assert.ok(cookieFrom(first, "zettel_session"));
  const second = await worker.fetch(get(url), env);
  assert.equal(cookieFrom(second, "zettel_session"), null);
  assert.match(second.headers.get("Location"), /signin=expired/);
});

test("email: an unknown address answers exactly like a known one", async () => {
  // The enumeration oracle. If these two responses ever differ, a breach
  // dump from somewhere else becomes a list of confirmed Zettel users.
  const env = makeEnv();
  const cap = captureConsole();
  await worker.fetch(post("/auth/email/start", { email: "known@example.com" }), env);
  const secret = cap.lastSecret();
  await worker.fetch(get(
    `/auth/email/callback?t=${encodeURIComponent(secret)}&e=known%40example.com`), env);

  const knownAgain = await worker.fetch(
    post("/auth/email/start", { email: "known@example.com" }), env);
  const stranger = await worker.fetch(
    post("/auth/email/start", { email: "stranger@example.com" }), env);
  cap.restore();

  assert.equal(knownAgain.status, stranger.status);
  assert.deepEqual(await knownAgain.json(), await stranger.json());
});

test("sign-out revokes the session it was called with", async () => {
  const env = makeEnv();
  const { cookie } = await signInByPhone(env);
  const headers = { Cookie: `zettel_session=${cookie}` };

  await worker.fetch(new Request("https://zettel.test/auth/signout",
    { method: "POST", headers }), env);
  const after = await worker.fetch(get("/me", headers), env);
  assert.equal((await after.json()).signedIn, false);
});

test("a forged session cookie is not a session", async () => {
  const env = makeEnv();
  await signInByPhone(env);
  const res = await worker.fetch(
    get("/me", { Cookie: "zettel_session=not-a-real-token" }), env);
  assert.equal((await res.json()).signedIn, false);
});

test("the session cookie is httpOnly, Secure and SameSite", async () => {
  const env = makeEnv();
  const { verified } = await signInByPhone(env);
  const raw = verified.headers.get("Set-Cookie");
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /Secure/);
  assert.match(raw, /SameSite=Lax/);
});

test("sending codes is rate limited per destination", async () => {
  const env = makeEnv();
  const phone = "+15550000137";
  const cap = captureConsole();
  const codes = [];
  for (let i = 0; i < 5; i++) {
    codes.push((await worker.fetch(post("/auth/phone/start", { phone }), env)).status);
  }
  const blocked = await worker.fetch(post("/auth/phone/start", { phone }), env);
  cap.restore();
  assert.deepEqual(codes, [200, 200, 200, 200, 200]);
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get("Retry-After"));
});

test("providers that are not configured are reported false, not offered", async () => {
  const env = makeEnv();
  const res = await worker.fetch(get("/health"), env);
  assert.deepEqual((await res.json()).providers, { google: false, apple: false });

  const start = await worker.fetch(get("/auth/google/start"), env);
  assert.equal(start.status, 503);
});

test("the router distinguishes a missing route from a wrong verb", async () => {
  const env = makeEnv();
  const missing = await worker.fetch(get("/nope"), env);
  assert.equal(missing.status, 404);

  const wrongVerb = await worker.fetch(get("/access"), env);
  assert.equal(wrongVerb.status, 405);
  assert.equal(wrongVerb.headers.get("Allow"), "POST");
});

test("every response carries the hardening headers", async () => {
  const env = makeEnv();
  const res = await worker.fetch(get("/health"), env);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(res.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("CORS never echoes an origin that is not on the list", async () => {
  const env = makeEnv();
  const evil = await worker.fetch(
    get("/health", { Origin: "https://evil.example" }), env);
  assert.equal(evil.headers.get("Access-Control-Allow-Origin"), null);

  const ours = await worker.fetch(
    get("/health", { Origin: "https://zettel.test" }), env);
  assert.equal(ours.headers.get("Access-Control-Allow-Origin"), "https://zettel.test");
  assert.equal(ours.headers.get("Access-Control-Allow-Credentials"), "true");
});

test("a malformed body is a 400, never a 500", async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request("https://zettel.test/access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  }), env);
  assert.equal(res.status, 400);
});
