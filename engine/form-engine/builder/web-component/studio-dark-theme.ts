import type { BuilderThemeDefinition } from "./builder-theme-registry.js";

/*
 * A module of its own, apart from the studio token list (studio-tokens.ts): the renderer bundle
 * registers the dark builder theme (themes.ts) and must not carry the light list with its
 * descriptions, which no form needs. The names here are studio token names; a test holds them
 * to the list.
 */
/**
 * The studio look's dark palette: the same tokens, every colour and elevation value
 * redrawn for a dark page, nothing else — type, space, radius, layers and motion are the light
 * look's. Drawn to the same floors as the light values, measured against the dark surface
 * (`#1e2127`) unless said otherwise: surfaces at least 1.15:1 apart (backdrop 1.17:1, sunken
 * 1.15:1, hover 1.18:1), card outlines 2:1 (2.01:1 on the surface, 2.37:1 on the backdrop), input
 * lines 3:1 (3.82:1), dividers 1.5:1 (1.55:1), text 4.5:1 (ink 13.4:1, muted 7.4:1, subtle 6.1:1),
 * the accent 6.5:1 as a fill under its dark ink (7.7:1) and 8.7:1 as text, the danger, warning
 * and ready colours 6.7:1 or better on the surface and 5.9:1 or better on their washes, their
 * lines 3.2:1 or better. The selection inverts: the light look's near-black pill becomes the ink
 * on the dark page, and the ring inside it is the light look's accent (5.7:1 on it).
 */
export const STUDIO_DARK_TOKENS: Readonly<Record<string, string>> = {
  "db-color-scheme": "dark",
  "db-backdrop": "#0f1114",
  "db-backdrop-dot": "#24282e",
  "db-surface": "#1e2127",
  "db-surface-sunken": "#101215",
  "db-surface-hover": "#2a2e35",
  "db-ink": "#e9ebee",
  "db-ink-muted": "#aab0b8",
  "db-ink-subtle": "#9aa0a8",
  "db-line-card": "#4a515a",
  "db-line-input": "#747c86",
  "db-line-divider": "#3a4049",
  "db-accent": "#8aa0f7",
  "db-accent-hover": "#9fb2f9",
  "db-accent-ink": "#0f1114",
  "db-accent-text": "#a6b8ff",
  "db-accent-soft": "#262f4d",
  "db-selected": "#e9ebee",
  "db-selected-ink": "#0f1114",
  "db-focus": "#a6b8ff",
  "db-focus-on-dark": "#2f4bd6",
  "db-danger": "#f0867c",
  "db-danger-soft": "#432528",
  "db-danger-line": "#a8524c",
  "db-warn": "#e6ad55",
  "db-warn-soft": "#3a2d14",
  "db-warn-line": "#9c6f22",
  "db-ok": "#6fcf8f",
  "db-ok-soft": "#183522",
  "db-ok-line": "#3f8c5a",
  "db-scrim": "rgba(0, 0, 0, .6)",
  "db-code-string": "#8bd3a6",
  "db-code-literal": "#c9a3f2",
  // Elevation: a shadow on a dark page has to be black and deeper to read at all.
  "db-shadow-pill": "0 10px 24px -16px rgb(0 0 0 / .7)",
  "db-shadow-card": "0 18px 40px -28px rgb(0 0 0 / .8)",
  "db-shadow-sheet": "0 30px 60px -40px rgb(0 0 0 / .9)",
  "db-shadow-drawer": "0 -20px 40px -20px rgb(0 0 0 / .85)",
  "db-shadow-drawer-side": "24px 0 48px -20px rgb(0 0 0 / .85)",
  "db-shadow-overlay": "0 24px 48px -20px rgb(0 0 0 / .85)"
};

export const DATUM_DARK_BUILDER_THEME_ID = "datum-dark";

/**
 * The dark look as a `"builder"`-target theme: what the shell applies while its
 * `scheme` is `"dark"` (the ⋮ menu's Dark mode), and what a page names with
 * `<datum-form-builder theme="datum-dark">`. The canvas follows the shell's scheme: the Datum
 * binding draws the form dark under it.
 */
export const DATUM_DARK_BUILDER_THEME: BuilderThemeDefinition = {
  id: DATUM_DARK_BUILDER_THEME_ID,
  version: "1.0.0",
  target: "builder",
  label: "Datum dark",
  tokens: { ...STUDIO_DARK_TOKENS }
};
