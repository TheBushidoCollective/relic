/**
 * Two-version relics for exercising the compare screen.
 *
 * Throwaway. The markdown relic's versions differ in length, so a proportional
 * mirror is distinguishable from an absolute one: the shorter pane runs out of
 * scroll first. The code relic carries lines wide enough to scroll sideways
 * with unchanged context rows between the changes, which is the second place
 * the screen scrolls.
 */

import {
  encodeFragment,
  encryptRelic,
  generateKey,
  generateRelicId,
} from '../relic-format/src/index.ts';
import type { RendererClass } from '../relic-format/src/renderer-class.ts';
import { createApp } from '../relic-server/src/app.ts';
import { crc32cBase64, MemoryStorage } from '../relic-server/src/storage.ts';
import { MemoryStore, type RelicRow } from '../relic-server/src/store.ts';

const PORT = 8490;
const USERCONTENT_PORT = 8491;
const OBJECT_PORT = 8492;
const SERVICE = `http://localhost:${PORT}`;
const OBJECT_ORIGIN = `http://localhost:${OBJECT_PORT}`;

const store = new MemoryStore();
// Pointed at a real origin, because the viewer follows the signed URL it is
// handed and the default one does not resolve. The bytes are kept here too so
// that origin can serve them.
const storage = new MemoryStorage(OBJECT_ORIGIN);
const objects = new Map<string, Uint8Array>();
const app = createApp({
  store,
  storage,
  now: () => Date.now(),
  config: {
    serviceOrigin: SERVICE,
    usercontentOrigin: `http://localhost:${USERCONTENT_PORT}`,
  },
});

/** Stands in for the object store the signed URL points at, CORS included. */
const objectServer = Bun.serve({
  port: OBJECT_PORT,
  fetch: (request) => {
    const key = decodeURIComponent(
      new URL(request.url).pathname.replace(/^\/o\//, '')
    );
    const bytes = objects.get(key);
    const headers = {
      'access-control-allow-origin': '*',
      'content-type': 'application/octet-stream',
    };
    if (bytes === undefined)
      return new Response('no object', { status: 404, headers });
    return new Response(bytes as unknown as BodyInit, { headers });
  },
});

/** The server's own key shape: version 1 is the bare id. */
const objectKey = (id: string, version: number): string =>
  version === 1 ? id : `${id}/v${version}`;

const prose = (
  label: string,
  sections: number,
  tail: string[] = []
): string => {
  const out = [`# ${label}`, ''];
  for (let i = 1; i <= sections; i++) {
    out.push(
      `## Section ${i}`,
      '',
      `Paragraph ${i} of ${label}. It carries enough words to occupy a line ` +
        'or two of a reading column so the pane has somewhere to scroll to, ' +
        `and it names its own number so a reader can see which part of the ` +
        `document a pane is showing: ${i}.`,
      ''
    );
  }
  out.push(...tail);
  return out.join('\n');
};

const notesV1 = prose('Release notes', 30);
const notesV2 = prose('Release notes', 22, [
  '## Appendix',
  '',
  'Added in version 2, at the very end, so a reader at the bottom of one',
  'pane should be at the bottom of the other.',
  '',
]);

const wide = (n: number): string =>
  `const row${n} = compute(${Array.from(
    { length: 14 },
    (_, i) => `argument_${n}_${i}`
  ).join(
    ', '
  )}); // trailing commentary that pushes this line well past the width of the column so the row has to scroll sideways`;

const context = [
  'function unchangedContext() {',
  '  // The same in both versions, so the diff renders these as context rows.',
  '  return "context";',
  '}',
];

const codeV1 = [
  ...Array.from({ length: 5 }, (_, i) => wide(i + 1)),
  ...context,
  ...Array.from({ length: 5 }, (_, i) => wide(i + 20)),
].join('\n');

const codeV2 = [
  ...Array.from({ length: 5 }, (_, i) => wide(i + 1)),
  ...context,
  ...Array.from({ length: 5 }, (_, i) => wide(i + 40)),
].join('\n');

async function publish(
  filename: string,
  mimetype: string,
  rendererClass: RendererClass,
  versions: readonly string[]
): Promise<string> {
  const key = await generateKey();
  const id = generateRelicId();

  const containers: Uint8Array[] = [];
  for (const source of versions) {
    containers.push(
      await encryptRelic({
        key,
        content: new TextEncoder().encode(source),
        filename,
        mimetype,
      })
    );
  }

  const first = containers[0];
  if (first === undefined) throw new Error('no versions given');

  const row: RelicRow = {
    id,
    publishIp: '127.0.0.1',
    grantedAt: Date.now(),
    expiresAt: undefined,
    rendererClass,
    publishingClient: 'proof',
    declaredSizeBytes: first.length,
    version: 1,
    publishTokenHash: 'proof',
    mintsUsed: 0,
    title: filename,
  };
  await store.putRelic(row);
  storage.put(objectKey(id, 1), first);
  objects.set(objectKey(id, 1), first);
  await store.markPublished(id, Date.now(), first.length, crc32cBase64(first));

  for (let version = 2; version <= containers.length; version++) {
    const container = containers[version - 1];
    if (container === undefined) continue;
    await store.beginVersion(id, rendererClass, container.length);
    storage.put(objectKey(id, version), container);
    objects.set(objectKey(id, version), container);
    await store.markPublished(
      id,
      Date.now(),
      container.length,
      crc32cBase64(container)
    );
  }

  return `${SERVICE}/${id}#${encodeFragment(key)}`;
}

const notes = await publish('notes.md', 'text/markdown', 'markdown', [
  notesV1,
  notesV2,
]);
const code = await publish('build.ts', 'text/plain', 'code', [codeV1, codeV2]);

const shell = Bun.serve({ port: PORT, fetch: app.fetch });
const usercontent = Bun.serve({ port: USERCONTENT_PORT, fetch: app.fetch });

console.log(`markdown\t${notes}`);
console.log(`code\t${code}`);
console.log(
  `ready on ${shell.port}, ${usercontent.port} and ${objectServer.port}`
);
