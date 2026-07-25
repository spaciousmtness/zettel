// A quiet, persistent chronology beside the conversation. Calendar time runs
// top to bottom; activity crosses the spine (them left, me right), while
// authored marks and marginalia sit on the same coordinates. The horizontal
// relationship map remains the wide atlas; this is the everyday reading hand.

const DAY = 86400;

export class ChronologyRail {
  constructor(container, { onJump, onHover } = {}) {
    this.el = container;
    this.track = container.querySelector("#chronology-track");
    this.canvas = container.querySelector("#chronology-canvas");
    this.marks = container.querySelector("#chronology-marks");
    this.position = container.querySelector("#chronology-position");
    this.preview = container.querySelector("#chronology-preview");
    this.back = container.querySelector("#chronology-back");
    this.onJump = onJump || (() => {});
    this.onHover = onHover || (() => {});
    this.days = [];
    this.dayTimes = [];
    this.markers = [];
    this.chapters = [];
    this.notes = [];
    this.people = { me: "ME", them: "THEM" };
    this.f0 = 0;
    this.f1 = 1;
    this.currentTs = null;
    this.previewTs = null;
    this.backTs = null;
    this.dragging = null;

    this.track.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button") || event.button > 0) return;
      event.preventDefault();
      this.dragging = event.pointerId;
      this.track.classList.add("is-scrubbing");
      try { this.track.setPointerCapture(event.pointerId); } catch (error) { /* lifted */ }
      this.previewAt(event.clientY);
    });
    this.track.addEventListener("pointermove", (event) => {
      if (this.dragging === event.pointerId ||
          (!this.dragging && event.pointerType === "mouse")) {
        this.previewAt(event.clientY);
      }
    });
    this.track.addEventListener("pointerup", (event) => {
      if (this.dragging !== event.pointerId) return;
      this.previewAt(event.clientY);
      const ts = this.previewTs;
      this.dragging = null;
      this.track.classList.remove("is-scrubbing");
      if (Number.isFinite(ts)) this.commit(ts);
      this.hidePreview();
    });
    this.track.addEventListener("pointercancel", (event) => {
      if (this.dragging !== event.pointerId) return;
      this.dragging = null;
      this.track.classList.remove("is-scrubbing");
      this.hidePreview();
      this.setPosition(this.currentTs);
    });
    this.track.addEventListener("pointerleave", () => {
      if (this.dragging === null) this.hidePreview();
    });
    this.track.addEventListener("keydown", (event) => this.keydown(event));
    this.back.addEventListener("click", () => {
      if (!Number.isFinite(this.backTs)) return;
      const destination = this.backTs;
      this.backTs = this.currentTs;
      this.updateBack();
      this.currentTs = destination;
      this.setPosition(destination);
      this.onJump(destination, null);
    });

    new ResizeObserver(() => this.draw()).observe(this.track);
  }

  reset() {
    this.days = [];
    this.dayTimes = [];
    this.markers = [];
    this.chapters = [];
    this.notes = [];
    this.currentTs = null;
    this.previewTs = null;
    this.backTs = null;
    this.position.hidden = true;
    this.marks.textContent = "";
    this.hidePreview();
    this.updateBack();
    this.draw();
  }

  setParticipants(me, them) {
    this.people = { me: me || "ME", them: them || "THEM" };
    this.renderLandmarks();
  }

  setData(days, markers = [], chapters = [], notes = []) {
    this.days = Array.isArray(days) ? days : [];
    this.dayTimes = this.days.map((day) =>
      Date.parse(`${day.day}T12:00:00`) / 1000);
    this.markers = Array.isArray(markers) ? markers : [];
    this.chapters = Array.isArray(chapters) ? chapters : [];
    this.notes = Array.isArray(notes) ? notes : [];
    if (this.days.length) {
      this.f0 = Date.parse(`${this.days[0].day}T00:00:00`) / 1000;
      this.f1 = Math.max(
        Date.parse(`${this.days[this.days.length - 1].day}T23:59:59`) / 1000,
        this.f0 + DAY);
      this.track.setAttribute("aria-valuemin", String(Math.round(this.f0)));
      this.track.setAttribute("aria-valuemax", String(Math.round(this.f1)));
    }
    this.draw();
  }

  y(ts) {
    const height = this.track.clientHeight;
    const pad = 16;
    const span = this.f1 - this.f0;
    if (!height || !Number.isFinite(span) || span <= 0) return pad;
    const fraction = Math.max(0, Math.min(1, (ts - this.f0) / span));
    return pad + fraction * Math.max(1, height - pad * 2);
  }

  ts(y) {
    const height = this.track.clientHeight;
    const pad = 16;
    const usable = Math.max(1, height - pad * 2);
    const fraction = Math.max(0, Math.min(1, (y - pad) / usable));
    return this.f0 + fraction * (this.f1 - this.f0);
  }

  lineX() {
    return Math.min(29, Math.max(20, this.track.clientWidth * 0.38));
  }

  draw() {
    const width = this.track.clientWidth;
    const height = this.track.clientHeight;
    if (!width || !height) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    const context = this.canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!this.days.length) return;

    const styles = getComputedStyle(document.documentElement);
    const color = (name, fallback) =>
      styles.getPropertyValue(name).trim() || fallback;
    const hairline = color("--hairline", "#cfc8b8");
    const graphite = color("--graphite", "#4d4a43");
    const slate = color("--slate", "#777168");
    const x = this.lineX();
    this.position.style.left = "4px";
    this.position.style.width = `${Math.max(20, x - 2)}px`;

    context.strokeStyle = hairline;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x + 0.5, 12);
    context.lineTo(x + 0.5, height - 12);
    context.stroke();

    // One tick per visual cell, not one DOM/canvas stroke per active day.
    // A long, lively relationship otherwise becomes a solid barcode. The
    // bucket still preserves the two-sided volume within each era.
    const tickStep = 9;
    const buckets = new Map();
    for (let index = 0; index < this.days.length; index++) {
      const yy = this.y(this.dayTimes[index]);
      const cell = Math.round(yy / tickStep);
      const bucket = buckets.get(cell) || { me: 0, them: 0 };
      bucket.me += Number(this.days[index].me || 0);
      bucket.them += Number(this.days[index].them || 0);
      buckets.set(cell, bucket);
    }
    let max = 1;
    for (const bucket of buckets.values()) {
      max = Math.max(max, bucket.me + bucket.them);
    }
    const scale = Math.log1p(max);
    context.lineCap = "round";
    for (const [cell, bucket] of buckets) {
      const me = bucket.me;
      const them = bucket.them;
      const total = me + them;
      if (!total) continue;
      const volume = Math.log1p(total) / scale;
      const reach = 4 + volume * Math.min(17, width * 0.26);
      const left = reach * (them / total);
      const right = reach * (me / total);
      const yy = cell * tickStep;
      context.strokeStyle = graphite;
      context.globalAlpha = 0.24 + volume * 0.46;
      context.lineWidth = total > max * 0.45 ? 1.5 : 1;
      context.beginPath();
      context.moveTo(x - Math.max(2, left), yy + 0.5);
      context.lineTo(x + Math.max(2, right), yy + 0.5);
      context.stroke();
    }
    context.globalAlpha = 1;

    const startYear = new Date(this.f0 * 1000).getFullYear();
    const endYear = new Date(this.f1 * 1000).getFullYear();
    const labelEvery = endYear - startYear > 9 ? 2 : 1;
    context.font = "9px ui-monospace, Menlo, monospace";
    context.fillStyle = slate;
    context.strokeStyle = slate;
    context.lineWidth = 1;
    for (let year = startYear; year <= endYear; year++) {
      const boundary = year === startYear || year === endYear;
      const ts = year === startYear ? this.f0
        : year === endYear ? this.f1
          : new Date(year, 0, 1).getTime() / 1000;
      const yy = this.y(ts);
      context.beginPath();
      context.moveTo(x - 8, yy + 0.5);
      context.lineTo(x + 8, yy + 0.5);
      context.stroke();
      if (width >= 66 &&
          (boundary || (year - startYear) % labelEvery === 0)) {
        context.fillText(String(year), x + 24, yy + 3);
      }
    }
    this.renderLandmarks();
    this.setPosition(this.currentTs);
  }

  landmarks() {
    const out = [];
    for (const marker of this.markers) {
      const ts = Number(marker.date_unix);
      if (!Number.isFinite(ts)) continue;
      out.push({
        ts, kind: "mark", rowid: marker.rowid,
        label: marker.emoji || "mark", preview: marker.preview || "",
        person: marker.from_me ? this.people.me : this.people.them,
        live: marker.state !== "settled" && marker.state !== "answered",
      });
    }
    for (const note of this.notes) {
      const ts = Number(note.date_unix);
      if (!Number.isFinite(ts)) continue;
      out.push({
        ts, kind: "note", rowid: note.rowid,
        label: note.peer ? (note.name || this.people.them) : this.people.me,
        preview: note.text || note.preview || "",
        person: note.peer ? (note.name || this.people.them) : this.people.me,
        shared: note.peer,
      });
    }
    for (const chapter of this.chapters) {
      const ts = Number(chapter.ts);
      if (!Number.isFinite(ts)) continue;
      out.push({
        ts, kind: "chapter", rowid: null, label: "chapter",
        preview: chapter.title || "",
      });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  renderLandmarks() {
    this.marks.textContent = "";
    if (!this.days.length) return;
    const cells = new Map();
    for (const item of this.landmarks()) {
      if (item.ts < this.f0 || item.ts > this.f1) continue;
      const yy = this.y(item.ts);
      const cell = Math.round(yy / 44);
      const cluster = cells.get(cell) || { items: [], y: yy };
      cluster.items.push(item);
      cluster.y = cluster.items.reduce((sum, entry) => sum + this.y(entry.ts), 0) /
        cluster.items.length;
      cells.set(cell, cluster);
    }
    for (const cluster of cells.values()) {
      const preferred = cluster.items.find((item) => item.live) ||
        cluster.items.find((item) => item.kind === "mark") ||
        cluster.items.find((item) => item.kind === "note") || cluster.items[0];
      const button = document.createElement("button");
      button.type = "button";
      button.className = `chronology-landmark chronology-${preferred.kind}` +
        (preferred.live ? " is-live" : "") +
        (preferred.shared ? " is-shared" : "");
      button.style.top = `${Math.max(0, Math.min(
        this.track.clientHeight - 44, cluster.y - 22))}px`;
      button.style.left = `${Math.max(0, this.lineX() - 22)}px`;
      const face = document.createElement("span");
      face.className = "chronology-face mono";
      face.textContent = preferred.kind === "chapter" ? "\u00a7"
        : preferred.kind === "note" ? "\u270e" : preferred.person;
      button.append(face);
      if (cluster.items.length > 1) {
        const count = document.createElement("span");
        count.className = "chronology-count mono";
        count.textContent = String(cluster.items.length);
        button.append(count);
      }
      const date = this.dateLabel(preferred.ts);
      button.setAttribute("aria-label",
        `${cluster.items.length > 1 ? `${cluster.items.length} annotations` : preferred.label} at ${date}`);
      button.title = preferred.preview
        ? `${date} - ${preferred.preview.slice(0, 100)}` : date;
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("pointerenter", () => {
        this.showPreview(preferred.ts, cluster.items, cluster.y);
        this.onHover(preferred.rowid ?? null);
      });
      button.addEventListener("pointerleave", () => {
        if (this.dragging === null) this.hidePreview();
        this.onHover(null);
      });
      button.addEventListener("focus", () =>
        this.showPreview(preferred.ts, cluster.items, cluster.y));
      button.addEventListener("blur", () => this.hidePreview());
      button.addEventListener("click", () =>
        this.commit(preferred.ts, preferred.rowid ?? null));
      this.marks.append(button);
    }
  }

  nearestActivity(ts) {
    if (!this.dayTimes.length) return null;
    let low = 0;
    let high = this.dayTimes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.dayTimes[middle] < ts) low = middle + 1;
      else high = middle;
    }
    const candidates = [low - 1, low]
      .filter((index) => index >= 0 && index < this.dayTimes.length);
    let best = candidates[0];
    for (const index of candidates) {
      if (Math.abs(this.dayTimes[index] - ts) <
          Math.abs(this.dayTimes[best] - ts)) best = index;
    }
    if (best === undefined) return null;
    return {
      day: this.days[best],
      distance: Math.abs(this.dayTimes[best] - ts) / DAY,
    };
  }

  nearbyLandmarks(ts) {
    const threshold = Math.max(DAY * 2,
      (this.f1 - this.f0) * (24 / Math.max(1, this.track.clientHeight)));
    return this.landmarks()
      .map((item) => ({ ...item, distance: Math.abs(item.ts - ts) }))
      .filter((item) => item.distance <= threshold)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 4);
  }

  previewAt(clientY) {
    if (!this.days.length) return;
    const rect = this.track.getBoundingClientRect();
    const yy = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const ts = this.ts(yy);
    this.previewTs = ts;
    this.position.hidden = false;
    this.position.style.top = `${this.y(ts)}px`;
    this.showPreview(ts, this.nearbyLandmarks(ts), this.y(ts));
  }

  showPreview(ts, items = [], yy = this.y(ts)) {
    this.previewTs = ts;
    this.preview.textContent = "";
    const date = document.createElement("strong");
    date.textContent = this.dateLabel(ts);
    const activity = document.createElement("span");
    activity.className = "mono chronology-preview-meta";
    const nearest = this.nearestActivity(ts);
    if (!nearest || nearest.distance > 4) {
      activity.textContent = "quiet stretch";
    } else {
      const me = Number(nearest.day.me || 0);
      const them = Number(nearest.day.them || 0);
      const total = me + them;
      activity.textContent = `${total.toLocaleString()} ${total === 1 ? "message" : "messages"}` +
        ` - ${me.toLocaleString()} me / ${them.toLocaleString()} them`;
    }
    this.preview.append(date, activity);
    if (items.length) {
      const item = items[0];
      const reading = document.createElement("span");
      reading.className = "chronology-preview-reading";
      const author = item.kind === "mark" ? `${item.person || "moment"} ${item.label}`
        : item.kind === "note" ? `${item.person || "margin"} wrote`
          : "chapter";
      reading.textContent = item.preview
        ? `${author} - ${item.preview.slice(0, 120)}` : author;
      this.preview.append(reading);
      if (items.length > 1) {
        const more = document.createElement("span");
        more.className = "mono chronology-preview-more";
        more.textContent = `+${items.length - 1} nearby`;
        this.preview.append(more);
      }
    }
    this.preview.hidden = false;
    const height = this.preview.offsetHeight;
    const top = Math.max(8, Math.min(yy - height / 2,
      this.track.clientHeight - height - 8));
    this.preview.style.top = `${top}px`;
    this.track.setAttribute("aria-valuetext", this.dateLabel(ts));
  }

  hidePreview() {
    this.preview.hidden = true;
    this.previewTs = null;
    this.onHover(null);
    this.setPosition(this.currentTs);
  }

  setPosition(ts) {
    this.currentTs = Number.isFinite(ts) ? ts : null;
    const visible = Number.isFinite(this.currentTs) && this.days.length;
    if (Number.isFinite(this.previewTs)) return;
    this.position.hidden = !visible;
    if (!visible) return;
    this.position.style.top = `${this.y(this.currentTs)}px`;
    this.track.setAttribute("aria-valuenow", String(Math.round(this.currentTs)));
    this.track.setAttribute("aria-valuetext", this.dateLabel(this.currentTs));
  }

  commit(ts, rowid = null) {
    if (!Number.isFinite(ts)) return;
    if (Number.isFinite(this.currentTs) && Math.abs(this.currentTs - ts) > 1) {
      this.backTs = this.currentTs;
      this.updateBack();
    }
    this.currentTs = ts;
    this.setPosition(ts);
    this.onJump(ts, rowid);
  }

  updateBack() {
    const enabled = Number.isFinite(this.backTs);
    this.back.disabled = !enabled;
    this.back.hidden = !enabled;
    this.back.title = enabled
      ? `back to ${this.dateLabel(this.backTs)}` : "back to the previous place";
  }

  keydown(event) {
    if (!this.days.length) return;
    const start = Number.isFinite(this.previewTs) ? this.previewTs
      : Number.isFinite(this.currentTs) ? this.currentTs : this.f1;
    const small = Math.max(DAY, (this.f1 - this.f0) / 100);
    const large = Math.max(DAY * 7, (this.f1 - this.f0) / 10);
    let next = null;
    if (event.key === "ArrowUp") next = start - small;
    if (event.key === "ArrowDown") next = start + small;
    if (event.key === "PageUp") next = start - large;
    if (event.key === "PageDown") next = start + large;
    if (event.key === "Home") next = this.f0;
    if (event.key === "End") next = this.f1;
    if (event.key === "Enter" && Number.isFinite(this.previewTs)) {
      event.preventDefault();
      event.stopPropagation();
      this.commit(this.previewTs);
      this.hidePreview();
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      this.hidePreview();
      this.setPosition(this.currentTs);
      return;
    }
    if (!Number.isFinite(next)) return;
    event.preventDefault();
    // the document handler saw the same key: ArrowDown moved the rail AND
    // the stream selection, and Home refetched the earliest message —
    // exactly the jump-to-the-beginning behaviour that was asked to stop
    event.stopPropagation();
    next = Math.max(this.f0, Math.min(this.f1, next));
    this.previewTs = next;
    this.position.hidden = false;
    this.position.style.top = `${this.y(next)}px`;
    this.showPreview(next, this.nearbyLandmarks(next));
  }

  dateLabel(ts) {
    return new Date(ts * 1000).toLocaleDateString([], {
      year: "numeric", month: "short", day: "numeric",
    });
  }
}
