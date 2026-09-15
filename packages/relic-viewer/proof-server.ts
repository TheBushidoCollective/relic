/**
 * Serves one relic of every annotatable class, for browser proof.
 *
 * Throwaway harness. Seeds the store directly rather than walking the publish
 * protocol, because the protocol's upload leg signs a URL against the
 * configured service origin and the point here is the viewer, not the mint.
 *
 * The markdown and html fixtures both repeat one phrase three times. That is
 * deliberate: it is the only shape in which a context-resolved quote and a
 * first-occurrence quote produce visibly different results, so a screenshot
 * of it is evidence rather than decoration.
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

// MemoryStorage's default signed-URL host is `storage.invalid`, which is
// unresolvable on purpose: unit tests intercept the fetch and a browser
// cannot. Objects are therefore signed against the service origin itself and
// served from it, because the viewer's CSP allows `connect-src 'self'` and
// `https:` only. A separate http port is refused by the browser, which is the
// CSP behaving exactly as intended.
const storage = new MemoryStorage(SERVICE);
const store = new MemoryStore();

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

const REPEATED = 'The bevel is wrong on this part.';

interface Fixture {
  readonly label: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly rendererClass:
    | 'markdown'
    | 'html'
    | 'image'
    | 'media'
    | 'pdf'
    | 'code';
  readonly bytes: Uint8Array;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const markdown = utf8(
  `# Review notes\n\nFirst section. ${REPEATED}\n\n` +
    `## Second section\n\nSecond section. ${REPEATED}\n\n` +
    `## Third section\n\nThird section. ${REPEATED}\n`
);

const html = utf8(
  '<!doctype html><html><head><meta charset="utf-8"></head>' +
    '<body style="font:16px/1.6 system-ui;padding:2rem;max-width:40rem">' +
    '<h1>Quarterly page</h1>' +
    `<p id="one">First paragraph. ${REPEATED}</p>` +
    `<p id="two">Second paragraph. ${REPEATED}</p>` +
    `<p id="three">Third paragraph. ${REPEATED}</p>` +
    '</body></html>'
);

const png = new Uint8Array(
  await Bun.file(new URL('./public/card.v1.png', import.meta.url)).bytes()
);

/**
 * A one-page PDF written by hand.
 *
 * A real PDF is used rather than a stub because the renderer parses it; a
 * placeholder would prove the loading state and nothing else. Offsets in the
 * xref table are computed after the body is assembled, since a wrong offset
 * is the one error pdf.js reports as a corrupt file.
 */
function onePagePdf(): Uint8Array {
  const text =
    'BT /F1 24 Tf 72 700 Td (Page one of the review) Tj ET\n' +
    'BT /F1 14 Tf 72 660 Td (The bevel is wrong on this part.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let body = '';
  const offsets: number[] = [];
  const header = '%PDF-1.4\n';
  let at = header.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(at);
    const chunk = `${index + 1} 0 obj\n${object}\nendobj\n`;
    body += chunk;
    at += chunk.length;
  }

  const xrefAt = at;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;

  return utf8(header + body + xref + trailer);
}

const fixtures: readonly Fixture[] = [
  {
    label: 'markdown',
    filename: 'notes.md',
    mimetype: 'text/markdown',
    rendererClass: 'markdown',
    bytes: markdown,
  },
  {
    label: 'html (framed)',
    filename: 'page.html',
    mimetype: 'text/html',
    rendererClass: 'html',
    bytes: html,
  },
  {
    label: 'image',
    filename: 'card.png',
    mimetype: 'image/png',
    rendererClass: 'image',
    bytes: png,
  },
  {
    label: 'pdf',
    filename: 'review.pdf',
    mimetype: 'application/pdf',
    rendererClass: 'pdf',
    bytes: onePagePdf(),
  },
];

// The object bytes, served from the service origin so `connect-src 'self'`
// covers them. Signature and expiry are ignored: this harness proves the
// viewer, not the signer.
const objects = new Map<string, Uint8Array>();

function serve(request: Request): Response | Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/o/')) {
    const bytes = objects.get(path.slice(3));
    if (bytes === undefined) return new Response('no object', { status: 404 });
    return new Response(bytes as unknown as BodyInit, {
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  return app.fetch(request);
}

const s1 = Bun.serve({ port: 8490, fetch: serve });
const s2 = Bun.serve({ port: 8491, fetch: serve });

for (const fixture of fixtures) {
  const relicId = generateRelicId();
  const key = generateKey();
  const container = await encryptRelic({
    content: fixture.bytes,
    filename: fixture.filename,
    mimetype: fixture.mimetype,
    key,
  });
  storage.put(relicId, container);
  objects.set(relicId, container);
  // The row is written directly in its published state. `putRelic` plus
  // `markPublished` is the pair the mint path itself uses; going through the
  // grant would sign an upload URL this harness has no reason to exercise.
  await store.putRelic({
    id: relicId,
    publishIp: '127.0.0.1',
    grantedAt: Date.now(),
    expiresAt: undefined,
    rendererClass: fixture.rendererClass,
    publishingClient: 'proof/0.1.0',
    declaredSizeBytes: fixture.bytes.length,
    version: 1,
    publishTokenHash: 'proof',
    mintsUsed: 0,
    title: fixture.filename,
  });
  await store.markPublished(relicId, Date.now(), container.length, 'proof');
  console.log(`${fixture.label}\t${SERVICE}/${relicId}#${encodeFragment(key)}`);
}

console.log(`ready on ${s1.port} and ${s2.port}`);
