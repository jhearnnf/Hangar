'use strict';

const {
  app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, dialog, shell: electronShell,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const pty = require('node-pty');
const { defaultShell, argsFor, listProjects, PROJECT_IGNORE } = require('./shell');
const { validateProjectName } = require('./project-name');
const { checkProjectDelete } = require('./project-delete');
const { checkProjectRename } = require('./project-rename');
const { parseState, restoreState, MIN_SIZE } = require('./window-state');
const { mirror, sweepDetached } = require('./backup');
const { createUsageReader } = require('./usage');
const { createMonitor, createSystemReader } = require('./processes');
const { createSessions } = require('./sessions');
const { recentFor } = require('./transcripts');
const { recentFor: recentCodexFor } = require('./codex-sessions');
const { createDevices, DEVICES_FILE } = require('./devices');
const { createServer } = require('./server');
const { lanAddresses, startResponder, DISCOVERY_PORT } = require('./discovery');
const firewall = require('./firewall');
const { loginItem, startedHidden } = require('./startup');
const {
  CONFIG_FILE, suggestions, parseConfig, resolveConfig, validateConfig,
} = require('./config');
const Agents = require('./agents');

let win = null;

/**
 * One Hangar at a time.
 *
 * There was no way to end up with two before: you launched it yourself, and a
 * second one was only ever a mistake you could see. Now Windows launches it at
 * login as well, so a double-click half an hour later would be a second copy
 * fighting the first for the port — and losing, silently. The second copy hands
 * its launch to the first, which shows itself, which is what the click meant.
 */
const onlyInstance = app.requestSingleInstanceLock();
if (!onlyInstance) app.quit();

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
});

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
  const applied = applyConfig(next);

  // Three of these settings are about the world outside this window — a
  // startup entry, a listening port, an icon by the clock — and all three take
  // effect on Save rather than on the next launch. A settings screen that
  // needed a restart to mean anything would be a settings screen nobody
  // believed.
  applyStartup(applied);
  applyRemote(applied);
  applyTray(applied);
  // A phone already connected is holding the old answer to "what does the +
  // button run", and would go on opening the other agent until it happened to
  // reconnect. The window is told by the reply to this call; the phones are
  // told here.
  server.broadcastInfo();
  return applied;
}

// Which fields the environment has taken over, so the setup screen can show
// them as locked rather than letting someone edit a value that will not win.
function envOverrides(env = process.env) {
  return {
    projectsRoot: Boolean(env.HANGAR_PROJECTS_ROOT),
    backupRoot: Boolean(env.HANGAR_BACKUP_ROOT),
    remotePort: Boolean(env.HANGAR_REMOTE_PORT),
    agent: Boolean(env.HANGAR_AGENT),
  };
}

// ------------------------------------------------------- start with Windows

/**
 * Put Hangar in — or take it out of — the per-user startup list.
 *
 * Called on save and once at launch. The second one matters: an entry that
 * points at a checkout which has since moved is an entry that fails silently
 * every morning, and rewriting it each launch is a one-line way never to have
 * to think about that.
 */
function applyStartup(current) {
  if (process.platform === 'linux') return;   // no login-item API there

  try {
    // No `packaged:` here on purpose — `app.isPackaged` only means "the exe is
    // not called electron.exe", which is true of the icon-stamped copy too.
    // startup.js works it out from where the app sits relative to the exe.
    const item = loginItem({
      execPath: process.execPath,
      appPath: app.getAppPath(),
      hidden: current.startMinimised,
    });
    app.setLoginItemSettings({ openAtLogin: current.autoStart, path: item.path, args: item.args });
  } catch (err) {
    console.error('Hangar: could not update the startup entry', err);
  }
}

// ------------------------------------------------------------------- tray

let tray = null;

