import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeKey,
  decryptComment,
  deriveCommentKey,
  encryptComment,
  generateKey,
} from '@relic/format';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import {
  COMMENT_TOOL_NAME,
  handleMessage,
  INSTRUCTIONS,
  READ_COMMENTS_TOOL_NAME,
} from '../src/server.ts';
import { publishStatePath } from '../src/state.ts';

const SERVICE = 'https://relic.example';

interface CommentRow {
  comment_id: string;
  author: string;
  created_at: string;
  ciphertext: string;
}

let scratch: string;
let deps: PublishDeps;
let stored: CommentRow[];
let posted: Record<string, unknown>[];
let refuseComments: { status: number; body: Record<string, unknown> } | null;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-comments-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');
  stored = [];
  posted = [];
  refuseComments = null;
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: commentFetch(),
    clientName: 'relic-mcp/comments-test',
  };
});

/**
 * A service that behaves like the real one on the two members that matter
 * here: it never sees a plaintext body, and it attributes a token-authorized
 * comment to `publisher`.
 */
function commentFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    if (url.hostname === 'storage.invalid' && init?.method === 'PUT') {
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/api/challenge') {
      return Response.json({
        challenge_nonce: 'comment-challenge',
        size_limit_bytes: 10_000_000,
        size_basis: 'plaintext',
      });
    }
    if (url.pathname === '/api/grant') {
      return Response.json({
        publish_token: 'publish-token-held-only-in-local-state',
        upload_url: 'https://storage.invalid/upload/first',
        relic_expires_at: null,
        report_url: `${SERVICE}/abuse`,
        disclosure_url: `${SERVICE}/disclosure`,
      });
    }
    if (url.pathname.endsWith('/complete')) return Response.json({});

    if (url.pathname.endsWith('/comments')) {
      if (refuseComments !== null) {
        return Response.json(refuseComments.body, {
          status: refuseComments.status,
        });
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        const row = {
          comment_id: `c${stored.length + 1}`,
          author: 'publisher',
          created_at: `2026-08-20T0${stored.length}:00:00Z`,
          ciphertext: String(body['ciphertext']),
        };
        stored.push(row);
        return Response.json({
          comment_id: row.comment_id,
          author: row.author,
          created_at: row.created_at,
        });
      }
      return Response.json(stored);
    }

    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    deps
  );
  return response?.result as Record<string, unknown>;
}

/** Publish a throwaway file so this machine holds a key and a token. */
async function publishFixture(): Promise<string> {
  const path = join(scratch, 'report.md');
  await writeFile(path, '# under review\n');
  const result = await publish({ path }, deps);
  return result.relic_id;
}

async function storedKey(relicId: string): Promise<string> {
  const file = JSON.parse(await readFile(publishStatePath(), 'utf8')) as {
    relics: Record<string, { key: string }>;
  };
  const entry = file.relics[relicId];
  if (entry === undefined) throw new Error(`no state for ${relicId}`);
  return entry.key;
}

describe('writing a comment as the publisher', () => {
  test('sends ciphertext plus the stored token, never the body', async () => {
    const relicId = await publishFixture();

    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'The second chart is using last quarter numbers.',
      display_name: 'Relic Agent',
    });

    expect(result['isError']).toBe(false);
    expect(result['structuredContent']).toEqual({
      relic_id: relicId,
      comment_id: 'c1',
      author: 'publisher',
      created_at: '2026-08-20T00:00:00Z',
    });

    const request = posted[0];
    expect(request).toBeDefined();
    expect(request?.['publish_token']).toBe(
      'publish-token-held-only-in-local-state'
    );
    const ciphertext = String(request?.['ciphertext']);
    expect(ciphertext).not.toContain('second chart');
    expect(JSON.stringify(request)).not.toContain('last quarter');

    // The only party who can read it is somebody holding the relic key.
    const commentKey = await deriveCommentKey(
      decodeKey(await storedKey(relicId))
    );
    expect(await decryptComment(commentKey, ciphertext)).toEqual({
      body: 'The second chart is using last quarter numbers.',
      display_name: 'Relic Agent',
      anchor: null,
    });
  });

  test('refuses an empty body and one over the envelope cap', async () => {
    const relicId = await publishFixture();

    const empty = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: '   ',
    });
    expect(empty['isError']).toBe(true);
    expect(
      (empty['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('local_comment_body_empty');

    const long = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'x'.repeat(4097),
    });
    expect(long['isError']).toBe(true);
    const details = long['structuredContent'] as Record<string, unknown>;
    expect(details['code']).toBe('local_comment_body_too_long');
    expect(details['body_bytes']).toBe(4097);
    expect(posted).toHaveLength(0);
  });

  test('names a comment rate limit as something to wait out', async () => {
    const relicId = await publishFixture();
    refuseComments = {
      status: 429,
      body: { code: 'comment_rate_limited', retry_after_seconds: 30 },
    };

    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'One more thought.',
    });

    expect(result['isError']).toBe(true);
    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['code']).toBe('comment_rate_limited');
    expect(structured['retry_after_seconds']).toBe(30);
    expect(JSON.stringify(result['content'])).toMatch(/retry_after_seconds/);
  });
});

