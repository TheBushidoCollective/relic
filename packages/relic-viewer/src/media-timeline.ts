/**
 * The arithmetic behind a comment-bearing scrubber, with no DOM in it.
 *
 * A time anchor is `{ t, t_end?, rect? }` and that shape is frozen, so
 * everything here converts between three representations of the same thing:
 * seconds on the media clock, a fraction of the track's width, and a pixel
 * offset inside a track of a given width. Keeping the conversions in one place
 * is the point: the hover indicator, the markers, the span highlight and the
 * keyboard stepping all have to agree about where a second sits, and three of
 * them disagreeing by a pixel is how a comment lands on the wrong frame.
 */

/** A comment's position on the timeline, in seconds. */
export interface TimeSpan {
  readonly t: number;
  readonly t_end?: number | undefined;
}

/** One thing to draw on the track. A moment is a span of zero length. */
export interface TimelineMarker {
  readonly commentId: string;
  readonly t: number;
  readonly t_end?: number | undefined;
  /** Left edge as a fraction of the track, 0 to 1. */
  readonly start: number;
  /** Width as a fraction of the track. Zero for a moment. */
  readonly width: number;
}

/** Markers close enough to overlap, drawn as one thing that says how many. */
export interface MarkerCluster {
  readonly members: readonly TimelineMarker[];
  /** Where the cluster sits, as a fraction of the track. */
  readonly start: number;
  readonly width: number;
}

/**
 * Seconds to a fraction of the track.
 *
 * A duration that is zero, negative, or not yet known (a media element reports
 * `NaN` before metadata loads) has no meaningful fraction, and callers must not
 * be handed 0, which is indistinguishable from the start of the clip.
 */
export function timeToFraction(
  t: number,
  duration: number
): number | undefined {
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  if (!Number.isFinite(t)) return undefined;
  return Math.min(Math.max(t / duration, 0), 1);
}

/** A fraction of the track back to seconds, clamped inside the clip. */
export function fractionToTime(fraction: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const bounded = Math.min(Math.max(fraction, 0), 1);
  return Math.round(bounded * duration * 1000) / 1000;
}

/**
 * Where a pointer landed, as a fraction of the track.
 *
 * `clientX` and the track's own box arrive from the DOM; the arithmetic is
 * here so it can be tested without one. A zero-width track yields 0 rather
 * than a division by zero.
 */
export function pointerFraction(
  clientX: number,
  trackLeft: number,
  trackWidth: number
): number {
  if (!(trackWidth > 0)) return 0;
  return Math.min(Math.max((clientX - trackLeft) / trackWidth, 0), 1);
}

/**
 * Build a span from a press and a release.
 *
 * Direction does not matter: dragging right to left names the same span as
 * left to right, because a reader dragging backwards over a passage means the
 * passage. A drag shorter than `minimumSpanSeconds` is a moment, not a
 * hair-thin span, which is what makes one gesture serve both: click for a
 * frame, drag for a passage.
 */
export function spanFromDrag(
  fromSeconds: number,
  toSeconds: number,
  minimumSpanSeconds = 0.2
): TimeSpan {
  const start = Math.round(Math.min(fromSeconds, toSeconds) * 1000) / 1000;
  const end = Math.round(Math.max(fromSeconds, toSeconds) * 1000) / 1000;
  if (end - start < minimumSpanSeconds) return { t: start };
  return { t: start, t_end: end };
}

/** How far one keyboard step moves an edge. Shift is the coarse step. */
export const STEP_SECONDS = 0.1;
export const COARSE_STEP_SECONDS = 1;

/**
 * Move a span's end by one step, keeping it after the start.
 *
 * Stepping the end back onto the start collapses the span into the moment it
 * started as, which is how Escape-free keyboard editing gets back to a single
 * frame without a second control.
 */
export function stepSpanEnd(
  span: TimeSpan,
  direction: -1 | 1,
  duration: number,
  coarse = false
): TimeSpan {
  const start = Math.round(span.t * 1000) / 1000;
  const current = Math.round((span.t_end ?? span.t) * 1000) / 1000;
  const step = (coarse ? COARSE_STEP_SECONDS : STEP_SECONDS) * direction;
  const next =
    Math.round(
      Math.min(Math.max(current + step, 0), Math.max(duration, 0)) * 1000
    ) / 1000;
  if (next - start < STEP_SECONDS / 2) return { t: start };
  return { t: start, t_end: next };
}

/** Lay one anchor out on a track of known duration. */
export function markerFor(
  commentId: string,
  anchor: TimeSpan,
  duration: number
): TimelineMarker | undefined {
  const start = timeToFraction(anchor.t, duration);
  if (start === undefined) return undefined;
  const end =
    anchor.t_end === undefined
      ? undefined
      : timeToFraction(anchor.t_end, duration);
  const width = end === undefined ? 0 : Math.max(end - start, 0);
  return {
    commentId,
    t: anchor.t,
    ...(anchor.t_end !== undefined ? { t_end: anchor.t_end } : {}),
    start,
    width,
  };
}

/**
 * Group markers that would overlap on a track of a given pixel width.
 *
 * Two comments on the same beat are common, and drawn raw they stack into one
 * unreadable tick that a reader cannot aim at. Clustering is done against
 * pixels rather than seconds because that is what decides whether they
 * actually collide: the same two seconds are distinct on a wide track and the
 * same tick on a narrow one.
 */
export function clusterMarkers(
  markers: readonly TimelineMarker[],
  trackWidthPx: number,
  minimumGapPx = 10
): readonly MarkerCluster[] {
  if (markers.length === 0) return [];
  const ordered = [...markers].sort(
    (a, b) => a.start - b.start || a.commentId.localeCompare(b.commentId)
  );
  const gap = trackWidthPx > 0 ? minimumGapPx / trackWidthPx : 0;

  const clusters: MarkerCluster[] = [];
  let members: TimelineMarker[] = [];
  let start = 0;
  let end = 0;

  const flush = (): void => {
    if (members.length === 0) return;
    clusters.push({ members, start, width: Math.max(end - start, 0) });
    members = [];
  };

  for (const marker of ordered) {
    const markerEnd = marker.start + marker.width;
    if (members.length === 0) {
      members = [marker];
      start = marker.start;
      end = markerEnd;
      continue;
    }
    // A marker joins the cluster when it begins before the cluster's end plus
    // the collision gap, so a span swallows the ticks that sit inside it.
    if (marker.start <= end + gap) {
      members.push(marker);
      end = Math.max(end, markerEnd);
      continue;
    }
    flush();
    members = [marker];
    start = marker.start;
    end = markerEnd;
  }
  flush();
  return clusters;
}

/**
 * The marker a reader is pointing at, or nothing.
 *
 * A moment has no width, so it cannot be hit by an exact comparison. The
 * tolerance is in pixels for the same reason clustering is: it is a question
 * about the pointer, not about the clip.
 */
export function markerAtFraction(
  clusters: readonly MarkerCluster[],
  fraction: number,
  trackWidthPx: number,
  tolerancePx = 6
): MarkerCluster | undefined {
  const tolerance = trackWidthPx > 0 ? tolerancePx / trackWidthPx : 0;
  let best: MarkerCluster | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const cluster of clusters) {
    const end = cluster.start + cluster.width;
    const distance =
      fraction < cluster.start
        ? cluster.start - fraction
        : fraction > end
          ? fraction - end
          : 0;
    if (distance <= tolerance && distance < bestDistance) {
      best = cluster;
      bestDistance = distance;
    }
  }
  return best;
}
