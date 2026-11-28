import type {
  InspectorAssetChoice,
  InspectorChoice,
  InspectorField,
  InspectorModel,
  InspectorSection
} from "../property-editor/inspector-model.js";
import {
  formatExpressionJson,
  isExpression,
  ruleRunControl,
  type RuleEditorMode,
  type RuleEditorState,
  type RuleRunControl
} from "../property-editor/rules-model.js";
import { builderPlural, builderText, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import { PANEL_LOOK_CLASSES, PANEL_LOOK_GROUP } from "../../render/live/look-classes.js";
import { FORMULA_EDITOR_STYLES } from "../formula/formula-editor-styles.js";
import type { NestedTreeNodeView } from "../tree-editor/nested-tree-view.js";
import type { BuilderModeWays } from "./builder-modes.js";
import { BUILTIN_ICONS, ICON_FALLBACK_CLASS, defaultIconSet, renderIcon, svgIconMarkup, type IconSet } from "../../render/icons/icon-set.js";
import { BUILTIN_ICON_ATTRS } from "../../render/icons/builtin-icons.js";
import { PALETTE_GLYPH_BODIES, PALETTE_GLYPH_VIEWBOX } from "./palette-glyphs.js";
import type { DatumIconName } from "../../render/icons/icon-names.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { BuilderController, BuilderIdRow, FormIdentity, TranslatableText } from "../controller/builder-controller.js";
import type { FormTranslations, TranslationCatalog } from "../../core/localization/translations.js";
import { textsCoverage, translationColumns, wordedTexts } from "../languages/languages-cells.js";
import { formatFileSize, isBase64FileAttachment, isFileAttachment } from "../../core/schema/file-upload.js";
import { DATA_GRID_COMPONENT_TYPE } from "../../core/schema/data-grid.js";
import { escapeHtml } from "../../render/core/escape-html.js";

import type { FormChromePart, FormChromePartType, FormChromeRegion } from "../../core/schema/form-chrome.js";
import { DATA_KEY_PROPERTY, holdsData, isDataScopeContainer } from "../../core/tree/data-scope.js";
import { studioLightValue, studioTokenDeclarations, studioTokenRules } from "./studio-tokens.js";
import { STUDIO_DARK_TOKENS } from "./studio-dark-theme.js";
import { formulaSettingsSectionHtml, type FormulaSettingsView } from "./formula-settings.js";
import { assistantsSettingsSectionHtml, type AssistantsSettingsView } from "./assistants-settings.js";
import { MODAL_BACKDROP_CLIP, MODAL_H, MODAL_INSET, MODAL_W } from "./modal-place.js";

/** Re-exported so the builder panels keep one escaper, shared with the form markup. */
export const esc = escapeHtml;

/**
 * A sentence whose template is the catalog's but which holds markup (a name, a `<code>` id):
 * the template's own words are escaped and each `{slot}` becomes the markup given for it. `render`
 * fills the template with the stand-ins it is handed, so one call serves a plain key and a plural.
 */
function htmlWith(render: (slots: Record<string, string>) => string, html: Record<string, string>): string {
  const marks: Record<string, string> = {};
  for (const name of Object.keys(html)) {
    marks[name] = `\u0001${name}\u0001`;
  }
  return esc(render(marks)).replace(/\u0001(\w+)\u0001/g, (whole, name: string) => html[name] ?? whole);
}

/**
 * The box a docked panel draws itself in: the palette's, the outline's, the inspector's — and
 * the shell's own View panel, which is plain markup in the shell's shadow root rather than an
 * element of its own. Shared so the two roots cannot drift: a panel that did not
 * match the others would read as a hole in the column rather than a panel.
 */
export const PANEL_BOX_STYLES = `
    /* Studio: the drawer around a panel is the card (the shell draws it), so the panel draws no second frame. */
    .panel {
      position: relative;
      background: var(--db-surface);
      border: 0;
      border-radius: 0;
      padding: var(--db-space-3) var(--db-space-4);
      height: 100%;
      overflow: auto;
    }
    .panel-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; margin-bottom: 8px;
    }
    /* A panel of separate cards (its host data-floating, so the drawer draws none): it scrolls them, a pinned one held at its edge. */
    .panel.card-stack { height: auto; max-height: 100%; margin: 0 calc(-1 * var(--db-space-2)); padding: 0 var(--db-space-2) var(--db-space-2); background: none; overflow: auto; pointer-events: auto; }
    :where(.panel.card-stack .card) { padding: var(--db-space-3) var(--db-space-4); }
    .card-stack > .is-pinned { position: sticky; top: 0; bottom: 0; z-index: 1; }`;

/**
 * The rules every builder shadow root shares, printed by `builderTokens()` and by the shell
 * (which does not use `builderTokens()`), so the shell's own panels (View, Settings) draw
 * their buttons, fields and dropdowns as the docked panels do.
 *
 * Keyboard focus is a ring, never a colour change alone: 2px of --db-focus, 2px outside the
 * control, on every button, field and disclosure. It sits in `:where()` so it adds no
 * specificity: any surface's own one-class rule (an inset ring in a scrolling list, the
 * on-dark ring on the selection bar) wins without a fight.
 *
 * A dropdown is drawn by the builder, not the browser: left to itself Safari keeps its own
 * face, height and corners on a select whatever the rules beside this one say, so the same
 * box read three ways across browsers. The arrow is two gradients in the box's own ink, so
 * it follows the scheme and forced colours. Only the arrow and the room for it are set here;
 * each panel's own rule keeps the box's line, fill and size. Never the form on the canvas,
 * which is its theme's to draw.
 */
export const FOCUS_AND_SELECT_STYLES = `
    :where(button, input, select, textarea, summary, a[href]):focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
    select:not([multiple]):not([size]):not(.canvas-surface select) {
      -webkit-appearance: none; appearance: none;
      background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
      background-repeat: no-repeat; background-size: 5px 5px, 5px 5px;
      background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%;
      padding-inline-end: 32px; text-overflow: ellipsis;
    }
    select:not([multiple]):not([size]):not(.canvas-surface select):dir(rtl) { background-position: 12px 50%, 17px 50%; }
    /* Forced colours drop a drawn gradient, so the browser's own arrow comes back. */
    @media (forced-colors: active) {
      select:not([multiple]):not([size]):not(.canvas-surface select) { -webkit-appearance: auto; appearance: auto; background-image: none; }
    }`;

/*
 * The shared patterns: one definition of each look the workspaces, panels and drawers draw, so a
 * surface uses the class instead of writing its own copy. builderTokens() prints all of them; the
 * shell prints the class patterns and the tooltips for its own panels and the modes' overlays.
 *
 *   Pattern              Classes and hooks                                  Constant
 *   checkbox, radio      input[type=checkbox|radio]: 24px, the strong fill  SHARED_CONTROL_STYLES
 *   text box             input (text-like), select, textarea                SHARED_CONTROL_STYLES
 *   field label          .field > .field-label, .field > label              SHARED_CONTROL_STYLES
 *   segmented control    .seg track; .seg-btn or .seg > button segments     SHARED_PATTERN_STYLES
 *   tool switched on     .tool-toggle, aria-pressed|expanded=true, .btn     CONFIRM_STYLES
 *   empty state          .empty-state; .empty-state.is-page                 SHARED_PATTERN_STYLES
 *   card headings        .card-title (h2), .card-heading (h3), .card-lead   SHARED_PATTERN_STYLES
 *   links                .link-btn (go somewhere), .row-link (row's name)   SHARED_PATTERN_STYLES
 *   notice               .note, data-tone="info|warning|error"              SHARED_PATTERN_STYLES
 *   inline confirmation  .note.confirm[data-tone=warning] > .confirm-actions SHARED_PATTERN_STYLES
 *   menu                 .menu, .menu-item, .menu-item.danger               SHARED_PATTERN_STYLES
 *   chips                .ref-chip (a field reference), .try-chip           SHARED_PATTERN_STYLES
 *   cards                .card, .card-stack (a scrolling column of cards)   SHARED_PATTERN_STYLES
 *   tooltip              data-tip="words", data-tip-side="top|start|end"    TIP_STYLES
 *   editor column        var(--db-editor-min) to var(--db-editor-max)       studio-tokens.ts
 *
 * Pressed has two meanings. The strong --db-selected fill is the current choice among several:
 * a tab, a segment, a filter, a .btn with aria-pressed. The pale accent (--db-accent-soft under
 * --db-accent-text) is a tool that is switched on: .tool-toggle, and the canvas bar's toggles.
 *
 * Every rule is one class (with a child, a variant or a state at most) or sits in :where(), so a
 * surface's own rule for the same class still wins and markup without the class is untouched.
 * The element rules (the boxes, the tick boxes) are :where() alone and only reach the builder's
 * own roots: the form on the canvas is drawn in the renderer's shadow root, out of their reach.
 */

/** The tick boxes, the text boxes and a field's label: 13px labels, 14px boxes. */
export const SHARED_CONTROL_STYLES = `
    :where(input[type="checkbox"], input[type="radio"]) {
      inline-size: 24px; block-size: 24px; flex: none; margin: 0; accent-color: var(--db-selected); cursor: pointer;
    }
    :where(input[type="checkbox"], input[type="radio"]):disabled { cursor: default; }
    :where(input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="color"]), select, textarea) {
      min-block-size: var(--db-control-h); padding: 0 var(--db-space-3);
      border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-md);
      background-color: var(--db-surface); color: var(--db-ink); font-family: inherit; font-size: var(--db-text-base);
    }
    /* A textarea is as tall as its rows, and its text starts clear of the line. */
    :where(textarea) { min-block-size: 0; padding: var(--db-space-2) var(--db-space-3); }
    :where(.field) { display: grid; gap: var(--db-space-1); min-width: 0; }
    :where(.field) > :where(.field-label, label):where(:not(.choice)) { font-size: var(--db-text-md); font-weight: 500; color: var(--db-ink); }`;

/**
 * The class patterns (see the table above). Notices: info has no line or wash token of its own,
 * so it is the sunken well under the divider line; warning and error are their tone's pair. A
 * .card-stack is the scroller and its cards keep their height; their shadows are clipped at its
 * edges, so a stack that needs them whole leaves itself padding.
 */
export const SHARED_PATTERN_STYLES = `
    .seg {
      display: inline-flex; flex-wrap: wrap; gap: var(--db-space-half); padding: var(--db-space-half);
      border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-pill);
    }
    .seg-btn, .seg > button {
      display: inline-flex; align-items: center; justify-content: center; gap: var(--db-space-1);
      min-block-size: 32px; padding: 0 var(--db-space-3); border: 0; border-radius: var(--db-radius-pill);
      background: transparent; color: var(--db-ink-muted); font: inherit; font-size: var(--db-text-sm); font-weight: 500; cursor: pointer;
      transition: background-color var(--db-motion-fast) var(--db-ease), color var(--db-motion-fast) var(--db-ease);
    }
    .seg-btn:hover, .seg > button:hover { background: var(--db-surface-hover); color: var(--db-ink); }
    :is(.seg-btn, .seg > button):is([aria-pressed="true"], [aria-selected="true"], [aria-checked="true"]) { background: var(--db-selected); color: var(--db-selected-ink); }
    :is(.seg-btn, .seg > button):disabled { opacity: .45; cursor: default; }
    :where(.empty-state) { display: grid; justify-items: start; gap: var(--db-space-2); padding: var(--db-space-6) var(--db-space-4); }
    :where(.empty-state) > :where(h2, h3) { margin: 0; font-size: var(--db-text-lg); font-weight: 600; }
    :where(.empty-state) > :where(p) { margin: 0; font-size: var(--db-text-md); color: var(--db-ink-muted); }
    /* No document yet: a card of its own in the middle of the room. */
    .empty-state.is-page {
      max-inline-size: 560px; margin: var(--db-space-8) auto; gap: var(--db-space-3); padding: var(--db-space-5) var(--db-space-6);
      border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-xl); background: var(--db-surface); box-shadow: var(--db-shadow-card);
    }
    .empty-state.is-page > :is(h2, h3) { font-size: var(--db-text-xl); line-height: 1.2; }
    :host([data-phone]) .empty-state.is-page { margin-inline: var(--db-space-3); padding: var(--db-space-4); }
    :where(.card-title, .card-heading, .card-lead) { margin: 0; }
    :where(.card-title) { font-size: var(--db-text-lg); font-weight: 600; }
    :where(.card-heading) { font-size: var(--db-text-md); font-weight: 600; }
    :where(.card-lead) { font-size: var(--db-text-sm); color: var(--db-ink-muted); }
    :where(.link-btn, .row-link) {
      padding: 0; border: 0; background: none; font: inherit; text-align: start; cursor: pointer;
      text-decoration: underline; text-underline-offset: 3px;
    }
    :where(.link-btn) { color: var(--db-accent-text); }
    :where(.row-link) { color: var(--db-ink); font-weight: 500; text-decoration-color: var(--db-line-input); }
    :where(.note) {
      margin: 0; padding: var(--db-space-2) var(--db-space-3); border: var(--db-border-w) solid var(--db-line-divider);
      border-radius: var(--db-radius-md); background: var(--db-surface-sunken); font-size: var(--db-text-sm);
    }
    :where(.note[data-tone="warning"]) { border-color: var(--db-warn-line); background: var(--db-warn-soft); }
    :where(.note[data-tone="error"]) { border-color: var(--db-danger-line); background: var(--db-danger-soft); }
    :where(.note.confirm) { display: grid; gap: var(--db-space-2); }
    :where(.note.confirm) > p { margin: 0; }
    :where(.confirm-actions) { display: flex; flex-wrap: wrap; gap: var(--db-space-2); }
    :where(.menu) {
      z-index: var(--db-z-popover); display: flex; flex-direction: column; gap: var(--db-space-half); min-inline-size: 160px;
      padding: var(--db-space-1); background: var(--db-surface); color: var(--db-ink);
      border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-lg); box-shadow: var(--db-shadow-overlay);
    }
    :where(.menu)[hidden] { display: none; }
    :where(.menu-item) {
      display: flex; align-items: center; gap: var(--db-space-2); inline-size: 100%; min-block-size: 36px; padding: 0 var(--db-space-3);
      border: 0; border-radius: var(--db-radius-sm); background: transparent; color: var(--db-ink);
      font: inherit; font-size: var(--db-text-md); text-align: start; cursor: pointer;
    }
    :where(.menu-item):is(:hover, :focus-visible) { background: var(--db-surface-hover); }
    :where(.menu-item):focus-visible { outline: 2px solid var(--db-focus); outline-offset: -2px; }
    :where(.menu-item.danger) { color: var(--db-danger); }
    :where(.menu-item.danger):hover { background: var(--db-danger-soft); }
    :where(.menu-item):is(:disabled, [aria-disabled="true"]) { opacity: .45; background: transparent; cursor: default; }
    :where(.ref-chip, .try-chip) { display: inline-flex; align-items: center; min-block-size: 24px; padding: 0 var(--db-space-2); font-size: var(--db-text-sm); }
    :where(.ref-chip) { border-radius: var(--db-radius-xs); background: var(--db-accent-soft); color: var(--db-accent-text); font-weight: 500; }
    :where(.try-chip) {
      border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-pill);
      background: var(--db-surface); color: var(--db-ink); font-family: var(--db-font-mono); cursor: pointer;
    }
    :where(.try-chip):hover { background: var(--db-surface-hover); }
    :where(.card) { background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-xl); box-shadow: var(--db-shadow-card); }
    :where(.card-stack) { display: flex; flex-direction: column; gap: var(--db-space-3); min-height: 0; overflow: auto; }
    :where(.card-stack) > * { flex: none; min-width: 0; }
    @media (pointer: coarse) {
      .seg-btn, .seg > button { min-block-size: 44px; }
      :where(.menu-item) { min-block-size: 44px; }
    }
    @media (forced-colors: active) {
      :is(.seg-btn, .seg > button):is([aria-pressed="true"], [aria-selected="true"], [aria-checked="true"]):not(:focus-visible) { outline: 2px solid Highlight; outline-offset: -4px; }
      :where(.menu-item):is(:disabled, [aria-disabled="true"]) { color: GrayText; opacity: 1; }
    }`;

/**
 * Tooltips for an icon-only button, in any root: drawn, not the browser's title, so they show
 * on keyboard focus as well as on hover, within a moment rather than a second. data-tip holds
 * the words, which repeat the button's aria-label for the eye and add nothing to what is read.
 * Below the button by default; data-tip-side="top", "start" or "end" puts it there. The tip is
 * the button's ::after, so an ancestor that clips (overflow hidden or a scroller) clips it too,
 * and it stacks only within the button's own stacking context: a pill or a drawer that clips
 * puts its tips on the side with room. A touch pointer has no hover, so there the tip shows on
 * keyboard focus alone.
 */
export const TIP_STYLES = `
    :where([data-tip]) { position: relative; }
    :where([data-tip])::after {
      content: attr(data-tip); position: absolute; top: calc(100% + 10px); left: 50%; z-index: 1; transform: translateX(-50%);
      padding: var(--db-space-1) var(--db-space-2); border-radius: var(--db-radius-sm);
      background: var(--db-ink); color: var(--db-surface); box-shadow: var(--db-shadow-pill);
      font-family: var(--db-font); font-size: var(--db-text-xs); font-weight: 500; line-height: 1.3; white-space: nowrap;
      pointer-events: none; opacity: 0; transition: opacity var(--db-motion-fast) var(--db-ease);
    }
    :where([data-tip-side="top"])::after { top: auto; bottom: calc(100% + 10px); }
    :where([data-tip-side="start"], [data-tip-side="end"])::after { top: 50%; left: auto; transform: translateY(-50%); }
    :where([data-tip-side="start"])::after { inset-inline-end: calc(100% + 10px); }
    :where([data-tip-side="end"])::after { inset-inline-start: calc(100% + 10px); }
    @media (hover: hover) { :where([data-tip]):hover::after { opacity: 1; transition-delay: 250ms; } }
    :where([data-tip]):focus-visible::after { opacity: 1; transition-delay: 0ms; }
    @media (forced-colors: active) {
      :where([data-tip])::after { border: 1px solid CanvasText; background: Canvas; color: CanvasText; }
    }`;

/**
 * Icon buttons: round and borderless, the hover a fill; 32px, past WCAG 2.5.8's 24. Printed in
 * every panel and in the shell, for the modes' overlays there (the PDF preview's head).
 */
export const ICON_BUTTON_STYLES = `
    .icon-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: var(--db-space-1);
      min-inline-size: 32px; min-block-size: 32px; padding: 0 var(--db-space-2);
      border: 0; border-radius: var(--db-radius-pill); background: transparent; color: var(--db-ink-muted);
      font: inherit; font-size: var(--db-text-sm); font-weight: 500; cursor: pointer;
      transition: background-color var(--db-motion-fast) var(--db-ease), color var(--db-motion-fast) var(--db-ease);
    }
    @media (pointer: coarse) { .icon-btn { min-inline-size: 44px; min-block-size: 44px; } }
    .icon-btn:hover:not(:disabled) { background: var(--db-surface-hover); color: var(--db-ink); }
    /* Nothing to undo, nothing to redo: the button stays where it is, faded rather than gone. */
    .icon-btn:disabled { opacity: .4; cursor: default; }
    .icon-btn svg { width: var(--db-icon-size); height: var(--db-icon-size); }`;

/** Shared design tokens + base rules for every builder panel's shadow root. */
export function builderTokens(): string {
  return `
    :host {
      display: block;
      /*
       * The studio tokens (studio-tokens.ts): one list printed here and in the shell, so the
       * panels and the shell can no longer drift apart. The values and their contrast floors are
       * explained there.
       */
${studioTokenDeclarations()}
      color: var(--db-ink);
      font-family: var(--db-font);
    }
${studioTokenRules()}
    * { box-sizing: border-box; }
${PANEL_BOX_STYLES}
${FOCUS_AND_SELECT_STYLES}
${SHARED_CONTROL_STYLES}
${ICON_BUTTON_STYLES}
    /* A glyph slot is never the hit target — the click belongs to the control around it. */
    .glyph { display: inline-flex; align-items: center; pointer-events: none; }
    .empty { color: var(--db-ink-muted); margin: 0; font-size: var(--db-text-md); }
    .drop-error { color: var(--db-danger); margin: 0 0 var(--db-space-2); }
    ${CONFIRM_STYLES}
${SHARED_PATTERN_STYLES}
${TIP_STYLES}
  `;
}

/**
 * The panel's prompts — a delete, which takes a whole subtree with it from a control on hover
 * chrome a pointer can reach by accident, and leaving a component with unsaved edits — ask
 * first, and ask in a way nothing else can be clicked past: each is a `<dialog>` the panel
 * opens with `showModal()`, so the browser's top layer puts it above every stacking context
 * on the page and everything outside it — the canvas, the palette, the host's own chrome — is
 * inert until it is answered. It is drawn over the builder's own box, and only that box is
 * dimmed (modal-place.ts): a builder embedded in a page keeps its prompts to itself. Not `window.confirm`, which is blocking, unstyleable and
 * unavailable in a non-browser DOM the panels are also expected to run under. Exported for a
 * mode that draws the same prompt over its own surface (the PDF designer's template mapping).
 */
export const CONFIRM_STYLES = `
  dialog.db-confirm {
    /* Over the builder's own box, not the window (modal-place.ts): the insets and the size are the shell's. */
    position: fixed; inset: ${MODAL_INSET}; margin: auto; height: fit-content;
    width: min(360px, calc(${MODAL_W} - 32px)); max-height: calc(${MODAL_H} - 32px);
    background: var(--db-surface); color: var(--db-ink); border: var(--db-border-w) solid var(--db-line-card);
    border-radius: var(--db-radius-lg); padding: var(--db-space-5); box-shadow: var(--db-shadow-overlay);
    font-family: var(--db-font); font-size: var(--db-text-md); line-height: 1.4;
  }
  /* The backdrop is no descendant of the dialog, so the token carries a fallback for engines
     that do not let ::backdrop see custom properties (the studio scrim's own value). */
  dialog.db-confirm::backdrop { background: var(--db-scrim, rgba(22, 23, 26, .42)); ${MODAL_BACKDROP_CLIP} }
  .db-confirm h4 { margin: 0 0 var(--db-space-2); font-size: var(--db-text-lg); font-weight: 600; line-height: 1.2; }
  .db-confirm p { margin: 0 0 var(--db-space-4); font-size: var(--db-text-md); color: var(--db-ink-muted); }
  .db-confirm p.db-confirm-note { color: var(--db-danger); }
  .db-confirm ul.db-confirm-problems { margin: calc(-1 * var(--db-space-2)) 0 var(--db-space-4); padding-inline-start: var(--db-space-5); font-size: var(--db-text-md); color: var(--db-danger); }
  .db-confirm-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--db-space-2); }
  .db-confirm code { font-family: var(--db-font-mono); }
  /* What else names the component a delete removes: the list, then the box that takes them along. */
  .db-confirm p.db-confirm-dependents-head { margin-block-end: var(--db-space-1); color: var(--db-ink); }
  .db-confirm ul.db-confirm-dependents { margin: 0 0 var(--db-space-3); padding-inline-start: var(--db-space-5); font-size: var(--db-text-md); color: var(--db-ink-muted); }
  .db-confirm label.db-confirm-also { display: flex; align-items: center; gap: var(--db-space-2); font-size: var(--db-text-md); color: var(--db-ink); }
  .db-confirm p.db-confirm-keep { margin: var(--db-space-1) 0 var(--db-space-4); font-size: var(--db-text-sm); }
  /*
   * Buttons are pills: white with an input-weight line, the accent fill for a primary, the
   * strong --db-selected fill for the commit that closes a panel or a dialog (the studio's
   * Apply), and danger as red words on white with a red line.
   */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: var(--db-space-2);
    min-block-size: 36px; padding: 0 var(--db-space-4);
    border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-pill);
    background: var(--db-surface); color: var(--db-ink);
    font: inherit; font-size: var(--db-text-md); font-weight: 500; line-height: 1.2; cursor: pointer;
    transition: background-color var(--db-motion-fast) var(--db-ease), border-color var(--db-motion-fast) var(--db-ease);
  }
  .btn:hover:not(:disabled) { background: var(--db-surface-hover); }
  .btn:disabled { opacity: .45; cursor: default; }
  /* The smaller button every surface shares (a row's action, a card's footer); a touch pointer gets the full target back. */
  .btn.small { min-block-size: 32px; padding: 0 var(--db-space-3); font-size: var(--db-text-sm); }
  .btn.primary { background: var(--db-accent); border-color: var(--db-accent); color: var(--db-accent-ink); }
  .btn.primary:hover:not(:disabled) { background: var(--db-accent-hover); border-color: var(--db-accent-hover); }
  .btn.danger { background: var(--db-surface); border-color: var(--db-danger-line); color: var(--db-danger); }
  .btn.danger:hover:not(:disabled) { background: var(--db-danger-soft); }
  .btn[aria-pressed="true"], .btn[aria-pressed="true"]:hover:not(:disabled) { background: var(--db-selected); border-color: var(--db-selected); color: var(--db-selected-ink); }
  /* A tool switched on (Show hidden, Record) is the pale accent, not the strong fill of a current choice: after the rule above, which it overrides at equal weight. */
  .tool-toggle:is([aria-pressed="true"], [aria-expanded="true"]), .tool-toggle:is([aria-pressed="true"], [aria-expanded="true"]):hover:not(:disabled) { background: var(--db-accent-soft); border-color: var(--db-accent); color: var(--db-accent-text); }
  .db-confirm-actions .btn.primary { background: var(--db-selected); border-color: var(--db-selected); color: var(--db-selected-ink); }
  .db-confirm-actions .btn.primary:hover:not(:disabled) { background: color-mix(in oklab, var(--db-selected) 84%, var(--db-surface)); }
  @media (pointer: coarse) { .btn.small { min-block-size: 44px; } }
  @media (forced-colors: active) {
    .btn:disabled, .icon-btn:disabled { color: GrayText; border-color: GrayText; opacity: 1; }
    .tool-toggle:is([aria-pressed="true"], [aria-expanded="true"]):not(:focus-visible) { outline: 2px solid Highlight; outline-offset: -2px; }
  }
`;

export interface DeleteConfirmation {
  componentId: string;
  /** The component's display label, shown so the author can tell which one this is. */
  label: string;
  /** Number of components that go with it, so a container's blast radius is visible. */
  descendantCount: number;
  /**
   * The id the dialog names it by beside its label: `componentId` when absent, the text its ID
   * row shows, or `false` where the inspector shows it none — a builder's own node id, never the
   * author's (`journey-page_2`), which the label alone names.
   */
  idShown?: string | false | undefined;
  /**
   * What else in the form names it (`BuilderController.dependentsOf`), worded by
   * `dependentsHeading` and `dependentLines`. Absent or empty: the dialog is the plain one.
   * Present: the list, and an "Also remove references" box (`data-confirm-also-remove`), unticked.
   */
  dependents?: { heading: string; lines: readonly string[] } | undefined;
}

/**
 * The confirmation for a pending delete: a `<dialog>` the panel shows modally (see
 * `CONFIRM_STYLES`). Returns `""` when nothing is pending, so a caller can drop it straight
 * into its markup.
 */
export function deleteConfirmHtml(pending: DeleteConfirmation | undefined, words?: BuilderTextOptions): string {
  if (!pending) {
    return "";
  }
  const what = `“${esc(pending.label)}”${pending.idShown === false ? "" : ` (<code>${esc(pending.idShown ?? pending.componentId)}</code>)`}`;
  const body = htmlWith(
    (slots) =>
      pending.descendantCount > 0
        ? builderPlural("confirm.delete.bodyInside", pending.descendantCount, slots, words)
        : builderText("confirm.delete.body", slots, words),
    { what }
  );
  // The places that name it, and the box that takes them along in the same undo step; the
  // note under the box says what happens to them without it.
  const dependents = pending.dependents && pending.dependents.lines.length > 0 ? pending.dependents : undefined;
  const dependentsBlock = dependents
    ? `<p class="db-confirm-dependents-head" id="db-confirm-dependents-head">${esc(dependents.heading)}</p>
      <ul class="db-confirm-dependents" data-confirm-dependents aria-labelledby="db-confirm-dependents-head">${dependents.lines
        .map((line) => `<li>${esc(line)}</li>`)
        .join("")}</ul>
      <label class="db-confirm-also"><input type="checkbox" data-confirm-also-remove aria-describedby="db-confirm-keep" />${esc(
        builderText("confirm.delete.alsoRemove", undefined, words)
      )}</label>
      <p class="db-confirm-keep" id="db-confirm-keep">${esc(builderText("confirm.delete.dependents.keep", undefined, words))}</p>`
    : "";
  // Focus lands on Cancel: the destructive answer to a question a stray click raised should
  // take a deliberate move, not the Enter the author was already pressing.
  return `<dialog class="db-confirm" role="alertdialog" aria-label="${esc(builderText("confirm.delete.label", undefined, words))}" data-prompt data-delete-prompt>
      <h4>${esc(builderText("confirm.delete.title", undefined, words))}</h4>
      <p>${body}</p>${dependentsBlock}
      <div class="db-confirm-actions">
        <button type="button" class="btn" data-confirm-cancel autofocus>${esc(builderText("common.cancel", undefined, words))}</button>
        <button type="button" class="btn danger" data-confirm-delete="${esc(pending.componentId)}">${esc(builderText("common.delete", undefined, words))}</button>
      </div>
    </dialog>`;
}

export interface UnsavedChangesPromptView {
  componentId: string;
  /** The component's display label, so the author can tell which edits these are. */
  label: string;
  /** What the author was doing (the controller's `HeldActionKind`); the wording follows it. */
  action: "select" | "add" | "drop" | "leave" | "replace" | "remove" | "panel";
  /** The form root's draft (the Form panel, Header & footer): named as the form's settings, not by its id. */
  isRoot?: boolean;
  /** Save is refused while the draft has a problem (an unusable id, class or data key), and the prompt says so. */
  blocked: boolean;
  /** What is wrong, in words, when {@link blocked}: the prompt lists it, and Keep editing leads there. */
  problems?: readonly string[];
}

/** How the prompt names what the author was about to do, per `UnsavedChangesPromptView.action`. */
function heldActionPhrase(action: UnsavedChangesPromptView["action"], words?: BuilderTextOptions): string {
  return builderText(`confirm.unsaved.action.${action}`, undefined, words);
}

/**
 * The prompt the properties panel puts up when the author leaves a component whose edits
 * are still a draft — a click on another component, on the canvas background, on the
 * palette, a drop, or the host taking them off the builder page (`requestLeave`). The canvas
 * previews a draft as though it were saved, so without this the click away is the moment the
 * edit quietly stops being real while the author believes it landed. The same modal
 * `<dialog>` as the delete confirmation (see `CONFIRM_STYLES`). Returns `""` when nothing is
 * pending.
 */
export function unsavedChangesPromptHtml(prompt: UnsavedChangesPromptView | undefined, words?: BuilderTextOptions): string {
  if (!prompt) {
    return "";
  }
  const problems = prompt.problems ?? [];
  const note = prompt.blocked
    ? problems.length > 0
      ? `<p class="db-confirm-note">${esc(builderPlural("confirm.unsaved.blocked", problems.length, undefined, words))}</p>
        <ul class="db-confirm-problems">${problems.map((problem) => `<li>${esc(problem)}</li>`).join("")}</ul>`
      : `<p class="db-confirm-note">${esc(builderText("confirm.unsaved.blockedPanel", undefined, words))}</p>`
    : "";
  const action = heldActionPhrase(prompt.action, words);
  const bodyText = prompt.isRoot
    ? esc(builderText("confirm.unsaved.bodyForm", { action }, words))
    : htmlWith((slots) => builderText("confirm.unsaved.body", { ...slots, action }, words), {
        what: htmlWith((slots) => builderText("confirm.unsaved.what", slots, words), {
          label: esc(prompt.label),
          id: `<code>${esc(prompt.componentId)}</code>`
        })
      });
  // Focus lands on Apply — what the author believed had already happened. A refused Apply is
  // not focusable, so focus falls to the first usable button, Keep editing.
  return `<dialog class="db-confirm" role="alertdialog" aria-label="${esc(builderText("confirm.unsaved.label", undefined, words))}" data-prompt data-unsaved-prompt>
      <h4>${esc(builderText("confirm.unsaved.label", undefined, words))}</h4>
      <p>${bodyText}</p>
      ${note}
      <div class="db-confirm-actions">
        <button type="button" class="btn" data-unsaved-stay>${esc(builderText("confirm.unsaved.keep", undefined, words))}</button>
        <button type="button" class="btn danger" data-unsaved-discard>${esc(builderText("common.discard", undefined, words))}</button>
        <button type="button" class="btn primary" data-unsaved-save autofocus${prompt.blocked ? " disabled" : ""}>${esc(builderText("common.apply", undefined, words))}</button>
      </div>
    </dialog>`;
}

// --- options editor -------------------------------------------------------

/** One inline option (or validation message) as the editor works on it: the key and its default-language text (translations are the Languages workspace's). */
export interface OptionsEditorRow {
  value: string;
  label: string;
  /**
   * Options only: the line of help under the option (`InlineOption.description`), in the
   * default language. Edited in the Description column the dialog shows once "Descriptions"
   * is on; absent or blank means the option has none.
   */
  description?: string | undefined;
  /** Messages only: what the code means, read-only beside it (an engine or host description). */
  meaning?: string | undefined;
  /**
   * Messages only: a code this component's own constraints can raise. Listed whether or not
   * it has a message — a blank row keeps the page's or engine's wording — so the author sees
   * everything the field can say in one place. It cannot be removed, only cleared.
   */
  seeded?: boolean | undefined;
  /**
   * Messages only: the page's own wording for the code, in the default language — what a blank
   * row shows on the form. Drawn as the cell's placeholder, and copied in by "Use default" so
   * the author can start from it rather than from nothing.
   */
  fallback?: { default: string } | undefined;
}

/** Whether a row carries any text at all. */
export function optionsRowHasText(row: OptionsEditorRow): boolean {
  return row.label.trim().length > 0;
}

/** The dialog's window geometry once the author has moved or resized it. */
export interface OptionsEditorFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * What the keyed-text dialog edits. `options` is a field's inline choices (key → label);
 * `messages` is a component's validation text per error code (code → message).
 * Same table, same handlers, same `data-options-*` protocol — only the words change.
 */
export type OptionsEditorKind = "options" | "messages";

export interface OptionsEditorView {
  /** Which list this is; absent means inline options, the dialog's first job. */
  kind?: OptionsEditorKind | undefined;
  /** The property the list is written to (`options`, `messages`); the dialog's identity across repaints. */
  path: string;
  /** Names the component the rows belong to. */
  title: string;
  rows: OptionsEditorRow[];
  /** The add-row inputs as typed so far. */
  newValue: string;
  newLabel: string;
  error: string | undefined;
  /** The data source the component names, if any — it takes precedence over the inline list. */
  sourceId: string | undefined;
  /**
   * Options only: whether the Description columns are shown. Off until an option carries a
   * description or the author presses "Descriptions", so the common list of plain choices
   * is not widened by columns nobody fills.
   */
  showDescriptions?: boolean | undefined;
  /**
   * Keys worth offering for the add row, in titled groups drawn as chips under the table —
   * for the messages editor, the validation codes this form or field raises, then the rest
   *. A click puts the key in the add row's key box. A collapsed group sits
   * behind a "more" disclosure so the ones that matter here stay in front.
   */
  suggestions?: OptionsEditorSuggestionGroup[] | undefined;
  maximized: boolean;
  frame?: OptionsEditorFrame | undefined;
  /** The builder's words (locale and catalog); English when absent. */
  words?: BuilderTextOptions | undefined;
}

// --- chrome parts editor -----------------------------------------------


  /** The property the parts are written to (`chrome.header`, `chrome.footer`). */
/** The part types as the editor names them, in the order its add-part picker offers them. */
export const CHROME_PART_TYPE_LABELS: ReadonlyArray<{ value: FormChromePartType; label: string }> = [
  { value: "form-title", label: "Form title" },
  { value: "form-description", label: "Form description" },
  { value: "heading", label: "Heading" },
  { value: "text", label: "Text" },
  { value: "html", label: "HTML" },
  { value: "image", label: "Image" },
  { value: "language-switcher", label: "Language switcher" },
  { value: "group", label: "Group (parts side by side)" }
];

export function chromePartLabel(part: FormChromePart, words?: BuilderTextOptions): string {
  if (part.type === "group") {
    return builderText("chromeSummary.group", undefined, words);
  }
  const named = CHROME_PART_TYPE_LABELS.find((entry) => entry.value === part.type);
  return named ? builderText(`chrome.partType.${named.value}`, undefined, words) : part.type;
}

/**
 * The next free id of the `part_1` style among `taken`: a part's translations are
 * keyed by its id, which is unique across the header and the footer, so the builder names a part
 * it creates and never reuses a number a deleted part held while another carries it.
 */
export function nextChromePartId(taken: Iterable<string>): string {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`part_${n}`)) {
    n += 1;
  }
  return `part_${n}`;
}

