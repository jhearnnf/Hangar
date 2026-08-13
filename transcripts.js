'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * The claude sessions a project has had, so one can be picked up again.
 *
 * Claude Code already keeps everything this needs; none of it is ours and none
 * of it is written here. Two files are read:
 *
 *   ~/.claude/history.jsonl      every prompt ever typed, one JSON object per
 *                                line, carrying the project it was typed in,
 *                                the session it belonged to and when.
 *   ~/.claude/sessions/<pid>.json  one file per *running* claude, with the
 *                                session id it is on and the folder it is in.
 *
 * The first is the list. The second is what greys a row out: a session already
 * running somewhere must not be opened a second time, because both copies would
 * then be appending to one transcript.
 *
 * Both are private to Claude Code and neither is a promise to us, so every read
 * here is defensive in the same way `usage.js` is — anything unrecognised
 * becomes an empty list rather than an error. The worst this feature is allowed
 * to do is show nothing.
 */

// Only ever read.
const HISTORY_FILE = 'history.jsonl';
const LIVE_DIR = 'sessions';

// How much of the tail of history.jsonl to look at. The file is append-only and
// never trimmed — it is already megabytes here — but a menu of recent work has
// no interest in the top of it, and reading a bounded window keeps a right
// click costing the same in a year as it does today.
//
// Two megabytes is a few weeks of steady use and a few tens of milliseconds to
// parse, once, on a click. Sessions older than the window are not lost, only
// unlisted: claude's own `/resume` picker still has all of them.
const TAIL_BYTES = 2 * 1024 * 1024;

// How many rows the menu offers. Past this it stops being something you scan
// and starts being something you search, which is what claude's own `/resume`
// picker is for.
const MAX_ROWS = 10;

// Long prompts are a paragraph. The row truncates anyway; this keeps the whole
// paragraph from crossing the bridge to be thrown away on the other side.
const LABEL_CHARS = 90;

// The shape claude names a session with. Checked rather than trusted: this
// string is read off disk and ends up on a command line, so anything that is
// not exactly a UUID never gets that far.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function claudeHome(env = process.env) {
  return env.HANGAR_CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/**
 * Are these two the same folder?
 *
 * Hangar's path comes from its own listing and claude's from wherever it was
 * started, so the same folder routinely arrives spelled two ways — mixed
 * separators, a trailing slash, a lower-case drive letter. Windows does not
 * care about any of that and neither does this.
 */
function samePath(a, b, platform = process.platform) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const flatten = (p) => {
    const flat = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? flat.toLowerCase() : flat;
  };
  return Boolean(a) && flatten(a) === flatten(b);
}

/** A prompt as one line of menu text, or null if there is nothing left of it. */
function label(text) {
  if (typeof text !== 'string') return null;
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > LABEL_CHARS ? `${line.slice(0, LABEL_CHARS - 1)}…` : line;
}

/**
 * A prompt that is a slash command and nothing else — `/resume`, `/clear`,
 * `/compact`.
 *
 * Worth telling apart because a session made only of these was never a
 * conversation. Typing `/resume` starts a new session, records the word
 * "/resume" against it, and immediately jumps to the old one — leaving behind a
 * session id with a 267-byte transcript containing no messages at all. Half the
 * rows in this project were those before they were filtered out, and every one
 * of them was called "/resume".
 *
 * A command carrying an argument (`/code-review the login flow`) is a real
 * instruction and is left alone.
 */
function isBareCommand(text) {
  return typeof text === 'string' && /^\s*\/[\w-]+\s*$/.test(text);
}

/**
 * The last `bytes` of a file as text, and whether that was the whole of it.
 *
 * Starting mid-file means the first line is very likely half a line, and may
 * even start mid-character. Both are the caller's problem to drop, which is why
 * `whole` comes back with the text.
 */
function readTail(file, bytes, deps = {}) {
  const { io = fs } = deps;

  let fd = null;
  try {
    fd = io.openSync(file, 'r');
    const { size } = io.fstatSync(fd);
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    io.readSync(fd, buf, 0, length, size - length);
    return { text: buf.toString('utf8'), whole: length === size };
  } catch {
    // No claude on this machine, or a file we are not allowed to read. Either
    // way there is nothing to offer and nothing to say about it.
    return { text: '', whole: true };
  } finally {
    if (fd !== null) {
      try { io.closeSync(fd); } catch { /* nothing left to do about it */ }
    }
  }
}

/**
 * The prompt lines out of history text, as `{ id, project, at, prompt }`.
 *
 * `whole: false` means the text began mid-file, so the first line is dropped
 * unread — it is a fragment, and might not even be valid UTF-8 at its start.
 */
function parseHistory({ text, whole = true }) {
  const lines = String(text).split('\n');
  if (!whole) lines.shift();

  const out = [];
  for (const line of lines) {
    if (!line) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;   // a torn write, or a format we don't know
    }

    if (!entry || typeof entry !== 'object') continue;
    if (!isSessionId(entry.sessionId) || typeof entry.project !== 'string') continue;
    if (typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp)) continue;

    out.push({
      id: entry.sessionId,
      project: entry.project,
      at: entry.timestamp,
      prompt: entry.display,
    });
  }
  return out;
}

