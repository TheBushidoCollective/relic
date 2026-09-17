/**
 * Outbound mail, over Resend's HTTP API.
 *
 * One call, no SDK. The service had exactly one dependency before this and
 * still does: a `fetch` against a documented endpoint is smaller than a
 * package, and the whole surface here is a single POST.
 *
 * What this file will not do is decide that a failure is unimportant. The
 * mailer it returns throws, loudly and with the provider's own reason
 * attached, and the caller decides what a failed send costs the response.
 */
import type { Mailer } from './app.ts';

const ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend refuses a request with no `User-Agent` outright, with a 403 rather
 * than a validation error, which reads exactly like a bad key. Stated in their
 * API reference, and cheap to satisfy.
 */
const USER_AGENT = 'relic/1.0 (+https://relik.link)';

/** What Resend said when it refused, so a log line names the actual cause. */
export class MailRefusedError extends Error {
  constructor(
    readonly status: number,
    /** Resend's own error name, when the body carried one. */
    readonly code: string,
    detail: string
  ) {
    super(`resend refused with ${status} ${code}: ${detail}`);
  }
}

export interface ResendMailerOptions {
  readonly apiKey: string;
  /** `Name <address@domain>` or a bare address, on the verified domain. */
  readonly from: string;
  /** Injected so a test asserts the request without a network. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected so a test reads the warning instead of the console. */
  readonly log?: (message: string) => void;
}

export interface OutboundMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * The body of the sign-in mail.
 *
 * Plain text as well as HTML, deliberately. Resend will synthesize a text part
 * from the HTML if one is missing, and a synthesized part is a worse version of
 * the one sentence this message actually contains.
 *
 * The link is the whole message. No branding, no marketing, nothing that reads
 * like a newsletter, because a message that looks like an announcement is a
 * message a spam filter treats like one.
 */
export function signInMail(link: string): OutboundMail {
  const subject = 'Your Relic sign-in link';
  const text = [
    'Open this link to comment on the relic you were reading:',
    '',
    link,
    '',
    'The link is single use and expires shortly. If you did not ask to sign',
    'in, nothing has happened and you can ignore this message.',
  ].join('\n');
  // Escaping matters even here: the link carries a token this service
  // generated, but it is still interpolated into markup, and a mail client is
  // a renderer like any other.
  const href = escapeHtml(link);
  const html = [
    '<p>Open this link to comment on the relic you were reading:</p>',
    `<p><a href="${href}">${href}</a></p>`,
    '<p>The link is single use and expires shortly. If you did not ask to ',
    'sign in, nothing has happened and you can ignore this message.</p>',
  ].join('');
  return { subject, text, html };
}

/**
 * Notification sent to a relic creator when a comment arrives.
 *
 * The service holds ciphertext it cannot read and never holds the key, so this
 * message names the relic title and who commented, but cannot quote the comment
 * or provide a direct decryption link.
 */
export function commentNotificationMail(
  title: string | undefined,
  commenter: string
): OutboundMail {
  const subject = title
    ? `New comment on "${title}"`
    : 'New comment on your relic';
  const text = [
    title
      ? `${commenter} left a comment on "${title}".`
      : `${commenter} left a comment on your relic.`,
    '',
    'Open the link you hold for this relic to read and answer the comment.',
    '',
    'Relic does not store the decryption key on its servers, so comments cannot be read from this email.',
  ].join('\n');
  const safeCommenter = escapeHtml(commenter);
  const safeTitle = title ? escapeHtml(title) : undefined;
  const html = [
    `<p>${safeCommenter} left a comment on ${safeTitle ? `<strong>${safeTitle}</strong>` : 'your relic'}.</p>`,
    '<p>Open the link you hold for this relic to read and answer the comment.</p>',
    '<p>Relic does not store the decryption key on its servers, so comments cannot be read from this email.</p>',
  ].join('');
  return { subject, text, html };
}

/**
 * Notification sent to a commenter when their comment is answered.
 */
