'use strict';

const dgram = require('dgram');
const os = require('os');

/**
 * "Any Hangars out there?"
 *
 * Typing an IP address into a phone is the sort of thing that makes a local
 * tool feel like homework, and the address changes whenever the router feels
 * like it. So the phone shouts a question at the whole network and every Hangar
 * that hears it answers with its name, its address and its port.
 *
 * One UDP packet each way, which is all this needs to be. mDNS would do the
 * same job with a dependency, a service registration and a daemon that is
 * missing or broken on a fair share of Windows machines; a broadcast that only
 * this app listens for has none of those failure modes and fits in a file.
 *
 * The answer contains nothing secret — a name, an address, a port. Pairing
 * still has to happen before anything can be done with it.
 */

// Not the server's port: this is a question anyone may ask, and the server's
// port is a thing only paired phones get to talk to.
const DISCOVERY_PORT = 7434;
const PROBE = 'HANGAR-DISCOVER-1';
const REPLY = 'HANGAR-HERE-1';

/**
 * Which of this machine's addresses are worth telling a phone about.
 *
 * Loopback is no use to another device, and neither is a link-local address
 * Windows invents when DHCP has failed. What is left is the address on the
 * router, which is the one to show in Settings.
 */
function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];

  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const addr of addrs || []) {
      if (addr.internal) continue;
      const family = typeof addr.family === 'number' ? `IPv${addr.family}` : addr.family;
      if (family !== 'IPv4') continue;                 // phones type v4
      if (/^169\.254\./.test(addr.address)) continue;  // DHCP gave up
      out.push({ name, address: addr.address, kind: addressKind(addr.address) });
    }
  }

  // A developer's machine has several of these and only one of them is the
  // router. WSL, Docker, Hyper-V and the VM tools all add an adapter with a
  // perfectly valid private address on it that no phone can reach, so the list
  // is ranked and the likeliest one shown first — the panel offers all of them
  // regardless, because ranking is a guess and typing is not.
  return out.sort((a, b) => rankAddress(b) - rankAddress(a));
}

// Adapters that exist because software asked for them rather than because a
// cable or an aerial did.
const VIRTUAL = /vethernet|virtual|vmware|vbox|hyper-?v|docker|wsl|loopback|tap|tun|zerotier/i;

/**
 * Whether an address is one the phone can reach by being in the same building,
 * or one it can only reach by being on the same private network *overlay*.
 *
 * The distinction matters because they look identical in a list and behave
 * nothing alike. 100.64/10 is carrier-grade NAT, which is where Tailscale puts
 * its addresses: perfectly reachable from a phone that is on the same tailnet,
 * and a black hole from one that is not — no error, no refusal, just silence,
 * which is the single most confusing way for this to fail. So the two are told
 * apart here and labelled differently on screen.
 */
function addressKind(address) {
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 'overlay';
  return isPrivateAddress(address) ? 'lan' : 'other';
}

function rankAddress({ name, address }) {
  let score = 0;
  if (isPrivateAddress(address)) score += 4;
  // 192.168/16 and 10/8 are what home routers hand out. 172.16/12 is private
  // too, and is also where every container runtime puts its bridge.
  if (/^192\.168\./.test(address) || /^10\./.test(address)) score += 2;
  if (!VIRTUAL.test(name)) score += 1;
  // An overlay address is a real answer and not the usual one, so it sorts
  // below every address that is simply on the network.
  if (addressKind(address) === 'overlay') score -= 3;
  return score;
}

/**
 * Whether an address belongs to a home network rather than the internet.
 *
 * The server refuses anything else outright. Port forwarding this to the world
 * is not a thing anyone should be able to do by accident, and a router that has
 * been told to forward 7433 is exactly the accident this rules out.
 */
function isPrivateAddress(address) {
  if (!address) return false;
  let ip = String(address);

  // Node reports IPv4 peers on a dual-stack socket in this form.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];

  if (ip === '::1') return true;                       // loopback, v6
  if (/^fe80:/i.test(ip)) return true;                 // link-local, v6
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;     // unique local, v6

  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!v4) return false;

  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127) return true;                          // loopback
  if (a === 10) return true;                           // 10/8
  if (a === 192 && b === 168) return true;             // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16/12
  if (a === 169 && b === 254) return true;             // link-local
  if (a === 100 && b >= 64 && b <= 127) return true;   // carrier NAT, and Tailscale
  return false;
}

/**
 * Answer discovery probes until stopped.
 *
 * `describe()` is called per probe rather than once, so the answer carries the
 * port the server is actually on right now rather than the one it was on when
 * this started.
 */
function startResponder({ describe, port = DISCOVERY_PORT, onError } = {}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let closed = false;

  socket.on('error', (err) => {
    if (onError) onError(err);
    try { socket.close(); } catch { /* already down */ }
  });

  socket.on('message', (message, remote) => {
    if (String(message).trim() !== PROBE) return;
    // A probe from off the local network is not a phone in this house.
    if (!isPrivateAddress(remote.address)) return;

    let reply;
    try {
      reply = Buffer.from(`${REPLY} ${JSON.stringify(describe())}`);
    } catch {
      return;
    }
    socket.send(reply, remote.port, remote.address, () => { /* best effort */ });
  });

  socket.bind(port, () => {
    try { socket.setBroadcast(true); } catch { /* not fatal for replying */ }
  });

  return {
    close() {
      if (closed) return;
      closed = true;
      try { socket.close(); } catch { /* already down */ }
    },
  };
}

module.exports = {
  lanAddresses,
  addressKind,
  isPrivateAddress,
  startResponder,
  DISCOVERY_PORT,
  PROBE,
  REPLY,
};
