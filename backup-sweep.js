'use strict';

/**
 * Mirrors a list of projects one after another, as its own process.
 *
 * Spawned detached on the way out, so quitting Hangar stays instant however
 * much there is left to copy. Sequential on purpose: every project is on the
 * same disk and headed for the same destination, so running fifteen robocopies
 * at once only makes them queue somewhere less visible.
 *
 * Takes project paths as arguments rather than finding them itself, so the
 * caller stays the only thing that decides what counts as a project. The
 * destination arrives as HANGAR_BACKUP_ROOT, which the parent sets from the
 * saved settings before spawning this.
 */

const { mirror } = require('./backup');

(async function sweep() {
  for (const projectPath of process.argv.slice(2)) {
    // One unreachable project must not cost the rest their backup.
    try {
      await mirror(projectPath);
    } catch { /* nothing here can report anywhere useful */ }
  }
})();
