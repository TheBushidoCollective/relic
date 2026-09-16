/**
 * Custom accessible media player for video and audio relics, with a comment-bearing timeline.
 *
 * Replaces native browser media controls with custom controls following the accession
 * label aesthetic: hairline rules, zero border radii, no glow effects, and patina teal
 * as the primary saturated colour.
 *
 * The timeline scrubber is layered in order back-to-front:
 * 1. Track rail
 * 2. Buffered ranges
 * 3. Played progress
 * 4. Comment markers (moments, spans, clusters)
 * 5. Pending selection (with draggable, keyboard-steppable span end handle)
 * 6. Hover indicator (vertical rule, timecode tag, comment action button)
 */

import type { CommentAnchor } from '@relic/format';
import { formatTimecode } from './annotate-time.ts';
import {
  fractionToTime,
  pointerFraction,
  STEP_SECONDS,
  spanFromDrag,
  stepSpanEnd,
  type TimeSpan,
  timeToFraction,
} from './media-timeline.ts';

const ICONS = {
  play: 'M4 3l9 5-9 5V3z',
  pause: 'M4 3h3v10H4V3zm5 0h3v10H9V3z',
  volume:
    'M2 5v6h3l4 4V1L5 5H2zm8.5 3c0-1.8-1-3.3-2.5-4v8c1.5-.7 2.5-2.2 2.5-4z',
  mute: 'M2 5v6h3l4 4V1L5 5H2zm10.5 3l2-2-.7-.7-2 2-2-2-.7.7 2 2-2 2 .7.7 2-2 2 2 .7-.7-2-2z',
  fullscreen:
    'M2 2h4v1.5H3.5V6H2V2zm12 0h-4v1.5h2.5V6H14V2zM2 14h4v-1.5H3.5V10H2v4zm12 0h-4v-1.5h2.5V10H14v4z',
  fullscreenExit:
    'M5.5 2H4v2.5H1.5V6H5.5V2zm5 0H12v2.5h2.5V6H10.5V2zm-5 12H4v-2.5H1.5V10H5.5v4zm5 0H12v-2.5h2.5V10H10.5v4z',
  plus: 'M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25V2z',
  audio: 'M3 2h10v12H3V2zm1 1v10h8V3H4zm2 2h4v1H6V5zm0 2h4v1H6V7zm0 2h2v1H6V9z',
} as const;

