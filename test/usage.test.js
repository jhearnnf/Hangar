import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MIN_INTERVAL_MS,
  credentialsPath,
  readToken,
  percent,
  parseWindow,
  parseUsage,
  cappedWindow,
  requestUsage,
  createUsageReader,
} = require('../usage.js');

/** The shape the endpoint actually answers with, codenames and all. */
const LIVE_BODY = {
  five_hour: {
    utilization: 38.0,
    resets_at: '2026-08-03T20:10:00.883538+00:00',
    limit_dollars: null,
    used_dollars: null,
  },
  seven_day: { utilization: 14.0, resets_at: '2026-08-09T06:00:00.883567+00:00' },
  seven_day_opus: null,
  iguana_necktie: null,
  omelette_promotional: null,
  extra_usage: { is_enabled: false },
};

function credentials(token) {
  return () => JSON.stringify({ claudeAiOauth: { accessToken: token, subscriptionType: 'pro' } });
}

/** A fetch that answers as told and records what it was asked. */
function fakeFetch(replies, calls = []) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  return async (url, opts) => {
    calls.push({ url, opts });
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status === undefined || (reply.status >= 200 && reply.status < 300),
      status: reply.status ?? 200,
      json: async () => reply.body,
    };
  };
}

describe('credentialsPath', () => {
  it('is the Claude Code credentials file unless overridden', () => {
    expect(credentialsPath({})).toMatch(/[\\/]\.claude[\\/]\.credentials\.json$/);
  });

  it('honours HANGAR_CLAUDE_CREDENTIALS', () => {
    expect(credentialsPath({ HANGAR_CLAUDE_CREDENTIALS: 'D:\\creds.json' })).toBe('D:\\creds.json');
  });
});

describe('readToken', () => {
  it('reads the OAuth access token', () => {
    expect(readToken({ readFile: credentials('sk-tok'), env: {} })).toBe('sk-tok');
  });

  it('is null when there is no credentials file', () => {
    const missing = () => { throw new Error('ENOENT'); };
    expect(readToken({ readFile: missing, env: {} })).toBeNull();
  });

  it('is null rather than throwing on a file that is not JSON', () => {
    expect(readToken({ readFile: () => 'not json at all', env: {} })).toBeNull();
  });

  it('is null when the file has no OAuth section', () => {
    // API-key, Bedrock and Vertex users land here.
    expect(readToken({ readFile: () => '{"other":true}', env: {} })).toBeNull();
    expect(readToken({ readFile: () => '{"claudeAiOauth":{}}', env: {} })).toBeNull();
  });
});

describe('percent', () => {
  it('passes ordinary figures through', () => {
    expect(percent(38)).toBe(38);
    expect(percent(0)).toBe(0);
  });

  it('clamps to 0-100 so a bar can never overflow its track', () => {
    expect(percent(140)).toBe(100);
    expect(percent(-5)).toBe(0);
  });

  it('rejects anything that is not a finite number', () => {
    for (const bad of ['38', null, undefined, NaN, Infinity, {}]) {
      expect(percent(bad)).toBeNull();
    }
  });
});

describe('parseWindow', () => {
  it('reduces a window to a percentage and a reset time', () => {
    const win = parseWindow(LIVE_BODY.five_hour);
    expect(win.used).toBe(38);
    expect(win.resetsAt).toBe(Date.parse('2026-08-03T20:10:00.883538+00:00'));
  });

  it('keeps a window whose reset time is missing or unparseable', () => {
    expect(parseWindow({ utilization: 10 })).toEqual({ used: 10, resetsAt: null });
    expect(parseWindow({ utilization: 10, resets_at: 'soon' }).resetsAt).toBeNull();
  });

  it('drops a window with no usable percentage', () => {
    expect(parseWindow({ resets_at: '2026-08-03T20:10:00Z' })).toBeNull();
    expect(parseWindow(null)).toBeNull();
    expect(parseWindow('five_hour')).toBeNull();
  });
});

