import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MIN_AGE_MS,
  COLLAPSE_AT,
  parseWindowsSample,
  parsePsRows,
  parseLsofPorts,
  parseUnixSample,
  parseGpuCounters,
  rates,
  byParent,
  jobRoots,
  subtree,
  summarise,
  collapseSiblings,
  createAgeTracker,
  buildView,
  samplerCommand,
  createMonitor,
  createSystemReader,
} = require('../processes.js');

/**
 * The tree this was written against, read off a real Hangar: four terminals,
 * each a powershell running claude, and under one of them a test suite that had
 * got as far as a headless Chrome.
 */
const SHELL = 3120;
const CLAUDE = 31820;

function win(pid, ppid, name, ticks, rss, command = '') {
  return [pid, ppid, name, ticks, rss, command];
}

const LIVE_ROWS = [
  win(29720, 32004, 'Hangar.exe', 1_000_000, 200e6),
  win(SHELL, 29720, 'powershell.exe', 500_000, 60e6, 'powershell.exe -NoLogo -NoExit -Command claude'),
  win(CLAUDE, SHELL, 'claude.exe', 900_000, 300e6, '"C:\\Users\\James\\AppData\\Roaming\\npm\\claude.exe"'),
  win(25100, CLAUDE, 'bash.exe', 10_000, 5e6, '"C:\\Program Files\\Git\\bin\\bash.exe" -c "source run"'),
  win(16412, 25100, 'python.exe', 4_000_000, 90e6, 'C:\\Python313\\python.exe run_tests.py test_lobby.py'),
  win(11068, 16412, 'chrome.exe', 2_000_000, 150e6, '"C:\\chrome.exe" --headless=new'),
  win(18940, 11068, 'chrome.exe', 100_000, 40e6, '"C:\\chrome.exe" --type=gpu-process'),
  win(22244, 11068, 'chrome.exe', 100_000, 40e6, '"C:\\chrome.exe" --type=renderer'),
  win(31412, 11068, 'chrome.exe', 100_000, 40e6, '"C:\\chrome.exe" --type=renderer'),
  win(25168, 25100, 'conhost.exe', 1000, 6e6),
];

function sample(rows = LIVE_ROWS, ports = [], t = 1000) {
  return JSON.stringify({ t, p: rows, l: ports });
}

const SESSION = { id: 's1', title: 'fix login redirect', projectName: 'Hangar', pid: SHELL };

describe('parsing what the samplers print', () => {
  it('reads a windows line into rows and ports', () => {
    const parsed = parseWindowsSample(sample(LIVE_ROWS, [[16412, 5173]], 4242));
    expect(parsed.at).toBe(4242);
    expect(parsed.rows).toHaveLength(LIVE_ROWS.length);
    expect(parsed.rows[1]).toMatchObject({ pid: SHELL, ppid: 29720, name: 'powershell.exe' });
    expect(parsed.ports).toEqual([{ pid: 16412, port: 5173 }]);
  });

  it('treats a half-written line as nothing rather than throwing', () => {
    expect(parseWindowsSample('{"t":1,"p":[[1,0,"a"')).toBeNull();
    expect(parseWindowsSample('')).toBeNull();
    expect(parseWindowsSample('null')).toBeNull();
  });

  it('skips rows it cannot make sense of instead of the whole sample', () => {
    const parsed = parseWindowsSample(JSON.stringify({
      t: 1, p: [win(5, 1, 'ok.exe', 0, 0), 'nonsense', [null, 1, 'bad']], l: ['nope'],
    }));
    expect(parsed.rows.map((r) => r.pid)).toEqual([5]);
    expect(parsed.ports).toEqual([]);
  });

  it('keeps a command line containing spaces whole', () => {
    const rows = parsePsRows([
      '  501  1  12.5  204800 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=gpu',
      '  502  501  0.0  1024 node server.js',
      'ignore this line',
    ].join('\n'));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 501, ppid: 1, cpu: 12.5, rss: 204800 * 1024 });
    expect(rows[0].command).toContain('--type=gpu');
    expect(rows[1].name).toBe('node');
  });

  it('pairs lsof addresses with the pid above them', () => {
    expect(parseLsofPorts('p900\nn*:5173\nn127.0.0.1:8080\np901\nn[::1]:3000\n')).toEqual([
      { pid: 900, port: 5173 },
      { pid: 900, port: 8080 },
      { pid: 901, port: 3000 },
    ]);
  });

  it('splits a unix block into its two halves', () => {
    const parsed = parseUnixSample('  1  0  0.5  1024 /sbin/launchd\n---PORTS---\np1\nn*:22\n', 77);
    expect(parsed.at).toBe(77);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.ports).toEqual([{ pid: 1, port: 22 }]);
  });

  it('adds a process gpu engines up and ignores anything unparsable', () => {
    const out = parseGpuCounters('12232 4.85\n12232 0.02\n21128 3.13\nnot a line\n');
    expect([...out.keys()]).toEqual([12232, 21128]);
    expect(out.get(12232)).toBeCloseTo(4.87, 5);
    expect(out.get(21128)).toBeCloseTo(3.13, 5);
  });
});

