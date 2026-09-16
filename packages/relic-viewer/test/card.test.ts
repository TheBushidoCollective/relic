import { describe, expect, test } from 'bun:test';
import { isCacheable } from '../src/sw-cache.ts';

/**
 * Verifies the committed unfurl card at packages/relic-viewer/public/card.v1.png.
 *
 * Every major link unfurler (Slack, Discord, iMessage, Twitter) crops or
 * outright refuses a card that is not 1200x630, and an incorrect placeholder
 * would otherwise ship silently. The test parses the real PNG IHDR chunk
 * rather than trusting the filename or extension.
 */

const pkgDir = new URL('..', import.meta.url).pathname;
const cardPath = `${pkgDir}public/card.v1.png`;

describe('the unfurl card asset', () => {
  test('exists in public/ as card.v1.png and is under 300 KB', async () => {
    const file = Bun.file(cardPath);
    expect(await file.exists()).toBe(true);

    const size = file.size;
    expect(size).toBeGreaterThan(0);
    // Must remain small so link unfurlers fetch it quickly and cache it reliably.
    expect(size).toBeLessThan(300 * 1024);
  });

  test('is a valid PNG with IHDR dimensions exactly 1200x630', async () => {
    const bytes = await Bun.file(cardPath).bytes();
    expect(bytes.byteLength).toBeGreaterThanOrEqual(33);

    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) {
      expect(bytes[i]).toBe(pngSignature[i]);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // First chunk must be IHDR: 4-byte length (13), 4-byte chunk type 'IHDR'
    const chunkLength = view.getUint32(8);
    expect(chunkLength).toBe(13);

    const chunkType = new TextDecoder().decode(bytes.slice(12, 16));
    expect(chunkType).toBe('IHDR');

    const width = view.getUint32(16);
    const height = view.getUint32(20);
    expect(width).toBe(1200);
    expect(height).toBe(630);
  });

  test('is excluded from service worker shell precache', () => {
    // The app viewer never renders the unfurl card. Precaching it in the
    // service worker would waste bandwidth on every client install.
    const origin = (path: string) => new URL(`https://relic.example${path}`);
    expect(isCacheable(origin('/assets/card.v1.png'), true)).toBe(false);
    expect(isCacheable(origin('/card.v1.png'), true)).toBe(false);
  });

  test('builds into dist/card.v1.png byte-for-byte identically', async () => {
    // Run build.ts to verify public assets copy cleanly into dist/.
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    const publicBytes = await Bun.file(cardPath).bytes();
    const distBytes = await Bun.file(`${pkgDir}dist/card.v1.png`).bytes();

    expect(distBytes.byteLength).toBe(publicBytes.byteLength);
    for (let i = 0; i < publicBytes.byteLength; i++) {
      expect(distBytes[i]).toBe(publicBytes[i]);
    }
  });
});
