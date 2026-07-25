// The Z layer — annotation as a second sheet laid over the record.
//
// Not a decoration drawn into the waveform's own SVG at a lower z-index:
// its own plane, in exact register with the ground, that can be lifted,
// dimmed and descended through. Depth without shadow (Living Paper bans
// them) comes from three things: vellum material, registration ticks, and
// parallax on the labels. Full rationale in Z-LAYER.md.
//
// Coordinates: this module NEVER computes its own time map. It borrows
// x()/ts() from the Waveform so every stratum shares one coordinate system
// (INTELLIGENCE-OVERLAY.md is explicit about this — competing maps were the
// thing to avoid).

const SVGNS = "http://www.w3.org/2000/svg";

// Form carries meaning; hue never does. Each stratum is a different SHAPE
// so the layer reads in pure grayscale and on e-ink.
const GLYPH = {
  unanswered: "?",     // a question nobody answered
  rupture: "—",   // an em dash: the silence itself
  reading: "◇",   // an open diamond: a model's reading, kept
  kept: "◆",      // filled: you accepted it into the record
  // almost-equal: the same sentence, not the same moment. The one glyph
  // that means two places at once, which is why it is the only one that
  // draws a tie line between its ends.
  resonance: "≈",
};

export class ZLayer {
  constructor(waveform, { onDescend, onSummon, onInk } = {}) {
    this.wave = waveform;
    this.onDescend = onDescend || (() => {});
    this.onSummon = onSummon || (() => {});
    this.onInk = onInk || (() => {});
    waveform.onRedraw = () => this.draw();   // repaint with the record
    this.candidates = [];
    this.readings = [];
    this.resonances = [];
    this._lift = 0;
    this._armed = null;
    this._armTimer = null;
    // Handwriting ON the sheet. Strokes are stored as {t, y} — a UNIX moment
    // and a normalised height — never pixels. So a stroke is anchored in the
    // conversation, not on the screen: zoom the track and the writing
    // stretches with the years, because it reads the same coordinate map the
    // record does.
    this.strokes = [];
    this.writing = false;
    this._live = null;
    this._storeKey = null;
    this._calm = document.body.classList.contains("calm");

    // the plane: its own svg, stacked over the ground in the same box
    this.svg = document.createElementNS(SVGNS, "svg");
    this.svg.setAttribute("id", "z-svg");
    this.svg.setAttribute("preserveAspectRatio", "none");
    this.svg.setAttribute("aria-hidden", "true");
    this.wave.box.appendChild(this.svg);

    // The pen writes in the record's own coordinates. x is read back through
    // the waveform's ts() so the mark belongs to a MOMENT; y is normalised so
    // it survives a resize.
    const at = (e) => {
      const r = this.svg.getBoundingClientRect();
      return { t: this.wave.ts(e.clientX - r.left),
               y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
    };
    this.svg.addEventListener("pointerdown", (e) => {
      if (!this.writing) return;
      e.preventDefault(); e.stopPropagation();
      // an already-lifted pointer makes this THROW, which aborted the
      // handler before the stroke was stored — handwriting vanished with no
      // error. Most likely exactly where it matters: a finger on glass.
      try { this.svg.setPointerCapture(e.pointerId); } catch { /* fine */ }
      this._live = { pts: [at(e)] };
      this.strokes.push(this._live);
    });
    this.svg.addEventListener("pointermove", (e) => {
      if (!this.writing || !this._live) return;
      e.preventDefault(); e.stopPropagation();
      const p = at(e), last = this._live.pts[this._live.pts.length - 1];
      // thin the stream: sub-pixel jitter is noise, not handwriting
      if (last && Math.abs(this.wave.x(p.t) - this.wave.x(last.t)) < 1.1
               && Math.abs(p.y - last.y) < 0.008) return;
      this._live.pts.push(p);
      this.draw();
    });
    const finish = (e) => {
      if (!this._live) return;
      e.stopPropagation();
      // a stray tap is not a stroke
      if (this._live.pts.length < 2) this.strokes.pop();
      this._live = null;
      this.save();
      this.draw();
      this.onInk();
    };
    this.svg.addEventListener("pointerup", finish);
    this.svg.addEventListener("pointercancel", finish);

    this.apply();
  }

  /** Proposals from /api/candidates — structure, not readings. */
  setCandidates(list) {
    this.candidates = Array.isArray(list) ? list : [];
    this.draw();
  }

  /** Kept summons entries — a model has read these stretches. */
  setReadings(list) {
    this.readings = Array.isArray(list) ? list : [];
    this.draw();
  }

  /** Resonances — the same question, asked again years later.
   *
   *  Its own stratum rather than a third kind of reading, because it is the
   *  only entry on the sheet that is about TWO moments at once, and the
   *  drawing has to say so: the pair is tied by a hairline across the plane.
   *  Paired with the resonance.js note about where the reading happens —
   *  the server never learned these two sentences were the same one. */
  setResonances(list) {
    this.resonances = Array.isArray(list) ? list : [];
    this.draw();
  }

  /** Point the ink at a conversation and load whatever was written on it.
   *
   *  `key` must be the SERVER'S merge key for the thread, never the raw
   *  identifier. One person is many chat rows — iMessage/SMS plus spelling
   *  variants of the same number — and the server folds them into one
   *  thread. Keyed by identifier, the same conversation reached by a
   *  different spelling opened a blank sheet and the handwriting looked
   *  lost. Marks (wl-seen-) and bookmarks (wl-bm-) already key by the merge
   *  key; the sheet was the one thing that didn't.
   *
   *  `legacy` is the old identifier-keyed store. Ink written before this
   *  fix is adopted into the merged key on first open and the dead key is
   *  cleared — nobody's handwriting is stranded under a spelling. */
  useStore(key, legacy) {
    this._storeKey = `zettel:ink:${key}`;
    const read = (name) => {
      try { return JSON.parse(localStorage.getItem(name) || "[]"); }
      catch { return []; }
    };
    this.strokes = read(this._storeKey);
    const legacyKey = legacy && legacy !== key ? `zettel:ink:${legacy}` : null;
    if (legacyKey) {
      const stranded = read(legacyKey);
      if (stranded.length) {
        // the merged sheet wins on conflict; strokes are additive and a
        // moment carries its own timestamp, so order does not matter
        this.strokes = this.strokes.concat(stranded);
        this.save();
      }
      if (stranded.length || localStorage.getItem(legacyKey) !== null) {
        try { localStorage.removeItem(legacyKey); } catch { /* fine */ }
      }
    }
    this.draw();
  }

  save() {
    if (!this._storeKey) return;
    try { localStorage.setItem(this._storeKey, JSON.stringify(this.strokes)); }
    catch { /* a full quota must never take the sheet down */ }
  }

  /** Writing mode: the plane takes the pen instead of passing taps through. */
  setWriting(on) {
    this.writing = !!on && this._lift > 0.5;
    this.svg.classList.toggle("z-writing", this.writing);
    this.svg.style.pointerEvents = this.writing ? "auto" : "none";
    this.svg.style.touchAction = this.writing ? "none" : "";
  }

  undo() {
    if (!this.strokes.length) return;
    this.strokes.pop();
    this.save();
    this.draw();
    this.onInk();
  }

  clearInk() {
    if (!this.strokes.length) return;
    this.strokes = [];
    this.save();
    this.draw();
  }

  get lift() { return this._lift; }

  /** Raise or lower the sheet. One scalar drives the whole plane AND the
   *  ground's recession — there is no second mode and no modal. */
  setLift(v) {
    const next = Math.max(0, Math.min(1, Number(v) || 0));
    if (next === this._lift) return;
    this._lift = next;
    if (next <= 0.5 && this.writing) this.setWriting(false);
    this.apply();
    this.draw();
  }

  toggle() { this.setLift(this._lift > 0.5 ? 0 : 1); }

  /** Material state: the ground recedes as the sheet rises. On e-ink this
   *  snaps — intermediate opacities smear into ghost trails, and a hard
   *  step reads as a sheet being laid down rather than faded in. */
  apply() {
    const l = this._calm ? (this._lift > 0.5 ? 1 : 0) : this._lift;
    this.wave.box.classList.toggle("z-lifted", l > 0.5);
    // on the root, not the track: the lift control lives outside #wave and
    // has to read the same scalar the plane does
    document.documentElement.style.setProperty("--z-lift", String(l));
    this.svg.style.opacity = String(0.35 + 0.65 * l);
    // parallax: the sheet's labels ride slightly behind the ground beneath
    // them. Never in calm mode — relative motion between planes is exactly
    // what leaves trails on the panel.
    this.svg.style.transform =
      this._calm ? "none" : `translateY(${(-l * 6).toFixed(2)}px)`;
  }

  /** Everything the plane draws, in one paint. */
  draw() {
    const w = this.wave.box.clientWidth;
    const h = this.wave.box.clientHeight;
    if (!w || !h) return;
    // a repaint invalidates every armed target — otherwise a stale arm
    // commits on the NEXT single tap somewhere else entirely
    this._armed = null;
    clearTimeout(this._armTimer);
    this.hint(null);
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.svg.textContent = "";
    if (this._lift <= 0) return;   // sheet down: the record stands alone

    this.registration(w, h);
    this.ink(w, h);
    // readings sit above candidates: a stretch someone actually read
    // outranks a stretch that merely looks interesting
    for (const c of this.cluster(this.candidates, w)) this.tab(c, w, h, true);
    for (const r of this.cluster(this.readings, w)) this.tab(r, w, h, false);
    // ties are drawn UNDER the resonance tabs so a hairline never crosses a
    // glyph, and above everything else so the pair reads as one object
    this.ties(w, h);
    for (const r of this.cluster(this.resonances, w)) this.tab(r, w, h, false);
  }

  /** The line between two askings of the same sentence.
   *
   *  This is the only mark on the sheet that joins two moments, and it is
   *  the reason resonance is a stratum rather than a kind: everything else
   *  here is local to one stretch of time. Drawn only when BOTH ends are in
   *  view — half a tie running off the edge reads as a stray rule, and the
   *  tab's own label already says where the other end is. */
  ties(w, h) {
    const seen = new Set();
    for (const r of this.resonances) {
      const here = Number(r?.anchor?.from_ts);
      const there = Number(r?.twin_ts);
      if (!Number.isFinite(here) || !Number.isFinite(there)) continue;
      const { t0, t1 } = this.wave;
      if (here < t0 || here > t1 || there < t0 || there > t1) continue;
      // each pair is held by both its ends; draw the tie once
      const key = [Math.min(here, there), Math.max(here, there)].join(":");
      if (seen.has(key)) continue;
      seen.add(key);

      const line = document.createElementNS(SVGNS, "line");
      line.setAttribute("x1", this.wave.x(here).toFixed(1));
      line.setAttribute("x2", this.wave.x(there).toFixed(1));
      line.setAttribute("y1", 36);
      line.setAttribute("y2", 36);
      line.setAttribute("stroke", "var(--ink)");
      line.setAttribute("stroke-width", "1");
      // a long dash: kin to the candidate's pencil, but continuous enough to
      // read as a span rather than a boundary. Solid at full contrast on
      // e-ink, where a fine dash dithers into a smear.
      if (!this._calm) line.setAttribute("stroke-dasharray", "6 4");
      line.setAttribute("stroke-opacity", this._calm ? "1" : "0.7");
      line.setAttribute("pointer-events", "none");
      line.classList.add("z-tie");
      this.svg.appendChild(line);
    }
  }

  /** Geometry for one entry, or null if it can't be placed / is off-view. */
  place(item, w) {
    const a = item?.anchor || {};
    let from = Number(a.from_ts ?? a.ts);
    let to = Number(a.to_ts ?? a.ts);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (from > to) [from, to] = [to, from];
    const { t0, t1 } = this.wave;
    if (to < t0 || from > t1) return null;
    // clamp inside the track at both chronological edges — a target hanging
    // off the end is half untappable, which was a real reported break
    const pad = 22;
    const x0 = Math.max(pad, Math.min(w - pad, this.wave.x(Math.max(from, t0))));
    const x1 = Math.max(pad, Math.min(w - pad, this.wave.x(Math.min(to, t1))));
    return { item, from, to, x0, x1, center: (x0 + x1) / 2 };
  }

  /** Twelve 44px targets need 528px; a phone track is 390. Without this,
   *  every adjacent pair overlaps (measured: -23px gaps) and you tap the
   *  wrong one. Neighbours merge into one counted tab — and a cluster is
   *  never silently resolved to one of its members: opening it zooms the
   *  track until they separate. */
  cluster(items, w) {
    const placed = [];
    for (const it of items) {
      const p = this.place(it, w);
      if (p) placed.push(p);
    }
    placed.sort((a, b) => a.center - b.center);
    const out = [];
    for (const p of placed) {
      const last = out[out.length - 1];
      if (last && p.center - last.center < 46) {
        last.x0 = Math.min(last.x0, p.x0);
        last.x1 = Math.max(last.x1, p.x1);
        last.from = Math.min(last.from, p.from);
        last.to = Math.max(last.to, p.to);
        last.center = Math.max(24, Math.min(w - 24, (last.x0 + last.x1) / 2));
        last.entries.push(p.item);
      } else {
        out.push({ x0: p.x0, x1: p.x1, center: p.center,
                   from: p.from, to: p.to, entries: [p.item] });
      }
    }
    return out;
  }

  /** Zoom the track until a cluster's members separate. */
  focusRange(from, to) {
    const span = Math.max(1, this.wave.t1 - this.wave.t0);
    const want = Math.max((to - from) * 2.2, span * 0.08);
    this.wave.zoom(want / span, (from + to) / 2);
    this.draw();
  }

  /** Hand-written strokes, replayed through the record's coordinate map. A
   *  stroke drawn over March 2024 stays over March 2024 at every zoom. */
  ink(w, h) {
    for (const st of this.strokes) {
      if (!st?.pts?.length) continue;
      const pts = [];
      for (const p of st.pts) {
        const t = Number(p.t);
        if (!Number.isFinite(t)) continue;
        pts.push(`${this.wave.x(t).toFixed(1)},${(p.y * h).toFixed(1)}`);
      }
      if (pts.length < 2) continue;
      const line = document.createElementNS(SVGNS, "polyline");
      line.setAttribute("points", pts.join(" "));
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "var(--ink)");
      line.setAttribute("stroke-width", "1.6");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("stroke-linejoin", "round");
      line.setAttribute("pointer-events", "none");
      line.classList.add("z-ink");
      this.svg.appendChild(line);
    }
  }

