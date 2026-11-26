/**
 * Where the printed sheets are estimated to start (the Print workspace's dashed lines): a pure
 * walk of the print document's blocks, measured top to bottom on one continuous sheet, against
 * the height a page's content has (the paper's height less its top and bottom margins).
 *
 * The rules are the print document's own (`render/print/document.ts`): a field, a piece of
 * content, a notice and a table row never split, so a block that would cross the foot of a page
 * starts the next one; a container kept together moves whole where it fits on one page; a
 * component that starts a new page starts one wherever it falls; and a leaf block taller than a
 * whole page splits where the pages end, since no browser can move it anywhere it would fit (a
 * container that tall is cut by the blocks inside it instead). An
 * estimate, not the printer's own pagination: the dialog's scale, its margins and its fonts can
 * all move a break.
 */

/** One block of the document, measured on the continuous sheet from the top of the content. */
export interface PrintBlock {
  /** Its top, in CSS px from the top of the first page's content. */
  top: number;
  /** Its height in CSS px. */
  height: number;
  /** It starts a new page (`datum-print__break-before`), the first block of the document aside. */
  breakBefore?: boolean;
  /** The component it draws, when it has one (`data-component-id`). */
  componentId?: string;
  /** Another measured block lies inside it: those blocks paginate it, so it is never split at page multiples itself. */
  container?: boolean;
}

/** Where a page after the first starts. */
export interface PrintPageStart {
  /** The page's number: 2 for the second sheet. */
  page: number;
  /** Where its content starts, in CSS px from the top of the first page's content. */
  top: number;
  /** The author's break (`breakBefore`) started it, not the foot of the page before. */
  forced: boolean;
  /** The component that starts it, when the block that starts it draws one. */
  componentId?: string;
}

export interface PrintPagination {
  /** The pages after the first, in order. */
  starts: PrintPageStart[];
  /** How many pages, at least one. */
  pages: number;
}

/** A hair of slack, so a block that ends exactly at the foot of a page (or rounds past it) stays on it. */
const EPSILON = 0.5;

/** The page starts for `blocks` on pages whose content is `pageHeight` px tall. Never throws. */
export function estimatePageStarts(blocks: readonly PrintBlock[], pageHeight: number): PrintPagination {
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) {
    return { starts: [], pages: 1 };
  }
  const usable = blocks
    .filter((block) => Number.isFinite(block.top) && Number.isFinite(block.height) && block.height >= 0)
    // Top to bottom; at one top, the outer block first (a container before its first field).
    .sort((a, b) => a.top - b.top || b.height - a.height);
  const starts: PrintPageStart[] = [];
  let pageTop = usable.length > 0 ? Math.min(0, usable[0]!.top) : 0;
  const begin = (top: number, forced: boolean, componentId: string | undefined): void => {
    pageTop = top;
    starts.push({ page: starts.length + 2, top, forced, ...(componentId !== undefined ? { componentId } : {}) });
  };
  for (const block of usable) {
    const bottom = block.top + block.height;
    if (block.breakBefore === true && block.top > pageTop + EPSILON) {
      begin(block.top, true, block.componentId);
    } else if (block.top >= pageTop + pageHeight - EPSILON) {
      // Past the foot of the page altogether (a gap, a block measured below the last one): a page per page of distance.
      while (block.top >= pageTop + pageHeight - EPSILON) {
        begin(pageTop + pageHeight, false, undefined);
      }
    }
    if (bottom <= pageTop + pageHeight + EPSILON) {
      continue;
    }
    if (block.height <= pageHeight + EPSILON && block.top > pageTop + EPSILON) {
      // Crosses the foot and fits on a page of its own: it moves whole to the next one.
      begin(block.top, false, block.componentId);
      continue;
    }
    if (block.container === true && block.height > pageHeight + EPSILON) {
      // A group taller than a page is cut by the fields and breaks inside it, which come next in the walk.
      continue;
    }
    // Taller than a page, or already at a page's top: it splits where each page ends.
    while (bottom > pageTop + pageHeight + EPSILON) {
      begin(pageTop + pageHeight, false, undefined);
    }
  }
  return { starts, pages: starts.length + 1 };
}
