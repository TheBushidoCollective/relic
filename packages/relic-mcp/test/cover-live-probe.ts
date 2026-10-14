/**
 * Live service cover probe.
 *
 *   bun packages/relic-mcp/test/cover-live-probe.ts
 *
 * Exercises cover upload, serving, and lifecycle against a live deployment.
 * Supports:
 *   RELIC_SERVICE_ORIGIN: destination service, defaults to https://relik.link
 *   RELIC_CHROME_PATH: optional explicit browser path
 *   RELIC_COVER_PROBE_CLIENT: 'source' (local dist bundle) or 'npx:<version>'
 *
 * Never prints the share URL, because the URL fragment contains the key.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { validateCoverRaster } from '@relic/format/cover';

const serviceOrigin = (
  process.env['RELIC_SERVICE_ORIGIN'] ?? 'https://relik.link'
).replace(/\/+$/, '');
const chromePath = process.env['RELIC_CHROME_PATH'];
const probeClient = process.env['RELIC_COVER_PROBE_CLIENT'] ?? 'source';

const scratch = await mkdtemp(join(tmpdir(), 'relic-cover-live-probe-'));
const statePath = join(scratch, 'state.json');

const bundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);

function resolveCommand(): string[] {
  if (probeClient.startsWith('npx:')) {
    const pkg = probeClient.slice(4);
    return ['npx', `relic-mcp@${pkg}`];
  }
  return ['node', bundlePath];
}

async function callMcp(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const cmd = resolveCommand();
  const child = Bun.spawn(cmd, {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: serviceOrigin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CLIENT_NAME: 'relic-mcp/cover-live-probe',
      ...(chromePath ? { RELIC_CHROME_PATH: chromePath } : {}),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();

  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  assert.equal(exit, 0, `relic-mcp exited with code ${exit}: ${stderr}`);
  const lines = stdout
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const raw = lines[lines.length - 1];
  assert.ok(raw !== undefined, 'relic-mcp returned empty output');
  const response = JSON.parse(raw) as {
    error?: unknown;
    result?: { structuredContent?: Record<string, unknown> } & Record<
      string,
      unknown
    >;
  };
  if (response.error) {
    throw new Error(`MCP error: ${JSON.stringify(response.error)}`);
  }
  const result = response.result?.structuredContent ?? response.result;
  assert.ok(result !== undefined, 'missing result in MCP response');
  return result;
}

try {
  const filePath = join(scratch, 'probe.md');
  await writeFile(
    filePath,
    '# Live Probe\n\nTesting per-relic cover on live service.\n'
  );

  const pubResult = await callMcp('relic_publish', {
    path: filePath,
    ttl_days: 1,
    title: '',
  });

  const relicId = pubResult['relic_id'];
  assert.ok(
    typeof relicId === 'string' && relicId.length > 0,
    'missing relic_id in publish result'
  );

  const cover = pubResult['cover'] as Record<string, unknown> | undefined;
  assert.ok(cover !== undefined, 'missing cover report in publish result');
  assert.equal(cover['status'], 'uploaded');

  const coverUrl = cover['url'];
  assert.ok(
    typeof coverUrl === 'string' && coverUrl.length > 0,
    'missing cover url'
  );

  // Fetch the shell and verify og:image matches the cover URL
  const shellRes = await fetch(`${serviceOrigin}/${relicId}`);
  assert.equal(shellRes.status, 200);
  const shellHtml = await shellRes.text();

  const ogImageMatch = shellHtml.match(
    /<meta property="og:image" content="([^"]+)">/
  );
  assert.ok(ogImageMatch !== null, 'missing og:image tag in shell');
  assert.equal(ogImageMatch[1], coverUrl);

  // Fetch the cover raster and verify 200 with exact headers and valid 1200x630 bytes
  const coverRes = await fetch(coverUrl);
  assert.equal(coverRes.status, 200);
  const contentType = coverRes.headers.get('content-type');
  assert.ok(
    contentType === 'image/png' || contentType === 'image/jpeg',
    `unexpected content-type: ${contentType}`
  );
  assert.equal(coverRes.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(coverRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(coverRes.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(coverRes.headers.get('x-robots-tag'), 'noindex');
  // One header, two directives: the sandbox directive rides in the CSP.
  assert.equal(
    coverRes.headers.get('content-security-policy'),
    "default-src 'none'; sandbox"
  );

  const coverBytes = new Uint8Array(await coverRes.arrayBuffer());
  const valid = validateCoverRaster(coverBytes, (data) => inflateSync(data));
  assert.ok(
    valid.ok,
    `cover raster validation failed: ${valid.ok ? '' : valid.detail}`
  );

  // Republish changed content with cover: false
  await writeFile(
    filePath,
    '# Live Probe v2\n\nContent updated to republish.\n'
  );
  const repubResult = await callMcp('relic_republish', {
    relic_id: relicId,
    path: filePath,
    cover: false,
  });

  const repubCover = repubResult['cover'] as
    | Record<string, unknown>
    | undefined;
  assert.ok(
    repubCover !== undefined,
    'missing cover report in republish result'
  );
  assert.equal(repubCover['status'], 'declined');

  // Old cover URL must now return 404
  const oldCoverRes = await fetch(coverUrl);
  assert.equal(oldCoverRes.status, 404);

  // Shell og:image must revert to the fallback card
  const shellAfterRes = await fetch(`${serviceOrigin}/${relicId}`);
  assert.equal(shellAfterRes.status, 200);
  const shellAfterHtml = await shellAfterRes.text();
  const fallbackMatch = shellAfterHtml.match(
    /<meta property="og:image" content="([^"]+)">/
  );
  assert.ok(fallbackMatch !== null, 'missing og:image tag after republish');
  assert.ok(
    fallbackMatch[1]?.endsWith('/assets/card.v1.png'),
    `expected card.v1.png fallback, got ${fallbackMatch[1]}`
  );

  console.log(`COVER_LIVE_OK relic_id=${relicId}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
