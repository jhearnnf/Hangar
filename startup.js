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

function loginItem({
  execPath,
  appPath,
  packaged = false,
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

module.exports = { loginItem, startedHidden, HIDDEN_FLAG };
