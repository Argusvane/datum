import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildThemeStyleVars } from "../form-engine/render/core/token-style-vars.js";
import { BuilderThemeRegistry, type BuilderThemeDefinition } from "../form-engine/builder/web-component/builder-theme-registry.js";
import { DATUM_DARK_BUILDER_THEME, STUDIO_DARK_TOKENS } from "../form-engine/builder/web-component/studio-dark-theme.js";
import { PUBLIC_STUDIO_TOKENS, STUDIO_TOKENS, studioTokenDeclarations, studioTokenRules } from "../form-engine/builder/web-component/studio-tokens.js";

/** The builder's own styles: the panels' tokens and rules, the shell, the JSON viewer, the outline panel. */
const BUILDER_SOURCES = ["builder-shared.ts", "default-builder-element.ts", "json-viewer.ts", "builder-outline.ts", "builder-chrome-panel.ts", "builder-variables-panel.ts", "phone-styles.ts"].map((name) =>
  fileURLToPath(new URL(`../form-engine/builder/web-component/${name}`, import.meta.url))
);
/**
 * The workspace surfaces, the palette and the editors: each prints the token
 * defaults on its own host and reads --db-* all over its styles, so a read the studio list does not
 * declare would resolve to nothing there and go unseen. Every .ts file under these folders is
 * scanned, plus the Try it chunk.
 */
const SURFACE_FOLDERS = ["logic", "data", "overview", "languages", "palette", "form-tests", "formula"];
const SURFACE_SOURCES = [
  ...SURFACE_FOLDERS.flatMap((folder) => {
    const dir = fileURLToPath(new URL(`../form-engine/builder/${folder}/`, import.meta.url));
    return readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `${dir}${name}`);
  }),
  fileURLToPath(new URL("../form-engine/builder/web-component/try-it.ts", import.meta.url))
];
const PDF_MODE_SOURCE = fileURLToPath(new URL("../form-engine/builder/pdf-designer/pdf-builder-mode.ts", import.meta.url));
/** The Move to... dialog, a chunk of its own that brings its own few rules. */
const MOVE_UI_SOURCE = fileURLToPath(new URL("../form-engine/builder/drag-drop/move-ui.ts", import.meta.url));
/**
 * The Journeys mode's styles: its bar controls, the designer's popover, empty state
 * and preview, and the page cards on the canvas, which read the builder's tokens inside the
 * renderer's shadow.
 */
const JOURNEY_SOURCES = [
    ...["journey-builder-mode.ts", "journey-designer-panels.ts", "journey-preview.ts", "journey-authoring.ts"].map((name) =>
    fileURLToPath(new URL(`../form-engine/builder/journey-designer/${name}`, import.meta.url))
  ),
  // The journey flow map: its surface, bar and SVG, a chunk of its own.
  fileURLToPath(new URL("../form-engine/builder/journey-map/journey-map-styles.ts", import.meta.url))
];

/**
 * The shell's own layout values and the values the canvas and the shell exchange: set by
 * the shell or a host's layout, read by the panels, never a theme's to set, so not studio tokens.
 */
const SHELL_LAYOUT_VARS = new Set<string>(["db-gap", "db-strip-w", "db-side-w", "db-props-w", "db-shell-top", "db-sheet-w", "db-sheet-bg", "db-canvas-gap", "db-density-control-h",
  // The phone tier: the bottom bar's height, the safe area under it, a sheet's height, the drawer's width.
  "db-bottom-bar-h", "db-safe-bottom", "db-sheet-h", "db-drawer-w",
  // The shell's own box width in px: what the bar popovers size to, set by the width observer.
  "db-shell-w",
  // Where a modal dialog sits (modal-place.ts): the builder's box as insets from the window and a size, written on each dialog as it opens.
  "db-modal-inset", "db-modal-w", "db-modal-h",
  // A coarse pointer hides the panels' keyboard hints: the shell sets it on the wrap, the formula editor's footer reads it.
  "db-hint-display",
  // The bar's tool size (38px; 32 in the Short tier, 44 for a coarse pointer): the shell sets it on the bar, the bar's buttons and a host's leading controls read it.
  "db-bar-tool"]);

/** The flow map's picture text, drawn at the sizes its layout measures. */
const MAP_PICTURE_TEXT = /\.jm-(label__text|node__(number|title|meta|note)|more__text|stub__text|badge|terminal__text)\b/;

