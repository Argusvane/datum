import { afterEach, describe, expect, it, vi } from "vitest";

import { PLAIN_PDF_THEME, DEFAULT_PDF_THEME } from "@argusvane/datum-engine";

import { ACME_PDF_THEME } from "./fixtures/acme-theme.js";
import { createPdfSupport } from "../src/pdf.js";
import { themes } from "../src/themes.js";

/**
 * The PDF module's font provider: the DejaVu pair from `fonts/` beside the bundle,
 * and a theme's own faces — named in the document's font need, fetched relative to the bundle
 * the first time a document asks for their family — ahead of them.
 */
/** An sfnt header (TrueType flavour, no tables): the 12 bytes the face reader needs to call it a font. */
const TTF = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

/** A WOFF 1.0 file of one stored (uncompressed) four-byte table, and the 32-byte sfnt it converts to. */
function tinyWoff(): { woff: Uint8Array<ArrayBuffer>; sfnt: Uint8Array<ArrayBuffer> } {
  const table = [0x41, 0x42, 0x43, 0x44];
  const woff = new Uint8Array(44 + 20 + 4);
  const view = new DataView(woff.buffer);
  view.setUint32(0, 0x774f4646); // "wOFF"
  view.setUint32(4, 0x00010000);
  view.setUint32(8, woff.length);
  view.setUint16(12, 1);
  woff.set([0x74, 0x65, 0x73, 0x74], 44); // "test"
  view.setUint32(48, 64);
  view.setUint32(52, 4);
  view.setUint32(56, 4);
  woff.set(table, 64);
  const sfnt = new Uint8Array(12 + 16 + 4);
  const out = new DataView(sfnt.buffer);
  out.setUint32(0, 0x00010000);
  out.setUint16(4, 1);
  out.setUint16(6, 16);
  out.setUint16(10, 0);
  sfnt.set([0x74, 0x65, 0x73, 0x74], 12);
  out.setUint32(16, ((0x41 << 24) | (0x42 << 16) | (0x43 << 8) | 0x44) >>> 0);
  out.setUint32(20, 28);
  out.setUint32(24, 4);
  sfnt.set(table, 28);
  return { woff, sfnt };
}

function fetchStub(): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = [];
  const { woff } = tinyWoff();
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response(url.endsWith(".woff") ? woff : TTF, { status: 200 });
  });
  return { calls, fetch: stub as unknown as typeof fetch };
}

function base64Bytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

describe("createPdfSupport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches a theme's faces beside the bundle only for the families a document names, once", async () => {
    const { calls, fetch } = fetchStub();
    vi.stubGlobal("fetch", fetch);
    const support = await createPdfSupport({ bundleUrl: "https://host.example/datum/", fontsUrl: "https://host.example/datum/fonts/" });
    const faces = ACME_PDF_THEME.assets!.fonts!;
    // The pack alone: nothing of the theme is fetched.
    const dejavu = await support.fonts!.resolve({ families: ["sans-serif"], scripts: ["Latn"], faces });
    expect(dejavu.map((resource) => resource.id)).toEqual(["dejavu-sans", "dejavu-sans-bold"]);
    expect(calls.filter((url) => url.includes("acme-fonts"))).toEqual([]);
    // A document in Acme Sans: its faces, then the pack for the scripts they lack.
    const acme = await support.fonts!.resolve({ families: ["Acme Sans", "sans-serif"], scripts: ["Latn", "Cyrl"], faces });
    const acmeFaces = faces.filter((face) => face.family === "Acme Sans");
    expect(acme.slice(0, acmeFaces.length).map((resource) => [resource.id, resource.family, resource.weight, resource.style])).toEqual(
      acmeFaces.map((face) => [`https://host.example/datum/${face.file}`, face.family, face.weight, face.style])
    );
    expect(acme.map((resource) => resource.id)).toContain("dejavu-sans");
    expect(calls.filter((url) => url.includes("acme-fonts")).sort()).toEqual(acmeFaces.map((face) => `https://host.example/datum/${face.file}`).sort());
    // Asked again, the files are not fetched twice.
    const before = calls.length;
    await support.fonts!.resolve({ families: ["Acme Sans"], scripts: ["Latn"], faces });
    expect(calls.length).toBe(before);
    // A need without faces (its theme ships none) loads nothing of any theme.
    await support.fonts!.resolve({ families: ["Lato"], scripts: ["Latn"] });
    expect(calls.filter((url) => url.includes("lato"))).toEqual([]);
  });

  it("converts a WOFF 1.0 face to the sfnt the kernel embeds", async () => {
    const { fetch } = fetchStub();
    vi.stubGlobal("fetch", fetch);
    const support = await createPdfSupport({ bundleUrl: "https://host.example/datum/", fontsUrl: "https://host.example/datum/fonts/" });
    const warnings: unknown[] = [];
    const faces = [{ family: "Acme Web", weight: 400, style: "normal" as const, file: "acme-fonts/web/acme-web-400.woff", coverage: ["Latn"] }];
    const resolved = await support.fonts!.resolve({ families: ["Acme Web"], scripts: ["Latn"], faces, warn: (warning) => warnings.push(warning) });
    expect(warnings).toEqual([]);
    const web = resolved.find((resource) => resource.family === "Acme Web");
    expect(web?.id).toBe("https://host.example/datum/acme-fonts/web/acme-web-400.woff");
    expect(Array.from(base64Bytes(web!.data))).toEqual(Array.from(tinyWoff().sfnt));
  });

  it("asks a bundleUrl function for each PDF theme's folder, and warns font.faceFailed for a theme it has none for", async () => {
    const { calls, fetch } = fetchStub();
    vi.stubGlobal("fetch", fetch);
    const support = await createPdfSupport({
      bundleUrl: (themeId) => (themeId === "acme" ? "https://cdn.example/acme/" : undefined),
      fontsUrl: "https://host.example/datum/fonts/"
    });
    const faces = ACME_PDF_THEME.assets!.fonts!.filter((face) => face.family === "Acme Display");
    const acmeWarnings: Array<{ code: string }> = [];
    const acme = await support.fonts!.resolve({ families: ["Acme Display"], scripts: ["Latn"], faces, themeId: "acme", warn: (warning) => acmeWarnings.push(warning) });
    expect(acmeWarnings).toEqual([]);
    expect(acme.map((resource) => resource.id)).toContain(`https://cdn.example/acme/${faces[0]!.file}`);
    expect(calls).toContain(`https://cdn.example/acme/${faces[0]!.file}`);

    const otherWarnings: Array<{ code: string; message: string }> = [];
    const before = calls.length;
    const other = await support.fonts!.resolve({ families: ["Acme Display"], scripts: ["Latn"], faces, themeId: "beta", warn: (warning) => otherWarnings.push(warning) });
    expect(other.some((resource) => resource.family === "Acme Display")).toBe(false);
    expect(otherWarnings.map((warning) => warning.code)).toEqual(["font.faceFailed"]);
    expect(otherWarnings[0]!.message).toContain('"beta"');
    expect(calls.slice(before).filter((url) => url.includes("acme-display"))).toEqual([]);
  });
});

describe("the page's PDF themes", () => {
  it("lists the engine's form look and the plain record it drew before, by id", () => {
    const ids = themes.pdfOptions().map((option) => option.id);
    expect(ids).toContain("default");
    expect(ids).toContain(PLAIN_PDF_THEME.id);
    expect(themes.resolvePdf("default")).toBe(DEFAULT_PDF_THEME);
    expect(themes.resolvePdf(PLAIN_PDF_THEME.id)).toBe(PLAIN_PDF_THEME);
  });
});
