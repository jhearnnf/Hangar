'use strict';

/**
 * Puts Hangar's own icon on the phone's home screen.
 *
 *   npm run icon      (in mobile/)
 *
 * Same trick as the desktop's tools/make-icon.js and for the same reason:
 * Chromium is already sitting in node_modules and renders the SVG exactly as
 * the app would, so there is no image toolchain to install and nothing to
 * commit but the source drawing. Both share tools/icon-render.js.
 *
 * Android wants the icon twice over. The legacy `ic_launcher.png` is the whole
 * icon at five sizes, for anything before Android 8. The adaptive icon is a
 * *layer* — a foreground drawn on a 108dp canvas of which only the middle 66dp
 * is guaranteed to survive, because the launcher crops it into whatever shape
 * that phone's manufacturer decided on. Drawing the icon at full bleed into
 * that canvas is the classic way to end up with the corners sliced off, so the
 * foreground here is the icon at 61% in the middle of a transparent square.
 *
 * That margin only works if it really is transparent. A foreground with an
 * opaque background is a solid square the launcher masks into a solid blob,
 * which hides the background layer entirely — see icon-render.js for how the
 * transparency is recovered from Chromium.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const { makeWindow, renderIcon, encodePng } = require('../../tools/icon-render');

const SVG = path.join(__dirname, '..', '..', 'assets', 'icon.svg');
const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

// One entry per screen density Android asks for.
const DENSITIES = [
  { dir: 'mipmap-mdpi', legacy: 48, adaptive: 108 },
  { dir: 'mipmap-hdpi', legacy: 72, adaptive: 162 },
  { dir: 'mipmap-xhdpi', legacy: 96, adaptive: 216 },
  { dir: 'mipmap-xxhdpi', legacy: 144, adaptive: 324 },
  { dir: 'mipmap-xxxhdpi', legacy: 192, adaptive: 432 },
];

// 66dp of safe zone inside a 108dp canvas.
const SAFE = 66 / 108;

app.disableHardwareAcceleration();

// The frame is fixed, so anything larger than it would be cropped rather than
// rendered. 432 is the largest Android asks for.
const FRAME = 512;

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG, 'utf8');
  const win = makeWindow(BrowserWindow, FRAME);

  for (const density of DENSITIES) {
    const dir = path.join(RES, density.dir);
    fs.mkdirSync(dir, { recursive: true });

    const legacy = encodePng(await renderIcon(win, svg, density.legacy, 1), density.legacy, density.legacy);
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), legacy);
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), legacy);

    const size = density.adaptive;
    const rgba = await renderIcon(win, svg, size, SAFE);
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), encodePng(rgba, size, size));

    console.log(`${density.dir}  ${density.legacy}px + ${size}px foreground  corner alpha ${rgba[3]}`);
  }

  // The colour behind the foreground layer, which is the app's own background
  // rather than the white Capacitor ships — a white square around a dark icon
  // is the thing that makes an app look unfinished on a home screen.
  const values = path.join(RES, 'values');
  fs.mkdirSync(values, { recursive: true });
  fs.writeFileSync(path.join(values, 'ic_launcher_background.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<resources>\n'
    + '    <color name="ic_launcher_background">#12141A</color>\n'
    + '</resources>\n');

  console.log('ic_launcher_background.xml  #12141A');
  app.exit(0);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
