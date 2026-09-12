import { describe, expect, test } from 'bun:test';
import {
  isStorableTitle,
  MAX_TITLE_CHARS,
  normalizeTitle,
} from '../src/title.ts';

describe('normalizeTitle', () => {
  test('a filename survives unchanged', () => {
    expect(normalizeTitle('quarterly-report.md')).toBe('quarterly-report.md');
  });

  test('a newline separates rather than joins', () => {
    // The forbidden class would strip it, so the collapse has to run first:
    // "two words" is the honest reading of a name that carried a line break.
    expect(normalizeTitle('two\nwords')).toBe('two words');
  });

  test('controls and bidi overrides are removed, not refused', () => {
    // A client normalizes on the publisher's behalf, because the alternative
    // is refusing a publish over a character nobody typed on purpose.
    expect(normalizeTitle('safe\u0000name')).toBe('safename');
    expect(normalizeTitle('gpj.\u202ename')).toBe('gpj.name');
  });

  test('truncation counts code points, so a pair cannot be split', () => {
    const title = normalizeTitle('🜚'.repeat(MAX_TITLE_CHARS + 10));
    expect([...title]).toHaveLength(MAX_TITLE_CHARS);
    // A lone surrogate would make this fail: the string would be one UTF-16
    // unit longer than its code points and unpaired at the end.
    expect(title).toBe('🜚'.repeat(MAX_TITLE_CHARS));
  });

  test('whitespace-only normalizes to nothing, which means no title', () => {
    expect(normalizeTitle('   \n\t ')).toBe('');
  });
});

describe('isStorableTitle', () => {
  test('accepts an ordinary name', () => {
    expect(isStorableTitle('quarterly-report.md')).toBe(true);
  });

  test('accepts a double space, which is cosmetic and not an attack', () => {
    expect(isStorableTitle('two  spaces.md')).toBe(true);
  });

  test('refuses empty and untrimmed text', () => {
    expect(isStorableTitle('')).toBe(false);
    expect(isStorableTitle(' leading.md')).toBe(false);
    expect(isStorableTitle('trailing.md ')).toBe(false);
  });

  test('refuses the forbidden class', () => {
    expect(isStorableTitle('two\nlines')).toBe(false);
    expect(isStorableTitle('nul\u0000here')).toBe(false);
    expect(isStorableTitle('spoof\u202egpj.exe')).toBe(false);
  });

  test('refuses past the cap, counted in code points', () => {
    expect(isStorableTitle('a'.repeat(MAX_TITLE_CHARS))).toBe(true);
    expect(isStorableTitle('a'.repeat(MAX_TITLE_CHARS + 1))).toBe(false);
    // Under the cap in code points, over it in UTF-16 units. Counting units
    // would refuse a title that is well inside the bound.
    expect(isStorableTitle('🜚'.repeat(MAX_TITLE_CHARS))).toBe(true);
  });
});
