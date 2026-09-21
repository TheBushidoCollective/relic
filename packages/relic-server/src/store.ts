/**
 * The server's record of a relic's life.
 *
 * The server holds only ciphertext and metadata. Nothing here is finer than
 * the seven-value renderer class and the publishing client name, which is the
 * whole of what the frame conceded (`spec/format.md` 3.2). A filename or a
 * declared mimetype appearing in this file is drift.
 */

import type { RendererClass } from '@relic/format';

/** Why a relic was removed. Private; the public code is always the same. */
export type ReasonClass =
  | 'abuse'
  | 'legal'
  | 'blocklist_match'
  | 'operator_error';

export interface RelicRow {
  readonly id: string;
  readonly publishIp: string;
  /** The app server's own clock. The publishing client's is never trusted. */
  readonly grantedAt: number;
  /**
   * When the publisher asked for a lifetime. Undefined means the relic never
   * expires on its own; only deletion ends it.
   */
  readonly expiresAt: number | undefined;
  readonly rendererClass: RendererClass;
  readonly publishingClient: string;
  readonly declaredSizeBytes: number;
  /**
   * Which version of the ciphertext the row serves, 1-based. Version 1 is
   * the original grant's upload; every republish increments. The number
   * never resets, and the cap counts across all of it, so a republished
   * relic cannot buy fresh egress.
   */
  readonly version: number;
  /**
   * SHA-256 of the publish token, hex. The token itself leaves the server
   * exactly once, in the first grant response, and possession of it is the
   * only way to republish. The store is a bucket of JSON documents, so what
   * lands here must not be replayable as that credential.
   */
  readonly publishTokenHash: string;
  /** Set when the object actually lands. Absent means granted, never filled. */
  publishedAt?: number | undefined;
  objectLength?: number | undefined;
  objectCrc32c?: string | undefined;
  /** Mints consumed against the per-relic cap, across all versions. */
  mintsUsed: number;
  /**
   * The one plaintext field about a relic the service holds. Publisher-declared,
   * stored in the clear so previews show a human-chosen name rather than a
   * blank card. A removal must take it with the row.
   */
  title?: string | undefined;
  /**
   * Verified email address of the relic's creator, if provided at publish/republish.
   * Used to notify the creator when comments arrive.
   */
  ownerEmail?: string | undefined;
}

export interface Tombstone {
  readonly id: string;
  readonly publishIp: string;
  readonly publishedAt: number | undefined;
  readonly publishingClient: string;
  readonly rendererClass: RendererClass;
  readonly ciphertextHash: string;
  readonly deletedAt: number;
  readonly operator: string;
  readonly reasonClass: ReasonClass;
  readonly reportReference: string | undefined;
}

/**
 * One record per mint attempt, granted or refused.
 *
 * `spec/service.md` 1.2: cap exhaustion, expiry, and all three flavors of
 * deletion share one HTTP status, so no view that groups by status can ever
 * tell them apart. This record is where the distinction survives, which is
 * why every dashboard and alert keys on `code` rather than on the status.
 */
export interface MintLogEntry {
  readonly relicId: string;
  readonly ip: string;
  readonly at: number;
  readonly endpoint: string;
  readonly outcome: 'granted' | 'refused';
  readonly code: string | undefined;
  readonly countedAsOpen: boolean;
  /** Which rule dropped it, when it was not counted. */
  readonly dropReason:
    | 'publishing_ip_match'
    | 'post_publish_window'
    | 'dedup'
    | 'refused'
    | undefined;
  readonly consumedCap: boolean;
  readonly capRemaining: number;
  readonly occurrenceId: string;
}

export interface AbuseReport {
  readonly relicId: string;
  readonly category:
    | 'malware'
    | 'phishing'
    | 'csam'
    | 'copyright'
    | 'legal_process'
    | 'other';
  readonly description: string;
  readonly contact: string | undefined;
  readonly authority: string | undefined;
  readonly reference: string | undefined;
  readonly receivedAt: number;
}

