import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import { acmeComponentsPlugin } from "./fixtures/acme-components.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { LiveBinding } from "../src/form.js";
import { modesReady, sampleDefinition, until } from "./helpers.js";
import { payload, scan, txt } from "./markup-injection-harness.js";

/**
 * What a shared definition can do to the author who opens it:
 * every case here is an attack the builder must resist.
 */
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const wrap = (children: unknown[], extra: Record<string, unknown> = {}): any => ({
  id: "shared",
  version: "1.0.0",
  schemaVersion: "1",
  ...extra,
  root: { id: "root", type: "form", configuration: {}, children: { content: children } }
});
const builderWith = async (definition: unknown): Promise<DatumFormBuilderElement> => {
  const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
  el.definition = definition as never;
  document.body.append(el);
  await until(() => el.builder?.shadowRoot?.querySelector("datum-builder-canvas"), 10000);
  return el;
};

const JS = "javascript:window.__pwn=1";
// The per-renderer cases (every unsafe spelling, each component) are the component package's own
// tests; here the two elements that draw a plugin's components are held to the same rule.
const pluginDefinition = () =>
  wrap([
    { id: "lnk", type: "acme-link", configuration: { text: "Read the notice", href: JS } },
    { id: "card", type: "acme-card", configuration: { cardTitle: "Card", href: JS }, children: { content: [] } }
  ]);

describe("a definition's javascript: href never reaches a live anchor", () => {
  // The form is drawn by a binding: no plugin string renderer draws it, and the only
  // address from the definition a binding is handed is held to `isSafeUrl` first (a chrome
  // image's link). An html component's link is sanitized before any binding sees it.
  it("<datum-form> draws none, and a binding's chrome adapter is never handed one", async () => {
    const heard: unknown[] = [];
    const binding: LiveBinding = {
      id: "markup-probe",
      label: "Markup probe",
      components: {},
      chrome: {
        image: {
          template: (state) => {
            heard.push(state.image?.href);
            // Datum's own drawing of the part, handed on unchanged.
            return state.content as never;
          }
        }
      }
    };
    const definition = wrap([
      { id: "lnk", type: "acme-link", configuration: { text: "Read the notice", href: JS } },
      { id: "h", type: "html", configuration: { html: `<a href="${JS}">notice</a>` } }
    ]);
    definition.root.configuration = { title: "T", chrome: { header: [{ type: "image", src: "/logo.png", alt: "Logo", href: JS }] } };
    for (const drawWith of [undefined, binding]) {
      const el = document.createElement("datum-form") as any;
      el.plugins = [acmeComponentsPlugin];
      if (drawWith) {
        el.binding = drawWith;
      }
      el.definition = definition;
      document.body.append(el);
      await until(() => el.renderer?.shadowRoot?.querySelector('[data-chrome-part="image"]') && el.renderer.shadowRoot.querySelector('[data-component-id="h"]'), 8000);
      expect(scan(el).filter((hit) => hit.kind === "js-url")).toEqual([]);
      el.remove();
    }
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((href) => href === undefined)).toBe(true);
  });

  it("the builder canvas draws none either", async () => {
    const el = document.createElement("datum-form-builder") as any;
    el.plugins = [acmeComponentsPlugin];
    el.definition = pluginDefinition();
    document.body.append(el);
    await until(() => el.builder?.shadowRoot?.querySelector("datum-builder-canvas"), 10000);
    await sleep(500);
    expect(scan(el).filter((hit) => hit.kind === "js-url")).toEqual([]);
  });
});