/** Every part id in `parts`, groups walked. */
export function chromePartIds(parts: readonly FormChromePart[]): string[] {
  return parts.flatMap((part) => (part.type === "group" ? [part.id, ...chromePartIds(part.parts)] : [part.id]));
}

/**
 * A fresh part of `type`, with nothing in it yet, for the editor's Add. `taken` holds the ids
 * already in the header and footer, so the new part's id (`part_1` style) is unique across both.
 */
export function createChromePart(type: FormChromePartType, taken: Iterable<string> = []): FormChromePart {
  const id = nextChromePartId(taken);
  switch (type) {
    case "image":
      return { id, type, src: "" };
    case "heading":
    case "text":
      return { id, type, text: "" };
    case "html":
      return { id, type, html: "" };
    case "group":
      return { id, type, parts: [] };
    case "form-title":
    case "form-description":
    case "language-switcher":
      return { id, type };
    default:
      return { id, type: "text", text: "" };
  }
}

/**
 * A row key names a part by its indices: `"0"` the first top-level part, `"0.2"` the third
 * part of the first group. The list holding the keyed part, and its index in that list.
 */
export function chromeListAt(parts: FormChromePart[], key: string): { list: FormChromePart[]; index: number } | undefined {
  const indices = key.split(".").map((segment) => Number(segment));
  if (indices.length === 0 || indices.some((index) => !Number.isInteger(index) || index < 0)) {
    return undefined;
  }
  let list = parts;
  for (let depth = 0; depth < indices.length - 1; depth += 1) {
    const holder = list[indices[depth]!];
    if (!holder || holder.type !== "group") {
      return undefined;
    }
    list = holder.parts;
  }
  const index = indices[indices.length - 1]!;
  return index < list.length ? { list, index } : undefined;
}

export function chromePartAt(parts: FormChromePart[], key: string): FormChromePart | undefined {
  const at = chromeListAt(parts, key);
  return at ? at.list[at.index] : undefined;
}

/** The configuration path of a row key's part: `"0.2"` under `chrome.header` is `chrome.header.0.parts.2`. */
export function chromePartPath(fieldPath: string, key: string): string {
  return `${fieldPath}.${key.split(".").join(".parts.")}`;
}

/**
 * The header or footer row of the form root's inspector: what is in the region,
 * and the button that opens the Header & footer panel on it, where the parts
 * themselves are edited. The click is the shell's to route (`builder-open-panel`).
 */
function chromeFieldHtml(field: InspectorField, words?: BuilderTextOptions): string {
  const parts = field.chromeEditor?.parts ?? [];
  const region = field.chromeEditor?.region ?? (field.propertyPath.endsWith("footer") ? "footer" : "header");
  const label = (part: FormChromePart): string => chromePartLabel(part, words);
  const names = parts.map((part) =>
    part.type === "group"
      ? builderText("chromeSummary.groupOf", { parts: part.parts.map(label).join(builderText("common.sep", undefined, words)) || builderText("chromeSummary.empty", undefined, words) }, words)
      : label(part)
  );
  const summary = names.length === 0 ? builderText("chromeSummary.none", undefined, words) : names.join(builderText("common.sep", undefined, words));
  return `<div class="property-row options-row"><strong>${esc(field.label)}</strong>
    <span class="options-summary"><span data-chrome-count>${esc(summary)}</span>
      <button type="button" class="btn" data-chrome-open="${region}" title="${esc(builderText("chromeSummary.open", undefined, words))}">${esc(builderText("chromeSummary.edit", { label: field.label.toLowerCase() }, words))}</button></span></div>${
        field.description ? `<p class="options-note">${esc(field.description)}</p>` : ""
      }`;
}

export interface OptionsEditorSuggestion {
  value: string;
  /** What the key means, shown on hover with the details a message may quote. */
  label: string;
  /** The `{parameter}` names a message for the key may use; shown on hover. */
  parameters?: readonly string[] | undefined;
}

export interface OptionsEditorSuggestionGroup {
  title: string;
  suggestions: OptionsEditorSuggestion[];
  /** What the group says when it has nothing to offer; absent, an empty group is not drawn. */
  emptyText?: string | undefined;
  collapsed?: boolean | undefined;
}

/** The words the dialog uses for one {@link OptionsEditorKind}. */
interface OptionsEditorCaptions {
  /** What one row is, for the row's accessible names ("option", "message"). */
  noun: string;
  keyHeader: string;
  textHeader: string;
  hint: string;
  emptyText: string;
  newKeyPlaceholder: string;
  newTextPlaceholder: string;
  addLabel: string;
  exportTitle: string;
  importTitle: string;
  closeLabel: string;
  /** Whether the rows' order means anything — for options it does, for a code map it does not. */
  reorder: boolean;
}

function optionsCaptions(kind: OptionsEditorKind, words: BuilderTextOptions | undefined): OptionsEditorCaptions {
  const t = (part: "noun" | "keyHeader" | "textHeader" | "hint" | "empty" | "newKeyPlaceholder" | "newTextPlaceholder" | "addLabel" | "exportTitle" | "importTitle" | "close"): string =>
    builderText(`optionsEditor.${kind}.${part}`, undefined, words);
  return {
    noun: t("noun"),
    keyHeader: t("keyHeader"),
    textHeader: t("textHeader"),
    hint: t("hint"),
    emptyText: t("empty"),
    newKeyPlaceholder: t("newKeyPlaceholder"),
    newTextPlaceholder: t("newTextPlaceholder"),
    addLabel: t("addLabel"),
    exportTitle: t("exportTitle"),
    importTitle: t("importTitle"),
    closeLabel: t("close"),
    reorder: kind === "options"
  };
}

/**
 * The suggestion chips under the table: one button per key, disabled once a row carries it,
 * its meaning and the details it may quote on hover. A collapsed group is a `<details>`
 * whose summary counts what it holds.
 */
function suggestionGroupsHtml(view: OptionsEditorView): string {
  const groups = view.suggestions ?? [];
  if (groups.length === 0) {
    return "";
  }
  const present = new Set(view.rows.map((row) => row.value.trim()));
  const chip = (entry: OptionsEditorSuggestion): string => {
    const details = entry.parameters?.length
      ? builderText("optionsEditor.chip.details", { names: entry.parameters.map((name) => `{${name}}`).join(builderText("common.sep", undefined, view.words)) }, view.words)
      : "";
    const taken = present.has(entry.value);
    // A host's label may already end its sentence; one full stop either way.
    const meaning = entry.label.trim().replace(/[.。]+$/, "");
    const state = builderText(taken ? "optionsEditor.chip.taken" : "optionsEditor.chip.free", undefined, view.words);
    const title = [`${meaning}.`, details, state].filter((part) => part !== "").join(" ");
    return `<button type="button" class="db-options-chip" data-options-suggest="${esc(entry.value)}" title="${esc(title)}"${
      taken ? " disabled" : ""
    }>${esc(entry.value)}</button>`;
  };
  const body = (group: OptionsEditorSuggestionGroup): string =>
    group.suggestions.length > 0
      ? group.suggestions.map(chip).join("")
      : group.emptyText
        ? `<span class="db-options-suggest__none">${esc(group.emptyText)}</span>`
        : "";
  const html = groups
    .filter((group) => group.suggestions.length > 0 || group.emptyText)
    .map((group) =>
      group.collapsed
        ? `<details class="db-options-suggest__more"><summary>${esc(group.title)} (${group.suggestions.length})</summary><div class="db-options-suggest__group">${body(group)}</div></details>`
        : `<div class="db-options-suggest__group"><span class="db-options-suggest__title">${esc(group.title)}</span>${body(group)}</div>`
    )
    .join("");
  return html ? `<div class="db-options-suggest" data-options-suggestions>${html}</div>` : "";
}

function optionsEditorRowHtml(
  row: OptionsEditorRow,
  index: number,
  view: OptionsEditorView,
  captions: OptionsEditorCaptions
): string {
  const noun = captions.noun;
  const words = view.words;
  const messages = (view.kind ?? "options") === "messages";
  const ofRow = (part: string): string => builderText("optionsEditor.partOf", { part, noun, n: index + 1 }, words);
  // A message row is named by its code ("required message"), never "Message of message 1": the
  // code is what the author recognises, and the noun repeating itself read as a stutter.
  const rowName = messages && row.value.trim() !== "" ? row.value.trim() : undefined;
  const textLabel = (): string =>
    rowName === undefined
      ? ofRow(captions.textHeader)
      : builderText("optionsEditor.messageOf", { code: rowName, part: captions.textHeader.toLowerCase() }, words);
  const cell = (part: "value" | "label" | "description", ariaLabel: string, value: string, placeholder = ""): string =>
    `<td><input type="text" data-option-row="${index}" data-option-part="${part}" aria-label="${esc(ariaLabel)}" value="${esc(value)}"${
      placeholder ? ` placeholder="${esc(placeholder)}"` : ""
    } /></td>`;
  // The help under the option — only once asked for.
  const descriptionCells =
    !messages && view.showDescriptions
      ? cell("description", builderText("optionsEditor.descriptionOf", { noun, n: index + 1 }, words), row.description ?? "")
      : "";
  // A blank option label shows its key on the form, so the key is the placeholder; a blank
  // message shows the page's wording (when the page words the code), which the code is not.
  const fallback = messages ? row.fallback : undefined;
  const textPlaceholder = messages ? (fallback?.default ?? "") : row.value;
  const last = view.rows.length - 1;
  const reorder = captions.reorder
    ? `<button type="button" class="btn" data-options-move="${index}:-1" aria-label="${esc(builderText("optionsEditor.moveUpLabel", { noun, n: index + 1 }, words))}" title="${esc(builderText("common.moveUp", undefined, words))}"${index === 0 ? " disabled" : ""}>↑</button>
        <button type="button" class="btn" data-options-move="${index}:1" aria-label="${esc(builderText("optionsEditor.moveDownLabel", { noun, n: index + 1 }, words))}" title="${esc(builderText("common.moveDown", undefined, words))}"${index === last ? " disabled" : ""}>↓</button>
        `
    : "";
  const seeded = messages && row.seeded === true;
  // A code the component's checks raise is the row's identity, not something to retype; a
  // code the author added stays editable. Both name what they mean beside the code.
  const keyCell = seeded
    ? `<th scope="row" data-option-row="${index}" data-option-part="value"><code>${esc(row.value)}</code></th>`
    : cell("value", ofRow(captions.keyHeader), row.value);
  const meaningCell = messages
    ? `<td class="db-options-meaning" title="${esc(row.meaning ?? "")}">${row.meaning ? esc(row.meaning) : '<span class="db-translations-none">—</span>'}</td>`
    : "";
  // A blank row with a page wording can start from it; a worded seeded row is cleared, never
  // removed, since the check still raises the code.
  const useDefault =
    fallback && !optionsRowHasText(row)
      ? `<button type="button" class="btn" data-options-default="${index}" aria-label="${esc(builderText("optionsEditor.useDefaultLabel", { noun, n: index + 1 }, words))}" title="${esc(builderText("optionsEditor.useDefaultTitle", undefined, words))}">${esc(builderText("optionsEditor.useDefault", undefined, words))}</button>`
      : "";
  const action = seeded
    ? optionsRowHasText(row)
      ? `<button type="button" class="btn" data-options-clear="${index}" aria-label="${esc(builderText("optionsEditor.clearLabel", { noun, n: index + 1 }, words))}" title="${esc(builderText("optionsEditor.clearTitle", undefined, words))}">${esc(builderText("common.clear", undefined, words))}</button>`
      : useDefault
    : `${useDefault}<button type="button" class="btn" data-options-remove="${index}" aria-label="${esc(builderText("optionsEditor.removeLabel", { noun, n: index + 1 }, words))}">${esc(builderText("common.remove", undefined, words))}</button>`;
  return `<tr data-options-row="${index}"${messages ? ` data-option-code="${esc(row.value)}"` : ""}>
      ${keyCell}${meaningCell}
      ${cell("label", textLabel(), row.label, textPlaceholder)}
      ${descriptionCells}
      <td class="db-options-actions">
        ${reorder}${action}
      </td>
    </tr>`;
}

/**
 * The keyed-text editor: a `<dialog>` the properties panel shows modally (see
 * `CONFIRM_STYLES` for why a dialog), holding one row per entry — its key and its default
 * text — with add, remove and (for options) reorder,
 * and Export / Import of the same JSON the schema carries. It edits a field's inline options
 * (key → label) and a component's validation messages (code → message) alike; see
 * {@link OptionsEditorKind}. Nothing changes until Apply; Apply then writes every value
 * straight to the form as one undo step (through `controller.setProperties`), so the panel's
 * own Save has nothing left to write for it.
 *
 * The panel owns the working copy ({@link OptionsEditorView}) and repaints the whole dialog
 * on each structural change; typing in a cell updates the copy without a repaint, so the
 * caret stays where it is.
 */
export function optionsEditorHtml(view: OptionsEditorView): string {
  const kind: OptionsEditorKind = view.kind ?? "options";
  const words = view.words;
  const captions = optionsCaptions(kind, words);
  const meaningHeader = kind === "messages" ? `<th scope="col">${esc(builderText("optionsEditor.meaning", undefined, words))}</th>` : "";
  const descriptions = kind === "options" && view.showDescriptions === true;
  const columns = 3 + (kind === "messages" ? 1 : 0) + (descriptions ? 1 : 0);
  const body =
    view.rows.length === 0
      ? `<tr><td colspan="${columns}" class="db-options-empty">${esc(captions.emptyText)}</td></tr>`
      : view.rows.map((row, index) => optionsEditorRowHtml(row, index, view, captions)).join("");
  const descriptionHeaders = descriptions ? `<th scope="col">${esc(builderText("optionsEditor.description", undefined, words))}</th>` : "";
  // A line of help under each option is the exception, so its columns come and go on demand.
  const descriptionsToggle =
    kind === "options"
      ? `<button type="button" class="btn" data-options-descriptions aria-pressed="${descriptions ? "true" : "false"}" title="${esc(builderText("optionsEditor.descriptionsTitle", undefined, words))}">${esc(builderText("optionsEditor.descriptions", undefined, words))}</button>`
      : "";
  const sourceNote = view.sourceId
    ? ` ${htmlWith((slots) => builderText("optionsEditor.source", slots, words), { source: `<code>${esc(view.sourceId)}</code>` })}`
    : "";
  return `<dialog class="db-confirm db-options-editor${view.maximized ? " maximized" : ""}" role="dialog" aria-labelledby="options-editor-title" data-options-dialog data-options-kind="${kind}" data-options-path="${esc(view.path)}"${dialogFrameStyle(view.frame)}>
      <div class="db-options-head" data-options-drag>
        <h4 id="options-editor-title">${esc(view.title)}</h4>
        <button type="button" class="icon-btn" data-options-maximize aria-label="${esc(builderText(view.maximized ? "common.restore" : "common.maximize", undefined, words))}" title="${esc(builderText(view.maximized ? "common.restore" : "common.maximize", undefined, words))}">${view.maximized ? "⤡" : "⤢"}</button>
        <button type="button" class="icon-btn" data-options-close aria-label="${esc(captions.closeLabel)}" title="${esc(builderText("common.close", undefined, words))}">×</button>
      </div>
      <p class="db-options-hint">${esc(captions.hint)}${sourceNote}</p>
      <div class="db-options-tools">
        <button type="button" class="btn" data-options-export title="${esc(captions.exportTitle)}">${esc(builderText("common.export", undefined, words))}</button>
        <button type="button" class="btn" data-options-import title="${esc(captions.importTitle)}">${esc(builderText("common.import", undefined, words))}</button>
        <input type="file" accept="application/json,.json" data-options-file hidden />${descriptionsToggle}
      </div>
      <div class="db-options-scroll">
        <table class="db-options-table">
          <thead><tr><th scope="col">${esc(captions.keyHeader)}</th>${meaningHeader}<th scope="col">${esc(captions.textHeader)}</th>${descriptionHeaders}<th scope="col" aria-label="${esc(builderText("common.rowActions", undefined, words))}"></th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${suggestionGroupsHtml(view)}
      <div class="db-options-add">
        <input type="text" data-options-new="value" aria-label="${esc(builderText("optionsEditor.newPart", { noun: captions.noun, part: captions.keyHeader.toLowerCase() }, words))}" placeholder="${esc(captions.newKeyPlaceholder)}" value="${esc(view.newValue)}" />
        <input type="text" data-options-new="label" aria-label="${esc(builderText("optionsEditor.newPart", { noun: captions.noun, part: captions.textHeader.toLowerCase() }, words))}" placeholder="${esc(captions.newTextPlaceholder)}" value="${esc(view.newLabel)}" />
        <button type="button" class="btn" data-options-add>${esc(captions.addLabel)}</button>
      </div>
      ${view.error ? `<p role="alert" class="db-options-error">${esc(view.error)}</p>` : ""}
      <div class="db-confirm-actions">
        <button type="button" class="btn" data-options-cancel>${esc(builderText("common.cancel", undefined, words))}</button>
        <button type="button" class="btn primary" data-options-apply>${esc(builderText("common.apply", undefined, words))}</button>
      </div>
    </dialog>`;
}

/** The inline style that pins a keyed-text dialog where the author moved or resized it. */
function dialogFrameStyle(frame: OptionsEditorFrame | undefined): string {
  return frame
    ? ` style="inset: auto; margin: 0; left: ${frame.left}px; top: ${frame.top}px; width: ${frame.width}px; height: ${frame.height}px;"`
    : "";
}

/** The options editor's own rules, on top of `CONFIRM_STYLES` (the `.db-confirm` base and `.btn`). */
export const OPTIONS_EDITOR_STYLES = `
  dialog.db-options-editor {
    /* fit-content, not auto: a fixed box with inset: 0 and an auto height fills the viewport. */
    width: min(760px, calc(${MODAL_W} - 32px)); height: fit-content; max-height: calc(${MODAL_H} - 32px);
    flex-direction: column; gap: var(--db-space-3);
    /* Native resize from the corner; the dialog's own box clips, and the table scrolls. */
    resize: both; overflow: hidden;
  }
  dialog.db-options-editor[open] { display: flex; }
  dialog.db-options-editor.maximized {
    inset: ${MODAL_INSET} !important; margin: 0 !important;
    width: ${MODAL_W} !important; height: ${MODAL_H} !important; max-width: none; max-height: none;
    border-radius: 0; resize: none;
  }
  .db-options-head { display: flex; align-items: center; gap: var(--db-space-1); cursor: move; user-select: none; }
  .db-options-head h4 { margin: 0; flex: 1; font-size: var(--db-text-lg); font-weight: 600; line-height: 1.2; }
  .db-options-head .icon-btn { cursor: pointer; font-size: var(--db-text-lg); }
  .db-confirm p.db-options-hint { margin: 0; }
  .db-options-tools { display: flex; flex-wrap: wrap; gap: var(--db-space-2); }
  .db-options-scroll {
    flex: 1; min-height: 120px; overflow: auto;
    border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-md); background: var(--db-surface);
  }
  .db-options-table { width: 100%; border-collapse: collapse; font-size: var(--db-text-sm); }
  .db-options-table th, .db-options-table td {
    padding: var(--db-space-1) var(--db-space-2); border-bottom: var(--db-border-w) solid var(--db-line-divider); text-align: start; vertical-align: middle;
  }
  .db-options-table th {
    position: sticky; top: 0; z-index: 1; background: var(--db-surface-sunken);
    font-weight: 600; color: var(--db-ink-muted); white-space: nowrap;
  }
  .db-options-table th code, .db-options-hint code { font-family: var(--db-font-mono); font-size: var(--db-text-xs); }
  .db-options-table input, .db-options-add input {
    width: 100%; min-width: 90px; min-block-size: 32px; box-sizing: border-box;
    border: var(--db-border-w) solid var(--db-line-input); background: var(--db-surface); color: var(--db-ink);
    border-radius: var(--db-radius-sm); padding: var(--db-space-1) var(--db-space-2); font: inherit; font-size: var(--db-text-sm);
  }
  .db-options-add input { min-block-size: 36px; border-radius: var(--db-radius-md); padding: 0 var(--db-space-3); font-size: var(--db-text-md); }
  .db-options-table input::placeholder, .db-options-add input::placeholder { color: var(--db-ink-subtle); }
  .db-options-actions { white-space: nowrap; text-align: end; }
  .db-options-actions .btn { min-block-size: 28px; min-inline-size: 28px; padding: 0 var(--db-space-2); margin-inline-start: var(--db-space-half); }
  .db-options-empty { color: var(--db-ink-muted); text-align: center; padding: var(--db-space-4) var(--db-space-2); }
  /* The suggestion chips: the keys worth adding, grouped, the ones that matter here in front. */
  .db-options-suggest { display: grid; gap: var(--db-space-2); font-size: var(--db-text-sm); }
  .db-options-suggest__group { display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-1); }
  .db-options-suggest__title, .db-options-suggest__more > summary { color: var(--db-ink-muted); }
  .db-options-suggest__more > summary { cursor: pointer; user-select: none; }
  .db-options-suggest__more[open] > summary { margin-bottom: var(--db-space-2); }
  .db-options-suggest__none { color: var(--db-ink-muted); font-style: italic; }
  .db-options-chip {
    display: inline-flex; align-items: center; min-block-size: 28px;
    font: inherit; font-size: var(--db-text-sm); font-family: var(--db-font-mono);
    padding: 0 var(--db-space-3); border-radius: var(--db-radius-pill); cursor: pointer;
    border: var(--db-border-w) solid var(--db-line-input); background: var(--db-surface); color: var(--db-ink);
  }
  .db-options-chip:hover:not([disabled]) { background: var(--db-surface-hover); }
  .db-options-chip[disabled] { opacity: 0.55; cursor: default; }
  .db-options-add { display: flex; gap: var(--db-space-2); }
  .db-options-add input { flex: 1; }
  .db-confirm p.db-options-error { margin: 0; color: var(--db-danger); }
  /* The inspector's own row: a count and the button that opens the editor. */
  .options-row .options-summary { display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-2); font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  .options-note { margin: calc(-1 * var(--db-space-2)) 0 var(--db-space-3); font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  .options-note code { font-family: var(--db-font-mono); }
  /* A value map: one row per answer, the answer beside the select that says what is written for it. */
  .property-listing { display: grid; gap: var(--db-space-2); }
  .property-listing-line { margin: 0; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  .property-listing-groups, .property-listing-groups ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--db-space-1); }
  .property-listing-groups { gap: var(--db-space-3); }
  .property-listing-heading { font-weight: 600; font-size: var(--db-text-sm); }
  .property-listing-groups ul li { font-size: var(--db-text-sm); padding-inline-start: var(--db-space-3); }
  .value-map-rows { list-style: none; margin: 0 0 var(--db-space-2); padding: 0; display: grid; gap: var(--db-space-2); }
  .value-map-rows li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: var(--db-space-2); font-size: var(--db-text-sm); }
  .value-map-rows code { font-family: var(--db-font-mono); color: var(--db-ink-muted); }
  /* The messages editor: a meaning column beside the code, so it takes the catalog's width. */
  dialog.db-options-editor[data-options-kind="messages"] { width: min(960px, calc(${MODAL_W} - 32px)); }
  .db-options-meaning { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--db-ink-muted); font-size: var(--db-text-xs); }
  /* The options editor's rows: the name is a row header, not a sticky column header. */
  .db-options-table th[scope="row"] {
    position: static; z-index: auto; background: transparent;
    color: var(--db-ink); font-weight: 500; white-space: nowrap;
  }
  /* Short windows: the tools tighten and the grid keeps room to show rows, scrolling inside while the head and tools stay put. */
  @media (max-height: 700px) {
    .db-options-tools { gap: var(--db-space-1); }
    .db-options-tools .btn { min-block-size: 28px; padding-inline: var(--db-space-2); }
    .db-options-scroll { min-height: 180px; }
    .db-options-add input { min-inline-size: 0; }
  }
`;

