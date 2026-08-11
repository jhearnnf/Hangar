'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Put xterm into `www/vendor` so the phone has a terminal to draw in.
 *
 * The desktop app loads xterm straight out of `node_modules` with a script tag,
 * because it runs from the source tree and can. An APK cannot: whatever the
 * page needs has to be inside it, and Capacitor only packages `www`.
 *
 * Copied rather than bundled, for the same reason there is no build step
 * anywhere else here — the files that ship are files you can read. Copied from
 * the *desktop's* node_modules rather than a second install, so the phone and
 * the PC can never end up drawing the same escape sequences two different ways.
 */

const root = path.resolve(__dirname, '..', '..');
const modules = path.join(root, 'node_modules');
const vendor = path.join(__dirname, '..', 'www', 'vendor');

const FILES = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-unicode11/lib/addon-unicode11.js', 'addon-unicode11.js'],
];

fs.mkdirSync(vendor, { recursive: true });

for (const [from, to] of FILES) {
  const source = path.join(modules, from);
  if (!fs.existsSync(source)) {
    console.error(`sync-www: ${from} is missing — run npm install in ${root} first.`);
    process.exit(1);
  }
  fs.copyFileSync(source, path.join(vendor, to));
  console.log(`sync-www: ${to}`);
}
