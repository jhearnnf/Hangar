'use strict';

/* global Terminal, FitAddon, WebglAddon, SearchAddon, WebLinksAddon, Unicode11Addon, Classify, ProjectName */

const api = window.hangar;
const $ = (id) => document.getElementById(id);

const sidebar = $('sidebar');
const projectlist = $('projectlist');
const tabbar = $('tabbar');
const tablist = $('tablist');
const panes = $('panes');
const emptyState = $('empty');
const findBar = $('find');
const findInput = $('findinput');

const tabs = new Map();
let order = [];          // tab ids, in creation order
let activeId = null;
let projects = [];
let projectsRoot = '';   // the folder new projects are created in
let ignoredNames = [];   // folder names the sidebar never lists

// Every terminal dies with the window, so a project restored open would only
// ever be an empty list. Launch collapsed and let opening a terminal expand it.
let expanded = new Set();
let sidebarOpen = localStorage.getItem('sidebarOpen') !== '0';
let zen = false;
let fontSize = Number(localStorage.getItem('fontSize')) || 14;

const DEFAULT_COMMAND = 'claude';

// Silence for this long means a terminal has finished whatever it was doing —
// which is now decided in the main process, since the phone has to agree with
// this window about it. Named here because the backup countdown below is
// explained in terms of it.
const IDLE_MS = 3000;

// Pause the pty once this many bytes are queued but unpainted, resume when the
// backlog drains, so a burst of output can never overrun the buffer.
const HIGH_WATER = 250_000;
const LOW_WATER = 25_000;

const THEME = {
  background: '#12141a',
  foreground: '#c9d1d9',
  cursor: '#4d9cf6',
  cursorAccent: '#12141a',
  selectionBackground: '#2d4b6e',
  black: '#12141a',
  red: '#f47067',
  green: '#57ab5a',
  yellow: '#c69026',
  blue: '#539bf5',
  magenta: '#b083f0',
  cyan: '#39c5cf',
  white: '#adbac7',
  brightBlack: '#545d68',
  brightRed: '#ff938a',
  brightGreen: '#6bc46d',
  brightYellow: '#daaa3f',
  brightBlue: '#6cb6ff',
  brightMagenta: '#dcbdfb',
  brightCyan: '#56d4dd',
  brightWhite: '#e6edf3',
};

// ------------------------------------------------------------------ chrome

function syncChrome() {
  sidebar.hidden = zen || !sidebarOpen;
  // The sidebar already lists every terminal, so showing the tab strip at the
  // same time would just say it twice.
  tabbar.hidden = zen || sidebarOpen;
  requestAnimationFrame(() => refit(tabs.get(activeId)));
}

function toggleSidebar() {
  zen = false;
  sidebarOpen = !sidebarOpen;
  localStorage.setItem('sidebarOpen', sidebarOpen ? '1' : '0');
  syncChrome();
}

function updateEmpty() {
  emptyState.hidden = order.length > 0;
}

// ----------------------------------------------------------------- sidebar

function toggleProject(projectPath) {
  if (expanded.has(projectPath)) expanded.delete(projectPath);
  else expanded.add(projectPath);
  renderSidebar();
}

function terminalsIn(projectPath) {
  return order.map((id) => tabs.get(id)).filter((t) => t && t.projectPath === projectPath);
}

// Work moves through these in order, so a project wearing the earliest stage
// any of its terminals is in means the colour always reports the least
// finished thing under it — red until nothing is planning, green only when
// everything is done.
const STAGES = ['planning', 'implementing', 'testing', 'ready'];

const projectRows = new Map();   // project path -> its row element

/** Colour a project's name after its most unfinished terminal. */
function paintProjectRow(projectPath) {
  const row = projectRows.get(projectPath);
  if (!row) return;
  const states = terminalsIn(projectPath).map((t) => t.state);
  const stage = STAGES.find((s) => states.includes(s));
  const sync = syncIcon(projectPath);
  // No terminals, no claim to make: the name stays the default grey.
  row.className = 'project-row'
    + (stage ? ' state-' + stage : '')
    + (sync ? ' backup-' + sync : '');

  const badge = row.querySelector('.bsync');
  // Rebuilding the icon costs more than the class swap above, and this runs on
  // every line a terminal prints, so the markup is only touched on a change.
  if (badge.dataset.icon !== (sync || '')) {
    badge.dataset.icon = sync || '';
    badge.innerHTML = sync ? SYNC_ICONS[sync] : '';
  }
  badge.title = sync ? BACKUP_LABELS[sync] : '';
}

function paintProject(projectPath) {
  const states = terminalsIn(projectPath).map((t) => t.state);
  scheduleBackup(projectPath, STAGES.find((s) => states.includes(s)));
  paintProjectRow(projectPath);
}

// ------------------------------------------- recent claude sessions

/**
 * Right-clicking a project lists the claude sessions it has had, so one can be
 * picked up where it was left.
 *
 * These are not Hangar's terminals — Hangar's are the rows under the twisty,
 * and they are all still running. These are claude's own, read out of the files
 * it keeps in ~/.claude, and every one of them is a conversation that has
 * already ended. Picking one runs `claude --resume` in a fresh terminal here.
 */

const projectMenu = $('projectmenu');
const projectMenuHead = $('projectmenuhead');
const projectMenuList = $('projectmenulist');

// Bumped on every open and every close, so a read that comes back after the
// menu was dismissed — or reopened on a different project — knows to say
// nothing rather than draw a list nobody asked for any more.
let menuToken = 0;

function menuOpen() {
  return !projectMenu.hidden;
}

function closeProjectMenu() {
  menuToken++;
  if (projectMenu.hidden) return;
  projectMenu.hidden = true;
  projectMenuList.textContent = '';
}

/** How long ago, at the granularity someone actually thinks in. */
function ago(at) {
  const secs = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (secs < 90) return 'just now';

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function menuRow(project, row) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'pmenu-item' + (row.live ? ' live' : '');
  item.setAttribute('role', 'menuitem');
  item.innerHTML = '<span class="pmenu-label"></span>'
    + (row.live ? '<span class="pmenu-live">live</span>' : '<span class="pmenu-when"></span>');
  item.querySelector('.pmenu-label').textContent = row.label;

  // A running session is listed and not offered. `disabled` would have been the
  // obvious way to say so and is the wrong one: a disabled button takes no
  // mouse events, so it could not carry the tooltip that explains itself.
  if (row.live) {
    item.setAttribute('aria-disabled', 'true');
    item.tabIndex = -1;
    item.title = `${row.label}\n\nThis one is open now. Resuming it again would put two`
      + ` claudes on the same conversation, so it has to be closed first.`;
    return item;
  }

  item.querySelector('.pmenu-when').textContent = ago(row.at);
  item.title = `${row.label}\n\n${new Date(row.at).toLocaleString()}\n${row.command}`;
  item.addEventListener('click', () => {
    closeProjectMenu();
    newTerminal(project, row.command);
  });
  return item;
}

/** Put the menu at the pointer, and inside the window wherever the pointer was. */
function placeMenu(x, y) {
  const gap = 8;
  const box = projectMenu.getBoundingClientRect();
  const left = Math.max(gap, Math.min(x, window.innerWidth - box.width - gap));
  // Below the pointer normally, above it near the bottom of the screen — which
  // is where the menu opens most often, since that is where a long project list
  // reaches.
  const below = y + box.height + gap <= window.innerHeight;
  const top = below ? y : Math.max(gap, y - box.height);

  projectMenu.style.left = `${left}px`;
  projectMenu.style.top = `${top}px`;
}

async function openProjectMenu(project, x, y) {
  closeProjectMenu();
  const token = menuToken;

  let rows;
  try {
    rows = await api.recentSessions(project.path);
  } catch (err) {
    console.error('Hangar: could not read claude history', err);
    rows = [];
  }
  if (token !== menuToken) return;

  projectMenuHead.textContent = `Recent claude sessions — ${project.name}`;
  projectMenuList.textContent = '';

  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'pmenu-empty';
    none.textContent = 'Nothing to resume here yet.';
    projectMenuList.appendChild(none);
  }
  for (const row of rows) projectMenuList.appendChild(menuRow(project, row));

  // Shown before it is placed, because it cannot be measured while it is
  // hidden. Both happen inside one task, so nothing is painted at the old
  // position in between.
  projectMenu.hidden = false;
  placeMenu(x, y);
}

