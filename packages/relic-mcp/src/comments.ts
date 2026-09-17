/**
 * Comments, from an agent's seat.
 *
 * The feature exists so a person can leave a comment and an agent can read it
 * back and act on it. The agent's half has two constraints the person's does
 * not, and both are structural rather than stylistic.
 *
 * **An agent cannot receive email.** `docs/frame.md` makes a verified email
 * address the commenter identity, and verification runs through a magic link,
 * which needs a mailbox. There is no mailbox here. The publish token already
 * proves this machine published the relic, so it stands as the agent's
 * identity and the service attributes the comment to `publisher`. That is
 * attribution, never authorization: the same non-goal entry says verified
 * email buys attribution and not entitlement, and a bearer token buys less.
 *
 * **The share URL is never an argument.** The fragment is the key, so a tool
 * accepting the URL would put the key in the transcript on every read, which
 * is the one disclosure `spec/publish.md` section 5 spends deliberately and
 * exactly once, at publish. These tools take the relic id and read the key
 * from local publish state instead, which draws the same machine boundary
 * republish already draws: only the machine that published can comment on a
 * relic or read its comments here.
 *
 * The comment key is derived from the fragment's key bytes under a distinct
 * HKDF `info`, so it is independent of the container key by construction, and
 * the fragment does not change. `spec/format.md` 2.1 fixes the fragment at
 * the marker and the key, and a third field would cost a version bump.
 */

import {
  type AnchorRect,
  COMMENT_ADDRESSES_LIMIT_BYTES,
  COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
  COMMENT_ANCHOR_MAX_PAGE,
  COMMENT_ANCHOR_MAX_SECONDS,
  COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
  COMMENT_BODY_LIMIT_BYTES,
  COMMENT_DISPLAY_NAME_LIMIT_BYTES,
  type CommentAnchor,
  decodeKey,
  decryptComment,
  deriveCommentKey,
  encryptComment,
  isValidRelicId,
} from '@relic/format';
import {
  getJson,
  type PublishDeps,
  PublishError,
  postJson,
} from './publish.ts';
import {
  type ContentBlock,
  type ResolvedAnchor,
  resolveAnchors,
} from './resolve-anchor.ts';
import { loadPublishState, type PublishState } from './state.ts';

export interface CommentAddressedBy {
  readonly comment_id: string;
  readonly version: number | null;
}

/** One comment as an agent reads it. */
export interface CommentRecord {
  readonly comment_id: string;
  /**
   * The verified email address of a human commenter, or the literal
   * `publisher` for a comment authorized by a publish token. Returned as the
   * service gave it: `docs/frame.md` makes the address the identity, so a
   * display name aliases it and never replaces it.
   */
  readonly author: string;
  readonly created_at: string;
  /** The commenter's chosen alias, when they set one. Decoration, not identity. */
  readonly display_name: string | null;
  /** Null exactly when `readable` is false. */
  readonly body: string | null;
  /**
   * What the comment is a mark on, or null for a freeform one.
   *
   * Dropping this was a defect rather than an omission. A reviewer's "this
   * line is wrong" is not actionable without the line, and an agent reading a
   * thread back could not tell a mark from a general remark, which is the
   * difference between fixing the right sentence and guessing. It lives inside
   * the encrypted envelope, so it arrives with the body or not at all.
   */
  readonly anchor: CommentAnchor | null;
  /**
   * The comment this one answers or acknowledges, by service-minted id.
   * Taken from the sealed copy only.
   */
  readonly addresses: string | null;
  readonly readable: boolean;
  /** Null exactly when `readable` is true. */
  readonly unreadable_reason: string | null;
  /**
   * True if some other comment carries addresses equal to this comment's id,
   * taken from the sealed copy only.
   */
  readonly addressed: boolean;
  /** The comment that addressed this one, if any. */
  readonly addressed_by: CommentAddressedBy | null;
  readonly addressed_by_comment_id?: string | null;
  readonly addressed_by_version?: number | null;
  /**
   * Resolved content for this comment's anchor when anchor resolution is
   * requested. Null when freeform or when resolution was not requested.
   */
  readonly resolved?: ResolvedAnchor | null;
}

export interface CommentsSummary {
  readonly total: number;
  readonly addressed: number;
  readonly open: number;
  readonly unreadable: number;
}

export interface ReadCommentsResult {
  readonly relic_id: string;
  readonly count: number;
  /**
   * Comments the comment key did not open. Reported rather than dropped: a
   * silently shortened list reads as agreement, and an agent acting on
   * "nobody objected" when somebody did is the failure this member prevents.
   */
  readonly unreadable_count: number;
  readonly summary: CommentsSummary;
  readonly comments: readonly CommentRecord[];
  readonly content_blocks?: readonly ContentBlock[];
}

