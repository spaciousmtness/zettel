---
name: report-a-zettel-bug
description: Turn something wrong with Zettel (formerly Wavelength) into a report Melissa can act on, without the reporter leaking a single word of their message archive. Checks for an existing report, gathers an allow-listed context block, drafts a redacted issue, routes security holes to private vulnerability reporting, and posts only on the reporter's explicit yes. Use when someone running Zettel says "report this", "file a bug", "this is broken", "Zettel won't load", "tell Melissa", or hits a wrong screen, a crash, or a 501 they did not expect.
---

# Report a Zettel bug

Zettel reads a person's entire message archive. So a bug report here has two
jobs, and the second outranks the first: tell Melissa enough to fix it, and
carry **nothing** from the archive while doing it. A report that leaks one
line of someone's texts is worse than no report.

**Why this exists.** The only people who can see a Zettel bug are the ones
running it on their own archive, which is exactly the thing nobody else can
look at. The founder's archive does not reproduce a tester's bug. So the
reporting path has to be easy, and safe by construction rather than by care.

Building this for another project? `PLUMBING.md` beside this file explains
the pieces, why each exists, and the build order.

## The one rule: the reporter approves the post

Never file silently. Draft it, show it, post only on an explicit yes. A
GitHub issue is posted under the reporter's own handle, permanently.

## Step 1: Is it a security hole? Then it never goes public.

Anything that lets code the user did not run reach the local server, lets
archive data leave the machine, or makes a claim on `/security.html` untrue,
is a vulnerability (see `SECURITY.md`, "What is in scope").

Those go through **GitHub private vulnerability reporting**:
`https://github.com/spaciousmtness/zettel/security/advisories/new`. Draft the
same body as below, show it, and hand the reporter that link. Never open a
public issue for one, and never paste a working exploit anywhere.

The three items under "Known and deliberate" in `SECURITY.md` are not new
bugs. Say so, and point at the line.

## Step 2: Do not file a duplicate

```bash
gh issue list --repo spaciousmtness/zettel --state all --search "<3-5 distinctive words>"
```

If one matches, comment there instead: what is different about this sighting
(commit, macOS version, what they were doing).

## Step 3: Gather the context, and show exactly what leaves

```bash
python3 .claude/skills/report-a-zettel-bug/scripts/gather_context.py
```

Paste its output in front of the reporter before anything is filed. It is an
allow-list: commit and branch, whether there are local changes, macOS,
architecture, Python, whether the server is running, db status and message
**count**, whether autostart is installed, and how many sidecar files exist.
The server's health reply also carries contact aliases; the script drops
them, and `test/test_gather_context.py` fails if that ever changes.

## Step 4: Redact before drafting

**Never include:** message text, contact names, phone numbers, emails, thread
titles, mark or note contents, voice or ink content, or any absolute path
(`/Users/<name>/…` names the person).

**Do include:** the commit, the exact route or command, the exact error, the
HTTP status, what was expected, and what happened. Use placeholders:
`<a contact>`, `<a thread>`, `~/…`.

**A screenshot of Zettel is the archive.** The track, the stream and the
sheet show names and words. So a screenshot is only allowed from the public
demo (`https://spaciousmtness.github.io/zettel/`, invented people), or with
every name and message cropped out, and the reporter must see the exact
image first. If the bug only shows on their real archive, describe it and say
a screenshot is available privately.

If the bug cannot be described without private data, say so in the report
and offer to share that part privately. Never paste it in.

## Step 5: Draft

Title names the failure, not the feeling: "sheet lift leaves ghost trails in
calm mode" beats "z layer broken".

```markdown
**What happened:** <observed>
**Expected:** <what should have happened>
**Where:** <route, key, or gesture, e.g. `/api/candidates`, press `z`, calm mode>
**Demo or own archive:** <demo | own archive>

**Repro:**
1. ...

**Error:**
```
<exact output, redacted>
```

**Notes:** <any signal that pointed the wrong way>

**Context:**
```
<gather_context.py output>
```
```

## Step 6: Ask once, with the body inside the question

Use `AskUserQuestion` with the full title and body verbatim in the question,
the destination on one line, and options **Send / Edit / Skip**. Be honest
that a public issue carries their GitHub handle. If they want no public
record, offer to send it to Melissa privately instead.

## Step 7: Post

```bash
gh issue create --repo spaciousmtness/zettel --title "<title>" --body-file <draft.md>
```

If `gh` cannot post (not logged in, no access), keep the draft, say where it
is, and offer the private route. Never discard it.

## Step 8: Fix it if you can

If the bug reproduces and the fix is clear, open a pull request with a test
that fails without it, and link it from the issue. Run all three suites
first, and say which failures were already on `main`:

```bash
node --test 'test/*.test.js'
python3 test/test_serve.py
python3 test/test_gather_context.py
(cd server && node --test 'test/*.test.js')
```

Respect the house laws in `HANDOFF.md`: content-blind by shape, absent not
inert, no shadows, the two-tap covenant, honest failure. A fix that breaks
one is a new bug.
