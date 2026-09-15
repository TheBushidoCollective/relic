/**
 * Tests for time-based comment anchoring on video and audio relics.
 *
 * Verifies timecode formatting, marker positioning along the timeline track,
 * metadata-deferred painting, playback seeking and pausing, playhead windowing
 * for rectangular frame annotations, and capture controls for frames and spans.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnchorRect } from '@relic/format';
import type { AnchorSurface } from '../src/anchoring.ts';
import {
  formatTimecode,
  isMediaElement,
  isTimeInWindow,
  markerPosition,
  paintTimeMark,
  revealTimeMark,
  supportsTimeAnchor,
  timeAdapter,
  timeTargetLabel,
} from '../src/annotate-time.ts';
import { buildMarkControls } from '../src/main.ts';

/** Minimal DOM node stub supporting hierarchy, attributes, and event dispatching. */
class TestNode {
  readonly tagName: string;
  className = '';
  textContent = '';
  id = '';
  hidden = false;
  tabIndex = 0;
  type = '';
  title = '';
  value = '';
  parent: TestNode | undefined;
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 640, height: 360 };
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<
    string,
    Array<{ handler: (event: unknown) => void; once?: boolean }>
  >();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  readonly classList = {
    add: (name: string): void => {
      if (this.classes().includes(name)) return;
      this.className = `${this.className} ${name}`.trim();
    },
    remove: (name: string): void => {
      this.className = this.classes()
        .filter((candidate) => candidate !== name)
        .join(' ');
    },
    contains: (name: string): boolean => this.classes().includes(name),
    toggle: (name: string, on?: boolean): void => {
      if (on ?? !this.classes().includes(name)) this.classList.add(name);
      else this.classList.remove(name);
    },
  };

  classes(): string[] {
    return this.className.split(' ').filter((name) => name.length > 0);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild(child: TestNode): TestNode {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children: TestNode[]): void {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children: TestNode[]): void {
    for (const child of [...this.children]) child.parent = undefined;
    this.children.length = 0;
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    const holder = this.parent;
    if (holder === undefined) return;
    const at = holder.children.indexOf(this);
    if (at >= 0) holder.children.splice(at, 1);
    this.parent = undefined;
  }

  contains(node: unknown): boolean {
    let walk = node instanceof TestNode ? node : undefined;
    while (walk !== undefined) {
      if (walk === this) return true;
      walk = walk.parent;
    }
    return false;
  }

  querySelectorAll(selector: string): TestNode[] {
    return descendants(this)
      .slice(1)
      .filter((candidate) => matchSelector(candidate, selector));
  }

  querySelector(selector: string): TestNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect(): typeof this.rect {
    return this.rect;
  }

  scrollIntoView(): void {}

  focus(): void {}

  addEventListener(
    type: string,
    handler: (event: unknown) => void,
    options?: { once?: boolean }
  ): void {
    const list = this.listeners.get(type) ?? [];
    const entry: { handler: (event: unknown) => void; once?: boolean } = {
      handler,
    };
    if (options?.once !== undefined) entry.once = options.once;
    list.push(entry);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    const index = list.findIndex((entry) => entry.handler === handler);
    if (index >= 0) list.splice(index, 1);
  }

  dispatchEvent(event: string | { type: string }): boolean {
    const eventType = typeof event === 'string' ? event : event.type;
    const eventObj =
      typeof event === 'string'
        ? {
            type: event,
            target: this,
            preventDefault: (): void => {},
            stopPropagation: (): void => {},
          }
        : {
            target: this,
            preventDefault: (): void => {},
            stopPropagation: (): void => {},
            ...event,
          };

    let walk: TestNode | undefined = this;
    while (walk !== undefined) {
      const list = walk.listeners.get(eventType);
      if (list !== undefined) {
        const remaining = [];
        for (const entry of list) {
          entry.handler(eventObj);
          if (!entry.once) remaining.push(entry);
        }
        walk.listeners.set(eventType, remaining);
      }
      walk = walk.parent;
    }
    return true;
  }
}

/** Media element stub providing playback state, duration, and time controls. */
class MediaTestNode extends TestNode {
  duration = 100;
  currentTime = 0;
  paused = true;

  play(): void {
    this.paused = false;
    this.dispatchEvent('play');
  }

  pause(): void {
    this.paused = true;
    this.dispatchEvent('pause');
  }
}

function descendants(node: TestNode): TestNode[] {
  return [node, ...node.children.flatMap(descendants)];
}

