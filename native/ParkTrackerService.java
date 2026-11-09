package com.m9r1u5.parkfinder;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Bundle;
import android.os.PowerManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.util.Locale;

/**
 * Foreground service that keeps counting steps and heading with the screen off.
 *
 * Sensors used (whichever the phone has):
 *  - TYPE_STEP_DETECTOR      hardware step events (best, low power) — needs ACTIVITY_RECOGNITION on Android 10+
 *  - TYPE_ACCELEROMETER      fallback step detection (same algorithm as pdr.js)
 *  - TYPE_ROTATION_VECTOR    absolute heading (compass + gyro fused by Android)
 *  - TYPE_GAME_ROTATION_VECTOR  gyro-only heading: smooth and immune to magnets, but no north
 *  - TYPE_MAGNETIC_FIELD     to spot magnetic interference (field strength outside 25–65 µT)
 *  - TYPE_PRESSURE           barometer → floor changes
 */
public class ParkTrackerService extends Service implements SensorEventListener {

    public static final String ACTION_START = "com.m9r1u5.parkfinder.START";
    public static final String ACTION_STOP = "com.m9r1u5.parkfinder.STOP";
    private static final String CHANNEL = "tracking";
    private static final int NOTIF_ID = 42;

    private SensorManager sm;
    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final TrackerState st = TrackerState.get();
    private boolean useHardwareSteps = false;
    private int lastNotifSteps = -1;

    /* ---------- heading fusion ---------- */
    // TUNING: how fast the gyro heading is pulled toward the compass (per sensor event, ~50 Hz)
    private static final double OFFSET_GAIN = 0.004;          // ~5 s to follow the compass
    private static final double OFFSET_GAIN_DISTURBED = 0.0008;
    private static final double DISTURB_DEG = 30;        // compass vs gyro disagreement treated as interference
    private static final double MAG_MIN_UT = 25, MAG_MAX_UT = 65;  // normal Earth field strength
    private double absHeading = -1, gameHeading = -1, offset = Double.NaN;
    private double magStrength = 45;
    private double magBase = -1;                              // usual field strength here
    private static final double MAG_JUMP_UT = 6;              // this much off usual = steel/cars nearby
    private boolean hasGame = false;
    private final float[] rot = new float[9];

    /* ---------- accelerometer step detector (mirror of pdr.js) ---------- */
    // TUNING: see pdr.js for what each knob does
    private static final double LP_HZ = 3.0, GRAVITY_TAU = 1.0;
    private static final long MIN_STEP_MS = 280, MAX_STEP_MS = 2000;
    private static final double MIN_THRESH = 0.7, MAX_THRESH = 3.5, THRESH_RATIO = 0.45;
    private long accLastT = -1, lastStepT = -100000;
    private double grav = 9.81, lp = 0, prev = 0, prev2 = 0, valley = 0, avgPeak = 1.6;
    private boolean valleySeen = true;

    /* ---------- barometer floors ---------- */
    // TUNING: FLOOR_M = height of one parkade level. DRIFT_HPA_PER_BIN = slower changes than this are weather, not stairs.
    private static final double FLOOR_M = 3.0, HYST_M = 0.6;
    private static final long BIN_MS = 10000;
    private static final double DRIFT_HPA_PER_BIN = 0.005;
    private double p0 = Double.NaN, pSmooth = Double.NaN;
    private long binStart = 0; private double binSum = 0; private int binN = 0; private double lastBin = Double.NaN;

    /* ---------- GPS (in the service so it keeps going with the screen off) ---------- */
    // TUNING: a fix this good means you're outdoors → slopes/hills are NOT parkade levels
    private static final float OUTDOOR_ACC_M = 20f;
    private static final long OUTDOOR_HOLD_MS = 15000;
    private LocationManager lm;
    private volatile long lastGoodFixMs = 0;
    private double altOffset = 0;     // terrain height absorbed while outdoors
    private final LocationListener locListener = new LocationListener() {
        @Override public void onLocationChanged(Location l) {
            long now = System.currentTimeMillis();
            if (l.hasAccuracy() && l.getAccuracy() <= OUTDOOR_ACC_M) lastGoodFixMs = now;
            synchronized (st) {
                st.fixLat = l.getLatitude(); st.fixLon = l.getLongitude();
                st.fixAcc = l.hasAccuracy() ? l.getAccuracy() : 999; st.fixTime = now;
            }
        }
        @Override public void onStatusChanged(String p, int s, Bundle b) { }
        @Override public void onProviderEnabled(String p) { }
        @Override public void onProviderDisabled(String p) { }
    };

