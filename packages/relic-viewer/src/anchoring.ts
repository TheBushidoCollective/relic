/**
 * How a comment's anchor becomes something a reader can see and aim.
 *
 * `@relic/format` settles what an anchor *is* on the wire. This settles what
 * the page does with one, and it exists as a registry rather than a switch
 * for a reason that is structural rather than stylistic.
 *
 * Four separate places used to branch on the anchor kind: the chip that says
 * what the next comment is about, the provisional mark, the posted marks, and
 * the controls that capture a target. A fifth kind meant editing four
 * switches, and every surface that wanted one was editing the same 3,000-line
 * module. With five kinds arriving at once that is not a style problem, it is
 * a merge that cannot be done safely.
 *
 * So each kind owns one adapter and the four call sites consult the table.
 * Adding a kind is a new file plus one row.
 *
 * ## The coordinate rule
 *
 * Geometry is measured against the annotated element's own content box, never
 * the stage. The existing `pin` is stage-relative and it is kept that way
 * because it is already stored that way; everything new uses the content box.
 * The difference is not cosmetic: an image is letterboxed inside the stage,
 * so the same unit point lands on a different part of the picture at a
 * different viewport width, which moves a mark off the thing it was placed on
 * between the writer's screen and the reader's.
 */

import type { AnchorRect, CommentAnchor } from '@relic/format';

/**
 * The element an anchor is measured against, and the box it occupies inside
 * its host.
 *
 * `content` is the artifact itself: the `img`, the `video`, the page canvas,
 * the frame. `host` is the element marks are painted into, which is the
 * stage. They differ whenever the artifact does not fill the stage, which is
 * most of the time and is exactly the case the content-box rule exists for.
 */
export interface AnchorSurface {
  readonly host: HTMLElement;
  readonly content: HTMLElement;
}

/** A rectangle in host pixels, ready to be written onto an overlay's style. */
export interface PaintedBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the content box sits inside the host's scrollable content.
 *
 * Content coordinates, not viewport ones, for the reason the existing bubble
 * placement already documents: the stage scrolls its own children, so an
 * offset measured against the visible box is wrong the moment the reader
 * scrolls.
 */
export function contentOffset(surface: AnchorSurface): PaintedBox {
  const host = surface.host.getBoundingClientRect();
  const content = surface.content.getBoundingClientRect();
  return {
    left: content.left - host.left + surface.host.scrollLeft,
    top: content.top - host.top + surface.host.scrollTop,
    width: content.width,
    height: content.height,
  };
}

/**
 * A unit rectangle on the content box, in host pixels.
 *
 * Returns `undefined` when the content box has no area, which happens for a
 * real reason rather than as a defensive shrug: an image that has not loaded,
 * a video before metadata, a frame mid-navigation. Painting into a zero box
 * would put the mark at the host's origin, which reads as a mark on the wrong
 * thing rather than as a mark that is not ready.
 */
export function boxFromUnit(
  surface: AnchorSurface,
  rect: AnchorRect
): PaintedBox | undefined {
  const box = contentOffset(surface);
  if (box.width === 0 || box.height === 0) return undefined;
  return {
    left: box.left + rect.x * box.width,
    top: box.top + rect.y * box.height,
    width: rect.w * box.width,
    height: rect.h * box.height,
  };
}

/**
 * A pointer position as a unit point on the content box.
 *
 * `undefined` when the pointer is outside the content box, which is the case
 * that matters: a drag that starts on the image and ends on the letterbox
 * beside it must not silently clamp to the edge and claim the reader pointed
 * there.
 */
export function unitFromPointer(
  surface: AnchorSurface,
  clientX: number,
  clientY: number
): { readonly x: number; readonly y: number } | undefined {
  const content = surface.content.getBoundingClientRect();
  if (content.width === 0 || content.height === 0) return undefined;
  const x = (clientX - content.left) / content.width;
  const y = (clientY - content.top) / content.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
  return { x, y };
}

/**
 * Two unit points as a normalised rectangle.
 *
 * A drag has no guaranteed direction, so the corners are sorted rather than
 * assumed. `undefined` for a rectangle with no area, which is a click that
 * did not become a drag and belongs to whatever handles clicks, not here.
 */
