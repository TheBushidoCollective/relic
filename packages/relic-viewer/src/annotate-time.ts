/**
 * Time-based comment anchoring for video and audio relics.
 *
 * A time mark lives on a timeline rather than on the picture, because the
 * moment or span it points at is not on screen most of the time. This adapter
 * renders a marker strip beneath the media element with proportional marks
 * and spans, and optionally renders a bounding box over the video frame when
 * the playhead is positioned within the anchor's time window.
 */

import type { CommentAnchor } from '@relic/format';
import {
  type AnchorAdapter,
  type AnchorSurface,
  boxFromUnit,
  contentOffset,
} from './anchoring.ts';

/**
 * Formats a duration in seconds into a human-readable timecode string.
 *
 * For durations under an hour, the format is m:ss (for example 1:23).
 * For durations of an hour or more, the format is h:mm:ss (for example 1:01:05).
 * Fractional seconds are floored because a reader reading a timecode needs
 * the second containing the frame, not floating-point noise.
 */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const totalSeconds = Math.floor(seconds);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * What the composer chip says when anchored to a time moment or span.
 *
 * A time anchor's number is its meaning: unlike text quotes where context
 * is needed, a reader needs to know the exact timecode or range being discussed.
 */
export function timeTargetLabel(
  anchor: Extract<CommentAnchor, { kind: 'time' }>
): string {
  const start = formatTimecode(anchor.t);
  if (anchor.t_end !== undefined) {
    const end = formatTimecode(anchor.t_end);
    return `Commenting at ${start} to ${end}`;
  }
  return `Commenting at ${start}`;
}

/**
 * Checks whether an element is an HTML video or audio element.
 *
 * Checks both instanceof HTMLMediaElement when running in a real browser
 * and tagName when running against test stubs in Bun.
 */
export function isMediaElement(element: unknown): element is HTMLMediaElement {
  if (
    typeof HTMLMediaElement !== 'undefined' &&
    element instanceof HTMLMediaElement
  ) {
    return true;
  }
  if (element && typeof element === 'object' && 'tagName' in element) {
    const tagValue = element.tagName;
    if (typeof tagValue === 'string') {
      const tag = tagValue.toUpperCase();
      return tag === 'VIDEO' || tag === 'AUDIO';
    }
  }
  return false;
}

/**
 * Checks whether the media element's playhead is inside an anchor's time window.
 *
 * For a span, the window is [t, t_end] with a small tolerance for playback ticks.
 * For a single moment without an end time, the tolerance is a small fraction of a second
 * around t so the box remains visible while paused on or scrubbing past that frame.
 */
export function isTimeInWindow(
  currentTime: number,
  anchor: { readonly t: number; readonly t_end?: number },
  singleFrameTolerance = 0.25
): boolean {
  if (anchor.t_end !== undefined) {
    return currentTime >= anchor.t - 0.05 && currentTime <= anchor.t_end + 0.05;
  }
  return Math.abs(currentTime - anchor.t) <= singleFrameTolerance;
}

/**
 * Calculates a marker's relative position along the track (0.0 to 1.0).
 *
 * Clamps to 1.0 so a timestamp extending past the media duration never
 * paints off the end of the timeline strip.
 */
export function markerPosition(t: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(1, t / duration));
}

/**
 * Pending repaints for media elements whose metadata had not loaded yet
 * when paint was first called.
 *
 * Stored in a WeakMap keyed by the media element so listeners and DOM nodes
 * are garbage collected automatically when the media element is removed.
 */
interface PendingMediaRepaint {
  readonly cleanup: () => void;
  entries: Array<{
    surface: AnchorSurface;
    overlay: HTMLElement;
    anchor: Extract<CommentAnchor, { kind: 'time' }>;
    commentId: string;
  }>;
}

const pendingRepaints = new WeakMap<HTMLMediaElement, PendingMediaRepaint>();

