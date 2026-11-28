import { describe, expect, it } from "vitest";

import { buildThemeStyleVars, responsiveTokensCss } from "../form-engine/render/core/token-style-vars.js";
import { DATUM_DARK_TOKENS, DATUM_TOKENS } from "../form-engine/render/live/datum/default-tokens.js";
import { datumCss } from "../form-engine/render/live/datum/css.js";

// Each of these leaves the CSS parser inside a function, a string, a comment or an escape, so
// it reads on into whatever rule follows (the dark set, the choice rules, the host's css).
const SWALLOWING = [
  "drop-shadow(0 0 2px",
  "var(--x",
  "calc(1px + (2px)",
  "a)",
  "[x",
  "x]",
  "(a]",
  '"x',
  "'x",
  "'x\\'",
  "red /*",
  "red */ blue",
  "/* note */ red",
  "red\\",
  "red \\\\\\"
];

describe("token values that would swallow the css after them", () => {
  it("drops a value with an unbalanced bracket, an open quote, a comment or a trailing escape", () => {
    for (const value of SWALLOWING) {
      expect(buildThemeStyleVars({ tokens: { bad: value, ok: "blue" } }), value).toEqual({ "--ok": "blue" });
      expect(
        responsiveTokensCss({ responsiveTokens: [{ media: "(min-width: 1px)", tokens: { bad: value, ok: "blue" } }] }),
        value
      ).toBe("@media (min-width: 1px) { .datum-form { --ok: blue !important; } }");
    }
  });

  it("drops a media or container condition that is unbalanced, open or escaped at its end", () => {
    for (const condition of ["(min-width: 1px", "(min-width: 1px))", "(min-width: 1px) /*", '(min-width: "1px)', "(min-width: 1px)\\"]) {
      expect(responsiveTokensCss({ responsiveTokens: [{ media: condition, tokens: { ok: "blue" } }] }), condition).toBe("");
      expect(responsiveTokensCss({ responsiveTokens: [{ container: condition, tokens: { ok: "blue" } }] }), condition).toBe("");
    }
  });

  it("keeps balanced values, escapes that escape something, and brackets inside a string", () => {
    const kept = {
      shadow: "drop-shadow(0 0 2px rgb(0 0 0 / 0.2))",
      font: '"Noto Sans", "Helvetica Neue", sans-serif',
      quoteParen: '"(" ")"',
      escaped: "\\(x\\)",
      area: "[full-start] minmax(1em, 1fr) [main-start]",
      calc: "calc(100% - var(--x, 2px))",
      mark: 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")'
    };
    const expected = Object.fromEntries(Object.entries(kept).map(([name, value]) => [`--${name}`, value]));
    expect(buildThemeStyleVars({ tokens: kept })).toEqual(expected);
  });

  it("keeps every default token of the Datum sheet", () => {
    expect(Object.keys(buildThemeStyleVars({ tokens: DATUM_TOKENS })).length).toBe(Object.keys(DATUM_TOKENS).length);
    expect(Object.keys(buildThemeStyleVars({ tokens: DATUM_DARK_TOKENS })).length).toBe(Object.keys(DATUM_DARK_TOKENS).length);
  });

  it("leaves the dark set and the host's rules intact behind a value that would have swallowed them", () => {
    const css = datumCss({ tokens: { "color-text": "red /*" }, dark: { "color-text": "#fff" }, css: [".host-rule { color: red }"] });
    expect(css).not.toContain("red /*");
    expect(css).toContain(".datum-form.datum-form--dark {");
    expect(css).toContain(".host-rule { color: red }");
  });
});
