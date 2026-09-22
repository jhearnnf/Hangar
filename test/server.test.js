import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createServer } from '../server.js';
import { createSessions } from '../sessions.js';
import { createDevices } from '../devices.js';

/**
 * The phone's half of this is a WebSocket and some JSON, so the test can be
 * one too. Everything below talks to a real listening server over a real
 * socket — the only thing faked is the pty at the bottom, because a test that
 * spawns shells is a test that is slow and platform-shaped.
 */

function fakePty() {
  const listeners = { data: [], exit: [] };
  return {
    pid: 99,
    written: [],
    onData: (cb) => listeners.data.push(cb),
    onExit: (cb) => listeners.exit.push(cb),
    write(data) { this.written.push(data); },
    resize() {},
    kill() { for (const cb of listeners.exit) cb({ exitCode: 0 }); },
    pause() {},
    resume() {},
    say(text) { for (const cb of listeners.data) cb(text); },
  };
}

/** A phone: connects, collects what arrives, and can wait for one message. */
function phone(port, token) {
  const query = token ? `?token=${token}` : '';
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  const seen = [];
  const waiting = [];

  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    seen.push(message);
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (waiting[i].match(message)) waiting.splice(i, 1)[0].resolve(message);
    }
  });

  return {
    ws,
    seen,
    open: () => new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) return resolve();
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send: (message) => ws.send(JSON.stringify(message)),
    /** The next message of this kind, or the first one already sitting there. */
    next(t, extra = () => true) {
      const match = (m) => m.t === t && extra(m);
      const already = seen.find(match);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`waited too long for "${t}"`)), 3000);
        waiting.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    closed: () => new Promise((resolve) => ws.once('close', (code) => resolve(code))),
    close: () => ws.close(),
  };
}

function counterRandom() {
  let n = 0;
  return (bytes) => Buffer.alloc(bytes, (n += 11) % 251);
}

