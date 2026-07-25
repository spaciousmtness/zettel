// Wavelength · ambient split-flap board (board.html).
// Rotates between the Wrapped stats dispatch and "on this day" echoes.
// Between dispatches each changed cell spins its character drum — cycling
// through intermediate glyphs like a real Vestaboard — so distance traveled,
// not a random number, decides when each tile lands. Calm/e-ink and
// reduced-motion skip the drum and re-render with the stepped fade.

const COLS = 22;
const ROWS = 6;
// The drum order every cell spins through. Must contain every character
// boardLine() can emit, or a spin would never terminate.
const DRUM = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:/+->";
const HOLD_MS = 20000;      // how long each dispatch stays up
const STEP_MS = 62;         // base drum step; each cell jitters around this
const POLL_MS = 5000;       // live-edge cadence, same as the timeline's
const ARRIVAL_HOLD_MS = 30000; // a landed message outstays a stat

const params = new URLSearchParams(location.search);
if (params.get("calm") === "1") document.body.classList.add("calm", "amber");
// A shelf display shows its dispatches to anyone in the room. ?quiet=1
// keeps arrivals to sender + count — the fact of a message, never its text.
const quiet = params.get("quiet") === "1";
const reducedMotion =
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const gentle = () => reducedMotion || document.body.classList.contains("calm");

const boardEl = document.getElementById("board");
const captionEl = document.getElementById("caption");

function boardLine(value) {
  const clean = String(value || "").normalize("NFKD")
    .replace(/[^ A-Za-z0-9>.:/+-]/g, "")
    .replace(/\s+/g, " ").trim()
    .toUpperCase().slice(0, COLS);
  const left = Math.floor((COLS - clean.length) / 2);
  return `${" ".repeat(left)}${clean}`.padEnd(COLS, " ");
}

// word-wrap a preview into at most `max` board lines
function wrapText(text, max) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length <= COLS) {
      line = (line + " " + word).trim();
    } else {
      if (line) lines.push(line);
      line = word.slice(0, COLS);
      if (lines.length === max) break;
    }
  }
  if (line && lines.length < max) lines.push(line);
  if (lines.length === max && words.join(" ").length > lines.join(" ").length)
    lines[max - 1] = lines[max - 1].slice(0, COLS - 1) + ">";
  return lines;
}

function statsDispatch(data) {
  const a = data.alltime;
  const years = data.years || [];
  const days = years.reduce((s, p) => s + Number(p.days_talked || 0), 0);
  const n = (v) => Number(v || 0).toLocaleString("en-US");
  return {
    caption: "the whole wavelength",
    lines: [
      "WAVELENGTH WRAPPED",
      `${String(a.first_day || "").slice(0, 4)} > ${String(a.last_day || "").slice(0, 4)}`,
      `${n(a.total)} MESSAGES`,
      `${n(days)} DAYS IN TOUCH`,
      `${n(a.longest_streak)} DAY STREAK`,
      `${n(a.marks)} MARKS KEPT`,
    ],
  };
}

function echoDispatches(years) {
  const out = [];
  for (const year of (years || []).slice(0, 4)) {
    const sample = (year.sample || [])[0];
    if (!sample) continue;
    const body = wrapText(sample.preview, 3);
    while (body.length < 3) body.push("");
    out.push({
      caption: `on this day · ${year.year}`,
      lines: [
        "ON THIS DAY",
        `${year.year} - ${year.count} MESSAGE${year.count === 1 ? "" : "S"}`,
        ...body,
        sample.marked ? "A KEPT MOMENT" : (sample.from_me ? "YOU SAID" : "THEY SAID"),
      ],
    });
  }
  return out;
}

// ---- rendering ----------------------------------------------------------

