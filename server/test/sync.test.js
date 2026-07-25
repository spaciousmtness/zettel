import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { makeEnv, post, get, cookieFrom, captureConsole } from "./harness.js";

const TIMELINE = "b".repeat(64);
const OTHER    = "c".repeat(64);

async function signIn(env, phone) {
  const cap = captureConsole();
  try {
    await worker.fetch(post("/auth/phone/start", { phone }), env);
    const code = cap.lastSecret();
    const res = await worker.fetch(post("/auth/phone/verify", { phone, code }), env);
    return { Cookie: `zettel_session=${cookieFrom(res, "zettel_session")}` };
  } finally { cap.restore(); }
}

const mark = (over = {}) => ({
  id: "mark-1", timeline: TIMELINE, kind: "note",
  t0: 1689000000, t1: 1689000000, y: 0.4,
  body_ct: "c2VhbGVk", revision: 1, ...over,
});

test("sync refuses anyone who is not signed in", async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(get("/sync"), env)).status, 401);
  assert.equal((await worker.fetch(post("/sync", { items: [mark()] }), env)).status, 401);
});

test("a pushed mark comes back on pull", async () => {
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");

  const pushed = await worker.fetch(post("/sync", { items: [mark()] }, auth), env);
  assert.equal(pushed.status, 200);
  assert.equal((await pushed.json()).accepted, 1);

  const pulled = await worker.fetch(get(`/sync?timeline=${TIMELINE}`, auth), env);
  const { items } = await pulled.json();
  assert.equal(items.length, 1);
  assert.equal(items[0].t0, 1689000000);
  assert.equal(items[0].kind, "note");
});

test("one account never sees another's marks", async () => {
  // The single most important assertion in this file. account_id is bound
  // from the session, so this is really a test that no payload field can
  // override it.
  const env = makeEnv();
  const mine = await signIn(env, "+15550000137");
  const theirs = await signIn(env, "+15550000188");

  await worker.fetch(post("/sync", { items: [mark()] }, mine), env);
  const pulled = await worker.fetch(get(`/sync?timeline=${TIMELINE}`, theirs), env);
  assert.deepEqual((await pulled.json()).items, []);
});

test("a payload cannot smuggle in another account_id", async () => {
  const env = makeEnv();
  const mine = await signIn(env, "+15550000137");
  const theirs = await signIn(env, "+15550000188");

  const victim = await worker.fetch(get("/me", theirs), env);
  const victimId = (await victim.json()).account.id;

  await worker.fetch(
    post("/sync", { items: [mark({ account_id: victimId })] }, mine), env);

  const pulled = await worker.fetch(get(`/sync?timeline=${TIMELINE}`, theirs), env);
  assert.deepEqual((await pulled.json()).items, [],
    "the body's account_id must be ignored entirely");
});

test("a raw phone number is refused as a timeline handle", async () => {
  // The boundary check. If a future client forgets to HMAC, we want a
  // rejection here rather than a phone number quietly in the table.
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");
  const res = await worker.fetch(
    post("/sync", { items: [mark({ timeline: "+15550000137" })] }, auth), env);
  const body = await res.json();
  assert.equal(body.accepted, 0);
  assert.deepEqual(body.rejected, [{ index: 0, why: "timeline" }]);
});

test("a bad item is rejected without taking the good ones with it", async () => {
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");
  const res = await worker.fetch(post("/sync", {
    items: [
      mark({ id: "good-1" }),
      mark({ id: "bad-1", kind: "not-a-kind" }),
      mark({ id: "bad-2", t0: "yesterday" }),
      mark({ id: "good-2", timeline: OTHER }),
    ],
  }, auth), env);
  const body = await res.json();
  assert.equal(body.accepted, 2);
  assert.deepEqual(body.rejected.map((r) => r.why), ["kind", "anchor"]);
});

test("last writer wins by revision, and an older write is refused", async () => {
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");

  await worker.fetch(post("/sync", { items: [mark({ revision: 5, y: 0.5 })] }, auth), env);
  await worker.fetch(post("/sync", { items: [mark({ revision: 2, y: 0.9 })] }, auth), env);

  const { items } = await (await worker.fetch(
    get(`/sync?timeline=${TIMELINE}`, auth), env)).json();
  assert.equal(items.length, 1);
  assert.equal(items[0].revision, 5, "the stale device must not win");
  assert.equal(items[0].y, 0.5);
});

