"""serve.py against a fixture archive — the traps that would otherwise wait
for midnight on a real Mac: the two-spellings merge, the ancient
seconds-scale epoch rows, typedstream decoding, cursor round-trips, and the
candidates route staying content-blind. Run: python3 test/test_serve.py"""

import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import serve  # noqa: E402

APPLE = 978307200


def ns(unix):
    return int((unix - APPLE) * 1e9)


def fixture():
    db = tempfile.mktemp(suffix=".db")
    c = sqlite3.connect(db)
    c.executescript("""
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT,
                       display_name TEXT, style INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,
      attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER, date INTEGER,
      service TEXT, cache_has_attachments INTEGER,
      associated_message_type INTEGER, associated_message_guid TEXT,
      thread_originator_guid TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT,
      transfer_name TEXT, mime_type TEXT, total_bytes INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    """)
    c.execute("INSERT INTO handle VALUES (1, '+15550000137')")
    # two spellings of ONE person — the merge the README warns about
    c.execute("INSERT INTO chat VALUES (1, '+15550000137', NULL, 45)")
    c.execute("INSERT INTO chat VALUES (2, '5550000137', NULL, 45)")
    t0 = 1695365880
    rows = [
        (1, 'G1', 'are you happy though. like actually?', None, 1, 1,
         ns(t0), 'iMessage', 0, 0, None, None),
        (2, 'G2', 'yeah anyway', None, 0, 0,
         ns(t0 + 50400), 'iMessage', 0, 0, None, None),
        (3, 'G3', None, None, 1, 0, ns(t0 + 50500), 'SMS', 0, 0, None, None),
        (4, 'G4', 'ok?', None, 1, 1, ns(t0 + 50600), 'iMessage', 0, 0, None, None),
        # ancient pre-High-Sierra row: SECONDS since 2001, not nanoseconds
        (5, 'G0', 'hello from 2015', None, 0, 0, 440000000, 'SMS', 0, 0, None, None),
    ]
    for r in rows:
        c.execute("INSERT INTO message VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", r)
    blob = (b'\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84'
            b'\x12NSAttributedString\x00\x84\x84\x08NSString\x01\x94\x84\x01+'
            b'\x14hidden in the stream')
    c.execute("UPDATE message SET attributedBody=? WHERE ROWID=3", (blob,))
    for chat_id, mid in [(1, 1), (1, 2), (2, 3), (1, 4), (1, 5)]:
        c.execute("INSERT INTO chat_message_join VALUES (?,?)", (chat_id, mid))
    c.commit()
    c.close()
    return db


class ServeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = serve.Archive(fixture())
        cls.api = serve.Api(cls.a, serve.Store(tempfile.mkdtemp()), {})
        cls.cids, cls.thread = cls.a.chat_ids('+15550000137')
        cls.key = cls.a.thread_key('+15550000137')

    def test_two_spellings_are_one_thread(self):
        live = [t for t in self.a.threads() if t["count"]]
        self.assertEqual(len(live), 1)
        self.assertEqual(live[0]["count"], 5)

    def test_country_codes_do_not_collide(self):
        # the exact bug the README warns about: +91 must never fold into +1
        self.assertEqual(serve.Archive.thread_key('+15550000137'), '5550000137')
        self.assertEqual(serve.Archive.thread_key('5550000137'), '5550000137')
        self.assertNotEqual(serve.Archive.thread_key('+915550000137'),
                            serve.Archive.thread_key('+15550000137'))

    def test_epoch_handles_both_scales(self):
        page = self.api.messages({"limit": ["100"]}, self.cids, self.key)
        years = sorted({time.gmtime(m["date_unix"]).tm_year
                        for m in page["messages"]})
        self.assertIn(years[0], (2014, 2015))   # the seconds-scale row
        self.assertEqual(years[-1], 2023)

    def test_typedstream_row_reads(self):
        page = self.api.messages({"limit": ["100"]}, self.cids, self.key)
        self.assertIn("hidden in the stream",
                      [m["text"] for m in page["messages"]])

    def test_before_cursor_is_strictly_older(self):
        latest = self.api.messages({"limit": ["2"]}, self.cids, self.key)
        cur = latest["cursor_older"]
        prev = self.api.messages(
            {"limit": ["2"], "before": [f"{cur[0]},{cur[1]}"]},
            self.cids, self.key)
        self.assertTrue(prev["messages"])
        self.assertLess(prev["messages"][-1]["date_apple"], cur[0])

    def test_candidates_find_the_question_and_leak_nothing(self):
        cand = self.api.candidates({"limit": ["10"]},
                                   self.cids, self.key)["candidates"]
        unanswered = [c for c in cand if c["kind"] == "unanswered"]
        self.assertTrue(unanswered)
        self.assertIn("asked, then", unanswered[0]["reason"])
        # the route is content-blind BY SHAPE — a word of message content in
        # its payload is a broken promise, not a formatting bug
        self.assertNotIn("happy", json.dumps(cand))

    def test_search_is_token_bounded(self):
        hit = self.api.search({"q": ['"happy though" from:me']},
                              self.cids, self.key)["results"]
        self.assertEqual(len(hit), 1)
        self.assertTrue(hit[0]["from_me"])
        # substrings must not match — 'ink' finding 'thinking' shipped once
        self.assertEqual(
            self.api.search({"q": ["happ"]}, self.cids, self.key)["results"], [])

    def test_humanize_speaks_the_house_register(self):
        self.assertEqual(serve.humanize(50400), "14 hours")
        self.assertEqual(serve.humanize(100000), "a day")
        self.assertEqual(serve.humanize(3 * 86400), "3 days")
        self.assertEqual(serve.humanize(400 * 86400), "1.1 years")


if __name__ == "__main__":
    unittest.main(verbosity=1)
