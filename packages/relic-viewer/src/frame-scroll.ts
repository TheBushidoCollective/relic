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
 * The fraction is a position along the scrollable range rather than a pixel
 * offset, because the two documents being compared have different heights and
 * a pixel offset would read section 12 against section 3.
 */

/** Shell to frame: put yourself at this fraction of your scroll range. */
export interface SetScrollMessage {
  readonly type: 'relic:set-scroll';
  readonly fraction: number;
}

/** Frame to shell: a reader scrolled me to this fraction. */
export interface FrameScrollMessage {
  readonly type: 'relic:frame-scroll';
  readonly fraction: number;
}

/**
 * Both guards refuse a non-finite fraction rather than passing it on. A NaN
 * reaching `scrollTop` is silently ignored by the DOM, which would leave a
 * pane stuck with no error anywhere.
 */
function isFractionMessage(data: unknown, type: string): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    'fraction' in data &&
    (data as { type: unknown }).type === type &&
    typeof (data as { fraction: unknown }).fraction === 'number' &&
    Number.isFinite((data as { fraction: number }).fraction)
  );
}

export function isSetScrollMessage(data: unknown): data is SetScrollMessage {
  return isFractionMessage(data, 'relic:set-scroll');
}

export function isFrameScrollMessage(
  data: unknown
): data is FrameScrollMessage {
  return isFractionMessage(data, 'relic:frame-scroll');
}
