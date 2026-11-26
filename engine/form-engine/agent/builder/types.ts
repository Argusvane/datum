/**
 * The builder catalogue's shared types and the
 * result interface of every builder tool. One file for all of them
 * so a tool never edits the barrel: a type a tool finds missing here is added here, not copied
 * locally.
 *
 * Result interfaces describe the whole envelope the agent reads (`AgentOk` plus the tool's own
 * fields); a tool body returns {@link ToolFields} of it, and the registrar stamps `ok`, `tool`,
 * `builder` and `revision`. Types only: nothing here runs.
 */
import type { RunScope } from "../../core/expressions/expression.js";
import type { FormulaErrorCode } from "../../core/expressions/formula-types.js";
import type { FormTestProblemCode } from "../../core/form-tests/form-test-types.js";
import type { JourneyDiagnostic } from "../../core/journey/journey-diagnostics.js";
import type { CollectionBinding } from "../../core/schema/collection.js";
import type { InlineOption } from "../../core/schema/inline-options.js";
import type { BuilderLocaleOption, BuilderNote, BuilderProblem, BuilderRenameNote, FormIdentity } from "../../builder/controller/builder-controller.js";
import type { TrySubmissionSettings } from "../../builder/controller/try-submission.js";
import type { Dependent } from "../../builder/controller/dependents.js";
import type { InspectorControl } from "../../builder/property-editor/inspector-model.js";
import type { BuilderFeature } from "../../builder/web-component/builder-features.js";
import type { BuilderWorkspace } from "../../builder/web-component/default-builder-element.js";
import type { PdfLayoutFinding } from "../../builder/pdf-designer/layout-conditions.js";
import type { AgentOk } from "../tool-types.js";

export type { BuilderFeature, BuilderWorkspace, CollectionBinding, Dependent, InlineOption, JourneyDiagnostic, PdfLayoutFinding };

/** What a tool body returns: the result's own fields, the envelope's stamps left to the registrar. */
export type ToolFields<T> = Omit<T, "ok" | "tool" | "form" | "builder" | "revision">;

/** The whole `ComponentRules` key set; the schemas name the first nine. */
export type RuleKey =
  | "visibleWhen"
  | "requiredWhen"
  | "enabledWhen"
  | "readonlyWhen"
  | "validWhen"
  | "value"
  | "defaultValue"
  | "minRows"
  | "maxRows"
  | "filter"
  | "navigationGating";

/** One row of `get_form`'s outline. */
export interface OutlineNode {
  id: string;
  type: string;
  /** As `treeView()` words it in the builder locale (its id when it has none), at most 200 characters. */
  label: string;
  parentId?: string;
  slotId?: string;
  index: number;
  depth: number;
  /** `dataPathOf(id)`: absent for the root, buttons and grouping containers. */
  path?: string;
  dataKey?: string;
  required?: true;
  hidden?: true;
  /** The rule keys set on the node. */
  rules?: string[];
  /** The inline option count; `source` the data source id. */
  options?: number;
  source?: string;
  /** `collectionPathOf(node)` when the node binds rows. */
  collection?: string;
  /** Containers only, in declared order. */
  slots?: Array<{ id: string; count: number; allowedTypes?: string[]; multiple: boolean }>;
  fixed?: true;
  /** Committed-check findings for this id, only when there are some. */
  problems?: number;
}

/** `get_form { detail: "full" }` and `get_component.node`: the outline row plus the node's JSON. */
export interface FullNode extends OutlineNode {
  /** A copy (`structuredClone`); inline options capped at 25. */
  configuration: Record<string, unknown>;
  moreOptions?: number;
  rulesText?: Record<string, string>;
  collectionBinding?: CollectionBinding;
}

