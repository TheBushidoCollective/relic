/**
 * A markdown relic for reproducing successive selections.
 *
 * Throwaway. The prose is deliberately ordinary: three paragraphs of distinct
 * sentences, so a second selection landing on the first one's position is
 * unambiguous rather than a coincidence of repeated words.
 */

import {
  deriveCommentKey,
  encodeFragment,
  encryptComment,
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
    const id = (path.slice(3).split('?')[0] ?? '').replace(/\/$/, '');
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

// One phrase in all three paragraphs, which is what makes a misresolved
// mark visible: a unique phrase resolves correctly even from a flow that has
// had text removed from it, so it cannot show this defect.
const REPEAT = 'the bevel radius is wrong';
const markdown = `# Review notes

Alpha paragraph says ${REPEAT} here.

Bravo paragraph says ${REPEAT} here.

Charlie paragraph says ${REPEAT} here.
`;

const relicId = generateRelicId();
const key = generateKey();
const container = await encryptRelic({
  content: new TextEncoder().encode(markdown),
  filename: 'notes.md',
  mimetype: 'text/markdown',
  key,
});

storage.put(relicId, container);
objects.set(relicId, container);
await store.putRelic({
  id: relicId,
  publishIp: '127.0.0.1',
  grantedAt: Date.now(),
  expiresAt: undefined,
  rendererClass: 'markdown',
  publishingClient: 'proof/0.1.0',
  declaredSizeBytes: markdown.length,
  version: 1,
  publishTokenHash: 'proof',
  mintsUsed: 0,
  title: 'notes.md',
});
await store.markPublished(relicId, Date.now(), container.length, 'proof');

// Two posted comments, each pointing at a different occurrence, with the
// context that disambiguates it. Painted in one pass, oldest first, which is
// the sequence a reader produces by commenting twice.
const commentKey = await deriveCommentKey(key);
const anchors = [
  { exact: REPEAT, prefix: 'Alpha paragraph says ', suffix: ' here.' },
  { exact: REPEAT, prefix: 'Charlie paragraph says ', suffix: ' here.' },
];
for (const [index, anchor] of anchors.entries()) {
  await store.putComment({
    id: `seed${index + 1}`,
    relicId,
    author: `reader${index + 1}@example.com`,
    createdAt: Date.now() + index,
    ciphertext: await encryptComment(commentKey, {
      body: `Comment on the ${index === 0 ? 'first' : 'third'} paragraph.`,
      display_name: null,
      anchor: { kind: 'quote', ...anchor },
    }),
  });
}

console.log(`markdown\t${SERVICE}/${relicId}#${encodeFragment(key)}`);
console.log(`ready on ${s1.port} and ${s2.port}`);
