/**
 * Annotation bridge for sandboxed HTML and JSX relics.
 *
 * Framed relics render inside an opaque-origin iframe (`sandbox="allow-scripts"`
 * without `allow-same-origin`) on the usercontent origin. The parent window
 * holds the decryption key and comment ciphertext but cannot read into the
 * frame's DOM directly. The frame renders author-controlled content and runs
 * without network access, but cannot read parent storage or location.
 *
 * This module defines the bidirectional message protocol that connects them:
 *
 * 1. Outward (Frame to Parent):
 *    - `relic:frame-selection`: reader selected text inside the frame.
 *    - `relic:frame-point`: reader clicked a point while pointing was armed.
 *    - `relic:frame-region`: reader dragged a box while pointing was armed.
 *    - `relic:frame-mark-click`: reader clicked an existing mark inside the frame.
 *
 * 2. Inward (Parent to Frame):
 *    - `relic:arm-pointing`: arm or disarm click/drag capture inside the frame.
 *    - `relic:paint-mark`: paint an individual mark (quote or region) by ID.
 *    - `relic:paint-marks`: paint a batch of marks by ID.
 *    - `relic:clear-mark`: remove a mark by ID.
 *    - `relic:clear-marks`: remove all comment marks from the frame.
 *    - `relic:reveal-mark`: scroll the frame to bring a mark into view.
 *
 * Security guarantees:
 * Every message crossing the boundary is validated strictly. The parent validates
 * that `event.source` is the frame's `contentWindow` and verifies message shape.
 * The frame validates that `event.source` is `window.parent` and verifies message shape.
 * Marks are constructed using `document.createElement` and `textContent` (never `innerHTML`),
 * ensuring author content or quote text cannot inject markup.
 */

import {
  type AnchorRect,
  COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
  COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
  type CommentAnchor,
} from '@relic/format';
import {
  type AnchorAdapter,
  type AnchorSurface,
  registerAnchorAdapter,
} from './anchoring.ts';

/**
 * Take code points from the start of text up to maxBytes in UTF-8.
 *
 * Never cuts a multibyte character or surrogate pair in half, which would
 * produce invalid UTF-8 sequences or replacement characters.
 */
export function takeHeadUtf8(text: string, maxBytes: number): string {
  if (text.length === 0 || maxBytes <= 0) return '';
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let totalBytes = 0;
  let endCodeUnit = 0;
  for (const char of text) {
    const charBytes = encoder.encode(char).length;
    if (totalBytes + charBytes > maxBytes) break;
    totalBytes += charBytes;
    endCodeUnit += char.length;
  }
  return text.slice(0, endCodeUnit);
}

/**
 * Take code points from the end of text backwards up to maxBytes in UTF-8,
 * preserving forward order in the result.
 *
 * Never cuts a multibyte character or surrogate pair in half.
 */
export function takeTailUtf8(text: string, maxBytes: number): string {
  if (text.length === 0 || maxBytes <= 0) return '';
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  const chars = Array.from(text);
  let totalBytes = 0;
  let startIdx = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i];
    const charBytes = encoder.encode(char).length;
    if (totalBytes + charBytes > maxBytes) break;
    totalBytes += charBytes;
    startIdx = i;
  }
  return chars.slice(startIdx).join('');
}

/**
 * Validate that an object satisfies the AnchorRect contract:
 * x, y, w, h are finite numbers in the unit square, with positive area
 * and no overhang past 1.
 */
export function isValidAnchorRect(data: unknown): data is AnchorRect {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Record<string, unknown>;
  const x = candidate.x;
  const y = candidate.y;
  const w = candidate.w;
  const h = candidate.h;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number'
  ) {
    return false;
  }
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    return false;
  }
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return false;
  if (x > 1 || y > 1) return false;
  if (x + w > 1.0001 || y + h > 1.0001) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Outward messages (Frame -> Parent)
// ---------------------------------------------------------------------------

export interface FrameSelectionMessage {
  readonly type: 'relic:frame-selection';
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

export function isFrameSelectionMessage(
  data: unknown
): data is FrameSelectionMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:frame-selection') return false;
  if (typeof msg.exact !== 'string') return false;
  if (
    new TextEncoder().encode(msg.exact).length >
    COMMENT_ANCHOR_QUOTE_LIMIT_BYTES
  ) {
    return false;
  }
  if (
    msg.prefix !== undefined &&
    (typeof msg.prefix !== 'string' ||
      new TextEncoder().encode(msg.prefix).length >
        COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES)
  ) {
    return false;
  }
  if (
    msg.suffix !== undefined &&
    (typeof msg.suffix !== 'string' ||
      new TextEncoder().encode(msg.suffix).length >
        COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES)
  ) {
    return false;
  }
  return true;
}

