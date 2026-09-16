import { describe, expect, test } from 'bun:test';
import { gcsStore } from '../src/gcsstore.ts';
import type { RelicRow } from '../src/store.ts';

/**
 * A fake GCS that models the one behaviour the store depends on for
 * correctness: every write bumps a generation, and a write carrying
 * `ifGenerationMatch` fails with 412 when it no longer matches.
 *
 * Testing `consumeMint` against a fake without generations would prove
 * nothing, because the race it exists to prevent is invisible without them.
 */
function fakeGcs() {
  const objects = new Map<string, { body: string; generation: number }>();
  let nextGeneration = 1;
  /**
   * Names to advance one generation just before the next write to them, which
   * is what a competing instance looks like from in here.
   *
   * Modelled by mutating the map directly rather than by driving a second
   * store, because a second store issues writes of its own and those would
   * re-enter this hook and recurse.
   */
  const bumps = new Map<string, number>();

  const competingIncrement = (name: string): void => {
    const remaining = bumps.get(name);
    if (remaining === undefined || remaining === 0) return;
    if (remaining > 0) bumps.set(name, remaining - 1);

    const existing = objects.get(name);
    if (existing === undefined) return;

    const parsed = JSON.parse(existing.body) as { mintsUsed?: number };
    parsed.mintsUsed = (parsed.mintsUsed ?? 0) + 1;
    objects.set(name, {
      body: JSON.stringify(parsed),
      generation: nextGeneration++,
    });
  };

  const handler = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';

    if (url.pathname.startsWith('/upload/')) {
      const name = url.searchParams.get('name') ?? '';
      const precondition = url.searchParams.get('ifGenerationMatch');

      competingIncrement(name);

      if (precondition !== null) {
        const existing = objects.get(name);
        const current = existing === undefined ? 0 : existing.generation;
        if (String(current) !== precondition) {
          return new Response('precondition failed', { status: 412 });
        }
      }

      objects.set(name, {
        body: String(init?.body ?? ''),
        generation: nextGeneration++,
      });
      return new Response('{}', { status: 200 });
    }

    // List: /storage/v1/b/{bucket}/o?prefix=
    const listMatch = /^\/storage\/v1\/b\/[^/]+\/o$/.exec(url.pathname);
    if (listMatch !== null && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const items = [...objects.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name }));
      return Response.json({ items });
    }

    // Single object: /storage/v1/b/{bucket}/o/{name}
    const objectMatch = /^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/.exec(url.pathname);
    if (objectMatch?.[1] !== undefined) {
      const name = decodeURIComponent(objectMatch[1]);

      if (method === 'DELETE') {
        objects.delete(name);
        return new Response('', { status: 204 });
      }

      const found = objects.get(name);
      if (found === undefined) {
        return new Response('not found', { status: 404 });
      }
      return new Response(found.body, {
        status: 200,
        headers: { 'x-goog-generation': String(found.generation) },
      });
    }

    return new Response('unhandled', { status: 500 });
  };

  return {
    fetch: handler as unknown as typeof globalThis.fetch,
    objects,
    /** `times: -1` means every write, for modelling permanent contention. */
    contendOn(name: string, times: number) {
      bumps.set(name, times);
    },
  };
}

function storeOn(gcs: ReturnType<typeof fakeGcs>, casAttempts?: number) {
  return gcsStore({
    bucket: 'relics',
    getAccessToken: async () => 'token',
    host: 'https://gcs.test',
    fetch: gcs.fetch,
    ...(casAttempts === undefined ? {} : { casAttempts }),
  });
}

function row(overrides: Partial<RelicRow> = {}): RelicRow {
  return {
    id: 'gdk6rpv49hftg5216ev7dejesc',
    publishIp: '203.0.113.7',
    grantedAt: 1000,
    expiresAt: 9_000_000,
    rendererClass: 'html',
    publishingClient: 'relic-mcp',
    declaredSizeBytes: 1024,
    version: 1,
    publishTokenHash: 'f'.repeat(64),
    mintsUsed: 0,
    ...overrides,
  };
}