describe('reading comments back', () => {
  test('returns them oldest first, decrypted, with the author', async () => {
    const relicId = await publishFixture();
    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'First pass looks right.',
    });
    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Second thought: drop the appendix.',
      display_name: 'Reviewer',
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });

    expect(result['isError']).toBe(false);
    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['count']).toBe(2);
    expect(structured['unreadable_count']).toBe(0);
    expect(structured['comments']).toEqual([
      {
        comment_id: 'c1',
        author: 'publisher',
        created_at: '2026-08-20T00:00:00Z',
        display_name: null,
        body: 'First pass looks right.',
        anchor: null,
        readable: true,
        unreadable_reason: null,
      },
      {
        comment_id: 'c2',
        author: 'publisher',
        created_at: '2026-08-20T01:00:00Z',
        display_name: 'Reviewer',
        body: 'Second thought: drop the appendix.',
        anchor: null,
        readable: true,
        unreadable_reason: null,
      },
    ]);
    const text = JSON.stringify(result['content']);
    expect(text).toMatch(/drop the appendix/);
    expect(text).toMatch(/oldest first/);
  });

  test('a mark reaches the agent, in the structure and in the transcript', async () => {
    // The defect this replaces: the anchor decrypted fine and was then
    // dropped, so an agent could not tell "this line is wrong" from a general
    // remark, and could not find the line either. Proven live against
    // production before it was fixed.
    const relicId = await publishFixture();
    const commentKey = await deriveCommentKey(
      decodeKey(await storedKey(relicId))
    );

    stored.push({
      comment_id: 'c1',
      author: 'reader@example.com',
      created_at: '2026-08-20T00:00:00Z',
      ciphertext: await encryptComment(commentKey, {
        body: 'This sentence is the wrong one.',
        display_name: null,
        anchor: { kind: 'text', quote: 'the kestrel audits the lighthouse' },
      }),
    });
    stored.push({
      comment_id: 'c2',
      author: 'reader@example.com',
      created_at: '2026-08-20T01:00:00Z',
      ciphertext: await encryptComment(commentKey, {
        body: 'And this bit of the diagram.',
        display_name: null,
        anchor: { kind: 'pin', x: 0.25, y: 0.8 },
      }),
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    const structured = result['structuredContent'] as Record<string, unknown>;
    const comments = structured['comments'] as Array<Record<string, unknown>>;

    expect(comments[0]?.['anchor']).toEqual({
      kind: 'text',
      quote: 'the kestrel audits the lighthouse',
    });
    expect(comments[1]?.['anchor']).toEqual({ kind: 'pin', x: 0.25, y: 0.8 });

    // And in the prose, because a field an agent has to go looking for is
    // most of the way back to not having it.
    const text = JSON.stringify(result['content']);
    expect(text).toContain('on \\"the kestrel audits the lighthouse\\"');
    expect(text).toContain('at 25% across, 80% down');
  });

  test('says so when there are none', async () => {
    const relicId = await publishFixture();
    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['count']).toBe(0);
    expect(structured['comments']).toEqual([]);
    expect(JSON.stringify(result['content'])).toMatch(/No comments/);
  });

  test('reports a comment that will not decrypt instead of skipping it', async () => {
    const relicId = await publishFixture();
    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'This one opens.',
    });

    // A body encrypted under some other relic's key: the shape the service
    // would return if a comment were written against a different fragment.
    const foreignKey = await deriveCommentKey(generateKey());
    stored.push({
      comment_id: 'c-foreign',
      author: 'someone@example.invalid',
      created_at: '2026-08-20T02:00:00Z',
      ciphertext: await encryptComment(foreignKey, {
        body: 'unreadable here',
        display_name: null,
      }),
    });
    stored.push({
      comment_id: 'c-empty',
      author: 'someone@example.invalid',
      created_at: '2026-08-20T03:00:00Z',
      ciphertext: '',
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });

    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['count']).toBe(3);
    expect(structured['unreadable_count']).toBe(2);
    const comments = structured['comments'] as Record<string, unknown>[];
    expect(comments[0]?.['readable']).toBe(true);
    expect(comments[1]?.['readable']).toBe(false);
    expect(comments[1]?.['body']).toBeNull();
    expect(String(comments[1]?.['unreadable_reason'])).toMatch(
      /did not decrypt/
    );
    expect(comments[2]?.['readable']).toBe(false);
    // The whole call still succeeds: a partial read is not a failed read.
    expect(result['isError']).toBe(false);
    const text = JSON.stringify(result['content']);
    expect(text).toMatch(/partially unread/);
    expect(text).toMatch(/unreadable/);
  });

  test('refuses a comment list that is not an array', async () => {
    const relicId = await publishFixture();
    refuseComments = null;
    deps = {
      ...deps,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : String(input));
        if (url.pathname.endsWith('/comments') && init?.method !== 'POST') {
          return Response.json({ comments: [] });
        }
        return deps.fetch(input, init);
      }) as typeof globalThis.fetch,
    };

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    expect(result['isError']).toBe(true);
    expect(
      (result['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('app_response_unusable');
  });
});

