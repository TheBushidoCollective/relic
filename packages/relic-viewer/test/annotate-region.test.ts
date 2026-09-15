import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnchorRect, CommentAnchor } from '@relic/format';
import { registerBuiltInAnchorAdapters } from '../src/anchor-adapters.ts';
import {
  type AnchorSurface,
  boxFromUnit,
  contentOffset,
  resetAnchorAdapters,
} from '../src/anchoring.ts';
import { isImageElement, regionAdapter } from '../src/annotate-region.ts';
import { buildMarkControls } from '../src/main.ts';

/**
 * Lightweight DOM stub for testing layout and mouse gestures in Bun.
 *
 * Dispatches events up the tree so that stage-level listeners can respond
 * to mousedown, mousemove, mouseup and click.
 */
class TestNode {
  readonly tagName: string;
  className = '';
  textContent = '';
  id = '';
  type = '';
  scrollLeft = 0;
  scrollTop = 0;
  scrollWidth = 0;
  scrollHeight = 0;
  clientHeight = 800;
  clientWidth = 1000;
  parent: TestNode | undefined;
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  readonly classList = {
    add: (name: string): void => {
      if (!this.classes().includes(name)) {
        this.className = `${this.className} ${name}`.trim();
      }
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

  appendChild(child: TestNode): TestNode {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: TestNode[]): void {
    for (const held of [...this.children]) held.parent = undefined;
    this.children.length = 0;
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    if (this.parent === undefined) return;
    const at = this.parent.children.indexOf(this);
    if (at >= 0) this.parent.children.splice(at, 1);
    this.parent = undefined;
  }

  contains(node: unknown): boolean {
    let walk: TestNode | undefined =
      node instanceof TestNode ? node : undefined;
    while (walk !== undefined) {
      if (walk === this) return true;
      walk = walk.parent;
    }
    return false;
  }

  closest(selector: string): TestNode | null {
    const parts = selector.split(',').map((s) => s.trim());
    let walk: TestNode | undefined = this;
    while (walk !== undefined) {
      for (const part of parts) {
        if (matchesSelector(walk, part)) return walk;
      }
      walk = walk.parent;
    }
    return null;
  }

  querySelectorAll(
    selector: string
  ): TestNode[] & { item(i: number): TestNode | null } {
    const results: TestNode[] = [];
    const walk = (current: TestNode): void => {
      for (const child of current.children) {
        if (matchesSelector(child, selector)) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    Object.defineProperty(results, 'item', {
      value: (i: number) => results[i] ?? null,
    });
    return results as TestNode[] & { item(i: number): TestNode | null };
  }

  querySelector(selector: string): TestNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect(): typeof this.rect {
    return this.rect;
  }

  scrollIntoView(): void {}

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const held = this.listeners.get(type) ?? [];
    held.push(handler);
    this.listeners.set(type, held);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const held = this.listeners.get(type) ?? [];
    const index = held.indexOf(handler);
    if (index >= 0) held.splice(index, 1);
  }

  dispatch(type: string, detail: Record<string, unknown> = {}): void {
    let prevented = false;
    let stopped = false;
    const event = {
      type,
      target: this,
      clientX: 0,
      clientY: 0,
      preventDefault: (): void => {
        prevented = true;
      },
      stopPropagation: (): void => {
        stopped = true;
      },
      get defaultPrevented(): boolean {
        return prevented;
      },
      ...detail,
    };
    let walk: TestNode | undefined = this;
    while (walk !== undefined && !stopped) {
      const handlers = walk.listeners.get(type) ?? [];
      for (const handler of [...handlers]) {
        handler(event);
        if (stopped) break;
      }
      walk = walk.parent;
    }
  }
}

function matchesSingle(node: TestNode, selector: string): boolean {
  const sel = selector.trim();
  if (sel.startsWith('.')) {
    const expected = sel.slice(1);
    if (expected.includes(':not(')) {
      const match = expected.match(/^([a-z0-9_-]+):not\(\.([a-z0-9_-]+)\)$/);
      if (match) {
        const hasClass = node.classList.contains(match[1] as string);
        const hasNotClass = node.classList.contains(match[2] as string);
        return hasClass && !hasNotClass;
      }
    }
    return node.classList.contains(expected);
  }
  if (sel.startsWith('img.')) {
    return node.tagName === 'IMG' && node.classList.contains(sel.slice(4));
  }
  if (sel.startsWith('video.')) {
    return node.tagName === 'VIDEO' && node.classList.contains(sel.slice(6));
  }
  if (sel.startsWith('audio.')) {
    return node.tagName === 'AUDIO' && node.classList.contains(sel.slice(6));
  }
  if (sel.startsWith('iframe.')) {
    return node.tagName === 'IFRAME' && node.classList.contains(sel.slice(7));
  }
  if (sel.startsWith('canvas.')) {
    return node.tagName === 'CANVAS' && node.classList.contains(sel.slice(7));
  }
  return false;
}

function matchesSelector(node: TestNode, selector: string): boolean {
  for (const part of selector.split(',')) {
    if (matchesSingle(node, part)) return true;
  }
  return false;
}

let savedDocument: unknown;
let savedWindow: unknown;
let savedElement: unknown;
let savedHtmlElement: unknown;
const windowListeners = new Map<string, ((event: unknown) => void)[]>();

function setupTestDom(): void {
  savedDocument = (globalThis as { document?: unknown }).document;
  savedWindow = (globalThis as { window?: unknown }).window;
  savedElement = (globalThis as { Element?: unknown }).Element;
  savedHtmlElement = (globalThis as { HTMLElement?: unknown }).HTMLElement;

  windowListeners.clear();

  (globalThis as { Element?: unknown }).Element = TestNode;
  (globalThis as { HTMLElement?: unknown }).HTMLElement = TestNode;
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new TestNode(tag),
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const held = windowListeners.get(type) ?? [];
      held.push(handler);
      windowListeners.set(type, held);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      const held = windowListeners.get(type) ?? [];
      const index = held.indexOf(handler);
      if (index >= 0) held.splice(index, 1);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  (globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const held = windowListeners.get(type) ?? [];
      held.push(handler);
      windowListeners.set(type, held);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      const held = windowListeners.get(type) ?? [];
      const index = held.indexOf(handler);
      if (index >= 0) held.splice(index, 1);
    },
    setTimeout: (run: () => void) => {
      run();
      return 0 as unknown as number;
    },
    getSelection: () => null,
  };
}

function teardownTestDom(): void {
  (globalThis as { document?: unknown }).document = savedDocument;
  (globalThis as { window?: unknown }).window = savedWindow;
  (globalThis as { Element?: unknown }).Element = savedElement;
  (globalThis as { HTMLElement?: unknown }).HTMLElement = savedHtmlElement;
  windowListeners.clear();
}

describe('regionAdapter basic properties', () => {
  test('declares kind as region', () => {
    expect(regionAdapter.kind).toBe('region');
  });

  test('label provides a clean description without reading coordinates', () => {
    const label = regionAdapter.label({
      kind: 'region',
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    });
    expect(label).toBe('Commenting on a region of the image');
  });

  test('supports returns true for image elements and false for others', () => {
    const imgNode = new TestNode('img');
    imgNode.className = 'relic-image';
    const hostNode = new TestNode('div');

    const imageSurface: AnchorSurface = {
      host: hostNode as unknown as HTMLElement,
      content: imgNode as unknown as HTMLElement,
    };
    expect(regionAdapter.supports(imageSurface)).toBe(true);

    const videoNode = new TestNode('video');
    const videoSurface: AnchorSurface = {
      host: hostNode as unknown as HTMLElement,
      content: videoNode as unknown as HTMLElement,
    };
    expect(regionAdapter.supports(videoSurface)).toBe(false);

    const divSurface: AnchorSurface = {
      host: hostNode as unknown as HTMLElement,
      content: hostNode as unknown as HTMLElement,
    };
    expect(regionAdapter.supports(divSurface)).toBe(false);
  });

  test('isImageElement identifies img elements and rejects other values', () => {
    const img = new TestNode('img');
    expect(isImageElement(img)).toBe(true);
    const div = new TestNode('div');
    expect(isImageElement(div)).toBe(false);
    expect(isImageElement(null)).toBe(false);
    expect(isImageElement(undefined)).toBe(false);
    expect(isImageElement('not an element')).toBe(false);
  });
});

describe('the headline guarantee', () => {
  test('the same region anchor painted against two different content-box sizes lands on the same fraction of the picture, and a stage-relative implementation would not', () => {
    // Under letterboxing, the image occupies different coordinates inside the stage.
    // Wide viewport: 1200x800 host with an 800x800 image centered (horizontal letterboxing: 200px margins).
    const wideHost = new TestNode('div');
    wideHost.rect = {
      left: 0,
      top: 0,
      right: 1200,
      bottom: 800,
      width: 1200,
      height: 800,
    };
    const wideImg = new TestNode('img');
    wideImg.rect = {
      left: 200,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 800,
      height: 800,
    };
    wideHost.appendChild(wideImg);

    const wideSurface: AnchorSurface = {
      host: wideHost as unknown as HTMLElement,
      content: wideImg as unknown as HTMLElement,
    };

    // Narrow viewport: 600x800 host with a 600x600 image centered (vertical letterboxing: 100px margins).
    const narrowHost = new TestNode('div');
    narrowHost.rect = {
      left: 0,
      top: 0,
      right: 600,
      bottom: 800,
      width: 600,
      height: 800,
    };
    const narrowImg = new TestNode('img');
    narrowImg.rect = {
      left: 0,
      top: 100,
      right: 600,
      bottom: 700,
      width: 600,
      height: 600,
    };
    narrowHost.appendChild(narrowImg);

    const narrowSurface: AnchorSurface = {
      host: narrowHost as unknown as HTMLElement,
      content: narrowImg as unknown as HTMLElement,
    };

    // The user anchored a specific feature: top-left quarter of the picture.
    const anchorRect: AnchorRect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const anchor: Extract<CommentAnchor, { kind: 'region' }> = {
      kind: 'region',
      rect: anchorRect,
    };

    const wideBox = boxFromUnit(wideSurface, anchor.rect);
    expect(wideBox).toBeDefined();
    if (!wideBox) return;

    const narrowBox = boxFromUnit(narrowSurface, anchor.rect);
    expect(narrowBox).toBeDefined();
    if (!narrowBox) return;

    // Measure the fraction of the picture covered by the painted mark in both sizes:
    const wideContentBox = contentOffset(wideSurface);
    const wideFraction = {
      x: (wideBox.left - wideContentBox.left) / wideContentBox.width,
      y: (wideBox.top - wideContentBox.top) / wideContentBox.height,
      w: wideBox.width / wideContentBox.width,
      h: wideBox.height / wideContentBox.height,
    };

    const narrowContentBox = contentOffset(narrowSurface);
    const narrowFraction = {
      x: (narrowBox.left - narrowContentBox.left) / narrowContentBox.width,
      y: (narrowBox.top - narrowContentBox.top) / narrowContentBox.height,
      w: narrowBox.width / narrowContentBox.width,
      h: narrowBox.height / narrowContentBox.height,
    };

    // The content-box rule ensures both viewports map to the exact same feature of the picture:
    expect(wideFraction).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(narrowFraction).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });

    // Now contrast with a stage-relative calculation (measuring against host instead of content):
    const stageRelativeWideBox = {
      left: wideHost.rect.left + anchor.rect.x * wideHost.rect.width,
      top: wideHost.rect.top + anchor.rect.y * wideHost.rect.height,
      width: anchor.rect.w * wideHost.rect.width,
      height: anchor.rect.h * wideHost.rect.height,
    };
    // On the picture, this stage-relative box lands at an incorrect position:
    const stageRelativeWidePictureFractionX =
      (stageRelativeWideBox.left - wideContentBox.left) / wideContentBox.width;
    // 0.25 * 1200 = 300. (300 - 200) / 800 = 0.125, which shifts off the feature by 50%.
    expect(stageRelativeWidePictureFractionX).toBe(0.125);
    expect(stageRelativeWidePictureFractionX).not.toBe(0.25);

    const stageRelativeNarrowBox = {
      left: narrowHost.rect.left + anchor.rect.x * narrowHost.rect.width,
      top: narrowHost.rect.top + anchor.rect.y * narrowHost.rect.height,
      width: anchor.rect.w * narrowHost.rect.width,
      height: anchor.rect.h * narrowHost.rect.height,
    };
    const stageRelativeNarrowPictureFractionY =
      (stageRelativeNarrowBox.top - narrowContentBox.top) /
      narrowContentBox.height;
    // 0.25 * 800 = 200. (200 - 100) / 600 = 0.1666..., which shifts off the feature by 33%.
    expect(stageRelativeNarrowPictureFractionY).toBeCloseTo(0.1666, 3);
    expect(stageRelativeNarrowPictureFractionY).not.toBe(0.25);
  });
});

