'use strict';

/**
 * Puts the executable bit back on node-pty's spawn-helper. Runs as postinstall,
 * so `npm install` and `npm ci` both leave a working tree behind.
 *
 * Every pty on macOS is spawned through a small helper binary that sets the
 * controlling terminal — `posix_spawn(pid, argv[0], ...)` in node-pty's
 * src/unix/pty.cc, where argv[0] is the helper and the shell is only argv[2].
 * The npm tarball records that helper as 0644, and npm extracts the mode it is
 * given, so a fresh install on a Mac has a helper that cannot be executed:
 * posix_spawn returns EACCES and node-pty turns every failure in that function
 * into the same bare string, "posix_spawnp failed." Nothing in it names the
 * helper, the errno, or the shell, which is why an unusable terminal there
 * looks like an unusable app.
 *
 * The binary itself is fine — the arm64 one is ad-hoc signed, so it runs once
 * it is allowed to. One mode bit is the whole repair.
 *
 * Windows goes through ConPTY and Linux through forkpty(); only the __APPLE__
 * branch of node-pty spawns a helper at all, so this is a no-op everywhere
 * else. It never fails an install: a tree it cannot fix is one the app will
 * describe when a terminal is asked for.
 */

const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') process.exit(0);

let root;
try {
  // .../node-pty/lib/index.js -> .../node-pty
  root = path.dirname(path.dirname(require.resolve('node-pty')));
} catch {
  process.exit(0);
}

// The same places, in the same order, that node-pty's own loadNativeModule
// looks in for pty.node — the helper sits beside whichever one was loaded.
const candidates = [
  path.join(root, 'build', 'Release', 'spawn-helper'),
  path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
];

for (const helper of candidates) {
  try {
    const { mode } = fs.statSync(helper);
    if (mode & 0o111) continue;
    fs.chmodSync(helper, mode | 0o111);
    console.log(`node-pty: restored the executable bit on ${path.relative(process.cwd(), helper)}`);
  } catch { /* not built, or not writable — either way not worth failing an install over */ }
}