/**
 * One comment on one relic.
 *
 * `ciphertext` is opaque. `format.md` 3.13 puts the comment key behind the
 * fragment, which never reaches the server, so this field cannot be read
 * here and must not be validated as anything but base64url. The caps on the
 * plaintext are enforced by `@relic/format` before encryption, and there is
 * no way to re-check them from this side.
 *
 * `author` is the whole of the participation record: a verified email
 * address for a human, or the literal `publisher` for a comment authorized
 * by the publish token. `frame.md`'s identity entry names holding this as a
 * real cost rather than a free one, so nothing beyond it is stored.
 */
export interface CommentRow {
  readonly id: string;
  readonly relicId: string;
  readonly author: string;
  readonly createdAt: number;
  readonly ciphertext: string;
  readonly version?: number | undefined;
  /**
   * Optional service-minted id of the comment this one answers.
   * Provided in the clear as a routing hint for notifications.
   * Never returned on public comment reads; the sealed copy in ciphertext is authoritative.
   */
  readonly addresses?: string | undefined;
  /**
   * When the sealed body was last replaced, in epoch millis like
   * `createdAt`. There is no edit history (`frame.md`): the service holds
   * one ciphertext per comment and an edit overwrites it, so the honest
   * record is that an edit happened, not what it replaced. Absent until the
   * first edit.
   */
  readonly editedAt?: number | undefined;
  /**
   * When the comment was marked resolved, and by whom. Deliberately clear
   * data: the resolution decides whether a republish is blocked, which the
   * service answers before any key exists on its side, so the operator
   * learns that a comment was settled and by which address and still
   * cannot read a word of it.
   */
  readonly resolvedAt?: number | undefined;
  readonly resolvedBy?: string | undefined;
}

/**
 * A change to a comment after the fact.
 *
 * `undefined` on a field means leave it alone; only `resolved` uses an
 * explicit null, to mean clear it. A two-way boolean cannot express "leave
 * any resolution alone" and "clear it" apart, and an edit and its stamp are
 * one fact, so the caller stamps `editedAt` alongside the new ciphertext
 * rather than the store guessing at a clock.
 */
export interface CommentPatch {
  /** Replaces the sealed body. */
  readonly ciphertext?: string;
  /** Stamped with `ciphertext` by the caller, never cleared by either. */
  readonly editedAt?: number;
  /** An object sets the resolution, null clears it, undefined leaves it. */
  readonly resolved?: { readonly at: number; readonly by: string } | null;
}

/**
 * Merge a patch into a comment row, returning a new row. Pure, and shared
 * by both stores so the merge rules (in particular: clearing a resolution
 * must not touch the edit stamp, and clearing omits the keys rather than
 * writing nulls) cannot drift between memory and GCS.
 */
export function applyCommentPatch(
  row: CommentRow,
  patch: CommentPatch
): CommentRow {
  let next: CommentRow = {
    ...row,
    ...(patch.ciphertext !== undefined ? { ciphertext: patch.ciphertext } : {}),
    ...(patch.editedAt !== undefined ? { editedAt: patch.editedAt } : {}),
  };
  if (patch.resolved !== undefined) {
    if (patch.resolved === null) {
      const { resolvedAt: _at, resolvedBy: _by, ...cleared } = next;
      next = cleared;
    } else {
      next = {
        ...next,
        resolvedAt: patch.resolved.at,
        resolvedBy: patch.resolved.by,
      };
    }
  }
  return next;
}

/** Summary of an author's engagement with a relic. */
export interface CommentedRelic {
  readonly relicId: string;
  readonly lastCommentAt: number;
}

/**
 * A verified email session, minted by following a magic link.
 *
 * The link's token is single use and short lived; the session that replaces
 * it is the thing a browser carries. Both are stored hashed, so this file
 * cannot hand anybody a replayable credential.
 */
