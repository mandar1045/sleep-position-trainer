/*
 * Sleep Position Trainer – ESP32 DevKit V1
 * Team: Mandar Joshi (24BIT0595), Animesh Abhi Dubey (24BIT0057)
 *
 * Sensors   : S1 MPU6050 (I2C), S2 MAX30102 (I2C), S3 KY-038 (A0), S4 DHT11, S5 LDR module HW-072 (digital DO)
 * Actuators : A1 coin vibration motor (2N2222A, PWM), A2 active buzzer (2N2222A), A3 status LED
 * Cloud     : Firebase Realtime Database over HTTPS (REST)
 *
 * Board package: esp32 by Espressif, 2.x or 3.x (both supported)
 * Libraries    : DHT sensor library (MPU6050 and MAX30102 are read directly over I2C)
 *                (MAX30102 is driven directly over I2C – no MAX3010x library needed)
 * Verified    : compiles for "DOIT ESP32 DEVKIT V1" with esp32 core 2.0.17 and 3.3.12
 */
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include <DHT.h>

// ---------------- Pin map ----------------
#define PIN_SDA      21
#define PIN_SCL      22
#define PIN_SOUND    34   // KY-038 A0  (ADC1)
#define PIN_LDR      35   // HW-072 LDR module DO (HIGH = dark)
#define PIN_DHT       4
#define PIN_MOTOR    25   // 2N2222A #1 base via 1k (PWM)
#define PIN_BUZZER   26   // 2N2222A #2 base via 1k
#define PIN_LED      27   // LED via 220R

// ---------------- Configuration ----------------
const char* WIFI_SSID     = "YOUR_WIFI";
const char* WIFI_PASS     = "YOUR_PASSWORD";
const char* FIREBASE_URL  = "https://YOUR-PROJECT-default-rtdb.firebaseio.com";
const char* FIREBASE_AUTH = "YOUR_DATABASE_SECRET";
const char* DEVICE_ID     = "spt01";

const int   LDR_DARK          = 800;     // ADC below this = room dark
const int   LDR_BRIGHT        = 2000;    // ADC above this = lights on
const unsigned long START_DELAY_MS   = 10UL * 1000;       // DEMO (real: 15 min)  // fall-asleep delay
const unsigned long SUPINE_CONFIRM_MS = 3UL * 1000;      // DEMO (real: 20 s)      // stable posture time
const unsigned long ESCALATE_MS       = 10UL * 1000;      // DEMO (real: 30 s)      // buzzer if ignored
const unsigned long UPLOAD_MS         = 5UL * 1000;       // DEMO (real: 60 s)      // cloud update period
const unsigned long MORNING_MS        = 10UL * 60 * 1000; // lights on this long = morning
const int   SNORE_P2P_LEVEL   = 1500;    // peak-to-peak ADC counts in 100 ms window
const int   SNORES_REQUIRED   = 3;       // bursts in last 30 s
const bool  REQUIRE_SNORE     = false;   // true = nudge only if also snoring (supine alone triggers in demo)

// ---------------- Objects & state ----------------
DHT dht(PIN_DHT, DHT11);

enum Posture { UPRIGHT, SUPINE, PRONE, LEFT_SIDE, RIGHT_SIDE };
const char* POSTURE_NAME[] = {"UPRIGHT", "SUPINE", "PRONE", "LEFT", "RIGHT"};
enum Mode { WAIT_DARK, START_DELAY, MONITOR };

Mode mode = WAIT_DARK;
Posture posture = UPRIGHT, candidate = UPRIGHT;
unsigned long candidateSince = 0, modeSince = 0, lastUpload = 0, brightSince = 0;
unsigned long nudgeStart = 0;
bool nudging = false, buzzing = false;
int nudgeLevel = -1;                 // current vibration level (0..2)

unsigned long snoreTimes[16]; int snoreHead = 0;
int loudFrames = 0;

// night statistics
unsigned long supineMs = 0, lastStatTick = 0;
int nudges = 0, nudgeSuccess = 0, escalations = 0, snoreEvents = 0;
int32_t lastSpo2 = -1, lastHR = -1, minSpo2 = 100;
float lastTemp = NAN, lastHum = NAN;
bool ppgOk = false;