// Anything that moves what the menu is pointing at, or takes attention away
// from it, closes it. Capture phase on the mousedown so a click aimed at
// something else does not also have to be a click that dismisses.
document.addEventListener('mousedown', (e) => {
  if (menuOpen() && !projectMenu.contains(e.target)) closeProjectMenu();
}, true);
window.addEventListener('blur', closeProjectMenu);
window.addEventListener('resize', closeProjectMenu);
projectlist.addEventListener('scroll', closeProjectMenu);

// ----------------------------------------------------------------- backups

// A project turns green after IDLE_MS, which is short enough to happen many
// times inside one task — between tool calls, or while claude waits on a
// permission prompt. Copying the folder then would catch it half written, so a
// backup wants a much longer unbroken quiet spell before it believes the work
// is actually over.
const BACKUP_QUIET_MS = 60_000;

// How long to leave a failed backup before its one retry.
const BACKUP_RETRY_MS = 120_000;

const backupTimers = new Map();   // project path -> countdown to its backup
const backupState = new Map();    // project path -> pending | running | done | failed
const backupDirty = new Set();    // projects written to since their last backup
const retried = new Set();        // projects whose one retry has been spent

// The badges Dropbox itself puts on a file: a green tick once it is safely up,
// the chasing arrows while it is not. Drawn rather than shipped as images so
// they take the row's colour and stay sharp at any scaling.
const SYNC_ARROWS =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
  + '<circle cx="8" cy="8" r="7" fill="currentColor"/>'
  + '<g class="cutline" stroke-width="1.2" stroke-linecap="butt">'
  + '<path d="M4.55 7.39A3.5 3.5 0 0 1 10.68 5.75"/>'
  + '<path d="M11.45 8.61A3.5 3.5 0 0 1 5.32 10.25"/>'
  + '</g>'
  + '<g class="cut">'
  + '<path d="M11.65 6.9 11.56 5.01 9.8 6.49Z"/>'
  + '<path d="M4.35 9.1 4.44 10.99 6.2 9.51Z"/>'
  + '</g>'
  + '</svg>';

const SYNC_ICONS = {
  stale: SYNC_ARROWS,
  running: SYNC_ARROWS,
  done:
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="7" fill="currentColor"/>'
    + '<path class="cutline" d="M4.8 8.3 6.9 10.4 11.2 5.9"'
    + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>',
  failed:
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="7" fill="currentColor"/>'
    + '<path class="cut" d="M7.1 3.9h1.8l-.25 5.2h-1.3z"/>'
    + '<circle class="cut" cx="8" cy="11.4" r="1"/>'
    + '</svg>',
};

const BACKUP_LABELS = {
  stale: 'Not backed up yet — waiting for the project to stay quiet',
  running: 'Backing up…',
  done: 'Backed up',
  failed: 'Backup failed — see the tooltip on the next attempt',
};

/**
 * Which badge a project's row should wear.
 *
 * Anything written since the last copy counts as out of date whether or not a
 * countdown is running yet, so a project being worked on shows the arrows the
 * moment its first line of output lands rather than waiting to go quiet.
 */
function syncIcon(projectPath) {
  // With backups off there is nothing for a badge to be honest about, so no
  // row wears one rather than every row wearing a permanent "not backed up".
  if (!backupsOn) return null;
  const state = backupState.get(projectPath);
  if (state === 'failed') return 'failed';
  if (state === 'running') return 'running';
  if (state === 'pending' || backupDirty.has(projectPath)) return 'stale';
  if (state === 'done') return 'done';
  return null;   // never touched this session, so nothing to claim either way
}

function setBackupState(projectPath, state) {
  if (state) backupState.set(projectPath, state);
  else backupState.delete(projectPath);
  paintProjectRow(projectPath);
}

/** Whether nothing under this project is mid-task, so it is safe to copy. */
function projectIsQuiet(projectPath) {
  const states = terminalsIn(projectPath).map((t) => t.state);
  const stage = STAGES.find((s) => states.includes(s));
  // No stage at all means no terminals, which is as quiet as it gets.
  return !stage || stage === 'ready';
}

/**
 * A terminal in this project just printed something, so its files may still be
 * moving. Marks it for copying and, if a countdown was already running, starts
 * that countdown over — it is re-armed by the idle timer once output stops.
 */
function noteProjectWrite(projectPath) {
  if (!backupsOn) return;
  const wasDirty = backupDirty.has(projectPath);
  backupDirty.add(projectPath);

  const timer = backupTimers.get(projectPath);
  if (!timer) {
    // The first write after a copy is what turns the tick back into arrows;
    // every write after that says nothing new, so the row is left alone.
    if (!wasDirty) paintProjectRow(projectPath);
    return;
  }
  clearTimeout(timer);
  backupTimers.delete(projectPath);
  setBackupState(projectPath, null);
}

/**
 * Arm or cancel a project's backup countdown. Called on every stage change, so
 * any terminal waking back up pushes the copy out of reach again.
 */
function scheduleBackup(projectPath, stage) {
  if (!backupsOn) return;

  // No stage at all means no terminals — a project whose last tab just closed
  // is as finished as one sitting green.
  const finished = !stage || stage === 'ready';
  const timer = backupTimers.get(projectPath);

  if (!finished) {
    if (timer) {
      clearTimeout(timer);
      backupTimers.delete(projectPath);
    }
    backupDirty.add(projectPath);
    setBackupState(projectPath, null);
    return;
  }

  if (timer) return;                                       // already counting
  if (!backupDirty.has(projectPath)) return;               // nothing new to copy
  if (backupState.get(projectPath) === 'running') return;

  setBackupState(projectPath, 'pending');
  backupTimers.set(projectPath, setTimeout(() => {
    backupTimers.delete(projectPath);
    runBackup(projectPath);
  }, BACKUP_QUIET_MS));
}

async function runBackup(projectPath) {
  if (!backupsOn) return;
  if (backupState.get(projectPath) === 'running') return;

  setBackupState(projectPath, 'running');
  // Cleared up front: anything written while the copy runs should re-arm the
  // countdown rather than be counted as covered by this pass.
  backupDirty.delete(projectPath);

  let result;
  try {
    result = await api.backup(projectPath);
  } catch (err) {
    result = { ok: false, message: err.message };
  }

  setBackupState(projectPath, result.ok ? 'done' : 'failed');

  const row = projectRows.get(projectPath);
  const badge = row && row.querySelector('.bsync');
  if (badge) badge.title = `Backup: ${result.message}`;

  // Most failures here are a race with Dropbox itself, which holds files open
  // while it uploads them and would have let go a moment later. One more go a
  // couple of minutes on clears that; anything still failing after it is a
  // real problem and is left showing red rather than retried on a loop.
  if (!result.ok && !retried.has(projectPath)) {
    retried.add(projectPath);
    setTimeout(() => {
      if (projectIsQuiet(projectPath)) runBackup(projectPath);
    }, BACKUP_RETRY_MS);
    return;
  }
  retried.delete(projectPath);
}

/**
 * Mirror every project once, in turn.
 *
 * The per-project trigger only fires for projects worked on inside Hangar,
 * which would leave anything edited in Cursor unprotected until the next time
 * a terminal happened to open there. Sweeping at launch closes that gap, and
 * costs almost nothing after the first run: a mirror walks a directory it has
 * already copied in milliseconds and moves only what changed.
 *
 * One at a time, and skipping anything mid-task, so it cannot compete with
 * work that has already started.
 */
let sweeping = false;
async function sweepAllProjects() {
  if (!backupsOn) return;
  if (sweeping) return;
  sweeping = true;

  try {
    for (const project of projects) {
      if (!projectIsQuiet(project.path)) continue;
      if (backupState.get(project.path) === 'running') continue;
      await runBackup(project.path);
    }
  } finally {
    sweeping = false;
  }
}

function renderSidebar() {
  projectlist.textContent = '';
  projectRows.clear();

  for (const project of projects) {
    const wrap = document.createElement('div');
    wrap.className = 'project';
    // Attached before it is filled, and everything below wrapped in a catch.
    // Painting a row does real work — stage colours, backup scheduling — and a
    // throw in the middle of it used to take the half-built project out of the
    // tree along with every project after it, which read as the sidebar
    // truncating itself the moment you touched a twisty.
    projectlist.appendChild(wrap);

    try {
      renderProject(project, wrap);
    } catch (err) {
      console.error(`Hangar: could not finish rendering ${project.path}`, err);
    }
  }
}

