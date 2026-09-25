'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const DIR = '.hangar-local';

function safeEntry(file) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error('Hangar local files must not be symbolic links.');
  }
}

function folder(projectPath) {
  const dir = path.join(projectPath, DIR);
  safeEntry(dir);
  return dir;
}

function prepare(projectPath) {
  const dir = folder(projectPath);
  // Refuse to write private data over anything already tracked by Git.
  let repo = false;
  try {
    execFileSync('git', ['-C', projectPath, 'rev-parse', '--show-toplevel'], { stdio: 'pipe', windowsHide: true });
    repo = true;
  } catch { /* A project need not be a Git repository yet. */ }
  if (repo && execFileSync('git', ['-C', projectPath, 'ls-files', '--', DIR], { encoding: 'utf8', windowsHide: true }).trim()) {
    throw new Error('.hangar-local contains Git-tracked files. Untrack them before saving private notes.');
  }
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  safeEntry(ignore);
  fs.writeFileSync(ignore, '*\n', { mode: 0o600 });
  return dir;
}

function read(file) {
  safeEntry(file);
  try { return fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
}

function load(projectPath) {
  const dir = folder(projectPath);
  const startup = read(path.join(dir, 'startup.txt'));
  const pages = fs.existsSync(dir) ? fs.readdirSync(dir)
    .filter((name) => /^page-[a-z0-9-]+\.txt$/.test(name)).sort().map((name) => {
      const text = read(path.join(dir, name));
      const split = text.indexOf('\n');
      return { id: name.slice(0, -4), title: split < 0 ? text : text.slice(0, split).replace(/\r$/, ''), body: split < 0 ? '' : text.slice(split + 1) };
    }) : [];
  return { startup, pages };
}

function save(projectPath, value) {
  const { startup, page } = value;
  if (startup !== undefined && (typeof startup !== 'string' || startup.length > 100000)) throw new Error('Invalid startup commands.');
  if (page && (!/^page-[a-z0-9-]+$/.test(page.id) || typeof page.title !== 'string' || /[\r\n]/.test(page.title) || page.title.length > 200 || typeof page.body !== 'string' || page.body.length > 2000000)) throw new Error('Invalid notes page.');
  const dir = prepare(projectPath);
  function write(name, text) {
    const target = path.join(dir, name);
    const temp = target + '.tmp';
    safeEntry(target);
    safeEntry(temp);
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, target);
  }
  if (startup !== undefined) write('startup.txt', startup);
  if (page) write(page.id + '.txt', page.title + '\n' + page.body);
}

module.exports = { load, save };
