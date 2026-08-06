'use strict';

/**
 * Where the window was last time. Pure geometry — the Electron side reads the
 * file and drives the BrowserWindow, everything here just decides what a saved
 * blob means given the displays that are actually attached right now.
 */

// First run, or a saved size we can't use.
const DEFAULT_SIZE = { width: 1280, height: 820 };

// Also the BrowserWindow's minWidth/minHeight — one source of truth so a saved
// size can never come back smaller than the window is allowed to be.
const MIN_SIZE = { width: 480, height: 300 };

// How much of the window has to land on a work area for the position to count
// as usable: enough title bar left to grab and drag the rest back into view.
const REACHABLE = { width: 120, height: 40 };

function isSize(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function isCoord(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Reads a state file. Junk on disk is the same as no file at all. */
function parseState(text) {
  try {
    const state = JSON.parse(text);
    return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

function intersection(a, b) {
  return {
    width: Math.max(Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), 0),
    height: Math.max(Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y), 0),
  };
}

/** True if enough of `bounds` overlaps some work area to be clickable. */
function reachable(bounds, workAreas) {
  return workAreas.some((area) => {
    const overlap = intersection(bounds, area);
    return overlap.width >= Math.min(REACHABLE.width, bounds.width)
      && overlap.height >= Math.min(REACHABLE.height, bounds.height);
  });
}

/**
 * Turn a saved blob plus the current display layout into what the window
 * should open as. Bounds come back without `x`/`y` when the saved position
 * can't be honoured — Electron centres a window that isn't given one, which is
 * the right answer both on a first run and after a monitor is unplugged.
 */
function restoreState(saved, workAreas = []) {
  const state = {
    bounds: { ...DEFAULT_SIZE },
    maximized: false,
    fullScreen: false,
  };

  if (!saved || typeof saved !== 'object') return state;

  state.maximized = saved.maximized === true;
  state.fullScreen = saved.fullScreen === true;

  if (isSize(saved.width) && isSize(saved.height)) {
    // Clamp to the biggest display we have. A window sized on a 4K monitor
    // that is no longer plugged in would otherwise open wider than the screen.
    const widest = Math.max(...workAreas.map((a) => a.width), DEFAULT_SIZE.width);
    const tallest = Math.max(...workAreas.map((a) => a.height), DEFAULT_SIZE.height);

    state.bounds.width = Math.min(Math.max(Math.round(saved.width), MIN_SIZE.width), widest);
    state.bounds.height = Math.min(Math.max(Math.round(saved.height), MIN_SIZE.height), tallest);
  }

  if (!isCoord(saved.x) || !isCoord(saved.y)) return state;

  const placed = { ...state.bounds, x: Math.round(saved.x), y: Math.round(saved.y) };
  if (reachable(placed, workAreas)) state.bounds = placed;

  return state;
}

module.exports = { parseState, restoreState, DEFAULT_SIZE, MIN_SIZE };
