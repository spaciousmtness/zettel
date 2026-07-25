# Zettel

**Find the questions you never answered.**

Zettel reads a conversation archive as a *track* you can drag, mark and
annotate — three years of messages as one gesture instead of an infinite
scroll.

**Live demo → https://spaciousmtness.github.io/zettel/**
The demo carries a **synthetic archive of invented people**. No real
conversation is ever on a server.

---

## The Z layer

Annotation is usually a mark *on* a record. Here it is a **second sheet laid
over it**, in exact register, that you can lift.

Press `z`. The record drops back to a whisper and a translucent plane comes
up carrying its own marks. Lower it and there is nothing but your own
conversation again.

Depth is carried without a single shadow — the design system bans them —
using three things instead: vellum material, registration ticks like a
drafting overlay pinned by crosses, and parallax on the labels. One scalar
raises the sheet and recedes the ground together. There is no second mode and
no modal.

On e-ink the lift **steps** rather than tweening, because interpolating
between two planes leaves ghost trails on the panel.

### Why `{t, y}` is the whole idea

A stroke on the sheet is stored as a **UNIX moment and a normalised height**.
Never pixels. Never a message id, never a document offset.

So a mark is anchored to a *moment*, not to a document. Drag the track from
five years down to ninety days and the handwriting stretches with the years,
because it reads the same coordinate map the record does.

That generalises further than it looks. An annotation anchored to **time**
composes with every document that shares that timeline — messages, mail,
a calendar, a commit log. They are all different records over one life. Today
each has its own private annotation system and none of them compose, because
each anchors to its own ids. `x` and `y` belong to the document underneath.
**`z` is the axis the document doesn't own.**

## The intelligence that costs nothing

`GET /api/candidates` proposes where a reader might want to look, using
**structure alone** — no model, no network, no spend:

- **unanswered** — a question, then half a day or more of quiet
- **rupture** — the thread's longest silences, and who ended them

It answers with *who spoke and how long the quiet lasted*, and **never a word
of content**:

```json
{ "kind": "unanswered",
  "reason": "they asked, then 2 weeks quiet",
  "gap": 1213980,
  "anchor": { "from": "…", "to": "…", "from_ts": 0, "to_ts": 0 } }
```

That shape is the point. The route is **content-blind by construction**,
which is exactly what makes it safe to publish. The overlay proposes; it
never reads. Candidates render only when the sheet is lifted, so nothing
appears unless you raise it.

### Resonance — the question that came back

The server proposes two silences. The **client** — in your browser, over
messages already on your screen — checks whether they were the same sentence.

When they are, and they are far enough apart to mean something, the sheet
ties them together with a hairline and marks each end `≈`:

> *"are you happy though. like actually?"* — asked in **2023**, unanswered
> for 14 hours.
> The same sentence, asked **back** in **2026**, unanswered for 3 days.

Nothing searched for it. Arithmetic over timestamps and question marks found
the two silences; a string comparison in the reader's own browser found that
they rhymed.

The division is exact, and it is the same boundary the server draws from the
other side:

| | sees |
|---|---|
| server | *"a question here, then a fortnight of quiet"* — structure, no content |
| client | *"…and it is the same question as that one"* — content, local |

Exactness is the feature. Two askings pair only if the normalised sentences
are **identical**, at least fourteen characters, at least six months apart,
and were questions when they were asked. A fuzzy matcher would turn a rare,
striking finding into ambient noise.

## Privacy as a mechanism, not a policy

- The archive is opened through **exactly one** `sqlite3` connection,
  `mode=ro`, and is never written.
- The intelligence route is content-blind **by shape**, so there is no
  configuration in which a real message reaches the internet.
- The public build is driven by a generated synthetic archive. The real
  application reads your own archive locally and speaks to nothing.

### The server, when there is one

`server/` is a Cloudflare Worker holding accounts, device pairing, and
Z-layer sync. Read [`server/schema.sql`](server/schema.sql) before any of the
JavaScript — the shape of it is the argument.

**There is no column anywhere in that schema for the content of a message.**
Not empty, not nullable, not "we don't populate it." It does not exist, and a
test fails if anyone adds one.

What syncs is an annotation: an opaque `timeline` handle the *client* derives
by HMAC-ing a thread identifier with the account's own salt, the coordinate
`(t0, t1, y)`, and a body. The strongest sentence anyone can build from that
table — including us, including a subpoena — is *"this account marked
something in this opaque bucket at this moment."*

The plain-language version is at [`/security.html`](security.html), including
the parts that are **not** true yet.

## Some things that were harder than they look

- Message text lives in `attributedBody` **typedstream blobs**, not
  `message.text`, on modern macOS. Question detection decodes blobs — but
  only at the ~120 gap boundaries the SQL already selected, so it stays cheap
  on a 200,000-message archive.
- Dates are **nanoseconds since 2001-01-01**, occasionally seconds on ancient
  rows. Pagination uses composite `(date, ROWID)` row-value cursors, never
  `OFFSET`, because restores and edits break the ROWID≈date correlation.
- One person is many chat rows — iMessage/SMS split plus spelling variants of
  the same number. Merging preserves country codes, because truncating every
  number to ten digits collides unrelated `+1` and `+91` recipients.
- The static demo is driven by a `window.fetch` shim that **composes with the
  app's existing CSRF fetch shim**, so 215KB of reviewed client logic needed
  zero changes. Message paging is reimplemented in JS against the server's
  exact cursor semantics.

## Design

One hue (amber). No shadows, anywhere. Every meaning-bearing distinction
survives `filter: grayscale(1)` — form carries it, never colour. Silence: no
interface sounds. The only living light is an ember pulse on a single 2.6s
tempo. Tokens live in `forme-tokens.css`; components may consume them and may
not invent their own.

Built to be read on paper-like screens, including a Daylight DC-1 e-ink
tablet, where `?calm=1` steps every transition and stops every pulse.

## Installable

A manifest, dimension-verified icons, and a service worker that precaches the
whole ES-module graph but **never** an `/api/` response — so offline degrades
honestly instead of showing stale data. Add to Home Screen on any phone.

## Running the checks

```sh
node --test 'test/*.test.js'          # the client's pure logic
cd server && node --test 'test/*.test.js'   # auth and sync, end to end
```

The server suite stands D1 up on `node:sqlite` and KV on a `Map`, so the
whole sign-in and sync flow runs with no network and no Cloudflare account.
CI additionally checks that every module parses and that **no non-555 phone
number** has crept into the demo bundle this README promises is synthetic.

---

*Made at a Night Hack with [Claude Code](https://claude.com/claude-code).
zettel.ink*
