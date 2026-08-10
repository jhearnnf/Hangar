import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  backupRoot,
  destinationFor,
  ROBOCOPY,
  RSYNC,
  copier,
  prepare,
  mirror,
  sweepDetached,
  EXCLUDE_DIRS,
  EXCLUDE_FILES,
} = require('../backup.js');

const robocopyArgs = ROBOCOPY.args;
const succeeded = ROBOCOPY.succeeded;
const describeCode = ROBOCOPY.describe;

const ROOT = path.resolve('D:/Backups/Hangar');

/** A robocopy that never runs, but reports the exit code we ask it to. */
function fakeSpawn(code, calls = []) {
  return (file, args, opts) => {
    calls.push({ file, args, opts });
    const proc = new EventEmitter();
    proc.unref = () => {};
    queueMicrotask(() => proc.emit('close', code));
    return proc;
  };
}

// The platform is stated rather than inherited, so which tool a test is about
// is part of the test rather than a property of the machine running it.
const okDeps = { root: ROOT, exists: () => true, mkdir: () => {}, platform: 'win32' };

describe('copier', () => {
  it('uses robocopy on Windows and rsync everywhere else', () => {
    expect(copier('win32')).toBe(ROBOCOPY);
    expect(copier('darwin')).toBe(RSYNC);
    expect(copier('linux')).toBe(RSYNC);
  });
});

describe('backupRoot', () => {
  it('falls back to a folder in home when nothing is configured', () => {
    expect(backupRoot({})).toMatch(/HangarBackups$/);
  });

  it('honours HANGAR_BACKUP_ROOT', () => {
    expect(backupRoot({ HANGAR_BACKUP_ROOT: 'D:\\elsewhere' })).toBe('D:\\elsewhere');
  });
});

describe('destinationFor', () => {
  it('puts a project under the backup root by name', () => {
    expect(destinationFor('C:/work/projects/Widget', ROOT))
      .toBe(path.join(ROOT, 'Widget'));
  });

  it('refuses names that would escape the backup root', () => {
    expect(destinationFor('..', ROOT)).toBeNull();
    expect(destinationFor('.', ROOT)).toBeNull();
    expect(destinationFor('', ROOT)).toBeNull();
  });

  it('never returns the backup root itself', () => {
    // /MIR onto the root would purge every other project's backup.
    for (const input of ['', '.', '..', '/', 'C:/']) {
      const dest = destinationFor(input, ROOT);
      expect(dest === path.resolve(ROOT) ? null : dest).not.toBe(path.resolve(ROOT));
    }
  });
});

describe('robocopyArgs', () => {
  const args = robocopyArgs('C:\\src\\Widget', 'D:\\bak\\Widget');

  it('leads with the source and destination', () => {
    expect(args[0]).toBe('C:\\src\\Widget');
    expect(args[1]).toBe('D:\\bak\\Widget');
  });

  it('mirrors', () => {
    expect(args).toContain('/MIR');
  });

  it('excludes the folders that break or bloat a sync', () => {
    for (const dir of ['node_modules', '.git', 'dist', '__pycache__']) {
      expect(args).toContain(dir);
      expect(EXCLUDE_DIRS).toContain(dir);
    }
  });

  it('lists every excluded directory after /XD and before /XF', () => {
    const xd = args.indexOf('/XD');
    const xf = args.indexOf('/XF');
    expect(xd).toBeGreaterThan(-1);
    expect(xf).toBeGreaterThan(xd);
    expect(args.slice(xd + 1, xf)).toEqual(EXCLUDE_DIRS);
  });

  it('rides out a brief Dropbox lock but still gives up in seconds', () => {
    // Dropbox holds destination files open while it uploads them, so the first
    // attempt can lose a race it would win a moment later. robocopy's default
    // is a million retries a minute apart, which would hang forever.
    expect(args).toContain('/R:3');
    expect(args).toContain('/W:2');
  });
});

