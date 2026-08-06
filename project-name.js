'use strict';

/**
 * What a new project folder is allowed to be called.
 *
 * Shared on purpose: the modal runs it on every keystroke to keep the create
 * button honest, and the main process runs it again before it touches the
 * disk, so a renderer that got ahead of itself can never create a folder the
 * sidebar would then refuse to list.
 *
 * Loaded as a plain <script> in the renderer and as a CommonJS module in the
 * main process and the tests, so keep it dependency-free.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProjectName = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_LENGTH = 64;

  // Everything Windows refuses in a path component, plus the control range.
  // The separators are in here too, which is also what stops a name from
  // climbing out of the projects folder.
  const ILLEGAL = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001F]');

  // Device names. Still reserved whatever extension is stapled on the end.
  const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

  function fail(message) {
    return { ok: false, message };
  }

  /**
   * Check `raw` as a project folder name.
   *
   * `existing` is the names already in the projects folder, and `ignored` the
   * ones listing skips (node_modules and friends) — a project called one of
   * those would be created and then never appear, which reads as the button
   * having done nothing.
   *
   * Returns `{ ok: true, name }` with the name trimmed as it will be created,
   * or `{ ok: false, message }` with something to show under the field.
   */
  function validateProjectName(raw, { existing = [], ignored = [] } = {}) {
    const name = String(raw == null ? '' : raw).trim();

    if (!name) return fail('Type a name for the project folder.');
    if (name.length > MAX_LENGTH) return fail(`Keep it to ${MAX_LENGTH} characters or fewer.`);
    if (ILLEGAL.test(name)) return fail('A folder name cannot contain < > : " / \\ | ? *');
    if (name.endsWith('.')) return fail('A folder name cannot end in a dot.');
    if (DEVICE.test(name)) return fail(`"${name}" is a name Windows reserves.`);

    // Both of these would be created quite happily and then filtered straight
    // back out of the sidebar.
    if (name.startsWith('.')) return fail('A name starting with a dot is hidden, so it would not be listed.');
    if (ignored.some((n) => n.toLowerCase() === name.toLowerCase())) {
      return fail(`A folder called ${name} is never listed as a project.`);
    }

    // Case-insensitively, because the filesystem underneath is: "Hangar" and
    // "hangar" would be the same folder.
    if (existing.some((n) => n.toLowerCase() === name.toLowerCase())) {
      return fail('There is already a project with that name.');
    }

    return { ok: true, name };
  }

  return { validateProjectName, MAX_LENGTH };
});