export interface SessionRow {
  readonly tokenHash: string;
  readonly email: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** A pending magic link, before anybody has followed it. */
export interface AuthLinkRow {
  readonly tokenHash: string;
  readonly email: string;
  readonly expiresAt: number;
  readonly returnTo: string;
}

interface Challenge {
  readonly nonce: string;
  readonly issuedAt: number;
  readonly ip: string;
}

export interface DedupEntry {
  readonly url: string;
  readonly urlExpiresAt: number;
  readonly at: number;
  /**
   * The relic version the stored URL was signed for. A mint after a
   * republish is a first look at new content, not a reload, so an entry
   * from an older version no longer dedupes. Optional because entries
   * written before versions existed carry none, and those degrade the
   * safe way: one open counted once, then the entry is overwritten.
   */
  readonly version?: number;
}

/**
 * The store, as an interface so tests run against memory and production runs
 * against a real database without the routes knowing which.
 */
export interface RelicStore {
  getRelic(id: string): Promise<RelicRow | undefined>;
  putRelic(row: RelicRow): Promise<void>;
  markPublished(
    id: string,
    at: number,
    objectLength: number,
    crc32c: string
  ): Promise<void>;
  consumeMint(id: string): Promise<number>;

  /**
   * Open the relic's next version: increment `version`, adopt the new
   * renderer class and declared size, and clear the publish markers so the
   * row says about the new version exactly what it says after a first
   * grant. Returns the updated row, or undefined if the relic is gone.
   */
  beginVersion(
    id: string,
    rendererClass: RendererClass,
    declaredSizeBytes: number,
    titleUpdate?: { readonly title: string | undefined },
    ownerUpdate?: { readonly ownerEmail: string | undefined }
  ): Promise<RelicRow | undefined>;

  getTombstone(id: string): Promise<Tombstone | undefined>;
  putTombstone(stone: Tombstone): Promise<void>;

  issueChallenge(ip: string, now: number): Promise<string>;
  consumeChallenge(nonce: string, now: number, ttl: number): Promise<boolean>;

  appendMintLog(entry: MintLogEntry): Promise<void>;
  readMintLog(): Promise<readonly MintLogEntry[]>;

  recentMint(
    id: string,
    ip: string,
    now: number,
    windowSeconds: number
  ): Promise<DedupEntry | undefined>;
  rememberMint(id: string, ip: string, entry: DedupEntry): Promise<void>;

  isBlocklisted(hash: string): Promise<boolean>;
  blocklist(hash: string): Promise<void>;

  putAbuseReport(report: AbuseReport): Promise<void>;
  readAbuseReports(): Promise<readonly AbuseReport[]>;

  putComment(row: CommentRow): Promise<void>;
  getComment(
    relicId: string,
    commentId: string
  ): Promise<CommentRow | undefined>;
  /** Oldest first, which is the order a thread is read in. */
  listComments(relicId: string): Promise<readonly CommentRow[]>;
  deleteComment(relicId: string, commentId: string): Promise<void>;
  /**
   * Apply a patch to one comment and return the updated row, or undefined
   * if the comment is gone. Concurrent writers must lose to each other
   * loudly where the store can tell, never silently overwrite.
   */
  updateComment(
    relicId: string,
    commentId: string,
    patch: CommentPatch
  ): Promise<CommentRow | undefined>;
  /**
   * Every comment on a relic, removed together with it. A comment outliving
   * the thing it comments on is a retention defect, not a leftover.
   */
  deleteCommentsForRelic(relicId: string): Promise<number>;
  /**
   * Relics an author has commented on, ordered by most recent engagement first.
   * Scoped strictly to the author address.
   */
  listCommentedRelics(author: string): Promise<readonly CommentedRelic[]>;

  putAuthLink(row: AuthLinkRow): Promise<void>;
  /** Single use: reading it consumes it, whether or not it had expired. */
  consumeAuthLink(tokenHash: string): Promise<AuthLinkRow | undefined>;
  putSession(row: SessionRow): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRow | undefined>;
  hasVerifiedIdentity(email: string): Promise<boolean>;
  recordVerifiedIdentity(email: string, at?: number): Promise<void>;
}

export class MemoryStore implements RelicStore {
  private readonly relics = new Map<string, RelicRow>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly mintLog: MintLogEntry[] = [];
  private readonly dedup = new Map<string, DedupEntry>();
  private readonly blocked = new Set<string>();
  private readonly reports: AbuseReport[] = [];
  private readonly comments = new Map<string, CommentRow[]>();
  private readonly authLinks = new Map<string, AuthLinkRow>();
  private readonly sessions = new Map<string, SessionRow>();
  private readonly verifiedEmails = new Set<string>();

