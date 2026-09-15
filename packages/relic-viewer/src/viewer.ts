/**
 * The viewer's core, with no DOM in it, so every rule below is testable.
 *
 * What `spec/format.md` section 5 hands this unit, in order:
 *
 * - The fragment is read once and stripped via `history.replaceState` (2.5),
 *   which obliges a copy-link affordance and a dead-page state after reload.
 * - The viewing origin sends `Referrer-Policy: no-referrer` (section 0).
 * - The renderer class never routes (3.6), and the declared-versus-sniffed
 *   disagreement rule runs against the envelope header's declared mimetype
 *   and filename.
 * - Unknown versions refuse in both places (3.7), and `idlen != 0` refuses
 *   after the fetch (3.4).
 * - A decrypt failure does not mean "wrong key" (3.5).
 */

import {
  DecryptFailedError,
  deriveRendererClass,
  KeyIdPresentError,
  leastPrivileged,
  MalformedFragmentError,
  openRelic,
  parseFragment,
  plaintextSizeUpperBound,
  privilegeTier,
  type RendererClass,
  sniffContentClass,
  UnknownVersionError,
  VersionMismatchError,
} from '@relic/format';
import { diffCeilingFor, diffModeForRoute } from './diff.ts';
import { isComponentSource } from './jsx.ts';

/** Refuse before allocating anything this large. */
export const MAX_RENDER_BYTES = 100 * 1024 * 1024;

export type ViewerState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: ReadyView }
  | { kind: 'dead'; dead: DeadView };

export interface ReadyView {
  readonly filename: string;
  readonly declaredMimetype: string;
  readonly content: Uint8Array;
  readonly route: RenderRoute;
  /**
   * Set when the declared type and the sniffed type disagreed. The recipient
   * is told, because silently downgrading is how a viewer trains people to
   * ignore it.
   */
  readonly downgradeNotice: string | undefined;
  /** Backs the copy-link affordance the fragment strip obliges. */
  readonly shareUrl: string;
  /** The ciphertext revision this view was decrypted from. */
  readonly version: number;
  /** The newest revision available to this link holder. */
  readonly currentVersion: number;
}

/** Where content is allowed to render. Never derived from the server. */
export type RenderRoute =
  | 'markdown'
  | 'code'
  | 'image'
  | 'sandboxed-html'
  | 'sandboxed-jsx'
  | 'media'
  | 'pdf'
  | 'download';

export interface DeadView {
  readonly headline: string;
  readonly detail: string;
  /** Shown only where the recipient can actually act on it. */
  readonly action: 'retry' | 'reopen-original-link' | 'report' | 'none';
  readonly code: string;
}

export interface MintResponse {
  readonly url: string;
  readonly url_expires_at: string;
  readonly relic_expires_at: string | null;
  readonly object_length: number;
  readonly object_crc32c: string;
  readonly mints_remaining: number;
  /** The revision this URL signs. */
  readonly version: number;
  /** The newest revision retained for this relic. */
  readonly current_version: number;
}

export type HistoricalVersionState =
  | { readonly kind: 'ready'; readonly view: ReadyView }
  | {
      readonly kind: 'unavailable';
      readonly code: string;
      readonly detail: string;
    };

/**
 * Somewhere to keep a key so a reload does not lose it.
 *
 * The fragment is stripped from the address bar the moment it is read, which
 * is what makes a reload land on a page with no key. That is a real cost paid
 * for a real benefit, and remembering the key on the recipient's own machine
 * buys back the reload without putting the key back in the URL.
 *
 * It does change who can open the relic. Anyone with this browser profile can
 * reopen it for as long as the entry lives, without ever having the link.
 * That is a deliberate trade, it is scoped to the service origin, and it is
 * stated in the disclosure rather than done quietly.
 */
export interface KeyVault {
  /**
   * Remember a key against a relic, until the relic expires.
   *
   * `Number.POSITIVE_INFINITY` means the relic has no lifetime, so the key is
   * kept until the relic is deleted; the forget-on-dead path evicts it then.
   */
  remember(relicId: string, fragment: string, expiresAt: number): void;
  recall(relicId: string): string | undefined;
  forget(relicId: string): void;
}

