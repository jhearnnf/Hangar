'use strict';

const { app, BrowserWindow, ipcMain, Menu, screen, dialog, shell: electronShell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const { defaultShell, argsFor, listProjects, PROJECT_IGNORE } = require('./shell');
const { validateProjectName } = require('./project-name');
const { parseState, restoreState, MIN_SIZE } = require('./window-state');
const { mirror, sweepDetached } = require('./backup');
const { createUsageReader } = require('./usage');
const {
  CONFIG_FILE, suggestions, parseConfig, resolveConfig, validateConfig,
} = require('./config');

// One pty per tab. Keyed by an id the renderer generates.
const sessions = new Map();

let win = null;

// ----------------------------------------------------------------- settings

// Alongside window-state.json, and for the same reason: these are answers about
// this machine — where its projects live, where its backups go — not something
// to carry around in the repo.
function configFile() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

/**
 * What was saved last time, or null on a first run.
 *
 * Null is what puts the setup screen up, so an unreadable file counts as one
 * too: better to ask again than to run on defaults nobody chose.
 */
function loadConfig() {
  try {
    return parseConfig(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return null;
  }
}

// Resolved once at startup and again on save, rather than per call: every read
// below wants the same answer, and re-reading the file per pty spawn would let
// the projects root change underneath a session.
let saved = null;
let config = null;

function applyConfig(next) {
  saved = next;
  config = resolveConfig(next, { defaults: { ...suggestions(__dirname), backupEnabled: false } });
  return config;
}

function saveConfig(next) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), `${JSON.stringify(next, null, 2)}\n`);
  return applyConfig(next);
}

// Which fields the environment has taken over, so the setup screen can show
// them as locked rather than letting someone edit a value that will not win.
function envOverrides(env = process.env) {
  return {
    projectsRoot: Boolean(env.HANGAR_PROJECTS_ROOT),
    backupRoot: Boolean(env.HANGAR_BACKUP_ROOT),
  };
}

// ------------------------------------------------------------- window state

// userData rather than the source tree: this is per-machine preference, not
// something to carry around in the repo.
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadState() {
  try {
    return parseState(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null; // first run
  }
}

function saveState() {
  if (!win || win.isDestroyed()) return;

  // getNormalBounds() is the un-maximized geometry, so a window closed while
  // maximized still remembers the size to restore down to.
  const { x, y, width, height } = win.getNormalBounds();
  const state = { x, y, width, height, maximized: win.isMaximized(), fullScreen: win.isFullScreen() };

  try {
    fs.writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
  } catch { /* not worth interrupting a close over */ }
}

// Dragging or resizing fires continuously; only the resting position matters.
let saveTimer = null;
function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);
}

/**
 * The menu bar, which on every platform but macOS is no menu bar at all — the
 * app is one big terminal and its shortcuts live in the renderer.
 *
 * macOS is the exception because the menu is not only a menu there. The system
 * routes Cmd+Q, Cmd+W and the clipboard through it, so an app without one
 * cannot be quit with the keyboard and cannot paste into its own text fields.
 * Only the roles that buy those back are here: no reload, no dev tools, and in
 * particular no zoom roles, since Cmd+= and Cmd+- are the terminal font size
 * and a menu accelerator would take them before the renderer ever saw them.
 */
function applicationMenu() {
  if (process.platform !== 'darwin') return null;

  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'close' },
      ],
    },
  ]);
}

