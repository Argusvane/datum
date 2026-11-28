import type { ComponentNode, LocalizationConfiguration } from "../../core/schema/types.js";
import type { FormError } from "../../core/errors/form-error.js";
import type { JourneyView } from "../../core/journey/journey-types.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import type { EffectiveNodeState } from "../../core/state/effective-state.js";
import type { FormState } from "../../core/state/form-state.js";
import { FormStateStore } from "../../core/state/form-state.js";
import { ComponentTree } from "../../core/tree/component-tree.js";
import { parseComponentPath } from "../../core/tree/component-path.js";
import { EventBus } from "../../core/events/event-bus.js";
import { FormEventType } from "../../core/events/event-types.js";
import { RuntimeOrchestrator } from "../../runtime/browser/runtime-orchestrator.js";
import type { DataSourceResolver } from "../../render/core/component-options.js";
import type { RenderHostRuntime } from "../../render/web-component/form-renderer-element.js";
import type { DataSourceSet, TranslationCatalog } from "../../core/schema/contracts.js";
import type { FormTranslations } from "../../core/localization/translations.js";
import type { PdfConfiguration } from "../../core/schema/pdf-layout.js";
import { resolveThroughDataSourceSet } from "../../render/core/host-data-sources.js";
import type { CollectionOperations } from "../../core/schema/collection.js";
import { collectionPathOf } from "../../core/tree/data-scope.js";
import { DATA_GRID_ROWS_CAP, dataGridSettingsOf, isDataGrid, normalizeDataGrids, rowOperationsOf } from "../../core/schema/data-grid.js";
import { kernelRowFields } from "../../validation/wasm/portable-kernel.js";

/** A collection-bound container the preview draws rows for: what its rows hold and allow. */
interface PreviewCollection {
  componentId: string;
  /** Each entry's field keys (`sku`, `address.city`): what an empty row holds a key for. */
  itemFields: string[];
  /** The container and the fields of its rows: whose errors a row operation leaves stale. */
  componentIds: Set<string>;
  operations: CollectionOperations;
  /** A data grid's starting rows and its fixed maximum; a repeating section has neither. */
  initialRows: number;
  maxRows: number | undefined;
}

/** A collection's entry key (`items[2].sku`): the entry's index and the field within it; else `undefined`. */
function previewEntryOf(key: string, collectionPath: string): { index: number; field: string } | undefined {
  const start = collectionPath.length + 1;
  if (!key.startsWith(collectionPath) || key.charAt(start - 1) !== "[") {
    return undefined;
  }
  const close = key.indexOf("]", start);
  const digits = close > start ? key.slice(start, close) : "";
  if (!/^(?:0|[1-9][0-9]*)$/.test(digits) || key.charAt(close + 1) !== "." || close + 2 >= key.length) {
    return undefined;
  }
  return { index: Number(digits), field: key.slice(close + 2) };
}

const PREVIEW_FORM_ID = "datum-builder-preview";

const NO_DATA_SOURCES: DataSourceResolver = { resolveDataSource: async () => undefined };

