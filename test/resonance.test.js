import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalize, asks, describe as describeSpan, findResonances, scan }
  from "../app/resonance.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const YEAR = 365.25 * 86400;
const at = (iso) => Date.parse(iso) / 1000;

const candidateAt = (ts, guid = `G-${ts}`) => ({
  kind: "unanswered",
  reason: "they asked, then quiet",
  anchor: { from: guid, to: `${guid}b`, from_ts: ts, to_ts: ts + 3600, ts },
});

const entry = (iso, text) => ({ candidate: candidateAt(at(iso)), text });

// ---- normalisation --------------------------------------------------------

test("normalize folds case, punctuation and spacing", () => {
  assert.equal(normalize("Are you HAPPY though.  Like actually?"),
                          "are you happy though like actually");
  assert.equal(normalize("are  you\nhappy   though. like actually?!"),
                          "are you happy though like actually");
});

test("normalize strips emoji and keeps letters across scripts", () => {
  assert.equal(normalize("are you ok? 🩷"), "are you ok");
  assert.equal(normalize("¿estás bien?"), "estas bien");
});

test("normalize survives null and undefined", () => {
  assert.equal(normalize(null), "");
  assert.equal(normalize(undefined), "");
});

test("asks requires a question mark in the RAW text", () => {
  // normalize() strips the mark, so the check has to run on the original —
  // a declarative sentence recurring is a catchphrase, not a reckoning
  const long = "are you happy though like actually";
  assert.ok(asks("are you happy though. like actually?", long));
  assert.ok(!asks("are you happy though. like actually.", long));
});

test("asks refuses short utterances", () => {
  // "you ok?" recurs in every archive on earth and means nothing by recurrence
  for (const short of ["you ok?", "what?", "still up?", "hey?"]) {
    assert.ok(!asks(short, normalize(short)), `should refuse ${short}`);
  }
});

// ---- pairing --------------------------------------------------------------

test("the same question years apart is a resonance", () => {
  const found = findResonances([
    entry("2023-09-22T06:58:00Z", "are you happy though. like actually?"),
    entry("2026-07-14T04:40:00Z", "are you happy though. like actually?"),
  ]);
  assert.equal(found.length, 2, "one entry at each end of the pair");
  assert.equal(found[0].kind, "resonance");
  assert.equal(found[0].pair.firstYear, 2023);
  assert.equal(found[0].pair.againYear, 2026);
});

test("both ends know where the other is", () => {
  const found = findResonances([
    entry("2023-09-22T06:58:00Z", "are you happy though. like actually?"),
    entry("2026-07-14T04:40:00Z", "are you happy though. like actually?"),
  ]);
  const [a, b] = found;
  assert.equal(a.twin_ts, b.anchor.from_ts);
  assert.equal(b.twin_ts, a.anchor.from_ts);
});

test("a question repeated next week is not a resonance", () => {
  // the floor that separates "you asked me this again" from nagging
  const found = findResonances([
    entry("2024-01-01T10:00:00Z", "did you ever call the landlord back?"),
    entry("2024-01-08T10:00:00Z", "did you ever call the landlord back?"),
  ]);
  assert.deepEqual(found, []);
});

test("punctuation and case differences still pair", () => {
  const found = findResonances([
    entry("2021-03-01T10:00:00Z", "Do you still think about moving?"),
    entry("2024-03-01T10:00:00Z", "do you still think about moving??"),
  ]);
  assert.equal(found.length, 2);
});

test("merely similar questions do NOT pair", () => {
  // exactness is the feature: a fuzzy matcher turns a rare, striking finding
  // into ambient noise, and the whole force is that it is the SAME sentence
  const found = findResonances([
    entry("2021-03-01T10:00:00Z", "do you still think about moving?"),
    entry("2024-03-01T10:00:00Z", "do you ever think about moving away?"),
  ]);
  assert.deepEqual(found, []);
});

test("three askings are two returns, not three pairs", () => {
  const found = findResonances([
    entry("2019-01-01T10:00:00Z", "are we actually going to do this?"),
    entry("2022-01-01T10:00:00Z", "are we actually going to do this?"),
    entry("2025-01-01T10:00:00Z", "are we actually going to do this?"),
  ]);
  assert.equal(found.length, 4, "two consecutive pairs, two entries each");
});

test("the longest silence sorts first", () => {
  const found = findResonances([
    entry("2020-01-01T10:00:00Z", "are you happy though. like actually?"),
    entry("2025-01-01T10:00:00Z", "are you happy though. like actually?"),
    entry("2023-01-01T10:00:00Z", "do you still think about moving?"),
    entry("2024-01-01T10:00:00Z", "do you still think about moving?"),
  ]);
  // a stranger lands on the strongest thing in the archive, not the first
  assert.ok(found[0].apart > found[found.length - 1].apart);
  assert.equal(found[0].pair.firstYear, 2020);
});

