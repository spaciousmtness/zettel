// Resonance — the same question, asked again, years later.
//
// The README has always told this story as an anecdote: "are you happy
// though. like actually?" asked in 2023 and unanswered for 14 hours; the
// same sentence asked BACK in 2026 and unanswered for 3 days. It was true,
// and a person had to be told it. The app never found it.
//
// This finds it, on any archive.
//
// WHERE THIS RUNS, AND WHY THAT MATTERS. /api/candidates is content-blind by
// construction — it proposes "someone asked, then a fortnight of quiet" out
// of timestamps and question marks alone, and never returns a word of what
// was said. That contract is what makes the route safe to publish, and this
// module does not weaken it: the pairing happens HERE, on the client, in the
// reader's own browser, over messages the reader is already entitled to see.
// The server proposes where to look. The client is the only thing that reads.
//
// So the division is exact:
//   server  — "a question here, then silence"     (structure, no content)
//   client  — "…and it is the same question as that one"   (content, local)
//
// A resonance is emitted as an ordinary Z-layer entry with kind "resonance",
// one at each end of the pair, so it needs no new geometry: the existing
// place/cluster/tab path draws it like anything else on the sheet.

// Two askings closer together than this are a follow-up, not a return. Six
// months is the smallest gap where "you asked me this again" carries any
// weight — below it you catch someone nagging about the dishes.
const MIN_APART = 180 * 86400;

// Short questions collide constantly: "you ok?", "still up?", "what?" are
// asked by everyone a hundred times and mean nothing by recurrence. The
// floor is on the NORMALISED form, so punctuation and case cost nothing.
const MIN_CHARS = 14;

/** Strip a sentence down to what would make two askings "the same".
 *
 *  Case, punctuation and whitespace go. Nothing else does — no stemming, no
 *  stopword removal, no fuzzy distance. A near-match is not a resonance; the
 *  whole force of the thing is that it is the SAME sentence, and a detector
 *  that fires on merely-similar sentences turns a rare, striking finding
 *  into ambient noise. Exactness is the feature. */
export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // combining marks from the NFKD split
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // punctuation, emoji, the question mark
    .replace(/\s+/g, " ")
    .trim();
}

/** Is this the kind of utterance a return could matter for?
 *
 *  It has to have been a question when it was asked. We check the RAW text
 *  for the mark rather than the normalised form, because normalising strips
 *  it — and a sentence that was never a question recurring is a catchphrase,
 *  not a reckoning. */
export function asks(raw, normalized) {
  if (!/[?？]/.test(String(raw ?? ""))) return false;
  return normalized.length >= MIN_CHARS;
}

/** Pair up askings of the same sentence.
 *
 *  `entries` is [{ candidate, text }] — a Z-layer candidate and the text of
 *  the message its anchor points at. Returns resonance entries in the same
 *  shape the sheet already draws, TWO per pair (one at each end), each
 *  naming the other's year so a tab reads without being opened.
 *
 *  Pairs are consecutive within a repeated sentence, not all-to-all: a
 *  sentence asked four times over a decade is three returns, not six. */
export function findResonances(entries) {
  const bySentence = new Map();

  for (const entry of entries || []) {
    const raw = entry?.text;
    const ts = Number(entry?.candidate?.anchor?.from_ts);
    if (!Number.isFinite(ts)) continue;
    const key = normalize(raw);
    if (!asks(raw, key)) continue;
    if (!bySentence.has(key)) bySentence.set(key, []);
    bySentence.get(key).push({ ts, raw, candidate: entry.candidate });
  }

  const out = [];
  for (const [key, askings] of bySentence) {
    if (askings.length < 2) continue;
    askings.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < askings.length; i++) {
      const first = askings[i - 1];
      const again = askings[i];
      if (again.ts - first.ts < MIN_APART) continue;
      out.push(...pair(key, first, again));
    }
  }
  // strongest first — the longest silence between two askings of the same
  // sentence is the one worth landing a stranger on
  out.sort((a, b) => b.apart - a.apart);
  return out;
}

