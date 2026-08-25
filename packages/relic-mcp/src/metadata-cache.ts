/**
 * Names recovered from relics, remembered so recovery is paid for once.
 *
 * A relic's filename lives inside its encrypted envelope, and reading it
 * costs one of that relic's finite opens: the download cap is a cost control
 * and waiting never refills it. The name cannot change without a new version,
 * so re-reading it on every listing would spend a recipient's budget to learn
 * something this machine already knew.
 *
 * **This is a cache and never a record.** Every entry is derivable from the
 * relic plus the key in publish state, so deleting this file costs one round
 * of recovery and nothing else. It is deliberately a separate file from the
 * publish state, which holds the only copy of every relic's key and publish
 * token: that file is read-modify-written whole with no lock between client
 * processes, so a read tool that wrote to it could drop an entry and take a
 * relic's republish rights with it. Losing a cached filename costs 64 KB.
 *
 * It holds no key and no token. Filenames are not secret to the person who
 * published them, but they do describe the publisher's work, so the file
 * carries the same 0600 permissions as its neighbour rather than being left
 * world readable in a home directory.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { publishStatePath } from './state.ts';

export interface RecoveredMetadata {
  /**
   * The version the name was read from. A republish writes a new envelope, so
   * an entry recovered at an older version is stale and gets re-read rather
   * than reported as current.
   */
  readonly version: number;
  readonly filename: string;
  readonly mimetype: string;
  readonly content_bytes: number;
}

/**
 * Beside the publish state, wherever that is.
 *
 * Derived from it rather than resolved independently, so a test or a user who
 * redirects one has redirected both, and a cache can never be read against a
 * different machine's state file.
 */
export function metadataCachePath(): string {
  const override = process.env['RELIC_METADATA_CACHE'];
  if (override !== undefined && override.length > 0) return override;
  return join(dirname(publishStatePath()), 'metadata-cache.json');
}

/**
 * Load the cache, treating every failure as an empty one.
 *
 * A damaged cache must never break a listing. The worst case of ignoring it
 * is that recovery runs again, which is the cost this file exists to avoid
 * and not a correctness problem; the worst case of trusting a half-parsed one
 * is a wrong filename reported as fact.
 */
export async function loadCachedMetadata(): Promise<
  Readonly<Record<string, RecoveredMetadata>>
> {
  let raw: string;
  try {
    raw = await readFile(metadataCachePath(), 'utf8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const relics = (parsed as Record<string, unknown>)['relics'];
  if (relics === null || typeof relics !== 'object' || Array.isArray(relics)) {
    return {};
  }

  const out: Record<string, RecoveredMetadata> = {};
  for (const [relicId, entry] of Object.entries(
    relics as Record<string, unknown>
  )) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const version = row['version'];
    const filename = row['filename'];
    const mimetype = row['mimetype'];
    const contentBytes = row['content_bytes'];
    if (
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      typeof filename !== 'string' ||
      typeof mimetype !== 'string' ||
      typeof contentBytes !== 'number'
    ) {
      continue;
    }
    out[relicId] = {
      version,
      filename,
      mimetype,
      content_bytes: contentBytes,
    };
  }
  return out;
}

/**
 * Merge newly recovered names in, keeping every other entry.
 *
 * A write failure is swallowed on purpose. The names are already in the
 * caller's hands and its answer is complete without this; refusing the whole
 * listing because a cache could not be written would trade the thing the
 * caller asked for against an optimization.
 */
export async function saveCachedMetadata(
  recovered: Readonly<Record<string, RecoveredMetadata>>
): Promise<void> {
  if (Object.keys(recovered).length === 0) return;
  const path = metadataCachePath();
  try {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const existing = await loadCachedMetadata();
    const next = { relics: { ...existing, ...recovered } };
    // Temp then rename, like the state file: a crash mid-write leaves the
    // previous cache rather than a torn one that parses as empty.
    const temp = `${path}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, path);
  } catch {
    // Deliberately swallowed; see the note above.
  }
}
