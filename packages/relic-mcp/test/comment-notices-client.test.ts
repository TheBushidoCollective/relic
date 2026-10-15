import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import {
  COMMENT_TOOL_DEFINITION,
  COMMENT_TOOL_NAME,
  DESCRIBE_TOOL_NAME,
  describeClient,
  handleMessage,
  INSTRUCTIONS,
  REPUBLISH_TOOL_DEFINITION,
  SHARE_TOOL_DEFINITION,
} from '../src/server.ts';

const SERVICE = 'https://relic.example';

let scratch: string;
let deps: PublishDeps;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-comment-notices-client-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');

  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    clientName: 'relic-mcp/test',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test fake renderer',
    }),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : String(input));
      if (url.hostname === 'storage.invalid' && init?.method === 'PUT') {
        return new Response(null, { status: 200 });
      }
      if (url.pathname === '/api/challenge') {
        return Response.json({
          challenge_nonce: 'challenge-nonce',
          size_limit_bytes: 10_000_000,
          size_basis: 'plaintext',
        });
      }
      if (url.pathname === '/api/grant') {
        let relicId = 'first';
        if (init?.body) {
          try {
            const parsed = JSON.parse(String(init.body));
            if (
              parsed &&
              typeof parsed === 'object' &&
              typeof parsed.relic_id === 'string'
            ) {
              relicId = parsed.relic_id;
            }
          } catch {
            // default
          }
        }
        return Response.json({
          publish_token: 'test-publish-token',
          upload_url: `https://storage.invalid/upload/${relicId}`,
          relic_expires_at: null,
          report_url: `${SERVICE}/abuse`,
          disclosure_url: `${SERVICE}/disclosure`,
        });
      }
      if (url.pathname.endsWith('/complete')) {
        return Response.json({});
      }
      if (url.origin === SERVICE && url.pathname.endsWith('/comments')) {
        return Response.json(
          {
            comment_id: 'c1',
            relic_id: '0123456789abcdef0123456789',
            author: 'publisher',
            created_at: new Date().toISOString(),
          },
          { status: 201 }
        );
      }
      return new Response(null, { status: 404 });
    },
  };
});

describe('comment notices client disclosures', () => {
  test('relic_comment description warns that posting emails everyone following the relic', () => {
    const desc = COMMENT_TOOL_DEFINITION.description;
    expect(desc).toMatch(
      /warning.*posting emails everyone following the relic/i
    );
    expect(desc).toMatch(/10 minutes/);
    expect(desc).toMatch(/stop link/);
  });

  test('callComment result text mentions that Relic emails everyone following the relic', async () => {
    const fixturePath = join(scratch, 'doc.md');
    await writeFile(fixturePath, '# Test file\n');
    const published = await publish({ path: fixturePath }, deps);

    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: COMMENT_TOOL_NAME,
          arguments: {
            relic_id: published.relic_id,
            body: 'Hello reviewer',
          },
        },
      },
      deps
    );
    expect(res).toBeDefined();
    if (!res || !('result' in res)) throw new Error('Expected result');
    const resultObj = res.result;
    if (!resultObj || typeof resultObj !== 'object')
      throw new Error('Result not object');
    expect('isError' in resultObj && resultObj.isError).toBe(false);

    if (!('content' in resultObj) || !Array.isArray(resultObj.content))
      throw new Error('Expected content array');
    const firstContent = resultObj.content[0];
    if (
      !firstContent ||
      typeof firstContent !== 'object' ||
      !('text' in firstContent) ||
      typeof firstContent.text !== 'string'
    ) {
      throw new Error('Expected text content');
    }
    const text = firstContent.text;
    expect(text).toMatch(/emails everyone following/i);
    expect(text).toMatch(/10 minutes/);
    expect(text).toMatch(/stop link/);
  });

  test('INSTRUCTIONS describes comment emails, 10-minute limiter, and single stop link', () => {
    expect(INSTRUCTIONS).toMatch(/comment.*emails everyone/i);
    expect(INSTRUCTIONS).toMatch(/10 minutes/);
    expect(INSTRUCTIONS).toMatch(/stop link/i);
  });

  test('describeClient prose and structured content explain comment notices', async () => {
    const desc = describeClient(deps);
    expect(desc).toMatch(
      /A new comment emails everyone on the relic('s|’s) list/i
    );
    expect(desc).toMatch(/10 minutes/);
    expect(desc).toMatch(/one stop link stops every email/i);

    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: DESCRIBE_TOOL_NAME, arguments: {} },
      },
      deps
    );
    expect(res).toBeDefined();
    if (!res || !('result' in res)) throw new Error('Expected result');
    const resultObj = res.result;
    if (!resultObj || typeof resultObj !== 'object')
      throw new Error('Result not object');
    expect('isError' in resultObj && resultObj.isError).toBe(false);

    if (
      !('structuredContent' in resultObj) ||
      !resultObj.structuredContent ||
      typeof resultObj.structuredContent !== 'object'
    ) {
      throw new Error('Expected structuredContent');
    }
    const structured = resultObj.structuredContent;
    expect('comment_notices' in structured).toBe(true);
    if (
      'comment_notices' in structured &&
      typeof structured.comment_notices === 'string'
    ) {
      expect(structured.comment_notices).toMatch(
        /emails everyone on its list/i
      );
      expect(structured.comment_notices).toMatch(/10 minutes/);
      expect(structured.comment_notices).toMatch(/stop link/i);
    }
  });

  test('relic_share description mentions comment and change notices, 10-minute limiter, and one stop link', () => {
    const desc = SHARE_TOOL_DEFINITION.description;
    expect(desc).toMatch(/comment/i);
    expect(desc).toMatch(/10 minutes/);
    expect(desc).toMatch(/one stop link stops every email/i);
  });

  test('relic_republish description mentions 10-minute limiter and one stop link', () => {
    const desc = REPUBLISH_TOOL_DEFINITION.description;
    expect(desc).toMatch(/10 minutes/);
    expect(desc).toMatch(/one stop link stops every email/i);
  });
});
