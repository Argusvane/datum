import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * A `wasm`, `pdf` or `validate-url` attribute names a URL that is resolved against the page's base
 * once, as the attribute is set: its origin is checked on that absolute URL, and the element keeps
 * and later loads (or posts to) the same URL. A `<base>` added to the page afterwards does not move
 * it. A module spec that came from the attribute has its origin checked again as the module is
 * about to be imported.
 */
const loads = vi.hoisted(() => ({ wasm: [] as string[], pdf: [] as string[], integrity: [] as (string | undefined)[] }));
vi.mock("../src/wasm-loader.ts", async (importActual) => {
  const actual = await importActual<typeof import("../src/wasm-loader.js")>();
  return {
    ...actual,
    loadWasmValidationHost: (spec: string, _plugins: unknown, options: { integrity?: string } = {}) => {
      loads.wasm.push(actual.resolveWasmModuleUrl(spec));
      loads.integrity.push(options.integrity);
      return new Promise(() => undefined);
    }
  };
});
vi.mock("../src/pdf-loader.ts", async (importActual) => {
  const actual = await importActual<typeof import("../src/pdf-loader.js")>();
  return {
    ...actual,
    loadPdfSupport: (spec: string) => {
      loads.pdf.push(actual.resolvePdfModuleUrl(spec));
      return Promise.reject(new Error("no PDF module in this test"));
    }
  };
});

import "../src/form.js";
import "../src/builder.js";
import type { DatumErrorDetail, DatumFormElement } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { sampleDefinition, until } from "./helpers.js";

const OTHER = "https://other.example";

beforeEach(() => {
  loads.wasm.length = 0;
  loads.pdf.length = 0;
  loads.integrity.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  document.head.querySelectorAll("base").forEach((base) => base.remove());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function addBase(href: string): void {
  const base = document.createElement("base");
  base.href = href;
  document.head.append(base);
}

function element(attributes: Record<string, string>): { el: DatumFormElement; errors: DatumErrorDetail[] } {
  const el = document.createElement("datum-form") as DatumFormElement;
  const errors: DatumErrorDetail[] = [];
  el.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<DatumErrorDetail>).detail));
  for (const [name, value] of Object.entries(attributes)) {
    el.setAttribute(name, value);
  }
  return { el, errors };
}

describe("an origin-bound attribute's URL is resolved once", () => {
  it("keeps the absolute URL it checked, so a <base> added later does not move the sandbox or the PDF module", async () => {
    const { el, errors } = element({ wasm: "./modules/datum-wasm.js", pdf: "modules/datum-pdf.js", "validate-url": "./api/check" });
    expect(errors).toEqual([]);
    const own = new URL("./modules/datum-wasm.js", document.baseURI).href;
    expect(new URL(own).origin).toBe(location.origin);
    expect(el.wasm).toBe(own);
    expect(el.pdf).toBe(new URL("modules/datum-pdf.js", document.baseURI).href);
    expect(el.validateUrl).toBe(new URL("./api/check", document.baseURI).href);

    addBase(`${OTHER}/`);
    el.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
    el.definition = sampleDefinition();
    document.body.append(el);
    await until(() => loads.wasm.length > 0);
    expect(loads.wasm).toEqual([own]);
    await el.renderPdf().catch(() => undefined);
    expect(loads.pdf).toEqual([new URL(el.pdf!).href]);
    expect(loads.pdf[0]!.startsWith(location.origin)).toBe(true);
    expect(errors.map((error) => error.code)).not.toContain("attribute.origin-refused");
  });

  it("checks an attribute's module origin again right before importing it", async () => {
    const { el, errors } = element({ "allow-origins": OTHER, wasm: `${OTHER}/datum-wasm.js`, pdf: `${OTHER}/datum-pdf.js` });
    expect(errors).toEqual([]);
    // allow-origins is gone without the attribute being judged again (as it would be): the load itself refuses.
    vi.spyOn(el as unknown as { allowOriginsChanged(value: string | null): void }, "allowOriginsChanged").mockImplementation(() => undefined);
    el.removeAttribute("allow-origins");
    expect(el.wasm).toBe(`${OTHER}/datum-wasm.js`);
    el.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
    el.definition = sampleDefinition();
    document.body.append(el);
    await until(() => errors.some((error) => error.code === "attribute.origin-refused"));
    await expect(el.renderPdf()).rejects.toThrow(/pdf attribute was not used/);
    expect(loads.wasm).toEqual([]);
    expect(loads.pdf).toEqual([]);
  });

  it("leaves a module a script assigns to the property alone: the property may name any origin", async () => {
    const { el, errors } = element({});
    el.wasm = `${OTHER}/datum-wasm.js`;
    el.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
    el.definition = sampleDefinition();
    document.body.append(el);
    await until(() => loads.wasm.length > 0);
    expect(loads.wasm).toEqual([`${OTHER}/datum-wasm.js`]);
    expect(errors.map((error) => error.code)).not.toContain("attribute.origin-refused");
  });

  it("hands the sandbox loader the wasm-integrity the module is held to", async () => {
    const { el } = element({ wasm: "auto", "wasm-integrity": "  sha384-AAAA  " });
    expect(el.wasmIntegrity).toBe("sha384-AAAA");
    el.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
    el.definition = sampleDefinition();
    document.body.append(el);
    await until(() => loads.wasm.length > 0);
    expect(loads.integrity).toEqual(["sha384-AAAA"]);
    el.removeAttribute("wasm-integrity");
    expect(el.wasmIntegrity).toBeUndefined();
  });

  it("resolves the builder's module attributes once too", () => {
    const builder = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    const own = new URL("./modules/datum-wasm.js", document.baseURI).href;
    builder.setAttribute("wasm", "./modules/datum-wasm.js");
    builder.setAttribute("pdf", "./modules/datum-pdf.js");
    builder.setAttribute("pdf-pages", "./modules/datum-pdf-pages.js");
    addBase(`${OTHER}/`);
    expect(builder.wasm).toBe(own);
    for (const value of [builder.wasm, builder.pdf, builder.pdfPages]) {
      expect(new URL(value!).origin).toBe(location.origin);
    }
  });
});