describe('region painting and unloaded image handling', () => {
  beforeEach(() => {
    setupTestDom();
  });

  afterEach(() => {
    teardownTestDom();
  });

  test('paint returns false for an image with no area rather than painting at the origin', () => {
    const hostNode = new TestNode('div');
    hostNode.rect = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
    };
    const unloadedImg = new TestNode('img');
    // An unloaded image has 0 width and height before layout:
    unloadedImg.rect = {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    };
    hostNode.appendChild(unloadedImg);

    const surface: AnchorSurface = {
      host: hostNode as unknown as HTMLElement,
      content: unloadedImg as unknown as HTMLElement,
    };

    const overlay = new TestNode('div');
    const result = regionAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'region', rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 } },
      'comment-unloaded'
    );

    expect(result).toBe(false);
    expect(overlay.children).toHaveLength(0);
  });

  test('paint appends comment-region with correct coordinates and visible number badge', () => {
    const hostNode = new TestNode('div');
    hostNode.rect = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
    };
    const img = new TestNode('img');
    img.rect = {
      left: 100,
      top: 100,
      right: 700,
      bottom: 500,
      width: 600,
      height: 400,
    };
    hostNode.appendChild(img);

    const surface: AnchorSurface = {
      host: hostNode as unknown as HTMLElement,
      content: img as unknown as HTMLElement,
    };

    const overlay = new TestNode('div');
    const result = regionAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'region', rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } },
      'comment-test-1'
    );

    expect(result).toBe(true);
    expect(overlay.children).toHaveLength(1);

    const painted = overlay.children[0] as TestNode;
    expect(painted.classList.contains('comment-region')).toBe(true);
    expect(painted.dataset.commentId).toBe('comment-test-1');
    // Expected: left = 100 + 0.1 * 600 = 160px; top = 100 + 0.2 * 400 = 180px;
    // width = 0.5 * 600 = 300px; height = 0.4 * 400 = 160px.
    expect(painted.style.left).toBe('160px');
    expect(painted.style.top).toBe('180px');
    expect(painted.style.width).toBe('300px');
    expect(painted.style.height).toBe('160px');

    // Number badge inside:
    const badge = painted.children[0] as TestNode;
    expect(badge.classList.contains('comment-region-badge')).toBe(true);
    expect(badge.textContent).toBe('1');
  });

  test('pending region mark carries is-pending class and no badge', () => {
    const hostNode = new TestNode('div');
    hostNode.rect = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
    };
    const img = new TestNode('img');
    img.rect = {
      left: 100,
      top: 100,
      right: 700,
      bottom: 500,
      width: 600,
      height: 400,
    };
    hostNode.appendChild(img);

    const surface: AnchorSurface = {
      host: hostNode as unknown as HTMLElement,
      content: img as unknown as HTMLElement,
    };

    const overlay = new TestNode('div');
    const result = regionAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'region', rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } },
      'pending:target'
    );

    expect(result).toBe(true);
    const painted = overlay.children[0] as TestNode;
    expect(painted.classList.contains('is-pending')).toBe(true);
    expect(painted.children).toHaveLength(0);
  });
});

