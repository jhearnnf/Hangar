'use strict';

const { spawn, execFileSync } = require('child_process');
const { defaultShell } = require('./shell');
const { stripVTControlCharacters } = require('util');

function commandArgs(shell, command) {
  if (/pwsh|powershell/i.test(shell.file)) return [...shell.args, '-NonInteractive', '-Command', command];
  if (/cmd\.exe/i.test(shell.file)) return [...shell.args, '/D', '/S', '/C', command];
  return [...shell.args, '-c', command];
}

function createStartupScripts({ launch = spawn, shell = defaultShell, changed = () => {}, killTree = stopTree } = {}) {
  const projects = new Map();
  function snapshot(projectPath) {
    const state = projects.get(projectPath);
    return { projectPath, running: Boolean(state?.children.size), finishing: Boolean(state?.closing.size), output: state?.output || '' };
  }
  function append(state, text) {
    state.output = (state.output + stripVTControlCharacters(text)).slice(-64000);
    if (!state.timer) state.timer = setTimeout(() => {
      state.timer = null;
      changed(snapshot(state.projectPath));
    }, 60);
  }
  function start(projectPath, text) {
    if (snapshot(projectPath).running) throw new Error('Startup scripts are already running.');
    if (typeof text !== 'string' || text.length > 100000) throw new Error('Invalid startup commands.');
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Enter a startup command first.');
    const previous = projects.get(projectPath);
    if (previous) clearTimeout(previous.timer);
    const state = { projectPath, children: new Set(), closing: new Set(), output: '', timer: null };
    projects.set(projectPath, state);
    const selected = shell();
    for (const [index, command] of lines.entries()) {
      const label = `[${index + 1}]`;
      append(state, `${label} ${command}\n`);
      try {
        const child = launch(selected.file, commandArgs(selected, command), {
          cwd: projectPath, windowsHide: true, detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        });
        state.children.add(child);
        for (const stream of [child.stdout, child.stderr]) {
          stream.setEncoding('utf8');
          stream.on('data', (data) => append(state, `${label} ${data}`));
        }
        child.on('error', (err) => {
          state.children.delete(child);
          state.closing.delete(child);
          append(state, `${label} Failed: ${err.message}\n`);
          changed(snapshot(projectPath));
        });
        child.on('close', (code) => {
          state.children.delete(child);
          state.closing.delete(child);
          append(state, `${label} Exited${code === null ? '' : ` (${code})`}\n`);
          changed(snapshot(projectPath));
        });
      } catch (err) { append(state, `${label} Failed: ${err.message}\n`); }
    }
    changed(snapshot(projectPath));
    return snapshot(projectPath);
  }
  function stop(projectPath) {
    const state = projects.get(projectPath);
    if (!state) return snapshot(projectPath);
    const errors = [];
    for (const child of [...state.children]) {
      try { state.closing.add(child); killTree(child); state.children.delete(child); }
      catch (err) { state.closing.delete(child); errors.push(err.message); }
    }
    append(state, errors.length ? `Could not stop: ${errors.join('; ')}\n` : 'Startup scripts stopped.\n');
    changed(snapshot(projectPath));
    if (errors.length) throw new Error(errors.join('; '));
    return snapshot(projectPath);
  }
  function stopAll() {
    const errors = [];
    for (const projectPath of projects.keys()) {
      try { stop(projectPath); } catch (err) { errors.push(err.message); }
    }
    if (errors.length) throw new Error(errors.join('; '));
  }
  return { start, stop, snapshot, stopAll };
}

function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe', timeout: 10000 });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
}

module.exports = { createStartupScripts, commandArgs };
