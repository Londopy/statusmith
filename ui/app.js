// Statusmith — front end. The Rust side is a thin bridge to Discord's local IPC
// pipe; everything about apps, presets, templates, rotation and reconnecting lives here.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

const RATE_LIMIT_MS = 15000;          // Discord applies at most one presence update per ~15 s
const STATUS_POLL_MS = 10000;
const DEV_PORTAL = "https://discord.com/developers/applications";
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

const DEFAULT_SETTINGS = { currentApp: "", autoReconnect: true, restoreOnLaunch: true, rotationInterval: 60 };

function blankPreset(name = "New preset", clientId = "") {
  return {
    name, clientId, type: 0, details: "", state: "",
    largeImage: "", largeText: "", smallImage: "", smallText: "",
    timeMode: "none", duration: 30, loop: false,
    partyCur: 0, partyMax: 0,
    buttons: [{ label: "", url: "" }, { label: "", url: "" }],
    rotate: false,
  };
}

function starterPresets() {
  return [
    { ...blankPreset("Vibing"), details: "vibing {random:✨|🌙|🎧|🍃|🫧}", state: "since {time}", timeMode: "apply", rotate: true },
    { ...blankPreset("Live clock"), details: "it is {time} for me", state: "{day} · {date}", rotate: true },
    { ...blankPreset("Touching grass"), details: "touching grass 🌱", state: "brb", timeMode: "countdown", duration: 30 },
    { ...blankPreset("Laptop stats"), details: "battery at {battery}", state: "up for {uptime}", timeMode: "app" },
    { ...blankPreset("Lofi"), type: 2, details: "lofi hip hop radio", state: "beats to relax/study to", timeMode: "countdown", duration: 3.5, loop: true },
    { ...blankPreset("Locked in"), type: 5, details: "vs. the syllabus", state: "in a study group", partyCur: 1, partyMax: 4, timeMode: "apply" },
  ];
}

function normalizeStore(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  const presets = (Array.isArray(s.presets) && s.presets.length ? s.presets : starterPresets()).map((p) => ({
    ...blankPreset(), ...p,
    clientId: String(p.clientId || "").trim(),
    buttons: [0, 1].map((i) => ({ label: "", url: "", ...((p.buttons || [])[i] || {}) })),
  }));
  const apps = (Array.isArray(s.apps) ? s.apps : [])
    .filter((a) => a && ID_RE.test(String(a.id || "")))
    .map((a) => ({ id: String(a.id), name: String(a.name || ""), auto: a.auto !== false }));
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
let previewStart = Date.now();
let batteryPct = null;
let appInfo = {};            // clientId -> { name, icon, fetched }
let assets = {};             // clientId -> [{ id, name }]
let rot = { active: false, idx: -1, nextAt: 0 };
let lastPoll = 0;
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
  battery: { hint: "87%",      fn: () => (batteryPct == null ? "?%" : batteryPct + "%") },
  "random:a|b|c": { hint: "one of", fn: null },
};