// ---- minimal MAX30102 driver (direct I2C, no library) ----
const uint8_t MAX_ADDR = 0x57;
void maxWrite(uint8_t reg, uint8_t val) { Wire.beginTransmission(MAX_ADDR); Wire.write(reg); Wire.write(val); Wire.endTransmission(); }
uint8_t maxRead(uint8_t reg) {
  Wire.beginTransmission(MAX_ADDR); Wire.write(reg); Wire.endTransmission(false);
  Wire.requestFrom(MAX_ADDR, (uint8_t)1); return Wire.available() ? Wire.read() : 0;
}
bool maxBegin() {
  if (maxRead(0xFF) != 0x15) return false;      // PART_ID of MAX30102 / MAX30105
  maxWrite(0x09, 0x40); delay(100);             // reset
  maxWrite(0x08, 0x5F);                         // FIFO: average 4 samples, rollover on
  maxWrite(0x0A, 0x2F);                         // SpO2: ADC 4096 nA, 100 samples/s, 411 us pulse (18-bit)
  maxWrite(0x0C, 0x3C); maxWrite(0x0D, 0x3C);   // LED currents: red, IR (~12 mA)
  maxWrite(0x04, 0); maxWrite(0x05, 0); maxWrite(0x06, 0);   // clear FIFO pointers
  maxWrite(0x09, 0x03);                         // SpO2 mode (red + IR)
  return true;
}
// reads one red/IR sample pair from the FIFO; returns false if none is waiting
bool maxReadSample(uint32_t& red, uint32_t& ir) {
  uint8_t wr = maxRead(0x04), rd = maxRead(0x06);
  if (wr == rd) return false;
  Wire.beginTransmission(MAX_ADDR); Wire.write(0x07); Wire.endTransmission(false);
  Wire.requestFrom(MAX_ADDR, (uint8_t)6);
  uint8_t b[6]; for (int i = 0; i < 6; i++) b[i] = Wire.available() ? Wire.read() : 0;
  red = (((uint32_t)b[0] << 16) | ((uint32_t)b[1] << 8) | b[2]) & 0x3FFFF;
  ir  = (((uint32_t)b[3] << 16) | ((uint32_t)b[4] << 8) | b[5]) & 0x3FFFF;
  return true;
}

// ---- minimal MPU6050 driver (direct I2C; also works with MPU6500/9250 clones) ----
uint8_t mpuAddr = 0x68;
bool mpuOk = false;
uint8_t i2cRead8(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr); Wire.write(reg); if (Wire.endTransmission(false) != 0) return 0xFF;
  Wire.requestFrom(addr, (uint8_t)1); return Wire.available() ? Wire.read() : 0xFF;
}
void i2cWrite8(uint8_t addr, uint8_t reg, uint8_t v) { Wire.beginTransmission(addr); Wire.write(reg); Wire.write(v); Wire.endTransmission(); }
bool mpuBegin() {
  for (uint8_t a : {0x68, 0x69}) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      mpuAddr = a;
      uint8_t who = i2cRead8(a, 0x75);
      i2cWrite8(a, 0x6B, 0x80); delay(100);   // reset
      i2cWrite8(a, 0x6B, 0x01);               // wake up, PLL clock
      i2cWrite8(a, 0x1C, 0x00);               // accel range +-2 g (16384 LSB/g)
      i2cWrite8(a, 0x1A, 0x04);               // low-pass filter ~21 Hz
      Serial.printf("[I2C ] MPU found @0x%02X (WHO_AM_I=0x%02X)\n", a, who);
      return true;
    }
  }
  return false;
}
bool mpuReadAccel(float& ax, float& ay, float& az) {
  Wire.beginTransmission(mpuAddr); Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(mpuAddr, (uint8_t)6) != 6) return false;
  int16_t x = (Wire.read() << 8) | Wire.read();
  int16_t y = (Wire.read() << 8) | Wire.read();
  int16_t z = (Wire.read() << 8) | Wire.read();
  ax = x / 16384.0f; ay = y / 16384.0f; az = z / 16384.0f;
  return true;
}

// ---------------- Helpers ----------------
// PWM works on both ESP32 board package 2.x (channel API) and 3.x (pin API)
#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif
const int MOTOR_CH = 0;
void motorPwmInit() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_MOTOR, 200, 8);          // 200 Hz, 8-bit
#else
  ledcSetup(MOTOR_CH, 200, 8);
  ledcAttachPin(PIN_MOTOR, MOTOR_CH);
