/**
 * A RelicStore backed by Google Cloud Storage.
 *
 * The server previously ran on `MemoryStore` in production, which meant a
 * relic existed only inside the instance that minted it. It did not survive a
 * new revision, a scale to zero, or a request routed to a sibling instance.
 * The ciphertext was durable the whole time; the row that made it reachable
 * was not, so publishing produced links that worked until they abruptly did
 * not.
 *
 * GCS rather than a database, because the deployment already has a bucket, an
 * attached identity, and no other stateful dependency. Adding one would mean
 * new infrastructure, new IAM, and a second thing to be down. The cost is that
 * a counter has to be built out of compare-and-swap instead of being handed to
 * us, which `consumeMint` does below with `ifGenerationMatch`.
 *
 * Every method here is a network call. That is a real latency cost against the
 * previous in-memory reads, and it is the price of the relic still being there
 * on the second request.
 */

import type { RendererClass } from '@relic/format';

import type {
  AbuseReport,
  AuthLinkRow,
  CommentRow,
  DedupEntry,
  MintLogEntry,
  RelicRow,
  RelicStore,
  SessionRow,
  Tombstone,
} from './store.ts';

export interface GcsStoreOptions {
  readonly bucket: string;
  /** Key prefix for metadata objects. Kept clear of the ciphertext prefix. */
  readonly prefix?: string;
  readonly getAccessToken: () => Promise<string>;
  readonly host?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Retries for a contended compare-and-swap. */
  readonly casAttempts?: number;
}

const DEFAULT_HOST = 'https://storage.googleapis.com';

/** A document plus the generation it was read at, for compare-and-swap. */
interface Versioned<T> {
  readonly value: T;
  readonly generation: string;
}

