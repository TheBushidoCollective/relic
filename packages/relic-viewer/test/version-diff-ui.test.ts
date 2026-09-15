import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MAX_DIFF_BYTES } from '../src/diff.ts';
import {
  buildBar,
  buildCurrentStage,
  renderCodeComparison,
  renderRenderedComparison,
} from '../src/main.ts';
import type { ReadyView } from '../src/viewer.ts';

/**
 * Bun tests run without a DOM. These stubs carry only what the DOM layer
 * touches while it builds: enough to assert structure, never enough to assert
 * layout or a rendered pixel. What a rendered comparison actually looks like
 * is proven in a browser, which is the only place it can be.
 */
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
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
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

  contains(): boolean {
    return false;
  }

  focus(): void {}

  addEventListener(): void {}
}

const encoder = new TextEncoder();

function view(
  route: ReadyView['route'],
  version: number,
  content: Uint8Array = encoder.encode('const current = true;\n'),
  currentVersion = version
): ReadyView {
  return {
    filename: route === 'download' ? 'archive.zip' : 'notes.ts',
    declaredMimetype:
      route === 'download' ? 'application/zip' : 'text/typescript',
    content,
    route,
    downgradeNotice: undefined,
    shareUrl: 'https://relik.example/aaaaaaaaaaaaaaaaaaaaaaaaaa#key',
    version,
    currentVersion,
  };
}

function textOf(element: ElementStub): string {
  return [element.textContent, ...element.children.map(textOf)].join(' ');
}

function descendants(element: ElementStub): ElementStub[] {
  return [element, ...element.children.flatMap(descendants)];
}

function withClass(element: ElementStub, name: string): ElementStub[] {
  return descendants(element).filter((candidate) =>
    candidate.className.split(' ').includes(name)
  );
}

