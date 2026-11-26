/**
 * The Print workspace's look: the settings card beside one continuous sheet, in the studio's
 * tokens. The sheet is paper and stays light under the builder's dark scheme: its strips and the
 * frame around the document redeclare the on-sheet tokens from the light list
 * (`studioLightValue`), so no colour is typed here; the document in the frame draws its own white.
 */
import { studioLightValue } from "../web-component/studio-tokens.js";

/** The tokens the sheet's own chrome reads, pinned to their light values. */
const SHEET_TOKENS = ["db-surface", "db-ink", "db-ink-muted", "db-line-divider", "db-line-card", "db-accent", "db-accent-text", "db-accent-soft", "db-surface-sunken"] as const;

function lightSheetTokens(): string {
  return SHEET_TOKENS.map((name) => `--${name}: ${studioLightValue(name)};`).join(" ");
}

export function printStyles(): string {
  return `
    :host { display: block; height: 100%; min-height: 0; container-type: inline-size; container-name: print; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .print {
      height: 100%; min-height: 0; display: grid; grid-template-columns: minmax(var(--db-editor-min), var(--db-editor-max)) minmax(0, 1fr);
      gap: var(--db-gap, 12px); padding: var(--db-gap, 12px); box-sizing: border-box;
      font-family: var(--db-font); font-size: var(--db-text-md); color: var(--db-ink);
    }
    .card { min-height: 0; }
    /* The settings are a column of cards (.card-stack), one a section, as the inspector's sections and Languages' are. */
    .side, .settings { min-width: 0; }
    /* Every grid in the card has one column that may shrink: a select or a box with a long intrinsic width never widens it past the card. */
    .group > *, .slot > *, .field > *, .property-row > * { min-width: 0; }
    p { margin: 0; }
    .muted { color: var(--db-ink-muted); }
    .small { font-size: var(--db-text-sm); }
    .group { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: var(--db-space-2); padding: var(--db-space-4); box-sizing: border-box; }
    .group > :is(.card-title, .card-heading) + .card-lead { margin-top: calc(var(--db-space-1) - var(--db-space-2)); }
    .group > .field, .group > .slot { margin-top: var(--db-space-1); }
    .preview-tools { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--db-space-3); justify-items: start; }
    .preview-tools > .field { justify-self: stretch; }
    /* A tick box and its caption: the shared 24px box, the words beside it. */
    .row { display: flex; gap: var(--db-space-3); align-items: center; min-block-size: 24px; cursor: pointer; }
    .row:has(.row-text) { align-items: flex-start; }
    .row-text { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--db-space-half); min-width: 0; padding-top: var(--db-space-half); }
    .field { grid-template-columns: minmax(0, 1fr); }
    /* The boxes are the shared ones; a box never outgrows its card. */
    input[type="text"], input[type="number"], select, textarea { max-width: 100%; }
    input::placeholder, textarea::placeholder { color: var(--db-ink-subtle); }
    .side input[type="text"], .side input[type="number"], .side select, .side textarea { width: 100%; max-width: 100%; min-width: 0; }
    textarea { width: 100%; font-family: var(--db-font-mono); resize: vertical; }
    input[aria-invalid="true"], textarea[aria-invalid="true"], select[aria-invalid="true"] { border-color: var(--db-danger); }
    .problem { color: var(--db-danger); font-size: var(--db-text-sm); }
    /* A slot reads down: its name with the Default badge, the text box across the full width, then the Insert control with the reset beside it. */
    .slot { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--db-space-1); min-width: 0; }
    .slot-head { display: flex; align-items: center; gap: var(--db-space-2); min-width: 0; }
    .slot-head label { font-weight: 500; font-size: var(--db-text-md); min-width: 0; }
    .slot-tools { display: flex; align-items: center; gap: var(--db-space-3); min-width: 0; }
    /* Insert is a menu button: its menu of placeholders drops from it, a button for each, as the builder's file menu does. */
    .insert { position: relative; flex: none; display: inline-flex; }
    .insert-menu { position: absolute; top: calc(100% + 4px); inset-inline-start: 0; min-inline-size: 200px; max-block-size: 320px; overflow: auto; white-space: nowrap; }
    .insert-group { display: flex; flex-direction: column; gap: var(--db-space-half); }
    .insert-sep { block-size: var(--db-border-w); margin: var(--db-space-1) 0; background: var(--db-line-divider); }
    .slot-tools .link-btn { flex: none; }
    .slot-tools .link-btn[hidden] { display: none; }
    .badge {
      flex: none; display: inline-flex; align-items: center; min-block-size: 20px; padding: 0 var(--db-space-2); border-radius: var(--db-radius-pill);
      background: var(--db-surface-sunken); font-size: var(--db-text-xs); font-weight: 500; white-space: nowrap; vertical-align: middle;
    }
    .badge[hidden] { display: none; }
    .slot-tools .link-btn { font-size: var(--db-text-sm); }
    .note strong { display: block; }
    .entries { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--db-space-1); }
    .entry { display: flex; align-items: center; justify-content: space-between; gap: var(--db-space-2); padding: var(--db-space-1) 0; border-bottom: var(--db-border-w) solid var(--db-line-divider); }
    .entry-text { display: grid; min-width: 0; }
    /* The pill button is the builder's own (.btn, with the tokens, and its .small for a card); the toolbar's is the small size too. */
    .toolbar .btn { min-block-size: 32px; padding: 0 var(--db-space-3); font-size: var(--db-text-sm); }
    .toolbar .btn.primary { font-weight: 600; border: 0; }
    .back { justify-self: start; }
    /* A component's "On paper" rows are the inspector's rows, so they are drawn as the inspector draws them. */
    .property-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: calc(var(--db-space-1) + var(--db-space-half)); min-width: 0; font-size: var(--db-text-md); }
    .group > .property-row + .property-row { margin-top: var(--db-space-2); }
    .property-row > strong, .property-label strong { font-size: var(--db-text-md); color: var(--db-ink); font-weight: 500; }
    .property-label { display: flex; align-items: center; gap: var(--db-space-1); }
    .property-row:has(> input[type="checkbox"]) { grid-template-columns: auto minmax(0, 1fr); align-items: center; column-gap: var(--db-space-3); }
    .property-row > input[type="checkbox"] { justify-self: start; order: -1; }
    .property-row--help:has(> input[type="checkbox"]) > :is(.property-help, .field-error, .field-note) { grid-column: 1 / -1; }
    .property-help { margin: 0; font-size: var(--db-text-sm); line-height: 1.4; color: var(--db-ink-muted); }
    .property-help[hidden] { display: none; }
    .property-help-toggle {
      flex: none; inline-size: 24px; block-size: 24px; min-inline-size: 24px; min-block-size: 24px; padding: 0;
      border-radius: var(--db-radius-pill); border: 0;
      background: var(--db-surface-sunken); color: var(--db-ink-muted); font: inherit; font-size: var(--db-text-xs); font-weight: 600;
      line-height: 1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      transition: background-color var(--db-motion-fast) var(--db-ease), color var(--db-motion-fast) var(--db-ease);
    }
    .property-help-toggle:hover { background: var(--db-surface-hover); color: var(--db-ink); }
    .property-help-toggle[aria-expanded="true"] { background: var(--db-selected); color: var(--db-selected-ink); }
    .field-error, .field-note { margin: 0; font-size: var(--db-text-sm); }
    .field-error { color: var(--db-danger); }
    .pane { display: flex; flex-direction: column; gap: var(--db-gap, 12px); min-width: 0; min-height: 0; }
    .pane > .toolbar, .pane > .fallback, .pane > .empty-state { flex: none; }
    /* The preview's bar is the canvas's bar: a white pill at the end edge, 32px tools at the small size, the primary action last. */
    .toolbar {
      align-self: flex-end; max-width: 100%; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--db-space-1); padding: var(--db-space-1);
      background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-pill); box-shadow: var(--db-shadow-pill);
      font-size: var(--db-text-sm); color: var(--db-ink);
    }
    .zoom { display: inline-flex; align-items: center; gap: 2px; padding-inline-start: var(--db-space-1); border-inline-start: var(--db-border-w) solid var(--db-line-divider); }
    .zoom .zoom-value { min-inline-size: 48px; text-align: center; font-weight: 500; font-variant-numeric: tabular-nums; }
    .zoom .icon-btn { font-size: var(--db-text-sm); }
    .zoom .icon-btn[aria-disabled="true"] { opacity: .4; cursor: default; }
    /* Switched off with aria-disabled (the shared hover only skips the disabled attribute): no lit fill, the resting ink. */
    .zoom .icon-btn[aria-disabled="true"]:hover { background: transparent; color: var(--db-ink-muted); }
    .pages { color: var(--db-ink-muted); padding-inline: var(--db-space-2); white-space: nowrap; }
    .pages:empty { display: none; }
    .receipt-toggle { position: relative; display: inline-flex; align-items: center; gap: var(--db-space-1); }
    .receipt-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--db-accent); flex: none; }
    /* The sample boxes open under the choices that ask for them, in the Preview card. */
    .samples { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--db-space-3); margin-top: var(--db-space-2); }
    .samples[hidden] { display: none; }
    .samples .field { min-width: 0; }
    .samples .field[hidden] { display: none; }
    .samples textarea { height: 4.75em; min-height: 3.5em; }
    .fallback { margin: 0; }
    /* The sheet lies on the builder's backdrop, as the form's sheet does on the canvas. */
    .scroller { position: relative; flex: 1 1 auto; overflow: auto; min-height: 0; border-radius: var(--db-radius-xl); padding: var(--db-space-1) var(--db-space-1) var(--db-space-4); }
    .scroller:focus-visible { outline: 2px solid var(--db-focus); outline-offset: -2px; }
    .sheet-box { position: relative; margin: 0 auto; }
    .sheet {
      ${lightSheetTokens()}
      position: absolute; top: 0; left: 0; transform-origin: 0 0; background: var(--db-surface);
      box-shadow: var(--db-shadow-card); color-scheme: light;
    }
    .sheet-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: var(--db-surface); }
    .sheet-frame[data-print-frame-back] { visibility: hidden; pointer-events: none; }
    .sheet-overlay { position: absolute; inset: 0; pointer-events: none; }
    .break-line { position: absolute; left: 0; right: 0; border-top: 2px dashed var(--db-line-card); }
    .break-line--forced { border-top: 2px solid var(--db-accent); }
    .break-label {
      position: absolute; right: var(--db-space-3); top: 2px; font-size: var(--db-text-xs); color: var(--db-ink-muted);
      background: var(--db-surface); padding: 0 var(--db-space-2); border-radius: var(--db-radius-pill); border: var(--db-border-w) solid var(--db-line-divider);
    }
    .break-line--forced .break-label { color: var(--db-accent-text); border-color: var(--db-accent); }
    /* The canvas's marks: a solid accent ring on the selected component, a thin dashed one on the component under the pointer. */
    .selection-box { position: absolute; outline: 2px solid var(--db-accent); outline-offset: 4px; border-radius: 4px; }
    .hover-box { position: absolute; outline: 1px dashed var(--db-accent); outline-offset: 4px; border-radius: 4px; }
    .strip {
      position: absolute; left: 0; right: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--db-space-3);
      padding: 0 var(--db-space-6); font-size: var(--db-text-xs); color: var(--db-ink-muted); pointer-events: none; box-sizing: border-box;
      border-style: dashed; border-color: var(--db-line-divider); border-width: 0;
    }
    .strip[hidden] { display: none; }
    .strip--top { top: 0; border-bottom-width: var(--db-border-w); }
    .strip--bottom { bottom: 0; border-top-width: var(--db-border-w); }
    .chromium { margin: var(--db-space-2) auto 0; max-width: 60ch; font-size: var(--db-text-sm); color: var(--db-ink-muted); text-align: center; }
    .empty-state[hidden], .scroller[hidden] { display: none; }
    /* Narrow: the settings above the preview, one column. */
    @container print (max-width: 860px) {
      .print { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); overflow: auto; height: auto; }
      .side { overflow: visible; }
    }
    /* A coarse pointer: the bar's tools are 44px, as the canvas bar's are. */
    @media (pointer: coarse) {
      .zoom .icon-btn, .toolbar .btn { min-block-size: 44px; }
      .zoom .icon-btn { min-inline-size: 44px; }
    }
    /* A phone: stacked, the bar across the width. */
    :host([data-phone]) .print { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); height: auto; overflow: auto; padding: var(--db-space-2); }
    :host([data-phone]) .side { overflow: visible; }
    :host([data-phone]) .toolbar { border-radius: var(--db-radius-xl); }
  `;
}
