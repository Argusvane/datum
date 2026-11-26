import type { ComponentNode, ChildrenDefinition } from "./types.js";
import type { FormHooks } from "../events/hooks.js";
import type { FormTextCatalog } from "../localization/form-texts.js";
import type { SubmissionHandlerDefinition } from "../submission/submission-handler.js";

export interface PropertyEditorContext {
  component: ComponentNode;
}

/**
 * Text a host hands in with its words in several languages: a bare string, or the
 * default with one entry per locale, resolved by `resolveLocalizedText`. Host data only — a
 * data source's items, the renderer's own words (`FormTextCatalog`), binding and editor labels,
 * the parts a host adds through `<datum-form-renderer>.chrome`, its `messages` catalog. No type
 * of a form definition carries it: a form's texts are strings in its default language, with
 * their translations in `FormDefinition.translations` (`core/localization/translations.ts`).
 */
export type LocalizedText =
  | string
  | {
      default: string;
      locales?: Record<string, string>;
    };

/**
 * A host's translations for a form: locale → kind → owner → property tree, with
 * string leaves, addressed exactly as the definition's own map is. An entry here overrides the
 * form's for the same address. Defined beside the map in `translations.ts`, which reads it.
 */
export type { TranslationCatalog } from "../localization/translations.js";

export type PropertyEditorFieldType =
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "expression"
  | "component-selector"
  | "data-source-selector"
  | "color"
  | "localized-text"
  /** Inline `{ value, label }` options (`core/schema/inline-options.ts`); the panel opens an editor for them. */
  | "options-editor"
  /**
   * Validation text per error code (`core/localization/validation-messages.ts`);
   * the panel opens the same table editor, one row per code.
   */
  | "messages-editor"
  /**
   * A chrome region's parts (`core/schema/form-chrome.ts`): the form root's header
   * or footer; the panel opens a parts editor for it.
   */
  | "chrome-editor"
  /**
   * A file kept in the configuration as an attachment envelope (`core/schema/file-upload.ts`:
   * `{ storage: "base64", name, type, size, data }`); the panel offers a picker and shows
   * what is set. For assets a document carries with it, such as an ICC profile.
   */
  | "file"
  /**
   * A value path typed freely, with the form's saved paths offered as suggestions (the
   * Data workspace's list); whoever supplies the field's choices names them.
   */
  | "path"
  /**
   * A formula written in the Rules tab's formula editor (live draft, lint, "Reads as"); the
   * value is what a rule stores: the formula string, an expression tree, or `{ formula, run }`.
   */
  | "formula"
  /**
   * A table translating one set of values into another (`PropertyEditorField.valueMap`), stored
   * as an object of strings at the field's path: the PDF designer's answer-to-export-value map
   *. A row set to its own value, or to nothing, writes no entry.
   */
  | "value-map"
  | "custom";

export interface PropertyEditorChoice {
  value: string;
  label: LocalizedText;
}

/**
 * A ready-made value a `file` field offers beside uploading: the attachment envelope it
 * writes (`storage` + what that storage needs — a built-in asset the kernel carries, or one
 * the host stores), what the picker calls it, and the group it is listed under.
 */
export interface PropertyEditorAssetChoice {
  id: string;
  label: LocalizedText;
  /** The picker's group heading ("Built in", "From the host"). Absent: listed ungrouped. */
  group?: LocalizedText;
  source: { storage: string; name: string; type: string; size: number; ref?: unknown; data?: string };
}

export interface PropertyEditorField {
  id: string;
  type: PropertyEditorFieldType;
  propertyPath: string;
  label?: LocalizedText;
  description?: LocalizedText;
  /**
   * Choices for a `select`-rendered field. Without these a `select` field has no options to
   * offer, so a contributor supplying `type: "select"` is expected to supply these too.
   */
  choices?: PropertyEditorChoice[];
  /**
   * What the editor shows while the configuration does not set the property. Display only:
   * nothing is written until the author changes it, so a form that never touches the field
   * keeps relying on the reader's own default. Declare it wherever that default is not the
   * empty value a blank control implies — a switch that is on unless turned off, a scale of 1.
   */
  defaultValue?: unknown;
  /** Bounds and increment for a `number` field; omitted, the control accepts any number. */
  min?: number;
  max?: number;
  step?: number;
  /** What a `file` field's picker offers (`accept` as an `<input type="file">` takes it: types and extensions). */
  accept?: string;
  /** Ready-made values a `file` field offers beside uploading, each written as it is. */
  assetChoices?: PropertyEditorAssetChoice[];
  /**
   * Drawn only while another property of the same component holds a value: `{ propertyPath,
   * equals }` (the inspector reads the draft). Any other shape leaves the field always drawn.
   */
  visibleWhen?: unknown;
  disabledWhen?: unknown;
  /**
   * What a `value-map` field translates: a row per value to translate, the values each may be
   * translated to, and the map that pairs row i with target i (the "Match by order" button
   * writes it whole). The stored object is `{ [row.value]: target.value }`.
   */
  valueMap?: PropertyEditorValueMap;
}

