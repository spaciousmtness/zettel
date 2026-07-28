"""Minimal extractor for the text inside message.attributedBody.

Modern macOS stores message text as an NSAttributedString archived in the
NeXT `typedstream` format, leaving message.text NULL. Full typedstream
parsing is unnecessary: the first NSString payload in the blob is the
message body. Layout after the b"NSString" class name:

    01 94 84 01 2b   <length> <utf-8 bytes>

where <length> is one byte if < 0x80, or 0x81 + uint16-LE, or
0x82 + uint32-LE. We search rather than parse, and treat any failure
as "no text" so callers can fall back gracefully.
"""


def extract(blob):
    if not blob:
        return None
    for marker in (b"NSString", b"NSMutableString"):
        idx = blob.find(marker)
        if idx == -1:
            continue
        # skip class name + the 5 marker bytes ending in 0x2b ('+')
        pos = idx + len(marker)
        # tolerate slight variation: scan forward a few bytes for the '+'
        plus = blob.find(b"\x2b", pos, pos + 8)
        if plus == -1:
            continue
        pos = plus + 1
        try:
            length, pos = _read_length(blob, pos)
            raw = blob[pos:pos + length]
            if len(raw) < length:
                continue
            return raw.decode("utf-8", errors="replace")
        except (IndexError, ValueError):
            continue
    return None


def _read_length(blob, pos):
    first = blob[pos]
    if first < 0x80:
        return first, pos + 1
    if first == 0x81:
        return int.from_bytes(blob[pos + 1:pos + 3], "little"), pos + 3
    if first == 0x82:
        return int.from_bytes(blob[pos + 1:pos + 5], "little"), pos + 5
    raise ValueError("unrecognized typedstream length prefix")