/** One property the inspector offers for a component: what `set_properties` takes. */
export interface PropertyInfo {
  propertyPath: string;
  label: string;
  description?: string;
  section: string;
  kind: InspectorControl;
  /** Draft-applied, the inspector's defaults filled. */
  value: unknown;
  /** Only when the person has an unsaved draft and it differs. */
  committedValue?: unknown;
  /** At most 25. */
  choices?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** Kind `options`: the first 25 and the data source id. */
  options?: InlineOption[];
  sourceId?: string;
  /** A static sentence per kind saying what value shape to send. */
  shape?: string;
}

/** One entry of `list_component_types`. */
export interface ComponentTypeInfo {
  type: string;
  label: string;
  group?: string;
  icon?: string;
  onPalette: boolean;
  container: boolean;
  fixed?: true;
  slots?: Array<{ id: string; multiple: boolean; min?: number; max?: number; allowedTypes?: string[] }>;
  /** Slot ids come from the configuration (tab ids, column_N); the listed ones are the template's. */
  configuredSlots?: "tabs" | "grid";
  /** Parents whose slots name this type exclusively (step: ["steps"]). */
  onlyInside?: string[];
  storesValue: boolean;
  offersDataKey: boolean;
  offersRequired: boolean;
  /** `detail: "full"`: the template's configuration. */
  defaults?: Record<string, unknown>;
  /** `detail: "full"`: the properties of a fresh instance (value = default). */
  properties?: PropertyInfo[];
  hint?: string;
}

export interface ComponentProblem {
  componentId: string;
  target: string;
  message: string;
  severity: "error" | "warning";
  source: "builder" | "data-key" | "formula" | "definition" | "note";
}

/** A formula finding; offsets are 0-based UTF-16 into `formula`, `end` exclusive. */
export interface FormulaProblem {
  componentId?: string;
  propertyPath: string;
  formula: string;
  code: FormulaErrorCode | "unknownField" | "lint";
  message: string;
  start: number;
  end: number;
  suggestion?: string;
}

export interface WordedTestProblem {
  code: FormTestProblemCode | "duplicateName";
  line: number;
  start: number;
  end: number;
  message: string;
}

/** `BuilderMoveTarget` without its sibling list. */
export interface MoveTargetRef {
  parentId: string;
  slotId: string;
  pageId?: string;
  label: string;
  slotLabel?: string;
  depth: number;
  siblings: number;
  current?: number;
}

/** Every write result's undo state: `steps` = the history entries this call pushed. */
export interface UndoInfo {
  steps: number;
  ownSteps: number;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * The change is in the catalogue's outside journal (a
   * journey or PDF layout list change, a layout step, Try it settings, the identity), on no
   * controller history, so Undo all, Stop and the notice's Undo reverse it.
   */
  journaled?: true;
}

/** The areas `check_form` runs. */
export type Area = "id" | "dataKey" | "formula" | "lint" | "structure" | "content" | "rows" | "pdf" | "journey" | "tests";

export interface Finding {
  severity: "error" | "warning";
  area: Area;
  code: string;
  componentId?: string;
  label?: string;
  propertyPath?: string;
  /** Worded in the builder's catalog words, at most 500 characters. */
  message: string;
  span?: { start: number; end: number; text: string };
  /** One sentence naming the tool and property that fix it. */
  fix?: string;
  layoutId?: string;
  journeyId?: string;
  pageId?: string;
  testId?: string;
}

/** What `add_components` / `replace_form` take per component. */
export interface ComponentSpec {
  type: string;
  id?: string;
  label?: string;
  description?: string;
  required?: boolean;
  dataKey?: string;
  placeholder?: string;
  options?: Array<string | { value: string; label: string }>;
  configuration?: Record<string, unknown>;
  rules?: Partial<Record<RuleKey, string | { formula: string; run?: RunScope }>>;
  collection?: CollectionBinding;
  children?: ComponentSpec[];
  slots?: Record<string, ComponentSpec[]>;
  parentId?: string;
  slotId?: string;
  index?: number;
}

