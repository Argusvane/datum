/**
 * The Tests panel's look: the side drawer's list and the editor view of
 * a test, at the drawer's width (360 px: the panel's own default in `panel-memory.ts` PANEL_DRAWER_WIDTHS, its rows being sentences) and in the phone's sheet (the shell owns the
 * sheet; nothing here depends on the width). Every colour, size and radius is a builder `--db-*`
 * token (`web-component/studio-tokens.ts`), so a builder theme restyles the panel with the rest.
 * No backticks inside this literal (it is a template string; see the builder CSS memory).
 */
export const TESTS_PANEL_STYLES = `
  /*
   * The panel is a stack of cards (the drawer draws none): the view's cards scroll in .tests-in,
   * its padding leaving their shadows room, and the foot is a card under it that stays put.
   */
  .panel--tests { font-size: var(--db-text-md); }
  .tests-in { flex: 0 1 auto; margin: 0 calc(-1 * var(--db-space-2)); padding: 0 var(--db-space-2) var(--db-space-2); }
  .tests-in > .card { display: grid; gap: var(--db-space-3); }
  .tests-in > .card > :empty, .tests-view > :empty { display: none; }
  /* The title and the Run all row under it are siblings in one region: the gap keeps them apart. */
  .tests-head + .tests-row { margin-block-start: var(--db-space-3); }
  .tests-head--editor { overflow-wrap: anywhere; }
  .tests-sub { margin: var(--db-space-1) 0 0; color: var(--db-ink-muted); }
  .tests-row { display: flex; align-items: center; gap: var(--db-space-2); flex-wrap: wrap; }
  .tests-spacer { flex: 1; }
  .btn.dark { background: var(--db-selected); border-color: var(--db-selected); color: var(--db-selected-ink); }
  .btn.dark:hover:not(:disabled) { background: color-mix(in oklab, var(--db-selected) 84%, var(--db-surface)); }
  .btn.ghost { border-color: transparent; background: transparent; }
  .btn svg { width: 14px; height: 14px; flex: none; }
  /* The switch: a pill track whose knob sits right when on. */
  .tests-switch {
    display: inline-flex; align-items: center; gap: var(--db-space-2); min-block-size: 32px; padding: 0 var(--db-space-1);
    border: 0; background: transparent; color: var(--db-ink-muted); font: inherit; cursor: pointer; border-radius: var(--db-radius-pill);
  }
  .tests-switch .track { position: relative; inline-size: 30px; block-size: 18px; border-radius: var(--db-radius-pill); background: var(--db-line-input); flex: none; transition: background-color var(--db-motion-fast) var(--db-ease); }
  .tests-switch .track::after { content: ""; position: absolute; inset-block-start: 2px; inset-inline-start: 2px; inline-size: 14px; block-size: 14px; border-radius: 50%; background: var(--db-surface); transition: inset-inline-start var(--db-motion-fast) var(--db-ease); }
  .tests-switch[aria-checked="true"] .track { background: var(--db-accent); }
  .tests-switch[aria-checked="true"] .track::after { inset-inline-start: 14px; }
  .tests-filter { inline-size: 100%; }
  .tests-filter::placeholder { color: var(--db-ink-subtle); }
  /* The list: one row per scenario, a status dot, the name and the line under it. */
  .tests-list { list-style: none; margin: 0; padding: 0; display: grid; }
  .tests-list > li + li { border-block-start: var(--db-border-w) solid var(--db-line-divider); }
  .tests-list > li[hidden] { display: none; }
  .tests-entry {
    display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: var(--db-space-2); align-items: start; inline-size: 100%; text-align: start;
    padding: var(--db-space-2); border: 0; border-radius: var(--db-radius-sm); background: transparent; color: var(--db-ink); font: inherit; cursor: pointer;
  }
  .tests-entry:hover { background: var(--db-surface-hover); }
  .tests-entry:focus-visible { outline-offset: -2px; }
  .tests-entry[data-stale] .tests-entry-text, .tests-entry[data-stale] .d { opacity: .6; }
  .tests-entry-name { display: block; font-weight: 500; line-height: 1.3; overflow-wrap: anywhere; }
  .tests-entry-summary { display: block; margin-block-start: var(--db-space-half); font-size: var(--db-text-sm); color: var(--db-ink-muted); overflow-wrap: anywhere; }
  .tests-entry-summary[data-tone="bad"] { color: var(--db-danger); }
  .tests-entry-summary[data-tone="warn"] { color: var(--db-warn); }
  .d { display: inline-block; inline-size: 10px; block-size: 10px; border-radius: 50%; margin-block-start: 4px; box-sizing: border-box; }
  .d[data-tone="ok"] { background: var(--db-ok); }
  .d[data-tone="bad"] { background: var(--db-danger); }
  .d[data-tone="warn"] { background: var(--db-warn); }
  .d[data-tone="off"] { background: transparent; border: 2px solid var(--db-line-card); }
  .d[data-tone="run"] { background: transparent; border: 2px solid var(--db-accent); }
  .tests-empty { margin: 0; color: var(--db-ink-muted); }
  .tests-foot { display: flex; justify-content: space-between; align-items: center; gap: var(--db-space-2); flex-wrap: wrap; }
  .tests-foot--end { justify-content: flex-end; }
  /* The view between the frame and its parts adds no box: the frame's column lays the parts out. */
  .tests-view { display: contents; }
  .tests-status { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .tests-note { margin: 0; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  /* The problems under the box: a list of buttons that lead to their line. The editor's own sheet
     hides an element of this class inside its box for assistive technology; this list is shown. */
  ul.tests-problems {
    position: static; inline-size: auto; block-size: auto; margin: 0; padding: 0; overflow: visible; clip: auto; white-space: normal;
    list-style: none; display: grid; gap: var(--db-space-1);
  }
  ul.tests-problems[hidden] { display: none; }
  .tests-problem {
    display: block; inline-size: 100%; text-align: start; padding: var(--db-space-1) var(--db-space-2); border: 0; border-radius: var(--db-radius-sm);
    background: var(--db-danger-soft); color: var(--db-danger); font: inherit; font-size: var(--db-text-sm); cursor: pointer;
  }
  .tests-problem[data-severity="warning"] { background: var(--db-warn-soft); color: var(--db-warn); }
  /* The failure: the shared notice (.note) in its error or warning tone. */
  .why { display: grid; gap: var(--db-space-2); }
  .why .wt { margin: 0; font-weight: 600; color: var(--db-danger); display: flex; gap: var(--db-space-2); align-items: flex-start; overflow-wrap: anywhere; }
  .why[data-tone="warning"] .wt { color: var(--db-warn); }
  .why .wt svg { inline-size: 14px; block-size: 14px; flex: none; margin-block-start: 2px; }
  .why .kv { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--db-space-half) var(--db-space-3); font-size: var(--db-text-sm); }
  .why .kv dt { color: var(--db-ink-muted); }
  .why .kv dd { margin: 0; color: var(--db-ink); overflow-wrap: anywhere; font-family: var(--db-font-mono); }
  .why .btn { min-block-size: 28px; padding: 0 var(--db-space-3); font-size: var(--db-text-sm); background: var(--db-surface); }
  .why .btn.ghost { background: transparent; }
  /*
   * The Add step popover. It hangs from the whole actions row, not from its button (a flex item the size of the button): in a
   * narrow drawer the row is the scroller's width, so the menu is exactly that wide and cannot run past the panel's edge; in a
   * wide panel max-inline-size holds it to 300px. The height is fitted by the panel's script (fitPopover) to the room left in
   * the scroller, which this sheet cannot know, so max-block-size here is only the cap.
   */
  .tests-actions { position: relative; }
  /* Both popovers are the shared menu (.menu), placed and sized here. */
  .tests-add-pop {
    position: absolute; inset-block-start: calc(100% + var(--db-space-1)); inset-inline: 0;
    inline-size: auto; max-inline-size: 300px; max-block-size: 360px; overflow: auto; padding: var(--db-space-2); gap: var(--db-space-2);
  }
  .tests-add-field { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--db-space-1); }
  /* A select sizes to its longest option; in a narrow drawer it must shrink to the popover instead of pushing it sideways. */
  .tests-add-field select { inline-size: 100%; min-inline-size: 0; }
  .tests-add-menu { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--db-space-half); }
  .tests-add-group { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--db-space-half); }
  .tests-add-title { margin: var(--db-space-1) 0 0; padding: 0 var(--db-space-2); font-size: var(--db-text-sm); font-weight: 600; letter-spacing: .02em; color: var(--db-ink-muted); }
  .tests-add-item { display: grid; gap: var(--db-space-half); padding: var(--db-space-1) var(--db-space-2); }
  .tests-add-item code { font-family: var(--db-font-mono); font-size: var(--db-text-xs); color: var(--db-ink-subtle); overflow-wrap: anywhere; }
  /*
   * CodeMirror gives its gutters z-index 200, and a flex item with a z-index opens its own stacking context in whichever
   * one holds the editor. Both popovers hang right over the editor from the row above it, at --db-z-popover (40): without a
   * context of its own here the line numbers would paint over the menu's left edge. z-index 0 keeps the editor's layers inside.
   */
  .tests-editor-slot { min-inline-size: 0; position: relative; z-index: 0; }
  /* Record, Assert this, the rules and their tests. */
  .tests-row--end { justify-content: flex-end; }
  .tests-recording { display: flex; align-items: center; gap: var(--db-space-2); color: var(--db-ink); }
  .tests-rec-dot { inline-size: 8px; block-size: 8px; border-radius: 50%; background: var(--db-danger); flex: none; }
  .btn[data-tests-record][data-recording] svg { color: var(--db-danger); }
  .tests-assert { position: relative; }
  .tests-assert-pop {
    position: absolute; inset-block-start: 0; inset-inline: 0;
    inline-size: auto; max-inline-size: 320px; max-block-size: 420px; overflow: auto; padding: var(--db-space-2); gap: var(--db-space-2);
  }
  /* Insert and Cancel stay in reach however long the list of fields is: the foot sticks to the popover's bottom. */
  .tests-assert-pop > .tests-row--end {
    position: sticky; inset-block-end: calc(-1 * var(--db-space-2)); z-index: 1;
    margin-block-end: calc(-1 * var(--db-space-2)); padding-block: var(--db-space-2);
    background: var(--db-surface); border-block-start: var(--db-border-w) solid var(--db-line-divider);
  }
  .tests-assert-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--db-space-half); }
  .tests-assert-list > li[hidden] { display: none; }
  .tests-assert-item {
    display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--db-space-2); align-items: start;
    padding: var(--db-space-1) var(--db-space-2); border-radius: var(--db-radius-sm); cursor: pointer;
  }
  .tests-assert-item:hover { background: var(--db-surface-hover); }
  /* The text's first line centred on the 24px box (SHARED_CONTROL_STYLES). */
  .tests-assert-text { display: grid; gap: var(--db-space-half); min-inline-size: 0; padding-block-start: 3px; }
  .tests-assert-label { overflow-wrap: anywhere; }
  .tests-assert-hint { font-size: var(--db-text-xs); color: var(--db-ink-muted); }
  .tests-back { justify-self: start; }
  .tests-untested-line { margin: 0 0 var(--db-space-2); }
  .tests-rules { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--db-space-2); }
  .tests-rule {
    display: grid; gap: var(--db-space-1); justify-items: start; padding: var(--db-space-2) var(--db-space-3);
    border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-md);
  }
  .tests-rule[data-tested="false"] { border-style: dashed; }
  .tests-rule-text { margin: 0; color: var(--db-ink); overflow-wrap: anywhere; }
  .tests-rule-kind { font-weight: 600; margin-inline-end: var(--db-space-1); }
  .tests-rule-pins { margin: 0; display: flex; flex-wrap: wrap; gap: var(--db-space-1); align-items: center; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  .tests-rule-untested { color: var(--db-warn); font-weight: 500; }
  .tests-pin {
    border: 0; border-radius: var(--db-radius-sm); padding: 1px var(--db-space-2); background: var(--db-accent-soft); color: var(--db-accent-text);
    font: inherit; font-size: var(--db-text-sm); font-weight: 500; cursor: pointer;
  }
  .tests-pin:hover { text-decoration: underline; }
`;
