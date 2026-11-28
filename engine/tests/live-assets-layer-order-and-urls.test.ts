// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adoptInto, resetAssetCaches, resolveUrls, shadowSheet } from "../form-engine/render/live/assets.js";

/*
 * A design system's stylesheet text as the live renderer composes it (render/live/assets.ts): the
 * cascade layer order an `@import ... layer()` and the `@layer` statements around it set, and the
 * relative addresses resolved against the sheet's own address wherever CSS names one, and nowhere
 * else.
 */

let served: Record<string, string> = {};

beforeEach(() => {
  resetAssetCaches();
  served = {};
  vi.stubGlobal("fetch", async (url: string) => {
    await Promise.resolve();
    const body = served[url];
    return body === undefined ? { ok: false, status: 404, text: async () => "" } : { ok: true, status: 200, text: async () => body };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
  document.body.replaceChildren();
});

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

const headsOf = (sheet: CSSStyleSheet | undefined): string[] => Array.from(sheet?.cssRules ?? [], (rule) => rule.cssText.split("{")[0]?.trim() ?? "");

describe("live assets: layer statements keep their place among the imports", () => {
  it("puts an imported layer ahead of a layer statement that follows the import", async () => {
    served = {
      "https://cdn.example/ds/main.css": "@import url(a.css) layer(a);\n@layer b;\n@layer b { .x{color:blue} }",
      "https://cdn.example/ds/a.css": ".x{color:red}"
    };
    const adopted = await adoptInto(withAdoptedSheets(shadowRoot()), { stylesheets: [{ url: "https://cdn.example/ds/main.css" }] }, { bindingId: "ds" });
    // Layer a is named first, as the import named it: b, declared after, wins over it.
    expect(headsOf(adopted.sheets[0])).toEqual(["@layer a", "@layer b;", "@layer b"]);
    adopted.release();
  });

  it("keeps a layer statement written before the imports ahead of them", async () => {
    served = {
      "https://cdn.example/ds/main.css": "@layer reset, base;\n@import url(r.css) layer(reset);\n@layer theme;\n.y{}",
      "https://cdn.example/ds/r.css": ".x{color:red}"
    };
    const adopted = await adoptInto(withAdoptedSheets(shadowRoot()), { stylesheets: [{ url: "https://cdn.example/ds/main.css" }] }, { bindingId: "ds" });
    expect(headsOf(adopted.sheets[0])).toEqual(["@layer reset, base;", "@layer reset", "@layer theme;", ".y"]);
    adopted.release();
  });
});

describe("live assets: relative addresses resolved where CSS names an address", () => {
  const base = "https://cdn.example/ds/css/theme.css";

  it("leaves a url() written inside a string or a comment as it is", () => {
    const text = 'a{content:"see url(x.png)"} b{content:\'url(y.png)\'} /* url(z.png) */ c{}';
    expect(resolveUrls(text, base)).toBe(text);
  });

  it("resolves url() in any case, as CSS reads it", () => {
    expect(resolveUrls("a{background:URL(img.png)} b{background:Url( 'img.png' )}", base)).toBe(
      "a{background:url(https://cdn.example/ds/css/img.png)} b{background:url('https://cdn.example/ds/css/img.png')}"
    );
  });

  it("resolves the strings of image-set(), and the url()s in it", () => {
    expect(resolveUrls('a{background-image:image-set("a.png" 1x, "a@2x.png" 2x)}', base)).toBe(
      'a{background-image:image-set("https://cdn.example/ds/css/a.png" 1x, "https://cdn.example/ds/css/a@2x.png" 2x)}'
    );
    expect(resolveUrls("a{background-image:-webkit-image-set(url(b.png) 1x, 'c.png' 2x)}", base)).toBe(
      "a{background-image:-webkit-image-set(url(https://cdn.example/ds/css/b.png) 1x, 'https://cdn.example/ds/css/c.png' 2x)}"
    );
    // A string outside image-set() is no address.
    expect(resolveUrls('a{font-family:"a.png"}', base)).toBe('a{font-family:"a.png"}');
  });

  it("lifts @font-face rules with absolute addresses, since the document's font sheet has no base", async () => {
    const { faces } = shadowSheet("@font-face{font-family:X;src:url(../fonts/x.woff2)} .x{}", document, {}, base);
    expect(faces).toHaveLength(1);
    expect(faces[0]).toContain("https://cdn.example/ds/fonts/x.woff2");
    expect(faces[0]).not.toMatch(/url\(["']?\.\./);

    const doc = withAdoptedSheets(document);
    served = { "https://cdn.example/ds/css/theme.css": "@font-face{font-family:Y;src:URL(../fonts/y.woff2) format(\"woff2\")} .x{font-family:Y}" };
    const adopted = await adoptInto(withAdoptedSheets(shadowRoot()), { stylesheets: [{ url: base }] }, { bindingId: "ds" });
    await vi.waitFor(() => expect(doc.adoptedStyleSheets[0]?.cssRules).toHaveLength(1));
    expect(doc.adoptedStyleSheets[0]?.cssRules[0]?.cssText).toContain("https://cdn.example/ds/fonts/y.woff2");
    adopted.release();
  });
});
