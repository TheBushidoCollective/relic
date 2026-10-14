import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAME_CSP, FRAME_CSP_META } from '../build.ts';

/**
 * The cover page ships inside relic-mcp and must never be served by the
 * service origin, so these checks read what the builds actually emit.
 *
 * Both builds run in a child process, the same way every other build check in
 * this directory does. Calling Bun.build in-process from a test here fails to
 * resolve sibling modules on the pinned bun, while the same build run as a
 * script succeeds, so the child process is what CI and publishers exercise.
 */

const pkgDir = new URL('..', import.meta.url).pathname;

const EXPECTED_COVER_FILES = [
  'cover.css',
  'cover.js',
  'frame.html',
  'index.html',
  'pdf.worker.mjs',
  'styles.css',
].sort();

let coverDir = '';

beforeAll(async () => {
  coverDir = await mkdtemp(join(tmpdir(), 'cover-build-test-'));
  const built = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      "import { buildCover } from './build.ts'; await buildCover({ outdir: process.env.COVER_OUT });",
    ],
    { cwd: pkgDir, env: { ...process.env, COVER_OUT: `${coverDir}/` } }
  );
  expect(built.exitCode).toBe(0);
});

afterAll(async () => {
  await rm(coverDir, { recursive: true, force: true });
});

describe('cover asset build', () => {
  test('emits the exact expected file set', async () => {
    const files = (await readdir(coverDir)).sort();
    expect(files).toEqual(EXPECTED_COVER_FILES);
  });

  test('frame.html carries the frame CSP immediately after the doctype', async () => {
    const html = await Bun.file(join(coverDir, 'frame.html')).text();

    expect(html).toContain(FRAME_CSP);
    const doctypeIndex = html.indexOf('<!doctype html>');
    expect(doctypeIndex).toBeGreaterThanOrEqual(0);
    const metaIndex = html.indexOf(FRAME_CSP_META);
    expect(metaIndex).toBeGreaterThan(doctypeIndex);

    const beforeMeta = html.slice(
      doctypeIndex + '<!doctype html>'.length,
      metaIndex
    );
    expect(beforeMeta.trim()).toBe('');
  });

  test('index.html references only same-origin paths', async () => {
    const html = await Bun.file(join(coverDir, 'index.html')).text();
    const paths = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(
      (m) => m[1] ?? ''
    );

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith('/')).toBe(true);
      expect(path.startsWith('//')).toBe(false);
      expect(path.includes('://')).toBe(false);
    }
  });

  test('the viewer build served as /assets carries none of the cover page', async () => {
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    const distFiles = await readdir(`${pkgDir}dist/`);
    for (const name of ['cover.js', 'cover.css', 'frame.html', 'index.html']) {
      expect(distFiles).not.toContain(name);
    }
  });
});
