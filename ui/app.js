// Statusmith — front end. The Rust side is a thin bridge to Discord's local IPC
// pipe; everything about apps, presets, templates, rotation and reconnecting lives here.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

const RATE_LIMIT_MS = 15000;          // Discord applies at most one presence update per ~15 s
const STATUS_POLL_MS = 10000;
const IDLE_POLL_MS = 10000;
const UPDATE_EVERY_MS = 6 * 3600 * 1000;
const DEV_PORTAL = "https://discord.com/developers/applications";
const REPO_URL = "https://github.com/Londopy/statusmith";
const ID_RE = /^\d{15,22}$/;
const TYPE_LABEL = { 0: "Playing", 2: "Listening", 3: "Watching", 5: "Competing" };
const TYPE_GLYPH = { 0: "🎮", 2: "🎧", 3: "📺", 5: "🏆" };
const TYPE_HINT = {
  0: "Card reads “Playing <app name>”, then details and state.",
  2: "Card reads “Listening to <app name>”; add a countdown for a progress bar.",
  3: "Card reads “Watching <app name>”.",
  5: "Card reads “Competing in <app name>”.",
};

// ---------------------------------------------------------------- model

const DEFAULT_SETTINGS = {
  currentApp: "", autoReconnect: true, restoreOnLaunch: true, rotationInterval: 60,
  autoUpdate: true, idlePauseMin: 0, updateDismissed: "",
  gameMode: false, gameTimer: true, gamesRefreshed: 0, gamePlacement: "takeover",
  musicMode: false, musicApp: "", musicByArtist: true, musicPlacement: "takeover",
  gameRotWeight: 1, musicRotWeight: 1,   // ×N for the live game / track stop in the rotation
};
const GAME_POLL_MS = 6000;

function blankPreset(name = "New preset", clientId = "") {
  return {
    name, clientId, type: 0, details: "", state: "",
    largeImage: "", largeText: "", smallImage: "", smallText: "",
    timeMode: "none", duration: 30, loop: false,
    partyCur: 0, partyMax: 0,
    buttons: [{ label: "", url: "" }, { label: "", url: "" }],
    rotate: false,
    weight: 1,          // how many times per rotation cycle this preset shows (1–5)
  };
}

function starterPresets() {
  return [
    { ...blankPreset("Vibing"), details: "vibing {random:✨|🌙|🎧|🍃|🫧}", state: "up since {boot}", timeMode: "apply", rotate: true },
    { ...blankPreset("Live clock"), details: "it is {time} for me", state: "{day} · {date}", rotate: true },
    { ...blankPreset("Touching grass"), details: "touching grass 🌱", state: "brb", timeMode: "countdown", duration: 30 },
    { ...blankPreset("Laptop stats"), details: "battery at {battery}", state: "up for {uptime}", timeMode: "app" },
    { ...blankPreset("Lofi"), type: 2, details: "lofi hip hop radio", state: "beats to relax/study to", timeMode: "countdown", duration: 3.5, loop: true },
    { ...blankPreset("Locked in"), type: 5, details: "vs. the syllabus", state: "in a study group", partyCur: 1, partyMax: 4, timeMode: "apply" },
  ];
}

function normalizePresets(list) {
  return list.map((p) => ({
    ...blankPreset(), ...p,
    name: String(p.name || "untitled").slice(0, 40),
    clientId: String(p.clientId || "").trim(),
    weight: Math.min(5, Math.max(1, Math.floor(Number(p.weight) || 1))),
    buttons: [0, 1].map((i) => ({ label: "", url: "", ...((p.buttons || [])[i] || {}) })),
  }));
}

function normalizeApps(list) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && ID_RE.test(String(a.id || "")))
    .map((a) => ({ id: String(a.id), name: String(a.name || ""), auto: a.auto !== false, game: !!a.game }));
}

function normalizeStore(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  const presets = normalizePresets(Array.isArray(s.presets) && s.presets.length ? s.presets : starterPresets());
  const apps = normalizeApps(s.apps);
  const known = new Set(apps.map((a) => a.id));
  const addApp = (id) => { if (ID_RE.test(id) && !known.has(id)) { apps.push({ id, name: "", auto: true }); known.add(id); } };
  // Migration from the single top-bar ID: it becomes the app of every preset that had no override.
  const legacy = String(settings.clientId || "").trim();
  delete settings.clientId;
  addApp(legacy);
  for (const p of presets) { if (!p.clientId && legacy) p.clientId = legacy; addApp(p.clientId); }
  if (!known.has(settings.currentApp)) settings.currentApp = legacy || (apps[0] ? apps[0].id : "");
  return {
    settings, apps, presets,
    last: s.last && s.last.preset ? s.last : null,
    rotation: { active: false, ...(s.rotation || {}) },
  };
}

let store = null;
let sel = -1;                // global index into store.presets, -1 = nothing in the editor
let conn = { connected: false, user: null, client_id: "" };
let lastError = "";
let current = null;          // { preset, appliedAt, lastSent, rendered, pending?, fatal? } = what Discord is showing
let appStart = Date.now();
let bootMs = 0;              // when the PC booted (from the OS), for {boot}/{awake}
let previewStart = Date.now();
let batteryPct = null;
let appInfo = {};            // clientId -> { name, icon, fetched }
let assets = {};             // clientId -> [{ id, name }]
let rot = { active: false, idx: -1, nextAt: 0 };
let lastPoll = 0;
let lastIdlePoll = 0;
let lastAutoPoll = 0;        // gate for the shared game/music resolver; 0 forces an immediate poll
let idlePaused = false;
let gameMap = null;          // { "<exe>": { id, name } } from Discord's detectable list
let gameIndex = [];          // deduped [{ id, name }] for the "fake a game" picker
let gameNow = null;          // { id, name, exe } while a game is detected
let musicNow = null;         // now-playing track object while music is detected
let autoNow = null;          // { kind:'game'|'music', id, key, label } currently driving the presence
let preAuto = null;          // what was live before an auto-source took over, to restore after
let appVersion = "0.0.0";
let updateInfo = null;       // { version, current, notes, date } from the last successful check
let updateStatus = "Updates not checked yet.";
let lastUpdateCheck = 0;
let afterDocClose = null;
let lastFocused = null;
let saveTimer = null;
let trayKey = "";

const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const preset = () => (sel >= 0 && sel < store.presets.length ? store.presets[sel] : null);
const currentApp = () => store.settings.currentApp;
const appOf = (id) => store.apps.find((a) => a.id === id) || null;
const appName = (id) => {
  const a = appOf(id);
  return (a && a.name) || (appInfo[id] && appInfo[id].name) || (id ? "app …" + id.slice(-4) : "no application");
};
const visible = () => store.presets.map((_, i) => i).filter((i) => store.presets[i].clientId === currentApp());
const presetCount = (id) => store.presets.filter((p) => p.clientId === id).length;
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => invoke("save_store", { data: store }).catch((e) => toast("Couldn't save: " + e, "err")), 250);
}

// ---------------------------------------------------------------- templates

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const VARS = {
  time:    { hint: "14:05",    fn: () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) },
  time12:  { hint: "2:05 PM",  fn: () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) },
  date:    { hint: "Sep 20",   fn: () => new Date().toLocaleDateString([], { month: "short", day: "numeric" }) },
  day:     { hint: "Saturday", fn: () => new Date().toLocaleDateString([], { weekday: "long" }) },
  uptime:  { hint: "2h 14m",   fn: () => fmtDuration(Date.now() - appStart) },
  boot:    { hint: "08:30",    fn: () => (bootMs ? new Date(bootMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "?") },
  boot12:  { hint: "8:30 AM",  fn: () => (bootMs ? new Date(bootMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "?") },
  awake:   { hint: "6h 40m",   fn: () => (bootMs ? fmtDuration(Date.now() - bootMs) : "?") },
  battery: { hint: "87%",      fn: () => (batteryPct == null ? "?%" : batteryPct + "%") },
  "random:a|b|c": { hint: "one of", fn: null },
  "sh:command":   { hint: "first line of output", fn: null },
  "nx:file.nx":   { hint: "runs a Nexium program", fn: null },
};

// `{sh:…}` / `{nx:…}` run out of process; results are cached for one refresh window so a
// slow command never blocks rendering. The first render shows "…" until the result lands.
const scriptCache = {};
function scriptVar(kind, arg) {
  const cmd = kind === "nx" ? `nx run "${arg.trim()}"` : arg.trim();
  if (!cmd) return "";
  const c = scriptCache[cmd];
  if (c && Date.now() - c.at < RATE_LIMIT_MS) return c.value;
  if (!c || !c.pending) {
    scriptCache[cmd] = { value: c ? c.value : "…", at: c ? c.at : 0, pending: true };
    invoke("run_command", { cmd, timeoutMs: 8000 })
      .then((out) => { scriptCache[cmd] = { value: (String(out).split(/\r?\n/)[0] || "").trim().slice(0, 128) || "(no output)", at: Date.now(), pending: false }; renderPreview(); })
      .catch((e) => { scriptCache[cmd] = { value: "(error)", at: Date.now(), pending: false }; console.warn(cmd, e); renderPreview(); });
  }
  return c ? c.value : "…";
}

function render(str) {
  return String(str || "").replace(/\{(\w+)(?::([^}]*))?\}/g, (m, name, arg) => {
    if (name === "random" && arg != null) {
      const opts = arg.split("|").filter(Boolean);
      return opts.length ? opts[Math.floor(Math.random() * opts.length)] : "";
    }
    if ((name === "sh" || name === "nx") && arg != null) return scriptVar(name, arg);
    const v = VARS[name];
    return v && v.fn ? v.fn() : m;
  });
}
const hasTemplates = (p) => /\{\w+(:[^}]*)?\}/.test([p.details, p.state, p.largeText, p.smallText].join("\n"));

// ---------------------------------------------------------------- activity

function timestampsFor(p, appliedAt) {
  switch (p.timeMode) {
    case "apply": return { start: appliedAt };
    case "app": return { start: appStart };
    case "countdown": {
      const ms = Math.max(RATE_LIMIT_MS, Math.round((Number(p.duration) || 0) * 60000));
      return { start: appliedAt, end: appliedAt + ms };
    }
    case "music": return p.musicTs || null;   // explicit start/end from the track position
    default: return null;
  }
}

function buildActivity(p, appliedAt) {
  const warnings = [];
  const a = { type: Number(p.type) || 0 };
  const text = (label, s) => {
    const v = render(s).trim();
    if (v.length === 1) { warnings.push(`${label} must be at least 2 characters — left it out.`); return ""; }
    return v.slice(0, 128);
  };
  const details = text("Details", p.details), state = text("State", p.state);
  if (details) a.details = details;
  if (state) a.state = state;

  const assets = {};
  if (p.largeImage.trim()) assets.large_image = p.largeImage.trim();
  const lt = text("Large image text", p.largeText); if (lt && assets.large_image) assets.large_text = lt;
  if (p.smallImage.trim()) assets.small_image = p.smallImage.trim();
  const st = text("Small image text", p.smallText); if (st && assets.small_image) assets.small_text = st;
  if (Object.keys(assets).length) a.assets = assets;

  // Which field Discord shows as your compact status line: 0 app name (default), 1 state, 2 details.
  const sd = Number(p.statusDisplay);
  if (sd === 1 || sd === 2) a.status_display_type = sd;

  const ts = timestampsFor(p, appliedAt);
  if (ts) a.timestamps = ts;

  const max = Math.max(0, Math.floor(Number(p.partyMax) || 0));
  if (max > 0) {
    const cur = Math.min(max, Math.max(1, Math.floor(Number(p.partyCur) || 1)));
    a.party = { id: "statusmith", size: [cur, max] };
  }

  const buttons = p.buttons
    .map((b) => ({ label: (b.label || "").trim().slice(0, 32), url: (b.url || "").trim() }))
    .filter((b) => b.label && b.url)
    .filter((b) => { if (!/^https?:\/\/\S+$/.test(b.url)) { warnings.push(`Button “${b.label}” needs an http(s) link — skipped.`); return false; } return true; })
    .slice(0, 2);
  if (buttons.length) a.buttons = buttons;

  a.instance = false;
  return { activity: a, warnings };
}

