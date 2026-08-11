import { describe, it, expect, vi } from 'vitest';
import { createSessions } from '../sessions.js';

/**
 * A pty that is not one: it records what was written to it and lets a test
 * decide what it printed back. Everything the registry does with a terminal
 * goes through these five methods, so nothing here needs a shell.
 */
function fakePty() {
  const listeners = { data: [], exit: [] };
  return {
    pid: 4242,
    written: [],
    resized: [],
    killed: false,
    paused: false,
    onData: (cb) => listeners.data.push(cb),
    onExit: (cb) => listeners.exit.push(cb),
    write(data) { this.written.push(data); },
    resize(cols, rows) { this.resized.push([cols, rows]); },
    kill() { this.killed = true; },
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    say(text) { for (const cb of listeners.data) cb(text); },
    die(code) { for (const cb of listeners.exit) cb({ exitCode: code }); },
  };
}

function registry(options = {}) {
  const pty = fakePty();
  const sessions = createSessions({
    spawn: () => ({ proc: pty, shell: 'pwsh.exe', cwd: 'C:\\work\\demo', args: [] }),
    ...options,
  });
  const session = sessions.create({
    projectPath: 'C:\\work\\demo', projectName: 'demo', command: 'claude', cols: 80, rows: 24,
  });
  return { sessions, pty, session };
}