/** Fill one project's row and terminal list into an already-attached wrapper. */
function renderProject(project, wrap) {
  const mine = terminalsIn(project.path);

  // A project with nothing under it has nothing to expand into, so it keeps
  // neither its twisty nor any open state left over from the terminal that
  // just closed. The glyph goes, its 16px stays, so names stay in one column.
  if (mine.length === 0) expanded.delete(project.path);
  const open = expanded.has(project.path);
  if (open) wrap.classList.add('open');

  const row = document.createElement('div');
  row.className = 'project-row';
  row.title = `${project.path}\nDouble-click for a claude terminal (shift for a plain shell)` +
    '\nRight-click to resume an earlier claude session' +
    (mine.length ? '\nArrow expands' : '');
  row.innerHTML =
    '<span class="twisty"></span><span class="pname"></span>' +
    '<span class="bsync"></span>' +
    '<button class="add" title="New claude terminal here (shift-click for a plain shell)">+</button>';
  row.querySelector('.pname').textContent = project.name;
  projectRows.set(project.path, row);

  // Expanding is the twisty's job alone. The name belongs to the
  // double-click, and a name that also toggled would collapse the project out
  // from under the terminal the double-click just asked for.
  if (mine.length) {
    const twisty = row.querySelector('.twisty');
    twisty.textContent = '▶';
    twisty.title = 'Expand / collapse';
    twisty.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleProject(project.path);
    });
  }
  row.addEventListener('dblclick', (e) => {
    if (e.target.classList.contains('add') || e.target.classList.contains('twisty')) return;
    newTerminal(project, e.shiftKey ? null : DEFAULT_COMMAND);
  });
  row.querySelector('.add').addEventListener('click', (e) => {
    e.stopPropagation();
    newTerminal(project, e.shiftKey ? null : DEFAULT_COMMAND);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openProjectMenu(project, e.clientX, e.clientY);
  });
  wrap.appendChild(row);

  const list = document.createElement('div');
  list.className = 'termlist';
  wrap.appendChild(list);

  for (const tab of mine) {
    const termRow = document.createElement('div');
    termRow.innerHTML =
      '<span class="dot"></span><span class="tname"></span><button class="x" title="Close">✕</button>';

    termRow.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(tab.id); return; }
      if (e.target.classList.contains('x')) return;
      activate(tab.id);
    });
    termRow.querySelector('.x').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    tab.row = termRow;
    list.appendChild(termRow);
    paint(tab);
  }

  paintProject(project.path);
}

/** Push a tab's current name and stage into both places that show it. */
function paint(tab) {
  const state = ' state-' + tab.state;
  const active = tab.id === activeId ? ' active' : '';

  if (tab.el) {
    tab.el.className = 'tab' + state + active;
    tab.el.querySelector('.label').textContent = tab.title;
    tab.el.title = `${tab.projectName} — ${tab.title}`;
  }
  if (tab.row) {
    tab.row.className = 'term-row' + state + active;
    tab.row.querySelector('.tname').textContent = tab.title;
    tab.row.title = `${tab.title} — ${tab.state}`;
  }
  paintProject(tab.projectPath);
}

function setState(tab, state) {
  if (tab.state === state) return;
  tab.state = state;
  paint(tab);
}

function setTitle(tab, title) {
  if (!title || tab.title === title) return;
  tab.title = title;
  paint(tab);
}

/**
 * Say why a terminal is not one, in the pane that was going to be it.
 *
 * A shell that cannot be spawned, or that exits the moment it is, used to leave
 * nothing at all behind — the sidebar was never redrawn, or the exit handler
 * closed the tab again within milliseconds — so asking for a terminal looked
 * exactly like asking for nothing. Whatever the shell or the spawn had to say
 * about it is the one thing that can tell you what to fix, and this pane is the
 * only place with room to print it.
 */
function reportFailure(tab, message) {
  tab.failed = true;
  setTitle(tab, 'failed');
  setState(tab, 'ready');

  tab.term.writeln('');
  tab.term.writeln('\x1b[31mHangar could not start this terminal.\x1b[0m');
  for (const line of String(message).split('\n')) tab.term.writeln(line);
  tab.term.writeln('');
  tab.term.writeln('\x1b[90mCtrl+Shift+W closes this tab.\x1b[0m');
  paint(tab);
}

// ------------------------------------------------------- new project modal

const modal = $('modal');
const modalName = $('modalname');
const modalError = $('modalerror');
const modalCreate = $('modalcreate');
const modalCancel = $('modalcancel');

const CREATE_LABEL = 'Create project folder';

let modalReturn = null;   // what had focus before the modal took it
let creating = false;

function modalOpen() {
  return !modal.hidden;
}

function openNewProject() {
  if (modalOpen()) return;

  modalReturn = document.activeElement;
  modalName.value = '';
  modalError.textContent = '';
  modalCreate.textContent = CREATE_LABEL;
  creating = false;
  checkName();

  const rootLabel = $('modalroot');
  rootLabel.textContent = projectsRoot;
  rootLabel.title = projectsRoot;

  modal.hidden = false;
  modalName.focus();
}

function closeNewProject() {
  if (!modalOpen()) return;
  modal.hidden = true;

  // Back to the terminal, which is where the keyboard belongs the rest of the
  // time; only if there isn't one does the thing that opened this get it back.
  const tab = tabs.get(activeId);
  if (tab) tab.term.focus();
  else if (modalReturn && modalReturn.focus) modalReturn.focus();
  modalReturn = null;
}

/**
 * Run the name rules over what has been typed so far, leaving the button and
 * the message line saying the same thing.
 *
 * An empty field is not a mistake yet, so it disables the button without
 * complaining about it — the modal opens quiet rather than opening in red.
 */
function checkName() {
  const raw = modalName.value;
  const result = ProjectName.validateProjectName(raw, {
    existing: projects.map((p) => p.name),
    ignored: ignoredNames,
  });

  modalCreate.disabled = creating || !result.ok;
  modalError.textContent = raw.trim() && !result.ok ? result.message : '';
  return result;
}

async function submitNewProject() {
  if (creating) return;

  const check = checkName();
  if (!check.ok) {
    modalError.textContent = check.message;
    modalName.focus();
    return;
  }

  creating = true;
  modalCreate.disabled = true;
  modalCreate.textContent = 'Creating…';

  let result;
  try {
    result = await api.createProject(check.name);
  } catch (err) {
    result = { ok: false, message: err.message };
  }

  creating = false;
  modalCreate.textContent = CREATE_LABEL;

  if (!result.ok) {
    // The main process is the one that actually touched the disk, so its
    // answer replaces whatever the field's own rules had to say.
    checkName();
    modalError.textContent = result.message;
    modalName.focus();
    modalName.select();
    return;
  }

  // The whole listing comes back with it, so the tree is rebuilt from what is
  // really on disk rather than from a row spliced in on trust.
  projects = result.projects;
  renderSidebar();
  closeNewProject();

  const row = projectRows.get(result.project.path);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

/**
 * Keep Tab inside the modal. Without this the last button hands focus off to
 * the sidebar behind the overlay, where it can be typed at unseen.
 */
function trapTab(e) {
  const stops = [modalName, modalCancel, modalCreate].filter((el) => !el.disabled);
  const i = stops.indexOf(document.activeElement);
  const next = e.shiftKey ? i - 1 : i + 1;
  if (i !== -1 && next >= 0 && next < stops.length) return;   // still inside

  e.preventDefault();
  e.stopPropagation();
  stops[e.shiftKey ? stops.length - 1 : 0].focus();
}

$('sidehead').addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;   // the collapse arrow lives here too
  openNewProject();
});

modalName.addEventListener('input', () => checkName());
modalName.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  submitNewProject();
});

modalCreate.addEventListener('click', submitNewProject);
modalCancel.addEventListener('click', closeNewProject);

// Clicking off it dismisses, but only when the press started on the backdrop —
// otherwise a selection dragged out of the field would close the modal on
// release.
modal.addEventListener('mousedown', (e) => {
  if (e.target === modal) closeNewProject();
});

// ------------------------------------------------------------ tab lifecycle

let idSeq = 0;

async function newTerminal(project, command = DEFAULT_COMMAND) {
  expanded.add(project.path);
  // The sidebar is redrawn whatever happened. A throw on the way up used to
  // skip it, which left the tab that had already been built listed nowhere and
  // the double-click that asked for it looking like it had missed.
  try {
    return await createTab(project, command);
  } catch (err) {
    console.error('Hangar: could not open a terminal', err);
    return null;
  } finally {
    renderSidebar();
  }
}