// ---------------------------------------------------------------- discord bridge

async function refreshStatus() {
  try { conn = await invoke("status"); } catch { conn = { connected: false, user: null, client_id: "" }; }
  renderConn();
}

async function apply(p, opts = {}) {
  const cid = (p.clientId || "").trim();
  if (!ID_RE.test(cid)) {
    if (!opts.silent) { toast("Assign this preset to an application first.", "err"); openApps(); }
    return false;
  }
  idlePaused = false;
  const appliedAt = opts.keepAppliedAt && current ? current.appliedAt : Date.now();
  const { activity, warnings } = buildActivity(p, appliedAt);
  try {
    const res = await invoke("set_activity", { clientId: cid, activity });
    current = { preset: clone(p), appliedAt, lastSent: Date.now(), rendered: JSON.stringify(activity) };
    if (res && res.name) noteAppName(cid, res.name);
    lastError = "";
    current.auto = !!opts.auto;
    current.autoKind = opts.autoKind || null;
    if (!opts.transient) { store.last = { preset: current.preset, appliedAt }; saveStore(); }
    if (!opts.silent) toast(`Presence set — ${p.name || "untitled"}`, "ok");
    warnings.forEach((w) => toast(w, "warn"));
  } catch (e) {
    lastError = String(e);
    if (!opts.silent) toast(lastError, "err");
    if (!current || !opts.keepAppliedAt) current = { preset: clone(p), appliedAt, lastSent: 0, rendered: "", pending: true };
    // A refused handshake (bad Application ID) won't fix itself; wait for the user instead of retrying.
    current.fatal = /refused the handshake|Application ID/i.test(lastError);
  }
  await refreshStatus();
  renderAll();
  return !lastError;
}

async function resend() {
  if (!current) return;
  const { activity } = buildActivity(current.preset, current.appliedAt);
  const rendered = JSON.stringify(activity);
  if (rendered === current.rendered) return;
  try {
    await invoke("set_activity", { clientId: current.preset.clientId, activity });
    current.rendered = rendered; current.lastSent = Date.now(); current.pending = false; lastError = "";
  } catch (e) { lastError = String(e); }
  await refreshStatus();
  syncTray();
}

async function clearPresence(silent) {
  stopRotation(true);
  current = null;
  idlePaused = false;
  store.last = null;
  saveStore();
  try {
    if (conn.connected) await invoke("set_activity", { clientId: conn.client_id, activity: null });
    if (!silent) toast("Presence cleared.", "ok");
  } catch (e) { if (!silent) toast(String(e), "err"); }
  await refreshStatus();
  renderAll();
}

// Discord's public application endpoints (no token). If the webview's CORS blocks them the
// UI falls back to the name Discord echoes back on the first apply.
function noteAppName(cid, name) {
  appInfo[cid] = { ...(appInfo[cid] || {}), name };
  const a = appOf(cid);
  if (a && a.auto && name && a.name !== name) { a.name = name; saveStore(); }
}

async function fetchAppInfo(cid) {
  cid = (cid || "").trim();
  if (!ID_RE.test(cid) || (appInfo[cid] && appInfo[cid].fetched)) return;
  appInfo[cid] = { ...(appInfo[cid] || {}), fetched: true };
  try {
    const r = await fetch(`https://discord.com/api/v10/applications/${cid}/rpc`);
    if (r.ok) { const j = await r.json(); appInfo[cid].icon = j.icon; noteAppName(cid, j.name); }
  } catch {}
  try {
    const r = await fetch(`https://discord.com/api/v10/oauth2/applications/${cid}/assets`);
    if (r.ok) assets[cid] = await r.json();
  } catch {}
  renderAll();
  renderApps();
}

// ---------------------------------------------------------------- rotation (global across apps)

const rotationList = () => store.presets.filter((p) => p.rotate);
const rotWeight = (p) => Math.min(5, Math.max(1, Math.floor(Number(p.weight) || 1)));

// The stops rotation walks. Each is { preset, weight } for a ticked preset, plus — when game or
// music mode is set to "keep rotating" and that source is live — a { game, weight } or
// { music, weight } stop for it, so the live game/track shows alongside your presets. A weight-N
// stop appears N times per cycle, spread out (it's in the first N of maxWeight passes), so
// "featured" stops recur more often without ever landing back-to-back.
let rotSeq = [];
const clampWeight = (n) => Math.min(5, Math.max(1, Math.floor(Number(n) || 1)));
function rotStops() {
  const stops = rotationList().map((p) => ({ preset: p, weight: rotWeight(p) }));
  if (store.settings.gamePlacement === "rotate" && gameNow) stops.push({ game: gameNow, weight: clampWeight(store.settings.gameRotWeight) });
  if (store.settings.musicPlacement === "rotate" && musicNow) stops.push({ music: musicNow, weight: clampWeight(store.settings.musicRotWeight) });
  return stops;
}
/// A stable id for any stop, for highlighting the "now" row in the rotation menu.
const stopKey = (s) => s.game ? "game:" + s.game.id : s.music ? "music:" + JSON.stringify([s.music.title, s.music.artist || ""]) : presetKey(s.preset);
function buildRotSeq() {
  const stops = rotStops();
  const maxW = stops.reduce((m, s) => Math.max(m, s.weight), 1);
  const seq = [];
  for (let pass = 0; pass < maxW; pass++) for (const s of stops) if (s.weight > pass) seq.push(s);
  rotSeq = seq;
}
const seqIndexOfPreset = (p) => rotSeq.findIndex((s) => s.preset === p);

function startRotation() {
  if (rotStops().length < 2) { toast("Tick ↻ on at least two presets first.", "warn"); return; }
  rot = { active: true, idx: -1, nextAt: 0 };
  store.rotation.active = true;
  saveStore();
  advanceRotation();
}

function stopRotation(quiet) {
  const was = rot.active;
  rot.active = false;
  store.rotation.active = false;
  if (was) { saveStore(); if (!quiet) toast("Rotation stopped.", "ok"); }
  renderRotation();
  syncTray();
}

async function advanceRotation() {
  buildRotSeq();                       // picks up membership, weight and game changes each step
  if (rotSeq.length < 2) return stopRotation();
  rot.idx = (rot.idx + 1) % rotSeq.length;
  rot.nextAt = Date.now() + Math.max(15, Number(store.settings.rotationInterval) || 60) * 1000;
  const stop = rotSeq[rot.idx];
  if (stop.game) await apply(gamePreset(stop.game), { silent: true, transient: true, auto: true, autoKind: "game" });
  else if (stop.music) await apply(musicPreset(stop.music), { silent: true, transient: true, auto: true, autoKind: "music" });
  else await apply(stop.preset, { silent: true });
  renderRotation();
}

// ---------------------------------------------------------------- updates

function setUpdateStatus(text) {
  updateStatus = text;
  $("aboutUpd").textContent = text;
}

function showUpdateBar() {
  if (!updateInfo) return;
  $("updateTitle").textContent = `Statusmith v${updateInfo.version} is available`;
  $("updateSub").textContent = `you have v${updateInfo.current}`;
  $("btnUpdateNotes").hidden = !(updateInfo.notes && updateInfo.notes.trim());
  $("updateBar").hidden = false;
}

async function checkForUpdates(manual) {
  lastUpdateCheck = Date.now();
  setUpdateStatus("Checking for updates…");
  try {
    const u = await invoke("check_update");
    if (u) {
      updateInfo = u;
      setUpdateStatus(`v${u.version} is available.`);
      if (manual || store.settings.updateDismissed !== u.version) showUpdateBar();
      if (manual) toast(`Update v${u.version} is available.`, "ok");
    } else {
      updateInfo = null;
      $("updateBar").hidden = true;
      setUpdateStatus(`Up to date · checked ${hhmm(Date.now())}`);
      if (manual) toast("You're on the latest version.", "ok");
    }
  } catch (e) {
    updateInfo = null;
    const msg = String(e).replace(/^error:?\s*/i, "");
    setUpdateStatus(`Couldn't check for updates (${msg.slice(0, 80)})`);
    if (manual) toast("Couldn't check for updates: " + msg, "err");
  }
  syncTray();
}

async function installUpdate() {
  if (!updateInfo) { checkForUpdates(true); return; }
  $("btnUpdateInstall").disabled = true;
  $("btnUpdateInstall").textContent = "Downloading…";
  toast(`Downloading v${updateInfo.version}… the app will restart by itself.`, "ok");
  try {
    await invoke("install_update");
  } catch (e) {
    toast("Update failed: " + e, "err");
    $("btnUpdateInstall").disabled = false;
    $("btnUpdateInstall").textContent = "Install and restart";
  }
}

// ---------------------------------------------------------------- game mode
//
// With Discord's own game detection turned off, Statusmith watches the running processes and,
// when a game from Discord's detectable list appears, sets the presence to that game (using the
// game's own application id, so the card reads "Playing <Game>" with its real art). While a game
// runs it takes over; when it quits, whatever was live before comes back.

async function loadGameMap() {
  try {
    const m = await invoke("load_games");
    gameMap = m && typeof m === "object" ? m : null;
  } catch { gameMap = null; }
  gameIndex = [];
  if (gameMap) {
    const seen = new Set();
    for (const k in gameMap) {
      const g = gameMap[k];
      if (g && g.id && !seen.has(g.id)) { seen.add(g.id); gameIndex.push({ id: String(g.id), name: String(g.name) }); }
    }
    gameIndex.sort((a, b) => a.name.localeCompare(b.name));
  }
  return gameMap;
}

async function refreshGames(manual) {
  setGameStatus("Fetching Discord's game list…");
  try {
    const n = await invoke("refresh_games");
    await loadGameMap();
    store.settings.gamesRefreshed = Date.now();
    saveStore();
    renderGamePanel();
    if (manual) toast(`Game list updated — ${n.toLocaleString()} games.`, "ok");
  } catch (e) {
    setGameStatus("Couldn't fetch the game list — check your connection.");
    if (manual) toast(String(e), "err");
  }
}

function gamePreset(hit) {
  // A synthetic preset: the headline comes from the game's app id; a bare card, optional timer.
  return { ...blankPreset(hit.name, hit.id), timeMode: store.settings.gameTimer ? "apply" : "none" };
}

