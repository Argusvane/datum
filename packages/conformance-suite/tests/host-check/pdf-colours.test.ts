import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { fillColours, hexComponents, setsFillColour } from "../../src/host-check/pdf-colours.js";

const pdf = (content: string, compress = true): Uint8Array => {
  const data = compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const filter = compress ? " /Filter /FlateDecode" : "";
  return Buffer.concat([Buffer.from(`%PDF-1.7\n4 0 obj\n<< /Length ${data.length}${filter} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]);
};

describe("the PDF fill-colour reader (PDF-06)", () => {
  it("reads the fill colour of a Flate content stream", () => {
    expect(fillColours(pdf("BT 0.0706 0.2039 0.3373 rg (x) Tj ET"))).toEqual([[0.0706, 0.2039, 0.3373]]);
    expect(setsFillColour(pdf("BT 0.0706 0.2039 0.3373 rg (x) Tj ET"), "#123456")).toBe(true);
  });

  it("tells the kit's colour from the engine's own", () => {
    expect(setsFillColour(pdf("BT 0.0667 0.0667 0.0667 rg (x) Tj ET"), "#123456")).toBe(false);
    expect(setsFillColour(pdf("0.0706 0.2039 0.3373 RG"), "#123456")).toBe(false);
  });

  it("reads an uncompressed stream and short numbers", () => {
    expect(fillColours(pdf(".5 0 1 rg", false))).toEqual([[0.5, 0, 1]]);
    expect(hexComponents("#ff0000")).toEqual([1, 0, 0]);
  });
});
