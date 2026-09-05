import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  codexHome,
  when,
  readHead,
  rolloutFiles,
  parseMeta,
  parseHistory,
  recentFor,
} = require('../codex-sessions.js');

const HOME = 'D:\\fake-codex';
const SESSIONS = path.join(HOME, 'sessions');
const HANGAR = 'C:\\Users\\James\\Desktop\\Cursor Projects\\Hangar';
const OTHER = 'C:\\Users\\James\\Desktop\\Cursor Projects\\Realms';

const ID = {
  a: '019c9c21-2a46-77c0-87d8-7cf3716a28e6',
  b: '98604b21-d831-469d-9cc8-fcab34b4d9a1',
  c: 'c885d8d2-2e79-48c7-8e20-e410a8f39828',
};

/** A directory listing that answers out of an object, and throws for anything else. */
function fakeReaddir(tree) {
  return (at) => {
    const names = tree[at];
    if (!names) {
      const err = new Error(`ENOENT: ${at}`);
      err.code = 'ENOENT';
      throw err;
    }
    return names;
  };
}

/** The first line of a rollout file, in the shape codex actually writes. */
function meta(id, cwd, timestamp) {
  return JSON.stringify({
    timestamp,
    type: 'session_meta',
    payload: { id, timestamp, cwd, originator: 'codex_cli_rs', cli_version: '0.105.0' },
  });
}

/** One line of history.jsonl, which carries no folder — only a session and a time. */
function prompt(id, ts, text) {
  return JSON.stringify({ session_id: id, ts, text });
}

function history(lines) {
  return () => ({ text: lines.join('\n'), whole: true });
}

/** An fs that answers reads out of a string. */
function fakeIo(content) {
  const buf = Buffer.from(content, 'utf8');
  return {
    openSync: () => 3,
    readSync: (_fd, target, offset, length) => buf.copy(target, offset, 0, Math.min(length, buf.length)),
    closeSync: () => {},
  };
}

describe('codexHome', () => {
  it('is overridable, so a test never reads the real one', () => {
    expect(codexHome({ HANGAR_CODEX_HOME: 'D:/fake' })).toBe('D:/fake');
  });

  it('honours codex\'s own variable, which moves the whole tree', () => {
    expect(codexHome({ CODEX_HOME: 'D:/elsewhere' })).toBe('D:/elsewhere');
  });
});

describe('when', () => {
  it('reads the ISO strings the rollout header writes', () => {
    expect(when('2026-02-26T22:46:23.099Z')).toBe(Date.parse('2026-02-26T22:46:23.099Z'));
  });

  it('reads seconds and milliseconds alike, since history has written both', () => {
    expect(when(1772145983)).toBe(1772145983000);
    expect(when(1772145983099)).toBe(1772145983099);
  });

  it('is zero for anything it cannot read, which sorts to the bottom', () => {
    expect(when('the other day')).toBe(0);
    expect(when(undefined)).toBe(0);
    expect(when({})).toBe(0);
  });
});

describe('readHead', () => {
  it('reads from the front, so the first line arrives whole', () => {
    const io = fakeIo('first line\nsecond line\n');
    expect(readHead('anywhere', 64, { io })).toBe('first line\nsecond line\n');
  });

  it('is empty for a file that cannot be opened, rather than throwing', () => {
    const io = { openSync: () => { throw new Error('ENOENT'); } };
    expect(readHead('nowhere', 64, { io })).toBe('');
  });
});

describe('rolloutFiles', () => {
  const tree = {
    [SESSIONS]: ['2025', '2026', 'archived'],
    [path.join(SESSIONS, '2026')]: ['09'],
    [path.join(SESSIONS, '2026', '09')]: ['04', '05'],
    [path.join(SESSIONS, '2026', '09', '05')]: [
      'rollout-2026-09-05T09-00-00-' + ID.a + '.jsonl',
      'rollout-2026-09-05T18-00-00-' + ID.b + '.jsonl',
    ],
    [path.join(SESSIONS, '2026', '09', '04')]: ['rollout-2026-09-04T10-00-00-' + ID.c + '.jsonl'],
    [path.join(SESSIONS, '2025')]: ['12'],
    [path.join(SESSIONS, '2025', '12')]: ['31'],
    [path.join(SESSIONS, '2025', '12', '31')]: ['rollout-2025-12-31T23-00-00-old.jsonl'],
  };

  it('walks the date folders newest first, which is what the sort is for', () => {
    const files = rolloutFiles(SESSIONS, { readdir: fakeReaddir(tree) });
    expect(files.map((f) => path.basename(f))).toEqual([
      'rollout-2026-09-05T18-00-00-' + ID.b + '.jsonl',
      'rollout-2026-09-05T09-00-00-' + ID.a + '.jsonl',
      'rollout-2026-09-04T10-00-00-' + ID.c + '.jsonl',
      'rollout-2025-12-31T23-00-00-old.jsonl',
    ]);
  });

  it('stops at the limit, so the cost of a right click is bounded', () => {
    const files = rolloutFiles(SESSIONS, { readdir: fakeReaddir(tree), limit: 2 });
    expect(files).toHaveLength(2);
  });

  it('reads the flat layout older versions wrote, out of the same walk', () => {
    const flat = { [SESSIONS]: ['rollout-2026-01-01T00-00-00-' + ID.a + '.jsonl', 'README'] };
    expect(rolloutFiles(SESSIONS, { readdir: fakeReaddir(flat) })).toHaveLength(1);
  });

  it('is empty on a machine with no codex, which is not a failure', () => {
    expect(rolloutFiles(SESSIONS, { readdir: fakeReaddir({}) })).toEqual([]);
  });
});