export interface FramePointMessage {
  readonly type: 'relic:frame-point';
  readonly x: number;
  readonly y: number;
}

export function isFramePointMessage(data: unknown): data is FramePointMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:frame-point') return false;
  if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return false;
  if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return false;
  if (msg.x < 0 || msg.x > 1 || msg.y < 0 || msg.y > 1) return false;
  return true;
}

export interface FrameRegionMessage {
  readonly type: 'relic:frame-region';
  readonly rect: AnchorRect;
}

export function isFrameRegionMessage(
  data: unknown
): data is FrameRegionMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:frame-region') return false;
  return isValidAnchorRect(msg.rect);
}

export interface FrameMarkClickMessage {
  readonly type: 'relic:frame-mark-click';
  readonly id: string;
}

export function isFrameMarkClickMessage(
  data: unknown
): data is FrameMarkClickMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:frame-mark-click') return false;
  if (
    typeof msg.id !== 'string' ||
    msg.id.length === 0 ||
    msg.id.length > 256
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Inward messages (Parent -> Frame)
// ---------------------------------------------------------------------------

export interface ArmPointingMessage {
  readonly type: 'relic:arm-pointing';
  readonly armed: boolean;
}

export function isArmPointingMessage(
  data: unknown
): data is ArmPointingMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg.type === 'relic:arm-pointing' && typeof msg.armed === 'boolean';
}

export type FrameMarkPayload =
  | {
      readonly id: string;
      readonly kind: 'quote';
      readonly exact: string;
      readonly prefix?: string;
      readonly suffix?: string;
    }
  | {
      readonly id: string;
      readonly kind: 'region';
      readonly rect: AnchorRect;
    };

export function isValidFrameMarkPayload(
  data: unknown
): data is FrameMarkPayload {
  if (typeof data !== 'object' || data === null) return false;
  const mark = data as Record<string, unknown>;
  if (
    typeof mark.id !== 'string' ||
    mark.id.length === 0 ||
    mark.id.length > 256
  ) {
    return false;
  }
  if (mark.kind === 'quote') {
    if (typeof mark.exact !== 'string') return false;
    if (
      new TextEncoder().encode(mark.exact).length >
      COMMENT_ANCHOR_QUOTE_LIMIT_BYTES
    ) {
      return false;
    }
    if (
      mark.prefix !== undefined &&
      (typeof mark.prefix !== 'string' ||
        new TextEncoder().encode(mark.prefix).length >
          COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES)
    ) {
      return false;
    }
    if (
      mark.suffix !== undefined &&
      (typeof mark.suffix !== 'string' ||
        new TextEncoder().encode(mark.suffix).length >
          COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES)
    ) {
      return false;
    }
    return true;
  }
  if (mark.kind === 'region') {
    return isValidAnchorRect(mark.rect);
  }
  return false;
}

export interface PaintMarkMessage {
  readonly type: 'relic:paint-mark';
  readonly mark: FrameMarkPayload;
}

export function isPaintMarkMessage(data: unknown): data is PaintMarkMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:paint-mark') return false;
  return isValidFrameMarkPayload(msg.mark);
}

export interface PaintMarksMessage {
  readonly type: 'relic:paint-marks';
  readonly marks: readonly FrameMarkPayload[];
}

export function isPaintMarksMessage(data: unknown): data is PaintMarksMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:paint-marks') return false;
  if (!Array.isArray(msg.marks)) return false;
  return msg.marks.every(isValidFrameMarkPayload);
}

export interface ClearMarkMessage {
  readonly type: 'relic:clear-mark';
  readonly id: string;
}

export function isClearMarkMessage(data: unknown): data is ClearMarkMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg.type === 'relic:clear-mark' && typeof msg.id === 'string';
}

export interface ClearMarksMessage {
  readonly type: 'relic:clear-marks';
}

export function isClearMarksMessage(data: unknown): data is ClearMarksMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg.type === 'relic:clear-marks';
}

export interface RevealMarkMessage {
  readonly type: 'relic:reveal-mark';
  readonly id?: string;
  readonly kind?: 'quote' | 'region';
  readonly exact?: string;
  readonly rect?: AnchorRect;
}

