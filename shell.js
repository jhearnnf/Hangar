'use strict';

const fs = require('fs');
const path = require('path');

// Folders that sit alongside real projects but aren't ones.
const PROJECT_IGNORE = new Set(['node_modules', 'dist', 'build', 'out', 'venv', '__pycache__']);

/**
 * Pick the best available shell. Order matters: PowerShell 7 if the user has
 * it, then Windows PowerShell, then cmd. On posix, honour $SHELL.
 *
 * macOS gets `-l` as well, because an app launched from the Dock or Finder
 * inherits launchd's bare PATH rather than a terminal's. Without a login shell
 * the profile that puts Homebrew, nvm and `claude` on PATH is never read, and
 * the first thing every tab would say is "command not found". Terminal.app runs
 * login shells for the same reason. zsh is the default there, so it is the
 * fallback when $SHELL is somehow unset.
 *
 * Dependencies are injectable so the choice can be tested for either platform.
 */
function defaultShell({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform === 'darwin') {
    return { file: env.SHELL || '/bin/zsh', args: ['-l'] };
  }

  if (platform !== 'win32') {
    return { file: env.SHELL || '/bin/bash', args: [] };
  }

  const sys = env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.win32.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];

  for (const file of candidates) {
    if (exists(file)) return { file, args: ['-NoLogo'] };
  }
  return { file: env.COMSPEC || 'cmd.exe', args: [] };
}

/**
 * Build the argv that starts `command` and then leaves the user at a live
 * prompt in the same directory. Passing the command as an argument rather than
 * typing it into the shell avoids racing the shell's own startup.
 */
function argsFor(shell, command) {
  const args = [...shell.args];
  if (!command) return args;

  if (/pwsh|powershell/i.test(shell.file)) return [...args, '-NoExit', '-Command', command];
  if (/cmd\.exe/i.test(shell.file)) return [...args, '/K', command];

  // The shell left behind after the command exits is started with the same
  // flags as the one running it, so `-l` on macOS is not quietly dropped
  // halfway through the tab's life.
  const rest = [...args, '-i'].join(' ');
  return [...args, '-i', '-c', `${command}; exec "${shell.file}" ${rest}`];
}

/**
 * The projects to offer in the sidebar: every real directory sitting directly
 * inside `root`, alphabetically.
 */
function listProjects(root, readdir = fs.readdirSync) {
  let entries;
  try {
    entries = readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => !e.name.startsWith('.') && !PROJECT_IGNORE.has(e.name))
    .map((e) => ({ name: e.name, path: path.join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

module.exports = { defaultShell, argsFor, listProjects, PROJECT_IGNORE };
