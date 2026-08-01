#!/usr/bin/env python3
"""Zettel — the local archive server.

WHAT THIS IS. The client in app/ speaks to /api/. On GitHub Pages a shim
answers from synthetic snapshots; on your own Mac, THIS answers from your
real iMessage archive. Same files, both grounds — app/demo.js probes
/api/health once and passes everything through when a real server answers.

HONESTY ABOUT ORIGINS. The original Wavelength server (the hackathon one,
with sending, summons, handwriting OCR and the shared-folder co-layer)
never made it into this repository — it lives only in the original project
folder. This file is a CLEAN-ROOM REBUILD of its read side, written from
the API contract the demo shim documents exhaustively. If you find the old
folder, keep it: it is the ancestor. Until then, this is the safety net,
and the repo finally carries its own server.

WHAT IT DOES NOT DO, ON PURPOSE, SAID PLAINLY:
  - It never writes the archive. One sqlite connection, mode=ro, ever.
  - It never sends a message (/api/say, /api/pinback answer 501 honestly).
  - It never calls a model (/api/summon, /api/scribe, /api/transcribe: 501).
  - It never leaves this machine. It binds 127.0.0.1 and nothing else.
Your marks, chapters, notes and ink live in a sidecar JSON under
~/Library/Application Support/Zettel/ — never inside chat.db.

Runs on a stock Mac: python3, no pip, no dependencies. HEIC thumbnails and
voice-memo transcodes shell out to sips/afconvert, which ship with macOS.
"""

import json
import mimetypes
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
import unicodedata

import contacts as contacts_mod
import typedstream as ts_mod
from datetime import datetime, date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

HERE = Path(__file__).resolve().parent
APP = HERE / "app"
PORT = int(os.environ.get("ZETTEL_PORT", "8477"))  # 8787 belongs to wrangler
DB_PATH = Path(os.environ.get(
    "ZETTEL_DB", Path.home() / "Library" / "Messages" / "chat.db"))
STORE_DIR = Path.home() / "Library" / "Application Support" / "Zettel"
CACHE_DIR = Path.home() / "Library" / "Caches" / "Zettel"
APPLE_EPOCH = 978307200          # 2001-01-01 in unix seconds
PAGE_MAX = 300

# the mark dialect — must match shared.js MARK_DIALECT by hand
MARKS = ["\U0001F4CC", "\U0001F525", "❓", "\U0001FA77", "✅", "\U0001F44D"]

CSRF = secrets.token_urlsafe(24)

# ---- time -------------------------------------------------------------------
# Dates are nanoseconds since 2001-01-01 — except ancient rows, which are
# SECONDS since 2001 (pre-High Sierra). Raw ordering still works, because a
# seconds-scale value is always smaller than a nanoseconds-scale one and the
# seconds rows really are older; only the unix conversion has to care.

def apple_to_unix(value):
    v = float(value or 0)
    if v > 1e12:
        v /= 1e9
    return v + APPLE_EPOCH

def unix_to_apple_ns(ts):
    return int(round((float(ts) - APPLE_EPOCH) * 1e9))

def humanize(seconds):
    """A span in the words the interface speaks. Mirrors the demo's register:
    '14 hours', 'a day', '3 days', '2 weeks', '7 months', '1.5 years'."""
    s = float(seconds)
    h = round(s / 3600)
    if s < 79200:
        return f"{max(1, h)} hour{'s' if h != 1 else ''}"
    if s < 151200:
        return "a day"
    d = round(s / 86400)
    if d < 7:
        return f"{d} days"
    if d < 25:
        w = round(d / 7)
        return "a week" if w == 1 else f"{w} weeks"
    mo = round(d / 30.44)
    if mo < 12:
        return "a month" if mo == 1 else f"{mo} months"
    y = round(s / (365.25 * 86400) * 10) / 10
    return f"{int(y)} year{'s' if y != 1 else ''}" if y == int(y) else f"{y} years"

# ---- typedstream ------------------------------------------------------------
# Modern macOS keeps message text in `attributedBody`, an NSKeyedArchiver-era
# typedstream blob, and leaves `message.text` NULL. The full format is
# baroque; the useful part is one NSString whose bytes follow a '+' marker
# and a length. This is a heuristic decoder — the README calls this exact
# problem out as one of the hard parts, and the original's decoder is in the
# folder that never reached the repo. It handles the common encodings and
# returns None rather than garbage when it doesn't understand.

def typedstream_text(blob):
    """The recovered original decoder (typedstream.py), plus the one house
    nicety: U+FFFC attachment placeholders strip, and an attachment-only
    message reads as no text so the client renders its media instead."""
    text = ts_mod.extract(blob)
    if not text:
        return None
    text = text.replace("\ufffc", "").strip()
    return text or None


# ---- the archive ------------------------------------------------------------
# Exactly one connection, mode=ro, guarded by one lock. The vow on the
# landing page is "the archive is read-only", and the honest implementation
# of a vow is the absence of any code path that could break it.

