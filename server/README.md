# Zettel · the server

Identity, device pairing, and Z-layer sync. **Never message content.**

Read [`schema.sql`](./schema.sql) first — it is the security policy, and it
is meant to be boring.

## The boundary

There is no column anywhere in this schema for the content of a message.
Not empty, not nullable, not "we don't populate it." It does not exist.
There is a test that fails if anyone adds one.

Message text lives in exactly one place: the archive on the owner's own
machine, opened read-only. What syncs is the **Z layer** — the marks, the
ink, the chapters — and an annotation is stored as:

| column | what it is |
|---|---|
| `timeline` | opaque 64-hex handle. `HMAC(surface_salt, thread id)`, computed **on the client**. We can group by it; we cannot reverse it. |
| `t0`, `t1`, `y` | the coordinate — a stretch of time and a height on the sheet |
| `body_ct` | ciphertext. The reader's own words, sealed before they leave the device. |

So the strongest statement anyone can make from this database is *"this
account marked something in this opaque bucket at this moment."* That is
the whole point. It is what makes the sync safe to run somewhere that would
never permit the alternative, and it is why the compliance story is an
architecture rather than a policy PDF.

Rotating an account's `surface_salt` orphans every handle at once. That is
the delete button.

## Running it

```sh
npm install
npm test                 # 59 tests, no network, no Cloudflare account

wrangler d1 create zettel        # paste the id into wrangler.toml
wrangler kv namespace create RATE
npm run db:local
npm run dev
```

With no mail or SMS provider configured, `ENVIRONMENT != production` logs
the magic link and the OTP to the console so the flow can be walked end to
end. In production the same path **throws** — a sign-in that silently
succeeds while nothing was delivered is indistinguishable, to the person
locked out, from one that worked.

## Secrets

Never in `wrangler.toml`. `wrangler secret put NAME` for each:

```
RESEND_API_KEY                          email
TWILIO_ACCOUNT_SID / _AUTH_TOKEN / _FROM   sms
GOOGLE_CLIENT_ID / _CLIENT_SECRET       omit both → the button never renders
APPLE_CLIENT_ID / _TEAM_ID / _KEY_ID / _PRIVATE_KEY
```

Providers are advertised by `GET /health`. The landing page draws only what
the server says it can actually complete — *absent, not inert*.

## Routes

| | | |
|---|---|---|
| `POST` | `/access` | the waiting list |
| `POST` | `/auth/email/start` | send a magic link |
| `GET` | `/auth/email/callback` | the click → session |
| `POST` | `/auth/phone/start` | send a six-digit code |
| `POST` | `/auth/phone/verify` | code → session |
| `GET` | `/auth/{google,apple}/start` | OIDC, PKCE |
| `GET\|POST` | `/auth/{google,apple}/callback` | Apple form-posts; Google doesn't |
| `POST` | `/auth/signout` | revoke this session |
| `GET` | `/me` | who am I — **and everything we hold** |
| `POST` | `/me/pair` | mint a pairing code for the Mac |
| `DELETE` | `/me` | close the account, cascade the data |
| `POST` | `/pair/claim` | the Mac trades a code for a device token |
| `GET\|POST` | `/sync` | pull / push annotations |
| `DELETE` | `/sync/timeline/{handle}` | forget one conversation |

`GET /me` doubles as the data-subject-access response. If it cannot show a
thing, we should not be holding that thing — that is the test to run
against `lib/accounts.js` whenever the schema changes.

## Decisions worth knowing about

**Secrets are stored as SHA-256, never in the clear.** A dump of this
database is not a set of working credentials. Comparison is constant-time
throughout; `===` leaks the matching prefix length.

**Single use is enforced by `UPDATE … WHERE consumed_at IS NULL` and a
check on `changes`,** not by a `SELECT` then a decision in JS. Two requests
racing the same valid code both read it as unspent; only one gets
`changes === 1`.

**Sign-in answers identically for a known and an unknown address.** "No
account with that email" is a free enumeration oracle that turns someone
else's breach dump into a list of confirmed Zettel users. The cost is that
a typo'd address looks like a success, which is why the copy says *"if we
can reach that"* rather than *"sent"*.

**OIDC identities key on the provider's `sub`, never the email.** Keying on
email is a takeover: anyone who can make a provider assert an address you
already use walks into your account. A verified email is linked as a
separate identity, and only when no other account holds it.

**Two secrets in the OIDC flow, doing two jobs.** `state` binds the
callback to this browser (login CSRF); `nonce` binds the id_token to this
request (replay). A flow with only one is broken in a way that is hard to
see. Apple's `response_mode=form_post` is why its state cookie is
`SameSite=None` — a `Lax` cookie is not sent on a cross-site POST.

**The id_token's signature is not verified, on purpose.** It is fetched
server-to-server over TLS from a pinned issuer host, which is the one
condition under which that is sound. `iss`, `aud`, `exp` and `nonce` still
are. **If the flow ever changes so an id_token reaches the browser, JWKS
verification becomes mandatory** — that note lives at the top of
`routes/oidc.js` and is the thing to re-read before touching it.

**Rate limiting fails open.** A KV outage must not take authentication
down. It is a floor against cheap loud attacks (burning your SMS budget,
enumeration at volume), not the control standing between an attacker and an
account — that is the per-challenge attempt counter in SQL, which is exact
and transactional.

**The audit table is coarse on purpose.** Who, what verb, what outcome.
Never a body, never an address. Writing it from day one costs nothing and
cannot be reconstructed later.

## Not done yet

- Client-side sealing of `body_ct`. The column and the contract exist; the
  key derivation and the client half do not. Until then, treat the body as
  plaintext-shaped and do not promise otherwise on the landing page.
- Device tokens are minted but no route consumes them yet — the Mac can
  pair, but cannot sync as a device.
- Session rotation on privilege change (`rotated_from` is in the schema,
  unused).
- No pen test. Nothing here has been looked at by anyone but its author.
