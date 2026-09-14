import { beforeEach, describe, expect, test } from 'bun:test';
import {
  decryptComment,
  deriveCommentKey,
  encryptComment,
  encryptedSize,
  encryptRelic,
  generateKey,
  generateRelicId,
  RESERVED_SEGMENTS,
} from '@relic/format';
import {
  createApp,
  type Mailer,
  type RelicApp,
  stripToRelicId,
} from '../src/app.ts';
import { memoryAssets } from '../src/assets.ts';
import { ciphertextHash, MemoryStorage } from '../src/storage.ts';
import { MemoryStore } from '../src/store.ts';

const OPERATOR = new Map([['jason', 'operator-secret']]);

let now = Date.parse('2026-08-02T12:00:00.000Z');
let storage: MemoryStorage;
let app: RelicApp;

function build(overrides: Parameters<typeof createApp>[0] = {}): RelicApp {
  storage = new MemoryStorage();
  return createApp({
    store: new MemoryStore(),
    storage,
    now: () => now,
    operatorTokens: OPERATOR,
    ...overrides,
  });
}

beforeEach(() => {
  now = Date.parse('2026-08-02T12:00:00.000Z');
  app = build();
});

function req(
  path: string,
  init: RequestInit & { ip?: string | undefined } = {}
): Request {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', init.ip ?? '198.51.100.10');
  return new Request(`https://relic.example${path}`, { ...init, headers });
}

async function publish(
  options: {
    ip?: string | undefined;
    id?: string;
    rendererClass?: string;
    size?: number;
    ttlDays?: number;
    title?: string;
  } = {}
): Promise<{ id: string; key: Uint8Array; grant: Record<string, unknown> }> {
  const challengeResponse = await app.fetch(
    req('/api/challenge', { method: 'POST', ip: options.ip })
  );
  const challenge = (await challengeResponse.json()) as {
    challenge_nonce: string;
  };

  const id = options.id ?? generateRelicId();
  const key = generateKey();

  const grantResponse = await app.fetch(
    req('/api/grant', {
      method: 'POST',
      ip: options.ip,
      body: JSON.stringify({
        challenge_nonce: challenge.challenge_nonce,
        relic_id: id,
        renderer_class: options.rendererClass ?? 'markdown',
        publishing_client: 'relic-mcp/0.1.0 (test)',
        declared_size_bytes: options.size ?? 12,
        declared_ciphertext_bytes: encryptedSize(options.size ?? 12),
        ...(options.ttlDays === undefined ? {} : { ttl_days: options.ttlDays }),
        ...(options.title === undefined ? {} : { title: options.title }),
      }),
    })
  );
  expect(grantResponse.status).toBe(200);
  const grant = (await grantResponse.json()) as Record<string, unknown>;

  const container = await encryptRelic({
    content: new TextEncoder().encode('hello relic'),
    filename: 'notes.md',
    mimetype: 'text/markdown',
    key,
  });
  storage.put(id, container);

  return { id, key, grant };
}

/** Ciphertext for a republished version, under the same key as v1. */
async function encrypted(text: string, key: Uint8Array): Promise<Uint8Array> {
  return encryptRelic({
    content: new TextEncoder().encode(text),
    filename: 'notes.md',
    mimetype: 'text/markdown',
    key,
  });
}

/**
 * A republish request the test controls token by token. `undefined` omits
 * the field entirely, which is its own refusal case.
 */
async function republish(
  id: string,
  token: string | undefined,
  options: { rendererClass?: string; size?: number; title?: string } = {}
): Promise<Response> {
  return app.fetch(
    req(`/api/relics/${id}/republish`, {
      method: 'POST',
      body: JSON.stringify({
        ...(token === undefined ? {} : { publish_token: token }),
        renderer_class: options.rendererClass ?? 'markdown',
        declared_size_bytes: options.size ?? 12,
        declared_ciphertext_bytes: encryptedSize(options.size ?? 12),
        ...(options.title === undefined ? {} : { title: options.title }),
      }),
    })
  );
}

/** A relic with every object present from version 1 through `currentVersion`. */
async function publishThroughVersion(
  currentVersion: number
): Promise<{ id: string }> {
  const { id, key, grant } = await publish();
  const token = grant['publish_token'] as string;

  for (let version = 2; version <= currentVersion; version++) {
    const response = await republish(id, token);
    expect(response.status).toBe(200);
    storage.put(
      `${id}/v${version}`,
      await encrypted(`hello relic, version ${version}`, key)
    );
  }

  return { id };
}

/**
 * A grant request the test controls field by field, for the metadata the
 * publish helper does not model.
 */
async function grantFor(fields: Record<string, unknown>): Promise<Response> {
  const challenge = (await app
    .fetch(req('/api/challenge', { method: 'POST' }))
    .then((r) => r.json())) as { challenge_nonce: string };
  return app.fetch(
    req('/api/grant', {
      method: 'POST',
      body: JSON.stringify({
        challenge_nonce: challenge.challenge_nonce,
        relic_id: generateRelicId(),
        renderer_class: 'markdown',
        publishing_client: 'test',
        declared_size_bytes: 12,
        declared_ciphertext_bytes: encryptedSize(12),
        ...fields,
      }),
    })
  );
}

