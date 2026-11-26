import { describe, expect, it } from "vitest";

import {
  parseCssRules,
  parseDeclarations,
  splitSelectorList,
  stripComments,
  styleRules
} from "../form-engine/render/core/css-rules.js";

describe("parseCssRules", () => {
  it("reads style rules with their selectors, raw bodies and declarations", () => {
    const rules = parseCssRules(`.a, .b > .c { color: red; margin: 0 4px }\n.d{padding:0}`);
    expect(rules).toHaveLength(2);
    const first = rules[0]!;
    expect(first.type).toBe("style");
    if (first.type === "style") {
      expect(first.selectorText).toBe(".a, .b > .c");
      expect(first.selectors).toEqual([".a", ".b > .c"]);
      expect(first.body).toBe(" color: red; margin: 0 4px ");
      expect(first.declarations).toEqual([
        { property: "color", value: "red" },
        { property: "margin", value: "0 4px" }
      ]);
    }
  });

  it("keeps a comma inside :is() / :where() / :has() as one selector", () => {
    const [rule] = parseCssRules(`.datum-form :is(.a, .b), .datum-form :has(> .c, > .d) { gap: 0 }`);
    expect(rule?.type).toBe("style");
    if (rule?.type === "style") {
      expect(rule.selectors).toEqual([".datum-form :is(.a, .b)", ".datum-form :has(> .c, > .d)"]);
    }
  });

  it("opens grouping at-rules and nests them, keeping the header as written", () => {
    const rules = parseCssRules(
      `@media (min-width: 40em) { .x { a: 1 } @supports (display: grid) { .y { b: 2 } } } .z { c: 3 }`
    );
    expect(rules.map((rule) => rule.type)).toEqual(["at", "style"]);
    const media = rules[0]!;
    if (media.type === "at") {
      expect(media.name).toBe("media");
      expect(media.prelude).toBe("(min-width: 40em)");
      expect(media.header).toBe("@media (min-width: 40em) {");
      expect(media.rules?.map((rule) => (rule.type === "style" ? rule.selectorText : rule.name))).toEqual([".x", "supports"]);
    }
    expect(styleRules(rules).map((rule) => rule.selectorText)).toEqual([".x", ".y", ".z"]);
  });

  it("keeps @charset and @import statements, and leaves @keyframes / @font-face opaque", () => {
    const rules = parseCssRules(
      `@charset "utf-8"; @import url("a.css"); @keyframes spin { from { r: 0 } to { r: 1 } } @font-face { font-family: X; src: url("x.woff2") } :root { --a: 1 }`
    );
    expect(rules.map((rule) => (rule.type === "at" ? rule.name : rule.selectorText))).toEqual([
      "charset",
      "import",
      "keyframes",
      "font-face",
      ":root"
    ]);
    const keyframes = rules[2]!;
    if (keyframes.type === "at") {
      expect(keyframes.rules).toBeUndefined();
      expect(keyframes.body).toBe(" from { r: 0 } to { r: 1 } ");
      expect(keyframes.prelude).toBe("spin");
    }
    // The statement is not mistaken for the first rule's selector.
    expect(styleRules(rules).map((rule) => rule.selectorText)).toEqual([":root"]);
  });

  it("ignores braces, semicolons and commas inside strings and comments", () => {
    const rules = parseCssRules(
      `/* .commented { } */ .icon { background: url("a}b;c.png"); content: "x, y"; } .after { z: 1 }`
    );
    expect(styleRules(rules).map((rule) => rule.selectorText)).toEqual([".icon", ".after"]);
    const icon = styleRules(rules)[0]!;
    expect(icon.declarations).toEqual([
      { property: "background", value: 'url("a}b;c.png")' },
      { property: "content", value: '"x, y"' }
    ]);
  });

  it("never throws on unbalanced input", () => {
    expect(styleRules(parseCssRules(".a { color: red")).map((rule) => rule.selectorText)).toEqual([".a"]);
    expect(parseCssRules("} .b { x: 1 }").length).toBe(1);
    expect(parseCssRules("")).toEqual([]);
    expect(parseCssRules("   /* only a comment */  ")).toEqual([]);
  });
});

describe("the parser's helpers", () => {
  it("splits a selector list outside parentheses only", () => {
    expect(splitSelectorList(":is(a, b), c , d")).toEqual([":is(a, b)", "c", "d"]);
    expect(splitSelectorList("")).toEqual([]);
  });

  it("splits declarations outside parentheses and strings", () => {
    expect(parseDeclarations(`a: rgb(1, 2, 3); b: "x;y"; c: var(--x, 1px)`)).toEqual([
      { property: "a", value: "rgb(1, 2, 3)" },
      { property: "b", value: '"x;y"' },
      { property: "c", value: "var(--x, 1px)" }
    ]);
  });

  it("strips comments but not strings that look like them", () => {
    expect(stripComments(`a /* b */ c "/* not */"`)).toBe(`a  c "/* not */"`);
  });
});