#endif
}
void setMotor(int duty) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_MOTOR, duty);
#else
  ledcWrite(MOTOR_CH, duty);
#endif
}

void ledPattern() {
  unsigned long t = millis();
  bool on;
  if (mode == WAIT_DARK)        on = false;
  else if (mode == START_DELAY) on = (t / 1000) % 2;          // slow blink
  else if (nudging)             on = (t / 125) % 2;           // fast blink
  else                          on = (t % 4000) < 80;         // heartbeat flash
  digitalWrite(PIN_LED, on);
}

// waitMs > 0: block up to waitMs (used once in setup). waitMs = 0: non-blocking retry every 30 s,
// so the motor / buzzer keep working normally even when Wi-Fi is unavailable.
bool ntpStarted = false;
unsigned long lastWifiTry = 0;
void wifiConnect(unsigned long waitMs = 0) {
  if (strcmp(WIFI_SSID, "YOUR_WIFI") == 0) {                // Wi-Fi not configured: run offline quietly
    if (waitMs) Serial.println("[WiFi] not configured – offline mode");
    return;
  }
  if (WiFi.status() == WL_CONNECTED) {
    if (!ntpStarted) {
      ntpStarted = true;
      Serial.printf("[WiFi] Connected: %s  RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      configTime(19800, 0, "pool.ntp.org", "time.google.com");   // IST = UTC+5:30
    }
    return;
  }
  if (waitMs == 0 && millis() - lastWifiTry < 30000) return;
  lastWifiTry = millis();
  if (waitMs) { WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS); }
  else WiFi.reconnect();
  unsigned long t0 = millis();
  while (waitMs && WiFi.status() != WL_CONNECTED && millis() - t0 < waitMs) delay(250);
  if (WiFi.status() == WL_CONNECTED) wifiConnect();            // prints + starts NTP
  else Serial.println(waitMs ? "[WiFi] not connected – running offline, will keep retrying" : "[WiFi] retrying...");
}

String isoTime() {
  struct tm ti;
  if (!getLocalTime(&ti, 50)) return String(millis() / 1000);
  char b[25]; strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%S", &ti);
  return String(b);
}

String dateKey() {
  struct tm ti;
  if (!getLocalTime(&ti, 50)) return "unknown";
  char b[12]; strftime(b, sizeof b, "%Y-%m-%d", &ti);
  return String(b);
}

bool firebaseSend(const String& path, const String& json, bool push) {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClientSecure client; client.setInsecure();
  HTTPClient http;
  String url = String(FIREBASE_URL) + path + ".json?auth=" + FIREBASE_AUTH;
  if (!http.begin(client, url)) return false;
  http.addHeader("Content-Type", "application/json");
  unsigned long t0 = millis();
  int code = push ? http.POST(json) : http.PUT(json);
  Serial.printf("[HTTP] %s %s -> %d (%lu ms)\n", push ? "POST" : "PUT", path.c_str(), code, millis() - t0);
  http.end();
  return code == 200;
}

void logEvent(const char* type, const String& detail) {
  String j = "{\"t\":\"" + isoTime() + "\",\"type\":\"" + type + "\",\"detail\":\"" + detail + "\"}";
  firebaseSend(String("/devices/") + DEVICE_ID + "/events", j, true);
}

// ---------------- Sensors ----------------
Posture readPosture(float& ax, float& ay, float& az) {
  ax = ay = az = 0;
  if (!mpuOk || !mpuReadAccel(ax, ay, az)) return posture;   // keep last posture if the sensor is missing
  // Mounting: Z axis points out of the chest, Y axis toward the head.
  if (ay > 0.7)  return UPRIGHT;
  if (az > 0.8)  return SUPINE;      // chest facing the ceiling
  if (az < -0.8) return PRONE;
  return (ax > 0) ? LEFT_SIDE : RIGHT_SIDE;
}

// one 100 ms window of the microphone: returns true when a snore burst ends
bool sampleSound(int& p2p) {
  int lo = 4095, hi = 0;
  unsigned long t0 = millis();
  while (millis() - t0 < 100) {
    int v = analogRead(PIN_SOUND);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    delayMicroseconds(500);
  }
  p2p = hi - lo;
  if (p2p > SNORE_P2P_LEVEL) { loudFrames++; return false; }
  bool burst = (loudFrames >= 3 && loudFrames <= 25);   // 0.3 s – 2.5 s of loud sound
  loudFrames = 0;
  return burst;
}

