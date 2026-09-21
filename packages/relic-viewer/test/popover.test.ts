/**
 * Where a panel lands, and what it offers when it gets there.
 *
 * The placement half is arithmetic and is asserted directly, because a panel
 * that sits over the sentence it is about, or off the clipped edge of the
 * stage, is the defect this module exists to prevent and a browser is a slow
 * way to find it. The look of the thing is proven in a browser, which is the
 * only place it can be.
 */

import { describe, expect, test } from 'bun:test';
import {
  anchorFromClientRect,
  OFFER_QUOTE_LIMIT,
  POPOVER_GAP,
  POPOVER_MARGIN,
  placePopover,
  shortQuote,
} from '../src/popover.ts';

const HOST = {
  scrollLeft: 0,
  scrollTop: 0,
  clientWidth: 800,
  clientHeight: 600,
};

const SIZE = { width: 320, height: 160 };

describe('where the panel lands', () => {
  test('above the anchor when there is room, clear of it', () => {
    const placed = placePopover(
      { left: 200, top: 300, width: 120, height: 20 },
      SIZE,
      HOST
    );
    expect(placed.side).toBe('above');
    expect(placed.top).toBe(300 - POPOVER_GAP - SIZE.height);
  });

  test('below when the anchor is near the top, so the head stays visible', () => {
    const placed = placePopover(
      { left: 200, top: 12, width: 120, height: 20 },
      SIZE,
      HOST
    );
    expect(placed.side).toBe('below');
    expect(placed.top).toBe(12 + 20 + POPOVER_GAP);
  });

  test('centred on the anchor', () => {
    const placed = placePopover(
      { left: 200, top: 300, width: 120, height: 20 },
      SIZE,
      HOST
    );
    expect(placed.left).toBe(200 + 60 - 160);
  });

  test('clamped inside the left edge rather than into the clipped overflow', () => {
    const placed = placePopover(
      { left: 0, top: 300, width: 40, height: 20 },
      SIZE,
      HOST
    );
    expect(placed.left).toBe(POPOVER_MARGIN);
  });

  test('clamped inside the right edge', () => {
    const placed = placePopover(
      { left: 780, top: 300, width: 20, height: 20 },
      SIZE,
      HOST
    );
    expect(placed.left).toBe(800 - SIZE.width - POPOVER_MARGIN);
  });

  test('the scroll offset moves the visible box, not just the anchor', () => {
    const scrolled = { ...HOST, scrollTop: 1_000, scrollLeft: 0 };
    const placed = placePopover(
      { left: 200, top: 1_300, width: 120, height: 20 },
      SIZE,
      scrolled
    );
    expect(placed.side).toBe('above');
    expect(placed.top).toBe(1_300 - POPOVER_GAP - SIZE.height);
  });

  test('an anchor scrolled to the top of the visible box goes below', () => {
    const scrolled = { ...HOST, scrollTop: 1_000 };
    const placed = placePopover(
      { left: 200, top: 1_004, width: 120, height: 20 },
      SIZE,
      scrolled
    );
    expect(placed.side).toBe('below');
  });

  test('a panel taller than the stage still shows its own top', () => {
    const tall = { width: 320, height: 900 };
    const placed = placePopover(
      { left: 200, top: 300, width: 120, height: 20 },
      tall,
      HOST
    );
    expect(placed.top).toBe(POPOVER_MARGIN);
  });

  test('a panel wider than the stage is pinned to the left margin', () => {
    const wide = { width: 900, height: 160 };
    const placed = placePopover(
      { left: 200, top: 300, width: 120, height: 20 },
      wide,
      HOST
    );
    expect(placed.left).toBe(POPOVER_MARGIN);
  });
});

describe('the conversion every call site would otherwise get wrong', () => {
  test('a viewport rect becomes content coordinates', () => {
    const anchor = anchorFromClientRect(
      { left: 300, top: 200, width: 80, height: 18 },
      { left: 100, top: 60 },
      { scrollLeft: 0, scrollTop: 420 }
    );
    expect(anchor).toEqual({ left: 200, top: 560, width: 80, height: 18 });
  });

  test('a host scrolled sideways is carried too', () => {
    const anchor = anchorFromClientRect(
      { left: 300, top: 200, width: 80, height: 18 },
      { left: 100, top: 60 },
      { scrollLeft: 50, scrollTop: 0 }
    );
    expect(anchor.left).toBe(250);
  });
});

describe('naming the selection back to the reader', () => {
  test('a short selection is quoted whole', () => {
    expect(shortQuote('the offer')).toBe('the offer');
  });

  test('a long one is cut and marked as cut', () => {
    const quoted = shortQuote('x'.repeat(OFFER_QUOTE_LIMIT + 20));
    expect(quoted.endsWith('\u2026')).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(OFFER_QUOTE_LIMIT + 1);
  });

  test('newlines inside a selection collapse, because a label is one line', () => {
    expect(shortQuote('two\n\nlines')).toBe('two lines');
  });
});