function createSvgIcon(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('media-icon');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

export interface MediaPlayerOptions {
  readonly isAudio: boolean;
  readonly filename?: string;
}

export interface MediaPlayerHandle {
  readonly chrome: HTMLElement;
  readonly container: HTMLElement;
  readonly audioCard?: HTMLElement | undefined;
  readonly track: HTMLElement;
  readonly destroy: () => void;
  readonly setPendingAnchor: (span: TimeSpan | null) => void;
}

function getTrackGeometry(element: HTMLElement): {
  left: number;
  width: number;
} {
  if (typeof element.getBoundingClientRect === 'function') {
    const rect = element.getBoundingClientRect();
    if (rect && rect.width > 0) {
      return { left: rect.left, width: rect.width };
    }
  }
  return { left: 0, width: 640 };
}
function createCustomEvent<T>(type: string, detail: T): Event {
  if (typeof CustomEvent === 'function') {
    return new CustomEvent(type, { detail, bubbles: true, composed: true });
  }
  return {
    type,
    detail,
    bubbles: true,
    composed: true,
  } as unknown as Event;
}

/**
 * Creates and mounts a custom media player around a video or audio element.
 */
export function createMediaPlayer(
  media: HTMLMediaElement,
  options: MediaPlayerOptions
): MediaPlayerHandle {
  const { isAudio, filename } = options;
  // Native controls are explicitly removed
  media.controls = false;
  if (typeof media.removeAttribute === 'function') {
    media.removeAttribute('controls');
  }

  let audioCard: HTMLElement | undefined;
  if (isAudio) {
    audioCard = document.createElement('div');
    audioCard.className = 'media-audio-card';

    const emblem = document.createElement('div');
    emblem.className = 'media-audio-emblem';
    emblem.appendChild(createSvgIcon(ICONS.audio));

    const info = document.createElement('div');
    info.className = 'media-audio-info';

    const title = document.createElement('span');
    title.className = 'media-audio-title';
    title.textContent =
      filename && filename.length > 0 ? filename : 'Audio recording';

    const state = document.createElement('span');
    state.className = 'media-audio-state';
    state.textContent = 'Audio track';

    info.append(title, state);
    audioCard.append(emblem, info);
  }

  // Chrome container (scrubber + controls)
  const chrome = document.createElement('div');
  chrome.className = `custom-media-player media-chrome ${
    isAudio ? 'media-is-audio' : 'media-is-video'
  }`;

  // --- Scrubber Wrapper & Interactive Slider ---
  const scrubberWrap = document.createElement('div');
  scrubberWrap.className = 'media-scrubber-wrap';

  const scrubber = document.createElement('div');
  scrubber.className = 'media-scrubber';
  scrubber.setAttribute('role', 'slider');
  scrubber.setAttribute('tabindex', '0');
  scrubber.setAttribute(
    'aria-label',
    isAudio ? 'Audio timeline' : 'Video timeline'
  );
  scrubber.setAttribute('aria-valuemin', '0');
  scrubber.setAttribute('aria-valuemax', '0');
  scrubber.setAttribute('aria-valuenow', '0');
  scrubber.setAttribute('aria-valuetext', '0:00 of 0:00');

  const rail = document.createElement('div');
  rail.className = 'media-track-rail';

  // Buffered ranges
  const bufferedBar = document.createElement('div');
  bufferedBar.className = 'media-buffered-bar';

  // Played progress
  const playedBar = document.createElement('div');
  playedBar.className = 'media-played-bar';

  // Markers track (where comment markers land)
  const track = document.createElement('div');
  track.className = 'time-track';
  track.dataset.mediaTimeline = 'true';

  // Pending selection (moment or dragged span)
  const pendingSelection = document.createElement('div');
  pendingSelection.className = 'media-pending-selection is-hidden';

  const pendingStartTag = document.createElement('span');
  pendingStartTag.className = 'pending-time-tag pending-start-tag';

  const spanHandle = document.createElement('button');
  spanHandle.type = 'button';
  spanHandle.className = 'timeline-span-handle';
  spanHandle.setAttribute('role', 'slider');
  spanHandle.setAttribute('tabindex', '0');
  spanHandle.setAttribute('aria-label', 'Adjust comment span end');
  spanHandle.setAttribute('aria-valuemin', '0');
  spanHandle.setAttribute('aria-valuemax', '0');
  spanHandle.setAttribute('aria-valuenow', '0');
  spanHandle.title = 'Drag or use left/right arrow keys to extend span';

  const pendingEndTag = document.createElement('span');
  pendingEndTag.className = 'pending-time-tag pending-end-tag';

  pendingSelection.append(pendingStartTag, spanHandle, pendingEndTag);

  // Hover indicator
  const hoverIndicator = document.createElement('div');
  hoverIndicator.className = 'media-hover-indicator is-hidden';

  const hoverRule = document.createElement('div');
  hoverRule.className = 'hover-rule';

  const hoverTimecode = document.createElement('div');
  hoverTimecode.className = 'hover-timecode';
  hoverTimecode.textContent = '0:00';

  const hoverCommentBtn = document.createElement('button');
  hoverCommentBtn.type = 'button';
  hoverCommentBtn.className = 'timeline-hover-comment-btn';
  hoverCommentBtn.setAttribute('aria-label', 'Comment at this time');
  hoverCommentBtn.title = isAudio
    ? 'Comment on this moment'
    : 'Comment on this frame';
  hoverCommentBtn.appendChild(createSvgIcon(ICONS.plus));

  hoverIndicator.append(hoverRule, hoverTimecode, hoverCommentBtn);

  rail.append(bufferedBar, playedBar, track, pendingSelection, hoverIndicator);
  scrubber.appendChild(rail);
  scrubberWrap.appendChild(scrubber);
  chrome.appendChild(scrubberWrap);

  // --- Controls Bar ---
  const controlsBar = document.createElement('div');
  controlsBar.className = 'media-controls-bar';

  // Left side: Play/Pause and Timecode
  const leftControls = document.createElement('div');
  leftControls.className = 'media-controls-left';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'media-btn media-play-btn';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.title = 'Play (Space / K)';
  playBtn.appendChild(createSvgIcon(ICONS.play));

  const timecode = document.createElement('div');
  timecode.className = 'media-timecode';

  const currentSpan = document.createElement('span');
  currentSpan.className = 'time-current';
  currentSpan.textContent = '0:00';

  const sepSpan = document.createElement('span');
  sepSpan.className = 'time-sep';
  sepSpan.textContent = ' / ';

  const durationSpan = document.createElement('span');
  durationSpan.className = 'time-duration';
  durationSpan.textContent = '0:00';

  timecode.append(currentSpan, sepSpan, durationSpan);
  leftControls.append(playBtn, timecode);

  // Right side: Mute and Fullscreen (video only)
  const rightControls = document.createElement('div');
  rightControls.className = 'media-controls-right';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'media-btn media-mute-btn';
  muteBtn.setAttribute('aria-label', 'Mute');
  muteBtn.title = 'Mute (M)';
  muteBtn.appendChild(createSvgIcon(ICONS.volume));
  rightControls.appendChild(muteBtn);

  let fullscreenBtn: HTMLButtonElement | undefined;
  if (!isAudio) {
    fullscreenBtn = document.createElement('button');
    fullscreenBtn.type = 'button';
    fullscreenBtn.className = 'media-btn media-fullscreen-btn';
    fullscreenBtn.setAttribute('aria-label', 'Fullscreen');
    fullscreenBtn.title = 'Fullscreen (F)';
    fullscreenBtn.appendChild(createSvgIcon(ICONS.fullscreen));
    rightControls.appendChild(fullscreenBtn);
  }

  controlsBar.append(leftControls, rightControls);
  chrome.appendChild(controlsBar);

  // --------------------------------------------------------------------------
  // State and Helpers
  // --------------------------------------------------------------------------
  let pendingSpan: TimeSpan | null = null;
  let dragState: {
    pointerId: number;
    startSeconds: number;
    currentSeconds: number;
    hasMoved: boolean;
  } | null = null;
  let handleDragState: { pointerId: number } | null = null;

  const getDuration = (): number => {
    const d = media.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  };

  const dispatchTimeAim = (
    anchor: Extract<CommentAnchor, { kind: 'time' }>
  ): void => {
    if (typeof chrome.dispatchEvent === 'function') {
      chrome.dispatchEvent(createCustomEvent('relic:time-aim', { anchor }));
    }
  };

  const updateTimeDisplay = (): void => {
    const duration = getDuration();
    const current = media.currentTime;
    currentSpan.textContent = formatTimecode(current);
    durationSpan.textContent = formatTimecode(duration);

    scrubber.setAttribute('aria-valuemax', String(Math.floor(duration)));
    scrubber.setAttribute('aria-valuenow', String(Math.floor(current)));
    scrubber.setAttribute(
      'aria-valuetext',
      `${formatTimecode(current)} of ${formatTimecode(duration)}`
    );

    const fraction = timeToFraction(current, duration) ?? 0;
    playedBar.style.width = `${fraction * 100}%`;
  };

  const updateBufferedDisplay = (): void => {
    const duration = getDuration();
    if (duration <= 0 || !media.buffered || media.buffered.length === 0) {
      bufferedBar.style.width = '0%';
      return;
    }
    const end = media.buffered.end(media.buffered.length - 1);
    const fraction = timeToFraction(end, duration) ?? 0;
    bufferedBar.style.width = `${fraction * 100}%`;
  };

  const updatePlayState = (): void => {
    const isPaused = media.paused;
    playBtn.replaceChildren(createSvgIcon(isPaused ? ICONS.play : ICONS.pause));
    playBtn.setAttribute('aria-label', isPaused ? 'Play' : 'Pause');
  };

  const updateMuteState = (): void => {
    const isMuted = media.muted || media.volume === 0;
    muteBtn.replaceChildren(createSvgIcon(isMuted ? ICONS.mute : ICONS.volume));
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
  };

  const updatePendingVisuals = (): void => {
    const duration = getDuration();
    if (pendingSpan === null || duration <= 0) {
      pendingSelection.classList.add('is-hidden');
      return;
    }

    pendingSelection.classList.remove('is-hidden');
    const startFrac = timeToFraction(pendingSpan.t, duration) ?? 0;
    const endSeconds = pendingSpan.t_end ?? pendingSpan.t;
    const endFrac = timeToFraction(endSeconds, duration) ?? startFrac;

    const leftPct = Number((startFrac * 100).toFixed(4));
    const widthPct = Number(
      (Math.max(0, endFrac - startFrac) * 100).toFixed(4)
    );

    pendingSelection.style.left = `${leftPct}%`;
    pendingSelection.style.width = `${widthPct}%`;

    pendingStartTag.textContent = formatTimecode(pendingSpan.t);
    pendingEndTag.textContent = formatTimecode(endSeconds);
    pendingEndTag.hidden = pendingSpan.t_end === undefined;

    spanHandle.setAttribute('aria-valuenow', String(endSeconds));
    spanHandle.setAttribute('aria-valuemin', String(pendingSpan.t));
    spanHandle.setAttribute('aria-valuemax', String(duration));
  };

  const setPendingAnchor = (span: TimeSpan | null): void => {
    pendingSpan = span;
    updatePendingVisuals();
  };

  const togglePlay = (): void => {
    if (media.paused) {
      const playPromise = media.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
      }
    } else {
      if (typeof media.pause === 'function') {
        media.pause();
      }
    }
  };

  const toggleMute = (): void => {
    media.muted = !media.muted;
  };

  const toggleFullscreen = (): void => {
    const doc = chrome.ownerDocument ?? document;
    const target = media.parentElement ?? media;
    if (doc.fullscreenElement) {
      if (typeof doc.exitFullscreen === 'function') {
        doc.exitFullscreen().catch(() => {});
      }
    } else {
      if (typeof target.requestFullscreen === 'function') {
        target.requestFullscreen().catch(() => {});
      } else if (typeof media.requestFullscreen === 'function') {
        media.requestFullscreen().catch(() => {});
      }
    }
  };

  const seekRelative = (seconds: number): void => {
    const duration = getDuration();
    const next = Math.max(0, Math.min(duration, media.currentTime + seconds));
    media.currentTime = next;
    updateTimeDisplay();
  };

  // --------------------------------------------------------------------------
  // Media Listeners
  // --------------------------------------------------------------------------
  media.addEventListener('play', updatePlayState);
  media.addEventListener('pause', updatePlayState);
  media.addEventListener('timeupdate', updateTimeDisplay);
  media.addEventListener('durationchange', () => {
    updateTimeDisplay();
    updateBufferedDisplay();
    updatePendingVisuals();
  });
  media.addEventListener('loadedmetadata', () => {
    updateTimeDisplay();
    updateBufferedDisplay();
    updatePendingVisuals();
  });
  media.addEventListener('progress', updateBufferedDisplay);
  media.addEventListener('volumechange', updateMuteState);
  media.addEventListener('seeking', updateTimeDisplay);
  media.addEventListener('seeked', updateTimeDisplay);
  playBtn.addEventListener('click', togglePlay);
  muteBtn.addEventListener('click', toggleMute);
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', toggleFullscreen);
    const doc = chrome.ownerDocument ?? document;
    doc.addEventListener('fullscreenchange', () => {
      const isFs = Boolean(doc.fullscreenElement);
      fullscreenBtn?.replaceChildren(
        createSvgIcon(isFs ? ICONS.fullscreenExit : ICONS.fullscreen)
      );
      fullscreenBtn?.setAttribute(
        'aria-label',
        isFs ? 'Exit fullscreen' : 'Fullscreen'
      );
    });
  }

  // --------------------------------------------------------------------------
  // Scrubber Pointer Gestures (Seek, Drag-to-span, Hover indicator)
  // --------------------------------------------------------------------------
  scrubber.addEventListener('pointerdown', (event: PointerEvent) => {
    // If the click is directly on the span handle or a marker button, let them handle it
    const target = event.target as HTMLElement | null;
    if (
      target?.closest('.timeline-span-handle') ||
      target?.closest('.time-marker') ||
      target?.closest('.timeline-hover-comment-btn')
    ) {
      return;
    }

    const duration = getDuration();
    if (duration <= 0) return;

    if (typeof scrubber.setPointerCapture === 'function') {
      try {
        scrubber.setPointerCapture(event.pointerId);
      } catch {}
    }

    const geom = getTrackGeometry(rail);
    const frac = pointerFraction(event.clientX, geom.left, geom.width);
    const t = fractionToTime(frac, duration);

    media.currentTime = t;
    if (typeof media.pause === 'function') {
      media.pause();
    }

    dragState = {
      pointerId: event.pointerId,
      startSeconds: t,
      currentSeconds: t,
      hasMoved: false,
    };

    setPendingAnchor({ t });
    hoverIndicator.classList.add('is-hidden');
  });

  scrubber.addEventListener('pointermove', (event: PointerEvent) => {
    const duration = getDuration();
    if (duration <= 0) return;

    const geom = getTrackGeometry(rail);
    const frac = pointerFraction(event.clientX, geom.left, geom.width);
    const currentSeconds = fractionToTime(frac, duration);

    if (dragState !== null) {
      dragState.currentSeconds = currentSeconds;
      if (Math.abs(currentSeconds - dragState.startSeconds) >= 0.2) {
        dragState.hasMoved = true;
      }
      media.currentTime = currentSeconds;
      const span = spanFromDrag(dragState.startSeconds, currentSeconds);
      setPendingAnchor(span);
      hoverIndicator.classList.add('is-hidden');
    } else {
      // Hover affordance: update without seeking
      hoverIndicator.classList.remove('is-hidden');
      hoverIndicator.style.left = `${frac * 100}%`;
      hoverTimecode.textContent = formatTimecode(currentSeconds);
      hoverCommentBtn.setAttribute(
        'aria-label',
        `Comment at ${formatTimecode(currentSeconds)}`
      );
      hoverCommentBtn.dataset.time = String(currentSeconds);
    }
  });

  scrubber.addEventListener('pointerleave', () => {
    if (dragState === null) {
      hoverIndicator.classList.add('is-hidden');
    }
  });

  const finishScrubberDrag = (event: PointerEvent): void => {
    if (dragState === null || dragState.pointerId !== event.pointerId) return;

    if (typeof scrubber.releasePointerCapture === 'function') {
      try {
        scrubber.releasePointerCapture(event.pointerId);
      } catch {}
    }

    const span = spanFromDrag(dragState.startSeconds, dragState.currentSeconds);
    const anchor: Extract<CommentAnchor, { kind: 'time' }> = {
      kind: 'time',
      t: span.t,
      ...(span.t_end !== undefined ? { t_end: span.t_end } : {}),
    };

    setPendingAnchor(span);
    dispatchTimeAim(anchor);
    dragState = null;
  };

  scrubber.addEventListener('pointerup', finishScrubberDrag);
  scrubber.addEventListener('pointercancel', finishScrubberDrag);

  // Hover comment button click
  hoverCommentBtn.addEventListener('click', (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const duration = getDuration();
    const t = Number(hoverCommentBtn.dataset.time ?? media.currentTime);
    const boundedTime = Math.max(0, Math.min(duration, t));

    media.currentTime = boundedTime;
    if (typeof media.pause === 'function') {
      media.pause();
    }

    const anchor: Extract<CommentAnchor, { kind: 'time' }> = {
      kind: 'time',
      t: boundedTime,
    };
    setPendingAnchor({ t: boundedTime });
    dispatchTimeAim(anchor);
  });

  // --------------------------------------------------------------------------
  // Span End Handle (Dragging & Keyboard Stepping)
  // --------------------------------------------------------------------------
  spanHandle.addEventListener('pointerdown', (event: PointerEvent) => {
    event.stopPropagation();
    handleDragState = { pointerId: event.pointerId };
    if (typeof spanHandle.setPointerCapture === 'function') {
      try {
        spanHandle.setPointerCapture(event.pointerId);
      } catch {}
    }
  });

  spanHandle.addEventListener('pointermove', (event: PointerEvent) => {
    if (handleDragState === null || pendingSpan === null) return;
    const duration = getDuration();
    if (duration <= 0) return;

    const geom = getTrackGeometry(rail);
    const frac = pointerFraction(event.clientX, geom.left, geom.width);
    const newTime = fractionToTime(frac, duration);

    if (newTime - pendingSpan.t < STEP_SECONDS / 2) {
      pendingSpan = { t: pendingSpan.t };
    } else {
      pendingSpan = { t: pendingSpan.t, t_end: newTime };
    }

    media.currentTime = newTime;
    updatePendingVisuals();
  });

  const finishHandleDrag = (event: PointerEvent): void => {
    if (
      handleDragState === null ||
      handleDragState.pointerId !== event.pointerId
    ) {
      return;
    }
    handleDragState = null;
    if (typeof spanHandle.releasePointerCapture === 'function') {
      try {
        spanHandle.releasePointerCapture(event.pointerId);
      } catch {}
    }
    if (pendingSpan !== null) {
      dispatchTimeAim({
        kind: 'time',
        t: pendingSpan.t,
        ...(pendingSpan.t_end !== undefined
          ? { t_end: pendingSpan.t_end }
          : {}),
      });
    }
  };

  spanHandle.addEventListener('pointerup', finishHandleDrag);
  spanHandle.addEventListener('pointercancel', finishHandleDrag);

  spanHandle.addEventListener('keydown', (event: KeyboardEvent) => {
    if (pendingSpan === null) return;
    const duration = getDuration();

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      const updated = stepSpanEnd(pendingSpan, 1, duration, event.shiftKey);
      pendingSpan = updated;
      media.currentTime = updated.t_end ?? updated.t;
      updatePendingVisuals();
      dispatchTimeAim({
        kind: 'time',
        t: updated.t,
        ...(updated.t_end !== undefined ? { t_end: updated.t_end } : {}),
      });
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      const updated = stepSpanEnd(pendingSpan, -1, duration, event.shiftKey);
      pendingSpan = updated;
      media.currentTime = updated.t_end ?? updated.t;
      updatePendingVisuals();
      dispatchTimeAim({
        kind: 'time',
        t: updated.t,
        ...(updated.t_end !== undefined ? { t_end: updated.t_end } : {}),
      });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      pendingSpan = { t: pendingSpan.t };
      media.currentTime = pendingSpan.t;
      updatePendingVisuals();
      dispatchTimeAim({ kind: 'time', t: pendingSpan.t });
    }
  });

  // --------------------------------------------------------------------------
  // Keyboard Controls on Scrubber Slider
  // --------------------------------------------------------------------------
  scrubber.addEventListener('keydown', (event: KeyboardEvent) => {
    const duration = getDuration();

    switch (event.key) {
      case 'ArrowLeft': {
        event.preventDefault();
        const step = event.shiftKey ? 10 : event.altKey ? 1 : 5;
        seekRelative(-step);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        const step = event.shiftKey ? 10 : event.altKey ? 1 : 5;
        seekRelative(step);
        break;
      }
      case 'Home': {
        event.preventDefault();
        media.currentTime = 0;
        updateTimeDisplay();
        break;
      }
      case 'End': {
        event.preventDefault();
        media.currentTime = duration;
        updateTimeDisplay();
        break;
      }
      case ' ':
      case 'k':
      case 'K': {
        event.preventDefault();
        togglePlay();
        break;
      }
      case 'm':
      case 'M': {
        event.preventDefault();
        toggleMute();
        break;
      }
      case 'f':
      case 'F': {
        if (!isAudio) {
          event.preventDefault();
          toggleFullscreen();
        }
        break;
      }
      case 'c':
      case 'C':
      case 'Enter': {
        event.preventDefault();
        const t = media.currentTime;
        if (typeof media.pause === 'function') {
          media.pause();
        }
        const anchor: Extract<CommentAnchor, { kind: 'time' }> = {
          kind: 'time',
          t,
        };
        setPendingAnchor({ t });
        dispatchTimeAim(anchor);
        break;
      }
    }
  });

  // --------------------------------------------------------------------------
  // Incoming Selection Events from Stage/Composer
  // --------------------------------------------------------------------------
  const onTimeSelection = (event: Event): void => {
    const detail = (event as CustomEvent).detail;
    if (detail?.anchor && detail.anchor.kind === 'time') {
      const a = detail.anchor as Extract<CommentAnchor, { kind: 'time' }>;
      setPendingAnchor({
        t: a.t,
        ...(a.t_end !== undefined ? { t_end: a.t_end } : {}),
      });
    }
  };

  const onTimeCleared = (): void => {
    setPendingAnchor(null);
  };

  chrome.addEventListener('relic:time-selection', onTimeSelection);
  chrome.addEventListener('relic:time-selection-cleared', onTimeCleared);

  // Initial display setup
  updateTimeDisplay();
  updatePlayState();
  updateMuteState();

  return {
    chrome,
    container: chrome,
    audioCard,
    track,
    destroy: () => {
      if (typeof media.removeEventListener === 'function') {
        media.removeEventListener('play', updatePlayState);
        media.removeEventListener('pause', updatePlayState);
        media.removeEventListener('timeupdate', updateTimeDisplay);
        media.removeEventListener('progress', updateBufferedDisplay);
        media.removeEventListener('volumechange', updateMuteState);
      }
      if (typeof chrome.removeEventListener === 'function') {
        chrome.removeEventListener('relic:time-selection', onTimeSelection);
        chrome.removeEventListener(
          'relic:time-selection-cleared',
          onTimeCleared
        );
      }
    },
    setPendingAnchor,
  };
}
