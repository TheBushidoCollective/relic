/**
 * The app shell must not carry the PDF renderer.
 *
 * This exists because the split was incidental rather than enforced, and an
 * incidental split is one toolchain bump away from being no split at all.
 *
 * The renderer is ~430 KB. Bundled into the shell it took `viewer.js` from
 * 303,891 bytes to 741,279, and the shell is what every reader of every
 * relic downloads, cached wholesale by the service worker, for a renderer
 * most of them never invoke. Nothing about `import()` guarantees a separate
 * chunk: it is the bundler's choice, so the guarantee has to be checked
 * rather than assumed.
 *
 * Two assertions, because either alone can pass while the property is lost.
 * A ceiling catches the renderer arriving inline even under a bundler that
 * renames everything. A marker check catches it arriving while still under
 * the ceiling, and names what leaked.
 */

import { describe, expect, test } from 'bun:test';

const pkgDir = new URL('..', import.meta.url).pathname;

/**
 * Generous against the measured shell, tight against the failure.
 *
 * The shell measured 329,321 bytes with the renderer split out and 741,279
 * with it inline. 450 KB sits far above the first and far below the second,
 * so ordinary growth does not trip it and the regression cannot hide under
 * it.
 */
const SHELL_CEILING_BYTES = 450 * 1024;

describe('the app shell', () => {
  test('does not carry the PDF renderer', async () => {
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    const shell = await Bun.file(`${pkgDir}dist/viewer.js`).text();

    // Identifiers pdf.js exports and cannot be minified away, because they
    // are public API names the module boundary preserves.
    const markers = ['GlobalWorkerOptions', 'getDocument', 'PDFWorker'];
    const inlined = markers.filter((marker) => shell.includes(marker));
    expect(inlined).toEqual([]);

    expect(shell.length).toBeLessThan(SHELL_CEILING_BYTES);
  });

  test('the renderer is emitted as its own chunk', async () => {
    // The other half of the same property. An empty `dist` with no chunk at
    // all would satisfy the shell assertions above while shipping a viewer
    // that cannot open a pdf.
    const chunks = [...new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)];
    expect(chunks.length).toBeGreaterThan(0);

    let carriesRenderer = false;
    for (const chunk of chunks) {
      const content = await Bun.file(`${pkgDir}dist/${chunk}`).text();
      if (content.includes('GlobalWorkerOptions')) carriesRenderer = true;
    }
    expect(carriesRenderer).toBe(true);
  });

  test('the worker is a separate same-origin asset', async () => {
    // Served from `/assets/`, never a CDN: the viewing origin's CSP allows
    // `script-src 'self'` and nothing else, so a remote worker URL would be
    // refused by the browser rather than by review.
    const worker = Bun.file(`${pkgDir}dist/pdf.worker.js`);
    expect(await worker.exists()).toBe(true);
    expect(worker.size).toBeGreaterThan(0);
  });
});