/** The builder additions to every write result. */
export interface WritePayload {
  undo: UndoInfo;
  /** What the person now sees selected; absent under a bare controller or when the selection was left alone. */
  shown?: { componentId?: string };
  /** While a session is open on this builder. */
  session?: { id: string; ownSteps: number };
}

/** The tests a removal or a replace leaves naming ids that are gone. */
export interface TestAffected {
  id: string;
  name: string;
  refs: string[];
}

// ---- results --------------------------------------------------

export interface DescribeBuilderResult extends AgentOk {
  toolset: "datum-builder/1";
  identity?: { id: string; version: string; schemaVersion: string };
  title: string;
  rootId: string;
  empty: boolean;
  locale: string;
  locales: BuilderLocaleOption[];
  /** The design-system binding the canvas previews the form in (`controller.bindingId()`); absent when the builder draws with Datum's own and offers no choice. */
  binding?: string;
  availableBindings: string[];
  /**
   * `availableBindings` with their labels (host text); the ids
   * above stay. These facts are optional in the type only; every result carries
   * `bindings`, `identityOwner`, `languages` and `ui.tryable`.
   */
  bindings?: Array<{ id: string; label: string }>;
  /** `"host"`: the host owns the identity (`controller.identity()` is undefined), so set_properties { target: "identity" } is refused. */
  identityOwner?: "form" | "host";
  /** root.configuration.agentTools as committed (readAgentToolsSetting): "unset" when absent or not one of the two words. Read-only to the agent. */
  assistants: "unset" | "allowed" | "off";
  /** `ui.managedSettings()`: the property paths the site manages (set_properties refuses them). */
  managed?: string[];
  /** The committed languages (`controller.localization()`); `locales` above stays draft-based. */
  languages?: { declared: boolean; default: string; preview: string; count: number };
  /** The designers' states and the document open in one, when the page has them. */
  designers?: { journeys: DesignerState; pdf: DesignerState; open?: { kind: "journey" | "pdf_layout"; id: string } };
  /** Try it as the person would find it; `chunk` from `TryItAdapter.chunk()`, `"off"` without an adapter. */
  tryIt?: {
    on: boolean;
    tryable: boolean;
    chunk: "ready" | "loading" | "failed" | "off";
    answered: { byPerson: number; byAssistant: number };
    recording: boolean;
    showing: boolean;
    serverChecks: "off" | "on";
    standIn: { outcome: "accept" | "refuse" | "fail"; sources: number };
  };
  counts: {
    components: number;
    containers: number;
    fields: number;
    byType: Record<string, number>;
    tests: number;
    dataSources: number;
    problems: number;
    pdfLayouts: number;
    journeys: number;
  };
  dataSourceIds: string[];
  features: { on: BuilderFeature[]; off: BuilderFeature[] };
  ui?: {
    workspace: BuilderWorkspace;
    workspacesAvailable: BuilderWorkspace[];
    mode: string;
    panel?: string;
    trying: boolean;
    dirty: boolean;
    workspaceProblems: Partial<Record<BuilderWorkspace, number>>;
    /** Whether Try it can run here (`ui.canTry()`, widened). */
    tryable?: boolean;
    /** Present only when the site gave the builder a Save: its label and whether a save is running. */
    save?: { label: string; busy: boolean };
  };
  selection?: { componentId: string; type: string; label: string; hasUnsavedDraft: boolean };
  blockedBy: Array<"prompt" | "draft" | "try-it" | "wrong-mode">;
  draftComponentId?: string;
  undo: UndoInfo;
  session?: { id: string; purpose: string; startedAt: number; idleInMs: number; ownSteps: number };
  stopped: boolean;
  guidance: string[];
}

/** The registrar's two-builder listing: no `revision`, no `guidance`. */
export interface DescribeBuildersResult extends Omit<AgentOk, "builder" | "revision"> {
  builders: Array<{ builder: string; title: string; dirty: boolean; workspace: string }>;
}