int recentSnores() {
  int n = 0; unsigned long now = millis();
  for (int i = 0; i < 16; i++) if (snoreTimes[i] && now - snoreTimes[i] < 30000) n++;
  return n;
}

// Heart rate + SpO2 from raw IR / red samples (self-contained, no extra library file needed).
// HR  : peaks of the detrended IR (pulse) signal, at least 0.33 s apart.
// SpO2: "ratio of ratios" R = (AC_red/DC_red) / (AC_ir/DC_ir), SpO2 ~ 110 - 25*R.
void calcHrSpo2(const uint32_t* ir, const uint32_t* red, int n, float fs,
                int32_t* hr, int8_t* hrValid, int32_t* spo2, int8_t* spo2Valid) {
  *hrValid = 0; *spo2Valid = 0;
  float dcIr = 0, dcRed = 0;
  for (int i = 0; i < n; i++) { dcIr += ir[i]; dcRed += red[i]; }
  dcIr /= n; dcRed /= n;
  static float ac[100];
  float acIr = 0, acRed = 0;
  const int W = 4;                                   // moving-average window removes slow drift
  for (int i = 0; i < n; i++) {
    float m = 0; int c = 0;
    for (int k = i - W; k <= i + W; k++) if (k >= 0 && k < n) { m += ir[k]; c++; }
    float base = 0; int cb = 0;
    for (int k = i - 12; k <= i + 12; k++) if (k >= 0 && k < n) { base += ir[k]; cb++; }
    ac[i] = (m / c) - (base / cb);
    acIr += ((float)ir[i] - dcIr) * ((float)ir[i] - dcIr);
    acRed += ((float)red[i] - dcRed) * ((float)red[i] - dcRed);
  }
  acIr = sqrtf(acIr / n); acRed = sqrtf(acRed / n);
  // peaks
  float thr = 0; for (int i = 0; i < n; i++) thr += fabsf(ac[i]); thr = thr / n * 0.6f;
  int minGap = (int)(fs * 0.33f), first = -1, last = -1, peaks = 0, prev = -1000;
  for (int i = 1; i < n - 1; i++) {
    if (ac[i] > thr && ac[i] >= ac[i - 1] && ac[i] > ac[i + 1] && i - prev >= minGap) {
      if (first < 0) first = i; last = i; peaks++; prev = i;
    }
  }
  if (peaks >= 2 && last > first) {
    float bpm = (peaks - 1) * 60.0f * fs / (last - first);
    if (bpm >= 40 && bpm <= 180) { *hr = (int32_t)(bpm + 0.5f); *hrValid = 1; }
  }
  if (dcIr > 0 && dcRed > 0 && acIr > 0) {
    float R = (acRed / dcRed) / (acIr / dcIr);
    float v = 110.0f - 25.0f * R;
    if (v > 100) v = 100;
    if (v >= 70) { *spo2 = (int32_t)(v + 0.5f); *spo2Valid = 1; }
  }
}

void readPPG() {
  if (!ppgOk) return;
  const int N = 100;
  static uint32_t ir[N], red[N];
  maxWrite(0x04, 0); maxWrite(0x05, 0); maxWrite(0x06, 0);   // drop stale FIFO data, start a fresh 4 s window
  for (int i = 0; i < N; i++) {
    unsigned long t0 = millis();
    while (!maxReadSample(red[i], ir[i])) { delay(2); if (millis() - t0 > 200) return; }
  }
  if (ir[N - 1] < 50000) { Serial.println("[PPG] no finger detected"); return; }
  int32_t spo2, hr; int8_t vs, vh;
  calcHrSpo2(ir, red, N, 25.0f, &hr, &vh, &spo2, &vs);   // 100 Hz with 4-sample averaging = 25 samples/s
  if (vs) { lastSpo2 = spo2; if (spo2 < minSpo2) minSpo2 = spo2; }
  if (vh) lastHR = hr;
  if (vs && spo2 < 90) logEvent("spo2_dip", String(spo2) + "%");
}

void readEnv() {
  float t = dht.readTemperature(), h = dht.readHumidity();
  if (!isnan(t)) lastTemp = t;
  if (!isnan(h)) lastHum = h;
}