export interface CommentResult {
  readonly relic_id: string;
  readonly comment_id: string;
  readonly author: string;
  readonly created_at: string;
}
export interface ReadCommentsOptions {
  readonly resolve_anchors?: boolean;
}

/** First part of a comment body for refusal summaries, truncated if long. */
export function previewCommentBody(body: string | null, maxChars = 80): string {
  if (body === null || body === undefined) return '';
  const trimmed = body.trim();
  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  const text = firstLine.length > 0 ? firstLine : trimmed;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

/** Format the refusal message when republish is blocked by unaddressed comments. */
export function formatUnaddressedRefusal(
  relicId: string,
  openComments: readonly CommentRecord[],
  unreadableComments: readonly CommentRecord[] = []
): string {
  const parts: string[] = [];

  if (openComments.length > 0 && unreadableComments.length > 0) {
    parts.push(
      `cannot republish relic ${relicId} while comments remain unaddressed. ` +
        `${openComments.length} comment(s) are unanswered, and ${unreadableComments.length} comment(s) could not be decrypted. ` +
        'Address unanswered comments either by replying with relic_comment or by passing addresses: [{ comment_id, note }] on republish.'
    );
  } else if (openComments.length > 0) {
    parts.push(
      `cannot republish relic ${relicId} while comments remain unaddressed. ` +
        `${openComments.length} comment(s) are unanswered. ` +
        'Address each open comment either by replying with relic_comment or by passing addresses: [{ comment_id, note }] on republish.'
    );
  } else {
    parts.push(
      `cannot republish relic ${relicId} because ${unreadableComments.length} comment(s) could not be decrypted. ` +
        'A comment this client cannot read cannot be verified as addressed.'
    );
  }

  if (openComments.length > 0) {
    const list = openComments
      .map(
        (c) =>
          `- [${c.comment_id}] from ${c.author} at ${c.created_at}: "${previewCommentBody(c.body)}"`
      )
      .join('\n');
    parts.push(`Open comments (${openComments.length}):\n${list}`);
  }

  if (unreadableComments.length > 0) {
    const list = unreadableComments
      .map(
        (c) =>
          `- [${c.comment_id}] from ${c.author} at ${c.created_at}: unreadable (${c.unreadable_reason ?? "it did not decrypt under this relic's comment key"})`
      )
      .join('\n');
    parts.push(`Unreadable comments (${unreadableComments.length}):\n${list}`);
  }

  return parts.join('\n\n');
}

export type CommentAnchorInput =
  | CommentAnchor
  | {
      readonly kind: 'time';
      readonly t: number | string;
      readonly t_end?: number | string | undefined;
      readonly rect?: AnchorRect | undefined;
    }
  | {
      readonly kind: 'quote';
      readonly exact?: string | undefined;
      readonly quote?: string | undefined;
      readonly prefix?: string | undefined;
      readonly suffix?: string | undefined;
    }
  | {
      readonly kind: 'text';
      readonly quote?: string | undefined;
      readonly exact?: string | undefined;
    }
  | {
      readonly kind: 'page';
      readonly page: number | string;
      readonly rect?: AnchorRect | undefined;
      readonly exact?: string | undefined;
    };

export interface CommentInput {
  readonly relic_id: string;
  readonly body: string;
  readonly display_name?: string | undefined;
  readonly anchor?: CommentAnchorInput | null | undefined;
  /**
   * Optional service-minted id of the comment this one answers or acknowledges.
   * Sealed into the ciphertext and passed in the clear to the service for notification routing.
   */
  readonly addresses?: string | null | undefined;
}

export async function readComments(
  relicId: string,
  deps: PublishDeps,
  options?: ReadCommentsOptions
): Promise<ReadCommentsResult> {
  const state = await localState(relicId);

  // No credential on this read. Anyone holding the link can already fetch the
  // ciphertext, and the bodies are ciphertext the service cannot open, so
  // authorizing it would gate nothing and cost the token an exposure.
  const listed = await getJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${relicId}/comments`
  );
  if (!Array.isArray(listed)) {
    throw new PublishError(
      'app_response_unusable',
      'the comment list did not come back as a JSON array, so there is no ' +
        'way to tell an empty conversation from an unreadable response',
      { relic_id: relicId, leg: 'comments' }
    );
  }

  const commentKey = await deriveCommentKey(decodeKey(state.key));
  interface DecryptedCommentEntry {
    comment_id: string;
    author: string;
    created_at: string;
    display_name: string | null;
    body: string | null;
    anchor: CommentAnchor | null;
    addresses: string | null;
    version: number | null;
    readable: boolean;
    unreadable_reason: string | null;
  }
  const entries: DecryptedCommentEntry[] = [];

  for (const [index, entry] of listed.entries()) {
    const row =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    const commentId =
      typeof row['comment_id'] === 'string'
        ? row['comment_id']
        : `unidentified-${index}`;
    const author =
      typeof row['author'] === 'string' ? row['author'] : 'unknown';
    const createdAt =
      typeof row['created_at'] === 'string' ? row['created_at'] : 'unknown';
    const ciphertext = row['ciphertext'];
    const version = typeof row['version'] === 'number' ? row['version'] : null;

    if (typeof ciphertext !== 'string') {
      entries.push({
        comment_id: commentId,
        author,
        created_at: createdAt,
        display_name: null,
        body: null,
        anchor: null,
        addresses: null,
        version,
        readable: false,
        unreadable_reason: 'the row carried no ciphertext',
      });
      continue;
    }

    try {
      const plaintext = await decryptComment(commentKey, ciphertext);
      entries.push({
        comment_id: commentId,
        author,
        created_at: createdAt,
        display_name: plaintext.display_name,
        body: plaintext.body,
        // Absent and null both mean freeform. One shape crosses to the agent,
        // so a caller never has to distinguish two ways of saying no mark.
        anchor: plaintext.anchor ?? null,
        addresses: plaintext.addresses ?? null,
        version,
        readable: true,
        unreadable_reason: null,
      });
    } catch (error) {
      // One comment that will not open must not hide the ones that will, and
      // it must not vanish either. It comes back named, with the reason.
      entries.push({
        comment_id: commentId,
        author,
        created_at: createdAt,
        display_name: null,
        body: null,
        anchor: null,
        addresses: null,
        version,
        readable: false,
        unreadable_reason: `it did not decrypt under this relic's comment key: ${
          (error as Error).message
        }`,
      });
    }
  }

  // The sealed copy is authoritative. It sits inside the AEAD. A caller MAY
  // also pass the same id to the service in the clear so the service can route
  // a notification, and that clear copy is a routing hint the operator can see
  // and could forge. Nothing user-facing may resolve "addressed" from the clear
  // copy. We only inspect plaintext.addresses from the decrypted ciphertext.
  const addressedByMap = new Map<
    string,
    { comment_id: string; version: number | null }
  >();

  for (const entry of entries) {
    if (
      entry.readable &&
      entry.addresses !== null &&
      entry.addresses !== entry.comment_id
    ) {
      if (!addressedByMap.has(entry.addresses)) {
        addressedByMap.set(entry.addresses, {
          comment_id: entry.comment_id,
          version: entry.version,
        });
      }
    }
  }

  const comments: CommentRecord[] = entries.map((entry) => {
    const addressedBy = addressedByMap.get(entry.comment_id) ?? null;
    const addressed = addressedBy !== null;
    return {
      comment_id: entry.comment_id,
      author: entry.author,
      created_at: entry.created_at,
      display_name: entry.display_name,
      body: entry.body,
      anchor: entry.anchor,
      addresses: entry.addresses,
      readable: entry.readable,
      unreadable_reason: entry.unreadable_reason,
      addressed,
      addressed_by: addressedBy,
      addressed_by_comment_id: addressedBy?.comment_id ?? null,
      addressed_by_version: addressedBy?.version ?? null,
    };
  });

  const addressedCount = comments.filter((c) => c.addressed).length;
  const unreadableCount = comments.filter((c) => !c.readable).length;
  // A comment is open when it is readable, has not been addressed by another
  // comment, and is not itself a reply or update acknowledgement.
  const openCount = comments.filter(
    (c) => c.readable && !c.addressed && c.addresses === null
  ).length;

  const summary: CommentsSummary = {
    total: comments.length,
    addressed: addressedCount,
    open: openCount,
    unreadable: unreadableCount,
  };

  if (options?.resolve_anchors === true) {
    const resolved = await resolveAnchors(relicId, comments, deps);
    return {
      relic_id: relicId,
      count: comments.length,
      unreadable_count: unreadableCount,
      summary,
      comments: resolved.comments,
      content_blocks: resolved.imageBlocks,
    };
  }

  return {
    relic_id: relicId,
    count: comments.length,
    unreadable_count: unreadableCount,
    summary,
    comments,
  };
}

export async function postComment(
  input: CommentInput,
  deps: PublishDeps
): Promise<CommentResult> {
  const state = await localState(input.relic_id);

  // The caps belong to the envelope, so they are enforced against its numbers
  // rather than a second copy of them, and enforced before encryption so the
  // refusal names the limit instead of a cipher failure.
  const bodyBytes = new TextEncoder().encode(input.body).length;
  if (input.body.trim().length === 0) {
    throw new PublishError(
      'local_comment_body_empty',
      'a comment needs a body. An empty one is attributable noise nobody can ' +
        'answer.'
    );
  }
  if (bodyBytes > COMMENT_BODY_LIMIT_BYTES) {
    throw new PublishError(
      'local_comment_body_too_long',
      `the comment body is ${bodyBytes} bytes of UTF-8 and the limit is ` +
        `${COMMENT_BODY_LIMIT_BYTES}. Shorten it; a truncated comment would ` +
        'change what it says.',
      { body_bytes: bodyBytes, limit_bytes: COMMENT_BODY_LIMIT_BYTES }
    );
  }

  const displayName = input.display_name ?? null;
  if (displayName !== null) {
    const nameBytes = new TextEncoder().encode(displayName).length;
    if (nameBytes > COMMENT_DISPLAY_NAME_LIMIT_BYTES) {
      throw new PublishError(
        'local_comment_name_too_long',
        `the display name is ${nameBytes} bytes of UTF-8 and the limit is ` +
          `${COMMENT_DISPLAY_NAME_LIMIT_BYTES}.`,
        { name_bytes: nameBytes, limit_bytes: COMMENT_DISPLAY_NAME_LIMIT_BYTES }
      );
    }
  }

  let addresses: string | null = null;
  if (input.addresses !== undefined && input.addresses !== null) {
    if (
      typeof input.addresses !== 'string' ||
      input.addresses.trim().length === 0
    ) {
      throw new PublishError(
        'local_comment_addresses_invalid',
        'addresses must be a non-empty string naming the comment being answered.'
      );
    }
    const addressesBytes = new TextEncoder().encode(input.addresses).length;
    if (addressesBytes > COMMENT_ADDRESSES_LIMIT_BYTES) {
      throw new PublishError(
        'local_comment_addresses_too_long',
        `addresses is ${addressesBytes} bytes of UTF-8 and the limit is ${COMMENT_ADDRESSES_LIMIT_BYTES}.`,
        {
          addresses_bytes: addressesBytes,
          limit_bytes: COMMENT_ADDRESSES_LIMIT_BYTES,
        }
      );
    }
    addresses = input.addresses;
  }

  const anchor = validateAndNormalizeAnchor(input.anchor);

  const commentKey = await deriveCommentKey(decodeKey(state.key));
  const ciphertext = await encryptComment(commentKey, {
    body: input.body,
    display_name: displayName,
    anchor,
    ...(addresses == null ? {} : { addresses }),
  });

  // The token travels in the body, where the republish grant already puts it,
  // so the two write paths authorize the same way and neither invents a
  // header the service has to learn.
  // When addressing a comment, the pointer is also sent in the clear for
  // notification routing.
  const posted = await postJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${input.relic_id}/comments`,
    {
      publish_token: state.publish_token,
      ciphertext,
      ...(addresses == null ? {} : { addresses }),
    }
  );
  return {
    relic_id: input.relic_id,
    comment_id: String(posted['comment_id']),
    author: String(posted['author']),
    created_at: String(posted['created_at']),
  };
}