function renderBoard(lines, { riffle } = {}) {
  boardEl.textContent = "";
  lines.forEach((line, r) => {
    const row = document.createElement("div");
    row.className = "wrapped-board-row";
    [...boardLine(line)].forEach((character, c) => {
      const flap = document.createElement("span");
      flap.className = "wrapped-flap" + (character === ">" ? " is-accent" : "");
      flap.textContent = character === " " ? " " : character;
      flap.setAttribute("aria-hidden", "true");
      if (riffle && !gentle()) {
        flap.style.setProperty("--flap-delay",
          `${Math.round((r + c) * 34 + Math.random() * 130)}ms`);
        flap.style.setProperty("--flap-dur",
          `${Math.round(300 + Math.random() * 160)}ms`);
      } else {
        flap.style.setProperty("--flap-delay", `${(r * COLS + c) % 44 * 9}ms`);
      }
      row.append(flap);
    });
    boardEl.append(row);
  });
}

// The drum engine. One clock drives every spinning cell: each cell's step
// count is distance along DRUM (like the real machine), but progress is
// computed from elapsed time, not counted ticks — so when a webview or
// background tab throttles timers, cells snap forward to where they should
// be instead of crawling. Cells that finish stop; the engine stops last.
let spinEngine = null;

function transitionTo(lines) {
  if (gentle()) { renderBoard(lines, { riffle: false }); return; }
  const flaps = boardEl.querySelectorAll(".wrapped-flap");
  if (flaps.length !== ROWS * COLS) { renderBoard(lines, { riffle: true }); return; }
  const now = performance.now();
  const cells = [];
  lines.forEach((line, r) => {
    [...boardLine(line)].forEach((target, c) => {
      const flap = flaps[r * COLS + c];
      const shown = flap.textContent === "\u00a0" ? " " : flap.textContent;
      const from = Math.max(0, DRUM.indexOf(shown));
      const to = Math.max(0, DRUM.indexOf(target));
      const steps = (to - from + DRUM.length) % DRUM.length;
      if (!steps) return;
      cells.push({
        flap, from, steps, shownStep: 0,
        start: now + Math.random() * 220,          // desync between cells
        stepDur: STEP_MS + Math.random() * 26,     // slightly uneven drums
      });
    });
  });
  if (spinEngine) clearInterval(spinEngine);
  if (!cells.length) return;
  spinEngine = setInterval(() => {
    const t = performance.now();
    let live = 0;
    for (const cell of cells) {
      if (cell.shownStep >= cell.steps) continue;
      const due = Math.min(cell.steps,
        Math.max(0, Math.floor((t - cell.start) / cell.stepDur)));
      if (due <= cell.shownStep) { live += 1; continue; }
      cell.shownStep = due;
      const glyph = DRUM[(cell.from + due) % DRUM.length];
      cell.flap.textContent = glyph === " " ? "\u00a0" : glyph;
      cell.flap.classList.toggle("is-accent", glyph === ">");
      cell.flap.style.setProperty("--step-dur", `${Math.round(cell.stepDur)}ms`);
      cell.flap.classList.remove("stepping");
      void cell.flap.offsetWidth;                  // restart the step flip
      cell.flap.classList.add("stepping");
      if (due < cell.steps) live += 1;
    }
    if (!live) { clearInterval(spinEngine); spinEngine = null; }
  }, 40);
}

// ---- arrivals -----------------------------------------------------------

// The board's reason to exist on a shelf: it flips when something new
// lands. Same 5s live-edge poll as the timeline (imports never move, so
// tg:/sg: threads don't poll). from_me rows advance the cursor silently;
// only the other side's ink interrupts the rotation.

function arrivalDispatch(incoming, senderName) {
  const latest = incoming[incoming.length - 1];
  const count = incoming.length;
  const when = new Date((latest.date_unix || 0) * 1000);
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  const head = count === 1 ? "A NEW MESSAGE" : `${count} NEW MESSAGES`;
  if (quiet) {
    return {
      caption: "just landed",
      lines: ["JUST LANDED", head, `FROM ${senderName}`, "", "", `${hh}:${mm}`],
    };
  }
  const body = wrapText(latest.text, 3);
  while (body.length < 3) body.push("");
  return {
    caption: "just landed",
    lines: [head, `FROM ${senderName}`, ...body, `${hh}:${mm}`],
  };
}