class Archive:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(
            f"file:{self.path}?mode=ro", uri=True, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        with self.lock:
            self.db.execute("PRAGMA query_only = ON")
            self.handles = {r["ROWID"]: r["id"] for r in
                            self.db.execute("SELECT ROWID, id FROM handle")}
        self._threads = None

    def q(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    # -- threads: one person is many chat rows ------------------------------
    # iMessage/SMS split plus spelling variants of one number. The merge key
    # preserves country codes: a bare US number and its +1 spelling fold
    # together, but +91xxxxxxxxxx never collides with an unrelated +1 number
    # that happens to share its last ten digits — the exact bug the README
    # warns about.

    @staticmethod
    def thread_key(identifier):
        ident = str(identifier or "")
        digits = re.sub(r"\D", "", ident)
        if not digits or not re.fullmatch(r"\+?[\d\s\-().]+", ident):
            return ident.lower()          # email addresses, group chat ids
        if len(digits) == 10:
            return digits                 # bare national (US) form
        if len(digits) == 11 and digits.startswith("1"):
            return digits[1:]             # +1 spelling of the same number
        return digits                     # any other country code, intact

    def threads(self):
        if self._threads is not None:
            return self._threads
        rows = self.q("""
            SELECT c.ROWID AS chat_id, c.chat_identifier, c.display_name,
                   c.style, COUNT(m.message_id) AS n
              FROM chat c
              LEFT JOIN chat_message_join m ON m.chat_id = c.ROWID
             GROUP BY c.ROWID""")
        merged = {}
        for r in rows:
            key = self.thread_key(r["chat_identifier"])
            t = merged.setdefault(key, {
                "key": key, "identifier": r["chat_identifier"],
                "display_name": r["display_name"] or None,
                "style": r["style"], "count": 0, "chat_ids": [], "_best": -1,
            })
            t["count"] += r["n"] or 0
            t["chat_ids"].append(r["chat_id"])
            if (r["n"] or 0) > t["_best"]:      # the busiest spelling fronts
                t["_best"] = r["n"] or 0
                t["identifier"] = r["chat_identifier"]
                t["style"] = r["style"]
                if r["display_name"]:
                    t["display_name"] = r["display_name"]
        out = sorted(merged.values(), key=lambda t: -t["count"])
        for t in out:
            t.pop("_best", None)
        self._threads = out
        return out

    def chat_ids(self, identifier):
        key = self.thread_key(identifier)
        for t in self.threads():
            if t["key"] == key:
                return t["chat_ids"], t
        return [], None

# ---- the sidecar ------------------------------------------------------------
# Your marks-about-the-archive, never inside it. Atomic writes: a crashed
# save must never leave half a store where all your chapters were.

class Store:
    def __init__(self, directory):
        self.path = Path(directory) / "store.json"
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.data = json.loads(self.path.read_text())
        except Exception:
            self.data = {}
        for k in ("notes", "chapters", "states", "inks", "voices"):
            self.data.setdefault(k, {})

    def bucket(self, kind, key):
        return self.data[kind].setdefault(
            key, [] if kind in ("notes", "chapters", "voices") else {})

    def save(self):
        with self.lock:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1))
            tmp.replace(self.path)

# ---- message plumbing -------------------------------------------------------

BASE_COLS = """m.ROWID AS rowid, m.guid, m.text, m.attributedBody,
               m.handle_id, m.is_from_me, m.date, m.service,
               m.cache_has_attachments"""
NOT_TAPBACK = "(m.associated_message_type IS NULL OR m.associated_message_type = 0)"

def message_text(row):
    return row["text"] or typedstream_text(row["attributedBody"])

