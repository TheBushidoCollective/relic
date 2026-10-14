/**
 * The PDF cover's crop: measured from page one's ink, kept free of pdf.js so
 * the geometry can be checked on its own.
 */

export const PDF_GUTTER_PX = 20;
export const PDF_CANVAS_WIDTH = 600;

/**
 * The most the ink trim may enlarge page one.
 *
 * The trim exists to cut away page margins, and margins are bounded: a
 * Letter page with 1.5 inch margins trims to 1.40, an A4 page with 30 mm
 * margins to 1.28, and the usual 1 inch or 25 mm to 1.20. Ink narrower than
 * that is not a margin story: it is a short line, a centred title or a lone
 * logo, and filling 600 px with it turns one line into a poster. At the cap
 * the crop keeps the extra width on both sides of the ink, inside the page.
 */
export const PDF_MAX_TRIM_SCALE = 1.5;

export interface InkBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export function findInkBox(
  data: Uint8ClampedArray,
  width: number,
  height: number
): InkBox | null {
  let minX = -1;
  let maxX = -1;
  let minY = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4;
      const alpha = data[idx + 3] ?? 0;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      // An ink pixel has visible opacity and is darker than pure white.
      if (alpha > 10 && (r < 250 || g < 250 || b < 250)) {
        if (minX === -1 || x < minX) minX = x;
        if (maxX === -1 || x > maxX) maxX = x;
        if (minY === -1 || y < minY) minY = y;
        if (maxY === -1 || y > maxY) maxY = y;
      }
    }
  }

  if (minX === -1) return null;
  return { minX, maxX, minY, maxY };
}

export interface PdfTrim {
  /** Enlargement of the 600 px reference render. */
  readonly scale: number;
  /** Crop origin in reference px. */
  readonly left: number;
  readonly top: number;
}

/**
 * Where the cover's 600 px window sits on page one, in reference px (the page
 * drawn 600 px wide): the ink box plus the gutter, scaled to fill the width,
 * top-anchored, and never enlarged past PDF_MAX_TRIM_SCALE.
 */
export function trimPdfPage(ink: InkBox | null, pageWidth: number): PdfTrim {
  if (ink === null) return { scale: 1, left: 0, top: 0 };

  const cropLeft = Math.max(0, ink.minX - PDF_GUTTER_PX);
  const cropRight = Math.min(pageWidth, ink.maxX + PDF_GUTTER_PX);
  const top = Math.max(0, ink.minY - PDF_GUTTER_PX);
  const croppedWidth = cropRight - cropLeft;
  if (croppedWidth <= 0) return { scale: 1, left: 0, top };

  const scale = Math.min(PDF_MAX_TRIM_SCALE, PDF_CANVAS_WIDTH / croppedWidth);
  const window = PDF_CANVAS_WIDTH / scale;
  const centre = (cropLeft + cropRight) / 2;
  const left = Math.min(
    Math.max(0, centre - window / 2),
    Math.max(0, pageWidth - window)
  );
  return { scale, left, top };
}