describe('the shell', () => {
  test('serving /{id} performs no mint and consumes no cap', async () => {
    const { id } = await publish();
    const before = await app.store.readMintLog();

    const response = await app.fetch(req(`/${id}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    // No mint log entry, no cap consumption. This is what keeps Slack's
    // fetcher, which does not honor robots.txt, off both counters.
    expect(await app.store.readMintLog()).toHaveLength(before.length);
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(0);
  });

  test('sends Referrer-Policy: no-referrer', async () => {
    const { id } = await publish();
    const response = await app.fetch(req(`/${id}`));
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('sends X-Robots-Tag on a real relic path, not just the apex', async () => {
    const { id } = await publish();
    const response = await app.fetch(req(`/${id}`));
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
  });

  test('frames only the usercontent origin', async () => {
    const { id } = await publish();
    const csp = await app
      .fetch(req(`/${id}`))
      .then((r) => r.headers.get('content-security-policy'));
    expect(csp).toContain('frame-src https://relic-usercontent.example');
  });

  test('permits the manifest it links, which default-src none refused', async () => {
    // The shell has always linked a manifest and the server has always served
    // it, but a manifest fetch falls back to default-src when manifest-src is
    // absent. Production reported a csp-blocked request of type Manifest, so
    // the install path never worked. Any relic path serves the same shell.
    const { id } = await publish();
    const csp = await app
      .fetch(req(`/${id}`))
      .then((r) => r.headers.get('content-security-policy'));
    expect(csp).toContain("manifest-src 'self'");
  });

  test('permits media blobs rendered by the player, which default-src none refused', async () => {
    const { id } = await publish();
    const csp = await app
      .fetch(req(`/${id}`))
      .then((r) => r.headers.get('content-security-policy'));
    expect(csp).toContain("media-src 'self' blob: data:");
  });

  test('the head byte order: Open Graph block appears before <script, <style, <link, or <title, and after <meta charset', async () => {
    const { id } = await publish({ title: 'Byte Order Test' });
    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    const charsetIdx = body.indexOf('<meta charset="utf-8">');
    const ogTypeIdx = body.indexOf('<meta property="og:type"');
    const ogSiteNameIdx = body.indexOf('<meta property="og:site_name"');
    const ogTitleIdx = body.indexOf('<meta property="og:title"');
    const ogDescIdx = body.indexOf('<meta property="og:description"');
    const ogUrlIdx = body.indexOf('<meta property="og:url"');
    const ogImageIdx = body.indexOf('<meta property="og:image"');
    const twitterCardIdx = body.indexOf('<meta name="twitter:card"');
    const titleIdx = body.indexOf('<title>');
    const linkIdx = body.indexOf('<link');
    const scriptIdx = body.indexOf('<script');

    expect(charsetIdx).toBeGreaterThanOrEqual(0);
    expect(ogTypeIdx).toBeGreaterThan(charsetIdx);
    expect(ogSiteNameIdx).toBeGreaterThan(ogTypeIdx);
    expect(ogTitleIdx).toBeGreaterThan(ogSiteNameIdx);
    expect(ogDescIdx).toBeGreaterThan(ogTitleIdx);
    expect(ogUrlIdx).toBeGreaterThan(ogDescIdx);
    expect(ogImageIdx).toBeGreaterThan(ogUrlIdx);
    expect(twitterCardIdx).toBeGreaterThan(ogImageIdx);
    expect(titleIdx).toBeGreaterThan(twitterCardIdx);
    expect(linkIdx).toBeGreaterThan(titleIdx);
    expect(scriptIdx).toBeGreaterThan(linkIdx);

    const styleIdx = body.indexOf('<style');
    if (styleIdx >= 0) {
      expect(styleIdx).toBeGreaterThan(twitterCardIdx);
    }
  });

  test('a relic published with a title emits it in og:title, twitter:title, and <title> while description carries the class', async () => {
    const { id } = await publish({ title: 'My Custom Document' });
    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    expect(body).toContain(
      '<meta property="og:title" content="My Custom Document">'
    );
    expect(body).toContain(
      '<meta name="twitter:title" content="My Custom Document">'
    );
    expect(body).toContain('<title>My Custom Document · Relic</title>');
    expect(body).toContain(
      '<meta property="og:description" content="A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(
      '<meta name="twitter:description" content="A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
  });

  test('an untitled relic serves its per-class fallback title in og:title, twitter:title and <title>', async () => {
    const { id } = await publish();
    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    expect(body).toContain(
      '<meta property="og:title" content="A Markdown relic">'
    );
    expect(body).toContain(
      '<meta name="twitter:title" content="A Markdown relic">'
    );
    expect(body).toContain('<title>A Markdown relic</title>');
    expect(body).not.toContain('· Relic');
    expect(body).toContain(
      '<meta property="og:description" content="A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
  });

  test('a relic published as markdown serves the Markdown phrase and browser tail; one published as archive serves the archive phrase and download tail', async () => {
    const { id: mdId } = await publish({ rendererClass: 'markdown' });
    const mdResponse = await app.fetch(req(`/${mdId}`));
    const mdBody = await mdResponse.text();

    expect(mdBody).toContain(
      '<meta property="og:description" content="A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(mdBody).toContain(
      '<meta name="twitter:description" content="A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );

    const { id: archiveId } = await publish({ rendererClass: 'archive' });
    const archiveResponse = await app.fetch(req(`/${archiveId}`));
    const archiveBody = await archiveResponse.text();

    expect(archiveBody).toContain(
      '<meta property="og:description" content="An archive. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it.">'
    );
    expect(archiveBody).toContain(
      '<meta name="twitter:description" content="An archive. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it.">'
    );
    expect(archiveBody).toContain(
      '<meta property="og:title" content="An archive relic">'
    );
    expect(archiveBody).toContain(
      '<meta name="twitter:title" content="An archive relic">'
    );
    expect(archiveBody).toContain('<title>An archive relic</title>');
  });

  test('a relic published as media serves the media phrase and played tail on og:description and twitter:description', async () => {
    const { id } = await publish({ rendererClass: 'media' });
    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    const expectedDescription =
      'An audio or video file. It plays in your browser, and only someone holding the whole link, including the part after the #, can open it.';

    expect(body).toContain(
      `<meta property="og:description" content="${expectedDescription}">`
    );
    expect(body).toContain(
      `<meta name="twitter:description" content="${expectedDescription}">`
    );
    expect(body).not.toContain('downloads to your device');
    expect(body).toContain(
      '<meta property="og:title" content="A media relic">'
    );
    expect(body).toContain(
      '<meta name="twitter:title" content="A media relic">'
    );
    expect(body).toContain('<title>A media relic</title>');
  });

  test('a title containing quotes and angle brackets cannot break out', async () => {
    const hostileTitle = 'hello "evil" <script>alert(1)</script>';
    const { id } = await publish({ title: hostileTitle });
    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    expect(body).not.toContain(hostileTitle);
    expect(body).toContain(
      '<meta property="og:title" content="hello &quot;evil&quot; &lt;script&gt;alert(1)&lt;/script&gt;">'
    );
    expect(body).toContain(
      '<meta name="twitter:title" content="hello &quot;evil&quot; &lt;script&gt;alert(1)&lt;/script&gt;">'
    );
    expect(body).toContain(
      '<title>hello &quot;evil&quot; &lt;script&gt;alert(1)&lt;/script&gt; · Relic</title>'
    );
  });

  test('a tombstoned relic serves the constant card and leaks neither title nor class', async () => {
    const { id } = await publish({
      title: 'Secret Tombstoned Title',
      rendererClass: 'markdown',
    });
    await app.store.putTombstone({
      id,
      publishIp: '198.51.100.10',
      publishedAt: now,
      publishingClient: 'test',
      rendererClass: 'markdown',
      ciphertextHash: 'hash',
      deletedAt: now,
      reasonClass: 'abuse',
      operator: 'test-op',
      reportReference: undefined,
    });

    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    expect(body).not.toContain('Secret Tombstoned Title');
    expect(body).not.toContain('Markdown');
    expect(body).toContain('<meta property="og:title" content="A relic">');
    expect(body).toContain('<meta name="twitter:title" content="A relic">');
    expect(body).toContain('<title>Relic</title>');
    expect(body).toContain(
      '<meta property="og:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(
      '<meta name="twitter:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
  });

  test('an expired relic serves the constant card and leaks neither title nor class', async () => {
    const { id } = await publish({
      title: 'Secret Expired Title',
      ttlDays: 1,
      rendererClass: 'markdown',
    });
    now += 2 * 86_400 * 1000;

    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    expect(body).not.toContain('Secret Expired Title');
    expect(body).not.toContain('Markdown');
    expect(body).toContain('<meta property="og:title" content="A relic">');
    expect(body).toContain('<meta name="twitter:title" content="A relic">');
    expect(body).toContain('<title>Relic</title>');
    expect(body).toContain(
      '<meta property="og:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(
      '<meta name="twitter:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
  });

  test('an unknown id serves the constant card and leaks neither title nor class', async () => {
    const unknownId = generateRelicId();
    const response = await app.fetch(req(`/${unknownId}`));
    const body = await response.text();

    expect(body).not.toContain('Markdown');
    expect(body).toContain('<meta property="og:title" content="A relic">');
    expect(body).toContain('<meta name="twitter:title" content="A relic">');
    expect(body).toContain('<title>Relic</title>');
    expect(body).toContain(
      '<meta property="og:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(
      '<meta name="twitter:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(`https://relic.example/${unknownId}`);
  });

  test('a malformed id serves the unknown pair and leaks neither title nor class', async () => {
    const malformedId = 'not-valid-base32-id!!';
    const response = await app.fetch(req(`/${malformedId}`));
    const body = await response.text();

    expect(body).not.toContain('Markdown');
    expect(body).toContain('<meta property="og:title" content="A relic">');
    expect(body).toContain('<meta name="twitter:title" content="A relic">');
    expect(body).toContain('<title>Relic</title>');
    expect(body).toContain(
      '<meta property="og:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(
      '<meta name="twitter:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
  });
  test('a reserved-word-shaped non-id serves the constant card with origin root and leaks nothing', async () => {
    await app.store.putRelic({
      id: 'not-a-valid-id',
      publishIp: '198.51.100.10',
      grantedAt: now,
      expiresAt: undefined,
      rendererClass: 'markdown',
      publishingClient: 'test',
      declaredSizeBytes: 12,
      version: 1,
      publishTokenHash: 'hash',
      mintsUsed: 0,
      title: 'Secret NonId Title',
    });

    const response = await app.fetch(req('/not-a-valid-id'));
    const body = await response.text();

    expect(body).not.toContain('Secret NonId Title');
    expect(body).toContain('<meta property="og:title" content="A relic">');
    expect(body).toContain('<meta name="twitter:title" content="A relic">');
    expect(body).toContain('<title>Relic</title>');
    expect(body).toContain(
      '<meta property="og:url" content="https://relic.example/">'
    );
  });

  test('serving /{id} for a titled relic still writes no mint log entry and leaves mintsUsed at 0', async () => {
    const { id } = await publish({ title: 'Uncounted Title' });
    const before = await app.store.readMintLog();

    const response = await app.fetch(req(`/${id}`));
    expect(response.status).toBe(200);

    expect(await app.store.readMintLog()).toHaveLength(before.length);
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(0);
  });

  test('serving /{id} for a classed relic still writes no mint log entry and leaves mintsUsed at 0', async () => {
    const { id } = await publish({
      rendererClass: 'archive',
      title: 'Classed Relic',
    });
    const before = await app.store.readMintLog();

    const response = await app.fetch(req(`/${id}`));
    expect(response.status).toBe(200);

    expect(await app.store.readMintLog()).toHaveLength(before.length);
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(0);
  });

  test('/assets/card.v1.png is served image/png with immutable cache policy and no content-encoding', async () => {
    const customApp = createApp({
      assets: memoryAssets({
        'card.v1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        'viewer.js': 'console.log("viewer")',
        'styles.css': 'body { margin: 0; }',
      }),
    });

    const request = new Request('https://relic.example/assets/card.v1.png', {
      headers: { 'accept-encoding': 'gzip, br' },
    });
    const response = await customApp.fetch(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable'
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-encoding')).toBeNull();

    const jsResponse = await customApp.fetch(
      new Request('https://relic.example/assets/viewer.js', {
        headers: { 'accept-encoding': 'gzip, br' },
      })
    );
    expect(jsResponse.headers.get('cache-control')).toBe('no-store');
    expect(jsResponse.headers.get('content-encoding')).toBe('gzip');

    const cssResponse = await customApp.fetch(
      new Request('https://relic.example/assets/styles.css', {
        headers: { 'accept-encoding': 'gzip, br' },
      })
    );
    expect(cssResponse.headers.get('cache-control')).toBe('no-store');
    expect(cssResponse.headers.get('content-encoding')).toBe('gzip');
  });
});

describe('reserved segments beat ids at the router', () => {
  for (const word of RESERVED_SEGMENTS) {
    test(`/${word} is not treated as a relic id`, async () => {
      const response = await app.fetch(req(`/${word}`));
      // Whatever it does, it must not be the relic shell for an id.
      const body = await response.text();
      expect(body).not.toContain(`data-relic-id="${word}"`);
    });
  }

  test('/abuse serves the form, which is a go/no-go obligation', async () => {
    const response = await app.fetch(req('/abuse'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<form method="post"');
  });

  test('/robots.txt disallows', async () => {
    expect(await app.fetch(req('/robots.txt')).then((r) => r.text())).toContain(
      'Disallow: /'
    );
  });

  test('/policy publishes the disclosure statement', async () => {
    const body = await app.fetch(req('/policy')).then((r) => r.text());
    expect(body).toContain('Your browser never sends the');
    expect(body).toContain('enters the model');
    expect(body).toContain('Deleted does not mean erased');
    expect(body).toContain('permits no remote source');
    expect(body).toContain('renders without them');
    expect(body).toContain('not safety');
    expect(body).toContain('markdown, code, html, jsx, image');
    expect(body).toContain(
      "Anyone holding a relic's link can fetch every version it has ever held"
    );
  });

  test('/install carries the configured origin, since the server has no default', async () => {
    const response = await app.fetch(req('/install'));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('claude mcp add relic');
    expect(body).toContain('RELIC_SERVICE_ORIGIN=https://relic.example');
    expect(body).toContain('"RELIC_SERVICE_ORIGIN": "https://relic.example"');
  });

  test('/install claims no more than the system delivers', async () => {
    const body = await app.fetch(req('/install')).then((r) => r.text());
    // The decrypting page is served by the operator the claim is made against,
    // so the copy may not say the operator cannot read a relic.
    expect(body).toContain('rests on our intent');
    expect(body).not.toMatch(/nobody can read/i);
  });

  test('/install is noindex and needs no script', async () => {
    const response = await app.fetch(req('/install'));
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'"
    );
    expect(await response.text()).not.toContain('<script');
  });
});

describe('the landing page', () => {
  test('/ is a real page, not the shell with a bogus relic id', async () => {
    const response = await app.fetch(req('/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    // The regression this page exists to fix: `/` used to serve the viewer
    // shell fed the literal string "Relic" as an id, so the homepage rendered
    // as a relic that does not exist. The manifest's start_url is `/`, so the
    // installed app landed there too.
    expect(body).not.toContain('id="relic-root"');
    expect(body).not.toContain('/assets/viewer.js');
  });

  test('/install serves the same body as /, so the two paths cannot drift', async () => {
    const root = await app.fetch(req('/')).then((r) => r.text());
    const install = await app.fetch(req('/install')).then((r) => r.text());
    expect(install).toBe(root);
  });

  test('carries no script at all, so the CSP can deny scripts outright', async () => {
    const body = await app.fetch(req('/')).then((r) => r.text());
    expect(body).not.toContain('<script');
  });

  test('sends exactly the contract headers', async () => {
    const response = await app.fetch(req('/'));
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'"
    );
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('carries the three install forms, each naming the configured origin', async () => {
    // build() leaves serviceOrigin at its default, which is the origin the
    // forms must interpolate; relik.link must not appear by accident.
    const body = await app.fetch(req('/')).then((r) => r.text());
    expect(body).toContain('claude mcp add');
    expect(body).toContain('mcpServers');
    expect(body).toContain('RELIC_SERVICE_ORIGIN');
    expect(body).toContain('https://relic.example');
  });

  test('links the policy, the abuse form, and the installable manifest', async () => {
    const body = await app.fetch(req('/')).then((r) => r.text());
    expect(body).toContain('href="/policy"');
    expect(body).toContain('href="/abuse"');
    expect(body).toContain('href="/manifest.webmanifest"');
  });

  test('a single segment that is not reserved still serves the viewer shell', async () => {
    // Guards the router change that gave `/` to the landing page: an id-shaped
    // path must keep reaching the shell.
    const body = await app
      .fetch(req('/aaaaaaaaaaaaaaaaaaaaaaaaaa'))
      .then((r) => r.text());
    expect(body).toContain('id="relic-root"');
  });
});

describe('the grant', () => {
  test('returns the cap before a grant is requested', async () => {
    const body = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as Record<string, unknown>;
    expect(body['size_limit_bytes']).toBe(100 * 1024 * 1024);
    expect(body['size_basis']).toBe('plaintext');
  });

  test('refuses a dead challenge nonce with a code the client can key on', async () => {
    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: 'never-issued',
          relic_id: generateRelicId(),
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('invalid_challenge_nonce');
  });

  test('refuses an expired challenge nonce', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    now += 6 * 60 * 1000;

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: generateRelicId(),
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );
    expect((await response.json()).code).toBe('invalid_challenge_nonce');
  });

  test('names which id check failed', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: 'too-short',
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe('invalid_relic_id');
    expect(body.id_validation_failure).toBe('length');
  });

  test('refuses an over-cap declaration with 413 and the three size fields', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: generateRelicId(),
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 200 * 1024 * 1024,
          declared_ciphertext_bytes: encryptedSize(200 * 1024 * 1024),
        }),
      })
    );
    const body = await response.json();
    expect(response.status).toBe(413);
    expect(body.code).toBe('size_over_cap');
    expect(body.size_basis).toBe('plaintext');
    expect(body.size_limit_bytes).toBe(100 * 1024 * 1024);
    expect(body.declared_size_bytes).toBe(200 * 1024 * 1024);
  });

  test('refuses a renderer class outside the seven', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: generateRelicId(),
          renderer_class: 'spreadsheet',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_publish_metadata');
  });

  test('grant title validation and storage', async () => {
    const nonString = await grantFor({ title: 12345 });
    expect(nonString.status).toBe(400);
    expect((await nonString.json()).code).toBe('invalid_publish_metadata');

    const tooLong = await grantFor({ title: 'a'.repeat(129) });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).code).toBe('invalid_publish_metadata');

    const withControl = await grantFor({ title: 'line1\nline2' });
    expect(withControl.status).toBe(400);
    expect((await withControl.json()).code).toBe('invalid_publish_metadata');

    const validId = generateRelicId();
    const validRes = await grantFor({ relic_id: validId, title: 'Good Title' });
    expect(validRes.status).toBe(200);
    const validRow = await app.store.getRelic(validId);
    expect(validRow?.title).toBe('Good Title');

    const trimmedId = generateRelicId();
    const trimmedRes = await grantFor({
      relic_id: trimmedId,
      title: '   Trimmed Title   ',
    });
    expect(trimmedRes.status).toBe(200);
    const trimmedRow = await app.store.getRelic(trimmedId);
    expect(trimmedRow?.title).toBe('Trimmed Title');

    const emptyId = generateRelicId();
    const emptyRes = await grantFor({ relic_id: emptyId, title: '' });
    expect(emptyRes.status).toBe(200);
    expect((await app.store.getRelic(emptyId))?.title).toBeUndefined();

    const spaceId = generateRelicId();
    const spaceRes = await grantFor({ relic_id: spaceId, title: '    ' });
    expect(spaceRes.status).toBe(200);
    expect((await app.store.getRelic(spaceId))?.title).toBeUndefined();
  });

  test('never overwrites: a colliding id is refused with 409', async () => {
    const id = generateRelicId();
    await publish({ id });

    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: id,
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('relic_id_collision');
  });

  test("signs the object's exact byte length, not the cap", async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const grant = (await app
      .fetch(
        req('/api/grant', {
          method: 'POST',
          body: JSON.stringify({
            challenge_nonce: challenge.challenge_nonce,
            relic_id: generateRelicId(),
            renderer_class: 'markdown',
            publishing_client: 'test',
            declared_size_bytes: 5000,
            declared_ciphertext_bytes: encryptedSize(5000),
          }),
        })
      )
      .then((r) => r.json())) as { upload_headers: Record<string, string> };

    // Signing the cap would mean the upload had to be 100 MiB exactly, which
    // is the bug that made every real publish fail with a 403.
    expect(grant.upload_headers['content-length']).toBe(
      String(encryptedSize(5000))
    );
    expect(grant.upload_headers['content-length']).not.toBe(
      String(100 * 1024 * 1024)
    );
  });

  test('refuses a ciphertext length that disagrees with its own arithmetic', async () => {
    // A disagreement means the two ends have drifted on the format. Caught
    // here rather than producing an object nobody can open.
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: generateRelicId(),
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 5000,
          declared_ciphertext_bytes: encryptedSize(5000) + 1,
        }),
      })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_publish_metadata');
  });

  test('refuses a ciphertext length over the cap', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: generateRelicId(),
          renderer_class: 'binary',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: 500 * 1024 * 1024,
        }),
      })
    );
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('size_over_cap');
  });

  test('signs no x-goog-meta header, because nothing needs object metadata', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const grant = (await app
      .fetch(
        req('/api/grant', {
          method: 'POST',
          body: JSON.stringify({
            challenge_nonce: challenge.challenge_nonce,
            relic_id: generateRelicId(),
            renderer_class: 'markdown',
            publishing_client: 'test',
            declared_size_bytes: 1,
            declared_ciphertext_bytes: encryptedSize(1),
          }),
        })
      )
      .then((r) => r.json())) as { upload_headers: Record<string, string> };

    for (const header of Object.keys(grant.upload_headers)) {
      expect(header.toLowerCase().startsWith('x-goog-meta-')).toBe(false);
    }
  });
});

