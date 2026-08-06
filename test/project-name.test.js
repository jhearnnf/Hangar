import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateProjectName, MAX_LENGTH } = require('../project-name.js');

// What the sidebar would be showing at the time.
const CONTEXT = { existing: ['Hangar', 'Notes'], ignored: ['node_modules', 'dist'] };

const check = (name) => validateProjectName(name, CONTEXT);

describe('validateProjectName', () => {
  it('accepts an ordinary name', () => {
    expect(check('New Project')).toEqual({ ok: true, name: 'New Project' });
  });

  it('hands back the name as it will be created', () => {
    expect(check('  spaced  ').name).toBe('spaced');
  });

  it('refuses an empty field', () => {
    for (const raw of ['', '   ', null, undefined]) {
      expect(validateProjectName(raw, CONTEXT).ok).toBe(false);
    }
  });

  it('refuses characters Windows will not take in a folder name', () => {
    for (const raw of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
      expect(check(raw).ok).toBe(false);
    }
    // Control characters too, which is what a pasted line ending arrives as.
    expect(check(`a${String.fromCharCode(9)}b`).ok).toBe(false);
    expect(check(`a${String.fromCharCode(7)}b`).ok).toBe(false);
  });

  it('refuses a trailing dot, which Windows would drop', () => {
    expect(check('project.').ok).toBe(false);
  });

  it('refuses reserved device names, with or without an extension', () => {
    for (const raw of ['CON', 'con', 'nul', 'COM1', 'lpt9', 'aux.txt']) {
      expect(check(raw).ok).toBe(false);
    }
    // Only the names themselves, not anything starting with them.
    expect(check('console').ok).toBe(true);
    expect(check('com10').ok).toBe(true);
  });

  it('refuses names the sidebar would never list', () => {
    expect(check('.hidden').ok).toBe(false);
    expect(check('..').ok).toBe(false);
    expect(check('node_modules').ok).toBe(false);
    expect(check('DIST').ok).toBe(false);
  });

  it('refuses a name already taken, whatever its case', () => {
    expect(check('Hangar').ok).toBe(false);
    expect(check('hangar').ok).toBe(false);
    expect(check('HANGAR').ok).toBe(false);
  });

  it('measures the length after trimming', () => {
    const long = 'a'.repeat(MAX_LENGTH);
    expect(check(long).ok).toBe(true);
    expect(check(`  ${long}  `).ok).toBe(true);
    expect(check(long + 'a').ok).toBe(false);
  });

  it('has nothing to compare against without a context', () => {
    expect(validateProjectName('Hangar')).toEqual({ ok: true, name: 'Hangar' });
  });

  it('always says why when it says no', () => {
    for (const raw of ['', 'a/b', '.x', 'CON', 'Hangar', 'node_modules', 'x.']) {
      const result = check(raw);
      expect(result.ok).toBe(false);
      expect(result.message).toBeTruthy();
    }
  });
});
