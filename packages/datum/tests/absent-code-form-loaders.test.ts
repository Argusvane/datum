import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Absent-code resilience for <datum-form>'s lazy files: a PDF module, a sandbox
 * module, or the journey diagnostics chunk that is not there (deleted, blocked, a 404) rejects with a
 * ChunkLoadError whose cause is the import error, reaches the page as `datum-error` {message,
 * cause}, raises no unhandled rejection, leaves the form working, and is asked for again the
 * next time (no cached rejection, and after a failure the URL carries `?retry=n` so the
 * browser's module map, which remembers a failed import, is not asked the same question).
 * The WebAuthn and server-validator chunks have their own files (*-lazy-failure.test.ts).
 */
const chunk = vi.hoisted(() => ({ diagnosticsFailures: 0, diagnosticsImports: 0 }));
vi.mock("../src/journey-diagnostics.ts", async (importActual) => {
  chunk.diagnosticsImports += 1;
  if (chunk.diagnosticsFailures > 0) {
    chunk.diagnosticsFailures -= 1;
    throw new Error("diagnostics chunk 404");
  }
  return importActual();
});

import "../src/form.js";
import type { DatumErrorDetail, DatumFormElement } from "../src/form.js";
import { ChunkLoadError, importUrl, noteImportFailure } from "../src/chunk-load-error.js";
import { reportJourneyDiagnostics } from "../src/journey-debug.js";
import { loadPdfSupport, resolvePdfModuleUrl } from "../src/pdf-loader.js";
import { loadWasmValidationHost, resolveWasmModuleUrl } from "../src/wasm-loader.js";

import { sampleDefinition, until } from "./helpers.js";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  chunk.diagnosticsFailures = 0;
  chunk.diagnosticsImports = 0;
  process.on("unhandledRejection", onUnhandled);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

async function mount(setup: (element: DatumFormElement) => void): Promise<{ element: DatumFormElement; errors: DatumErrorDetail[] }> {
  const element = document.createElement("datum-form") as DatumFormElement;
  const errors: DatumErrorDetail[] = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<DatumErrorDetail>).detail));
  element.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
  element.definition = sampleDefinition();
  setup(element);
  document.body.append(element);
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  return { element, errors };
}

describe("the module URL after a failed import", () => {
  it("is the URL itself the first time and carries ?retry=n after n failures", () => {
    const url = "https://example.test/a/datum-x.js";
    expect(importUrl(url)).toBe(url);
    noteImportFailure(url);
    expect(importUrl(url)).toBe(`${url}?retry=1`);
    noteImportFailure(url);
    expect(importUrl(url)).toBe(`${url}?retry=2`);
    const query = "https://example.test/b/datum-y.js?v=3";
    noteImportFailure(query);
    expect(importUrl(query)).toBe(`${query}&retry=1`);
  });
});