/** `text` without the rules that style only the flow map's picture text. */
function withoutMapPictureText(text: string): string {
  return text.replace(/([^{}]+)\{([^}]*)\}/g, (rule, selectors: string) =>
    selectors.split(",").every((selector) => MAP_PICTURE_TEXT.test(selector)) ? "" : rule
  );
}

/** WCAG 2.x relative luminance of a 6-digit hex colour. */
function luminance(hex: string): number {
  const channel = (index: number) => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

describe("a host-registered builder theme", () => {
  /** A look a host registers itself: the engine ships none, the seam stays. */
  const HOST_BUILDER_THEME: BuilderThemeDefinition = {
    id: "host-builder",
    version: "1.0.0",
    target: "builder",
    tokens: { "db-accent": "#3d8fe6", "db-border-w": "2px" }
  };

  it("registers and resolves in the builder theme registry, and writes its tokens as --db-* vars", () => {
    const registry = new BuilderThemeRegistry();
    registry.register(HOST_BUILDER_THEME);
    expect(registry.resolve("host-builder")).toEqual(HOST_BUILDER_THEME);

    const vars = buildThemeStyleVars(HOST_BUILDER_THEME);
    expect(vars["--db-accent"]).toBe("#3d8fe6");
    expect(vars["--db-border-w"]).toBe("2px");
  });
});

describe("the builder's geometry tokens", () => {
  const panelSource = readFileSync(BUILDER_SOURCES[0]!, "utf8");
  const wrapperSource = readFileSync(BUILDER_SOURCES[1]!, "utf8");

  /**
   * The studio tokens: one list both roots print, every value the
   * studio look needs, and nothing read that the list or the shell's layout does not declare.
   */
  it("prints one token list in the shell and every panel, and every --db-* the builder reads is declared", () => {
    for (const text of [panelSource, wrapperSource]) {
      expect(text).toContain("${studioTokenDeclarations()}");
      expect(text).toContain("${studioTokenRules()}");
    }
    const value = (name: string) => STUDIO_TOKENS.find((entry) => entry.name === name)?.value;
    expect(new Set(STUDIO_TOKENS.map((entry) => entry.name)).size).toBe(STUDIO_TOKENS.length);
    expect(value("db-border-w")).toBe("1px");
    expect(value("db-radius-pill")).toBe("999px");
    expect(value("db-font-mono")).toContain("ui-monospace");
    // Coverage: every var(--db-*) the builder's styles read is a studio token or
    // one of the shell's own layout values (never a theme's), so nothing resolves to nothing.
    const declared = new Set(STUDIO_TOKENS.map((entry) => entry.name));
    const read = new Set<string>();
    for (const path of [...BUILDER_SOURCES, PDF_MODE_SOURCE, ...JOURNEY_SOURCES, MOVE_UI_SOURCE, ...SURFACE_SOURCES]) {
      for (const match of readFileSync(path, "utf8").matchAll(/var\(--(db-[a-z0-9-]+)/g)) read.add(match[1]!);
    }
    const undeclared = [...read].filter((name) => !declared.has(name) && !SHELL_LAYOUT_VARS.has(name)).sort();
    expect(undeclared).toEqual([]);
    // The public tier is the documented contract: a host's Save reads two of these.
    expect(PUBLIC_STUDIO_TOKENS).toEqual(["db-accent", "db-accent-hover", "db-accent-ink", "db-accent-text", "db-accent-soft", "db-font", "db-font-mono"]);
    // No builder text below the 11px floor.
    for (const entry of STUDIO_TOKENS.filter((candidate) => /^db-text-/.test(candidate.name) && /px$/.test(candidate.value))) {
      expect(parseInt(entry.value, 10), entry.name).toBeGreaterThanOrEqual(11);
    }
  });

  /**
   * The one border colour serves four jobs a design system draws differently (a panel's frame,
   * a control's outline, an input's border, a divider), so no chrome rule reads it directly; the scrollbar thumb and the dashed drop zone (feedback) are the exceptions. The
   * same for the headings' caps and tracking.
   */
  it("reads borders and headings through the detail tokens, not the base literals", () => {
    for (const text of [panelSource, wrapperSource, readFileSync(BUILDER_SOURCES[2]!, "utf8"), readFileSync(PDF_MODE_SOURCE, "utf8"), ...JOURNEY_SOURCES.map((path) => readFileSync(path, "utf8"))]) {
      expect(text).not.toMatch(/solid var\(--db-border[,)]/);
      expect(text).not.toMatch(/text-transform: uppercase;/);
      expect(text).not.toMatch(/letter-spacing: \.04em;/);
      // The type scale: no chrome text at a literal size a theme cannot move. The
      // flow map's picture is the exception: its layout measures its text at fixed
      // sizes (JOURNEY_MAP_METRICS), so its SVG text is drawn at them; its chrome is not.
      expect(withoutMapPictureText(text)).not.toMatch(/font-size: (9|10|11|12|13)px/);
    }
  });

  /** What a theme cannot reach, it cannot restyle: no rule paints a literal white on the accent. */
  it("paints text on the accent through --db-accent-ink, never a literal white", () => {
    for (const text of [panelSource, wrapperSource]) {
      expect(text).not.toMatch(/var\(--db-accent(?:, #0974cb)?\);[^\n]*color: #fff\b/);
      expect(text).not.toMatch(/color: #fff;[^\n]*background: var\(--db-accent\)/);
    }
  });

  /** The default look's pair clears the text floor too: its ink is on 12px labels as well. */
  it("declares an accent and ink that read at 4.5:1 in the default look", () => {
    const sixDigits = (hex: string) => (hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex);
    const text = studioTokenDeclarations();
    const accent = /--db-accent: (#[0-9a-f]{6});/.exec(text)?.[1];
    const ink = /--db-accent-ink: (#[0-9a-f]{3}|#[0-9a-f]{6});/.exec(text)?.[1];
    expect(accent).toBeDefined();
    expect(ink).toBeDefined();
    expect(contrast(sixDigits(ink!), accent!)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * What a theme cannot reach, it cannot restyle: a border width, a control corner or a code
   * face left as a literal would show through a square-cornered, thick-lined theme. Selection
   * outlines (2px solid, 1px dashed on the accent) are feedback, not chrome, and stay literal.
   */
  it("leaves no literal border width, control corner or mono stack in the builder's chrome", () => {
    for (const text of [panelSource, wrapperSource, readFileSync(BUILDER_SOURCES[2]!, "utf8"), readFileSync(PDF_MODE_SOURCE, "utf8"), ...JOURNEY_SOURCES.map((path) => readFileSync(path, "utf8"))]) {
      // Borders only: `outline: 1px dashed` is the hover feedback and stays.
      expect(text).not.toMatch(/border[A-Za-z-]*: "?1px (solid|dashed) var\(--db-/);
      expect(text).not.toMatch(/border-radius: [678]px/);
      expect(text).not.toMatch(/border-radius: 999px/);
      expect(text).not.toMatch(/font-family: ui-monospace/);
    }
  });
});

describe("the shell's size tiers", () => {
  /**
   * The tier blocks override base rules at equal weight, so they must come after them: placed
   * earlier, the Narrow menu never replaced the tabs and the Short bar kept its full-size buttons,
   * with no test in jsdom to notice (it applies no shadow CSS).
   */
  it("puts the container queries and the coarse-pointer rules after every base rule they override", () => {
    const wrapperSource = readFileSync(BUILDER_SOURCES[1]!, "utf8");
    const styles = wrapperSource.slice(wrapperSource.indexOf("function wrapperStyles"));
    const firstTier = Math.min(styles.indexOf("@container db-shell"), styles.indexOf("@media (pointer: coarse)"));
    expect(firstTier).toBeGreaterThan(0);
    for (const base of [".bar-btn {", ".strip-btn {", ".workspace-tabs {", ".workspace-tab {", ".workspace-menu {", ".document-face {", ".strip, .add-rail {"]) {
      const at = styles.indexOf(`    ${base}`);
      expect(at, base).toBeGreaterThan(0);
      expect(at, base).toBeLessThan(firstTier);
    }
  });
});

describe("the shell's drawn marks", () => {
  /**
   * Generated content is part of an element's accessible name unless it is empty: the document
   * label's caret is drawn with borders, so the label is read as the document's name and kind
   * alone.
   */
  it("draws the document label's caret with borders, no text", () => {
    const wrapperSource = readFileSync(BUILDER_SOURCES[1]!, "utf8");
    const rule = (selector: string): string => {
      const at = wrapperSource.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return wrapperSource.slice(at, wrapperSource.indexOf("}", at));
    };
    expect(rule("button.document-face::after")).toMatch(/content: "";[\s\S]*border-inline-end: 1\.5px solid currentColor/);
  });
});

describe("the studio look's dark palette", () => {
  const light = Object.fromEntries(STUDIO_TOKENS.map((entry) => [entry.name, entry.value]));
  const dark = STUDIO_DARK_TOKENS;
  const panelSource = readFileSync(BUILDER_SOURCES[0]!, "utf8");
  const wrapperSource = readFileSync(BUILDER_SOURCES[1]!, "utf8");

  it("redraws the colour and elevation tokens only, every one a studio token, and sets the colour scheme", () => {
    const declared = new Map(STUDIO_TOKENS.map((entry) => [entry.name, entry]));
    for (const name of Object.keys(dark)) {
      const entry = declared.get(name);
      expect(entry, name).toBeDefined();
      expect(["colour", "elevation"], name).toContain(entry!.group);
    }
    // Every colour the light look sets, the dark look sets too: no light value can show through.
    for (const entry of STUDIO_TOKENS.filter((candidate) => candidate.group === "colour" || candidate.group === "elevation")) {
      expect(dark[entry.name], entry.name).toBeDefined();
      expect(dark[entry.name], entry.name).not.toBe(light[entry.name]);
    }
    expect(light["db-color-scheme"]).toBe("light");
    expect(dark["db-color-scheme"]).toBe("dark");
    // Both roots print the rule that hands the token to the browser's native parts.
    expect(studioTokenRules()).toContain(":host { color-scheme: var(--db-color-scheme); }");
    for (const text of [panelSource, wrapperSource]) {
      expect(text).toContain("${studioTokenRules()}");
    }
  });

  it("is the datum-dark builder theme, registered and resolved in the builder theme registry", () => {
    expect(DATUM_DARK_BUILDER_THEME).toMatchObject({ id: "datum-dark", target: "builder", tokens: dark });
    const registry = new BuilderThemeRegistry();
    registry.register(DATUM_DARK_BUILDER_THEME);
    expect(registry.resolve("datum-dark")).toEqual(DATUM_DARK_BUILDER_THEME);
    expect(buildThemeStyleVars(DATUM_DARK_BUILDER_THEME)["--db-surface"]).toBe(dark["db-surface"]);
    expect(buildThemeStyleVars(DATUM_DARK_BUILDER_THEME)["--db-color-scheme"]).toBe("dark");
  });

  /** The light look's floors, measured on the dark surface and its neighbours. */
  it("clears the studio floors on the dark surface", () => {
    const surface = dark["db-surface"]!;
    const floor = (name: string, on: string, ratio: number) => expect(contrast(dark[name]!, on), `${name} on ${on}`).toBeGreaterThanOrEqual(ratio);
    // Surfaces a step apart an HDR display cannot flatten.
    for (const name of ["db-backdrop", "db-surface-sunken", "db-surface-hover", "db-accent-soft", "db-danger-soft", "db-warn-soft", "db-ok-soft"]) floor(name, surface, 1.15);
    // Lines: card outlines on the card and the backdrop, input lines, dividers.
    floor("db-line-card", surface, 2);
    floor("db-line-card", dark["db-backdrop"]!, 2);
    floor("db-line-input", surface, 3);
    floor("db-line-divider", surface, 1.5);
    for (const name of ["db-danger-line", "db-warn-line", "db-ok-line"]) floor(name, surface, 3);
    // Text on the surface, the wells and the backdrop.
    for (const name of ["db-ink", "db-ink-muted", "db-ink-subtle", "db-accent-text", "db-danger", "db-warn", "db-ok"]) floor(name, surface, 4.5);
    for (const name of ["db-ink", "db-ink-muted", "db-ink-subtle", "db-code-string", "db-code-literal"]) floor(name, dark["db-surface-sunken"]!, 4.5);
    floor("db-ink", dark["db-surface-hover"]!, 4.5);
    floor("db-ink-muted", dark["db-backdrop"]!, 4.5);
    // Fills and what sits on them.
    floor("db-accent", surface, 4.5);
    floor("db-accent-ink", dark["db-accent"]!, 4.5);
    floor("db-accent-ink", dark["db-accent-hover"]!, 4.5);
    floor("db-accent-text", dark["db-accent-soft"]!, 4.5);
    floor("db-selected-ink", dark["db-selected"]!, 4.5);
    floor("db-danger", dark["db-danger-soft"]!, 4.5);
    floor("db-warn", dark["db-warn-soft"]!, 4.5);
    floor("db-ok", dark["db-ok-soft"]!, 4.5);
    // Focus rings: on the surface, and the ring inside the (now light) selected pill.
    floor("db-focus", surface, 3);
    floor("db-focus-on-dark", dark["db-selected"]!, 3);
  });
});
