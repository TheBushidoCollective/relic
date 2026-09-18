/**
 * The usercontent origin's page.
 *
 * This runs on a different registrable domain from the service. That
 * separation is the control, not a detail: the service origin holds the
 * fragment, and untrusted HTML must never execute anywhere that can reach it.
 * Google's own pattern is separate isolated origins, and they treat XSS inside
 * a sandbox domain as an invalid bug report, which shows how completely the
 * origin boundary is doing the work.
 *
 * The parent frames this page with `sandbox` and without `allow-same-origin`,
 * so the document lands in an opaque origin. It cannot read `parent.location`,
 * it cannot touch this origin's storage, and it has no credentials to leak.
 *
 * It receives markup, or transpiled component code. It never receives the
 * key, and there is deliberately no code in this bundle that could do
 * anything with one.
 *
 * Rendered content here cannot reach the network. The page's CSP names no
 * remote source, so nothing a relic's author writes can make a request
 * leave this frame. The JSX path carries its own dependencies for the same
 * reason: React and ReactDOM are bundled into this script, and the build
 * inlines that script into the page. An opaque origin cannot fetch even
 * its own origin's assets, so inlining is the only channel through which
 * the frame can receive code at all.
 */
// React and ReactDOM are bundled into this file rather than fetched: the
// frame is not allowed to reach the network, and an opaque origin cannot
// fetch same-origin assets even when they are offered. One bundled copy
// also settles the instance question hooks depend on: the `React` global
// the component resolves and the `createRoot` that mounts it are the same
// module by construction.
import type { AnchorRect } from '@relic/format';
import {
  COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
  COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
} from '@relic/format';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { rectFromCorners } from './anchoring.ts';
import {
  type FrameMarkPayload,
  type FramePointMessage,
  type FrameRegionMessage,
  type FrameSelectionMessage,
  isArmPointingMessage,
  isClearMarkMessage,
  isClearMarksMessage,
  isPaintMarkMessage,
  isPaintMarksMessage,
  isRevealMarkMessage,
  type RevealMarkMessage,
  takeHeadUtf8,
  takeTailUtf8,
} from './annotate-frame.ts';
import {
  type FrameScrollMessage,
  isSetScrollMessage,
  type SetScrollMessage,
} from './frame-scroll.ts';
import {
  applyMarks,
  captureTree,
  HIGHLIGHT_CSS,
  isAnnotateMessage,
  type Mark,
} from './rendered-tree.ts';
import {
  landmarkScrollDelta,
  nearestScrollLandmark,
  type ScrollPosition,
} from './scroll-landmark.ts';

export interface RenderMessage {
  readonly type: 'relic:render';
  readonly html: string;
}

export function isRenderMessage(data: unknown): data is RenderMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    'html' in data &&
    data.type === 'relic:render' &&
    typeof data.html === 'string'
  );
}

export interface RenderJsxMessage {
  readonly type: 'relic:render-jsx';
  readonly code: string;
}

export function isRenderJsxMessage(data: unknown): data is RenderJsxMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    'code' in data &&
    data.type === 'relic:render-jsx' &&
    typeof data.code === 'string'
  );
}

export interface FrameInteractionHandler {
  setArmed(armed: boolean): void;
  onPaintMark(mark: FrameMarkPayload): boolean;
  onPaintMarks(marks: readonly FrameMarkPayload[]): boolean;
  onClearMark(id: string): void;
  onClearMarks(): void;
  onRevealMark(msg: RevealMarkMessage): void;
  onPairMark(id: string, active: boolean): void;
  onSetScroll?(position: ScrollPosition): void;
}

export interface FrameInteraction extends FrameInteractionHandler {
  isArmed(): boolean;
}

/**
 * Constant stylesheet injected into the frame for comment marks and pointing.
 * Isolated from service-origin styles, so it provides its own visual tokens.
 */