describe('RSYNC.args', () => {
  const args = RSYNC.args('/Users/you/src/Widget', '/Users/you/Dropbox/bak/Widget');

  it('mirrors rather than merges', () => {
    expect(args).toContain('-a');
    expect(args).toContain('--delete');
  });

  it('ends the source in a slash and leaves the destination without one', () => {
    // The single most dangerous character in this file. Without it rsync
    // creates bak/Widget/Widget and --delete empties the level above it.
    expect(args[args.length - 2]).toBe('/Users/you/src/Widget/');
    expect(args[args.length - 1]).toBe('/Users/you/Dropbox/bak/Widget');
  });

  it('does not double the slash on a source that already has one', () => {
    const already = RSYNC.args('/Users/you/src/Widget/', '/bak/Widget');
    expect(already[already.length - 2]).toBe('/Users/you/src/Widget/');
  });

  it('leaves out everything the Windows mirror leaves out', () => {
    // Both mirrors have to skip the same things, or the same project backed up
    // from two machines would be two different trees.
    for (const name of [...EXCLUDE_DIRS, ...EXCLUDE_FILES]) {
      expect(args).toContain(`--exclude=${name}`);
    }
  });

  it('says nothing on stdout, since only the exit code is read', () => {
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--progress');
  });
});

describe('RSYNC exit codes', () => {
  it('treats a clean run as success', () => {
    expect(RSYNC.succeeded(0)).toBe(true);
    expect(RSYNC.describe(0)).toMatch(/backed up/);
  });

  it('forgives files that vanished mid-copy', () => {
    // 24 is an editor writing a temp file while the backup walks past it, not
    // a backup worth flagging red in the sidebar.
    expect(RSYNC.succeeded(24)).toBe(true);
  });

  it('treats a partial transfer as a failure', () => {
    expect(RSYNC.succeeded(23)).toBe(false);
    expect(RSYNC.describe(23)).toMatch(/^failed/);
  });

  it('names any other code rather than swallowing it', () => {
    expect(RSYNC.succeeded(1)).toBe(false);
    expect(RSYNC.describe(12)).toMatch(/12/);
  });
});

describe('succeeded', () => {
  it('treats robocopy bits 0-2 as ordinary outcomes', () => {
    for (const code of [0, 1, 2, 3, 4, 5, 6, 7]) expect(succeeded(code)).toBe(true);
  });

  it('treats 8 and above as failure', () => {
    for (const code of [8, 9, 16, 24]) expect(succeeded(code)).toBe(false);
  });

  it('treats a missing code as failure', () => {
    expect(succeeded(null)).toBe(false);
    expect(succeeded(undefined)).toBe(false);
  });
});

describe('describe', () => {
  it('distinguishes a no-op from a real copy', () => {
    expect(describeCode(0)).toMatch(/up to date/);
    expect(describeCode(1)).toMatch(/backed up/);
  });

  it('says so when files could not be copied', () => {
    expect(describeCode(8)).toMatch(/^failed/);
    expect(describeCode(16)).toMatch(/fatal/);
  });
});

describe('prepare', () => {
  it('refuses when the project folder is missing', () => {
    // /MIR against a vanished source would empty the backup rather than fill it.
    const plan = prepare('C:/src/Gone', { ...okDeps, exists: () => false });
    expect(plan.error).toMatch(/missing/);
  });

  it('refuses a relative path', () => {
    // resolve() would turn '..' into an ordinary absolute path, and mirroring
    // the whole projects root off the back of it is the accident to avoid.
    expect(prepare('..', okDeps).error).toMatch(/refused/);
    expect(prepare('Widget', okDeps).error).toMatch(/refused/);
    expect(prepare('', okDeps).error).toMatch(/refused/);
  });

  it('reports a backup folder it cannot create', () => {
    const plan = prepare('C:/src/Widget', {
      ...okDeps,
      mkdir: () => { throw new Error('EACCES'); },
    });
    expect(plan.error).toMatch(/EACCES/);
  });

  it('returns both paths when everything checks out', () => {
    const plan = prepare('C:/src/Widget', okDeps);
    expect(plan.error).toBeUndefined();
    expect(plan.dest).toBe(path.join(ROOT, 'Widget'));
  });

});

