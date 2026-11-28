import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import "../src/builder.js";
import type { DatumFormElement } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import { elementAgentHost } from "../src/agent-host.js";
import { sampleDefinition, until } from "./helpers.js";
import { control, type } from "./live-dom.js";

/*
 * An attribute that names code to import or an endpoint to send answers to (`wasm`, `pdf`,
 * `draft-store`, `validate-url`, and the builder's `wasm`, `pdf`, `pdf-pages`) is taken only when
 * the URL is on the page's own origin or on one `allow-origins` lists. A refused attribute is a
 * datum-error and loads nothing: the element acts as if it were absent. The properties are not
 * held to this: a script that assigns one may name any origin.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const OTHER = "https://other.example";

function plainDefinition(): FormDefinition {
  const sample = sampleDefinition();
  const content = (sample.root.children?.content ?? []).filter((node) => node.id !== "country");
  return { ...sample, root: { ...sample.root, children: { content } } };
}

function formWith(attributes: Record<string, string>, setup?: (el: DatumFormElement) => void): { el: DatumFormElement; errors: string[] } {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const el = document.createElement("datum-form") as DatumFormElement;
  const errors: string[] = [];
  el.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
  for (const [name, value] of Object.entries(attributes)) {
    el.setAttribute(name, value);
  }
  setup?.(el);
  return { el, errors };
}

describe("<datum-form> URL attributes and allow-origins", () => {
  it("takes same-origin and relative URLs, and the bundle's own auto", () => {
    const { el, errors } = formWith({ wasm: "/static/datum-wasm.js", pdf: "auto", "validate-url": "/api/check", "draft-store": "server:/api/drafts" });
    expect(errors).toEqual([]);
    // A relative URL is kept as the absolute URL it was checked as.
    expect(el.wasm).toBe(new URL("/static/datum-wasm.js", document.baseURI).href);
    expect(el.pdf).toBe("auto");
    expect(el.validateUrl).toBe(new URL("/api/check", document.baseURI).href);
    el.setAttribute("wasm", `${location.origin}/x/datum-wasm.js`);
    expect(errors).toEqual([]);
    expect(el.wasm).toBe(`${location.origin}/x/datum-wasm.js`);
  });

  it("refuses each attribute on another origin with a datum-error and loads nothing", () => {
    const { el, errors } = formWith({
      wasm: `${OTHER}/datum-wasm.js`,
      pdf: `//other.example/datum-pdf.js`,
      "validate-url": `${OTHER}/check`
    });
    expect(errors).toHaveLength(3);
    for (const [index, name] of ["wasm", "pdf", "validate-url"].entries()) {
      expect(errors[index]).toContain(`The ${name} attribute was not used`);
      // `//other.example` takes the page's scheme.
      expect(errors[index]).toContain("://other.example");
      expect(errors[index]).toContain("allow-origins");
    }
    expect(el.wasm).toBeUndefined();
    expect(el.pdf).toBeUndefined();
    expect(el.validateUrl).toBeUndefined();
  });

  it("refuses data:, blob: of another origin and javascript: module URLs", () => {
    for (const value of ["data:text/javascript,export%20const%20x=1", "javascript:alert(1)", "blob:https://other.example/0f0f"]) {
      const { el, errors } = formWith({ wasm: value });
      expect(errors, value).toHaveLength(1);
      expect(el.wasm, value).toBeUndefined();
    }
  });

  it("a refused value replaces an accepted one: the earlier module is not kept", () => {
    const { el, errors } = formWith({ pdf: "/static/datum-pdf.js" });
    el.setAttribute("pdf", `${OTHER}/datum-pdf.js`);
    expect(errors).toHaveLength(1);
    expect(el.pdf).toBeUndefined();
  });

  it("takes an origin allow-origins lists, whichever attribute comes first, and drops it again when the list does", () => {
    const { el, errors } = formWith({ wasm: `${OTHER}/datum-wasm.js` });
    expect(errors).toHaveLength(1);
    expect(el.wasm).toBeUndefined();
    el.setAttribute("allow-origins", `https://cdn.example ${OTHER}/any/path`);
    expect(el.wasm).toBe(`${OTHER}/datum-wasm.js`);
    expect(errors).toHaveLength(1);
    el.setAttribute("validate-url", `${OTHER}/check`);
    expect(el.validateUrl).toBe(`${OTHER}/check`);
    el.setAttribute("allow-origins", "https://cdn.example");
    expect(el.wasm).toBeUndefined();
    expect(el.validateUrl).toBeUndefined();
    expect(errors).toHaveLength(3);
    el.removeAttribute("allow-origins");
    expect(errors).toHaveLength(3);
  });

  it("reports an allow-origins word that names no origin and keeps the others", () => {
    const { el, errors } = formWith({ "allow-origins": `not-a-url * ${OTHER}`, wasm: `${OTHER}/datum-wasm.js` });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/allow-origins/);
    expect(errors[0]).toContain('"not-a-url"');
    expect(errors[0]).toContain('"*"');
    expect(el.wasm).toBe(`${OTHER}/datum-wasm.js`);
  });

  it("keeps the properties free to name any origin", () => {
    const { el, errors } = formWith({});
    el.wasm = `${OTHER}/datum-wasm.js`;
    el.pdf = `${OTHER}/datum-pdf.js`;
    el.validateUrl = `${OTHER}/check`;
    expect(errors).toEqual([]);
    expect(el.wasm).toBe(`${OTHER}/datum-wasm.js`);
    expect(el.pdf).toBe(`${OTHER}/datum-pdf.js`);
    expect(el.validateUrl).toBe(`${OTHER}/check`);
  });

  it("sends no draft to a draft-store server on another origin; drafts stay in the browser", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      calls.push(String(input));
      return new Response("[]", { status: 200 });
    }));
    const { el, errors } = formWith({ draft: "k1", "draft-store": `server:${OTHER}/api/drafts` });
    el.definition = plainDefinition();
    document.body.append(el);
    await until(() => el.renderer?.shadowRoot?.querySelector("form"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("The draft-store attribute was not used");
    type(control(el.renderer!.shadowRoot!, "fullName"), "Grace");
    await el.saveDraft();
    expect(calls.filter((url) => url.startsWith(OTHER))).toEqual([]);
    expect(await el.hasDraft()).toBe(true);
  });

  it("tells the agent tools the drafts stay in the browser while draft-store is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    const { el, errors } = formWith({ draft: "k1", "draft-store": `server:${OTHER}/api/drafts` });
    el.definition = plainDefinition();
    document.body.append(el);
    await until(() => el.renderer?.shadowRoot?.querySelector("form"));
    expect(errors).toHaveLength(1);
    expect(elementAgentHost(el).drafts!()?.store).toBe("browser");
    el.setAttribute("allow-origins", OTHER);
    expect(elementAgentHost(el).drafts!()?.store).toBe("server");
    el.removeAttribute("allow-origins");
    expect(elementAgentHost(el).drafts!()?.store).toBe("browser");
  });

  it("reports a refused attribute once when the element upgrades with allow-origins written before it", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Parsed into a template, the elements upgrade only when they join the page, every attribute already there.
    const template = document.createElement("template");
    template.innerHTML = `<div><datum-form allow-origins="https://cdn.example" wasm="${OTHER}/datum-wasm.js" validate-url="${OTHER}/check"></datum-form><datum-form-builder allow-origins="https://cdn.example" pdf="${OTHER}/datum-pdf.js"></datum-form-builder></div>`;
    const host = template.content.firstElementChild!;
    const errors: string[] = [];
    for (const el of host.children) {
      el.addEventListener("datum-error", (event) => errors.push(`${el.localName}: ${(event as CustomEvent<{ message: string }>).detail.message}`));
    }
    document.body.append(host);
    expect(errors).toHaveLength(3);
    expect(errors.filter((text) => text.startsWith("datum-form: The wasm attribute"))).toHaveLength(1);
    expect(errors.filter((text) => text.startsWith("datum-form: The validate-url attribute"))).toHaveLength(1);
    expect(errors.filter((text) => text.startsWith("datum-form-builder: The pdf attribute"))).toHaveLength(1);
    const form = host.querySelector("datum-form") as DatumFormElement;
    expect(form.wasm).toBeUndefined();
    // A list that names the origin later still takes them, and says nothing more.
    form.setAttribute("allow-origins", OTHER);
    expect(form.wasm).toBe(`${OTHER}/datum-wasm.js`);
    expect(errors).toHaveLength(3);
  });

  it("lists allow-origins among its attributes", () => {
    expect((customElements.get("datum-form") as unknown as { observedAttributes: string[] }).observedAttributes).toContain("allow-origins");
    expect((customElements.get("datum-form-builder") as unknown as { observedAttributes: string[] }).observedAttributes).toContain("allow-origins");
  });
});

describe("<datum-form-builder> URL attributes and allow-origins", () => {
  it("refuses wasm, pdf and pdf-pages on another origin and keeps off, auto and the page's own", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    const errors: string[] = [];
    el.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    el.setAttribute("wasm", "off");
    el.setAttribute("pdf", "auto");
    el.setAttribute("pdf-pages", "/static/datum-pdf-pages.js");
    expect(errors).toEqual([]);
    expect(el.wasm).toBe("off");
    expect(el.pdfPages).toBe(new URL("/static/datum-pdf-pages.js", document.baseURI).href);
    el.setAttribute("wasm", `${OTHER}/datum-wasm.js`);
    el.setAttribute("pdf", `${OTHER}/datum-pdf.js`);
    el.setAttribute("pdf-pages", `${OTHER}/datum-pdf-pages.js`);
    expect(errors).toHaveLength(3);
    expect(el.wasm).toBeUndefined();
    expect(el.pdf).toBeUndefined();
    expect(el.pdfPages).toBeUndefined();
    el.setAttribute("allow-origins", OTHER);
    expect(el.wasm).toBe(`${OTHER}/datum-wasm.js`);
    expect(el.pdf).toBe(`${OTHER}/datum-pdf.js`);
    expect(el.pdfPages).toBe(`${OTHER}/datum-pdf-pages.js`);
    el.pdf = "https://third.example/datum-pdf.js";
    expect(el.pdf).toBe("https://third.example/datum-pdf.js");
    expect(errors).toHaveLength(3);
  });
});
