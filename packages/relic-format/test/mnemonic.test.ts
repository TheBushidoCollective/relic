import { describe, expect, test } from 'bun:test';
import {
  InvalidMnemonicError,
  isMnemonicLike,
  keyToMnemonic,
  MNEMONIC_WORDS,
  mnemonicToKey,
  wordlist,
  WORDLIST_SIZE,
} from '../src/index.ts';

describe('wordlist properties', () => {
  const words = wordlist();

  test('contains exactly 7776 entries', () => {
    expect(words.length).toBe(WORDLIST_SIZE);
    expect(WORDLIST_SIZE).toBe(7776);
  });

  test('every entry consists strictly of lowercase ASCII a-z', () => {
    for (const word of words) {
      expect(/^[a-z]+$/.test(word)).toBe(true);
    }
  });

  test('contains no duplicate words', () => {
    const unique = new Set(words);
    expect(unique.size).toBe(WORDLIST_SIZE);
  });

  test('every word is unique in its first four characters', () => {
    const prefixes = words.map((w) => w.slice(0, 4));
    const uniquePrefixes = new Set(prefixes);
    expect(uniquePrefixes.size).toBe(WORDLIST_SIZE);
  });

  test('word lengths fall strictly between 3 and 8 characters inclusive', () => {
    for (const word of words) {
      expect(word.length).toBeGreaterThanOrEqual(3);
      expect(word.length).toBeLessThanOrEqual(8);
    }
  });

  test('no three-letter word is a prefix of any other word in the list', () => {
    const threeLetterWords = words.filter((w) => w.length === 3);
    expect(threeLetterWords.length).toBeGreaterThan(0);

    for (const shortWord of threeLetterWords) {
      const collisions = words.filter(
        (w) => w !== shortWord && w.startsWith(shortWord)
      );
      expect(collisions.length).toBe(0);
    }
  });
});

describe('keyToMnemonic and mnemonicToKey round trips', () => {
  test('round-trips 16 zero bytes', () => {
    const zeroKey = new Uint8Array(16);
    const mnemonic = keyToMnemonic(zeroKey);

    expect(mnemonic.length).toBe(MNEMONIC_WORDS);
    const decoded = mnemonicToKey(mnemonic);
    expect(decoded).toEqual(zeroKey);
  });

  test('round-trips 16 0xff bytes (maximum 128-bit key)', () => {
    const maxKey = new Uint8Array(16).fill(0xff);
    const mnemonic = keyToMnemonic(maxKey);

    expect(mnemonic.length).toBe(MNEMONIC_WORDS);
    const decoded = mnemonicToKey(mnemonic);
    expect(decoded).toEqual(maxKey);
  });

  test('round-trips at least 200 random CSPRNG keys with exact byte equality', () => {
    for (let i = 0; i < 250; i++) {
      const originalKey = crypto.getRandomValues(new Uint8Array(16));
      const mnemonic = keyToMnemonic(originalKey);
      expect(mnemonic.length).toBe(MNEMONIC_WORDS);

      const restoredKey = mnemonicToKey(mnemonic);
      expect(restoredKey).toEqual(originalKey);
    }
  });
});

describe('input tolerance and normalization on mnemonicToKey', () => {
  const originalKey = new Uint8Array([
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98,
    0x76, 0x54, 0x32, 0x10,
  ]);
  const canonicalWords = keyToMnemonic(originalKey);

  test('accepts a single string separated by whitespace, commas, and newlines', () => {
    const mixedDelimiters = `${canonicalWords.slice(0, 3).join('  ')}, \n${canonicalWords.slice(3, 7).join(',\t')},\n\n${canonicalWords.slice(7).join(' ')}`;
    const decoded = mnemonicToKey(mixedDelimiters);
    expect(decoded).toEqual(originalKey);
  });

  test('folds uppercase and mixed-case tokens to lowercase', () => {
    const upperWords = canonicalWords.map((w, idx) =>
      idx % 2 === 0 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)
    );
    const decoded = mnemonicToKey(upperWords);
    expect(decoded).toEqual(originalKey);
  });

  test('strips surrounding punctuation from tokens', () => {
    const punctuated = canonicalWords.map((w, idx) => {
      if (idx === 0) return `"${w}",`;
      if (idx === 1) return `(${w})`;
      if (idx === 2) return `[${w}].`;
      return `${w};`;
    });
    const decoded = mnemonicToKey(punctuated);
    expect(decoded).toEqual(originalKey);
  });

  test('resolves tokens by four-character prefix', () => {
    const prefixWords = canonicalWords.map((w) =>
      w.length > 4 ? w.slice(0, 4) : w
    );
    const decoded = mnemonicToKey(prefixWords);
    expect(decoded).toEqual(originalKey);
  });
});

