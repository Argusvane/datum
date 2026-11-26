import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import { datumPrintTheme, type DatumFormElement, type PrintCallOptions, type PrintTheme } from "../src/form.js";
import type { FormDefinition } from "@argusvane/datum-engine";

import { until } from "./helpers.js";

/** Printing a live form and a read-only one through <datum-form>: per-component print settings, notes, a journey's path. */

afterEach(() => {
  document.body.innerHTML = "";
});

function definition(): FormDefinition {
  return {
    id: "licence",
    version: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Licence" },
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "subscribe", type: "checkbox", configuration: { label: "Subscribe" } },
          {
            id: "email",
            type: "text",
            configuration: { label: "Email", print: { show: "always", note: "Complete only if you ticked Subscribe." } },
            rules: { visibleWhen: { kind: "path", path: "subscribe" } }
          },
          {
            id: "phone",
            type: "text",
            configuration: { label: "Phone", print: { show: "always" } },
            rules: { visibleWhen: { kind: "path", path: "subscribe" } }
          },
          { id: "office", type: "text", configuration: { label: "Office use only", print: { on: "screen" } } },
          { id: "reference", type: "text", configuration: { label: "Reference", print: { show: "answered" } } }
        ]
      }
    }
  } as unknown as FormDefinition;
}

async function printed(element: DatumFormElement, options?: PrintCallOptions): Promise<string> {
  let html = "";
  const listener = (event: Event): void => {
    event.preventDefault();
    html = (event as CustomEvent<{ html: string }>).detail.html;
  };
  element.addEventListener("datum-print", listener);
  await element.print(options);
  element.removeEventListener("datum-print", listener);
  return html;
}

async function mount(mode?: "readonly"): Promise<DatumFormElement> {
  const element = document.createElement("datum-form") as DatumFormElement;
  if (mode) {
    element.setAttribute("mode", mode);
  }
  element.definition = definition();
  document.body.append(element);
  await until(() => element.renderer?.shadowRoot?.querySelector('[data-component-id="name"]'));
  return element;
}

const has = (html: string, id: string): boolean => html.includes(`data-component-id="${id}"`);

/** The note printed beside a field: the basic print theme's `.dp-note` inside the field's wrapper. */
const noteOf = (html: string, id: string): string | undefined =>
  new DOMParser().parseFromString(html, "text/html").querySelector(`.datum-print__field[data-component-id="${id}"] .dp-note`)?.textContent ?? undefined;
const notes = (html: string): number => new DOMParser().parseFromString(html, "text/html").querySelectorAll(".dp-note").length;

describe("printing a live form", () => {
  it("prints a field a rule hides when it is set to always, with its note or the form's own", async () => {
    const html = await printed(await mount());
    expect(has(html, "email")).toBe(true);
    expect(noteOf(html, "email")).toBe("Complete only if you ticked Subscribe.");
    expect(noteOf(html, "phone")).toBe("Complete only if it applies to you.");
  });

  it("leaves off a field shown on screen only, and one set to only when answered until it has an answer", async () => {
    const element = await mount();
    let html = await printed(element);
    expect(has(html, "office")).toBe(false);
    expect(has(html, "reference")).toBe(false);
    element.runtime!.setValue("reference", "A-123");
    html = await printed(element);
    expect(has(html, "reference")).toBe(true);
  });

  it("prints an always field without a note once its rule shows it", async () => {
    const element = await mount();
    element.runtime!.setValue("subscribe", true);
    const html = await printed(element);
    expect(has(html, "email")).toBe(true);
    expect(notes(html)).toBe(0);
  });
});

describe("printing a read-only form", () => {
  it("prints exactly what it shows: no field a rule hides, every visible one but a screen-only one, whatever else the print settings say", async () => {
    const html = await printed(await mount("readonly"));
    expect(has(html, "email")).toBe(false);
    expect(notes(html)).toBe(0);
    expect(has(html, "office")).toBe(false);
    expect(has(html, "reference")).toBe(true);
  });
});

describe("printing a journey", () => {
  it("prints the pages on the person's path as headed sections in order, not just the page the person is on", async () => {
    const journeyDefinition = {
      ...definition(),
      journey: {
        journeys: [
          {
            id: "apply",
            name: "Apply",
            pages: [
              { id: "first", title: "Who you are", components: ["name"] },
              { id: "second", title: "Staying in touch", components: ["subscribe", "email", "phone"] }
            ]
          }
        ]
      }
    } as unknown as FormDefinition;
    const element = document.createElement("datum-form") as DatumFormElement;
    element.definition = journeyDefinition;
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("[data-journey-heading]"));
    // On the first page, only its field is on screen.
    expect(element.renderer!.shadowRoot!.querySelector('[data-component-id="subscribe"]')).toBeNull();
    const html = await printed(element);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect([...doc.querySelectorAll(".dp-section--page > .dp-heading")].map((heading) => heading.textContent)).toEqual(["Who you are", "Staying in touch"]);
    for (const id of ["name", "subscribe", "email", "phone"]) {
      expect(has(html, id), id).toBe(true);
    }
    // A field no page lists is on no page of the path, so not on paper.
    expect(has(html, "reference")).toBe(false);
  });
});