describe('drag gesture and capture behavior', () => {
  beforeEach(() => {
    setupTestDom();
    resetAnchorAdapters();
  });

  afterEach(() => {
    teardownTestDom();
    // Restore rather than clear. The adapter table is process-wide and bun
    // runs every test file in one process, so an empty table here is an empty
    // table for every file that runs after this one. Leaving it cleared broke
    // an unrelated assertion in `annotate.test.ts`, where a quote's composer
    // chip silently fell back to saying the page cannot show the mark.
    registerBuiltInAnchorAdapters();
  });

  test('a drag on an armed image produces a region anchor', () => {
    let repaints = 0;
    let opened = false;
    let focused = false;

    const controls = buildMarkControls({
      open: () => {
        opened = true;
      },
      focusBody: () => {
        focused = true;
      },
      repaint: () => {
        repaints += 1;
      },
    });

    const stage = new TestNode('div');
    stage.rect = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
    };

    const img = new TestNode('img');
    img.className = 'relic-image';
    img.rect = {
      left: 200,
      top: 100,
      right: 800,
      bottom: 500,
      width: 600,
      height: 400,
    };
    stage.appendChild(img);

    const pins = new TestNode('div');
    pins.className = 'comment-pins';
    stage.appendChild(pins);

    controls.attach(stage as unknown as HTMLElement);

    // Arm the tool by clicking the toggle button:
    const modeBtn = (controls.tools as unknown as TestNode)
      .children[0] as TestNode;
    expect(modeBtn.classList.contains('mark-mode')).toBe(true);
    modeBtn.dispatch('click');
    expect(modeBtn.getAttribute('aria-pressed')).toBe('true');

    // Start drag inside image at (320, 180):
    // Unit coordinate: (320 - 200) / 600 = 0.2; (180 - 100) / 400 = 0.2.
    stage.dispatch('mousedown', { clientX: 320, clientY: 180 });

    // Drag to (560, 340):
    // Unit coordinate: (560 - 200) / 600 = 0.6; (340 - 100) / 400 = 0.6.
    stage.dispatch('mousemove', { clientX: 560, clientY: 340 });

    // Release mouse:
    stage.dispatch('mouseup', { clientX: 560, clientY: 340 });

    const target = controls.target();
    expect(target).not.toBeNull();
    expect(target?.kind).toBe('region');
    if (target?.kind === 'region') {
      expect(target.rect.x).toBeCloseTo(0.2, 4);
      expect(target.rect.y).toBeCloseTo(0.2, 4);
      expect(target.rect.w).toBeCloseTo(0.4, 4);
      expect(target.rect.h).toBeCloseTo(0.4, 4);
    }

    expect(opened).toBe(true);
    expect(focused).toBe(true);
    expect(repaints).toBeGreaterThan(0);
    // Tool disarms on successful placement:
    expect(modeBtn.getAttribute('aria-pressed')).toBe('false');
  });

  test('a drag ending in the letterbox beside the image does not produce an anchor', () => {
    const controls = buildMarkControls({
      open: () => {},
      focusBody: () => {},
      repaint: () => {},
    });

    const stage = new TestNode('div');
    stage.rect = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
    };

    const img = new TestNode('img');
    img.className = 'relic-image';
    // Image occupies 200 to 800 horizontally. 0 to 200 is the left letterbox.
    img.rect = {
      left: 200,
      top: 100,
      right: 800,
      bottom: 500,
      width: 600,
      height: 400,
    };
    stage.appendChild(img);

    const pins = new TestNode('div');
    pins.className = 'comment-pins';
    stage.appendChild(pins);

    controls.attach(stage as unknown as HTMLElement);
    const modeBtn = (controls.tools as unknown as TestNode)
      .children[0] as TestNode;
    modeBtn.dispatch('click');
    expect(modeBtn.getAttribute('aria-pressed')).toBe('true');

    // Start drag inside image at (320, 180):
    stage.dispatch('mousedown', { clientX: 320, clientY: 180 });

    // Drag into left letterbox at clientX 50 (outside image):
    stage.dispatch('mousemove', { clientX: 50, clientY: 180 });

    // Release in the letterbox:
    stage.dispatch('mouseup', { clientX: 50, clientY: 180 });

    // Drag ending in letterbox must not produce an anchor:
    expect(controls.target()).toBeNull();
    // Tool remains armed because nothing was placed:
    expect(modeBtn.getAttribute('aria-pressed')).toBe('true');
  });

  test('a plain click without dragging on an armed image places a pin anchor', () => {
    const controls = buildMarkControls({
      open: () => {},
      focusBody: () => {},
      repaint: () => {},
    });

    const stage = new TestNode('div');
    stage.rect = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
    };
    stage.scrollWidth = 1000;
    stage.scrollHeight = 800;

    const img = new TestNode('img');
    img.className = 'relic-image';
    img.rect = {
      left: 200,
      top: 100,
      right: 800,
      bottom: 500,
      width: 600,
      height: 400,
    };
    stage.appendChild(img);

    controls.attach(stage as unknown as HTMLElement);
    const modeBtn = (controls.tools as unknown as TestNode)
      .children[0] as TestNode;
    modeBtn.dispatch('click');
    expect(modeBtn.getAttribute('aria-pressed')).toBe('true');

    // Plain click at (400, 300) without drag:
    stage.dispatch('click', { clientX: 400, clientY: 300 });

    const target = controls.target();
    expect(target).not.toBeNull();
    // Plain click places a point (pin), not a region:
    expect(target?.kind).toBe('pin');
    if (target?.kind === 'pin') {
      expect(target.x).toBe(0.4);
      expect(target.y).toBe(0.375);
    }
  });

  test('a drag starting in the letterbox does not start a drag', () => {
    const controls = buildMarkControls({
      open: () => {},
      focusBody: () => {},
      repaint: () => {},
    });

    const stage = new TestNode('div');
    stage.rect = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
    };

    const img = new TestNode('img');
    img.className = 'relic-image';
    img.rect = {
      left: 200,
      top: 100,
      right: 800,
      bottom: 500,
      width: 600,
      height: 400,
    };
    stage.appendChild(img);

    controls.attach(stage as unknown as HTMLElement);
    const modeBtn = (controls.tools as unknown as TestNode)
      .children[0] as TestNode;
    modeBtn.dispatch('click');

    // Mousedown in the letterbox at clientX 80:
    stage.dispatch('mousedown', { clientX: 80, clientY: 200 });

    // Drag into the image at clientX 400:
    stage.dispatch('mousemove', { clientX: 400, clientY: 200 });
    stage.dispatch('mouseup', { clientX: 400, clientY: 200 });

    // No drag originated from the image, so no anchor was produced:
    expect(controls.target()).toBeNull();
    expect(modeBtn.getAttribute('aria-pressed')).toBe('true');
  });
});