    private boolean hasLocationPerm() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void startGps() {
        if (!hasLocationPerm()) return;
        try {
            lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            lm.removeUpdates(locListener);
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER))
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, locListener, Looper.getMainLooper());
        } catch (Exception ignored) { }
    }

    private void stopGps() {
        try { if (lm != null) lm.removeUpdates(locListener); } catch (Exception ignored) { }
    }

    private final Runnable autoStop = () -> stopTracking();

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopTracking();
            return START_NOT_STICKY;
        }
        startForegroundCompat(buildNotification("Starting…"));

        double stepLen = intent.getDoubleExtra("stepLength", 0.7);
        long autoStopMs = intent.getLongExtra("autoStopMs", 3L * 3600 * 1000);
        st.reset(intent.getDoubleExtra("x", 0), intent.getDoubleExtra("y", 0),
                intent.getIntExtra("steps", 0), intent.getDoubleExtra("dist", 0),
                intent.getDoubleExtra("heading", -1), stepLen);
        st.addPoint();
        absHeading = gameHeading = -1; offset = Double.NaN;
        p0 = pSmooth = lastBin = Double.NaN; binN = 0; binSum = 0;
        accLastT = -1; lp = prev = prev2 = 0; avgPeak = 1.6; valleySeen = true;
        resetCleaner(); seg = -1; inPocket = false; anchorPending = false; headingCorr = 0; magBase = -1;

        registerSensors();
        lastGoodFixMs = 0; altOffset = 0;
        startGps();

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ParkFinder:tracking");
        wakeLock.acquire(autoStopMs + 60000);

        handler.removeCallbacks(autoStop);
        handler.postDelayed(autoStop, autoStopMs);
        st.running = true;
        updateNotification(true);
        return START_NOT_STICKY;
    }

    private void registerSensors() {
        sm = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        sm.unregisterListener(this);

        Sensor stepDet = sm.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR);
        boolean actOk = Build.VERSION.SDK_INT < 29 ||
                ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
        useHardwareSteps = stepDet != null && actOk;
        if (useHardwareSteps) {
            sm.registerListener(this, stepDet, SensorManager.SENSOR_DELAY_FASTEST);
            st.stepSource = "hardware";
        } else {
            Sensor acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            if (acc != null) sm.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME);
            st.stepSource = acc != null ? "accelerometer" : "none";
        }

        Sensor rv = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        Sensor game = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        Sensor mag = sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
        if (rv != null) sm.registerListener(this, rv, SensorManager.SENSOR_DELAY_GAME);
        hasGame = game != null;
        if (hasGame) sm.registerListener(this, game, SensorManager.SENSOR_DELAY_GAME);
        if (mag != null) sm.registerListener(this, mag, SensorManager.SENSOR_DELAY_UI);

        Sensor prox = sm.getDefaultSensor(Sensor.TYPE_PROXIMITY);
        if (prox != null) { proxMax = prox.getMaximumRange(); sm.registerListener(this, prox, SensorManager.SENSOR_DELAY_NORMAL); }

        Sensor baro = sm.getDefaultSensor(Sensor.TYPE_PRESSURE);
        st.hasBaro = baro != null;
        if (baro != null) sm.registerListener(this, baro, SensorManager.SENSOR_DELAY_NORMAL);
    }

    private void stopTracking() {
        handler.removeCallbacks(autoStop);
        stopGps();
        if (sm != null) sm.unregisterListener(this);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        st.running = false;
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
        stopSelf();
    }

    @Override public void onDestroy() {
        handler.removeCallbacks(autoStop);
        stopGps();
        if (sm != null) sm.unregisterListener(this);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        st.running = false;
        super.onDestroy();
    }

    /* ================= sensors ================= */
    @Override
    public void onSensorChanged(SensorEvent e) {
        switch (e.sensor.getType()) {
            case Sensor.TYPE_STEP_DETECTOR:
                onStep();
                break;
            case Sensor.TYPE_ACCELEROMETER:
                feedAccel(e.timestamp / 1_000_000L, e.values[0], e.values[1], e.values[2]);
                break;
            case Sensor.TYPE_ROTATION_VECTOR:
                absHeading = forwardHeading(e.values);
                if (!hasGame) setHeading(absHeading);
                else fuse();
                break;
            case Sensor.TYPE_GAME_ROTATION_VECTOR:
                gameHeading = forwardHeading(e.values);
                fuse();
                break;
            case Sensor.TYPE_MAGNETIC_FIELD:
                magStrength = Math.sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]);
                break;
            case Sensor.TYPE_PROXIMITY: {
                boolean near = e.values[0] < Math.min(3f, proxMax * 0.5f);
                long now = android.os.SystemClock.elapsedRealtime();
                if (near && !inPocket) { inPocket = true; anchorPending = true; anchorAt = now + 1000; }
                else if (!near && inPocket) { inPocket = false; anchorPending = false; headingCorr = 0; }
                break;
            }
            case Sensor.TYPE_PRESSURE:
                onPressure(e.values[0]);
                break;
        }
    }
    @Override public void onAccuracyChanged(Sensor s, int a) { }

    /**
     * Horizontal direction the phone points in, from a rotation vector.
     * Adds the top edge and the back face (both projected flat), so it works
     * whether the phone is held flat or upright.
     */
    private double forwardHeading(float[] v) {
        SensorManager.getRotationMatrixFromVector(rot, v);
        // device→world matrix: world X = east, Y = north, Z = up
        double topX = rot[1], topY = rot[4];          // device +Y axis
        double backX = -rot[2], backY = -rot[5];      // device -Z axis
        double vx = topX + backX, vy = topY + backY;
        if (Math.hypot(vx, vy) < 0.15) return -1;     // pointing straight up/down
        double h = Math.toDegrees(Math.atan2(vx, vy));
        return (h + 360) % 360;
    }

    /** Gyro heading + slowly-learned offset to true north from the compass. */
    private void fuse() {
        if (gameHeading < 0) return;
        if (absHeading >= 0) {
            double target = wrap180(absHeading - gameHeading);
            if (Double.isNaN(offset)) offset = target;
            else {
                double diff = wrap180(target - offset);
                boolean magOdd = magStrength < MAG_MIN_UT || magStrength > MAG_MAX_UT
                        || (magBase > 0 && Math.abs(magStrength - magBase) > MAG_JUMP_UT);
                if (!magOdd) magBase = magBase < 0 ? magStrength : magBase + 0.002 * (magStrength - magBase);
                boolean disturbed = magOdd || Math.abs(diff) > DISTURB_DEG;
                offset = wrap180(offset + (disturbed ? OFFSET_GAIN_DISTURBED : OFFSET_GAIN) * diff);
            }
        }
        if (!Double.isNaN(offset)) setHeading((gameHeading + offset + 360) % 360);
    }

    private void setHeading(double h) { if (h >= 0) synchronized (st) { st.heading = h; } }

    private static double wrap180(double a) { a = ((a + 180) % 360 + 360) % 360 - 180; return a; }

    /* ---------- step cleaner (same as StepCleaner in pdr.js — see comments there) ---------- */
    // TUNING: MIN_BOUT steps in a steady rhythm before steps count; WINDOW = median of last N headings
    private static final int MIN_BOUT = 4, WINDOW = 5;
    private static final long MAX_GAP_MS = 1300;
    private static final double RHYTHM = 0.35;
    private static final double TURN_DEG = 25;     // smaller direction changes = wobble, keep the line straight
    private double seg = -1;                        // direction of the current straight line

    /* ---------- pocket: phone's pointing direction ≠ walking direction ---------- */
    // When the proximity sensor says "covered" (pocket/bag) we keep walking in the
    // direction we had just before, and only follow how the heading CHANGES from there.
    private float proxMax = 5f;
    private boolean inPocket = false, anchorPending = false;
    private long anchorAt = 0;
    private double headingCorr = 0;
    private long cLastT = -1_000_000_000L;
    private double cadence = -1;
    private boolean inBout = false;
    private final java.util.ArrayList<Double> pending = new java.util.ArrayList<>();
    private final java.util.ArrayDeque<Double> recent = new java.util.ArrayDeque<>();

    private void resetCleaner() { pending.clear(); recent.clear(); inBout = false; cadence = -1; }

    private double segmentLock(double m) {
        if (m < 0) return seg;
        if (seg < 0 || Math.abs(wrap180(m - seg)) > TURN_DEG) seg = m;
        return seg;
    }

    private static double circMedian(java.util.Collection<Double> hs) {
        double best = -1, bestSum = Double.MAX_VALUE;
        for (double a : hs) {
            double sum = 0;
            for (double b : hs) sum += Math.abs(wrap180(a - b));
            if (sum < bestSum) { bestSum = sum; best = a; }
        }
        return best;
    }

    private void onStep() {
        long t = android.os.SystemClock.elapsedRealtime();
        double h;
        synchronized (st) { h = st.heading; }
        if (inPocket && h >= 0) {
            if (anchorPending) {
                if (t >= anchorAt && seg >= 0) { headingCorr = wrap180(seg - h); anchorPending = false; }
                else h = seg;                       // phone still settling in the pocket: hold direction
            }
            if (!anchorPending && h >= 0) h = (h + headingCorr + 360) % 360;
        }
        long gap = t - cLastT;
        cLastT = t;
        if (gap > MAX_GAP_MS) { resetCleaner(); }
        else if (cadence > 0 && Math.abs(gap - cadence) > RHYTHM * cadence) {
            if (!inBout) resetCleaner();
        } else {
            cadence = cadence < 0 ? gap : cadence + 0.3 * (gap - cadence);
        }
        if (gap <= MAX_GAP_MS && cadence < 0 && !pending.isEmpty()) cadence = gap;

        if (h >= 0) { recent.addLast(h); if (recent.size() > WINDOW) recent.removeFirst(); }
        double smooth = recent.isEmpty() ? -1 : segmentLock(circMedian(recent));
        if (inBout) {
            st.step(h < 0 ? -1 : smooth);
        } else {
            pending.add(h);
            if (pending.size() < MIN_BOUT) return;
            inBout = true;
            for (double p : pending) st.step(p < 0 ? -1 : smooth);
            pending.clear();
        }
        if (st.steps - lastNotifSteps >= 10) updateNotification(false);
    }

    private void feedAccel(long tMs, float ax, float ay, float az) {
        double mag = Math.sqrt(ax * ax + ay * ay + az * az);
        if (accLastT < 0) { accLastT = tMs; grav = mag; return; }
        double dt = (tMs - accLastT) / 1000.0;
        accLastT = tMs;
        if (dt <= 0 || dt > 0.5) dt = 0.02;
        grav += dt / (GRAVITY_TAU + dt) * (mag - grav);
        double dyn = mag - grav;
        double rc = 1 / (2 * Math.PI * LP_HZ);
        prev2 = prev; prev = lp;
        lp += dt / (rc + dt) * (dyn - lp);
        double th = Math.min(MAX_THRESH, Math.max(MIN_THRESH, THRESH_RATIO * avgPeak));
        if (lp < -0.3 * th) { valleySeen = true; valley = Math.min(valley, lp); }
        boolean peak = prev > prev2 && prev >= lp;
        if (peak && prev > th && valleySeen && tMs - lastStepT >= MIN_STEP_MS) {
            avgPeak += 0.15 * (Math.min(prev, avgPeak * 3) - avgPeak);
            lastStepT = tMs; valleySeen = false; valley = 0;
            onStep();
        } else if (tMs - lastStepT > MAX_STEP_MS) {
            avgPeak += 0.002 * (1.6 - avgPeak);
        }
    }

    private void onPressure(float hPa) {
        long t = System.currentTimeMillis();
        pSmooth = Double.isNaN(pSmooth) ? hPa : pSmooth + 0.1 * (hPa - pSmooth);
        if (Double.isNaN(p0)) { p0 = hPa; binStart = t; }

        // 10-second bins: very slow change = weather drift → move the baseline with it
        binSum += hPa; binN++;
        if (t - binStart >= BIN_MS) {
            double avg = binSum / binN;
            if (!Double.isNaN(lastBin)) {
                double d = avg - lastBin;
                if (Math.abs(d) < DRIFT_HPA_PER_BIN) p0 += d;
            }
            lastBin = avg; binSum = 0; binN = 0; binStart = t;
        }

        double alt = 44330.0 * (1 - Math.pow(pSmooth / p0, 1 / 5.255));
        boolean outdoor = t - lastGoodFixMs < OUTDOOR_HOLD_MS;
        synchronized (st) {
            st.outdoor = outdoor;
            if (outdoor) {
                // Good GPS = outside. Walking up/down a slope isn't a parkade level,
                // so absorb the height change and keep the level count as it is.
                altOffset = alt - st.floor * FLOOR_M;
                return;
            }
            alt -= altOffset;
            int f = st.floor;
            if (alt > (f + 0.5) * FLOOR_M + HYST_M) f++;
            else if (alt < (f - 0.5) * FLOOR_M - HYST_M) f--;
            if (f != st.floor) { st.floor = f; st.addPoint(); }
        }
    }

    /* ================= notification ================= */
    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Parking tracker", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Shown while Park Finder is counting your steps");
                nm.createNotificationChannel(ch);
            }
        }
    }

    private Notification buildNotification(String text) {
        ensureChannel();
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, ParkTrackerService.class).setAction(ACTION_STOP);
        PendingIntent ps = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL)
                .setContentTitle("Park Finder is tracking")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_stat_park)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi)
                .addAction(0, "Stop", ps)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void updateNotification(boolean force) {
        int steps; double d; int f;
        synchronized (st) { steps = st.steps; d = Math.hypot(st.x, st.y); f = st.floor; }
        lastNotifSteps = steps;
        String text = String.format(Locale.US, "%d steps · %d m from car%s", steps, Math.round(d),
                f == 0 ? "" : String.format(Locale.US, " · car %d level%s %s", Math.abs(f), Math.abs(f) > 1 ? "s" : "", f > 0 ? "down" : "up"));
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        try { nm.notify(NOTIF_ID, buildNotification(text)); } catch (SecurityException ignored) { }
    }

    private void startForegroundCompat(Notification n) {
        if (Build.VERSION.SDK_INT >= 34) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH;
            if (hasLocationPerm()) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            startForeground(NOTIF_ID, n, type);
        } else if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, hasLocationPerm() ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }
}
