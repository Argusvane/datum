// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import {
  AssetLoadError,
  acquireFontSheet,
  adoptInto,
  importWrappers,
  leadingImports,
  loadScript,
  remAsVariable,
  resetAssetCaches,
  resolveUrls,
  rewriteSelectorList,
  shadowSheet
} from "../form-engine/render/live/assets.js";
import { assetsFeature } from "../form-engine/render/live/assets-feature.js";
import type { BindingErrorDetail, FieldAdapter, LiveAssets, LiveBinding } from "../form-engine/render/live/contract.js";
import { lit } from "../form-engine/render/live/lit.js";
import { mountLive, type LiveForm } from "../form-engine/render/live/mount.js";
import { hideConstructedSheets } from "./setup/constructed-sheets.js";

/*
 * The design system's files (render/live/assets.ts):
 * the selector rewrite over parsed rules, imports inlined under their conditions, url()s
 * resolved, rem scaled, @font-face lifted to one document sheet per binding, the caches keyed by
 * (url, integrity, rewrite options), scripts, and the fail-loud mount.
 *
 * jsdom parses constructed sheets (nesting included) and gives a document and a shadow root
 * `adoptedStyleSheets`: the cases for a root that takes none hide it (hideConstructedSheets), and the
 * ones that watch the array swapped define it on the instance, here in the test.
 * What jsdom cannot show (a rewritten rule reaching the shadow tree, SRI, CORS, real script
 * loads) is checked in headless Chrome.
 */

// ── Fetch, stubbed ─────────────────────────────────────────────────────────────────────────

interface Served {
  status?: number;
  body?: string;
  throws?: string;
}

let served: Record<string, Served> = {};
let fetches: Array<{ url: string; integrity: string | undefined }> = [];

function serve(files: Record<string, string | Served>): void {
  served = Object.fromEntries(Object.entries(files).map(([url, file]) => [url, typeof file === "string" ? { body: file } : file]));
}

