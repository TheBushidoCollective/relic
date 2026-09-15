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

const out = new URL('./dist/', import.meta.url).pathname;
await mkdir(out, { recursive: true });

// Two builds, because exactly one entrypoint wants code splitting and the
// other two must not have it. `main.ts` dynamically imports the PDF renderer,
// and splitting is what keeps that 429 KB out of the app shell. `sandbox.ts`
// is inlined into an HTML document served from the opaque usercontent origin,
// so a chunk import in it would be a request that document cannot make;
// `sw.ts` is a service worker, which cannot import a sibling chunk either.
const built = await Bun.build({
  entrypoints: ['./src/main.ts'],
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

const builtStandalone = await Bun.build({
  entrypoints: ['./src/sandbox.ts', './src/sw.ts'],
  outdir: out,
  target: 'browser',
  format: 'esm',
  minify: true,
  splitting: false,
  naming: '[name].js',
  define: { 'process.env.NODE_ENV': '"production"' },
});

if (!builtStandalone.success) {
  for (const log of builtStandalone.logs) console.error(log);
  process.exit(1);
}

// `main.js` is served as `viewer.js`, because that is the name the shell and
// the service worker's cache list both reference.
await copyFile(`${out}main.js`, `${out}viewer.js`);
await copyFile('./src/styles.css', `${out}styles.css`);

for (const name of await readdir('./public')) {
  await copyFile(`./public/${name}`, `${out}${name}`);
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

const shell = await Bun.file('./public/sandbox.html').text();
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

const names = (await readdir(out)).sort();
console.log(`built ${names.length} assets: ${names.join(', ')}`);
