'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const { isSessionId, samePath, label, isBareCommand, readTail } = require('./transcripts');

/**
 * The codex sessions a project has had, so one can be picked up again — the
 * same right-click menu `transcripts.js` fills when the agent is Claude Code,
 * filled from Codex's own files instead.
 *
 * The menu is the same and the two files behind it are not, because the two
 * agents record different things:
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<when>-<uuid>.jsonl
 *                                one file per session, whose first line is a
 *                                `session_meta` record carrying the session id
 *                                and — the part that matters here — the folder
 *                                it was started in.
 *   ~/.codex/history.jsonl       every prompt typed, one JSON object per line,
 *                                carrying the session it belonged to and when.
 *                                It does *not* carry the folder, which is why
 *                                the rollouts above are read at all.
 *
 * So the rollouts are the list and history is only the names: which sessions
 * belong to this project is answered by the first line of each rollout file,
 * and what to call them by the first thing asked of each.
 *
 * Two things follow from that and are worth knowing before changing any of it.
 *
 * The rollout heads are read on the click, one short read per file, newest
 * first and bounded — see `MAX_FILES`. Codex files them by date, so newest
 * first is three sorted directory listings rather than a stat of every session
 * anyone has ever had.
 *
 * Nothing here can tell that a session is open somewhere else. Claude Code
 * writes a file per running process and `transcripts.js` greys those rows out;
 * Codex keeps no such record, so every row here says `live: false` and the menu
 * will happily offer one that is already up in another window. The cost is two
 * Codexes appending to one rollout, which is the same cost the other menu
 * avoids — there is simply nothing on disk to avoid it with.
 *
 * Both files are private to Codex and neither is a promise to us, so every read
 * is defensive in the same way `transcripts.js` and `usage.js` are: anything
 * unrecognised becomes an empty list rather than an error. The worst this
 * feature is allowed to do is show nothing.
 */

// Only ever read.
const SESSIONS_DIR = 'sessions';
const HISTORY_FILE = 'history.jsonl';

// As in `transcripts.js`: a bounded window off the end of an append-only file
// that is never trimmed, so a right click costs the same in a year as today.
const TAIL_BYTES = 2 * 1024 * 1024;

// How many rollout files to open. Newest first, so this is a depth into the
// past rather than an arbitrary subset — 300 sessions is months of steady use,
// and the menu only ever shows ten of them.
const MAX_FILES = 300;

// How much of the front of a rollout file to read. Only the first line is
// wanted and it is the longest one in the file — `session_meta` can carry the
// whole system prompt — so this is generous on purpose and still one read.
const HEAD_BYTES = 64 * 1024;

// How many rows the menu offers, matching the other agent's.
const MAX_ROWS = 10;

// The date folders Codex nests sessions in: a four-digit year, two-digit month
// and day. Matched rather than walked blindly, so a stray folder in there is
// not descended into.
const DATE_DIR = /^\d{2,4}$/;
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;

// year / month / day, and no deeper.
const MAX_DEPTH = 3;

/**
 * Where Codex keeps its files.
 *
 * `CODEX_HOME` is Codex's own escape hatch and moves the whole tree, so it is
 * honoured; `HANGAR_CODEX_HOME` is ours, and is how the tests point at a temp
 * folder without touching a real install.
 */
function codexHome(env = process.env) {
  return env.HANGAR_CODEX_HOME || env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * A timestamp in any of the shapes these files use.
 *
 * The rollout header writes ISO strings; history.jsonl writes a number. Which
 * unit that number is in has not always been the same, so both are read: a
 * value small enough to be a date in 1973 when taken as milliseconds is seconds
 * instead. Anything unreadable is 0, which sorts to the bottom of the menu
 * rather than throwing on the way to it.
 */
function when(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/**
 * The first `bytes` of a file as text.
 *
 * The mirror of `readTail` in `transcripts.js`, and simpler than it: a file
 * read from the front starts on a line boundary, so there is no half-line for
 * the caller to drop.
 */
function readHead(file, bytes, deps = {}) {
  const { io = fs } = deps;

  let fd = null;
  try {
    fd = io.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const read = io.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, read);
  } catch {
    // No codex on this machine, a file being written right now, or one we are
    // not allowed to read. Nothing to offer and nothing to say about it.
    return '';
  } finally {
    if (fd !== null) {
      try { io.closeSync(fd); } catch { /* nothing left to do about it */ }
    }
  }
}

/**
 * The newest rollout files, newest first, at most `limit` of them.
 *
 * Names are sorted descending at every level, which is chronological at every
 * level: the date folders are zero-padded numbers and the file names begin with
 * an ISO timestamp. So this walks the newest day first and stops as soon as it
 * has enough, without reading a single file or asking for a single stat.
 *
 * Older Codex versions wrote the files flat into `sessions/` rather than under
 * date folders. Both shapes fall out of the same walk — a name is a rollout, a
 * date folder, or ignored.
 */
function rolloutFiles(dir, deps = {}) {
  const { readdir = fs.readdirSync, limit = MAX_FILES } = deps;
  const out = [];

  function walk(at, depth) {
    if (out.length >= limit) return;

    let names;
    try {
      names = readdir(at);
    } catch {
      return;   // no directory yet, which is the same as nothing to list
    }

    for (const name of [...names].sort().reverse()) {
      if (out.length >= limit) return;
      if (ROLLOUT_FILE.test(name)) out.push(path.join(at, name));
      else if (depth < MAX_DEPTH && DATE_DIR.test(name)) walk(path.join(at, name), depth + 1);
    }
  }

  walk(dir, 0);
  return out;
}

/**
 * The `session_meta` line of a rollout file as `{ id, cwd, at }`, or null.
 *
 * Codex has moved this record about between versions — the payload has been
 * both `payload` and `item`, and the id both `id` and `session_id` — so all of
 * the spellings are tried. Anything that does not end up carrying a real
 * session id and a folder is skipped rather than guessed at: an id read off
 * disk ends up on a command line, so it goes through the same UUID check the
 * other agent's does.
 */
function parseMeta(head) {
  const line = String(head).split('\n', 1)[0];
  if (!line) return null;

  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;   // a torn write, or a format we don't know
  }
  if (!entry || typeof entry !== 'object') return null;
  // A file whose first line is something else entirely is not one of ours.
  if (entry.type && entry.type !== 'session_meta') return null;

  const meta = entry.payload || entry.item || entry;
  if (!meta || typeof meta !== 'object') return null;

  const id = meta.id || meta.session_id;
  if (!isSessionId(id) || typeof meta.cwd !== 'string' || !meta.cwd) return null;

  return { id, cwd: meta.cwd, at: when(meta.timestamp) || when(entry.timestamp) };
}

