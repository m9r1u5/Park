# Park Finder

Remembers where you parked and leads you back — even underground with no GPS.
It counts your steps and the direction you walk (pedestrian dead reckoning),
uses the barometer for parkade levels on Android, and snaps the trail to GPS
whenever a good fix comes back.

- **iPhone:** open **https://m9r1u5.github.io/Park/** in Safari → Share → *Add to Home Screen*
- **Android:** download **[ParkFinder.apk](https://github.com/m9r1u5/Park/releases/latest/download/ParkFinder.apk)** and open it to install

## Files (flat layout)

| File | What it is |
|---|---|
| `index.html` | All screens (Car, Find My Car, History, Settings) and pop-up sheets |
| `app.css` | Styles — dark by default for parkades |
| `app.js` | App logic: parking, GPS fusion, timer, history, install/update, both trackers |
| `pdr.js` | Step detector + gyro/compass heading filter (tuning knobs are commented) |
| `map.js` | Offline trail map on a metre grid (drag, pinch, fit) |
| `sw.js` | Service worker — makes the web app work offline |
| `manifest.json` | PWA install info |
| `version.json` | Current version — the **Update** button checks this |
| `icons/` | App icons |
| `native/*.java` | Android-only: foreground service that tracks with the screen off, barometer floors, timer reminders |
| `native/patch_android.py` | Used by the build to drop the Java code, permissions and icons into the Android project |
| `package.json`, `capacitor.config.json` | Capacitor setup for the APK |
| `.github/workflows/build-apk.yml` | Builds the APK on every push and publishes it to the **latest** release |

## Turn on GitHub Pages (once)

Settings → Pages → *Deploy from a branch* → **main** / **(root)** → Save.

## Releasing an update

1. Change the version in **three** places: `version.json`, `APP_VERSION` at the top of `app.js`, and `CACHE` at the top of `sw.js` (e.g. `1.0.1`).
2. Commit to `main`. The Action builds a new APK; Pages serves the new web app.
3. In the app: Settings → **Update**.

## How the tracking works

- **Steps:** Android uses the phone's hardware step sensor; otherwise the accelerometer
  (peak detection with smoothing, adaptive threshold and a minimum gap between steps).
- **Direction:** gyro (smooth, ignores magnets) fused with the compass (no drift).
  When the compass suddenly disagrees — steel, cars, rebar — it is trusted much less.
- **Step length:** 0.415 × your height, or calibrate it in Settings.
- **Floors:** Android barometer, ~3 m per level; slow pressure drift (weather) is ignored.
  iPhone has no barometer access in the browser, so use the ▲/▼ buttons.
- **GPS:** fixes better than ±15 m correct the position. If you parked with no GPS,
  the first good fix outside works out where the car is on the real map.

## Limits

- Hold the phone in your hand, top pointing where you walk. In a pocket, steps still count
  but direction follows the phone.
- Expect drift of roughly 5–10 % of the distance walked.
- iPhone (web app): keep the app open and the screen on while walking; timer reminders only
  fire while the app is open.