/**
 * The machine boundary, checked before anything touches the network.
 *
 * Both tools need the key, and the write needs the publish token too. Neither
 * can be reconstructed from the link or from the service, so a relic this
 * machine never published is refused here rather than after a round trip that
 * could only end the same way.
 */
async function localState(relicId: string): Promise<PublishState> {
  if (!isValidRelicId(relicId)) {
    throw new PublishError(
      'no_local_publish_state',
      `"${relicId}" is not a relic id. These tools take the 26-character id ` +
        'the original publish returned, never the share URL: the URL carries ' +
        'the key in its fragment, and passing it would put the key in this ' +
        'transcript for nothing.'
    );
  }

  try {
    const loaded = await loadPublishState(relicId);
    if (loaded === undefined) {
      throw new PublishError(
        'no_local_publish_state',
        `relic ${relicId} was published from another machine, so its ` +
          'comments can be neither read nor written here. The key that ' +
          'decrypts a comment and the publish token that authorizes one live ' +
          'only on the machine that made the first publish, and neither can ' +
          'be reconstructed from the link or from the service. Open the ' +
          "relic's own page to read its comments, or ask whoever published it."
      );
    }
    return loaded;
  } catch (error) {
    // State-file damage is not "published elsewhere"; naming it as that would
    // send someone hunting the wrong machine.
    if (error instanceof PublishError) throw error;
    throw new PublishError('local_state_unreadable', (error as Error).message);
  }
}

