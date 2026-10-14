import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ArchiveEntry, ArchiveListing } from '@relic/format/cover';
import {
  archiveRow,
  fitPath,
  fitWaveform,
  formatBytes,
  layoutArchive,
  moreRow,
  treeRows,
} from '../src/cover/layouts.ts';

interface GlobalWithDom {
  document?: {
    createElement: (tag: string) => ElementStub;
  };
  getComputedStyle?: (el: ElementStub) => {
    getPropertyValue: (name: string) => string;
    paddingTop: string;
    paddingBottom: string;
    borderTopWidth: string;
    borderBottomWidth: string;
  };
}

const domGlobal = globalThis as unknown as GlobalWithDom;

class ElementStub {
  readonly tagName: string;
  className = '';
  textContent = '';
  readonly children: ElementStub[] = [];
  readonly style = {
    _props: new Map<string, string>(),
    setProperty(name: string, value: string): void {
      this._props.set(name, value);
    },
    getPropertyValue(name: string): string {
      return this._props.get(name) ?? '';
    },
  };
  clientHeight = 315;
  clientWidth = 100;
  scrollWidth = 100;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  append(...kids: (ElementStub | string)[]): void {
    for (const kid of kids) {
      if (typeof kid === 'string') {
        const text = new ElementStub('#text');
        text.textContent = kid;
        this.children.push(text);
      } else {
        this.children.push(kid);
      }
    }
  }

  appendChild(child: ElementStub): ElementStub {
    this.children.push(child);
    return child;
  }

  replaceChildren(...kids: (ElementStub | string)[]): void {
    this.children.length = 0;
    this.append(...kids);
  }

  querySelector(selector: string): ElementStub | null {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      const walk = (el: ElementStub): ElementStub | null => {
        if (el.className.split(' ').includes(cls)) return el;
        for (const child of el.children) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    }
    return null;
  }
}

describe('formatBytes', () => {
  test('handles null and undefined', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(undefined)).toBe('');
  });

  test('formats bytes below 1000', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(142)).toBe('142 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  test('formats kilobytes, megabytes, and gigabytes', () => {
    expect(formatBytes(1236)).toBe('1.2 KB');
    expect(formatBytes(42310)).toBe('42 KB');
    expect(formatBytes(1184023)).toBe('1.2 MB');
    expect(formatBytes(48213904)).toBe('48 MB');
    expect(formatBytes(1000000000)).toBe('1.0 GB');
  });
});

describe('treeRows', () => {
  test('calculates correct nesting depths for hierarchically ordered archive entries', () => {
    const entries: readonly ArchiveEntry[] = [
      { path: 'repo/', size: null, directory: true },
      { path: 'repo/.github/', size: null, directory: true },
      { path: 'repo/.github/workflows/', size: null, directory: true },
      { path: 'repo/.github/workflows/ci.yml', size: 1236, directory: false },
      { path: 'repo/README.md', size: 6912, directory: false },
    ];
    const e0 = entries[0];
    const e1 = entries[1];
    const e2 = entries[2];
    const e3 = entries[3];
    const e4 = entries[4];
    if (!e0 || !e1 || !e2 || !e3 || !e4) {
      throw new Error('Expected 5 entries');
    }

    const rows = treeRows(entries);
    expect(rows.length).toBe(5);

    expect(rows[0]).toEqual({
      entry: e0,
      depth: 0,
      prefix: '',
      name: 'repo/',
    });

    expect(rows[1]).toEqual({
      entry: e1,
      depth: 1,
      prefix: '',
      name: '.github/',
    });

    expect(rows[2]).toEqual({
      entry: e2,
      depth: 2,
      prefix: '',
      name: 'workflows/',
    });

    expect(rows[3]).toEqual({
      entry: e3,
      depth: 3,
      prefix: '',
      name: 'ci.yml',
    });

    expect(rows[4]).toEqual({
      entry: e4,
      depth: 1,
      prefix: '',
      name: 'README.md',
    });
  });

  test('leaves entries without ancestor folders at depth 0 with full prefix', () => {
    const entries: readonly ArchiveEntry[] = [
      { path: 'site/assets/images/hero.avif', size: 318220, directory: false },
    ];

    const e0 = entries[0];
    if (!e0) throw new Error('Expected 1 entry');
    const rows = treeRows(entries);
    expect(rows[0]).toEqual({
      entry: e0,
      depth: 0,
      prefix: 'site/assets/images/',
      name: 'hero.avif',
    });
  });
});

