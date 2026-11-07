/* =====================================================================
   Park Finder — pdr.js
   Pedestrian Dead Reckoning (PDR) engine used by the PWA / iPhone build
   and for step-length calibration. The Android APK runs the same ideas
   natively (see native/ParkTrackerService.java) so it keeps working with
   the screen off.

   Coordinate frame: local metres, car = (0,0), +x = east, +y = north.
   Headings are compass degrees: 0 = north, 90 = east, clockwise.
   ===================================================================== */
(function (root) {
  'use strict';

  const G = 9.80665;
  const DEG = Math.PI / 180;

  /** Wrap any angle to the range -180..+180 degrees. */
  function wrap180(a) {
    a = ((a + 180) % 360 + 360) % 360 - 180;
    return a === -180 ? 180 : a;
  }
  /** Wrap any angle to 0..360 degrees. */
  function wrap360(a) { return ((a % 360) + 360) % 360; }

  /* -------------------------------------------------------------------
     STEP DETECTOR
     Input: accelerationIncludingGravity (m/s²) at whatever rate the
     browser gives (usually 50–60 Hz).

     1. Take the magnitude |a| so phone orientation doesn't matter.
     2. Remove gravity with a slow moving average (high-pass).
     3. Smooth with a low-pass filter (~3 Hz) to kill hand jitter.
     4. A step = a local peak that
          - is above an ADAPTIVE threshold (follows how hard you walk),
          - comes at least MIN_STEP_MS after the previous step,
          - was preceded by a valley (stops one bounce counting twice).

     TUNING KNOBS (change these if it over/under-counts):
       LP_HZ         lower = smoother, but may merge fast steps
       MIN_STEP_MS   raise if it double-counts, lower for fast walkers
       MIN_THRESH    raise if it counts steps while standing still
       THRESH_RATIO  fraction of the typical peak height used as threshold
     ------------------------------------------------------------------- */
  class StepDetector {
    constructor(opts = {}) {
      this.LP_HZ = opts.lpHz ?? 3.0;
      this.GRAVITY_TAU = opts.gravityTau ?? 1.0;  // seconds
      this.MIN_STEP_MS = opts.minStepMs ?? 280;
      this.MAX_STEP_MS = opts.maxStepMs ?? 2000;
      this.MIN_THRESH = opts.minThresh ?? 0.7;    // m/s²
      this.MAX_THRESH = opts.maxThresh ?? 3.5;
      this.THRESH_RATIO = opts.threshRatio ?? 0.45;
      this.reset();
    }
    reset() {
      this.lastT = null;
      this.grav = null;          // slow average of |a|
      this.lp = 0;               // smoothed dynamic signal
      this.prev = 0; this.prev2 = 0;
      this.lastStepT = -1e9;
      this.valleySeen = true;
      this.valley = 0;
      this.avgPeak = 1.6;        // running estimate of a typical step peak
      this.count = 0;
    }
    get threshold() {
      return Math.min(this.MAX_THRESH, Math.max(this.MIN_THRESH, this.THRESH_RATIO * this.avgPeak));
    }
    /**
     * Feed one accelerometer sample.
     * @param {number} tMs timestamp in ms
     * @returns {null|{amp:number}} a step event or null
     */
    feed(tMs, ax, ay, az) {
      const mag = Math.sqrt(ax * ax + ay * ay + az * az);
      if (!isFinite(mag)) return null;
      if (this.lastT === null) { this.lastT = tMs; this.grav = mag || G; return null; }
      let dt = (tMs - this.lastT) / 1000;
      this.lastT = tMs;
      if (dt <= 0 || dt > 0.5) dt = 0.02;   // gap or clock glitch: assume 50 Hz

      // (2) gravity removal: exponential average with time constant GRAVITY_TAU
      const kg = dt / (this.GRAVITY_TAU + dt);
      this.grav += kg * (mag - this.grav);
      const dyn = mag - this.grav;

      // (3) low-pass: first-order RC filter at LP_HZ
      const rc = 1 / (2 * Math.PI * this.LP_HZ);
      const kl = dt / (rc + dt);
      this.prev2 = this.prev;
      this.prev = this.lp;
      this.lp += kl * (dyn - this.lp);

      const th = this.threshold;
      if (this.lp < -0.3 * th) { this.valleySeen = true; this.valley = Math.min(this.valley, this.lp); }

      // (4) peak = previous sample higher than both neighbours
      const isPeak = this.prev > this.prev2 && this.prev >= this.lp;
      if (isPeak && this.prev > th && this.valleySeen && (tMs - this.lastStepT) >= this.MIN_STEP_MS) {
        const amp = this.prev - this.valley;
        // adapt: typical peak follows real peaks (ignore crazy spikes)
        const p = Math.min(this.prev, this.avgPeak * 3);
        this.avgPeak += 0.15 * (p - this.avgPeak);
        this.lastStepT = tMs;
        this.valleySeen = false;
        this.valley = 0;
        this.count++;
        return { amp };
      }
      // after a long pause, slowly forget how hard we were walking
      if (tMs - this.lastStepT > this.MAX_STEP_MS) this.avgPeak += 0.002 * (1.6 - this.avgPeak);
      return null;
    }
  }

  /* -------------------------------------------------------------------
     HEADING FILTER (complementary filter: gyro + compass)

     - The GYRO is smooth and ignores magnets, but slowly drifts.
     - The COMPASS doesn't drift, but jumps near cars, rebar and pillars.

     Each update we first rotate the heading by the gyro's turn rate,
     then nudge it a little towards the compass. If the compass suddenly
     disagrees by more than GATE_DEG (typical of magnetic interference),
     we trust it much less until it agrees again.

     Turn rate: the gyro gives rotation about the phone's own x/y/z axes.
     Projecting that onto the gravity direction gives the turn rate about
     the vertical, whatever angle you hold the phone at.

     Browsers disagree on the sign of these readings (iOS vs Android), so
     the filter LEARNS the sign by comparing gyro turns with compass turns.

     TUNING KNOBS:
       COMPASS_GAIN   per-second pull towards compass when it agrees
       GATED_GAIN     per-second pull when compass looks disturbed
       GATE_DEG       disagreement treated as magnetic interference
     ------------------------------------------------------------------- */
  class HeadingFilter {
    constructor(opts = {}) {
      this.COMPASS_GAIN = opts.compassGain ?? 2.0;   // 1/s
      this.GATED_GAIN = opts.gatedGain ?? 0.06;      // 1/s
      this.GATE_DEG = opts.gateDeg ?? 30;
      this.NO_GYRO_GAIN = opts.noGyroGain ?? 6.0;    // 1/s smoothing only
      this.heading = null;
      this.lastT = null;
      this.lastCompass = null; this.lastCompassT = null;
      this.signEvidence = 0;     // >0 → +1, <0 → -1
      this.signSamples = 0;
      this.gyroSign = 0;         // 0 = not learned yet
      this.disturbed = false;
      this.disturbedFor = 0;     // seconds
    }
    get gyroReady() { return this.gyroSign !== 0; }

    /** Turn rate about vertical (deg/s) from rotationRate + gravity vector. */
    static yawRate(rot, grav) {
      if (!rot || !grav) return null;
      const gx = grav.x, gy = grav.y, gz = grav.z;
      const n = Math.hypot(gx, gy, gz);
      if (!n) return null;
      // rotationRate: beta = about x, gamma = about y, alpha = about z (deg/s)
      const wx = rot.beta || 0, wy = rot.gamma || 0, wz = rot.alpha || 0;
      return (wx * gx + wy * gy + wz * gz) / n;
    }

    /**
     * @param {number} tMs
     * @param {number|null} compassDeg absolute heading (0=N), or null
     * @param {number|null} yawRateDps turn rate about vertical, or null
     */
    update(tMs, compassDeg, yawRateDps) {
      // Browsers deliver gyro (devicemotion) and compass (deviceorientation)
      // as separate events, so each keeps its own clock.

      // ---- gyro: rotate the heading by the measured turn ----
      if (yawRateDps != null) {
        const dtg = this.lastGyroT == null ? 0 : (tMs - this.lastGyroT) / 1000;
        this.lastGyroT = tMs;
        this.lastYaw = yawRateDps; this.lastYawT = tMs;
        if (this.heading !== null && this.gyroReady && dtg > 0 && dtg < 0.5) {
          this.heading = wrap360(this.heading + this.gyroSign * yawRateDps * dtg);
        }
      }
      if (compassDeg == null) return this.heading;

      // ---- compass ----
      const dt = this.lastCompassT == null ? 0 : (tMs - this.lastCompassT) / 1000;
      const yaw = (this.lastYawT != null && tMs - this.lastYawT < 200) ? this.lastYaw : null;

      // learn gyro sign from fast turns (compass rate vs gyro rate)
      if (yaw != null && this.lastCompass != null && dt > 0.005 && dt < 0.5) {
        const cRate = wrap180(compassDeg - this.lastCompass) / dt;
        if (Math.abs(cRate) > 40 && Math.abs(cRate) < 720 && Math.abs(yaw) > 20) {
          this.signEvidence += Math.sign(cRate * yaw);
          this.signSamples++;
          if (this.signSamples >= 15 && Math.abs(this.signEvidence) >= 9) {
            this.gyroSign = Math.sign(this.signEvidence);
          }
        }
      }
      this.lastCompass = compassDeg; this.lastCompassT = tMs;

      if (this.heading === null) { this.heading = wrap360(compassDeg); return this.heading; }

      const useGyro = this.gyroReady && yaw != null;
      if (dt > 0 && dt < 1) {
        const diff = wrap180(compassDeg - this.heading);
        let gain;
        if (!useGyro) {
          gain = this.NO_GYRO_GAIN;
          this.disturbed = false;
        } else if (Math.abs(diff) > this.GATE_DEG) {
          // compass disagrees with gyro → probably magnetic interference.
          // If it keeps disagreeing for 8 s, accept it was really the gyro drifting.
          this.disturbedFor += dt;
          this.disturbed = this.disturbedFor < 8;
          gain = this.disturbed ? this.GATED_GAIN : this.COMPASS_GAIN * 0.5;
        } else {
          this.disturbedFor = Math.max(0, this.disturbedFor - dt * 2);
          this.disturbed = false;
          gain = this.COMPASS_GAIN;
        }
        const k = Math.min(1, gain * dt);
        this.heading = wrap360(this.heading + k * diff);
      }
      return this.heading;
    }
  }

  /* -------------------------------------------------------------------
     GEO HELPERS (equirectangular — accurate to cm over a few km)
     ------------------------------------------------------------------- */
  const R_EARTH = 6371008.8;
  function geoToLocal(lat0, lon0, lat, lon) {
    const x = (lon - lon0) * DEG * R_EARTH * Math.cos(lat0 * DEG);
    const y = (lat - lat0) * DEG * R_EARTH;
    return { x, y };
  }
  function localToGeo(lat0, lon0, x, y) {
    const lat = lat0 + (y / R_EARTH) / DEG;
    const lon = lon0 + (x / (R_EARTH * Math.cos(lat0 * DEG))) / DEG;
    return { lat, lon };
  }
  /** Compass bearing (deg) from (x1,y1) to (x2,y2). */
  function bearing(x1, y1, x2, y2) { return wrap360(Math.atan2(x2 - x1, y2 - y1) / DEG); }

  /** Douglas–Peucker line simplification on [{x,y}] with tolerance (m). */
  function simplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const A = pts[a], B = pts[b];
      const dx = B.x - A.x, dy = B.y - A.y;
      const L = Math.hypot(dx, dy) || 1e-9;
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dy * (pts[i].x - A.x) - dx * (pts[i].y - A.y)) / L;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  /* -------------------------------------------------------------------
     POSITION ERROR MODEL
     Dead reckoning error grows with distance walked. A good rule of
     thumb for hand-held PDR is ~5–8 % of distance. We use:
        sigma = sqrt(base² + (DRIFT_PER_M × distance since last fix)²)
     ------------------------------------------------------------------- */
  const DRIFT_PER_M = 0.07;
  function pdrSigma(baseSigma, distSinceFix) {
    return Math.sqrt(baseSigma * baseSigma + Math.pow(DRIFT_PER_M * distSinceFix, 2));
  }

  /**
   * Blend a dead-reckoned position with a GPS fix (1-D Kalman per axis).
   * Returns the corrected position and its new sigma.
   */
  function fuseFix(x, y, sigmaP, gx, gy, sigmaG) {
    const vp = sigmaP * sigmaP, vg = sigmaG * sigmaG;
    const w = vp / (vp + vg);
    return {
      x: x + w * (gx - x),
      y: y + w * (gy - y),
      sigma: Math.sqrt((vp * vg) / (vp + vg)),
      weight: w
    };
  }

  /**
   * GPS + steps fusion that can't "lock up".
   * Old bug: each fix shrank the confidence radius, so after a minute it was
   * ~0 m and GPS was ignored completely while the step trail drifted.
   * Now:
   *  - the radius never drops below MIN_SIGMA (or half the GPS accuracy),
   *  - if steps and GPS disagree by much more than both errors allow,
   *    the steps are wrong (drift, magnets) → jump most of the way to GPS.
   */
  const MIN_SIGMA = 3;
  function robustFuse(x, y, sigmaP, gx, gy, gpsAcc) {
    const sp = Math.max(MIN_SIGMA, sigmaP);
    const sg = Math.max(2, gpsAcc);
    const f = fuseFix(x, y, sp, gx, gy, sg);
    const gap = Math.hypot(gx - x, gy - y);
    if (gap > 3 * Math.hypot(sp, sg)) {
      f.x = x + 0.8 * (gx - x); f.y = y + 0.8 * (gy - y); f.weight = 0.8;
    }
    f.sigma = Math.max(MIN_SIGMA, sg * 0.5, f.sigma);
    return f;
  }

  /**
   * Retrace: which waypoint to head for next.
   * wps[0] is the car, wps[last] is where you started retracing.
   *  1. Move on when you reach the target, or once you're already closer to
   *     the next waypoint than the target is (you've walked past it).
   *  2. SHORTCUT: for every earlier point on the trail (including the car),
   *     compare  STRAIGHT_PENALTY × straight-line distance to it  +  trail
   *     from there to the car. A straight line might cross a wall, so it is
   *     counted 5× — but if you walked a big loop and the car is close, going
   *     straight still wins and you aren't sent round the loop again.
   */
  const STRAIGHT_PENALTY = 5;
  function retraceTarget(wps, tgt, x, y, snap) {
    const d = i => Math.hypot(wps[i].x - x, wps[i].y - y);
    while (tgt > 0) {
      const seg = Math.hypot(wps[tgt].x - wps[tgt - 1].x, wps[tgt].y - wps[tgt - 1].y);
      if (d(tgt) < snap || d(tgt - 1) < seg) tgt--; else break;
    }
    // trail length from each waypoint back to the car
    const cum = [0];
    for (let i = 1; i <= tgt; i++) cum[i] = cum[i - 1] + Math.hypot(wps[i].x - wps[i - 1].x, wps[i].y - wps[i - 1].y);
    // the leg to the current target is along the trail you walked → no penalty
    let best = tgt, bestCost = d(tgt) + cum[tgt];
    for (let i = 0; i < tgt; i++) {
      const c = STRAIGHT_PENALTY * d(i) + cum[i];
      if (c < bestCost) { bestCost = c; best = i; }
    }
    return best;
  }

  /** Default step length from body height (cm) — common 0.415 × height rule. */
  function stepFromHeight(cm) { return Math.max(0.35, Math.min(1.1, (cm / 100) * 0.415)); }

  root.PDR = {
    StepDetector, HeadingFilter, wrap180, wrap360,
    geoToLocal, localToGeo, bearing, simplify,
    pdrSigma, fuseFix, robustFuse, retraceTarget, stepFromHeight, DRIFT_PER_M, MIN_SIGMA
  };
})(typeof window !== 'undefined' ? window : globalThis);
