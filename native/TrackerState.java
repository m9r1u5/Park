package com.m9r1u5.parkfinder;

/**
 * Shared, thread-safe tracking state. Written by ParkTrackerService (sensor thread),
 * read by ParkTrackerPlugin (JS bridge). Coordinates: metres, car = (0,0),
 * +x east, +y north.
 */
public final class TrackerState {
    private static final TrackerState INSTANCE = new TrackerState();
    public static TrackerState get() { return INSTANCE; }

    public boolean running = false;
    public double x = 0, y = 0, dist = 0;
    public int steps = 0;
    public double heading = -1;      // degrees from north, -1 = unknown
    public int floor = 0;            // levels above the car (barometer)
    public boolean hasBaro = false;
    public String stepSource = "none";
    public double stepLength = 0.7;
    public double headingBias = 0;                   // compass error learned from GPS (deg)
    public boolean outdoor = false;                  // good GPS right now
    public double fixLat = 0, fixLon = 0, fixAcc = 999;
    public long fixTime = 0;                         // ms, 0 = no fix yet

    // trail: x, y, floor triplets
    private float[] pts = new float[3 * 4096];
    private int count = 0;

    private TrackerState() {}

    public synchronized void reset(double x0, double y0, int steps0, double dist0, double heading0, double stepLen) {
        x = x0; y = y0; steps = steps0; dist = dist0; heading = heading0; stepLength = stepLen;
        floor = 0; count = 0; outdoor = false; fixTime = 0;
    }

    public synchronized void addPoint() {
        if (3 * (count + 1) > pts.length) {
            float[] n = new float[pts.length * 2];
            System.arraycopy(pts, 0, n, 0, 3 * count);
            pts = n;
        }
        pts[3 * count] = (float) x;
        pts[3 * count + 1] = (float) y;
        pts[3 * count + 2] = floor;
        count++;
    }

    /** Called for every detected step. */
    public synchronized void step(double headingDeg) {
        steps++;
        if (headingDeg < 0) return;     // direction unknown: count only
        double r = Math.toRadians(headingDeg);
        x += stepLength * Math.sin(r);
        y += stepLength * Math.cos(r);
        dist += stepLength;
        addPoint();
    }

    /** GPS correction from the app. */
    public synchronized void shift(double dx, double dy) {
        x += dx; y += dy;
        addPoint();
    }

    public synchronized int count() { return count; }

    /** Copy points [from, count) as a flat x,y,floor array. */
    public synchronized float[] pointsSince(int from) {
        if (from < 0 || from > count) from = 0;
        float[] out = new float[3 * (count - from)];
        System.arraycopy(pts, 3 * from, out, 0, out.length);
        return out;
    }
}
