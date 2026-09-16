'use strict';

/**
 * Which coding agent Hangar opens for you, and everything about it the rest of
 * the app has to spell out.
 *
 * Hangar is a terminal host and does not care what runs in it — `codex` worked
 * in a tab here long before this file existed, the same way `npm test` does.
 * What this is for is the handful of places that had the word `claude` written
 * into them and could not have been told otherwise: the button that opens one
 * without being asked, the menu that resumes an earlier conversation, the
 * process view that steps over the agent to show what it started, and a dozen
 * lines of help text naming it.
 *
 * One table, so a second agent is a row here rather than a search through six
 * files, and so nothing can end up half-switched.
 *
 * Loaded as a plain <script> in the renderer and as a CommonJS module in the
 * main process, like classify.js, so both sides read the same row rather than
 * each keeping their own idea of what is running. Keep it dependency-free.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Agents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const AGENTS = {
    claude: {
      id: 'claude',
      // For a heading, where it is being named rather than typed.
      name: 'Claude Code',
      // For a sentence, where what you would type is what you mean.
      label: 'claude',
      command: 'claude',
      // Never a job of its own in the process view: this is what a terminal is,
      // not something it went on to run.
      processNames: ['claude', 'claude.exe'],
      // Whether the sidebar can read this agent's 5h and 7d usage windows.
      usage: true,
      // Where the sessions this menu cannot offer are still to be found.
      ownPicker: 'claude’s own /resume',
      resume: (id) => `claude --resume ${id}`,
    },

    codex: {
      id: 'codex',
      name: 'Codex',
      label: 'codex',
      command: 'codex',
      processNames: ['codex', 'codex.exe'],
      usage: true,
      ownPicker: '`codex resume` in a terminal',
      resume: (id) => `codex resume ${id}`,
    },
  };

  // What a machine that has never been asked runs, and what an unrecognised
  // answer falls back to.
  const DEFAULT = 'claude';

  const IDS = Object.keys(AGENTS);

  function isAgentId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(AGENTS, id);
  }

  /**
   * The agent with this id, or the default one.
   *
   * Never null. Everything downstream of this is drawing a sidebar or naming a
   * button, and a saved setting for an agent this version has never heard of —
   * a hand-edited file, a config from a later release — should open a terminal
   * rather than throw on the way to the first paint.
   */
  function get(id) {
    return isAgentId(id) ? AGENTS[id] : AGENTS[DEFAULT];
  }

  /**
   * Every agent's process names at once, lower-cased.
   *
   * The process view wants the whole set rather than the chosen one: switching
   * agents does not close the terminals already running the other, and a
   * `claude` left open under a Codex setting is still the furniture of its own
   * tab rather than a job that tab started.
   */
  function processNames() {
    const out = new Set();
    for (const id of IDS) for (const name of AGENTS[id].processNames) out.add(name.toLowerCase());
    return [...out];
  }

  return { AGENTS, IDS, DEFAULT, isAgentId, get, processNames };
});