function matchSelector(node: TestNode, selector: string): boolean {
  for (const part of selector.split(',').map((p) => p.trim())) {
    if (matchSingleSelector(node, part)) return true;
  }
  return false;
}

function matchSingleSelector(node: TestNode, selector: string): boolean {
  const dataMatch = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (dataMatch !== null) {
    const rawKey = dataMatch[1];
    if (rawKey === undefined) return false;
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = node.dataset[key];
    if (val === undefined) return false;
    if (dataMatch[2] !== undefined) return val === dataMatch[2];
    return true;
  }

  if (selector.startsWith('.')) {
    return node.classes().includes(selector.slice(1));
  }

  const tagClassMatch = /^([A-Z0-9]+)\.([a-z0-9_-]+)$/i.exec(selector);
  if (tagClassMatch !== null) {
    const rawTag = tagClassMatch[1];
    const wantedClass = tagClassMatch[2];
    if (rawTag === undefined || wantedClass === undefined) return false;
    const wantedTag = rawTag.toUpperCase();
    return node.tagName === wantedTag && node.classes().includes(wantedClass);
  }

  return node.tagName === selector.toUpperCase();
}

describe('annotate-time', () => {
  let origDocument: unknown;
  let origWindow: unknown;

  beforeEach(() => {
    origDocument = (globalThis as { document?: unknown }).document;
    origWindow = (globalThis as { window?: unknown }).window;

    const docListeners = new Map<string, Array<(event: unknown) => void>>();
    const bodyNode = new TestNode('body');

    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => {
        if (tag.toLowerCase() === 'video' || tag.toLowerCase() === 'audio') {
          return new MediaTestNode(tag);
        }
        return new TestNode(tag);
      },
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        const list = docListeners.get(type) ?? [];
        list.push(handler);
        docListeners.set(type, list);
      },
      removeEventListener: (
        type: string,
        handler: (event: unknown) => void
      ) => {
        const list = docListeners.get(type);
        if (list === undefined) return;
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      },
      dispatchEvent: (event: unknown, detail?: Record<string, unknown>) => {
        const eventType =
          typeof event === 'string' ? event : (event as { type: string }).type;
        const eventObj =
          typeof event === 'string' ? { type: event, ...detail } : event;
        for (const handler of docListeners.get(eventType) ?? []) {
          handler(eventObj);
        }
        return true;
      },
      body: bodyNode,
      contains: (_node: unknown) => true,
      querySelector: (selector: string) => bodyNode.querySelector(selector),
    };
    (globalThis as { window?: unknown }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      getSelection: () => null,
    };
  });

  afterEach(() => {
    (globalThis as { document?: unknown }).document = origDocument;
    (globalThis as { window?: unknown }).window = origWindow;
  });

  test('the timecode label: 83.5 seconds reads as 1:23, and something over an hour reads with hours', () => {
    // Proves the timecode label formatting meets the contract requirement.
    expect(formatTimecode(83.5)).toBe('1:23');
    expect(formatTimecode(3665)).toBe('1:01:05');
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(59)).toBe('0:59');
    expect(formatTimecode(60)).toBe('1:00');
    expect(formatTimecode(3600)).toBe('1:00:00');
    expect(formatTimecode(-5)).toBe('0:00');

    // Label on time anchor
    expect(timeAdapter.label({ kind: 'time', t: 83.5 })).toBe(
      'Commenting at 1:23'
    );
    expect(timeAdapter.label({ kind: 'time', t: 3665 })).toBe(
      'Commenting at 1:01:05'
    );
    expect(timeAdapter.label({ kind: 'time', t: 83.5, t_end: 120 })).toBe(
      'Commenting at 1:23 to 2:00'
    );
    expect(timeTargetLabel({ kind: 'time', t: 83.5 })).toBe(
      'Commenting at 1:23'
    );
  });

  test('a marker position is t / duration of track width, and t past duration does not paint off the end', () => {
    // For a video of 100 seconds:
    expect(markerPosition(25, 100)).toBe(0.25);
    expect(markerPosition(50, 100)).toBe(0.5);
    expect(markerPosition(0, 100)).toBe(0);

    // A timestamp exceeding the media duration must clamp to 1.0 rather than painting past the track end
    expect(markerPosition(150, 100)).toBe(1.0);
    expect(markerPosition(-10, 100)).toBe(0);

    // Rendered element styles
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    video.duration = 100;
    host.appendChild(video);
    const surface: AnchorSurface = {
      host: host as unknown as HTMLElement,
      content: video as unknown as HTMLElement,
    };
    const overlay = new TestNode('div');

    const placed = timeAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 25 },
      'c1'
    );
    expect(placed).toBe(true);

    const marker = overlay.querySelector('[data-comment-id="c1"]');
    expect(marker).toBeDefined();
    expect(marker?.style.left).toBe('25%');

    // Marker past duration
    const placedPast = timeAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 150 },
      'c2'
    );
    expect(placedPast).toBe(true);
    const markerPast = overlay.querySelector('[data-comment-id="c2"]');
    expect(markerPast).toBeDefined();
    expect(markerPast?.style.left).toBe('100%');
  });

  test('paint returns false before metadata and repaints after loadedmetadata', () => {
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    // Media duration is NaN before metadata loads
    video.duration = Number.NaN;
    host.appendChild(video);

    const surface: AnchorSurface = {
      host: host as unknown as HTMLElement,
      content: video as unknown as HTMLElement,
    };
    const overlay = new TestNode('div');

    // Should return false because duration is unknown
    const placedBefore = timeAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 15 },
      'c1'
    );
    expect(placedBefore).toBe(false);
    expect(overlay.querySelector('[data-comment-id="c1"]')).toBeNull();

    // Now metadata arrives and loadedmetadata event fires
    video.duration = 60;
    video.dispatchEvent('loadedmetadata');

    // Marker is painted after loadedmetadata
    const markerAfter = overlay.querySelector('[data-comment-id="c1"]');
    expect(markerAfter).toBeDefined();
    expect(markerAfter?.style.left).toBe('25%');
  });

  test('reveal both seeks AND pauses', () => {
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    video.duration = 100;
    video.currentTime = 5;
    video.play();
    expect(video.paused).toBe(false);

    const surface: AnchorSurface = {
      host: host as unknown as HTMLElement,
      content: video as unknown as HTMLElement,
    };

    timeAdapter.reveal?.(surface, { kind: 'time', t: 42.5 });

    // Both seeks to the exact timestamp and ensures playback is paused
    expect(video.currentTime).toBe(42.5);
    expect(video.paused).toBe(true);
  });

  test('a rect box is shown only while the playhead is inside the anchor window', () => {
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    video.duration = 100;
    video.currentTime = 10;
    host.appendChild(video);

    const surface: AnchorSurface = {
      host: host as unknown as HTMLElement,
      content: video as unknown as HTMLElement,
    };
    const overlay = new TestNode('div');

    const rect: AnchorRect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const placed = timeAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 10, rect },
      'c1'
    );
    expect(placed).toBe(true);

    const frameBox = overlay.querySelector('.time-frame-box');
    expect(frameBox).toBeDefined();
    expect(frameBox?.dataset.commentId).toBe('c1');

    // While currentTime is 10 (at anchor.t), box is inside window and visible
    expect(frameBox?.hidden).toBe(false);
    expect(frameBox?.classes()).not.toContain('is-hidden');

    // Playhead advances to 20: outside window, box becomes hidden
    video.currentTime = 20;
    video.dispatchEvent('timeupdate');
    expect(frameBox?.hidden).toBe(true);
    expect(frameBox?.classes()).toContain('is-hidden');

    // Playhead seeks back to 10: inside window, box becomes visible again
    video.currentTime = 10;
    video.dispatchEvent('seeked');
    expect(frameBox?.hidden).toBe(false);
    expect(frameBox?.classes()).not.toContain('is-hidden');
  });

  test('span anchor with rect is visible within the entire [t, t_end] window', () => {
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    video.duration = 100;
    video.currentTime = 5;
    host.appendChild(video);

    const surface: AnchorSurface = {
      host: host as unknown as HTMLElement,
      content: video as unknown as HTMLElement,
    };
    const overlay = new TestNode('div');

    const rect: AnchorRect = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
    timeAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 10, t_end: 20, rect },
      'c-span'
    );

    const frameBox = overlay.querySelector('.time-frame-box');
    expect(frameBox).toBeDefined();

    // At 5s (before span start): hidden
    expect(frameBox?.hidden).toBe(true);

    // At 15s (within span): visible
    video.currentTime = 15;
    video.dispatchEvent('timeupdate');
    expect(frameBox?.hidden).toBe(false);

    // At 20s (at span end): visible
    video.currentTime = 20;
    video.dispatchEvent('timeupdate');
    expect(frameBox?.hidden).toBe(false);

    // At 25s (past span end): hidden
    video.currentTime = 25;
    video.dispatchEvent('timeupdate');
    expect(frameBox?.hidden).toBe(true);
  });

  test('an anchor with t_end renders as a span marker with correct width', () => {
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    video.duration = 100;
    host.appendChild(video);

    const surface: AnchorSurface = {
      host: host as unknown as HTMLElement,
      content: video as unknown as HTMLElement,
    };
    const overlay = new TestNode('div');

    timeAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 20, t_end: 60 },
      'span-1'
    );

    const marker = overlay.querySelector('[data-comment-id="span-1"]');
    expect(marker).toBeDefined();
    expect(marker?.classes()).toContain('time-marker-span');
    expect(marker?.style.left).toBe('20%');
    expect(marker?.style.width).toBe('40%');
  });

  test('isMediaElement identifies video and audio nodes correctly', () => {
    const video = new MediaTestNode('video');
    const audio = new MediaTestNode('audio');
    const div = new TestNode('div');
    expect(isMediaElement(video)).toBe(true);
    expect(isMediaElement(audio)).toBe(true);
    expect(isMediaElement(div)).toBe(false);
    expect(isMediaElement(null)).toBe(false);
    expect(isMediaElement({})).toBe(false);
  });

  test('isTimeInWindow evaluates single frames and span boundaries', () => {
    // Moment at 10s with default 0.25s tolerance
    expect(isTimeInWindow(10, { t: 10 })).toBe(true);
    expect(isTimeInWindow(10.2, { t: 10 })).toBe(true);
    expect(isTimeInWindow(10.5, { t: 10 })).toBe(false);
    expect(isTimeInWindow(9.7, { t: 10 })).toBe(false);

    // Span from 10s to 20s
    expect(isTimeInWindow(10, { t: 10, t_end: 20 })).toBe(true);
    expect(isTimeInWindow(15, { t: 10, t_end: 20 })).toBe(true);
    expect(isTimeInWindow(20, { t: 10, t_end: 20 })).toBe(true);
    expect(isTimeInWindow(9, { t: 10, t_end: 20 })).toBe(false);
    expect(isTimeInWindow(21, { t: 10, t_end: 20 })).toBe(false);
  });

  test('paintTimeMark and revealTimeMark exported functions behave identically to adapter', () => {
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    video.duration = 60;
    video.currentTime = 0;
    host.appendChild(video);
    const surface: AnchorSurface = {
      host: host as unknown as HTMLElement,
      content: video as unknown as HTMLElement,
    };
    const overlay = new TestNode('div');

    const placed = paintTimeMark(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 30 },
      'direct-1'
    );
    expect(placed).toBe(true);
    expect(overlay.querySelector('[data-comment-id="direct-1"]')).toBeDefined();

    revealTimeMark(surface, { kind: 'time', t: 30 });
    expect(video.currentTime).toBe(30);
    expect(video.paused).toBe(true);
  });

  test('supports accurately discriminates media elements from non-media surfaces', () => {
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    const audio = new MediaTestNode('audio');
    const div = new TestNode('div');
    const img = new TestNode('img');
    const iframe = new TestNode('iframe');

    expect(
      supportsTimeAnchor({
        host: host as unknown as HTMLElement,
        content: video as unknown as HTMLElement,
      })
    ).toBe(true);

    expect(
      supportsTimeAnchor({
        host: host as unknown as HTMLElement,
        content: audio as unknown as HTMLElement,
      })
    ).toBe(true);

    expect(
      supportsTimeAnchor({
        host: host as unknown as HTMLElement,
        content: div as unknown as HTMLElement,
      })
    ).toBe(false);

    expect(
      supportsTimeAnchor({
        host: host as unknown as HTMLElement,
        content: img as unknown as HTMLElement,
      })
    ).toBe(false);

    expect(
      supportsTimeAnchor({
        host: host as unknown as HTMLElement,
        content: iframe as unknown as HTMLElement,
      })
    ).toBe(false);
  });

  test('clicking a marker on the strip seeks to the timecode and pauses', () => {
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    video.duration = 100;
    video.currentTime = 0;
    video.play();
    host.appendChild(video);

    const surface: AnchorSurface = {
      host: host as unknown as HTMLElement,
      content: video as unknown as HTMLElement,
    };
    const overlay = new TestNode('div');

    timeAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 33 },
      'c-click'
    );

    const marker = overlay.querySelector('[data-comment-id="c-click"]');
    expect(marker).toBeDefined();

    // Clicking the marker seeks there and pauses
    marker?.dispatchEvent('click');
    expect(video.currentTime).toBe(33);
    expect(video.paused).toBe(true);
  });

  test('capture control comments on a frame and closes span on second activation', () => {
    let repainted = 0;
    let opened = 0;
    let focused = 0;
    const controls = buildMarkControls({
      open: () => {
        opened += 1;
      },
      focusBody: () => {
        focused += 1;
      },
      repaint: () => {
        repainted += 1;
      },
    });

    const stage = new TestNode('div');
    const video = new MediaTestNode('video');
    video.className = 'media-player media-video relic-media';
    video.currentTime = 12.4;
    video.play();
    expect(video.paused).toBe(false);
    stage.appendChild(video);

    controls.attach(stage as unknown as HTMLElement);

    const timeToggle = controls.tools.querySelector(
      '.mark-time'
    ) as unknown as TestNode | null;
    expect(timeToggle).toBeDefined();
    expect(timeToggle?.textContent).toBe('Comment on this frame');
    expect(timeToggle?.getAttribute('aria-pressed')).toBe('false');

    // First activation: pauses playback, sets target to 12.4, arms span mode
    timeToggle?.dispatchEvent('click');
    expect(video.paused).toBe(true);
    expect(controls.target()).toEqual({ kind: 'time', t: 12.4 });
    expect(timeToggle?.getAttribute('aria-pressed')).toBe('true');
    expect(timeToggle?.textContent).toBe('Mark end of span');
    expect(opened).toBe(1);
    expect(focused).toBe(1);
    expect(repainted).toBe(1);

    // Player advances to 18.2
    video.currentTime = 18.2;

    // Second activation: closes span at current time
    timeToggle?.dispatchEvent('click');
    expect(controls.target()).toEqual({ kind: 'time', t: 12.4, t_end: 18.2 });
    expect(timeToggle?.getAttribute('aria-pressed')).toBe('false');
    expect(timeToggle?.textContent).toBe('Comment on this frame');

    // Escape cancels span mode if armed, but here span is already disarmed so clear resets
    stage.dispatchEvent('keydown');
    // Calling clear directly
    controls.clear();
    expect(controls.target()).toBeNull();
  });

  test('capture control on audio element uses moment phrasing', () => {
    const controls = buildMarkControls({
      open: () => {},
      focusBody: () => {},
      repaint: () => {},
    });

    const stage = new TestNode('div');
    const audio = new MediaTestNode('audio');
    audio.className = 'media-player media-audio relic-media';
    stage.appendChild(audio);

    controls.attach(stage as unknown as HTMLElement);

    const timeToggle = controls.tools.querySelector('.mark-time');
    expect(timeToggle).toBeDefined();
    expect(timeToggle?.textContent).toBe('Comment on this moment');
  });

  test('escape cancels armed span mode while preserving the moment target', () => {
    let repainted = 0;
    const controls = buildMarkControls({
      open: () => {},
      focusBody: () => {},
      repaint: () => {
        repainted += 1;
      },
    });

    const stage = new TestNode('div');
    const video = new MediaTestNode('video');
    video.className = 'media-player media-video relic-media';
    video.currentTime = 8;
    stage.appendChild(video);

    controls.attach(stage as unknown as HTMLElement);

    const timeToggle = controls.tools.querySelector(
      '.mark-time'
    ) as unknown as TestNode | null;
    timeToggle?.dispatchEvent('click');

    expect(timeToggle?.getAttribute('aria-pressed')).toBe('true');
    expect(controls.target()).toEqual({ kind: 'time', t: 8 });

    // Press Escape to cancel span arming
    const doc = (
      globalThis as unknown as {
        document: {
          dispatchEvent: (event: unknown, detail?: unknown) => boolean;
        };
      }
    ).document;
    doc.dispatchEvent('keydown', { key: 'Escape' });

    // Span mode disarmed
    expect(timeToggle?.getAttribute('aria-pressed')).toBe('false');
    expect(timeToggle?.textContent).toBe('Comment on this frame');
    // But the moment anchor was preserved
    expect(controls.target()).toEqual({ kind: 'time', t: 8 });
    expect(repainted).toBe(1);
  });
});
