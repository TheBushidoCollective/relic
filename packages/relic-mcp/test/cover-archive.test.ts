import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import {
  ARCHIVE_LISTING_CAP,
  parseArchiveListing,
} from '../src/cover/archive.ts';

function makeZip(
  files: Array<{ path: string; content?: Uint8Array; isDir?: boolean }>
): Uint8Array {
  const fileRecords: Uint8Array[] = [];
  const cdRecords: Uint8Array[] = [];
  let localOffset = 0;

  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.path);
    const data = f.content ?? new Uint8Array(0);
    const isDir = f.isDir ?? f.path.endsWith('/');

    // Local file header: 30 bytes + name + data
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method 0 (stored)
    lv.setUint32(14, 0, true); // crc
    lv.setUint32(18, data.length, true); // comp size
    lv.setUint32(22, data.length, true); // uncomp size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra len
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    fileRecords.push(local);

    // Central directory header: 46 bytes + name
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, isDir ? 0x10 : 0, true); // external attrs
    cv.setUint32(42, localOffset, true);
    cd.set(nameBytes, 46);
    cdRecords.push(cd);

    localOffset += local.length;
  }

  const cdTotalSize = cdRecords.reduce((sum, r) => sum + r.length, 0);

  // EOCD: 22 bytes
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdTotalSize, true);
  ev.setUint32(16, localOffset, true);
  ev.setUint16(20, 0, true);

  const totalLength = localOffset + cdTotalSize + 22;
  const out = new Uint8Array(totalLength);
  let pos = 0;
  for (const r of fileRecords) {
    out.set(r, pos);
    pos += r.length;
  }
  for (const r of cdRecords) {
    out.set(r, pos);
    pos += r.length;
  }
  out.set(eocd, pos);
  return out;
}

function makeTarBlock(
  path: string,
  content: Uint8Array = new Uint8Array(0),
  isDir = false
): Uint8Array {
  const header = new Uint8Array(512);
  const nameBytes = new TextEncoder().encode(path);
  header.set(nameBytes.subarray(0, 100), 0);

  // Mode: 0000644
  header.set(new TextEncoder().encode('0000644\0'), 100);
  // UID/GID
  header.set(new TextEncoder().encode('0000000\0'), 108);
  header.set(new TextEncoder().encode('0000000\0'), 116);
  // Size in octal
  const sizeOctal = `${content.length.toString(8).padStart(11, '0')} `;
  header.set(new TextEncoder().encode(sizeOctal), 124);
  // Mtime
  header.set(new TextEncoder().encode('00000000000 '), 136);
  // Typeflag
  header[156] = isDir ? 0x35 : 0x30; // '5' or '0'
  // Magic ustar\0
  header.set(new Uint8Array([0x75, 0x73, 0x74, 0x61, 0x72, 0x00]), 257);
  header.set(new Uint8Array([0x30, 0x30]), 263);

  // Checksum calculation
  header.fill(0x20, 148, 156); // 8 spaces
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i] ?? 0;
  }
  const chkStr = `${checksum.toString(8).padStart(6, '0')}\0 `;
  header.set(new TextEncoder().encode(chkStr), 148);

  const dataBlocks = Math.ceil(content.length / 512) * 512;
  const out = new Uint8Array(512 + dataBlocks);
  out.set(header, 0);
  out.set(content, 512);
  return out;
}

function makeTar(
  entries: Array<{ path: string; content?: Uint8Array; isDir?: boolean }>
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    blocks.push(makeTarBlock(e.path, e.content, e.isDir));
  }
  // Two 512-byte zero blocks at end of tar
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, b) => sum + b.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const b of blocks) {
    out.set(b, pos);
    pos += b.length;
  }
  return out;
}

