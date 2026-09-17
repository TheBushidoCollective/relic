import { describe, expect, test } from 'bun:test';
import {
  commentNotificationMail,
  MailRefusedError,
  mailerFromEnv,
  quotaWarning,
  replyNotificationMail,
  resendMailer,
  signInMail,
} from '../src/mail.ts';

const LINK = 'https://relik.link/api/auth/callback?token=abc123&next=%2Fx';

/** Captures one outbound request without a network. */
function recorder(response: Response): {
  readonly calls: { url: string; init: RequestInit }[];
  readonly fetch: typeof globalThis.fetch;
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return response;
    }) as typeof globalThis.fetch,
  };
}

function accepted(): Response {
  return new Response(JSON.stringify({ id: 'e1' }), { status: 200 });
}

describe('the quota Resend reports on an accepted send', () => {
  // Found live: a probe returned 200 with an id and a daily quota of 0. The
  // free tier pauses sending at the wall instead of refusing, so this is the
  // difference between a link that is late and a link that never comes.
  const headers = (values: Record<string, string>): Pick<Headers, 'get'> => ({
    get: (name: string) => values[name.toLowerCase()] ?? null,
  });

  test('a spent daily quota says the link will not arrive', () => {
    const said = quotaWarning(headers({ 'x-resend-daily-quota': '0' }));
    expect(said).toContain('spent');
    expect(said).toContain('will not arrive');
  });

  test('a nearly spent quota warns before the wall, not at it', () => {
    const said = quotaWarning(headers({ 'x-resend-daily-quota': '3' }));
    expect(said).toContain('nearly spent');
    expect(said).toContain('daily 3');
  });

  test('headroom says nothing at all', () => {
    expect(
      quotaWarning(
        headers({
          'x-resend-daily-quota': '90',
          'x-resend-monthly-quota': '2900',
        })
      )
    ).toBeUndefined();
  });

  test('a monthly wall counts even with daily headroom', () => {
    const said = quotaWarning(
      headers({ 'x-resend-daily-quota': '90', 'x-resend-monthly-quota': '0' })
    );
    expect(said).toContain('spent');
    expect(said).toContain('monthly 0');
    expect(said).not.toContain('daily');
  });

  test('absent or unparseable headers are not a warning', () => {
    expect(quotaWarning(headers({}))).toBeUndefined();
    expect(
      quotaWarning(headers({ 'x-resend-daily-quota': 'unknown' }))
    ).toBeUndefined();
  });

  test('an accepted send at the wall logs, and still succeeds', async () => {
    const said: string[] = [];
    const wire = recorder(
      new Response(JSON.stringify({ id: 'e1' }), {
        status: 200,
        headers: { 'x-resend-daily-quota': '0' },
      })
    );
    await resendMailer({
      apiKey: 're_test_key',
      from: 'no-reply@relik.link',
      fetch: wire.fetch,
      log: (message) => said.push(message),
    }).send('ada@example.com', LINK);

    // Not an error: Resend took it. The reader still gets nothing, and that
    // is what the line has to say.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('quota is spent');
  });
});

