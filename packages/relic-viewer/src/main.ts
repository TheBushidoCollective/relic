/**
 * The DOM layer.
 *
 * Everything that decides anything lives in `viewer.ts`, which has no DOM in
 * it and is tested directly. This file only draws what that decided, so the
 * rules cannot quietly diverge from their tests.
 *
 * Two things here are security, not presentation:
 *
 * 1. **Content reaches the DOM through `textContent` or through the escaping
 *    renderer, never through `innerHTML` on raw bytes.**
 * 2. **HTML content is never rendered on this origin.** It goes to the
 *    usercontent origin through an iframe that gets the markup and never the
 *    key.
 */

import {
  type CommentAnchor,
  deriveCommentKey,
  parseFragment,
} from '@relic/format';
import {
  type AnchorSurface,
  adapterFor,
  anchorLabel,
  MARK_UNPLACEABLE_NOTE,
  UNSUPPORTED_ANCHOR_LABEL,
} from './anchoring.ts';
import {
  type FrameMarkClickMessage,
  type FramePointMessage,
  type FrameRegionMessage,
  type FrameSelectionMessage,
  isFrameMarkClickMessage,
  isFramePointMessage,
  isFrameRegionMessage,
  isFrameSelectionMessage,
  registerFrameAdapters,
} from './annotate-frame.ts';
import {
  type CommentCipher,
  type CommentEntry,
  commentCipher,
  commentTime,
  DELIVERY_DISCLOSURE,
  IDENTITY_DISCLOSURE,
  KEY_AT_RISK_NOTE,
  keySurvivesNavigation,
  loadThread,
  MAX_BODY_BYTES,
  MAX_DISPLAY_NAME_BYTES,
  PUBLISHER_AUTHOR,
  plainLabel,
  postComment,
  type Refusal,
  readSession,
  requestMagicLink,
  type SessionState,
  threadCountLabel,
  unwrapTextQuotes,
  utf8Bytes,
  wrapTextQuote,
} from './comments.ts';
import {
  bytesEqual,
  comparisonAvailability,
  createImageDiff,
  createTextDiff,
  diffModeForRoutes,
  type TextDiffPart,
  versionHistoryCopy,
} from './diff.ts';
import { diffTrees, type RenderedChange, type TreeDiff } from './domdiff.ts';
import { transpileJsx } from './jsx.ts';
import { highlightCode, renderMarkdown } from './markdown.ts';
import {
  applyMarks,
  captureTree,
  isTreeMessage,
  type Mark,
  type TreeNode,
} from './rendered-tree.ts';
import {
  type DeadView,
  formatBytes,
  type KeyVault,
  load,
  loadHistoricalVersion,
  type ReadyView,
  type ViewerDeps,
} from './viewer.ts';

registerFrameAdapters();

const SERVICE_ORIGIN =
  typeof window === 'undefined' ? '' : window.location.origin;

/**
 * The wordmark in the accession band.
 *
 * The recipient is deciding whether to trust an unfamiliar domain, so the
 * wordmark is the domain itself rather than a product name they have no way to
 * connect to the address bar. It is a brand fact and belongs in code: deriving
 * it from the serving origin would print whatever host the deployment happens
 * to answer on.
 */
const WORDMARK = 'relik.link';

/**
 * The marker beside the actions, in one place.
 *
 * It is the visible label, the accessible name, and the stem of the tooltip,
 * and it was three separate strings until two of them disagreed.
 */
const MARKER_LABEL = 'Runs author code, isolated';

const ICONS = {
  copy: 'M5 2h7a1 1 0 0 1 1 1v8h-1V3H5V2zM3 4h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 1v8h7V5H3z',
  compare:
    'M2 4h9L9 2l.7-.7L13 4.5 9.7 8 9 7.3l2-2H2V4zm12 8H5l2 2-.7.7L3 11.5 6.3 8l.7.7-2 2h9V12z',
  download:
    'M7.5 1h1v7.3l2.6-2.6.7.7L8 10.2 4.2 6.4l.7-.7 2.6 2.6V1zM2 12h12v1H2v-1z',
  source:
    'M5.7 3.3 2 7l3.7 3.7.7-.7L3.4 7l3-3-.7-.7zm4.6 0-.7.7 3 3-3 3 .7.7L14 7l-3.7-3.7z',
  rendered: 'M2 3h12v1H2V3zm0 3h12v1H2V6zm0 3h8v1H2V9zm0 3h10v1H2v-1z',
  flag: 'M3 1h1v14H3V1zm2 1h8l-2 3 2 3H5V2z',
  chevron: 'M3.4 5.7 8 10.3l4.6-4.6-.7-.7L8 8.9 4.1 5l-.7.7z',
  swipe: 'M7.5 1h1v14h-1V1zM2 7.5h3.5v1H2v-1zm8.5 0H14v1h-3.5v-1z',
  columns: 'M2 2h5v12H2V2zm1 1v10h3V3H3zm6-1h5v12H9V2zm1 1v10h3V3h-3z',
  // A speech rectangle with a tail, drawn on the same 16-unit grid and with
  // the same single-path construction as the rest of the set.
  comment: 'M2 2h12v9H7.5L4 14v-3H2V2zm1 1v7h2v2.1L7.1 10H13V3H3z',
} as const;

function icon(path: string): SVGSVGElement {
  // Inline SVG rather than an emoji or a webfont: the CSP blocks external
  // anything, and an emoji is not an icon system.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

function button(
  label: string,
  iconPath: string,
  onClick: () => void
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'action';
  element.appendChild(icon(iconPath));
  const text = document.createElement('span');
  text.textContent = label;
  element.appendChild(text);
  element.addEventListener('click', onClick);
  return element;
}

/**
 * The filename is untrusted and is used here as a lookup key, which is the
 * same defect class as archive entry names. Path separators and leading dots
 * are stripped rather than trusted.
 */
export function safeDownloadName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/^\.+/, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'relic';
}

/**
 * The mimetype handed to a Blob is derived from magic bytes, never from the
 * declared type. A declared `image/svg+xml` would otherwise be a route into
 * script execution, which is why SVG is classified as a web page instead.
 */
export function sniffImageType(content: Uint8Array): string {
  const starts = (...bytes: number[]): boolean =>
    bytes.every((byte, index) => content[index] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x42, 0x4d)) return 'image/bmp';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    content[8] === 0x57 &&
    content[9] === 0x45
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

function decodeText(content: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(content);
}

function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const element = document.createElement('div');
  element.className = 'toast';
  element.setAttribute('role', 'status');
  element.textContent = message;
  document.body.appendChild(element);
  window.setTimeout(() => element.remove(), 4000);
}

/**
 * A one-off statement above the content.
 *
 * The pre-render statement that used to greet every sandboxed relic is gone,
 * demoted to a marker in the bar, because the risk it described was removed.
 * This remains for the cases that are genuinely about this file: a downgrade,
 * or a component that would not compile. Those are conditions of the content
 * in front of the reader, not a standing warning.
 */
function notice(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'notice';
  element.appendChild(icon(ICONS.flag));
  const span = document.createElement('span');
  span.textContent = text;
  element.appendChild(span);
  return element;
}

function downloadContent(view: ReadyView): void {
  const blob = new Blob([view.content as unknown as BlobPart], {
    type: 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeDownloadName(view.filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export interface BarOptions {
  readonly onCompare?: () => void;
  readonly comparisonOpen?: boolean;
  /**
   * Which version the reader is looking at, when that is not the current
   * one. Set while a comparison is open so the taskbar names the version
   * being compared rather than the one behind it.
   */
  readonly selectedVersion?: number;
  /**
   * Takes the reader to the thread. Present on every renderable relic, and
   * absent while a comparison is open, where the thread is not on the page.
   */
  readonly onComments?: () => void;
  /**
   * How many comments the thread is showing, once it knows. `undefined` is
   * the loading state rather than zero: a badge reading `0` before the fetch
   * lands is a claim, and it is wrong about a third of the time.
   */
  readonly commentCount?: number;
  /** Offered only when there is more than one historical version to pick. */
  readonly onSelectVersion?: (version: number) => void;
}

/**
 * The version, as the taskbar shows it.
 *
 * Two strings rather than one, because the row has already overflowed once at
 * narrow width and the long form does not fit at 320 CSS pixels. The
 * stylesheet swaps them, so neither form is built by measuring anything.
 */
function versionLabels(
  shown: number,
  current: number
): { readonly long: string; readonly short: string } {
  return {
    long: `Version ${shown} of ${current}`,
    short: `v${shown}/${current}`,
  };
}

/**
 * The version chip in the identity zone, which is a control only when there
 * is a choice to make.
 *
 * A relic on its second version has exactly one historical version, so a
 * picker there would be a menu with one item: it looks like a decision and
 * offers none. That case renders a label, and Compare versions in the actions
 * zone is the only control. From the third version on there is a real choice,
 * so the chip becomes an owned listbox.
 *
 * Owned rather than a native `select`, and that is a platform limit rather
 * than a styling preference: a native popup cannot be positioned or sized by
 * the page, and on macOS it rendered as a large panel detached from its
 * control, floating in empty space. No stylesheet reaches it.
 */
function buildVersionControl(
  view: ReadyView,
  options: BarOptions
): HTMLElement | undefined {
  // A single-version relic says nothing about versions at all. A number with
  // no history behind it invites a question that has no answer.
  if (!Number.isInteger(view.currentVersion) || view.currentVersion <= 1) {
    return undefined;
  }

  const shown = options.selectedVersion ?? view.version;
  const labels = versionLabels(shown, view.currentVersion);
  const wrap = document.createElement('div');
  wrap.className = 'version';

  const text = (parent: HTMLElement): void => {
    const long = document.createElement('span');
    long.className = 'version-long';
    long.textContent = labels.long;
    const short = document.createElement('span');
    short.className = 'version-short';
    short.setAttribute('aria-hidden', 'true');
    short.textContent = labels.short;
    parent.append(long, short);
  };

  const onSelect = options.onSelectVersion;
  if (onSelect === undefined || view.currentVersion < 3) {
    const label = document.createElement('div');
    label.className = 'version-label';
    text(label);
    wrap.appendChild(label);
    return wrap;
  }

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'version-label version-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute(
    'aria-label',
    `${labels.long}. Choose an earlier version to compare`
  );
  text(trigger);
  trigger.appendChild(icon(ICONS.chevron));

  const list = document.createElement('div');
  list.className = 'version-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Earlier version to compare');
  list.hidden = true;

  const optionElements: HTMLElement[] = [];
  for (let version = view.currentVersion - 1; version >= 1; version--) {
    const option = document.createElement('div');
    option.className = 'version-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', version === shown ? 'true' : 'false');
    // Roving focus rather than a tab stop each: a listbox is one stop, and
    // arrow keys move within it.
    option.tabIndex = -1;
    option.textContent = `Version ${version}`;
    option.addEventListener('click', () => {
      close();
      onSelect(version);
    });
    list.appendChild(option);
    optionElements.push(option);
  }

  let open = false;
  function close(focusTrigger = false): void {
    if (!open) return;
    open = false;
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger.focus();
  }

  const move = (from: number, delta: number): void => {
    const last = optionElements.length - 1;
    const next = Math.min(last, Math.max(0, from + delta));
    optionElements[next]?.focus();
  };

  function show(index: number): void {
    open = true;
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    optionElements[index]?.focus();
  }

  trigger.addEventListener('click', () => {
    if (open) close();
    else show(0);
  });

  trigger.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')
      show(0);
    else if (event.key === 'ArrowUp') show(optionElements.length - 1);
    else return;
    event.preventDefault();
  });

  list.addEventListener('keydown', (event: KeyboardEvent) => {
    const index = optionElements.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    if (event.key === 'ArrowDown') move(index, 1);
    else if (event.key === 'ArrowUp') move(index, -1);
    else if (event.key === 'Home') move(index, -optionElements.length);
    else if (event.key === 'End') move(index, optionElements.length);
    else if (event.key === 'Escape' || event.key === 'Tab') close(true);
    else if (event.key === 'Enter' || event.key === ' ')
      optionElements[index]?.click();
    else return;
    event.preventDefault();
  });

  // A click anywhere else dismisses it. Bound on the document rather than on
  // a blur, because focus moves inside the list on every arrow key and a
  // blur handler would close it mid-navigation.
  document.addEventListener('click', (event: Event) => {
    if (!wrap.contains(event.target as Node)) close();
  });

  wrap.append(trigger, list);
  return wrap;
}

/**
 * The taskbar, built as an accession label rather than app chrome.
 *
 * The relic ID is a catalog number and reads as one: monospace, letterspaced,
 * selectable. The filename is untrusted display text and goes in through
 * `textContent`.
 */
