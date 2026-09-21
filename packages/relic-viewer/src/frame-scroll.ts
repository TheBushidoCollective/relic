/**
 * The two messages the shell and a sandboxed frame exchange to scroll
 * together, and nothing else.
 *
 * This is its own module because of what the two ends are. `sandbox.ts` runs
 * on the usercontent origin and bundles React and ReactDOM, since an opaque
 * origin cannot fetch even same-origin assets. `main.ts` is the shell, which
 * every reader of every relic downloads. Declaring this contract in
 * `sandbox.ts` and importing it from the shell pulled that whole bundle
 * across the boundary: the shell went from 378,473 bytes to 586,497, and the
 * 208 KB it gained was React arriving where no relic needs it.
 *
 * So the contract lives here, where both ends can import it and neither end
 * drags the other in. Same reason `sw-cache.ts` exists.
 *
 * A position keeps the proportional fraction as its fallback and may carry a
 * paired changed node as the exact reference. Different document heights make
 * fraction better than pixels at the ends; different content above a change
 * makes the paired node better where it exists.
 */

import type { ScrollLandmark, ScrollPosition } from './scroll-landmark.ts';

/** Shell to frame: put yourself at this paired mark, or at the fallback fraction. */
export interface SetScrollMessage extends ScrollPosition {
  readonly type: 'relic:set-scroll';
}

/** Frame to shell: this is what the reader currently has at the top. */
export interface FrameScrollMessage extends ScrollPosition {
  readonly type: 'relic:frame-scroll';
}

/**
 * Both guards refuse a non-finite fraction rather than passing it on. A NaN
 * reaching `scrollTop` is silently ignored by the DOM, which would leave a
 * pane stuck with no error anywhere.
 */
function isLandmark(value: unknown): value is ScrollLandmark {
  if (typeof value !== 'object' || value === null) return false;
  const mark = value as Record<string, unknown>;
  return (
    typeof mark['id'] === 'string' &&
    // Both namespaces the diff mints: `d` for a changed pair, `a` for
    // matched content. Accepting only changed pairs silently dropped every
    // message carrying an anchor, which is most of them once unchanged
    // content became something the panes can align on, and the follower
    // then sat still while the leader scrolled.
    /^[da][0-9]+$/.test(mark['id']) &&
    typeof mark['top'] === 'number' &&
    Number.isFinite(mark['top'])
  );
}

function isFractionMessage(data: unknown, type: string): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Record<string, unknown>;
  if (message['type'] !== type) return false;
  if (
    typeof message['fraction'] !== 'number' ||
    !Number.isFinite(message['fraction'])
  ) {
    return false;
  }
  const landmark = message['landmark'];
  return landmark === undefined || isLandmark(landmark);
}

export function isSetScrollMessage(data: unknown): data is SetScrollMessage {
  return isFractionMessage(data, 'relic:set-scroll');
}

export function isFrameScrollMessage(
  data: unknown
): data is FrameScrollMessage {
  return isFractionMessage(data, 'relic:frame-scroll');
}
