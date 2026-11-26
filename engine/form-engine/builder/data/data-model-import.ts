/**
 * Building a form from a data model: read a pasted or opened JSON sample or JSON
 * Schema, lay the model it implies over the form's — what is new, what the form already holds,
 * what it holds as something else — and build: Add missing fields, or Replace form contents,
 * each one undo step.
 *
 * The Data workspace's Import dialog draws the frame this module writes and hands its events to a
 * {@link DataModelImporter}; the importer keeps the text, reads it, and asks its host to repaint.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import type { BuilderController, InsertComponentsResult } from "../controller/builder-controller.js";
import { esc } from "../web-component/builder-shared.js";
import { childrenOf, type DataModel, type DataModelNode, type DataModelNote } from "../data-model/data-model.js";
import { dataModelFromForm } from "../data-model/from-form.js";
import { MAX_DATA_MODEL_INPUT, readDataModelInput, type DataModelReadAs, type DataModelSourceKind, type ReadDataModelResult } from "../data-model/read-input.js";
import { compareDataModels, type DataModelComparison, type DataModelComparisonEntry } from "../data-model/compare.js";
import { planAddMissing, planReplace, type SkippedPlace } from "../data-model/generate.js";
import { mappingFor } from "../data-model/mapping.js";
import type { BuilderWords } from "../logic/builder-texts.js";
import { areaWords } from "./data-texts-en.js";
// The planner's pieces without the DOM: the browser-assistant tools load the
// same module, so a field they build from a sample is the one Add missing fields builds here.
import { dataModelClassifier, dataModelGenerateOptions, formDataModel } from "./data-model-plan.js";

export { formDataModel } from "./data-model-plan.js";

/** Detail of `builder-data-model-apply`: what a build did. */
export interface BuilderDataModelApplyDetail {
  action: "build" | "add-missing" | "replace";
  /** What the model was read from. */
  source: DataModelSourceKind;
  /** The top-level components placed. */
  ids: string[];
  /** Places nothing was built for, and why. */
  skipped: SkippedPlace[];
}

export const DATA_MODEL_INPUT_PLACEHOLDER = `{
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "address": { "street": "1 Main St", "city": "London" },
  "items": [{ "sku": "A-1", "qty": 2 }]
}`;

/** Words in English, for a caller that passes none. */
const ENGLISH_WORDS = areaWords();

/**
 * The look of the import's frame and of a model's rows, on the studio tokens: the body a
 * scrolling column, the text box monospaced, a place per row with its chips.
 */
