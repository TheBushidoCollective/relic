/**
 * Anchor resolution against decrypted relic content.
 *
 * An agent reading comments back needs more than a text description of
 * what a human marked. When a reviewer circles a defect on an image or
 * points at a phrase in a document, an agent that receives only the words
 * "a box in the upper left" or a detached quote has to guess where to look
 * and what to change.
 *
 * This module resolves comment anchors against the actual artifact bytes
 * by fetching the ciphertext once, decrypting it using the stored content
 * key, and extracting the pointed-at content:
 * - Quotes and text anchors: exact matching run with surrounding source context.
 * - Regions on images: a cropped view of the region and an annotated full view.
 * - Time moments and spans on video: extracted frame images at the timecode(s).
 * - Time moments on audio: timecode text notice that no frames exist.
 * - Pages on PDF: page number and quoted text, with a notice that server-side
 *   PDF rendering is omitted to avoid heavy client dependencies.
 * - Stage-relative pins: an honest notice that stage-relative pins cannot be
 *   resolved against artifact content with fidelity.
 * - Unsupported anchors: the declared kind preserved without dropping.
 */

import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AnchorRect,
  decodeKey,
  deriveRendererClass,
  type OpenedRelic,
  openRelic,
  type RendererClass,
} from '@relic/format';
import { boxPosition, type CommentRecord, formatTimecode } from './comments.ts';
import type { PublishDeps } from './publish.ts';
import { loadPublishState } from './state.ts';

/**
 * Maximum dimension in pixels for images returned in tool results.
 *
 * Images returned inline in MCP results consume the agent's context window.
 * Capping dimensions at 1200 pixels preserves fine visual detail (such as
 * product bevels, typography, and UI controls) while keeping base64 payload
 * sizes comfortably under 400 kilobytes per image, preventing context
 * exhaustion and avoiding downstream vision model downscaling artifacts.
 */
export const MAX_IMAGE_DIMENSION = 1200;

export interface ResolvedImageBlock {
  readonly type: 'image';
  readonly data: string;
  readonly mimeType: string;
}

export interface ResolvedTextBlock {
  readonly type: 'text';
  readonly text: string;
}

export type ContentBlock = ResolvedTextBlock | ResolvedImageBlock;

export type ResolvedAnchor =
  | {
      readonly kind: 'quote' | 'text';
      readonly status: 'resolved';
      readonly exact: string;
      readonly line: number;
      readonly context_before: string;
      readonly context_after: string;
    }
  | {
      readonly kind: 'quote' | 'text';
      readonly status: 'unresolvable';
      readonly explanation: string;
    }
  | {
      readonly kind: 'region';
      readonly status: 'resolved';
      readonly original_width: number;
      readonly original_height: number;
      readonly downscaled: boolean;
      readonly downscaled_width?: number | undefined;
      readonly downscaled_height?: number | undefined;
      readonly crop_box_pixels: {
        readonly x: number;
        readonly y: number;
        readonly w: number;
        readonly h: number;
      };
      readonly explanation?: string | undefined;
    }
  | {
      readonly kind: 'region';
      readonly status: 'unresolvable';
      readonly explanation: string;
    }
  | {
      readonly kind: 'time';
      readonly status: 'resolved';
      readonly t: number;
      readonly t_end?: number | undefined;
      readonly has_frames: boolean;
      readonly downscaled: boolean;
      readonly explanation?: string | undefined;
    }
  | {
      readonly kind: 'time';
      readonly status: 'unresolvable';
      readonly explanation: string;
      readonly t?: number | undefined;
      readonly t_end?: number | undefined;
      readonly has_frames?: boolean | undefined;
      readonly downscaled?: boolean | undefined;
    }
  | {
      readonly kind: 'page';
      readonly status: 'resolved' | 'unresolvable';
      readonly page: number;
      readonly explanation: string;
      readonly exact?: string | undefined;
      readonly rect?: AnchorRect | undefined;
    }
  | {
      readonly kind: 'pin';
      readonly status: 'unresolvable';
      readonly x: number;
      readonly y: number;
      readonly explanation: string;
    }
  | {
      readonly kind: 'unsupported';
      readonly status: 'unresolvable';
      readonly declared: string;
      readonly explanation: string;
    };

let cachedSystemFfmpeg: string | null | undefined;

/**
 * Reset cached ffmpeg path for test isolation.
 */
export function resetFfmpegCacheForTest(): void {
  cachedSystemFfmpeg = undefined;
}

