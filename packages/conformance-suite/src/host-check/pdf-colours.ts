import { constants, inflateSync } from "node:zlib";

/**
 * The fill colours a PDF sets (`r g b rg`, each component 0 to 1), read from its bytes: the text outside streams and
 * every stream, inflated when it is Flate-compressed (a page's content stream is, as the PDF program writes it). The
 * per-route binding case (PDF-06) looks for its fixture theme's text colour here: what the PDF was drawn under, not
 * what a header says. The Java kit's PdfContract reads a PDF the same way (PdfColours).
 */
export function fillColours(pdf: Uint8Array): [number, number, number][] {
  const bytes = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  const texts: string[] = [bytes.toString("latin1")];
  const opening = /(?<!end)stream\r?\n/g;
  const whole = texts[0] as string;
  for (let match = opening.exec(whole); match !== null; match = opening.exec(whole)) {
    const start = match.index + match[0].length;
    const end = whole.indexOf("endstream", start);
    if (end < 0) break;
    const data = bytes.subarray(start, end);
    try {
      texts.push(inflateSync(data, { finishFlush: constants.Z_SYNC_FLUSH }).toString("latin1"));
    } catch {
      // Not Flate (an image, a raw stream): its text is in the whole file already.
    }
    opening.lastIndex = end;
  }
  const found: [number, number, number][] = [];
  const number = "(-?(?:\\d+\\.?\\d*|\\.\\d+))";
  const op = new RegExp(`(?<![\\w.])${number}\\s+${number}\\s+${number}\\s+rg(?![\\w])`, "g");
  for (const text of texts) {
    for (const hit of text.matchAll(op)) {
      found.push([Number(hit[1]), Number(hit[2]), Number(hit[3])]);
    }
  }
  return found;
}

/** `#rrggbb` as the three 0 to 1 components a PDF writes. */
export function hexComponents(hex: string): [number, number, number] {
  const value = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (value === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [parseInt(value[1] as string, 16) / 255, parseInt(value[2] as string, 16) / 255, parseInt(value[3] as string, 16) / 255];
}

/** Whether the PDF sets the fill colour `hex` anywhere (each component within 0.002, a PDF writer's rounding). */
export function setsFillColour(pdf: Uint8Array, hex: string): boolean {
  const wanted = hexComponents(hex);
  return fillColours(pdf).some((colour) => colour.every((component, index) => Math.abs(component - (wanted[index] as number)) <= 0.002));
}
