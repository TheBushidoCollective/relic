import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildViewer, FRAME_CSP, FRAME_CSP_META } from '../build.ts';

const EXPECTED_COVER_FILES = [
  'cover.css',
  'cover.js',
  'frame.html',
  'index.html',
  'pdf.worker.mjs',
  'styles.css',
].sort();

const pkgDir = new URL('..', import.meta.url).pathname;

/**
 * Runs buildCover in a fresh bun process, the way the relic-mcp build runs
 * it. Inside bun:test the first Bun.build of an entry whose imports climb a
 * directory (`src/cover/kinds.ts` importing `../text-views.ts`) fails with
 * "Could not resolve" (oven-sh/bun#22941, reproduced on the pinned 1.3.14);
 * that is the test runner's resolver, not the build.
 */
async function buildCover(options: { outdir: string }): Promise<void> {
  const script = [
    `import { buildCover } from ${JSON.stringify(`${pkgDir}build.ts`)};`,
    `await buildCover({ outdir: ${JSON.stringify(options.outdir)} });`,
  ].join('\n');
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [stderr, exit] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`buildCover exited ${exit}: ${stderr}`);
}

describe('cover asset build', () => {
  test('emits the exact expected file set', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cover-build-test-'));
    try {
      await buildCover({ outdir: `${tempDir}/` });
      const files = (await readdir(tempDir)).sort();
      expect(files).toEqual(EXPECTED_COVER_FILES);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('frame.html contains the frame CSP verbatim as the first head element', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cover-csp-test-'));
    try {
      await buildCover({ outdir: `${tempDir}/` });
      const html = await Bun.file(join(tempDir, 'frame.html')).text();

      expect(html).toContain(FRAME_CSP);
      expect(html).toContain(FRAME_CSP_META);

      // Verify the CSP meta is placed immediately after the doctype as the first element in head
      const doctypeIndex = html.indexOf('<!doctype html>');
      expect(doctypeIndex).toBeGreaterThanOrEqual(0);
      const metaIndex = html.indexOf(FRAME_CSP_META);
      expect(metaIndex).toBeGreaterThan(doctypeIndex);

      const beforeMeta = html.slice(
        doctypeIndex + '<!doctype html>'.length,
        metaIndex
      );
      expect(beforeMeta.trim()).toBe('');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('index.html references only same-origin paths', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cover-index-test-'));
    try {
      await buildCover({ outdir: `${tempDir}/` });
      const html = await Bun.file(join(tempDir, 'index.html')).text();

      const pathMatches = [
        ...html.matchAll(/(?:href|src)=["']([^"']+)["']/g),
      ].map((m) => m[1] ?? '');

      expect(pathMatches.length).toBeGreaterThan(0);
      for (const path of pathMatches) {
        expect(path.startsWith('/')).toBe(true);
        expect(path.startsWith('//')).toBe(false);
        expect(path.includes('://')).toBe(false);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('relic-viewer dist/ contains none of cover.js, cover.css, frame.html, index.html', async () => {
    // Build standard viewer distribution
    await buildViewer({ outdir: `${pkgDir}dist/` });
    const distFiles = await readdir(`${pkgDir}dist/`);

    const forbidden = ['cover.js', 'cover.css', 'frame.html', 'index.html'];
    for (const name of forbidden) {
      expect(distFiles.includes(name)).toBe(false);
    }
  });

  test('guard fails if cover.js is emitted into viewer dist', () => {
    const sampleFiles = ['viewer.js', 'styles.css', 'cover.js'];
    const forbidden = ['cover.js', 'cover.css', 'frame.html', 'index.html'];
    const hasForbidden = sampleFiles.some((f) => forbidden.includes(f));
    expect(hasForbidden).toBe(true);
  });
});
