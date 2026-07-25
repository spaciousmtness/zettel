import { Timeline, MARKS, copyText, inkFp } from "./timeline.js";
import { ChronologyRail } from "./chronology.js";
import { Waveform } from "./waveform.js";
import { ZLayer } from "./zlayer.js";
import { MARK_DIALECT, TAPBACK_GLYPHS, markGlyph, armCrossing, armTwoTap,
         installApiSecurity, safeHttpUrl } from "./shared.js";
import { scan as scanResonance, describe as describeSpan } from "./resonance.js";

const $ = (id) => document.getElementById(id);

// Where are we standing? On the desk this is a private loopback/LAN/Tailscale
// host; on a judge's phone it is a public URL. Several strings are only true
// in one of those places, so they ask.
const ON_A_PRIVATE_HOST =
  /^(localhost|127\.|\[::1\]|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
    .test(location.hostname)
  || location.hostname.endsWith(".local")
  || location.hostname.endsWith(".ts.net");

const state = {
  chat: null,
  aliases: {},
  markers: [],
  markerIdx: -1,
  facet: null,          // "pins" | "links" | "media" | "threads" | "search"
  facetCursor: null,
  searchQuery: "",
  playing: null,        // interval id while playing
  gotoYear: new Date().getFullYear(),
  rangeDays: null,      // null = the whole conversation track
  density: [],
  summons: [],
  threadEpoch: 0,
};

// calm mode: the DC-1 evening register — amber, bigger serif, no hover
// dependencies, no keyboard chrome. Everything else is the same tool.
const CALM = new URLSearchParams(location.search).has("calm") ||
             localStorage.getItem("wl-calm") === "1";
if (CALM) {
  document.body.classList.add("amber", "calm");
  localStorage.setItem("wl-calm", "1");
}
function syncHandle(mode = "idle") {
  const label = $("handle-label"), meta = $("handle-meta");
  if (mode === "playing") {
    label.textContent = "▮▮ moving through the conversation";
    meta.textContent = "space to pause";
    return;
  }
  label.textContent = "▴ relationship map";
  const bits = [];
  if (state.markers.length) bits.push(
    `${state.markers.length} mark${state.markers.length === 1 ? "" : "s"}`);
  bits.push(document.body.classList.contains("calm")
    ? "tap to open"
    : "z lift the sheet · j/k move · n/p marks · g date · space play");
  meta.textContent = bits.join(" · ");
}
syncHandle();

let arrivalTimer = null;
function celebrateArrival(messages) {
  const last = messages[messages.length - 1];
  if (!last) return;
  const normalized = messages.map((message) =>
    message.service === "imessage" ? "imessage"
      : message.service === "rcs" ? "rcs" : "sms");
  const transports = new Set(normalized);
  const service = transports.size === 1 ? normalized[0] : "mixed";
  const channel = service === "imessage" ? "iMessage"
    : service === "rcs" ? "RCS" : service === "sms" ? "SMS" : "message";
  const handles = new Set(messages.map((message) => message.handle).filter(Boolean));
  const who = handles.size === 1
    ? state.aliases[last.handle] || last.handle
    : $("thread-name").textContent || "the conversation";
  const signal = $("arrival-signal");
  const count = messages.length;
  signal.textContent = count === 1
    ? `new ${channel} · ${who}`
    : service === "mixed"
      ? `${count} new messages · ${who}`
      : `${count} new ${channel} messages · ${who}`;
  signal.className = `arrival-signal mono ${service} showing`;
  signal.hidden = false;
  clearTimeout(arrivalTimer);
  arrivalTimer = setTimeout(() => {
    signal.hidden = true;
    signal.classList.remove("showing");
  }, 4200);
}

const timeline = new Timeline($("timeline"), {
  onSelect(m) {
    state.markerIdx = nearestMarkerIdx(m.date_unix);
  },
  async onNoteChange() {
    const chat = state.chat;
    const q = encodeURIComponent(chat);
    const { notes } = await (await fetch(`/api/notes?chat=${q}`)).json();
    if (state.chat !== chat) return;
    state.notes = notes;
    syncMapData();
  },
  async onMarksChange() {
    const chat = state.chat;
    const q = encodeURIComponent(chat);
    const { markers } = await (await fetch(`/api/markers?chat=${q}&refresh=1`)).json();
    if (state.chat !== chat) return;
    state.markers = markers;
    refreshPinBadge();
    syncMapData();
    if (state.facet === "pins") renderLedger($("panel-body"));
  },
  onSummon(bounds) { openSummon(bounds); },
  onArrival(messages) { celebrateArrival(messages); },
});
window.__timeline = timeline;

const chronology = new ChronologyRail($("chronology"), {
  onJump: (ts, rowid) => {
    stopPlaying();
    timeline.jump(ts, rowid);
  },
  onHover: (rowid) => timeline.glow(rowid),
});
window.__chronology = chronology;

const waveform = new Waveform($("wave"), {
  onJump: (ts) => { stopPlaying(); timeline.jump(ts); },
  onMarker: (m) => { stopPlaying(); jumpToMarker(m); },
  onMarkHover: (m) => timeline.glow(m ? m.rowid : null),
  onViewChange: () => {
    state.rangeDays = null;
    for (const button of document.querySelectorAll("#track-ranges button")) {
      button.setAttribute("aria-pressed", "false");
    }
  },
});
window.__waveform = waveform;

// The Z layer: the sheet over the record. It borrows the waveform's
// coordinate map — it never builds its own.
const zlayer = new ZLayer(waveform, {
  // a kept reading: descend to the stretch it reads
  onDescend: (entry) => {
    stopPlaying();
    const ts = Number(entry?.anchor?.from_ts ?? entry?.anchor?.ts);
    if (Number.isFinite(ts)) timeline.jump(ts);
  },
  // a candidate: nothing has read it yet, so this is an OFFER, not a result.
  // Travel there and let her decide whether to summon.
  onSummon: (entry) => {
    stopPlaying();
    const ts = Number(entry?.anchor?.from_ts ?? entry?.anchor?.ts);
    if (Number.isFinite(ts)) timeline.jump(ts);
  },
  onInk: () => syncPen(),
});
window.__zlayer = zlayer;

// ---- worlds: step into one transport at a time -----------------------------------
// The picker groups every thread by transport; the worlds nav makes those
// groups a visible switch (not a buried dropdown) — tap Telegram, you're in
// Telegram. Only appears when more than one world has threads.

const WORLD_OF = (t) => {
  const id = String(t?.identifier || "");
  if (id.startsWith("tg:")) return "Telegram";
  if (id.startsWith("sg:")) return "Signal";
  return "iMessage / SMS";
};
// imported transports (Telegram, Signal) are read-only archives — the desk
// can only speak INTO iMessage (through Messages.app), so a send targeting
// one must never be offered. The move-elsewhere path redirects to iMessage.
const isImported = (id) =>
  String(id || "").startsWith("tg:") || String(id || "").startsWith("sg:");

function monogram(name) {
  const parts = String(name || "").match(/[A-Za-z]+|[0-9]+/g) || [];
  if (!parts.length) return "TH";
  if (parts.length === 1 && /^\d+$/.test(parts[0])) return parts[0].slice(-2);
  return parts.slice(0, 2).map((part) => part[0].toUpperCase()).join("");
}

function updateTrackMeta() {
  const t = state.thread;
  if (!t) return;
  const title = t.display_name || state.aliases[t.identifier] || t.identifier;
  const imported = isImported(t.identifier);
  const world = WORLD_OF(t);
  const first = state.density[0]?.day?.slice(0, 4);
  const last = state.density[state.density.length - 1]?.day?.slice(0, 4);
  const years = first && last ? (first === last ? first : `${first} to ${last}`) : "";
  const count = Number(t.count || 0).toLocaleString();

  $("track-title").textContent = title;
  // "private on this Mac" is TRUE on the desk and FALSE on a public URL, where
  // it also reads as though the demo were running on localhost. Say where you
  // actually are. ON_A_PRIVATE_HOST is computed at boot from the hostname.
  $("track-world").textContent = imported
    ? `${world} · read-only import`
    : ON_A_PRIVATE_HOST
      ? `${world} · private on this Mac`
      : `${world} · a synthetic archive · nothing leaves this page`;
  $("track-summary").textContent =
    `${count} message${t.count === 1 ? "" : "s"}` + (years ? ` · ${years}` : "");
  $("track-peer").textContent = monogram(title);
  waveform.setParticipants("ME", monogram(title));
  chronology.setParticipants("ME", monogram(title));
}

function syncCapabilities(identifier) {
  const imported = isImported(identifier);
  const unavailable = new Set(["pins", "links", "media", "wrapped"]);
  for (const button of document.querySelectorAll(".facet")) {
    button.hidden = imported && unavailable.has(button.dataset.facet);
  }
  $("search").hidden = imported;
  $("search").disabled = imported;
  $("export-btn").hidden = imported;
  if (imported && unavailable.has(state.facet)) closeFacet();
}

function selectTrackRange(days) {
  state.rangeDays = days;
  waveform.setWindow(days);
  for (const button of document.querySelectorAll("#track-ranges button")) {
    const selected = days === null
      ? button.dataset.range === "all"
      : Number(button.dataset.range) === days;
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
  updateTrackReadout(timeline.visibleDate());
}

for (const button of document.querySelectorAll("#track-ranges button")) {
  button.addEventListener("click", () => {
    const value = button.dataset.range;
    selectTrackRange(value === "all" ? null : Number(value));
  });
}

function syncIntelligenceOverlay() {
  const readings = state.summons || [];
  const candidates = state.candidates || [];
  const resonances = state.resonances || [];
  const total = readings.length + candidates.length + resonances.length;
  const button = $("track-z");
  // Absent, not inert. With nothing on the sheet there is no control to
  // press — the same honesty rule that makes the summon verb vanish rather
  // than answer 403.
  button.hidden = total === 0;
  if (total === 0) {
    zlayer.setCandidates([]);
    zlayer.setReadings([]);
    zlayer.setResonances([]);
    zlayer.setLift(0);
    // ...and the pen goes with it. Leaving through this branch skipped
    // syncPen(), so opening a thread WITH candidates, lifting the sheet,
    // then switching to a thread WITHOUT any left "✎ write" and "undo"
    // stranded on the rail — controls for a plane that is no longer there.
    button.setAttribute("aria-pressed", "false");
    $("z-count").textContent = "";
    syncPen();
    return;
  }
  zlayer.setReadings(readings);
  zlayer.setCandidates(candidates);
  zlayer.setResonances(resonances);
  if (typeof syncPen === "function") syncPen();
  const lifted = zlayer.lift > 0.5;
  button.setAttribute("aria-pressed", lifted ? "true" : "false");
  $("z-count").textContent = ` ${total}`;
}

function toggleZLayer() {
  zlayer.toggle();
  syncIntelligenceOverlay();
}

// The pen only exists while the sheet is up — you cannot write on a plane
// that isn't there, so the control is absent rather than inert.
function syncPen() {
  const up = zlayer.lift > 0.5;
  const pen = $("track-pen");
  const undo = $("track-undo");
  pen.hidden = !up;
  undo.hidden = !up || !zlayer.strokes.length;
  pen.setAttribute("aria-pressed", zlayer.writing ? "true" : "false");
  pen.textContent = zlayer.writing ? "✎ writing" : "✎ write";
}

$("track-z").addEventListener("click", () => { toggleZLayer(); syncPen(); });
$("track-pen").addEventListener("click", () => {
  zlayer.setWriting(!zlayer.writing);
  syncPen();
});
$("track-undo").addEventListener("click", () => { zlayer.undo(); syncPen(); });

function threadGroups() {
  const g = { "iMessage / SMS": [], "Telegram": [], "Signal": [] };
  for (const t of state.threads || []) g[WORLD_OF(t)].push(t);
  return g;
}

function renderPicker() {
  const pick = $("thread-pick");
  pick.textContent = "";
  const groups = threadGroups();
  const show = state.world && state.world !== "All"
    ? { [state.world]: groups[state.world] } : groups;
  const label = (t) =>
    `${t.display_name || state.aliases[t.identifier] || t.identifier}` +
    ` (${t.count.toLocaleString()})`;
  for (const [name, list] of Object.entries(show)) {
    if (!list.length) continue;
    const og = document.createElement("optgroup");
    og.label = `— ${name} · ${list.length} —`;
    for (const t of list) {
      const opt = document.createElement("option");
      opt.value = t.identifier;
      opt.textContent = label(t);
      og.append(opt);
    }
    pick.append(og);
  }
}

function renderWorlds() {
  const nav = $("worlds");
  if (!nav) return;
  nav.textContent = "";
  const groups = threadGroups();
  const chips = [["All", (state.threads || []).length]];
  for (const name of ["iMessage / SMS", "Telegram", "Signal"])
    if (groups[name].length) chips.push([name, groups[name].length]);
  if (chips.length <= 2) return;   // only one world — no switch to show
  for (const [name, n] of chips) {
    const b = document.createElement("button");
    b.className = "world-chip" +
      ((state.world || "All") === name ? " current" : "");
    b.textContent = name === "All" ? "all" : name.replace(" / SMS", "");
    b.title = `${n} thread${n === 1 ? "" : "s"}`;
    b.addEventListener("click", () => selectWorld(name));
    nav.append(b);
  }
}

function selectWorld(name) {
  state.world = name;
  renderWorlds();
  renderPicker();
  // the switch lands you IN that world — open its top (busiest) thread
  const list = name === "All" ? state.threads : threadGroups()[name];
  if (list && list.length) {
    $("thread-pick").value = list[0].identifier;
    openThread(list[0].identifier, state.threads);
  }
}

// ---- boot ----------------------------------------------------------------------

async function boot() {
  const health = await (await fetch("/api/health")).json();
  installApiSecurity(health.csrf_token);
  if (health.db !== "ok") {
    consentCard(health.help);
    return;
  }
  state.aliases = health.config.aliases || {};
  // the summons verb exists only at the Mac itself (it bears the key);
  // set before the first render so rows are born with or without it
  timeline.summonEnabled = !!health.summon_available;
  // the archive moved (or was restored) since last time — its ink is
  // waiting under a dead suffix. This only ever asks; both answers are
  // honored for real (STEP 6b).
  // ...but never as the FIRST thing anyone sees. On a first visit the reveal
  // is about to play, and a stranger's opening screen should not be file
  // bookkeeping in two identical boxes. It waits for the next launch.
  if (Array.isArray(health.orphaned_families) && health.orphaned_families.length
      && localStorage.getItem("wl-revealed")) {
    offerAdoption(health.orphaned_families);
  }

  const { threads } = await (await fetch("/api/chats")).json();
  if (!threads.length) {
    consentCard("The archive opened, but no conversations were found.");
    return;
  }
  state.threads = threads;
  state.world = "All";
  renderPicker();   // grouped by transport, EVERY thread reachable
  renderWorlds();   // the visible transport switch (>1 world only)
  const params = new URLSearchParams(location.search);
  const linkChat = params.get("chat");
  const preferred = linkChat || health.config.default_chat;
  const def =
    (preferred && threads.find((t) => t.identifier === preferred)) ||
    threads.find((t) => t.style === 45) ||
    threads[0];
  const pick = $("thread-pick");
  pick.value = def.identifier;
  pick.addEventListener("change", () => openThread(pick.value, threads));
  await openThread(def.identifier, threads);

  // a shared timestamp landed here: resolve guid → exact message
  // (works across archives), fall back to the moment in time
  if (params.get("g") || params.get("at")) {
    let target = null;
    if (params.get("g")) {
      const r = await (await fetch(`/api/resolve?chat=${
        encodeURIComponent(def.identifier)}&guid=${
        encodeURIComponent(params.get("g"))}`)).json();
      if (r.found) target = r;
    }
    const at = target?.date_unix ?? parseFloat(params.get("at"));
    if (at) timeline.jump(at, target?.rowid ?? null);
    history.replaceState(null, "", WL.base); // the address bar returns to calm
  } else {
    // a thread opens at its MOST RECENT message (openThread → jumpToLatest);
    // we never yank the view back to the beginning. On the very first visit
    // the layer lifts once so the timeline is discoverable, but the stream
    // stays at the newest end — the reveal used to rewind to the first day
    // and autoplay, which is exactly the "starts at the earliest" she asked
    // us to stop doing. The on-this-day card (a non-moving offer) still
    // appears after the first visit.
    // A stranger's first ten seconds decide whether there is an eleventh.
    // The old reveal opened the layer after 700ms, which shows the machinery
    // and says nothing — you are looking at a waveform of somebody else's
    // life with no reason to care. So the first visit WAITS, briefly, for
    // the resonance scan to find something worth arriving on, and opens the
    // layer anyway if it doesn't. Nothing here ever moves the stream on its
    // own: the card is an offer, and travelling is a tap.
    if (!localStorage.getItem("wl-revealed") ||
        new URLSearchParams(location.search).has("arrive")) {
      localStorage.setItem("wl-revealed", "1");
      state.arrivalOpen = true;
      setTimeout(() => {
        if (!state.arrivalOpen) return;   // an arrival landed; leave it alone
        state.arrivalOpen = false;
        if (!layerOpen()) openLayer();
      }, 4000);
    } else {
      maybeOnThisDay(); // the daily ritual — a card, never a jump
    }
  }
}

// ---- reading bookmark: mark your spot while re-reading, return to it later ------
// An explicit, per-thread bookmark (press b). Reopening the thread offers a
// "resume" pill that jumps back — it never auto-jumps, so the default stays
// most-recent. Stores only navigation coords in localStorage (ts/guid/rowid),
// never message content.

function bookmarkKey() { return "wl-bm-" + (state.chatKey || state.chat); }

function dropBookmark() {
  const t = window.__timeline;
  if (!t || !t.loaded.length) return;
  const idx = t.selectedIdx >= 0 ? t.selectedIdx : t.visibleIndex();
  const m = t.loaded[idx];
  if (!m) return;
  localStorage.setItem(bookmarkKey(), JSON.stringify(
    { ts: m.date_unix, guid: m.guid, rowid: m.rowid }));
  flashToast("bookmarked here — reopen this thread to resume");
}

function flashToast(text) {
  let el = $("wl-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "wl-toast";
    el.className = "wl-toast mono";
    document.body.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2600);
}

function maybeResumeReading() {
  $("resume-pill")?.remove();
  const raw = localStorage.getItem(bookmarkKey());
  if (!raw) return;
  let bm;
  try { bm = JSON.parse(raw); } catch (e) { return; }
  if (!bm || !bm.ts) return;
  const pill = document.createElement("button");
  pill.id = "resume-pill";
  pill.className = "resume-pill mono";
  const when = new Date(bm.ts * 1000).toLocaleDateString([],
    { month: "short", day: "numeric", year: "numeric" });
  pill.textContent = `↩ resume reading · ${when}`;
  pill.title = "return to where you bookmarked in this thread";
  pill.addEventListener("click", () => {
    stopPlaying();
    timeline.jump(bm.ts, bm.rowid ?? null);
    pill.remove();
  });
  document.body.append(pill);
  setTimeout(() => { if (pill.isConnected) pill.remove(); }, 12000);
}

// ---- the arrival: what a stranger sees first ------------------------------------
// One card, offered once, naming the strongest thing the sheet found in this
// archive without anyone asking it to look. It states the finding and then
// stops — the stream does not move, nothing lifts, and the only way onward
// is a tap. An interface that seizes the view to impress you has told you
// what it thinks of your attention.

function offerArrival(resonance) {
  if (!state.arrivalOpen) return;         // the moment has passed, or was used
  if (!resonance?.pair) return;
  state.arrivalOpen = false;
  $("arrival")?.remove();

  const wrap = document.createElement("aside");
  wrap.id = "arrival";
  wrap.className = "arrival";
  const card = document.createElement("div");
  card.className = "card arrival-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "false");
  card.setAttribute("aria-labelledby", "arrival-head");

  const head = document.createElement("p");
  head.className = "mono arrival-head";
  head.id = "arrival-head";
  head.textContent = "the sheet found this on its own";

  // The sentence itself, as it was typed. This is the only place in the
  // interface where a message is quoted out of the stream, and it earns it:
  // the finding IS the sentence.
  const said = document.createElement("blockquote");
  said.className = "arrival-said";
  said.textContent = `“${resonance.text}”`;

  const { firstYear, againYear, span } = resonance.pair;
  const line = document.createElement("p");
  line.className = "mono arrival-line";
  line.textContent =
    `asked in ${firstYear} · asked again in ${againYear} · ${span} apart`;

  const gloss = document.createElement("p");
  gloss.className = "arrival-gloss";
  gloss.textContent =
    "Both times, the question sat unanswered. Nothing searched for it — " +
    "the layer proposed two silences, and the same sentence was underneath " +
    "both of them.";

  const row = document.createElement("div");
  row.className = "row arrival-row";
  const go = document.createElement("button");
  go.className = "arrival-go";
  go.textContent = "lift the sheet and show me";
  const later = document.createElement("button");
  later.className = "quiet mono";
  later.textContent = "not now";

  const close = () => {
    wrap.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  };
  later.addEventListener("click", close);
  go.addEventListener("click", () => {
    close();
    stopPlaying();
    openLayer();
    // Land on the FIRST asking, not the return. The return is the punchline
    // and it is already drawn on the sheet with a line running to it; being
    // shown the punchline first is the difference between reading something
    // and being told about it.
    const at = Number(resonance.pair.first);
    if (Number.isFinite(at)) timeline.jump(at);
    // lift after the jump so the sheet rises over a track that is already
    // where it belongs — the plane has no meaning without the record under it
    setTimeout(() => {
      zlayer.setLift(1);
      syncIntelligenceOverlay();
      syncPen();
    }, 220);
  });
  row.append(go, later);

  card.append(head, said, line, gloss, row);
  wrap.append(card);
  document.body.append(wrap);
  document.addEventListener("keydown", onKey, true);
  go.focus();
}

// ---- on this day: the reason to open it tomorrow ---------------------------------

async function maybeOnThisDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem("wl-otd") === today) return; // once a day, quietly
  const q = encodeURIComponent(state.chat);
  const { years } = await (await fetch(`/api/onthisday?chat=${q}`)).json();
  if (!years?.length) return;
  localStorage.setItem("wl-otd", today);

  const card = document.createElement("aside");
  card.id = "onthisday";
  const summary = document.createElement("button");
  summary.className = "otd-summary";
  const summaryTitle = document.createElement("span");
  summaryTitle.textContent = "on this day";
  const summaryCount = document.createElement("span");
  summaryCount.className = "mono";
  summaryCount.textContent = `${years.length} year${years.length === 1 ? "" : "s"} remembered`;
  summary.append(summaryTitle, summaryCount);
  summary.addEventListener("click", () => card.classList.add("open"));
  card.append(summary);
  const head = document.createElement("div");
  head.className = "otd-head mono";
  head.append(`on this day — ${new Date().toLocaleDateString([], {
    month: "long", day: "numeric" })}`);
  const x = document.createElement("button");
  x.className = "otd-close";
  x.textContent = "×";
  x.setAttribute("aria-label", "put away");
  x.addEventListener("click", () => card.remove());
  head.append(x);
  card.append(head);

  for (const y of years) {
    const row = document.createElement("button");
    row.className = "otd-year";
    const meta = document.createElement("span");
    meta.className = "mono";
    meta.textContent =
      `${y.year} · ${y.count} message${y.count === 1 ? "" : "s"}`;
    row.append(meta);
    for (const s of y.sample) {
      const p = document.createElement("p");
      if (s.marked) p.className = "otd-marked";
      p.textContent = `“${s.preview}”`;
      row.append(p);
    }
    row.addEventListener("click", () => {
      stopPlaying();
      timeline.jump(y.sample[0].date_unix, y.sample[0].rowid);
      card.remove();
    });
    card.append(row);
  }
  document.body.append(card);
  setTimeout(() => {
    if (card.isConnected && !card.classList.contains("open")) card.remove();
  }, 12000);
}