/**
 * Plain-language position of a bounding box on an artifact.
 *
 * An agent reasoning about a visual mark needs words like "upper left" or
 * "centre" rather than raw decimal fractions. The position is computed from
 * the box center point, with boxes covering most of the content area
 * labeled "centre".
 */
export function boxPosition(rect: AnchorRect): string {
  if (rect.w >= 0.8 && rect.h >= 0.8) {
    return 'centre';
  }
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  let v = 'middle';
  if (cy < 0.35) v = 'upper';
  else if (cy > 0.65) v = 'lower';

  let h = 'centre';
  if (cx < 0.35) h = 'left';
  else if (cx > 0.65) h = 'right';

  if (v === 'middle' && h === 'centre') return 'centre';
  if (v === 'middle') return `middle ${h}`;
  if (h === 'centre') return `${v} centre`;
  return `${v} ${h}`;
}

/**
 * Format media seconds into "m:ss" or "h:mm:ss" timecode.
 */
export function formatTimecode(seconds: number): string {
  const rounded = Math.round(seconds);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = Math.floor(rounded % 60);
  const sStr = String(s).padStart(2, '0');
  if (h > 0) {
    const mStr = String(m).padStart(2, '0');
    return `${h}:${mStr}:${sStr}`;
  }
  return `${m}:${sStr}`;
}

