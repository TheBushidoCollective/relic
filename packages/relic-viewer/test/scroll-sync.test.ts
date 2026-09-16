/**
 * Tests for keeping two comparison panes on the same part of the document.
 *
 * The stub dispatches a scroll event on every write to `scrollTop`, which is
 * what a browser does and what makes this worth testing: a naive mirror feeds
 * itself, and a test whose stub stays silent would pass on code that loops
 * forever in a real page.
 */

import { describe, expect, test } from 'bun:test';
import {
  applyScrollFraction,
  type Scroller,
  scrollFraction,
  syncScrollers,
} from '../src/scroll-sync.ts';

/** A scroll container that announces its own movement, as a browser does. */
class ScrollerStub implements Scroller {
  private position = 0;
  private readonly listeners: (() => void)[] = [];
  /** Every write, so a test can see thrash rather than only its outcome. */
  readonly writes: number[] = [];

  constructor(
    readonly scrollHeight: number,
    readonly clientHeight: number
  ) {}

  get scrollTop(): number {
    return this.position;
  }

  set scrollTop(next: number) {
    this.position = next;
    this.writes.push(next);
    for (const listener of [...this.listeners]) listener();
  }

  addEventListener(_type: 'scroll', listener: () => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: 'scroll', listener: () => void): void {
    const at = this.listeners.indexOf(listener);
    if (at !== -1) this.listeners.splice(at, 1);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

/** Runs scheduled work on demand, so a test decides when a frame happens. */
function manualFrames(): {
  schedule: (run: () => void) => void;
  flush: () => void;
  pending: () => number;
} {
  let queue: (() => void)[] = [];
  return {
    schedule: (run) => queue.push(run),
    flush: () => {
      const due = queue;
      queue = [];
      for (const run of due) run();
    },
    pending: () => queue.length,
  };
}

describe('scrollFraction', () => {
  test('reports position as a share of the travel available', () => {
    expect(scrollFraction(new ScrollerStub(2000, 1000))).toBe(0);
    const half = new ScrollerStub(2000, 1000);
    half.scrollTop = 500;
    expect(scrollFraction(half)).toBe(0.5);
    const end = new ScrollerStub(2000, 1000);
    end.scrollTop = 1000;
    expect(scrollFraction(end)).toBe(1);
  });

  test('a pane with nothing to scroll has no position, rather than zero', () => {
    // Zero would be a lie a caller cannot distinguish from "at the top", and
    // it would drag the other pane to the top every time it was read.
    expect(scrollFraction(new ScrollerStub(800, 800))).toBeNull();
    expect(scrollFraction(new ScrollerStub(600, 800))).toBeNull();
  });

  test('a position past either end reads as that end', () => {
    const over = new ScrollerStub(2000, 1000);
    over.scrollTop = 5000;
    expect(scrollFraction(over)).toBe(1);
    const under = new ScrollerStub(2000, 1000);
    under.scrollTop = -40;
    expect(scrollFraction(under)).toBe(0);
  });
});

describe('applyScrollFraction', () => {
  test('places a pane at a share of its own travel', () => {
    const pane = new ScrollerStub(3000, 1000);
    applyScrollFraction(pane, 0.5);
    expect(pane.scrollTop).toBe(1000);
    applyScrollFraction(pane, 1);
    expect(pane.scrollTop).toBe(2000);
  });

  test('a pane with nothing to scroll is left alone', () => {
    const pane = new ScrollerStub(500, 900);
    applyScrollFraction(pane, 0.7);
    expect(pane.writes).toEqual([]);
  });
});

describe('syncScrollers', () => {
  test('scrolling one pane moves the other to the same relative position', () => {
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(3000, 1000);
    syncScrollers([left, right], frames.schedule);

    left.scrollTop = 1500;
    frames.flush();

    // Half of the left pane's 3000 of travel, so half of the right pane's 2000.
    expect(scrollFraction(left)).toBe(0.5);
    expect(right.scrollTop).toBe(1000);
  });

  test('either pane can drive', () => {
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(3000, 1000);
    syncScrollers([left, right], frames.schedule);

    right.scrollTop = 2000;
    frames.flush();
    expect(left.scrollTop).toBe(3000);
  });

  test('the ends line up, which pixel mirroring cannot do', () => {
    // The reported case: a version that gained a section is taller than the
    // one it is compared against.
    const frames = manualFrames();
    const longer = new ScrollerStub(5000, 1000);
    const shorter = new ScrollerStub(2000, 1000);
    syncScrollers([longer, shorter], frames.schedule);

    longer.scrollTop = 4000;
    frames.flush();

    expect(scrollFraction(longer)).toBe(1);
    expect(shorter.scrollTop).toBe(1000);
    expect(scrollFraction(shorter)).toBe(1);
  });

  test('following a pane does not drive it back', () => {
    // The stub fires a scroll event on every write, so an unguarded mirror
    // ping-pongs. Each pane is written at most once for one gesture.
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(3000, 1000);
    syncScrollers([left, right], frames.schedule);

    left.scrollTop = 900;
    frames.flush();

    // The follower's own scroll event arrived during that flush. Nothing may
    // be waiting on the next frame because of it: without the guard the echo
    // schedules another pass, so a continuous gesture pays for two frames of
    // work per frame of movement.
    expect(frames.pending()).toBe(0);

    frames.flush();
    expect(right.writes).toHaveLength(1);
    expect(left.writes).toEqual([900]);
  });

  test('a burst of scroll events costs one write per pane, not one per event', () => {
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(3000, 1000);
    syncScrollers([left, right], frames.schedule);

    // A real gesture fires far more often than the browser paints.
    for (const top of [100, 200, 300, 400, 500]) left.scrollTop = top;
    expect(frames.pending()).toBe(1);
    frames.flush();

    expect(right.writes).toHaveLength(1);
    // The last position wins, not the first.
    expect(right.scrollTop).toBe(Math.round((500 / 3000) * 2000));
  });

  test('a pane already at the target is not written at all', () => {
    // Two versions of similar length put the follower where it already is.
    // Writing anyway fires a scroll event for no movement, which is work per
    // frame that buys nothing and is one rounding error away from a loop.
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(4000, 1000);
    syncScrollers([left, right], frames.schedule);

    right.scrollTop = 1500;
    frames.flush();
    const writesBefore = right.writes.length;

    left.scrollTop = 1500;
    frames.flush();

    expect(right.writes).toHaveLength(writesBefore);
    expect(right.scrollTop).toBe(1500);
  });

  test('a pane that cannot scroll is skipped rather than reset', () => {
    const frames = manualFrames();
    const tall = new ScrollerStub(4000, 1000);
    const flat = new ScrollerStub(700, 1000);
    syncScrollers([tall, flat], frames.schedule);

    tall.scrollTop = 1500;
    frames.flush();

    expect(flat.writes).toEqual([]);
  });

  test('teardown unbinds every listener', () => {
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(3000, 1000);
    const stop = syncScrollers([left, right], manualFrames().schedule);

    expect(left.listenerCount).toBe(1);
    expect(right.listenerCount).toBe(1);

    stop();
    expect(left.listenerCount).toBe(0);
    expect(right.listenerCount).toBe(0);
  });

  test('a single pane binds nothing, so a one-sided view costs no listener', () => {
    const only = new ScrollerStub(4000, 1000);
    syncScrollers([only], manualFrames().schedule);
    expect(only.listenerCount).toBe(0);
  });
});