describe('archive rows and fitPath', () => {
  beforeEach(() => {
    domGlobal.document = {
      createElement: (tag: string) => new ElementStub(tag),
    };
  });

  afterEach(() => {
    delete domGlobal.document;
  });

  test('archiveRow sets textContent and class attributes cleanly', () => {
    const item = {
      entry: { path: 'src/main.ts', size: 2451, directory: false },
      depth: 1,
      prefix: '',
      name: 'main.ts',
    };
    const row = archiveRow(item, 4);

    expect(row.className).toBe('ar-row');
    expect(row.querySelector('.ar-num')?.textContent).toBe('4');
    expect(row.querySelector('.ar-base')?.textContent).toBe('main.ts');
    expect(row.querySelector('.ar-size')?.textContent).toBe('2.5 KB');
  });

  test('directory row omits size and carries is-dir class', () => {
    const item = {
      entry: { path: 'src/', size: null, directory: true },
      depth: 0,
      prefix: '',
      name: 'src/',
    };
    const row = archiveRow(item, 1);

    expect(row.className).toBe('ar-row is-dir');
    expect(row.querySelector('.ar-size')?.textContent).toBe('');
  });

  test('moreRow formats remaining count or plain more string', () => {
    const rowWithCount = moreRow(142);
    expect(rowWithCount.className).toBe('ar-row is-more');
    expect(rowWithCount.querySelector('.ar-path')?.textContent).toBe(
      '+ 142 more'
    );

    const rowWithoutCount = moreRow(null);
    expect(rowWithoutCount.querySelector('.ar-path')?.textContent).toBe('more');
  });

  test('fitPath truncates leading folder segments when base overflows client width', () => {
    const row = new ElementStub('li');
    const path = new ElementStub('span');
    const dir = new ElementStub('span');
    dir.className = 'ar-dir';
    dir.textContent = 'site/assets/images/';
    const base = new ElementStub('span');
    base.className = 'ar-base';
    base.textContent = 'hero-north-field.avif';

    base.clientWidth = 100;
    Object.defineProperty(base, 'scrollWidth', {
      get() {
        return dir.textContent.includes('site') ? 150 : 80;
      },
    });

    path.append(dir, base);
    row.append(path);

    fitPath(row as unknown as HTMLElement);
    expect(dir.textContent).toBe('…/assets/images/');
  });
});

describe('layoutArchive', () => {
  beforeEach(() => {
    domGlobal.document = {
      createElement: (tag: string) => new ElementStub(tag),
    };
    domGlobal.getComputedStyle = (el: ElementStub) => ({
      getPropertyValue: (name: string) => el.style.getPropertyValue(name),
      paddingTop: '0px',
      paddingBottom: '0px',
      borderTopWidth: '0px',
      borderBottomWidth: '0px',
    });
  });

  afterEach(() => {
    delete domGlobal.document;
    delete domGlobal.getComputedStyle;
  });

  test('populates list element with rows according to capacity', () => {
    const cover = new ElementStub('div');
    const stage = new ElementStub('main');
    stage.className = 'stage';
    stage.clientHeight = 315;

    const ol = new ElementStub('ol');
    ol.className = 'ar';
    stage.appendChild(ol);
    cover.appendChild(stage);

    const listing: ArchiveListing = {
      format: 'zip',
      totalEntries: 25,
      totalBytes: 50000,
      entries: [
        { path: 'file1.txt', size: 100, directory: false },
        { path: 'file2.txt', size: 200, directory: false },
        { path: 'file3.txt', size: 300, directory: false },
      ],
    };

    layoutArchive(cover as unknown as HTMLElement, listing);
    expect(ol.children.length).toBeGreaterThan(0);
  });
});

describe('fitWaveform', () => {
  test('sets CSS mask variables for audio waveform styling', () => {
    const cover = new ElementStub('div');
    const wave = new ElementStub('div');
    wave.className = 'wf-wave';
    wave.clientHeight = 200;
    cover.appendChild(wave);

    const bounds = { height: 600, top: 100, bottom: 500 };
    fitWaveform(
      cover as unknown as HTMLElement,
      bounds,
      'data:image/png;base64,test'
    );

    expect(wave.style.getPropertyValue('--wf-src')).toBe(
      'url("data:image/png;base64,test")'
    );
    expect(wave.style.getPropertyValue('--wf-h')).not.toBe('');
    expect(wave.style.getPropertyValue('--wf-y')).not.toBe('');
  });
});