export interface VerticalRect {
  top: number;
  height: number;
  left?: number;
  width?: number;
}

export type InsertionAxis = "vertical" | "horizontal";

/**
 * The index at which a dragged component should be inserted among `nodeRects` (the direct
 * `.db-node` rects of a drop zone, in document order) given the pointer position along the
 * zone's flow axis. Pointer before a node's midpoint inserts before it; after inserts after;
 * past the last node appends.
 *
 * The axis matters now that the canvas renders real layout: a `grid` lays its
 * children out side by side, where vertical midpoints would put the marker in visibly the
 * wrong place.
 */
export function computeInsertionIndex(
  nodeRects: VerticalRect[],
  pointer: number,
  axis: InsertionAxis = "vertical"
): number {
  for (let i = 0; i < nodeRects.length; i += 1) {
    const rect = nodeRects[i];
    if (!rect) {
      continue;
    }
    const start = axis === "horizontal" ? (rect.left ?? 0) : rect.top;
    const extent = axis === "horizontal" ? (rect.width ?? 0) : rect.height;
    if (pointer < start + extent / 2) {
      return i;
    }
  }
  return nodeRects.length;
}

/** The flow axis a container's drop zone lays its children out along. */
export function insertionAxisForLayout(kind: "stack" | "grid"): InsertionAxis {
  return kind === "stack" ? "vertical" : "horizontal";
}

/**
 * The drop zone a drag is aimed at, from the event's composed path (target first).
 *
 * Walking outward from the target, the first of these answers:
 *
 * 1. an element that *is* a zone — a drag over a field targets the zone the field sits in,
 *    and one inside a nested container targets that container, whose zone is nearer on the
 *    path than its parent's;
 * 2. an element that wraps exactly one top-level zone — the chrome a container shell draws
 *    around its slot: a PDF page band's label and padding, a tab panel's padding, a card's
 *    heading, a group's legend. Each is visibly part of the container's box, so a drop on it
 *    goes into the container. Without this a drag over any of them found no zone and fell
 *    through to the root, so a drop on the PDF footer band's label landed in the *header* (the
 *    root's first zone in document order) and one on a tab panel's padding left the tab.
 *    An element wrapping several (a grid's columns, the PDF page's three bands, the form
 *    root) is ambiguous and skipped.
 *
 * A node's own grip and type chip are chrome of the node, not of what it holds: over them
 * only rule 1 applies, so a container dragged by its grip still targets the zone around it
 * rather than its own inside. The walk stops at the rendered form's shadow root: the canvas
 * chrome outside it wraps every zone and would otherwise answer for all of them. `undefined`
 * leaves the caller its own fallback (the root's primary slot, anywhere over the canvas).
 */
export function dropZoneOnPath(path: readonly EventTarget[]): HTMLElement | undefined {
  let nodeChrome = false;
  for (const target of path) {
    const node = target as Node;
    // A shadow root is a document fragment (nodeType 11): the rendered form ends here.
    if (node.nodeType === 11) {
      return undefined;
    }
    if (node.nodeType !== 1) {
      continue;
    }
    const element = node as HTMLElement;
    // A container's node is its own empty slot's zone; over its grip, it is the thing dragged, not where.
    if (element.hasAttribute("data-dropzone") && !(nodeChrome && element.classList.contains("db-node"))) {
      return element;
    }
    if (element.classList.contains("db-handle") || element.classList.contains("db-tag")) {
      nodeChrome = true;
    }
    if (nodeChrome) {
      continue;
    }
    const zone = soleZoneWithin(element);
    if (zone) {
      return zone;
    }
  }
  return undefined;
}

/**
 * The one drop zone `element` wraps at the top level — a zone nested in another zone of the
 * element's does not count — or `undefined` when it wraps none or several.
 */
function soleZoneWithin(element: Element): HTMLElement | undefined {
  let found: HTMLElement | undefined;
  for (const zone of element.querySelectorAll<HTMLElement>("[data-dropzone]")) {
    const enclosing = zone.parentElement?.closest("[data-dropzone]");
    if (enclosing && element.contains(enclosing)) {
      continue;
    }
    if (found) {
      return undefined;
    }
    found = zone;
  }
  return found;
}

// --- toolbar ---------------------------------------------------------------

/** The size every palette glyph is drawn at, in CSS px. */
const PALETTE_ICON_SIZE = 15;

/**
 * Palette glyphs — one {@link DatumIconName} per kind of component, drawn through the active
 * icon set so they inherit the panel's colour and scale with the type size. Keys
 * are matched against the component type, then a few common aliases, so a host that registers
 * `email` or `datagrid` gets a fitting icon without declaring one; anything unrecognized falls
 * back to the generic `component` glyph rather than a bare `+`.
 *
 * Every glyph here is chosen in this file, from the engine's own vocabulary — a host-supplied
 * `icon` is escaped as text instead (see {@link BuilderComponentType.icon}), so nothing a
 * *form* or a component catalogue says can inject markup. The icon set itself is the page's,
 * trusted like a theme's CSS.
 */
const PALETTE_GLYPHS: Record<string, DatumIconName> = {
  // Text-ish inputs.
  text: "field-text",
  textarea: "field-textarea",
  email: "field-email",
  password: "field-password",
  phone: "field-phone",
  tel: "field-phone",
  url: "field-url",
  number: "field-number",
  currency: "field-currency",
  slider: "field-slider",
  rating: "field-rating",
  checkbox: "field-checkbox",
  checkboxes: "field-checkboxes",
  toggle: "field-toggle",
  radio: "field-radio",
  select: "field-select",
  multiselect: "field-checkboxes",
  date: "field-date",
  time: "field-time",
  datetime: "field-datetime",
  file: "field-file",
  signature: "field-signature",
  button: "action-button",
  // Containers.
  form: "container-form",
  fieldset: "container-fieldset",
  section: "container-section",
  group: "container-section",
  panel: "container-section",
  container: "container-box",
  tabs: "container-tabs",
  grid: "container-grid",
  row: "container-row",
  // A row of buttons; matched whole, before its tail `group` names a section.
  buttongroup: "container-row",
  column: "container-column",
  table: "container-table",
  datagrid: "container-table",
  repeater: "container-repeater",
  collection: "container-repeater",
  step: "container-step",
  steps: "container-step",
  wizard: "container-step",
  // Static content.
  heading: "content-heading",
  paragraph: "content-paragraph",
  html: "content-html",
  divider: "content-divider",
  image: "content-image",
  // Page furniture and messaging — reached mostly through the vendor-prefix fallback in
  // {@link paletteIconHtml} (`gcds-notice` → `notice`), so any component library's types
  // land on a fitting glyph without the engine naming that library.
  header: "content-header",
  banner: "content-header",
  footer: "content-footer",
  link: "content-link",
  card: "content-card",
  details: "content-details",
  disclosure: "content-details",
  notice: "content-notice",
  alert: "content-alert",
  icon: "content-icon",
  errormessage: "content-alert",
  // One glyph for both, like the panels they name: `summary` is the error summary's short
  // alias, and the two must render identically (the palette test pins this).
  errorsummary: "content-error-summary",
  summary: "content-error-summary"
};

/**
 * The icon-vocabulary name the palette draws for a component type: the full normalized name
 * first, then with leading segments dropped, so a vendor-prefixed type (`gcds-link`,
 * `acme-rating`) lands on the glyph its tail names rather than on the generic one.
 */
export function paletteGlyphName(type: string): DatumIconName {
  const segments = type.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  for (let start = 0; start < segments.length; start++) {
    const match = PALETTE_GLYPHS[segments.slice(start).join("")];
    if (match) {
      return match;
    }
  }
  return "component";
}

/** The palette glyph for a component type: host override, built-in match, or the fallback. */
export function paletteIconHtml(
  entry: { type: string; icon?: string | undefined },
  icons: IconSet = defaultIconSet()
): string {
  if (entry.icon) {
    return `<span class="palette-icon palette-icon--text" aria-hidden="true">${esc(entry.icon)}</span>`;
  }
  const name = paletteGlyphName(entry.type);
  // The page's set first; for a name it leaves out, the builder's own drawing of that kind of
  // component, and only then the built-in set's one drawing per palette kind.
  const own = icons === BUILTIN_ICONS ? undefined : icons.icon(name, { size: PALETTE_ICON_SIZE, className: "palette-icon" });
  if (own !== undefined) {
    return own;
  }
  const body = (PALETTE_GLYPH_BODIES as Partial<Record<DatumIconName, string>>)[name];
  if (body !== undefined) {
    return svgIconMarkup({ viewBox: PALETTE_GLYPH_VIEWBOX, body }, { size: PALETTE_ICON_SIZE, className: `palette-icon ${ICON_FALLBACK_CLASS}` }, BUILTIN_ICON_ATTRS);
  }
  return renderIcon(icons, name, { size: PALETTE_ICON_SIZE, className: "palette-icon" });
}

/** What the palette needs to know about one offerable type. */
export interface PaletteEntry {
  type: string;
  label: string;
  icon?: string | undefined;
  /** Explicit palette group. Omitted, the palette infers one from the type name. */
  group?: string | undefined;
}

export function paletteHtml(componentTypes: PaletteEntry[], icons: IconSet = defaultIconSet(), words?: BuilderTextOptions): string {
  return componentTypes
    .map(
      (entry) => `
      <button type="button" class="palette-item" data-add-type="${esc(entry.type)}"
        data-palette-type="${esc(entry.type)}" draggable="true"
        title="${esc(builderText("toolbar.addTitle", undefined, words))}">${paletteIconHtml(entry, icons)}<span class="palette-label">${esc(
          entry.label
        )}</span></button>`
    )
    .join("\n");
}

/**
 * The natural palette groups, in display order, and which type names fall into each. Matched
 * on the same normalized key as {@link PALETTE_ICONS}, so `date-time` and `datetime` land
 * together. A type in none of them — a host's custom component with no declared `group` —
 * goes to {@link OTHER_PALETTE_GROUP}, and a host wanting better files it under its own named
 * group instead ({@link PaletteEntry.group}).
 */
const PALETTE_GROUPS: ReadonlyArray<{ label: string; types: ReadonlySet<string> }> = [
  {
    label: "Fields",
    types: new Set([
      "text", "textarea", "email", "password", "phone", "tel", "url", "number", "currency",
      "date", "time", "datetime", "slider", "file", "signature"
    ])
  },
  {
    // A rating is a pick from a fixed set of marks, not something typed — it belongs with
    // the other pick-one controls rather than the text-and-number fields.
    label: "Choices",
    types: new Set(["checkbox", "checkboxes", "toggle", "radio", "select", "multiselect", "rating"])
  },
  {
    label: "Layout",
    types: new Set([
      "form", "fieldset", "section", "group", "panel", "container", "tabs", "grid",
      // `datagrid` is the data grid's type key, `dataGrid`, as the lookup normalizes it.
      "column", "datagrid", "repeater", "collection", "steps", "step", "wizard",
      "buttongroup"
    ])
  },
  { label: "Content", types: new Set(["heading", "paragraph", "html", "divider", "image"]) },
  { label: "Actions", types: new Set(["button"]) }
];

const OTHER_PALETTE_GROUP = "Other";

/** A built-in group's label in the builder's words; a host's own group name is shown as declared. */
function paletteGroupDisplay(label: string, words: BuilderTextOptions | undefined): string {
  switch (label) {
    case "Fields":
      return builderText("paletteGroup.fields", undefined, words);
    case "Choices":
      return builderText("paletteGroup.choices", undefined, words);
    case "Layout":
      return builderText("paletteGroup.layout", undefined, words);
    case "Content":
      return builderText("paletteGroup.content", undefined, words);
    case "Actions":
      return builderText("paletteGroup.actions", undefined, words);
    case "Other":
      return builderText("paletteGroup.other", undefined, words);
    default:
      return label;
  }
}

/** The group label for one palette entry: declared group first, else inferred from the type. */
export function paletteGroupForEntry(entry: Pick<PaletteEntry, "type" | "group">): string {
  const declared = entry.group?.trim();
  if (declared) {
    return declared;
  }
  const key = entry.type.toLowerCase().replace(/[\s_-]/g, "");
  return PALETTE_GROUPS.find((group) => group.types.has(key))?.label ?? OTHER_PALETTE_GROUP;
}

/**
 * Palette entries gathered under their group labels: built-in groups in their canonical
 * order, then host-declared groups in first-appearance order, with "Other" always last —
 * a catch-all reads as an afterthought anywhere else. Within a group, host order is kept.
 */
export function groupPaletteEntries(
  componentTypes: PaletteEntry[]
): Array<{ label: string; entries: PaletteEntry[] }> {
  const byLabel = new Map<string, PaletteEntry[]>();
  for (const entry of componentTypes) {
    const label = paletteGroupForEntry(entry);
    const bucket = byLabel.get(label);
    if (bucket) {
      bucket.push(entry);
    } else {
      byLabel.set(label, [entry]);
    }
  }
  const ordered: Array<{ label: string; entries: PaletteEntry[] }> = [];
  for (const group of PALETTE_GROUPS) {
    const entries = byLabel.get(group.label);
    if (entries) {
      ordered.push({ label: group.label, entries });
      byLabel.delete(group.label);
    }
  }
  const other = byLabel.get(OTHER_PALETTE_GROUP);
  byLabel.delete(OTHER_PALETTE_GROUP);
  for (const [label, entries] of byLabel) {
    ordered.push({ label, entries });
  }
  if (other) {
    ordered.push({ label: OTHER_PALETTE_GROUP, entries: other });
  }
  return ordered;
}

/**
 * The palette as collapsible groups. With everything in a single group the headings would
 * only restate the panel, so the flat list renders instead. `collapsedGroups` carries which
 * headings the author closed across the panel's re-renders (the toolbar repaints on every
 * controller change); groups it does not name default open, so finding a component never
 * starts behind a closed door.
 */
export function paletteGroupsHtml(
  componentTypes: PaletteEntry[],
  collapsedGroups: ReadonlySet<string> = new Set<string>(),
  icons: IconSet = defaultIconSet(),
  words?: BuilderTextOptions
): string {
  const groups = groupPaletteEntries(componentTypes);
  if (groups.length <= 1) {
    return paletteHtml(componentTypes, icons, words);
  }
  return groups
    .map(
      (group) => `<details class="palette-group" data-palette-group="${esc(group.label)}"${
        collapsedGroups.has(group.label) ? "" : " open"
      }>
      <summary>${esc(paletteGroupDisplay(group.label, words))}<span class="palette-count">${group.entries.length}</span></summary>
      <div class="palette-group-body">${paletteHtml(group.entries, icons, words)}</div>
    </details>`
    )
    .join("\n");
}

export const TOOLBAR_STYLES = `
  /* Two cards: the filter's, pinned while the listing's scrolls beneath it, so the box never scrolls out of reach. */
  .palette-list { display: grid; gap: var(--db-space-2); align-content: start; }
  .palette-item svg { width: var(--db-icon-size); height: var(--db-icon-size); }
  /* A component is a row in a list: no box until hovered, its glyph on an accent-soft tile. */
  .palette-item {
    width: 100%; min-block-size: 40px; display: flex; align-items: center; gap: var(--db-space-3); text-align: start;
    border: 0; color: var(--db-ink);
    border-radius: var(--db-radius-sm); background: transparent; padding: var(--db-space-1) var(--db-space-2); cursor: grab;
    font: inherit; font-size: var(--db-text-md); font-weight: 500;
    transition: background-color var(--db-motion-fast) var(--db-ease);
  }
  .palette-item:hover { background: var(--db-surface-hover); }
  .palette-item:active { cursor: grabbing; }
  /*
   * The glyph must never be the event target: click-to-add and dragstart both read the
   * button's own dataset, and an SVG child would otherwise retarget them.
   */
  .palette-icon {
    flex: none; pointer-events: none; display: inline-flex; align-items: center; justify-content: center;
    inline-size: 28px; block-size: 28px; border-radius: var(--db-radius-sm);
    background: var(--db-accent-soft); color: var(--db-accent-text);
  }
  .palette-icon--text { font-size: var(--db-text-base); line-height: 1; }
  .palette-label { pointer-events: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The filter heads the column on its own: the shell's activity strip opens and closes the panel. */
  .panel-head--bare { justify-content: flex-start; margin: 0; gap: var(--db-space-2); }
  /* The box is the shared one (SHARED_CONTROL_STYLES). */
  .palette-filter { flex: 1 1 auto; min-width: 0; }
  .palette-filter::placeholder { color: var(--db-ink-subtle); }
  /*
   * Groups collapse the same way the properties panel's sections do: a palette of dozens of
   * components is a directory, and a directory needs headings that fold. Open by default —
   * the headings organise, they must not hide. A plain heading row, a divider between groups,
   * no box around them.
   */
  .palette-group + .palette-group { border-top: var(--db-border-w) solid var(--db-line-divider); padding-top: var(--db-space-2); }
  .palette-group > summary {
    cursor: pointer; list-style: none; min-block-size: 32px; padding: 0 var(--db-space-2); display: flex; align-items: center;
    gap: var(--db-space-2); border-radius: var(--db-radius-sm);
    font-size: var(--db-text-sm); font-weight: 600; letter-spacing: .02em; color: var(--db-ink-muted);
  }
  .palette-group > summary:hover { background: var(--db-surface-hover); color: var(--db-ink); }
  .palette-group > summary::-webkit-details-marker { display: none; }
  /* A drawn chevron, not a text glyph: crisp in any face, and nothing added to the name. */
  .palette-group > summary::before { content: ""; display: inline-block; flex: none; width: 6px; height: 6px; margin-inline: 2px 4px; border-block-end: 1.5px solid currentColor; border-inline-end: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform var(--db-motion-fast) var(--db-ease); }
  .palette-group[open] > summary::before { transform: rotate(45deg); }
  .palette-count {
    margin-inline-start: auto; border-radius: var(--db-radius-pill); background: var(--db-surface-sunken); color: var(--db-ink-muted);
    padding: 0 var(--db-space-2); font-size: var(--db-text-xs); font-weight: 500; letter-spacing: 0; line-height: 1.6;
  }
  .palette-group-body { display: grid; gap: var(--db-space-half); padding: var(--db-space-1) 0 var(--db-space-2); }
`;

// --- canvas ---------------------------------------------------------------

