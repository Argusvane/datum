import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createFormRuntime, renderPdf as renderPdfLoaded, type DatumFormElement } from "../src/form.js";
import { createPdfSupport, renderPdf, type DatumPdfSupport } from "../src/pdf.js";
import { ACME_PDF_THEME } from "./fixtures/acme-theme.js";
import "./fixtures/acme-theme-bundle.js";
import { mount, paintedForm, sampleDefinition, until } from "./helpers.js";

/**
 * `renderPdf(runtime, options)` (datum-pdf.js, and its loader in datum-form.js) draws what
 * `<datum-form>`'s `renderPdf()` draws for the same runtime: the same bytes from the real kernel
 * and fonts. A PDF carries its creation instant and a document id, so both are fixed for the
 * calls compared (the clock and `crypto.randomUUID`); everything else is the form's.
 */

const require = createRequire(import.meta.url);
const FONTS = join(dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
const PDF_MODULE = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../src/pdf.ts")).href;

let support: DatumPdfSupport;

beforeAll(async () => {
  support = await createPdfSupport({ fontsUrl: FONTS });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Runs `render` with the clock and the document id held still, so two renderings can be compared byte for byte. */
async function still<T>(render: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-04T05:06:07.000Z") });
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
  try {
    return await render();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
}

async function paintedWithSupport(setup?: (element: DatumFormElement) => void): Promise<DatumFormElement> {
  const element = mount((el) => {
    el.definition = sampleDefinition();
    el.values = { fullName: "Ada Lovelace", subscribe: true, email: "ada@example.org" };
    el.pdfSupport = support;
    setup?.(el);
  });
  await paintedForm(element);
  return element;
}

describe("renderPdf(runtime)", () => {
  it("draws the bytes the element draws for the same runtime", async () => {
    const element = await paintedWithSupport();
    const [fromElement, fromRuntime] = await still(async () => [await element.renderPdf(), await renderPdf(element.runtime!, { support })] as const);
    expect(fromElement.bytes.length).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(fromElement.bytes.slice(0, 5))).toBe("%PDF-");
    expect(Buffer.from(fromRuntime.bytes).equals(Buffer.from(fromElement.bytes))).toBe(true);
    expect({ layoutId: fromRuntime.layoutId, themeId: fromRuntime.themeId, fileName: fromRuntime.fileName, pageCount: fromRuntime.pageCount }).toEqual({
      layoutId: fromElement.layoutId,
      themeId: fromElement.themeId,
      fileName: fromElement.fileName,
      pageCount: fromElement.pageCount
    });
  });

  it("follows the element's PDF theme and the call's locale the same way", async () => {
    const element = await paintedWithSupport((el) => el.setAttribute("pdf-theme", ACME_PDF_THEME.id));
    await until(() => element.renderer!.pdfTheme === ACME_PDF_THEME);
    const [fromElement, fromRuntime, unthemed] = await still(async () => [
      await element.renderPdf({ locale: "fr-CA" }),
      await renderPdf(element.runtime!, { support, theme: ACME_PDF_THEME.id, locale: "fr-CA" }),
      await renderPdf(element.runtime!, { support, locale: "fr-CA" })
    ] as const);
    expect(fromElement.themeId).toBe(ACME_PDF_THEME.id);
    expect(Buffer.from(fromRuntime.bytes).equals(Buffer.from(fromElement.bytes))).toBe(true);
    expect(fromRuntime.fileName).toBe(fromElement.fileName);
    // Without the theme it is another document: the comparison above is not vacuous.
    expect(unthemed.themeId).not.toBe(ACME_PDF_THEME.id);
    expect(Buffer.from(unthemed.bytes).equals(Buffer.from(fromElement.bytes))).toBe(false);
  });

  it("draws the same bytes through datum-form.js's loader, and for a runtime built without an element", async () => {
    const element = await paintedWithSupport();
    const runtime = createFormRuntime(sampleDefinition());
    runtime.setValue("fullName", "Ada Lovelace");
    runtime.setValue("subscribe", true);
    runtime.setValue("email", "ada@example.org");
    const [fromElement, loaded, standalone] = await still(async () => [
      await element.renderPdf(),
      await renderPdfLoaded(element.runtime!, { pdf: PDF_MODULE, support }),
      await renderPdf(runtime, { support })
    ] as const);
    expect(Buffer.from(loaded.bytes).equals(Buffer.from(fromElement.bytes))).toBe(true);
    expect(Buffer.from(standalone.bytes).equals(Buffer.from(fromElement.bytes))).toBe(true);
  });
});
