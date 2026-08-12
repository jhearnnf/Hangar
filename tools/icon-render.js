'use strict';

/**
 * Draws assets/icon.svg into RGBA pixels, and packs those into PNGs.
 *
 * Shared by tools/make-icon.js and mobile/tools/make-icon.js: the same drawing,
 * at the sizes Windows and Android each ask for.
 *
 * The icon is a rounded tile, so its corners have to come out transparent, and
 * an Android adaptive foreground is mostly transparent by definition. Asking
 * Chromium for a transparent offscreen window does not reliably deliver that -
 * the offscreen compositor can hand back an opaque frame, and what sits in the
 * corners is then whatever it composited onto. That is how every size except
 * the 16px once shipped with white corners baked in.
 *
 * So the transparency is recovered rather than requested. Each size is drawn
 * twice, once on black and once on white, and the pair is solved for the alpha
 * that produced them:
 *
 *   on white   Cw = C*a + 255*(1-a)
 *   on black   Cb = C*a
 *   giving     a  = 1 - (Cw - Cb)/255        and        C  = Cb/a
 *
 * That is exact for any antialiased edge and for the semi-transparent strokes
 * inside the drawing, and it needs to know nothing about the shape - the icon
 * can be redrawn without this file having to follow.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

/**
 * The offscreen window every render goes through. One window, reused:
 * destroying an offscreen window and immediately opening another makes the next
 * load fail with ERR_FAILED.
 *
 * `frame` has to be at least the largest canvas asked for - Windows clamps a
 * window to a minimum size, so each drawing goes into the top-left of a fixed
 * frame and is cropped back out rather than the window being resized.
 */
function makeWindow(BrowserWindow, frame) {
  return new BrowserWindow({
    width: frame,
    height: frame,
    show: false,
    frame: false,
    // Deliberately opaque. The page paints its own background, and that is what
    // the alpha is solved against.
    backgroundColor: '#000000',
    webPreferences: { offscreen: true },
  });
}

/**
 * The icon at `inset` of a `canvas`-pixel square, centred, on `background`.
 * An inset of 1 is the whole tile; less leaves transparent margin around it.
 */
function buildPage(svg, canvas, inset, background) {
  const drawn = Math.round(canvas * inset);
  const pad = Math.round((canvas - drawn) / 2);

  // Inline rather than an <img src>: Chromium refuses top-level navigation to
  // a data: URL, and a file:// page pulling in a file:// image is its own
  // fight. The SVG as live markup sidesteps both.
  const scaled = svg.replace(/width="\d+" height="\d+"/, `width="${drawn}" height="${drawn}"`);

  return `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:${background};overflow:hidden}
      #tile{width:${canvas}px;height:${canvas}px;padding:${pad}px;box-sizing:border-box}
      svg{display:block}
    </style><div id="tile">${scaled}</div>`;
}

/** One pass. Resolves to the frame's raw bitmap, cropped to `canvas`. */
function paintOnce(win, html, canvas, tag) {
  const page = path.join(os.tmpdir(), `hangar-icon-${tag}.html`);
  fs.writeFileSync(page, html, 'utf8');

  return new Promise((resolve, reject) => {
    // The first paint is often the empty frame before layout lands, so keep
    // the most recent one and grab it once the page has settled.
    let latest = null;
    const onPaint = (_event, _dirty, image) => {
      if (!image.isEmpty()) latest = image;
    };
    win.webContents.on('paint', onPaint);

    const finish = (err, bitmap) => {
      clearTimeout(timer);
      win.webContents.off('paint', onPaint);
      fs.unlinkSync(page);
      if (err) reject(err); else resolve(bitmap);
    };

    const timer = setTimeout(() => finish(new Error(`timed out rendering ${tag}`)), 20000);

    win.webContents.once('did-finish-load', () => {
      win.webContents.invalidate();
      setTimeout(() => {
        if (!latest) return finish(new Error(`no frame painted for ${tag}`));
        const cropped = latest.crop({ x: 0, y: 0, width: canvas, height: canvas });
        const size = cropped.getSize();
        if (size.width !== canvas || size.height !== canvas) {
          return finish(new Error(`expected ${canvas}x${canvas}, got ${size.width}x${size.height}`));
        }
        finish(null, cropped.toBitmap());
      }, 600);
    });

    win.loadFile(page).catch((err) => finish(err));
  });
}

