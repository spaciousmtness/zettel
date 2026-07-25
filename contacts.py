"""macOS Contacts → names on the desk. Read-only, best-effort, local.

The archive stores handles (a phone number, an Apple-ID email) — not
names. macOS keeps the names, in AddressBook SQLite stores under
~/Library/Application Support/AddressBook/. This reads those stores
read-only (the Terminal-launched server holds the Full Disk Access that
already lets it read chat.db) and returns a map from a NORMALIZED handle
key to a display name, so a thread that read "+14255551234" reads
"Jamie" instead.

Nothing is written. A store that won't open is skipped, not fatal — a
desk with no Contacts access simply falls back to raw handles, exactly
as before. Names are the owner's own data; this module never logs them.
"""

import glob
import os
import re
import sqlite3

_ABROOT = os.path.expanduser("~/Library/Application Support/AddressBook")


def _stores(root=None):
    """Every AddressBook SQLite under `root` (default: the real macOS
    AddressBook) — the per-source stores plus the legacy top-level one.
    `root` is a seam for tests: a fixture points it at a temp AddressBook
    of the same shape, so this reader is verifiable without real Contacts."""
    root = root or _ABROOT
    paths = glob.glob(
        os.path.join(root, "Sources", "*", "AddressBook-v22.abcddb"))
    top = os.path.join(root, "AddressBook-v22.abcddb")
    if os.path.exists(top):
        paths.append(top)
    return paths


def _phone_key(raw):
    """Normalize a phone handle the way db.thread_key does.

    NANP formatting variants share a ten-digit key; explicit international
    country codes remain intact instead of being truncated into collisions.
    """
    value = (raw or "").strip()
    digits = re.sub(r"\D", "", value)
    if not digits:
        return None
    if len(digits) == 10:
        return digits
    if len(digits) == 11 and digits.startswith("1"):
        return digits[-10:]
    if value.startswith("+"):
        return "+" + digits
    return digits


def handle_key(raw):
    """Normalize any Messages handle for a Contacts lookup."""
    value = (raw or "").strip()
    if "@" in value:
        return value.lower()
    return _phone_key(value)


def _name(first, last, nick, org):
    """Best single display name from a contact's parts, in the order a
    person expects to recognize: nickname, then full name, then either
    part, then the organization."""
    first = (first or "").strip()
    last = (last or "").strip()
    nick = (nick or "").strip()
    org = (org or "").strip()
    if nick:
        return nick
    full = (first + " " + last).strip()
    return full or first or last or org or ""


def load_map(root=None):
    """{normalized_handle_key: display_name} across every readable store.
    NANP phone keys are ten digits; international country codes are kept;
    email keys are lowercased. Earlier
    stores win on a key collision (the primary source first). Empty dict
    if Contacts can't be read — the caller degrades to raw handles.
    `root` (tests only) points at a fixture AddressBook of the same shape."""
    out = {}
    for path in _stores(root):
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        except sqlite3.Error:
            continue
        try:
            rows = con.execute("""
                SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, r.ZORGANIZATION,
                       p.ZFULLNUMBER
                FROM ZABCDPHONENUMBER p
                JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER
                WHERE p.ZFULLNUMBER IS NOT NULL
            """).fetchall()
            for first, last, nick, org, number in rows:
                key = _phone_key(number)
                name = _name(first, last, nick, org)
                if key and name and key not in out:
                    out[key] = name
            erows = con.execute("""
                SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, r.ZORGANIZATION,
                       e.ZADDRESS
                FROM ZABCDEMAILADDRESS e
                JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER
                WHERE e.ZADDRESS IS NOT NULL
            """).fetchall()
            for first, last, nick, org, addr in erows:
                key = handle_key(addr)
                name = _name(first, last, nick, org)
                if key and name and key not in out:
                    out[key] = name
        except sqlite3.Error:
            continue
        finally:
            con.close()
    return out