export interface GetFormResult extends AgentOk {
  rootId: string;
  total: number;
  count: number;
  nodes: OutlineNode[] | FullNode[];
  problems: number;
}

export interface GetComponentResult extends AgentOk {
  node: FullNode;
  location: { parentId?: string; slotId?: string; index?: number };
  children?: Array<{ slotId: string; ids: string[]; allowedTypes?: string[]; multiple: boolean }>;
  properties: PropertyInfo[];
  rules: Record<string, { formula: string; run?: RunScope; parses: boolean; problem?: FormulaProblem }>;
  ruleKeys: string[];
  problems: BuilderProblem[];
  notes: BuilderNote[];
  cssClassWarning?: string;
  dependents: { items: Dependent[]; lines: string[] };
  moveTargets: MoveTargetRef[];
  hasUnsavedDraft: boolean;
}

export interface ListComponentTypesResult extends AgentOk {
  types: ComponentTypeInfo[];
  total: number;
  count: number;
  notPlaceable: string[];
  rootSlots: string[];
  rules: { id: string; dataKey: string; slots: string };
}

export interface AddComponentsResult extends AgentOk, WritePayload {
  dryRun: boolean;
  ids: string[];
  allIds: string[];
  /** Input position ("0", "0.children.2", "1.slots.tab_1.0") → generated id. */
  generatedIds: Record<string, string>;
  added: Array<{ id: string; type: string; label: string; path?: string; parentId: string; slotId: string; index: number }>;
  lints: FormulaProblem[];
  problems: ComponentProblem[];
  next: string[];
  /** With `fromData`: `false` when the form already had a field for every place. */
  changed?: boolean;
  /** With `fromData`: what the data model read and what was (or, with dryRun, would be) added. */
  dataModel?: DataModelReport;
}

export interface ReplaceFormResult extends AddComponentsResult {
  removed: string[];
  removedCount: number;
  kept: string[];
  testsAffected: TestAffected[];
  outsideReferences: Dependent[];
}

export interface SetPropertiesResult extends AgentOk, WritePayload {
  written: Array<{ componentId: string; propertyPath: string; target: "configuration" | "rules"; previous: unknown; value: unknown }>;
  skipped: SetPropertiesSkipped[];
  lints: FormulaProblem[];
  problems: ComponentProblem[];
  next: string[];
  /** `target: "identity"`: the form's identity before and after; journaled. */
  identity?: IdentityChange;
  /** The one call that reverses an identity change (it is on no undo history). */
  reverse?: ReverseCall;
}

/**
 * An edit `set_properties` left out under `partial: true`: a formula that failed, or
 * a path the site manages, with its code and details, or a value
 * of the wrong shape for its property (`bad-input` with the problems it would have been refused for).
 */
export type SetPropertiesSkipped =
  | { componentId: string; propertyPath: string; problem: FormulaProblem }
  | { componentId: string; propertyPath: string; code: "protected-setting"; details: { propertyPath: string; by: "host" | "author" } }
  | { componentId: string; propertyPath: string; code: "bad-input"; details: { problems: Array<{ key: string; expected: string }> } };

/** The form's identity before and after a `set_properties { target: "identity" }` write. */
export interface IdentityChange {
  before: FormIdentity;
  after: FormIdentity;
}

export interface RenameComponentResult extends AgentOk, WritePayload {
  from: string;
  to: string;
  rulesRewritten: string[];
  unparsed: BuilderRenameNote[];
  collectionPathFollowed: boolean;
  testsFollow: "queued" | "none" | "unavailable";
}

export interface MoveComponentResult extends AgentOk, WritePayload {
  componentId: string;
  from: { parentId: string; slotId: string; index: number };
  to: { parentId: string; slotId: string; index: number };
  leftEmpty: string[];
}