/**
 * Take over a terminal this window did not open.
 *
 * There are two ways one turns up: it was already running when the window was
 * built — the terminals outlive the window now — or a phone just started it.
 * Either way the pty, the name, the stage and the history are all over in the
 * main process already, so this builds the pane around them and replays what
 * was printed before we were looking.
 */
async function adoptSession(summary) {
  if (tabs.has(summary.id)) return tabs.get(summary.id);

  const tab = buildTab({
    id: summary.id,
    projectPath: summary.projectPath,
    projectName: summary.projectName || lastSegment(summary.projectPath),
    title: summary.title,
    state: summary.state,
  });
  // Very often a phone's: this is the path a terminal opened on the phone
  // arrives by, and the window has to know it does not own the width yet.
  tab.sizeOwner = summary.sizeOwner;

  wireLiveTab(tab);

  // Only if there is nothing to interrupt. A terminal opened on the phone
  // appearing in the sidebar is welcome; it yanking the pane out from under
  // whatever is being read at the desk is not.
  const showing = !activeId;
  if (showing) activate(tab.id);

  updateEmpty();
  renderSidebar();

  // Same measurement problem as a terminal opened here, with the same answer —
  // except that an adopted one only gets to claim the width if it is the pane
  // on screen. A terminal running quietly behind another must not reflow the
  // shell to a pane nobody is looking at.
  if (showing) {
    await laidOut();
    refit(tab);
  }

  await hydrate(tab);
  return tab;
}

function lastSegment(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || p || 'project';
}

/**
 * Fill a freshly built pane with what the terminal printed before it had one.
 *
 * Output does not stop while this is being asked for, so anything that lands
 * in between is held rather than written — and then written from exactly where
 * the history left off. Without that the first screenful of an adopted
 * terminal is the same few hundred characters twice.
 */
async function hydrate(tab) {
  tab.hydrating = [];
  let past;
  try {
    past = await api.history(tab.id, 0);
  } catch {
    past = null;
  }

  if (past && past.data) tab.term.write(past.data);
  tab.seq = past ? past.seq : 0;

  const held = tab.hydrating;
  tab.hydrating = null;
  for (const chunk of held) writeChunk(tab, chunk);
}

/**
 * Write a chunk that carries the sequence number it ends at, skipping whatever
 * of it the tab has already seen.
 */
function writeChunk(tab, { seq, data }, done) {
  if (typeof seq !== 'number') { tab.term.write(data, done); return; }

  // Already covered by the history replay: count it as seen and write nothing.
  if (seq <= tab.seq) {
    tab.seq = Math.max(tab.seq, seq);
    if (done) done();
    return;
  }

  const start = seq - data.length;
  const text = start >= tab.seq ? data : data.slice(tab.seq - start);
  tab.seq = seq;
  tab.term.write(text, done);
}

/** Everything a pane needs that does not depend on how the terminal started. */
function buildTab({ id, projectPath, projectName, title, state }) {
  const pane = document.createElement('div');
  // Hidden until something activates it. A terminal the phone opened builds a
  // pane over here too, and an unhidden one would land on top of whatever is
  // being read without anything having asked it to.
  pane.hidden = true;
  pane.className = 'pane';
  panes.appendChild(pane);

  const el = document.createElement('div');
  el.className = 'tab';
  el.innerHTML = '<span class="dot"></span><span class="label"></span><span class="close">✕</span>';
  tablist.appendChild(el);

  const term = new Terminal({
    scrollback: 100_000,
    // Windows first, then the macOS pair. None of the mac names exist on
    // Windows and none of the Windows ones exist on macOS, so each platform
    // falls through to its own without either having to be asked about.
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, "Courier New", monospace',
    fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
    scrollOnUserInput: true,
    smoothScrollDuration: 0,
    windowsPty: { backend: 'conpty' },
    theme: THEME,
  });

  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';

  term.open(pane);

  // WebGL keeps big scrolling output smooth; fall back to the DOM renderer if
  // the GPU context is lost rather than leaving a blank pane.
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* software rendering is fine, just slower */
  }

  const tab = {
    id, term, fit, search, el, pane,
    row: null,
    projectPath,
    projectName,
    title: title || 'shell',
    // The name and the coloured dot are worked out in the main process now, so
    // the sidebar here and the list on a phone cannot end up calling one
    // terminal two different things. Both arrive as session events.
    state: state || 'ready',
    // How far through this terminal's output the pane has got — which is what
    // lets a terminal that was already running be caught up on without
    // printing the join twice.
    seq: 0,
    hydrating: null,
    pending: 0,
    paused: false,
  };

  tabs.set(id, tab);
  order.push(id);

  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) { e.preventDefault(); closeTab(tab.id); return; }
    if (e.target.classList.contains('close')) return;
    activate(tab.id);
  });
  el.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  });

  fit.fit();
  return tab;
}

/** The keyboard and the size, for a tab whose terminal is actually running. */
function wireLiveTab(tab) {
  const term = tab.term;
  tab.startedAt = Date.now();

  term.onData((data) => sendInput(tab, data));
  term.onResize(({ cols, rows }) => api.resize(tab.id, cols, rows));

  // Shift+Enter opens a new line instead of submitting. A terminal sends a bare
  // CR for both, so nothing on the far end can tell them apart; ESC+CR is the
  // sequence Claude Code's own /terminal-setup teaches other terminals to send
  // for this, and shells read it as a meta-return they have nothing to do with.
  // Attached after the pty exists so an early keypress has somewhere to go.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || e.key !== 'Enter') return true;
    if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true;
    e.preventDefault();
    sendInput(tab, '\u001b\r');
    return false; // xterm must not also send the CR that would submit
  });

  paint(tab);
  return tab;
}

async function createTab(project, command) {
  // The pane is built first because a pty needs a size and the only honest
  // source of one is a terminal that has been laid out. It is keyed on a
  // placeholder until the main process says what the terminal is called: ids
  // belong to the side that keeps the list, now that two screens can both ask
  // for a terminal at the same moment.
  const tab = buildTab({
    id: 'pending-' + (++idSeq),
    projectPath: project.path,
    projectName: project.name,
    title: command || 'shell',
    state: 'ready',
  });

  activate(tab.id);
  updateEmpty();

  // A pane that has not been laid out has no size, and a terminal measured
  // while it is still hidden reports the 80x24 it was constructed with. That
  // number used to go straight to the pty, which then painted into the top-left
  // corner of a much larger pane — and stayed that way, because the handler
  // that reports later resizes is not attached until the pty exists. The first
  // window resize would fix it, which is a strange thing to have to do to every
  // new terminal. So: let the pane lay out, measure it, and start the shell at
  // the size it is actually going to be.
  await laidOut();
  refit(tab);

  let session;
  try {
    session = await api.create({
      cwd: project.path,
      projectName: project.name,
      command,
      cols: tab.term.cols,
      rows: tab.term.rows,
    });
  } catch (err) {
    reportFailure(tab, err && err.message ? err.message : String(err));
    return tab;
  }

  rekey(tab, session.id);
  tab.sizeOwner = session.sizeOwner;
  wireLiveTab(tab);

  // Anything that moved between the measurement above and the pty existing —
  // the sidebar being redrawn underneath it, a font still settling — is caught
  // here rather than waiting for the user to resize something.
  refit(tab);
  api.resize(tab.id, tab.term.cols, tab.term.rows);
  return tab;
}

/** The next frame, by which time the browser has laid out what was just added. */
function laidOut() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Move a tab off its placeholder onto the id the main process gave it. */
function rekey(tab, id) {
  tabs.delete(tab.id);
  order = order.map((x) => (x === tab.id ? id : x));
  if (activeId === tab.id) activeId = id;
  tab.id = id;
  tabs.set(id, tab);
}

function sendInput(tab, data) {
  // Typing into a terminal is the plainest statement there is that someone is
  // sitting at this window, so it takes the width back from a phone that had
  // reflowed this terminal to its own screen. Without this the only two ways
  // back were activating a tab and the window regaining focus — and neither
  // happens to a window that never lost focus in the first place, which is how
  // a terminal ended up staying phone-shaped while being typed into.
  //
  // Guarded rather than measured on every keystroke: when the width is already
  // this window's, which is nearly always, this costs one comparison.
  if (tab.sizeOwner && tab.sizeOwner !== 'desktop') refit(tab, { force: true });
  api.write(tab.id, data);
}