export interface ViewerDeps {
  readonly serviceOrigin: string;
  readonly fetch: typeof globalThis.fetch;
  /** Reads `location.hash` exactly once, then hands it over. */
  readonly takeFragment: () => string;
  /** Calls `history.replaceState` to drop the fragment from the address bar. */
  readonly stripFragment: () => void;
  readonly locationHref: string;
  readonly keyVault: KeyVault;
}

/**
 * The link to hand somebody else: this page, plus the key.
 *
 * Keeps the origin and path the reader is actually on, so a custom domain or a
 * proxy in front of the service produces a link that works from where they got
 * it rather than one pointing at whatever the service calls itself.
 */
export function shareUrlFor(href: string, fragment: string): string {
  const url = new URL(href);
  url.hash = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  return url.toString();
}

export async function load(
  relicId: string,
  deps: ViewerDeps
): Promise<ViewerState> {
  // Read the hash once into a local variable, then strip it. Cheapest
  // insurance in the product: a sanitizer bypass, a stray same-origin script,
  // or a bundled first-party SDK finds nothing in `location.hash` to read.
  //
  // It shrinks the window without closing it. The URL with its fragment
  // existed before the replace, so browser history sync, an extension with
  // host permissions, and the application the link was clicked from all
  // already saw it.
  const fromUrl = deps.takeFragment();
  deps.stripFragment();

  // A reload arrives with no fragment, because reading it stripped it. Fall
  // back to what this browser was told last time.
  const recalled =
    fromUrl.length === 0 || fromUrl === '#'
      ? deps.keyVault.recall(relicId)
      : undefined;
  const fragment = recalled ?? fromUrl;
  /** Whether the key came from storage, so a bad one can be evicted. */
  const fromVault = recalled !== undefined;

  // Rebuilt from the key actually in use, never read back off the address bar.
  //
  // The address bar is the one place the key is guaranteed not to be: it was
  // stripped on the way in, and a reload arrives with it already gone. Taking
  // the share URL from `location.href` therefore produced a link with no key
  // on exactly the visits where the reader had to fall back to storage, and it
  // did it silently: the copy succeeded, the toast said the link contained the
  // key, and the recipient got a page that could not open.
  const shareUrl = shareUrlFor(deps.locationHref, fragment);

  if (fragment.length === 0 || fragment === '#') {
    // No key in the URL and none remembered here. Say so plainly, pointing
    // back at the original link rather than showing a decrypt error.
    return {
      kind: 'dead',
      dead: {
        headline: 'This link is missing its key',
        detail:
          'The part of the link after the # is the decryption key, and it ' +
          'is not here. This usually means the page was reloaded, which ' +
          'drops it. Open the original link again.',
        action: 'reopen-original-link',
        code: 'fragment_missing',
      },
    };
  }

  let key: Uint8Array;
  let version: number;
  try {
    // An unknown version refuses here, before the fetch: no mint, no consumed
    // download cap, no byte of egress.
    ({ key, version } = parseFragment(fragment));
  } catch (error) {
    if (error instanceof UnknownVersionError) {
      return dead(
        'This relic uses a newer format',
        'This viewer does not know how to read it. Nothing was fetched.',
        'none',
        'unknown_version'
      );
    }
    // A remembered key that no longer parses is corrupt storage, not a bad
    // link. Drop it so the next attempt is a clean one.
    if (fromVault) deps.keyVault.forget(relicId);
    if (error instanceof MalformedFragmentError) {
      return dead(
        'This link looks truncated',
        'The key in the link is not the right length. Links can lose ' +
          'characters when they are pasted or wrapped. Ask the sender to ' +
          'send it again.',
        'reopen-original-link',
        'fragment_malformed'
      );
    }
    throw error;
  }

  const minted = await mint(relicId, deps);
  if ('dead' in minted) {
    // Expired, removed, or never published. Whatever this browser remembered
    // is worthless now, and keeping a dead key is keeping a secret for no
    // reason at all.
    deps.keyVault.forget(relicId);
    return { kind: 'dead', dead: minted.dead };
  }
  const mintResponse = minted.mint;

  // The relic is real and this key reached it, so it is worth remembering
  // until the relic itself expires. Done after the mint rather than before,
  // so a key for a relic that does not exist is never written down. A relic
  // with no lifetime never expires, and Date.parse(null) is NaN, which the
  // vault would rightly refuse: map it to the explicit never-expires value.
  deps.keyVault.remember(
    relicId,
    fragment,
    mintResponse.relic_expires_at === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(mintResponse.relic_expires_at)
  );

  // Refuse before allocating, using a bound computed from the object length
  // and the record size rather than anything the server declared.
  const upperBound = plaintextSizeUpperBound(mintResponse.object_length);
  if (upperBound > MAX_RENDER_BYTES) {
    return dead(
      'This relic is too large to open here',
      `It holds up to ${formatBytes(upperBound)}, past what this viewer will ` +
        'load into a browser tab.',
      'none',
      'too_large'
    );
  }

  const fetched = await deps.fetch(mintResponse.url);
  if (!fetched.ok) {
    // A fetch that fails not-found after a successful mint is a takedown that
    // landed between the two. It must never render as a decrypt failure, or
    // the recipient blames the sender.
    return dead(
      'This relic is no longer available',
      'It was removed after this page started loading.',
      'report',
      'removed_after_mint'
    );
  }

  const bytes = new Uint8Array(await fetched.arrayBuffer());

  if (bytes.length !== mintResponse.object_length) {
    return dead(
      'The download was cut short',
      'The transfer did not complete. This is a network problem, not a ' +
        'problem with the link.',
      'retry',
      'truncated_transfer'
    );
  }

  try {
    const opened = await openRelic(bytes, key, version);
    const entry = opened.envelope.entries[0];
    if (entry === undefined) {
      return dead(
        'This relic is empty',
        'Its envelope declares no content.',
        'none',
        'empty_envelope'
      );
    }

    const route = routeFor(entry.filename, entry.mimetype, opened.content);

    return {
      kind: 'ready',
      view: {
        filename: entry.filename,
        declaredMimetype: entry.mimetype,
        content: opened.content,
        route: route.route,
        downgradeNotice: route.notice,
        shareUrl,
        version: mintResponse.version,
        currentVersion: mintResponse.current_version,
      },
    };
  } catch (error) {
    if (error instanceof KeyIdPresentError) {
      return dead(
        'This relic is malformed',
        'It sets a header field this format forbids.',
        'none',
        'keyid_present'
      );
    }
    if (error instanceof VersionMismatchError) {
      return dead(
        'This relic does not match its link',
        'The format version inside the file disagrees with the one in the ' +
          'link. The link may have been altered.',
        'none',
        'version_mismatch'
      );
    }
    if (error instanceof DecryptFailedError) {
      // Deliberately does not say "wrong key". A wrong key, a truncated
      // transfer, and a tampered header produce the identical symptom, and
      // claiming one of them would be a guess presented as a diagnosis.
      return dead(
        'This relic could not be opened',
        'The file did not decrypt. That can mean the link was altered or ' +
          'shortened, or that the stored file was changed. There is no way ' +
          'to tell which from here.',
        'reopen-original-link',
        'decrypt_failed'
      );
    }
    return dead(
      'This relic could not be read',
      'Its contents are not in a shape this viewer understands.',
      'none',
      'malformed_container'
    );
  }
}

