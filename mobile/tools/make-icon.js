'use strict';

/**
 * Puts Hangar's own icon on the phone's home screen.
 *
 *   npm run icon      (in mobile/)
 *
 * Same trick as the desktop's tools/make-icon.js and for the same reason:
 * Chromium is already sitting in node_modules and renders the SVG exactly as
 * the app would, so there is no image toolchain to install and nothing to
 * commit but the source drawing.
 *
 * Android wants the icon twice over. The legacy `ic_launcher.png` is the whole
 * icon at five sizes, for anything before Android 8. The adaptive icon is a
 * *layer* — a foreground drawn on a 108dp canvas of which only the middle 66dp
 * is guaranteed to survive, because the launcher crops it into whatever shape
 * that phone's manufacturer decided on. Drawing the icon at full bleed into
 * that canvas is the classic way to end up with the corners sliced off, so the
 * foreground here is the icon at 61% in the middle of a transparent square.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

const FRAME = 512;

function makeWindow() {
  return new BrowserWindow({
    width: FRAME,
    height: FRAME,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
}

/**
 * Render the icon into a transparent square of `canvas` pixels, drawn at
 * `inset` of that (1 for the whole thing, SAFE for an adaptive foreground).
 */
function renderAt(win, svg, canvas, inset) {
  const drawn = Math.round(canvas * inset);
  const scaled = svg.replace(/width="\d+" height="\d+"/, `width="${drawn}" height="${drawn}"`);
  const pad = Math.round((canvas - drawn) / 2);

  const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      #box{width:${canvas}px;height:${canvas}px;padding:${pad}px;box-sizing:border-box}
      svg{display:block}
    </style><div id="box">${scaled}</div>`;

  const page = path.join(os.tmpdir(), `hangar-android-icon-${canvas}-${inset}.html`);
  fs.writeFileSync(page, html, 'utf8');

  return new Promise((resolve, reject) => {
    let latest = null;
    const onPaint = (_event, _dirty, image) => { if (!image.isEmpty()) latest = image; };
    win.webContents.on('paint', onPaint);

    const finish = (err, png) => {
      clearTimeout(timer);
      win.webContents.off('paint', onPaint);
      fs.unlinkSync(page);
      if (err) reject(err); else resolve(png);
    };

    const timer = setTimeout(() => finish(new Error(`timed out at ${canvas}px`)), 20000);

    win.webContents.once('did-finish-load', () => {
      win.webContents.invalidate();
      setTimeout(() => {
        if (!latest) return finish(new Error(`no frame painted at ${canvas}px`));
        finish(null, latest.crop({ x: 0, y: 0, width: canvas, height: canvas }).toPNG());
      }, 500);
    });

    win.loadFile(page).catch((err) => finish(err));
  });
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG, 'utf8');
  const win = makeWindow();

  // The frame is fixed, so anything larger than it would be cropped rather than
  // rendered. 432 is the largest Android asks for and the window is 512.
  for (const density of DENSITIES) {
    const dir = path.join(RES, density.dir);
    fs.mkdirSync(dir, { recursive: true });

    const legacy = await renderAt(win, svg, density.legacy, 1);
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), legacy);
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), legacy);

    const foreground = await renderAt(win, svg, density.adaptive, SAFE);
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), foreground);

    console.log(`${density.dir}  ${density.legacy}px + ${density.adaptive}px foreground`);
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