function activate(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  activeId = id;

  for (const t of tabs.values()) {
    const on = t.id === id;
    t.pane.hidden = !on;
    paint(t);
  }

  // A hidden pane has no size, so it can only be measured once visible.
  requestAnimationFrame(() => {
    refit(tab, { force: true });
    tab.term.focus();
  });
}

/**
 * Fit a pane's terminal to the space it has.
 *
 * `force` also takes the width back from a phone that had reflowed this
 * terminal to its own screen. Only where sitting down at the window is the
 * point — activating a tab, bringing the window forward — because a phone
 * being used in another room should not have the terminal snatched out from
 * under it by a window nobody is looking at.
 */
function refit(tab, { force = false } = {}) {
  if (!tab || tab.pane.hidden) return;
  try { tab.fit.fit(); } catch { /* pane not laid out yet */ }

  if (!force || !tab.sizeOwner || tab.sizeOwner === 'desktop') return;
  tab.sizeOwner = 'desktop';
  api.claim(tab.id, tab.term.cols, tab.term.rows);
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const idx = order.indexOf(id);

  clearTimeout(tab.idleTimer);
  clearTimeout(tab.classifyTimer);
  api.kill(id);
  tab.term.dispose();
  tab.pane.remove();
  tab.el.remove();
  tabs.delete(id);
  order = order.filter((x) => x !== id);

  if (activeId === id) {
    activeId = order.length ? order[Math.min(idx, order.length - 1)] : null;
    if (activeId) activate(activeId);
  }

  renderSidebar();
  updateEmpty();
}

function cycle(delta) {
  if (order.length < 2) return;
  const i = order.indexOf(activeId);
  activate(order[(i + delta + order.length) % order.length]);
}

function activeProject() {
  const tab = tabs.get(activeId);
  if (tab) return { name: tab.projectName, path: tab.projectPath };
  return projects[0] || null;
}

// ---------------------------------------------------------------- pty wiring

api.onData((chunk) => {
  const tab = tabs.get(chunk.id);
  if (!tab) return;

  // Mid-adoption: this window is still waiting to be told what was printed
  // before it had a pane. Holding the chunk rather than writing it keeps the
  // two in order, and `hydrate` writes them once it knows where history ended.
  if (tab.hydrating) {
    tab.hydrating.push(chunk);
    noteOutput(tab, chunk.data);
    return;
  }

  const { data } = chunk;
  tab.pending += data.length;
  if (!tab.paused && tab.pending > HIGH_WATER) {
    tab.paused = true;
    api.flow(tab.id, true);
  }

  writeChunk(tab, chunk, () => {
    tab.pending -= data.length;
    if (tab.paused && tab.pending < LOW_WATER) {
      tab.paused = false;
      api.flow(tab.id, false);
    }
  });

  noteOutput(tab, data);
});

/**
 * What this window still does per chunk, now that naming and the stage dot are
 * the main process's job: notice that a project's files may have moved.
 *
 * Output is the only reliable sign of that. A terminal that never leaves
 * 'ready' — a short command, a stage the classifier does not recognise — would
 * otherwise never queue a backup.
 */
function noteOutput(tab) {
  noteProjectWrite(tab.projectPath);
}

/**
 * A terminal appeared, was renamed, changed stage, or went.
 *
 * All four used to be worked out here from the bytes. They are worked out once
 * in the main process now and broadcast to everything looking, which is what
 * makes a terminal a phone opened show up in this sidebar with the right name
 * and the right colour on it without this file knowing phones exist.
 */
api.onSession(({ kind, session }) => {
  const tab = tabs.get(session.id);

  if (kind === 'created') {
    // A terminal this window asked for arrives twice: once as this broadcast,
    // which can land before the call that asked for it has even returned, and
    // once as that call's answer. The answer is the one that owns the pane
    // that was already built for it, so the broadcast is ignored — otherwise
    // one click on `+` leaves two tabs behind for one shell.
    if (session.origin === 'desktop') return;
    if (!tab) adoptSession(session);
    return;
  }

  if (!tab) return;

  if (kind === 'updated') {
    setTitle(tab, session.title);
    setState(tab, session.state);

    // A phone let go of the width — it disconnected, or handed it back. It
    // returns the size it was using rather than one that fits here, so the
    // window has to say how big it actually is or go on painting into a
    // phone-shaped corner of itself.
    const wasOwned = tab.sizeOwner && tab.sizeOwner !== 'desktop';
    tab.sizeOwner = session.sizeOwner;
    if (wasOwned && session.sizeOwner === 'desktop' && tab.id === activeId) refit(tab, { force: true });
    return;
  }

  // 'closed' is handled by the exit event, which knows the difference between
  // a shell someone quit and one that never started.
});

// A terminal has gone quiet. Usually that is not a change of stage — it was
// already green — so it arrives separately from the stage events, and it is
// the moment the backup countdown can start.
api.onIdle(({ projectPath }) => paintProject(projectPath));

api.onProjectsChanged(() => refreshProjects());

async function refreshProjects() {
  const { projects: found, root, ignored } = await api.listProjects();
  projects = found;
  projectsRoot = root || '';
  ignoredNames = ignored || [];
  renderSidebar();
}

// Closing the tab is right for a shell you exited out of, and wrong for one
// that never got as far as a prompt — a shell that isn't there, a login profile
// that bailed, a `claude` that died on startup. Both arrive here as the same
// event, and the only thing separating them is how long the session lasted:
// nobody types `exit` inside a second and a half. So an instant death keeps its
// tab and prints its exit code rather than disappearing, which is the same
// thing as the click never having worked.
const DEAD_ON_ARRIVAL_MS = 1500;

api.onExit(({ id, exitCode }) => {
  const tab = tabs.get(id);
  if (tab && !tab.failed && Date.now() - tab.startedAt < DEAD_ON_ARRIVAL_MS) {
    reportFailure(tab, `The shell exited immediately with code ${exitCode}.`);
    return;
  }
  closeTab(id);
});

// -------------------------------------------------------------------- resizing

new ResizeObserver(() => refit(tabs.get(activeId))).observe(panes);

// Clicking into a terminal counts as sitting down at it too. Activating a tab
// already takes the width back, but clicking inside the tab that is already
// active is not activating anything.
panes.addEventListener('pointerdown', () => {
  const tab = tabs.get(activeId);
  if (tab && tab.sizeOwner && tab.sizeOwner !== 'desktop') refit(tab, { force: true });
});

// -------------------------------------------------------------------- find bar

function openFind() {
  findBar.hidden = false;
  findInput.select();
  findInput.focus();
}

function closeFind() {
  findBar.hidden = true;
  const tab = tabs.get(activeId);
  if (tab) {
    tab.search.clearDecorations();
    tab.term.focus();
  }
}

function runSearch(back) {
  const tab = tabs.get(activeId);
  const q = findInput.value;
  if (!tab || !q) return;
  const opts = {
    decorations: {
      matchOverviewRuler: '#4d9cf6',
      activeMatchColorOverviewRuler: '#f0c674',
      activeMatchBackground: '#f0c674',
      activeMatchBorder: '#f0c674',
      matchBackground: '#2d4b6e',
    },
  };
  if (back) tab.search.findPrevious(q, opts);
  else tab.search.findNext(q, opts);
}

findInput.addEventListener('input', () => runSearch(false));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('findnext').addEventListener('click', () => runSearch(false));
$('findprev').addEventListener('click', () => runSearch(true));
$('findclose').addEventListener('click', closeFind);

// ----------------------------------------------------------------- clipboard

function copySelection() {
  const tab = tabs.get(activeId);
  if (!tab) return false;
  const sel = tab.term.getSelection();
  if (!sel) return false;
  api.copy(sel);
  tab.term.clearSelection();
  return true;
}

function pasteClipboard() {
  const tab = tabs.get(activeId);
  const text = api.paste();
  if (tab && text) sendInput(tab, text);
}

// Windows Terminal behaviour: right-click copies a selection if there is one,
// otherwise it pastes.
panes.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!copySelection()) pasteClipboard();
});

// ------------------------------------------------------------------ font size

function setFontSize(next) {
  fontSize = Math.min(32, Math.max(8, next));
  localStorage.setItem('fontSize', String(fontSize));
  for (const t of tabs.values()) {
    t.term.options.fontSize = fontSize;
    refit(t);
  }
}

// ------------------------------------------------------------------ shortcuts