async function openThread(identifier, threads) {
  const epoch = ++state.threadEpoch;
  state.chat = identifier;
  const t = threads.find((x) => x.identifier === identifier);
  state.thread = t;
  state.density = [];
  state.summons = [];
  state.candidates = [];
  state.resonances = [];
  chronology.reset();
  waveform.reset();   // a new conversation is a cold track
  // the server's merge key for this thread — one function (db.py's
  // thread_key) decides it; the client just remembers what it was told
  state.chatKey = t?.key || identifier;
  $("thread-name").textContent =
    t?.display_name || state.aliases[identifier] || identifier;
  syncCapabilities(identifier);
  updateTrackMeta();
  timeline.setChat(identifier, state.aliases);
  bubbleThreadChanged();
  closeFacet();
  stopPlaying();

  const q = encodeURIComponent(identifier);
  // the hand behind sent messages — loaded before rows render so every
  // ink-born message carries its ✍ from the first paint
  const inkPayload = await fetch(`/api/inks?chat=${q}`).then((r) => r.json())
    .catch(() => ({}));
  if (state.threadEpoch !== epoch || state.chat !== identifier) return;
  state.inks = inkPayload.inks || {};
  timeline.setInks(state.inks);
  const [density, markers, chapters, notes, co, summons, candidates] = await Promise.all([
    fetch(`/api/density?chat=${q}`).then((r) => r.json()),
    fetch(`/api/markers?chat=${q}`).then((r) => r.json()),
    fetch(`/api/chapters?chat=${q}`).then((r) => r.json()),
    fetch(`/api/notes?chat=${q}`).then((r) => r.json()),
    fetch(`/api/co?chat=${q}`).then((r) => r.json())
      .catch(() => ({ linked: false })),
    fetch(`/api/summons?chat=${q}`).then((r) => r.json())
      .catch(() => ({ summons: [] })),
    // the Z layer's proposals — structure only, no model has read them
    fetch(`/api/candidates?chat=${q}&limit=40`).then((r) => r.json())
      .catch(() => ({ candidates: [] })),
    timeline.jumpToLatest(),
  ]);
  if (state.threadEpoch !== epoch || state.chat !== identifier) return;
  state.markers = markers.markers;
  state.markerIdx = state.markers.length;
  state.chapters = chapters.chapters;
  state.notes = notes.notes;
  state.co = co;
  state.summons = summons.summons || [];
  state.candidates = candidates.candidates || [];
  // the hand that wrote on THIS conversation — keyed by the server's merge
  // key, like marks and bookmarks, so a second spelling of the same person
  // opens the same sheet. state.chat is passed as the legacy key to adopt.
  zlayer.useStore(state.chatKey || state.chat, state.chat);
  state.density = density.days || [];
  refreshPinBadge();
  syncMapData();
  waveform.setWindow(state.rangeDays);
  syncIntelligenceOverlay();
  updateTrackMeta();
  updateTrackReadout(timeline.visibleDate());
  maybeResumeReading();  // opened at latest; offer a jump back if bookmarked
  findResonances(epoch, identifier);   // deliberately not awaited
}

// ---- resonance: the same question, asked again years later ---------------------
// Reads the text behind the candidates the server proposed. The server never
// learns what it found — /api/candidates stays content-blind, and the pairing
// happens here, in this browser, over messages already on this screen.
//
// Never awaited by openThread: it costs one small request per proposed
// question, and the stream must be readable long before it finishes.

async function findResonances(epoch, identifier) {
  try {
    const found = await scanResonance(state.candidates, {
      chat: identifier,
      fetchJson: async (url) => (await fetch(url)).json(),
    });
    // a thread switch mid-scan must not paint A's echoes over B
    if (state.threadEpoch !== epoch || state.chat !== identifier) return;
    if (!found.length) return;
    state.resonances = found;
    syncIntelligenceOverlay();
    offerArrival(found[0]);
  } catch { /* the sheet without echoes is the sheet that shipped */ }
}

// ---- the co-layer: private readings can be offered into a shared journal ------
// The record never changes. A peer's annotation is dashed while offered and
// becomes solid "ours" only after this person accepts its exact revision.

function mergedNotes() {
  const peers = (state.co?.notes || [])
    .filter((n) => !n.you && n.my_response !== "decline")
    .map((n) => ({ date_unix: n.date_unix, text: n.text, kind: "track",
                   peer: true, name: n.name, author: n.author,
                   consent_status: n.status }));
  return [...(state.notes || []), ...peers];
}

function syncMapData() {
  const notes = mergedNotes();
  waveform.setData(
    state.density || [], state.markers || [], state.chapters || [], notes);
  chronology.setData(
    state.density || [], state.markers || [], state.chapters || [], notes);
}

async function refreshCo() {
  if (!state.chat) return;
  const chat = state.chat;                 // a thread switch mid-fetch...
  const q = encodeURIComponent(chat);
  const co = await fetch(`/api/co?chat=${q}`).then((r) => r.json())
    .catch(() => null);
  if (state.chat !== chat) return;         // ...must not paint A's fold on B
  if (co) state.co = co;
  syncMapData();
}

function consentCard(text) {
  const el = $("timeline");
  el.textContent = "";
  const card = document.createElement("div");
  card.className = "card lifted";
  for (const line of (text || "something went quietly wrong").split("\n")) {
    const p = document.createElement("p");
    if (/^\d\./.test(line)) p.className = "mono";
    p.textContent = line;
    card.append(p);
  }
  const retry = document.createElement("button");
  retry.textContent = "try again";
  retry.addEventListener("click", () => location.reload());
  card.append(retry);
  el.append(card);
}

// ---- suffix adoption: a previous location of this archive left ink behind -----
// /api/health.orphaned_families only ever ASKS; both answers are honored for
// real — "not now" just closes the card (asked again next boot), "adopt"
// claims every named family server-side (db.py: adopt_family) then reloads
// so the freshly-claimed notes/marks/chapters render in the open thread.

function offerAdoption(families) {
  $("adopt-card")?.remove();
  const total = families.reduce((n, f) => n + (f.notes || 0), 0);
  const wrap = document.createElement("aside");
  wrap.id = "adopt-card";
  const card = document.createElement("div");
  card.className = "card";
  const p = document.createElement("p");
  p.textContent =
    `This archive moved (or was restored) since last time — ` +
    `${total.toLocaleString()} note${total === 1 ? "" : "s"} from a ` +
    `previous location ${families.length === 1 ? "is" : "are"} waiting. ` +
    `Adopt them into this one?`;
  const row = document.createElement("div");
  row.className = "row";
  const yes = document.createElement("button");
  yes.textContent = "adopt";
  const no = document.createElement("button");
  no.textContent = "not now";
  no.addEventListener("click", () => wrap.remove());
  yes.addEventListener("click", async () => {
    yes.disabled = true;
    no.disabled = true;
    yes.textContent = "adopting…";
    for (const f of families) {
      await fetch("/api/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suffix: f.suffix }),
      }).catch(() => null);
    }
    location.reload();  // freshly-claimed keys need a fresh boot to render
  });
  row.append(yes, no);
  card.append(p, row);
  wrap.append(card);
  document.body.append(wrap);
}