export function gcsStore(options: GcsStoreOptions): RelicStore {
  const host = options.host ?? DEFAULT_HOST;
  const doFetch = options.fetch ?? globalThis.fetch;
  const prefix = (options.prefix ?? 'm').replace(/^\/+|\/+$/g, '');
  const casAttempts = options.casAttempts ?? 5;

  const key = (...parts: readonly string[]): string =>
    [prefix, ...parts].join('/');

  async function authorized(
    url: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const token = await options.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return doFetch(url, { ...init, headers });
  }

  /**
   * Read a document and the generation it was read at.
   *
   * A missing object is `undefined` rather than an error: "no such relic" is
   * an ordinary answer here, not a failure.
   */
  async function get<T>(name: string): Promise<Versioned<T> | undefined> {
    const url =
      `${host}/storage/v1/b/${encodeURIComponent(options.bucket)}` +
      `/o/${encodeURIComponent(name)}?alt=media`;

    const response = await authorized(url);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `gcs get ${name} returned ${response.status}: ${await response.text()}`
      );
    }

    // The generation of the bytes just read. Writing back with it as a
    // precondition is what makes a read-modify-write safe against a concurrent
    // instance doing the same thing.
    const generation = response.headers.get('x-goog-generation') ?? '';
    return { value: (await response.json()) as T, generation };
  }

  /**
   * Write a document, optionally only if it is still at `generation`.
   *
   * `ifGenerationMatch=0` means "only if it does not exist", which is how a
   * create is distinguished from an overwrite.
   */
  async function put(
    name: string,
    body: unknown,
    generation?: string
  ): Promise<boolean> {
    const params = new URLSearchParams({ uploadType: 'media', name });
    if (generation !== undefined) {
      params.set('ifGenerationMatch', generation);
    }

    const url =
      `${host}/upload/storage/v1/b/${encodeURIComponent(options.bucket)}/o` +
      `?${params.toString()}`;

    const response = await authorized(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Somebody else wrote first. The caller decides whether to retry or to
    // treat losing the race as the answer.
    if (response.status === 412) return false;

    if (!response.ok) {
      throw new Error(
        `gcs put ${name} returned ${response.status}: ${await response.text()}`
      );
    }
    return true;
  }

  async function remove(name: string): Promise<void> {
    const url =
      `${host}/storage/v1/b/${encodeURIComponent(options.bucket)}` +
      `/o/${encodeURIComponent(name)}`;
    const response = await authorized(url, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`gcs delete ${name} returned ${response.status}`);
    }
  }

  /** Every object under a prefix, following pagination to the end. */
  async function list<T>(under: string): Promise<readonly T[]> {
    const names: string[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ prefix: under });
      if (pageToken !== undefined) params.set('pageToken', pageToken);

      const url =
        `${host}/storage/v1/b/${encodeURIComponent(options.bucket)}/o` +
        `?${params.toString()}`;

      const response = await authorized(url);
      if (!response.ok) {
        throw new Error(`gcs list ${under} returned ${response.status}`);
      }

      const body = (await response.json()) as {
        items?: readonly { name: string }[];
        nextPageToken?: string;
      };
      for (const item of body.items ?? []) names.push(item.name);
      pageToken = body.nextPageToken;
    } while (pageToken !== undefined);

    const docs = await Promise.all(names.map((name) => get<T>(name)));
    return docs
      .filter((d): d is Versioned<T> => d !== undefined)
      .map((d) => d.value);
  }

  return {
    async getRelic(id: string): Promise<RelicRow | undefined> {
      return (await get<RelicRow>(key('relic', `${id}.json`)))?.value;
    },

    async putRelic(row: RelicRow): Promise<void> {
      await put(key('relic', `${row.id}.json`), row);
    },

    async markPublished(
      id: string,
      at: number,
      objectLength: number,
      crc32c: string
    ): Promise<void> {
      await mutateRelic(id, (row) => ({
        ...row,
        publishedAt: at,
        objectLength,
        objectCrc32c: crc32c,
      }));
    },

    /**
     * Opening a version is a read-modify-write like any other, so it rides
     * the same generation-checked retry. Two instances granting a
     * republish concurrently must not both hand out the same `v{n}`.
     */
    async beginVersion(
      id: string,
      rendererClass: RendererClass,
      declaredSizeBytes: number,
      titleUpdate?: { readonly title: string | undefined }
    ): Promise<RelicRow | undefined> {
      return mutateRelic(id, (row) => ({
        ...row,
        version: row.version + 1,
        rendererClass,
        declaredSizeBytes,
        publishedAt: undefined,
        objectLength: undefined,
        objectCrc32c: undefined,
        title: titleUpdate !== undefined ? titleUpdate.title : row.title,
      }));
    },

    /**
     * Spend one open against the cap, and return the new total.
     *
     * This is the one place two instances can genuinely race: both read a
     * count of 4, both write 5, and the relic gets an extra open it was not
     * owed. The write is therefore conditional on the generation the count was
     * read at, and a lost race is retried against fresh state rather than
     * papered over.
     */
    async consumeMint(id: string): Promise<number> {
      const updated = await mutateRelic(id, (row) => ({
        ...row,
        mintsUsed: row.mintsUsed + 1,
      }));
      return updated?.mintsUsed ?? 0;
    },

    async getTombstone(id: string): Promise<Tombstone | undefined> {
      return (await get<Tombstone>(key('tomb', `${id}.json`)))?.value;
    },

    async putTombstone(stone: Tombstone): Promise<void> {
      await put(key('tomb', `${stone.id}.json`), stone);
    },

    /**
     * Challenges are shared, not per-instance.
     *
     * They have to be: a challenge issued by one instance is redeemed by
     * whichever instance the grant lands on, and with a per-instance map that
     * is a coin flip on every publish.
     */
    async issueChallenge(ip: string, now: number): Promise<string> {
      const nonce = crypto.randomUUID();
      await put(key('challenge', `${nonce}.json`), {
        nonce,
        issuedAt: now,
        ip,
      });
      return nonce;
    },

    async consumeChallenge(
      nonce: string,
      now: number,
      ttl: number
    ): Promise<boolean> {
      const name = key('challenge', `${nonce}.json`);
      const found = await get<{ issuedAt: number }>(name);
      if (found === undefined) return false;

      // Delete before judging freshness, so a stale nonce cannot be retried
      // and so a valid one is single-use even under concurrent redemption.
      await remove(name);
      return now - found.value.issuedAt <= ttl * 1000;
    },

    async appendMintLog(entry: MintLogEntry): Promise<void> {
      // Name carries the timestamp so the log sorts lexicographically, and a
      // random suffix so two mints in the same millisecond cannot collide.
      const suffix = crypto.randomUUID().slice(0, 8);
      const stamp = String(entry.at).padStart(16, '0');
      await put(key('mintlog', `${stamp}-${suffix}.json`), entry);
    },

    async readMintLog(): Promise<readonly MintLogEntry[]> {
      const entries = await list<MintLogEntry>(`${prefix}/mintlog/`);
      return [...entries].sort((a, b) => a.at - b.at);
    },

    async recentMint(
      id: string,
      ip: string,
      now: number,
      windowSeconds: number
    ): Promise<DedupEntry | undefined> {
      const found = await get<DedupEntry>(dedupKey(id, ip));
      if (found === undefined) return undefined;
      if (now - found.value.at > windowSeconds * 1000) return undefined;
      return found.value;
    },

    async rememberMint(
      id: string,
      ip: string,
      entry: DedupEntry
    ): Promise<void> {
      await put(dedupKey(id, ip), entry);
    },

    async isBlocklisted(hash: string): Promise<boolean> {
      return (await get(key('block', `${hash}.json`))) !== undefined;
    },

    async blocklist(hash: string): Promise<void> {
      await put(key('block', `${hash}.json`), { hash });
    },

    async putAbuseReport(report: AbuseReport): Promise<void> {
      const suffix = crypto.randomUUID().slice(0, 8);
      const stamp = String(report.receivedAt).padStart(16, '0');
      await put(key('abuse', `${stamp}-${suffix}.json`), report);
    },

    async readAbuseReports(): Promise<readonly AbuseReport[]> {
      const reports = await list<AbuseReport>(`${prefix}/abuse/`);
      return [...reports].sort((a, b) => a.receivedAt - b.receivedAt);
    },

    // Comments live one object per comment under the relic's own folder, so
    // a thread is a prefix listing and a relic's whole thread is one delete
    // sweep. A single document holding the array would need a
    // compare-and-swap per comment, and two readers commenting at once would
    // make one of them lose their words rather than merely retry.
    async putComment(row: CommentRow): Promise<void> {
      await put(key('comment', row.relicId, `${row.id}.json`), row);
    },

    async getComment(
      relicId: string,
      commentId: string
    ): Promise<CommentRow | undefined> {
      return (
        await get<CommentRow>(key('comment', relicId, `${commentId}.json`))
      )?.value;
    },

    async listComments(relicId: string): Promise<readonly CommentRow[]> {
      const rows = await list<CommentRow>(`${prefix}/comment/${relicId}/`);
      // Oldest first, ties broken on id so the order is total. A listing
      // comes back in whatever order the bucket likes, which is lexical by
      // object name, and a random comment id is not chronological.
      return [...rows].sort(
        (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)
      );
    },

    async deleteComment(relicId: string, commentId: string): Promise<void> {
      await remove(key('comment', relicId, `${commentId}.json`));
    },

    async deleteCommentsForRelic(relicId: string): Promise<number> {
      const rows = await list<CommentRow>(`${prefix}/comment/${relicId}/`);
      for (const row of rows) {
        await remove(key('comment', relicId, `${row.id}.json`));
      }
      return rows.length;
    },

    // A link and a session are both keyed by the hash of the secret, never
    // by the secret, so the bucket cannot hand anybody a usable credential
    // even to somebody who can list it.
    async putAuthLink(row: AuthLinkRow): Promise<void> {
      await put(key('authlink', `${row.tokenHash}.json`), row);
    },

    async consumeAuthLink(tokenHash: string): Promise<AuthLinkRow | undefined> {
      const name = key('authlink', `${tokenHash}.json`);
      const current = await get<AuthLinkRow>(name);
      if (current === undefined) return undefined;
      // Spend it whether or not it was still valid, so a replay finds
      // nothing rather than an expired row somebody might forgive later.
      await remove(name);
      return current.value;
    },

    async putSession(row: SessionRow): Promise<void> {
      await put(key('session', `${row.tokenHash}.json`), row);
    },

    async getSession(tokenHash: string): Promise<SessionRow | undefined> {
      return (await get<SessionRow>(key('session', `${tokenHash}.json`)))
        ?.value;
    },
  };

  function dedupKey(id: string, ip: string): string {
    // The IP is part of a key in a bucket, so it is hashed rather than spelled
    // out. Same reason the mint log records what it records and no more.
    return key('dedup', id, `${fnv1a(ip)}.json`);
  }

  /**
   * Read-modify-write a relic row under its generation, retrying on loss.
   *
   * Returns undefined if the row is gone, which callers treat the same way
   * they treat a relic that never existed.
   */
  async function mutateRelic(
    id: string,
    change: (row: RelicRow) => RelicRow
  ): Promise<RelicRow | undefined> {
    const name = key('relic', `${id}.json`);

    for (let attempt = 0; attempt < casAttempts; attempt++) {
      const current = await get<RelicRow>(name);
      if (current === undefined) return undefined;

      const next = change(current.value);
      if (await put(name, next, current.generation)) return next;
    }

    throw new Error(
      `gcs relic ${id} lost ${casAttempts} compare-and-swap races; ` +
        'refusing to write a count derived from stale state'
    );
  }
}

/** Small non-cryptographic hash, used only to avoid writing an IP into a key. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