// ---------------- Actuator logic ----------------
void startNudge() {
  nudging = true; buzzing = false; nudgeStart = millis(); nudges++; nudgeLevel = -1;
  Serial.println("[ACT ] nudge start");
  logEvent("nudge", POSTURE_NAME[posture]);
}

void stopNudge(bool success) {
  if (!nudging) return;
  nudging = false; buzzing = false;
  setMotor(0); digitalWrite(PIN_BUZZER, LOW);
  if (success) {
    nudgeSuccess++;
    unsigned long s = (millis() - nudgeStart) / 1000;
    Serial.printf("[ACT ] turned to %s in %lu s – motor OFF\n", POSTURE_NAME[posture], s);
    logEvent("turned", String(POSTURE_NAME[posture]) + " in " + s + " s");
  }
}

// Vibration gets clearly stronger in 3 levels before the buzzer joins in:
//   level 1: 35 % PWM, short 250 ms pulses   (gentle tap)
//   level 2: 65 % PWM, 500 ms pulses         (stronger)
//   level 3: 100 % PWM, 800 ms pulses        (full) – and the buzzer starts after ESCALATE_MS
const int  LEVEL_DUTY[3]  = {90, 165, 255};
const int  LEVEL_PULSE[3] = {250, 500, 800};        // ms ON out of every 1000 ms


void updateNudge() {
  if (!nudging) return;
  unsigned long dt = millis() - nudgeStart;
  int level = min(2, (int)(dt * 3 / ESCALATE_MS));   // splits the time before the buzzer into 3 equal steps
  if (level != nudgeLevel) {
    nudgeLevel = level;
    Serial.printf("[ACT ] vibration level %d: PWM %d/255 (%d %%), pulse %d ms\n",
                  level + 1, LEVEL_DUTY[level], LEVEL_DUTY[level] * 100 / 255, LEVEL_PULSE[level]);
  }
  setMotor((dt % 1000) < (unsigned long)LEVEL_PULSE[level] ? LEVEL_DUTY[level] : 0);
  if (dt > ESCALATE_MS) {
    if (!buzzing) { buzzing = true; escalations++; Serial.println("[ACT ] nudge ignored – buzzer ON"); logEvent("escalate", "buzzer"); }
    digitalWrite(PIN_BUZZER, (dt % 1500) < 200);        // short beep every 1.5 s
  }
  if (dt > 120000UL) stopNudge(false);                    // safety: give up after 2 min
}

// ---------------- Cloud ----------------
void uploadLive(float ax, float ay, float az, int p2p, int ldr) {
  char j[480];
  snprintf(j, sizeof j,
    "{\"t\":\"%s\",\"mode\":%d,\"posture\":\"%s\",\"ax\":%.2f,\"ay\":%.2f,\"az\":%.2f,"
    "\"sound\":%d,\"snores30s\":%d,\"light\":%d,\"temp\":%.1f,\"hum\":%.0f,\"hr\":%ld,\"spo2\":%ld,"
    "\"supineMin\":%lu,\"nudges\":%d,\"success\":%d,\"nudging\":%d,\"buzzing\":%d}",
    isoTime().c_str(), mode, POSTURE_NAME[posture], ax, ay, az, p2p, recentSnores(), ldr,
    lastTemp, lastHum, (long)lastHR, (long)lastSpo2, supineMs / 60000, nudges, nudgeSuccess, nudging, buzzing);
  firebaseSend(String("/devices/") + DEVICE_ID + "/live", j, false);

  // compact history point every 6th upload (~30 s) for the dashboard charts
  static uint8_t histTick = 0;
  if (histTick++ % 6 == 0) {
    char h[200];
    snprintf(h, sizeof h, "{\"t\":\"%s\",\"posture\":\"%s\",\"hr\":%ld,\"spo2\":%ld,\"sound\":%d,\"snores30s\":%d,\"temp\":%.1f,\"hum\":%.0f}",
             isoTime().c_str(), POSTURE_NAME[posture], (long)lastHR, (long)lastSpo2, p2p, recentSnores(), lastTemp, lastHum);
    firebaseSend(String("/devices/") + DEVICE_ID + "/history", h, true);
  }
}