export function isRevealMarkMessage(data: unknown): data is RevealMarkMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:reveal-mark') return false;
  if (msg.id !== undefined && typeof msg.id !== 'string') return false;
  if (msg.kind !== undefined && msg.kind !== 'quote' && msg.kind !== 'region') {
    return false;
  }
  if (msg.exact !== undefined && typeof msg.exact !== 'string') return false;
  if (msg.rect !== undefined && !isValidAnchorRect(msg.rect)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Adapters for iframe.usercontent-frame
// ---------------------------------------------------------------------------

function isFrameSurface(surface: AnchorSurface): boolean {
  const content = surface.content;
  if (!content || typeof content !== 'object') return false;
  if (
    typeof HTMLIFrameElement !== 'undefined' &&
    content instanceof HTMLIFrameElement
  ) {
    return content.classList.contains('usercontent-frame');
  }
  if ('tagName' in content && typeof content.tagName === 'string') {
    if (content.tagName.toUpperCase() !== 'IFRAME') return false;
    if (
      'classList' in content &&
      content.classList &&
      typeof content.classList === 'object'
    ) {
      const cl = content.classList;
      if ('contains' in cl && typeof cl.contains === 'function') {
        return Boolean(cl.contains('usercontent-frame'));
      }
    }
    if ('className' in content && typeof content.className === 'string') {
      return content.className.includes('usercontent-frame');
    }
  }
  return false;
}

function frameWindow(surface: AnchorSurface): Window | undefined {
  const content = surface.content;
  if (content && typeof content === 'object' && 'contentWindow' in content) {
    const win = content.contentWindow;
    if (win && typeof win === 'object' && 'postMessage' in win) {
      return win as Window;
    }
  }
  return undefined;
}

/**
 * Adapter for quote anchors targeting text rendered inside a sandboxed iframe.
 *
 * Claims kind 'quote' strictly when the rendered stage holds an iframe.usercontent-frame.
 * Forwards paint and reveal instructions across postMessage to the frame shim.
 */
export const frameQuoteAdapter: AnchorAdapter<'quote'> = {
  kind: 'quote',

  label(anchor: Extract<CommentAnchor, { kind: 'quote' }>): string {
    const plain = anchor.exact.replace(
      /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g,
      ''
    );
    const shown =
      plain.length > 60 ? `${plain.slice(0, 60).trimEnd()}…` : plain;
    return `Commenting on "${shown}"`;
  },

  supports(surface: AnchorSurface): boolean {
    return isFrameSurface(surface);
  },

  paint(
    surface: AnchorSurface,
    _overlay: HTMLElement,
    anchor: Extract<CommentAnchor, { kind: 'quote' }>,
    commentId: string
  ): boolean {
    if (!isFrameSurface(surface)) return false;
    const win = frameWindow(surface);
    win?.postMessage(
      {
        type: 'relic:paint-mark',
        mark: {
          id: commentId,
          kind: 'quote',
          exact: anchor.exact,
          ...(anchor.prefix ? { prefix: anchor.prefix } : {}),
          ...(anchor.suffix ? { suffix: anchor.suffix } : {}),
        },
      } satisfies PaintMarkMessage,
      '*'
    );
    return true;
  },

  reveal(
    surface: AnchorSurface,
    anchor: Extract<CommentAnchor, { kind: 'quote' }>
  ): void {
    if (!isFrameSurface(surface)) return;
    const win = frameWindow(surface);
    win?.postMessage(
      {
        type: 'relic:reveal-mark',
        kind: 'quote',
        exact: anchor.exact,
      } satisfies RevealMarkMessage,
      '*'
    );
  },
};

/**
 * Adapter for region anchors targeting a box or point on a sandboxed iframe.
 *
 * Coordinates are unit rectangles relative to the frame's scrolling document box.
 * Claims kind 'region' strictly when the rendered stage holds an iframe.usercontent-frame.
 */
export const frameRegionAdapter: AnchorAdapter<'region'> = {
  kind: 'region',

  label(_anchor: Extract<CommentAnchor, { kind: 'region' }>): string {
    return 'Commenting on a region';
  },

  supports(surface: AnchorSurface): boolean {
    return isFrameSurface(surface);
  },

  paint(
    surface: AnchorSurface,
    _overlay: HTMLElement,
    anchor: Extract<CommentAnchor, { kind: 'region' }>,
    commentId: string
  ): boolean {
    if (!isFrameSurface(surface)) return false;
    const win = frameWindow(surface);
    win?.postMessage(
      {
        type: 'relic:paint-mark',
        mark: {
          id: commentId,
          kind: 'region',
          rect: anchor.rect,
        },
      } satisfies PaintMarkMessage,
      '*'
    );
    return true;
  },
  reveal(
    surface: AnchorSurface,
    anchor: Extract<CommentAnchor, { kind: 'region' }>
  ): void {
    if (!isFrameSurface(surface)) return;
    const win = frameWindow(surface);
    win?.postMessage(
      {
        type: 'relic:reveal-mark',
        kind: 'region',
        rect: anchor.rect,
      } satisfies RevealMarkMessage,
      '*'
    );
  },
};
