/**
 * Publishes one relic of each class against a local server, for browser proof.
 *
 * Throwaway. Uses the real `publish` leg rather than seeding the store
 * directly, because the point is to exercise what a publishing client
 * actually produces, including the renderer class it declares.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFiles } from '../src/files.ts';
import { publish } from '../src/publish.ts';

const ORIGIN = process.env['ORIGIN'] ?? 'http://127.0.0.1:4899';
const dir = await mkdtemp(`${tmpdir()}/relic-proof-`);

const repeated = 'The bevel is wrong on this part.';
await writeFile(
  `${dir}/notes.md`,
  `# Review notes\n\n${repeated}\n\n## Second section\n\n${repeated}\n\n## Third section\n\n${repeated}\n`
);
await writeFile(
  `${dir}/page.html`,
  '<!doctype html><html><body style="font:16px system-ui;padding:2rem">' +
    '<h1>Quarterly page</h1>' +
    `<p id="a">${repeated}</p><p id="b">${repeated}</p>` +
    '</body></html>'
);
await writeFile(
  `${dir}/card.png`,
  await readFile(
    new URL('../../relic-viewer/public/card.v1.png', import.meta.url).pathname
  )
);

const deps = {
  serviceOrigin: ORIGIN,
  relicOrigin: ORIGIN,
  clientName: 'proof',
  files: nodeFiles,
  fetch: globalThis.fetch,
} as unknown as Parameters<typeof publish>[1];

for (const file of ['notes.md', 'page.html', 'card.png']) {
  try {
    const res = await publish(
      { path: `${dir}/${file}` } as Parameters<typeof publish>[0],
      deps
    );
    console.log(`${file}\t${res.url}`);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    console.log(`${file}\tFAILED\t${err.code ?? ''}\t${err.message ?? ''}`);
  }
}
