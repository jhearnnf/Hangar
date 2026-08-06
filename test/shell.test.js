import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { defaultShell, argsFor, listProjects } = require('../shell.js');

const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const WINPS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const winEnv = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
};

describe('defaultShell', () => {
  it('prefers PowerShell 7 when it is installed', () => {
    const shell = defaultShell({ platform: 'win32', env: winEnv, exists: (f) => f === PWSH7 });
    expect(shell.file).toBe(PWSH7);
    expect(shell.args).toEqual(['-NoLogo']);
  });

  it('falls back to Windows PowerShell', () => {
    const shell = defaultShell({ platform: 'win32', env: winEnv, exists: (f) => f === WINPS });
    expect(shell.file).toBe(WINPS);
  });

  it('falls back to cmd when no PowerShell is present', () => {
    const shell = defaultShell({ platform: 'win32', env: winEnv, exists: () => false });
    expect(shell.file).toBe(winEnv.COMSPEC);
    expect(shell.args).toEqual([]);
  });

  it('honours $SHELL on posix', () => {
    const shell = defaultShell({ platform: 'linux', env: { SHELL: '/usr/bin/zsh' } });
    expect(shell).toEqual({ file: '/usr/bin/zsh', args: [] });
  });
});

describe('argsFor', () => {
  const pwsh = { file: PWSH7, args: ['-NoLogo'] };
  const cmd = { file: 'C:\\Windows\\system32\\cmd.exe', args: [] };
  const bash = { file: '/bin/bash', args: [] };

  it('passes the base args through when there is no command', () => {
    expect(argsFor(pwsh, null)).toEqual(['-NoLogo']);
    expect(argsFor(pwsh, undefined)).toEqual(['-NoLogo']);
  });

  it('does not mutate the shell it was given', () => {
    argsFor(pwsh, 'claude');
    expect(pwsh.args).toEqual(['-NoLogo']);
  });

  it('keeps PowerShell alive after the command exits', () => {
    expect(argsFor(pwsh, 'claude')).toEqual(['-NoLogo', '-NoExit', '-Command', 'claude']);
  });

  it('keeps cmd alive after the command exits', () => {
    expect(argsFor(cmd, 'claude')).toEqual(['/K', 'claude']);
  });

  it('re-execs an interactive shell on posix', () => {
    const args = argsFor(bash, 'claude');
    expect(args[0]).toBe('-i');
    expect(args[1]).toBe('-c');
    expect(args[2]).toContain('claude;');
    expect(args[2]).toContain('exec "/bin/bash" -i');
  });
});

describe('listProjects', () => {
  const dirent = (name, isDir = true) => ({ name, isDirectory: () => isDir });

  // Mixed casing on purpose: the sort has to be case-insensitive, and a list
  // that was already in ASCII order would not prove it.
  const fakeRoot = [
    dirent('Widget'),
    dirent('API_NOTES'),
    dirent('node_modules'),
    dirent('.git'),
    dirent('readme.txt', false),
    dirent('little_bot'),
  ];

  it('returns real project directories only', () => {
    const names = listProjects('/root', () => fakeRoot).map((p) => p.name);
    expect(names).toEqual(['API_NOTES', 'little_bot', 'Widget']);
  });

  it('drops node_modules, dotfolders and plain files', () => {
    const names = listProjects('/root', () => fakeRoot).map((p) => p.name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
    expect(names).not.toContain('readme.txt');
  });

  it('sorts case-insensitively so casing does not scatter the list', () => {
    const entries = [dirent('zebra'), dirent('Apple'), dirent('banana')];
    const names = listProjects('/root', () => entries).map((p) => p.name);
    expect(names).toEqual(['Apple', 'banana', 'zebra']);
  });

  it('gives each project an absolute path under the root', () => {
    const [project] = listProjects('/root', () => [dirent('Widget')]);
    expect(project.path).toContain('Widget');
    expect(project.path).toContain('root');
  });

  it('returns nothing rather than throwing when the root is unreadable', () => {
    expect(listProjects('/nope', () => { throw new Error('ENOENT'); })).toEqual([]);
  });
});