describe('the mint', () => {
  test('omitting version signs the current object for version 1', async () => {
    const { id } = await publish();
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    expect(body['url']).toContain(`/o/${id}?`);
    expect(body['version']).toBe(1);
    expect(body['current_version']).toBe(1);
  });

  test('omitting version signs the current object for version 5', async () => {
    const { id } = await publishThroughVersion(5);
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    expect(body['url']).toContain(`/o/${id}/v5?`);
    expect(body['version']).toBe(5);
    expect(body['current_version']).toBe(5);
  });

  test('version 1 on a version 5 relic signs the bare object path', async () => {
    const { id } = await publishThroughVersion(5);
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, {
          method: 'POST',
          ip: '203.0.113.5',
          body: JSON.stringify({ version: 1 }),
        })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    expect(body['url']).toContain(`/o/${id}?`);
    expect(body['url']).not.toContain(`/v1?`);
    expect(body['version']).toBe(1);
    expect(body['current_version']).toBe(5);
  });

  test('version 3 on a version 5 relic signs the v3 object path', async () => {
    const { id } = await publishThroughVersion(5);
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, {
          method: 'POST',
          ip: '203.0.113.5',
          body: JSON.stringify({ version: 3 }),
        })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    expect(body['url']).toContain(`/o/${id}/v3?`);
    expect(body['version']).toBe(3);
    expect(body['current_version']).toBe(5);
  });

  test('returns the eight fields the viewer consumes', async () => {
    const { id } = await publish();
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      'current_version',
      'mints_remaining',
      'object_crc32c',
      'object_length',
      'relic_expires_at',
      'url',
      'url_expires_at',
      'version',
    ]);
  });

  test('excludes filename, mimetype, and renderer class', async () => {
    const { id } = await publish();
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    for (const barred of ['filename', 'mimetype', 'renderer_class']) {
      expect(body[barred]).toBeUndefined();
    }
  });

  test('refuses an invalid explicit version without consuming the cap', async () => {
    const { id } = await publishThroughVersion(5);

    for (const version of [0, 6, -1, 1.5, 'three']) {
      const response = await app.fetch(
        req(`/api/relics/${id}/mint`, {
          method: 'POST',
          ip: `203.0.113.${String(version).length + 10}`,
          body: JSON.stringify({ version }),
        })
      );
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('invalid_relic_version');
    }

    expect((await app.store.getRelic(id))?.mintsUsed).toBe(0);
  });

  test('rate limiting counts each explicit-version mint', async () => {
    app = build({ config: { mintRateLimit: { limit: 2, windowSeconds: 60 } } });
    const { id } = await publishThroughVersion(5);
    const statuses: number[] = [];

    for (const version of [1, 3, 5]) {
      statuses.push(
        (
          await app.fetch(
            req(`/api/relics/${id}/mint`, {
              method: 'POST',
              ip: '203.0.113.5',
              body: JSON.stringify({ version }),
            })
          )
        ).status
      );
    }

    expect(statuses).toEqual([200, 200, 429]);
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(2);
  });

  test('is case-insensitive on the id, and the cap does not fragment', async () => {
    const { id } = await publish();
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    await app.fetch(
      req(`/api/relics/${id.toUpperCase()}/mint`, {
        method: 'POST',
        ip: '203.0.113.6',
      })
    );
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(2);
  });

  test('a never-issued id is 404, distinguishable from expired', async () => {
    const response = await app.fetch(
      req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' })
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('relic_not_found');
  });

  test('an expired relic is 410 relic_expired', async () => {
    const { id } = await publish({ ttlDays: 7 });
    now += 8 * 86_400 * 1000;
    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST' })
    );
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('relic_expired');
  });

  test('a granted-but-never-uploaded relic is 410 relic_never_published', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const id = generateRelicId();
    await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: id,
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
          ttl_days: 7,
        }),
      })
    );
    now += 8 * 86_400 * 1000;

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST' })
    );
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('relic_never_published');
  });

  test('a live grant whose bytes have not landed is 409, temporary and retryable', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const id = generateRelicId();
    await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: id,
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST' })
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('relic_not_yet_published');
    expect(body.retry_after_seconds).toBeGreaterThan(0);
    expect(response.headers.get('retry-after')).not.toBeNull();
  });
});