// ---- the layer -----------------------------------------------------------------

function layerOpen() {
  return $("layer").classList.contains("open");
}

function openLayer() {
  const layer = $("layer");
  layer.hidden = false;
  setTimeout(() => layer.classList.add("open"), 0);
  waveform.draw();
  syncPlayhead();
  refreshCo(); // the folder may have synced while the layer slept
}

function closeLayer() {
  stopPlaying();
  closeFacet();
  $("layer").classList.remove("open");
  setTimeout(() => { if (!layerOpen()) $("layer").hidden = true; }, 300);
}

function toggleLayer() {
  layerOpen() ? closeLayer() : openLayer();
}

// ---- playhead + play mode (the SoundCloud heart) ----------------------------------

function syncPlayhead() {
  const ts = timeline.visibleDate();
  chronology.setPosition(ts);
  if (!layerOpen()) return;
  waveform.setPlayhead(ts);
  updateTrackReadout(ts);
}
// A backgrounded tab has no playhead to move and nobody watching it move.
// board.js already guards its poll this way; the reading surfaces did not,
// so a DC-1 left on the desk kept repainting the rail behind a locked
// screen. Nothing is missed: the tick resumes on the next visible frame.
setInterval(() => { if (!document.hidden) syncPlayhead(); }, 350);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncPlayhead();   // catch up the moment it returns
});

function updateTrackReadout(ts) {
  if (!Number.isFinite(ts) || !waveform.days.length) {
    $("track-date").textContent = "most recent";
    $("track-position").textContent = "ready";
    return;
  }
  const clamped = Math.max(waveform.f0, Math.min(ts, waveform.f1));
  const span = Math.max(1, waveform.f1 - waveform.f0);
  const pct = Math.max(0, Math.min(100,
    Math.round(((clamped - waveform.f0) / span) * 100)));
  $("track-date").textContent = new Date(clamped * 1000).toLocaleDateString([], {
    year: "numeric", month: "short", day: "numeric",
  });
  // "100% through" on a thread you just opened is technically true and
  // useless — it reads as a finished progress bar. Until the hand engages,
  // the track is simply ready.
  $("track-position").textContent = waveform.warm ? `${pct}% through` : "ready";
}

function startPlaying() {
  if (state.playing) return;
  waveform.warmUp();   // now the played region means something — paint it
  const el = $("timeline");
  // A thread opens at the live edge, where the stop condition is ALREADY
  // true — so the first press of every session started and stopped on the
  // next tick, flickering the button and moving nothing. Rewind to the top
  // of what's loaded and play forward from there.
  if (timeline.doneNewer &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
    el.scrollTop = 0;
  }
  let last = Date.now();
  let lastSkip = 0;
  state.playing = setInterval(() => {
    const now = Date.now();
    // wall-clock paced (~64px/s) so throttled timers can't slow the listen-back
    el.scrollTop += Math.min(1000, now - last) * 0.064;
    last = now;
    // skip the silence: a gap over a day plays as a cut, not dead air —
    // but each message still gets a beat (~3/s), so sparse years read as
    // brisk, not blurred
    const i = timeline.visibleIndex();
    const cur = timeline.loaded[i], next = timeline.loaded[i + 1];
    if (cur && next && next.date_unix - cur.date_unix > 86400 &&
        now - lastSkip > 400) {
      const n = timeline.nodes[i + 1];
      // land the next message exactly on the reading line (viewport middle)
      const target = n.offsetTop + n.offsetHeight / 2 - el.clientHeight / 2;
      if (target > el.scrollTop) { el.scrollTop = target; lastSkip = now; }
    }
    if (timeline.doneNewer &&
        el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
      stopPlaying(); // reached today; the needle rests
    }
  }, 50);
  syncHandle("playing");
  $("play-btn").classList.add("playing");
  $("play-btn").setAttribute("aria-label", "pause the conversation");
}

function stopPlaying() {
  if (!state.playing) return;
  clearInterval(state.playing);
  state.playing = null;
  syncHandle();
  $("play-btn").classList.remove("playing");
  $("play-btn").setAttribute("aria-label", "play the conversation");
}

function togglePlaying() {
  state.playing ? stopPlaying() : startPlaying();
}

// the visible trigger for the hidden delight — pointerdown must not
// reach the waveform's scrub handlers underneath
for (const ev of ["pointerdown", "dblclick"]) {
  $("play-btn").addEventListener(ev, (e) => e.stopPropagation());
}
$("play-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  togglePlaying();
});

// ---- track notes: double-click the waveform to pin a thought to a moment -----------

$("wave").addEventListener("dblclick", (e) => {
  const wave = $("wave");
  wave.querySelector(".track-note-editor")?.remove();
  const x = e.clientX - wave.getBoundingClientRect().left;
  const ts = waveform.ts(x);
  const box = document.createElement("input");
  box.className = "track-note-editor";
  box.placeholder = new Date(ts * 1000).toLocaleDateString([], {
    year: "numeric", month: "short", day: "numeric" }) + " — a note on the track…";
  box.style.left = `${Math.min(Math.max(8, x - 120), wave.clientWidth - 248)}px`;
  box.addEventListener("keydown", async (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") box.remove();
    if (ev.key === "Enter" && box.value.trim()) {
      await fetch("/api/tracknote", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: state.chat, ts, text: box.value }),
      });
      box.remove();
      const q = encodeURIComponent(state.chat);
      const { notes } = await (await fetch(`/api/notes?chat=${q}`)).json();
      state.notes = notes;
      syncMapData();
    }
  });
  box.addEventListener("blur", () => setTimeout(() => box.remove(), 150));
  wave.append(box);
  box.focus();
});

// ---- markers / n-p navigation -----------------------------------------------------

function nearestMarkerIdx(ts) {
  let best = -1;
  for (let i = 0; i < state.markers.length; i++) {
    if (state.markers[i].date_unix <= ts) best = i;
  }
  return best;
}

function jumpToMarker(m) {
  const i = state.markers.findIndex((x) => x.rowid === m.rowid);
  if (i >= 0) state.markerIdx = i;
  timeline.jump(m.date_unix, m.rowid);
}

function gotoMarker(delta) {
  if (!state.markers.length) return;
  let i = state.markerIdx + delta;
  i = Math.max(0, Math.min(i, state.markers.length - 1));
  state.markerIdx = i;
  const m = state.markers[i];
  timeline.jump(m.date_unix, m.rowid);
}

// ---- facets --------------------------------------------------------------------------

function closeFacet() {
  state.facet = null;
  state.facetCursor = null;
  $("layer").classList.remove("focus-facet");
  $("facet-body").hidden = true;
  $("panel-body").textContent = "";
  $("panel-body").classList.remove("grid");
  $("panel-more").hidden = true;
  for (const b of document.querySelectorAll(".facet")) b.classList.remove("active");
}

async function openFacet(kind, opts = {}) {
  // Every branch below destructures its response and NOTHING caught it: a 500
  // threw "data.results is not iterable", the panel silently stopped growing,
  // "older…" stayed visible, and the reader was told nothing at all. One
  // wrapper covers all six facets rather than six edits.
  try {
    return await openFacetBody(kind, opts);
  } catch {
    const body = $("panel-body");
    if (body) emptyAside(body, "That didn't load. Try again — if it keeps "
      + "failing, the server may need to be put away and opened again.");
    const more = $("panel-more");
    if (more) more.hidden = true;
  }
}

async function openFacetBody(kind, { fresh = true } = {}) {
  if (isImported(state.chat)
      && ["pins", "links", "media", "wrapped", "search"].includes(kind)) return;
  if (fresh && state.facet === kind) { closeFacet(); return; }
  if (!layerOpen()) openLayer();
  if (fresh) {
    closeFacet();
    state.facet = kind;
    $("layer").classList.toggle("focus-facet", kind === "wrapped");
    document.querySelector(`.facet[data-facet="${kind}"]`)?.classList.add("active");
    $("facet-body").hidden = false;
  }
  const body = $("panel-body");
  const chat = state.chat;
  const epoch = state.threadEpoch;
  const stillCurrent = () => state.chat === chat &&
    state.threadEpoch === epoch && state.facet === kind;
  const q = encodeURIComponent(chat);

  if (kind === "pins") {
    const { markers } = await (await fetch(`/api/markers?chat=${q}&refresh=1`)).json();
    if (!stillCurrent()) return;
    state.markers = markers;
    syncMapData();
    markSeen();
    renderLedger(body);
  }

  if (kind === "desk") {
    const summons = await (await fetch(`/api/summons?chat=${q}`)).json();
    if (!stillCurrent()) return;
    state.summons = summons.summons || [];
    syncIntelligenceOverlay();
    renderDeskFacet(body);
  }

  if (kind === "chapters") {
    renderChaptersFacet(body);
  }

  if (kind === "notes") {
    const [{ notes }, , summons] = await Promise.all([
      (await fetch(`/api/notes?chat=${q}`)).json(),
      refreshCo(),
      (await fetch(`/api/summons?chat=${q}`)).json(),
    ]);
    if (!stillCurrent()) return;
    state.notes = notes;
    state.summons = summons.summons || [];
    syncIntelligenceOverlay();
    renderNotesFacet(body);
  }

  if (kind === "wrapped") {
    renderWrappedControls(body);
    await refreshWrapped();
  }

  if (kind === "threads") {
    const { items } = await (await fetch(`/api/threads?chat=${q}`)).json();
    if (!stillCurrent()) return;
    if (!items.length) return emptyAside(body,
      "No reply threads here yet — reply to a specific message to start one.");
    for (const t of items) {
      body.append(panelRow(t, { tag: `↩ ${t.replies}` }));
    }
  }

  if (kind === "links") {
    const params = new URLSearchParams({ chat });
    if (!fresh && state.facetCursor) params.set("before", state.facetCursor.join(","));
    const data = await (await fetch(`/api/links?${params}`)).json();
    if (!stillCurrent()) return;
    if (fresh && !data.items.length) return emptyAside(body,
      "No links shared here yet.");
    for (const it of data.items) body.append(panelRow(it, { urls: it.urls }));
    state.facetCursor = data.cursor;
    $("panel-more").hidden = !data.cursor || !data.items.length;
  }

  if (kind === "media") {
    body.classList.add("grid");
    const params = new URLSearchParams({ chat });
    if (!fresh && state.facetCursor) params.set("before", state.facetCursor.join(","));
    const data = await (await fetch(`/api/media?${params}`)).json();
    if (!stillCurrent()) return;
    if (fresh && !data.items.length) return emptyAside(body,
      "No images here yet.");
    for (const it of data.items) body.append(thumbCell(it));
    state.facetCursor = data.cursor;
    $("panel-more").hidden = !data.cursor || !data.items.length;
  }

  if (kind === "search") {
    const params = new URLSearchParams({ chat, q: state.searchQuery });
    if (!fresh && state.facetCursor) params.set("before", state.facetCursor.join(","));
    const data = await (await fetch(`/api/search?${params}`)).json();
    if (!stillCurrent()) return;
    if (fresh && !data.results.length) return emptyAside(body,
      "Nothing found by that name — try fewer words?");
    for (const r of data.results) body.append(panelRow(r, {}));
    state.facetCursor = data.cursor;
    $("panel-more").hidden = !data.cursor || !data.results.length;
  }
}

// ---- journal: private readings + the folder door (SYNC-ROUTES Route A) --------
// Every note is private by default. Sharing makes a proposal, not a jointly
// authored fact; the peer must accept the exact revision before it becomes ours.

const coFolderName = () =>
  (state.co?.folder || "").split("/").filter(Boolean).pop() || "the folder";

// my shared entry at this waveform moment, if any
const coSharedAt = (ts) => (state.co?.notes || []).find(
  (e) => e.you && e.anchor === "t" + Math.floor(ts));

const onThisMac = () =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(location.hostname);

function coStrip(body) {
  const strip = document.createElement("div");
  strip.className = "co-strip";
  if (state.co?.linked) {
    const line = document.createElement("span");
    line.className = "mono";
    const peers = state.co.peers || [];
    const un = state.co.unreadable || 0;
    line.textContent = `⊂⊃ shared journal · ${coFolderName()} · you appear as ` +
      `${state.co.you?.name || "someone"}` +
      (peers.length ? ` · with ${peers.map((p) => p.name).join(", ")}` : " · no one else yet") +
      (un ? ` · ${un} log${un === 1 ? "" : "s"} still syncing` : "");
    const unlink = document.createElement("button");
    unlink.className = "quiet mono";
    unlink.textContent = "close the door";
    unlink.title = "forget this folder — nothing in it is touched";
    unlink.addEventListener("click", async () => {
      const res = await fetch("/api/co/unlink", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: state.chat }),
      });
      const d = await res.json();
      if (res.ok) state.co = d;
      else line.textContent = d.error || "couldn't unlink";
      syncMapData();
      renderNotesFacet(body);
    });
    strip.append(line, unlink);
    return strip;
  }
  // the door, closed. Linking grants a write-path and happens at the Mac
  // (loopback-only server-side); on a --share device say so plainly rather
  // than offer a form with Finder instructions that can only 403
  if (!onThisMac()) {
    const p = document.createElement("p");
    p.className = "aside co-aside";
    p.textContent = "a shared folder is opened from the Mac itself — this is " +
      "a view of it over your wifi. Peers' shared notes still appear here.";
    strip.append(p);
    return strip;
  }
  // a quiet way to open it — local config only; the only thing written to
  // the folder now is your whoami card
  const name = document.createElement("input");
  name.className = "co-name";
  name.placeholder = "your name to them";
  name.maxLength = 40;
  name.value = state.co?.you?.name || "";
  const folder = document.createElement("input");
  folder.className = "co-folder";
  folder.placeholder = "point this chat at a shared folder — paste its path…";
  const link = document.createElement("button");
  link.className = "quiet mono";
  link.textContent = "open the door";
  const note = document.createElement("span");
  note.className = "mono co-note";
  note.textContent = "";
  const doLink = async () => {
    if (!folder.value.trim()) {
      note.textContent = "in Finder: right-click the folder, hold ⌥, " +
        "Copy as Pathname — paste it here";
      return;
    }
    link.disabled = true;
    try {
      const res = await fetch("/api/co/link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: state.chat, folder: folder.value,
                               name: name.value }),
      });
      const d = await res.json();
      if (!res.ok) { note.textContent = d.error || "couldn't link"; }
      else {
        state.co = d;
        syncMapData();
        renderNotesFacet(body);
        return;
      }
    } catch (e) {
      note.textContent = "couldn't reach the server";
    }
    link.disabled = false;
  };
  link.addEventListener("click", doLink);
  folder.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") doLink();
  });
  name.addEventListener("keydown", (e) => e.stopPropagation());
  const aside = document.createElement("p");
  aside.className = "aside co-aside";
  aside.textContent = "private readings stay here; offered readings enter " +
    "this journal, and become ours only by consent.";
  strip.append(name, folder, link, note, aside);
  return strip;
}