/**
 * Registers a pending repaint when paint is called before metadata has loaded.
 *
 * Avoids listener leaks by using a single once-only loadedmetadata listener on
 * the media element, updating pending entries for existing comment IDs so stale
 * overlays from previous paint passes are not retained in memory.
 */
function registerMetadataRepaint(
  surface: AnchorSurface,
  overlay: HTMLElement,
  anchor: Extract<CommentAnchor, { kind: 'time' }>,
  commentId: string
): void {
  const media = surface.content as HTMLMediaElement;
  let pending = pendingRepaints.get(media);
  if (pending === undefined) {
    const onLoadedMetadata = (): void => {
      const current = pendingRepaints.get(media);
      pendingRepaints.delete(media);
      if (current === undefined) return;
      for (const item of current.entries) {
        paintTimeMark(item.surface, item.overlay, item.anchor, item.commentId);
      }
      // Both halves are checked, the method and the constructor. The method
      // was guarded and the constructor was not, so this threw
      // `ReferenceError: CustomEvent is not defined` wherever the global is
      // absent. It passed locally only because another test file installs a
      // DOM shim on `globalThis` first, so the failure depended on the order
      // bun happened to load files in, and it surfaced on CI rather than
      // here. A repaint notice is decoration; being unable to send one is
      // never worth throwing from inside a metadata handler.
      if (
        typeof CustomEvent === 'function' &&
        typeof surface.host.dispatchEvent === 'function'
      ) {
        surface.host.dispatchEvent(new CustomEvent('relic-repaint'));
      }
    };
    media.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    pending = {
      cleanup: () => {
        media.removeEventListener('loadedmetadata', onLoadedMetadata);
      },
      entries: [],
    };
    pendingRepaints.set(media, pending);
  }

  // Replace any older pending entry with the same comment ID so we paint into the latest overlay
  const existingIndex = pending.entries.findIndex(
    (item) => item.commentId === commentId
  );
  const entry = { surface, overlay, anchor, commentId };
  if (existingIndex >= 0) {
    pending.entries[existingIndex] = entry;
  } else {
    pending.entries.push(entry);
  }
}

/**
 * Finds or creates the timeline marker track inside the overlay, positioned
 * right below the media content box.
 */
export function getOrCreateTimeTrack(
  surface: AnchorSurface,
  overlay: HTMLElement
): HTMLElement {
  let track = overlay.querySelector('.time-track') as HTMLElement | null;
  if (track === null) {
    track = document.createElement('div');
    track.className = 'time-track';
    overlay.appendChild(track);
  }

  const box = contentOffset(surface);
  if (box.width > 0) {
    track.style.left = `${box.left}px`;
    track.style.top = `${box.top + box.height + 4}px`;
    track.style.width = `${box.width}px`;
  }
  return track;
}

/**
 * Seeks to the anchor's timestamp and pauses playback.
 *
 * Seeking without pausing would mean the reader arrives at the moment and it
 * has already vanished into subsequent frames before they can read the comment.
 */
export function revealTimeMark(
  surface: AnchorSurface,
  anchor: Extract<CommentAnchor, { kind: 'time' }>
): void {
  if (!isMediaElement(surface.content)) return;
  const media = surface.content as HTMLMediaElement;
  media.currentTime = anchor.t;
  if (typeof media.pause === 'function') {
    media.pause();
  }
}

/**
 * Paints a time mark on the timeline track, and optionally paints a frame box
 * on the video if a rectangular region was specified.
 *
 * Returns false when the media duration is not yet available, scheduling a
 * repaint on loadedmetadata.
 */
