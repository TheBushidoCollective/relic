import { describe, expect, test } from 'bun:test';
import { deriveShareProof, shareVerifierFor } from '../src/index.ts';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('share proof', () => {
  // A known answer, computed independently with Python's hmac module from RFC
  // 5869's definition, so the client that registers the verifier and the
  // viewer that presents the proof are pinned to the same bytes rather than
  // to whatever this implementation happens to produce.
  test('matches the independently computed vector for key 00..0f', async () => {
    const key = Uint8Array.from({ length: 16 }, (_, i) => i);
    const proof = await deriveShareProof(key);
    expect(hex(proof)).toBe(
      'c7a63439956113d46dad23c42853c01267fdd76936a0e842ea7497c2af0d0bc5'
    );
    expect(await shareVerifierFor(proof)).toBe(
      '1d9d36de491218c5183a0e4f9215dce82f9cd0c5094ab6aa4f6610b1e7e61c85'
    );
  });

  test('a different key gives a proof the first verifier refuses', async () => {
    const verifier = await shareVerifierFor(
      await deriveShareProof(new Uint8Array(16))
    );
    const other = await deriveShareProof(new Uint8Array(16).fill(1));
    expect(await shareVerifierFor(other)).not.toBe(verifier);
  });
});
