'use strict';

const { EventEmitter } = require('events');
const Classify = require('./renderer/classify');

/**
 * Every terminal Hangar is running, and everything known about it.
 *
 * This used to be the renderer's job. A tab owned its pty, its scrollback, its
 * name and its coloured dot, and closing the window took the lot with it. That
 * works exactly as long as there is one screen looking at it.
 *
 * There are two now — the window and a phone — so the terminals moved down
 * here, to the one process both of them can talk to. A viewer attaches, gets
 * the history it missed, and is sent everything after it; the name and the
 * stage are worked out once, here, so the sidebar and the phone cannot end up
 * calling the same terminal two different things.
 *
 * Nothing in this file knows about Electron, IPC or sockets. It is handed a
 * `spawn` and emits events; `main.js` wires it to the window and `server.js`
 * wires it to the network.
 */

// How much of each terminal's output to keep for a viewer that turns up late.
// Half a megabyte is a few thousand lines — plenty to fill a phone screen and
// see what just happened, and far less than xterm's own 100,000-line
// scrollback, which is still the window's and is not duplicated here.
const SCROLLBACK_BYTES = 512 * 1024;

// The same three constants the renderer used to classify with, moved with the
// code that used them.
const IDLE_MS = 3000;
const CLASSIFY_MS = 150;
const RECENT_CHARS = 4000;

