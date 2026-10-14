#!/usr/bin/env node
/*
 * Sleep Position Trainer – device simulator
 * Writes exactly the same JSON as the ESP32 firmware to Firebase, so the dashboard
 * can be tested end-to-end without the hardware.
 *
 *   FIREBASE_URL=https://xxx.firebaseio.com FIREBASE_AUTH=<database secret> node simulate.js          # live loop
 *   ... node simulate.js --seed     # also write 7 nights of summaries + 1 h of history
 *   ... node simulate.js --clear    # delete /devices/<id>
 *
 * Node 18+ (uses built-in fetch). No npm install needed.
 */
const URL_ = (process.env.FIREBASE_URL || "").replace(/\/+$/, "");
const AUTH = process.env.FIREBASE_AUTH || "";
const DEV = process.env.DEVICE_ID || "spt01";
const PERIOD = Number(process.env.PERIOD_MS || 5000);
if (!URL_) { console.error("Set FIREBASE_URL (and FIREBASE_AUTH). See README."); process.exit(1); }

const base = `${URL_}/devices/${DEV}`;
const q = AUTH ? `?auth=${encodeURIComponent(AUTH)}` : "";
async function send(method, path, body) {
  const r = await fetch(`${base}${path}.json${q}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}
const pad = (n) => String(n).padStart(2, "0");
// IST wall-clock string, same format as the firmware's isoTime()
const iso = (ms = Date.now()) => { const d = new Date(ms + 5.5 * 3600e3); return d.toISOString().slice(0, 19); };
const dateKey = (ms = Date.now()) => iso(ms).slice(0, 10);
const rnd = (a, b) => a + Math.random() * (b - a);
const ACC = { SUPINE: [0.05, 0.08, 0.98], LEFT: [0.96, 0.05, 0.12], RIGHT: [-0.95, 0.06, 0.1], PRONE: [0.04, 0.1, -0.97], UPRIGHT: [0.05, 0.97, 0.15] };

async function seed() {
  const sup = [96, 81, 74, 52, 47, 33, 21];
  for (let i = 7; i >= 1; i--) {
    const s = sup[7 - i], n = Math.round(s / 6 + rnd(0, 3));
    await send("PUT", `/nights/${dateKey(Date.now() - i * 86400e3)}`, { supineMin: s, nudges: n, success: Math.max(0, n - 1), escalations: Math.round(rnd(0, 3)), snoreEvents: Math.round(s * 1.4), minSpo2: Math.round(rnd(89, 94)), lastHR: Math.round(rnd(58, 66)), temp: +rnd(25, 28).toFixed(1), hum: Math.round(rnd(50, 65)) });
  }
  const pattern = [["LEFT", 18], ["SUPINE", 4], ["RIGHT", 22], ["SUPINE", 2], ["LEFT", 14]];
  let t = Date.now() - 60 * 60e3; const batch = {};
  for (const [p, min] of pattern) for (let i = 0; i < min * 2; i++) {
    t += 30e3;
    batch["-seed" + t] = { t: iso(t), posture: p, hr: Math.round(rnd(58, 68)), spo2: Math.round(rnd(94, 98)), sound: Math.round(p === "SUPINE" ? rnd(600, 1300) : rnd(60, 260)), snores30s: p === "SUPINE" ? 3 : 0, temp: 26.4, hum: 58 };
  }
  await send("PATCH", "/history", batch);
  console.log("seeded 7 nights + 1 h history");
}

async function loop() {
  const script = [["UPRIGHT", 10, 0], ["UPRIGHT", 15, 1], ["LEFT", 40, 2], ["SUPINE", 25, 2], ["RIGHT", 40, 2], ["SUPINE", 40, 2], ["LEFT", 40, 2]];
  let si = 0, segT = 0, tick = 0, nudges = 0, success = 0, esc = 0, supineMs = 0, nudging = false, buzzing = false, nudgeAt = 0, supFor = 0;
  console.log(`simulating device "${DEV}" every ${PERIOD / 1000}s – Ctrl+C to stop`);
  for (;;) {
    const [p, len, mode] = script[si];
    try {
      if (mode === 2 && p === "SUPINE") {
        supFor += PERIOD; supineMs += PERIOD;
        if (!nudging && supFor >= 3000) { nudging = true; nudgeAt = Date.now(); nudges++; await send("POST", "/events", { t: iso(), type: "nudge", detail: "SUPINE" }); }
        if (nudging && !buzzing && Date.now() - nudgeAt > 10000) { buzzing = true; esc++; await send("POST", "/events", { t: iso(), type: "escalate", detail: "buzzer" }); }
      } else {
        if (nudging) { success++; await send("POST", "/events", { t: iso(), type: "turned", detail: `${p} in ${Math.round((Date.now() - nudgeAt) / 1000)} s` }); }
        nudging = buzzing = false; supFor = 0;
      }
      const a = ACC[p], snore = mode === 2 && p === "SUPINE";
      const live = { t: iso(), mode, posture: p, ax: +(a[0] + rnd(-.04, .04)).toFixed(2), ay: +(a[1] + rnd(-.04, .04)).toFixed(2), az: +(a[2] + rnd(-.04, .04)).toFixed(2),
        sound: Math.round(snore ? rnd(700, 1400) : rnd(40, 240)), snores30s: snore ? 4 : 0, light: mode === 0 ? 4095 : 0, temp: +(26.4 + rnd(-.2, .2)).toFixed(1), hum: Math.round(58 + rnd(-1, 1)),
        hr: Math.round(snore ? rnd(66, 74) : rnd(58, 66)), spo2: Math.round(snore ? rnd(91, 95) : rnd(95, 98)), supineMin: Math.floor(supineMs / 60000), nudges, success, nudging, buzzing };
      await send("PUT", "/live", live);
      if (tick++ % 6 === 0) await send("POST", "/history", { t: live.t, posture: p, hr: live.hr, spo2: live.spo2, sound: live.sound, snores30s: live.snores30s, temp: live.temp, hum: live.hum });
      console.log(`${live.t}  mode=${mode} ${p.padEnd(7)} hr=${live.hr} spo2=${live.spo2} motor=${nudging ? "ON" : "off"} buzzer=${buzzing ? "ON" : "off"}`);
      if (tick % 60 === 0) await send("PUT", `/nights/${dateKey()}`, { supineMin: Math.floor(supineMs / 60000), nudges, success, escalations: esc, snoreEvents: nudges * 4, minSpo2: 91, lastHR: live.hr, temp: live.temp, hum: live.hum });
    } catch (e) { console.error(e.message); }
    segT += PERIOD / 1000; if (segT >= len) { segT = 0; si = si + 1 >= script.length ? 2 : si + 1; }
    await new Promise((r) => setTimeout(r, PERIOD));
  }
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes("--clear")) { await send("DELETE", ""); console.log("cleared /devices/" + DEV); return; }
  if (args.includes("--seed")) await seed();
  await loop();
})().catch((e) => { console.error(e.message); process.exit(1); });