describe('the sign-in mail', () => {
  test('the link is the message, in both parts', () => {
    const mail = signInMail(LINK);
    expect(mail.subject).toBe('Your Relic sign-in link');
    expect(mail.text).toContain(LINK);
    // Single use and expiring is the part a recipient needs, and the part that
    // makes an unexpected message safe to ignore.
    expect(mail.text).toContain('single use');
    expect(mail.text).toContain('did not ask');
  });

  test('the link is escaped into the markup, not pasted into it', () => {
    // A token is service-generated, and it is still interpolated into markup
    // that a mail client renders.
    const mail = signInMail('https://relik.link/cb?a=1&b="><script>x</script>');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&amp;');
    expect(mail.html).toContain('&quot;');
  });
});
describe('the comment notification mail', () => {
  test('names the title and commenter when title is present', () => {
    const mail = commentNotificationMail(
      'Q3 Strategy Brief',
      'ada@example.com'
    );
    expect(mail.subject).toBe('New comment on "Q3 Strategy Brief"');
    expect(mail.text).toContain(
      'ada@example.com left a comment on "Q3 Strategy Brief".'
    );
    expect(mail.text).toContain(
      'Open the link you hold for this relic to read and answer the comment.'
    );
    expect(mail.text).toContain('Relic does not store the decryption key');
    expect(mail.html).toContain('ada@example.com');
    expect(mail.html).toContain('<strong>Q3 Strategy Brief</strong>');
    expect(mail.html).toContain('Relic does not store the decryption key');
  });

  test('uses fallback phrasing when title is absent', () => {
    const mail = commentNotificationMail(undefined, 'ada@example.com');
    expect(mail.subject).toBe('New comment on your relic');
    expect(mail.text).toContain(
      'ada@example.com left a comment on your relic.'
    );
    expect(mail.html).toContain('your relic');
  });

  test('escapes HTML in title and commenter', () => {
    const mail = commentNotificationMail(
      '<script>alert("xss")</script>',
      'b"o&b<x>@example.com'
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('&amp;');
    expect(mail.html).toContain('&quot;');
  });

  test('carries no comment body, no fragment, and no key', () => {
    const mail = commentNotificationMail('Notes', 'ada@example.com');
    expect(mail.text).not.toContain('#');
    expect(mail.html).not.toContain('#');
    expect(mail.text).not.toContain('comment_id');
    expect(mail.html).not.toContain('comment_id');
  });
});

describe('the reply notification mail', () => {
  test('names the title and replier when title is present', () => {
    const mail = replyNotificationMail('Q3 Strategy Brief', 'publisher');
    expect(mail.subject).toBe(
      'Your comment on "Q3 Strategy Brief" was answered'
    );
    expect(mail.text).toContain(
      'publisher answered your comment on "Q3 Strategy Brief".'
    );
    expect(mail.text).toContain(
      'Open the link you hold for this relic to read the reply.'
    );
    expect(mail.html).toContain('publisher');
    expect(mail.html).toContain('<strong>Q3 Strategy Brief</strong>');
  });

  test('uses fallback phrasing when title is absent', () => {
    const mail = replyNotificationMail(undefined, 'bob@example.com');
    expect(mail.subject).toBe('Your comment on a relic was answered');
    expect(mail.text).toContain(
      'bob@example.com answered your comment on a relic.'
    );
    expect(mail.html).toContain('a relic');
  });

  test('escapes HTML in title and replier', () => {
    const mail = replyNotificationMail(
      '<img src=x onerror=1>',
      'bob<script>@example.com'
    );
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;img');
  });

  test('carries no comment body, no fragment, and no key', () => {
    const mail = replyNotificationMail('Notes', 'bob@example.com');
    expect(mail.text).not.toContain('#');
    expect(mail.html).not.toContain('#');
    expect(mail.text).not.toContain('comment_id');
    expect(mail.html).not.toContain('comment_id');
  });
});

describe('sending through Resend', () => {
  test('the request is the documented one', async () => {
    const wire = recorder(accepted());
    await resendMailer({
      apiKey: 're_test_key',
      from: 'Relic <no-reply@relik.link>',
      fetch: wire.fetch,
    }).send('ada@example.com', LINK);

    const call = wire.calls[0];
    if (call === undefined) throw new Error('nothing was sent');
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.init.method).toBe('POST');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer re_test_key');
    // Resend answers 403 to a request with no user agent, which reads exactly
    // like a bad key. Omitting it costs an afternoon.
    expect(headers['user-agent']).toContain('relic/');
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body['from']).toBe('Relic <no-reply@relik.link>');
    expect(body['to']).toBe('ada@example.com');
    expect(body['subject']).toBe('Your Relic sign-in link');
    expect(String(body['text'])).toContain(LINK);
    expect(String(body['html'])).toContain('href=');
  });

  test('the key is never in the body it sends', async () => {
    const wire = recorder(accepted());
    await resendMailer({
      apiKey: 're_secret_value',
      from: 'no-reply@relik.link',
      fetch: wire.fetch,
    }).send('ada@example.com', LINK);
    expect(String(wire.calls[0]?.init.body)).not.toContain('re_secret_value');
  });

  test('an unverified domain is reported as itself', async () => {
    // The refusal that will actually happen first, before DNS propagates.
    const wire = recorder(
      new Response(
        JSON.stringify({
          statusCode: 403,
          name: 'validation_error',
          message: 'The relik.link domain is not verified.',
        }),
        { status: 403 }
      )
    );
    const send = resendMailer({
      apiKey: 're_test_key',
      from: 'no-reply@relik.link',
      fetch: wire.fetch,
    }).send('ada@example.com', LINK);

    await expect(send).rejects.toBeInstanceOf(MailRefusedError);
    await send.catch((error: MailRefusedError) => {
      expect(error.status).toBe(403);
      expect(error.code).toBe('validation_error');
      // The operator has to be able to tell this from a bad key without
      // guessing, so the provider's own sentence rides along.
      expect(error.message).toContain('not verified');
    });
  });

  test('a refusal with an unreadable body is still a refusal', async () => {
    const wire = recorder(
      new Response('<html>gateway</html>', { status: 502 })
    );
    const send = resendMailer({
      apiKey: 're_test_key',
      from: 'no-reply@relik.link',
      fetch: wire.fetch,
    }).send('ada@example.com', LINK);
    await expect(send).rejects.toBeInstanceOf(MailRefusedError);
    await send.catch((error: MailRefusedError) => {
      expect(error.status).toBe(502);
      expect(error.code).toBe('unknown');
    });
  });
  test('sendMail sends custom outbound mail through the wire', async () => {
    const wire = recorder(accepted());
    const mailer = resendMailer({
      apiKey: 're_test_key',
      from: 'Relic <no-reply@relik.link>',
      fetch: wire.fetch,
    });
    const notification = commentNotificationMail('Report', 'ada@example.com');
    await mailer.sendMail?.('creator@example.com', notification);

    const call = wire.calls[0];
    if (call === undefined) throw new Error('nothing was sent');
    expect(call.url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body['to']).toBe('creator@example.com');
    expect(body['subject']).toBe('New comment on "Report"');
    expect(String(body['text'])).toContain('ada@example.com left a comment');
  });
});

