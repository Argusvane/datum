// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCssRules, styleRules } from "../form-engine/render/core/css-rules.js";
import { chromeFeature } from "../form-engine/render/live/chrome.js";
import { DATUM_CHOICE_CSS, DATUM_DARK_CSS, DATUM_DARK_TOKENS, DATUM_TOKENS } from "../form-engine/render/live/datum/default-tokens.js";
import { DATUM_STYLES, DATUM_DRAWN_CONTROLS, datumCss, datumFormClass, datumTokenRule } from "../form-engine/render/live/datum/css.js";
import { FORM_TOKEN_NAMES, FORM_TOKENS, formTokenFallback, formTokenNamesOfTier, formTokenSpec } from "../form-engine/render/live/datum/tokens.js";
import { createDatumChromeFiles } from "../form-engine/render/live/datum/chrome-files.js";
import { definitionOf, mounted, unmountAll } from "./live-datum-parts-kit.js";
import { hideConstructedSheets } from "./setup/constructed-sheets.js";

afterEach(unmountAll);

// The sheets are read back as the <style> text the renderer places where a root takes no constructed sheets.
let restoreSheets = (): void => undefined;
beforeEach(() => {
  restoreSheets = hideConstructedSheets();
});
afterEach(() => {
  restoreSheets();
});

/** Tokens the layout containers' own rules read (the grid's column minimum), which are not in this sheet. */
const READ_BY_LAYOUT: readonly string[] = ["layout-grid-column-min"];

interface ReadSite {
  name: string;
  /** `undefined` where the read has no fallback. */
  fallback: string | undefined;
  /** The read sits inside another token's fallback; its fallback is that chain's, not the token's own. */
  nested: boolean;
}

/** Every `var(--name, fallback)` in the sheet, parentheses balanced. */
function readSites(text: string): ReadSite[] {
  const out: ReadSite[] = [];
  const spans: Array<[number, number]> = [];
  let at = text.indexOf("var(--");
  while (at !== -1) {
    const rest = text.slice(at + 6);
    const nameEnd = rest.search(/[,)]/);
    const name = rest.slice(0, nameEnd);
    let end = at + 6 + nameEnd + 1;
    let fallback: string | undefined;
    if (rest[nameEnd] === ",") {
      let depth = 1;
      for (; end < text.length && depth > 0; end += 1) {
        if (text[end] === "(") depth += 1;
        else if (text[end] === ")") depth -= 1;
      }
      fallback = text.slice(at + 6 + nameEnd + 1, end - 1).trim();
    }
    const nested = spans.some(([start, stop]) => at > start && at < stop);
    spans.push([at, end]);
    if (!name.startsWith("datum-")) {
      out.push({ name, fallback, nested });
    }
    at = text.indexOf("var(--", at + 6);
  }
  return out;
}

describe("the Datum token manifest", () => {
  it("names exactly the tokens the sheet reads, both ways", () => {
    const read = [...new Set(readSites(DATUM_STYLES).map((site) => site.name))].sort();
    expect([...read, ...READ_BY_LAYOUT].sort()).toEqual([...FORM_TOKEN_NAMES]);
    expect(FORM_TOKEN_NAMES).toEqual([...FORM_TOKEN_NAMES].sort());
    expect(new Set(FORM_TOKEN_NAMES).size).toBe(FORM_TOKENS.length);
  });

  it("records, for every token, the fallback every direct read in the sheet uses", () => {
    // color-choice-mark is `auto` where it feeds accent-color and the accent where it fills a drawn mark.
    const perProperty = new Set(["color-choice-mark"]);
    const disagreements: string[] = [];
    for (const site of readSites(DATUM_STYLES)) {
      const spec = formTokenSpec(site.name);
      expect(spec, site.name).toBeDefined();
      if (!site.nested && site.fallback !== spec?.fallback && !perProperty.has(site.name)) {
        disagreements.push(`${site.name}: manifest ${JSON.stringify(spec?.fallback)}, sheet ${JSON.stringify(site.fallback)}`);
      }
    }
    expect(disagreements).toEqual([]);
    const direct = new Set(readSites(DATUM_STYLES).filter((site) => !site.nested).map((site) => site.name));
    for (const spec of FORM_TOKENS.filter((entry) => !READ_BY_LAYOUT.includes(entry.name))) {
      expect(direct.has(spec.name), spec.name).toBe(true);
    }
  });

  it("puts every token in a tier, and answers a name with or without its dashes", () => {
    for (const spec of FORM_TOKENS) {
      expect(["base", "derived", "geometry"], spec.name).toContain(spec.tier);
      expect(spec.what.length, spec.name).toBeGreaterThan(10);
    }
    expect(formTokenNamesOfTier("base").length).toBeGreaterThan(30);
    expect(formTokenFallback("--color-text")).toBe("#14212b");
    expect(formTokenFallback("color-text")).toBe("#14212b");
    expect(formTokenFallback("no-such-token")).toBeUndefined();
  });
});