/// Album art for a track. The OS only hands us a thumbnail *stream*, and Discord needs an https
/// URL for an external image, so look the cover up on iTunes' public search (no key) — one
/// request per distinct track, cached, and a miss is remembered too.
const artCache = new Map();   // JSON [title, artist] -> url | null | Promise
function albumArt(np) {
  const key = JSON.stringify([np.title || "", np.artist || ""]);
  if (artCache.has(key)) return Promise.resolve(artCache.get(key));
  const pr = (async () => {
    try {
      const term = encodeURIComponent(`${np.artist || ""} ${np.title || ""}`.trim());
      const r = await fetch(`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5`);
      if (!r.ok) return null;
      const hits = ((await r.json()).results || []);
      const want = String(np.artist || "").toLowerCase().split(/[,&]/)[0].trim();
      const hit = (want && hits.find((h) => String(h.artistName || "").toLowerCase().includes(want))) || hits[0];
      return hit && hit.artworkUrl100 ? String(hit.artworkUrl100).replace(/\/\d+x\d+bb\./, "/512x512bb.") : null;
    } catch { return null; }
  })();
  artCache.set(key, pr);
  return pr.then((v) => { artCache.set(key, v); return v; });
}

/// A Listening preset built from the OS "now playing": the song is the details, the artist the
/// state, the album the hover text, the cover the large image, and the progress bar comes from
/// the track position (start = now - elapsed, end = start + duration). `statusDisplay` 2 asks
/// Discord to put the *song* in your compact status line ("Listening to <song>") instead of the
/// headline application's name.
function musicPreset(np) {
  const p = blankPreset(np.title || "music", store.settings.musicApp);
  p.type = 2;
  p.details = String(np.title || "").slice(0, 128) || "music";
  const artist = String(np.artist || "");
  p.state = artist ? (store.settings.musicByArtist === false ? artist : "by " + artist) : "";
  if (np.art) p.largeImage = np.art;
  if (np.album) p.largeText = String(np.album).slice(0, 128);
  p.statusDisplay = 2;
  if (Number(np.durMs) > 0) {
    const start = Date.now() - Math.max(0, Number(np.posMs) || 0);
    p.timeMode = "music";
    p.musicTs = { start, end: start + Number(np.durMs) };
  }
  return p;
}

function detectGameHit(procs) {
  for (const p of procs) {
    const g = gameMap && gameMap[p];
    if (g && g.id) return { id: String(g.id), name: String(g.name), exe: p };
  }
  return null;
}

/// Read the OS "now playing" and, if a track is going, return a source descriptor (and set
/// musicNow). Returns null and clears musicNow when nothing is playing.
async function pollMusic() {
  if (!(store.settings.musicMode && ID_RE.test(store.settings.musicApp || ""))) { musicNow = null; return null; }
  let np = null;
  try { np = await invoke("now_playing"); } catch {}
  if (!(np && np.playing && np.title)) { musicNow = null; return null; }
  np.art = await albumArt(np);        // cached after the first look-up per track
  musicNow = np;
  return {
    kind: "music", id: store.settings.musicApp, label: np.title,
    key: "music:" + JSON.stringify([np.title, np.artist || ""]),
    preset: musicPreset(np),
  };
}

/// Put an auto source on top of your own presence (a take-over game or track, or a lone
/// keep-rotating source that has nothing to cycle with), or, with `desired` null, hand control
/// back to what was live before. `preAuto` snapshots that the first time an override takes hold,
/// so game -> music -> nothing lands you back on your own status. No-op while unchanged.
async function override(desired) {
  const desKey = desired ? desired.key : null;
  const curKey = autoNow ? autoNow.key : null;
  if (desKey === curKey) return;
  if (!autoNow && desired) {
    preAuto = { rotating: rot.active, preset: current && !current.pending && !current.auto ? clone(current.preset) : null };
  }
  if (desired) {
    if (rot.active) stopRotation(true);
    autoNow = { kind: desired.kind, id: desired.id, key: desired.key, label: desired.label };
    await apply(desired.preset, { silent: true, transient: true, auto: true, autoKind: desired.kind });
  } else {
    const pa = preAuto; preAuto = null; autoNow = null;
    if (pa && pa.rotating && rotStops().length >= 2) startRotation();
    else if (pa && pa.preset) await apply(pa.preset, { silent: true });
    else await clearPresence(true);
  }
}

/// One resolver for both auto sources. A take-over source (game or track) overrides your own
/// presence — a game take-over beats a music take-over — while a keep-rotating source rides along
/// as a rotation stop instead. `preAuto` snapshots what was live before an override, so a
/// game -> music -> nothing sequence lands you back on your own status.
async function pollAuto() {
  const gm = store.settings.gameMode && gameMap;
  const mm = store.settings.musicMode && ID_RE.test(store.settings.musicApp || "");
  if (!gm && !mm) return;

  let hit = null;
  if (gm) { try { hit = detectGameHit(await invoke("list_processes")); } catch {} }
  gameNow = hit;
  const music = mm ? await pollMusic() : (musicNow = null);   // pollMusic sets musicNow

  // A take-over source overrides everything; a game take-over beats a music take-over.
  let over = null;
  if (hit && store.settings.gamePlacement !== "rotate")
    over = { kind: "game", id: hit.id, key: "game:" + hit.id, label: hit.name, preset: gamePreset(hit) };
  else if (music && store.settings.musicPlacement !== "rotate")
    over = music;

  if (over) { await override(over); renderGamePanel(); renderMusicPanel(); refreshRotationUi(); return; }

  // No take-over. Keep-rotating sources (game and/or track) ride along as rotation stops.
  buildRotSeq();
  const stops = rotStops();
  const autoStops = stops.filter((s) => s.game || s.music);

  if (stops.length >= 2 && (rot.active || autoStops.length)) {
    // Enough to cycle and something wants in: run the rotation (it picks up the auto stops).
    if (autoNow) { autoNow = null; preAuto = null; }
    if (!rot.active) startRotation();
  } else if (autoStops.length === 1 && stops.length === 1) {
    // A lone keep-rotating source with nothing to cycle with — show it by itself.
    const s = autoStops[0];
    await override(s.game
      ? { kind: "game", id: s.game.id, key: "game:" + s.game.id, label: s.game.name, preset: gamePreset(s.game) }
      : { kind: "music", id: store.settings.musicApp, key: "music:" + JSON.stringify([s.music.title, s.music.artist || ""]), label: s.music.title, preset: musicPreset(s.music) });
  } else if (autoNow) {
    await override(null);              // an override ended and nothing replaces it → restore
  } else if (rot.active && stops.length < 2) {
    stopRotation(true);
  }
  renderGamePanel(); renderMusicPanel(); refreshRotationUi();
}
function setGameStatus(text) { $("gameStatus").textContent = text; }

function renderGamePanel() {
  const on = store.settings.gameMode;
  $("sGameMode").checked = on;
  $("sGameTimer").checked = store.settings.gameTimer;
  $("sGamePlacement").value = store.settings.gamePlacement;
  const count = gameIndex.length;
  $("gameCount").textContent = count ? `${count.toLocaleString()} games` : "";
  document.querySelector(".panel.game").classList.toggle("playing", !!gameNow);
  if (gameNow && store.settings.gamePlacement === "rotate") setGameStatus(`In the rotation now: ${gameNow.name}.`);
  else if (gameNow) setGameStatus(`Playing ${gameNow.name} — your status resumes when it closes.`);
  else if (!on) setGameStatus("Off — turn on to detect games, or “LARP a game”.");
  else if (!count) setGameStatus("No game list yet — hit Refresh.");
  else setGameStatus("Watching for games. Turn off Discord's own detection so they don't double up.");
}

/// Step off whatever auto-source is showing and put back what was live before it.
async function restoreAuto() {
  autoNow = null; musicNow = null;
  const pa = preAuto; preAuto = null;
  if (pa && pa.rotating && rotStops().length >= 2) startRotation();
  else if (pa && pa.preset) await apply(pa.preset, { silent: true });
  else await clearPresence(true);
}

async function setGameMode(on) {
  store.settings.gameMode = on;
  saveStore();
  if (on) {
    if (!gameMap || !Object.keys(gameMap).length) await refreshGames(false);
    lastAutoPoll = 0; // resolve on the next tick
  } else {
    const wasGame = current && current.auto && current.autoKind === "game";
    gameNow = null;
    if (store.settings.gamePlacement === "rotate" && wasGame) {
      buildRotSeq();
      if (rot.active) await advanceRotation(); else await clearPresence(true);
    } else if (wasGame) {
      await restoreAuto();     // music may pick up on the next poll
      lastAutoPoll = 0;
    }
  }
  renderGamePanel();
}

async function setMusicMode(on) {
  store.settings.musicMode = on;
  saveStore();
  if (on) {
    if (!ID_RE.test(store.settings.musicApp || "")) {
      // Default the music headline: an application literally named "music" (or a player's name)
      // reads best - "Listening to music" - else fall back to the current application if it
      // isn't a faked game.
      const a = store.apps.find((x) => !x.game && /^(music|spotify|tidal|apple music|youtube music|listening)$/i.test(appName(x.id).trim()))
        || appOf(currentApp());
      if (a && !a.game) { store.settings.musicApp = a.id; saveStore(); }
    }
    lastAutoPoll = 0;
  } else {
    const wasMusic = current && current.auto && current.autoKind === "music";
    musicNow = null;
    if (store.settings.musicPlacement === "rotate" && wasMusic) {
      buildRotSeq();
      if (rot.active) await advanceRotation(); else await clearPresence(true);
    } else if (wasMusic) {
      await restoreAuto();     // a game may pick up on the next poll
      lastAutoPoll = 0;
    }
  }
  renderMusicPanel();
}

function setMusicStatus(text) { $("musicStatus").textContent = text; }

function renderMusicPanel() {
  const on = store.settings.musicMode;
  $("sMusicMode").checked = on;
  const sel = $("sMusicApp");
  sel.innerHTML = store.apps.filter((a) => !a.game).map((a) => `<option value="${esc(a.id)}">${esc(appName(a.id))}</option>`).join("")
    || `<option value="">add an application first</option>`;
  if (ID_RE.test(store.settings.musicApp || "")) sel.value = store.settings.musicApp;
  $("sMusicPlacement").value = store.settings.musicPlacement || "takeover";
  $("sMusicByArtist").checked = store.settings.musicByArtist !== false;
  const live = current && current.auto && current.autoKind === "music";
  document.querySelector(".panel.music").classList.toggle("playing", !!live);
  if (live && musicNow && store.settings.musicPlacement === "rotate") setMusicStatus(`In the rotation now: ${musicNow.title} — ${musicNow.artist}.`);
  else if (live && musicNow) setMusicStatus(`♪ ${musicNow.title} — ${musicNow.artist}`);
  else if (!on) setMusicStatus("Off — turn on to show what you're listening to.");
  else if (!ID_RE.test(store.settings.musicApp || "")) setMusicStatus("Pick which application is the “Listening to …” headline.");
  else if (musicNow) setMusicStatus(`Playing: ${musicNow.title} — ${musicNow.artist}.`);
  else setMusicStatus("Watching your media. Play something in Spotify, a browser, etc.");
}

// ---------------------------------------------------------------- LARP a game (fake/spoof)

function ensureGameApp(id, name) {
  if (!appOf(id)) store.apps.push({ id, name, auto: false, game: true });
}

