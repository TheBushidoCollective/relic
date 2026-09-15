/**
 * Comment encryption (`spec/format.md` 3.13).
 *
 * A comment about content the operator cannot read, stored in the clear,
 * hands the operator exactly what the architecture exists to deny. So comment
 * bodies are encrypted by whoever writes them, under a key only a holder of
 * the relic's link can derive.
 *
 * **The fragment does not change, and that is the constraint everything here
 * bends around.** `spec/format.md` 2.1 fixes the fragment at the marker and
 * the key, and says a third field takes a version bump. There is therefore no
 * room for a separate comment secret. What there is room for is another HKDF
 * label: RFC 8188 already expands the same input keying material twice, under
 * `Content-Encoding: aes128gcm\0` for the content key and
 * `Content-Encoding: nonce\0` for the base nonce, and a third distinct label
 * yields a third key independent of both. Independence is by construction
 * rather than by assertion, which is why this needs no version bump: the
 * container's bytes, the envelope's fields, and the fragment's shape are all
 * untouched. Nothing that was written before this existed decodes differently
 * after it.
 *
 * The salt is zero-length, unlike the container's, because there is no salt to
 * carry: a comment is not a container and has no header to put one in. RFC
 * 5869 permits it, and the label plus a per-comment nonce is what separates
 * comments from each other.
 *
 * The framing is deliberately not RFC 8188. A comment is small, read whole,
 * and never range-decrypted, so records, padding, and a 21-byte header would
 * all be overhead spent on properties comments do not need. It is
 * `nonce(12) || AES-128-GCM(key, nonce, plaintext)`, transported base64url.
 *
 * This package owns it because the viewer and the publishing client both
 * encrypt and decrypt comments, and a second definition of the derivation is
 * the drift this package exists to prevent.
 */

import {
  CommentDecryptFailedError,
  CommentTooLargeError,
  MalformedCommentError,
} from './errors.ts';

/**
 * The third label. Distinct from RFC 8188's two by construction, and namespaced
 * with a version segment so a later envelope change has a label to move to
 * without colliding with comments already written.
 */
const COMMENT_INFO = new TextEncoder().encode('relic/comments/v1');

/** AES-GCM's standard nonce length, prepended to every comment. */
export const COMMENT_NONCE_BYTES = 12;

/**
 * A body cap, enforced here rather than left to a caller.
 *
 * Enforced before encryption so the refusal names the limit, and enforced in
 * this package so it is one number rather than one per caller. Truncating
 * instead of refusing would change what a comment says, which is worse than
 * refusing to store it.
 */
export const COMMENT_BODY_LIMIT_BYTES = 4096;

/** A display name is decoration, so it gets a decoration-sized cap. */
export const COMMENT_DISPLAY_NAME_LIMIT_BYTES = 64;

/**
 * A rectangle in unit coordinates of whatever space the anchor carrying it
 * names. `x` and `y` are the top-left corner, `w` and `h` the extent, all in
 * 0 to 1. A zero-area rectangle is refused: a box nobody can see is a point
 * wearing a box's shape, and `pin` already exists for a point.
 */
export interface AnchorRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Where a comment sits on the relic, encrypted with the body so the
 * operator cannot read the mark either.
 *
 * Missing on a comment that is just a remark about the relic as a whole.
 *
 * **`text` and `pin` are frozen.** They are the two kinds that shipped, they
 * are already stored under keys this package cannot enumerate, and a reader
 * built before this paragraph parses exactly them and refuses any field it
 * has not seen. Extending either in place would turn every comment written
 * by a current writer into `MalformedComment` in that reader, which surfaces
 * to a person as "altered in storage". That is a lie about tampering told by
 * a version gap, so precision arrives as new kinds instead and the frozen
 * two are never widened.
 *
 * - `text` is a quote to re-find in the document. First exact occurrence,
 *   which is why `quote` exists beside it.
 * - `pin` is a point on the stage in unit coordinates.
 * - `quote` is a quote plus the text immediately around it, so a phrase that
 *   appears more than once resolves to the occurrence the reader selected
 *   rather than the first one in the document.
 * - `region` is a box on the artifact's own content box, not the stage's.
 *   The distinction is the whole point: a stage-relative box drifts when the
 *   same image is letterboxed differently at another viewport width, so a
 *   mark placed on a face on a wide screen lands beside it on a phone.
 * - `time` is a moment, or a span, in a media relic, with an optional box
 *   inside that frame.
 * - `page` is one page of a paged document, with an optional box or quote on
 *   it.
 * - `unsupported` is never written. It is what this parser returns for a
 *   `kind` it does not know, so a reader can say a mark exists and it cannot
 *   show it, which is true, instead of reporting the comment as unreadable,
 *   which is not.
 */
