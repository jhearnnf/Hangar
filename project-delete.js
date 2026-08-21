'use strict';

const path = require('path');

/**
 * Whether a project folder is allowed to be deleted, and why not.
 *
 * Deleting is the one thing in here that cannot be undone by clicking again,
 * so the decision is kept away from the code that does it: a pure function
 * over paths, testable without a disk, run in the main process before anything
 * is touched. The renderer asks the same questions to grey the menu item out,
 * but nothing it says is trusted — the path arrives over IPC and this is the
 * side holding `fs`.
 *
 * `busy` is how many of Hangar's terminals are open in the folder. A shell
 * sitting in a directory holds it open on Windows, so a delete underneath one
 * fails halfway through and leaves a project half gone; and a folder being
 * worked in is not one anybody meant to throw away.
 */
function checkProjectDelete(target, { root, appDir = null, busy = 0 } = {}) {
  const fail = (message) => ({ ok: false, message });

  if (typeof target !== 'string' || !target.trim()) return fail('No project was named.');
  if (typeof root !== 'string' || !root.trim()) return fail('There is no projects folder set.');

  const dir = path.resolve(target);
  const base = path.resolve(root);

  // A direct child of the projects root and nothing else. The sidebar only
  // ever lists those, so anything else is either a mistake or an attempt to
  // point this at somewhere it has no business being — a parent folder, a
  // path with `..` in it, a drive.
  if (dir === base) return fail('That is the projects folder itself, not a project in it.');
  if (path.dirname(dir) !== base) {
    return fail('Only a folder directly inside the projects folder can be deleted here.');
  }

  // Hangar is usually a sibling of the projects it lists, so it appears in its
  // own sidebar. Deleting the running app is not a thing to find out about
  // afterwards.
  if (appDir && path.resolve(appDir) === dir) return fail('That is Hangar itself.');

  if (busy > 0) {
    return fail(busy === 1
      ? 'A terminal is still open in this project. Close it first.'
      : `${busy} terminals are still open in this project. Close them first.`);
  }

  return { ok: true, path: dir, name: path.basename(dir) };
}

module.exports = { checkProjectDelete };