/**
 * The prompt lines out of history text, as `{ id, at, prompt }`.
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
      continue;
    }

    if (!entry || typeof entry !== 'object') continue;
    if (!isSessionId(entry.session_id)) continue;

    out.push({ id: entry.session_id, at: when(entry.ts), prompt: entry.text });
  }
  return out;
}

/** Every session on this machine that has a rollout file worth reading. */
function readSessions(deps = {}) {
  const { env = process.env, head = readHead, headBytes = HEAD_BYTES } = deps;
  const dir = path.join(codexHome(env), SESSIONS_DIR);

  const out = [];
  for (const file of rolloutFiles(dir, deps)) {
    const meta = parseMeta(head(file, headBytes, deps));
    if (meta) out.push(meta);
  }
  return out;
}

function readHistory(deps = {}) {
  const { env = process.env, tailBytes = TAIL_BYTES } = deps;
  return readTail(path.join(codexHome(env), HISTORY_FILE), tailBytes, deps);
}

/**
 * The menu: this project's codex sessions, newest first.
 *
 * Named after the first thing asked of a session and dated by the last, which
 * is the same rule the other agent's menu follows and for the same reasons —
 * the first prompt is the only thing in the file anybody chose, and the last
 * activity is when it was really last touched.
 *
 * A session with no prompt in the window is still listed, under its id. That
 * differs from the Claude menu, which drops those, and it has to: there the
 * history file is the list, so a session missing from it is a session with
 * nothing to go back to. Here the rollout file is the list, and a session
 * missing from history is far more often one whose prompts are simply older
 * than the window than one that was never spoken to.
 */
function recentFor(projectPath, deps = {}) {
  const {
    sessions = readSessions,
    history = readHistory,
    limit = MAX_ROWS,
    platform = process.platform,
  } = deps;

  if (!projectPath) return [];

  const mine = new Map();
  for (const meta of sessions(deps)) {
    if (!samePath(meta.cwd, projectPath, platform)) continue;

    // A session can have more than one rollout file — Codex starts a new one
    // when a resumed session is forked — so the newest wins the date.
    const row = mine.get(meta.id);
    if (!row) mine.set(meta.id, { id: meta.id, at: meta.at, label: null, labelAt: 0 });
    else if (meta.at > row.at) row.at = meta.at;
  }

  if (mine.size === 0) return [];

  for (const entry of parseHistory(history(deps))) {
    const row = mine.get(entry.id);
    if (!row) continue;   // another project's, or older than the rollouts read

    if (entry.at > row.at) row.at = entry.at;

    // Every prompt counts towards the date, only a real one towards the name:
    // a session made of nothing but `/status` and `/diff` was never a
    // conversation, and neither is a name.
    const text = isBareCommand(entry.prompt) ? null : label(entry.prompt);
    if (text && (!row.label || entry.at < row.labelAt)) {
      row.label = text;
      row.labelAt = entry.at;
    }
  }

  return [...mine.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      at: row.at,
      label: row.label || `session ${row.id.slice(0, 8)}`,
      // Codex publishes no record of what is running, so nothing here can be
      // greyed out. See the note at the top of this file.
      live: false,
      // Built here, where the id has been checked, rather than glued together
      // from a raw id on the other side of the bridge.
      command: `codex resume ${row.id}`,
    }));
}

module.exports = {
  SESSIONS_DIR,
  HISTORY_FILE,
  TAIL_BYTES,
  MAX_FILES,
  MAX_ROWS,
  codexHome,
  when,
  readHead,
  rolloutFiles,
  parseMeta,
  parseHistory,
  readSessions,
  readHistory,
  recentFor,
};