describe('counting', () => {
  test('an open from the publishing IP is dropped from the metric', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '198.51.100.10' })
    );

    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.countedAsOpen).toBe(false);
    expect(entry?.dropReason).toBe('publishing_ip_match');
  });

  test('an open inside the post-publish window is dropped', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );

    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.countedAsOpen).toBe(false);
    expect(entry?.dropReason).toBe('post_publish_window');
  });

  test('a recipient open outside both filters counts', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );

    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.countedAsOpen).toBe(true);
    expect(entry?.dropReason).toBeUndefined();
  });

  test('a repeat inside the dedup window is not a distinct open but still consumes cap', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;

    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    now += 60 * 1000;
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );

    const log = await app.store.readMintLog();
    const last = log.at(-1);
    expect(last?.countedAsOpen).toBe(false);
    expect(last?.dropReason).toBe('dedup');
    expect(last?.consumedCap).toBe(true);
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(2);
  });

  test('a deduped mint returns the URL already issued, never a fresh one', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;

    const first = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url: string };
    now += 60 * 1000;
    const second = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url: string };

    expect(second.url).toBe(first.url);
  });

  test('a refused mint is never an open and never consumes the cap', async () => {
    await app.fetch(
      req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' })
    );
    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.outcome).toBe('refused');
    expect(entry?.countedAsOpen).toBe(false);
    expect(entry?.consumedCap).toBe(false);
  });

  test('the mint log records the code, not only the status', async () => {
    await app.fetch(
      req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' })
    );
    expect((await app.store.readMintLog()).at(-1)?.code).toBe(
      'relic_not_found'
    );
  });
});

