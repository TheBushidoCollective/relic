import type { ArchiveEntry, ArchiveListing } from '@relic/format/cover';

export const MAX_INDENT = 8;

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1000;
  let unit = 0;
  while (value >= 999.5 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 9.95 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export interface TreeRowItem {
  readonly entry: ArchiveEntry;
  readonly depth: number;
  readonly prefix: string;
  readonly name: string;
}

export function treeRows(entries: readonly ArchiveEntry[]): TreeRowItem[] {
  const folders = new Map<string, number>();
  return entries.map((entry) => {
    const bare = entry.path.replace(/\/+$/, '');
    const cut = bare.lastIndexOf('/');
    const parent = cut >= 0 ? bare.slice(0, cut + 1) : '';
    const name =
      (cut >= 0 ? bare.slice(cut + 1) : bare) + (entry.directory ? '/' : '');
    const nested = parent !== '' && folders.has(parent);
    const depth = nested ? (folders.get(parent) ?? 0) + 1 : 0;
    if (entry.directory) folders.set(`${bare}/`, depth);
    return { entry, depth, prefix: nested ? '' : parent, name };
  });
}

export function archiveRow(item: TreeRowItem, ordinal: number): HTMLElement {
  const row = document.createElement('li');
  row.className = item.entry.directory ? 'ar-row is-dir' : 'ar-row';

  const num = document.createElement('span');
  num.className = 'ar-num';
  num.textContent = String(ordinal);

  const path = document.createElement('span');
  path.className = 'ar-path';
  path.style.setProperty('--depth', String(Math.min(item.depth, MAX_INDENT)));
  const dir = document.createElement('span');
  dir.className = 'ar-dir';
  dir.textContent = item.prefix;
  const base = document.createElement('span');
  base.className = 'ar-base';
  base.textContent = item.name;
  const lead = document.createElement('span');
  lead.className = 'ar-lead';
  path.append(dir, base, lead);

  const size = document.createElement('span');
  size.className = 'ar-size';
  size.textContent = item.entry.directory ? '' : formatBytes(item.entry.size);

  row.append(num, path, size);
  return row;
}

export function moreRow(remaining: number | null): HTMLElement {
  const row = document.createElement('li');
  row.className = 'ar-row is-more';
  const num = document.createElement('span');
  num.className = 'ar-num';
  const path = document.createElement('span');
  path.className = 'ar-path';
  path.textContent =
    remaining === null ? 'more' : `+ ${remaining.toLocaleString('en-US')} more`;
  const size = document.createElement('span');
  size.className = 'ar-size';
  row.append(num, path, size);
  return row;
}

export function fitPath(row: HTMLElement): void {
  const dir = row.querySelector('.ar-dir');
  const base = row.querySelector('.ar-base');
  if (!dir || !base || !dir.textContent) return;
  const folders = dir.textContent.split('/').filter(Boolean);
  while (base.scrollWidth > base.clientWidth && folders.length > 0) {
    folders.shift();
    dir.textContent = folders.length > 0 ? `…/${folders.join('/')}/` : '…/';
  }
}

export function layoutArchive(
  cover: HTMLElement,
  listing: ArchiveListing
): void {
  const list = cover.querySelector('.ar');
  const stage = cover.querySelector('.stage');
  if (!list || !stage) return;
  list.replaceChildren();

  const listStyle = getComputedStyle(list);
  const rowHeight = parseFloat(listStyle.getPropertyValue('--row')) || 24;
  const stageStyle = getComputedStyle(stage);
  const room =
    stage.clientHeight -
    parseFloat(stageStyle.paddingTop || '0') -
    parseFloat(stageStyle.paddingBottom || '0') -
    parseFloat(listStyle.paddingTop || '0') -
    parseFloat(listStyle.paddingBottom || '0') -
    parseFloat(listStyle.borderTopWidth || '0') -
    parseFloat(listStyle.borderBottomWidth || '0');
  const capacity = Math.max(1, Math.floor(room / rowHeight));

  const listed = listing.entries.length;
  const total = listing.totalEntries;
  const everything = total !== null && total <= listed && listed <= capacity;
  const shown = everything ? listed : Math.min(listed, capacity - 1);

  const rows = treeRows(listing.entries.slice(0, shown));
  rows.forEach((item, i) => {
    list.append(archiveRow(item, i + 1));
  });
  if (!everything) list.append(moreRow(total === null ? null : total - shown));

  for (const row of Array.from(list.children)) {
    fitPath(row as HTMLElement);
  }
}

export interface ArtworkBox {
  readonly width: number;
  readonly height: number;
}

/**
 * The border box of embedded artwork shown whole in a square of `side` px:
 * its longer edge fills the square, small artwork scaled up and large
 * scaled down, never cropped, so non-square artwork sits inside the square
 * with its hairline hugging the picture.
 */
export function artworkBox(
  naturalWidth: number,
  naturalHeight: number,
  side: number,
  border: number
): ArtworkBox {
  const inner = side - 2 * border;
  const scale = inner / Math.max(naturalWidth, naturalHeight, 1);
  return {
    width: naturalWidth * scale + 2 * border,
    height: naturalHeight * scale + 2 * border,
  };
}

/** Sizes the artwork to the largest square the stage's padding leaves. */
export function fitArtwork(cover: HTMLElement, img: HTMLImageElement): void {
  const stage = cover.querySelector('.stage') as HTMLElement | null;
  if (!stage) return;
  const stageStyle = getComputedStyle(stage);
  const side = Math.min(
    stage.clientWidth -
      parseFloat(stageStyle.paddingLeft || '0') -
      parseFloat(stageStyle.paddingRight || '0'),
    stage.clientHeight -
      parseFloat(stageStyle.paddingTop || '0') -
      parseFloat(stageStyle.paddingBottom || '0')
  );
  const border = parseFloat(getComputedStyle(img).borderTopWidth || '0');
  const box = artworkBox(img.naturalWidth, img.naturalHeight, side, border);
  img.style.width = `${box.width}px`;
  img.style.height = `${box.height}px`;
}

export interface WaveformBounds {
  readonly height: number;
  readonly top: number;
  readonly bottom: number;
}

export async function readWaveformBounds(src: string): Promise<WaveformBounds> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { height: img.naturalHeight, top: -1, bottom: -1 };
  }
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    const rowStart = y * canvas.width * 4;
    for (let x = 0; x < canvas.width; x += 1) {
      const alpha = data[rowStart + x * 4 + 3];
      if (alpha !== undefined && alpha > 24) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  return { height: canvas.height, top, bottom };
}

export function fitWaveform(
  cover: HTMLElement,
  bounds: WaveformBounds | null,
  src: string
): void {
  const wave = cover.querySelector('.wf-wave') as HTMLElement | null;
  if (!wave) return;
  wave.style.setProperty('--wf-src', `url("${src}")`);
  if (!bounds || bounds.top < 0) return;
  const box = wave.clientHeight;
  const inked = bounds.bottom - bounds.top + 1;
  const maskHeight = (box * bounds.height) / inked;
  const offset = -bounds.top * (maskHeight / bounds.height);
  wave.style.setProperty('--wf-h', `${maskHeight}px`);
  wave.style.setProperty('--wf-y', `${offset}px`);
}
