import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createImageStore, projectDir, resumedSession, parseTranscript, matchesLine,
} = require('../images.js');

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OTHER = '11111111-2222-4333-8444-555555555555';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function line(n, text, data = 'iVBORw0KGgo=') {
  return JSON.stringify({
    type: 'user',
    imagePasteIds: [n],
    message: { content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] },
  });
}

function fakeFs(files) {
  return {
    env: { HANGAR_CLAUDE_HOME: '/home/.claude' },
    readFile: async (file) => {
      if (!(file in files)) throw new Error('ENOENT');
      return files[file];
    },
    readdir: async (dir) => Object.keys(files).filter((f) => path.dirname(f) === dir).map((f) => path.basename(f)),
    stat: async (file) => ({ mtimeMs: files[file].length, size: files[file].length }),
  };
}

describe('transcript pictures', () => {
  it('names the project folder the way claude does', () => {
    expect(path.basename(projectDir(String.raw`C:\Users\James\Desktop\Cursor Projects\Hangar`, {})))
      .toBe('C--Users-James-Desktop-Cursor-Projects-Hangar');
  });

  it('reads the session id out of a resume command only', () => {
    expect(resumedSession(`claude --resume ${ID}`)).toBe(ID);
    expect(resumedSession('claude')).toBe(null);
    expect(resumedSession(`claude --resume ${ID}; rm -rf /`)).toBe(null);
  });

  it('pairs each paste id with its picture and prompt', () => {
    const found = parseTranscript([line(1, '[Image #1] look'), '{"type":"user","message":{}}', 'torn {'].join('\n'));
    expect(found).toEqual([{ n: 1, text: '[Image #1] look', url: PNG }]);
  });

  it('ignores pictures that are not base64', () => {
    expect(parseTranscript(line(1, 'x', '"><script>'))).toEqual([]);
  });

  it('matches a replayed line by its words', () => {
    const found = { n: 3, text: '[Image #3] testing image paste' };
    expect(matchesLine(found, 3, '  testing image')).toBe(true);
    expect(matchesLine(found, 2, 'testing image')).toBe(false);
    expect(matchesLine(found, 3, 'te')).toBe(false);
  });
});

describe('image store', () => {
  it('keeps live pictures, newest per number', () => {
    const store = createImageStore(fakeFs({}));
    const changes = [];
    store.on('changed', (e) => changes.push(e.id));
    store.open('s1', { cwd: 'C:/p' });
    expect(store.add('s1', 1, PNG)).toBe(true);
    expect(store.add('s1', 1, PNG)).toBe(true);
    expect(store.add('s1', 2, 'javascript:alert(1)')).toBe(false);
    expect(store.list('s1').map((i) => i.n)).toEqual([1]);
    expect(changes).toEqual(['s1', 's1']);
    store.close('s1');
    expect(store.list('s1')).toEqual([]);
  });

  it('loads a resumed chat from its transcript', async () => {
    const dir = projectDir('C:/p', { HANGAR_CLAUDE_HOME: '/home/.claude' });
    const store = createImageStore(fakeFs({ [path.join(dir, `${ID}.jsonl`)]: line(1, '[Image #1] a') + '\n' + line(2, '[Image #2] b') }));
    await store.open('s1', { cwd: 'C:/p', command: `claude --resume ${ID}` });
    expect(store.meta('s1').map((i) => i.n)).toEqual([1, 2]);
    expect(store.get('s1', store.meta('s1')[0].key)).toBe(PNG);
  });

  it('finds a chat resumed another way by its replayed line', async () => {
    const dir = projectDir('C:/p', { HANGAR_CLAUDE_HOME: '/home/.claude' });
    const store = createImageStore(fakeFs({
      [path.join(dir, `${OTHER}.jsonl`)]: line(1, '[Image #1] something else'),
      [path.join(dir, `${ID}.jsonl`)]: line(1, '[Image #1] the real prompt here'),
    }));
    await store.open('s1', { cwd: 'C:/p', command: 'claude' });
    expect(await store.find('s1', 1, 'the real prompt')).toBe(true);
    expect(store.meta('s1').map((i) => i.n)).toEqual([1]);
    // Asked once; the same question is not searched again.
    expect(await store.find('s1', 1, 'the real prompt')).toBe(false);
  });

  it('does not let a transcript replace a live picture', async () => {
    const dir = projectDir('C:/p', { HANGAR_CLAUDE_HOME: '/home/.claude' });
    const store = createImageStore(fakeFs({ [path.join(dir, `${ID}.jsonl`)]: line(1, '[Image #1] a', 'AAAA') }));
    await store.open('s1', { cwd: 'C:/p' });
    store.add('s1', 1, PNG);
    await store.link('s1', ID);
    expect(store.list('s1').map((i) => i.url)).toEqual([PNG]);
  });
});