describe('the publish completion call', () => {
  test('records a true publish timestamp', async () => {
    const { id } = await publish();
    now += 30 * 1000;

    const response = await app.fetch(
      req(`/api/relics/${id}/complete`, { method: 'POST' })
    );
    expect(response.status).toBe(200);
    expect((await app.store.getRelic(id))?.publishedAt).toBe(now);
  });

  test('is optional: a lost confirmation still yields a usable relic', async () => {
    const { id } = await publish();
    now += 10 * 60 * 1000;

    // No completion call was ever made.
    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(response.status).toBe(200);
  });

  test('falls back to the grant time, so the first genuine open still counts', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;

    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect((await app.store.readMintLog()).at(-1)?.countedAsOpen).toBe(true);
  });

  test('an open inside the window of a reported publish is still dropped', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    now += 30 * 1000; // inside the 120-second window
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );

    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.countedAsOpen).toBe(false);
    expect(entry?.dropReason).toBe('post_publish_window');
  });

  test('refuses when the bytes have not landed', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const id = generateRelicId();
    await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: id,
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );

    const response = await app.fetch(
      req(`/api/relics/${id}/complete`, { method: 'POST' })
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('relic_not_yet_published');
  });

  test('does not mint, consume cap, or write an open', async () => {
    const { id } = await publish();
    const before = (await app.store.readMintLog()).length;

    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    expect((await app.store.getRelic(id))?.mintsUsed).toBe(0);
    expect(await app.store.readMintLog()).toHaveLength(before);
  });
});

