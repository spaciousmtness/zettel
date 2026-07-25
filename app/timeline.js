// Virtualized message list: the DOM only ever holds a ~600-row window
// between two sentinels. Jump-anywhere and infinite scroll share one
// mechanism: fetch around/before/after, splice, compensate scrollTop.

import { MARK_DIALECT, TAPBACK_GLYPHS, armCrossing,
         armTwoTap } from "./shared.js";

const PAGE = 100;
const CAP = 600;
const TRIM = 200;
const PIN = "\u{1F4CC}";

const URL_RE = /https?:\/\/[^\s<>"']+/g;
// the emoji dialect — pin · fire · question · heart · check · thumb
export const MARKS = Object.keys(MARK_DIALECT);
// origin glyphs (ROADMAP §8, people-not-pipes): form, not hue. iMessage is
// the water they swim in — the faintest dot; the carrier gets a small
// square. Both SMS and RCS read as "carrier"; the title says which.
// Telegram (another river, imported): a quiet hollow dot.
const ORIGIN_GLYPH = {
  imessage: "⋅", sms: "▫", rcs: "▫", telegram: "◦", signal: "◦",
};
const ORIGIN_CLASS = new Set(["imessage", "sms", "rcs", "telegram", "signal"]);

export class Timeline {
  constructor(container, { onSelect, onNoteChange, onMarksChange,
                           onSummon, onArrival } = {}) {
    this.el = container;
    this.onSelect = onSelect || (() => {});
    this.onNoteChange = onNoteChange || (() => {});
    this.onMarksChange = onMarksChange || (() => {});
    this.onSummon = onSummon || (() => {});
    this.onArrival = onArrival || (() => {});
    this.summonEnabled = false;  // set from /api/health before first render
    this.stretchAnchor = null;   // shift-click: the far end of a stretch
    this.selectedMsg = null;     // survives virtualization trimming the row
    this.chat = null;
    this.aliases = {};
    this.loaded = [];
    this.nodes = [];
    this.cursorOlder = null;
    this.cursorNewer = null;
    this.doneOlder = false;
    this.doneNewer = false;
    this.epoch = 0;
    this.fetching = { older: false, newer: false };
    this.selectedIdx = -1;

    this.topSentinel = document.createElement("div");
    this.bottomSentinel = document.createElement("div");
    for (const s of [this.topSentinel, this.bottomSentinel]) {
      s.style.height = "1px";
    }

    // scroll-driven edge check (not IntersectionObserver: its callbacks ride
    // the rendering pipeline, which some embedded webviews never tick)
    this.el.addEventListener("scroll", () => this.maybeExtend(), { passive: true });
    // idle poll: covers windows too short to scroll (no scrollbar → no
    // scroll events) and webviews that drop scroll-event delivery
    // Both idle timers stand down while the tab is hidden — a backgrounded
    // reader has no viewport to extend and nobody to show an arrival to,
    // and on a battery-powered paper screen the wake cost is the whole
    // cost. Neither loses anything: the next visible tick catches up, and
    // pollNewer is a tail check, not a subscription.
    setInterval(() => { if (!document.hidden) this.maybeExtend(); }, 400);
    // A quiet tail check gives the archive a real arrival moment. It runs
    // only while this view is at the live end of an iMessage/SMS thread;
    // reading history is never interrupted or pulled toward the present.
    setInterval(() => { if (!document.hidden) this.pollNewer(); }, 5000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.maybeExtend();
    });

    this.el.addEventListener("click", (ev) => {
      const rt = ev.target.closest(".reply-to");
      if (rt) {
        this.jump(+rt.dataset.jumpTs, +rt.dataset.jumpRowid);
        return;
      }
      if (ev.target.closest("a")) return; // links open, don't select
      const row = ev.target.closest(".msg");
      if (!row) return;
      const idx = this.nodes.indexOf(row);
      if (idx < 0) return;
      // shift-click stretches the selection to here — a contiguous run the
      // summons can carry; a plain click always collapses back to one
      if (ev.shiftKey && this.selectedMsg) {
        this.stretchAnchor = this.loaded[idx];
        this.refreshStretch();
        return;
      }
      this.stretchAnchor = null;
      this.select(idx, { scroll: false });
      this.refreshStretch();
    });
  }

  setChat(chat, aliases) {
    if (this.chat !== chat) {
      this.epoch++;
      this.fetching = { older: false, newer: false };
      this.loaded = [];
      this.nodes = [];
      this.cursorOlder = null;
      this.doneNewer = false;
      this.cursorNewer = null;
      this.doneOlder = false;
      this.selectedIdx = -1;
      this.selectedMsg = null;
      this.stretchAnchor = null;
      this.inks = null;
      this.el.textContent = "";
    }
    this.chat = chat;
    this.aliases = aliases || {};
  }

  // ---- fetching ------------------------------------------------------------

  async fetchPage(params) {
    const myEpoch = this.epoch;
    const q = new URLSearchParams({ chat: this.chat, limit: PAGE, ...params });
    const res = await fetch(`/api/messages?${q}`);
    const data = await res.json();
    if (myEpoch !== this.epoch) return null; // a jump superseded this fetch
    if (!res.ok) throw new Error(data.error || "fetch failed");
    return data;
  }

  async jumpToLatest() {
    return this.jump(null);
  }

  // ts: unix seconds or null for "latest"; focusRowid highlights a known row
  async jump(ts, focusRowid = null) {
    this.epoch++;
    this.fetching = { older: false, newer: false };
    const data = await this.fetchPage(
      ts === null ? {} : { around: ts, limit: PAGE }
    );
    if (data === null) return;

    this.loaded = data.messages;
    this.cursorOlder = data.cursor_older;
    this.cursorNewer = data.cursor_newer;
    this.doneOlder = false;
    this.doneNewer = ts === null; // latest page: nothing newer
    this.selectedIdx = -1;
    this.selectedMsg = null;
    this.stretchAnchor = null;    // a jump is a new place; no stale band

    this.el.textContent = "";
    this.el.appendChild(this.topSentinel);
    const frag = document.createDocumentFragment();
    this.nodes = this.loaded.map((m, i) => {
      const node = this.render(m, i);
      frag.appendChild(node);
      return node;
    });
    this.el.appendChild(frag);
    this.el.appendChild(this.bottomSentinel);
    this.refreshDaySep();

    let target = null;
    if (focusRowid !== null) {
      const i = this.loaded.findIndex((m) => m.rowid === focusRowid);
      if (i >= 0) target = this.nodes[i];
    }
    if (!target && data.anchor_rowid !== null) {
      const i = this.loaded.findIndex((m) => m.rowid === data.anchor_rowid);
      if (i >= 0) target = this.nodes[i];
    }
    if (target) {
      target.scrollIntoView({ block: "center" });
      this.pulse(target);
    } else {
      this.el.scrollTop = this.el.scrollHeight; // latest: rest at the bottom
    }
    this.maybeExtend();
  }

  maybeExtend() {
    const near = 1200;
    if (this.el.scrollTop < near) this.extend("older");
    const fromBottom =
      this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight;
    if (fromBottom < near) this.extend("newer");
  }

  async extend(direction) {
    if (!this.chat || this.fetching[direction]) return;
    if (direction === "older" ? this.doneOlder : this.doneNewer) return;
    const cursor = direction === "older" ? this.cursorOlder : this.cursorNewer;
    if (!cursor) return;
    this.fetching[direction] = true;
    try {
      const data = await this.fetchPage({ [direction === "older" ? "before" : "after"]: cursor.join(",") });
      if (data === null) return;
      if (data.messages.length < PAGE) {
        if (direction === "older") this.doneOlder = true;
        else this.doneNewer = true;
      }
      if (data.messages.length) this.splice(direction, data);
    } finally {
      this.fetching[direction] = false;
    }
    // still inside the threshold after splicing? keep filling
    setTimeout(() => this.maybeExtend(), 0);
  }

  async pollNewer() {
    if (!this.chat || !this.doneNewer || !this.cursorNewer ||
        this.fetching.newer || document.hidden ||
        this.chat.startsWith("tg:") || this.chat.startsWith("sg:")) return;
    this.fetching.newer = true;
    try {
      const fromBottom =
        this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight;
      const data = await this.fetchPage({ after: this.cursorNewer.join(",") });
      if (data === null || !data.messages.length) return;
      const nodes = this.splice("newer", data);
      const incoming = [];
      data.messages.forEach((message, i) => {
        if (message.from_me) return;
        incoming.push(message);
        nodes[i]?.classList.add("arriving");
        setTimeout(() => nodes[i]?.classList.remove("arriving"), 4400);
      });
      if (fromBottom < 160) {
        requestAnimationFrame(() => { this.el.scrollTop = this.el.scrollHeight; });
      }
      if (incoming.length) this.onArrival(incoming);
    } catch (err) {
      // Arrival polling is atmosphere, never a reason to disturb reading.
      // The next interval retries; explicit navigation still reports errors.
    } finally {
      this.fetching.newer = false;
    }
  }

  splice(direction, data) {
    const frag = document.createDocumentFragment();
    const newNodes = data.messages.map((m) => this.render(m, -1));
    newNodes.forEach((n) => frag.appendChild(n));

    if (direction === "older") {
      const prevHeight = this.el.scrollHeight;
      const prevTop = this.el.scrollTop;
      this.el.insertBefore(frag, this.topSentinel.nextSibling);
      this.loaded = data.messages.concat(this.loaded);
      this.nodes = newNodes.concat(this.nodes);
      if (this.selectedIdx >= 0) this.selectedIdx += data.messages.length;
      // new rows + the junction row (old first row may no longer start its day)
      this.refreshDaySepRange(0, data.messages.length);
      this.cursorOlder = data.cursor_older;
      this.el.scrollTop = prevTop + (this.el.scrollHeight - prevHeight);
    } else {
      this.el.insertBefore(frag, this.bottomSentinel);
      const junction = this.loaded.length;
      this.loaded = this.loaded.concat(data.messages);
      this.nodes = this.nodes.concat(newNodes);
      this.refreshDaySepRange(junction, this.loaded.length - 1);
      this.cursorNewer = data.cursor_newer;
    }
    this.trim(direction === "older" ? "newer" : "older");
    this.restoreSelection();
    this.refreshStretch(); // newly loaded rows may sit inside the band
    return newNodes;
  }

  trim(farEnd) {
    if (this.loaded.length <= CAP) return;
    const n = TRIM;
    if (farEnd === "newer") {
      for (const node of this.nodes.slice(-n)) node.remove();
      this.loaded = this.loaded.slice(0, -n);
      this.nodes = this.nodes.slice(0, -n);
      this.cursorNewer = this.cursorFor(this.loaded[this.loaded.length - 1]);
      this.doneNewer = false;
      if (this.selectedIdx >= this.loaded.length) this.selectedIdx = -1;
    } else {
      const prevHeight = this.el.scrollHeight;
      const prevTop = this.el.scrollTop;
      for (const node of this.nodes.slice(0, n)) node.remove();
      this.loaded = this.loaded.slice(n);
      this.nodes = this.nodes.slice(n);
      this.selectedIdx = this.selectedIdx >= n ? this.selectedIdx - n : -1;
      this.cursorOlder = this.cursorFor(this.loaded[0]);
      this.doneOlder = false;
      this.refreshDaySep(0);
      this.el.scrollTop = prevTop - (prevHeight - this.el.scrollHeight);
    }
  }

  cursorFor(m) {
    return m ? [m.date_apple, m.rowid] : null;
  }

  // ---- rendering ------------------------------------------------------------

  render(m, idx) {
    const row = document.createElement("article");
    row.className = `msg ${m.from_me ? "mine" : "theirs"}`;
    const originClass = ORIGIN_CLASS.has(m.service) ? m.service : null;
    if (originClass) row.classList.add(`via-${originClass}`);
    const marked = MARKS.some((e) =>
      (m.text && m.text.includes(e)) || m.tapbacks.some((t) => t.emoji === e));
    if (marked) row.classList.add("pinned");
    // a pin spoken back into the thread by Wavelength itself: alive
    // both forms are wavelength's voice: a quote (📌 “…” 〰️) or a
    // declaration (📌/🔥/❓ … 〰️) — anything mark-led and 〰️-signed
    if (m.text && /^[\u{1F4CC}\u{1F525}❓\u{1FA77}✅\u{1F44D}] .+ 〰️$/su.test(m.text.trim())) {
      row.classList.add("pinback");
    }
    row.dataset.rowid = m.rowid;

    const daySep = document.createElement("div");
    daySep.className = "day-sep mono";
    daySep.textContent = this.dayLabel(m.date_unix);
    daySep.hidden = true;
    row.prepend(daySep);

    const sender = document.createElement("span");
    sender.className = "sender mono";
    const who = m.from_me ? "me" : this.aliases[m.handle] || m.handle || "?";
    const d = new Date(m.date_unix * 1000);
    const when = d.toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    sender.append(`${who} `);
    // origin as a quiet mono glyph — people, not pipes: form (not hue)
    // marks whether this arrived over iMessage or the carrier; the exact
    // protocol is one hover away. Absent on archives macOS didn't tag.
    // It sits DIRECTLY after the name: the timestamp that follows is
    // invisible at rest but still holds its width, and a lone dot floating
    // mid-gap reads as a dead pixel on e-ink.
    if (m.service) {
      const o = document.createElement("span");
      o.className = "origin";
      if (originClass) o.classList.add(`origin-${originClass}`);
      o.textContent = ORIGIN_GLYPH[m.service] || "◦";
      o.title = m.service === "sms" ? "SMS" : m.service === "rcs" ? "RCS"
        : m.service === "imessage" ? "iMessage"
        : m.service === "telegram" ? "Telegram" : m.service;
      sender.append(o);
    }
    // an in-place edit (telegram records them): the words shown are the
    // final ones; the ✎ says they were revised — quiet, like the origin
    if (m.edited) {
      const e = document.createElement("span");
      e.className = "origin";
      e.textContent = "✎";
      e.title = "edited";
      sender.append(e);
    }
    const whenEl = document.createElement("span");
    whenEl.className = "when";
    whenEl.textContent = when;
    // absolute fidelity on demand: the archive knows this moment to the
    // nanosecond — hold the cursor on the time to read all of it
    whenEl.title = d.toISOString() + `  ·  unix ${m.date_unix}`;
    sender.append(whenEl);
    row.append(sender);

    if (m.reply_to) {
      const rt = document.createElement("button");
      rt.className = "reply-to";
      rt.textContent = `↩ in reply to “${m.reply_to.preview.slice(0, 48)}…”`;
      rt.dataset.jumpTs = m.reply_to.date_unix;
      rt.dataset.jumpRowid = m.reply_to.rowid;
      row.append(rt);
    }

    const body = document.createElement("div");
    body.className = "body";
    if (m.text) {
      this.linkify(body, m.text);
    } else if (!m.attachments.length) {
      body.textContent = "[no text]";
      body.classList.add("placeholder");
    }
    row.append(body);

    if (m.reply_count) {
      const rc = document.createElement("span");
      rc.className = "reply-count mono";
      rc.textContent = `↩ ${m.reply_count} repl${m.reply_count === 1 ? "y" : "ies"}`;
      row.append(rc);
    }

    // the hand behind the words: messages born in ink carry a ✍ toggle —
    // the record stays text; the handwriting survives as provenance
    const inkEntry = m.from_me && m.text && this.inks
      ? this.inks[inkFp(m.text)] : null;
    if (inkEntry) {
      const inkBtn = document.createElement("button");
      inkBtn.className = "ink-toggle quiet mono";
      inkBtn.textContent = "✍";
      inkBtn.title = "see it in your hand";
      let handEl = null;
      inkBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (handEl) {
          handEl.remove(); handEl = null;
          body.hidden = false;
          inkBtn.title = "see it in your hand";
          return;
        }
        handEl = this.renderInk(inkEntry);
        body.hidden = true;
        body.before(handEl);
        inkBtn.title = "back to the words";
      });
      row.append(inkBtn);
    }

    if (m.note) row.append(this.noteEl(m));

    // touch affordances on selection: margins (✎) and timestamp link —
    // the DC-1 needs no keyboard for `a` or `y`
    const noteBtn = document.createElement("button");
    noteBtn.className = "note-btn quiet mono";
    noteBtn.textContent = "✎";
    noteBtn.title = "write in the margin (a)";
    noteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = this.nodes.indexOf(row);
      if (idx >= 0) { this.select(idx, { scroll: false }); this.editNote(); }
    });
    const linkBtn = document.createElement("button");
    linkBtn.className = "link-btn quiet mono";
    linkBtn.textContent = "⌗";
    linkBtn.title = "copy a timestamp link (y)";
    linkBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.copyLink(m);
      linkBtn.textContent = "copied";
      setTimeout(() => { linkBtn.textContent = "⌗"; }, 1200);
    });

    const imported = this.chat.startsWith("tg:") || this.chat.startsWith("sg:");
    const rowChat = this.chat;

    // pin back INTO the thread — two taps: the interface may only ask
    const pinBtn = document.createElement("button");
    pinBtn.className = "pin-btn quiet mono";
    pinBtn.textContent = "◆";
    pinBtn.title = "pin this back into iMessage";
    // the summons verb: call an outside mind on the stretch this row sits
    // in (or on this row alone). Only the consent card can send anything —
    // this button just opens it. Absent when the desk isn't at the Mac.
    let sumBtn = null;
    if (this.summonEnabled && !imported) {
      sumBtn = document.createElement("button");
      sumBtn.className = "summon-btn quiet mono";
      sumBtn.textContent = "@";
      sumBtn.title = "call on an outside mind (shift-click stretches)";
      sumBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = this.nodes.indexOf(row);
        if (idx < 0) return;
        const inBand = row.classList.contains("stretched") ||
          idx === this.selectedIdx;
        if (!inBand) {           // an unrelated row: this message alone
          this.stretchAnchor = null;
          this.select(idx, { scroll: false });
        }
        const bounds = this.stretchBounds();
        if (bounds) this.onSummon(bounds);
      });
    }
    // while a verb is armed its widened label covers the neighbors —
    // hide them so a mis-tap can never commit the WRONG send
    const soloVerb = (btn, on) => {
      for (const b of [reigBtn, pinBtn, linkBtn, noteBtn, sumBtn])
        if (b && b !== btn) b.style.visibility = on ? "hidden" : "";
    };
    let pinConsent = null;
    armTwoTap(pinBtn, {
      guard: () => {
        if (pinBtn.dataset.armed === "1" && !pinConsent) {
          pinBtn.textContent = "arming…";
          return false;
        }
        return true;
      },
      armedLabel: "send 📌 to the thread?",
      restLabel: "◆",
      timeoutMs: 4000,
      onArm: (on) => {
        soloVerb(pinBtn, on);
        if (!on) return;
        pinConsent = null;
        armCrossing("pinback", { chat: rowChat, guid: m.guid })
          .then((token) => { pinConsent = token; })
          .catch((err) => { pinBtn.textContent = err.message.slice(0, 40); });
      },
      onFire: async () => {
        pinBtn.textContent = "pinning…";
        try {
          const res = await fetch("/api/pinback", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat: rowChat, guid: m.guid,
                                   _consent: pinConsent }),
          });
          pinConsent = null;
          const d = await res.json();
          if (!res.ok) throw new Error(d.error);
          pinBtn.textContent = d.dry ? "would send ✓ (demo)" : "pinned ✓";
          if (d.sent) setTimeout(() => this.jumpToLatest(), 2500);
        } catch (err) {
          pinBtn.textContent = err.message.slice(0, 40);
          setTimeout(() => { pinBtn.textContent = "◆"; }, 4000);
        }
      },
    });
    // reignite — resurface this moment: a "still on this" nudge into the
    // thread (reminds them) and flags it resurfaced (reminds you). Two taps.
    const reigBtn = document.createElement("button");
    reigBtn.className = "reignite-btn quiet mono";
    reigBtn.textContent = "↻";
    reigBtn.title = "reignite — bring this back to attention";
    if (m.state === "resurfaced") row.classList.add("resurfaced");
    let reigniteConsent = null;
    armTwoTap(reigBtn, {
      guard: () => {
        if (reigBtn.dataset.armed === "1" && !reigniteConsent) {
          reigBtn.textContent = "arming…";
          return false;
        }
        return true;
      },
      armedLabel: "circle back to this?",
      restLabel: "↻",
      timeoutMs: 4000,
      onArm: (on) => {
        soloVerb(reigBtn, on);
        if (!on) return;
        reigniteConsent = null;
        armCrossing("reignite", { chat: rowChat, guid: m.guid })
          .then((token) => { reigniteConsent = token; })
          .catch((err) => { reigBtn.textContent = err.message.slice(0, 40); });
      },
      onFire: async () => {
        reigBtn.textContent = "reigniting…";
        try {
          const res = await fetch("/api/reignite", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat: rowChat, guid: m.guid,
                                   _consent: reigniteConsent }),
          });
          reigniteConsent = null;
          const d = await res.json();
          if (!res.ok) throw new Error(d.error);
          reigBtn.textContent = d.dry ? "would nudge ✓ (demo)" : "reignited ✓";
          m.state = "resurfaced";
          row.classList.add("resurfaced");
          this.onMarksChange();  // re-light it on the waveform + ledger
          if (d.sent) setTimeout(() => this.jumpToLatest(), 2600);
        } catch (err) {
          reigBtn.textContent = err.message.slice(0, 40);
          setTimeout(() => { reigBtn.textContent = "↻"; }, 4000);
        }
      },
    });
    if (!imported) row.append(reigBtn, pinBtn);
    row.append(linkBtn, noteBtn);
    if (sumBtn) row.append(sumBtn);

    for (const a of m.attachments) row.append(this.renderAttachment(a));

    if (m.tapbacks.length) {
      const tbs = document.createElement("div");
      tbs.className = "tapbacks mono";
      for (const t of m.tapbacks) {
        const g = document.createElement("span");
        g.className = "tb" + (t.emoji === PIN ? " pin" : "");
        const glyph = t.emoji || TAPBACK_GLYPHS[t.kind] || "•";
        const who = t.from_me ? "me" : this.aliases[t.handle] || t.handle || "?";
        g.textContent = `${glyph} ${who}`;
        tbs.append(g);
      }
      row.append(tbs);
    }
    return row;
  }

  setInks(inks) {
    this.inks = inks || null;
  }

  // strokes -> SVG: one polyline per stroke, width from mean pressure.
  // Vector, so grandma's hand scales to any glass it's read on.
  renderInk(entry) {
    const wrap = document.createElement("div");
    wrap.className = "ink-hand";
    for (const page of entry.pages) {
      const svg = document.createElementNS(
        "http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${page.w} ${page.h}`);
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      for (const stroke of page.strokes) {
        if (!stroke.length) continue;
        const line = document.createElementNS(
          "http://www.w3.org/2000/svg", "polyline");
        line.setAttribute("points",
          stroke.map((p) => `${p[0]},${p[1]}`).join(" "));
        const meanP = stroke.reduce((s, p) => s + (p[2] || 0.5), 0)
          / stroke.length;
        line.setAttribute("stroke-width", Math.max(1.2, meanP * 3.2));
        line.setAttribute("stroke", "var(--ink)");
        line.setAttribute("fill", "none");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("stroke-linejoin", "round");
        svg.appendChild(line);
      }
      wrap.appendChild(svg);
    }
    return wrap;
  }

  linkify(el, text) {
    let last = 0;
    for (const match of text.matchAll(URL_RE)) {
      el.append(text.slice(last, match.index));
      const a = document.createElement("a");
      a.href = match[0];
      a.textContent = match[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      el.append(a);
      last = match.index + match[0].length;
    }
    el.append(text.slice(last));
  }

  renderAttachment(a) {
    const isVoice = a.mime.startsWith("audio/") ||
      /\.(caf|amr|m4a|mp3)$/i.test(a.name);
    if (isVoice) {
      const wrap = document.createElement("div");
      wrap.className = "att-audio";
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "none";
      const needsTranscode = /\.(caf|amr)$/i.test(a.name) ||
        ["audio/x-caf", "audio/amr"].includes(a.mime);
      audio.src = window.__demoAtt(a.rowid, needsTranscode ? "?audio=1" : "");
      audio.onerror = async () => {
        // ask the server WHY, so the chip tells the truth
        let reason = "left the archive";
        try {
          const res = await fetch(audio.src, { cache: "no-store" });
          if (!res.ok) {
            const d = await res.json();
            reason = d.error || reason;
            if (d.detail) console.warn("voice memo detail:", d.detail);
          } else {
            reason = "this Mac's browser can't play this format";
          }
        } catch (e) { /* keep default */ }
        wrap.replaceWith(this.chip(a, reason));
      };
      const tag = document.createElement("span");
      tag.className = "mono";
      tag.textContent = "▮ voice memo";
      wrap.append(tag, audio);
      if (a.transcript) {
        const t = document.createElement("span");
        t.className = "att-transcript";
        t.textContent = `“${a.transcript}”`;
        wrap.append(t);
      } else {
        const btn = document.createElement("button");
        btn.className = "transcribe-btn quiet mono";
        btn.textContent = "transcribe";
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          btn.textContent = "listening…";
          btn.disabled = true;
          try {
            const res = await fetch("/api/transcribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ att: a.rowid }),
            });
            const data = await res.json();
            if (!res.ok) {
              if (data.detail) console.warn("transcribe detail:", data.detail);
              throw new Error(data.error);
            }
            const t = document.createElement("span");
            t.className = "att-transcript";
            t.textContent = `“${data.text}”`;
            btn.replaceWith(t);
          } catch (err) {
            btn.textContent = err.message || "couldn't transcribe";
            btn.disabled = false;
          }
        });
        wrap.append(btn);
      }
      return wrap;
    }
    if (a.mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "att-img";
      img.loading = "lazy";
      img.alt = a.name;
      const thumb = a.mime === "image/heic" ? "?thumb=1" : "";
      img.src = window.__demoAtt(a.rowid, thumb);
      img.onerror = () => img.replaceWith(this.chip(a, "left the archive"));
      return img;
    }
    return this.chip(a);
  }

  chip(a, note) {
    const chip = document.createElement("span");
    chip.className = "att-chip mono";
    const kb = a.bytes ? ` · ${Math.max(1, Math.round(a.bytes / 1024))} KB` : "";
    chip.textContent = note ? `${a.name} — ${note}` : `${a.name}${kb}`;
    return chip;
  }

  dayLabel(unix) {
    return new Date(unix * 1000).toLocaleDateString([], {
      weekday: "short", year: "numeric", month: "long", day: "numeric",
    });
  }

  dayKey(unix) {
    const d = new Date(unix * 1000);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  // show a day separator on row i iff it's the window's first row or a new day;
  // called for junction rows after any splice/trim
  refreshDaySep(...indices) {
    const fix = (i) => {
      if (i < 0 || i >= this.nodes.length) return;
      const sep = this.nodes[i].querySelector(".day-sep");
      if (!sep) return;
      const isNew =
        i === 0 ||
        this.dayKey(this.loaded[i].date_unix) !==
          this.dayKey(this.loaded[i - 1].date_unix);
      sep.hidden = !isNew;
    };
    if (indices.length === 0) {
      for (let i = 0; i < this.nodes.length; i++) fix(i);
    } else {
      for (const i of indices) fix(i);
    }
  }

  refreshDaySepRange(from, to) {
    for (let i = from; i <= to; i++) this.refreshDaySep(i);
  }

  // ---- the stretch: a contiguous run the summons can carry ---------------------

  // both ends of the stretch, ordered — selection alone is a stretch of one
  stretchBounds() {
    const sel = this.selectedMsg;
    if (!sel) return null;
    const a = this.stretchAnchor;
    if (!a || a.guid === sel.guid) {
      return { from: sel.guid, to: sel.guid, ts: sel.date_unix };
    }
    const first = (a.date_apple < sel.date_apple ||
      (a.date_apple === sel.date_apple && a.rowid < sel.rowid)) ? a : sel;
    const last = first === a ? sel : a;
    return { from: first.guid, to: last.guid, ts: last.date_unix };
  }

  // repaint the .stretched band over whatever part of it is loaded
  refreshStretch() {
    for (const n of this.el.querySelectorAll(".msg.stretched")) {
      n.classList.remove("stretched");
    }
    const sel = this.selectedMsg;
    const a = this.stretchAnchor;
    if (!sel || !a || a.guid === sel.guid) return;
    const key = (m) => [m.date_apple, m.rowid];
    let [lo, hi] = [key(a), key(sel)].sort(
      (x, y) => x[0] - y[0] || x[1] - y[1]);
    this.loaded.forEach((m, i) => {
      const k = key(m);
      if ((k[0] > lo[0] || (k[0] === lo[0] && k[1] >= lo[1])) &&
          (k[0] < hi[0] || (k[0] === hi[0] && k[1] <= hi[1]))) {
        this.nodes[i].classList.add("stretched");
      }
    });
  }

  // ---- selection & pulse ------------------------------------------------------

  select(idx, { scroll = true } = {}) {
    if (!this.loaded.length) return;
    idx = Math.max(0, Math.min(idx, this.loaded.length - 1));
    if (this.selectedIdx >= 0 && this.nodes[this.selectedIdx]) {
      this.nodes[this.selectedIdx].classList.remove("selected");
    }
    this.selectedIdx = idx;
    this.selectedMsg = this.loaded[idx];
    const node = this.nodes[idx];
    node.classList.add("selected");
    if (scroll) node.scrollIntoView({ block: "nearest" });
    this.refreshStretch(); // j/k moves resize the band live
    this.onSelect(this.loaded[idx]);
  }

  // a trimmed selection keeps its message; when the row scrolls back into
  // the window, the highlight (and the stretch it bounds) comes home
  restoreSelection() {
    if (this.selectedIdx >= 0 || !this.selectedMsg) return;
    const i = this.loaded.findIndex((m) => m.guid === this.selectedMsg.guid);
    if (i >= 0) {
      this.selectedIdx = i;
      this.nodes[i].classList.add("selected");
    }
  }

  move(delta) {
    const from = this.selectedIdx >= 0 ? this.selectedIdx : this.visibleIndex();
    this.select(from + delta);
  }

  visibleIndex() {
    const mid = this.el.scrollTop + this.el.clientHeight / 2;
    let acc = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      acc = this.nodes[i].offsetTop;
      if (acc >= mid) return Math.max(0, i - 1);
    }
    return this.nodes.length - 1;
  }

  // the ember: a pin hovered on the waveform sets its message glowing
  // in the stream (if it's within the loaded window)
  glow(rowid) {
    this.el.querySelector(".msg.ember")?.classList.remove("ember");
    if (rowid === null) return;
    const i = this.loaded.findIndex((m) => m.rowid === rowid);
    if (i >= 0) this.nodes[i].classList.add("ember");
  }

  pulse(node) {
    node.classList.add("anchor-pulse");
    setTimeout(() => {
      node.classList.add("settled");
      setTimeout(() => node.classList.remove("anchor-pulse", "settled"), 900);
    }, 30);
  }

  // debug-only: not called from any production path — a console hook
  // for eyeballing the virtualized window's actual DOM size while poking
  // at scroll/trim behavior by hand.
  domRowCount() {
    return this.el.querySelectorAll(".msg").length;
  }

  // glassnote: a note is lines of thought; lines starting [] or [x]
  // become living checkboxes (toggling writes back into the note)
  noteEl(m) {
    const wrap = document.createElement("span");
    wrap.className = "msg-note";
    const lines = m.note.split("\n");
    lines.forEach((line, li) => {
      const todo = line.match(/^\[( |x)?\]\s?(.*)$/i);
      if (todo) {
        const row = document.createElement("label");
        row.className = "note-todo";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = (todo[1] || "").toLowerCase() === "x";
        const txt = document.createElement("span");
        txt.textContent = todo[2];
        if (box.checked) txt.classList.add("done");
        box.addEventListener("change", () => {
          const next = [...lines];
          next[li] = `[${box.checked ? "x" : " "}] ${todo[2]}`;
          const node = wrap.closest(".msg");
          this.saveNote(m, node, next.join("\n"));
        });
        row.append(box, txt);
        wrap.append(row);
      } else if (line.trim()) {
        const p = document.createElement("span");
        p.className = "note-text";
        p.textContent = (li === 0 ? "✎ " : "") + line;
        wrap.append(p);
      }
    });
    if (!wrap.childElementCount) wrap.textContent = `✎ ${m.note}`;
    return wrap;
  }

  // marginalia editor: your ink in the margin of the record
  editNote() {
    const idx = this.selectedIdx;
    if (idx < 0) return;
    const m = this.loaded[idx];
    const node = this.nodes[idx];
    if (node.querySelector(".note-editor")) return;
    node.querySelector(".msg-note")?.remove();
    const box = document.createElement("textarea");
    box.className = "note-editor";
    box.value = m.note || "";
    box.rows = 2;
    box.placeholder = "a note only you will see… (enter saves · esc cancels · empty removes)";
    const done = (save) => {
      box.onblur = null;
      const text = save ? box.value.trim() : (m.note || "");
      box.remove();
      if (save) this.saveNote(m, node, text);
      else if (m.note) node.append(this.noteEl(m));
    };
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); done(true); }
      if (e.key === "Escape") done(false);
    });
    box.onblur = () => done(false);
    node.append(box);
    box.focus();
  }

  async saveNote(m, node, text) {
    const res = await fetch("/api/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat: this.chat, rowid: m.rowid, date_unix: m.date_unix,
        preview: (m.text || "").slice(0, 80), text,
      }),
    });
    if (!res.ok) return;
    m.note = text || null;
    node.querySelector(".msg-note")?.remove();
    if (m.note) node.append(this.noteEl(m));
    this.onNoteChange();
  }

  visibleDate() {
    if (!this.loaded.length) return null;
    return this.loaded[this.visibleIndex()]?.date_unix ?? null;
  }

  selected() {
    // the message, even while its row is trimmed out of the DOM window
    return this.selectedMsg;
  }

  // a timestamp is an address: guid travels across archives (the other Mac
  // holds the same message under the same guid), date is the fallback
  async copyLink(m) {
    const u = new URL(location.origin + WL.base);
    u.searchParams.set("chat", this.chat);
    u.searchParams.set("g", m.guid);
    u.searchParams.set("at", String(Math.floor(m.date_unix)));
    await copyText(u.toString());
  }
}

// ink fingerprints are computed HERE and only here — the server stores
// them verbatim, so there is no cross-language hashing to keep in sync
export function inkFp(text) {
  const s = (text || "").trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// clipboard that survives --share: navigator.clipboard exists only in
// secure contexts (https / localhost), so a DC-1 reading the app over
// plain-HTTP wifi has none — fall back to the selection-based copy,
// which still works everywhere. Returns whether anything was copied.
export async function copyText(s) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(s); return true; }
    catch (e) { /* fall through to the old way */ }
  }
  const ta = document.createElement("textarea");
  ta.value = s;
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(ta);
  ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) {}
  ta.remove();
  return ok;
}