function coShareBtn(n, body) {
  const b = document.createElement("button");
  b.className = "quiet mono note-share";
  const shared = coSharedAt(n.date_unix);
  const base = shared
    ? shared.status === "ours" ? "ours ✓ · withdraw" : "proposed · withdraw"
    : "offer as ours";
  b.textContent = base;
  b.title = shared
    ? "withdraw this reading from the shared journal"
    : `offer this reading in ${coFolderName()}`;
  const { disarm } = armTwoTap(b, {
    armedLabel: shared
      ? `withdraw from ${coFolderName()}?`
      : `offer exact words to ${coFolderName()}?`,
    restLabel: base,
    timeoutMs: 4000,
    onFire: async () => {
      b.textContent = shared ? "withdrawing…" : "sharing…";
      try {
        const res = await fetch("/api/co/share", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat: state.chat, ts: n.date_unix,
                                 retract: !!shared }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error);
        await refreshCo();
        renderNotesFacet(body);          // rebuilds this row from fresh state
      } catch (err) {
        b.textContent = err.message || "couldn't share";  // honest, untruncated
        setTimeout(() => { if (b.isConnected) disarm(); }, 4000);
      }
    },
  });
  return b;
}

function coConsentControls(entry, body) {
  const wrap = document.createElement("span");
  wrap.className = "co-consent";
  const addDecision = (label, armedLabel, decision) => {
    const button = document.createElement("button");
    button.className = "quiet mono note-share";
    button.textContent = label;
    const { disarm } = armTwoTap(button, {
      armedLabel,
      restLabel: label,
      timeoutMs: 4000,
      onFire: async () => {
        button.textContent = "recording…";
        try {
          const res = await fetch("/api/co/respond", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat: state.chat, ts: entry.date_unix,
              author: entry.author, revision: entry.revision, decision,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "the journal didn't answer");
          await refreshCo();
          renderNotesFacet(body);
        } catch (error) {
          button.textContent = error.message || "couldn't record consent";
          setTimeout(() => { if (button.isConnected) disarm(); }, 4000);
        }
      },
    });
    wrap.append(button);
  };

  if (entry.my_response === "accept") {
    addDecision("ours ✓ · withdraw consent", "make this separate again?", "withdraw");
  } else if (entry.my_response === "decline") {
    addDecision("accept instead", "accept these exact words as ours?", "accept");
    addDecision("reopen", "return this reading to offered?", "withdraw");
  } else {
    addDecision("accept into ours", "accept these exact words as ours?", "accept");
    addDecision("keep separate", "keep this as their reading only?", "decline");
  }
  return wrap;
}

function coStatusTag(entry) {
  if (entry.you) {
    const names = (entry.accepted_by || []).map((person) => person.name);
    return names.length ? `ours with ${names.join(", ")}` : "mine · proposed";
  }
  if (entry.status === "ours") return `ours with ${entry.name}`;
  if (entry.status === "separate") return `${entry.name} · kept separate`;
  return `${entry.name} · offered`;
}

function renderNotesFacet(body) {
  if (state.facet !== "notes") return;   // a late async caller must not
  body.textContent = "";                 // clobber a facet that moved on
  // the named door: the summons by the words she knows it by — always
  // findable here, no hover secret. Absent (not broken) off the Mac.
  if (timeline.summonEnabled) {
    const callBtn = document.createElement("button");
    callBtn.className = "quiet mono summon-door";
    callBtn.textContent = "✦ call on an outside mind";
    callBtn.addEventListener("click", () => {
      const b = timeline.stretchBounds();
      if (b) { openSummon(b); return; }
      callBtn.textContent = "✦ tap a message in the stream first, then call";
      setTimeout(() => {
        if (callBtn.isConnected)
          callBtn.textContent = "✦ call on an outside mind";
      }, 3000);
    });
    body.append(callBtn);
  }
  body.append(coStrip(body));
  const notes = state.notes || [];
  const linked = state.co?.linked;
  for (const n of [...notes].reverse()) {
    const row = panelRow(n.kind === "track"
      ? { ...n, preview: "— on the track —", from_me: true } : n,
      { tag: n.kind === "track" ? "moment" : undefined });
    const noteLine = document.createElement("span");
    noteLine.className = "note-line";
    noteLine.textContent = `✎ ${n.text}`;
    row.insertBefore(noteLine, row.querySelector(".meta"));
    if (linked && n.kind === "track") row.append(coShareBtn(n, body));
    body.append(row);
  }
  if (linked) {
    // The shared journal shows proposals and accepted readings without
    // flattening two people's interpretations into one mutable note.
    const mine = new Set(notes.filter((n) => n.kind === "track")
      .map((n) => "t" + Math.floor(n.date_unix)));
    const shared = (state.co.notes || []).filter(
      (e) => !e.you || !mine.has(e.anchor));
    if (shared.length) {
      const head = document.createElement("p");
      head.className = "mono co-head";
      head.textContent = "— live journal · mine / yours / ours —";
      body.append(head);
    }
    for (const e of [...shared].reverse()) {
      const row = panelRow(
        { ...e, preview: "— on the track —", from_me: !!e.you },
        { tag: coStatusTag(e) });
      row.classList.add(`journal-${e.status || "offered"}`);
      const noteLine = document.createElement("span");
      noteLine.className = "note-line";
      noteLine.textContent = `✎ ${e.text}`;
      row.insertBefore(noteLine, row.querySelector(".meta"));
      if (e.you) row.append(coShareBtn({ date_unix: e.date_unix }, body));
      else row.append(coConsentControls(e, body));
      body.append(row);
    }
  }
  // private ink from the summons: what an outside mind said when called on
  const summons = state.summons || [];
  if (summons.length) {
    const head = document.createElement("p");
    head.className = "mono co-head";
    head.textContent = "— summoned · yours only, never sent —";
    body.append(head);
  }
  for (const e of [...summons].reverse()) {
    const isAsk = e.kind === "ask";
    const isAssist = e.kind === "assist";
    const row = panelRow(
      { preview: isAsk ? e.question
          : isAssist ? "the desk hand — actionable matter"
          : `the reflection lens · ${e.mode}`,
        date_unix: e.anchor?.ts || e.created, from_me: true },
      { tag: "claude" + (e.dry ? " · rehearsed" : "")
             + (e.open ? " · unfinished" : "") });
    const ans = isAsk ? e.answer : isAssist ? e.note : e.closing;
    if (ans) {
      const line = document.createElement("span");
      line.className = "note-line summon-line";
      line.textContent = `✦ ${ans}`;
      row.insertBefore(line, row.querySelector(".meta"));
    }
    if (isAssist && (e.actions || []).length) {
      row.append(assistActions(e.actions));
    }
    if (isAsk && e.answer) {
      const toBubble = document.createElement("button");
      toBubble.className = "quiet mono note-share";
      toBubble.textContent = "→ bubble";
      toBubble.title = "hand this answer to the bubble as a draft — " +
        "sending still takes your own two taps";
      toBubble.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toBubble.textContent = bubbleDraft(e.answer)
          ? "drafted ✓" : "a draft is already waiting";
        setTimeout(() => { toBubble.textContent = "→ bubble"; }, 2400);
      });
      row.append(toBubble);
    }
    if (!isAsk && (e.turns || []).length) {
      // the interview itself is ink too — unfold it in place
      const tBtn = document.createElement("button");
      tBtn.className = "quiet mono note-share";
      tBtn.textContent = "unfold";
      let tEl = null;
      tBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (tEl) { tEl.remove(); tEl = null; tBtn.textContent = "unfold"; return; }
        tEl = document.createElement("span");
        tEl.className = "summon-transcript";
        for (const t of e.turns) {
          if (t.q) {
            const qs = document.createElement("span");
            qs.className = "summon-tq";
            qs.textContent = t.q;
            tEl.append(qs);
          }
          if (t.a) {
            const as = document.createElement("span");
            as.className = "summon-ta";
            as.textContent = t.a;
            tEl.append(as);
          }
        }
        row.insertBefore(tEl, row.querySelector(".meta"));
        tBtn.textContent = "fold";
      });
      row.append(tBtn);
    }
    body.append(row);
  }
  if (!notes.length && !(state.co?.notes || []).length && !summons.length) {
    emptyAside(body,
      "No marginalia yet — select a message and press a to write in the margin.");
  }
}

// ---- desk: selected-message work, kept visible without ambient access -------

function renderDeskFacet(body) {
  if (state.facet !== "desk") return;
  body.textContent = "";

  if (timeline.summonEnabled) {
    const callBtn = document.createElement("button");
    callBtn.className = "mono desk-call";
    callBtn.textContent = "✦ work this stretch";
    callBtn.addEventListener("click", () => {
      const bounds = timeline.stretchBounds();
      if (bounds) {
        openSummon(bounds, "assist");
        return;
      }
      callBtn.textContent = "select a message first";
      setTimeout(() => {
        if (callBtn.isConnected) callBtn.textContent = "✦ work this stretch";
      }, 2600);
    });
    body.append(callBtn);
  } else {
    const status = document.createElement("p");
    status.className = "mono desk-status";
    status.textContent = "new desk work waits for approval on the paired Mac";
    body.append(status);
  }

  const entries = (state.summons || []).filter((entry) =>
    entry.kind === "assist");
  if (!entries.length) {
    emptyAside(body, "No kept desk work in this conversation.");
    return;
  }

  for (const entry of [...entries].reverse()) {
    const section = document.createElement("section");
    section.className = "desk-entry";
    const meta = document.createElement("p");
    meta.className = "mono";
    const timestamp = entry.anchor?.ts || entry.created;
    const when = timestamp
      ? new Date(timestamp * 1000).toLocaleDateString([], {
          year: "numeric", month: "short", day: "numeric",
        })
      : "kept";
    meta.textContent = `${when}${entry.dry ? " · rehearsed" : " · private"}`;
    const note = document.createElement("p");
    note.textContent = entry.note || "No actionable matter surfaced.";
    section.append(meta, note);
    const sourceTs = Number(entry.anchor?.from_ts ?? entry.anchor?.ts);
    if (Number.isFinite(sourceTs)) {
      const source = document.createElement("button");
      source.className = "quiet mono desk-source";
      source.textContent = "↓ source";
      source.addEventListener("click", () => {
        timeline.jump(sourceTs);
        closeLayer();
      });
      section.append(source);
    }
    if ((entry.actions || []).length) {
      section.append(assistActions(entry.actions));
    }
    body.append(section);
  }
}

// ---- the summons: call an outside mind on a chosen stretch (vow door 3) -------
// The card SHOWS the payload before anything crosses — exactly the chosen
// messages, the destination and model named on the button itself. Two
// taps; edits disarm; answers land as PRIVATE ink in the margins room and
// never send anywhere. Fixture servers rehearse the whole flow dry.

let bubbleDraft = () => false;   // assigned inside buildBubble
let bubbleThreadChanged = () => {};

function closeSummon() {
  $("summon")?.remove();
  summonRequestClose = closeSummon;
}

// the desk hand's actions: server-built destinations only. A tap opens
// HER browser to a labeled place — nothing acts by itself. The real
// destination is shown ON the button (host for a URL, the value beneath
// the label), never hidden in a hover — the DC-1 has no hover, and a
// label must never be the only thing she sees before a tap opens a tab.
const ASSIST_GLYPH = Object.assign(Object.create(null),
  { track: "⦿", map: "⌖", event: "▤", link: "→", search: "?" });
function assistActions(actions) {
  const wrap = document.createElement("span");
  wrap.className = "summon-actions";
  for (const a of actions) {
    const glyph = ASSIST_GLYPH[a.kind] || "→";
    // malformed or non-http destinations remain visible, never active
    const safeUrl = safeHttpUrl(a.url);
    if (safeUrl) {
      const b = document.createElement("button");
      b.className = "quiet mono summon-action";
      const top = document.createElement("span");
      top.className = "summon-action-label";
      top.textContent = `${glyph} ${a.label}`;
      const dest = document.createElement("span");
      dest.className = "summon-action-dest";
      // the true destination, visible before the tap: value + where it goes
      dest.textContent = `${a.value} → opens ${safeUrl.host}`;
      b.append(top, dest);
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        window.open(safeUrl.href, "_blank", "noopener");
      });
      wrap.append(b);
    } else {
      const s = document.createElement("span");
      s.className = "mono summon-action-flat";
      s.textContent = `${glyph} ${a.label} — ${a.value}`;
      wrap.append(s);
    }
  }
  return wrap;
}
// the live card swaps in a guarded close (a mid-interview Escape must ask
// once before it destroys anything); everyone else calls this alias
let summonRequestClose = closeSummon;