/**
 * Solves the black and white passes for straight (un-premultiplied) RGBA.
 *
 * The white pass can never come out darker than the black one. If it does, the
 * two captures are not of the same frame - a stale bitmap, most likely - and
 * every pixel after it would be quietly wrong, so it is worth failing over.
 */
function unmix(onBlack, onWhite, canvas) {
  const count = canvas * canvas;
  if (onBlack.length !== count * 4 || onWhite.length !== count * 4) {
    throw new Error(`bitmap is not ${canvas}x${canvas} RGBA`);
  }

  const rgba = Buffer.alloc(count * 4);
  let darkest = 0;

  for (let i = 0; i < count; i++) {
    const at = i * 4;
    // toBitmap() hands back the platform's raw order, which is BGRA.
    const b0 = onBlack[at], g0 = onBlack[at + 1], r0 = onBlack[at + 2];
    const b1 = onWhite[at], g1 = onWhite[at + 1], r1 = onWhite[at + 2];

    // The three channels carry the same alpha; averaging them shakes off a
    // little of the 8-bit rounding.
    const lifted = ((b1 - b0) + (g1 - g0) + (r1 - r0)) / 3;
    if (lifted < darkest) darkest = lifted;

    const alpha = 1 - Math.min(255, Math.max(0, lifted)) / 255;
    if (alpha <= 0) continue;  // buffer is already zeroed

    rgba[at] = Math.min(255, Math.round(r0 / alpha));
    rgba[at + 1] = Math.min(255, Math.round(g0 / alpha));
    rgba[at + 2] = Math.min(255, Math.round(b0 / alpha));
    rgba[at + 3] = Math.round(alpha * 255);
  }

  // A pixel or two off is dithering; a real mismatch is nowhere near this.
  if (darkest < -2) throw new Error(`passes disagree by ${-darkest} - captured different frames`);

  return rgba;
}

/** The icon as straight RGBA, `canvas` square, drawn at `inset` of it. */
async function renderIcon(win, svg, canvas, inset) {
  const tag = `${canvas}-${Math.round(inset * 100)}`;
  const onBlack = await paintOnce(win, buildPage(svg, canvas, inset, '#000'), canvas, `${tag}-black`);
  const onWhite = await paintOnce(win, buildPage(svg, canvas, inset, '#fff'), canvas, `${tag}-white`);
  return unmix(onBlack, onWhite, canvas);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encodes straight RGBA as an 8-bit truecolour-with-alpha PNG.
 *
 * Written here rather than taken from nativeImage.toPNG(), which is what threw
 * the alpha away in the first place - it returns a colour-type-2 file with the
 * transparency already flattened onto the compositor's background.
 */
function encodePng(rgba, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // colour type: truecolour + alpha
  header[10] = 0;  // deflate
  header[11] = 0;  // adaptive filtering
  header[12] = 0;  // not interlaced

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  // Paeth on every row. The tile is a vertical gradient, which it predicts
  // almost perfectly, and the flat transparent corners cost nothing either way.
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    raw[out] = 4;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const corner = (x >= 4 && y > 0) ? rgba[(y - 1) * stride + x - 4] : 0;

      const guess = left + up - corner;
      const dl = Math.abs(guess - left), du = Math.abs(guess - up), dc = Math.abs(guess - corner);
      const predicted = (dl <= du && dl <= dc) ? left : (du <= dc ? up : corner);

      raw[out + 1 + x] = (rgba[y * stride + x] - predicted) & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { makeWindow, renderIcon, encodePng };