/**
 * Parse an offset given as seconds or a timecode string ("m:ss", "h:mm:ss").
 *
 * Models reading "1:23" from a transcript must be able to reply using that
 * exact string and have it round-trip to the same offset.
 */
export function parseTimecode(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PublishError(
        'local_comment_anchor_time_invalid',
        `the ${label} must be a finite number: ${value}.`
      );
    }
    if (value < 0 || value > COMMENT_ANCHOR_MAX_SECONDS) {
      throw new PublishError(
        'local_comment_anchor_time_out_of_range',
        `the ${label} is ${value} seconds, but must be between 0 and ${COMMENT_ANCHOR_MAX_SECONDS} seconds (24 hours).`,
        { time_seconds: value, max_seconds: COMMENT_ANCHOR_MAX_SECONDS }
      );
    }
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new PublishError(
        'local_comment_anchor_time_invalid',
        `the ${label} timecode cannot be empty.`
      );
    }
    const parts = trimmed.split(':');
    if (parts.length === 1) {
      const s = Number(parts[0]);
      if (!Number.isFinite(s)) {
        throw new PublishError(
          'local_comment_anchor_time_invalid',
          `the ${label} is not a valid number or timecode: "${value}".`
        );
      }
      if (s < 0 || s > COMMENT_ANCHOR_MAX_SECONDS) {
        throw new PublishError(
          'local_comment_anchor_time_out_of_range',
          `the ${label} is ${s} seconds, but must be between 0 and ${COMMENT_ANCHOR_MAX_SECONDS} seconds (24 hours).`,
          { time_seconds: s, max_seconds: COMMENT_ANCHOR_MAX_SECONDS }
        );
      }
      return s;
    }
    if (parts.length === 2) {
      const partM = parts[0] ?? '';
      const partS = parts[1] ?? '';
      const m = Number(partM);
      const s = Number(partS);
      if (
        !Number.isFinite(m) ||
        !Number.isFinite(s) ||
        m < 0 ||
        s < 0 ||
        s >= 60 ||
        partS.length < 2
      ) {
        throw new PublishError(
          'local_comment_anchor_time_invalid',
          `the ${label} timecode "${value}" is invalid. Expected format like "m:ss" with seconds between 00 and 59.`
        );
      }
      const total = m * 60 + s;
      if (total > COMMENT_ANCHOR_MAX_SECONDS) {
        throw new PublishError(
          'local_comment_anchor_time_out_of_range',
          `the ${label} is ${total} seconds (${value}), but must be between 0 and ${COMMENT_ANCHOR_MAX_SECONDS} seconds.`,
          { time_seconds: total, max_seconds: COMMENT_ANCHOR_MAX_SECONDS }
        );
      }
      return total;
    }
    if (parts.length === 3) {
      const partH = parts[0] ?? '';
      const partM = parts[1] ?? '';
      const partS = parts[2] ?? '';
      const h = Number(partH);
      const m = Number(partM);
      const s = Number(partS);
      if (
        !Number.isFinite(h) ||
        !Number.isFinite(m) ||
        !Number.isFinite(s) ||
        h < 0 ||
        m < 0 ||
        m >= 60 ||
        s < 0 ||
        s >= 60 ||
        partM.length < 2 ||
        partS.length < 2
      ) {
        throw new PublishError(
          'local_comment_anchor_time_invalid',
          `the ${label} timecode "${value}" is invalid. Expected format like "h:mm:ss" with minutes and seconds between 00 and 59.`
        );
      }
      const total = h * 3600 + m * 60 + s;
      if (total > COMMENT_ANCHOR_MAX_SECONDS) {
        throw new PublishError(
          'local_comment_anchor_time_out_of_range',
          `the ${label} is ${total} seconds (${value}), but must be between 0 and ${COMMENT_ANCHOR_MAX_SECONDS} seconds.`,
          { time_seconds: total, max_seconds: COMMENT_ANCHOR_MAX_SECONDS }
        );
      }
      return total;
    }
  }

  throw new PublishError(
    'local_comment_anchor_time_invalid',
    `the ${label} must be a number of seconds or a timecode string like "1:23".`
  );
}

