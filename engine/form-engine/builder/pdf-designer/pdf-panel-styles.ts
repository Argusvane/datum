/**
 * The styles of the PDF designer's own chrome (the Preview dialog, the Add popover, the template
 * page viewer's surface), in their own module because the mode puts them on the page when it
 * registers, while the panels themselves (`pdf-designer-panels.ts`) load with the designer's chunk.
 */
import { MODAL_BACKDROP_CLIP, MODAL_H, MODAL_INSET, MODAL_W } from "../web-component/modal-place.js";
import { studioLightValue } from "../web-component/studio-tokens.js";

/**
 * The tokens a template page pins to the light look. The paper is white whatever the builder's
 * scheme, so the accent that outlines an area, the accent as the area's label text, the focus
 * ring and the unmapped-field line are the light values (6.8:1 and better on white); the dark
 * builder's own accent is 1.9 to 2.5:1 on it. The page's own variables are re-read after the
 * pin, since a custom property that names another is resolved where it is declared. Forced
 * colours keep the system-colour mapping instead (the pin sits in `not (forced-colors: active)`).
 */
const PDF_PAGE_PIN = ["db-accent", "db-accent-text", "db-focus", "db-warn-line", "db-surface"].map((name) => `--${name}: ${studioLightValue(name)};`).join(" ");

