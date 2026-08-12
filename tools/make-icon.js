'use strict';

/**
 * Rasterises assets/icon.svg into the PNGs and the .ico Windows needs.
 *
 *   npm run icon
 *
 * Runs under Electron rather than a build toolchain: Chromium is already a
 * dependency and renders the SVG exactly as the window would, so there is
 * nothing extra to install. tools/icon-render.js does the drawing, and is where
 * the transparent corners come from.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const { makeWindow, renderIcon, encodePng } = require('./icon-render');

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
  const win = makeWindow(BrowserWindow, FRAME);
  const images = [];

  for (const size of SIZES) {
    const rgba = await renderIcon(win, svg, size, 1);
    const png = encodePng(rgba, size, size);

    fs.writeFileSync(path.join(ASSETS, `icon-${size}.png`), png);
    if (ICO_SIZES.includes(size)) images.push({ size, png });

    // The corner is the pixel this whole exercise is about, so say what it came
    // out as. Anything but a 0 there is the transparency having been lost again.
    console.log(`icon-${size}.png  ${size}x${size}  ${png.length} bytes  corner alpha ${rgba[3]}`);
  }

  const ico = path.join(ASSETS, 'icon.ico');
  fs.writeFileSync(ico, buildIco(images));
  console.log(`icon.ico  ${fs.statSync(ico).size} bytes`);

  app.exit(0);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
