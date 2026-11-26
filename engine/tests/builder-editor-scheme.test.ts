// @vitest-environment jsdom
/**
 * The three CodeMirror editors carry the builder's palette in their own
 * EditorView.theme(), because CodeMirror's built-in light theme (a pale tooltip, a black caret,
 * a pale gutter) is an adopted sheet the shadow root applies after the host's <style> at equal
 * specificity, so a rule in the host's sheet loses. jsdom applies no CSS, so the check reads the
 * rules CodeMirror mounts and asks that the colours it must not leave to its light theme are
 * written there as --db-* reads.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { FORMULA_FUNCTION_ROWS, FORMULA_SNIPPETS } from "../form-engine/builder/formula/feel-functions.js";
import { mountFormulaEditor } from "../form-engine/builder/formula/formula-editor.js";
import { mountTestsEditor } from "../form-engine/builder/form-tests/tests-editor.js";
import { mountJsonViewer } from "../form-engine/builder/web-component/json-viewer.js";
import { CANVAS_CHROME_STYLES } from "../form-engine/builder/web-component/builder-shared.js";
import { PDF_DESIGNER_PANEL_STYLES } from "../form-engine/builder/pdf-designer/pdf-panel-styles.js";
import { STUDIO_DARK_TOKENS } from "../form-engine/builder/web-component/studio-dark-theme.js";
import { studioLightValue, studioTokenRules } from "../form-engine/builder/web-component/studio-tokens.js";

/** Every rule CodeMirror and style-mod have put into the document so far, as one text. */
function mountedCss(): string {
  const parts: string[] = [];
  for (const style of document.querySelectorAll("style")) {
    parts.push(style.textContent ?? "");
  }
  for (const sheet of (document as unknown as { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []) {
    for (const rule of sheet.cssRules) {
      parts.push(rule.cssText);
    }
  }
  return parts.join("\n");
}

/**
 * The declarations of the rules whose selector ends in `selector` and starts with one of the
 * `scopes` (the generated theme classes of one editor). style-mod puts every editor's rules into
 * one <style> in the document, so an unscoped match would pass on a sibling editor's rules.
 */
function declarationsOf(css: string, selector: string, scopes: readonly string[]): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`([^{}]*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s*\\{([^}]*)\\}`, "g");
  for (const match of css.matchAll(pattern)) {
    const scoped = (match[1] ?? "").split(",").some((part) => {
      const trimmed = part.trim();
      return trimmed.endsWith(selector) && scopes.some((scope) => trimmed === scope || trimmed.startsWith(`${scope} `) || trimmed.startsWith(`${scope}.`));
    });
    if (scoped) {
      found.push(match[2] ?? "");
    }
  }
  return found;
}

/** One editor's own scoping classes: the generated ones on its `.cm-editor` (the \u037c names CodeMirror hands out). */
function scopesOf(editorHost: HTMLElement): string[] {
  const editor = editorHost.querySelector(".cm-editor");
  expect(editor, "the editor mounted").not.toBeNull();
  return [...editor!.classList].filter((name) => name.startsWith("\u037c")).map((name) => `.${name}`);
}

describe("the editors' palette lives in their own theme", () => {
  const hosts: HTMLElement[] = [];
  const destroyers: Array<() => void> = [];

  beforeAll(() => {
    const range = Range.prototype as unknown as Record<string, unknown>;
    for (const name of ["getClientRects", "getBoundingClientRect"]) {
      if (typeof range[name] !== "function") {
        range[name] = name === "getClientRects" ? () => [] : () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
      }
    }
  });

  afterEach(() => {
    for (const destroy of destroyers.splice(0)) {
      destroy();
    }
    for (const host of hosts.splice(0)) {
      host.remove();
    }
  });

  const host = (): HTMLElement => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    hosts.push(element);
    return element;
  };

  const themed = (scopes: readonly string[], selector: string, property: string, token: string): boolean =>
    declarationsOf(mountedCss(), selector, scopes).some((body) => new RegExp(`${property}\\s*:[^;]*var\\(--db-${token}`).test(body));

  it("the formula editor sets the tooltip, the caret and the cursor with builder tokens", () => {
    const where = host();
    const editor = mountFormulaEditor(where, {
      text: "",
      label: "When",
      fields: [],
      functions: [...FORMULA_FUNCTION_ROWS],
      signatures: formulaFunctionSignatures(),
      snippets: [...FORMULA_SNIPPETS],
      onChange: () => undefined,
      onCommit: () => undefined
    });
    destroyers.push(() => editor.destroy());
    const scopes = scopesOf(where);
    expect(scopes.length).toBeGreaterThan(0);
    expect(themed(scopes, ".cm-tooltip", "background-color", "surface")).toBe(true);
    expect(themed(scopes, ".cm-tooltip", "color", "ink")).toBe(true);
    expect(themed(scopes, ".cm-tooltip", "border", "line-card")).toBe(true);
    expect(themed(scopes, ".cm-content", "caret-color", "ink")).toBe(true);
    expect(themed(scopes, ".cm-dropCursor", "border-left-color", "ink")).toBe(true);
  });

  it("the Tests editor sets the tooltip, the caret, the cursor and the gutter with builder tokens", () => {
    const where = host();
    const editor = mountTestsEditor(where, {
      text: "",
      completions: { fields: () => [], pages: () => [], journeys: () => [], layouts: () => [], codes: () => [] },
      words: undefined,
      ariaLabel: "Tests",
      onChange: () => undefined
    });
    destroyers.push(() => editor.destroy());
    const scopes = scopesOf(where);
    expect(scopes.length).toBeGreaterThan(0);
    expect(themed(scopes, ".cm-tooltip", "background-color", "surface")).toBe(true);
    expect(themed(scopes, ".cm-tooltip", "color", "ink")).toBe(true);
    expect(themed(scopes, ".cm-content", "caret-color", "ink")).toBe(true);
    expect(themed(scopes, ".cm-dropCursor", "border-left-color", "ink")).toBe(true);
    expect(themed(scopes, ".cm-gutters", "background-color", "surface-sunken")).toBe(true);
    expect(themed(scopes, ".cm-gutters", "color", "ink-subtle")).toBe(true);
  });

  it("the JSON box sets the tooltip, the caret, the cursor and the gutter with builder tokens", () => {
    const where = host();
    const viewer = mountJsonViewer(where, "{}", { editable: true });
    destroyers.push(() => viewer.destroy());
    const scopes = scopesOf(where);
    expect(scopes.length).toBeGreaterThan(0);
    expect(themed(scopes, ".cm-tooltip", "background-color", "surface")).toBe(true);
    expect(themed(scopes, ".cm-tooltip", "color", "ink")).toBe(true);
    expect(themed(scopes, ".cm-content", "caret-color", "ink")).toBe(true);
    expect(themed(scopes, ".cm-dropCursor", "border-left-color", "ink")).toBe(true);
    expect(themed(scopes, ".cm-gutters", "background-color", "surface")).toBe(true);
  });
});

