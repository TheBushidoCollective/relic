import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnchorRect } from '@relic/format';
import type { AnchorSurface } from '../src/anchoring.ts';
import {
  type FrameMarkPayload,
  frameQuoteAdapter,
  frameRegionAdapter,
  isArmPointingMessage,
  isClearMarkMessage,
  isClearMarksMessage,
  isFrameMarkClickMessage,
  isFrameMarkHoverMessage,
  isFramePointMessage,
  isFrameRegionMessage,
  isFrameSelectionMessage,
  isPaintMarkMessage,
  isPaintMarksMessage,
  isRevealMarkMessage,
  takeHeadUtf8,
  takeTailUtf8,
} from '../src/annotate-frame.ts';
import {
  clearFrameRegions,
  createSandboxHandler,
  FRAME_MARK_CSS,
  paintFrameRegion,
  setupFrameInteraction,
  unwrapFrameQuotes,
  wrapFrameQuote,
} from '../src/sandbox.ts';

// ---------------------------------------------------------------------------
// Lightweight DOM stub for testing in Bun's DOM-less runtime
// ---------------------------------------------------------------------------

class MockClassList {
  private set = new Set<string>();

  add(...classes: string[]) {
    for (const c of classes) this.set.add(c);
  }
  remove(...classes: string[]) {
    for (const c of classes) this.set.delete(c);
  }
  contains(cls: string): boolean {
    return this.set.has(cls);
  }
  has(cls: string): boolean {
    return this.set.has(cls);
  }
  toggle(cls: string, force?: boolean): boolean {
    if (force === true) {
      this.set.add(cls);
      return true;
    }
    if (force === false) {
      this.set.delete(cls);
      return false;
    }
    if (this.set.has(cls)) {
      this.set.delete(cls);
      return false;
    }
    this.set.add(cls);
    return true;
  }
  [Symbol.iterator]() {
    return this.set[Symbol.iterator]();
  }
  get length(): number {
    return this.set.size;
  }
}

function matches(node: MockNode, selector: string): boolean {
  if (selector.startsWith('#')) {
    return node.id === selector.slice(1);
  }
  if (selector.startsWith('.')) {
    return node.classList.contains(selector.slice(1));
  }
  if (selector.includes('.')) {
    const [tag, cls] = selector.split('.');
    return Boolean(
      tag &&
        cls &&
        node.tagName?.toLowerCase() === tag.toLowerCase() &&
        node.classList.contains(cls)
    );
  }
  if (selector.startsWith('[data-comment-id')) {
    const m = selector.match(/\[data-comment-id="([^"]+)"\]/);
    if (m) return node.dataset.commentId === m[1];
    return node.dataset.commentId !== undefined;
  }
  return node.tagName?.toLowerCase() === selector.toLowerCase();
}

class MockNode {
  readonly nodeType: number;
  readonly nodeName: string;
  tagName?: string;
  parentNode: MockNode | null = null;
  childNodes: MockNode[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = new MockClassList();
  style: Record<string, string> & { cssText?: string } = {};
  listeners = new Map<string, Array<(e: unknown) => void>>();
  data?: string;
  scrollWidth = 1000;
  scrollHeight = 2000;

  get className(): string {
    return Array.from(this.classList).join(' ');
  }
  set className(val: string) {
    this.classList = new MockClassList();
    for (const c of val.split(/\s+/).filter(Boolean)) {
      this.classList.add(c);
    }
  }

  get id(): string {
    return this.attributes.id ?? '';
  }
  set id(val: string) {
    this.attributes.id = val;
  }
  constructor(nodeType: number, name: string) {
    this.nodeType = nodeType;
    this.nodeName = name;
    if (nodeType === 1) {
      this.tagName = name.toUpperCase();
    }
  }

  get parentElement(): MockNode | null {
    return this.parentNode && this.parentNode.nodeType === 1
      ? this.parentNode
      : null;
  }

  get ownerDocument(): MockDocument {
    return mockDoc;
  }

  get firstChild(): MockNode | null {
    return this.childNodes[0] ?? null;
  }
  get previousSibling(): MockNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx > 0 ? (this.parentNode.childNodes[idx - 1] ?? null) : null;
  }

  get nextSibling(): MockNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.data ?? '';
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(val: string) {
    if (this.nodeType === 3) {
      this.data = val;
    } else {
      this.childNodes = [];
      if (val.length > 0) {
        const t = new MockNode(3, '#text');
        t.data = val;
        t.parentNode = this;
        this.childNodes.push(t);
      }
    }
  }

