import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const require = createRequire(import.meta.url);
const { parseCodexUsage, requestCodexUsage, createCodexUsageReader } = require('../codex-usage');
const { MIN_INTERVAL_MS, RESET_RECHECK_MS } = require('../usage');
const limits = {
  limitId: 'codex',
  primary: { usedPercent: 51, windowDurationMins: 300, resetsAt: 1800000000 },
  secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1800600000 },
};
const usage = parseCodexUsage({ rateLimits: limits });

describe('Codex usage windows', () => {
  it('reads the Codex bucket, converts seconds, and ignores other buckets', () => {
    expect(parseCodexUsage({ rateLimits: {}, rateLimitsByLimitId: { codex: limits } })).toEqual({
      fiveHour: { used: 51, resetsAt: 1800000000000 },
      sevenDay: { used: 8, resetsAt: 1800600000000 },
    });
    expect(parseCodexUsage({ rateLimits: { ...limits, limitId: 'other' } })).toBeNull();
  });
  it('does not label an unexpected window duration as five hours', () => {
    expect(parseCodexUsage({ rateLimits: { primary: { ...limits.primary, windowDurationMins: 15 } } })).toBeNull();
    expect(parseCodexUsage(null)).toBeNull();
    expect(parseCodexUsage({ rateLimits: { primary: { ...limits.primary, usedPercent: '51' } } })).toBeNull();
  });
  it('keeps a usable window when the other is absent', () => {
    expect(parseCodexUsage({ rateLimits: { secondary: limits.secondary } })).toEqual({ fiveHour: null, sevenDay: usage.sevenDay });
  });
});

function server(respond) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const messages = [];
  child.stdin.on('data', chunk => {
    const message = JSON.parse(chunk.toString());
    messages.push(message);
    queueMicrotask(() => respond(message, child));
  });
  return { child, messages };
}

describe('Codex app-server request', () => {
  it('initializes, reads limits, handles split lines and closes the helper', async () => {
    const { child, messages } = server((message, proc) => {
      if (message.id === 1) proc.stdout.write('{"id":1,"result":{}}\n');
      if (message.id === 2) {
        const reply = JSON.stringify({ id: 2, result: { rateLimits: limits } }) + '\n';
        proc.stdout.write(reply.slice(0, 15));
        proc.stdout.write(reply.slice(15));
      }
    });
    expect(await requestCodexUsage({ spawnFn: () => child })).toEqual({ ok: true, usage });
    expect(messages.map(m => m.method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
    expect(child.killed).toBe(true);
  });
  it('handles a missing CLI and an unanswered request', async () => {
    expect((await requestCodexUsage({ spawnFn: () => { throw Error('ENOENT'); } })).ok).toBe(false);
    const { child } = server(() => {});
    expect(await requestCodexUsage({ spawnFn: () => child, timeoutMs: 5 })).toEqual({ ok: false, reason: 'timed out' });
    expect(child.killed).toBe(true);
  });
  it('does not expose server errors or credentials to the renderer', async () => {
    const { child } = server((m, p) => p.stdout.write(JSON.stringify({ id: m.id, error: { message: 'sensitive' } }) + '\n'));
    expect(await requestCodexUsage({ spawnFn: () => child })).toEqual({ ok: false, reason: 'usage unavailable' });
  });
});

describe('Codex usage cache', () => {
  it('shares requests, throttles failures, and marks retained figures stale', async () => {
    let clock = 1000;
    let calls = 0;
    const reader = createCodexUsageReader({ now: () => clock, request: async () => {
      calls++;
      return calls === 1 ? { ok: true, usage } : { ok: false, reason: 'offline' };
    } });
    await Promise.all([reader.get(), reader.get()]);
    expect(calls).toBe(1);
    clock += MIN_INTERVAL_MS;
    expect(await reader.get()).toMatchObject({ available: true, stale: true, fiveHour: usage.fiveHour });
    await reader.get();
    expect(calls).toBe(2);
  });
  it('throttles an unavailable account even without cached figures', async () => {
    let calls = 0;
    const reader = createCodexUsageReader({ request: async () => { calls++; throw Error('offline'); } });
    expect((await reader.get()).available).toBe(false);
    await reader.get();
    expect(calls).toBe(1);
  });
  it('rechecks a spent window sooner after its reset', async () => {
    let clock = 100000;
    let calls = 0;
    const reader = createCodexUsageReader({ now: () => clock, request: async () => {
      calls++;
      return { ok: true, usage: { fiveHour: { used: 100, resetsAt: 100001 }, sevenDay: null } };
    } });
    await reader.get();
    clock += RESET_RECHECK_MS;
    await reader.get();
    expect(calls).toBe(2);
  });
});