export interface RemoveComponentsResult extends AgentOk, WritePayload {
  removed: string[];
  removedCount: number;
  skipped: Array<{ id: string; reason: "nested" }>;
  referencesCleared: Dependent[];
  testsAffected: TestAffected[];
  next: string[];
}

export interface DuplicateComponentResult extends AgentOk, WritePayload {
  from: string;
  id: string;
  /** Old id → new id for every node in the copy. */
  ids: Record<string, string>;
  dataKeysDropped: string[];
}

/** `"stopped"` is the part of a `binding` change held back while the person's Stop holds. */
export type OpenNotDoneReason = "feature-off" | "hidden" | "not-available" | "not-tryable" | "tried-answers" | "no-ui" | "stopped";

export interface OpenResult extends AgentOk {
  /** `binding`: the preview binding now shown, when the call set one (`""` for the default look). */
  shown: { componentId?: string; workspace: string; panel: string | null; trying: boolean; binding?: string };
  notDone?: Array<{ what: "componentId" | "workspace" | "panel" | "tryIt" | "binding"; reason: OpenNotDoneReason; message: string; triedPaths?: number }>;
  triedAnswersCleared?: number;
  queued?: Array<"workspace">;
}

export interface HistoryResult extends AgentOk, WritePayload {
  action: "undo" | "redo";
  requested: number;
  done: number;
  stoppedBecause?: string;
}

export interface CheckFormResult extends AgentOk {
  clean: boolean;
  counts: { errors: number; warnings: number; byArea: Partial<Record<Area, number>> };
  findings: Finding[];
  total: number;
  count: number;
  ran: Area[];
  skipped: Array<{ area: Area; check?: string; reason: "feature-off" | "chunk-unavailable" | "not-applicable" }>;
  definitionProblem?: string;
  draftsExcluded: string[];
}

export interface GetDefinitionResult extends AgentOk {
  section: string;
  /** The section's JSON; for `section: "data-model"` a {@link DataModelSection}. */
  value: unknown;
  bytes: number;
  sizes?: Record<string, number>;
  hasDrafts: boolean;
}

export interface ListTestsResult extends AgentOk {
  tests: Array<{
    id: string;
    name?: string;
    line?: number;
    source?: string;
    skip?: string;
    steps: number;
    refs: string[];
    valid: boolean;
    problems: WordedTestProblem[];
    lastRun?: { status: "passed" | "failed" | "skipped" | "error" | "invalid"; at: number };
  }>;
  total: number;
  count: number;
  featureOn: boolean;
  syntaxHint: string;
  next?: string[];
}

export interface WriteTestResult extends AgentOk, WritePayload {
  id: string;
  name: string;
  replaced: boolean;
  dryRun: boolean;
  refs: string[];
  unknownRefs: string[];
}

export interface RemoveTestResult extends AgentOk, WritePayload {
  id: string;
  name?: string;
  remaining: number;
}

