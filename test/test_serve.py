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
from unittest import mock

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


class ConsentTest(unittest.TestCase):
    """The screen most people will quit on. macOS never prompts for Full Disk
    Access, and the grant attaches to a BINARY — so which instruction is
    correct depends on how the server was started. Getting this wrong doesn't
    just fail to help, it sends someone to grant a permission to an app that
    isn't running the server."""

    def test_from_a_shell_it_names_the_app(self):
        with mock.patch.object(serve, "under_launchd", lambda: False):
            b = serve.consent_brief("denied")
        self.assertEqual(b["grant_kind"], "app")
        self.assertEqual(b["grant"], "Terminal")
        # the step everyone misses has to be said, not implied
        self.assertTrue(any("Q" in s for s in b["restart"]))

    def test_under_launchd_it_names_the_interpreter(self):
        with mock.patch.object(serve, "under_launchd", lambda: True):
            b = serve.consent_brief("denied")
        self.assertEqual(b["grant_kind"], "path")
        self.assertEqual(b["grant"], sys.executable)
        # "turn it on for Terminal" is WRONG here — Terminal isn't running us
        self.assertNotIn("Terminal", " ".join(b["restart"]))

    def test_it_links_straight_at_the_pane(self):
        # three levels into System Settings is where people give up
        b = serve.consent_brief("denied")
        self.assertIn("Privacy_AllFiles", b["settings_url"])

    def test_the_error_survives_for_the_card_to_show(self):
        self.assertEqual(serve.consent_brief("unable to open")["error"],
                         "unable to open")