export function buildBar(
  view: ReadyView,
  relicId: string,
  options: BarOptions = {}
): HTMLElement {
  const bar = document.createElement('header');
  bar.className = 'bar';

  const mark = document.createElement('div');
  mark.className = 'mark';
  mark.textContent = WORDMARK;
  bar.appendChild(mark);

  const identity = document.createElement('div');
  identity.className = 'identity';

  const name = document.createElement('div');
  name.className = 'filename';
  name.textContent = view.filename.length > 0 ? view.filename : 'Untitled';
  name.title = view.filename;

  // The relic id and the version sit on one metadata line, because a version
  // number is artifact metadata of exactly the same kind as a catalog number.
  // They share the identity zone rather than joining the actions, and that is
  // load bearing: identity is the only flexible column on the row, so the
  // pressure a new element adds lands on an ellipsis that already exists
  // instead of pushing a control off the end.
  const meta = document.createElement('div');
  meta.className = 'identity-meta';

  const accession = document.createElement('div');
  accession.className = 'accession';
  accession.textContent = relicId;
  meta.appendChild(accession);

  const version = buildVersionControl(view, options);
  if (version !== undefined) meta.appendChild(version);

  identity.append(name, meta);
  bar.appendChild(identity);

  const actions = document.createElement('div');
  actions.className = 'actions';

  // A statement of fact, sitting with the actions rather than above the
  // content. It used to be a banner, and the risk it warned about, content
  // reaching the network, no longer exists.
  //
  // It collapses to its icon at narrow widths exactly like the buttons beside
  // it. Keeping this label while hiding theirs put a fact ahead of the
  // actions and pushed Report off the row, so the accessible name carries the
  // meaning once the text is gone.
  const marker = document.createElement('a');
  marker.className = 'action marker';
  marker.href = `${SERVICE_ORIGIN}/policy`;
  marker.rel = 'noopener noreferrer';
  // One string for the label and the accessible name, because WCAG 2.5.3
  // wants the name to contain the visible text and these had drifted: the
  // label read "Runs author code" while the name read "the author's code",
  // which is exactly the mismatch that breaks speech control.
  marker.setAttribute('aria-label', MARKER_LABEL);
  marker.title = `${MARKER_LABEL}. What Relic knows.`;
  marker.appendChild(icon(ICONS.source));
  const markerText = document.createElement('span');
  markerText.textContent = MARKER_LABEL;
  marker.appendChild(markerText);
  actions.appendChild(marker);

  // Comments is the eleventh element on the row and the sixth action, and it
  // is the first addition whose absence costs nothing, which is why it is the
  // one that leaves at the floor. The thread overlays the relic, and a handle
  // on the stage remains after the button leaves, so a reader who loses the
  // control still reaches the same thread. `viewer.md` 6.5 carries the arithmetic.
  //
  // A button rather than a link to a document fragment. A `#thread` href
  // would write a fragment into the address bar of the one page in this
  // product whose entire security model is about what lives there, and the
  // key had already been stripped out of it.
  if (options.onComments !== undefined) {
    const comments = button('Comments', ICONS.comment, options.onComments);
    // Named so the stylesheet can drop this one control at the 320px floor
    // without reaching for a positional selector that the next addition to
    // the row would silently repoint.
    comments.classList.add('action-comments');
    if (options.commentCount !== undefined) {
      const count = document.createElement('span');
      // Survives the narrow collapse that hides the label beside it, because
      // the number is the part a reader cannot get anywhere else on the row.
      count.className = 'action-count';
      count.textContent = String(options.commentCount);
      comments.appendChild(count);
      comments.title = threadCountLabel(options.commentCount);
    } else {
      comments.title = 'Comments on this relic';
    }
    actions.appendChild(comments);
  }

  const availability = comparisonAvailability(view);
  if (availability.kind === 'available' && options.onCompare !== undefined) {
    const label =
      options.comparisonOpen === true ? 'View current' : 'Compare versions';
    const compare = button(label, ICONS.compare, options.onCompare);
    compare.setAttribute(
      'aria-pressed',
      options.comparisonOpen === true ? 'true' : 'false'
    );
    compare.title =
      options.comparisonOpen === true
        ? `Return to version ${view.currentVersion}`
        : `Compare version ${view.currentVersion} with its history`;
    actions.appendChild(compare);
  }

  // The fragment was stripped from the address bar, so re-sharing has to come
  // from somewhere. This is that affordance, backed by the in-memory key.
  actions.appendChild(
    button('Copy link', ICONS.copy, () => {
      void navigator.clipboard.writeText(view.shareUrl).then(
        () => toast('Link copied. It contains the decryption key.'),
        () => toast('Could not copy. Copy the link from where you opened it.')
      );
    })
  );

  actions.appendChild(
    button('Download', ICONS.download, () => downloadContent(view))
  );

  const report = document.createElement('a');
  report.className = 'action';
  report.href = `${SERVICE_ORIGIN}/abuse`;
  report.rel = 'noopener noreferrer';
  report.appendChild(icon(ICONS.flag));
  const reportText = document.createElement('span');
  reportText.textContent = 'Report';
  report.appendChild(reportText);
  actions.appendChild(report);

  bar.appendChild(actions);
  return bar;
}

function renderMarkdownView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc';

  const source = decodeText(view.content);

  const prose = document.createElement('article');
  prose.className = 'prose';
  // renderMarkdown escapes before it adds markup, and nothing in the source
  // can become an element. That property is asserted directly in
  // test/markdown.test.ts against fifteen attack payloads.
  prose.innerHTML = renderMarkdown(source);

  const raw = document.createElement('pre');
  raw.className = 'raw';
  raw.hidden = true;
  raw.textContent = source;

  let showingSource = false;
  const toggle = button('View source', ICONS.source, () => {
    showingSource = !showingSource;
    prose.hidden = showingSource;
    raw.hidden = !showingSource;
    toggle.replaceChildren();
    toggle.appendChild(icon(showingSource ? ICONS.rendered : ICONS.source));
    const label = document.createElement('span');
    label.textContent = showingSource ? 'View rendered' : 'View source';
    toggle.appendChild(label);
  });

  const toggleRow = document.createElement('div');
  toggleRow.className = 'toggle-row';
  toggleRow.appendChild(toggle);

  wrapper.append(toggleRow, prose, raw);
  return wrapper;
}

function renderCodeView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc';

  const source = decodeText(view.content);
  const lines = source.split('\n');

  const table = document.createElement('div');
  table.className = 'code';

  const gutter = document.createElement('pre');
  gutter.className = 'gutter';
  gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = lines.map((_line, index) => index + 1).join('\n');

  const body = document.createElement('pre');
  body.className = 'code-body';
  // highlightCode escapes before it marks up.
  body.innerHTML = highlightCode(source);

  table.append(gutter, body);
  wrapper.appendChild(table);
  return wrapper;
}

function renderImageView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-image';

  const blob = new Blob([view.content as unknown as BlobPart], {
    type: sniffImageType(view.content),
  });
  const url = URL.createObjectURL(blob);

  const image = document.createElement('img');
  image.src = url;
  image.alt = view.filename;
  image.addEventListener('load', () => URL.revokeObjectURL(url));
  image.addEventListener('error', () => {
    URL.revokeObjectURL(url);
    wrapper.replaceChildren(
      notice('This image could not be decoded by the browser.')
    );
  });

  wrapper.appendChild(image);
  return wrapper;
}

/**
 * What a render frame is told to render. HTML crosses as markup, a component
 * crosses as JavaScript this origin transpiled without running.
 */
type RenderPayload =
  | { readonly type: 'relic:render'; readonly html: string }
  | { readonly type: 'relic:render-jsx'; readonly code: string };

interface FrameHandle {
  readonly frame: HTMLIFrameElement;
  /**
   * Mark this frame's own rendered nodes, once the parent holds a diff.
   *
   * The marks carry a child-index path and a kind, and nothing else. That is
   * what makes a second message safe where a second render would not be: this
   * channel is structurally incapable of changing what the document says.
   */
  annotate(marks: readonly Mark[]): void;
}

/**
 * One render frame on the usercontent origin.
 *
 * The iframe carries `sandbox` without `allow-same-origin`, so the document
 * lands in an opaque origin: it cannot reach this origin, it cannot reach the
 * usercontent origin's storage, and it cannot read `parent.location`. The
 * payload is posted in; the key never is.
 *
 * Scripts and nothing else. Popups are removed by dropping the flag, not by
 * CSP: a popup opens a new top-level context this frame's policy does not
 * govern.
 *
 * A comparison needs two renders of untrusted content, and it gets them from
 * two of these rather than by relaxing the frame's one-render guard. The
 * guard exists so nothing that can post here can swap the content after the
 * recipient has decided to trust what they are looking at, and a second
 * render is exactly that swap.
 */
function sandboxFrame(
  view: ReadyView,
  usercontentOrigin: string,
  payload: RenderPayload,
  onTree?: (tree: TreeNode) => void
): FrameHandle {
  const frame = document.createElement('iframe');
  frame.className = 'usercontent-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.src = `${usercontentOrigin}/sandbox.html`;
  frame.title = view.filename;

  // An opaque-origin frame has no origin to target, so '*' is the only option
  // the platform offers. It is safe here because the payload is the content
  // that frame is about to display anyway. The key is never in it.
  const post = (message: object): void => {
    frame.contentWindow?.postMessage(message, '*');
  };

  // Both paths, because the race runs in either direction: `load` can fire
  // before the frame's own script attaches its listener, and the frame's
  // ready message can arrive before `load`. The frame renders at most once,
  // so posting twice is harmless and losing the message is not.
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) return;
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type === 'relic:sandbox-ready') {
      post(payload);
      return;
    }
    // The captured tree is tag names, a fixed attribute allowlist, and text.
    // No markup crosses back to this origin, so nothing here has to be
    // sanitized before it is read: there is nothing to sanitize.
    if (onTree !== undefined && isTreeMessage(event.data)) {
      onTree(event.data.tree);
      return;
    }
    if (isFrameSelectionMessage(event.data)) {
      frame.dispatchEvent(
        new CustomEvent('relic:frame-selection', {
          detail: event.data,
          bubbles: true,
        })
      );
      return;
    }
    if (isFramePointMessage(event.data)) {
      frame.dispatchEvent(
        new CustomEvent('relic:frame-point', {
          detail: event.data,
          bubbles: true,
        })
      );
      return;
    }
    if (isFrameRegionMessage(event.data)) {
      frame.dispatchEvent(
        new CustomEvent('relic:frame-region', {
          detail: event.data,
          bubbles: true,
        })
      );
      return;
    }
    if (isFrameMarkClickMessage(event.data)) {
      frame.dispatchEvent(
        new CustomEvent('relic:frame-mark-click', {
          detail: event.data,
          bubbles: true,
        })
      );
      return;
    }
  };
  window.addEventListener('message', onMessage);
  frame.addEventListener('load', () => post(payload));

  return {
    frame,
    annotate: (marks) => post({ type: 'relic:annotate', marks }),
  };
}

/**
 * A component's payload, or nothing when it will not compile.
 *
 * The service origin must never execute relic content, and the transform
 * never does: it is a text-to-text rewrite whose output is posted as a
 * string. The frame turns that string back into running code by importing it
 * as a module. React is bundled into the inlined frame script because the
 * opaque origin cannot fetch same-origin assets or any remote dependency.
 */
function jsxPayload(view: ReadyView): RenderPayload | undefined {
  try {
    return {
      type: 'relic:render-jsx',
      code: transpileJsx(decodeText(view.content), view.filename),
    };
  } catch {
    return undefined;
  }
}

function payloadFor(view: ReadyView): RenderPayload | undefined {
  return view.route === 'sandboxed-jsx'
    ? jsxPayload(view)
    : { type: 'relic:render', html: decodeText(view.content) };
}

/** HTML renders on the usercontent origin and nowhere else. */
export function renderSandboxedHtml(
  view: ReadyView,
  usercontentOrigin: string
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-html';
  wrapper.appendChild(
    sandboxFrame(view, usercontentOrigin, {
      type: 'relic:render',
      html: decodeText(view.content),
    }).frame
  );
  return wrapper;
}

/**
 * A component renders on the usercontent origin and nowhere else, exactly
 * like HTML, but what crosses the frame boundary is different: the source is
 * transpiled here, on the service origin, into plain JavaScript first.
 */