export interface PropertyEditorValueMap {
  rows: Array<{ value: string; label: LocalizedText }>;
  targets: PropertyEditorChoice[];
  byOrder: Record<string, string>;
  /** The row choice that writes no entry ("Same value"). */
  sameLabel: LocalizedText;
  /** The button that writes `byOrder`; `byOrderHint` is its tooltip. */
  byOrderLabel: LocalizedText;
  byOrderHint?: LocalizedText;
  /**
   * The stored entries (by key) that no longer match anything: an answer the source lost, a
   * target the PDF field does not list. When any, a second button removes them from the map
   * (`removeStaleLabel`, `removeStaleHint`); nothing prunes them otherwise.
   */
  stale?: string[];
  removeStaleLabel?: LocalizedText;
  removeStaleHint?: LocalizedText;
}

export interface PropertyEditorSection {
  id: string;
  title?: LocalizedText;
  fieldIds: string[];
  /**
   * Not drawn when none of its fields is present for the node (a field a capability adds only
   * where it applies, or one `visibleWhen` hides). Off by default: every other section draws its
   * heading whatever it holds.
   */
  hideWhenEmpty?: boolean;
}

export interface PropertyEditorFeature {
  id: string;
  label: LocalizedText;
  isAvailable(context: PropertyEditorContext): boolean;
  execute?(context: PropertyEditorContext): void;
  render?(context: PropertyEditorContext): unknown;
}

export interface PropertyEditorContribution {
  fields?: PropertyEditorField[];
  sections?: PropertyEditorSection[];
  features?: PropertyEditorFeature[];
}

export type ComponentUpdater = (configuration: Record<string, unknown>) => void;

export interface ComponentEditorContext {
  component: ComponentNode;
  get<T>(path: string): T | undefined;
  set<T>(path: string, value: T): void;
  remove(path: string): void;
  update(updater: ComponentUpdater): void;
}

export interface PluginDependency {
  id: string;
  versionRange?: string;
}

export interface CapabilityDefinition {
  id: string;
  version: string;
  configureEditor?(context: PropertyEditorContext): PropertyEditorContribution;
  apply(component: ComponentNode, configuration: unknown): ComponentNode;
}

export interface ValidationResult {
  errors: Array<{
    code: string;
    componentId?: string;
    path?: string;
    stage: string;
    source: "client" | "wasm" | "server" | "custom";
    severity?: "error" | "warning" | "info";
    parameters?: Record<string, unknown>;
  }>;
}

/** The levels a run log records at. */
export type ValidationLogLevel = "debug" | "info" | "warn" | "error";

/** What a run keeps: entries at this level and above, or nothing at all. */
export type ValidationLogThreshold = ValidationLogLevel | "off";

/** One entry of a run log: plain data, so every host reads the same log for the same run. */
export interface ValidationLogEntry {
  level: ValidationLogLevel;
  message: string;
  data?: unknown;
}

/**
 * The log a sandbox validator writes to as `context.log`. Entries at or above the
 * run's threshold are kept, in order, and returned with the outcome for the host to forward
 * to a logger of its own; the sandbox itself has no console and no I/O. `data` must be plain
 * data — no error stacks, nothing engine-specific — so the same run yields the same log on
 * every host, and the parity tests hold.
 */
