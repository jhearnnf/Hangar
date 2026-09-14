'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

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
 * ever read it, fresh on every poll, and never pass it anywhere the renderer
 * can reach.
 *
 * Where it lives depends on the machine. On Windows and Linux it is a file. On
 * macOS Claude Code puts the same JSON in the login keychain instead, so there
 * the file is usually absent and `security` is asked for it.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Sent because the token is an OAuth one rather than an API key.
const OAUTH_BETA = 'oauth-2025-04-20';

// The endpoint rate-limits — Claude Code's own changelog mentions falling back
// to last-known bars when it does. Polling this slowly makes tripping it
// unlikely in the first place, and a usage bar has no reason to be livelier.
const MIN_INTERVAL_MS = 120_000;

// How often to ask again once a spent window's reset time has been and gone.
// From that moment the cached figures describe a window that no longer exists —
// the terminals are already working again — and every second the sidebar keeps
// the banner up on their say-so is a second of claiming a limit that has lifted.
// Still a floor rather than a free-for-all, since the endpoint may lag the reset
// by a little and rate-limits the impatient.
const RESET_RECHECK_MS = 15_000;

// A poll nobody is waiting on should never be able to hang around forever.
const TIMEOUT_MS = 10_000;

// The keychain item Claude Code writes on macOS. Its name is Claude Code's, not
// ours, and the value under it is byte for byte what `.credentials.json` holds
// on the other platforms.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// The first read of that item from a binary that has not been granted access
// puts a system prompt in front of the user. `security` sits there until it is
// answered, so this runs asynchronously and gives up rather than leaving a
// child of ours parked on a dialog nobody is looking at.
const KEYCHAIN_TIMEOUT_MS = 20_000;

// How long to leave the keychain alone after it declines to answer. Without
// this a machine that has no item — or a user who clicked Deny — would be asked
// again every couple of minutes, and each ask can be another dialog.
const KEYCHAIN_RETRY_MS = 600_000;

function credentialsPath(env = process.env) {
  return env.HANGAR_CLAUDE_CREDENTIALS
    || path.join(os.homedir(), '.claude', '.credentials.json');
}

/** The access token out of the credentials JSON, or null if it is not in there. */
function tokenFrom(raw) {
  try {
    const parsed = JSON.parse(raw);
    const token = parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null; // not JSON at all
  }
}

/**
 * The current OAuth access token from the credentials file, or null if this
 * machine has none.
 *
 * Null is an ordinary answer rather than a failure: API-key, Bedrock and Vertex
 * users have no credentials file at all, a machine where Claude Code has never
 * been signed in has none either, and on macOS there is normally no file to
 * read because the same JSON is in the keychain instead.
 */
function readToken(deps = {}) {
  const { readFile = fs.readFileSync, env = process.env } = deps;
  try {
    return tokenFrom(readFile(credentialsPath(env), 'utf8'));
  } catch {
    return null; // missing or unreadable — same answer as "no bar"
  }
}

/**
 * The same token out of the macOS login keychain, or null.
 *
 * Only macOS keeps it there, so everywhere else this answers null without
 * spawning anything. Every failure — no item, no `security`, a refused prompt,
 * a timeout — is the same "no bar" as a missing file.
 */
function readKeychainToken(deps = {}) {
  const { execFileFn = execFile, platform = process.platform } = deps;
  if (platform !== 'darwin') return Promise.resolve(null);

  return new Promise((resolve) => {
    try {
      execFileFn(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { timeout: KEYCHAIN_TIMEOUT_MS },
        (err, stdout) => resolve(err ? null : tokenFrom(String(stdout).trim())),
      );
    } catch {
      resolve(null);
    }
  });
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
  let keychainAfter = 0;   // don't ask macOS again before this

  /**
   * The token, from wherever this machine keeps it. The file is tried first
   * everywhere, because it costs a `readFileSync` and answers on the platforms
   * that use it; the keychain is the macOS fallback behind it.
   */
  async function currentToken() {
    const fromFile = readToken(deps);
    if (fromFile) return fromFile;

    if (now() < keychainAfter) return null;
    const fromKeychain = await readKeychainToken(deps);
    if (!fromKeychain) keychainAfter = now() + KEYCHAIN_RETRY_MS;
    return fromKeychain;
  }

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
    const token = await currentToken();
    if (!token) return answer({ reason: 'no credentials' });

    let res = await requestUsage(token, deps);

    // A rotated token is the one auth failure worth a second attempt: Claude
    // Code may have rewritten it between our read and the request. Only retried
    // when it genuinely changed, so an expired login costs one request rather
    // than two.
    if (!res.ok && res.reason === 'auth') {
      const fresh = await currentToken();
      if (fresh && fresh !== token) res = await requestUsage(fresh, deps);
    }

    if (res.ok) {
      cached = res.usage;
      cachedAt = now();
      return answer();
    }

    return answer({ reason: res.reason });
  }

  /**
   * Whether the figures in hand are still worth serving without asking again.
   *
   * Ordinarily two minutes. But figures that say a window is spent, taken
   * before the moment that window was due to reset, stop being an answer the
   * instant that moment passes: they are the last word from a wait that is
   * most likely over. Those go back to the endpoint on the shorter rhythm.
   */
  function fresh() {
    if (!cached) return false;
    const age = now() - cachedAt;
    if (age >= MIN_INTERVAL_MS) return false;

    const spent = cappedWindow(cached);
    const resetsAt = spent && cached[spent].resetsAt;
    if (resetsAt && resetsAt <= now()) return age < RESET_RECHECK_MS;
    return true;
  }

  return {
    /**
     * The current figures, polling at most once per MIN_INTERVAL_MS however
     * often it is asked — or once per RESET_RECHECK_MS while a spent window is
     * past due to reopen. Concurrent callers share the one request.
     */
    get() {
      if (fresh()) return Promise.resolve(answer());
      if (inflight) return inflight;

      inflight = poll().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

module.exports = {
  USAGE_URL,
  MIN_INTERVAL_MS,
  RESET_RECHECK_MS,
  KEYCHAIN_SERVICE,
  KEYCHAIN_RETRY_MS,
  credentialsPath,
  tokenFrom,
  readToken,
  readKeychainToken,
  percent,
  parseWindow,
  parseUsage,
  cappedWindow,
  requestUsage,
  createUsageReader,
};