/// Pick any game from Discord's list and show "Playing <Game>". Creates a reusable, editable
/// preset (so it can join rotation), then applies it. Your own vanity status — a LARP.
async function fakeGame(g, opts = {}) {
  ensureGameApp(g.id, g.name);
  let p = store.presets.find((x) => x.clientId === g.id && x.name === g.name);
  if (!p) { p = { ...blankPreset(g.name, g.id), timeMode: "apply" }; store.presets.push(p); }
  if (opts.rotate) p.rotate = true;
  store.settings.currentApp = g.id;
  saveStore();
  fetchAppInfo(g.id);
  renderAll();
  select(store.presets.indexOf(p));
  if (opts.rotate) {
    // Join the rotation: start it if it's not running and there's enough to cycle, else it's
    // ticked and ready for when you do start.
    if (!rot.active && rotStops().length >= 2) startRotation();
    else if (rot.active) { buildRotSeq(); renderRotation(); }
    toast(`Added ${g.name} to your rotation.`, "ok");
  } else {
    stopRotation(true);
    await apply(p);
    toast(`Now "playing" ${g.name} 😏`, "ok");
  }
}

function openGamePicker() {
  if (!gameIndex.length) { toast("No game list yet — turn on Game mode or hit Refresh first.", "warn"); return; }
  $("gamePickSearch").value = "";
  $("gamePickRotate").checked = false;
  renderGamePicks("");
  $("gamePickModal").hidden = false;
  $("gamePickSearch").focus();
}

