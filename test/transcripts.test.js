import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  LABEL_CHARS,
  claudeHome,
  isSessionId,
  samePath,
  label,
  isBareCommand,
  readTail,
  parseHistory,
  sessionsIn,
  pidAlive,
  readLive,
  recentFor,
} = require('../transcripts.js');

const HANGAR = 'C:\\Users\\James\\Desktop\\Cursor Projects\\Hangar';
const OTHER = 'C:\\Users\\James\\Desktop\\Cursor Projects\\Realms';

const ID = {
  a: '02735993-68b4-4791-a7a1-40c5204e4103',
  b: '98604b21-d831-469d-9cc8-fcab34b4d9a1',
  c: 'c885d8d2-2e79-48c7-8e20-e410a8f39828',
};

/** One line of history.jsonl, in the shape claude actually writes. */
function prompt(id, project, timestamp, display) {
  return JSON.stringify({ display, pastedContents: {}, timestamp, project, sessionId: id });
}

function history(lines) {
  return { text: lines.join('\n'), whole: true };
}

/** An fs that answers reads out of a string. */
function fakeIo(content) {
  const buf = Buffer.from(content, 'utf8');
  return {
    openSync: () => 3,
    fstatSync: () => ({ size: buf.length }),
    readSync: (_fd, target, offset, length, position) => {
      buf.copy(target, offset, position, position + length);
      return length;
    },
    closeSync: () => {},
  };
}

describe('claudeHome', () => {
  it('is overridable, so a test never reads the real one', () => {
    expect(claudeHome({ HANGAR_CLAUDE_HOME: 'D:/fake' })).toBe('D:/fake');
  });
});

describe('isSessionId', () => {
  it('accepts a uuid and nothing else', () => {
    expect(isSessionId(ID.a)).toBe(true);
    expect(isSessionId('not-a-uuid')).toBe(false);
    expect(isSessionId(`${ID.a}; rm -rf /`)).toBe(false);
    expect(isSessionId(null)).toBe(false);
  });
});

describe('samePath', () => {
  it('sees through the spellings the same folder arrives in', () => {
    expect(samePath('C:/Projects/Hangar', 'C:\\Projects\\Hangar', 'win32')).toBe(true);
    expect(samePath('C:\\Projects\\Hangar\\', 'C:\\Projects\\Hangar', 'win32')).toBe(true);
    expect(samePath('c:\\projects\\hangar', HANGAR.toUpperCase(), 'win32')).toBe(false);
  });

  it('folds case on Windows and nowhere else', () => {
    expect(samePath('C:/Projects/Hangar', 'c:/projects/hangar', 'win32')).toBe(true);
    expect(samePath('/home/j/Hangar', '/home/j/hangar', 'linux')).toBe(false);
  });

  it('never matches on missing or empty paths', () => {
    expect(samePath('', '')).toBe(false);
    expect(samePath(undefined, HANGAR)).toBe(false);
  });
});