describe("builder textCatalog values are text", () => {
  it("settings.sources.state.*, inspector.tab.*, languages.coverage.* make no element", async () => {
    const keys = ["settings.sources.state.missing", "inspector.tab.rules", "inspector.tab.settings", "languages.coverage.other", "languages.coverage.one"];
    const en: Record<string, string> = {};
    for (const key of keys) {
      en[key] = `${txt("T:" + key)} {translated} {total}`;
    }
    const definition: any = sampleDefinition();
    definition.root.children.content[1].rules = { visibleWhen: "true" };
    const el = document.createElement("datum-form-builder") as any;
    el.definition = definition;
    el.textCatalog = { en };
    document.body.append(el);
    await until(() => el.builder?.shadowRoot?.querySelector("datum-builder-canvas"), 10000);
    await modesReady(el, 8000).catch(() => undefined);
    (el.builder.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>('[data-strip] [data-panel="form"]')?.click();
    el.controller.select("country");
    await sleep(300);
    el.controller.select("root");
    await sleep(300);
    el.workspace = "languages";
    await sleep(1500);
    expect(scan(el).filter((hit) => hit.kind === "on-attr" || hit.kind === "marker")).toEqual([]);
  }, 40000);
});

/** Definition TEXT with `depth` fieldsets around a leaf, built by concatenation: a 1 MB stack (Linux runners) overflows JSON.stringify on a deep object. */
const deepText = (depth: number, wrapAround: (nested: string) => string = (nested) => nested): string => {
  let open = "";
  let close = "";
  for (let i = depth - 1; i >= 0; i -= 1) {
    open += `{"id":"f${i}","type":"fieldset","configuration":{},"children":{"content":[`;
    close += "]}}";
  }
  return wrapAround(`${open}{"id":"leaf","type":"text","configuration":{}}${close}`);
};
const SENTINEL = { id: "__nested__", type: "text", configuration: {} };
/** wrap([...]) as text with the deep node text in place of `SENTINEL`. */
const textWith = (definition: unknown, nestedText: string): string => JSON.stringify(definition).replace(JSON.stringify(SENTINEL), nestedText);

const deep = (depth: number): any => {
  let node: any = { id: "leaf", type: "text", configuration: {} };
  for (let i = 0; i < depth; i += 1) {
    node = { id: "f" + i, type: "fieldset", configuration: {}, children: { content: [node] } };
  }
  return wrap([node]);
};

describe("every load path runs the structure check", () => {
  it("the definition setter keeps the form and reports a datum-error for an over-deep tree", async () => {
    const el = await builderWith(wrap([{ id: "keep", type: "text", configuration: {} }]));
    const heard: string[] = [];
    el.addEventListener("datum-error", (event) => heard.push((event as CustomEvent<{ message: string }>).detail.message));
    const uncaught: string[] = [];
    const onError = (event: ErrorEvent) => uncaught.push(event.message);
    window.addEventListener("error", onError);
    el.definition = deep(2500);
    await sleep(500);
    window.removeEventListener("error", onError);
    expect(heard.join(" ")).toMatch(/not loaded.*levels deep/);
    expect(el.controller?.snapshot().children?.content?.map((child) => child.id)).toEqual(["keep"]);
    expect(uncaught).toEqual([]);
  }, 30000);

  it("the definition setter, the attribute and src refuse a tree whose nodes are not nodes, keep the form and report it", async () => {
    const keep = wrap([{ id: "keep", type: "text", configuration: {} }]);
    const cases: Array<[string, unknown]> = [
      ["a null child", wrap([null, { id: "a", type: "text", configuration: {} }])],
      ["a slot that is not a list", { ...keep, root: { id: "root", type: "form", children: { content: "x" } } }],
      ["a child without a type", wrap([{ id: "a" }, { id: "b", type: "text", configuration: {} }])],
      ["a configuration that is a number", wrap([{ id: "a", type: "text", configuration: 5 }])],
      ["children that are null", { ...keep, root: { id: "root", type: "form", children: null } }],
      ["a root that is not the form", { ...keep, root: { id: "root", type: "text", configuration: {} } }],
      ["a root with no type", { ...keep, root: { id: "root" } }],
      ["a root that is a string", { ...keep, root: "x" }],
      ["an empty object", {}]
    ];
    const el = await builderWith(keep);
    const heard: string[] = [];
    el.addEventListener("datum-error", (event) => heard.push((event as CustomEvent<{ message: string }>).detail.message));
    const uncaught: string[] = [];
    const onError = (event: ErrorEvent) => {
      uncaught.push(event.message);
      event.preventDefault();
    };
    const onRejection = (reason: unknown) => uncaught.push(String(reason));
    window.addEventListener("error", onError);
    process.on("unhandledRejection", onRejection);
    const kept = () => el.controller?.snapshot().children?.content?.map((child) => child.id);
    try {
      for (const [label, bad] of cases) {
        heard.length = 0;
        el.definition = bad as never;
        await sleep(30);
        expect(heard.length, `setter: ${label}`).toBe(1);
        expect(heard[0], label).toMatch(/not loaded/);
        expect(kept(), `setter: ${label}`).toEqual(["keep"]);
        expect(el.definition.id, label).toBe("shared");

        heard.length = 0;
        el.setAttribute("definition", JSON.stringify(bad));
        await sleep(30);
        expect(heard.length, `attribute: ${label}`).toBeGreaterThanOrEqual(1);
        expect(kept(), `attribute: ${label}`).toEqual(["keep"]);

        heard.length = 0;
        vi.stubGlobal("fetch", async () => new Response(JSON.stringify(bad), { status: 200 }));
        el.src = "/forms/bad.json";
        await sleep(30);
        expect(heard.length, `src: ${label}`).toBeGreaterThanOrEqual(1);
        expect(kept(), `src: ${label}`).toEqual(["keep"]);
        el.src = undefined;
      }
    } finally {
      window.removeEventListener("error", onError);
      process.off("unhandledRejection", onRejection);
    }
    expect(uncaught).toEqual([]);
    expect(el.dirty).toBe(false);
    // A form with a layout or a journey the builder cannot use still loads, as definitionLoadProblem says.
    heard.length = 0;
    el.definition = wrap([{ id: "next", type: "text", configuration: {} }], { pdf: { layouts: [null] }, journey: { journeys: ["x"] } });
    await sleep(60);
    expect(heard.filter((message) => /not loaded/.test(message))).toEqual([]);
    expect(kept()).toEqual(["next"]);
  }, 30000);

  it("a malformed tree handed over before the element connects is reported, not left as the default form in silence", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    const heard: string[] = [];
    const uncaught: string[] = [];
    const onError = (event: ErrorEvent) => {
      uncaught.push(event.message);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    el.addEventListener("datum-error", (event) => heard.push((event as CustomEvent<{ message: string }>).detail.message));
    el.definition = wrap([null, { id: "a", type: "text", configuration: {} }]);
    document.body.append(el);
    await until(() => el.builder?.shadowRoot?.querySelector("datum-builder-canvas"), 10000);
    await sleep(60);
    window.removeEventListener("error", onError);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/The form was not loaded: root\.children\.content\[0\] must be a component node object/);
    expect(uncaught).toEqual([]);
  }, 30000);

  it("the journeyConfiguration and pdfConfiguration setters refuse what Open refuses and keep the sides as they are", async () => {
    const el = await builderWith(wrap([{ id: "keep", type: "text", configuration: {} }]));
    const heard: string[] = [];
    el.addEventListener("datum-error", (event) => heard.push((event as CustomEvent<{ message: string }>).detail.message));
    const journeyBefore = JSON.stringify(el.journeyConfiguration ?? null);
    const pdfBefore = JSON.stringify(el.pdfConfiguration ?? null);
    const badJourneys: unknown[] = [
      { journeys: "x" },
      { journeys: [null] },
      { journeys: Array.from({ length: 33 }, (_, i) => ({ id: "j" + i, pages: [{ id: "p", components: ["keep"] }] })) },
      JSON.parse('{"journeys":[{"id":"j","pages":[]}],"__proto__":{"x":1}}'),
      5
    ];
    for (const bad of badJourneys) {
      heard.length = 0;
      el.journeyConfiguration = bad as never;
      expect(heard.length, JSON.stringify(bad).slice(0, 60)).toBe(1);
      expect(JSON.stringify(el.journeyConfiguration ?? null)).toBe(journeyBefore);
      expect("journey" in el.definition).toBe(false);
    }
    const layout = (id: string) => ({ id, kind: "generated", root: { id: "document", type: "pdf-document", children: {} } });
    const badPdfs: unknown[] = [{ layouts: 5 }, { layouts: Array.from({ length: 65 }, (_, i) => layout("l" + i)) }, { layouts: [null] }, "x"];
    for (const bad of badPdfs) {
      heard.length = 0;
      el.pdfConfiguration = bad as never;
      expect(heard.length, JSON.stringify(bad).slice(0, 60)).toBe(1);
      expect(JSON.stringify(el.pdfConfiguration ?? null)).toBe(pdfBefore);
    }
    // A good block still goes in.
    heard.length = 0;
    el.journeyConfiguration = { journeys: [{ id: "j", pages: [{ id: "p", components: ["keep"] }] }] } as never;
    expect(heard).toEqual([]);
    expect(el.definition.journey?.journeys?.[0]?.id).toBe("j");
    el.journeyConfiguration = undefined;
    el.pdfConfiguration = undefined;
    expect(heard).toEqual([]);
    expect("journey" in el.definition).toBe(false);
  }, 30000);

  it("a journey page entry nested 3,000 deep is refused on every route, as the server counts it", async () => {
    const el = await builderWith(wrap([{ id: "keep", type: "text", configuration: {} }]));
    let entry: any = { id: "leaf", type: "text", configuration: {} };
    for (let i = 0; i < 3000; i += 1) {
      entry = { id: "e" + i, type: "fieldset", configuration: {}, children: { content: [entry] } };
    }
    const withEntry = (nested: unknown): any => ({ ...wrap([{ id: "a", type: "text", configuration: {} }]), journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["a", nested] }] }] } });
    const entryText = textWith(withEntry(SENTINEL), deepText(3000));
    const heard: string[] = [];
    el.addEventListener("datum-error", (event) => heard.push((event as CustomEvent<{ message: string }>).detail.message));
    el.definition = withEntry(entry);
    expect(heard.join(" ")).toMatch(/not loaded.*levels deep/);
    expect(el.controller?.snapshot().children?.content?.map((child) => child.id)).toEqual(["keep"]);
    expect(() => el.fileActions.open!({ name: "x.json", text: entryText })).toThrow(/levels deep/);
    // A shallow entry still loads.
    expect(() => el.fileActions.open!({ name: "x.json", text: JSON.stringify(withEntry({ id: "shallow", type: "text", configuration: {} })) })).not.toThrow();
  }, 30000);

  it("Open refuses depth, prototype-named ids, invalid ids and a definition over the component cap", async () => {
    const el = await builderWith(wrap([{ id: "keep", type: "text", configuration: {} }]));
    const open = (definition: unknown): unknown => el.fileActions.open!({ name: "x.json", text: JSON.stringify(definition) }) as unknown;
    const openText = (text: string): unknown => el.fileActions.open!({ name: "x.json", text }) as unknown;
    const deepFormText = (depth: number): string => textWith(wrap([SENTINEL]), deepText(depth));
    expect(() => openText(deepFormText(1000))).toThrow(/levels deep/);
    expect(() => openText(deepFormText(8000))).toThrow(/levels deep/);
    expect(() => open(wrap([{ id: "__proto__", type: "text", configuration: {} }]))).toThrow(/id/i);
    expect(() => open(wrap([{ id: "a b", type: "text", configuration: {} }]))).toThrow(/id/i);
    const many = Array.from({ length: 10_001 }, (_, i) => ({ id: "f" + i, type: "text", configuration: {} }));
    expect(() => open(wrap(many))).toThrow(/at most 10000 components/);
    expect(() => open(wrap([{ id: "fine", type: "text", configuration: {} }]))).not.toThrow();
  }, 30000);
});