  async getRelic(id: string): Promise<RelicRow | undefined> {
    return this.relics.get(id);
  }

  async beginVersion(
    id: string,
    rendererClass: RendererClass,
    declaredSizeBytes: number,
    titleUpdate?: { readonly title: string | undefined },
    ownerUpdate?: { readonly ownerEmail: string | undefined }
  ): Promise<RelicRow | undefined> {
    const row = this.relics.get(id);
    if (row === undefined) return undefined;
    const nextTitle = titleUpdate !== undefined ? titleUpdate.title : row.title;
    const nextOwnerEmail =
      ownerUpdate !== undefined ? ownerUpdate.ownerEmail : row.ownerEmail;
    const next: RelicRow = {
      ...row,
      version: row.version + 1,
      rendererClass,
      declaredSizeBytes,
      publishedAt: undefined,
      objectLength: undefined,
      objectCrc32c: undefined,
      title: nextTitle,
      ownerEmail: nextOwnerEmail,
    };
    this.relics.set(id, next);
    return next;
  }

  async putRelic(row: RelicRow): Promise<void> {
    this.relics.set(row.id, row);
  }

  async markPublished(
    id: string,
    at: number,
    objectLength: number,
    crc32c: string
  ): Promise<void> {
    const row = this.relics.get(id);
    if (row === undefined) return;
    row.publishedAt = at;
    row.objectLength = objectLength;
    row.objectCrc32c = crc32c;
  }

  async consumeMint(id: string): Promise<number> {
    const row = this.relics.get(id);
    if (row === undefined) return 0;
    row.mintsUsed += 1;
    return row.mintsUsed;
  }

  async getTombstone(id: string): Promise<Tombstone | undefined> {
    return this.tombstones.get(id);
  }

  async putTombstone(stone: Tombstone): Promise<void> {
    this.tombstones.set(stone.id, stone);
  }

  async issueChallenge(ip: string, now: number): Promise<string> {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nonce = [...bytes]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    this.challenges.set(nonce, { nonce, issuedAt: now, ip });
    return nonce;
  }

  async consumeChallenge(
    nonce: string,
    now: number,
    ttl: number
  ): Promise<boolean> {
    const challenge = this.challenges.get(nonce);
    if (challenge === undefined) return false;
    this.challenges.delete(nonce);
    return now - challenge.issuedAt <= ttl * 1000;
  }

  async appendMintLog(entry: MintLogEntry): Promise<void> {
    this.mintLog.push(entry);
  }

  async readMintLog(): Promise<readonly MintLogEntry[]> {
    return this.mintLog;
  }

  async recentMint(
    id: string,
    ip: string,
    now: number,
    windowSeconds: number
  ): Promise<DedupEntry | undefined> {
    const entry = this.dedup.get(`${id}\x00${ip}`);
    if (entry === undefined) return undefined;
    if (now - entry.at > windowSeconds * 1000) return undefined;
    return entry;
  }

  async rememberMint(id: string, ip: string, entry: DedupEntry): Promise<void> {
    this.dedup.set(`${id}\x00${ip}`, entry);
  }

  async isBlocklisted(hash: string): Promise<boolean> {
    return this.blocked.has(hash);
  }

  async blocklist(hash: string): Promise<void> {
    // Idempotent, so a scanner-triggered delete does not re-add its own hash.
    this.blocked.add(hash);
  }

  async putAbuseReport(report: AbuseReport): Promise<void> {
    this.reports.push(report);
  }

  async readAbuseReports(): Promise<readonly AbuseReport[]> {
    return this.reports;
  }