describe('republish and versions', () => {
  test('a first grant returns the publish token exactly once, at version 1', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'];
    // 32 random bytes, base64url: 43 characters, no padding, no + or /.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await app.store.getRelic(id);
    expect(row?.version).toBe(1);
    // The row holds a hash, never the credential itself.
    expect(row?.publishTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.publishTokenHash).not.toBe(token);
  });

  test('the token never appears outside the first grant response', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'] as string;

    const response = await republish(id, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['publish_token']).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(token);
  });

  test('a valid token opens version 2 at the suffixed object path', async () => {
    const { id, grant } = await publish();

    const response = await republish(id, grant['publish_token'] as string, {
      rendererClass: 'html',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { upload_url: string };
    expect(body.upload_url).toContain(`/upload/${id}/v2?`);

    const row = await app.store.getRelic(id);
    expect(row?.version).toBe(2);
    expect(row?.rendererClass).toBe('html');
    // Version 1's object stays in place until the new one completes: a
    // republish in flight must not be able to destroy the servable bytes.
    expect(await storage.stat(id)).toBeDefined();
    expect(await storage.stat(`${id}/v2`)).toBeUndefined();
  });

  test('republish with no title key leaves stored title, empty string clears it, and value replaces it', async () => {
    const { id, grant } = await publish({ title: 'Initial Title' });
    const token = grant['publish_token'] as string;

    const res1 = await republish(id, token, { rendererClass: 'html' });
    expect(res1.status).toBe(200);
    const row1 = await app.store.getRelic(id);
    expect(row1?.version).toBe(2);
    expect(row1?.title).toBe('Initial Title');

    const res2 = await republish(id, token, { title: 'Second Title' });
    expect(res2.status).toBe(200);
    const row2 = await app.store.getRelic(id);
    expect(row2?.version).toBe(3);
    expect(row2?.title).toBe('Second Title');

    const res3 = await republish(id, token, { title: '   ' });
    expect(res3.status).toBe(200);
    const row3 = await app.store.getRelic(id);
    expect(row3?.version).toBe(4);
    expect(row3?.title).toBeUndefined();

    const res4 = await republish(id, token, { title: 'bad\0title' });
    expect(res4.status).toBe(400);
    expect((await res4.json()).code).toBe('invalid_publish_metadata');
  });

  test('completion and mint serve the new version bytes', async () => {
    const { id, key, grant } = await publish();
    const first = await storage.stat(id);

    await republish(id, grant['publish_token'] as string);
    const container = await encrypted('hello relic, revised and longer', key);
    storage.put(`${id}/v2`, container);

    now += 30 * 1000;
    const completed = await app.fetch(
      req(`/api/relics/${id}/complete`, { method: 'POST' })
    );
    expect(completed.status).toBe(200);
    const completedBody = await completed.json();
    expect(completedBody.object_length).toBe(container.length);
    // A true publish timestamp for the new version, same as a first publish.
    expect((await app.store.getRelic(id))?.publishedAt).toBe(now);

    const mint = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as {
      url: string;
      object_length: number;
      object_crc32c: string;
    };
    expect(mint.url).toContain(`/o/${id}/v2?`);
    expect(mint.object_length).toBe(container.length);
    expect(mint.object_crc32c).not.toBe(first?.crc32c);
  });

  test('a mint between republish and landing is the usual temporary 409', async () => {
    const { id, grant } = await publish();
    await republish(id, grant['publish_token'] as string);

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('relic_not_yet_published');
  });

  test('a wrong or missing publish token is 403 invalid_publish_token', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'] as string;

    for (const bad of [undefined, 'not-the-token', token.slice(0, 42)]) {
      const response = await republish(id, bad);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.code).toBe('invalid_publish_token');
      expect(body.relic_id).toBe(id);
    }
    // A refused republish does not consume a version.
    expect((await app.store.getRelic(id))?.version).toBe(1);
  });

  test('a takedown can never be undone by republishing', async () => {
    const { id, grant } = await publish();
    await app.fetch(
      req(`/api/relics/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );

    // The refusal lands before the token is even hashed, so the rightful
    // holder and a brute force are indistinguishable here.
    const response = await republish(id, grant['publish_token'] as string);
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('relic_removed');
  });

  test('the download cap is one number across all versions', async () => {
    app = build({ config: { downloadCap: 2 } });
    const { id, grant } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;

    for (let index = 0; index < 2; index++) {
      const response = await app.fetch(
        req(`/api/relics/${id}/mint`, {
          method: 'POST',
          ip: `203.0.113.${index + 20}`,
        })
      );
      expect(response.status).toBe(200);
    }

    await republish(id, grant['publish_token'] as string);
    storage.put(
      `${id}/v2`,
      await encrypted('hello relic again', generateKey())
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.99' })
    );
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.code).toBe('download_cap_exhausted');
    expect(body.download_cap).toBe(2);
  });

  test('version 1 keeps the bare object path production already serves', async () => {
    const { id, grant } = await publish();
    expect(grant['upload_url']).toContain(`/upload/${id}?`);
    expect(await storage.stat(`${id}/v1`)).toBeUndefined();

    const mint = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url: string };
    expect(mint.url).toContain(`/o/${id}?`);
    expect(mint.url).not.toContain('/v1');
  });

  test('a repeat mint after a republish is a fresh URL for new content', async () => {
    const { id, key, grant } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;
    const first = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url: string };

    await republish(id, grant['publish_token'] as string);
    storage.put(
      `${id}/v2`,
      await encrypted('hello relic, second edition', key)
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    // Still inside the dedup window, but the content changed: new content
    // is a first look, not a reload.
    now += 3 * 60 * 1000;
    const second = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url: string };
    expect(second.url).toContain(`/o/${id}/v2?`);
    expect(second.url).not.toBe(first.url);

    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.countedAsOpen).toBe(true);
    expect(entry?.dropReason).toBeUndefined();
  });

  test('a delete removes and blocklists every version payload', async () => {
    const { id, key, grant } = await publish();
    const v1Bytes = await storage.read(id);
    if (v1Bytes === undefined) throw new Error('v1 bytes missing');
    const v1Hash = await ciphertextHash(v1Bytes);

    await republish(id, grant['publish_token'] as string);
    storage.put(`${id}/v2`, await encrypted('a second payload', key));
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    const response = await app.fetch(
      req(`/api/relics/${id}?reason=abuse`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(response.status).toBe(200);

    expect(await storage.stat(id)).toBeUndefined();
    expect(await storage.stat(`${id}/v2`)).toBeUndefined();

    // The tombstone records the version that was being served, and the
    // blocklist covers the older payload too: one republish must not be
    // able to hide a payload from the abuse control.
    const stone = await app.store.getTombstone(id);
    expect(stone?.ciphertextHash).not.toBe(v1Hash);
    expect(await app.store.isBlocklisted(stone?.ciphertextHash ?? '')).toBe(
      true
    );
    expect(await app.store.isBlocklisted(v1Hash)).toBe(true);
  });

  test('a republish declaration obeys the same size cap arithmetic', async () => {
    const { id, grant } = await publish();
    const response = await republish(id, grant['publish_token'] as string, {
      size: 200 * 1024 * 1024,
    });
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('size_over_cap');
    expect((await app.store.getRelic(id))?.version).toBe(1);
  });

  test('a republish on an unknown id is 404, an unparseable one is 400', async () => {
    const missing = await republish(generateRelicId(), 'whatever');
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('relic_not_found');

    const malformed = await republish('too-short', 'whatever');
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).code).toBe('invalid_relic_id');
  });
});

describe('the download cap', () => {
  test('exhaustion is 410 download_cap_exhausted, echoing the published cap', async () => {
    app = build({ config: { downloadCap: 2 } });
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;

    for (let index = 0; index < 2; index++) {
      const response = await app.fetch(
        req(`/api/relics/${id}/mint`, {
          method: 'POST',
          ip: `203.0.113.${index + 20}`,
        })
      );
      expect(response.status).toBe(200);
    }

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.99' })
    );
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.code).toBe('download_cap_exhausted');
    expect(body.download_cap).toBe(2);
  });

  test('the default cap clears the 40-person Defender arithmetic with room', async () => {
    // A 40-person list draws a floor of 40 legitimate mints and a ceiling near
    // 80 where scanners detonate with a real browser.
    expect(app.config.downloadCap).toBeGreaterThanOrEqual(80);
  });
});

describe('signed URL validity', () => {
  test('clamps to min(url_validity, relic_expiry)', async () => {
    const { id } = await publish({ ttlDays: 7 });
    // 5 minutes of relic life left, against a 15-minute validity window.
    now += 7 * 86_400 * 1000 - 5 * 60 * 1000;

    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url_expires_at: string };

    expect(Date.parse(body.url_expires_at)).toBeLessThanOrEqual(
      now + 5 * 60 * 1000 + 1000
    );
  });

  test('refuses below the minimum viable validity rather than issuing a dying URL', async () => {
    const { id } = await publish({ ttlDays: 7 });
    now += 7 * 86_400 * 1000 - 30 * 1000;

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('relic_expired');
  });
});

describe('publisher lifetimes', () => {
  const grantedAt = Date.parse('2026-08-02T12:00:00.000Z');

  test('a grant with no ttl_days reports no deadline', async () => {
    const response = await grantFor({});
    const grant = (await response.json()) as {
      relic_expires_at: string | null;
    };
    expect(grant.relic_expires_at).toBeNull();
  });

  test('an explicit null ttl_days means the same as omitting it', async () => {
    const response = await grantFor({ ttl_days: null });
    const grant = (await response.json()) as {
      relic_expires_at: string | null;
    };
    expect(grant.relic_expires_at).toBeNull();
  });

  test('a supplied ttl_days is recorded as the grant deadline', async () => {
    const response = await grantFor({ ttl_days: 3 });
    const grant = (await response.json()) as {
      relic_expires_at: string | null;
    };
    expect(grant.relic_expires_at).toBe(
      new Date(grantedAt + 3 * 86_400 * 1000).toISOString()
    );
  });

  test('the ttl_days boundaries are inclusive', async () => {
    for (const ttlDays of [1, 3650]) {
      const response = await grantFor({ ttl_days: ttlDays });
      expect(response.status).toBe(200);
    }
  });

  test('out-of-range and non-integer ttl_days refuse with invalid_publish_metadata', async () => {
    for (const bad of [0, -1, 1.5, 3651, '7', true]) {
      const response = await grantFor({ ttl_days: bad });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('invalid_publish_metadata');
    }
  });

  test('a relic with no lifetime mints however far the clock advances', async () => {
    const { id } = await publish();
    // Past the 3650-day ceiling, past any retention window.
    now += 11 * 365 * 86_400 * 1000;
    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      relic_expires_at: string | null;
    };
    expect(body.relic_expires_at).toBeNull();
  });

  test('a relic with no lifetime reports null on complete too', async () => {
    const { id } = await publish();
    const response = await app.fetch(
      req(`/api/relics/${id}/complete`, { method: 'POST' })
    );
    expect(response.status).toBe(200);
    expect((await response.json()).relic_expires_at).toBeNull();
  });

  test('a relic with no lifetime mints at the full validity window', async () => {
    const { id } = await publish();
    // Thirty days past any TTL this service ever had, and the URL still
    // carries the whole fifteen minutes: nothing left to clamp against.
    now += 30 * 86_400 * 1000;
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url_expires_at: string };
    expect(Date.parse(body.url_expires_at)).toBe(now + 15 * 60 * 1000);
  });

  test('a relic granted a lifetime behaves exactly as the fixed TTL did', async () => {
    const { id } = await publish({ ttlDays: 7 });
    now += 6 * 86_400 * 1000;
    const live = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(live.status).toBe(200);

    now += 2 * 86_400 * 1000;
    const dead = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.6' })
    );
    expect(dead.status).toBe(410);
    expect((await dead.json()).code).toBe('relic_expired');
  });
});

describe('the kill switch', () => {
  test('refuses every mint with 503 service_paused', async () => {
    app = build({ config: { killSwitchEngaged: true } });
    const response = await app.fetch(
      req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' })
    );
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('service_paused');
  });

  test('refuses publishing too', async () => {
    app = build({ config: { killSwitchEngaged: true } });
    const response = await app.fetch(req('/api/challenge', { method: 'POST' }));
    expect(response.status).toBe(503);
  });
});

describe('rate limiting', () => {
  test('refuses with 429 and never 401 or 403', async () => {
    app = build({ config: { mintRateLimit: { limit: 2, windowSeconds: 60 } } });
    const { id } = await publish();

    const statuses: number[] = [];
    for (let index = 0; index < 5; index++) {
      const response = await app.fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.7' })
      );
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
    expect(statuses).not.toContain(401);
    expect(statuses).not.toContain(403);
  });

  test('sends both Retry-After and the mirrored extension member', async () => {
    app = build({ config: { mintRateLimit: { limit: 1, windowSeconds: 60 } } });
    const { id } = await publish();
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.8' })
    );
    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.8' })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect((await response.json()).retry_after_seconds).toBeGreaterThan(0);
  });
});

describe('problem documents', () => {
  test('are served as application/problem+json', async () => {
    const response = await app.fetch(
      req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' })
    );
    expect(response.headers.get('content-type')).toBe(
      'application/problem+json'
    );
  });

  test('carry an occurrence id in instance, never the request path', async () => {
    const id = generateRelicId();
    const body = (await app
      .fetch(req(`/api/relics/${id}/mint`, { method: 'POST' }))
      .then((r) => r.json())) as { instance: string };

    expect(body.instance).toContain('/problems/occurrences/');
    expect(body.instance).not.toContain(id);
  });

  test('the occurrence id joins the response to a mint log line', async () => {
    const body = (await app
      .fetch(req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' }))
      .then((r) => r.json())) as { instance: string };

    const occurrenceId = body.instance.split('/').pop();
    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.occurrenceId).toBe(occurrenceId as string);
  });

  test('type is generated from code, so the two cannot disagree', async () => {
    const body = (await app
      .fetch(req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' }))
      .then((r) => r.json())) as { type: string; code: string };
    expect(body.type).toBe(`https://relic.example/problems/${body.code}`);
  });
});

