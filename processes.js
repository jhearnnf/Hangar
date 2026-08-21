'use strict';

const os = require('os');
const { spawn } = require('child_process');

/**
 * What the terminals are actually running, underneath the terminals.
 *
 * A `claude` that has started a dev server or a test suite leaves it running
 * somewhere below itself, and until now there was no way to see any of it: the
 * tab shows whatever the TUI is painting, and the thing chewing a core is three
 * processes further down. Task Manager can see the processes but not which
 * terminal they belong to, which is the half that matters.
 *
 * So this walks down from each session's shell and reports what it finds,
 * grouped by the terminal that started it.
 *
 * Three things are worth knowing before changing any of it.
 *
 * The measuring is not free, so it only happens while somebody is looking. The
 * sidebar's sparkline is a different thing entirely — `os.cpus()` in the main
 * process, which costs nothing and needs no child — and this heavier walk runs
 * only between `start()` and `stop()`.
 *
 * The sampling is one long-lived child rather than a child per tick. Spawning a
 * PowerShell costs more than the query it would run (~300ms of startup against
 * ~70ms of work), so one is started, loops on its own, and prints a line of
 * JSON per tick until it is killed.
 *
 * GPU is off unless asked for, and that is a measurement rather than a
 * preference: `\GPU Engine(*)\Utilization Percentage` takes 2.7 seconds to
 * answer on a machine with 469 engine instances, which is longer than the tick
 * it would be part of. It runs on its own slow lane when switched on, and
 * nothing at all when it is not.
 */

// How often the sampler emits. Two seconds is fast enough that starting a
// server feels acknowledged and slow enough that the walk is a rounding error.
const TICK_MS = 2000;

// The GPU lane, which is its own child and its own much slower clock.
const GPU_TICK_MS = 10_000;
const GPU_TIMEOUT_MS = 8000;

// A job younger than this is not shown. Claude runs a great many very short
// commands — a `git status`, an `ls` — and each one is a real process that
// would appear for one tick and go. What this panel is for is the things that
// stay, so the things that don't are given a moment to prove they will.
const MIN_AGE_MS = 1500;

// Never worth a row of its own. The shell and the agent are on every session by
// definition, so listing them would be listing the furniture; conhost is
// Windows' own console host, attached to things rather than doing anything.
const AGENT_NAMES = new Set(['claude', 'claude.exe']);
const HIDDEN_NAMES = new Set(['conhost.exe', 'openconsole.exe']);

// Below a job root, this many children sharing one name stop being interesting
// individually — a headless Chrome is eight renderers and a GPU process, and
// nine rows of "chrome.exe" say less than one row saying nine.
const COLLAPSE_AT = 3;

// Command lines are truncated by the sampler; this is what a row shows.
const SUMMARY_CHARS = 96;

// ------------------------------------------------------------------- parsing

/** Windows sampler rows: [pid, ppid, name, cpuTicks, rss, commandLine]. */
function parseWindowsSample(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null; // a half-written line, or PowerShell saying something we didn't ask for
  }
  if (!obj || typeof obj !== 'object') return null;

  const rows = [];
  for (const r of Array.isArray(obj.p) ? obj.p : []) {
    if (!Array.isArray(r) || typeof r[0] !== 'number') continue;
    rows.push({
      pid: r[0],
      ppid: typeof r[1] === 'number' ? r[1] : 0,
      name: String(r[2] || ''),
      // 100ns units, cumulative since the process started. Turned into a
      // percentage by `rates` once there are two samples to subtract.
      cpuTicks: typeof r[3] === 'number' ? r[3] : 0,
      rss: typeof r[4] === 'number' ? r[4] : 0,
      command: r[5] ? String(r[5]) : '',
    });
  }

  const ports = [];
  for (const p of Array.isArray(obj.l) ? obj.l : []) {
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') {
      ports.push({ pid: p[0], port: p[1] });
    }
  }

  return { at: typeof obj.t === 'number' ? obj.t : Date.now(), rows, ports };
}

/**
 * `ps` output, which is four numbers and then a command line that may contain
 * anything at all — including spaces in the executable's own path, which is
 * why the free-form field is last and everything before it is fixed.
 */
function parsePsRows(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[5].trim();
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      // ps answers in percent directly, so there is no delta to take here. The
      // number means a slightly different thing from the Windows one — it is
      // decayed rather than instantaneous — which is a difference nobody
      // reading a resource panel is going to be misled by.
      cpu: Number(m[3]),
      rss: Number(m[4]) * 1024, // ps reports KB
      name: basename(firstWord(command)),
      command,
    });
  }
  return rows;
}