/**
 * Render what a comment points at into words an agent can act on.
 *
 * Every anchor kind is described without requiring the agent to guess at
 * coordinate systems: quotes include disambiguating context, pins state they
 * are stage-relative, regions give plain-language positions and percentages,
 * times format as timecodes, pages name the page number, and unsupported marks
 * state the declared kind rather than pretending the mark does not exist.
 *
 * A comment without an anchor is described as being about the whole relic,
 * so it is not confused with a mark that failed to place.
 */
export function describeAnchor(anchor: CommentAnchor | null): string {
  if (anchor === null) {
    return 'about the whole relic';
  }

  switch (anchor.kind) {
    case 'text':
      return `on "${anchor.quote}"`;

    case 'quote': {
      const contextParts: string[] = [];
      if (anchor.prefix !== undefined) {
        contextParts.push(`"${anchor.prefix}" before`);
      }
      if (anchor.suffix !== undefined) {
        contextParts.push(`"${anchor.suffix}" after`);
      }
      if (contextParts.length > 0) {
        return `on "${anchor.exact}" (context: ${contextParts.join(', ')})`;
      }
      return `on "${anchor.exact}"`;
    }

    case 'pin': {
      const percent = (value: number): number => Math.round(value * 100);
      return `at ${percent(anchor.x)}% across, ${percent(anchor.y)}% down (stage-relative point)`;
    }

    case 'region': {
      const pos = boxPosition(anchor.rect);
      const r = anchor.rect;
      return (
        `in region (${pos}, ${Math.round(r.x * 100)}% across, ` +
        `${Math.round(r.y * 100)}% down, ${Math.round(r.w * 100)}% wide by ` +
        `${Math.round(r.h * 100)}% high)`
      );
    }

    case 'time': {
      const timeStr =
        anchor.t_end !== undefined
          ? `at ${formatTimecode(anchor.t)} to ${formatTimecode(anchor.t_end)}`
          : `at ${formatTimecode(anchor.t)}`;
      if (anchor.rect !== undefined) {
        const pos = boxPosition(anchor.rect);
        const r = anchor.rect;
        return (
          `${timeStr} in region (${pos}, ${Math.round(r.x * 100)}% across, ` +
          `${Math.round(r.y * 100)}% down, ${Math.round(r.w * 100)}% wide by ` +
          `${Math.round(r.h * 100)}% high)`
        );
      }
      return timeStr;
    }

    case 'page': {
      const parts: string[] = [`on page ${anchor.page}`];
      if (anchor.exact !== undefined) {
        parts.push(`at "${anchor.exact}"`);
      }
      if (anchor.rect !== undefined) {
        const pos = boxPosition(anchor.rect);
        const r = anchor.rect;
        parts.push(
          `in region (${pos}, ${Math.round(r.x * 100)}% across, ` +
            `${Math.round(r.y * 100)}% down, ${Math.round(r.w * 100)}% wide by ` +
            `${Math.round(r.h * 100)}% high)`
        );
      }
      return parts.join(' ');
    }

    case 'unsupported':
      return `carrying a mark this client does not understand (declared kind "${anchor.declared}")`;
  }
}