export interface BuilderPreviewRuntimeOptions {
  /**
   * Resolves `select` options while authoring. Without one a data-source-backed select
   * previews with only its placeholder — the host supplies its real resolver to see the
   * options an end user would.
   */
  dataSourceResolver?: DataSourceResolver | undefined;
  /**
   * The host's wiring-time data sources (`defineDataSources`), asked before
   * {@link dataSourceResolver} for a component naming one of their ids — the same precedence
   * the live renderer applies, so the canvas shows what the form will.
   */
  dataSources?: DataSourceSet | undefined;
  locale?: string | undefined;
  /**
   * The definition's translations, the map the renderer words every authored text
   * from under a non-default locale. The builder's controller holds the committed map and hands
   * it here (and again through {@link BuilderPreviewRuntime.setTranslations} after each edit), so
   * the canvas says "Nom complet" when the preview language is French. Without one every text
   * reads in the default language, as a form that declares no translations does.
   */
  translations?: FormTranslations | undefined;
  /**
   * The host's translation catalog (`FormRuntimeDependencies.translationCatalog`), asked before
   * the map in the resolution order, so a host-supplied wording shows on the canvas as it
   * will in the form.
   */
  translationCatalog?: TranslationCatalog | undefined;
  /**
   * The calendar day the rules read (`today()`, `age()`), `YYYY-MM-DD`. Without one the
   * orchestrator evaluates a day-reading rule with no day; Logic's Try it passes
   * the day the author chose.
   */
  today?: string | undefined;
  /**
   * The plugin formula functions, by name: what `FormulaFunctionRegistry.functions()`
   * returns. Handed to the orchestrator on every rule context, so a rule calling `double(x)`
   * works out the same number on the canvas and in Logic's Try it as it does in the form.
   * Without any, a call to a plugin function reads as no function and the rule gives nothing.
   */
  functions?: Record<string, (args: unknown[]) => unknown> | undefined;
  /**
   * The function signatures a rule still written as text is parsed against: the built-ins'
   * followed by the plugins' (`formulaSignatures(registry)`). Without them the orchestrator
   * knows the built-ins only, and a tree rule calling a plugin function parses as unknown.
   */
  signatures?: readonly FormulaFunctionSignature[] | undefined;
  /**
   * The form's `localization` block, read when the renderer asks: what a language switcher
   * the author placed in the form's own chrome offers on the canvas. A function,
   * because the block is the controller's and changes with the Form panel's Save; without one
   * the canvas draws no switcher, as a form declaring no locales would.
   */
  localization?: (() => LocalizationConfiguration | undefined) | undefined;
  /**
   * The definition's `pdf` block, read when a PDF is rendered from the preview: Try it's Preview
   * PDF on the form's canvas then prints the layout the answers choose, as
   * the form would. A function, because the PDF designer holds the block and edits it; without
   * one, or with none declared, the PDF is the one the engine derives from the form.
   */
  pdfConfiguration?: (() => PdfConfiguration | undefined) | undefined;
}

/** What {@link BuilderPreviewRuntime.setFormRoot} draws the tree as, besides the tree itself. */
export interface BuilderPreviewRootOptions {
  /**
   * The journey page the tree is drawn as (one journey step on the edit canvas): the renderer
   * then draws the page's own heading, counter, Back and Continue around it, as the live form
   * does, from {@link BuilderPreviewRuntime.journeyView}. `undefined` (the Form canvas) draws the
   * tree as the whole form. Never saved: it is the canvas's, worked out from the designer's tree.
   */
  journeyView?: JourneyView | undefined;
}

/**
 * The design-time stand-in for `FormRuntime` that drives the builder canvas's preview.
 *
 * It satisfies {@link RenderHostRuntime} structurally, so `<datum-form-renderer>` drives it
 * exactly as it drives a live form — which is the whole point: the canvas renders through the
 * real renderer rather than a second, drifting approximation of it.
 *
 * `FormRuntime` itself is the wrong tool here. It requires a `ValidationPipeline` and a
 * `SubmissionModeRegistry` the builder has no business inventing, and it owns drafts,
 * submission and plugins that mean nothing while authoring. What the preview actually needs
 * is the recompute layer: {@link RuntimeOrchestrator} evaluates `rules.visibleWhen` /
 * `enabledWhen` / `readonlyWhen` / `requiredWhen` against a scratch value store, so
 * conditional logic behaves on the canvas the way it will in the form. The canvas's required
 * marker therefore reads as the form's: Required OR Required when, so a ticked field
 * keeps its asterisk while its rule is false.
 */
export class BuilderPreviewRuntime implements RenderHostRuntime {
  private readonly bus = new EventBus();
  private readonly store: FormStateStore;
  private resolver: DataSourceResolver;
  private dataSources: DataSourceSet | undefined;
  private todayValue: string | undefined;
  /** What the rules' `host.` paths read: Try it's Settings' host values, preview state only (see {@link setHostContext}). */
  private hostContextValue: Record<string, unknown> | undefined;
  private functionsValue: Record<string, (args: unknown[]) => unknown> | undefined;
  private signaturesValue: readonly FormulaFunctionSignature[] | undefined;
  private translationsValue: FormTranslations | undefined;
  private translationCatalogValue: TranslationCatalog | undefined;
  private readonly localizationSource: (() => LocalizationConfiguration | undefined) | undefined;
  private readonly pdfSource: (() => PdfConfiguration | undefined) | undefined;
  private root: ComponentNode;
  private tree: ComponentTree;
  private orchestrator: RuntimeOrchestrator;
  /** Serialized `root`, to tell a real edit from a repaint. See {@link setFormRoot}. */
  private rootKey: string;
  /** The journey page the tree is drawn as, when it is drawn as one (see {@link setFormRoot}). */
  private journeyViewValue: JourneyView | undefined;
  /** Serialized {@link journeyViewValue}: part of what tells a real change from a repaint. */
  private journeyViewKey = "null";
  /** The errors Try it's submit put on the form; none until it does. */
  private errorList: FormError[] = [];
  /** The tree's collection-bound containers by collection path, read with each tree. */
  private collections = new Map<string, PreviewCollection>();