/** `lsof -Fpn` output: `p<pid>` lines followed by the `n<addr>` lines under them. */
function parseLsofPorts(text) {
  const ports = [];
  let pid = 0;
  for (const line of String(text).split('\n')) {
    const tag = line[0];
    const rest = line.slice(1).trim();
    if (tag === 'p') pid = Number(rest) || 0;
    else if (tag === 'n' && pid) {
      const m = /:(\d+)$/.exec(rest);
      if (m) ports.push({ pid, port: Number(m[1]) });
    }
  }
  return ports;
}

/** One framed block of the unix sampler's output. */
function parseUnixSample(block, now = Date.now()) {
  const [psPart = '', lsofPart = ''] = String(block).split('---PORTS---');
  return { at: now, rows: parsePsRows(psPart), ports: parseLsofPorts(lsofPart) };
}

function firstWord(s) {
  const i = String(s).indexOf(' ');
  return i === -1 ? String(s) : s.slice(0, i);
}

function basename(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

// --------------------------------------------------------------------- rates

/**
 * CPU as a percentage of one machine, from the difference between two samples.
 *
 * Divided by the core count so the number means the same thing the sparkline
 * and Task Manager mean: 100% is the whole machine busy, not one core of it.
 * A process that was not in the previous sample has no delta to take and is
 * left at zero rather than credited with every tick it has ever used, which is
 * what makes a freshly started process read as idle for one tick instead of as
 * a spike.
 */
function rates(prev, next, cores = os.cpus().length || 1) {
  const out = new Map();
  if (!next) return out;

  // Unix already answers in percent; there is nothing to subtract.
  if (next.rows.length && next.rows[0].cpu !== undefined) {
    for (const r of next.rows) out.set(r.pid, r.cpu);
    return out;
  }

  const elapsed = prev ? next.at - prev.at : 0;
  if (!prev || elapsed <= 0) {
    for (const r of next.rows) out.set(r.pid, 0);
    return out;
  }

  const before = new Map(prev.rows.map((r) => [r.pid, r]));
  for (const r of next.rows) {
    const was = before.get(r.pid);
    // Ticks are 100ns, so /1e4 is milliseconds of CPU spent.
    const usedMs = was ? (r.cpuTicks - was.cpuTicks) / 1e4 : 0;
    const pct = (usedMs / elapsed / cores) * 100;
    out.set(r.pid, Math.max(0, Math.min(100, pct)));
  }
  return out;
}

// ---------------------------------------------------------------- the tree

/** pid -> the rows whose parent it is. */
function byParent(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.ppid)) map.set(r.ppid, []);
    map.get(r.ppid).push(r);
  }
  return map;
}

function isAgent(row) {
  return AGENT_NAMES.has(String(row.name).toLowerCase());
}

function isHidden(row) {
  return HIDDEN_NAMES.has(String(row.name).toLowerCase());
}

/**
 * The jobs running under one terminal.
 *
 * A session's own pid is its shell, and directly under that is almost always
 * `claude` itself. Neither is a job — they are what a terminal *is* — so both
 * are stepped through rather than reported, and what comes out is the first
 * layer of things that are actually work: the `npm run dev`, the `pytest`, the
 * `powershell -Command` behind one of Claude's tool calls.
 *
 * A plain shell tab works out of the same rule with no special case: nothing
 * there is an agent, so the job roots are simply whatever was typed.
 */
function jobRoots(kids, shellPid) {
  const roots = [];
  const queue = [shellPid];
  const seen = new Set(queue);

  while (queue.length) {
    const pid = queue.shift();
    for (const child of kids.get(pid) || []) {
      // A tree cannot contain a cycle, but pids get reused and a stale sample
      // can describe one. Walking it forever would be the worse answer.
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (isAgent(child) || isHidden(child)) queue.push(child.pid);
      else roots.push(child);
    }
  }
  return roots;
}

/** Every row at or below `pid`, the root included. */
function subtree(kids, row) {
  const out = [];
  const queue = [row];
  const seen = new Set([row.pid]);
  while (queue.length) {
    const r = queue.shift();
    out.push(r);
    for (const child of kids.get(r.pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child);
    }
  }
  return out;
}

/**
 * What a row says it is.
 *
 * The executable's own path is the least informative part of a command line and
 * the longest, so it goes: what is left is the program's name and the arguments
 * that say which run of it this is — `python run_tests.py test_lobby.py` rather
 * than 90 characters of `C:\Python313\`.
 */