export function renderSandboxedJsx(
  view: ReadyView,
  usercontentOrigin: string
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-jsx';

  const payload = jsxPayload(view);
  if (payload === undefined) {
    // Routing already established the bytes parse, so landing here means a
    // path the route decision could not see. Source view is the honest
    // fallback: it shows exactly what was published without running it.
    wrapper.appendChild(
      notice(
        'This file is named like a React component, but its contents do not ' +
          'compile as one. It is shown as source.'
      )
    );
    wrapper.appendChild(renderCodeView(view));
    return wrapper;
  }

  wrapper.appendChild(sandboxFrame(view, usercontentOrigin, payload).frame);
  return wrapper;
}

function renderDownloadView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-download';

  const card = document.createElement('div');
  card.className = 'card';

  const name = document.createElement('div');
  name.className = 'card-title';
  name.textContent = view.filename.length > 0 ? view.filename : 'Untitled';

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `${view.declaredMimetype} · ${formatBytes(view.content.length)}`;

  const action = button('Download', ICONS.download, () =>
    downloadContent(view)
  );
  action.classList.add('primary');

  const note = document.createElement('p');
  note.className = 'card-note';
  note.textContent =
    'This kind of file is not displayed in the browser. It has already been ' +
    'decrypted here, so downloading it does not contact the service again.';

  card.append(name, meta, action, note);
  wrapper.appendChild(card);
  return wrapper;
}

const AUDIO_EXTENSIONS: Record<string, true> = {
  mp3: true,
  wav: true,
  aac: true,
  ogg: true,
  flac: true,
  m4a: true,
  weba: true,
  opus: true,
};

function isAudioMedia(mimetype: string, filename: string): boolean {
  const mime = mimetype.toLowerCase().split(';')[0]?.trim() ?? '';
  if (mime.startsWith('audio/')) return true;
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return AUDIO_EXTENSIONS[ext] === true;
}

export function renderMediaView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-media';

  const blob = new Blob([view.content as unknown as BlobPart], {
    type: view.declaredMimetype,
  });
  const blobUrl = URL.createObjectURL(blob);

  let revoked = false;
  const revoke = (): void => {
    if (!revoked) {
      revoked = true;
      URL.revokeObjectURL(blobUrl);
    }
  };

  wrapper.addEventListener('cleanup', revoke);

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('unload', revoke, { once: true });
  }

  if (
    typeof MutationObserver !== 'undefined' &&
    typeof document !== 'undefined' &&
    document.body
  ) {
    const observer = new MutationObserver(() => {
      if (document.contains && !document.contains(wrapper)) {
        observer.disconnect();
        revoke();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const isAudio = isAudioMedia(view.declaredMimetype, view.filename);

  let player: HTMLVideoElement | HTMLAudioElement;
  if (isAudio) {
    const audio = document.createElement('audio');
    audio.className = 'media-player media-audio';
    audio.controls = true;
    audio.setAttribute('controls', '');
    audio.preload = 'metadata';
    audio.setAttribute('preload', 'metadata');
    audio.src = blobUrl;
    player = audio;
  } else {
    const video = document.createElement('video');
    video.className = 'media-player media-video';
    video.controls = true;
    video.setAttribute('controls', '');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'metadata';
    video.setAttribute('preload', 'metadata');
    video.src = blobUrl;
    player = video;
  }

  wrapper.appendChild(player);

  const strip = document.createElement('div');
  strip.className = 'media-meta-strip';

  const info = document.createElement('div');
  info.className = 'media-meta-info';

  const name = document.createElement('span');
  name.className = 'media-meta-name';
  name.textContent = view.filename.length > 0 ? view.filename : 'Untitled';

  const details = document.createElement('span');
  details.className = 'media-meta-details';
  details.textContent = `${view.declaredMimetype} · ${formatBytes(view.content.length)}`;

  info.append(name, details);

  const downloadBtn = button('Download', ICONS.download, () =>
    downloadContent(view)
  );

  strip.append(info, downloadBtn);
  wrapper.appendChild(strip);

  return wrapper;
}

export function buildCurrentStage(
  view: ReadyView,
  usercontentOrigin: string
): HTMLElement {
  const main = document.createElement('main');
  main.className = `stage stage-${view.route}`;

  const availability = comparisonAvailability(view);
  if (availability.kind === 'unavailable') {
    main.appendChild(notice(availability.detail));
  }

  if (view.downgradeNotice !== undefined) {
    main.appendChild(notice(view.downgradeNotice));
  }

  switch (view.route) {
    case 'markdown':
      main.appendChild(renderMarkdownView(view));
      break;
    case 'code':
      main.appendChild(renderCodeView(view));
      break;
    case 'image':
      main.appendChild(renderImageView(view));
      break;
    case 'media':
      main.appendChild(renderMediaView(view));
      break;
    case 'sandboxed-html':
      main.appendChild(renderSandboxedHtml(view, usercontentOrigin));
      break;
    case 'sandboxed-jsx':
      main.appendChild(renderSandboxedJsx(view, usercontentOrigin));
      break;
    default:
      main.appendChild(renderDownloadView(view));
      break;
  }

  return main;
}

function lineNumbers(
  start: number | undefined,
  count: number,
  displayedLines: number
): string {
  let value = '';
  for (let index = 0; index < displayedLines; index++) {
    if (index > 0) value += '\n';
    if (start !== undefined && index < count) value += String(start + index);
  }
  return value;
}

function appendDiffText(body: HTMLElement, part: TextDiffPart): void {
  if (part.segments === undefined) {
    body.textContent = part.value;
    return;
  }

  for (const segment of part.segments) {
    const span = document.createElement('span');
    span.className =
      segment.kind === 'unchanged' ? '' : `diff-inline-${segment.kind}`;
    span.textContent = segment.text;
    body.appendChild(span);
  }
}

function noChanges(summary: string): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'diff-empty';
  empty.setAttribute('role', 'status');
  const headline = document.createElement('strong');
  headline.textContent = 'No changes';
  const detail = document.createElement('span');
  detail.textContent = summary;
  empty.append(headline, detail);
  return empty;
}

/**
 * The line comparison, now scoped to code.
 *
 * Markdown, HTML and JSX all used to arrive here and be compared as source
 * text. That is a text diff of markup, which is not a visual diff of anything
 * a reader looks at, so each of them now compares as it renders. Code stays,
 * because for code the source is what a reader sees.
 */
export function renderCodeComparison(
  current: ReadyView,
  historical: ReadyView
): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = 'diff-view diff-view-code';

  const result = createTextDiff(
    decodeText(historical.content),
    decodeText(current.content)
  );
  const summary = document.createElement('div');
  summary.className = 'diff-summary';
  const label = document.createElement('strong');
  label.textContent = 'Code comparison';
  const counts = document.createElement('span');
  counts.textContent = result.summary;
  summary.append(label, counts);
  wrapper.appendChild(summary);

  if (!result.changed) {
    wrapper.appendChild(noChanges(result.summary));
    return wrapper;
  }

  const changes = document.createElement('div');
  changes.className = 'diff-changes';
  changes.setAttribute(
    'aria-label',
    `Changes from version ${historical.version} to version ${current.version}`
  );

  for (const part of result.parts) {
    const row = document.createElement('div');
    row.className = `diff-part diff-part-${part.kind}`;
    row.setAttribute(
      'aria-label',
      part.kind === 'unchanged'
        ? 'Unchanged lines'
        : `${part.kind === 'added' ? 'Added' : 'Removed'} lines`
    );

    const displayedLines = Math.max(part.beforeLines, part.currentLines);
    const beforeNumbers = document.createElement('pre');
    beforeNumbers.className = 'diff-gutter diff-gutter-before';
    beforeNumbers.setAttribute('aria-hidden', 'true');
    beforeNumbers.textContent = lineNumbers(
      part.beforeStart,
      part.beforeLines,
      displayedLines
    );

    const currentNumbers = document.createElement('pre');
    currentNumbers.className = 'diff-gutter diff-gutter-current';
    currentNumbers.setAttribute('aria-hidden', 'true');
    currentNumbers.textContent = lineNumbers(
      part.currentStart,
      part.currentLines,
      displayedLines
    );

    const body = document.createElement('pre');
    body.className = 'diff-body';
    appendDiffText(body, part);

    row.append(beforeNumbers, currentNumbers, body);
    changes.appendChild(row);
  }

  wrapper.appendChild(changes);
  return wrapper;
}

/** What a reader sees changed, in rendered terms rather than source terms. */
function renderChangeList(changes: readonly RenderedChange[]): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'diff-change-list';

  for (const change of changes) {
    const item = document.createElement('li');
    item.className = `diff-change diff-change-${change.kind}`;

    const kind = document.createElement('span');
    kind.className = 'diff-change-kind';
    kind.textContent = change.kind;

    const what = document.createElement('span');
    what.className = 'diff-change-what';
    what.textContent = change.label;

    // Rendered text from the compared versions, and it reaches the DOM as a
    // text node. Nothing parses it, so content that is secretly markup shows
    // as its own source and does nothing, which is the correct outcome on the
    // origin that holds the key.
    const detail = document.createElement('span');
    detail.className = 'diff-change-detail';
    if (change.kind === 'changed') {
      const before = document.createElement('del');
      before.textContent = change.before;
      const after = document.createElement('ins');
      after.textContent = change.after;
      detail.append(before, after);
    } else {
      detail.textContent =
        change.kind === 'added' ? change.after : change.before;
    }

    item.append(kind, what, detail);
    list.appendChild(item);
  }

  return list;
}

/** One side of a rendered comparison, and how to mark it once a diff exists. */
interface ComparisonPane {
  readonly element: HTMLElement;
  /** Resolves with the pane's captured tree, or never when it cannot render. */
  readonly tree: Promise<TreeNode>;
  annotate(marks: readonly Mark[]): void;
}

/** How long to wait for a frame that renders nothing at all. */
const TREE_TIMEOUT_MS = 6000;

/**
 * A markdown pane, rendered here rather than in a frame.
 *
 * Markdown renders on the service origin because `renderMarkdown` escapes
 * before it emits markup and its element and attribute set is fixed by the
 * viewer, so nothing in the source can become an element. That means both
 * versions are ordinary DOM on this origin, and the comparison needs no frame
 * and no protocol.
 */
function markdownPane(view: ReadyView): ComparisonPane {
  const prose = document.createElement('article');
  prose.className = 'prose';
  prose.innerHTML = renderMarkdown(decodeText(view.content));
  return {
    element: prose,
    tree: Promise.resolve(captureTree(prose)),
    annotate: (marks) => {
      applyMarks(prose, marks);
    },
  };
}

/**
 * A pane whose content is a page or a component, so it renders in its own
 * network-denied frame.
 *
 * Two frames rather than two renders in one: each keeps the single-render
 * guarantee it already had. The parent cannot read a frame's DOM, because the
 * render frame is an opaque origin, so the frame reports its own rendered
 * structure and the parent posts back marks that carry no content.
 */
function framePane(view: ReadyView, usercontentOrigin: string): ComparisonPane {
  const payload = payloadFor(view);
  if (payload === undefined) {
    return {
      element: notice(
        `Version ${view.version} is named like a React component and does ` +
          'not compile as one, so it cannot be rendered for comparison.'
      ),
      tree: new Promise<TreeNode>(() => {}),
      annotate: () => {},
    };
  }

  let settle: ((tree: TreeNode) => void) | undefined;
  const tree = new Promise<TreeNode>((resolve) => {
    settle = resolve;
  });
  const handle = sandboxFrame(view, usercontentOrigin, payload, (reported) =>
    settle?.(reported)
  );
  return { element: handle.frame, tree, annotate: handle.annotate };
}

/**
 * The visual comparison for every class that has a rendered form.
 *
 * Two panes, each showing one version as it actually renders, stacked under a
 * swipe control so the reader can wipe between them, or laid side by side.
 * On top of that, each pane's own changed nodes are outlined where they sit,
 * so a change is visible without hunting for it. Markdown defaults to side by
 * side because prose is read, and a page or a component defaults to the swipe
 * because what matters there is whether the pixels moved.
 */