describe("print options on <datum-form>", () => {
  it("forwards the rendition and the paper, and draws with the print theme set on the element, before or after it builds", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    // Set before the element has built its renderer: kept, and handed over when it does.
    element.printTheme = datumPrintTheme;
    element.definition = definition();
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector('[data-component-id="name"]'));
    element.runtime!.setValue("name", "Ada");
    let html = await printed(element, { rendition: "blank", page: { size: "A4", margin: "12mm" } });
    let doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.body.getAttribute("data-print-theme")).toBe("datum");
    expect(doc.querySelector(".datum-print--blank")).not.toBeNull();
    expect(html).toContain("size: A4; margin: 12mm;");
    expect(html).not.toContain("Ada");

    // A theme of the page's own, drawing through the tag its drawers are handed.
    const own: PrintTheme = { id: "own", label: "Own", css: "", draw: { title: (title, { html: tag }) => tag`<h1 class="own-title">${title}</h1>` } };
    element.printTheme = own;
    expect(element.printTheme).toBe(own);
    html = await printed(element);
    doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.body.getAttribute("data-print-theme")).toBe("own");
    expect(doc.querySelector("h1.own-title")?.textContent).toBe("Licence");
    expect(doc.querySelector('.datum-print__field[data-component-id="name"] .dp-answer')?.textContent).toBe("Ada");
  });
});

