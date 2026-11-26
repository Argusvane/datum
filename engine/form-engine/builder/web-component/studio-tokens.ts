/**
 * The builder's design tokens: the "studio" look, light. The one list every `--db-*`
 * default is printed from — the shell's `:host` (wrapperStyles) and every panel's `:host`
 * (builderTokens) — so the two can no longer drift apart.
 *
 * Tiers:
 * - `public`: the documented contract a host, or a host-registered builder theme, may
 *   set and rely on across versions. A test pins the list.
 * - `theme`: every other colour, type, radius and elevation value. A host theme may set them,
 *   but they can change between versions.
 * Every read uses the names below (--db-panel, --db-muted, --db-border, …).
 *
 * The layout values (bar height, rail and drawer widths, gaps) are the shell's own and stay in its
 * stylesheet: a theme must not set them.
 *
 * Contrast (light): every surface step is at least 1.15:1, card outlines at least 2:1 against the
 * card and the backdrop, input borders 3:1, dividers 1.5:1 — floors an HDR display's tone mapping
 * cannot flatten — and text 4.5:1 (WCAG 2.2 AA). `tests/builder-default-tokens.test.ts` holds the dark
 * palette to these floors and the light accent and its ink to 4.5:1.
 */

export type StudioTokenTier = "public" | "theme";

export interface StudioToken {
  /** The custom property, without its leading dashes: `db-accent`. */
  name: string;
  value: string;
  tier: StudioTokenTier;
  group: "colour" | "type" | "space" | "radius" | "elevation" | "layer" | "motion" | "size";
  what: string;
}

const token = (name: string, value: string, tier: StudioTokenTier, group: StudioToken["group"], what: string): StudioToken => ({ name, value, tier, group, what });

