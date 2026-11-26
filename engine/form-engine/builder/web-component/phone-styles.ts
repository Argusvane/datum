/**
 * The phone tier's look: the shell under 768px of its
 * own box. One top row (the Menu button, undo and redo, the host's Save), the strip and the
 * rail laid flat as a bottom bar, every drawer a bottom sheet over a scrim, and a menu drawer
 * from the start edge for everything the wide bar holds.
 *
 * Keyed on the wrap's data-phone attribute, which the shell's width observer sets beside
 * data-narrow: one source for the look and the behaviour (sheets are dialogs, drag is off, the
 * bottom bar overflows). Printed last in the shell's styles, so it wins at equal weight.
 *
 * No backticks in these comments: the sheet is a template literal.
 */

/** The bottom bar holds at most this many items; past it, the first ones less one, and More. */
export const PHONE_BOTTOM_BAR_MAX = 4;

/**
 * The bottom bar's order: Add first, then Outline and Try it in Form, the
 * Form settings panel in a designer, then the rest. Lower comes first; a host's item after the
 * shell's, Results and More last.
 */
export const PHONE_BOTTOM_ORDER: Readonly<Record<string, number>> = {
  add: 1,
  components: 1,
  // The Form fields panel (a journey's Step view): the other way to fill a step, next to the palette.
  fields: 1.5,
  outline: 2,
  try: 3,
  form: 4,
  variables: 5,
  chrome: 6,
  view: 7,
  settings: 8,
  translations: 9,
  // The Tests panel sorts after Settings: it is an author's check, not a way to change the form.
  tests: 9.5,
  host: 10,
  results: 11,
  more: 12
};