// ---- boot ---------------------------------------------------------------

async function boot() {
  let chat = params.get("chat") || "";
  let title = chat;
  let aliases = {};
  try {
    const { threads } = await (await fetch("/api/chats")).json();
    if (!chat && threads && threads.length) chat = threads[0].identifier;
    const hit = (threads || []).find((t) =>
      t.identifier === chat || (t.identifiers || []).includes(chat));
    if (hit) title = hit.display_name || hit.identifier;
  } catch { /* board still works with an explicit ?chat= */ }
  if (!chat) { captionEl.textContent = "no conversation found"; return; }
  try {
    const health = await (await fetch("/api/health")).json();
    aliases = (health.config || {}).aliases || {};
  } catch { /* raw handles are honest, just plainer */ }

  const q = encodeURIComponent(chat);
  // quiet boards never show message text — the on-this-day echoes quote
  // real history, so quiet skips them entirely and rests on the stats
  const [wrapped, otd] = await Promise.all([
    (await fetch(`/api/wrapped?chat=${q}&bucket=year`)).json(),
    quiet ? { years: [] } : (await fetch(`/api/onthisday?chat=${q}`)).json(),
  ]);

  const dispatches = [statsDispatch(wrapped), ...echoDispatches(otd.years)];
  if (!dispatches.length) { captionEl.textContent = "a quiet wire"; return; }

  let index = 0;
  let rotateTimer = null;
  const showNext = () => {
    const d = dispatches[index % dispatches.length];
    captionEl.textContent = `${title} · ${d.caption}`;
    transitionTo(d.lines);
    index += 1;
    if (dispatches.length > 1) rotateTimer = setTimeout(showNext, HOLD_MS);
  };
  const first = dispatches[0];
  captionEl.textContent = `${title} · ${first.caption}`;
  renderBoard(first.lines, { riffle: true });
  index = 1;
  if (dispatches.length > 1) rotateTimer = setTimeout(showNext, HOLD_MS);

  // live edge — iMessage/SMS only, matching the timeline's poll
  if (chat.startsWith("tg:") || chat.startsWith("sg:")) return;
  let cursor = null;
  try {
    // no-store: a cached cursor is a stale live edge (old servers may not
    // send Cache-Control on API answers)
    const page = await (await fetch(`/api/messages?chat=${q}&limit=1`,
      { cache: "no-store" })).json();
    cursor = page.cursor_newer;
  } catch { /* no edge, no poll */ }
  if (!cursor) return;

  let polling = false;
  async function pollArrivals() {
    if (polling) return;
    polling = true;
    try {
      const data = await (await fetch(
        `/api/messages?chat=${q}&after=${cursor.join(",")}&limit=12`,
        { cache: "no-store" })).json();
      if (!data.messages || !data.messages.length) return;
      if (data.cursor_newer) cursor = data.cursor_newer;
      const incoming = data.messages.filter((m) => !m.from_me);
      if (!incoming.length) return;
      const sender = aliases[incoming[incoming.length - 1].handle] || title;
      const d = arrivalDispatch(incoming, sender);
      clearTimeout(rotateTimer);
      // re-arm before the transition so a render fault can't kill rotation
      rotateTimer = setTimeout(showNext, ARRIVAL_HOLD_MS);
      captionEl.textContent = `${title} · ${d.caption}`;
      transitionTo(d.lines);
    } catch {
      // arrival polling is atmosphere; the next tick retries
    } finally {
      polling = false;
    }
  }
  setInterval(() => { if (!document.hidden) pollArrivals(); }, POLL_MS);
  // deterministic hooks for headless verification (house pattern:
  // __timeline/__waveform/__wrapped) — the preview webview reports
  // document.hidden=true, so the interval alone is untestable there
  window.__board = { poll: pollArrivals, cursor: () => cursor };
}

boot();
