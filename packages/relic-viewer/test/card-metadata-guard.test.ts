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

    // Named tokens rather than five bare assertions. The previous shape
    // reported only "Expected: false, Received: true", which says neither
    // which bundle tripped nor which token did it, and that cost a CI cycle
    // to find out because the failure did not reproduce locally.
    //
    // The property prefixes require quoting, and that is a correctness fix
    // rather than a loosening. `\bog:` matches a minified identifier named
    // `og`, and the bundle now carries 377 KB of third-party code whose
    // mangled names are chosen by whichever version of the minifier ran. So
    // the old pattern passed here and failed on CI, and it would have kept
    // flapping with every toolchain bump. A card read is a string literal,
    // `'og:title'`, or a selector; a mangled binding has no quote in front
    // of it. The nearest miss the tree already contains is `log:"code"` in
    // the extension map, which is exactly the shape that makes an unquoted
    // match worthless.
    const forbidden: readonly (readonly [string, RegExp])[] = [
      ['og: property literal', /["']og:/],
      ['twitter: property literal', /["']twitter:/],
      ['card raster name', /card\.v1/],
      ['meta-by-property selector', /meta\[property/],
      ['meta-by-name selector', /meta\[name/],
    ];

    // Every emitted script, not a fixed list. Code splitting means the
    // routing code can move into a chunk, and a guard that names files by
    // hand stops covering the code the moment the bundler rearranges it.
    const emitted = [...new Bun.Glob('*.js').scanSync(`${pkgDir}dist`)];
    expect(emitted.length).toBeGreaterThan(0);
    const files = [...emitted, 'sandbox.html'];

    const hits: string[] = [];
    for (const file of files) {
      const content = await Bun.file(`${pkgDir}dist/${file}`).text();
      for (const [label, pattern] of forbidden) {
        if (pattern.test(content)) hits.push(`${file}: ${label}`);
      }
    }

    expect(hits).toEqual([]);
  });
});