function pair(key, first, again) {
  const apart = again.ts - first.ts;
  const firstYear = new Date(first.ts * 1000).getFullYear();
  const againYear = new Date(again.ts * 1000).getFullYear();
  const span = describe(apart);

  const make = (self, other, otherYear, tense) => ({
    kind: "resonance",
    id: `resonance:${key}:${self.ts}`,
    // The reason is the tab's own label and its aria-label, so it has to
    // read as a sentence on its own — nothing else tells you what you found.
    reason: tense === "again"
      ? `asked again — ${span} after ${otherYear}`
      : `asked again in ${otherYear} — ${span} later`,
    apart,
    text: self.raw,
    sentence: key,
    // Both ends of the pair carry the WHOLE pair, so a tab can offer to
    // travel to its twin without going back to the index for it.
    pair: { first: first.ts, again: again.ts, firstYear, againYear, span },
    anchor: {
      from: self.candidate?.anchor?.from,
      to: self.candidate?.anchor?.to,
      from_ts: self.ts,
      to_ts: self.ts,
      ts: self.ts,
    },
    // where the other end is, for the travel verb
    twin_ts: other.ts,
  });

  return [make(first, again, againYear, "first"),
          make(again, first, firstYear, "again")];
}

/** A span of time in the register the rest of the interface speaks: plain
 *  words, no decimals, never "1 years". */
export function describe(seconds) {
  const days = Math.round(seconds / 86400);
  if (days < 60) return `${days} days`;
  const months = Math.round(days / 30.44);
  // Hand over to years at twelve, not twenty-four. "12 months apart" is
  // something no one says out loud, and this string is read aloud — it is
  // the line under the sentence on the arrival card.
  if (months < 12) return `${months} months`;
  const years = seconds / (365.25 * 86400);
  const rounded = Math.round(years * 10) / 10;
  return Number.isInteger(rounded)
    ? `${rounded} year${rounded === 1 ? "" : "s"}`
    : `${rounded} years`;
}

/** Fetch the anchor text for each candidate, then pair them.
 *
 *  Cost control, because this runs against a reader's own machine and an
 *  archive that may hold 200,000 messages:
 *    - only `unanswered` candidates are read. A rupture is a silence, not a
 *      sentence; there is nothing to match.
 *    - one message per candidate (`limit=1&around=`), never a page.
 *    - a hard ceiling on how many are read at all.
 *    - one at a time is wrong (slow) and all at once is wrong (a burst of
 *      forty requests at a local server that is also serving the stream), so
 *      it goes in small waves.
 *
 *  Any failure yields an empty list. A sheet that draws without resonances
 *  is the sheet that shipped yesterday; a sheet that throws is a regression. */
export async function scan(candidates, { chat, fetchJson, limit = 40 } = {}) {
  const asked = (candidates || [])
    .filter((c) => c?.kind === "unanswered" &&
                   Number.isFinite(Number(c?.anchor?.from_ts)))
    .slice(0, limit);
  if (asked.length < 2) return [];

  const entries = [];
  const WAVE = 6;
  for (let i = 0; i < asked.length; i += WAVE) {
    const wave = asked.slice(i, i + WAVE);
    const texts = await Promise.all(wave.map(async (candidate) => {
      try {
        const q = encodeURIComponent(chat);
        const at = Number(candidate.anchor.from_ts);
        const data = await fetchJson(
          `/api/messages?chat=${q}&around=${at}&limit=1`);
        const rows = data?.messages || [];
        // `around` returns the anchor plus its neighbour; take the row that
        // IS the anchor — by guid when we have one, else by timestamp — and
        // never simply the first, which is the neighbour half the time.
        const want = candidate.anchor.from;
        const hit = (want && rows.find((m) => m.guid === want))
          || rows.find((m) => Math.abs(Number(m.date_unix) - at) < 1)
          || null;
        return hit ? { candidate, text: hit.text } : null;
      } catch { return null; }
    }));
    for (const entry of texts) if (entry?.text) entries.push(entry);
  }
  return findResonances(entries);
}
