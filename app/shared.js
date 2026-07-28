// One home for the dialect: the mark shapes/names/settle-words, the
// tapback glyphs, and the send-safety two-tap. Previously scattered
// (mark dialect across timeline.js + app.js + waveform.js; the two-tap
// hand-rolled 6x with drifting timeouts; tapback glyphs forked between
// the stream and the clipboard) — STEP 7 consolidates the JS side.
// db.py keeps its own MARKS dict (Python can't import this file); the
// names here (pin/fire/question/heart/check/thumb) match it by hand.

// the emoji dialect — pin · fire · question · heart · check · thumb.
// shape names are for anything that wants to dispatch on FORM rather
// than the raw emoji (waveform.js's markShape draws these directly
// today and is left as-is — this is the data for whenever that follows).
// `glyph` is the INK form of each mark — the same shapes waveform.js draws
// (diamond · circle · triangle · heart · tick · square), so the interface
// speaks ONE language about one concept. The emoji keys stay exactly as they
// are: they are the vocabulary actually sent in messages, not decoration, and
// a real 📌 in a message body still renders as itself.
export const MARK_DIALECT = {
  "\u{1F4CC}": { name: "pin", shape: "diamond", glyph: "◆", settleWord: "settle" },
  "\u{1F525}": { name: "fire", shape: "circle", glyph: "●", settleWord: "keep" },
  "❓": { name: "question", shape: "triangle", glyph: "▲", settleWord: "answered" },
  "\u{1FA77}": { name: "heart", shape: "heart", glyph: "♥", settleWord: "keep" },
  "✅": { name: "check", shape: "tick", glyph: "✓", settleWord: "done" },
  "\u{1F44D}": { name: "thumb", shape: "square", glyph: "■", settleWord: "ack" },
};

/** The ink form for a mark, for any surface that is CHROME rather than
 *  message content. Falls back to the emoji itself for anything outside
 *  the dialect (a custom-emoji tapback is content, and stays as it is). */
export function markGlyph(emoji) {
  return MARK_DIALECT[emoji]?.glyph || emoji;
}

/** The one gate every clickable destination passes through.
 *
 *  A URL in this app is never ours: it arrives inside a message somebody
 *  else sent, or inside a server-built action. `a.href = url` on an
 *  unchecked string makes `javascript:` and `data:` executable by tap —
 *  the summons' action buttons already refused those inline, and the links
 *  facet did not. One home for the rule so the two cannot drift.
 *
 *  Credentials are refused too: https://evil.example@real-bank.com reads to
 *  the eye as the bank, and the links facet prints the raw string as the
 *  label. A destination we cannot vouch for stays VISIBLE and inert —
 *  never silently dropped, so nothing disappears out of the record.
 *
 *  Returns a URL object, or null. */
export function safeHttpUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch { return null; }
}

// tapback kind -> glyph. Text forms (e-ink legible, form-not-hue) —
// these are timeline.js's original forms, now the one canonical set;
// app.js's clipboard copy used to fork with its own emoji-only array.
export const TAPBACK_GLYPHS = { 0: "♥", 1: "▲", 2: "▼", 3: "ha", 4: "!!", 5: "?" };

// Every mutation carries a per-process token learned from authenticated
// /api/health. Install once at boot so existing and future POST call sites
// cannot accidentally omit the CSRF boundary.
let apiSecurityInstalled = false;
export function installApiSecurity(token) {
  if (apiSecurityInstalled) return;
  // A page may briefly be served by an already-running pre-token process
  // while its files are being upgraded. Keep reading usable; the new server
  // itself still rejects every mutation until it is restarted with a token.
  if (!token) return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const method = String(init.method || (isRequest ? input.method : "GET"))
      .toUpperCase();
    const raw = typeof input === "string" ? input
      : isRequest ? input.url : input?.href || input?.url;
    const url = new URL(raw || location.href, location.href);
    if (method === "POST" && url.origin === location.origin &&
        url.pathname.startsWith("/api/")) {
      const headers = new Headers(isRequest ? input.headers : {});
      if (init.headers) {
        new Headers(init.headers).forEach((value, name) =>
          headers.set(name, value));
      }
      headers.set("Content-Type", "application/json");
      headers.set("X-Wavelength-CSRF", token);
      return nativeFetch(input, { ...init, headers });
    }
    return nativeFetch(input, init);
  };
  apiSecurityInstalled = true;
}

export async function armCrossing(action, payload) {
  const response = await fetch("/api/arm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  const data = await response.json().catch(() => ({}));
  // During an in-place upgrade an already-running pre-consent server still
  // serves the new static files. Preserve its existing two-tap behavior until
  // the owner restarts; the new server never returns 404 for this route.
  if (response.status === 404) return "legacy-pre-consent";
  if (!response.ok || !data.consent) {
    throw new Error(data.error || "that action could not be armed");
  }
  return data.consent;
}

// the send-safety two-tap: first tap arms (widens the label, starts a
// disarm timer), second tap fires. Every call site keeps its OWN label
// text and timeout — this only holds the arm/disarm bookkeeping so it
// can't drift out of sync with itself.
//
// btn: the button element.
// armedLabel / restLabel: string, or a function returning one (read
//   fresh at arm/disarm time — several sites need the freshest value,
//   e.g. a name or a count that can change between renders).
// timeoutMs: how long an arm lasts before it quietly disarms.
// guard(): optional — runs before EITHER an arm or a fire attempt; a
//   falsy return vetoes the tap entirely (no arm, no fire, no timer
//   change) — this is for sites whose click handler used to open with
//   an early-return validation check (e.g. "nothing typed yet").
// onArm(isArmed): optional — called with true on arm, false on disarm
//   (both natural-timeout and fire-triggered disarm) — for sites that
//   hide sibling verbs while one is armed.
// onFire(): called once when an already-armed button is tapped again.
//   Owns everything after that: request, its own success/error text,
//   any of its own later reverts. armTwoTap's job ends at the tap.
export function armTwoTap(btn, { armedLabel, restLabel, timeoutMs = 4000,
                                  guard, onArm, onFire } = {}) {
  let timer = null;
  const val = (v) => (typeof v === "function" ? v() : v);

  function disarm() {
    clearTimeout(timer);
    timer = null;
    btn.dataset.armed = "";
    if (restLabel !== undefined) btn.textContent = val(restLabel);
    onArm?.(false);
  }

  function tap() {
    if (guard && !guard()) return;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      if (armedLabel !== undefined) btn.textContent = val(armedLabel);
      onArm?.(true);
      clearTimeout(timer);
      timer = setTimeout(disarm, timeoutMs);
      return;
    }
    clearTimeout(timer);
    timer = null;
    btn.dataset.armed = "";
    onArm?.(false);
    onFire();
  }

  btn.addEventListener("click", (e) => { e.stopPropagation(); tap(); });
  return { disarm, tap };
}