export type CommentAnchor =
  | { readonly kind: 'text'; readonly quote: string }
  | { readonly kind: 'pin'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'quote';
      readonly exact: string;
      readonly prefix?: string;
      readonly suffix?: string;
    }
  | { readonly kind: 'region'; readonly rect: AnchorRect }
  | {
      readonly kind: 'time';
      readonly t: number;
      readonly t_end?: number;
      readonly rect?: AnchorRect;
    }
  | {
      readonly kind: 'page';
      readonly page: number;
      readonly rect?: AnchorRect;
      readonly exact?: string;
    }
  | { readonly kind: 'unsupported'; readonly declared: string };

/** Longest quote stored on a text mark. A selection is not a document. */
export const COMMENT_ANCHOR_QUOTE_LIMIT_BYTES = 512;

/**
 * Longest run of surrounding text stored beside a quote, each side.
 *
 * Context exists to disambiguate an occurrence, not to reproduce the passage.
 * A run this long already separates every repeat of a phrase a reader could
 * plausibly have selected, and anything longer is the document leaking into
 * the mark.
 */
export const COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES = 128;

/**
 * Highest page number a `page` anchor may carry.
 *
 * A bound exists so a hostile value cannot be handed to a renderer as a page
 * to seek to, and it is far above any document a reader is annotating.
 */
export const COMMENT_ANCHOR_MAX_PAGE = 10_000;

/**
 * Longest media offset a `time` anchor may carry, in seconds.
 *
 * Twenty-four hours. The same reasoning as the page ceiling: the value is
 * handed to a player as a seek target, so it is bounded here rather than
 * trusted there.
 */
export const COMMENT_ANCHOR_MAX_SECONDS = 86_400;

/**
 * What a comment carries.
 *
 * `display_name` aliases the commenter's identity for presentation and never
 * replaces it: the identity is the verified address the service holds, and
 * this is untrusted display text living inside the ciphertext where the
 * service cannot read it.
 *
 * `anchor` is omitted from the sealed JSON when it is null, so a freeform
 * comment stays readable to a parser that has not learned marks yet.
 */
export interface CommentPlaintext {
  readonly body: string;
  readonly display_name: string | null;
  /** Absent or null is a freeform comment, not a mark. */
  readonly anchor?: CommentAnchor | null;
}

/**
 * Derive a relic's comment key from the same 16 bytes the fragment carries.
 *
 * HKDF-SHA256, zero-length salt, `relic/comments/v1`, expanded to 128 bits.
 */
export async function deriveCommentKey(
  keyBytes: Uint8Array
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    toBufferSource(keyBytes),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: COMMENT_INFO,
    },
    material,
    128
  );
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Seal one comment. The nonce is drawn fresh per call, never derived from a
 * counter, because comments have no ordering this package can see and a reused
 * nonce under a reused key loses the plaintext outright.
 */