beforeEach(() => {
  resetAssetCaches();
  served = {};
  fetches = [];
  vi.stubGlobal("fetch", async (url: string, init?: { integrity?: string }) => {
    fetches.push({ url, integrity: init?.integrity });
    await Promise.resolve();
    const file = served[url];
    if (file?.throws !== undefined) {
      throw new TypeError(file.throws);
    }
    if (!file) {
      return { ok: false, status: 404, text: async () => "" };
    }
    const status = file.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => file.body ?? "" };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const element of Array.from(document.querySelectorAll("[data-datum-binding-script], [data-datum-binding-fonts]"))) {
    element.remove();
  }
  delete (document as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
  document.body.replaceChildren();
});

/** Gives `target` its own plain `adoptedStyleSheets` array, so the test reads back exactly what the code assigned. */
function withAdoptedSheets<T extends Document | ShadowRoot>(target: T): T & { adoptedStyleSheets: CSSStyleSheet[] } {
  let sheets: CSSStyleSheet[] = [];
  Object.defineProperty(target, "adoptedStyleSheets", {
    configurable: true,
    get: () => sheets,
    set: (value: CSSStyleSheet[]) => {
      sheets = [...value];
    }
  });
  return target as T & { adoptedStyleSheets: CSSStyleSheet[] };
}

function shadowRoot(): ShadowRoot {
  const host = document.createElement("div");
  document.body.append(host);
  return host.attachShadow({ mode: "open" });
}

const selectorsOf = (sheet: CSSStyleSheet): string[] =>
  Array.from(sheet.cssRules, (rule) => (rule as CSSStyleRule).selectorText ?? rule.cssText.split("{")[0]?.trim() ?? "");

// ── The selector rewrite ───────────────────────────────────────────────────────────────────

describe("live assets: selectors made to name the shadow host", () => {
  // The prototype's fix-pass corpus (checks/legacy/fixpass/css2.mts) as selectors, plus nesting and :where(html).
  const cases: Array<[string, string, boolean]> = [
    [':root[data-theme="dark"]', ':host([data-theme="dark"])', false],
    [":root:not(.x)", ":host(:not(.x))", false],
    [":root.x .y", ":host(.x) .y", false],
    ["html", ":host", true],
    ["body", ":host", true],
    [":root", ":host", false],
    ['html[dir="rtl"] .x', ':host([dir="rtl"]) .x', false],
    ["body.modal-open", ":host(.modal-open)", false],
    [".a, html", ".a, :host", false],
    ["html, body", ":host, :host", true],
    ["html body .x", ":host .x", false],
    ["html > body > .x", ":host > .x", false],
    ["html:not(.js) body .x", ":host(:not(.js)) .x", false],
    ["body::before", ":host::before", false],
    ["html::-webkit-scrollbar", ":host::-webkit-scrollbar", false],
    [".html", ".html", false],
    ["htmlx", "htmlx", false],
    ['[data-x="html{"] .y', '[data-x="html{"] .y', false],
    [":where(:root)", ":where(:host)", false],
    [":where(html)", ":where(:host)", true],
    [":where(html) .x", ":where(:host) .x", false],
    [':where(html[dir="rtl"]) .x', ':where(:host([dir="rtl"])) .x', false],
    [":is(html, body)", ":is(:host, :host)", true],
    ["html &", ":host &", false],
    [':root[dir="rtl"] &', ':host([dir="rtl"]) &', false],
    ["& .x", "& .x", false],
    [".a :root .b", ".a :host .b", false]
  ];
  it.each(cases)("%s -> %s", (input, output, pageOnly) => {
    expect(rewriteSelectorList(input)).toEqual({ text: output, pageOnly });
  });
});

describe("live assets: a sheet parsed and rewritten", () => {
  it("rewrites rules inside grouping rules and nested rules, and leaves keyframes alone", () => {
    const { sheet } = shadowSheet(
      "@media print{html{color:red}} @supports (display:grid){body{display:grid}} @layer base{:root{--a:1}} html{color:red;& .x{color:blue}} .card{html &{color:green}} @keyframes k{from{opacity:0}}",
      document
    );
    const rules = Array.from(sheet.cssRules);
    const inner = (index: number): string[] => Array.from((rules[index] as CSSGroupingRule).cssRules, (rule) => (rule as CSSStyleRule).selectorText);
    expect(inner(0)).toEqual([":host"]);
    expect(inner(1)).toEqual([":host"]);
    expect(inner(2)).toEqual([":host"]);
    expect((rules[3] as CSSStyleRule).selectorText).toBe(":host");
    expect(inner(3)).toEqual(["& .x"]);
    expect(inner(4)).toEqual([":host &"]);
    expect(rules[5]?.cssText).toContain("@keyframes k");
  });

  it("drops page-only declarations from a bare html or body only", () => {
    const { sheet } = shadowSheet("html,body{height:100%;margin:0;overflow-x:hidden;color:red;line-height:1.5} body.x{margin:0} .a,html{margin:0}", document);
    const [bare, qualified, mixed] = Array.from(sheet.cssRules) as CSSStyleRule[];
    expect(bare?.style.getPropertyValue("height")).toBe("");
    expect(bare?.style.getPropertyValue("margin-top")).toBe("");
    expect(bare?.style.getPropertyValue("overflow-x")).toBe("");
    expect(bare?.style.getPropertyValue("color")).toBe("red");
    expect(bare?.style.getPropertyValue("line-height")).toBe("1.5");
    expect(qualified?.style.getPropertyValue("margin-top")).not.toBe("");
    expect(mixed?.style.getPropertyValue("margin-top")).not.toBe("");
  });

  it("takes the @font-face rules out, wherever they sit, and hands them back in order", () => {
    const { sheet, faces } = shadowSheet("@font-face{font-family:a} .x{color:red} @media screen{@font-face{font-family:b}}", document);
    expect(faces).toHaveLength(2);
    expect(faces[0]).toContain("font-family: a");
    expect(faces[1]).toContain("font-family: b");
    expect(selectorsOf(sheet)).toEqual([".x", "@media screen"]);
    expect((sheet.cssRules[1] as CSSGroupingRule).cssRules).toHaveLength(0);
  });

  it("scales rem lengths through --datum-rem only when the sheet expects another root size", () => {
    const scaled = shadowSheet(".x{font-size:1rem;padding:.5rem 2rem} @media (min-width:40rem){.y{margin:-1.25rem}}", document, { rem: { expected: 10, actual: 16 } }).sheet;
    expect((scaled.cssRules[0] as CSSStyleRule).style.cssText).toContain("calc(1 * var(--datum-rem))");
    // Media queries read the initial font size, not the root's: they stay as written.
    expect((scaled.cssRules[1] as CSSMediaRule).conditionText ?? scaled.cssRules[1]?.cssText).toContain("40rem");
    expect(((scaled.cssRules[1] as CSSMediaRule).cssRules[0] as CSSStyleRule).style.cssText).toContain("calc(-1.25 * var(--datum-rem))");
    const same = shadowSheet(".x{font-size:1rem}", document, { rem: { expected: 16, actual: 16 } }).sheet;
    expect((same.cssRules[0] as CSSStyleRule).style.cssText).toBe("font-size: 1rem;");
  });

  it("rewrites rem in declaration text, never in strings, url()s or longer names", () => {
    expect(remAsVariable("margin: 0 1rem -2.5rem .5rem")).toBe(
      "margin: 0 calc(1 * var(--datum-rem)) calc(-2.5 * var(--datum-rem)) calc(.5 * var(--datum-rem))"
    );
    expect(remAsVariable('background: url(icon-2rem.svg); content: "3rem"; --x: 1remx; width: calc(100% - 1rem)')).toBe(
      'background: url(icon-2rem.svg); content: "3rem"; --x: 1remx; width: calc(100% - calc(1 * var(--datum-rem)))'
    );
  });
});

// ── Text: imports and urls ─────────────────────────────────────────────────────────────────

describe("live assets: imports and urls", () => {
  it("wraps an import's text in its conditions, outermost first", () => {
    const cases: Array<[string, string]> = [
      ["screen and (min-width:1px)", "@media screen and (min-width:1px){"],
      ["layer(base) supports(display:grid) print", "@layer base{@supports (display:grid){@media print{"],
      ["layer", "@layer{"],
      ["", ""],
      ["supports(selector(:has(a)))", "@supports (selector(:has(a))){"]
    ];
    for (const [conditions, open] of cases) {
      const wrapped = importWrappers(conditions);
      expect(wrapped.open).toBe(open);
      expect(wrapped.close).toBe("}".repeat((open.match(/\{/g) ?? []).length));
    }
  });

  it("reads only the imports a sheet opens with, semicolons inside addresses included", () => {
    const text = [
      '@charset "utf-8";',
      "/* banner @import 'no.css'; */",
      "@layer reset, base;",
      "@import url(https://fonts.example/css2?family=Lato:wght@400;700&display=swap);",
      '@import "a.css" layer(base) screen;',
      "@import url('b.css') supports(display:grid);",
      ".x{content:'@import \"c.css\";'}",
      "@import 'late.css';"
    ].join("\n");
    const found = leadingImports(text);
    expect(found.layers).toEqual(["@layer reset, base;"]);
    expect(found.imports).toEqual([
      { target: "https://fonts.example/css2?family=Lato:wght@400;700&display=swap", conditions: "" },
      { target: "a.css", conditions: "layer(base) screen" },
      { target: "b.css", conditions: "supports(display:grid)" }
    ]);
    expect(found.rest.trimStart().startsWith(".x{")).toBe(true);
  });

  it("resolves relative url()s against the sheet's address and leaves the ones that stand alone", () => {
    const base = "https://cdn.example/ds/css/main.css";
    expect(resolveUrls("a{b:url(../img/x.png)} c{d:url( 'f.woff2' )} e{f:url(\"g h.svg\")}", base)).toBe(
      'a{b:url(https://cdn.example/ds/img/x.png)} c{d:url(\'https://cdn.example/ds/css/f.woff2\')} e{f:url("https://cdn.example/ds/css/g%20h.svg")}'
    );
    const alone = "a{b:url(data:image/png;base64,AA==)} c{d:url(blob:https://x/1)} e{f:url(#clip)} g{h:url(//other.example/x.png)} i{j:url(https://x/y)}";
    expect(resolveUrls(alone, base)).toBe(alone);
  });
});

// ── Adopting into a root ───────────────────────────────────────────────────────────────────

describe("live assets: adoptInto", () => {
  it("inlines imports under their conditions and adopts the rewritten sheet ahead of what the root holds", async () => {
    serve({
      "https://cdn.example/ds/main.css": "@import 'parts/print.css' print;\n@import url(parts/base.css) layer(base);\nhtml{color:red}",
      "https://cdn.example/ds/parts/print.css": "body{color:black}",
      "https://cdn.example/ds/parts/base.css": ".x{background:url(x.png)}"
    });
    const root = withAdoptedSheets(shadowRoot());
    const own = new CSSStyleSheet();
    root.adoptedStyleSheets = [own];
    const adopted = await adoptInto(root, { stylesheets: [{ url: "https://cdn.example/ds/main.css" }] }, { bindingId: "ds" });
    expect(root.adoptedStyleSheets).toEqual([...adopted.sheets, own]);
    const rules = Array.from(adopted.sheets[0]?.cssRules ?? []);
    expect(rules.map((rule) => rule.cssText.split("{")[0]?.trim())).toEqual(["@media print", "@layer base", ":host"]);
    expect(rules[1]?.cssText).toContain("https://cdn.example/ds/parts/x.png");
    adopted.release();
    expect(root.adoptedStyleSheets).toEqual([own]);
  });

  it("fetches a sheet once per (url, integrity) and shares one parsed sheet per rewrite, released with its last user", async () => {
    serve({ "https://cdn.example/ds.css": "html{font-size:1rem}" });
    const integrity = "sha384-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+/ab";
    const a = withAdoptedSheets(shadowRoot());
    const b = withAdoptedSheets(shadowRoot());
    const c = withAdoptedSheets(shadowRoot());
    const first = await adoptInto(a, { stylesheets: [{ url: "https://cdn.example/ds.css" }] }, { bindingId: "ds" });
    const second = await adoptInto(b, { stylesheets: [{ url: "https://cdn.example/ds.css" }] }, { bindingId: "ds" });
    expect(second.sheets[0]).toBe(first.sheets[0]);
    // Another rewrite (the rem scale) is another sheet from the same fetched text.
    const scaled = await adoptInto(c, { stylesheets: [{ url: "https://cdn.example/ds.css" }], rootFontSize: 20 }, { bindingId: "ds", expectedRootFontSize: 16 });
    expect(scaled.sheets).toHaveLength(2);
    expect(scaled.sheets[1]).not.toBe(first.sheets[0]);
    expect(scaled.sheets[0]?.cssRules[0]?.cssText.replace(/\s/g, "")).toBe(":host{--datum-rem:calc(1rem*0.8);}");
    expect(fetches).toEqual([{ url: "https://cdn.example/ds.css", integrity: undefined }]);
    // Integrity is part of the key, and goes to the fetch.
    await adoptInto(withAdoptedSheets(shadowRoot()), { stylesheets: [{ url: "https://cdn.example/ds.css", integrity }] }, { bindingId: "ds" });
    expect(fetches[1]).toEqual({ url: "https://cdn.example/ds.css", integrity });
    first.release();
    second.release();
    const again = await adoptInto(withAdoptedSheets(shadowRoot()), { stylesheets: [{ url: "https://cdn.example/ds.css" }] }, { bindingId: "ds" });
    expect(again.sheets[0]).not.toBe(first.sheets[0]);
    expect(fetches).toHaveLength(2);
  });

  it("refuses an integrity that is no digest, so a typo is never checked against nothing", async () => {
    serve({ "https://cdn.example/ds.css": ".x{}" });
    const failure = adoptInto(withAdoptedSheets(shadowRoot()), { stylesheets: [{ url: "https://cdn.example/ds.css", integrity: "abc123" }] }, { bindingId: "ds" });
    await expect(failure).rejects.toMatchObject({ name: "AssetLoadError", url: "https://cdn.example/ds.css" });
    expect(fetches).toEqual([]);
  });

  it("fails naming the file for a status, a refused fetch and a failed import, giving back what it took", async () => {
    serve({
      "https://cdn.example/ok.css": ".ok{}",
      "https://cdn.example/gone.css": { status: 404 },
      "https://other.example/ds.css": { throws: "Failed to fetch" },
      "https://cdn.example/imports.css": "@import 'missing.css';.x{}"
    });
    const root = withAdoptedSheets(shadowRoot());
    const status = adoptInto(root, { stylesheets: [{ url: "https://cdn.example/ok.css" }, { url: "https://cdn.example/gone.css" }] }, { bindingId: "ds" });
    await expect(status).rejects.toThrow("Stylesheet https://cdn.example/gone.css answered 404.");
    expect(root.adoptedStyleSheets).toEqual([]);
    const cors = adoptInto(root, { stylesheets: [{ url: "https://other.example/ds.css" }] }, { bindingId: "ds" });
    await expect(cors).rejects.toMatchObject({ url: "https://other.example/ds.css" });
    await expect(cors).rejects.toThrow(/could not be fetched \(Failed to fetch\).*CORS/);
    const imported = adoptInto(root, { stylesheets: [{ url: "https://cdn.example/imports.css" }] }, { bindingId: "ds" });
    await expect(imported).rejects.toMatchObject({ url: "https://cdn.example/missing.css" });
    await expect(imported).rejects.toThrow("imported by https://cdn.example/imports.css");
    // A failure is not remembered: the next mount asks again.
    const before = fetches.filter((entry) => entry.url === "https://cdn.example/gone.css").length;
    await adoptInto(root, { stylesheets: [{ url: "https://cdn.example/gone.css" }] }, { bindingId: "ds" }).catch(() => undefined);
    expect(fetches.filter((entry) => entry.url === "https://cdn.example/gone.css").length).toBe(before + 1);
  });

  it("skips an import already on its chain, as a browser does", async () => {
    serve({ "https://cdn.example/a.css": "@import 'b.css';.a{}", "https://cdn.example/b.css": "@import 'a.css';.b{}" });
    const adopted = await adoptInto(withAdoptedSheets(shadowRoot()), { stylesheets: [{ url: "https://cdn.example/a.css" }] }, { bindingId: "ds" });
    expect(selectorsOf(adopted.sheets[0] as CSSStyleSheet)).toEqual([".b", ".a"]);
  });

  it("puts the rules in <style> elements first where the root takes no constructed sheets", async () => {
    serve({ "https://cdn.example/ds.css": "body{color:red}" });
    onTestFinished(hideConstructedSheets());
    const root = shadowRoot();
    root.append(document.createElement("p"));
    const adopted = await adoptInto(root, { stylesheets: [{ url: "https://cdn.example/ds.css" }] }, { bindingId: "ds" });
    const first = root.firstElementChild;
    expect(first?.tagName).toBe("STYLE");
    expect(first?.textContent).toContain(":host");
    adopted.release();
    expect(root.querySelector("style")).toBeNull();
  });
});

// ── Fonts ──────────────────────────────────────────────────────────────────────────────────

describe("live assets: the document's font sheet", () => {
  it("is one sheet per binding, holding each face once, taken away with the binding's last form", async () => {
    const doc = withAdoptedSheets(document);
    const pageOwn = new CSSStyleSheet();
    doc.adoptedStyleSheets = [pageOwn];
    serve({
      "https://cdn.example/ds.css": "@font-face{font-family:Lato} .x{font-family:Lato}",
      "https://cdn.example/fonts.css": "@font-face{font-family:Noto} .ignored{color:red}"
    });
    const assets: LiveAssets = { stylesheets: [{ url: "https://cdn.example/ds.css" }], fonts: [{ url: "https://cdn.example/fonts.css" }] };
    const one = await adoptInto(withAdoptedSheets(shadowRoot()), assets, { bindingId: "ds" });
    const two = await adoptInto(withAdoptedSheets(shadowRoot()), assets, { bindingId: "ds" });
    const other = await adoptInto(withAdoptedSheets(shadowRoot()), { stylesheets: [{ url: "https://cdn.example/ds.css" }] }, { bindingId: "other" });
    await vi.waitFor(() => expect(doc.adoptedStyleSheets[1]?.cssRules).toHaveLength(2));
    expect(doc.adoptedStyleSheets).toHaveLength(3);
    expect(doc.adoptedStyleSheets[0]).toBe(pageOwn);
    const faces = Array.from(doc.adoptedStyleSheets[1]?.cssRules ?? [], (rule) => rule.cssText);
    expect(faces.every((face) => face.startsWith("@font-face"))).toBe(true);
    // The shadow root's sheet keeps no face: it is never registered there.
    expect(Array.from(one.sheets[0]?.cssRules ?? [], (rule) => rule.cssText).some((text) => text.includes("@font-face"))).toBe(false);
    one.release();
    expect(doc.adoptedStyleSheets).toHaveLength(3);
    two.release();
    expect(doc.adoptedStyleSheets).toHaveLength(2);
    other.release();
    expect(doc.adoptedStyleSheets).toEqual([pageOwn]);
  });

  it("goes in a <style> in the head where the document takes no constructed sheets", () => {
    onTestFinished(hideConstructedSheets());
    const fonts = acquireFontSheet(document, "ds");
    fonts.add(["@font-face { font-family: A; }", "@font-face { font-family: A; }"]);
    const element = document.head.querySelector('style[data-datum-binding-fonts="ds"]');
    expect(element?.textContent).toBe("@font-face { font-family: A; }");
    fonts.release();
    expect(element?.isConnected).toBe(false);
  });

  it("reports a font sheet that cannot be had, and the form's sheets are adopted all the same", async () => {
    serve({ "https://cdn.example/ds.css": ".x{}" });
    const failures: AssetLoadError[] = [];
    const adopted = await adoptInto(
      withAdoptedSheets(shadowRoot()),
      { stylesheets: [{ url: "https://cdn.example/ds.css" }], fonts: [{ url: "https://fonts.example/missing.css" }] },
      { bindingId: "ds", onFontError: (failure) => failures.push(failure) }
    );
    expect(adopted.sheets).toHaveLength(1);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]?.url).toBe("https://fonts.example/missing.css");
  });
});