export function renderRenderedComparison(
  current: ReadyView,
  historical: ReadyView,
  mode: 'markdown' | 'rendered',
  usercontentOrigin: string
): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = `diff-view diff-view-${mode}`;

  const summary = document.createElement('div');
  summary.className = 'diff-summary';
  const label = document.createElement('strong');
  label.textContent = 'Rendered comparison';
  const counts = document.createElement('span');
  counts.textContent = 'Rendering both versions.';
  summary.append(label, counts);
  wrapper.appendChild(summary);

  const before =
    mode === 'markdown'
      ? markdownPane(historical)
      : framePane(historical, usercontentOrigin);
  const after =
    mode === 'markdown'
      ? markdownPane(current)
      : framePane(current, usercontentOrigin);

  const stage = document.createElement('div');
  stage.className = 'compare-stage';
  stage.dataset['layout'] = mode === 'markdown' ? 'split' : 'swipe';
  stage.style.setProperty('--split', '50%');

  const beforePane = document.createElement('div');
  beforePane.className = 'compare-pane compare-pane-before';
  beforePane.appendChild(before.element);

  const afterPane = document.createElement('div');
  afterPane.className = 'compare-pane compare-pane-current';
  afterPane.appendChild(after.element);

  const beforeLabel = document.createElement('span');
  beforeLabel.className = 'compare-label compare-label-before';
  beforeLabel.textContent = `Version ${historical.version}`;
  const afterLabel = document.createElement('span');
  afterLabel.className = 'compare-label compare-label-current';
  afterLabel.textContent = `Version ${current.version}, current`;
  const divider = document.createElement('span');
  divider.className = 'compare-divider';
  divider.setAttribute('aria-hidden', 'true');

  stage.append(beforePane, afterPane, beforeLabel, afterLabel, divider);

  const controls = document.createElement('div');
  controls.className = 'compare-controls';

  const swipeControl = document.createElement('label');
  swipeControl.className = 'compare-swipe';
  const swipeText = document.createElement('span');
  const swipeLabel = `Reveal version ${current.version} over version ${historical.version}`;
  swipeText.textContent = swipeLabel;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = '50';
  slider.setAttribute('aria-label', swipeLabel);
  slider.addEventListener('input', () => {
    stage.style.setProperty('--split', `${slider.value}%`);
  });
  swipeControl.append(swipeText, slider);

  const layout = document.createElement('div');
  layout.className = 'compare-layout';
  const buttons: HTMLButtonElement[] = [];
  const setLayout = (next: 'swipe' | 'split'): void => {
    stage.dataset['layout'] = next;
    for (const candidate of buttons) {
      const active = candidate.dataset['layout'] === next;
      candidate.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    swipeControl.hidden = next !== 'swipe';
  };
  for (const [value, text, path] of [
    ['swipe', 'Swipe', ICONS.swipe],
    ['split', 'Side by side', ICONS.columns],
  ] as const) {
    const control = button(text, path, () => setLayout(value));
    control.dataset['layout'] = value;
    buttons.push(control);
    layout.appendChild(control);
  }
  setLayout(stage.dataset['layout'] === 'split' ? 'split' : 'swipe');

  controls.append(layout, swipeControl);

  const result = document.createElement('div');
  result.className = 'diff-rendered-result';

  wrapper.append(stage, controls, result);

  // The structural comparison is the annotation, and the two live renders are
  // the evidence. So a frame that never reports a tree costs the outlines and
  // the change list, and leaves the reader everything a swipe can show.
  const timeout = new Promise<undefined>((resolve) => {
    setTimeout(() => resolve(undefined), TREE_TIMEOUT_MS);
  });
  void Promise.race([Promise.all([before.tree, after.tree]), timeout]).then(
    (trees) => {
      if (trees === undefined) {
        counts.textContent =
          'Both versions are shown. Relik could not read their rendered ' +
          'structure, so changes are not outlined.';
        return;
      }
      const [beforeTree, afterTree] = trees;
      const diff: TreeDiff = diffTrees(beforeTree, afterTree);
      counts.textContent = diff.summary;
      before.annotate(diff.removedMarks);
      after.annotate(diff.addedMarks);
      if (!diff.changed) {
        result.replaceChildren(noChanges(diff.summary));
        return;
      }
      if (diff.changes.length > 0) {
        result.replaceChildren(renderChangeList(diff.changes));
      }
    }
  );

  return wrapper;
}

