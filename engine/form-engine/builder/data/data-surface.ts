/**
 * The Data workspace's surface: the schema table —
 * every answer the form stores, where, what kind, whether required — filtered by step or by a
 * journey's page, its JSON Schema and an example document, and the storage settings of the
 * answer chosen. Loaded in a chunk of its own the first time the author opens Data
 * (`data-loader.ts`), drawn where the canvas is in Form.
 *
 * It edits the form's controller only, through the selection's draft like the
 * inspector: Apply commits it as one undo step, the controller's own checks hold an unusable or
 * clashing data key back, and leaving with a draft not applied asks first. The inspector steps
 * aside in Data, so the surface draws that prompt itself.
 *
 * Import builds the form from a JSON sample or a JSON Schema in a dialog the surface owns
 * (the import's logic is `data-model-import.ts`):
 * what the text would add or change, then Add missing fields or Replace form contents, each
 * one undo step.
 */
import type { BuilderController, BuilderChangeReason } from "../controller/builder-controller.js";
import { type BuilderTextCatalog, type BuilderTextKey } from "../logic/builder-texts.js";
import { areaWords } from "./data-texts-en.js";
import { builderTokens, esc, unsavedChangesPromptHtml } from "../web-component/builder-shared.js";
import { SURFACE_SHEET_STYLES, SurfaceSheet } from "../web-component/surface-sheet.js";
import { mountJsonViewerAfter } from "../web-component/json-viewer-loader.js";
import { HTMLElementBase, canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import { defaultHiddenValueBehaviorFor, type HiddenValueBehavior } from "../../core/state/effective-state.js";
import type { FormDefinition } from "../../core/schema/types.js";
import { DATA_KEY_PROPERTY } from "../../core/tree/data-scope.js";
import { dataModelExample, dataModelFromForm, dataModelToJsonSchema, indexDataModel, type DataModelNode } from "../data-model/index.js";
import { buildSchemaTable, filterSchemaRows, type SchemaRow, type SchemaTable } from "./schema-rows.js";
import {
  DATA_MODEL_IMPORT_FOCUS_KEYS,
  DATA_MODEL_IMPORT_STYLES,
  DataModelImporter,
  focusedResultsKey,
  restoreResultsFocus,
  type BuilderDataModelApplyDetail
} from "./data-model-import.js";
import { MODAL_BACKDROP_CLIP, MODAL_H, MODAL_INSET, MODAL_W, showBuilderModal } from "../web-component/modal-place.js";

export const DATUM_BUILDER_DATA_TAG = "datum-builder-data";

type DataView = "table" | "schema" | "example";

const HIDDEN_CHOICES: ReadonlyArray<{ value: HiddenValueBehavior; label: BuilderTextKey }> = [
  { value: "exclude-from-submission", label: "data.hidden.exclude" },
  { value: "retain", label: "data.hidden.retain" },
  { value: "clear", label: "data.hidden.clear" }
];

export class DatumBuilderDataElement extends HTMLElementBase {
  private readonly root: ShadowRoot;
  private ctrl: BuilderController | undefined;
  private unsubscribe: (() => void) | undefined;
  private definitionSource: (() => FormDefinition | undefined) | undefined;
  private localeValue: string | undefined;
  private filter = "all";
  private view: DataView = "table";
  private table: SchemaTable | undefined;
  private bound = false;
  /** Whether the "?" note under "Checks on the server" is open; kept across repaints. */
  private checksHelpOpen = false;
  /** What the last import built, under the schema's heading until the form next changes. */
  private notice = "";
  /** Import: its text, how it is read, and its builds, in the surface's dialog. */
  private readonly importer = new DataModelImporter({
    controller: () => this.ctrl,
    words: () => this.words,
    canBuild: () => true,
    // Behind a modal dialog the canvas cannot follow a selection: the rows only list.
    selectsRows: () => false,
    scope: () => this.importDialog(),
    paint: () => this.paintImport(),
    announce: (text) => {
      const live = this.root.querySelector<HTMLElement>("[data-import-live]");
      if (live) {
        live.textContent = text;
      }
    },
    built: (detail, message) => this.onBuilt(detail, message)
  });
  /** What the import results show, so an unrelated change costs no markup. */
  private importResultsKey: string | undefined;

  public constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  public connectedCallback(): void {
    this.bind();
    this.subscribe();
    this.paint();
  }

  public disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.importer.dispose();
    this.sheet.dispose();
  }

  /**
   * Listens to the controller's changes while the surface is on the page. A surface the shell drops
   * (a reconnect replaces its markup) would otherwise stay in the controller's listener list for
   * the controller's life, so it lets go on disconnect and takes the listener again on connect.
   * The controller itself stays: the setter owns that, and clearing it would also clear the
   * controller's single leave-guard slot.
   */
  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.ctrl?.on("change", (event) => this.onChange(event.reason));
  }

  public static get observedAttributes(): string[] {
    return ["data-phone"];
  }

  /** The tier changed under an open editor: it becomes (or stops being) a dialog without a repaint. */
  public attributeChangedCallback(): void {
    if (this.isConnected && this.bound) {
      this.sheet.sync(this.subject() !== undefined);
    }
  }

  /** The row whose button opened the sheet, so focus goes back to it on close. */
  private sheetRowId: string | undefined;

  /** The phone sheet over the table: dialog semantics, scrim, Escape, grabber, focus. */
  private readonly sheet = new SurfaceSheet({
    host: this,
    sheet: () => this.root.querySelector<HTMLElement>("[data-data-editor]"),
    dismiss: () => {
      const controller = this.ctrl;
      controller?.requestLeave(() => controller.select(undefined));
    },
    grabLabel: (tall) => this.t(tall ? "shell.sheet.grabTall" : "shell.sheet.grab"),
    opener: () => (this.sheetRowId ? this.root.querySelector<HTMLElement>(`[data-data-row="${this.sheetRowId.replace(/["\\]/g, "\\$&")}"]`) : null),
    firstControl: (sheet) => sheet.querySelector<HTMLElement>("[data-data-key], [data-data-hidden], [data-data-close], [data-data-discard]")
  });

  private importOn = true;
  private jsonOn = true;

  /**
   * Whether the surface offers Import (the `data-model` feature). Off, the button is not
   * drawn, here or in the empty state, and the Schema / Example views go with it (they show a data
   * model as JSON). Read when the markup is drawn; a change repaints once, an unchanged value never.
   */
  public get importEnabled(): boolean {
    return this.importOn;
  }

  public set importEnabled(value: boolean) {
    if (value !== this.importOn) {
      this.importOn = value;
      this.paint();
    }
  }

  /**
   * Whether the surface may show JSON (the `json` feature): off, the Schema / Example views are not
   * drawn, so the JSON editor's chunk is never asked for. Same repaint rule as {@link importEnabled}.
   */
  public get jsonEnabled(): boolean {
    return this.jsonOn;
  }

  public set jsonEnabled(value: boolean) {
    if (value !== this.jsonOn) {
      this.jsonOn = value;
      this.paint();
    }
  }

  /** The Schema and Example views exist only where a data model can be read as JSON. */
  private viewsOn(): boolean {
    return this.importOn && this.jsonOn;
  }

  /** The form's controller: Data reads and writes the form only. */
  public get controller(): BuilderController | undefined {
    return this.ctrl;
  }

  public set controller(value: BuilderController | undefined) {
    if (value === this.ctrl) {
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.ctrl = value;
    if (this.isConnected) {
      this.subscribe();
    }
    this.paint();
  }

  /** The whole definition, for the journeys' pages the table filters by. */
  public set definition(source: (() => FormDefinition | undefined) | undefined) {
    this.definitionSource = source;
    this.paint();
  }

  public set locale(value: string | undefined) {
    this.localeValue = value;
    this.paint();
  }

  /** The builder's words (the text catalog), English until the host sets a locale or catalog. */
  private readonly words = areaWords();

  /** The builder's own language for its words, not the form's. */
  public set textLocale(value: string | undefined) {
    if (this.words.locale !== value) {
      this.words.locale = value;
      this.repaintWords();
    }
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. */
  public set textCatalog(value: BuilderTextCatalog | undefined) {
    if (this.words.catalog !== value) {
      this.words.catalog = value;
      this.repaintWords();
    }
  }

  /** The words moved: the frame (the Import dialog's head) and the surface are drawn again. */
  private repaintWords(): void {
    const frame = this.root.querySelector("[data-data-main]");
    if (frame) {
      this.root.querySelector<HTMLElement>("#data-import-title")!.textContent = this.words.text("data.import.title");
      this.root.querySelector<HTMLElement>("[data-import-close]")!.textContent = this.words.text("data.close");
    }
    this.paint();
  }

  private t(key: BuilderTextKey, params?: Record<string, string | number>): string {
    return this.words.text(key, params);
  }

  /** Whether the editor is up, as last said: a phone draws it as a sheet over the shell's bars. */
  private sheetReported = false;

  private reportSheet(open: boolean): void {
    if (open === this.sheetReported) {
      return;
    }
    this.sheetReported = open;
    this.dispatchEvent(new CustomEvent<{ open: boolean }>("builder-sheet-change", { detail: { open }, bubbles: true, composed: true }));
  }

  /** The answer the editor shows: the selection, when it is one of the table's rows. */
  private subject(): SchemaRow | undefined {
    const selected = this.ctrl?.selectedComponentId();
    return selected === undefined ? undefined : this.table?.rows.find((row) => row.componentId === selected);
  }

  private onChange(reason: BuilderChangeReason): void {
    // A build's message stands until the form next changes, and then it would mislead.
    this.notice = "";
    this.importer.formChanged();
    // A keystroke in the editor's own boxes: the parts that follow the draft, not the whole
    // surface, so the box keeps its caret.
    // A commit, a discard or an undo is an "edit" too, but leaves no draft: that one repaints.
    const subject = this.subject();
    if (
      reason === "edit" &&
      subject !== undefined &&
      this.ctrl?.hasPendingChanges(subject.componentId) &&
      this.root.activeElement?.closest?.("[data-data-editor]")
    ) {
      this.root.querySelector("[data-data-notice]")?.remove();
      this.refreshLive();
      return;
    }
    this.paint();
  }

  // --- painting ---------------------------------------------------------------------

  /**
   * What stays put across repaints: the styles, the live region, and the Import dialog, so
   * the dialog's text box keeps its text, focus and caret while the form changes behind it.
   */
  private frame(): HTMLElement {
    let main = this.root.querySelector<HTMLElement>("[data-data-main]");
    if (!main) {
      this.root.innerHTML = `<style>${builderTokens()}${DATA_STYLES}${SURFACE_SHEET_STYLES}${DATA_MODEL_IMPORT_STYLES}${IMPORT_DIALOG_STYLES}</style>
        <div class="data" data-data-main></div>
        <p class="sr-only" aria-live="polite" data-data-live></p>
        <dialog class="import-dialog" aria-labelledby="data-import-title" data-import-dialog>
          <div class="import-head">
            <h2 id="data-import-title">${esc(this.t("data.import.title"))}</h2>
            <button type="button" class="btn small" data-import-close>${esc(this.t("data.close"))}</button>
          </div>
          <div class="dm-body" data-import-body></div>
          <p class="sr-only" aria-live="polite" data-import-live></p>
        </dialog>`;
      main = this.root.querySelector<HTMLElement>("[data-data-main]")!;
      this.importResultsKey = undefined;
    }
    return main;
  }

  private paint(): void {
    if (!this.isConnected) {
      return;
    }
    const main = this.frame();
    const controller = this.ctrl;
    if (!controller) {
      main.removeAttribute("data-editing");
      main.innerHTML = `<p class="empty">${esc(this.t("shell.noController"))}</p>`;
      return;
    }
    const definition = this.definitionSource?.();
    const locale = this.localeValue ?? controller.currentLocale();
    this.table = buildSchemaTable(controller.previewSnapshot(), { locale, words: this.words, ...(definition ? { definition } : {}) });
    const known = this.filter === "all" || [...this.table.steps, ...this.table.pages].some((entry) => entry.id === this.filter);
    if (!known) {
      this.filter = "all";
    }
    if (this.view !== "table" && !this.viewsOn()) {
      this.view = "table";
    }
    const subject = this.subject();
    const focus = this.captureFocus();
    main.toggleAttribute("data-editing", subject !== undefined);
    this.reportSheet(subject !== undefined);
    main.innerHTML = `<section class="data-main card${this.view === "table" ? "" : " data-main--json"}" aria-labelledby="data-title">
          ${this.headHtml()}
          ${this.notice ? `<p class="note" data-data-notice>${esc(this.notice)}</p>` : ""}
          ${this.view === "table" ? `${this.filtersHtml()}${this.tableHtml()}` : this.jsonHtml()}
        </section>
        ${subject ? this.editorHtml(subject) : ""}
        ${this.promptHtml(controller, subject)}`;
    this.restoreFocus(focus);
    if (subject) {
      this.sheetRowId = subject.componentId;
    }
    this.sheet.sync(subject !== undefined);
    this.paintImport();
    const source = this.root.querySelector<HTMLElement>("[data-json-view]");
    if (source) {
      mountJsonViewerAfter(source, { label: this.t(this.view === "schema" ? "data.json.schema.label" : "data.json.example.label") }, () => undefined);
    }
    const dialog = this.root.querySelector<HTMLDialogElement>("dialog[data-prompt]");
    if (dialog && !dialog.open && typeof dialog.showModal === "function") {
      showBuilderModal(dialog);
      dialog.querySelector<HTMLElement>("[autofocus]:not([disabled])")?.focus();
    }
  }

  private headHtml(): string {
    const count = this.table?.rows.length ?? 0;
    const views: Array<{ id: DataView; label: string }> = this.viewsOn()
      ? [
          { id: "table", label: this.t("data.view.table") },
          { id: "schema", label: this.t("data.view.schema") },
          { id: "example", label: this.t("data.view.example") }
        ]
      : [];
    return `<header class="data-head">
        <div class="data-title"><h2 class="card-title" id="data-title">${esc(this.t("data.title"))}</h2><p class="card-lead">${esc(this.t("data.subtitle", { fields: this.words.plural("data.fields", count) }))}</p></div>
        <div class="data-tools">
          ${
            views.length === 0
              ? ""
              : `<div class="seg" role="group" aria-label="${esc(this.t("data.views.label"))}">${views
                  .map((entry) => `<button type="button" class="seg-btn" data-data-view="${entry.id}" aria-pressed="${this.view === entry.id}">${esc(entry.label)}</button>`)
                  .join("")}</div>`
          }
          ${this.importOn ? `<button type="button" class="btn small" data-data-import aria-haspopup="dialog">${esc(this.t("data.import.button"))}</button>` : ""}
        </div>
      </header>`;
  }

  private filtersHtml(): string {
    const table = this.table!;
    if (table.steps.length === 0 && table.pages.length === 0) {
      return "";
    }
    const chips = [{ id: "all", label: this.t(table.steps.length > 0 ? "data.filter.allSteps" : "data.filter.allFields") }, ...table.steps]
      .map((entry) => `<button type="button" class="chip-btn" data-data-filter="${esc(entry.id)}" aria-pressed="${this.filter === entry.id}">${esc(entry.label)}</button>`)
      .join("");
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const page of table.pages) {
      const key = page.group ?? this.t("data.filter.journey");
      groups.set(key, [...(groups.get(key) ?? []), page]);
    }
    const pageSelect =
      table.pages.length > 0
        ? `<label class="page-filter"><span>${esc(this.t("data.filter.page"))}</span><select data-data-page-filter><option value="">${esc(this.t("data.filter.anyPage"))}</option>${[...groups]
            .map(
              ([group, pages]) =>
                `<optgroup label="${esc(group)}">${pages
                  .map((page) => `<option value="${esc(page.id)}"${this.filter === page.id ? " selected" : ""}>${esc(page.label)}</option>`)
                  .join("")}</optgroup>`
            )
            .join("")}</select></label>`
        : "";
    return `<div class="filters"><div class="chips" role="group" aria-label="${esc(this.t("data.filter.label"))}">${table.steps.length > 0 ? chips : ""}</div>${pageSelect}</div>`;
  }

  private tableHtml(): string {
    const rows = filterSchemaRows(this.table!, this.filter);
    if (this.table!.rows.length === 0) {
      return `<div class="empty-state"><h3>${esc(this.t("data.empty.title"))}</h3><p>${esc(this.t("data.empty.body"))}</p>${this.importOn ? `<button type="button" class="btn primary" data-data-import aria-haspopup="dialog">${esc(this.t("data.import.button"))}</button>` : ""}</div>`;
    }
    if (rows.length === 0) {
      return `<p class="empty">${esc(this.t(this.filter.startsWith("page:") ? "data.empty.page" : "data.empty.step"))}</p>`;
    }
    const selected = this.ctrl?.selectedComponentId();
    return `<div class="table-wrap"><table>
        <caption class="sr-only">${esc(this.t("data.table.caption"))}</caption>
        <thead><tr><th scope="col">${esc(this.t("data.col.field"))}</th><th scope="col">${esc(this.t("data.col.path"))}</th><th scope="col">${esc(this.t("data.col.type"))}</th><th scope="col">${esc(this.t("data.col.required"))}</th></tr></thead>
        <tbody>${rows
          .map(
            (row) => `<tr${row.componentId === selected ? ' class="selected" aria-current="true"' : ""}>
              <th scope="row"><button type="button" class="row-link" data-data-row="${esc(row.componentId)}">${esc(row.label)}</button>${row.badges
                .map((badge) => `<span class="badge badge--${badge.kind}"${badge.kind === "warning" ? ` title="${esc(badge.text)}"` : ""}>${esc(badge.kind === "warning" ? this.t("data.badge.checkKey") : badge.text)}</span>`)
                .join("")}</th>
              <td><code>${esc(row.path)}</code></td>
              <td>${esc(row.typeText)}</td>
              <td data-required-label="${esc(this.t("data.col.required.label"))}">${esc(row.requiredText)}</td>
            </tr>`
          )
          .join("")}</tbody>
      </table></div>`;
  }

  /**
   * A JSON view: its line and Copy over the text. Copy sits here, not among the view buttons,
   * so the heading's row is the same for every view and never wraps differently.
   */
  private jsonHtml(): string {
    const line = this.t(this.view === "schema" ? "data.json.schema" : "data.json.example");
    return `<div class="json-bar"><p class="muted">${esc(line)}</p><button type="button" class="btn small" data-data-copy>${esc(this.t("data.copy"))}</button></div>
      <pre class="json" data-json-view>${esc(JSON.stringify(this.jsonValue(), null, 2))}</pre>`;
  }

  private jsonValue(): unknown {
    const controller = this.ctrl!;
    const model = dataModelFromForm(controller.previewSnapshot(), { locale: this.localeValue ?? controller.currentLocale() });
    return this.view === "schema" ? dataModelToJsonSchema(model) : dataModelExample(model);
  }

  // --- the storage editor -------------------------------------------------------------

  /** What `id`'s hidden answer does while its configuration names nothing (`defaultHiddenValueBehaviorFor`), open draft applied. */
  private defaultHiddenOf(id: string): HiddenValueBehavior {
    const controller = this.ctrl!;
    return defaultHiddenValueBehaviorFor({
      hiddenRequiredBehavior: controller.draftProperty(id, "hiddenRequiredBehavior"),
      hiddenValidationBehavior: controller.draftProperty(id, "hiddenValidationBehavior")
    });
  }

  private editorHtml(row: SchemaRow): string {
    const controller = this.ctrl!;
    const id = row.componentId;
    const typeLabel = controller.componentTypes().find((entry) => entry.type === row.componentType)?.label ?? row.componentType;
    const step = row.stepId ? this.table!.steps.find((entry) => entry.id === `step:${row.stepId}`)?.label : undefined;
    const offersKey = controller.offersDataKey(row.componentType);
    const key = controller.draftProperty(id, DATA_KEY_PROPERTY);
    const keyProblems = controller.problemsOf(id).filter((problem) => problem.target === DATA_KEY_PROPERTY);
    const hidden = (controller.draftProperty(id, "hiddenValueBehavior") as HiddenValueBehavior | undefined) ?? this.defaultHiddenOf(id);
    const excluded = controller.draftProperty(id, "pdf.exclude") === true;
    const dirty = controller.hasPendingChanges(id);
    return `<section class="data-editor card-stack" aria-labelledby="data-editor-title" data-data-editor>
        <header class="card editor-section editor-head">
          <div class="editor-head-row"><h2 class="card-title" id="data-editor-title">${esc(row.label)}</h2><button type="button" class="btn small sheet-close-btn" data-data-close>${esc(this.t("data.close"))}</button></div>
          <p class="card-lead">${esc(typeLabel)}${step ? ` · ${esc(step)}` : ""}</p>
        </header>
        <div class="card editor-section">
        ${
          offersKey
            ? `<label class="field"><span class="field-label">${esc(this.t("data.editor.key"))}</span>
                <input type="text" data-data-key value="${esc(typeof key === "string" ? key : "")}" placeholder="${esc(id)}" spellcheck="false"
                  aria-describedby="data-saves-to${keyProblems.length > 0 ? " data-key-problem" : ""}"${keyProblems.length > 0 ? ' aria-invalid="true"' : ""}></label>
              <div data-data-key-problem>${keyProblems.map((problem) => `<p class="problem" id="data-key-problem">${esc(problem.message)}</p>`).join("")}</div>`
            : ""
        }
        <label class="field" id="data-saves-to"><span class="field-label">${esc(this.t("data.editor.savesTo"))}</span><input type="text" readonly data-data-saves-to value="${esc(controller.dataPathOf(id) ?? row.path)}"></label>
        </div>
        <div class="card editor-section">
        <fieldset class="field"><legend class="field-label">${esc(this.t("data.editor.hidden"))}</legend>${HIDDEN_CHOICES.map(
          (choice) =>
            `<label class="choice"><input type="radio" name="data-hidden" data-data-hidden value="${choice.value}"${hidden === choice.value ? " checked" : ""}> ${esc(this.t(choice.label))}</label>`
        ).join("")}</fieldset>
        <label class="choice"><input type="checkbox" data-data-pdf${excluded ? "" : " checked"}> ${esc(this.t("data.editor.pdf"))}</label>
        </div>
        <div class="card editor-section">
          <div class="row-label-line"><h3 class="card-heading">${esc(this.t("data.editor.checks"))}</h3><button type="button" class="help-toggle" data-data-help="checks" data-tip="${esc(this.t("data.editor.checks.help"))}" data-tip-side="end"
            aria-expanded="${this.checksHelpOpen}" aria-controls="data-checks-help" aria-label="${esc(this.t("data.editor.checks.help"))}">?</button></div>
          <p class="checks">${esc(this.checksText(row))}</p>
          <p class="help" id="data-checks-help"${this.checksHelpOpen ? "" : " hidden"}>${esc(this.t("data.checks.help"))}</p>
        </div>
        <div class="card editor-foot">
          <span class="spacer"></span>
          <span class="dirty-flag" data-data-dirty${dirty ? "" : " hidden"}>${esc(this.t("data.notApplied"))}</span>
          <button type="button" class="btn" data-data-discard${dirty ? "" : " disabled"}>${esc(this.t("data.discard"))}</button>
          <button type="button" class="btn primary" data-data-apply${dirty ? "" : " disabled"}>${esc(this.t("data.apply"))}</button>
        </div>
      </section>`;
  }

  /** What the server checks of the answer when the form is sent, in words (the fold's rules). */
  private checksText(row: SchemaRow): string {
    const model = dataModelFromForm(this.ctrl!.previewSnapshot(), { locale: this.localeValue ?? this.ctrl!.currentLocale() });
    const node: DataModelNode | undefined = indexDataModel(model).get(row.path);
    const parts: string[] = [];
    if (row.required === "yes") {
      parts.push(this.t("data.checks.required"));
    } else if (row.required === "when") {
      parts.push(this.t("data.checks.requiredWhen", { when: `${row.requiredText.charAt(0).toLowerCase()}${row.requiredText.slice(1)}` }));
    } else if (row.required === "calculated") {
      parts.push(this.t("data.checks.calculated"));
    }
    if (node?.minLength !== undefined && node.maxLength !== undefined) {
      parts.push(this.t("data.checks.length.between", { min: node.minLength, max: node.maxLength }));
    } else if (node?.maxLength !== undefined) {
      parts.push(this.t("data.checks.length.max", { max: node.maxLength }));
    } else if (node?.minLength !== undefined) {
      parts.push(this.t("data.checks.length.min", { min: node.minLength }));
    }
    if (node?.pattern) {
      parts.push(this.t("data.checks.pattern"));
    }
    if (node?.options && node.options.length > 0) {
      parts.push(this.t("data.checks.options", { count: node.options.length }));
    }
    if (parts.length === 0) {
      return this.t("data.checks.none");
    }
    return `${parts.join(" · ")}.`;
  }

  private promptHtml(controller: BuilderController, subject: SchemaRow | undefined): string {
    const held = controller.unsavedChangesPrompt();
    if (!held || held.external || !subject || held.componentId !== subject.componentId) {
      return "";
    }
    const problems = controller.problemsOf(subject.componentId).map((problem) => problem.message);
    return unsavedChangesPromptHtml({
      componentId: subject.componentId,
      label: subject.label,
      action: held.action,
      blocked: problems.length > 0,
      ...(problems.length > 0 ? { problems } : {})
    }, this.words.options());
  }

  /** After a keystroke: Saves to, the key's problem, "Not applied" and the buttons, in place. */
  private refreshLive(): void {
    const controller = this.ctrl;
    const subject = this.subject();
    if (!controller || !subject) {
      return;
    }
    const id = subject.componentId;
    const savesTo = this.root.querySelector<HTMLInputElement>("[data-data-saves-to]");
    if (savesTo) {
      savesTo.value = controller.dataPathOf(id) ?? subject.path;
    }
    const problems = controller.problemsOf(id).filter((problem) => problem.target === DATA_KEY_PROPERTY);
    const slot = this.root.querySelector<HTMLElement>("[data-data-key-problem]");
    if (slot) {
      slot.innerHTML = problems.map((problem) => `<p class="problem" id="data-key-problem">${esc(problem.message)}</p>`).join("");
    }
    const box = this.root.querySelector<HTMLInputElement>("[data-data-key]");
    if (box) {
      box.toggleAttribute("aria-invalid", problems.length > 0);
      box.setAttribute("aria-describedby", `data-saves-to${problems.length > 0 ? " data-key-problem" : ""}`);
    }
    const dirty = controller.hasPendingChanges(id);
    const flag = this.root.querySelector<HTMLElement>("[data-data-dirty]");
    if (flag) {
      flag.hidden = !dirty;
    }
    for (const selector of ["[data-data-discard]", "[data-data-apply]"]) {
      const button = this.root.querySelector<HTMLButtonElement>(selector);
      if (button) {
        button.disabled = !dirty;
      }
    }
  }

  // --- events -----------------------------------------------------------------------

  private bind(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.root.addEventListener("click", (event) => this.onClick(event));
    this.root.addEventListener("input", (event) => this.onEdit(event));
    this.root.addEventListener("change", (event) => this.onEdit(event));
    this.root.addEventListener(
      "cancel",
      (event) => {
        const dialog = event.target as HTMLElement | null;
        if (dialog?.dataset?.prompt !== undefined) {
          event.preventDefault();
          this.ctrl?.answerUnsavedChangesPrompt("stay");
        } else if (dialog?.hasAttribute?.("data-import-dialog")) {
          // The dialog closes through closeImport, which puts focus back on Import.
          event.preventDefault();
          this.escapeImport(this.root.activeElement);
        }
      },
      true
    );
    // Escape in the Import dialog: Replace's confirm first, then the dialog. Taken here so the
    // browser's own close request (the cancel above) does not follow it.
    this.root.addEventListener("keydown", (event) => {
      const keyboard = event as KeyboardEvent;
      const target = keyboard.target as HTMLElement | null;
      if (keyboard.key === "Escape" && target?.closest?.("[data-import-dialog]")) {
        keyboard.preventDefault();
        this.escapeImport(target);
      } else if (keyboard.key === "Escape") {
        this.sheet.onEscape(keyboard);
      }
    });
  }

  private onClick(event: Event): void {
    const target = event.target as HTMLElement;
    const hit = (selector: string): HTMLElement | null => target.closest<HTMLElement>(selector);
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    if (hit("[data-unsaved-stay]")) {
      controller.answerUnsavedChangesPrompt("stay");
      return;
    }
    if (hit("[data-unsaved-discard]")) {
      controller.answerUnsavedChangesPrompt("discard");
      return;
    }
    if (hit("[data-unsaved-save]")) {
      controller.answerUnsavedChangesPrompt("save");
      return;
    }
    if (hit("[data-import-close]")) {
      this.closeImport();
      return;
    }
    if (hit("[data-import-dialog]")) {
      const button = hit("button") as HTMLButtonElement | null;
      if (button && !button.disabled) {
        this.importer.click(button);
      }
      return;
    }
    if (hit("[data-data-import]")) {
      this.openImport();
      return;
    }
    const help = hit("[data-data-help]");
    if (help) {
      // Shown or hidden in place, as the inspector's "?" is: no repaint for a click that changes no state of the form.
      this.checksHelpOpen = help.getAttribute("aria-expanded") !== "true";
      help.setAttribute("aria-expanded", String(this.checksHelpOpen));
      const note = this.root.querySelector<HTMLElement>("#data-checks-help");
      if (note) {
        note.hidden = !this.checksHelpOpen;
      }
      return;
    }
    const view = hit("[data-data-view]");
    if (view) {
      this.view = view.dataset.dataView as DataView;
      this.paint();
      return;
    }
    const filter = hit("[data-data-filter]");
    if (filter) {
      this.filter = filter.dataset.dataFilter ?? "all";
      this.paint();
      return;
    }
    // A phone's row sheet closes as the selection goes; a draft on it asks first.
    if (hit("[data-data-close]")) {
      controller.requestLeave(() => controller.select(undefined));
      return;
    }
    const row = hit("[data-data-row]");
    if (row) {
      // Guarded: a draft on the answer open now asks first, as a click on the canvas does.
      controller.requestSelect(row.dataset.dataRow);
      return;
    }
    if (hit("[data-data-copy]")) {
      const text = JSON.stringify(this.jsonValue(), null, 2);
      const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
      void clipboard?.writeText?.(text).then(
        () => this.say(this.t("data.copied")),
        () => this.say(this.t("data.copyRefused"))
      );
      return;
    }
    const subject = this.subject();
    if (!subject) {
      return;
    }
    if (hit("[data-data-apply]")) {
      if (controller.commitDraft(subject.componentId)) {
        this.say(this.t("data.applied"));
      } else {
        this.root.querySelector<HTMLElement>("[data-data-key]")?.focus();
      }
      return;
    }
    if (hit("[data-data-discard]")) {
      controller.discardDraft(subject.componentId);
    }
  }

  private onEdit(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const data = target.dataset ?? {};
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    if (target.closest?.("[data-import-dialog]")) {
      if (event.type === "input") {
        this.importer.input(target);
      } else {
        this.importer.change(target);
      }
      return;
    }
    if (data.dataPageFilter !== undefined && event.type === "change") {
      this.filter = target.value || "all";
      this.paint();
      return;
    }
    const subject = this.subject();
    if (!subject) {
      return;
    }
    const id = subject.componentId;
    if (data.dataKey !== undefined && event.type === "input") {
      const value = target.value.trim();
      controller.setDraftProperty(id, DATA_KEY_PROPERTY, value === "" ? undefined : value);
      return;
    }
    if (data.dataHidden !== undefined && event.type === "change") {
      // The key the inspector's "When hidden" and the Logic workspace write: only a choice other than the default is stored.
      controller.setDraftProperty(id, "hiddenValueBehavior", target.value === this.defaultHiddenOf(id) ? undefined : target.value);
      return;
    }
    if (data.dataPdf !== undefined && event.type === "change") {
      controller.setDraftProperty(id, "pdf.exclude", (target as HTMLInputElement).checked ? undefined : true);
    }
  }

  // --- import ----------------------------------------------------------------------

  private importDialog(): HTMLDialogElement | null {
    return this.root.querySelector<HTMLDialogElement>("dialog[data-import-dialog]");
  }

  private importOpen(): boolean {
    return this.importDialog()?.hasAttribute("open") ?? false;
  }

  /** Opens Import as a modal dialog, its text box as the author left it, focus in the box. */
  private openImport(): void {
    const dialog = this.importDialog();
    if (!dialog || this.importOpen()) {
      return;
    }
    const body = dialog.querySelector<HTMLElement>("[data-import-body]")!;
    if (!body.querySelector("[data-model-input]")) {
      body.innerHTML = this.importer.frameHtml("data-import-error");
      this.importResultsKey = undefined;
    }
    if (typeof dialog.showModal === "function") {
      showBuilderModal(dialog);
    } else {
      dialog.setAttribute("open", "");
    }
    this.paintImport();
    dialog.querySelector<HTMLElement>("[data-model-input]")?.focus();
  }

  /** Closes Import; focus goes back to the Import button, which every view draws. */
  private closeImport(): void {
    const dialog = this.importDialog();
    if (!dialog || !this.importOpen()) {
      return;
    }
    if (typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
    if (this.importer.confirmingReplace) {
      this.importer.confirmingReplace = false;
      this.importResultsKey = undefined;
    }
    this.root.querySelector<HTMLElement>("[data-data-import]")?.focus();
  }

  /** Escape in the dialog: Replace's confirm, when it is open and focus is in it, else the dialog. */
  private escapeImport(target: Element | null): void {
    if (!this.importer.escape(target)) {
      this.closeImport();
    }
  }

  /** The dialog's moving parts: the read, the line under the box, and the results when they changed. */
  private paintImport(): void {
    const dialog = this.importDialog();
    if (!dialog || !this.importOpen() || !this.ctrl) {
      return;
    }
    this.importer.sync();
    const results = this.importer.results();
    if (results.key !== this.importResultsKey) {
      const region = dialog.querySelector<HTMLElement>("[data-model-results]");
      if (region) {
        const focus = focusedResultsKey(dialog, this.root.activeElement, DATA_MODEL_IMPORT_FOCUS_KEYS);
        region.innerHTML = results.html;
        this.importResultsKey = results.key;
        restoreResultsFocus(dialog, focus);
      }
    }
    // The unsaved-edits prompt a build raised, answered and gone: focus back into the dialog,
    // the one place the page lets it be.
    if (!this.root.querySelector("dialog[data-prompt]") && !dialog.contains(this.root.activeElement)) {
      dialog.querySelector<HTMLElement>("[data-model-add]:not([disabled]), [data-model-build]:not([disabled]), [data-model-input]")?.focus();
    }
  }

  /** A build ran: the page hears of it, the dialog closes, and the schema says what changed. */
  private onBuilt(detail: BuilderDataModelApplyDetail, message: string): void {
    this.dispatchEvent(new CustomEvent<BuilderDataModelApplyDetail>("builder-data-model-apply", { detail, bubbles: true, composed: true }));
    this.importer.statusText = "";
    this.notice = message;
    this.closeImport();
    this.paint();
    this.say(message);
  }

  private say(text: string): void {
    const live = this.root.querySelector<HTMLElement>("[data-data-live]");
    if (live) {
      live.textContent = text;
    }
  }

  // --- focus across repaints --------------------------------------------------------

  private captureFocus(): { selector: string; start: number | null; end: number | null } | undefined {
    const active = this.root.activeElement as HTMLElement | null;
    if (!active) {
      return undefined;
    }
    for (const attribute of active.getAttributeNames()) {
      if (attribute.startsWith("data-data") || attribute.startsWith("data-unsaved")) {
        const value = active.getAttribute(attribute);
        const extra = active instanceof HTMLInputElement && active.type === "radio" ? `[value="${quoteAttr(active.value)}"]` : "";
        const text = active instanceof HTMLInputElement && active.type === "text";
        return {
          selector: `[${attribute}${value ? `="${quoteAttr(value)}"` : ""}]${extra}`,
          start: text ? (active as HTMLInputElement).selectionStart : null,
          end: text ? (active as HTMLInputElement).selectionEnd : null
        };
      }
    }
    return undefined;
  }

  private restoreFocus(snapshot: { selector: string; start: number | null; end: number | null } | undefined): void {
    if (!snapshot) {
      return;
    }
    try {
      const target = this.root.querySelector<HTMLElement>(snapshot.selector);
      target?.focus();
      // The caret where the author left it, in a box the repaint drew afresh.
      if (target instanceof HTMLInputElement && snapshot.start !== null && snapshot.end !== null) {
        target.setSelectionRange(snapshot.start, snapshot.end);
      }
    } catch {
      // A selector the repaint no longer matches: focus stays where the browser put it.
    }
  }
}

/** A value inside a quoted attribute selector: its quotes and backslashes escaped. */
function quoteAttr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * The surface's look, on the studio tokens: the table and the editor as two cards
 * over the backdrop, the editor folding over the table under 900px of surface.
 */
const DATA_STYLES = `
  :host { display: block; height: 100%; min-height: 0; container-type: inline-size; }
  .data {
    box-sizing: border-box; height: 100%; min-height: 0; padding: var(--db-gap, 12px); position: relative;
    display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--db-gap, 12px);
    font-family: var(--db-font); font-size: var(--db-text-md); color: var(--db-ink);
  }
  .data[data-editing] { grid-template-columns: minmax(0, 1fr) minmax(var(--db-editor-min), var(--db-editor-max)); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .muted { color: var(--db-ink-muted); }
  /*
   * The card holds still: its title and filters stay put and the table under them scrolls on its
   * own (.table-wrap), its column headings pinned. A JSON view has no table, so its card scrolls.
   */
  .data-main { min-height: 0; overflow: hidden; padding: var(--db-space-4); display: flex; flex-direction: column; gap: var(--db-space-3); }
  .data-main > * { flex: none; min-width: 0; }
  .data-main--json { overflow: auto; scrollbar-gutter: stable; }
  .data-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--db-space-3); }
  .data-title p { margin-top: var(--db-space-1); }
  .data-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-2); }
  .seg-btn:focus-visible, .chip-btn:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
  .filters { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--db-space-2); }
  .chips { display: flex; flex-wrap: wrap; gap: var(--db-space-1); }
  .chip-btn {
    min-block-size: 30px; padding: 0 var(--db-space-3); border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-pill);
    background: var(--db-surface); color: var(--db-ink); font: inherit; font-size: var(--db-text-sm); font-weight: 500; cursor: pointer;
  }
  .chip-btn:hover:not([aria-pressed="true"]) { background: var(--db-surface-hover); }
  .chip-btn[aria-pressed="true"] { background: var(--db-selected); border-color: var(--db-selected); color: var(--db-selected-ink); }
  .page-filter { display: inline-flex; align-items: center; gap: var(--db-space-2); font-size: var(--db-text-sm); }
  /* The gutter is kept, so a table long enough to scroll is as wide as one that is not. */
  .data-main > .table-wrap { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
  table { width: 100%; border-collapse: collapse; font-size: var(--db-text-md); }
  th, td { text-align: start; padding: var(--db-space-2) var(--db-space-3); border-bottom: var(--db-border-w) solid var(--db-line-divider); vertical-align: top; }
  thead th { position: sticky; top: 0; z-index: 1; background: var(--db-surface); font-size: var(--db-text-sm); font-weight: 600; color: var(--db-ink-muted); white-space: nowrap; }
  tbody th { font-weight: 500; }
  tbody tr:hover { background: var(--db-surface-hover); }
  tr.selected { background: var(--db-accent-soft); }
  td code { font-family: var(--db-font-mono); font-size: var(--db-text-sm); }
  .badge {
    display: inline-flex; align-items: center; margin-inline-start: var(--db-space-2); padding: 0 var(--db-space-2); min-block-size: 20px;
    border-radius: var(--db-radius-pill); background: var(--db-surface-sunken); font-size: var(--db-text-xs); font-weight: 500; vertical-align: middle;
  }
  .badge--warning { background: var(--db-warn-soft); border: var(--db-border-w) solid var(--db-warn-line); }
  .json { margin: 0; font-family: var(--db-font-mono); font-size: var(--db-text-sm); white-space: pre-wrap; }
  .json-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--db-space-2); }
  .json-bar p { margin: 0; font-size: var(--db-text-sm); }
  /*
   * The row editor is a stack of cards (.card-stack scrolls, .card draws): the title, a card for
   * each part, then Apply and Discard, pinned to the bottom of the stack so they stay in reach.
   */
  .data-editor > .card { padding: var(--db-space-4); }
  /* A field focused under the pinned buttons scrolls clear of them. */
  .data-editor { scroll-padding-block-end: 80px; }
  .editor-section { display: grid; gap: var(--db-space-3); align-content: start; }
  .editor-head { gap: var(--db-space-1); }
  [data-data-key-problem]:empty { display: none; }
  /* A group of choices is a fieldset: no frame of its own, the shared field layout and label. */
  fieldset.field { border: 0; margin: 0; padding: 0; }
  input[type="text"], select { max-width: 100%; }
  input[aria-invalid="true"] { border-color: var(--db-danger); }
  /* Saves to: a read-only box like the inspector's, its path selectable. */
  input[data-data-saves-to] { font-family: var(--db-font-mono); font-size: var(--db-text-sm); }
  .choice { display: flex; align-items: center; gap: var(--db-space-2); min-block-size: 24px; cursor: pointer; }
  .checks { margin: 0; color: var(--db-ink-muted); }
  /*
   * The "?" beside a row's label, as the inspector draws a property's (.property-help-toggle):
   * a 24px round chip, pressed in the strong fill while its note is open, the note under the row.
   */
  .row-label-line { display: flex; align-items: center; gap: var(--db-space-1); }
  .help-toggle {
    flex: none; inline-size: 24px; block-size: 24px; min-inline-size: 24px; min-block-size: 24px; padding: 0;
    border-radius: var(--db-radius-pill); border: 0;
    background: var(--db-surface-sunken); color: var(--db-ink-muted); font: inherit; font-size: var(--db-text-xs); font-weight: 600;
    line-height: 1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
    transition: background-color var(--db-motion-fast) var(--db-ease), color var(--db-motion-fast) var(--db-ease);
  }
  .help-toggle:hover { background: var(--db-surface-hover); color: var(--db-ink); }
  .help-toggle[aria-expanded="true"] { background: var(--db-selected); color: var(--db-selected-ink); }
  .help-toggle:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
  .help { margin: 0; font-size: var(--db-text-sm); line-height: 1.4; color: var(--db-ink-muted); }
  .help[hidden] { display: none; }
  .problem { margin: 0; color: var(--db-danger); font-size: var(--db-text-sm); }
  /* Apply and Discard are the stack's last card, pinned to its bottom edge at every width, as the inspector's footer is. */
  .editor-foot { position: sticky; bottom: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-2); padding: var(--db-space-3) var(--db-space-4); }
  .editor-foot .spacer { flex: 1; }
  .editor-foot .btn.primary { background: var(--db-selected); border-color: var(--db-selected); color: var(--db-selected-ink); }
  .editor-foot .btn.primary:hover:not(:disabled) { background: color-mix(in oklab, var(--db-selected) 84%, var(--db-surface)); border-color: var(--db-selected); }
  .dirty-flag { display: inline-flex; align-items: center; gap: var(--db-space-1); font-size: var(--db-text-sm); font-weight: 500; color: var(--db-warn); }
  .dirty-flag::before { content: ""; inline-size: 8px; block-size: 8px; border-radius: 50%; background: currentColor; }
  .dirty-flag[hidden] { display: none; }
  /* Under 900px of surface the editor folds over the table. */
  @container (max-width: 899px) {
    .data[data-editing] { grid-template-columns: minmax(0, 1fr); }
    .data-editor {
      position: absolute; inset-block: var(--db-gap, 12px); inset-inline-end: var(--db-gap, 12px);
      inline-size: min(var(--db-editor-max), calc(100% - 2 * var(--db-gap, 12px))); z-index: var(--db-z-drawer);
      /* Over the list the gaps between the cards are filled, so no row shows through them. */
      background: var(--db-backdrop); border-radius: var(--db-radius-lg); box-shadow: var(--db-shadow-overlay);
    }
  }
  @media (pointer: coarse) {
    .chip-btn { min-block-size: 44px; }
  }
  /*
   * The phone tier: the shell sets data-phone. The editor rises as a tall sheet over
   * a scrim of the surface's own (the shell dims its bars), its Apply and Discard pinned.
   */
  :host([data-phone]) .data-editor {
    position: absolute; inset: max(var(--db-space-2), 10%) 0 0 0; inline-size: auto; z-index: 30;
    gap: var(--db-space-2); border-radius: 22px 22px 0 0; background: var(--db-surface-sunken); box-shadow: var(--db-shadow-drawer);
    overscroll-behavior: contain;
  }
  :host([data-phone]) .data-editor > .card { margin-inline: var(--db-space-2); box-shadow: none; }
  :host([data-phone]) .data-editor > .editor-foot { padding-bottom: calc(var(--db-space-3) + env(safe-area-inset-bottom, 0px)); }
  :host([data-phone]) :is(select, input[type="text"], textarea) { min-block-size: 44px; font-size: var(--db-text-lg); }
  :host([data-phone]) .btn { min-block-size: 44px; }
  :host([data-phone]) .choice { min-block-size: 44px; align-items: center; }
  .sheet-close-btn { display: none; }
  @container (max-width: 899px) { .sheet-close-btn { display: inline-flex; } }
  :host([data-phone]) .sheet-close-btn { display: inline-flex; }
  .editor-head-row { display: flex; align-items: center; justify-content: space-between; gap: var(--db-space-2); }
  :host([data-phone]) .data { padding: var(--db-gap, 8px); }
  :host([data-phone]) .chip-btn { min-block-size: 44px; }
  :host([data-phone]) .data-main { overflow: auto; }
  /* The schema as cards (spec 4.3): four columns do not fit a phone, and scrolling sideways hides the ones that matter. */
  :host([data-phone]) .data-main > .table-wrap { flex: none; overflow: visible; }
  :host([data-phone]) :is(table, tbody, tr, th, td) { display: block; }
  :host([data-phone]) thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  :host([data-phone]) tbody { display: grid; gap: var(--db-space-2); }
  :host([data-phone]) tbody tr {
    position: relative; display: grid; gap: 2px; padding: var(--db-space-3) var(--db-space-4);
    border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-lg); background: var(--db-surface);
  }
  :host([data-phone]) tbody tr.selected { border-color: var(--db-selected); box-shadow: 0 0 0 1px var(--db-selected); }
  :host([data-phone]) :is(tbody th, td) { padding: 0; border: 0; }
  :host([data-phone]) td { color: var(--db-ink-muted); font-size: var(--db-text-sm); }
  :host([data-phone]) td:empty { display: none; }
  :host([data-phone]) td:last-child::before { content: attr(data-required-label); }
  :host([data-phone]) .row-link { min-block-size: 44px; font-size: var(--db-text-lg); font-weight: 600; text-decoration: none; }
  :host([data-phone]) .row-link::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
  :host([data-phone]) .row-link:focus-visible { outline: none; }
  :host([data-phone]) tbody tr:has(.row-link:focus-visible) { outline: 2px solid var(--db-focus); outline-offset: 2px; }

  @media (forced-colors: active) {
    tr.selected { outline: 2px solid Highlight; }
    .help-toggle { border: var(--db-border-w) solid ButtonText; }
    .chip-btn[aria-pressed="true"] { outline: 2px solid Highlight; }
  }
`;

/**
 * Import's dialog: a modal over the surface, as wide as a comparison wants and no taller than
 * the window, its body (the shared frame) scrolling under a fixed heading.
 */
const IMPORT_DIALOG_STYLES = `
  dialog.import-dialog {
    inset: ${MODAL_INSET}; margin: auto;
    box-sizing: border-box; inline-size: min(720px, calc(${MODAL_W} - 32px)); max-block-size: min(760px, calc(${MODAL_H} - 32px));
    padding: var(--db-space-5); background: var(--db-surface); color: var(--db-ink);
    border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-lg); box-shadow: var(--db-shadow-overlay);
    font-family: var(--db-font); font-size: var(--db-text-md); line-height: 1.4;
  }
  dialog.import-dialog[open] { display: flex; flex-direction: column; gap: var(--db-space-3); }
  /* The backdrop is no descendant of the dialog: the scrim token carries its own fallback. */
  dialog.import-dialog::backdrop { background: var(--db-scrim, rgba(22, 23, 26, .42)); ${MODAL_BACKDROP_CLIP} }
  .import-head { display: flex; align-items: center; justify-content: space-between; gap: var(--db-space-3); }
  .import-head h2 { margin: 0; font-size: var(--db-text-lg); font-weight: 600; line-height: 1.2; }
  .import-dialog .btn:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
`;

export function defineBuilderData(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_BUILDER_DATA_TAG)) {
    customElements.define(DATUM_BUILDER_DATA_TAG, DatumBuilderDataElement);
  }
}

defineBuilderData();
