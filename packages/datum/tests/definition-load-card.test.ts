import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import type { DatumErrorDetail } from "../src/support.js";
import { until } from "./helpers.js";

/*
 * A definition that cannot be had from `src` leaves the element's error card, worded by the
 * form's `definitionUnavailable` text, instead of "Loading form…" for ever. The reason (address,
 * status) stays in `datum-error` and the console, never on the card.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const form = (): Record<string, unknown> => ({
  id: "card",
  version: "1.0.0",
  schemaVersion: "1",
  root: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "keep", type: "text", configuration: { label: "Keep" } }] } }
});

function element(): { el: DatumFormElement; details: DatumErrorDetail[] } {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const el = document.createElement("datum-form") as DatumFormElement;
  const details: DatumErrorDetail[] = [];
  el.addEventListener("datum-error", (event) => details.push((event as CustomEvent<DatumErrorDetail>).detail));
  document.body.append(el);
  return { el, details };
}

const card = (el: DatumFormElement): HTMLElement | null => el.shadowRoot!.querySelector<HTMLElement>("[data-form-error]");
const renderer = (el: DatumFormElement): HTMLElement => el.shadowRoot!.querySelector<HTMLElement>("datum-form-renderer")!;
const loadingLine = (el: DatumFormElement): boolean => renderer(el).shadowRoot?.querySelector("[data-datum-loading]") != null;

const DEFAULT_WORDS = "This form could not be loaded.";

describe("<datum-form> failed definition loads show the error card", () => {
  it("a 404: the card replaces the placeholder, and the reason stays in datum-error", async () => {
    const { el, details } = element();
    vi.stubGlobal("fetch", async () => new Response("", { status: 404, statusText: "Not Found" }));
    el.src = "/forms/missing.json";
    await until(() => card(el));
    const shown = card(el)!;
    expect(shown.getAttribute("role")).toBe("alert");
    expect(shown.hasAttribute("data-definition-error")).toBe(true);
    expect(shown.textContent).toBe(DEFAULT_WORDS);
    expect(shown.textContent).not.toContain("404");
    expect(shown.textContent).not.toContain("missing.json");
    // The placeholder is out of sight: the renderer holding it is hidden.
    expect(renderer(el).hidden).toBe(true);
    expect(details.map((detail) => detail.code)).toEqual(["definition.load"]);
    expect(details[0]!.message).toContain("404");
  });

  it("a response that is not JSON: the card, with definition.invalid raised as before", async () => {
    const { el, details } = element();
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));
    el.src = "/forms/html.json";
    await until(() => card(el));
    expect(card(el)!.textContent).toBe(DEFAULT_WORDS);
    expect(details.map((detail) => detail.code)).toEqual(["definition.invalid"]);
  });

  it("a body over max-definition-bytes: the card, with definition.too-large", async () => {
    const { el, details } = element();
    el.maxDefinitionBytes = 1000;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ...form(), pad: "x".repeat(4000) }), { status: 200 }));
    el.src = "/forms/big.json";
    await until(() => card(el));
    expect(details.map((detail) => detail.code)).toEqual(["definition.too-large"]);
  });

  it("a fetched definition the element refuses: the card, with definition.invalid", async () => {
    const { el, details } = element();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ nothing: true }), { status: 200 }));
    el.src = "/forms/not-a-form.json";
    await until(() => card(el));
    expect(card(el)!.textContent).toBe(DEFAULT_WORDS);
    expect(details.map((detail) => detail.code)).toEqual(["definition.invalid"]);
  });

  it("a definition of a shape no walk can read: the card too, from src", async () => {
    const { el, details } = element();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ...form(), root: { id: "root", type: "text" } }), { status: 200 }));
    el.src = "/forms/odd-root.json";
    await until(() => card(el));
    expect(details.map((detail) => detail.code)).toEqual(["definition.invalid"]);
  });

  it("an element given src before it is connected shows the card once it is", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => new Response("", { status: 500, statusText: "Server Error" }));
    const el = document.createElement("datum-form") as DatumFormElement;
    el.src = "/forms/early.json";
    await new Promise((resolve) => setTimeout(resolve, 20));
    document.body.append(el);
    await until(() => card(el));
    expect(card(el)!.textContent).toBe(DEFAULT_WORDS);
    expect(renderer(el).hidden).toBe(true);
  });

  it("words the card from the page's texts and the element's locale", async () => {
    const { el } = element();
    el.texts = { definitionUnavailable: { default: "Sorry, no form today.", locales: { fr: "Désolé, pas de formulaire." } } };
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    el.src = "/forms/missing.json";
    await until(() => card(el));
    expect(card(el)!.textContent).toBe("Sorry, no form today.");
    el.setAttribute("locale", "fr");
    el.src = "/forms/missing-again.json";
    await until(() => card(el)?.textContent === "Désolé, pas de formulaire.");
  });

  it("goes when a later src loads, and the placeholder returns while that one is on its way", async () => {
    const { el } = element();
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    el.src = "/forms/missing.json";
    await until(() => card(el));
    let release: (response: Response) => void = () => undefined;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => (release = resolve)));
    el.src = "/forms/good.json";
    expect(card(el)).toBeNull();
    expect(renderer(el).hidden).toBe(false);
    await until(() => loadingLine(el));
    release(new Response(JSON.stringify(form()), { status: 200 }));
    await until(() => el.runtime);
    expect(card(el)).toBeNull();
    expect(renderer(el).hidden).toBe(false);
  });

  it("goes when a definition is assigned, and when src is removed", async () => {
    const { el } = element();
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    el.src = "/forms/missing.json";
    await until(() => card(el));
    el.src = undefined;
    expect(card(el)).toBeNull();
    expect(renderer(el).hidden).toBe(false);
    el.src = "/forms/missing.json";
    await until(() => card(el));
    el.src = undefined;
    el.definition = form() as never;
    await until(() => el.runtime);
    expect(card(el)).toBeNull();
    expect(renderer(el).hidden).toBe(false);
  });

  it("stays through a rebuild the page asks for while there is still no definition", async () => {
    const { el } = element();
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    el.src = "/forms/missing.json";
    await until(() => card(el));
    el.setAttribute("locale", "fr");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(card(el)).not.toBeNull();
    expect(renderer(el).hidden).toBe(true);
  });

  it("never draws a card for an address the element has moved on from", async () => {
    const { el, details } = element();
    let failFirst: (reason: unknown) => void = () => undefined;
    vi.stubGlobal("fetch", (url: string) =>
      url.endsWith("first.json")
        ? new Promise<Response>((_resolve, reject) => (failFirst = reject))
        : Promise.resolve(new Response(JSON.stringify(form()), { status: 200 }))
    );
    el.src = "/forms/first.json";
    el.src = "/forms/second.json";
    await until(() => el.runtime);
    failFirst(new TypeError("Failed to fetch"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(card(el)).toBeNull();
    expect(renderer(el).hidden).toBe(false);
    expect(details).toEqual([]);
  });

  it("never draws a card for a failure that lands after src was removed", async () => {
    const { el } = element();
    let failFirst: (reason: unknown) => void = () => undefined;
    vi.stubGlobal("fetch", () => new Promise<Response>((_resolve, reject) => (failFirst = reject)));
    el.src = "/forms/first.json";
    el.src = undefined;
    failFirst(new TypeError("Failed to fetch"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(card(el)).toBeNull();
  });

  it("a definition attribute that is not usable shows the card too, and a good one takes it down", () => {
    const { el, details } = element();
    el.setAttribute("definition", "{nope");
    expect(card(el)!.textContent).toBe(DEFAULT_WORDS);
    expect(renderer(el).hidden).toBe(true);
    expect(details.length).toBe(1);
    el.setAttribute("definition", JSON.stringify(form()));
    expect(card(el)).toBeNull();
    expect(renderer(el).hidden).toBe(false);
  });

  it("a refused definition property shows the card with nothing drawn, and says nothing over a form already drawn", async () => {
    const { el, details } = element();
    el.definition = { root: { id: "root", type: "text" } } as never;
    expect(card(el)!.textContent).toBe(DEFAULT_WORDS);
    expect(renderer(el).hidden).toBe(true);
    expect(details.map((detail) => detail.code)).toEqual(["definition.invalid"]);
    el.definition = form() as never;
    await until(() => el.runtime);
    expect(card(el)).toBeNull();
    // The form on screen is loaded and working: the refusal is reported, and no card claims otherwise.
    el.definition = { root: { id: "root", type: "text" } } as never;
    expect(card(el)).toBeNull();
    expect(renderer(el).hidden).toBe(false);
    expect(el.runtime).toBeDefined();
    expect(details.map((detail) => detail.code)).toEqual(["definition.invalid", "definition.invalid"]);
  });

  it("a definition refused while a good one is still being built leaves that form to be drawn", async () => {
    const { el, details } = element();
    el.definition = form() as never;
    el.definition = { root: { id: "root", type: "text" } } as never;
    expect(card(el)).toBeNull();
    expect(renderer(el).hidden).toBe(false);
    await until(() => el.runtime);
    expect(card(el)).toBeNull();
    expect(renderer(el).hidden).toBe(false);
    expect(details.map((detail) => detail.code)).toEqual(["definition.invalid"]);
  });

  it("the same before the element is connected: connecting draws the good form, not the card", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const el = document.createElement("datum-form") as DatumFormElement;
    el.definition = form() as never;
    el.definition = { root: { id: "root", type: "text" } } as never;
    document.body.append(el);
    await until(() => el.runtime);
    expect(card(el)).toBeNull();
    expect(renderer(el).hidden).toBe(false);
  });

  it("a src that fails while a form is on screen keeps the form and draws no card", async () => {
    const { el, details } = element();
    el.definition = form() as never;
    await until(() => el.runtime);
    vi.stubGlobal("fetch", async () => new Response("", { status: 404, statusText: "Not Found" }));
    el.src = "/forms/missing.json";
    await until(() => details.length > 0);
    expect(card(el)).toBeNull();
    expect(renderer(el).hidden).toBe(false);
    expect(el.runtime).toBeDefined();
  });
});
