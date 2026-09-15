import { createApp } from '../packages/relic-server/src/app.ts';
import { diskAssets } from '../packages/relic-server/src/assets.ts';
import { MemoryStorage } from '../packages/relic-server/src/storage.ts';
import { MemoryStore } from '../packages/relic-server/src/store.ts';
import {
  encryptRelic,
  generateKey,
  generateRelicId,
  encodeFragment,
  type RendererClass,
} from '../packages/relic-format/src/index.ts';

const PORT = 4895;
const serviceOrigin = `http://127.0.0.1:${PORT}`;
const usercontentOrigin = `http://localhost:4896`;

const storage = new MemoryStorage(`${serviceOrigin}/storage`);
const store = new MemoryStore();
const distPath = `${import.meta.dir}/../packages/relic-viewer/dist`;

const app = createApp({
  store,
  storage,
  assets: diskAssets(distPath),
  config: {
    serviceOrigin,
    usercontentOrigin,
    maxRelicBytes: 50 * 1024 * 1024,
  },
  operatorTokens: new Map([['admin', 'secret']]),
});

// Pre-create verified session for authoring audit
const sessionToken = 'audit-session-token-authoring';
const encoder = new TextEncoder();
const hashBuffer = await crypto.subtle.digest(
  'SHA-256',
  encoder.encode(sessionToken)
);
const tokenHash = Array.from(new Uint8Array(hashBuffer))
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');

const now = Date.now();
await store.putSession({
  tokenHash,
  email: 'reviewer@example.com',
  createdAt: now,
  expiresAt: now + 365 * 24 * 3600 * 1000,
});

interface RelicFixture {
  id: string;
  fragment: string;
  url: string;
  cls: RendererClass;
  title: string;
}

const fixtures: Record<string, RelicFixture> = {};

async function addRelic(options: {
  filename: string;
  content: Uint8Array;
  cls: RendererClass;
  title: string;
  mimetype?: string;
}): Promise<RelicFixture> {
  const id = generateRelicId();
  const key = generateKey();
  const fragment = encodeFragment(key);

  const encrypted = await encryptRelic({
    content: options.content,
    filename: options.filename,
    mimetype: options.mimetype,
    key,
  });

  await storage.put(id, encrypted);
  await store.putRelic({
    id,
    publishIp: '127.0.0.1',
    grantedAt: now,
    expiresAt: undefined,
    rendererClass: options.cls,
    publishingClient: 'audit-client',
    declaredSizeBytes: options.content.byteLength,
    version: 1,
    publishTokenHash: 'dummy',
    publishedAt: now,
    mintsUsed: 0,
    title: options.title,
  });

  const fixture: RelicFixture = {
    id,
    fragment,
    url: `${serviceOrigin}/${id}#${fragment}`,
    cls: options.cls,
    title: options.title,
  };
  fixtures[options.cls] = fixture;
  return fixture;
}

// 1. Markdown
await addRelic({
  filename: 'notes.md',
  content: encoder.encode(
    '# Architecture Notes\n\nRelic stores encrypted files.\n\nHere is a second paragraph with some specific phrases for quote testing.\n\n- First point\n- Second point\n'
  ),
  cls: 'markdown',
  title: 'Architecture Notes',
  mimetype: 'text/markdown',
});

// 2. Code
await addRelic({
  filename: 'main.ts',
  content: encoder.encode(
    'export function calculateSum(a: number, b: number): number {\n  const result = a + b;\n  return result;\n}\n'
  ),
  cls: 'code',
  title: 'Sum Calculation Code',
  mimetype: 'text/typescript',
});

// 3. Image
const imageFile = Bun.file(
  `${import.meta.dir}/../packages/relic-viewer/public/card.v1.png`
);
const imageBytes = new Uint8Array(await imageFile.arrayBuffer());
await addRelic({
  filename: 'card.png',
  content: imageBytes,
  cls: 'image',
  title: 'Card Preview Image',
  mimetype: 'image/png',
});

// 4. Media (Video)
const videoFile = Bun.file('/tmp/sample-video.mp4');
const videoBytes = new Uint8Array(await videoFile.arrayBuffer());
await addRelic({
  filename: 'clip.mp4',
  content: videoBytes,
  cls: 'media',
  title: 'Sample Video Clip',
  mimetype: 'video/mp4',
});

// 5. Media (Audio) - minimal valid WAV
const wavHeader = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46, // RIFF
  0x24,
  0x00,
  0x00,
  0x00, // 36 + data size
  0x57,
  0x41,
  0x56,
  0x45, // WAVE
  0x66,
  0x6d,
  0x74,
  0x20, // fmt
  0x10,
  0x00,
  0x00,
  0x00, // 16 bytes format chunk
  0x01,
  0x00, // PCM format
  0x01,
  0x00, // 1 channel
  0x44,
  0xac,
  0x00,
  0x00, // 44100 sample rate
  0x88,
  0x58,
  0x01,
  0x00, // byte rate
  0x02,
  0x00, // block align
  0x10,
  0x00, // 16 bits per sample
  0x64,
  0x61,
  0x74,
  0x61, // data
  0x00,
  0x00,
  0x00,
  0x00, // 0 bytes data
]);
await addRelic({
  filename: 'sound.wav',
  content: wavHeader,
  cls: 'media',
  title: 'Sample Audio Sound',
  mimetype: 'audio/wav',
});

// 6. HTML
await addRelic({
  filename: 'index.html',
  content: encoder.encode(
    '<!DOCTYPE html><html><head><title>Sample Document</title></head><body><h1>User Document</h1><p>This is rendered in a sandboxed iframe.</p></body></html>'
  ),
  cls: 'html',
  title: 'User Document HTML',
  mimetype: 'text/html',
});

// 7. JSX
await addRelic({
  filename: 'component.jsx',
  content: encoder.encode(
    'export default function Widget() {\n  return <div style={{ padding: 20 }}>\n    <h2>Interactive Widget</h2>\n    <p>Rendered via JSX sandbox</p>\n  </div>;\n}\n'
  ),
  cls: 'jsx',
  title: 'Widget Component JSX',
  mimetype: 'text/jsx',
});

// 8. PDF
const pdfText = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 100 700 Td (Sample PDF Document) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000227 00000 n 
0000000321 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
392
%%EOF`;
await addRelic({
  filename: 'report.pdf',
  content: encoder.encode(pdfText),
  cls: 'binary',
  title: 'Sample Report PDF',
  mimetype: 'application/pdf',
});

// 9. Binary
await addRelic({
  filename: 'data.bin',
  content: new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xff]),
  cls: 'binary',
  title: 'Raw Data Binary',
  mimetype: 'application/octet-stream',
});

const server = Bun.serve({
  port: PORT,
  fetch: async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === '/auth-cookie') {
      const target = url.searchParams.get('to') ?? '/';
      return new Response(null, {
        status: 302,
        headers: {
          Location: target,
          'Set-Cookie': `relic_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`,
        },
      });
    }
    if (url.pathname.startsWith('/storage/o/')) {
      const key = url.pathname.replace('/storage/o/', '');
      const bytes = await storage.read(key);
      if (bytes !== undefined) {
        return new Response(bytes, {
          headers: {
            'content-type': 'application/octet-stream',
            'access-control-allow-origin': '*',
          },
        });
      }
    }
    return app.fetch(request);
  },
});

console.log('AUDIT_SERVER_READY');
console.log(JSON.stringify(fixtures, null, 2));
