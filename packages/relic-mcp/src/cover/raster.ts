import { inflateSync } from 'node:zlib';
import {
  COVER_CAP_BYTES,
  type CoverKind,
  type CoverOutcome,
  type CoverValidation,
  validateCoverRaster,
} from '@relic/format/cover';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function normalizePng(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 8) return bytes;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return bytes;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  const keptChunks: Uint8Array[] = [bytes.subarray(0, 8)];

  while (offset + 12 <= bytes.length) {
    const chunkLength = view.getUint32(offset);
    const chunkTotalLength = 12 + chunkLength;
    if (offset + chunkTotalLength > bytes.length) {
      break;
    }
    const b4 = bytes[offset + 4] ?? 0;
    const b5 = bytes[offset + 5] ?? 0;
    const b6 = bytes[offset + 6] ?? 0;
    const b7 = bytes[offset + 7] ?? 0;
    const typeStr = String.fromCharCode(b4, b5, b6, b7);
    if (typeStr === 'IHDR' || typeStr === 'IDAT' || typeStr === 'IEND') {
      keptChunks.push(bytes.subarray(offset, offset + chunkTotalLength));
    }
    offset += chunkTotalLength;
    if (typeStr === 'IEND') {
      break;
    }
  }

  const totalLength = keptChunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of keptChunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

export function normalizeJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return bytes;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keptChunks: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      break;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset++;
    }
    if (offset >= bytes.length) break;

    const marker = bytes[offset++];
    if (marker === undefined) break;
    if (marker === 0xda) {
      keptChunks.push(bytes.subarray(offset - 2));
      break;
    }

    if (offset + 2 > bytes.length) break;
    const len = view.getUint16(offset);
    if (len < 2 || offset + len > bytes.length) break;

    const isApp = marker >= 0xe1 && marker <= 0xef;
    const isCom = marker === 0xfe;
    if (isApp || isCom) {
      offset += len;
    } else {
      keptChunks.push(bytes.subarray(offset - 2, offset + len));
      offset += len;
    }
  }

  const totalLength = keptChunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of keptChunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

export function validateRaster(bytes: Uint8Array): CoverValidation {
  return validateCoverRaster(bytes, (data, maxOutputLength) =>
    inflateSync(data, { maxOutputLength })
  );
}

export type ScreenshotCapturer = (options: {
  format: 'png' | 'jpeg';
  quality?: number;
}) => Promise<Uint8Array>;

export async function executeEncodeLadder(
  capture: ScreenshotCapturer,
  kind: CoverKind
): Promise<CoverOutcome> {
  // Step 1: PNG capture
  const rawPng = await capture({ format: 'png' });
  const png = normalizePng(rawPng);
  if (png.length <= COVER_CAP_BYTES) {
    const pngVal = validateRaster(png);
    if (!pngVal.ok) {
      return {
        status: 'skipped',
        reason: 'render_failed',
        detail: `Cover raster validation failed on PNG: ${pngVal.detail}`,
      };
    }
    return {
      status: 'rendered',
      kind,
      type: 'image/png',
      bytes: png,
    };
  }

  // Step 2: JPEG q85 capture
  const rawJpeg85 = await capture({ format: 'jpeg', quality: 85 });
  const jpeg85 = normalizeJpeg(rawJpeg85);
  if (jpeg85.length <= COVER_CAP_BYTES) {
    const jpeg85Val = validateRaster(jpeg85);
    if (!jpeg85Val.ok) {
      return {
        status: 'skipped',
        reason: 'render_failed',
        detail: `Cover raster validation failed on JPEG q85: ${jpeg85Val.detail}`,
      };
    }
    return {
      status: 'rendered',
      kind,
      type: 'image/jpeg',
      bytes: jpeg85,
    };
  }

  // Step 3: JPEG q70 capture
  const rawJpeg70 = await capture({ format: 'jpeg', quality: 70 });
  const jpeg70 = normalizeJpeg(rawJpeg70);
  if (jpeg70.length <= COVER_CAP_BYTES) {
    const jpeg70Val = validateRaster(jpeg70);
    if (!jpeg70Val.ok) {
      return {
        status: 'skipped',
        reason: 'render_failed',
        detail: `Cover raster validation failed on JPEG q70: ${jpeg70Val.detail}`,
      };
    }
    return {
      status: 'rendered',
      kind,
      type: 'image/jpeg',
      bytes: jpeg70,
    };
  }

  // Step 4: Over size budget
  return {
    status: 'skipped',
    reason: 'over_size_budget',
    detail: 'Cover image exceeded size budget after JPEG compression',
  };
}
