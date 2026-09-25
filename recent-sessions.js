'use strict';

const { recentFor: claude } = require('./transcripts');
const { recentFor: codex } = require('./codex-sessions');

// Each reader returns only this project's locally available history. A missing
// or unreadable history for one agent must not hide the other agent's sessions.
function recentAll(projectPath, readers = { claude, codex }, report = console.error) {
  const rows = [];
  for (const [agentId, read] of Object.entries(readers)) {
    try {
      rows.push(...read(projectPath).map((row) => ({ ...row, agentId })));
    } catch (err) { report(`Hangar: could not read ${agentId} history`, err); }
  }
  return rows.sort((a, b) => b.at - a.at);
}

module.exports = { recentAll };