// ── Scripts ────────────────────────────────────────────────────────────────────────────────

describe("live assets: scripts", () => {
  const added = (url: string): HTMLScriptElement[] => Array.from(document.querySelectorAll<HTMLScriptElement>("script[data-datum-binding-script]")).filter((script) => script.src === url);

  it("loads a module once per page, and a classic script in order with its attributes and integrity", async () => {
    const one = loadScript({ url: "https://cdn.example/ds.js" });
    const two = loadScript({ url: "https://cdn.example/ds.js" });
    expect(two).toBe(one);
    const [module] = added("https://cdn.example/ds.js");
    expect(module?.type).toBe("module");
    module?.dispatchEvent(new Event("load"));
    await expect(one).resolves.toBeUndefined();

    const integrity = "sha384-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+/ab";
    const classic = loadScript({ url: "https://cdn.example/qc.js", classic: true, integrity, attributes: { "data-root": "/qc" } });
    const [script] = added("https://cdn.example/qc.js");
    expect(script?.type).toBe("");
    expect(script?.async).toBe(false);
    expect(script?.getAttribute("data-root")).toBe("/qc");
    expect(script?.getAttribute("integrity")).toBe(integrity);
    expect(script?.getAttribute("crossorigin")).toBe("anonymous");
    script?.dispatchEvent(new Event("load"));
    await classic;
    // The same address with another integrity cannot be checked again: it already ran.
    await expect(loadScript({ url: "https://cdn.example/qc.js", integrity: "sha256-AAAA" })).rejects.toThrow("another integrity");
  });

  it("rejects naming the address when a script cannot be loaded, and asks again next time", async () => {
    const failing = loadScript({ url: "https://cdn.example/broken.js" });
    added("https://cdn.example/broken.js")[0]?.dispatchEvent(new Event("error"));
    await expect(failing).rejects.toMatchObject({ name: "AssetLoadError", url: "https://cdn.example/broken.js" });
    expect(added("https://cdn.example/broken.js")).toHaveLength(0);
    const retry = loadScript({ url: "https://cdn.example/broken.js" });
    expect(retry).not.toBe(failing);
    expect(added("https://cdn.example/broken.js")).toHaveLength(1);
  });

  it("takes a script the page already carries as run", async () => {
    const own = document.createElement("script");
    own.src = "https://cdn.example/page.js";
    document.head.append(own);
    await expect(loadScript({ url: "https://cdn.example/page.js" })).resolves.toBeUndefined();
    expect(added("https://cdn.example/page.js")).toHaveLength(0);
    own.remove();
  });

  it("checks a host's integrity against the page's own script tag, and records the page's value", async () => {
    const digest = "sha384-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+/ab";
    const other = "sha384-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxwvutsrqponmlkjihgfedcba+/ab";
    const own = document.createElement("script");
    own.src = "https://cdn.example/pinned.js";
    own.setAttribute("integrity", digest);
    document.head.append(own);
    const bare = document.createElement("script");
    bare.src = "https://cdn.example/bare.js";
    document.head.append(bare);
    try {
      // The page's digest is not the host's: nothing was checked against the host's, so it is refused.
      await expect(loadScript({ url: "https://cdn.example/pinned.js", integrity: other })).rejects.toMatchObject({ name: "AssetLoadError", url: "https://cdn.example/pinned.js" });
      await expect(loadScript({ url: "https://cdn.example/pinned.js", integrity: other })).rejects.toThrow("another integrity");
      // A tag with no integrity cannot vouch for one either.
      await expect(loadScript({ url: "https://cdn.example/bare.js", integrity: digest })).rejects.toThrow("without an integrity");
      // The same digest passes, and a later host naming another one is refused against what the page carries.
      await expect(loadScript({ url: "https://cdn.example/pinned.js", integrity: digest })).resolves.toBeUndefined();
      await expect(loadScript({ url: "https://cdn.example/pinned.js", integrity: other })).rejects.toThrow("another integrity");
      // A host that names no integrity takes the page's tag as it is; the page's digest is what is recorded.
      await expect(loadScript({ url: "https://cdn.example/pinned.js" })).resolves.toBeUndefined();
      await expect(loadScript({ url: "https://cdn.example/bare.js" })).resolves.toBeUndefined();
      await expect(loadScript({ url: "https://cdn.example/bare.js", integrity: digest })).rejects.toThrow("another integrity");
      expect(added("https://cdn.example/pinned.js")).toHaveLength(0);
    } finally {
      own.remove();
      bare.remove();
    }
  });
});

