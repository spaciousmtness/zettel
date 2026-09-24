# Reporting a vulnerability

Zettel reads a person's entire message archive. A bug here is not an
inconvenience — it is someone's private life. Reports are welcome and will be
answered.

**Please report privately first.** Use GitHub's private vulnerability
reporting on this repository (Security → Report a vulnerability). It opens a
channel visible only to the maintainer, and it works without either of us
publishing an email address.

Expect a first reply within 72 hours. If a fix is warranted, the report gets
credit in the commit unless you'd rather it didn't.

## What is in scope

The local archive server (`serve.py`) is the sensitive surface. It binds
`127.0.0.1` and reads `~/Library/Messages/chat.db` read-only. Anything that
lets code the user did not run reach that server, or lets data from that
server reach anywhere else, is in scope. So is anything that makes a claim on
`/security.html` untrue.

The `server/` directory is a Cloudflare Worker for syncing *annotations* — it
has no column for message content, and a test fails if one appears. It is not
deployed. Reports against it are still welcome.

## Known and deliberate

- **The archive is readable by anything running as you on your Mac.** macOS
  Full Disk Access is granted to a binary, not to Zettel specifically. This is
  a property of the platform, not a bug we can fix.
- **Marks and voice notes are stored unencrypted** in
  `~/Library/Application Support/Zettel/` (mode `0700`). Encrypting them at
  rest requires a key-derivation decision that hasn't been made; until it is,
  we don't claim encryption. `/security.html` says so in the same size type.
- **Another local process can bind port 8477 before Zettel does** and
  impersonate it. Defending this properly on loopback is unsolved; we'd rather
  name it than pretend.

## Already fixed

- **DNS rebinding → full archive read** (2026-08-01). Any web page you
  visited could point its own hostname at your loopback and read every
  message same-origin, plus lift the CSRF token from `/api/health` and gain
  writes. Fixed by allowlisting the `Host` header.
- **Stored XSS via attachment MIME type** (2026-08-01). A `.html` file
  someone texted you was served under `text/html` from the app's own origin,
  so its script could read the archive through the API. Non-renderable types
  now leave as downloads.
- **Path traversal to a sibling directory** (2026-08-01). The static handler
  compared paths by string prefix, so `../app-private/` passed.

## What we ask in return

Please don't test against anyone's archive but your own, and don't publish a
working exploit before there's a fix people can get.
