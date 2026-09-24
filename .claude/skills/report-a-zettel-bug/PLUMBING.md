# Bug-report plumbing: how to build it for any project, and why

For an agent adding a "report a bug" path to a project it maintains. The
worked example is this folder (`report-a-zettel-bug`), which was modeled on
Freedom's `suggest-an-improvement`. Read this before building one; copy the
shape, not the Zettel specifics.

## Why build it at all

**The person who can see a bug is almost never the person who wrote the
code.** The maintainer's machine is configured, current, and full of their
own data, so the failure does not reproduce there. The user who hits it has
the evidence and no path to hand it over: they do not know the repo, the
maintainer, or what information matters. So the bug is worked around in
silence and hit again by the next person.

A reporting path fixes the handoff at the one moment it is cheap: when the
bug has just happened and the context is loaded. Three things follow:

1. **Reports arrive with enough context to reproduce.** A thin report ("it's
   broken") cannot be fixed; the plumbing gathers versions and state
   automatically, so the reporter never has to research their own machine.
2. **Private data never leaks by accident.** The reporter is under stress
   and not reading carefully. Safety has to be structural, not a reminder.
3. **Fixes compound.** Every report that turns into a fix with a test is a
   bug nobody hits again. Without the plumbing, each bug is paid for once
   per person who hits it.

Evidence this works: on 2026-09-20 Freedom's version of this took a setup
failure from "noticed" to a filed issue (ContinentalWorks/freedom#203) and a
text to the maintainer in a few minutes, with the reporter reading and
approving every word.

## The pieces

Build all six. Each one exists because its absence caused a real failure.

### 1. A skill file that triggers on plain words

`SKILL.md` with a `description` listing what a stuck person actually says:
"report this", "file a bug", "this is broken", "tell <maintainer>". Nobody
types the skill's name when something breaks.

### 2. A context gatherer that is an ALLOW-LIST

A script (`scripts/gather_context.py` here) that prints exactly what will be
attached. Rules:

- **Allow-list, never a redactor.** Collect only versions, yes/no values, and
  counts. A redactor has to anticipate every leak; an allow-list cannot leak
  what it never reads.
- **Watch your own endpoints.** Zettel's `/api/health` returns contact
  nicknames alongside the status. The gatherer keeps two fields and drops
  the rest. Check what every source you touch actually returns.
- **No absolute paths.** `/Users/<name>/` names the person.
- **Print the exclusions too.** "Never collected: ..." lets the reporter
  check the promise instead of trusting it.
- **Show the output to the reporter before anything is filed.** Not a
  summary: the literal block.

### 3. A test that fails if private data ever gets in

`test/test_gather_context.py` feeds the gatherer a fake health reply full of
names, a phone number, and a token, and asserts none of them appear. Wire it
into CI. The allow-list is only as good as the day someone adds a field; the
test is what keeps it true after that day.

### 4. A security fork that never goes public

Decide what counts as a vulnerability (point at the project's `SECURITY.md`)
and route those to a private channel (GitHub private vulnerability
reporting). A public issue about a hole is a published exploit. List the
known-and-deliberate limitations so they are not re-reported as new.

### 5. An approval gate with the body inside the question

Never file silently: the issue goes out under the reporter's name. Show the
full title and body **inside** the approval question (a long chat reply can
be collapsed; a question cannot), with Send / Edit / Skip. Be honest that a
GitHub issue carries their handle, and offer a private route instead.

### 6. A duplicate check and a "fix it if you can" step

Search existing issues first; a second sighting goes on the existing thread.
Then, if the bug reproduces and the fix is clear, the agent opens a pull
request with a regression test, runs every suite, and names any failure that
was already on `main`. A report hands the maintainer a job; a PR hands them
a decision.

## Project-specific judgment to add

- **What does a screenshot show?** For Zettel, any screenshot of the real app
  is someone's messages, so screenshots come only from the synthetic demo or
  fully cropped. Ask this question for every project that renders user data.
- **What are the house laws?** Link them (Zettel: `HANDOFF.md`), so a fix
  that violates one is caught as a new bug.
- **Where do reports go?** The repo, the private channel, and whether the
  maintainer wants a text for urgent bugs.

## Build order

1. Read the project's security doc and every endpoint or file the gatherer
   might touch. Note what each returns.
2. Write the gatherer and its leak test together; run both.
3. Write `SKILL.md`: trigger words, security fork, duplicate check, redaction
   list, draft template, approval gate, post command, fix step.
4. Add the test to CI.
5. Run the gatherer on a real machine and read its output as a stranger
   would.
6. Commit with a message that says what it protects, not what files changed.

## Anti-patterns

- A redactor that scrubs a full dump. It misses the field nobody thought of.
- "Paste your logs here." Logs carry names, paths, and tokens.
- Filing on the reporter's behalf without showing them the exact body.
- Calling a GitHub issue anonymous. It is not.
- A report template with no context block, so every report starts a round
  trip of "what version are you on?"
