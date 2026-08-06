import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  DEFAULTS,
  detectDropbox,
  suggestions,
  parseConfig,
  resolveConfig,
  validateFolder,
  isInside,
  validateConfig,
} = require('../config.js');

const HOME = 'C:\\Users\\someone';
const PROJECTS = path.resolve('C:/work/projects');
const BACKUPS = path.resolve('D:/Backups/Hangar');

// A disk where only the listed paths exist.
const diskOf = (...present) => ({
  exists: (p) => present.map((x) => path.resolve(x)).includes(path.resolve(p)),
});

describe('detectDropbox', () => {
  it('finds the ordinary Dropbox folder', () => {
    const dir = path.join(HOME, 'Dropbox');
    expect(detectDropbox({ home: HOME, ...diskOf(dir) })).toBe(dir);
  });

  it('finds the personal one an account pair creates', () => {
    const dir = path.join(HOME, 'Dropbox (Personal)');
    expect(detectDropbox({ home: HOME, ...diskOf(dir) })).toBe(dir);
  });

  it('is null on a machine without Dropbox, which is not a failure', () => {
    expect(detectDropbox({ home: HOME, exists: () => false })).toBeNull();
  });
});

describe('suggestions', () => {
  const appDir = path.resolve('C:/work/projects/Hangar');

  it('offers Hangar\'s parent as the projects root, so its siblings are the list', () => {
    const s = suggestions(appDir, { home: HOME, exists: () => false });
    expect(s.projectsRoot).toBe(PROJECTS);
  });

  it('puts backups in Dropbox when there is one', () => {
    const dropbox = path.join(HOME, 'Dropbox');
    const s = suggestions(appDir, { home: HOME, ...diskOf(dropbox) });
    expect(s.backupRoot).toBe(path.join(dropbox, 'HangarBackups'));
    expect(s.dropbox).toBe(dropbox);
  });

  it('falls back to a plain folder in home when there is not', () => {
    const s = suggestions(appDir, { home: HOME, exists: () => false });
    expect(s.backupRoot).toBe(path.join(HOME, 'HangarBackups'));
    expect(s.dropbox).toBeNull();
  });
});

describe('parseConfig', () => {
  it('reads back what was saved', () => {
    const saved = parseConfig(JSON.stringify({
      projectsRoot: PROJECTS, backupEnabled: true, backupRoot: BACKUPS,
    }));
    expect(saved).toEqual({ projectsRoot: PROJECTS, backupEnabled: true, backupRoot: BACKUPS });
  });

  it('is null on anything unreadable, which is what re-runs setup', () => {
    // A config that failed to parse should ask again rather than quietly run on
    // defaults nobody chose.
    for (const raw of ['', '{', 'null', '[]', '{}', '"a string"', '7']) {
      expect(parseConfig(raw)).toBeNull();
    }
  });

  it('survives a byte order mark, which is what Notepad leaves behind', () => {
    const raw = `﻿${JSON.stringify({ projectsRoot: PROJECTS, backupEnabled: false, backupRoot: '' })}`;
    expect(parseConfig(raw)).toEqual({ projectsRoot: PROJECTS, backupEnabled: false, backupRoot: '' });
  });

  it('is null without a usable projects root, since setup always writes one', () => {
    // A file missing it was not written by the setup screen — half-edited, or
    // an empty object — and re-asking beats running on defaults nobody chose.
    for (const projectsRoot of [42, '', '   ', undefined]) {
      expect(parseConfig(JSON.stringify({ projectsRoot, backupRoot: BACKUPS }))).toBeNull();
    }
  });

  it('drops other fields of the wrong type rather than trusting them', () => {
    const saved = parseConfig(JSON.stringify({
      projectsRoot: PROJECTS, backupEnabled: 'yes', backupRoot: 42,
    }));
    expect(saved).toEqual({ projectsRoot: PROJECTS });
  });
});