export function rectFromCorners(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  minimum = 0.005
): AnchorRect | undefined {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  const w = Math.abs(to.x - from.x);
  const h = Math.abs(to.y - from.y);
  if (w < minimum || h < minimum) return undefined;
  // Clamped so the stored rectangle cannot overhang the edge, which the
  // format refuses. Clamping here rather than refusing keeps a drag that ran
  // one pixel past the corner from being thrown away.
  return {
    x,
    y,
    w: Math.min(w, 1 - x),
    h: Math.min(h, 1 - y),
  };
}

/**
 * What one anchor kind needs in order to exist on the page.
 *
 * Capture is deliberately not here. Capture is a gesture on a particular kind
 * of artifact, it needs listeners with a lifetime, and it differs far more
 * between kinds than display does; it lives with the controls. This interface
 * is the display and navigation half, which is what the four branching call
 * sites actually needed.
 */
export interface AnchorAdapter<K extends CommentAnchor['kind']> {
  readonly kind: K;

  /**
   * What the composer's chip says the next comment is about.
   *
   * Display only. Whatever the anchor stores stays exact, because the stored
   * value is what a later paint is matched against.
   */
  label(anchor: Extract<CommentAnchor, { kind: K }>): string;

  /**
   * Put the mark on the artifact.
   *
   * Returns whether it landed. `false` is a real answer and not a failure to
   * report: a quote that is no longer in the document because the relic was
   * republished has no place to be painted, and the thread must still show
   * the comment. A caller uses this to say the mark could not be placed
   * rather than to hide the comment.
   */
  paint(
    surface: AnchorSurface,
    overlay: HTMLElement,
    anchor: Extract<CommentAnchor, { kind: K }>,
    commentId: string
  ): boolean;

  /**
   * Bring the marked thing into view when its comment is activated.
   *
   * Scrolling for a quote, seeking for a moment, turning the page for a page.
   * Optional: a kind whose mark is always already in view has nothing to do.
   */
  reveal?(
    surface: AnchorSurface,
    anchor: Extract<CommentAnchor, { kind: K }>
  ): void;

  /**
   * Whether this artifact can carry this kind at all.
   *
   * The test is what is actually on the page, never the renderer class. A
   * `jsx` relic whose bytes do not compile renders as source, and a rule
   * shaped like a class would take marks away from a reader who is looking at
   * selectable text.
   */
  supports(surface: AnchorSurface): boolean;
}

/**
 * Any adapter, for the table's value type.
 *
 * The table is heterogeneous by construction. Each entry is sound against its
 * own kind, and `adapterFor` is the only way in, so the widening stops at the
 * table boundary rather than spreading to call sites.
 */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry; see above
export type SomeAnchorAdapter = AnchorAdapter<any>;

const adapters = new Map<string, SomeAnchorAdapter>();

/**
 * Register one kind's adapter.
 *
 * Re-registering the same kind is refused rather than allowed to win,
 * because two adapters for one kind is a merge that went wrong and the
 * symptom of letting it through is marks that paint differently depending on
 * module load order.
 */
export function registerAnchorAdapter(adapter: SomeAnchorAdapter): void {
  if (adapters.has(adapter.kind)) {
    throw new Error(
      `anchor adapter for "${adapter.kind}" is already registered`
    );
  }
  adapters.set(adapter.kind, adapter);
}

export function adapterFor(
  anchor: CommentAnchor
): SomeAnchorAdapter | undefined {
  return adapters.get(anchor.kind);
}

/** Every registered kind, for the controls to offer and for tests to assert. */
export function registeredAnchorKinds(): readonly string[] {
  return [...adapters.keys()].sort();
}

/** Test seam. Never called by the page. */
export function resetAnchorAdapters(): void {
  adapters.clear();
}

/**
 * What a reader is told about a mark this build cannot place.
 *
 * Two distinct cases share one sentence on purpose, because the reader's
 * situation is the same in both: the comment is real, its body is readable,
 * and the thing it points at is not reachable from here. Naming which case
 * it is would be telling them about the version of a bundle.
 */
export const MARK_UNPLACEABLE_NOTE =
  'This comment points at part of the document that this page cannot show.';

/**
 * The chip's wording for an anchor whose kind arrived from a newer writer.
 *
 * Stated as a gap in this page rather than as a defect in the comment,
 * because that is what it is.
 */
export const UNSUPPORTED_ANCHOR_LABEL =
  'Commenting on something this page cannot show';
