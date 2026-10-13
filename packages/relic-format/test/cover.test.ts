import { describe, expect, test } from 'bun:test';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  COVER_CAP_BYTES,
  COVER_CSS_HEIGHT,
  COVER_CSS_WIDTH,
  COVER_DEVICE_SCALE,
  COVER_HEIGHT,
  COVER_INPUT_PART_BYTES,
  COVER_KINDS,
  COVER_PAGE_PROTOCOL,
  COVER_TYPES,
  COVER_WIDTH,
  coverExtension,
  crc32,
  isCoverKind,
  validateCoverRaster,
} from '../src/cover.ts';

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const typeAndData = chunk.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(typeAndData));
  return chunk;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

function makeIhdr(
  width = COVER_WIDTH,
  height = COVER_HEIGHT,
  bitDepth = 8,
  colorType = 2,
  compression = 0,
  filter = 0,
  interlace = 0
): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = compression;
  data[11] = filter;
  data[12] = interlace;
  return makeChunk('IHDR', data);
}

function makeValidPng(colorType: 2 | 6 = 2): Uint8Array {
  const bpp = colorType === 2 ? 3 : 4;
  const rawPixels = new Uint8Array(COVER_HEIGHT * (1 + COVER_WIDTH * bpp));
  const idat = makeChunk('IDAT', deflateSync(rawPixels));
  const iend = makeChunk('IEND', new Uint8Array(0));
  return concat(
    PNG_SIGNATURE,
    makeIhdr(COVER_WIDTH, COVER_HEIGHT, 8, colorType),
    idat,
    iend
  );
}

function makeValidJpeg(): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00, // APP0 (JFIF)
    0xff,
    0xdb,
    0x00,
    0x43,
    0x00,
    ...new Array(64).fill(1), // DQT
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x02,
    0x76,
    0x04,
    0xb0,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00, // SOF0 (630x1200, 3 components)
    0xff,
    0xc4,
    0x00,
    0x1f,
    0x00,
    0x00,
    0x01,
    0x05,
    0x01,
    0x01,
    0x01,
    0x01,
    0x01,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01,
    0x02,
    0x03,
    0x04,
    0x05,
    0x06,
    0x07,
    0x08,
    0x09,
    0x0a,
    0x0b, // DHT
    0xff,
    0xda,
    0x00,
    0x0c,
    0x03,
    0x01,
    0x00,
    0x02,
    0x00,
    0x03,
    0x00,
    0x00,
    0x3f,
    0x00, // SOS
    0x12,
    0x34,
    0xff,
    0x00,
    0x56, // entropy with FF00 stuffing
    0xff,
    0xd9, // EOI
  ]);
}

const testInflate = (data: Uint8Array, maxOutputLength: number): Uint8Array =>
  inflateSync(data, { maxOutputLength });