export interface TestFailure {
  line: number;
  text: string;
  code: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface RunTestsResult extends AgentOk {
  summary: { total: number; passed: number; failed: number; skipped: number; error: number; invalid: number; notRun: number; durationMs: number };
  results: Array<{
    id?: string;
    name?: string;
    status: "passed" | "failed" | "skipped" | "error" | "invalid" | "not-run";
    reason?: string;
    steps: { total: number; passed: number; failed: number; skipped: number };
    firstFailure?: TestFailure;
    failures: TestFailure[];
    problems?: WordedTestProblem[];
  }>;
  pending: string[];
  partial: boolean;
  draftsExcluded: string[];
  next?: string[];
}

/**
 * `begin_session` on a builder: the registrar's shape for every kind. No
 * `ownSteps` and no `next`: the agent reads `ownSteps` from `describe_builder.undo` or any write.
 */
export interface BeginSessionResult extends AgentOk {
  session: { id: string; purpose: string; startedAt: number; idleTimeoutMs: number; revisionAtBegin: number };
  locked: boolean;
  pausedTyping?: boolean;
  resumed?: true;
}

export interface EndSessionResult extends AgentOk {
  wasOpen: boolean;
  session?: {
    id: string;
    durationMs: number;
    calls: number;
    steps: number;
    componentsAdded: number;
    componentsChanged: number;
    componentsRemoved: number;
    testsWritten: number;
    undoable: number;
    undone: number;
  };
}

// ---- the page's seams ----

/**
 * A designer's state as the agent reads it: `"off"` the feature
 * is off, `"hidden"` the host hides the workspace, `"loading"` / `"failed"` its chunk, `"ready"`
 * its mode is on the page and answers.
 */
export type DesignerState = "ready" | "loading" | "failed" | "off" | "hidden";

/** The one call that reverses a change on no controller history. */
export interface ReverseCall {
  tool: string;
  input: Record<string, unknown>;
}

/** Steps a write pushed onto a designer document's own history, which `history` does not reach. */
export interface ElsewhereSteps {
  what: string;
  steps: number;
}

/** The fields every folded tool's result carries. */
export interface FoldedResult<A extends string> {
  action: A;
  changed: boolean;
}

export type TryItAction = "read" | "fill" | "edit_rows" | "navigate" | "check" | "submit" | "clear" | "settings";

/** One tried field, as `try_it { action: 'read' }` lists it. */
export interface TriedField {
  path: string;
  componentId: string;
  label: string;
  type: string;
  visible: boolean;
  required: boolean;
  enabled: boolean;
  readonly: boolean;
  value?: unknown;
  /** Visible fields only. */
  display?: string;
  typedBy?: "person" | "assistant";
  /** The error codes the tried form shows now. */
  errors?: string[];
}

/** One problem the tried form's checks found. */
export interface TryProblem {
  path?: string;
  componentId?: string;
  label: string;
  message: string;
}

/** A per-item refusal inside a `try_it` or `languages` result. */
export interface ItemRefusal {
  code: string;
  message: string;
  hint: string;
  details?: Record<string, unknown>;
}

export interface TryItResult extends AgentOk, FoldedResult<TryItAction> {
  /** Try it is on after the call. */
  trying: boolean;
  /** This call turned Try it on: the person now sees the live form. */
  started?: true;
  /** Present while trying. */
  where?: {
    workspace: "form" | "journeys" | "pdf";
    journey?: {
      journeyId: string;
      pageId: string;
      title: string;
      index: number;
      total: number;
      final: boolean;
      /** At most 50. */
      pages: Array<{ pageId: string; title: string; onPath: boolean }>;
    };
  };
  /** Non-empty typed answers now; `byAssistant` = those still holding what the agent wrote. */
  answered: { byPerson: number; byAssistant: number };
  // read
  fields?: TriedField[];
  fieldCount?: number;
  /** The agent's last check in this Try it. */
  lastCheck?: { at: number; problemCount: number };
  /** Anyone's last Submit while trying (`builder-try-submit`). */
  lastSubmit?: { at: number; outcome: "accepted" | "invalid" | "refused" | "failed"; reference?: string };
  recording?: boolean;
  showing?: boolean;
  /** read and settings. */
  settings?: {
    /** `null` with the try-it feature off. */
    trySubmission: TrySubmissionSettings | null;
    /** At most 100; `usedBy` at most 10. */
    sources: Array<{ sourceId: string; state: "simulated" | "host" | "missing"; usedBy: string[]; simulatedOptions?: number }>;
  };
  // fill, edit_rows
  written?: Array<{ path: string; value: unknown; display?: string; matched?: "label" }>;
  refused?: Array<ItemRefusal & { path: string }>;
  /** Paths the answers made visible (at most 50). */
  revealed?: string[];
  /** Paths the answers made required (at most 50). */
  nowRequired?: string[];
  rows?: { collection: string; count: number; added?: number; removed?: number };
  // fill (on the written paths), check (the form or the journey page), submit (when invalid)
  /** At most 100. */
  problems?: TryProblem[];
  problemCount?: number;
  /** The person's WebAssembly checks; never turned on by a tool. */
  serverChecks?: "off" | "on" | "failed";
  // submit
  submitted?: { outcome: "accepted" | "invalid" | "refused" | "failed"; standIn: true; reference?: string; message?: string; readOnlyNow?: true };
  // navigate
  moved?: boolean;
  // clear
  cleared?: { byPerson: number; byAssistant: number };
  // settings
  /** "trySubmission.outcome", "source:provinces". */
  settingsChanged?: string[];
  /** settings only (steps 0). */
  undo?: UndoInfo & { journaled: true };
  /** settings only. */
  reverse?: ReverseCall & { tool: "try_it" };
}

export type LanguagesAction = "list" | "texts" | "translate" | "add" | "rename" | "relabel" | "set_default" | "preview";
export type LanguagesGroup = "fields" | "options" | "messages" | "chrome" | "journeys" | "pdf";

/** One translatable text as `languages { action: 'texts' }` lists it. */
export interface LanguagesTextEntry {
  textId: string;
  group: LanguagesGroup;
  componentId: string;
  component: string;
  what: string;
  source: string;
  translations: Record<string, string>;
  /** Languages whose entry answers an older wording than the text's current one ("Source changed"); writing the entry again confirms it. */
  stale?: string[];
  /** Locales the site's catalog fills; its values are never returned. */
  catalog?: string[];
  /** false: no target, `translate` refuses it. */
  writable: boolean;
}

export interface LanguagesResult extends AgentOk, Partial<WritePayload>, FoldedResult<LanguagesAction> {
  /** false: the form declares no languages (a single-language form). */
  declared: boolean;
  /** `effectiveDefaultLocale`; meaningful only when declared. */
  defaultLanguage: string;
  /** `controller.currentLocale()`. */
  previewLanguage: string;
  /** Committed (`controller.localization()`), never the person's draft. */
  languages: Array<{ code: string; label: string; isDefault: boolean; translated: number; total: number }>;
  /** `localeChangesSinceSave()`: what the next save hands the site. */
  changedSinceSave?: { removed: string[]; renamed: Array<{ from: string; to: string }> };
  outside: { journeys: "included" | "not-loaded" | "none"; pdf: "included" | "not-loaded" | "none" };
  // texts
  texts?: LanguagesTextEntry[];
  textCount?: number;
  // translate
  written?: Array<{ textId: string; language: string }>;
  refused?: Array<ItemRefusal & { textId: string; language: string }>;
  // add, set_default
  /** add: the codes declared (sourceLocale first on a form that had none). */
  added?: string[];
  /** set_default: texts whose source wording moved. */
  promotedTexts?: number;
}

export type DocumentsAction =
  | "list"
  | "open"
  | "new"
  | "duplicate"
  | "rename"
  | "set_default"
  | "move"
  | "map_fields"
  | "create_form_fields"
  | "preview_pdf"
  | "restore_removed";

/** A document kind as the tools spell it (snake_case). */
export type DocumentKind = "journey" | "pdf_layout";

/** One journey or layout as `documents` lists it (try order for layouts; at most 50). */
export interface DocumentEntry {
  id: string;
  name: string;
  isDefault: boolean;
  open: boolean;
  pages?: number;
  layoutKind?: "generated" | "template";
  conditional?: boolean;
}

/** What `documents { action: 'preview_pdf' }` reports: metadata, never the file or kernel text. */
export interface DocumentsPreview {
  layoutId: string;
  layoutChoice: "given" | "condition" | "default" | "fallback" | "derived";
  layoutKind: "generated" | "template" | "derived";
  pageCount: number;
  answers: "tried" | "host" | "none";
  /** At most 20; PdfWarning codes, never its message. */
  warnings: Array<{ code: string; componentId?: string }>;
  fields?: { filled: number; empty: number };
}

export interface DocumentsResult extends AgentOk, Partial<WritePayload>, FoldedResult<DocumentsAction> {
  kind: DocumentKind;
  /** Every action; at most 50. */
  documents: DocumentEntry[];
  /** Journeys. */
  opensAs?: "journey" | "form";
  /** pdf_layout list; at most 50. */
  templates?: Array<{ templateId: string; label: string }>;
  designer: { state: DesignerState; workspace: string; openId?: string };
  /** list: journey diagnostics / layout condition findings when loaded; never fetched. */
  findings?: { errors: number; warnings: number } | { checked: false };
  /** Writes. */
  document?: { id: string; name: string; isDefault: boolean };
  /** open, new, duplicate: the person sees it now. */
  opened?: boolean;
  /** map_fields. */
  mapped?: number;
  /** create_form_fields. */
  formFields?: { added: string[]; mapped: number; matched: number; skipped: Array<{ pdfField: string; reason: string }> };
  preview?: DocumentsPreview;
  /** map_fields, create_form_fields, a rename a built designer recorded. */
  elsewhere?: ElsewhereSteps;
  reverse?: ReverseCall & { tool: "documents" | "remove_part" };
  undo?: UndoInfo & { journaled?: true };
}

export type RemovePartKind = "language" | "journey" | "pdf_layout";

export interface RemovePartResult extends AgentOk, WritePayload {
  kind: RemovePartKind;
  id: string;
  name?: string;
  changed: true;
  language?: { translationsRemoved: number; newDefault?: string; nowSingleLanguage?: true; notReached?: Array<"journeys" | "pdf"> };
  journey?: { pages: number; opensAs: "journey" | "form"; newDefault?: string };
  layout?: { layoutsLeft: number; newDefault?: string };
  /** language: one `history` undo; journey / layout: `restore_removed`, Undo all or the notice's Restore while the page stays open. */
  restorable: "history" | "until-reload";
  /** journey / layout: `documents { action: 'restore_removed' }`. */
  reverse?: ReverseCall & { tool: "documents" };
  undo: UndoInfo & { journaled?: true };
}

export interface SaveResult extends AgentOk {
  saved: true;
  changed: true;
  /** The site's Save label ("Save", "Save draft", …). */
  label: string;
  savedAt: number;
  undoable: false;
  /** What the site was told (it may drop catalog columns for removed languages). */
  localeChanges?: { removed: string[]; renamed: Array<{ from: string; to: string }> };
  /** check_form's count at save time (describe_builder counts.problems). */
  problems: number;
  /** `ui.dirty()`: a site that tracks its own state may leave it true. */
  dirtyAfter: boolean;
}

/** `fromData`'s report on add_components / replace_form. */
export interface DataModelReport {
  readAs: "sample" | "schema";
  detected: "sample" | "schema";
  /** Places the input describes. */
  places: number;
  /** At most 200; with dryRun what would be added, `componentId` being the id that would be used. */
  added: Array<{ path: string; componentId: string; type: string; fit: "exact" | "approximate"; notes?: string[] }>;
  /** add: places the form already has. */
  alreadyInForm: number;
  /** At most 50, left alone. */
  kindDiffers: Array<{ path: string; form: string; incoming: string }>;
  /** At most 50, the planner's own sentences. */
  skipped: Array<{ path: string; reason: string }>;
  /** At most 20 (ignored keywords, unusable or risky patterns). */
  notes: string[];
}

/** `get_definition { section: "data-model" }`'s value. */
export interface DataModelSection {
  dataModel: {
    schema: Record<string, unknown>;
    example: Record<string, unknown>;
    places: number;
    notes: string[];
    /** The person's unapplied drafts show, as the Data surface shows them. */
    draftsApplied: boolean;
  };
}