export interface ValidationLog {
  readonly level: ValidationLogThreshold;
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface ValidationContext {
  values: Record<string, unknown>;
  formId: string;
  locale?: string;
  externalData?: Record<string, unknown>;
  /** The run log, present when the sandbox kernel runs the validator. */
  log?: ValidationLog;
  /**
   * Each component's requiredness from the runtime's last recompute: `configuration.required`
   * OR its `rules.requiredWhen` holding over the settled view, before the hidden-required
   * policy. `FormRuntime` sets it for its pipeline; absent, the field-constraints
   * stage reads the static flag alone. Not part of the sandbox ABI: `WasmSubmissionContext`
   * leaves it out and `JsonWasmAbi.serializeContext` drops it should a spread carry it, and the
   * kernel works it out for itself from the same fold.
   */
  requiredComponents?: Readonly<Record<string, boolean>>;
  /**
   * Component id -> `true` where the field's `rules.validWhen` does not hold over the runtime's
   * settled view: the fold's `invalid`, which `FormRuntime` and the builder's Try it
   * set beside `requiredComponents`, and the field-constraints stage then refuses a non-empty
   * answer with `rule`. Browser-only like that map: it never crosses to the sandbox
   * (`WasmSubmissionContext` leaves it out and `JsonWasmAbi.serializeContext` drops it by name),
   * which works the rule out itself. No ABI change.
   */
  invalidComponents?: Readonly<Record<string, boolean>> | undefined;
  /**
   * What the controls know that their stored values cannot say, by value path: a
   * date typed in part (`incomplete`, naming the parts still empty) or a number box holding
   * text the browser could not read (`badInput`); both store the empty answer. `FormRuntime`
   * sets it for its stages from `setInputState`, and the field-constraints stage then raises
   * `dateIncomplete` or `number` in place of `required`. Client-only, like
   * `requiredComponents`: never in a draft or the envelope, and `WasmSubmissionContext` leaves
   * it out (`JsonWasmAbi.serializeContext` drops it by name).
   */
  inputStates?: Readonly<Record<string, { incomplete?: { missing: ReadonlyArray<"day" | "month" | "year"> }; badInput?: true }>>;
  /**
   * Aborted when the run this context belongs to goes stale: a newer check of the same value
   * path replaced it (`FormRuntime`'s per-path runs). An async stage doing I/O should pass it on
   * (`fetch(url, { signal })`) and stop; one that ignores it still has its result dropped.
   * Browser-only and absent on a form-wide run: `WasmSubmissionContext` leaves it out and
   * `JsonWasmAbi.serializeContext` drops it by name.
   */
  signal?: AbortSignal;
}

export interface ValidationStage {
  id: string;
  version: string;
  /**
   * `deterministic` (default) stages must be pure and are eligible for cross-runtime
   * parity execution; `async` stages may perform I/O and always run after every
   * deterministic stage.
   */
  kind?: "deterministic" | "async";
  /** When present and it returns false, the stage is skipped for this context. */
  runIf?(context: ValidationContext): boolean;
  /**
   * The value paths an `async` stage judges (`"email"`, `"items[1].sku"`). While the stage runs
   * those fields are pending (`FormState.validation.pending`), and a check of one path
   * (`ValidationPipeline.runFor`) runs only the async stages that declare it. An async stage
   * without it is form-wide: it runs on every whole-form check, marks no field pending and
   * never runs for a single path.
   */
  paths?(context: ValidationContext): readonly string[];
  validate(context: ValidationContext): ValidationResult | Promise<ValidationResult>;
}

/** Where a builder or PDF theme comes from: the design system it was read from. */
export interface ThemeSource {
  /** The design system's name, as it names itself ("GC Design System"). */
  name: LocalizedText;
  /** Its home page or documentation site. */
  url?: string;
  /** The release, date or commit the theme's values were read from. */
  version?: string;
}

/**
 * One face a theme ships for the PDF kernel: TrueType or OpenType bytes the host loads and
 * hands to its font provider when a document names the family. The kernel program embeds
 * TrueType and OpenType only: the host converts a WOFF 1.0 file on load (`woffToSfnt`), and
 * WOFF2 is not read.
 */
export interface ThemeFontFace {
  /** The family name the theme's `pdf.typography` uses (`"Noto Sans"`). */
  family: string;
  /** CSS weight; 400 regular, 700 bold. Default 400. */
  weight?: number;
  style?: "normal" | "italic";
  /** The font file, relative to the bundle's own URL like `stylesheets`, or absolute. */
  file: string;
  /** Unicode script tags (`Latn`, `Cyrl`, …) the face covers. Default `["Latn"]`. */
  coverage?: string[];
}

/** What a builder or PDF theme asks the page to load. */
export interface ThemeAssets {
  /** Stylesheet hrefs, relative to the bundle's own URL or absolute. */
  stylesheets?: string[];
  /**
   * Faces the PDF kernel embeds for the families a PDF theme's typography names. They live
   * here, with the stylesheets, because they are the same kind of thing: files served beside
   * the bundles and named relative to them. The kernel never reads this — the engine forwards
   * the faces a document needs in its font need, and the host's provider loads the files.
   */
  fonts?: ThemeFontFace[];
}

export interface DataSourceDefinition {
  id: string;
  providerId: string;
  version: string;
  defaultQuery?: Record<string, unknown>;
}

/**
 * A PDF rendition's drawing ({@link PdfRenditionDeclaration.render}):
 * the node and a render-layer context, typed `unknown` here because core cannot name the render
 * layer's types; the PDF layer narrows both (`asPdfRenderer`).
 */
export type ComponentRenderer = (node: ComponentNode, context: unknown) => unknown;

export interface PropertyEditorDefinition {
  mode: "default" | "extend" | "replace" | "none";
  fields?: PropertyEditorField[];
  sections?: PropertyEditorSection[];
  features?: PropertyEditorFeature[];
  render?(context: ComponentEditorContext): unknown;
}

/**
 * One way a component type can appear on paper: an AcroForm widget, its label and
 * value as text, a ruled line to write on. `render` receives the node and a render-layer
 * `PdfRenditionContext` (typed `unknown` here for the same layering reason as
 * {@link ComponentRenderer}) and returns the PDF blocks the kernel lays out.
 */
export interface PdfRenditionDeclaration {
  id: string;
  /** Shown where an author picks a rendition. */
  label?: LocalizedText;
  render: ComponentRenderer;
}

/**
 * A component type's PDF renditions and which one it takes when nothing chooses. A layout
 * binding, the instance's `configuration.pdf.rendition`, the layout's `renditionDefaults` and
 * the PDF theme all outrank `defaultRendition`; the engine's built-in table backs a type that
 * declares none.
 */
export interface ComponentPdfDefinition {
  renditions: PdfRenditionDeclaration[];
  defaultRendition: string;
}

/** A plugin giving an existing component type another rendition without owning its definition. */
export interface PdfRenditionContribution {
  componentType: string;
  rendition: PdfRenditionDeclaration;
}

/**
 * How a builder's palette lists a component type (see {@link ComponentDefinition.palette}):
 * the label under the type's glyph, the heading it is grouped under, and a one- or
 * two-character glyph in place of the palette's built-in icon for the type name.
 */
export interface ComponentPaletteEntry {
  label: string;
  /** The palette group; absent, the palette infers one from the type name (Fields / Choices / Layout / Content / Actions, else Other). */
  group?: string;
  /** A short text glyph (an emoji, a symbol); it is escaped, so it cannot carry markup. */
  icon?: string;
  /**
   * The id of the design-system binding the type belongs to (`gcds`): the builder offers it only
   * while that binding draws the canvas. Absent, it is offered under every binding.
   */
  binding?: string;
}

export interface ComponentDefinition {
  type: string;
  version: string;
  /**
   * For a type the engine does not know (a plugin's, a design-system binding's tier-2 type such as
   * `gcds-date`): the engine type it reads as (`date`), an answer base or a plain container base
   * (`core/schema/component-kinds.ts` `kernelIsKindBase`). The builder writes it into the saved
   * definition's `kinds` map for each such type the form uses, which is how validation, the
   * sandbox and the PDF treat the type as its base without this definition's code; the renderer
   * draws the type as its base meanwhile. Ignored on an engine type and for a base the map may
   * not hold.
   */
  base?: string;
  createDefault(): ComponentNode;
  capabilities: CapabilityDefinition[];
  children?: ChildrenDefinition;
  /**
   * How the type is drawn on a form and on the builder's canvas: the live renderer's adapter
   * for it (render/live `contract.ts`: a `FieldAdapter`, or a container's `GroupAdapter` /
   * `TabsAdapter` / `GridAdapter` / `StepsAdapter`), or a list of them chosen by their `when`, or
   * a factory of either, `(lit, datum) => entry`, called with the renderer's lit namespace and the
   * Datum binding: what a plugin built apart from the engine writes, so it never imports lit by
   * specifier. Typed `unknown` here because core cannot name the render layer's types; a host that
   * draws reads it as `plugins/component-adapters.ts` does and leaves out an entry of another shape. Optional: a type the
   * engine draws (`text`, `number`, a `fieldset`) needs none. Supply one to draw a type the
   * engine does not know, or to replace how a type it knows is drawn: it is laid over whatever
   * binding draws the form (`extendBinding`), so it draws the type under every binding. A type
   * that nothing draws shows the renderer's unknown-component note.
   */
  adapter?: unknown;
  /** The type's PDF renditions. */
  pdf?: ComponentPdfDefinition;
  /**
   * The palette entry a builder lists the type under, so a plugin's component reaches the
   * palette with nothing more than its definition (`paletteEntriesOf`). Absent, the type is
   * a host's to list through the builder's `componentTypes`, or is not offered at all — the
   * form root, a `step` outside its `steps`.
   */
  palette?: ComponentPaletteEntry;
  /**
   * The type's own stylesheet: rules for what its {@link adapter} draws, adopted into
   * the form's shadow root after the binding's own, on every form that draws the type under any
   * binding. What a component library ships so its components look like themselves wherever the
   * library is registered.
   */
  css?: string[];
  propertyEditor?: PropertyEditorDefinition;
  validators?: ValidationStage[];
  /**
   * The node stands for something outside the author's hands — a PDF template's own field,
   * listed from the file: its properties are edited, but the builder offers no
   * Delete for it and refuses to remove it, and it is never on the palette.
   */
  fixed?: boolean;
}

/**
 * A plugin's contribution to the WASM validation sandbox: a portable JS module.
 * `source` is an ES2020 program whose completion value is a module object
 * `{ validators?: Array<(context) => { errors }> }` — closure-free, deterministic, no I/O.
 * A validator may write to `context.log` (`debug` / `info` / `warn` / `error`); the run log
 * comes back with the outcome.
 * Hosts wire these into the sandbox they construct at startup; the sandbox's core kernel
 * already enforces schema-declared constraints (`required`/`pattern`), so a plugin module
 * is only needed for genuinely custom validation logic.
 *
 * The module may also carry the reserved key `functions: { name: fn }`, an object of
 * closure-free `(args: unknown[]) => unknown` functions that a formula can call by name. A
 * name that is a built-in formula function or already taken by another module is refused
 * when the module registers.
 */
export interface WasmPluginContribution {
  id: string;
  version: string;
  source: string;
}

/**
 * A formula function a plugin adds (a rule's `formula` text calls it by `name`). The function
 * is closure-free and deterministic so the sandbox can run it beside the browser: it gets the
 * evaluated arguments only and returns a plain value. `undefined` stands for "no value".
 */
export interface FormulaFunctionContribution {
  name: string;
  /** Parameter names; one ending in `?` is optional. A variadic function lists its one repeating name. */
  params: string[];
  variadic?: true;
  /** The fewest arguments accepted, when that differs from the count of required params. */
  min?: number;
  summary: string;
  example: string;
  returns?: "number" | "text" | "boolean" | "list" | "date";
  evaluate: (args: unknown[]) => unknown;
  /** Insertions the builder's formula editor offers for the function. */
  snippets?: Array<{ label: string; insert: string }>;
}

/**
 * A builder or PDF theme as a plugin carries it (`FormPlugin.builderThemes`,
 * `FormPlugin.pdfThemes`): the builder layer's `BuilderThemeDefinition` or the PDF layer's
 * `PdfThemeDefinition`, whose full shapes core cannot name. These are the fields such themes
 * have, the PDF settings typed loosely; the registry that takes the theme up reads it as its
 * full type.
 */
export type PluginThemeContribution<Target extends "builder" | "pdf"> = {
  id: string;
  version: string;
  target: Target;
  extends?: string;
  label?: LocalizedText;
  assets?: ThemeAssets;
  source?: ThemeSource;
  /** A PDF theme's `pdf` block (the PDF layer's `PdfThemeSettings`). */
  pdf?: unknown;
} & (Target extends "pdf"
  ? // A PDF theme has no tokens (its settings are the `pdf` block); at most the empty record.
    { tokens?: Record<string, never> }
  : // A builder theme's tokens are what it is made of.
    { tokens: Record<string, string> });

export interface FormPlugin {
  id: string;
  version: string;
  /** Engine versions this plugin supports (a semver range). Checked at install. */
  engineRange?: string;
  /** Environments this plugin may install into. Checked at install. */
  environments?: Array<PluginContext["environment"]>;
  dependencies?: PluginDependency[];
  components?: ComponentDefinition[];
  validators?: ValidationStage[];
  /** Portable sandbox module for the WASM validation host (see {@link WasmPluginContribution}). */
  wasmPlugin?: WasmPluginContribution;
  /** Functions a rule's formula may call; see {@link FormulaFunctionContribution}. */
  formulaFunctions?: FormulaFunctionContribution[];
  /** Further PDF renditions for component types the plugin does not own. */
  pdfRenditions?: PdfRenditionContribution[];
  /** Themes for the builder shell (the builder layer's `BuilderThemeDefinition`; see {@link PluginThemeContribution}). */
  builderThemes?: PluginThemeContribution<"builder">[];
  /** Themes for the generated PDF (the PDF layer's `PdfThemeDefinition`; see {@link PluginThemeContribution}). */
  pdfThemes?: PluginThemeContribution<"pdf">[];
  dataSourceProviders?: DataSourceProvider[];
  dataSources?: DataSourceDefinition[];
  /** Runtime hooks contributed by the plugin; merged after host hooks. */
  hooks?: FormHooks;
  /** Post-acceptance submission side effects. */
  submissionHandlers?: SubmissionHandlerDefinition[];
  initialize?(context: PluginContext): void;
}

export interface PluginContext {
  environment: "browser" | "server" | "wasm";
}

export interface PluginLifecycleHooks {
  beforeInitialize?(context: PluginContext): void;
  afterInitialize?(context: PluginContext): void;
  onError?(error: unknown, context: PluginContext): void;
  /** Called when a plugin is rejected at install time by a compatibility check. */
  onIncompatible?(pluginId: string, reason: string, context: PluginContext): void;
}

export interface DataSourceRequest {
  sourceId: string;
  query?: Record<string, unknown>;
}

export interface DataSourceContext {
  environment: "client" | "server";
  locale?: string;
  values?: Record<string, unknown>;
}

/**
 * One option a data source offers. `label` and `description` are {@link LocalizedText}, host
 * data: a plain string (what the source already resolved for the locale it was
 * asked) or an object with a word per locale, which the renderer resolves in the filler's
 * locale. An inline option is not one of these: its texts are the form's strings, translated
 * through the definition's map before they become a {@link ResolvedDataSourceItem}. `value` is
 * language-independent; it is what is stored and what a snapshot compares.
 */
export interface DataSourceItem {
  value: string;
  label: LocalizedText;
  /**
   * A line of help under the label — drawn as the option's hint by a radio or checkboxes
   * group, as a second line by a PDF checklist. A plain string is shown as given; a
   * localized object is resolved like the label.
   */
  description?: LocalizedText;
  meta?: Record<string, unknown>;
}

/** A {@link DataSourceItem} with its texts resolved for one locale: what the markup, the PDF and the sandbox receive. */
export interface ResolvedDataSourceItem {
  value: string;
  label: string;
  description?: string;
  meta?: Record<string, unknown>;
}

export interface DataSourceResult {
  items: DataSourceItem[];
}

export interface DataSourceProvider {
  id: string;
  /**
   * Environments this provider may resolve in. Omitted means both. A runtime rejects a
   * provider whose list excludes the runtime's own environment.
   */
  environments?: Array<DataSourceContext["environment"]>;
  /**
   * Declared, advisory privilege footprint. Not enforced by the engine; surfaced for
   * host policy / certification review (e.g. a `client` provider that needs `network`).
   */
  privileges?: {
    network?: boolean;
    storage?: boolean;
  };
  load(request: DataSourceRequest, context: DataSourceContext): Promise<DataSourceResult>;
}

export interface DataSourceRuntime {
  load(
    sourceId: string,
    query?: Record<string, unknown>,
    context?: Omit<DataSourceContext, "environment">
  ): Promise<DataSourceResult>;
}

/**
 * Data sources a host defines while wiring a form (`defineDataSources`, in the data layer):
 * a {@link DataSourceRuntime} that can also say which ids it holds. That is what lets a
 * renderer or a builder consult it *before* the runtime's own registered sources, and what
 * lets the builder's data-source picker list what a host has wired.
 */
export interface DataSourceSet extends DataSourceRuntime {
  has(sourceId: string): boolean;
  ids(): string[];
}