describe('cover module constants and utilities', () => {
  test('exports exact cover dimensions and protocol constants', () => {
    expect(COVER_WIDTH).toBe(1200);
    expect(COVER_HEIGHT).toBe(630);
    expect(COVER_CSS_WIDTH).toBe(600);
    expect(COVER_CSS_HEIGHT).toBe(315);
    expect(COVER_DEVICE_SCALE).toBe(2);
    expect(COVER_CAP_BYTES).toBe(524_288);
    expect(COVER_PAGE_PROTOCOL).toBe(1);
    expect(COVER_INPUT_PART_BYTES).toBe(16_777_216);
  });

  test('isCoverKind identifies all 10 cover kinds and rejects others', () => {
    expect(COVER_KINDS).toEqual([
      'markdown',
      'code',
      'html',
      'jsx',
      'image',
      'pdf',
      'video',
      'audio-artwork',
      'audio-waveform',
      'archive',
    ]);
    for (const kind of COVER_KINDS) {
      expect(isCoverKind(kind)).toBe(true);
    }
    expect(isCoverKind('spreadsheet')).toBe(false);
    expect(isCoverKind('')).toBe(false);
    expect(isCoverKind(null)).toBe(false);
    expect(isCoverKind(123)).toBe(false);
  });

  test('coverExtension maps supported cover types and rejects others', () => {
    expect(COVER_TYPES).toEqual(['image/png', 'image/jpeg']);
    expect(coverExtension('image/png')).toBe('png');
    expect(coverExtension('image/jpeg')).toBe('jpg');
    expect(() =>
      coverExtension('image/webp' as unknown as 'image/png')
    ).toThrow();
  });

  test('crc32 computes IEEE 802.3 CRC32 correctly', () => {
    expect(crc32(new Uint8Array([]))).toBe(0);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('validateCoverRaster valid rasters', () => {
  test('validates 1200x630 PNG RGB raster', () => {
    const png = makeValidPng(2);
    const result = validateCoverRaster(png, testInflate);
    expect(result).toEqual({ ok: true, type: 'image/png' });
  });

  test('validates 1200x630 PNG RGBA raster', () => {
    const png = makeValidPng(6);
    const result = validateCoverRaster(png, testInflate);
    expect(result).toEqual({ ok: true, type: 'image/png' });
  });

  test('validates 1200x630 JPEG raster', () => {
    const jpeg = makeValidJpeg();
    const result = validateCoverRaster(jpeg, testInflate);
    expect(result).toEqual({ ok: true, type: 'image/jpeg' });
  });

  test('validates progressive JPEG with multiple scans and DHT', () => {
    const progressiveJpeg = new Uint8Array([
      0xff,
      0xd8, // SOI
      0xff,
      0xe0,
      0x00,
      0x10,
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00,
      0x01,
      0x01,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00, // APP0
      0xff,
      0xdb,
      0x00,
      0x43,
      0x00,
      ...new Array(64).fill(1), // DQT
      0xff,
      0xc2,
      0x00,
      0x11,
      0x08,
      0x02,
      0x76,
      0x04,
      0xb0,
      0x03,
      0x01,
      0x11,
      0x00,
      0x02,
      0x11,
      0x00,
      0x03,
      0x11,
      0x00, // SOF2 progressive (630x1200)
      0xff,
      0xc4,
      0x00,
      0x1f,
      0x00,
      0x00,
      0x01,
      0x05,
      0x01,
      0x01,
      0x01,
      0x01,
      0x01,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x02,
      0x03,
      0x04,
      0x05,
      0x06,
      0x07,
      0x08,
      0x09,
      0x0a,
      0x0b, // DHT
      0xff,
      0xda,
      0x00,
      0x0c,
      0x03,
      0x01,
      0x00,
      0x02,
      0x00,
      0x03,
      0x00,
      0x00,
      0x00,
      0x00, // Scan 1 SOS
      0x01,
      0x02, // entropy scan 1
      0xff,
      0xc4,
      0x00,
      0x1f,
      0x10,
      0x00,
      0x01,
      0x05,
      0x01,
      0x01,
      0x01,
      0x01,
      0x01,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x02,
      0x03,
      0x04,
      0x05,
      0x06,
      0x07,
      0x08,
      0x09,
      0x0a,
      0x0b, // DHT scan 2
      0xff,
      0xda,
      0x00,
      0x0c,
      0x03,
      0x01,
      0x00,
      0x02,
      0x00,
      0x03,
      0x00,
      0x01,
      0x3f,
      0x00, // Scan 2 SOS
      0x03,
      0x04, // entropy scan 2
      0xff,
      0xd9, // EOI
    ]);
    const result = validateCoverRaster(progressiveJpeg, testInflate);
    expect(result).toEqual({ ok: true, type: 'image/jpeg' });
  });

  test('validates JPEG with restart markers (RST0-7) and DRI', () => {
    const jpegWithDri = new Uint8Array([
      0xff,
      0xd8, // SOI
      0xff,
      0xe0,
      0x00,
      0x10,
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00,
      0x01,
      0x01,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00, // APP0
      0xff,
      0xdd,
      0x00,
      0x04,
      0x00,
      0x04, // DRI (restart interval = 4)
      0xff,
      0xdb,
      0x00,
      0x43,
      0x00,
      ...new Array(64).fill(1), // DQT
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x02,
      0x76,
      0x04,
      0xb0,
      0x03,
      0x01,
      0x11,
      0x00,
      0x02,
      0x11,
      0x00,
      0x03,
      0x11,
      0x00, // SOF0
      0xff,
      0xc4,
      0x00,
      0x1f,
      0x00,
      0x00,
      0x01,
      0x05,
      0x01,
      0x01,
      0x01,
      0x01,
      0x01,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x02,
      0x03,
      0x04,
      0x05,
      0x06,
      0x07,
      0x08,
      0x09,
      0x0a,
      0x0b, // DHT
      0xff,
      0xda,
      0x00,
      0x0c,
      0x03,
      0x01,
      0x00,
      0x02,
      0x00,
      0x03,
      0x00,
      0x00,
      0x3f,
      0x00, // SOS
      0x12,
      0xff,
      0xd0,
      0x34,
      0xff,
      0xd1,
      0x56, // entropy with RST0 and RST1
      0xff,
      0xd9, // EOI
    ]);
    const result = validateCoverRaster(jpegWithDri, testInflate);
    expect(result).toEqual({ ok: true, type: 'image/jpeg' });
  });
});

describe('validateCoverRaster rejections', () => {
  test('rejects PNG+ZIP polyglot via trailing bytes', () => {
    const validPng = makeValidPng();
    const zipTrailer = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    const polyglot = concat(validPng, zipTrailer);
    const result = validateCoverRaster(polyglot, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('trailing_data');
    }
  });

  test('rejects PNG with tEXt chunk', () => {
    const textChunk = makeChunk(
      'tEXt',
      new TextEncoder().encode('Comment=polyglot metadata')
    );
    const rawPixels = new Uint8Array(COVER_HEIGHT * (1 + COVER_WIDTH * 3));
    const idat = makeChunk('IDAT', deflateSync(rawPixels));
    const iend = makeChunk('IEND', new Uint8Array(0));
    const pngWithText = concat(
      PNG_SIGNATURE,
      makeIhdr(),
      textChunk,
      idat,
      iend
    );
    const result = validateCoverRaster(pngWithText, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('chunk');
    }
  });

  test('rejects PNG with dimensions 1200x631', () => {
    const rawPixels = new Uint8Array(631 * (1 + COVER_WIDTH * 3));
    const idat = makeChunk('IDAT', deflateSync(rawPixels));
    const iend = makeChunk('IEND', new Uint8Array(0));
    const png631 = concat(
      PNG_SIGNATURE,
      makeIhdr(COVER_WIDTH, 631),
      idat,
      iend
    );
    const result = validateCoverRaster(png631, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('dimensions');
    }
  });

  test('rejects interlaced PNG', () => {
    const rawPixels = new Uint8Array(COVER_HEIGHT * (1 + COVER_WIDTH * 3));
    const idat = makeChunk('IDAT', deflateSync(rawPixels));
    const iend = makeChunk('IEND', new Uint8Array(0));
    const interlacedPng = concat(
      PNG_SIGNATURE,
      makeIhdr(COVER_WIDTH, COVER_HEIGHT, 8, 2, 0, 0, 1),
      idat,
      iend
    );
    const result = validateCoverRaster(interlacedPng, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('structure');
    }
  });

  test('rejects 16-bit PNG', () => {
    const rawPixels = new Uint8Array(COVER_HEIGHT * (1 + COVER_WIDTH * 6));
    const idat = makeChunk('IDAT', deflateSync(rawPixels));
    const iend = makeChunk('IEND', new Uint8Array(0));
    const png16 = concat(
      PNG_SIGNATURE,
      makeIhdr(COVER_WIDTH, COVER_HEIGHT, 16, 2),
      idat,
      iend
    );
    const result = validateCoverRaster(png16, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('structure');
    }
  });

  test('rejects PNG with bad CRC', () => {
    const validPng = makeValidPng();
    const tampered = new Uint8Array(validPng);
    // Tamper with CRC byte of IHDR chunk (offset 8 + 13 + 8 = 29)
    tampered[29] = (tampered[29] ?? 0) ^ 0xff;
    const result = validateCoverRaster(tampered, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('crc');
    }
  });

  test('rejects oversized IDAT', () => {
    const rawPixelsOversized = new Uint8Array(
      COVER_HEIGHT * (1 + COVER_WIDTH * 3) + 1
    );
    const idat = makeChunk('IDAT', deflateSync(rawPixelsOversized));
    const iend = makeChunk('IEND', new Uint8Array(0));
    const oversizedPng = concat(PNG_SIGNATURE, makeIhdr(), idat, iend);
    const result = validateCoverRaster(oversizedPng, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('pixel_data');
    }
  });

  test('rejects PNG with invalid row filter byte', () => {
    const rawPixels = new Uint8Array(COVER_HEIGHT * (1 + COVER_WIDTH * 3));
    rawPixels[0] = 5; // Invalid filter byte on first row
    const idat = makeChunk('IDAT', deflateSync(rawPixels));
    const iend = makeChunk('IEND', new Uint8Array(0));
    const badFilterPng = concat(PNG_SIGNATURE, makeIhdr(), idat, iend);
    const result = validateCoverRaster(badFilterPng, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('pixel_data');
    }
  });

  test('rejects JPEG with COM marker', () => {
    const jpegWithCom = new Uint8Array([
      0xff,
      0xd8, // SOI
      0xff,
      0xfe,
      0x00,
      0x05,
      0x41,
      0x42,
      0x43, // COM marker
      0xff,
      0xc0,
      0x00,
      0x0b,
      0x08,
      0x02,
      0x76,
      0x04,
      0xb0,
      0x01,
      0x01,
      0x11,
      0x00, // SOF0
      0xff,
      0xda,
      0x00,
      0x08,
      0x01,
      0x01,
      0x00,
      0x00,
      0x3f,
      0x00, // SOS
      0x00,
      0xff,
      0xd9, // EOI
    ]);
    const result = validateCoverRaster(jpegWithCom, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('chunk');
    }
  });

  test('rejects JPEG with APP1 marker', () => {
    const jpegWithApp1 = new Uint8Array([
      0xff,
      0xd8, // SOI
      0xff,
      0xe1,
      0x00,
      0x06,
      0x45,
      0x78,
      0x69,
      0x66, // APP1 marker (Exif)
      0xff,
      0xc0,
      0x00,
      0x0b,
      0x08,
      0x02,
      0x76,
      0x04,
      0xb0,
      0x01,
      0x01,
      0x11,
      0x00, // SOF0
      0xff,
      0xda,
      0x00,
      0x08,
      0x01,
      0x01,
      0x00,
      0x00,
      0x3f,
      0x00, // SOS
      0x00,
      0xff,
      0xd9, // EOI
    ]);
    const result = validateCoverRaster(jpegWithApp1, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('chunk');
    }
  });

  test('rejects JPEG with bytes after EOI', () => {
    const validJpeg = makeValidJpeg();
    const trailingJpeg = concat(validJpeg, new Uint8Array([0x00, 0x01, 0x02]));
    const result = validateCoverRaster(trailingJpeg, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('trailing_data');
    }
  });

  test('rejects JPEG with wrong dimensions', () => {
    const wrongDimsJpeg = new Uint8Array([
      0xff,
      0xd8, // SOI
      0xff,
      0xc0,
      0x00,
      0x0b,
      0x08,
      0x02,
      0x58,
      0x04,
      0xb0,
      0x01,
      0x01,
      0x11,
      0x00, // 600x1200
      0xff,
      0xda,
      0x00,
      0x08,
      0x01,
      0x01,
      0x00,
      0x00,
      0x3f,
      0x00, // SOS
      0x00,
      0xff,
      0xd9, // EOI
    ]);
    const result = validateCoverRaster(wrongDimsJpeg, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('dimensions');
    }
  });

  test('rejects raster exceeding COVER_CAP_BYTES', () => {
    const oversized = new Uint8Array(COVER_CAP_BYTES + 1);
    const result = validateCoverRaster(oversized, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('size');
    }
  });

  test('rejects empty raster', () => {
    const empty = new Uint8Array(0);
    const result = validateCoverRaster(empty, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('size');
    }
  });

  test('rejects unknown signature', () => {
    const garbage = new Uint8Array([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
    ]);
    const result = validateCoverRaster(garbage, testInflate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('signature');
    }
  });
});
