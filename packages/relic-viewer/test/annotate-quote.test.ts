/**
 * Tests for quote anchor resolving, painting, and context-aware disambiguation.
 *
 * A reader highlighting text on the page needs their comment anchored to the
 * exact occurrence they selected, even when that phrase appears multiple times
 * in the document. These tests assert that context resolves the correct
 * occurrence, that frozen text anchors remain unchanged, that missing quotes
 * return false safely, and that character boundaries are never split.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CommentAnchor } from '@relic/format';
import type { AnchorSurface } from '../src/anchoring.ts';
import {
  quoteAdapter,
  takeHeadUtf8,
  takeTailUtf8,
} from '../src/annotate-quote.ts';
import {
  unwrapTextQuotes,
  wrapTextQuote,
  wrapTextQuoteWithContext,
} from '../src/comments.ts';

// A minimal, complete DOM tree for testing text manipulation and tree-walking.
class TestNode {
  parentElement: TestElement | null = null;
  parentNode: TestElement | null = null;

  contains(other: TestNode): boolean {
    let curr: TestNode | null = other;
    while (curr !== null) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }
}

class TestText extends TestNode {
  readonly nodeType = 3;
  data: string;

  constructor(data: string) {
    super();
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(val: string) {
    this.data = val;
  }

  splitText(offset: number): TestText {
    const head = this.data.slice(0, offset);
    const tail = this.data.slice(offset);
    this.data = head;
    const next = new TestText(tail);
    if (this.parentNode) {
      const idx = this.parentNode.childNodes.indexOf(this);
      if (idx !== -1) {
        this.parentNode.childNodes.splice(idx + 1, 0, next);
        next.parentNode = this.parentNode;
        next.parentElement = this.parentElement;
      }
    }
    return next;
  }
}

class TestElement extends TestNode {
  readonly nodeType = 1;
  readonly tagName: string;
  className = '';
  readonly dataset: Record<string, string> = {};
  get firstChild(): TestElement | TestText | null {
    return this.childNodes[0] ?? null;
  }
  readonly childNodes: (TestElement | TestText)[] = [];
  scrolledIntoView = false;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  get children(): TestElement[] {
    return this.childNodes.filter(
      (c): c is TestElement => c instanceof TestElement
    );
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(val: string) {
    this.childNodes.length = 0;
    if (val.length > 0) {
      this.appendChild(new TestText(val));
    }
  }

  readonly classList = {
    add: (cls: string): void => {
      const parts = this.className.split(' ').filter(Boolean);
      if (!parts.includes(cls)) {
        parts.push(cls);
        this.className = parts.join(' ');
      }
    },
    remove: (cls: string): void => {
      this.className = this.className
        .split(' ')
        .filter((c) => c && c !== cls)
        .join(' ');
    },
    contains: (cls: string): boolean => {
      return this.className.split(' ').filter(Boolean).includes(cls);
    },
    toggle: (cls: string, on?: boolean): void => {
      const active = on ?? !this.classList.contains(cls);
      if (active) this.classList.add(cls);
      else this.classList.remove(cls);
    },
  };

  appendChild<T extends TestElement | TestText>(child: T): T {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    this.childNodes.push(child);
    child.parentNode = this;
    child.parentElement = this;
    return child;
  }

  insertBefore<T extends TestElement | TestText>(
    newChild: T,
    refChild: TestElement | TestText | null
  ): T {
    if (newChild.parentNode) {
      newChild.parentNode.removeChild(newChild);
    }
    if (refChild === null) {
      return this.appendChild(newChild);
    }
    const idx = this.childNodes.indexOf(refChild);
    if (idx === -1) {
      return this.appendChild(newChild);
    }
    this.childNodes.splice(idx, 0, newChild);
    newChild.parentNode = this;
    newChild.parentElement = this;
    return newChild;
  }

  removeChild<T extends TestElement | TestText>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
      child.parentElement = null;
    }
    return child;
  }

  normalize(): void {
    const normalized: (TestElement | TestText)[] = [];
    let prevText: TestText | null = null;
    for (const child of this.childNodes) {
      if (child instanceof TestText) {
        if (child.data.length === 0) continue;
        if (prevText) {
          prevText.data += child.data;
        } else {
          prevText = child;
          normalized.push(child);
        }
      } else {
        prevText = null;
        child.normalize();
        normalized.push(child);
      }
    }
    this.childNodes.length = 0;
    this.childNodes.push(...normalized);
  }

  closest(selector: string): TestElement | null {
    const matchers = selector.split(',').map((s) => s.trim());
    let curr: TestElement | null = this;
    while (curr !== null) {
      for (const m of matchers) {
        if (matchesSelector(curr, m)) return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll<T extends TestElement = TestElement>(selector: string): T[] {
    const results: T[] = [];
    const matchers = selector.split(',').map((s) => s.trim());
    function search(elem: TestElement): void {
      for (const child of elem.childNodes) {
        if (child instanceof TestElement) {
          for (const m of matchers) {
            if (matchesSelector(child, m)) {
              results.push(child as unknown as T);
              break;
            }
          }
          search(child);
        }
      }
    }
    search(this);
    return results;
  }

  scrollIntoView(_options?: { block?: string }): void {
    this.scrolledIntoView = true;
  }
}

function matchesSelector(elem: TestElement, selector: string): boolean {
  if (selector === 'iframe.usercontent-frame') {
    return (
      elem.tagName === 'IFRAME' && elem.classList.contains('usercontent-frame')
    );
  }
  if (selector === 'mark.relic-text-mark') {
    return (
      elem.tagName === 'MARK' && elem.classList.contains('relic-text-mark')
    );
  }
  if (selector === '.comment-pins') {
    return elem.classList.contains('comment-pins');
  }
  if (selector === '.mark-bubble') {
    return elem.classList.contains('mark-bubble');
  }
  if (selector === 'script') {
    return elem.tagName === 'SCRIPT';
  }
  if (selector === 'style') {
    return elem.tagName === 'STYLE';
  }
  if (selector.startsWith('mark[')) {
    if (elem.tagName !== 'MARK') return false;
    const match = /data-comment-id="([^"]+)"/.exec(selector);
    return match ? elem.dataset.commentId === match[1] : true;
  }
  if (selector.startsWith('[')) {
    const match = /data-comment-id="([^"]+)"/.exec(selector);
    return match ? elem.dataset.commentId === match[1] : true;
  }
  return elem.tagName === selector.toUpperCase();
}

function installTestDom(): void {
  (globalThis as { NodeFilter?: unknown }).NodeFilter = {
    SHOW_TEXT: 4,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  };
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new TestElement(tag),
    createTextNode: (text: string) => new TestText(text),
    createTreeWalker: (
      root: TestNode,
      _whatToShow: number,
      filter?: { acceptNode(n: TestNode): number }
    ) => {
      const textNodes: TestText[] = [];
      function collect(node: TestNode): void {
        if (node instanceof TestText) {
          if (!filter || filter.acceptNode(node) === 1) {
            textNodes.push(node);
          }
          return;
        }
        if (node instanceof TestElement) {
          for (const child of [...node.childNodes]) {
            collect(child);
          }
        }
      }
      collect(root);
      let idx = 0;
      return {
        nextNode: (): TestText | null => {
          if (idx < textNodes.length) {
            const next = textNodes[idx];
            idx++;
            return next ?? null;
          }
          return null;
        },
      };
    },
  };
}

function clearTestDom(): void {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { NodeFilter?: unknown }).NodeFilter;
}

describe('quote anchor adapter and context-aware resolver', () => {
  beforeEach(installTestDom);
  afterEach(clearTestDom);

  test('headline case: document contains the same phrase three times and context names the second', () => {
    // The defect: wrapTextQuote wrapped the first occurrence unconditionally.
    // When a phrase occurs multiple times, the resolver must use prefix/suffix
    // context to land on the second occurrence.
    const stage = new TestElement('div');
    stage.className = 'stage-wrap';

    const p1 = new TestElement('p');
    p1.textContent = 'First observation: not measured in a browser.';
    const p2 = new TestElement('p');
    p2.textContent = 'Second observation: not measured in a browser.';
    const p3 = new TestElement('p');
    p3.textContent = 'Third observation: not measured in a browser.';
    stage.appendChild(p1);
    stage.appendChild(p2);
    stage.appendChild(p3);

    const surface: AnchorSurface = {
      host: stage as unknown as HTMLElement,
      content: stage as unknown as HTMLElement,
    };

    const overlay = new TestElement('div');
    const anchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'not measured in a browser',
      prefix: 'Second observation: ',
      suffix: '.',
    };

    const placed = quoteAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      anchor,
      'comment-2'
    );
    expect(placed).toBe(true);

    // Paragraph 1 must NOT have the mark.
    expect(p1.querySelector('mark.relic-text-mark')).toBeNull();

    // Paragraph 2 MUST have the mark.
    const mark = p2.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    expect(mark?.dataset.commentId).toBe('comment-2');
    expect(mark?.textContent).toBe('not measured in a browser');

    // Paragraph 3 must NOT have the mark.
    expect(p3.querySelector('mark.relic-text-mark')).toBeNull();
  });

  test('proves the defect: ignoring context lands on the wrong (first) occurrence', () => {
    // When context is absent, the resolver falls back to first-occurrence,
    // which highlights paragraph 1 rather than paragraph 2.
    const stage = new TestElement('div');
    const p1 = new TestElement('p');
    p1.textContent = 'First observation: not measured in a browser.';
    const p2 = new TestElement('p');
    p2.textContent = 'Second observation: not measured in a browser.';
    stage.appendChild(p1);
    stage.appendChild(p2);

    const anchorWithoutContext = {
      exact: 'not measured in a browser',
    };

    const placed = wrapTextQuoteWithContext(
      stage as unknown as ParentNode,
      anchorWithoutContext,
      'comment-no-context'
    );
    expect(placed).toBe(true);

    // Without context, it lands on the first paragraph.
    expect(p1.querySelector('mark.relic-text-mark')).not.toBeNull();
    expect(p2.querySelector('mark.relic-text-mark')).toBeNull();
  });

  test('frozen text anchor still lands on the first occurrence unchanged', () => {
    // Stored legacy text comments must continue to paint on the first occurrence.
    const stage = new TestElement('div');
    const p1 = new TestElement('p');
    p1.textContent = 'First: not measured in a browser.';
    const p2 = new TestElement('p');
    p2.textContent = 'Second: not measured in a browser.';
    stage.appendChild(p1);
    stage.appendChild(p2);

    const placed = wrapTextQuote(
      stage as unknown as ParentNode,
      'not measured in a browser',
      'legacy-text-id'
    );
    expect(placed).toBe(true);

    expect(p1.querySelector('mark.relic-text-mark')).not.toBeNull();
    expect(p2.querySelector('mark.relic-text-mark')).toBeNull();
  });

  test('a quote no longer present returns false rather than throwing or marking wrong runs', () => {
    // When a relic is republished and earlier text was deleted, paint must
    // return false so the thread can display the unplaceable note.
    const stage = new TestElement('div');
    const p1 = new TestElement('p');
    p1.textContent = 'Content currently on the page.';
    stage.appendChild(p1);

    const surface: AnchorSurface = {
      host: stage as unknown as HTMLElement,
      content: stage as unknown as HTMLElement,
    };

    const anchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'deleted text from an older version',
      prefix: 'context before ',
      suffix: ' context after',
    };

    const placed = quoteAdapter.paint(
      surface,
      new TestElement('div') as unknown as HTMLElement,
      anchor,
      'deleted-comment'
    );
    expect(placed).toBe(false);
    expect(stage.querySelector('mark')).toBeNull();
  });

  test('quotes spanning across inline elements resolve and wrap cleanly', () => {
    // A reader highlighting across emphasis (e.g. `the <em>third</em> paragraph`)
    // must still resolve across text node boundaries.
    const stage = new TestElement('div');
    const p = new TestElement('p');
    const lead = new TestText('the ');
    const em = new TestElement('em');
    em.appendChild(new TestText('third'));
    const trail = new TestText(' paragraph of the document');

    p.appendChild(lead);
    p.appendChild(em);
    p.appendChild(trail);
    stage.appendChild(p);

    const surface: AnchorSurface = {
      host: stage as unknown as HTMLElement,
      content: stage as unknown as HTMLElement,
    };

    const anchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'the third paragraph',
      suffix: ' of the document',
    };

    const placed = quoteAdapter.paint(
      surface,
      new TestElement('div') as unknown as HTMLElement,
      anchor,
      'inline-comment'
    );
    expect(placed).toBe(true);

    const marks = stage.querySelectorAll('mark.relic-text-mark');
    expect(marks.length).toBeGreaterThanOrEqual(2);
    for (const mark of marks) {
      expect(mark.dataset.commentId).toBe('inline-comment');
    }
    expect(marks.map((m) => m.textContent).join('')).toBe(
      'the third paragraph'
    );

    // Unwrapping cleanly restores the text flow.
    unwrapTextQuotes(stage as unknown as ParentNode);
    expect(stage.querySelectorAll('mark')).toHaveLength(0);
    expect(p.textContent).toBe('the third paragraph of the document');
  });

  test('never matches inside an existing mark painted by this page', () => {
    const stage = new TestElement('div');
    const p = new TestElement('p');
    p.textContent = 'the target text repeated here and target text here';
    stage.appendChild(p);

    // Paint first mark
    const placed1 = wrapTextQuoteWithContext(
      stage as unknown as ParentNode,
      { exact: 'the target text' },
      'first-mark'
    );
    expect(placed1).toBe(true);

    // A second comment quoting a subset of the already-marked text
    // should not nest inside the first mark.
    const placed2 = wrapTextQuoteWithContext(
      stage as unknown as ParentNode,
      { exact: 'target text', prefix: 'the ' },
      'second-mark'
    );
    expect(placed2).toBe(true);
    const nested = stage.querySelectorAll('mark mark');
    expect(nested).toHaveLength(0);
  });

  test('label wording matches the chip wording and abbreviates over 60 characters', () => {
    const shortAnchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'a short quote',
    };
    expect(quoteAdapter.label(shortAnchor)).toBe(
      'Commenting on "a short quote"'
    );

    const longAnchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'x'.repeat(80),
    };
    const label = quoteAdapter.label(longAnchor);
    expect(label.length).toBeLessThan(100);
    expect(label).toContain('…');
  });

  test('reveal scrolls the painted mark into view', () => {
    const stage = new TestElement('div');
    const p = new TestElement('p');
    p.textContent = 'some target text to reveal';
    stage.appendChild(p);

    const surface: AnchorSurface = {
      host: stage as unknown as HTMLElement,
      content: stage as unknown as HTMLElement,
    };

    const anchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'target text',
    };

    quoteAdapter.paint(
      surface,
      new TestElement('div') as unknown as HTMLElement,
      anchor,
      'reveal-test'
    );

    const mark = stage.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    expect(mark?.scrolledIntoView).toBe(false);

    quoteAdapter.reveal?.(surface, anchor);
    expect(mark?.scrolledIntoView).toBe(true);
  });

  test('supports returns false when the stage holds an iframe.usercontent-frame', () => {
    const stage = new TestElement('div');
    const iframe = new TestElement('iframe');
    iframe.classList.add('usercontent-frame');
    stage.appendChild(iframe);

    const framedSurface: AnchorSurface = {
      host: stage as unknown as HTMLElement,
      content: iframe as unknown as HTMLElement,
    };
    expect(quoteAdapter.supports(framedSurface)).toBe(false);

    const standardStage = new TestElement('div');
    const standardSurface: AnchorSurface = {
      host: standardStage as unknown as HTMLElement,
      content: standardStage as unknown as HTMLElement,
    };
    expect(quoteAdapter.supports(standardSurface)).toBe(true);
  });

  describe('UTF-8 character boundary truncation', () => {
    test('takeHeadUtf8 never cuts multibyte characters in half', () => {
      // 3-byte CJK: '日' (3 bytes), '本' (3 bytes), '語' (3 bytes)
      expect(takeHeadUtf8('日本語', 2)).toBe('');
      expect(takeHeadUtf8('日本語', 3)).toBe('日');
      expect(takeHeadUtf8('日本語', 5)).toBe('日');
      expect(takeHeadUtf8('日本語', 6)).toBe('日本');

      // 4-byte surrogate pair emoji: '😀' (4 bytes)
      expect(takeHeadUtf8('hello 😀 world', 8)).toBe('hello ');
      expect(takeHeadUtf8('hello 😀 world', 10)).toBe('hello 😀');
    });

    test('takeTailUtf8 preserves characters from the end without cutting boundaries', () => {
      // 3-byte CJK
      expect(takeTailUtf8('日本語', 2)).toBe('');
      expect(takeTailUtf8('日本語', 3)).toBe('語');
      expect(takeTailUtf8('日本語', 5)).toBe('語');
      expect(takeTailUtf8('日本語', 6)).toBe('本語');

      // 4-byte emoji
      expect(takeTailUtf8('hello 😀 world', 8)).toBe(' world');
      expect(takeTailUtf8('hello 😀 world', 10)).toBe('😀 world');
      expect(takeTailUtf8('hello 😀 world', 11)).toBe(' 😀 world');
    });
  });
});