function renderGamePicks(query) {
  const q = query.trim().toLowerCase();
  const box = $("gamePickList");
  const matches = (q ? gameIndex.filter((g) => g.name.toLowerCase().includes(q)) : gameIndex).slice(0, 60);
  box.innerHTML = "";
  if (!matches.length) { box.innerHTML = `<p class="muted">No game matches “${esc(query)}”.</p>`; return; }
  for (const g of matches) {
    const row = document.createElement("button");
    row.className = "pick-row";
    row.innerHTML = `<span class="nm"></span><span class="muted">Playing…</span>`;
    row.querySelector(".nm").textContent = g.name;
    row.addEventListener("click", () => { const rotate = $("gamePickRotate").checked; closeModals(); fakeGame(g, { rotate }); });
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------- tick

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try { await tickInner(); } finally { ticking = false; }
}

async function tickInner() {
  const now = Date.now();
  renderPreviewTimer();
  renderRotation();
  renderRotationStatus();

  if (rot.active && !idlePaused && now >= rot.nextAt) { await advanceRotation(); return; }

  if (current && !idlePaused) {
    const p = current.preset;
    if (p.timeMode === "countdown" && p.loop) {
      const end = current.appliedAt + Math.max(RATE_LIMIT_MS, (Number(p.duration) || 0) * 60000);
      if (now >= end) { await apply(p, { silent: true }); return; }
    }
    if (conn.connected && !current.pending && hasTemplates(p) && now - current.lastSent >= RATE_LIMIT_MS) {
      await resend();
    }
  }

  // Pause the presence after N idle minutes; come back on the first input.
  if (current && Number(store.settings.idlePauseMin) > 0 && now - lastIdlePoll >= IDLE_POLL_MS) {
    lastIdlePoll = now;
    const idle = Number(await invoke("idle_ms").catch(() => 0));
    const limit = Number(store.settings.idlePauseMin) * 60000;
    if (!idlePaused && idle >= limit && conn.connected && !current.pending) {
      idlePaused = true;
      try { await invoke("set_activity", { clientId: current.preset.clientId, activity: null }); } catch {}
      renderPreview(); syncTray();
    } else if (idlePaused && idle < IDLE_POLL_MS) {
      await apply(current.preset, { silent: true, keepAppliedAt: true });
    }
  }

  if ((store.settings.gameMode || store.settings.musicMode) && now - lastAutoPoll >= GAME_POLL_MS) {
    lastAutoPoll = now;
    await pollAuto();
  }

  if (now - lastPoll >= STATUS_POLL_MS) {
    lastPoll = now;
    await refreshStatus();
    if (current && !current.fatal && !idlePaused && !conn.connected && store.settings.autoReconnect) {
      await apply(current.preset, { silent: true, keepAppliedAt: true });
    }
  }

  if (store.settings.autoUpdate && now - lastUpdateCheck >= UPDATE_EVERY_MS) {
    await checkForUpdates(false);
  }
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderAppSelect();
  renderPresetAppSelect();
  renderList();
  renderConn();
  renderPreview();
  renderRotation();
  renderAssets();
  syncTray();
}

function renderAppSelect() {
  const el = $("appSelect");
  const real = store.apps.filter((a) => !a.game);
  const games = store.apps.filter((a) => a.game);
  const opt = (a) => `<option value="${esc(a.id)}">${esc(appName(a.id))}</option>`;
  const opts = real.map(opt);
  if (games.length) {
    opts.push(`<option value="" disabled>── faked games ──</option>`);
    opts.push(...games.map(opt));
  }
  if (!store.apps.length) opts.push(`<option value="">no application yet</option>`);
  opts.push(`<option value="__manage">Manage applications…</option>`);
  el.innerHTML = opts.join("");
  el.value = currentApp();
  el.title = currentApp() ? `Application ID ${currentApp()}` : "";
}

function renderList() {
  const ul = $("presetList");
  ul.innerHTML = "";
  for (const i of visible()) {
    const p = store.presets[i];
    const li = document.createElement("li");
    li.dataset.i = i;
    li.className = i === sel ? "on" : "";
    const live = current && current.preset.name === p.name && current.preset.clientId === p.clientId && !current.pending;
    li.innerHTML = `<span class="ty">${TYPE_GLYPH[p.type] || "🎮"}</span><span class="nm"></span>${live ? '<span class="live" title="currently applied"></span>' : ""}<button class="rot ${p.rotate ? "on" : ""}" title="include in rotation">↻</button>`;
    li.querySelector(".nm").textContent = p.name || "untitled";
    li.title = "click to edit · double-click to apply";
    // Only the selection class changes on click, so the second click of a double-click
    // still lands on this same element and the browser fires dblclick.
    li.addEventListener("click", () => select(i));
    li.addEventListener("dblclick", (e) => { e.preventDefault(); stopRotation(true); apply(p); });
    li.querySelector(".rot").addEventListener("click", (e) => { e.stopPropagation(); p.rotate = !p.rotate; saveStore(); renderList(); renderRotation(); });
    ul.appendChild(li);
  }
  const empty = !visible().length;
  $("editorEmpty").hidden = !empty;
  $("editorForm").hidden = empty;
  if (empty) {
    $("editorEmptyText").textContent = store.apps.length
      ? `No presets under “${appName(currentApp())}” yet.`
      : "Add a Discord application first (Manage, in the top bar).";
    $("btnNewEmpty").textContent = store.apps.length ? "+ New preset" : "Manage applications";
  }
}

function markSelection() {
  $("presetList").querySelectorAll("li").forEach((li) => li.classList.toggle("on", Number(li.dataset.i) === sel));
}

function renderConn() {
  const pill = $("connPill"), txt = $("connText"), av = $("connAvatar");
  const u = conn.user;
  if (conn.connected) {
    pill.className = "pill on";
    txt.textContent = `Connected as ${u ? (u.global_name || u.username) : "Discord"}`;
    if (u && u.avatar) { av.src = `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`; av.hidden = false; } else av.hidden = true;
    pill.title = conn.client_id ? `Presence app: ${appName(conn.client_id)}` : "";
  } else if (current && !current.fatal && store.settings.autoReconnect) {
    pill.className = "pill wait";
    txt.textContent = lastError ? lastError : "Waiting for Discord…";
    pill.title = lastError;
    av.hidden = true;
  } else {
    pill.className = lastError ? "pill err" : "pill off";
    txt.textContent = lastError || "Not connected";
    pill.title = lastError;
    av.hidden = true;
  }
}

/// The application's icon as Discord's CDN serves it, once `fetchAppInfo` has seen the app.
function appIconUrl(cid, size) {
  const info = appInfo[cid];
  return info && info.icon ? `https://cdn.discordapp.com/app-icons/${cid}/${info.icon}.png?size=${size || 64}` : null;
}

function assetUrl(cid, key) {
  key = (key || "").trim();
  if (!key) return null;
  if (/^https?:\/\//.test(key)) return key;
  if (key.startsWith("mp:")) return null;
  const a = (assets[cid] || []).find((x) => x.name === key);
  return a ? `https://cdn.discordapp.com/app-assets/${cid}/${a.id}.png?size=160` : null;
}

function liveMeta() {
  if (!current) return "Nothing applied yet — hit Apply.";
  let s = `Live: ${current.preset.name || "untitled"} · applied ${hhmm(current.appliedAt)}`;
  if (current.pending) s += " (waiting for Discord)";
  else if (idlePaused) s += " (paused — you're idle)";
  return s;
}

/// Index of the store preset that's live right now, or -1 (nothing applied, or an auto-built
/// game/track card that isn't a saved preset). Matched by application + name, since `current`
/// holds a clone.
function liveIndex() {
  if (!current || !current.preset) return -1;
  const k = presetKey(current.preset);
  return store.presets.findIndex((p) => presetKey(p) === k);
}

/// Jump the editor to whatever is on your profile now.
function showLive() {
  const i = liveIndex();
  if (i < 0) { toast(current ? "What's live isn't a saved preset (a detected game or track)." : "Nothing is applied right now.", "warn"); return; }
  if (store.presets[i].clientId !== currentApp()) { store.settings.currentApp = store.presets[i].clientId; saveStore(); renderAll(); }
  select(i);
  const row = $("presetList").querySelector(`[data-i="${i}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

function renderLiveButton() {
  const i = liveIndex();
  const b = $("btnShowLive");
  b.hidden = !current;
  b.disabled = i < 0;
  b.classList.toggle("dim", i >= 0 && i === sel);
  b.title = i < 0 ? "What's live is a detected game or track, not a saved preset" : (i === sel ? "This preset is what's live now" : "Open what's on your profile right now in the editor");
}

function renderPreview() {
  const p = preset();
  const u = conn.user;
  $("pvAvatar").src = u && u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=80` : "https://cdn.discordapp.com/embed/avatars/0.png";
  $("pvName").textContent = u ? (u.global_name || u.username) : "You";
  if (!p) {
    $("pvHeader").textContent = "Playing a game";
    for (const id of ["pvL1", "pvL2", "pvL3", "pvTimer"]) $(id).textContent = "";
    $("pvBar").hidden = true; $("pvButtons").innerHTML = ""; $("pvSmall").hidden = true;
    $("pvLarge").style.backgroundImage = ""; $("pvLarge").classList.add("empty"); $("pvLargeKey").textContent = "";
    $("pvMeta").textContent = liveMeta();
    renderLiveButton();
    return;
  }
  const cid = p.clientId;
  const name = appOf(cid) || (appInfo[cid] && appInfo[cid].name) ? appName(cid) : "your app";

  const type = Number(p.type) || 0;
  const details = render(p.details).trim(), state = render(p.state).trim();
  const party = Number(p.partyMax) > 0 ? ` (${Math.min(Math.max(1, Number(p.partyCur) || 1), Number(p.partyMax))} of ${Number(p.partyMax)})` : "";
  let header, l1, l2, l3;
  if (type === 0) { header = "Playing a game"; l1 = name; l2 = details; l3 = state + (state ? party : ""); }
  else { header = `${TYPE_LABEL[type]} ${type === 5 ? "in" : "to"} ${name}`; l1 = details; l2 = state + (state ? party : ""); l3 = ""; }
  $("pvHeader").textContent = header;
  $("pvL1").textContent = l1; $("pvL2").textContent = l2; $("pvL3").textContent = l3;

  // With no large image Discord draws the application's icon as the tile, so the preview does too.
  const large = $("pvLarge");
  const iconUrl = appIconUrl(cid, 160);
  const largeUrl = assetUrl(cid, p.largeImage) || (!p.largeImage.trim() ? iconUrl : null);
  large.style.backgroundImage = largeUrl ? `url("${largeUrl}")` : "";
  large.classList.toggle("empty", !largeUrl);
  $("pvLargeKey").textContent = !largeUrl && p.largeImage.trim() ? p.largeImage.trim() : "";
  large.title = p.largeImage.trim() ? render(p.largeText) : iconUrl ? `${appName(cid)} — the application's icon` : "no image; upload an App Icon in the Developer Portal or set a large image";

  const small = $("pvSmall"), smallUrl = assetUrl(cid, p.smallImage);
  small.hidden = !p.smallImage.trim();
  small.style.backgroundImage = smallUrl ? `url("${smallUrl}")` : "";
  small.title = render(p.smallText);

  const btns = $("pvButtons");
  btns.innerHTML = "";
  p.buttons.filter((b) => b.label.trim() && b.url.trim()).slice(0, 2).forEach((b) => {
    const d = document.createElement("div"); d.className = "pv-btn"; d.textContent = b.label.trim(); d.title = b.url.trim(); btns.appendChild(d);
  });

  renderPreviewTimer();
  $("pvMeta").textContent = liveMeta();
  renderLiveButton();
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderPreviewTimer() {
  const p = preset();
  const timer = $("pvTimer"), bar = $("pvBar");
  if (!p) { timer.textContent = ""; bar.hidden = true; return; }
  const isLive = current && current.preset.name === p.name && current.preset.clientId === p.clientId && !current.pending;
  const ts = timestampsFor(p, isLive ? current.appliedAt : previewStart);
  const now = Date.now();
  if (!ts) { timer.textContent = ""; bar.hidden = true; return; }
  if (ts.end && Number(p.type) === 2) {
    timer.textContent = "";
    bar.hidden = false;
    const total = ts.end - ts.start, done = Math.min(total, Math.max(0, now - ts.start));
    $("pvBarFill").style.width = `${(done / total) * 100}%`;
    $("pvBarL").textContent = clock(done); $("pvBarR").textContent = clock(total);
    return;
  }
  bar.hidden = true;
  timer.textContent = ts.end ? `${clock(ts.end - now)} left` : `${clock(now - ts.start)} elapsed`;
}

function renderRotation() {
  const n = rotationList().length;
  const live = rotStops().length - n;            // detected game / playing track riding along
  const liveTxt = live ? ` + ${live} live` : "";
  $("btnRotate").textContent = rot.active ? "■ Stop" : "▶ Start";
  const scope = store.apps.length > 1 ? " · all apps" : "";
  $("rotInfo").textContent = rot.active
    ? `${n} presets${liveTxt} · next in ${Math.max(0, Math.ceil((rot.nextAt - Date.now()) / 1000))}s`
    : n ? `${n} selected${liveTxt}${scope}` : live ? `${live} live${scope}` : "off";
}

// ---------------------------------------------------------------- rotation menu

function setRotationInterval(v) {
  store.settings.rotationInterval = Math.max(15, Number(v) || 60);
  $("rotInterval").value = store.settings.rotationInterval;
  $("rotInterval2").value = store.settings.rotationInterval;
  saveStore();
}

/// Sidebar count always; the menu's list only when the live game/track stops actually changed
/// (rebuilding it mid-click would swallow the click).
let lastLiveSig = "";
function refreshRotationUi() {
  renderRotation();
  const sig = rotStops().filter((s) => s.game || s.music).map(stopKey).join("|");
  if (sig !== lastLiveSig) { lastLiveSig = sig; renderRotationModal(); }
}

function rotationNowStop() { return rot.active && rot.idx >= 0 ? rotSeq[rot.idx] || null : null; }
function rotationNow() {
  const s = rotationNowStop();
  return s ? s.preset || null : null;   // a game/track stop has no preset row in the sidebar
}
function stopLabel(s) {
  if (s.game) return `${s.game.name} · live game`;
  if (s.music) return `${s.music.title}${s.music.artist ? " — " + s.music.artist : ""} · now playing`;
  return `${s.preset.name} · ${appName(s.preset.clientId)}`;
}

function openRotation() {
  $("rotModal").hidden = false;
  renderRotationModal();
}

/// The cheap part, refreshed every second while the menu is open.
function renderRotationStatus() {
  if ($("rotModal").hidden) return;
  const list = rotationList();
  const now = rotationNowStop();
  const total = rotStops().length;
  $("btnRotate2").textContent = rot.active ? "■ Stop" : "▶ Start";
  $("rotNow").textContent = rot.active
    ? `Now: ${now ? stopLabel(now) : "—"} · next in ${Math.max(0, Math.ceil((rot.nextAt - Date.now()) / 1000))} s`
    : total ? `${total} stop${total === 1 ? "" : "s"} in the cycle — not running.` : "Nothing in the cycle yet — tick presets below.";
  const nowKey = now ? stopKey(now) : null;
  $("rotInList").querySelectorAll(".rot-row").forEach((row) => row.classList.toggle("now", !!nowKey && row.dataset.key === nowKey));
}

const presetKey = (p) => `${p.clientId}${p.name}`;

/// The full lists; rebuilt on open and after every edit (not per tick, so clicks land).
function renderRotationModal() {
  if ($("rotModal").hidden) return;
  $("rotInterval2").value = store.settings.rotationInterval;
  const list = rotationList();
  const cur = rotationNow();
  const now = rotationNowStop();

  const liveStops = rotStops().filter((s) => s.game || s.music);
  const inBox = $("rotInList");
  inBox.innerHTML = list.length || liveStops.length ? "" : `<span class="muted">Empty.</span>`;
  list.forEach((p, k) => {
    const row = document.createElement("div");
    row.className = "rot-row" + (cur === p ? " now" : "");
    row.dataset.key = presetKey(p);
    const w = rotWeight(p);
    row.innerHTML = `<label class="check"><input type="checkbox" checked><span class="ty">${TYPE_GLYPH[p.type] || "🎮"}</span><span class="nm"></span><span class="app muted"></span></label><button class="wt ${w > 1 ? "on" : ""}" title="How often it shows in the cycle — click to change">×${w}</button><button class="ghost small" data-mv="-1" title="Earlier">▲</button><button class="ghost small" data-mv="1" title="Later">▼</button>`;
    row.querySelector(".nm").textContent = p.name || "untitled";
    row.querySelector(".app").textContent = appName(p.clientId);
    row.querySelector("input").addEventListener("change", () => { p.rotate = false; afterRotationEdit(); });
    row.querySelector(".wt").addEventListener("click", () => { p.weight = (rotWeight(p) % 3) + 1; afterRotationEdit(); });
    row.querySelector('[data-mv="-1"]').disabled = k === 0;
    row.querySelector('[data-mv="1"]').disabled = k === list.length - 1;
    row.querySelectorAll("[data-mv]").forEach((b) => b.addEventListener("click", () => moveInRotation(p, Number(b.dataset.mv))));
    inBox.appendChild(row);
  });

  // Live stops from game / music mode ("keep rotating"). They ride at the end of the cycle and
  // come and go with the game or track; the panel's placement controls whether they're here at
  // all, so there's no untick — but the ×N weight works like a preset's.
  liveStops.forEach((s) => {
    const row = document.createElement("div");
    row.className = "rot-row live" + (now && stopKey(now) === stopKey(s) ? " now" : "");
    row.dataset.key = stopKey(s);
    const w = s.weight;
    row.innerHTML = `<label class="check"><span class="ty">${s.game ? "🎮" : "🎧"}</span><span class="nm"></span><span class="app muted"></span></label><button class="wt ${w > 1 ? "on" : ""}" title="How often it shows in the cycle — click to change">×${w}</button><span class="live-tag" title="Comes and goes with the ${s.game ? "game" : "track"}; set by ${s.game ? "Game" : "Music"} mode → keep rotating">live</span>`;
    row.querySelector(".nm").textContent = s.game ? s.game.name : `${s.music.title}${s.music.artist ? " — " + s.music.artist : ""}`;
    row.querySelector(".app").textContent = s.game ? "detected game" : "now playing";
    row.querySelector(".wt").addEventListener("click", () => {
      const k = s.game ? "gameRotWeight" : "musicRotWeight";
      store.settings[k] = (clampWeight(store.settings[k]) % 3) + 1;
      afterRotationEdit();
    });
    inBox.appendChild(row);
  });

  const av = $("rotAvail");
  av.innerHTML = "";
  let any = false;
  for (const a of store.apps) {
    const items = store.presets.filter((p) => p.clientId === a.id && !p.rotate);
    if (!items.length) continue;
    any = true;
    const h = document.createElement("div");
    h.className = "rot-app";
    h.textContent = appName(a.id);
    av.appendChild(h);
    for (const p of items) {
      const row = document.createElement("div");
      row.className = "rot-row";
      row.innerHTML = `<label class="check"><input type="checkbox"><span class="ty">${TYPE_GLYPH[p.type] || "🎮"}</span><span class="nm"></span></label>`;
      row.querySelector(".nm").textContent = p.name || "untitled";
      row.querySelector("input").addEventListener("change", () => { p.rotate = true; afterRotationEdit(); });
      av.appendChild(row);
    }
  }
  if (!any) av.innerHTML = `<span class="muted">Everything is in the cycle.</span>`;
  renderRotationStatus();
}

function afterRotationEdit() {
  saveStore();
  renderList();
  renderRotation();
  if (rot.active) {
    const cur = rotationNow();
    if (rotStops().length < 2) stopRotation();
    else { buildRotSeq(); if (cur) rot.idx = Math.max(0, seqIndexOfPreset(cur)); }
  }
  renderRotationModal();
}

/// Reorder within the cycle by moving the preset next to its neighbour in the store.
function moveInRotation(p, dir) {
  const list = rotationList();
  const k = list.indexOf(p);
  const other = list[k + dir];
  if (!other) return;
  const cur = rotationNow();
  const selected = preset();
  store.presets.splice(store.presets.indexOf(p), 1);
  const j = store.presets.indexOf(other);
  store.presets.splice(dir < 0 ? j : j + 1, 0, p);
  sel = selected ? store.presets.indexOf(selected) : -1;
  if (rot.active) { buildRotSeq(); if (cur) rot.idx = Math.max(0, seqIndexOfPreset(cur)); }
  saveStore();
  renderList();
  markSelection();
  renderRotation();
  renderRotationModal();
  syncTray();
}

function renderAssets() {
  const p = preset();
  const list = p ? assets[p.clientId] || [] : [];
  $("assetList").innerHTML = list.map((a) => `<option value="${esc(a.name)}"></option>`).join("");
}

function syncTray() {
  const status = conn.connected
    ? `Discord: ${conn.user ? (conn.user.global_name || conn.user.username) : "connected"}`
    : "Discord: not connected";
  const groups = store.apps.map((a) => ({
    app: appName(a.id),
    presets: store.presets.map((p, index) => ({ index, p })).filter((x) => x.p.clientId === a.id).map((x) => ({ index: x.index, name: x.p.name || "untitled" })),
  }));
  const stray = store.presets.map((p, index) => ({ index, p })).filter((x) => !appOf(x.p.clientId));
  if (stray.length) groups.push({ app: "unassigned", presets: stray.map((x) => ({ index: x.index, name: x.p.name || "untitled" })) });
  let tooltip = "Statusmith — no presence";
  if (current && !current.pending && current.rendered) {
    let d = "";
    try { d = JSON.parse(current.rendered).details || ""; } catch {}
    tooltip = idlePaused
      ? "Statusmith — paused while idle"
      : `Statusmith — ${TYPE_LABEL[current.preset.type] || "Playing"} ${appName(current.preset.clientId)}${d ? ": " + d : ""}`;
  }
  const update = updateInfo ? updateInfo.version : null;
  const key = JSON.stringify([status, groups, rot.active, tooltip, update]);
  if (key === trayKey) return;
  trayKey = key;
  invoke("set_tray", { status, groups, rotating: rot.active, tooltip: tooltip.slice(0, 120), update }).catch(() => {});
}

// ---------------------------------------------------------------- applications

function openApps(msg) {
  $("appsMsg").textContent = msg || "";
  $("newAppId").value = ""; $("newAppName").value = "";
  renderApps();
  $("appsModal").hidden = false;
  $("newAppId").focus();
}

function renderApps() {
  const box = $("appRows");
  box.innerHTML = "";
  if (!store.apps.length) {
    box.innerHTML = `<p class="muted">No applications yet.</p>`;
    return;
  }
  for (const a of store.apps) {
    const row = document.createElement("div");
    row.className = "app-row";
    row.innerHTML = `<span class="app-icon"></span><input class="app-name" placeholder="name" spellcheck="false"><code></code><span class="count"></span><button class="ghost small danger">Remove</button>`;
    const icon = appIconUrl(a.id, 64);
    const iconEl = row.querySelector(".app-icon");
    if (icon) iconEl.style.backgroundImage = `url("${icon}")`;
    else iconEl.textContent = (appName(a.id) || "?").slice(0, 1).toUpperCase();
    iconEl.title = icon ? "Application icon (Developer Portal → General Information)" : "No icon uploaded yet — Discord shows a grey tile until there is one";
    const nameEl = row.querySelector(".app-name");
    nameEl.value = a.name || "";
    nameEl.title = a.auto ? "Fetched from Discord — edit to override" : "Custom name";
    row.querySelector("code").textContent = a.id;
    const n = presetCount(a.id);
    row.querySelector(".count").textContent = `${n} preset${n === 1 ? "" : "s"}`;
    nameEl.addEventListener("change", () => {
      const v = nameEl.value.trim();
      if (v) { a.name = v; a.auto = false; }
      else { a.auto = true; a.name = (appInfo[a.id] && appInfo[a.id].name) || ""; nameEl.value = a.name; }
      saveStore(); renderAll();
    });
    row.querySelector("button").addEventListener("click", () => removeApp(a.id));
    box.appendChild(row);
  }
}

function addApp() {
  const id = $("newAppId").value.trim();
  const name = $("newAppName").value.trim();
  if (!ID_RE.test(id)) { $("appsMsg").textContent = "Application IDs are 17–20 digit numbers (General Information → Application ID)."; return; }
  if (appOf(id)) { $("appsMsg").textContent = "That application is already in the list."; return; }
  store.apps.push({ id, name, auto: !name });
  // First app: adopt every preset that was never assigned (the starters, or a fresh install).
  if (store.apps.length === 1) for (const p of store.presets) if (!p.clientId) p.clientId = id;
  store.settings.currentApp = id;
  saveStore();
  fetchAppInfo(id);
  $("newAppId").value = ""; $("newAppName").value = "";
  $("appsMsg").textContent = "";
  const v = visible();
  select(v.length ? v[0] : -1);
  renderAll();
  renderApps();
  toast(`Added ${name || "application …" + id.slice(-4)}.`, "ok");
}

function removeApp(id) {
  const n = presetCount(id);
  if (n) { $("appsMsg").textContent = `“${appName(id)}” still has ${n} preset${n === 1 ? "" : "s"} — move them to another application (editor → Application) or delete them first.`; return; }
  store.apps = store.apps.filter((a) => a.id !== id);
  if (currentApp() === id) store.settings.currentApp = store.apps[0] ? store.apps[0].id : "";
  saveStore();
  const v = visible();
  select(v.length ? v[0] : -1);
  renderAll();
  renderApps();
}

function switchApp(id) {
  if (id === currentApp()) return;
  store.settings.currentApp = id;
  saveStore();
  const v = visible();
  const keep = current && current.preset.clientId === id ? store.presets.findIndex((p) => p.clientId === id && p.name === current.preset.name) : -1;
  select(keep >= 0 ? keep : v.length ? v[0] : -1);
  renderAll();
}

// ---------------------------------------------------------------- import / export

async function exportPresets() {
  try {
    const path = await invoke("export_presets", { data: { statusmith: appVersion, apps: store.apps, presets: store.presets } });
    if (path) toast(`Exported ${store.presets.length} presets to ${path}`, "ok");
  } catch (e) { toast("Export failed: " + e, "err"); }
}

async function importPresets() {
  try {
    const data = await invoke("import_presets");
    if (!data) return;
    if (!Array.isArray(data.presets) || !data.presets.length) { toast("No presets in that file.", "warn"); return; }
    const apps = normalizeApps(data.apps), presets = normalizePresets(data.presets);
    let addedApps = 0, addedPresets = 0;
    for (const a of apps) if (!appOf(a.id)) { store.apps.push(a); addedApps++; }
    for (const p of presets) {
      if (!ID_RE.test(p.clientId)) continue;
      if (!appOf(p.clientId)) { store.apps.push({ id: p.clientId, name: "", auto: true }); addedApps++; }
      if (store.presets.some((q) => q.name === p.name && q.clientId === p.clientId)) continue;
      p.name = uniqueName(p.name); p.rotate = false;
      store.presets.push(p); addedPresets++;
    }
    if (!appOf(currentApp()) && store.apps.length) store.settings.currentApp = store.apps[0].id;
    saveStore();
    store.apps.forEach((a) => fetchAppInfo(a.id));
    renderAll();
    if (sel < 0) { const v = visible(); if (v.length) select(v[0]); }
    toast(`Imported ${addedPresets} preset${addedPresets === 1 ? "" : "s"}${addedApps ? ` and ${addedApps} application${addedApps === 1 ? "" : "s"}` : ""}.`, "ok");
  } catch (e) { toast("Import failed: " + e, "err"); }
}

// ---------------------------------------------------------------- docs (README / LICENSE / shortcuts)

const SHORTCUTS_HTML = `
<table><thead><tr><th>Keys</th><th>Action</th></tr></thead><tbody>
<tr><td><kbd>Ctrl</kbd><kbd>Enter</kbd></td><td>Apply the selected preset</td></tr>
<tr><td>double-click a preset</td><td>Apply it</td></tr>
<tr><td><kbd>Ctrl</kbd><kbd>N</kbd></td><td>New preset under the current application</td></tr>
<tr><td><kbd>Ctrl</kbd><kbd>D</kbd></td><td>Duplicate the selected preset</td></tr>
<tr><td><kbd>Delete</kbd></td><td>Delete the selected preset (when not typing in a field)</td></tr>
<tr><td><kbd>Ctrl</kbd><kbd>↑</kbd> / <kbd>Ctrl</kbd><kbd>↓</kbd></td><td>Move the selected preset up / down</td></tr>
<tr><td><kbd>Esc</kbd></td><td>Close any dialog</td></tr>
</tbody></table>
<p class="muted">Tray: left-click opens the window; right-click applies presets, toggles rotation, clears, quits.</p>`;

function md(src) {
  const lines = String(src).replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  const inline = (s) => {
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/(^|[^*\w])\*([^*]+)\*(?!\w)/g, "$1<i>$2</i>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => `<a href="#" data-url="${esc(u)}">${t}</a>`);
    return s;
  };
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").replace(/\\\|/g, "").split("|").map((c) => inline(c.trim().replace(//g, "|")));
  const isBlockStart = (l) => /^(#{1,3}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*\||\s*>)/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
    }
    const h = /^(#{1,3})\s+(.*)/.exec(l);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const listItem = (re) => {
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        let t = lines[i].replace(re, ""); i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i]) && !/^\s*\|/.test(lines[i])) t += " " + lines[i++].trim();
        items.push(`<li>${inline(t)}</li>`);
      }
      return items.join("");
    };
    if (/^\s*[-*]\s+/.test(l)) { out.push(`<ul>${listItem(/^\s*[-*]\s+/)}</ul>`); continue; }
    if (/^\s*\d+\.\s+/.test(l)) { out.push(`<ol>${listItem(/^\s*\d+\.\s+/)}</ol>`); continue; }
    if (/^\s*>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = [l]; i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

async function openDoc(name, opts = {}) {
  const body = $("docBody");
  afterDocClose = opts.after || null;
  $("docFoot").textContent = "";
  if (name === "shortcuts") {
    $("docTitle").textContent = "Keyboard shortcuts";
    body.innerHTML = SHORTCUTS_HTML;
  } else {
    $("docTitle").textContent = opts.title || (name === "license" ? "License" : "README");
    body.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const text = await invoke("read_doc", { name });
      body.innerHTML = name === "license" ? `<pre><code>${esc(text)}</code></pre>` : md(text);
      if (name === "readme") $("docFoot").textContent = `Statusmith v${appVersion}`;
    } catch (e) { body.innerHTML = `<p class="validation">${esc(String(e))}</p>`; }
  }
  $("docModal").hidden = false;
  body.scrollTop = 0;
}

// ---------------------------------------------------------------- wiki

let wikiPages = null;        // [{ id, title, body }], compiled into the app
let wikiCurrent = "";
let afterWikiClose = null;
const WIKI_URL = `${REPO_URL}/blob/main/docs/wiki`;

async function loadWiki() {
  if (wikiPages) return wikiPages;
  try { wikiPages = await invoke("wiki_pages"); }
  catch (e) { wikiPages = []; toast("Couldn't load the wiki: " + e, "err"); }
  return wikiPages;
}

async function openWiki(id, opts = {}) {
  await loadWiki();
  if (!wikiPages.length) return;
  afterWikiClose = opts.after || null;
  $("wikiSearch").value = "";
  wikiCurrent = wikiPages.some((p) => p.id === id) ? id : wikiPages[0].id;
  renderWikiNav("");
  showWikiPage(wikiCurrent);
  $("wikiModal").hidden = false;
  $("wikiSearch").focus();
}

function renderWikiNav(query) {
  const nav = $("wikiNav");
  nav.innerHTML = "";
  const q = query.trim().toLowerCase();
  for (const p of wikiPages) {
    const a = document.createElement("a");
    a.href = "#";
    a.dataset.id = p.id;
    a.className = p.id === wikiCurrent ? "on" : "";
    let hit = "";
    if (q) {
      const i = p.body.toLowerCase().indexOf(q);
      if (i >= 0) {
        const s = Math.max(0, i - 28);
        hit = (s > 0 ? "…" : "") + p.body.slice(s, i + q.length + 44).replace(/\s+/g, " ") + "…";
      } else if (!p.title.toLowerCase().includes(q)) {
        a.classList.add("dim");
      }
    }
    a.innerHTML = `<span></span>${hit ? "<small></small>" : ""}`;
    a.querySelector("span").textContent = p.title;
    if (hit) a.querySelector("small").textContent = hit;
    a.addEventListener("click", (e) => { e.preventDefault(); showWikiPage(p.id); });
    nav.appendChild(a);
  }
}

function showWikiPage(id) {
  const p = wikiPages.find((x) => x.id === id) || wikiPages[0];
  if (!p) return;
  wikiCurrent = p.id;
  const page = $("wikiPage");
  page.innerHTML = md(p.body);
  const q = $("wikiSearch").value.trim();
  if (q) highlightText(page, q);
  page.scrollTop = 0;
  $("wikiNav").querySelectorAll("a").forEach((a) => a.classList.toggle("on", a.dataset.id === p.id));
  $("wikiFoot").textContent = `${p.title} · Statusmith v${appVersion}`;
  $("wikiOnGithub").dataset.url = `${WIKI_URL}/${p.id}.md`;
}

function highlightText(root, q) {
  const needle = q.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) if (n.nodeValue.toLowerCase().includes(needle)) nodes.push(n);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let rest = node.nodeValue;
    while (rest.length) {
      const i = rest.toLowerCase().indexOf(needle);
      if (i < 0) { frag.appendChild(document.createTextNode(rest)); break; }
      frag.appendChild(document.createTextNode(rest.slice(0, i)));
      const m = document.createElement("mark");
      m.textContent = rest.slice(i, i + q.length);
      frag.appendChild(m);
      rest = rest.slice(i + q.length);
    }
    node.parentNode.replaceChild(frag, node);
  }
}