class Api:
    def __init__(self, archive, store, config):
        self.a = archive
        self.s = store
        self.config = config
        # names from macOS Contacts, keyed by the RAW identifiers the client
        # shows; explicit config aliases win over Contacts on collision
        self.aliases = {}
        try:
            book = contacts_mod.load_map()
            idents = {t["identifier"] for t in archive.threads()}
            idents.update(v for v in archive.handles.values() if v)
            for ident in idents:
                name = book.get(contacts_mod.handle_key(ident))
                if name:
                    self.aliases[ident] = name
        except Exception:
            pass                     # no Contacts access: raw handles, as before
        self.aliases.update(config.get("aliases", {}))

    # -- paging: mirrors the demo shim's pageOlder/pageNewer exactly, which
    #    mirrors the original db.py. Composite (date, ROWID) row-value
    #    cursors, never OFFSET — restores and edits break ROWID≈date.

    def _page(self, cids, direction, cursor, limit, inclusive=False):
        cs = ",".join("?" * len(cids))
        args = list(cids)
        where = f"cm.chat_id IN ({cs}) AND {NOT_TAPBACK}"
        if direction == "older":
            if cursor:
                op = "<=" if inclusive else "<"
                where += f" AND (m.date < ? OR (m.date = ? AND m.ROWID {op} ?))"
                args += [cursor[0], cursor[0], cursor[1]]
            order = "m.date DESC, m.ROWID DESC"
        else:
            if cursor:
                op = ">=" if inclusive else ">"
                where += f" AND (m.date > ? OR (m.date = ? AND m.ROWID {op} ?))"
                args += [cursor[0], cursor[0], cursor[1]]
            order = "m.date ASC, m.ROWID ASC"
        rows = self.a.q(f"""
            SELECT {BASE_COLS} FROM message m
              JOIN chat_message_join cm ON cm.message_id = m.ROWID
             WHERE {where} ORDER BY {order} LIMIT ?""", args + [limit])
        rows = list(rows)
        if direction == "older":
            rows.reverse()
        return rows

    def _anchor(self, cids, ts):
        """First row at-or-after the moment, else the last row of history."""
        cs = ",".join("?" * len(cids))
        target = unix_to_apple_ns(ts)
        row = self.a.q(f"""
            SELECT m.date, m.ROWID AS rowid FROM message m
              JOIN chat_message_join cm ON cm.message_id = m.ROWID
             WHERE cm.chat_id IN ({cs}) AND {NOT_TAPBACK} AND m.date >= ?
             ORDER BY m.date ASC, m.ROWID ASC LIMIT 1""", list(cids) + [target])
        if not row:
            row = self.a.q(f"""
                SELECT m.date, m.ROWID AS rowid FROM message m
                  JOIN chat_message_join cm ON cm.message_id = m.ROWID
                 WHERE cm.chat_id IN ({cs}) AND {NOT_TAPBACK}
                 ORDER BY m.date DESC, m.ROWID DESC LIMIT 1""", list(cids))
        return (row[0]["date"], row[0]["rowid"]) if row else None

    def _dress(self, rows, key):
        """Rows -> the wire shape, with tapbacks, replies, attachments and
        the sidecar's notes/states folded in — batched, never per-row."""
        if not rows:
            return []
        guids = [r["guid"] for r in rows]
        rowids = [r["rowid"] for r in rows]
        gs = ",".join("?" * len(guids))

        tapbacks = {}
        try:
            for t in self.a.q(f"""
                SELECT associated_message_guid AS ag, associated_message_type AS at,
                       is_from_me, handle_id, text
                  FROM message
                 WHERE associated_message_type BETWEEN 2000 AND 2999
                   AND associated_message_guid IS NOT NULL"""):
                ag = t["ag"] or ""
                ref = ag.split("/", 1)[1] if "/" in ag else ag.split(":", 1)[-1]
                if ref not in set(guids):
                    continue
                tapbacks.setdefault(ref, []).append({
                    "kind": (t["at"] or 2000) - 2000,
                    "emoji": None,
                    "from_me": bool(t["is_from_me"]),
                    "handle": self.a.handles.get(t["handle_id"]),
                })
        except sqlite3.Error:
            pass

        replies = {}
        origin_of = {}
        try:
            for r in self.a.q(f"""
                SELECT thread_originator_guid AS og, COUNT(*) AS n
                  FROM message WHERE thread_originator_guid IN ({gs})
                 GROUP BY thread_originator_guid""", guids):
                replies[r["og"]] = r["n"]
            need = [r["thread_originator_guid"] for r in self.a.q(
                f"SELECT thread_originator_guid FROM message WHERE guid IN ({gs})"
                " AND thread_originator_guid IS NOT NULL", guids)]
            if need:
                ns = ",".join("?" * len(need))
                for o in self.a.q(f"""
                    SELECT guid, ROWID AS rowid, date, text, attributedBody
                      FROM message WHERE guid IN ({ns})""", need):
                    origin_of[o["guid"]] = {
                        "rowid": o["rowid"],
                        "date_unix": apple_to_unix(o["date"]),
                        "preview": (message_text(o) or "[media]")[:120],
                    }
        except sqlite3.Error:
            pass

        atts = {}
        rs = ",".join("?" * len(rowids))
        for j in self.a.q(f"""
            SELECT j.message_id AS mid, a.ROWID AS arid, a.filename,
                   a.transfer_name, a.mime_type, a.total_bytes
              FROM message_attachment_join j
              JOIN attachment a ON a.ROWID = j.attachment_id
             WHERE j.message_id IN ({rs})""", rowids):
            name = j["transfer_name"] or os.path.basename(j["filename"] or "") or "attachment"
            atts.setdefault(j["mid"], []).append({
                "rowid": j["arid"], "name": name,
                "mime": j["mime_type"] or mimetypes.guess_type(name)[0] or "application/octet-stream",
                "bytes": j["total_bytes"] or 0,
            })

        notes = {str(n.get("rowid")): n for n in self.s.bucket("notes", key)
                 if n.get("kind") == "msg"}
        states = self.s.bucket("states", key)

        out = []
        for r in rows:
            guid = r["guid"]
            orig = None
            try:
                og = r["thread_originator_guid"]
            except (IndexError, KeyError):
                og = None
            if og and og in origin_of:
                orig = origin_of[og]
            out.append({
                "rowid": r["rowid"], "guid": guid,
                "date_unix": apple_to_unix(r["date"]), "date_apple": r["date"],
                "from_me": bool(r["is_from_me"]),
                "handle": None if r["is_from_me"] else self.a.handles.get(r["handle_id"]),
                "text": message_text(r),
                "reply_to_guid": og, "reply_to": orig,
                "reply_count": replies.get(guid, 0),
                "tapbacks": tapbacks.get(guid, []),
                "attachments": atts.get(r["rowid"], []),
                "service": (r["service"] or "iMessage").lower(),
                "note": (notes.get(str(r["rowid"])) or {}).get("text"),
                "state": states.get(str(r["rowid"])),
            })
        return out

    # -- routes --------------------------------------------------------------

    def health(self, sp):
        try:
            n = self.a.q("SELECT COUNT(*) AS n FROM message")[0]["n"]
        except sqlite3.Error as e:
            return {"db": "error", "help": FDA_HELP.format(err=e)}
        return {
            "db": "ok", "messages": n, "csrf_token": CSRF,
            "summon_available": False, "orphaned_families": [],
            "config": {"aliases": self.aliases,
                       "default_chat": self.config.get("default_chat")},
        }

    def chats(self, sp):
        aliases = self.aliases
        threads = []
        for t in self.a.threads():
            if t["count"] == 0:
                continue
            threads.append({
                "identifier": t["identifier"], "key": t["key"],
                "display_name": t["display_name"] or aliases.get(t["identifier"]),
                "count": t["count"], "style": t["style"],
            })
        return {"threads": threads}

    def messages(self, sp, cids, key):
        limit = max(1, min(int(sp.get("limit", ["100"])[0] or 100), PAGE_MAX))
        empty = {"messages": [], "anchor_rowid": None,
                 "cursor_older": None, "cursor_newer": None}
        if not cids:
            return empty

        def cur(raw):
            bits = str(raw or "").split(",")
            if len(bits) < 2:
                return None
            try:
                return (int(float(bits[0])), int(bits[1]))
            except ValueError:
                return None

        around = sp.get("around", [None])[0]
        before = cur(sp.get("before", [None])[0])
        after = cur(sp.get("after", [None])[0])
        anchor_rowid = None
        if around not in (None, ""):
            anchor = self._anchor(cids, float(around))
            if not anchor:
                return empty
            rows = (self._page(cids, "older", anchor, limit, inclusive=True)
                    + self._page(cids, "newer", anchor, limit))
            anchor_rowid = anchor[1]
        elif before:
            rows = self._page(cids, "older", before, limit)
        elif after:
            rows = self._page(cids, "newer", after, limit)
        else:
            rows = self._page(cids, "older", None, limit)
        dressed = self._dress(rows, key)
        return {
            "messages": dressed, "anchor_rowid": anchor_rowid,
            "cursor_older": [rows[0]["date"], rows[0]["rowid"]] if rows else None,
            "cursor_newer": [rows[-1]["date"], rows[-1]["rowid"]] if rows else None,
        }

    def density(self, sp, cids, key):
        days = {}
        for r in self._stream(cids):
            d = datetime.fromtimestamp(apple_to_unix(r["date"])).strftime("%Y-%m-%d")
            slot = days.setdefault(d, {"day": d, "me": 0, "them": 0})
            slot["me" if r["is_from_me"] else "them"] += 1
        return {"days": [days[k] for k in sorted(days)]}

    def _stream(self, cids):
        """(date, rowid, guid, is_from_me) for a thread, ascending — the
        cheap spine every structural route walks."""
        cs = ",".join("?" * len(cids))
        return self.a.q(f"""
            SELECT m.date, m.ROWID AS rowid, m.guid, m.is_from_me
              FROM message m JOIN chat_message_join cm ON cm.message_id = m.ROWID
             WHERE cm.chat_id IN ({cs}) AND {NOT_TAPBACK}
             ORDER BY m.date ASC, m.ROWID ASC""", list(cids))

    def candidates(self, sp, cids, key):
        """Content-blind by construction: gaps come from timestamps alone,
        and text is decoded ONLY at the ~hundred gap boundaries the scan
        already selected — never the archive at large. What leaves this
        route is who spoke and how long the quiet was, not a word of it."""
        limit = max(1, min(int(sp.get("limit", ["12"])[0] or 12), 60))
        spine = list(self._stream(cids))
        if len(spine) < 3:
            return {"candidates": []}
        gaps = []
        for i in range(len(spine) - 1):
            a, b = spine[i], spine[i + 1]
            gap = apple_to_unix(b["date"]) - apple_to_unix(a["date"])
            if gap >= 43200:                       # half a day or more
                gaps.append((gap, a, b))
        gaps.sort(key=lambda g: -g[0])
        boundary = gaps[:120]                       # decode text only here
        texts = {}
        if boundary:
            ids = [g[1]["rowid"] for g in boundary]
            bs = ",".join("?" * len(ids))
            for r in self.a.q(
                f"SELECT ROWID AS rowid, text, attributedBody FROM message"
                f" WHERE ROWID IN ({bs})", ids):
                texts[r["rowid"]] = message_text(r) or ""
        out = []
        for gap, a, b in boundary:
            asked = texts.get(a["rowid"], "").rstrip()
            who_a = "you" if a["is_from_me"] else "they"
            who_b = "you" if b["is_from_me"] else "they"
            anchor = {"from": a["guid"], "to": b["guid"],
                      "from_ts": apple_to_unix(a["date"]),
                      "to_ts": apple_to_unix(b["date"]),
                      "ts": apple_to_unix(b["date"])}
            if asked.endswith("?") or asked.endswith("？"):
                out.append({"id": f"unanswered:{a['rowid']}", "kind": "unanswered",
                            "reason": f"{who_a} asked, then {humanize(gap)} quiet",
                            "gap": int(gap), "anchor": anchor})
            elif gap >= 3 * 86400:                  # a rupture is a long silence
                out.append({"id": f"rupture:{a['rowid']}", "kind": "rupture",
                            "reason": f"{humanize(gap)} quiet, then {who_b} wrote",
                            "gap": int(gap), "anchor": anchor})
        out.sort(key=lambda c: -c["gap"])
        out = out[:limit]
        out.sort(key=lambda c: c["anchor"]["ts"])
        return {"candidates": out}

    def markers(self, sp, cids, key):
        cs = ",".join("?" * len(cids))
        rows = self.a.q(f"""
            SELECT {BASE_COLS} FROM message m
              JOIN chat_message_join cm ON cm.message_id = m.ROWID
             WHERE cm.chat_id IN ({cs}) AND {NOT_TAPBACK}
               AND m.text IS NOT NULL
             ORDER BY m.date ASC, m.ROWID ASC""", list(cids))
        states = self.s.bucket("states", key)
        markers = []
        for r in rows:
            text = (r["text"] or "").lstrip()
            if not text or text[0] not in "".join(MARKS):
                # variation selectors ride behind some emoji
                if not any(text.startswith(e) for e in MARKS):
                    continue
            emoji = next((e for e in MARKS if text.startswith(e)), None)
            if not emoji:
                continue
            markers.append({
                "rowid": r["rowid"], "date_unix": apple_to_unix(r["date"]),
                "preview": re.sub(r"\s+", " ", text)[:120],
                "source": "message", "from_me": bool(r["is_from_me"]),
                "emoji": emoji, "state": states.get(str(r["rowid"]), "live"),
            })
        return {"markers": markers}

    def onthisday(self, sp, cids, key):
        today = date.today()
        years = {}
        for r in self._stream(cids):
            d = datetime.fromtimestamp(apple_to_unix(r["date"]))
            if (d.month, d.day) == (today.month, today.day) and d.year < today.year:
                years.setdefault(d.year, []).append(r)
        out = []
        for y in sorted(years, reverse=True):
            sample_rows = years[y][:2]
            ids = [s["rowid"] for s in sample_rows]
            bs = ",".join("?" * len(ids))
            texts = {t["rowid"]: message_text(t) for t in self.a.q(
                f"SELECT ROWID AS rowid, text, attributedBody FROM message"
                f" WHERE ROWID IN ({bs})", ids)}
            out.append({"year": y, "count": len(years[y]), "sample": [
                {"preview": (texts.get(s["rowid"]) or "[media]")[:120],
                 "date_unix": apple_to_unix(s["date"]), "rowid": s["rowid"],
                 "marked": False}
                for s in sample_rows]})
        return {"years": out}

    def wrapped(self, sp, cids, key):
        bucket = sp.get("bucket", ["year"])[0]
        f = sp.get("from", [None])[0]
        t = sp.get("to", [None])[0]
        lo = float(f) if f else None
        hi = float(t) if t else None
        per = {}
        day_first = {}
        all_days = set()
        marks = 0
        first_day = last_day = None
        for r in self._stream(cids):
            ts = apple_to_unix(r["date"])
            if (lo and ts < lo) or (hi and ts > hi):
                continue
            d = datetime.fromtimestamp(ts)
            dk = d.strftime("%Y-%m-%d")
            pk = d.strftime("%Y-%m") if bucket == "month" else str(d.year)
            p = per.setdefault(pk, {"year": pk, "me": 0, "them": 0,
                                    "days": set(), "first_me": 0, "first_them": 0})
            p["me" if r["is_from_me"] else "them"] += 1
            p["days"].add(dk)
            all_days.add(dk)
            if dk not in day_first:
                day_first[dk] = bool(r["is_from_me"])
                p["first_me" if r["is_from_me"] else "first_them"] += 1
            first_day = first_day or dk
            last_day = dk
        if not all_days:
            return {"years": [], "alltime": None}

        def longest_streak(days):
            best = run = 0
            prev = None
            best_start = None
            for dk in sorted(days):
                d = date.fromisoformat(dk)
                run = run + 1 if prev and (d - prev).days == 1 else 1
                if run > best:
                    best, best_start = run, d
                prev = d
            return best, best_start

        years = []
        for pk in sorted(per):
            p = per[pk]
            counts = {}
            streak, _ = longest_streak(p["days"])
            busiest_day, busiest_n = "", 0
            # busiest day needs per-day totals; recompute from the day set is
            # not enough — count in one more pass, bounded to this period
            years.append({
                "year": p["year"], "me": p["me"], "them": p["them"],
                "days_talked": len(p["days"]), "longest_streak": streak,
                "busiest_day": busiest_day, "busiest_n": busiest_n,
                "first_texts_me": p["first_me"], "first_texts_them": p["first_them"],
                "marks": 0,
            })
        streak, start = longest_streak(all_days)
        return {"years": years, "alltime": {
            "total": sum(p["me"] + p["them"] for p in per.values()),
            "first_day": first_day, "last_day": last_day,
            "longest_streak": streak,
            "streak_year": start.year if start else "",
            "marks": marks,
        }}

    def links(self, sp, cids, key):
        return self._grep(sp, cids, key, want="links")

    def media(self, sp, cids, key):
        limit = 60
        cs = ",".join("?" * len(cids))
        before = sp.get("before", [None])[0]
        args = list(cids)
        where = f"cm.chat_id IN ({cs})"
        if before:
            bits = before.split(",")
            where += " AND (m.date < ? OR (m.date = ? AND m.ROWID < ?))"
            args += [int(float(bits[0])), int(float(bits[0])), int(bits[1])]
        rows = self.a.q(f"""
            SELECT m.ROWID AS rowid, m.date, m.is_from_me,
                   a.ROWID AS arid, a.filename, a.transfer_name,
                   a.mime_type, a.total_bytes
              FROM message m
              JOIN chat_message_join cm ON cm.message_id = m.ROWID
              JOIN message_attachment_join j ON j.message_id = m.ROWID
              JOIN attachment a ON a.ROWID = j.attachment_id
             WHERE {where} AND a.mime_type LIKE 'image/%'
             ORDER BY m.date DESC, m.ROWID DESC LIMIT ?""", args + [limit])
        items = [{
            "rowid": r["rowid"], "date_unix": apple_to_unix(r["date"]),
            "att_rowid": r["arid"],
            "mime": r["mime_type"],
            "name": r["transfer_name"] or os.path.basename(r["filename"] or "") or "image",
            "bytes": r["total_bytes"] or 0, "from_me": bool(r["is_from_me"]),
        } for r in rows]
        cursor = [rows[-1]["date"], rows[-1]["rowid"]] if len(rows) == limit else None
        return {"items": items, "cursor": cursor}

    def _grep(self, sp, cids, key, want):
        limit = 40
        cs = ",".join("?" * len(cids))
        before = sp.get("before", [None])[0]
        args = list(cids)
        where = f"cm.chat_id IN ({cs}) AND {NOT_TAPBACK} AND m.text LIKE '%http%'"
        if before:
            bits = before.split(",")
            where += " AND (m.date < ? OR (m.date = ? AND m.ROWID < ?))"
            args += [int(float(bits[0])), int(float(bits[0])), int(bits[1])]
        rows = self.a.q(f"""
            SELECT {BASE_COLS} FROM message m
              JOIN chat_message_join cm ON cm.message_id = m.ROWID
             WHERE {where} ORDER BY m.date DESC, m.ROWID DESC LIMIT ?""",
             args + [limit])
        items = []
        for r in rows:
            text = message_text(r) or ""
            urls = re.findall(r"https?://[^\s<>\"']+", text)
            if not urls:
                continue
            items.append({
                "rowid": r["rowid"], "date_unix": apple_to_unix(r["date"]),
                "preview": re.sub(r"\s+", " ", text)[:120],
                "from_me": bool(r["is_from_me"]), "urls": urls[:6],
            })
        cursor = [rows[-1]["date"], rows[-1]["rowid"]] if len(rows) == limit else None
        return {"items": items, "cursor": cursor}

    # -- search: the demo grammar, over the real archive ---------------------
    #   "exact phrase" · from:me|them · after:/before:YYYY-MM-DD ·
    #   has:link|image|voice|mark · in:all
    # A linear scan, not FTS5 — the original indexed; this reads. On a
    # 200k-message archive a thread-scoped search stays comfortably fast;
    # in:all is the slow path and says so in its own time.

    @staticmethod
    def _fold(s):
        t = unicodedata.normalize("NFD", (s or "").lower())
        t = "".join(c for c in t if not unicodedata.combining(c))
        t = re.sub(r"[^\w\s]|_", " ", t, flags=re.UNICODE)
        return " " + " ".join(t.split()) + " "

    def search(self, sp, cids, key):
        q = sp.get("q", [""])[0]
        phrases = re.findall(r'"([^"]+)"', q)
        rest = re.sub(r'"[^"]+"', " ", q)
        filters = {"from_me": None, "after": None, "before": None,
                   "flags": [], "all": False}
        needles = list(phrases)
        for tok in rest.split():
            low = tok.lower()
            if low in ("from:me", "from:them"):
                filters["from_me"] = low.endswith(":me")
            elif low.startswith("after:"):
                try: filters["after"] = datetime.fromisoformat(low[6:]).timestamp()
                except ValueError: pass
            elif low.startswith("before:"):
                try: filters["before"] = datetime.fromisoformat(low[7:]).timestamp()
                except ValueError: pass
            elif low.startswith("has:"):
                filters["flags"].append(low[4:])
            elif low == "in:all":
                filters["all"] = True
            else:
                needles.append(tok)
        folded = [self._fold(n) for n in needles if self._fold(n).strip()]

        pools = ([(t["chat_ids"], t["key"]) for t in self.a.threads() if t["count"]]
                 if filters["all"] else [(cids, key)])
        results = []
        before = sp.get("before", [None])[0]
        before_cur = None
        if before:
            bits = before.split(",")
            before_cur = (int(float(bits[0])), int(bits[1]))
        limit = 50
        for pool_cids, pool_key in pools:
            if not pool_cids:
                continue
            cs = ",".join("?" * len(pool_cids))
            rows = self.a.q(f"""
                SELECT {BASE_COLS} FROM message m
                  JOIN chat_message_join cm ON cm.message_id = m.ROWID
                 WHERE cm.chat_id IN ({cs}) AND {NOT_TAPBACK}
                 ORDER BY m.date DESC, m.ROWID DESC""", list(pool_cids))
            for r in rows:
                if before_cur and (r["date"], r["rowid"]) >= before_cur:
                    continue
                ts = apple_to_unix(r["date"])
                if filters["after"] and ts < filters["after"]:
                    continue
                if filters["before"] and ts > filters["before"]:
                    continue
                if filters["from_me"] is not None and bool(r["is_from_me"]) != filters["from_me"]:
                    continue
                text = message_text(r) or ""
                if folded:
                    flat = self._fold(text)
                    if not all(n in flat for n in folded):
                        continue
                if "link" in filters["flags"] and "http" not in text:
                    continue
                if "mark" in filters["flags"] and not any(
                        text.lstrip().startswith(e) for e in MARKS):
                    continue
                results.append({
                    "rowid": r["rowid"], "date_unix": ts,
                    "preview": re.sub(r"\s+", " ", text)[:160],
                    "from_me": bool(r["is_from_me"]),
                    "thread": pool_key if filters["all"] else None,
                    "_c": (r["date"], r["rowid"]),
                })
                if len(results) >= limit * 2:
                    break
        results.sort(key=lambda x: x["_c"], reverse=True)
        page = results[:limit]
        cursor = list(page[-1]["_c"]) if len(results) > limit else None
        for x in page:
            x.pop("_c", None)
        return {"results": page, "cursor": cursor}

    def resolve(self, sp, cids, key):
        guid = sp.get("guid", [""])[0]
        row = self.a.q(
            "SELECT ROWID AS rowid, date FROM message WHERE guid = ?", (guid,))
        if not row:
            return {"found": False}
        return {"found": True, "rowid": row[0]["rowid"],
                "date_unix": apple_to_unix(row[0]["date"])}

    def export(self, sp, cids, key, thread):
        f = sp.get("from", [None])[0]
        t = sp.get("to", [None])[0]
        lo = float(f) if f else None
        hi = float(t) if t else None
        pins = sp.get("pins", [None])[0] == "1"
        emoji = sp.get("emoji", [None])[0]
        rows = self._page(cids, "older", None, 100000)
        aliases = self.aliases
        title = (thread or {}).get("display_name") or \
            aliases.get((thread or {}).get("identifier", ""), "") or \
            (thread or {}).get("identifier", "the thread")
        lines, count, last_day = [], 0, None
        for r in rows:
            ts = apple_to_unix(r["date"])
            if (lo and ts < lo) or (hi and ts > hi):
                continue
            text = message_text(r) or "[media]"
            if pins:
                stripped = text.lstrip()
                if not any(stripped.startswith(e) for e in MARKS):
                    continue
                if emoji and not stripped.startswith(emoji):
                    continue
            d = datetime.fromtimestamp(ts)
            day = d.strftime("%Y-%m-%d")
            if day != last_day:
                lines.append(f"\n## {d.strftime('%A, %B %-d, %Y')}\n")
                last_day = day
            who = "Me" if r["is_from_me"] else (
                aliases.get(self.a.handles.get(r["handle_id"], ""), None)
                or self.a.handles.get(r["handle_id"]) or "Them")
            lines.append(f"[{d.strftime('%H:%M')}] {who}: {text}")
            count += 1
        md = "\n".join(lines).strip()
        return {"markdown": md, "count": count, "title": title,
                "handoff": md, "handles": [], "days": 0}

    # -- sidecar routes -------------------------------------------------------

    def notes(self, sp, cids, key):
        out = []
        for n in self.s.bucket("notes", key):
            if n.get("kind") == "track":
                out.append({"date_unix": n["ts"], "text": n["text"], "kind": "track"})
            else:
                out.append({"date_unix": n.get("ts", 0), "text": n["text"],
                            "rowid": n.get("rowid"),
                            "preview": n.get("preview", ""),
                            "from_me": True, "kind": "msg"})
        return {"notes": out}

    def chapters(self, sp, cids, key):
        return {"chapters": sorted(self.s.bucket("chapters", key),
                                   key=lambda c: c["ts"])}

    def inks(self, sp, cids, key):
        return {"inks": self.s.data["inks"].get(key, {})}

    def voicenotes(self, sp, cids, key):
        """Spoken marks: the sheet gets where and how long; the sound itself
        stays a file on this Mac, fetched only when its ◉ is tapped."""
        return {"voicenotes": [
            {"id": v["id"], "ts": v["ts"], "dur": v.get("dur", 0)}
            for v in self.s.bucket("voices", key)]}


