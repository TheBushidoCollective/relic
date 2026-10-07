import { describe, expect, test } from 'bun:test';
import { renderHomeRelics } from '../src/home.ts';
import { homeRelicRows } from '../src/relic-rows.ts';
import type { KeyVault, VaultEntry } from '../src/vault.ts';

const pkgDir = new URL('..', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Lightweight DOM stub for testing home.ts without a browser
// ---------------------------------------------------------------------------

function matchesSelector(node: ElementStub, selector: string): boolean {
  if (selector === '*' || selector.length === 0) return true;
  if (selector.startsWith('#')) {
    return node.id === selector.slice(1);
  }
  if (selector.includes('.')) {
    const dotIndex = selector.indexOf('.');
    const tag = selector.slice(0, dotIndex);
    const cls = selector.slice(dotIndex + 1);
    if (tag.length > 0 && node.tagName.toLowerCase() !== tag.toLowerCase()) {
      return false;
    }
    return node.className.split(/\s+/).includes(cls);
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

class ElementStub {
  readonly tagName: string;
  id = '';
  className = '';
  textContent = '';
  href = '';
  set innerHTML(html: string) {
    this.children.length = 0;
    if (html.includes('<img')) {
      const img = new ElementStub('img');
      this.children.push(img);
    }
    this.textContent = html;
  }
  readonly attributes = new Map<string, string>();
  readonly children: ElementStub[] = [];

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get hidden(): boolean {
    return this.attributes.has('hidden');
  }

  set hidden(val: boolean) {
    if (val) {
      this.attributes.set('hidden', '');
    } else {
      this.attributes.delete('hidden');
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
    if (name === 'href') this.href = value;
  }

  getAttribute(name: string): string | null {
    if (name === 'id') return this.id || this.attributes.get('id') || null;
    if (name === 'class')
      return this.className || this.attributes.get('class') || null;
    if (name === 'href')
      return this.href || this.attributes.get('href') || null;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'id') this.id = '';
    if (name === 'class') this.className = '';
    if (name === 'href') this.href = '';
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild(child: ElementStub): ElementStub {
    this.children.push(child);
    return child;
  }

  append(...kids: ElementStub[]): void {
    for (const k of kids) {
      this.children.push(k);
    }
  }

  replaceChildren(...kids: ElementStub[]): void {
    this.children.length = 0;
    this.append(...kids);
  }

  querySelector(selector: string): ElementStub | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ElementStub[] {
    const parts = selector.trim().split(/\s+/);
    if (parts.length > 1) {
      let current = [this as ElementStub];
      for (const part of parts) {
        const next: ElementStub[] = [];
        for (const el of current) {
          next.push(...el.querySelectorAll(part));
        }
        current = next;
      }
      return current;
    }
    const results: ElementStub[] = [];
    const check = (node: ElementStub) => {
      if (matchesSelector(node, selector)) {
        results.push(node);
      }
      for (const child of node.children) {
        check(child);
      }
    };
    for (const child of this.children) {
      check(child);
    }
    return results;
  }
}

class DocumentStub {
  readonly body = new ElementStub('body');

  createElement(tag: string): ElementStub {
    return new ElementStub(tag);
  }

  getElementById(id: string): ElementStub | null {
    const check = (node: ElementStub): ElementStub | null => {
      if (node.id === id || node.getAttribute('id') === id) return node;
      for (const child of node.children) {
        const found = check(child);
        if (found) return found;
      }
      return null;
    };
    return check(this.body);
  }
}

function makeMockVault(entries: VaultEntry[] = []): KeyVault {
  return {
    remember() {},
    recall(relicId) {
      return entries.find((e) => e.relicId === relicId)?.fragment;
    },
    forget() {},
    list() {
      return [...entries];
    },
    exportEntries() {
      return JSON.stringify({ version: 1, entries });
    },
    importEntries() {
      return { added: 0, skipped: 0 };
    },
  };
}

describe('homeRelicRows ordering helper', () => {
  test('orders by lastOpenedAt descending, with un-opened entries after in vault order', () => {
    const vault = makeMockVault([
      {
        relicId: 'unopened-1',
        fragment: 'f1',
        expiresAt: null,
        title: 'Unopened 1',
      },
      {
        relicId: 'opened-early',
        fragment: 'f2',
        expiresAt: null,
        title: 'Opened Early',
        lastOpenedAt: 1000,
      },
      {
        relicId: 'opened-late',
        fragment: 'f3',
        expiresAt: null,
        title: 'Opened Late',
        lastOpenedAt: 5000,
      },
      {
        relicId: 'unopened-2',
        fragment: 'f4',
        expiresAt: null,
        title: 'Unopened 2',
      },
    ]);

    const rows = homeRelicRows(vault);
    expect(rows.map((r) => r.relicId)).toEqual([
      'opened-late',
      'opened-early',
      'unopened-1',
      'unopened-2',
    ]);
  });
});

describe('renderHomeRelics', () => {
  test('(a) with an empty vault the section stays hidden and has no children', () => {
    const doc = new DocumentStub();
    const section = doc.createElement('section');
    section.id = 'home-relics';
    section.className = 'home-relics';
    section.setAttribute('aria-labelledby', 'home-relics-title');
    section.setAttribute('hidden', '');
    doc.body.appendChild(section);

    const vault = makeMockVault([]);
    renderHomeRelics(doc as unknown as Document, vault);

    expect(section.hasAttribute('hidden')).toBe(true);
    expect(section.children).toHaveLength(0);
  });

  test('(b) with three entries (one without lastOpenedAt, two with) the rows render in specified order with exact hrefs, label, title fallback, and hidden removed', () => {
    const doc = new DocumentStub();
    const section = doc.createElement('section');
    section.id = 'home-relics';
    section.className = 'home-relics';
    section.setAttribute('aria-labelledby', 'home-relics-title');
    section.setAttribute('hidden', '');
    doc.body.appendChild(section);

    const vault = makeMockVault([
      {
        relicId: 'relic-one',
        fragment: '#r1frag',
        expiresAt: null,
        title: '', // empty title -> should fallback to relicId
        lastOpenedAt: 1000,
        renderer: 'markdown',
      },
      {
        relicId: 'relic-two',
        fragment: 'r2frag',
        expiresAt: null,
        title: 'Second Relic',
        lastOpenedAt: undefined, // no lastOpenedAt -> should sort after opened ones
        renderer: 'code',
      },
      {
        relicId: 'relic-three',
        fragment: '#r3frag',
        expiresAt: null,
        title: 'Third Relic',
        lastOpenedAt: 3000, // newest -> should be first
        renderer: 'html',
      },
    ]);

    renderHomeRelics(doc as unknown as Document, vault);

    // hidden attribute removed
    expect(section.hasAttribute('hidden')).toBe(false);

    // Headings and note
    const title = section.querySelector('#home-relics-title');
    expect(title).not.toBeNull();
    expect(title?.textContent).toBe('Your relics');

    const note = section.querySelector('.home-relics-note');
    expect(note).not.toBeNull();
    expect(note?.textContent).toBe(
      'Relics this browser has opened. The list is read here and sent nowhere.'
    );

    // Rows and order
    const list = section.querySelector('ul.home-relic-list');
    expect(list).not.toBeNull();

    const items = section.querySelectorAll('li.home-relic');
    expect(items).toHaveLength(3);

    // 1st row: relic-three (lastOpenedAt 3000)
    const kind1 = items[0]?.querySelector('.home-relic-kind');
    const link1 = items[0]?.querySelector('.home-relic-link');
    expect(kind1?.textContent).toBe('Page');
    expect(link1?.textContent).toBe('Third Relic');
    expect(link1?.getAttribute('href')).toBe('/relic-three#r3frag');

    // 2nd row: relic-one (lastOpenedAt 1000)
    const kind2 = items[1]?.querySelector('.home-relic-kind');
    const link2 = items[1]?.querySelector('.home-relic-link');
    expect(kind2?.textContent).toBe('Document');
    expect(link2?.textContent).toBe('relic-one'); // fallback to id
    expect(link2?.getAttribute('href')).toBe('/relic-one#r1frag');

    // 3rd row: relic-two (no lastOpenedAt)
    const kind3 = items[2]?.querySelector('.home-relic-kind');
    const link3 = items[2]?.querySelector('.home-relic-link');
    expect(kind3?.textContent).toBe('Code');
    expect(link3?.textContent).toBe('Second Relic');
    expect(link3?.getAttribute('href')).toBe('/relic-two#r2frag');

    // More link
    const more = section.querySelector('.home-relics-more a');
    expect(more).not.toBeNull();
    expect(more?.getAttribute('href')).toBe('/dashboard');
    expect(more?.textContent).toBe(
      'Back up keys, forget a relic, or find relics you commented on'
    );
  });

  test('(c) a title containing <img src=x onerror=alert(1)> renders as text, no element created', () => {
    const doc = new DocumentStub();
    const section = doc.createElement('section');
    section.id = 'home-relics';
    section.setAttribute('hidden', '');
    doc.body.appendChild(section);

    const xssPayload = '<img src=x onerror=alert(1)>';
    const vault = makeMockVault([
      {
        relicId: 'xss-relic',
        fragment: 'key123',
        expiresAt: null,
        title: xssPayload,
        lastOpenedAt: 100,
      },
    ]);

    renderHomeRelics(doc as unknown as Document, vault);

    // No img elements created
    expect(section.querySelectorAll('img')).toHaveLength(0);

    const link = section.querySelector('.home-relic-link');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe(xssPayload);
  });

  test('(d) no fetch is called (stub globalThis.fetch to throw)', () => {
    const doc = new DocumentStub();
    const section = doc.createElement('section');
    section.id = 'home-relics';
    section.setAttribute('hidden', '');
    doc.body.appendChild(section);

    const vault = makeMockVault([
      {
        relicId: 'offline-relic',
        fragment: 'f123',
        expiresAt: null,
        title: 'Offline Relic',
        lastOpenedAt: 200,
      },
    ]);

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (() => {
        throw new Error('fetch must not be called by home relics list');
      }) as unknown as typeof globalThis.fetch;

      expect(() => {
        renderHomeRelics(doc as unknown as Document, vault);
      }).not.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('(e) the built dist/home.js exists after bun run build, is under 16 KB, and contains neither sucrase nor react nor pdfjs', async () => {
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    const homeFile = Bun.file(`${pkgDir}dist/home.js`);
    expect(await homeFile.exists()).toBe(true);

    const homeJs = await homeFile.text();
    expect(homeJs.length).toBeGreaterThan(0);
    expect(homeJs.length).toBeLessThan(16 * 1024);

    const markers = ['sucrase', 'react', 'pdfjs'];
    const inlined = markers.filter((marker) =>
      homeJs.toLowerCase().includes(marker)
    );
    expect(inlined).toEqual([]);
  });
});
