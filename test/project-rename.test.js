import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { checkProjectRename } = require('../project-rename.js');

// Absolute, and built the way this platform builds them, so the same test
// reads correctly on Windows and on the machines that run CI.
const ROOT = path.resolve('projects');
const APP = path.join(ROOT, 'Hangar');
const NOTES = path.join(ROOT, 'Notes');
const check = (target, name, extra = {}) =>
  checkProjectRename(target, name, { root: ROOT, appDir: APP, ...extra });

describe('checkProjectRename', () => {
  it('renames a project sitting directly in the projects folder', () => {
    expect(check(NOTES, 'Ideas')).toEqual({
      ok: true, from: NOTES, to: path.join(ROOT, 'Ideas'), name: 'Ideas', was: 'Notes',
    });
  });

  it('takes a path that has not been normalised yet', () => {
    expect(check(path.join(ROOT, 'Deep', '..', 'Notes'), 'Ideas').from).toBe(NOTES);
  });

  it('trims the new name the way it will be created', () => {
    expect(check(NOTES, '  Ideas  ')).toMatchObject({ ok: true, name: 'Ideas' });
  });

  it('refuses anything that is not named', () => {
    for (const raw of ['', '   ', null, undefined, 42]) expect(check(raw, 'Ideas').ok).toBe(false);
  });

  it('refuses the projects folder itself and anything outside it', () => {
    expect(check(ROOT, 'Ideas').ok).toBe(false);
    expect(check(path.dirname(ROOT), 'Ideas').ok).toBe(false);
    expect(check(path.join(ROOT, '..', 'Elsewhere'), 'Ideas').ok).toBe(false);
    expect(check(path.join(ROOT, 'Notes', 'src'), 'Ideas').ok).toBe(false);
  });

  it('refuses Hangar itself, which is usually a sibling of the projects', () => {
    expect(check(APP, 'Ideas').ok).toBe(false);
    expect(check(APP, 'Ideas', { appDir: path.resolve('apps', 'Hangar') }).ok).toBe(true);
  });

  it('refuses a project with terminals still open in it', () => {
    expect(check(NOTES, 'Ideas', { busy: 1 }).message).toMatch(/terminal is still open/);
    expect(check(NOTES, 'Ideas', { busy: 3 }).message).toMatch(/3 terminals/);
  });

  it('refuses a name the sidebar would then refuse to list', () => {
    expect(check(NOTES, 'up/down').ok).toBe(false);
    expect(check(NOTES, '.hidden').ok).toBe(false);
    expect(check(NOTES, 'nul').ok).toBe(false);
    expect(check(NOTES, 'node_modules', { ignored: ['node_modules'] }).ok).toBe(false);
  });

  it('refuses a name another project already has', () => {
    const taken = check(NOTES, 'Ideas', { existing: ['Notes', 'Ideas'] });
    expect(taken.ok).toBe(false);
    expect(taken.message).toMatch(/already a project/);
  });

  it('does not treat the folder as a clash with itself', () => {
    // Only the case changes, which is the one rename a case-insensitive
    // filesystem exists to make awkward.
    expect(check(NOTES, 'notes', { existing: ['Notes'] })).toMatchObject({
      ok: true, to: path.join(ROOT, 'notes'), was: 'Notes',
    });
  });

  it('refuses the name it already has', () => {
    const same = check(NOTES, ' Notes ', { existing: ['Notes'] });
    expect(same.ok).toBe(false);
    expect(same.message).toMatch(/already called Notes/);
  });

  it('refuses when there is no projects folder to be inside', () => {
    expect(checkProjectRename(NOTES, 'Ideas', { root: '' }).ok).toBe(false);
    expect(checkProjectRename(NOTES, 'Ideas', {}).ok).toBe(false);
  });
});