/**
 * One row per session in this project: named after the first thing asked of it,
 * dated by the last.
 *
 * The first prompt is the name because it is the only thing in the file anyone
 * chose — it is what you typed when you knew what you wanted. The last is the
 * date because that is when the session was really last touched.
 *
 * "First" means the first prompt that asked for something — see
 * `isBareCommand`. A session that never got one of those is not listed at all:
 * it has no transcript to go back to, so there is nothing for a row to offer.
 *
 * The one thing that costs is a session whose real prompts are older than the
 * window we read, leaving only a later `/resume` in view. That session drops
 * off the menu — but its last activity is that old too, so it was near the
 * bottom of a ten-row list anyway, and claude's own picker still has it.
 */
function sessionsIn(entries, projectPath, platform) {
  const found = new Map();

  for (const entry of entries) {
    if (!samePath(entry.project, projectPath, platform)) continue;

    let row = found.get(entry.id);
    if (!row) {
      row = { id: entry.id, at: entry.at, label: null, labelAt: 0 };
      found.set(entry.id, row);
    }
    if (entry.at > row.at) row.at = entry.at;

    // Every prompt counts towards the date, only a real one towards the name.
    const text = isBareCommand(entry.prompt) ? null : label(entry.prompt);
    if (text && (!row.label || entry.at < row.labelAt)) {
      row.label = text;
      row.labelAt = entry.at;
    }
  }

  return [...found.values()]
    .filter((row) => row.label)
    .map((row) => ({ id: row.id, label: row.label, at: row.at }));
}

/**
 * Is this process still there?
 *
 * Signal 0 asks without sending anything. EPERM means it exists and is not
 * ours, which on a single-user machine it always is, but it is still an answer
 * of "alive".
 *
 * Claude removes its own file on the way out, so this only matters for one that
 * was killed or crashed. It cannot tell a reused pid from the original, so a
 * long-dead session can in principle come back marked live — the cost of that
 * is one row you have to resume from a terminal instead of from this menu,
 * which is a great deal cheaper than two claudes writing one transcript.
 */
function pidAlive(pid, kill = process.kill.bind(process)) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/** Every claude currently running on this machine, as far as its own files say. */
function readLive(deps = {}) {
  const {
    env = process.env,
    readdir = fs.readdirSync,
    readFile = fs.readFileSync,
    alive = pidAlive,
  } = deps;

  const dir = path.join(claudeHome(env), LIVE_DIR);

  let names;
  try {
    names = readdir(dir);
  } catch {
    return [];   // no directory yet, which is the same as nothing running
  }

  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;

    let entry;
    try {
      entry = JSON.parse(readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue;   // being written to right now, most likely
    }

    if (!entry || !isSessionId(entry.sessionId) || typeof entry.cwd !== 'string') continue;
    if (!alive(entry.pid)) continue;

    out.push({
      id: entry.sessionId,
      cwd: entry.cwd,
      // claude's own derived name ("hangar-71"), which is all there is to call
      // a session that is running but has not been asked anything yet.
      name: typeof entry.name === 'string' ? entry.name : null,
      startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : 0,
    });
  }
  return out;
}

function readHistory(deps = {}) {
  const { env = process.env, tailBytes = TAIL_BYTES } = deps;
  return readTail(path.join(claudeHome(env), HISTORY_FILE), tailBytes, deps);
}

/**
 * The menu: this project's claude sessions, newest first.
 *
 * A running session is listed rather than hidden, and marked. Hiding it would
 * leave the most recent thing you did missing from a list of recent things you
 * did, with nothing to say why.
 */
function recentFor(projectPath, deps = {}) {
  const {
    history = readHistory,
    live = readLive,
    limit = MAX_ROWS,
    platform = process.platform,
  } = deps;

  if (!projectPath) return [];

  const running = live(deps).filter((s) => samePath(s.cwd, projectPath, platform));
  const runningIds = new Set(running.map((s) => s.id));

  const rows = sessionsIn(parseHistory(history(deps)), projectPath, platform)
    .map((row) => ({ id: row.id, label: row.label, at: row.at, live: runningIds.has(row.id) }));

  // A claude started a minute ago and not yet spoken to has no prompt to be
  // named after and no line in history at all, so it is added from the live
  // side. It is greyed out like the rest of them, but it is on the list.
  const listed = new Set(rows.map((row) => row.id));
  for (const session of running) {
    if (listed.has(session.id)) continue;
    rows.push({ id: session.id, label: session.name, at: session.startedAt, live: true });
  }

  return rows
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((row) => ({
      ...row,
      label: row.label || `session ${row.id.slice(0, 8)}`,
      // Built here, where the id has been checked, rather than glued together
      // from a raw id on the other side of the bridge.
      command: `claude --resume ${row.id}`,
    }));
}

module.exports = {
  HISTORY_FILE,
  LIVE_DIR,
  TAIL_BYTES,
  MAX_ROWS,
  LABEL_CHARS,
  claudeHome,
  isSessionId,
  samePath,
  label,
  isBareCommand,
  readTail,
  parseHistory,
  sessionsIn,
  pidAlive,
  readLive,
  readHistory,
  recentFor,
};