test("a newer revision does overwrite", async () => {
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");
  await worker.fetch(post("/sync", { items: [mark({ revision: 1, y: 0.1 })] }, auth), env);
  await worker.fetch(post("/sync", { items: [mark({ revision: 2, y: 0.8 })] }, auth), env);

  const { items } = await (await worker.fetch(
    get(`/sync?timeline=${TIMELINE}`, auth), env)).json();
  assert.equal(items[0].revision, 2);
  assert.equal(items[0].y, 0.8);
});

test("a deletion travels as a tombstone", async () => {
  // A sync that only carries creations resurrects every mark ever removed.
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");
  await worker.fetch(post("/sync", { items: [mark()] }, auth), env);
  await worker.fetch(
    post("/sync", { items: [mark({ revision: 2, deleted: true })] }, auth), env);

  const { items } = await (await worker.fetch(
    get(`/sync?timeline=${TIMELINE}`, auth), env)).json();
  assert.equal(items.length, 1);
  assert.ok(items[0].deleted_at, "the row must still be visible, marked dead");
});

test("forgetting a timeline tombstones it and drops the ciphertext", async () => {
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");
  await worker.fetch(post("/sync", {
    items: [mark({ id: "a" }), mark({ id: "b" }), mark({ id: "c", timeline: OTHER })],
  }, auth), env);

  const forgotten = await worker.fetch(new Request(
    `https://zettel.test/sync/timeline/${TIMELINE}`, { method: "DELETE", headers: auth }),
    env);
  assert.equal((await forgotten.json()).forgotten, 2);

  const { items } = await (await worker.fetch(
    get(`/sync?timeline=${TIMELINE}`, auth), env)).json();
  for (const row of items) {
    assert.ok(row.deleted_at);
    assert.equal(row.body_ct, null, "the sealed body should not survive a forget");
  }

  // the untouched timeline is untouched
  const other = await (await worker.fetch(
    get(`/sync?timeline=${OTHER}`, auth), env)).json();
  assert.equal(other.items.length, 1);
  assert.equal(other.items[0].deleted_at, null);
});

test("pull honours the full (updated_at, id) watermark", async () => {
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");
  await worker.fetch(post("/sync", { items: [mark()] }, auth), env);

  const all = await (await worker.fetch(get(`/sync?timeline=${TIMELINE}`, auth), env)).json();
  const row = all.items[0];

  const nothingNew = await (await worker.fetch(get(
    `/sync?timeline=${TIMELINE}&since=${row.updated_at}&since_id=${row.id}`,
    auth), env)).json();
  assert.deepEqual(nothingNew.items, []);
  assert.equal(nothingNew.cursor, null);
});

test("a half watermark re-delivers rather than skipping", async () => {
  // `since` without `since_id` is the old client's cursor. It must fail SAFE:
  // re-sending a row the client already has is idempotent; skipping one is
  // silent data loss.
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");
  await worker.fetch(post("/sync", { items: [mark()] }, auth), env);
  const all = await (await worker.fetch(get(`/sync?timeline=${TIMELINE}`, auth), env)).json();

  const again = await (await worker.fetch(
    get(`/sync?timeline=${TIMELINE}&since=${all.items[0].updated_at}`, auth), env)).json();
  assert.equal(again.items.length, 1, "duplicate, never a drop");
});

