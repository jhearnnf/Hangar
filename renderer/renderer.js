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

// Silence for this long means the terminal has finished whatever it was doing.
// Claude's TUI animates continuously while working, so it never goes quiet
// mid-task.
const IDLE_MS = 3000;
const CLASSIFY_MS = 150;
const RECENT_CHARS = 4000;

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
  // Cleared up front: anything written while robocopy runs should re-arm the
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
 * costs almost nothing after the first run: robocopy walks a directory it has
 * already mirrored in milliseconds and copies only what moved.
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
  const tab = await createTab(project, command);
  renderSidebar();
  return tab;
}

async function createTab(project, command) {
  const id = 'tab-' + (++idSeq);

  const pane = document.createElement('div');
  pane.className = 'pane';
  panes.appendChild(pane);

  const el = document.createElement('div');
  el.className = 'tab';
  el.innerHTML = '<span class="dot"></span><span class="label"></span><span class="close">✕</span>';
  tablist.appendChild(el);

  const term = new Terminal({
    scrollback: 100_000,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
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
    projectPath: project.path,
    projectName: project.name,
    title: command || 'shell',
    namedBySession: false,
    state: 'ready',
    recent: '',
    pending: 0,
    paused: false,
    dirty: false,
    idleTimer: null,
    classifyTimer: null,
  };

  // Claude Code names its own session — the summary it shows in the header goes
  // out as the terminal title too, and ConPTY turns that into an OSC sequence
  // xterm parses for us. A program describing itself beats anything we can
  // infer, so the first real title takes the tab over for good.
  term.onTitleChange((raw) => {
    const name = Classify.nameFromTitle(raw);
    if (!name) return;
    tab.namedBySession = true;
    setTitle(tab, name);
  });

  // Until then — a plain shell, or claude before it has summarised anything —
  // guess from what the user asked for. Their keystrokes are a cleaner source
  // than the redrawn TUI.
  tab.capture = Classify.createInputCapture((line) => {
    if (!tab.namedBySession) setTitle(tab, Classify.nameFromPrompt(line) || tab.title);
    setState(tab, 'planning');
  });

  tabs.set(id, tab);
  order.push(id);

  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) { e.preventDefault(); closeTab(id); return; }
    if (e.target.classList.contains('close')) return;
    activate(id);
  });
  el.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });

  activate(id);
  updateEmpty();
  fit.fit();

  await api.create({ id, cwd: project.path, command, cols: term.cols, rows: term.rows });

  term.onData((data) => sendInput(tab, data));
  term.onResize(({ cols, rows }) => api.resize(id, cols, rows));

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

function sendInput(tab, data) {
  tab.capture(data);
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
    refit(tab);
    tab.term.focus();
  });
}

function refit(tab) {
  if (!tab || tab.pane.hidden) return;
  try { tab.fit.fit(); } catch { /* pane not laid out yet */ }
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

api.onData(({ id, data }) => {
  const tab = tabs.get(id);
  if (!tab) return;

  tab.pending += data.length;
  if (!tab.paused && tab.pending > HIGH_WATER) {
    tab.paused = true;
    api.flow(id, true);
  }

  tab.term.write(data, () => {
    tab.pending -= data.length;
    if (tab.paused && tab.pending < LOW_WATER) {
      tab.paused = false;
      api.flow(id, false);
    }
  });

  noteOutput(tab, data);
});

function noteOutput(tab, data) {
  tab.recent = (tab.recent + Classify.stripAnsi(data)).slice(-RECENT_CHARS);
  tab.dirty = true;

  // Output is the only reliable sign the project's files may have moved under
  // us. A terminal that never leaves 'ready' — a short command, a stage the
  // classifier does not recognise — would otherwise never queue a backup.
  noteProjectWrite(tab.projectPath);

  clearTimeout(tab.idleTimer);
  tab.idleTimer = setTimeout(() => {
    setState(tab, 'ready');
    // setState is a no-op when the terminal was already resting, so the backup
    // countdown is armed here rather than left to a stage change that may
    // never come.
    paintProject(tab.projectPath);
  }, IDLE_MS);

  // Throttled: the regex sweep is cheap but output arrives many times a second.
  if (!tab.classifyTimer) {
    tab.classifyTimer = setTimeout(() => {
      tab.classifyTimer = null;
      if (!tab.dirty) return;
      tab.dirty = false;
      const state = Classify.classify(tab.recent);
      if (state) setState(tab, state);
    }, CLASSIFY_MS);
  }
}

api.onExit(({ id }) => closeTab(id));

// -------------------------------------------------------------------- resizing

new ResizeObserver(() => refit(tabs.get(activeId))).observe(panes);

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

async function openSetup(state) {
  if (setupOpen()) return;

  const { configured: everSaved, config, suggested, env } = state || await api.getConfig();
  configured = everSaved;

  setupReturn = document.activeElement;
  setupProjectsError.textContent = '';
  setupBackupError.textContent = '';

  // A first run has nothing saved to show, so the fields open on the guesses.
  setupProjects.value = everSaved ? config.projectsRoot : suggested.projectsRoot;
  setupBackupRoot.value = (everSaved && config.backupRoot) || suggested.backupRoot;
  setupBackup.checked = everSaved ? config.backupEnabled : Boolean(suggested.dropbox);
  paintBackupBox();

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

  setup.hidden = false;
  (setupProjects.disabled ? setupSave : setupProjects).focus();
}

function closeSetup() {
  if (!setupOpen()) return;
  setup.hidden = true;
  if (setupReturn && setupReturn.focus) setupReturn.focus();
  setupReturn = null;
}

async function browseFor(input, title) {
  if (input.disabled) return;
  const picked = await api.pickFolder(title, input.value);
  if (picked) input.value = picked;
}

async function submitSetup() {
  setupProjectsError.textContent = '';
  setupBackupError.textContent = '';
  setupSave.disabled = true;

  let result;
  try {
    result = await api.saveConfig({
      projectsRoot: setupProjects.value,
      backupEnabled: setupBackup.checked,
      backupRoot: setupBackupRoot.value,
    });
  } catch (err) {
    result = { ok: false, field: null, message: err.message };
  } finally {
    setupSave.disabled = false;
  }

  if (!result.ok) {
    const target = result.field === 'backupRoot' ? setupBackupError : setupProjectsError;
    target.textContent = result.message;
    if (result.field === 'backupRoot') setupBackupRoot.focus();
    else setupProjects.focus();
    return;
  }

  configured = true;
  closeSetup();
  await applySettings(result.config);
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
$('setupprojectsbrowse').addEventListener('click', () => browseFor(setupProjects, 'Where your projects live'));
$('setupbackupbrowse').addEventListener('click', () => browseFor(setupBackupRoot, 'Where backups go'));
$('opensettings').addEventListener('click', () => openSetup());

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
  const { projects: found, root, ignored } = await api.listProjects();
  projects = found;
  projectsRoot = root || '';
  ignoredNames = ignored || [];
  renderSidebar();

  refreshUsage();
  setInterval(refreshUsage, USAGE_TICK_MS);

  // Not awaited: the sweep runs behind whatever you do next, and every project
  // in it is skipped the moment a terminal starts working there.
  if (backupsOn) sweepAllProjects();
})();