describe('cpu', () => {
  it('is the difference between two samples, over the whole machine', () => {
    const prev = parseWindowsSample(sample([win(1, 0, 'a.exe', 0, 0)], [], 0));
    // 100ns ticks: 40,000,000 of them is 4 seconds of cpu.
    const next = parseWindowsSample(sample([win(1, 0, 'a.exe', 40_000_000, 0)], [], 2000));

    // 4s of cpu in 2s of wall clock on 4 cores is half the machine.
    expect(rates(prev, next, 4).get(1)).toBeCloseTo(50, 5);
    expect(rates(prev, next, 8).get(1)).toBeCloseTo(25, 5);
  });

  it('credits a process that has only just appeared with nothing', () => {
    const prev = parseWindowsSample(sample([win(1, 0, 'a.exe', 0, 0)], [], 0));
    const next = parseWindowsSample(sample(
      [win(1, 0, 'a.exe', 0, 0), win(2, 1, 'new.exe', 9_000_000_000, 0)], [], 2000,
    ));
    expect(rates(prev, next, 4).get(2)).toBe(0);
  });

  it('reports nothing at all when there is no previous sample to subtract', () => {
    const next = parseWindowsSample(sample([win(1, 0, 'a.exe', 40_000_000, 0)], [], 2000));
    expect(rates(null, next, 4).get(1)).toBe(0);
  });

  it('takes the percentage ps already worked out, without subtracting', () => {
    const next = parseUnixSample('  7  1  33.5  1024 node server.js\n---PORTS---\n', 5);
    expect(rates(null, next, 4).get(7)).toBe(33.5);
  });
});

describe('finding the jobs under a terminal', () => {
  const rows = parseWindowsSample(sample()).rows;
  const kids = byParent(rows);

  it('steps through the shell and the agent to what is actually running', () => {
    // Not powershell (that is the terminal) and not claude (that is the agent).
    expect(jobRoots(kids, SHELL).map((r) => r.pid)).toEqual([25100]);
  });

  it('reports what was typed directly in a plain shell tab', () => {
    const plain = parseWindowsSample(sample([
      win(100, 1, 'powershell.exe', 0, 0),
      win(101, 100, 'node.exe', 0, 0, 'node server.js'),
    ])).rows;
    expect(jobRoots(byParent(plain), 100).map((r) => r.name)).toEqual(['node.exe']);
  });

  it('answers with nothing for a terminal sitting at its prompt', () => {
    const idle = parseWindowsSample(sample([
      win(100, 1, 'powershell.exe', 0, 0),
      win(101, 100, 'claude.exe', 0, 0),
    ])).rows;
    expect(jobRoots(byParent(idle), 100)).toEqual([]);
  });

  it('does not walk forever if a sample describes a cycle', () => {
    const looped = parseWindowsSample(sample([
      win(100, 1, 'powershell.exe', 0, 0),
      win(101, 100, 'claude.exe', 0, 0),
      win(100, 101, 'powershell.exe', 0, 0),
    ])).rows;
    expect(() => jobRoots(byParent(looped), 100)).not.toThrow();
  });

  it('collects everything below a root', () => {
    const root = rows.find((r) => r.pid === 25100);
    expect(subtree(kids, root).map((r) => r.pid).sort()).toEqual(
      [25100, 25168, 11068, 16412, 18940, 22244, 31412].sort(),
    );
  });
});

