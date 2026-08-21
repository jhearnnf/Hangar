'use strict';

const path = require('path');
const { validateProjectName } = require('./project-name');

/**
 * Whether a project folder can be given a different name, and why not.
 *
 * The path half of this is the same argument `project-delete.js` makes and for
 * the same reason: the folder about to be moved is named by a renderer over
 * IPC, so the side holding `fs` decides for itself that it is a project and not
 * a parent folder, a drive, or Hangar. The name half is the new-project rules
 * (`project-name.js`) run again — a folder renamed to something the sidebar
 * filters out would vanish from the list, which reads as the rename having
 * deleted it.
 *
 * `busy` is how many of Hangar's terminals are open in the folder. A shell
 * sitting in a directory holds it open on Windows, so the rename fails outright
 * — and every terminal, backup and session in here is remembered by path, so
 * the folder moving under one is not worth being clever about. Close them.
 *
 * The folder's own name is not something for it to clash with, so a rename that
 * only changes case — `hangar` to `Hangar`, which is the whole point on a
 * filesystem that does not care — is allowed rather than refused as a name
 * already taken.
 */
function checkProjectRename(target, raw, { root, appDir = null, busy = 0, existing = [], ignored = [] } = {}) {
  const fail = (message) => ({ ok: false, message });

  if (typeof target !== 'string' || !target.trim()) return fail('No project was named.');
  if (typeof root !== 'string' || !root.trim()) return fail('There is no projects folder set.');

  const from = path.resolve(target);
  const base = path.resolve(root);
  const was = path.basename(from);

  if (from === base) return fail('That is the projects folder itself, not a project in it.');
  if (path.dirname(from) !== base) {
    return fail('Only a folder directly inside the projects folder can be renamed here.');
  }

  // Renaming the running app out from under itself is not a thing to find out
  // about afterwards, and Hangar is usually a sibling of what it lists.
  if (appDir && path.resolve(appDir) === from) return fail('That is Hangar itself.');

  if (busy > 0) {
    return fail(busy === 1
      ? 'A terminal is still open in this project. Close it first.'
      : `${busy} terminals are still open in this project. Close them first.`);
  }

  const check = validateProjectName(raw, {
    existing: existing.filter((n) => typeof n === 'string' && n.toLowerCase() !== was.toLowerCase()),
    ignored,
  });
  if (!check.ok) return check;

  if (check.name === was) return fail(`It is already called ${was}.`);

  const to = path.resolve(base, check.name);
  // Belt and braces, as in `makeProject`: the name rules already bar separators
  // and `..`, but a folder is about to be moved on the strength of something
  // typed into a text field.
  if (path.dirname(to) !== base) return fail('That name would not sit inside the projects folder.');

  return { ok: true, from, to, name: check.name, was };
}

module.exports = { checkProjectRename };
