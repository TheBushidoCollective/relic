/**
 * Throwaway proof fixture serving multi-version relics for markdown, code,
 * and sandboxed-html comparison views.
 *
 * Runs two Bun.serve listeners:
 * - Service origin: http://127.0.0.1:8510
 * - Usercontent origin: http://127.0.0.1:8511
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFiles } from '../relic-mcp/src/files.ts';
import { type PublishDeps, publish } from '../relic-mcp/src/publish.ts';
import { republish } from '../relic-mcp/src/republish.ts';
import { createApp } from '../relic-server/src/app.ts';
import { diskAssets } from '../relic-server/src/assets.ts';
import { MemoryStorage } from '../relic-server/src/storage.ts';
import { MemoryStore } from '../relic-server/src/store.ts';

const SERVICE_PORT = 8510;
const USERCONTENT_PORT = 8511;
const serviceOrigin = `http://127.0.0.1:${SERVICE_PORT}`;
const usercontentOrigin = `http://127.0.0.1:${USERCONTENT_PORT}`;

const viewerDist = fileURLToPath(new URL('./dist/', import.meta.url));

const scratch = await mkdtemp(join(tmpdir(), 'relic-proof-scroll-'));
process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');

const store = new MemoryStore();
const storage = new MemoryStorage();

function routedFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    if (url.hostname !== 'storage.invalid') return fetch(url.toString(), init);

    const key = url.pathname.replace(/^\/(?:upload|o)\//, '');
    if (init?.method === 'PUT') {
      storage.put(key, new Uint8Array(init.body as Uint8Array));
      return new Response(null, { status: 200 });
    }

    const bytes = await storage.read(key);
    if (bytes === undefined) return new Response(null, { status: 404 });
    return new Response(bytes as unknown as BodyInit, { status: 200 });
  }) as typeof globalThis.fetch;
}

const app = createApp({
  config: {
    serviceOrigin,
    usercontentOrigin,
  },
  store,
  storage,
  assets: diskAssets(viewerDist),
});

// Start listeners first so publish can connect to challenge endpoint
Bun.serve({
  port: SERVICE_PORT,
  fetch: app.fetch,
});

Bun.serve({
  port: USERCONTENT_PORT,
  fetch: app.fetch,
});

const deps: PublishDeps = {
  serviceOrigin,
  relicOrigin: serviceOrigin,
  files: nodeFiles,
  fetch: routedFetch(),
  clientName: 'relic-viewer/proof-compare-scroll',
};

// 1. Markdown relic with 2 versions
const mdV1Path = join(scratch, 'doc-v1.md');
const mdV2Path = join(scratch, 'doc-v2.md');
let mdV1Content = '# Chapter One: The Beginning\n\n';
for (let i = 1; i <= 60; i++) {
  mdV1Content += `Paragraph ${i}: The story unfolds with historical facts and descriptions of events across various regions.\n\n`;
}
let mdV2Content = '# Chapter One: The Expanded Edition\n\n';
for (let i = 1; i <= 100; i++) {
  mdV2Content += `Expanded paragraph ${i}: Additional details and observations recorded for the second version.\n\n`;
}
await writeFile(mdV1Path, mdV1Content);
await writeFile(mdV2Path, mdV2Content);

const mdPub = await publish({ path: mdV1Path, filename: 'document.md' }, deps);
await republish(
  { relic_id: mdPub.relic_id, path: mdV2Path, filename: 'document.md' },
  deps
);

// 2. Code relic with 2 versions
const codeV1Path = join(scratch, 'service-v1.ts');
const codeV2Path = join(scratch, 'service-v2.ts');
let codeV1Content = '// Service v1 implementation\n';
for (let i = 1; i <= 80; i++) {
  codeV1Content += `export const metric_${i} = ${i * 10};\n`;
}
let codeV2Content = '// Service v2 implementation\n';
for (let i = 1; i <= 120; i++) {
  codeV2Content += `export const metric_${i} = ${i * 20};\n`;
}
await writeFile(codeV1Path, codeV1Content);
await writeFile(codeV2Path, codeV2Content);

const codePub = await publish(
  { path: codeV1Path, filename: 'service.ts' },
  deps
);
await republish(
  { relic_id: codePub.relic_id, path: codeV2Path, filename: 'service.ts' },
  deps
);

// 3. Sandboxed-html relic with 2 versions
const htmlV1Path = join(scratch, 'page-v1.html');
const htmlV2Path = join(scratch, 'page-v2.html');
let htmlV1Content =
  '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:2rem;line-height:1.6;}</style></head><body><h1>Interactive Page v1</h1>';
for (let i = 1; i <= 60; i++) {
  htmlV1Content += `<p>Section ${i}: Content rendered in an isolated frame with no network access.</p>`;
}
htmlV1Content += '</body></html>';

let htmlV2Content =
  '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:2rem;line-height:1.6;background:#f9fafb;}</style></head><body><h1>Interactive Page v2</h1>';
for (let i = 1; i <= 100; i++) {
  htmlV2Content += `<p>Expanded section ${i}: Revised content rendered with updated styling and additional commentary.</p>`;
}
htmlV2Content += '</body></html>';

await writeFile(htmlV1Path, htmlV1Content);
await writeFile(htmlV2Path, htmlV2Content);

const htmlPub = await publish(
  { path: htmlV1Path, filename: 'page.html' },
  deps
);
await republish(
  { relic_id: htmlPub.relic_id, path: htmlV2Path, filename: 'page.html' },
  deps
);

console.log('--- Proof compare URLs ---');
console.log(`markdown:       ${mdPub.url}`);
console.log(`code:           ${codePub.url}`);
console.log(`sandboxed-html: ${htmlPub.url}`);
console.log(`ready on ${SERVICE_PORT}`);