describe('delete by id', () => {
  test('requires an operator credential', async () => {
    const { id } = await publish();
    const response = await app.fetch(
      req(`/api/relics/${id}`, { method: 'DELETE' })
    );
    expect(response.status).toBe(401);
  });

  test('stops serving and tombstones the row, which is never removed', async () => {
    const { id } = await publish();
    const response = await app.fetch(
      req(`/api/relics/${id}?reason=abuse&reference=REP-1`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(response.status).toBe(200);

    const stone = await app.store.getTombstone(id);
    expect(stone?.operator).toBe('jason');
    expect(stone?.reasonClass).toBe('abuse');
    expect(stone?.reportReference).toBe('REP-1');
    // Upload IP and timestamp survive for law enforcement.
    expect(stone?.publishIp).toBe('198.51.100.10');
    expect(stone?.ciphertextHash).toHaveLength(64);
  });

  test('a deleted relic mints 410 relic_removed with the appeal path', async () => {
    const { id } = await publish();
    await app.fetch(
      req(`/api/relics/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.code).toBe('relic_removed');
    expect(body.report_url).toBe('https://relic.example/abuse');
  });

  test('the public code never names the reason', async () => {
    for (const reason of ['abuse', 'legal', 'blocklist_match']) {
      const local = build();
      app = local;
      const { id } = await publish();
      await app.fetch(
        req(`/api/relics/${id}?reason=${reason}`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer operator-secret' },
        })
      );
      const body = await app
        .fetch(req(`/api/relics/${id}/mint`, { method: 'POST' }))
        .then((r) => r.json());
      expect(body.code).toBe('relic_removed');
    }
  });

  test('blocklists automatically on abuse, not on legal', async () => {
    const first = await publish();
    await app.fetch(
      req(`/api/relics/${first.id}?reason=abuse`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    const abuseStone = await app.store.getTombstone(first.id);
    expect(
      await app.store.isBlocklisted(abuseStone?.ciphertextHash ?? '')
    ).toBe(true);

    const second = await publish();
    await app.fetch(
      req(`/api/relics/${second.id}?reason=legal`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    const legalStone = await app.store.getTombstone(second.id);
    expect(
      await app.store.isBlocklisted(legalStone?.ciphertextHash ?? '')
    ).toBe(false);
  });

  test('is idempotent and never returns 404 on a tombstoned id', async () => {
    const { id } = await publish();
    const auth = { authorization: 'Bearer operator-secret' };
    await app.fetch(
      req(`/api/relics/${id}`, { method: 'DELETE', headers: auth })
    );

    const second = await app.fetch(
      req(`/api/relics/${id}`, { method: 'DELETE', headers: auth })
    );
    expect(second.status).toBe(200);
    expect((await second.json()).already_deleted).toBe(true);
  });

  test('404 on the delete endpoint means never issued, and nothing else', async () => {
    const response = await app.fetch(
      req(`/api/relics/${generateRelicId()}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(response.status).toBe(404);
  });

  test('refuses a delete it cannot hash', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const id = generateRelicId();
    await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: id,
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );

    const response = await app.fetch(
      req(`/api/relics/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(response.status).toBe(409);
  });
});

describe('the abuse form', () => {
  test('strips the fragment server-side, which is the only strip a no-JS post reaches', async () => {
    const key = 'r1AAAAAAAAAAAAAAAAAAAA';
    const id = generateRelicId();
    const form = new FormData();
    form.set('relic_id', `https://relic.example/${id}#${key}`);
    form.set('category', 'phishing');
    form.set('description', 'looks like a credential harvest');

    const response = await app.fetch(
      req('/abuse', { method: 'POST', body: form })
    );
    expect(response.status).toBe(202);

    const reports = await app.store.readAbuseReports();
    expect(reports[0]?.relicId).toBe(id);
    expect(JSON.stringify(reports)).not.toContain(key);
  });

  test('requires authority and reference on legal process', async () => {
    const form = new FormData();
    form.set('relic_id', generateRelicId());
    form.set('category', 'legal_process');
    form.set('description', 'court order');

    const response = await app.fetch(
      req('/abuse', { method: 'POST', body: form })
    );
    expect(response.status).toBe(400);
  });
});

describe('stripToRelicId', () => {
  test('drops the fragment and the origin', () => {
    expect(stripToRelicId('https://relic.example/abc123#r1KEY')).toBe('abc123');
  });

  test('accepts a bare id', () => {
    expect(stripToRelicId('abc123')).toBe('abc123');
  });

  test('drops a fragment on a bare id', () => {
    expect(stripToRelicId('abc123#r1KEY')).toBe('abc123');
  });
});

describe('config invariants', () => {
  test('refuses a dedup interval inside the post-publish window', () => {
    expect(() =>
      createApp({
        config: { mintDedupSeconds: 60, postPublishWindowSeconds: 120 },
      })
    ).toThrow(/dedup/);
  });

  test('refuses a usercontent origin sharing the service host', () => {
    expect(() =>
      createApp({
        config: {
          serviceOrigin: 'https://relic.example',
          usercontentOrigin: 'https://relic.example',
        },
      })
    ).toThrow(/distinct host/);
  });

  test('refuses a URL validity over the GCS ceiling', () => {
    expect(() =>
      createApp({ config: { urlValiditySeconds: 700_000 } })
    ).toThrow(/ceiling/);
  });
});

describe('comments', () => {
  test('lists an empty thread without asking who you are', async () => {
    const { id } = await publish();
    const response = await app.fetch(req(`/api/relics/${id}/comments`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });

  test('the publisher comments with the publish token and is stored as publisher', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'] as string;

    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'YWJjZA',
          publish_token: token,
        }),
      })
    );
    expect(posted.status).toBe(201);
    const created = (await posted.json()) as { author: string };
    expect(created.author).toBe('publisher');

    const listed = await app.fetch(req(`/api/relics/${id}/comments`));
    const listedBody = await listed.json();
    expect(Array.isArray(listedBody)).toBe(true);
    expect(listedBody).toHaveLength(1);
    expect(listedBody[0]?.author).toBe('publisher');
    expect(listedBody[0]?.ciphertext).toBe('YWJjZA');
  });

  test('the stored ciphertext is not the plaintext, which is the zero-knowledge claim', async () => {
    const { id, key, grant } = await publish();
    const token = grant['publish_token'] as string;
    const secret = 'the body the server must never see';

    const commentKey = await deriveCommentKey(key);
    const ciphertext = await encryptComment(commentKey, {
      body: secret,
      display_name: null,
    });

    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ ciphertext, publish_token: token }),
      })
    );
    expect(posted.status).toBe(201);

    const rows = await app.store.listComments(id);
    expect(rows).toHaveLength(1);
    const stored = rows[0]?.ciphertext ?? '';
    expect(stored).toBe(ciphertext);
    expect(stored).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain(secret);

    // And a holder of the fragment key can still read it, which is the
    // other half of the claim: opaque to the server, readable to anyone
    // who already holds the relic.
    const opened = await decryptComment(commentKey, stored);
    expect(opened.body).toBe(secret);
  });

  test('refuses a body that is not base64url, the one check this server can make', async () => {
    const { id, grant } = await publish();
    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'not+valid/base64==',
          publish_token: grant['publish_token'],
        }),
      })
    );
    expect(posted.status).toBe(400);
    expect((await posted.json()).code).toBe('invalid_comment');
    expect(await app.store.listComments(id)).toHaveLength(0);
  });

  test('a tombstoned relic has no thread, even to a reader who already has the link', async () => {
    const { id } = await publish();
    await app.fetch(
      req(`/api/relics/${id}?reason=abuse`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );

    const listed = await app.fetch(req(`/api/relics/${id}/comments`));
    expect(listed.status).toBe(410);
    expect((await listed.json()).code).toBe('relic_removed');
  });

  test('deleting a relic takes its comments with it', async () => {
    const { id, grant } = await publish();
    await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'YWJjZA',
          publish_token: grant['publish_token'],
        }),
      })
    );
    expect(await app.store.listComments(id)).toHaveLength(1);

    const deleted = await app.fetch(
      req(`/api/relics/${id}?reason=abuse`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).comments_deleted).toBe(1);
    expect(await app.store.listComments(id)).toHaveLength(0);
  });

  test('the author can delete their own comment, and nobody else can', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'] as string;
    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ ciphertext: 'YWJjZA', publish_token: token }),
      })
    );
    const commentId = ((await posted.json()) as { comment_id: string })
      .comment_id;

    const stranger = await app.fetch(
      req(`/api/relics/${id}/comments/${commentId}`, {
        method: 'DELETE',
        body: JSON.stringify({}),
      })
    );
    expect(stranger.status).toBe(403);
    expect((await stranger.json()).code).toBe('comment_forbidden');
    expect(await app.store.listComments(id)).toHaveLength(1);

    const own = await app.fetch(
      req(`/api/relics/${id}/comments/${commentId}`, {
        method: 'DELETE',
        body: JSON.stringify({ publish_token: token }),
      })
    );
    expect(own.status).toBe(204);
    expect(await app.store.listComments(id)).toHaveLength(0);
  });
});

