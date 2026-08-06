import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  stripAnsi, classify, nameFromTitle, nameFromPrompt, createInputCapture,
} = require('../renderer/classify.js');

const ESC = '\u001B';

describe('stripAnsi', () => {
  it('removes colour and cursor sequences', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(stripAnsi(`${ESC}[2J${ESC}[Hcleared`)).toBe('cleared');
  });

  it('removes OSC title sequences terminated by BEL or ST', () => {
    expect(stripAnsi(`${ESC}]0;C:\\repo\u0007prompt`)).toBe('prompt');
    expect(stripAnsi(`${ESC}]0;title${ESC}\\prompt`)).toBe('prompt');
  });

  it('leaves ordinary text alone', () => {
    expect(stripAnsi('npm test -- --watch')).toBe('npm test -- --watch');
  });
});

describe('classify', () => {
  it('returns null when nothing is recognisable', () => {
    expect(classify('just some prose with no tool calls')).toBeNull();
    expect(classify('')).toBeNull();
  });

  it('detects the planning stage from read-only tool calls', () => {
    expect(classify('Read(src/app.js)')).toBe('planning');
    expect(classify('Grep(pattern)')).toBe('planning');
    expect(classify('Thinking about the approach')).toBe('planning');
  });

  it('detects implementation from mutating tool calls', () => {
    expect(classify('Edit(src/app.js)')).toBe('implementing');
    expect(classify('Write(README.md)')).toBe('implementing');
    expect(classify('MultiEdit (a.js)')).toBe('implementing');
  });

  it('detects test runs across ecosystems', () => {
    expect(classify('Bash(npm test)')).toBe('testing');
    expect(classify('running vitest now')).toBe('testing');
    expect(classify('$ cargo test --all')).toBe('testing');
    expect(classify('pytest -q')).toBe('testing');
  });

  it('takes the latest signal, not the highest priority one', () => {
    // A TUI appends its newest activity at the bottom, so position wins.
    expect(classify('Read(a.js)\nEdit(a.js)')).toBe('implementing');
    expect(classify('Edit(a.js)\nBash(npm test)')).toBe('testing');
    expect(classify('Bash(npm test)\nEdit(a.js)')).toBe('implementing');
    expect(classify('Edit(a.js)\nRead(b.js)')).toBe('planning');
  });

  it('classifies output that still carries ANSI once stripped', () => {
    const raw = `${ESC}[32m⏺${ESC}[0m Edit(src/main.js)`;
    expect(classify(stripAnsi(raw))).toBe('implementing');
  });
});

describe('nameFromTitle', () => {
  it('takes the session summary claude publishes as its title', () => {
    expect(nameFromTitle('\u2733 Fix the login redirect')).toBe('Fix the login redirect');
  });

  it('strips the spinner frames claude cycles through while it works', () => {
    expect(nameFromTitle('\u2802 Fix the login redirect')).toBe('Fix the login redirect');
    expect(nameFromTitle('\u2810 Fix the login redirect')).toBe('Fix the login redirect');
  });

  it('rejects titles that only name the program', () => {
    expect(nameFromTitle('\u2733 Claude Code')).toBeNull();
    expect(nameFromTitle('claude')).toBeNull();
    expect(nameFromTitle('Windows PowerShell')).toBeNull();
    expect(nameFromTitle('Administrator: Windows PowerShell')).toBeNull();
    expect(nameFromTitle('Select cmd.exe')).toBeNull();
    expect(nameFromTitle('')).toBeNull();
    expect(nameFromTitle(null)).toBeNull();
  });

  it('shortens a shell that titles itself after the working directory', () => {
    expect(nameFromTitle('C:\\Users\\you\\Desktop\\Projects\\Widget')).toBe('Widget');
    expect(nameFromTitle('/home/james/code/skywatch')).toBe('skywatch');
  });

  it('truncates a long summary', () => {
    const name = nameFromTitle('\u2733 rework the whole authentication middleware', 20);
    expect(name.length).toBeLessThanOrEqual(20);
    expect(name.endsWith('…')).toBe(true);
  });
});

