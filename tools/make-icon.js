'use strict';

/**
 * Rasterises assets/icon.svg into the PNGs and the .ico Windows needs.
 *
 *   npm run icon
 *
 * Runs under Electron rather than a build toolchain: Chromium is already a
 * dependency and renders the SVG exactly as the window would, so there is
 * nothing extra to install. Offscreen rendering keeps it headless.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ASSETS = path.join(__dirname, '..', 'assets');
const SVG = path.join(ASSETS, 'icon.svg');

// Explorer, the taskbar, alt-tab and the shortcut all pick different sizes.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// The Dock draws an icon far bigger than anything Windows asks for, and an
// .icns is expected to carry a 512 and a 1024 for retina. Neither is any use in
// an .ico — 256 is the largest entry that format has — so they are rendered
// only on the platform that reads them, and only ICO_SIZES is ever packed.
const MAC_SIZES = process.platform === 'darwin' ? [512, 1024] : [];
const SIZES = [...ICO_SIZES, ...MAC_SIZES];

// GPU compositing and offscreen capture disagree on some Windows drivers and
// you get blank frames. Software rendering is plenty for seven small images.
app.disableHardwareAcceleration();

// Windows clamps a window to a minimum size (asking for 16x16 gets you 32x39),
// so the frame is fixed at the largest icon and every size is drawn into its
// top-left corner and cropped out. That renders each size natively at its own
// scale rather than downsampling one master, which keeps the small ones crisp.
const FRAME = Math.max(...SIZES);

// One window, reused. Destroying an offscreen window and immediately opening
// another makes the next load fail with ERR_FAILED.
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

function renderAt(win, svg, size) {
  // Inline rather than an <img src>: Chromium refuses top-level navigation to
  // a data: URL, and a file:// page pulling in a file:// image is its own
  // fight. The SVG as live markup sidesteps both.
  const scaled = svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
  const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block}
    </style>${scaled}`;

  const page = path.join(os.tmpdir(), `hangar-icon-${size}.html`);
  fs.writeFileSync(page, html, 'utf8');

  return new Promise((resolve, reject) => {
    // The first paint is often the empty frame before layout lands, so keep
    // the most recent one and grab it once the page has settled.
    let latest = null;
    const onPaint = (_event, _dirty, image) => {
      if (!image.isEmpty()) latest = image;
    };
    win.webContents.on('paint', onPaint);

    const finish = (err, png) => {
      clearTimeout(timer);
      win.webContents.off('paint', onPaint);
      fs.unlinkSync(page);
      if (err) reject(err); else resolve(png);
    };

    const timer = setTimeout(() => finish(new Error(`timed out rendering ${size}px`)), 20000);

    win.webContents.once('did-finish-load', () => {
      win.webContents.invalidate();
      setTimeout(() => {
        if (!latest) return finish(new Error(`no frame painted at ${size}px`));
        finish(null, latest.crop({ x: 0, y: 0, width: size, height: size }).toPNG());
      }, 600);
    });

    win.loadFile(page).catch((err) => finish(err));
  });
}

/**
 * An .ico whose directory disagrees with its payloads renders as garbage, and
 * nothing downstream complains, so check the real PNG header rather than
 * trusting that the capture came back at the size we asked for.
 */
function pngSize(png) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!png.subarray(0, 8).equals(signature)) throw new Error('not a PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Packs PNGs into an .ico. Windows has accepted PNG-compressed icon entries
 * since Vista, so each size goes in as-is rather than being re-encoded to BMP.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, png }, i) => {
    const at = i * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);     // 0 means 256
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2);                      // palette size
    directory.writeUInt8(0, at + 3);                      // reserved
    directory.writeUInt16LE(1, at + 4);                   // colour planes
    directory.writeUInt16LE(32, at + 6);                  // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG, 'utf8');
  const win = makeWindow();
  const images = [];

  for (const size of SIZES) {
    const png = await renderAt(win, svg, size);
    const actual = pngSize(png);
    if (actual.width !== size || actual.height !== size) {
      throw new Error(`expected ${size}x${size}, got ${actual.width}x${actual.height}`);
    }
    fs.writeFileSync(path.join(ASSETS, `icon-${size}.png`), png);
    if (ICO_SIZES.includes(size)) images.push({ size, png });
    console.log(`icon-${size}.png  ${size}x${size}  ${png.length} bytes`);
  }

  const ico = path.join(ASSETS, 'icon.ico');
  fs.writeFileSync(ico, buildIco(images));
  console.log(`icon.ico  ${fs.statSync(ico).size} bytes`);

  app.exit(0);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
