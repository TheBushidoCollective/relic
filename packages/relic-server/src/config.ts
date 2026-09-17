/**
 * Every operating number, in one place, each traceable to `docs/decisions.md`.
 *
 * Nothing here is a magic constant. A value that cannot be accounted for is a
 * value nobody can defend when it turns out to be wrong.
 */

import { ciphertextCapBytes, PLAINTEXT_CAP_BYTES } from '@relic/format';

export interface RelicConfig {
  /** The service origin: the API and the PWA shell. */
  readonly serviceOrigin: string;
  /**
   * The usercontent origin, where untrusted HTML renders. A distinct
   * registrable domain, never a subdomain of the service (`preconditions.md`
   * section 2).
   */
  readonly usercontentOrigin: string;

  /** Published cap, on plaintext, verifiable with `ls`. */
  readonly plaintextCapBytes: number;
  /** The signed grant's ciphertext constraint, derived from the above. */
  readonly ciphertextCapBytes: number;

  /**
   * The largest publisher-supplied lifetime, in days, that a grant will
   * record. Bounds the opt-in so a lifetime stays a commitment inside the
   * storage arithmetic the operator already pays for, not an open-ended one.
   */
  readonly maxTtlDays: number;
  /** Signed download URL validity. */
  readonly urlValiditySeconds: number;
  /** Below this, a clamped mint is refused rather than issuing a dying URL. */
  readonly minViableValiditySeconds: number;
  /** Per-object download cap, priced against the Defender-tenant arithmetic. */
  readonly downloadCap: number;
  /** Repeat mints from one IP inside this window are not distinct opens. */
  readonly mintDedupSeconds: number;
  /** Opens inside this window of publish are dropped from the metric. */
  readonly postPublishWindowSeconds: number;
  /**
   * How long the mint log and tombstones live. Relics with a publisher-set
   * lifetime can outlive this; `assertConfig` says why that is allowed.
   */
  readonly retentionSeconds: number;
  /** How long a publish challenge nonce stays valid. */
  readonly challengeTtlSeconds: number;
  /** Published abuse-response SLA, from arrival. */
  readonly abuseSlaHours: number;

  readonly publishRateLimit: RateLimitConfig;
  readonly mintRateLimit: RateLimitConfig;
  /**
   * Comment writes per IP. Lower than publishing, because a comment costs
   * the writer nothing to produce and the thread is the one surface a
   * link-holder can add to.
   */
  readonly commentRateLimit: RateLimitConfig;
  /** Sign-in requests per IP. Each one can send mail, so it is the tightest. */
  readonly authRateLimit: RateLimitConfig;
  /**
   * Comment notification sends per recipient per relic.
   * Collapses repeats inside the window and caps outbound mail volume.
   */
  readonly notificationRateLimit: RateLimitConfig;
  /**
   * The longest comment ciphertext the server will store, in base64url
   * characters. It is a transport bound, not a plaintext one: the real caps
   * are 4096 and 64 bytes, enforced in `@relic/format` before encryption
   * (`format.md` 3.13), and cannot be recomputed from ciphertext. This
   * number only stops an unbounded body from reaching the store.
   */
  readonly commentCiphertextCapChars: number;
  /** How long a magic link stays followable. Short: it arrives by mail. */
  readonly authLinkTtlSeconds: number;
  /** How long a verified session lasts before the reader signs in again. */
  readonly sessionTtlSeconds: number;

  /** Engaged when egress spend crosses the ceiling. Refuses every mint. */
  readonly killSwitchEngaged: boolean;
}

export interface RateLimitConfig {
  readonly limit: number;
  readonly windowSeconds: number;
}

const DAY = 86_400;

export const DEFAULT_CONFIG: RelicConfig = {
  serviceOrigin: 'https://relic.example',
  usercontentOrigin: 'https://relic-usercontent.example',

  plaintextCapBytes: PLAINTEXT_CAP_BYTES,
  ciphertextCapBytes: ciphertextCapBytes(),

  maxTtlDays: 3650,
  urlValiditySeconds: 15 * 60,
  minViableValiditySeconds: 60,
  downloadCap: 200,
  mintDedupSeconds: 10 * 60,
  postPublishWindowSeconds: 120,
  retentionSeconds: 30 * DAY,
  challengeTtlSeconds: 5 * 60,
  abuseSlaHours: 24,

  publishRateLimit: { limit: 60, windowSeconds: 3600 },
  mintRateLimit: { limit: 240, windowSeconds: 3600 },
  commentRateLimit: { limit: 30, windowSeconds: 3600 },
  authRateLimit: { limit: 10, windowSeconds: 3600 },
  notificationRateLimit: { limit: 1, windowSeconds: 10 * 60 },
  // 4096 plaintext bytes plus a 64-byte name, a 12-byte nonce and a 16-byte
  // tag, JSON framing, then base64url's 4-for-3 expansion, rounded up with
  // room to spare rather than computed to the byte.
  commentCiphertextCapChars: 8192,
  authLinkTtlSeconds: 15 * 60,
  sessionTtlSeconds: 30 * 24 * 3600,

  killSwitchEngaged: false,
};

/**
 * GCS caps signed URL lifetime at 604800 seconds. Asserted rather than
 * assumed, so a later TTL change cannot silently produce an unsignable URL.
 */
export const GCS_MAX_SIGNED_URL_SECONDS = 604_800;

export function assertConfig(config: RelicConfig): void {
  if (config.urlValiditySeconds > GCS_MAX_SIGNED_URL_SECONDS) {
    throw new Error(
      `url validity ${config.urlValiditySeconds}s exceeds the GCS ceiling`
    );
  }
  if (config.minViableValiditySeconds > config.urlValiditySeconds) {
    throw new Error('minimum viable validity exceeds the validity window');
  }
  // `service.md` 7.5 wanted the mint log to outlive every relic, so the
  // metric's publishing-IP filter could still fire on an old relic's self
  // opens. That was expressible only while every relic's life was a single
  // number fixed here. A relic may now outlive any retention window, or
  // never die at all, so no ordering of these two values can promise it, and
  // the check is gone rather than quietly comparing against the wrong life.
  if (config.mintDedupSeconds <= config.postPublishWindowSeconds) {
    throw new Error(
      'mint dedup interval must exceed the post-publish window, or the two ' +
        'rules interact'
    );
  }
  if (
    new URL(config.serviceOrigin).host ===
    new URL(config.usercontentOrigin).host
  ) {
    throw new Error(
      'the usercontent origin must be a distinct host from the service origin'
    );
  }
}