export async function encryptComment(
  commentKey: CryptoKey,
  plaintext: CommentPlaintext
): Promise<string> {
  const bodyBytes = new TextEncoder().encode(plaintext.body);
  if (bodyBytes.length > COMMENT_BODY_LIMIT_BYTES) {
    throw new CommentTooLargeError(
      'body',
      bodyBytes.length,
      COMMENT_BODY_LIMIT_BYTES
    );
  }
  if (plaintext.display_name !== null) {
    const nameBytes = new TextEncoder().encode(plaintext.display_name).length;
    if (nameBytes > COMMENT_DISPLAY_NAME_LIMIT_BYTES) {
      throw new CommentTooLargeError(
        'display_name',
        nameBytes,
        COMMENT_DISPLAY_NAME_LIMIT_BYTES
      );
    }
  }
  if (plaintext.anchor != null) {
    assertWritableAnchor(plaintext.anchor);
  }

  const encoded = new TextEncoder().encode(
    JSON.stringify({
      body: plaintext.body,
      display_name: plaintext.display_name,
      ...(plaintext.anchor == null ? {} : { anchor: plaintext.anchor }),
    })
  );
  const nonce = crypto.getRandomValues(new Uint8Array(COMMENT_NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBufferSource(nonce) },
      commentKey,
      toBufferSource(encoded)
    )
  );

  const framed = new Uint8Array(nonce.length + sealed.length);
  framed.set(nonce, 0);
  framed.set(sealed, nonce.length);
  return base64url(framed);
}

/**
 * Open one comment, parsing strictly.
 *
 * An unknown field is refused rather than ignored, so an extension to this
 * envelope has to be a deliberate change instead of something a shrugging
 * parser absorbed. A `display_name` that is present and neither a string nor
 * null is refused for the same reason: coercing it to null would silently
 * discard whatever the writer meant.
 */
export async function decryptComment(
  commentKey: CryptoKey,
  ciphertext: string
): Promise<CommentPlaintext> {
  const framed = decodeBase64url(ciphertext);
  if (framed.length <= COMMENT_NONCE_BYTES) {
    throw new MalformedCommentError(
      `comment is ${framed.length} bytes, too short to carry a ` +
        `${COMMENT_NONCE_BYTES}-byte nonce and a tag`
    );
  }

  let opened: Uint8Array;
  try {
    opened = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: toBufferSource(framed.subarray(0, COMMENT_NONCE_BYTES)),
        },
        commentKey,
        toBufferSource(framed.subarray(COMMENT_NONCE_BYTES))
      )
    );
  } catch {
    // No cause, per `spec/format.md` 3.5. A wrong key, a truncated value, and
    // a tampered nonce are the same symptom from here.
    throw new CommentDecryptFailedError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(opened)
    );
  } catch {
    throw new MalformedCommentError('comment plaintext is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MalformedCommentError('comment plaintext is not a JSON object');
  }

  const fields = parsed as Record<string, unknown>;
  const unknown = Object.keys(fields).filter(
    (key) => key !== 'body' && key !== 'display_name' && key !== 'anchor'
  );
  if (unknown.length > 0) {
    throw new MalformedCommentError(
      `comment carries unknown field(s): ${unknown.join(', ')}`
    );
  }

  const body = fields['body'];
  if (typeof body !== 'string') {
    throw new MalformedCommentError('comment body is missing or not a string');
  }

  const displayName = fields['display_name'];
  if (displayName !== null && typeof displayName !== 'string') {
    throw new MalformedCommentError(
      'comment display_name is present and is neither a string nor null'
    );
  }

  return {
    body,
    display_name: displayName,
    anchor: parseAnchor(fields['anchor']),
  };
}

/**
 * Read one anchor off a decrypted comment.
 *
 * Two different strictnesses, and the difference is deliberate. **An unknown
 * field inside a known kind is refused**, exactly as the envelope refuses
 * one, because that is the tampering and typo case and absorbing it would
 * discard whatever the writer meant. **An unknown `kind` is not refused**: it
 * comes back as `unsupported`, because the only thing that produces one is a
 * reader older than the writer, and the honest report is that a mark exists
 * this page cannot show rather than that the comment is unreadable.
 */