/**
 * The icon by the clock, which exists for exactly one reason: something has to
 * be clickable when there is no window.
 *
 * So it appears with "start minimised" and not otherwise. Turning that on also
 * changes what closing the window means — hide rather than quit — because a
 * Hangar that vanished when you closed its window would take every running
 * terminal and the phone's connection with it, which is the opposite of what
 * someone asking for a tray icon wants.
 */
function applyTray(current) {
  if (current.startMinimised) {
    if (!tray) createTray();
    paintTray();
    return;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function createTray() {
  const file = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon-32.png');
  let image;
  try {
    image = nativeImage.createFromPath(file);
  } catch {
    image = nativeImage.createEmpty();
  }

  tray = new Tray(image);
  tray.setToolTip('Hangar');
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function paintTray() {
  if (!tray) return;

  const running = sessions.count();
  const phone = server && server.running()
    ? `Phones can connect on port ${server.port()}`
    : 'Phone access is off';

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Hangar', click: showWindow },
    { type: 'separator' },
    { label: running === 1 ? '1 terminal running' : `${running} terminals running`, enabled: false },
    { label: phone, enabled: false },
    { type: 'separator' },
    { label: 'Quit Hangar', click: () => app.quit() },
  ]));

  tray.setToolTip(running ? `Hangar — ${running} terminal${running === 1 ? '' : 's'}` : 'Hangar');
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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
    // Launched by Windows at login with "start minimised" ticked: the window is
    // built, the renderer runs, the server is up — there is simply nothing on
    // screen until the tray icon is clicked. Only that launch passes the flag,
    // so opening Hangar yourself always shows you a window.
    if (!hiddenLaunch) win.show();
    hiddenLaunch = false;
  });

  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(event, saveStateSoon);
  }

  // 'close' still has a live window to measure; 'closed' does not.
  win.on('close', (event) => {
    clearTimeout(saveTimer);
    saveState();

    // With a tray icon there is somewhere to come back from, so closing the
    // window puts Hangar down rather than ending it: the terminals keep
    // running and the phone keeps its connection. Quit from the tray menu, or
    // untick the setting, to get the old behaviour back.
    if (!quitting && config && config.startMinimised) {
      event.preventDefault();
      win.hide();
    }

    // Whether this is a hide or the end of the window, the panel that asked for
    // the sampler has gone and nothing is reading it. It costs a walk of every
    // process on the machine every two seconds, which is not a thing to leave
    // running behind a tray icon; opening the panel again starts it again.
    monitor.stop();
  });

  win.on('closed', () => {
    win = null;
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

// Set once, at the top of the process, because the flag says something about
// *this* launch that is no longer true a moment later.
let hiddenLaunch = startedHidden();
let quitting = false;

app.on('before-quit', () => { quitting = true; });

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

  const current = applyConfig(loadConfig());

  // A hidden launch only makes sense while the setting that asks for one is
  // still on. The flag is written into the startup entry, and an entry can
  // outlive the tick box that wrote it — after an unclean shutdown, or if the
  // config was rolled back — so both have to agree before a launch shows
  // nothing.
  hiddenLaunch = hiddenLaunch && current.startMinimised;

  applyStartup(current);
  applyTray(current);
  applyRemote(current);
  createWindow();
});

app.on('window-all-closed', () => {
  // With the tray on, closing the window is not the end of Hangar and this
  // never fires — but a window that fails to build, or a platform that
  // destroys it anyway, would otherwise leave a process with no way back.
  if (!config || !config.startMinimised) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else showWindow();
});

// ------------------------------------------------------------------ projects

function projectsRoot() {
  return config.projectsRoot;
}

// The skip list travels with the listing so the new-project modal can say why
// a name it would have filtered out is refused, without keeping its own copy
// of it. `projectListing()` is defined further down, beside the server, since
// both sides ask for exactly this.
ipcMain.handle('projects:list', () => projectListing());

/**
 * Create an empty project folder and hand back the refreshed listing.
 *
 * Validated here rather than trusting whoever asked: this is the side that
 * actually makes the folder, and there are two callers now — the modal in the
 * window and a phone. Failures come back as a message to show under the field,
 * since none of them are exceptional enough to throw.
 */
