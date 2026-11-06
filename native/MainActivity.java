package com.m9r1u5.parkfinder;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ParkTrackerPlugin.class);   // our native step/heading tracker
        super.onCreate(savedInstanceState);
    }
}
