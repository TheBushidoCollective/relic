/**
 * Per-relic cover upload to the app server.
 *
 * Authorized by the publish token in the JSON body, matching the republish
 * precedent. Sent after the ciphertext PUT and reportComplete, so a failed
 * publish never leaves a plaintext cover behind.
 *
 * Never throws: an upload failure must never fail the publish. Errors are
 * mapped onto CoverReport skipped variants according to cause.
 */

import { inflateSync } from 'node:zlib';
import {
  type CoverKind,
  type CoverReport,
  type CoverType,
  validateCoverRaster,
} from '@relic/format/cover';

const inflate = (data: Uint8Array, maxOutputLength: number): Uint8Array =>
  inflateSync(data, { maxOutputLength });

import { ServerRefusal } from '../publish.ts';

export interface UploadCoverDeps {
  readonly serviceOrigin: string;
  readonly fetch: typeof globalThis.fetch;
}

export interface UploadCoverParams {
  readonly relicId: string;
  readonly publishToken: string;
  readonly version: number;
  readonly kind: CoverKind;
  readonly type: CoverType;
  readonly bytes: Uint8Array;
}

/**
 * Upload a validated cover image to the service.
 *
 * Never throws. On 200 with cover_url, returns an uploaded report. Any server
 * refusal, 404, network error, or timeout is caught and returned as a skipped
 * report with the appropriate reason and detail.
 */
export async function uploadCover(
  deps: UploadCoverDeps,
  params: UploadCoverParams
): Promise<CoverReport> {
  try {
    const validation = validateCoverRaster(params.bytes, inflate);
    if (!validation.ok) {
      return {
        status: 'skipped',
        reason: 'render_failed',
        detail: `invalid cover raster: ${validation.failure}`,
      };
    }
    if (validation.type !== params.type) {
      return {
        status: 'skipped',
        reason: 'render_failed',
        detail: `declared cover type ${params.type} does not match detected ${validation.type}`,
      };
    }

    const url = `${deps.serviceOrigin}/api/relics/${params.relicId}/cover`;
    const response = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publish_token: params.publishToken,
        version: params.version,
        kind: params.kind,
        type: params.type,
        data: Buffer.from(params.bytes).toString('base64'),
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const parsed = await response.json().catch(() => undefined);
      const problem =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      const code = String(problem['code'] ?? 'unknown');
      if (response.status === 404 && code === 'unknown') {
        return {
          status: 'skipped',
          reason: 'service_unsupported',
          detail: `the service at ${deps.serviceOrigin} does not accept cover images (HTTP 404)`,
        };
      }
      const detail = String(problem['detail'] ?? code);
      return {
        status: 'skipped',
        reason: 'service_refused',
        detail: `${code}: ${detail}`,
      };
    }

    const parsed = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const coverUrl = parsed['cover_url'];
    if (typeof coverUrl !== 'string' || coverUrl.length === 0) {
      return {
        status: 'skipped',
        reason: 'service_refused',
        detail: 'response_invalid: missing cover_url in response',
      };
    }

    return {
      status: 'uploaded',
      kind: params.kind,
      type: params.type,
      url: coverUrl,
      bytes: params.bytes.length,
    };
  } catch (error) {
    if (error instanceof ServerRefusal) {
      if (error.status === 404 && error.code === 'unknown') {
        return {
          status: 'skipped',
          reason: 'service_unsupported',
          detail: `the service at ${deps.serviceOrigin} does not accept cover images (HTTP 404)`,
        };
      }
      const code = error.code;
      const detail = String(error.problem['detail'] ?? error.message);
      return {
        status: 'skipped',
        reason: 'service_refused',
        detail: `${code}: ${detail}`,
      };
    }
    return {
      status: 'skipped',
      reason: 'upload_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
