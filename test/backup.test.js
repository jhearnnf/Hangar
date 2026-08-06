import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  backupRoot,
  destinationFor,
  robocopyArgs,
  succeeded,
  describe: describeCode,
  prepare,
  mirror,
  sweepDetached,
  EXCLUDE_DIRS,
} = require('../backup.js');

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

const okDeps = { root: ROOT, exists: () => true, mkdir: () => {} };

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
    const plan = prepare('C:/src/Gone', { root: ROOT, exists: () => false, mkdir: () => {} });
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
      root: ROOT,
      exists: () => true,
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
      root: ROOT,
      exists: () => false,
      mkdir: () => {},
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
});

describe('sweepDetached', () => {
  const run = (paths) => {
    const calls = [];
    const ok = sweepDetached(paths, { spawnFn: fakeSpawn(0, calls), execPath: 'C:\\el\\electron.exe' });
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
