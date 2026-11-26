/**
 * The Form fields panel: the form's own fields beside the step the
 * Journeys workspace's Step view is drawing. The strip offers it only while that view is up
 * (`BuilderModeFormFields.offered`). It lists the form's fields in form order, in two groups:
 * "Not on a step" first, then "On a step" with the name of each step asking the field. A click
 * or a drag puts a field on the step shown, as a placement in one undo step; a field already on
 * this step is shown as such and is not offered again.
 *
 * The data and the placement are the mode's (`BuilderMode.formFields`); the panel only draws and
 * asks. It follows the builder panel paint contract: the shell of the panel (heading, filter
 * box) is written once, so typing in the box never loses its caret, and the list repaints only
 * when what it would draw changed (the rows, the filter, the words), not on every controller
 * change a draft keystroke elsewhere brings.
 */
import { canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import { writeDragPayload } from "../drag-drop/html5-drag-drop.js";
import { BuilderWords, type BuilderTextCatalog } from "../logic/builder-texts.js";
import type { BuilderChangeReason } from "../controller/builder-controller.js";
import type { BuilderModeFormFieldRow, BuilderModeFormFields } from "./builder-modes.js";
import { BuilderPanelElement } from "./builder-panels.js";
import { builderTokens, esc } from "./builder-shared.js";

export const DATUM_BUILDER_FORM_FIELDS_TAG = "datum-builder-form-fields";

const FORM_FIELDS_STYLES = `
  .panel { font-size: var(--db-text-md); }
  .fields-filter { width: 100%; margin-top: var(--db-space-3); }
  /* The list's groups and notes are cards of the panel's own stack. */
  .fields-list { display: contents; }
  .fields-group { display: flex; align-items: center; gap: var(--db-space-2); margin-bottom: var(--db-space-2); }
  .fields-group .field-tag { margin-inline-start: auto; }
  .fields-rows { margin: 0; padding: 0; list-style: none; }
  .field-row {
    display: flex; align-items: center; gap: var(--db-space-3); box-sizing: border-box; width: 100%; min-height: 40px;
    padding: var(--db-space-1) var(--db-space-2); border: 0; border-radius: var(--db-radius-sm);
    background: transparent; color: var(--db-ink); font: inherit; font-weight: 500; text-align: start; cursor: pointer;
  }
  .field-row:hover { background: var(--db-surface-hover); }
  .field-row:focus-visible { outline: 2px solid var(--db-focus); outline-offset: -2px; }
  .field-row[aria-disabled="true"] { cursor: default; color: var(--db-ink-muted); }
  .field-row[aria-disabled="true"]:hover { background: transparent; }
  .field-glyph { flex: none; inline-size: 16px; block-size: 16px; color: var(--db-accent-text); fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .field-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .field-tag { flex: none; display: inline-flex; align-items: center; max-inline-size: 45%; min-block-size: 20px; padding: 0 var(--db-space-2); border-radius: var(--db-radius-pill); background: var(--db-surface-sunken); color: var(--db-ink-muted); font-size: var(--db-text-xs); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fields-note { margin: 0; color: var(--db-ink-muted); font-size: var(--db-text-sm); }
  .sr-only { position: absolute; inline-size: 1px; block-size: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;

/** A field's glyph: an input box, the one drawing every row carries. */
const FIELD_GLYPH = `<svg class="field-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="5" width="12" height="6" rx="1.5"></rect><path d="M5 8h1"></path></svg>`;

export class DatumBuilderFormFieldsElement extends BuilderPanelElement {
  private readonly words = new BuilderWords();
  private source: BuilderModeFormFields | undefined;
  private unsubscribe: (() => void) | undefined;
  private filter = "";
  /** Whether the panel's shell (heading, filter box, list) is in the root as of these words and icons. */
  private built = false;
  /**
   * Whether the root's listeners are on. The root outlives every rebuild of the shell (a change
   * of the builder's language, catalog or icons writes the shell again), so they are added once:
   * a second set would place a pressed field twice and step the history twice per Ctrl+Z.
   */
  private bound = false;
  /** What the list last drew, so a paint that would look the same writes nothing. */
  private signature: string | undefined;

  /** The builder's own language for its words, not the form's. */
  public set textLocale(value: string | undefined) {
    if (this.words.locale !== value) {
      this.words.locale = value;
      this.built = false;
      this.paint();
    }
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. */
  public set textCatalog(value: BuilderTextCatalog | undefined) {
    if (this.words.catalog !== value) {
      this.words.catalog = value;
      this.built = false;
      this.paint();
    }
  }

  /**
   * Where the rows come from and where a click goes: the mode's `formFields`. Assigning another
   * source (or none, on a mode with none) drops the old one's subscription.
   */
  public set fields(value: BuilderModeFormFields | undefined) {
    if (value === this.source) {
      return;
    }
    this.unsubscribe?.();
    this.source = value;
    this.unsubscribe = value?.subscribe(() => this.paint());
    this.signature = undefined;
    this.paint();
  }

  public get fields(): BuilderModeFormFields | undefined {
    return this.source;
  }

  // The rows come from the mode, not from the controller: a draft keystroke or a selection elsewhere changes none of them.
  protected override onControllerChange(_reason: BuilderChangeReason): void {}
  protected override onSelectionChange(): void {}

  protected override onIconsChange(): void {
    this.built = false;
    this.paint();
  }

  protected render(): void {
    if (!this.built) {
      this.build();
    }
    const list = this.root.querySelector<HTMLElement>("[data-fields-list]");
    if (!list) {
      return;
    }
    const rows = this.source?.rows() ?? [];
    // A step that takes no field (Check answers, exit): said above the list, and no row offered.
    const refusal = this.source?.refusal?.();
    // What the list would draw: the step names of a field on this step are not drawn (it says "On this step"),
    // so a title typed on the step shown is no reason to draw again.
    const signature = JSON.stringify([rows.map((row) => [row.id, row.label, row.required, row.where, row.where === "here" ? [] : row.steps]), this.filter, refusal ?? null]);
    if (signature === this.signature) {
      return;
    }
    this.signature = signature;
    // Focus is on a row when it was pressed: the repaint puts it back on that field's row, which has moved groups.
    const focused = (this.root.activeElement as HTMLElement | null)?.closest?.<HTMLElement>("[data-field-add]")?.dataset.fieldAdd;
    list.innerHTML = `${refusal !== undefined && rows.length > 0 ? `<p class="card fields-note" data-fields-refused>${esc(refusal)}</p>` : ""}${this.listHtml(rows, refusal !== undefined)}`;
    if (focused !== undefined) {
      [...this.root.querySelectorAll<HTMLElement>("[data-field-add]")].find((row) => row.dataset.fieldAdd === focused)?.focus();
    }
  }

  /** The panel's shell: written once per set of words, so the filter box keeps its caret as the list repaints. */
  private build(): void {
    this.built = true;
    this.signature = undefined;
    this.root.innerHTML = `
      <style>${builderTokens()}${FORM_FIELDS_STYLES}${this.iconCss()}</style>
      <div class="panel card-stack">
        <div class="card is-pinned"><h2 class="card-title">${esc(this.words.text("shell.fields.title"))}</h2><input class="fields-filter" type="search" data-fields-filter placeholder="${esc(this.words.text("shell.fields.filter.placeholder"))}" aria-label="${esc(this.words.text("shell.fields.filter.label"))}" value="${esc(this.filter)}" autocomplete="off" spellcheck="false"></div>
        <div class="fields-list" data-fields-list></div>
        <div class="sr-only" role="status" aria-live="polite" data-fields-status></div>
      </div>`;
    this.bind();
  }

  private shows(row: BuilderModeFormFieldRow): boolean {
    const wanted = this.filter.trim().toLowerCase();
    return wanted === "" || row.label.toLowerCase().includes(wanted) || row.id.toLowerCase().includes(wanted);
  }

  private rowHtml(row: BuilderModeFormFieldRow, refused: boolean): string {
    const here = row.where === "here";
    const offered = !here && !refused;
    const label = `${esc(row.label)}${row.required ? ` <span aria-hidden="true">*</span><span class="sr-only"> (${esc(this.words.text("shell.fields.required"))})</span>` : ""}`;
    const tag = row.where === "none" ? "" : `<span class="field-tag">${esc(here ? this.words.text("shell.fields.here") : row.steps.join(", "))}</span>`;
    return `<li><button type="button" class="field-row" data-field-add="${esc(row.id)}" data-where="${row.where}"${offered ? ' draggable="true"' : ' aria-disabled="true"'}${
      here ? ` title="${esc(this.words.text("shell.fields.here"))}"` : offered ? ` title="${esc(this.words.text("shell.fields.add", { field: row.label }))}"` : ""
    }>${FIELD_GLYPH}<span class="field-label">${label}</span>${tag}</button></li>`;
  }

  private listHtml(rows: readonly BuilderModeFormFieldRow[], refused: boolean): string {
    if (rows.length === 0) {
      return `<div class="card empty-state" data-fields-empty><p>${esc(this.words.text("shell.fields.empty"))}</p></div>`;
    }
    const shown = rows.filter((row) => this.shows(row));
    if (shown.length === 0) {
      return `<p class="card fields-note" data-fields-none>${esc(this.words.text("shell.fields.none"))}</p>`;
    }
    const group = (id: "none" | "on", title: string, held: readonly BuilderModeFormFieldRow[]): string =>
      held.length === 0
        ? ""
        : `<section class="card" data-fields-group="${id}"><h3 class="card-heading fields-group"><span>${esc(title)}</span><span class="field-tag">${held.length}</span></h3><ul class="fields-rows">${held.map((row) => this.rowHtml(row, refused)).join("")}</ul></section>`;
    const unplaced = shown.filter((row) => row.where === "none");
    const placed = shown.filter((row) => row.where !== "none");
    return [group("none", this.words.text("shell.fields.notPlaced"), unplaced), group("on", this.words.text("shell.fields.placed"), placed)].join("");
  }

  private bind(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.root.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      if (target?.dataset?.fieldsFilter === undefined) {
        return;
      }
      // Only the list is drawn again, never the box being typed into.
      this.filter = target.value;
      this.paint();
    });
    this.root.addEventListener("click", (event) => {
      const row = (event.target as Element).closest?.<HTMLElement>("[data-field-add]");
      const id = row?.dataset.fieldAdd;
      if (!row || id === undefined || row.getAttribute("aria-disabled") === "true") {
        return;
      }
      const field = this.source?.rows().find((entry) => entry.id === id);
      if (this.source?.add(id) === true && field) {
        const status = this.root.querySelector<HTMLElement>("[data-fields-status]");
        if (status) {
          status.textContent = this.words.text("shell.fields.added", { field: field.label });
        }
      }
    });
    this.root.addEventListener("dragstart", (event) => {
      const dragEvent = event as DragEvent;
      const dt = dragEvent.dataTransfer;
      const item = (dragEvent.target as Element).closest?.<HTMLElement>("[data-field-add]");
      const id = item?.dataset.fieldAdd;
      const drag = id !== undefined ? this.source?.drag(id) : undefined;
      if (!dt || !item || !drag || item.getAttribute("aria-disabled") === "true") {
        return;
      }
      // A new placement of the field, as the palette's drag of a type is: the canvas's drop makes the node.
      writeDragPayload(dt, { kind: "template-component", component: { id: "", type: drag.type, configuration: drag.configuration } });
      if (typeof dt.setDragImage === "function") {
        dt.setDragImage(item, 12, 12);
      }
    });
    this.root.addEventListener("keydown", (event) => {
      const keyEvent = event as KeyboardEvent;
      if ((keyEvent.metaKey || keyEvent.ctrlKey) && keyEvent.key.toLowerCase() === "z") {
        keyEvent.preventDefault();
        // Through the shell's one Undo: the Step view undoes over the form and the journey.
        this.stepHistory(keyEvent.shiftKey ? "redo" : "undo");
      }
    });
  }
}

export function defineBuilderFormFields(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_BUILDER_FORM_FIELDS_TAG)) {
    customElements.define(DATUM_BUILDER_FORM_FIELDS_TAG, DatumBuilderFormFieldsElement);
  }
}