describe("ids named like Object.prototype members", () => {
  it("draw: the options lookup reads own keys (the server warns, it does not refuse, these ids)", async () => {
    const el = await builderWith(wrap([{ id: "keep", type: "text", configuration: {} }]));
    const messages: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));
    try {
      // `constructor` and `prototype` are not component ids at all now (the translations map cannot key them), so Open refuses them.
      for (const id of ["toString", "hasOwnProperty", "valueOf"]) {
        const apply = el.fileActions.open!({ name: "x.json", text: JSON.stringify(wrap([{ id, type: "text", configuration: {} }])) }) as unknown as () => void;
        apply();
        await sleep(200);
      }
    } finally {
      console.error = original;
    }
    expect(messages.filter((message) => /could not be drawn|path\.split/.test(message))).toEqual([]);
    expect(Object.keys(Object.prototype)).toEqual([]);
  }, 20000);
});

describe("the preview refuses a risky pattern", () => {
  it("Open of a definition with a catastrophic literal pattern does not run it", async () => {
    const el = await builderWith(wrap([{ id: "x", type: "text", configuration: { label: "x" } }]));
    const definition = wrap([{ id: "x", type: "text", configuration: { label: "x" }, rules: { visibleWhen: `matches("${"a".repeat(30)}!", "(a+)+$")` } }]);
    const apply = el.fileActions.open!({ name: "x.json", text: JSON.stringify(definition) }) as unknown as () => void;
    const started = performance.now();
    apply();
    await sleep(300);
    // Before the fix n=27 held the tab for 1.3 s and n=30 for about 10 s.
    expect(performance.now() - started).toBeLessThan(1500);
  }, 30000);
});

describe("text from a refused file reaches the bar as text", () => {
  it("a hostile file name and message make no element", async () => {
    const el = await builderWith(wrap([{ id: "keep", type: "text", configuration: {} }]));
    const builder = el.builder!;
    const file = new File(["not json"], `${payload("file.name")}.json`);
    const input = builder.shadowRoot!.querySelector<HTMLInputElement>('input[type="file"]');
    if (input) {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(500);
    }
    expect(scan(el).filter((hit) => hit.kind === "on-attr" || hit.kind === "marker")).toEqual([]);
  });
});