FDA_HELP = """The archive couldn't be opened: {err}
This is almost always macOS protecting your Messages — grant access and try again:
1. Open System Settings → Privacy & Security → Full Disk Access
2. Turn it on for Terminal (or iTerm — whichever runs this)
3. Quit Terminal fully (Cmd+Q) and reopen it, then run Zettel again
Nothing is sent anywhere: this permission is between you and your own Mac."""

READ_ONLY_501 = ("this rebuild reads your archive and keeps your marks — "
                 "sending, summons and handwriting still live in the original "
                 "Wavelength server on your Mac")

# ---- HTTP -------------------------------------------------------------------

# The names this server will answer to. Binding 127.0.0.1 keeps the network
# out, but it does NOT keep out the browser you are already running: any page
# you visit can open a socket to your own loopback. Normally the same-origin
# policy makes that harmless — we send no CORS headers, so evil.com may send
# the request but may not read the reply. DNS rebinding walks around that
# entirely: the attacker publishes evil.com with a one-second TTL, you load
# the page, the record flips to 127.0.0.1, and their script fetches
# http://evil.com:8477/api/messages. To the browser that is SAME-origin, so
# no CORS check ever runs — and the socket lands here. Checking Host is the
# defence, because the one thing the attacker cannot forge is which name the
# browser thinks it is talking to.
ALLOWED_HOSTS = frozenset(
    f"{h}{p}" for h in ("localhost", "127.0.0.1", "[::1]")
    for p in (f":{PORT}", "")
)