describe('resolveConfig', () => {
  const defaults = { projectsRoot: 'C:\\fallback', backupEnabled: false, backupRoot: 'C:\\fallback-bak' };

  it('uses the saved answers when the environment is quiet', () => {
    const c = resolveConfig(
      { projectsRoot: PROJECTS, backupEnabled: true, backupRoot: BACKUPS },
      { env: {}, defaults },
    );
    expect(c).toEqual({ projectsRoot: PROJECTS, backupEnabled: true, backupRoot: BACKUPS });
  });

  it('falls back to the defaults on a first run', () => {
    expect(resolveConfig(null, { env: {}, defaults })).toEqual(defaults);
  });

  it('lets an environment variable win over what was saved', () => {
    const c = resolveConfig(
      { projectsRoot: PROJECTS, backupEnabled: true, backupRoot: BACKUPS },
      { env: { HANGAR_PROJECTS_ROOT: 'E:\\elsewhere' }, defaults },
    );
    expect(c.projectsRoot).toBe('E:\\elsewhere');
  });

  it('overrides field by field, so one variable does not discard the rest', () => {
    const c = resolveConfig(
      { projectsRoot: PROJECTS, backupEnabled: true, backupRoot: BACKUPS },
      { env: { HANGAR_BACKUP_ROOT: 'E:\\bak' }, defaults },
    );
    expect(c.projectsRoot).toBe(PROJECTS);
    expect(c.backupRoot).toBe('E:\\bak');
  });

  it('treats HANGAR_BACKUP_ROOT as asking for backups, not just relocating them', () => {
    // Setting it on a machine with backups off would otherwise do nothing at all.
    const c = resolveConfig(
      { projectsRoot: PROJECTS, backupEnabled: false, backupRoot: '' },
      { env: { HANGAR_BACKUP_ROOT: 'E:\\bak' }, defaults },
    );
    expect(c.backupEnabled).toBe(true);
  });

  it('reports backups off when there is nowhere for them to go', () => {
    const c = resolveConfig(
      { projectsRoot: PROJECTS, backupEnabled: true, backupRoot: '' },
      { env: {}, defaults: { ...defaults, backupRoot: '' } },
    );
    expect(c.backupEnabled).toBe(false);
  });

  it('defaults backups to off, since they write to disk', () => {
    expect(DEFAULTS.backupEnabled).toBe(false);
  });
});

describe('validateFolder', () => {
  it('refuses an empty field', () => {
    expect(validateFolder('  ').ok).toBe(false);
  });

  it('refuses a relative path', () => {
    expect(validateFolder('projects').ok).toBe(false);
    expect(validateFolder('..\\projects').ok).toBe(false);
  });

  it('accepts an absolute path', () => {
    expect(validateFolder(PROJECTS).ok).toBe(true);
  });

  it('can insist the folder is really there', () => {
    expect(validateFolder(PROJECTS, { mustExist: true, exists: () => false }).ok).toBe(false);
    expect(validateFolder(PROJECTS, { mustExist: true, exists: () => true }).ok).toBe(true);
  });
});

describe('isInside', () => {
  it('spots a folder nested in another', () => {
    expect(isInside('C:/a/b/c', 'C:/a')).toBe(true);
  });

  it('counts a folder as inside itself', () => {
    expect(isInside('C:/a', 'C:/a')).toBe(true);
  });

  it('is not fooled by a shared name prefix', () => {
    expect(isInside('C:/apple', 'C:/app')).toBe(false);
  });

  it('says no for unrelated folders', () => {
    expect(isInside('D:/x', 'C:/a')).toBe(false);
  });
});

describe('validateConfig', () => {
  const exists = () => true;

  it('accepts a sensible pair', () => {
    const res = validateConfig(
      { projectsRoot: PROJECTS, backupEnabled: true, backupRoot: BACKUPS },
      { exists },
    );
    expect(res.ok).toBe(true);
    expect(res.config).toEqual({ projectsRoot: PROJECTS, backupEnabled: true, backupRoot: BACKUPS });
  });

  it('refuses a projects folder that is not there', () => {
    const res = validateConfig(
      { projectsRoot: PROJECTS, backupEnabled: false },
      { exists: () => false },
    );
    expect(res.ok).toBe(false);
    expect(res.field).toBe('projectsRoot');
  });

  it('refuses a backup folder inside the projects folder', () => {
    // /MIR would be copying a tree into itself, without bound.
    const res = validateConfig(
      { projectsRoot: PROJECTS, backupEnabled: true, backupRoot: path.join(PROJECTS, 'backups') },
      { exists },
    );
    expect(res.ok).toBe(false);
    expect(res.field).toBe('backupRoot');
    expect(res.message).toMatch(/inside/);
  });

  it('refuses the two being the same folder', () => {
    const res = validateConfig(
      { projectsRoot: PROJECTS, backupEnabled: true, backupRoot: PROJECTS },
      { exists },
    );
    expect(res.ok).toBe(false);
  });

  it('refuses a projects folder inside the backup folder', () => {
    const res = validateConfig(
      { projectsRoot: path.join(BACKUPS, 'work'), backupEnabled: true, backupRoot: BACKUPS },
      { exists },
    );
    expect(res.ok).toBe(false);
    expect(res.field).toBe('backupRoot');
  });

  it('does not check the backup folder at all when backups are off', () => {
    const res = validateConfig(
      { projectsRoot: PROJECTS, backupEnabled: false, backupRoot: 'nonsense' },
      { exists },
    );
    expect(res.ok).toBe(true);
    expect(res.config.backupEnabled).toBe(false);
  });

  it('keeps the folder when backups are switched off, so turning them back on is one click', () => {
    const res = validateConfig(
      { projectsRoot: PROJECTS, backupEnabled: false, backupRoot: BACKUPS },
      { exists },
    );
    expect(res.config.backupRoot).toBe(BACKUPS);
  });
});
