-- Zettel · the boundary, written in DDL.
--
-- Read this file as the security policy. Everything a compliance review
-- will ask ("what do you store, and what could you be compelled to hand
-- over?") is answerable by reading it top to bottom, and the answer is
-- meant to be boring.
--
-- THE ONE RULE: there is no column anywhere in this schema for the content
-- of a message. Not empty, not nullable, not "we don't populate it" — it
-- does not exist. Message text lives in one place, the archive on the
-- owner's own machine, and it is opened read-only. A subpoena served on
-- this database returns account identifiers and opaque ciphertext.
--
-- What the Z layer actually needs from a server is smaller than it looks.
-- An annotation is anchored to a MOMENT (t0/t1) and a normalised height —
-- never to a document, never to a message id. That is what makes a mark
-- portable across surfaces, and it is also what makes this table safe:
-- (timeline, t0, t1) says "something was marked here" and nothing else.

PRAGMA foreign_keys = ON;

-- ---- identity -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account (
  id          TEXT PRIMARY KEY,          -- ULID-ish, generated server side
  created_at  INTEGER NOT NULL,          -- unix seconds
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'closed')),
  -- The surface salt. The client derives every timeline key by HMAC-ing a
  -- thread identifier with this, so the server is handed an opaque handle
  -- and never a phone number or an email address. Rotating it orphans the
  -- old keys by design — that IS the delete button.
  surface_salt TEXT NOT NULL
);

-- One account, many ways in. A person who signs up by phone on Monday and
-- by Google on Tuesday is ONE account, joined on the verified address.
CREATE TABLE IF NOT EXISTS identity (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'google', 'apple')),
  -- For email/phone this is the address itself: we need it in cleartext to
  -- deliver a code to it, and pretending otherwise would be theatre. For
  -- the OIDC kinds it is the provider's stable subject claim, which is
  -- already opaque. This is the most sensitive column in the file.
  value       TEXT NOT NULL,
  verified_at INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS identity_account ON identity(account_id);

-- ---- proving you are you --------------------------------------------------

-- Magic links and phone codes both land here. We store a HASH of the secret,
-- never the secret: a dump of this table cannot be replayed to log in as
-- anyone. `attempts` is what stops a six-digit code from being guessable.
CREATE TABLE IF NOT EXISTS challenge (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('email', 'phone')),
  value       TEXT NOT NULL,             -- who it was sent to
  secret_hash TEXT NOT NULL,             -- sha256(secret), hex
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER                    -- single use; set on success
);
CREATE INDEX IF NOT EXISTS challenge_lookup ON challenge(kind, value, expires_at);

-- Same discipline for sessions: the cookie holds the secret, we hold its
-- hash. `rotated_from` keeps a stolen-cookie audit trail without keeping
-- the cookie.
CREATE TABLE IF NOT EXISTS session (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER,
  rotated_from TEXT,
  user_agent   TEXT                      -- coarse, for "sign out other devices"
);
CREATE INDEX IF NOT EXISTS session_account ON session(account_id);

-- ---- the paired Mac -------------------------------------------------------

-- The web account and the machine that actually reads the archive are two
-- different things, joined by a short code the owner carries across by hand.
-- This row is how the Mac proves it belongs to an account. It never gives
-- the server a way to reach INTO the Mac — the arrow only points outward.
CREATE TABLE IF NOT EXISTS device (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  label       TEXT,                      -- "Melissa's MacBook", owner-supplied
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS device_account ON device(account_id);

CREATE TABLE IF NOT EXISTS pairing (
  code_hash   TEXT PRIMARY KEY,          -- sha256 of the short code
  account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,          -- minutes, not days
  claimed_at  INTEGER
);

-- ---- the Z layer ----------------------------------------------------------

-- The substrate. An annotation is (timeline, t0, t1, y) — a stretch of time
-- and a height on the sheet. That is the whole coordinate system, and it is
-- deliberately transport-agnostic: the same shape holds a mark over an
-- iMessage thread, a Slack channel, or a calendar year, because none of
-- those identities appear here.
--
-- `timeline` is HMAC(account.surface_salt, thread identifier), computed on
-- the client. The server cannot reverse it and never needs to.
--
-- `body_ct` is ciphertext. The reader's own words — the note, the ink, the
-- chapter name — are encrypted before they leave the machine, so the thing
-- that syncs between two of your devices is a blob with a timestamp on it.
-- There is, again, no column for the message being annotated.
CREATE TABLE IF NOT EXISTS annotation (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  timeline    TEXT NOT NULL,             -- opaque; see above
  kind        TEXT NOT NULL
                CHECK (kind IN ('ink', 'note', 'mark', 'chapter', 'reading')),
  t0          REAL NOT NULL,             -- unix seconds, the anchor
  t1          REAL NOT NULL,             -- == t0 for a point annotation
  y           REAL,                      -- 0..1 height on the sheet, ink only
  body_ct     BLOB,                      -- ciphertext, opaque to this server
  body_nonce  BLOB,
  -- last-writer-wins per (id), with the clock supplied by the client. Two
  -- devices editing the same mark is a merge the CLIENT resolves; the
  -- server only ever refuses a write that is older than what it holds.
  revision    INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER                    -- tombstone: sync needs to see removals
);
CREATE INDEX IF NOT EXISTS annotation_sync
  ON annotation(account_id, timeline, updated_at);

-- ---- the front door -------------------------------------------------------

CREATE TABLE IF NOT EXISTS access_request (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  phone       TEXT,
  source      TEXT,                      -- "landing", a campaign, a referrer
  created_at  INTEGER NOT NULL,
  invited_at  INTEGER
);

-- ---- evidence -------------------------------------------------------------

-- A SOC 2 auditor will ask for an access log. Writing it from day one costs
-- nothing and is impossible to reconstruct later. Deliberately coarse: WHO
-- and WHAT VERB, never what was in it.
CREATE TABLE IF NOT EXISTS audit (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  account_id  TEXT,                      -- null for pre-auth events
  action      TEXT NOT NULL,             -- 'signin.email', 'device.pair', ...
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'error')),
  meta        TEXT                       -- small JSON; never a body, never PII
);
CREATE INDEX IF NOT EXISTS audit_account_at ON audit(account_id, at);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
