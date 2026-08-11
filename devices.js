'use strict';

const crypto = require('crypto');

/**
 * Which phones are allowed to talk to this Hangar.
 *
 * The server hands out shells on your machine. Everything else in Hangar is
 * reachable only by someone already sitting at the keyboard; this is the one
 * part that is reachable by anything on the wifi, so it is the one part that
 * has to say no to almost all of it.
 *
 * The shape is deliberately the dullest one that works:
 *
 *   - Settings shows a six-character code. It lasts five minutes and one use.
 *   - A phone sends that code once and gets a long random key back.
 *   - Every connection after that carries the key. No key, no connection.
 *   - Settings lists the phones that hold a key, and can take one back.
 *
 * The code is short because it gets typed on a phone; it is short-lived and
 * single-use because that is what makes a short code safe. The key is long
 * because it is stored rather than typed.
 *
 * Pure apart from an injected reader and writer, so the tests can run the whole
 * pairing dance without a disk.
 */

const DEVICES_FILE = 'devices.json';

// No 0/O/1/I/l: this gets read off a screen and typed into a phone, and a
// pairing that fails because a zero looked like an O is a bug in the alphabet.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_TTL_MS = 5 * 60 * 1000;

// Long enough that guessing is not a strategy, short enough to sit in a URL.
const TOKEN_BYTES = 32;

function randomCode(random = crypto.randomBytes) {
  const bytes = random(CODE_LENGTH * 2);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Compare two secrets without letting the clock say how much of one matched. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

function createDevices(options = {}) {
  const {
    load = () => null,
    save = () => {},
    now = Date.now,
    random = crypto.randomBytes,
    codeTtlMs = CODE_TTL_MS,
  } = options;

  let devices = [];
  try {
    const raw = load();
    if (Array.isArray(raw)) {
      devices = raw.filter((d) => d && typeof d.token === 'string' && typeof d.id === 'string');
    }
  } catch {
    // A devices file that cannot be read means no phone is paired, which is the
    // safe way round: pairing again takes ten seconds, and inventing a device
    // out of a half-written file would not.
    devices = [];
  }

  // At most one code is live at a time. Opening the pairing panel again
  // replaces it, which is also how you cancel one you did not mean to show.
  let pending = null;

  function persist() {
    try { save(devices); } catch { /* the pairing still works this session */ }
  }

  /** A fresh code for the Settings screen to show. */
  function newCode() {
    pending = { code: randomCode(random), expiresAt: now() + codeTtlMs };
    return { code: pending.code, expiresAt: pending.expiresAt };
  }

  function currentCode() {
    if (!pending) return null;
    if (now() > pending.expiresAt) { pending = null; return null; }
    return { code: pending.code, expiresAt: pending.expiresAt };
  }

  function clearCode() {
    pending = null;
  }

  /**
   * Trade a code for a key. One use — the code is spent whether or not the
   * phone that used it is the one it was meant for, so a code that leaked
   * cannot be used twice.
   */
  function pair(code, name) {
    const live = currentCode();
    if (!live) return { ok: false, message: 'No pairing code is open. Open Settings on the PC and try again.' };
    if (!sameSecret(String(code || '').trim().toUpperCase(), live.code)) {
      return { ok: false, message: 'That code is not the one on the screen.' };
    }

    pending = null;

    const device = {
      id: random(8).toString('hex'),
      name: String(name || 'A phone').slice(0, 40),
      token: random(TOKEN_BYTES).toString('hex'),
      pairedAt: now(),
      lastSeen: now(),
    };
    devices.push(device);
    persist();
    return { ok: true, token: device.token, device: publicDevice(device) };
  }

  function publicDevice(d) {
    return { id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen };
  }

  /** The device holding this key, or null. */
  function verify(token) {
    if (!token) return null;
    const found = devices.find((d) => sameSecret(d.token, token));
    if (!found) return null;
    found.lastSeen = now();
    return publicDevice(found);
  }

  function seen(id) {
    const found = devices.find((d) => d.id === id);
    if (!found) return;
    found.lastSeen = now();
    persist();
  }

  function forget(id) {
    const before = devices.length;
    devices = devices.filter((d) => d.id !== id);
    if (devices.length === before) return false;
    persist();
    return true;
  }

  function forgetAll() {
    devices = [];
    persist();
  }

  return {
    newCode,
    currentCode,
    clearCode,
    pair,
    verify,
    seen,
    forget,
    forgetAll,
    list: () => devices.map(publicDevice),
    count: () => devices.length,
  };
}

module.exports = {
  createDevices,
  randomCode,
  sameSecret,
  DEVICES_FILE,
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_TTL_MS,
};