export const PDF_DESIGNER_PANEL_STYLES = `
  dialog.dpd, .dpd-template-surface {
    --dpd-panel: var(--db-surface);
    --dpd-border: var(--db-line-card);
    --dpd-ink: var(--db-ink);
    --dpd-muted: var(--db-ink-muted);
    --dpd-accent: var(--db-accent);
    --dpd-danger: var(--db-danger);
  }
  /*
   * The preview dialog: a studio dialog card over the scrim, placed and sized from the
   * shell's own box (modal-place.ts) rather than the viewport, and draggable,
   * resizable and maximizable like the shell's other dialogs. On a phone it is a full sheet.
   */
  dialog.dpd {
    box-sizing: border-box;
    inset: ${MODAL_INSET};
    width: min(960px, calc(${MODAL_W} - 32px));
    height: min(760px, calc(${MODAL_H} - 32px));
    max-width: ${MODAL_W};
    max-height: ${MODAL_H};
    margin: auto;
    padding: var(--db-space-4) var(--db-space-5);
    border: var(--db-border-w) solid var(--dpd-border);
    border-radius: var(--db-radius-lg);
    background: var(--dpd-panel);
    color: var(--dpd-ink);
    font: var(--db-text-md)/1.45 var(--db-font);
    box-shadow: var(--db-shadow-overlay);
    overflow: hidden;
    resize: both;
  }
  dialog.dpd[open] { display: flex; flex-direction: column; }
  /* Maximized and the phone sheet beat the inline coordinates a drag or the corner wrote (as the shell's dialogs do). */
  dialog.dpd.maximized, .wrap[data-phone] ~ dialog.dpd {
    inset: ${MODAL_INSET} !important; margin: 0 !important;
    width: ${MODAL_W} !important; height: ${MODAL_H} !important; max-width: none; max-height: none; border-radius: 0; resize: none;
  }
  .wrap[data-phone] ~ dialog.dpd { padding: var(--db-space-3); }
  .wrap[data-phone] ~ dialog.dpd :is(.btn, .icon-btn) { min-block-size: var(--db-density-control-h, 44px); }
  .wrap[data-phone] ~ dialog.dpd .icon-btn { inline-size: var(--db-density-control-h, 44px); block-size: var(--db-density-control-h, 44px); }
  dialog.dpd::backdrop { background: var(--db-scrim); ${MODAL_BACKDROP_CLIP} }
  .dpd-head { display: flex; align-items: center; gap: var(--db-space-2); margin-bottom: var(--db-space-2); flex-wrap: wrap; cursor: grab; }
  .dpd-head__text { flex: 1; min-width: 0; }
  .dpd-head h2 { margin: 0; font-size: var(--db-text-lg); font-weight: 600; }
  .dpd-head__sub { margin: 0; color: var(--dpd-muted); font-size: var(--db-text-sm); }
  .dpd a.btn { text-decoration: none; }
  /* The head's icon buttons: the shared .icon-btn (the shell prints it), square, their glyph a character at the title's size. */
  .dpd .icon-btn { inline-size: 32px; padding: 0; font-size: var(--db-text-xl); line-height: 1; }
  .dpd-muted { color: var(--dpd-muted); }
  /*
   * The template surface: what the canvas shows in the sheet's place over a
   * populated-form layout — a status line, then the page viewer with the template's fields
   * and the areas drawn over the pages. The page around it scrolls; the viewer's own
   * scroller is unbounded here, so the whole document is laid out down the page.
   */
  .dpd-template-surface { display: grid; gap: var(--db-space-2); width: 100%; color: var(--dpd-ink); font: var(--db-text-md)/1.45 var(--db-font); }
  .dpd-template-status { margin: 0; color: var(--dpd-muted); font-size: var(--db-text-sm); }
  .dpd-template-status[data-tone="error"] { color: var(--dpd-danger); }
  .dpd-template-status[data-tone="warn"] { color: var(--db-warn); }
  /* What Suggest mappings found: a note with its own Dismiss, a quiet card over the pages. */
  .dpd-template-note { display: flex; align-items: center; justify-content: space-between; gap: var(--db-space-3); color: var(--dpd-ink); }
  .dpd-template-note[hidden] { display: none; }
  .dpd-template-surface .dpd-pages__scroll { max-height: none; overflow: visible; }
  .dpd-pages { display: grid; gap: var(--db-space-2); }
  .dpd-pages__status { flex: 1; color: var(--dpd-muted); font-size: var(--db-text-sm); }
  .dpd-pages__scroll { display: grid; gap: var(--db-space-3); justify-items: center; overflow: auto; padding: var(--db-space-2); border: var(--db-border-w) solid var(--dpd-border); border-radius: var(--db-radius-md); background: var(--db-surface-sunken); }
  /* A page of the template: paper, white whatever the builder's look, its edge a hairline. */
  .dpd-page { --dpd-accent: var(--db-accent); --dpd-panel: var(--db-surface); position: relative; flex: none; background: #fff; box-shadow: 0 0 0 1px var(--db-line-divider), var(--db-shadow-card); }
  @media not (forced-colors: active) {
    .dpd-page { ${PDF_PAGE_PIN} --dpd-accent: var(--db-accent); --dpd-panel: var(--db-surface); }
  }
  .dpd-page__picture { display: block; position: absolute; inset: 0; pointer-events: none; }
  .dpd-page__overlay { display: block; position: absolute; inset: 0; cursor: crosshair; touch-action: none; outline: none; }
  .dpd-page__overlay:focus-visible { box-shadow: 0 0 0 2px var(--db-focus); }
  /* The template's own fields: mapped in the accent, a field nothing fills a warning (a dashed warn line). */
  .dpd-page__overlay .datum-pdf-schematic__field { fill: color-mix(in srgb, var(--db-warn-line) 14%, transparent); stroke: var(--db-warn-line); stroke-dasharray: 4 3; stroke-width: 1; cursor: pointer; vector-effect: non-scaling-stroke; }
  .dpd-page__overlay .datum-pdf-schematic__field--mapped { fill: color-mix(in srgb, var(--dpd-accent) 16%, transparent); stroke: var(--dpd-accent); stroke-dasharray: none; }
  .dpd-page__overlay .datum-pdf-schematic__field--unresolved { fill: color-mix(in srgb, var(--db-warn-line) 24%, transparent); stroke: var(--db-warn-line); stroke-dasharray: 2 2; stroke-width: 2; }
  .dpd-page__overlay .datum-pdf-schematic__field.is-focused { stroke-width: 2.5; }
  .dpd-area { cursor: move; }
  .dpd-area__box { fill: color-mix(in srgb, var(--dpd-accent) 14%, transparent); stroke: var(--dpd-accent); stroke-width: 1.5; }
  .dpd-area.is-selected .dpd-area__box { stroke-width: 2.5; fill: color-mix(in srgb, var(--dpd-accent) 22%, transparent); }
  .dpd-area--check .dpd-area__box { stroke-dasharray: 3 2; }
  .dpd-area__label { fill: var(--db-accent-text); font-family: var(--db-font); pointer-events: none; user-select: none; }
  .dpd-area__handle { fill: var(--dpd-panel); stroke: var(--dpd-accent); stroke-width: 1.5; cursor: nwse-resize; }
  .dpd-area__handle[data-handle="n"], .dpd-area__handle[data-handle="s"] { cursor: ns-resize; }
  .dpd-area__handle[data-handle="e"], .dpd-area__handle[data-handle="w"] { cursor: ew-resize; }
  .dpd-area__handle[data-handle="ne"], .dpd-area__handle[data-handle="sw"] { cursor: nesw-resize; }
  .dpd-area__draft { fill: color-mix(in srgb, var(--dpd-accent) 10%, transparent); stroke: var(--dpd-accent); stroke-width: 1; stroke-dasharray: 4 3; pointer-events: none; }
  .dpd-area--field .dpd-area__box { fill: color-mix(in srgb, var(--dpd-accent) 8%, transparent); stroke-width: 1.5; stroke-dasharray: none; }
  .dpd-area--field.is-selected .dpd-area__box { stroke-width: 2.5; }
  .dpd-area--field .dpd-area__label { font-weight: 600; }
  /* The preview dialog: the rendered bytes, and for a populated form what filled each field and area. */
  .dpd-preview-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 240px); gap: var(--db-space-3); }
  .dpd-side { overflow: auto; display: grid; align-content: start; gap: var(--db-space-3); }
  .dpd-side h3 { margin: 0 0 var(--db-space-1); font-size: var(--db-text-sm); font-weight: 600; color: var(--dpd-muted); }
  .dpd-side p { margin: 0; }
  .dpd-side__pages { display: flex; flex-wrap: wrap; gap: var(--db-space-1); }
  .wrap[data-phone] ~ dialog.dpd .dpd-preview-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
  .wrap[data-phone] ~ dialog.dpd .dpd-side { max-height: 40%; }
  .dpd-preview-frame { width: 100%; height: 100%; min-height: 0; border: var(--db-border-w) solid var(--dpd-border); border-radius: var(--db-radius-md); background: var(--db-surface-sunken); }
  .dpd-warnings { margin: var(--db-space-2) 0 0; padding-inline-start: var(--db-space-5); color: var(--dpd-danger); font-size: var(--db-text-sm); }
  .dpd-report { margin: var(--db-space-2) 0 0; padding-inline-start: var(--db-space-5); font-size: var(--db-text-sm); }
  .dpd-report li[data-status="missing"], .dpd-report li[data-status="unsupported"], .dpd-report li[data-status="overflow"] { color: var(--dpd-danger); }
  /* The Add popover under the bar's + button: the shared menu card (menu, menu-item, note), placed and sized here. */
  .dpd-add {
    position: fixed; box-sizing: border-box;
    min-width: min(240px, calc(var(--db-shell-w, 100vw) - 16px)); max-width: min(320px, calc(var(--db-shell-w, 100vw) - 16px));
    gap: var(--db-space-3); padding: var(--db-space-3);
    font: var(--db-text-md)/1.45 var(--db-font);
  }
  /* A section heading: sentence case, small and muted. */
  .dpd-add h3 { margin: 0 0 var(--db-space-1); font-size: var(--db-text-sm); font-weight: 600; color: var(--db-ink-muted); letter-spacing: .02em; }
  .dpd-add__group { display: grid; gap: var(--db-space-half); }
  .dpd-add__group[data-add-name-step] { gap: var(--db-space-2); padding: var(--db-space-1); }
  .dpd-add__group .confirm-actions { justify-content: flex-end; }
  /* The name step's box: the shell's root prints no element-wide box rules, so it is drawn here, 13px label over 14px box. */
  .dpd-add label { display: grid; gap: var(--db-space-1); font-weight: 500; }
  .dpd-add input[type="text"] {
    box-sizing: border-box; width: 100%; min-height: var(--db-control-h); padding: 0 var(--db-space-3);
    border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-md);
    background: var(--db-surface); color: var(--db-ink); font: inherit; font-size: var(--db-text-base); font-weight: 400;
  }
`;