export const DATA_MODEL_IMPORT_STYLES = `
  .dm-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--db-space-3); }
  .dm-intro, .dm-hint { margin: 0; color: var(--db-ink-muted); font-size: var(--db-text-sm); line-height: 1.4; }
  .dm-toolbar { display: flex; gap: var(--db-space-2); align-items: center; flex-wrap: wrap; }
  .dm-toolbar > * { min-width: 0; }
  .dm-filter { flex: 1 1 120px; }
  /* The boxes are the shared ones (the 14px text box, the focus ring); the paste box adds its height and the code face. */
  .dm-body input[type="search"]::placeholder, .dm-input::placeholder { color: var(--db-ink-subtle); }
  .dm-input { width: 100%; min-height: 140px; resize: vertical; font-family: var(--db-font-mono); line-height: 1.45; white-space: pre; overflow: auto; }
  .dm-input[aria-invalid="true"] { border-color: var(--db-danger-line); }
  .dm-label { display: inline-flex; align-items: center; gap: var(--db-space-2); font-size: var(--db-text-sm); font-weight: 500; color: var(--db-ink-muted); }
  .dm-error { margin: 0; color: var(--db-danger); font-size: var(--db-text-sm); }
  .dm-error:empty { display: none; }
  .dm-results { display: flex; flex-direction: column; gap: var(--db-space-2); min-height: 0; }
  .dm-counts { margin: 0; font-size: var(--db-text-sm); color: var(--db-ink); }
  .dm-rows { list-style: none; margin: 0; padding: 0; }
  .dm-rows li[hidden] { display: none; }
  /* A place per row, over a divider; nested places indent. The selected component's row takes the selected tint. */
  .dm-row {
    padding-block: var(--db-space-2); padding-inline: calc(var(--dm-depth, 0) * 14px + var(--db-space-1)) var(--db-space-1);
    border-bottom: var(--db-border-w) solid var(--db-line-divider);
  }
  .dm-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-1) var(--db-space-2); }
  .dm-key {
    font-family: var(--db-font-mono); font-size: var(--db-text-sm); color: var(--db-ink);
    word-break: break-all; background: none; border: none; padding: 0; text-align: start;
  }
  button.dm-key { min-height: 24px; cursor: pointer; text-decoration: underline; text-decoration-color: var(--db-line-divider); text-underline-offset: 2px; border-radius: var(--db-radius-xs); }
  button.dm-key:hover { color: var(--db-accent-text); text-decoration-color: currentColor; }
  button.dm-key:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
  .dm-row[aria-current="true"] { background: var(--db-accent-soft); border-radius: var(--db-radius-sm); }
  /* Chips: the sunken well, muted; New in the accent tint, a problem in the error wash, approximate in the warning wash. */
  .dm-chip {
    display: inline-flex; align-items: center;
    font-size: var(--db-text-xs); font-weight: 500; line-height: 20px; padding: 0 var(--db-space-2); border-radius: var(--db-radius-pill);
    color: var(--db-ink-muted); background: var(--db-surface-sunken); white-space: nowrap;
  }
  .dm-chip--new { color: var(--db-accent-text); background: var(--db-accent-soft); }
  .dm-chip--differs, .dm-chip--problem { color: var(--db-danger); background: var(--db-danger-soft); }
  .dm-chip--approx { color: var(--db-warn); background: var(--db-warn-soft); }
  .dm-required { color: var(--db-danger); font-size: var(--db-text-xs); font-weight: 500; }
  .dm-text { font-size: var(--db-text-xs); color: var(--db-ink-muted); }
  .dm-notes { list-style: none; margin: var(--db-space-1) 0 0; padding: 0; }
  .dm-note { font-size: var(--db-text-sm); color: var(--db-ink-muted); line-height: 1.35; }
  .dm-note--warning { color: var(--db-warn); }
  .dm-model-notes { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--db-space-1); }
  .dm-actions { display: flex; gap: var(--db-space-2); flex-wrap: wrap; align-items: center; }
  .dm-note-line { margin: 0; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  .dm-only summary { min-height: 24px; cursor: pointer; font-size: var(--db-text-sm); font-weight: 600; color: var(--db-ink-muted); letter-spacing: .02em; }
  .dm-only summary:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
  .dm-status-line { margin: 0; font-size: var(--db-text-sm); color: var(--db-ink); }
  .dm-status-line:empty { display: none; }
  .dm-file { display: none; }
`;

// --- a model's places, in words and rows -------------------------------------------

/** The words for what sits at a place. */
export function dataModelKindText(node: DataModelNode, words: BuilderWords = ENGLISH_WORDS): string {
  switch (node.kind) {
    case "string":
      switch (node.format) {
        case "date":
          return words.text("dataModel.kind.date");
        case "date-time":
          return words.text("dataModel.kind.dateTime");
        case "time":
          return words.text("dataModel.kind.time");
        case "email":
          return words.text("dataModel.kind.email");
        case "uri":
          return words.text("dataModel.kind.uri");
        case "multiline":
          return words.text("dataModel.kind.longText");
        default:
          return words.text(node.options ? "dataModel.kind.choice" : "dataModel.kind.text");
      }
    case "number":
      return words.text(node.options ? "dataModel.kind.numberChoice" : "dataModel.kind.number");
    case "integer":
      return words.text(node.options ? "dataModel.kind.wholeChoice" : "dataModel.kind.whole");
    case "boolean":
      return words.text("dataModel.kind.yesNo");
    case "object":
      return words.text(node.format === "flags" ? "dataModel.kind.flags" : "dataModel.kind.object");
    case "array":
      if (!node.items) {
        return words.text("dataModel.kind.list");
      }
      return node.items.kind === "object" ? words.text("dataModel.kind.entries") : words.text("dataModel.kind.listOf", { kind: dataModelKindText(node.items, words) });
    case "file":
      return words.text("dataModel.kind.file");
    case "null":
      return words.text("dataModel.kind.null");
    default:
      return words.text("dataModel.kind.any");
  }
}

