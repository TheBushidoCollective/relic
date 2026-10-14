import type { CoverRenderResult } from '@relic/format/cover';
import * as pdfjsLib from 'pdfjs-dist';

export const PDF_GUTTER_PX = 20;
export const PDF_CANVAS_WIDTH = 600;
export const PDF_CANVAS_HEIGHT = 315;
export const PDF_DEVICE_SCALE = 2;

let workerInitialized = false;

export function ensurePdfWorker(): void {
  if (!workerInitialized) {
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker('/pdf.worker.mjs', {
      type: 'module',
    });
    workerInitialized = true;
  }
}

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

export async function renderPdfCover(
  bytes: Uint8Array,
  root: HTMLElement
): Promise<CoverRenderResult> {
  ensurePdfWorker();

  let pdfDoc: pdfjsLib.PDFDocumentProxy;
  try {
    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    return {
      ok: false,
      reason: 'parse_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let page: pdfjsLib.PDFPageProxy;
  try {
    page = await pdfDoc.getPage(1);
  } catch (err) {
    return {
      ok: false,
      reason: 'parse_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const unscaled = page.getViewport({ scale: 1 });
  const refScale = PDF_CANVAS_WIDTH / unscaled.width;
  const refViewport = page.getViewport({ scale: refScale });

  const measureCanvas = document.createElement('canvas');
  measureCanvas.width = Math.ceil(refViewport.width);
  measureCanvas.height = Math.ceil(refViewport.height);
  const measureCtx = measureCanvas.getContext('2d', {
    willReadFrequently: true,
  });
  if (!measureCtx) {
    return {
      ok: false,
      reason: 'decode_failed',
      detail: 'Could not acquire 2d canvas context for measurement',
    };
  }

  try {
    await page.render({
      canvasContext: measureCtx,
      viewport: refViewport,
      canvas: measureCanvas,
    }).promise;
  } catch (err) {
    return {
      ok: false,
      reason: 'parse_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const imageData = measureCtx.getImageData(
    0,
    0,
    measureCanvas.width,
    measureCanvas.height
  );
  const ink = findInkBox(
    imageData.data,
    measureCanvas.width,
    measureCanvas.height
  );

  const minX = ink !== null ? ink.minX : 0;
  const maxX = ink !== null ? ink.maxX : measureCanvas.width;
  const minY = ink !== null ? ink.minY : 0;

  const cropLeft = Math.max(0, minX - PDF_GUTTER_PX);
  const cropRight = Math.min(measureCanvas.width, maxX + PDF_GUTTER_PX);
  const cropTop = Math.max(0, minY - PDF_GUTTER_PX);
  const croppedWidth = cropRight - cropLeft;

  const trimScale = croppedWidth > 0 ? PDF_CANVAS_WIDTH / croppedWidth : 1;
  const leftOffset = -cropLeft * trimScale;
  const topOffset = -cropTop * trimScale;

  // Render high-resolution vector output onto destination canvas at device scale factor 2.
  const finalScale = refScale * trimScale * PDF_DEVICE_SCALE;
  const finalViewport = page.getViewport({ scale: finalScale });

  const renderCanvas = document.createElement('canvas');
  renderCanvas.width = Math.ceil(finalViewport.width);
  renderCanvas.height = Math.ceil(finalViewport.height);
  renderCanvas.style.position = 'absolute';
  renderCanvas.style.left = `${leftOffset}px`;
  renderCanvas.style.top = `${topOffset}px`;
  renderCanvas.style.width = `${refViewport.width * trimScale}px`;
  renderCanvas.style.height = `${refViewport.height * trimScale}px`;

  const renderCtx = renderCanvas.getContext('2d');
  if (!renderCtx) {
    return {
      ok: false,
      reason: 'decode_failed',
      detail: 'Could not acquire 2d canvas context for final render',
    };
  }

  try {
    await page.render({
      canvasContext: renderCtx,
      viewport: finalViewport,
      canvas: renderCanvas,
    }).promise;
  } catch (err) {
    return {
      ok: false,
      reason: 'parse_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const cv = document.createElement('div');
  cv.className = 'cv cv-pdf';
  cv.style.position = 'relative';
  cv.style.width = `${PDF_CANVAS_WIDTH}px`;
  cv.style.height = `${PDF_CANVAS_HEIGHT}px`;
  cv.style.overflow = 'hidden';
  cv.style.background = '#fff';

  cv.appendChild(renderCanvas);
  root.replaceChildren(cv);

  return { ok: true };
}