export const CANVAS_PANEL_STYLES = `
  /*
   * The canvas is a page; the form is a sheet on it.
   *
   * A form is never the width of the window it is filled in on — it is a column on a page —
   * so authoring it edge-to-edge across the canvas misrepresents it. The panel supplies the
   * backdrop and .canvas-surface the sheet: bounded, centred, with the page showing on both
   * sides, the way a notebook shows a cell.
   *
   * The sheet's width is the form's own: --db-sheet-w by default, overridden inline by the
   * bar's Width control, so choosing a device width narrows the sheet rather than the window —
   * or by the tree, when the host's BuilderControllerOptions.sheetWidth gives it the say (the
   * PDF designer's page); the canvas marks the sheet data-sheet-fixed then, see below.
   */
  /*
   * A window onto the builder's backdrop, not a boxed panel: the page the sheet sits on is
   * the shell's own dotted backdrop, so the canvas draws no frame or fill of its own — a
   * border here reads as a stray seam beside the form.
   *
   * The column fills the box the shell gives it (a flex item as tall as the shell's
   * row) and the page inside it is the scroll region, both ways. Scrolling *inside* the pane
   * is what puts the horizontal scrollbar at the bottom of the canvas where it can be seen.
   */
  .panel--canvas {
    background: transparent; border: 0; border-radius: 0; padding: 0;
    display: flex; flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  /*
   * The page scrolls both ways. Auto margins center the sheet while it fits and collapse to
   * zero once it overflows — the sheet is then laid out from the scroller's start, which is
   * what keeps every part of it reachable by scrolling (unsafe flex centering was tried and
   * puts the left overflow beyond scrollLeft 0). The canvas re-centers scrollLeft from
   * script whenever the width changes, so an over-wide sheet still *looks* centered and a
   * drag still grows both edges symmetrically.
   *
   * --db-canvas-gap is the headroom above the sheet, inside the scroll region, so a host can
   * rest the sheet at the same y as another surface's (the web host aligns it with its
   * renderer stage) without adding page height.
   */
  .canvas-page {
    padding: var(--db-canvas-gap, var(--db-space-6)) var(--db-space-4) var(--db-space-10);
    flex: 1; min-height: 0;
    overflow: auto;
    /* Always-visible scrollbars: an overlay scrollbar hides until touched, and a sheet
       wider than the pane then looks cut off rather than scrollable. */
    scrollbar-width: thin;
    scrollbar-color: var(--db-line-card) transparent;
  }
  /*
   * The sheet keeps clear of the open side drawer when the canvas has the room.
   * --db-side-w is how far the drawer reaches over the canvas's start edge (nothing while it is
   * folded), at whatever width it opened or was dragged to; the sheet's start edge must sit a gap
   * past it (--page-clear, zero while folded). --page-sheet is the sheet as drawn, which the
   * canvas writes: a device, dragged or fixed width or the default, times the zoom. The page's
   * start padding grows only by what centring between it and the end padding (--page-end: Try
   * it's room, when shown) leaves short: a sheet already clear does not move, one that would be
   * covered moves just clear, and one too wide for the room left starts clear of the drawer, a
   * default sheet narrowing to the room and a set width keeping its size for the page to scroll.
   * When the room left would be under 480px, the least a form sheet is useful at, the padding
   * stays as it was and the drawer lies over the sheet. Pure arithmetic (the 1000 multipliers
   * turn a sign into all or nothing). A mode's own surface lays itself out and keeps the plain
   * padding.
   */
  /*
   * The end edge keeps clear of the inspector the same way: --db-props-w is how far it reaches
   * (nothing while it is folded or has nothing to show), and --page-end is the end padding the
   * start padding above centres against. With under 480px left beside the inspector the padding
   * stays plain and the inspector lies over the sheet. Try it sets --page-end itself.
   */
  .canvas-page:not([data-surface]) {
    --page-props: min(calc(var(--db-props-w, 0px) * 1000), calc(var(--db-props-w, 0px) + 2 * var(--db-gap, 12px)));
    --page-end: max(var(--db-space-4), min(var(--page-props), calc((100% - var(--page-props) - 480px) * 1000)));
    padding-right: var(--page-end);
  }
  .canvas-page:not([data-surface]) {
    --page-clear: min(calc(var(--db-side-w, 0px) * 1000), calc(var(--db-side-w, 0px) + 2 * var(--db-gap, 12px)));
    padding-left: max(var(--db-space-4), min(
      clamp(var(--db-space-4), calc(2 * var(--page-clear) + var(--page-sheet, var(--db-sheet-w, 860px)) + var(--page-end, var(--db-space-4)) - 100%), var(--page-clear)),
      calc((100% - var(--page-clear) - var(--page-end, var(--db-space-4)) - 480px) * 1000)));
  }
  /*
   * In Chromium and WebKit a non-auto scrollbar-width/color displaces the ::-webkit-scrollbar
   * styling below, and a "thin" bar on macOS is still an overlay one that hides until touched
   * — defeating the always-visible intent. Resetting to auto where the webkit pseudos exist
   * re-enables the custom bars, which are painted persistently and hold layout space. Firefox
   * fails the selector test and keeps the thin styling above.
   */
  @supports selector(::-webkit-scrollbar) {
    .canvas-page { scrollbar-width: auto; scrollbar-color: auto; }
  }
  /*
   * The hand (a pan): empty canvas around the sheet says it can be grabbed; while a pan is in
   * flight the whole page says so, and nothing under it is selected as text.
   */
  .canvas-page:not([data-surface]) { cursor: grab; }
  .canvas-page:not([data-surface]) > .canvas-surface { cursor: auto; }
  .canvas-page[data-panning], .canvas-page[data-panning] * { cursor: grabbing; user-select: none; }
  .canvas-page::-webkit-scrollbar { width: 10px; height: 10px; }
  .canvas-page::-webkit-scrollbar-thumb { background: var(--db-line-card); border-radius: var(--db-radius-pill); }
  .canvas-page::-webkit-scrollbar-thumb:hover { background: var(--db-accent); }
  .canvas-page::-webkit-scrollbar-track { background: transparent; }
  /*
   * The canvas's notice (a drop it refused, a step of the history that could not be taken) stays
   * in view while the page scrolls either way, and clear of the drawers lying over the page's
   * edges: --db-side-w and --db-props-w say how far they reach, nothing while one is
   * folded or, for the inspector, while nothing is selected.
   */
  [data-drop-error] {
    position: sticky; top: 0; left: 0; z-index: 3;
    margin-left: min(var(--db-side-w, 0px), max(0px, calc(100% - 240px)));
    margin-right: min(var(--db-props-w, 0px), max(0px, calc(100% - 240px)));
  }
  [data-drop-error] .drop-error { box-shadow: var(--db-shadow-pill); }
  .canvas-surface {
    position: relative;
    margin: 0 auto;
    width: 100%;
    max-width: var(--db-sheet-w, 860px);
    /*
     * The sheet's fill is the *form's* page, not a builder panel: the drawn form's own
     * background, read off it by the canvas after every draw, white when the form is
     * transparent. A dark builder therefore shows a light form on a white sheet, and a form
     * drawn dark a dark sheet flush with the form, whatever the chrome around it. The
     * frame — outline, corners, shadow — stays builder chrome: a card line carries the edge
     * (an HDR display flattens shadows), the sheet shadow only lifts it.
     */
    background: var(--db-sheet-bg, #fff);
    border: var(--db-border-w) solid var(--db-line-card);
    border-radius: var(--db-radius-lg);
    box-shadow: var(--db-shadow-sheet);
    /*
     * The same breathing room on every side; the fields must not press against the sheet's
     * edge. Chrome that hangs outside a field (the drag grip at -28px) may still overhang
     * the sheet onto the page — the sheet does not clip, so nothing is lost.
     */
    padding: var(--db-space-6);
  }
  /* A wholly empty form: the renderer draws nothing, so the canvas says where the first component goes. */
  .canvas-empty-root {
    margin: 0; padding: var(--db-space-4); text-align: center; font-family: var(--db-font); font-size: var(--db-text-sm);
    color: var(--db-ink-muted);
    border: var(--db-border-w) dashed var(--db-line-input); border-radius: var(--db-radius-md); background: var(--db-surface-sunken);
  }
  /*
   * A sheet whose width the tree fixes: the inline width is the *form's* — a PDF page at its
   * paper width — so the box switches to content-box and the padding and border above wrap
   * it, rather than eating into it the way they do a device width.
   */
  .canvas-surface[data-sheet-fixed] { box-sizing: content-box; }
  /*
   * A form that draws its own frame previews it on a flush sheet: the sheet keeps
   * its fill and its room, and drops its border and shadow, so the author sees one frame.
   */
  .canvas-surface--flush { border-color: transparent; box-shadow: none; }
  /*
   * A mode's own surface in the sheet's place: a populated PDF's pages, drawn by
   * the mode, laid out where the sheet would be — the page's padding around it, the page
   * scrolling it. The sheet is put away while one is up.
   */
  .canvas-mode-surface { display: block; }
  .canvas-mode-surface[hidden] { display: none; }
  .canvas-page[data-surface] .canvas-surface { display: none; }
  /* Grips straddling the sheet's edges; dragging one sets a custom preview width. */
  .sheet-grip {
    position: absolute; top: 0; bottom: 0; width: 10px; z-index: 2;
    cursor: ew-resize; background: transparent;
    transition: background-color var(--db-motion-fast) var(--db-ease);
  }
  .sheet-grip[data-sheet-grip="left"] { left: -5px; }
  .sheet-grip[data-sheet-grip="right"] { right: -5px; }
  .sheet-grip:hover { background: color-mix(in oklab, var(--db-accent) 15%, transparent); }

  /*
   * Edit and preview. The canvas is one Tab stop: its ring sits inside the
   * pane, since the pane meets the drawers and the bar edge to edge.
   */
  .panel--canvas { position: relative; }
  .canvas-page:focus { outline: none; }
  .canvas-page:focus-visible { outline: 2px solid var(--db-focus); outline-offset: -4px; border-radius: var(--db-radius-lg); }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  /*
   * The canvas bar and the selection bar sit in fixed places over the part of the canvas the
   * drawers leave showing: --db-side-w and --db-props-w say how far each reaches (capped as the
   * page's margins are, above). Nothing is measured; neither bar is ever attached to a field.
   */
  .canvas-bar-zone, .selection-zone {
    position: absolute; z-index: var(--db-z-canvas-ui);
    /* Physical, as the drawers are (left and right in the shell): in a right-to-left page the bars must still clear the drawer, not trade sides with it. */
    left: calc(min(var(--db-side-w, 0px), max(0px, calc(100% - 240px))) + var(--db-gap, 12px));
    right: calc(min(var(--db-props-w, 0px), max(0px, calc(100% - 240px))) + var(--db-gap, 12px));
    display: flex; justify-content: center; pointer-events: none;
  }
  /* The canvas bar keeps to the end edge, clear of the bar's documents menu that opens over the canvas's start. */
  .canvas-bar-zone { top: var(--db-gap, 12px); justify-content: flex-end; }
  /* Room for the bars, so neither covers the sheet's first or last row. */
  .panel--canvas[data-canvas-bar-shown] .canvas-page { padding-top: calc(var(--db-gap, 12px) + 52px); }
  .panel--canvas[data-selection-shown] .canvas-page { padding-bottom: calc(var(--db-gap, 12px) + 64px); }
  .selection-zone { bottom: var(--db-gap, 12px); }
  .canvas-bar-zone[hidden], .selection-zone[hidden], .canvas-devices[hidden], .canvas-zoom[hidden], .canvas-previewing[hidden], .canvas-bar[hidden] { display: none; }
  /*
   * Both bars answer the room the drawers leave them: each zone is a container. A
   * wide canvas shows the width and zoom buttons in the bar (their wrapper lays out nothing of
   * its own); a narrow one folds them behind one button, opened as a card under the bar. The
   * selection bar lets the component's name give way first, and drops it where even its
   * buttons are tight: the inspector names the selection too.
   */
  .canvas-bar-zone { container: db-canvas-bar / inline-size; }
  .selection-zone { container: db-selection-bar / inline-size; }
  .canvas-more-pop, .canvas-actions { display: contents; }
  .canvas-tool.canvas-more { display: none; }
  @container db-canvas-bar (max-width: 519px) {
    .canvas-bar { position: relative; }
    .canvas-tool.canvas-more { display: inline-flex; }
    .canvas-more-pop {
      position: absolute; top: calc(100% + var(--db-space-2)); inset-inline-end: 0;
      display: none; flex-direction: column; align-items: stretch; gap: var(--db-space-1);
      padding: var(--db-space-1); border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-lg);
      background: var(--db-surface); box-shadow: var(--db-shadow-overlay);
    }
    .canvas-bar[data-more-open] .canvas-more-pop { display: flex; }
    .canvas-more-pop .canvas-zoom { margin: 0; padding: var(--db-space-1) 0 0; border: 0; border-top: var(--db-border-w) solid var(--db-line-divider); }
    .canvas-more-pop .canvas-zoom[hidden] { display: none; }
    .canvas-more-pop .canvas-tool[data-tip]::after { display: none; }
    .canvas-more-pop .canvas-word { justify-content: flex-start; }
    .canvas-stepper-text { max-width: 14ch; }
  }
  @container db-canvas-bar (max-width: 299px) {
    .canvas-stepper-text, .canvas-previewing { display: none; }
  }
  @container db-selection-bar (max-width: 359px) {
    .selection-name { display: none; }
  }
  .canvas-bar, .selection-bar {
    pointer-events: auto; display: flex; align-items: center; gap: var(--db-space-1); max-width: 100%;
    padding: var(--db-space-1); border-radius: var(--db-radius-pill); font-family: var(--db-font); font-size: var(--db-text-sm);
  }
  .canvas-bar { background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card); box-shadow: var(--db-shadow-pill); color: var(--db-ink); }
  .canvas-devices { display: inline-flex; gap: 2px; }
  /* The zoom: out, in, Fit and the level (which goes back to 100%), after a divider. */
  .canvas-zoom { display: inline-flex; align-items: center; gap: 2px; padding-inline-start: var(--db-space-1); margin-inline-start: var(--db-space-1); border-inline-start: var(--db-border-w) solid var(--db-line-divider); }
  /* Nothing before it (no width buttons, no previewing word, no worded action of a mode): no divider either, or the bar starts with an empty segment. */
  .canvas-previewing[hidden] ~ .canvas-more-pop > .canvas-actions:not(:has(> :not([hidden]))) + .canvas-devices[hidden] + .canvas-zoom { padding-inline-start: 0; margin-inline-start: 0; border-inline-start: 0; }
  .canvas-actions:not(:has(> :not([hidden]))) + .canvas-devices[hidden] + .canvas-zoom { border-block-start: 0; padding-block-start: 0; }
  .canvas-zoom-word { inline-size: auto; min-inline-size: 32px; padding: 0 var(--db-space-2); font: inherit; font-weight: 500; font-variant-numeric: tabular-nums; }
  .canvas-zoom-word[data-canvas-zoom-level] { min-inline-size: 48px; }
  /* A mode's worded action (Suggest mappings): a tool as wide as its words. */
  .canvas-tool.canvas-word { inline-size: auto; padding: 0 var(--db-space-3); font: inherit; font-weight: 500; white-space: nowrap; }
  .canvas-tool[hidden] { display: none; }
  .canvas-stepper { display: inline-flex; align-items: center; gap: 2px; padding-inline-end: var(--db-space-2); margin-inline-end: var(--db-space-1); border-inline-end: var(--db-border-w) solid var(--db-line-divider); }
  .canvas-stepper[hidden] { display: none; }
  .canvas-stepper-text { padding: 0 var(--db-space-2); font-weight: 500; white-space: nowrap; max-width: 28ch; overflow: hidden; text-overflow: ellipsis; }
  .canvas-tool:disabled { opacity: .4; cursor: default; }
  .canvas-tool:disabled:hover { background: transparent; color: var(--db-ink-muted); }
  .canvas-tool, .selection-btn {
    display: inline-flex; align-items: center; justify-content: center; flex: none;
    inline-size: 32px; block-size: 32px; padding: 0; border: 0; border-radius: var(--db-radius-pill);
    background: transparent; color: inherit; cursor: pointer;
    transition: background-color var(--db-motion-fast) var(--db-ease);
  }
  .canvas-tool svg, .selection-btn svg { inline-size: var(--db-icon-size); block-size: var(--db-icon-size); }
  .canvas-tool { color: var(--db-ink-muted); }
  .canvas-tool:hover { background: var(--db-surface-hover); color: var(--db-ink); }
  .canvas-tool[aria-pressed="true"] { background: var(--db-accent-soft); color: var(--db-accent-text); }
  .canvas-try {
    min-block-size: 32px; padding: 0 var(--db-space-3); border: 0; border-radius: var(--db-radius-pill);
    background: var(--db-accent); color: var(--db-accent-ink); font: inherit; font-weight: 600; cursor: pointer;
  }
  .canvas-try:hover { background: var(--db-accent-hover); }
  /* A primary action that cannot run now keeps the accent; only the fade says so. */
  .canvas-try:disabled { opacity: .5; cursor: default; background: var(--db-accent); }
  .canvas-try[aria-pressed="true"] { background: var(--db-selected); color: var(--db-selected-ink); }
  .canvas-previewing { padding: 0 var(--db-space-2) 0 var(--db-space-3); font-weight: 600; color: var(--db-ink); }
  /* The selection bar is the studio's one dark part: the selected colour, its own focus ring. */
  .selection-bar { background: var(--db-selected); color: var(--db-selected-ink); box-shadow: var(--db-shadow-overlay); }
  .selection-name {
    flex: 0 1 auto; padding: 0 var(--db-space-3); font-weight: 600; min-width: 0; max-width: 24ch;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .selection-btn:hover:not(:disabled) { background: color-mix(in oklab, var(--db-selected-ink) 16%, transparent); }
  .selection-btn:disabled { opacity: .4; cursor: default; }
  .selection-btn:focus-visible { outline: 2px solid var(--db-focus-on-dark); outline-offset: -2px; }
  .selection-btn[data-selection-action="delete"] { margin-inline-start: var(--db-space-1); }
  /* The canvas's icon buttons carry the shared tooltips (TIP_STYLES): below the canvas bar, above the selection bar. */
  .selection-btn[data-tip]::after { top: auto; bottom: calc(100% + 10px); }
  @media (pointer: coarse) {
    .canvas-tool, .selection-btn { inline-size: 44px; block-size: 44px; }
    .canvas-try { min-block-size: 44px; }
  }
  @media (forced-colors: active) {
    .canvas-bar, .selection-bar { border: 1px solid CanvasText; }
    .selection-btn:disabled { color: GrayText; opacity: 1; }
  }
  .selection-edit[hidden] { display: none; }
  /*
   * The phone tier: the shell's data-phone, set on this element. The canvas is the
   * phone's width and has no toolbar: Try it is on the bottom bar, zoom and Show hidden are in the menu drawer. Two pills stay, each only
   * when it applies: the steps stepper, and Previewing with Back to editing. The selection bar
   * runs the width above the bottom bar, Edit first.
   */
  :host([data-phone]) .canvas-more,
  :host([data-phone]) .canvas-more-pop,
  :host([data-phone]) .panel--canvas:not([data-previewing]) .canvas-try { display: none; }
  :host([data-phone]) .canvas-bar-zone { inset-inline: var(--db-gap, 8px); justify-content: flex-start; }
  :host([data-phone]) .canvas-bar-zone:not(:has(.canvas-stepper:not([hidden]), .canvas-previewing:not([hidden]))) { display: none; }
  :host([data-phone]) .canvas-bar { min-block-size: 44px; }
  :host([data-phone]) .canvas-tool { inline-size: 40px; block-size: 40px; }
  :host([data-phone]) .canvas-stepper { border-inline-end: 0; margin-inline-end: 0; }
  :host([data-phone]) .canvas-stepper-text { max-width: 24ch; }
  :host([data-phone]) .canvas-try { min-block-size: 40px; }
  :host([data-phone]) .canvas-page {
    padding-inline: var(--db-gap, 8px);
    padding-bottom: calc(var(--db-bottom-bar-h, 0px) + var(--db-gap, 8px));
    touch-action: pan-x pan-y;
  }
  :host([data-phone]) .panel--canvas:not(:has(.canvas-stepper:not([hidden]), .canvas-previewing:not([hidden]))) .canvas-page { padding-top: var(--db-gap, 8px); }
  :host([data-phone]) .panel--canvas[data-selection-shown] .canvas-page { padding-bottom: calc(var(--db-bottom-bar-h, 0px) + 2 * var(--db-gap, 8px) + 48px); }
  :host([data-phone]) .canvas-surface:not([data-sheet-fixed]) { width: 100% !important; max-width: none !important; }
  :host([data-phone]) .sheet-grip { display: none; }
  :host([data-phone]) .panel--canvas[data-try-shown] .canvas-page { padding-right: var(--db-gap, 8px); }
  :host([data-phone]) .selection-zone { inset-inline: var(--db-gap, 8px); bottom: calc(var(--db-bottom-bar-h, 0px) + var(--db-gap, 8px)); }
  :host([data-phone]) .selection-bar { width: 100%; min-block-size: 48px; padding: 2px; }
  :host([data-phone]) .selection-name { flex: 1; min-width: 0; padding: 0 var(--db-space-1); }
  :host([data-phone]) .selection-btn { inline-size: 44px; block-size: 44px; }
  :host([data-phone]) .selection-btn[data-tip]::after { display: none; }
`;

/**
 * The tokens the canvas chrome reads on the sheet: the selection ring, drop line, hover outline
 * and agent-touched outline (accent, focus), the type chips and empty wells (accent-soft,
 * accent-text, surface, surface-sunken, ink, ink-muted, line-input), and the drag grip, which
 * overhangs the sheet but is drawn whole from one palette (surface-hover, line-card).
 */
const SHEET_CHROME_TOKENS = [
  "db-accent", "db-accent-soft", "db-accent-text", "db-focus", "db-surface", "db-surface-sunken", "db-surface-hover",
  "db-ink", "db-ink-muted", "db-line-input", "db-line-card"
] as const;

/**
 * The on-sheet tokens per sheet scheme. The chrome sits on the *form's* sheet, which
 * wears the page colour of the binding that draws it, so it is judged against that sheet and not
 * against the builder's page: the dark builder's accent is 2.5:1 on a white sheet, the light builder's is dim
 * on a dark one. The renderer carries data-sheet-scheme (the canvas panel sets it from the scheme
 * the form is drawn in), and each block redeclares the tokens from the light list or the dark
 * map, so no colour is typed here. Not under forced colours, where the host's system-colour
 * mapping must stay in force.
 */
function sheetSchemeRules(): string {
  const block = (scheme: "light" | "dark", read: (name: string) => string): string =>
    `:host([data-sheet-scheme="${scheme}"]) { ${SHEET_CHROME_TOKENS.map((name) => `--${name}: ${read(name)};`).join(" ")} }`;
  return `@media not (forced-colors: active) {
    ${block("light", studioLightValue)}
    ${block("dark", (name) => STUDIO_DARK_TOKENS[name] ?? studioLightValue(name))}
  }`;
}

/**
 * Chrome the canvas layers over the rendered form. Every rule here is deliberately additive —
 * selection uses `outline` rather than a border or box-shadow, and drop zones only draw on
 * hover — so that nothing on the canvas shifts a field's position relative to where the live
 * form puts it. That restraint is what makes the preview trustworthy.
 *
 * Loaded into `<datum-form-renderer>`'s shadow root via its `extraStyles`, so it reaches the
 * decorated markup while the form's own CSS isolation boundary still holds.
 */
export const CANVAS_CHROME_STYLES = `
  ${sheetSchemeRules()}
  /*
   * The chrome is the *builder's* UI, so it wears the builder's typography even though it
   * lives inside the form's shadow root. --db-* custom properties inherit across the
   * boundary from the canvas panel, and the form now states its own font rather than passing
   * the host's down, so the two vocabularies stay separate in both directions.
   */
  .db-handle, .db-tag, .db-empty {
    font-family: var(--db-font);
  }
  .db-node { position: relative; display: grid; }
  /*
   * Edit mode: a field is one click target, so a click selects and never
   * types. The field's leaf (the binding's drawing) is HTML inert, which takes its controls out
   * of the pointer's reach, the Tab order and the selection; the leaf draws no box of its own. A
   * container is never inert: the step and tab controls stay live, since they choose what the
   * canvas shows. Preview draws the form with no canvas hooks at all.
   */
  .db-leaf { display: contents; }
  /* A choice field with no options: a link-like button under the empty control that opens the options editor. */
  .db-node > .db-no-options {
    justify-self: start; margin: var(--db-space-1) 0 0; padding: 2px var(--db-space-2);
    font-family: var(--db-font); font-size: var(--db-text-sm); line-height: 1.4; font-weight: 500;
    color: var(--db-accent-text); background: var(--db-accent-soft); cursor: pointer;
    border: var(--db-border-w) dashed var(--db-accent); border-radius: var(--db-radius-sm);
    text-decoration: underline; text-underline-offset: 2px;
  }
  .db-node > .db-no-options:hover { text-decoration-thickness: 2px; }
  /*
   * The form root has no node of its own (it cannot be dragged): its selection outline hangs
   * on its drop zone (data-db-root), shown while the renderer says the root is selected.
   */
  .db-selected { outline: 2px solid var(--db-accent); outline-offset: 4px; border-radius: 4px; }
  /*
   * Hover previews the selection, so what a click is about to select is visible before the
   * click. Thin and dashed so it never reads as "already selected"; on the element that *is*
   * selected the rule above wins on specificity.
   */
  .db-node:hover { outline: 1px dashed var(--db-accent); outline-offset: 4px; border-radius: 4px; }
  /*
   * A container is a different kind of thing from a field — it holds components rather than a
   * value, and selecting one means something different (drop target, group label, its own
   * layout). It gets a dashed outline with a wider offset that visibly encloses its children,
   * plus a type chip, so the two are never confused at a glance.
   */
  .db-node--container.db-selected,
  .db-node--container:hover { outline-style: dashed; outline-offset: 6px; }
  /* Widest of all, and dashed: "the whole form", not one group inside it. */
  :host([data-db-root-selected]) [data-db-root] { outline: 2px dashed var(--db-accent); outline-offset: 8px; border-radius: 4px; }
  .db-node.db-dragging { opacity: .45; }

  /*
   * Revealed by opacity, never by display: the grip sits entirely outside its node's box
   * (in the gutter), so it must stay hit-testable while invisible — a display:none grip
   * disappears the instant the pointer leaves the field on its way over, and an element
   * with no box cannot be hovered to bring itself back. 24px square: WCAG 2.5.8's floor.
   */
  .db-handle {
    position: absolute; inset-inline-start: -28px; top: 0; width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center; opacity: 0;
    cursor: grab; color: var(--db-ink-muted); font-size: var(--db-text-sm); line-height: 1;
    background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-xs);
    box-shadow: var(--db-shadow-pill);
    transition: opacity var(--db-motion-fast) var(--db-ease);
  }
  .db-handle:hover { background: var(--db-surface-hover); color: var(--db-ink); }
  /* Bridges the 4px gap between the grip and the node's edge, so :hover holds unbroken
     while the pointer crosses from the field onto the grip. */
  .db-handle::after {
    content: ""; position: absolute; inset-inline-start: 100%; top: -3px; width: 4px; height: calc(100% + 6px);
  }
  .db-handle:active { cursor: grabbing; }
  /* The grip glyph must never be the hit target — the drag and the hover belong to the span. */
  .db-handle > * { pointer-events: none; }
  /*
   * A component the form is currently hiding, shown only because build mode asked for it
   * (see FormBodyOptions.includeHiddenComponents). Dimmed, ringed with a dashed line and
   * labelled, so it is never mistaken for something an end user would see. Its tag is in
   * full ink: the dimming takes the node's text down with it, and ink stays past 4.5:1.
   */
  .db-node--hidden { opacity: .72; }
  .db-node--hidden:not(.db-selected):not(:hover) { outline: 1px dashed var(--db-line-input); outline-offset: 4px; border-radius: 4px; }
  /*
   * What an assistant just changed: the components its write touched
   * wear the studio's focus colour for 1.5 s; the shell's highlightComponents sets and clears
   * the attribute. It has to win over every other outline a box can wear in that moment: the
   * selection, the hover preview, a container's dashed ring and a hidden component's
   * ring. So it comes after all of them, and each selector matches the weight of the rule it
   * must beat: .db-node[...] ties .db-node:hover and the container rules (0,2,0) and wins on
   * order, the hidden form outweighs the hidden ring (0,3,0), and the bare attribute covers
   * the tried form's own elements and anything else. No transition, so no motion to reduce.
   */
  [data-agent-touched],
  .db-node[data-agent-touched],
  .db-node--hidden[data-agent-touched]:not(.db-selected):not(:hover) { outline: 2px solid var(--db-focus); outline-offset: 2px; }
  .db-node--hidden > .db-tag--hidden { display: block; }
  .db-tag {
    position: absolute; inset-inline-start: 0; top: -10px; z-index: 2; display: none;
    padding: 0 var(--db-space-2); border-radius: var(--db-radius-pill); font-size: var(--db-text-xs); font-weight: 500; line-height: 18px; white-space: nowrap;
    background: var(--db-accent-soft); color: var(--db-accent-text);
  }
  /*
   * The container's type, so "this outline is a fieldset" needs no guessing: an accent badge,
   * shown while the container is hovered or selected. It hangs above the node, over the gap
   * before it, so it never covers what a binding draws at the node's top edge: a legend, a tab
   * list, a heading. Which binding draws there is not the canvas's to know. It takes no pointer,
   * so the part of it over the component above never steals that component's hover or click.
   * Only the type chip: the hidden tag below is always shown and carries a title to hover.
   */
  .db-tag:not(.db-tag--hidden) { top: auto; bottom: calc(100% + 4px); pointer-events: none; }
  /*
   * A container inside another hangs its chip at its end corner: at the start, the chip of one
   * drawn first in its parent would lie on the parent's legend or heading.
   */
  .db-node--container .db-node--container > .db-tag:not(.db-tag--hidden) { inset-inline-start: auto; inset-inline-end: 0; }
  /* A hidden container shows both tags: the type chip rises clear of the hidden tag's corner. */
  .db-node--hidden > .db-tag:not(.db-tag--hidden) { bottom: calc(100% + 12px); }
  /*
   * The hidden tag sits on the node's own top edge at the end corner, a chip on white with an
   * input line, and takes the pointer so its title can be read. It follows .db-tag and outweighs
   * it: placed before it at equal weight, its corner and fill were overridden, and the tag
   * stretched across the whole component.
   */
  .db-tag.db-tag--hidden {
    inset-inline-start: auto; inset-inline-end: 0;
    background: var(--db-surface); color: var(--db-ink); border: var(--db-border-w) solid var(--db-line-input);
  }
  .db-node:hover > .db-handle,
  .db-node.db-selected > .db-handle { opacity: 1; }
  .db-node--container:hover > .db-tag,
  .db-node--container.db-selected > .db-tag { display: block; }
  /* Hover chrome must not follow the pointer around during a drag. */
  .db-dragging .db-handle, .db-dragging .db-tag { display: none !important; }

  [data-dropzone] { border-radius: var(--db-radius-sm); }
  [data-dropzone][data-db-drag-over] { outline: 1px dashed var(--db-accent); outline-offset: 3px; }
  /*
   * An empty slot's drop zone: the one box build mode adds that the live form has no element
   * for, and it has to: an empty slot draws nothing, and an element with no box cannot be
   * hovered or hit by a drag. A slot holding components is the element the binding drew them in.
   */
  .db-stack { display: grid; gap: inherit; align-content: start; min-height: 14px; }
  .db-empty {
    margin: 0; padding: var(--db-space-4); text-align: center; font-size: var(--db-text-sm);
    color: var(--db-ink-muted);
    border: var(--db-border-w) dashed var(--db-line-input); border-radius: var(--db-radius-md); background: var(--db-surface-sunken);
  }
  /* The drop line: the accent, with a soft halo of itself. */
  .db-marker {
    background: var(--db-accent); border-radius: var(--db-radius-pill);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--db-accent) 22%, transparent);
  }
  .db-marker[data-axis="vertical"] { height: 3px; margin: 1px 0; }
  .db-marker[data-axis="horizontal"] { width: 3px; align-self: stretch; margin: 0 1px; }

  /*
   * No reserved gutter for the drag handles: the form sits flush with the sheet's left edge,
   * and a handle (at -28px) overhangs the sheet onto the page instead — nothing clips it,
   * and the authored form keeps its real margins.
   */
  /* A phone has no drag and drop: Add inserts after the selection, Move up and down reorder. */
  :host([data-phone]) .db-handle { display: none; }
`;

/**
 * What the live renderer wraps every drawn component in (the DOM contract): a field's
 * wrapper (`data-component-id`) or a container's (`data-container-id`). Whatever a binding draws
 * inside, these are the boxes the canvas places, counts and drops between.
 */
export const DRAWN_COMPONENT_SELECTOR = ".datum-live-field[data-component-id], .datum-live-container[data-container-id]";

/** The component a drawn wrapper is: a container's id, else a field's. */
export function drawnComponentId(element: HTMLElement): string | undefined {
  return element.dataset.containerId ?? element.dataset.componentId;
}

/**
 * The components drawn in a drop zone at its own level, in document order: each drawn wrapper
 * inside it that no other drawn wrapper inside it holds. A binding may put its own elements
 * between the zone and its components (a list item, a table cell), so these are found, not
 * assumed to be the zone's children.
 */
export function zoneItems(zone: Element): HTMLElement[] {
  return [...zone.querySelectorAll<HTMLElement>(DRAWN_COMPONENT_SELECTOR)].filter((item) => {
    const outer = item.parentElement?.closest(DRAWN_COMPONENT_SELECTOR);
    return !outer || outer === zone || !zone.contains(outer);
  });
}

/**
 * Which way a zone's components flow, read from where they were laid out: side by side when two
 * neighbours share a line (a row, a layout grid's columns, a data grid's template row), else
 * stacked. A zone with fewer than two components takes the axis it was marked with.
 */
export function zoneAxis(zone: HTMLElement, items: readonly HTMLElement[]): InsertionAxis {
  for (let i = 1; i < items.length; i += 1) {
    const a = items[i - 1]!.getBoundingClientRect();
    const b = items[i]!.getBoundingClientRect();
    if (a.height > 0 && b.height > 0 && b.top < a.bottom - 1 && a.top < b.bottom - 1 && b.left !== a.left) {
      return "horizontal";
    }
  }
  return zone.dataset.axis === "horizontal" ? "horizontal" : "vertical";
}

/** The attributes a marked zone carries; `data-db-zone` says the canvas marked it, so it is unmarked before the next marking. */
const ZONE_MARKS = ["data-dropzone", "data-parent-id", "data-slot-id", "data-axis", "data-db-zone", "data-db-root"] as const;

/** The smallest element holding every one of `items`. */
function commonAncestor(items: readonly HTMLElement[]): HTMLElement | undefined {
  let candidate = items[0]?.parentElement ?? undefined;
  while (candidate && !items.every((item) => candidate!.contains(item))) {
    candidate = candidate.parentElement ?? undefined;
  }
  return candidate;
}

/**
 * Marks the canvas's drop zones on the drawn form: run after every draw. An empty
 * slot draws its own zone (the canvas hooks' `emptySlot`); a slot that holds components is the
 * smallest element its components share, so a design system's container keeps its own markup and
 * a drop lands in the slot it is aimed at. The root's zone is the `<form>` itself when it holds
 * nothing (marked `data-db-root`, which the root's selection outline hangs on); a container whose
 * one slot is drawn empty with no zone of its own takes drops on its node. A slot whose
 * components share their element with another slot's has no element of its own, and is left
 * unmarked: a drop there lands in the container around it.
 *
 * Last time's marks go first and the new ones are worked out on a copy; the DOM is written only
 * where the two differ. Taking a mark off the `<form>` and putting it back sends a style
 * invalidation to every component under it (the sheet's `[data-dropzone] > [data-component-id]`
 * rules), about 6 ms of style per commit at 200 fields for marks that did not move.
 */
export function markDropZones(root: ParentNode, view: NestedTreeNodeView): void {
  // The marks each element carries once last time's are gone and this time's are made: an element
  // the canvas marked before starts from none, any other from what it has (a hook's own zone).
  const marks = new Map<HTMLElement, Map<string, string>>();
  const marksOf = (element: HTMLElement): Map<string, string> => {
    let held = marks.get(element);
    if (!held) {
      held = new Map();
      if (!element.hasAttribute("data-db-zone")) {
        for (const name of ZONE_MARKS) {
          const value = element.getAttribute(name);
          if (value !== null) {
            held.set(name, value);
          }
        }
      }
      marks.set(element, held);
    }
    return held;
  };
  for (const element of root.querySelectorAll<HTMLElement>("[data-db-zone]")) {
    marksOf(element);
  }
  const hasMark = (element: HTMLElement, name: string): boolean => (marks.has(element) ? marks.get(element)!.has(name) : element.hasAttribute(name));
  const drawn = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>(DRAWN_COMPONENT_SELECTOR)) {
    const id = drawnComponentId(element);
    if (id !== undefined && !drawn.has(id)) {
      drawn.set(id, element);
    }
  }
  const zoned = new Set<string>();
  for (const zone of root.querySelectorAll<HTMLElement>("[data-dropzone]")) {
    if (hasMark(zone, "data-dropzone")) {
      zoned.add(`${zone.dataset.parentId ?? ""}\u0000${zone.dataset.slotId ?? ""}`);
    }
  }
  const form = root.querySelector<HTMLElement>("form");
  const mark = (zone: HTMLElement, parentId: string, slotId: string, axis: InsertionAxis, isRoot: boolean): void => {
    const held = marksOf(zone);
    held.set("data-dropzone", "true");
    held.set("data-parent-id", parentId);
    held.set("data-slot-id", slotId);
    held.set("data-axis", axis);
    held.set("data-db-zone", "");
    if (isRoot) {
      held.set("data-db-root", "");
    }
  };
  const visit = (node: NestedTreeNodeView, isRoot: boolean): void => {
    const wrapper = drawn.get(node.id);
    // The container's node (its canvas hook's wrapper) is a child of the renderer's wrapper.
    const box = isRoot ? (form ?? undefined) : ((wrapper ? ([...wrapper.children].find((el) => el.classList.contains("db-node")) as HTMLElement | undefined) : undefined) ?? wrapper);
    if (box) {
      const slotItems = node.slots.map((slot) => slot.children.map((child) => drawn.get(child.id)).filter((item): item is HTMLElement => item !== undefined));
      node.slots.forEach((slot, index) => {
        if (zoned.has(`${node.id}\u0000${slot.slotId}`)) {
          return;
        }
        const items = slotItems[index]!;
        let zone: HTMLElement | undefined;
        if (items.length > 0) {
          zone = commonAncestor(items);
          if (zone && (!box.contains(zone) || slotItems.some((other, at) => at !== index && other.some((item) => zone!.contains(item))))) {
            zone = undefined;
          }
        } else if (node.slots.length === 1 || (isRoot && index === 0)) {
          zone = box;
        }
        if (zone && !hasMark(zone, "data-dropzone")) {
          // A data grid's template row lays its columns side by side; every other zone reads its axis off the layout.
          mark(zone, node.id, slot.slotId, node.type === DATA_GRID_COMPONENT_TYPE ? "horizontal" : "vertical", isRoot && index === 0);
        }
      });
    }
    for (const slot of node.slots) {
      for (const child of slot.children) {
        visit(child, false);
      }
    }
  };
  visit(view, true);
  // The root's selection outline hangs on its zone, wherever its components put it.
  const rooted = [...marks.values()].some((held) => held.has("data-db-root")) || [...root.querySelectorAll<HTMLElement>("[data-db-root]")].some((element) => !marks.has(element));
  if (form && !rooted) {
    const held = marksOf(form);
    held.set("data-db-root", "");
    held.set("data-db-zone", "");
  }
  for (const [element, held] of marks) {
    for (const name of ZONE_MARKS) {
      const value = held.get(name);
      if (value === undefined) {
        element.removeAttribute(name);
      } else if (element.getAttribute(name) !== value) {
        element.setAttribute(name, value);
      }
    }
  }
}