async function loadImage(
  image: HTMLImageElement,
  url: string
): Promise<HTMLImageElement> {
  image.src = url;
  try {
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function renderImageComparison(
  current: ReadyView,
  historical: ReadyView
): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = 'diff-view diff-view-image';

  const heading = document.createElement('div');
  heading.className = 'diff-summary';
  const label = document.createElement('strong');
  label.textContent = 'Image comparison';
  const status = document.createElement('span');
  status.textContent = 'Loading image dimensions.';
  heading.append(label, status);
  wrapper.appendChild(heading);

  if (bytesEqual(historical.content, current.content)) {
    status.textContent = 'No changed pixels or metadata bytes.';
    wrapper.appendChild(
      noChanges('No changes. These versions have identical content.')
    );
    return wrapper;
  }

  const canvas = document.createElement('div');
  canvas.className = 'image-diff-canvas';
  canvas.style.setProperty('--split', '50%');

  const before = document.createElement('img');
  before.className = 'image-diff-before';
  before.alt = `Version ${historical.version}`;

  const after = document.createElement('img');
  after.className = 'image-diff-current';
  after.alt = `Version ${current.version}`;

  const historicalUrl = URL.createObjectURL(
    new Blob([historical.content as unknown as BlobPart], {
      type: sniffImageType(historical.content),
    })
  );
  const currentUrl = URL.createObjectURL(
    new Blob([current.content as unknown as BlobPart], {
      type: sniffImageType(current.content),
    })
  );

  const beforeLabel = document.createElement('span');
  beforeLabel.className = 'image-diff-label image-diff-label-before';
  beforeLabel.textContent = `Version ${historical.version}`;
  const currentLabel = document.createElement('span');
  currentLabel.className = 'image-diff-label image-diff-label-current';
  currentLabel.textContent = `Version ${current.version}, current`;
  const divider = document.createElement('span');
  divider.className = 'image-diff-divider';
  divider.setAttribute('aria-hidden', 'true');
  canvas.append(before, after, beforeLabel, currentLabel, divider);

  const control = document.createElement('label');
  control.className = 'image-diff-control';
  const controlText = document.createElement('span');
  controlText.textContent = `Reveal version ${current.version} over version ${historical.version}`;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = '50';
  slider.setAttribute(
    'aria-label',
    `Reveal version ${current.version} over version ${historical.version}`
  );
  slider.addEventListener('input', () => {
    canvas.style.setProperty('--split', `${slider.value}%`);
  });
  control.append(controlText, slider);

  wrapper.append(canvas, control);

  void Promise.all([
    loadImage(before, historicalUrl),
    loadImage(after, currentUrl),
  ]).then(
    ([loadedBefore, loadedCurrent]) => {
      const result = createImageDiff(
        historical.content,
        current.content,
        {
          width: loadedBefore.naturalWidth,
          height: loadedBefore.naturalHeight,
        },
        {
          width: loadedCurrent.naturalWidth,
          height: loadedCurrent.naturalHeight,
        }
      );
      status.textContent = result.summary;
    },
    () => {
      wrapper.replaceChildren(
        notice(
          'One of these image versions could not be decoded by the browser.'
        )
      );
    }
  );

  return wrapper;
}

interface ComparisonScaffold {
  readonly main: HTMLElement;
  readonly result: HTMLElement;
  readonly headline: HTMLElement;
  readonly historyNote: HTMLElement;
}

/**
 * The comparison shell, and it carries no version picker of its own.
 *
 * The taskbar spans both views and now holds the version, so a second
 * selector down here would be the same choice offered twice. What is left is
 * the heading, which names both version numbers, and the result area.
 */
function buildComparisonScaffold(): ComparisonScaffold {
  const main = document.createElement('main');
  main.className = 'stage stage-diff';

  const shell = document.createElement('div');
  shell.className = 'diff-shell';

  const toolbar = document.createElement('header');
  toolbar.className = 'diff-toolbar';

  const copy = document.createElement('div');
  copy.className = 'diff-heading';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'diff-eyebrow';
  eyebrow.textContent = 'Version history';
  const headline = document.createElement('h1');
  headline.tabIndex = -1;
  const historyNote = document.createElement('p');
  historyNote.className = 'diff-history-note';
  copy.append(eyebrow, headline, historyNote);
  toolbar.appendChild(copy);

  const result = document.createElement('div');
  result.className = 'diff-result';
  result.setAttribute('aria-live', 'polite');
  shell.append(toolbar, result);
  main.appendChild(shell);
  return { main, result, headline, historyNote };
}

function renderComparison(
  current: ReadyView,
  relicId: string,
  usercontentOrigin: string,
  deps: ViewerDeps,
  onClose: () => void,
  initialVersion?: number
): void {
  const scaffold = buildComparisonScaffold();
  let request = 0;

  const loadSelected = async (selectedVersion: number): Promise<void> => {
    const thisRequest = ++request;
    const copy = versionHistoryCopy(current.version, selectedVersion);
    scaffold.headline.textContent = copy.headline;
    scaffold.historyNote.textContent = copy.detail;
    scaffold.result.setAttribute('aria-busy', 'true');
    const loading = document.createElement('p');
    loading.className = 'diff-loading';
    loading.setAttribute('role', 'status');
    loading.textContent = `Loading version ${selectedVersion} for comparison.`;
    scaffold.result.replaceChildren(loading);

    const historical = await loadHistoricalVersion(
      relicId,
      selectedVersion,
      current,
      deps
    );
    if (thisRequest !== request) return;
    scaffold.result.setAttribute('aria-busy', 'false');

    if (historical.kind === 'unavailable') {
      scaffold.result.replaceChildren(notice(historical.detail));
      return;
    }

    const historicalView = historical.view;
    const mode = diffModeForRoutes(current.route, historicalView.route);
    if (mode === undefined) {
      scaffold.result.replaceChildren(
        notice(
          `Version ${selectedVersion} and version ${current.version} use ` +
            'different display modes, so Relik cannot compare them here.'
        )
      );
      return;
    }

    if (mode === 'image') {
      scaffold.result.replaceChildren(
        renderImageComparison(current, historicalView)
      );
    } else if (mode === 'code') {
      scaffold.result.replaceChildren(
        renderCodeComparison(current, historicalView)
      );
    } else {
      scaffold.result.replaceChildren(
        renderRenderedComparison(
          current,
          historicalView,
          mode,
          usercontentOrigin
        )
      );
    }
  };

  const show = (selectedVersion: number): void => {
    document.body.replaceChildren(
      buildBar(current, relicId, {
        onCompare: onClose,
        comparisonOpen: true,
        selectedVersion,
        onSelectVersion: show,
      }),
      scaffold.main
    );
    scaffold.headline.focus();
    void loadSelected(selectedVersion);
  };

  show(initialVersion ?? current.currentVersion - 1);
}

/* ---------- the comment thread ---------- */

/**
 * A paragraph, because the thread builds a dozen of them and they have to
 * agree on getting their text through `textContent`.
 */
function line(className: string, text: string): HTMLElement {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = text;
  return element;
}

/** A labelled control, since the composer builds three. */
function field(
  labelText: string,
  control: HTMLInputElement | HTMLTextAreaElement
): HTMLElement {
  const label = document.createElement('label');
  label.className = 'compose-field';
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

/**
 * One comment.
 *
 * The address is the identity, so it is always present and never replaced. A
 * display name sits in front of it as an alias, which is what `frame.md`
 * settled when it reversed the no-accounts non-goal: names are decoration and
 * the address is the record.
 *
 * Both are untrusted display text on the origin that holds the fragment. The
 * name is chosen by any link holder, and the address only proves a mailbox
 * answered, so both go in through `textContent` with the bidirectional
 * controls stripped.
 */
export function commentRow(
  entry: CommentEntry,
  /**
   * Whether this comment's mark exists and could not be placed on the page.
   *
   * Read as a parameter rather than derived here, because whether a mark
   * lands depends on what is currently rendered and only the paint pass
   * knows that.
   */
  unplaceable = false
): HTMLElement {
  const row = document.createElement('li');
  row.className =
    entry.kind === 'open' ? 'comment' : 'comment comment-undecryptable';
  if (entry.id !== null) row.dataset.commentId = entry.id;

  const head = document.createElement('div');
  head.className = 'comment-head';

  if (entry.kind === 'open' && entry.displayName !== null) {
    const name = document.createElement('span');
    name.className = 'comment-name';
    name.textContent = plainLabel(entry.displayName);
    head.appendChild(name);
  }

  // A row this page could not read at all may carry no author, so the slot is
  // left empty rather than filled with a stand in. Inventing a sender for a
  // row that named none would be the only fabrication on the page.
  if (entry.author !== null) {
    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = plainLabel(entry.author);
    head.appendChild(author);
  }

  if (entry.author === PUBLISHER_AUTHOR) {
    // True by construction rather than by claim: this comment was authorized
    // by the publish token, and only the machine that published the relic
    // holds one.
    const badge = document.createElement('span');
    badge.className = 'comment-badge';
    badge.textContent = 'Published this relic';
    head.appendChild(badge);
  }

  if (entry.createdAt !== null) {
    const time = document.createElement('time');
    time.className = 'comment-time';
    time.setAttribute('datetime', entry.createdAt);
    time.textContent = commentTime(entry.createdAt);
    head.appendChild(time);
  }

  row.appendChild(head);

  if (entry.kind === 'open') {
    row.appendChild(line('comment-body', entry.body));
  } else if (entry.kind === 'sealed') {
    row.appendChild(
      line(
        'comment-body comment-sealed',
        'This comment did not decrypt. It was either written under a ' +
          'different key for this relic or altered in storage, and there is ' +
          'no way to tell which from here. It is shown rather than dropped, ' +
          'because a thread that quietly hides what it cannot read is one ' +
          'you cannot trust the length of.'
      )
    );
  } else {
    row.appendChild(
      line(
        'comment-body comment-sealed',
        'This comment did not arrive in a form this page can read, so there ' +
          'may never have been a body to open. It is counted here rather ' +
          'than hidden, because a thread that is shorter than it looks is ' +
          'one you cannot trust the length of.'
      )
    );
  }
  // Said on the row rather than left to be inferred from a missing mark. A
  // comment that points at something and shows nothing reads as a comment
  // about the whole relic, which is the wrong thing to conclude from it.
  if (unplaceable) {
    row.appendChild(line('comment-unplaceable', MARK_UNPLACEABLE_NOTE));
  }
  return row;
}

/** A refusal, with its cause named and a retry only where one could work. */
export function threadRefusal(
  refusal: Refusal,
  onRetry: () => void
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'thread-refusal';
  const headline = document.createElement('p');
  headline.className = 'thread-refusal-title';
  headline.textContent = refusal.headline;
  card.append(headline, line('thread-note', refusal.detail));
  if (refusal.retryable) {
    const again = button('Try again', ICONS.rendered, onRetry);
    again.classList.add('primary');
    card.appendChild(again);
  }
  const code = document.createElement('div');
  code.className = 'accession';
  code.textContent = refusal.code;
  card.appendChild(code);
  return card;
}

/** Copy for a thread with nothing in it yet, which is not an error. */
export const THREAD_EMPTY_NOTE =
  'No comments yet. Anyone holding this link can leave one, and the text is ' +
  'encrypted the same way the file is, so Relic stores it without being ' +
  'able to read it.';

/**
 * Copy for the wait, with its reason attached.
 *
 * A bare spinner here would be hiding the interesting part: the bodies arrive
 * as ciphertext and are opened in this browser, so the list can exist before
 * the words in it do.
 */
export const THREAD_LOADING_NOTE =
  'Reading the thread. Comment text arrives encrypted and is decrypted here ' +
  'with the key from your link.';

interface ThreadHandle {
  readonly element: HTMLElement;
  /** The edge tab that opens the sidebar, for a row that has room for it. */
  readonly tab: HTMLElement;
  /** The divider between the relic and the sidebar. */
  readonly resizer: HTMLElement;
  /** Opens or closes the sidebar beside the relic. */
  readonly toggle: () => void;
  /** The stage the marks are painted on. */
  readonly attach: (host: HTMLElement) => void;
}

/** Compares two session states without comparing objects. */
function sessionSignature(state: SessionState): string {
  return state.kind === 'verified' ? `verified:${state.email}` : state.kind;
}
/** Updates the sidebar header without replacing the interactive control. */
export function updateThreadToggle(toggle: HTMLElement, count: number): void {
  toggle.textContent = threadCountLabel(count);
}

/** The narrowest sidebar a comment is worth reading in, in CSS pixels. */
const THREAD_MIN_WIDTH = 272;

/** What a reader gets before they have ever dragged the divider. */
const THREAD_DEFAULT_WIDTH = 352;

/** The widest sidebar, so a wide window still spends most of itself on the relic. */
const THREAD_MAX_WIDTH = 640;

const THREAD_WIDTH_KEY = 'relic:comment-width';

/**
 * Deliberately not keyed by relic.
 *
 * A display name belongs to the reader, not to the file they are looking at,
 * and retyping it per relic is the same annoyance as signing in per relic. It
 * is untrusted text the reader chose and it is not a credential, which is why
 * it can live here at all: the session proving who they are stays in an
 * HttpOnly cookie that no script on this origin can read.
 */
const DISPLAY_NAME_KEY = 'relic:display-name';

/**
 * Clamps a dragged width to what the viewport can actually spare.
 *
 * The ceiling is a share of the viewport rather than a constant, so dragging
 * the divider in a narrow window cannot push the relic out of the row.
 */
export function clampThreadWidth(width: number, viewport: number): number {
  const max = Math.max(
    THREAD_MIN_WIDTH,
    Math.min(THREAD_MAX_WIDTH, viewport * 0.6)
  );
  return Math.min(Math.max(width, THREAD_MIN_WIDTH), max);
}

/**
 * Storage for reader preferences, or nothing.
 *
 * Touching `localStorage` throws outright in some embedded contexts rather
 * than being absent, so the guard has to be a try and not a null check.
 * Preferences only: relic keys go through the vault and the session is a
 * cookie, neither of which belongs here.
 */
function preferenceStore(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** The display name this reader last posted under, on any relic. */
export function readDisplayName(): string {
  try {
    return preferenceStore()?.getItem(DISPLAY_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Remembers it, so the next comment and the next relic start filled in. */
export function writeDisplayName(name: string): void {
  try {
    const store = preferenceStore();
    if (store === undefined) return;
    const trimmed = name.trim();
    // Clearing it is a choice worth keeping, so an empty name removes the
    // entry rather than leaving the previous one to reappear.
    if (trimmed.length === 0) store.removeItem(DISPLAY_NAME_KEY);
    else store.setItem(DISPLAY_NAME_KEY, trimmed);
  } catch {
    // Quota, or storage disabled mid-session. A remembered name is a
    // convenience, and failing to keep one is not worth an error page.
  }
}

/**
 * The display name field, already filled in.
 *
 * A function rather than four lines inline so the prefill is assertable: the
 * whole point of the change is that this field arrives carrying the name the
 * reader typed on some other relic, and an untested assignment is exactly the
 * kind of one-liner that silently stops happening.
 */
export function displayNameInput(): HTMLInputElement {
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'compose-input';
  // A coarse guard only: `maxLength` counts UTF-16 units and the cap is on
  // UTF-8 bytes, so the byte check before encryption is the authority.
  name.maxLength = MAX_DISPLAY_NAME_BYTES;
  name.placeholder = 'Optional, shown beside your address';
  name.value = readDisplayName();
  return name;
}

/** The width this reader last dragged the divider to, if it was kept. */
function readThreadWidth(): number | undefined {
  try {
    const raw = preferenceStore()?.getItem(THREAD_WIDTH_KEY);
    if (raw === null || raw === undefined) return undefined;
    const width = Number.parseInt(raw, 10);
    return Number.isFinite(width) ? width : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a dragged width, so the next relic opens the way this one was left. */
function writeThreadWidth(width: number): void {
  try {
    preferenceStore()?.setItem(THREAD_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Quota, or storage disabled mid-session. A remembered width is a
    // convenience, and failing to keep one is not worth an error page.
  }
}

/** The scrolled stage, as the numbers a mark needs from it. */
export interface StageBox {
  readonly left: number;
  readonly top: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
}

/**
 * Where a click landed, as a fraction of the whole rendered relic.
 *
 * Of the whole relic, not of the visible box. A mark belongs to the line it
 * was put on, and the reader scrolls. Measuring against the visible box pins a
 * comment to a screen position instead, which is how a mark ends up beside
 * unrelated text one scroll later, and how a mark placed halfway down a long
 * relic lands near the top of it.
 */
export function pinFraction(
  box: StageBox,
  clientX: number,
  clientY: number
): { readonly x: number; readonly y: number } | undefined {
  if (box.scrollWidth <= 0 || box.scrollHeight <= 0) return undefined;
  const x = (clientX - box.left + box.scrollLeft) / box.scrollWidth;
  const y = (clientY - box.top + box.scrollTop) / box.scrollHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
  return { x, y };
}

/**
 * Where a stored fraction sits, in the scrolled content's own pixels.
 *
 * Pixels rather than percentages: a percentage inside a scroll container
 * resolves against the visible box, so a pin two screens down would paint
 * itself onto the first screen.
 */
export function pinOffsets(
  anchor: { readonly x: number; readonly y: number },
  content: { readonly scrollWidth: number; readonly scrollHeight: number }
): { readonly left: number; readonly top: number } {
  return {
    left: anchor.x * content.scrollWidth,
    top: anchor.y * content.scrollHeight,
  };
}

/** How much of a quote the chip shows before it abbreviates. */
const MARK_QUOTE_DISPLAY_LIMIT = 60;

/** What an armed pin tool tells the reader to do next. */
export const MARK_PIN_HINT = 'Click the document to place a point';

/**
 * The clearance between a selection and the button offered above it, in CSS
 * pixels. Small enough to read as attached to the selection, wide enough that
 * it does not sit on the words it is about.
 */
const MARK_BUBBLE_GAP = 6;

/**
 * The key a provisional mark is painted under.
 *
 * A colon cannot occur in a server-minted comment id, which is base64url, so
 * this can never collide with a real one. That matters because the pairing
 * handler and the unwrap pass both address marks by this key, and a collision
 * would light the wrong comment or strand a mark on the page.
 */
export const PENDING_MARK_ID = 'pending:target';

/**
 * Paints the target the reader has aimed but not yet posted.
 *
 * Runs inside the same pass as the posted marks rather than beside it. Two
 * passes would mean two places that decide what the document shows, and the
 * provisional mark would survive a refresh that removed everything else.
 */
export function paintPendingMark(
  host: HTMLElement,
  pins: HTMLElement,
  anchor: CommentAnchor | null
): void {
  if (anchor === null) {
    host
      .querySelector<HTMLIFrameElement>('iframe.usercontent-frame')
      ?.contentWindow?.postMessage(
        { type: 'relic:clear-mark', id: PENDING_MARK_ID },
        '*'
      );
    return;
  }
  if (anchor.kind === 'text') {
    wrapTextQuote(host, anchor.quote, PENDING_MARK_ID);
    const painted = host.querySelector(
      `mark[data-comment-id="${PENDING_MARK_ID}"]`
    );
    painted?.classList.add('is-pending');
    return;
  }
  if (anchor.kind === 'pin') {
    const pin = document.createElement('div');
    // Not a button: there is no comment to scroll to yet, and a control that
    // answers a press by doing nothing is the defect this whole change removed.
    pin.className = 'comment-pin is-pending';
    pin.dataset.commentId = PENDING_MARK_ID;
    const offsets = pinOffsets(anchor, host);
    pin.style.left = `${offsets.left}px`;
    pin.style.top = `${offsets.top}px`;
    pins.appendChild(pin);
    return;
  }
  // A precise kind paints its provisional mark through the same adapter that
  // paints the posted one, so the reader sees the thing they aimed at rather
  // than a preview that differs from the result.
  const surface = anchorSurfaceFor(host);
  if (surface === undefined) return;
  const adapter = adapterFor(anchor, surface);
  if (adapter === undefined) return;
  adapter.paint(surface, pins, anchor, PENDING_MARK_ID);
  for (const painted of pins.querySelectorAll(
    `[data-comment-id="${PENDING_MARK_ID}"]`
  )) {
    painted.classList.add('is-pending');
  }
}

/**
 * The element geometry is measured against, given the stage marks live on.
 *
 * The artifact, when there is exactly one: the `img`, the `video`, the frame,
 * the page canvas. Otherwise the stage stands in as its own content box,
 * which is right for flowing text where there is no single framed object and
 * the host *is* the content.
 *
 * `undefined` never happens today and is kept in the signature because a
 * future class could render more than one candidate, and silently picking
 * the first would put marks on whichever one happened to be first in the DOM.
 */
export function anchorSurfaceFor(host: HTMLElement): AnchorSurface | undefined {
  const candidates = host.querySelectorAll(
    'img.relic-image, video.relic-media, audio.relic-media, iframe.usercontent-frame, canvas.relic-page'
  );
  if (candidates.length > 1) return undefined;
  const only =
    typeof candidates.item === 'function'
      ? candidates.item(0)
      : (candidates as unknown as Element[])[0];
  return {
    host,
    content:
      only instanceof HTMLElement || (only && typeof only === 'object')
        ? (only as HTMLElement)
        : host,
  };
}

/**
 * What the composer says the next comment is about.
 *
 * Having no target is a state with wording rather than a blank, because the
 * blank is what shipped: nothing on the page said marks existed, and a reader
 * who had selected something by accident had no way to find out that the next
 * comment they wrote was about to land on it.
 */
export function markTargetLabel(anchor: CommentAnchor | null): string {
  if (anchor === null) return 'Commenting on the whole document';
  if (anchor.kind === 'pin') return 'Commenting on a point';
  if (anchor.kind === 'text') return quotedTargetLabel(anchor.quote);
  return anchorLabel(anchor) ?? UNSUPPORTED_ANCHOR_LABEL;
}

/**
 * A quote as the chip shows it.
 *
 * Display only, and shared by every kind that carries a quote. The stored
 * value stays exact, because it is what a later paint is matched against.
 */
export function quotedTargetLabel(quote: string): string {
  const plain = plainLabel(quote);
  const shown =
    plain.length > MARK_QUOTE_DISPLAY_LIMIT
      ? `${plain.slice(0, MARK_QUOTE_DISPLAY_LIMIT).trimEnd()}…`
      : plain;
  return `Commenting on "${shown}"`;
}

/** The aiming controls, and the one target they hold between them. */
export interface MarkControls {
  /**
   * The chip the composer carries in every state, including holding no target
   * at all. That state is the one worth announcing: it answers "can I comment
   * on a line", and before this there was nothing on the page that did.
   */
  readonly chip: HTMLElement;
  /** The row offering the pin tool, or saying why this relic cannot have one. */
  readonly tools: HTMLElement;
  /** Binds a rendered stage, and decides there whether marks can work at all. */
  attach(host: HTMLElement): void;
  /** Read once, when a comment is posted. */
  target(): CommentAnchor | null;
  /** Back to the whole document, with the pin tool disarmed. */
  clear(): void;
}

export interface MarkDeps {
  /** Aiming a mark is the start of writing one, so the thread comes open. */
  readonly open: () => void;
  /** Where the reader types, once a target is locked. */
  readonly focusBody: () => void;
  /**
   * Repaints the document's marks, because the target changed.
   *
   * A chip that names a quote while the page shows nothing tells the reader
   * where their comment is going and gives them no way to check it. The
   * target is painted on the document from the same pass that paints posted
   * comments, so a provisional mark and a real one cannot drift apart.
   */
  readonly repaint: () => void;
}

/**
 * Reads the selection the browser has finished settling.
 *
 * `mouseup` fires before the selection it produced is readable, so a handler
 * that reads immediately reads the previous one. Ten milliseconds is what
 * haiku's review app settled on for the same reason.
 */
function afterSelection(run: () => void): void {
  window.setTimeout(run, 10);
}

/**
 * The controls that let a reader aim a comment, and see what it is aimed at.
 *
 * Before this the target was set by any selection and rendered nowhere, so a
 * stray selection silently anchored the next comment to an unrelated line and
 * nothing on the page said so. Three changes fix that and they are one unit: a
 * selection now only offers a target, the composer always names the target it
 * holds, and a point is placed by an armed tool rather than by whichever click
 * happened to miss the text.
 */
export function buildMarkControls(deps: MarkDeps): MarkControls {
  let anchor: CommentAnchor | null = null;
  let host: HTMLElement | undefined;
  let bubble: HTMLElement | undefined;
  let mode: HTMLElement | undefined;
  let hint: HTMLElement | undefined;

  const chip = document.createElement('div');
  chip.className = 'compose-target';
  // Polite: a target arriving is worth announcing to a reader who cannot see
  // the chip change, and never worth interrupting one mid sentence.
  chip.setAttribute('aria-live', 'polite');

  const tools = document.createElement('div');
  tools.className = 'thread-tools';

  // One element rather than one per repaint, because there is one clear
  // control and its listener is attached once.
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'compose-target-clear';
  reset.textContent = 'Clear';
  reset.setAttribute('aria-label', 'Comment on the whole document instead');

  const dismiss = (): void => {
    bubble?.remove();
    bubble = undefined;
  };

  /** The button's own pressed state is the armed state, so there is one. */
  const armed = (): boolean => mode?.getAttribute('aria-pressed') === 'true';

  const disarm = (): void => {
    mode?.setAttribute('aria-pressed', 'false');
    host?.classList.remove('is-pinning');
    hint?.remove();
    hint = undefined;
    host
      ?.querySelector<HTMLIFrameElement>('iframe.usercontent-frame')
      ?.contentWindow?.postMessage(
        { type: 'relic:arm-pointing', armed: false },
        '*'
      );
  };

  const paintChip = (): void => {
    const label = document.createElement('span');
    label.className = 'compose-target-label';
    label.textContent = markTargetLabel(anchor);
    if (anchor === null) {
      chip.replaceChildren(label);
      return;
    }
    chip.replaceChildren(label, reset);
  };

  const clear = (): void => {
    anchor = null;
    dismiss();
    disarm();
    paintChip();
    deps.repaint();
  };

  reset.addEventListener('click', clear);

  const aim = (next: CommentAnchor): void => {
    anchor = next;
    dismiss();
    disarm();
    paintChip();
    deps.repaint();
    deps.open();
    deps.focusBody();
  };

  const arm = (): void => {
    const surface = host;
    if (mode === undefined || surface === undefined) return;
    mode.setAttribute('aria-pressed', 'true');
    surface.classList.add('is-pinning');
    const said = document.createElement('p');
    said.className = 'mark-hint';
    said.setAttribute('aria-live', 'polite');
    said.textContent = MARK_PIN_HINT;
    // On the stage rather than in the sidebar, and out of flow. The reader is
    // looking at the document, the sidebar is not on the row at all at narrow
    // width, and a hint that took layout space would shift the line under the
    // cursor between arming and the click that places the point.
    surface.appendChild(said);
    hint = said;
    surface
      .querySelector<HTMLIFrameElement>('iframe.usercontent-frame')
      ?.contentWindow?.postMessage(
        { type: 'relic:arm-pointing', armed: true },
        '*'
      );
  };

  /** Offers a target for a settled selection, and offers nothing otherwise. */
  const offer = (): void => {
    const surface = host;
    if (surface === undefined) return;
    const selection = window.getSelection();
    if (
      selection === null ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      dismiss();
      return;
    }
    const range = selection.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) {
      dismiss();
      return;
    }
    const quote = selection.toString().trim();
    if (quote.length === 0) {
      dismiss();
      return;
    }

    dismiss();
    const rect = range.getBoundingClientRect();
    const box = surface.getBoundingClientRect();
    const offered = document.createElement('button');
    offered.type = 'button';
    offered.className = 'mark-bubble';
    offered.textContent = 'Comment';
    // Content coordinates, not viewport ones: the stage scrolls its own
    // children, so an offset measured against the visible box would leave the
    // bubble behind the moment the reader scrolls.
    offered.style.left = `${rect.left - box.left + surface.scrollLeft + rect.width / 2}px`;
    // A press that moved focus would collapse the selection before the click
    // arrived, which is how a selection toolbar loses the thing it points at.
    offered.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    // The quote is captured here rather than re-read on click, so what gets
    // anchored is what the bubble appeared for.
    offered.addEventListener('click', () => {
      aim({ kind: 'text', quote });
    });
    surface.appendChild(offered);
    // Above the selection, and never above the content box. The stage clips
    // its overflow, so the first line of every relic would otherwise be
    // offered a button sitting outside the box it is clipped to. The height is
    // read after insertion because it is the button's own and not a guess.
    const above = rect.top - box.top + surface.scrollTop;
    offered.style.top = `${Math.max(above - offered.offsetHeight - MARK_BUBBLE_GAP, 0)}px`;
    bubble = offered;
  };

  /** Places a point, but only for a click the reader armed the tool for. */
  const place = (event: MouseEvent): void => {
    const surface = host;
    if (surface === undefined || !armed()) return;
    if (!(event.target instanceof Element)) return;
    // An existing mark, the bubble and the conversation are controls. Only the
    // document itself takes a point.
    if (event.target.closest('.comment-pin, .mark-bubble, .thread')) return;
    const rect = surface.getBoundingClientRect();
    const fraction = pinFraction(
      {
        left: rect.left,
        top: rect.top,
        scrollLeft: surface.scrollLeft,
        scrollTop: surface.scrollTop,
        scrollWidth: surface.scrollWidth,
        scrollHeight: surface.scrollHeight,
      },
      event.clientX,
      event.clientY
    );
    // A click the stage cannot place leaves the tool armed, because nothing
    // was placed and disarming would read as though something had been.
    if (fraction === undefined) return;
    aim({ kind: 'pin', ...fraction });
  };

  // Bound to the document once, here rather than in `attach`, because a
  // comparison closing rebuilds the stage and attaches again: listeners added
  // there would accumulate one copy per visit.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    clear();
  });
  document.addEventListener('selectionchange', () => {
    const live = window.getSelection();
    if (live === null || live.isCollapsed) dismiss();
  });

  paintChip();

  return {
    chip,
    tools,
    target: () => anchor,
    clear,
    attach: (next) => {
      // Both belonged to the stage that is being replaced.
      dismiss();
      disarm();
      host = next;

      // The boundary, read from the DOM rather than from the route, because a
      // component that will not compile falls back to its own source and that
      // source renders right here in the page where a mark can reach it.

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mark-mode';
      toggle.textContent = 'Point at something';
      toggle.setAttribute('aria-pressed', 'false');
      toggle.addEventListener('click', () => {
        if (armed()) disarm();
        else arm();
      });
      mode = toggle;
      tools.replaceChildren(toggle);

      if (next.dataset.markBind === '1') return;
      next.dataset.markBind = '1';
      const isFramed = next.querySelector('iframe.usercontent-frame') !== null;
      if (!isFramed) {
        next.addEventListener('mouseup', () => {
          afterSelection(offer);
        });
        next.addEventListener('click', place);
      }
      next.addEventListener('relic:frame-selection', ((
        event: CustomEvent<FrameSelectionMessage>
      ) => {
        const msg = event.detail;
        if (msg?.exact && msg.exact.trim().length > 0) {
          aim({
            kind: 'quote',
            exact: msg.exact.trim(),
            ...(msg.prefix ? { prefix: msg.prefix } : {}),
            ...(msg.suffix ? { suffix: msg.suffix } : {}),
          });
        }
      }) as EventListener);
      next.addEventListener('relic:frame-point', ((
        event: CustomEvent<FramePointMessage>
      ) => {
        if (!armed()) return;
        const msg = event.detail;
        if (!msg) return;
        const w = 0.03;
        const h = 0.03;
        const rect = {
          x: Math.max(0, Math.min(1 - w, msg.x - w / 2)),
          y: Math.max(0, Math.min(1 - h, msg.y - h / 2)),
          w,
          h,
        };
        aim({ kind: 'region', rect });
      }) as EventListener);
      next.addEventListener('relic:frame-region', ((
        event: CustomEvent<FrameRegionMessage>
      ) => {
        if (!armed()) return;
        if (event.detail?.rect) {
          aim({ kind: 'region', rect: event.detail.rect });
        }
      }) as EventListener);
      next.addEventListener('relic:frame-mark-click', ((
        event: CustomEvent<FrameMarkClickMessage>
      ) => {
        if (!event.detail?.id) return;
        const row = document.querySelector(
          `[data-comment-id="${event.detail.id}"]`
        );
        if (row instanceof HTMLElement) {
          deps.open();
          row.scrollIntoView({ block: 'nearest' });
        }
      }) as EventListener);
    },
  };
}

/**
 * The thread, in the service-origin chrome.
 *
 * It cannot live in the render frame and this is not a preference: the frame
 * is network denied, `default-src 'none'` with sandbox exactly
 * `allow-scripts`, so it could not fetch a comment if it tried. The chrome
 * around it can, and it is also the only side of the boundary that holds the
 * key the bodies are sealed under.
 */
export function buildThread(
  view: ReadyView,
  relicId: string,
  deps: ViewerDeps,
  onCount: (count: number) => void
): ThreadHandle {
  const section = document.createElement('aside');
  section.className = 'thread';
  section.id = 'comment-thread';
  section.setAttribute('aria-labelledby', 'thread-title');

  const title = document.createElement('h2');
  title.className = 'thread-title';
  title.id = 'thread-title';
  const toggle = document.createElement('button');
  toggle.className = 'thread-toggle';
  toggle.type = 'button';
  toggle.textContent = 'Comments';
  toggle.setAttribute('aria-controls', section.id);
  toggle.setAttribute('aria-expanded', 'false');
  title.appendChild(toggle);

  // The divider lives in the row rather than in the sidebar, because the
  // sidebar scrolls and a divider that scrolled away with the conversation
  // would be a control that disappears while it is being used.
  const resizer = document.createElement('div');
  resizer.className = 'thread-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', 'Resize the comments');
  resizer.tabIndex = 0;

  // The one entry that survives every width. The taskbar control leaves the
  // row at the 320px floor, and a reader on a phone still has to get in.
  const tab = document.createElement('button');
  tab.className = 'thread-tab';
  tab.type = 'button';
  tab.textContent = 'Comments';
  tab.setAttribute('aria-controls', section.id);
  tab.setAttribute('aria-expanded', 'false');

  const status = document.createElement('div');
  status.className = 'thread-status';
  // Polite: a comment arriving is worth announcing and never worth
  // interrupting what is being read.
  status.setAttribute('aria-live', 'polite');

  const list = document.createElement('ol');
  list.className = 'thread-list';

  const composer = document.createElement('div');
  composer.className = 'compose-slot';

  // Outcomes live outside the composer, so repainting the composer after a
  // lapsed session does not throw away the sentence explaining why.
  const outcome = document.createElement('div');
  outcome.className = 'thread-outcome';
  outcome.setAttribute('aria-live', 'polite');

  // The aiming controls, built here because two places carry a piece of them:
  // what a comment is about belongs in the composer, and arming the pin tool
  // belongs in the sidebar beside the conversation it will join.
  const marks = buildMarkControls({
    open: () => {
      setOpen(true);
    },
    focusBody: () => {
      // Absent for a reader who has not verified an address yet, and that is
      // the state the chip exists for: the target is announced even when
      // there is nothing yet to type it into.
      const box = composer.querySelector('.compose-textarea');
      if (box instanceof HTMLElement) box.focus();
    },
    repaint: () => {
      // The entries it already has, because the target changed and the
      // conversation did not. Refetching the thread to redraw one provisional
      // mark would put a network round trip behind a text selection.
      paintMarks(lastEntries);
    },
  });

  section.append(title, marks.tools, status, list, composer, outcome);

  // The one place the in-memory fragment is already carried on a ready view.
  // Reading it back from here rather than adding a second copy to `ReadyView`
  // keeps the number of places holding key material at one.
  const fragment = new URL(view.shareUrl).hash;

  let cipher: CommentCipher | undefined;
  let session: SessionState = { kind: 'unknown' };
  let host: HTMLElement | undefined;
  let lastEntries: readonly CommentEntry[] = [];
  /**
   * Comment ids whose mark is real but has nowhere to land on this page.
   *
   * Two causes, one reader-visible consequence: a kind this build has no
   * adapter for, and a quote the current version of the relic no longer
   * contains. The thread says so on the row, because a comment that appears
   * to point at nothing is worse than one that says where it pointed.
   */
  const unplaceable = new Set<string>();
  /** Puts the width where the sidebar and the divider both read it. */
  const applyWidth = (width: number): number => {
    const clamped = Math.round(clampThreadWidth(width, window.innerWidth));
    document.documentElement.style.setProperty(
      '--thread-width',
      `${clamped}px`
    );
    return clamped;
  };
  applyWidth(readThreadWidth() ?? THREAD_DEFAULT_WIDTH);

  const setOpen = (open: boolean): void => {
    section.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    tab.setAttribute('aria-expanded', String(open));
    if (open) toggle.focus({ preventScroll: true });
  };
  const toggleOpen = (): void => {
    setOpen(!section.classList.contains('is-open'));
  };
  toggle.addEventListener('click', toggleOpen);
  tab.addEventListener('click', toggleOpen);

  // Pointer capture, so a drag that outruns the divider keeps arriving here
  // instead of being swallowed by whatever it crossed.
  resizer.addEventListener('pointerdown', (event) => {
    const row = resizer.parentElement;
    if (row === null) return;
    event.preventDefault();
    const right = row.getBoundingClientRect().right;
    resizer.setPointerCapture(event.pointerId);
    let width = section.getBoundingClientRect().width;
    const move = (moved: PointerEvent): void => {
      width = applyWidth(right - moved.clientX);
    };
    const done = (): void => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', done);
      resizer.removeEventListener('pointercancel', done);
      writeThreadWidth(width);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', done);
    resizer.addEventListener('pointercancel', done);
  });

  // A divider that only answers a pointer is a divider a keyboard cannot
  // reach, and this one is in the tab order.
  resizer.addEventListener('keydown', (event) => {
    const step =
      event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
    if (step === 0) return;
    event.preventDefault();
    writeThreadWidth(applyWidth(section.getBoundingClientRect().width + step));
  });

  const paintMarks = (entries: readonly CommentEntry[]): void => {
    lastEntries = entries;
    if (host === undefined) return;
    unwrapTextQuotes(host);
    host.querySelector('.comment-pins')?.remove();
    host
      .querySelector<HTMLIFrameElement>('iframe.usercontent-frame')
      ?.contentWindow?.postMessage({ type: 'relic:clear-marks' }, '*');
    const pins = document.createElement('div');
    pins.className = 'comment-pins';
    let number = 0;
    // Ids whose mark could not be placed on this page, so the thread can say
    // so on the row instead of showing a comment that appears to point at
    // nothing. Rebuilt every pass, because whether a mark lands depends on
    // the content currently rendered.
    unplaceable.clear();
    for (const entry of entries) {
      if (entry.kind !== 'open' || entry.anchor === null) continue;
      number += 1;
      if (entry.anchor.kind === 'text') {
        wrapTextQuote(host, entry.anchor.quote, entry.id);
        continue;
      }
      if (entry.anchor.kind === 'pin') {
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'comment-pin';
        pin.textContent = String(number);
        // Addressable, so hovering the pin can light its comment. Posted pins
        // and marks now carry the same key, which is what lets one pairing
        // handler serve both shapes.
        pin.dataset.commentId = entry.id;
        const offsets = pinOffsets(entry.anchor, host);
        pin.style.left = `${offsets.left}px`;
        pin.style.top = `${offsets.top}px`;
        pin.title = entry.body;
        pin.addEventListener('click', (event) => {
          event.preventDefault();
          setOpen(true);
          const row = list.querySelector(`[data-comment-id="${entry.id}"]`);
          if (row instanceof HTMLElement) {
            row.scrollIntoView({ block: 'nearest' });
          }
        });
        pins.appendChild(pin);
        continue;
      }
      // Every precise kind, through its adapter. A kind with no adapter
      // registered, or one whose mark has nowhere to land because the relic
      // was republished, leaves the comment in the thread and marks the row
      // as unplaceable rather than dropping either.
      const surface = anchorSurfaceFor(host);
      const adapter =
        surface === undefined ? undefined : adapterFor(entry.anchor, surface);
      const placed =
        adapter !== undefined &&
        surface !== undefined &&
        adapter.paint(surface, pins, entry.anchor, entry.id);
      if (!placed) unplaceable.add(entry.id);
    }
    paintPendingMark(host, pins, marks.target());
    host.appendChild(pins);
  };

  /**
   * Lights a comment and the thing it points at, together.
   *
   * A thread and a document are two views of one set of remarks, and without
   * this the reader has to hold the pairing in their head: the sidebar says
   * what was said and the page says where, and nothing joins them.
   */
  const pair = (id: string | undefined, on: boolean): void => {
    if (host === undefined) return;
    const selector = id === undefined ? null : `[data-comment-id="${id}"]`;
    if (selector === null) return;
    for (const root of [host, list]) {
      for (const found of root.querySelectorAll(selector)) {
        found.classList.toggle('is-active', on);
      }
    }
  };

  // Delegated rather than bound per row and per mark, because both are
  // replaced wholesale on every repaint and a listener attached to the old
  // element would light nothing at all.
  const bindPairing = (root: HTMLElement): void => {
    const enter = (event: Event): void => {
      if (!(event.target instanceof Element)) return;
      pair(
        event.target.closest<HTMLElement>('[data-comment-id]')?.dataset
          .commentId,
        true
      );
    };
    const leave = (event: Event): void => {
      if (!(event.target instanceof Element)) return;
      pair(
        event.target.closest<HTMLElement>('[data-comment-id]')?.dataset
          .commentId,
        false
      );
    };
    root.addEventListener('mouseover', enter);
    root.addEventListener('mouseout', leave);
    // A pin is a button, so it is in the tab order. Pairing on focus keeps a
    // keyboard reader from being the only one who cannot see the join.
    root.addEventListener('focusin', enter);
    root.addEventListener('focusout', leave);
  };

  bindPairing(list);

  const policyLink = (): HTMLElement => {
    const link = document.createElement('a');
    link.className = 'thread-policy';
    link.href = `${SERVICE_ORIGIN}/policy`;
    link.rel = 'noopener noreferrer';
    link.textContent = 'What Relic knows';
    return link;
  };

  const refresh = async (): Promise<void> => {
    const opener = cipher;
    if (opener === undefined) return;
    status.replaceChildren(line('thread-note', THREAD_LOADING_NOTE));
    const state = await loadThread(relicId, deps, opener);
    if (state.kind === 'refused') {
      list.replaceChildren();
      status.replaceChildren(
        threadRefusal(state.refusal, () => {
          void refresh();
        })
      );
      return;
    }
    // Paint first, then build the rows. Which marks landed is only known
    // after the paint pass, and a row that has to say its mark could not be
    // placed cannot be built before that is decided.
    paintMarks(state.entries);
    list.replaceChildren(
      // Not a bare `map(commentRow)`: `map` passes the index as the second
      // argument, which would make every row after the first claim its mark
      // was unplaceable.
      ...state.entries.map((entry) =>
        commentRow(entry, entry.id !== null && unplaceable.has(entry.id))
      )
    );
    updateThreadToggle(toggle, state.entries.length);
    status.replaceChildren(
      ...(state.entries.length === 0
        ? [line('thread-note', THREAD_EMPTY_NOTE)]
        : [])
    );
    onCount(state.entries.length);
  };

  /** The address form, for a reader this browser has not verified. */
  const composeIdentity = (): HTMLElement => {
    const form = document.createElement('form');
    form.className = 'compose';

    const heading = document.createElement('h3');
    heading.className = 'compose-title';
    heading.textContent = 'Leave a comment';
    form.append(heading, marks.chip);

    if (session.kind === 'unknown') {
      form.appendChild(
        line(
          'thread-note',
          'Relic could not tell whether this browser is already verified, so ' +
            'it is asking. Entering an address you have used before costs ' +
            'nothing but the email.'
        )
      );
    }

    form.append(line('compose-note', IDENTITY_DISCLOSURE), policyLink());

    const email = document.createElement('input');
    email.type = 'email';
    email.required = true;
    email.autocomplete = 'email';
    email.className = 'compose-input';
    email.placeholder = 'you@example.com';
    form.appendChild(field('Email address', email));

    form.appendChild(line('compose-fine', DELIVERY_DISCLOSURE));

    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'action primary';
    send.textContent = 'Send me a link';
    form.appendChild(send);

    form.addEventListener('submit', (event) => {
      // The control. `form-action 'none'` in the shell's CSP is the backstop,
      // and both are wanted: a submission that got past this would put the
      // address in a query string on the one page whose URL must stay clean.
      event.preventDefault();
      const address = email.value.trim();
      if (address.length === 0) return;
      send.disabled = true;
      outcome.replaceChildren(line('thread-note', 'Sending.'));
      void requestMagicLink(relicId, address, deps).then((result) => {
        send.disabled = false;
        if (result.kind === 'refused') {
          outcome.replaceChildren(threadRefusal(result.refusal, () => {}));
          return;
        }
        // Deliberately does not confirm the address exists. The endpoint
        // answers 202 either way so it cannot be used to find out who has
        // commented before, and copy reading "we sent it" would hand back
        // exactly what that 202 withholds.
        const said = [
          line(
            'thread-note',
            `If ${plainLabel(address)} can receive mail, a link is on its ` +
              'way. Following it verifies the address and brings you back ' +
              'here.'
          ),
        ];
        if (!keySurvivesNavigation(relicId, fragment, deps)) {
          said.push(line('compose-warning', KEY_AT_RISK_NOTE));
        }
        outcome.replaceChildren(...said);
      });
    });

    return form;
  };

  /** The comment form, for a verified reader. */
  const composeComment = (email: string): HTMLElement => {
    const form = document.createElement('form');
    form.className = 'compose';

    const heading = document.createElement('h3');
    heading.className = 'compose-title';
    heading.textContent = 'Leave a comment';

    const identity = document.createElement('p');
    identity.className = 'compose-identity';
    const address = document.createElement('strong');
    address.textContent = plainLabel(email);
    identity.append(document.createTextNode('Commenting as '), address);

    form.append(
      heading,
      identity,
      marks.chip,
      line('compose-note', IDENTITY_DISCLOSURE),
      policyLink()
    );

    const name = displayNameInput();
    form.appendChild(field('Display name', name));

    const body = document.createElement('textarea');
    body.className = 'compose-textarea';
    body.rows = 4;
    body.required = true;
    form.appendChild(field('Comment', body));

    const foot = document.createElement('div');
    foot.className = 'compose-foot';

    const count = document.createElement('span');
    count.className = 'compose-count';
    const paintCount = (): void => {
      const used = utf8Bytes(body.value);
      // Bytes rather than characters, because the cap is on bytes and an
      // emoji costing four of them would otherwise be a surprise at submit.
      count.textContent = `${used} of ${MAX_BODY_BYTES} bytes`;
      count.classList.toggle('over', used > MAX_BODY_BYTES);
    };
    paintCount();
    body.addEventListener('input', paintCount);

    const post = document.createElement('button');
    post.type = 'submit';
    post.className = 'action primary';
    post.textContent = 'Post comment';

    foot.append(count, post);
    form.appendChild(foot);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const sealer = cipher;
      if (sealer === undefined) return;
      const draft = {
        body: body.value,
        display_name: name.value.trim().length > 0 ? name.value.trim() : null,
        anchor: marks.target(),
      };
      // The target is spent. Leaving it set would aim the reader's next
      // comment at the last thing they marked, which is the bug this whole
      // change exists to remove, one comment later.
      marks.clear();
      post.disabled = true;
      outcome.replaceChildren(line('thread-note', 'Encrypting and posting.'));
      void postComment(relicId, draft, deps, sealer).then(async (result) => {
        post.disabled = false;
        if (result.kind === 'refused') {
          outcome.replaceChildren(threadRefusal(result.refusal, () => {}));
          if (result.refusal.code === 'invalid_session') {
            session = { kind: 'anonymous' };
            composer.replaceChildren(composeIdentity());
          }
          return;
        }
        body.value = '';
        // The body is this comment's and goes. The name is the reader's and
        // stays, here and on the next relic they open.
        writeDisplayName(name.value);
        paintCount();
        outcome.replaceChildren(
          line(
            'thread-note',
            `Posted as ${plainLabel(result.author)}, which is what everybody ` +
              'holding this link now sees.'
          )
        );
        await refresh();
      });
    });

    return form;
  };

  const paintComposer = (): void => {
    composer.replaceChildren(
      session.kind === 'verified'
        ? composeComment(session.email)
        : composeIdentity()
    );
  };

  /**
   * A magic link opened in another tab verifies this browser, not this tab.
   *
   * That is the common case rather than the edge: a mail client opens links
   * in its own tab, so the relic page that asked for the link is still
   * sitting there with its key in memory and no idea anything happened. Both
   * signals below are cheap and neither carries an address or a key.
   */
  const recheck = async (): Promise<void> => {
    if (cipher === undefined) return;
    const discovered = await readSession(deps);
    if (sessionSignature(discovered) === sessionSignature(session)) return;
    session = discovered;
    paintComposer();
  };

  const initialise = async (): Promise<void> => {
    status.replaceChildren(line('thread-note', THREAD_LOADING_NOTE));
    let key: Uint8Array;
    try {
      key = parseFragment(fragment).key;
    } catch {
      // Unreachable from a ready view, which exists only because the fragment
      // parsed. Caught rather than thrown because an error escaping here
      // would be an error object holding the fragment, and section 1.8 rules
      // that out.
      status.replaceChildren(
        threadRefusal(
          {
            code: 'no_comment_key',
            headline: 'Comments need the key from your link',
            detail:
              'Comment text is sealed under a key derived from the one in ' +
              'this link, and this page does not have it.',
            retryable: false,
          },
          () => {}
        )
      );
      return;
    }
    cipher = commentCipher(await deriveCommentKey(key));
    const [, discovered] = await Promise.all([refresh(), readSession(deps)]);
    session = discovered;
    paintComposer();
    if (
      discovered.kind === 'verified' &&
      typeof BroadcastChannel === 'function'
    ) {
      // Tells whichever tab asked for the link that it can stop waiting. The
      // message is a bare marker: no address, and certainly no key.
      const channel = new BroadcastChannel('relic:auth');
      channel.postMessage('verified');
      channel.close();
    }
  };

  if (typeof BroadcastChannel === 'function') {
    new BroadcastChannel('relic:auth').addEventListener('message', () => {
      void recheck();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void recheck();
  });

  void initialise();

  return {
    element: section,
    tab,
    resizer,
    toggle: toggleOpen,
    attach: (next) => {
      host = next;
      // Once per stage. A second binding would toggle the class twice on one
      // pointer crossing, which reads as the pairing not working at all.
      if (next.dataset.pairBind !== '1') {
        next.dataset.pairBind = '1';
        bindPairing(next);
      }
      paintMarks(lastEntries);
      marks.attach(next);
    },
  };
}

/** The rendered relic, which is also the surface the marks are painted on. */
export function buildStageWrap(
  view: ReadyView,
  usercontentOrigin: string
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'stage-wrap';
  wrap.appendChild(buildCurrentStage(view, usercontentOrigin));
  return wrap;
}

/**
 * The relic beside its conversation.
 *
 * Reading and commenting happen together, so the sidebar takes width from the
 * row rather than covering the relic or sitting under it. The relic reflows
 * narrower, which is the whole point: a comment is written next to the line it
 * is about, while that line is still on the screen.
 *
 * Order matters. The divider and the edge tab follow the sidebar so the
 * stylesheet can hide each of them from the sidebar's own state with a
 * sibling selector, rather than asking the row to carry a second copy of it.
 */
export function buildRelicRow(
  stage: HTMLElement,
  sidebar?: HTMLElement,
  resizer?: HTMLElement,
  tab?: HTMLElement
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'relic-row';
  row.appendChild(stage);
  if (sidebar !== undefined) row.appendChild(sidebar);
  if (resizer !== undefined) row.appendChild(resizer);
  if (tab !== undefined) row.appendChild(tab);
  return row;
}

function renderReady(
  view: ReadyView,
  relicId: string,
  usercontentOrigin: string,
  deps: ViewerDeps
): void {
  /** The attached taskbar, so a count arriving can replace just that row. */
  let bar: HTMLElement | undefined;
  let commentCount: number | undefined;
  let thread: ThreadHandle | undefined;

  function barFor(): HTMLElement {
    return buildBar(view, relicId, {
      onCompare: () => showComparison(),
      onSelectVersion: showComparison,
      ...(thread === undefined
        ? {}
        : {
            onComments: thread.toggle,
            ...(commentCount === undefined ? {} : { commentCount }),
          }),
    });
  }

  const showCurrent = (): void => {
    bar = barFor();
    const stage = buildStageWrap(view, usercontentOrigin);
    document.body.replaceChildren(
      bar,
      buildRelicRow(stage, thread?.element, thread?.resizer, thread?.tab)
    );
    thread?.attach(stage);
  };
  const showComparison = (selectedVersion?: number): void => {
    renderComparison(
      view,
      relicId,
      usercontentOrigin,
      deps,
      showCurrent,
      selectedVersion
    );
  };

  // A download-only relic gets no thread, for the same reason section 6.1
  // item 13 gives it no comparison control: nothing rendered, so there is
  // nothing on the page to comment about.
  if (view.route !== 'download') {
    thread = buildThread(view, relicId, deps, (count) => {
      commentCount = count;
      if (bar === undefined) return;
      const replacement = barFor();
      bar.replaceWith(replacement);
      bar = replacement;
    });
  }

  showCurrent();
}

function renderDead(dead: DeadView): void {
  const bar = document.createElement('header');
  bar.className = 'bar';
  const mark = document.createElement('div');
  mark.className = 'mark';
  mark.textContent = WORDMARK;
  bar.appendChild(mark);
  document.body.replaceChildren(bar);

  const main = document.createElement('main');
  main.className = 'stage stage-dead';

  const card = document.createElement('div');
  card.className = 'card';

  const headline = document.createElement('h1');
  headline.className = 'card-title';
  headline.textContent = dead.headline;

  const detail = document.createElement('p');
  detail.className = 'card-note';
  detail.textContent = dead.detail;

  card.append(headline, detail);

  if (dead.action === 'retry') {
    const retry = button('Try again', ICONS.rendered, () =>
      window.location.reload()
    );
    retry.classList.add('primary');
    card.appendChild(retry);
  }
  if (dead.action === 'report') {
    const link = document.createElement('a');
    link.className = 'action primary';
    link.href = `${SERVICE_ORIGIN}/abuse`;
    link.textContent = 'Contact us';
    card.appendChild(link);
  }

  const code = document.createElement('div');
  code.className = 'accession';
  code.textContent = dead.code;
  card.appendChild(code);

  main.appendChild(card);
  document.body.appendChild(main);
}

const VAULT_PREFIX = 'relic:key:';

/**
 * Keys remembered in this browser's storage for the service origin.
 *
 * Storage can be absent or refuse to write: private browsing, a quota, an
 * embedded webview, or a user who has blocked site data. None of that should
 * cost somebody the relic they are currently looking at, so every operation
 * degrades to doing nothing. The worst case is the behaviour that existed
 * before this: a reload asks for the original link.
 *
 * Entries carry their relic's expiry and are swept on every read, so storage
 * does not accumulate keys to relics that stopped existing days ago.
 */
export function localStorageKeyVault(
  storage: Storage | undefined = globalThis.localStorage,
  now: () => number = Date.now
): KeyVault {
  const read = (): Storage | undefined => {
    try {
      // Touching localStorage throws outright in some embedded contexts,
      // rather than being absent, so the guard has to be a try and not a null
      // check.
      return storage ?? undefined;
    } catch {
      return undefined;
    }
  };

  const sweep = (store: Storage): void => {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const name = store.key(i);
      if (name === null || !name.startsWith(VAULT_PREFIX)) continue;
      try {
        const entry = JSON.parse(store.getItem(name) ?? '') as {
          expiresAt?: number | null;
        };
        // null is how a never-expires entry is persisted; JSON has no
        // Infinity. Any other non-number is corruption, and swept.
        if (
          (entry.expiresAt !== null && typeof entry.expiresAt !== 'number') ||
          (typeof entry.expiresAt === 'number' && entry.expiresAt <= now())
        ) {
          stale.push(name);
        }
      } catch {
        // Unreadable entry. Not ours to interpret, and not worth keeping.
        stale.push(name);
      }
    }
    for (const name of stale) store.removeItem(name);
  };

  return {
    remember(relicId, fragment, expiresAt) {
      const store = read();
      if (store === undefined) return;
      // NaN stays refused: an unparsable date is corruption, not forever.
      // Infinity passes, because a relic with no lifetime is worth keeping
      // the key for until it is deleted.
      if (Number.isNaN(expiresAt) || expiresAt <= now()) return;
      try {
        store.setItem(
          `${VAULT_PREFIX}${relicId}`,
          JSON.stringify({
            fragment,
            expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
          })
        );
      } catch {
        // Quota, or storage disabled mid-session. A remembered key is a
        // convenience; failing to store one is not worth an error page.
      }
    },

    recall(relicId) {
      const store = read();
      if (store === undefined) return undefined;
      try {
        sweep(store);
        const raw = store.getItem(`${VAULT_PREFIX}${relicId}`);
        if (raw === null) return undefined;
        const entry = JSON.parse(raw) as {
          fragment?: unknown;
          expiresAt?: unknown;
        };
        if (typeof entry.fragment !== 'string') return undefined;
        if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now()) {
          return undefined;
        }
        // null means never expires. Anything else that is not a number is
        // corruption, and recalls nothing.
        if (entry.expiresAt !== null && typeof entry.expiresAt !== 'number') {
          return undefined;
        }
        return entry.fragment;
      } catch {
        return undefined;
      }
    },

    forget(relicId) {
      const store = read();
      if (store === undefined) return;
      try {
        store.removeItem(`${VAULT_PREFIX}${relicId}`);
      } catch {
        // Nothing to do, and nothing worth telling the reader about.
      }
    },
  };
}

export function makeBrowserDeps(): ViewerDeps {
  return {
    serviceOrigin: SERVICE_ORIGIN,
    fetch: globalThis.fetch.bind(globalThis),
    keyVault: localStorageKeyVault(),
    takeFragment: () => window.location.hash,
    stripFragment: () => {
      // Replace the current entry with the fragment removed. The URL that
      // carried it already existed, so this shrinks the window rather than
      // closing it.
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      );
    },
    locationHref: window.location.href,
  };
}

async function main(): Promise<void> {
  const root = document.getElementById('relic-root');
  const relicId = root?.dataset['relicId'] ?? '';
  const usercontentOrigin = root?.dataset['usercontentOrigin'] ?? '';
  const deps = makeBrowserDeps();
  const state = await load(relicId, deps);

  if (state.kind === 'ready')
    renderReady(state.view, relicId, usercontentOrigin, deps);
  else if (state.kind === 'dead') renderDead(state.dead);
}

if (typeof document !== 'undefined') {
  void main();
}