async function openSummon(bounds, initialLens = "ask") {
  closeSummon();
  stopPlaying();
  let interviewLive = false;     // an open interview closes gently, not blind
  const wrap = document.createElement("aside");
  wrap.id = "summon";
  const card = document.createElement("div");
  card.className = "summon-card";
  wrap.append(card);
  const requestClose = () => {
    if (!interviewLive || wrap.dataset.closing === "1") {
      closeSummon();
      return;
    }
    wrap.dataset.closing = "1";
    note.textContent = "again to put the interview away — answered turns "
      + "are already kept as ink";
    setTimeout(() => {
      wrap.dataset.closing = "";
      if (wrap.isConnected) note.textContent = "";
    }, 4000);
  };
  summonRequestClose = requestClose;
  wrap.addEventListener("keydown", (e) => {
    e.stopPropagation();               // typing here trips no shortcuts
    if (e.key === "Escape") requestClose();
  });
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) requestClose();  // the ground puts it away
  });

  const head = document.createElement("div");
  head.className = "summon-head mono";
  const title = document.createElement("span");
  title.textContent = initialLens === "assist"
    ? "✦ the desk" : "✦ call on an outside mind";
  const close = document.createElement("button");
  close.className = "quiet mono summon-close";
  close.textContent = "✕";
  close.title = "put it away — nothing crosses";
  close.addEventListener("click", requestClose);
  head.append(title, close);

  const note = document.createElement("p");
  note.className = "summon-note mono";

  // the lens: a plain ask, or the reflection lens in either sub-mode
  let lens = ["ask", "assist", "belief", "map"].includes(initialLens)
    ? initialLens : "ask";
  const lenses = document.createElement("div");
  lenses.className = "summon-lenses";
  const chips = {};
  for (const [key, label] of [["ask", "ask"],
                              ["assist", "assist"],
                              ["belief", "reflect · belief"],
                              ["map", "reflect · map"]]) {
    const c = document.createElement("button");
    c.className = "quiet mono summon-lens" + (key === lens ? " current" : "");
    c.textContent = label;
    c.addEventListener("click", () => {
      lens = key;
      for (const el of Object.values(chips)) el.classList.remove("current");
      c.classList.add("current");
      question.hidden = key !== "ask";
      disarm();   // late-bound: the stub until armTwoTap rebinds it
    });
    chips[key] = c;
    lenses.append(c);
  }

  const question = document.createElement("textarea");
  question.className = "summon-question";
  question.rows = 2;
  question.maxLength = 500;   // the server refuses more; never trim silently
  question.placeholder = "what do you want to ask about this stretch?";
  question.hidden = lens !== "ask";
  question.addEventListener("input", () => disarm());

  // the payload — shown whole before anything can cross
  const payloadHead = document.createElement("p");
  payloadHead.className = "mono summon-payload-head";
  payloadHead.textContent = "gathering the payload…";
  const payload = document.createElement("div");
  payload.className = "summon-payload";

  const go = document.createElement("button");
  go.className = "summon-go mono";
  go.textContent = "summon";
  go.disabled = true;
  card.append(head, lenses, question, payloadHead, payload, go, note);
  document.body.append(wrap);
  (lens === "ask" ? question : go).focus();

  // preview: the server assembles the exact payload; send reassembles the
  // same stretch through the same code path AND carries the fingerprint of
  // what was shown — a stretch that changed underneath (a transcript
  // landing mid-consent) is refused, and the card redraws
  let preview = null;
  // rebound by armTwoTap below; a callable stub until then, so the chip
  // and question listeners are safe on every path (incl. preview failure)
  let disarm = () => {};
  async function drawPayload() {
    const params = new URLSearchParams(
      { chat: state.chat, from: bounds.from, to: bounds.to });
    const res = await fetch(`/api/summon/preview?${params}`);
    preview = await res.json();
    if (!res.ok) throw new Error(preview.error);
    payloadHead.textContent =
      `the payload — exactly this crosses, nothing else (${preview.count} ` +
      `message${preview.count === 1 ? "" : "s"}):`;
    payload.textContent = "";
    for (const m of preview.messages) {
      const row = document.createElement("div");
      row.className = "summon-msg";
      const who = document.createElement("span");
      who.className = "mono";
      who.textContent = `${m.who} · ${m.when}`;
      const text = document.createElement("p");
      text.textContent = m.text;
      row.append(who, text);
      payload.append(row);
    }
  }
  try {
    await drawPayload();
  } catch (err) {
    payloadHead.textContent = err.message || "couldn't gather that stretch";
    return;
  }
  go.disabled = false;

  const summonBody = () => lens === "ask"
    ? { chat: state.chat, from: bounds.from, to: bounds.to,
        shown: preview.fingerprint, question: question.value.trim() }
    : lens === "assist"
    ? { chat: state.chat, from: bounds.from, to: bounds.to,
        shown: preview.fingerprint, lens: "assist" }
    : { chat: state.chat, from: bounds.from, to: bounds.to,
        shown: preview.fingerprint, lens: "reflect", mode: lens };
  let summonConsent = null;

  ({ disarm } = armTwoTap(go, {
    guard: () => {
      if (lens === "ask" && !question.value.trim()) {
        note.textContent = "nothing asked yet";
        return false;
      }
      if (go.dataset.armed === "1" && !summonConsent) {
        note.textContent = "arming the exact stretch…";
        return false;
      }
      return true;
    },
    armedLabel: () => `→ Anthropic · ${preview.model} · send ` +
      `${preview.count} message${preview.count === 1 ? "" : "s"}?`,
    restLabel: "summon",
    timeoutMs: 5000,
    onArm: (armed) => {
      if (!armed) return;
      summonConsent = null;
      const payload = summonBody();
      armCrossing("summon", payload)
        .then((token) => { summonConsent = token; })
        .catch((err) => { note.textContent = err.message; });
    },
    onFire: async () => {
      go.disabled = true;
      note.textContent = "summoning…";
      const body = { ...summonBody(), _consent: summonConsent };
      try {
        const res = await fetch("/api/summon", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = await res.json();
        summonConsent = null;
        if (res.status === 409 && d.stale) {
          // the stretch changed under the card — redraw, never send blind
          note.textContent = d.error;
          await drawPayload().catch(() => {});
          go.disabled = false;
          return;
        }
        if (!res.ok) throw new Error(d.error);
        note.textContent = "";
        if (lens === "ask") showAnswer(d.entry);
        else if (lens === "assist") showAssist(d.entry);
        else if (d.done) showClosing(d.closing);  // a lens may close at once
        else startInterview(d);
      } catch (err) {
        note.textContent = err.message || "couldn't reach the server";
        go.disabled = false;
      }
    },
  }));

  // the desk hand's findings: a note plus tappable actions, kept as ink
  function showAssist(entry) {
    lenses.remove(); question.remove(); go.remove();
    payloadHead.textContent = "the desk hand — actionable matter:";
    payload.textContent = "";
    const noteEl = document.createElement("p");
    noteEl.className = "summon-answer";
    noteEl.textContent = entry.note;
    payload.append(noteEl);
    if ((entry.actions || []).length) {
      payload.append(assistActions(entry.actions));
    } else {
      const none = document.createElement("p");
      none.className = "mono summon-kept";
      none.textContent = "nothing actionable surfaced in this stretch";
      payload.append(none);
    }
    const kept = document.createElement("p");
    kept.className = "mono summon-kept";
    kept.textContent = entry.dry
      ? "rehearsed only — this server never summons"
      : "kept as private ink — each action opens in a new tab, only when "
        + "you tap it";
    payload.append(kept);
    refreshMargins();
  }

  // the lens closed without needing an interview — show what it named
  function showClosing(closing) {
    lenses.remove(); question.remove(); go.remove();
    payloadHead.textContent = `the reflection lens · ${lens}`;
    payload.textContent = "";
    const qEl = document.createElement("p");
    qEl.className = "summon-interview-q summon-closing";
    qEl.textContent = closing;
    const kept = document.createElement("p");
    kept.className = "mono summon-kept";
    kept.textContent = "the lens closed — kept as private ink in your journal";
    payload.append(qEl, kept);
    refreshMargins();
  }

  // a plain ask: the answer lands, already kept as private ink
  function showAnswer(entry) {
    lenses.remove(); question.remove(); go.remove();
    payloadHead.textContent = `you asked: ${entry.question}`;
    payload.textContent = "";
    const ans = document.createElement("p");
    ans.className = "summon-answer";
    ans.textContent = entry.answer;
    payload.append(ans);
    const kept = document.createElement("p");
    kept.className = "mono summon-kept";
    kept.textContent = entry.dry
      ? "rehearsed only — this server never summons"
      : "kept as private ink — it lives in your journal now";
    const toBubble = document.createElement("button");
    toBubble.className = "quiet mono";
    toBubble.textContent = "→ bubble";
    toBubble.title = "hand this to the bubble as a draft — sending still " +
      "takes your own two taps";
    toBubble.addEventListener("click", () => {
      bubbleDraft(entry.answer);
      toBubble.textContent = "drafted ✓";
    });
    payload.append(kept, toBubble);
    refreshMargins();
  }

  // the reflection lens: a live interview, one question at a time
  function startInterview(d) {
    interviewLive = true;
    lenses.remove(); question.remove(); go.remove();
    payloadHead.textContent = `the reflection lens · ${lens} — one question ` +
      `at a time; your answers travel too`;
    payload.textContent = "";
    const qEl = document.createElement("p");
    qEl.className = "summon-interview-q";
    const aEl = document.createElement("textarea");
    aEl.className = "summon-question";
    aEl.rows = 3;
    aEl.placeholder = "answer honestly — one true sentence is plenty";
    const send = document.createElement("button");
    send.className = "summon-go mono";
    send.textContent = "answer";
    payload.append(qEl, aEl, send);
    qEl.textContent = d.question;
    aEl.focus();
    send.addEventListener("click", async () => {
      const answer = aEl.value.trim();
      if (!answer) { note.textContent = "an answer first"; return; }
      send.disabled = true;
      note.textContent = "…";
      try {
        const res = await fetch("/api/summon", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: d.session, answer }),
        });
        const t = await res.json();
        if (!res.ok) throw new Error(t.error);
        note.textContent = "";
        if (t.done) {
          interviewLive = false;
          qEl.textContent = t.closing;
          qEl.classList.add("summon-closing");
          aEl.remove(); send.remove();
          const kept = document.createElement("p");
          kept.className = "mono summon-kept";
          kept.textContent = "the lens closed — the whole interview is " +
            "kept as private ink in your journal";
          payload.append(kept);
          refreshMargins();
        } else {
          qEl.textContent = t.question;
          aEl.value = "";
          aEl.focus();
          send.disabled = false;
        }
      } catch (err) {
        note.textContent = err.message || "couldn't reach the server";
        send.disabled = false;
      }
    });
  }

  async function refreshMargins() {
    if (state.facet === "notes" || state.facet === "desk") {
      const q = encodeURIComponent(state.chat);
      const s = await (await fetch(`/api/summons?chat=${q}`)).json();
      state.summons = s.summons || [];
      syncIntelligenceOverlay();
      if (state.facet === "notes") renderNotesFacet($("panel-body"));
      else renderDeskFacet($("panel-body"));
    }
  }
}

// ---- the ledger: marks as the working document of the pair -------------------

const ledger = { emoji: null, showSettled: false };
// a leading dialect mark plus its optional variation selector and spacing
const LEADING_MARK =
  /^\s*[\u{1F4CC}\u{1F525}\u2753\u{1FA77}\u2705\u{1F44D}]\uFE0F?\s*/u;
const MARK_LABELS = {
  "📌": "decision", "🔥": "idea", "❓": "question",
  "🩷": "keepsake", "✅": "done", "👍": "agreed",
};
// a mark is dimmed (hidden by default, struck through) only when finished;
// "resurfaced" is live-with-attention — always shown, never struck
const DIMMED = (s) => s === "settled" || s === "answered";

// the thread key the server merged this chat under (set in openThread) —
// the one place that rule lives now; the client no longer re-derives it
function seenKey() { return "wl-seen-" + (state.chatKey || state.chat); }
function newMarksCount() {
  const last = +localStorage.getItem(seenKey()) || 0;
  return state.markers.filter((m) => m.date_unix > last).length;
}
function markSeen() {
  if (state.markers.length) {
    localStorage.setItem(seenKey(),
      String(Math.max(...state.markers.map((m) => m.date_unix))));
  }
  refreshPinBadge();
}
function refreshPinBadge() {
  const n = newMarksCount();
  $("pin-count").textContent =
    state.markers.length + (n ? ` +${n} new` : "");
  document.querySelector('.facet[data-facet="pins"]')
    ?.classList.toggle("has-new", n > 0);
  syncHandle();
}

function renderLedger(body) {
  body.textContent = "";

  // declare a decision that was never a message — it lands in the thread
  const declare = document.createElement("div");
  declare.className = "ledger-declare";
  const pick = document.createElement("select");
  pick.setAttribute("aria-label", "mark kind");
  for (const e of MARKS) {
    const o = document.createElement("option");
    o.value = e; o.textContent = `${markGlyph(e)} ${MARK_LABELS[e]}`;
    pick.append(o);
  }
  const input = document.createElement("input");
  input.setAttribute("aria-label", "decision text");
  input.placeholder = "declare it — lands in the real thread…";
  input.maxLength = 220;
  const send = document.createElement("button");
  send.textContent = "send to the thread";
  let declareConsent = null;
  const { tap: doDeclare, disarm: disarmDeclare } = armTwoTap(send, {
    guard: () => {
      if (!input.value.trim()) return false;
      if (send.dataset.armed === "1" && !declareConsent) {
        send.textContent = "arming…";
        return false;
      }
      return true;
    },
    armedLabel: () => `send ${pick.value} into iMessage?`,
    restLabel: "send to the thread",
    timeoutMs: 4000,
    onArm: (armed) => {
      if (!armed) return;
      declareConsent = null;
      armCrossing("pinback", { chat: state.chat, text: input.value.trim(),
                               emoji: pick.value })
        .then((token) => { declareConsent = token; })
        .catch((err) => { send.textContent = err.message; });
    },
    onFire: async () => {
      const markText = input.value.trim();
      const markEmoji = pick.value;
      send.disabled = true;
      send.textContent = "sending…";
      try {
        const res = await fetch("/api/pinback", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat: state.chat, text: markText,
                                 emoji: markEmoji,
                                 _consent: declareConsent }),
        });
        declareConsent = null;
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `the Mac answered ${res.status}`);
        send.textContent = d.dry ? "would send ✓ (demo)" : "declared ✓";
        input.value = "";
        if (d.sent) setTimeout(() => openFacet("pins"), 3500);
      } catch (e) {
        send.textContent = (e.message || "couldn't reach the Mac").slice(0, 34);
      } finally {
        send.disabled = false;
      }
      setTimeout(() => { send.textContent = "send to the thread"; }, 4000);
    },
  });
  input.addEventListener("input", disarmDeclare);
  pick.addEventListener("change", disarmDeclare);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doDeclare(); });
  declare.append(pick, input, send);
  body.append(declare);

  // filters: kind + settled visibility + the minutes
  const bar = document.createElement("div");
  bar.className = "ledger-bar";
  const chip = (label, active, fn) => {
    const b = document.createElement("button");
    b.className = "quiet mono" + (active ? " ledger-on" : "");
    b.textContent = label;
    b.addEventListener("click", () => { fn(); renderLedger(body); });
    return b;
  };
  bar.append(chip("all marks", ledger.emoji === null, () => (ledger.emoji = null)));
  // one chip per mark in the dialect — only show kinds that actually occur,
  // so the row stays calm on a thread that only uses a couple
  const present = new Set(state.markers.map((m) => m.emoji));
  for (const e of MARKS) {
    if (!present.has(e)) continue;
    bar.append(chip(`${markGlyph(e)} ${MARK_LABELS[e]}`, ledger.emoji === e,
      () => (ledger.emoji = e)));
  }
  bar.append(chip(ledger.showSettled ? "hide settled" : "show settled",
    ledger.showSettled, () => (ledger.showSettled = !ledger.showSettled)));
  const minutes = document.createElement("button");
  minutes.className = "quiet mono";
  minutes.textContent = "copy the minutes";
  minutes.title = "the ledger as markdown — decisions, questions, fires";
  minutes.addEventListener("click", async () => {
    try {
      const params = new URLSearchParams({ chat: state.chat, pins: "1" });
      if (ledger.emoji) params.set("emoji", ledger.emoji);
      const response = await fetch(`/api/export?${params}`);
      const d = await response.json();
      if (!response.ok) throw new Error(d.error || "export failed");
      const ok = await copyText(
        `# the minutes — ${$("thread-name").textContent}\n\n` + d.markdown);
      minutes.textContent = ok ? `copied — ${d.count} marks`
                               : "couldn't copy here — use export…";
    } catch (error) {
      minutes.textContent = "couldn't make minutes — try again";
    }
    setTimeout(() => { minutes.textContent = "copy the minutes"; }, 2000);
  });
  bar.append(minutes);
  body.append(bar);

  const last = +localStorage.getItem(seenKey()) || 0;
  const rows = state.markers.filter((m) =>
    (ledger.emoji === null || m.emoji === ledger.emoji) &&
    (ledger.showSettled || !DIMMED(m.state)));
  if (!rows.length) {
    const live = (e) => state.markers.filter(
      (m) => m.emoji === e && !DIMMED(m.state)).length;
    const liveSummary = MARKS.map((e) => `${e} ${live(e)}`)
      .filter((s) => !s.endsWith(" 0")).join(" · ");
    const census = liveSummary ? `live now: ${liveSummary}` : "none live";
    return emptyAside(body, state.markers.length
      ? `None of this kind are live — ${census}. Declare one above, or widen the filter.`
      : "No marks yet — put 📌 🔥 ❓ 🩷 ✅ 👍 in a message, tapback one, or declare one above.");
  }
  for (const m of [...rows].reverse()) {
    const row = panelRow(m, { tag: m.source, marker: true });
    row.classList.add("ledger-row");
    if (DIMMED(m.state)) row.classList.add("ledger-settled");
    if (m.state === "resurfaced") row.classList.add("ledger-resurfaced");
    const glyph = document.createElement("span");
    glyph.className = "ledger-glyph";
    glyph.textContent = markGlyph(m.emoji);
    row.prepend(glyph);
    // The row's own ink glyph already states the kind, so a preview that
    // still leads with the typed emoji read doubled: "◆📌 launch video…".
    // Drop the leading emoji from the PREVIEW only — the message itself is
    // untouched and still shows its 📌 in the stream.
    // Strip with a REGEX, never by slicing emoji.length: a dialect emoji may
    // carry a variation selector, and the arithmetic ate the first real letter
    // of the message ("glad you're back" rendered as "lad you're back").
    const prev = row.querySelector(".preview");
    if (prev) {
      prev.textContent = prev.textContent.replace(LEADING_MARK, "");
    }
    if (m.state === "resurfaced") {
      const rs = document.createElement("span");
      rs.className = "mono ledger-resurf-tag";
      rs.textContent = "↻ still on";
      row.querySelector(".meta").append(" · ", rs);
    } else if (m.date_unix > last) {
      const nu = document.createElement("span");
      nu.className = "mono ledger-new";
      nu.textContent = "new";
      row.querySelector(".meta").append(" · ", nu);
    }
    const st = document.createElement("button");
    st.className = "quiet mono ledger-state";
    st.textContent = DIMMED(m.state)
      ? "reopen" : MARK_DIALECT[m.emoji]?.settleWord || "settle";
    st.addEventListener("click", async (e) => {
      e.stopPropagation();
      const next = DIMMED(m.state)
        ? "live" : (m.emoji === "❓" ? "answered" : "settled");
      st.disabled = true;
      st.textContent = "saving…";
      try {
        const response = await fetch("/api/markstate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat: state.chat, rowid: m.rowid, state: next }),
        });
        const d = await response.json();
        if (!response.ok) throw new Error(d.error || "mark update failed");
        m.state = d.state || next;
        syncMapData();
        renderLedger(body);
      } catch (error) {
        st.disabled = false;
        st.textContent = "try again";
      }
    });
    row.append(st);
    body.append(row);
  }
}

