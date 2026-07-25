import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail, normalizePhone, normalizeTimeline, normalizeAnchor }
  from "../src/lib/validate.js";

test("email normalises case and trims", () => {
  assert.equal(normalizeEmail("  Melissa@Example.COM "), "melissa@example.com");
});

test("email keeps +tags and dots apart", () => {
  // Collapsing these decides for the user that two deliverable addresses
  // are one account. They are not, and they may have separated them on
  // purpose.
  assert.equal(normalizeEmail("a+zettel@gmail.com"), "a+zettel@gmail.com");
  assert.notEqual(normalizeEmail("a.b@gmail.com"), normalizeEmail("ab@gmail.com"));
});

test("email refuses the shapes that break delivery", () => {
  for (const bad of ["", "  ", "no-at-sign", "a@b", "a@@b.com", "a b@c.com",
                     "a@b .com", "@b.com", "a@", null, undefined,
                     "a@b.c" .padEnd(300, "x")]) {
    assert.equal(normalizeEmail(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("phone requires an explicit country code", () => {
  // The README's own warning, enforced: a bare ten digits is not knowably
  // +1, and guessing collides unrelated numbers across countries.
  assert.equal(normalizePhone("5550000137"), null);
  assert.equal(normalizePhone("+15550000137"), "+15550000137");
});

test("phone folds the punctuation people actually type", () => {
  const want = "+15550000137";
  for (const spelling of ["+1 555 000 0137", "+1 (555) 000-0137",
                          "+1-555-000-0137", "  +15550000137  ",
                          "0015550000137"]) {
    assert.equal(normalizePhone(spelling), want, `failed on ${spelling}`);
  }
});

test("phone refuses out-of-range and malformed", () => {
  for (const bad of ["+0123456789", "+1234567", "+1234567890123456",
                     "+", "++15550000137", "phone", "", null]) {
    assert.equal(normalizePhone(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("timeline handle must look opaque", () => {
  const ok = "a".repeat(64);
  assert.equal(normalizeTimeline(ok), ok);
  // The point of the check: a client that forgets to hash gets refused
  // rather than quietly writing a phone number into the annotation table.
  assert.equal(normalizeTimeline("+15550000137"), null);
  assert.equal(normalizeTimeline("A".repeat(64)), null);     // uppercase hex
  assert.equal(normalizeTimeline("a".repeat(63)), null);
  assert.equal(normalizeTimeline("a".repeat(65)), null);
  assert.equal(normalizeTimeline(""), null);
});

test("anchor orders t0 and t1", () => {
  assert.deepEqual(normalizeAnchor({ t0: 200, t1: 100 }), { t0: 100, t1: 200, y: null });
});

test("anchor defaults t1 to t0 for a point mark", () => {
  assert.deepEqual(normalizeAnchor({ t0: 500 }), { t0: 500, t1: 500, y: null });
});

test("anchor clamps y to the sheet", () => {
  assert.equal(normalizeAnchor({ t0: 1, y: 5 }).y, 1);
  assert.equal(normalizeAnchor({ t0: 1, y: -3 }).y, 0);
  assert.equal(normalizeAnchor({ t0: 1, y: 0.5 }).y, 0.5);
});

test("anchor refuses a non-finite or out-of-era timestamp", () => {
  // Milliseconds passed as seconds is the usual slip; stored silently it
  // puts a mark 50,000 years out where no view will ever show it again.
  assert.equal(normalizeAnchor({ t0: Date.now() }), null);
  assert.equal(normalizeAnchor({ t0: NaN }), null);
  assert.equal(normalizeAnchor({ t0: Infinity }), null);
  assert.equal(normalizeAnchor({ t0: "not a time" }), null);
  assert.equal(normalizeAnchor({ t0: -1 }), null);
  assert.equal(normalizeAnchor({}), null);
});

test("anchor refuses a non-finite y rather than storing NaN", () => {
  assert.equal(normalizeAnchor({ t0: 1, y: NaN }), null);
  assert.equal(normalizeAnchor({ t0: 1, y: "high" }), null);
});