function makeProject(name) {
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
}

ipcMain.handle('projects:create', (_event, { name }) => {
  const result = makeProject(name);
  // A folder that appeared on this machine is news to every phone looking at
  // the same folder, whichever side asked for it.
  if (result.ok) server.broadcastProjects();
  return result;
});

/** How many of Hangar's terminals are open in a folder. */
function terminalsIn(dir) {
  const wanted = path.resolve(dir);
  return sessions.list().filter((s) => path.resolve(s.projectPath) === wanted).length;
}

/**
 * Delete a project folder — to the recycle bin, not off the disk.
 *
 * The window asks for this behind a dialog that makes you type the word, and
 * every one of those checks is re-run here: the renderer is where the path
 * came from, and this is the side that can actually remove a directory tree.
 *
 * `shell.trashItem` rather than `fs.rm` because it is the only version of this
 * that can be taken back. A machine where it fails — a network share, a Linux
 * without a trash implementation — gets the error and keeps its folder; the
 * dialog said the recycle bin, so quietly deleting for good instead would be
 * the one outcome nobody agreed to.
 *
 * The offer is deliberately not extended to whatever `robocopy` mirrored into
 * the backup folder. That copy is the point of having it.
 */
async function removeProject(target) {
  const check = checkProjectDelete(target, {
    root: path.resolve(projectsRoot()),
    appDir: __dirname,
    busy: terminalsIn(target),
  });
  if (!check.ok) return check;

  let stat;
  try {
    stat = fs.statSync(check.path);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, message: 'That folder is not there any more.' };
    return { ok: false, message: `Could not read the folder: ${err.message}` };
  }
  if (!stat.isDirectory()) return { ok: false, message: 'That is a file, not a project folder.' };

  try {
    await electronShell.trashItem(check.path);
  } catch (err) {
    return { ok: false, message: `Could not move it to the recycle bin: ${err.message}` };
  }

  return { ok: true, project: { name: check.name, path: check.path }, ...projectListing() };
}

ipcMain.handle('projects:delete', async (_event, { projectPath }) => {
  const result = await removeProject(projectPath);
  // Same as creating one: a phone looking at the same folder is now looking at
  // a project that is gone.
  if (result.ok) server.broadcastProjects();
  return result;
});

// A rename that only changes case points at the same folder on a filesystem
// that does not care about case, so "there is already one of those" would be
// the folder itself. Everywhere else two names differing only in case really
// are two folders, and one of them is not to be moved over.
const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Give a project folder a different name.
 *
 * Nothing else moves with it. Hangar's own bookkeeping is all keyed by path —
 * the terminals, the backup countdowns, claude's record of what has been asked
 * in this folder — which is why the rename is refused while a terminal is open
 * and why the dialog says what stops matching afterwards. The alternative is
 * rewriting other programs' files on the strength of a text field, which is not
 * an offer Hangar is in a position to make.
 *
 * `fs.renameSync` rather than a copy and a delete: it is one operation the
 * filesystem either does or refuses, so a folder can never end up half moved.
 */