function parseRectInput(rect: unknown, kind: string): AnchorRect {
  if (typeof rect !== 'object' || rect === null || Array.isArray(rect)) {
    throw new PublishError(
      'local_comment_anchor_rect_invalid',
      `the ${kind} anchor rect must be an object with {x, y, w, h} in unit coordinates (0 to 1).`
    );
  }
  const r = rect as Record<string, unknown>;
  const x = Number(r['x']);
  const y = Number(r['y']);
  const w = Number(r['w']);
  const h = Number(r['h']);

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    throw new PublishError(
      'local_comment_anchor_rect_invalid',
      `the ${kind} anchor rect fields {x, y, w, h} must all be finite numbers.`
    );
  }
  if (x < 0 || y < 0 || x > 1 || y > 1) {
    throw new PublishError(
      'local_comment_anchor_rect_out_of_bounds',
      `the ${kind} anchor rect position {x: ${x}, y: ${y}} must be between 0 and 1.`,
      { x, y, w, h }
    );
  }
  if (w <= 0 || h <= 0) {
    throw new PublishError(
      'local_comment_anchor_rect_zero_area',
      `the ${kind} anchor rect dimensions {w: ${w}, h: ${h}} must have real positive area.`,
      { x, y, w, h }
    );
  }
  if (x + w > 1.000001 || y + h > 1.000001) {
    throw new PublishError(
      'local_comment_anchor_rect_overhang',
      `the ${kind} anchor rect overhangs the boundary: x+w=${x + w}, y+h=${y + h}. Coordinates must fit within the unit square.`,
      { x, y, w, h }
    );
  }
  return { x, y, w, h };
}

/**
 * Validate and canonicalize an anchor input at the tool boundary.
 *
 * Enforces all format bounds and caps before reaching encryption, returning
 * human-readable PublishError refusals rather than opaque cipher failures.
 */
