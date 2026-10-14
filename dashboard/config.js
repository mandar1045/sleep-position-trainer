// Sleep Position Trainer – dashboard configuration
// 1. Paste your Firebase Realtime Database URL below (same as FIREBASE_URL in the firmware).
// 2. If left empty, the dashboard asks for the URL on first load (stored in that browser).
// You can also override both at runtime:  index.html?db=https://xxx.firebaseio.com&device=spt01

window.SPT_CONFIG = {
  databaseURL: "",        // e.g. "https://sleep-trainer-1234-default-rtdb.asia-southeast1.firebasedatabase.app"
  deviceId: "spt01",
  offlineAfterSec: 30     // mark the device offline if /live is older than this
};
