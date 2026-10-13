/**
 * The agent's comment round trip, as a repeatable command.
 *
 *   bun test/comment-path.ts
 *
 * A sibling of `source-versioning-path.ts` rather than an extension of it,
 * because it asserts a different thing: that half of the comment feature works
 * for the party that cannot receive email. It publishes, comments, reads the
 * comment back from a *fresh process* holding nothing but the state file,
 * shows the stored row is ciphertext, and proves a relic this machine did not
 * publish is refused.
 *
 * The service is a real HTTP listener on loopback rather than a fetch stub, so
 * the fresh process talks to it exactly as it would talk to Relic, and the
 * body it stores can be inspected the way an operator would see it.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import { COMMENT_TOOL_NAME, READ_COMMENTS_TOOL_NAME } from '../src/server.ts';
import { publishStatePath } from '../src/state.ts';

interface CommentRow {
  comment_id: string;
  author: string;
  created_at: string;
  ciphertext: string;
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'relic-comment-path-'));
process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');

const rows: CommentRow[] = [];
let acceptedToken: string | undefined;

const service = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/challenge') {
      return Response.json({
        challenge_nonce: 'comment-path-challenge',
        size_limit_bytes: 1_000_000,
        size_basis: 'plaintext',
      });
    }
    if (url.pathname === '/api/grant') {
      return Response.json({
        publish_token: 'comment-path-publish-token',
        upload_url: `${origin()}/upload`,
        relic_expires_at: null,
        report_url: `${origin()}/abuse`,
        disclosure_url: `${origin()}/disclosure`,
      });
    }
    if (url.pathname === '/upload') return new Response(null, { status: 200 });
    if (url.pathname.endsWith('/complete')) return Response.json({});

    if (url.pathname.endsWith('/comments')) {
      if (request.method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>;
        // The service authorizes on the token and stores what it is given. It
        // has no key, so the body is opaque to it by construction.
        acceptedToken = String(body['publish_token']);
        const row = {
          comment_id: `c${rows.length + 1}`,
          author: 'publisher',
          created_at: new Date(
            Date.UTC(2026, 7, 20, rows.length)
          ).toISOString(),
          ciphertext: String(body['ciphertext']),
        };
        rows.push(row);
        return Response.json({
          comment_id: row.comment_id,
          author: row.author,
          created_at: row.created_at,
        });
      }
      return Response.json(rows);
    }

    return new Response(null, { status: 404 });
  },
});

function origin(): string {
  return `http://127.0.0.1:${service.port}`;
}

/** A fresh process, holding nothing but the state file on disk. */
async function callFresh(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(['bun', join(packageRoot, 'src', 'index.ts')], {
    cwd: packageRoot,
    env: {
      ...process.env,
      RELIC_CHROME_PATH: 'none',
      RELIC_SERVICE_ORIGIN: origin(),
      RELIC_PUBLISH_STATE: publishStatePath(),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`
  );
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(exit, 0, stderr);
  assert.equal(stderr, '');
  const response = JSON.parse(stdout.trim()) as Record<string, unknown>;
  return response['result'] as Record<string, unknown>;
}

try {
  const deps: PublishDeps = {
    serviceOrigin: origin(),
    relicOrigin: origin(),
    files: nodeFiles,
    fetch: globalThis.fetch,
    clientName: 'relic-mcp/comment-path',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'comment-path test runner',
    }),
  };

  const path = join(scratch, 'report.md');
  await writeFile(path, '# quarterly report\n\nDraft for review.\n');
  const published = await publish({ path }, deps);
  const relicId = published.relic_id;
  console.log(`PUBLISHED relic_id=${relicId}`);

  const body = 'The second chart still uses last quarter numbers.';
  const written = await callFresh(COMMENT_TOOL_NAME, {
    relic_id: relicId,
    body,
    display_name: 'Relic Agent',
  });
  assert.equal(written['isError'], false, JSON.stringify(written));
  const writtenContent = written['structuredContent'] as Record<
    string,
    unknown
  >;
  assert.equal(writtenContent['author'], 'publisher');
  assert.equal(acceptedToken, 'comment-path-publish-token');
  console.log(
    `COMMENTED comment_id=${writtenContent['comment_id']} ` +
      `author=${writtenContent['author']}`
  );

  // What the operator holds. Nothing in it is the comment.
  const storedRow = rows[0];
  assert.ok(storedRow);
  assert.ok(!storedRow.ciphertext.includes('chart'));
  assert.ok(!storedRow.ciphertext.includes('quarter'));
  console.log(
    `STORED_CIPHERTEXT ${storedRow.ciphertext.slice(0, 32)}... ` +
      `(${storedRow.ciphertext.length} chars, contains_plaintext=false)`
  );

  const read = await callFresh(READ_COMMENTS_TOOL_NAME, { relic_id: relicId });
  assert.equal(read['isError'], false, JSON.stringify(read));
  const readContent = read['structuredContent'] as Record<string, unknown>;
  assert.equal(readContent['count'], 1);
  assert.equal(readContent['unreadable_count'], 0);
  const comments = readContent['comments'] as Record<string, unknown>[];
  assert.equal(comments[0]?.['body'], body);
  assert.equal(comments[0]?.['display_name'], 'Relic Agent');
  assert.equal(comments[0]?.['author'], 'publisher');
  console.log(
    `READ_BACK count=${readContent['count']} ` +
      `author=${comments[0]?.['author']} body=${JSON.stringify(
        comments[0]?.['body']
      )}`
  );

  // A relic this machine never published: no key, no token, refused before any
  // network call.
  const elsewhere = await callFresh(READ_COMMENTS_TOOL_NAME, {
    relic_id: '01jw0000000000000000000000',
  });
  assert.equal(elsewhere['isError'], true);
  const elsewhereContent = elsewhere['structuredContent'] as Record<
    string,
    unknown
  >;
  assert.equal(elsewhereContent['code'], 'no_local_publish_state');
  const elsewhereText = JSON.stringify(elsewhere['content']);
  assert.match(elsewhereText, /published from another machine/);
  console.log(`REFUSED_ELSEWHERE code=${elsewhereContent['code']}`);

  // A share URL is never an argument, so the key never enters a transcript
  // for a comment.
  const urlAttempt = await callFresh(READ_COMMENTS_TOOL_NAME, {
    relic_id: published.url,
  });
  assert.equal(urlAttempt['isError'], true);
  assert.match(
    JSON.stringify(urlAttempt['content']),
    /never the share URL: the URL carries the key in its fragment/
  );
  console.log('REFUSED_URL_ARGUMENT code=no_local_publish_state');

  console.log('COMMENT_PATH_OK');
} finally {
  service.stop(true);
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(scratch, { recursive: true, force: true });
}