export function dataModelNotesHtml(notes: readonly DataModelNote[] | undefined): string {
  if (!notes || notes.length === 0) {
    return "";
  }
  return `<ul class="dm-notes">${notes.map((note) => `<li class="dm-note dm-note--${note.level}">${esc(note.message)}</li>`).join("")}</ul>`;
}

/** What a row's filter matches: its path, label, component and kind. */
export function dataModelSearchText(node: DataModelNode, words: BuilderWords = ENGLISH_WORDS): string {
  return [node.path, node.label, node.componentId, node.componentType, dataModelKindText(node, words)].filter(Boolean).join(" ").toLowerCase();
}

export function isDataModelProblem(note: DataModelNote): boolean {
  return note.code === "duplicate-path" || note.code === "path-conflict" || note.code === "invalid-key";
}

/** Whether the form has any place in its data at all. */
export function dataModelHasPlaces(model: DataModel): boolean {
  return (model.root.children ?? []).length > 0;
}

/** Every place of a model as a row, with its depth; a list's entry node adds no row of its own. */
export function* dataModelPlaces(model: DataModel): Generator<{ node: DataModelNode; depth: number }> {
  const walk = function* (node: DataModelNode, depth: number): Generator<{ node: DataModelNode; depth: number }> {
    for (const child of childrenOf(node)) {
      if (child.key === "") {
        yield* walk(child, depth);
        continue;
      }
      yield { node: child, depth };
      // A checkboxes group's options are its value, not places of their own.
      if (child.format !== "flags") {
        yield* walk(child, depth + 1);
      }
    }
  };
  yield* walk(model.root, 0);
}

/** A form's place as a row; with `selectable`, its key is a button that selects its component. */
export function dataModelRowHtml(node: DataModelNode, depth: number, selectable: boolean, selected: string | undefined, words: BuilderWords = ENGLISH_WORDS): string {
  const canSelect = selectable && node.componentId !== undefined;
  const key = canSelect
    ? `<button type="button" class="dm-key" data-model-select="${esc(node.componentId!)}" title="${esc(words.text("dataModel.select", { id: node.componentId! }))}">${esc(node.key)}</button>`
    : `<code class="dm-key">${esc(node.key)}</code>`;
  const problem = node.notes?.some(isDataModelProblem) ?? false;
  const required = node.required ? `<span class="dm-required">${esc(words.text("dataModel.required"))}</span>` : node.requiredWhen ? `<span class="dm-required">${esc(words.text("dataModel.requiredWhen"))}</span>` : "";
  const id = node.componentId !== undefined && node.componentId !== node.key ? `<span class="dm-text">${words.html("dataModel.idLabel", { id: `<code>${esc(node.componentId)}</code>` })}</span>` : "";
  const type = node.componentType ? `<span class="dm-text">${esc(node.componentType)}</span>` : node.implicit ? `<span class="dm-text">${esc(words.text("dataModel.noContainer"))}</span>` : "";
  return `<li class="dm-row" data-model-row="${esc(node.path)}" data-model-search="${esc(dataModelSearchText(node, words))}" style="--dm-depth: ${depth}"${node.componentId !== undefined && node.componentId === selected ? ' aria-current="true"' : ""}>
      <div class="dm-line">${key}<span class="dm-chip${problem ? " dm-chip--problem" : ""}">${esc(dataModelKindText(node, words))}</span>${required}${node.label ? `<span class="dm-text">${esc(node.label)}</span>` : ""}${id}${type}</div>
      ${dataModelNotesHtml(node.notes)}
    </li>`;
}

// --- what a build places ------------------------------------------------------------
//
// The form's model (`formDataModel`), how a type the engine does not know takes part
// (`dataModelClassifier`) and what a build may use (`dataModelGenerateOptions`) live in
// `data-model-plan.ts`, imported above.

function trailingButtonCount(content: readonly ComponentNode[]): number {
  let count = 0;
  for (let index = content.length - 1; index >= 0 && content[index]!.type === "button"; index -= 1) {
    count += 1;
  }
  return count;
}

// --- focus across a results repaint -------------------------------------------------

/** The results' buttons a repaint puts focus back on, by their data attribute. */
export const DATA_MODEL_IMPORT_FOCUS_KEYS = ["modelAdd", "modelBuild", "modelReplace", "modelReplaceCancel", "modelReplaceConfirm"] as const;