function renameProject(target, name) {
  const root = path.resolve(projectsRoot());
  const check = checkProjectRename(target, name, {
    root,
    appDir: __dirname,
    busy: terminalsIn(target),
    existing: listProjects(root).map((p) => p.name),
    ignored: [...PROJECT_IGNORE],
  });
  if (!check.ok) return check;

  let stat;
  try {
    stat = fs.statSync(check.from);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, message: 'That folder is not there any more.' };
    return { ok: false, message: `Could not read the folder: ${err.message}` };
  }
  if (!stat.isDirectory()) return { ok: false, message: 'That is a file, not a project folder.' };

  // The listing the name was checked against skips hidden folders and
  // node_modules, so a clash with one of those would otherwise be found out
  // about by `rename` — or, on a bad day, not found out about at all.
  const caseOnly = CASE_BLIND && check.to.toLowerCase() === check.from.toLowerCase();
  if (!caseOnly && fs.existsSync(check.to)) {
    return { ok: false, message: 'There is already a folder with that name.' };
  }

  try {
    fs.renameSync(check.from, check.to);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') {
      return { ok: false, message: 'There is already a folder with that name.' };
    }
    if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY') {
      // Almost always something holding the folder open — an editor, a shell
      // outside Hangar, a virus scanner mid-file.
      return { ok: false, message: `Something has the folder open, so it could not be renamed: ${err.message}` };
    }
    return { ok: false, message: `Could not rename the folder: ${err.message}` };
  }

  return {
    ok: true,
    project: { name: check.name, path: check.to },
    was: { name: check.was, path: check.from },
    ...projectListing(),
  };
}

