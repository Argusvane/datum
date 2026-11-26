import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import * as fontkit from "fontkit";
import { describe, expect, it } from "vitest";

import { isSfnt, isTtc, isWoff, isWoff2, toSfnt, woffToSfnt } from "../src/woff-to-sfnt.js";

async function dejavu(file: string): Promise<Uint8Array> {
  const root = dirname(createRequire(import.meta.url).resolve("dejavu-fonts-ttf/package.json"));
  return new Uint8Array(await readFile(join(root, "ttf", file)));
}

/** A WOFF 1.0 file made from an sfnt's tables: zlib where it helps, stored where it does not. */
function woffFrom(sfnt: Uint8Array, options: { store?: readonly string[] } = {}): Uint8Array {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const count = view.getUint16(4);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16;
    const tag = String.fromCharCode(sfnt[at]!, sfnt[at + 1]!, sfnt[at + 2]!, sfnt[at + 3]!);
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    const data = sfnt.subarray(offset, offset + length);
    const packed = options.store?.includes(tag) ? data : new Uint8Array(deflateSync(data));
    const stored = packed.length < data.length ? packed : data;
    entries.push({ tag, data, stored, checksum: view.getUint32(at + 4) });
  }
  const directory = 44 + count * 20;
  let offset = directory;
  const placed = entries.map((entry) => {
    const at = offset;
    offset += Math.ceil(entry.stored.length / 4) * 4;
    return { ...entry, at };
  });
  const out = new Uint8Array(offset);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, 0x774f4646);
  outView.setUint32(4, view.getUint32(0));
  outView.setUint32(8, offset);
  outView.setUint16(12, count);
  placed.forEach((entry, index) => {
    const at = 44 + index * 20;
    for (let char = 0; char < 4; char += 1) out[at + char] = entry.tag.charCodeAt(char);
    outView.setUint32(at + 4, entry.at);
    outView.setUint32(at + 8, entry.stored.length);
    outView.setUint32(at + 12, entry.data.length);
    outView.setUint32(at + 16, entry.checksum);
    out.set(entry.stored, entry.at);
  });
  return out;
}

describe("woffToSfnt", () => {
  it("gives back the sfnt a WOFF was made from, byte for byte", async () => {
    const ttf = await dejavu("DejaVuSansMono-Bold.ttf");
    const woff = woffFrom(ttf);
    expect(isWoff(woff)).toBe(true);
    expect(woff.length).toBeLessThan(ttf.length);
    const back = await woffToSfnt(woff);
    expect(back.length).toBe(ttf.length);
    expect(Buffer.from(back).equals(Buffer.from(ttf))).toBe(true);
  });

  it("reads tables the WOFF stored uncompressed, and the result is a font fontkit opens", async () => {
    const ttf = await dejavu("DejaVuSansMono.ttf");
    const back = await woffToSfnt(woffFrom(ttf, { store: ["head", "hhea", "maxp", "cmap"] }));
    expect(Buffer.from(back).equals(Buffer.from(ttf))).toBe(true);
    const font = fontkit.create(Buffer.from(back)) as { familyName: string; hasGlyphForCodePoint(cp: number): boolean };
    expect(font.familyName).toBe("DejaVu Sans Mono");
    expect(font.hasGlyphForCodePoint(0x41)).toBe(true);
  });

  it("passes sfnt bytes through toSfnt unchanged and converts a WOFF", async () => {
    const ttf = await dejavu("DejaVuSansMono.ttf");
    expect(await toSfnt(ttf)).toBe(ttf);
    expect(Buffer.from(await toSfnt(woffFrom(ttf))).equals(Buffer.from(ttf))).toBe(true);
  });

  it("refuses bytes that are no font at all through toSfnt (an HTML error page, an empty body)", async () => {
    await expect(toSfnt(new TextEncoder().encode("<!doctype html><title>404</title>"))).rejects.toThrow(/Not a font file/);
    await expect(toSfnt(new Uint8Array(0))).rejects.toThrow(/Not a font file/);
  });

  it("refuses a TrueType collection through toSfnt by name, since the kernel embeds single TTF and OTF faces only", async () => {
    const ttc = new Uint8Array(32);
    new DataView(ttc.buffer).setUint32(0, 0x74746366); // "ttcf"
    expect(isTtc(ttc)).toBe(true);
    expect(isSfnt(ttc)).toBe(false);
    await expect(toSfnt(ttc)).rejects.toThrow(/TrueType collection/);
    const ttf = await dejavu("DejaVuSansMono.ttf");
    expect(isSfnt(ttf)).toBe(true);
    expect(isTtc(ttf)).toBe(false);
  });

  it("refuses what is not a WOFF 1.0 file, WOFF2 by name, and a table that does not inflate to its length", async () => {
    const ttf = await dejavu("DejaVuSansMono.ttf");
    await expect(woffToSfnt(ttf)).rejects.toThrow("Not a WOFF 1.0 file");
    const woff2 = new Uint8Array(64);
    new DataView(woff2.buffer).setUint32(0, 0x774f4632);
    expect(isWoff2(woff2)).toBe(true);
    await expect(woffToSfnt(woff2)).rejects.toThrow(/WOFF2 is not supported/);
    const liar = woffFrom(ttf);
    // The first table's declared original length is wrong.
    new DataView(liar.buffer).setUint32(44 + 12, 7);
    await expect(woffToSfnt(liar)).rejects.toThrow(/expected 7/);
    await expect(woffToSfnt(woffFrom(ttf).subarray(0, 100))).rejects.toThrow();
  });
});