describe('label', () => {
  it('flattens a prompt onto one line', () => {
    expect(label('  ensure reports\n  say hard or easier  ')).toBe('ensure reports say hard or easier');
  });

  it('truncates a paragraph rather than carrying it across the bridge', () => {
    const long = label('x'.repeat(400));
    expect(long).toHaveLength(LABEL_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  it('has nothing to say about an empty prompt', () => {
    expect(label('   ')).toBe(null);
    expect(label(undefined)).toBe(null);
  });
});

describe('readTail', () => {
  it('reads only the end of a long file, fragment and all', () => {
    const io = fakeIo('aaaa\nbbbb\ncccc\n');
    expect(readTail('history.jsonl', 7, { io })).toEqual({ text: 'b\ncccc\n', whole: false });
  });

  it('says so when the whole file fitted', () => {
    const io = fakeIo('aaaa\n');
    expect(readTail('history.jsonl', 4096, { io })).toEqual({ text: 'aaaa\n', whole: true });
  });

  it('answers empty for a file that is not there', () => {
    const io = { openSync: () => { throw new Error('ENOENT'); } };
    expect(readTail('history.jsonl', 4096, { io })).toEqual({ text: '', whole: true });
  });

  it('closes the descriptor even when the read throws', () => {
    let closed = 0;
    const io = {
      openSync: () => 7,
      fstatSync: () => ({ size: 10 }),
      readSync: () => { throw new Error('EIO'); },
      closeSync: () => { closed += 1; },
    };
    readTail('history.jsonl', 4096, { io });
    expect(closed).toBe(1);
  });
});

describe('parseHistory', () => {
  it('keeps the prompt lines and drops everything it does not recognise', () => {
    const entries = parseHistory(history([
      prompt(ID.a, HANGAR, 1000, 'first'),
      'not json at all',
      JSON.stringify({ display: 'no session', project: HANGAR, timestamp: 2000 }),
      JSON.stringify({ sessionId: ID.a, project: HANGAR, timestamp: 'soon', display: 'bad time' }),
      '',
      prompt(ID.b, OTHER, 3000, 'second'),
    ]));

    expect(entries).toEqual([
      { id: ID.a, project: HANGAR, at: 1000, prompt: 'first' },
      { id: ID.b, project: OTHER, at: 3000, prompt: 'second' },
    ]);
  });

  it('throws away the first line when the read started mid-file', () => {
    const lines = [prompt(ID.a, HANGAR, 1000, 'first'), prompt(ID.b, HANGAR, 2000, 'second')];
    expect(parseHistory({ text: lines.join('\n'), whole: false }))
      .toEqual([{ id: ID.b, project: HANGAR, at: 2000, prompt: 'second' }]);
  });
});

describe('isBareCommand', () => {
  it('knows a slash command with nothing to say from one that says something', () => {
    expect(isBareCommand('/resume')).toBe(true);
    expect(isBareCommand('  /clear  ')).toBe(true);
    expect(isBareCommand('/code-review the login flow')).toBe(false);
    expect(isBareCommand('with our /immerse game, add collision')).toBe(false);
  });
});

describe('sessionsIn', () => {
  const entries = parseHistory(history([
    prompt(ID.a, HANGAR, 1000, 'add a sidebar'),
    prompt(ID.b, OTHER, 1500, 'somebody else'),
    prompt(ID.a, HANGAR, 4000, 'now make it green'),
    prompt(ID.c, HANGAR, 2000, 'fix the icon'),
  ]));

  it('names a session after its first prompt and dates it by its last', () => {
    expect(sessionsIn(entries, HANGAR, 'win32')).toEqual([
      { id: ID.a, label: 'add a sidebar', at: 4000 },
      { id: ID.c, label: 'fix the icon', at: 2000 },
    ]);
  });

  it('takes the earliest prompt as the name whatever order they arrive in', () => {
    const rows = sessionsIn([...entries].reverse(), HANGAR, 'win32');
    expect(rows.find((r) => r.id === ID.a).label).toBe('add a sidebar');
  });

  it('looks past the /resume a session came back through', () => {
    const rows = sessionsIn(parseHistory(history([
      prompt(ID.a, HANGAR, 1000, '/resume'),
      prompt(ID.a, HANGAR, 2000, '/clear'),
      prompt(ID.a, HANGAR, 3000, 'now make it green'),
      prompt(ID.a, HANGAR, 4000, 'and rounder'),
    ])), HANGAR, 'win32');
    expect(rows).toEqual([{ id: ID.a, label: 'now make it green', at: 4000 }]);
  });

  it('drops the stub session a /resume leaves behind', () => {
    const rows = sessionsIn(parseHistory(history([
      prompt(ID.a, HANGAR, 1000, '/resume'),
      prompt(ID.b, HANGAR, 2000, '   '),
    ])), HANGAR, 'win32');
    expect(rows).toEqual([]);
  });

  it('leaves other projects alone', () => {
    expect(sessionsIn(entries, OTHER, 'win32').map((r) => r.id)).toEqual([ID.b]);
  });
});

describe('pidAlive', () => {
  it('reads signal 0 the way the kernel answers it', () => {
    expect(pidAlive(100, () => {})).toBe(true);
    expect(pidAlive(100, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); })).toBe(false);
    expect(pidAlive(100, () => { throw Object.assign(new Error('theirs'), { code: 'EPERM' }); })).toBe(true);
  });

  it('refuses a pid that is not one', () => {
    expect(pidAlive(undefined, () => {})).toBe(false);
    expect(pidAlive(0, () => {})).toBe(false);
  });
});

describe('readLive', () => {
  const files = {
    '26048.json': JSON.stringify({ pid: 26048, sessionId: ID.a, cwd: HANGAR, startedAt: 900, name: 'hangar-71' }),
    '26456.json': JSON.stringify({ pid: 26456, sessionId: ID.b, cwd: OTHER, startedAt: 800, name: 'realms-b8' }),
    '99999.json': JSON.stringify({ pid: 99999, sessionId: ID.c, cwd: HANGAR, startedAt: 700 }),
    'half-written.json': '{"pid":1,"sessi',
    'notes.txt': 'ignored',
  };

  const deps = {
    env: { HANGAR_CLAUDE_HOME: 'D:/fake' },
    readdir: () => Object.keys(files),
    readFile: (file) => files[file.replace(/^.*[\\/]/, '')],
    alive: (pid) => pid !== 99999,
  };

  it('lists the claudes that are actually running', () => {
    expect(readLive(deps)).toEqual([
      { id: ID.a, cwd: HANGAR, name: 'hangar-71', startedAt: 900 },
      { id: ID.b, cwd: OTHER, name: 'realms-b8', startedAt: 800 },
    ]);
  });

  it('answers nothing when claude has never run here', () => {
    expect(readLive({ ...deps, readdir: () => { throw new Error('ENOENT'); } })).toEqual([]);
  });
});

describe('recentFor', () => {
  const lines = [
    prompt(ID.a, HANGAR, 1000, 'add a sidebar'),
    prompt(ID.b, OTHER, 1500, 'somebody else'),
    prompt(ID.a, HANGAR, 4000, 'now make it green'),
    prompt(ID.c, HANGAR, 2000, 'fix the icon'),
  ];

  const deps = {
    platform: 'win32',
    history: () => history(lines),
    live: () => [],
  };

  it('lists this project newest first, with a command to resume each', () => {
    expect(recentFor(HANGAR, deps)).toEqual([
      { id: ID.a, label: 'add a sidebar', at: 4000, live: false, command: `claude --resume ${ID.a}` },
      { id: ID.c, label: 'fix the icon', at: 2000, live: false, command: `claude --resume ${ID.c}` },
    ]);
  });

  it('marks the one that is already running', () => {
    const rows = recentFor(HANGAR, {
      ...deps,
      live: () => [{ id: ID.a, cwd: HANGAR.toLowerCase(), name: 'hangar-71', startedAt: 900 }],
    });
    expect(rows.map((r) => [r.id, r.live])).toEqual([[ID.a, true], [ID.c, false]]);
  });

  it('ignores a claude running somewhere else', () => {
    const rows = recentFor(HANGAR, {
      ...deps,
      live: () => [{ id: ID.b, cwd: OTHER, name: 'realms-b8', startedAt: 9000 }],
    });
    expect(rows.every((r) => !r.live)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([ID.a, ID.c]);
  });

  it('lists a claude that has started but not been asked anything yet', () => {
    const rows = recentFor(HANGAR, {
      ...deps,
      live: () => [{ id: ID.b, cwd: HANGAR, name: 'hangar-99', startedAt: 9000 }],
    });
    expect(rows[0]).toEqual({
      id: ID.b, label: 'hangar-99', at: 9000, live: true, command: `claude --resume ${ID.b}`,
    });
  });

  it('falls back to the session id when a live one has no name either', () => {
    const rows = recentFor(HANGAR, {
      ...deps,
      live: () => [{ id: ID.b, cwd: HANGAR, name: null, startedAt: 9000 }],
    });
    expect(rows[0].label).toBe(`session ${ID.b.slice(0, 8)}`);
  });

  it('stops at the limit', () => {
    expect(recentFor(HANGAR, { ...deps, limit: 1 }).map((r) => r.id)).toEqual([ID.a]);
  });

  it('has nothing to say about a project with no path', () => {
    expect(recentFor('', deps)).toEqual([]);
  });
});
