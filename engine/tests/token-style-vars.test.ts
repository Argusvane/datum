import { describe, expect, it } from "vitest";

import { buildThemeStyleVars, responsiveTokensCss, themeStyleVarsToCssText } from "../form-engine/render/core/token-style-vars.js";

const theme = {
  responsiveTokens: [
    {
      media: "(min-width: 40.0625em)",
      tokens: { "spacing-field-gap": "30px", "--font-size-title": "2.25rem" }
    },
    { media: "(max-width: 40em)", tokens: { "font-size-label": "1.125rem" } }
  ]
};

describe("responsive tokens", () => {
  it("compiles each entry to an important redefinition of the tokens on the form root", () => {
    expect(responsiveTokensCss(theme)).toBe(
      [
        "@media (min-width: 40.0625em) { .datum-form { --spacing-field-gap: 30px !important; --font-size-title: 2.25rem !important; } }",
        "@media (max-width: 40em) { .datum-form { --font-size-label: 1.125rem !important; } }"
      ].join("\n")
    );
    expect(responsiveTokensCss({})).toBe("");
    expect(responsiveTokensCss(undefined)).toBe("");
  });

  it("drops what could break out of its block rather than emitting it broken", () => {
    expect(
      responsiveTokensCss({
        responsiveTokens: [
          { media: "(min-width: 1px) } body { color: red", tokens: { "color-text": "#000" } },
          { media: "   ", tokens: { "color-text": "#000" } },
          { media: "(min-width: 1px)", tokens: { "color-text": "#000; } body { color: red", "bad name!": "1px", "": "1px" } },
          { media: "(min-width: 2px)", tokens: { "color-text": "#111" } }
        ]
      })
    ).toBe("@media (min-width: 2px) { .datum-form { --color-text: #111 !important; } }");
  });

  it("drops a value or condition that would end the <style> element or fetch outside the form", () => {
    // The sheet is the text of a live <style>; a theme may have been loaded from data.
    const breakouts = [
      "red;}</style><script>window.x=1</script>",
      "red</style><img src=x onerror=1>",
      "red</STYLE>",
      "red<!--",
      "url(javascript:alert(1))",
      'url( "JavaScript:alert(1)" )',
      "url('vbscript:x')",
      "url(data:text/html,<script>1</script>)",
      "@import url(https://evil.example/x.css)",
      "red; @import 'x.css'"
    ];
    for (const value of breakouts) {
      const css = responsiveTokensCss({ responsiveTokens: [{ media: "(min-width: 1px)", tokens: { "color-x": value, ok: "blue" } }] });
      expect(css, value).toBe("@media (min-width: 1px) { .datum-form { --ok: blue !important; } }");
      const media = responsiveTokensCss({ responsiveTokens: [{ media: `(min-width: 1px)${value}`, tokens: { ok: "blue" } }] });
      expect(media, value).toBe("");
    }
    // An image data URI, a page-relative or https url stay usable: hosts draw marks with them.
    expect(
      responsiveTokensCss({
        responsiveTokens: [
          {
            media: "(min-width: 1px)",
            tokens: { mark: 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")', logo: "url(https://cdn.example/logo.png)", icon: "url(/icons/x.svg)" }
          }
        ]
      })
    ).toBe(
      '@media (min-width: 1px) { .datum-form { --mark: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E") !important; --logo: url(https://cdn.example/logo.png) !important; --icon: url(/icons/x.svg) !important; } }'
    );
  });

  it("compiles a container condition to a @container datum-form block on the root's children", () => {
    const css = responsiveTokensCss({
      responsiveTokens: [
        { container: "(width < 24em)", tokens: { "padding-message": "8px" } },
        { media: "(min-width: 40em)", tokens: { "font-size-title": "2rem" } },
        { container: "(width < 30em)", media: "(min-width: 1px)", tokens: { "spacing-field-gap": "4px" } },
        { tokens: { "spacing-field-gap": "4px" } }
      ]
    });
    expect(css).toBe(
      [
        "@container datum-form (width < 24em) { .datum-form > * { --padding-message: 8px !important; } }",
        "@media (min-width: 40em) { .datum-form { --font-size-title: 2rem !important; } }",
        "@container datum-form (width < 30em) { .datum-form > * { --spacing-field-gap: 4px !important; } }"
      ].join("\n")
    );
  });
});

describe("buildThemeStyleVars", () => {
  it("writes each token as a custom property, with or without its dashes", () => {
    expect(buildThemeStyleVars({ tokens: { "db-accent": "#3d8fe6", "--db-border-w": "2px" } })).toEqual({ "--db-accent": "#3d8fe6", "--db-border-w": "2px" });
    expect(buildThemeStyleVars({})).toEqual({});
    expect(themeStyleVarsToCssText({ "--a": "1", "--b": "2" })).toBe("--a: 1; --b: 2;");
  });

  it("drops values that break out of the declaration and names that are not custom properties", () => {
    const vars = buildThemeStyleVars({
      tokens: { "--ok": "#fff", "--bad": "red;background:url(javascript:1)", "--brace": "a}b", "--tag": "</style>", "a b": "1", "--n:x": "1" }
    });
    expect(vars).toEqual({ "--ok": "#fff" });
  });
});