function renderChaptersFacet(body) {
  body.textContent = "";
  const at = timeline.visibleDate();
  const addRow = document.createElement("div");
  addRow.className = "chapter-add";
  const input = document.createElement("input");
  input.placeholder = "name this era…";
  input.maxLength = 60;
  const btn = document.createElement("button");
  const when = at ? new Date(at * 1000).toLocaleDateString([], {
    year: "numeric", month: "short", day: "numeric" }) : "here";
  btn.textContent = `begin at ${when}`;
  const add = async () => {
    if (!input.value.trim() || !at) return;
    const res = await fetch("/api/chapters", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: state.chat, ts: at, title: input.value }),
    });
    state.chapters = (await res.json()).chapters;
    syncMapData();
    renderChaptersFacet(body);
  };
  btn.addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  addRow.append(input, btn);
  body.append(addRow);

  if (!state.chapters?.length) {
    return emptyAside(body,
      "No chapters yet — scroll to where an era began, then name it.");
  }
  for (const c of [...state.chapters].reverse()) {
    const row = document.createElement("div");
    row.className = "panel-row chapter-row";
    const go = document.createElement("button");
    go.className = "quiet chapter-title";
    go.textContent = c.title;
    go.addEventListener("click", () => { stopPlaying(); timeline.jump(c.ts); });
    const meta = document.createElement("span");
    meta.className = "meta mono";
    meta.textContent = new Date(c.ts * 1000).toLocaleDateString([], {
      year: "numeric", month: "long", day: "numeric" });
    const del = document.createElement("button");
    del.className = "quiet chapter-del";
    del.title = "remove this chapter";
    del.textContent = "✕";
    del.addEventListener("click", async () => {
      const res = await fetch("/api/chapters", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: state.chat, ts: c.ts, remove: true }),
      });
      state.chapters = (await res.json()).chapters;
      syncMapData();
      renderChaptersFacet(body);
    });
    row.append(go, meta, del);
    body.append(row);
  }
}

// wrapped over any window: quick spans, custom dates, year/month grain
const wrappedState = { from: "", to: "", bucket: "year" };

function renderWrappedControls(body) {
  const bar = document.createElement("div");
  bar.className = "wrapped-controls";
  const chip = (label, fn) => {
    const b = document.createElement("button");
    b.className = "quiet mono";
    b.textContent = label;
    b.addEventListener("click", (event) => { fn(event); syncInputs(); refreshWrapped(); });
    return b;
  };
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const fromInput = document.createElement("input");
  fromInput.type = "date"; fromInput.id = "wrapped-from";
  const toInput = document.createElement("input");
  toInput.type = "date"; toInput.id = "wrapped-to";
  const syncInputs = () => {
    fromInput.value = wrappedState.from; toInput.value = wrappedState.to;
  };
  for (const el of [fromInput, toInput]) {
    el.addEventListener("change", () => {
      wrappedState.from = fromInput.value; wrappedState.to = toInput.value;
      refreshWrapped();
    });
  }
  const grain = chip("by month", () => {
    wrappedState.bucket = wrappedState.bucket === "year" ? "month" : "year";
    grain.textContent = wrappedState.bucket === "year" ? "by month" : "by year";
  });
  bar.append(
    chip("everything", () => { wrappedState.from = ""; wrappedState.to = ""; }),
    chip("this year", () => {
      wrappedState.from = `${now.getFullYear()}-01-01`; wrappedState.to = "";
      wrappedState.bucket = "month"; grain.textContent = "by year";
    }),
    chip("90 days", () => {
      wrappedState.from = iso(new Date(Date.now() - 90 * 86400e3));
      wrappedState.to = "";
      wrappedState.bucket = "month"; grain.textContent = "by year";
    }),
    fromInput, toInput, grain,
    chip("keep as image", (event) => downloadWrappedCard(event.currentTarget)),
    chip("keep board", (event) => downloadWrappedBoard(event.currentTarget)),
  );
  // the ambient full-screen board (board.html) — stats + on-this-day echoes
  const boardLink = document.createElement("a");
  boardLink.className = "quiet mono";
  boardLink.href = `board.html?chat=${encodeURIComponent(state.chat)}`;
  boardLink.target = "_blank";
  boardLink.rel = "noopener";
  boardLink.textContent = "board view";
  bar.append(boardLink);
  body.append(bar);
  const cards = document.createElement("div");
  cards.id = "wrapped-cards";
  body.append(cards);
  syncInputs();
}

async function refreshWrapped() {
  const cards = document.getElementById("wrapped-cards");
  if (!cards) return;
  cards.textContent = "…";
  const params = new URLSearchParams({ chat: state.chat,
                                       bucket: wrappedState.bucket });
  if (wrappedState.from)
    params.set("from", Date.parse(wrappedState.from + "T00:00:00") / 1000);
  if (wrappedState.to)
    params.set("to", Date.parse(wrappedState.to + "T23:59:59") / 1000);
  const data = await (await fetch(`/api/wrapped?${params}`)).json();
  wrappedState.last = data;
  cards.textContent = "";
  renderWrapped(cards, data);
}

function renderWrapped(body, data) {
  if (!data.alltime) return emptyAside(body, "Nothing in that window.");
  const a = data.alltime;
  const hero = document.createElement("div");
  hero.className = "wrapped-hero";
  const big = document.createElement("span");
  big.className = "wrapped-big";
  big.textContent = a.total.toLocaleString();
  const sub = document.createElement("span");
  sub.className = "mono";
  sub.textContent = `messages · ${a.first_day} → ${a.last_day} · longest streak ` +
    `${a.longest_streak} days (${a.streak_year}) · ${a.marks} marks`;
  hero.append(big, sub);
  body.append(hero);
  renderWrappedBoard(body, data);
  for (const y of [...data.years].reverse()) {
    const card = document.createElement("div");
    card.className = "wrapped-year";
    const h = document.createElement("span");
    h.className = "wrapped-y";
    h.textContent = y.year;
    const line = document.createElement("span");
    line.className = "mono";
    const opener = y.first_texts_me >= y.first_texts_them ? "you" : "them";
    line.textContent =
      `${(y.me + y.them).toLocaleString()} messages · you ${y.me.toLocaleString()}` +
      ` / them ${y.them.toLocaleString()} · ${y.days_talked} days · ` +
      `streak ${y.longest_streak} · busiest ${y.busiest_day} (${y.busiest_n})` +
      ` · ${opener} opened most days · ${y.marks} marks`;
    card.append(h, line);
    body.append(card);
  }
}

const WRAPPED_BOARD_COLUMNS = 22;

function wrappedBoardLine(value) {
  const clean = String(value || "").normalize("NFKD")
    .replace(/[^ A-Za-z0-9>.:/+-]/g, "")
    .toUpperCase().slice(0, WRAPPED_BOARD_COLUMNS);
  const left = Math.floor((WRAPPED_BOARD_COLUMNS - clean.length) / 2);
  return `${" ".repeat(left)}${clean}`.padEnd(WRAPPED_BOARD_COLUMNS, " ");
}

function wrappedBoardLines(data) {
  const a = data.alltime;
  const years = data.years || [];
  const firstYear = String(a.first_day || "").slice(0, 4);
  const lastYear = String(a.last_day || "").slice(0, 4);
  const days = years.reduce((sum, period) =>
    sum + Number(period.days_talked || 0), 0);
  const number = (value) => Number(value || 0).toLocaleString("en-US");
  return [
    "ZETTEL WRAPPED",
    `${firstYear} > ${lastYear}`,
    `${number(a.total)} MESSAGES`,
    `${number(days)} DAYS IN TOUCH`,
    `${number(a.longest_streak)} DAY STREAK`,
    `${number(a.marks)} MARKS KEPT`,
  ].map(wrappedBoardLine);
}

function renderWrappedBoard(body, data) {
  const lines = wrappedBoardLines(data);
  const shell = document.createElement("section");
  shell.className = "wrapped-board-shell";
  const meta = document.createElement("span");
  meta.className = "mono wrapped-board-meta";
  meta.textContent = "split-flap dispatch · 6 x 22 · private preview";
  const board = document.createElement("div");
  board.className = "wrapped-board";
  board.setAttribute("role", "img");
  board.setAttribute("aria-label",
    `Vestaboard-style Wrapped preview: ${lines.map((line) => line.trim()).join(". ")}`);
  board.dataset.lines = JSON.stringify(lines);
  // Split-flap settle: each flap carries its own --flap-delay / --flap-dur
  // (a diagonal wave + random jitter) so the dispatch riffles into place
  // rather than sweeping in a rigid line; the amber accent flap lands last.
  // Delay/duration are CSS custom props, so the animation is declarative,
  // survives the preview panel, and honours reduced-motion / calm e-ink.
  const lastDelay = (lines.length + 21) * 34 + 320; // after the whole board
  lines.forEach((line, r) => {
    const row = document.createElement("div");
    row.className = "wrapped-board-row";
    [...line].forEach((character, c) => {
      const flap = document.createElement("span");
      const accent = character === ">";
      flap.className = "wrapped-flap" + (accent ? " is-accent" : "");
      flap.textContent = character === " " ? "\u00a0" : character;
      flap.setAttribute("aria-hidden", "true");
      // Organic settle: a soft top-left -> bottom-right diagonal wave with a
      // little random jitter, so the board riffles into place instead of
      // sweeping in a rigid line. The amber accent flap lands last.
      const wave = (r + c) * 34;
      const delay = accent ? lastDelay : wave + Math.random() * 130;
      flap.style.setProperty("--flap-delay", `${Math.round(delay)}ms`);
      flap.style.setProperty("--flap-dur", `${Math.round(300 + Math.random() * 160)}ms`);
      row.append(flap);
    });
    board.append(row);
  });
  shell.append(meta, board);
  body.append(shell);
}

// the wrapped card as a keepable PNG — the one artifact meant to leave the
// machine, so it carries numbers only: no names, no handles, no words.
function wrappedCardCanvas(data) {
  const a = data.alltime;
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  const PAPER = "#f6f2e9", CARD = "#faf8f2", INK = "#1c1a15",
        FADE = "#6f685c", RULE = "#d8d1c1", AMBER = "#e8720c";
  const mono = (px) => `${px}px ui-monospace, Menlo, monospace`;
  x.fillStyle = PAPER; x.fillRect(0, 0, W, H);
  x.fillStyle = CARD;
  x.strokeStyle = INK; x.lineWidth = 3;
  x.beginPath(); x.roundRect(48, 48, W - 96, H - 96, 8);
  x.fill(); x.stroke();

  x.fillStyle = FADE; x.font = mono(24); x.textAlign = "center";
  x.fillText(`${a.first_day}  →  ${a.last_day}`, W / 2, 168);

  x.fillStyle = INK; x.font = "600 176px Georgia, serif";
  x.fillText(a.total.toLocaleString(), W / 2, 400);
  x.fillStyle = FADE; x.font = mono(28);
  x.fillText("messages", W / 2, 460);
  x.fillText(`longest streak ${a.longest_streak} days (${a.streak_year})` +
             `  ·  ${a.marks.toLocaleString()} marks`, W / 2, 540);

  // the years as a waveform: you above the line, them below
  const years = data.years || [];
  if (years.length) {
    const midY = 830, maxBar = 190;
    const left = 140, span = W - 2 * left;
    const slot = span / years.length;
    const bw = Math.min(56, slot * 0.55);
    const peak = Math.max(...years.map((y) => Math.max(y.me, y.them)), 1);
    const busiest = years.reduce((p, y) =>
      (y.me + y.them > p.me + p.them ? y : p), years[0]);
    x.strokeStyle = RULE; x.lineWidth = 1;
    x.beginPath(); x.moveTo(left, midY); x.lineTo(left + span, midY); x.stroke();
    years.forEach((y, i) => {
      const cx = left + slot * (i + 0.5);
      const up = Math.max(3, (y.me / peak) * maxBar);
      const dn = Math.max(3, (y.them / peak) * maxBar);
      x.fillStyle = y === busiest ? AMBER : INK;
      x.beginPath(); x.roundRect(cx - bw / 2, midY - up, bw, up, 3); x.fill();
      x.globalAlpha = 0.55;
      x.beginPath(); x.roundRect(cx - bw / 2, midY, bw, dn, 3); x.fill();
      x.globalAlpha = 1;
      x.fillStyle = FADE; x.font = mono(Math.min(22, slot * 0.32));
      const label = String(y.year);
      if (years.length <= 12 || i % 2 === 0 || y === busiest)
        x.fillText(label, cx, midY + maxBar + 48);
    });
    x.fillStyle = FADE; x.font = mono(22);
    x.textAlign = "left";
    x.fillText("you", left, midY - maxBar - 16);
    x.fillText("them", left, midY + maxBar + 10);
    x.textAlign = "center";
  }

  x.strokeStyle = RULE; x.lineWidth = 1;
  x.beginPath(); x.moveTo(120, H - 190); x.lineTo(W - 120, H - 190); x.stroke();
  // wordmark + the public address. This PNG is the ONE artifact built to
  // leave the machine, so it is the one place the name has to be current —
  // it shipped carrying the pre-rename wordmark to everyone it was sent to.
  x.fillStyle = FADE; x.font = mono(24);
  x.fillText("made with zettel · zettel.ink", W / 2, H - 118);
  return c;
}

function wrappedBoardCanvas(data) {
  const lines = wrappedBoardLines(data);
  const W = 1100, H = 420, pad = 24, gap = 4;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  const cellW = (W - pad * 2 - gap * 21) / 22;
  const cellH = (H - pad * 2 - gap * 5) / 6;
  x.fillStyle = "#10100f"; x.fillRect(0, 0, W, H);
  x.textAlign = "center"; x.textBaseline = "middle";
  x.font = "600 25px ui-monospace, Menlo, monospace";
  lines.forEach((line, row) => {
    [...line].forEach((character, column) => {
      const xx = pad + column * (cellW + gap);
      const yy = pad + row * (cellH + gap);
      x.fillStyle = character === ">" ? "#e8720c" : "#242421";
      x.fillRect(xx, yy, cellW, cellH);
      x.strokeStyle = character === ">" ? "#e8720c" : "#454540";
      x.strokeRect(xx + 0.5, yy + 0.5, cellW - 1, cellH - 1);
      x.strokeStyle = "rgba(0,0,0,.55)";
      x.beginPath(); x.moveTo(xx + 2, yy + cellH / 2);
      x.lineTo(xx + cellW - 2, yy + cellH / 2); x.stroke();
      if (character !== " ") {
        x.fillStyle = character === ">" ? "#1c1a15" : "#faf8f2";
        x.fillText(character, xx + cellW / 2, yy + cellH / 2 + 1);
      }
    });
  });
  return c;
}