  constructor(root: ComponentNode, options: BuilderPreviewRuntimeOptions = {}) {
    this.store = new FormStateStore(options.locale ?? "en");
    this.resolver = options.dataSourceResolver ?? NO_DATA_SOURCES;
    this.dataSources = options.dataSources;
    this.localizationSource = options.localization;
    this.pdfSource = options.pdfConfiguration;
    this.todayValue = options.today;
    this.functionsValue = options.functions;
    this.signaturesValue = options.signatures;
    this.translationsValue = options.translations;
    this.translationCatalogValue = options.translationCatalog;
    this.root = root;
    this.rootKey = JSON.stringify(root);
    this.tree = new ComponentTree(root);
    this.orchestrator = this.buildOrchestrator();
    // A data grid opens with its starting rows, as the form's runtime opens it.
    this.readCollections();
    this.seedStartingRows();
    this.recompute();
  }

  /**
   * The collection-bound containers of the tree: each one's entry fields (the
   * binding's, else its children's keys), its row operations and, for a data grid, its starting
   * rows and fixed maximum, as `FormRuntime.registerCollections` reads them.
   */
  private readCollections(): void {
    const root = normalizeDataGrids(this.root);
    const rowFields = kernelRowFields(root);
    const collections = new Map<string, PreviewCollection>();
    const walk = (node: ComponentNode): void => {
      const collectionPath = collectionPathOf(node);
      if (collectionPath !== undefined && node.collection) {
        const listed = Array.isArray(node.collection.itemFields) && node.collection.itemFields.length > 0 ? node.collection.itemFields : undefined;
        const settings = isDataGrid(node) ? dataGridSettingsOf(node) : undefined;
        const members = Object.keys(rowFields).filter((id) => (rowFields[id] as { collection: string }).collection === collectionPath);
        collections.set(collectionPath, {
          componentId: node.id,
          itemFields: listed ?? members.map((id) => (rowFields[id] as { suffix: string }).suffix.slice(1)),
          componentIds: new Set([node.id, ...members]),
          operations: rowOperationsOf(node),
          initialRows: settings?.initialRows ?? 0,
          maxRows: settings?.maxRows
        });
      }
      for (const children of Object.values(node.children ?? {})) {
        for (const child of children ?? []) {
          walk(child);
        }
      }
    };
    walk(root);
    this.collections = collections;
  }

  /** How many entries of a collection the answers hold a key for (an empty row's keys included). */
  private entryCount(collectionPath: string): number {
    let count = 0;
    for (const key of Object.keys(this.store.readView().values)) {
      const entry = previewEntryOf(key, collectionPath);
      if (entry !== undefined && entry.index + 1 > count) {
        count = entry.index + 1;
      }
    }
    return count;
  }

  /**
   * Gives every data grid that holds no entry its starting rows: empty rows, a key per
   * field holding `undefined`, so the renderer draws them and Try it's checks count them. Not
   * marked typed: nobody typed anything.
   */
  private seedStartingRows(): void {
    for (const [collectionPath, collection] of this.collections) {
      if (collection.initialRows === 0 || this.entryCount(collectionPath) > 0) {
        continue;
      }
      for (let index = 0; index < collection.initialRows; index += 1) {
        for (const field of collection.itemFields) {
          this.store.setComputedValue(parseComponentPath(`${collectionPath}[${index}].${field}`), undefined);
        }
      }
    }
  }