export function validateAndNormalizeAnchor(raw: unknown): CommentAnchor | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PublishError(
      'local_comment_anchor_invalid',
      'the anchor must be an object or omitted.'
    );
  }

  const obj = raw as Record<string, unknown>;
  const kind = obj['kind'];
  if (typeof kind !== 'string') {
    throw new PublishError(
      'local_comment_anchor_invalid',
      'the anchor is missing a "kind" string.'
    );
  }

  switch (kind) {
    case 'unsupported':
      throw new PublishError(
        'local_comment_anchor_unsupported',
        'unsupported is a parser output kind and cannot be written as a comment anchor.'
      );

    case 'text': {
      const quoteVal = obj['quote'] ?? obj['exact'];
      if (typeof quoteVal !== 'string' || quoteVal.trim().length === 0) {
        throw new PublishError(
          'local_comment_anchor_quote_empty',
          'a text anchor requires a non-empty "quote" string.'
        );
      }
      const quoteBytes = new TextEncoder().encode(quoteVal).length;
      if (quoteBytes > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES) {
        throw new PublishError(
          'local_comment_anchor_quote_too_long',
          `the quote is ${quoteBytes} bytes of UTF-8 and the limit is ${COMMENT_ANCHOR_QUOTE_LIMIT_BYTES}.`,
          {
            quote_bytes: quoteBytes,
            limit_bytes: COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
          }
        );
      }
      return { kind: 'text', quote: quoteVal };
    }

    case 'quote': {
      const exactVal = obj['exact'] ?? obj['quote'];
      if (typeof exactVal !== 'string' || exactVal.trim().length === 0) {
        throw new PublishError(
          'local_comment_anchor_quote_empty',
          'a quote anchor requires a non-empty "exact" string.'
        );
      }
      const exactBytes = new TextEncoder().encode(exactVal).length;
      if (exactBytes > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES) {
        throw new PublishError(
          'local_comment_anchor_quote_too_long',
          `the exact quote is ${exactBytes} bytes of UTF-8 and the limit is ${COMMENT_ANCHOR_QUOTE_LIMIT_BYTES}.`,
          {
            quote_bytes: exactBytes,
            limit_bytes: COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
          }
        );
      }

      let prefix: string | undefined;
      if (obj['prefix'] !== undefined && obj['prefix'] !== null) {
        if (typeof obj['prefix'] !== 'string') {
          throw new PublishError(
            'local_comment_anchor_context_invalid',
            'the quote prefix must be a string or omitted.'
          );
        }
        const prefixBytes = new TextEncoder().encode(obj['prefix']).length;
        if (prefixBytes > COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES) {
          throw new PublishError(
            'local_comment_anchor_context_too_long',
            `the quote prefix is ${prefixBytes} bytes of UTF-8 and the limit is ${COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES}.`,
            {
              context_bytes: prefixBytes,
              limit_bytes: COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
              context_type: 'prefix',
            }
          );
        }
        prefix = obj['prefix'];
      }

      let suffix: string | undefined;
      if (obj['suffix'] !== undefined && obj['suffix'] !== null) {
        if (typeof obj['suffix'] !== 'string') {
          throw new PublishError(
            'local_comment_anchor_context_invalid',
            'the quote suffix must be a string or omitted.'
          );
        }
        const suffixBytes = new TextEncoder().encode(obj['suffix']).length;
        if (suffixBytes > COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES) {
          throw new PublishError(
            'local_comment_anchor_context_too_long',
            `the quote suffix is ${suffixBytes} bytes of UTF-8 and the limit is ${COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES}.`,
            {
              context_bytes: suffixBytes,
              limit_bytes: COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
              context_type: 'suffix',
            }
          );
        }
        suffix = obj['suffix'];
      }

      return {
        kind: 'quote',
        exact: exactVal,
        ...(prefix !== undefined ? { prefix } : {}),
        ...(suffix !== undefined ? { suffix } : {}),
      };
    }

    case 'pin': {
      const x = Number(obj['x']);
      const y = Number(obj['y']);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        x > 1 ||
        y < 0 ||
        y > 1
      ) {
        throw new PublishError(
          'local_comment_anchor_pin_invalid',
          `the pin coordinates {x: ${obj['x']}, y: ${obj['y']}} must be numbers between 0 and 1.`,
          { x: obj['x'], y: obj['y'] }
        );
      }
      return { kind: 'pin', x, y };
    }

    case 'region': {
      const rect = parseRectInput(obj['rect'], 'region');
      return { kind: 'region', rect };
    }

    case 'time': {
      if (obj['t'] === undefined || obj['t'] === null) {
        throw new PublishError(
          'local_comment_anchor_time_missing',
          'a time anchor requires a "t" timestamp.'
        );
      }
      const t = parseTimecode(obj['t'], 'start time (t)');
      let t_end: number | undefined;
      if (obj['t_end'] !== undefined && obj['t_end'] !== null) {
        t_end = parseTimecode(obj['t_end'], 'end time (t_end)');
        if (t_end <= t) {
          throw new PublishError(
            'local_comment_anchor_time_span_invalid',
            `the end time (${t_end}s) must be strictly after the start time (${t}s).`,
            { t, t_end }
          );
        }
      }
      let rect: AnchorRect | undefined;
      if (obj['rect'] !== undefined && obj['rect'] !== null) {
        rect = parseRectInput(obj['rect'], 'time');
      }
      return {
        kind: 'time',
        t,
        ...(t_end !== undefined ? { t_end } : {}),
        ...(rect !== undefined ? { rect } : {}),
      };
    }

    case 'page': {
      if (obj['page'] === undefined || obj['page'] === null) {
        throw new PublishError(
          'local_comment_anchor_page_missing',
          'a page anchor requires a "page" number.'
        );
      }
      const page = Number(obj['page']);
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        page > COMMENT_ANCHOR_MAX_PAGE
      ) {
        throw new PublishError(
          'local_comment_anchor_page_out_of_range',
          `the page number (${obj['page']}) must be an integer between 1 and ${COMMENT_ANCHOR_MAX_PAGE}.`,
          { page: obj['page'], max_page: COMMENT_ANCHOR_MAX_PAGE }
        );
      }
      let rect: AnchorRect | undefined;
      if (obj['rect'] !== undefined && obj['rect'] !== null) {
        rect = parseRectInput(obj['rect'], 'page');
      }
      let exact: string | undefined;
      if (obj['exact'] !== undefined && obj['exact'] !== null) {
        if (
          typeof obj['exact'] !== 'string' ||
          obj['exact'].trim().length === 0
        ) {
          throw new PublishError(
            'local_comment_anchor_quote_empty',
            'the page exact quote must be a non-empty string.'
          );
        }
        const exactBytes = new TextEncoder().encode(obj['exact']).length;
        if (exactBytes > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES) {
          throw new PublishError(
            'local_comment_anchor_quote_too_long',
            `the page quote is ${exactBytes} bytes of UTF-8 and the limit is ${COMMENT_ANCHOR_QUOTE_LIMIT_BYTES}.`,
            {
              quote_bytes: exactBytes,
              limit_bytes: COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
            }
          );
        }
        exact = obj['exact'];
      }
      return {
        kind: 'page',
        page,
        ...(rect !== undefined ? { rect } : {}),
        ...(exact !== undefined ? { exact } : {}),
      };
    }

    default:
      throw new PublishError(
        'local_comment_anchor_kind_unknown',
        `unknown anchor kind "${kind}". Expected one of: quote, text, pin, region, time, page.`
      );
  }
}