// Capture phase so these never reach the shell as keystrokes.
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  const swallow = () => { e.preventDefault(); e.stopPropagation(); };

  // A card owns the keyboard while it is up. Returning rather than swallowing
  // leaves ordinary keys to reach the fields, but stops every shortcut below
  // from acting on a window the user cannot see the state of.
  if (setupOpen()) {
    // Escape only means something once there is a saved state to fall back to;
    // on a first run there is nothing behind the card to escape to.
    if (e.key === 'Escape' && configured) { swallow(); closeSetup(); }
    return;
  }

  if (modalOpen()) {
    if (e.key === 'Escape') { swallow(); closeNewProject(); return; }
    if (e.key === 'Tab') trapTab(e);
    return;
  }

  // The project menu is dismissed by anything, so it does not swallow the key
  // that dismissed it — every shortcut below still fires, on a window that no
  // longer has a menu floating over it.
  if (menuOpen()) {
    closeProjectMenu();
    if (e.key === 'Escape') { swallow(); return; }
  }

  if (e.key === 'F11') { swallow(); api.toggleFullScreen(); return; }

  if (ctrl && shift) {
    switch (e.code) {
      case 'KeyT': {
        swallow();
        const project = activeProject();
        if (project) newTerminal(project);
        return;
      }
      case 'KeyW': swallow(); if (activeId) closeTab(activeId); return;
      case 'KeyE': swallow(); toggleSidebar(); return;
      case 'KeyB': swallow(); zen = !zen; syncChrome(); return;
      case 'KeyF': swallow(); openFind(); return;
      case 'KeyC': swallow(); copySelection(); return;
      case 'KeyV': swallow(); pasteClipboard(); return;
      case 'KeyK': {
        swallow();
        const tab = tabs.get(activeId);
        if (tab) tab.term.clear();
        return;
      }
      default: break;
    }
  }

  if (ctrl && e.code === 'Tab') { swallow(); cycle(shift ? -1 : 1); return; }

  if (ctrl && !shift) {
    if (e.code === 'Equal' || e.code === 'NumpadAdd') { swallow(); setFontSize(fontSize + 1); return; }
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') { swallow(); setFontSize(fontSize - 1); return; }
    if (e.code === 'Digit0') { swallow(); setFontSize(14); return; }
  }

  if (e.altKey && !ctrl && /^Digit[1-9]$/.test(e.code)) {
    const i = Number(e.code.slice(5)) - 1;
    if (order[i]) { swallow(); activate(order[i]); }
    return;
  }

  if (e.key === 'Escape' && !findBar.hidden) { swallow(); closeFind(); }
}, true);

$('newtab').addEventListener('click', () => {
  const project = activeProject();
  if (project) newTerminal(project);
});
$('sidecollapse').addEventListener('click', toggleSidebar);
$('sideexpand').addEventListener('click', toggleSidebar);

// Keep focus in the terminal when the window comes back.
window.addEventListener('focus', () => {
  const tab = tabs.get(activeId);
  if (setupOpen()) { /* the card holds its own focus */ }
  else if (modalOpen()) modalName.focus();
  else if (tab && findBar.hidden) tab.term.focus();

  // Coming back to the window is someone sitting down at it, which is the
  // moment a terminal a phone had reflowed should go back to full width.
  refit(tab, { force: true });

  // Coming back after a while away is exactly when the bars are most likely to
  // be out of date. Cheap: the main process still decides when to really poll.
  refreshUsage();
});

// --------------------------------------------------------------------- usage

const usageBox = $('usage');
const usageNote = $('usagenote');
const usageBars = {
  fiveHour: { fill: $('usage5hfill'), pct: $('usage5hpct') },
  sevenDay: { fill: $('usage7dfill'), pct: $('usage7dpct') },
};

// The same short names the rows are labelled with, for the note below them.
const USAGE_LABELS = { fiveHour: '5h', sevenDay: '7d' };

// Asked for more often than the main process will actually fetch, because the
// countdown below has to keep moving between polls. The extra calls are served
// from the cache over there and never touch the network.
const USAGE_TICK_MS = 60_000;