/**
 * Where a drag aimed at `zone` puts the dragged component, from the pointer: the index among the
 * slot's components (counting the ones not drawn, a hidden step's or a rule's), and the element to
 * show the insertion marker before (`undefined`: after the last). `index` reads the drawn
 * components' places in the tree (`placeOf`), so a slot whose components are not all drawn still
 * gets the slot's own index.
 */
export function zoneInsertion(
  zone: HTMLElement,
  pointer: { x: number; y: number },
  placeOf: (componentId: string) => number | undefined
): { index: number; before: HTMLElement | undefined; after: HTMLElement | undefined; axis: InsertionAxis } {
  const items = zoneItems(zone);
  const axis = zoneAxis(zone, items);
  const at = computeInsertionIndex(
    items.map((item) => item.getBoundingClientRect()),
    axis === "horizontal" ? pointer.x : pointer.y,
    axis
  );
  const before = items[at];
  const after = before ? undefined : items.at(-1);
  const anchor = before ?? after;
  const anchorId = anchor ? drawnComponentId(anchor) : undefined;
  const place = anchorId !== undefined ? placeOf(anchorId) : undefined;
  const index = place === undefined ? at : before ? place : place + 1;
  return { index, before, after, axis };
}

/** Puts the insertion marker in `zone`, before `before`, after `after`, or at its end. */
export function placeMarker(marker: HTMLElement, zone: HTMLElement, before: Element | undefined, after: Element | undefined, axis: InsertionAxis): void {
  marker.dataset.axis = axis;
  if (before?.parentNode) {
    before.parentNode.insertBefore(marker, before);
  } else if (after?.parentNode) {
    after.parentNode.insertBefore(marker, after.nextSibling);
  } else {
    zone.appendChild(marker);
  }
}

/** The place of each component in its slot, read off the builder's tree view: what a drop counts in. */
export function slotPlaces(view: NestedTreeNodeView): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (node: NestedTreeNodeView): void => {
    for (const slot of node.slots) {
      slot.children.forEach((child, index) => {
        out.set(child.id, index);
        walk(child);
      });
    }
  };
  walk(view);
  return out;
}

/**
 * Declared slot ids per container id, read off the builder's own tree view. The registry knows
 * about slots a node declares but has not filled; the render model only sees children that
 * exist, so an empty container would otherwise have nowhere to drop into.
 */
export function declaredSlotsByComponent(view: NestedTreeNodeView): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (node: NestedTreeNodeView): void => {
    if (node.slots.length > 0) {
      out.set(
        node.id,
        node.slots.map((slot) => slot.slotId)
      );
    }
    for (const slot of node.slots) {
      for (const child of slot.children) {
        walk(child);
      }
    }
  };
  walk(view);
  return out;
}

/**
 * The `emptyHint` of every declared slot that has one, per container id then slot id, read
 * off the builder's own tree view like {@link declaredSlotsByComponent}: what the canvas says
 * in that slot while it is empty. A blank hint is kept as `""`: the slot's zone is
 * drawn with no words (a journey's Check answers or exit step, which asks no field).
 */
export function slotEmptyHintsByComponent(view: NestedTreeNodeView): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const walk = (node: NestedTreeNodeView): void => {
    for (const slot of node.slots) {
      const hint = slot.definition?.emptyHint;
      if (hint !== undefined) {
        const hints = out.get(node.id) ?? new Map<string, string>();
        hints.set(slot.slotId, hint.trim() === "" ? "" : hint);
        out.set(node.id, hints);
      }
      for (const child of slot.children) {
        walk(child);
      }
    }
  };
  walk(view);
  return out;
}

// --- properties ---------------------------------------------------------

/**
 * The component tree's rows, shared by the outline panel and any host drawing `treeTabHtml`
 * inside the properties panel's styles.
 */
export const TREE_STYLES = `
  .tree-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--db-space-half); }
  .tree-row { display: flex; align-items: center; gap: var(--db-space-1); min-width: 0; }
  /* The label (two lines at most) over the type and key, the hidden chip at that line's end. */
  .tree-select {
    flex: 1; min-width: 0; min-block-size: 32px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: var(--db-space-2); text-align: start;
    border: var(--db-border-w) solid transparent; border-radius: var(--db-radius-sm); background: none;
    padding: var(--db-space-1) var(--db-space-2); font: inherit; font-size: var(--db-text-md); cursor: pointer; color: var(--db-ink); overflow: hidden;
    transition: background-color var(--db-motion-fast) var(--db-ease);
  }
  .tree-select:hover { background: var(--db-surface-hover); }
  .tree-select.active { border-color: var(--db-accent); background: var(--db-accent-soft); }
  .tree-label { grid-column: 1 / -1; font-weight: 500; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
  .tree-meta { color: var(--db-ink-muted); font-size: var(--db-text-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tree-hidden {
    color: var(--db-ink-muted); background: var(--db-surface-sunken); font-size: var(--db-text-xs); font-weight: 500;
    border-radius: var(--db-radius-pill); padding: 0 var(--db-space-2); white-space: nowrap; flex-shrink: 0;
  }
  .tree-delete {
    display: inline-flex; align-items: center; min-block-size: 28px;
    border: var(--db-border-w) solid var(--db-danger-line); background: var(--db-surface); color: var(--db-danger);
    border-radius: var(--db-radius-pill); padding: 0 var(--db-space-2); font: inherit; font-size: var(--db-text-xs); font-weight: 500; cursor: pointer;
  }
  .tree-delete:hover { background: var(--db-danger-soft); }
  .tree-note { margin: 0 0 var(--db-space-2); font-size: var(--db-text-sm); color: var(--db-ink-muted); }
`;

/**
 * The folded inspector's stub in the floating drawer: one small card holding its button, not a
 * strip the drawer's height. Its own sheet, since the stub paints without PROPERTIES_STYLES.
 */
export const INSPECTOR_STUB_STYLES = `
  :host([data-floating]) .panel--stub {
    height: auto; padding: var(--db-space-1) 0; overflow: visible;
    border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-pill); box-shadow: var(--db-shadow-card);
  }
`;

export const PROPERTIES_STYLES = `
  /*
   * The panel is a column: a fixed head and tab strip, one scrolling body, and a footer that
   * stays put. Save / Cancel / Delete must never scroll out of reach — the panel is narrow and
   * a long property list would otherwise hide the only way to commit an edit.
   */
  .panel { display: flex; flex-direction: column; overflow: hidden; }
  /*
   * The shell docks the panel in a column as tall as itself, so the body takes
   * whatever the head and the footer leave and scrolls inside it; a host that leaves the
   * panel unbounded gets a body as tall as its content, with the sticky footer covering that.
   */
  .inspector-body { flex: 1; min-height: 0; overflow: auto; }
  /*
   * Pill tabs, the studio's segmented look: transparent until chosen, the chosen one in the
   * strong --db-selected fill. 34px tall, past WCAG 2.5.8's floor.
   */
  .inspector-tabs { position: relative; display: flex; align-items: center; gap: var(--db-space-1); margin-bottom: var(--db-space-3); flex-wrap: nowrap; }
  /*
   * The Form panel names what it edits above its tabs: with two inspectors on
   * screen, the tabs alone would not say which tree's root this one is for.
   */
  .inspector-head { justify-content: flex-start; margin-bottom: var(--db-space-3); }
  .inspector-head strong { font-size: var(--db-text-lg); font-weight: 600; line-height: 1.2; }
  .inspector-filter { margin-bottom: var(--db-space-4); }
  /* The box is the shared one (SHARED_CONTROL_STYLES), the filter's width. */
  .inspector-filter input { width: 100%; }
  .inspector-filter input::placeholder, .property-row input::placeholder { color: var(--db-ink-subtle); }
  .inspector-tab {
    appearance: none; display: inline-flex; align-items: center; gap: var(--db-space-2);
    min-block-size: 34px; padding: 0 var(--db-space-3);
    border: 0; border-radius: var(--db-radius-pill);
    background: transparent; color: var(--db-ink-muted);
    font: inherit; font-size: var(--db-text-base); font-weight: 500; cursor: pointer;
    transition: background-color var(--db-motion-fast) var(--db-ease), color var(--db-motion-fast) var(--db-ease);
  }
  .inspector-tab:hover { color: var(--db-ink); background: var(--db-surface-hover); }
  .inspector-tab.active, .inspector-tab.active:hover { color: var(--db-selected-ink); background: var(--db-selected); }
  /* A tab's count (Logic's rules): a small chip, its number also in the tab's name. */
  .inspector-tab-count {
    min-inline-size: 18px; padding: 0 var(--db-space-1); border-radius: var(--db-radius-pill);
    background: var(--db-surface-sunken); color: var(--db-ink); font-size: var(--db-text-xs); font-weight: 600; line-height: 18px; text-align: center;
  }
  .inspector-tab.active .inspector-tab-count { background: color-mix(in oklab, var(--db-selected-ink) 22%, transparent); color: var(--db-selected-ink); }
  /* The component's name over its tabs, its type beside it (for example "Legal business name · Short text"). */
  .inspector-title { display: flex; align-items: baseline; gap: var(--db-space-2); min-width: 0; margin-bottom: var(--db-space-3); }
  .inspector-title strong { font-size: var(--db-text-lg); font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .inspector-title span { color: var(--db-ink-muted); font-size: var(--db-text-sm); white-space: nowrap; }
  /* The tabs' ⋯: what is about the component rather than a setting of it (its JSON). */
  /* One row: the tabs may wrap among themselves, the ⋯ stays at the row's end (a narrow drawer, the Form panel's). */
  .inspector-tablist { min-width: 0; display: flex; gap: var(--db-space-1); flex-wrap: wrap; }
  .inspector-more { margin-inline-start: auto; }
  /* The shared menu (SHARED_PATTERN_STYLES), dropped from the tabs' end. */
  .inspector-menu { position: absolute; inset-inline-end: 0; top: calc(100% + var(--db-space-1)); }
  .style-options { border: 0; margin: 0 0 var(--db-space-4); padding: 0; display: grid; gap: var(--db-space-2); }
  .style-option { display: flex; align-items: flex-start; gap: var(--db-space-2); min-block-size: 24px; font-size: var(--db-text-md); cursor: pointer; }
  /* The caption's first line centred on the 24px box. */
  .style-option-text { display: grid; gap: 2px; padding-top: 3px; }
  .style-option-help { color: var(--db-ink-muted); font-size: var(--db-text-sm); }
  .style-option-group { border: 0; margin: 0; padding: 0; display: grid; gap: var(--db-space-2); }
  .style-options legend, .style-option-group legend { padding: 0; margin-bottom: var(--db-space-2); font-size: var(--db-text-md); font-weight: 600; color: var(--db-ink); }
  /*
   * The footer spans the drawer edge to edge (it gives the panel's padding back) under a
   * divider: Delete at the start, the secondary Cancel and the strong commit at the end.
   */
  .inspector-footer {
    position: sticky; bottom: calc(-1 * var(--db-space-3)); z-index: 1;
    display: flex; flex-direction: column; gap: var(--db-space-2);
    margin: var(--db-space-3) calc(-1 * var(--db-space-4)) calc(-1 * var(--db-space-3)); padding: var(--db-space-3) var(--db-space-4);
    border-top: var(--db-border-w) solid var(--db-line-divider); background: var(--db-surface);
  }
  .inspector-footer-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-2); }
  /* Delete is last in the markup so Tab reaches Discard and Apply first, and still draws first. */
  .inspector-footer-row > [data-inspector-delete] { order: -1; }
  .inspector-footer .spacer { flex: 1; }
  .inspector-footer .btn.primary { background: var(--db-selected); border-color: var(--db-selected); color: var(--db-selected-ink); }
  .inspector-footer .btn.primary:hover:not(:disabled) { background: color-mix(in oklab, var(--db-selected) 84%, var(--db-surface)); border-color: var(--db-selected); }
  /* Waiting for Save: the warn ink and a dot, so the state is a word and a mark, not a hue alone. */
  .dirty-flag { display: inline-flex; align-items: center; gap: var(--db-space-1); font-size: var(--db-text-sm); font-weight: 500; color: var(--db-warn); }
  .dirty-flag::before { content: ""; inline-size: 8px; block-size: 8px; border-radius: 50%; background: currentColor; }
  /*
   * The line above Save: what holds it back, and the way there. One problem shows its message;
   * several show their count, which opens their list.
   */
  .problem-summary {
    appearance: none; display: block; width: 100%; min-block-size: 32px; text-align: start; cursor: pointer;
    padding: var(--db-space-2) var(--db-space-3); border-radius: var(--db-radius-md);
    border: var(--db-border-w) solid var(--db-danger-line); background: var(--db-danger-soft);
    font: inherit; font-size: var(--db-text-sm); color: var(--db-danger);
  }
  .problem-summary:hover .problem-summary__count { text-decoration: underline; text-underline-offset: 2px; }
  .problem-summary__count { font-weight: 600; }
  .problem-summary[aria-expanded]::after { content: ""; display: inline-block; flex: none; width: 6px; height: 6px; margin-inline: var(--db-space-2) 0; border-block-end: 1.5px solid currentColor; border-inline-end: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform var(--db-motion-fast) var(--db-ease); }
  .problem-summary[aria-expanded="true"]::after { transform: rotate(45deg); }
  .problem-list {
    list-style: none; margin: 0; padding: var(--db-space-1); display: grid; gap: var(--db-space-half);
    border: var(--db-border-w) solid var(--db-danger-line); background: var(--db-danger-soft);
    border-radius: var(--db-radius-md); max-height: 160px; overflow: auto;
  }
  .problem-item {
    appearance: none; width: 100%; min-block-size: 28px; text-align: start; background: none; border: none; cursor: pointer;
    padding: var(--db-space-1) var(--db-space-2); border-radius: var(--db-radius-sm);
    font: inherit; font-size: var(--db-text-sm); color: var(--db-danger);
  }
  .problem-item:hover { background: var(--db-surface); }
  .problem-item strong { color: var(--db-ink); margin-inline-end: var(--db-space-1); }
  /* A problem's message under its box, and the box it names. */
  .field-error { margin: var(--db-space-1) 0 0; font-size: var(--db-text-sm); color: var(--db-danger); }
  /* The box a problem names: see .property-row input[aria-invalid] after the field rules, which it has to follow. */
  /* Read out, never shown: what a refused Save or a jump to a problem says. */
  .sr-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  /*
   * Sections fold like the rules and translations do. No box: each is a plain heading row
   * (sentence case, the muted 12px heading) with a divider above it, and its rows beneath.
   */
  .inspector-section { border-top: var(--db-border-w) solid var(--db-line-divider); }
  .inspector-body > .inspector-section:first-child { border-top: 0; }
  .inspector-section > summary {
    cursor: pointer; list-style: none; min-block-size: 40px; padding: var(--db-space-2) 0; display: flex; align-items: center;
    gap: var(--db-space-2); font-size: var(--db-text-sm); font-weight: 600; letter-spacing: .02em; color: var(--db-ink-muted);
  }
  .inspector-section > summary:hover { color: var(--db-ink); }
  .inspector-section > summary::-webkit-details-marker { display: none; }
  .inspector-section > summary::before, .rule > summary::before { content: ""; display: inline-block; flex: none; width: 6px; height: 6px; margin-inline: 2px 4px; border-block-end: 1.5px solid currentColor; border-inline-end: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform var(--db-motion-fast) var(--db-ease); }
  .inspector-section[open] > summary::before, .rule[open] > summary::before { transform: rotate(45deg); }
  .inspector-section-body { padding: var(--db-space-1) 0 var(--db-space-2); }
  /* Advisory, not a refusal — amber, and Save stays live. */
  .css-class-warning { margin: calc(-1 * var(--db-space-2)) 0 var(--db-space-3); font-size: var(--db-text-sm); color: var(--db-warn); }
  /* A note the tree's owner makes about a box: advisory like the class warning, never counted against Save. */
  .field-note { margin: var(--db-space-1) 0 0; font-size: var(--db-text-sm); color: var(--db-warn); }
  .field-note[data-severity="error"] { color: var(--db-danger); }
  /* A line that only informs (a rule calculates the answer): muted, never amber. */
  .field-note[data-severity="info"] { color: var(--db-ink-muted); }
  /* Notes about the component as a whole, or about a box this tab does not draw: above the sections. */
  .inspector-notes { display: grid; gap: var(--db-space-1); margin: 0 0 var(--db-space-3); }
  .inspector-notes .field-note { margin: 0; }
  /*
   * Label above input, not beside it. The panel is a narrow column; a fixed label gutter took
   * a third of it and left every text box too short to read a label or an id in. Stacking
   * gives the input the panel's full width, which is where the author is actually working.
   */
  .property-row { display: grid; gap: calc(var(--db-space-1) + var(--db-space-half)); margin-bottom: var(--db-space-4); font-size: var(--db-text-md); }
  .property-row > strong, .property-row > span:first-child, .property-label strong { font-size: var(--db-text-md); color: var(--db-ink); font-weight: 500; }
  .property-row input[type="text"], .property-row input[type="number"], .property-row select {
    border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-md); min-block-size: var(--db-control-h); padding: 0 var(--db-space-3); width: 100%;
    background: var(--db-surface); color: var(--db-ink); font: inherit; font-size: var(--db-text-base);
  }
  /* After the field rules, so the danger border wins over theirs. */
  .property-row input[aria-invalid="true"], .property-row select[aria-invalid="true"], .property-row textarea[aria-invalid="true"] {
    border-color: var(--db-danger);
  }
  .property-static { color: var(--db-ink-muted); font-family: var(--db-font-mono); font-size: var(--db-text-sm); word-break: break-all; }
  /*
   * A property with a description gets a "?" beside its label. The text is one click away
   * (or a hover, through the button's title) rather than always on screen: most rows do not
   * need it, and a panel of hints would bury the controls. See labeledRowHtml. The toggle is a
   * 24px round chip (WCAG 2.5.8's floor), pressed in the strong fill while its note is open.
   */
  .property-label { display: flex; align-items: center; gap: var(--db-space-1); }
  .property-help-toggle {
    flex: none; inline-size: 24px; block-size: 24px; min-inline-size: 24px; min-block-size: 24px; padding: 0;
    border-radius: var(--db-radius-pill); border: 0;
    background: var(--db-surface-sunken); color: var(--db-ink-muted); font: inherit; font-size: var(--db-text-xs); font-weight: 600;
    line-height: 1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
    transition: background-color var(--db-motion-fast) var(--db-ease), color var(--db-motion-fast) var(--db-ease);
  }
  .property-help-toggle:hover { background: var(--db-surface-hover); color: var(--db-ink); }
  .property-help-toggle[aria-expanded="true"] { background: var(--db-selected); color: var(--db-selected-ink); }
  @media (forced-colors: active) {
    .property-help-toggle { border: var(--db-border-w) solid ButtonText; }
  }
  .property-help { margin: 0; font-size: var(--db-text-sm); line-height: 1.4; color: var(--db-ink-muted); }
  pre { margin: 0; background: var(--db-surface-sunken); border: var(--db-border-w) solid var(--db-line-divider); border-radius: var(--db-radius-md); padding: var(--db-space-3); font-family: var(--db-font-mono); font-size: var(--db-text-sm); max-height: 340px; overflow: auto; }
  /*
   * JSON tab. The viewer is the tab's whole body: edge to edge across the panel (the body
   * gives the panel's padding back, as the footer does) and as tall as the rail lets the body
   * be, the editor's own scroller doing the scrolling. The <pre> the markup carries is the
   * text's source, and what shows until the panel mounts the editor beside it — hidden from
   * then on, but still there for a host that reads the JSON from the DOM (see
   * DatumBuilderPropertiesElement.mountJsonViewer). Where nothing bounds the rail the body
   * grows with the document to its usual cap and scrolls itself, as it did for the <pre>.
   */
  .inspector-body:has(> [data-json-view]) { display: flex; flex-direction: column; margin: 0 calc(-1 * var(--db-space-4)); }
  [data-json-view] { flex: 1; min-height: 0; max-height: none; border-radius: 0; border-width: var(--db-border-w) 0; }
  [data-json-view][hidden] { display: none; }
  .json-editor {
    flex: 1; min-height: 240px; display: flex; flex-direction: column;
    border-top: var(--db-border-w) solid var(--db-line-divider); border-bottom: var(--db-border-w) solid var(--db-line-divider);
  }
  .json-editor > .cm-editor { flex: 1; min-height: 0; }
  /*
   * The inspector's JSON is a box to edit: the textarea is the box until the editor
   * mounts, and for good if it never does. The line about children sits above it and a problem
   * under it, each its own height, the box taking the rest.
   */
  textarea.json-edit {
    width: 100%; min-height: 240px; resize: none; padding: var(--db-space-3);
    font-family: var(--db-font-mono); font-size: var(--db-text-sm); line-height: 1.5;
    color: var(--db-ink); background: var(--db-surface-sunken);
  }
  .inspector-body:has(> [data-json-view]) > .json-note,
  .inspector-body:has(> [data-json-view]) > .json-error { flex: none; margin: var(--db-space-2) var(--db-space-4); }
  .json-note { font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  /*
   * A checkbox's caption belongs beside it, not above: the control is the smaller half. The box
   * is the shared one (SHARED_CONTROL_STYLES): 24px square, WCAG 2.5.8's floor for a target
   * (Required, a PDF layout's title setting), in the strong fill when ticked.
   */
  .property-row:has(> input[type="checkbox"]) {
    grid-template-columns: auto 1fr; align-items: center; column-gap: var(--db-space-3);
  }
  .property-row > input[type="checkbox"] { justify-self: start; order: -1; }
  /* With a description the row has a third child, the help text; it spans under both. */
  .property-row--help:has(> input[type="checkbox"]) { row-gap: var(--db-space-1); }
  .property-row--help:has(> input[type="checkbox"]) > .property-help { grid-column: 1 / -1; }
  .locale-hint { margin: 0 0 var(--db-space-2); font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  /* The pointer line under a component's texts: coverage in words, then the way to Languages. */
  .translation-pointer { display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-2); margin: var(--db-space-2) 0 0; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  .translation-pointer-text { flex: 1 1 auto; min-width: 0; }

  ${TREE_STYLES}

  .rules-note { margin: 0 0 var(--db-space-3); font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  /* A rule is a card, as on the Logic board: white, a card line, the studio's sheet corner. */
  .rule { border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-lg); margin-bottom: var(--db-space-2); background: var(--db-surface); }
  .rule > summary {
    cursor: pointer; list-style: none; min-block-size: 40px; padding: var(--db-space-2) var(--db-space-3); display: flex; align-items: center;
    gap: var(--db-space-2); font-size: var(--db-text-md); font-weight: 600; border-radius: var(--db-radius-lg);
  }
  .rule > summary:hover { background: var(--db-surface-hover); }
  .rule[open] > summary { border-end-start-radius: 0; border-end-end-radius: 0; }
  .rule > summary::-webkit-details-marker { display: none; }
  .rule-state {
    margin-inline-start: auto; font-weight: 500; font-size: var(--db-text-xs); white-space: nowrap;
    color: var(--db-ink-muted); background: var(--db-surface-sunken); border-radius: var(--db-radius-pill); padding: 0 var(--db-space-2);
  }
  .rule-state.on { color: var(--db-accent-text); background: var(--db-accent-soft); }
  .rule-body { padding: 0 var(--db-space-3) var(--db-space-3); display: grid; gap: var(--db-space-3); }
  .rule-desc { margin: 0; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  /* The head: the Off / Formula segmented control (the shared .seg look, in SHARED_PATTERN_STYLES) and the Runs control. */
  .rule-head { display: flex; align-items: center; justify-content: space-between; gap: var(--db-space-2); flex-wrap: wrap; }
  /* Where the rule runs: a select-looking button opening the four scopes, each with its consequence. */
  .rule-run { position: relative; }
  .rule-run > summary {
    list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: var(--db-space-1); min-block-size: 30px; padding: 0 var(--db-space-3);
    border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-pill); background: var(--db-surface);
    font-size: var(--db-text-sm); font-weight: 500; color: var(--db-ink); white-space: nowrap;
  }
  .rule-run > summary::-webkit-details-marker { display: none; }
  .rule-run > summary:hover { background: var(--db-surface-hover); }
  .rule-run > summary::after { content: ""; display: inline-block; width: 5px; height: 5px; margin-inline-start: 2px; border-block-end: 1.5px solid currentColor; border-inline-end: 1.5px solid currentColor; transform: translateY(-2px) rotate(45deg); }
  .rule-run-menu {
    position: absolute; inset-inline-end: 0; top: calc(100% + 4px); z-index: var(--db-z-popover, 30); min-width: 300px; max-width: min(360px, 90vw);
    display: grid; gap: 2px; padding: var(--db-space-1); background: var(--db-surface); color: var(--db-ink);
    border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-lg); box-shadow: var(--db-shadow-overlay, 0 24px 48px -20px rgba(0,0,0,.45));
  }
  .rule-run-option {
    display: grid; gap: 2px; text-align: start; border: 0; background: transparent; border-radius: var(--db-radius-md); padding: var(--db-space-2) var(--db-space-3);
    font: inherit; font-size: var(--db-text-sm); color: var(--db-ink); cursor: pointer;
  }
  .rule-run-option:hover, .rule-run-option:focus-visible { background: var(--db-surface-hover); }
  .rule-run-option:focus-visible { outline: 2px solid var(--db-focus); outline-offset: -2px; }
  .rule-run-option[aria-checked="true"] { background: var(--db-surface-sunken); }
  .rule-run-option b { font-weight: 500; }
  .rule-run-option span { font-size: var(--db-text-xs); color: var(--db-ink-muted); }
  .rule-run-fixed {
    display: inline-flex; align-items: center; min-block-size: 26px; padding: 0 var(--db-space-2); border-radius: var(--db-radius-pill);
    background: var(--db-surface-sunken); color: var(--db-ink-muted); font-size: var(--db-text-xs); font-weight: 500; white-space: nowrap; cursor: help;
  }
  /* The formula box: the plain textarea first, the editor (formula-editor-styles.ts) swapped in over it when its chunk lands. */
  .rule-formula { display: grid; gap: var(--db-space-2); min-width: 0; }
  /* The shared textarea (SHARED_CONTROL_STYLES), at the formula's size. */
  .rule-formula-box { width: 100%; min-height: 44px; resize: vertical; font: inherit; font-size: var(--db-text-sm); line-height: 1.6; }
  .rule-formula-box[aria-invalid="true"] { border-color: var(--db-danger-line); }
  .rule-formula-box[hidden] { display: none; }
  .rule-try { display: flex; flex-wrap: wrap; gap: var(--db-space-1); align-items: center; font-size: var(--db-text-xs); color: var(--db-ink-muted); }
  .rule-reads { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 5px; margin: 0; font-size: var(--db-text-xs); color: var(--db-ink-muted); line-height: 24px; }
  .rule-reads-label { font-size: var(--db-text-xs); font-weight: 600; letter-spacing: .02em; color: var(--db-ink-muted); margin-inline-end: 2px; }
  /*
   * A field it reads is the shared .ref-chip, a value the same chip in the sunken well, a formula
   * to try the shared .try-chip. They keep the line's 11px: at 12px the Reads as line no longer
   * fits the inspector's column and its last words wrap under the chips.
   */
  .rule-reads .val { background: var(--db-surface-sunken); color: var(--db-ink); }
  .rule-reads > *, .rule-try > * { font-size: inherit; }
  .rule-links { margin: 0; display: flex; justify-content: flex-end; font-size: var(--db-text-xs); }
  .rule-warning { margin: 0; font-size: var(--db-text-sm); color: var(--db-warn); }
  .rule-editor-failed { margin: 0; display: flex; gap: var(--db-space-2); align-items: center; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  /* An expression property's JSON box (the inspector's expression control). */
  .rule-json { width: 100%; min-height: 108px; resize: vertical; font-family: var(--db-font-mono); font-size: var(--db-text-sm); }
  .rule-error { margin: 0; font-size: var(--db-text-sm); color: var(--db-danger); }
  .rule-hint { margin: 0; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  /* The head's and the identity rows' groupings draw nothing of their own outside the floating drawer. */
  .inspector-top { display: contents; }
  /*
   * The floating drawer: the shell's inspector drawer sets data-floating
   * and draws no frame, and the panel is a stack of cards over the canvas. The head (name, tabs,
   * filter) is one card, each part of the body (the identity rows, a section, a rule, a note)
   * another, and Apply and Discard a card of their own after them. Still one panel with one
   * Apply: only the dressing moves. Every place is CSS: the column takes its
   * content's height up to the drawer's, its body scrolls, and the canvas under the gaps and
   * under a short column takes the pointer. Last, so it overrides the rules above.
   */
  :host([data-floating]) { pointer-events: none; }
  :host([data-floating]) .panel:not(.panel--stub) {
    height: auto; max-height: 100%; padding: 0; gap: var(--db-space-2);
    background: transparent; overflow: visible;
  }
  :host([data-floating]) .panel:not(.panel--stub) > * { pointer-events: auto; }
  :host([data-floating]) :is(.inspector-top, .inspector-footer, .inspector-body > *) {
    background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card);
    border-radius: var(--db-radius-xl); box-shadow: var(--db-shadow-card);
  }
  :host([data-floating]) .inspector-top { display: block; flex: none; padding: var(--db-space-3) var(--db-space-4); }
  :host([data-floating]) .inspector-top > :last-child { margin-bottom: 0; }
  /*
   * The body scrolls the cards. Its inline padding, given back by a margin, leaves the cards'
   * shadows room inside the scroller, which clips them; the cards still line up with the head's.
   */
  :host([data-floating]) .inspector-body {
    flex: 0 1 auto; display: flex; flex-direction: column; gap: var(--db-space-2);
    margin: 0 calc(-1 * var(--db-space-2)); padding: 0 var(--db-space-2) var(--db-space-3);
  }
  :host([data-floating]) .inspector-body > * { flex: none; margin: 0; padding: var(--db-space-3) var(--db-space-4); }
  :host([data-floating]) .inspector-body > .inspector-section { border-top: var(--db-border-w) solid var(--db-line-card); padding-block: 0; }
  :host([data-floating]) .inspector-section > summary { min-block-size: 44px; }
  :host([data-floating]) .inspector-body > .rule { padding: 0; border-radius: var(--db-radius-lg); }
  :host([data-floating]) .inspector-body > .drop-error { background: var(--db-danger-soft); border-color: var(--db-danger-line); }
  :host([data-floating]) .inspector-body > .inspector-about > .property-row:last-child { margin-bottom: 0; }
  :host([data-floating]) .inspector-section-body > :last-child { margin-bottom: var(--db-space-3); }
  /* The JSON is one card the body's whole height, the viewer edge to edge inside it. */
  :host([data-floating]) .inspector-body:has(> [data-json-view]) {
    flex: 1 1 auto; gap: 0; margin: 0; padding: 0; overflow: hidden;
    background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card);
    border-radius: var(--db-radius-xl); box-shadow: var(--db-shadow-card);
  }
  :host([data-floating]) .inspector-body:has(> [data-json-view]) > * { flex: 1 1 auto; padding: 0; border: 0; border-radius: 0; box-shadow: none; }
  :host([data-floating]) .inspector-body:has(> [data-json-view]) > [hidden] { display: none; }
  :host([data-floating]) .json-editor { border: 0; }
  :host([data-floating]) .inspector-body:has(> [data-json-view]) > .json-note,
  :host([data-floating]) .inspector-body:has(> [data-json-view]) > .json-error { flex: none; padding: 0; margin: var(--db-space-2) var(--db-space-4); }
  :host([data-floating]) .inspector-body:has(> [data-json-view]) > textarea.json-edit { padding: var(--db-space-3); }
  /* Apply and Discard: a card pinned under the cards, raised like the drawer it replaces. */
  :host([data-floating]) .inspector-footer {
    position: static; flex: none; margin: 0; padding: var(--db-space-3) var(--db-space-4);
    box-shadow: var(--db-shadow-overlay);
  }
${FORMULA_EDITOR_STYLES}
  /*
   * The phone sheet: the footer clears the home indicator through the
   * shell's safe-area token, and the tabs, buttons, menu rows and help toggles measure 44px
   * (the help chip keeps its 24px look and takes a 44px hit area).
   */
  :host([data-phone]) .inspector-footer { padding-bottom: calc(var(--db-space-3) + var(--db-safe-bottom, env(safe-area-inset-bottom, 0px))); }
  :host([data-phone]) .inspector-tab { min-block-size: var(--db-density-control-h, 44px); min-inline-size: var(--db-density-control-h, 44px); justify-content: center; }
  :host([data-phone]) .inspector-footer .btn, :host([data-phone]) .inspector-body .btn { min-block-size: var(--db-density-control-h, 44px); }
  :host([data-phone]) .menu-item, :host([data-phone]) .problem-summary { min-block-size: var(--db-density-control-h, 44px); }
  :host([data-phone]) .property-help-toggle { position: relative; }
  :host([data-phone]) .property-help-toggle::after { content: ""; position: absolute; inset: -10px; }
`;