function summarise(name, command) {
  const text = String(command || '').trim();
  if (!text) return name;

  // The executable is either quoted or runs to the first space.
  const m = text[0] === '"' ? /^"([^"]*)"\s*(.*)$/.exec(text) : /^(\S+)\s*(.*)$/.exec(text);
  const head = m ? basename(m[1]) : name;
  const tail = m ? m[2] : '';

  const whole = tail ? `${head} ${tail}` : head;
  return whole.length > SUMMARY_CHARS ? `${whole.slice(0, SUMMARY_CHARS - 1)}…` : whole;
}

/**
 * Children folded down by name once there are enough of them to stop being
 * individuals. Order is by cost, so whatever is actually busy is at the top.
 */
function collapseSiblings(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.length < COLLAPSE_AT) {
      out.push(...group);
      continue;
    }
    out.push({
      pid: group[0].pid,
      name: group[0].name,
      label: `${group[0].name} ×${group.length}`,
      count: group.length,
      cpu: group.reduce((n, r) => n + r.cpu, 0),
      // Summed like the rest. A headless browser is the case the GPU column
      // exists for, and it is also the case that always collapses — leaving it
      // out here would zero the one number worth having.
      gpu: group.reduce((n, r) => n + (r.gpu || 0), 0),
      rss: group.reduce((n, r) => n + r.rss, 0),
      ports: [...new Set(group.flatMap((r) => r.ports))].sort((a, b) => a - b),
    });
  }
  return out.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
}

/**
 * Everything the panel draws, from one sample and the one before it.
 *
 * `sessions` is what `sessions.js` already knows — id, title, project, pid —
 * so a job is named after the terminal it belongs to rather than after a pid
 * nobody recognises.
 */
function buildView({
  sample, prev, sessions = [], gpu = null, cores, now = Date.now(),
  // How long a pid has been around. The default answers "long enough" for
  // everything, so the age filter is something the monitor opts into rather
  // than something every caller has to know about.
  ageOf = () => Infinity,
}) {
  if (!sample) return { at: 0, sessions: [], totals: { cpu: 0, rss: 0, jobs: 0 } };

  const cpuOf = rates(prev, sample, cores);
  const gpuOf = gpu instanceof Map ? gpu : new Map();
  const kids = byParent(sample.rows);

  const portsOf = new Map();
  for (const { pid, port } of sample.ports) {
    if (!portsOf.has(pid)) portsOf.set(pid, new Set());
    portsOf.get(pid).add(port);
  }

  const decorate = (r) => ({
    pid: r.pid,
    name: r.name,
    label: summarise(r.name, r.command),
    cpu: cpuOf.get(r.pid) || 0,
    gpu: gpuOf.get(r.pid) || 0,
    rss: r.rss,
    ports: [...(portsOf.get(r.pid) || [])],
  });

  const out = [];
  let totalCpu = 0;
  let totalRss = 0;
  let totalJobs = 0;

  for (const s of sessions) {
    const jobs = [];
    for (const root of jobRoots(kids, s.pid)) {
      if (ageOf(root.pid, now) < MIN_AGE_MS) continue;

      const all = subtree(kids, root).filter((r) => !isHidden(r));
      const parts = all.map(decorate);
      const cpu = parts.reduce((n, p) => n + p.cpu, 0);
      const rss = parts.reduce((n, p) => n + p.rss, 0);

      jobs.push({
        pid: root.pid,
        name: root.name,
        label: summarise(root.name, root.command),
        cpu,
        gpu: parts.reduce((n, p) => n + p.gpu, 0),
        rss,
        count: all.length,
        ports: [...new Set(parts.flatMap((p) => p.ports))].sort((a, b) => a - b),
        // The root itself is already the row; what expands is what is under it.
        children: collapseSiblings(parts.filter((p) => p.pid !== root.pid)),
      });

      totalCpu += cpu;
      totalRss += rss;
      totalJobs += 1;
    }

    out.push({
      id: s.id,
      title: s.title,
      projectName: s.projectName,
      pid: s.pid,
      jobs: jobs.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss),
    });
  }

  return {
    at: sample.at,
    sessions: out,
    totals: { cpu: totalCpu, rss: totalRss, jobs: totalJobs },
  };
}

/**
 * How long each pid has been around, which is what `MIN_AGE_MS` is measured
 * against.
 *
 * Deliberately "first seen by us" rather than the real creation time: it costs
 * nothing, it is the same answer for anything that outlives a tick, and asking
 * Windows for `CreationDate` on every process on every tick — to be right about
 * the processes we are about to hide — is a poor trade.
 *
 * Pids that go away are forgotten, so a reused pid is treated as the new
 * process it is rather than inheriting the age of the dead one.
 */
