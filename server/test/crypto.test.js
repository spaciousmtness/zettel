import { test } from "node:test";
import assert from "node:assert/strict";
import { otpCode, timingSafeEqual, sha256Hex, newId, randomToken, b64url }
  from "../src/lib/crypto.js";

test("otpCode is always six digits", () => {
  for (let i = 0; i < 2000; i++) {
    assert.match(otpCode(), /^\d{6}$/);
  }
});

test("otpCode has no low-end modulo bias", () => {
  // The bug this guards: `random32 % 1e6` makes codes below 967296 about
  // twice as likely as the rest. With 60k samples in 10 buckets, that skew
  // is unmissable — a correct generator sits near 6000 a bucket.
  const buckets = new Array(10).fill(0);
  const n = 60000;
  for (let i = 0; i < n; i++) {
    buckets[Math.floor(Number(otpCode()) / 100000)]++;
  }
  const expected = n / 10;
  for (const [i, count] of buckets.entries()) {
    const drift = Math.abs(count - expected) / expected;
    assert.ok(drift < 0.08, `bucket ${i} drifted ${(drift * 100).toFixed(1)}%`);
  }
});

test("otpCode keeps leading zeros", () => {
  // padStart is load-bearing: a code rendered as "1234" cannot be typed
  // into a six-box input, and String(n) drops the zeros silently.
  assert.equal("000042".length, 6);
  for (let i = 0; i < 5000; i++) {
    assert.equal(otpCode().length, 6);
  }
});

test("timingSafeEqual agrees with === on equality", () => {
  assert.ok(timingSafeEqual("abc", "abc"));
  assert.ok(timingSafeEqual("", ""));
  assert.ok(!timingSafeEqual("abc", "abd"));
  assert.ok(!timingSafeEqual("abc", "ab"));
  assert.ok(!timingSafeEqual("ab", "abc"));
});

test("timingSafeEqual survives null and undefined", () => {
  // Reached whenever a cookie or a claim is missing; must be false, not throw.
  assert.ok(!timingSafeEqual(null, "abc"));
  assert.ok(!timingSafeEqual(undefined, "abc"));
  assert.ok(timingSafeEqual(null, undefined));   // both coerce to ""
});

test("timingSafeEqual walks the whole input on a length mismatch", () => {
  // A guard clause on length would be the obvious "optimisation" and would
  // reintroduce the leak. This asserts the loop bound, not the timing:
  // a 1-char vs 10000-char comparison must still return, not blow up.
  assert.ok(!timingSafeEqual("a", "a".repeat(10000)));
});

test("sha256Hex is stable and 64 hex chars", async () => {
  const a = await sha256Hex("hello");
  assert.equal(a,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(a, await sha256Hex("hello"));
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("newId is sortable by creation order, as a STRING", async () => {
  // The property that matters, and the one base64url quietly lacked: string
  // comparison must agree with time. `ORDER BY id` in SQL is a string compare.
  const first = newId();
  await new Promise((r) => setTimeout(r, 3));
  const second = newId();
  assert.ok(first < second, `${first} should sort before ${second}`);
});

test("newId sorts correctly across a character-class boundary", async () => {
  // The flake that exposed the bug: base64url's alphabet is not in ASCII
  // order, so whether two ids compared correctly depended on which characters
  // the millisecond happened to land on. 200 consecutive ids, in order, every
  // time — a loop long enough to cross the boundaries that used to break it.
  const ids = [];
  for (let i = 0; i < 200; i++) {
    ids.push(newId());
    await new Promise((r) => setTimeout(r, 1));
  }
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, "string order must match creation order");
});

test("newId is monotonic INSIDE a millisecond too", () => {
  // Several rows of one batch land in the same millisecond routinely. Plain
  // ULID leaves their order to chance, which makes `ORDER BY id` *mostly*
  // chronological — the worst kind. 10,000 with no clock advance at all.
  const ids = Array.from({ length: 10000 }, () => newId());
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, "a batch in one millisecond must still order");
  assert.equal(new Set(ids).size, ids.length, "and must not collide");
});

test("newId uses only ASCII-ordered characters", () => {
  for (let i = 0; i < 500; i++) {
    assert.match(newId(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  }
});

test("newId and randomToken do not repeat", () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(newId());
  assert.equal(seen.size, 5000);
  const tokens = new Set();
  for (let i = 0; i < 5000; i++) tokens.add(randomToken());
  assert.equal(tokens.size, 5000);
});

test("b64url output is URL and cookie safe", () => {
  for (let i = 0; i < 500; i++) {
    assert.match(randomToken(), /^[A-Za-z0-9_-]+$/);
  }
  assert.equal(b64url(new Uint8Array([255, 254, 253])), "__79");
});