export interface TreeTabOptions {
  selectedId: string | undefined;
  /** Component ids the preview is currently hiding (a false `rules.visibleWhen`, or `hidden`). */
  hiddenIds: ReadonlySet<string>;
  /**
   * Whether rows carry a delete control. The builder's own tree dropdown is for navigating and
   * selecting, so it sets this false: an irreversible action does not belong on a list an
   * author is scrolling through to find something. Defaults to true for a host rendering the
   * tree as a standalone editor.
   */
  deletable?: boolean | undefined;
  /** The line above the rows; the form's wording when omitted. */
  note?: string | undefined;
  /** The builder's words; English when absent. */
  words?: BuilderTextOptions | undefined;
}

/**
 * The component tree as a selectable list — every component the form has, including the ones
 * the canvas is not painting, with a marker on those. It is the index of the form, and the way
 * to reach a component gated behind a rule.
 */
export function treeTabHtml(view: NestedTreeNodeView, options: TreeTabOptions): string {
  const rows: string[] = [];
  const walk = (node: NestedTreeNodeView, depth: number): void => {
    const active = options.selectedId === node.id ? " active" : "";
    const hidden = options.hiddenIds.has(node.id)
      ? ` <span class="tree-hidden">${esc(builderText("tree.hidden", undefined, options.words))}</span>`
      : "";
    // The root cannot be removed, and a navigation-only listing carries no delete at all.
    const showDelete = depth > 0 && options.deletable !== false;
    // The type and the id, unless the id already begins with the type (a journey's `journey`,
    // its `journey-page_1`): saying it twice only crowds the row.
    const meta = node.id.startsWith(node.type) ? node.id : `${node.type} · ${node.id}`;
    rows.push(`<div class="tree-row" style="padding-left:${depth * 12}px">
        <button type="button" class="tree-select${active}" data-tree-select="${esc(node.id)}">
          <span class="tree-label" title="${esc(node.label)}">${esc(node.label)}</span>
          <span class="tree-meta" title="${esc(meta)}">${esc(meta)}</span>${hidden}
        </button>
        ${showDelete ? `<button type="button" class="tree-delete" data-tree-delete="${esc(node.id)}">${esc(builderText("common.delete", undefined, options.words))}</button>` : ""}
      </div>`);
    for (const slot of node.slots) {
      for (const child of slot.children) {
        walk(child, depth + 1);
      }
    }
  };
  walk(view, 0);

  return `<p class="tree-note">${esc(options.note ?? builderText("tree.note", undefined, options.words))}</p>
    <div class="tree-list">${rows.join("")}</div>`;
}