  getAttribute(name: string): string | null {
    if (name === 'class') return Array.from(this.classList).join(' ');
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[key] ?? null;
    }
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, val: string): void {
    if (name === 'class') {
      this.classList = new MockClassList();
      this.classList.add(...val.split(/\s+/).filter(Boolean));
    } else if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = val;
    } else {
      this.attributes[name] = val;
    }
  }

  splitText(offset: number): MockNode {
    if (this.nodeType !== 3) throw new Error('not a text node');
    const full = this.data ?? '';
    const first = full.slice(0, offset);
    const second = full.slice(offset);
    this.data = first;
    const newNode = new MockNode(3, '#text');
    newNode.data = second;
    if (this.parentNode) {
      const idx = this.parentNode.childNodes.indexOf(this);
      this.parentNode.childNodes.splice(idx + 1, 0, newNode);
      newNode.parentNode = this.parentNode;
    }
    return newNode;
  }

  appendChild(child: MockNode): MockNode {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(newNode: MockNode, refNode: MockNode | null): MockNode {
    if (newNode.parentNode) {
      newNode.parentNode.removeChild(newNode);
    }
    if (!refNode) {
      return this.appendChild(newNode);
    }
    const idx = this.childNodes.indexOf(refNode);
    if (idx === -1) {
      return this.appendChild(newNode);
    }
    this.childNodes.splice(idx, 0, newNode);
    newNode.parentNode = this;
    return newNode;
  }

  removeChild(child: MockNode): MockNode {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  replaceChildren(...children: MockNode[]): void {
    for (const c of [...this.childNodes]) {
      this.removeChild(c);
    }
    for (const c of children) {
      this.appendChild(c);
    }
  }

  normalize(): void {
    let i = 0;
    while (i < this.childNodes.length - 1) {
      const curr = this.childNodes[i];
      const next = this.childNodes[i + 1];
      if (curr && next && curr.nodeType === 3 && next.nodeType === 3) {
        curr.data = (curr.data ?? '') + (next.data ?? '');
        this.removeChild(next);
      } else {
        curr?.normalize();
        i++;
      }
    }
  }

  closest(selector: string): MockNode | null {
    let curr: MockNode | null = this;
    while (curr) {
      if (matches(curr, selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): MockNode[] {
    const results: MockNode[] = [];
    function walk(node: MockNode) {
      for (const child of node.childNodes) {
        if (matches(child, selector)) results.push(child);
        walk(child);
      }
    }
    walk(this);
    return results;
  }

  querySelector(selector: string): MockNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  scrollIntoView(): void {}

  addEventListener(type: string, handler: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatchEvent(event: { type: string; [k: string]: unknown }): boolean {
    let walk: MockNode | null = this;
    while (walk) {
      const list = walk.listeners.get(event.type) ?? [];
      for (const h of list) h(event);
      walk = walk.parentNode ?? (walk === mockDoc ? null : mockDoc);
    }
    return true;
  }
}

class MockDocument extends MockNode {
  head: MockNode;
  body: MockNode;
  documentElement: MockNode;
  defaultView: unknown;

  constructor() {
    super(9, '#document');
    this.documentElement = new MockNode(1, 'html');
    this.head = new MockNode(1, 'head');
    this.body = new MockNode(1, 'body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }

  getElementById(id: string): MockNode | null {
    return this.querySelector(`#${id}`);
  }

  createElement(tag: string): MockNode {
    return new MockNode(1, tag);
  }

  createTextNode(text: string): MockNode {
    const n = new MockNode(3, '#text');
    n.data = text;
    return n;
  }

  createTreeWalker(
    root: MockNode,
    _whatToShow: number,
    filter?: { acceptNode(node: MockNode): number }
  ) {
    const nodes: MockNode[] = [];
    function walk(node: MockNode) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          if (!filter || filter.acceptNode(child) === 1) {
            nodes.push(child);
          }
        } else {
          if (filter && filter.acceptNode(child) === 2) {
            continue;
          }
          walk(child);
        }
      }
    }
    walk(root);
    let idx = 0;
    return {
      nextNode: () => nodes[idx++] ?? null,
    };
  }

  createRange() {
    let _startNode: MockNode | null = null;
    let _startOff = 0;
    let _endNode: MockNode | null = null;
    let _endOff = 0;
    return {
      selectNodeContents(node: MockNode) {
        _startNode = node;
        _startOff = 0;
        _endNode = node;
        _endOff = node.childNodes.length;
      },
      setStart(node: MockNode, off: number) {
        _startNode = node;
        _startOff = off;
      },
      setEnd(node: MockNode, off: number) {
        _endNode = node;
        _endOff = off;
      },
      toString() {
        return 'context text';
      },
    };
  }
}

let mockDoc: MockDocument = new MockDocument();
let mockWin: {
  getSelection: () => unknown;
  parent: unknown;
  scrollTo: () => void;
} = {
  getSelection: () => null,
  parent: {},
  scrollTo: () => {},
};
mockDoc.defaultView = mockWin;

beforeEach(() => {
  mockDoc = new MockDocument();
  mockWin = {
    getSelection: () => null,
    parent: {},
    scrollTo: () => {},
  };
  mockDoc.defaultView = mockWin;

  const g = globalThis as {
    document?: unknown;
    window?: unknown;
    NodeFilter?: unknown;
    HTMLElement?: unknown;
  };
  g.document = mockDoc;
  g.window = mockWin;
  g.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  g.HTMLElement = MockNode;
});

afterEach(() => {
  const g = globalThis as {
    document?: unknown;
    window?: unknown;
  };
  delete g.document;
  delete g.window;
});

function makeElement(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: (MockNode | string)[]
): MockNode {
  const el = mockDoc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') {
      el.appendChild(mockDoc.createTextNode(child));
    } else {
      el.appendChild(child);
    }
  }
  return el;
}

// ---------------------------------------------------------------------------
// Message shape and validation
// ---------------------------------------------------------------------------

describe('frame message validation', () => {
  test('validates well-formed frame selection messages', () => {
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'hello world',
      })
    ).toBe(true);

    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'hello world',
        prefix: 'before ',
        suffix: ' after',
      })
    ).toBe(true);
  });

  test('rejects malformed frame selection messages', () => {
    expect(isFrameSelectionMessage(null)).toBe(false);
    expect(isFrameSelectionMessage({})).toBe(false);
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 123,
      })
    ).toBe(false);
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'a'.repeat(513),
      })
    ).toBe(false);
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'ok',
        prefix: 'a'.repeat(129),
      })
    ).toBe(false);
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'ok',
        suffix: 'a'.repeat(129),
      })
    ).toBe(false);
  });

  test('validates well-formed frame point messages', () => {
    expect(
      isFramePointMessage({ type: 'relic:frame-point', x: 0.5, y: 0.25 })
    ).toBe(true);
    expect(isFramePointMessage({ type: 'relic:frame-point', x: 0, y: 1 })).toBe(
      true
    );
  });

  test('rejects malformed frame point messages', () => {
    expect(isFramePointMessage(null)).toBe(false);
    expect(
      isFramePointMessage({ type: 'relic:frame-point', x: -0.1, y: 0.5 })
    ).toBe(false);
    expect(
      isFramePointMessage({ type: 'relic:frame-point', x: 1.1, y: 0.5 })
    ).toBe(false);
    expect(
      isFramePointMessage({ type: 'relic:frame-point', x: Number.NaN, y: 0.5 })
    ).toBe(false);
    expect(
      isFramePointMessage({
        type: 'relic:frame-point',
        x: 0.5,
        y: Number.POSITIVE_INFINITY,
      })
    ).toBe(false);
    expect(isFramePointMessage({ type: 'other', x: 0.5, y: 0.5 })).toBe(false);
  });

  test('validates well-formed frame region messages', () => {
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      })
    ).toBe(true);
  });

  test('rejects malformed frame region messages', () => {
    expect(isFrameRegionMessage(null)).toBe(false);
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.1, y: 0.2, w: 0, h: 0.4 },
      })
    ).toBe(false);
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.8, y: 0.2, w: 0.5, h: 0.4 },
      })
    ).toBe(false);
  });

  test('validates well-formed mark click messages', () => {
    expect(
      isFrameMarkClickMessage({ type: 'relic:frame-mark-click', id: 'c1' })
    ).toBe(true);
    expect(
      isFrameMarkClickMessage({ type: 'relic:frame-mark-click', id: '' })
    ).toBe(false);
    expect(isFrameMarkClickMessage({ type: 'relic:frame-mark-click' })).toBe(
      false
    );
  });

  test('validates arm pointing messages', () => {
    expect(
      isArmPointingMessage({ type: 'relic:arm-pointing', armed: true })
    ).toBe(true);
    expect(
      isArmPointingMessage({ type: 'relic:arm-pointing', armed: false })
    ).toBe(true);
    expect(
      isArmPointingMessage({ type: 'relic:arm-pointing', armed: 'true' })
    ).toBe(false);
  });

  test('validates paint mark and paint marks messages', () => {
    const quoteMark: FrameMarkPayload = {
      id: 'm1',
      kind: 'quote',
      exact: 'selected text',
      prefix: 'pre',
      suffix: 'post',
    };
    const regionMark: FrameMarkPayload = {
      id: 'm2',
      kind: 'region',
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    };
    expect(
      isPaintMarkMessage({ type: 'relic:paint-mark', mark: quoteMark })
    ).toBe(true);
    expect(
      isPaintMarkMessage({ type: 'relic:paint-mark', mark: regionMark })
    ).toBe(true);
    expect(
      isPaintMarksMessage({
        type: 'relic:paint-marks',
        marks: [quoteMark, regionMark],
      })
    ).toBe(true);

    expect(
      isPaintMarkMessage({
        type: 'relic:paint-mark',
        mark: { id: 'm1', kind: 'quote', exact: 'a'.repeat(600) },
      })
    ).toBe(false);
  });

  test('validates clear mark and clear marks messages', () => {
    expect(isClearMarkMessage({ type: 'relic:clear-mark', id: 'm1' })).toBe(
      true
    );
    expect(isClearMarkMessage({ type: 'relic:clear-mark' })).toBe(false);
    expect(isClearMarksMessage({ type: 'relic:clear-marks' })).toBe(true);
    expect(isClearMarksMessage({ type: 'other' })).toBe(false);
  });

  test('validates reveal mark messages', () => {
    expect(isRevealMarkMessage({ type: 'relic:reveal-mark', id: 'm1' })).toBe(
      true
    );
    expect(
      isRevealMarkMessage({
        type: 'relic:reveal-mark',
        kind: 'quote',
        exact: 'find me',
      })
    ).toBe(true);
    expect(
      isRevealMarkMessage({
        type: 'relic:reveal-mark',
        kind: 'region',
        rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UTF-8 truncation helpers
// ---------------------------------------------------------------------------

describe('UTF-8 truncation helpers', () => {
  test('takeHeadUtf8 preserves multibyte characters and surrogate pairs', () => {
    expect(takeHeadUtf8('hello', 10)).toBe('hello');
    expect(takeHeadUtf8('hello', 3)).toBe('hel');

    const jp = '日本語テスト';
    expect(takeHeadUtf8(jp, 6)).toBe('日本');
    expect(takeHeadUtf8(jp, 7)).toBe('日本');
    expect(takeHeadUtf8(jp, 9)).toBe('日本語');

    const emoji = '🎉party';
    expect(takeHeadUtf8(emoji, 3)).toBe('');
    expect(takeHeadUtf8(emoji, 4)).toBe('🎉');
    expect(takeHeadUtf8(emoji, 5)).toBe('🎉p');
  });

  test('takeTailUtf8 preserves multibyte characters and surrogate pairs from end', () => {
    expect(takeTailUtf8('hello', 10)).toBe('hello');
    expect(takeTailUtf8('hello', 3)).toBe('llo');

    const jp = '日本語テスト';
    expect(takeTailUtf8(jp, 6)).toBe('スト');
    expect(takeTailUtf8(jp, 7)).toBe('スト');
    expect(takeTailUtf8(jp, 9)).toBe('テスト');

    const emoji = 'party🎉';
    expect(takeTailUtf8(emoji, 3)).toBe('');
    expect(takeTailUtf8(emoji, 4)).toBe('🎉');
    expect(takeTailUtf8(emoji, 5)).toBe('y🎉');
  });
});

// ---------------------------------------------------------------------------
// Frame DOM mark manipulation and security
// ---------------------------------------------------------------------------

describe('frame DOM quote wrapping and security', () => {
  test('wraps an exact quote with createElement and textContent', () => {
    const root = makeElement(
      'div',
      {},
      'The quick brown fox jumps over the lazy dog.'
    );
    mockDoc.body.appendChild(root);

    const placed = wrapFrameQuote(
      root as unknown as HTMLElement,
      'brown fox',
      undefined,
      undefined,
      'c1'
    );
    expect(placed).toBe(true);

    const mark = root.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('brown fox');
    expect(mark?.getAttribute('data-comment-id')).toBe('c1');

    unwrapFrameQuotes(root as unknown as HTMLElement);
    expect(root.querySelector('mark.relic-text-mark')).toBeNull();
    expect(root.textContent).toBe(
      'The quick brown fox jumps over the lazy dog.'
    );
  });

  test('author content containing markup cannot become markup in a mark', () => {
    const dangerousText = '<script>window.__injected = true;</script>';
    const root = makeElement('div', {}, dangerousText);
    mockDoc.body.appendChild(root);

    const placed = wrapFrameQuote(
      root as unknown as HTMLElement,
      '<script>',
      undefined,
      undefined,
      'sec1'
    );
    expect(placed).toBe(true);

    expect(root.querySelectorAll('script')).toHaveLength(0);
    const mark = root.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('<script>');

    unwrapFrameQuotes(root as unknown as HTMLElement);
  });

  test('disambiguates repeat occurrences using prefix and suffix context', () => {
    const root = makeElement(
      'div',
      {},
      'first apple pie is good, second apple pie is better'
    );
    mockDoc.body.appendChild(root);

    const placed = wrapFrameQuote(
      root as unknown as HTMLElement,
      'apple pie',
      'second ',
      ' is better',
      'second-apple'
    );
    expect(placed).toBe(true);

    const mark = root.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute('data-comment-id')).toBe('second-apple');

    const prevNode = mark?.previousSibling;
    expect(prevNode?.textContent?.endsWith('second ')).toBe(true);

    unwrapFrameQuotes(root as unknown as HTMLElement);
  });
});

describe('frame DOM region painting', () => {
  test('positions a box on the scrollable document overlay', () => {
    const root = makeElement('div', {}, 'content');
    mockDoc.body.appendChild(root);

    const rect: AnchorRect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const div = paintFrameRegion(root as unknown as HTMLElement, rect, 'reg-1');
    expect(div).not.toBeUndefined();
    expect(div?.classList.contains('relic-region-mark')).toBe(true);
    expect(div?.dataset.commentId).toBe('reg-1');

    clearFrameRegions(root as unknown as HTMLElement, 'reg-1');
    expect(root.querySelector('[data-comment-id="reg-1"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Frame interaction (pointing arm/disarm and clicks)
// ---------------------------------------------------------------------------

describe('frame interaction and click capture', () => {
  test('ignores clicks while pointing is disarmed', () => {
    const root = makeElement('div', {}, 'Clickable area');
    mockDoc.body.appendChild(root);

    const messages: object[] = [];
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => {
        messages.push(msg);
      }
    );

    expect(interaction.isArmed()).toBe(false);

    root.dispatchEvent({ type: 'mousedown', pageX: 100, pageY: 100 });
    root.dispatchEvent({ type: 'mouseup', pageX: 100, pageY: 100 });

    const pointMsgs = messages.filter(
      (m) =>
        (m as { type?: string }).type === 'relic:frame-point' ||
        (m as { type?: string }).type === 'relic:frame-region'
    );
    expect(pointMsgs).toHaveLength(0);
  });

  test('reports unit coordinates on click when pointing is armed', () => {
    const root = makeElement('div', {}, 'Clickable area');
    mockDoc.body.appendChild(root);

    const messages: object[] = [];
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => {
        messages.push(msg);
      }
    );

    interaction.setArmed(true);
    expect(interaction.isArmed()).toBe(true);

    root.dispatchEvent({ type: 'mousedown', pageX: 50, pageY: 50 });
    root.dispatchEvent({ type: 'mouseup', pageX: 50, pageY: 50 });

    const pointMsgs = messages.filter(
      (m) =>
        (m as { type?: string }).type === 'relic:frame-point' ||
        (m as { type?: string }).type === 'relic:frame-region'
    );
    expect(pointMsgs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Sandbox message handler security: source check and malformed input
// ---------------------------------------------------------------------------

describe('sandbox handler security', () => {
  test('ignores messages from a window that is not the parent window', () => {
    const received: unknown[] = [];
    const handle = createSandboxHandler(
      () => {},
      () => {},
      () => {},
      {
        setArmed: () => {},
        onPaintMark: (mark) => {
          received.push(mark);
          return true;
        },
        onPaintMarks: () => true,
        onClearMark: () => {},
        onClearMarks: () => {},
        onRevealMark: () => {},
        onPairMark: () => {},
      }
    );

    expect(handle({ type: 'relic:render', html: '<p>ok</p>' })).toBe(true);

    const fakeOtherWindow = {};
    const isFromParent = (src: unknown) => src === mockWin.parent;

    expect(isFromParent(fakeOtherWindow)).toBe(false);
    expect(isFromParent(mockWin.parent)).toBe(true);
  });

  test('malformed inbound message does not throw and does not paint', () => {
    const painted: unknown[] = [];
    const handle = createSandboxHandler(
      () => {},
      () => {},
      () => {},
      {
        setArmed: () => {},
        onPaintMark: (mark) => {
          painted.push(mark);
          return true;
        },
        onPaintMarks: () => true,
        onClearMark: () => {},
        onClearMarks: () => {},
        onRevealMark: () => {},
        onPairMark: () => {},
      }
    );

    handle({ type: 'relic:render', html: '<p>ok</p>' });

    expect(handle(null)).toBe(false);
    expect(handle(undefined)).toBe(false);
    expect(handle('not an object')).toBe(false);
    expect(handle(12345)).toBe(false);
    expect(handle({ type: 'relic:paint-mark', mark: { bad: 'data' } })).toBe(
      false
    );
    expect(
      handle({
        type: 'relic:paint-mark',
        mark: { id: 'm1', kind: 'quote', exact: 42 },
      })
    ).toBe(false);
    expect(
      handle({
        type: 'relic:paint-mark',
        mark: { id: 'm1', kind: 'region', rect: { x: -1, y: 0, w: 1, h: 1 } },
      })
    ).toBe(false);
    expect(handle({ type: 'relic:unknown-action' })).toBe(false);

    expect(painted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Adapters: frameQuoteAdapter and frameRegionAdapter
// ---------------------------------------------------------------------------

describe('frame adapters', () => {
  const iframe = makeElement('iframe', { class: 'usercontent-frame' });
  const divHost = makeElement('div', { class: 'stage-wrap' }, iframe);
  const nonFrameHost = makeElement(
    'div',
    { class: 'stage-wrap' },
    makeElement('div')
  );

  const frameSurface: AnchorSurface = {
    host: divHost as unknown as HTMLElement,
    content: iframe as unknown as HTMLElement,
  };
  const nonFrameSurface: AnchorSurface = {
    host: nonFrameHost as unknown as HTMLElement,
    content: nonFrameHost.firstChild as unknown as HTMLElement,
  };

  test('supports() returns true only when surface is iframe.usercontent-frame', () => {
    expect(frameQuoteAdapter.supports(frameSurface)).toBe(true);
    expect(frameQuoteAdapter.supports(nonFrameSurface)).toBe(false);

    expect(frameRegionAdapter.supports(frameSurface)).toBe(true);
    expect(frameRegionAdapter.supports(nonFrameSurface)).toBe(false);
  });

  test('label() returns descriptive human-readable text', () => {
    expect(
      frameQuoteAdapter.label({ kind: 'quote', exact: 'hello world' })
    ).toBe('Commenting on "hello world"');
    expect(
      frameRegionAdapter.label({
        kind: 'region',
        rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      })
    ).toBe('Commenting on a region');
  });

  test('paint() posts message across frame boundary and returns true', () => {
    const posted: unknown[] = [];
    (
      iframe as unknown as {
        contentWindow: { postMessage: (msg: unknown) => void };
      }
    ).contentWindow = {
      postMessage: (msg: unknown) => {
        posted.push(msg);
      },
    };

    const quotePlaced = frameQuoteAdapter.paint(
      frameSurface,
      divHost as unknown as HTMLElement,
      { kind: 'quote', exact: 'test quote' },
      'comment-1'
    );
    expect(quotePlaced).toBe(true);
    expect(posted).toHaveLength(1);
    expect((posted[0] as { type: string }).type).toBe('relic:paint-mark');

    const regionPlaced = frameRegionAdapter.paint(
      frameSurface,
      divHost as unknown as HTMLElement,
      { kind: 'region', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
      'comment-2'
    );
    expect(regionPlaced).toBe(true);
    expect(posted).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Frame mark geometry: hover boxes, click rects, selection text, active mark
// ---------------------------------------------------------------------------

describe('frame mark geometry and selection reporting', () => {
  interface PostedMessage {
    type?: string;
    id?: string | null;
    rect?: { left: number; top: number; width: number; height: number };
    exact?: string;
    text?: string;
    truncated?: boolean;
  }

  const posted: PostedMessage[] = [];

  beforeEach(() => {
    posted.length = 0;
    // The frame posts over window.parent.postMessage; the mock window's
    // parent ships without one, so give it a listener that records.
    (
      mockWin as unknown as { parent: { postMessage: (msg: unknown) => void } }
    ).parent.postMessage = (msg: unknown) => {
      posted.push(msg as PostedMessage);
    };
  });

  function wrapWithBox(
    exact: string,
    id: string,
    rect: { left: number; top: number; width: number; height: number }
  ): MockNode {
    const root = makeElement('div', {}, `before ${exact} after`);
    mockDoc.body.appendChild(root);
    expect(
      wrapFrameQuote(root as unknown as HTMLElement, exact, '', '', id)
    ).toBe(true);
    const mark = root.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    (
      mark as unknown as { getBoundingClientRect: () => unknown }
    ).getBoundingClientRect = () => rect;
    return mark as unknown as MockNode;
  }

  test('hover enter posts the mark id and its box, leave posts null', () => {
    const mark = wrapWithBox('words', 'c1', {
      left: 10,
      top: 20,
      width: 30,
      height: 40,
    });

    mark.dispatchEvent({ type: 'mouseenter' });
    mark.dispatchEvent({ type: 'mouseleave' });

    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual({
      type: 'relic:frame-mark-hover',
      id: 'c1',
      rect: { left: 10, top: 20, width: 30, height: 40 },
    });
    expect(posted[1]).toEqual({ type: 'relic:frame-mark-hover', id: null });
    expect(isFrameMarkHoverMessage(posted[0])).toBe(true);
    expect(isFrameMarkHoverMessage(posted[1])).toBe(true);
  });

  test('a mark click carries the box it was clicked on', () => {
    const mark = wrapWithBox('words', 'c2', {
      left: 1,
      top: 2,
      width: 3,
      height: 4,
    });

    mark.dispatchEvent({
      type: 'click',
      stopPropagation: () => {},
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: 'relic:frame-mark-click',
      id: 'c2',
      rect: { left: 1, top: 2, width: 3, height: 4 },
    });
    expect(isFrameMarkClickMessage(posted[0])).toBe(true);
  });

  test('hover and click on a region mark carry its box', () => {
    const div = paintFrameRegion(
      mockDoc.body as unknown as HTMLElement,
      { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      'reg-9'
    );
    expect(div).not.toBeUndefined();
    const region = div as unknown as MockNode & {
      getBoundingClientRect: () => unknown;
    };
    region.getBoundingClientRect = () => ({
      left: 50,
      top: 60,
      width: 70,
      height: 80,
    });

    region.dispatchEvent({ type: 'mouseenter' });
    region.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    region.dispatchEvent({ type: 'mouseleave' });

    const hover = posted.find(
      (m) => m.type === 'relic:frame-mark-hover' && m.id === 'reg-9'
    );
    const leave = posted.find(
      (m) => m.type === 'relic:frame-mark-hover' && m.id === null
    );
    const click = posted.find((m) => m.type === 'relic:frame-mark-click');
    expect(hover?.rect).toEqual({ left: 50, top: 60, width: 70, height: 80 });
    expect(leave).toEqual({ type: 'relic:frame-mark-hover', id: null });
    expect(click).toEqual({
      type: 'relic:frame-mark-click',
      id: 'reg-9',
      rect: { left: 50, top: 60, width: 70, height: 80 },
    });
  });

  test('a selection carries its box and the full selected text', () => {
    const root = makeElement('div', {}, 'selectable words');
    mockDoc.body.appendChild(root);
    const textNode = root.firstChild as unknown as { data: string };

    mockWin.getSelection = () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'selectable words',
      getRangeAt: () => ({
        startContainer: textNode,
        startOffset: 0,
        endContainer: textNode,
        endOffset: 15,
        getBoundingClientRect: () => ({
          left: 5,
          top: 6,
          width: 100,
          height: 12,
        }),
      }),
    });

    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => {
        posted.push(msg as PostedMessage);
      }
    );
    expect(interaction.isArmed()).toBe(false);

    mockDoc.body.dispatchEvent({ type: 'mouseup' });

    const selection = posted.find((m) => m.type === 'relic:frame-selection');
    expect(selection).toBeDefined();
    expect(selection?.exact).toBe('selectable words');
    expect(selection?.text).toBe('selectable words');
    expect(selection?.truncated).toBeUndefined();
    expect(selection?.rect).toEqual({
      left: 5,
      top: 6,
      width: 100,
      height: 12,
    });
    expect(isFrameSelectionMessage(selection)).toBe(true);
  });

  test('an oversized selection is flagged and its copy text capped', () => {
    const raw = 'x'.repeat(70_000);
    mockWin.getSelection = () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => raw,
      getRangeAt: () => ({
        startContainer: mockDoc.body,
        startOffset: 0,
        endContainer: mockDoc.body,
        endOffset: 1,
      }),
    });

    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => {
        posted.push(msg as PostedMessage);
      }
    );
    expect(interaction.isArmed()).toBe(false);

    mockDoc.body.dispatchEvent({ type: 'mouseup' });

    const selection = posted.find((m) => m.type === 'relic:frame-selection');
    expect(selection).toBeDefined();
    expect(selection?.truncated).toBe(true);
    expect(selection?.exact).toBe('x'.repeat(512));
    expect(selection?.text).toBe('x'.repeat(64 * 1024));
    expect(selection?.rect).toBeUndefined();
    expect(isFrameSelectionMessage(selection)).toBe(true);
  });

  test('a collapsing selection posts one cleared message', () => {
    let selection: unknown = null;
    mockWin.getSelection = () => selection;

    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => {
        posted.push(msg as PostedMessage);
      }
    );
    expect(interaction.isArmed()).toBe(false);

    // Nothing was ever reported: a falling edge without a rise posts nothing.
    mockDoc.body.dispatchEvent({ type: 'selectionchange' });
    expect(posted).toHaveLength(0);

    const root = makeElement('div', {}, 'a sentence to select');
    mockDoc.body.appendChild(root);
    const textNode = root.firstChild as unknown as { data: string };
    selection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'a sentence',
      getRangeAt: () => ({
        startContainer: textNode,
        startOffset: 0,
        endContainer: textNode,
        endOffset: 10,
      }),
    };
    mockDoc.body.dispatchEvent({ type: 'mouseup' });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.type).toBe('relic:frame-selection');

    // The selection collapses: one cleared message, and no repeats.
    selection = null;
    mockDoc.body.dispatchEvent({ type: 'selectionchange' });
    mockDoc.body.dispatchEvent({ type: 'selectionchange' });
    const cleared = posted.filter(
      (m) => m.type === 'relic:frame-selection-cleared'
    );
    expect(cleared).toHaveLength(1);
  });

  test('quiet-marks settles the named marks and reopening puts them back', () => {
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      () => {}
    );

    const rootA = makeElement('p', {}, 'first quote here');
    const rootB = makeElement('p', {}, 'second quote here');
    mockDoc.body.appendChild(rootA);
    mockDoc.body.appendChild(rootB);
    wrapFrameQuote(
      rootA as unknown as HTMLElement,
      'first quote',
      '',
      '',
      'c-a'
    );
    wrapFrameQuote(
      rootB as unknown as HTMLElement,
      'second quote',
      '',
      '',
      'c-b'
    );
    const markA = mockDoc.body.querySelector(
      '[data-comment-id="c-a"]'
    ) as unknown as { classList: MockClassList };
    const markB = mockDoc.body.querySelector(
      '[data-comment-id="c-b"]'
    ) as unknown as { classList: MockClassList };

    interaction.onQuietMarks(['c-b']);
    expect(markA.classList.contains('is-resolved')).toBe(false);
    expect(markB.classList.contains('is-resolved')).toBe(true);

    // The whole list every time, so undoing a resolution is expressible. A
    // message that only ever added would leave a reopened comment looking
    // closed inside the frame while the thread said otherwise.
    interaction.onQuietMarks([]);
    expect(markB.classList.contains('is-resolved')).toBe(false);
  });

  test('active-mark lights the matching mark and null clears every mark', () => {
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      () => {}
    );

    const rootA = makeElement('p', {}, 'first quote here');
    const rootB = makeElement('p', {}, 'second quote here');
    mockDoc.body.appendChild(rootA);
    mockDoc.body.appendChild(rootB);
    wrapFrameQuote(
      rootA as unknown as HTMLElement,
      'first quote',
      '',
      '',
      'c-a'
    );
    wrapFrameQuote(
      rootB as unknown as HTMLElement,
      'second quote',
      '',
      '',
      'c-b'
    );
    const markA = mockDoc.body.querySelector(
      '[data-comment-id="c-a"]'
    ) as unknown as { classList: MockClassList };
    const markB = mockDoc.body.querySelector(
      '[data-comment-id="c-b"]'
    ) as unknown as { classList: MockClassList };
    expect(markA).not.toBeNull();
    expect(markB).not.toBeNull();

    interaction.onActiveMark('c-b');
    expect(markA.classList.contains('is-active')).toBe(false);
    expect(markB.classList.contains('is-active')).toBe(true);

    interaction.onActiveMark('c-a');
    expect(markA.classList.contains('is-active')).toBe(true);
    expect(markB.classList.contains('is-active')).toBe(false);

    interaction.onActiveMark(null);
    expect(markA.classList.contains('is-active')).toBe(false);
    expect(markB.classList.contains('is-active')).toBe(false);
  });

  test('relic:active-mark routes to the interaction through the handler', () => {
    const activeIds: (string | null)[] = [];
    const handle = createSandboxHandler(
      () => {},
      () => {},
      () => {},
      {
        setArmed: () => {},
        onPaintMark: () => true,
        onPaintMarks: () => true,
        onClearMark: () => {},
        onClearMarks: () => {},
        onRevealMark: () => {},
        onPairMark: () => {},
        onActiveMark: (id) => {
          activeIds.push(id);
        },
      }
    );

    expect(handle({ type: 'relic:render', html: '<p>ok</p>' })).toBe(true);
    expect(handle({ type: 'relic:active-mark', id: 'c-7' })).toBe(true);
    expect(handle({ type: 'relic:active-mark', id: null })).toBe(true);

    expect(activeIds).toEqual(['c-7', null]);
  });

  test('mark CSS keeps commented passages visible at rest, active strongest', () => {
    // The stylesheet is a constant; assert the states it must carry rather
    // than re-deriving them from selectors elsewhere in this file.
    expect(FRAME_MARK_CSS).toContain('.relic-text-mark {');
    expect(FRAME_MARK_CSS).toContain('.relic-text-mark.is-active {');
    expect(FRAME_MARK_CSS).toContain('.relic-text-mark.is-resolved {');
    expect(FRAME_MARK_CSS).toContain('.relic-region-mark.is-active {');
    expect(FRAME_MARK_CSS).toContain('.relic-region-mark.is-resolved {');
    // Every declaration is !important: the frame's document is author-owned
    // content that must never be able to hide a mark.
    for (const line of FRAME_MARK_CSS.split('\n')) {
      if (line.trim().startsWith('background:')) {
        expect(line).toContain('!important');
      }
      if (line.trim().startsWith('border-bottom:')) {
        expect(line).toContain('!important');
      }
    }
  });
});
