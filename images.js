'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { claudeHome } = require('./transcripts');

/**
 * The pictures pasted into each terminal, kept where the terminals are.
 *
 * The window used to hold these itself, which meant a reload lost them. They
 * live down here now, next to the pty they were pasted into, so the window and
 * a phone both ask the same place and a reload asks again.
 *
 * Two ways in:
 *
 *   - Live. The window watched the clipboard go into a terminal and Claude
 *     print `[Image #N]` for it, and hands the picture over.
 *   - From Claude's transcript, for a chat picked up again after Hangar was
 *     closed. Claude records every pasted picture in its session file, beside
 *     the prompt it went with:
 *
 *       { type: 'user', imagePasteIds: [3],
 *         message: { content: [{ type: 'text', text: '[Image #3] look' },
 *                              { type: 'image', source: { type: 'base64', … } }] } }
 *
 *     Found by the session id in a `claude --resume <id>` command when there
 *     is one, and otherwise by matching the `[Image #N] …` line a resumed chat
 *     replays against the project's recent transcripts.
 *
 * The transcript is Claude's private file and promises nothing, so every read
 * here falls back to "no pictures" rather than an error.
 */

const RESUME = /(?:^|\s)--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i;
const DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const MEDIA_TYPE = /^image\/(?:png|jpeg|gif|webp)$/;
const BASE64 = /^[A-Za-z0-9+/=]+$/;

// Screenshots are a few megabytes each as data URLs. Past this many the oldest
// go, rather than a long session quietly holding hundreds.
const MAX_PER_TERMINAL = 40;

// How many of a project's transcripts a replayed placeholder is looked for in,
// newest first. A chat worth resuming is nearly always a recent one.
const SEARCH_FILES = 15;

// A replayed line shorter than this is too little to tell two chats apart by.
const MIN_SNIPPET = 4;

/** The folder Claude keeps a project's transcripts in. */
function projectDir(cwd, env = process.env) {
  return path.join(claudeHome(env), 'projects', String(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

/** The session id a `claude --resume <id>` command names, or null. */
function resumedSession(command) {
  const m = typeof command === 'string' ? RESUME.exec(command) : null;
  return m ? m[1].toLowerCase() : null;
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Every pasted picture in a transcript, in order, as `{ n, text, url }`.
 *
 * `withData: false` skips building the data URLs, for the search, which only
 * needs to know which numbers and prompts are in a file.
 */
function parseTranscript(text, { withData = true } = {}) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.includes('"imagePasteIds"')) continue;

    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.type !== 'user' || !Array.isArray(entry.imagePasteIds)) continue;

    const content = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
    const pictures = content.filter((b) => b && b.type === 'image' && b.source
      && b.source.type === 'base64' && typeof b.source.data === 'string');
    const prompt = normalize(content.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join(' '));

    entry.imagePasteIds.forEach((n, i) => {
      const picture = pictures[i];
      if (!picture || !Number.isInteger(n) || n < 1) return;
      const found = { n, text: prompt };
      if (withData) {
        if (!BASE64.test(picture.source.data)) return;
        const type = MEDIA_TYPE.test(picture.source.media_type) ? picture.source.media_type : 'image/png';
        found.url = `data:${type};base64,${picture.source.data}`;
      }
      out.push(found);
    });
  }
  return out;
}

/** Does this transcript picture belong to the line `[Image #n] <snippet>`? */
function matchesLine(found, n, snippet) {
  const tail = normalize(snippet);
  if (found.n !== n || tail.length < MIN_SNIPPET) return false;
  return found.text.includes(`[Image #${n}] ${tail}`);
}