function createSessions(options = {}) {
  const {
    spawn,
    idleMs = IDLE_MS,
    classifyMs = CLASSIFY_MS,
    scrollbackBytes = SCROLLBACK_BYTES,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  const emitter = new EventEmitter();
  const sessions = new Map();
  let counter = 0;

  /** What a viewer is told about a terminal. Never the pty, never the buffer. */
  function summary(s) {
    return {
      id: s.id,
      projectPath: s.projectPath,
      projectName: s.projectName,
      command: s.command,
      shell: s.shell,
      cwd: s.cwd,
      pid: s.pid,
      cols: s.cols,
      rows: s.rows,
      sizeOwner: s.sizeOwner,
      origin: s.origin,
      title: s.title,
      state: s.state,
      altScreen: s.altScreen,
      startedAt: s.startedAt,
      seq: s.seq,
    };
  }

  function announce(kind, s) {
    emitter.emit('session', { kind, session: summary(s) });
  }

  /**
   * Start a terminal.
   *
   * Throws rather than returning a broken session: a shell that will not spawn
   * has no history, no name and nothing to attach to, and the thing that asked
   * for it is the only one in a position to say so. On the desktop that is a
   * tab printing the reason; on the phone it is a message on the screen.
   */
  function create({
    projectPath, projectName, command, cols, rows,
    sizeOwner = 'desktop',
    // Which screen asked. The window learns the id of a terminal it opened
    // from the call it made, so it has to be able to tell that from the
    // broadcast about the same terminal arriving a moment earlier — otherwise
    // one `+` click builds two tabs for one shell.
    origin = 'desktop',
  }) {
    const started = spawn({ cwd: projectPath, command, cols, rows });

    const id = `s${++counter}-${Date.now().toString(36)}`;
    const s = {
      id,
      projectPath,
      projectName,
      command: command || null,
      shell: started.shell,
      cwd: started.cwd,
      args: started.args,
      pid: started.proc.pid,
      proc: started.proc,

      cols: cols || 80,
      rows: rows || 24,
      sizeOwner,
      origin,

      title: command || 'shell',
      namedBySession: false,
      state: 'ready',
      startedAt: Date.now(),

      // The scrollback ring. `seq` counts every character the terminal has ever
      // printed, so a viewer can say "I had the first 40,000" and be sent only
      // what came after — which is what makes a phone waking from sleep pick up
      // where it left off instead of redrawing everything.
      seq: 0,
      bytes: 0,
      chunks: [],

      altScreen: false,
      recent: '',
      dirty: false,
      paused: false,
      idleTimer: null,
      classifyTimer: null,
    };

    // Claude Code publishes its session summary as the terminal title. That
    // beats anything we can infer from keystrokes, so the first real one takes
    // the terminal over for good.
    s.titleCapture = Classify.createTitleCapture((raw) => {
      const name = Classify.nameFromTitle(raw);
      if (!name) return;
      s.namedBySession = true;
      setTitle(s, name);
    });

    // Until then, guess from what was typed.
    s.capture = Classify.createInputCapture((line) => {
      if (!s.namedBySession) setTitle(s, Classify.nameFromPrompt(line) || s.title);
      setState(s, 'planning');
    });

    s.proc.onData((data) => onOutput(s, data));
    s.proc.onExit(({ exitCode }) => {
      sessions.delete(id);
      clearTimer(s.idleTimer);
      clearTimer(s.classifyTimer);
      emitter.emit('exit', { id, exitCode });
      announce('closed', s);
    });

    sessions.set(id, s);
    announce('created', s);
    return summary(s);
  }

  function setTitle(s, title) {
    if (!title || s.title === title) return;
    s.title = title;
    announce('updated', s);
  }

  function setState(s, state) {
    if (s.state === state) return;
    s.state = state;
    announce('updated', s);
  }

  function onOutput(s, data) {
    const text = String(data);

    s.seq += text.length;
    s.chunks.push({ end: s.seq, data: text });
    s.bytes += text.length;
    while (s.bytes > scrollbackBytes && s.chunks.length > 1) {
      s.bytes -= s.chunks.shift().data.length;
    }

    s.titleCapture(text);

    const wasAlt = s.altScreen;
    s.altScreen = Classify.altScreenAfter(s.altScreen, text);
    if (wasAlt !== s.altScreen) announce('updated', s);

    emitter.emit('data', { id: s.id, seq: s.seq, data: text });

    // Everything below is the stage dot, moved here from the renderer verbatim.
    s.recent = (s.recent + Classify.stripAnsi(text)).slice(-RECENT_CHARS);
    s.dirty = true;
    emitter.emit('activity', { id: s.id, projectPath: s.projectPath });

    clearTimer(s.idleTimer);
    s.idleTimer = setTimer(() => {
      setState(s, 'ready');
      emitter.emit('idle', { id: s.id, projectPath: s.projectPath });
    }, idleMs);

    // Throttled: the regex sweep is cheap, but output arrives many times a
    // second and there is no sense running it per chunk.
    if (!s.classifyTimer) {
      s.classifyTimer = setTimer(() => {
        s.classifyTimer = null;
        if (!s.dirty) return;
        s.dirty = false;
        const state = Classify.classify(s.recent);
        if (state) setState(s, state);
      }, classifyMs);
    }
  }

  /**
   * What a viewer missed, given how far it had got.
   *
   * `reset` means the answer starts further along than the viewer was, because
   * what it wanted has already scrolled out of the ring — the viewer should
   * clear its screen rather than paste this onto the end of stale output.
   */
  function history(id, sinceSeq) {
    const s = sessions.get(id);
    if (!s) return null;

    const earliest = s.seq - s.bytes;
    if (typeof sinceSeq === 'number' && sinceSeq >= s.seq) {
      return { seq: s.seq, data: '', reset: false };
    }
    if (typeof sinceSeq !== 'number' || sinceSeq < earliest) {
      return { seq: s.seq, data: s.chunks.map((c) => c.data).join(''), reset: true };
    }

    let out = '';
    for (const chunk of s.chunks) {
      if (chunk.end <= sinceSeq) continue;
      const start = chunk.end - chunk.data.length;
      out += start >= sinceSeq ? chunk.data : chunk.data.slice(sinceSeq - start);
    }
    return { seq: s.seq, data: out, reset: false };
  }

  function write(id, data) {
    const s = sessions.get(id);
    if (!s) return false;
    s.capture(data);
    s.proc.write(data);
    return true;
  }

  /**
   * Resize, but only for whoever owns the size.
   *
   * Two screens of very different widths are looking at one terminal, and a
   * terminal can only be one width. So one viewer owns it and the other scales
   * its own text to match — the desktop by default, since that is where the
   * work is being done, and the phone only if it asks to take over. Without
   * this rule the two would fight, reflowing the TUI every time focus moved.
   */
  function resize(id, cols, rows, owner = 'desktop') {
    const s = sessions.get(id);
    if (!s) return false;
    if (s.sizeOwner !== owner) return false;

    const c = Math.max(Number(cols) || 0, 1);
    const r = Math.max(Number(rows) || 0, 1);
    if (c === s.cols && r === s.rows) return true;

    s.cols = c;
    s.rows = r;
    try { s.proc.resize(c, r); } catch { /* racing a dying pty */ }
    announce('updated', s);
    return true;
  }

  /** Hand the size to a different viewer, and immediately fit to it. */
  function claimSize(id, owner, cols, rows) {
    const s = sessions.get(id);
    if (!s) return false;
    s.sizeOwner = owner;
    announce('updated', s);
    return resize(id, cols, rows, owner);
  }

  /**
   * Make a full-screen program repaint itself.
   *
   * A viewer joining mid-session gets the bytes it missed, which is enough for
   * ordinary scrolling output and not enough for a TUI: what it is looking at
   * was painted into a screen buffer whose earlier state has scrolled out of
   * the ring. Nothing can ask a program for its current screen — but almost
   * every one of them redraws from scratch on a resize, so a column out and
   * back is the standard way to ask. tmux does the same thing on attach.
   */
  function nudge(id) {
    const s = sessions.get(id);
    if (!s || !s.altScreen) return false;
    try {
      s.proc.resize(Math.max(s.cols - 1, 1), s.rows);
      setTimer(() => {
        try { s.proc.resize(s.cols, s.rows); } catch { /* gone */ }
      }, 40);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Flow control, which is still the window's alone.
   *
   * The window cannot drop output — it is the scrollback of record — so when it
   * falls behind, the pty stops. A phone that falls behind is a different
   * problem with a different answer (see `server.js`): it skips ahead rather
   * than making everyone else wait on a wifi hiccup.
   */
  function flow(id, pause) {
    const s = sessions.get(id);
    if (!s || s.paused === pause) return;
    s.paused = pause;
    if (pause) s.proc.pause(); else s.proc.resume();
  }

  function kill(id) {
    const s = sessions.get(id);
    if (!s) return false;
    try { s.proc.kill(); } catch { /* already gone */ }
    sessions.delete(id);
    clearTimer(s.idleTimer);
    clearTimer(s.classifyTimer);
    announce('closed', s);
    return true;
  }

  function killAll() {
    for (const id of [...sessions.keys()]) kill(id);
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    create,
    list: () => [...sessions.values()].map(summary),
    get: (id) => (sessions.has(id) ? summary(sessions.get(id)) : null),
    has: (id) => sessions.has(id),
    history,
    write,
    resize,
    claimSize,
    nudge,
    flow,
    kill,
    killAll,
    count: () => sessions.size,
  };
}

module.exports = { createSessions, SCROLLBACK_BYTES, IDLE_MS, CLASSIFY_MS, RECENT_CHARS };
