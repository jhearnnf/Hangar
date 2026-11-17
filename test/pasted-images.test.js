import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findPlaceholders, placeholderSpans, countPlaceholders, newPlaceholder,
} = require('../renderer/pasted-images.js');

describe('pasted image placeholders', () => {
  it('finds every [Image #N] in order', () => {
    expect(findPlaceholders('> look [Image #1] and [Image #12]')).toEqual([1, 12]);
    expect(findPlaceholders('[Pasted text #1 +20 lines]')).toEqual([]);
  });

  it('reports where each one sits', () => {
    expect(placeholderSpans('ab [Image #3]')).toEqual([{ n: 3, start: 3, end: 13 }]);
  });

  it('picks the number that newly appeared', () => {
    const before = countPlaceholders('[Image #1]');
    expect(newPlaceholder(before, countPlaceholders('[Image #1]'))).toBe(null);
    expect(newPlaceholder(before, countPlaceholders('[Image #1] [Image #2]'))).toBe(2);
  });

  it('notices a number reused by a fresh session', () => {
    const before = countPlaceholders('old [Image #1]');
    expect(newPlaceholder(before, countPlaceholders('old [Image #1]\n> [Image #1]'))).toBe(1);
  });
});

describe('placeholdersWithText', () => {
  it('takes the words after each placeholder', () => {
    const { placeholdersWithText } = require('../renderer/pasted-images.js');
    expect(placeholdersWithText('> [Image #3]  testing   image paste')).toEqual([{ n: 3, snippet: 'testing image paste' }]);
  });
});
