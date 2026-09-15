/**
 * Serves relics with earlier versions that cannot be compared.
 *
 * Throwaway. Three fixtures, one per cause, because the reported defect has
 * three sources and a fix proven on one of them is not proven.
 *
 *   prose-then-picture  v1 markdown, v2 image      -> display modes differ
 *   picture-then-prose  v1 image,    v2 markdown   -> the reverse
 *   archive             v1 and v2 both zip         -> download-only
 */

import {
  encodeFragment,
  encryptRelic,
  generateKey,
  generateRelicId,
} from '@relic/format';
import { createApp } from '../relic-server/src/app.ts';
import { diskAssets } from '../relic-server/src/assets.ts';
import { MemoryStorage } from '../relic-server/src/storage.ts';
import { MemoryStore } from '../relic-server/src/store.ts';

const SERVICE = 'http://localhost:8490';
const USERCONTENT = 'http://127.0.0.1:8491';

const storage = new MemoryStorage(SERVICE);
const store = new MemoryStore();
const objects = new Map<string, Uint8Array>();

const app = createApp({
  config: {
    serviceOrigin: SERVICE,
    usercontentOrigin: USERCONTENT,
    killSwitchEngaged: false,
  },
  storage,
  store,
  assets: diskAssets(new URL('./dist/', import.meta.url).pathname),
  operatorTokens: new Map(),
});

function serve(request: Request): Response | Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/o/')) {
    // MemoryStorage signs against the service origin here, so the bytes are
    // served from it: the viewer's CSP allows `connect-src 'self'` only.
    const id = path.slice(3).split('?')[0] ?? '';
    const bytes = objects.get(id);
    if (bytes === undefined) return new Response('no object', { status: 404 });
    return new Response(bytes as unknown as BodyInit, {
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  return app.fetch(request);
}

const s1 = Bun.serve({ port: 8490, fetch: serve });
const s2 = Bun.serve({ port: 8491, fetch: serve });

const png = new Uint8Array(
  await Bun.file(new URL('./public/card.v1.png', import.meta.url)).bytes()
);

/** A real, if tiny, zip. Enough to classify as an archive. */
function emptyZip(): Uint8Array {
  return new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0,
  ]);
}

interface Revision {
  readonly filename: string;
  readonly mimetype: string;
  readonly bytes: Uint8Array;
  readonly rendererClass: 'markdown' | 'image' | 'archive';
}

/**
 * Publish every revision of one relic under one id and one key.
 *
 * The store is driven directly rather than through the grant legs: this
 * harness proves the viewer, and `beginVersion` plus `markPublished` is the
 * pair the mint path itself uses.
 */
async function publishRevisions(
  label: string,
  revisions: readonly Revision[]
): Promise<void> {
  const relicId = generateRelicId();
  const key = generateKey();

  for (const [index, revision] of revisions.entries()) {
    const version = index + 1;
    const container = await encryptRelic({
      content: revision.bytes,
      filename: revision.filename,
      mimetype: revision.mimetype,
      key,
    });

    if (version === 1) {
      await store.putRelic({
        id: relicId,
        publishIp: '127.0.0.1',
        grantedAt: Date.now(),
        expiresAt: undefined,
        rendererClass: revision.rendererClass,
        publishingClient: 'proof/0.1.0',
        declaredSizeBytes: revision.bytes.length,
        version: 1,
        publishTokenHash: 'proof',
        mintsUsed: 0,
        title: revision.filename,
      });
    } else {
      await store.beginVersion(
        relicId,
        revision.rendererClass,
        revision.bytes.length,
        {
          title: revision.filename,
        }
      );
    }
    await store.markPublished(relicId, Date.now(), container.length, 'proof');
    // `objectKey` in the server: version 1 is the bare id, every later
    // version is `<id>/v<n>`. The bytes go into storage under that key,
    // because the mint path stats storage before it will sign anything, and
    // into the HTTP map the signed URL is then fetched from.
    const objectName = version === 1 ? relicId : `${relicId}/v${version}`;
    storage.put(objectName, container);
    objects.set(objectName, container);
  }

  console.log(`${label}\t${SERVICE}/${relicId}#${encodeFragment(key)}`);
}

await publishRevisions('prose-then-picture', [
  {
    filename: 'notes.md',
    mimetype: 'text/markdown',
    bytes: new TextEncoder().encode(
      '# Review notes\n\nThe bevel is wrong on this part.\n'
    ),
    rendererClass: 'markdown',
  },
  {
    filename: 'chart.png',
    mimetype: 'image/png',
    bytes: png,
    rendererClass: 'image',
  },
]);

await publishRevisions('archive-only', [
  {
    filename: 'bundle.zip',
    mimetype: 'application/zip',
    bytes: emptyZip(),
    rendererClass: 'archive',
  },
  {
    filename: 'bundle.zip',
    mimetype: 'application/zip',
    bytes: emptyZip(),
    rendererClass: 'archive',
  },
]);

console.log(`ready on ${s1.port} and ${s2.port}`);