function createWindow() {
  const state = restoreState(loadState(), screen.getAllDisplays().map((d) => d.workArea));

  win = new BrowserWindow({
    ...state.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    backgroundColor: '#12141a',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Terminals must keep rendering when the window is in the background,
      // otherwise long test runs stall until you focus the window.
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(applicationMenu());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.env.HANGAR_DEBUG) {
    win.webContents.on('console-message', (e) => {
      console.log(`[renderer] ${e.message}  (${e.sourceId}:${e.lineNumber})`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[renderer] gone:', details);
    });
  }

  win.once('ready-to-show', () => {
    if (state.fullScreen) win.setFullScreen(true);
    else if (state.maximized) win.maximize();
    win.show();
  });

  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(event, saveStateSoon);
  }

  // 'close' still has a live window to measure; 'closed' does not.
  win.on('close', () => {
    clearTimeout(saveTimer);
    saveState();
  });

  win.on('closed', () => {
    win = null;
    for (const s of sessions.values()) {
      try { s.proc.kill(); } catch { /* already gone */ }
    }
    sessions.clear();
  });
}

// Without this Windows groups the taskbar button under Electron and shows
// Electron's icon there instead of ours. The shortcuts tools/install-shortcut.ps1
// writes carry the same id — the taskbar only ties a running window to a
// shortcut when both agree, and without the pairing the button stays a loose
// "Electron" entry that pins as electron.exe.
app.setAppUserModelId('com.jameshangar.hangar');

// macOS puts the app name in the menu bar and in the About item, and takes it
// from package.json otherwise — a lower-case "hangar". Only set there, because
// the name is also what userData is named after: renaming it on Windows would
// orphan the config.json that is already sitting in %APPDATA%\hangar.
if (process.platform === 'darwin') app.setName('Hangar');

// Settings first: the window's very first IPC call asks for them, and the
// projects root decides what the sidebar is a listing of.
app.whenReady().then(() => {
  // The window's `icon:` is ignored on macOS, and the .ico beside it is not a
  // format the Dock reads, so the Dock is set from a png here or it shows
  // Electron's own icon. The pngs are rasterised by `npm run icon` rather than
  // committed, so a clone that has not run it simply keeps the stock icon.
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = path.join(__dirname, 'assets', 'icon-256.png');
    try {
      if (fs.existsSync(dockIcon)) app.dock.setIcon(dockIcon);
    } catch { /* cosmetic, never worth failing a launch over */ }
  }

  applyConfig(loadConfig());
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ------------------------------------------------------------------ projects

function projectsRoot() {
  return config.projectsRoot;
}

ipcMain.handle('projects:list', () => {
  const root = projectsRoot();
  // The skip list travels with the listing so the new-project modal can say
  // why a name it would have filtered out is refused, without keeping its own
  // copy of it.
  return { root, projects: listProjects(root), ignored: [...PROJECT_IGNORE] };
});

/**
 * Create an empty project folder and hand back the refreshed listing.
 *
 * Validated again here rather than trusting the modal: this is the side that
 * actually makes the folder. Failures come back as a message to show under the
 * field, since none of them are exceptional enough to throw across the bridge.
 */
ipcMain.handle('projects:create', (_event, { name }) => {
  const root = path.resolve(projectsRoot());
  const check = validateProjectName(name, {
    existing: listProjects(root).map((p) => p.name),
    ignored: [...PROJECT_IGNORE],
  });
  if (!check.ok) return { ok: false, message: check.message };

  const dir = path.resolve(root, check.name);
  // Belt and braces. The name rules already bar separators and `..`, but a
  // folder is about to be created from something typed into a text field, so
  // anything that did not land directly inside the projects root is refused.
  if (path.dirname(dir) !== root) {
    return { ok: false, message: 'That name would not sit inside the projects folder.' };
  }

  try {
    fs.mkdirSync(dir);   // not recursive: EEXIST is an answer worth reporting
  } catch (err) {
    if (err.code === 'EEXIST') return { ok: false, message: 'There is already a folder with that name.' };
    return { ok: false, message: `Could not create the folder: ${err.message}` };
  }

  return { ok: true, project: { name: check.name, path: dir }, projects: listProjects(root) };
});

// ------------------------------------------------------------------- backups

// Refused here rather than only in the renderer: this is the side that runs the
// copy, and backups being off has to mean nothing copies whatever asked.
ipcMain.handle('backup:run', (_event, { projectPath }) => {
  if (!config.backupEnabled) return { ok: false, message: 'backups are turned off' };
  return mirror(projectPath, { root: config.backupRoot });
});

ipcMain.handle('backup:root', () => (config.backupEnabled ? config.backupRoot : null));

// ------------------------------------------------------------------- config

/**
 * Everything the setup screen needs to draw itself: what is in force now,
 * whether it has ever been answered, and what to suggest if it has not.
 */
ipcMain.handle('config:get', () => ({
  configured: saved !== null,
  config,
  suggested: suggestions(__dirname),
  env: envOverrides(),
}));

ipcMain.handle('config:save', (_event, input) => {
  const check = validateConfig(input);
  if (!check.ok) return { ok: false, field: check.field, message: check.message };

  try {
    return { ok: true, config: saveConfig(check.config) };
  } catch (err) {
    return { ok: false, field: null, message: `Could not save settings: ${err.message}` };
  }
});

// A folder picker, because typing a Windows path by hand is exactly the thing
// the setup screen exists to avoid.
ipcMain.handle('config:pick', async (_event, { title, defaultPath }) => {
  const res = await dialog.showOpenDialog(win, {
    title: title || 'Choose a folder',
    defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

// Used by the setup screen's "show me" links, so someone unsure what a path
// means can go and look at it.
ipcMain.handle('config:reveal', (_event, { target }) => {
  if (target && fs.existsSync(target)) electronShell.openPath(target);
});

// --------------------------------------------------------------------- usage

// Kept on this side of the bridge because reading it means reading the Claude
// Code credentials file. The renderer is handed two percentages and a reset
// time; the token never leaves this process.
const usage = createUsageReader();

ipcMain.handle('usage:get', () => usage.get());

// Every project, not only the ones worked on in this session: the point of the
// backup is that the whole projects folder survives the machine, and plenty of
// editing happens in Cursor rather than in here. Detached, so closing the
// window stays instant however much is left to copy.
let quitSweepStarted = false;
app.on('before-quit', () => {
  if (quitSweepStarted) return;
  quitSweepStarted = true;
  // config is null if we are quitting before ever becoming ready.
  if (!config || !config.backupEnabled) return;
  sweepDetached(listProjects(projectsRoot()).map((p) => p.path), { root: config.backupRoot });
});

// ---------------------------------------------------------------- pty bridge

/**
 * Every terminal here is a fresh top-level session. If Hangar itself was
 * launched from inside a Claude Code session, the inherited child-session
 * marker makes each new `claude` think it is nested and silently turn
 * transcript saving off.
 */
function childEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete env.CLAUDE_CODE_CHILD_SESSION;
  return env;
}

ipcMain.handle('pty:create', (_event, { id, cwd, command, cols, rows }) => {
  const shell = defaultShell();
  const startDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

  const proc = pty.spawn(shell.file, argsFor(shell, command), {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: startDir,
    env: childEnv(),
    useConpty: process.platform === 'win32',
    // The newer ConPTY bundled with node-pty rather than the one in Windows.
    // The in-box one on Windows 10 swallows the alternate screen buffer, so a
    // full-screen TUI like `claude` paints straight over the normal buffer and
    // destroys the screenful of scrollback that was already there. Passing the
    // alt screen through means the TUI gets its own buffer and everything
    // printed before it comes back untouched when it exits.
    useConptyDll: process.platform === 'win32',
  });

  sessions.set(id, { proc, paused: false });

  proc.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data });
  });

  proc.onExit(({ exitCode }) => {
    sessions.delete(id);
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id, exitCode });
  });

  return { pid: proc.pid, shell: path.basename(shell.file), cwd: startDir };
});

ipcMain.on('pty:write', (_event, { id, data }) => {
  const s = sessions.get(id);
  if (s) s.proc.write(data);
});

ipcMain.on('pty:resize', (_event, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (!s) return;
  try { s.proc.resize(Math.max(cols, 1), Math.max(rows, 1)); } catch { /* racing a dying pty */ }
});

// Flow control. When the renderer falls behind on a burst of output (a test
// suite dumping thousands of lines) we stop reading from the pty rather than
// letting the buffer overflow and drop characters.
ipcMain.on('pty:flow', (_event, { id, pause }) => {
  const s = sessions.get(id);
  if (!s || s.paused === pause) return;
  s.paused = pause;
  if (pause) s.proc.pause(); else s.proc.resume();
});

ipcMain.on('pty:kill', (_event, { id }) => {
  const s = sessions.get(id);
  if (!s) return;
  try { s.proc.kill(); } catch { /* already gone */ }
  sessions.delete(id);
});

ipcMain.on('win:fullscreen', () => {
  if (win) win.setFullScreen(!win.isFullScreen());
});