/**
 * Locate the ffmpeg binary, or return undefined when it is absent.
 *
 * Treated as optional at runtime. Respects dependency overrides and
 * environment variable toggles before probing known system paths.
 */
export async function probeFfmpeg(
  deps?: PublishDeps
): Promise<string | undefined> {
  if (deps?.ffmpegPath === null) return undefined;
  if (typeof deps?.ffmpegPath === 'string') return deps.ffmpegPath;

  const env = process.env['RELIC_FFMPEG_PATH'];
  if (env === 'none' || env === 'disabled') return undefined;
  if (env) return env;

  if (cachedSystemFfmpeg !== undefined) {
    return cachedSystemFfmpeg ?? undefined;
  }

  const candidatePaths = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    'ffmpeg',
  ];

  for (const candidate of candidatePaths) {
    try {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const child = spawn(candidate, ['-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      const ok = await promise;
      if (ok) {
        cachedSystemFfmpeg = candidate;
        return candidate;
      }
    } catch {
      // Continue probing remaining candidate paths.
    }
  }

  cachedSystemFfmpeg = null;
  return undefined;
}

/**
 * Run ffmpeg with input bytes supplied through pipe:0, falling back to a
 * secure temporary file only when pipes fail on unseekable media.
 *
 * Plaintext bytes are kept in memory whenever possible. If ffmpeg cannot
 * seek within a piped stream (for instance, on certain MP4 files whose moov
 * atom sits at the end of the file), a temporary file is created with 0600
 * permissions in a private directory and deleted in a finally block.
 */
export async function runFfmpeg(
  ffmpegPath: string,
  args: readonly string[],
  inputBytes: Uint8Array
): Promise<Uint8Array> {
  try {
    return await runFfmpegPiped(ffmpegPath, args, inputBytes);
  } catch (pipeError) {
    if (!args.includes('pipe:0')) {
      throw pipeError;
    }
    return await runFfmpegTemp(ffmpegPath, args, inputBytes);
  }
}

function runFfmpegPiped(
  ffmpegPath: string,
  args: readonly string[],
  inputBytes: Uint8Array
): Promise<Uint8Array> {
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
  const child = spawn(ffmpegPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

  child.on('error', (err) => reject(err));

  child.on('close', (code) => {
    if (code !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    } else {
      resolve(new Uint8Array(Buffer.concat(stdoutChunks)));
    }
  });

  child.stdin.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
      reject(err);
    }
  });

  child.stdin.end(Buffer.from(inputBytes));
  return promise;
}

async function runFfmpegTemp(
  ffmpegPath: string,
  args: readonly string[],
  inputBytes: Uint8Array
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'relic-media-'));
  await chmod(dir, 0o700);
  const tempPath = join(dir, 'content.bin');
  try {
    await writeFile(tempPath, inputBytes, { mode: 0o600 });
    const adjustedArgs = args.map((arg) => (arg === 'pipe:0' ? tempPath : arg));

    const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
    const child = spawn(ffmpegPath, adjustedArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      } else {
        resolve(new Uint8Array(Buffer.concat(stdoutChunks)));
      }
    });
    return await promise;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Fast synchronous dimension extractor for standard image headers.
 *
 * Avoids spawning a child process when the dimensions can be parsed directly
 * from the first few bytes of the container payload.
 */
export function parseImageDimensions(
  bytes: Uint8Array
): { width: number; height: number } | undefined {
  // PNG: bytes 16..24 contain uint32 big-endian width and height.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) return { width, height };
  }

  // GIF: bytes 6..10 contain uint16 little-endian width and height.
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    if (width > 0 && height > 0) return { width, height };
  }

  // JPEG: scan markers for SOF0 (0xFFC0), SOF1 (0xFFC1), or SOF2 (0xFFC2).
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      // Skip fill bytes or restart markers
      if (
        marker === 0xff ||
        (marker !== undefined && marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0x01
      ) {
        offset += 1;
        continue;
      }
      if (marker === 0xd9) break; // EOI
      const segmentLength = view.getUint16(offset + 2, false);
      if (
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3 ||
        marker === 0xc5 ||
        marker === 0xc6 ||
        marker === 0xc7 ||
        marker === 0xc9 ||
        marker === 0xca ||
        marker === 0xcb
      ) {
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        if (width > 0 && height > 0) return { width, height };
      }
      offset += 2 + segmentLength;
    }
  }

  return undefined;
}

/**
 * Fallback dimension probe using ffmpeg stderr output when header parsing
 * does not recognise the format (such as WebP or video containers).
 */