function parseAnchor(value: unknown): CommentAnchor | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new MalformedCommentError('comment anchor is not an object');
  }
  const anchor = value as Record<string, unknown>;
  const kind = anchor['kind'];
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new MalformedCommentError('comment anchor kind is missing');
  }

  if (kind === 'text') {
    const quote = requireQuote(anchor, 'quote', 'text');
    refuseExtra(anchor, ['kind', 'quote'], 'text');
    return { kind: 'text', quote };
  }

  if (kind === 'pin') {
    const x = requireUnit(anchor['x'], 'pin x');
    const y = requireUnit(anchor['y'], 'pin y');
    refuseExtra(anchor, ['kind', 'x', 'y'], 'pin');
    return { kind: 'pin', x, y };
  }

  if (kind === 'quote') {
    const exact = requireQuote(anchor, 'exact', 'quote');
    const prefix = optionalContext(anchor['prefix'], 'quote prefix');
    const suffix = optionalContext(anchor['suffix'], 'quote suffix');
    refuseExtra(anchor, ['kind', 'exact', 'prefix', 'suffix'], 'quote');
    return {
      kind: 'quote',
      exact,
      ...(prefix === undefined ? {} : { prefix }),
      ...(suffix === undefined ? {} : { suffix }),
    };
  }

  if (kind === 'region') {
    const rect = requireRect(anchor['rect'], 'region');
    refuseExtra(anchor, ['kind', 'rect'], 'region');
    return { kind: 'region', rect };
  }

  if (kind === 'time') {
    const t = requireSeconds(anchor['t'], 'time t');
    const end = anchor['t_end'];
    const tEnd =
      end === undefined ? undefined : requireSeconds(end, 'time t_end');
    if (tEnd !== undefined && tEnd <= t) {
      throw new MalformedCommentError(
        'time anchor t_end is not after t, so the span is empty or reversed'
      );
    }
    const box = anchor['rect'];
    const rect = box === undefined ? undefined : requireRect(box, 'time');
    refuseExtra(anchor, ['kind', 't', 't_end', 'rect'], 'time');
    return {
      kind: 'time',
      t,
      ...(tEnd === undefined ? {} : { t_end: tEnd }),
      ...(rect === undefined ? {} : { rect }),
    };
  }

  if (kind === 'page') {
    const page = anchor['page'];
    if (
      typeof page !== 'number' ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > COMMENT_ANCHOR_MAX_PAGE
    ) {
      throw new MalformedCommentError(
        `page anchor page is not an integer in 1 to ${COMMENT_ANCHOR_MAX_PAGE}`
      );
    }
    const box = anchor['rect'];
    const rect = box === undefined ? undefined : requireRect(box, 'page');
    const quoted = anchor['exact'];
    const exact =
      quoted === undefined ? undefined : requireQuote(anchor, 'exact', 'page');
    refuseExtra(anchor, ['kind', 'page', 'rect', 'exact'], 'page');
    return {
      kind: 'page',
      page,
      ...(rect === undefined ? {} : { rect }),
      ...(exact === undefined ? {} : { exact }),
    };
  }

  // The forward-tolerant branch. A `kind` this build has never heard of is a
  // writer newer than this reader, which is a version gap and not a defect in
  // the comment, so it keeps its body and loses only the ability to be shown
  // in place.
  return { kind: 'unsupported', declared: kind };
}

/**
 * Refuse an anchor that must never be written, and enforce the caps.
 *
 * `unsupported` is the one kind a writer may never seal: it exists to
 * describe a gap a reader found, and writing it would store a comment
 * pointing at nothing, permanently, under a key nobody can rewrite.
 */
