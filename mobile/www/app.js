'use strict';

/* global createClient, Terminal, Unicode11Addon */

/**
 * Hangar, on a phone.
 *
 * The PC does everything. This is a viewer with a keyboard attached: it lists
 * the projects and terminals the PC reports, draws whatever they print, and
 * sends back what you type. Nothing here decides anything about a terminal —
 * not its name, not its colour, not when it is finished — because the PC has
 * already decided all of that for the window sitting in front of it, and two
 * screens disagreeing about which terminal is which is worse than either being
 * wrong on its own.
 */

const $ = (id) => document.getElementById(id);
const store = {
  get: (key, fallback = null) => {
    try { return JSON.parse(localStorage.getItem('hangar.' + key)) ?? fallback; } catch { return fallback; }
  },
  set: (key, value) => { try { localStorage.setItem('hangar.' + key, JSON.stringify(value)); } catch { /* full */ } },
  drop: (key) => { try { localStorage.removeItem('hangar.' + key); } catch { /* nothing to do */ } },
};

// `monospace` last and doing the real work: on Android it is whatever that
// device ships as its fixed-width face, which is always a real one. The named
// families ahead of it are a preference, not a requirement — a name that is not
// installed is skipped, and the generic is what stops the list ever falling
// through to a proportional font, which xterm would then lay out on a fixed
// grid with the wide glyphs overlapping their neighbours.
const FONT = 'ui-monospace, "Roboto Mono", "Droid Sans Mono", monospace';
const LINE_HEIGHT = 1.15;

// Below about this, glyph hinting on a phone runs the letters into each other
// and the terminal turns to grey mush. Better to clip a too-wide grid at a size
// that can be read than to fit all of it at a size that cannot.
const MIN_FONT = 9;

const THEME = {
  background: '#12141a', foreground: '#c9d1d9', cursor: '#4d9cf6', cursorAccent: '#12141a',
  selectionBackground: '#2d4b6e',
  black: '#12141a', red: '#f47067', green: '#57ab5a', yellow: '#c69026', blue: '#539bf5',
  magenta: '#b083f0', cyan: '#39c5cf', white: '#adbac7',
  brightBlack: '#545d68', brightRed: '#ff938a', brightGreen: '#6bc46d', brightYellow: '#daaa3f',
  brightBlue: '#6cb6ff', brightMagenta: '#dcbdfb', brightCyan: '#56d4dd', brightWhite: '#e6edf3',
};

// ------------------------------------------------------------------ state

let projects = [];
const sessions = new Map();   // id -> the PC's summary of it
const views = new Map();      // id -> { term, el, seq }
let openId = null;            // the terminal being looked at, if any
let host = store.get('host', '');
let port = store.get('port', 7433);
let fontSize = store.get('fontSize', 12);
let rawMode = store.get('rawMode', false);
// On by default, which is the opposite of what it was and the opposite of what
// seemed obvious. Mirroring the PC's exact layout sounds like the respectful
// thing to do until you work out what it means: a 160-column terminal shrunk
// into a phone is four-pixel text, which is not small — it is unreadable, the
// letters run together, and it looks like the font is broken rather than like a
// deliberate choice. A terminal reflowed to the width of the screen you are
// actually holding is legible, and the ⋮ menu still has the other one.
let claimSize = store.get('claimSize', true);
let pcName = '';

// Which agent the PC opens for you, sent with the welcome and again whenever
// its Settings change. Only ever what the PC last said: this is one setting for
// the machine, and a phone with an opinion of its own about it would be a way
// to start the wrong one from across the room. The pill in the header asks the
// PC to change it, and this follows once the PC says it has.
let agent = { id: 'claude', label: 'claude', command: 'claude' };
// What the pill can switch to, and why it cannot, when it cannot.
let agents = [];
let agentLocked = null;

function takeAgentInfo(message) {
  if (message.agent) agent = message.agent;
  if (Array.isArray(message.agents)) agents = message.agents;
  if ('agentLocked' in message) agentLocked = message.agentLocked;
  $('agentpick').textContent = agent.label;
  // A PC from before phones could switch sends no list; the pill still names
  // the agent but offers nothing it cannot do.
  $('agentpick').disabled = agents.length < 2;
}

// Whether this phone has ever got as far as a welcome from this PC. It decides
// whether a dropped connection is a note in the header or a trip back to the
// form — the difference between "the wifi blinked" and "this has never worked".
let everConnected = false;

const client = createClient({
  state: onState,
  welcome: onWelcome,
  paired: onPaired,
  unpaired: onUnpaired,
  unreachable: onUnreachable,
  session: onSession,
  data: onData,
  exit: onExit,
  created: onCreated,
  projects: onProjects,
  newProject: onNewProject,
  recent: onRecent,
  usage: onUsage,
  info: onInfo,
  error: (m) => toast(m.message),
});

// ----------------------------------------------------------------- screens

function show(name) {
  for (const screen of document.querySelectorAll('.screen')) screen.hidden = screen.id !== name;
  // The terminal is a screen over the top of the app rather than one of the
  // three you can tab between, so the bar goes away under it.
  $('nav').hidden = name === 'connect' || name === 'term';

  for (const button of document.querySelectorAll('.nav-btn')) {
    button.classList.toggle('on', button.dataset.screen === name);
  }

  if (name === 'projects') client.send({ t: 'usage' });
  if (name === 'settings') paintSettings();
}

for (const button of document.querySelectorAll('.nav-btn')) {
  button.addEventListener('click', () => show(button.dataset.screen));
}

let toastTimer = null;
function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 3200);
}

// ----------------------------------------------------------------- connect