describe('parseUsage', () => {
  it('reads the live response shape', () => {
    expect(parseUsage(LIVE_BODY)).toEqual({
      fiveHour: { used: 38, resetsAt: Date.parse('2026-08-03T20:10:00.883538+00:00') },
      sevenDay: { used: 14, resetsAt: Date.parse('2026-08-09T06:00:00.883567+00:00') },
    });
  });

  it('keeps going when only one window is readable', () => {
    const usage = parseUsage({ five_hour: { utilization: 38 }, seven_day: null });
    expect(usage.fiveHour.used).toBe(38);
    expect(usage.sevenDay).toBeNull();
  });

  it('gives up when the schema has moved out from under it', () => {
    // The endpoint is private, so this is the expected end state one day. It has
    // to read as "no bar", never as a crash.
    expect(parseUsage({ windows: [{ name: 'five_hour', pct: 38 }] })).toBeNull();
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage('nope')).toBeNull();
  });
});

describe('cappedWindow', () => {
  const win = (used) => ({ used, resetsAt: null });

  it('is null while either window has headroom left', () => {
    expect(cappedWindow({ fiveHour: win(99), sevenDay: win(0) })).toBeNull();
    expect(cappedWindow({ fiveHour: win(0), sevenDay: win(99.9) })).toBeNull();
  });

  it('names the window that ran out', () => {
    expect(cappedWindow({ fiveHour: win(100), sevenDay: win(40) })).toBe('fiveHour');
    expect(cappedWindow({ fiveHour: win(40), sevenDay: win(100) })).toBe('sevenDay');
  });

  it('prefers the 5h window when both are spent, since it resets first', () => {
    expect(cappedWindow({ fiveHour: win(100), sevenDay: win(100) })).toBe('fiveHour');
  });

  it('copes with a missing window and with nothing at all', () => {
    expect(cappedWindow({ fiveHour: null, sevenDay: win(100) })).toBe('sevenDay');
    expect(cappedWindow({ fiveHour: win(100), sevenDay: null })).toBe('fiveHour');
    expect(cappedWindow(null)).toBeNull();
    expect(cappedWindow('spent')).toBeNull();
  });
});

