'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * A one-way mirror of a project folder into Dropbox, so a dead machine costs
 * nothing.
 *
 * Deliberately not a sync. The copy is only ever written to, never read back,
 * and exists to be restored from rather than worked in. Robocopy's /MIR makes
 * the destination match the source exactly, which means anything edited over
 * there is lost on the next run — fine for a backup, fatal for a working copy.
 *
 * Dependencies are injectable so the argument building and the refusals can be
 * tested without touching a disk.
 */

// Left out of the mirror because they are large, regenerable, or actively
// hostile to a file-sync client. `.git` is the last of those: a commit writes
// the index, the refs and the objects as a set that is only coherent all
// together, and Dropbox uploads them separately and out of order, so a synced
// .git stands a good chance of arriving corrupt.
const EXCLUDE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.pytest_cache',
];

const EXCLUDE_FILES = ['*.log', 'Thumbs.db', '.DS_Store'];

/**
 * Where mirrors go when nobody has said. Only a fallback now — the real answer
 * comes from the settings the setup screen writes and is passed in as `root`.
 */
function backupRoot(env = process.env) {
  return env.HANGAR_BACKUP_ROOT || path.join(os.homedir(), 'HangarBackups');
}

/**
 * Where a project's mirror goes, or null if the name is not one we are willing
 * to mirror onto. The destination is about to have /MIR pointed at it, so a
 * path that escapes the backup root would take whatever it landed on with it.
 */
function destinationFor(projectPath, root) {
  const name = path.basename(projectPath);
  if (!name || name === '.' || name === '..') return null;

  const dest = path.resolve(root, name);
  if (!dest.startsWith(path.resolve(root) + path.sep)) return null;
  return dest;
}

function robocopyArgs(source, dest) {
  return [
    source, dest,
    '/MIR',
    '/XD', ...EXCLUDE_DIRS,
    '/XF', ...EXCLUDE_FILES,
    // Dropbox opens files in the destination to hash and upload them, and a
    // file it has open cannot be replaced or deleted, so a mirror will now and
    // then lose a race it would win a second later. Three retries two seconds
    // apart rides that out while still giving up in under ten seconds, rather
    // than robocopy's default of a million attempts a minute apart.
    '/R:3', '/W:2',
    '/MT:8',
    // Silent: the exit code is the only part we read.
    '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
  ];
}

/**
 * Robocopy answers with a bit field rather than the usual zero-or-not. Bits 0
 * to 2 are ordinary outcomes — files were copied, the destination had extras,
 * something mismatched — and only 8 and above mean a file failed to copy.
 */
function succeeded(code) {
  return typeof code === 'number' && code >= 0 && code < 8;
}

function describe(code) {
  if (code === 0) return 'already up to date';
  if (succeeded(code)) return 'backed up';
  if (code >= 16) return 'failed: robocopy hit a fatal error';
  return 'failed: some files could not be copied';
}

/**
 * Validate a request and make the destination folder. Returns either the pair
 * of paths to hand robocopy, or the reason we will not run it.
 */
function prepare(projectPath, { root = backupRoot(), exists = fs.existsSync, mkdir = fs.mkdirSync } = {}) {
  // Checked before resolving, not after: resolve() turns '..' into a perfectly
  // ordinary absolute path, and mirroring the whole projects root because of a
  // relative one is exactly the accident this is here to stop. Projects always
  // arrive absolute from listProjects(), so nothing legitimate is turned away.
  if (!projectPath || !path.isAbsolute(projectPath)) {
    return { error: 'refused: not an absolute project path' };
  }

  const source = path.resolve(projectPath);
  const dest = destinationFor(source, root);

  if (!dest) return { error: 'refused: not a plain project name' };

  // /MIR deletes everything the source does not have, so a source that has
  // gone missing would quietly empty the backup instead of filling it.
  if (!exists(source)) return { error: 'refused: the project folder is missing' };

  try {
    mkdir(dest, { recursive: true });
  } catch (err) {
    return { error: `cannot create the backup folder: ${err.message}` };
  }

  return { source, dest };
}

/** Mirror one project and resolve with how it went. */
function mirror(projectPath, deps = {}) {
  const { spawnFn = spawn } = deps;
  const plan = prepare(projectPath, deps);
  if (plan.error) return Promise.resolve({ ok: false, message: plan.error });

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnFn('robocopy', robocopyArgs(plan.source, plan.dest), {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (err) {
      resolve({ ok: false, message: err.message });
      return;
    }

    proc.on('error', (err) => resolve({ ok: false, message: err.message }));
    proc.on('close', (code) => resolve({ ok: succeeded(code), code, message: describe(code) }));
  });
}

/**
 * Mirror a whole list of projects on the way out, without holding the quit
 * open while they copy.
 *
 * Handed to a detached child process rather than spawned here, because the
 * copies have to run one at a time and nothing in this one will be alive to
 * start the second. `execPath` is Electron's own binary, which runs as plain
 * node when asked, so this needs no separate runtime.
 */
function sweepDetached(projectPaths, { spawnFn = spawn, execPath = process.execPath, root = backupRoot() } = {}) {
  const paths = (projectPaths || []).filter(Boolean);
  if (paths.length === 0) return false;

  try {
    const proc = spawnFn(execPath, [path.join(__dirname, 'backup-sweep.js'), ...paths], {
      // The child re-derives its destination from the environment, since argv is
      // already carrying the project list. Setting it explicitly rather than
      // inheriting means the sweep lands where the settings say, not where the
      // launching shell happened to point.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HANGAR_BACKUP_ROOT: root },
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  backupRoot,
  destinationFor,
  robocopyArgs,
  succeeded,
  describe,
  prepare,
  mirror,
  sweepDetached,
  EXCLUDE_DIRS,
  EXCLUDE_FILES,
};