describe('magic-link identity', () => {
  test('a followed link lets a reader comment, and the stored author is the address', async () => {
    const sent: Array<{ email: string; link: string }> = [];
    const mailer: Mailer = {
      async send(email, link) {
        sent.push({ email, link });
      },
    };
    app = build({ mailer });

    const { id } = await publish();
    const asked = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({
          email: 'reader@example.com',
          return_to: `/${id}`,
        }),
      })
    );
    expect(asked.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email).toBe('reader@example.com');

    const link = sent[0]?.link ?? '';
    const followed = await app.fetch(
      req(new URL(link).pathname + new URL(link).search, {
        redirect: 'manual',
      })
    );
    expect(followed.status).toBe(303);
    expect(followed.headers.get('location')).toBe(`/${id}`);
    const cookie = followed.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toMatch(/relic_session=/);

    const session = cookie.split(';')[0] ?? '';
    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: session },
        body: JSON.stringify({ ciphertext: 'YWJjZA' }),
      })
    );
    expect(posted.status).toBe(201);
    expect(((await posted.json()) as { author: string }).author).toBe(
      'reader@example.com'
    );
  });

  test('one sign-in carries to every other relic, without a second link', async () => {
    // The reported symptom was signing in again for each relic. The session
    // row has no relic id and the cookie is Path=/, so this asserts the
    // property end to end rather than reading the shapes and assuming it.
    const sent: Array<{ email: string; link: string }> = [];
    app = build({
      mailer: {
        async send(email, link) {
          sent.push({ email, link });
        },
      },
    });

    const first = await publish();
    const second = await publish();
    expect(second.id).not.toBe(first.id);

    // Signed in from the first relic, and only ever from there.
    await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({
          email: 'reader@example.com',
          return_to: `/${first.id}`,
        }),
      })
    );
    const link = sent[0]?.link;
    if (link === undefined) throw new Error('no link was sent');
    const followed = await app.fetch(
      req(new URL(link).pathname + new URL(link).search, {
        redirect: 'manual',
      })
    );
    const session = (followed.headers.get('set-cookie') ?? '').split(';')[0];
    if (session === undefined) throw new Error('no session cookie');

    // The reader now opens a relic they have never signed in on. The session
    // endpoint has to already know them, or the composer asks again and this
    // is exactly the reported bug.
    const who = await app.fetch(
      req('/api/auth/session', { headers: { cookie: session } })
    );
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({ email: 'reader@example.com' });

    // And the write on the second relic is attributed to the same address,
    // with no second link anywhere in the flow.
    const posted = await app.fetch(
      req(`/api/relics/${second.id}/comments`, {
        method: 'POST',
        headers: { cookie: session },
        body: JSON.stringify({ ciphertext: 'c2Vjb25k' }),
      })
    );
    expect(posted.status).toBe(201);

    const rows = await app.store.listComments(second.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.author).toBe('reader@example.com');
    expect(sent).toHaveLength(1);
  });

  test('asking for a link always answers 202, even for garbage, so it is not an address oracle', async () => {
    const sent: Array<{ email: string; link: string }> = [];
    const mailer: Mailer = {
      async send(email, link) {
        sent.push({ email, link });
      },
    };
    app = build({ mailer });

    const garbage = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({ email: 'not-an-address' }),
      })
    );
    expect(garbage.status).toBe(202);
    expect(sent).toHaveLength(0);

    const missing = await app.fetch(
      req('/api/auth/request', { method: 'POST', body: '{}' })
    );
    expect(missing.status).toBe(202);
    expect(sent).toHaveLength(0);
  });

  test('a provider refusal is still 202, so error codes cannot become the oracle', async () => {
    // Mail can fail for reasons that have nothing to do with the address: an
    // unverified domain, a suspended key, a quota. If those turned into a 500
    // while an undeliverable address kept its 202, the oracle the status code
    // was flattened to prevent would be rebuilt out of failure modes.
    const attempts: string[] = [];
    app = build({
      mailer: {
        async send(email) {
          attempts.push(email);
          throw new Error('resend refused with 403 validation_error');
        },
      },
    });

    const asked = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );

    expect(asked.status).toBe(202);
    expect(attempts).toEqual(['reader@example.com']);
  });

  test('a spent or missing token is invalid_session, not a new session', async () => {
    const sent: Array<{ email: string; link: string }> = [];
    app = build({
      mailer: {
        async send(email, link) {
          sent.push({ email, link });
        },
      },
    });

    await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    const link = sent[0]?.link ?? '';
    const url = new URL(link);
    const path = url.pathname + url.search;

    const first = await app.fetch(req(path, { redirect: 'manual' }));
    expect(first.status).toBe(303);

    const replay = await app.fetch(req(path, { redirect: 'manual' }));
    expect(replay.status).toBe(401);
    expect((await replay.json()).code).toBe('invalid_session');

    const missing = await app.fetch(
      req('/api/auth/callback', { redirect: 'manual' })
    );
    expect(missing.status).toBe(401);
    expect((await missing.json()).code).toBe('invalid_session');
  });

  test('GET /api/auth/session is 200 with null when nobody is signed in, never 401', async () => {
    const response = await app.fetch(req('/api/auth/session'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: null });
  });

  test('after a followed link, GET /api/auth/session returns the verified address', async () => {
    const sent: Array<{ email: string; link: string }> = [];
    app = build({
      mailer: {
        async send(email, link) {
          sent.push({ email, link });
        },
      },
    });
    const { id } = await publish();

    await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({
          email: 'reader@example.com',
          relic_id: id,
        }),
      })
    );
    const link = sent[0]?.link ?? '';
    const followed = await app.fetch(
      req(new URL(link).pathname + new URL(link).search, {
        redirect: 'manual',
      })
    );
    expect(followed.headers.get('location')).toBe(`/${id}`);
    const session = (followed.headers.get('set-cookie') ?? '').split(';')[0];

    const probe = await app.fetch(
      req('/api/auth/session', { headers: { cookie: session ?? '' } })
    );
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ email: 'reader@example.com' });
  });

  test('an absolute return_to is dropped so a sign-in cannot leave the service', async () => {
    const sent: Array<{ email: string; link: string }> = [];
    app = build({
      mailer: {
        async send(email, link) {
          sent.push({ email, link });
        },
      },
    });

    await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({
          email: 'reader@example.com',
          return_to: 'https://evil.example/steal',
        }),
      })
    );
    const link = sent[0]?.link ?? '';
    const followed = await app.fetch(
      req(new URL(link).pathname + new URL(link).search, {
        redirect: 'manual',
      })
    );
    expect(followed.headers.get('location')).toBe('/');
  });
});
