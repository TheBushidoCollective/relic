/**
 * Spoken word form for a 16-byte relic key.
 *
 * Encodes a 128-bit key as 12 words from the 2048-word BIP-39 English vocabulary.
 * 128 bits of key entropy plus a 4-bit checksum (the first 4 bits of SHA-256)
 * gives 132 bits, divided into 12 words of 11 bits each (12 * 11 = 132).
 *
 * The 4-bit checksum detects approximately 15 out of 16 mistyped or corrupt
 * phrases. Decryption is the authoritative validation: the checksum catches
 * typos early, but only successfully decrypting the relic container proves
 * the key is the right one.
 */

import { InvalidMnemonicError } from './errors.ts';
import { WORDLIST_SIZE, wordlist } from './wordlist.ts';

export const MNEMONIC_WORDS = 12;
export { WORDLIST_SIZE, wordlist };

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
      const word = list[i];
      if (word === undefined) continue;
      const prefix = word.length >= 4 ? word.slice(0, 4) : word;
      map.set(prefix, i);
    }
    prefixMap = map;
  }
  return prefixMap;
}

/**
 * Synchronous SHA-256 implementation for computing the 4-bit mnemonic checksum.
 * Keeps @relic/format fully self-contained with zero runtime dependencies.
 */
function sha256(data: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const len = data.length;
  const bitLen = len * 8;
  const padLen = len % 64 < 56 ? 56 - (len % 64) : 120 - (len % 64);
  const totalLen = len + padLen + 8;
  const buf = new Uint8Array(totalLen);
  buf.set(data);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(totalLen - 4, bitLen >>> 0);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000));

  const w = new Int32Array(64);
  const ror = (val: number, n: number): number =>
    (val >>> n) | (val << (32 - n));

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getInt32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const wMinus15 = w[i - 15] ?? 0;
      const wMinus2 = w[i - 2] ?? 0;
      const wMinus16 = w[i - 16] ?? 0;
      const wMinus7 = w[i - 7] ?? 0;
      const s0 = ror(wMinus15, 7) ^ ror(wMinus15, 18) ^ (wMinus15 >>> 3);
      const s1 = ror(wMinus2, 17) ^ ror(wMinus2, 19) ^ (wMinus2 >>> 10);
      w[i] = (wMinus16 + s0 + wMinus7 + s1) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const kVal = K[i] ?? 0;
      const wVal = w[i] ?? 0;
      const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + kVal + wVal) | 0;
      const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, h0);
  outView.setInt32(4, h1);
  outView.setInt32(8, h2);
  outView.setInt32(12, h3);
  outView.setInt32(16, h4);
  outView.setInt32(20, h5);
  outView.setInt32(24, h6);
  outView.setInt32(28, h7);
  return out;
}

/**
 * Cheap shape check answering whether text looks like 12 whitespace-separated
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
    const word = match[1];
    if (word === undefined || word.length < 3 || word.length > 16) return false;
  }

  return true;
}

/**
 * Convert a 16-byte relic key into a 12-word BIP-39 mnemonic phrase.
 *
 * Appends a 4-bit checksum (the first 4 bits of SHA-256 of the key) to the
 * 128-bit key, yielding 132 bits. The 132 bits are split into 12 11-bit
 * indices into the 2048-word vocabulary, most significant bits first.
 */
export function keyToMnemonic(key: Uint8Array): string[] {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new InvalidMnemonicError(
      'range',
      undefined,
      `key must be ${KEY_BYTES} bytes, got ${key?.length}`
    );
  }

  const hash = sha256(key);
  const firstByte = hash[0];
  if (firstByte === undefined) {
    throw new Error('failed to compute key hash');
  }
  const checksum = (firstByte >> 4) & 0x0f;

  let bits = 0n;
  for (let i = 0; i < KEY_BYTES; i++) {
    const byte = key[i];
    if (byte === undefined) {
      throw new InvalidMnemonicError('range', undefined, 'invalid key bytes');
    }
    bits = (bits << 8n) | BigInt(byte);
  }
  bits = (bits << 4n) | BigInt(checksum);

  const list = wordlist();
  const words = new Array<string>(MNEMONIC_WORDS);

  for (let i = MNEMONIC_WORDS - 1; i >= 0; i--) {
    const index = Number(bits & 0x7ffn);
    bits >>= 11n;
    const word = list[index];
    if (word === undefined) {
      throw new Error(`wordlist missing entry at index ${index}`);
    }
    words[i] = word;
  }

  return words;
}

/**
 * Decode a 12-word BIP-39 mnemonic phrase back into a 16-byte relic key.
 *
 * Accepts either an array of words or a single string with words separated by
 * whitespace, commas, or newlines. Words are resolved by unique 4-character
 * prefix (or full word for 3-letter entries) with case folding and tolerance
 * for surrounding punctuation.
 *
 * Validates the embedded 4-bit SHA-256 checksum. Decryption remains the
 * authoritative validation: the checksum catches typos, but only opening the
 * relic proves the key is the right one.
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
  let bits = 0n;

  for (let i = 0; i < MNEMONIC_WORDS; i++) {
    const raw = tokens[i];
    if (raw === undefined) {
      throw new InvalidMnemonicError(
        'count',
        i,
        `missing mnemonic token at index ${i}`
      );
    }
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

    bits = (bits << 11n) | BigInt(index);
  }

  const storedChecksum = Number(bits & 0x0fn);
  bits >>= 4n;

  const key = new Uint8Array(KEY_BYTES);
  for (let i = KEY_BYTES - 1; i >= 0; i--) {
    key[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }

  // Verify the 4-bit checksum against SHA-256 of the recovered key.
  // The checksum catches typos; only opening the relic proves the key is the right one.
  const hash = sha256(key);
  const firstByte = hash[0];
  if (firstByte === undefined) {
    throw new Error('failed to compute key hash for checksum validation');
  }
  const actualChecksum = (firstByte >> 4) & 0x0f;

  if (storedChecksum !== actualChecksum) {
    throw new InvalidMnemonicError(
      'checksum',
      undefined,
      'invalid mnemonic checksum'
    );
  }

  return key;
}