async function mint(
  relicId: string,
  deps: ViewerDeps,
  requestedVersion?: number
): Promise<{ mint: MintResponse } | { dead: DeadView }> {
  const response = await deps.fetch(
    `${deps.serviceOrigin}/api/relics/${relicId}/mint`,
    requestedVersion === undefined
      ? { method: 'POST' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: requestedVersion }),
        }
  );

  if (response.ok) {
    return { mint: (await response.json()) as MintResponse };
  }

  const problem = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { dead: deadFromProblem(String(problem['code'] ?? 'unknown')) };
}

/**
 * Mint, fetch, and decrypt one retained revision without disturbing the
 * current view. The key is recovered from the in-memory share URL that already
 * backs Copy link. Neither plaintext nor a comparison result crosses the
 * service boundary.
 */
export async function loadHistoricalVersion(
  relicId: string,
  requestedVersion: number,
  current: ReadyView,
  deps: ViewerDeps
): Promise<HistoricalVersionState> {
  if (
    !Number.isInteger(requestedVersion) ||
    requestedVersion < 1 ||
    requestedVersion >= current.currentVersion
  ) {
    return {
      kind: 'unavailable',
      code: 'comparison_version_invalid',
      detail:
        `Version ${requestedVersion} is not available for comparison. Choose ` +
        `a version from 1 through ${current.currentVersion - 1}.`,
    };
  }

  const mode = diffModeForRoute(current.route);
  if (mode === undefined) {
    return {
      kind: 'unavailable',
      code: 'comparison_not_renderable',
      detail:
        'Earlier versions exist, but this file is download-only. Relik cannot ' +
        'compare media, archives, or binary files in the browser.',
    };
  }

  // The ceiling is per mode, because a rendered comparison holds two live DOM
  // trees the line comparison never allocates.
  const ceiling = diffCeilingFor(mode);
  if (current.content.length > ceiling.bytes) {
    return {
      kind: 'unavailable',
      code: 'comparison_too_large',
      detail:
        `Version ${current.version} is larger than the ${ceiling.label} ` +
        'comparison limit. It remains open normally.',
    };
  }

  let key: Uint8Array;
  let formatVersion: number;
  try {
    ({ key, version: formatVersion } = parseFragment(
      new URL(current.shareUrl).hash
    ));
  } catch {
    return {
      kind: 'unavailable',
      code: 'comparison_key_unavailable',
      detail:
        'The in-memory key is no longer available for this comparison. Reopen ' +
        'the original link.',
    };
  }

  const minted = await mint(relicId, deps, requestedVersion);
  if ('dead' in minted) {
    return {
      kind: 'unavailable',
      code: minted.dead.code,
      detail:
        `Version ${requestedVersion} could not be loaded for comparison. ` +
        `${minted.dead.detail} Version ${current.version} remains open.`,
    };
  }
  const mintResponse = minted.mint;

  if (
    mintResponse.version !== requestedVersion ||
    mintResponse.current_version !== current.currentVersion
  ) {
    return {
      kind: 'unavailable',
      code: 'comparison_version_mismatch',
      detail:
        'The service signed a different version than the viewer requested. ' +
        `Version ${current.version} remains open.`,
    };
  }

  const upperBound = plaintextSizeUpperBound(mintResponse.object_length);
  if (upperBound > ceiling.bytes) {
    return {
      kind: 'unavailable',
      code: 'comparison_too_large',
      detail:
        `Version ${requestedVersion} can hold up to ${formatBytes(upperBound)}, ` +
        `past the ${ceiling.label} comparison limit. Version ` +
        `${current.version} remains open.`,
    };
  }

  const fetched = await deps.fetch(mintResponse.url);
  if (!fetched.ok) {
    return {
      kind: 'unavailable',
      code: 'comparison_fetch_failed',
      detail:
        `Version ${requestedVersion} could not be downloaded. Version ` +
        `${current.version} remains open.`,
    };
  }

  const bytes = new Uint8Array(await fetched.arrayBuffer());
  if (bytes.length !== mintResponse.object_length) {
    return {
      kind: 'unavailable',
      code: 'comparison_truncated',
      detail:
        `Version ${requestedVersion} did not finish downloading. Version ` +
        `${current.version} remains open.`,
    };
  }

  try {
    const opened = await openRelic(bytes, key, formatVersion);
    const entry = opened.envelope.entries[0];
    if (entry === undefined) {
      return {
        kind: 'unavailable',
        code: 'comparison_empty',
        detail:
          `Version ${requestedVersion} has no content to compare. Version ` +
          `${current.version} remains open.`,
      };
    }

    if (opened.content.length > ceiling.bytes) {
      return {
        kind: 'unavailable',
        code: 'comparison_too_large',
        detail:
          `Version ${requestedVersion} is larger than the ${ceiling.label} ` +
          `comparison limit. Version ${current.version} remains open.`,
      };
    }

    const route = routeFor(entry.filename, entry.mimetype, opened.content);
    return {
      kind: 'ready',
      view: {
        filename: entry.filename,
        declaredMimetype: entry.mimetype,
        content: opened.content,
        route: route.route,
        downgradeNotice: route.notice,
        shareUrl: current.shareUrl,
        version: mintResponse.version,
        currentVersion: mintResponse.current_version,
      },
    };
  } catch {
    return {
      kind: 'unavailable',
      code: 'comparison_decrypt_failed',
      detail:
        `Version ${requestedVersion} could not be decrypted. Version ` +
        `${current.version} remains open.`,
    };
  }
}