describe('mnemonicToKey rejection cases', () => {
  const validKey = new Uint8Array(16).fill(0x42);
  const validWords = keyToMnemonic(validKey);

  test('rejects fewer than 10 words (9 words) carrying word count in error', () => {
    const nineWords = validWords.slice(0, 9);
    expect(() => mnemonicToKey(nineWords)).toThrow(InvalidMnemonicError);

    try {
      mnemonicToKey(nineWords);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMnemonicError);
      const err = error as InvalidMnemonicError;
      expect(err.reason).toBe('count');
      expect(err.wordIndex).toBe(9);
    }
  });

  test('rejects more than 10 words (11 words) carrying word count in error', () => {
    const elevenWords = [...validWords, validWords[0]!];
    expect(() => mnemonicToKey(elevenWords)).toThrow(InvalidMnemonicError);

    try {
      mnemonicToKey(elevenWords);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMnemonicError);
      const err = error as InvalidMnemonicError;
      expect(err.reason).toBe('count');
      expect(err.wordIndex).toBe(11);
    }
  });

  test('rejects an unknown word carrying the failing word index', () => {
    const corrupted = [...validWords];
    corrupted[4] = 'zzzznotaword';

    expect(() => mnemonicToKey(corrupted)).toThrow(InvalidMnemonicError);

    try {
      mnemonicToKey(corrupted);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMnemonicError);
      const err = error as InvalidMnemonicError;
      expect(err.reason).toBe('unknown_word');
      expect(err.wordIndex).toBe(4);
    }
  });

  test('rejects a prefix matching no word carrying the failing word index', () => {
    const corrupted = [...validWords];
    corrupted[7] = 'qqqx';

    expect(() => mnemonicToKey(corrupted)).toThrow(InvalidMnemonicError);

    try {
      mnemonicToKey(corrupted);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMnemonicError);
      const err = error as InvalidMnemonicError;
      expect(err.reason).toBe('unknown_word');
      expect(err.wordIndex).toBe(7);
    }
  });

  test('rejects a 10-word phrase whose decoded integer exceeds 2^128', () => {
    const words = wordlist();
    // Repeating the maximum vocabulary entry guarantees value > 2^128,
    // since 7776^10 - 1 is roughly 8.08e38 against a 2^128 ceiling of 3.40e38.
    const maximumWord = words[words.length - 1]!;
    const overflowingPhrase = new Array(MNEMONIC_WORDS).fill(maximumWord);

    expect(() => mnemonicToKey(overflowingPhrase)).toThrow(
      InvalidMnemonicError
    );

    try {
      mnemonicToKey(overflowingPhrase);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMnemonicError);
      const err = error as InvalidMnemonicError;
      expect(err.reason).toBe('range');
      expect(err.message).toContain('exceeds 128-bit key range');
    }
  });

  test('rejects a 10-word phrase constructed right above 2^128 boundary', () => {
    const words = wordlist();
    let value = 1n << 128n; // smallest value exceeding 128-bit key space
    const boundaryWords = new Array<string>(MNEMONIC_WORDS);

    for (let i = MNEMONIC_WORDS - 1; i >= 0; i--) {
      const rem = Number(value % 7776n);
      value = value / 7776n;
      boundaryWords[i] = words[rem]!;
    }

    expect(() => mnemonicToKey(boundaryWords)).toThrow(InvalidMnemonicError);
  });
});

describe('keyToMnemonic validation', () => {
  test('rejects keys with length other than 16 bytes', () => {
    expect(() => keyToMnemonic(new Uint8Array(15))).toThrow(
      InvalidMnemonicError
    );
    expect(() => keyToMnemonic(new Uint8Array(17))).toThrow(
      InvalidMnemonicError
    );
    expect(() => keyToMnemonic(new Uint8Array(0))).toThrow(
      InvalidMnemonicError
    );
  });
});

describe('isMnemonicLike fast shape check', () => {
  const validWords = keyToMnemonic(new Uint8Array(16).fill(0x12));

  test('returns true for 10 whitespace-separated alphabetic tokens', () => {
    expect(isMnemonicLike(validWords.join(' '))).toBe(true);
    expect(isMnemonicLike(validWords.join(',\n'))).toBe(true);
  });

  test('returns false for token counts other than 10', () => {
    expect(isMnemonicLike(validWords.slice(0, 9).join(' '))).toBe(false);
    expect(isMnemonicLike(validWords.concat('extra').join(' '))).toBe(false);
  });

  test('returns false for non-alphabetic characters inside tokens', () => {
    const tokensWithDigits = [...validWords];
    tokensWithDigits[2] = 'word123';
    expect(isMnemonicLike(tokensWithDigits.join(' '))).toBe(false);
  });

  test('returns false for empty or whitespace-only input', () => {
    expect(isMnemonicLike('')).toBe(false);
    expect(isMnemonicLike('   \n\t  ')).toBe(false);
  });
});