export const STUDIO_TOKENS: readonly StudioToken[] = [
  // --- Colour -------------------------------------------------------------------------------------
  token("db-backdrop", "#edeff2", "theme", "colour", "The page behind the cards (surface 1.15:1): decorative, so it holds no contrast floor; board A's soft grey"),
  token("db-backdrop-dot", "#d2d6dc", "theme", "colour", "The backdrop's dot grid (decorative)"),
  token("db-surface", "#ffffff", "theme", "colour", "Cards, bar pills, drawers, controls"),
  token("db-surface-sunken", "#eceef1", "theme", "colour", "Wells: chips, code, read-only boxes (surface 1.16:1)"),
  token("db-surface-hover", "#e4e7eb", "theme", "colour", "Hover on any control (surface 1.24:1)"),
  token("db-ink", "#16171a", "theme", "colour", "Text (surface 17.9:1)"),
  token("db-ink-muted", "#4e525b", "theme", "colour", "Secondary text and icons (surface 7.8:1, backdrop 6.8:1)"),
  token("db-ink-subtle", "#5f646d", "theme", "colour", "Placeholders and hints (surface 6.0:1)"),
  token("db-line-card", "#9aa2ad", "theme", "colour", "Card and pill outlines (surface 2.58:1, backdrop 2.24:1)"),
  token("db-line-input", "#7b828c", "theme", "colour", "Input and control borders (surface 3.88:1)"),
  token("db-line-divider", "#c8cdd4", "theme", "colour", "Dividers inside a card (surface 1.60:1)"),
  token("db-accent", "#2f4bd6", "public", "colour", "Primary fills, links, the drop indicator (surface 6.78:1)"),
  token("db-accent-hover", "#2540c2", "public", "colour", "The accent fill hovered or pressed"),
  token("db-accent-ink", "#ffffff", "public", "colour", "Text and icons on the accent (6.78:1)"),
  token("db-accent-text", "#2a44c4", "public", "colour", "The accent as text (surface 7.7:1)"),
  token("db-accent-soft", "#e1e7fb", "public", "colour", "Selected rows, the type badge (surface 1.23:1)"),
  token("db-selected", "#16171a", "theme", "colour", "The current workspace, tab or segment; the selection bar"),
  token("db-selected-ink", "#ffffff", "theme", "colour", "Text and icons on --db-selected"),
  token("db-focus", "#2f4bd6", "theme", "colour", "The focus ring, drawn 2px outside on the light surface"),
  token("db-focus-on-dark", "#9db0ff", "theme", "colour", "The focus ring inside a dark part (on selected 8.6:1)"),
  token("db-danger", "#b42318", "theme", "colour", "Errors and Delete (surface 6.6:1)"),
  token("db-danger-soft", "#fce9e7", "theme", "colour", "The error wash (surface 1.17:1)"),
  token("db-danger-line", "#d9776d", "theme", "colour", "The error border (surface 3.08:1)"),
  token("db-warn", "#8a4b00", "theme", "colour", "Warnings and Not applied (surface 6.8:1)"),
  token("db-warn-soft", "#fae9cf", "theme", "colour", "The warning wash (surface 1.19:1)"),
  token("db-warn-line", "#b47a1e", "theme", "colour", "The warning border (surface 3.66:1)"),
  token("db-ok", "#1e6b3a", "theme", "colour", "Ready and passed (surface 6.5:1)"),
  token("db-ok-soft", "#e0f1e5", "theme", "colour", "The ready wash (surface 1.17:1)"),
  token("db-ok-line", "#4c9868", "theme", "colour", "The ready border (surface 3.50:1)"),
  token("db-scrim", "rgba(22, 23, 26, .42)", "theme", "colour", "Behind sheets and dialogs"),
  token("db-code-string", "#1b6f4a", "theme", "colour", "JSON strings (sunken 5.9:1)"),
  token("db-code-literal", "#7a3aa8", "theme", "colour", "JSON numbers, booleans, null (sunken 6.2:1)"),
  token("db-color-scheme", "light", "theme", "colour", "The css color-scheme of every builder root: what the native parts a stylesheet cannot reach (scrollbars, select popups, date pickers) follow; the dark look sets dark"),
  // --- Type ---------------------------------------------------------------------------------------
  token("db-font", '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif', "public", "type", "The builder's face; the system face until Geist is loaded"),
  token("db-font-mono", '"Geist Mono", ui-monospace, Menlo, monospace', "public", "type", "Keys and code"),
  token("db-text-xs", "11px", "theme", "type", "The smallest text the builder draws"),
  token("db-text-sm", "12px", "theme", "type", "Labels, captions"),
  token("db-text-md", "13px", "theme", "type", "Body text in panels"),
  token("db-text-base", "14px", "theme", "type", "Controls, the bar"),
  token("db-text-lg", "16px", "theme", "type", "Card titles"),
  token("db-text-xl", "18px", "theme", "type", "Workspace titles"),
  token("db-text-2xl", "22px", "theme", "type", "Empty-state headings"),
  // --- Space, radius, elevation, layers, motion, size --------------------------------------------
  token("db-space-half", "2px", "theme", "space", "The hairline step"),
  token("db-space-1", "4px", "theme", "space", "4px steps: 1 to 10"),
  token("db-space-2", "8px", "theme", "space", ""),
  token("db-space-3", "12px", "theme", "space", ""),
  token("db-space-4", "16px", "theme", "space", ""),
  token("db-space-5", "20px", "theme", "space", ""),
  token("db-space-6", "24px", "theme", "space", ""),
  token("db-space-8", "32px", "theme", "space", ""),
  token("db-space-10", "40px", "theme", "space", ""),
  token("db-border-w", "1px", "theme", "size", "Every line's width"),
  token("db-radius-xs", "6px", "theme", "radius", "Small chips"),
  token("db-radius-sm", "8px", "theme", "radius", "Buttons in lists"),
  token("db-radius-md", "10px", "theme", "radius", "Inputs"),
  token("db-radius-lg", "14px", "theme", "radius", "The canvas sheet"),
  token("db-radius-xl", "18px", "theme", "radius", "Cards and drawers"),
  token("db-radius-pill", "999px", "theme", "radius", "Pills"),
  token("db-shadow-pill", "0 10px 24px -16px rgb(22 23 26 / .28)", "theme", "elevation", "Bar pills"),
  token("db-shadow-card", "0 18px 40px -28px rgb(22 23 26 / .35)", "theme", "elevation", "Cards and the rail"),
  token("db-shadow-sheet", "0 30px 60px -40px rgb(22 23 26 / .45)", "theme", "elevation", "The canvas sheet"),
  token("db-shadow-drawer", "0 -20px 40px -20px rgb(22 23 26 / .45)", "theme", "elevation", "A bottom sheet and its handle on the phone tier, and the Logic and Data surfaces' sheets"),
  token("db-shadow-drawer-side", "24px 0 48px -20px rgb(22 23 26 / .45)", "theme", "elevation", "The phone menu drawer from the start edge"),
  token("db-shadow-overlay", "0 24px 48px -20px rgb(22 23 26 / .45)", "theme", "elevation", "Popovers, dialogs, drawers over the canvas"),
  token("db-z-canvas-ui", "10", "theme", "layer", "Selection bar, drop line"),
  token("db-z-chrome", "20", "theme", "layer", "Bar, rail"),
  token("db-z-drawer", "30", "theme", "layer", "Drawers over the canvas"),
  token("db-z-popover", "40", "theme", "layer", "Menus and popovers"),
  token("db-z-dialog", "50", "theme", "layer", "Dialogs"),
  token("db-motion-fast", "120ms", "theme", "motion", "Hover, press; 0ms under reduced motion"),
  token("db-motion-base", "180ms", "theme", "motion", "Drawers, menus; 0ms under reduced motion"),
  token("db-ease", "cubic-bezier(.2, 0, 0, 1)", "theme", "motion", ""),
  token("db-control-h", "var(--db-density-control-h, 40px)", "theme", "size", "A control's height: 40 comfortable, 34 compact (Short), 44 touch; the shell sets the density, which every panel inherits"),
  token("db-icon-size", "16px", "theme", "size", "The glyph size icons draw at"),
  token("db-icon-btn-w", "30px", "theme", "size", "The canvas toggles' box"),
  token("db-icon-btn-h", "28px", "theme", "size", "The canvas toggles' box (WCAG 2.5.8: at least 24px)"),
  token("db-editor-min", "300px", "theme", "size", "An editor column: minmax(min, max)"),
  token("db-editor-max", "360px", "theme", "size", ""),

];

