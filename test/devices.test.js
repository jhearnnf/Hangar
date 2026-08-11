import { describe, it, expect } from 'vitest';
import { createDevices, randomCode, sameSecret, CODE_ALPHABET, CODE_LENGTH } from '../devices.js';

// Predictable "randomness", so a test can know what code is on the screen.
function counterRandom() {
  let n = 0;
  return (bytes) => Buffer.alloc(bytes, (n += 7) % 251);
}

function store(initial = null) {
  let saved = initial;
  return {
    load: () => saved,
    save: (list) => { saved = JSON.parse(JSON.stringify(list)); },
    read: () => saved,
  };
}

describe('randomCode', () => {
  it('is six characters from an alphabet with no lookalikes in it', () => {
    const code = randomCode(counterRandom());
    expect(code).toHaveLength(CODE_LENGTH);
    for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });
});

describe('sameSecret', () => {
  it('is true only for the same string', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
  });

  it('is never true for nothing, however it is spelt', () => {
    expect(sameSecret('', '')).toBe(false);
    expect(sameSecret(null, undefined)).toBe(false);
    expect(sameSecret(undefined, '')).toBe(false);
  });
});

describe('createDevices', () => {
  it('refuses to pair when no code is open', () => {
    const devices = createDevices({ random: counterRandom() });
    const result = devices.pair('ABCDEF', 'Pixel');
    expect(result.ok).toBe(false);
    expect(devices.count()).toBe(0);
  });

  it('trades the code on screen for a key', () => {
    const files = store();
    const devices = createDevices({ ...files, random: counterRandom() });

    const { code } = devices.newCode();
    const result = devices.pair(code, 'Pixel');

    expect(result.ok).toBe(true);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(devices.list()).toEqual([expect.objectContaining({ name: 'Pixel' })]);
    expect(files.read()).toHaveLength(1);
  });

  it('does not care about case or stray spaces in a typed code', () => {
    const devices = createDevices({ random: counterRandom() });
    const { code } = devices.newCode();
    expect(devices.pair(`  ${code.toLowerCase()} `, 'Pixel').ok).toBe(true);
  });

  it('spends the code on one use, right or wrong', () => {
    const devices = createDevices({ random: counterRandom() });

    const { code } = devices.newCode();
    expect(devices.pair(code, 'first').ok).toBe(true);
    expect(devices.pair(code, 'second').ok).toBe(false);
    expect(devices.count()).toBe(1);
  });

  it('lets a code expire', () => {
    let clock = 1_000_000;
    const devices = createDevices({ now: () => clock, random: counterRandom(), codeTtlMs: 1000 });

    const { code } = devices.newCode();
    clock += 1001;

    expect(devices.currentCode()).toBe(null);
    expect(devices.pair(code, 'Pixel').ok).toBe(false);
  });

  it('recognises a key it handed out, and nothing else', () => {
    const devices = createDevices({ random: counterRandom() });
    const { code } = devices.newCode();
    const { token } = devices.pair(code, 'Pixel');

    expect(devices.verify(token)).toEqual(expect.objectContaining({ name: 'Pixel' }));
    expect(devices.verify('0'.repeat(64))).toBe(null);
    expect(devices.verify('')).toBe(null);
    expect(devices.verify(null)).toBe(null);
  });

  it('never lets the key back out with the device', () => {
    const devices = createDevices({ random: counterRandom() });
    const { code } = devices.newCode();
    devices.pair(code, 'Pixel');

    for (const device of devices.list()) expect(device.token).toBeUndefined();
    expect(devices.verify.length).toBe(1);
  });

  it('forgets a phone, and the key with it', () => {
    const files = store();
    const devices = createDevices({ ...files, random: counterRandom() });
    const { code } = devices.newCode();
    const { token, device } = devices.pair(code, 'Pixel');

    expect(devices.forget(device.id)).toBe(true);
    expect(devices.verify(token)).toBe(null);
    expect(files.read()).toEqual([]);
    expect(devices.forget(device.id)).toBe(false);
  });

  it('picks up the phones that were paired last time', () => {
    const saved = [{ id: 'a1', name: 'Pixel', token: 'f'.repeat(64), pairedAt: 1, lastSeen: 2 }];
    const devices = createDevices({ load: () => saved });
    expect(devices.verify('f'.repeat(64))).toEqual(expect.objectContaining({ name: 'Pixel' }));
  });

  it('treats an unreadable devices file as nobody being paired', () => {
    const devices = createDevices({ load: () => { throw new Error('ENOENT'); } });
    expect(devices.count()).toBe(0);
  });

  it('drops half-written entries rather than inventing a device from one', () => {
    const devices = createDevices({ load: () => [{ name: 'no token here' }, 'nonsense'] });
    expect(devices.count()).toBe(0);
  });

  it('cancels an open code on request, which is what closing Settings does', () => {
    const devices = createDevices({ random: counterRandom() });
    const { code } = devices.newCode();
    devices.clearCode();
    expect(devices.currentCode()).toBe(null);
    expect(devices.pair(code, 'Pixel').ok).toBe(false);
  });
});
