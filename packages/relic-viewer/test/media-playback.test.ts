import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildCurrentStage, renderMediaView } from '../src/main.ts';
import { type ReadyView, routeForClass } from '../src/viewer.ts';

class ElementStub {
  readonly tagName: string;
  className = '';
  textContent = '';
  innerHTML = '';
  hidden = false;
  tabIndex = 0;
  type = '';
  title = '';
  min = '';
  max = '';
  value = '';
  src = '';
  controls = false;
  playsInline = false;
  preload = '';
  download = '';
  href = '';
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly style = { setProperty: (): void => {} };
  readonly classList = {
    add: (name: string): void => {
      this.className = `${this.className} ${name}`.trim();
    },
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'controls') this.controls = true;
    if (name === 'playsinline') this.playsInline = true;
    if (name === 'preload') this.preload = value;
    if (name === 'src') this.src = value;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'controls') this.controls = false;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild(child: ElementStub): ElementStub {
    this.children.push(child);
    return child;
  }

  append(...children: ElementStub[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: ElementStub[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  addEventListener(
    event: string,
    listener: (...args: unknown[]) => void
  ): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  removeEventListener(
    event: string,
    listener: (...args: unknown[]) => void
  ): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const idx = list.indexOf(listener);
    if (idx >= 0) list.splice(idx, 1);
  }

  dispatchEvent(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  click(): void {
    this.dispatchEvent('click');
  }

  remove(): void {}
}

function descendants(element: ElementStub): ElementStub[] {
  return [element, ...element.children.flatMap(descendants)];
}

function textOf(element: ElementStub): string {
  return [element.textContent, ...element.children.map(textOf)]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeMediaView(options: {
  filename: string;
  declaredMimetype: string;
  content?: Uint8Array;
}): ReadyView {
  return {
    filename: options.filename,
    declaredMimetype: options.declaredMimetype,
    content: options.content ?? new Uint8Array([0, 1, 2, 3, 4]),
    route: 'media',
    downgradeNotice: undefined,
    shareUrl: 'https://relik.example/test#key',
    version: 1,
    currentVersion: 1,
  };
}

describe('media playback support', () => {
  let createdUrls: string[] = [];
  let revokedUrls: string[] = [];
  const origCreateObjectUrl = URL.createObjectURL;
  const origRevokeObjectUrl = URL.revokeObjectURL;

  beforeEach(() => {
    createdUrls = [];
    revokedUrls = [];
    URL.createObjectURL = (_blob: Blob): string => {
      const url = `blob:test-media-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string): void => {
      revokedUrls.push(url);
    };

    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => new ElementStub(tag),
      createElementNS: (_namespace: string, tag: string) =>
        new ElementStub(tag),
      addEventListener: () => {},
      body: new ElementStub('body'),
      contains: () => true,
    };
    (globalThis as { window?: unknown }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  afterEach(() => {
    URL.createObjectURL = origCreateObjectUrl;
    URL.revokeObjectURL = origRevokeObjectUrl;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
  });

  test("routeForClass('media') returns 'media'", () => {
    expect(routeForClass('media')).toBe('media');
  });

  test('buildCurrentStage for video view produces container with video element', () => {
    const view = makeMediaView({
      filename: 'sample.mp4',
      declaredMimetype: 'video/mp4',
      content: new Uint8Array([10, 20, 30]),
    });

    const stage = buildCurrentStage(
      view,
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    expect(stage.className).toContain('stage-media');

    const container = descendants(stage).find(
      (element) => element.className === 'doc doc-media'
    );
    expect(container).toBeDefined();
    if (!container) return;

    const video = container.children.find((child) => child.tagName === 'VIDEO');
    expect(video).toBeDefined();
    if (!video) return;

    expect(video.className).toContain('media-player media-video');
    expect(video.className).toContain('relic-media');
    expect(video.controls).toBe(false);
    expect(video.hasAttribute('controls')).toBe(false);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.src).toMatch(/^blob:test-media-/);
    expect(createdUrls).toContain(video.src);

    const strip = container.children.find(
      (child) => child.className === 'media-meta-strip'
    );
    expect(strip).toBeDefined();
    if (!strip) return;

    const stripText = textOf(strip);
    expect(stripText).toContain('sample.mp4');
    expect(stripText).toContain('video/mp4');
    expect(stripText).toContain('Download');
  });

  test('buildCurrentStage for audio view produces container with audio element', () => {
    const view = makeMediaView({
      filename: 'recording.mp3',
      declaredMimetype: 'audio/mpeg',
      content: new Uint8Array([1, 2, 3, 4, 5]),
    });

    const stage = buildCurrentStage(
      view,
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    const container = descendants(stage).find(
      (element) => element.className === 'doc doc-media'
    );
    expect(container).toBeDefined();
    if (!container) return;

    const audio = container.children.find((child) => child.tagName === 'AUDIO');
    expect(audio).toBeDefined();
    if (!audio) return;

    expect(audio.className).toContain('media-player media-audio');
    expect(audio.className).toContain('relic-media');
    expect(audio.controls).toBe(false);
    expect(audio.hasAttribute('controls')).toBe(false);
    expect(audio.getAttribute('preload')).toBe('metadata');
    expect(audio.src).toMatch(/^blob:test-media-/);
    expect(createdUrls).toContain(audio.src);

    const strip = container.children.find(
      (child) => child.className === 'media-meta-strip'
    );
    expect(strip).toBeDefined();
    if (!strip) return;

    const stripText = textOf(strip);
    expect(stripText).toContain('recording.mp3');
    expect(stripText).toContain('audio/mpeg');
    expect(stripText).toContain('Download');
  });

  test('renderMediaView revokes object URL on cleanup event', () => {
    const view = makeMediaView({
      filename: 'podcast.wav',
      declaredMimetype: 'audio/wav',
    });

    const container = renderMediaView(view) as unknown as ElementStub;
    expect(createdUrls.length).toBe(1);
    expect(revokedUrls.length).toBe(0);

    container.dispatchEvent('cleanup');
    expect(revokedUrls).toEqual(createdUrls);
  });
});