export function paintTimeMark(
  surface: AnchorSurface,
  overlay: HTMLElement,
  anchor: Extract<CommentAnchor, { kind: 'time' }>,
  commentId: string
): boolean {
  if (!isMediaElement(surface.content)) return false;
  const media = surface.content as HTMLMediaElement;
  const duration = media.duration;

  if (!Number.isFinite(duration) || duration <= 0) {
    registerMetadataRepaint(surface, overlay, anchor, commentId);
    return false;
  }

  const track = getOrCreateTimeTrack(surface, overlay);
  const startFrac = markerPosition(anchor.t, duration);

  const marker = document.createElement('button');
  marker.type = 'button';
  marker.dataset.commentId = commentId;
  marker.style.left = `${startFrac * 100}%`;

  if (anchor.t_end !== undefined) {
    const endFrac = markerPosition(anchor.t_end, duration);
    marker.className = 'time-marker time-marker-span';
    marker.style.width = `${Math.max(0, endFrac - startFrac) * 100}%`;
    marker.title = `${formatTimecode(anchor.t)} to ${formatTimecode(anchor.t_end)}`;
  } else {
    marker.className = 'time-marker';
    marker.title = formatTimecode(anchor.t);
  }

  marker.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    revealTimeMark(surface, anchor);
    const doc =
      surface.host.ownerDocument ??
      (typeof document !== 'undefined' ? document : null);
    const row =
      doc !== null &&
      typeof doc === 'object' &&
      'querySelector' in doc &&
      typeof doc.querySelector === 'function'
        ? (doc.querySelector(
            `.thread [data-comment-id="${commentId}"]`
          ) as HTMLElement | null)
        : null;
    if (typeof HTMLElement !== 'undefined' && row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest' });
    } else if (
      row !== null &&
      typeof row === 'object' &&
      'scrollIntoView' in row &&
      typeof row.scrollIntoView === 'function'
    ) {
      row.scrollIntoView({ block: 'nearest' });
    }
  });

  track.appendChild(marker);
  // If a bounding box on the frame was specified, paint the frame box and wire
  // its visibility to whether the current playhead position is in range.
  if (anchor.rect !== undefined) {
    const frameBox = document.createElement('div');
    frameBox.className = 'time-frame-box';
    frameBox.dataset.commentId = commentId;

    const painted = boxFromUnit(surface, anchor.rect);
    if (painted !== undefined) {
      frameBox.style.left = `${painted.left}px`;
      frameBox.style.top = `${painted.top}px`;
      frameBox.style.width = `${painted.width}px`;
      frameBox.style.height = `${painted.height}px`;
    }

    const updateBoxVisibility = (): void => {
      const inWindow = isTimeInWindow(media.currentTime, anchor);
      frameBox.hidden = !inWindow;
      if (inWindow) {
        frameBox.classList.remove('is-hidden');
      } else {
        frameBox.classList.add('is-hidden');
      }
    };

    updateBoxVisibility();

    // Re-evaluate box visibility as the playhead advances or seeks.
    // Unregisters automatically when the overlay is detached from the DOM to prevent leaks.
    const onTimeChange = (): void => {
      const doc =
        surface.host.ownerDocument ??
        (typeof document !== 'undefined' ? document : null);
      if (doc && !doc.contains(overlay)) {
        media.removeEventListener('timeupdate', onTimeChange);
        media.removeEventListener('seeked', onTimeChange);
        return;
      }
      updateBoxVisibility();
    };

    media.addEventListener('timeupdate', onTimeChange);
    media.addEventListener('seeked', onTimeChange);

    overlay.appendChild(frameBox);
  }

  return true;
}

/**
 * Checks whether this surface supports time-based anchors.
 *
 * Answers honestly by testing whether the rendered artifact is an HTML
 * media element (video or audio), never assuming support based on file type.
 */
export function supportsTimeAnchor(surface: AnchorSurface): boolean {
  return isMediaElement(surface.content);
}

export const timeAdapter: AnchorAdapter<'time'> = {
  kind: 'time',
  label: timeTargetLabel,
  paint: paintTimeMark,
  reveal: revealTimeMark,
  supports: supportsTimeAnchor,
};
