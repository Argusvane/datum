import { describe, expect, it } from "vitest";
import { compactCss, readsAsCss, stripCssLiterals } from "../scripts/strip-css-literals.js";

const run = (code: string): string => stripCssLiterals(code, "/repo/engine/form-engine/x.ts")?.code ?? code;

describe("strip-css-literals", () => {
  it("drops comments and collapses indentation in a CSS literal", () => {
    const code = [
      "export const STYLES = `",
      "  /*",
      "   * Why the panel is a column.",
      "   */",
      "  .panel { display: flex; } /* trailing */",
      "    .body {",
      "      overflow: auto;",
      "    }",
      "`;"
    ].join("\n");
    expect(run(code)).toBe("export const STYLES = `\n.panel { display: flex; }\n.body {\noverflow: auto;\n}\n`;");
  });

  it("leaves code that holds `/*` alone: accept lists, regular expressions, globs", () => {
    const code = [
      'const accept = "image/*";',
      "const glob = `src/**/*.ts`;",
      "const html = `<input type=\"file\" accept=\"image/*\"> /* not css */`;",
      "const re = /a\\/*b/;"
    ].join("\n");
    expect(run(code)).toBe(code);
  });

  it("keeps substitutions and the text next to them", () => {
    const code = "const css = (accent: string) => `\n  /* accent */\n  .a { color: ${accent}; }\n  .b { border: 1px solid ${accent}; }\n`;";
    expect(run(code)).toBe("const css = (accent: string) => `\n.a { color: ${accent}; }\n.b { border: 1px solid ${accent}; }\n`;");
  });

  it("never strips a comment that runs across a substitution", () => {
    const code = "const css = (x: string) => `\n  .a { color: red; } /* starts ${x} ends */\n`;";
    expect(run(code)).toBe("const css = (x: string) => `\n.a { color: red; } /* starts ${x} ends */\n`;");
  });

  it("leaves markup, script and plain text literals exactly as written", () => {
    const markup = "const m = `\n  <style>\n    /* c */\n    .a { color: red; }\n  </style>\n  <div>x</div>\n`;";
    const script = "const s = `\n  function f() {\n    /* c */\n    return { a: 1; };\n  }\n`;";
    const python = "const p = `\ndef handler(request):\n    /* c */\n    return {\"ok\": True}\n`;";
    const text = "const t = `Line one\n    Line two`;";
    for (const code of [markup, script, python, text]) expect(run(code)).toBe(code);
  });

  it("classifies by braces and declarations", () => {
    expect(readsAsCss([".a { color: red; }"])).toBe(true);
    expect(readsAsCss(["color: red;"])).toBe(false);
    expect(readsAsCss(["{ a }"])).toBe(false);
    expect(readsAsCss([":host { --db-x: 1px; }"])).toBe(true);
  });

  it("returns nothing for a module with no CSS literal, and maps what it changes", () => {
    expect(stripCssLiterals("export const a = 1;", "/x.ts")).toBeUndefined();
    const result = stripCssLiterals("const s = `\n  /* c */\n  .a { color: red; }\n`;", "/x.ts");
    expect(result?.literals).toBe(1);
    expect(result?.saved).toBeGreaterThan(0);
    expect(result?.map.mappings.length).toBeGreaterThan(0);
  });

  it("keeps a selector list's meaning when a line break becomes the only separator", () => {
    expect(compactCss(".a,\n    .b {\n      color: red;\n    }")).toBe(".a,\n.b {\ncolor: red;\n}");
  });
});
