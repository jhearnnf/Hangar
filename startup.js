'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Starting with Windows.
 *
 * This is the ordinary per-user startup list — the same one the Startup tab of
 * Task Manager shows and can turn off. No service, no scheduled task, nothing
 * elevated, and unticking the box in Settings takes the entry straight back
 * out. Electron writes it for us; all this file does is work out what to point
 * it at, which is the part that is easy to get wrong and worth testing.
 *
 * There are three candidates for "Hangar", and the difference between them is
 * what Windows shows in the startup list and on the taskbar:
 *
 *   - A packaged build, if there ever is one: the exe is the app, and it takes
 *     no arguments.
 *   - `Hangar.exe`, the icon-stamped copy of the Electron binary that
 *     `npm run exe` makes. This is the normal case for a checkout that has run
 *     the shortcut script, and it is the one that says "Hangar" rather than
 *     "Electron" in the startup list.
 *   - Plain `electron.exe`, which works and looks like Electron.
 *
 * The last two are running a source tree, so the folder has to travel with
 * them as an argument or the exe launches Electron's own welcome window.
 */

// Only ever passed by the startup entry, never by a person double-clicking the
// icon — which is the whole point of it. "Start minimised" has to mean *when
// Windows started it*, or opening Hangar yourself would appear to do nothing.
const HIDDEN_FLAG = '--hidden';

/**
 * Whether the exe *is* the app, rather than an Electron running a folder.
 *
 * Not `app.isPackaged`, which on Windows means no more than "the exe is not
 * called electron.exe" — and `npm run exe` renames it to Hangar.exe precisely
 * so the startup list says Hangar. Believing it there wrote an entry with the
 * folder left off, which is an Electron welcome window every morning.
 *
 * The layout answers it honestly instead: a packaged build keeps its app
 * inside the exe's own folder (`resources/app.asar`), while a checkout's exe
 * lives down in `node_modules` and the folder it is handed sits above it.
 */
function isPackagedLayout(execPath, appPath) {
  if (!execPath || !appPath) return false;
  const within = path.relative(path.dirname(execPath), appPath);
  return within !== '' && !within.startsWith('..') && !path.isAbsolute(within);
}

function loginItem({
  execPath,
  appPath,
  packaged = isPackagedLayout(execPath, appPath),
  hidden = false,
  exists = fs.existsSync,
} = {}) {
  const args = [];

  if (packaged) {
    if (hidden) args.push(HIDDEN_FLAG);
    return { path: execPath, args };
  }

  // `Hangar.exe` sits beside the electron binary it was copied from.
  const branded = path.join(path.dirname(execPath), 'Hangar.exe');
  const target = exists(branded) ? branded : execPath;

  args.push(appPath);
  if (hidden) args.push(HIDDEN_FLAG);
  return { path: target, args };
}

/** Whether this launch came from the startup entry rather than from a person. */
function startedHidden(argv = process.argv) {
  return argv.includes(HIDDEN_FLAG);
}

module.exports = { loginItem, startedHidden, isPackagedLayout, HIDDEN_FLAG };