/** Which of `names` the focused button in `[data-model-results]` carries, as `name=value`. */
export function focusedResultsKey(scope: ParentNode, active: Element | null, names: readonly string[]): string | undefined {
  const region = scope.querySelector("[data-model-results]");
  if (!(active instanceof HTMLElement) || !region?.contains(active)) {
    return undefined;
  }
  for (const name of names) {
    if (active.dataset[name] !== undefined) {
      return `${name}=${active.dataset[name]}`;
    }
  }
  return undefined;
}

/** Focuses the results' button {@link focusedResultsKey} named, when the repaint drew it again. */
export function restoreResultsFocus(scope: ParentNode, key: string | undefined): void {
  if (!key) {
    return;
  }
  const [name, value] = key.split("=") as [string, string];
  for (const candidate of scope.querySelectorAll<HTMLElement>("[data-model-results] button")) {
    if (candidate.dataset[name] === value) {
      candidate.focus();
      return;
    }
  }
}

// --- the importer -------------------------------------------------------------------

/** Where an importer draws, and what it asks of the element around it. */
export interface DataModelImporterHost {
  /** The form's controller, or none. */
  controller(): BuilderController | undefined;
  /** The builder's words, in the locale and catalog the host set; English when a host sets none. */
  words?(): BuilderWords;
  /** Whether a build may run: on the form's own controller only. */
  canBuild(): boolean;
  /** Whether the rows of what is on the form only select their component (the panel's do, beside the canvas). */
  selectsRows(): boolean;
  /** Where the frame ({@link DataModelImporter.frameHtml}) is drawn. */
  scope(): ParentNode | null | undefined;
  /** A repaint: the host calls {@link DataModelImporter.sync} and redraws the results if they changed. */
  paint(): void;
  /** Reads a line out through the host's live region. */
  announce(text: string): void;
  /** A build placed components (or found nothing to place): the host tells the page. */
  built(detail: BuilderDataModelApplyDetail, message: string): void;
}

/**
 * The import's state and behaviour: the text box's text (kept across repaints, not across
 * sessions), how it is read, the confirm Replace asks for, and the line the last build left.
 * Typing reads the text after a pause, so the results trail the box a little.
 */
export class DataModelImporter {
  /** The text box's content. */
  public text = "";
  /** The line under the box the last build or failed read left, until the form next changes. */
  public statusText = "";
  /** Whether Replace form contents is asking to be confirmed. */
  public confirmingReplace = false;
  private readAsValue: DataModelReadAs = "auto";
  private readText = "";
  private readCache: { key: string; result: ReadDataModelResult } | undefined;
  private readTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(private readonly host: DataModelImporterHost) {}

  /** How the text is read: as detected, or as a sample or a schema outright. */
  public get readAs(): DataModelReadAs {
    return this.readAsValue;
  }

  public set readAs(value: DataModelReadAs) {
    if (value === this.readAsValue || (value !== "auto" && value !== "sample" && value !== "schema")) {
      return;
    }
    this.readAsValue = value;
    this.confirmingReplace = false;
    this.host.paint();
  }

  private get words(): BuilderWords {
    return areaWords(this.host.words?.() ?? ENGLISH_WORDS);
  }

  /** Sets the text and reads it at once, as a paste followed by a pause would. */
  public setText(value: string): void {
    this.text = value;
    this.readText = value;
    this.confirmingReplace = false;
    const box = this.host.scope()?.querySelector<HTMLTextAreaElement>("[data-model-input]");
    if (box && box.value !== value) {
      box.value = value;
    }
    this.host.paint();
  }

  /** What the text reads as; none while it is empty. */
  public result(): ReadDataModelResult | undefined {
    if (this.readText.trim() === "") {
      return undefined;
    }
    const key = `${this.readAsValue}\u0000${this.words.locale ?? ""}\u0000${this.readText}`;
    if (this.readCache?.key !== key) {
      this.readCache = { key, result: readDataModelInput(this.readText, this.readAsValue, this.words) };
    }
    return this.readCache.result;
  }

  /** The text's model laid over the form's; none until the text reads. */
  public comparison(): DataModelComparison | undefined {
    const controller = this.host.controller();
    const read = this.result();
    if (!controller || !read?.ok) {
      return undefined;
    }
    return compareDataModels(formDataModel(controller), read.model, { hasType: (type) => controller.hasComponentType(type) });
  }

  // --- drawing --------------------------------------------------------------------