describe('what the deployment gets', () => {
  test('both halves present builds a real mailer', () => {
    const said: string[] = [];
    const mailer = mailerFromEnv(
      {
        RELIC_RESEND_API_KEY: 're_test_key',
        RELIC_MAIL_FROM: 'no-reply@relik.link',
      },
      (message) => said.push(message)
    );
    expect(mailer).not.toBeUndefined();
    expect(said).toEqual([]);
  });

  test('a missing key is said out loud, and names what it costs', () => {
    // The defect this replaces: an unconfigured deployment was indistinguishable
    // from a working one, because the endpoint answers 202 either way.
    const said: string[] = [];
    const mailer = mailerFromEnv(
      { RELIC_MAIL_FROM: 'no-reply@relik.link' },
      (message) => said.push(message)
    );
    expect(mailer).toBeUndefined();
    expect(said[0]).toContain('RELIC_RESEND_API_KEY');
    expect(said[0]).toContain('202');
  });

  test('a missing from address is not papered over with a default', () => {
    // Guessing a from address means guessing a verified domain, and a wrong
    // guess is a 403 on every send.
    const said: string[] = [];
    expect(
      mailerFromEnv({ RELIC_RESEND_API_KEY: 're_test_key' }, (message) =>
        said.push(message)
      )
    ).toBeUndefined();
    expect(said[0]).toContain('RELIC_MAIL_FROM');
  });

  test('an empty string is unset, not configured', () => {
    // Terraform passes "" for an unset variable, which is the shape this will
    // actually arrive in before the flag is flipped.
    const said: string[] = [];
    expect(
      mailerFromEnv(
        { RELIC_RESEND_API_KEY: '', RELIC_MAIL_FROM: '' },
        (message) => said.push(message)
      )
    ).toBeUndefined();
    expect(said[0]).toContain('RELIC_RESEND_API_KEY');
    expect(said[0]).toContain('RELIC_MAIL_FROM');
  });
});