function onState(state) {
  const line = $('connectstate');
  if (state === 'online') return;

  if (state === 'connecting') line.textContent = `Connecting to ${host}…`;
  else if (state === 'reconnecting') line.textContent = 'Lost the PC — trying again…';
  else if (state === 'offline') line.textContent = `No answer from ${host}. Is Hangar running?`;

  // A drop mid-session is not a reason to throw the user back to a form; the
  // client is already trying, and the terminal they were reading is still on
  // screen. Only say so.
  if (!$('connect').hidden) return;
  if (state === 'offline' || state === 'reconnecting') {
    $('pchost').textContent = 'reconnecting…';
    $('pchost').classList.add('warn');
  }
}

function onWelcome(message) {
  pcName = message.name || 'the PC';
  takeAgentInfo(message);
  everConnected = true;
  store.set('host', host);
  store.set('port', port);
  store.set('token', client.token());

  $('pchost').textContent = pcName;
  $('pchost').classList.remove('warn');
  $('connecterror').textContent = '';

  projects = message.projects || [];
  sessions.clear();
  for (const session of message.sessions || []) sessions.set(session.id, session);

  paintProjects();
  paintTerminals();

  // A terminal that was being read before the drop is still the one being
  // read. Re-attaching happens in the client; this puts the pane back.
  if (openId && sessions.has(openId)) openTerminal(openId);
  else if ($('connect').hidden === false) show('projects');
  else if (openId) { openId = null; show('projects'); }

  client.send({ t: 'usage' });
}

function onPaired() {
  store.set('token', client.token());
  $('pairfield').hidden = true;
  $('code').value = '';
  toast('Paired with this PC.');
}

function onUnpaired(message) {
  store.drop('token');
  $('pairfield').hidden = false;
  $('connecterror').textContent = message;
  $('connectstate').textContent = 'This phone needs pairing.';
  show('connect');
}

/**
 * Say why nothing happened, in terms of what to go and do about it.
 *
 * "Connecting…" forever is the worst thing this screen can say, because every
 * cause of it looks identical from here and none of them are on the phone. The
 * two failures are told apart by how long the attempt took (see client.js) and
 * they want opposite fixes, so they get opposite messages.
 */
function onUnreachable({ reason, host: where, port: onPort }) {
  // Mid-session, this is a note in the header: the terminal being read is still
  // on screen, the client is still trying, and throwing the whole app back to a
  // form because the wifi blinked would be its own bug. Before the first
  // connection there is nothing to protect, and the form is where the answer is.
  if ($('connect').hidden && everConnected) {
    $('pchost').textContent = 'no answer';
    $('pchost').classList.add('warn');
    return;
  }
  show('connect');

  if (reason === 'refused') {
    $('connectstate').textContent = `${where} answered, but nothing is listening on ${onPort}.`;
    $('connecterror').textContent =
      'Hangar is probably not running on that PC, or Settings → Phone is not ticked. '
      + 'Check the port matches the one it shows.';
    return;
  }

  $('connectstate').textContent = `No answer at all from ${where}.`;
  $('connecterror').textContent =
    'Something is dropping the connection rather than refusing it — nearly always Windows '
    + 'Firewall on the PC, or a guest wifi network that keeps devices apart. On the PC, '
    + 'check Settings → Phone: it says whether the network is one Windows is blocking. '
    + 'Also check this phone is on the same wifi, not the guest one.';
}

async function connectNow() {
  host = $('host').value.trim();
  port = Number($('port').value) || 7433;
  const code = $('code').value.trim().toUpperCase();
  const token = store.get('token');

  if (!host) {
    $('connecterror').textContent = 'Type the address shown on the PC, or tap Find my PC.';
    return;
  }

  // Without one of these the socket would open, sit there saying nothing, and
  // be closed by the PC half a minute later — which reads exactly like a
  // network that is not working, and is not one.
  if (!token && !code) {
    $('pairfield').hidden = false;
    $('connecterror').textContent =
      'This phone has not been paired yet. On the PC: Settings → Phone → Show a code, '
      + 'then type those six characters here.';
    $('code').focus();
    return;
  }

  $('connecterror').textContent = '';
  $('connectstate').textContent = `Connecting to ${host}…`;
  client.connect({ host, port, token, code: code || null, name: deviceName() });
}

function deviceName() {
  // Android does not hand a WebView the phone's name, and a made-up one is
  // worse than none: the list on the PC has to be readable enough to know
  // which phone to remove. The model out of the user agent is the closest
  // thing to a name that is actually true.
  const match = /Android[^;]*;\s*([^)]+?)(?:\s+Build|\))/.exec(navigator.userAgent);
  return (match && match[1].trim()) || 'A phone';
}

$('connectgo').addEventListener('click', connectNow);
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectNow(); });
$('host').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectNow(); });

/**
 * Ask the network where Hangar is.
 *
 * A WebView cannot send a UDP broadcast, so this is the one thing on the phone
 * that needs native code — a small plugin in the Android project that shouts
 * and collects the answers. Where it is missing (a browser, an older build)
 * the address field is still there and still works, so this is a convenience
 * that fails into a form rather than a dead end.
 */
async function scan() {
  const button = $('scan');
  const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Discovery;

  if (!plugin) {
    $('connecterror').textContent =
      'This build cannot search the network. Type the address the PC shows under Settings → Phone.';
    return;
  }

  button.disabled = true;
  $('connectstate').textContent = 'Listening for Hangar on this network…';
  $('found').textContent = '';

  let result;
  try {
    result = await plugin.find({ timeout: 2000 });
  } catch (err) {
    result = { hosts: [] };
  }
  button.disabled = false;

  const hosts = (result && result.hosts) || [];
  if (!hosts.length) {
    $('connectstate').textContent = 'Nothing answered.';
    $('connecterror').textContent =
      'Either Hangar is not running with Settings → Phone ticked, or something is dropping '
      + 'the question: Windows Firewall on the PC, or a guest wifi that keeps devices apart. '
      + 'The PC shows its address under Settings → Phone — typing it in below works even when '
      + 'searching does not.';
    return;
  }

  $('connectstate').textContent = hosts.length === 1 ? 'Found it.' : 'Found these:';
  for (const found of hosts) {
    const row = document.createElement('button');
    row.className = 'found-row';
    row.innerHTML = '<span class="found-name"></span><span class="found-addr"></span>';
    row.querySelector('.found-name').textContent = found.name || 'Hangar';
    row.querySelector('.found-addr').textContent = `${found.address}:${found.port}`;
    row.addEventListener('click', () => {
      $('host').value = found.address;
      $('port').value = found.port;
      connectNow();
    });
    $('found').appendChild(row);
  }
}