/** Maps the server's codes onto what a recipient should actually be told. */
export function deadFromProblem(code: string): DeadView {
  switch (code) {
    case 'relic_not_found':
      return view(
        'No such relic',
        'This link does not point at anything. It may have been mistyped.',
        'none'
      );
    case 'relic_expired':
      return view(
        'This relic has expired',
        'Relics are deleted on a fixed schedule and cannot be extended. Ask ' +
          'the sender to publish it again.',
        'none'
      );
    case 'relic_never_published':
      return view(
        'This relic was never uploaded',
        'The sender started publishing it and it never finished. Ask them ' +
          'to publish it again.',
        'none'
      );
    case 'relic_not_yet_published':
      // Temporary. It must not read as a dead link.
      return view(
        'Still uploading',
        'The sender is still uploading this relic. It will be ready shortly.',
        'retry'
      );
    case 'relic_removed':
      return view(
        'This relic was removed',
        'It is no longer available. If you believe this was a mistake, you ' +
          'can contact us.',
        'report'
      );
    case 'download_cap_exhausted':
      return view(
        'This link has been opened too many times',
        'Each relic can be opened a fixed number of times. Waiting will not ' +
          'help. Ask the sender to publish it again.',
        'none'
      );
    case 'mint_rate_limited':
      return view(
        'Too many requests',
        'Give it a moment and try again.',
        'retry'
      );
    case 'service_paused':
      return view(
        'Relic is paused',
        'The service is temporarily not serving relics. Try again later.',
        'retry'
      );
    case 'invalid_relic_id':
      return view(
        'This link is not valid',
        'The relic id in the link is not a well-formed one.',
        'none'
      );
    default:
      return view(
        'This relic could not be opened',
        'Something went wrong reaching the service.',
        'retry'
      );
  }

  function view(
    headline: string,
    detail: string,
    action: DeadView['action']
  ): DeadView {
    return { headline, detail, action, code };
  }
}

