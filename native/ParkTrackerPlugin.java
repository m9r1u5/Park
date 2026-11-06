package com.m9r1u5.parkfinder;

import android.Manifest;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * JS bridge: window.Capacitor.registerPlugin('ParkTracker')
 *   start({stepLength, autoStopMs, x, y, steps, dist, heading})
 *   stop()
 *   getState({since, peek}) → {running, steps, x, y, dist, heading, floor, hasBaro, stepSource, total, points:[x,y,f,...]}
 *   correct({dx, dy})
 *   setStepLength({stepLength})
 *   scheduleReminder({id, at, title, body}) / cancelReminder({id})
 *   requestPermissions() → {activity, notifications, location}
 */
@CapacitorPlugin(
        name = "ParkTracker",
        permissions = {
                @Permission(alias = "activity", strings = { Manifest.permission.ACTIVITY_RECOGNITION }),
                @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
                @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION })
        }
)
public class ParkTrackerPlugin extends Plugin {

    /** Reads any JS number (int, long or double) safely. */
    private static double num(PluginCall call, String key, double def) {
        return call.getData().optDouble(key, def);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = getContext();
        Intent i = new Intent(ctx, ParkTrackerService.class).setAction(ParkTrackerService.ACTION_START);
        i.putExtra("stepLength", num(call, "stepLength", 0.7));
        i.putExtra("autoStopMs", (long) num(call, "autoStopMs", 3.0 * 3600 * 1000));
        i.putExtra("x", num(call, "x", 0.0));
        i.putExtra("y", num(call, "y", 0.0));
        i.putExtra("steps", (int) num(call, "steps", 0));
        i.putExtra("dist", num(call, "dist", 0.0));
        i.putExtra("heading", num(call, "heading", -1.0));
        try {
            ContextCompat.startForegroundService(ctx, i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start tracking: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        if (TrackerState.get().running) {
            Intent i = new Intent(ctx, ParkTrackerService.class).setAction(ParkTrackerService.ACTION_STOP);
            try { ctx.startService(i); } catch (Exception ignored) { }
        }
        call.resolve();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        TrackerState s = TrackerState.get();
        int since = (int) num(call, "since", 0);
        boolean peek = call.getBoolean("peek", false);
        JSObject r = new JSObject();
        float[] pts;
        synchronized (s) {
            r.put("running", s.running);
            r.put("steps", s.steps);
            r.put("x", s.x);
            r.put("y", s.y);
            r.put("dist", s.dist);
            r.put("heading", s.heading);
            r.put("floor", s.floor);
            r.put("hasBaro", s.hasBaro);
            r.put("stepSource", s.stepSource);
            r.put("total", s.count());
            pts = peek ? new float[0] : s.pointsSince(since);
        }
        JSArray arr = new JSArray();
        try {
            for (float v : pts) arr.put(Math.round(v * 100) / 100.0);
        } catch (Exception ignored) { }
        r.put("points", arr);
        call.resolve(r);
    }

    @PluginMethod
    public void correct(PluginCall call) {
        TrackerState.get().shift(num(call, "dx", 0.0), num(call, "dy", 0.0));
        call.resolve();
    }

    @PluginMethod
    public void setStepLength(PluginCall call) {
        TrackerState s = TrackerState.get();
        synchronized (s) { s.stepLength = num(call, "stepLength", s.stepLength); }
        call.resolve();
    }

    @PluginMethod
    public void scheduleReminder(PluginCall call) {
        int id = (int) num(call, "id", 1);
        long at = (long) num(call, "at", 0.0);
        Context ctx = getContext();
        Intent i = new Intent(ctx, ReminderReceiver.class);
        i.putExtra("id", id);
        i.putExtra("title", call.getString("title", "Park Finder"));
        i.putExtra("body", call.getString("body", ""));
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 100 + id, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        // inexact (may be a minute or two late) but needs no special "exact alarm" permission
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        call.resolve();
    }

    @PluginMethod
    public void cancelReminder(PluginCall call) {
        int id = (int) num(call, "id", 1);
        Context ctx = getContext();
        Intent i = new Intent(ctx, ReminderReceiver.class);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 100 + id, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        am.cancel(pi);
        call.resolve();
    }
}