describe("Datum's default tokens", () => {
  it("are the studio's light and dark sets, with the dark set owning the form's scheme and surface", () => {
    expect(DATUM_TOKENS["font-size"]).toBe("0.875rem");
    expect(DATUM_TOKENS["font-size-label"]).toBe("0.8125rem");
    expect(DATUM_TOKENS["control-max-width"]).toBe("min(75ch, 100%)");
    expect(DATUM_DARK_TOKENS["color-scheme"]).toBe("dark");
    expect(DATUM_DARK_TOKENS["color-surface"]).toBeDefined();
    expect(DATUM_CHOICE_CSS).toContain(".datum-form__control--checkbox");
    expect(DATUM_DARK_CSS.length).toBeGreaterThan(0);
    for (const rule of DATUM_DARK_CSS) {
      expect(rule).toContain(".datum-form--dark");
    }
  });

  it("set only tokens the manifest names", () => {
    for (const name of [...Object.keys(DATUM_TOKENS), ...Object.keys(DATUM_DARK_TOKENS)]) {
      expect(formTokenSpec(name), name).toBeDefined();
    }
  });

  it("set every base colour in the dark set, so no light fallback shows through", () => {
    const colours = FORM_TOKENS.filter((spec) => spec.tier === "base" && spec.group === "palette").map((spec) => spec.name);
    const set = new Set([...Object.keys(DATUM_TOKENS), ...Object.keys(DATUM_DARK_TOKENS)]);
    for (const name of colours) {
      expect(set.has(name), name).toBe(true);
    }
    // Nothing the dark set restates is the light set's value.
    for (const [name, value] of Object.entries(DATUM_DARK_TOKENS)) {
      if (name.startsWith("color-") && DATUM_TOKENS[name] !== undefined) {
        expect(value, name).not.toBe(DATUM_TOKENS[name]);
      }
    }
  });
});

describe("the Datum stylesheet", () => {
  const declarations = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const rule of styleRules(parseCssRules(text))) {
      for (const selector of rule.selectors) {
        for (const declaration of rule.declarations) {
          out.add(`${selector} | ${declaration.property}: ${declaration.value}`);
        }
      }
    }
    return out;
  };
  const selectorOf = (entry: string): string => entry.slice(0, entry.indexOf(" | "));

  it("is a sheet of many rules that parse, each a selector with declarations", () => {
    const sheet = declarations(DATUM_STYLES);
    expect(sheet.size).toBeGreaterThan(900);
    for (const entry of sheet) {
      expect(selectorOf(entry).length, entry).toBeGreaterThan(0);
    }
  });

  it("reads a field's state and the form's mode from the renderer's hooks", () => {
    expect(DATUM_STYLES).toContain(":where([data-invalid]) .datum-form__affix");
    expect(DATUM_STYLES).toContain(':where(.datum-form:not([data-mode="readonly"])) .datum-form__control--text:where(:disabled)');
    expect(DATUM_STYLES).toContain('.datum-form[data-mode="readonly"] .datum-form__control--text:disabled');
    expect(DATUM_STYLES).not.toContain("datum-form--readonly");
    expect(DATUM_STYLES).not.toContain("datum-form__field--invalid");
    expect(DATUM_STYLES).not.toContain("datum-form__fields");
  });

  it("styles the marks the renderer's modules find, next to the classes the old tooltip carried", () => {
    expect(DATUM_STYLES).toContain("[data-tooltip-mark]");
    expect(DATUM_STYLES).toContain("[data-tooltip-text]");
    expect(DATUM_STYLES).toContain(".datum-live-field[data-file-drag]");
    expect(DATUM_STYLES).toContain(".datum-live-notice");
  });

  it("is plain text a style element can hold: no template syntax, no closing tag", () => {
    expect(DATUM_STYLES).not.toContain("`");
    expect(DATUM_STYLES).not.toContain("${");
    expect(DATUM_STYLES.toLowerCase()).not.toContain("</style");
  });
});

