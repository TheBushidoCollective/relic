import { COVER_INPUT_PART_BYTES } from '@relic/format/cover';
import { isCoverAssetPath, loadCoverAsset } from './assets.ts';
import type { CdpConnection, CdpEvent } from './cdp.ts';

export const VIRTUAL_ORIGIN = 'https://cover.relic.invalid';

export interface VirtualOriginOptions {
  readonly assetDir: string;
  readonly inputBytes?: Uint8Array | undefined;
  readonly inputMimetype?: string | undefined;
}

export async function handleRequestPaused(
  cdp: CdpConnection,
  sessionId: string,
  event: CdpEvent,
  options: VirtualOriginOptions
): Promise<void> {
  const requestId = event.params['requestId'] as string;
  const request = event.params['request'] as { url: string } | undefined;

  if (requestId && request?.url) {
    try {
      const url = new URL(request.url);
      if (url.origin === VIRTUAL_ORIGIN) {
        const pathname = url.pathname;
        if (isCoverAssetPath(pathname)) {
          const asset = await loadCoverAsset(options.assetDir, pathname);
          if (asset) {
            await cdp.send(
              'Fetch.fulfillRequest',
              {
                requestId,
                responseCode: 200,
                responseHeaders: asset.headers,
                body: Buffer.from(asset.content).toString('base64'),
              },
              sessionId
            );
            return;
          }
        } else {
          const match = pathname.match(/^\/input\/(\d+)$/);
          if (match?.[1] !== undefined) {
            const partIndex = Number.parseInt(match[1], 10);
            const inputBytes = options.inputBytes ?? new Uint8Array(0);
            const start = partIndex * COVER_INPUT_PART_BYTES;
            const end = (partIndex + 1) * COVER_INPUT_PART_BYTES;
            if (
              start < inputBytes.length ||
              (partIndex === 0 && inputBytes.length === 0)
            ) {
              const slice = inputBytes.subarray(
                start,
                Math.min(end, inputBytes.length)
              );
              await cdp.send(
                'Fetch.fulfillRequest',
                {
                  requestId,
                  responseCode: 200,
                  responseHeaders: [
                    { name: 'cache-control', value: 'no-store' },
                    {
                      name: 'content-type',
                      value:
                        options.inputMimetype ?? 'application/octet-stream',
                    },
                  ],
                  body: Buffer.from(slice).toString('base64'),
                },
                sessionId
              );
              return;
            }
          }
        }
      }
    } catch {
      // Malformed URL or unhandled error falls through to failRequest
    }
  }

  // Fallback branch: anything else -> Fetch.failRequest errorReason BlockedByClient
  await cdp.send(
    'Fetch.failRequest',
    {
      requestId,
      errorReason: 'BlockedByClient',
    },
    sessionId
  );
}

export function setupVirtualOrigin(
  cdp: CdpConnection,
  sessionId: string,
  options: VirtualOriginOptions
): () => void {
  return cdp.onEvent((event: CdpEvent) => {
    if (
      event.method === 'Fetch.requestPaused' &&
      event.sessionId === sessionId
    ) {
      handleRequestPaused(cdp, sessionId, event, options).catch(() => {});
    }
  });
}
