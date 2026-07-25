// A D1 and KV stand-in built on node:sqlite, so the auth flow can be walked
// end to end in `node --test` without a network, a Cloudflare account, or a
// running wrangler.
//
// This mirrors the SHAPE of the D1 client the Worker actually calls —
// prepare/bind/first/all/run/batch, and `.meta.changes` on a run — because
// the single-use and last-writer-wins logic in this codebase depends on
// `changes` being real. A stub that always reported success would let every
// race condition through the tests untouched, which is the opposite of the
// point.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

class Stmt {
  constructor(db, sql, args = []) {
    this.db = db; this.sql = sql; this.args = args;
  }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  #prepared() { return this.db.prepare(this.sql); }
  async first() {
    const rows = this.#prepared().all(...this.args);
    return rows.length ? rows[0] : null;
  }
  async all() { return { results: this.#prepared().all(...this.args) }; }
  async run() {
    const out = this.#prepared().run(...this.args);
    return { meta: { changes: out.changes, last_row_id: out.lastInsertRowid } };
  }
}

export function makeDb() {
  const db = new DatabaseSync(":memory:");
  // D1 enforces foreign keys unconditionally; SQLite does not, and the pragma
  // that would turn them on cannot live in schema.sql because D1's authorizer
  // rejects it. So it lives HERE — without it the harness would be laxer than
  // production and every ON DELETE CASCADE test would pass vacuously.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(join(here, "..", "schema.sql"), "utf8"));
  return {
    prepare: (sql) => new Stmt(db, sql),
    batch: async (statements) => {
      // D1's batch is atomic. Anything less would make the account+identity
      // insert in accounts.js able to leave a half-made account behind.
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    _raw: db,
  };
}

/** KV, minus the eventual consistency. Honours expirationTtl so the
 *  rate-limiter's cleanup path is exercised rather than assumed. */
export function makeKv() {
  const store = new Map();
  return {
    async get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expires && hit.expires < Date.now()) { store.delete(key); return null; }
      return hit.value;
    },
    async put(key, value, opts = {}) {
      store.set(key, {
        value: String(value),
        expires: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null,
      });
    },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

export function makeEnv(overrides = {}) {
  return {
    DB: makeDb(),
    RATE: makeKv(),
    ENVIRONMENT: "test",
    // Two DIFFERENT origins, as in production. Making them one string is what
    // let a magic link point at the static site and still pass its test.
    PUBLIC_ORIGIN: "https://api.zettel.test",   // this Worker
    APP_ORIGIN: "https://zettel.test",          // the front end
    ALLOWED_ORIGINS: "https://zettel.test",
    MAIL_FROM: "hello@zettel.test",
    ALLOW_CONSOLE_SECRETS: "1",   // the dev senders log instead of delivering
    ...overrides,
  };
}

export function post(path, body, headers = {}) {
  return new Request(`https://zettel.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export function get(path, headers = {}) {
  return new Request(`https://zettel.test${path}`, { method: "GET", headers });
}

/** The Set-Cookie value for one cookie name, as a browser would send it back.
 *
 *  Uses getSetCookie(), which returns the headers UNJOINED. The old version
 *  read a single header and split it on "," — and that is precisely how a
 *  response that comma-joined two Set-Cookie values looked correct here while
 *  a real browser parsed it as one cookie with a delete instruction stapled
 *  to the end. A harness that is more forgiving than a browser proves
 *  nothing; this is the one place that has to be stricter. */
export function cookieFrom(response, name) {
  const all = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("Set-Cookie")].filter(Boolean);
  const match = all.find((line) => String(line).startsWith(`${name}=`));
  if (!match) return null;
  const value = String(match).split(";")[0].slice(name.length + 1);
  return value || null;
}

/** Every Set-Cookie line, so a test can assert on how many there are. */
export function setCookies(response) {
  return typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("Set-Cookie")].filter(Boolean);
}

/** The dev senders log the secret rather than delivering it. Capturing that
 *  line is how a test learns the code without a mail provider — and it is
 *  also a standing check that the dev path never leaks in production, since
 *  deliver.js throws instead when ENVIRONMENT is production. */
export function captureConsole() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  return {
    lines,
    restore() { console.log = original; },
    lastSecret() {
      const line = lines[lines.length - 1] || "";
      const link = line.match(/[?&]t=([^&\s]+)/);
      if (link) return decodeURIComponent(link[1]);
      const code = line.match(/:\s*(\d{6})\s*$/);
      return code ? code[1] : null;
    },
  };
}