test("a full page of rows sharing one second paginates completely", async () => {
  // The bug this exists for: push() stamps a whole batch with one `now`, so
  // hundreds of rows share an `updated_at`. A cursor of updated_at alone asks
  // the next page for `> T` and silently skips every remaining row AT T. One
  // legal push made 300 marks permanently invisible to a second device.
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");

  const TOTAL = 300, PAGE = 100;
  const items = Array.from({ length: TOTAL }, (_, i) =>
    mark({ id: `m${String(i).padStart(4, "0")}` }));
  const pushed = await worker.fetch(post("/sync", { items }, auth), env);
  assert.equal((await pushed.json()).accepted, TOTAL);

  // they really do share a second — otherwise this test proves nothing
  const stamps = new Set(env.DB._raw
    .prepare("SELECT DISTINCT updated_at FROM annotation").all()
    .map((r) => r.updated_at));
  assert.equal(stamps.size, 1, "the whole batch should carry one timestamp");

  const seen = new Set();
  let cursor = null, pages = 0;
  do {
    const qs = new URLSearchParams({ timeline: TIMELINE, limit: String(PAGE) });
    if (cursor) {
      qs.set("since", String(cursor.since));
      qs.set("since_id", cursor.since_id);
    }
    const page = await (await worker.fetch(get(`/sync?${qs}`, auth), env)).json();
    for (const row of page.items) seen.add(row.id);
    cursor = page.cursor;
    pages++;
    assert.ok(pages < 20, "pagination should terminate");
  } while (cursor);

  assert.equal(seen.size, TOTAL, "every row must survive pagination");
});

test("a batch over the cap is refused whole", async () => {
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");
  const items = Array.from({ length: 501 }, (_, i) => mark({ id: `m${i}` }));
  const res = await worker.fetch(post("/sync", { items }, auth), env);
  assert.equal(res.status, 413);
});

test("closing an account really removes the marks", async () => {
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");
  await worker.fetch(post("/sync", { items: [mark()] }, auth), env);

  const refused = await worker.fetch(new Request("https://zettel.test/me",
    { method: "DELETE", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({}) }), env);
  assert.equal(refused.status, 400, "a destructive verb needs its confirmation");

  await worker.fetch(new Request("https://zettel.test/me", {
    method: "DELETE",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: "close my account" }),
  }), env);

  const left = env.DB._raw.prepare("SELECT COUNT(*) AS n FROM annotation").all()[0];
  assert.equal(left.n, 0, "ON DELETE CASCADE should have taken the marks");
  const audits = env.DB._raw.prepare(
    "SELECT COUNT(*) AS n FROM audit WHERE action = 'account.close'").all()[0];
  assert.equal(audits.n, 1, "the evidence that deletion happened must survive");
});

test("pairing: a code is single use and yields a device token", async () => {
  const env = makeEnv();
  const auth = await signIn(env, "+15550000137");
  const { code } = await (await worker.fetch(
    new Request("https://zettel.test/me/pair", { method: "POST", headers: auth }),
    env)).json();
  assert.match(code, /^\d{6}-\d{6}$/);

  const first = await worker.fetch(post("/pair/claim", { code, label: "the Mac" }), env);
  assert.equal(first.status, 200);
  assert.ok((await first.json()).deviceToken);

  const replay = await worker.fetch(post("/pair/claim", { code }), env);
  assert.equal(replay.status, 401);
});

test("access requests dedupe on the address", async () => {
  const env = makeEnv();
  await worker.fetch(post("/access", { email: "a@example.com" }), env);
  await worker.fetch(post("/access",
    { email: "A@Example.com", phone: "+15550000137" }), env);

  const rows = env.DB._raw.prepare("SELECT * FROM access_request").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, "+15550000137", "a later phone should fill in");
});

test("an unparseable optional phone does not sink the signup", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    post("/access", { email: "a@example.com", phone: "555" }), env);
  assert.equal(res.status, 200);
  const row = env.DB._raw.prepare("SELECT * FROM access_request").all()[0];
  assert.equal(row.phone, null);
});

test("the annotation table has no column for message content", async () => {
  // The boundary, asserted. If someone adds `text` or `body` or `message`
  // to the schema, this fails and they have to argue with it on purpose.
  const env = makeEnv();
  const columns = env.DB._raw.prepare("PRAGMA table_info(annotation)").all()
    .map((c) => c.name);
  for (const forbidden of ["text", "body", "message", "content", "preview",
                           "transcript", "handle", "chat"]) {
    assert.ok(!columns.includes(forbidden),
      `annotation must never carry a "${forbidden}" column`);
  }
  assert.deepEqual(columns.filter((c) => c.startsWith("body")),
    ["body_ct", "body_nonce"], "only sealed bodies");
});