class DoorwayTest(unittest.TestCase):
    """Binding 127.0.0.1 keeps the network out. It does not keep out the
    browser already running on this Mac — a page you visit can point its own
    hostname at your loopback (DNS rebinding) and then read same-origin.
    These go over a real socket with a forged Host, because that is the only
    way to prove the header is actually consulted."""

    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer
        import threading
        cls.dbpath = fixture()
        archive = serve.Archive(cls.dbpath)
        serve.Handler.api = serve.Api(archive, serve.Store(tempfile.mkdtemp()), {})
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()
        # the guard is built from serve.PORT at import; this server is on an
        # ephemeral port, so allow it explicitly rather than weakening the set
        cls.saved = serve.ALLOWED_HOSTS
        serve.ALLOWED_HOSTS = frozenset(
            list(cls.saved) + [f"localhost:{cls.port}", f"127.0.0.1:{cls.port}"])

    @classmethod
    def tearDownClass(cls):
        serve.ALLOWED_HOSTS = cls.saved
        cls.srv.shutdown()
        cls.srv.server_close()

    def raw(self, request):
        """Speak HTTP by hand — http.client would rewrite Host for us."""
        import socket
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        try:
            s.sendall(request.encode())
            chunks = []
            while True:
                b = s.recv(65536)
                if not b:
                    break
                chunks.append(b)
                if b"\r\n\r\n" in b"".join(chunks) and len(chunks) > 0:
                    blob = b"".join(chunks)
                    head, _, body = blob.partition(b"\r\n\r\n")
                    length = 0
                    for line in head.split(b"\r\n"):
                        if line.lower().startswith(b"content-length:"):
                            length = int(line.split(b":")[1])
                    if len(body) >= length:
                        return blob
        finally:
            s.close()
        return b"".join(chunks)

    def get(self, path, host, extra=""):
        return self.raw(f"GET {path} HTTP/1.1\r\nHost: {host}\r\n"
                        f"{extra}Connection: close\r\n\r\n")

    def test_the_app_itself_is_let_through(self):
        for host in (f"localhost:{self.port}", f"127.0.0.1:{self.port}"):
            self.assertIn(b"200 OK", self.get("/api/health", host))

    def test_a_rebound_hostname_cannot_read_the_archive(self):
        # the whole attack in one line: same-origin to the browser, loopback
        # on the wire. If this ever returns 200, every message is readable.
        r = self.get("/api/messages?chat=%2B15550000137", f"evil.example:{self.port}")
        self.assertIn(b"403", r)
        self.assertNotIn(b"hidden in the stream", r)
        self.assertNotIn(b"are you happy though", r)

    def test_rebinding_cannot_reach_any_read_route(self):
        for route in ("health", "chats", "messages", "search?q=happy",
                      "export", "candidates", "onthisday", "wrapped"):
            r = self.get(f"/api/{route}&chat=x" if "?" in route
                         else f"/api/{route}?chat=x", "attacker.test")
            self.assertIn(b"403", r, route)

    def test_the_csrf_token_never_escapes(self):
        # /api/health is where the write token lives. One readable response
        # and the token defence is over, so health must refuse too.
        r = self.get("/api/health", "attacker.test")
        self.assertIn(b"403", r)
        self.assertNotIn(serve.CSRF.encode(), r)

    def test_static_files_are_behind_the_same_door(self):
        self.assertIn(b"403", self.get("/", "attacker.test"))

    def test_a_missing_host_is_not_the_app_asking(self):
        # HTTP/1.1 requires Host and every browser sends it; absence is not
        # something to be generous about.
        self.assertIn(b"403", self.raw(
            "GET /api/health HTTP/1.1\r\nConnection: close\r\n\r\n"))

    def test_an_honest_cross_origin_post_is_refused_on_the_header(self):
        # Not rebinding — a plain page POSTing to localhost. The CSRF token
        # would catch it, but only while /api/health stays unreadable.
        r = self.raw(
            f"POST /api/tracknote HTTP/1.1\r\nHost: localhost:{self.port}\r\n"
            "Origin: https://evil.example\r\nContent-Type: application/json\r\n"
            "Content-Length: 2\r\nConnection: close\r\n\r\n{}")
        self.assertIn(b"403", r)

    def test_our_own_origin_still_writes(self):
        body = json.dumps({"chat": "+15550000137", "ts": 1695365880,
                           "text": "still here"})
        r = self.raw(
            f"POST /api/tracknote HTTP/1.1\r\nHost: localhost:{self.port}\r\n"
            f"Origin: http://localhost:{self.port}\r\n"
            f"X-Wavelength-CSRF: {serve.CSRF}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body.encode())}\r\n"
            f"Connection: close\r\n\r\n{body}")
        self.assertIn(b"200 OK", r)

    def test_port_is_part_of_the_name(self):
        # localhost:9999 is a DIFFERENT server; answering to it would mean
        # any local port could be rebound onto ours.
        self.assertIn(b"403", self.get("/api/health", "localhost:9999"))

    def test_restart_refuses_when_nothing_would_bring_it_back(self):
        """Absent, not inert: started from a shell there is no supervisor, so
        the verb must say so rather than exit and strand you with no server."""
        body = "{}"
        r = self.raw(
            f"POST /api/restart HTTP/1.1\r\nHost: localhost:{self.port}\r\n"
            f"X-Wavelength-CSRF: {serve.CSRF}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n{body}")
        self.assertIn(b"501", r)
        self.assertIn(b"Terminal", r)

    def test_restart_is_not_an_unauthenticated_kill_switch(self):
        body = "{}"
        r = self.raw(
            f"POST /api/restart HTTP/1.1\r\nHost: localhost:{self.port}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n{body}")
        self.assertIn(b"403", r)

    def test_a_texted_html_file_cannot_run_inside_the_app(self):
        """An attachment is a file a stranger chose. Under its own MIME type
        it executes in our origin and can read the archive through the API."""
        html = Path(tempfile.mkdtemp()) / "invoice.html"
        html.write_text("<script>fetch('/api/messages?chat=x')</script>")
        db = sqlite3.connect(self.dbpath)
        db.execute("INSERT INTO attachment VALUES (9, ?, 'invoice.html',"
                   " 'text/html', 40)", (str(html),))
        db.commit()
        db.close()
        r = self.get("/api/attachments/9", f"localhost:{self.port}")
        head = r.split(b"\r\n\r\n")[0].lower()
        self.assertIn(b"200 ok", head)
        self.assertNotIn(b"text/html", head)
        self.assertIn(b"application/octet-stream", head)
        self.assertIn(b"content-disposition: attachment", head)

    def test_an_image_still_renders_in_place(self):
        png = Path(tempfile.mkdtemp()) / "her.png"
        png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 32)
        db = sqlite3.connect(self.dbpath)
        db.execute("INSERT INTO attachment VALUES (10, ?, 'her.png',"
                   " 'image/png', 40)", (str(png),))
        db.commit()
        db.close()
        head = self.get("/api/attachments/10",
                        f"localhost:{self.port}").split(b"\r\n\r\n")[0].lower()
        self.assertIn(b"image/png", head)
        self.assertNotIn(b"content-disposition", head)

    def test_a_sibling_folder_sharing_our_prefix_is_not_reachable(self):
        """`str.startswith` would have let ../app-private through, because
        that path really does begin with the app folder's name."""
        sibling = serve.APP.resolve().parent / (serve.APP.resolve().name + "-private")
        sibling.mkdir(exist_ok=True)
        (sibling / "keys.txt").write_text("SHOULD-NEVER-BE-SERVED")
        try:
            r = self.get(f"/../{sibling.name}/keys.txt", f"localhost:{self.port}")
            self.assertNotIn(b"SHOULD-NEVER-BE-SERVED", r)
        finally:
            (sibling / "keys.txt").unlink()
            sibling.rmdir()


if __name__ == "__main__":
    unittest.main(verbosity=1)
