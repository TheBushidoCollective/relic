import { gunzipSync } from 'node:zlib';
import type { ArchiveEntry, ArchiveListing } from '@relic/format/cover';

export const ARCHIVE_LISTING_CAP = 200;
export const ARCHIVE_WALK_CAP_ENTRIES = 100_000;
export const ARCHIVE_WALK_CAP_BYTES = 1_073_741_824; // 1 GiB

export type ArchiveParseResult =
  | { readonly ok: true; readonly listing: ArchiveListing }
  | {
      readonly ok: false;
      readonly status: 'skipped';
      readonly reason: 'archive_format_unlisted';
      readonly detail: string;
    };

function isUnlistedArchiveMagic(bytes: Uint8Array): boolean {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0x42 &&
    bytes[1] === 0x5a &&
    bytes[2] === 0x68
  ) {
    // bzip2 (BZh)
    return true;
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0xfd &&
    bytes[1] === 0x37 &&
    bytes[2] === 0x7a &&
    bytes[3] === 0x58 &&
    bytes[4] === 0x5a &&
    bytes[5] === 0x00
  ) {
    // xz
    return true;
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x28 &&
    bytes[1] === 0xb5 &&
    bytes[2] === 0x2f &&
    bytes[3] === 0xfd
  ) {
    // zstd
    return true;
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x37 &&
    bytes[1] === 0x7a &&
    bytes[2] === 0xbc &&
    bytes[3] === 0xaf &&
    bytes[4] === 0x27 &&
    bytes[5] === 0x1c
  ) {
    // 7z
    return true;
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x72 &&
    bytes[3] === 0x21
  ) {
    // RAR
    return true;
  }
  return false;
}

