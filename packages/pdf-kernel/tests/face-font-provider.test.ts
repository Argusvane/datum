import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import type { PdfFontNeed, PdfWarning } from "@argusvane/datum-engine/render";
import { base64ToBytes } from "@argusvane/datum-engine/render";
import { createFaceFontProvider } from "../src/fonts.js";

async function dejavu(file: string): Promise<Uint8Array> {
  const root = dirname(createRequire(import.meta.url).resolve("dejavu-fonts-ttf/package.json"));
  return new Uint8Array(await readFile(join(root, "ttf", file)));
}

/** A one-table WOFF around the given sfnt, enough for the reader to convert. */
function woffAround(sfnt: Uint8Array): Uint8Array {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const count = view.getUint16(4);
  const tables = [];
  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16;
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    const data = sfnt.subarray(offset, offset + length);
    const packed = new Uint8Array(deflateSync(data));
    tables.push({ tag: sfnt.subarray(at, at + 4), data, stored: packed.length < data.length ? packed : data });
  }
  let offset = 44 + count * 20;
  const out = new Uint8Array(offset + tables.reduce((sum, table) => sum + Math.ceil(table.stored.length / 4) * 4, 0));
  const outView = new DataView(out.buffer);
  outView.setUint32(0, 0x774f4646);
  outView.setUint32(4, view.getUint32(0));
  outView.setUint16(12, count);
  tables.forEach((table, index) => {
    const at = 44 + index * 20;
    out.set(table.tag, at);
    outView.setUint32(at + 4, offset);
    outView.setUint32(at + 8, table.stored.length);
    outView.setUint32(at + 12, table.data.length);
    out.set(table.stored, offset);
    offset += Math.ceil(table.stored.length / 4) * 4;
  });
  return out;
}

const faces = [
  { family: "Lato", file: "lato-400.woff", weight: 400 },
  { family: "Lato", file: "lato-700.woff", weight: 700 },
  { family: "Missing Sans", file: "missing.woff" }
];

function need(overrides: Partial<PdfFontNeed> = {}): { need: PdfFontNeed; warnings: PdfWarning[] } {
  const warnings: PdfWarning[] = [];
  return { need: { families: ["Lato", "Missing Sans"], scripts: ["Latn"], faces, warn: (warning) => warnings.push(warning), ...overrides }, warnings };
}

describe("createFaceFontProvider", () => {
  it("loads a theme's WOFF faces as sfnt resources, once per location", async () => {
    const ttf = await dejavu("DejaVuSansMono.ttf");
    const woff = woffAround(ttf);
    const reads: string[] = [];
    const provider = createFaceFontProvider({
      baseUrl: "https://fonts.example/gcds",
      read: async (location) => {
        reads.push(location);
        if (location.includes("missing")) throw new Error("404");
        return woff;
      }
    });
    const first = need({ themeId: "gcds" });
    const resources = await provider.resolve(first.need);
    expect(resources.map((resource) => [resource.family, resource.weight, resource.id])).toEqual([
      ["Lato", 400, "https://fonts.example/gcds/lato-400.woff"],
      ["Lato", 700, "https://fonts.example/gcds/lato-700.woff"]
    ]);
    expect(Buffer.from(base64ToBytes(resources[0]!.data)).equals(Buffer.from(ttf))).toBe(true);
    // One face that failed is one warning, not a failed document; the others still load.
    expect(first.warnings).toEqual([{ code: "font.faceFailed", message: expect.stringContaining('"missing.woff" for "Missing Sans" could not be loaded (404)') }]);

    await provider.resolve(need({ themeId: "gcds" }).need);
    expect(reads.filter((location) => location.includes("lato-400"))).toHaveLength(1);
    // A failed read is not remembered: the host that serves the file later gets it.
    expect(reads.filter((location) => location.includes("missing"))).toHaveLength(2);
  });

  it("addresses the files per theme and reports a theme it has no folder for", async () => {
    const ttf = await dejavu("DejaVuSansMono.ttf");
    const reads: string[] = [];
    const provider = createFaceFontProvider({
      baseUrl: (themeId) => (themeId === "gcds" ? "/fonts/gcds" : themeId === "other" ? "/fonts/other" : undefined),
      read: async (location) => {
        reads.push(location);
        return ttf;
      }
    });
    const lato = [{ family: "Lato", file: "lato.ttf" }];
    const a = need({ themeId: "gcds", faces: lato, families: ["Lato"] });
    const b = need({ themeId: "other", faces: lato, families: ["Lato"] });
    await provider.resolve(a.need);
    await provider.resolve(b.need);
    expect(reads).toEqual(["/fonts/gcds/lato.ttf", "/fonts/other/lato.ttf"]);

    const none = need({ themeId: "datum-pdf", faces: lato, families: ["Lato"] });
    expect(await provider.resolve(none.need)).toEqual([]);
    expect(none.warnings).toEqual([{ code: "font.faceFailed", message: expect.stringContaining('No font folder is configured for the PDF theme "datum-pdf"') }]);
  });

  it("reports a file that is not a font as a warning too, and loads nothing for families the document does not name", async () => {
    const provider = createFaceFontProvider({
      baseUrl: "/fonts",
      read: async () => {
        const html = new TextEncoder().encode("<!doctype html>");
        return new Uint8Array([...new Uint8Array(new Uint32Array([0x774f4646]).buffer).reverse(), ...html]);
      }
    });
    const bad = need({ families: ["Lato"], faces: [{ family: "Lato", file: "lato.woff" }] });
    expect(await provider.resolve(bad.need)).toEqual([]);
    expect(bad.warnings.map((warning) => warning.code)).toEqual(["font.faceFailed"]);

    const collection = createFaceFontProvider({
      baseUrl: "/fonts",
      read: async () => {
        const ttc = new Uint8Array(64);
        new DataView(ttc.buffer).setUint32(0, 0x74746366); // "ttcf"
        return ttc;
      }
    });
    const ttc = need({ families: ["Lato"], faces: [{ family: "Lato", file: "lato.ttc" }] });
    expect(await collection.resolve(ttc.need)).toEqual([]);
    expect(ttc.warnings).toEqual([{ code: "font.faceFailed", message: expect.stringContaining("TrueType collection") }]);

    const other = need({ families: ["Something Else"] });
    expect(await provider.resolve(other.need)).toEqual([]);
    expect(other.warnings).toEqual([]);
  });
});