export async function probeMediaDimensionsWithFfmpeg(
  ffmpegPath: string,
  bytes: Uint8Array
): Promise<{ width: number; height: number } | undefined> {
  try {
    const { promise, resolve } = Promise.withResolvers<
      { width: number; height: number } | undefined
    >();
    const child = spawn(ffmpegPath, ['-i', 'pipe:0', '-f', 'null', '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', () => resolve(undefined));
    child.on('close', () => {
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const match = stderr.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
      if (match?.[1] && match[2]) {
        const width = Number.parseInt(match[1], 10);
        const height = Number.parseInt(match[2], 10);
        if (width > 0 && height > 0) {
          resolve({ width, height });
          return;
        }
      }
      resolve(undefined);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(bytes));
    return await promise;
  } catch {
    return undefined;
  }
}

/**
 * Fetch and decrypt the container for one relic, exactly once.
 */
async function fetchAndDecryptRelic(
  relicId: string,
  deps: PublishDeps
): Promise<{ ok: true; opened: OpenedRelic } | { ok: false; error: string }> {
  const state = await loadPublishState(relicId);
  if (!state || !state.key) {
    return {
      ok: false,
      error:
        'No local publish state or decryption key found on this machine for this relic.',
    };
  }

  let mint: { url: string; object_length: number; version?: number };
  try {
    const mintResponse = await deps.fetch(
      `${deps.serviceOrigin}/api/relics/${relicId}/mint`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }
    );
    if (!mintResponse.ok) {
      if (mintResponse.status === 404 || mintResponse.status === 410) {
        return {
          ok: false,
          error:
            'Relic was not found or has expired on the service, so its content cannot be retrieved.',
        };
      }
      return {
        ok: false,
        error: `Failed to mint download URL: HTTP status ${mintResponse.status}.`,
      };
    }
    mint = (await mintResponse.json()) as {
      url: string;
      object_length: number;
      version?: number;
    };
  } catch (error) {
    return {
      ok: false,
      error: `Network error reaching relic service: ${(error as Error).message}.`,
    };
  }

  try {
    const containerResponse = await deps.fetch(mint.url);
    if (!containerResponse.ok) {
      return {
        ok: false,
        error: `Failed to fetch relic ciphertext: HTTP status ${containerResponse.status}.`,
      };
    }
    const containerBytes = new Uint8Array(
      await containerResponse.arrayBuffer()
    );
    const key = decodeKey(state.key);
    const opened = await openRelic(
      containerBytes,
      key,
      mint.version ?? state.version
    );
    return { ok: true, opened };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to decrypt relic content: ${(error as Error).message}.`,
    };
  }
}

/**
 * Locate a target string in text and select the occurrence matching prefix and suffix.
 */
function findTextOccurrence(
  fullText: string,
  target: string,
  prefix?: string,
  suffix?: string
): { matchIndex: number; line: number } | undefined {
  if (target.length === 0) return undefined;

  const candidates: number[] = [];
  let searchPos = 0;
  while (true) {
    const found = fullText.indexOf(target, searchPos);
    if (found === -1) break;
    candidates.push(found);
    searchPos = found + 1;
  }

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1 && candidates[0] !== undefined) {
    const matchIndex = candidates[0];
    const line = fullText.slice(0, matchIndex).split('\n').length;
    return { matchIndex, line };
  }

  let bestIndex = candidates[0] ?? 0;
  let bestScore = -1;

  for (const cand of candidates) {
    let score = 0;
    if (prefix && prefix.length > 0) {
      const before = fullText.slice(Math.max(0, cand - prefix.length), cand);
      if (before === prefix) {
        score += 2;
      } else if (before.endsWith(prefix) || prefix.endsWith(before)) {
        score += 1;
      }
    }
    if (suffix && suffix.length > 0) {
      const after = fullText.slice(
        cand + target.length,
        cand + target.length + suffix.length
      );
      if (after === suffix) {
        score += 2;
      } else if (after.startsWith(suffix) || suffix.startsWith(after)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = cand;
    }
  }

  const line = fullText.slice(0, bestIndex).split('\n').length;
  return { matchIndex: bestIndex, line };
}

/**
 * Resolve anchors on comments by fetching and decrypting the relic once.
 */
export async function resolveAnchors(
  relicId: string,
  comments: readonly CommentRecord[],
  deps: PublishDeps
): Promise<{
  readonly comments: readonly CommentRecord[];
  readonly imageBlocks: readonly ResolvedImageBlock[];
}> {
  if (comments.length === 0) {
    return { comments, imageBlocks: [] };
  }

  const hasAnyAnchor = comments.some((c) => c.readable && c.anchor !== null);

  // If no comment carries an anchor, avoid fetching or decrypting the relic.
  if (!hasAnyAnchor) {
    return { comments, imageBlocks: [] };
  }

  const fetchResult = await fetchAndDecryptRelic(relicId, deps);
  const updatedComments: CommentRecord[] = [];
  const imageBlocks: ResolvedImageBlock[] = [];

  if (!fetchResult.ok) {
    for (const comment of comments) {
      if (!comment.readable || comment.anchor === null) {
        updatedComments.push(comment);
        continue;
      }
      updatedComments.push({
        ...comment,
        resolved: {
          kind: comment.anchor.kind,
          status: 'unresolvable',
          explanation: fetchResult.error,
        } as ResolvedAnchor,
      });
    }
    return { comments: updatedComments, imageBlocks: [] };
  }

  const { opened } = fetchResult;
  const entry = opened.envelope.entries[0];
  const filename = entry?.filename ?? '';
  const mimetype = entry?.mimetype ?? '';
  const rendererClass: RendererClass = deriveRendererClass(
    opened.content,
    filename
  );

  const isImage =
    rendererClass === 'image' ||
    mimetype.startsWith('image/') ||
    /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(filename);

  const isAudio =
    mimetype.startsWith('audio/') ||
    /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(filename);

  const isVideo =
    mimetype.startsWith('video/') ||
    /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(filename) ||
    (rendererClass === 'media' && !isAudio);
  const isPdf =
    mimetype === 'application/pdf' ||
    /\.pdf$/i.test(filename) ||
    (opened.content.length >= 4 &&
      opened.content[0] === 0x25 &&
      opened.content[1] === 0x50 &&
      opened.content[2] === 0x44 &&
      opened.content[3] === 0x46);

  for (const comment of comments) {
    if (!comment.readable || comment.anchor === null) {
      updatedComments.push(comment);
      continue;
    }

    const { anchor } = comment;

    switch (anchor.kind) {
      case 'text':
      case 'quote': {
        const target = anchor.kind === 'text' ? anchor.quote : anchor.exact;
        const prefix = anchor.kind === 'quote' ? anchor.prefix : undefined;
        const suffix = anchor.kind === 'quote' ? anchor.suffix : undefined;

        if (isImage || isVideo || isAudio) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: anchor.kind,
              status: 'unresolvable',
              explanation: `A text quote anchor cannot be resolved against a ${rendererClass} relic.`,
            },
          });
          break;
        }

        const fullText = new TextDecoder('utf-8', { fatal: false }).decode(
          opened.content
        );
        const match = findTextOccurrence(fullText, target, prefix, suffix);

        if (!match) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: anchor.kind,
              status: 'unresolvable',
              explanation:
                'The quoted text was not found in the current relic content (it may have been edited or removed in a newer version).',
            },
          });
          break;
        }

        const contextBefore = fullText.slice(
          Math.max(0, match.matchIndex - 120),
          match.matchIndex
        );
        const contextAfter = fullText.slice(
          match.matchIndex + target.length,
          Math.min(fullText.length, match.matchIndex + target.length + 120)
        );

        updatedComments.push({
          ...comment,
          resolved: {
            kind: anchor.kind,
            status: 'resolved',
            exact: target,
            line: match.line,
            context_before: contextBefore,
            context_after: contextAfter,
          },
        });
        break;
      }

      case 'region': {
        if (!isImage) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'region',
              status: 'unresolvable',
              explanation: `Region anchor cannot be resolved against a non-image relic (type: ${rendererClass}).`,
            },
          });
          break;
        }

        const ffmpegPath = await probeFfmpeg(deps);
        if (!ffmpegPath) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'region',
              status: 'unresolvable',
              explanation: `ffmpeg is not available on this machine to process image regions. Region: ${boxPosition(anchor.rect)}.`,
            },
          });
          break;
        }

        let dims = parseImageDimensions(opened.content);
        if (!dims) {
          dims = await probeMediaDimensionsWithFfmpeg(
            ffmpegPath,
            opened.content
          );
        }

        if (!dims) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'region',
              status: 'unresolvable',
              explanation:
                'Could not determine image dimensions for region crop.',
            },
          });
          break;
        }

        const origW = dims.width;
        const origH = dims.height;
        const cropX = Math.max(
          0,
          Math.min(origW - 1, Math.round(anchor.rect.x * origW))
        );
        const cropY = Math.max(
          0,
          Math.min(origH - 1, Math.round(anchor.rect.y * origH))
        );
        const cropW = Math.max(
          1,
          Math.min(origW - cropX, Math.round(anchor.rect.w * origW))
        );
        const cropH = Math.max(
          1,
          Math.min(origH - cropY, Math.round(anchor.rect.h * origH))
        );

        const isDownscaled =
          origW > MAX_IMAGE_DIMENSION || origH > MAX_IMAGE_DIMENSION;

        try {
          const cropFilter = `crop=w=${cropW}:h=${cropH}:x=${cropX}:y=${cropY},scale='min(${MAX_IMAGE_DIMENSION},iw)':'min(${MAX_IMAGE_DIMENSION},ih)':force_original_aspect_ratio=decrease`;
          const cropBytes = await runFfmpeg(
            ffmpegPath,
            [
              '-i',
              'pipe:0',
              '-vf',
              cropFilter,
              '-frames:v',
              '1',
              '-f',
              'image2',
              '-c:v',
              'png',
              'pipe:1',
            ],
            opened.content
          );

          const boxThickness = Math.max(
            2,
            Math.round(Math.min(origW, origH) * 0.005)
          );
          const annotatedFilter = `drawbox=x=${cropX}:y=${cropY}:w=${cropW}:h=${cropH}:color=red:t=${boxThickness},scale='min(${MAX_IMAGE_DIMENSION},iw)':'min(${MAX_IMAGE_DIMENSION},ih)':force_original_aspect_ratio=decrease`;
          const annotatedBytes = await runFfmpeg(
            ffmpegPath,
            [
              '-i',
              'pipe:0',
              '-vf',
              annotatedFilter,
              '-frames:v',
              '1',
              '-f',
              'image2',
              '-c:v',
              'png',
              'pipe:1',
            ],
            opened.content
          );

          imageBlocks.push({
            type: 'image',
            data: Buffer.from(cropBytes).toString('base64'),
            mimeType: 'image/png',
          });

          imageBlocks.push({
            type: 'image',
            data: Buffer.from(annotatedBytes).toString('base64'),
            mimeType: 'image/png',
          });

          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'region',
              status: 'resolved',
              original_width: origW,
              original_height: origH,
              downscaled: isDownscaled,
              crop_box_pixels: {
                x: cropX,
                y: cropY,
                w: cropW,
                h: cropH,
              },
            },
          });
        } catch (error) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'region',
              status: 'unresolvable',
              explanation: `Failed to crop or annotate image with ffmpeg: ${(error as Error).message}.`,
            },
          });
        }
        break;
      }

      case 'time': {
        if (isAudio) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'time',
              status: 'unresolvable',
              t: anchor.t,
              t_end: anchor.t_end,
              has_frames: false,
              downscaled: false,
              explanation: `Audio relics have no visual frames to display. Timecode: ${formatTimecode(anchor.t)}${anchor.t_end !== undefined ? ` to ${formatTimecode(anchor.t_end)}` : ''}.`,
            },
          });
          break;
        }

        if (!isVideo) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'time',
              status: 'unresolvable',
              explanation: `Time anchor cannot be resolved against a non-video relic (type: ${rendererClass}).`,
            },
          });
          break;
        }

        const ffmpegPath = await probeFfmpeg(deps);
        if (!ffmpegPath) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'time',
              status: 'unresolvable',
              explanation: `ffmpeg is not available on this machine to extract video frames. Video timestamp: ${formatTimecode(anchor.t)}${anchor.t_end !== undefined ? ` to ${formatTimecode(anchor.t_end)}` : ''}.`,
            },
          });
          break;
        }

        const scaleFilter = `scale='min(${MAX_IMAGE_DIMENSION},iw)':'min(${MAX_IMAGE_DIMENSION},ih)':force_original_aspect_ratio=decrease`;

        try {
          const frame1Bytes = await runFfmpeg(
            ffmpegPath,
            [
              '-ss',
              String(anchor.t),
              '-i',
              'pipe:0',
              '-frames:v',
              '1',
              '-vf',
              scaleFilter,
              '-f',
              'image2',
              '-c:v',
              'png',
              'pipe:1',
            ],
            opened.content
          );

          if (!frame1Bytes || frame1Bytes.length === 0) {
            updatedComments.push({
              ...comment,
              resolved: {
                kind: 'time',
                status: 'unresolvable',
                explanation: `Timestamp ${formatTimecode(anchor.t)} could not be extracted (may be beyond video duration).`,
              },
            });
            break;
          }

          imageBlocks.push({
            type: 'image',
            data: Buffer.from(frame1Bytes).toString('base64'),
            mimeType: 'image/png',
          });

          if (anchor.t_end !== undefined) {
            try {
              const frame2Bytes = await runFfmpeg(
                ffmpegPath,
                [
                  '-ss',
                  String(anchor.t_end),
                  '-i',
                  'pipe:0',
                  '-frames:v',
                  '1',
                  '-vf',
                  scaleFilter,
                  '-f',
                  'image2',
                  '-c:v',
                  'png',
                  'pipe:1',
                ],
                opened.content
              );
              if (frame2Bytes && frame2Bytes.length > 0) {
                imageBlocks.push({
                  type: 'image',
                  data: Buffer.from(frame2Bytes).toString('base64'),
                  mimeType: 'image/png',
                });
              }
            } catch {
              // If span end frame fails, proceed with the first frame
            }
          }

          if (anchor.rect) {
            const frameDims = parseImageDimensions(frame1Bytes);
            if (frameDims) {
              const cropX = Math.max(
                0,
                Math.min(
                  frameDims.width - 1,
                  Math.round(anchor.rect.x * frameDims.width)
                )
              );
              const cropY = Math.max(
                0,
                Math.min(
                  frameDims.height - 1,
                  Math.round(anchor.rect.y * frameDims.height)
                )
              );
              const cropW = Math.max(
                1,
                Math.min(
                  frameDims.width - cropX,
                  Math.round(anchor.rect.w * frameDims.width)
                )
              );
              const cropH = Math.max(
                1,
                Math.min(
                  frameDims.height - cropY,
                  Math.round(anchor.rect.h * frameDims.height)
                )
              );
              const frameCropFilter = `crop=w=${cropW}:h=${cropH}:x=${cropX}:y=${cropY},scale='min(${MAX_IMAGE_DIMENSION},iw)':'min(${MAX_IMAGE_DIMENSION},ih)':force_original_aspect_ratio=decrease`;
              const frameCropBytes = await runFfmpeg(
                ffmpegPath,
                [
                  '-i',
                  'pipe:0',
                  '-vf',
                  frameCropFilter,
                  '-frames:v',
                  '1',
                  '-f',
                  'image2',
                  '-c:v',
                  'png',
                  'pipe:1',
                ],
                frame1Bytes
              );
              imageBlocks.push({
                type: 'image',
                data: Buffer.from(frameCropBytes).toString('base64'),
                mimeType: 'image/png',
              });
            }
          }

          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'time',
              status: 'resolved',
              t: anchor.t,
              t_end: anchor.t_end,
              has_frames: true,
              downscaled: false,
            },
          });
        } catch (error) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'time',
              status: 'unresolvable',
              explanation: `Failed to extract video frame at timestamp ${formatTimecode(anchor.t)}: ${(error as Error).message}.`,
            },
          });
        }
        break;
      }

      case 'page': {
        if (!isPdf) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'page',
              status: 'unresolvable',
              page: anchor.page,
              explanation: `Page anchor cannot be resolved against a non-PDF relic (type: ${rendererClass}).`,
            },
          });
          break;
        }

        updatedComments.push({
          ...comment,
          resolved: {
            kind: 'page',
            status: 'resolved',
            page: anchor.page,
            exact: anchor.exact,
            rect: anchor.rect,
            explanation: `PDF page ${anchor.page} (server-side PDF page rendering is omitted to avoid heavy client dependencies).${anchor.rect ? ` Region on page: ${boxPosition(anchor.rect)}.` : ''}`,
          },
        });
        break;
      }

      case 'pin': {
        updatedComments.push({
          ...comment,
          resolved: {
            kind: 'pin',
            status: 'unresolvable',
            x: anchor.x,
            y: anchor.y,
            explanation: `Stage-relative pin at (${Math.round(anchor.x * 100)}%, ${Math.round(anchor.y * 100)}%). Pins are placed relative to the viewer stage rather than the content itself, so they cannot be resolved against artifact content with fidelity.`,
          },
        });
        break;
      }

      case 'unsupported': {
        updatedComments.push({
          ...comment,
          resolved: {
            kind: 'unsupported',
            status: 'unresolvable',
            declared: anchor.declared,
            explanation: `Unsupported anchor kind "${anchor.declared}".`,
          },
        });
        break;
      }
    }
  }

  return { comments: updatedComments, imageBlocks };
}