  /** The frame: what stays put while the results change. `errorId` names the read error for the box. */
  public frameHtml(errorId: string): string {
    const w = this.words;
    return `<p class="dm-intro">${esc(w.text("data.import.intro"))}</p>
      <textarea class="dm-input" data-model-input spellcheck="false" autocomplete="off" aria-label="${esc(w.text("data.import.input"))}" aria-describedby="${errorId}" placeholder="${esc(DATA_MODEL_INPUT_PLACEHOLDER)}">${esc(this.text)}</textarea>
      <div class="dm-toolbar">
        <button type="button" class="btn" data-model-open>${esc(w.text("data.import.open"))}</button>
        <input type="file" class="dm-file" data-model-file accept=".json,application/json,application/schema+json" tabindex="-1" aria-hidden="true" />
        <button type="button" class="btn" data-model-clear>${esc(w.text("data.import.clear"))}</button>
        <label class="dm-label">${esc(w.text("data.import.readAs"))} <select data-model-read-as aria-label="${esc(w.text("data.import.readAs.label"))}">
          <option value="auto">${esc(w.text("data.import.auto"))}</option>
          <option value="sample">${esc(w.text("data.import.sample"))}</option>
          <option value="schema">${esc(w.text("data.import.schema"))}</option>
        </select></label>
      </div>
      <p class="dm-error" id="${errorId}" data-model-input-error></p>
      <p class="dm-status-line" data-model-status-line></p>
      <div class="dm-results" data-model-results></div>`;
  }

  /** The frame's small moving parts, set in place: never a rewrite of the text box. */
  public sync(): void {
    const scope = this.host.scope();
    if (!scope) {
      return;
    }
    const statusLine = scope.querySelector<HTMLElement>("[data-model-status-line]");
    if (statusLine && statusLine.textContent !== this.statusText) {
      statusLine.textContent = this.statusText;
    }
    const readAs = scope.querySelector<HTMLSelectElement>("[data-model-read-as]");
    if (readAs) {
      if (readAs.value !== this.readAsValue) {
        readAs.value = this.readAsValue;
      }
      const read = this.result();
      const auto = readAs.querySelector<HTMLOptionElement>('option[value="auto"]');
      const label = read?.ok ? this.words.text("data.import.autoDetected", { kind: read.detected === "schema" ? this.words.text("data.import.schema") : this.words.text("data.import.sampleKind") }) : this.words.text("data.import.auto");
      if (auto && auto.textContent !== label) {
        auto.textContent = label;
      }
    }
    const error = scope.querySelector<HTMLElement>("[data-model-input-error]");
    if (error) {
      const read = this.result();
      const message = read && !read.ok && !read.empty ? `${read.error ?? this.words.text("data.import.cannotRead")}${read.line !== undefined ? ` ${this.words.text("data.import.lineColumn", { line: read.line, column: read.column ?? 1 })}` : ""}` : "";
      if (error.textContent !== message) {
        error.textContent = message;
      }
      scope.querySelector<HTMLTextAreaElement>("[data-model-input]")?.setAttribute("aria-invalid", message === "" ? "false" : "true");
    }
  }

  /** The results under the frame, with a key that changes only when what they show does. */
  public results(): { key: string; html: string } {
    const controller = this.host.controller();
    if (!controller) {
      return { key: "", html: "" };
    }
    const read = this.result();
    const form = formDataModel(controller);
    const canBuild = this.host.canBuild();
    const key = JSON.stringify(["import", this.words.locale ?? "", canBuild, this.host.selectsRows(), this.confirmingReplace, this.readAsValue, this.readText, form]);
    if (!read || !read.ok) {
      return { key, html: "" };
    }
    const comparison = compareDataModels(form, read.model, { hasType: (type) => controller.hasComponentType(type) });
    const incoming = comparison.entries.filter((entry) => entry.status !== "form-only");
    const formOnly = comparison.entries.filter((entry) => entry.status === "form-only");
    const places = incoming.length;
    const counts = comparison.counts;
    const w = this.words;
    const summary = [
      w.plural("dataModel.places", places),
      w.text("data.import.summary.new", { count: counts.new }),
      w.text("data.import.summary.present", { count: counts.present }),
      ...(counts["kind-differs"] > 0 ? [w.text("data.import.summary.differs", { count: counts["kind-differs"] })] : []),
      ...(counts.unsupported > 0 ? [w.text("data.import.summary.unsupported", { count: counts.unsupported })] : [])
    ].join(w.text("data.import.sep"));
    const modelNotes =
      read.model.notes.length > 0
        ? `<ul class="dm-model-notes">${read.model.notes.map((note) => `<li class="dm-note dm-note--${note.level}">${esc(note.message)}</li>`).join("")}</ul>`
        : "";
    const rows = incoming.map((entry) => this.rowHtml(controller, entry)).join("");
    const only =
      formOnly.length > 0
        ? `<details class="dm-only"><summary>${esc(w.text("data.import.onFormOnly", { count: formOnly.length }))}</summary><ul class="dm-rows">${formOnly
            .map((entry) => dataModelRowHtml(entry.form!, 0, this.host.selectsRows(), undefined, w))
            .join("")}</ul></details>`
        : "";
    return { key, html: `${modelNotes}<p class="dm-counts" data-model-counts>${esc(w.text("data.import.summary", { summary }))}</p><ul class="dm-rows" data-model-rows>${rows}</ul>${only}${this.actionsHtml(controller, form, comparison)}` };
  }

