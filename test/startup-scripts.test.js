import { it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { createStartupScripts, commandArgs } = require('../startup-scripts');
afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers();
  const children = [];
  const launch = vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = vi.fn();
    child.stderr = new EventEmitter(); child.stderr.setEncoding = vi.fn();
    children.push(child);
    return child;
  });
  const killTree = vi.fn();
  const changed = vi.fn();
  const runner = createStartupScripts({ launch, killTree, changed, shell: () => ({ file: 'powershell.exe', args: ['-NoLogo'] }) });
  return { runner, children, launch, killTree, changed };
}
it('runs lines independently without persistent interactive shells and bounds output', () => {
  const { runner, launch, children } = setup();
  expect(runner.start('project', 'npm run dev\n\nnpm run api').running).toBe(true);
  expect(launch).toHaveBeenCalledTimes(2);
  expect(launch.mock.calls[0][1]).toEqual(['-NoLogo', '-NonInteractive', '-Command', 'npm run dev']);
  expect(launch.mock.calls[0][2]).toMatchObject({ cwd: 'project', windowsHide: true });
  children[0].stdout.emit('data', '\u001b[31mReady\u001b[0m');
  expect(runner.snapshot('project').output).toContain('Ready');
  expect(runner.snapshot('project').output).not.toContain('\u001b');
  children[1].stderr.emit('data', 'x'.repeat(70000));
  expect(runner.snapshot('project').output.length).toBe(64000);
  expect(() => runner.start('project', 'duplicate')).toThrow('already running');
});
it('stops only the requested project process trees', () => {
  const { runner, children, killTree } = setup();
  runner.start('A', 'one\ntwo'); runner.start('B', 'three');
  expect(runner.stop('A').running).toBe(false);
  expect(killTree.mock.calls.map(([child]) => child)).toEqual(children.slice(0, 2));
  expect(runner.snapshot('B').running).toBe(true);
});
it('unlocks only after all processes exit, including launch errors', () => {
  const { runner, children } = setup();
  runner.start('A', 'one\ntwo');
  children[0].emit('close', 0);
  expect(runner.snapshot('A').running).toBe(true);
  children[1].emit('error', new Error('spawn failed'));
  expect(runner.snapshot('A').running).toBe(false);
  expect(runner.snapshot('A').output).toContain('spawn failed');
});
it('retains running state when process tree termination fails', () => {
  const { runner, killTree } = setup();
  runner.start('A', 'one');
  killTree.mockImplementation(() => { throw new Error('Access denied'); });
  expect(() => runner.stop('A')).toThrow('Access denied');
  expect(runner.snapshot('A').running).toBe(true);
});
it('uses exiting command modes for cmd and POSIX shells', () => {
  expect(commandArgs({ file: 'cmd.exe', args: [] }, 'npm start')).toEqual(['/D', '/S', '/C', 'npm start']);
  expect(commandArgs({ file: '/bin/zsh', args: ['-l'] }, 'npm start')).toEqual(['-l', '-c', 'npm start']);
});
