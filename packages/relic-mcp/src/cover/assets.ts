import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COVER_INDEX_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

export const COVER_ASSET_PATHS = [
  '/index.html',
  '/cover.js',
  '/cover.css',
  '/styles.css',
  '/frame.html',
  '/pdf.worker.mjs',
] as const;

export type CoverAssetPath = (typeof COVER_ASSET_PATHS)[number];

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function coverAssetDir(): string {
  return fileURLToPath(
    new URL(
      process.env['RELIC_MCP_COVER_DIR'] ?? '../../dist/cover/',
      import.meta.url
    )
  );
}

export function isCoverAssetPath(pathname: string): pathname is CoverAssetPath {
  return (COVER_ASSET_PATHS as readonly string[]).includes(pathname);
}

export function getCoverAssetContentType(pathname: string): string | undefined {
  const dot = pathname.lastIndexOf('.');
  if (dot === -1) return undefined;
  const ext = pathname.slice(dot);
  return CONTENT_TYPES[ext];
}

export async function loadCoverAsset(
  assetDir: string,
  pathname: string
): Promise<
  | {
      readonly content: Uint8Array;
      readonly headers: readonly {
        readonly name: string;
        readonly value: string;
      }[];
    }
  | undefined
> {
  if (!isCoverAssetPath(pathname)) return undefined;
  const contentType = getCoverAssetContentType(pathname);
  if (!contentType) return undefined;

  const filename = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const filePath = join(assetDir, filename);

  try {
    const fileBytes = await readFile(filePath);
    const headers: { name: string; value: string }[] = [
      { name: 'cache-control', value: 'no-store' },
      { name: 'content-type', value: contentType },
    ];
    if (pathname === '/index.html') {
      headers.push({ name: 'content-security-policy', value: COVER_INDEX_CSP });
    }
    return {
      content: new Uint8Array(fileBytes),
      headers,
    };
  } catch {
    return undefined;
  }
}
