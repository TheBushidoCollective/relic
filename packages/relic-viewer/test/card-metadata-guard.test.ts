/**
 * Guard against reading card metadata from the DOM in the client bundles.
 *
 * The served HTML head on the service origin carries Open Graph and Twitter
 * card metadata, including the coarse renderer class and publisher-declared
 * title. The viewer runs on this origin and holds the fragment decryption key.
 *
 * A failure in this test means a publisher-asserted string on the key-holding
 * origin has become a routing or rendering input. If the viewer reads card
 * metadata from the DOM, an attacker could craft card attributes to influence
 * routing or sandbox decisions, turning a publisher lie into fragment theft.
 *
 * Routing inputs must come exclusively from the authenticated envelope header
 * inside the AEAD and the sniffed decrypted bytes, never from the ambient DOM.
 */

import { describe, expect, test } from 'bun:test';

const pkgDir = new URL('..', import.meta.url).pathname;

describe('card metadata isolation', () => {
  test('built viewer and sandbox bundles never read card metadata from the DOM', async () => {
    // Build for real rather than trusting a dist/ that may predate the
    // change under test.
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    const bundleFiles = ['viewer.js', 'sandbox.js', 'sandbox.html'];

    for (const file of bundleFiles) {
      const content = await Bun.file(`${pkgDir}dist/${file}`).text();

      // Card property prefixes and metadata tokens.
      expect(/\bog:/.test(content)).toBe(false);
      expect(/\btwitter:/.test(content)).toBe(false);
      expect(content.includes('card.v1')).toBe(false);

      // DOM selectors targeting meta tags by property or name.
      expect(content.includes('meta[property')).toBe(false);
      expect(content.includes('meta[name')).toBe(false);
    }
  });
});