$('scan').addEventListener('click', scan);

// ---------------------------------------------------------------- projects

function onProjects(message) {
  projects = message.projects || [];
  paintProjects();
}

function terminalsIn(projectPath) {
  return [...sessions.values()].filter((s) => s.projectPath === projectPath);
}

// Work moves through these in order, so a project wears the earliest stage any
// terminal under it is in — the same rule the sidebar on the PC uses.
const STAGES = ['planning', 'implementing', 'testing', 'ready'];

function projectStage(projectPath) {
  const states = terminalsIn(projectPath).map((s) => s.state);
  return STAGES.find((s) => states.includes(s)) || null;
}

function paintProjects() {
  const list = $('projectlist');
  list.textContent = '';

  for (const project of projects) {
    const mine = terminalsIn(project.path);

    const row = document.createElement('div');
    row.className = 'row project-row' + (projectStage(project.path) ? ' state-' + projectStage(project.path) : '');
    row.innerHTML = '<span class="dot"></span><span class="row-name"></span>'
      + '<span class="row-count"></span><button class="row-add" aria-label="New terminal">+</button>';
    row.querySelector('.row-name').textContent = project.name;
    row.querySelector('.row-count').textContent = mine.length ? String(mine.length) : '';

    // Tapping the row opens an agent terminal, which is what you came for.
    // The + offers the choice of a plain shell, and holding the row offers the
    // sessions this project has already had — the phone's answer to the
    // right-click menu in the PC's sidebar.
    wireRowGestures(row, {
      tap: (e) => {
        if (e.target.closest('.row-add')) return;
        if (mine.length) openTerminal(mine[0].id);
        else newTerminal(project, agent.command);
      },
      hold: () => askRecent(project),
    });
    row.querySelector('.row-add').addEventListener('click', (e) => {
      e.stopPropagation();
      sheet(`New terminal in ${project.name}`, [
        { label: `Run ${agent.label}`, run: () => newTerminal(project, agent.command) },
        { label: 'Plain shell', run: () => newTerminal(project, null) },
        { label: 'Back up this project now', run: () => client.send({ t: 'backup', projectPath: project.path }) },
      ]);
    });
    list.appendChild(row);

    for (const session of mine) list.appendChild(terminalRow(session, true));
  }

  if (!projects.length) {
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'No projects in the folder the PC is pointed at.';
    list.appendChild(none);
  }
}

function terminalRow(session, nested) {
  const row = document.createElement('div');
  row.className = 'row term-row state-' + session.state + (nested ? ' nested' : '');
  row.innerHTML = '<span class="dot"></span><span class="row-name"></span>'
    + '<span class="row-sub"></span><button class="row-x" aria-label="Close">✕</button>';
  row.querySelector('.row-name').textContent = session.title;
  row.querySelector('.row-sub').textContent = nested ? '' : session.projectName;
  row.addEventListener('click', (e) => {
    if (e.target.closest('.row-x')) return;
    openTerminal(session.id);
  });
  row.querySelector('.row-x').addEventListener('click', (e) => {
    e.stopPropagation();
    client.send({ t: 'kill', id: session.id });
  });
  return row;
}

function paintTerminals() {
  const list = $('terminallist');
  list.textContent = '';

  const all = [...sessions.values()];
  if (!all.length) {
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'Nothing running. Open one from Projects.';
    list.appendChild(none);
    return;
  }
  for (const session of all) list.appendChild(terminalRow(session, false));
}

// ------------------------------------------- holding a project down

// How long a finger has to stay put. Android's own long press is around half a
// second, so this is what a thumb already expects.
const HOLD_MS = 500;

// A finger resting on a screen still moves a little. Past this it was a scroll,
// and a list that opened a menu every time it was flicked would be unusable.
const HOLD_SLOP = 10;

/**
 * Give a row both gestures: a tap and a hold.
 *
 * Both live in here rather than in two listeners because only one of them can
 * win, and the losing one has to be swallowed — a hold that opened its menu and
 * then let the tap through would open a terminal behind it. The browser sends
 * the click after the finger lifts either way, so the hold marks itself as
 * having happened and the click is dropped.
 *
 * `contextmenu` is wired to the same thing, which is what a WebView fires on a
 * long press when it decides to, and what a right-click sends in the desktop
 * browser this client is also served to. Both routes go through `fire`, which
 * only lets the first of them through.
 */
function wireRowGestures(el, { tap, hold }) {
  let timer = null;
  let from = null;
  let held = false;

  const cancel = () => { clearTimeout(timer); timer = null; };

  const fire = () => {
    if (held) return;
    held = true;
    cancel();
    // The little bump that says the press registered. Not every phone has one,
    // and a browser will not have the API at all.
    if (navigator.vibrate) navigator.vibrate(12);
    hold();
  };

  // A button inside the row is its own thing with its own action, so holding
  // one is not holding the row — otherwise resting a thumb on `+` would open
  // the resume list behind the menu it was already opening.
  const onButton = (e) => Boolean(e.target.closest && e.target.closest('button'));

  el.addEventListener('touchstart', (e) => {
    held = false;
    cancel();
    if (e.touches.length !== 1 || onButton(e)) return;
    from = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    timer = setTimeout(fire, HOLD_MS);
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!timer || !e.touches.length) return;
    const dx = e.touches[0].clientX - from.x;
    const dy = e.touches[0].clientY - from.y;
    if (Math.hypot(dx, dy) > HOLD_SLOP) cancel();
  }, { passive: true });

  el.addEventListener('touchend', cancel, { passive: true });
  el.addEventListener('touchcancel', cancel, { passive: true });

  // A mouse, in the browser the PC also serves this page to.
  el.addEventListener('mousedown', () => { held = false; });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!onButton(e)) fire();
  });

  el.addEventListener('click', (e) => {
    if (held) return;   // the hold already answered this press
    tap(e);
  });
}

