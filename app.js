/* =====================================================================
   Park Finder — app.js
   UI, storage, GPS fusion and the two trackers:
     • JsTracker     — browser sensors (iPhone PWA, or any browser)
     • NativeTracker — Android foreground service (APK), works screen-off
   ===================================================================== */
(function () {
  'use strict';

  /* ---------------- constants ---------------- */
  const APP_VERSION = '1.0.0';
  const PAGES_URL = 'https://m9r1u5.github.io/Park/';
  const APK_URL = 'https://github.com/m9r1u5/Park/releases/latest/download/ParkFinder.apk';
  const GOOD_GPS_M = 15;          // GPS fixes better than this correct the trail
  const ARRIVE_M = 5;
  const MAX_POINTS = 20000;
  const MAX_HISTORY = 20;

  const cap = window.Capacitor;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let Native = null;
  if (isNative) {
    try { Native = cap.registerPlugin ? cap.registerPlugin('ParkTracker') : cap.Plugins.ParkTracker; } catch (e) { Native = null; }
  }

  const $ = id => document.getElementById(id);
  const now = () => Date.now();

  /* ---------------- small storage helpers ---------------- */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { } }
  };

  const DB = (() => {
    let p = null;
    function open() {
      if (p) return p;
      p = new Promise((res, rej) => {
        if (!window.indexedDB) return rej(new Error('no idb'));
        const r = indexedDB.open('parkfinder', 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return p;
    }
    async function tx(store, mode, fn) {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const out = fn(s);
        t.oncomplete = () => res(out && 'result' in out ? out.result : out);
        t.onerror = () => rej(t.error);
      });
    }
    return {
      put: (store, v) => tx(store, 'readwrite', s => s.put(v)).catch(() => null),
      get: (store, id) => tx(store, 'readonly', s => s.get(id)).catch(() => null),
      del: (store, id) => tx(store, 'readwrite', s => s.delete(id)).catch(() => null),
      all: (store) => tx(store, 'readonly', s => s.getAll()).catch(() => [])
    };
  })();

  /* ---------------- settings ---------------- */
  const settings = Object.assign({
    heightCm: 170, stepLen: null, units: 'm', theme: 'dark', autoStopMin: 180, remindMin: 10
  }, LS.get('pf.settings', {}));
  function saveSettings() { LS.set('pf.settings', settings); }
  function stepLength() { return settings.stepLen || PDR.stepFromHeight(settings.heightCm); }
  function applyTheme() { document.documentElement.dataset.theme = settings.theme; }
  applyTheme();

  /* ---------------- formatting ---------------- */
  function fmtDist(m) {
    if (m == null || !isFinite(m)) return '—';
    if (settings.units === 'ft') {
      const ft = m * 3.28084;
      return ft < 5280 ? Math.round(ft) + ' ft' : (ft / 5280).toFixed(1) + ' mi';
    }
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km';
  }
  function fmtDistParts(m) { const s = fmtDist(m).split(' '); return { n: s[0], u: s[1] || '' }; }
  function fmtTime(t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function fmtDate(t) {
    const d = new Date(t), today = new Date();
    const same = d.toDateString() === today.toDateString();
    return (same ? 'Today' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })) + ', ' + fmtTime(t);
  }
  function fmtLeft(ms) {
    const neg = ms < 0; ms = Math.abs(ms);
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return (neg ? '-' : '') + (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }
  function floorText(diff) {
    if (!diff) return 'Car is on this level';
    const n = Math.abs(diff);
    return `Car is ${n} level${n > 1 ? 's' : ''} ${diff > 0 ? 'down' : 'up'}`;
  }

  let toastTimer = null;
  function toast(msg, ms = 3200) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function buzz(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { } }

  /* =====================================================================
     SESSION (the current parking)
     ===================================================================== */
  let session = LS.get('pf.session', null);
  let saveQueued = false;
  function saveSession(immediate) {
    if (immediate) { LS.set('pf.session', session); saveQueued = false; return; }
    if (saveQueued) return;
    saveQueued = true;
    setTimeout(() => { saveQueued = false; if (session) LS.set('pf.session', session); }, 2000);
  }
  function newSession(fields) {
    return Object.assign({
      id: 'p' + now(), startedAt: now(),
      gps: null, carGeo: null,
      level: '', bay: '', note: '', photoId: null,
      points: [{ x: 0, y: 0, f: 0 }],
      x: 0, y: 0, heading: null, steps: 0, dist: 0,
      floorAuto: 0, floorManual: 0,
      sigmaBase: 1.5, distAtFix: 0, lastFixAt: 0, lastFixAcc: null,
      tracking: true, autoStopAt: now() + settings.autoStopMin * 60000,
      timer: null, nativeIdx: 0, stepSource: isNative ? 'native' : 'browser'
    }, fields);
  }
  function floorNow() { return session ? (session.floorAuto || 0) + (session.floorManual || 0) : 0; }
  function sigmaNow() { return session ? PDR.pdrSigma(session.sigmaBase, session.dist - session.distAtFix) : 0; }
  function posMode() {
    if (!session) return null;
    const age = now() - (session.lastFixAt || 0);
    if (age < 10000) return 'gps';
    if (age < 120000) return 'mixed';
    return 'steps';
  }

  function addPoint(x, y, f) {
    const pts = session.points;
    pts.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, f });
    if (pts.length > MAX_POINTS) {          // thin older half to keep storage small
      const keep = [pts[0]];
      for (let i = 1; i < pts.length / 2; i += 2) keep.push(pts[i]);
      session.points = keep.concat(pts.slice(Math.floor(pts.length / 2)));
    }
  }

  /** Shift the current position (GPS correction). Trail history stays as walked. */
  function applyCorrection(dx, dy) {
    session.x += dx; session.y += dy;
    addPoint(session.x, session.y, floorNow());
    tracker && tracker.correct(dx, dy);
  }

  /* =====================================================================
     JS TRACKER — browser sensors (PWA / iPhone)
     ===================================================================== */
  const JsTracker = {
    running: false,
    det: null, hf: null, grav: null, lastCompass: null, gyroRate: null,
    compassSeen: false, motionSeen: false,

    start() {
      if (this.running) return;
      this.det = new PDR.StepDetector();
      this.hf = new PDR.HeadingFilter();
      if (session && session.heading != null) this.hf.heading = session.heading;
      this.running = true;
      window.addEventListener('devicemotion', this._onMotion);
      if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', this._onOrient);
      else window.addEventListener('deviceorientation', this._onOrient);
    },
    stop() {
      this.running = false;
      window.removeEventListener('devicemotion', this._onMotion);
      window.removeEventListener('deviceorientationabsolute', this._onOrient);
      window.removeEventListener('deviceorientation', this._onOrient);
    },
    correct() { /* position lives in session; nothing extra to do */ },
    sync() { return Promise.resolve(); },

    _onOrient(e) {
      const self = JsTracker;
      let h = null;
      if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
        h = e.webkitCompassHeading;            // iOS: already degrees from north, clockwise
      } else if ((e.absolute || e.type === 'deviceorientationabsolute') && e.alpha != null) {
        h = forwardHeading(e.alpha, e.beta || 0, e.gamma || 0);
      }
      if (h == null || isNaN(h)) return;
      self.compassSeen = true;
      self.lastCompass = h;
      self._heading(performance.now(), h, null);
    },

    _onMotion(e) {
      const self = JsTracker;
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      self.motionSeen = true;
      const t = performance.now();
      // slow average of the raw vector = gravity direction (for gyro projection)
      if (!self.grav) self.grav = { x: a.x, y: a.y, z: a.z };
      else { const k = 0.08; self.grav.x += k * (a.x - self.grav.x); self.grav.y += k * (a.y - self.grav.y); self.grav.z += k * (a.z - self.grav.z); }
      const yaw = PDR.HeadingFilter.yawRate(e.rotationRate, self.grav);
      self._heading(t, null, yaw);

      const step = self.det.feed(t, a.x, a.y, a.z);
      if (step && session && session.tracking) onStep(stepLength(), self.hf.heading);
    },

    _heading(t, compass, yaw) {
      const h = this.hf.update(t, compass, yaw);
      if (session && h != null) session.heading = h;
    }
  };
  JsTracker._onMotion = JsTracker._onMotion.bind(JsTracker);
  JsTracker._onOrient = JsTracker._onOrient.bind(JsTracker);

  /**
   * Direction the phone is "pointing" for walking, from absolute
   * alpha/beta/gamma. Uses the top edge when the phone is flat and the
   * back of the phone when it is held upright, so it works either way.
   */
  function forwardHeading(alpha, beta, gamma) {
    const D = Math.PI / 180;
    const sA = Math.sin(alpha * D), cA = Math.cos(alpha * D);
    const sB = Math.sin(beta * D), cB = Math.cos(beta * D);
    const sG = Math.sin(gamma * D), cG = Math.cos(gamma * D);
    // device top edge and back face expressed in earth frame (x=east, y=north)
    const topX = -sA * cB, topY = cA * cB;
    const backX = -cA * sG - sA * sB * cG, backY = -sA * sG + cA * sB * cG;
    const vx = topX + backX, vy = topY + backY;
    if (Math.hypot(vx, vy) < 0.15) return null;   // phone pointing straight up/down
    return PDR.wrap360(Math.atan2(vx, vy) * 180 / Math.PI);
  }

  function onStep(len, heading) {
    if (heading == null) {             // no compass yet: count the step, can't place it
      session.steps++; session.noHeadingSteps = (session.noHeadingSteps || 0) + 1;
      saveSession(); return;
    }
    const r = heading * Math.PI / 180;
    session.x += len * Math.sin(r);
    session.y += len * Math.cos(r);
    session.steps++; session.dist += len;
    addPoint(session.x, session.y, floorNow());
    saveSession();
  }

  /* =====================================================================
     NATIVE TRACKER — Android foreground service via Capacitor plugin
     ===================================================================== */
  const NativeTracker = {
    running: false, poll: null,
    async start() {
      this.running = true;
      try {
        session.nativeIdx = 0;
        // barometer restarts from 0 → keep the levels already counted
        session.floorManual = (session.floorManual || 0) + (session.floorAuto || 0);
        session.floorAuto = 0;
        await Native.start({
          stepLength: stepLength(), autoStopMs: Math.max(60000, session.autoStopAt - now()),
          // continue from where we are (e.g. after "Resume tracking")
          x: session.x, y: session.y, steps: session.steps, dist: session.dist,
          heading: session.heading == null ? -1 : session.heading
        });
      } catch (e) {
        toast('Background tracking failed: ' + (e.message || e) + '. Using in-app sensors.');
        tracker = JsTracker; JsTracker.start(); return;
      }
      this._startPoll();
    },
    async stop() {
      this.running = false; clearInterval(this.poll); this.poll = null;
      try { await Native.stop(); } catch (e) { }
    },
    correct(dx, dy) { Native.correct({ dx, dy }).catch(() => { }); },
    _startPoll() { clearInterval(this.poll); this.poll = setInterval(() => this.sync(), 500); this.sync(); },
    async sync() {
      if (!session) return;
      let s;
      try { s = await Native.getState({ since: session.nativeIdx || 0 }); } catch (e) { return; }
      if (!s) return;
      if (s.total < (session.nativeIdx || 0)) session.nativeIdx = 0;   // service restarted
      const arr = s.points || [];
      for (let i = 0; i + 2 < arr.length; i += 3) addPoint(arr[i], arr[i + 1], arr[i + 2] + (session.floorManual || 0));
      session.nativeIdx = s.total;
      session.x = s.x; session.y = s.y;
      session.steps = s.steps; session.dist = s.dist;
      session.heading = s.heading >= 0 ? s.heading : session.heading;
      session.floorAuto = s.floor || 0;
      session.hasBaro = !!s.hasBaro;
      session.stepSource = s.stepSource;
      if (!s.running && session.tracking) { session.tracking = false; toast('Tracking stopped automatically.'); render(); }
      saveSession();
    }
  };

  let tracker = isNative && Native ? NativeTracker : JsTracker;

  /* =====================================================================
     GPS — fusion with the step trail
     ===================================================================== */
  const Gps = {
    watchId: null, last: null,
    start() {
      if (!('geolocation' in navigator) || this.watchId != null) return;
      this.watchId = navigator.geolocation.watchPosition(p => this._fix(p), err => {
        this.err = err;
        // denied → forget the watch so a later start (after allowing) can retry
        if (err.code === 1) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
      },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
    },
    stop() { if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId); this.watchId = null; },
    _fix(p) {
      const fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: p.timestamp || now() };
      this.last = fix;
      parkSheetGps(fix);
      if (!session || !session.tracking) return;

      // first fix at the car (before walking off) → this IS the car position
      if (!session.gps || (fix.acc < session.gps.acc && session.steps < 8)) {
        if (session.steps < 8) session.gps = fix;
      }
      if (fix.acc > GOOD_GPS_M) return;     // too weak to correct anything

      const sigmaP = sigmaNow();
      if (!session.carGeo) {
        // We now know where we are; we know where the car is relative to us
        // (from the steps). So we can place the car on the real map.
        const g = PDR.localToGeo(fix.lat, fix.lon, -session.x, -session.y);
        session.carGeo = { lat: g.lat, lon: g.lon, acc: Math.hypot(fix.acc, sigmaP), src: session.steps < 8 ? 'gps' : 'derived' };
        session.sigmaBase = Math.min(sigmaP, fix.acc); session.distAtFix = session.dist;
      } else {
        const g = PDR.geoToLocal(session.carGeo.lat, session.carGeo.lon, fix.lat, fix.lon);
        const f = PDR.fuseFix(session.x, session.y, sigmaP, g.x, g.y, fix.acc);
        const dx = f.x - session.x, dy = f.y - session.y;
        if (Math.hypot(dx, dy) > 0.3) applyCorrection(dx, dy);
        session.sigmaBase = f.sigma; session.distAtFix = session.dist;
      }
      session.lastFixAt = now(); session.lastFixAcc = fix.acc;
      saveSession();
    }
  };

  /* =====================================================================
     PERMISSIONS
     ===================================================================== */
  async function requestMotion() {
    const out = { motion: true, orientation: true };
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        out.motion = (await DeviceMotionEvent.requestPermission()) === 'granted';
      }
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        out.orientation = (await DeviceOrientationEvent.requestPermission()) === 'granted';
      }
    } catch (e) { out.motion = out.orientation = false; out.err = e.message; }
    if (Native) {
      try { const r = await Native.requestPermissions(); out.native = r; } catch (e) { }
    }
    return out;
  }
  function requestLocationOnce() {
    return new Promise(res => {
      if (!('geolocation' in navigator)) return res(null);
      navigator.geolocation.getCurrentPosition(p => res(p), () => res(null), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    });
  }

  /* =====================================================================
     WAKE LOCK (keep screen on: PWA while tracking, all while finding)
     ===================================================================== */
  let wakeLock = null;
  async function updateWakeLock() {
    const want = document.visibilityState === 'visible' && session &&
      (currentScreen === 'find' || (!isNative && session.tracking));
    try {
      if (want && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
  }

  /* =====================================================================
     NAVIGATION
     ===================================================================== */
  let currentScreen = 'home';
  function show(name) {
    currentScreen = name;
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.body.classList.toggle('finding', name === 'find');
    if (name === 'history') renderHistory();
    if (name === 'settings') renderSettings();
    if (name === 'find') { retrace.on = false; $('btn-retrace').classList.remove('on'); setTimeout(() => map.refit(), 30); }
    updateWakeLock();
    render();
  }
  document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));

  function openSheet(id) { $(id).hidden = false; }
  function closeSheet(id) { $(id).hidden = true; }
  document.querySelectorAll('.sheet').forEach(sh => {
    sh.addEventListener('click', e => { if (e.target === sh) closeSheet(sh.id); });
    sh.querySelectorAll('.sheet-close').forEach(b => b.addEventListener('click', () => {
      closeSheet(sh.id); if (sh.id === 'sheet-calib') Calib.stop();
    }));
  });

  /* =====================================================================
     PARK FLOW
     ===================================================================== */
  let draftPhoto = null;
  function parkSheetGps(fix) {
    if ($('sheet-park').hidden) return;
    const el = $('gps-status');
    if (!fix) { el.textContent = 'No GPS here — that\'s fine, steps will guide you back.'; return; }
    el.textContent = fix.acc <= GOOD_GPS_M ? `📍 GPS locked (±${Math.round(fix.acc)} m)` :
      `📍 Weak GPS (±${Math.round(fix.acc)} m) — steps will do the work`;
  }

  $('btn-park').addEventListener('click', async () => {
    // iOS needs the permission request inside the tap
    const perm = await requestMotion();
    if (perm.motion === false || perm.orientation === false) {
      toast('Motion sensors were blocked. Allow them in Settings to track without GPS.', 5000);
    }
    draftPhoto = null;
    $('in-level').value = ''; $('in-bay').value = ''; $('in-note').value = '';
    $('photo-preview').hidden = true; $('photo-label').textContent = '📷 Add a photo';
    $('gps-status').textContent = 'Getting GPS…';
    openSheet('sheet-park');
    Gps.start();
    if (Gps.last && now() - Gps.last.t < 20000) parkSheetGps(Gps.last);
    setTimeout(() => { if (!$('sheet-park').hidden && (!Gps.last || now() - Gps.last.t > 20000)) parkSheetGps(null); }, 12000);
  });

  $('in-photo').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    draftPhoto = await shrinkImage(f, 1024);
    $('photo-preview').src = draftPhoto; $('photo-preview').hidden = false;
    $('photo-label').textContent = '📷 Change photo';
  });

  function shrinkImage(file, max) {
    return new Promise(res => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = () => { URL.revokeObjectURL(url); res(null); };
      img.src = url;
    });
  }

  $('btn-park-save').addEventListener('click', async () => {
    const fields = { level: $('in-level').value.trim(), bay: $('in-bay').value.trim(), note: $('in-note').value.trim() };
    if (draftPhoto) {
      const pid = 'ph' + now();
      await DB.put('photos', { id: pid, data: draftPhoto });
      fields.photoId = pid;
    }
    const recent = Gps.last && now() - Gps.last.t < 30000 ? Gps.last : null;
    if (recent) {
      fields.gps = recent;
      if (recent.acc <= GOOD_GPS_M) {
        fields.carGeo = { lat: recent.lat, lon: recent.lon, acc: recent.acc, src: 'gps' };
        fields.sigmaBase = 1.5; fields.lastFixAt = now(); fields.lastFixAcc = recent.acc;
      }
    }
    session = newSession(fields);
    saveSession(true);
    closeSheet('sheet-park');
    await startTracking();
    buzz(40);
    toast('Spot saved. Tracking your steps…');
    render();
  });

  async function startTracking() {
    session.tracking = true;
    if (!session.autoStopAt || session.autoStopAt < now()) session.autoStopAt = now() + settings.autoStopMin * 60000;
    saveSession(true);
    Gps.start();
    await tracker.start();
    updateWakeLock();
    // warn if sensors never show up
    if (tracker === JsTracker) {
      setTimeout(() => {
        if (!session || !session.tracking) return;
        if (!JsTracker.motionSeen) toast('No motion sensor data — step tracking can\'t work on this device/browser.', 6000);
        else if (!JsTracker.compassSeen) toast('No compass — steps are counted but direction is unknown. Check sensor permissions.', 6000);
      }, 4000);
    }
  }
  async function stopTracking(reason) {
    if (!session) return;
    session.tracking = false;
    await tracker.stop();
    saveSession(true);
    if (reason) toast(reason);
    updateWakeLock();
    render();
  }

  $('btn-pause').addEventListener('click', async () => {
    if (!session) return;
    if (session.tracking) await stopTracking('Tracking stopped. Position frozen.');
    else {
      session.autoStopAt = now() + settings.autoStopMin * 60000;
      await requestMotion();
      await startTracking();
      toast('Tracking resumed from the last known spot.');
    }
    render();
  });

  $('btn-find').addEventListener('click', async () => {
    if (session && session.tracking && tracker === JsTracker && !JsTracker.running) await requestMotion();
    show('find');
  });
  $('btn-find-back').addEventListener('click', () => show('home'));

  async function finishSession() {
    if (!session) return;
    if (!confirm('Finish this parking and save it to history?')) return;
    await tracker.stop();
    Gps.stop();
    cancelReminders();
    const pts = PDR.simplify(session.points.map(p => ({ x: p.x, y: p.y })), 1.5);
    const rec = {
      id: session.id, startedAt: session.startedAt, endedAt: now(),
      gps: session.gps, carGeo: session.carGeo, level: session.level, bay: session.bay, note: session.note,
      photoId: session.photoId, steps: session.steps, dist: session.dist, points: pts
    };
    await DB.put('history', rec);
    await trimHistory();
    session = null; LS.del('pf.session');
    show('home');
    toast('Saved to history. Drive safe!');
  }
  $('btn-found').addEventListener('click', finishSession);
  $('btn-found-home').addEventListener('click', finishSession);

  async function trimHistory() {
    const all = (await DB.all('history')) || [];
    all.sort((a, b) => b.startedAt - a.startedAt);
    for (const r of all.slice(MAX_HISTORY)) {
      if (r.photoId) await DB.del('photos', r.photoId);
      await DB.del('history', r.id);
    }
  }

  /* level buttons (manual floor change — iPhone has no barometer access) */
  $('btn-floor-up').addEventListener('click', () => { if (!session) return; session.floorManual++; saveSession(); buzz(20); render(); });
  $('btn-floor-down').addEventListener('click', () => { if (!session) return; session.floorManual--; saveSession(); buzz(20); render(); });

  /* open in maps */
  function openMaps(lat, lon) {
    const q = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    const url = isIOS ? `https://maps.apple.com/?ll=${q}&q=My%20car` : `https://www.google.com/maps/search/?api=1&query=${q}`;
    if (isNative) location.href = url; else window.open(url, '_blank');
  }
  $('btn-maps').addEventListener('click', () => { if (session && session.carGeo) openMaps(session.carGeo.lat, session.carGeo.lon); });

  /* =====================================================================
     PARKING TIMER
     ===================================================================== */
  let pickedMin = null;
  $('btn-timer').addEventListener('click', () => {
    pickedMin = null; $('in-timer-min').value = '';
    document.querySelectorAll('#sheet-timer .chip').forEach(c => c.classList.remove('on'));
    openSheet('sheet-timer');
  });
  document.querySelectorAll('#sheet-timer .chip').forEach(c => c.addEventListener('click', () => {
    document.querySelectorAll('#sheet-timer .chip').forEach(x => x.classList.toggle('on', x === c));
    pickedMin = +c.dataset.min; $('in-timer-min').value = '';
  }));
  $('btn-timer-set').addEventListener('click', async () => {
    const typed = parseInt($('in-timer-min').value, 10);
    const min = typed > 0 ? typed : pickedMin;
    if (!min || !session) { toast('Pick a time first.'); return; }
    const endAt = now() + min * 60000;
    const remindAt = Math.max(now() + 30000, endAt - settings.remindMin * 60000);
    session.timer = { endAt, remindAt, reminded: false, expired: false };
    saveSession(true);
    closeSheet('sheet-timer');
    await scheduleReminders();
    toast(`Timer set. Reminder ${settings.remindMin} min before.`);
    render();
  });
  $('btn-timer-clear').addEventListener('click', () => {
    if (!session) return; session.timer = null; saveSession(true); cancelReminders(); render();
  });

  async function scheduleReminders() {
    const t = session.timer; if (!t) return;
    if (Native) {
      try {
        await Native.scheduleReminder({ id: 1, at: t.remindAt, title: 'Parking time almost up', body: `${settings.remindMin} minutes left on your parking.` });
        await Native.scheduleReminder({ id: 2, at: t.endAt, title: 'Parking time is up', body: 'Your parking timer has run out.' });
      } catch (e) { }
    } else if ('Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (e) { }
    }
  }
  function cancelReminders() {
    if (Native) { Native.cancelReminder({ id: 1 }).catch(() => { }); Native.cancelReminder({ id: 2 }).catch(() => { }); }
  }
  async function webNotify(title, body) {
    buzz([300, 150, 300]);
    toast(title + ' — ' + body, 8000);
    if (Native || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag: 'pf-timer' });
      else new Notification(title, { body });
    } catch (e) { }
  }
  function checkTimer() {
    const t = session && session.timer; if (!t) return;
    if (!t.reminded && now() >= t.remindAt) { t.reminded = true; saveSession(true); webNotify('Parking time almost up', `${settings.remindMin} minutes left.`); }
    if (!t.expired && now() >= t.endAt) { t.expired = true; saveSession(true); webNotify('Parking time is up', 'Your parking timer has run out.'); }
  }

  /* =====================================================================
     FIND MY CAR — arrow, distance, retrace
     ===================================================================== */
  const map = new TrailMap($('map'));
  $('btn-fit').addEventListener('click', () => map.refit());

  const retrace = { on: false, wps: [], target: -1 };
  $('btn-retrace').addEventListener('click', () => {
    if (!session) return;
    retrace.on = !retrace.on;
    $('btn-retrace').classList.toggle('on', retrace.on);
    if (retrace.on) {
      retrace.wps = PDR.simplify(session.points.map(p => ({ x: p.x, y: p.y })), 3);
      let best = 0, bd = Infinity;
      retrace.wps.forEach((p, i) => { const d = Math.hypot(p.x - session.x, p.y - session.y); if (d < bd) { bd = d; best = i; } });
      retrace.target = bd < 6 && best > 0 ? best - 1 : best;
      toast('Retrace: follow the arrow back along the way you came.');
    }
    render();
  });

  let arrowAngle = 0, arrived = false;
  function updateFind() {
    if (!session) { show('home'); return; }
    const x = session.x, y = session.y;
    const directDist = Math.hypot(x, y);
    let tx = 0, ty = 0, remain = directDist, wpNote = '';
    if (retrace.on && retrace.wps.length > 1) {
      let tgt = retrace.target;
      while (tgt > 0 && Math.hypot(retrace.wps[tgt].x - x, retrace.wps[tgt].y - y) < 4) tgt--;
      retrace.target = tgt;
      tx = retrace.wps[tgt].x; ty = retrace.wps[tgt].y;
      remain = Math.hypot(tx - x, ty - y);
      for (let i = tgt; i > 0; i--) remain += Math.hypot(retrace.wps[i].x - retrace.wps[i - 1].x, retrace.wps[i].y - retrace.wps[i - 1].y);
      wpNote = tgt > 0 ? `Waypoint ${tgt} of ${retrace.wps.length - 1} · then on to car` : 'Last stretch to the car';
    }
    const sigma = sigmaNow();
    const brg = PDR.bearing(x, y, tx, ty);
    const h = session.heading;
    const arrowEl = $('arrow');
    let target;
    if (directDist < ARRIVE_M) {
      arrowEl.className = 'arrow here'; target = arrowAngle; $('arrow-note').textContent = 'You\'re here';
    } else if (h != null) {
      arrowEl.className = 'arrow'; target = brg - h; $('arrow-note').textContent = '';
    } else {
      arrowEl.className = 'arrow north'; target = brg; $('arrow-note').textContent = 'No compass · north-up';
    }
    arrowAngle += PDR.wrap180(target - arrowAngle);       // shortest turn, no 359→0 spin
    arrowEl.style.transform = `rotate(${arrowAngle}deg)`;

    $('find-dist').textContent = directDist < ARRIVE_M ? 'Here!' : fmtDist(remain);
    let sub;
    if (directDist < ARRIVE_M) sub = 'Look around for your car.';
    else if (directDist < sigma) sub = `Within ±${fmtDist(sigma)} — start looking around.`;
    else sub = retrace.on ? wpNote : `${fmtDist(directDist)} straight-line · ±${fmtDist(sigma)}`;
    $('find-sub').textContent = sub;
    if (directDist < ARRIVE_M && !arrived) { arrived = true; buzz([80, 60, 80]); }
    if (directDist > ARRIVE_M * 2) arrived = false;

    const fl = floorNow();
    const lv = session.level ? ` (${session.level})` : '';
    $('find-floor').textContent = floorText(fl) + lv;

    const m = posMode();
    const pill = $('acc-pill');
    pill.className = 'pill ' + m;
    pill.textContent = (m === 'gps' ? 'GPS' : m === 'mixed' ? 'Mixed' : 'Steps') + ' ±' + fmtDist(sigma);
    $('btn-maps').hidden = !session.carGeo || !navigator.onLine;
    $('map-legend').textContent = map.gridStep ? `Grid ${fmtDist(map.gridStep)}` : '';

    map.set({
      points: session.points, me: { x, y, heading: h, sigma },
      waypoints: retrace.on ? retrace.wps : null, target: retrace.target
    });
  }

  /* =====================================================================
     RENDER
     ===================================================================== */
  let photoShownFor = null;
  function render() {
    const parked = !!session;
    $('home-empty').hidden = parked;
    $('home-parked').hidden = !parked;
    const pill = $('mode-pill');
    if (!parked) { pill.hidden = true; return; }

    $('parked-when').textContent = fmtDate(session.startedAt);
    const meta = [];
    if (session.level) meta.push('Level ' + session.level);
    if (session.bay) meta.push('Bay ' + session.bay);
    if (session.note) meta.push(session.note);
    $('parked-meta').textContent = meta.join(' · ');
    $('parked-meta').hidden = !meta.length;
    if (photoShownFor !== session.photoId) {
      photoShownFor = session.photoId;
      $('parked-photo').hidden = true;
      if (session.photoId) DB.get('photos', session.photoId).then(p => { if (p) { $('parked-photo').src = p.data; $('parked-photo').hidden = false; } });
    }
    const d = fmtDistParts(Math.hypot(session.x, session.y));
    $('st-dist').textContent = d.n; $('st-dist-u').textContent = d.u + ' away';
    $('st-steps').textContent = session.steps;
    const fl = floorNow();
    $('st-floor').textContent = fl > 0 ? '+' + fl : fl;

    const tl = $('tracking-line');
    if (session.tracking) {
      const left = session.autoStopAt - now();
      const src = tracker === NativeTracker ? 'works with screen off' : 'keep this app open';
      tl.innerHTML = `<span class="dot"></span> Tracking · ${src} · stops in ${Math.max(1, Math.round(left / 60000))} min`;
    } else tl.innerHTML = '<span class="dot off"></span> Not tracking — position frozen';
    $('btn-pause').textContent = session.tracking ? 'Stop tracking' : 'Resume tracking';

    const m = posMode();
    pill.hidden = !session.tracking;
    pill.className = 'pill ' + m;
    pill.textContent = m === 'gps' ? 'GPS' : m === 'mixed' ? 'Mixed' : 'Steps only';

    const t = session.timer;
    $('timer-card').hidden = !t;
    if (t) {
      const left = t.endAt - now();
      $('timer-left').textContent = fmtLeft(left);
      $('timer-card').classList.toggle('late', left < 0);
    }
    if (currentScreen === 'find') updateFind();
  }

  /* =====================================================================
     HISTORY
     ===================================================================== */
  async function renderHistory() {
    const ul = $('history-list');
    const all = ((await DB.all('history')) || []).sort((a, b) => b.startedAt - a.startedAt);
    ul.innerHTML = '';
    if (!all.length) { ul.innerHTML = '<li class="empty">No parkings saved yet.</li>'; return; }
    for (const r of all) {
      const li = document.createElement('li');
      const mins = Math.round((r.endedAt - r.startedAt) / 60000);
      const bits = [r.level && 'Level ' + r.level, r.bay && 'Bay ' + r.bay, r.note].filter(Boolean).join(' · ');
      li.innerHTML = `<div class="grow"><div class="t"></div><div class="s"></div><div class="s"></div></div>`;
      li.querySelector('.t').textContent = fmtDate(r.startedAt);
      li.querySelectorAll('.s')[0].textContent = bits || 'No notes';
      li.querySelectorAll('.s')[1].textContent = `${mins} min · ${r.steps} steps · walked ${fmtDist(r.dist)}`;
      if (r.photoId) DB.get('photos', r.photoId).then(p => { if (p) { const im = new Image(); im.src = p.data; im.alt = ''; li.prepend(im); } });
      if (r.carGeo) {
        const b = document.createElement('button'); b.className = 'chip'; b.textContent = 'Map';
        b.addEventListener('click', () => openMaps(r.carGeo.lat, r.carGeo.lon)); li.append(b);
      }
      const del = document.createElement('button'); del.className = 'chip'; del.textContent = '✕'; del.setAttribute('aria-label', 'Delete');
      del.addEventListener('click', async () => {
        if (!confirm('Delete this entry?')) return;
        if (r.photoId) await DB.del('photos', r.photoId);
        await DB.del('history', r.id); renderHistory();
      });
      li.append(del);
      ul.append(li);
    }
  }

  /* =====================================================================
     SETTINGS + CALIBRATION
     ===================================================================== */
  function renderSettings() {
    $('set-height').value = settings.heightCm;
    $('set-units').value = settings.units;
    $('set-theme').value = settings.theme;
    $('set-autostop').value = String(settings.autoStopMin);
    $('set-remind').value = String(settings.remindMin);
    $('step-len-line').textContent = `Step length: ${stepLength().toFixed(2)} m (${settings.stepLen ? 'calibrated' : 'from height'})`;
    $('app-version').textContent = APP_VERSION;
    $('app-platform').textContent = isNative ? 'Android app' : isStandalone ? 'Installed web app' : 'Browser';
    $('btn-install').hidden = isNative;
    $('btn-apk').hidden = isNative || isIOS;
  }
  $('set-height').addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    if (v >= 120 && v <= 220) { settings.heightCm = v; saveSettings(); pushStepLength(); }
    renderSettings();
  });
  $('set-units').addEventListener('change', e => { settings.units = e.target.value; saveSettings(); render(); });
  $('set-theme').addEventListener('change', e => { settings.theme = e.target.value; saveSettings(); applyTheme(); map.draw(); });
  $('set-autostop').addEventListener('change', e => { settings.autoStopMin = +e.target.value; saveSettings(); });
  $('set-remind').addEventListener('change', e => { settings.remindMin = +e.target.value; saveSettings(); });
  function pushStepLength() { if (Native && session && session.tracking) Native.setStepLength({ stepLength: stepLength() }).catch(() => { }); }

  const Calib = {
    on: false, det: null,
    onMotion(e) {
      const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
      if (Calib.det.feed(performance.now(), a.x, a.y, a.z)) $('calib-steps').textContent = Calib.det.count;
    },
    async start() {
      await requestMotion();
      this.det = new PDR.StepDetector(); this.on = true;
      $('calib-steps').textContent = '0';
      window.addEventListener('devicemotion', this.onMotion);
      $('btn-calib-go').textContent = 'Stop';
      $('calib-dist-wrap').hidden = true; $('btn-calib-save').hidden = true;
    },
    stop() {
      if (!this.on) return;
      this.on = false;
      window.removeEventListener('devicemotion', this.onMotion);
      $('btn-calib-go').textContent = 'Start again';
      if (this.det && this.det.count >= 8) { $('calib-dist-wrap').hidden = false; $('btn-calib-save').hidden = false; $('in-calib-dist').focus(); }
      else if (this.det) toast('Walk at least 10 steps, then stop.');
    }
  };
  $('btn-calibrate').addEventListener('click', () => {
    $('calib-steps').textContent = '0'; $('btn-calib-go').textContent = 'Start';
    $('calib-dist-wrap').hidden = true; $('btn-calib-save').hidden = true; $('in-calib-dist').value = '';
    openSheet('sheet-calib');
  });
  $('btn-calib-go').addEventListener('click', () => Calib.on ? Calib.stop() : Calib.start());
  $('btn-calib-save').addEventListener('click', () => {
    let d = parseFloat($('in-calib-dist').value);
    if (!(d > 0) || !Calib.det || !Calib.det.count) { toast('Enter the distance you walked.'); return; }
    const len = d / Calib.det.count;
    if (len < 0.3 || len > 1.3) { toast(`That gives ${len.toFixed(2)} m per step, which looks wrong. Try again.`); return; }
    settings.stepLen = Math.round(len * 1000) / 1000; saveSettings(); pushStepLength();
    closeSheet('sheet-calib'); renderSettings(); toast(`Step length saved: ${settings.stepLen.toFixed(2)} m`);
  });
  $('btn-calib-reset').addEventListener('click', () => {
    settings.stepLen = null; saveSettings(); pushStepLength(); renderSettings();
    toast(`Using ${stepLength().toFixed(2)} m from your height.`);
  });

  $('btn-perms').addEventListener('click', () => { $('perm-result').textContent = ''; openSheet('sheet-perms'); });
  $('btn-perm-allow').addEventListener('click', async () => {
    const m = await requestMotion();
    const loc = await requestLocationOnce();
    const lines = [
      'Motion: ' + (m.motion ? '✓' : '✗ blocked'),
      'Compass: ' + (m.orientation ? '✓' : '✗ blocked'),
      'Location: ' + (loc ? `✓ (±${Math.round(loc.coords.accuracy)} m now)` : '✗ not available here or blocked')
    ];
    if (m.native) lines.push('Background steps: ' + (m.native.activity === 'granted' ? '✓' : 'using accelerometer'),
      'Notifications: ' + (m.native.notifications === 'granted' ? '✓' : '✗'));
    $('perm-result').innerHTML = lines.join('<br>');
  });

  /* =====================================================================
     INSTALL + UPDATE
     ===================================================================== */
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; });
  $('btn-install').addEventListener('click', async () => {
    if (isStandalone) { toast('Already installed. 👍'); return; }
    if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; return; }
    if (isIOS) toast('In Safari tap Share ⬆, then "Add to Home Screen".', 7000);
    else toast('Use your browser menu → "Install app" or "Add to Home screen". Or get the APK below.', 7000);
  });
  $('btn-apk').addEventListener('click', () => { window.open(APK_URL, '_blank'); });

  function newer(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
    return false;
  }
  $('btn-update').addEventListener('click', async () => {
    const st = $('update-status');
    if (!navigator.onLine) { st.textContent = 'You\'re offline. Connect to check for updates.'; return; }
    st.textContent = 'Checking…';
    try {
      const r = await fetch(PAGES_URL + 'version.json?t=' + now(), { cache: 'no-store' });
      const v = await r.json();
      if (!newer(v.version, APP_VERSION)) {
        st.textContent = `You're up to date (${APP_VERSION}).`;
        if (!isNative) navigator.serviceWorker?.getRegistration().then(reg => reg && reg.update());
        return;
      }
      if (isNative) {
        st.textContent = `Version ${v.version} available. Downloading APK — open it when done to install.`;
        location.href = APK_URL;
      } else {
        st.textContent = `Updating to ${v.version}…`;
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) {
          await reg.update();
          const w = reg.waiting || reg.installing;
          if (w) w.postMessage('SKIP_WAITING');
        }
        setTimeout(() => location.reload(), 1200);
      }
    } catch (e) { st.textContent = 'Couldn\'t reach the update server. Try again later.'; }
  });

  if ('serviceWorker' in navigator && !isNative && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { });
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }

  /* =====================================================================
     MAIN LOOP + LIFECYCLE
     ===================================================================== */
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = now(); saveSession(true); }
    else {
      if (session && session.tracking && tracker === JsTracker && hiddenAt && now() - hiddenAt > 5000) {
        toast('Steps taken while the app was in the background were missed. Keep it open while walking.', 6000);
      }
      if (tracker === NativeTracker) NativeTracker.sync();
      if (session && session.tracking) Gps.start();
      updateWakeLock(); render();
    }
  });
  window.addEventListener('pagehide', () => saveSession(true));

  setInterval(() => {
    if (!session) return;
    if (session.tracking && now() > session.autoStopAt) stopTracking('Tracking stopped automatically (time limit).');
    checkTimer();
    if (currentScreen !== 'find') render();
  }, 1000);

  (function findLoop() {
    if (currentScreen === 'find' && document.visibilityState === 'visible') updateFind();
    setTimeout(() => requestAnimationFrame(findLoop), 100);
  })();

  /* resume after reload / app restart */
  (async function boot() {
    if (isIOS) $('hold-hint').textContent = 'Keep Park Finder open and the phone in your hand, top pointing where you walk.';
    if (session) {
      if (session.tracking) {
        if (now() > session.autoStopAt) { session.tracking = false; saveSession(true); }
        else {
          Gps.start();
          if (tracker === NativeTracker) {
            // service may still be running from before the app was closed
            let st = null;
            try { st = await Native.getState({ since: 0, peek: true }); } catch (e) { }
            if (st && st.running) { NativeTracker.running = true; NativeTracker._startPoll(); }
            else await NativeTracker.start();
          } else {
            JsTracker.start();   // iOS may need a tap to re-grant; Find/Resume will ask
          }
        }
      }
    }
    render();
    renderSettings();
  })();
})();
