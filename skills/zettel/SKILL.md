---
name: zettel
description: Build, run, verify and ship Zettel (zetl.ink, formerly Wavelength), Melissa's local reader that lays a Z layer of marks over her own message archive, in the repo at ~/zettel. Use whenever she mentions Zettel, zetl.ink, the Z layer, the track, strata, resonance, candidates, the sidecar, the demo on GitHub Pages, the shipping blockers (license, uninstall/export, update path), the ten users, or asks to change, verify or ship anything in that repo, even a small tweak, because the house laws and the content-blind rule here are what a quick change breaks.
analytics: Operate and extend a local-first message-archive reader app, keeping message content off every server and the founder's open product decisions with the founder.
---

# Zettel

Zettel reads a person's own message archive as a scrubbable track and lays a
Z layer over it: marks anchored to a moment `{t, y}`, never to a pixel or a
message id. The one law is that **message content never reaches any server we
run**, enforced by schema and test. This skill is how to work on it without
breaking that, and without deciding things that are Melissa's.

## Boot order, before touching anything

1. `~/zettel/HANDOFF.md`: what it is, how to run it, the house laws, dated state.
2. `~/zettel/SHIPPING.md`: the blockers before a stranger runs it on their archive.
3. The workspace project: `~/Documents/github-repos/melissas-freedom/projects/2026-09-20-zettel/STATE.md`
   for the current next action. It outranks the dated State block in HANDOFF.
4. `git -C ~/zettel status` and the current branch. Work has lived on
   `claude/zetl-ink-review-lt8j7u` (PR #1); confirm whether it has merged to
   `main` before assuming either.
5. Changing anything visual: load `living-paper`. Verifying in a browser: load
   `browser-verification-craft`.

## Run and check

```sh
cd ~/zettel && python3 serve.py          # http://localhost:8477, reads chat.db read-only
node --test 'test/*.test.js'             # client logic
python3 test/test_serve.py               # serve.py against fixtures
cd server && node --test 'test/*.test.js'  # the sync Worker, no network needed
```

Run all three suites after any change and report the real output. CI also
sweeps the demo bundle for any phone number that is not a 555.

**Stale process first.** A "doesn't work on the real archive" report is
usually an old `serve.py` or an old tab. Check what is on 8477, restart, open a
fresh tab, before debugging. A Claude-spawned `python3` may not hold Full Disk
Access; verify through `/api/health` rather than assuming, and ask before
killing a server she started.

## House laws (breaking one is a bug)

1. **Content-blind by shape.** Server routes (`/api/candidates` and anything
   new) return who spoke and how long the quiet lasted, never a word. Reading
   happens client-side only.
2. **The archive is never written.** One `sqlite3` connection to chat.db,
   `mode=ro`. Writes go only to the sidecar in
   `~/Library/Application Support/Zettel/` (mode 0700).
3. **`server/schema.sql` has no content column**, and a test fails if one
   appears. Read the schema before any Worker code. The Worker is not
   deployed and stays undeployed until sharing between people is a real
   product.
4. **Absent, not inert.** A control that cannot do its job is not rendered.
   Missing verbs answer 501 with a sentence saying where the capability lives.
5. **Design:** one hue (amber), no shadows, everything survives
   `filter: grayscale(1)`, silence. Calm mode (`?calm=1`) steps every
   transition for e-ink.
6. **Two-tap covenant** on anything that sends or destroys.
7. **Honest claims.** `security.html` says what is not true yet. Never claim
   encryption at rest: marks are stored unencrypted until a key-derivation
   decision is made.

## Content-blind in what you say, too

Anything you print, remember, commit or put in a report about her archive is
counts and booleans, never her words or a contact's name. The demo carries a
synthetic archive of invented people; keep real data out of `app/snap` and
out of fixtures. A bug report goes through `report-a-zettel-bug`, which
allow-lists its context for exactly this reason.

## The ancestor repo is read-only

`~/Claude_Tools/imessage-timeline` (private, the original Wavelength) holds
sending, summons, the scribe, the co-layer and the founding docs. Recover
code from it into `~/zettel`; never edit it. The `wavelength` skill covers
that repo.

## What is Melissa's, not yours

Present these with a recommendation and stop. Never settle them in code or copy:

- **The license** (SHIPPING.md recommends Apache-2.0). Hard to reverse.
- Closure vs excavation (whether resonance ends in answer / settle / let go).
- Consumer vs enterprise.
- Hero copy, the name's trademark check, who the ten people are.
- Anything that sends a message, publishes, or pushes to `main`.

Everything else inside a task she asked for (a fix, a test, a SHIPPING item
with an obvious answer) is yours to decide and do.

## Shipping to the ten

The goal is ten people running it on their own archive, answering one
question: does a mark made over one record get used against another. Work the
unchecked SHIPPING.md blockers in order: license, a real disclosure path in
SECURITY.md, uninstall and export, second-party consent copy, update path, a
way to hear back. Tick a box in SHIPPING.md only when the thing is verified,
in the same commit as the work.

## After the work

- Write a dated line in the project's STATE.md through
  `freedom:create-or-update-project`, and move its next action if it moved.
- Update HANDOFF.md's State block when what is live changes, with the date.
- Commit in `~/zettel` with a plain message; push only to the working branch
  unless she says merge.

## Quality bar

Great: the change works on the real archive through `/api/health` and the
three suites, no word of content crossed a boundary, and the next session
opens on a written next action. Mediocre: green tests on fixtures only.
Bad: a server route or a report that carries message text, or a founder
decision made quietly in code.