export interface RouteDecision {
  readonly route: RenderRoute;
  readonly notice: string | undefined;
}

/**
 * Decide where content is allowed to render.
 *
 * The declared type comes from the envelope header, which sits inside the
 * AEAD and is therefore tamper-evident, and the sniffed type comes from the
 * decrypted bytes. When they disagree, route to the least privileged path
 * either type would allow, and say so.
 *
 * The renderer class is emitted into the served head as card metadata, but
 * it is not an input here. This function's parameters are the whole routing
 * surface, so routing on the class would require an explicit signature change
 * rather than a silent edit. A publisher-asserted routing input on the origin
 * holding the fragment secret is exactly the shape that turns a lie into
 * fragment theft in one step. The guard test in card-metadata-guard.test.ts
 * enforces that the built bundles never read the card metadata.
 */
export function routeFor(
  filename: string,
  declaredMimetype: string,
  content: Uint8Array
): RouteDecision {
  const declared = classFromMimetype(declaredMimetype, filename);
  // Content only. Feeding the filename into the sniff would make this
  // comparison measure the declared name against itself, and it would agree
  // in exactly the case the rule exists to catch.
  let sniffed = sniffContentClass(content);

  // JSX is the one class the byte sniffer cannot see: telling a component
  // from prose takes a parser, `@relic/format` stays dependency-free, and no
  // cheap prefix separates the two. So the question is asked here, with the
  // compiler, and only when the declared class already says `jsx`.
  //
  // The gate is the declared class rather than content alone, and that is
  // deliberate. Asking it of every textual relic would sniff every valid
  // JavaScript file as `jsx` and downgrade it with a spurious notice, so the
  // parse is spent only where the answer can change the route. The answer
  // itself is content-truth the publisher cannot influence: prose fails to
  // parse and falls back to `code`, and the only route the upgrade can
  // produce is the sandboxed frame, never inline rendering on this origin.
  // A component that does not parse is shown as source, which is the
  // least-privileged telling of a lie.
  if (declared === 'jsx' && sniffed === 'code') {
    const source = new TextDecoder('utf-8', { fatal: false }).decode(content);
    if (isComponentSource(source, filename)) sniffed = 'jsx';
  }

  // Tiers, not classes. `markdown` and `code` are both escaped text and
  // carry identical privilege, and the sniffer cannot tell them apart, so
  // comparing classes would downgrade every Markdown relic ever published.
  if (privilegeTier(declared) === privilegeTier(sniffed)) {
    return { route: routeForClass(declared), notice: undefined };
  }

  const resolved = leastPrivileged(declared, sniffed);
  return {
    route: routeForClass(resolved),
    notice:
      `This file is named like ${describe(declared)} but its contents look ` +
      `like ${describe(sniffed)}. It is being shown the safer way.`,
  };
}