// ---------------------------------------------------------------- editor binding

const FIELDS = {
  pName: "name", pDetails: "details", pState: "state",
  pLargeImage: "largeImage", pLargeText: "largeText", pSmallImage: "smallImage", pSmallText: "smallText",
  pDuration: "duration", pPartyCur: "partyCur", pPartyMax: "partyMax",
};

function renderPresetAppSelect() {
  const p = preset();
  const el = $("pApp");
  const opts = store.apps.map((a) => `<option value="${esc(a.id)}">${esc(appName(a.id))}</option>`);
  if (p && !appOf(p.clientId)) opts.unshift(`<option value="${esc(p.clientId)}">${p.clientId ? "unknown app " + esc(p.clientId) : "not assigned"}</option>`);
  el.innerHTML = opts.join("");
  if (p) el.value = p.clientId;
}

function loadEditor() {
  const p = preset();
  if (!p) return;
  for (const [id, key] of Object.entries(FIELDS)) $(id).value = p[key] ?? "";
  $("pLoop").checked = !!p.loop;
  $("pBtn1Label").value = p.buttons[0].label; $("pBtn1Url").value = p.buttons[0].url;
  $("pBtn2Label").value = p.buttons[1].label; $("pBtn2Url").value = p.buttons[1].url;
  setSeg("typeSeg", "type", String(p.type));
  setSeg("timeSeg", "time", p.timeMode);
  $("countdownRow").hidden = p.timeMode !== "countdown";
  $("typeHint").textContent = TYPE_HINT[p.type] || "";
  renderPresetAppSelect();
  updateCounts();
  validate();
}

