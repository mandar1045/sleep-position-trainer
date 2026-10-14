/* Sleep Position Trainer – dashboard
 * Reads the Firebase Realtime Database in real time using REST streaming (Server-Sent Events).
 *   /devices/<id>/live      latest reading          (firmware PUT every 5 s)
 *   /devices/<id>/history   trend points            (firmware POST every 30 s)
 *   /devices/<id>/events    nudge / turned / escalate / spo2_dip
 *   /devices/<id>/nights    one summary per night
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
  const clean = (u) => (u || "").trim().replace(/\/+$/, "");
  const dbURL = clean(qs.get("db") || store.get("spt.db") || CFG.databaseURL);
  const deviceId = (qs.get("device") || store.get("spt.dev") || CFG.deviceId || "spt01").trim();
  const OFFLINE_SEC = CFG.offlineAfterSec || 30;

  const POSTURES = {
    SUPINE:  { label: "On back",          color: "#eb6834", rot: 0,   hint: "Supine – the position this device trains away from." },
    LEFT:    { label: "Left side",        color: "#2a78d6", rot: -90, hint: "Lateral position – no action needed." },
    RIGHT:   { label: "Right side",       color: "#1baf7a", rot: 90,  hint: "Lateral position – no action needed." },
    PRONE:   { label: "On stomach",       color: "#6250d6", rot: 180, hint: "Prone – not supine, no alert." },
    UPRIGHT: { label: "Upright",          color: "#eda100", rot: 0,   hint: "Sitting or standing." }
  };
  const EV = { nudge: "Vibration nudge", turned: "Turned off back", escalate: "Buzzer escalation", spo2_dip: "SpO₂ below 90 %" };

  const S = { live: null, history: {}, events: {}, nights: {}, liveSeries: [], lastRx: 0, connected: false, postureSince: null, lastPosture: null };
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- helpers
  const parseT = (t) => { if (!t || /^\d+$/.test(String(t))) return null; const d = new Date(t); return isNaN(d) ? null : d; };
  const hhmm = (d) => d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const hhmmss = (d) => d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
  const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`; };
  const pos = (v, d = 0) => (v == null || isNaN(v) || Number(v) <= 0) ? "—" : Number(v).toFixed(d);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pkey = (p) => ({ LEFT_SIDE: "LEFT", RIGHT_SIDE: "RIGHT" }[p] || (POSTURES[p] ? p : "UPRIGHT"));
  const prettyDetail = (s) => String(s || "").replace(/\b(LEFT|RIGHT)(_SIDE)?\b/g, (m, a) => a.toLowerCase() + " side").replace(/\bPRONE\b/, "stomach").replace(/\bSUPINE\b/, "back").replace(/\bbuzzer\b/, "");

  function applyAt(root, path, data) {
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) return data;
    root = root && typeof root === "object" ? root : {};
    let o = root;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== "object" || o[parts[i]] == null) o[parts[i]] = {}; o = o[parts[i]]; }
    const k = parts[parts.length - 1];
    if (data == null) delete o[k]; else o[k] = data;
    return root;
  }

  // ---------------------------------------------------------------- status
  function setConn(kind, text) { const el = $("conn"); el.className = "conn " + kind; el.lastElementChild.textContent = text; }
  function refreshConn() {
    if (!S.connected) return;
    if (!S.live) { setConn("wait", "Waiting for device"); $("lastSeen").textContent = ""; return; }
    const t = parseT(S.live.t); const age = Date.now() - (t ? t.getTime() : S.lastRx);
    if (age > OFFLINE_SEC * 1000) setConn("off", "Device offline"); else setConn("live", "Live");
    $("lastSeen").textContent = "Last reading " + (t ? hhmmss(t) : dur(Date.now() - S.lastRx) + " ago");
    if (S.postureSince) $("since").textContent = dur(Date.now() - S.postureSince);
  }

  // ---------------------------------------------------------------- live
  function renderLive() {
    const L = S.live; const col = $("positionCol");
    if (!L) { col.className = "col position empty"; return; }
    const k = pkey(L.posture), P = POSTURES[k];
    if (k !== S.lastPosture) { S.lastPosture = k; S.postureSince = Date.now(); }
    col.className = "col position" + (k === "SUPINE" ? " supine" : k === "UPRIGHT" ? " upright" : "");
    $("torso").style.transform = `rotate(${P.rot}deg)`;
    $("postureName").textContent = P.label;
    $("postureHint").textContent = L.nudging ? (L.buzzing ? "Nudge ignored – buzzer active." : "Vibration nudge active – waiting for the user to turn.") : P.hint;
    for (const a of ["ax", "ay", "az"]) $(a + "V").textContent = L[a] == null ? "—" : (+L[a]).toFixed(2);

    const m = Number(L.mode) || 0;
    document.querySelectorAll("#modes li").forEach((li) => { const i = +li.dataset.m; li.className = i < m ? "done" : i === m ? "on" : ""; });
    const act = (id, on, txt = "On") => { const el = $(id); el.className = on ? "on" : "off"; el.textContent = on ? txt : "Off"; };
    act("actMotor", !!L.nudging, "Vibrating");
    act("actBuzzer", !!L.buzzing, "Sounding");
    const led = $("actLed"); const ledOn = m === 2 || !!L.nudging; led.className = ledOn ? "ok" : "off"; led.textContent = ledOn ? (L.nudging ? "Blinking" : "On") : "Off";
    $("nNudges").textContent = L.nudges ?? 0;
    $("nSuccess").textContent = L.nudges ? Math.round(100 * (L.success || 0) / L.nudges) + " %" : "—";
    $("nSupine").textContent = L.supineMin ?? 0;

    $("vHR").textContent = pos(L.hr); $("vSpO2").textContent = pos(L.spo2);
    $("vSnore").textContent = L.snores30s ?? "—";
    $("vLight").textContent = L.light == null ? "—" : L.light < 2000 ? "Dark" : "Lit";
    $("vTemp").textContent = L.temp ? (+L.temp).toFixed(1) : "—"; $("vHum").textContent = pos(L.hum);
    const sp = $("sSpO2");
    if (L.spo2 > 0 && L.spo2 < 90) { sp.className = "s crit"; sp.textContent = "Below 90 %"; }
    else { sp.className = "s"; sp.textContent = L.spo2 > 0 ? (L.spo2 >= 95 ? "Normal range" : "Slightly low") : "No finger detected"; }
    $("sHR").textContent = L.hr > 0 ? "MAX30102" : "No finger detected";
    const sn = $("sSnore"), snoring = (L.snores30s || 0) >= 3;
    sn.className = "s" + (snoring ? " warn" : ""); sn.textContent = snoring ? "Snoring detected" : "KY-038";
    refreshConn();
  }

  // ---------------------------------------------------------------- charts
  const charts = {};
  const GRID = "#eef0f2", TICK = "#868b96", LINE = "#2a5bd7";
  const crosshair = { id: "x", afterDraw(c) { const a = c.tooltip?.getActiveElements(); if (!a?.length) return; const x = a[0].element.x, ctx = c.ctx; ctx.save(); ctx.strokeStyle = "#c4c7cd"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, c.chartArea.top); ctx.lineTo(x, c.chartArea.bottom); ctx.stroke(); ctx.restore(); } };
  const tooltip = { backgroundColor: "#16181d", titleColor: "#fff", bodyColor: "#e6e7ea", padding: 9, cornerRadius: 4, displayColors: false, titleFont: { weight: "500" } };
  function line(id, unit, y, extra = []) {
    return new Chart($(id), {
      type: "line",
      data: { labels: [], datasets: [{ data: [], borderColor: LINE, borderWidth: 1.75, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: LINE, pointHoverBorderColor: "#fff", pointHoverBorderWidth: 2, tension: .3, spanGaps: true, fill: false }, ...extra] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { ...tooltip, filter: (i) => i.datasetIndex === 0, callbacks: { label: (i) => `${i.formattedValue} ${unit}` } } },
        scales: {
          x: { grid: { display: false }, border: { color: "#d3d5da" }, ticks: { color: TICK, maxTicksLimit: 5, maxRotation: 0, font: { size: 11 } } },
          y: { ...y, grid: { color: GRID }, border: { display: false }, ticks: { color: TICK, maxTicksLimit: 5, font: { size: 11 } } }
        }
      },
      plugins: [crosshair]
    });
  }
  function initCharts() {
    if (!window.Chart) return;
    Chart.defaults.font.family = '"IBM Plex Sans", system-ui, sans-serif';
    charts.hr = line("cHR", "bpm", { suggestedMin: 50, suggestedMax: 100 });
    charts.spo2 = line("cSpO2", "%", { min: 80, max: 100 }, [{ data: [], borderColor: "#b91c1c", borderDash: [4, 4], borderWidth: 1, pointRadius: 0, fill: false }]);
    charts.sound = line("cSound", "", { suggestedMin: 0, suggestedMax: 1500 });
    charts.nights = new Chart($("cNights"), {
      type: "bar",
      data: { labels: [], datasets: [{ data: [], backgroundColor: "#eb6834", hoverBackgroundColor: "#c2410c", borderRadius: { topLeft: 3, topRight: 3 }, borderSkipped: "start", maxBarThickness: 28 }] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { label: (i) => { const n = nightsArr()[i.dataIndex][1]; return [`${n.supineMin ?? 0} min on back`, `${n.nudges ?? 0} nudges, ${n.success ?? 0} turned`]; } } } },
        scales: {
          x: { grid: { display: false }, border: { color: "#d3d5da" }, ticks: { color: TICK, font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: GRID }, border: { display: false }, ticks: { color: TICK, maxTicksLimit: 5, font: { size: 11 } }, title: { display: true, text: "Minutes on back", color: TICK, font: { size: 11 } } }
        }
      }
    });
  }

  function points() {
    const all = Object.values(S.history).concat(S.liveSeries).map((p) => ({ ...p, _d: parseT(p.t) })).filter((p) => p._d).sort((a, b) => a._d - b._d);
    const out = []; let last = 0;
    for (const p of all) if (+p._d - last >= 4000) { out.push(p); last = +p._d; }
    return out.slice(-240);
  }
  function renderCharts() {
    const pts = points(), has = pts.length >= 2;
    $("trendEmpty").hidden = has;
    document.querySelector(".trends").hidden = !has; document.querySelector(".timeline-fig").hidden = !has;
    if (!has) { $("tlRange").textContent = ""; return; }
    if (charts.hr) {
      const labels = pts.map((p) => hhmm(p._d));
      const put = (c, k) => { c.data.labels = labels; c.data.datasets[0].data = pts.map((p) => (p[k] > 0 ? p[k] : null)); };
      put(charts.hr, "hr"); put(charts.spo2, "spo2");
      charts.spo2.data.datasets[1].data = pts.map(() => 90);
      charts.sound.data.labels = labels; charts.sound.data.datasets[0].data = pts.map((p) => p.sound ?? null);
      charts.hr.update("none"); charts.spo2.update("none"); charts.sound.update("none");
    }
    renderTimeline(pts);
  }

  const tip = document.createElement("div"); tip.className = "tip"; document.body.appendChild(tip);
  function renderTimeline(pts) {
    const segs = [];
    for (const p of pts) { const k = pkey(p.posture), s = segs[segs.length - 1]; if (s && s.k === k) s.end = p._d; else segs.push({ k, start: p._d, end: p._d }); }
    for (let i = 0; i < segs.length - 1; i++) segs[i].end = segs[i + 1].start;
    const t0 = +segs[0].start, span = Math.max(1, +segs[segs.length - 1].end - t0), tot = {};
    const tl = $("timeline"); tl.innerHTML = "";
    for (const s of segs) {
      const d = +s.end - +s.start; tot[s.k] = (tot[s.k] || 0) + d; if (d <= 0) continue;
      const el = document.createElement("span"); el.style.flex = String(d / span); el.style.background = POSTURES[s.k].color;
      el.onmousemove = (e) => { tip.style.display = "block"; tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY + 14 + "px"; tip.textContent = `${POSTURES[s.k].label} · ${hhmm(s.start)}–${hhmm(s.end)} · ${dur(d)}`; };
      el.onmouseleave = () => (tip.style.display = "none");
      tl.appendChild(el);
    }
    const pct = (k) => 100 * (tot[k] || 0) / span;
    $("tlRange").textContent = `${hhmm(segs[0].start)} – ${hhmm(segs[segs.length - 1].end)}`;
    $("tlLegend").innerHTML = ["LEFT", "RIGHT", "SUPINE", "PRONE", "UPRIGHT"].filter((k) => pct(k) >= 0.5)
      .map((k) => `<span><i style="background:${POSTURES[k].color}"></i>${POSTURES[k].label}<b>${Math.round(pct(k))} %</b></span>`).join("");
    const longest = Math.max(0, ...segs.filter((x) => x.k === "SUPINE").map((x) => +x.end - +x.start));
    $("tlStats").innerHTML = `<span><b>${dur(span)}</b>recorded</span><span><b>${segs.length - 1}</b>position changes</span><span><b>${longest ? dur(longest) : "—"}</b>longest on back</span>`;
  }

  // ---------------------------------------------------------------- events
  function renderEvents() {
    const list = Object.entries(S.events).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 80);
    $("evEmpty").hidden = list.length > 0; $("events").hidden = !list.length;
    $("evCount").textContent = list.length ? `${list.length} most recent` : "";
    $("events").tBodies[0].innerHTML = list.map(([, e]) =>
      `<tr><td>${hhmmss(parseT(e.t))}</td><td><span class="tag ${esc(e.type)}">${esc(EV[e.type] || e.type)}</span></td><td>${esc(e.type === "nudge" ? "" : prettyDetail(e.detail))}</td></tr>`).join("");
  }

  // ---------------------------------------------------------------- nights
  const nightsArr = () => Object.entries(S.nights).filter(([, n]) => n && typeof n === "object").sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-14);
  function renderNights() {
    const arr = nightsArr(), has = arr.length > 0;
    $("nEmpty").hidden = has;
    const view = document.querySelector(".tabs .on").dataset.v;
    $("nightsChart").hidden = !has || view !== "chart"; $("nightsTable").hidden = !has || view !== "table";
    if (!has) return;
    if (charts.nights) {
      charts.nights.data.labels = arr.map(([k]) => { const d = new Date(k + "T00:00:00"); return isNaN(d) ? k : d.toLocaleDateString([], { day: "numeric", month: "short" }); });
      charts.nights.data.datasets[0].data = arr.map(([, n]) => n.supineMin || 0);
      charts.nights.update("none");
    }
    $("nightsTable").innerHTML = `<table><thead><tr><th>Night</th><th class="r">On back</th><th class="r">Nudges</th><th class="r">Turned</th><th class="r">Buzzer</th><th class="r">Snores</th><th class="r">Min SpO₂</th><th class="r">Temp</th></tr></thead><tbody>${
      arr.slice().reverse().map(([k, n]) => `<tr><td>${esc(k)}</td><td class="r">${n.supineMin ?? 0} min</td><td class="r">${n.nudges ?? 0}</td><td class="r">${n.success ?? 0}</td><td class="r">${n.escalations ?? 0}</td><td class="r">${n.snoreEvents ?? 0}</td><td class="r">${n.minSpo2 && n.minSpo2 < 100 ? n.minSpo2 + " %" : "—"}</td><td class="r">${n.temp ? (+n.temp).toFixed(1) + " °C" : "—"}</td></tr>`).join("")}</tbody></table>`;
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b)); renderNights();
  }));

  // ---------------------------------------------------------------- firebase streaming
  function stream(path, query, onData) {
    const url = `${dbURL}/devices/${encodeURIComponent(deviceId)}/${path}.json${query ? "?" + query : ""}`;
    let mirror = null;
    const es = new EventSource(url);
    const handle = (kind) => (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg) return;
      if (kind === "put") mirror = applyAt(mirror, msg.path, msg.data);
      else for (const k in msg.data || {}) mirror = applyAt(mirror, (msg.path === "/" ? "" : msg.path) + "/" + k, msg.data[k]);
      S.connected = true; S.lastRx = Date.now(); $("notice").hidden = true; onData(mirror);
    };
    es.addEventListener("put", handle("put"));
    es.addEventListener("patch", handle("patch"));
    es.addEventListener("cancel", () => notice("Read permission denied. Publish the rules in backend/database.rules.json in the Firebase console."));
    es.onerror = () => { if (!S.connected) { setConn("off", "Not connected"); notice(`Cannot reach ${dbURL}. Check the database URL in Settings.`); } };
  }
  function notice(msg) { const n = $("notice"); n.textContent = msg; n.hidden = false; }

  function start() {
    $("app").hidden = false; $("devName").textContent = deviceId;
    $("srcInfo").textContent = dbURL.replace(/^https?:\/\//, "") + " / devices / " + deviceId;
    setConn("wait", "Connecting");
    initCharts(); renderLive(); renderCharts(); renderEvents(); renderNights();
    stream("live", "", (d) => {
      S.live = d && typeof d === "object" ? d : null;
      if (S.live?.t && S.liveSeries.at(-1)?.t !== S.live.t) { S.liveSeries.push({ ...S.live }); if (S.liveSeries.length > 400) S.liveSeries.shift(); }
      renderLive(); renderCharts();
    });
    stream("history", 'orderBy="$key"&limitToLast=240', (d) => { S.history = d || {}; renderCharts(); });
    stream("events", 'orderBy="$key"&limitToLast=80', (d) => { S.events = d || {}; renderEvents(); });
    stream("nights", "", (d) => { S.nights = d || {}; renderNights(); });
    setInterval(refreshConn, 1000);
  }

  // ---------------------------------------------------------------- setup + settings
  $("setupForm").addEventListener("submit", (e) => {
    e.preventDefault();
    store.set("spt.db", clean($("sDb").value)); store.set("spt.dev", $("sDev").value.trim() || "spt01");
    location.href = location.pathname;
  });
  const dlg = $("dlg");
  $("btnSettings").addEventListener("click", () => { $("inDb").value = dbURL; $("inDev").value = deviceId; dlg.showModal(); });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "save" && $("inDb").value.trim()) { store.set("spt.db", clean($("inDb").value)); store.set("spt.dev", $("inDev").value.trim() || "spt01"); }
    else if (dlg.returnValue === "forget") { store.set("spt.db", null); store.set("spt.dev", null); }
    else return;
    location.href = location.pathname;
  });

  if (dbURL) start();
  else { $("setup").hidden = false; $("btnSettings").hidden = true; setConn("off", "No database configured"); $("sDev").value = deviceId; }
})();
