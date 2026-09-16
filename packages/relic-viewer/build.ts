/**
 * Bundles the viewer into `dist/`, which the app server serves as `/assets/`.
 *
 * Three entry points, deliberately separate bundles. `viewer.js` runs on the
 * service origin and holds the key. `sandbox.js` runs on the usercontent
 * origin and must never contain a line of key-handling code, which staying a
 * separate entry point makes true by construction rather than by review.
 * `sw.js` is the service worker and has to sit at the root scope.
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises';

const pkgDir = new URL('.', import.meta.url).pathname;

/**
 * Computes a deterministic content hash over the shell assets that sw.ts precaches.
 * Any change to viewer.js, styles.css, or manifest.webmanifest alters this hash,
 * which in turn updates SHELL_CACHE and the sw.js bundle bytes.
 */
export function computeShellHash(
  assets: Array<{ path: string; content: Uint8Array | string }>
): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const asset of assets) {
    hasher.update(asset.path);
    hasher.update('\0');
    hasher.update(asset.content);
    hasher.update('\0');
  }
  return hasher.digest('hex').slice(0, 16);
}

export async function buildViewer(options?: {
  outdir?: string;
}): Promise<string> {
  const out = options?.outdir ?? `${pkgDir}dist/`;
  await mkdir(out, { recursive: true });

  // Two builds, because exactly one entrypoint wants code splitting and the
  // other two must not have it. `main.ts` dynamically imports the PDF renderer,
  // and splitting is what keeps that 429 KB out of the app shell. `sandbox.ts`
  // is inlined into an HTML document served from the opaque usercontent origin,
  // so a chunk import in it would be a request that document cannot make;
  // `sw.ts` is a service worker, which cannot import a sibling chunk either.
  const built = await Bun.build({
    entrypoints: [`${pkgDir}src/main.ts`],
    outdir: out,
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: true,
    naming: '[name].js',
    // React picks its development or production build by reading
    // `process.env.NODE_ENV`; with no define the bundler keeps the development
    // branch, which roughly doubles the sandbox page the build then inlines.
    // Nothing in this repo branches on NODE_ENV itself.
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  if (!built.success) {
    for (const log of built.logs) console.error(log);
    process.exit(1);
  }

  const builtSandbox = await Bun.build({
    entrypoints: [`${pkgDir}src/sandbox.ts`],
    outdir: out,
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: false,
    naming: '[name].js',
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  if (!builtSandbox.success) {
    for (const log of builtSandbox.logs) console.error(log);
    process.exit(1);
  }

  // `main.js` is served as `viewer.js`, because that is the name the shell and
  // the service worker's cache list both reference.
  await copyFile(`${out}main.js`, `${out}viewer.js`);
  await copyFile(`${pkgDir}src/styles.css`, `${out}styles.css`);

  for (const name of await readdir(`${pkgDir}public`)) {
    await copyFile(`${pkgDir}public/${name}`, `${out}${name}`);
  }

  const workerPath = new URL(
    './node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).pathname;
  await copyFile(workerPath, `${out}pdf.worker.js`);

  /**
   * Inline the sandbox bundle into its page, rather than linking it.
   *
   * The frame is deliberately given no `allow-same-origin`, which puts its
   * document in an opaque origin. Every request that document makes is
   * therefore cross-origin with `Origin: null`, and a `type="module"` script is
   * fetched with CORS semantics. With no `Access-Control-Allow-Origin` on the
   * response the browser refuses the module, the script never runs, the frame
   * never announces itself, and the parent's markup is posted to a listener that
   * does not exist. The visible result is a blank frame and an empty console,
   * because the failure is in the frame's origin and not the page's.
   *
   * Relaxing CORS on the asset would fix the symptom by making the usercontent
   * origin serve something cross-origin, which is the property that origin
   * exists to remove. An inline script fetches nothing, so there is no request
   * to be blocked and no header anybody can regress.
   *
   * This runs after the copy above, which would otherwise put the linked version
   * back.
   */
  const SCRIPT_TAG = '<script type="module" src="/assets/sandbox.js"></script>';

  const shell = await Bun.file(`${pkgDir}public/sandbox.html`).text();
  if (!shell.includes(SCRIPT_TAG)) {
    console.error(
      'sandbox.html no longer contains the expected script tag, so the bundle ' +
        'would ship linked instead of inlined and the frame would never render'
    );
    process.exit(1);
  }

  const sandboxJs = await Bun.file(`${out}sandbox.js`).text();
  await Bun.write(
    `${out}sandbox.html`,
    shell.replace(
      SCRIPT_TAG,
      // A `</script` anywhere in the bundle would close the tag early. Minified
      // output has no reason to contain one, which is exactly why it would go
      // unnoticed if it ever did.
      //
      // The replacement is a function, not a string, because the bundle now
      // carries React and minified React contains `$&`. In a string
      // replacement that expands to the matched script tag, splicing tag
      // fragments into the code and shipping a bundle that cannot parse.
      () =>
        `<script type="module">${sandboxJs.replace(/<\/script/gi, '<\\/script')}</script>`
    )
  );

  // Compute the shell asset hash across viewer.js, styles.css, and manifest.webmanifest.
  // This build identity is injected into sw.ts so SHELL_CACHE changes on every deploy
  // that modifies shell assets, making sw.js byte-different and forcing an update.
  const shellAssetFiles = [
    { path: '/assets/viewer.js', file: `${out}viewer.js` },
    { path: '/assets/styles.css', file: `${out}styles.css` },
    { path: '/manifest.webmanifest', file: `${out}manifest.webmanifest` },
  ];

  const assetBuffers = await Promise.all(
    shellAssetFiles.map(async ({ path, file }) => ({
      path,
      content: new Uint8Array(await Bun.file(file).arrayBuffer()),
    }))
  );

  const buildHash = computeShellHash(assetBuffers);

  const builtSw = await Bun.build({
    entrypoints: [`${pkgDir}src/sw.ts`],
    outdir: out,
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: false,
    naming: '[name].js',
    define: {
      'process.env.NODE_ENV': '"production"',
      __BUILD_HASH__: JSON.stringify(buildHash),
      __SHELL_CACHE__: JSON.stringify(`relic-shell-${buildHash}`),
    },
  });

  if (!builtSw.success) {
    for (const log of builtSw.logs) console.error(log);
    process.exit(1);
  }

  const names = (await readdir(out)).sort();
  console.log(
    `built ${names.length} assets (shell hash: ${buildHash}): ${names.join(', ')}`
  );

  return buildHash;
}

if (import.meta.main) {
  await buildViewer();
}
