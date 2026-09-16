/**
 * Keeping two comparison panes on the same part of the document.
 *
 * Each `.compare-pane` is its own scroll container, in both the side-by-side
 * and the swipe layout. Independently scrolled, the two stop being a
 * comparison: side by side you end up reading section 12 against section 3,
 * and under the swipe, where the panes are overlaid and clipped, the revealed
 * strip shows a different part of the document than the strip it covers.
 *
 * The mapping is proportional rather than pixel for pixel, because the two
 * sides are different documents. A version that gained a section is taller
 * than the one it is compared against, so mirroring pixels runs one pane out
 * of scroll while the other still has room, and the ends never line up.
 * Proportional keeps the top at the top and the bottom at the bottom, which
 * is the best correspondence available: the tree diff reports which nodes
 * changed, not a line-by-line alignment between the two renders, so there is
 * nothing to anchor a smarter mapping to.
 */

/** A scroll container, narrowed to what syncing actually reads and writes. */
export interface Scroller {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener(type: 'scroll', listener: () => void): void;
  removeEventListener(type: 'scroll', listener: () => void): void;
}

/** How far down its own travel a scroller sits, or null when it cannot move. */
export function scrollFraction(el: Scroller): number | null {
  const travel = el.scrollHeight - el.clientHeight;
  if (!(travel > 0)) return null;
  const clamped = Math.min(Math.max(el.scrollTop, 0), travel);
  return clamped / travel;
}

/** Put a scroller at a fraction of its own travel. A no-op when it cannot move. */
export function applyScrollFraction(el: Scroller, fraction: number): void {
  const travel = el.scrollHeight - el.clientHeight;
  if (!(travel > 0)) return;
  const bounded = Math.min(Math.max(fraction, 0), 1);
  el.scrollTop = Math.round(bounded * travel);
}

/**
 * Whether two positions are close enough to leave alone.
 *
 * Writing `scrollTop` rounds to whole pixels, and a fraction converted into
 * two differently sized panes and back does not land on the same number it
 * started from. Without a deadband each correction provokes the next one and
 * the panes creep while a reader watches.
 */
const SETTLED_PIXELS = 1;

/**
 * Bind scrollers so that scrolling any one moves the rest to the same relative
 * position. Returns a teardown that unbinds every listener.
 *
 * Reciprocal feedback is the whole difficulty: moving a follower fires its own
 * scroll event, which would drive the pane that just drove it. So one element
 * holds the wheel for the duration of a frame, events from anything else are
 * ignored while it does, and writes are coalesced to one per frame because a
 * scroll gesture fires far more often than a browser paints.
 */
export function syncScrollers(
  panes: readonly Scroller[],
  schedule: (run: () => void) => void = (run) => {
    if (
      typeof window !== 'undefined' &&
      typeof window.requestAnimationFrame === 'function'
    ) {
      window.requestAnimationFrame(run);
    } else if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }
): () => void {
  if (panes.length < 2) return () => {};

  let driver: Scroller | undefined;
  let queued = false;

  const follow = (): void => {
    queued = false;
    const leader = driver;
    if (leader === undefined) return;

    // The leader keeps the wheel until every write is done, and is released
    // only in the finally below. Clearing it first made each follower's own
    // scroll event look like a reader scrolling, which is the exact loop the
    // guard exists to stop.
    try {
      const fraction = scrollFraction(leader);
      if (fraction === null) return;
      const bounded = Math.min(Math.max(fraction, 0), 1);

      for (const pane of panes) {
        if (pane === leader) continue;
        const travel = pane.scrollHeight - pane.clientHeight;
        if (!(travel > 0)) continue;
        const target = Math.round(bounded * travel);
        // Only write a real move. An assignment that changes nothing still
        // fires a scroll event in some browsers, and the deadband is what
        // keeps a rounding difference from provoking the next correction.
        if (Math.abs(pane.scrollTop - target) > SETTLED_PIXELS) {
          pane.scrollTop = target;
        }
      }
    } finally {
      driver = undefined;
    }
  };

  const bound = panes.map((pane) => {
    const listener = (): void => {
      // A follower being moved is not a reader scrolling. Its event is the
      // echo of this frame's write.
      if (driver !== undefined && driver !== pane) return;
      driver = pane;
      if (queued) return;
      queued = true;
      schedule(follow);
    };
    pane.addEventListener('scroll', listener);
    return { pane, listener };
  });

  return () => {
    for (const { pane, listener } of bound) {
      pane.removeEventListener('scroll', listener);
    }
  };
}

/**
 * A sandboxed frame scroller that communicates through fractional scroll events
 * and commands across an opaque origin boundary.
 */
export interface FrameScroller {
  setScrollFraction(fraction: number): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/**
 * Whether two scroll fractions are close enough to leave alone.
 *
 * A difference smaller than half a thousandth is well below one pixel on any
 * practical viewport, and avoiding redundant writes keeps rounding jitter
 * from generating echo cycles across the postMessage bridge.
 */
const SETTLED_FRACTION = 0.001;

/**
 * Bind sandboxed frame scrollers so that scrolling any one moves the other
 * to the same relative position. Returns a teardown that unbinds every listener.
 *
 * Like `syncScrollers`, this maintains proportional mapping and guards against
 * reciprocal feedback. Because postMessage is asynchronous across the opaque
 * frame boundary, the feedback guard tracks both the active driver during frame
 * scheduling and the expected echo fraction sent to each follower.
 */
export function syncFrameScrollers(
  panes: readonly FrameScroller[],
  schedule: (run: () => void) => void = (run) => {
    if (
      typeof window !== 'undefined' &&
      typeof window.requestAnimationFrame === 'function'
    ) {
      window.requestAnimationFrame(run);
    } else if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }
): () => void {
  if (panes.length < 2) return () => {};

  let driver: FrameScroller | undefined;
  let latestFraction: number | null = null;
  let queued = false;
  const expectedEchoes = new Map<FrameScroller, number>();

  const follow = (): void => {
    queued = false;
    const leader = driver;
    const fraction = latestFraction;
    if (leader === undefined || fraction === null) return;

    try {
      const bounded = Math.min(Math.max(fraction, 0), 1);

      for (const pane of panes) {
        if (pane === leader) continue;
        const lastSent = expectedEchoes.get(pane);
        if (
          lastSent !== undefined &&
          Math.abs(lastSent - bounded) < SETTLED_FRACTION
        ) {
          continue;
        }
        expectedEchoes.set(pane, bounded);
        pane.setScrollFraction(bounded);
      }
    } finally {
      driver = undefined;
      latestFraction = null;
    }
  };

  const bound = panes.map((pane) => {
    const listener = (event: Event): void => {
      const frac = (event as CustomEvent<{ fraction?: number }>).detail
        ?.fraction;
      if (typeof frac !== 'number' || !Number.isFinite(frac)) return;

      // An echo from a programmatic write to this follower is not a reader gesture.
      const expected = expectedEchoes.get(pane);
      if (
        expected !== undefined &&
        Math.abs(frac - expected) < SETTLED_FRACTION * 5
      ) {
        expectedEchoes.delete(pane);
        return;
      }
      expectedEchoes.delete(pane);
      driver = pane;
      latestFraction = frac;
      if (queued) return;
      queued = true;
      schedule(follow);
    };
    pane.addEventListener('relic:frame-scroll', listener);
    return { pane, listener };
  });

  return () => {
    for (const { pane, listener } of bound) {
      pane.removeEventListener('relic:frame-scroll', listener);
    }
  };
}