describe('requestUsage', () => {
  it('sends the token as a bearer with the OAuth beta header', async () => {
    const calls = [];
    await requestUsage('sk-tok', { fetchFn: fakeFetch({ body: LIVE_BODY }, calls) });

    expect(calls[0].url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer sk-tok');
    expect(calls[0].opts.headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('reports the parsed usage on success', async () => {
    const res = await requestUsage('sk-tok', { fetchFn: fakeFetch({ body: LIVE_BODY }) });
    expect(res).toEqual({ ok: true, usage: parseUsage(LIVE_BODY) });
  });

  it('names the failures the reader has to tell apart', async () => {
    const cases = [[401, 'auth'], [403, 'auth'], [429, 'rate-limited'], [500, 'http 500']];
    for (const [status, reason] of cases) {
      const res = await requestUsage('sk-tok', { fetchFn: fakeFetch({ status, body: {} }) });
      expect(res).toEqual({ ok: false, reason });
    }
  });

  it('treats a network error as unreachable rather than throwing', async () => {
    const res = await requestUsage('sk-tok', { fetchFn: fakeFetch(new Error('ECONNREFUSED')) });
    expect(res).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('treats a response it cannot read as unrecognised', async () => {
    const res = await requestUsage('sk-tok', { fetchFn: fakeFetch({ body: { moved: true } }) });
    expect(res).toEqual({ ok: false, reason: 'unrecognised response' });
  });
});

describe('createUsageReader', () => {
  const base = (over = {}) => ({
    readFile: credentials('sk-tok'),
    env: {},
    fetchFn: fakeFetch({ body: LIVE_BODY }),
    ...over,
  });

  it('reports the figures for the sidebar to draw', async () => {
    const res = await createUsageReader(base()).get();
    expect(res.available).toBe(true);
    expect(res.fiveHour.used).toBe(38);
    expect(res.sevenDay.used).toBe(14);
    expect(res.stale).toBe(false);
    expect(res.capped).toBeNull();
  });

  it('tells the sidebar which window ran out, so it can say so', async () => {
    const spent = { ...LIVE_BODY, five_hour: { ...LIVE_BODY.five_hour, utilization: 100 } };
    const res = await createUsageReader(base({ fetchFn: fakeFetch({ body: spent }) })).get();
    expect(res.capped).toBe('fiveHour');
  });

  it('keeps saying so while the figures are stale', async () => {
    // A failed poll must not let the warning blink off: the limit is still
    // spent, we simply cannot ask again yet.
    let clock = 1_000_000;
    const spent = { ...LIVE_BODY, seven_day: { ...LIVE_BODY.seven_day, utilization: 100 } };
    const reader = createUsageReader(base({
      fetchFn: fakeFetch([{ body: spent }, { status: 429, body: {} }]),
      now: () => clock,
    }));

    await reader.get();
    clock += MIN_INTERVAL_MS + 1;
    const res = await reader.get();
    expect(res.stale).toBe(true);
    expect(res.capped).toBe('sevenDay');
  });

  it('is unavailable, not broken, when there are no credentials', async () => {
    const noFile = () => { throw new Error('ENOENT'); };
    const res = await createUsageReader(base({ readFile: noFile })).get();
    expect(res).toEqual({ available: false, reason: 'no credentials' });
  });

  it('polls at most once per interval however often it is asked', async () => {
    const calls = [];
    let clock = 1_000_000;
    const reader = createUsageReader(base({
      fetchFn: fakeFetch({ body: LIVE_BODY }, calls),
      now: () => clock,
    }));

    await reader.get();
    await reader.get();
    await reader.get();
    expect(calls.length).toBe(1);

    clock += MIN_INTERVAL_MS + 1;
    await reader.get();
    expect(calls.length).toBe(2);
  });

  it('shares one request between callers that arrive together', async () => {
    const calls = [];
    const reader = createUsageReader(base({ fetchFn: fakeFetch({ body: LIVE_BODY }, calls) }));

    await Promise.all([reader.get(), reader.get(), reader.get()]);
    expect(calls.length).toBe(1);
  });

  it('keeps drawing the last good figures when a poll fails', async () => {
    let clock = 1_000_000;
    const reader = createUsageReader(base({
      fetchFn: fakeFetch([{ body: LIVE_BODY }, { status: 429, body: {} }]),
      now: () => clock,
    }));

    await reader.get();
    clock += MIN_INTERVAL_MS + 1;
    const res = await reader.get();

    // Still drawable, but flagged old and stamped so the note can say when.
    expect(res.available).toBe(true);
    expect(res.fiveHour.used).toBe(38);
    expect(res.reason).toBe('rate-limited');
    expect(res.stale).toBe(true);
    expect(res.at).toBe(1_000_000);
  });

  it('retries once when the token was rotated under it', async () => {
    const calls = [];
    let token = 'stale-tok';
    const reader = createUsageReader(base({
      readFile: () => JSON.stringify({ claudeAiOauth: { accessToken: token } }),
      fetchFn: async (url, opts) => {
        calls.push(opts.headers.Authorization);
        // Claude Code rewrites the file the moment the stale one is refused.
        if (opts.headers.Authorization === 'Bearer stale-tok') {
          token = 'fresh-tok';
          return { ok: false, status: 401, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => LIVE_BODY };
      },
    }));

    const res = await reader.get();
    expect(calls).toEqual(['Bearer stale-tok', 'Bearer fresh-tok']);
    expect(res.available).toBe(true);
  });

  it('does not retry when the token on disk is the one just refused', async () => {
    const calls = [];
    const reader = createUsageReader(base({
      fetchFn: fakeFetch({ status: 401, body: {} }, calls),
    }));

    const res = await reader.get();
    expect(calls.length).toBe(1); // an expired login costs one request, not two
    expect(res).toEqual({ available: false, reason: 'auth' });
  });
});
