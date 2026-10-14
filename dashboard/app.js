/* Sleep Position Trainer – dashboard
 * Data source: Firebase Realtime Database REST streaming (Server-Sent Events) – no SDK, no API key.
 *   /devices/<id>/live      latest reading          (firmware PUT every 5 s)
 *   /devices/<id>/history   chart points            (firmware POST every 30 s)
 *   /devices/<id>/events    nudge / turned / escalate / spo2_dip  (firmware POST)
 *   /devices/<id>/nights    one summary per night   (firmware PUT each morning)
 * Without a database URL the page runs a built-in simulator (demo mode).
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- config
  const qs = new URLSearchParams(location.search);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
  };
  const CFG = window.SPT_CONFIG || {};
  let dbURL = (qs.get("db") || store.get("spt.db") || CFG.databaseURL || "").trim().replace(/\/+$/, "");
  let deviceId = (qs.get("device") || store.get("spt.dev") || CFG.deviceId || "spt01").trim();
  const forceDemo = qs.get("demo") === "1" || store.get("spt.demo") === "1";
  const OFFLINE_SEC = CFG.offlineAfterSec || 30;

  const POSTURES = {
    SUPINE:  { label: "On back (supine)", color: "#d95926", rot: 0,   hint: "Airway most likely to narrow – nudge zone" },
    LEFT:    { label: "Left side",        color: "#3987e5", rot: -90, hint: "Good position" },
    RIGHT:   { label: "Right side",       color: "#199e70", rot: 90,  hint: "Good position" },
    PRONE:   { label: "On stomach",       color: "#9085e9", rot: 180, hint: "Not supine – no alert" },
    UPRIGHT: { label: "Sitting / upright", color: "#c98500", rot: 0,  hint: "Awake or sitting up" }
  };
  const MODES = ["Waiting for dark", "Fall-asleep delay", "Monitoring"];
  const EV = {
    nudge:    { ic: "〰", text: "Vibration nudge started" },
    turned:   { ic: "✓", text: "Turned off back" },
    escalate: { ic: "!", text: "Ignored – buzzer escalation" },
    spo2_dip: { ic: "♥", text: "SpO₂ dropped below 90 %" }
  };

  // ---------------------------------------------------------------- state
  const S = { live: null, history: {}, events: {}, nights: {}, liveSeries: [], lastRx: 0, source: "none", postureSince: null, lastPosture: null };
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- helpers
  const parseT = (t) => {
    if (!t || /^\d+$/.test(String(t))) return null;   // firmware sends millis if NTP not synced
    const d = new Date(t); return isNaN(d) ? null : d;
  };
  const hhmm = (d) => d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--";
  const hhmmss = (d) => d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const num = (v, d = 0) => (v == null || isNaN(v) || Number(v) <= 0) ? "—" : Number(v).toFixed(d);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const postureKey = (p) => ({ LEFT_SIDE: "LEFT", RIGHT_SIDE: "RIGHT" }[p] || p || "UPRIGHT");

  function applyAt(root, path, data) {
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) return data == null ? {} : data;
    root = root && typeof root === "object" ? root : {};
    let o = root;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== "object" || o[parts[i]] == null) o[parts[i]] = {}; o = o[parts[i]]; }
    const k = parts[parts.length - 1];
    if (data == null) delete o[k]; else o[k] = data;
    return root;
  }

  // ---------------------------------------------------------------- connection pill
  function setConn(kind, text) {
    const el = $("conn"); el.className = "pill pill-" + kind; el.lastElementChild.textContent = text;
  }
  function refreshConn() {
    if (S.source === "demo") { setConn("demo", "Demo data"); return; }
    if (S.source !== "firebase") return;
    if (!S.live) { setConn("wait", "Connected · waiting for device"); return; }
    const t = parseT(S.live.t); const age = Date.now() - (t ? t.getTime() : S.lastRx);
    if (age > OFFLINE_SEC * 1000) setConn("off", "Device offline · " + ago(age));
    else setConn("live", "Live · " + deviceId);
    $("lastSeen").textContent = "updated " + ago(Math.max(0, Date.now() - S.lastRx));
  }

  // ---------------------------------------------------------------- render: live
  function renderLive() {
    const L = S.live; if (!L) return;
    const pk = postureKey(L.posture); const P = POSTURES[pk] || POSTURES.UPRIGHT;
    if (pk !== S.lastPosture) { S.lastPosture = pk; S.postureSince = Date.now(); }
    const card = document.querySelector(".posture-card");
    card.classList.toggle("supine", pk === "SUPINE"); card.classList.toggle("upright", pk === "UPRIGHT");
    $("torso").style.transform = `rotate(${P.rot}deg)`;
    $("postureName").textContent = P.label;
    $("postureHint").textContent = L.nudging ? (L.buzzing ? "Ignored nudge – buzzer sounding" : "Vibrating – waiting for user to turn") : P.hint;
    $("postureSince").textContent = S.postureSince ? "for " + ago(Date.now() - S.postureSince).replace(" ago", "") : "";
    for (const a of ["ax", "ay", "az"]) {
      const v = Math.max(-1.2, Math.min(1.2, Number(L[a]) || 0)); const w = Math.abs(v) / 1.2 * 50;
      const b = $(a + "B"); b.style.width = w + "%"; b.style.left = (v < 0 ? 50 - w : 50) + "%";
      b.style.background = a === "az" && v > 0.8 ? "var(--s2)" : "var(--s1)";
      $(a + "V").textContent = (Number(L[a]) || 0).toFixed(2);
    }
    // modes
    const m = Number(L.mode) || 0;
    document.querySelectorAll("#modes li").forEach((li) => { const k = +li.dataset.m; li.className = k < m ? "done" : k === m ? "on" : ""; });
    $("actMotor").classList.toggle("on", !!L.nudging);
    $("actBuzzer").classList.toggle("on", !!L.buzzing);
    const led = $("actLed"); led.classList.add("led"); led.classList.toggle("on", m === 2 || !!L.nudging);
    $("nNudges").textContent = L.nudges ?? 0;
    $("nSuccess").textContent = L.nudges ? Math.round(100 * (L.success || 0) / L.nudges) + "%" : "—";
    $("nSupine").textContent = L.supineMin ?? 0;
    // tiles
    $("vHR").textContent = num(L.hr); $("vSpO2").textContent = num(L.spo2);
    $("vSnore").textContent = L.snores30s ?? "—";
    $("vLight").textContent = L.light == null ? "—" : (L.light < 2000 ? "Dark" : "Lights on");
    $("vTemp").textContent = L.temp ? Number(L.temp).toFixed(1) : "—"; $("vHum").textContent = num(L.hum);
    const sp = $("sSpO2"); sp.className = "t-s" + (L.spo2 > 0 && L.spo2 < 90 ? " crit" : "");
    sp.textContent = L.spo2 > 0 && L.spo2 < 90 ? "Below 90 % – alert" : L.spo2 > 0 ? "Normal (≥ 95 %)".replace("≥ 95 %", L.spo2 >= 95 ? "≥ 95 %" : "90–94 %") : "Place finger on sensor";
    const sn = $("sSnore"); const snoring = (L.snores30s || 0) >= 3;
    sn.className = "t-s" + (snoring ? " warn" : ""); sn.textContent = snoring ? "Snoring detected" : "Quiet";
    $("sHR").textContent = L.hr > 0 ? "Resting range 50–90" : "Place finger on sensor";
    refreshConn();
  }

  // ---------------------------------------------------------------- charts
  let charts = {};
  const GRID = "#1f2944", TICK = "#7f89a3";
  const crosshair = {
    id: "crosshair",
    afterDraw(c) {
      const a = c.tooltip && c.tooltip.getActiveElements(); if (!a || !a.length) return;
      const x = a[0].element.x, { top, bottom } = c.chartArea, ctx = c.ctx;
      ctx.save(); ctx.strokeStyle = "#7f89a366"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
    }
  };
  function lineChart(id, color, opts = {}) {
    const ctx = $(id);
    const grad = ctx.getContext("2d").createLinearGradient(0, 0, 0, 210);
    grad.addColorStop(0, color + "55"); grad.addColorStop(1, color + "00");
    return new Chart(ctx, {
      type: "line",
      data: { labels: [], datasets: [{ data: [], borderColor: color, backgroundColor: grad, fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: "#121a2e", pointHoverBackgroundColor: color, tension: .35, spanGaps: true }].concat(opts.extra || []) },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { backgroundColor: "#0b1020ee", borderColor: "#26304b", borderWidth: 1, padding: 10, displayColors: false, filter: (i) => i.datasetIndex === 0, callbacks: { label: (i) => `${i.formattedValue} ${opts.unit || ""}` } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: TICK, maxTicksLimit: 6, maxRotation: 0, font: { size: 11 } }, border: { color: GRID } },
          y: { min: opts.min, max: opts.max, suggestedMin: opts.smin, suggestedMax: opts.smax, grid: { color: GRID }, border: { display: false }, ticks: { color: TICK, maxTicksLimit: 5, font: { size: 11 } } }
        }
      },
      plugins: [crosshair]
    });
  }
  function initCharts() {
    if (!window.Chart) return;
    Chart.defaults.font.family = "Inter, system-ui, sans-serif";
    charts.hr = lineChart("cHR", "#3987e5", { unit: "bpm", smin: 50, smax: 100 });
    charts.spo2 = lineChart("cSpO2", "#199e70", { unit: "%", min: 80, max: 100, extra: [{ data: [], borderColor: "#e66767aa", borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, fill: false }] });
    charts.sound = lineChart("cSound", "#c98500", { unit: "ADC p-p", smin: 0, smax: 1500 });
    charts.nights = new Chart($("cNights"), {
      type: "bar",
      data: { labels: [], datasets: [{ label: "Minutes on back", data: [], backgroundColor: "#d95926", borderRadius: 4, borderSkipped: "start", maxBarThickness: 34 }] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { backgroundColor: "#0b1020ee", borderColor: "#26304b", borderWidth: 1, padding: 10, displayColors: false,
          callbacks: { title: (i) => i[0].label, label: (i) => { const n = nightsArr()[i.dataIndex][1]; return [`${n.supineMin} min on back`, `${n.nudges} nudges · ${n.success} turned`, `snore events ${n.snoreEvents ?? 0} · min SpO₂ ${n.minSpo2 ?? "—"}%`]; } } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: TICK, font: { size: 11 } }, border: { color: GRID } },
          y: { beginAtZero: true, grid: { color: GRID }, border: { display: false }, ticks: { color: TICK, maxTicksLimit: 5, font: { size: 11 } }, title: { display: true, text: "minutes on back", color: TICK, font: { size: 11 } } }
        }
      }
    });
  }

  function seriesPoints() {
    // history (every 30 s) + live points received this session, merged by time
    const pts = Object.values(S.history).concat(S.liveSeries).map((p) => ({ ...p, _d: parseT(p.t) })).filter((p) => p._d);
    pts.sort((a, b) => a._d - b._d);
    const out = []; let last = 0;
    for (const p of pts) { const ts = +p._d; if (ts - last >= 4000) { out.push(p); last = ts; } }
    return out.slice(-240);
  }
  function renderCharts() {
    const pts = seriesPoints();
    if (charts.hr) {
      const labels = pts.map((p) => hhmm(p._d));
      const set = (c, key) => { c.data.labels = labels; c.data.datasets[0].data = pts.map((p) => (p[key] > 0 ? p[key] : null)); c.update("none"); };
      set(charts.hr, "hr"); set(charts.spo2, "spo2");
      charts.spo2.data.datasets[1].data = pts.map(() => 90); charts.spo2.update("none");
      charts.sound.data.labels = labels; charts.sound.data.datasets[0].data = pts.map((p) => p.sound ?? null); charts.sound.update("none");
    }
    renderTimeline(pts);
  }

  // posture timeline: contiguous segments
  const tip = document.createElement("div"); tip.className = "tip"; document.body.appendChild(tip);
  function renderTimeline(pts) {
    const tl = $("timeline"); tl.innerHTML = "";
    if (pts.length < 2) { tl.innerHTML = '<span style="flex:1;background:transparent"></span>'; $("tlLegend").innerHTML = '<span class="muted">Collecting data…</span>'; return; }
    const segs = []; for (const p of pts) { const k = postureKey(p.posture); const s = segs[segs.length - 1]; if (s && s.k === k) s.end = p._d; else segs.push({ k, start: p._d, end: p._d }); }
    for (let i = 0; i < segs.length - 1; i++) segs[i].end = segs[i + 1].start;
    const t0 = +segs[0].start, t1 = +segs[segs.length - 1].end || t0 + 1, span = Math.max(1, t1 - t0);
    const totals = {};
    for (const s of segs) {
      const dur = +s.end - +s.start; totals[s.k] = (totals[s.k] || 0) + dur;
      if (dur <= 0) continue;
      const el = document.createElement("span"); el.style.flex = String(dur / span); el.style.background = (POSTURES[s.k] || POSTURES.UPRIGHT).color;
      el.addEventListener("mousemove", (e) => { tip.style.display = "block"; tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY + 12 + "px"; tip.innerHTML = `<b>${POSTURES[s.k].label}</b><br>${hhmm(s.start)} – ${hhmm(s.end)} · ${Math.max(1, Math.round(dur / 60000))} min`; });
      el.addEventListener("mouseleave", () => (tip.style.display = "none"));
      tl.appendChild(el);
    }
    $("tlRange").textContent = `${hhmm(segs[0].start)} – ${hhmm(segs[segs.length - 1].end)}`;
    const order = ["LEFT", "RIGHT", "SUPINE", "PRONE", "UPRIGHT"];
    const pct = (k) => 100 * (totals[k] || 0) / span;
    $("tlLegend").innerHTML = order.filter((k) => pct(k) >= 0.5).map((k) => `<span><i style="background:${POSTURES[k].color}"></i>${POSTURES[k].label} <b>${Math.round(pct(k))}%</b></span>`).join("");
    const longest = Math.max(0, ...segs.filter((x) => x.k === "SUPINE").map((x) => +x.end - +x.start));
    const changes = segs.length - 1;
    $("tlStats").innerHTML = `<div><b>${Math.round(span / 60000)} min</b>tracked</div><div><b>${changes}</b>position changes</div><div><b>${Math.round(pct("LEFT") + pct("RIGHT"))}%</b>on a side</div><div><b>${longest ? Math.max(1, Math.round(longest / 60000)) + " min" : "—"}</b>longest on back</div>`;
  }

  // ---------------------------------------------------------------- events
  function renderEvents() {
    const list = Object.entries(S.events).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 60);
    $("evCount").textContent = list.length ? list.length + " recent" : "";
    if (!list.length) { $("events").innerHTML = '<li class="muted" style="display:block">No events yet – nudges and turns appear here.</li>'; return; }
    $("events").innerHTML = list.map(([, e]) => {
      const m = EV[e.type] || { ic: "•", text: e.type };
      const d = parseT(e.t);
      const detail = e.type === "nudge" ? "" : e.type === "turned" ? "→ " + String(e.detail || "").replace("LEFT_SIDE", "left side").replace("RIGHT_SIDE", "right side").replace("LEFT", "left side").replace("RIGHT", "right side").replace("PRONE", "stomach") : e.detail || "";
      return `<li class="ev-${esc(e.type)}"><time>${d ? hhmmss(d) : "—"}</time><span class="ic">${m.ic}</span><span>${esc(m.text)} <span class="d">${esc(detail)}</span></span></li>`;
    }).join("");
  }

  // ---------------------------------------------------------------- nights
  const nightsArr = () => Object.entries(S.nights).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-14);
  function renderNights() {
    const arr = nightsArr();
    if (charts.nights) {
      charts.nights.data.labels = arr.map(([k]) => { const d = new Date(k + "T00:00:00"); return isNaN(d) ? k : d.toLocaleDateString([], { day: "numeric", month: "short" }); });
      charts.nights.data.datasets[0].data = arr.map(([, n]) => n.supineMin || 0);
      charts.nights.update("none");
    }
    $("nightsTable").innerHTML = arr.length ? `<table><thead><tr><th>Night</th><th>Min on back</th><th>Nudges</th><th>Turned</th><th>Buzzer</th><th>Snore ev.</th><th>Min SpO₂</th><th>Temp</th><th>Hum</th></tr></thead><tbody>${
      arr.slice().reverse().map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n.supineMin ?? 0}</td><td>${n.nudges ?? 0}</td><td>${n.success ?? 0}</td><td>${n.escalations ?? 0}</td><td>${n.snoreEvents ?? 0}</td><td>${n.minSpo2 && n.minSpo2 < 100 ? n.minSpo2 + "%" : "—"}</td><td>${n.temp ? Number(n.temp).toFixed(1) + "°" : "—"}</td><td>${n.hum ? n.hum + "%" : "—"}</td></tr>`).join("")
    }</tbody></table>` : '<p class="muted">No nightly summaries yet. The device uploads one each morning when the lights stay on for 10 minutes.</p>';
  }
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
    $("nightsChart").hidden = b.dataset.v !== "chart"; $("nightsTable").hidden = b.dataset.v !== "table";
  }));

  // ---------------------------------------------------------------- firebase source
  const streams = [];
  function stream(path, query, onData) {
    const url = `${dbURL}/devices/${encodeURIComponent(deviceId)}/${path}.json${query ? "?" + query : ""}`;
    let mirror = null;
    const es = new EventSource(url);
    const handle = (kind) => (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg) return;
      if (kind === "put") mirror = applyAt(mirror, msg.path, msg.data);
      else for (const k in msg.data || {}) mirror = applyAt(mirror, (msg.path === "/" ? "" : msg.path) + "/" + k, msg.data[k]);
      S.lastRx = Date.now(); onData(mirror);
    };
    es.addEventListener("put", handle("put"));
    es.addEventListener("patch", handle("patch"));
    es.addEventListener("cancel", () => setConn("off", "Permission denied – check database rules"));
    es.onerror = () => { if (es.readyState === 2) setConn("off", "Cannot reach database"); };
    streams.push(es);
  }
  function startFirebase() {
    S.source = "firebase"; setConn("wait", "Connecting…");
    $("srcInfo").textContent = "· source: " + dbURL.replace(/^https?:\/\//, "") + " / " + deviceId;
    stream("live", "", (d) => {
      S.live = d && typeof d === "object" ? d : null;
      if (S.live && S.live.t) { S.liveSeries.push({ ...S.live }); if (S.liveSeries.length > 400) S.liveSeries.shift(); }
      renderLive(); renderCharts();
    });
    stream("history", 'orderBy="$key"&limitToLast=240', (d) => { S.history = d || {}; renderCharts(); });
    stream("events", 'orderBy="$key"&limitToLast=60', (d) => { S.events = d || {}; renderEvents(); });
    stream("nights", "", (d) => { S.nights = d || {}; renderNights(); });
    refreshConn();
  }

  // ---------------------------------------------------------------- demo source (simulator)
  function startDemo() {
    S.source = "demo"; setConn("demo", "Demo data");
    $("srcInfo").textContent = "· source: built-in simulator";
    const pad = (n) => String(n).padStart(2, "0");
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const rnd = (a, b) => a + Math.random() * (b - a);
    let pushN = 0; const pid = () => "-demo" + String(Date.now()).padStart(14, "0") + String(pushN++).padStart(4, "0");

    // seed ~2 h of history at 30 s
    const pattern = [["LEFT", 26], ["SUPINE", 4], ["RIGHT", 34], ["SUPINE", 3], ["LEFT", 20], ["PRONE", 8], ["SUPINE", 2], ["RIGHT", 23]];
    let t = Date.now() - 120 * 60000;
    for (const [p, min] of pattern) for (let i = 0; i < min * 2; i++) {
      t += 30000; S.history["h" + t] = { t: iso(new Date(t)), posture: p, hr: Math.round(rnd(58, 68)), spo2: Math.round(rnd(94, 98)), sound: Math.round(p === "SUPINE" ? rnd(600, 1300) : rnd(60, 260)), snores30s: p === "SUPINE" ? 3 : 0, temp: 26.4, hum: 58 };
    }
    // seed events matching the supine segments
    let te = Date.now() - 120 * 60000;
    for (const [p, min] of pattern) {
      if (p === "SUPINE") {
        const a = new Date(te + 60000); S.events[pid()] = { t: iso(a), type: "nudge", detail: "SUPINE" };
        if (min === 4) S.events[pid()] = { t: iso(new Date(+a + 31000)), type: "escalate", detail: "buzzer" };
        S.events[pid()] = { t: iso(new Date(+a + (min === 4 ? 38000 : 12000))), type: "turned", detail: "RIGHT in " + (min === 4 ? 38 : 12) + " s" };
      }
      te += min * 60000;
    }
    // seed 7 nights – improving trend
    const sup = [96, 81, 74, 52, 47, 33, 21];
    for (let i = 7; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86400000); const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const s = sup[7 - i], nud = Math.round(s / 6 + rnd(0, 3));
      S.nights[k] = { supineMin: s, nudges: nud, success: Math.max(0, nud - Math.round(rnd(0, 2))), escalations: Math.round(rnd(0, 3)), snoreEvents: Math.round(s * 1.4 + rnd(0, 10)), minSpo2: Math.round(rnd(89, 94)), lastHR: Math.round(rnd(58, 66)), temp: +(rnd(25, 28)).toFixed(1), hum: Math.round(rnd(50, 65)) };
    }

    // live scenario loop (seconds): mirrors the firmware state machine with demo timings
    const script = [["UPRIGHT", 4, 0], ["UPRIGHT", 8, 1], ["LEFT", 16, 2], ["SUPINE", 9, 2], ["RIGHT", 18, 2], ["SUPINE", 18, 2], ["LEFT", 16, 2]];
    let si = 0, segT = 0, tick = 0, nudges = 0, success = 0, supineSec = 0, nudging = false, nudgeAt = 0, buzzing = false, supineFor = 0;
    const live = () => {
      const [p, len, mode] = script[si];
      const now = new Date();
      if (mode === 2 && p === "SUPINE") {
        supineFor += 2; supineSec += 2;
        if (!nudging && supineFor >= 4) { nudging = true; nudgeAt = Date.now(); nudges++; S.events[pid()] = { t: iso(now), type: "nudge", detail: "SUPINE" }; }
        if (nudging && !buzzing && Date.now() - nudgeAt > 10000) { buzzing = true; S.events[pid()] = { t: iso(now), type: "escalate", detail: "buzzer" }; }
      } else {
        if (nudging) { success++; S.events[pid()] = { t: iso(now), type: "turned", detail: `${p} in ${Math.round((Date.now() - nudgeAt) / 1000)} s` }; }
        nudging = buzzing = false; supineFor = 0;
      }
      const ang = { SUPINE: [0.05, 0.08, 0.98], LEFT: [0.96, 0.05, 0.12], RIGHT: [-0.95, 0.06, 0.1], PRONE: [0.04, 0.1, -0.97], UPRIGHT: [0.05, 0.97, 0.15] }[p];
      const snore = mode === 2 && p === "SUPINE";
      S.live = {
        t: iso(now), mode, posture: p === "LEFT" ? "LEFT" : p, ax: +(ang[0] + rnd(-.04, .04)).toFixed(2), ay: +(ang[1] + rnd(-.04, .04)).toFixed(2), az: +(ang[2] + rnd(-.04, .04)).toFixed(2),
        sound: Math.round(snore ? rnd(700, 1400) : rnd(40, 240)), snores30s: snore ? Math.min(6, 2 + Math.floor(supineFor / 3)) : 0, light: mode === 0 ? 4095 : 0,
        temp: +(26.4 + rnd(-.2, .2)).toFixed(1), hum: Math.round(58 + rnd(-1, 1)), hr: Math.round(snore ? rnd(66, 74) : rnd(58, 66)), spo2: Math.round(snore ? rnd(91, 95) : rnd(95, 98)),
        supineMin: 9 + Math.floor(supineSec / 60), nudges: 3 + nudges, success: 3 + success, nudging, buzzing
      };
      if (snore && supineFor === 14) S.events[pid()] = { t: iso(now), type: "spo2_dip", detail: "89%" };
      S.lastRx = Date.now();
      if (tick++ % 2 === 0) S.liveSeries.push({ ...S.live });
      renderLive(); renderCharts(); renderEvents();
      segT += 2; if (segT >= len) { segT = 0; si = si + 1 >= script.length ? 2 : si + 1; }
    };
    renderNights(); renderEvents(); live();
    setInterval(live, 2000);
  }

  // ---------------------------------------------------------------- settings dialog
  const dlg = $("dlg");
  $("btnSettings").addEventListener("click", () => { $("inDb").value = dbURL; $("inDev").value = deviceId; dlg.showModal(); });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "save" && $("inDb").value.trim()) {
      store.set("spt.db", $("inDb").value.trim()); store.set("spt.dev", $("inDev").value.trim() || "spt01"); store.set("spt.demo", null);
    } else if (dlg.returnValue === "demo") { store.set("spt.demo", "1"); }
    else return;
    location.href = location.pathname;
  });

  // ---------------------------------------------------------------- boot
  initCharts();
  if (dbURL && !forceDemo) startFirebase(); else startDemo();
  setInterval(() => { refreshConn(); if (S.live) $("postureSince").textContent = S.postureSince ? "for " + ago(Date.now() - S.postureSince).replace(" ago", "") : ""; }, 1000);
})();