describe("the chrome drawn on a sheet or a paper page", () => {
  it("the canvas chrome redeclares its on-sheet tokens per sheet scheme, from the two palettes", () => {
    for (const [scheme, read] of [
      ["light", studioLightValue],
      ["dark", (name: string) => STUDIO_DARK_TOKENS[name]!]
    ] as const) {
      const start = CANVAS_CHROME_STYLES.indexOf(`:host([data-sheet-scheme="${scheme}"])`);
      expect(start).toBeGreaterThan(-1);
      const block = CANVAS_CHROME_STYLES.slice(start, CANVAS_CHROME_STYLES.indexOf("}", start));
      for (const name of ["db-accent", "db-accent-soft", "db-accent-text", "db-focus", "db-surface", "db-surface-sunken", "db-ink", "db-ink-muted", "db-line-input"]) {
        expect(block).toContain(`--${name}: ${read(name)};`);
      }
    }
    // Forced colours keep the host's system-colour mapping.
    expect(CANVAS_CHROME_STYLES).toContain("@media not (forced-colors: active)");
    expect(CANVAS_CHROME_STYLES).not.toContain("`");
  });

  it("the canvas panel writes data-sheet-scheme from the scheme the form is drawn in", () => {
    const source = readFileSync(resolve(process.cwd(), "form-engine/builder/web-component/builder-panels.ts"), "utf8");
    expect(source).toContain('setAttribute("data-sheet-scheme"');
    expect(source).toContain("controller.canvasColorScheme()");
  });

  it("a template page pins the light accent, its text and the focus ring (the paper is white)", () => {
    // In forced colours the system-colour mapping stays, so the pin sits in a media query.
    const media = PDF_DESIGNER_PANEL_STYLES.indexOf("@media not (forced-colors: active)");
    expect(media).toBeGreaterThan(-1);
    const start = PDF_DESIGNER_PANEL_STYLES.indexOf(".dpd-page {", media);
    expect(start - media).toBeLessThan(80);
    const block = PDF_DESIGNER_PANEL_STYLES.slice(start, PDF_DESIGNER_PANEL_STYLES.indexOf("}", start));
    for (const name of ["db-accent", "db-accent-text", "db-focus"]) {
      expect(block).toContain(`--${name}: ${studioLightValue(name)};`);
    }
    expect(block).toContain("--dpd-accent: var(--db-accent);");
  });

  it("the sheet and drawer shadows are tokens, deeper on a dark page, and no panel types the literal", () => {
    for (const name of ["db-shadow-drawer", "db-shadow-drawer-side"]) {
      expect(studioLightValue(name)).toContain("rgb(22 23 26");
      expect(STUDIO_DARK_TOKENS[name]).toContain("rgb(0 0 0");
    }
    for (const file of ["web-component/phone-styles.ts", "web-component/builder-panels.ts", "logic/logic-surface.ts", "data/data-surface.ts"]) {
      const source = readFileSync(resolve(process.cwd(), "form-engine/builder", file), "utf8");
      expect(source, file).not.toMatch(/box-shadow:[^;]*rgb\(22 23 26/);
    }
  });

  it("the forced-colors mapping is important, so an inline scheme or host theme cannot put a palette back", () => {
    const rules = studioTokenRules();
    const block = rules.slice(rules.indexOf("@media (forced-colors: active)"));
    const declarations = block.match(/--db-[a-z-]+: [A-Za-z]+( !important)?;/g) ?? [];
    expect(declarations.length).toBeGreaterThan(20);
    expect(declarations.every((declaration) => declaration.includes("!important"))).toBe(true);
  });
});