window.__wrapped = { state: wrappedState, card: wrappedCardCanvas,
                     board: wrappedBoardCanvas, boardLines: wrappedBoardLines,
                     controls: renderWrappedControls };

function saveWrappedCanvas(canvas, filename, button, savedLabel) {
  canvas.toBlob((blob) => {
    if (!blob) {
      if (button) button.textContent = "try again";
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    document.body.dataset.lastWrappedDownload = filename;
    if (button) {
      const original = button.dataset.downloadLabel || button.textContent;
      button.dataset.downloadLabel = original;
      button.textContent = savedLabel;
      window.setTimeout(() => { button.textContent = original; }, 1600);
    }
    // Give the browser time to claim the Blob before releasing its URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }, "image/png");
}

function downloadWrappedCard(button) {
  const data = wrappedState.last;
  if (!data || !data.alltime) return;
  const c = wrappedCardCanvas(data);
  const span = [wrappedState.from, wrappedState.to].filter(Boolean)
    .join("_") || "everything";
  saveWrappedCanvas(c, `zettel-wrapped-${span}.png`, button, "image saved");
}

function downloadWrappedBoard(button) {
  const data = wrappedState.last;
  if (!data || !data.alltime) return;
  const c = wrappedBoardCanvas(data);
  const span = [wrappedState.from, wrappedState.to].filter(Boolean)
    .join("_") || "everything";
  saveWrappedCanvas(c, `zettel-board-${span}.png`, button, "board saved");
}

function emptyAside(body, text) {
  const p = document.createElement("p");
  p.className = "aside";
  p.textContent = text;
  body.append(p);
}

function panelRow(item, { tag, urls, marker = false } = {}) {
  const btn = document.createElement("button");
  btn.className = "panel-row";
  const prev = document.createElement("span");
  prev.className = "preview";
  prev.textContent = item.preview || "[no text]";
  const meta = document.createElement("span");
  meta.className = "meta mono";
  const when = new Date(item.date_unix * 1000).toLocaleDateString([], {
    year: "numeric", month: "short", day: "numeric",
  });
  const threadTag = item.thread
    ? " · in " + (state.threads?.find(
        (t) => t.key === item.thread)?.display_name ||
        state.aliases[item.thread] || item.thread)
    : "";
  meta.textContent = `${when} · ${item.from_me ? "me" : "them"}${tag ? " · " + tag : ""}${threadTag}`;
  btn.append(prev, meta);
  if (urls && urls.length) {
    const u = document.createElement("span");
    u.className = "urls";
    for (const url of urls) {
      // a link in this panel came out of a message SOMEONE ELSE sent. The
      // summons' action buttons have always refused a non-http destination;
      // this row handed the raw string to a.href and made `javascript:` a
      // tap away. Same gate, one home (shared.js), so they cannot drift.
      const safe = safeHttpUrl(url);
      if (!safe) {
        // never silently drop it — the record shows what was there, inert
        const flat = document.createElement("span");
        flat.className = "mono";
        flat.textContent = url;
        u.append(flat, " ");
        continue;
      }
      const a = document.createElement("a");
      a.href = safe.href; a.textContent = url;
      a.target = "_blank"; a.rel = "noopener noreferrer";
      a.addEventListener("click", (e) => e.stopPropagation());
      u.append(a, " ");
    }
    btn.append(u);
  }
  btn.addEventListener("click", async () => {
    stopPlaying();
    if (item.thread) {
      // a hit from another conversation: travel there first
      const t = state.threads?.find((x) => x.key === item.thread);
      if (t) {
        $("thread-pick").value = t.identifier;
        await openThread(t.identifier, state.threads);
      }
      timeline.jump(item.date_unix, item.rowid);
      return;
    }
    marker ? jumpToMarker(item) : timeline.jump(item.date_unix, item.rowid);
  });
  return btn;
}

function thumbCell(it) {
  const btn = document.createElement("button");
  btn.className = "thumb";
  btn.title = new Date(it.date_unix * 1000).toLocaleDateString();
  if (it.mime.startsWith("image/")) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = it.name;
    const thumb = it.mime === "image/heic" ? "?thumb=1" : "";
    img.src = window.__demoAtt(it.att_rowid, thumb);
    img.onerror = () => {
      const s = document.createElement("span");
      s.className = "mono";
      s.textContent = it.name;
      img.replaceWith(s);
    };
    btn.append(img);
  } else {
    const s = document.createElement("span");
    s.className = "mono";
    s.textContent = it.name;
    btn.append(s);
  }
  btn.addEventListener("click", () => {
    stopPlaying();
    timeline.jump(it.date_unix, it.rowid);
  });
  return btn;
}

// ---- search --------------------------------------------------------------------------

function runSearch() {
  if (isImported(state.chat)) return;
  const q = $("search").value.trim();
  if (!q) return;
  state.searchQuery = q;
  state.facet = null; // force fresh even if search was already active
  openFacet("search");
}

// ---- export: high-fidelity copy, download, and the Claude handoff --------------------

function localDateValue(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function openExport() {
  if (isImported(state.chat)) return;
  const ts = timeline.visibleDate();
  if (ts) {
    $("export-from").value = localDateValue(ts);
    $("export-to").value = localDateValue(ts);
  }
  $("export-note").textContent = "";
  $("export").classList.add("open");
}
function closeExport() { $("export").classList.remove("open"); }

async function fetchExport(action) {
  const params = new URLSearchParams({ chat: state.chat });
  const from = $("export-from").value;
  const to = $("export-to").value;
  if (from) params.set("from", Date.parse(from + "T00:00:00") / 1000);
  if (to) params.set("to", Date.parse(to + "T23:59:59") / 1000);
  if ($("export-pins").checked) params.set("pins", "1");
  if (action === "claude") params.set("handoff", "1");
  $("export-note").textContent = "gathering…";
  const data = await (await fetch(`/api/export?${params}`)).json();
  const rangeNote = $("export-pins").checked ? "pins"
    : (from || to) ? `${from || "start"} → ${to || "now"}` : "everything";
  data.header = `# ${data.title} — ${rangeNote}\n\n`;
  return data;
}

function downloadMd(name, text) {
  const blob = new Blob([text], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function doExport(action) {
  try {
    const data = await fetchExport(action);
    if (!data.count) {
      $("export-note").textContent = "nothing in that range";
      return;
    }
    const md = data.header + data.markdown;
    const stem = `${state.chat.replace(/[^\w+-]/g, "_")}-${
      $("export-pins").checked ? "pins" : ($("export-from").value || "all")}`;
    if (action === "copy") {
      const ok = await copyText(md);
      $("export-note").textContent = ok
        ? `copied — ${data.count.toLocaleString()} messages`
        : "copy is blocked on this device — download .md instead";
    } else if (action === "download") {
      downloadMd(`zettel-${stem}.md`, md);
      $("export-note").textContent = `downloaded — ${data.count.toLocaleString()} messages`;
    } else if (action === "claude") {
      // The handoff has to actually ARRIVE. Small transcripts ride the
      // composer's own ?q= and land already in the box; big ones land on
      // the clipboard with the new thread open beside them — one paste.
      // The file download remains only as the fallback when the clipboard
      // is blocked, because a download that hopes is not a handoff.
      const handoff = data.header + (data.handoff || data.markdown);
      const copied = await copyText(handoff);
      const url = handoff.length < 6000
        ? "https://claude.ai/new?q=" + encodeURIComponent(handoff)
        : "https://claude.ai/new";
      window.open(url, "_blank", "noopener");
      if (handoff.length < 6000) {
        $("export-note").textContent =
          `${data.count.toLocaleString()} messages — waiting in the composer`;
      } else if (copied) {
        $("export-note").textContent =
          `${data.count.toLocaleString()} messages copied — paste (⌘V) into the new thread`;
      } else {
        downloadMd(`zettel-handoff-${stem}.md`, data.handoff || md);
        $("export-note").textContent =
        `downloaded — ${data.count.toLocaleString()} messages. ` +
        "attach the file in Claude; it knows how to be read.";
      }
    }
  } catch (e) {
    $("export-note").textContent = "that export took a strange turn — try again?";
  }
}

// c: copy the selected message alone, full fidelity
async function copySelected() {
  const m = timeline.selected();
  if (!m) return;
  const d = new Date(m.date_unix * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const when = `${localDateValue(m.date_unix)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const who = m.from_me ? "Me" : state.aliases[m.handle] || m.handle || "?";
  const lines = [`[${when}] ${who}: ${m.text || "[no text]"}`];
  if (m.reply_to) lines.push(`  ↩ in reply to: “${m.reply_to.preview}”`);
  for (const a of m.attachments) lines.push(`  📎 ${a.name} (${a.mime || "file"})`);
  if (m.tapbacks.length) {
    lines.push("  reactions: " + m.tapbacks.map((t) =>
      `${t.emoji || TAPBACK_GLYPHS[t.kind] || "•"} ${
        t.from_me ? "Me" : state.aliases[t.handle] || t.handle || "?"}`).join(" · "));
  }
  await copyText(lines.join("\n"));
}

// ---- the bubble: your next message, composed where it will land --------------------------
// A dashed proposal at the stream's foot (dashed = proposal, solid =
// real). Keys or pen write INTO the bubble; send turns it into record and
// the landed message glows so it never sinks into the scroll unseen.
// Same two-tap covenant as everything that speaks.

function buildBubble() {
  const rest = $("bubble-rest"), card = $("bubble-card"),
        text = $("bubble-text"), ink = $("bubble-ink"),
        modeBtn = $("bubble-mode"), readBtn = $("bubble-read"),
        clearBtn = $("bubble-clear"), send = $("bubble-send"),
        away = $("bubble-away"), note = $("bubble-note");
  const LIMIT = 500;
  let watchTimer = null;
  let target = null; // where this draft will land; null = the open thread
  let armedTarget = null;
  let sayConsent = null;
  const targetId = () => target || state.chat;
  const targetName = (id) =>
    state.threads?.find((t) => t.identifier === id)?.display_name ||
    state.aliases[id] || id;
  const meta = $("bubble-meta"), moveBtn = $("bubble-move"),
        threadsBox = $("bubble-threads");
  const updateMeta = () => {
    const ro = isImported(targetId());
    meta.textContent = `me → ${targetName(targetId())} · ` +
      (ro ? "read-only (imported)" : "about to be");
    // a read-only target: the send button goes inert (a disabled button
    // can't even arm), and the note names the way to actually send
    send.disabled = ro;
    send.title = ro
      ? "imported threads are read-only — use “→ elsewhere” to send into iMessage"
      : "";
    if (ro) {
      note.textContent = `${targetName(targetId())} is imported — read-only. ` +
        `Tap “→ elsewhere” to send into an iMessage thread.`;
    } else if (note.textContent.includes("imported")) {
      note.textContent = "";
    }
  };
  const stopWatch = () => {
    if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
  };
  const collapse = () => {
    stopWatch();
    card.hidden = true; rest.hidden = false; note.textContent = ""; disarm();
    target = null; threadsBox.hidden = true;
    if (!text.textContent.trim()) { pendingPages = []; strokes = []; }
    const draft = text.textContent.trim();
    rest.textContent = draft            // a waiting draft shows through
      ? `✎ ${draft.slice(0, 48)}${draft.length > 48 ? "…" : ""}`
      : "✎ your next message…";
  };
  const swell = (e) => {
    stopWatch();
    rest.hidden = true; card.hidden = false;
    updateMeta();
    // a pen tap announces its own mode; fingers and keys get the keyboard
    setMode(e && e.pointerType === "pen" ? "ink" : "keys");
  };

  // move the draft out of this thread — words and ink travel together;
  // changing where it lands always demands a fresh two-tap
  moveBtn.addEventListener("click", () => {
    if (!threadsBox.hidden) { threadsBox.hidden = true; return; }
    threadsBox.textContent = "";
    for (const t of (state.threads || []).filter(
      (thread) => !isImported(thread.identifier))) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mono bubble-thread" +
        (t.identifier === targetId() ? " current" : "");
      b.textContent = (t.identifier === targetId() ? "→ " : "") +
        targetName(t.identifier);
      b.addEventListener("click", () => {
        target = t.identifier === state.chat ? null : t.identifier;
        threadsBox.hidden = true;
        disarm(); updateMeta();
        note.textContent = target
          ? `this will land in ${targetName(t.identifier)}'s thread`
          : "";
      });
      threadsBox.append(b);
    }
    threadsBox.hidden = false;
  });
  rest.addEventListener("click", swell);
  away.addEventListener("click", collapse); // ink and words wait, unsent
  // a draft handed in from the margins (the summons' "→ bubble") — it
  // waits in the resting bubble, disarmed; sending is still two taps here.
  // A waiting draft is never clobbered, and nothing is ever trimmed
  // silently: over the limit, the bubble's own counter takes over.
  bubbleDraft = (draft) => {
    const existing = text.textContent.trim();
    if (existing && existing !== (draft || "").trim()) return false;
    text.textContent = draft || "";
    disarm();
    collapse();
    if (text.textContent.length > LIMIT) {
      note.textContent =
        `${text.textContent.length} of ${LIMIT} — trim before it can send`;
    }
    return true;
  };
  bubbleThreadChanged = () => {
    disarm();
    if (target === null) updateMeta();
  };
  card.addEventListener("keydown", (e) => {
    if (e.key === "Escape") collapse();
  });
  text.addEventListener("input", () => {
    disarm(); // edits demand a fresh two-tap
    const n = text.textContent.length;
    note.textContent = n > LIMIT
      ? `${n} of ${LIMIT} — trim before it can send` : "";
  });

  // -- two modes, one bubble: keys or ink ---------------------------------
  let ctx = null, drawn = false, stroke = null;
  let strokes = [], pendingPages = [];   // the hand, kept page by page
  const setMode = (mode) => {
    const hand = mode === "ink";
    ink.hidden = !hand; text.hidden = hand;
    readBtn.hidden = !hand; clearBtn.hidden = !hand;
    modeBtn.textContent = hand ? "⌨ keys" : "✎ hand";
    if (hand) {
      const need = card.clientWidth - 36;
      // re-measure only a blank page — drawn ink is never wiped by a
      // rotation; CSS max-width keeps an old size from overflowing
      if (!ctx || (!drawn && parseInt(ink.style.width, 10) !== need))
        inkSurface(need);
    } else {
      text.focus();
    }
  };
  const inkSurface = (w) => {
    const dpr = window.devicePixelRatio || 1, h = 200;
    ink.width = w * dpr; ink.height = h * dpr;
    ink.style.width = w + "px"; ink.style.height = h + "px";
    ctx = ink.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--ink").trim() || "#1c1a15";
    paintGround();
    drawn = false;
  };
  const paintGround = () => {
    // the house paper, not hard white — ink on bone is ~16:1, far more
    // than the reader needs, and it belongs to the palette
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--bone").trim() || "#faf8f2";
    ctx.fillRect(0, 0, ink.width, ink.height);
    ctx.restore();
  };
  modeBtn.addEventListener("click", () =>
    setMode(ink.hidden ? "ink" : "keys"));
  ink.addEventListener("pointerdown", (e) => {
    try { ink.setPointerCapture(e.pointerId); } catch (err) {}
    const r = ink.getBoundingClientRect();
    stroke = { x: e.clientX - r.left, y: e.clientY - r.top,
               pts: [[Math.round(e.clientX - r.left),
                      Math.round(e.clientY - r.top),
                      +(e.pressure || 0.5).toFixed(2)]] };
    e.preventDefault();
  });
  ink.addEventListener("pointermove", (e) => {
    if (!stroke || !ctx) return;
    const r = ink.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    ctx.lineWidth = (e.pointerType === "pen" ? (e.pressure || 0.5) * 3.2
                                             : 2.2);
    ctx.beginPath(); ctx.moveTo(stroke.x, stroke.y); ctx.lineTo(x, y);
    ctx.stroke();
    stroke.x = x; stroke.y = y;
    stroke.pts.push([Math.round(x), Math.round(y),
                     +(e.pressure || 0.5).toFixed(2)]);
    drawn = true;
  });
  const strokeEnd = () => {
    if (stroke && stroke.pts.length > 1) strokes.push(stroke.pts);
    stroke = null;
  };
  ink.addEventListener("pointerup", strokeEnd);
  ink.addEventListener("pointercancel", strokeEnd);
  const scribeImage = () => {
    const points = strokes.flat();
    if (!points.length) return ink.toDataURL("image/png");

    const cssWidth = parseFloat(ink.style.width) || ink.clientWidth || 1;
    const dpr = ink.width / cssWidth;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point[0]); maxX = Math.max(maxX, point[0]);
      minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]);
    }
    const pad = 24;
    const x0 = Math.max(0, minX - pad);
    const y0 = Math.max(0, minY - pad);
    const x1 = Math.min(cssWidth, maxX + pad);
    const cssHeight = parseFloat(ink.style.height) || ink.clientHeight || 200;
    const y1 = Math.min(cssHeight, maxY + pad);
    const sx = Math.floor(x0 * dpr), sy = Math.floor(y0 * dpr);
    const sw = Math.max(1, Math.ceil((x1 - x0) * dpr));
    const sh = Math.max(1, Math.ceil((y1 - y0) * dpr));
    const scale = Math.max(1, Math.min(3, 900 / sw));
    const cropped = document.createElement("canvas");
    cropped.width = Math.round(sw * scale);
    cropped.height = Math.round(sh * scale);
    const cropCtx = cropped.getContext("2d");
    cropCtx.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--bone").trim() || "#faf8f2";
    cropCtx.fillRect(0, 0, cropped.width, cropped.height);
    cropCtx.imageSmoothingEnabled = true;
    cropCtx.imageSmoothingQuality = "high";
    cropCtx.drawImage(ink, sx, sy, sw, sh,
      0, 0, cropped.width, cropped.height);
    return cropped.toDataURL("image/png");
  };
  clearBtn.addEventListener("click", () => {
    if (ctx) paintGround();
    drawn = false; strokes = []; note.textContent = "";
  });
  readBtn.addEventListener("click", async () => {
    if (!drawn) { note.textContent = "the page is blank"; return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 48000);
    readBtn.disabled = true;
    readBtn.textContent = "reading…";
    note.textContent = "reading handwriting on your Mac…";
    try {
      const r = await fetch("/api/scribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: scribeImage() }),
        signal: controller.signal,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        note.textContent = d.error ||
          `the Mac couldn't read that (${r.status}) — your ink is still here`;
      } else if (d.text) {
        text.textContent = (text.textContent ? text.textContent + " " : "")
          + d.text;
        if (strokes.length) {
          pendingPages.push({ w: parseInt(ink.style.width, 10) || 600,
                              h: 200, strokes });
          strokes = [];
        }
        paintGround(); drawn = false;
        setMode("keys");              // eyes on the words before the thread
        disarm();
        note.textContent = "editable text — look it over, then send";
      } else {
        note.textContent = (d.error || "couldn't read that") +
          " — your ink is still here; try larger letters";
      }
    } catch (err) {
      note.textContent = err.name === "AbortError"
        ? "the Mac took too long — your ink is still here; try again"
        : "couldn't reach the Mac — your ink is still here";
    } finally {
      clearTimeout(timeout);
      readBtn.disabled = false;
      readBtn.textContent = "read handwriting";
    }
  });

  // -- send: proposal becomes record; the landed message glows ------------
  const { disarm } = armTwoTap(send, {
    guard: () => {
      if (send.dataset.armed === "1" && armedTarget !== targetId()) {
        note.textContent = "the destination changed — look once more, then tap twice";
        disarm();
        return false;
      }
      if (send.dataset.armed === "1" && !sayConsent) {
        note.textContent = "arming those exact words…";
        return false;
      }
      if (isImported(targetId())) {
        // belt-and-suspenders: updateMeta already disables the button, but
        // never let a send arm against a read-only imported thread
        note.textContent =
          `${targetName(targetId())} is imported — read-only. ` +
          `Tap “→ elsewhere” to send into an iMessage thread.`;
        return false;
      }
      if (!ink.hidden) {
        // what the eyes see must be what sends — ink is not words yet,
        // and words may be waiting unseen behind the page
        note.textContent = drawn
          ? "read handwriting first — ink has to become words before it can send"
          : (text.textContent.trim()
              ? "your words are behind the page — ⌨ keys to see them"
              : "nothing to say yet");
        return false;
      }
      const said = text.textContent.trim();
      if (!said) { note.textContent = "nothing to say yet"; return false; }
      if (said.length > LIMIT) {
        note.textContent =
          `${said.length} of ${LIMIT} — trim before it can send`;
        return false;
      }
      return true;
    },
    armedLabel: () => `send to ${targetName(targetId())}?`,
    restLabel: "send",
    timeoutMs: 4000,
    onArm: (armed) => {
      if (!armed) return;
      armedTarget = targetId();
      sayConsent = null;
      armCrossing("say", { chat: armedTarget, text: text.textContent.trim() })
        .then((token) => { sayConsent = token; })
        .catch((err) => { note.textContent = err.message; });
    },
    onFire: async () => {
      const said = text.textContent.trim();
      const dest = armedTarget;
      if (!dest || dest !== targetId()) {
        note.textContent = "the destination changed — nothing was sent";
        armedTarget = null;
        disarm();
        return;
      }
      send.disabled = true;
      send.textContent = "sending…";
      // remember the newest own row so the watcher can only ever light a
      // NEWER one — never an old message that happens to share the words
      const before = Math.max(0,
        ...[...document.querySelectorAll("#timeline .msg.mine")]
          .map((row) => +row.dataset.rowid || 0));
      try {
        const r = await fetch("/api/say", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat: dest, text: said,
                                 _consent: sayConsent }),
        });
        sayConsent = null;
        const d = await r.json();
        if (d.sent || d.dry) {
          // the hand is kept either way — rehearsals are still writing
          if (pendingPages.length) {
            const fp = inkFp(said);
            const entry = { ts: Date.now() / 1000, pages: pendingPages };
            fetch("/api/ink", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat: dest, fp, ...entry }),
            }).then((r) => {
              if (r.ok && state.inks && dest === state.chat)
                state.inks[fp] = entry;
            }).catch(() => {});
            pendingPages = [];
          }
        }
        if (d.sent && dest !== state.chat) {
          note.textContent =
            `sent to ${targetName(dest)} — it lives in their thread`;
          text.textContent = "";
          watchTimer = setTimeout(collapse, 3000);
        } else if (d.sent) {
          note.textContent = "sent — joining the thread…";
          text.textContent = "";
          setTimeout(() => timeline.jumpToLatest(), 2000); // fetch the tail
          watchForLanding(said, before);
        } else if (d.dry) {
          note.textContent = "rehearsed only — this server never sends";
          watchTimer = setTimeout(collapse, 2500);
        } else if (r.status === 404) {
          note.textContent =
            "your server predates say — put Zettel away and open it again";
        } else {
          note.textContent = d.error || "Messages declined — try once more?";
        }
      } catch (err) {
        note.textContent = "couldn't reach the server";
      }
      armedTarget = null;
      send.disabled = false;
      disarm();
    },
  });

  // watch the stream's tail for the sent words; when Apple's db shows
  // them, light the landed row so the moment of joining is visible
  function watchForLanding(said, beforeRowid) {
    stopWatch();
    const began = Date.now();
    const look = () => {
      const hit = [...document.querySelectorAll("#timeline .msg.mine")]
        .filter((row) => (+row.dataset.rowid || 0) > beforeRowid)
        .find((row) => row.textContent.includes(said));
      if (hit) {
        hit.classList.add("just-said");
        hit.scrollIntoView({ block: "nearest", behavior: "smooth" });
        setTimeout(() => hit.classList.remove("just-said"), 4000);
        collapse();
        return;
      }
      if (Date.now() - began < 15000) watchTimer = setTimeout(look, 600);
      else collapse(); // it sent; the stream will catch up on its own
    };
    watchTimer = setTimeout(look, 2600); // after the tail refetch lands
  }
}
buildBubble();

