import { newId } from "../lib/crypto.js";
import { json, fail, readJson } from "../lib/respond.js";
import { normalizeTimeline, normalizeAnchor, ANNOTATION_KINDS }
  from "../lib/validate.js";
import { currentAccount } from "../lib/session.js";

// The Z layer, synced.
//
// This is the only route that touches a person's marks, and it is worth
// being precise about what it can and cannot see. An annotation arrives as:
//
//   timeline  — an opaque 64-hex handle the CLIENT derived by HMAC-ing a
//               thread identifier with the account's surface salt. We can
//               group by it. We cannot reverse it.
//   t0/t1/y   — the coordinate. A stretch of time and a height on a sheet.
//   body_ct   — ciphertext. The reader's own words, sealed on their device.
//
// So the strongest statement anyone can make from this table is "this
// account marked something in this opaque bucket at this moment." That is
// the whole point, and it is why message content has no column: not because
// we forgot, but because the shape of the sync is what makes the product
// deployable somewhere that would never allow the alternative.

const MAX_BATCH = 500;
const MAX_BODY = 32 * 1024;     // one ink stroke set; generous, still bounded

/** GET /sync?timeline=&since= — everything changed since a watermark.
 *
 *  Tombstones are included deliberately: a device that has been asleep must
 *  learn about deletions, and a sync that only sends creations resurrects
 *  every mark the owner ever removed. */
export async function pull(request, env) {
  const who = await currentAccount(env, request);
  if (!who) return fail(401, "signed_out", "sign in first");

  const url = new URL(request.url);
  const timeline = normalizeTimeline(url.searchParams.get("timeline"));
  const since = Number(url.searchParams.get("since")) || 0;
  // The other half of the watermark. `updated_at` is whole seconds and push()
  // stamps an entire batch with one `now`, so hundreds of rows routinely share
  // a second — and a cursor of `updated_at` alone asks the next page for
  // `> T`, silently skipping every remaining row AT T. One legal 500-row push
  // was enough to make 300 marks permanently invisible to a second device,
  // with no error anywhere. The sort key is (updated_at, id); the cursor has
  // to be the same pair or it is not a cursor.
  const sinceId = String(url.searchParams.get("since_id") ?? "");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1),
                         MAX_BATCH);

  const bound = [who.account_id, since, since, sinceId];
  let sql =
    `SELECT id, timeline, kind, t0, t1, y, body_ct, body_nonce,
            revision, updated_at, deleted_at
       FROM annotation
      WHERE account_id = ?
        AND (updated_at > ? OR (updated_at = ? AND id > ?))`;
  if (timeline) { sql += ` AND timeline = ?`; bound.push(timeline); }
  sql += ` ORDER BY updated_at, id LIMIT ?`;
  bound.push(limit);

  const rows = await env.DB.prepare(sql).bind(...bound).all();
  const items = rows.results || [];
  const last = items[items.length - 1];
  return json({
    items,
    // null when the page was not full — the client stops rather than
    // spinning on a watermark that never advances
    cursor: items.length === limit && last
      ? { since: last.updated_at, since_id: last.id }
      : null,
  });
}

/** POST /sync — { items: [...] }
 *
 *  Last-writer-wins on `revision`, which the CLIENT owns. Two devices that
 *  edit the same mark converge because the server refuses anything it
 *  already has a newer copy of; it never merges, because merging two
 *  people's readings is exactly the thing this product refuses to do
 *  anywhere else and there is no reason to start here. */
export async function push(request, env) {
  const who = await currentAccount(env, request);
  if (!who) return fail(401, "signed_out", "sign in first");

  const body = await readJson(request, 1024 * 1024);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items) return fail(400, "bad_body", "expected { items: [...] }");
  if (items.length > MAX_BATCH) {
    return fail(413, "too_many", `send at most ${MAX_BATCH} at a time`);
  }

  const now = Math.floor(Date.now() / 1000);
  const statements = [];
  const rejected = [];

  for (const [index, item] of items.entries()) {
    const timeline = normalizeTimeline(item?.timeline);
    if (!timeline) { rejected.push({ index, why: "timeline" }); continue; }
    const kind = String(item?.kind ?? "");
    if (!ANNOTATION_KINDS.has(kind)) { rejected.push({ index, why: "kind" }); continue; }
    const anchor = normalizeAnchor(item);
    if (!anchor) { rejected.push({ index, why: "anchor" }); continue; }

    const ct = item?.body_ct ?? null;
    if (ct !== null && String(ct).length > MAX_BODY) {
      rejected.push({ index, why: "too_big" });
      continue;
    }
    const revision = Number(item?.revision) || 1;
    const id = typeof item?.id === "string" && item.id.length <= 64
      ? item.id : newId();

    // account_id is bound from the SESSION, never from the payload. A body
    // that carries its own account_id is ignored — that is the whole of the
    // authorisation check on this route, and it is why it is one line.
    statements.push(env.DB.prepare(
      `INSERT INTO annotation
         (id, account_id, timeline, kind, t0, t1, y,
          body_ct, body_nonce, revision, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, t0 = excluded.t0, t1 = excluded.t1,
         y = excluded.y, body_ct = excluded.body_ct,
         body_nonce = excluded.body_nonce, revision = excluded.revision,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
       WHERE annotation.account_id = excluded.account_id
         AND excluded.revision > annotation.revision`)
      .bind(id, who.account_id, timeline, kind, anchor.t0, anchor.t1, anchor.y,
            ct, item?.body_nonce ?? null, revision, now,
            item?.deleted ? now : null));
  }

  if (statements.length) await env.DB.batch(statements);
  return json({ ok: true, accepted: statements.length, rejected, at: now });
}

/** DELETE /sync/timeline/:handle — forget one conversation's marks.
 *
 *  Tombstoned rather than dropped, so other devices learn about it. The
 *  hard delete is account-level (see routes/me.js), where rotating the
 *  surface salt orphans every handle at once. */
export async function forgetTimeline(request, env, handle) {
  const who = await currentAccount(env, request);
  if (!who) return fail(401, "signed_out", "sign in first");
  const timeline = normalizeTimeline(handle);
  if (!timeline) return fail(400, "bad_timeline", "not a timeline handle");

  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `UPDATE annotation
        SET deleted_at = ?, body_ct = NULL, body_nonce = NULL,
            revision = revision + 1, updated_at = ?
      WHERE account_id = ? AND timeline = ? AND deleted_at IS NULL`)
    .bind(now, now, who.account_id, timeline).run();
  return json({ ok: true, forgotten: result.meta?.changes ?? 0 });
}