  private rowHtml(controller: BuilderController, entry: DataModelComparisonEntry): string {
    const node = entry.incoming!;
    const w = this.words;
    const statusChip =
      entry.status === "new"
        ? `<span class="dm-chip dm-chip--new" data-model-status-chip="new">${esc(w.text("data.import.chip.new"))}</span>`
        : entry.status === "present"
          ? `<span class="dm-chip" data-model-status-chip="present">${esc(w.text("data.import.chip.onForm"))}</span>`
          : `<span class="dm-chip dm-chip--differs" data-model-status-chip="kind-differs">${esc(w.text("data.import.chip.held", { kind: dataModelKindText(entry.form!, w) }))}</span>`;
    const fit =
      entry.status === "new" && entry.fit === "unsupported"
        ? `<span class="dm-chip dm-chip--differs">${esc(w.text("data.import.chip.notBuilt"))}</span>`
        : entry.status === "new" && entry.fit === "approximate"
          ? `<span class="dm-chip dm-chip--approx" title="${esc(w.text("data.import.chip.approxTitle"))}">${esc(w.text("data.import.chip.approx"))}</span>`
          : "";
    const required = node.required ? `<span class="dm-required">${esc(w.text("dataModel.required"))}</span>` : "";
    const hidden = entry.hidden ? `<span class="dm-text">${esc(w.plural("dataModel.hidden", entry.hidden))}</span>` : "";
    const notes = [...(node.notes ?? [])];
    if (entry.status === "new" && entry.fit !== "exact") {
      // Why a new place is approximate or left out: what its mapping says.
      notes.push(...mappingFor(node, (type) => controller.hasComponentType(type), entry.path.includes("[]")).notes);
    }
    return `<li class="dm-row" data-model-row="${esc(entry.path)}" data-model-entry-status="${entry.status}" data-model-search="${esc(dataModelSearchText(node, w))}" style="--dm-depth: ${entry.depth}">
        <div class="dm-line"><code class="dm-key">${esc(node.key)}</code><span class="dm-chip">${esc(dataModelKindText(node, w))}</span>${statusChip}${fit}${required}${node.label ? `<span class="dm-text">${esc(node.label)}</span>` : ""}${hidden}</div>
        ${dataModelNotesHtml(notes)}
      </li>`;
  }