describe("live assets: scripts under Trusted Types", () => {
  const added = (url: string): HTMLScriptElement[] => Array.from(document.querySelectorAll<HTMLScriptElement>("script[data-datum-binding-script]")).filter((script) => script.src === url);

  /** A stand-in for the browser's `trustedTypes`: records the policies made, and what each was asked to pass. */
  function fakeTrustedTypes(refuse = false): { names: string[]; rules: Array<{ createScriptURL(input: string): string }> } {
    const made = { names: [] as string[], rules: [] as Array<{ createScriptURL(input: string): string }> };
    vi.stubGlobal("trustedTypes", {
      createPolicy(name: string, rules: { createScriptURL(input: string): string }) {
        if (refuse) {
          throw new TypeError(`Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': Policy "${name}" disallowed.`);
        }
        made.names.push(name);
        made.rules.push(rules);
        return { createScriptURL: (input: string) => ({ toString: () => rules.createScriptURL(input) }) };
      }
    });
    return made;
  }

  /** Enforces Trusted Types on `script.src` the way a browser does: a plain string is refused. Returns the undo. */
  function refuseStringSources(): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src") as PropertyDescriptor;
    Object.defineProperty(HTMLScriptElement.prototype, "src", {
      configurable: true,
      get(this: HTMLScriptElement) {
        return descriptor.get?.call(this);
      },
      set(this: HTMLScriptElement, value: unknown) {
        if (typeof value === "string") {
          throw new TypeError("Failed to set the 'src' property on 'HTMLScriptElement': This document requires 'TrustedScriptURL' assignment.");
        }
        descriptor.set?.call(this, value);
      }
    });
    return () => Object.defineProperty(HTMLScriptElement.prototype, "src", descriptor);
  }

  const mounts: LiveForm[] = [];

  afterEach(() => {
    for (const form of mounts.splice(0)) {
      form.unmount();
    }
    vi.unstubAllGlobals();
  });

  it("sets a script's address through one datum-assets policy, which passes only the addresses asked for", async () => {
    const made = fakeTrustedTypes();
    // Only a value from the policy is accepted: an address set as a plain string throws here.
    const restore = refuseStringSources();
    try {
      const one = loadScript({ url: "https://cdn.example/tt-one.js" });
      const two = loadScript({ url: "https://cdn.example/tt-two.js", classic: true });
      expect(made.names).toEqual(["datum-assets"]);
      const [first] = added("https://cdn.example/tt-one.js");
      const [second] = added("https://cdn.example/tt-two.js");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      first?.dispatchEvent(new Event("load"));
      second?.dispatchEvent(new Event("load"));
      await Promise.all([one, two]);
    } finally {
      restore();
    }
    // Nothing else gets through it: an address no binding asked for is refused.
    expect(() => made.rules[0]?.createScriptURL("https://evil.example/x.js")).toThrow("passes only the scripts a binding's assets list");
  });

  it("makes no policy for a form whose binding lists no script", async () => {
    const made = fakeTrustedTypes();
    serve({ "https://cdn.example/tt.css": ".x{}" });
    const definition: FormDefinition = {
      id: "f",
      version: "1",
      schemaVersion: "1",
      root: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }
    };
    const text: FieldAdapter = { kind: "field", name: "text", template: (s) => lit.html`<label for=${s.id}>${s.label}</label><input id=${s.id} />` };
    const binding: LiveBinding = { id: "tt-ds", label: "TT DS", designSystem: { name: "Test" }, components: { text } };
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]) });
    const host = document.createElement("div");
    document.body.append(host);
    const root = withAdoptedSheets(host.attachShadow({ mode: "open" }));
    const form = mountLive(root, { runtime, binding, assets: { stylesheets: [{ url: "https://cdn.example/tt.css" }] }, features: [assetsFeature()] });
    mounts.push(form);
    await form.ready;
    expect(root.querySelector("input")).not.toBeNull();
    expect(made.names).toEqual([]);
    expect(document.querySelectorAll("script[data-datum-binding-script]").length).toBe(0);
  });

  it("rejects naming the policy when the page enforces Trusted Types without allowing it, and adds no script", async () => {
    fakeTrustedTypes(true);
    // The page refuses a plain string where a TrustedScriptURL is required.
    const restore = refuseStringSources();
    try {
      const refused = loadScript({ url: "https://cdn.example/tt-refused.js" });
      await expect(refused).rejects.toMatchObject({ name: "AssetLoadError", url: "https://cdn.example/tt-refused.js" });
      await expect(refused).rejects.toThrow('does not allow the "datum-assets" policy');
      expect(document.querySelectorAll("script[data-datum-binding-script]").length).toBe(0);
      // Not remembered: the next form asks again.
      const again = loadScript({ url: "https://cdn.example/tt-refused.js" });
      expect(again).not.toBe(refused);
      await expect(again).rejects.toThrow("datum-assets");
    } finally {
      restore();
    }
  });
});