function readEditor() {
  const p = preset();
  if (!p) return;
  for (const [id, key] of Object.entries(FIELDS)) {
    const v = $(id).value;
    p[key] = id === "pDuration" || id === "pPartyCur" || id === "pPartyMax" ? Number(v) || 0 : v;
  }
  p.loop = $("pLoop").checked;
  p.buttons = [
    { label: $("pBtn1Label").value, url: $("pBtn1Url").value },
    { label: $("pBtn2Label").value, url: $("pBtn2Url").value },
  ];
  updateCounts();
  validate();
  saveStore();
  renderList();
  renderPreview();
  renderAssets();
  syncTray();
}

function setSeg(segId, attr, value) {
  $(segId).querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset[attr] === value));
}

function updateCounts() {
  document.querySelectorAll(".count[data-for]").forEach((c) => {
    const el = $(c.dataset.for);
    c.textContent = `${el.value.length}/128`;
    c.classList.toggle("over", el.value.length > 128);
  });
}

function validate() {
  const p = preset();
  if (!p) { $("validation").textContent = ""; return; }
  const msgs = [];
  if (!ID_RE.test(p.clientId)) msgs.push("Not assigned to an application — Apply will ask for one.");
  if (render(p.details).trim().length === 1) msgs.push("Details needs at least 2 characters.");
  if (render(p.state).trim().length === 1) msgs.push("State needs at least 2 characters.");
  if (!p.details.trim() && !p.state.trim() && !p.largeImage.trim()) msgs.push("Empty presence — add details, state or an image.");
  p.buttons.forEach((b, i) => { if (b.label.trim() && b.url.trim() && !/^https?:\/\//.test(b.url.trim())) msgs.push(`Button ${i + 1} link must start with http(s)://`); });
  if (Number(p.partyMax) > 0 && Number(p.partyCur) > Number(p.partyMax)) msgs.push("Party current can't exceed max.");
  $("validation").textContent = msgs.join("  ·  ");
}

function select(i) {
  sel = i >= 0 && i < store.presets.length ? i : -1;
  previewStart = Date.now();
  loadEditor();
  markSelection();
  renderPreview();
  renderAssets();
  const p = preset();
  if (p) fetchAppInfo(p.clientId);
}

function uniqueName(base) {
  let name = base, n = 2;
  while (store.presets.some((p) => p.name === name)) name = `${base} ${n++}`;
  return name;
}

function newPreset() {
  if (!store.apps.length) { openApps("Add an application first — every preset needs one."); return; }
  store.presets.push(blankPreset(uniqueName("New preset"), currentApp()));
  saveStore();
  renderList();
  select(store.presets.length - 1);
  $("pName").focus(); $("pName").select();
}

function duplicatePreset() {
  const p = preset(); if (!p) return;
  const c = clone(p); c.name = uniqueName(`${c.name} copy`); c.rotate = false;
  store.presets.splice(sel + 1, 0, c);
  saveStore();
  renderList();
  select(sel + 1);
  syncTray();
}

function deletePreset() {
  const p = preset(); if (!p) return;
  const v = visible(), pos = v.indexOf(sel);
  const wasLive = current && current.preset.name === p.name && current.preset.clientId === p.clientId;
  store.presets.splice(sel, 1);
  // A faked game leaves behind its own app; when its last preset goes, drop the app too so the
  // LARP disappears completely from the Application menu.
  const app = appOf(p.clientId);
  const gone = app && app.game && !store.presets.some((q) => q.clientId === p.clientId);
  if (gone) {
    store.apps = store.apps.filter((a) => a.id !== p.clientId);
    if (currentApp() === p.clientId) store.settings.currentApp = store.apps[0] ? store.apps[0].id : "";
  }
  saveStore();
  if (wasLive) clearPresence(true);   // stop showing the game we just deleted
  renderAll();
  const v2 = visible();
  select(v2.length ? v2[Math.min(pos, v2.length - 1)] : -1);
  toast(gone ? `Stopped faking ${p.name}.` : `Deleted “${p.name}”.`);
  syncTray();
}

function movePreset(dir) {
  const p = preset(); if (!p) return;
  const v = visible(), pos = v.indexOf(sel), target = v[pos + dir];
  if (target == null) return;
  [store.presets[sel], store.presets[target]] = [store.presets[target], store.presets[sel]];
  saveStore();
  renderList();
  select(target);
  syncTray();
}

function buildChips() {
  const box = $("chips");
  box.innerHTML = "";
  for (const [name, v] of Object.entries(VARS)) {
    const b = document.createElement("button");
    b.className = "chip";
    b.innerHTML = `{${name}}<small></small>`;
    b.querySelector("small").textContent = v.fn ? v.fn() : v.hint;
    b.title = v.fn ? `now: ${v.fn()}` : "picks one option at random each refresh";
    b.addEventListener("click", () => insertChip(`{${name}}`));
    box.appendChild(b);
  }
}

function insertChip(text) {
  if (!preset()) return;
  const el = lastFocused && lastFocused.isConnected ? lastFocused : $("pDetails");
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
  el.setRangeText(text, s, e, "end");
  el.focus();
  readEditor();
}

// ---------------------------------------------------------------- toasts / modals

function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $("toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, kind === "err" ? 6000 : 3200);
}

function openHelp() { $("helpModal").hidden = false; }

function closeModals() {
  const docWasOpen = !$("docModal").hidden;
  const wikiWasOpen = !$("wikiModal").hidden;
  document.querySelectorAll(".modal").forEach((m) => { m.hidden = true; });
  if (docWasOpen && afterDocClose) { const f = afterDocClose; afterDocClose = null; f(); }
  if (wikiWasOpen && afterWikiClose) { const f = afterWikiClose; afterWikiClose = null; f(); }
}

// ---------------------------------------------------------------- wiring

function wire() {
  // top bar
  $("appSelect").addEventListener("change", () => {
    const v = $("appSelect").value;
    if (v === "__manage") { $("appSelect").value = currentApp(); openApps(); return; }
    switchApp(v);
  });
  $("btnApps").addEventListener("click", () => openApps());
  $("btnAppHelp").addEventListener("click", () => openWiki("getting-started"));
  $("btnHelpClose").addEventListener("click", closeModals);
  $("btnAppsClose").addEventListener("click", closeModals);
  $("btnDocClose").addEventListener("click", closeModals);
  document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) closeModals(); }));
  for (const id of ["linkDevPortal", "linkDevPortal2"]) $(id).addEventListener("click", (e) => { e.preventDefault(); invoke("open_url", { url: DEV_PORTAL }); });
  $("btnAddApp").addEventListener("click", addApp);
  $("newAppId").addEventListener("keydown", (e) => { if (e.key === "Enter") addApp(); });
  $("newAppName").addEventListener("keydown", (e) => { if (e.key === "Enter") addApp(); });
  $("btnApply").addEventListener("click", () => { const p = preset(); if (p) { stopRotation(true); apply(p); } });
  $("btnClear").addEventListener("click", () => clearPresence(false));

  // sidebar
  $("btnNew").addEventListener("click", newPreset);
  $("btnNewEmpty").addEventListener("click", () => (store.apps.length ? newPreset() : openApps()));
  $("btnDup").addEventListener("click", duplicatePreset);
  $("btnDelete").addEventListener("click", deletePreset);
  $("rotInterval").addEventListener("change", () => setRotationInterval($("rotInterval").value));
  $("rotInterval2").addEventListener("change", () => setRotationInterval($("rotInterval2").value));
  const toggleRotation = () => { if (rot.active) stopRotation(); else startRotation(); renderRotationStatus(); };
  $("btnRotate").addEventListener("click", toggleRotation);
  $("btnRotate2").addEventListener("click", toggleRotation);
  $("rotOpen").addEventListener("click", (e) => { e.preventDefault(); openRotation(); });
  $("btnRotClose").addEventListener("click", closeModals);

  // editor
  for (const id of Object.keys(FIELDS)) $(id).addEventListener("input", readEditor);
  for (const id of ["pBtn1Label", "pBtn1Url", "pBtn2Label", "pBtn2Url"]) $(id).addEventListener("input", readEditor);
  $("pLoop").addEventListener("change", readEditor);
  $("pName").addEventListener("change", () => {
    const p = preset(); if (!p) return;
    if (!p.name.trim()) p.name = uniqueName("Untitled");
    else if (store.presets.some((q, i) => i !== sel && q.name === p.name)) { p.name = uniqueName(p.name); toast("Renamed — that name was taken.", "warn"); }
    $("pName").value = p.name; saveStore(); renderList(); syncTray();
  });
  $("pApp").addEventListener("change", () => {
    const p = preset(); if (!p) return;
    p.clientId = $("pApp").value;
    saveStore();
    // Follow the preset into its new application.
    store.settings.currentApp = p.clientId;
    const keep = sel;
    renderAll();
    select(keep);
    fetchAppInfo(p.clientId);
  });
  $("typeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); const p = preset(); if (!b || !p) return;
    p.type = Number(b.dataset.type); setSeg("typeSeg", "type", b.dataset.type);
    $("typeHint").textContent = TYPE_HINT[p.type]; readEditor();
  });
  $("timeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); const p = preset(); if (!b || !p) return;
    p.timeMode = b.dataset.time; setSeg("timeSeg", "time", b.dataset.time);
    $("countdownRow").hidden = b.dataset.time !== "countdown"; previewStart = Date.now(); readEditor();
  });
  document.querySelectorAll("#editorForm input:not([type=number]):not([type=checkbox])").forEach((el) => {
    el.addEventListener("focus", () => { if (el.id !== "pName") lastFocused = el; });
  });

  // settings
  $("sReconnect").addEventListener("change", () => { store.settings.autoReconnect = $("sReconnect").checked; saveStore(); renderConn(); });
  $("sRestore").addEventListener("change", () => { store.settings.restoreOnLaunch = $("sRestore").checked; saveStore(); });
  $("sAutostart").addEventListener("change", async () => {
    try { await invoke("set_autostart", { enabled: $("sAutostart").checked }); toast($("sAutostart").checked ? "Statusmith will start with Windows." : "Autostart off."); }
    catch (e) { toast(String(e), "err"); $("sAutostart").checked = !$("sAutostart").checked; }
  });
  $("sUpdates").addEventListener("change", () => { store.settings.autoUpdate = $("sUpdates").checked; saveStore(); if (store.settings.autoUpdate) checkForUpdates(false); });
  const idleChanged = async () => {
    const on = $("sIdle").checked;
    const min = Math.max(1, Math.min(720, Number($("sIdleMin").value) || 15));
    $("sIdleMin").value = min;
    store.settings.idlePauseMin = on ? min : 0;
    saveStore();
    if (!on && idlePaused && current) await apply(current.preset, { silent: true, keepAppliedAt: true });
  };
  $("sIdle").addEventListener("change", idleChanged);
  $("sIdleMin").addEventListener("change", idleChanged);
  $("sGameMode").addEventListener("change", () => setGameMode($("sGameMode").checked));
  $("sGameTimer").addEventListener("change", () => {
    store.settings.gameTimer = $("sGameTimer").checked; saveStore();
    if (gameNow && current && current.auto && current.autoKind === "game")
      apply(gamePreset(gameNow), { silent: true, transient: true, auto: true, autoKind: "game" });
  });
  $("sGamePlacement").addEventListener("change", () => {
    store.settings.gamePlacement = $("sGamePlacement").value; saveStore();
    lastAutoPoll = 0; buildRotSeq(); renderGamePanel();
  });
  $("btnGamesRefresh").addEventListener("click", () => refreshGames(true));
  $("btnFakeGame").addEventListener("click", openGamePicker);
  $("btnGamePickClose").addEventListener("click", closeModals);
  $("gamePickSearch").addEventListener("input", () => renderGamePicks($("gamePickSearch").value));
  $("gameHelp").addEventListener("click", (e) => { e.preventDefault(); openWiki("game-mode"); });
  $("sMusicMode").addEventListener("change", () => setMusicMode($("sMusicMode").checked));
  $("sMusicApp").addEventListener("change", () => {
    store.settings.musicApp = $("sMusicApp").value; saveStore();
    lastAutoPoll = 0;
    if (current && current.auto && current.autoKind === "music") { autoNow = null; }
    renderMusicPanel();
  });
  $("sMusicPlacement").addEventListener("change", () => {
    store.settings.musicPlacement = $("sMusicPlacement").value; saveStore();
    autoNow = null; lastAutoPoll = 0; buildRotSeq(); renderMusicPanel();
  });
  $("sMusicByArtist").addEventListener("change", () => {
    store.settings.musicByArtist = $("sMusicByArtist").checked; saveStore();
    if (musicNow && current && current.auto && current.autoKind === "music")
      apply(musicPreset(musicNow), { silent: true, transient: true, auto: true, autoKind: "music" });
  });
  $("musicHelp").addEventListener("click", (e) => { e.preventDefault(); openWiki("music-mode"); });
  $("pvAvatar").addEventListener("error", () => $("pvAvatar").removeAttribute("src"));
  $("connAvatar").addEventListener("error", () => { $("connAvatar").hidden = true; });
  $("btnShowLive").addEventListener("click", showLive);
  $("btnHide").addEventListener("click", () => invoke("hide_window"));
  $("btnData").addEventListener("click", () => invoke("open_data_dir"));

  // about / updates / docs
  $("btnCheckUpdate").addEventListener("click", () => checkForUpdates(true));
  $("btnUpdateInstall").addEventListener("click", installUpdate);
  $("btnUpdateNotes").addEventListener("click", () => {
    if (!updateInfo) return;
    afterDocClose = null;
    $("docTitle").textContent = `What's new in v${updateInfo.version}`;
    $("docBody").innerHTML = md(updateInfo.notes || "");
    $("docFoot").textContent = updateInfo.date ? updateInfo.date.slice(0, 10) : "";
    $("docModal").hidden = false;
  });
  $("btnUpdateLater").addEventListener("click", () => {
    $("updateBar").hidden = true;
    if (updateInfo) { store.settings.updateDismissed = updateInfo.version; saveStore(); }
  });
  $("btnExport").addEventListener("click", exportPresets);
  $("btnImport").addEventListener("click", importPresets);
  $("linkGithub").addEventListener("click", (e) => { e.preventDefault(); invoke("open_url", { url: REPO_URL }); });
  $("linkReadme").addEventListener("click", (e) => { e.preventDefault(); openDoc("readme"); });
  $("linkLicense").addEventListener("click", (e) => { e.preventDefault(); openDoc("license"); });
  $("linkShortcuts").addEventListener("click", (e) => { e.preventDefault(); openWiki("shortcuts"); });
  $("linkWiki").addEventListener("click", (e) => { e.preventDefault(); openWiki(wikiCurrent || "getting-started"); });
  $("btnWikiClose").addEventListener("click", closeModals);
  $("btnHelpWiki").addEventListener("click", () => { closeModals(); openWiki("getting-started"); });
  $("wikiSearch").addEventListener("input", () => { renderWikiNav($("wikiSearch").value); showWikiPage(wikiCurrent); });
  $("wikiOnGithub").addEventListener("click", (e) => { e.preventDefault(); invoke("open_url", { url: e.currentTarget.dataset.url || WIKI_URL }); });
  $("wikiPage").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-url]");
    if (!a) return;
    e.preventDefault();
    const u = a.dataset.url;
    if (u.startsWith("wiki:")) showWikiPage(u.slice(5));
    else if (/^https?:\/\//.test(u)) invoke("open_url", { url: u });
  });
  $("docBody").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-url]");
    if (!a) return;
    e.preventDefault();
    const u = a.dataset.url;
    if (/^https?:\/\//.test(u)) invoke("open_url", { url: u });
    else if (/LICENSE/i.test(u)) openDoc("license");
    else if (/README/i.test(u)) openDoc("readme");
  });

  // keys
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
    if (e.key === "Escape") { closeModals(); return; }
    if (e.key === "F1") { e.preventDefault(); openWiki(wikiCurrent || "getting-started"); return; }
    if (mod && e.key === "Enter") { e.preventDefault(); const p = preset(); if (p) { stopRotation(true); apply(p); } return; }
    if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newPreset(); return; }
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicatePreset(); return; }
    if (mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); movePreset(e.key === "ArrowUp" ? -1 : 1); return; }
    if (e.key === "Delete" && !typing && document.querySelectorAll(".modal:not([hidden])").length === 0) { deletePreset(); return; }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveStore(); toast("Presets save automatically as you type."); }
  });

  // tray → UI
  listen("tray-preset", (e) => {
    const i = Number(e.payload); const p = store.presets[i];
    if (!p) return;
    stopRotation(true);
    if (p.clientId !== currentApp()) { store.settings.currentApp = p.clientId; saveStore(); }
    select(i); renderAll(); apply(p);
  });
  listen("tray-clear", () => clearPresence(false));
  listen("tray-rotation", () => (rot.active ? stopRotation() : startRotation()));
  listen("tray-update", () => { invoke("show_window"); installUpdate(); });
}