export function replyNotificationMail(
  title: string | undefined,
  replier: string
): OutboundMail {
  const subject = title
    ? `Your comment on "${title}" was answered`
    : 'Your comment on a relic was answered';
  const text = [
    title
      ? `${replier} answered your comment on "${title}".`
      : `${replier} answered your comment on a relic.`,
    '',
    'Open the link you hold for this relic to read the reply.',
    '',
    'Relic does not store the decryption key on its servers, so comments cannot be read from this email.',
  ].join('\n');
  const safeReplier = escapeHtml(replier);
  const safeTitle = title ? escapeHtml(title) : undefined;
  const html = [
    `<p>${safeReplier} answered your comment on ${safeTitle ? `<strong>${safeTitle}</strong>` : 'a relic'}.</p>`,
    '<p>Open the link you hold for this relic to read the reply.</p>',
    '<p>Relic does not store the decryption key on its servers, so comments cannot be read from this email.</p>',
  ].join('');
  return { subject, text, html };
}
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The quota Resend reports on every accepted send.
 *
 * This exists because of a failure found live: a probe send returned 200 with
 * an id and `x-resend-daily-quota: 0`. On the free tier the daily allowance is
 * a hard stop that PAUSES sending rather than refusing it, so at zero a
 * sign-in link is accepted, never delivered, and nothing in the response says
 * so. A 200 is a 200. These headers are the only warning there is.
 */
export const QUOTA_WARN_AT = 10;

/** What the headers said, and whether it is worth saying out loud. */
export function quotaWarning(
  headers: Pick<Headers, 'get'>
): string | undefined {
  const read = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : undefined;
  };

  const daily = read('x-resend-daily-quota');
  const monthly = read('x-resend-monthly-quota');
  const left = [
    ...(daily !== undefined && daily <= QUOTA_WARN_AT
      ? [`daily ${daily}`]
      : []),
    ...(monthly !== undefined && monthly <= QUOTA_WARN_AT
      ? [`monthly ${monthly}`]
      : []),
  ];
  if (left.length === 0) return undefined;

  return daily === 0 || monthly === 0
    ? `relic: Resend quota is spent (${left.join(', ')} remaining). Sends ` +
        'are accepted and paused, so sign-in links will not arrive until it ' +
        'resets.'
    : `relic: Resend quota is nearly spent (${left.join(', ')} remaining). ` +
        'At zero, sends are accepted and paused rather than refused.';
}

/**
 * A mailer that actually sends.
 *
 * Resend answering 200 means Resend accepted the message, not that it arrived.
 * That distinction is real and this code cannot close it: what it can do is
 * refuse to report an acceptance it did not get.
 */
export function resendMailer(options: ResendMailerOptions): Mailer {
  const call = options.fetch ?? globalThis.fetch;

  async function post(to: string, mail: OutboundMail): Promise<void> {
    const response = await call(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        from: options.from,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    });

    if (response.ok) {
      // An accepted send is not a delivered one, and this is the only place
      // the difference is visible before a reader reports it.
      const warning = quotaWarning(response.headers);
      if (warning !== undefined) (options.log ?? console.error)(warning);
      return;
    }

    // The body is the only place the reason lives. A status alone cannot
    // tell an unverified domain from a suspended key, and those are
    // different jobs for whoever reads the log.
    let code = 'unknown';
    let detail = '';
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body['name'] === 'string') code = body['name'];
      else if (typeof body['code'] === 'string') code = body['code'];
      if (typeof body['message'] === 'string') detail = body['message'];
    } catch {
      // A refusal with an unreadable body is still a refusal, and the status
      // is worth more than nothing.
    }
    throw new MailRefusedError(response.status, code, detail);
  }

  return {
    async send(email: string, link: string): Promise<void> {
      return post(email, signInMail(link));
    },
    async sendMail(email: string, mail: OutboundMail): Promise<void> {
      return post(email, mail);
    },
  };
}

/**
 * The mailer the deployment gets, or nothing, said out loud.
 *
 * `NULL_MAILER` exists so a deployment without mail cannot leak addresses to a
 * half-built integration. Its comment claimed the resulting failure was loud.
 * It was not: the sign-in endpoint answers 202 whether or not anything was
 * sent, on purpose, so an unconfigured deployment looks exactly like a working
 * one from the outside. This is the line that makes it loud, on the inside.
 */
export function mailerFromEnv(
  env: Record<string, string | undefined>,
  log: (message: string) => void = console.error
): Mailer | undefined {
  const apiKey = env['RELIC_RESEND_API_KEY'];
  const from = env['RELIC_MAIL_FROM'];
  if (
    apiKey !== undefined &&
    apiKey.length > 0 &&
    from !== undefined &&
    from.length > 0
  ) {
    return resendMailer({ apiKey, from });
  }

  const missing = [
    ...(apiKey === undefined || apiKey.length === 0
      ? ['RELIC_RESEND_API_KEY']
      : []),
    ...(from === undefined || from.length === 0 ? ['RELIC_MAIL_FROM'] : []),
  ];
  log(
    `relic: mail is not configured (${missing.join(', ')} unset). ` +
      'Sign-in links will not be sent, and the request endpoint will still ' +
      'answer 202, so nobody can complete a comment.'
  );
  return undefined;
}
