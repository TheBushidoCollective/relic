/**
 * The share proof (`spec/format.md` 3.14).
 *
 * A reader can enroll addresses in a relic's change notices from the viewer,
 * and only a holder of the key may do that. The service never sees the key,
 * so it cannot check possession directly. What it can check is a value only a
 * key holder can compute: the publisher's client registers the SHA-256 of a
 * key-derived proof when it publishes or republishes, and a reader presents
 * the proof itself when sharing. The service compares hashes and learns the
 * proof, which decrypts nothing.
 *
 * Another HKDF label off the same 16 bytes the fragment carries, for the same
 * reason the comment key is one (`comments.ts`): the fragment has no room for
 * a second secret, and a distinct label yields a value independent of the
 * content key, the nonce, and the comment key by construction.
 *
 * This package owns it because the publishing client derives the verifier and
 * the viewer derives the proof, and two definitions of either would drift into
 * a share button that is always refused.
 */

const SHARE_PROOF_INFO = new TextEncoder().encode('relic/share-proof/v1');

/** Bytes in a share proof. */
export const SHARE_PROOF_BYTES = 32;

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

/**
 * Derive a relic's share proof from the key the fragment carries.
 *
 * HKDF-SHA256, zero-length salt, `relic/share-proof/v1`, expanded to 256 bits.
 */
export async function deriveShareProof(
  keyBytes: Uint8Array
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    toBufferSource(keyBytes),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: SHARE_PROOF_INFO,
    },
    material,
    SHARE_PROOF_BYTES * 8
  );
  return new Uint8Array(bits);
}

/**
 * The value a publisher registers: lowercase hex SHA-256 of the proof.
 *
 * Registered rather than the proof itself so the service holds nothing a
 * sharer could replay until a sharer actually presents it.
 */
export async function shareVerifierFor(proof: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBufferSource(proof));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}