export const PHONE_SHELL_STYLES = `
    /* Parts only the phone tier draws: absent at every other width. */
    .menu-open, .document-back, .sheet-head, .db-scrim, .menu-drawer, .more-sheet, .bottom-btn, .strip-label { display: none; }
    .bar-history { display: contents; }

    .wrap[data-phone] {
      --db-gap: 8px;
      --db-density-control-h: 44px;
      --db-safe-bottom: env(safe-area-inset-bottom, 0px);
      --db-bottom-bar-h: calc(64px + var(--db-safe-bottom));
      --db-sheet-h: 70%;
      --db-drawer-w: min(320px, 86%);
    }
    /* An overview (Journeys, PDF) has no bottom bar. */
    .wrap[data-phone][data-overview] { --db-bottom-bar-h: 0px; }
    .wrap[data-phone][data-sheet-tall] { --db-sheet-h: calc(100% - 8px); }

    /* The top row: Menu (or a designer's back title), undo and redo, the host's Save. Nothing else. */
    .wrap[data-phone] .bar {
      display: flex; align-items: center; gap: var(--db-space-2);
      padding: var(--db-space-2) var(--db-space-2) 0;
    }
    .wrap[data-phone] :is(.bar-lead, .bar-start) { display: contents; }
    .wrap[data-phone] :is(.workspaces, .bar-centre, [data-palette-open], [data-host-sep], [data-overview-back], [data-overview-back-sep]) { display: none; }
    /*
     * Orders below zero: a host's Save comes through a forwarding slot (datum-form-builder's), whose
     * order cannot be set from here, so it keeps the default 0 and lands last on its own.
     */
    .wrap[data-phone] .menu-open {
      order: -3; flex: none; display: inline-flex; align-items: center; gap: var(--db-space-2);
      min-width: 0; max-width: 55%; height: 48px; padding: 0 var(--db-space-4) 0 var(--db-space-3);
      border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-pill);
      background: var(--db-surface); box-shadow: var(--db-shadow-pill); color: var(--db-ink);
      font: inherit; font-size: var(--db-text-lg); font-weight: 500; cursor: pointer;
    }
    .wrap[data-phone] .menu-open:hover { background: var(--db-surface-hover); }
    .wrap[data-phone] .menu-open svg { flex: none; width: 18px; height: 18px; }
    .menu-open-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wrap[data-phone] .menu-open-count:not([hidden]), .menu-count {
      flex: none; display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px;
      border-radius: var(--db-radius-pill); background: var(--db-danger); color: var(--db-surface);
      font-size: var(--db-text-xs); font-weight: 600;
    }
    /* In a designer the back title takes the room: Menu is its glyph alone. */
    .wrap[data-phone][data-designer] .menu-open { width: 48px; padding: 0; justify-content: center; }
    .wrap[data-phone][data-designer] :is(.menu-open-label, .menu-open-count) { display: none; }
    .wrap[data-phone] .document-back:not([hidden]) {
      order: -2; flex: 0 1 auto; display: inline-flex; align-items: center; gap: var(--db-space-1);
      min-width: 0; height: 48px; padding: 0 var(--db-space-4) 0 var(--db-space-2);
      border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-pill);
      background: var(--db-surface); box-shadow: var(--db-shadow-pill); color: var(--db-ink);
      font: inherit; text-align: start; cursor: pointer;
    }
    .wrap[data-phone] .document-back:hover { background: var(--db-surface-hover); }
    .document-back svg { flex: none; width: 16px; height: 16px; }
    .document-back-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
    .document-back-name { font-size: var(--db-text-base); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .document-back-kind { font-size: var(--db-text-xs); font-weight: 500; color: var(--db-ink-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wrap[data-phone] .bar-history {
      order: -1; margin-inline-start: auto; flex: none; display: inline-flex; align-items: center; gap: var(--db-space-half);
      height: 48px; padding: 1px;
      border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-pill);
      background: var(--db-surface); box-shadow: var(--db-shadow-pill);
    }
    .wrap[data-phone] .bar-history .bar-btn { width: 44px; height: 44px; }
    /* A renamed document's box takes the row while it is up. */
    .wrap[data-phone] .bar-centre:has(.document-rename) {
      display: flex; position: absolute; inset: var(--db-space-2) var(--db-space-2) auto; z-index: 2; justify-content: stretch;
    }
    .wrap[data-phone] .bar-centre:has(.document-rename) .documents { flex: 1; }
    .wrap[data-phone] .bar-centre:has(.document-rename) .document-rename { flex: 1; width: auto; height: 40px; font-size: var(--db-text-lg); }
    /* The wide bar's end: gone, but for a file's message, which shows under the row. */
    .wrap[data-phone] .bar-end {
      position: absolute; top: calc(100% + var(--db-space-1)); inset-inline: var(--db-space-2);
      display: flex; justify-content: center; pointer-events: none;
    }
    .wrap[data-phone] .bar-end > :not(.file-actions) { display: none; }
    .wrap[data-phone] .file-actions > :not(.file-error) { display: none; }
    .wrap[data-phone] .file-error { pointer-events: auto; max-width: 100%; box-shadow: var(--db-shadow-overlay); }

    /* The body: the canvas the whole width, everything else placed against the shell's box. */
    .wrap[data-phone] .body { position: static; }
    .wrap[data-phone] .resizer { display: none; }
    .wrap[data-phone] .logic-host { padding-bottom: var(--db-bottom-bar-h); }
    /* The inspector's folded stub has no place on a phone: Edit and a second tap open it. */
    .wrap[data-phone][data-props-collapsed] .body > datum-builder-properties { display: none; }

    /* The bottom bar: the strip and the rail laid flat, labelled tabs, at most four. */
    .wrap[data-phone] .rails {
      position: absolute; inset: auto 0 0 0; z-index: 5;
      width: auto; max-height: none; margin: 0;
      flex-direction: row; align-items: stretch; gap: var(--db-space-1);
      height: var(--db-bottom-bar-h);
      padding: var(--db-space-2) var(--db-space-2) calc(var(--db-space-2) + var(--db-safe-bottom));
      background: var(--db-surface); border-top: var(--db-border-w) solid var(--db-line-card); pointer-events: auto;
      overflow: visible;
    }
    /* The tabs carry their captions: no tooltips. */
    .wrap[data-phone] .rails [data-tip]::after { display: none; }
    .wrap[data-phone] :is(.add-rail:not([hidden]), .strip, .strip-tabs) {
      display: contents;
    }
    .wrap[data-phone] :is(.strip-btn:not([hidden]), .bottom-btn:not([hidden])) {
      flex: 1 1 0; min-width: 0; width: auto; height: 48px;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
      padding: 0; border: 0; border-radius: var(--db-radius-lg);
      background: transparent; color: var(--db-ink-muted);
      font: inherit; font-size: var(--db-text-xs); font-weight: 500; cursor: pointer;
    }
    .wrap[data-phone] :is(.strip-btn, .bottom-btn) > .glyph {
      width: 52px; height: 28px; display: grid; place-items: center; border-radius: var(--db-radius-pill);
    }
    .wrap[data-phone] :is(.strip-btn, .bottom-btn) svg { width: 20px; height: 20px; }
    .wrap[data-phone] :is(.strip-btn, .bottom-btn):hover { background: transparent; color: var(--db-ink); }
    .wrap[data-phone] :is(.strip-btn, .bottom-btn):hover > .glyph { background: var(--db-surface-hover); }
    .wrap[data-phone] :is(.strip-btn[aria-selected="true"], .strip-btn[aria-pressed="true"], .bottom-btn[aria-pressed="true"], .bottom-btn[aria-expanded="true"]) {
      background: transparent; color: var(--db-ink);
    }
    .wrap[data-phone] :is(.strip-btn[aria-selected="true"], .strip-btn[aria-pressed="true"], .bottom-btn[aria-pressed="true"], .bottom-btn[aria-expanded="true"]) > .glyph {
      background: var(--db-selected); color: var(--db-selected-ink);
    }
    .wrap[data-phone] .rail-more { background: transparent; }
    .rail-more-plus { display: none; }
    .wrap[data-phone] .rail-more-dots { display: none; }
    .wrap[data-phone] .rail-more-plus { display: block; }
    .wrap[data-phone] :is(.strip-btn, .bottom-btn):disabled { opacity: .4; cursor: default; }
    .wrap[data-phone] .strip-label {
      display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.2;
    }
    .wrap[data-phone] [data-bottom-overflow] { display: none !important; }
    /* The rail keeps its Add alone, and the strip its items: after the item rule above, at more weight. */
    .wrap[data-phone] .rails .add-rail .rail-btn:not(.rail-more), .wrap[data-phone] .rails .strip-sep { display: none; }
    .bottom-btn .menu-count { position: absolute; top: 2px; inset-inline-end: calc(50% - 30px); }
    .bottom-btn { position: relative; }
    .bottom-btn .menu-count--ok { background: var(--db-ok); }

    /*
     * Sheets: the side column and the inspector rise from the bottom over a
     * scrim, one at a time. The shell draws their handle row above them; the panel keeps its
     * own head, and its Apply and Discard stay pinned in its own footer.
     */
    .wrap[data-phone] .side,
    .wrap[data-phone] .body > datum-builder-properties {
      position: absolute; top: auto; bottom: 0; left: 0; right: 0; z-index: 30;
      width: auto; min-width: 0; height: calc(var(--db-sheet-h) - 44px);
      border: 0; border-radius: 0; box-shadow: none; background: var(--db-surface);
      overscroll-behavior: contain;
    }
    .wrap[data-phone] .side:is(:has(> [data-floating]:not([hidden])), [data-host-floating]) { background: var(--db-surface); pointer-events: auto; overflow: hidden; }
    .wrap[data-phone] .sheet-head:not([hidden]) {
      display: flex; align-items: center; position: absolute; left: 0; right: 0; z-index: 31;
      bottom: calc(var(--db-sheet-h) - 44px); height: 44px; padding: 0 var(--db-space-1) 0 52px;
      background: var(--db-surface); border-radius: 22px 22px 0 0;
      box-shadow: var(--db-shadow-drawer);
    }
    .sheet-grab {
      flex: 1; height: 44px; padding: 0; border: 0; background: transparent; cursor: grab;
      display: grid; place-items: center; touch-action: none;
    }
    /* The handle row is the drag handle (sheet-gestures.ts): the page must not claim the touch. */
    .wrap[data-phone] .sheet-head { touch-action: none; }
    .sheet-grab::before { content: ""; width: 40px; height: 5px; border-radius: var(--db-radius-pill); background: var(--db-line-card); }
    .sheet-close, .menu-close {
      flex: none; width: 44px; height: 44px; padding: 0; border: 0; border-radius: var(--db-radius-pill);
      background: transparent; color: var(--db-ink-muted); display: grid; place-items: center; cursor: pointer;
    }
    .sheet-close:hover, .menu-close:hover { background: var(--db-surface-hover); color: var(--db-ink); }
    :is(.sheet-grab, .sheet-close, .menu-close, .menu-row, .more-row):focus-visible { outline: 2px solid var(--db-focus); outline-offset: -2px; }
    .wrap[data-phone][data-sheet] .db-scrim {
      display: block; position: absolute; inset: 0; z-index: 20; background: var(--db-scrim);
      touch-action: none;
    }
    /* A sheet scrolling past its end does not hand the scroll to the page behind it. */
    .wrap[data-phone][data-sheet] { overscroll-behavior: contain; }
    /* A surface's own sheet (Logic's rule, Data's row) and Try it's results lift their host over the bars. */
    .wrap[data-phone][data-sheet="surface"] .logic-host:not([hidden]) { z-index: 30; padding-bottom: 0; }
    .wrap[data-phone][data-sheet="results"] datum-builder-canvas { position: relative; z-index: 30; }

    /* More: the bottom bar's overflow, as a sheet as tall as its rows. */
    .wrap[data-phone] .more-sheet:not([hidden]) {
      display: flex; flex-direction: column; position: absolute; left: 0; right: 0; bottom: 0; z-index: 30;
      max-height: calc(var(--db-sheet-h) - 8px); padding-bottom: calc(var(--db-space-3) + var(--db-safe-bottom));
      background: var(--db-surface); border-radius: 22px 22px 0 0;
      box-shadow: var(--db-shadow-drawer);
    }
    /* More has no handle button; its head row is the drag handle, drawn with the same pill. */
    .wrap[data-phone] .more-head { position: relative; padding-top: var(--db-space-4); touch-action: none; }
    .wrap[data-phone] .more-head::before {
      content: ""; position: absolute; top: 8px; inset-inline-start: 50%; width: 40px; height: 5px; margin-inline-start: -20px;
      border-radius: var(--db-radius-pill); background: var(--db-line-card);
    }
    /* Every part of the drawer, its scrolling body included, takes only vertical pans, so a sideways swipe reaches the pointer handler (sheet-gestures.ts) wherever it starts. */
    .wrap[data-phone] .menu-drawer, .wrap[data-phone] .menu-drawer * { touch-action: pan-y; }
    .more-head, .menu-head { display: flex; align-items: center; gap: var(--db-space-2); padding: var(--db-space-2) var(--db-space-1) var(--db-space-2) var(--db-space-5); }
    .more-head h2 { flex: 1; margin: 0; font-size: var(--db-text-xl); font-weight: 600; }
    .more-list { overflow: auto; overscroll-behavior: contain; }
    .more-row, .menu-row {
      display: flex; align-items: center; gap: var(--db-space-4); width: 100%; min-height: 56px;
      padding: 0 var(--db-space-4) 0 var(--db-space-5); border: 0; background: transparent; color: var(--db-ink);
      font: inherit; font-size: var(--db-text-lg); font-weight: 500; text-align: start; cursor: pointer;
    }
    .menu-row { min-height: 48px; font-size: var(--db-text-base); }
    .more-row:hover, .menu-row:hover { background: var(--db-surface-hover); }
    .more-row-icon {
      flex: none; width: 40px; height: 40px; border-radius: var(--db-radius-md); display: grid; place-items: center;
      background: var(--db-surface-sunken); color: var(--db-ink-muted);
    }
    .more-row-icon svg, .menu-row-icon svg { width: 18px; height: 18px; }
    .more-row-label, .menu-row-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* The menu drawer, from the start edge over the scrim. */
    .wrap[data-phone] .menu-drawer:not([hidden]) {
      display: flex; flex-direction: column; position: absolute; inset-block: 0; inset-inline-start: 0; z-index: 40;
      width: var(--db-drawer-w); background: var(--db-surface);
      box-shadow: var(--db-shadow-drawer-side); overflow: hidden;
    }
    .menu-head { padding: var(--db-space-3) var(--db-space-1) var(--db-space-2) var(--db-space-5); }
    .menu-head-text { flex: 1; min-width: 0; }
    .menu-title { font-size: var(--db-text-lg); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .menu-title:focus { outline: none; }
    .menu-state { font-size: var(--db-text-md); color: var(--db-ink-muted); }
    .menu-body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding-bottom: calc(var(--db-space-3) + var(--db-safe-bottom)); }
    .menu-heading {
      margin: 0; padding: var(--db-space-4) var(--db-space-5) var(--db-space-1);
      font-size: var(--db-text-sm); font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--db-ink-muted);
    }
    .menu-row-icon { flex: none; width: 22px; display: grid; place-items: center; color: var(--db-ink-muted); }
    .menu-row[aria-current="true"] {
      background: var(--db-selected); color: var(--db-selected-ink);
      border-start-end-radius: var(--db-radius-pill); border-end-end-radius: var(--db-radius-pill);
      width: calc(100% - var(--db-space-3));
    }
    .menu-row[aria-current="true"] :is(.menu-row-icon, .menu-row-chip, .menu-row-key) { color: inherit; }
    .menu-row[aria-current="true"] .menu-count { background: var(--db-surface); color: var(--db-danger); }
    .menu-row-key { font-size: var(--db-text-sm); color: var(--db-ink-muted); font-family: var(--db-font-mono); }
    .menu-row-chip { font-size: var(--db-text-sm); color: var(--db-ink-muted); }
    .menu-row--danger { color: var(--db-danger); }
    .menu-switch {
      flex: none; position: relative; width: 44px; height: 26px; border-radius: var(--db-radius-pill); background: var(--db-line-card);
    }
    .menu-switch::after {
      content: ""; position: absolute; top: 3px; inset-inline-start: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--db-surface);
    }
    [aria-checked="true"] > .menu-switch { background: var(--db-selected); }
    [aria-checked="true"] > .menu-switch::after { inset-inline-start: 21px; }
    /* The host's own bar controls, moved here on a phone: a column of full-width rows. */
    .menu-host { --db-bar-tool: 44px; display: flex; flex-direction: column; align-items: stretch; gap: var(--db-space-1); padding: 0 var(--db-space-3); }
    .menu-host > slot, .menu-host > .mode-actions { display: contents; }
    .menu-host ::slotted(*) { min-height: 44px; justify-content: flex-start; }
    .menu-section[hidden] { display: none; }

    /* Under 360px of shell, the host's Save keeps its glyph or its first word only. */
    @container db-shell (max-width: 359px) {
      .wrap[data-phone] .bar-history .bar-btn { width: 40px; }
      .wrap[data-phone] .menu-open { max-width: 40%; }
    }
    @media (prefers-reduced-motion: no-preference) {
      .wrap[data-phone] .menu-drawer:not([hidden]) { animation: db-drawer-in var(--db-motion-base) var(--db-ease); }
      .wrap[data-phone] :is(.more-sheet:not([hidden]), .sheet-head:not([hidden])) { animation: db-sheet-in var(--db-motion-base) var(--db-ease); }
    }
    @keyframes db-drawer-in { from { transform: translateX(-16px); opacity: .6; } to { transform: none; opacity: 1; } }
    @keyframes db-sheet-in { from { transform: translateY(16px); opacity: .6; } to { transform: none; opacity: 1; } }
    @media (forced-colors: active) {
      .wrap[data-phone] :is(.menu-drawer, .more-sheet, .sheet-head, .rails) { border: 1px solid CanvasText; }
      .menu-row[aria-current="true"] { background: Highlight; color: HighlightText; }
    }
`;