describe('cover-archive', () => {
  test('parses zip archive central directory', () => {
    const zipBytes = makeZip([
      { path: 'src/', isDir: true },
      {
        path: 'src/index.ts',
        content: new TextEncoder().encode('console.log(1);'),
      },
      { path: 'README.md', content: new TextEncoder().encode('# Test') },
    ]);

    const res = parseArchiveListing(zipBytes, 'test.zip');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.listing.format).toBe('zip');
      expect(res.listing.totalEntries).toBe(3);
      expect(res.listing.totalBytes).toBe(15 + 6);
      expect(res.listing.entries.length).toBe(3);
      expect(res.listing.entries[0]?.path).toBe('src/');
      expect(res.listing.entries[0]?.directory).toBe(true);
      expect(res.listing.entries[1]?.path).toBe('src/index.ts');
      expect(res.listing.entries[1]?.directory).toBe(false);
      expect(res.listing.entries[2]?.path).toBe('README.md');
    }
  });

  test('parses tar ustar archive', () => {
    const tarBytes = makeTar([
      { path: 'docs/', isDir: true },
      {
        path: 'docs/spec.txt',
        content: new TextEncoder().encode('Specification'),
      },
    ]);

    const res = parseArchiveListing(tarBytes, 'test.tar');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.listing.format).toBe('tar');
      expect(res.listing.totalEntries).toBe(2);
      expect(res.listing.entries.length).toBe(2);
      expect(res.listing.entries[0]?.path).toBe('docs/');
      expect(res.listing.entries[0]?.directory).toBe(true);
      expect(res.listing.entries[1]?.path).toBe('docs/spec.txt');
      expect(res.listing.entries[1]?.size).toBe(13);
    }
  });

  test('parses tar.gz archive as tar.gz format with tar entries', () => {
    const tarBytes = makeTar([
      { path: 'file1.txt', content: new TextEncoder().encode('hello') },
      { path: 'file2.txt', content: new TextEncoder().encode('world') },
    ]);
    const gzBytes = gzipSync(tarBytes);

    const res = parseArchiveListing(gzBytes, 'bundle.tar.gz');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.listing.format).toBe('tar.gz');
      expect(res.listing.totalEntries).toBe(2);
      expect(res.listing.entries.length).toBe(2);
      expect(res.listing.entries[0]?.path).toBe('file1.txt');
      expect(res.listing.entries[1]?.path).toBe('file2.txt');
    }
  });

  test('parses single-file gzip archive', () => {
    const content = new TextEncoder().encode('plain text content inside gzip');
    const gzBytes = gzipSync(content);

    const res = parseArchiveListing(gzBytes, 'data.csv.gz');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.listing.format).toBe('gzip');
      expect(res.listing.totalEntries).toBe(1);
      expect(res.listing.totalBytes).toBe(content.length);
      expect(res.listing.entries.length).toBe(1);
      expect(res.listing.entries[0]?.path).toBe('data.csv');
      expect(res.listing.entries[0]?.size).toBe(content.length);
      expect(res.listing.entries[0]?.directory).toBe(false);
    }
  });

  test('caps listing at ARCHIVE_LISTING_CAP but counts total entries', () => {
    const files: Array<{ path: string }> = [];
    for (let i = 0; i < 250; i++) {
      files.push({ path: `file_${i.toString().padStart(3, '0')}.txt` });
    }
    const zipBytes = makeZip(files);

    const res = parseArchiveListing(zipBytes, 'many.zip');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.listing.totalEntries).toBe(250);
      expect(res.listing.entries.length).toBe(ARCHIVE_LISTING_CAP);
      expect(res.listing.entries[0]?.path).toBe('file_000.txt');
      expect(res.listing.entries[199]?.path).toBe('file_199.txt');
    }
  });

  test('skips with archive_format_unlisted for xz, bzip2, 7z, and unknown binary', () => {
    // xz magic
    const xzBytes = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 1, 2]);
    const xzRes = parseArchiveListing(xzBytes, 'archive.xz');
    expect(xzRes.ok).toBe(false);
    if (!xzRes.ok) {
      expect(xzRes.reason).toBe('archive_format_unlisted');
    }

    // bzip2 magic
    const bzBytes = new Uint8Array([0x42, 0x5a, 0x68, 0x39, 1, 2]);
    const bzRes = parseArchiveListing(bzBytes, 'archive.bz2');
    expect(bzRes.ok).toBe(false);
    if (!bzRes.ok) {
      expect(bzRes.reason).toBe('archive_format_unlisted');
    }

    // 7z magic
    const sevenZBytes = new Uint8Array([
      0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0,
    ]);
    const sevenZRes = parseArchiveListing(sevenZBytes, 'archive.7z');
    expect(sevenZRes.ok).toBe(false);
    if (!sevenZRes.ok) {
      expect(sevenZRes.reason).toBe('archive_format_unlisted');
    }

    // random binary noise
    const noise = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44]);
    const noiseRes = parseArchiveListing(noise, 'unknown.bin');
    expect(noiseRes.ok).toBe(false);
    if (!noiseRes.ok) {
      expect(noiseRes.reason).toBe('archive_format_unlisted');
    }
  });
});
