/**
 * Spoken word form for a 16-byte relic key.
 *
 * Encodes a 128-bit key as 10 words from a 7776-word vocabulary (6^5).
 * 7776^10 offers roughly 129.25 bits of capacity, giving about 1.25 bits of
 * headroom above 2^128.
 */

import { InvalidMnemonicError } from './errors.ts';
import { WORDLIST_SIZE, wordlist } from './wordlist.ts';

export const MNEMONIC_WORDS = 10;
export { WORDLIST_SIZE, wordlist };

const BASE = 7776n;
const MAX_KEY_VALUE = 1n << 128n;
const KEY_BYTES = 16;

/**
 * Lazy index mapping each unique 4-character prefix (or 3-letter word)
 * to its corresponding index in the wordlist.
 */
let prefixMap: Map<string, number> | undefined;

function getPrefixMap(): Map<string, number> {
  if (prefixMap === undefined) {
    const map = new Map<string, number>();
    const list = wordlist();
    for (let i = 0; i < list.length; i++) {
      const word = list[i]!;
      const prefix = word.length >= 4 ? word.slice(0, 4) : word;
      map.set(prefix, i);
    }
    prefixMap = map;
  }
  return prefixMap;
}

/**
 * Cheap shape check answering whether text looks like 10 whitespace-separated
 * alphabetic tokens without loading or parsing the wordlist.
 */
export function isMnemonicLike(text: string): boolean {
  if (typeof text !== 'string') return false;
  const tokens = text
    .trim()
    .split(/[\s,\n\r]+/)
    .filter((t) => t.length > 0);
  if (tokens.length !== MNEMONIC_WORDS) return false;

  for (const token of tokens) {
    const match = token.match(/^[^a-zA-Z0-9]*([a-zA-Z]+)[^a-zA-Z0-9]*$/);
    if (!match) return false;
    const word = match[1]!;
    if (word.length < 3 || word.length > 16) return false;
  }

  return true;
}

/**
 * Convert a 16-byte relic key into a 10-word mnemonic phrase.
 *
 * Interprets the 16 bytes as a big-endian integer and writes it in base 7776,
 * most significant word first.
 */
export function keyToMnemonic(key: Uint8Array): string[] {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new InvalidMnemonicError(
      'range',
      undefined,
      `key must be ${KEY_BYTES} bytes, got ${key?.length}`
    );
  }

  let value = 0n;
  for (let i = 0; i < KEY_BYTES; i++) {
    value = (value << 8n) | BigInt(key[i]!);
  }

  const list = wordlist();
  const words = new Array<string>(MNEMONIC_WORDS);

  for (let i = MNEMONIC_WORDS - 1; i >= 0; i--) {
    const rem = Number(value % BASE);
    value = value / BASE;
    words[i] = list[rem]!;
  }

  return words;
}

/**
 * Decode a 10-word mnemonic phrase back into a 16-byte relic key.
 *
 * Accepts either an array of words or a single string with words separated by
 * whitespace, commas, or newlines. Words are resolved by unique 4-character
 * prefix (or full word for 3-letter entries) with case folding and tolerance
 * for surrounding punctuation.
 */
export function mnemonicToKey(words: readonly string[] | string): Uint8Array {
  let tokens: string[];

  if (typeof words === 'string') {
    tokens = words
      .trim()
      .split(/[\s,\n\r]+/)
      .filter((t) => t.length > 0);
  } else if (Array.isArray(words)) {
    tokens = [];
    for (const item of words) {
      if (typeof item !== 'string') continue;
      const parts = item
        .trim()
        .split(/[\s,\n\r]+/)
        .filter((t) => t.length > 0);
      tokens.push(...parts);
    }
  } else {
    throw new InvalidMnemonicError('count', 0, 'invalid mnemonic input');
  }

  if (tokens.length !== MNEMONIC_WORDS) {
    throw new InvalidMnemonicError(
      'count',
      tokens.length,
      `mnemonic must contain exactly ${MNEMONIC_WORDS} words, got ${tokens.length}`
    );
  }

  const map = getPrefixMap();
  let value = 0n;

  for (let i = 0; i < MNEMONIC_WORDS; i++) {
    const raw = tokens[i]!;
    const cleaned = raw.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
    const prefix = cleaned.length >= 4 ? cleaned.slice(0, 4) : cleaned;
    const index = map.get(prefix);

    if (index === undefined) {
      throw new InvalidMnemonicError(
        'unknown_word',
        i,
        `unknown mnemonic word at index ${i}: ${JSON.stringify(raw)}`
      );
    }

    value = value * BASE + BigInt(index);
  }

  // 7776^10 can express values up to approximately 2^129.25, which exceeds the
  // 128-bit key ceiling. This range check rejects a large fraction of random
  // or corrupt phrases, but it is not a strong cryptographic checksum. The
  // authoritative validation is whether the decrypted container verifies its
  // AEAD authentication tag, which remains the caller responsibility.
  if (value >= MAX_KEY_VALUE) {
    throw new InvalidMnemonicError(
      'range',
      undefined,
      'mnemonic value exceeds 128-bit key range'
    );
  }

  const key = new Uint8Array(KEY_BYTES);
  for (let i = KEY_BYTES - 1; i >= 0; i--) {
    key[i] = Number(value & 0xffn);
    value >>= 8n;
  }

  return key;
}
