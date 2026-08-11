'use strict';

/**
 * The phone's half of the conversation with Hangar on the PC.
 *
 * One WebSocket, JSON both ways, and everything else in this file exists
 * because that socket is on a phone:
 *
 *   - It drops. Constantly. Locking the screen, walking past the router,
 *     Android deciding the app is not in the foreground any more. So the
 *     connection is a thing that keeps trying rather than a thing you do once,
 *     and reconnecting has to be indistinguishable from never having dropped.
 *   - Which means remembering, per terminal, how far through its output we got.
 *     `seq` is a character count kept by the PC; asking to attach with the last
 *     one we saw is the whole of the resume protocol.
 *   - The key is kept here and never leaves the phone except as a query
 *     parameter to the PC that issued it.
 */

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 10_000;

// Long enough for a busy PC on a slow wifi, short enough that "connecting…" is
// never the last thing the screen ever says. A connection that has not been
// accepted by now is being dropped, not delayed.
const CONNECT_TIMEOUT_MS = 6000;

// A refusal comes back at the speed of the network — one round trip. Anything
// slower than this that still failed was not refused by anybody.
const REFUSED_MS = 1500;

function createClient(handlers = {}) {
  let socket = null;
  let host = null;
  let port = null;
  let token = null;
  let retry = RETRY_MIN_MS;
  let retryTimer = null;
  let wanted = false;       // whether we are supposed to be connected at all
  let pairing = null;       // a code waiting to be traded for a key

  // Which terminals this phone is watching, and how far through each it is.
  const attached = new Map();

  const emit = (name, payload) => {
    if (handlers[name]) handlers[name](payload);
  };

  function url() {
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    return `ws://${host}:${port}/ws${query}`;
  }

  function open() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (!wanted || !host) return;

    emit('state', socket ? 'reconnecting' : 'connecting');

    let ws;
    try {
      ws = new WebSocket(url());
    } catch (err) {
      scheduleRetry();
      return;
    }
    socket = ws;

    // How a failure to connect *fails* is the only clue anyone gets about why,
    // and the two ways it can go want two completely different fixes:
    //
    //   - Refused, in milliseconds. Something is at that address and there is
    //     nothing listening on the port. Hangar is not running, or its phone
    //     setting is off, or the port is wrong.
    //   - Nothing at all, for as long as you care to wait. The packets are
    //     being dropped rather than answered — which is what a firewall does,
    //     and what a router does between two devices it will not let talk.
    //
    // A WebSocket reports both as the same bare close event, so the clock is
    // the only thing that separates them.
    const startedAt = Date.now();
    let opened = false;

    const giveUp = setTimeout(() => {
      if (opened) return;
      try { ws.close(); } catch { /* it never got anywhere */ }
      socket = null;
      emit('unreachable', { reason: 'silence', host, port });
      scheduleRetry();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      opened = true;
      clearTimeout(giveUp);
      retry = RETRY_MIN_MS;
      // An unpaired socket has thirty seconds to send exactly this and nothing
      // else, so it goes first.
      if (pairing) ws.send(JSON.stringify({ t: 'pair', code: pairing.code, name: pairing.name }));
    };

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      receive(message);
    };

    ws.onclose = (event) => {
      clearTimeout(giveUp);
      socket = null;

      // 4001 is "you are not paired": retrying that forever would be a loop
      // around a question only a person can answer.
      if (event.code === 4001 || event.code === 4029) {
        wanted = false;
        emit('unpaired', event.reason || 'This phone is not paired.');
        return;
      }

      if (!opened) {
        const quick = Date.now() - startedAt < REFUSED_MS;
        emit('unreachable', { reason: quick ? 'refused' : 'silence', host, port });
        scheduleRetry();
        return;
      }

      emit('state', 'offline');
      scheduleRetry();
    };

    ws.onerror = () => { /* close follows, and is where the timing is read */ };
  }

  function scheduleRetry() {
    if (!wanted || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, retry);
    // Backing off matters more here than anywhere: a phone that cannot reach a
    // PC that is switched off would otherwise wake the radio twice a second
    // all night.
    retry = Math.min(retry * 2, RETRY_MAX_MS);
  }

  function receive(message) {
    switch (message.t) {
      case 'welcome':
        pairing = null;
        emit('state', 'online');
        emit('welcome', message);
        // Everything that was being watched before the drop, from where it got
        // to. This is what makes unlocking the phone show a live terminal
        // rather than an empty one.
        for (const [id, view] of attached) send({ t: 'attach', id, seq: view.seq });
        return;

      case 'paired':
        token = message.token;
        emit('paired', message);
        return;

      case 'data': {
        const view = attached.get(message.id);
        if (view) view.seq = message.seq;
        emit('data', message);
        return;
      }

      case 'session':
        emit('session', message);
        return;

      case 'exit':
        attached.delete(message.id);
        emit('exit', message);
        return;

      case 'created':
        // The PC attaches us on creation, so start counting from the top.
        attached.set(message.session.id, { seq: 0 });
        emit('created', message);
        return;

      default:
        emit(message.t, message);
    }
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  return {
    /** Point at a PC and keep trying until told to stop. */
    connect(next) {
      host = next.host;
      port = next.port;
      token = next.token || null;
      pairing = next.code ? { code: next.code, name: next.name } : null;
      wanted = true;
      retry = RETRY_MIN_MS;
      if (socket) { try { socket.close(); } catch { /* going anyway */ } }
      open();
    },

    disconnect() {
      wanted = false;
      clearTimeout(retryTimer);
      retryTimer = null;
      attached.clear();
      if (socket) { try { socket.close(1000, 'bye'); } catch { /* gone */ } }
      socket = null;
    },

    /** Nudge the socket after the phone wakes, rather than waiting on a timer. */
    wake() {
      if (!wanted) return;
      if (socket && socket.readyState === WebSocket.OPEN) { send({ t: 'ping' }); return; }
      clearTimeout(retryTimer);
      retryTimer = null;
      retry = RETRY_MIN_MS;
      open();
    },

    attach(id) {
      if (!attached.has(id)) attached.set(id, { seq: 0 });
      send({ t: 'attach', id, seq: attached.get(id).seq });
    },

    detach(id) {
      attached.delete(id);
      send({ t: 'detach', id });
    },

    /** Start again from nothing for this terminal — used when a replay resets. */
    rewind(id) {
      attached.set(id, { seq: 0 });
    },

    send,
    token: () => token,
    online: () => Boolean(socket && socket.readyState === WebSocket.OPEN),
  };
}

window.createClient = createClient;