ipcMain.handle('projects:rename', (_event, { projectPath, name }) => {
  const result = renameProject(projectPath, name);
  // A project that changed its name is news to every phone looking at the same
  // folder, exactly as one appearing or going away is.
  if (result.ok) server.broadcastProjects();
  return result;
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

/** The chosen agent, in the shape the phone draws and runs with. */
function agentSummary() {
  const { id, label, command } = Agents.get(config && config.agent);
  return { id, label, command };
}

/**
 * The bars, or nothing at all.
 *
 * They are Claude Code's own numbers off Anthropic's endpoint, and there is no
 * equivalent to read for another agent. So with one of those selected the
 * endpoint is not asked — not asked rather than asked and ignored, since the
 * token it would be asked with is not ours to spend on a question nobody is
 * looking at — and the sidebar hides the bars exactly as it does on a machine
 * where Claude Code has never been signed in.
 */
function currentUsage() {
  return Agents.get(config && config.agent).usage ? usage.get() : { available: false };
}

ipcMain.handle('usage:get', () => currentUsage());

// Every project, not only the ones worked on in this session: the point of the
// backup is that the whole projects folder survives the machine, and plenty of
// editing happens in Cursor rather than in here. Detached, so closing the
// window stays instant however much is left to copy.
let quitSweepStarted = false;
app.on('before-quit', () => {
  if (quitSweepStarted) return;
  quitSweepStarted = true;

  // The terminals used to die with the window because they belonged to it.
  // They belong to this process now and outlive a closed window on purpose, so
  // the quit is where they end — before the sweep below, so the copy it makes
  // is of a folder nothing is still writing to.
  sessions.killAll();
  // The sampler is a child of ours like any other, and one left behind would be
  // a PowerShell looping over every process on the machine with nobody reading
  // it. Harmless only until the next launch starts a second.
  monitor.stop();
  if (responder) { responder.close(); responder = null; }
  server.dispose();
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

/**
 * Start one shell, for whoever asked.
 *
 * This is the only thing in the app that knows how to make a pty, and it is
 * handed to the session registry rather than called from anywhere: the window
 * and the phone both go through the registry, so neither can start a terminal
 * the other does not know about.
 */
function spawnSession({ cwd, command, cols, rows }) {
  const shell = defaultShell();
  const startDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const args = argsFor(shell, command);

  // What is thrown here ends up on someone's screen, and "spawn ENOENT" on its
  // own is not something anyone can act on. The shell it tried, the arguments
  // it tried them with and the directory it tried them in are the three things
  // that actually name the problem.
  let proc;
  try {
    proc = spawnPty(shell, args, { cols, rows, cwd: startDir });
  } catch (err) {
    throw new Error(
      `${err.message}${spawnHelperHint()}\n\n${shell.file} ${args.join(' ')}\nin ${startDir}`);
  }

  return { proc, shell: path.basename(shell.file), cwd: startDir, args };
}

const sessions = createSessions({ spawn: spawnSession });

function toWindow(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// The window is a viewer like any other. It gets the raw output, and it gets
// told when a terminal appears, is renamed, changes stage or goes — including
// the ones a phone opened, which is how they show up in the sidebar without
// the sidebar knowing anything about phones.
// The sequence number rides along so a window rebuilding itself around a
// terminal that was already running can tell which of the chunks arriving live
// are ones the replayed history already covered.
sessions.on('data', ({ id, seq, data }) => toWindow('pty:data', { id, seq, data }));
sessions.on('exit', (payload) => toWindow('pty:exit', payload));

// A terminal going quiet is not always a change of stage — most of the time it
// was already resting — but it is always the moment a backup countdown can be
// armed, so it is said out loud rather than inferred from a stage event that
// may never come.
sessions.on('idle', ({ projectPath }) => toWindow('session:idle', { projectPath }));
sessions.on('session', (payload) => {
  toWindow('session:event', payload);
  paintTray();
});

// --------------------------------------------------------------- resources

/**
 * The line above the usage bars, and the panel behind it.
 *
 * Two different costs, kept apart on purpose. The line is `os.cpus()` — ticks
 * the kernel already has, no child process, no platform branch — so it can run
 * whenever the window is up. The panel walks every process on the machine and
 * pairs each one with the terminal that started it, which is worth doing only
 * while somebody has it open, so it starts and stops with the panel.
 */
const system = createSystemReader();
const monitor = createMonitor({
  log: (line) => { if (process.env.HANGAR_DEBUG) console.log(`[processes] ${line}`); },
});

// The panel is about Hangar's terminals rather than about the machine, so the
// walk asks for the session list as it builds each view. A terminal opened a
// second ago is in the next tick, and one that has gone takes its jobs with it,
// without anything here subscribing to anything.
monitor.useSessions(() => sessions.list());
monitor.on((view) => toWindow('processes:view', view));

ipcMain.handle('system:stats', () => system.read());

ipcMain.handle('processes:start', () => ({
  ok: monitor.start(),
  gpuAvailable: monitor.gpuAvailable(),
}));

ipcMain.handle('processes:stop', () => { monitor.stop(); return null; });

// Off unless asked for, and that is a measurement rather than caution: the GPU
// engine counter takes seconds to answer. See the note in `processes.js`.
ipcMain.handle('processes:gpu', (_event, { on }) => monitor.setGpu(on));

ipcMain.handle('pty:create', (_event, { cwd, projectName, command, cols, rows }) => (
  // The id comes back from here rather than going in: two screens can both ask
  // for a terminal, and only the one place that keeps the list can promise the
  // name is not already taken.
  sessions.create({ projectPath: cwd, projectName, command, cols, rows })
));

ipcMain.handle('sessions:list', () => sessions.list());

// Everything a viewer missed. The window asks for this when it is rebuilt
// around terminals that were already running.
ipcMain.handle('sessions:history', (_event, { id, seq }) => sessions.history(id, seq));

/**
 * The sessions a project has had with whichever agent is selected — the
 * sidebar's right-click menu, and the same list behind a long press on the
 * phone.
 *
 * Read on the press rather than watched: it is a bounded handful of files, and
 * a list that is a few milliseconds old at the moment it is drawn is as fresh
 * as a list can usefully be.
 */
function recentSessions(projectPath) {
  const agent = Agents.get(config && config.agent);
  try {
    return agent.id === 'codex' ? recentCodexFor(projectPath) : recentFor(projectPath);
  } catch (err) {
    // Each agent owns its own files and is free to change any of them. An empty
    // menu is a fine way to say so; a broken sidebar is not.
    console.error(`Hangar: could not read ${agent.label} history`, err);
    return [];
  }
}

ipcMain.handle('sessions:recent', (_event, { projectPath }) => recentSessions(projectPath));

/**
 * The one thing "posix_spawnp failed." is nearly always about.
 *
 * node-pty spawns every macOS pty through a helper binary rather than the shell
 * directly, and the npm tarball records that helper as 0644 — so a fresh
 * install has one that cannot be executed, and every failure inside that
 * function comes back as the same bare string with no errno and no path in it.
 * tools/fix-spawn-helper.js puts the bit back at install time; this is for the
 * tree where that did not run, since the message alone leads nowhere.
 */
function spawnHelperHint() {
  if (process.platform !== 'darwin') return '';

  try {
    const root = path.dirname(path.dirname(require.resolve('node-pty')));
    for (const helper of [
      path.join(root, 'build', 'Release', 'spawn-helper'),
      path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ]) {
      if (!fs.existsSync(helper)) continue;
      if (fs.statSync(helper).mode & 0o111) return '';
      return `\n\nnode-pty's spawn-helper is not executable, which is what fails:\n`
        + `  chmod +x ${helper}`;
    }
  } catch { /* a guess that cannot be made is simply not offered */ }

  return '';
}

function spawnPty(shell, args, { cols, rows, cwd }) {
  return pty.spawn(shell.file, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
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
}

ipcMain.on('pty:write', (_event, { id, data }) => sessions.write(id, data));

// 'desktop' is the window's name as a size owner. A terminal a phone has taken
// the width of ignores this until the phone gives it back.
ipcMain.on('pty:resize', (_event, { id, cols, rows }) => sessions.resize(id, cols, rows, 'desktop'));

/**
 * Take the width back for the window.
 *
 * A phone that has reflowed a terminal to its own screen keeps it that way
 * until it says otherwise, which is right while you are holding the phone and
 * wrong the moment you sit back down: the window would go on painting into a
 * phone-shaped corner of itself with no way to say so. Sitting down and looking
 * at it is the signal, so activating a tab or focusing the window claims it.
 */
ipcMain.on('pty:claim', (_event, { id, cols, rows }) => sessions.claimSize(id, 'desktop', cols, rows));

// Flow control. When the renderer falls behind on a burst of output (a test
// suite dumping thousands of lines) we stop reading from the pty rather than
// letting the buffer overflow and drop characters.
ipcMain.on('pty:flow', (_event, { id, pause }) => sessions.flow(id, pause));

ipcMain.on('pty:kill', (_event, { id }) => sessions.kill(id));

ipcMain.on('win:fullscreen', () => {
  if (win) win.setFullScreen(!win.isFullScreen());
});

// ------------------------------------------------------------ phone access

const devices = createDevices({
  load: () => JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), DEVICES_FILE), 'utf8')),
  save: (list) => {
    const file = path.join(app.getPath('userData'), DEVICES_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  },
});

function projectListing() {
  const root = projectsRoot();
  return { root, projects: listProjects(root), ignored: [...PROJECT_IGNORE] };
}

const server = createServer({
  sessions,
  devices,
  listProjects: projectListing,
  createProject: (name) => {
    const result = makeProject(name);
    if (result.ok) toWindow('projects:changed');
    return result;
  },
  usage: () => currentUsage(),
  recentSessions,
  backup: (projectPath) => (
    config.backupEnabled
      ? mirror(projectPath, { root: config.backupRoot })
      : { ok: false, message: 'backups are turned off' }
  ),
  info: () => ({
    app: 'Hangar',
    name: os.hostname(),
    version: app.getVersion(),
    platform: process.platform,
    backupsOn: Boolean(config && config.backupEnabled),
    // Which agent the phone's row tap and + sheet should offer, so it names
    // and runs the same one this window does. The three fields it needs rather
    // than an id: the phone is served out of mobile/www and the agent table is
    // not, so an id would only be something for it to look up in a second copy
    // of the table.
    agent: agentSummary(),
  }),
  // Handy rather than necessary: pointing a phone browser at the same port is
  // the fastest way to find out whether the PC half of this is working, and it
  // is the same client the app runs.
  wwwDir: fs.existsSync(path.join(__dirname, 'mobile', 'www'))
    ? path.join(__dirname, 'mobile', 'www')
    : null,
  log: (line) => { if (process.env.HANGAR_DEBUG) console.log(`[server] ${line}`); },
});

let responder = null;

/**
 * Bring the server up, down, or across to a different port, to match what
 * Settings now says.
 *
 * A port that will not bind is reported back through the same channel the
 * Settings screen is watching rather than thrown: the usual reason is another
 * Hangar, or something else on 7433, and neither is a crash.
 */
let remoteError = null;

async function applyRemote(current) {
  const wanted = Boolean(current.remoteEnabled);
  const port = current.remotePort;

  if (!wanted) {
    server.stop();
    if (responder) { responder.close(); responder = null; }
    remoteError = null;
    paintTray();
    toWindow('remote:changed');
    return;
  }

  if (server.running() && server.port() === port) return;

  server.stop();
  if (responder) { responder.close(); responder = null; }

  try {
    await server.start(port);
    remoteError = null;
    responder = startResponder({
      describe: () => ({
        app: 'Hangar',
        name: os.hostname(),
        port: server.port(),
        version: app.getVersion(),
      }),
      onError: (err) => {
        // Only discovery is lost here — a phone can still be given the address
        // by hand, so this is a note rather than a failure.
        if (process.env.HANGAR_DEBUG) console.error('[discovery]', err.message);
      },
    });
  } catch (err) {
    remoteError = err.code === 'EADDRINUSE'
      ? `Port ${port} is already being used by something else. Try another one.`
      : err.message;
  }

  paintTray();
  toWindow('remote:changed');
}

ipcMain.handle('remote:status', async () => ({
  enabled: Boolean(config && config.remoteEnabled),
  running: server.running(),
  port: server.port() || (config && config.remotePort),
  error: remoteError,
  addresses: lanAddresses(),
  devices: devices.list(),
  connected: server.clients(),
  code: devices.currentCode(),
  // The one thing that can be perfectly configured here and still not work.
  firewall: await firewall.check({
    execPath: process.execPath,
    port: (config && config.remotePort) || 7433,
  }),
}));

/**
 * Let Windows Firewall through to the port, with the user's consent.
 *
 * Rules need administrator, so this is a UAC prompt and nothing at all if it is
 * declined. The script it runs is in `firewall.js` and is narrower than the
 * permission Windows itself would have granted: two ports, local subnet only.
 */
ipcMain.handle('remote:fixFirewall', () => new Promise((resolve) => {
  if (process.platform !== 'win32') return resolve({ ok: false, message: 'Windows only.' });

  // Only where this machine actually has a mesh VPN on it. Allowing that range
  // on a machine with no VPN would be widening the rule for a route that does
  // not exist, which is the sort of thing a firewall rule should never do.
  const hasMesh = lanAddresses().some((a) => a.kind === 'overlay');

  const script = firewall.fixScript({
    execPath: process.execPath,
    port: config.remotePort,
    discoveryPort: DISCOVERY_PORT,
    meshRanges: hasMesh ? [firewall.MESH_RANGE] : [],
  });

  // Base64 so nothing in the script has to survive two rounds of quoting on the
  // way through Start-Process.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  execFile('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden`
    + ` -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`,
  ], { windowsHide: true }, async (err) => {
    if (err) {
      // Cancelling the UAC prompt lands here, and is not an error worth
      // dressing up as one.
      resolve({ ok: false, message: 'Windows did not allow the change. Nothing was altered.' });
      return;
    }
    resolve({ ok: true, firewall: await firewall.check({ execPath: process.execPath }) });
  });
}));

// A fresh code every time the panel is opened, which is also how you cancel one
// you did not mean to put on the screen.
ipcMain.handle('remote:code', () => devices.newCode());
ipcMain.handle('remote:cancelCode', () => { devices.clearCode(); return null; });
ipcMain.handle('remote:forget', (_event, { id }) => {
  devices.forget(id);
  return devices.list();
});
