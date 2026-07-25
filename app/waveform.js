// The conversation as a waveform: time runs left→right across the whole
// thread, your messages rise above the midline, theirs fall below (form
// carries the meaning — survives grayscale). The played region — everything
// before the playhead — warms to amber, and 📌 pins sit on the strip like
// comments on a SoundCloud track.

const SVGNS = "http://www.w3.org/2000/svg";
const DAY = 86400;

export class Waveform {
  constructor(container, { onJump, onMarker, onMarkHover,
                           onViewChange } = {}) {
    this.box = container;
    this.svg = container.querySelector("svg");
    this.label = container.querySelector(".drag-label");
    this.onJump = onJump || (() => {});
    this.onMarker = onMarker || (() => {});
    this.onMarkHover = onMarkHover || (() => {});
    this.onViewChange = onViewChange || (() => {});
    this.days = [];
    this.markers = [];
    this.chapters = [];
    this.notes = [];
    this.t0 = 0;   // view range (zoomable)
    this.t1 = 1;
    this.f0 = 0;   // full range
    this.f1 = 1;
    this.playheadTs = null;
    // The amber wash means "you have listened this far" — so it must not
    // appear before you have. A thread opens at its NEWEST message, which
    // made every bar `played` on the first frame: a solid amber comb, the
    // loudest thing on the page, saying nothing. The ground is quiet until
    // you play or scrub. (See INTELLIGENCE-OVERLAY.md: the ground is quiet,
    // authored meaning is loud.)
    this.warm = false;
    this.bars = []; // {el, ts} for played-region recolor
    this.playheadLine = null;
    this.playheadKnob = null;
    this.people = { me: "ME", them: "THEM" };

    this._pointers = new Map();   // live pointers: two of them is a pinch
    this._anchors = [];           // tappable moments for coarse pointers
    // the pointer census runs on the CAPTURE phase — children stop
    // propagation on bubble, but a pinch must see every finger no matter
    // what it landed on, and no path may ever leave a ghost entry
    container.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      this._pointers.set(e.pointerId, { x: e.clientX });
      if (this._pointers.size === 2 && !this._pinching) this.enterPinch();
    }, true);
    const drop = (e) => { this._pointers.delete(e.pointerId); };
    container.addEventListener("pointerup", drop, true);
    container.addEventListener("pointercancel", drop, true);
    container.addEventListener("pointerdown", (e) => this.dragStart(e));
    // wheel zooms time around the cursor, like an audio editor
    container.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoom(e.deltaY > 0 ? 1.3 : 0.75,
                this.ts(e.clientX - this.box.getBoundingClientRect().left));
    }, { passive: false });

    new ResizeObserver(() => this.draw()).observe(container);
  }

  setParticipants(me, them) {
    this.people = { me: me || "ME", them: them || "THEM" };
    this.draw();
  }

  setWindow(days) {
    if (!this.days.length) return;
    if (days === null) {
      this.t0 = this.f0;
      this.t1 = this.f1;
    } else {
      this.t1 = this.f1;
      this.t0 = Math.max(this.f0, this.f1 - days * DAY);
    }
    this.draw();
  }

  zoom(factor, center) {
    const span = (this.t1 - this.t0) * factor;
    const full = this.f1 - this.f0;
    const clamped = Math.min(full, Math.max(3 * DAY, span));
    const frac = (center - this.t0) / (this.t1 - this.t0);
    let t0 = center - clamped * frac;
    let t1 = t0 + clamped;
    if (t0 < this.f0) { t0 = this.f0; t1 = t0 + clamped; }
    if (t1 > this.f1) { t1 = this.f1; t0 = t1 - clamped; }
    this.t0 = t0; this.t1 = t1;
    this.draw();
    this.onViewChange();
  }

  setData(days, markers, chapters, notes) {
    this.days = days;
    this.dayTimes = days.map((d) =>
      Date.parse(`${d.day}T12:00:00`) / 1000);
    this.markers = markers;
    if (chapters !== undefined) this.chapters = chapters;
    if (notes !== undefined) this.notes = notes;
    if (days.length) {
      this.f0 = Date.parse(days[0].day + "T00:00:00") / 1000;
      this.f1 = Math.max(
        Date.parse(days[days.length - 1].day + "T23:59:59") / 1000,
        this.f0 + DAY
      );
      // keep the current zoom if it still fits; otherwise show everything
      if (!(this.t0 >= this.f0 && this.t1 <= this.f1 && this.t1 > this.t0)) {
        this.t0 = this.f0;
        this.t1 = this.f1;
      }
    }
    this.draw();
  }


  x(ts) {
    const width = this.box.clientWidth;
    const span = this.t1 - this.t0;
    if (!width || !Number.isFinite(span) || span <= 0) return 0;
    return ((ts - this.t0) / span) * width;
  }

  ts(x) {
    const width = this.box.clientWidth;
    if (!width) return this.t0;
    const f = Math.min(1, Math.max(0, x / width));
    return this.t0 + f * (this.t1 - this.t0);
  }

  draw() {
    const w = this.box.clientWidth;
    const h = this.box.clientHeight;
    if (!w || !h || !this.days.length) return;
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.svg.textContent = "";
    this.bars = [];
    this._paintKey = null;   // new bars, nothing painted on them yet
    this._anchors = [];
    // SoundCloud's useful idea, translated into this paper grammar: the
    // conversation itself is the track, with "me" above, "them" below,
    // and authored mark comments riding a dedicated rail above the sound.
    const mid = h * 0.61;
    const span = this.t1 - this.t0;

    // midline
    const midline = document.createElementNS(SVGNS, "line");
    midline.setAttribute("x1", 0); midline.setAttribute("x2", w);
    midline.setAttribute("y1", mid); midline.setAttribute("y2", mid);
    midline.setAttribute("stroke", "var(--hairline)");
    this.svg.appendChild(midline);


    // bucket days so bars sit ~4px apart
    const bucketSecs = Math.max(DAY, Math.ceil(span / (w / 4) / DAY) * DAY);
    const buckets = new Map(); // b -> {me, them}
    for (const d of this.days) {
      const ts = Date.parse(d.day + "T12:00:00") / 1000;
      if (ts < this.t0 - bucketSecs || ts > this.t1 + bucketSecs) continue;
      const b = Math.floor((ts - this.t0) / bucketSecs);
      const cur = buckets.get(b) || { me: 0, them: 0 };
      cur.me += d.me; cur.them += d.them;
      buckets.set(b, cur);
    }
    let maxN = 1;
    for (const v of buckets.values()) maxN = Math.max(maxN, v.me, v.them);
    const upMax = mid - 46;         // keep the authored-comment rail clear
    const downMax = h - mid - 17;   // room for date labels below

    for (const [b, v] of buckets) {
      const ts = this.t0 + (b + 0.5) * bucketSecs;
      const x = this.x(ts);
      const up = v.me ? Math.max(1.5, (v.me / maxN) * upMax) : 0;
      const down = v.them ? Math.max(1.5, (v.them / maxN) * downMax) : 0;
      if (!up && !down) continue;
      const bar = document.createElementNS(SVGNS, "line");
      bar.setAttribute("x1", x); bar.setAttribute("x2", x);
      bar.setAttribute("y1", mid - up); bar.setAttribute("y2", mid + down);
      bar.setAttribute("stroke-width", "2");
      bar.setAttribute("stroke-linecap", "round");
      this.svg.appendChild(bar);
      this.bars.push({ el: bar, ts });
    }

    // year labels along the bottom (months when the span is short)
    const first = new Date(this.t0 * 1000);
    const monthly = span < 400 * DAY;
    const d = new Date(first.getFullYear(), monthly ? first.getMonth() : 0, 1);
    while (d.getTime() / 1000 < this.t1) {
      const ts = d.getTime() / 1000;
      if (ts >= this.t0) {
        const x = this.x(ts);
        const tick = document.createElementNS(SVGNS, "line");
        tick.setAttribute("x1", x); tick.setAttribute("x2", x);
        tick.setAttribute("y1", h - 12); tick.setAttribute("y2", h);
        tick.setAttribute("stroke", "var(--deckle)");
        this.svg.appendChild(tick);
        const text = document.createElementNS(SVGNS, "text");
        text.setAttribute("x", x + 3);
        text.setAttribute("y", h - 3);
        text.setAttribute("fill", "var(--slate)");
        text.setAttribute("font-size", "9");
        text.setAttribute("font-family", "ui-monospace, Menlo, monospace");
        text.setAttribute("letter-spacing", "1");
        text.textContent = monthly
          ? d.toLocaleDateString([], { month: "short" })
          : String(d.getFullYear());
        this.svg.appendChild(text);
      }
      if (monthly) d.setMonth(d.getMonth() + 1);
      else d.setFullYear(d.getFullYear() + 1);
    }

    // playhead: an ink needle over the strip
    this.playheadLine = document.createElementNS(SVGNS, "line");
    this.playheadLine.setAttribute("y1", 0);
    this.playheadLine.setAttribute("y2", h);
    this.playheadLine.setAttribute("stroke", "var(--ink)");
    this.playheadLine.setAttribute("stroke-width", "1.5");
    this.playheadLine.setAttribute("pointer-events", "none");
    this.svg.appendChild(this.playheadLine);

    // A real thumb makes preview position legible under a finger or stylus.
    // It is display-only; the whole strip remains the generous hit target.
    this.playheadKnob = document.createElementNS(SVGNS, "circle");
    this.playheadKnob.setAttribute("cy", mid);
    this.playheadKnob.setAttribute("r", 7);
    this.playheadKnob.setAttribute("fill", "var(--bone)");
    this.playheadKnob.setAttribute("stroke", "var(--ink)");
    this.playheadKnob.setAttribute("stroke-width", "2");
    this.playheadKnob.setAttribute("pointer-events", "none");
    this.svg.appendChild(this.playheadKnob);

    // marginalia on the track: message-notes are slate dots; track notes
    // (pinned to a moment, no message under them) are open ink circles.
    // A PEER's shared track note is the same open circle strapped in amber
    // (one hue; form still carries the meaning) — hover names its author.
    const notesAtMoment = new Map();
    for (const n of this.notes) {
      if (n.date_unix < this.t0 || n.date_unix > this.t1) continue;
      const x = this.x(n.date_unix);
      const dot = document.createElementNS(SVGNS, "circle");
      const isTrack = n.kind === "track";
      const moment = Math.floor(n.date_unix);
      const stack = notesAtMoment.get(moment) || 0;
      notesAtMoment.set(moment, stack + 1);
      const noteY = isTrack ? 58 + Math.min(stack, 3) * 8 : 51;
      dot.setAttribute("cx", x); dot.setAttribute("cy", noteY);
      dot.setAttribute("r", isTrack ? 3.6 : 2.2);
      if (isTrack) {
        dot.setAttribute("fill", "var(--vellum)");
        dot.setAttribute("stroke", n.peer ? "var(--amber)" : "var(--ink)");
        dot.setAttribute("stroke-width",
          n.peer && n.consent_status === "ours" ? "2.1"
            : n.peer ? "1.7" : "1.4");
        if (n.peer && n.consent_status !== "ours") {
          dot.setAttribute("stroke-dasharray", "1.5 1.5");
        }
      } else {
        dot.setAttribute("fill", "var(--slate)");
      }
      dot.style.cursor = "pointer";
      if (n.peer && n.consent_status === "ours") {
        const ring = document.createElementNS(SVGNS, "circle");
        ring.setAttribute("cx", x);
        ring.setAttribute("cy", noteY);
        ring.setAttribute("r", 6.2);
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", "var(--ink)");
        ring.setAttribute("stroke-width", ".7");
        ring.setAttribute("pointer-events", "none");
        this.svg.appendChild(ring);
      }
      const noteAnchor = {
        x, y: noteY,
        key: `n${n.date_unix}:${n.author || (n.peer ? "peer" : n.kind || "margin")}`,
        enter: () => {
          if (!n.text) return;
          const relation = n.consent_status === "ours" ? "ours with" : "offered by";
          this.label.textContent = n.peer
            ? `✎ ${relation} ${n.name || "them"} — ${n.text.slice(0, 70)}`
            : `✎ ${n.text.slice(0, 80)}`;
          this.placeLabel(x);
        },
        leave: () => { this.label.style.display = "none"; },
        commit: () => this.onMarker(n),
      };
      this._anchors.push(noteAnchor);
      dot.addEventListener("pointerenter", noteAnchor.enter);
      // no-hover devices fire pointerleave right at finger lift — an armed
      // preview must survive its own tap
      dot.addEventListener("pointerleave", () => {
        if (this._armedKey !== noteAnchor.key) noteAnchor.leave();
      });
      dot.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (this._pinching) return;
        if (e.pointerType === "mouse") this.onMarker(n);
        else this.tapAnchor(noteAnchor);
      });
      this.svg.appendChild(dot);
    }

    // chapters: named eras, a dashed boundary + a quiet title
    for (const c of this.chapters) {
      if (c.ts < this.t0 || c.ts > this.t1) continue;
      const x = this.x(c.ts);
      const rule = document.createElementNS(SVGNS, "line");
      rule.setAttribute("x1", x); rule.setAttribute("x2", x);
      rule.setAttribute("y1", 0); rule.setAttribute("y2", h - 12);
      rule.setAttribute("stroke", "var(--umber)");
      rule.setAttribute("stroke-dasharray", "3 4");
      this.svg.appendChild(rule);
      const title = document.createElementNS(SVGNS, "text");
      title.setAttribute("x", x + 5);
      title.setAttribute("y", 67);
      title.setAttribute("fill", "var(--graphite)");
      title.setAttribute("font-size", "10");
      title.setAttribute("font-style", "italic");
      title.setAttribute("font-family", "Georgia, serif");
      title.textContent = c.title;
      title.style.cursor = "pointer";
      const chapterAnchor = {
        x, y: 60, key: `c${c.ts}`,
        enter: () => {
          this.label.textContent = `» ${c.title}`;
          this.placeLabel(x);
        },
        leave: () => { this.label.style.display = "none"; },
        commit: () => this.onJump(c.ts),
      };
      this._anchors.push(chapterAnchor);
      title.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (this._pinching) return;
        if (e.pointerType === "mouse") this.onJump(c.ts);
        else this.tapAnchor(chapterAnchor);
      });
      this.svg.appendChild(title);
    }

    // marks ride above the waveform like track comments — shape = meaning.
    // Crowded eras occupy fixed visual cells. The previous nearest-neighbor
    // grouping could still leave overlapping 44px targets in a lively year;
    // one cell now holds the count and the ledger holds every underlying mark.
    const isLive = (mk) => mk.state !== "settled" && mk.state !== "answered";
    const clusters = [];
    const clusterWidth = 52;
    for (const m of this.markers) {
      if (m.date_unix < this.t0 || m.date_unix > this.t1) continue;
      const x = this.x(m.date_unix);
      const cell = Math.floor(x / clusterWidth);
      const last = clusters[clusters.length - 1];
      if (last && last.cell === cell) {
        last.n++;
        last.totalX += x;
        last.x = last.totalX / last.n;
        // a cluster keeps its ember while ANY member is live
        last.live = last.live || isLive(m);
        if (!isLive(last.m) && isLive(m)) last.m = m;
      } else {
        clusters.push({ m, x, totalX: x, cell, n: 1, live: isLive(m) });
      }
    }
    for (const { m, x, n, live } of clusters) {
      const avatarY = 18;
      const glyphY = 40;
      // Each marked moment is an authored track comment: monogram disc,
      // hairline stem, and the existing shape dialect beneath it.
      if (live) {
        const halo = document.createElementNS(SVGNS, "circle");
        halo.setAttribute("cx", x); halo.setAttribute("cy", avatarY);
        halo.setAttribute("r", 14);
        halo.setAttribute("fill", "var(--amber)");
        halo.classList.add("mark-halo");
        halo.style.animationDelay = `${(x % 47) / 10}s`;
        this.svg.appendChild(halo);
      }

      const stem = document.createElementNS(SVGNS, "line");
      stem.setAttribute("x1", x); stem.setAttribute("x2", x);
      stem.setAttribute("y1", avatarY + 11); stem.setAttribute("y2", mid - 3);
      stem.setAttribute("stroke", live ? "var(--amber)" : "var(--deckle)");
      stem.setAttribute("stroke-width", "1");
      stem.setAttribute("stroke-dasharray", "2 3");
      this.svg.appendChild(stem);

      const avatar = document.createElementNS(SVGNS, "circle");
      avatar.setAttribute("cx", x); avatar.setAttribute("cy", avatarY);
      avatar.setAttribute("r", 10.5);
      avatar.setAttribute("fill", m.from_me ? "var(--ink)" : "var(--bone)");
      avatar.setAttribute("stroke", live ? "var(--amber)" : "var(--graphite)");
      avatar.setAttribute("stroke-width", live ? "1.8" : "1");
      this.svg.appendChild(avatar);

      const author = document.createElementNS(SVGNS, "text");
      author.setAttribute("x", x); author.setAttribute("y", avatarY + 3);
      author.setAttribute("text-anchor", "middle");
      author.setAttribute("fill", m.from_me ? "var(--bone)" : "var(--ink)");
      author.setAttribute("font-size", "7");
      author.setAttribute("font-family", "ui-monospace, Menlo, monospace");
      author.setAttribute("letter-spacing", "0");
      author.textContent = m.from_me ? this.people.me : this.people.them;
      author.style.pointerEvents = "none";
      this.svg.appendChild(author);

      const shape = this.markShape(m.emoji, x, glyphY);
      if (!live) {
        shape.setAttribute("fill", "var(--vellum)");
        shape.setAttribute("stroke", "var(--umber)");
      }
      if (n > 1) shape.setAttribute("fill-opacity", "var(--a-pressproof)");
      if (n > 1) {
        const count = document.createElementNS(SVGNS, "text");
        count.setAttribute("x", x + 9); count.setAttribute("y", 9);
        count.setAttribute("fill", "var(--sienna)");
        count.setAttribute("font-size", "8");
        count.setAttribute("font-family", "ui-monospace, Menlo, monospace");
        count.textContent = String(n);
        this.svg.appendChild(count);
      }
      const hit = document.createElementNS(SVGNS, "rect");
      hit.setAttribute("x", x - 22); hit.setAttribute("y", 0);
      hit.setAttribute("width", 44); hit.setAttribute("height", 52);
      hit.setAttribute("fill", "transparent");
      hit.style.cursor = "pointer";
      // the ember: hovering a pin makes it breathe, floats its words,
      // and sets the pinned message in the stream glowing
      const enter = () => {
        shape.classList.add("mark-hot");
        this.label.textContent = `${m.emoji} ${m.preview.slice(0, 70)}`;
        this.placeLabel(x);
        this.onMarkHover(m);
      };
      const leave = () => {
        shape.classList.remove("mark-hot");
        this.label.style.display = "none";
        this.onMarkHover(null);
      };
      const markAnchor = {
        x, y: 26, key: `m${m.date_unix}:${m.emoji || ""}`, enter, leave,
        commit: () => this.onMarker(m),
      };
      this._anchors.push(markAnchor);
      const jump = (e) => {
        e.stopPropagation();
        if (this._pinching) return;
        if (e.pointerType === "mouse") this.onMarker(m);
        else this.tapAnchor(markAnchor);
      };
      const leaveUnlessArmed = () => {
        if (this._armedKey !== markAnchor.key) leave();
      };
      for (const el of [shape, hit]) {
        el.addEventListener("pointerdown", jump);
        el.addEventListener("pointerenter", enter);
        el.addEventListener("pointerleave", leaveUnlessArmed);
      }
      this.svg.appendChild(shape);
      this.svg.appendChild(hit);
    }

    this.setPlayhead(this.playheadTs);
    // The sheet above shares this coordinate map, so it must repaint when the
    // view moves. Without this a zoom slid the record out from under the
    // overlay and left every band and every hand-written stroke behind.
    if (this.onRedraw) this.onRedraw();
  }

  // the dialect, each a distinct grayscale-survivable shape:
  // 📌 diamond · 🔥 circle · ❓ triangle · 🩷 heart · ✅ tick · 👍 square
  markShape(emoji, x, cy = 9) {
    let el;
    if (emoji === "\u{1F525}") {                    // 🔥 fire → circle
      el = document.createElementNS(SVGNS, "circle");
      el.setAttribute("cx", x); el.setAttribute("cy", cy);
      el.setAttribute("r", 4.4);
    } else if (emoji === "❓") {                      // ❓ question → triangle
      el = document.createElementNS(SVGNS, "path");
      el.setAttribute("d",
        `M ${x} ${cy - 5} L ${x + 5} ${cy + 4.5} L ${x - 5} ${cy + 4.5} Z`);
    } else if (emoji === "\u{1FA77}") {              // 🩷 heart
      el = document.createElementNS(SVGNS, "path");
      el.setAttribute("d",
        `M ${x} ${cy + 4} C ${x - 5} ${cy} ${x - 4} ${cy - 4} ${x} ${cy - 1.5}`
        + ` C ${x + 4} ${cy - 4} ${x + 5} ${cy} ${x} ${cy + 4} Z`);
    } else if (emoji === "✅") {                      // ✅ check → a tick (stroke)
      el = document.createElementNS(SVGNS, "path");
      el.setAttribute("d", `M ${x - 4} ${cy} L ${x - 1} ${cy + 3} L ${x + 4.5} ${cy - 4}`);
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "var(--amber)");
      el.setAttribute("stroke-width", "2.4");
      el.setAttribute("stroke-linecap", "round");
      el.setAttribute("stroke-linejoin", "round");
      return el;
    } else if (emoji === "\u{1F44D}") {              // 👍 thumb → square
      el = document.createElementNS(SVGNS, "rect");
      el.setAttribute("x", x - 3.6); el.setAttribute("y", cy - 3.6);
      el.setAttribute("width", 7.2); el.setAttribute("height", 7.2);
      el.setAttribute("rx", 1);
    } else {                                         // 📌 pin → diamond
      el = document.createElementNS(SVGNS, "rect");
      el.setAttribute("x", -4); el.setAttribute("y", -4);
      el.setAttribute("width", 8); el.setAttribute("height", 8);
      el.setAttribute("transform", `translate(${x} ${cy}) rotate(45)`);
    }
    el.setAttribute("fill", "var(--amber)");
    el.setAttribute("stroke", "var(--ink)");
    el.setAttribute("stroke-width", "1");
    return el;
  }

  // recolor the played region + move the needle
  setPlayhead(ts) {
    // Called on a 350ms heartbeat whether or not anything moved: 320 bars
    // meant ~640 attribute writes 3x a second, forever, and on e-ink every
    // one of those is repaint pressure. So it early-outs — but the guard MUST
    // also account for the bars being rebuilt. draw() clears _paintKey for
    // exactly that reason: the bars it creates carry no stroke of their own,
    // so a guard that only compared the timestamp skipped the repaint after
    // every redraw and left the whole trace INVISIBLE (stroke: none) on any
    // zoom, window change or resize.
    this.playheadTs = ts;
    if (!this.playheadLine) return;
    const key = `${ts}|${this.warm}`;
    if (this._paintKey === key) return;
    this._paintKey = key;
    const visible = ts !== null && ts >= this.t0 && ts <= this.t1;
    const x = visible ? this.x(ts) : -20;
    this.playheadLine.setAttribute("x1", x);
    this.playheadLine.setAttribute("x2", x);
    if (this.playheadKnob) {
      this.playheadKnob.setAttribute("cx", x);
      this.playheadKnob.setAttribute("visibility", visible ? "visible" : "hidden");
    }
    for (const b of this.bars) {
      const played = this.warm && ts !== null && b.ts <= ts;
      b.el.setAttribute("stroke", played ? "var(--amber)" : "var(--graphite)");
      b.el.setAttribute("stroke-opacity",
        played ? "var(--a-pressproof)" : "var(--a-proof)");
    }
  }

  /** A new conversation is a cold track.
   *
   *  `warm` protected only the FIRST thread of a session: nothing ever
   *  returned it to false, so opening thread B painted every bar played on
   *  the first frame — the solid amber comb this flag exists to prevent,
   *  saying "you have listened to all of this" about a conversation just
   *  opened. Deliberately NOT inside setData(): syncMapData() re-calls that
   *  on every in-thread marks/notes refresh, which would un-warm the strip
   *  mid-listen. */
  reset() {
    this.warm = false;
    this.playheadTs = null;
    this._paintKey = null;
  }

  /** The hand has engaged the track — play or a deliberate scrub. Only now
   *  does the played region mean anything, so only now is it painted. */
  warmUp() {
    if (this.warm) return;
    this.warm = true;
    this._paintKey = null;              // the wash changes: force one repaint
    this.setPlayhead(this.playheadTs);
  }

  dragStart(e) {
    if (e.target.tagName === "rect") return; // a pin, handled there
    if (this._pinching) return;
    this.warmUp();   // a deliberate scrub is engagement
    const id = e.pointerId;
    const committedTs = this.playheadTs;
    this.box.classList.add("is-scrubbing");
    try { this.box.setPointerCapture(id); } catch (err) { /* lifted */ }
    const move = (ev) => {
      if (ev.pointerId === id && !this._pinching) this.showLabel(ev);
    };
    const up = (ev) => {
      if (ev.pointerId !== id) return; // another finger's story, not ours
      cancel(false);
      this.label.style.display = "none";
      if (this._pinching) return;
      if (ev.type === "pointercancel") {
        this.setPlayhead(committedTs);
        return;
      }
      const r = this.box.getBoundingClientRect();
      const x = ev.clientX - r.left;
      // a coarse tap near a mark, note, or chapter belongs to it — the
      // finger meant the moment, not the millisecond under it
      if (ev.pointerType !== "mouse" &&
          this.tapNearestAnchor(x, ev.clientY - r.top)) return;
      const ts = this.ts(x);
      this.setPlayhead(ts);
      this.onJump(ts);
    };
    const cancel = (restore = true) => {
      this.box.removeEventListener("pointermove", move);
      this.box.removeEventListener("pointerup", up);
      this.box.removeEventListener("pointercancel", up);
      this.box.classList.remove("is-scrubbing");
      if (this._scrubCancel === cancel) this._scrubCancel = null;
      if (restore) this.setPlayhead(committedTs);
    };
    this._scrubCancel = cancel;
    this.box.addEventListener("pointermove", move);
    this.box.addEventListener("pointerup", up);
    this.box.addEventListener("pointercancel", up);
    this.showLabel(e);
  }

  // two fingers zoom time around their midpoint — the instrument finally
  // pinches (wheel stays for mice; "all" restores the whole years)
  enterPinch() {
    this._pinching = true;
    this._pinchSpan = null;
    if (this._scrubCancel) this._scrubCancel();
    this.label.style.display = "none";
    for (const pid of this._pointers.keys()) {
      try { this.box.setPointerCapture(pid); } catch (err) { /* lifted */ }
    }
    const move = (ev) => {
      const p = this._pointers.get(ev.pointerId);
      if (!p) return;
      p.x = ev.clientX;
      const xs = [...this._pointers.values()].map((q) => q.x).slice(0, 2);
      if (xs.length < 2) return;
      const span = Math.abs(xs[0] - xs[1]);
      if (span < 12) return;
      if (this._pinchSpan === null) { this._pinchSpan = span; return; }
      const factor = this._pinchSpan / span; // spread = zoom in
      if (Math.abs(factor - 1) > 0.02) {
        const mid = (xs[0] + xs[1]) / 2 - this.box.getBoundingClientRect().left;
        this.zoom(Math.max(0.5, Math.min(2, factor)), this.ts(mid));
        this._pinchSpan = span;
      }
    };
    const end = (ev) => {
      // the census (capture phase) already deleted it; re-baseline so a
      // surviving pair never zooms against a stale span
      this._pinchSpan = null;
      if (this._pointers.size < 2) {
        this._pinching = false;
        this.box.removeEventListener("pointermove", move);
        this.box.removeEventListener("pointerup", end);
        this.box.removeEventListener("pointercancel", end);
      }
    };
    this.box.addEventListener("pointermove", move);
    this.box.addEventListener("pointerup", end);
    this.box.addEventListener("pointercancel", end);
  }

  // -- coarse-pointer grammar: first tap previews, second commits ----------
  // Hover carries the preview for mice; fingers and pens get the same
  // courtesy as two deliberate taps. Nothing travels blind.
  tapAnchor(a) {
    if (this._pinching) return;
    if (this._armedKey === a.key) {
      clearTimeout(this._armedT);
      this._armedKey = null;
      if (a.leave) a.leave();
      a.commit();
      return;
    }
    if (this._armedLeave) this._armedLeave();
    this._armedKey = a.key;
    this._armedLeave = a.leave || null;
    if (a.enter) a.enter();
    clearTimeout(this._armedT);
    this._armedT = setTimeout(() => {
      this._armedKey = null;
      if (a.leave) a.leave();
    }, 3000);
  }

  tapNearestAnchor(x, y) {
    if (!this._anchors.length) return false;
    let best = null, bestScore = Infinity;
    for (const a of this._anchors) {
      const dx = Math.abs(a.x - x);
      const dy = Math.abs((a.y ?? 32) - y);
      if (dx > 28 || dy > 28) continue;
      const score = dx + dy * .45;
      if (score < bestScore) { bestScore = score; best = a; }
    }
    if (!best) return false;
    this.tapAnchor(best);
    return true;
  }

  showLabel(e) {
    const x = e.clientX - this.box.getBoundingClientRect().left;
    const ts = this.ts(x);
    const parts = [new Date(ts * 1000).toLocaleDateString([], {
      year: "numeric", month: "short", day: "numeric",
    })];
    const activity = this.nearestActivity(ts);
    if (activity) parts.push(activity);
    const landmark = this.nearestLandmark(ts);
    if (landmark) parts.push(landmark);
    this.label.textContent = parts.join(" · ");
    this.setPlayhead(ts);
    this.placeLabel(x);
  }

  nearestActivity(ts) {
    if (!this.dayTimes?.length) return "";
    let lo = 0, hi = this.dayTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.dayTimes[mid] < ts) lo = mid + 1;
      else hi = mid;
    }
    const candidates = [lo - 1, lo]
      .filter((i) => i >= 0 && i < this.dayTimes.length);
    let best = candidates[0];
    for (const i of candidates) {
      if (Math.abs(this.dayTimes[i] - ts) < Math.abs(this.dayTimes[best] - ts)) best = i;
    }
    const distance = Math.abs(this.dayTimes[best] - ts) / DAY;
    if (distance > 4) return "quiet stretch";
    const day = this.days[best];
    const count = Number(day.me || 0) + Number(day.them || 0);
    return `${count.toLocaleString()} ${count === 1 ? "message" : "messages"}`;
  }

  nearestLandmark(ts) {
    const threshold = Math.min(30 * DAY, Math.max(2 * DAY, (this.t1 - this.t0) * 0.018));
    let best = null;
    for (const chapter of this.chapters) {
      const distance = Math.abs(chapter.ts - ts);
      if (distance <= threshold && (!best || distance < best.distance)) {
        best = { distance, text: `chapter: ${chapter.title}` };
      }
    }
    for (const mark of this.markers) {
      const distance = Math.abs(mark.date_unix - ts);
      if (distance <= threshold && (!best || distance < best.distance)) {
        const preview = String(mark.preview || "").trim();
        best = {
          distance,
          text: preview ? `${mark.emoji || "mark"} ${preview.slice(0, 42)}` : "marked moment",
        };
      }
    }
    return best?.text || "";
  }

  // the label is centered by CSS (translate(-50%)), so `left` places its
  // CENTER — clamp accordingly or words near either edge walk off the strip
  placeLabel(x) {
    this.label.style.display = "block";
    const lw = this.label.offsetWidth;
    this.label.style.left =
      `${Math.max(lw / 2 + 4, Math.min(x, this.box.clientWidth - lw / 2 - 4))}px`;
  }
}
