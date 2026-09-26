import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const workspace = require('../project-workspace');
const { EXCLUDE_DIRS, EXCLUDE_FILES } = require('../backup');
const roots = [];
function project() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-notes-')); roots.push(dir); return dir; }
function git(dir, ...args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }); }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('project workspace', () => {
  it('loads an empty project without creating files', () => {
    const dir = project();
    expect(workspace.load(dir)).toEqual({ startup: '', pages: [], appUrl: '' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it('persists separate titled text pages and commands independently per project', () => {
    const dir = project();
    const page = { id: 'page-1', title: 'Test accounts', body: 'dev@example.test\npassword: test\n' };
    workspace.save(dir, { startup: 'npm run dev\nnpm run api', page });
    workspace.save(dir, { page: { id: 'page-2', title: 'TODO', body: 'Fix UI' } });
    expect(workspace.load(dir)).toEqual({ startup: 'npm run dev\nnpm run api', pages: [page, { id: 'page-2', title: 'TODO', body: 'Fix UI' }], appUrl: '' });
    expect(fs.readFileSync(path.join(dir, '.hangar-local', 'page-1.txt'), 'utf8')).toBe('Test accounts\ndev@example.test\npassword: test\n');
    expect(workspace.load(project()).pages).toEqual([]);
    workspace.save(dir, { page: { ...page, title: 'Updated' } });
    expect(workspace.load(dir).pages[0].title).toBe('Updated');
  });
  it('persists, preserves and clears the app link independently per project', () => {
    const dir = project();
    workspace.save(dir, { appUrl: 'localhost:3000/app' });
    workspace.save(dir, { startup: 'npm run dev' });
    expect(workspace.load(dir).appUrl).toBe('localhost:3000/app');
    expect(workspace.load(project()).appUrl).toBe('');
    workspace.save(dir, { appUrl: '' });
    expect(workspace.load(dir).appUrl).toBe('');
  });
  it('ignores all local files even when Git is initialized after saving', () => {
    const dir = project();
    workspace.save(dir, { startup: 'npm run dev', page: { id: 'page-1', title: 'Private', body: 'secret' } });
    git(dir, 'init');
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(git(dir, 'check-ignore', '.hangar-local/page-1.txt').trim()).toBe('.hangar-local/page-1.txt');
  });
  it('refuses to write private data into tracked files', () => {
    const dir = project();
    git(dir, 'init');
    workspace.save(dir, { startup: 'old' });
    git(dir, 'add', '-f', '.hangar-local/startup.txt');
    expect(() => workspace.save(dir, { startup: 'secret' })).toThrow('Git-tracked');
    expect(workspace.load(dir).startup).toBe('old');
  });
  it('rejects page traversal and multiline titles', () => {
    const dir = project();
    expect(() => workspace.save(dir, { page: { id: '../outside', title: 'X', body: '' } })).toThrow();
    expect(() => workspace.save(dir, { page: { id: 'page-1', title: 'X\nY', body: '' } })).toThrow();
  });
  it('keeps local text files eligible for Hangar backups', () => {
    expect(EXCLUDE_DIRS).not.toContain('.hangar-local');
    expect(EXCLUDE_FILES).not.toContain('*.txt');
  });
});