function render(str) {
  return String(str || "").replace(/\{(\w+)(?::([^}]*))?\}/g, (m, name, arg) => {
    if (name === "random" && arg != null) {
      const opts = arg.split("|").filter(Boolean);
      return opts.length ? opts[Math.floor(Math.random() * opts.length)] : "";
    }
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
  const appliedAt = opts.keepAppliedAt && current ? current.appliedAt : Date.now();
  const { activity, warnings } = buildActivity(p, appliedAt);
  try {
    const res = await invoke("set_activity", { clientId: cid, activity });
    current = { preset: clone(p), appliedAt, lastSent: Date.now(), rendered: JSON.stringify(activity) };
    if (res && res.name) noteAppName(cid, res.name);
    lastError = "";
    store.last = { preset: current.preset, appliedAt };
    saveStore();
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

function startRotation() {
  if (rotationList().length < 2) { toast("Tick ↻ on at least two presets first.", "warn"); return; }
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
  const list = rotationList();
  if (list.length < 2) return stopRotation();
  rot.idx = (rot.idx + 1) % list.length;
  rot.nextAt = Date.now() + Math.max(15, Number(store.settings.rotationInterval) || 60) * 1000;
  await apply(list[rot.idx], { silent: true });
  renderRotation();
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

  if (rot.active && now >= rot.nextAt) { await advanceRotation(); return; }

  if (current) {
    const p = current.preset;
    if (p.timeMode === "countdown" && p.loop) {
      const end = current.appliedAt + Math.max(RATE_LIMIT_MS, (Number(p.duration) || 0) * 60000);
      if (now >= end) { await apply(p, { silent: true }); return; }
    }
    if (conn.connected && !current.pending && hasTemplates(p) && now - current.lastSent >= RATE_LIMIT_MS) {
      await resend();
    }
  }

  if (now - lastPoll >= STATUS_POLL_MS) {
    lastPoll = now;
    await refreshStatus();
    if (current && !current.fatal && !conn.connected && store.settings.autoReconnect) {
      await apply(current.preset, { silent: true, keepAppliedAt: true });
    }
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
  const opts = store.apps.map((a) => `<option value="${esc(a.id)}">${esc(appName(a.id))}</option>`);
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
    li.className = i === sel ? "on" : "";
    const live = current && current.preset.name === p.name && current.preset.clientId === p.clientId && !current.pending;
    li.innerHTML = `<span class="ty">${TYPE_GLYPH[p.type] || "🎮"}</span><span class="nm"></span>${live ? '<span class="live" title="currently applied"></span>' : ""}<button class="rot ${p.rotate ? "on" : ""}" title="include in rotation">↻</button>`;
    li.querySelector(".nm").textContent = p.name || "untitled";
    li.addEventListener("click", () => select(i));
    li.addEventListener("dblclick", () => { stopRotation(true); apply(p); });
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

function assetUrl(cid, key) {
  key = (key || "").trim();
  if (!key) return null;
  if (/^https?:\/\//.test(key)) return key;
  if (key.startsWith("mp:")) return null;
  const a = (assets[cid] || []).find((x) => x.name === key);
  return a ? `https://cdn.discordapp.com/app-assets/${cid}/${a.id}.png?size=160` : null;
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
    $("pvMeta").textContent = current ? `Live: ${current.preset.name || "untitled"}` : "Nothing applied yet.";
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

  const large = $("pvLarge"), largeUrl = assetUrl(cid, p.largeImage);
  large.style.backgroundImage = largeUrl ? `url("${largeUrl}")` : "";
  large.classList.toggle("empty", !p.largeImage.trim());
  $("pvLargeKey").textContent = !largeUrl && p.largeImage.trim() ? p.largeImage.trim() : "";
  large.title = render(p.largeText);

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
  $("pvMeta").textContent = current
    ? `Live: ${current.preset.name || "untitled"} · applied ${new Date(current.appliedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${current.pending ? " (waiting for Discord)" : ""}`
    : "Nothing applied yet — hit Apply.";
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
  $("btnRotate").textContent = rot.active ? "■ Stop" : "▶ Start";
  const scope = store.apps.length > 1 ? " · all apps" : "";
  $("rotInfo").textContent = rot.active
    ? `${n} presets · next in ${Math.max(0, Math.ceil((rot.nextAt - Date.now()) / 1000))}s`
    : n ? `${n} selected${scope}` : "off";
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
    tooltip = `Statusmith — ${TYPE_LABEL[current.preset.type] || "Playing"} ${appName(current.preset.clientId)}${d ? ": " + d : ""}`;
  }
  const key = JSON.stringify([status, groups, rot.active, tooltip]);
  if (key === trayKey) return;
  trayKey = key;
  invoke("set_tray", { status, groups, rotating: rot.active, tooltip: tooltip.slice(0, 120) }).catch(() => {});
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
    row.innerHTML = `<input class="app-name" placeholder="name" spellcheck="false"><code></code><span class="count"></span><button class="ghost small danger">Remove</button>`;
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
  renderList();
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
  select(store.presets.length - 1);
  $("pName").focus(); $("pName").select();
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
function closeModals() { document.querySelectorAll(".modal").forEach((m) => { m.hidden = true; }); }

// ---------------------------------------------------------------- wiring

function wire() {
  // top bar
  $("appSelect").addEventListener("change", () => {
    const v = $("appSelect").value;
    if (v === "__manage") { $("appSelect").value = currentApp(); openApps(); return; }
    switchApp(v);
  });
  $("btnApps").addEventListener("click", () => openApps());
  $("btnAppHelp").addEventListener("click", openHelp);
  $("btnHelpClose").addEventListener("click", closeModals);
  $("btnAppsClose").addEventListener("click", closeModals);
  document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; }));
  for (const id of ["linkDevPortal", "linkDevPortal2"]) $(id).addEventListener("click", (e) => { e.preventDefault(); invoke("open_url", { url: DEV_PORTAL }); });
  $("btnAddApp").addEventListener("click", addApp);
  $("newAppId").addEventListener("keydown", (e) => { if (e.key === "Enter") addApp(); });
  $("newAppName").addEventListener("keydown", (e) => { if (e.key === "Enter") addApp(); });
  $("btnApply").addEventListener("click", () => { const p = preset(); if (p) { stopRotation(true); apply(p); } });
  $("btnClear").addEventListener("click", () => clearPresence(false));

  // sidebar
  $("btnNew").addEventListener("click", newPreset);
  $("btnNewEmpty").addEventListener("click", () => (store.apps.length ? newPreset() : openApps()));
  $("btnDup").addEventListener("click", () => {
    const p = preset(); if (!p) return;
    const c = clone(p); c.name = uniqueName(`${c.name} copy`); c.rotate = false;
    store.presets.splice(sel + 1, 0, c); saveStore(); select(sel + 1);
  });
  $("btnDelete").addEventListener("click", () => {
    const p = preset(); if (!p) return;
    const v = visible(), pos = v.indexOf(sel);
    store.presets.splice(sel, 1); saveStore();
    const v2 = visible();
    select(v2.length ? v2[Math.min(pos, v2.length - 1)] : -1);
    toast(`Deleted “${p.name}”.`);
    syncTray();
  });
  $("rotInterval").addEventListener("change", () => {
    store.settings.rotationInterval = Math.max(15, Number($("rotInterval").value) || 60);
    $("rotInterval").value = store.settings.rotationInterval; saveStore();
  });
  $("btnRotate").addEventListener("click", () => (rot.active ? stopRotation() : startRotation()));

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
  $("pvAvatar").addEventListener("error", () => $("pvAvatar").removeAttribute("src"));
  $("connAvatar").addEventListener("error", () => { $("connAvatar").hidden = true; });
  $("btnHide").addEventListener("click", () => invoke("hide_window"));
  $("btnData").addEventListener("click", () => invoke("open_data_dir"));

  // keys
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModals();
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); const p = preset(); if (p) { stopRotation(true); apply(p); } }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveStore(); toast("Presets save automatically as you type."); }
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
}

// ---------------------------------------------------------------- boot

async function init() {
  store = normalizeStore(await invoke("load_store").catch(() => null));
  appStart = Number(await invoke("app_start_ms").catch(() => 0)) || Date.now();

  $("sReconnect").checked = store.settings.autoReconnect;
  $("sRestore").checked = store.settings.restoreOnLaunch;
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
  select(start);

  if (store.rotation.active && rotationList().length >= 2) {
    startRotation();
  } else if (store.settings.restoreOnLaunch && store.last) {
    current = { preset: clone(store.last.preset), appliedAt: store.last.appliedAt || Date.now(), lastSent: 0, rendered: "", pending: true };
    apply(current.preset, { silent: true, keepAppliedAt: true });
  }

  store.apps.forEach((a) => fetchAppInfo(a.id));
  if (!store.apps.length) openApps();
  renderAll();
  saveStore(); // persist the migrated shape
  setInterval(tick, 1000);
}

init().catch((e) => { console.error(e); toast("Startup failed: " + e, "err"); });