describe('how a row reads', () => {
  it('drops the executable path and keeps the arguments', () => {
    expect(summarise('python.exe', 'C:\\Python313\\python.exe run_tests.py test_lobby.py'))
      .toBe('python.exe run_tests.py test_lobby.py');
  });

  it('handles a quoted path with spaces in it', () => {
    expect(summarise('bash.exe', '"C:\\Program Files\\Git\\bin\\bash.exe" -c "source run"'))
      .toBe('bash.exe -c "source run"');
  });

  it('falls back to the name when there is no command line', () => {
    expect(summarise('node.exe', '')).toBe('node.exe');
    expect(summarise('node.exe', undefined)).toBe('node.exe');
  });

  it('truncates something enormous rather than letting it out', () => {
    const long = summarise('a.exe', `a.exe ${'x'.repeat(500)}`);
    expect(long.length).toBeLessThanOrEqual(96);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('collapsing siblings', () => {
  const many = (n, name) => Array.from({ length: n }, (_, i) => ({
    pid: i + 1, name, label: name, cpu: 1, gpu: 2, rss: 10, ports: [],
  }));

  it('leaves a handful of them alone', () => {
    const out = collapseSiblings(many(COLLAPSE_AT - 1, 'chrome.exe'));
    expect(out).toHaveLength(COLLAPSE_AT - 1);
  });

  it('folds a crowd into one row that adds up', () => {
    const [row] = collapseSiblings(many(8, 'chrome.exe'));
    expect(row.label).toBe('chrome.exe ×8');
    expect(row.count).toBe(8);
    expect(row.cpu).toBe(8);
    expect(row.rss).toBe(80);
    // A headless browser is the thing that both collapses and uses the GPU, so
    // this is the one number a fold must not drop.
    expect(row.gpu).toBe(16);
  });

  it('puts the busiest first', () => {
    const out = collapseSiblings([
      { pid: 1, name: 'a', label: 'a', cpu: 1, rss: 0, ports: [] },
      { pid: 2, name: 'b', label: 'b', cpu: 9, rss: 0, ports: [] },
    ]);
    expect(out.map((r) => r.name)).toEqual(['b', 'a']);
  });
});

describe('the view the panel draws', () => {
  const now = 100_000;
  const prev = parseWindowsSample(sample(LIVE_ROWS, [], 0));
  const current = parseWindowsSample(sample(LIVE_ROWS, [[16412, 5173]], 2000));

  const view = buildView({
    sample: current, prev, sessions: [SESSION], cores: 4, now,
  });

  it('groups the jobs under the terminal that started them', () => {
    expect(view.sessions).toHaveLength(1);
    expect(view.sessions[0].title).toBe('fix login redirect');
    expect(view.sessions[0].jobs).toHaveLength(1);
  });

  it('names the job after what it is running', () => {
    expect(view.sessions[0].jobs[0].label).toBe('bash.exe -c "source run"');
  });

  it('counts the whole subtree into the job, minus the console host', () => {
    // bash, python and four chromes — conhost is furniture.
    expect(view.sessions[0].jobs[0].count).toBe(6);
  });

  it('carries a listening port up from wherever in the tree it was found', () => {
    expect(view.sessions[0].jobs[0].ports).toEqual([5173]);
  });

  it('collapses the chrome fleet inside the job', () => {
    const labels = view.sessions[0].jobs[0].children.map((c) => c.label);
    expect(labels).toContain('chrome.exe ×4');
  });

  it('adds the sessions up into totals', () => {
    expect(view.totals.jobs).toBe(1);
    expect(view.totals.rss).toBe(view.sessions[0].jobs[0].rss);
  });

  it('answers emptily rather than throwing when there is no sample yet', () => {
    expect(buildView({ sample: null })).toEqual({
      at: 0, sessions: [], totals: { cpu: 0, rss: 0, jobs: 0 } },
    );
  });

  it('lists a terminal with nothing running as a terminal with no jobs', () => {
    const quiet = buildView({
      sample: parseWindowsSample(sample([
        win(100, 1, 'powershell.exe', 0, 0), win(101, 100, 'claude.exe', 0, 0),
      ])),
      sessions: [{ id: 's2', title: 'idle', projectName: 'p', pid: 100 }],
    });
    expect(quiet.sessions[0].jobs).toEqual([]);
    expect(quiet.totals.jobs).toBe(0);
  });

  it('hides a job that has only just started, and shows it once it stays', () => {
    const ages = createAgeTracker();
    const args = { sample: current, prev, sessions: [SESSION], cores: 4 };

    ages.saw(current, 0);
    expect(buildView({ ...args, now: 0, ageOf: ages.ageOf }).totals.jobs).toBe(0);
    expect(buildView({ ...args, now: MIN_AGE_MS, ageOf: ages.ageOf }).totals.jobs).toBe(1);
  });

  it('applies gpu figures from the slow lane when there are any', () => {
    const withGpu = buildView({
      sample: current, prev, sessions: [SESSION], cores: 4, now,
      gpu: new Map([[18940, 12.5]]),
    });
    expect(withGpu.sessions[0].jobs[0].gpu).toBeCloseTo(12.5, 5);
  });
});

describe('ages', () => {
  it('forgets a pid that goes away, so a reused one is not treated as old', () => {
    const ages = createAgeTracker();
    const one = parseWindowsSample(sample([win(7, 1, 'a.exe', 0, 0)]));
    const none = parseWindowsSample(sample([win(8, 1, 'b.exe', 0, 0)]));

    ages.saw(one, 0);
    expect(ages.ageOf(7, 5000)).toBe(5000);

    ages.saw(none, 6000);        // 7 has gone
    ages.saw(one, 7000);         // and something else is now 7
    expect(ages.ageOf(7, 7000)).toBe(0);
  });
});

describe('the samplers', () => {
  it('asks windows through one long-lived powershell', () => {
    const { file, args } = samplerCommand('win32', 2000);
    expect(file).toBe('powershell.exe');
    expect(args).toContain('-NoProfile');
    expect(args.join(' ')).toContain('Win32_Process');
    expect(args.join(' ')).toContain('Start-Sleep -Milliseconds 2000');
  });

  it('asks everywhere else through one shell loop, in whole seconds', () => {
    const { file, args } = samplerCommand('darwin', 2000);
    expect(file).toBe('/bin/sh');
    expect(args.join(' ')).toContain('ps -Ao');
    expect(args.join(' ')).toContain('sleep 2');
  });
});

/** A child process that is only a stdout to push lines into. */
function fakeChild() {
  const handlers = new Map();
  const child = {
    killed: false,
    stdout: { on: (_e, fn) => { child.push = fn; } },
    on: (event, fn) => { handlers.set(event, fn); },
    kill: () => { child.killed = true; },
  };
  return child;
}

describe('the monitor', () => {
  function harness(extra = {}) {
    const spawned = [];
    // A clock that moves a tick per read, so the age filter behaves as it would
    // over real seconds rather than hiding everything inside one millisecond.
    let clock = 0;
    const monitor = createMonitor({
      platform: 'win32',
      cores: 4,
      now: () => { clock += MIN_AGE_MS; return clock; },
      spawnFn: (file, args, opts) => {
        const child = fakeChild();
        spawned.push({ file, args, opts, child });
        return child;
      },
      ...extra,
    });
    return { monitor, spawned };
  }

  it('starts one sampler however many times it is asked', () => {
    const { monitor, spawned } = harness();
    expect(monitor.start()).toBe(true);
    monitor.start();
    monitor.start();
    expect(spawned).toHaveLength(1);
    expect(monitor.running()).toBe(true);
  });

  it('kills the sampler on stop, and can be started again after', () => {
    const { monitor, spawned } = harness();
    monitor.start();
    monitor.stop();
    expect(spawned[0].child.killed).toBe(true);
    expect(monitor.running()).toBe(false);

    monitor.start();
    expect(spawned).toHaveLength(2);
  });

  it('builds a view per line and hands it to whoever is listening', () => {
    const { monitor, spawned } = harness();
    const seen = [];
    monitor.useSessions(() => [SESSION]);
    monitor.on((view) => seen.push(view));
    monitor.start();

    spawned[0].child.push(`${sample(LIVE_ROWS, [], 0)}\n`);
    spawned[0].child.push(`${sample(LIVE_ROWS, [], 2000)}\n`);

    expect(seen).toHaveLength(2);
    expect(seen[1].sessions[0].jobs[0].name).toBe('bash.exe');
  });

  it('waits for a line to be whole before reading it', () => {
    const { monitor, spawned } = harness();
    const seen = [];
    monitor.useSessions(() => [SESSION]);
    monitor.on((view) => seen.push(view));
    monitor.start();

    const line = sample();
    spawned[0].child.push(line.slice(0, 40));
    expect(seen).toHaveLength(0);
    spawned[0].child.push(`${line.slice(40)}\n`);
    expect(seen).toHaveLength(1);
  });

  it('survives a sampler that will not start', () => {
    const { monitor } = harness({
      spawnFn: () => { throw new Error('powershell is not on PATH'); },
    });
    expect(monitor.start()).toBe(false);
    expect(monitor.running()).toBe(false);
    expect(monitor.view()).toBeNull();
  });

  it('survives a listener that throws', () => {
    const { monitor, spawned } = harness();
    monitor.on(() => { throw new Error('the panel is gone'); });
    monitor.start();
    expect(() => spawned[0].child.push(`${sample()}\n`)).not.toThrow();
  });

  it('does not spawn the gpu lane unless it is asked for', () => {
    const { monitor, spawned } = harness();
    monitor.start();
    expect(spawned).toHaveLength(1);

    monitor.setGpu(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args.join(' ')).toContain('GPU Engine');

    monitor.setGpu(false);
    expect(spawned[1].child.killed).toBe(true);
  });

  it('refuses the gpu lane off windows, where the counter does not exist', () => {
    const { monitor } = harness({ platform: 'darwin' });
    expect(monitor.gpuAvailable()).toBe(false);
    expect(monitor.setGpu(true)).toBe(false);
  });
});

describe('the sparkline numbers', () => {
  function reader(series) {
    let i = 0;
    let clock = 0;
    return createSystemReader({
      cpus: () => series[Math.min(i++, series.length - 1)],
      freemem: () => 4e9,
      totalmem: () => 16e9,
      now: () => { clock += 1000; return clock; },
    });
  }

  const core = (idle, busy) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });

  it('reports nothing on the very first read rather than the average since boot', () => {
    expect(reader([[core(1000, 9000)]]).read().cpu).toBe(0);
  });

  it('is the share of ticks that were not idle between two reads', () => {
    const r = reader([[core(1000, 0)], [core(1500, 500)]]);
    r.read();
    expect(r.read().cpu).toBeCloseTo(50, 5);
  });

  it('gives memory as a share of the machine', () => {
    const out = reader([[core(0, 0)]]).read();
    expect(out.mem).toBeCloseTo(75, 5);
    expect(out.memUsed).toBe(12e9);
  });
});