/** The tokens of the public tier: what a host may set and rely on. */
export const PUBLIC_STUDIO_TOKENS: readonly string[] = STUDIO_TOKENS.filter((entry) => entry.tier === "public").map((entry) => entry.name);

/**
 * One token's light value: for the places that draw on a surface which stays light whatever the
 * builder's scheme (a PDF page's paper, a light form sheet), so the literal is read from the list
 * rather than typed again.
 */
export function studioLightValue(name: string): string {
  const entry = STUDIO_TOKENS.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`Unknown studio token: ${name}`);
  }
  return entry.value;
}

/** Every token as declarations for a `:host` rule, one per line, at `indent`. */
export function studioTokenDeclarations(indent = "      "): string {
  return STUDIO_TOKENS.map((entry) => `${indent}--${entry.name}: ${entry.value};`).join("\n");
}

/**
 * The rules every builder root carries with the tokens: no motion under `prefers-reduced-motion`,
 * and the forced-colours mapping — system colours for surfaces, text and lines,
 * no shadows, and the selection drawn as the system highlight.
 */
export function studioTokenRules(): string {
  return `
    :host { color-scheme: var(--db-color-scheme); }
    @media (prefers-reduced-motion: reduce) {
      :host { --db-motion-fast: 0ms; --db-motion-base: 0ms; }
    }
    @media (forced-colors: active) {
      /* Important, because a scheme or a host theme writes its tokens as inline custom properties on the host, which would otherwise beat this rule and put a palette back under forced colours. */
      :host {
        --db-backdrop: Canvas !important; --db-backdrop-dot: Canvas !important; --db-surface: Canvas !important; --db-surface-sunken: Canvas !important;
        --db-surface-hover: Canvas !important; --db-ink: CanvasText !important; --db-ink-muted: CanvasText !important; --db-ink-subtle: GrayText !important;
        --db-line-card: CanvasText !important; --db-line-input: CanvasText !important; --db-line-divider: CanvasText !important;
        --db-accent: Highlight !important; --db-accent-hover: Highlight !important; --db-accent-ink: HighlightText !important; --db-accent-text: LinkText !important;
        --db-accent-soft: Canvas !important; --db-selected: Highlight !important; --db-selected-ink: HighlightText !important;
        --db-focus: Highlight !important; --db-focus-on-dark: HighlightText !important;
        --db-danger: CanvasText !important; --db-danger-soft: Canvas !important; --db-danger-line: CanvasText !important;
        --db-warn: CanvasText !important; --db-warn-soft: Canvas !important; --db-warn-line: CanvasText !important;
        --db-ok: CanvasText !important; --db-ok-soft: Canvas !important; --db-ok-line: CanvasText !important;
        --db-shadow-pill: none !important; --db-shadow-card: none !important; --db-shadow-sheet: none !important; --db-shadow-drawer: none !important; --db-shadow-drawer-side: none !important; --db-shadow-overlay: none !important;
      }
    }`;
}

