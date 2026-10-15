import { beforeEach, describe, expect, test } from 'bun:test';
import {
  deriveShareProof,
  encryptedSize,
  encryptRelic,
  generateKey,
  generateRelicId,
  shareVerifierFor,
} from '@relic/format';
import { createApp, type Mailer, type RelicApp } from '../src/app.ts';
import { sha256Hex } from '../src/gcs.ts';
import type { OutboundMail } from '../src/mail.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryStore } from '../src/store.ts';

const OPERATOR = new Map([['jason', 'operator-secret']]);

let now = Date.parse('2026-08-02T12:00:00.000Z');
let storage: MemoryStorage;
let store: MemoryStore;
let app: RelicApp;
let sentMails: Array<{ email: string; mail: OutboundMail }>;
let testMailer: Mailer;

function build(overrides: Parameters<typeof createApp>[0] = {}): RelicApp {
  return createApp({
    store: overrides.store ?? store,
    storage: overrides.storage ?? storage,
    now: () => now,
    operatorTokens: OPERATOR,
    mailer: testMailer,
    ...overrides,
  });
}

beforeEach(() => {
  now = Date.parse('2026-08-02T12:00:00.000Z');
  sentMails = [];
  store = new MemoryStore();
  storage = new MemoryStorage();
  testMailer = {
    async send(email, link) {
      sentMails.push({
        email,
        mail: { subject: 'link', text: link, html: link },
      });
    },
    async sendMail(email, mail) {
      sentMails.push({ email, mail });
    },
  };
  app = build();
});

function req(
  path: string,
  init: RequestInit & { ip?: string | undefined } = {}
): Request {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', init.ip ?? '198.51.100.10');
  return new Request(`https://relic.example${path}`, { ...init, headers });
}

async function createSession(
  email = 'reader@example.com',
  expiresAt = now + 3600 * 1000
): Promise<string> {
  const token = `token-${Math.random()}`;
  const tokenHash = await sha256Hex(token);
  await app.store.putSession({
    tokenHash,
    email,
    createdAt: now,
    expiresAt,
  });
  return `relic_session=${token}`;
}

async function publish(
  options: {
    ip?: string | undefined;
    id?: string;
    title?: string;
    ownerEmail?: string;
    ttlDays?: number;
    shareVerifier?: string;
  } = {}
): Promise<{ id: string; key: Uint8Array; grant: Record<string, unknown> }> {
  const challengeResponse = await app.fetch(
    req('/api/challenge', { method: 'POST', ip: options.ip })
  );
  const challenge = (await challengeResponse.json()) as {
    challenge_nonce: string;
  };

  const id = options.id ?? generateRelicId();
  const key = generateKey();

  if (options.ownerEmail !== undefined) {
    await app.store.recordVerifiedIdentity(options.ownerEmail, now);
  }

  const grantResponse = await app.fetch(
    req('/api/grant', {
      method: 'POST',
      ip: options.ip,
      body: JSON.stringify({
        challenge_nonce: challenge.challenge_nonce,
        relic_id: id,
        renderer_class: 'markdown',
        publishing_client: 'relic-mcp/0.1.0 (test)',
        declared_size_bytes: 12,
        declared_ciphertext_bytes: encryptedSize(12),
        ...(options.ttlDays === undefined ? {} : { ttl_days: options.ttlDays }),
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.ownerEmail === undefined
          ? {}
          : { owner_email: options.ownerEmail }),
        ...(options.shareVerifier === undefined
          ? {}
          : { share_verifier: options.shareVerifier }),
      }),
    })
  );
  expect(grantResponse.status).toBe(200);
  const grant = (await grantResponse.json()) as Record<string, unknown>;

  const container = await encryptRelic({
    content: new TextEncoder().encode('hello relic'),
    filename: 'notes.md',
    mimetype: 'text/markdown',
    key,
  });
  storage.put(id, container);

  return { id, key, grant };
}