/** A DOM id for a property path: `style.font.size` becomes `prop-style-font-size`. */
function propertyDomId(propertyPath: string): string {
  return `prop-${propertyPath.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

/**
 * A labelled row for a plain control (text, number, select, checkbox, the default box of a
 * localized text). Without a description it is the label-wrapped row the panel has always
 * drawn. With one, the label gains a "?" toggle and the description sits under the control,
 * hidden until asked for (hover reads it as a tooltip). The toggle is a button, and a button
 * cannot live inside a `<label>` (it is labelable itself and would steal the association), so
 * that variant is a `<div>` with an explicit `for` / `id` pair. The label text stays inside
 * `<strong>` and the toggle outside it: the property filter matches rows on that element's
 * text. `openHelp` is the set of paths whose description the author has expanded. `notes` are
 * the tree owner's advisory notes about the box, drawn under it and read with it,
 * without marking it invalid.
 */
function labeledRowHtml(
  field: InspectorField,
  openHelp: ReadonlySet<string>,
  control: (extraAttrs: string) => string,
  problem?: string,
  notes: readonly InspectorNoteView[] = [],
  words?: BuilderTextOptions
): string {
  if (!field.description && problem === undefined && notes.length === 0) {
    return `<label class="property-row"><strong>${esc(field.label)}</strong>
    ${control("")}</label>`;
  }
  const id = propertyDomId(field.propertyPath);
  const helpId = `${id}-help`;
  const errorId = problemDomId(field.propertyPath);
  const open = openHelp.has(field.propertyPath);
  const noteIds = notes.map((_, index) => noteDomId(field.propertyPath, index));
  const describedBy = [field.description ? helpId : undefined, problem !== undefined ? errorId : undefined, ...noteIds].filter(Boolean).join(" ");
  const help = field.description
    ? `<button type="button" class="property-help-toggle" data-help-toggle="${esc(field.propertyPath)}"
        aria-expanded="${open ? "true" : "false"}" aria-controls="${helpId}"
        aria-label="${esc(builderText("inspector.helpOf", { label: field.label }, words))}" title="${esc(field.description)}">?</button>`
    : "";
  return `<div class="property-row${field.description ? " property-row--help" : ""}">
    <span class="property-label"><label for="${id}"><strong>${esc(field.label)}</strong></label>
      ${help}</span>
    ${control(` id="${id}" aria-describedby="${describedBy}"${problem !== undefined ? ' aria-invalid="true"' : ""}`)}
    ${field.description ? `<p class="property-help" id="${helpId}"${open ? "" : " hidden"}>${esc(field.description)}</p>` : ""}
    ${problem !== undefined ? fieldErrorHtml(field.propertyPath, problem) : ""}
    ${fieldNotesHtml(field.propertyPath, notes)}
  </div>`;
}

/**
 * The "?" and its note for one of the panel's own rows, the ID and Saved as, drawn as
 * {@link labeledRowHtml} draws a described property's. `key` is what the panel remembers the
 * note open under, beside the property paths.
 */
function identityHelpHtml(
  key: "id" | "savedAs",
  label: string,
  text: string,
  openHelp: ReadonlySet<string>,
  words?: BuilderTextOptions
): { id: string; toggle: string; text: string } {
  const id = `${propertyDomId(key)}-help`;
  const open = openHelp.has(key);
  return {
    id,
    toggle: `<button type="button" class="property-help-toggle" data-help-toggle="${key}"
      aria-expanded="${open ? "true" : "false"}" aria-controls="${id}"
      aria-label="${esc(builderText("inspector.helpOf", { label }, words))}" title="${esc(text)}">?</button>`,
    text: `<p class="property-help" id="${id}"${open ? "" : " hidden"}>${esc(text)}</p>`
  };
}

/**
 * What the ID's "?" says. An id names its component across the whole tree, so no two share
 * one, whatever containers they sit in. On the form's own tree it also says how the id relates
 * to where the component's data is stored, which the Saved as line shows when the two differ
 *. A PDF layout's components store nothing: they show the form's answers.
 */
export function idHelpText(node: ComponentNode, place: { isRoot: boolean; formTree: boolean }, words?: BuilderTextOptions): string {
  if (!place.formTree) {
    return builderText(place.isRoot ? "idHelp.layoutRoot" : "idHelp.layout", undefined, words);
  }
  if (place.isRoot) {
    return builderText("idHelp.formRoot", undefined, words);
  }
  const name = builderText("idHelp.name", undefined, words);
  const rest =
    node.collection !== undefined
      ? "idHelp.collection"
      : isDataScopeContainer(node)
        ? "idHelp.scope"
        : holdsData(node)
          ? "idHelp.data"
          : "idHelp.none";
  return `${name} ${builderText(rest, undefined, words)}`;
}

/**
 * What the Saved as line's "?" says: what the path is, how it is made, and, inside a
 * repeating section, what its `[]` stands for.
 */
export function savedAsHelpText(node: ComponentNode, path: string, words?: BuilderTextOptions): string {
  if (node.collection !== undefined) {
    return builderText("savedAsHelp.collection", undefined, words);
  }
  const made = builderText("savedAsHelp.made", undefined, words);
  const entry = path.includes("[]") ? builderText("savedAsHelp.entry", { example: path.replace("[]", "[0]") }, words) : "";
  const sentences = isDataScopeContainer(node)
    ? [builderText("savedAsHelp.container", undefined, words), made, entry]
    : [builderText("savedAsHelp.answer", undefined, words), made, entry, builderText("savedAsHelp.tail", undefined, words)];
  return sentences.filter((sentence) => sentence !== "").join(" ");
}

/** The DOM id of the message a problem at `target` draws under its box (`"id"`, a property path, `rules:<key>`). */
export function problemDomId(target: string): string {
  return `problem-${target.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

/** A problem's message as its box draws it: the box names it through `aria-describedby`. */
function fieldErrorHtml(target: string, message: string): string {
  return `<p class="field-error" id="${problemDomId(target)}" data-problem="${esc(target)}">${esc(message)}</p>`;
}

/**
 * An advisory note as the panel draws it (`BuilderNote`): under the box it is about,
 * or above the sections. Never a problem: it is not listed by the footer and holds nothing back.
 */
export interface InspectorNoteView {
  message: string;
  severity?: "error" | "warning" | undefined;
}

/** The DOM id of the `index`th note under the box at `target`. */
function noteDomId(target: string, index: number): string {
  return `note-${target.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${index}`;
}

/** The notes under the box at `target`, each named by the box's `aria-describedby`. */
function fieldNotesHtml(target: string, notes: readonly InspectorNoteView[]): string {
  return notes
    .map(
      (note, index) =>
        `<p class="field-note" id="${noteDomId(target, index)}" data-note="${esc(target)}" data-severity="${note.severity ?? "warning"}">${esc(note.message)}</p>`
    )
    .join("");
}

/**
 * A `localized-text` field is a translatable string: one plain box for the
 * default-language text. Its translations are the Languages workspace's, reached from the
 * pointer line under the component's texts (see {@link translationPointerHtml}).
 */
function localizedTextFieldHtml(field: InspectorField, context: FieldRenderContext): string {
  const text = typeof field.value === "string" ? field.value : "";
  const attrs = `data-prop="${esc(field.propertyPath)}" data-control="localized-text"`;
  return labeledRowHtml(
    field,
    context.openHelp,
    (extra) => `<input ${attrs}${extra} type="text" value="${esc(text)}" />`,
    context.problems.get(field.propertyPath),
    context.notes.get(field.propertyPath),
    context.words
  );
}

/** One language's standing for the component the pointer line speaks of. */
export interface TranslationCoverageEntry {
  /** The language code. */
  code: string;
  /** The language under the name the form gave it. */
  label: string;
  /** How many of the component's texts have no current translation in it (stale counts as missing). */
  missing: number;
}

/**
 * How well the texts `pick` chooses are translated, one entry per language besides the default
 * (the pointer line). The counts are the Languages workspace's own:
 * the rows come from its model (`languagesTexts` over the committed form, the map and the page's
 * catalog) and each language's figure from `languageCoverage`, so the pointer and the Texts
 * grid cannot disagree: a text the page's catalog words counts as translated, a stale one as
 * missing. Empty when the form declares one language or `pick` chooses no text.
 */
export function translationCoverageOf(controller: CoverageSource, pick: (text: TranslatableText) => boolean): TranslationCoverageEntry[] {
  return translationCoverageReader(controller)(pick);
}

/** What {@link translationCoverageOf} reads from the controller. */
type CoverageSource = Pick<BuilderController, "localization" | "translatableTexts" | "translations" | "translationCatalog">;

/**
 * {@link translationCoverageOf} for several picks over one read of the form: the Header & footer
 * panel asks once per part, and the texts are read once for all of them (and not at all for a
 * form of one language). The rules are the Languages model's own leaf (`languages-cells.ts`:
 * the same texts listed, the same cell status), so the pointer and the Texts grid cannot
 * disagree, and the model's chunk stays lazy.
 */
export function translationCoverageReader(controller: CoverageSource): (pick: (text: TranslatableText) => boolean) => TranslationCoverageEntry[] {
  const localization = controller.localization();
  const others = translationColumns(localization);
  let texts: TranslatableText[] | undefined;
  let sources: { translations: FormTranslations | undefined; catalog: TranslationCatalog | undefined } | undefined;
  return (pick) => {
    if (others.length === 0) {
      return [];
    }
    sources ??= { translations: controller.translations(), catalog: controller.translationCatalog() };
    texts ??= wordedTexts(controller.translatableTexts(), localization, sources);
    const mine = texts.filter(pick);
    if (mine.length === 0) {
      return [];
    }
    return others.map((entry) => {
      const coverage = textsCoverage(mine, entry.code, sources!);
      return { code: entry.code, label: entry.label, missing: coverage.total - coverage.translated };
    });
  };
}

/**
 * The one line under a component's texts when the form declares more than one language
 *: the languages that have everything, then each that lacks some with how
 * many, and (`offerOpen`, when the shell has the workspace) the way to the Languages workspace
 * filtered to this component (or, with `target`, to a header or footer part: the button names it
 * for the Header & footer panel's goto). Nothing is drawn for a single-language form, or when
 * the component shows no text (`coverage` empty).
 */
export function translationPointerHtml(coverage: readonly TranslationCoverageEntry[], words?: BuilderTextOptions, offerOpen = true, target?: { id: string; label: string }): string {
  if (coverage.length === 0) {
    return "";
  }
  const complete = coverage.filter((entry) => entry.missing === 0).map((entry) => entry.label);
  const lacking = coverage.filter((entry) => entry.missing > 0);
  const parts = [
    ...(complete.length > 0 ? [builderText("inspector.pointer.done", { languages: complete.join(" · ") }, words)] : []),
    ...lacking.map((entry) => builderText("inspector.pointer.missing", { language: entry.label, count: entry.missing }, words))
  ];
  return `<div class="translation-pointer" data-translation-pointer>
    <span class="translation-pointer-text" data-translation-coverage>${esc(parts.join(" · "))}</span>
    ${
      offerOpen
        ? `<button type="button" class="btn" data-open-in-languages${target ? `="${esc(target.id)}" aria-label="${esc(builderText("inspector.pointer.openPart", { part: target.label }, words))}"` : ""}>${esc(builderText("inspector.pointer.open", undefined, words))}</button>`
        : ""
    }</div>`;
}

/** Per-render context threaded to every field, so a field can reach panel-level state. */
interface FieldRenderContext {
  /** Property paths whose "?" description the author expanded; see {@link labeledRowHtml}. */
  openHelp: ReadonlySet<string>;
  /**
   * What holds the component's Save back, by where it is — `"id"` or a property path — each
   * drawn under its own box, which is marked invalid and described by the message.
   */
  problems: ReadonlyMap<string, string>;
  /** Advisory note about classes the binding does not declare. Shown, never blocking. */
  cssClassWarning: string | undefined;
  /**
   * The tree owner's advisory notes, by the property path of the box each is about
   * (`BuilderNote`): drawn under it, never blocking. A box with a problem shows the
   * problem alone, which says the same thing more urgently.
   */
  notes: ReadonlyMap<string, readonly InspectorNoteView[]>;
  /**
   * An `expression` control's text as the author is typing it, by property path. JSON
   * mid-keystroke has no expression to store, so the panel keeps the text itself and the box
   * shows it rather than the last value that parsed (see {@link expressionFieldHtml}).
   */
  expressionDrafts: ReadonlyMap<string, string>;
  /** Parse failures of `expression` controls, by property path, shown under the box. */
  expressionErrors: ReadonlyMap<string, string>;
  /** Why a `file` control refused the last pick, by property path, shown under the row. */
  fileErrors: ReadonlyMap<string, string>;
  /** The formula boxes of `formula` controls, by property path (see {@link FormulaFieldView}). */
  formulas: ReadonlyMap<string, FormulaFieldView>;
  /** A choice a left-out feature owns, by the select's property path: not offered unless it is the stored value. */
  hiddenChoices?: ReadonlyMap<string, string>;
  /** Property paths the host manages: drawn as a note, not a box. */
  managed?: ReadonlySet<string>;
  /** The builder's words (locale and catalog); English when absent. */
  words?: BuilderTextOptions | undefined;
}

/**
 * The rows of one inspector section as the properties panel draws them, for a surface that
 * shows a component's fields outside the inspector (the Print workspace's "On paper" card): the
 * same markup, `data-prop` attributes and problem lines. `problems` is `BuilderController.problemsOf`
 * for the component, by box. The caller listens for the boxes' `input`/`change` events and writes
 * through the controller.
 */
export function inspectorSectionRowsHtml(
  section: Pick<InspectorSection, "fields">,
  options: { problems?: ReadonlyArray<{ target: string; message: string }>; words?: BuilderTextOptions | undefined; openHelp?: ReadonlySet<string> } = {}
): string {
  const context: FieldRenderContext = {
    openHelp: options.openHelp ?? new Set<string>(),
    problems: new Map((options.problems ?? []).map((problem) => [problem.target, problem.message])),
    cssClassWarning: undefined,
    notes: new Map(),
    expressionDrafts: new Map(),
    expressionErrors: new Map(),
    fileErrors: new Map(),
    formulas: new Map(),
    words: options.words
  };
  return section.fields.map((field) => inspectorFieldHtml(field, context)).join("\n");
}

/**
 * What a `formula` control draws: the rule view of its value and the options its feedback is
 * drawn with. The panel builds one per paint and refreshes the feedback in place as the author
 * types, exactly as it does for a rule on the Rules tab (the box and the editor are left alone).
 */
export interface FormulaFieldView {
  /** The rule key the box is addressed by (`data-rule`); the panel resolves it back to the field. */
  key: string;
  view: RuleView;
  options: RuleHtmlOptions;
}

/** The row of a `formula` control: a formula box with the Rules tab's feedback under it. */
function formulaFieldHtml(field: InspectorField, context: FieldRenderContext): string {
  const formula = context.formulas.get(field.propertyPath);
  if (!formula) {
    return "";
  }
  const { key, view, options } = formula;
  return `<div class="property-row property-row--formula" data-formula-field="${esc(field.propertyPath)}"><strong>${esc(field.label)}</strong>
    ${ruleFormulaBoxHtml(view, options, field.label)}
    ${field.description ? `<p class="rule-hint">${esc(field.description)}</p>` : ""}
    <div class="rule-feedback" data-rule-feedback="${esc(key)}">${ruleFeedbackHtml(view, options)}</div></div>`;
}

/**
 * The editor a property declared `type: "expression"` gets: the same JSON box as the Rules
 * tab's Expression mode, because the value is the same AST (`core/expressions`) and a plain
 * text box cannot produce it. The box shows, in order, what the author is typing, the stored
 * expression pretty-printed, or a stored *string* as it is — the residue of the plain text
 * box this control once fell back to, left visible so it can be cleared rather than hidden
 * behind `[object Object]`. The hint and the parse error sit inside the row so the property
 * filter hides them with it.
 */
function expressionFieldHtml(field: InspectorField, attrs: string, context: FieldRenderContext): string {
  const draft = context.expressionDrafts.get(field.propertyPath);
  const text =
    draft !== undefined
      ? draft
      : isExpression(field.value)
        ? formatExpressionJson(field.value)
        : typeof field.value === "string"
          ? field.value
          : "";
  const error = context.problems.get(field.propertyPath) ?? context.expressionErrors.get(field.propertyPath);
  const description = field.description ? `${esc(field.description)} ` : "";
  const invalid = error ? ` aria-invalid="true" aria-describedby="${problemDomId(field.propertyPath)}"` : "";
  return `<div class="property-row"><strong>${esc(field.label)}</strong>
    <textarea class="rule-json" ${attrs} spellcheck="false" aria-label="${esc(field.label)}"${invalid}
      placeholder='{ "kind": "path", "path": "field_id" }'>${esc(text)}</textarea>
    <p class="rule-hint">${description}${esc(builderText("inspector.expressionHint", undefined, context.words))}</p>
    ${error ? fieldErrorHtml(field.propertyPath, error) : ""}</div>`;
}

/**
 * What the CSS-classes editor adds under its text box: the advisory note for a class the
 * binding does not declare. The box stands alone otherwise: the binding's classes are offered
 * on the Style tab, not as chips under it, and its vocabulary informs the note.
 */
function cssClassExtrasHtml(context: FieldRenderContext): string {
  // A malformed class is a problem, drawn under the box like any other; this is the advisory note.
  return context.cssClassWarning ? `<p class="css-class-warning">${esc(context.cssClassWarning)}</p>` : "";
}

/**
 * The inline-options row: how many options the draft holds, and the button that opens the
 * options editor (see {@link optionsEditorHtml}). A named data source is noted, because it
 * takes precedence over the inline list and an author editing options that never show would
 * otherwise be left guessing why.
 */
function optionsFieldHtml(field: InspectorField, words?: BuilderTextOptions): string {
  const editor = field.optionsEditor;
  const count = editor?.options.length ?? 0;
  if (editor?.sourceId) {
    // A named source wins outright, so the inline list is dead data while one is
    // set: nothing renders it, and a failing source never falls back to it. The editor is
    // not offered — a control with no effect is one an author learns to distrust — but the
    // saved list is kept and named, so clearing the source brings it straight back.
    const note = count === 0 ? builderText("inspector.sourceNote", undefined, words) : builderPlural("inspector.sourceNoteKept", count, undefined, words);
    return `<div class="property-row options-row"><strong>${esc(field.label)}</strong>
    <span class="options-summary" data-options-source="${esc(editor.sourceId)}"><span data-options-count>${htmlWith((slots) => builderText("inspector.fromSource", slots, words), { source: `<code>${esc(editor.sourceId)}</code>` })}</span></span></div>
    <p class="options-note">${esc(note)}</p>`;
  }
  const summary = count === 0 ? builderText("inspector.optionsCount.none", undefined, words) : builderPlural("inspector.optionsCount", count, undefined, words);
  return `<div class="property-row options-row"><strong>${esc(field.label)}</strong>
    <span class="options-summary"><span data-options-count>${esc(summary)}</span>
      <button type="button" class="btn" data-options-edit="${esc(field.propertyPath)}">${esc(builderText("inspector.editOptions", undefined, words))}</button></span></div>`;
}

/**
 * The validation-messages row: how many codes the draft words, and the button that
 * opens the same table editor the options use (see {@link optionsEditorHtml}).
 */
function messagesFieldHtml(field: InspectorField, words?: BuilderTextOptions): string {
  const count = field.messagesEditor?.entries.length ?? 0;
  const summary = count === 0 ? builderText("inspector.messagesCount.none", undefined, words) : builderPlural("inspector.messagesCount", count, undefined, words);
  return `<div class="property-row options-row"><strong>${esc(field.label)}</strong>
    <span class="options-summary"><span data-messages-count>${esc(summary)}</span>
      <button type="button" class="btn" data-messages-edit="${esc(field.propertyPath)}">${esc(builderText("inspector.editMessages", undefined, words))}</button></span></div>${
        field.description ? `<p class="options-note">${esc(field.description)}</p>` : ""
      }`;
}

/** The ready-made value an envelope is, if it is one: the same storage and reference. */
export function assetChoiceOf(value: unknown, choices: readonly InspectorAssetChoice[]): InspectorAssetChoice | undefined {
  if (!isFileAttachment(value)) {
    return undefined;
  }
  const key = JSON.stringify([value.storage, (value as { ref?: unknown }).ref ?? null]);
  return choices.find((choice) => JSON.stringify([choice.source.storage, choice.source.ref ?? null]) === key);
}

/** The select's "upload" and "none" entries; a value that is neither a choice nor absent shows as its own, disabled entry. */
export const FILE_CHOICE_NONE = "";
export const FILE_CHOICE_UPLOAD = "__upload";
export const FILE_CHOICE_CUSTOM = "__custom";

/**
 * The file row: what is set — a ready-made value by its label, an inline file by name and
 * size, or one a host store serves — the way to change it, and, when something is set, a
 * Remove button. With ready-made values (`assetChoices`) the way is a select, grouped as the
 * choices are, whose last entry opens the hidden `<input type="file">`; without them, a
 * Choose… button opens it. The pick is handled by the panel (`applyFileEdit`), which reads the
 * file into the attachment envelope and refuses one that is not what the field accepts.
 */
function fileFieldHtml(field: InspectorField, context: FieldRenderContext): string {
  const words = context.words;
  const value = field.value;
  const choices = field.assetChoices ?? [];
  const chosen = assetChoiceOf(value, choices);
  const summary = chosen
    ? `${chosen.label}${chosen.group ? ` · ${chosen.group.toLowerCase()}` : ""}`
    : isBase64FileAttachment(value)
      ? builderText("inspector.file.inline", { name: value.name, size: formatFileSize(value.size) }, words)
      : isFileAttachment(value)
        ? builderText("inspector.file.host", { name: value.name, storage: value.storage }, words)
        : builderText("inspector.file.none", undefined, words);
  const attrs = `data-prop="${esc(field.propertyPath)}" data-control="file"`;
  const accept = field.accept ? ` accept="${esc(field.accept)}"` : "";
  const error = context.fileErrors.get(field.propertyPath);
  let control: string;
  if (choices.length > 0) {
    const groups = new Map<string | undefined, InspectorAssetChoice[]>();
    for (const choice of choices) {
      groups.set(choice.group, [...(groups.get(choice.group) ?? []), choice]);
    }
    const selected = chosen ? chosen.id : isFileAttachment(value) ? FILE_CHOICE_CUSTOM : FILE_CHOICE_NONE;
    const option = (id: string, label: string, extra = ""): string => `<option value="${esc(id)}"${id === selected ? " selected" : ""}${extra}>${esc(label)}</option>`;
    const grouped = [...groups.entries()]
      .map(([group, entries]) => {
        const options = entries.map((choice) => option(choice.id, choice.label)).join("");
        return group ? `<optgroup label="${esc(group)}">${options}</optgroup>` : options;
      })
      .join("");
    control = `<select data-file-choice="${esc(field.propertyPath)}" aria-label="${esc(field.label)}">${option(FILE_CHOICE_NONE, builderText("inspector.file.none", undefined, words))}${grouped}${
      selected === FILE_CHOICE_CUSTOM ? option(FILE_CHOICE_CUSTOM, summary, " disabled") : ""
    }${option(FILE_CHOICE_UPLOAD, builderText("inspector.file.upload", undefined, words))}</select>`;
  } else {
    control = `<button type="button" class="btn" data-file-pick="${esc(field.propertyPath)}">${esc(builderText("inspector.file.choose", undefined, words))}</button>`;
  }
  return `<div class="property-row options-row" data-file-row="${esc(field.propertyPath)}"><strong>${esc(field.label)}</strong>
    <span class="options-summary"><span data-file-summary>${esc(summary)}</span>
      ${control}${isFileAttachment(value) ? `<button type="button" class="btn" data-file-clear="${esc(field.propertyPath)}">${esc(builderText("common.remove", undefined, words))}</button>` : ""}</span>
    <input ${attrs} type="file"${accept} hidden aria-label="${esc(field.label)}" /></div>${
      field.description ? `<p class="options-note">${esc(field.description)}</p>` : ""
    }${error ? `<p class="rule-error" data-file-error="${esc(field.propertyPath)}">${esc(error)}</p>` : ""}`;
}

/**
 * The value-map row: a select per answer, set to "Same value" until the author picks
 * what is written to the PDF for it, and a button that pairs the answers with the targets by
 * order. A stored target the list lacks (a layout written for another PDF) keeps its own option,
 * marked, rather than vanish and be rewritten by the next edit. The panel writes the whole object.
 */
function valueMapFieldHtml(field: InspectorField, context: FieldRenderContext): string {
  const map = field.valueMap;
  if (!map) {
    return "";
  }
  const id = propertyDomId(field.propertyPath);
  const notes = context.notes.get(field.propertyPath) ?? [];
  const problem = context.problems.get(field.propertyPath);
  const noteIds = notes.map((_, index) => noteDomId(field.propertyPath, index));
  const describedBy = [field.description ? `${id}-help` : undefined, problem !== undefined ? problemDomId(field.propertyPath) : undefined, ...noteIds].filter(Boolean).join(" ");
  const rows = map.rows
    .map((row, index) => {
      const known = row.target === "" || map.targets.some((target) => target.value === row.target);
      const options = [
        `<option value=""${row.target === "" ? " selected" : ""}>${esc(map.sameLabel)}</option>`,
        ...(known ? [] : [`<option value="${esc(row.target)}" selected>${esc(row.target)}</option>`]),
        ...map.targets.map((target) => `<option value="${esc(target.value)}"${target.value === row.target ? " selected" : ""}>${esc(target.label)}</option>`)
      ].join("");
      const shown = row.label !== row.value ? `${esc(row.label)} <code>${esc(row.value)}</code>` : `<code>${esc(row.value)}</code>`;
      return `<li><label for="${id}-${index}">${shown}</label><select id="${id}-${index}" data-value-map-row="${esc(row.value)}" data-value-map-prop="${esc(field.propertyPath)}">${options}</select></li>`;
    })
    .join("");
  return `<div class="property-row options-row value-map" role="group" aria-labelledby="${id}-label"${describedBy ? ` aria-describedby="${describedBy}"` : ""} data-value-map="${esc(field.propertyPath)}">
    <strong id="${id}-label">${esc(field.label)}</strong>
    ${field.description ? `<p class="options-note" id="${id}-help">${esc(field.description)}</p>` : ""}
    <ul class="value-map-rows">${rows}</ul>
    <span class="options-summary">${
      map.rows.length > 0 ? `<button type="button" class="btn" data-value-map-order="${esc(field.propertyPath)}"${map.byOrderHint ? ` title="${esc(map.byOrderHint)}"` : ""}>${esc(map.byOrderLabel)}</button>` : ""
    }${
      map.stale.length > 0
        ? `<button type="button" class="btn" data-value-map-stale="${esc(field.propertyPath)}"${map.removeStaleHint ? ` title="${esc(map.removeStaleHint)}"` : ""}>${esc(map.removeStaleLabel)}</button>`
        : ""
    }</span>
    ${problem !== undefined ? fieldErrorHtml(field.propertyPath, problem) : ""}
    ${fieldNotesHtml(field.propertyPath, notes)}
  </div>`;
}

/**
 * A read-only list the tree's owner supplies (a `custom` control: a Check answers step's "Answers
 * listed"): a line for each entry with no value (the count, or what an empty list says), then a
 * list under each group's heading, in the order given. It carries no `data-prop`, so nothing in
 * it is read back as an edit.
 */
function listingFieldHtml(field: InspectorField): string {
  const groups: Array<{ heading: string | undefined; items: string[] }> = [];
  const lines: string[] = [];
  for (const choice of field.choices) {
    if (choice.value === "") {
      lines.push(`<p class="property-listing-line">${esc(choice.label)}</p>`);
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.heading === choice.group) {
      last.items.push(choice.label);
    } else {
      groups.push({ heading: choice.group, items: [choice.label] });
    }
  }
  const lists = groups
    .map(
      (group) =>
        `<li class="property-listing-group">${group.heading !== undefined ? `<span class="property-listing-heading">${esc(group.heading)}</span>` : ""}<ul>${group.items
          .map((item) => `<li>${esc(item)}</li>`)
          .join("")}</ul></li>`
    )
    .join("");
  const id = propertyDomId(field.propertyPath);
  return `<div class="property-row property-listing" role="group" aria-labelledby="${id}-label" data-listing="${esc(field.propertyPath)}">
    <strong id="${id}-label">${esc(field.label)}</strong>
    ${field.description ? `<p class="options-note">${esc(field.description)}</p>` : ""}
    ${lines.join("")}
    ${lists ? `<ul class="property-listing-groups">${lists}</ul>` : ""}
  </div>`;
}

function inspectorFieldHtml(field: InspectorField, context: FieldRenderContext): string {
  if (context.managed?.has(field.propertyPath)) {
    return `<div class="field-row" data-managed-setting="${esc(field.propertyPath)}"><span class="field-label">${esc(field.label)}</span><p class="field-note" data-severity="info">${esc(builderText("inspector.managedBySite", undefined, context.words))}</p></div>`;
  }
  if (field.control === "value-map") {
    return valueMapFieldHtml(field, context);
  }
  if (field.control === "custom") {
    return listingFieldHtml(field);
  }
  if (field.control === "localized-text") {
    return localizedTextFieldHtml(field, context);
  }
  if (field.control === "options") {
    return optionsFieldHtml(field, context.words);
  }
  if (field.control === "messages") {
    return messagesFieldHtml(field, context.words);
  }
  if (field.control === "chrome") {
    return chromeFieldHtml(field, context.words);
  }
  if (field.control === "file") {
    return fileFieldHtml(field, context);
  }
  if (field.control === "formula") {
    return formulaFieldHtml(field, context);
  }
  const attrs = `data-prop="${esc(field.propertyPath)}" data-control="${field.control}"`;
  if (field.control === "expression") {
    return expressionFieldHtml(field, attrs, context);
  }
  const problem = context.problems.get(field.propertyPath);
  const notes = context.notes.get(field.propertyPath);
  if (field.control === "checkbox") {
    return labeledRowHtml(
      field,
      context.openHelp,
      (extra) => `<input ${attrs}${extra} type="checkbox" ${field.value === true ? "checked" : ""} />`,
      problem,
      notes,
      context.words
    );
  }
  if (field.control === "select") {
    const current = field.value === undefined ? "" : String(field.value);
    // An unrecognized stored value (e.g. authored by a newer builder) would otherwise vanish
    // from the picker and be silently rewritten on the next edit — keep it as an option.
    const hidden = context.hiddenChoices?.get(field.propertyPath);
    const offered = hidden === undefined ? field.choices : field.choices.filter((choice) => choice.value !== hidden);
    const known = offered.some((choice) => choice.value === current);
    const options = ([
      ...(current !== "" && !known ? [{ value: current, label: builderText("inspector.unknownChoice", { value: current }, context.words) }] : []),
      ...offered
    ] as InspectorChoice[])
      .map(
        (choice) =>
          `<option value="${esc(choice.value)}"${choice.value === current ? " selected" : ""}${choice.disabled === true ? " disabled" : ""}>${esc(choice.label)}</option>`
      )
      .join("");
    return labeledRowHtml(field, context.openHelp, (extra) => `<select ${attrs}${extra}>${options}</select>`, problem, notes, context.words);
  }
  const type = field.control === "number" ? "number" : "text";
  const bounds =
    field.control === "number"
      ? (["min", "max", "step"] as const)
          .filter((name) => field[name] !== undefined)
          .map((name) => ` ${name}="${field[name]}"`)
          .join("")
      : "";
  const placeholder = field.placeholder !== undefined ? ` placeholder="${esc(field.placeholder)}"` : "";
  const listId = field.suggestions && field.suggestions.length > 0 ? `${propertyDomId(field.propertyPath)}-list` : undefined;
  const list = listId !== undefined ? ` list="${listId}"` : "";
  const datalist =
    listId !== undefined
      ? `<datalist id="${listId}">${field.suggestions!.map((choice) => `<option value="${esc(choice.value)}">${esc(choice.label)}</option>`).join("")}</datalist>`
      : "";
  const row = labeledRowHtml(
    field,
    context.openHelp,
    (extra) =>
      `<input ${attrs}${extra} type="${type}"${bounds}${placeholder}${list} value="${esc(field.value === undefined ? "" : String(field.value))}" />${datalist}`,
    problem,
    notes,
    context.words
  );
  if (field.propertyPath === "cssClass" && field.control === "text") {
    return `${row}${cssClassExtrasHtml(context)}`;
  }
  return row;
}

// --- rules tab ------------------------------------------------------------

/** One piece of a rule's "Reads as" line: a field chip, a value pill, or plain words. */
export interface RuleReadsToken {
  kind: "field" | "value" | "word";
  text: string;
}

/** What the tab draws for one rule beyond its editor state: the panel's view of it. */
export interface RuleView extends RuleEditorState {
  /** Where the rule may run and how the control draws; absent: as its descriptor says. */
  runControl?: RuleRunControl | undefined;
  /** Advice under the box that holds nothing back: an unknown field with its nearest name. */
  warnings?: readonly string[] | undefined;
  /** The rule in words, labels and option names in place of ids and values. */
  reads?: readonly RuleReadsToken[] | undefined;
  /** Formulas to try when the box is empty, as the editor would spell them. */
  examples?: readonly string[] | undefined;
}

const RULE_MODE_LABELS: ReadonlyArray<{ value: RuleEditorMode; key: "rules.off" | "rules.formula" }> = [
  { value: "off", key: "rules.off" },
  { value: "formula", key: "rules.formula" }
];

const RUN_SCOPES = ["both", "browser", "server", "server-secret"] as const;

function runLabelKey(run: string): "run.both" | "run.browser" | "run.server" | "run.secret" {
  return run === "browser" ? "run.browser" : run === "server" ? "run.server" : run === "server-secret" ? "run.secret" : "run.both";
}

/** The Runs control: a select-looking button opening the four scopes, each with its one-line consequence. */
function runControlHtml(state: RuleView, words: BuilderTextOptions | undefined): string {
  const control = state.runControl ?? ruleRunControl(state.descriptor);
  if (control === "none") {
    return "";
  }
  const key = state.key;
  if (control === "browser") {
    return `<span class="rule-run-fixed" data-rule-run-fixed="${esc(key)}" title="${esc(builderText("run.fixedBrowser.hint", undefined, words))}">${esc(
      builderText("run.fixedBrowser", undefined, words)
    )}</span>`;
  }
  const options = RUN_SCOPES.map((run) => {
    const label = runLabelKey(run);
    return `<button type="button" class="rule-run-option" role="menuitemradio" aria-checked="${state.run === run ? "true" : "false"}"
        data-rule="${esc(key)}" data-rule-run="${run}"><b>${esc(builderText(label, undefined, words))}</b><span>${esc(builderText(`${label}.hint`, undefined, words))}</span></button>`;
  }).join("");
  // The summary's name is its visible "Runs: on the browser" (WCAG 2.5.3, Label in Name): an
  // aria-label of just "Runs" would drop the value a screen reader user needs.
  return `<details class="rule-run" data-rule-run-menu="${esc(key)}">
      <summary>${esc(builderText("rules.runsValue", { scope: builderText(runLabelKey(state.run), undefined, words) }, words))}</summary>
      <div class="rule-run-menu" role="menu">${options}</div>
    </details>`;
}

function readsHtml(tokens: readonly RuleReadsToken[], words: BuilderTextOptions | undefined): string {
  const parts = tokens
    .map((token) =>
      token.kind === "field"
        ? `<span class="ref-chip">${esc(token.text)}</span>`
        : token.kind === "value"
          ? `<span class="ref-chip val">${esc(token.text)}</span>`
          : `<span>${esc(token.text)}</span>`
    )
    .join("");
  return `<p class="rule-reads" data-rule-reads><span class="rule-reads-label">${esc(builderText("editor.readsAs", undefined, words))}</span>${parts}</p>`;
}

/** What one rule's markup is drawn with beyond its state (see {@link ruleFeedbackHtml}). */
export interface RuleHtmlOptions {
  /** The problem under the box, and in the summary above Save when it is the author's own. */
  error: string | undefined;
  notes?: readonly InspectorNoteView[] | undefined;
  openInLogic: boolean;
  editorFailed: boolean;
  words: BuilderTextOptions | undefined;
}

/**
 * How a rule's box describes itself: invalid while its text does not parse, and described by
 * its problem line, else by the notes under it (the ids `ruleFeedbackHtml` draws). A panel
 * refreshing a box in place while the author types sets these the way a paint would.
 */
export function ruleBoxDescription(key: string, options: Pick<RuleHtmlOptions, "error" | "notes">): { invalid: boolean; describedBy: string | undefined } {
  // The notes under the rule are named by its box, as a property box names its own
  // (`labeledRowHtml`): a screen reader moving by Tab hears them with the formula. A box
  // that does not parse names its problem instead.
  const noteIds = options.error ? [] : (options.notes ?? []).map((_, index) => noteDomId(`rules:${key}`, index));
  const described = options.error ? problemDomId(`rules:${key}`) : noteIds.join(" ");
  return { invalid: options.error !== undefined && options.error !== "", describedBy: described === "" ? undefined : described };
}

/**
 * Everything a rule draws under its box, as one block the panel can refresh in place while
 * the author types (the box itself, and the editor over it, are left alone): the editor's
 * failed-load line, the "Try one" chips over an empty box, the problem line, the unknown-field
 * warnings, the secret note, "Reads as", the Open in Logic link, and the tree owner's notes.
 * Empty but for the notes when the rule is off.
 */
export function ruleFeedbackHtml(state: RuleView, options: RuleHtmlOptions): string {
  const key = state.key;
  const words = options.words;
  const notes = options.error ? "" : fieldNotesHtml(`rules:${key}`, options.notes ?? []);
  if (state.mode !== "formula") {
    return notes;
  }
  const failed = options.editorFailed
    ? `<p class="rule-editor-failed" data-rule-editor-failed>${esc(builderText("editor.failed", undefined, words))}
          <button type="button" class="btn" data-rule="${esc(key)}" data-rule-editor-retry>${esc(builderText("editor.retry", undefined, words))}</button></p>`
    : "";
  const examples =
    state.text.trim() === "" && state.examples && state.examples.length > 0
      ? `<div class="rule-try"><span>${esc(builderText("editor.tryOne", undefined, words))}</span>${state.examples
          .map((example) => `<button type="button" class="try-chip" data-rule="${esc(key)}" data-rule-try="${esc(example)}">${esc(example)}</button>`)
          .join("")}</div>`
      : "";
  const warnings = (state.warnings ?? []).map((warning) => `<p class="rule-warning" data-rule-warning="${esc(key)}">${esc(warning)}</p>`).join("");
  const secret =
    state.run === "server-secret"
      ? `<p class="note" data-rule-secret-note>${esc(builderText("run.secret.note", undefined, words))}</p>`
      : "";
  const reads = state.reads && state.reads.length > 0 ? readsHtml(state.reads, words) : "";
  const links = options.openInLogic
    ? `<p class="rule-links"><button type="button" class="link-btn" data-open-workspace="logic">${esc(builderText("rules.openInLogic", undefined, words))}</button></p>`
    : "";
  return `${failed}${examples}
      ${options.error ? `<p class="rule-error" id="${problemDomId(`rules:${key}`)}" data-problem="rules:${esc(key)}">${esc(options.error)}</p>` : ""}
      ${warnings}${secret}${reads}${links}${notes}`;
}

/** The textarea a rule's formula is typed in (the editor mounts over it); also the box of a `formula` control. */
export function ruleFormulaBoxHtml(state: RuleView, options: Pick<RuleHtmlOptions, "error" | "notes" | "words">, label: string): string {
  const key = state.key;
  const description = ruleBoxDescription(key, options);
  const multiline = state.descriptor.kind === "value";
  return `<div class="rule-formula" data-rule-formula-host="${esc(key)}"><textarea class="rule-formula-box" data-rule="${esc(key)}" data-rule-formula rows="${multiline ? 3 : 1}" spellcheck="false" autocomplete="off" autocapitalize="off"
        aria-label="${esc(label)}"${multiline ? ' aria-multiline="true" data-rule-multiline' : ""}${description.invalid ? ' aria-invalid="true"' : ""}${
          description.describedBy ? ` aria-describedby="${description.describedBy}"` : ""
        } placeholder="${esc(builderText("editor.placeholder", undefined, options.words))}">${esc(state.text)}</textarea></div>`;
}

function ruleHtml(state: RuleView, options: RuleHtmlOptions & { open: boolean }): string {
  const key = state.key;
  const words = options.words;
  const modes = RULE_MODE_LABELS.map(
    (mode) =>
      `<button type="button" class="seg-btn" aria-pressed="${state.mode === mode.value ? "true" : "false"}"
        data-rule="${esc(key)}" data-rule-mode="${mode.value}">${esc(builderText(mode.key, undefined, words))}</button>`
  ).join("");

  const box = state.mode === "formula" ? ruleFormulaBoxHtml(state, options, state.descriptor.label) : "";

  return `<details class="rule" data-rule-section="${esc(key)}"${options.open ? " open" : ""}>
      <summary>${esc(state.descriptor.label)}
        <span class="rule-state${state.mode === "off" ? "" : " on"}">${esc(builderText(state.mode === "off" ? "rules.stateOff" : "rules.stateOn", undefined, words))}</span>
      </summary>
      <div class="rule-body">
        <p class="rule-desc">${esc(state.descriptor.description)}</p>
        <div class="rule-head">
          <div class="seg" role="group" aria-label="${esc(state.descriptor.label)}">${modes}</div>
          ${state.mode === "formula" ? runControlHtml(state, words) : ""}
        </div>
        ${box}
        <div class="rule-feedback" data-rule-feedback="${esc(key)}">${ruleFeedbackHtml(state, options)}</div>
      </div>
    </details>`;
}

export interface RulesTabOptions {
  /** Editor state per rule, in the order {@link RULE_DESCRIPTORS} declares, or a builder mode's descriptors do. */
  states: RuleView[];
  /** Rule sections the author has expanded, so they survive the panel's re-render. */
  openRules: ReadonlySet<string>;
  /** Per-rule parse problems, keyed by rule: under the box and in the summary above Save. */
  errors: ReadonlyMap<string, string>;
  /** The tree owner's advisory notes about a rule (a `BuilderNote` targeting `rules:<key>`), keyed by rule. */
  notes?: ReadonlyMap<string, readonly InspectorNoteView[]> | undefined;
  /**
   * The line at the top of the tab, from a builder mode whose conditions read something other
   * than the form's rules do (`BuilderModeRules.note`). Absent: the form's own line.
   */
  note?: string | undefined;
  /** Whether each rule offers "Open in Logic": the form's own rules, which the Logic workspace lists. */
  openInLogic?: boolean | undefined;
  /** The formula editor's chunk failed to load: the plain box stays, with a Retry. */
  editorFailed?: boolean | undefined;
  /** The builder's locale and catalog for the tab's words. */
  words?: BuilderTextOptions | undefined;
  /** A step's Go to rules, listed in the rules' markup in place of descriptors, each with Open in Logic. */
  ways?: BuilderModeWays | undefined;
}

/** A step's Go to rules, as {@link ruleHtml} draws a rule: its words, "Reads as" and Open in Logic; New rule last. */
function waysHtml(ways: BuilderModeWays, words: BuilderTextOptions | undefined): string {
  const link = (way: string, label: string): string => `<p class="rule-links"><button type="button" class="link-btn" data-rule-way="${way}">${esc(label)}</button></p>`;
  return `<p class="rules-note">${esc(ways.note)}</p>${ways.rows
    .map(
      (row, index) => `<details class="rule" data-rule-section="way:${index}" open>
      <summary>${esc(row.title)}</summary>
      <div class="rule-body">${row.reads ? `<p class="rule-reads"><span class="rule-reads-label">${esc(builderText("editor.readsAs", undefined, words))}</span><span>${esc(row.reads)}</span></p>` : ""}${
        row.open ? link(String(index), builderText("rules.openInLogic", undefined, words)) : ""
      }</div>
    </details>`
    )
    .join("")}${ways.newRule ? link("new", ways.newRule.label) : ""}`;
}

/**
 * The Logic tab: every rule the engine evaluates, each off or written as a formula. See
 * `property-editor/rules-model.ts` for what the box holds and what the draft gets.
 */
export function rulesTabHtml(options: RulesTabOptions): string {
  if (options.ways) {
    return waysHtml(options.ways, options.words);
  }
  const note =
    options.note !== undefined
      ? esc(options.note)
      : htmlWith((slots) => builderText("rules.note", slots, options.words), {
          row: "<code>row.</code>",
          ancestor: "<code>ancestor.</code>",
          host: "<code>host.</code>"
        });
  return `<p class="rules-note">${note}</p>
    ${options.states
      .map((state) =>
        ruleHtml(state, {
          open: options.openRules.has(state.key) || state.mode !== "off",
          error: options.errors.get(state.key) ?? state.problem,
          notes: options.notes?.get(state.key),
          openInLogic: options.openInLogic === true,
          editorFailed: options.editorFailed === true,
          words: options.words
        })
      )
      .join("")}`;
}

/** Selectable ids for a rule's field box: every component on the form except the one edited. */
export function ruleFieldOptions(
  view: NestedTreeNodeView,
  excludeId: string | undefined
): InspectorChoice[] {
  const out: InspectorChoice[] = [];
  const walk = (node: NestedTreeNodeView): void => {
    if (node.id !== excludeId && node.depth > 0) {
      out.push({ value: node.id, label: `${node.label} (${node.type})` });
    }
    for (const slot of node.slots) {
      for (const child of slot.children) {
        walk(child);
      }
    }
  };
  walk(view);
  return out;
}

export type InspectorTab = "properties" | "style" | "rules" | "tree" | "json";

/**
 * The sections the inspector's Style tab holds: how a component looks —
 * its presentation and its PDF appearance — apart from what it is, says and stores, which the
 * Field tab keeps. Named options only; no class picker is added. The "On paper" group is not
 * here: whether and how a component prints is a choice about the component, so it closes the
 * Field tab, after everything about the component on screen.
 */
export const STYLE_SECTION_IDS: ReadonlySet<string> = new Set(["presentation", "pdf"]);

/** Whether a component's model has anything for the Style tab. */
export function hasStyleSections(model: InspectorModel | undefined): boolean {
  return model !== undefined && model.mode !== "none" && model.sections.some((section) => STYLE_SECTION_IDS.has(section.id));
}

/** What the form-level Identity section renders from; see {@link identitySectionHtml}. */
export interface IdentityPanelOptions {
  /** The identity being edited — the form root draft's view of the definition's id and versions. */
  value: FormIdentity;
  /** What is wrong with a box, in words, drawn under it (`BuilderController.identityProblems`). */
  problems?: { id?: string; version?: string };
}

/**
 * The form-level Identity section: the definition's `id`, `version` and `schemaVersion` —
 * how a submission envelope, a saved draft and the host's storage name this form. Not any
 * component's configuration: the properties panel routes the boxes through
 * `BuilderController.setDraftIdentity`, so Save / Cancel govern them like every other
 * form-root property. A box left blank keeps its current value on Save.
 */
export function identitySectionHtml(options: IdentityPanelOptions, open: boolean, words?: BuilderTextOptions): string {
  const box = (field: keyof FormIdentity, label: string, example: string): string => {
    const problem = field === "id" || field === "version" ? options.problems?.[field] : undefined;
    const target = `identity.${field}`;
    return `<label class="property-row"><strong>${esc(label)}</strong>
        <input type="text" data-identity-field="${field}" value="${esc(options.value[field])}"
          placeholder="${esc(builderText("identity.eg", { example }, words))}" spellcheck="false" autocomplete="off"${
            problem !== undefined ? ` aria-invalid="true" aria-describedby="${problemDomId(target)}"` : ""
          } /></label>${problem !== undefined ? fieldErrorHtml(target, problem) : ""}`;
  };
  return `<details class="inspector-section" data-inspector-section="identity"${open ? " open" : ""}>
      <summary>${esc(builderText("identity.title", undefined, words))}</summary>
      <div class="inspector-section-body">
        <p class="locale-hint">${esc(builderText("identity.hint", undefined, words))}</p>
        ${box("id", builderText("identity.formId", undefined, words), "customer-intake")}
        ${box("version", builderText("identity.version", undefined, words), "1.0.0")}
        ${box("schemaVersion", builderText("identity.schemaVersion", undefined, words), "1")}
      </div>
    </details>`;
}

/** The inspector's editable JSON; see {@link PropertiesPanelOptions.jsonEdit}. */
export interface JsonEditView {
  /** The text the box holds: the draft's JSON, or what the author typed that does not apply yet. */
  text: string;
  /** What the box is, for assistive technology. */
  label: string;
  /** Why the text does not apply, with the line and column when there is one to point at. */
  problem?: { message: string; line?: number | undefined; column?: number | undefined } | undefined;
  /** Whether the component has children, which the JSON leaves to the canvas (a line above the box says so). */
  hasChildren?: boolean;
}

export interface PropertiesPanelOptions {
  tab: InspectorTab;
  /**
   * The coverage the pointer line under the component's texts speaks of:
   * one entry per language besides the default. Absent or empty draws no line, which is what a
   * single-language form, a component with no text, and the `translations` feature
   * turned off all look like.
   */
  translationCoverage?: readonly TranslationCoverageEntry[];
  /** Whether the pointer line offers Open in Languages (the shell has the workspace); default true. */
  openInLanguages?: boolean;
  /**
   * Whether the panel offers the Style tab: the Field tab ("properties") then leaves out the
   * {@link STYLE_SECTION_IDS} sections, which the Style tab shows. Off, the Field tab has them all.
   */
  splitStyle?: boolean;
  /** The component tree, rendered as the selectable list on the Tree tab. */
  treeView: NestedTreeNodeView;
  /** Component ids the canvas preview is currently hiding. */
  hiddenIds: ReadonlySet<string>;
  /**
   * What holds the component's Save back (the controller's `problemsOf`, plus what the panel
   * itself could not read, such as an expression that does not parse), each drawn under its
   * own box. When given, the three single-problem options below are ignored.
   */
  problems?: ReadonlyArray<{ target: string; message: string }>;
  /** The pending id's problem alone; see {@link problems}. */
  idError?: string | undefined;
  /** When false the ID is shown read-only (e.g. the form root). */
  idEditable: boolean;
  /**
   * How the tree's owner wants the ID row drawn (`BuilderController.idRow`): hidden,
   * read-only with its own text, or editable where {@link idEditable} allows; its `help`
   * replaces the row's "?" text. Absent: as {@link idEditable} says, with the builder's help.
   */
  idRow?: BuilderIdRow | undefined;
  isRoot: boolean;
  /** Property paths whose "?" description the author expanded; see {@link labeledRowHtml}. */
  openHelp?: ReadonlySet<string>;
  /** Property sections the author collapsed. Sections not named here render open. */
  collapsedSections?: ReadonlySet<string>;
  /**
   * Property sections the author opened that start folded (`InspectorSection.folded`).
   * A folded section not named here renders folded.
   */
  openedSections?: ReadonlySet<string>;
  /**
   * The tree owner's advisory notes about the component (`BuilderController.notesOf`):
   * each under the box its `target` names, the rest above the sections. Never blocking.
   */
  notes?: ReadonlyArray<InspectorNoteView & { target?: string | undefined }>;
  /**
   * Lines that only inform about the component (`inspectorHints`: a rule calculates
   * its answer), drawn once above the sections of the Field tab. Never blocking, never counted.
   */
  hints?: readonly string[];
  /**
   * Which adapter draws the component and whose it is (`BuilderController.drawnByLine`), one
   * line of the same kind as the hints, after them. Absent before the canvas has drawn it.
   */
  drawnBy?: string | undefined;
  /**
   * The binding's classes that apply to the component, for the Style tab (`BuilderController.styleOptions`),
   * and the classes the draft carries now; each option is a toggle of its class, and the options of a
   * group are one choice among them with a way back to none.
   */
  styleOptions?: { choices: ReadonlyArray<{ name: string; label: string; description?: string | undefined; group?: string | undefined; groupLabel?: string | undefined }>; active: readonly string[] };
  /** The cssClass value's problem alone; see {@link problems}. */
  cssClassError?: string | undefined;
  /** Advisory note about cssClass entries the binding does not declare. */
  cssClassWarning?: string | undefined;
  /** The data key's problem alone; see {@link problems}. */
  dataKeyError?: string | undefined;
  /**
   * Where the selection's answer is stored (`billing.street`, `items[].sku`), shown as a line
   * under its type when it is not simply the id; unset for a component with no place of its own.
   */
  dataPath?: string | undefined;
  /**
   * Whether the tree is the form's own rather than another mode's, such as a PDF layout
   *. Only the form's components store answers, so only they get the ID help's
   * sentence about where. Default true.
   */
  formTree?: boolean;
  /** Text of `expression` controls as typed, by property path; see {@link expressionFieldHtml}. */
  expressionDrafts?: ReadonlyMap<string, string>;
  /** Parse failures of `expression` controls, by property path, shown under the box. */
  expressionErrors?: ReadonlyMap<string, string>;
  /** Why a `file` control refused the last pick, by property path; see {@link fileFieldHtml}. */
  fileErrors?: ReadonlyMap<string, string>;
  /** The formula boxes of `formula` controls, by property path; see {@link FormulaFieldView}. */
  formulas?: ReadonlyMap<string, FormulaFieldView>;
  /** The builder's locale and catalog for the panel's own words; the Rules tab's `words` when absent. */
  words?: BuilderTextOptions | undefined;
  /** Everything the Rules tab needs. Omit and the tab renders as unavailable. */
  rules?: RulesTabOptions;
  /**
   * The JSON view as a box to edit: the text as the author has it, and why it does
   * not apply. Omit and the JSON tab shows the node read-only, children and all.
   */
  jsonEdit?: JsonEditView;
  /** Renders the form-level Identity section (form id, version, schema version); {@link isRoot} only. */
  identity?: IdentityPanelOptions;
  /**
   * Settings other builder modes add to the form's own, a section per mode after
   * the form's sections; {@link isRoot} only. See {@link modeSettingsSectionHtml}.
   */
  modeSettings?: ReadonlyArray<ModeSettingsGroupView>;
  /** The form's formula-error policy (Formulas section); {@link isRoot} on the form's own panel only. */
  formulaSettings?: FormulaSettingsView;
  /** The author's switch for assistants in the browser (Browser assistants section); {@link isRoot} on the form's own panel only, whatever the builder's features. */
  assistantsSettings?: AssistantsSettingsView;
  /**
   * Which optional parts of the inspector exist: a part the builder's `features`
   * list leaves out is absent here, not merely dimmed. Every key defaults to true. `formulas` is the
   * Form panel's Formulas section, `print` the component's "On paper" group, `pdfAction` the Button's
   * "Download as PDF" action and `webauthn` its passkey signature choice. A stored value the choice list no longer offers stays in the select as the
   * unrecognized value it is, so a round trip through the box rewrites nothing.
   */
  parts?: Partial<Record<InspectorPart, boolean>>;
  /**
   * Property paths the host manages (`managed-settings`): the box is not
   * drawn; its label and a one-line "managed by the site" note stand in its place.
   */
  managedSettings?: readonly string[];
}

/** The inspector parts {@link PropertiesPanelOptions.parts} can switch off. */
export type InspectorPart = "formulas" | "print" | "pdfAction" | "webauthn";

/** The button choices a part owns: component type, property path, and the value that part gates. */
const BUTTON_PART_CHOICES: ReadonlyArray<{ part: InspectorPart; path: string; value: string }> = [
  { part: "pdfAction", path: "action", value: "pdf" },
  { part: "webauthn", path: "signature", value: "webauthn" }
];

/** One mode's rows in the Form panel, as {@link modeSettingsSectionHtml} draws them. */
export interface ModeSettingsGroupView {
  /** The mode's id: the section's and the open button's key. */
  mode: string;
  title: string;
  rows: ReadonlyArray<{
    id: string;
    label: string;
    description?: string | undefined;
    choices: readonly InspectorChoice[];
    /** The value as the author sees it: drafted, else committed. */
    value: string;
    note?: string | undefined;
    open?: { label: string; document?: string | undefined } | undefined;
  }>;
  /** Rows that only say something, after the choices: a label, its words, the open button. */
  readOnlyRows?: ReadonlyArray<{
    id: string;
    label: string;
    note: string;
    open?: { label: string; document?: string | undefined } | undefined;
  }>;
}

/** The button under a mode's row that opens the mode (`data-root-setting-open`), on a document when it names one. */
function modeSettingOpenHtml(mode: string, open: { label: string; document?: string | undefined } | undefined): string {
  return open
    ? `<button type="button" class="btn" data-root-setting-open="${esc(mode)}"${
        open.document !== undefined ? ` data-root-setting-document="${esc(open.document)}"` : ""
      }>${esc(open.label)}</button>`
    : "";
}

/**
 * A mode's settings in the Form panel: a section under the mode's heading, a
 * select per row (`data-root-setting` names the setting, drafted on the form root), its
 * description and note — both read with the select (`aria-describedby`), since what is at stake
 * belongs with the choice — and a button that opens the mode (`data-root-setting-open`). A
 * read-only row is its label over its words (`data-root-setting-readonly`), with no
 * control to draft. Nothing without rows.
 */
export function modeSettingsSectionHtml(group: ModeSettingsGroupView, open: boolean, words?: BuilderTextOptions): string {
  const readOnlyRows = group.readOnlyRows ?? [];
  if (group.rows.length === 0 && readOnlyRows.length === 0) {
    return "";
  }
  const said = readOnlyRows
    .map((row) => {
      // Read in order, label then words: there is no control for them to describe.
      return `<div class="property-row" data-root-setting-readonly="${esc(row.id)}"><strong>${esc(row.label)}</strong></div>
        <p class="options-note" data-root-setting-note="${esc(row.id)}">${esc(row.note)}</p>${modeSettingOpenHtml(group.mode, row.open)}`;
    })
    .join("");
  const rows = group.rows
    .map((row) => {
      const known = row.choices.some((choice) => choice.value === row.value);
      const options = [...(!known ? [{ value: row.value, label: builderText("inspector.unknownChoice", { value: row.value }, words) }] : []), ...row.choices]
        .map((choice) => `<option value="${esc(choice.value)}"${choice.value === row.value ? " selected" : ""}>${esc(choice.label)}</option>`)
        .join("");
      const open = modeSettingOpenHtml(group.mode, row.open);
      const base = `mode-setting-${row.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
      const descriptionId = row.description ? `${base}-desc` : undefined;
      const noteId = row.note ? `${base}-note` : undefined;
      const describedBy = [descriptionId, noteId].filter((id) => id !== undefined).join(" ");
      return `<label class="property-row"><strong>${esc(row.label)}</strong>
          <select data-root-setting="${esc(row.id)}"${describedBy ? ` aria-describedby="${describedBy}"` : ""}>${options}</select></label>${
            row.description ? `<p class="options-note" id="${descriptionId}">${esc(row.description)}</p>` : ""
          }${row.note ? `<p class="options-note" id="${noteId}" data-root-setting-note="${esc(row.id)}">${esc(row.note)}</p>` : ""}${open}`;
    })
    .join("");
  return `<details class="inspector-section" data-inspector-section="mode-${esc(group.mode)}" data-mode-settings="${esc(group.mode)}"${open ? " open" : ""}>
      <summary>${esc(group.title)}</summary>
      <div class="inspector-section-body">${rows}${said}</div>
    </details>`;
}

/** The controls drawn as a labelled row (see {@link labeledRowHtml}), which a note can sit under. */
const NOTED_CONTROLS: ReadonlyArray<InspectorField["control"]> = ["text", "number", "select", "checkbox", "localized-text", "formula", "value-map"];

/**
 * The inspector's JSON as a box to edit. The <textarea> is the text's source and
 * the box itself until the panel mounts the editor beside it (json-viewer.ts), and stays the
 * box if the editor's chunk never loads. A problem is said under it, the box
 * names it through `aria-describedby`, and the footer's line leads to it.
 */
function jsonEditHtml(view: JsonEditView, words?: BuilderTextOptions): string {
  const problemId = problemDomId("json");
  const where =
    view.problem?.line !== undefined && view.problem.column !== undefined
      ? builderText("inspector.jsonAt", { line: view.problem.line, column: view.problem.column }, words)
      : "";
  const note = view.hasChildren ? `<p class="json-note" data-json-note>${esc(builderText("inspector.childrenNote", undefined, words))}</p>` : "";
  // The newline after the tag is the one the parser drops, so a text that starts with one keeps it.
  return `${note}<textarea class="json-edit" data-json-view data-json-edit spellcheck="false" autocomplete="off" aria-label="${esc(view.label)}"${
    view.problem ? ` aria-invalid="true" aria-describedby="${problemId}"` : ""
  }>\n${esc(view.text)}</textarea>${
    view.problem ? `<p class="field-error json-error" id="${problemId}" data-problem="json">${esc(where + view.problem.message)}</p>` : ""
  }`;
}

export function propertiesPanelHtml(
  model: InspectorModel | undefined,
  selectedNode: ComponentNode | undefined,
  options: PropertiesPanelOptions
): string {
  const words = options.words ?? options.rules?.words;
  if (options.tab === "tree") {
    return treeTabHtml(options.treeView, {
      selectedId: selectedNode?.id,
      hiddenIds: options.hiddenIds,
      words
    });
  }
  if (options.tab === "json") {
    if (!selectedNode) {
      return `<p class="empty">${esc(builderText("inspector.selectJson", undefined, words))}</p>`;
    }
    if (options.jsonEdit) {
      return jsonEditHtml(options.jsonEdit, words);
    }
    // The selected node's own subtree, exactly as it is persisted — the properties tab shows
    // what the inspector knows how to edit, this shows everything the node actually carries
    // (`collection` included, which the inspector does not reach). The panel mounts a
    // read-only editor over this <pre> once the markup is in place (json-viewer.ts).
    return `<pre data-json-view>${esc(JSON.stringify(selectedNode, null, 2))}</pre>`;
  }
  if (options.tab === "rules") {
    if (!selectedNode || !options.rules) {
      return `<p class="empty">${esc(builderText("inspector.selectRules", undefined, words))}</p>`;
    }
    return rulesTabHtml(options.rules);
  }
  if (!selectedNode || !model) {
    return `<p class="empty">${esc(builderText("inspector.selectProperties", undefined, words))}</p>`;
  }
  const problems = new Map<string, string>(
    (
      options.problems ?? [
        ...(options.idError ? [{ target: "id", message: options.idError }] : []),
        ...(options.cssClassError ? [{ target: "cssClass", message: options.cssClassError }] : []),
        ...(options.dataKeyError ? [{ target: DATA_KEY_PROPERTY, message: options.dataKeyError }] : [])
      ]
    ).map((problem) => [problem.target, problem.message])
  );
  /*
   * The tree owner's notes: under the box each names, when this tab draws that box
   * as a labelled row; the rest — about the component as a whole, a rule, a box drawn some
   * other way — above the sections. A box whose value has a problem shows the problem alone.
   */
  const boxed = new Set(
    model.sections.flatMap((section) =>
      section.fields.filter((field) => NOTED_CONTROLS.includes(field.control)).map((field) => field.propertyPath)
    )
  );
  const notesByBox = new Map<string, InspectorNoteView[]>();
  const looseNotes: InspectorNoteView[] = [];
  for (const note of options.notes ?? []) {
    if (note.target !== undefined && problems.has(note.target)) {
      continue;
    }
    const view: InspectorNoteView = { message: note.message, ...(note.severity !== undefined ? { severity: note.severity } : {}) };
    if (note.target !== undefined && boxed.has(note.target)) {
      notesByBox.set(note.target, [...(notesByBox.get(note.target) ?? []), view]);
    } else {
      looseNotes.push(view);
    }
  }
  const notesBlock =
    looseNotes.length > 0 && model.mode !== "none"
      ? `<div class="inspector-notes" data-inspector-notes>${fieldNotesHtml("component", looseNotes)}</div>`
      : "";
  const hints = options.hints ?? [];
  const hintsBlock =
    (hints.length > 0 || options.drawnBy !== undefined) && model.mode !== "none"
      ? `<div class="inspector-notes" data-inspector-hints>${hints
          .map((hint) => `<p class="field-note" data-severity="info" data-inspector-hint>${esc(hint)}</p>`)
          .join("")}${options.drawnBy !== undefined ? `<p class="field-note" data-severity="info" data-inspector-drawn>${esc(options.drawnBy)}</p>` : ""}</div>`
      : "";
  const partOn = (part: InspectorPart): boolean => options.parts?.[part] !== false;
  const fieldContext: FieldRenderContext = {
    openHelp: options.openHelp ?? new Set<string>(),
    problems,
    cssClassWarning: options.cssClassWarning,
    notes: notesByBox,
    expressionDrafts: options.expressionDrafts ?? new Map<string, string>(),
    expressionErrors: options.expressionErrors ?? new Map<string, string>(),
    fileErrors: options.fileErrors ?? new Map<string, string>(),
    formulas: options.formulas ?? new Map<string, FormulaFieldView>(),
    hiddenChoices:
      selectedNode.type === "button"
        ? new Map(
            BUTTON_PART_CHOICES.filter((entry) => !partOn(entry.part)).map((entry) => [entry.path, entry.value] as const)
          )
        : new Map<string, string>(),
    managed: new Set(options.managedSettings ?? []),
    words
  };
  const collapsedSections = options.collapsedSections ?? new Set<string>();
  const openedSections = options.openedSections ?? new Set<string>();
  /*
   * Sections fold. The inspector model already groups fields into logical sections
   * (Content / Settings / Validation / …, see `inspector-model.ts`); rendering each as a
   * `<details>` lets the author put away what they are not editing. Open by default and
   * only `collapsedSections` closes one, so a section never starts hidden — unless the tree's
   * owner folds it (a journey's Wording), which then stays folded until the author
   * opens it (`openedSections`).
   */
  const sectionOpen = (section: InspectorSection): boolean =>
    section.folded === true ? openedSections.has(section.id) : !collapsedSections.has(section.id);
  const styleTab = options.tab === "style";
  // "On paper" is the Print workspace's part of the inspector: a list without `print` has no group.
  const shownSections = model.sections
    .filter((section) => section.id !== "print" || partOn("print"))
    .filter((section) => styleTab ? STYLE_SECTION_IDS.has(section.id) : !(options.splitStyle && STYLE_SECTION_IDS.has(section.id)));
  // The pointer to the Languages workspace sits under the texts: at the end of the last shown
  // section that holds a translatable string.
  const pointerSection = model.mode === "none" ? undefined : [...shownSections].reverse().find((section) => section.fields.some((field) => field.control === "localized-text"));
  const sections =
    model.mode === "none"
      ? `<p class="empty">${esc(builderText("inspector.noProperties", undefined, words))}</p>`
      : styleTab && shownSections.length === 0
        ? `<p class="empty">${esc(builderText("inspector.noStyle", undefined, words))}</p>`
        : shownSections
          .map(
            (section) => `<details class="inspector-section" data-inspector-section="${esc(
              section.id
            )}"${section.folded === true ? " data-folded" : ""}${sectionOpen(section) ? " open" : ""}>
              <summary>${esc(section.title ?? builderText("inspector.properties", undefined, words))}</summary>
              <div class="inspector-section-body">
              ${section.fields.map((field) => inspectorFieldHtml(field, fieldContext)).join("\n")}
              ${section === pointerSection ? translationPointerHtml(options.translationCoverage ?? [], words, options.openInLanguages !== false) : ""}
              </div>
            </details>`
          )
          .join("\n");
  const idProblem = problems.get("id");
  // The ID and Saved as rows are the panel's own, not fields of the model, but they explain
  // themselves like one: a "?" beside the name.
  const idLabel = builderText("inspector.id", undefined, words);
  const idHelp = identityHelpHtml("id", idLabel, options.idRow?.help ?? idHelpText(selectedNode, {
    isRoot: options.isRoot,
    formTree: options.formTree ?? true
  }, words), fieldContext.openHelp, words);
  // A tree whose ids are the builder's own bookkeeping (a journey's) may show a
  // name of its choosing read-only, or no row at all.
  const idMode = options.idRow?.mode === "hidden" ? "hidden" : options.idEditable && options.idRow?.mode !== "static" ? "edit" : "static";
  // The id's problem sits under the id box, where the author typed it, not after every section.
  const idRow =
    idMode === "hidden"
      ? ""
      : idMode === "edit"
        ? `<div class="property-row property-row--help"><span class="property-label"><label for="prop-id"><strong>${esc(idLabel)}</strong></label>
        ${idHelp.toggle}</span>
        <input id="prop-id" data-prop="id" type="text" value="${esc(selectedNode.id)}"${
          idProblem !== undefined ? ' aria-invalid="true"' : ""
        } aria-describedby="${idHelp.id}${idProblem !== undefined ? ` ${problemDomId("id")}` : ""}" />
        ${idHelp.text}
        ${idProblem !== undefined ? fieldErrorHtml("id", idProblem) : ""}</div>`
        : `<div class="property-row property-row--help"><span class="property-label"><strong>${esc(idLabel)}</strong>
        ${idHelp.toggle}</span><span class="property-static">${esc(options.idRow?.text ?? selectedNode.id)}</span>
        ${idHelp.text}</div>`;
  // "Saves to" always: where the answer lands, even when the path is the id itself.
  // A PDF layout's tree stores no answers, and the root is the whole record.
  const savedAsPath = options.dataPath !== undefined && !options.isRoot && (options.formTree ?? true) ? options.dataPath : undefined;
  const savedAs =
    savedAsPath !== undefined
      ? identityHelpHtml("savedAs", builderText("inspector.savesTo", undefined, words), savedAsHelpText(selectedNode, savedAsPath, words), fieldContext.openHelp, words)
      : undefined;
  if (styleTab) {
    return `${styleOptionsHtml(options.styleOptions, words)}${sections}`;
  }
  // Definition-level sections follow the component's own: the identity.
  const identitySection =
    options.isRoot && options.identity
      ? identitySectionHtml(options.identity, !collapsedSections.has("identity"), words)
      : "";
  // What the form does with a formula it cannot read (Formulas, drafted on the root).
  const formulaSection =
    options.isRoot && options.formulaSettings && partOn("formulas")
      ? formulaSettingsSectionHtml(options.formulaSettings, !collapsedSections.has("formulas"))
      : "";
  // Whether assistants in the browser may fill the form (Browser assistants): no part gates it.
  const assistantsSection =
    options.isRoot && options.assistantsSettings
      ? assistantsSettingsSectionHtml(options.assistantsSettings, !collapsedSections.has("assistants"))
      : "";
  // Then what other modes add to the form's settings, a section each.
  const modeSettingsSections = options.isRoot
    ? (options.modeSettings ?? []).map((group) => modeSettingsSectionHtml(group, !collapsedSections.has(`mode-${group.mode}`), words)).join("")
    : "";
  // No "you are editing the form" note: the Form panel's own head says so, and on
  // the inspector the root is never the subject.
  // The ID and where its answer is saved: what the component is rather than
  // how it behaves, kept together so the floating drawer draws them as one card. The path is
  // a read-only box like the ID's: readonly rather than disabled, so it can still be selected
  // and copied, and it carries no data-prop, so nothing in it reaches the draft.
  const savesToRow =
    savedAs && savedAsPath !== undefined
      ? `<div class="property-row property-row--help" data-saved-as><span class="property-label"><label for="${propertyDomId("savedAs")}"><strong>${esc(builderText("inspector.savesTo", undefined, words))}</strong></label>
        ${savedAs.toggle}</span>
        <input id="${propertyDomId("savedAs")}" type="text" readonly value="${esc(savedAsPath)}" aria-describedby="${savedAs.id}" />
        ${savedAs.text}</div>`
      : "";
  const aboutCard =
    idRow || savesToRow ? `<div class="inspector-about" data-inspector-about>${idRow}${savesToRow}</div>` : "";
  return `
    ${
      model.unknownType
        ? `<p class="note drop-error" data-tone="error" data-unknown-type>${esc(builderText("inspector.unknownType", { type: selectedNode.type }, words))}</p>`
        : ""
    }
    ${aboutCard}
    ${hintsBlock}${notesBlock}
    ${sections}
    ${identitySection}
    ${formulaSection}
    ${assistantsSection}
    ${modeSettingsSections}`;
}

/** The builder's words for the four shared panel looks, by class name. */
const PANEL_LOOK_TEXTS: Readonly<Record<string, { label: BuilderTextKey; help: BuilderTextKey }>> = {
  "panel-plain": { label: "inspector.styleLook.plain", help: "inspector.styleLook.plainHelp" },
  "panel-outlined": { label: "inspector.styleLook.outlined", help: "inspector.styleLook.outlinedHelp" },
  "panel-shaded": { label: "inspector.styleLook.shaded", help: "inspector.styleLook.shadedHelp" },
  "panel-card": { label: "inspector.styleLook.card", help: "inspector.styleLook.cardHelp" }
};

/**
 * The Style tab's options: the classes the binding declares for this component, by name, as
 * toggles, never a picker of raw class names. Classes that share a group exclude each other: they
 * are drawn as one set of radio buttons under a legend, with a "Default" choice first that clears
 * the set (a native radio group, so the arrow keys move between the choices and the group is one
 * Tab stop). A group with a single class offered has nothing to exclude and is a toggle.
 * A shared panel look is worded through the builder's text tables (so a host's translation of the
 * tab reaches it) while the binding declares it as the shared one; a binding that relabels a look,
 * or declares a class of its own, is worded as it declares it. The radios check the last active
 * class of a group, the one the form draws when a hand-written list holds two. Nothing when the
 * binding declares none that applies.
 */
export function styleOptionsHtml(view: PropertiesPanelOptions["styleOptions"], words?: BuilderTextOptions): string {
  if (!view || view.choices.length === 0) {
    return "";
  }
  const active = new Set(view.active);
  let helpIndex = 0;
  // What a choice is called and says: the builder's words for a shared look the binding leaves as shared, else its own.
  const worded = <T extends { name: string; label: string; description?: string | undefined }>(choice: T): T => {
    const shared = PANEL_LOOK_CLASSES.find((look) => look.name === choice.name);
    const own = PANEL_LOOK_TEXTS[choice.name];
    if (!shared || !own) {
      return choice;
    }
    return {
      ...choice,
      label: choice.label === shared.label ? builderText(own.label, undefined, words) : choice.label,
      ...(choice.description === undefined || choice.description === shared.description ? { description: builderText(own.help, undefined, words) } : {})
    };
  };
  const optionHtml = (choice: { label: string; description?: string | undefined }, input: (describedBy: string) => string): string => {
    const helpId = choice.description ? `style-option-${helpIndex++}-help` : "";
    const help = helpId ? `<span class="style-option-help" id="${helpId}">${esc(choice.description ?? "")}</span>` : "";
    return `<label class="style-option">${input(helpId)}<span class="style-option-text"><span>${esc(choice.label)}</span>${help}</span></label>`;
  };
  const described = (helpId: string): string => (helpId ? ` aria-describedby="${helpId}"` : "");
  const box = (choice: { name: string; label: string; description?: string | undefined }): string =>
    optionHtml(worded(choice), (helpId) => `<input type="checkbox" data-style-option="${esc(choice.name)}"${active.has(choice.name) ? " checked" : ""}${described(helpId)} />`);

  const groups = new Map<string, typeof view.choices[number][]>();
  for (const choice of view.choices) {
    if (choice.group !== undefined) {
      groups.set(choice.group, [...(groups.get(choice.group) ?? []), choice]);
    }
  }
  const drawn = new Set<string>();
  const body = view.choices
    .map((choice) => {
      const members = choice.group === undefined ? undefined : groups.get(choice.group);
      if (choice.group === undefined || members === undefined || members.length < 2) {
        return box(choice);
      }
      if (drawn.has(choice.group)) {
        return "";
      }
      drawn.add(choice.group);
      const group = choice.group;
      // The last active class of the group is the one drawn: print and the canvas read a hand-written list the same way.
      const chosen = [...view.active].reverse().find((name) => members.some((member) => member.name === name));
      const field = `style-group-${group}`;
      const legend =
        group === PANEL_LOOK_GROUP
          ? builderText("inspector.styleGroup.panelLook", undefined, words)
          : (members.find((member) => member.groupLabel !== undefined)?.groupLabel ?? builderText("inspector.styleGroup.other", undefined, words));
      const none = optionHtml(
        { label: builderText("inspector.styleGroup.default", undefined, words), description: builderText("inspector.styleGroup.defaultHelp", undefined, words) },
        (helpId) => `<input type="radio" name="${esc(field)}" data-style-group-clear="${esc(group)}"${chosen === undefined ? " checked" : ""}${described(helpId)} />`
      );
      const radios = members.map((member) =>
        optionHtml(worded(member), (helpId) => `<input type="radio" name="${esc(field)}" data-style-option="${esc(member.name)}"${member.name === chosen ? " checked" : ""}${described(helpId)} />`)
      );
      return `<fieldset class="style-option-group" data-style-group="${esc(group)}"><legend>${esc(legend)}</legend>${none}${radios.join("")}</fieldset>`;
    })
    .join("");
  return `<fieldset class="style-options" data-style-options>
      <legend>${esc(builderText("inspector.themeOptions", undefined, words))}</legend>
      ${body}
    </fieldset>`;
}

export interface InspectorFooterOptions {
  /** No selection at all — the footer is not rendered. */
  hasSelection: boolean;
  /** Whether the draft differs from what is committed. Drives Save / Cancel. */
  dirty: boolean;
  /** The form root cannot be deleted, so it gets no delete control. */
  deletable: boolean;
  /**
   * What holds the Save back, in the order the panel shows them, each with the name of the
   * box it is under. Save stays usable: pressing it with a problem leads to the first one
   * instead of saving, and the line above it leads to each.
   */
  problems?: ReadonlyArray<{ target: string; label: string; message: string }>;
  /** Whether the list the count opens is open (only with more than one problem). */
  problemsOpen?: boolean;
  /**
   * Whether Apply is held back (`applyBlockers`: a pattern that is no regular
   * expression, a minimum above its maximum). The one exception to the rule below: Apply is
   * disabled while it holds, and the message under the box and the line above say why.
   */
  applyBlocked?: boolean;
  /** The builder's words (locale and catalog); English when absent. */
  words?: BuilderTextOptions | undefined;
}

/** "1 problem", "3 problems". */
export function problemCountText(count: number, words?: BuilderTextOptions): string {
  return builderPlural("problems.count", count, undefined, words);
}

/** A problem in words: `CSS classes: "2cols" is not…`, or the message alone when it names its box already (`ID "city" already exists.`). */
export function problemText(problem: { label: string; message: string }, words?: BuilderTextOptions): string {
  return problem.message.toLowerCase().startsWith(problem.label.toLowerCase())
    ? problem.message
    : builderText("problem.labelled", { label: problem.label, message: problem.message }, words);
}

function problemTextHtml(problem: { label: string; message: string }): string {
  return problem.message.toLowerCase().startsWith(problem.label.toLowerCase())
    ? esc(problem.message)
    : `<strong>${esc(problem.label)}</strong> ${esc(problem.message)}`;
}

/**
 * Save / Cancel / Delete. The panel edits into a draft rather than writing through on every
 * keystroke, so these are how an edit actually lands (or is thrown away) — which also makes a
 * session of typing one entry in the undo history instead of one per character. Save is never
 * disabled by a problem: a disabled button says nothing and cannot be reached, so Save leads
 * to the problem instead, and the line above it says what is wrong and leads to each one.
 */
export function inspectorFooterHtml(options: InspectorFooterOptions): string {
  if (!options.hasSelection) {
    return "";
  }
  const words = options.words;
  const deleteButton = options.deletable
    ? `<button type="button" class="btn danger" data-inspector-delete>${esc(builderText("common.delete", undefined, words))}</button>`
    : "";
  const problems = options.problems ?? [];
  const listed = problems.length > 1 && options.problemsOpen === true;
  // One problem: its message, which goes straight to its box. Several: their count, which opens their list.
  const first = problems[0];
  const summary =
    problems.length === 0 || !first
      ? ""
      : problems.length === 1
        ? `<button type="button" class="problem-summary" data-inspector-problems title="${esc(builderText("problem.goTo", undefined, words))}"><span class="problem-summary__count">${esc(problemCountText(1, words))}:</span> ${problemTextHtml(first)}</button>`
        : `<button type="button" class="problem-summary" data-inspector-problems aria-expanded="${listed ? "true" : "false"}" aria-controls="inspector-problem-list"><span class="problem-summary__count">${esc(problemCountText(problems.length, words))}</span></button>`;
  const list = listed
    ? `<ul class="problem-list" id="inspector-problem-list" data-inspector-problem-list>${problems
        .map(
          (problem) =>
            `<li><button type="button" class="problem-item" data-problem-go="${esc(problem.target)}">${problemTextHtml(problem)}</button></li>`
        )
        .join("")}</ul>`
    : "";
  return `<div class="inspector-footer">
      ${summary}
      ${list}
      <div class="inspector-footer-row">
        <span class="spacer"></span>
        ${options.dirty ? `<span class="dirty-flag" data-not-applied>${esc(builderText("problem.notApplied", undefined, words))}</span>` : ""}
        <button type="button" class="btn" data-inspector-cancel ${options.dirty ? "" : "disabled"}>${esc(builderText("common.discard", undefined, words))}</button>
        <button type="button" class="btn primary" data-inspector-save ${options.dirty && options.applyBlocked !== true ? "" : "disabled"}>${esc(builderText("common.apply", undefined, words))}</button>
        ${deleteButton}
      </div>
    </div>`;
}
