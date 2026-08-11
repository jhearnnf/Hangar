package com.jameshangar.hangar;

import android.content.Context;
import android.net.wifi.WifiManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * "Any Hangars out there?"
 *
 * The one thing on the phone that cannot be done from the web page. A WebView
 * has no UDP, and without UDP there is no way to ask a network a question
 * without already knowing who to ask — which would mean typing an IP address
 * that changes whenever the router feels like it.
 *
 * So: shout once at the broadcast address, listen for a second or two, and
 * hand back whatever answered. Nothing is sent but the word HANGAR-DISCOVER-1,
 * nothing is stored, and pairing still has to happen afterwards — this only
 * finds the PC, it does not get you into it.
 *
 * The multicast lock matters and is easy to miss: without one, Android's wifi
 * driver drops broadcast packets that are not addressed to this device
 * specifically, to save power. The replies would simply never arrive, on a
 * network where everything is working.
 */
@CapacitorPlugin(name = "Discovery")
public class DiscoveryPlugin extends Plugin {

    private static final int PORT = 7434;
    private static final String PROBE = "HANGAR-DISCOVER-1";
    private static final String REPLY = "HANGAR-HERE-1";

    @PluginMethod
    public void find(PluginCall call) {
        final int timeout = call.getInt("timeout", 2000);

        new Thread(() -> {
            WifiManager wifi = (WifiManager) getContext()
                    .getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            WifiManager.MulticastLock lock = null;

            if (wifi != null) {
                lock = wifi.createMulticastLock("hangar-discovery");
                lock.setReferenceCounted(true);
                lock.acquire();
            }

            DatagramSocket socket = null;
            List<JSObject> found = new ArrayList<>();
            Set<String> seen = new HashSet<>();

            try {
                socket = new DatagramSocket();
                socket.setBroadcast(true);
                socket.setSoTimeout(300);

                byte[] probe = PROBE.getBytes(StandardCharsets.UTF_8);
                socket.send(new DatagramPacket(
                        probe, probe.length, InetAddress.getByName("255.255.255.255"), PORT));

                long until = System.currentTimeMillis() + timeout;
                byte[] buffer = new byte[2048];

                while (System.currentTimeMillis() < until) {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    try {
                        socket.receive(packet);
                    } catch (Exception timedOut) {
                        continue;   // the read window, not the search window
                    }

                    String message = new String(
                            packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8).trim();
                    if (!message.startsWith(REPLY)) continue;

                    String address = packet.getAddress().getHostAddress();
                    if (address == null || !seen.add(address)) continue;

                    JSObject entry = new JSObject();
                    entry.put("address", address);
                    entry.put("name", "Hangar");
                    entry.put("port", 7433);

                    // The PC describes itself in the rest of the packet. If any
                    // of that cannot be read, the address alone is still a
                    // perfectly good answer, so it is never fatal.
                    int space = message.indexOf(' ');
                    if (space > 0) {
                        try {
                            JSONObject described = new JSONObject(message.substring(space + 1));
                            if (described.has("name")) entry.put("name", described.getString("name"));
                            if (described.has("port")) entry.put("port", described.getInt("port"));
                        } catch (Exception ignored) {
                        }
                    }
                    found.add(entry);
                }
            } catch (Exception err) {
                // A phone with no wifi, or a network that refuses broadcasts.
                // An empty list is the honest answer and the screen already
                // knows what to say about one.
            } finally {
                if (socket != null) socket.close();
                if (lock != null && lock.isHeld()) lock.release();
            }

            JSArray hosts = new JSArray();
            for (JSObject entry : found) hosts.put(entry);

            JSObject result = new JSObject();
            result.put("hosts", hosts);
            call.resolve(result);
        }).start();
    }
}