  /** Registration ticks — the drafting-overlay cue that says "separate
   *  sheet, pinned in register" and does the work a shadow would. */
  registration(w, h) {
    for (const x of [0.5, w - 0.5]) {
      for (const y of [[0, 9], [h - 9, h]]) {
        const t = document.createElementNS(SVGNS, "line");
        t.setAttribute("x1", x); t.setAttribute("x2", x);
        t.setAttribute("y1", y[0]); t.setAttribute("y2", y[1]);
        t.setAttribute("stroke", "var(--slate)");
        t.setAttribute("stroke-width", "1");
        t.setAttribute("pointer-events", "none");
        this.svg.appendChild(t);
      }
    }
  }

  tab(cluster, w, h, candidate) {
    const many = cluster.entries.length > 1;
    const item = cluster.entries[0];
    const kind = many ? "cluster" : (item.kind || "reading");
    const x0 = cluster.x0, width = Math.max(2, cluster.x1 - cluster.x0);
    const cx = cluster.center;

    // the span. A candidate is pencil: hairline, dashed, quiet. On e-ink a
    // faded dash dithers, so calm mode trades opacity for FORM at full
    // contrast — the grayscale rule doing the work it was written for.
    const band = document.createElementNS(SVGNS, "rect");
    band.setAttribute("x", x0);
    band.setAttribute("y", 12);
    band.setAttribute("width", width);
    band.setAttribute("height", Math.max(1, h - 34));
    band.setAttribute("fill", candidate ? "none" : "var(--vellum)");
    band.setAttribute("fill-opacity", candidate ? "0" : "0.42");
    band.setAttribute("stroke", candidate ? "var(--slate)" : "var(--ink)");
    band.setAttribute("stroke-width", candidate && !this._calm ? "1" : "1.2");
    band.setAttribute("stroke-dasharray", candidate ? "2 5" : "4 3");
    band.setAttribute("stroke-opacity", candidate && !this._calm ? "0.55" : "1");
    band.setAttribute("pointer-events", "none");
    band.classList.add(candidate ? "z-candidate" : "z-reading");
    this.svg.appendChild(band);

    const label = many
      ? `${cluster.entries.length} here — open to separate them`
      : (item.reason || "a kept reading");

    const g = document.createElementNS(SVGNS, "g");
    g.classList.add("z-tab");
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", label);

    const hit = document.createElementNS(SVGNS, "rect");
    hit.setAttribute("x", cx - 22);
    hit.setAttribute("y", 4);
    hit.setAttribute("width", 44);
    hit.setAttribute("height", 44);
    hit.setAttribute("fill", "transparent");
    g.appendChild(hit);

    const seat = document.createElementNS(SVGNS, "rect");
    seat.setAttribute("x", cx - 8);
    seat.setAttribute("y", 14);
    seat.setAttribute("width", 16);
    seat.setAttribute("height", 15);
    seat.setAttribute("rx", "2");
    seat.setAttribute("fill", "var(--bone)");
    seat.setAttribute("stroke", candidate ? "var(--slate)" : "var(--ink)");
    seat.setAttribute("stroke-width", candidate ? "1" : "1.4");
    if (candidate) seat.setAttribute("stroke-dasharray", "2 2");
    g.appendChild(seat);
    if (many) {   // a stack reads as more-than-one before you read the number
      const back = document.createElementNS(SVGNS, "rect");
      back.setAttribute("x", cx - 5); back.setAttribute("y", 11);
      back.setAttribute("width", 16); back.setAttribute("height", 15);
      back.setAttribute("rx", "2");
      back.setAttribute("fill", "none");
      back.setAttribute("stroke", candidate ? "var(--slate)" : "var(--ink)");
      back.setAttribute("stroke-width", "1");
      g.insertBefore(back, seat);
    }

    const glyph = document.createElementNS(SVGNS, "text");
    glyph.setAttribute("x", cx);
    glyph.setAttribute("y", 26);
    glyph.setAttribute("text-anchor", "middle");
    glyph.setAttribute("font-size", many ? "10" : "11");
    glyph.setAttribute("fill", "var(--ink)");
    glyph.textContent = many ? String(cluster.entries.length)
                             : (GLYPH[kind] || GLYPH.reading);
    g.appendChild(glyph);

    const commit = () => {
      // a cluster is NEVER silently resolved to one of its members
      if (many) return this.focusRange(cluster.from, cluster.to);
      if (candidate) this.onSummon(item);
      else this.onDescend(item);
    };
    // Touch and pen preview, then commit — the house grammar, and the reason
    // a stuck hover hint was wrong here. A mouse descends immediately.
    // preventDefault on pointerdown does NOT reliably suppress the follow-up
    // click on iOS, so a committed second tap would fire commit() twice
    // (jump, then jump again). This flag is the gate.
    let touchDriven = false;
    g.addEventListener("pointerdown", (e) => {
      e.stopPropagation();          // never fall through to a track scrub
      if (e.pointerType === "mouse") return;
      e.preventDefault();
      touchDriven = true;
      if (this._armed === cluster.center) {
        this._armed = null;
        this.hint(null);
        commit();
      } else {
        this._armed = cluster.center;
        this.hint(cx, label);
        clearTimeout(this._armTimer);
        this._armTimer = setTimeout(() => {
          this._armed = null; this.hint(null);
        }, 3000);
      }
    });
    g.addEventListener("click", (e) => {
      e.stopPropagation(); e.preventDefault();
      if (touchDriven) { touchDriven = false; return; }  // touch owns it
      commit();
    });
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); e.stopPropagation(); commit();
      }
    });
    // hover is a MOUSE affordance only: on touch, pointerenter fires on tap
    // and the hint has nothing to dismiss it, so it stuck on the phone
    g.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") this.hint(cx, label);
    });
    g.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") this.hint(null);
    });
    this.svg.appendChild(g);
  }

  /** The reason, in words, on hover — clamped inside the track. */
  hint(cx, text) {
    const el = this.wave.box.querySelector(".z-hint")
      || (() => {
        const d = document.createElement("div");
        d.className = "z-hint mono";
        this.wave.box.appendChild(d);
        return d;
      })();
    if (cx === null) { el.hidden = true; return; }
    el.textContent = text;
    el.hidden = false;
    const w = this.wave.box.clientWidth;
    const half = el.offsetWidth / 2;
    el.style.left = `${Math.max(half + 4, Math.min(w - half - 4, cx))}px`;
  }
}