/** How long ago, at the granularity someone actually thinks in. */
function ago(at) {
  const secs = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (secs < 90) return 'just now';

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Which project the sheet on screen is waiting on an answer for. The PC reads
// two files to answer, and over wifi that is long enough for a thumb to have
// let go and pressed something else.
let recentWaiting = null;

function recentTitle(project) {
  return `Resume ${agent.label} in ${project.name}`;
}

function askRecent(project) {
  recentWaiting = project;
  client.send({ t: 'recent', projectPath: project.path });
  // The sheet goes up straight away, so the press is visibly acknowledged
  // rather than appearing to have missed for as long as the round trip takes.
  sheet(recentTitle(project), [{ label: 'Looking…' }]);
}

function onRecent(message) {
  const project = recentWaiting;
  if (!project || message.projectPath !== project.path) return;
  recentWaiting = null;
  // Dismissed while we were asking, which is an answer of its own.
  if ($('sheet').hidden) return;

  const rows = message.rows || [];
  if (!rows.length) {
    sheet(recentTitle(project), [{ label: 'Nothing to resume here yet.' }]);
    return;
  }

  sheet(recentTitle(project), rows.map((row) => ({
    label: row.label,
    note: ago(row.at),
    live: row.live,
    // A session that is already running is shown and not resumed: opening it
    // again would put two of them on the one conversation, both appending.
    // It still answers the tap, because a row that did nothing at all on a
    // phone — where there is no tooltip to hover for the reason — would just
    // look broken.
    run: row.live
      ? () => toast('That one is open already. Close it and it can be resumed.')
      : () => newTerminal(project, row.command),
  })));
}

/**
 * The PC's settings changed while we were connected.
 *
 * Only the half of the welcome that can change under a live connection, which
 * today is which agent the + opens. Repainting the project list is what puts
 * the new name on the buttons.
 */
function onInfo(message) {
  const before = agent.id;
  takeAgentInfo(message);
  paintProjects();
  // The bars are the agent's, so a switch makes the ones on screen wrong.
  if (agent.id !== before) {
    $('usage').hidden = true;
    client.send({ t: 'usage' });
  }
}

$('agentpick').addEventListener('click', () => {
  if (agentLocked) {
    toast(agentLocked);
    return;
  }
  sheet('New terminals open', agents.map((option) => ({
    label: option.id === agent.id ? `${option.name} ✓` : option.name,
    run: option.id === agent.id ? null : () => client.send({ t: 'agent', id: option.id }),
  })));
});

function newTerminal(project, command) {
  const size = claimSize ? phoneSize() : { cols: 100, rows: 30 };
  client.send({
    t: 'create',
    projectPath: project.path,
    projectName: project.name,
    command,
    cols: size.cols,
    rows: size.rows,
    claim: claimSize,
  });
}

$('newproject').addEventListener('click', () => {
  ask('New project folder', '', (name) => client.send({ t: 'newProject', name }));
});

function onNewProject(message) {
  if (message.ok) toast(`Created ${message.project.name}`);
  else promptError(message.message);
}

// --------------------------------------------------------------- sessions

function onSession({ kind, session }) {
  if (kind === 'closed') sessions.delete(session.id);
  else sessions.set(session.id, session);

  paintProjects();
  paintTerminals();

  if (session.id === openId) {
    if (kind === 'closed') closeTerminal();
    else paintTermBar(session);
  }
}

function onExit({ id }) {
  sessions.delete(id);
  const view = views.get(id);
  if (view) {
    view.term.dispose();
    view.el.remove();
    views.delete(id);
  }
  if (id === openId) closeTerminal();
  paintProjects();
  paintTerminals();
}

function onCreated({ session }) {
  sessions.set(session.id, session);
  paintProjects();
  paintTerminals();
  openTerminal(session.id);
}

function onData({ id, data, reset }) {
  const view = views.get(id);
  if (!view) return;
  // The PC could not give us everything we asked for — what we were up to has
  // scrolled out of its buffer. Anything already on screen is now the wrong
  // end of a gap, so it goes rather than being written onto.
  if (reset) view.term.reset();
  view.term.write(data, reset ? () => markOldWidth(view) : undefined);
}

/**
 * Draw a line under history that was printed at a different width.
 *
 * What the PC sends back is the bytes it printed, not text: a program that drew
 * a box eighty characters wide put that box's right-hand edge at column eighty,
 * and there is no honest way to show that on a screen with fifty-seven columns.
 * It wraps, and the wrapped-off ends collect down the right-hand side — a word
 * fragment on the left, one stray character on the right, which reads as a
 * broken app rather than as a picture that does not fit.
 *
 * Checked before assuming it could be fixed: replaying those bytes at the width
 * they were printed at and re-laying them out afterwards gives the same result,
 * character for character. Nothing was lost on the way — it genuinely does not
 * fit.
 *
 * So the line says which it is. Everything below it was printed at this phone's
 * width and is laid out properly; everything above was printed at the PC's, and
 * the ⋮ menu will show it as it was.
 */
function markOldWidth(view) {
  const printedAt = view.historyCols;
  if (!printedAt || printedAt === view.term.cols) return;

  // Only when there is something up there to scroll back to. A terminal opened
  // from this phone a second ago has a prompt and nothing else, and its width
  // can still differ by a column or two from what was asked for — a line
  // announcing history above a screen with no history above it explains
  // nothing.
  view.historyCols = null;
  if (view.term.buffer.active.baseY === 0) return;

  const label = ` above: printed at the PC's ${printedAt} columns `;
  const rule = '─'.repeat(Math.max(0, Math.floor((view.term.cols - label.length) / 2)));
  view.term.write(`\r\n[2m${rule}${label}${rule}[0m\r\n`);
}

// ---------------------------------------------------------------- terminal

function makeView(session) {
  const el = document.createElement('div');
  el.className = 'term-pane';
  $('termhost').appendChild(el);

  const term = new Terminal({
    scrollback: 5000,
    fontFamily: FONT,
    fontSize,
    lineHeight: LINE_HEIGHT,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
    scrollOnUserInput: true,
    smoothScrollDuration: 0,
    // Off by default: the phone keyboard belongs to the compose box below
    // unless raw typing has been asked for, and a terminal that takes focus on
    // every tap makes the whole screen jump.
    disableStdin: !rawMode,
    theme: THEME,
  });

  try {
    term.loadAddon(new Unicode11Addon.Unicode11Addon());
    term.unicode.activeVersion = '11';
  } catch { /* the fallback widths are close enough */ }

  term.open(el);
  term.onData((data) => client.send({ t: 'input', id: session.id, data }));

  const view = { term, el };
  wireTouchScroll(view);
  views.set(session.id, view);
  return view;
}

/**
 * Scrolling with a finger.
 *
 * xterm does not do this. Its viewport answers a wheel and a scrollbar drag,
 * and a phone has neither — a touch drag reaches it as nothing whatsoever,
 * which is why the terminal sat at the bottom however hard it was pulled at.
 * Measured rather than assumed: a simulated drag across 250px moved the
 * viewport not one line, while a single wheel event over the same terminal
 * moved it three.
 *
 * So the drag becomes scrolling here, a line for every line-height of travel,
 * in whichever form the program in front of you understands.
 */
function wireTouchScroll(view) {
  let last = 0;        // where the finger was last seen
  let carry = 0;       // travel not yet worth a whole line
  let dragging = false;

  view.el.addEventListener('touchstart', (e) => {
    dragging = e.touches.length === 1;
    if (dragging) {
      last = e.touches[0].clientY;
      carry = 0;
    }
  }, { passive: true });

  view.el.addEventListener('touchmove', (e) => {
    if (!dragging || e.touches.length !== 1) return;

    const y = e.touches[0].clientY;
    carry += y - last;
    last = y;

    // Truncated toward zero so the two directions behave the same, and the
    // remainder kept, so a slow drag still moves rather than rounding to
    // nothing every frame.
    const cell = cellSize(view).h;
    const lines = Math.trunc(carry / cell);
    if (!lines) return;
    carry -= lines * cell;

    e.preventDefault();
    scrollByLines(view, -lines);   // a finger pulled downwards looks backwards
  }, { passive: false });

  const stop = () => { dragging = false; };
  view.el.addEventListener('touchend', stop, { passive: true });
  view.el.addEventListener('touchcancel', stop, { passive: true });
}

/**
 * Move a terminal by whole lines, negative being back into what it printed
 * earlier — for whichever of the two kinds of terminal this is.
 *
 * Ordinary output has real scrollback and the view moves through it. A
 * full-screen program — claude, vim, top — has none: it painted over the whole
 * screen and kept nothing behind it, so there is nothing to move through and
 * the scroll has to be handed to the program instead. Which is what a wheel
 * does on the desktop, and the rules here are the ones xterm itself uses for
 * one: a mouse event if the program asked for the mouse, arrow keys if it did
 * not.
 */
function scrollByLines(view, lines) {
  const term = view.term;

  if (term.buffer.active.type === 'normal') {
    term.scrollLines(lines);
    return;
  }

  // Capped: a flick that would send forty keystrokes into a program is not
  // what anyone meant by it.
  const count = Math.min(Math.abs(lines), 5);
  const up = lines < 0;

  if (term.modes.mouseTrackingMode !== 'none') {
    // Encoded by xterm, because only it knows which of the four mouse
    // encodings the program asked for, and what comes out arrives back through
    // term.onData like anything else typed.
    //
    // Which is also why stdin is opened for the length of the call: while the
    // compose box owns the keyboard xterm is told to accept nothing, and that
    // gate swallows the report along with everything else. It is shut again
    // before the call returns — the encoding is synchronous, and no keystroke
    // can get through in between.
    const core = term._core && term._core.coreMouseService;
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor(term.rows / 2)));
    let reported = false;

    if (core && typeof core.triggerMouseEvent === 'function') {
      const shut = term.options.disableStdin;
      term.options.disableStdin = false;
      try {
        for (let i = 0; i < count; i++) {
          // Button 4 is the wheel; actions 0 and 1 are its two directions.
          const ok = core.triggerMouseEvent({ col: 0, row, button: 4, action: up ? 0 : 1, ctrl: false, alt: false, shift: false });
          reported = reported || ok;
        }
      } finally {
        term.options.disableStdin = shut;
      }
    }

    // A program can have the mouse switched on and still refuse a wheel, so a
    // report that was turned down falls through to the keys below rather than
    // to nothing at all.
    if (reported) return;
  }

  const key = (term.modes.applicationCursorKeysMode ? 'O' : '[') + (up ? 'A' : 'B');
  client.send({ t: 'input', id: openId, data: key.repeat(count) });
}