describe('parseMeta', () => {
  it('reads the record codex writes', () => {
    const line = meta(ID.a, HANGAR, '2026-09-05T10:00:00.000Z');
    expect(parseMeta(`${line}\n{"type":"response_item"}\n`)).toEqual({
      id: ID.a,
      cwd: HANGAR,
      at: Date.parse('2026-09-05T10:00:00.000Z'),
    });
  });

  it('reads the spellings this record has had, since the shape is nobody\'s promise', () => {
    const item = JSON.stringify({
      type: 'session_meta',
      item: { session_id: ID.b, cwd: HANGAR, timestamp: '2026-09-05T10:00:00.000Z' },
    });
    expect(parseMeta(item).id).toBe(ID.b);
  });

  it('refuses anything that is not a session id, which ends up on a command line', () => {
    const nasty = JSON.stringify({
      type: 'session_meta',
      payload: { id: `${ID.a}; rm -rf /`, cwd: HANGAR },
    });
    expect(parseMeta(nasty)).toBeNull();
  });

  it('is null for a first line that is not one of ours', () => {
    expect(parseMeta('')).toBeNull();
    expect(parseMeta('half a line, torn mid-writ')).toBeNull();
    expect(parseMeta(JSON.stringify({ type: 'response_item', payload: {} }))).toBeNull();
    // A session with no folder cannot be filed under a project.
    expect(parseMeta(JSON.stringify({ type: 'session_meta', payload: { id: ID.a } }))).toBeNull();
  });
});

describe('parseHistory', () => {
  it('reads the prompt lines and skips everything else', () => {
    const rows = parseHistory({
      text: [
        prompt(ID.a, 1772145983, 'add a settings tab'),
        'not json at all',
        JSON.stringify({ session_id: 'nope', ts: 1, text: 'x' }),
        prompt(ID.b, 1772145999, 'fix the tests'),
      ].join('\n'),
    });
    expect(rows).toEqual([
      { id: ID.a, at: 1772145983000, prompt: 'add a settings tab' },
      { id: ID.b, at: 1772145999000, prompt: 'fix the tests' },
    ]);
  });

  it('drops the first line when the read began mid-file', () => {
    const rows = parseHistory({
      text: [prompt(ID.a, 1, 'half of this'), prompt(ID.b, 2, 'whole')].join('\n'),
      whole: false,
    });
    expect(rows.map((r) => r.id)).toEqual([ID.b]);
  });
});

describe('recentFor', () => {
  const at = (iso) => Date.parse(iso);

  const sessions = () => ([
    { id: ID.a, cwd: HANGAR, at: at('2026-09-05T09:00:00Z') },
    { id: ID.b, cwd: 'c:/users/james/desktop/cursor projects/hangar/', at: at('2026-09-04T09:00:00Z') },
    { id: ID.c, cwd: OTHER, at: at('2026-09-05T23:00:00Z') },
  ]);

  // history.jsonl writes seconds, and these have to sit later than the rollout
  // headers above: the last prompt is what dates a row.
  const secs = (iso) => Date.parse(iso) / 1000;

  const deps = {
    platform: 'win32',
    sessions,
    history: history([
      prompt(ID.a, secs('2026-09-05T10:00:00Z'), 'add an agent tab to settings'),
      prompt(ID.a, secs('2026-09-05T11:00:00Z'), 'and a test for it'),
      prompt(ID.b, secs('2026-09-04T10:00:00Z'), '/diff'),
      prompt(ID.c, secs('2026-09-05T23:30:00Z'), 'something in the other project'),
    ]),
  };

  it('lists only the sessions started in this folder', () => {
    const rows = recentFor(HANGAR, deps);
    expect(rows.map((r) => r.id)).toEqual([ID.a, ID.b]);
  });

  it('sees through the spellings the same folder arrives in', () => {
    // The rollout records the folder as codex was started in it; Hangar's comes
    // from its own listing. Windows does not care about the difference.
    expect(recentFor(HANGAR, deps).some((r) => r.id === ID.b)).toBe(true);
  });

  it('names a session after the first thing asked of it', () => {
    const row = recentFor(HANGAR, deps).find((r) => r.id === ID.a);
    expect(row.label).toBe('add an agent tab to settings');
  });

  it('dates it by the last, which is when it was really touched', () => {
    const row = recentFor(HANGAR, deps).find((r) => r.id === ID.a);
    expect(row.at).toBe(Date.parse('2026-09-05T11:00:00Z'));
  });

  it('does not name one after a bare slash command, which is not a conversation', () => {
    const row = recentFor(HANGAR, deps).find((r) => r.id === ID.b);
    expect(row.label).toBe(`session ${ID.b.slice(0, 8)}`);
  });

  it('builds the resume command here, where the id has been checked', () => {
    expect(recentFor(HANGAR, deps)[0].command).toBe(`codex resume ${ID.a}`);
  });

  it('marks nothing live, because codex publishes no record of what is running', () => {
    expect(recentFor(HANGAR, deps).every((r) => r.live === false)).toBe(true);
  });

  it('is empty for a project with no sessions, and for no project at all', () => {
    expect(recentFor('C:\\nowhere', deps)).toEqual([]);
    expect(recentFor('', deps)).toEqual([]);
  });

  it('stops at the row limit, newest first', () => {
    const many = [];
    for (let i = 0; i < 25; i++) {
      many.push({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        cwd: HANGAR,
        at: at('2026-09-05T00:00:00Z') + i * 1000,
      });
    }
    const rows = recentFor(HANGAR, { ...deps, sessions: () => many });
    expect(rows).toHaveLength(10);
    expect(rows[0].id).toBe(many[24].id);
  });
});