describe("the receipt's data on paper", () => {
  function receiptForm(): FormDefinition {
    return {
      id: "licence",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: { title: "Licence", print: { header: { end: "Ref {{receipt.reference}}" }, footer: { start: "Received {{receipt.receivedAt}}" } } },
        children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] }
      }
    } as unknown as FormDefinition;
  }

  async function mountWith(setup: (element: DatumFormElement) => void): Promise<DatumFormElement> {
    const element = document.createElement("datum-form") as DatumFormElement;
    setup(element);
    element.definition = receiptForm();
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector('[data-component-id="name"]'));
    return element;
  }

  /** The content of a margin box of the print document, as the renderer's sheet writes it. */
  const marginBox = (html: string, at: string): string | undefined => new RegExp(`@${at} \\{ content: ([^;]*);`).exec(html)?.[1];

  it("takes the built-in confirmation's data from the reply's receipt, and prints {{receipt.reference}} in the header", async () => {
    const element = await mountWith((el) => {
      el.confirmation = true;
      el.addEventListener("datum-submit", (event) =>
        (event as CustomEvent).detail.waitUntil(Promise.resolve({ ok: true, receipt: { reference: "GC-48213", receivedAt: "2026-03-15", agent: { name: "Clerk" } } }))
      );
    });
    // Before a receipt the line reads only the receipt, so it is left off the page.
    expect(marginBox(await printed(element), "top-right")).toBeUndefined();
    const outcome = await element.submit();
    expect(outcome.accepted, JSON.stringify(element.errors)).toBe(true);
    await until(() => element.notice?.data !== undefined);
    expect(element.notice?.data).toEqual({ reference: "GC-48213", receivedAt: "2026-03-15", agent: { name: "Clerk" } });
    const html = await printed(element);
    expect(marginBox(html, "top-right")).toContain("GC-48213");
    expect(marginBox(html, "bottom-left")).toContain("2026-03-15");
  });

  it("takes the whole reply when it carries no receipt object, and none from a reply that is no plain object", async () => {
    const whole = await mountWith((el) => {
      el.confirmation = true;
      el.addEventListener("datum-submit", (event) => (event as CustomEvent).detail.waitUntil(Promise.resolve({ reference: "R-1", count: 2 })));
    });
    await whole.submit();
    await until(() => whole.notice !== undefined);
    expect(whole.notice?.data).toEqual({ reference: "R-1", count: 2 });

    class Reply {
      reference = "R-2";
    }
    const instance = await mountWith((el) => {
      el.confirmation = true;
      el.addEventListener("datum-submit", (event) => (event as CustomEvent).detail.waitUntil(Promise.resolve(new Reply())));
    });
    await instance.submit();
    await until(() => instance.notice !== undefined);
    // The reference still shows; the instance itself is no receipt data.
    expect(instance.notice?.details?.[0]?.value).toBe("R-2");
    expect(instance.notice?.data).toBeUndefined();
  });

  it("reduces the page's own data to plain JSON, never throwing on what it cannot read", async () => {
    const element = await mountWith(() => undefined);
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    cyclic.list = [1, cyclic, "two"];
    let deep: Record<string, unknown> = { leaf: "bottom" };
    for (let level = 0; level < 20; level += 1) {
      deep = { next: deep };
    }
    const throwing = new Proxy({}, { ownKeys: () => { throw new Error("no keys"); } });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const withGetter = Object.defineProperty({ kept: true }, "boom", { enumerable: true, get: () => { throw new Error("boom"); } });
    const data = {
      reference: "GC-1",
      amount: 12.5,
      ok: false,
      none: null,
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      fn: () => "x",
      symbol: Symbol("s"),
      big: BigInt(1),
      date: new Date(0),
      map: new Map([["a", 1]]),
      huge: "x".repeat(5000),
      cyclic,
      deep,
      throwing,
      revoked: revocable.proxy,
      withGetter,
      list: [1, Number.NaN, "a", () => 1, [true]],
      bare: Object.assign(Object.create(null), { a: 1 }),
      ["__proto__"]: { polluted: true }
    };
    expect(() => element.setNotice({ data })).not.toThrow();
    const reduced = element.notice?.data as Record<string, unknown>;
    expect(Object.keys(reduced).sort()).toEqual(["__proto__", "amount", "bare", "cyclic", "deep", "list", "none", "ok", "reference", "withGetter"].sort());
    expect(reduced.reference).toBe("GC-1");
    expect(reduced.cyclic).toEqual({ name: "loop", list: [1, "two"] });
    expect(reduced.list).toEqual([1, "a", [true]]);
    expect(reduced.withGetter).toEqual({ kept: true });
    expect(reduced.bare).toEqual({ a: 1 });
    // An own key, never the prototype.
    expect(Object.getPrototypeOf(reduced)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Deep nesting is cut past the bound.
    let level = reduced.deep as Record<string, unknown> | undefined;
    let depth = 0;
    while (level && typeof level.next === "object") {
      level = level.next as Record<string, unknown>;
      depth += 1;
    }
    expect(depth).toBeLessThan(10);
    expect(JSON.stringify(reduced)).not.toContain("bottom");
    // A huge list is bounded too.
    element.setNotice({ data: { many: Array.from({ length: 10000 }, (_, index) => index) } });
    expect((element.notice?.data?.many as unknown[]).length).toBeLessThan(600);
    // A sparse array of any length is read only to the bound.
    const sparse: unknown[] = [];
    sparse.length = 2 ** 31;
    element.setNotice({ data: { sparse } });
    expect(element.notice?.data).toEqual({ sparse: [] });
    // No plain object: no data.
    element.setNotice({ title: "Hi", data: [1, 2] as never });
    expect(element.notice).toEqual({ title: "Hi" });
  });

  it("draws nothing for a data-only notice, moves no focus and announces nothing, and prints its data", async () => {
    const element = await mountWith(() => undefined);
    const shadow = element.renderer!.shadowRoot!;
    const input = shadow.querySelector<HTMLInputElement>('[data-component-id="name"] input')!;
    input.focus();
    const before = shadow.querySelectorAll('[role="status"], [role="alert"]').length;
    element.setNotice({ data: { reference: "PAGE-7" } });
    await element.renderer!.painted();
    expect(shadow.querySelector(".datum-form__notice")).toBeNull();
    expect(shadow.querySelectorAll('[role="status"], [role="alert"]').length).toBe(before);
    expect(shadow.activeElement).toBe(input);
    expect(marginBox(await printed(element), "top-right")).toContain("PAGE-7");
  });

  it("keeps the page's data when the built-in confirmation follows a data-only notice", async () => {
    const element = await mountWith((el) => {
      el.confirmation = true;
      el.addEventListener("datum-submit", (event) =>
        (event as CustomEvent).detail.waitUntil(Promise.resolve({ reference: "SERVER-1" }).then((reply) => (el.setNotice({ data: { reference: "PAGE-1" } }), reply)))
      );
    });
    await element.submit();
    await until(() => element.notice?.title !== undefined);
    expect(element.notice?.details?.[0]?.value).toBe("SERVER-1");
    expect(element.notice?.data).toEqual({ reference: "PAGE-1" });
  });
});

describe("printRenditions on <datum-form>", () => {
  it("reads what the definition offers and its default", () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    expect(element.printRenditions).toEqual({ offered: ["answers"], default: "answers" });
    const offered = definition();
    (offered.root.configuration as Record<string, unknown>).print = { renditions: ["filled", "blank"] };
    element.definition = offered;
    expect(element.printRenditions).toEqual({ offered: ["filled", "blank"], default: "filled" });
  });
});

describe("printing in another locale through <datum-form>", () => {
  it("forwards the locale, leaving the form's own", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    const french = definition();
    (french as unknown as Record<string, unknown>).localization = { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] };
    element.definition = french;
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector('[data-component-id="name"]'));
    const html = await printed(element, { locale: "fr" });
    expect(new DOMParser().parseFromString(html, "text/html").documentElement.getAttribute("lang")).toBe("fr");
    expect(element.runtime!.state().locale).toBe("en");
  });
});
