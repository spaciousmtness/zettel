"""The bug-report context block must never carry anything private, even when
the server's own health reply does. Run: python3 test/test_gather_context.py"""

import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "gather_context", ROOT / ".claude/skills/report-a-zettel-bug/scripts/gather_context.py")
gc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gc)

HEALTH = {"db": "ok", "messages": 1234, "csrf_token": "secret-token",
          "config": {"aliases": {"+15555550100": "Aunt Rosalind"},
                     "default_chat": "chat-with-rosalind"}}


class FakeResponse:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def read(self, *a):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class GatherContext(unittest.TestCase):
    def test_health_reply_is_filtered_to_status_and_count(self):
        with mock.patch.object(gc.urllib.request, "urlopen", return_value=FakeResponse(HEALTH)):
            ctx = gc.gather()
        text = json.dumps(ctx) + gc.render(ctx)
        self.assertEqual(ctx["server"], {"running": True, "db": "ok", "messages": 1234})
        for leak in ("Rosalind", "+15555550100", "secret-token", "chat-with"):
            self.assertNotIn(leak, text)

    def test_no_absolute_paths(self):
        with mock.patch.object(gc.urllib.request, "urlopen", side_effect=OSError):
            ctx = gc.gather()
        text = json.dumps(ctx) + gc.render(ctx)
        self.assertNotIn(str(Path.home()), text)
        self.assertEqual(ctx["server"], {"running": False})


if __name__ == "__main__":
    unittest.main()