function openTerminal(id) {
  const session = sessions.get(id);
  if (!session) return;

  openId = id;
  show('term');

  let view = views.get(id);
  if (!view) {
    view = makeView(session);
    // The width the PC is at right now, which is the width everything it is
    // about to send back was printed at. Read before the claim below moves it,
    // because after that the session says this phone's width and the bytes
    // still say the PC's.
    view.historyCols = session.cols;
    client.attach(id);
  }

  for (const [otherId, other] of views) other.el.hidden = otherId !== id;

  paintTermBar(session);
  fitTerminal({ force: true });
  if (rawMode) view.term.focus();
}

function closeTerminal() {
  if (openId) client.detach(openId);
  openId = null;
  show('terminals');
}

$('termback').addEventListener('click', closeTerminal);

function paintTermBar(session) {
  $('termtitle').textContent = session.title;
  $('termdot').className = 'dot state-' + session.state;
}

/**
 * Make the PC's terminal fit a phone.
 *
 * Two terminals, one width. The PC's window owns it by default, so what
 * happens here is that the same grid is drawn at whatever text size makes all
 * of it visible — small, but complete, and readable in landscape. The other
 * way round is one tap in the ⋮ menu: the phone claims the width, the PC
 * letterboxes, and the text goes back to a comfortable size.
 */
