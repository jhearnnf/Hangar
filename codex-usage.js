'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { codexHome } = require('./codex-sessions');
const { percent, cappedWindow, MIN_INTERVAL_MS, RESET_RECHECK_MS } = require('./usage');

// Use Codex's authenticated app-server protocol. Credentials never enter Hangar.
function codexCommand(env = process.env, platform = process.platform, arch = process.arch) {
  if (env.HANGAR_CODEX_BIN) return env.HANGAR_CODEX_BIN;
  if (platform !== 'win32') return 'codex';
  const target = arch === 'arm64' ? 'aarch64' : 'x86_64';
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    const root = path.join(dir, 'node_modules', '@openai', 'codex');
    const candidates = [
      path.join(dir, 'codex.exe'),
      path.join(root, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', `${target}-pc-windows-msvc`, 'bin', 'codex.exe'),
      path.join(root, 'vendor', `${target}-pc-windows-msvc`, 'bin', 'codex.exe'),
    ];
    for (const file of candidates) if (fs.existsSync(file)) return file;
  }
  return 'codex.exe';
}

function parseCodexUsage(result) {
  const limits = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
  if (!limits || (limits.limitId && limits.limitId !== 'codex')) return null;
  const windows = [limits.primary, limits.secondary];
  function windowFor(minutes) {
    const win = windows.find(w => w?.windowDurationMins === minutes);
    const used = percent(win?.usedPercent);
    if (used === null) return null;
    const resetsAt = typeof win.resetsAt === 'number' && Number.isFinite(win.resetsAt)
      ? win.resetsAt * 1000 : null;
    return { used, resetsAt };
  }
  const fiveHour = windowFor(300);
  const sevenDay = windowFor(10080);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

function requestCodexUsage(deps = {}) {
  const { spawnFn = spawn, env = process.env, timeoutMs = 15000 } = deps;
  return new Promise(resolve => {
    let child;
    let done = false;
    let buffer = '';
    const timer = setTimeout(() => finish({ ok: false, reason: 'timed out' }), timeoutMs);
    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child?.stdin.destroy();
      child?.kill();
      resolve(result);
    }
    function send(message) {
      child.stdin.write(JSON.stringify(message) + '\n');
    }
    try {
      child = spawnFn(codexCommand(env), ['app-server'], {
        env: { ...env, CODEX_HOME: codexHome(env) },
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
      child.on('error', () => finish({ ok: false, reason: 'Codex unavailable' }));
      child.on('close', () => finish({ ok: false, reason: 'Codex closed' }));
      child.stdin.on('error', () => finish({ ok: false, reason: 'Codex unavailable' }));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (done) return;
        buffer += chunk;
        if (buffer.length > 1024 * 1024) return finish({ ok: false, reason: 'unrecognised response' });
        let end;
        while (!done && (end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id !== 1 && message.id !== 2) continue;
          if (message.error) return finish({ ok: false, reason: 'usage unavailable' });
          if (message.id === 1) {
            send({ method: 'initialized' });
            send({ id: 2, method: 'account/rateLimits/read' });
          } else {
            const usage = parseCodexUsage(message.result);
            finish(usage ? { ok: true, usage } : { ok: false, reason: 'unrecognised response' });
          }
        }
      });
      send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'hangar', version: '0.1.0' },
      } });
    } catch { finish({ ok: false, reason: 'Codex unavailable' }); }
  });
}

function createCodexUsageReader(deps = {}) {
  const { now = Date.now, request = () => requestCodexUsage(deps) } = deps;
  let cached = null;
  let at = 0;
  let lastAttempt = -Infinity;
  let failure = null;
  let inflight = null;
  function answer() {
    if (!cached) return { available: false, reason: failure || 'usage unavailable' };
    return { available: true, ...cached, at, capped: cappedWindow(cached),
      stale: !!failure || now() - at > MIN_INTERVAL_MS, ...(failure ? { reason: failure } : {}) };
  }
  return { get() {
    if (inflight) return inflight;
    const spent = cappedWindow(cached);
    const reset = spent && cached[spent].resetsAt;
    const interval = reset && reset <= now() ? RESET_RECHECK_MS : MIN_INTERVAL_MS;
    if (now() - lastAttempt < interval) return Promise.resolve(answer());
    lastAttempt = now();
    inflight = Promise.resolve().then(request).then(result => {
      failure = result.ok ? null : result.reason;
      if (result.ok) { cached = result.usage; at = now(); }
      return answer();
    }).catch(() => { failure = 'usage unavailable'; return answer(); })
      .finally(() => { inflight = null; });
    return inflight;
  } };
}

module.exports = { codexCommand, parseCodexUsage, requestCodexUsage, createCodexUsageReader };
