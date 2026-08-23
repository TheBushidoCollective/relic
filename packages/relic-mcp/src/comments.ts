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
import { loadPublishState, type PublishState } from './state.ts';

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
  readonly readable: boolean;
  /** Null exactly when `readable` is true. */
  readonly unreadable_reason: string | null;
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
  readonly comments: readonly CommentRecord[];
}

export interface CommentResult {
  readonly relic_id: string;
  readonly comment_id: string;
  readonly author: string;
  readonly created_at: string;
}

export interface CommentInput {
  readonly relic_id: string;
  readonly body: string;
  readonly display_name?: string | undefined;
}

export async function readComments(
  relicId: string,
  deps: PublishDeps
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
  const comments: CommentRecord[] = [];
  let unreadable = 0;

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

    if (typeof ciphertext !== 'string') {
      unreadable += 1;
      comments.push({
        comment_id: commentId,
        author,
        created_at: createdAt,
        display_name: null,
        body: null,
        anchor: null,
        readable: false,
        unreadable_reason: 'the row carried no ciphertext',
      });
      continue;
    }

    try {
      const plaintext = await decryptComment(commentKey, ciphertext);
      comments.push({
        comment_id: commentId,
        author,
        created_at: createdAt,
        display_name: plaintext.display_name,
        body: plaintext.body,
        // Absent and null both mean freeform. One shape crosses to the agent,
        // so a caller never has to distinguish two ways of saying no mark.
        anchor: plaintext.anchor ?? null,
        readable: true,
        unreadable_reason: null,
      });
    } catch (error) {
      // One comment that will not open must not hide the ones that will, and
      // it must not vanish either. It comes back named, with the reason.
      unreadable += 1;
      comments.push({
        comment_id: commentId,
        author,
        created_at: createdAt,
        display_name: null,
        body: null,
        anchor: null,
        readable: false,
        unreadable_reason: `it did not decrypt under this relic's comment key: ${
          (error as Error).message
        }`,
      });
    }
  }

  return {
    relic_id: relicId,
    count: comments.length,
    unreadable_count: unreadable,
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

  const commentKey = await deriveCommentKey(decodeKey(state.key));
  const ciphertext = await encryptComment(commentKey, {
    body: input.body,
    display_name: displayName,
  });

  // The token travels in the body, where the republish grant already puts it,
  // so the two write paths authorize the same way and neither invents a
  // header the service has to learn.
  const posted = await postJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${input.relic_id}/comments`,
    { publish_token: state.publish_token, ciphertext }
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