/**
 * The Try it results sheet is drawn inside the canvas's shadow root (builder-panels.ts), which
 * the shell cannot style from outside and the canvas redraws wholesale: the shell adopts this
 * sheet into it while the results are up. The grab button in the head is the drag handle, a real button
 * with the same pill as the other sheets.
 *
 * No backticks in these comments: the sheet is a template literal.
 */
export const RESULTS_SHEET_STYLES = `
    :host([data-phone][data-results-open]) .try-sheet-head { position: sticky; flex-wrap: wrap; padding: 0; }
    :host([data-phone][data-results-open]) .try-grab {
      display: grid; place-items: center; flex: 1; min-block-size: 44px; margin: 0; margin-inline-start: 44px; padding: 0;
      border: 0; background: transparent; cursor: grab; touch-action: none;
    }
    :host([data-phone][data-results-open]) .try-grab::before {
      content: ""; inline-size: 40px; block-size: 5px; border-radius: var(--db-radius-pill); background: var(--db-line-card);
    }
    :host([data-phone][data-results-open]) .try-grab:focus-visible { outline: 2px solid var(--db-focus); outline-offset: -2px; }
    :host([data-phone][data-results-open]) .try-sheet-title { order: 3; flex: 1 0 100%; padding-bottom: var(--db-space-2); }
    :host([data-phone][data-results-open][data-results-tall]) .try-panel:not([hidden]) { max-height: calc(100% - 8px); }
`;
