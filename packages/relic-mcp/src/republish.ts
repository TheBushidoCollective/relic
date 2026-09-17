/**
 * The republish flow: a new version of an existing relic.
 *
 * The whole point of a version is that the share URL keeps working, and the
 * URL's fragment is the key, so a new version MUST be encrypted under the
 * key the first publish used. That key exists in exactly two places: the
 * URL, and this machine's publish state. The service holds only a hash of
 * the publish token and none of the key, so it cannot help. Republishing is
 * therefore possible only from the machine that published, which is the
 * boundary the state file draws and this flow enforces before any network.
 */

import {
  decodeKey,
  deriveRendererClass,
  encryptRelic,
  isValidRelicId,
  normalizeTitle,
  type RendererClass,
} from '@relic/format';
import { keyToMnemonic } from '@relic/format/mnemonic';
import {
  type CommentResult,
  formatUnaddressedRefusal,
  postComment,
  readComments,
} from './comments.ts';
import {
  guessMimetype,
  type PublishDeps,
  PublishError,
  postJson,
  putContainer,
  readSource,
  reportComplete,
} from './publish.ts';
import {
  loadPublishState,
  type PublishState,
  savePublishState,
} from './state.ts';

export interface RepublishAddressEntry {
  readonly comment_id: string;
  readonly note: string;
}

export interface RepublishInput {
  readonly relic_id: string;
  readonly path: string;
  readonly filename?: string | undefined;
  /**
   * Optional plaintext title for the new version. Defaults to the new
   * version's filename. Pass "" to clear the relic's title.
   */
  readonly title?: string | undefined;
  /**
   * Forwarded on the republish body when set and omitted when unset, the
   * grant's own convention. A relic's lifetime is fixed at its first grant,
   * so the service does not read it here today; carrying it keeps the
   * request honest about what the publisher asked for and needs no client
   * change if that ever shifts.
   */
  readonly ttl_days?: number | undefined;
  /**
   * Optional acknowledgement notes for open comments being addressed by this
   * update. Each entry posts an acknowledgement comment stamped with the new
   * version after it lands. Every open comment on the relic must be addressed
   * either by an entry here or by a prior reply.
   */
  readonly addresses?: readonly RepublishAddressEntry[] | undefined;
}

export interface RepublishResult {
  readonly relic_id: string;
  /**
   * The version just published, counted from the local state file: the
   * service does not return one, and a publisher only needs to know how
   * many times this relic has changed.
   */
  readonly version: number;
  /** Null when the relic has no lifetime, which is now the default. */
  readonly relic_expires_at: string | null;
  readonly renderer_class: RendererClass;
  readonly filename: string;
  /**
   * Stored by the service in the clear for link previews. Null when cleared
   * or published without a title.
   */
  readonly title: string | null;
  readonly resolved_path: string;
  readonly report_url: string;
  readonly disclosure_url: string;
  readonly key_phrase: string;
  /**
   * Acknowledgement comments posted for comments addressed by this update.
   */
  readonly acknowledgements?: readonly CommentResult[] | undefined;
  /**
   * Deliberately no `url` member. The share URL is unchanged by a new
   * version, and reprinting it would reprint the key for no new benefit;
   * the first publish disclosed it once and that is the disclosure that
   * counts.
   */
}