void uploadNight() {
  char j[300];
  snprintf(j, sizeof j,
    "{\"supineMin\":%lu,\"nudges\":%d,\"success\":%d,\"escalations\":%d,\"snoreEvents\":%d,"
    "\"minSpo2\":%ld,\"lastHR\":%ld,\"temp\":%.1f,\"hum\":%.0f}",
    supineMs / 60000, nudges, nudgeSuccess, escalations, snoreEvents, (long)minSpo2, (long)lastHR, lastTemp, lastHum);
  firebaseSend(String("/devices/") + DEVICE_ID + "/nights/" + dateKey(), j, false);
  supineMs = 0; nudges = nudgeSuccess = escalations = snoreEvents = 0; minSpo2 = 100;
}

// ---------------- Setup / loop ----------------
void setup() {
  Serial.begin(115200);
  Serial.println("\n[BOOT] Sleep Position Trainer v0.9 (ESP32 DevKit V1)");
  pinMode(PIN_LED, OUTPUT); pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  motorPwmInit();                  // 200 Hz, 8-bit PWM
  setMotor(0);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_SOUND, ADC_11db);
  pinMode(PIN_LDR, INPUT);                    // HW-072 LDR module: DO is HIGH when dark

  Wire.begin(PIN_SDA, PIN_SCL);
  Serial.print("[I2C ] scan:");
  for (uint8_t a = 1; a < 127; a++) { Wire.beginTransmission(a); if (Wire.endTransmission() == 0) Serial.printf(" 0x%02X", a); }
  Serial.println();
  mpuOk = mpuBegin();
  if (!mpuOk) Serial.println("[I2C ] MPU6050 NOT found – check SDA/SCL");
  ppgOk = maxBegin();
  if (ppgOk) Serial.println("[I2C ] MAX30102 found @0x57");
  else Serial.println("[I2C ] MAX30102 NOT found");
  dht.begin();
  wifiConnect(10000);
  modeSince = millis(); lastStatTick = millis();
}

void loop() {
  bool dark = digitalRead(PIN_LDR) == HIGH;  // digital LDR module
  int ldr = dark ? 0 : 4095;
  int p2p = 0;
  if (sampleSound(p2p)) {                       // ~100 ms, also paces the loop
    snoreTimes[snoreHead] = millis(); snoreHead = (snoreHead + 1) % 16; snoreEvents++;
  }
  float ax, ay, az;
  Posture p = readPosture(ax, ay, az);
  if (p != candidate) { candidate = p; candidateSince = millis(); }
  if (millis() - candidateSince > SUPINE_CONFIRM_MS || (nudging && p != SUPINE)) posture = candidate;

  unsigned long now = millis();
  switch (mode) {
    case WAIT_DARK:
      if (ldr < LDR_DARK) { mode = START_DELAY; modeSince = now; Serial.println("[LDR ] dark -> start-up delay"); }
      break;
    case START_DELAY:
      if (ldr > LDR_BRIGHT) { mode = WAIT_DARK; break; }
      if (now - modeSince > START_DELAY_MS) { mode = MONITOR; Serial.println("[MODE] monitoring"); }
      break;
    case MONITOR: {
      if (posture == SUPINE) supineMs += now - lastStatTick;
      bool snoring = recentSnores() >= SNORES_REQUIRED;
      if (!nudging && posture == SUPINE && (snoring || !REQUIRE_SNORE)) startNudge();
      if (nudging && posture != SUPINE) stopNudge(true);
      updateNudge();
      if (ldr > LDR_BRIGHT) { if (!brightSince) brightSince = now; }
      else brightSince = 0;
      if (brightSince && now - brightSince > MORNING_MS) {   // morning: send summary
        stopNudge(false); uploadNight(); mode = WAIT_DARK; brightSince = 0;
      }
      break;
    }
  }
  lastStatTick = now;
  ledPattern();

  if (now - lastUpload > UPLOAD_MS) {
    lastUpload = now;
    static uint8_t ppgTick = 0;
    if (!nudging && (ppgTick++ % 3 == 0)) readPPG();   // ~4 s blocking read, every 3rd upload, skipped while nudging
    readEnv();
    Serial.printf("[STAT] pos=%s ax=%.2f ay=%.2f az=%.2f sound=%d snores=%d ldr=%d T=%.1f RH=%.0f HR=%ld SpO2=%ld\n",
                  POSTURE_NAME[posture], ax, ay, az, p2p, recentSnores(), ldr, lastTemp, lastHum, (long)lastHR, (long)lastSpo2);
    wifiConnect();
    uploadLive(ax, ay, az, p2p, ldr);
  }
}
