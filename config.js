'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const { DEFAULT: DEFAULT_AGENT, isAgentId } = require('./agents');

/**
 * The handful of settings that used to be environment variables.
 *
 * Env vars are fine for the person who wrote the app and useless to anyone
 * else, so the same three answers now come from a file the setup screen writes.
 * The env var still wins where it is set — it is the escape hatch for a machine
 * where the saved answer is wrong and the UI is not reachable, and it is how
 * the tests point everything at a temp folder.
 *
 * Everything here is pure apart from the two `fs` defaults, both injectable, so
 * the resolution order can be tested without a disk or an Electron.
 */

// A first run is the absence of this file, not a flag inside it: a config that
// failed to parse should re-ask rather than silently run on defaults, and this
// way it does.
const CONFIG_FILE = 'config.json';

// The port the phone talks to. Nothing famous lives here, and it is only ever
// listened on when someone has ticked the box.
const DEFAULT_REMOTE_PORT = 7433;

const DEFAULTS = {
  projectsRoot: '',      // filled in by suggestions() — depends on where Hangar sits
  backupEnabled: false,  // off until someone says otherwise; it writes to disk
  backupRoot: '',
  // All three of these are off until asked for, and for the same reason: each
  // one does something outside this window — opens a port, writes a startup
  // entry — that nobody should discover after the fact.
  remoteEnabled: false,
  remotePort: DEFAULT_REMOTE_PORT,
  autoStart: false,
  startMinimised: false,
  // Which agent the + button opens. Not in that group: it changes nothing
  // outside this window and there is no answer that does nothing, so it starts
  // on the one most people here are running rather than on nobody.
  agent: DEFAULT_AGENT,
};

/**
 * Where Dropbox is on this machine, or null.
 *
 * Only used to offer a sensible default in the setup screen — nothing here
 * requires Dropbox, and a machine without it just gets a plain folder instead.
 * `Dropbox (Personal)` is what the installer creates for a personal account
 * alongside a work one.
 */
function detectDropbox({ home = os.homedir(), exists = fs.existsSync } = {}) {
  for (const name of ['Dropbox', 'Dropbox (Personal)']) {
    const dir = path.join(home, name);
    if (exists(dir)) return dir;
  }
  return null;
}

/**
 * What to put in the setup screen's fields before anyone touches them.
 *
 * `appDir` is Hangar's own folder. Its parent is the projects root, because the
 * sidebar lists Hangar's siblings — the layout the app assumes when nobody has
 * said otherwise.
 */
function suggestions(appDir, deps = {}) {
  const { home = os.homedir() } = deps;
  const dropbox = detectDropbox(deps);

  return {
    projectsRoot: path.dirname(appDir),
    // Inside Dropbox if there is one, since a backup that syncs off the machine
    // is worth more than one that dies with it. Otherwise a plain folder in the
    // home directory, which is at least somewhere to point a cloud client later.
    backupRoot: path.join(dropbox || home, 'HangarBackups'),
    dropbox,
  };
}