function fitTerminal(opts = {}) {
  applyFit(opts);

  // What a character cell really measures is only known once xterm has drawn at
  // the new font size, so the first pass works from the previous measurement
  // and can be a row out. A second pass on the next frame, from what was
  // actually drawn, settles it — and resizing to the size it already is costs
  // nothing.
  if (!opts.again) {
    requestAnimationFrame(() => { if (openId) applyFit({ again: true }); });
  }
}

function applyFit({ force = false } = {}) {
  const view = views.get(openId);
  const session = sessions.get(openId);
  if (!view || !session) return;

  // Not while this phone is in a pocket. A dropped connection coming back puts
  // the open terminal back on screen, and that used to claim the width — so a
  // phone left with a terminal open would reach round from the next room and
  // reflow a terminal someone at the PC was in the middle of using. Nothing
  // here is worth doing for a screen nobody is looking at, and coming back to
  // it fits again below.
  if (document.hidden) return;

  const box = $('termhost');
  const width = box.clientWidth;
  const height = box.clientHeight;
  if (!width || !height) return;

  if (claimSize) {
    if (view.term.options.fontSize !== fontSize) view.term.options.fontSize = fontSize;

    const cell = cellSize(view);
    const cols = Math.max(20, Math.floor(width / cell.w));
    const rows = Math.max(8, Math.floor(height / cell.h));
    view.term.resize(cols, rows);

    // Only when it has actually changed. This runs on every viewport change,
    // and the soft keyboard opening is a viewport change — so without the guard
    // every tap on the compose box would reflow the shell on the PC, and a TUI
    // repaints itself from scratch each time that happens.
    //
    // Opening a terminal is the exception and has to send regardless: the PC
    // takes the width back whenever someone sits down at it, so the size can be
    // unchanged here while the claim behind it has quietly gone.
    if (force || view.cols !== cols || view.rows !== rows) {
      view.cols = cols;
      view.rows = rows;
      client.send({ t: 'resize', id: openId, cols, rows, claim: true });
    }
    return;
  }

  // Mirroring the PC's grid: the rows are fixed at what the PC has, so the font
  // is the thing that gives. Scaled from a real cell at the size it is drawn at
  // now, rather than from what a cell that size ought to measure.
  const cell = cellSize(view);
  const at = view.term.options.fontSize || fontSize;
  const byWidth = (width * at) / (session.cols * cell.w);
  const byHeight = (height * at) / (session.rows * cell.h);

  // Clipped rather than shrunk past legibility. Whatever does not fit runs off
  // the edge, and the ⋮ menu can reflow it to this screen instead — which is
  // the answer, and is what happens by default.
  const size = Math.max(MIN_FONT, Math.floor(Math.min(byWidth, byHeight)));

  if (view.term.options.fontSize !== size) view.term.options.fontSize = size;
  view.term.resize(session.cols, session.rows);
}

/**
 * What one character cell actually measures, in CSS pixels.
 *
 * Taken from what xterm drew rather than worked out from the font size, because
 * a row is not `fontSize × lineHeight`: xterm measures the face's own height,
 * which is a good deal taller than its point size, and then rounds the row up to
 * a whole pixel. Guessing low means asking for more rows than there is room for,
 * and the last two or three end up behind the compose bar — which is exactly
 * what was happening.
 */
function cellSize(view) {
  const core = view.term._core;
  const cell = core && core._renderService && core._renderService.dimensions
    && core._renderService.dimensions.css && core._renderService.dimensions.css.cell;
  if (cell && cell.width > 0 && cell.height > 0) return { w: cell.width, h: cell.height };
  return estimateCell(view.term.options.fontSize || fontSize);
}

/**
 * A cell's size before there is one to measure — a terminal being opened, or one
 * being asked for that the PC has not started yet. Deliberately generous on the
 * height so the guess asks for too few rows rather than too many: a gap above
 * the compose bar for one frame is invisible, a clipped last line is not.
 */
function estimateCell(size) {
  return { w: size * charRatio(), h: Math.ceil(size * LINE_HEIGHT * 1.3) };
}

/**
 * How wide one character is, as a fraction of the font size.
 *
 * Measured rather than assumed: it is 0.6 for most monospace faces and not for
 * all of them, and being wrong by a twentieth costs a column at the right-hand
 * edge. But a canvas quietly ignores a font it cannot parse and keeps whatever
 * it had — 10px sans-serif — so an unusable answer here would come back as a
 * confident 0.08 and ask for four hundred columns. Anything outside the range
 * real monospace faces actually occupy is treated as not having measured.
 */
let ratioCache = null;
function charRatio() {
  if (ratioCache) return ratioCache;

  let measured = 0;
  try {
    const canvas = document.createElement('canvas').getContext('2d');
    canvas.font = `100px ${FONT}`;
    measured = canvas.measureText('M').width / 100;
  } catch {
    measured = 0;
  }

  ratioCache = measured >= 0.35 && measured <= 1 ? measured : 0.6;
  return ratioCache;
}

/**
 * The grid this phone would like, for a terminal that does not exist yet and so
 * has nothing to measure. Whatever this gets wrong is corrected the moment the
 * terminal opens and a real cell can be measured.
 */