REBIND_HELP = ("this server answers to localhost only. A request arrived "
               "addressed to another name, which is how a web page tries to "
               "read your archive through your own browser — refused")


class Handler(BaseHTTPRequestHandler):
    api: Api = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass                                     # quiet; errors still raise

    # -- the doorway ---------------------------------------------------------

    def _addressed_here(self):
        """True when the browser believes it is talking to localhost.

        Absent Host is refused too: HTTP/1.1 requires it, every browser sends
        it, so a request without one is not the app asking.
        """
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in ALLOWED_HOSTS:
            return False
        # Belt to that brace: a plain cross-origin POST (no rebinding) still
        # reaches us with an honest Origin. The CSRF token already refuses it,
        # but the token is handed out by /api/health, so it is only ever one
        # readable response away from useless. Refuse on the header instead.
        origin = (self.headers.get("Origin") or "").strip().lower()
        if origin and origin not in {f"http://{h}" for h in ALLOWED_HOSTS}:
            return False
        return True

    # -- plumbing ------------------------------------------------------------

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        # same hardening the Worker sends; localhost is not an excuse
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 1024 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return None

    # -- GET -----------------------------------------------------------------

    def do_GET(self):
        if not self._addressed_here():
            return self._send(403, {"error": REBIND_HELP})
        u = urlparse(self.path)
        sp = parse_qs(u.query)
        path = unquote(u.path)

        if path.startswith("/api/attachments/"):
            return self._attachment(path[len("/api/attachments/"):], sp)
        if path.startswith("/api/voicenote/"):
            return self._voice_audio(path[len("/api/voicenote/"):])
        if path.startswith("/api/"):
            return self._api_get(path[len("/api/"):], sp)
        if path.rstrip("/") == "/card":
            return self._card(sp)
        return self._static(path)

    def _api_get(self, route, sp):
        api = self.api
        chat = sp.get("chat", [""])[0]
        cids, thread = api.a.chat_ids(chat) if chat else ([], None)
        key = api.a.thread_key(chat) if chat else ""
        table = {
            "health": lambda: api.health(sp),
            "chats": lambda: api.chats(sp),
            "messages": lambda: api.messages(sp, cids, key),
            "density": lambda: api.density(sp, cids, key),
            "candidates": lambda: api.candidates(sp, cids, key),
            "markers": lambda: api.markers(sp, cids, key),
            "chapters": lambda: api.chapters(sp, cids, key),
            "notes": lambda: api.notes(sp, cids, key),
            "inks": lambda: api.inks(sp, cids, key),
            "voicenotes": lambda: api.voicenotes(sp, cids, key),
            "summons": lambda: {"summons": []},
            "co": lambda: {"linked": False, "you": None},
            "threads": lambda: {"items": []},
            "links": lambda: api.links(sp, cids, key),
            "media": lambda: api.media(sp, cids, key),
            "search": lambda: api.search(sp, cids, key),
            "resolve": lambda: api.resolve(sp, cids, key),
            "onthisday": lambda: api.onthisday(sp, cids, key),
            "wrapped": lambda: api.wrapped(sp, cids, key),
            "export": lambda: api.export(sp, cids, key, thread),
        }
        fn = table.get(route)
        if not fn:
            return self._send(404, {"error": "nothing here"})
        try:
            return self._send(200, fn())
        except Exception as e:
            return self._send(500, {"error": "that took a strange turn",
                                    "detail": str(e)[:200]})

    # -- POST: sidecar writes, honest 501s for the Mac-only verbs ------------

    def do_POST(self):
        if not self._addressed_here():
            return self._send(403, {"error": REBIND_HELP})
        u = urlparse(self.path)
        path = unquote(u.path)
        if not path.startswith("/api/"):
            return self._send(404, {"error": "nothing here"})
        route = path[len("/api/"):]

        # /api/arm deliberately 404s: the client reads that as a
        # pre-consent server and proceeds; the real verb then answers 501.
        if route == "arm":
            return self._send(404, {"error": "legacy"})
        if route in ("say", "pinback", "summon", "summon/preview",
                     "scribe", "transcribe", "adopt", "co/link",
                     "co/unlink", "co/share", "co/respond"):
            return self._send(501, {"error": READ_ONLY_501})

        if self.headers.get("X-Wavelength-CSRF") != CSRF:
            return self._send(403, {"error": "stale page — reload and try again"})
        body = self._json_body()
        if body is None:
            return self._send(400, {"error": "malformed body"})
        api = self.api
        chat = str(body.get("chat", ""))
        key = api.a.thread_key(chat)
        try:
            if route == "tracknote":
                api.s.bucket("notes", key).append({
                    "kind": "track", "ts": float(body["ts"]),
                    "text": str(body["text"])[:500]})
                api.s.save()
                return self._send(200, {"ok": True})
            if route in ("note", "notes"):
                notes = api.s.bucket("notes", key)
                rowid = body.get("rowid")
                notes[:] = [n for n in notes
                            if not (n.get("kind") == "msg" and n.get("rowid") == rowid)]
                if str(body.get("text", "")).strip():
                    notes.append({"kind": "msg", "rowid": rowid,
                                  "ts": float(body.get("ts", 0)),
                                  "text": str(body["text"])[:500]})
                api.s.save()
                return self._send(200, {"ok": True})
            if route == "chapters":
                chapters = api.s.bucket("chapters", key)
                ts = float(body["ts"])
                if body.get("remove"):
                    chapters[:] = [c for c in chapters if abs(c["ts"] - ts) > 1]
                else:
                    chapters.append({"ts": ts, "title": str(body["title"])[:60]})
                api.s.save()
                return self._send(200, api.chapters({}, [], key))
            if route == "markstate":
                api.s.bucket("states", key)[str(body["rowid"])] = str(body["state"])
                api.s.save()
                return self._send(200, {"state": body["state"]})
            if route == "voicenote":
                # data URL in, file on disk out — the JSON store holds only
                # the coordinate and a pointer, never the sound itself
                raw = str(body.get("audio", ""))
                m = re.match(r"data:(audio/[\w.+-]+);base64,(.+)$", raw, re.S)
                if not m or len(m.group(2)) > 6_000_000:
                    return self._send(400, {"error": "bad or oversized audio"})
                import base64
                ext = {"audio/mp4": "m4a", "audio/webm": "webm",
                       "audio/ogg": "ogg"}.get(m.group(1), "bin")
                vid = secrets.token_hex(8)
                vdir = STORE_DIR / "voice"
                vdir.mkdir(parents=True, exist_ok=True)
                (vdir / f"{vid}.{ext}").write_bytes(
                    base64.b64decode(m.group(2)))
                api.s.bucket("voices", key).append({
                    "id": vid, "ext": ext, "mime": m.group(1),
                    "ts": float(body["ts"]), "dur": float(body.get("dur", 0)),
                    "created": time.time()})
                api.s.save()
                return self._send(200, {"ok": True, "id": vid})
            if route == "ink":
                api.s.data["inks"].setdefault(key, {})[str(body["fp"])] = {
                    "ts": body.get("ts"), "pages": body.get("pages", [])}
                api.s.save()
                return self._send(200, {"ok": True})
        except (KeyError, ValueError, TypeError) as e:
            return self._send(400, {"error": f"bad request: {e}"})
        return self._send(404, {"error": "nothing here"})

    def _voice_audio(self, vid):
        vid = re.sub(r"[^a-f0-9]", "", vid.split("?")[0])
        for bucket in self.api.s.data["voices"].values():
            for v in bucket:
                if v["id"] == vid:
                    f = STORE_DIR / "voice" / f"{vid}.{v['ext']}"
                    if f.exists():
                        return self._send(200, f.read_bytes(),
                                          ctype=v.get("mime", "audio/mp4"))
        return self._send(404, {"error": "that voice note is gone"})

    # -- attachments ----------------------------------------------------------

    def _attachment(self, rest, sp):
        try:
            rowid = int(rest.split("?")[0])
        except ValueError:
            return self._send(400, {"error": "bad attachment id"})
        row = self.api.a.q(
            "SELECT filename, mime_type, transfer_name FROM attachment"
            " WHERE ROWID = ?", (rowid,))
        if not row or not row[0]["filename"]:
            return self._send(404, {"error": "left the archive"})
        path = Path(os.path.expanduser(row[0]["filename"]))
        if not path.exists():
            return self._send(404, {"error": "left the archive",
                                    "detail": str(path)})
        mime = row[0]["mime_type"] or mimetypes.guess_type(path.name)[0] \
            or "application/octet-stream"
        try:
            if sp.get("thumb") and mime == "image/heic":
                path = self._transcode(path, rowid, "jpg",
                    ["sips", "-s", "format", "jpeg", "-Z", "640", str(path),
                     "--out", "{out}"])
                mime = "image/jpeg"
            elif sp.get("audio"):
                path = self._transcode(path, rowid, "m4a",
                    ["afconvert", "-f", "m4af", "-d", "aac", str(path), "{out}"])
                mime = "audio/mp4"
        except Exception as e:
            return self._send(500, {"error": "this Mac couldn't convert it",
                                    "detail": str(e)[:200]})
        return self._send(200, path.read_bytes(), ctype=mime)

    def _transcode(self, src, rowid, ext, cmd):
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        out = CACHE_DIR / f"att-{rowid}.{ext}"
        if not out.exists():
            subprocess.run([c.replace("{out}", str(out)) for c in cmd],
                           check=True, capture_output=True, timeout=30)
        return out

    # -- the shareable card ----------------------------------------------------

    def _card(self, sp):
        chat = sp.get("chat", [""])[0]
        guid = sp.get("g", [""])[0]
        ctx = max(1, min(int(sp.get("ctx", ["2"])[0] or 2), 6))
        api = self.api
        cids, _ = api.a.chat_ids(chat)
        hit = api.resolve({"guid": [guid]}, cids, "")
        if not hit.get("found"):
            return self._send(404, b"<p>that moment is not in this archive.</p>",
                              ctype="text/html; charset=utf-8")
        anchor = api._anchor(cids, hit["date_unix"])
        rows = (api._page(cids, "older", anchor, ctx, inclusive=True)
                + api._page(cids, "newer", anchor, ctx))
        aliases = api.aliases
        day = datetime.fromtimestamp(hit["date_unix"]).strftime("%A, %B %-d, %Y")
        def esc(s):
            return (str(s).replace("&", "&amp;").replace("<", "&lt;")
                    .replace(">", "&gt;"))
        body = ""
        for r in rows:
            who = "me" if r["is_from_me"] else (
                aliases.get(api.a.handles.get(r["handle_id"], ""), None)
                or api.a.handles.get(r["handle_id"]) or "?")
            hot = ' class="hot"' if r["guid"] == guid else ""
            when = datetime.fromtimestamp(apple_to_unix(r["date"])).strftime("%H:%M")
            body += (f"<article{hot}><span class=\"mono\">{esc(who)} · {when}"
                     f"</span><p>{esc(message_text(r) or '[media]')}</p></article>")
        html = f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>a moment · {esc(day)}</title><style>