function createImageStore(deps = {}) {
  const {
    env = process.env,
    readFile = (file) => fs.promises.readFile(file, 'utf8'),
    readdir = (dir) => fs.promises.readdir(dir),
    stat = (file) => fs.promises.stat(file),
    max = MAX_PER_TERMINAL,
    searchFiles = SEARCH_FILES,
    log = () => {},
  } = deps;

  const emitter = new EventEmitter();
  const terminals = new Map();   // hangar terminal id -> { cwd, images, linked, tried }
  // A light index of transcripts already searched: numbers and prompts only,
  // keyed on size and time so a file that has grown is read again.
  const index = new Map();
  let keySeq = 0;

  function changed(id) {
    emitter.emit('changed', { id });
  }

  /** A terminal appeared. Picks up its pictures at once if it is a resume. */
  function open(id, { cwd, command } = {}) {
    if (!id || terminals.has(id)) return Promise.resolve(false);
    terminals.set(id, { cwd: cwd || '', images: [], linked: null, tried: new Set() });
    const resumed = resumedSession(command);
    return resumed ? link(id, resumed) : Promise.resolve(false);
  }

  function close(id) {
    terminals.delete(id);
  }

  function list(id) {
    const t = terminals.get(id);
    return t ? t.images.map(({ key, n, url }) => ({ key, n, url })) : [];
  }

  function meta(id) {
    const t = terminals.get(id);
    return t ? t.images.map(({ key, n }) => ({ key, n })) : [];
  }

  function get(id, key) {
    const t = terminals.get(id);
    const found = t && t.images.find((img) => img.key === key);
    return found ? found.url : null;
  }

  function trim(t) {
    if (t.images.length > max) t.images.splice(0, t.images.length - max);
  }

  /** A picture the window just watched go in. Replaces any older one with its number. */
  function add(id, n, url) {
    const t = terminals.get(id);
    if (!t || !Number.isInteger(n) || n < 1 || typeof url !== 'string' || !DATA_URL.test(url)) return false;
    t.images = t.images.filter((img) => img.n !== n);
    t.images.push({ key: `i${++keySeq}`, n, url });
    trim(t);
    changed(id);
    return true;
  }

  function remove(id, key) {
    const t = terminals.get(id);
    if (!t) return false;
    const before = t.images.length;
    t.images = t.images.filter((img) => img.key !== key);
    if (t.images.length === before) return false;
    changed(id);
    return true;
  }

  /** Fill in, from a transcript, every number this terminal has no picture for. */
  function merge(id, found) {
    const t = terminals.get(id);
    if (!t) return 0;
    let added = 0;
    for (const img of found) {
      if (t.images.some((have) => have.n === img.n)) continue;
      t.images.push({ key: `i${++keySeq}`, n: img.n, url: img.url });
      added++;
    }
    if (added) {
      trim(t);
      changed(id);
    }
    return added;
  }

  async function readPictures(file) {
    try {
      return parseTranscript(await readFile(file));
    } catch (err) {
      log(`could not read ${file}: ${err && err.message}`);
      return [];
    }
  }

  /** Tie a terminal to one Claude session and take its pictures. */
  async function link(id, sessionId) {
    const t = terminals.get(id);
    if (!t) return false;
    t.linked = sessionId;
    const found = await readPictures(path.join(projectDir(t.cwd, env), `${sessionId}.jsonl`));
    return merge(id, found) > 0;
  }

  async function indexed(file) {
    let info;
    try { info = await stat(file); } catch { return []; }
    const cached = index.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.found;
    let found = [];
    try { found = parseTranscript(await readFile(file), { withData: false }); } catch { /* unreadable */ }
    index.set(file, { mtimeMs: info.mtimeMs, size: info.size, found });
    return found;
  }

  /**
   * A terminal is showing `[Image #n] <snippet>` and has no picture for it.
   *
   * If the terminal is already tied to a session, that transcript is read
   * again — the prompt has very likely just been sent. Otherwise the project's
   * recent transcripts are searched for the line, and the first that has it
   * becomes this terminal's session.
   */
  async function find(id, n, snippet) {
    const t = terminals.get(id);
    if (!t || !Number.isInteger(n) || t.images.some((img) => img.n === n)) return false;

    // Claude can carry a resumed chat on in a new file, so a miss here falls
    // through to the search rather than giving up.
    if (t.linked) {
      await link(id, t.linked);
      if (t.images.some((img) => img.n === n)) return true;
    }

    const tail = normalize(snippet);
    if (tail.length < MIN_SNIPPET) return false;
    const asked = `${n}|${tail}`;
    if (t.tried.has(asked)) return false;
    t.tried.add(asked);

    const dir = projectDir(t.cwd, env);
    let names;
    try { names = await readdir(dir); } catch { return false; }

    const files = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try { files.push({ file, name, mtimeMs: (await stat(file)).mtimeMs }); } catch { /* gone */ }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const { file, name } of files.slice(0, searchFiles)) {
      const found = await indexed(file);
      if (!found.some((img) => matchesLine(img, n, tail))) continue;
      if (!terminals.has(id)) return false;
      await link(id, name.slice(0, -'.jsonl'.length));
      return true;
    }
    return false;
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    open, close, list, meta, get, add, remove, find, link,
  };
}

module.exports = {
  createImageStore,
  projectDir,
  resumedSession,
  parseTranscript,
  matchesLine,
  MAX_PER_TERMINAL,
};