function phoneSize() {
  const box = $('termhost');
  const cell = estimateCell(fontSize);
  const width = box.clientWidth || window.innerWidth;
  const height = box.clientHeight || window.innerHeight * 0.5;
  return {
    cols: Math.max(20, Math.floor(width / cell.w)),
    rows: Math.max(8, Math.floor(height / cell.h)),
  };
}

// Anything that changes the shape of the box the terminal lives in: the soft
// keyboard opening, rotation, and — the one that was getting missed — the
// compose box growing a line as a longer prompt is typed into it. The terminal
// has to give those rows up rather than have its last lines end up underneath.
if (window.ResizeObserver) {
  new ResizeObserver(() => { if (openId) fitTerminal(); }).observe($('termhost'));
}

// Belt and braces for the viewport changes a WebView reports without the box
// itself changing size.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => { if (openId) fitTerminal(); });
}
window.addEventListener('orientationchange', () => setTimeout(() => { if (openId) fitTerminal(); }, 250));
window.addEventListener('resize', () => { if (openId) fitTerminal(); });

// ------------------------------------------------------------ typing to it

// What each key on the strip actually sends. Arrows and Esc are the ones a
// phone keyboard simply does not have; 1, 2 and 3 are there because they are
// the answers to an agent's permission prompts and hunting for them on a number
// row you have to switch layouts to reach is the single most annoying thing
// about driving an agent from a phone.
const KEYS = {
  esc: '',
  tab: '\t',
  up: '[A',
  down: '[B',
  right: '[C',
  left: '[D',
  ctrlc: '',
  enter: '\r',
  1: '1',
  2: '2',
  3: '3',
};

for (const button of document.querySelectorAll('#keybar button')) {
  // Down rather than click: a tap that moves a pixel is a scroll to the
  // browser and never becomes a click, which on a key strip reads as the
  // button being broken.
  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const data = KEYS[button.dataset.key];
    if (openId && data) client.send({ t: 'input', id: openId, data });
  });
}

const compose = $('compose');

// How long to leave between a prompt and the Enter that submits it. A TUI
// handed text and a carriage return in one read has been given a paste rather
// than a line somebody typed, and a pasted newline stays a newline: the prompt
// lands in the box and sits there, unsent. Arriving on its own, the Enter means
// what it says. Long enough to survive two writes being coalesced on the way,
// short enough that nobody waits for it.
const SUBMIT_GAP_MS = 40;

function sendComposed() {
  const text = compose.value;
  if (!openId) return;

  // Nothing typed and ➤ tapped anyway: send the bare Enter. That is the
  // gesture of someone whose last prompt is sitting unsent in the terminal,
  // and a button that does nothing at all there is a button that looks broken.
  if (!text.trim()) {
    client.send({ t: 'input', id: openId, data: '\r' });
    return;
  }

  // The prompt as one message, because per-keystroke over wifi to a TUI that
  // redraws on every character is the thing this box exists to avoid. Both
  // halves go to the terminal that was open when the send began rather than to
  // whatever is open a frame later, so leaving the screen mid-send cannot fire
  // an Enter at a stranger.
  const id = openId;
  client.send({ t: 'input', id, data: text });
  setTimeout(() => client.send({ t: 'input', id, data: '\r' }), SUBMIT_GAP_MS);

  compose.value = '';
  compose.style.height = 'auto';
}

$('send').addEventListener('click', sendComposed);

compose.addEventListener('input', () => {
  // Grow with what is typed, up to a few lines, then scroll inside itself.
  compose.style.height = 'auto';
  compose.style.height = Math.min(compose.scrollHeight, 120) + 'px';
});

compose.addEventListener('keydown', (e) => {
  // A hardware or floating keyboard with a real Enter on it: send, rather than
  // inserting a newline nobody asked for in a one-line box.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendComposed();
  }
});

function applyInputMode() {
  $('composebar').hidden = rawMode;
  for (const [, view] of views) view.term.options.disableStdin = !rawMode;
  const view = views.get(openId);
  if (rawMode && view) view.term.focus();
}

// ------------------------------------------------------------- the ⋮ menu

/**
 * The bottom sheet, which is this app's only menu.
 *
 * An item is `{ label, run }` at its simplest. Two extras exist for the list of
 * past agent sessions, which needs more than a line of text per row: `note`
 * puts a quiet second column on the right — how long ago it was — and `live`
 * replaces that with a pulsing green mark. An item with no `run` cannot be
 * tapped, which is how both a live session and an empty list are said.
 */
function sheet(title, items) {
  const box = $('sheetitems');
  box.textContent = '';

  const head = document.createElement('div');
  head.className = 'sheet-title';
  head.textContent = title;
  box.appendChild(head);

  for (const item of items) {
    const button = document.createElement('button');
    const detail = Boolean(item.note || item.live);
    button.className = 'sheet-item' + (detail ? ' detail' : '') + (item.live ? ' live' : '');

    if (detail) {
      button.innerHTML = '<span class="sheet-label"></span>'
        + (item.live ? '<span class="sheet-live">live</span>' : '<span class="sheet-note"></span>');
      button.querySelector('.sheet-label').textContent = item.label;
      if (!item.live) button.querySelector('.sheet-note').textContent = item.note;
    } else {
      button.textContent = item.label;
    }

    if (item.run) {
      button.addEventListener('click', () => {
        $('sheet').hidden = true;
        item.run();
      });
    } else {
      button.disabled = true;
    }
    box.appendChild(button);
  }
  $('sheet').hidden = false;
}

$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet') || e.target.classList.contains('cancel')) $('sheet').hidden = true;
});

