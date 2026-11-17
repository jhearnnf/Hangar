'use strict';

/**
 * Pictures pasted into a terminal, shown over it.
 *
 * A terminal cannot draw an image, and Claude Code does not try: it reads the
 * clipboard itself and prints `[Image #N]` where the picture went. The pictures
 * themselves are kept by the main process (see `images.js` at the root), which
 * is what lets them outlive a reload and reach a phone. This file is the part
 * that shows them, and is loaded by both the window and the phone:
 *
 *   createImageTray          thumbnails in a corner, one picture full size,
 *                            and `[Image #N]` in the text made clickable.
 *   createPlaceholderScanner notices an `[Image #N]` on screen with no picture
 *                            — a chat resumed after Hangar was closed — and
 *                            asks for it to be looked up.
 *   createPasteWatcher       the window only: takes a copy of the clipboard as
 *                            a paste goes out, and hands it on once Claude
 *                            prints the number it gave it. A paste Claude did
 *                            not take never becomes a picture nobody sent.
 */

const PLACEHOLDER = /\[Image #(\d+)\]/g;

// How long a paste waits for its placeholder. Claude reads the clipboard
// through a child process on Windows, which can take a second or two cold.
const WAIT_MS = 6000;

// How often the screen is looked over for placeholders with no picture.
const SCAN_MS = 800;

// The shortest gap between two lookups for the same number.
const REASK_MS = 5000;

// Matches MIN_SNIPPET in images.js: shorter text is never looked up.
const MIN_SNIPPET = 4;

/** Every `[Image #N]` in a piece of text, as numbers, in order. */
function findPlaceholders(text) {
  const out = [];
  for (const m of String(text).matchAll(PLACEHOLDER)) out.push(Number(m[1]));
  return out;
}

/** The same, with where each one sits on the line (0-based, end exclusive). */
function placeholderSpans(text) {
  const out = [];
  for (const m of String(text).matchAll(PLACEHOLDER)) {
    out.push({ n: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** How many times each number appears. */
function countPlaceholders(text) {
  const counts = new Map();
  for (const n of findPlaceholders(text)) counts.set(n, (counts.get(n) || 0) + 1);
  return counts;
}

/**
 * The number a paste produced: the lowest one that appears more often now
 * than it did when the paste was armed. Null if nothing new has appeared yet.
 */
function newPlaceholder(before, after) {
  const fresh = [...after.keys()]
    .filter((n) => after.get(n) > (before.get(n) || 0))
    .sort((a, b) => a - b);
  return fresh.length ? fresh[0] : null;
}

/**
 * Each placeholder on a row with the words that follow it — what a resumed
 * chat's transcript is searched for.
 */
function placeholdersWithText(row) {
  return placeholderSpans(row).map((span) => ({
    n: span.n,
    snippet: row.slice(span.end).replace(/\s+/g, ' ').trim().slice(0, 60),
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    findPlaceholders, placeholderSpans, countPlaceholders, newPlaceholder, placeholdersWithText,
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.PastedImages = (() => {
    const COLLAPSED_KEY = 'pastedImagesCollapsed';
    let collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { /* default */ }

    const trays = new Set();
    let viewing = null;   // the tray with a picture open full size

    function viewportRows(term) {
      const buf = term.buffer.active;
      const rows = [];
      for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
        const line = buf.getLine(y);
        if (line) rows.push(line.translateToString(true));
      }
      return rows;
    }

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    // ----------------------------------------------------------- the tray

    /**
     * Thumbnails over `host`, for the terminal `term`.
     *
     * `remove(key)` asks for a picture to go; the list comes back through
     * `set()`. A picture without a `url` yet (the phone fetches them one at a
     * time) shows as its number until it arrives.
     */
    function createImageTray({ host, term, remove = () => {}, touch = false }) {
      let images = [];
      let openIndex = -1;
      const tray = el('div', 'imgtray');
      tray.hidden = true;
      host.appendChild(tray);
      let view = null;
      // On a phone the pane scrolls the terminal by drag; a drag that starts on
      // the pictures is about the pictures.
      const keepTouch = (node) => {
        if (touch) node.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
      };
      keepTouch(tray);

      function render() {
        tray.replaceChildren();
        tray.hidden = images.length === 0;
        tray.classList.toggle('collapsed', collapsed);

        if (!collapsed) {
          const strip = el('div', 'imgtray-strip');
          images.forEach((img, i) => {
            const thumb = el('button', 'imgthumb');
            thumb.type = 'button';
            thumb.title = `Image #${img.n} — click to enlarge`;
            if (img.url) {
              const pic = el('img');
              pic.src = img.url;
              pic.alt = `Image #${img.n}`;
              pic.draggable = false;
              thumb.appendChild(pic);
            } else {
              thumb.classList.add('loading');
            }
            const drop = el('span', 'imgthumb-x', '✕');
            drop.title = 'Remove from this list';
            drop.addEventListener('click', (e) => { e.stopPropagation(); remove(img.key); });
            thumb.append(el('span', 'imgthumb-n', `#${img.n}`), drop);
            thumb.addEventListener('click', () => open(i));
            strip.appendChild(thumb);
          });
          tray.appendChild(strip);
        }

        const toggle = el('button', 'imgtray-toggle', collapsed ? `🖼 ${images.length}` : '−');
        toggle.type = 'button';
        toggle.title = collapsed ? 'Show pasted images' : 'Hide pasted images';
        toggle.addEventListener('click', (e) => { e.stopPropagation(); setCollapsed(!collapsed); });
        tray.appendChild(toggle);
      }

      function open(index) {
        const img = images[index];
        if (!img) return;
        if (viewing && viewing !== api) viewing.close();
        if (view) view.remove();

        view = el('div', 'imgview');
        view.title = 'Click to shrink';
        keepTouch(view);
        if (img.url) {
          const pic = el('img');
          pic.src = img.url;
          pic.alt = `Image #${img.n}`;
          pic.draggable = false;
          view.appendChild(pic);
        } else {
          view.appendChild(el('div', 'imgview-wait', 'Loading…'));
        }
        const hint = touch ? 'tap to close' : '← → to step, Esc to close';
        view.appendChild(el('div', 'imgview-cap', images.length > 1
          ? `Image #${img.n}  ·  ${index + 1} of ${images.length}  ·  ${hint}`
          : `Image #${img.n}  ·  ${touch ? 'tap' : 'Esc'} to close`));
        view.addEventListener('click', close);
        host.appendChild(view);
        openIndex = index;
        viewing = api;
      }

      function close() {
        if (view) view.remove();
        view = null;
        openIndex = -1;
        if (viewing === api) viewing = null;
        if (!touch) { try { term.focus(); } catch { /* gone */ } }
      }

      function openNumber(n) {
        for (let i = images.length - 1; i >= 0; i--) {
          if (images[i].n === n) { open(i); return true; }
        }
        return false;
      }

      function step(by) {
        if (openIndex < 0 || images.length < 2) return;
        open((openIndex + by + images.length) % images.length);
      }

      /** Replace the list. Keeps the open picture open if it is still there. */
      function set(next) {
        const openKey = openIndex >= 0 && images[openIndex] ? images[openIndex].key : null;
        const hadUrl = openKey && images[openIndex].url;
        images = Array.isArray(next) ? next.slice() : [];
        render();
        if (openKey) {
          const at = images.findIndex((img) => img.key === openKey);
          if (at < 0) close();
          else if (!hadUrl && images[at].url) open(at);
          else openIndex = at;
        }
      }

      const links = term.registerLinkProvider({
        provideLinks(y, callback) {
          if (!images.length) { callback(undefined); return; }
          const line = term.buffer.active.getLine(y - 1);
          if (!line) { callback(undefined); return; }
          const known = new Set(images.map((img) => img.n));
          const found = placeholderSpans(line.translateToString(true))
            .filter((span) => known.has(span.n))
            .map((span) => ({
              range: { start: { x: span.start + 1, y }, end: { x: span.end, y } },
              text: `[Image #${span.n}]`,
              decorations: { pointerCursor: true, underline: true },
              activate: () => openNumber(span.n),
            }));
          callback(found.length ? found : undefined);
        },
      });

      const api = {
        set,
        open,
        close,
        step,
        openNumber,
        render,
        images: () => images,
        knows: (n) => images.some((img) => img.n === n),
        isOpen: () => openIndex >= 0,
        dispose() {
          close();
          links.dispose();
          tray.remove();
          trays.delete(api);
        },
      };
      trays.add(api);
      return api;
    }

    function setCollapsed(on) {
      collapsed = on;
      try { localStorage.setItem(COLLAPSED_KEY, on ? '1' : '0'); } catch { /* fine */ }
      for (const t of trays) t.render();
    }

    /** Keys while a picture is open. True if the key was used. */
    function handleKey(e) {
      if (!viewing) return false;
      if (e.key === 'Escape') { viewing.close(); return true; }
      if (e.key === 'ArrowLeft') { viewing.step(-1); return true; }
      if (e.key === 'ArrowRight') { viewing.step(1); return true; }
      return false;
    }

    // ------------------------------------------------- unknown placeholders

    /**
     * Looks the screen over, now and then while output arrives, for an
     * `[Image #N]` with no picture, and asks once for each.
     */
    function createPlaceholderScanner({ term, knows, ask, busy = () => false }) {
      // n -> { snippets, at }. A line being typed changes with every key, so a
      // number is asked about again only for words not tried before, and not
      // more than once every few seconds.
      const asked = new Map();
      let timer = null;

      function scan() {
        timer = null;
        if (busy()) return;
        const now = Date.now();
        const thisScan = new Set();
        for (const row of viewportRows(term)) {
          for (const { n, snippet } of placeholdersWithText(row)) {
            // Too few words to tell one chat from another by.
            if (snippet.length < MIN_SNIPPET || knows(n)) continue;
            const seen = asked.get(n) || { snippets: new Set(), at: 0 };
            if (seen.snippets.has(snippet)) continue;
            // Every line on screen is fair game in one look; the wait is only
            // between looks, which is what a line being typed would repeat.
            if (!thisScan.has(n) && now - seen.at < REASK_MS) continue;
            thisScan.add(n);
            seen.snippets.add(snippet);
            seen.at = now;
            asked.set(n, seen);
            ask(n, snippet);
          }
        }
      }

      function soon() {
        if (!timer) timer = setTimeout(scan, SCAN_MS);
      }

      const sub = term.onWriteParsed(soon);
      soon();
      return {
        soon,
        dispose() { clearTimeout(timer); sub.dispose(); },
      };
    }

    // --------------------------------------------------------- the paste

    function createPasteWatcher({ term, readImage, onCapture }) {
      let waiting = [];
      let sub = null;

      function counts() {
        return countPlaceholders(viewportRows(term).join('\n'));
      }

      function check() {
        const now = Date.now();
        waiting = waiting.filter((w) => w.until > now);

        if (waiting.length) {
          const after = counts();
          const n = newPlaceholder(waiting[0].before, after);
          if (n !== null) {
            const w = waiting.shift();
            // Anything still waiting counts this one as already there.
            for (const other of waiting) other.before = new Map(after);
            onCapture(n, w.url);
          }
        }

        if (!waiting.length && sub) { sub.dispose(); sub = null; }
      }

      return {
        /** A paste is going out. Keeps the clipboard picture, if there is one. */
        arm() {
          let url = null;
          try { url = readImage(); } catch { url = null; }
          if (!url) return;
          waiting.push({ url, before: counts(), until: Date.now() + WAIT_MS });
          if (!sub) sub = term.onWriteParsed(check);
        },
        busy: () => waiting.length > 0,
        dispose() { if (sub) sub.dispose(); sub = null; waiting = []; },
      };
    }

    return {
      createImageTray,
      createPlaceholderScanner,
      createPasteWatcher,
      handleKey,
      isOpen: () => viewing !== null,
    };
  })();
}
