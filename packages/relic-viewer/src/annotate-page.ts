/**
 * Anchor adapter for page-based annotations on multi-page documents (PDFs).
 *
 * Each mark points to a specific page number, and optionally a unit rectangle
 * (rect) or an exact quote on that page. When the anchor's page is not the
 * visible page, paint returns false: painting page 3's box onto page 1's canvas
 * would falsely claim the comment points at page 1 content. Returning false
 * lets the thread row indicate the comment points to a part of the document
 * not currently shown.
 */

import {
  type AnchorAdapter,
  type AnchorSurface,
  boxFromUnit,
} from './anchoring.ts';

export const pageAnchorAdapter: AnchorAdapter<'page'> = {
  kind: 'page',

  label(anchor): string {
    const base = `Commenting on page ${anchor.page}`;
    if (anchor.exact !== undefined && anchor.exact.length > 0) {
      return `${base}: "${anchor.exact}"`;
    }
    return base;
  },

  supports(surface: AnchorSurface): boolean {
    const isCanvas =
      typeof HTMLCanvasElement !== 'undefined'
        ? surface.content instanceof HTMLCanvasElement
        : surface.content.tagName === 'CANVAS';
    return (
      isCanvas && surface.content.classList?.contains('relic-page') === true
    );
  },

  paint(surface, overlay, anchor, commentId): boolean {
    const pageAttr = surface.content.dataset.pageNumber;
    const visiblePage =
      pageAttr !== undefined ? Number.parseInt(pageAttr, 10) : 1;
    if (visiblePage !== anchor.page) {
      // The anchor points to a different page. Never paint a mark on the wrong
      // page. Returning false marks the comment as unplaceable on this view.
      return false;
    }
    if (anchor.rect !== undefined) {
      const box = boxFromUnit(surface, anchor.rect);
      if (box === undefined) return false;

      const mark = document.createElement('div');
      mark.className = 'mark-page mark-region';
      mark.dataset.commentId = commentId;
      mark.style.left = `${box.left}px`;
      mark.style.top = `${box.top}px`;
      mark.style.width = `${box.width}px`;
      mark.style.height = `${box.height}px`;
      overlay.appendChild(mark);
      return true;
    }

    // Bare page comment with no bounding box: paint a subtle indicator
    // highlighting the canvas content box.
    const box = boxFromUnit(surface, { x: 0, y: 0, w: 1, h: 1 });
    if (box !== undefined) {
      const mark = document.createElement('div');
      mark.className = 'mark-page mark-page-whole';
      mark.dataset.commentId = commentId;
      mark.style.left = `${box.left}px`;
      mark.style.top = `${box.top}px`;
      mark.style.width = `${box.width}px`;
      mark.style.height = `${box.height}px`;
      overlay.appendChild(mark);
      return true;
    }

    return false;
  },

  reveal(surface, anchor): void {
    const pageAttr = surface.content.dataset.pageNumber;
    const visiblePage =
      pageAttr !== undefined ? Number.parseInt(pageAttr, 10) : 1;
    if (visiblePage !== anchor.page) {
      surface.content.dispatchEvent(
        new CustomEvent('relic:turn-page', {
          detail: { page: anchor.page },
          bubbles: true,
        })
      );
    }

    if (anchor.rect !== undefined) {
      const box = boxFromUnit(surface, anchor.rect);
      if (box !== undefined && surface.host !== undefined) {
        surface.host.scrollTo({
          top: box.top,
          behavior: 'smooth',
        });
      }
    }
  },
};
