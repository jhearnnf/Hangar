import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { checkProjectDelete } = require('../project-delete.js');

// Absolute, and built the way this platform builds them, so the same test
// reads correctly on Windows and on the machines that run CI.
const ROOT = path.resolve('projects');
const APP = path.join(ROOT, 'Hangar');
const check = (target, extra = {}) => checkProjectDelete(target, { root: ROOT, appDir: APP, ...extra });

describe('checkProjectDelete', () => {
  it('allows a project sitting directly in the projects folder', () => {
    const dir = path.join(ROOT, 'Notes');
    expect(check(dir)).toEqual({ ok: true, path: dir, name: 'Notes' });
  });

  it('takes a path that has not been normalised yet', () => {
    const dir = path.join(ROOT, 'Deep', '..', 'Notes');
    expect(check(dir)).toEqual({ ok: true, path: path.join(ROOT, 'Notes'), name: 'Notes' });
  });

  it('refuses anything that is not named', () => {
    for (const raw of ['', '   ', null, undefined, 42]) expect(check(raw).ok).toBe(false);
  });

  it('refuses the projects folder itself', () => {
    expect(check(ROOT).ok).toBe(false);
    expect(check(path.join(ROOT, 'Notes', '..')).ok).toBe(false);
  });

  it('refuses anything outside the projects folder', () => {
    expect(check(path.dirname(ROOT)).ok).toBe(false);
    expect(check(path.join(ROOT, '..', 'Elsewhere')).ok).toBe(false);
    expect(check(path.resolve('somewhere-else')).ok).toBe(false);
  });

  it('refuses a folder nested deeper than a project', () => {
    // The sidebar never lists these, so nothing should be able to name one.
    expect(check(path.join(ROOT, 'Notes', 'src')).ok).toBe(false);
  });

  it('refuses Hangar itself, which is usually a sibling of the projects', () => {
    expect(check(APP).ok).toBe(false);
    // ...and does not object when it is somewhere else entirely.
    expect(check(path.join(ROOT, 'Hangar'), { appDir: path.resolve('apps', 'Hangar') }).ok).toBe(true);
  });

  it('refuses a project with terminals still open in it', () => {
    const one = check(path.join(ROOT, 'Notes'), { busy: 1 });
    expect(one.ok).toBe(false);
    expect(one.message).toMatch(/terminal is still open/);

    const many = check(path.join(ROOT, 'Notes'), { busy: 3 });
    expect(many.message).toMatch(/3 terminals/);
  });

  it('refuses when there is no projects folder to be inside', () => {
    expect(checkProjectDelete(path.join(ROOT, 'Notes'), { root: '' }).ok).toBe(false);
    expect(checkProjectDelete(path.join(ROOT, 'Notes'), {}).ok).toBe(false);
  });
});
