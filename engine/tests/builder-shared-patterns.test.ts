import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CANVAS_PANEL_STYLES,
  CONFIRM_STYLES,
  PROPERTIES_STYLES,
  SHARED_CONTROL_STYLES,
  SHARED_PATTERN_STYLES,
  TIP_STYLES,
  builderTokens
} from "../form-engine/builder/web-component/builder-shared.js";
import { STUDIO_TOKENS } from "../form-engine/builder/web-component/studio-tokens.js";

const SHELL_SOURCE = readFileSync(fileURLToPath(new URL("../form-engine/builder/web-component/default-builder-element.ts", import.meta.url)), "utf8");
/** The shell's own stylesheet function, as written: it is not exported. */
const SHELL_STYLES = SHELL_SOURCE.slice(SHELL_SOURCE.indexOf("function wrapperStyles"), SHELL_SOURCE.indexOf("`;\n}", SHELL_SOURCE.indexOf("function wrapperStyles")));

/** How many times `needle` occurs in `text`. */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The selector lists of every rule in `css`, at-rules unwrapped and comments dropped. */
function selectors(css: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{/g, "");
  return [...bare.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((match) => match[1]!.trim()).filter((text) => text.length > 0);
}

describe("the shared patterns (builder UX unification)", () => {
  const panels = builderTokens();

  it("prints each shared constant once in every panel's stylesheet", () => {
    for (const block of [SHARED_CONTROL_STYLES, SHARED_PATTERN_STYLES, TIP_STYLES, CONFIRM_STYLES]) {
      expect(count(panels, block)).toBe(1);
    }
  });

  it("defines each pattern's class once", () => {
    const rules = [
      // The segmented control, the chosen segment in the strong fill.
      ".seg {",
      ".seg-btn, .seg > button {\n      display: inline-flex;",
      ':is(.seg-btn, .seg > button):is([aria-pressed="true"], [aria-selected="true"], [aria-checked="true"]) { background: var(--db-selected); color: var(--db-selected-ink); }',
      // A tool switched on: the pale accent.
      '.tool-toggle:is([aria-pressed="true"], [aria-expanded="true"]), .tool-toggle:is([aria-pressed="true"], [aria-expanded="true"]):hover:not(:disabled) { background: var(--db-accent-soft);',
      // Tick boxes and text boxes.
      ':where(input[type="checkbox"], input[type="radio"]) {',
      ':where(input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="color"]), select, textarea) {',
      // An option's caption (label.choice in a fieldset) is not a field label.
      ":where(.field) > :where(.field-label, label):where(:not(.choice)) { font-size: var(--db-text-md); font-weight: 500;",
      // The two empty states.
      ":where(.empty-state) {",
      ".empty-state.is-page {\n      max-inline-size: 560px;",
      // Card headings, links, notices.
      ":where(.card-title) { font-size: var(--db-text-lg); font-weight: 600; }",
      ":where(.card-heading) { font-size: var(--db-text-md); font-weight: 600; }",
      ":where(.card-lead) { font-size: var(--db-text-sm); color: var(--db-ink-muted); }",
      ":where(.link-btn) { color: var(--db-accent-text); }",
      ":where(.row-link) {",
      ":where(.note) {",
      ':where(.note[data-tone="warning"]) { border-color: var(--db-warn-line); background: var(--db-warn-soft); }',
      ':where(.note[data-tone="error"]) { border-color: var(--db-danger-line); background: var(--db-danger-soft); }',
      // Menus, chips, cards.
      ":where(.menu) {",
      ":where(.menu-item) {\n      display: flex;",
      ":where(.menu-item.danger) { color: var(--db-danger); }",
      ":where(.ref-chip) {",
      ":where(.try-chip) {",
      ":where(.card) {",
      ":where(.card-stack) {",
      // Tooltips, below by default, on three other sides on request.
      ":where([data-tip])::after {\n      content: attr(data-tip);",
      ':where([data-tip-side="top"])::after {',
      ':where([data-tip-side="start"])::after {',
      ':where([data-tip-side="end"])::after {'
    ];
    for (const rule of rules) {
      expect(count(panels, rule), rule).toBe(1);
    }
  });

  it("draws checkboxes at 24px in the strong fill, and every element rule at no specificity", () => {
    expect(SHARED_CONTROL_STYLES).toMatch(/:where\(input\[type="checkbox"\], input\[type="radio"\]\) \{\s+inline-size: 24px; block-size: 24px; flex: none; margin: 0; accent-color: var\(--db-selected\);/);
    // A box is 14px, a label 13px.
    expect(SHARED_CONTROL_STYLES).toContain("font-size: var(--db-text-base);");
    for (const selector of selectors(SHARED_CONTROL_STYLES)) {
      for (const part of selector.split(/,(?![^(]*\))/)) {
        expect(part.trim(), selector).toMatch(/^:where\(/);
      }
    }
    // A chosen segment or a switched-on tool keeps the focus ring in forced colours; a worded canvas tool outranks the square one.
    expect(SHARED_PATTERN_STYLES).toContain('[aria-checked="true"]):not(:focus-visible) { outline: 2px solid Highlight;');
    expect(TIP_STYLES).toContain("@media (hover: hover) { :where([data-tip]):hover::after");
    // No pattern selector names an id.
    for (const selector of selectors(SHARED_PATTERN_STYLES + TIP_STYLES)) {
      expect(selector).not.toContain("#");
    }
  });

  it("gives menus and popovers the 14px corner", () => {
    expect(STUDIO_TOKENS.find((entry) => entry.name === "db-radius-lg")?.value).toBe("14px");
    /** The corner of the rule for `selector` that draws one (a selector may have a layout-only rule too). */
    const corner = (css: string, selector: string): string | undefined => {
      for (let at = css.indexOf(`${selector} {`); at >= 0; at = css.indexOf(`${selector} {`, at + 1)) {
        const radius = /border-radius: (var\(--db-radius-[a-z]+\))/.exec(css.slice(at, css.indexOf("}", at)))?.[1];
        if (radius) return radius;
      }
      return undefined;
    };
    expect(corner(SHARED_PATTERN_STYLES, ":where(.menu)")).toBe("var(--db-radius-lg)");
    expect(corner(PROPERTIES_STYLES, ".rule-run-menu")).toBe("var(--db-radius-lg)");
    expect(corner(CANVAS_PANEL_STYLES, ".canvas-more-pop")).toBe("var(--db-radius-lg)");
  });

  it("draws the canvas's tooltips from the shared rules, the selection bar's above it", () => {
    expect(CANVAS_PANEL_STYLES).not.toContain("content: attr(data-tip)");
    expect(CANVAS_PANEL_STYLES).toContain(".selection-btn[data-tip]::after { top: auto; bottom: calc(100% + 10px); }");
    expect(TIP_STYLES).toContain(":where([data-tip]):focus-visible::after { opacity: 1;");
  });

  it("prints the class patterns and tooltips in the shell, and leaves its own boxes to its own rules", () => {
    for (const block of ["${SHARED_PATTERN_STYLES}", "${TIP_STYLES}", "${CONFIRM_STYLES}"]) {
      expect(count(SHELL_STYLES, block), block).toBe(1);
    }
    expect(SHELL_STYLES).not.toContain("${SHARED_CONTROL_STYLES}");
  });

  it("declares the editor column's bounds as size tokens", () => {
    const entry = (name: string) => STUDIO_TOKENS.find((candidate) => candidate.name === name);
    expect(entry("db-editor-min")).toMatchObject({ value: "300px", group: "size", tier: "theme" });
    expect(entry("db-editor-max")).toMatchObject({ value: "360px", group: "size", tier: "theme" });
  });
});