export const FRAME_MARK_CSS = `
.relic-text-mark {
  background: rgba(180, 140, 60, 0.22);
  border-bottom: 2px solid rgba(180, 140, 60, 0.8);
  color: inherit;
  cursor: pointer;
  padding: 0.1em 0;
}
.relic-text-mark.is-pending {
  background: rgba(180, 140, 60, 0.14);
  border-bottom: 2px dashed rgba(180, 140, 60, 0.8);
}
.relic-text-mark.is-paired {
  background: rgba(180, 140, 60, 0.42);
  outline: 2px solid rgba(180, 140, 60, 0.8);
}
.relic-region-mark {
  position: absolute;
  box-sizing: border-box;
  background: rgba(180, 140, 60, 0.18);
  border: 2px solid rgba(180, 140, 60, 0.8);
  border-radius: 3px;
  cursor: pointer;
  pointer-events: auto;
}
.relic-region-mark.is-pending {
  background: rgba(180, 140, 60, 0.10);
  border: 2px dashed rgba(180, 140, 60, 0.8);
}
.relic-region-mark.is-paired {
  background: rgba(180, 140, 60, 0.35);
  box-shadow: 0 0 0 2px rgba(180, 140, 60, 0.8);
}
.relic-pointing-active, .relic-pointing-active * {
  cursor: crosshair !important;
}
`;

export function ensureFrameStyles(doc: Document): void {
  if (doc.getElementById('relic-frame-styles')) return;
  const style = doc.createElement('style');
  style.id = 'relic-frame-styles';
  style.textContent = FRAME_MARK_CSS;
  doc.head?.appendChild(style);
}

/**
 * Wrap an occurrence of a text quote in the frame DOM with a mark element.
 *
 * Uses `document.createElement('mark')` and DOM text node splitting.
 * Never uses `innerHTML`, ensuring author markup or hostile quote text
 * cannot inject executable HTML.
 */
