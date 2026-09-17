/**
 * A paired point of reference inside two different rendered documents.
 *
 * Proportional scroll is the honest fallback when all we know is the two page
 * heights. It is not alignment: if version two added a paragraph above the
 * changed sentence a half-page scroll puts the two sentences at different
 * screen positions. The rendered diff already pairs the changed nodes, so a
 * scroll position carries the nearest paired mark and its top inside the
 * pane's viewport. The follower puts its copy at that same top.
 *
 * This module is bundled into the shell and the network-denied usercontent
 * frame. It stays dependency-free for the same reason `rendered-tree.ts`
 * does: importing a shell entry into the frame, or the frame entry into the
 * shell, pulls the wrong runtime across the trust boundary.
 */

export interface ScrollLandmark {
  /** Assigned by one tree diff to the two nodes it paired. */
  readonly id: string;
  /** The node's top in CSS pixels relative to its scroll viewport. */
  readonly top: number;
}

export interface ScrollPosition {
  /** Fallback position for unpaired regions, bounded to zero through one. */
  readonly fraction: number;
  /** Present when a paired changed node is the nearest reference. */
  readonly landmark?: ScrollLandmark;
}

interface LandmarkRect {
  readonly top: number;
  readonly bottom: number;
}

interface LandmarkElement {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): LandmarkRect;
}

export interface LandmarkRoot {
  querySelectorAll?(selector: string): ArrayLike<LandmarkElement>;
}

const LANDMARK_ATTRIBUTE = 'data-relic-sync-id';

/**
 * Pick the paired mark nearest the viewport's top edge.
 *
 * A mark crossing the edge has distance zero. Otherwise the nearest edge wins,
 * which keeps the preceding change as the reference until the following one
 * is genuinely closer instead of jumping simply because it entered the DOM.
 */
export function nearestScrollLandmark(
  root: LandmarkRoot,
  viewportTop = 0
): ScrollLandmark | undefined {
  let best:
    | { readonly landmark: ScrollLandmark; readonly distance: number }
    | undefined;

  const nodes = root.querySelectorAll?.(`[${LANDMARK_ATTRIBUTE}]`);
  if (nodes === undefined) return undefined;
  for (const node of Array.from(nodes)) {
    const id = node.getAttribute(LANDMARK_ATTRIBUTE);
    if (id === null || id.length === 0) continue;
    const rect = node.getBoundingClientRect();
    const top = rect.top - viewportTop;
    const bottom = rect.bottom - viewportTop;
    const distance = top > 0 ? top : bottom < 0 ? -bottom : 0;
    if (
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance &&
        Math.abs(top) < Math.abs(best.landmark.top))
    ) {
      best = { landmark: { id, top }, distance };
    }
  }

  return best?.landmark;
}

/**
 * How far a follower must scroll to put its copy of a paired mark at the
 * leader's viewport position. Null means this document has no such mark, so
 * the caller must fall back to the proportional fraction.
 */
export function landmarkScrollDelta(
  root: LandmarkRoot,
  landmark: ScrollLandmark,
  viewportTop = 0
): number | null {
  const nodes = root.querySelectorAll?.(`[${LANDMARK_ATTRIBUTE}]`);
  if (nodes === undefined) return null;
  for (const node of Array.from(nodes)) {
    if (node.getAttribute(LANDMARK_ATTRIBUTE) !== landmark.id) continue;
    return node.getBoundingClientRect().top - viewportTop - landmark.top;
  }
  return null;
}
