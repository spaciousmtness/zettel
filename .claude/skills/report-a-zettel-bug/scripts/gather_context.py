"""What a Zettel bug report may say about the machine it came from.

An allow-list, not a redactor: every field is a version, a yes/no, or a
count. Nothing here reads a message, a name, a thread, a note, or a path
with a username in it, so there is nothing to scrub afterwards.

Run: python3 .claude/skills/report-a-zettel-bug/scripts/gather_context.py [--json]
"""

import json
import os
import platform
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
HOME = Path.home()
SIDECAR = HOME / "Library/Application Support/Zettel"
PLIST = HOME / "Library/LaunchAgents/ink.zettel.server.plist"
PORT = int(os.environ.get("ZETTEL_PORT", "8477"))

NEVER = [
    "any message text, contact name, number, or thread title",
    "your aliases or default chat (the server's health reply carries them; only db status and the message count are kept)",
    "the contents of your marks, notes, ink or voice files (counted only)",
    "any absolute path, which would carry your username",
]


def git(*args):
    try:
        return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True,
                              text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def server():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=2) as r:
            h = json.load(r)
    except Exception:
        return {"running": False}
    out = {"running": True, "db": h.get("db")}
    if isinstance(h.get("messages"), int):
        out["messages"] = h["messages"]
    return out


def sidecar():
    if not SIDECAR.is_dir():
        return {"exists": False}
    files = [p for p in SIDECAR.rglob("*") if p.is_file()]
    return {"exists": True, "files": len(files),
            "mode": oct(SIDECAR.stat().st_mode & 0o777)}


def gather():
    return {
        "commit": git("rev-parse", "--short", "HEAD") or "unknown",
        "branch": git("rev-parse", "--abbrev-ref", "HEAD") or "unknown",
        "local_changes": bool(git("status", "--porcelain", "--untracked-files=no")),
        "macos": platform.mac_ver()[0] or platform.system(),
        "arch": platform.machine(),
        "python": platform.python_version(),
        "server": server(),
        "autostart_installed": PLIST.exists(),
        "sidecar": sidecar(),
    }


def render(c):
    s, sc = c["server"], c["sidecar"]
    srv = "not running"
    if s["running"]:
        srv = f"running, db {s.get('db')}"
        if "messages" in s:
            srv += f", {s['messages']} messages"
    side = f"{sc['files']} files, mode {sc['mode']}" if sc["exists"] else "none"
    return "\n".join([
        f"Zettel:    commit {c['commit']} on {c['branch']}"
        + (", local changes" if c["local_changes"] else ""),
        f"Machine:   macOS {c['macos']} · {c['arch']} · python {c['python']}",
        f"Server:    {srv} · autostart {'installed' if c['autostart_installed'] else 'not installed'}",
        f"Sidecar:   {side}",
    ])


if __name__ == "__main__":
    ctx = gather()
    if "--json" in sys.argv:
        print(json.dumps(ctx, indent=2))
    else:
        print("This is EXACTLY what would be attached to your report:\n")
        print(render(ctx))
        print("\nNever collected, by construction:")
        for line in NEVER:
            print(f"  · {line}")
