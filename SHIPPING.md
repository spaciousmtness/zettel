# Shipping Zettel

What has to be true before other people use this. Ordered by what blocks,
not by what's interesting.

## "Share it" is three different verbs

|   | what they get | friction | what it proves |
|---|---|---|---|
| **Send the demo link** | synthetic archive, any device | none, ~5 seconds | that the idea reads |
| **They run it on their archive** | their own 200k messages | Mac + Terminal + Full Disk Access | **the only thing that matters** |
| **They share marks with each other** | the Z layer between people | not built | the long bet |

Row 1 is live now: <https://spaciousmtness.github.io/zettel/>. Send it to
anyone today; nothing below blocks it.

Row 2 is the one that answers the question in `HANDOFF.md` — *does a mark
made over one record get used against another?* Everything below is scoped
to row 2. Row 3 isn't a shipping question yet, it's a product one.

---

## Blockers — don't send row 2 to a stranger without these

- [x] **DNS rebinding.** Any website you visited could read the whole
      archive through your own browser. Closed 2026-08-01 (Host allowlist,
      9 tests).
- [x] **Attachment XSS.** A texted `.html` ran inside the app's origin and
      could read everything through the API. Closed 2026-08-01.
- [x] **Static path traversal** to a sibling folder. Closed 2026-08-01.
- [ ] **LICENSE — there isn't one.** A public repo with no license is "all
      rights reserved": strictly, nobody may legally run or copy it. This is
      a founder decision, not a formality, because it's hard to reverse:
      - **Apache-2.0** — permissive like MIT but with an explicit patent
        grant. The default if you want adoption and to keep raising
        optionality open. *Recommended.*
      - **AGPL-3.0** — anyone who runs a modified version as a service must
        publish their changes. Protects against a large company shipping
        your primitive. Scares some enterprises off.
      - **Business Source License** — source-available, converts to open
        after N years, blocks commercial hosting meanwhile.
      - **No license at all** — legitimate if you want to show the code but
        grant nothing. But then say so, because silence reads as an
        oversight.
- [ ] **SECURITY.md with a real address.** I found three holes today. The
      fourth will be found by someone who isn't me, and right now they have
      nowhere to send it — so it goes public instead.
- [ ] **Uninstall and export.** Their marks live in
      `~/Library/Application Support/Zettel/`, autostart in
      `~/Library/LaunchAgents/`, logs in `~/Library/Logs/Zettel/`. Nothing
      in the product tells them that, and there's no one-button "give me my
      marks as a file." A product about not accumulating baggage should be
      unusually good at being deleted.
- [ ] **Second-party consent.** Their archive contains other people's
      messages. Those people never agreed to be read by new software. This
      isn't a legal blocker for a local-only tool, but it becomes one the
      moment anything syncs, and it's a fair question a thoughtful user will
      ask on first run. Decide what the app says about it.
- [ ] **Update path.** If you ship a fix, how do the ten people get it? Right
      now: `git pull`, which they won't. At minimum, a version string in the
      UI and a line in the README.
- [ ] **A way to hear back.** No telemetry, by design — so you learn nothing
      unless you build the human path. An email, a form, a "copy
      diagnostics" button.

---

## Security — what's left after today

- [ ] **Sidecar permissions.** Confirm the store directory is `0700`. Their
      marks and voice notes are as sensitive as the archive.
- [ ] **Crash logs.** `log_message` is suppressed, so no request logging —
      good. But an unhandled traceback in `server.log` can carry message
      text. Scrub or confirm.
- [ ] **Port squatting.** Another local process can bind 8477 first and
      impersonate Zettel. Hard to solve properly on localhost; worth knowing
      about, probably not worth fixing at ten users.
- [ ] **`server/` (the Cloudflare Worker) is not live and shouldn't be** until
      row 3 is a real product. When it is: secrets in Wrangler not source,
      D1 backups, rate limits verified, and a privacy policy that matches
      `schema.sql`.
- [x] **Dependency posture.** One dependency in the whole project
      (`wrangler`, dev-only). This is a genuine security asset — most of what
      goes wrong in shipped software arrives through the supply chain. Protect
      it; every `npm install` is a decision.

---

## Hosting

- [x] Landing page + demo on GitHub Pages. Free, fast, adequate.
- [ ] **zettel.ink** still isn't pointed anywhere (Porkbun login). A records
      for GitHub Pages are `185.199.108.153`, `.109.153`, `.110.153`,
      `.111.153`, plus a `CNAME` file in the repo. **This is cosmetic — do
      not let it block sending the link.** `spaciousmtness.github.io/zettel`
      works today.
- [ ] If you ever want the app reachable *without* someone cloning a repo,
      that's a signed `.app`: Apple Developer account ($99/yr), `codesign`,
      and notarization — otherwise Gatekeeper says "unidentified developer"
      and most people stop. Only worth it past ~20 users.

---

## Compliance — the honest answer

You asked about SOC 2, HIPAA and ISO 27001 before. Straight version:

- **SOC 2 Type II** certifies that you do what you say you do. It needs a
  legal entity, written policies, 3–12 months of collected evidence, and an
  auditor — realistically $20–60k with a tool like Vanta or Drata. It is an
  **enterprise sales unlock, not a security property.** At ten users it buys
  nothing.
- **HIPAA** applies if you're a Business Associate handling protected health
  information for a covered entity. Texts about your own health are not PHI.
  **Not applicable.**
- **ISO 27001** is the international analogue of SOC 2. Same shape, same
  prematurity.
- **GDPR / CCPA** are the ones that actually bite sooner — the moment content
  touches a server you run and one user is in the EU, you're a data
  controller with deletion and portability duties. **Today content never
  leaves the device, which is the strongest position available.** Every
  decision that keeps it there is worth more than a certificate.

What a technical evaluator will actually check, in order: does it phone
home, what does the server store, who can reach it, and is there a
disclosure path. Three of those four are now good. The fourth is
`SECURITY.md`.

---

## Things you didn't ask about

- **The name.** Check "Zettel" on USPTO TESS and the App Store before it's on
  anything. *Zettelkasten* is generic; *Zettel* alone may not be.
- **You cannot reach your users.** No telemetry means no way to push "stop
  using v1, it leaks." If you'd found today's rebinding bug after shipping to
  ten people, you'd have had no channel. Either keep a list of who has it, or
  build a version check — but decide deliberately, don't drift.
- **Accessibility.** The strata are glyphs — `?` `—` `◇` `◆` `≈` `◉`. To a
  screen reader those are punctuation. They need labels. The no-shadow,
  survives-grayscale rule already puts you ahead on contrast; finish the job
  with keyboard order and focus rings.
- **First run when it isn't a Mac**, or the archive is empty, or it's 400
  messages instead of 276,765. All three will happen in the first ten people.
- **Full Disk Access is your funnel.** Six manual steps in System Settings,
  and macOS never prompts for it — the user has to go find it. Most
  abandonment will happen here, before anyone sees the product. The in-app
  consent card is therefore not a detail; it's the most important screen you
  have.
- **Speed on a real archive is the demo.** 276,765 messages. Measure first
  paint and search latency and treat regressions as bugs.
- **Name the ten people.** Not a technical item, and the one most likely to
  slip. Who, specifically, and what do you want to watch them do?
