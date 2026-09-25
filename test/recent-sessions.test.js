import { it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { recentAll } = require('../recent-sessions');

it('combines both histories newest first with explicit agent labels and correct resume commands', () => {
  const claude = vi.fn(() => [{ id: 'same', label: 'Claude work', at: 10, live: true, command: 'claude --resume same' }]);
  const codex = vi.fn(() => [{ id: 'same', label: 'Codex work', at: 20, live: false, command: 'codex resume same' }]);
  const rows = recentAll('/project', { claude, codex });
  expect(rows.map((r) => [r.agentId, r.command, r.live])).toEqual([
    ['codex', 'codex resume same', false], ['claude', 'claude --resume same', true],
  ]);
  expect(claude).toHaveBeenCalledWith('/project');
  expect(codex).toHaveBeenCalledWith('/project');
});

it('still shows the available agent when the other has no history or fails', () => {
  const row = { id: '1', at: 1, command: 'codex resume 1' };
  const report = vi.fn();
  expect(recentAll('/project', { claude: () => [], codex: () => [row] })).toEqual([{ ...row, agentId: 'codex' }]);
  expect(recentAll('/project', { claude: () => { throw new Error('Unreadable'); }, codex: () => [row] }, report)).toEqual([{ ...row, agentId: 'codex' }]);
  expect(report).toHaveBeenCalledOnce();
});