function createAgeTracker() {
  const first = new Map();

  return {
    saw(sample, now) {
      const live = new Set();
      for (const r of sample.rows) {
        live.add(r.pid);
        if (!first.has(r.pid)) first.set(r.pid, now);
      }
      for (const pid of [...first.keys()]) {
        if (!live.has(pid)) first.delete(pid);
      }
    },
    ageOf(pid, now) {
      const since = first.get(pid);
      return since === undefined ? Infinity : now - since;
    },
    clear() { first.clear(); },
  };
}

// ------------------------------------------------------------- gpu, slowly

/** `pid_1234_luid_..._engtype_3d` -> the pid in front of it. */
function parseGpuCounters(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+([\d.eE+-]+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    // A process has an instance per engine — 3D, copy, video decode. What is
    // wanted is how much of the GPU it is using, so they add up.
    out.set(pid, (out.get(pid) || 0) + value);
  }
  return out;
}

const GPU_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$s = (Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples
foreach ($c in $s) {
  if ($c.CookedValue -gt 0 -and $c.InstanceName -match '^pid_(\\d+)_') {
    [Console]::Out.WriteLine("$($Matches[1]) $($c.CookedValue)")
  }
}
`;

// ---------------------------------------------------------------- samplers

// One PowerShell that loops on its own, so the cost per tick is the query
// rather than the query plus a process start. Everything it prints is one line
// of JSON; anything else it might say is ignored by the parser above.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $procs = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime | ForEach-Object {
    $c = $_.CommandLine
    if ($c -and $c.Length -gt 200) { $c = $c.Substring(0, 200) }
    ,@($_.ProcessId, $_.ParentProcessId, $_.Name, ($_.KernelModeTime + $_.UserModeTime), $_.WorkingSetSize, $c)
  })
  $ports = @(netstat -ano -p tcp | Select-String 'LISTENING' | ForEach-Object {
    $f = ($_.Line -split '\\s+') | Where-Object { $_ }
    ,@([int]$f[-1], [int](($f[1] -split ':')[-1]))
  })
  [Console]::Out.WriteLine((@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); p = $procs; l = $ports } | ConvertTo-Json -Compress -Depth 4))
  Start-Sleep -Milliseconds __TICK__
}
`;

const UNIX_SCRIPT = `
while :; do
  ps -Ao pid=,ppid=,pcpu=,rss=,command=
  echo '---PORTS---'
  lsof -nP -iTCP -sTCP:LISTEN -Fpn 2>/dev/null || true
  echo '---END---'
  sleep __TICK__
done
`;

/** The argv that starts the long-lived sampler for this platform. */
function samplerCommand(platform = process.platform, tickMs = TICK_MS) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        WINDOWS_SCRIPT.replace('__TICK__', String(tickMs))],
    };
  }
  return {
    file: '/bin/sh',
    args: ['-c', UNIX_SCRIPT.replace('__TICK__', String(Math.max(1, Math.round(tickMs / 1000))))],
  };
}

// ---------------------------------------------------------------- the monitor

/**
 * A sampler that runs only while somebody is watching.
 *
 * `start` is idempotent and `stop` kills the child, so a panel opened and shut
 * ten times leaves nothing behind. Every failure — no PowerShell, a child that
 * dies, output that will not parse — resolves to "no data" rather than to an
 * error: this is a panel about other processes, and it has no business being
 * the thing that breaks.
 */
