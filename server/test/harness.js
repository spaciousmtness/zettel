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
    PUBLIC_ORIGIN: "https://zettel.test",
    ALLOWED_ORIGINS: "https://zettel.test",
    MAIL_FROM: "hello@zettel.test",
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

/** The Set-Cookie value for one cookie name, as a browser would send it back. */
export function cookieFrom(response, name) {
  const raw = response.headers.get("Set-Cookie") || "";
  const match = raw.split(",").map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`));
  if (!match) return null;
  const value = match.split(";")[0].slice(name.length + 1);
  return value || null;
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
