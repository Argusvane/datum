import { describe, expect, it } from "vitest";

import {
  PDF_ABI_VERSION,
  PdfKernelError,
  pdfAbiCompatible,
  unwrapPdfResponse
} from "../form-engine/render/pdf/pdf-abi.js";
import type { PdfDocument } from "../form-engine/render/pdf/pdf-document.js";
import { DEFAULT_PDF_COLORS, DEFAULT_PDF_TYPOGRAPHY } from "../form-engine/render/pdf/pdf-theme.js";
import {
  BASE64_TEMPLATE_RESOLVER,
  base64ToBytes,
  buildPdfFillRequest,
  buildPdfInspectRequest,
  buildPdfRenderRequest,
  bytesToBase64,
  createPdfTemplateResolver,
  pdfFillFontNeed,
  pdfFontNeed,
  pdfKernelEnv
} from "../form-engine/render/pdf/pdf-provider.js";
import { DEFAULT_PDF_AREA_DRAW, DEFAULT_PDF_PAGE_SETUP } from "../form-engine/core/schema/pdf-layout.js";

function document(overrides: Partial<PdfDocument> = {}): PdfDocument {
  return {
    version: "1",
    page: DEFAULT_PDF_PAGE_SETUP,
    metadata: { title: "T", lang: "en", textDirection: "ltr" },
    accessibility: { tagged: true, displayDocTitle: true },
    typography: DEFAULT_PDF_TYPOGRAPHY,
    colors: DEFAULT_PDF_COLORS,
    blocks: [],
    anchored: [],
    resources: { images: {} },
    ...overrides
  };
}

describe("base64 without btoa/atob", () => {
  it("round-trips every byte value and agrees with Node's encoder", () => {
    const bytes = new Uint8Array(300).map((_, index) => index % 256);
    for (const length of [0, 1, 2, 3, 4, 5, 299, 300]) {
      const slice = bytes.subarray(0, length);
      const encoded = bytesToBase64(slice);
      expect(encoded).toBe(Buffer.from(slice).toString("base64"));
      expect([...base64ToBytes(encoded)]).toEqual([...slice]);
    }
    expect([...base64ToBytes("AQID\nBA==")]).toEqual([1, 2, 3, 4]);
    expect([...base64ToBytes("-_8")]).toEqual([0xfb, 0xff]);
    expect(() => base64ToBytes("A*B")).toThrow(/Invalid base64/);
    // Past one output chunk, and on every remainder around the chunk edge.
    for (const length of [3071, 3072, 3073, 10_000, 100_001]) {
      const big = new Uint8Array(length).map((_, index) => (index * 7919) % 256);
      const encoded = bytesToBase64(big);
      expect(encoded).toBe(Buffer.from(big).toString("base64"));
      expect(Buffer.compare(Buffer.from(base64ToBytes(encoded)), Buffer.from(big))).toBe(0);
    }
    expect([...base64ToBytes(" AQ\r\nID ")]).toEqual([1, 2, 3]);
  });
});

describe("pdfFontNeed", () => {
  it("lists the theme's families and the scripts the text uses", () => {
    const need = pdfFontNeed(
      document({
        typography: { ...DEFAULT_PDF_TYPOGRAPHY, heading: { family: "Serif", sizes: [16] }, fallbacks: { Arab: "Noto Naskh" } },
        blocks: [
          { id: "p", kind: "paragraph", runs: [{ text: "Hello مرحبا" }] },
          { id: "lv", kind: "labelValue", label: "שלום", value: [{ text: "Привет" }], arrangement: "stacked" },
          { id: "w", kind: "widget", field: { name: "f", kind: "dropdown", options: [{ value: "a", label: "日本" }] } }
        ],
        footer: [{ id: "f", kind: "paragraph", runs: [{ text: "한국어" }] }],
        anchored: [{ id: "a", anchor: { page: "first", x: 0, y: 0, width: 1, height: 1 }, box: { id: "b", kind: "box", blocks: [{ id: "q", kind: "checkmark", label: "ελληνικά", checked: true }] } }]
      })
    );
    expect(need.families).toEqual(["sans-serif", "Serif", "monospace", "Noto Naskh"]);
    expect(need.scripts).toEqual(["Latn", "Arab", "Hebr", "Cyrl", "Hani", "Hang", "Grek"]);
  });
});

