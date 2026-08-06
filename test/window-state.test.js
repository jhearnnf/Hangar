import { describe, it, expect } from 'vitest';
import { parseState, restoreState, DEFAULT_SIZE, MIN_SIZE } from '../window-state.js';

// A single 1920x1080 monitor with the taskbar taken off the bottom.
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
// A second one hanging off the left, as an unplugged-monitor stand-in.
const LEFT = { x: -1920, y: 0, width: 1920, height: 1040 };

describe('parseState', () => {
  it('reads a saved blob', () => {
    expect(parseState('{"x":10,"y":20}')).toEqual({ x: 10, y: 20 });
  });

  it('treats junk as no state', () => {
    expect(parseState('')).toBeNull();
    expect(parseState('{ truncated')).toBeNull();
    expect(parseState('null')).toBeNull();
    expect(parseState('[1,2]')).toBeNull();
    expect(parseState('"a string"')).toBeNull();
  });
});

describe('restoreState', () => {
  it('falls back to the default size, unplaced, on a first run', () => {
    const state = restoreState(null, [PRIMARY]);
    expect(state.bounds).toEqual({ ...DEFAULT_SIZE });
    expect(state.bounds.x).toBeUndefined();
    expect(state.maximized).toBe(false);
    expect(state.fullScreen).toBe(false);
  });

  it('restores a position that is still on screen', () => {
    const saved = { x: 100, y: 80, width: 1000, height: 700 };
    expect(restoreState(saved, [PRIMARY]).bounds).toEqual(saved);
  });

  it('keeps the size but drops the position when the display is gone', () => {
    const saved = { x: -1500, y: 200, width: 1000, height: 700 };
    const state = restoreState(saved, [PRIMARY]);
    expect(state.bounds).toEqual({ width: 1000, height: 700 });
  });

  it('keeps that same position when the display is still attached', () => {
    const saved = { x: -1500, y: 200, width: 1000, height: 700 };
    expect(restoreState(saved, [PRIMARY, LEFT]).bounds).toEqual(saved);
  });

  it('keeps a window hanging off an edge as long as enough is grabbable', () => {
    const saved = { x: 1700, y: 100, width: 1000, height: 700 };
    expect(restoreState(saved, [PRIMARY]).bounds).toEqual(saved);
  });

  it('drops a position with only a sliver on screen', () => {
    const saved = { x: 1900, y: 100, width: 1000, height: 700 };
    expect(restoreState(saved, [PRIMARY]).bounds).toEqual({ width: 1000, height: 700 });
  });

  it('never restores smaller than the window minimum', () => {
    const state = restoreState({ x: 0, y: 0, width: 50, height: 50 }, [PRIMARY]);
    expect(state.bounds.width).toBe(MIN_SIZE.width);
    expect(state.bounds.height).toBe(MIN_SIZE.height);
  });

  it('clamps a size saved on a bigger monitor down to what is attached', () => {
    const state = restoreState({ x: 0, y: 0, width: 3840, height: 2000 }, [PRIMARY]);
    expect(state.bounds.width).toBe(PRIMARY.width);
    expect(state.bounds.height).toBe(PRIMARY.height);
  });

  it('carries maximized and full screen through', () => {
    const saved = { x: 0, y: 0, width: 1000, height: 700, maximized: true, fullScreen: true };
    const state = restoreState(saved, [PRIMARY]);
    expect(state.maximized).toBe(true);
    expect(state.fullScreen).toBe(true);
  });

  it('ignores non-numeric or half-written geometry', () => {
    for (const saved of [{ x: 'a', y: 'b', width: 'c', height: 'd' },
      { x: NaN, y: 0, width: 1000, height: 700 },
      { x: 5 }]) {
      expect(restoreState(saved, [PRIMARY]).bounds.x).toBeUndefined();
    }

    // A size on its own still opens centred at that size.
    expect(restoreState({ width: 1000, height: 700 }, [PRIMARY]).bounds)
      .toEqual({ width: 1000, height: 700 });
    // A position on its own still opens there, at the default size.
    expect(restoreState({ x: 5, y: 5 }, [PRIMARY]).bounds)
      .toEqual({ ...DEFAULT_SIZE, x: 5, y: 5 });
  });

  it('does not place a window when no displays are known', () => {
    const state = restoreState({ x: 100, y: 80, width: 1000, height: 700 }, []);
    expect(state.bounds).toEqual({ width: 1000, height: 700 });
  });
});