describe('the machine boundary', () => {
  const elsewhere = '01jw0000000000000000000000';

  test('refuses to read comments on a relic published elsewhere', async () => {
    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: elsewhere,
    });
    expect(result['isError']).toBe(true);
    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['code']).toBe('no_local_publish_state');
    const text = JSON.stringify(result['content']);
    expect(text).toMatch(/published from another machine/);
    expect(text).toMatch(/neither read nor written here/);
  });

  test('refuses to write a comment on a relic published elsewhere', async () => {
    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: elsewhere,
      body: 'Cannot attribute this.',
    });
    expect(result['isError']).toBe(true);
    expect(
      (result['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('no_local_publish_state');
    expect(posted).toHaveLength(0);
  });

  test('refuses a share URL and says to pass the id instead', async () => {
    const relicId = await publishFixture();
    const key = await storedKey(relicId);

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: `${SERVICE}/${relicId}#r1${key}`,
    });

    expect(result['isError']).toBe(true);
    expect(
      (result['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('no_local_publish_state');
    expect(JSON.stringify(result['content'])).toMatch(
      /never the share URL: the URL carries the key in its fragment/
    );
  });
});

describe('what an agent is told before it calls anything', () => {
  test('both tools are listed with their machine boundary', async () => {
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      deps
    );
    // The server's own definitions, read back through the protocol.
    const listed = response?.result as {
      tools: { name: string; description: string }[];
    };
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain(READ_COMMENTS_TOOL_NAME);
    expect(names).toContain(COMMENT_TOOL_NAME);

    for (const name of [READ_COMMENTS_TOOL_NAME, COMMENT_TOOL_NAME]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/Only works for a relic this machine/);
      expect(tool?.description).toMatch(/never the share URL/);
    }
  });

  test('the handshake instructions name the comment tools', () => {
    expect(INSTRUCTIONS).toMatch(/relic_read_comments/);
    expect(INSTRUCTIONS).toMatch(/relic_comment/);
    expect(INSTRUCTIONS).toMatch(/Seven things/);
  });
});

afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(scratch, { recursive: true, force: true });
});
