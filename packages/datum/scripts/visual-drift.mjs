// How a capture is compared with its baseline: the perceptual signature's drift rule, shared by
// the form harness (visual-browser.mjs) and the builder harness (builder-browser.mjs).
// Its own module, since both harnesses run on import.

/**
 * How far a capture may move before it is drift. The hash tolerates a few flipped gradient
 * bits (antialiasing); a grid cell is 1/24 of the capture's width and height, so a moved
 * border or a recoloured button shifts a cell's mean luma by tens, while rasterisation
 * differences stay in single digits.
 */
export const THRESHOLDS = { hashBits: 10, cellLuma: 20 };

function hamming(a, b) {
  let bits = 0;
  for (let index = 0; index < a.length; index += 1) {
    let xor = parseInt(a[index], 16) ^ parseInt(b[index], 16);
    while (xor) {
      bits += xor & 1;
      xor >>= 1;
    }
  }
  return bits;
}

/** The worst cell difference between two luma grids (base64 of 576 bytes). */
function worstCell(a, b) {
  const left = Buffer.from(a, "base64");
  const right = Buffer.from(b, "base64");
  let worst = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    worst = Math.max(worst, Math.abs(left[index] - right[index]));
  }
  return worst;
}

/** Why `after` differs from `before` beyond the thresholds, or undefined when it does not. */
export function drift(before, after) {
  if (!before) return "no baseline entry";
  if (before.width !== after.width || before.height !== after.height) {
    return `size ${before.width}×${before.height} → ${after.width}×${after.height}`;
  }
  const bits = hamming(before.dhash, after.dhash);
  if (bits > THRESHOLDS.hashBits) return `hash moved by ${bits} bits`;
  const cell = worstCell(before.grid, after.grid);
  if (cell > THRESHOLDS.cellLuma) return `a grid cell's luma moved by ${cell}`;
  return undefined;
}