describe("datumCss and datumFormClass", () => {
  it("sets the light tokens on the form, the dark set under its dark class, then the choice rule", () => {
    const css = datumCss();
    expect(css.startsWith(DATUM_STYLES)).toBe(true);
    expect(css).toContain(".datum-form { --color-text: #16171a;");
    expect(css).toContain(".datum-form.datum-form--dark { --color-scheme: dark;");
    expect(css.indexOf(".datum-form.datum-form--dark {")).toBeGreaterThan(css.indexOf(".datum-form { --color-text"));
    expect(css).toContain(DATUM_CHOICE_CSS);
    for (const rule of DATUM_DARK_CSS) {
      expect(css).toContain(rule);
    }
  });

  it("takes a host's tokens over the studio's, a dark set, responsive tokens and rules after all of them", () => {
    const css = datumCss({
      tokens: { "color-accent": "#123456", "acme-private": "1px" },
      dark: { "color-accent": "#abcdef" },
      responsiveTokens: [{ media: "(max-width: 600px)", tokens: { "spacing-field-gap": "8px" } }],
      css: [".datum-form__title { text-transform: uppercase; }"]
    });
    expect(css).toContain("--color-accent: #123456;");
    expect(css).toContain("--acme-private: 1px;");
    expect(css).not.toContain("--color-accent: #2f4bd6;");
    expect(css).toContain("--color-accent: #abcdef;");
    expect(css).toContain("@media (max-width: 600px) { .datum-form { --spacing-field-gap: 8px !important; } }");
    expect(css.trimEnd().endsWith(".datum-form__title { text-transform: uppercase; }")).toBe(true);
  });

  it("drops a token whose name or value would break out of its declaration", () => {
    const rule = datumTokenRule(".datum-form", {
      "color-text": "red; } body { display: none",
      "color-muted": "url(javascript:alert(1))",
      "bad name": "1px",
      "color-border": "</style><script>",
      "color-light": "#eee"
    });
    expect(rule).toBe(".datum-form { --color-light: #eee; }");
    expect(datumTokenRule(".datum-form", {})).toBe("");
  });

  it("names the form's classes: the dark palette's and one per drawn control", () => {
    expect(datumFormClass({ colorScheme: "light" })).toBe("datum-form datum-form--error-icon-drawn");
    expect(datumFormClass({ colorScheme: "dark" })).toBe("datum-form datum-form--dark datum-form--error-icon-drawn");
    expect(datumFormClass({ colorScheme: "light" }, { choiceMarks: "drawn", selectChevron: "drawn", errorIcon: "native" }, "extra")).toBe(
      "datum-form datum-form--choice-marks-drawn datum-form--select-chevron-drawn extra"
    );
    expect(DATUM_DRAWN_CONTROLS).toEqual({ choiceMarks: "native", selectChevron: "native", errorIcon: "drawn" });
  });
});

describe("the renderer adopts the Datum sheet", () => {
  const def = definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }], {}, { chrome: { frame: "paper" } });

  const sheets = (root: ShadowRoot): string => Array.from(root.querySelectorAll("style[data-datum-live]")).map((style) => style.textContent ?? "").join("\n");

  it("as the binding's css, with the form element wearing the Datum classes", async () => {
    const m = await mounted(def, { features: [chromeFeature()] });
    expect(sheets(m.root)).toContain(datumCss());
    const form = m.root.querySelector("form") as HTMLFormElement;
    expect(form.className).toBe("datum-live datum-form datum-form--error-icon-drawn datum-form--frame-paper");
    expect(form.getAttribute("data-mode")).toBe("interactive");
    expect(sheets(m.root)).toContain(".datum-form--frame-paper {");
  });

  it("follows the colour scheme the host mounts under, and the host's token choices", async () => {
    const dark = await mounted(def, { colorScheme: "dark" });
    expect((dark.root.querySelector("form") as HTMLElement).classList.contains("datum-form--dark")).toBe(true);
    unmountAll();
    const themed = await mounted(def, { parts: { css: { tokens: { "color-accent": "#123456" } } } });
    expect(sheets(themed.root)).toContain(".datum-form { --color-text: #16171a;");
    expect(sheets(themed.root)).toContain("--color-accent: #123456;");
  });

  it("marks a read-only form for the sheet's review rules, and removes its sheet on unmount", async () => {
    const m = await mounted(def, { mode: "readonly" });
    expect((m.root.querySelector("form") as HTMLElement).getAttribute("data-mode")).toBe("readonly");
    const { root } = m;
    m.form.unmount();
    expect(root.querySelector("style[data-datum-live]")).toBeNull();
  });

  it("is the slice of the binding createDatumChromeFiles makes", () => {
    const parts = createDatumChromeFiles({ css: { tokens: { "color-accent": "#123456" } }, drawn: { choiceMarks: "drawn" } });
    expect(parts.css).toContain("--color-accent: #123456;");
    expect(parts.formClass({ colorScheme: "light", locale: "en" })).toBe("datum-form datum-form--choice-marks-drawn datum-form--error-icon-drawn");
  });
});