describe("requests and environment", () => {
  const env = pdfKernelEnv({ now: () => "2026-09-05T10:00:00.000Z", newDocumentId: () => "doc-1", producer: "Test" });

  it("stamps the ABI version and the host's environment on every request", () => {
    expect(env).toEqual({ createdAt: "2026-09-05T10:00:00.000Z", documentId: "doc-1", producer: "Test" });
    const render = buildPdfRenderRequest(document(), [], env, { compact: true });
    expect(render).toMatchObject({ abi: PDF_ABI_VERSION, op: "render", env, options: { compact: true } });
    const plan = {
      layoutId: "t",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 3, data: "AQID" },
      values: { A: "x" },
      areas: [],
      options: { flatten: true, readOnly: false, appearances: "viewer" as const }
    };
    const fill = buildPdfFillRequest(plan, new Uint8Array([1, 2, 3]), [], env);
    // A fields-only plan sends no `areas` key: the request carries none.
    expect(fill).toEqual({ abi: PDF_ABI_VERSION, op: "fill", template: { data: "AQID" }, values: { A: "x" }, fonts: [], env, options: { flatten: true, readOnly: false, appearances: "viewer" } });
    const area = { id: "a1", page: 1, rect: { x: 10, y: 20, width: 100, height: 14 }, value: "drawn", draw: DEFAULT_PDF_AREA_DRAW };
    expect(buildPdfFillRequest({ ...plan, areas: [area] }, new Uint8Array([1, 2, 3]), [], env).areas).toEqual([area]);
    // A claim travels only when the plan carries one.
    expect(buildPdfFillRequest({ ...plan, conformance: { pdfa: "2b" } }, new Uint8Array([1, 2, 3]), [], env).conformance).toEqual({ pdfa: "2b" });
    expect(buildPdfInspectRequest(new Uint8Array([1]))).toEqual({ abi: PDF_ABI_VERSION, op: "inspect", template: { data: "AQ==" } });
  });

  it("asks for the scripts a fill plan's values and areas use", () => {
    const plan = {
      layoutId: "t",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 3, data: "AQID" },
      values: { A: "plain", B: ["Привет"], C: true, D: null },
      areas: [{ id: "a1", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, value: "مرحبا", draw: DEFAULT_PDF_AREA_DRAW }],
      options: { flatten: false, readOnly: false, appearances: "regenerate" as const }
    };
    expect(pdfFillFontNeed(plan)).toEqual({ families: [], scripts: ["Latn", "Cyrl", "Arab"] });
    expect(pdfFillFontNeed({ ...plan, values: {}, areas: [] })).toEqual({ families: [], scripts: ["Latn"] });
  });

  it("accepts one ABI major only, refuses another or a malformed version, and unwraps failures as typed errors", () => {
    expect(pdfAbiCompatible("4.0.0", "4.4.1")).toBe(true);
    expect(pdfAbiCompatible("4.1.0", "4.0.0")).toBe(true);
    expect(pdfAbiCompatible("4.0.0", "3.18.0")).toBe(false);
    expect(pdfAbiCompatible("4.0.0", "5.0.0")).toBe(false);
    for (const malformed of ["4", "4.0", "4.0.0-rc1", " 4.0.0", "", undefined, null, 4]) {
      expect(pdfAbiCompatible("4.0.0", malformed), String(malformed)).toBe(false);
    }
    expect(unwrapPdfResponse({ ok: true, op: "layout", pages: [], warnings: [] }).op).toBe("layout");
    expect(() => unwrapPdfResponse({ ok: false, error: { code: "font", message: "no glyph" } })).toThrow(PdfKernelError);
    try {
      unwrapPdfResponse({ ok: false, error: { code: "template", message: "bad" } });
    } catch (error) {
      expect((error as PdfKernelError).code).toBe("template");
    }
  });
});

describe("template resolvers", () => {
  it("resolves inline base64 and delegates other storages to the host", async () => {
    const inline = { storage: "base64", name: "t.pdf", type: "application/pdf", size: 3, data: "AQID" };
    expect([...(await BASE64_TEMPLATE_RESOLVER.resolve(inline))]).toEqual([1, 2, 3]);
    await expect(BASE64_TEMPLATE_RESOLVER.resolve({ ...inline, storage: "s3" })).rejects.toThrow(/No resolver/);
    const resolver = createPdfTemplateResolver({ s3: async (source) => new Uint8Array([source.size]) });
    expect([...(await resolver.resolve({ ...inline, storage: "s3", size: 9 }))]).toEqual([9]);
    expect([...(await resolver.resolve(inline))]).toEqual([1, 2, 3]);
  });

  it("lists the PDF forms the host provides, fixed or looked up, and nothing when it provides none", async () => {
    const paper = { id: "paper", label: "Paper form", source: { storage: "url", name: "paper.pdf", type: "application/pdf", size: 10, ref: "/paper.pdf" } };
    expect(createPdfTemplateResolver().list).toBeUndefined();
    expect(await createPdfTemplateResolver({}, { templates: [paper] }).list?.()).toEqual([paper]);
    const lookedUp = createPdfTemplateResolver({}, { templates: async () => [paper, { ...paper, id: "paper-2" }] });
    expect((await lookedUp.list?.())?.map((option) => option.id)).toEqual(["paper", "paper-2"]);
  });
});