async function republish(
  id: string,
  token: string | undefined,
  options: {
    notify?: unknown;
    shareVerifier?: unknown;
    title?: string;
  } = {}
): Promise<Response> {
  const body: Record<string, unknown> = {
    renderer_class: 'markdown',
    declared_size_bytes: 12,
    declared_ciphertext_bytes: encryptedSize(12),
    ...(token === undefined ? {} : { publish_token: token }),
    ...(options.title === undefined ? {} : { title: options.title }),
  };
  if ('notify' in options) {
    body['notify'] = options.notify;
  }
  if ('shareVerifier' in options) {
    body['share_verifier'] = options.shareVerifier;
  }
  return app.fetch(
    req(`/api/relics/${id}/republish`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

describe('change notices and relic_share', () => {
  test('1. A republish that lands mails each verified commenter and each shared address exactly once. It never mails publisher or the owner address.', async () => {
    const { id, key, grant } = await publish({
      title: 'Roadmap',
      ownerEmail: 'owner@example.com',
    });
    const token = grant['publish_token'] as string;

    // Commenter 1
    const aliceCookie = await createSession('alice@example.com');
    await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: aliceCookie },
        body: JSON.stringify({ ciphertext: 'YWxpY2U' }),
      })
    );

    // Commenter 2 (publisher using publish_token)
    await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          ciphertext: 'cHVibGlzaGVy',
        }),
      })
    );

    // Share with bob and owner
    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['bob@example.com', 'owner@example.com'],
        }),
      })
    );

    // Clear initial comment notification to owner
    sentMails = [];

    // Republish v2
    const repub = await republish(id, token);
    expect(repub.status).toBe(200);

    const container = await encryptRelic({
      content: new TextEncoder().encode('version 2 content'),
      filename: 'notes.md',
      mimetype: 'text/markdown',
      key,
    });
    storage.put(`${id}/v2`, container);

    const comp = await app.fetch(
      req(`/api/relics/${id}/complete`, { method: 'POST' })
    );
    expect(comp.status).toBe(200);

    // Alice and Bob should each be mailed exactly once.
    // Publisher and owner@example.com must not be mailed.
    expect(sentMails).toHaveLength(2);
    const recipients = sentMails.map((s) => s.email).sort();
    expect(recipients).toEqual(['alice@example.com', 'bob@example.com']);
  });

  test('2. The notice carries the subject and the version, links to https://relic.example/<id> with no #, and has both List-Unsubscribe headers.', async () => {
    const { id, key, grant } = await publish({ title: 'Design Document' });
    const token = grant['publish_token'] as string;

    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['reader@example.com'],
        }),
      })
    );

    sentMails = [];
    const repub = await republish(id, token);
    expect(repub.status).toBe(200);

    storage.put(
      `${id}/v2`,
      await encryptRelic({
        content: new TextEncoder().encode('v2'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    expect(sentMails).toHaveLength(1);
    const mailItem = sentMails[0];
    expect(mailItem).toBeDefined();
    const mail = mailItem?.mail;
    if (mail === undefined) throw new Error('missing mail');
    expect(mail.subject).toBe('New version of "Design Document"');
    expect(mail.text).toContain(
      '"Design Document" has a new version: version 2.'
    );
    expect(mail.text).toContain(`https://relic.example/${id}`);
    expect(mail.text).not.toContain(`https://relic.example/${id}#`);
    expect(mail.html).toContain(`https://relic.example/${id}`);
    expect(mail.html).not.toContain(`https://relic.example/${id}#`);

    expect(mail.headers).toBeDefined();
    expect(mail.headers?.['List-Unsubscribe']).toMatch(
      new RegExp(
        `^<https://relic\\.example/api/relics/${id}/unsubscribe\\?addr=[0-9a-f]{64}&token=[A-Za-z0-9_-]+>$`
      )
    );
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click'
    );
  });

  test('3. notify: false sends nothing, and the next republish notifies again. A non-boolean notify is invalid_publish_metadata.', async () => {
    const { id, key, grant } = await publish({ title: 'Silent Update' });
    const token = grant['publish_token'] as string;

    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['reader@example.com'],
        }),
      })
    );
    sentMails = [];

    // Non-boolean notify is 400 invalid_publish_metadata
    const badRepub = await republish(id, token, { notify: 'false' });
    expect(badRepub.status).toBe(400);
    const badJson = await badRepub.json();
    expect(badJson.code).toBe('invalid_publish_metadata');

    // notify: false republish
    const r2 = await republish(id, token, { notify: false });
    expect(r2.status).toBe(200);
    storage.put(
      `${id}/v2`,
      await encryptRelic({
        content: new TextEncoder().encode('v2'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));
    expect(sentMails).toHaveLength(0);

    // Next republish defaults to notify: true and sends
    const r3 = await republish(id, token);
    expect(r3.status).toBe(200);
    storage.put(
      `${id}/v3`,
      await encryptRelic({
        content: new TextEncoder().encode('v3'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.mail.text).toContain('version 3');
  });

  test('4. An upload that never lands announces nothing: completion answers 409, and a mint answers 409 with 0 mails.', async () => {
    const { id, grant } = await publish({ title: 'Unfinished' });
    const token = grant['publish_token'] as string;

    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['reader@example.com'],
        }),
      })
    );
    sentMails = [];

    await republish(id, token);
    // Object v2 is NEVER put into storage.

    const comp = await app.fetch(
      req(`/api/relics/${id}/complete`, { method: 'POST' })
    );
    expect(comp.status).toBe(409);
    expect(sentMails).toHaveLength(0);

    const mint = await app.fetch(
      req(`/api/relics/${id}/mint`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
    );
    expect(mint.status).toBe(409);
    expect(sentMails).toHaveLength(0);
  });

  test('5. Completion twice, completion then mint, or two completions under Promise.all all produce exactly one batch.', async () => {
    const { id, key, grant } = await publish({ title: 'Batching' });
    const token = grant['publish_token'] as string;
    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['reader@example.com'],
        }),
      })
    );
    sentMails = [];

    await republish(id, token);
    storage.put(
      `${id}/v2`,
      await encryptRelic({
        content: new TextEncoder().encode('v2'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );

    // Two completions under Promise.all
    const [c1, c2] = await Promise.all([
      app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' })),
      app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' })),
    ]);
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);
    expect(sentMails).toHaveLength(1);

    // Followed by mint
    await app.fetch(
      req(`/api/relics/${id}/mint`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
    );
    expect(sentMails).toHaveLength(1);
  });

  test('6. A lost completion is announced once, by the first mint of the current version. Version 1 is never announced.', async () => {
    // Version 1 mint never announces
    sentMails = [];
    const { id, key, grant } = await publish({ title: 'Lost Complete' });
    const token = grant['publish_token'] as string;
    await app.fetch(
      req(`/api/relics/${id}/mint`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
    );
    expect(sentMails).toHaveLength(0);

    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['reader@example.com'],
        }),
      })
    );
    sentMails = [];

    // Republish to v2, upload to storage, but skip complete endpoint
    await republish(id, token);
    storage.put(
      `${id}/v2`,
      await encryptRelic({
        content: new TextEncoder().encode('v2'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );

    // First mint of v2 triggers announce
    const mint1 = await app.fetch(
      req(`/api/relics/${id}/mint`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
    );
    expect(mint1.status).toBe(200);
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.mail.text).toContain('version 2');

    // Second mint of v2 does not send again
    const mint2 = await app.fetch(
      req(`/api/relics/${id}/mint`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
    );
    expect(mint2.status).toBe(200);
    expect(sentMails).toHaveLength(1);
  });

  test('7. Expired, tombstoned, and cap-exhausted relics announce nothing.', async () => {
    // 1. Expired
    const exp = await publish({ title: 'Expired', ttlDays: 1 });
    const expToken = exp.grant['publish_token'] as string;
    await app.fetch(
      req(`/api/relics/${exp.id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: expToken,
          emails: ['reader@example.com'],
        }),
      })
    );
    await republish(exp.id, expToken);
    storage.put(
      `${exp.id}/v2`,
      await encryptRelic({
        content: new TextEncoder().encode('v2'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key: exp.key,
      })
    );
    now += 2 * 86_400 * 1000; // Fast forward past expiration
    sentMails = [];
    await app.fetch(req(`/api/relics/${exp.id}/complete`, { method: 'POST' }));
    expect(sentMails).toHaveLength(0);

    // 2. Tombstoned
    const tomb = await publish({ title: 'Tombstoned' });
    const tombToken = tomb.grant['publish_token'] as string;
    await app.fetch(
      req(`/api/relics/${tomb.id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: tombToken,
          emails: ['reader@example.com'],
        }),
      })
    );
    await republish(tomb.id, tombToken);
    storage.put(
      `${tomb.id}/v2`,
      await encryptRelic({
        content: new TextEncoder().encode('v2'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key: tomb.key,
      })
    );
    // Delete relic as operator
    await app.fetch(
      req(`/api/relics/${tomb.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    sentMails = [];
    await app.fetch(req(`/api/relics/${tomb.id}/complete`, { method: 'POST' }));
    expect(sentMails).toHaveLength(0);

    // 3. Cap-exhausted
    const cap = await publish({ title: 'Capped' });
    const capToken = cap.grant['publish_token'] as string;
    await app.fetch(
      req(`/api/relics/${cap.id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: capToken,
          emails: ['reader@example.com'],
        }),
      })
    );
    await republish(cap.id, capToken);
    storage.put(
      `${cap.id}/v2`,
      await encryptRelic({
        content: new TextEncoder().encode('v2'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key: cap.key,
      })
    );
    const row = await app.store.getRelic(cap.id);
    if (row) row.mintsUsed = 200; // config.downloadCap
    sentMails = [];
    await app.fetch(req(`/api/relics/${cap.id}/complete`, { method: 'POST' }));
    expect(sentMails).toHaveLength(0);
  });

  test('8. A change notice followed by an acknowledgement reply to the same commenter inside the window gives 1 mail. After the window, a new notice goes out.', async () => {
    const { id, key, grant } = await publish({
      title: 'Active Doc',
      ownerEmail: 'owner@example.com',
    });
    const token = grant['publish_token'] as string;
    const commenterSession = await createSession('commenter@example.com');

    // Commenter leaves a comment
    const commentRes = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: commenterSession },
        body: JSON.stringify({ ciphertext: 'Y29tbWVudA' }),
      })
    );
    const commentJson = (await commentRes.json()) as { id: string };

    sentMails = [];

    // Republish at t=0 sends change notice to commenter
    await republish(id, token);
    storage.put(
      `${id}/v2`,
      await encryptRelic({
        content: new TextEncoder().encode('v2'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.email).toBe('commenter@example.com');
    expect(sentMails[0]?.mail.subject).toContain('New version');

    // Inside the 10-minute window (e.g. t = 30s): an answer reply to the commenter's comment
    now += 30 * 1000;
    const replyRes = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          ciphertext: 'cmVwbHk',
          reply_to: commentJson.id,
        }),
      })
    );
    expect(replyRes.status).toBe(201);
    // Rate limit window collapsed the reply notification
    expect(sentMails).toHaveLength(1);

    // After the window (11 minutes later): republish v3 sends notice
    now += 11 * 60 * 1000;
    await republish(id, token);
    storage.put(
      `${id}/v3`,
      await encryptRelic({
        content: new TextEncoder().encode('v3'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));
    expect(sentMails).toHaveLength(2);
    expect(sentMails[1]?.mail.text).toContain('version 3');
  });

  test('9. One send that throws does not stop the others, and completion still answers 200.', async () => {
    const { id, key, grant } = await publish({ title: 'Error handling' });
    const token = grant['publish_token'] as string;

    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['fail@example.com', 'ok@example.com'],
        }),
      })
    );

    testMailer.sendMail = async (email, mail) => {
      if (email === 'fail@example.com') {
        throw new Error('Resend 500 network error');
      }
      sentMails.push({ email, mail });
    };

    await republish(id, token);
    storage.put(
      `${id}/v2`,
      await encryptRelic({
        content: new TextEncoder().encode('v2'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );

    const comp = await app.fetch(
      req(`/api/relics/${id}/complete`, { method: 'POST' })
    );
    expect(comp.status).toBe(200);
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.email).toBe('ok@example.com');
  });

  test('10. Stop link: GET shows form and records nothing; POST stops that address; one-click POST answers 200; tampered token is 400; works with kill switch.', async () => {
    const { id, key, grant } = await publish({ title: 'Unsubscribe Test' });
    const token = grant['publish_token'] as string;

    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['user@example.com'],
        }),
      })
    );

    sentMails = [];
    await republish(id, token);
    storage.put(
      `${id}/v2`,
      await encryptRelic({
        content: new TextEncoder().encode('v2'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    expect(sentMails).toHaveLength(1);
    const rawStopUrl = sentMails[0]?.mail.headers?.['List-Unsubscribe'];
    if (rawStopUrl === undefined) {
      throw new Error('missing List-Unsubscribe header');
    }
    const stopUrl = rawStopUrl.slice(1, -1);
    const stopParsed = new URL(stopUrl);

    // 1. GET shows a form and records nothing
    const getRes = await app.fetch(
      req(stopParsed.pathname + stopParsed.search)
    );
    expect(getRes.status).toBe(200);
    const getHtml = await getRes.text();
    expect(getHtml).toContain('Stop change emails');
    expect(getHtml).toContain('<form method="POST"');
    expect(getHtml).toContain('Stop these emails');

    // Republish v3: user still receives notice because GET did not record opt-out
    now += 15 * 60 * 1000;
    sentMails = [];
    await republish(id, token);
    storage.put(
      `${id}/v3`,
      await encryptRelic({
        content: new TextEncoder().encode('v3'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));
    expect(sentMails).toHaveLength(1);

    // 2. Tampered token or address is 400
    const tampered = await app.fetch(
      req(
        `${stopParsed.pathname}?addr=${stopParsed.searchParams.get('addr')}&token=tampered_token`
      )
    );
    expect(tampered.status).toBe(400);
    expect(await tampered.text()).toContain('This link does not work');

    const tamperedAddr = await app.fetch(
      req(
        `${stopParsed.pathname}?addr=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&token=${stopParsed.searchParams.get('token')}`
      )
    );
    expect(tamperedAddr.status).toBe(400);

    // 3. One-click POST with body List-Unsubscribe=One-Click answers 200 with no location header
    const postRes = await app.fetch(
      req(stopParsed.pathname + stopParsed.search, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      })
    );
    expect(postRes.status).toBe(200);
    expect(postRes.headers.get('location')).toBeNull();
    const postHtml = await postRes.text();
    expect(postHtml).toContain('Stopped');

    // 4. Opt-out recorded: next republish v4 does NOT mail user
    now += 15 * 60 * 1000;
    sentMails = [];
    await republish(id, token);
    storage.put(
      `${id}/v4`,
      await encryptRelic({
        content: new TextEncoder().encode('v4'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));
    expect(sentMails).toHaveLength(0);

    // 5. Unsubscribe still works with kill switch engaged
    app = build({ config: { killSwitchEngaged: true } });
    const killSwitchRes = await app.fetch(
      req(stopParsed.pathname + stopParsed.search, { method: 'POST' })
    );
    expect(killSwitchRes.status).toBe(200);
  });

  test('11. Share: addresses are normalized, a repeat is idempotent (added counts only new ones), and the response carries title.', async () => {
    const { id, grant } = await publish({ title: 'Shared Doc' });
    const token = grant['publish_token'] as string;

    const res1 = await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['  Alice@Example.Com  ', 'bob@example.com'],
        }),
      })
    );
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.emails).toEqual(['alice@example.com', 'bob@example.com']);
    expect(json1.added).toBe(2);
    expect(json1.shared_count).toBe(2);
    expect(json1.share_limit).toBe(50);
    expect(json1.title).toBe('Shared Doc');

    // Repeat with one existing and one new
    const res2 = await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['alice@example.com', 'carol@example.com'],
        }),
      })
    );
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.emails).toEqual(['alice@example.com', 'carol@example.com']);
    expect(json2.added).toBe(1);
    expect(json2.shared_count).toBe(3);
  });

  test('12. Share: a missing or wrong token is 403 and stores nothing. An empty list, a bad entry, or more than 20 is 400 invalid_share and stores nothing. Going past 50 is 409 and stores nothing. Then 410 removed, 404 unknown, 410 relic_expired, 410 download_cap_exhausted, and 429 with the config overridden.', async () => {
    const { id, grant } = await publish({ title: 'Validations', ttlDays: 1 });
    const token = grant['publish_token'] as string;

    // 403 wrong token
    const wrongToken = await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: 'bad-token',
          emails: ['a@example.com'],
        }),
      })
    );
    expect(wrongToken.status).toBe(403);
    expect(await app.store.listShares(id)).toEqual([]);

    // 403 empty token
    const emptyToken = await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: '',
          emails: ['a@example.com'],
        }),
      })
    );
    expect(emptyToken.status).toBe(403);

    // 400 empty list
    const emptyList = await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({ publish_token: token, emails: [] }),
      })
    );
    expect(emptyList.status).toBe(400);

    // 400 bad entry
    const badEntry = await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['good@example.com', 'not-an-email'],
        }),
      })
    );
    expect(badEntry.status).toBe(400);
    expect(await app.store.listShares(id)).toEqual([]);

    // 400 more than 20 emails
    const twentyOne = Array.from(
      { length: 21 },
      (_, i) => `user${i}@example.com`
    );
    const tooMany = await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({ publish_token: token, emails: twentyOne }),
      })
    );
    expect(tooMany.status).toBe(400);

    // Going past 50 is 409
    const batch1 = Array.from({ length: 20 }, (_, i) => `b1_${i}@example.com`);
    const batch2 = Array.from({ length: 20 }, (_, i) => `b2_${i}@example.com`);
    const batch3 = Array.from({ length: 10 }, (_, i) => `b3_${i}@example.com`);
    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({ publish_token: token, emails: batch1 }),
      })
    );
    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({ publish_token: token, emails: batch2 }),
      })
    );
    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({ publish_token: token, emails: batch3 }),
      })
    );
    expect((await app.store.listShares(id)).length).toBe(50);

    // 51st email is refused 409
    const overflow = await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['overflow@example.com'],
        }),
      })
    );
    expect(overflow.status).toBe(409);
    expect((await overflow.json()).code).toBe('share_limit_reached');

    // 404 unknown relic
    const unknownRes = await app.fetch(
      req(`/api/relics/${generateRelicId()}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['x@example.com'],
        }),
      })
    );
    expect(unknownRes.status).toBe(404);

    // 410 relic_expired
    now += 2 * 86_400 * 1000;
    const expiredRes = await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['x@example.com'],
        }),
      })
    );
    expect(expiredRes.status).toBe(410);
    expect((await expiredRes.json()).code).toBe('relic_expired');

    // 410 relic_removed
    const rTomb = await publish({ title: 'Tomb' });
    const rTombToken = rTomb.grant['publish_token'] as string;
    await app.fetch(
      req(`/api/relics/${rTomb.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    const tombRes = await app.fetch(
      req(`/api/relics/${rTomb.id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: rTombToken,
          emails: ['x@example.com'],
        }),
      })
    );
    expect(tombRes.status).toBe(410);
    expect((await tombRes.json()).code).toBe('relic_removed');

    // 410 download_cap_exhausted
    const rCap = await publish({ title: 'Cap' });
    const rCapToken = rCap.grant['publish_token'] as string;
    const rCapRow = await app.store.getRelic(rCap.id);
    if (rCapRow) rCapRow.mintsUsed = 200;
    const capRes = await app.fetch(
      req(`/api/relics/${rCap.id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: rCapToken,
          emails: ['x@example.com'],
        }),
      })
    );
    expect(capRes.status).toBe(410);
    expect((await capRes.json()).code).toBe('download_cap_exhausted');

    // 429 share_rate_limited
    const rRate = await publish({ title: 'Rate' });
    const rRateToken = rRate.grant['publish_token'] as string;
    app = build({
      config: { shareRateLimit: { limit: 1, windowSeconds: 3600 } },
    });
    const s1 = await app.fetch(
      req(`/api/relics/${rRate.id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: rRateToken,
          emails: ['one@example.com'],
        }),
      })
    );
    expect(s1.status).toBe(200);
    const s2 = await app.fetch(
      req(`/api/relics/${rRate.id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: rRateToken,
          emails: ['two@example.com'],
        }),
      })
    );
    expect(s2.status).toBe(429);
    expect((await s2.json()).code).toBe('share_rate_limited');
  });

  test('13. Operator delete removes shares and stop records and returns their counts.', async () => {
    const { id, grant } = await publish({ title: 'To Delete' });
    const token = grant['publish_token'] as string;

    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['share1@example.com', 'share2@example.com'],
        }),
      })
    );
    await app.store.putOptOut({ relicId: id, addressHash: 'hash1', at: now });

    const del = await app.fetch(
      req(`/api/relics/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(del.status).toBe(200);
    const json = await del.json();
    expect(json.shares_deleted).toBe(2);
    expect(json.opt_outs_deleted).toBe(1);

    expect(await app.store.listShares(id)).toEqual([]);
    expect(await app.store.listOptOuts(id)).toEqual([]);
  });

  test('14. The fuse stops sending once changeNoticeRateLimit is overridden low.', async () => {
    app = build({
      config: { changeNoticeRateLimit: { limit: 1, windowSeconds: 3600 } },
    });
    const { id, key, grant } = await publish({ title: 'Fuse Test' });
    const token = grant['publish_token'] as string;

    await app.fetch(
      req(`/api/relics/${id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          emails: ['first@example.com', 'second@example.com'],
        }),
      })
    );
    sentMails = [];

    await republish(id, token);
    storage.put(
      `${id}/v2`,
      await encryptRelic({
        content: new TextEncoder().encode('v2'),
        filename: 'notes.md',
        mimetype: 'text/markdown',
        key,
      })
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    // Only 1 mail went out because limit is 1
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.email).toBe('first@example.com');
  });

  describe('Addendum A3: key proof, reader share, and verifiers', () => {
    test('publish/republish refuse a malformed share_verifier', async () => {
      const chRes1 = await app.fetch(req('/api/challenge', { method: 'POST' }));
      const ch1 = (await chRes1.json()) as { challenge_nonce: string };

      // Short verifier
      const short = await app.fetch(
        req('/api/grant', {
          method: 'POST',
          body: JSON.stringify({
            challenge_nonce: ch1.challenge_nonce,
            relic_id: generateRelicId(),
            renderer_class: 'markdown',
            publishing_client: 'test',
            declared_size_bytes: 12,
            declared_ciphertext_bytes: encryptedSize(12),
            share_verifier: 'abc123',
          }),
        })
      );
      expect(short.status).toBe(400);

      const chRes2 = await app.fetch(req('/api/challenge', { method: 'POST' }));
      const ch2 = (await chRes2.json()) as { challenge_nonce: string };

      // Uppercase characters
      const uppercase = await app.fetch(
        req('/api/grant', {
          method: 'POST',
          body: JSON.stringify({
            challenge_nonce: ch2.challenge_nonce,
            relic_id: generateRelicId(),
            renderer_class: 'markdown',
            publishing_client: 'test',
            declared_size_bytes: 12,
            declared_ciphertext_bytes: encryptedSize(12),
            share_verifier: 'A'.repeat(64),
          }),
        })
      );
      expect(uppercase.status).toBe(400);
      // Republish with malformed verifier
      const { id, grant } = await publish();
      const token = grant['publish_token'] as string;

      const badRepub = await republish(id, token, {
        shareVerifier: 'not-hex',
      });
      expect(badRepub.status).toBe(400);
      expect((await badRepub.json()).code).toBe('invalid_publish_metadata');
    });

    test('reader share refused with both or neither authority (400 invalid_share)', async () => {
      const { id, key, grant } = await publish();
      const token = grant['publish_token'] as string;
      const proof = await deriveShareProof(key);
      const proofStr = Buffer.from(proof).toString('base64url');
      const cookie = await createSession('reader@example.com');

      // Neither authority
      const neither = await app.fetch(
        req(`/api/relics/${id}/share`, {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({ emails: ['friend@example.com'] }),
        })
      );
      expect(neither.status).toBe(400);
      expect((await neither.json()).code).toBe('invalid_share');

      // Both authorities
      const both = await app.fetch(
        req(`/api/relics/${id}/share`, {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({
            publish_token: token,
            share_proof: proofStr,
            emails: ['friend@example.com'],
          }),
        })
      );
      expect(both.status).toBe(400);
      expect((await both.json()).code).toBe('invalid_share');
    });

    test('reader share refused without session', async () => {
      const { id, key } = await publish();
      const proof = await deriveShareProof(key);
      const proofStr = Buffer.from(proof).toString('base64url');

      const noSession = await app.fetch(
        req(`/api/relics/${id}/share`, {
          method: 'POST',
          body: JSON.stringify({
            share_proof: proofStr,
            emails: ['friend@example.com'],
          }),
        })
      );
      expect(noSession.status).toBe(401);
      expect((await noSession.json()).code).toBe('invalid_session');
    });

    test('reader share refused without verifier (409 share_unavailable)', async () => {
      // Published without share_verifier (pre-share relic)
      const { id, key } = await publish();
      const proof = await deriveShareProof(key);
      const proofStr = Buffer.from(proof).toString('base64url');
      const cookie = await createSession('reader@example.com');

      const res = await app.fetch(
        req(`/api/relics/${id}/share`, {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({
            share_proof: proofStr,
            emails: ['friend@example.com'],
          }),
        })
      );
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe('share_unavailable');
      expect(json.detail).toContain(
        'This relic was published before sharing existed'
      );
    });

    test('reader share refused with a wrong proof (403 invalid_share_proof)', async () => {
      const key = generateKey();
      const proof = await deriveShareProof(key);
      const verifier = await shareVerifierFor(proof);
      const { id } = await publish({ shareVerifier: verifier });

      const wrongProof = await deriveShareProof(generateKey());
      const wrongProofStr = Buffer.from(wrongProof).toString('base64url');
      const cookie = await createSession('reader@example.com');

      const res = await app.fetch(
        req(`/api/relics/${id}/share`, {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({
            share_proof: wrongProofStr,
            emails: ['friend@example.com'],
          }),
        })
      );
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('invalid_share_proof');
    });

    test('reader share refused over the per-sharer limit (429 share_rate_limited)', async () => {
      app = build({
        config: {
          readerShareRateLimit: { limit: 1, windowSeconds: 3600 },
        },
      });
      const key = generateKey();
      const proof = await deriveShareProof(key);
      const verifier = await shareVerifierFor(proof);
      const { id } = await publish({ shareVerifier: verifier });
      const proofStr = Buffer.from(proof).toString('base64url');
      const cookie = await createSession('sharer@example.com');

      const s1 = await app.fetch(
        req(`/api/relics/${id}/share`, {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({
            share_proof: proofStr,
            emails: ['one@example.com'],
          }),
        })
      );
      expect(s1.status).toBe(200);

      const s2 = await app.fetch(
        req(`/api/relics/${id}/share`, {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({
            share_proof: proofStr,
            emails: ['two@example.com'],
          }),
        })
      );
      expect(s2.status).toBe(429);
      expect((await s2.json()).code).toBe('share_rate_limited');
    });

    test('a reader share with a valid proof and session enrolls addresses that then receive exactly one change notice on the next landed republish with the reader-share reason', async () => {
      const key = generateKey();
      const proof = await deriveShareProof(key);
      const verifier = await shareVerifierFor(proof);
      const { id, grant } = await publish({
        title: 'Collaborative Spec',
        shareVerifier: verifier,
      });
      const token = grant['publish_token'] as string;

      const proofStr = Buffer.from(proof).toString('base64url');
      const cookie = await createSession('reader_sharer@example.com');

      // Reader shares with bob
      const shareRes = await app.fetch(
        req(`/api/relics/${id}/share`, {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({
            share_proof: proofStr,
            emails: ['bob@example.com'],
          }),
        })
      );
      expect(shareRes.status).toBe(200);

      sentMails = [];

      // Republish v2
      await republish(id, token);
      storage.put(
        `${id}/v2`,
        await encryptRelic({
          content: new TextEncoder().encode('v2'),
          filename: 'notes.md',
          mimetype: 'text/markdown',
          key,
        })
      );
      await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

      expect(sentMails).toHaveLength(1);
      const mail = sentMails[0];
      expect(mail).toBeDefined();
      expect(mail?.email).toBe('bob@example.com');
      expect(mail?.mail.text).toContain(
        "someone with this relic's link shared it with you"
      );
      expect(mail?.mail.html).toContain(
        "someone with this relic's link shared it with you"
      );
    });

    test('no endpoint ever returns the share list or the verifier', async () => {
      const key = generateKey();
      const proof = await deriveShareProof(key);
      const verifier = await shareVerifierFor(proof);
      const { id, grant } = await publish({
        title: 'Secret Verifier',
        shareVerifier: verifier,
      });
      const token = grant['publish_token'] as string;

      // Grant response check
      expect(JSON.stringify(grant)).not.toContain(verifier);

      // Share response check
      const shareRes = await app.fetch(
        req(`/api/relics/${id}/share`, {
          method: 'POST',
          body: JSON.stringify({
            publish_token: token,
            emails: ['hidden@example.com'],
          }),
        })
      );
      const shareJson = await shareRes.json();
      expect(JSON.stringify(shareJson)).not.toContain(verifier);
      // Returns only emails in the request, not existing share list from store
      expect(shareJson.emails).toEqual(['hidden@example.com']);
      expect(shareJson.shares).toBeUndefined();

      // Republish response check
      const repubRes = await republish(id, token, { shareVerifier: verifier });
      const repubJson = await repubRes.json();
      expect(JSON.stringify(repubJson)).not.toContain(verifier);

      // Complete response check
      storage.put(
        `${id}/v2`,
        await encryptRelic({
          content: new TextEncoder().encode('v2'),
          filename: 'notes.md',
          mimetype: 'text/markdown',
          key,
        })
      );
      const compRes = await app.fetch(
        req(`/api/relics/${id}/complete`, { method: 'POST' })
      );
      const compJson = await compRes.json();
      expect(JSON.stringify(compJson)).not.toContain(verifier);
      expect(JSON.stringify(compJson)).not.toContain('hidden@example.com');

      // Mint response check
      const mintRes = await app.fetch(
        req(`/api/relics/${id}/mint`, {
          method: 'POST',
          body: JSON.stringify({}),
        })
      );
      const mintJson = await mintRes.json();
      expect(JSON.stringify(mintJson)).not.toContain(verifier);
      expect(JSON.stringify(mintJson)).not.toContain('hidden@example.com');
    });
  });
});
