import { describe, expect, test } from 'bun:test';
import {
  InvalidMnemonicError,
  isMnemonicLike,
  keyToMnemonic,
  MNEMONIC_WORDS,
  mnemonicToKey,
  WORDLIST_SIZE,
  wordlist,
} from '../src/index.ts';

describe('wordlist properties', () => {
  const words = wordlist();

  test('contains exactly 2048 entries', () => {
    expect(words.length).toBe(WORDLIST_SIZE);
    expect(WORDLIST_SIZE).toBe(2048);
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

  test('every word is uniquely identified by its four-character prefix', () => {
    const prefixes = words.map((w) => (w.length >= 4 ? w.slice(0, 4) : w));
    const uniquePrefixes = new Set(prefixes);
    expect(uniquePrefixes.size).toBe(WORDLIST_SIZE);
  });

  test('word lengths fall strictly between 3 and 8 characters inclusive', () => {
    for (const word of words) {
      expect(word.length).toBeGreaterThanOrEqual(3);
      expect(word.length).toBeLessThanOrEqual(8);
    }
  });
});

describe('wordlist digest pin', () => {
  test('matches literal SHA-256 digest constant', async () => {
    // Changing this list invalidates every mnemonic ever spoken and breaks key
    // recovery for existing relics. This pin test exists to guarantee that any
    // modification to the vocabulary is an explicit, deliberate act.
    const PINNED_DIGEST =
      '187db04a869dd9bc7be80d21a86497d692c0db6abd3aa8cb6be5d618ff757fae';

    const words = wordlist();
    const joined = words.join('\n');
    const digestBuffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(joined)
    );
    const hex = Array.from(new Uint8Array(digestBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    expect(hex).toBe(PINNED_DIGEST);
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

  test('round-trips 16 all-0xff bytes', () => {
    const maxKey = new Uint8Array(16).fill(0xff);
    const mnemonic = keyToMnemonic(maxKey);

    expect(mnemonic.length).toBe(MNEMONIC_WORDS);
    const decoded = mnemonicToKey(mnemonic);
    expect(decoded).toEqual(maxKey);
  });

  test('round-trips 250 random 16-byte keys byte-for-byte', () => {
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

  test('accepts mixed whitespace, commas, and newlines', () => {
    const mixedDelimiters = `${canonicalWords.slice(0, 3).join('  ')}, \n${canonicalWords.slice(3, 7).join(',\t')},\n\n${canonicalWords.slice(7).join(' ')}`;
    const decoded = mnemonicToKey(mixedDelimiters);
    expect(decoded).toEqual(originalKey);
  });

  test('folds uppercase and mixed-case tokens to lowercase', () => {
    const upperWords = canonicalWords.map((w, idx) =>
      idx % 2 === 0 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
    );
    const decoded = mnemonicToKey(upperWords);
    expect(decoded).toEqual(originalKey);
  });

  test('ignores surrounding punctuation on individual tokens', () => {
    const punctuated = canonicalWords.map((w, idx) => {
      if (idx === 0) return `"${w}"`;
      if (idx === 2) return `(${w})`;
      if (idx === 5) return `[${w}]`;
      if (idx === 8) return `<${w}>!`;
      return w;
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

  test('rejects fewer than 12 words (11 words) carrying word count in error', () => {
    const elevenWords = validWords.slice(0, 11);
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

  test('rejects more than 12 words (13 words) carrying word count in error', () => {
    const firstWord = validWords[0];
    if (firstWord === undefined) throw new Error('expected word in validWords');
    const thirteenWords = [...validWords, firstWord];
    expect(() => mnemonicToKey(thirteenWords)).toThrow(InvalidMnemonicError);

    try {
      mnemonicToKey(thirteenWords);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMnemonicError);
      const err = error as InvalidMnemonicError;
      expect(err.reason).toBe('count');
      expect(err.wordIndex).toBe(13);
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

  test('rejects a phrase whose checksum is wrong with reason checksum', () => {
    // Valid phrase for 16 bytes of 0x42:
    // "drastic bamboo mountain loyal category cancel animal embark drastic bamboo mountain lunch"
    // Swapping the first word "drastic" for another valid word "abandon" changes the
    // entropy without updating the 4-bit checksum stored in the final word, which
    // causes mnemonicToKey to compute SHA-256 of the altered key and detect a mismatch.
    const corrupted = [...validWords];
    corrupted[0] = 'abandon';

    expect(() => mnemonicToKey(corrupted)).toThrow(InvalidMnemonicError);

    try {
      mnemonicToKey(corrupted);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMnemonicError);
      const err = error as InvalidMnemonicError;
      expect(err.reason).toBe('checksum');
      expect(err.message).toBe('invalid mnemonic checksum');
    }
  });
});

describe('interoperability with standard BIP-39 specification', () => {
  test('matches standard BIP-39 test vector for 16 zero bytes', () => {
    // Derivation by hand directly from BIP-39 specification:
    // 1. Key entropy: 16 zero bytes (128 zero bits).
    // 2. Checksum: SHA-256 of 16 zero bytes begins with byte 0x37 (binary 00110111).
    //    Checksum length for 128 bits is 128 / 32 = 4 bits.
    //    Taking the first 4 bits yields 0011 (decimal 3).
    // 3. Bitstream: 128 zero bits followed by 4 checksum bits 0011 (132 bits total).
    // 4. Split into 12 groups of 11 bits:
    //    - Groups 0 through 10 (words 1 to 11): 11 zero bits each -> index 0 ("abandon").
    //    - Group 11 (word 12): remaining 7 zero bits of entropy plus 4 checksum bits 0011:
    //      binary 00000000011 = decimal 3 -> wordlist[3] ("about").
    // 5. Resulting 12-word mnemonic:
    //    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    const zeroKey = new Uint8Array(16);
    const expected = [
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'about',
    ];

    expect(keyToMnemonic(zeroKey)).toEqual(expected);
    expect(mnemonicToKey(expected)).toEqual(zeroKey);
  });

  test('matches standard BIP-39 test vector for 16 0xff bytes', () => {
    // Derivation by hand directly from BIP-39 specification:
    // 1. Key entropy: 16 bytes of 0xff (128 one bits).
    // 2. Checksum: SHA-256 of 16 0xff bytes begins with byte 0xdc (binary 11011100).
    //    Taking the first 4 bits yields 1101 (decimal 13).
    // 3. Bitstream: 128 one bits followed by 4 checksum bits 1101 (132 bits total).
    // 4. Split into 12 groups of 11 bits:
    //    - Groups 0 through 10 (words 1 to 11): 11 one bits each -> binary 11111111111 = decimal 2047
    //      -> wordlist[2047] ("zoo").
    //    - Group 11 (word 12): remaining 7 one bits of entropy plus 4 checksum bits 1101:
    //      binary 11111111101 = decimal 2029 -> wordlist[2029] ("wrong").
    // 5. Resulting 12-word mnemonic:
    //    11 repetitions of "zoo" followed by "wrong".
    const maxKey = new Uint8Array(16).fill(0xff);
    const expected = [
      'zoo',
      'zoo',
      'zoo',
      'zoo',
      'zoo',
      'zoo',
      'zoo',
      'zoo',
      'zoo',
      'zoo',
      'zoo',
      'wrong',
    ];

    expect(keyToMnemonic(maxKey)).toEqual(expected);
    expect(mnemonicToKey(expected)).toEqual(maxKey);
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

  test('returns true for 12 whitespace-separated alphabetic tokens', () => {
    expect(isMnemonicLike(validWords.join(' '))).toBe(true);
    expect(isMnemonicLike(validWords.join(',\n'))).toBe(true);
  });

  test('returns false for token counts other than 12', () => {
    expect(isMnemonicLike(validWords.slice(0, 11).join(' '))).toBe(false);
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