  private actionsHtml(controller: BuilderController, form: DataModel, comparison: DataModelComparison): string {
    const w = this.words;
    if (!this.host.canBuild()) {
      return `<p class="dm-note-line">${esc(w.text("data.import.onlyTab"))}</p>`;
    }
    if (this.confirmingReplace) {
      const content = controller.snapshot().children?.content ?? [];
      const kept = trailingButtonCount(content);
      const removed = content.length - kept;
      // Undo takes the replacement back in one step, so it is asked in place, as every such confirmation is.
      return `<div class="note confirm" data-tone="warning" role="group" aria-label="${esc(w.text("data.import.replace.label"))}" data-model-confirm>
          <p>${esc(w.text("data.import.confirm.lead", { buttons: kept > 0 ? w.text("data.import.confirm.buttons") : "", goes: w.plural("dataModel.goes", removed) }))}</p>
          <p>${esc(w.text("data.import.confirm.undo"))}</p>
          <div class="confirm-actions">
            <button type="button" class="btn small" data-model-replace-cancel>${esc(w.text("data.import.cancel"))}</button>
            <button type="button" class="btn small danger" data-model-replace-confirm>${esc(w.text("data.import.replace"))}</button>
          </div>
        </div>`;
    }
    if (!dataModelHasPlaces(form)) {
      const buildable = comparison.entries.filter((entry) => entry.status === "new" && entry.fit !== "unsupported" && !entry.path.includes(".") && !entry.path.includes("[")).length;
      return `<div class="dm-actions"><button type="button" class="btn primary" data-model-build${buildable === 0 ? " disabled" : ""}>${esc(w.text("data.import.build"))}</button></div>`;
    }
    const top = new Set(comparison.entries.filter((entry) => entry.status === "new").map((entry) => entry.path));
    const addable = comparison.entries.filter((entry) => {
      if (entry.status !== "new" || entry.fit === "unsupported") {
        return false;
      }
      const owner = entry.parentPath.endsWith("[]") ? entry.parentPath.slice(0, -2) : entry.parentPath;
      return !top.has(owner);
    }).length;
    return `<div class="dm-actions">
        <button type="button" class="btn primary" data-model-add${addable === 0 ? " disabled" : ""}>${esc(w.text("data.import.add", { count: addable }))}</button>
        <button type="button" class="btn danger" data-model-replace>${esc(w.text("data.import.replace.open"))}</button>
      </div>`;
  }

  // --- events ---------------------------------------------------------------------

  /** A click on one of the import's buttons; false when the button is not the import's. */
  public click(button: HTMLElement): boolean {
    const data = button.dataset;
    const scope = this.host.scope();
    if (data.modelOpen !== undefined) {
      scope?.querySelector<HTMLInputElement>("[data-model-file]")?.click();
    } else if (data.modelClear !== undefined) {
      this.text = "";
      const box = scope?.querySelector<HTMLTextAreaElement>("[data-model-input]");
      if (box) {
        box.value = "";
        box.focus();
      }
      this.readNow();
    } else if (data.modelBuild !== undefined) {
      this.apply("build");
    } else if (data.modelAdd !== undefined) {
      this.apply("add-missing");
    } else if (data.modelReplace !== undefined) {
      this.confirmingReplace = true;
      this.host.paint();
      this.host.scope()?.querySelector<HTMLElement>("[data-model-replace-cancel]")?.focus();
    } else if (data.modelReplaceCancel !== undefined) {
      this.cancelReplace();
    } else if (data.modelReplaceConfirm !== undefined) {
      this.apply("replace");
    } else {
      return false;
    }
    return true;
  }

  /** Typing in the text box: read after a pause. */
  public input(target: HTMLElement): boolean {
    if (!target.hasAttribute?.("data-model-input")) {
      return false;
    }
    this.text = (target as HTMLTextAreaElement).value;
    this.scheduleRead();
    return true;
  }

  /** A change: the text box left (read now), Read as, a file chosen. */
  public change(target: HTMLElement): boolean {
    if (target.hasAttribute?.("data-model-input")) {
      this.text = (target as HTMLTextAreaElement).value;
      this.readNow();
    } else if (target.hasAttribute?.("data-model-read-as")) {
      this.readAs = (target as HTMLSelectElement).value as DataModelReadAs;
    } else if (target.hasAttribute?.("data-model-file")) {
      this.openFile(target as HTMLInputElement);
    } else {
      return false;
    }
    return true;
  }

  /** Escape inside Replace's confirm takes the confirm back; false when there was none to take back. */
  public escape(target: Element | null): boolean {
    if (!this.confirmingReplace || !target?.closest?.("[data-model-confirm]")) {
      return false;
    }
    this.cancelReplace();
    return true;
  }

  /** The form changed: a build's message would mislead now. */
  public formChanged(): void {
    this.statusText = "";
  }

  public dispose(): void {
    if (this.readTimer !== undefined) {
      clearTimeout(this.readTimer);
      this.readTimer = undefined;
    }
  }

  private cancelReplace(): void {
    this.confirmingReplace = false;
    this.host.paint();
    this.host.scope()?.querySelector<HTMLElement>("[data-model-replace]")?.focus();
  }