describe("a PDF module that is not there", () => {
  it("rejects loadPdfSupport as a ChunkLoadError with the import error as cause, and asks again next time", async () => {
    const url = resolvePdfModuleUrl("https://nowhere.invalid/datum-pdf.js");
    const first = loadPdfSupport("https://nowhere.invalid/datum-pdf.js");
    const error = await first.then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect((error as ChunkLoadError).message).toContain(url);
    expect((error as ChunkLoadError).cause).toBeTruthy();
    await settle();
    // Forgotten: a new attempt is a new promise, and it imports a URL the module map has not failed on.
    const second = loadPdfSupport("https://nowhere.invalid/datum-pdf.js");
    expect(second).not.toBe(first);
    await expect(second).rejects.toBeInstanceOf(ChunkLoadError);
    expect(importUrl(url)).toContain("retry=2");
  });

  it("reaches the page as datum-error from renderPdf, rejects with the Error, and the form keeps working", async () => {
    const { element, errors } = await mount((el) => {
      // A module on another origin is taken from an attribute only when allow-origins lists it.
      el.setAttribute("allow-origins", "https://nowhere.invalid");
      el.setAttribute("pdf", "https://nowhere.invalid/datum-pdf-2.js");
    });
    await expect(element.renderPdf()).rejects.toBeInstanceOf(ChunkLoadError);
    await until(() => errors.length > 0);
    expect(errors[0]!.code).toBe("file.unavailable");
    expect(errors[0]!.message).toContain("could not be loaded");
    expect(errors[0]!.cause).toBeTruthy();
    // The next call tries again (a second report), it is not a cached rejection.
    await expect(element.renderPdf()).rejects.toBeInstanceOf(ChunkLoadError);
    await until(() => errors.length === 2);
    // The form still takes a value and submits.
    element.values = { fullName: "Ada Lovelace" };
    const outcome = await element.submit();
    expect(outcome.submission).toBeDefined();
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("a form's own PDF button leaves an inline alert for the filler (role=alert, worded by pdfUnavailable), and datum-error", async () => {
    const definition = sampleDefinition();
    definition.root.children = {
      content: [...(definition.root.children?.content ?? []), { id: "pdfButton", type: "button", configuration: { label: "Get PDF", action: "pdf" } }]
    };
    const element = document.createElement("datum-form") as DatumFormElement;
    const errors: DatumErrorDetail[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<DatumErrorDetail>).detail));
    element.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
    // The PDF button checks the answers first, so the required name is given.
    element.values = { fullName: "Ada Lovelace" };
    element.definition = definition;
    element.setAttribute("allow-origins", "https://nowhere.invalid");
    element.setAttribute("pdf", "https://nowhere.invalid/datum-pdf-4.js");
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector('[data-button-action="pdf"]'));
    element.renderer!.shadowRoot!.querySelector<HTMLElement>('[data-button-action="pdf"]')!.click();
    await until(() => element.shadowRoot!.querySelector("[data-form-error][data-pdf-error]"));
    const alert = element.shadowRoot!.querySelector("[data-form-error][data-pdf-error]")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("The PDF could not be created");
    expect(errors.some((entry) => entry.message.includes("could not be loaded"))).toBe(true);
    // Pressing again clears the old alert before it asks once more.
    element.renderer!.shadowRoot!.querySelector<HTMLElement>('[data-button-action="pdf"]')!.click();
    await until(() => errors.filter((entry) => entry.message.includes("could not be loaded")).length === 2);
    await until(() => element.shadowRoot!.querySelectorAll("[data-pdf-error]").length === 1);
    // The form text is the page's to reword.
    element.texts = { pdfUnavailable: "Pas de PDF pour l'instant." };
    element.renderer!.shadowRoot!.querySelector<HTMLElement>('[data-button-action="pdf"]')!.click();
    await until(() => element.shadowRoot!.querySelector("[data-pdf-error]")?.textContent?.includes("Pas de PDF"));
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("is never asked for when the features list leaves pdf out: renderPdf rejects, nothing is reported", async () => {
    const { element, errors } = await mount((el) => {
      el.setAttribute("features", "journeys");
      el.setAttribute("allow-origins", "https://nowhere.invalid");
      el.setAttribute("pdf", "https://nowhere.invalid/datum-pdf-3.js");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(element.renderPdf()).rejects.toThrow(/pdf/i);
    await settle();
    expect(errors).toEqual([]);
  });
});

describe("a sandbox module that is not there", () => {
  it("rejects loadWasmValidationHost as a ChunkLoadError and asks again next time", async () => {
    const spec = "https://nowhere.invalid/datum-wasm.js";
    const error = await loadWasmValidationHost(spec, []).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect((error as ChunkLoadError).message).toContain(resolveWasmModuleUrl(spec));
    expect((error as ChunkLoadError).cause).toBeTruthy();
    await settle();
    await expect(loadWasmValidationHost(spec, [])).rejects.toBeInstanceOf(ChunkLoadError);
    expect(importUrl(resolveWasmModuleUrl(spec))).toContain("retry=2");
  });

  it("reaches the page as datum-error from the element, which keeps working", async () => {
    const { element, errors } = await mount((el) => {
      el.setAttribute("allow-origins", "https://nowhere.invalid");
      el.setAttribute("wasm", "https://nowhere.invalid/datum-wasm-2.js");
    });
    await until(() => errors.length > 0);
    expect(errors[0]!.code).toBe("sandbox.unavailable");
    expect(errors[0]!.message).toContain("The validation sandbox could not be loaded");
    // The message names the file; the cause is the browser's own error, not the ChunkLoadError wrapping it, as for the PDF module.
    expect(errors[0]!.message).toContain("could not be loaded: ");
    expect(errors[0]!.cause).toBeInstanceOf(Error);
    expect((errors[0]!.cause as Error).name).not.toBe("ChunkLoadError");
    // The form is still a form: it takes a value.
    element.values = { fullName: "Ada Lovelace" };
    await until(() => [...element.renderer!.shadowRoot!.querySelectorAll("input")].some((input) => input.value === "Ada Lovelace"));
    await settle();
    expect(unhandled).toEqual([]);
  });
});

describe("a journey diagnostics chunk that is not there", () => {
  it("tells the host as datum-error, forgets the definition, and a later definition loads it", async () => {
    chunk.diagnosticsFailures = 1;
    const host = document.createElement("div");
    document.body.append(host);
    const errors: DatumErrorDetail[] = [];
    host.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<DatumErrorDetail>).detail));
    const first = sampleDefinition();
    reportJourneyDiagnostics(host, first);
    await until(() => errors.length > 0);
    expect(errors[0]!.code).toBe("file.unavailable");
    expect(errors[0]!.message).toBe("The journey diagnostics could not be loaded");
    expect(errors[0]!.cause).toBeInstanceOf(Error);
    // Not remembered: the same definition is tried again, and so is a new one.
    reportJourneyDiagnostics(host, first);
    await until(() => chunk.diagnosticsImports === 2);
    await settle();
    expect(errors).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });
});