$('termmenu').addEventListener('click', () => {
  const session = sessions.get(openId);
  if (!session) return;

  sheet(session.title, [
    {
      label: claimSize ? "Show the PC's layout" : 'Reflow to this screen',
      run: () => {
        claimSize = !claimSize;
        store.set('claimSize', claimSize);
        if (!claimSize) client.send({ t: 'release', id: openId });
        fitTerminal({ force: true });
      },
    },
    {
      label: rawMode ? 'Use the compose box' : 'Type straight into the terminal',
      run: () => { rawMode = !rawMode; store.set('rawMode', rawMode); applyInputMode(); },
    },
    { label: 'Clear what is on screen', run: () => { const v = views.get(openId); if (v) v.term.clear(); } },
    { label: 'Close this terminal', run: () => client.send({ t: 'kill', id: openId }) },
  ]);
});

// ------------------------------------------------------------- little modal

let promptRun = null;

function ask(title, value, run) {
  $('prompttitle').textContent = title;
  $('promptinput').value = value;
  $('prompterror').textContent = '';
  promptRun = run;
  $('prompt').hidden = false;
  $('promptinput').focus();
}

function promptError(message) {
  $('prompterror').textContent = message;
  $('prompt').hidden = false;
}

$('promptok').addEventListener('click', () => {
  const value = $('promptinput').value.trim();
  if (!value) return;
  $('prompt').hidden = true;
  if (promptRun) promptRun(value);
});
$('promptcancel').addEventListener('click', () => { $('prompt').hidden = true; });
$('promptinput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('promptok').click(); });

// ----------------------------------------------------------------- settings

function paintSettings() {
  $('setwhere').textContent = client.online() ? `${pcName} — ${host}:${port}` : `${host}:${port} (offline)`;
  $('fontsize').textContent = `${fontSize}px`;
  $('rawmode').checked = rawMode;
  $('claimsize').checked = claimSize;
}

function setFont(next) {
  fontSize = Math.min(24, Math.max(MIN_FONT, next));
  store.set('fontSize', fontSize);
  paintSettings();
  if (openId) fitTerminal();
}

$('fontup').addEventListener('click', () => setFont(fontSize + 1));
$('fontdown').addEventListener('click', () => setFont(fontSize - 1));

$('rawmode').addEventListener('change', (e) => {
  rawMode = e.target.checked;
  store.set('rawMode', rawMode);
  applyInputMode();
});

$('claimsize').addEventListener('change', (e) => {
  claimSize = e.target.checked;
  store.set('claimSize', claimSize);
  // Forced: turning this back on has to reclaim the width even when the numbers
  // work out the same as the last time this phone held it.
  if (openId) fitTerminal({ force: true });
});

$('forget').addEventListener('click', () => {
  client.disconnect();
  store.drop('token');
  sessions.clear();
  for (const [, view] of views) { view.term.dispose(); view.el.remove(); }
  views.clear();
  $('pairfield').hidden = false;
  $('connectstate').textContent = 'Pair with a PC again.';
  show('connect');
});

// ---------------------------------------------------------- usage bars

function onUsage({ usage }) {
  const box = $('usage');
  box.hidden = !usage || !usage.available;
  if (box.hidden) return;

  drawBar($('u5'), $('u5pct'), usage.fiveHour);
  drawBar($('u7'), $('u7pct'), usage.sevenDay);

  const parts = [];
  if (usage.capped) parts.push(`${usage.capped === 'sevenDay' ? '7d' : '5h'} limit reached`);
  const counting = usage[usage.capped || 'fiveHour'];
  if (counting && counting.resetsAt > Date.now()) {
    const mins = Math.ceil((counting.resetsAt - Date.now()) / 60_000);
    parts.push(mins < 60 ? `resets in ${mins}m` : `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`);
  }
  $('usagenote').textContent = parts.join(' · ');
}

function drawBar(fill, pct, window) {
  if (!window) { fill.style.width = '0'; pct.textContent = '--'; return; }
  fill.style.width = `${window.used}%`;
  fill.classList.toggle('warn', window.used >= 75 && window.used < 90);
  fill.classList.toggle('hot', window.used >= 90);
  pct.textContent = `${Math.round(window.used)}%`;
}

// --------------------------------------------------------------------- boot

// Android's back gesture, which has to mean "out of this terminal" before it
// means "close the app" — otherwise reading a terminal is a one-way trip.
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  const { App } = window.Capacitor.Plugins;
  App.addListener('backButton', () => {
    if (!$('sheet').hidden) { $('sheet').hidden = true; return; }
    if (!$('prompt').hidden) { $('prompt').hidden = true; return; }
    if (openId) { closeTerminal(); return; }
    App.exitApp();
  });

  // Coming back from the lock screen is exactly when the socket has quietly
  // died and nothing has noticed yet.
  App.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) { releaseWidth(); return; }
    client.wake();
    if (openId) fitTerminal({ force: true });
  });
}

// A phone in a pocket is not reading anything, so the PC gets its width back
// until this one is picked up again, when the fit below claims it afresh.
function releaseWidth() {
  if (openId && claimSize) client.send({ t: 'release', id: openId });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { releaseWidth(); return; }
  client.wake();
  // Picking the phone back up is the moment to fit — and to take the width
  // back, which the reconnect behind this deliberately no longer does on its
  // own.
  if (openId) fitTerminal({ force: true });
});

setInterval(() => { if (!$('projects').hidden) client.send({ t: 'usage' }); }, 60_000);

(function boot() {
  $('host').value = host || '';
  $('port').value = String(port);
  applyInputMode();

  const token = store.get('token');
  if (host && token) {
    show('projects');
    $('pchost').textContent = 'connecting…';
    client.connect({ host, port, token, name: deviceName() });
    return;
  }

  // No key means pairing, whether or not this phone has seen a PC before — and
  // a first run is the one time the code box is certainly needed, so hiding it
  // then was exactly the wrong way round.
  $('pairfield').hidden = false;
  show('connect');
  $('connectstate').textContent = host
    ? 'Pair this phone with your PC.'
    : 'Tap Find my PC, or type its address, then pair with the code the PC shows.';
})();