describe('gcsStore', () => {
  test('a relic survives being written and read back', async () => {
    const store = storeOn(fakeGcs());
    await store.putRelic(row());

    const found = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.id).toBe('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.rendererClass).toBe('html');
  });

  test('a relic title survives being written and read back', async () => {
    const store = storeOn(fakeGcs());
    await store.putRelic(row({ title: 'GCS Title' }));

    const found = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.title).toBe('GCS Title');
  });

  test('rows written without a title key read back with title undefined', async () => {
    const gcs = fakeGcs();
    const legacyRowJson = JSON.stringify({
      id: 'gdk6rpv49hftg5216ev7dejesc',
      publishIp: '203.0.113.7',
      grantedAt: 1000,
      expiresAt: 9_000_000,
      rendererClass: 'html',
      publishingClient: 'relic-mcp',
      declaredSizeBytes: 1024,
      version: 1,
      publishTokenHash: 'f'.repeat(64),
      mintsUsed: 0,
    });
    await gcs.fetch(
      'https://gcs.test/upload/storage/v1/b/relics/o?name=m%2Frelic%2Fgdk6rpv49hftg5216ev7dejesc.json',
      {
        method: 'POST',
        body: legacyRowJson,
      }
    );
    const store = storeOn(gcs);
    const found = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.id).toBe('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.title).toBeUndefined();
  });

  test('beginVersion preserves, clears, or replaces title across generations', async () => {
    const store = storeOn(fakeGcs());
    await store.putRelic(row({ title: 'Original Title' }));

    // Absent titleUpdate leaves stored title unchanged
    const v2 = await store.beginVersion(
      'gdk6rpv49hftg5216ev7dejesc',
      'html',
      2048
    );
    expect(v2?.version).toBe(2);
    expect(v2?.title).toBe('Original Title');

    const readV2 = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(readV2?.title).toBe('Original Title');

    // titleUpdate with title: undefined clears the title
    const v3 = await store.beginVersion(
      'gdk6rpv49hftg5216ev7dejesc',
      'html',
      4096,
      { title: undefined }
    );
    expect(v3?.version).toBe(3);
    expect(v3?.title).toBeUndefined();

    const readV3 = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(readV3?.title).toBeUndefined();

    // titleUpdate with a new title replaces it
    const v4 = await store.beginVersion(
      'gdk6rpv49hftg5216ev7dejesc',
      'html',
      8192,
      { title: 'Replaced Title' }
    );
    expect(v4?.version).toBe(4);
    expect(v4?.title).toBe('Replaced Title');

    const readV4 = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(readV4?.title).toBe('Replaced Title');
  });

  // The whole point of the change: a second reader is a different instance.
  test('a second store over the same bucket sees the relic', async () => {
    const gcs = fakeGcs();
    await storeOn(gcs).putRelic(row());

    const other = storeOn(gcs);
    expect(await other.getRelic('gdk6rpv49hftg5216ev7dejesc')).toBeDefined();
  });

  test('an unknown relic is undefined, not an error', async () => {
    const store = storeOn(fakeGcs());
    expect(await store.getRelic('nope')).toBeUndefined();
  });

  test('markPublished records the object it landed as', async () => {
    const store = storeOn(fakeGcs());
    await store.putRelic(row());
    await store.markPublished('gdk6rpv49hftg5216ev7dejesc', 2000, 4096, 'crc');

    const found = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.publishedAt).toBe(2000);
    expect(found?.objectLength).toBe(4096);
    expect(found?.objectCrc32c).toBe('crc');
  });

  test('consumeMint counts up', async () => {
    const store = storeOn(fakeGcs());
    await store.putRelic(row());

    expect(await store.consumeMint('gdk6rpv49hftg5216ev7dejesc')).toBe(1);
    expect(await store.consumeMint('gdk6rpv49hftg5216ev7dejesc')).toBe(2);
  });

  // Two instances both read 0 and both write 1, and the relic gets a free
  // open. The generation precondition is what stops it.
  test('a mint that loses the race retries against fresh state', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    await store.putRelic(row());

    // One competing increment lands between our read and our write.
    gcs.contendOn('m/relic/gdk6rpv49hftg5216ev7dejesc.json', 1);

    const result = await store.consumeMint('gdk6rpv49hftg5216ev7dejesc');

    // Both increments are accounted for. Neither silently overwrote the other,
    // which is exactly what an unconditional write would have done.
    expect(result).toBe(2);
    const found = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.mintsUsed).toBe(2);
  });

  test('giving up on a hopelessly contended row raises, never guesses', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs, 2);
    await store.putRelic(row());

    gcs.contendOn('m/relic/gdk6rpv49hftg5216ev7dejesc.json', -1);

    await expect(
      store.consumeMint('gdk6rpv49hftg5216ev7dejesc')
    ).rejects.toThrow(/compare-and-swap/);
  });

  test('minting a relic that is gone does not invent one', async () => {
    const store = storeOn(fakeGcs());
    expect(await store.consumeMint('missing')).toBe(0);
    expect(await store.getRelic('missing')).toBeUndefined();
  });

  test('a tombstone outlives the relic it replaces', async () => {
    const store = storeOn(fakeGcs());
    await store.putTombstone({
      id: 'gdk6rpv49hftg5216ev7dejesc',
      publishIp: '203.0.113.7',
      publishedAt: 2000,
      publishingClient: 'relic-mcp',
      rendererClass: 'html',
      ciphertextHash: 'hash',
      deletedAt: 3000,
      operator: 'jason',
      reasonClass: 'abuse',
      reportReference: undefined,
    });

    const stone = await store.getTombstone('gdk6rpv49hftg5216ev7dejesc');
    expect(stone?.reasonClass).toBe('abuse');
  });

  // A challenge issued on one instance is redeemed on whichever instance the
  // grant reaches, so it cannot live in a per-instance map.
  test('a challenge issued by one instance is redeemable by another', async () => {
    const gcs = fakeGcs();
    const nonce = await storeOn(gcs).issueChallenge('203.0.113.7', 1000);

    expect(await storeOn(gcs).consumeChallenge(nonce, 1500, 60)).toBe(true);
  });

  test('a challenge is single use', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    const nonce = await store.issueChallenge('203.0.113.7', 1000);

    expect(await store.consumeChallenge(nonce, 1500, 60)).toBe(true);
    expect(await store.consumeChallenge(nonce, 1600, 60)).toBe(false);
  });

  test('an expired challenge is refused and not left behind', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    const nonce = await store.issueChallenge('203.0.113.7', 1000);

    expect(await store.consumeChallenge(nonce, 1000 + 61_000, 60)).toBe(false);
    expect(await store.consumeChallenge(nonce, 1000 + 61_000, 60)).toBe(false);
  });

  test('an unknown challenge is refused', async () => {
    const store = storeOn(fakeGcs());
    expect(await store.consumeChallenge('never-issued', 1, 60)).toBe(false);
  });

  test('dedup entries expire out of the window', async () => {
    const store = storeOn(fakeGcs());
    const entry = { url: 'https://signed', urlExpiresAt: 9000, at: 1000 };
    await store.rememberMint('relic', '203.0.113.7', entry);

    expect(await store.recentMint('relic', '203.0.113.7', 1500, 60)).toEqual(
      entry
    );
    expect(
      await store.recentMint('relic', '203.0.113.7', 1000 + 61_000, 60)
    ).toBeUndefined();
  });

  test('dedup is per ip, not per relic', async () => {
    const store = storeOn(fakeGcs());
    await store.rememberMint('relic', '203.0.113.7', {
      url: 'https://signed',
      urlExpiresAt: 9000,
      at: 1000,
    });

    expect(
      await store.recentMint('relic', '198.51.100.2', 1500, 60)
    ).toBeUndefined();
  });

  test('the dedup key never spells out the ip', async () => {
    const gcs = fakeGcs();
    await storeOn(gcs).rememberMint('relic', '203.0.113.7', {
      url: 'https://signed',
      urlExpiresAt: 9000,
      at: 1000,
    });

    expect([...gcs.objects.keys()].join('\n')).not.toContain('203.0.113.7');
  });

  test('the blocklist persists', async () => {
    const gcs = fakeGcs();
    await storeOn(gcs).blocklist('deadbeef');

    expect(await storeOn(gcs).isBlocklisted('deadbeef')).toBe(true);
    expect(await storeOn(gcs).isBlocklisted('cafe')).toBe(false);
  });

  test('the mint log accumulates and reads back in time order', async () => {
    const store = storeOn(fakeGcs());
    const base = {
      relicId: 'relic',
      ip: '203.0.113.7',
      endpoint: 'mint',
      outcome: 'granted' as const,
      code: undefined,
      countedAsOpen: true,
      dropReason: undefined,
      consumedCap: true,
      capRemaining: 199,
      occurrenceId: 'occ',
    };

    await store.appendMintLog({ ...base, at: 3000 });
    await store.appendMintLog({ ...base, at: 1000 });
    await store.appendMintLog({ ...base, at: 2000 });

    expect((await store.readMintLog()).map((e) => e.at)).toEqual([
      1000, 2000, 3000,
    ]);
  });

  test('abuse reports accumulate rather than overwrite', async () => {
    const store = storeOn(fakeGcs());
    const base = {
      relicId: 'relic',
      category: 'phishing' as const,
      description: 'looks like a bank',
      contact: undefined,
      authority: undefined,
      reference: undefined,
    };

    await store.putAbuseReport({ ...base, receivedAt: 2000 });
    await store.putAbuseReport({ ...base, receivedAt: 1000 });

    const reports = await store.readAbuseReports();
    expect(reports.map((r) => r.receivedAt)).toEqual([1000, 2000]);
  });

  test('two reports in the same millisecond both survive', async () => {
    const store = storeOn(fakeGcs());
    const base = {
      relicId: 'relic',
      category: 'other' as const,
      description: 'x',
      contact: undefined,
      authority: undefined,
      reference: undefined,
      receivedAt: 1000,
    };

    await store.putAbuseReport(base);
    await store.putAbuseReport(base);

    expect((await store.readAbuseReports()).length).toBe(2);
  });

  test('comments land one object each and list oldest first', async () => {
    const store = storeOn(fakeGcs());
    await store.putComment({
      id: 'b',
      relicId: 'relic',
      author: 'publisher',
      createdAt: 2000,
      ciphertext: 'YWJjZA',
    });
    await store.putComment({
      id: 'a',
      relicId: 'relic',
      author: 'reader@example.com',
      createdAt: 1000,
      ciphertext: 'ZGVjZA',
    });

    const listed = await store.listComments('relic');
    expect(listed.map((c) => c.id)).toEqual(['a', 'b']);
    expect(await store.getComment('relic', 'a')).toMatchObject({
      author: 'reader@example.com',
    });
    expect(await store.listComments('other')).toEqual([]);
  });

  test('deleting one comment leaves the rest, and deleting the relic takes all of them', async () => {
    const store = storeOn(fakeGcs());
    await store.putComment({
      id: 'one',
      relicId: 'relic',
      author: 'publisher',
      createdAt: 1,
      ciphertext: 'YWJjZA',
    });
    await store.putComment({
      id: 'two',
      relicId: 'relic',
      author: 'publisher',
      createdAt: 2,
      ciphertext: 'ZGVjZA',
    });

    await store.deleteComment('relic', 'one');
    expect((await store.listComments('relic')).map((c) => c.id)).toEqual([
      'two',
    ]);

    expect(await store.deleteCommentsForRelic('relic')).toBe(1);
    expect(await store.listComments('relic')).toEqual([]);
  });
  test('a legacy comment row with no version key in the bucket reads back with version undefined', async () => {
    const gcs = fakeGcs();
    gcs.objects.set('m/comment/relic/legacy.json', {
      body: JSON.stringify({
        id: 'legacy',
        relicId: 'relic',
        author: 'reader@example.com',
        createdAt: 500,
        ciphertext: 'YWJjZA',
      }),
      generation: 1,
    });
    const store = storeOn(gcs);
    const comment = await store.getComment('relic', 'legacy');
    expect(comment).toBeDefined();
    expect(comment?.version).toBeUndefined();

    const listed = await store.listComments('relic');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('legacy');
    expect(listed[0]?.version).toBeUndefined();
  });

  test('a comment with an explicit version persists and reads back with that version', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    await store.putComment({
      id: 'v2comment',
      relicId: 'relic',
      author: 'publisher',
      createdAt: 600,
      ciphertext: 'YWJjZA',
      version: 2,
    });

    const rawBody = gcs.objects.get('m/comment/relic/v2comment.json')?.body;
    expect(rawBody).toBeDefined();
    const parsed = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
    expect(parsed['version']).toBe(2);

    const comment = await store.getComment('relic', 'v2comment');
    expect(comment?.version).toBe(2);

    const listed = await store.listComments('relic');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.version).toBe(2);
  });

  test('a comment without a version key omits the version property from the stored GCS document', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    await store.putComment({
      id: 'unversioned',
      relicId: 'relic',
      author: 'publisher',
      createdAt: 700,
      ciphertext: 'YWJjZA',
    });

    const rawBody = gcs.objects.get('m/comment/relic/unversioned.json')?.body;
    expect(rawBody).toBeDefined();
    const parsed = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
    expect('version' in parsed).toBe(false);

    const comment = await store.getComment('relic', 'unversioned');
    expect(comment?.version).toBeUndefined();
  });

  test('a magic link is spent on first consume, so a replay finds nothing', async () => {
    const store = storeOn(fakeGcs());
    await store.putAuthLink({
      tokenHash: 'abc',
      email: 'reader@example.com',
      expiresAt: 9_000_000,
      returnTo: '/',
    });

    const first = await store.consumeAuthLink('abc');
    expect(first?.email).toBe('reader@example.com');
    expect(await store.consumeAuthLink('abc')).toBeUndefined();
  });

  test('a session reads back by the hash of the secret, never the secret', async () => {
    const store = storeOn(fakeGcs());
    await store.putSession({
      tokenHash: 'hashed',
      email: 'reader@example.com',
      createdAt: 1000,
      expiresAt: 9_000_000,
    });
    expect((await store.getSession('hashed'))?.email).toBe(
      'reader@example.com'
    );
    expect(await store.getSession('the-secret')).toBeUndefined();
  });

  test('listCommentedRelics returns relics an author commented on, ordered by most recent engagement first', async () => {
    const store = storeOn(fakeGcs());
    await store.putComment({
      id: 'c1',
      relicId: 'relic1',
      author: 'reader@example.com',
      createdAt: 1000,
      ciphertext: 'YWJjZA',
    });
    await store.putComment({
      id: 'c2',
      relicId: 'relic2',
      author: 'reader@example.com',
      createdAt: 2000,
      ciphertext: 'YWJjZA',
    });
    await store.putComment({
      id: 'c3',
      relicId: 'relic1',
      author: 'reader@example.com',
      createdAt: 3000,
      ciphertext: 'YWJjZA',
    });
    // Second author comments on relic 3
    await store.putComment({
      id: 'c4',
      relicId: 'relic3',
      author: 'other@example.com',
      createdAt: 4000,
      ciphertext: 'YWJjZA',
    });

    const readerRelics = await store.listCommentedRelics('reader@example.com');
    expect(readerRelics).toEqual([
      { relicId: 'relic1', lastCommentAt: 3000 },
      { relicId: 'relic2', lastCommentAt: 2000 },
    ]);

    const otherRelics = await store.listCommentedRelics('other@example.com');
    expect(otherRelics).toEqual([{ relicId: 'relic3', lastCommentAt: 4000 }]);
  });

  test('a failed index write in gcsStore does not lose the comment', async () => {
    const gcs = fakeGcs();
    const originalFetch = gcs.fetch;
    gcs.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const name = url.searchParams.get('name') ?? '';
      if (
        url.pathname.startsWith('/upload/') &&
        name.includes('author_relic')
      ) {
        return new Response('index write error', { status: 500 });
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
    const store = storeOn(gcs);

    await store.putComment({
      id: 'c1',
      relicId: 'relic1',
      author: 'reader@example.com',
      createdAt: 1000,
      ciphertext: 'YWJjZA',
    });

    const comments = await store.listComments('relic1');
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe('c1');
  });
});
