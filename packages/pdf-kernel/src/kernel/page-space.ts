/**
 * A template page as a reader sees it: its crop box (where the viewer cuts the page), turned by
 * its `/Rotate`. That is the space the designer's page viewer draws — pdf.js lays a page out
 * the same way — so the page sizes `inspect` reports, the field boxes it lists and the areas
 * an author draws are all in it, and the kernel turns them into the page's own coordinates (its
 * user space, y from the bottom of the media box, unrotated) where it writes.
 *
 * Two conventions over the one space: areas are top-down (`x`, `y` from the top-left corner,
 * the layout's), field boxes are bottom-up (`y` from the bottom edge, the ABI's PDF convention).
 */
import type { PDFPage } from "@cantoo/pdf-lib";

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `[a b c d e f]`: user = (a·x + c·y + e, b·x + d·y + f) for a bottom-up point of the displayed page. */
export type Matrix = [number, number, number, number, number, number];

export interface PageSpace {
  /** The displayed page's size, in points. */
  width: number;
  height: number;
  /** Clockwise quarter turns, as `/Rotate` gives them. */
  rotation: 0 | 90 | 180 | 270;
  /** Displayed (bottom-up) to user space. */
  matrix: Matrix;
  /** Whether the two spaces are one (no crop offset, no turn): nothing to transform. */
  identity: boolean;
}

/** `/Rotate` reduced to a quarter turn, as viewers read it (a value off the quarters is no turn). */
function quarterTurn(angle: number): 0 | 90 | 180 | 270 {
  if (!Number.isFinite(angle) || angle % 90 !== 0) {
    return 0;
  }
  return (((angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

/** The page's visible box: the crop box within the media box (pdf.js's `view`). */
function visibleBox(page: PDFPage): PageRect {
  const media = page.getMediaBox();
  let crop: PageRect = media;
  try {
    crop = page.getCropBox();
  } catch {
    // No crop box readable: the media box is what shows.
  }
  const x1 = Math.max(media.x, crop.x);
  const y1 = Math.max(media.y, crop.y);
  const x2 = Math.min(media.x + media.width, crop.x + crop.width);
  const y2 = Math.min(media.y + media.height, crop.y + crop.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : media;
}

export function pageSpace(page: PDFPage): PageSpace {
  const media = page.getMediaBox();
  const box = visibleBox(page);
  let rotation: 0 | 90 | 180 | 270 = 0;
  try {
    rotation = quarterTurn(page.getRotation().angle);
  } catch {
    rotation = 0;
  }
  const { x: cx, y: cy, width: cw, height: ch } = box;
  const turned = rotation === 90 || rotation === 270;
  const matrix: Matrix =
    rotation === 90
      ? [0, 1, -1, 0, cx + cw, cy]
      : rotation === 180
        ? [-1, 0, 0, -1, cx + cw, cy + ch]
        : rotation === 270
          ? [0, -1, 1, 0, cx, cy + ch]
          : [1, 0, 0, 1, cx, cy];
  return {
    width: turned ? ch : cw,
    height: turned ? cw : ch,
    rotation,
    matrix,
    // The page's own space, the one pdf-lib's `getHeight()` flips in: no turn, all of a media box at the origin.
    identity: rotation === 0 && cx === 0 && cy === 0 && media.x === 0 && media.y === 0 && cw === media.width && ch === media.height
  };
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function bounds(points: Array<[number, number]>): PageRect {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function corners(rect: PageRect): Array<[number, number]> {
  return [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height]
  ];
}

/** A top-down rectangle on the displayed page (an area's) in user space, bottom-up. */
export function displayRectToUser(space: PageSpace, rect: PageRect): PageRect {
  const bottomUp = { x: rect.x, y: space.height - rect.y - rect.height, width: rect.width, height: rect.height };
  return bounds(corners(bottomUp).map(([x, y]) => apply(space.matrix, x, y)));
}

/** A user-space rectangle (a widget's `/Rect`) on the displayed page, bottom-up as the ABI reports field boxes. */
export function userRectToDisplay(space: PageSpace, rect: PageRect): PageRect {
  const inverse = invert(space.matrix);
  return bounds(corners(rect).map(([x, y]) => apply(inverse, x, y)));
}