describe('the server a phone talks to', () => {
  let pty;
  let sessions;
  let devices;
  let server;
  let port;
  let phones;
  let agentId;

  beforeEach(async () => {
    agentId = 'claude';
    pty = fakePty();
    sessions = createSessions({
      spawn: () => ({ proc: pty, shell: 'pwsh.exe', cwd: 'C:\\work\\demo', args: [] }),
    });
    devices = createDevices({ random: counterRandom() });
    phones = [];

    server = createServer({
      sessions,
      devices,
      listProjects: () => ({ root: 'C:\\work', projects: [{ name: 'demo', path: 'C:\\work\\demo' }], ignored: [] }),
      createProject: (name) => ({ ok: true, project: { name, path: `C:\\work\\${name}` }, projects: [] }),
      usage: async () => ({ available: false }),
      backup: async () => ({ ok: true, message: 'backed up' }),
      recentSessions: (projectPath) => (projectPath === 'C:\\work\\demo'
        ? [{ id: 'f1e2d3c4-0000-4000-8000-000000000001', label: 'add a sidebar', at: 1000, live: false, command: 'claude --resume f1e2d3c4-0000-4000-8000-000000000001' }]
        : []),
      setAgent: (id) => {
        if (id !== 'codex') return { ok: false, message: 'Unknown agent.' };
        agentId = id;
        server.broadcastInfo();
        return { ok: true };
      },
      info: () => ({ app: 'Hangar', name: 'TEST-PC', agent: { id: agentId } }),
    });

    ({ port } = await server.start(0));
  });

  afterEach(() => {
    for (const p of phones) p.close();
    server.dispose();
    sessions.killAll();
  });

  function connect(token) {
    const p = phone(port, token);
    phones.push(p);
    return p;
  }

  it('says nothing at all to a phone that has not paired', async () => {
    const p = connect();
    await p.open();
    p.send({ t: 'projects' });

    const code = await p.closed();
    expect(code).toBe(4001);
    expect(p.seen.some((m) => m.t === 'welcome')).toBe(false);
    expect(p.seen.some((m) => m.t === 'projects')).toBe(false);
  });

  it('refuses a wrong code without giving up the socket', async () => {
    devices.newCode();
    const p = connect();
    await p.open();
    p.send({ t: 'pair', code: 'WRONG1', name: 'Pixel' });

    const error = await p.next('error');
    expect(error.message).toMatch(/not the one/i);
    expect(p.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('gives up after five wrong codes, and cancels the code with it', async () => {
    devices.newCode();
    const p = connect();
    await p.open();

    for (let i = 0; i < 5; i++) p.send({ t: 'pair', code: 'WRONG1', name: 'Pixel' });
    p.send({ t: 'pair', code: 'WRONG1', name: 'Pixel' });

    expect(await p.closed()).toBe(4029);
    expect(devices.currentCode()).toBe(null);
  });

  it('trades the right code for a key and the state of everything', async () => {
    const { code } = devices.newCode();
    const p = connect();
    await p.open();
    p.send({ t: 'pair', code, name: 'Pixel' });

    const paired = await p.next('paired');
    expect(paired.token).toMatch(/^[0-9a-f]{64}$/);

    const welcome = await p.next('welcome');
    expect(welcome.name).toBe('TEST-PC');
    expect(welcome.projects).toEqual([{ name: 'demo', path: 'C:\\work\\demo' }]);
    expect(welcome.sessions).toEqual([]);
  });

  it('lets a phone with a key straight in, no code needed', async () => {
    const { code } = devices.newCode();
    const first = connect();
    await first.open();
    first.send({ t: 'pair', code, name: 'Pixel' });
    const { token } = await first.next('paired');
    first.close();

    const again = connect(token);
    await again.open();
    const welcome = await again.next('welcome');
    expect(welcome.device.name).toBe('Pixel');
  });

  async function paired() {
    const { code } = devices.newCode();
    const p = connect();
    await p.open();
    p.send({ t: 'pair', code, name: 'Pixel' });
    await p.next('welcome');
    return p;
  }

  it('switches the agent for a phone and tells every phone', async () => {
    const p = await paired();
    const other = await paired();
    p.send({ t: 'agent', id: 'codex' });

    expect((await p.next('info')).agent.id).toBe('codex');
    expect((await other.next('info')).agent.id).toBe('codex');
  });

  it('says why an agent switch was refused', async () => {
    const p = await paired();
    p.send({ t: 'agent', ref: 7, id: 'nope' });

    const error = await p.next('error');
    expect(error.ref).toBe(7);
    expect(error.message).toBe('Unknown agent.');
  });

  it('opens a terminal for a phone and attaches it', async () => {
    const p = await paired();
    p.send({ t: 'create', ref: 1, projectPath: 'C:\\work\\demo', projectName: 'demo', command: 'claude', cols: 45, rows: 30 });

    const created = await p.next('created');
    expect(created.session.projectName).toBe('demo');
    expect(sessions.count()).toBe(1);

    pty.say('hello from the shell');
    const data = await p.next('data', (m) => m.data.includes('hello'));
    expect(data.id).toBe(created.session.id);
    expect(data.seq).toBe(20);
  });

  it('tells a phone what claude has been used for in a project', async () => {
    const p = await paired();
    p.send({ t: 'recent', projectPath: 'C:\\work\\demo' });

    const answer = await p.next('recent');
    // The path comes back with it: a thumb can have let go and pressed another
    // project before this arrives, and the phone has to be able to tell.
    expect(answer.projectPath).toBe('C:\\work\\demo');
    expect(answer.rows).toHaveLength(1);
    expect(answer.rows[0].command).toContain('--resume');
  });

  it('answers an empty list for a project claude has never been run in', async () => {
    const p = await paired();
    p.send({ t: 'recent', projectPath: 'C:\\work\\somewhere-else' });
    expect((await p.next('recent')).rows).toEqual([]);
  });

  it('sends only what a phone missed when it comes back', async () => {
    const first = await paired();
    first.send({ t: 'create', ref: 1, projectPath: 'C:\\work\\demo', projectName: 'demo' });
    const { session } = await first.next('created');

    pty.say('AAAA');
    pty.say('BBBB');
    await first.next('data', (m) => m.data.includes('BBBB'));

    // The same phone, back after a drop, saying how far it had got: it had the
    // first four characters and wants everything after them.
    first.send({ t: 'attach', id: session.id, seq: 4 });

    const caught = await first.next('data', (m) => m.seq === 8 && m.data === 'BBBB');
    expect(caught.reset).toBe(false);
  });

  it('says to start again when what was missed has scrolled away', async () => {
    const small = createSessions({
      spawn: () => ({ proc: pty, shell: 'pwsh.exe', cwd: 'C:\\work\\demo', args: [] }),
      scrollbackBytes: 4,
    });
    const other = createServer({
      sessions: small,
      devices,
      listProjects: () => ({ root: 'C:\\work', projects: [], ignored: [] }),
      createProject: () => ({ ok: false }),
      usage: async () => ({}),
      backup: async () => ({ ok: true }),
    });
    const { port: otherPort } = await other.start(0);

    try {
      const { code } = devices.newCode();
      const p = phone(otherPort);
      phones.push(p);
      await p.open();
      p.send({ t: 'pair', code, name: 'Pixel' });
      await p.next('welcome');

      const session = small.create({ projectPath: 'C:\\work\\demo', projectName: 'demo' });
      pty.say('AAAA');
      pty.say('BBBB');

      p.send({ t: 'attach', id: session.id, seq: 0 });
      const caught = await p.next('data', (m) => m.reset === true);
      expect(caught.data).toBe('BBBB');
    } finally {
      other.dispose();
      small.killAll();
    }
  });

  it('passes typing through to the shell', async () => {
    const p = await paired();
    p.send({ t: 'create', ref: 1, projectPath: 'C:\\work\\demo', projectName: 'demo' });
    const { session } = await p.next('created');

    p.send({ t: 'input', id: session.id, data: 'fix the login redirect\r' });
    await new Promise((r) => setTimeout(r, 50));

    expect(pty.written.join('')).toBe('fix the login redirect\r');
  });

  it('tells every phone about a terminal any of them opened', async () => {
    const one = await paired();
    const { code } = devices.newCode();
    const two = connect();
    await two.open();
    two.send({ t: 'pair', code, name: 'Tablet' });
    await two.next('welcome');

    one.send({ t: 'create', ref: 1, projectPath: 'C:\\work\\demo', projectName: 'demo' });

    const heard = await two.next('session', (m) => m.kind === 'created');
    expect(heard.session.projectName).toBe('demo');
  });

  it('tells the phone when a terminal ends', async () => {
    const p = await paired();
    p.send({ t: 'create', ref: 1, projectPath: 'C:\\work\\demo', projectName: 'demo' });
    const { session } = await p.next('created');

    p.send({ t: 'kill', id: session.id });
    const gone = await p.next('session', (m) => m.kind === 'closed');
    expect(gone.session.id).toBe(session.id);
  });

  it('hands a claimed width back to the desktop when the phone goes', async () => {
    const p = await paired();
    p.send({ t: 'create', ref: 1, projectPath: 'C:\\work\\demo', projectName: 'demo', claim: true, cols: 45, rows: 30 });
    const { session } = await p.next('created');
    expect(sessions.get(session.id).sizeOwner).not.toBe('desktop');

    p.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(sessions.get(session.id).sizeOwner).toBe('desktop');
  });

  it('hands the width back when the phone leaves the terminal or is put down', async () => {
    const p = await paired();
    p.send({ t: 'create', ref: 1, projectPath: 'C:\\work\\demo', projectName: 'demo', claim: true, cols: 45, rows: 30 });
    const { session } = await p.next('created');

    p.send({ t: 'release', id: session.id });
    await p.next('session', (m) => m.session.sizeOwner === 'desktop');

    p.send({ t: 'resize', id: session.id, claim: true, cols: 45, rows: 30 });
    await p.next('session', (m) => m.session.sizeOwner !== 'desktop');

    p.send({ t: 'detach', id: session.id });
    await p.next('session', (m) => m.session.sizeOwner === 'desktop');
  });

  it("leaves another phone's width alone when this one lets go", async () => {
    const holder = await paired();
    const other = await paired();
    holder.send({ t: 'create', ref: 1, projectPath: 'C:\\work\\demo', projectName: 'demo', claim: true, cols: 45, rows: 30 });
    const { session } = await holder.next('created');

    other.send({ t: 'release', id: session.id });
    other.send({ t: 'detach', id: session.id });
    await new Promise((r) => setTimeout(r, 100));

    expect(sessions.get(session.id).sizeOwner).not.toBe('desktop');
  });

  it('answers a health check without a socket, for anyone wondering if it is up', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, name: 'TEST-PC' });
  });

  it('shuts the door completely when it is stopped', async () => {
    const p = await paired();
    server.stop();
    await p.closed();

    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
