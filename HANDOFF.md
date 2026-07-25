# HANDOFF — Zettel (zettel.ink)

Read this first, whoever you are — a fresh Claude session, a collaborator,
or Melissa in three months. It is written to be pasted whole into a new
session as the opening prompt.

## What this is

Zettel reads a person's own message archive as a scrubbable track, and lays
a **Z layer** over it — a second sheet in exact register carrying their
marks, ink, spoken notes and the machine's structural proposals. The one
load-bearing idea: **every mark is anchored to a moment `{t, y}`, never to
a pixel or a message id.** Time is the only coordinate every record of a
life shares and no vendor owns. The one law: **message content never
reaches any server we run** — enforced by schema and test, not by policy.

Formerly Wavelength. Renamed Zettel at the July 2026 Night Hack.

## Run it

```sh
cd ~/zettel && python3 serve.py     # → http://localhost:8477
```
Reads `~/Library/Messages/chat.db` read-only (needs Full Disk Access on the
Terminal). Public demo (synthetic archive): the same `app/` on GitHub
Pages — `demo.js` probes `/api/health` once and answers from snapshots when
no server is there.

Checks: `node --test 'test/*.test.js'` · `python3 test/test_serve.py` ·
`cd server && node --test 'test/*.test.js'`. CI runs all three plus a
no-real-phone-numbers sweep of the demo bundle.

## The folder

| path | what |
|---|---|
| `app/` | the client. No build step. `app.js` orchestrates; `waveform.js` owns the one coordinate map everything borrows; `zlayer.js` is the sheet (strata: `?` unanswered, `—` rupture, `◇/◆` readings, `≈` resonance, `◉` voice); `resonance.js` pairs the same question asked years apart, client-side only; `demo.js` is the snapshot shim + live gate; `sw.js` caches the shell, never `/api/` |
| `serve.py` | local archive server, stdlib-only, read-only, 127.0.0.1 only. Sidecar (marks/notes/ink/voice) in `~/Library/Application Support/Zettel/` |
| `contacts.py` `typedstream.py` | recovered verbatim from the original repo |
| `server/` | cloud sync (Cloudflare Worker + D1). **Read `server/schema.sql` first — the annotation table has no content column, and a test fails if one appears** |
| `test/` | client + serve.py fixture suites |
| `index.html` `security.html` | landing page + the trust page (says what is NOT true yet) |

Sibling repo **`spaciousmtness/imessage-timeline`** (private): the complete
original Wavelength — sending, summons, scribe, co-layer, Telegram/Signal
imports, and the founding docs (`PHILOSOPHY.md`, `YC-APPLICATION.md`).
Treat it as the ancestor: recover from it, don't edit it.

## House laws (violating these is a bug, not a style choice)

1. **Content-blind by shape.** `/api/candidates` returns who spoke and how
   long the quiet was — never a word. Reading happens client-side only.
2. **Absent, not inert.** A control that can't do its job isn't rendered.
3. **No shadows; hue never carries meaning alone** — everything must
   survive `filter: grayscale(1)`. Calm mode (`?calm=1`, e-ink) steps
   every transition and stops every pulse.
4. **Two-tap covenant** on anything that sends or destroys.
5. **Honest failure.** Missing verbs answer 501 with a sentence saying
   where the capability actually lives. Nothing pretends.

## State (2026-07-27)

Working on the founder's real archive (276,765 messages): track, stream,
sheet, candidates, resonance + arrival, names from Contacts, search,
export→Claude, PWA, hold-to-speak voice marks (`◉`, audio local, playback
by tap). Everything on branch `claude/zetl-ink-review-lt8j7u` — **PR #1,
open, CI green, one merge away from main.**

Not done, on purpose: transcription of voice/ink (the original's scribe
does this; port it next), `body_ct` client-side sealing (schema ready, key
derivation isn't — do not claim encryption at rest), send/summon (501 until
ported), no third-party security review yet.

## Open decisions (the founder's, not yours)

1. **Closure vs. excavation.** The mission says "without ghosts"; the
   product currently excavates. Proposed: resonance ends in a verb —
   answer / settle / let go — wired to the existing mark-state machine.
2. **Consumer vs. enterprise.** Research says: the primitive's proven
   buyer is incident-review/legal-chronology (Jeli→PagerDuty precedent);
   the consumer moment is resonance, not the sheet. Undecided.
3. The hero copy still sells "a decision ledger" — the third-best thing in
   the building.

## The one question that outranks everything

Nobody but the founder has used this on their own archive. The composition
thesis reduces to one instrumentable event: *does a mark made over one
record get used against another?* Ten people, their own archives, watch
where their hands stop. Everything else is downstream.