  private scheduleRead(): void {
    if (this.readTimer !== undefined) {
      clearTimeout(this.readTimer);
    }
    this.readTimer = setTimeout(() => {
      this.readTimer = undefined;
      this.readNow();
    }, 250);
  }

  private readNow(): void {
    this.dispose();
    if (this.readText === this.text) {
      return;
    }
    this.readText = this.text;
    this.confirmingReplace = false;
    this.statusText = "";
    const read = this.result();
    // Read out, not shown: the counts line under the box already says it.
    const w = this.words;
    this.host.announce(
      read?.ok
        ? w.text("data.import.read.announce", { kind: read.readAs === "schema" ? w.text("data.import.schema") : w.text("data.import.sampleKind"), places: w.plural("dataModel.places", [...dataModelPlaces(read.model)].length) })
        : read && !read.empty
          ? w.text("data.import.read.failed")
          : ""
    );
    this.host.paint();
  }

  private openFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    // Over the cap: said before the file is read into memory, the box and the status line. The
    // cap counts characters and a character is at most four bytes, so only a file past that many
    // bytes is refused here; the exact count is readDataModelInput's, once the text is in.
    if (file.size > MAX_DATA_MODEL_INPUT * 4) {
      this.statusText = this.words.text("dataModel.input.tooBig", { kb: Math.round(file.size / 1024), mb: MAX_DATA_MODEL_INPUT / 1024 / 1024 });
      this.host.announce(this.statusText);
      this.host.paint();
      input.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      this.text = typeof reader.result === "string" ? reader.result : "";
      const box = this.host.scope()?.querySelector<HTMLTextAreaElement>("[data-model-input]");
      if (box) {
        box.value = this.text;
      }
      this.readNow();
    };
    reader.onerror = () => {
      this.statusText = this.words.text("data.import.file.failed", { name: file.name });
      this.host.announce(this.statusText);
      this.host.paint();
    };
    reader.readAsText(file);
    // The same file picked again is a change too.
    input.value = "";
  }

  // --- building -------------------------------------------------------------------

  private apply(action: BuilderDataModelApplyDetail["action"]): void {
    const controller = this.host.controller();
    const read = this.result();
    if (!controller || !read?.ok || !this.host.canBuild()) {
      return;
    }
    const model = read.model;
    const options = dataModelGenerateOptions(controller, this.words);
    const classify = dataModelClassifier(controller);
    let skipped: SkippedPlace[] = [];
    const finish = (result: InsertComponentsResult): void => {
      this.confirmingReplace = false;
      const w = this.words;
      if (result.ok) {
        const placed = result.ids.length;
        const count = w.plural("dataModel.components", placed);
        const left = skipped.length > 0 ? w.text("data.import.leftOut", { count: skipped.length }) : "";
        this.statusText =
          placed === 0
            ? w.text("data.import.nothingToAdd")
            : action === "replace"
              ? w.text("data.import.replaced", { count, left })
              : w.text("data.import.added", { count, left });
        this.host.announce(this.statusText);
        this.host.built({ action, source: read.readAs, ids: result.ids, skipped }, this.statusText);
      } else {
        this.statusText = w.text("data.import.refused", { error: result.error ?? w.text("data.import.refusedDefault") });
        this.host.announce(this.statusText);
      }
      this.host.paint();
    };
    let ran: boolean;
    if (action === "replace") {
      const keep = planReplace(controller.snapshot(), model, options).keep;
      ran = controller.requestReplaceContent(
        () => {
          const plan = planReplace(controller.snapshot(), model, options);
          skipped = plan.skipped;
          return plan.nodes;
        },
        { keep, onResult: finish }
      );
    } else {
      ran = controller.requestInsertComponents(
        () => {
          const committed = controller.snapshot();
          const formModel = dataModelFromForm(committed, { locale: controller.currentLocale(), classify });
          const plan = planAddMissing(committed, formModel, compareDataModels(formModel, model, { hasType: options.hasType }), options);
          skipped = plan.skipped;
          return plan.entries;
        },
        // The author stays with the import, watching the rows turn "On the form"; the inspector is not opened on them.
        { onResult: finish, select: "none" }
      );
    }
    if (!ran) {
      this.statusText = this.words.text("data.import.held");
      this.host.announce(this.statusText);
      this.host.paint();
    }
  }
}
