// Sleep Position Trainer – dashboard configuration
// 1. Paste your Firebase Realtime Database URL below (same as FIREBASE_URL in the firmware).
// 2. Leave it empty to run the dashboard in DEMO mode with simulated data.
// You can also override both at runtime:  index.html?db=https://xxx.firebaseio.com&device=spt01
//                       or force demo:     index.html?demo=1
window.SPT_CONFIG = {
  databaseURL: "",        // e.g. "https://sleep-trainer-1234-default-rtdb.asia-southeast1.firebasedatabase.app"
  deviceId: "spt01",
  offlineAfterSec: 30     // mark the device offline if /live is older than this
};
