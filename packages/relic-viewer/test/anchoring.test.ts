/**
 * The geometry every region-shaped anchor is built on, and the registry the
 * four branching call sites consult.
 *
 * These are asserted here rather than inside each adapter because a defect in
 * them is a defect in all five kinds at once, and because the one that
 * matters is invisible in a screenshot: a mark placed correctly on a wide
 * screen landing beside the thing it marks on a narrow one.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  type AnchorSurface,
  adapterFor,
  boxFromUnit,
  contentOffset,
  rectFromCorners,
  registerAnchorAdapter,
  registeredAnchorKinds,
  resetAnchorAdapters,
  unitFromPointer,
} from '../src/anchoring.ts';

/**
 * A host and a content element with stated boxes.
 *
 * Real `getBoundingClientRect` values, because the whole point of the
 * content-box rule is the relationship between two boxes, and stubbing one of
 * them away would remove the thing under test.
 */
function surface(
  host: { left: number; top: number; width: number; height: number },
  content: { left: number; top: number; width: number; height: number },
  scroll: { left: number; top: number } = { left: 0, top: 0 }
): AnchorSurface {
  const box = (r: typeof host) =>
    ({
      left: r.left,
      top: r.top,
      right: r.left + r.width,
      bottom: r.top + r.height,
      width: r.width,
      height: r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;

  return {
    host: {
      getBoundingClientRect: () => box(host),
      scrollLeft: scroll.left,
      scrollTop: scroll.top,
    } as unknown as HTMLElement,
    content: {
      getBoundingClientRect: () => box(content),
    } as unknown as HTMLElement,
  };
}

describe('the content box', () => {
  test('is measured against the host content, not the viewport', () => {
    // The stage scrolls its own children, so a mark placed while scrolled
    // down must not move when the reader scrolls back up.
    const scrolled = surface(
      { left: 0, top: -400, width: 1000, height: 800 },
      { left: 100, top: -300, width: 800, height: 600 },
      { left: 0, top: 400 }
    );

    expect(contentOffset(scrolled)).toEqual({
      left: 100,
      top: 500,
      width: 800,
      height: 600,
    });
  });

  test('a letterboxed image resolves the same unit point to the same pixel of the picture at two widths', () => {
    // This is the defect the content-box rule exists for, stated as a test.
    // A stage-relative anchor would put these two somewhere different.
    const wide = surface(
      { left: 0, top: 0, width: 1200, height: 800 },
      { left: 300, top: 0, width: 600, height: 800 }
    );
    const narrow = surface(
      { left: 0, top: 0, width: 400, height: 800 },
      { left: 50, top: 250, width: 300, height: 400 }
    );

    const rect = { x: 0.5, y: 0.25, w: 0.1, h: 0.1 };
    const onWide = boxFromUnit(wide, rect);
    const onNarrow = boxFromUnit(narrow, rect);

    // Same fraction of the picture in both, which is the guarantee.
    expect(onWide).toEqual({ left: 600, top: 200, width: 60, height: 80 });
    expect(onNarrow).toEqual({ left: 200, top: 350, width: 30, height: 40 });

    const fractionOf = (
      painted: NonNullable<typeof onWide>,
      s: AnchorSurface
    ) => {
      const box = contentOffset(s);
      return {
        x: (painted.left - box.left) / box.width,
        y: (painted.top - box.top) / box.height,
      };
    };
    expect(fractionOf(onWide as never, wide)).toEqual(
      fractionOf(onNarrow as never, narrow)
    );
  });

  test('a content box with no area paints nothing rather than at the origin', () => {
    // An image that has not loaded. Painting at the host origin would read as
    // a mark on the wrong thing instead of a mark that is not ready.
    const unloaded = surface(
      { left: 0, top: 0, width: 800, height: 600 },
      { left: 0, top: 0, width: 0, height: 0 }
    );
    expect(
      boxFromUnit(unloaded, { x: 0.2, y: 0.2, w: 0.1, h: 0.1 })
    ).toBeUndefined();
  });
});

describe('a pointer on the content', () => {
  const stage = surface(
    { left: 0, top: 0, width: 1000, height: 800 },
    { left: 200, top: 100, width: 600, height: 400 }
  );

  test('becomes a unit point on the picture', () => {
    expect(unitFromPointer(stage, 500, 300)).toEqual({ x: 0.5, y: 0.5 });
  });

  test('outside the picture is nothing, never clamped to an edge', () => {
    // In the letterbox beside the image. Clamping would claim the reader
    // pointed at the edge of the picture, which they did not.
    expect(unitFromPointer(stage, 100, 300)).toBeUndefined();
    expect(unitFromPointer(stage, 500, 60)).toBeUndefined();
    expect(unitFromPointer(stage, 900, 300)).toBeUndefined();
  });
});

describe('a drag', () => {
  test('normalises its corners, so direction does not matter', () => {
    const forward = rectFromCorners({ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.7 });
    const backward = rectFromCorners({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 });
    expect(forward?.x).toBeCloseTo(0.2, 6);
    expect(forward?.y).toBeCloseTo(0.3, 6);
    expect(forward?.w).toBeCloseTo(0.4, 6);
    expect(forward?.h).toBeCloseTo(0.4, 6);
    expect(backward).toEqual(forward);
  });

  test('that did not move is not a region', () => {
    // A click. It belongs to whatever handles clicks, and a zero-area
    // rectangle is refused by the format anyway.
    expect(
      rectFromCorners({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })
    ).toBeUndefined();
    expect(
      rectFromCorners({ x: 0.5, y: 0.5 }, { x: 0.502, y: 0.9 })
    ).toBeUndefined();
  });

  test('is clamped inside the unit square rather than thrown away', () => {
    // A drag that ran a pixel past the corner is still what the reader meant.
    const rect = rectFromCorners({ x: 0.7, y: 0.7 }, { x: 1, y: 1 });
    expect(rect).toBeDefined();
    const box = rect as NonNullable<typeof rect>;
    expect(box.x + box.w).toBeLessThanOrEqual(1);
    expect(box.y + box.h).toBeLessThanOrEqual(1);
  });
});

describe('the adapter registry', () => {
  afterEach(() => resetAnchorAdapters());

  const stub = (kind: string) => ({
    kind,
    label: () => `on a ${kind}`,
    paint: () => true,
    supports: () => true,
  });

  test('finds an adapter by the anchor it is handed', () => {
    registerAnchorAdapter(stub('region') as never);
    const found = adapterFor({
      kind: 'region',
      rect: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(found?.kind).toBe('region');
  });

  test('a kind with no adapter is absent rather than an error', () => {
    // The forward-tolerance case reaching the page: the comment is shown and
    // the mark is reported as unplaceable.
    expect(
      adapterFor({ kind: 'unsupported', declared: 'cell' })
    ).toBeUndefined();
  });

  test('registering one kind twice is refused', () => {
    // Two adapters for one kind is a merge that went wrong, and letting the
    // second win makes marks depend on module load order.
    registerAnchorAdapter(stub('time') as never);
    expect(() => registerAnchorAdapter(stub('time') as never)).toThrow(
      /already registered/
    );
  });

  test('reports its kinds in a stable order', () => {
    registerAnchorAdapter(stub('time') as never);
    registerAnchorAdapter(stub('page') as never);
    registerAnchorAdapter(stub('quote') as never);
    expect(registeredAnchorKinds()).toEqual(['page', 'quote', 'time']);
  });
});