  async putComment(row: CommentRow): Promise<void> {
    const thread = this.comments.get(row.relicId) ?? [];
    // Copied whole rather than field by field. Rebuilding it here meant this
    // store silently dropped every field added to the row afterwards, which
    // is how the clear routing hint went missing in development and how an
    // edit stamp and a resolution would have followed it. A store that
    // writes less than its own row type is a lie about what was stored.
    thread.push({
      ...row,
      version: typeof row.version === 'number' ? row.version : undefined,
    });
    this.comments.set(row.relicId, thread);
  }

  async getComment(
    relicId: string,
    commentId: string
  ): Promise<CommentRow | undefined> {
    return this.comments.get(relicId)?.find((c) => c.id === commentId);
  }

  async listComments(relicId: string): Promise<readonly CommentRow[]> {
    // Sorted rather than trusting insertion order, because a real store
    // returns rows in whatever order it likes and the thread's contract is
    // oldest first. Ties break on id so the order is total, not merely
    // mostly-sorted, which is what makes the list reproducible.
    return [...(this.comments.get(relicId) ?? [])].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)
    );
  }

  async deleteComment(relicId: string, commentId: string): Promise<void> {
    const thread = this.comments.get(relicId);
    if (thread === undefined) return;
    const kept = thread.filter((c) => c.id !== commentId);
    if (kept.length === 0) this.comments.delete(relicId);
    else this.comments.set(relicId, kept);
  }

  async updateComment(
    relicId: string,
    commentId: string,
    patch: CommentPatch
  ): Promise<CommentRow | undefined> {
    const thread = this.comments.get(relicId);
    const index = thread?.findIndex((c) => c.id === commentId) ?? -1;
    if (thread === undefined || index === -1) return undefined;
    // The merge rules live in one function shared with the GCS store, so a
    // clearing patch behaves identically no matter where the row lives.
    const updated = applyCommentPatch(thread[index] as CommentRow, patch);
    thread[index] = updated;
    return updated;
  }

  async deleteCommentsForRelic(relicId: string): Promise<number> {
    const removed = this.comments.get(relicId)?.length ?? 0;
    this.comments.delete(relicId);
    return removed;
  }

  async listCommentedRelics(
    author: string
  ): Promise<readonly CommentedRelic[]> {
    const results: CommentedRelic[] = [];
    for (const [relicId, thread] of this.comments) {
      let lastCommentAt: number | undefined;
      for (const comment of thread) {
        if (comment.author === author) {
          if (
            lastCommentAt === undefined ||
            comment.createdAt > lastCommentAt
          ) {
            lastCommentAt = comment.createdAt;
          }
        }
      }
      if (lastCommentAt !== undefined) {
        results.push({ relicId, lastCommentAt });
      }
    }
    return results.sort(
      (a, b) =>
        b.lastCommentAt - a.lastCommentAt || (a.relicId < b.relicId ? -1 : 1)
    );
  }

  async putAuthLink(row: AuthLinkRow): Promise<void> {
    this.authLinks.set(row.tokenHash, row);
  }

  async consumeAuthLink(tokenHash: string): Promise<AuthLinkRow | undefined> {
    const row = this.authLinks.get(tokenHash);
    // Deleted whether or not it was still valid. A link that has been
    // presented once is spent, so a replay finds nothing rather than
    // finding an expired row it might be tempted to forgive.
    this.authLinks.delete(tokenHash);
    return row;
  }

  async putSession(row: SessionRow): Promise<void> {
    this.sessions.set(row.tokenHash, row);
    this.verifiedEmails.add(row.email.toLowerCase().trim());
  }

  async getSession(tokenHash: string): Promise<SessionRow | undefined> {
    return this.sessions.get(tokenHash);
  }

  async recordVerifiedIdentity(email: string, _at?: number): Promise<void> {
    this.verifiedEmails.add(email.toLowerCase().trim());
  }

  async hasVerifiedIdentity(email: string): Promise<boolean> {
    const normalized = email.toLowerCase().trim();
    if (this.verifiedEmails.has(normalized)) return true;
    for (const session of this.sessions.values()) {
      if (session.email.toLowerCase().trim() === normalized) return true;
    }
    return false;
  }
}
