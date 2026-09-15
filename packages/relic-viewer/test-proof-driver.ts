import {
  deriveCommentKey,
  encodeKey,
  encryptRelic,
  generateKey,
  generateRelicId,
} from '@relic/format';
import { createApp } from '../relic-server/src/app.ts';
import { diskAssets } from '../relic-server/src/assets.ts';
import { MemoryStorage } from '../relic-server/src/storage.ts';
import { MemoryStore } from '../relic-server/src/store.ts';

export async function setupTestRelicServer(): Promise<{
  url: string;
  relicId: string;
  key: Uint8Array;
  close: () => void;
}> {
  const serviceOrigin = 'http://localhost:8480';
  const usercontentOrigin = 'http://localhost:8481';

  const storage = new MemoryStorage();
  const store = new MemoryStore();
  const assets = diskAssets(new URL('./dist/', import.meta.url).pathname);

  const app = createApp({
    config: {
      serviceOrigin,
      usercontentOrigin,
      killSwitchEngaged: false,
    },
    storage,
    store,
    assets,
    now: () => Date.now(),
  });

  const s1 = Bun.serve({ port: 8480, fetch: app.fetch });
  const s2 = Bun.serve({ port: 8481, fetch: app.fetch });

  const relicId = generateRelicId();
  const key = generateKey();

  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Annotated Sandboxed HTML</title>
  <style>
    body { font-family: sans-serif; padding: 2rem; line-height: 1.6; }
    h1 { color: #1a365d; }
    .box { padding: 1rem; border: 1px solid #ccc; margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>Framed Product Overview</h1>
  <p id="first-p">Here is an important sentence for pointed feedback that we want to annotate.</p>
  <div class="box">
    <p id="second-p">This is a highlighted section inside the sandboxed frame.</p>
    <button id="test-btn" onclick="document.getElementById('click-result').textContent = 'button clicked'">Clickable Button</button>
    <span id="click-result"></span>
  </div>
</body>
</html>`;

  const container = await encryptRelic({
    content: new TextEncoder().encode(htmlContent),
    filename: 'overview.html',
    mimetype: 'text/html',
    key,
  });

  storage.put(relicId, container);
  await store.completeMint(
    relicId,
    {
      rendererClass: 'html',
      publishingClient: 'relic-test/0.1.0',
      sizeBytes: htmlContent.length,
      ciphertextBytes: container.length,
      ttlDays: 30,
      title: 'Framed Product Overview',
      ciphertextSha256: 'dummy',
    },
    Date.now()
  );

  const encodedKey = encodeKey(key);
  const url = `${serviceOrigin}/${relicId}#${encodedKey}`;

  return {
    url,
    relicId,
    key,
    close: () => {
      s1.stop(true);
      s2.stop(true);
    },
  };
}

if (import.meta.main) {
  const info = await setupTestRelicServer();
  console.log(`Test relic server ready at ${info.url}`);
}
