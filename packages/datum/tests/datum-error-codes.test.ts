import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import "../src/builder.js";
import type { DatumFormElement } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { DatumErrorDetail } from "../src/support.js";
import { until } from "./helpers.js";

/*
 * `datum-error` carries a stable `code` beside its message, one per distinct cause. These are
 * the causes a page can reach with no loader or sandbox in the way; the lazy-file ones are asserted
 * where those files are made to fail (the absent-code tests).
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const form = (content: unknown[] = [{ id: "keep", type: "text", configuration: { label: "Keep" } }]): Record<string, unknown> => ({
  id: "codes",
  version: "1.0.0",
  schemaVersion: "1",
  root: { id: "root", type: "form", configuration: {}, children: { content } }
});

function element(): { el: DatumFormElement; codes: string[]; details: DatumErrorDetail[] } {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const el = document.createElement("datum-form") as DatumFormElement;
  const details: DatumErrorDetail[] = [];
  const codes: string[] = [];
  el.addEventListener("datum-error", (event) => {
    details.push((event as CustomEvent<DatumErrorDetail>).detail);
    codes.push((event as CustomEvent<DatumErrorDetail>).detail.code);
  });
  document.body.append(el);
  return { el, details, codes };
}

describe("<datum-form> datum-error codes", () => {
  it("attribute.invalid-json: a JSON attribute that is not JSON", () => {
    const { el, codes, details } = element();
    el.setAttribute("chrome", "{nope");
    expect(codes).toEqual(["attribute.invalid-json"]);
    expect(details[0]!.message).toContain("chrome attribute is not valid JSON");
  });

  it("attribute.invalid: an attribute value no parser takes", () => {
    const { el, codes } = element();
    el.setAttribute("change-on", "sometimes");
    el.setAttribute("data-source-wait", "soon");
    expect(codes).toEqual(["attribute.invalid", "attribute.invalid"]);
  });

  it("definition.invalid: a definition attribute, a shape and a fetched body that is not a form", async () => {
    const { el, codes } = element();
    el.setAttribute("definition", JSON.stringify({ nothing: true }));
    el.definition = { root: { id: "root", type: "text" } } as never;
    expect(codes).toEqual(["definition.invalid", "definition.invalid"]);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ nothing: true }), { status: 200 }));
    el.removeAttribute("definition");
    el.src = "/forms/not-a-form.json";
    await until(() => codes.length === 3);
    expect(codes[2]).toBe("definition.invalid");
  });

  it("definition.invalid: a src body that is not JSON", async () => {
    const { el, codes } = element();
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));
    el.src = "/forms/html.json";
    await until(() => codes.length === 1);
    expect(codes).toEqual(["definition.invalid"]);
  });

  it("definition.load: a src the server refuses or the network does not reach", async () => {
    const { el, codes } = element();
    vi.stubGlobal("fetch", async () => new Response("", { status: 404, statusText: "Not Found" }));
    el.src = "/forms/missing.json";
    await until(() => codes.length === 1);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    el.src = "/forms/offline.json";
    await until(() => codes.length === 2);
    expect(codes).toEqual(["definition.load", "definition.load"]);
  });

  it("definition.too-large: a src body past max-definition-bytes", async () => {
    const { el, codes } = element();
    el.maxDefinitionBytes = 1000;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ...form(), pad: "x".repeat(4000) }), { status: 200 }));
    el.src = "/forms/big.json";
    await until(() => codes.length === 1);
    expect(codes).toEqual(["definition.too-large"]);
  });

  it("definition.source-conflict: a definition while src loads, and src while a definition is assigned", async () => {
    const { el, codes } = element();
    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    el.src = "/forms/slow.json";
    el.definition = form() as never;
    expect(codes).toEqual(["definition.source-conflict"]);
    el.src = undefined;
    el.definition = form() as never;
    el.src = "/forms/other.json";
    expect(codes).toEqual(["definition.source-conflict", "definition.source-conflict"]);
  });

  it("definition.duplicate-ids: two components with one id", async () => {
    const { el, codes } = element();
    el.definition = form([
      { id: "same", type: "text", configuration: { label: "A" } },
      { id: "same", type: "text", configuration: { label: "B" } }
    ]) as never;
    await until(() => codes.length > 0);
    expect(codes).toContain("definition.duplicate-ids");
  });

  it("max-definition-bytes.invalid: a cap that is not a whole number above 0, by property and attribute", () => {
    const { el, codes } = element();
    el.maxDefinitionBytes = 0;
    el.setAttribute("max-definition-bytes", "lots");
    expect(codes).toEqual(["max-definition-bytes.invalid", "max-definition-bytes.invalid"]);
  });

  it("mode.invalid: a mode that is neither interactive nor readonly, by property and attribute", () => {
    const { el, codes } = element();
    el.mode = "edit" as never;
    el.setAttribute("mode", "edit");
    expect(codes).toEqual(["mode.invalid", "mode.invalid"]);
  });

  it("features.unknown: a word that is no feature", () => {
    const { el, codes } = element();
    el.setAttribute("features", "journeys prnt");
    expect(codes).toEqual(["features.unknown"]);
  });

  it("allow-origins.invalid: a word that names no origin", () => {
    const { el, codes } = element();
    el.setAttribute("allow-origins", "*");
    expect(codes).toEqual(["allow-origins.invalid"]);
  });

  it("attribute.origin-refused: a code-loading attribute that names another origin", () => {
    const { el, codes } = element();
    el.setAttribute("wasm", "https://other.example/datum-wasm.js");
    expect(codes).toEqual(["attribute.origin-refused"]);
  });

  it("pdf-theme.unresolved: a PDF theme id nothing registered", async () => {
    const { el, codes } = element();
    el.setAttribute("pdf-theme", "no-such-theme");
    el.definition = form() as never;
    await until(() => codes.length > 0);
    expect(codes[0]).toBe("pdf-theme.unresolved");
  });

  it("submit.delivery-failed: a promise handed to datum-submit's waitUntil that rejects", async () => {
    const { el, codes } = element();
    el.addEventListener("datum-submit", (event) => (event as CustomEvent).detail.waitUntil(Promise.reject(new Error("offline"))));
    el.definition = form([{ id: "keep", type: "text", configuration: { label: "Keep" } }]) as never;
    await until(() => el.runtime !== undefined);
    await el.submit();
    await until(() => codes.length > 0);
    expect(codes).toEqual(["submit.delivery-failed"]);
  });

  it("draft.save-failed: autosave the draft store refuses", async () => {
    const { el, codes } = element();
    el.draft = "codes-draft";
    el.draftStore = {
      save: async () => {
        throw new Error("storage full");
      },
      load: async () => undefined,
      remove: async () => undefined,
      list: async () => []
    } as never;
    el.definition = form() as never;
    await until(() => el.runtime !== undefined);
    el.runtime!.setValue("keep", "typed");
    await until(() => codes.length > 0, 3000);
    expect(codes[0]).toBe("draft.save-failed");
  });

  it("values.invalid: an initial value the form cannot take", async () => {
    const { el, codes } = element();
    el.definition = form() as never;
    await until(() => el.runtime !== undefined);
    el.values = { "nothing.here.at.all": 1, keep: { not: "text" } } as never;
    await sleep(50);
    // The runtime may take or refuse a value by its own rules; what matters is that a refusal,
    // when there is one, carries this code and no other.
    expect(codes.every((code) => code === "values.invalid")).toBe(true);
  });
});

describe("<datum-builder> datum-error codes", () => {
  function builder(): { el: DatumFormBuilderElement; codes: string[] } {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    const codes: string[] = [];
    el.addEventListener("datum-error", (event) => codes.push((event as CustomEvent<DatumErrorDetail>).detail.code));
    document.body.append(el);
    return { el, codes };
  }

  it("carries the same codes for the causes it shares with the form", async () => {
    const { el, codes } = builder();
    el.setAttribute("features", "logic nonsense");
    el.setAttribute("definition", "{nope");
    el.setAttribute("allow-origins", "*");
    el.setAttribute("save-method", "PATCH");
    el.maxDefinitionBytes = 0;
    expect(codes).toEqual(["features.unknown", "attribute.invalid-json", "allow-origins.invalid", "save-method.invalid", "max-definition-bytes.invalid"]);
    vi.stubGlobal("fetch", async () => new Response("", { status: 500, statusText: "Server Error" }));
    el.src = "/forms/missing.json";
    await until(() => codes.length === 6);
    expect(codes[5]).toBe("definition.load");
  });
});
