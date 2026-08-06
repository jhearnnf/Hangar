'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * The 5-hour and weekly usage bars, read from the same endpoint Claude Code's
 * own `/usage` screen reads.
 *
 * Two things are worth knowing before changing any of this.
 *
 * The endpoint is private. Its response carries internal codenames
 * (`iguana_necktie`, `omelette_promotional`) next to the real fields, which is
 * a fair sign its shape is nobody's promise to us. So every read here is
 * defensive, and anything unrecognised resolves to "nothing to show" — the bar
 * hides itself rather than parking an error in the sidebar. A future Claude
 * Code release is allowed to break this feature, but not to break Hangar.
 *
 * The token is not ours to manage. Claude Code writes and rotates it; we only
 * ever read the file, fresh on every poll, and never pass it anywhere the
 * renderer can reach.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Sent because the token is an OAuth one rather than an API key.
const OAUTH_BETA = 'oauth-2025-04-20';

// The endpoint rate-limits — Claude Code's own changelog mentions falling back
// to last-known bars when it does. Polling this slowly makes tripping it
// unlikely in the first place, and a usage bar has no reason to be livelier.
const MIN_INTERVAL_MS = 120_000;

// A poll nobody is waiting on should never be able to hang around forever.
const TIMEOUT_MS = 10_000;

function credentialsPath(env = process.env) {
  return env.HANGAR_CLAUDE_CREDENTIALS
    || path.join(os.homedir(), '.claude', '.credentials.json');
}

/**
 * The current OAuth access token, or null if this machine has none.
 *
 * Null is an ordinary answer rather than a failure: API-key, Bedrock and Vertex
 * users have no credentials file at all, and neither does a machine where
 * Claude Code has never been signed in.
 */
function readToken(deps = {}) {
  const { readFile = fs.readFileSync, env = process.env } = deps;
  try {
    const raw = JSON.parse(readFile(credentialsPath(env), 'utf8'));
    const token = raw && raw.claudeAiOauth && raw.claudeAiOauth.accessToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null; // missing, unreadable, or not JSON — all mean "no bar"
  }
}

/** A utilisation figure as 0-100, or null if it is not a usable number. */
function percent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/**
 * One window ("five_hour", "seven_day") reduced to what the sidebar draws.
 *
 * A window missing its reset time is still worth showing — the percentage is
 * the part being asked for — but a window without a usable percentage is not.
 */
function parseWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const used = percent(raw.utilization);
  if (used === null) return null;

  const resetsAt = Date.parse(raw.resets_at);
  return { used, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt };
}

/**
 * The whole response reduced to the two windows, or null if neither survived.
 *
 * Either window alone is enough to draw something useful, so this only gives up
 * when both are unreadable — which is the signal that the schema moved.
 */
function parseUsage(body) {
  if (!body || typeof body !== 'object') return null;

  const fiveHour = parseWindow(body.five_hour);
  const sevenDay = parseWindow(body.seven_day);
  if (!fiveHour && !sevenDay) return null;

  return { fiveHour, sevenDay };
}

/**
 * Which window, if either, has run out entirely — "fiveHour", "sevenDay", or
 * null while there is headroom left in both.
 *
 * These are hard stops rather than warnings: at 100% no further work can start
 * until that window resets, which is worth saying more loudly than a full bar
 * does. Percentages are already clamped to 100, so the comparison is inclusive.
 *
 * The shorter window wins a tie, because it is the one that will let go first
 * and so the only reset time worth counting down.
 */
function cappedWindow(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (usage.fiveHour && usage.fiveHour.used >= 100) return 'fiveHour';
  if (usage.sevenDay && usage.sevenDay.used >= 100) return 'sevenDay';
  return null;
}

/**
 * Ask the endpoint once. Separated from the caching so the request handling can
 * be tested without a clock.
 */
async function requestUsage(token, deps = {}) {
  const { fetchFn = fetch } = deps;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetchFn(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
    if (res.status === 429) return { ok: false, reason: 'rate-limited' };
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };

    const usage = parseUsage(await res.json());
    return usage ? { ok: true, usage } : { ok: false, reason: 'unrecognised response' };
  } catch (err) {
    // Includes the abort above, which arrives as an ordinary rejection.
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timed out' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A reader that rate-limits itself and remembers the last good answer.
 *
 * Holding the previous figures through a failed poll is deliberate: a bar that
 * blinked out every time the endpoint was busy would be worse than one that
 * quietly goes a couple of minutes stale, so failures keep drawing the old
 * numbers and let the renderer mark them as of their timestamp.
 */
function createUsageReader(deps = {}) {
  const { now = Date.now } = deps;

  let cached = null;   // last good { fiveHour, sevenDay }
  let cachedAt = 0;
  let inflight = null;

  function answer(extra = {}) {
    if (!cached) return { available: false, ...extra };
    return {
      available: true,
      ...cached,
      capped: cappedWindow(cached),
      at: cachedAt,
      stale: now() - cachedAt > MIN_INTERVAL_MS,
      ...extra,
    };
  }

  async function poll() {
    const token = readToken(deps);
    if (!token) return answer({ reason: 'no credentials' });

    let res = await requestUsage(token, deps);

    // A rotated token is the one auth failure worth a second attempt: Claude
    // Code may have rewritten the file between our read and the request. Only
    // retried when the file genuinely changed, so an expired login costs one
    // request rather than two.
    if (!res.ok && res.reason === 'auth') {
      const fresh = readToken(deps);
      if (fresh && fresh !== token) res = await requestUsage(fresh, deps);
    }

    if (res.ok) {
      cached = res.usage;
      cachedAt = now();
      return answer();
    }

    return answer({ reason: res.reason });
  }

  return {
    /**
     * The current figures, polling at most once per MIN_INTERVAL_MS however
     * often it is asked. Concurrent callers share the one request.
     */
    get() {
      if (cached && now() - cachedAt < MIN_INTERVAL_MS) return Promise.resolve(answer());
      if (inflight) return inflight;

      inflight = poll().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

module.exports = {
  USAGE_URL,
  MIN_INTERVAL_MS,
  credentialsPath,
  readToken,
  percent,
  parseWindow,
  parseUsage,
  cappedWindow,
  requestUsage,
  createUsageReader,
};
