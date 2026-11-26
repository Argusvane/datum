/**
 * The Header & footer panel: the form's own chrome — the parts drawn above and
 * below its fields, saved as `root.configuration.chrome` — edited in a panel the
 * activity strip opens in the side column, beside Form, Components and Outline. Both regions
 * at once, one block per part with its type, its place on its row and its own boxes, groups
 * indented with their own Add.
 *
 * There is no working copy and no Apply: this
 * edits the root's draft directly: every keystroke reaches the draft, so the canvas previews
 * the header as it is typed, and Save and Cancel are the root's — the same draft the Form
 * panel edits, so an edit made in either shows as unsaved in both, and either one's Save
 * lands both. The prompt that guards that draft (unsaved changes on the way out) is drawn
 * here too when this is the panel on screen.
 *
 * A docked panel hears every controller change, so it repaints only for what it shows: the
 * two regions as drafted, whether the root is dirty, and a prompt naming the root.
 */
import { BuilderController, type BuilderChangeEvent, type BuilderChangeReason } from "../controller/builder-controller.js";
import {
  readFormChromeParts,
  type FormChromePart,
  type FormChromePartType,
  type FormChromeRegion
} from "../../core/schema/form-chrome.js";
import { kernelMaxComponentDepth } from "../../core/expressions/compile.js";
import { isSafeSegment } from "../../core/localization/translations.js";
import { canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import { BuilderWords, type BuilderTextCatalog, type BuilderTextKey } from "../logic/builder-texts.js";
import { BuilderPanelElement, PANEL_TITLE_STYLES, describeUnsavedChanges, type BuilderOpenPanelDetail } from "./builder-panels.js";
import type { JsonViewer } from "./json-viewer.js";
import { mountJsonViewerAfter } from "./json-viewer-loader.js";
import {
  CHROME_PART_TYPE_LABELS,
  CONFIRM_STYLES,
  builderTokens,
  chromeListAt,
  chromePartAt,
  chromePartIds,
  createChromePart,
  nextChromePartId,
  esc,
  translationCoverageReader,
  translationPointerHtml,
  unsavedChangesPromptHtml
} from "./builder-shared.js";
import type { BuilderLanguagesGotoDetail } from "../languages/languages-surface.js";
import { showBuilderModal } from "./modal-place.js";

// Re-exported for the element's load check (`@argusvane/datum-engine` has no other door to the schema layer's reader).
export { chromePartIdProblems } from "../../core/schema/form-chrome.js";

export const DATUM_BUILDER_CHROME_PANEL_TAG = "datum-builder-chrome-panel";

/** The two regions, in the order the panel lists them: the header above the fields, the footer below. */
export const CHROME_PANEL_REGIONS: readonly FormChromeRegion[] = ["header", "footer"];

/** English words, for the editor's pure functions when no panel hands its own. */
const ENGLISH_WORDS = new BuilderWords();

/** A part type's name in the builder's words (the editor's picker and each part's Part box). */
function partTypeChoices(nested: boolean, w: BuilderWords): Array<{ value: FormChromePartType; label: string }> {
  return CHROME_PART_TYPE_LABELS.filter((entry) => !nested || entry.value !== "group").map((entry) => ({
    value: entry.value,
    label: w.text(`chrome.partType.${entry.value}` as BuilderTextKey)
  }));
}

/**
 * What the panel shows: the parts editor, or the chrome block as it will be saved. Parts is
 * the one tab; the JSON sits behind the tabs' ⋯, as the inspector's and the Form panel's do,
 * since it is a view of the block rather than a way to edit it.
 */
export type ChromePanelTab = "parts" | "json";

const MORE_GLYPH =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>';

/** The property a region's parts live under on the form root. */
export function chromeRegionPath(region: FormChromeRegion): string {
  return `chrome.${region}`;
}

/** A row key (`0.2`) or move token (`0.2:1`) quoted for an attribute selector; jsdom has no `CSS.escape`. */
function chromeKey(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** The text of a part property, for its box: a string in the default language, blank when unset. */
function chromeTextOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function chromeSelectHtml(key: string, fieldName: string, label: string, value: string, choices: ReadonlyArray<{ value: string; label: string }>): string {
  const options = choices
    .map((choice) => `<option value="${esc(choice.value)}"${choice.value === value ? " selected" : ""}>${esc(choice.label)}</option>`)
    .join("");
  return `<label><span>${esc(label)}</span><select data-chrome-row="${esc(key)}" data-chrome-field="${fieldName}" aria-label="${esc(label)}">${options}</select></label>`;
}

function chromeInputHtml(key: string, fieldName: string, label: string, value: string, extra = ""): string {
  return `<label><span>${esc(label)}</span><input type="text" data-chrome-row="${esc(key)}" data-chrome-field="${fieldName}" aria-label="${esc(label)}" value="${esc(value)}"${extra} /></label>`;
}

const CHROME_ALIGN_CHOICES = (w: BuilderWords) => [
  { value: "", label: w.text("chrome.choice.default") },
  { value: "start", label: w.text("chrome.choice.start") },
  { value: "center", label: w.text("chrome.choice.center") },
  { value: "end", label: w.text("chrome.choice.end") }
];
const CHROME_LEVEL_CHOICES = (fallback: string, w: BuilderWords) => [
  { value: "", label: w.text("chrome.choice.levelDefault", { level: fallback }) },
  { value: "1", label: "h1" },
  { value: "2", label: "h2" },
  { value: "3", label: "h3" }
];
const CHROME_JUSTIFY_CHOICES = (w: BuilderWords) => [
  { value: "", label: w.text("chrome.choice.justifyDefault") },
  { value: "start", label: w.text("chrome.choice.start") },
  { value: "center", label: w.text("chrome.choice.center") },
  { value: "end", label: w.text("chrome.choice.end") },
  { value: "space-between", label: w.text("chrome.choice.spaceBetween") }
];

/** The type-specific boxes of one part. */
function chromePartFieldsHtml(part: FormChromePart, key: string, w: BuilderWords): string {
  switch (part.type) {
    case "language-switcher":
      return `${chromeInputHtml(key, "label", w.text("chrome.field.label"), chromeTextOf(part.label))}
        <label class="db-chrome-check"><input type="checkbox" data-chrome-row="${esc(key)}" data-chrome-field="hideLabel"${part.hideLabel ? " checked" : ""} /> <span>${esc(w.text("chrome.field.hideLabel"))}</span></label>`;
    case "image":
      return `${chromeInputHtml(key, "src", w.text("chrome.field.src"), chromeTextOf(part.src), ` placeholder="${esc(w.text("chrome.field.src.placeholder"))}"`)}
        ${chromeInputHtml(key, "alt", w.text("chrome.field.alt"), chromeTextOf(part.alt))}
        ${chromeInputHtml(key, "href", w.text("chrome.field.href"), chromeTextOf(part.href))}
        ${chromeInputHtml(key, "width", w.text("chrome.field.width"), part.width === undefined ? "" : String(part.width), ' inputmode="numeric"')}
        ${chromeInputHtml(key, "height", w.text("chrome.field.height"), part.height === undefined ? "" : String(part.height), ' inputmode="numeric"')}`;
    case "heading":
      return `${chromeInputHtml(key, "text", w.text("chrome.field.text"), chromeTextOf(part.text))}
        ${chromeSelectHtml(key, "level", w.text("chrome.field.level"), part.level === undefined ? "" : String(part.level), CHROME_LEVEL_CHOICES("2", w))}`;
    case "text":
      return chromeInputHtml(key, "text", w.text("chrome.field.text"), chromeTextOf(part.text));
    case "html":
      return `<label class="db-chrome-wide"><span>${esc(w.text("chrome.field.html"))}</span><textarea data-chrome-row="${esc(key)}" data-chrome-field="html" aria-label="${esc(w.text("chrome.field.html.label"))}" rows="3">${esc(chromeTextOf(part.html))}</textarea></label>`;
    case "form-title":
      return chromeSelectHtml(key, "level", w.text("chrome.field.level"), part.level === undefined ? "" : String(part.level), CHROME_LEVEL_CHOICES("1", w));
    case "form-description":
      return `<p class="db-chrome-note">${esc(w.text("chrome.field.description"))}</p>`;
    case "group":
      return `${chromeSelectHtml(key, "justify", w.text("chrome.field.spread"), part.justify ?? "", CHROME_JUSTIFY_CHOICES(w))}
        ${chromeSelectHtml(key, "verticalAlign", w.text("chrome.field.lineUp"), part.verticalAlign ?? "", [
          { value: "", label: w.text("chrome.choice.middleDefault") },
          { value: "start", label: w.text("chrome.choice.top") },
          { value: "center", label: w.text("chrome.choice.middle") },
          { value: "end", label: w.text("chrome.choice.bottom") }
        ])}`;
    default:
      return "";
  }
}

/** The add-part row: a type picker and the button; `key` is the group to add into, `""` the region itself. */
function chromeAddHtml(key: string, nested: boolean, w: BuilderWords): string {
  const options = partTypeChoices(nested, w)
    .map((entry) => `<option value="${entry.value}">${esc(entry.label)}</option>`)
    .join("");
  return `<div class="db-chrome-add"><select data-chrome-add-type="${esc(key)}" aria-label="${esc(w.text(nested ? "chrome.add.typeGroup" : "chrome.add.type"))}">${options}</select>
      <button type="button" class="btn" data-chrome-add="${esc(key)}">${esc(w.text(nested ? "chrome.add.group" : "chrome.add.button"))}</button></div>`;
}

/** The pointer line under a part's boxes: the part's coverage and the way to its rows in Languages. */
type ChromePointer = (part: FormChromePart) => string;

function chromePartRowHtml(part: FormChromePart, key: string, index: number, count: number, nested: boolean, w: BuilderWords, pointer?: ChromePointer): string {
  const ordinal = index + 1;
  const typeChoices = partTypeChoices(nested, w);
  const alignBox = nested ? "" : chromeSelectHtml(key, "align", w.text("chrome.field.place"), part.align ?? "", CHROME_ALIGN_CHOICES(w));
  const children =
    part.type === "group"
      ? `<div class="db-chrome-list db-chrome-list--nested" data-chrome-list="${esc(key)}">${
          part.parts.length === 0 ? `<p class="db-chrome-note">${esc(w.text("chrome.group.empty"))}</p>` : ""
        }${part.parts.map((child, childIndex) => chromePartRowHtml(child, `${key}.${childIndex}`, childIndex, part.parts.length, true, w, pointer)).join("")}${chromeAddHtml(key, true, w)}</div>`
      : "";
  return `<div class="db-chrome-part${nested ? " db-chrome-part--nested" : ""}" data-chrome-part-row="${esc(key)}" data-chrome-part-id="${esc(part.id)}">
      <div class="db-chrome-part__head">
        <span class="db-chrome-part__ordinal">${ordinal}</span>
        ${chromeSelectHtml(key, "type", w.text("chrome.field.part"), part.type, typeChoices)}
        ${alignBox}
        <span class="db-chrome-actions">
          <button type="button" class="btn" data-chrome-move="${esc(key)}:-1" aria-label="${esc(w.text("chrome.move.upLabel", { n: ordinal }))}" data-tip="${esc(w.text("chrome.move.up"))}" data-tip-side="top"${index === 0 ? " disabled" : ""}>↑</button>
          <button type="button" class="btn" data-chrome-move="${esc(key)}:1" aria-label="${esc(w.text("chrome.move.downLabel", { n: ordinal }))}" data-tip="${esc(w.text("chrome.move.down"))}" data-tip-side="top"${index === count - 1 ? " disabled" : ""}>↓</button>
          <button type="button" class="btn" data-chrome-remove="${esc(key)}" aria-label="${esc(w.text("chrome.remove.label", { n: ordinal }))}" data-tip="${esc(w.text("chrome.remove"))}" data-tip-side="top">×</button>
        </span>
      </div>
      <div class="db-chrome-part__fields">${chromePartFieldsHtml(part, key, w)}</div>${pointer?.(part) ?? ""}${children}
    </div>`;
}

/**
 * One region of the panel: its title, a block per part — its type, its place on its row,
 * its own boxes — groups holding their parts indented, with Add at the end of every list.
 * `pointer`, when given, draws a line under a part's boxes (its translation coverage). Row keys (`0`, `0.2`) are the part's indices within the region; the region itself is the
 * `data-chrome-region` section around them, which is how a control is told apart from its
 * twin in the other region.
 */
export function chromeRegionEditorHtml(region: FormChromeRegion, parts: FormChromePart[], w: BuilderWords = ENGLISH_WORDS, pointer?: ChromePointer): string {
  const rows =
    parts.length === 0
      ? `<p class="db-chrome-empty">${esc(w.text(region === "header" ? "chrome.empty.header" : "chrome.empty.footer"))}</p>`
      : parts.map((part, index) => chromePartRowHtml(part, String(index), index, parts.length, false, w, pointer)).join("");
  return `<section class="db-chrome-region" data-chrome-region="${region}" aria-labelledby="chrome-${region}-title">
      <h4 class="db-chrome-region__title" id="chrome-${region}-title">${esc(w.text(region === "header" ? "chrome.region.header" : "chrome.region.footer"))}</h4>
      <div class="db-chrome-list" data-chrome-list="" data-chrome-focus>${rows}</div>
      ${chromeAddHtml("", false, w)}
    </section>`;
}

export const CHROME_PANEL_STYLES = `
  /* A column like the inspector's: a fixed head, one scrolling body, a footer that stays put. */
  .panel { display: flex; flex-direction: column; overflow: hidden; }
  .chrome-head { justify-content: flex-start; margin-bottom: var(--db-space-3); }
  .chrome-head strong { font-family: var(--db-font); font-size: var(--db-text-lg); font-weight: 600; line-height: 1.2; color: var(--db-ink); }
  .chrome-body { flex: 1; min-height: 0; overflow: auto; }
  /*
   * The tabs as the inspector draws them: a row of pills, the open one drawn as the selected
   * segment, and the ⋯ at the end of the row with its menu (the JSON) under it. The ⋯ is
   * pressed while the JSON is up.
   */
  .inspector-tabs { position: relative; display: flex; align-items: center; gap: var(--db-space-1); margin-bottom: var(--db-space-4); flex-wrap: nowrap; }
  .inspector-tablist { display: flex; gap: var(--db-space-1); flex-wrap: wrap; }
  .inspector-tab {
    appearance: none; display: inline-flex; align-items: center; gap: var(--db-space-2);
    min-block-size: 34px; padding: 0 var(--db-space-3);
    border: 0; border-radius: var(--db-radius-pill);
    background: transparent; color: var(--db-ink-muted);
    font: inherit; font-family: var(--db-font); font-size: var(--db-text-base); font-weight: 500; cursor: pointer;
    transition: background-color var(--db-motion-fast) var(--db-ease), color var(--db-motion-fast) var(--db-ease);
  }
  .inspector-tab:hover { background: var(--db-surface-hover); color: var(--db-ink); }
  .inspector-tab.active, .inspector-tab.active:hover { background: var(--db-selected); color: var(--db-selected-ink); }
  .inspector-more { margin-inline-start: auto; }
  /* The shared menu (.menu), dropped from the tabs' end. */
  .inspector-menu { position: absolute; inset-inline-end: 0; top: calc(100% + var(--db-space-1)); }
  /* The JSON: the read-only editor fills the body, bleeding to the panel's edges as the inspector's does. */
  .chrome-body:has(> [data-json-view]) { display: flex; flex-direction: column; margin: 0 calc(-1 * var(--db-space-4)); }
  [data-json-view] { flex: 1; min-height: 0; margin: 0; }
  [data-json-view][hidden] { display: none; }
  .json-editor {
    flex: 1; min-height: 240px; display: flex; flex-direction: column;
    border-top: var(--db-border-w) solid var(--db-line-divider); border-bottom: var(--db-border-w) solid var(--db-line-divider);
  }
  .json-editor > .cm-editor { flex: 1; min-height: 0; }
  .db-chrome-hint { margin: 0 0 var(--db-space-3); font-size: var(--db-text-sm); line-height: 1.4; color: var(--db-ink-muted); }
  /* The header and the footer: two groups, kept apart by space and a divider. */
  .db-chrome-region { margin-bottom: var(--db-space-4); }
  .db-chrome-region + .db-chrome-region { padding-top: var(--db-space-4); border-top: var(--db-border-w) solid var(--db-line-divider); }
  .db-chrome-region__title {
    margin: 0 0 var(--db-space-2); font-family: var(--db-font); font-size: var(--db-text-sm); font-weight: 600; line-height: 1.2;
    color: var(--db-ink-muted); letter-spacing: .02em;
  }
  /* A block per part on the surface, outlined by a divider line; groups indent their own list. */
  .db-chrome-list { display: grid; gap: var(--db-space-2); margin-bottom: var(--db-space-2); }
  .db-chrome-list--nested { padding-block: var(--db-space-2) 0; padding-inline: var(--db-space-3) 0; margin-bottom: 0; border-inline-start: 2px solid var(--db-line-divider); }
  .db-chrome-part {
    display: grid; gap: var(--db-space-2); padding: var(--db-space-3);
    border: var(--db-border-w) solid var(--db-line-divider); border-radius: var(--db-radius-md); background: var(--db-surface);
  }
  .db-chrome-part--nested { padding: var(--db-space-2) var(--db-space-3); }
  .db-chrome-part__head { display: flex; align-items: end; gap: var(--db-space-2); flex-wrap: wrap; }
  .db-chrome-part__head .db-chrome-actions { margin-inline-start: auto; align-self: end; white-space: nowrap; }
  /* Move up, move down, remove: round borderless icon buttons. */
  .db-chrome-actions .btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; min-width: 0; padding: 0; margin-inline-start: var(--db-space-half);
    border: 0; border-radius: var(--db-radius-pill); background: transparent; color: var(--db-ink-muted);
    font-size: var(--db-text-base);
  }
  .db-chrome-actions .btn:hover:not(:disabled) { background: var(--db-surface-hover); color: var(--db-ink); }
  .db-chrome-actions .btn[data-chrome-remove]:hover:not(:disabled) { color: var(--db-danger); }
  .db-chrome-part__ordinal { font-size: var(--db-text-xs); font-weight: 600; color: var(--db-ink-muted); min-width: 14px; align-self: end; padding-bottom: var(--db-space-3); font-variant-numeric: tabular-nums; }
  .db-chrome-part__fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--db-space-2); }
  .db-chrome-part__fields:empty { display: none; }
  .db-chrome-region label { display: grid; gap: var(--db-space-1); font-size: var(--db-text-md); font-weight: 500; min-width: 0; }
  .db-chrome-region label > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .db-chrome-region label.db-chrome-check { grid-template-columns: auto 1fr; align-items: center; gap: var(--db-space-2); min-height: 24px; font-weight: 400; }
  .db-chrome-region label.db-chrome-check > span { white-space: normal; }
  .db-chrome-region label.db-chrome-wide { grid-column: 1 / -1; }
  /* The boxes are the shared ones (SHARED_CONTROL_STYLES), at the row's width; the label's weight stays out of them. */
  .db-chrome-region :is(input[type="text"], select, textarea) { width: 100%; min-width: 0; font-weight: 400; }
  .db-chrome-region textarea { resize: vertical; font-family: var(--db-font-mono); font-size: var(--db-text-sm); line-height: 1.45; }
  .db-chrome-add { display: flex; gap: var(--db-space-2); align-items: center; }
  .db-chrome-add select { flex: 1; min-width: 0; }
  .db-chrome-note, .db-chrome-empty { margin: 0; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  /* Save / Cancel, pinned below the body as the inspector's are, across the drawer's whole width. */
  .inspector-footer {
    position: sticky; bottom: calc(-1 * var(--db-space-3)); z-index: 1;
    display: flex; align-items: center; gap: var(--db-space-2);
    margin: var(--db-space-3) calc(-1 * var(--db-space-4)) calc(-1 * var(--db-space-3)); padding: var(--db-space-3) var(--db-space-4);
    border-top: var(--db-border-w) solid var(--db-line-divider); background: var(--db-surface);
  }
  .inspector-footer .spacer { flex: 1; }
  /* Apply in the strong selected fill, as the inspector's and the Form panel's. */
  .inspector-footer .btn.primary { background: var(--db-selected); border-color: var(--db-selected); color: var(--db-selected-ink); }
  .inspector-footer .btn.primary:hover:not(:disabled) { background: color-mix(in oklab, var(--db-selected) 84%, var(--db-surface)); border-color: var(--db-selected); }
  /* Edits not yet applied: the warning ink, in words. */
  .dirty-flag { font-size: var(--db-text-sm); font-weight: 500; color: var(--db-warn); }
  .problem-count {
    appearance: none; background: none; border: none; padding: 0; min-height: 24px; cursor: pointer;
    font: inherit; font-size: var(--db-text-sm); font-weight: 500; color: var(--db-danger);
    text-decoration: underline; text-underline-offset: 2px;
  }
  .problem-count:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; border-radius: var(--db-radius-xs); }
  /* The head's grouping draws nothing outside the floating drawer. */
  .inspector-top { display: contents; }
  /*
   * In the floating drawer (data-floating) the panel is a stack of cards like the
   * inspector's: the head, the hint, a card per region, and Apply and Discard in their own.
   */
  :host([data-floating]) { pointer-events: none; }
  :host([data-floating]) .panel { height: auto; max-height: 100%; padding: 0; gap: var(--db-space-2); background: transparent; overflow: visible; }
  :host([data-floating]) .panel > * { pointer-events: auto; }
  :host([data-floating]) :is(.inspector-top, .inspector-footer, .chrome-body > *) {
    background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card);
    border-radius: var(--db-radius-xl); box-shadow: var(--db-shadow-card);
  }
  :host([data-floating]) .inspector-top { display: block; flex: none; padding: var(--db-space-3) var(--db-space-4); }
  :host([data-floating]) .inspector-top > :last-child { margin-bottom: 0; }
  :host([data-floating]) .chrome-body {
    flex: 0 1 auto; display: flex; flex-direction: column; gap: var(--db-space-2);
    margin: 0 calc(-1 * var(--db-space-2)); padding: 0 var(--db-space-2) var(--db-space-3);
  }
  :host([data-floating]) .chrome-body > * { flex: none; margin: 0; padding: var(--db-space-3) var(--db-space-4); }
  :host([data-floating]) .chrome-body > .db-chrome-region + .db-chrome-region { border-top: var(--db-border-w) solid var(--db-line-card); }
  :host([data-floating]) .chrome-body:has(> [data-json-view]) {
    flex: 1 1 auto; gap: 0; margin: 0; padding: 0; overflow: hidden;
    background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-xl); box-shadow: var(--db-shadow-card);
  }
  :host([data-floating]) .chrome-body:has(> [data-json-view]) > * { flex: 1 1 auto; padding: 0; border: 0; border-radius: 0; box-shadow: none; }
  :host([data-floating]) .chrome-body:has(> [data-json-view]) > [hidden] { display: none; }
  :host([data-floating]) .inspector-footer { position: static; flex: none; margin: 0; padding: var(--db-space-3) var(--db-space-4); box-shadow: var(--db-shadow-overlay); }  /*
   * The phone sheet: the footer clears the home indicator through the
   * shell's safe-area token, and the rows, checkboxes and icon buttons are finger-sized (a box
   * is 24px at the least, its row 44px).
   */
  :host([data-phone]) .inspector-footer { padding-bottom: calc(var(--db-space-3) + var(--db-safe-bottom, env(safe-area-inset-bottom, 0px))); }
  :host([data-phone]) .inspector-footer .btn, :host([data-phone]) .db-chrome-region .btn { min-block-size: var(--db-density-control-h, 44px); }
  :host([data-phone]) .db-chrome-actions .btn { inline-size: var(--db-density-control-h, 44px); block-size: var(--db-density-control-h, 44px); }
  :host([data-phone]) .db-chrome-region label.db-chrome-check { min-height: var(--db-density-control-h, 44px); }
  :host([data-phone]) .inspector-tab, :host([data-phone]) .menu-item { min-block-size: var(--db-density-control-h, 44px); }
  :host([data-phone]) .problem-count { min-height: var(--db-density-control-h, 44px); }
`;

/**
 * The dataset attributes that together address one control, with the region it sits in.
 * Matching walks the rendered controls and compares these rather than building a selector,
 * as the inspector does: `CSS.escape` is not in every DOM the panels run under.
 */
const FOCUS_KEY_ATTRIBUTES = ["chromeTab", "chromeMore", "chromeRow", "chromeField", "chromeAdd", "chromeAddType", "chromeMove", "chromeRemove", "inspectorSave", "inspectorCancel"] as const;

interface FocusSnapshot {
  key: string;
  start: number | null;
  end: number | null;
}

export class DatumBuilderChromePanelElement extends BuilderPanelElement {
  private bound = false;
  /** What the panel drew last, cheap to recompute, so a change elsewhere in the form costs no markup. */
  private stateKey: string | undefined;
  private tab: ChromePanelTab = "parts";
  /** The builder's words (the text catalog), English until the host sets a locale or catalog. */
  private readonly words = new BuilderWords();

  /** The builder's own language for its words, not the form's. */
  public set textLocale(value: string | undefined) {
    if (this.words.locale !== value) {
      this.words.locale = value;
      this.repaintForWords();
    }
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. */
  public set textCatalog(value: BuilderTextCatalog | undefined) {
    if (this.words.catalog !== value) {
      this.words.catalog = value;
      this.repaintForWords();
    }
  }

  /** The words moved: the panel draws again, keeping the focus and caret a repaint keeps. */
  private repaintForWords(): void {
    this.stateKey = undefined;
    this.paint();
  }
  private jsonOn = true;
  private languagesOn = false;
  private translationsOn = true;

  /**
   * Whether the shell offers the Languages workspace: each part's pointer line then
   * offers Open in Languages, filtered to that part's texts.
   */
  public get languagesWorkspace(): boolean {
    return this.languagesOn;
  }

  public set languagesWorkspace(value: boolean) {
    if (value === this.languagesOn) {
      return;
    }
    this.languagesOn = value;
    this.stateKey = undefined;
    this.paint();
  }

  /** Whether the builder's `translations` feature is on: off, no part draws a pointer line. */
  public get translationsEnabled(): boolean {
    return this.translationsOn;
  }

  public set translationsEnabled(value: boolean) {
    if (value === this.translationsOn) {
      return;
    }
    this.translationsOn = value;
    this.stateKey = undefined;
    this.paint();
  }

  /**
   * Whether the panel may show its JSON view (the `json` feature): off, the ⋯ menu and
   * its only item are not drawn, so the JSON editor's chunk is never asked for. A change repaints
   * once (the shell sets it inside its suspended paints); an unchanged value does nothing.
   */
  public get jsonEnabled(): boolean {
    return this.jsonOn;
  }

  public set jsonEnabled(value: boolean) {
    if (value === this.jsonOn) {
      return;
    }
    this.jsonOn = value;
    if (!value && this.tab === "json") {
      this.tab = "parts";
    }
    this.stateKey = undefined;
    this.paint();
  }

  /** Whether the tabs' ⋯ menu is open; opening and closing it toggles markup in place, no repaint. */
  private menuOpen = false;
  /**
   * The JSON tab's read-only editor while one is on screen. Every paint replaces the panel's
   * markup, so the editor is torn down before a paint and mounted again after it, its scroll
   * offset carried across (see {@link mountJson}).
   */
  private jsonViewer: JsonViewer | undefined;

  /**
   * Everything this panel draws: the regions as drafted, whether the root is dirty and its
   * Save usable, and a prompt naming the root. A change that leaves all of it alone — a
   * field's label being typed in the inspector — is not worth composing markup for.
   */
  private currentStateKeys(): { full: string; clean: string } | undefined {
    const controller = this.ctrl;
    if (!controller) {
      return undefined;
    }
    const rootId = controller.rootId();
    // What a live keystroke changes: the box holds it already, the footer is refreshed in place.
    const typed = JSON.stringify([controller.draftProperty(rootId, "chrome"), controller.hasPendingChanges(rootId), controller.unsavedChangesPrompt()]);
    const clean = JSON.stringify([
      rootId,
      this.primaryValue,
      this.tab,
      // The root's own problems: a field's never hold this Save back.
      controller.problemsOf(rootId),
      // The parts' pointer lines: the languages, the map and the page's
      // catalog they are counted from, as identities (no walk of the map per change).
      this.pointerKey(controller)
    ]);
    return { full: `${clean}\n${typed}`, clean };
  }

  /** What the parts' pointer lines are drawn from, as a cheap key; empty when none is drawn. */
  private pointerKey(controller: BuilderController): string {
    if (!this.primaryValue || !this.translationsOn) {
      return "";
    }
    const identity = (value: object | undefined): number => {
      if (!value) {
        return 0;
      }
      const known = DatumBuilderChromePanelElement.identities.get(value);
      const id = known ?? (DatumBuilderChromePanelElement.nextIdentity += 1);
      DatumBuilderChromePanelElement.identities.set(value, id);
      return id;
    };
    return JSON.stringify([controller.localization(), identity(controller.translations()), identity(controller.translationCatalog()), this.languagesOn]);
  }

  private static readonly identities = new WeakMap<object, number>();
  private static nextIdentity = 0;

  /**
   * The line under each part's boxes: how well that part's texts (`chrome › <id> › …`) are
   * translated, counted by the Languages model so the line and the grid agree, and the
   * way to those rows. Nothing for a part with no text, a single-language form, a tree that is
   * not the form's own, or with the `translations` feature off.
   */
  private pointerFor(controller: BuilderController): ChromePointer | undefined {
    if (!this.primaryValue || !this.translationsOn) {
      return undefined;
    }
    const read = translationCoverageReader(controller);
    return (part) =>
      translationPointerHtml(
        read((row) => row.address.kind === "chrome" && row.address.owner === part.id),
        this.words.options(),
        this.languagesOn,
        { id: part.id, label: part.id }
      );
  }

  protected override onControllerChange(reason: BuilderChangeReason, event?: BuilderChangeEvent): void {
    const keys = this.currentStateKeys();
    const key = keys?.full;
    if (key !== undefined && key === this.stateKey) {
      return;
    }
    if (reason === "edit" && event?.live && this.liveWrite && key !== undefined && keys?.clean === this.stateKeyClean) {
      // This panel's own keystroke in a part's box: the draft holds the text, the box is not
      // touched, and the footer (Apply, Discard, Not applied) is redrawn only when the pending
      // flag moved. Nothing is painted.
      this.stateKey = key;
      if (!!this.ctrl?.hasPendingChanges(this.ctrl.rootId()) !== this.footerDirty) {
        this.refreshFooter();
      }
      return;
    }
    this.paint();
  }

  /** Whether the footer as last drawn showed the draft as waiting to be applied. */
  private footerDirty: boolean | undefined;

  /** True while a keystroke's live write is going to the controller (see {@link writeParts}). */
  private liveWrite = false;
  /** A live keystroke waits for its plain change when the author leaves the box. */
  private livePending = false;
  private stateKeyClean: string | undefined;

  private footerHtml(): string {
    const controller = this.ctrl!;
    const rootId = controller.rootId();
    const dirty = controller.hasPendingChanges(rootId);
    this.footerDirty = dirty;
    const problems = controller.problemsOf(rootId);
    return `<div class="inspector-footer">
          ${dirty ? `<span class="dirty-flag" data-not-applied>${esc(this.words.text("chrome.notApplied"))}</span>` : ""}
          ${
            problems.length > 0
              ? `<button type="button" class="problem-count" data-chrome-problems title="${esc(this.words.text("chrome.problems.title"))}">${esc(this.words.plural("chrome.problems", problems.length))}</button>`
              : ""
          }
          <span class="spacer"></span>
          <button type="button" class="btn" data-inspector-cancel${dirty ? "" : " disabled"}>${esc(this.words.text("chrome.discard"))}</button>
          <button type="button" class="btn primary" data-inspector-save${dirty ? "" : " disabled"}>${esc(this.words.text("chrome.apply"))}</button>
        </div>`;
  }

  private refreshFooter(): void {
    const footer = this.root.querySelector<HTMLElement>(".inspector-footer");
    if (footer && this.ctrl) {
      footer.outerHTML = this.footerHtml();
    }
  }

  /** The selection is no concern of the form's chrome. */
  protected override onSelectionChange(): void {}

  /**
   * Puts focus on a region's first control — its first part's type, or the type picker of
   * its Add row when it is empty — for the Form panel's Edit button, which opens this panel
   * on that region. A paint skipped while the panel was hidden is made up first.
   */
  public focusRegion(region: FormChromeRegion): void {
    this.paint();
    const root = this.regionRoot(region);
    if (!root) {
      return;
    }
    if (typeof root.scrollIntoView === "function") {
      root.scrollIntoView({ block: "start" });
    }
    (
      root.querySelector<HTMLElement>("[data-chrome-part-row] select, [data-chrome-part-row] input") ??
      root.querySelector<HTMLElement>("[data-chrome-add-type='']")
    )?.focus();
  }

  protected render(): void {
    const controller = this.ctrl;
    const keys = this.currentStateKeys();
    this.stateKey = keys?.full;
    this.stateKeyClean = keys?.clean;
    const head = `<div class="panel-head chrome-head"><h2 class="panel-title"><strong>${esc(this.words.text("chrome.title"))}</strong></h2></div>`;
    if (!controller) {
      this.writeMarkup(`<style>${builderTokens()}</style><div class="panel"><p class="empty">${esc(this.words.text("shell.noController"))}</p></div>`);
      return;
    }
    if (!this.primaryValue) {
      // Another mode's document (a PDF layout) has no chrome: the shell hides this
      // panel's strip item on such a tab, so this is a panel used on its own.
      this.writeMarkup(
        `<style>${builderTokens()}${CHROME_PANEL_STYLES}${PANEL_TITLE_STYLES}</style><div class="panel panel--chrome">${head}<p class="empty">${esc(this.words.text("chrome.notPrimary"))}</p></div>`
      );
      return;
    }
    const rootId = controller.rootId();
    // One tab, and the ⋯ beside the tablist rather than in it: a tablist owns tabs only.
    const parts = this.tab === "parts";
    const pointer = parts ? this.pointerFor(controller) : undefined;
    const tabs = `<div class="inspector-tabs">
        <div class="inspector-tablist" role="tablist" aria-label="${esc(this.words.text("chrome.tablist"))}">
          <button type="button" role="tab" class="inspector-tab${parts ? " active" : ""}" data-chrome-tab="parts" aria-selected="${parts}">${esc(this.words.text("chrome.tab.parts"))}</button>
        </div>
        ${
          this.jsonOn
            ? `<button type="button" class="inspector-tab inspector-more${parts ? "" : " active"}" data-chrome-more aria-haspopup="menu"
          aria-expanded="${this.menuOpen}" aria-controls="chrome-menu" aria-label="${esc(this.words.text("chrome.more"))}" data-tip="${esc(this.words.text("chrome.more"))}">${MORE_GLYPH}</button>
        <div class="menu inspector-menu" id="chrome-menu" role="menu" data-chrome-menu${this.menuOpen ? "" : " hidden"}>
          <button type="button" class="menu-item" role="menuitem" data-chrome-tab="json">${esc(this.words.text("chrome.viewJson"))}</button>
        </div>`
            : ""
        }
      </div>`;
    // The JSON shows the root's `chrome` block as it will be saved — what the definition
    // carries under configuration.chrome, the frame included — read-only, through the same
    // viewer as the inspector's JSON tab; the parts stay the only way to change it here.
    const body =
      this.tab === "json"
        ? `<pre data-json-view>${esc(JSON.stringify(controller.draftProperty(rootId, "chrome") ?? {}, null, 2))}</pre>`
        : `<p class="db-chrome-hint">${esc(this.words.text("chrome.hint"))}</p>
          ${CHROME_PANEL_REGIONS.map((region) =>
            chromeRegionEditorHtml(region, readFormChromeParts(this.adoptedRegions()[region]), this.words, pointer)
          ).join("")}`;
    const dirty = controller.hasPendingChanges(rootId);
    // The root's draft is the Form panel's too, and so are the boxes its problems sit under:
    // Save and the count beside Unsaved open the Form panel at the first one (see saveDraft).
    const problems = controller.problemsOf(rootId);
    // The controller holds a click-away while the root's edits are unsaved; the panel on
    // screen is where the author answers it (the Form panel draws the same prompt when it is
    // the one open). One overlay at a time: a prompt yields nothing to a Save's confirmation.
    const held = controller.unsavedChangesPrompt();
    const prompt = held && !held.external && held.componentId === rootId ? describeUnsavedChanges(controller, held) : undefined;
    const focus = this.captureFocus();
    const markup = `
      <style>${builderTokens()}${CHROME_PANEL_STYLES}${PANEL_TITLE_STYLES}</style>
      <div class="panel panel--chrome">
        <div class="inspector-top">
        ${head}
        ${tabs}
        </div>
        <div class="chrome-body" data-chrome-body>${body}</div>
        ${this.footerHtml()}
        ${prompt ? unsavedChangesPromptHtml(prompt, this.words.options()) : ""}
      </div>`;
    if (markup === this.shownMarkup()) {
      return;
    }
    // The markup is about to be replaced; the JSON editor living in it goes first.
    const scrollTop = this.unmountJson();
    this.writeMarkup(markup);
    this.bind();
    this.restoreFocus(focus);
    this.mountJson(scrollTop);
    this.openPrompt();
  }

  // --- the ⋯ menu and the JSON ---------------------------------------------------

  private menuItems(): HTMLElement[] {
    return Array.from(this.root.querySelectorAll<HTMLElement>("[data-chrome-menu] [role=menuitem]"));
  }

  /** Opens or closes the ⋯ menu; open, focus goes to its first item, or its last for `"last"`. */
  private setMenuOpen(open: boolean, focus: "first" | "last" | "button" | "none" = "none"): void {
    this.menuOpen = open;
    this.root.querySelector<HTMLElement>("[data-chrome-menu]")?.toggleAttribute("hidden", !open);
    this.root.querySelector<HTMLElement>("[data-chrome-more]")?.setAttribute("aria-expanded", String(open));
    if (focus === "button") {
      this.root.querySelector<HTMLElement>("[data-chrome-more]")?.focus();
    } else if (open && focus !== "none") {
      const items = this.menuItems();
      items[focus === "first" ? 0 : items.length - 1]?.focus();
    }
  }

  /**
   * The menu's keys: Escape closes it and returns focus to the ⋯; the arrows, Home and End
   * walk its items, wrapping at the ends. Down or Up on the ⋯ itself opens it at the first or
   * last item. True when the key was the menu's.
   */
  private handleMenuKey(event: KeyboardEvent): boolean {
    const target = event.target as Element | null;
    const onButton = Boolean(target?.closest?.("[data-chrome-more]"));
    if (!this.menuOpen) {
      if (onButton && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        this.setMenuOpen(true, event.key === "ArrowDown" ? "first" : "last");
        return true;
      }
      return false;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.setMenuOpen(false, "button");
      return true;
    }
    const items = this.menuItems();
    const at = items.indexOf(target as HTMLElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") {
      next = at < 0 ? 0 : (at + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    }
    if (next === undefined || items.length === 0) {
      return false;
    }
    event.preventDefault();
    items[next]?.focus();
    return true;
  }

  private unmountJson(): number | undefined {
    const current = this.jsonViewer;
    if (!current) {
      return undefined;
    }
    this.jsonViewer = undefined;
    const scrollTop = current.scrollTop;
    current.destroy();
    return scrollTop;
  }

  /**
   * Mounts the read-only editor over the `<pre>` the markup carries, when the paint produced
   * one. The `<pre>` is the text's source and stays in the DOM, hidden, so the JSON is still
   * there for anything that reads it from the markup; the editor takes its place on screen,
   * at the offset the last one was scrolled to.
   */
  private mountJson(scrollTop: number | undefined): void {
    const source = this.root.querySelector<HTMLElement>("[data-json-view]");
    if (!source) {
      return;
    }
    mountJsonViewerAfter(source, { label: this.words.text("chrome.json.label") }, (viewer) => {
      if (scrollTop !== undefined) {
        viewer.scrollTop = scrollTop;
      }
      this.jsonViewer = viewer;
    });
  }

  // --- the draft ----------------------------------------------------------------

  private regionRoot(region: FormChromeRegion): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`[data-chrome-region="${region}"]`);
  }

  /** The region a control sits in, from the section around it. */
  private regionOf(target: Element): FormChromeRegion | undefined {
    const region = target.closest?.<HTMLElement>("[data-chrome-region]")?.dataset.chromeRegion;
    return region === "header" || region === "footer" ? region : undefined;
  }

  /**
   * A region's parts as drafted, normalised the way the renderer reads them — a fresh copy
   * to edit and write back, so what the panel lists is what the form draws.
   */
  private draftParts(region: FormChromeRegion): FormChromePart[] {
    return readFormChromeParts(this.adoptedRegions()[region]);
  }

  /**
   * The two regions as drafted, with a fresh id on every part that cannot key a translation: one
   * with none, an unsafe one, or one an earlier part already holds (the header's parts first). The
   * canvas draws such a part untranslated, so the panel lists it too, and the first edit writes
   * its id with the rest of the region (see {@link writeParts}) instead of reading it away.
   */
  private adoptedRegions(): Record<FormChromeRegion, unknown> {
    const controller = this.ctrl!;
    const rootId = controller.rootId();
    const regions = {} as Record<FormChromeRegion, unknown>;
    const parts: Array<Record<string, unknown>> = [];
    const gather = (list: unknown, depth: number): void => {
      if (!Array.isArray(list) || depth > kernelMaxComponentDepth()) {
        return;
      }
      for (const part of list) {
        if (part !== null && typeof part === "object" && !Array.isArray(part)) {
          parts.push(part as Record<string, unknown>);
          gather((part as Record<string, unknown>).parts, depth + 1);
        }
      }
    };
    for (const region of CHROME_PANEL_REGIONS) {
      const raw = controller.draftProperty(rootId, chromeRegionPath(region));
      regions[region] = Array.isArray(raw) ? structuredClone(raw) : raw;
      gather(regions[region], 1);
    }
    const taken = new Set<string>();
    const unkeyed: Array<Record<string, unknown>> = [];
    for (const part of parts) {
      if (isSafeSegment(part.id) && !taken.has(part.id)) {
        taken.add(part.id);
      } else {
        unkeyed.push(part);
      }
    }
    for (const part of unkeyed) {
      const id = nextChromePartId(taken);
      taken.add(id);
      part.id = id;
    }
    return regions;
  }

  /** Every part id in the header and the footer as drafted: a new part's id must be free across both. */
  private takenPartIds(): string[] {
    return CHROME_PANEL_REGIONS.flatMap((region) => chromePartIds(this.draftParts(region)));
  }

  /**
   * The edited parts into the draft, as authored — a part with an empty text stays, drawing
   * nothing until it is filled in — or the region cleared when it is empty, and the whole
   * `chrome` block with it once nothing else is in it, so a form that never composed a header
   * carries no scaffolding. The controller announces the change and the panel repaints from
   * the draft at once.
   */
  private writeParts(region: FormChromeRegion, parts: FormChromePart[], meta: { live?: boolean } = {}): void {
    const controller = this.ctrl!;
    const rootId = controller.rootId();
    this.liveWrite = meta.live === true;
    this.livePending = this.livePending || meta.live === true;
    try {
      controller.setDraftProperty(rootId, chromeRegionPath(region), parts.length > 0 ? parts : undefined, meta);
      // The other region's parts that were given an id here are written with this edit: one Save lands both.
      const other = CHROME_PANEL_REGIONS.find((name) => name !== region)!;
      const adopted = this.adoptedRegions()[other];
      if (adopted !== undefined && JSON.stringify(adopted) !== JSON.stringify(controller.draftProperty(rootId, chromeRegionPath(other)))) {
        controller.setDraftProperty(rootId, chromeRegionPath(other), adopted, meta);
      }
      const chrome = controller.draftProperty(rootId, "chrome");
      if (chrome && typeof chrome === "object" && Object.values(chrome as Record<string, unknown>).every((value) => value === undefined)) {
        controller.setDraftProperty(rootId, "chrome", undefined, meta);
      }
    } finally {
      this.liveWrite = false;
    }
  }

  private saveDraft(): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    // A problem holds the root's draft back; its box is the Form panel's, so Save goes there.
    if (controller.problemsOf(controller.rootId()).length > 0) {
      this.openProblem();
      return;
    }
    controller.commitDraft(controller.rootId());
  }

  /** Asks the shell to open the Form panel at the root's first problem, where its box is. */
  private openProblem(): void {
    const first = this.ctrl?.problemsOf(this.ctrl.rootId())[0];
    this.dispatchEvent(
      new CustomEvent<BuilderOpenPanelDetail>("builder-open-panel", {
        detail: { panel: "form", ...(first ? { problem: first.target } : {}) },
        bubbles: true,
        composed: true
      })
    );
  }

  // --- focus across a repaint ---------------------------------------------------

  private focusKeyFor(element: HTMLElement): string | undefined {
    const region = element.closest?.<HTMLElement>("[data-chrome-region]")?.dataset.chromeRegion ?? "";
    const parts = FOCUS_KEY_ATTRIBUTES.filter((name) => element.dataset[name] !== undefined).map((name) => `${name}=${element.dataset[name]}`);
    return parts.length > 0 ? `${region}|${parts.join("|")}` : undefined;
  }

  /** Every keystroke repaints from the draft; the box being typed in, and the caret, come back after it. */
  private captureFocus(): FocusSnapshot | undefined {
    const active = this.root.activeElement as HTMLElement | null;
    if (!active) {
      return undefined;
    }
    const key = this.focusKeyFor(active);
    if (key === undefined) {
      return undefined;
    }
    const text = active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type === "text");
    return {
      key,
      start: text ? (active as HTMLInputElement).selectionStart : null,
      end: text ? (active as HTMLInputElement).selectionEnd : null
    };
  }

  private restoreFocus(snapshot: FocusSnapshot | undefined): void {
    if (!snapshot) {
      return;
    }
    for (const candidate of this.root.querySelectorAll<HTMLElement>("input, select, textarea, button")) {
      if (this.focusKeyFor(candidate) !== snapshot.key) {
        continue;
      }
      candidate.focus();
      if (snapshot.start !== null && (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement)) {
        try {
          candidate.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
        } catch {
          // Not every input type supports a selection range.
        }
      }
      return;
    }
  }

  // --- the prompts ----------------------------------------------------------------

  /** Shows the prompt that is up modally, as the inspector does; Escape is "not now", never an answer. */
  private openPrompt(): void {
    const dialog = this.root.querySelector<HTMLDialogElement>("dialog[data-prompt]");
    if (!dialog) {
      return;
    }
    if (typeof dialog.showModal === "function") {
      showBuilderModal(dialog);
    } else {
      dialog.setAttribute("open", "");
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.dismissPrompt();
    });
    dialog.querySelector<HTMLElement>("[autofocus]")?.focus();
  }

  private dismissPrompt(): void {
    if (this.ctrl?.unsavedChangesPrompt()) {
      this.ctrl.answerUnsavedChangesPrompt("stay");
    }
  }

  // --- events ---------------------------------------------------------------------

  private bind(): void {
    if (this.bound) {
      return;
    }
    // Listeners live on the persistent shadow root; a repaint replaces the markup under them.
    this.bound = true;

    this.root.addEventListener("click", (event) => {
      const target = event.target as Element;
      // A prompt is modal while it is up, so its buttons are the only clicks that can arrive.
      if (target.closest?.("[data-unsaved-save]")) {
        this.ctrl?.answerUnsavedChangesPrompt("save");
        return;
      }
      if (target.closest?.("[data-unsaved-discard]")) {
        this.ctrl?.answerUnsavedChangesPrompt("discard");
        return;
      }
      if (target.closest?.("[data-unsaved-stay]")) {
        this.ctrl?.answerUnsavedChangesPrompt("stay");
        return;
      }
      // The tabs' ⋯ opens its menu; a click anywhere else in the panel closes it.
      if (target.closest?.("[data-chrome-more]")) {
        this.setMenuOpen(!this.menuOpen, this.menuOpen ? "none" : "first");
        return;
      }
      const menuWasOpen = this.menuOpen;
      if (menuWasOpen) {
        this.setMenuOpen(false);
      }
      const tab = target.closest?.<HTMLElement>("[data-chrome-tab]")?.dataset.chromeTab;
      if (tab === "parts" || tab === "json") {
        const fromMenu = target.closest?.("[data-chrome-menu]") != null;
        this.tab = tab;
        this.paint();
        // Chosen from the menu, focus goes back to the ⋯, which now shows the JSON is up.
        if (fromMenu) {
          this.root.querySelector<HTMLElement>("[data-chrome-more]")?.focus();
        }
        return;
      }
      // A part's pointer line: the shell opens Languages on that part's texts.
      const openLanguages = target.closest?.<HTMLElement>("[data-open-in-languages]");
      if (openLanguages) {
        const partId = openLanguages.dataset.openInLanguages;
        if (partId) {
          this.dispatchEvent(new CustomEvent<BuilderLanguagesGotoDetail>("builder-languages-goto", { detail: { kind: "chrome", partId }, bubbles: true, composed: true }));
        }
        return;
      }
      if (target.closest?.("[data-inspector-save]")) {
        this.saveDraft();
        return;
      }
      if (target.closest?.("[data-chrome-problems]")) {
        this.openProblem();
        return;
      }
      if (target.closest?.("[data-inspector-cancel]")) {
        this.ctrl?.discardDraft(this.ctrl.rootId());
        return;
      }
      this.handleRegionClick(target);
    });

    // Typing in a part's box edits the draft; the repaint that follows brings the box and
    // its caret back (see captureFocus).
    this.root.addEventListener("input", (event) => {
      const target = event.target as Element;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        this.handleInput(target);
      }
    });
    // Leaving a part's box: the text written live is written once more, plainly.
    this.root.addEventListener("focusout", (event) => {
      const target = event.target as Element;
      if (this.livePending && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        this.livePending = false;
        const region = this.regionOf(target);
        // Saved or discarded since the keystroke: the canvas never drew the live text.
        if (region && this.ctrl && this.ctrl.hasPendingChanges(this.ctrl.rootId())) {
          this.writeParts(region, this.draftParts(region));
        }
      }
    });
    // A part's type, place, level, spread or label switch: the region changes shape.
    this.root.addEventListener("change", (event) => {
      const target = event.target as Element;
      if (target instanceof HTMLSelectElement || target instanceof HTMLInputElement) {
        this.handleChange(target);
      }
    });

    // Enter saves and Escape cancels, as in the inspector — except behind a prompt, which
    // Escape dismisses, and in a textarea, where Enter is a new line.
    this.root.addEventListener("keydown", (event) => {
      const keyEvent = event as KeyboardEvent;
      // The ⋯ menu takes its keys first: Escape closes it, focus back on its button, the draft untouched.
      if (this.handleMenuKey(keyEvent)) {
        return;
      }
      if (keyEvent.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (this.ctrl?.unsavedChangesPrompt()) {
        if (keyEvent.key === "Escape") {
          keyEvent.preventDefault();
          this.dismissPrompt();
        }
        return;
      }
      if (keyEvent.key === "Enter" && !(keyEvent.target instanceof HTMLButtonElement)) {
        keyEvent.preventDefault();
        this.saveDraft();
      } else if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        this.ctrl?.discardDraft(this.ctrl.rootId());
      }
    });
  }

  /** Add, move and remove, each landing focus where the author goes next. */
  private handleRegionClick(target: Element): void {
    const region = this.ctrl ? this.regionOf(target) : undefined;
    if (!region) {
      return;
    }
    const add = target.closest?.<HTMLElement>("[data-chrome-add]")?.dataset.chromeAdd;
    if (add !== undefined) {
      const picker = this.regionRoot(region)?.querySelector<HTMLSelectElement>(`[data-chrome-add-type="${chromeKey(add)}"]`);
      const type = (picker?.value ?? "text") as FormChromePartType;
      const parts = this.draftParts(region);
      const list = add === "" ? parts : (chromePartAt(parts, add) as { parts?: FormChromePart[] } | undefined)?.parts;
      if (!list) {
        return;
      }
      list.push(createChromePart(type, this.takenPartIds()));
      this.writeParts(region, parts);
      const key = add === "" ? String(list.length - 1) : `${add}.${list.length - 1}`;
      this.regionRoot(region)
        ?.querySelector<HTMLElement>(`[data-chrome-part-row="${chromeKey(key)}"] input, [data-chrome-part-row="${chromeKey(key)}"] select`)
        ?.focus();
      return;
    }
    const move = target.closest?.<HTMLElement>("[data-chrome-move]")?.dataset.chromeMove;
    if (move !== undefined) {
      const [key, delta] = move.split(":");
      const parts = this.draftParts(region);
      const at = key !== undefined ? chromeListAt(parts, key) : undefined;
      const next = at ? at.index + Number(delta) : -1;
      if (at && next >= 0 && next < at.list.length) {
        const [part] = at.list.splice(at.index, 1);
        at.list.splice(next, 0, part!);
        this.writeParts(region, parts);
        // Focus follows the part to its new row: the same arrow, or — at the end of the list,
        // where that arrow is disabled — the one that brings it back.
        const movedKey = key!.replace(/\d+$/, String(next));
        const root = this.regionRoot(region);
        const same = root?.querySelector<HTMLButtonElement>(`[data-chrome-move="${chromeKey(`${movedKey}:${delta}`)}"]`);
        const back = root?.querySelector<HTMLButtonElement>(`[data-chrome-move="${chromeKey(`${movedKey}:${-Number(delta)}`)}"]`);
        (same && !same.disabled ? same : back)?.focus();
      }
      return;
    }
    const remove = target.closest?.<HTMLElement>("[data-chrome-remove]")?.dataset.chromeRemove;
    if (remove !== undefined) {
      const parts = this.draftParts(region);
      const at = chromeListAt(parts, remove);
      if (at) {
        at.list.splice(at.index, 1);
        this.writeParts(region, parts);
        this.regionRoot(region)?.querySelector<HTMLElement>("[data-chrome-add='']")?.focus();
      }
    }
  }

  private handleInput(target: HTMLInputElement | HTMLTextAreaElement): void {
    const region = this.ctrl ? this.regionOf(target) : undefined;
    const key = target.dataset.chromeRow;
    const field = target.dataset.chromeField;
    if (!region || key === undefined || !field || field === "hideLabel") {
      return;
    }
    const parts = this.draftParts(region);
    const part = chromePartAt(parts, key) as unknown as Record<string, unknown> | undefined;
    if (!part) {
      return;
    }
    if (field === "width" || field === "height") {
      const size = Math.floor(Number(target.value));
      if (target.value.trim().length > 0 && Number.isFinite(size) && size >= 1) {
        part[field] = size;
      } else {
        delete part[field];
      }
      this.writeParts(region, parts);
      return;
    }
    // The default-language string; an optional text emptied is no text at all.
    const optional = field === "label" || field === "alt" || field === "href";
    if (target.value.length === 0 && optional) {
      delete part[field];
    } else {
      part[field] = target.value;
    }
    this.writeParts(region, parts, { live: true });
  }

  private handleChange(target: HTMLInputElement | HTMLSelectElement): void {
    const region = this.ctrl ? this.regionOf(target) : undefined;
    const key = target.dataset.chromeRow;
    const field = target.dataset.chromeField;
    if (!region || key === undefined || !field) {
      return;
    }
    const parts = this.draftParts(region);
    if (field === "type") {
      const at = chromeListAt(parts, key);
      const previous = at?.list[at.index];
      if (at && previous && previous.type !== target.value) {
        // The part keeps its id: its translations are keyed by it, and a retyped part is the same part.
        const fresh = { ...createChromePart(target.value as FormChromePartType), id: previous.id } as FormChromePart;
        at.list[at.index] = previous.align ? { ...fresh, align: previous.align } : fresh;
        this.writeParts(region, parts);
      }
      return;
    }
    const part = chromePartAt(parts, key) as unknown as Record<string, unknown> | undefined;
    if (!part) {
      return;
    }
    if (field === "hideLabel") {
      if ((target as HTMLInputElement).checked) {
        part.hideLabel = true;
      } else {
        delete part.hideLabel;
      }
      this.writeParts(region, parts);
      return;
    }
    if (field === "align" || field === "justify" || field === "verticalAlign" || field === "level") {
      if (target.value === "") {
        delete part[field];
      } else {
        part[field] = field === "level" ? Number(target.value) : target.value;
      }
      this.writeParts(region, parts);
    }
  }
}

export function defineBuilderChromePanel(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_BUILDER_CHROME_PANEL_TAG)) {
    customElements.define(DATUM_BUILDER_CHROME_PANEL_TAG, DatumBuilderChromePanelElement);
  }
}
