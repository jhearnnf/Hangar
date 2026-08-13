'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { isPrivateAddress } = require('./discovery');

/**
 * The half of Hangar a phone can see.
 *
 * One socket per phone. Down it go the projects, the terminals, and every
 * character every attached terminal prints; up it come keystrokes, resizes and
 * "open a terminal here". Nothing in here runs a shell or reads a file itself —
 * it is a translation layer over the same `sessions` registry the window uses,
 * which is what keeps the two screens honest about being one app.
 *
 * Three rules do the security, and they are all in `accept()` and `handle()`:
 *
 *   1. Off unless switched on. No setting, no listener, no port.
 *   2. Local addresses only. Something arriving from the internet — a
 *      forwarded port, a router someone was too clever with — is dropped
 *      before the socket is even upgraded.
 *   3. Paired or nothing. An unpaired socket may send exactly one kind of
 *      message: a pairing code. Everything else is refused until it holds a
 *      key, and an unpaired socket that does not pair within half a minute is
 *      closed.
 */

const DEFAULT_PORT = 7433;

// An unpaired socket exists only to carry a pairing code. Anything still
// sitting there after this is not pairing.
const UNPAIRED_GRACE_MS = 30_000;

// A six-character code is safe because it is short-lived, single-use and
// rate-limited. This is the last of those three.
const MAX_PAIR_ATTEMPTS = 5;

// How far a phone's socket may fall behind before we stop feeding it. Wifi on
// a phone in a pocket drops to nothing regularly, and a burst of output while
// that happens must not be allowed to queue in memory without bound. When the
// socket drains it is sent everything it missed in one go — which is what the
// sequence numbers in `sessions.js` are for.
const CLIENT_HIGH_WATER = 1_000_000;
const CLIENT_LOW_WATER = 100_000;
const DRAIN_TICK_MS = 150;