function createMonitor(deps = {}) {
  const {
    spawnFn = spawn,
    platform = process.platform,
    tickMs = TICK_MS,
    gpuTickMs = GPU_TICK_MS,
    now = Date.now,
    cores = os.cpus().length || 1,
    log = () => {},
  } = deps;

  const listeners = new Set();
  const ages = createAgeTracker();

  let child = null;
  let buffer = '';
  let prev = null;
  let latest = null;
  let lastView = null;
  let sessionsFor = () => [];
  let gpuChild = null;
  let gpuTimer = null;
  let gpu = new Map();
  let gpuOn = false;

  function emit(view) {
    for (const fn of listeners) {
      try { fn(view); } catch (err) { log(`listener failed: ${err.message}`); }
    }
  }

  function onSample(sample) {
    if (!sample) return;
    const at = now();
    ages.saw(sample, at);
    prev = latest;
    latest = sample;
    lastView = buildView({
      sample, prev, sessions: sessionsFor(), gpu, cores, now: at, ageOf: ages.ageOf,
    });
    emit(lastView);
  }

  function onStdout(text) {
    buffer += text;
    if (buffer.length > 4_000_000) buffer = ''; // a child printing something we can't read

    if (platform === 'win32') {
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) onSample(parseWindowsSample(line));
      }
      return;
    }

    let end = buffer.indexOf('---END---');
    while (end !== -1) {
      onSample(parseUnixSample(buffer.slice(0, end), now()));
      buffer = buffer.slice(end + '---END---'.length);
      end = buffer.indexOf('---END---');
    }
  }

  function startGpu() {
    if (platform !== 'win32' || gpuTimer) return;

    const sampleGpu = () => {
      if (gpuChild) return; // the last one is still going; it is allowed to be slow
      let out = '';
      try {
        gpuChild = spawnFn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', GPU_SCRIPT],
          { windowsHide: true });
      } catch (err) {
        log(`gpu sampler would not start: ${err.message}`);
        return;
      }

      const kill = setTimeout(() => { try { gpuChild.kill(); } catch { /* gone */ } }, GPU_TIMEOUT_MS);
      gpuChild.stdout.on('data', (d) => { out += d.toString(); });
      gpuChild.on('error', () => {});
      gpuChild.on('close', () => {
        clearTimeout(kill);
        gpuChild = null;
        gpu = parseGpuCounters(out);
      });
    };

    sampleGpu();
    gpuTimer = setInterval(sampleGpu, gpuTickMs);
  }

  function stopGpu() {
    if (gpuTimer) { clearInterval(gpuTimer); gpuTimer = null; }
    if (gpuChild) { try { gpuChild.kill(); } catch { /* gone */ } gpuChild = null; }
    gpu = new Map();
  }

  return {
    /** Told what the terminals are, each time a view is built. */
    useSessions(fn) { sessionsFor = fn; },

    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    start() {
      if (child) return true;
      const { file, args } = samplerCommand(platform, tickMs);
      try {
        child = spawnFn(file, args, { windowsHide: true });
      } catch (err) {
        log(`sampler would not start: ${err.message}`);
        child = null;
        return false;
      }

      buffer = '';
      prev = null;
      latest = null;
      child.stdout.on('data', (d) => onStdout(d.toString()));
      child.on('error', (err) => log(`sampler failed: ${err.message}`));
      child.on('close', () => { child = null; });
      if (gpuOn) startGpu();
      return true;
    },

    stop() {
      if (child) { try { child.kill(); } catch { /* already gone */ } child = null; }
      stopGpu();
      buffer = '';
      prev = null;
      latest = null;
      lastView = null;
      ages.clear();
    },

    /** GPU is only ever on because somebody asked; see the note at the top. */
    setGpu(on) {
      gpuOn = Boolean(on) && platform === 'win32';
      if (!gpuOn) stopGpu();
      else if (child) startGpu();
      return gpuOn;
    },

    gpuAvailable: () => platform === 'win32',
    running: () => Boolean(child),
    view: () => lastView,
  };
}

// ---------------------------------------------------------- the free half

/**
 * The sparkline's numbers, which cost nothing.
 *
 * `os.cpus()` is cumulative per-core tick counters and `freemem` is a number
 * the kernel already has, so this needs no child process, no dependency and no
 * platform branch — which is what lets the line above the usage bars run all
 * the time while the panel below it does not.
 */
function createSystemReader(deps = {}) {
  const { cpus = os.cpus, freemem = os.freemem, totalmem = os.totalmem, now = Date.now } = deps;

  let last = null;

  function ticks() {
    let idle = 0;
    let total = 0;
    for (const c of cpus()) {
      for (const kind of Object.keys(c.times)) total += c.times[kind];
      idle += c.times.idle;
    }
    return { idle, total, at: now() };
  }

  return {
    read() {
      const t = ticks();
      const was = last;
      last = t;

      // The first read has nothing to subtract from, so it reports no load
      // rather than the average since boot — which is a real number and not the
      // one a live chart is claiming to show.
      let cpu = 0;
      if (was && t.total > was.total) {
        cpu = (1 - (t.idle - was.idle) / (t.total - was.total)) * 100;
      }

      const free = freemem();
      const all = totalmem();
      return {
        at: t.at,
        cpu: Math.max(0, Math.min(100, cpu)),
        mem: all ? ((all - free) / all) * 100 : 0,
        memUsed: all - free,
        memTotal: all,
      };
    },
  };
}

module.exports = {
  TICK_MS,
  GPU_TICK_MS,
  MIN_AGE_MS,
  COLLAPSE_AT,
  SUMMARY_CHARS,
  AGENT_NAMES,
  HIDDEN_NAMES,
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
};
