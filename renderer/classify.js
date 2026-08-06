'use strict';

/**
 * Pure helpers for naming a terminal after what it is doing, and for guessing
 * which stage of work it is in. Loaded as a plain <script> in the renderer and
 * as a CommonJS module by the tests, so keep it dependency-free.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Classify = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ESC = '\u001B';

  // Covers OSC (terminated by BEL or ST) and CSI / single-character escapes.
  const ANSI = new RegExp(
    [
      ESC + '\\][^\\u0007\u001B]*(?:\\u0007|' + ESC + '\\\\)',
      ESC + '[[][0-9;?]*[ -/]*[@-~]',
      ESC + '[@-Z\\\\-_]',
    ].join('|'),
    'g'
  );

  function stripAnsi(text) {
    return String(text).replace(ANSI, '');
  }

  // The four stages the sidebar colours terminals by. `ready` is the resting
  // state and is set by silence rather than by a pattern.
  const STATES = ['planning', 'implementing', 'testing', 'ready'];

  // Order here is irrelevant: whichever signal appears *latest* in the recent
  // output wins, because a TUI appends its newest activity at the bottom.
  const SIGNALS = [
    {
      state: 'testing',
      pattern: /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?tests?\b|\b(?:vitest|jest|pytest|playwright|cypress|mocha|rspec|phpunit)\b|\b(?:go|cargo|dotnet|swift)\s+test\b|\bgradle\s+\w*test/i,
    },
    {
      state: 'implementing',
      pattern: /\b(?:Edit|Write|Update|Create|MultiEdit|NotebookEdit|Patch|Apply)\s*\(/,
    },
    {
      state: 'planning',
      pattern: /\b(?:Read|Grep|Glob|Search|Explore|Plan|Task|WebSearch|WebFetch|List|Bash)\s*\(|\b(?:planning|thinking|plan mode|exitplanmode)\b/i,
    },
  ];

  /**
   * Classify a window of recent, ANSI-stripped output.
   * Returns a state id, or null when nothing in the window is recognisable.
   */
  function classify(text) {
    if (!text) return null;
    let winner = null;
    let winningIndex = -1;

    for (const signal of SIGNALS) {
      const re = new RegExp(signal.pattern.source, signal.pattern.flags.replace('g', '') + 'g');
      let match;
      let last = -1;
      while ((match = re.exec(text)) !== null) {
        last = match.index;
        if (match[0].length === 0) re.lastIndex++; // paranoia against zero-width
      }
      if (last > winningIndex) {
        winningIndex = last;
        winner = signal.state;
      }
    }
    return winner;
  }

  const STOPWORDS = new Set(`
    a an and or but so if then than that this these those is are was were be been being am
    do does did doing done have has had having i me my mine myself you your yours we us our
    ours it its they them their theirs he she his her for to in on at by with from of as into
    about over under out up down off again once here there where when what which who whom why
    how all any both each few more most other some such only own same too very can could would
    should will shall may might must please just now also really quite rather still even ever
    never always maybe perhaps let lets like want wants wanted need needs needed make makes
    made making get gets got getting put puts use uses used using go goes going thing things
    stuff bit lot ok okay yeah yes no not dont im ive cant thanks thank youre were theyre
  `.trim().split(/\s+/));

  function truncate(name, maxChars) {
    if (name.length <= maxChars) return name;
    return name.slice(0, maxChars - 1).trimEnd() + '…';
  }

  // Claude Code publishes what it is working on as the terminal title, prefixed
  // with a spinner frame while it is busy and ✳ at rest. Anything in that
  // family of decorations is noise once the title is a tab name.
  const TITLE_PREFIX = /^[\s\u2000-\u2BFF*+~-]+/;

  // Titles that name the program rather than the work. Falling back to the
  // keystroke guess says more than "claude" repeated down the sidebar does.
  const GENERIC_TITLES = new Set([
    'claude', 'claude code', 'cmd', 'cmd.exe', 'command prompt', 'powershell',
    'windows powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'node',
    'select cmd.exe', 'administrator',
  ]);

  /**
   * Turn a terminal title into a tab name, or null when the title says nothing
   * the tab does not already show. Titles beat every other source: the program
   * is describing itself rather than being guessed at.
   */
  function nameFromTitle(title, maxChars = 28) {
    if (!title) return null;

    let name = stripAnsi(title).replace(TITLE_PREFIX, '').replace(/\s+/g, ' ').trim();
    // conhost decorates its own titles: "Administrator: Windows PowerShell" is
    // still nothing but a shell underneath.
    name = name.replace(/^(?:Administrator:|Select)\s+/i, '');
    if (name.length < 2) return null;
    if (GENERIC_TITLES.has(name.toLowerCase())) return null;

    // Shells title themselves after the working directory. The tab already
    // sits under its project, so only the last segment carries any news.
    if (/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(name)) {
      const segments = name.split(/[\\/]+/).filter(Boolean);
      name = segments[segments.length - 1] || name;
      if (GENERIC_TITLES.has(name.toLowerCase())) return null;
    }

    return truncate(name, maxChars);
  }

  /**
   * Pick a couple of keywords out of something the user typed, to use as a
   * terminal name. Returns null when there is nothing worth naming it after.
   */
  function nameFromPrompt(prompt, maxWords = 3, maxChars = 28) {
    if (!prompt) return null;
    const clean = stripAnsi(prompt).trim();
    if (clean.length < 3) return null;
    // Slash commands drive the session, they do not describe it.
    if (clean.startsWith('/')) return null;

    const tokens = clean.match(/[A-Za-z0-9][A-Za-z0-9._/\\-]*/g) || [];

    const candidates = [];
    tokens.forEach((token, index) => {
      const lower = token.toLowerCase().replace(/[._/\\-]+$/, '');
      if (token.length < 3) return;
      // A bare number is a menu choice or an issue id, never a name.
      if (!/[A-Za-z]/.test(token)) return;
      if (STOPWORDS.has(lower)) return;

      // Identifiers and paths say far more about the task than prose does.
      let score = Math.min(token.length, 12);
      if (/[./\\]/.test(token)) score += 10;
      if (/[a-z][A-Z]/.test(token)) score += 8;
      if (/^[A-Z]/.test(token)) score += 3;
      if (/\d/.test(token)) score += 2;

      candidates.push({ token, index, score });
    });

    if (candidates.length === 0) return null;

    const chosen = candidates
      .slice()
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, maxWords)
      .sort((a, b) => a.index - b.index)
      .map((c) => c.token);

    return truncate(chosen.join(' '), maxChars);
  }

  /**
   * Advance the escape-sequence parser by one character. Any mode other than
   * 'text' means the character belongs to a sequence and is swallowed.
   *
   * The stream carries far more than keystrokes: mouse reports, cursor position
   * answers and colour queries all travel back the same way, and a parser that
   * only understood arrow keys let their digits through as if they were typed.
   */
  function advance(mode, ch) {
    switch (mode) {
      case 'esc':
        if (ch === '[') return 'csi';
        // OSC, DCS, APC and PM each carry a payload up to a string terminator.
        if (ch === ']' || ch === 'P' || ch === '^' || ch === '_') return 'string';
        if (ch === 'N' || ch === 'O') return 'one'; // SS2 / SS3: one byte follows
        return 'text';
      case 'csi':
        // Parameters and intermediates, then a final byte in @ to ~. This is
        // what covers SGR mouse reports, whose '<' the old parser tripped over.
        return ch >= '@' && ch <= '~' ? 'text' : 'csi';
      case 'string':
        if (ch === '\u0007') return 'text';
        return ch === ESC ? 'string-esc' : 'string';
      case 'string-esc':
        if (ch === '\\') return 'text';
        return ch === ESC ? 'string-esc' : 'string';
      default:
        return 'text'; // 'one', and anything unrecognised
    }
  }

  /**
   * Fold a stream of raw keystrokes into submitted lines. Terminal input
   * arrives a character at a time, so this tracks a buffer and emits it on
   * Enter. Escape sequences are discarded; bracketed paste payloads are kept,
   * since the brackets themselves are ordinary CSI sequences.
   *
   * Parser state outlives each chunk: a sequence is free to be split across two.
   */
  function createInputCapture(onSubmit) {
    let buffer = '';
    let mode = 'text';

    return function feed(data) {
      const text = String(data);

      for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (mode !== 'text') {
          mode = advance(mode, ch);
          continue;
        }
        if (ch === ESC) {
          mode = 'esc';
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          const line = buffer.trim();
          buffer = '';
          if (line) onSubmit(line);
          continue;
        }
        if (ch === '\u007F' || ch === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        // Ctrl+C and Ctrl+U abandon whatever was being typed.
        if (ch === '\u0003' || ch === '\u0015') {
          buffer = '';
          continue;
        }
        if (ch >= ' ') buffer += ch;
      }
    };
  }

  return { stripAnsi, classify, nameFromTitle, nameFromPrompt, createInputCapture, STATES, SIGNALS };
});