describe('nameFromPrompt', () => {
  it('ignores prompts too short to be meaningful', () => {
    expect(nameFromPrompt('')).toBeNull();
    expect(nameFromPrompt('hi')).toBeNull();
    expect(nameFromPrompt(null)).toBeNull();
  });

  it('drops stopwords and keeps the substance', () => {
    expect(nameFromPrompt('can you please fix the login redirect')).toBe('fix login redirect');
  });

  it('prefers file paths over prose', () => {
    const name = nameFromPrompt('have a look at the thing in src/pages/Admin.jsx for me');
    expect(name).toContain('src/pages/Admin.jsx');
  });

  it('prefers camelCase identifiers', () => {
    const name = nameFromPrompt('the function getLevelInfo is returning the wrong value');
    expect(name).toContain('getLevelInfo');
  });

  it('preserves the order words appeared in', () => {
    expect(nameFromPrompt('add weekly leaderboards')).toBe('add weekly leaderboards');
  });

  it('caps the number of words', () => {
    const name = nameFromPrompt('alpha bravo charlie delta echo foxtrot', 3, 100);
    expect(name.split(' ')).toHaveLength(3);
  });

  it('truncates long names with an ellipsis', () => {
    const name = nameFromPrompt('refactoring authentication middleware thoroughly', 3, 20);
    expect(name.length).toBeLessThanOrEqual(20);
    expect(name.endsWith('…')).toBe(true);
  });

  it('returns null when a prompt is nothing but stopwords', () => {
    expect(nameFromPrompt('can you please do it for me')).toBeNull();
  });

  it('ignores slash commands, which drive a session rather than describe it', () => {
    expect(nameFromPrompt('/clear')).toBeNull();
    expect(nameFromPrompt('/model opus')).toBeNull();
  });

  it('ignores bare numbers picked out of a menu', () => {
    expect(nameFromPrompt('2')).toBeNull();
    expect(nameFromPrompt('1 2 3')).toBeNull();
  });
});

describe('createInputCapture', () => {
  it('emits a line when Enter is pressed', () => {
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    'hello'.split('').forEach(feed);
    feed('\r');
    expect(onSubmit).toHaveBeenCalledWith('hello');
  });

  it('does not emit on an empty line', () => {
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    feed('\r');
    feed('   \r');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('honours backspace and delete', () => {
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    feed('abcX');
    feed('\u007F');
    feed('\r');
    expect(onSubmit).toHaveBeenCalledWith('abc');
  });

  it('ignores arrow keys and other escape sequences', () => {
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    feed('ab');
    feed(`${ESC}[A`);
    feed(`${ESC}[1;5D`);
    feed('c\r');
    expect(onSubmit).toHaveBeenCalledWith('abc');
  });

  it('treats the Shift+Enter newline as part of the same prompt', () => {
    // The renderer sends ESC+CR for a soft newline. Nothing has been submitted
    // yet, so the buffer has to survive it and go out whole on the real Enter.
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    feed('rename the docking');
    feed(`${ESC}\r`);
    feed(' module\r');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('rename the docking module');
  });

  it('captures bracketed paste payloads', () => {
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    feed(`${ESC}[200~fix the build${ESC}[201~`);
    feed('\r');
    expect(onSubmit).toHaveBeenCalledWith('fix the build');
  });

  it('abandons the buffer on Ctrl+C', () => {
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    feed('half typed');
    feed('\u0003');
    feed('real prompt\r');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('real prompt');
  });

  it('handles a whole prompt arriving as one chunk', () => {
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    feed('run the skywatch tests\r');
    expect(onSubmit).toHaveBeenCalledWith('run the skywatch tests');
  });

  it('swallows SGR mouse reports instead of reading them as typing', () => {
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    feed(`${ESC}[<0;20;35M`);
    feed(`${ESC}[<0;21;35m`);
    feed(`${ESC}[<64;20;35M`);
    feed('add a dark theme\r');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('add a dark theme');
  });

  it('swallows the answers the terminal sends back to a query', () => {
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    feed(`${ESC}[20;35R`);                        // cursor position
    feed(`${ESC}]11;rgb:1213/1415/1a1f${ESC}\\`); // background colour
    feed(`${ESC}[?62;c`);                         // device attributes
    feed(`${ESC}P>|xterm(390)${ESC}\\`);          // version, as a DCS payload
    feed('add a dark theme\r');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('add a dark theme');
  });

  it('keeps parsing a sequence split across chunks', () => {
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    feed(`ab${ESC}`);
    feed('[<0;');
    feed('20;35m');
    feed('c\r');
    expect(onSubmit).toHaveBeenCalledWith('abc');
  });

  it('swallows an OSC title the shell echoes back', () => {
    const onSubmit = vi.fn();
    const feed = createInputCapture(onSubmit);
    feed(`${ESC}]0;C:\\repo\u0007fix the parser\r`);
    expect(onSubmit).toHaveBeenCalledWith('fix the parser');
  });
});
