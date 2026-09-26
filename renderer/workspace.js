'use strict';

window.createProjectWorkspace = function (api, runtimeChanged = () => {}) {
  const el = (id) => document.getElementById(id);
  const panel = el('workspace');
  const commands = el('startupcommands');
  const title = el('notetitle');
  const body = el('notebody');
  const appUrl = el('appurl');
  function paintAppLink() {
    const invalid = Boolean(appUrl.value.trim() && !window.localAppUrl(appUrl.value));
    el('openapp').hidden = !appUrl.value.trim();
    el('openapp').disabled = invalid || loading || !current;
    appUrl.setAttribute('aria-invalid', String(invalid));
    el('appurlhint').hidden = !invalid;
    el('appurlhint').textContent = invalid ? 'Use a localhost URL, e.g. localhost:3000.' : '';
  }
  const states = new Map();
  let current = null;
  let generation = 0;
  let loading = false;
  let hintTimer;

  function clearStartupHint() {
    clearTimeout(hintTimer);
    el('runstartup').classList.remove('startup-nudge');
    el('startuprequired').classList.remove('visible');
    el('startuprequired').setAttribute('aria-hidden', 'true');
  }

  function hintStartup(state) {
    clearTimeout(hintTimer);
    el('runstartup').classList.remove('startup-nudge');
    el('startuprequiredtext').textContent = state.busy
      ? 'Wait for startup scripts to finish starting or stopping.'
      : state.startup.trim()
        ? 'Run startup scripts first, then open your app.'
        : 'Add a startup command, then run startup scripts to open your app.';
    el('startuprequired').classList.add('visible');
    el('startuprequired').setAttribute('aria-hidden', 'false');
    const button = el('runstartup');
    void button.offsetWidth; // Restart the pulse on repeated attempts.
    button.classList.add('startup-nudge');
    hintTimer = setTimeout(clearStartupHint, 2500);
    if (!state.busy) (state.startup.trim() ? button : commands).focus();
  }

  function paintScripts() {
    if (!current || loading) return;
    const state = current;
    commands.disabled = Boolean(state.busy || state.runtime?.running);
    el('runstartup').disabled = Boolean(state.busy || (!state.runtime?.running && !state.startup.trim()));
    el('runstartup').textContent = state.busy
      ? (state.runtime?.running ? 'Stopping…' : 'Starting…')
      : (state.runtime?.running ? 'Stop startup scripts' : 'Run startup scripts');
    const output = el('startupoutputtext');
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
    if (output.textContent !== (state.runtime?.output || '')) {
      output.textContent = state.runtime?.output || '';
      if (follow) output.scrollTop = output.scrollHeight;
    }
    el('startupoutput').hidden = !(state.busy || state.runtime?.running || (state.runtime?.output && !state.outputDismissed));
    el('startupoutputclose').hidden = Boolean(state.busy || state.runtime?.running);
  }

  function dismissAfterStop(state) {
    clearTimeout(state.dismissTimer);
    if (!state.dismissWhenStopped || state.busy || state.runtime?.running || state.runtime?.finishing) return;
    state.dismissTimer = setTimeout(() => {
      state.outputDismissed = true;
      state.dismissWhenStopped = false;
      if (current === state) paintScripts();
    }, 1000);
  }

  api.onStartupChanged((runtime) => {
    runtimeChanged(runtime);
    const state = states.get(runtime.projectPath);
    if (!state) return;
    state.runtime = runtime;
    dismissAfterStop(state);
    if (current === state) {
      if (runtime.running) clearStartupHint();
      paintScripts();
    }
  });
  el('startupoutputclose').onclick = () => {
    if (current) { current.outputDismissed = true; paintScripts(); }
  };

  function updateScrollHint() {
    el('startupscrollhint').classList.toggle('visible', commands.scrollWidth > commands.clientWidth + 1);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateScrollHint).observe(commands);

  function status(state, message, error = false) {
    if (state !== current) return;
    el('workspacestatus').textContent = message;
    el('workspacestatus').classList.toggle('error', error);
  }

  function flush(state) {
    clearTimeout(state.timer);
    if (!state.dirty) return state.pending;
    const value = { startup: state.startup, appUrl: state.appUrl || '', page: { ...state.pages[state.index] } };
    state.dirty = false;
    state.saving = (state.saving || 0) + 1;
    state.pending = state.pending.then(() => api.saveWorkspace(state.project.path, value)).then(() => {
      state.error = null;
      if (!state.dirty) status(state, 'Saved locally');
    }).catch((err) => {
      state.error = err;
      state.dirty = true;
      status(state, 'Could not save: ' + err.message, true);
    }).finally(() => { state.saving--; });
    return state.pending;
  }

  async function settle(state) {
    do { await flush(state); } while (state.dirty && !state.error);
  }

  function changed() {
    updateScrollHint();
    if (!current) return;
    current.startup = commands.value;
    current.appUrl = appUrl.value;
    paintAppLink();
    Object.assign(current.pages[current.index], { title: title.value, body: body.value });
    current.dirty = true;
    status(current, 'Saving…');
    clearTimeout(current.timer);
    const state = current;
    state.timer = setTimeout(() => flush(state), 300);
    paintScripts();
  }

  function page() {
    const state = current;
    title.value = state.pages[state.index].title;
    body.value = state.pages[state.index].body;
    el('notecount').textContent = `${state.index + 1} / ${state.pages.length}`;
    el('noteprev').disabled = state.index === 0;
    el('notenext').disabled = state.index === state.pages.length - 1;
  }

  function blank() {
    return { id: 'page-' + Date.now().toString(36) + '-' + crypto.randomUUID(), title: 'Untitled', body: '' };
  }

  async function show(project) {
    const ticket = ++generation;
    if (current && current.project.path === project.path && !loading) return;
    if (current) {
      const previous = current;
      await settle(previous);
      if (ticket !== generation) return;
      if (previous.error) return;
    }
    panel.hidden = false;
    clearStartupHint();
    loading = true;
    el('startupoutput').hidden = true;
    for (const field of panel.querySelectorAll('input, textarea, button')) field.disabled = true;
    el('workspaceproject').textContent = project.name;
    el('workspacestatus').textContent = 'Loading…';
    try {
      let state = states.get(project.path);
      if (!state) {
        const data = await api.loadWorkspace(project.path);
        state = { ...data, project, index: 0, dirty: false, pending: Promise.resolve() };
        if (!state.pages.length) state.pages.push(blank());
        states.set(project.path, state);
      }
      state.runtime = await api.startupState(project.path);
      runtimeChanged(state.runtime);
      if (ticket !== generation) return;
      current = state;
      loading = false;
      for (const field of panel.querySelectorAll('input, textarea, button')) field.disabled = false;
      commands.value = state.startup;
      appUrl.value = state.appUrl || '';
      paintAppLink();
      commands.scrollLeft = 0;
      updateScrollHint();
      paintScripts();
      page();
      status(state, 'Local notes · autosaved');
    } catch (err) {
      if (ticket !== generation) return;
      current = null;
      loading = false;
      commands.value = title.value = body.value = '';
      appUrl.value = '';
      paintAppLink();
      updateScrollHint();
      el('workspacestatus').textContent = 'Could not load: ' + err.message;
      el('workspacestatus').classList.add('error');
    }
  }

  for (const field of [commands, title, body, appUrl]) {
    field.addEventListener('input', changed);
    field.addEventListener('blur', () => { if (current) flush(current); });
  }
  el('openapp').onclick = async () => {
    const state = current;
    const url = window.localAppUrl(appUrl.value);
    if (!state || loading || !url) return;
    if (state.busy || !state.runtime?.running) { hintStartup(state); return; }
    clearStartupHint();
    try { await api.openApp(url); }
    catch (err) { status(state, 'Could not open app: ' + err.message, true); }
  };
  appUrl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); el('openapp').onclick(); }
  });
  async function navigate(delta) {
    const state = current;
    if (!state) return;
    await settle(state);
    if (current !== state || state.error) return;
    state.index = Math.max(0, Math.min(state.pages.length - 1, state.index + delta));
    page();
  }
  el('noteprev').onclick = () => navigate(-1);
  el('notenext').onclick = () => navigate(1);
  el('noteadd').onclick = async () => {
    const state = current;
    if (!state) return;
    await settle(state);
    if (current !== state || state.error) return;
    state.pages.push(blank());
    state.index = state.pages.length - 1;
    state.dirty = true;
    page();
    await flush(state);
    title.focus();
    title.select();
  };
  el('runstartup').onclick = async () => {
    const state = current;
    if (!state || state.busy || loading) return;
    const stopping = state.runtime?.running;
    if (!stopping && !state.startup.trim()) return;
    clearStartupHint();
    state.busy = true;
    clearTimeout(state.dismissTimer);
    state.dismissWhenStopped = Boolean(stopping);
    state.outputDismissed = false;
    if (!stopping) state.runtime = { running: false, output: '' };
    paintScripts();
    try {
      if (stopping) state.runtime = await api.stopScripts(state.project.path);
      else {
        await settle(state);
        if (state.error) return;
        state.runtime = await api.startScripts(state.project.path, state.startup);
      }
      runtimeChanged(state.runtime);
    } catch (err) {
      state.dismissWhenStopped = false;
      status(state, `Could not ${stopping ? 'stop' : 'start'}: ` + err.message, true);
    }
    finally {
      state.busy = false;
      dismissAfterStop(state);
      paintScripts();
    }
  };
  // Text editing shortcuts must never reach terminal shortcuts.
  panel.addEventListener('keydown', (event) => event.stopPropagation());
  window.addEventListener('beforeunload', (event) => {
    if (![...states.values()].some((state) => state.dirty || state.saving)) return;
    event.preventDefault();
    event.returnValue = '';
    Promise.all([...states.values()].map(settle)).then(() => {
      if (![...states.values()].some((state) => state.error || state.dirty)) window.close();
    });
  });
  return { show };
};