function assertWritableAnchor(anchor: CommentAnchor): void {
  if (anchor.kind === 'unsupported') {
    throw new MalformedCommentError(
      'an unsupported anchor describes a reader gap and is never written'
    );
  }
  if (anchor.kind === 'text') capQuote(anchor.quote);
  if (anchor.kind === 'quote') {
    capQuote(anchor.exact);
    capContext(anchor.prefix);
    capContext(anchor.suffix);
  }
  if (anchor.kind === 'page' && anchor.exact !== undefined) {
    capQuote(anchor.exact);
  }
  // Every other field is a bounded number, and the bound is checked on the
  // way back in by `parseAnchor`. Round-tripping a value this side accepted
  // and that side refuses would be the real defect, so the writer runs the
  // same predicates rather than a second, looser copy of them.
  parseAnchor(JSON.parse(JSON.stringify(anchor)) as unknown);
}

function capQuote(quote: string): void {
  const bytes = new TextEncoder().encode(quote).length;
  if (bytes > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES) {
    throw new CommentTooLargeError(
      'anchor',
      bytes,
      COMMENT_ANCHOR_QUOTE_LIMIT_BYTES
    );
  }
}

function capContext(context: string | undefined): void {
  if (context === undefined) return;
  const bytes = new TextEncoder().encode(context).length;
  if (bytes > COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES) {
    throw new CommentTooLargeError(
      'anchor',
      bytes,
      COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES
    );
  }
}

function requireQuote(
  anchor: Record<string, unknown>,
  field: string,
  kind: string
): string {
  const quote = anchor[field];
  if (typeof quote !== 'string' || quote.length === 0) {
    throw new MalformedCommentError(`${kind} anchor ${field} is missing`);
  }
  const bytes = new TextEncoder().encode(quote).length;
  if (bytes > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES) {
    throw new MalformedCommentError(
      `${kind} anchor ${field} is ${bytes} bytes, over the ` +
        `${COMMENT_ANCHOR_QUOTE_LIMIT_BYTES}-byte cap`
    );
  }
  return quote;
}

function optionalContext(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new MalformedCommentError(`${label} is present and is not a string`);
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES) {
    throw new MalformedCommentError(
      `${label} is ${bytes} bytes, over the ` +
        `${COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES}-byte cap`
    );
  }
  return value;
}

function requireUnit(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new MalformedCommentError(`${label} is out of unit range`);
  }
  return value;
}

function requireSeconds(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > COMMENT_ANCHOR_MAX_SECONDS
  ) {
    throw new MalformedCommentError(
      `${label} is not a finite offset in 0 to ${COMMENT_ANCHOR_MAX_SECONDS} seconds`
    );
  }
  return value;
}

function requireRect(value: unknown, kind: string): AnchorRect {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedCommentError(`${kind} anchor rect is not an object`);
  }
  const rect = value as Record<string, unknown>;
  const x = requireUnit(rect['x'], `${kind} rect x`);
  const y = requireUnit(rect['y'], `${kind} rect y`);
  const w = requireUnit(rect['w'], `${kind} rect w`);
  const h = requireUnit(rect['h'], `${kind} rect h`);
  if (w === 0 || h === 0) {
    throw new MalformedCommentError(
      `${kind} anchor rect has no area, so it marks nothing`
    );
  }
  if (x + w > 1 || y + h > 1) {
    throw new MalformedCommentError(
      `${kind} anchor rect runs past the edge of what it is measured against`
    );
  }
  refuseExtra(rect, ['x', 'y', 'w', 'h'], `${kind} rect`);
  return { x, y, w, h };
}

function refuseExtra(
  value: Record<string, unknown>,
  allowed: readonly string[],
  kind: string
): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new MalformedCommentError(
      `${kind} anchor carries unknown field(s): ${extra.join(', ')}`
    );
  }
}

/** Unpadded base64url (RFC 4648 section 5), the same encoding the key uses. */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeBase64url(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) {
    throw new MalformedCommentError('comment is not unpadded base64url');
  }
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  } catch {
    throw new MalformedCommentError('comment is not decodable base64url');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Bun and the DOM disagree on whether a `Uint8Array` over a `SharedArrayBuffer`
 * satisfies `BufferSource`. Narrowing here keeps every call site clean, the
 * same way `rfc8188.ts` does.
 */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