export function wrapFrameQuote(
  root: HTMLElement,
  exact: string,
  prefix?: string,
  suffix?: string,
  id = ''
): boolean {
  if (exact.length === 0) return false;
  const doc = root.ownerDocument;
  if (!doc) return false;
  ensureFrameStyles(doc);

  const textNodes: Text[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (
        parent?.closest(
          'mark.relic-text-mark, script, style, #relic-frame-overlay'
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let curr = walker.nextNode();
  while (curr !== null) {
    textNodes.push(curr as Text);
    curr = walker.nextNode();
  }
  if (textNodes.length === 0) return false;

  type Candidate = {
    node: Text;
    index: number;
    score: number;
  };
  const candidates: Candidate[] = [];

  for (const node of textNodes) {
    let startPos = 0;
    while (startPos < node.data.length) {
      const index = node.data.indexOf(exact, startPos);
      if (index === -1) break;
      let score = 0;
      if (prefix && prefix.length > 0) {
        const preceding = node.data.slice(0, index);
        if (preceding.endsWith(prefix) || prefix.endsWith(preceding)) {
          score += Math.min(preceding.length, prefix.length);
        }
      }
      if (suffix && suffix.length > 0) {
        const following = node.data.slice(index + exact.length);
        if (following.startsWith(suffix) || suffix.startsWith(following)) {
          score += Math.min(following.length, suffix.length);
        }
      }
      candidates.push({ node, index, score });
      startPos = index + 1;
    }
  }

  if (candidates.length === 0) {
    let fullText = '';
    const spans: { node: Text; start: number; end: number }[] = [];
    for (const node of textNodes) {
      const start = fullText.length;
      fullText += node.data;
      spans.push({ node, start, end: fullText.length });
    }

    const multiCandidates: { start: number; end: number; score: number }[] = [];
    let startPos = 0;
    while (startPos < fullText.length) {
      const idx = fullText.indexOf(exact, startPos);
      if (idx === -1) break;
      let score = 0;
      if (prefix && prefix.length > 0) {
        const preceding = fullText.slice(Math.max(0, idx - prefix.length), idx);
        if (preceding === prefix) score += prefix.length;
      }
      if (suffix && suffix.length > 0) {
        const following = fullText.slice(
          idx + exact.length,
          idx + exact.length + suffix.length
        );
        if (following === suffix) score += suffix.length;
      }
      multiCandidates.push({ start: idx, end: idx + exact.length, score });
      startPos = idx + 1;
    }

    if (multiCandidates.length === 0) return false;

    multiCandidates.sort((a, b) => b.score - a.score);
    const chosen = multiCandidates[0];
    if (!chosen) return false;
    for (const span of spans) {
      if (span.end <= chosen.start || span.start >= chosen.end) continue;
      const nodeStart = Math.max(0, chosen.start - span.start);
      const nodeEnd = Math.min(span.node.data.length, chosen.end - span.start);
      const matchLen = nodeEnd - nodeStart;
      if (matchLen <= 0) continue;

      let target = span.node;
      if (nodeStart > 0) {
        target = target.splitText(nodeStart);
      }
      if (target.data.length > matchLen) {
        target.splitText(matchLen);
      }

      const mark = doc.createElement('mark');
      mark.className = `relic-text-mark${id === 'pending:target' ? ' is-pending' : ''}`;
      mark.dataset.commentId = id;
      target.parentNode?.insertBefore(mark, target);
      mark.appendChild(target);
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        doc.defaultView?.parent?.postMessage(
          { type: 'relic:frame-mark-click', id },
          '*'
        );
      });
    }
    return true;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return false;
  let target = best.node;
  if (best.index > 0) {
    target = target.splitText(best.index);
  }
  if (target.data.length > exact.length) {
    target.splitText(exact.length);
  }

  const mark = doc.createElement('mark');
  mark.className = `relic-text-mark${id === 'pending:target' ? ' is-pending' : ''}`;
  mark.dataset.commentId = id;
  target.parentNode?.insertBefore(mark, target);
  mark.appendChild(target);
  mark.addEventListener('click', (e) => {
    e.stopPropagation();
    doc.defaultView?.parent?.postMessage(
      { type: 'relic:frame-mark-click', id },
      '*'
    );
  });
  return true;
}

export function unwrapFrameQuotes(root: HTMLElement, id?: string): void {
  const selector =
    id !== undefined
      ? `mark.relic-text-mark[data-comment-id="${id}"]`
      : 'mark.relic-text-mark';
  for (const mark of Array.from(root.querySelectorAll(selector))) {
    const parent = mark.parentNode;
    if (parent === null) continue;
    while (mark.firstChild !== null) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();
  }
}

export function paintFrameRegion(
  root: HTMLElement,
  rect: AnchorRect,
  id: string
): HTMLElement | undefined {
  const doc = root.ownerDocument;
  if (!doc || !doc.body) return undefined;
  ensureFrameStyles(doc);

  const docWidth = Math.max(
    doc.documentElement.scrollWidth,
    doc.body.scrollWidth
  );
  const docHeight = Math.max(
    doc.documentElement.scrollHeight,
    doc.body.scrollHeight
  );
  if (docWidth <= 0 || docHeight <= 0) return undefined;

  let overlay = doc.getElementById('relic-frame-overlay');
  if (!overlay) {
    overlay = doc.createElement('div');
    overlay.id = 'relic-frame-overlay';
    overlay.style.cssText =
      'position: absolute; left: 0; top: 0; pointer-events: none; z-index: 99999;';
    doc.body.appendChild(overlay);
  }
  overlay.style.width = `${docWidth}px`;
  overlay.style.height = `${docHeight}px`;

  for (const old of Array.from(
    overlay.querySelectorAll(`[data-comment-id="${id}"]`)
  )) {
    old.remove();
  }

  const div = doc.createElement('div');
  div.className = `relic-region-mark${id === 'pending:target' ? ' is-pending' : ''}`;
  div.dataset.commentId = id;
  div.style.left = `${rect.x * docWidth}px`;
  div.style.top = `${rect.y * docHeight}px`;
  div.style.width = `${rect.w * docWidth}px`;
  div.style.height = `${rect.h * docHeight}px`;

  div.addEventListener('click', (e) => {
    e.stopPropagation();
    doc.defaultView?.parent?.postMessage(
      { type: 'relic:frame-mark-click', id },
      '*'
    );
  });

  overlay.appendChild(div);
  return div;
}

export function clearFrameRegions(root: HTMLElement, id?: string): void {
  const overlay = root.querySelector('#relic-frame-overlay');
  if (!overlay) return;
  if (id !== undefined) {
    for (const el of Array.from(
      overlay.querySelectorAll(`[data-comment-id="${id}"]`)
    )) {
      el.remove();
    }
  } else {
    overlay.replaceChildren();
  }
}

/**
 * Setup pointer, selection, and mark manipulation listeners inside the frame.
 */
/** How far down its travel the document in a window sits, or null when it cannot move. */
export function documentScrollFraction(
  doc: Document,
  win: Window
): number | null {
  const el = doc.scrollingElement ?? doc.documentElement;
  if (!el) return null;
  const scrollHeight = Math.max(
    el.scrollHeight ?? 0,
    doc.body?.scrollHeight ?? 0
  );
  const clientHeight = win.innerHeight || el.clientHeight || 0;
  const travel = scrollHeight - clientHeight;
  if (!(travel > 0)) return null;
  const scrollTop = win.scrollY || el.scrollTop || doc.body?.scrollTop || 0;
  const clamped = Math.min(Math.max(scrollTop, 0), travel);
  return clamped / travel;
}

/** Put the document in a window at a fraction of its travel. */
function documentScrollTop(doc: Document, win: Window): number {
  const el = doc.scrollingElement ?? doc.documentElement;
  return win.scrollY || el?.scrollTop || doc.body?.scrollTop || 0;
}

function applyDocumentScrollTop(
  doc: Document,
  win: Window,
  target: number
): void {
  const el = doc.scrollingElement ?? doc.documentElement;
  if (!el) return;
  const scrollHeight = Math.max(
    el.scrollHeight ?? 0,
    doc.body?.scrollHeight ?? 0
  );
  const clientHeight = win.innerHeight || el.clientHeight || 0;
  const travel = Math.max(scrollHeight - clientHeight, 0);
  const bounded = Math.round(Math.min(Math.max(target, 0), travel));
  const current = documentScrollTop(doc, win);
  if (Math.abs(current - bounded) <= 1) return;
  if (typeof win.scrollTo === 'function') {
    try {
      win.scrollTo({ top: bounded, behavior: 'instant' as ScrollBehavior });
    } catch {
      win.scrollTo(0, bounded);
    }
  }
  if (el.scrollTop !== bounded) el.scrollTop = bounded;
  if (doc.body && doc.body.scrollTop !== bounded) doc.body.scrollTop = bounded;
}

/** The frame's exact paired reference plus the proportional fallback. */
export function documentScrollPosition(
  doc: Document,
  win: Window
): ScrollPosition | null {
  const fraction = documentScrollFraction(doc, win);
  if (fraction === null) return null;
  const landmark = nearestScrollLandmark(doc);
  return {
    fraction,
    ...(landmark === undefined ? {} : { landmark }),
  };
}

/** Put a document at a paired mark when it has one, otherwise by fraction. */
export function applyDocumentScrollPosition(
  doc: Document,
  win: Window,
  position: ScrollPosition
): void {
  if (position.landmark !== undefined) {
    const delta = landmarkScrollDelta(doc, position.landmark);
    if (delta !== null) {
      const el = doc.scrollingElement ?? doc.documentElement;
      const scrollHeight = Math.max(
        el?.scrollHeight ?? 0,
        doc.body?.scrollHeight ?? 0
      );
      const clientHeight = win.innerHeight || el?.clientHeight || 0;
      const travel = Math.max(scrollHeight - clientHeight, 0);
      const exactTarget = documentScrollTop(doc, win) + delta;
      if (exactTarget >= 0 && exactTarget <= travel) {
        applyDocumentScrollTop(doc, win, exactTarget);
        return;
      }
    }
  }
  applyDocumentScrollFraction(doc, win, position.fraction);
}

export function applyDocumentScrollFraction(
  doc: Document,
  win: Window,
  fraction: number
): void {
  const el = doc.scrollingElement ?? doc.documentElement;
  if (!el) return;
  const scrollHeight = Math.max(
    el.scrollHeight ?? 0,
    doc.body?.scrollHeight ?? 0
  );
  const clientHeight = win.innerHeight || el.clientHeight || 0;
  const travel = scrollHeight - clientHeight;
  if (!(travel > 0)) return;
  const bounded = Math.min(Math.max(fraction, 0), 1);
  applyDocumentScrollTop(doc, win, bounded * travel);
}

export function setupFrameInteraction(
  doc: Document,
  win: Window,
  postOutward: (msg: object) => void
): FrameInteraction {
  let armed = false;
  let startX = 0;
  let startY = 0;
  let isDown = false;
  let suppressScroll = false;
  let scrollResetTimer: number | undefined;

  const handleScroll = (): void => {
    if (suppressScroll) return;
    const position = documentScrollPosition(doc, win);
    if (position === null) return;
    postOutward({ type: 'relic:frame-scroll', ...position });
  };

  // Guarded because this function is called with a stub window in the frame
  // interaction tests, which predate scroll syncing and supply only the
  // members they exercise. An unguarded call threw there and took two tests
  // with it, which is the signal that the stub is the contract this function
  // has always had.
  if (typeof win.addEventListener === 'function') {
    win.addEventListener('scroll', handleScroll, { passive: true });
  }

  doc.addEventListener('mousedown', (event: MouseEvent) => {
    if (!armed) return;
    isDown = true;
    startX = event.pageX;
    startY = event.pageY;
  });

  function handleSelection(): void {
    const sel = win.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const raw = sel.toString().trim();
    if (raw.length === 0) return;

    const exact = takeHeadUtf8(raw, COMMENT_ANCHOR_QUOTE_LIMIT_BYTES);
    if (exact.length === 0) return;

    const range = sel.getRangeAt(0);
    let prefix = '';
    let suffix = '';
    try {
      if (doc.body) {
        const preRange = doc.createRange();
        preRange.selectNodeContents(doc.body);
        preRange.setEnd(range.startContainer, range.startOffset);
        prefix = takeTailUtf8(
          preRange.toString(),
          COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES
        );

        const postRange = doc.createRange();
        postRange.selectNodeContents(doc.body);
        postRange.setStart(range.endContainer, range.endOffset);
        suffix = takeHeadUtf8(
          postRange.toString(),
          COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES
        );
      }
    } catch {
      // If range computation throws in an edge-case DOM state, proceed without context
    }

    const message: FrameSelectionMessage = {
      type: 'relic:frame-selection',
      exact,
      ...(prefix.length > 0 ? { prefix } : {}),
      ...(suffix.length > 0 ? { suffix } : {}),
    };
    postOutward(message);
  }

  doc.addEventListener('mouseup', (event: MouseEvent) => {
    if (!armed) {
      // When pointing is disarmed, reading clicks pass through normally.
      // Check whether text was selected instead.
      handleSelection();
      return;
    }

    if (!isDown) return;
    isDown = false;
    event.preventDefault?.();
    event.stopPropagation?.();

    const endX = event.pageX;
    const endY = event.pageY;

    const docWidth = Math.max(
      doc.documentElement.scrollWidth,
      doc.body?.scrollWidth ?? 0
    );
    const docHeight = Math.max(
      doc.documentElement.scrollHeight,
      doc.body?.scrollHeight ?? 0
    );
    if (docWidth <= 0 || docHeight <= 0) return;

    // Unit coordinates are measured relative to the scrolling document,
    // not the visible viewport. If measured against the visible viewport,
    // a mark placed while scrolled would point at the wrong element after
    // scrolling elsewhere.
    const from = {
      x: Math.max(0, Math.min(1, startX / docWidth)),
      y: Math.max(0, Math.min(1, startY / docHeight)),
    };
    const to = {
      x: Math.max(0, Math.min(1, endX / docWidth)),
      y: Math.max(0, Math.min(1, endY / docHeight)),
    };

    const rect = rectFromCorners(from, to, 0.005);
    if (rect !== undefined) {
      const msg: FrameRegionMessage = { type: 'relic:frame-region', rect };
      postOutward(msg);
    } else {
      const msg: FramePointMessage = {
        type: 'relic:frame-point',
        x: from.x,
        y: from.y,
      };
      postOutward(msg);
    }
  });

  return {
    setArmed(nextArmed: boolean) {
      armed = nextArmed;
      if (doc.documentElement) {
        doc.documentElement.classList.toggle('relic-pointing-active', armed);
      }
    },

    isArmed() {
      return armed;
    },

    onPaintMark(mark: FrameMarkPayload): boolean {
      if (!doc.body) return false;
      if (mark.kind === 'quote') {
        unwrapFrameQuotes(doc.body, mark.id);
        return wrapFrameQuote(
          doc.body,
          mark.exact,
          mark.prefix,
          mark.suffix,
          mark.id
        );
      }
      if (mark.kind === 'region') {
        return paintFrameRegion(doc.body, mark.rect, mark.id) !== undefined;
      }
      return false;
    },

    onPaintMarks(marks: readonly FrameMarkPayload[]): boolean {
      let allPlaced = true;
      for (const mark of marks) {
        const placed = this.onPaintMark(mark);
        if (!placed) allPlaced = false;
      }
      return allPlaced;
    },

    onClearMark(id: string) {
      if (!doc.body) return;
      unwrapFrameQuotes(doc.body, id);
      clearFrameRegions(doc.body, id);
    },

    onClearMarks() {
      if (!doc.body) return;
      unwrapFrameQuotes(doc.body);
      clearFrameRegions(doc.body);
    },

    onRevealMark(msg: RevealMarkMessage) {
      if (!doc.body) return;
      if (msg.id) {
        const target = doc.body.querySelector(`[data-comment-id="${msg.id}"]`);
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
      }
      if (msg.kind === 'quote' && msg.exact) {
        const quoteMark = doc.body.querySelector('mark.relic-text-mark');
        if (quoteMark instanceof HTMLElement) {
          quoteMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
      }
      if (msg.kind === 'region' && msg.rect) {
        const docHeight = Math.max(
          doc.documentElement.scrollHeight,
          doc.body.scrollHeight
        );
        win.scrollTo({
          top: msg.rect.y * docHeight,
          behavior: 'smooth',
        });
      }
    },

    onPairMark(id: string, active: boolean) {
      if (!doc.body) return;
      const targets = doc.body.querySelectorAll(`[data-comment-id="${id}"]`);
      for (const target of Array.from(targets)) {
        target.classList.toggle('is-paired', active);
      }
    },

    onSetScroll(position: ScrollPosition) {
      suppressScroll = true;
      clearTimeout(scrollResetTimer);
      applyDocumentScrollPosition(doc, win, position);
      scrollResetTimer = win.setTimeout(() => {
        suppressScroll = false;
      }, 50) as unknown as number;
    },
  };
}

/**
 * Build the message handler.
 *
 * `write` is injected so the guard logic is testable without a DOM, and so
 * the one call that actually renders untrusted markup sits in a single named
 * place rather than inline in an event listener. `writeJsx` is injected for
 * the same reason: the guard does not care how a render lands, only that it
 * lands once. `annotate` is injected for the same reason again, and carries a
 * default so every existing call site keeps working.
 *
 * `interaction` handles comment mark painting, point/region arming, and reveal
 * requests once the frame has rendered.
 */
export function createSandboxHandler(
  write: (html: string) => void,
  writeJsx: (code: string) => void,
  annotate: (marks: readonly Mark[]) => void = () => {},
  interaction?: FrameInteractionHandler
): (data: unknown) => boolean {
  let rendered = false;
  let annotated = false;

  return (data: unknown): boolean => {
    if (!rendered) {
      if (isRenderMessage(data)) {
        rendered = true;
        write(data.html);
        return true;
      }
      if (isRenderJsxMessage(data)) {
        rendered = true;
        writeJsx(data.code);
        return true;
      }
      return false;
    }

    if (!annotated && isAnnotateMessage(data)) {
      annotated = true;
      annotate(data.marks);
      return true;
    }

    if (isArmPointingMessage(data)) {
      interaction?.setArmed(data.armed);
      return true;
    }

    if (isPaintMarkMessage(data)) {
      return interaction?.onPaintMark(data.mark) ?? true;
    }

    if (isPaintMarksMessage(data)) {
      return interaction?.onPaintMarks(data.marks) ?? true;
    }

    if (isClearMarkMessage(data)) {
      interaction?.onClearMark(data.id);
      return true;
    }

    if (isClearMarksMessage(data)) {
      interaction?.onClearMarks();
      return true;
    }

    if (isRevealMarkMessage(data)) {
      interaction?.onRevealMark(data);
      return true;
    }

    if (isSetScrollMessage(data)) {
      interaction?.onSetScroll?.({
        fraction: data.fraction,
        ...(data.landmark === undefined ? {} : { landmark: data.landmark }),
      });
      return true;
    }
    return false;
  };
}

async function mountComponent(code: string): Promise<void> {
  const root = document.createElement('div');
  root.id = 'relic-root';
  document.body.replaceChildren(root);

  try {
    const sandboxGlobal = globalThis as { React?: typeof React };
    sandboxGlobal.React = React;
    const url = URL.createObjectURL(
      new Blob([code], { type: 'text/javascript' })
    );
    const module = await import(url);
    const component = module.default;
    if (typeof component !== 'function') {
      throw new Error('module has no default export to mount');
    }
    createRoot(root).render(React.createElement(component));
  } catch {
    const failure = document.createElement('div');
    failure.style.cssText =
      'font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;' +
      'padding: 2rem; color: #333;';
    failure.textContent = 'This component could not be rendered.';
    root.replaceChildren(failure);
  }
}

/**
 * Tell the parent what this frame ended up rendering.
 */
function reportTree(): void {
  window.parent.postMessage(
    { type: 'relic:tree', tree: captureTree(document.body) },
    '*'
  );
}

function scheduleReport(): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(reportTree));
    return;
  }
  window.setTimeout(reportTree, 0);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let interaction: FrameInteraction | undefined;

  function initInteraction(): void {
    interaction = setupFrameInteraction(document, window, (msg) => {
      window.parent.postMessage(msg, '*');
    });
  }

  const handle = createSandboxHandler(
    (html) => {
      document.open();
      document.write(html);
      document.close();
      initInteraction();
      listen();
      scheduleReport();
    },
    (code) => {
      void mountComponent(code).then(() => {
        initInteraction();
        scheduleReport();
      }, scheduleReport);
    },
    (marks) => {
      const style = document.createElement('style');
      style.textContent = HIGHLIGHT_CSS;
      document.head.appendChild(style);
      applyMarks(document.body, marks);
    },
    {
      setArmed: (armed) => interaction?.setArmed(armed),
      onPaintMark: (mark) => interaction?.onPaintMark(mark) ?? false,
      onPaintMarks: (marks) => interaction?.onPaintMarks(marks) ?? false,
      onClearMark: (id) => interaction?.onClearMark(id),
      onClearMarks: () => interaction?.onClearMarks(),
      onRevealMark: (msg) => interaction?.onRevealMark(msg),
      onPairMark: (id, active) => interaction?.onPairMark(id, active),
      onSetScroll: (fraction) => interaction?.onSetScroll?.(fraction),
    }
  );

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== window.parent) return;
    handle(event.data);
  };

  function listen(): void {
    window.addEventListener('message', onMessage);
  }
  listen();

  window.parent.postMessage({ type: 'relic:sandbox-ready' }, '*');
}