/** A duration as the sidebar says it: "2h 14m", "47m", or nothing at all. */
function formatIn(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function drawBar({ fill, pct }, window) {
  if (!window) {
    fill.style.width = '0';
    fill.classList.remove('warn', 'hot');
    pct.textContent = '--';
    return;
  }

  fill.style.width = `${window.used}%`;
  fill.classList.toggle('warn', window.used >= 75 && window.used < 90);
  fill.classList.toggle('hot', window.used >= 90);
  pct.textContent = `${Math.round(window.used)}%`;
}

async function refreshUsage() {
  let usage;
  try {
    usage = await api.usage();
  } catch {
    return; // leave whatever is drawn; the next tick can try again
  }

  // No credentials, or a response we could not read. Nothing to say, so the
  // sidebar goes back to ending on the hint line.
  usageBox.hidden = !usage || !usage.available;
  if (usageBox.hidden) {
    projectlist.classList.remove('capped');
    return;
  }

  drawBar(usageBars.fiveHour, usage.fiveHour);
  drawBar(usageBars.sevenDay, usage.sevenDay);

  // A window at 100% means no project can be worked on until it resets, which
  // the bars alone say too quietly. The list of projects glows for it instead —
  // whichever project you were about to reach for is already under the mist.
  const capped = USAGE_LABELS[usage.capped] ? usage.capped : null;
  projectlist.classList.toggle('capped', !!capped);

  const parts = [];
  if (capped) parts.push(`${USAGE_LABELS[capped]} limit reached`);

  // Normally the 5h window is the one worth counting down. Once a window has
  // run out, its own reset is the only time that means anything.
  const counting = usage[capped || 'fiveHour'];
  const resets = counting && formatIn(counting.resetsAt - Date.now());
  if (resets) parts.push(`resets in ${resets}`);

  // Only mentioned once the figures are actually old — during a rate-limit or
  // an outage these are the last good ones rather than the current ones, and
  // silently showing them as current would be the wrong kind of reassuring.
  if (usage.stale && usage.at) {
    parts.push(`as of ${new Date(usage.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  }

  usageNote.textContent = parts.join(' · ');
}

// ------------------------------------------------------------------ settings

/**
 * The setup screen, which is also the settings screen.
 *
 * It is the first thing a new install shows, before the sidebar has anything in
 * it, because until someone says where their projects are there is nothing to
 * list. Reopening it later from the sidebar foot is the same card with the
 * saved answers in the fields and a Cancel button that means something.
 *
 * Validation lives in the main process rather than here. Both fields are paths
 * on disk, and only that side can actually look; a copy of the rules over here
 * would only be a second opinion that is sometimes wrong.
 */

const setup = $('setup');
const setupTitle = $('setuptitle');
const setupIntro = $('setupintro');
const setupTabs = $('setuptabs');
const setupRemote = $('setupremote');
const setupRemoteBox = $('setupremotebox');
const setupRemotePort = $('setupremoteport');
const setupRemoteError = $('setupremoteerror');
const setupAutoStart = $('setupautostart');
const setupMinimised = $('setupminimised');
const remoteState = $('remotestate');
const remoteAddresses = $('remoteaddresses');
const remoteCode = $('remotecode');
const remoteCodeValue = $('remotecodevalue');
const remoteCodeNote = $('remotecodenote');
const remoteDevices = $('remotedevices');
const setupProjects = $('setupprojects');
const setupProjectsError = $('setupprojectserror');
const setupBackup = $('setupbackup');
const setupBackupBox = $('setupbackupbox');
const setupBackupRoot = $('setupbackuproot');
const setupBackupError = $('setupbackuperror');
const setupDropbox = $('setupdropbox');
const setupEnvNote = $('setupenvnote');
const setupSave = $('setupsave');
const setupCancel = $('setupcancel');

let configured = false;   // false only until the first save ever
let backupsOn = false;    // what the app is currently running with
let setupReturn = null;

function setupOpen() {
  return !setup.hidden;
}

function paintBackupBox() {
  setupBackupBox.classList.toggle('off', !setupBackup.checked);
  setupBackupRoot.disabled = !setupBackup.checked;
}

function paintRemoteBox() {
  setupRemoteBox.classList.toggle('off', !setupRemote.checked);
  setupRemotePort.disabled = !setupRemote.checked || envLocked.remotePort;
  $('remotepair').disabled = !setupRemote.checked;
}

// --------------------------------------------------------- the four groups

const PANELS = ['projects', 'backups', 'phone', 'startup'];
let panel = 'projects';

function showPanel(name, { firstRun = false } = {}) {
  panel = PANELS.includes(name) ? name : 'projects';

  for (const field of document.querySelectorAll('.setup-field[data-panel]')) {
    // A first run has no strip and asks its two questions together — the two
    // that have to be answered before anything else means anything.
    field.hidden = firstRun
      ? !['projects', 'backups'].includes(field.dataset.panel)
      : field.dataset.panel !== panel;
  }

  for (const tab of setupTabs.querySelectorAll('.setup-tab')) {
    tab.classList.toggle('on', tab.dataset.panel === panel);
    tab.setAttribute('aria-selected', tab.dataset.panel === panel ? 'true' : 'false');
  }

  // Only worth asking about while the tab that shows it is on screen.
  if (panel === 'phone') refreshRemote();
}

for (const tab of document.querySelectorAll('.setup-tab')) {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel));
}

// ---------------------------------------------------------- phone access

// What is on screen is a listening port and a device list, both of which can
// change without anybody touching this card — a phone connects, the server
// comes up on Save — so the panel is repainted from the main process rather
// than from what the fields say.
let envLocked = { projectsRoot: false, backupRoot: false, remotePort: false };
let codeTimer = null;

function relative(ms) {
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function refreshRemote() {
  let status;
  try {
    status = await api.remote.status();
  } catch {
    return;
  }

  if (status.error) {
    remoteState.textContent = '';
    setupRemoteError.textContent = status.error;
  } else {
    setupRemoteError.textContent = '';
    remoteState.textContent = status.running
      ? `listening — phones can connect`
      : (status.enabled ? 'starting…' : 'off — tick the box and Save');
  }

  remoteAddresses.textContent = '';
  for (const addr of status.addresses || []) {
    const chip = document.createElement('span');
    // A VPN or mesh address works only from a phone on the same mesh, and from
    // any other phone it fails by going quiet rather than by saying no — which
    // is indistinguishable from a firewall, from the wrong wifi, and from the
    // PC being off. Two addresses in a row with nothing to choose between them
    // is a coin flip nobody knows they are making, so the odd one says so.
    const overlay = addr.kind === 'overlay';
    chip.className = 'remote-address' + (overlay ? ' overlay' : '');
    chip.textContent = `${addr.address}:${status.port}`;
    chip.title = overlay
      ? `${addr.name} — a VPN address. Only works from a phone on the same VPN; use it away from home.`
      : `${addr.name} — this network. Use this one.`;

    if (overlay) {
      const tag = document.createElement('span');
      tag.className = 'remote-address-tag';
      tag.textContent = 'VPN';
      chip.appendChild(tag);
    }
    remoteAddresses.appendChild(chip);
  }
  if (!(status.addresses || []).length) {
    const none = document.createElement('span');
    none.className = 'remote-empty';
    none.textContent = 'This PC does not appear to be on a network.';
    remoteAddresses.appendChild(none);
  }

  paintFirewall(status.firewall, status.port, (status.devices || []).length);
  paintDevices(status.devices || [], status.connected || []);
  paintCode(status.code);
}

/**
 * Say when Windows is dropping everything the phone sends.
 *
 * Only shown when the rules actually say Block. `known: false` means the check
 * could not read them — a Windows that answers `netsh` in another language, or
 * a platform that has no such thing — and a warning nobody can act on, on a
 * machine that may well be fine, is worse than no warning.
 */
/**
 * What the firewall has to say, and how loudly.
 *
 * There are two findings here and they deserve very different volumes. A Block
 * rule naming Hangar is a mistake with a fix, and it is worth shouting about. A
 * rule that blocks the whole local network is somebody's deliberate policy —
 * worth stating, because it is invisible otherwise and it will be why the LAN
 * route does not work, but it is not a fault and it is not always in the way:
 * a phone reaching Hangar over a mesh VPN never touches it.
 *
 * So the second one goes quiet once a phone has actually been paired. Shouting
 * "Windows Firewall is blocking this" at someone whose phone is connected and
 * working teaches them to ignore the panel, and then it will not be believed on
 * the day it is right.
 */
function paintFirewall(state, port, pairedCount) {
  const box = $('firewallwarn');
  const catchAll = (state && state.catchAll) || [];
  box.hidden = !state || !state.known || (!state.blocked && !catchAll.length);
  if (box.hidden) return;

  const parts = [];
  // Loud only when something is genuinely broken: a rule aimed at Hangar, or a
  // blanket block on a machine that has never managed to pair a phone at all.
  const loud = Boolean(state.blocked) || pairedCount === 0;

  if (state.blocked) {
    const where = (state.profiles || []).join(' and ') || 'this';
    parts.push(
      `There is a rule set to block Hangar on ${where} networks, so your phone's connection `
      + 'is thrown away rather than refused — which is why it sits saying "connecting" and '
      + 'never stops. Windows writes that rule when its "allow access" prompt is answered '
      + 'with the box for this kind of network unticked, and it never asks again.',
      'The button asks Windows for permission to replace it with one that allows just port '
      + `${port} and the search Hangar answers, and only from other devices on this network.`,
    );
  }

  // The rule that names no program, and so blocks Hangar without ever
  // mentioning it. Windows lets a block beat any allowance beside it.
  if (catchAll.length) {
    const names = catchAll.map((name) => `"${name}"`).join(', ');
    const subject = catchAll.length === 1 ? 'A rule' : 'Rules';

    parts.push(loud
      ? `${subject} named ${names} block everything arriving at this PC, without naming any `
        + 'program. Windows lets a block beat any allowance beside it, so this stops the '
        + 'phone however the rest of this panel is set — and because it never mentions '
        + 'Hangar, nothing here would otherwise say so.'
      : `${subject} named ${names} block everything arriving at this PC over the local `
        + 'network. That is not a fault and Hangar has not touched it — it only means a '
        + 'phone cannot reach the addresses above by being on the same wifi.');

    parts.push(loud
      ? 'Hangar will not touch that one: somebody wrote it on purpose. To let the phone '
        + `through, narrow it so it does not cover this machine on port ${port} — the usual `
        + 'way is to exclude the phone\'s own address from it, which is what "all other '
        + 'devices" was probably meant to say in the first place.'
      : 'A phone on a mesh VPN is unaffected, because that traffic arrives on its own '
        + 'address rather than the local one — which is why a VPN address is listed here '
        + 'and why it keeps working away from the house.');
  }

  $('firewallhead').textContent = state.blocked
    ? 'Windows Firewall is blocking this'
    : (loud ? 'A firewall rule is blocking this' : 'The local network route is closed');

  box.classList.toggle('quiet', !loud);
  $('firewalltext').textContent = parts.join('\n\n');
  $('firewallfix').hidden = !state.blocked;
  $('firewallnote').textContent = '';
}

$('firewallfix').addEventListener('click', async () => {
  const button = $('firewallfix');
  button.disabled = true;
  $('firewallnote').textContent = 'Waiting for Windows…';

  let result;
  try {
    result = await api.remote.fixFirewall();
  } catch (err) {
    result = { ok: false, message: err.message };
  }

  button.disabled = false;
  $('firewallnote').textContent = result.ok ? 'Done — try the phone again.' : result.message;
  refreshRemote();
});

function paintDevices(devices, connected) {
  remoteDevices.textContent = '';

  if (!devices.length) {
    const none = document.createElement('div');
    none.className = 'remote-empty';
    none.textContent = 'None yet.';
    remoteDevices.appendChild(none);
    return;
  }

  const live = new Set(connected.map((d) => d.id));

  for (const device of devices) {
    const row = document.createElement('div');
    row.className = 'remote-device';
    row.innerHTML = '<span class="dot"></span><span class="name"></span>'
      + '<span class="when"></span><button class="forget">Remove</button>';
    row.querySelector('.name').textContent = device.name;
    row.querySelector('.when').textContent = live.has(device.id)
      ? 'connected now'
      : `last seen ${relative(device.lastSeen)}`;
    row.classList.toggle('state-ready', live.has(device.id));
    row.querySelector('.forget').addEventListener('click', async () => {
      await api.remote.forget(device.id);
      refreshRemote();
    });
    remoteDevices.appendChild(row);
  }
}

function paintCode(code) {
  clearInterval(codeTimer);
  codeTimer = null;

  if (!code) {
    remoteCode.hidden = true;
    return;
  }

  remoteCode.hidden = false;
  remoteCodeValue.textContent = code.code;

  // A code with no countdown on it is a code nobody knows has expired, and a
  // pairing that fails for that reason looks exactly like one that failed for
  // any other.
  const tick = () => {
    const left = code.expiresAt - Date.now();
    if (left <= 0) {
      remoteCodeNote.textContent = 'expired — ask for another';
      clearInterval(codeTimer);
      codeTimer = null;
      return;
    }
    const secs = Math.ceil(left / 1000);
    remoteCodeNote.textContent = `expires in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  };
  tick();
  codeTimer = setInterval(tick, 1000);
}

$('remotepair').addEventListener('click', async () => {
  paintCode(await api.remote.newCode());
});

// The server coming up or going down, or a phone connecting — repaint if the
// panel that shows any of it happens to be open.
api.remote.onChanged(() => {
  if (setupOpen() && panel === 'phone') refreshRemote();
});

async function openSetup(state) {
  if (setupOpen()) return;

  const { configured: everSaved, config, suggested, env } = state || await api.getConfig();
  configured = everSaved;

  setupReturn = document.activeElement;
  setupProjectsError.textContent = '';
  setupBackupError.textContent = '';
  setupRemoteError.textContent = '';
  envLocked = env;

  // A first run has nothing saved to show, so the fields open on the guesses.
  setupProjects.value = everSaved ? config.projectsRoot : suggested.projectsRoot;
  setupBackupRoot.value = (everSaved && config.backupRoot) || suggested.backupRoot;
  setupBackup.checked = everSaved ? config.backupEnabled : Boolean(suggested.dropbox);
  paintBackupBox();

  // Both of these are off until asked for, on a first run and on every run
  // after it, so there is nothing to guess at — they open on what was saved.
  setupRemote.checked = Boolean(config.remoteEnabled);
  setupRemotePort.value = String(config.remotePort || 7433);
  setupAutoStart.checked = Boolean(config.autoStart);
  setupMinimised.checked = Boolean(config.startMinimised);
  paintRemoteBox();

  // Worth saying out loud, because "we found Dropbox and put your backups in
  // it" is otherwise something the app does to you silently.
  if (!everSaved && suggested.dropbox) {
    setupDropbox.textContent = 'Dropbox is on this machine, so backups are set to go there — '
      + 'they then sync off the machine too. Any other folder works just as well.';
    setupDropbox.hidden = false;
  } else {
    setupDropbox.hidden = true;
  }

  // A field the environment has taken over is shown, but not as something
  // editable — saving over it would have no effect and read as a bug.
  const locked = [
    env.projectsRoot && 'the projects folder',
    env.backupRoot && 'the backup folder',
    env.remotePort && 'the phone port',
  ].filter(Boolean);
  setupProjects.disabled = env.projectsRoot;
  if (env.projectsRoot) setupProjects.value = config.projectsRoot;
  if (env.backupRoot) setupBackupRoot.value = config.backupRoot;
  setupEnvNote.hidden = locked.length === 0;
  setupEnvNote.textContent = locked.length
    ? `Set by an environment variable this session: ${locked.join(' and ')}. Clear it to edit here.`
    : '';

  setupTitle.textContent = everSaved ? 'Settings' : 'Set up Hangar';
  setupIntro.hidden = everSaved;
  setupSave.textContent = everSaved ? 'Save' : 'Start using Hangar';
  // Nothing to cancel back to on a first run — the app behind this is empty.
  setupCancel.hidden = !everSaved;

  setupTabs.hidden = !everSaved;
  showPanel(everSaved ? panel : 'projects', { firstRun: !everSaved });

  setup.hidden = false;
  (setupProjects.disabled ? setupSave : setupProjects).focus();
}

function closeSetup() {
  if (!setupOpen()) return;
  setup.hidden = true;

  // A pairing code lives for five minutes, and the panel showing it is now
  // shut. Anything still open when nobody is looking is a code that could be
  // used by someone who saw it over your shoulder, so it goes with the card.
  api.remote.cancelCode();
  paintCode(null);

  if (setupReturn && setupReturn.focus) setupReturn.focus();
  setupReturn = null;
}

async function browseFor(input, title) {
  if (input.disabled) return;
  const picked = await api.pickFolder(title, input.value);
  if (picked) input.value = picked;
}

// Where a rejected field lives, so a message about the phone port does not get
// printed under the projects folder on a panel nobody is looking at.
const ERROR_FIELDS = {
  projectsRoot: { panel: 'projects', line: () => setupProjectsError, focus: () => setupProjects },
  backupRoot: { panel: 'backups', line: () => setupBackupError, focus: () => setupBackupRoot },
  remotePort: { panel: 'phone', line: () => setupRemoteError, focus: () => setupRemotePort },
};

async function submitSetup() {
  setupProjectsError.textContent = '';
  setupBackupError.textContent = '';
  setupRemoteError.textContent = '';
  setupSave.disabled = true;

  let result;
  try {
    result = await api.saveConfig({
      projectsRoot: setupProjects.value,
      backupEnabled: setupBackup.checked,
      backupRoot: setupBackupRoot.value,
      remoteEnabled: setupRemote.checked,
      remotePort: Number(setupRemotePort.value),
      autoStart: setupAutoStart.checked,
      startMinimised: setupMinimised.checked,
    });
  } catch (err) {
    result = { ok: false, field: null, message: err.message };
  } finally {
    setupSave.disabled = false;
  }

  if (!result.ok) {
    const where = ERROR_FIELDS[result.field] || ERROR_FIELDS.projectsRoot;
    if (configured) showPanel(where.panel);
    where.line().textContent = result.message;
    where.focus().focus();
    return;
  }

  configured = true;
  const wantedPhone = result.config.remoteEnabled;
  await applySettings(result.config);

  // Turning phone access on and then having the card close on you leaves the
  // one thing you came here for — a pairing code — one click away on a panel
  // you have to find again. So the card stays up, showing what the server did.
  if (wantedPhone && panel === 'phone') {
    refreshRemote();
    return;
  }
  closeSetup();
}

/**
 * Take up the settings that were just saved without a restart.
 *
 * The projects root may have moved, so the sidebar is rebuilt from a fresh
 * listing rather than patched. Open terminals are left alone — they are running
 * shells in directories that still exist, and killing someone's work because
 * they changed a folder setting would be its own bug.
 */
async function applySettings(config) {
  backupsOn = config.backupEnabled;

  const { projects: found, root, ignored } = await api.listProjects();
  projects = found;
  projectsRoot = root || '';
  ignoredNames = ignored || [];
  renderSidebar();
  updateEmpty();

  if (backupsOn) sweepAllProjects();
}

setupSave.addEventListener('click', submitSetup);
setupCancel.addEventListener('click', closeSetup);
setupBackup.addEventListener('change', paintBackupBox);
setupRemote.addEventListener('change', paintRemoteBox);
$('setupprojectsbrowse').addEventListener('click', () => browseFor(setupProjects, 'Where your projects live'));
$('setupbackupbrowse').addEventListener('click', () => browseFor(setupBackupRoot, 'Where backups go'));
$('opensettings').addEventListener('click', () => openSetup());
$('opensettings2').addEventListener('click', () => openSetup());

// Same rule as the new-project modal: a click on the backdrop dismisses, but
// only once it has been answered at least once.
setup.addEventListener('mousedown', (e) => {
  if (e.target === setup && configured) closeSetup();
});

// ---------------------------------------------------------------------- boot

(async function init() {
  syncChrome();
  updateEmpty();

  const state = await api.getConfig();
  backupsOn = state.config.backupEnabled;

  // Nothing has been answered yet, so there is no projects root to list and no
  // point drawing an empty sidebar behind the card. The rest of boot happens in
  // applySettings once it is filled in.
  if (!state.configured) {
    await openSetup(state);
    refreshUsage();
    setInterval(refreshUsage, USAGE_TICK_MS);
    return;
  }

  configured = true;
  await refreshProjects();

  // Terminals outlive this window now — it can be closed to the tray and
  // reopened, and a phone can start one while it is down. So the window is
  // built around whatever is already running rather than assuming an empty
  // list, and each pane is caught up on what it missed.
  try {
    for (const session of await api.listSessions()) await adoptSession(session);
  } catch (err) {
    console.error('Hangar: could not pick up the running terminals', err);
  }

  refreshUsage();
  setInterval(refreshUsage, USAGE_TICK_MS);

  // Not awaited: the sweep runs behind whatever you do next, and every project
  // in it is skipped the moment a terminal starts working there.
  if (backupsOn) sweepAllProjects();
})();