describe('mirror', () => {
  it('resolves ok on an ordinary robocopy exit', async () => {
    const result = await mirror('C:/src/Widget', { ...okDeps, spawnFn: fakeSpawn(1) });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/backed up/);
  });

  it('resolves not-ok on a robocopy failure', async () => {
    const result = await mirror('C:/src/Widget', { ...okDeps, spawnFn: fakeSpawn(8) });
    expect(result.ok).toBe(false);
  });

  it('never spawns anything when the source is missing', async () => {
    const calls = [];
    const result = await mirror('C:/src/Gone', {
      ...okDeps,
      exists: () => false,
      spawnFn: fakeSpawn(0, calls),
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('survives robocopy not being on the machine at all', async () => {
    const spawnFn = () => {
      const proc = new EventEmitter();
      queueMicrotask(() => proc.emit('error', new Error('ENOENT')));
      return proc;
    };
    const result = await mirror('C:/src/Widget', { ...okDeps, spawnFn });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/ENOENT/);
  });

  it('hides the console window robocopy would otherwise flash up', async () => {
    const calls = [];
    await mirror('C:/src/Widget', { ...okDeps, spawnFn: fakeSpawn(0, calls) });
    expect(calls[0].opts.windowsHide).toBe(true);
  });

  it('runs rsync off Windows, with the source it was given', async () => {
    const calls = [];
    const result = await mirror('/Users/you/src/Widget', {
      ...okDeps, platform: 'darwin', root: '/Users/you/bak', spawnFn: fakeSpawn(0, calls),
    });

    const args = calls[0].args;
    expect(calls[0].file).toBe('rsync');
    expect(args).toContain('--delete');
    // prepare() resolves through the host's path module, so running this on
    // Windows puts a drive letter on the front. What matters here is that the
    // source still arrives with its trailing slash.
    expect(args[args.length - 2]).toBe(`${path.resolve('/Users/you/src/Widget')}/`);
    expect(result.ok).toBe(true);
  });

  it('reads rsync exit codes as rsync codes, not robocopy ones', async () => {
    // 1 is a success under robocopy's bit field and a failure under rsync, so
    // this is the one case where reading the wrong table looks fine and isn't.
    const rsync = await mirror('/Users/you/src/Widget', {
      ...okDeps, platform: 'darwin', root: '/Users/you/bak', spawnFn: fakeSpawn(1),
    });
    expect(rsync.ok).toBe(false);

    const robocopy = await mirror('C:/src/Widget', { ...okDeps, spawnFn: fakeSpawn(1) });
    expect(robocopy.ok).toBe(true);
  });

  it('says so plainly when rsync is not installed', async () => {
    const spawnFn = () => {
      const proc = new EventEmitter();
      const err = new Error('spawn rsync ENOENT');
      err.code = 'ENOENT';
      queueMicrotask(() => proc.emit('error', err));
      return proc;
    };
    const result = await mirror('/Users/you/src/Widget', {
      ...okDeps, platform: 'darwin', root: '/Users/you/bak', spawnFn,
    });
    expect(result.message).toBe('rsync is not installed');
  });
});

describe('sweepDetached', () => {
  const run = (paths) => {
    const calls = [];
    const ok = sweepDetached(paths, {
      spawnFn: fakeSpawn(0, calls), execPath: 'C:\\el\\electron.exe', platform: 'win32',
    });
    return { ok, call: calls[0], calls };
  };

  it('hands every project to one sequential child rather than racing them', () => {
    // Fifteen robocopies at once would only queue on the same disk and uplink.
    const { call, calls } = run(['C:/src/A', 'C:/src/B', 'C:/src/C']);
    expect(calls).toHaveLength(1);
    expect(call.args.slice(1)).toEqual(['C:/src/A', 'C:/src/B', 'C:/src/C']);
  });

  it('runs the sweep script on Electron as plain node', () => {
    const { call } = run(['C:/src/A']);
    expect(call.file).toBe('C:\\el\\electron.exe');
    expect(call.args[0]).toMatch(/backup-sweep\.js$/);
    expect(call.opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('passes the configured destination down to the child', () => {
    // The child re-derives its root from the environment, so a sweep would
    // otherwise land wherever the launching shell happened to point.
    const calls = [];
    sweepDetached(['C:/src/A'], {
      spawnFn: fakeSpawn(0, calls),
      execPath: 'C:\\el\\electron.exe',
      root: 'D:\\chosen',
      platform: 'win32',
    });
    expect(calls[0].opts.env.HANGAR_BACKUP_ROOT).toBe('D:\\chosen');
  });

  it('detaches so quitting is not held up by the copy', () => {
    const { call } = run(['C:/src/A']);
    expect(call.opts.detached).toBe(true);
    expect(call.opts.windowsHide).toBe(true);
  });

  it('spawns nothing when there is nothing to sweep', () => {
    for (const empty of [[], null, undefined, [null, '']]) {
      const { ok, calls } = run(empty);
      expect(ok).toBe(false);
      expect(calls).toEqual([]);
    }
  });
});