function parseZip(bytes: Uint8Array): ArchiveListing | undefined {
  if (bytes.length < 22) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate EOCD signature 0x06054b50 searching backwards
  let eocdOffset = -1;
  const searchFloor = Math.max(0, bytes.length - 65535 - 22);
  for (let i = bytes.length - 22; i >= searchFloor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return undefined;

  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset + cdSize > bytes.length) return undefined;

  const entries: ArchiveEntry[] = [];
  let totalEntries: number | null = 0;
  let totalBytes: number | null = 0;
  let offset = cdOffset;
  const decoder = new TextDecoder('utf-8', { fatal: false });

  while (offset + 46 <= cdOffset + cdSize) {
    const signature = view.getUint32(offset, true);
    if (signature !== 0x02014b50) {
      break;
    }

    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const fileCommentLength = view.getUint16(offset + 32, true);
    const externalAttrs = view.getUint32(offset + 38, true);

    const nameOffset = offset + 46;
    if (nameOffset + fileNameLength > bytes.length) break;

    const pathBytes = bytes.subarray(nameOffset, nameOffset + fileNameLength);
    const path = decoder.decode(pathBytes);
    const isDir = path.endsWith('/') || (externalAttrs & 0x10) !== 0;

    if (entries.length < ARCHIVE_LISTING_CAP) {
      entries.push({
        path,
        size: isDir ? 0 : uncompressedSize,
        directory: isDir,
      });
    }

    if (totalEntries !== null && totalBytes !== null) {
      totalEntries++;
      totalBytes += isDir ? 0 : uncompressedSize;
      if (
        totalEntries >= ARCHIVE_WALK_CAP_ENTRIES ||
        totalBytes >= ARCHIVE_WALK_CAP_BYTES
      ) {
        totalEntries = null;
        totalBytes = null;
      }
    }

    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  return {
    format: 'zip',
    entries,
    totalEntries,
    totalBytes,
  };
}

function parseTar(
  bytes: Uint8Array,
  format: 'tar' | 'tar.gz' = 'tar'
): ArchiveListing | undefined {
  if (bytes.length < 512) return undefined;

  const entries: ArchiveEntry[] = [];
  let totalEntries: number | null = 0;
  let totalBytes: number | null = 0;
  let offset = 0;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const asciiDecoder = new TextDecoder('ascii');

  let pendingGnuLongName: string | undefined;
  let pendingPaxPath: string | undefined;

  let validBlocksSeen = 0;

  while (offset + 512 <= bytes.length) {
    let isZero = true;
    for (let i = 0; i < 512; i++) {
      if (bytes[offset + i] !== 0) {
        isZero = false;
        break;
      }
    }
    if (isZero) {
      // End of tar stream
      break;
    }

    const nameSlice = bytes.subarray(offset, offset + 100);
    let nameEnd = 0;
    while (nameEnd < 100 && nameSlice[nameEnd] !== 0) {
      nameEnd++;
    }
    const rawName = decoder.decode(nameSlice.subarray(0, nameEnd));

    const sizeSlice = bytes.subarray(offset + 124, offset + 136);
    const sizeStr = asciiDecoder.decode(sizeSlice).trim().replace(/\0.*$/, '');
    const size = sizeStr ? Number.parseInt(sizeStr, 8) : 0;

    const typeflagByte = bytes[offset + 156] ?? 0;
    const typeflag = String.fromCharCode(typeflagByte);

    const magicSlice = bytes.subarray(offset + 257, offset + 263);
    const isUstar =
      magicSlice[0] === 0x75 &&
      magicSlice[1] === 0x73 &&
      magicSlice[2] === 0x74 &&
      magicSlice[3] === 0x61 &&
      magicSlice[4] === 0x72;

    let fullPath = rawName;
    if (isUstar) {
      const prefixSlice = bytes.subarray(offset + 345, offset + 500);
      let prefixEnd = 0;
      while (prefixEnd < 155 && prefixSlice[prefixEnd] !== 0) {
        prefixEnd++;
      }
      if (prefixEnd > 0) {
        const prefix = decoder.decode(prefixSlice.subarray(0, prefixEnd));
        fullPath = `${prefix}/${rawName}`;
      }
    }

    const dataBlockBytes = Math.ceil(size / 512) * 512;
    const dataOffset = offset + 512;
    validBlocksSeen++;

    if (typeflag === 'L') {
      // GNU LongName
      if (dataOffset + size <= bytes.length) {
        const longNameSlice = bytes.subarray(dataOffset, dataOffset + size);
        let end = 0;
        while (end < size && longNameSlice[end] !== 0) end++;
        pendingGnuLongName = decoder.decode(longNameSlice.subarray(0, end));
      }
      offset = dataOffset + dataBlockBytes;
      continue;
    }

    if (typeflag === 'x' || typeflag === 'g') {
      // PAX extended header
      if (dataOffset + size <= bytes.length) {
        const paxText = decoder.decode(
          bytes.subarray(dataOffset, dataOffset + size)
        );
        for (const line of paxText.split('\n')) {
          const spaceIdx = line.indexOf(' ');
          if (spaceIdx !== -1) {
            const eqIdx = line.indexOf('=', spaceIdx);
            if (eqIdx !== -1) {
              const key = line.slice(spaceIdx + 1, eqIdx);
              const val = line.slice(eqIdx + 1);
              if (key === 'path') {
                pendingPaxPath = val;
              }
            }
          }
        }
      }
      offset = dataOffset + dataBlockBytes;
      continue;
    }

    if (pendingGnuLongName) {
      fullPath = pendingGnuLongName;
      pendingGnuLongName = undefined;
    } else if (pendingPaxPath) {
      fullPath = pendingPaxPath;
      pendingPaxPath = undefined;
    }

    const isDir = typeflag === '5' || fullPath.endsWith('/');

    if (entries.length < ARCHIVE_LISTING_CAP) {
      entries.push({
        path: fullPath,
        size: isDir ? 0 : size,
        directory: isDir,
      });
    }

    if (totalEntries !== null && totalBytes !== null) {
      totalEntries++;
      totalBytes += isDir ? 0 : size;
      if (
        totalEntries >= ARCHIVE_WALK_CAP_ENTRIES ||
        totalBytes >= ARCHIVE_WALK_CAP_BYTES
      ) {
        totalEntries = null;
        totalBytes = null;
      }
    }

    offset = dataOffset + dataBlockBytes;
  }

  if (validBlocksSeen === 0) return undefined;

  return {
    format,
    entries,
    totalEntries,
    totalBytes,
  };
}

function parseGzip(
  bytes: Uint8Array,
  fallbackFilename: string
): ArchiveListing | undefined {
  if (bytes.length < 10) return undefined;
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return undefined;

  let decompressed: Uint8Array;
  try {
    decompressed = gunzipSync(bytes, {
      maxOutputLength: ARCHIVE_WALK_CAP_BYTES,
    });
  } catch {
    // Exceeded maxOutputLength or corrupt gzip
    return undefined;
  }

  // Check if decompressed payload is a tar archive
  if (decompressed.length >= 262) {
    const magic = decompressed.subarray(257, 262);
    if (
      magic[0] === 0x75 &&
      magic[1] === 0x73 &&
      magic[2] === 0x74 &&
      magic[3] === 0x61 &&
      magic[4] === 0x72
    ) {
      const tarListing = parseTar(decompressed, 'tar.gz');
      if (tarListing) return tarListing;
    }
  }

  // Single-file gzip archive
  const flags = bytes[3] ?? 0;
  let offset = 10;
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > bytes.length) return undefined;
    const xlen = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
    offset += 2 + xlen;
  }

  let fname: string | undefined;
  if ((flags & 0x08) !== 0) {
    let nul = offset;
    while (nul < bytes.length && bytes[nul] !== 0) nul++;
    if (nul < bytes.length) {
      fname = new TextDecoder('utf-8', { fatal: false }).decode(
        bytes.subarray(offset, nul)
      );
    }
  }

  const path =
    fname ??
    (fallbackFilename.toLowerCase().endsWith('.gz')
      ? fallbackFilename.slice(0, -3)
      : 'unnamed');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isize =
    bytes.length >= 4
      ? view.getUint32(bytes.length - 4, true)
      : decompressed.length;

  return {
    format: 'gzip',
    entries: [
      {
        path,
        size: isize,
        directory: false,
      },
    ],
    totalEntries: 1,
    totalBytes: isize,
  };
}

export function parseArchiveListing(
  bytes: Uint8Array,
  filename: string
): ArchiveParseResult {
  if (isUnlistedArchiveMagic(bytes)) {
    return {
      ok: false,
      status: 'skipped',
      reason: 'archive_format_unlisted',
      detail: 'Archive format is not supported for cover generation',
    };
  }

  // Check zip magic
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05)
  ) {
    const zipListing = parseZip(bytes);
    if (zipListing) return { ok: true, listing: zipListing };
  }

  // Check gzip magic
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const gzListing = parseGzip(bytes, filename);
    if (gzListing) return { ok: true, listing: gzListing };
  }

  // Check tar
  const tarListing = parseTar(bytes, 'tar');
  if (tarListing) {
    return { ok: true, listing: tarListing };
  }

  return {
    ok: false,
    status: 'skipped',
    reason: 'archive_format_unlisted',
    detail: 'Unrecognized or unsupported archive format',
  };
}
