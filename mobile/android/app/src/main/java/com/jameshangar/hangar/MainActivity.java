package com.jameshangar.hangar;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Registered before the bridge starts, or the web page loads first and
        // finds no Discovery plugin to call.
        registerPlugin(DiscoveryPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
