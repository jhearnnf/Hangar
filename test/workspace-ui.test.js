import { it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
afterEach(() => vi.useRealTimers());

function setup() {
  const fields = new Map();
  const handlers = {};
  function get(id) {
    if (!fields.has(id)) fields.set(id, {
      value: '', disabled: false, hidden: true, textContent: '',
      classList: { toggle() {}, add() {} },
      addEventListener(name, fn) { this[name] = fn; },
      querySelectorAll() { return [...fields.values()].filter((f) => f !== this); },
      focus() {}, select() {},
      setAttribute() {},
    });
    return fields.get(id);
  }
  for (const id of ['workspace', 'startupcommands', 'notetitle', 'notebody', 'workspacestatus', 'workspaceproject', 'runstartup', 'notecount', 'noteprev', 'notenext', 'noteadd']) get(id);
  const api = {
    onStartupChanged: (cb) => { handlers.startup = cb; },
    startupState: vi.fn(async (projectPath) => ({ projectPath, running: false, output: '' })),
    startScripts: vi.fn(async (projectPath) => ({ projectPath, running: true, output: 'Server ready\n' })),
    stopScripts: vi.fn(async (projectPath) => ({ projectPath, running: false, output: 'Stopped\n' })),
    loadWorkspace: vi.fn(async (path) => ({ startup: path === 'A' ? 'npm run dev\nnpm run api' : '', pages: [{ id: 'page-1', title: path, body: '' }] })),
    saveWorkspace: vi.fn(async () => {}),
    openApp: vi.fn(async () => {}),
  };
  const run = vi.fn(async () => {});
  const window = { addEventListener: (name, fn) => { handlers[name] = fn; }, close: vi.fn() };
  vm.runInNewContext(fs.readFileSync(new URL('../renderer/local-app-url.js', import.meta.url), 'utf8'), { window, URL });
  vm.runInNewContext(fs.readFileSync(new URL('../renderer/workspace.js', import.meta.url), 'utf8'), {
    window, document: { getElementById: get }, crypto: { randomUUID }, setTimeout, clearTimeout,
  });
  return { workspace: window.createProjectWorkspace(api, run), api, run, get, handlers, window };
}

it('saves app links per project and opens only valid local URLs', async () => {
  const { workspace, get, api } = setup();
  await workspace.show({ path: 'A', name: 'Alpha' });
  expect(get('openapp').hidden).toBe(true);
  get('appurl').value = 'localhost:3000/dashboard';
  get('appurl').input();
  expect(get('openapp').disabled).toBe(false);
  await get('openapp').onclick();
  expect(api.openApp).toHaveBeenCalledWith('http://localhost:3000/dashboard');
  await workspace.show({ path: 'B', name: 'Beta' });
  expect(api.saveWorkspace.mock.calls[0][1].appUrl).toBe('localhost:3000/dashboard');
  expect(get('appurl').value).toBe('');
  await workspace.show({ path: 'A', name: 'Alpha' });
  expect(get('appurl').value).toBe('localhost:3000/dashboard');
  get('appurl').value = 'https://example.com';
  get('appurl').input();
  expect(get('openapp').disabled).toBe(true);
  await get('openapp').onclick();
  expect(api.openApp).toHaveBeenCalledTimes(1);
  get('appurl').value = '';
  get('appurl').input();
  await workspace.show({ path: 'B', name: 'Beta' });
});

it('saves titles and bodies before adding or switching pages and projects', async () => {
  const { workspace, get, api } = setup();
  await workspace.show({ path: 'A', name: 'Alpha' });
  get('notetitle').value = 'Accounts';
  get('notebody').value = 'Password';
  get('notebody').input();
  await get('noteadd').onclick();
  expect(api.saveWorkspace.mock.calls[0][1].page).toMatchObject({ title: 'Accounts', body: 'Password' });
  expect(get('notecount').textContent).toBe('2 / 2');
  await get('noteprev').onclick();
  expect(get('notetitle').value).toBe('Accounts');
  expect(get('notebody').value).toBe('Password');
  await workspace.show({ path: 'B', name: 'Beta' });
  expect(get('runstartup').disabled).toBe(true);
  await workspace.show({ path: 'A', name: 'Alpha' });
  expect(get('notebody').value).toBe('Password');
});

it('runs scripts separately, locks commands, shows output and supports stopping', async () => {
  const { workspace, get, api, run } = setup();
  const project = { path: 'A', name: 'Alpha' };
  await workspace.show(project);
  expect(get('runstartup').disabled).toBe(false);
  await get('runstartup').onclick();
  expect(run).not.toHaveBeenCalled();
  expect(api.startScripts).toHaveBeenCalledWith('A', 'npm run dev\nnpm run api');
  expect(get('startupcommands').disabled).toBe(true);
  expect(get('runstartup').textContent).toBe('Stop startup scripts');
  expect(get('startupoutput').hidden).toBe(false);
  expect(get('startupoutputtext').textContent).toContain('Server ready');
  expect(get('notebody').disabled).toBe(false);
  await get('runstartup').onclick();
  expect(api.stopScripts).toHaveBeenCalledWith('A');
  expect(get('startupcommands').disabled).toBe(false);
  expect(get('runstartup').textContent).toBe('Run startup scripts');
});

it('dismisses stopped output only after processes finish and final output settles', async () => {
  vi.useFakeTimers();
  const { workspace, get, api, handlers } = setup();
  await workspace.show({ path: 'A', name: 'Alpha' });
  await get('runstartup').onclick();
  api.stopScripts.mockResolvedValueOnce({ projectPath: 'A', running: false, finishing: true, output: 'Stopping' });
  await get('runstartup').onclick();
  vi.advanceTimersByTime(2000);
  expect(get('startupoutput').hidden).toBe(false);
  handlers.startup({ projectPath: 'A', running: false, finishing: false, output: '[1] Exited (1)' });
  vi.advanceTimersByTime(900);
  expect(get('startupoutput').hidden).toBe(false);
  handlers.startup({ projectPath: 'A', running: false, finishing: false, output: '[1] Exited (1)\n[2] Exited (1)' });
  vi.advanceTimersByTime(1000);
  expect(get('startupoutput').hidden).toBe(true);
  expect(get('startupcommands').disabled).toBe(false);
});

it('updates running state after exit and restores it when switching projects', async () => {
  const { workspace, get, api, handlers } = setup();
  await workspace.show({ path: 'A', name: 'Alpha' });
  await get('runstartup').onclick();
  await workspace.show({ path: 'B', name: 'Beta' });
  expect(get('startupcommands').disabled).toBe(false);
  api.startupState.mockResolvedValueOnce({ projectPath: 'A', running: true, output: 'Still running' });
  await workspace.show({ path: 'A', name: 'Alpha' });
  expect(get('startupcommands').disabled).toBe(true);
  expect(get('startupoutputtext').textContent).toBe('Still running');
  handlers.startup({ projectPath: 'A', running: false, output: 'Exited (1)' });
  expect(get('startupcommands').disabled).toBe(false);
  expect(get('startupoutputtext').textContent).toBe('Exited (1)');
});

it('keeps the edited page visible and reports failed saves', async () => {
  const { workspace, get, api } = setup();
  await workspace.show({ path: 'A', name: 'Alpha' });
  api.saveWorkspace.mockRejectedValue(new Error('Disk full'));
  get('notebody').value = 'Keep this';
  get('notebody').input();
  await get('noteadd').onclick();
  expect(get('notebody').value).toBe('Keep this');
  expect(get('notecount').textContent).toBe('1 / 1');
  expect(get('workspacestatus').textContent).toContain('Disk full');
});

it('ignores a stale project load when another project is selected', async () => {
  const { workspace, get, api } = setup();
  let resolve;
  api.loadWorkspace.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const first = workspace.show({ path: 'A', name: 'Alpha' });
  await workspace.show({ path: 'B', name: 'Beta' });
  resolve({ startup: 'wrong', pages: [] });
  await first;
  expect(get('workspaceproject').textContent).toBe('Beta');
  expect(get('startupcommands').value).toBe('');
});