// ---------------------------------------------------------------- boot

async function init() {
  const raw = await invoke("load_store").catch(() => null);
  const firstRun = raw == null;
  store = normalizeStore(raw);
  appStart = Number(await invoke("app_start_ms").catch(() => 0)) || Date.now();
  bootMs = Number(await invoke("boot_time").catch(() => 0)) * 1000 || 0;
  appVersion = String(await invoke("app_version").catch(() => "0.0.0"));
  $("aboutVer").textContent = `v${appVersion}`;

  $("sReconnect").checked = store.settings.autoReconnect;
  $("sRestore").checked = store.settings.restoreOnLaunch;
  $("sUpdates").checked = store.settings.autoUpdate;
  await loadGameMap();
  renderGamePanel();
  $("sIdle").checked = Number(store.settings.idlePauseMin) > 0;
  $("sIdleMin").value = Number(store.settings.idlePauseMin) > 0 ? store.settings.idlePauseMin : 15;
  $("rotInterval").value = store.settings.rotationInterval;
  invoke("autostart_enabled").then((v) => { $("sAutostart").checked = !!v; }).catch(() => {});

  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      const upd = () => { batteryPct = Math.round(b.level * 100); buildChips(); };
      upd(); b.addEventListener("levelchange", upd);
    }).catch(() => {});
  }

  wire();
  buildChips();
  setInterval(buildChips, 30000);

  // Open on the last-applied preset if it exists, else the first preset of the current app.
  let start = -1;
  if (store.last) {
    const i = store.presets.findIndex((p) => p.name === store.last.preset.name && p.clientId === store.last.preset.clientId);
    if (i >= 0) { start = i; store.settings.currentApp = store.presets[i].clientId; }
  }
  if (start < 0) { const v = visible(); start = v.length ? v[0] : -1; }
  renderAll();
  select(start);

  if (store.rotation.active && rotationList().length >= 2) {
    startRotation();
  } else if (store.settings.restoreOnLaunch && store.last) {
    current = { preset: clone(store.last.preset), appliedAt: store.last.appliedAt || Date.now(), lastSent: 0, rendered: "", pending: true };
    apply(current.preset, { silent: true, keepAppliedAt: true });
  }

  store.apps.forEach((a) => fetchAppInfo(a.id));

  if (firstRun) {
    // First launch: start with Windows by default (Settings turns it off) and show the README.
    invoke("set_autostart", { enabled: true })
      .then(() => { $("sAutostart").checked = true; toast("Statusmith will start with Windows — change it in Settings.", "ok"); })
      .catch(() => {});
    openWiki("getting-started", { after: () => { if (!store.apps.length) openApps(); } });
  } else if (!store.apps.length) {
    openApps();
  }

  renderAll();
  saveStore(); // persist the migrated shape
  setInterval(tick, 1000);
  if (store.settings.autoUpdate) setTimeout(() => checkForUpdates(false), 15000);
}

init().catch((e) => { console.error(e); toast("Startup failed: " + e, "err"); });
