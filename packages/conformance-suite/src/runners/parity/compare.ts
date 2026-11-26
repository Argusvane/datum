/** The result of comparing two outcome texts byte for byte. */
export interface ByteComparison {
  equal: boolean;
  lengths: [number, number];
  /** Index of the first differing UTF-16 unit, when the texts differ. */
  firstDifference?: number;
  /** A short window of each text around the first difference. */
  excerpts?: [string, string];
}

/**
 * Compares two serialized outcomes exactly. The comparator is the bytes of the canonical
 * outcome (`kernelStableStringify`), not a projection: a field the program adds, reorders or
 * rounds differently is a difference.
 */
export function compareBytes(left: string, right: string): ByteComparison {
  if (left === right) {
    return { equal: true, lengths: [left.length, right.length] };
  }
  const shared = Math.min(left.length, right.length);
  let at = 0;
  while (at < shared && left.charCodeAt(at) === right.charCodeAt(at)) {
    at += 1;
  }
  const window = (text: string): string => text.slice(Math.max(0, at - 30), at + 50);
  return { equal: false, lengths: [left.length, right.length], firstDifference: at, excerpts: [window(left), window(right)] };
}