export function routeForClass(cls: RendererClass): RenderRoute {
  switch (cls) {
    case 'markdown':
      return 'markdown';
    case 'code':
      return 'code';
    case 'image':
      return 'image';
    case 'media':
      return 'media';
    case 'html':
      return 'sandboxed-html';
    case 'jsx':
      // Same frame as HTML, different payload: transpiled text posted in
      // rather than markup. Never inline on this origin.
      return 'sandboxed-jsx';
    case 'pdf':
      return 'pdf';
    default:
      // Archives and arbitrary binaries are download-only in the
      // first release. The framing keeps range decryption available so this
      // can change without a new container.
      return 'download';
  }
}

function classFromMimetype(mimetype: string, filename: string): RendererClass {
  const type = mimetype.toLowerCase().split(';')[0]?.trim() ?? '';

  if (type === 'text/markdown') return 'markdown';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'image/svg+xml') return 'html'; // SVG carries script
  if (type === 'text/jsx' || type === 'text/tsx') return 'jsx';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'media';
  if (type === 'application/pdf') return 'pdf';
  if (
    type === 'application/zip' ||
    type === 'application/gzip' ||
    type === 'application/x-tar'
  ) {
    return 'archive';
  }
  if (type.startsWith('text/') || type === 'application/json') return 'code';
  if (type === 'application/octet-stream') {
    // Uninformative, so fall back to the name, which is the only other
    // declared signal.
    return deriveRendererClass(new Uint8Array([0x20]), filename);
  }
  return 'binary';
}

function describe(cls: RendererClass): string {
  switch (cls) {
    case 'markdown':
      return 'a Markdown document';
    case 'code':
      return 'a text or code file';
    case 'html':
      return 'a web page';
    case 'jsx':
      return 'a React component';
    case 'pdf':
      return 'a PDF document';
    case 'image':
      return 'an image';
    case 'media':
      return 'audio or video';
    case 'archive':
      return 'an archive';
    default:
      return 'a binary file';
  }
}

function dead(
  headline: string,
  detail: string,
  action: DeadView['action'],
  code: string
): ViewerState {
  return { kind: 'dead', dead: { headline, detail, action, code } };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