// ── The feature in a mount ─────────────────────────────────────────────────────────────────

describe("live assets: the assets feature", () => {
  const definition: FormDefinition = {
    id: "f",
    version: "1",
    schemaVersion: "1",
    root: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }
  };
  const text: FieldAdapter = { kind: "field", name: "text", template: (s) => lit.html`<label for=${s.id}>${s.label}</label><input id=${s.id} />` };
  const binding: LiveBinding = { id: "test-ds", label: "Test DS", designSystem: { name: "Test", rootFontSize: 10 }, components: { text } };
  const mounts: LiveForm[] = [];

  afterEach(() => {
    for (const form of mounts.splice(0)) {
      form.unmount();
    }
  });

  function mount(assets: LiveAssets): { root: ShadowRoot; form: LiveForm; errors: BindingErrorDetail[] } {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]) });
    const host = document.createElement("div");
    document.body.append(host);
    const root = withAdoptedSheets(host.attachShadow({ mode: "open" }));
    const errors: BindingErrorDetail[] = [];
    host.addEventListener("datum-binding-error", (event) => errors.push((event as CustomEvent<BindingErrorDetail>).detail));
    const form = mountLive(root, { runtime, binding, assets, features: [assetsFeature()] });
    mounts.push(form);
    return { root, form, errors };
  }

  it("adopts the host's sheets before the first draw, ahead of the renderer's own, and gives them back on unmount", async () => {
    serve({ "https://cdn.example/ds.css": "html{font-size:1.6rem}" });
    const { root, form } = mount({ stylesheets: [{ url: "https://cdn.example/ds.css" }] });
    await form.ready;
    const sheets = (root as ShadowRoot & { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets;
    // The rem scale (the binding expects 10px, the page is the browser's 16px), the host's sheet, then the renderer's.
    expect(sheets[0]?.cssRules[0]?.cssText.replace(/\s/g, "")).toBe(":host{--datum-rem:calc(1rem*0.625);}");
    expect((sheets[1]?.cssRules[0] as CSSStyleRule).style.cssText).toBe("font-size: calc(1.6 * var(--datum-rem));");
    expect(sheets.length).toBeGreaterThan(2);
    expect(root.querySelector("input")).not.toBeNull();
    form.unmount();
    expect((root as ShadowRoot & { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets).toEqual([]);
  });

  it("draws an alert in the form's place, emits datum-binding-error with the address, and rejects ready", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, form, errors } = mount({ stylesheets: [{ url: "https://cdn.example/missing.css" }] });
    await expect(form.ready).rejects.toBeInstanceOf(AssetLoadError);
    expect(root.querySelector("form")).toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("This form could not be shown. Check the connection and try again.");
    expect(errors).toEqual([{ hook: "assets", message: "Stylesheet https://cdn.example/missing.css answered 404.", url: "https://cdn.example/missing.css" }]);
  });

  it("reports a font sheet that fails with the same event, and still draws the form", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    serve({ "https://cdn.example/ds.css": ".x{}" });
    const { root, form, errors } = mount({ stylesheets: [{ url: "https://cdn.example/ds.css" }], fonts: [{ url: "https://fonts.example/gone.css" }] });
    await form.ready;
    expect(root.querySelector("input")).not.toBeNull();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ hook: "assets", url: "https://fonts.example/gone.css" });
  });

  it("gives the files back at once when the form is unmounted while they load", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    vi.stubGlobal("fetch", async () => {
      await gate;
      return { ok: true, status: 200, text: async () => ".x{}" };
    });
    const doc = withAdoptedSheets(document);
    const { root, form } = mount({ stylesheets: [{ url: "https://cdn.example/slow.css" }] });
    form.unmount();
    finish();
    await form.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((root as ShadowRoot & { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets).toEqual([]);
    expect(doc.adoptedStyleSheets).toEqual([]);
    expect(root.querySelector("form")).toBeNull();
  });

  it("does nothing for a binding with no host files", async () => {
    const { form } = mount({});
    await form.ready;
    expect(fetches).toEqual([]);
  });
});
