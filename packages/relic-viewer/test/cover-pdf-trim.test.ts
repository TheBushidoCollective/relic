import { describe, expect, test } from 'bun:test';
import {
  findInkBox,
  PDF_CANVAS_WIDTH,
  PDF_GUTTER_PX,
  PDF_MAX_TRIM_SCALE,
  trimPdfPage,
} from '../src/cover/pdf-trim.ts';

// Page one drawn 600 px wide, the reference render the trim measures.
const PAGE = 600;

describe('trimPdfPage', () => {
  test('a page with ordinary margins is trimmed to its ink plus the gutter', () => {
    // A Letter page with 1 inch margins: ink from 70.6 to 529.4 px.
    const ink = { minX: 71, maxX: 529, minY: 71, maxY: 700 };
    const trim = trimPdfPage(ink, PAGE);
    const cropped = ink.maxX - ink.minX + 2 * PDF_GUTTER_PX;
    expect(trim.scale).toBeCloseTo(PDF_CANVAS_WIDTH / cropped, 9);
    expect(trim.scale).toBeLessThan(PDF_MAX_TRIM_SCALE);
    expect(trim.left).toBeCloseTo(ink.minX - PDF_GUTTER_PX, 9);
    expect(trim.top).toBe(ink.minY - PDF_GUTTER_PX);
  });

  test('a sparse page stops at the cap instead of filling 600 px with one line', () => {
    // One short line at the left margin: 98 px of ink.
    const ink = { minX: 71, maxX: 169, minY: 71, maxY: 86 };
    const trim = trimPdfPage(ink, PAGE);
    expect(trim.scale).toBe(PDF_MAX_TRIM_SCALE);
    // The window is centred on the ink and held inside the page, so a line
    // at the left margin keeps the page's left edge in view.
    expect(trim.left).toBe(0);
    expect(trim.top).toBe(ink.minY - PDF_GUTTER_PX);
  });

  test('a capped crop keeps centred ink centred', () => {
    // A centred title 240 px wide.
    const ink = { minX: 180, maxX: 420, minY: 210, maxY: 260 };
    const trim = trimPdfPage(ink, PAGE);
    expect(trim.scale).toBe(PDF_MAX_TRIM_SCALE);
    const window = PDF_CANVAS_WIDTH / trim.scale;
    expect(trim.left + window / 2).toBeCloseTo((ink.minX + ink.maxX) / 2, 9);
  });

  test('a capped crop never runs past the right edge of the page', () => {
    const ink = { minX: 500, maxX: 580, minY: 40, maxY: 60 };
    const trim = trimPdfPage(ink, PAGE);
    expect(trim.scale).toBe(PDF_MAX_TRIM_SCALE);
    expect(trim.left + PDF_CANVAS_WIDTH / trim.scale).toBeCloseTo(PAGE, 9);
  });

  test('full-bleed ink and a blank page are drawn at the page width', () => {
    expect(
      trimPdfPage({ minX: 0, maxX: 599, minY: 0, maxY: 776 }, PAGE)
    ).toEqual({ scale: 1, left: 0, top: 0 });
    expect(trimPdfPage(null, PAGE)).toEqual({ scale: 1, left: 0, top: 0 });
  });
});

describe('findInkBox', () => {
  test('bounds the pixels darker than white', () => {
    const width = 8;
    const height = 6;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (const [x, y] of [
      [2, 1],
      [5, 4],
    ] as const) {
      const i = (y * width + x) * 4;
      data[i] = 20;
      data[i + 1] = 20;
      data[i + 2] = 20;
    }
    expect(findInkBox(data, width, height)).toEqual({
      minX: 2,
      maxX: 5,
      minY: 1,
      maxY: 4,
    });
    expect(findInkBox(new Uint8ClampedArray(16).fill(255), 2, 2)).toBeNull();
  });
});