describe('createSessions', () => {
  it('gives every terminal an id of its own', () => {
    const { sessions, session } = registry();
    expect(session.id).toBeTruthy();
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.get(session.id).projectName).toBe('demo');
  });

  it('never hands out the pty, only what a viewer needs', () => {
    const { session } = registry();
    expect(session.proc).toBeUndefined();
    expect(session.chunks).toBeUndefined();
    expect(session.pid).toBe(4242);
  });

  it('keeps what was printed, and hands back only what a viewer missed', () => {
    const { sessions, pty, session } = registry();

    pty.say('one');
    pty.say('two');

    expect(sessions.history(session.id, 0)).toEqual({ seq: 6, data: 'onetwo', reset: false });
    expect(sessions.history(session.id, 3)).toEqual({ seq: 6, data: 'two', reset: false });
    expect(sessions.history(session.id, 6)).toEqual({ seq: 6, data: '', reset: false });
  });

  it('slices into the middle of a chunk a viewer is halfway through', () => {
    const { sessions, pty, session } = registry();
    pty.say('abcdef');
    expect(sessions.history(session.id, 2).data).toBe('cdef');
  });

  it('says so when what was asked for has scrolled out of the ring', () => {
    const { sessions, pty, session } = registry({ scrollbackBytes: 8 });

    pty.say('aaaaa');
    pty.say('bbbbb');   // the first chunk is now dropped

    const past = sessions.history(session.id, 0);
    expect(past.reset).toBe(true);
    expect(past.data).toBe('bbbbb');
    expect(past.seq).toBe(10);
  });

  it('names itself after a title the program published', () => {
    const { sessions, pty, session } = registry();
    const seen = [];
    sessions.on('session', (e) => seen.push(e));

    pty.say('\u001b]0;fix login redirect\u0007');

    expect(sessions.get(session.id).title).toBe('fix login redirect');
    expect(seen.some((e) => e.kind === 'updated')).toBe(true);
  });

  it('falls back to naming itself after what was typed', () => {
    const { sessions, session } = registry();
    sessions.write(session.id, 'can you fix the login redirect\r');
    expect(sessions.get(session.id).title).toBe('fix login redirect');
  });

  it('a published title beats the guess from then on', () => {
    const { sessions, pty, session } = registry();
    pty.say('\u001b]0;real name\u0007');
    sessions.write(session.id, 'some other thing entirely\r');
    expect(sessions.get(session.id).title).toBe('real name');
  });

  it('tracks whether a full-screen program has taken the screen', () => {
    const { sessions, pty, session } = registry();
    expect(sessions.get(session.id).altScreen).toBe(false);
    pty.say('\u001b[?1049h');
    expect(sessions.get(session.id).altScreen).toBe(true);
    pty.say('\u001b[?1049l');
    expect(sessions.get(session.id).altScreen).toBe(false);
  });

  it('only lets the viewer that owns the width change it', () => {
    const { sessions, pty, session } = registry();

    expect(sessions.resize(session.id, 100, 30, 'desktop')).toBe(true);
    expect(pty.resized.at(-1)).toEqual([100, 30]);

    expect(sessions.resize(session.id, 40, 20, 'c1')).toBe(false);
    expect(pty.resized.at(-1)).toEqual([100, 30]);
  });

  it('hands the width over when a viewer claims it', () => {
    const { sessions, pty, session } = registry();
    sessions.claimSize(session.id, 'c1', 45, 30);
    expect(pty.resized.at(-1)).toEqual([45, 30]);
    expect(sessions.get(session.id).sizeOwner).toBe('c1');
    // And the desktop no longer wins.
    expect(sessions.resize(session.id, 120, 40, 'desktop')).toBe(false);
  });

  // The width has to be able to go both ways. It only went one way at first,
  // which left a terminal opened on a phone painting into a phone-shaped corner
  // of the window for as long as the phone stayed connected — and nothing at
  // the desk could take it back.
  it('gives the width back to whichever screen is being used', () => {
    const { sessions, pty, session } = registry();

    sessions.claimSize(session.id, 'phone-1', 45, 30);
    expect(pty.resized.at(-1)).toEqual([45, 30]);
    expect(sessions.resize(session.id, 200, 50, 'desktop')).toBe(false);

    // Sitting back down at the window.
    sessions.claimSize(session.id, 'desktop', 200, 50);
    expect(sessions.get(session.id).sizeOwner).toBe('desktop');
    expect(pty.resized.at(-1)).toEqual([200, 50]);
    expect(sessions.resize(session.id, 180, 45, 'desktop')).toBe(true);

    // And back to the phone again, without anything having to disconnect.
    sessions.claimSize(session.id, 'phone-1', 45, 30);
    expect(pty.resized.at(-1)).toEqual([45, 30]);
  });

  it('tells every viewer who owns the width now', () => {
    const { sessions, session } = registry();
    const seen = [];
    sessions.on('session', (e) => seen.push(e.session.sizeOwner));

    sessions.claimSize(session.id, 'phone-1', 45, 30);
    expect(seen).toContain('phone-1');

    sessions.claimSize(session.id, 'desktop', 200, 50);
    expect(seen.at(-1)).toBe('desktop');
  });

  it('nudges a full-screen program into repainting, and leaves a plain one alone', () => {
    const { sessions, pty, session } = registry();

    expect(sessions.nudge(session.id)).toBe(false);
    expect(pty.resized).toHaveLength(0);

    pty.say('\u001b[?1049h');
    expect(sessions.nudge(session.id)).toBe(true);
    expect(pty.resized[0]).toEqual([79, 24]);
  });

  it('stops and starts the pty for flow control', () => {
    const { sessions, pty, session } = registry();
    sessions.flow(session.id, true);
    expect(pty.paused).toBe(true);
    sessions.flow(session.id, false);
    expect(pty.paused).toBe(false);
  });

  it('forgets a terminal that exited, and says so once', () => {
    const { sessions, pty, session } = registry();
    const closed = [];
    sessions.on('exit', (e) => closed.push(e));

    pty.die(0);

    expect(closed).toEqual([{ id: session.id, exitCode: 0 }]);
    expect(sessions.has(session.id)).toBe(false);
    expect(sessions.history(session.id, 0)).toBe(null);
  });

  it('killAll takes every terminal with it', () => {
    const { sessions, pty } = registry();
    sessions.killAll();
    expect(pty.killed).toBe(true);
    expect(sessions.count()).toBe(0);
  });

  it('lets a spawn failure through to whoever asked', () => {
    const sessions = createSessions({
      spawn: () => { throw new Error('spawn ENOENT'); },
    });
    expect(() => sessions.create({ projectPath: 'C:\\nope' })).toThrow('spawn ENOENT');
    expect(sessions.count()).toBe(0);
  });

  it('goes quiet after the idle stretch, and says so', () => {
    vi.useFakeTimers();
    try {
      const { sessions, pty, session } = registry({ idleMs: 100, classifyMs: 10 });
      const idle = [];
      sessions.on('idle', (e) => idle.push(e));

      pty.say('Edit(login.jsx)');
      vi.advanceTimersByTime(20);
      expect(sessions.get(session.id).state).toBe('implementing');

      vi.advanceTimersByTime(120);
      expect(sessions.get(session.id).state).toBe('ready');
      expect(idle).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