test("a candidate with a non-finite anchor is skipped, not fatal", () => {
  const broken = { candidate: { kind: "unanswered", anchor: { from_ts: NaN } },
                   text: "are you happy though. like actually?" };
  const found = findResonances([
    broken,
    entry("2023-09-22T06:58:00Z", "are you happy though. like actually?"),
    entry("2026-07-14T04:40:00Z", "are you happy though. like actually?"),
  ]);
  assert.equal(found.length, 2);
});

test("findResonances tolerates junk input", () => {
  assert.deepEqual(findResonances(null), []);
  assert.deepEqual(findResonances([]), []);
  assert.deepEqual(findResonances([{}, { text: "hi?" }, null]), []);
});

// ---- spans read like a person wrote them ----------------------------------

test("describe never says 1 years or a decimal day", () => {
  assert.equal(describeSpan(10 * 86400), "10 days");
  assert.equal(describeSpan(200 * 86400), "7 months");
  assert.equal(describeSpan(Math.round(YEAR)), "1 year");
  assert.equal(describeSpan(Math.round(2 * YEAR)), "2 years");
  assert.match(describeSpan(Math.round(2.83 * YEAR)), /^2\.8 years$/);
});

// ---- against the real demo archive ----------------------------------------

test("the demo archive's 2023 question and its 2026 return are found", async () => {
  // The README has told this story as an anecdote since the hackathon. This
  // asserts the app now finds it, from the same data a stranger loads.
  const corpus = JSON.parse(readFileSync(
    join(repo, "app/snap/corpus-5555550137.json"), "utf8"));
  const candidates = JSON.parse(readFileSync(
    join(repo, "app/snap/candidates-a5a2d7f3d4.json"), "utf8")).candidates;

  const byGuid = new Map(corpus.messages.map((m) => [m.guid, m]));

  // stand in for /api/messages?around=&limit=1 exactly as demo.js answers it
  const fetchJson = async (url) => {
    const around = Number(new URL(url, "https://x").searchParams.get("around"));
    const hit = corpus.messages.find(
      (m) => Math.abs(Number(m.date_unix) - around) < 1);
    return { messages: hit ? [hit] : [] };
  };

  const found = await scan(candidates, { chat: "+15555550137", fetchJson });
  assert.ok(found.length >= 2, "the demo archive should carry a resonance");

  const top = found[0];
  assert.match(top.text, /are you happy though/);
  assert.equal(top.pair.firstYear, 2023);
  assert.equal(top.pair.againYear, 2026);

  // and both ends point at real messages in the archive
  for (const end of found.slice(0, 2)) {
    assert.ok(byGuid.has(end.anchor.from),
      `${end.anchor.from} should be a real message`);
  }
});

test("scan reads only unanswered candidates, and one message each", async () => {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    return { messages: [] };
  };
  const candidates = [
    { kind: "unanswered", anchor: { from: "a", from_ts: at("2020-01-01T00:00:00Z") } },
    { kind: "rupture",    anchor: { from: "b", from_ts: at("2021-01-01T00:00:00Z") } },
    { kind: "unanswered", anchor: { from: "c", from_ts: at("2022-01-01T00:00:00Z") } },
  ];
  await scan(candidates, { chat: "+1", fetchJson });
  assert.equal(calls.length, 2, "a rupture is a silence — no sentence to match");
  for (const url of calls) assert.match(url, /limit=1/);
});

test("scan survives a route that throws on every call", async () => {
  const found = await scan(
    [candidateAt(at("2020-01-01T00:00:00Z")), candidateAt(at("2024-01-01T00:00:00Z"))],
    { chat: "+1", fetchJson: async () => { throw new Error("offline"); } });
  assert.deepEqual(found, [],
    "a sheet without echoes is yesterday's sheet; a sheet that throws is a regression");
});

test("scan takes the anchor row, not its neighbour", async () => {
  // /api/messages?around= returns the anchor PLUS the next message. Taking
  // rows[0] blindly pairs the wrong sentences roughly half the time.
  const ts1 = at("2020-01-01T00:00:00Z"), ts2 = at("2024-01-01T00:00:00Z");
  const fetchJson = async (url) => {
    const around = Number(new URL(url, "https://x").searchParams.get("around"));
    return {
      messages: [
        { guid: `G-${around}`, date_unix: around,
          text: "are you happy though. like actually?" },
        { guid: "neighbour", date_unix: around + 60, text: "anyway. dinner?" },
      ],
    };
  };
  const found = await scan([candidateAt(ts1, `G-${ts1}`), candidateAt(ts2, `G-${ts2}`)],
    { chat: "+1", fetchJson });
  assert.equal(found.length, 2);
  assert.match(found[0].text, /are you happy though/);
});