body{{background:#f6f2e9;color:#1c1a15;font-family:Georgia,serif;margin:0;
padding:6vh 24px;font-size:17px;line-height:1.5}}
main{{max-width:34rem;margin:0 auto;border:1.5px solid #1c1a15;border-radius:4px;
background:#faf8f2;padding:26px 30px}}
.mono{{font-family:ui-monospace,Menlo,monospace;font-size:11px;
letter-spacing:.08em;color:#6f685c}}
article{{margin:14px 0}} article p{{margin:2px 0 0;white-space:pre-wrap}}
article.hot{{border-left:3px solid #e8720c;padding-left:12px}}
header{{border-bottom:1px solid #d8d1c1;padding-bottom:8px}}
footer{{margin-top:20px;padding-top:10px;border-top:1px solid #d8d1c1}}
</style></head><body><main><header><span class="mono">{esc(day)}</span></header>
{body}<footer class="mono">a moment from your own archive · zettel</footer>
</main></body></html>"""
        return self._send(200, html.encode(), ctype="text/html; charset=utf-8")

    # -- static: the app itself ------------------------------------------------

    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        if rel.endswith("/"):
            rel += "index.html"
        target = (APP / rel).resolve()
        if not str(target).startswith(str(APP.resolve())) or not target.is_file():
            # unknown paths fall back to the app shell (deep links like /?chat=)
            target = APP / "index.html"
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self._send(200, target.read_bytes(), ctype=f"{mime}; charset=utf-8"
                   if mime.startswith("text/") or mime.endswith("javascript")
                   or mime.endswith("json") else mime)


def main():
    config = {}
    cfg = HERE / "zettel.config.json"
    if cfg.exists():
        try:
            config = json.loads(cfg.read_text())
        except Exception as e:
            print(f"· zettel.config.json ignored ({e})")
    try:
        archive = Archive(DB_PATH)
        n = archive.q("SELECT COUNT(*) AS n FROM message")[0]["n"]
        print(f"· archive open, read-only: {DB_PATH}")
        print(f"· {n:,} messages · {len(archive.threads())} threads")
    except sqlite3.Error as e:
        print(f"\n!! couldn't open the archive: {e}\n")
        print(FDA_HELP.format(err=e))
        print("\nStarting anyway — the page will show the same steps.\n")
        archive = None

    class BootErrorApi(Api):
        def health(self, sp):
            return {"db": "error", "help": FDA_HELP.format(err="no access yet")}

    if archive:
        Handler.api = Api(archive, Store(STORE_DIR), config)
        print(f"· contacts: {len(Handler.api.aliases)} names on the desk")
    else:
        # serve the page so the consent card can explain, retry reopens
        dummy = type("A", (), {"q": lambda *a, **k: [],
                               "chat_ids": lambda *a: ([], None),
                               "thread_key": staticmethod(lambda x: str(x)),
                               "threads": lambda self: [],
                               "handles": {}})()
        Handler.api = BootErrorApi(dummy, Store(STORE_DIR), config)

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"· Zettel is reading at  http://localhost:{PORT}")
    print("· nothing leaves this Mac — Ctrl+C to put it away\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n· put away.")


if __name__ == "__main__":
    main()
