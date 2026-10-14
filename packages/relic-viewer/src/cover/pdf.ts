import type { CoverRenderResult } from '@relic/format/cover';
import * as pdfjsLib from 'pdfjs-dist';
import { findInkBox, PDF_CANVAS_WIDTH, trimPdfPage } from './pdf-trim.ts';

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

  const trim = trimPdfPage(ink, measureCanvas.width);
  const trimScale = trim.scale;
  const leftOffset = -trim.left * trimScale;
  const topOffset = -trim.top * trimScale;

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