// ---- go-to-date popover ------------------------------------------------------------------

function buildGoto() {
  const months = $("months");
  months.textContent = "";
  for (let m = 0; m < 12; m++) {
    const b = document.createElement("button");
    b.textContent = new Date(2000, m, 1).toLocaleDateString([], { month: "short" });
    b.addEventListener("click", () => {
      closeGoto();
      stopPlaying();
      timeline.jump(new Date(state.gotoYear, m, 1).getTime() / 1000);
    });
    months.append(b);
  }
  $("year-label").textContent = state.gotoYear;
  $("year-prev").onclick = () => {
    state.gotoYear--; $("year-label").textContent = state.gotoYear;
  };
  $("year-next").onclick = () => {
    state.gotoYear++; $("year-label").textContent = state.gotoYear;
  };
}

function openGoto() { buildGoto(); $("goto").classList.add("open"); }
function closeGoto() { $("goto").classList.remove("open"); }

// ---- wiring ---------------------------------------------------------------------------------

$("layer-handle").addEventListener("click", toggleLayer);
$("layer-handle").addEventListener("keydown", (e) => {
  // stopPropagation, or the document handler sees the same Space and also
  // toggles play: one press slammed the map shut and started playing
  if (e.key === "Enter" || e.key === " ") {
    toggleLayer(); e.preventDefault(); e.stopPropagation();
  }
});
$("layer-close").addEventListener("click", closeLayer);
$("layer-down").addEventListener("click", closeLayer);
// The deck lowers by HAND, not only by key — iOS and the DC-1 have no
// Escape, and the ▾ in the controls row can sit below the fold. A drag
// down on the deck's head is the gesture the sheet itself taught.
(() => {
  const head = $("track-head");
  let y0 = null;
  head.addEventListener("pointerdown", (e) => { y0 = e.clientY; });
  head.addEventListener("pointermove", (e) => {
    if (y0 !== null && e.clientY - y0 > 48) { y0 = null; closeLayer(); }
  });
  const end = () => { y0 = null; };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
})();
for (const b of document.querySelectorAll(".facet")) {
  b.addEventListener("click", () => openFacet(b.dataset.facet));
}
$("panel-more").addEventListener("click", () =>
  openFacet(state.facet, { fresh: false }));
$("goto-btn").addEventListener("click", () =>
  $("goto").classList.contains("open") ? closeGoto() : openGoto());
$("export-btn").addEventListener("click", () =>
  $("export").classList.contains("open") ? closeExport() : openExport());
$("export-all").addEventListener("click", () => {
  $("export-from").value = ""; $("export-to").value = "";
});
$("export-copy").addEventListener("click", () => doExport("copy"));
$("export-download").addEventListener("click", () => doExport("download"));
$("export-claude").addEventListener("click", () => doExport("claude"));
$("guide-btn").addEventListener("click", () => window.open(WL.base + "guide.html", "_blank"));
$("amber-btn").addEventListener("click", () => {
  const calm = document.body.classList.toggle("calm");
  document.body.classList.toggle("amber", calm);
  localStorage.setItem("wl-calm", calm ? "1" : "0");
  syncHandle();
});
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
  if (e.key === "Escape") $("search").blur();
});
$("timeline").addEventListener("pointerdown", stopPlaying);

document.addEventListener("keydown", (e) => {
  // the OS's own verbs pass through untouched — Cmd+C must copy, never
  // open the copy flow; and typing anywhere (inputs, the bubble's
  // contenteditable) must never trip single-letter shortcuts
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(
    document.activeElement?.tagName
  ) || document.activeElement?.isContentEditable;
  if (typing) return;
  const k = e.key;
  // while the summons card is open the ground is inert — only Escape
  // reaches through (focus can fall to body when card content is clicked)
  if ($("summon") && k !== "Escape") return;
  if (k === "j" || k === "ArrowDown") { stopPlaying(); timeline.move(1); e.preventDefault(); }
  else if (k === "k" || k === "ArrowUp") { stopPlaying(); timeline.move(-1); e.preventDefault(); }
  else if (k === "n") { stopPlaying(); gotoMarker(1); }
  else if (k === "p") { stopPlaying(); gotoMarker(-1); }
  else if (k === "g") openGoto();
  else if (k === "z" && !$("track-z").hidden) {
    // lift the sheet. Opens the layer first — the plane has no meaning
    // without the record it lies over.
    openLayer();
    toggleZLayer();
    e.preventDefault();
  }
  else if (k === "e" && !isImported(state.chat)) { openLayer(); openExport(); }
  else if (k === "c") copySelected();
  else if (k === "y") {
    const m = timeline.selected();
    if (m) timeline.copyLink(m);
  }
  else if (k === "x") {
    // exhibit: open the shareable card for this moment (a static artifact —
    // the only thing that ever leaves is what you choose to send)
    const m = timeline.selected();
    if (m) window.open(`${WL.base}card?chat=${encodeURIComponent(state.chat)}&g=${
      encodeURIComponent(m.guid)}&ctx=2`, "_blank");
  }
  else if (k === "a") { stopPlaying(); timeline.editNote(); e.preventDefault(); }
  else if (k === "b") { dropBookmark(); e.preventDefault(); }
  else if (k === "@") {
    const b = timeline.summonEnabled && timeline.stretchBounds();
    if (b) { stopPlaying(); openSummon(b); e.preventDefault(); }
  }
  else if (k === "t") toggleLayer();
  else if (k === "?") window.open(WL.base + "guide.html", "_blank");
  else if (k === "m") { openLayer(); openFacet("pins"); }
  else if (k === "/" && !isImported(state.chat)) {
    openLayer(); $("search").focus(); e.preventDefault();
  }
  else if (k === " ") { togglePlaying(); e.preventDefault(); }
  else if (k === "Escape") {
    const otd = document.getElementById("onthisday");
    if (otd) otd.remove();
    else if ($("summon")) summonRequestClose();
    else if ($("export").classList.contains("open")) closeExport();
    else if ($("goto").classList.contains("open")) closeGoto();
    else if (state.facet) closeFacet();
    else if (layerOpen()) closeLayer();
  }
  else if (k === "Home") { stopPlaying(); timeline.jump(0); e.preventDefault(); }
  else if (k === "End") { stopPlaying(); timeline.jumpToLatest(); e.preventDefault(); }
});

boot().catch(() => consentCard(ON_A_PRIVATE_HOST
  ? "The Mac didn't answer yet. Check that Zettel is open on the Mac and "
    + "this device is on the same private network, then try again."
  : "This copy couldn't load its archive. Reload the page — if it keeps "
    + "failing, the demo data didn't ship with it."));