// Phones sleep, wifi drops, and a TCP connection can stay open for minutes
// after the far end has gone. A ping every twenty seconds finds that out.
const PING_MS = 20_000;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function createServer(deps) {
  const {
    sessions,
    devices,
    listProjects,
    createProject,
    usage,
    backup,
    // Claude's own record of what has been worked on in a project, for the
    // phone's long-press menu. Injected like `usage` and `backup` rather than
    // required here, so this file still knows nothing about where any of it
    // comes from — and so a server built without one simply has nothing to
    // offer instead of failing to start.
    recentSessions = () => [],
    info = () => ({}),
    wwwDir = null,
    log = () => {},
  } = deps;

  const clients = new Set();
  let httpServer = null;
  let wss = null;
  let drainTimer = null;
  let pingTimer = null;
  let pairAttempts = 0;
  let listening = null;   // { port, address } once up

  // ------------------------------------------------------------- sending

  function send(client, message) {
    if (client.ws.readyState !== 1) return;
    try { client.ws.send(JSON.stringify(message)); } catch { /* it is going away */ }
  }

  function broadcast(message, filter = () => true) {
    for (const client of clients) {
      if (client.device && filter(client)) send(client, message);
    }
  }

  /**
   * Push a terminal's output at one phone, from wherever it had got to.
   *
   * Always sent as "everything since your last sequence number" rather than as
   * the chunk that just arrived, which means a client that was skipped while
   * its socket was full catches up automatically the next time anything is
   * printed — no separate resend path, and no way for the two to disagree
   * about what has been delivered.
   */
  function pump(client, id) {
    const view = client.attached.get(id);
    if (!view) return;

    if (client.ws.bufferedAmount > CLIENT_HIGH_WATER) {
      view.lagging = true;
      return;
    }
    if (view.lagging && client.ws.bufferedAmount > CLIENT_LOW_WATER) return;
    view.lagging = false;

    const slice = sessions.history(id, view.seq);
    if (!slice) return;
    if (!slice.data && slice.seq === view.seq) return;

    view.seq = slice.seq;
    send(client, { t: 'data', id, seq: slice.seq, data: slice.data, reset: slice.reset });
  }

  // ------------------------------------------------- registry -> sockets

  function onSessionData({ id }) {
    for (const client of clients) {
      if (client.device && client.attached.has(id)) pump(client, id);
    }
  }

  function onSessionEvent(event) {
    broadcast({ t: 'session', kind: event.kind, session: event.session });
  }

  function onSessionExit(event) {
    broadcast({ t: 'exit', id: event.id, exitCode: event.exitCode });
    for (const client of clients) client.attached.delete(event.id);
  }

  sessions.on('data', onSessionData);
  sessions.on('session', onSessionEvent);
  sessions.on('exit', onSessionExit);

  // --------------------------------------------------------- the messages

  async function handle(client, message) {
    // An unpaired socket has exactly one thing it is allowed to say.
    if (!client.device) {
      if (message.t !== 'pair') {
        send(client, { t: 'error', message: 'This phone is not paired with Hangar yet.', fatal: true });
        client.ws.close(4001, 'unpaired');
        return;
      }

      if (pairAttempts >= MAX_PAIR_ATTEMPTS) {
        devices.clearCode();
        send(client, { t: 'error', message: 'Too many tries. Open Settings on the PC for a new code.' });
        client.ws.close(4029, 'too many attempts');
        return;
      }

      const result = devices.pair(message.code, message.name);
      if (!result.ok) {
        pairAttempts += 1;
        send(client, { t: 'error', message: result.message, ref: message.ref });
        return;
      }

      pairAttempts = 0;
      client.device = result.device;
      log(`paired with ${result.device.name}`);
      send(client, { t: 'paired', token: result.token, device: result.device });
      send(client, welcome(client));
      return;
    }

    switch (message.t) {
      case 'hello':
        send(client, welcome(client));
        return;

      case 'ping':
        send(client, { t: 'pong' });
        return;

      case 'projects':
        send(client, { t: 'projects', ...listProjects() });
        return;

      case 'newProject': {
        const result = await createProject(message.name);
        send(client, { t: 'newProject', ref: message.ref, ...result });
        if (result.ok) broadcast({ t: 'projects', ...listProjects() });
        return;
      }

      case 'create': {
        try {
          const session = sessions.create({
            projectPath: message.projectPath,
            projectName: message.projectName,
            command: message.command || null,
            cols: message.cols,
            rows: message.rows,
            // A terminal opened from the phone is sized by the phone, until a
            // desktop window takes it over. The alternative — 80 columns of
            // nothing on a screen four inches wide — is unreadable.
            sizeOwner: message.claim ? client.id : 'desktop',
            origin: 'phone',
          });
          attach(client, session.id, 0);
          send(client, { t: 'created', ref: message.ref, session });
        } catch (err) {
          send(client, { t: 'error', ref: message.ref, message: err && err.message ? err.message : String(err) });
        }
        return;
      }

      case 'attach':
        attach(client, message.id, message.seq);
        return;

      case 'detach':
        client.attached.delete(message.id);
        return;

      case 'input':
        sessions.write(message.id, String(message.data || ''));
        return;

      case 'resize':
        if (message.claim) sessions.claimSize(message.id, client.id, message.cols, message.rows);
        else sessions.resize(message.id, message.cols, message.rows, client.id);
        return;

      case 'release':
        // Hand the width back to the desktop window.
        sessions.claimSize(message.id, 'desktop', message.cols, message.rows);
        return;

      case 'kill':
        sessions.kill(message.id);
        return;

      case 'usage':
        send(client, { t: 'usage', usage: await usage() });
        return;

      case 'backup': {
        const result = await backup(message.projectPath);
        send(client, { t: 'backup', ref: message.ref, projectPath: message.projectPath, ...result });
        return;
      }

      // The claude sessions a project has had. `projectPath` comes back with
      // the answer because the phone asks on a long press and may well have
      // let go and pressed something else before this arrives.
      case 'recent': {
        const rows = await recentSessions(message.projectPath);
        send(client, { t: 'recent', ref: message.ref, projectPath: message.projectPath, rows });
        return;
      }

      default:
        send(client, { t: 'error', message: `Hangar does not understand "${message.t}".` });
    }
  }

  function attach(client, id, sinceSeq) {
    if (!sessions.has(id)) {
      send(client, { t: 'error', message: 'That terminal has closed.', id });
      return;
    }
    client.attached.set(id, { seq: Number.isFinite(sinceSeq) ? sinceSeq : 0, lagging: false });
    pump(client, id);
    // A full-screen program's current screen is not in the replay — it was
    // painted into a buffer, not printed. Ask it to draw itself again.
    sessions.nudge(id);
  }

  function welcome(client) {
    return {
      t: 'welcome',
      ...info(),
      device: client.device,
      ...listProjects(),
      sessions: sessions.list(),
    };
  }

  // ------------------------------------------------------ sockets and http

  function accept(request) {
    const remote = request.socket.remoteAddress;
    if (!isPrivateAddress(remote)) {
      log(`refused a connection from ${remote} — not a local address`);
      return false;
    }
    return true;
  }

  function serveStatic(request, response) {
    // A browser fallback, and the quickest way to tell whether the PC half is
    // working: point a phone at http://<pc>:7433 and this answers.
    if (!wwwDir) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Hangar is running here. Open the Hangar app on your phone.\n');
      return;
    }

    const url = new URL(request.url, 'http://localhost');
    const wanted = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(wwwDir, path.normalize(wanted).replace(/^[\\/]+/, ''));

    // Nothing outside the folder being served, whatever the path says.
    if (!file.startsWith(path.resolve(wwwDir))) {
      response.writeHead(403).end('no');
      return;
    }

    fs.readFile(file, (err, body) => {
      if (err) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not here.\n');
        return;
      }
      response.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream' });
      response.end(body);
    });
  }

  function onRequest(request, response) {
    if (!accept(request)) {
      response.writeHead(403).end();
      return;
    }

    if (request.url.startsWith('/health')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, ...info() }));
      return;
    }

    serveStatic(request, response);
  }

  let nextClientId = 0;

  function onConnection(ws, request) {
    const url = new URL(request.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const device = token ? devices.verify(token) : null;

    const client = {
      id: `c${++nextClientId}`,
      ws,
      device,
      attached: new Map(),
      alive: true,
    };
    clients.add(client);

    if (device) {
      log(`${device.name} connected`);
      send(client, welcome(client));
    } else {
      // Half a minute to type six characters, then the socket goes. An open
      // socket that never pairs is either a mistake or someone trying codes.
      client.graceTimer = setTimeout(() => {
        if (!client.device) {
          send(client, { t: 'error', message: 'Not paired. Ask the PC for a code.', fatal: true });
          try { ws.close(4001, 'unpaired'); } catch { /* already gone */ }
        }
      }, UNPAIRED_GRACE_MS);
    }

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        send(client, { t: 'error', message: 'That was not a message Hangar could read.' });
        return;
      }
      if (!message || typeof message.t !== 'string') return;

      Promise.resolve()
        .then(() => handle(client, message))
        .catch((err) => send(client, { t: 'error', message: err && err.message ? err.message : String(err) }));
    });

    ws.on('pong', () => { client.alive = true; });

    ws.on('close', () => {
      clearTimeout(client.graceTimer);
      clients.delete(client);
      // Anything this phone had taken the width of goes back to the window,
      // which is the only viewer that is definitely still there.
      for (const id of client.attached.keys()) {
        const session = sessions.get(id);
        if (session && session.sizeOwner === client.id) sessions.claimSize(id, 'desktop', session.cols, session.rows);
      }
      if (client.device) {
        devices.seen(client.device.id);
        log(`${client.device.name} disconnected`);
      }
    });

    ws.on('error', () => { /* close follows */ });
  }

  // ------------------------------------------------------------ lifecycle

  function start(port = DEFAULT_PORT) {
    if (httpServer) return Promise.resolve(listening);

    return new Promise((resolve, reject) => {
      httpServer = http.createServer(onRequest);
      wss = new WebSocketServer({ noServer: true });

      httpServer.on('upgrade', (request, socket, head) => {
        if (!accept(request) || !request.url.startsWith('/ws')) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => onConnection(ws, request));
      });

      httpServer.on('error', (err) => {
        httpServer = null;
        reject(err);
      });

      httpServer.listen(port, '0.0.0.0', () => {
        listening = { port: httpServer.address().port };
        log(`listening on ${listening.port}`);

        // Everything a lagging phone missed, flushed the moment its socket has
        // room. Cheap: it does nothing at all unless something is behind.
        drainTimer = setInterval(() => {
          for (const client of clients) {
            if (!client.device) continue;
            for (const [id, view] of client.attached) if (view.lagging) pump(client, id);
          }
        }, DRAIN_TICK_MS);

        pingTimer = setInterval(() => {
          for (const client of clients) {
            if (!client.alive) { try { client.ws.terminate(); } catch { /* gone */ } continue; }
            client.alive = false;
            try { client.ws.ping(); } catch { /* gone */ }
          }
        }, PING_MS);

        resolve(listening);
      });
    });
  }

  function stop() {
    clearInterval(drainTimer);
    clearInterval(pingTimer);
    drainTimer = null;
    pingTimer = null;

    for (const client of clients) {
      try { client.ws.close(1001, 'Hangar is no longer sharing'); } catch { /* gone */ }
    }
    clients.clear();

    if (wss) { try { wss.close(); } catch { /* gone */ } wss = null; }
    if (httpServer) { try { httpServer.close(); } catch { /* gone */ } httpServer = null; }
    listening = null;
  }

  return {
    start,
    stop,
    port: () => (listening ? listening.port : null),
    running: () => Boolean(listening),
    clients: () => [...clients].filter((c) => c.device).map((c) => c.device),
    broadcastProjects: () => broadcast({ t: 'projects', ...listProjects() }),
    dispose() {
      stop();
      sessions.off('data', onSessionData);
      sessions.off('session', onSessionEvent);
      sessions.off('exit', onSessionExit);
    },
  };
}

module.exports = { createServer, DEFAULT_PORT };