  /** A collection's rows as the answers hold them: one object per entry, a key per field. */
  private rowsOf(collectionPath: string, collection: PreviewCollection): Record<string, unknown>[] {
    const values = this.store.readView().values;
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < this.entryCount(collectionPath); index += 1) {
      rows.push(Object.fromEntries(collection.itemFields.map((field) => [field, undefined])));
    }
    for (const key of Object.keys(values)) {
      const entry = previewEntryOf(key, collectionPath);
      if (entry !== undefined) {
        (rows[entry.index] as Record<string, unknown>)[entry.field] = values[key];
      }
    }
    return rows;
  }

  private requireCollection(collectionPath: string): PreviewCollection {
    const collection = this.collections.get(collectionPath);
    if (!collection) {
      throw new Error(`Unknown collection: ${collectionPath}`);
    }
    return collection;
  }

  /**
   * A row operation's end: the rows written back as the collection's keys (marked as
   * the person's), the errors Try it put on the container and its rows' fields dropped — they
   * were about rows that moved, as a field's go when its value changes — the rules worked out again, and the change published, so the form is drawn again
   * and Try it's panel follows.
   */
  private writeRows(collectionPath: string, collection: PreviewCollection, rows: Record<string, unknown>[]): void {
    this.store.replaceCollectionValues(collectionPath, rows);
    const kept = this.errorList.filter((error) => error.componentId === undefined || !collection.componentIds.has(error.componentId));
    const dropped = kept.length !== this.errorList.length;
    this.errorList = kept;
    this.recompute();
    this.publish(FormEventType.COLLECTION_CHANGED);
    this.publish(FormEventType.COMPONENT_CHANGED, collectionPath);
    if (dropped) {
      this.publish(FormEventType.ERRORS_CHANGED);
    }
  }

  /** Appends an empty row (a data grid's Add), within the grid's fixed maximum. Returns its index. */
  public addRow(collectionPath: string, row: Record<string, unknown> = {}): number {
    const collection = this.requireCollection(collectionPath);
    if (collection.operations.add === false) {
      throw new Error(`Collection ${collectionPath} does not allow adding rows`);
    }
    const rows = this.rowsOf(collectionPath, collection);
    const limit = collection.maxRows ?? DATA_GRID_ROWS_CAP;
    if (rows.length + 1 > limit) {
      throw new Error(`Collection ${collectionPath} holds the most rows it may (${limit})`);
    }
    rows.push({ ...Object.fromEntries(collection.itemFields.map((field) => [field, undefined])), ...row });
    this.writeRows(collectionPath, collection, rows);
    return rows.length - 1;
  }

  /** Drops a row (a data grid's Remove). */
  public removeRow(collectionPath: string, rowIndex: number): void {
    const collection = this.requireCollection(collectionPath);
    if (collection.operations.remove === false) {
      throw new Error(`Collection ${collectionPath} does not allow removing rows`);
    }
    const rows = this.rowsOf(collectionPath, collection);
    if (rowIndex < 0 || rowIndex >= rows.length) {
      return;
    }
    rows.splice(rowIndex, 1);
    this.writeRows(collectionPath, collection, rows);
  }

  /** Moves a row (a data grid's Move up / Move down). */
  public reorderRow(collectionPath: string, fromIndex: number, toIndex: number): void {
    const collection = this.requireCollection(collectionPath);
    if (collection.operations.reorder === false) {
      throw new Error(`Collection ${collectionPath} does not allow reordering rows`);
    }
    const rows = this.rowsOf(collectionPath, collection);
    if (fromIndex < 0 || fromIndex >= rows.length || toIndex < 0 || toIndex >= rows.length) {
      return;
    }
    const [moved] = rows.splice(fromIndex, 1);
    rows.splice(toIndex, 0, moved as Record<string, unknown>);
    this.writeRows(collectionPath, collection, rows);
  }

  private buildOrchestrator(): RuntimeOrchestrator {
    return new RuntimeOrchestrator(this.tree, {
      eventBus: this.bus,
      formId: PREVIEW_FORM_ID,
      ...(this.todayValue !== undefined ? { today: () => this.todayValue } : {}),
      ...(this.hostContextValue !== undefined ? { hostContext: this.hostContextValue } : {}),
      ...(this.functionsValue !== undefined ? { functions: this.functionsValue } : {}),
      ...(this.signaturesValue !== undefined ? { signatures: this.signaturesValue } : {}),
      applyComputedValue: (componentId, value) => {
        // An id that is not a path segment (a space, a dot) cannot hold a computed value: the
        // component simply shows none, and the id is a Problem at Save (`component.id.invalid`),
        // not an exception out of the canvas build.
        let path: ReturnType<typeof parseComponentPath>;
        try {
          path = parseComponentPath(componentId);
        } catch {
          return;
        }
        this.store.setComputedValue(path, value);
      }
    });
  }

  private recompute(): void {
    this.orchestrator.recompute(this.store.snapshot());
  }

  /**
   * Adopts an edited tree while **keeping the value store**. A builder emits a change on every
   * keystroke in the property inspector; rebuilding the whole preview each time would wipe
   * whatever the author had typed into the canvas to exercise their own conditional rules.
   *
   * A tree whose rules form a calculation cycle makes `RuntimeOrchestrator` throw. That is a
   * transient state while authoring — the previous orchestrator is kept so the canvas goes on
   * rendering the last coherent tree rather than going blank mid-edit.
   *
   * Callers hand over a fresh clone each time (a builder snapshot), so the guard compares the
   * serialized tree: a selection change or a panel repaint must not cost a rebuild and a
   * repaint of the whole form.
   *
   * `options.journeyView` draws the tree as one journey page (see
   * {@link BuilderPreviewRootOptions}). It is part of the same guard: the page's title, its
   * place among the steps and its Back are not in the tree, so a change of either the tree or
   * the view is drawn, once (one `FORM_INITIALIZED`), and a repaint over both unchanged draws
   * nothing. A tree that cannot be read (a root `ComponentTree` refuses) is not taken: the last
   * one that could goes on being drawn, with the view it was drawn as, and nothing is thrown at
   * the paint. Two nodes under one id are taken, not refused (the Form canvas draws a loaded
   * definition's duplicate as two boxes and goes on drawing every edit).
   */
  public setFormRoot(root: ComponentNode, options: BuilderPreviewRootOptions = {}): void {
    const nextKey = JSON.stringify(root);
    const journeyView = options.journeyView;
    const nextViewKey = journeyView === undefined ? "null" : JSON.stringify(journeyView);
    const treeChanged = nextKey !== this.rootKey;
    if (!treeChanged && nextViewKey === this.journeyViewKey) {
      return;
    }
    if (treeChanged) {
      // A tree holding an id twice is taken as it always was (a definition loaded whole is never
      // checked for one, so the Form canvas must go on drawing its edits); the step canvas's
      // adapter draws no id twice. Only an unreadable root (no id) is refused, never thrown.
      let nextTree: ComponentTree;
      try {
        nextTree = new ComponentTree(root);
      } catch {
        return;
      }
      const previousTree = this.tree;
      const previousOrchestrator = this.orchestrator;
      this.tree = nextTree;
      try {
        this.orchestrator = this.buildOrchestrator();
      } catch {
        this.tree = previousTree;
        this.orchestrator = previousOrchestrator;
        return;
      }
      this.root = root;
      this.rootKey = nextKey;
      // A grid the edit brought (or one left with no row) opens with its starting rows.
      this.readCollections();
      this.seedStartingRows();
      this.recompute();
    }
    this.journeyViewValue = journeyView;
    this.journeyViewKey = nextViewKey;
    this.publish(FormEventType.FORM_INITIALIZED);
  }

  /**
   * The journey page the tree is drawn as (`FormRuntime.journeyView`, read by the renderer for
   * the page's heading, counter and buttons); `undefined` while it is drawn as the whole form.
   */
  public journeyView(): JourneyView | undefined {
    return this.journeyViewValue;
  }

  public setDataSourceResolver(resolver: DataSourceResolver | undefined): void {
    const next = resolver ?? NO_DATA_SOURCES;
    if (next === this.resolver) {
      return;
    }
    this.resolver = next;
    this.publish(FormEventType.FORM_INITIALIZED);
  }

  public setDataSources(dataSources: DataSourceSet | undefined): void {
    if (dataSources === this.dataSources) {
      return;
    }
    this.dataSources = dataSources;
    this.publish(FormEventType.FORM_INITIALIZED);
  }

  /**
   * Adopts the plugin functions a host wired after the preview was built (a `plugins.register`
   * on a page whose builder is already up). The orchestrator reads its functions once, so it is
   * rebuilt over the same tree and the rules recomputed; the values the author typed stay.
   */
  public setFunctions(
    functions: Record<string, (args: unknown[]) => unknown> | undefined,
    signatures?: readonly FormulaFunctionSignature[]
  ): void {
    if (functions === this.functionsValue && signatures === this.signaturesValue) {
      return;
    }
    this.functionsValue = functions;
    this.signaturesValue = signatures;
    const previousOrchestrator = this.orchestrator;
    try {
      this.orchestrator = this.buildOrchestrator();
    } catch {
      this.orchestrator = previousOrchestrator;
      return;
    }
    this.recompute();
    this.publish(FormEventType.FORM_INITIALIZED);
  }

  /**
   * Adopts the controller's committed translations map: a Languages Apply, an inspector
   * edit of a wording or a rename reaches the canvas through this, without a tree reset. The
   * map is the controller's own and replaced whole on every write, so identity tells a change.
   */
  public setTranslations(translations: FormTranslations | undefined): void {
    if (translations === this.translationsValue) {
      return;
    }
    this.translationsValue = translations;
    this.publish(FormEventType.FORM_INITIALIZED);
  }

  /** Adopts the host's translation catalog after the preview was built (the shell sets it late). */
  public setTranslationCatalog(catalog: TranslationCatalog | undefined): void {
    if (catalog === this.translationCatalogValue) {
      return;
    }
    this.translationCatalogValue = catalog;
    this.publish(FormEventType.FORM_INITIALIZED);
  }

  /** The definition's translations, as `FormRuntime.translations()` offers them to the renderer. */
  public translations(): FormTranslations | undefined {
    return this.translationsValue;
  }

  /** The host's translation catalog, as `FormRuntime.translationCatalog()` offers it. */
  public translationCatalog(): TranslationCatalog | undefined {
    return this.translationCatalogValue;
  }

  public setLocale(locale: string): void {
    if (this.store.snapshot().locale === locale) {
      return;
    }
    this.store.setLocale(locale);
    this.recompute();
    this.publish(FormEventType.LOCALE_CHANGED);
  }

  /** The form's `localization` block, for the chrome's language switcher (see the option). */
  public localization(): LocalizationConfiguration | undefined {
    return this.localizationSource?.();
  }

  /** The definition's `pdf` block, for a PDF rendered from the preview (see the option). */
  public pdfConfiguration(): PdfConfiguration | undefined {
    return this.pdfSource?.();
  }

  /**
   * Empties the answers typed into the preview (Try it's Clear answers): the rules are
   * worked out again over none, the errors Try it put on the form go, and the form is drawn afresh.
   */
  public clearValues(): void {
    this.store.hydrate({ values: {}, touched: [], dirty: [], locale: this.store.snapshot().locale });
    this.errorList = [];
    // Answers cleared, the form opens as it first did: each data grid with its starting rows.
    this.seedStartingRows();
    this.recompute();
    this.publish(FormEventType.FORM_INITIALIZED);
  }

  /**
   * Takes another runtime's answers wholesale (Try it's session ending): every key
   * but this store's own "@" ones is replaced, so a field cleared or a collection row removed
   * there is gone here too. `dirty` names the answers typed there; nothing else is marked typed,
   * so a calculation's or a default's value stays nobody's answer.
   */
  public replaceValues(values: Record<string, unknown>, dirty: Iterable<string> = []): void {
    const state = this.store.snapshot();
    const kept = Object.fromEntries(Object.entries(state.values).filter(([key]) => key.startsWith("@")));
    const next = { ...kept, ...Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith("@"))) };
    this.store.hydrate({ values: next, touched: [...state.touched], dirty: [...dirty], locale: state.locale });
    this.recompute();
    this.publish(FormEventType.FORM_INITIALIZED);
  }

  /**
   * The answers as a submission would carry them, from the last recompute (`FormRuntime`'s
   * own): what a PDF layout's `when` reads to choose the layout, calculations
   * included and hidden answers left out as the form's policy says.
   */
  public submittableValues(): Record<string, unknown> {
    return this.orchestrator.effectiveValues();
  }

  /**
   * Sets the calendar day the rules read (`today()`, `age()`), `YYYY-MM-DD`, or none with
   * `undefined`: Show me puts a scenario's `given today` here for the showing and the day it
   * found back after. The orchestrator takes its day when it is made, so it is made
   * again over the same tree, as {@link setFunctions} does, and the rules worked out again; the
   * values typed stay.
   */
  public setToday(day: string | undefined): void {
    const next = day === "" ? undefined : day;
    if (next === this.todayValue) {
      return;
    }
    const previousDay = this.todayValue;
    const previousOrchestrator = this.orchestrator;
    this.todayValue = next;
    try {
      this.orchestrator = this.buildOrchestrator();
    } catch {
      this.todayValue = previousDay;
      this.orchestrator = previousOrchestrator;
      return;
    }
    this.recompute();
    this.publish(FormEventType.FORM_INITIALIZED);
  }

  /**
   * Sets what the rules' `host.` paths read (the host values the author gives Try it's Settings),
   * or none with `undefined`. The orchestrator takes the new record in place, so no rebuild: the
   * rules, calculations and worked-out values are computed again over the answers typed, which
   * stay, and the form is drawn once. A record equal to the one held changes nothing. The
   * caller hands plain JSON data (`plainHostContext`); it is copied, never held.
   */
  public setHostContext(context: Record<string, unknown> | undefined): void {
    const next = context === undefined ? undefined : (JSON.parse(JSON.stringify(context)) as Record<string, unknown>);
    if (JSON.stringify(next ?? null) === JSON.stringify(this.hostContextValue ?? null)) {
      return;
    }
    this.hostContextValue = next;
    this.orchestrator.setHostContext(next);
    this.recompute();
    this.publish(FormEventType.FORM_INITIALIZED);
  }

  /** What the rules' `host.` paths read now; `undefined` when none was given. */
  public hostContext(): Record<string, unknown> | undefined {
    return this.hostContextValue;
  }

  /** The day the rules read, when one was given (Logic's Try it); "" otherwise, and a PDF takes the local date. */
  public today(): string {
    return this.todayValue ?? "";
  }

  private publish(type: string, componentId?: string): void {
    this.bus.publish({
      id: `${type}_${Date.now()}`,
      type,
      timestamp: Date.now(),
      source: "builder",
      formId: PREVIEW_FORM_ID,
      ...(componentId ? { componentId } : {})
    });
  }

  // --- RenderHostRuntime -----------------------------------------------

  public formRoot(): ComponentNode {
    return this.root;
  }

  public state(): FormState {
    return this.store.snapshot();
  }

  /**
   * The errors {@link setErrors} put on the form, else none: validation is a host-supplied
   * pipeline, not something a tree implies.
   */
  public errors(): FormError[] {
    return this.errorList;
  }

  /**
   * Puts errors on the form, as `FormRuntime.setErrors` does for a host: Try it's
   * submit, with the checks' problems or a stand-in server's refusal. The renderer
   * draws them at their fields and in the summary; a field's drop when its value changes, and
   * an empty list clears them all.
   */
  public setErrors(errors: FormError[]): void {
    if (errors.length === 0 && this.errorList.length === 0) {
      return;
    }
    this.errorList = errors.map((error) => ({ ...error }));
    this.publish(FormEventType.ERRORS_CHANGED);
  }

  public effectiveStatesMap(): ReadonlyMap<string, EffectiveNodeState> {
    return this.orchestrator.effectiveStates();
  }

  public requiredMap(): ReadonlyMap<string, boolean> {
    return this.orchestrator.requiredComponents();
  }

  /**
   * The components whose Validate rule (`rules.validWhen`) does not hold over the
   * answers, id -> `true`: the field-constraints stage's `invalidComponents`, from the same fold
   * as {@link requiredMap}.
   */
  public invalidMap(): Record<string, boolean> {
    return this.orchestrator.invalidComponents();
  }

  public componentTree(): ComponentTree {
    return this.tree;
  }

  /** The host's wiring-time set first, then its resolver — the live renderer's own precedence. */
  public resolveDataSource: DataSourceResolver["resolveDataSource"] = (request) => {
    const state = this.store.snapshot();
    return (
      resolveThroughDataSourceSet(this.dataSources, {
        node: this.tree.find(request.componentId),
        request,
        locale: state.locale,
        values: state.values
      }) ?? this.resolver.resolveDataSource(request)
    );
  };

  public events(): EventBus {
    return this.bus;
  }

  /** Writing a value re-evaluates the rules, so conditional fields react on the canvas. */
  public setValue(componentId: string, value: unknown): void {
    const path = parseComponentPath(componentId);
    this.store.setValue(path, value);
    this.recompute();
    // The field's errors were about the old value: they go with it, the form's own stay.
    const leaf = path.segments[path.segments.length - 1]?.key;
    const kept = this.errorList.filter((error) => error.componentId === undefined || (error.componentId !== componentId && error.componentId !== leaf));
    const dropped = kept.length !== this.errorList.length;
    this.errorList = kept;
    this.publish(FormEventType.COMPONENT_CHANGED, componentId);
    if (dropped) {
      this.publish(FormEventType.ERRORS_CHANGED);
    }
  }

  /** No-op: the preview has no validation pipeline to run. */
  public validate(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
}