/** A saved config, or null if there is nothing usable saved. */
function parseConfig(raw) {
  let saved;
  try {
    // Notepad and PowerShell's `Set-Content -Encoding utf8` both put a byte
    // order mark on the front, and JSON.parse throws on it. We never write one,
    // but this file is plain JSON in a findable place and someone editing it by
    // hand should not have setup silently start over.
    saved = JSON.parse(String(raw).replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;

  const out = {};
  if (typeof saved.backupRoot === 'string') out.backupRoot = saved.backupRoot;
  if (typeof saved.backupEnabled === 'boolean') out.backupEnabled = saved.backupEnabled;

  // Read one at a time rather than spread in, so a hand-edited file with
  // nonsense in these fields falls back to the defaults for those fields alone
  // instead of taking the whole config down with it.
  if (typeof saved.remoteEnabled === 'boolean') out.remoteEnabled = saved.remoteEnabled;
  if (Number.isInteger(saved.remotePort)) out.remotePort = saved.remotePort;
  if (typeof saved.autoStart === 'boolean') out.autoStart = saved.autoStart;
  if (typeof saved.startMinimised === 'boolean') out.startMinimised = saved.startMinimised;
  // Checked against the table rather than kept as typed: this string names the
  // program the + button runs, and the only names it is allowed to name are
  // ones Hangar ships a row for.
  if (isAgentId(saved.agent)) out.agent = saved.agent;

  // The projects root is the one answer the setup screen always writes, so a
  // file without a usable one was not written by it — an empty object, or a
  // half-edited file. Null rather than a partial config, because null is what
  // puts the setup screen back up, and running on defaults nobody chose is the
  // outcome worth avoiding.
  if (typeof saved.projectsRoot !== 'string' || !saved.projectsRoot.trim()) return null;
  out.projectsRoot = saved.projectsRoot;

  return out;
}

/**
 * The settings the app should actually run on: env var, then saved answer, then
 * default, field by field.
 *
 * Per-field rather than whole-object, so `HANGAR_BACKUP_ROOT` on its own does
 * not discard a saved projects root.
 */
function resolveConfig(saved, { env = process.env, defaults = DEFAULTS } = {}) {
  const from = saved || {};
  // Callers pass the defaults they actually have an opinion about — the two
  // folders — so the rest are filled in from here rather than arriving
  // undefined and being mistaken for a deliberate answer.
  defaults = { ...DEFAULTS, ...defaults };

  const projectsRoot = env.HANGAR_PROJECTS_ROOT || from.projectsRoot || defaults.projectsRoot;
  const backupRoot = env.HANGAR_BACKUP_ROOT || from.backupRoot || defaults.backupRoot;

  // An explicit HANGAR_BACKUP_ROOT is someone asking for backups, so it turns
  // them on as well as pointing them somewhere — otherwise setting it on a
  // machine that had them off would look like it did nothing.
  const backupEnabled = env.HANGAR_BACKUP_ROOT
    ? true
    : (typeof from.backupEnabled === 'boolean' ? from.backupEnabled : defaults.backupEnabled);

  const port = Number(env.HANGAR_REMOTE_PORT) || from.remotePort || defaults.remotePort;

  return {
    projectsRoot,
    // A backup with nowhere to go is off however it was asked for.
    backupEnabled: Boolean(backupEnabled && backupRoot),
    backupRoot,

    // Same escape hatch as the folders: an environment variable wins, so a
    // machine where 7433 is taken can be moved without the UI.
    remoteEnabled: env.HANGAR_REMOTE_PORT
      ? true
      : (typeof from.remoteEnabled === 'boolean' ? from.remoteEnabled : defaults.remoteEnabled),
    remotePort: validPort(port) ? port : defaults.remotePort,
    autoStart: typeof from.autoStart === 'boolean' ? from.autoStart : defaults.autoStart,

    // Same escape hatch again, and the same fallback as everywhere else this
    // id is read: an agent Hangar has no row for is not an error to refuse
    // over, it is a machine that should still open a terminal.
    agent: isAgentId(env.HANGAR_AGENT) ? env.HANGAR_AGENT
      : (isAgentId(from.agent) ? from.agent : defaults.agent),
    // Minimised has nothing to be minimised *from* unless something starts it,
    // so it only means anything alongside autoStart.
    startMinimised: Boolean(
      (typeof from.startMinimised === 'boolean' ? from.startMinimised : defaults.startMinimised)),
  };
}

/** Ports Hangar will listen on: unprivileged, and real. */
function validPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/**
 * Check one of the setup screen's folder fields.
 *
 * The projects folder has to exist already — it is a place on disk being
 * pointed at, and a typo there shows an empty sidebar rather than an error. The
 * backup folder does not, since it is about to be created; it only has to be an
 * absolute path that is not inside the projects folder.
 */
function validateFolder(value, { mustExist = false, exists = fs.existsSync, platform = process.platform } = {}) {
  const example = platform === 'win32' ? 'C:\\Users\\you\\Projects' : '/Users/you/Projects';
  const trimmed = (value || '').trim();
  if (!trimmed) return { ok: false, message: 'Pick a folder.' };
  if (!path.isAbsolute(trimmed)) return { ok: false, message: `Needs to be a full path, like ${example}.` };
  if (mustExist && !exists(trimmed)) return { ok: false, message: 'There is no folder at that path.' };
  return { ok: true, value: path.resolve(trimmed) };
}

/** Whether `inner` sits inside `outer` — or is `outer`. */
function isInside(inner, outer) {
  if (!inner || !outer) return false;
  const a = path.resolve(inner);
  const b = path.resolve(outer);
  if (a === b) return true;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * Check a whole proposed settings object, the way the setup screen submits it.
 *
 * The one combination worth refusing outright is a backup folder inside the
 * projects folder. `robocopy /MIR` would then be copying a tree into itself,
 * which grows without bound and takes the projects root down with it.
 */
function validateConfig(input, deps = {}) {
  const projects = validateFolder(input && input.projectsRoot, { mustExist: true, ...deps });
  if (!projects.ok) return { ok: false, field: 'projectsRoot', message: projects.message };

  const given = input || {};

  // The port is typed into a text field, so it gets the same treatment as the
  // folders: refused with a reason rather than silently corrected, since a
  // phone that cannot find Hangar is a much worse thing to debug than a red
  // line under a box.
  const port = given.remotePort === undefined || given.remotePort === ''
    ? DEFAULTS.remotePort
    : Number(given.remotePort);
  if (!validPort(port)) {
    return { ok: false, field: 'remotePort', message: 'Pick a port between 1024 and 65535 — 7433 is the usual one.' };
  }

  const extras = {
    remoteEnabled: Boolean(given.remoteEnabled),
    remotePort: port,
    autoStart: Boolean(given.autoStart),
    startMinimised: Boolean(given.startMinimised),
    agent: isAgentId(given.agent) ? given.agent : DEFAULTS.agent,
  };

  const enabled = Boolean(given.backupEnabled);
  if (!enabled) {
    // The path is kept even when the toggle is off, so turning backups back on
    // does not mean picking the folder again.
    const kept = (given.backupRoot || '').trim();
    return {
      ok: true,
      config: { projectsRoot: projects.value, backupEnabled: false, backupRoot: kept, ...extras },
    };
  }

  const backup = validateFolder(input && input.backupRoot, { mustExist: false, ...deps });
  if (!backup.ok) return { ok: false, field: 'backupRoot', message: backup.message };

  if (isInside(backup.value, projects.value)) {
    return {
      ok: false,
      field: 'backupRoot',
      message: 'The backup folder cannot sit inside the projects folder — it would copy into itself.',
    };
  }

  if (isInside(projects.value, backup.value)) {
    return {
      ok: false,
      field: 'backupRoot',
      message: 'The projects folder cannot sit inside the backup folder.',
    };
  }

  return {
    ok: true,
    config: { projectsRoot: projects.value, backupEnabled: true, backupRoot: backup.value, ...extras },
  };
}

module.exports = {
  CONFIG_FILE,
  DEFAULTS,
  DEFAULT_REMOTE_PORT,
  detectDropbox,
  suggestions,
  parseConfig,
  resolveConfig,
  validateFolder,
  validPort,
  isInside,
  validateConfig,
};