export async function republish(
  input: RepublishInput,
  deps: PublishDeps
): Promise<RepublishResult> {
  // The gate comes first, before the file is read and before anything can
  // touch the network: without local state there is nothing to encrypt or
  // authorize with, and a round trip would only produce a refusal this
  // machine already knows the reason for.
  if (!isValidRelicId(input.relic_id)) {
    throw new PublishError(
      'no_local_publish_state',
      `"${input.relic_id}" is not a relic id. Republish takes the ` +
        '26-character id the original publish returned.'
    );
  }

  let state: PublishState;
  try {
    const loaded = await loadPublishState(input.relic_id);
    if (loaded === undefined) {
      throw new PublishError(
        'no_local_publish_state',
        `relic ${input.relic_id} was published from another machine and ` +
          'cannot be republished here. The key and the publish token live ' +
          'only on the machine that made the first publish, and neither can ' +
          'be reconstructed from the link or from the service. Publish the ' +
          'content as a new relic instead.'
      );
    }
    state = loaded;
  } catch (error) {
    // State-file damage is not "published elsewhere"; naming it as that
    // would send someone hunting the wrong machine.
    if (error instanceof PublishError) throw error;
    throw new PublishError('local_state_unreadable', (error as Error).message);
  }
  // Validate addresses entries up front before any network or file reads.
  const addressesEntries = input.addresses;
  if (addressesEntries !== undefined) {
    if (!Array.isArray(addressesEntries)) {
      throw new PublishError(
        'invalid_acknowledgements',
        'addresses must be an array of { comment_id, note } entries.'
      );
    }
    const seen = new Set<string>();
    for (const entry of addressesEntries) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof entry.comment_id !== 'string' ||
        entry.comment_id.trim().length === 0
      ) {
        throw new PublishError(
          'invalid_acknowledgement_comment_id',
          'acknowledgement comment_id must be a non-empty string.'
        );
      }
      if (typeof entry.note !== 'string' || entry.note.trim().length === 0) {
        throw new PublishError(
          'empty_acknowledgement_note',
          `acknowledgement note for comment ${entry.comment_id} cannot be empty or whitespace-only: it must say what was done to address the comment.`
        );
      }
      if (seen.has(entry.comment_id)) {
        throw new PublishError(
          'duplicate_acknowledgement',
          `duplicate acknowledgement entry for comment ${entry.comment_id}.`
        );
      }
      seen.add(entry.comment_id);
    }
  }

  // The comment gate: before publishing a new version, read the relic's
  // comments, decrypt them locally, and verify every comment has been
  // addressed. Unaddressed or unreadable comments refuse the republish.
  const commentResult = await readComments(input.relic_id, deps);
  const unreadableComments = commentResult.comments.filter((c) => !c.readable);
  const openComments = commentResult.comments.filter(
    (c) => c.readable && !c.addressed && c.addresses === null
  );

  if (addressesEntries && addressesEntries.length > 0) {
    for (const entry of addressesEntries) {
      const match = commentResult.comments.find(
        (c) => c.comment_id === entry.comment_id
      );
      if (!match) {
        throw new PublishError(
          'unknown_comment_id',
          `comment ${entry.comment_id} does not exist on relic ${input.relic_id}. The comment ids can only come from having read the relic's comments.`
        );
      }
      if (!match.readable) {
        throw new PublishError(
          'unreadable_comment_cannot_be_addressed',
          `comment ${entry.comment_id} cannot be addressed because it could not be decrypted.`
        );
      }
    }
  }

  const addressesSet = new Set(
    addressesEntries?.map((e) => e.comment_id) ?? []
  );
  const remainingOpen = openComments.filter(
    (c) => !addressesSet.has(c.comment_id)
  );

  if (unreadableComments.length > 0 || remainingOpen.length > 0) {
    throw new PublishError(
      'unaddressed_comments',
      formatUnaddressedRefusal(
        input.relic_id,
        remainingOpen,
        unreadableComments
      ),
      {
        relic_id: input.relic_id,
        open_count: remainingOpen.length,
        unreadable_count: unreadableComments.length,
        open_comments: remainingOpen.map((c) => ({
          comment_id: c.comment_id,
          author: c.author,
          created_at: c.created_at,
          body: c.body,
        })),
        unreadable_comments: unreadableComments.map((c) => ({
          comment_id: c.comment_id,
          author: c.author,
          created_at: c.created_at,
          unreadable_reason: c.unreadable_reason,
        })),
      }
    );
  }

  const source = await readSource(input.path, deps.files);
  const filename = input.filename ?? source.basename;
  const normalizedTitle = normalizeTitle(input.title ?? filename);
  // Same rule as a first publish: the class comes from bytes in hand, never
  // from a tool input, so the taxonomy stays machine-attested.
  const rendererClass = deriveRendererClass(source.bytes, filename);

  // The stored key, not a fresh one. This is the line that keeps the
  // existing share URL decrypting the new version; a fresh key here would
  // silently cut every recipient off from content they were told this link
  // carries.
  const container = await encryptRelic({
    content: source.bytes,
    filename,
    mimetype: guessMimetype(filename, rendererClass),
    key: decodeKey(state.key),
  });

  // 1. The republish grant: same shape as a first grant, authorized by the
  //    publish token instead of a challenge nonce, aiming the upload at the
  //    next version's object.
  const grant = await postJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${input.relic_id}/republish`,
    {
      publish_token: state.publish_token,
      renderer_class: rendererClass,
      declared_size_bytes: source.bytes.length,
      declared_ciphertext_bytes: container.length,
      title: normalizedTitle,
      ...(input.ttl_days === undefined ? {} : { ttl_days: input.ttl_days }),
    }
  );

  // 2. Straight to storage, exactly like a first publish.
  await putContainer(
    deps,
    input.relic_id,
    String(grant['upload_url']),
    container
  );

  // 3. Completion, with the same survivability as a first publish.
  await reportComplete(deps, input.relic_id);

  // 4. Count the version locally before reporting it. The service does not
  //    return one, so this file is the only ledger; if the count drifts, the
  //    number reported drifts with it, and nothing else does.
  const version = state.version + 1;
  try {
    // The filename tracks the newest version, because that is the one the
    // link now serves and the one an inventory should name. `published_at`
    // is deliberately untouched: it answers when this relic was made, and a
    // republish overwriting it would erase the only date this machine has.
    await savePublishState(input.relic_id, {
      ...state,
      version,
      filename,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    throw new PublishError(
      'local_state_write_failed',
      'the new version is live at the existing link, but updating the ' +
        'local record failed, so the next republish from this machine may ' +
        `report a stale version number: ${(error as Error).message}`,
      { relic_id: input.relic_id, version }
    );
  }

  // After the new version lands, post an acknowledgement comment for each
  // addressed entry, so the acknowledgement is stamped with the new version.
  const acknowledgements: CommentResult[] = [];
  if (addressesEntries && addressesEntries.length > 0) {
    for (const entry of addressesEntries) {
      const ack = await postComment(
        {
          relic_id: input.relic_id,
          body: entry.note,
          addresses: entry.comment_id,
        },
        deps
      );
      acknowledgements.push(ack);
    }
  }

  return {
    relic_id: input.relic_id,
    version,
    relic_expires_at:
      grant['relic_expires_at'] == null
        ? null
        : String(grant['relic_expires_at']),
    renderer_class: rendererClass,
    filename,
    title: normalizedTitle.length === 0 ? null : normalizedTitle,
    resolved_path: source.resolvedPath,
    report_url: String(grant['report_url']),
    disclosure_url: String(grant['disclosure_url']),
    key_phrase: keyToMnemonic(decodeKey(state.key)).join(' '),
    ...(acknowledgements.length > 0 ? { acknowledgements } : {}),
  };
}