describe('version comparison affordance', () => {
  beforeEach(() => {
    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => new ElementStub(tag),
      createElementNS: (_namespace: string, tag: string) =>
        new ElementStub(tag),
      addEventListener: () => {},
    };
    (globalThis as { window?: unknown }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
  });

  test('version 1 shows no comparison affordance at all', () => {
    const bar = buildBar(view('code', 1), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;

    const buttons = descendants(bar).filter(
      (element) => element.tagName === 'BUTTON'
    );
    expect(buttons.map(textOf).join(' ')).not.toContain('Compare versions');
  });

  test('version 1 says nothing about versions in the taskbar either', () => {
    // A version number with no history behind it invites a question that has
    // no answer, so absence survived the move into the taskbar.
    const bar = buildBar(view('code', 1), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;

    expect(withClass(bar, 'version')).toHaveLength(0);
    expect(textOf(bar)).not.toContain('Version');
  });

  test('version 2 or higher offers comparison', () => {
    const bar = buildBar(view('code', 2), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;

    const buttons = descendants(bar).filter(
      (element) => element.tagName === 'BUTTON'
    );
    expect(buttons.map(textOf).join(' ')).toContain('Compare versions');
  });

  test('the taskbar carries the version beside the relic id', () => {
    const bar = buildBar(view('code', 4), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;

    const meta = withClass(bar, 'identity-meta')[0];
    if (meta === undefined) throw new Error('the bar built no metadata line');
    expect(textOf(meta)).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(textOf(meta)).toContain('Version 4 of 4');
    // The short form ships alongside it, because the long one does not fit at
    // 320 CSS pixels and the stylesheet is what chooses between them.
    expect(textOf(meta)).toContain('v4/4');
  });

  test('one historical version renders a label, never a picker', () => {
    // A relic on its second version has exactly one earlier version, so a
    // menu there would look like a decision and offer none.
    const bar = buildBar(view('code', 2), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
      onSelectVersion: () => {},
    }) as unknown as ElementStub;

    expect(withClass(bar, 'version-label')).toHaveLength(1);
    expect(withClass(bar, 'version-trigger')).toHaveLength(0);
    expect(withClass(bar, 'version-list')).toHaveLength(0);
  });

  test('two or more historical versions render an owned listbox', () => {
    const bar = buildBar(view('code', 3), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
      onSelectVersion: () => {},
    }) as unknown as ElementStub;

    const trigger = withClass(bar, 'version-trigger')[0];
    const list = withClass(bar, 'version-list')[0];
    if (trigger === undefined || list === undefined) {
      throw new Error('the bar built no version listbox');
    }
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.attributes.get('aria-haspopup')).toBe('listbox');
    expect(trigger.attributes.get('aria-expanded')).toBe('false');
    expect(list.attributes.get('role')).toBe('listbox');
    expect(list.hidden).toBe(true);

    // Never a native select: its popup cannot be positioned or styled, which
    // is what made it render as a detached panel on macOS.
    expect(
      descendants(bar).some((element) => element.tagName === 'SELECT')
    ).toBe(false);

    const options = withClass(bar, 'version-option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Version 2',
      'Version 1',
    ]);
    // Roving focus rather than a tab stop each: a listbox is one stop.
    expect(options.every((option) => option.tabIndex === -1)).toBe(true);
  });

  test('the picker names the version being compared, not the current one', () => {
    const bar = buildBar(view('code', 5), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
      onSelectVersion: () => {},
      comparisonOpen: true,
      selectedVersion: 2,
    }) as unknown as ElementStub;

    expect(textOf(bar)).toContain('Version 2 of 5');
  });

  /**
   * These three assert the same guarantee on the three relics that cannot be
   * compared, and they used to assert only half of it.
   *
   * Checking that the bar does not say "Compare versions" was true and
   * insufficient: it passes just as well when the bar offers no way into the
   * history at all, which is what it did, and which is the defect. So each
   * one now also asserts the control is there under a label that describes
   * what it actually does.
   */
  test('download-only history is reachable, and says why it cannot compare', () => {
    const current = view('download', 3);
    const bar = buildBar(current, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;
    const stage = buildCurrentStage(
      current,
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    expect(textOf(bar)).not.toContain('Compare versions');
    expect(textOf(bar)).toContain('Earlier versions');
    expect(textOf(stage)).toContain('download-only');
    expect(
      descendants(stage).some(
        (element) => element.className === 'doc doc-download'
      )
    ).toBe(true);
  });

  test('oversized code history is reachable, and states the ceiling', () => {
    const current = view('code', 3, new Uint8Array(MAX_DIFF_BYTES + 1));
    const bar = buildBar(current, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;
    const stage = buildCurrentStage(
      current,
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    expect(textOf(bar)).not.toContain('Compare versions');
    expect(textOf(bar)).toContain('Earlier versions');
    expect(textOf(stage)).toContain('16 MiB');
    expect(
      descendants(stage).some((element) => element.className === 'code')
    ).toBe(true);
  });

  test('oversized rendered history is reachable, and states the same ceiling', () => {
    const current = view(
      'sandboxed-html',
      3,
      new Uint8Array(MAX_DIFF_BYTES + 1)
    );
    const bar = buildBar(current, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;
    const stage = buildCurrentStage(
      current,
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    expect(textOf(bar)).not.toContain('Compare versions');
    expect(textOf(bar)).toContain('Earlier versions');
    expect(textOf(stage)).toContain('16 MiB');
    expect(
      descendants(stage).some((element) =>
        element.className.split(' ').includes('doc-html')
      )
    ).toBe(true);
  });

  test('the rendered comparison renders both versions and shows neither as source', () => {
    const collector = 'https://collector.invalid/diff-probe';
    const historical = view(
      'sandboxed-html',
      2,
      encoder.encode(
        `<img src="${collector}"><script>fetch('${collector}')</script>`
      ),
      5
    );
    const current = view(
      'sandboxed-html',
      5,
      encoder.encode('<p>Current version</p>')
    );

    const comparison = renderRenderedComparison(
      current,
      historical,
      'rendered',
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    // Two frames, because a rendered comparison needs two renders of
    // untrusted content and gets them from two frames rather than by
    // relaxing either frame's one-render guard.
    const frames = descendants(comparison).filter(
      (element) => element.tagName === 'IFRAME'
    );
    expect(frames).toHaveLength(2);
    expect(
      frames.every(
        (frame) => frame.attributes.get('sandbox') === 'allow-scripts'
      )
    ).toBe(true);

    // Source text is what this replaced. The markup of neither version is
    // printed on the service origin.
    expect(textOf(comparison)).not.toContain(collector);
    expect(textOf(comparison)).not.toContain('<script>');
    expect(textOf(comparison)).toContain('Rendered comparison');
  });

  test('the rendered comparison offers a swipe and a side by side layout', () => {
    const comparison = renderRenderedComparison(
      view('markdown', 5, encoder.encode('# After\n')),
      view('markdown', 2, encoder.encode('# Before\n'), 5),
      'markdown',
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    const stage = withClass(comparison, 'compare-stage')[0];
    if (stage === undefined) throw new Error('no comparison stage was built');
    // Prose is read, so markdown starts side by side; a page starts on the
    // swipe, where the question is whether the pixels moved.
    expect(stage.dataset['layout']).toBe('split');

    const layout = withClass(comparison, 'compare-layout')[0];
    if (layout === undefined) throw new Error('no layout control was built');
    expect(layout.children.map(textOf).join(' ')).toContain('Swipe');
    expect(layout.children.map(textOf).join(' ')).toContain('Side by side');

    const slider = descendants(comparison).find(
      (element) => element.type === 'range'
    );
    if (slider === undefined) throw new Error('no swipe control was built');
    expect(slider.attributes.get('aria-label')).toBe(
      'Reveal version 5 over version 2'
    );

    // Both panes name their version, so a swiped view is never ambiguous.
    expect(textOf(comparison)).toContain('Version 2');
    expect(textOf(comparison)).toContain('Version 5, current');
  });

  test('markdown compares rendered prose rather than building a frame', () => {
    const comparison = renderRenderedComparison(
      view('markdown', 5, encoder.encode('# After\n')),
      view('markdown', 2, encoder.encode('# Before\n'), 5),
      'markdown',
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    // Markdown renders on the service origin through the escaping renderer,
    // so both versions are ordinary DOM here and need no frame at all.
    expect(
      descendants(comparison).some((element) => element.tagName === 'IFRAME')
    ).toBe(false);
    expect(withClass(comparison, 'prose')).toHaveLength(2);
  });

  test('code keeps its line comparison, because for code the source is the view', () => {
    const comparison = renderCodeComparison(
      view('code', 5, encoder.encode('const answer = 42;\n')),
      view('code', 2, encoder.encode('const answer = 41;\n'), 5)
    ) as unknown as ElementStub;

    expect(textOf(comparison)).toContain('Code comparison');
    expect(withClass(comparison, 'diff-changes')).toHaveLength(1);
    expect(textOf(comparison)).toContain('42');
    expect(textOf(comparison)).toContain('41');
  });

  test('identical code says so rather than showing an empty comparison', () => {
    const same = encoder.encode('const answer = 42;\n');
    const comparison = renderCodeComparison(
      view('code', 5, same),
      view('code', 2, same.slice(), 5)
    ) as unknown as ElementStub;

    expect(withClass(comparison, 'diff-empty')).toHaveLength(1);
    expect(textOf(comparison)).toContain(
      'No changes. These versions have identical content.'
    );
    expect(withClass(comparison, 'diff-changes')).toHaveLength(0);
  });
});
