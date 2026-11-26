/**
 * The live renderer's draw loop: `mountLive(shadowRoot, options)` draws the engine's presentation
 * fold (`render/core/presentation-tree.ts`) of the runtime's render output through a binding's
 * adapters as a lit-html update step. The first draw creates the nodes; every later one changes
 * only what changed, so focus, the caret and a design system's component state need no putting
 * back. One draw per runtime change: the change events of one write are coalesced into one build,
 * and a build that a newer one overtook is dropped.
 *
 * What this module owns, for every binding:
 * - the adapter lookup per node (contract.ts `resolveAdapter`), the Datum fallback for what the
 *   binding does not draw (tinted by its `fallbackTokens`), and a note for what nothing draws;
 *   each of these recorded once in `unsupported()` and warned about once, as is a capability a
 *   field or a container uses that its adapter answers `none` and a binding's own type the
 *   definition's `kinds` map leaves out (the binding's `kinds` stand under the definition's in
 *   the drawing);
 * - the ids a binding's markup must write (`describedBy`, for `idsWrittenBy: "binding"`): one
 *   nothing in the form carries is reported;
 * - the root's adopted sheets: on unmount they go back to what they were before the mount;
 * - the field wrapper and the DOM contract on it (`data-component-id`, `data-value-path`, the
 *   instance key) and the state hooks (contract.ts `STATE_HOOKS`); a `data-container-id` wrapper
 *   around every container, which lays nothing out (`display: contents`);
 * - the common field state (`FieldState`): worded blocking errors, notices, ids that exist,
 *   pending, busy, the form's words;
 * - the write guard: no `input`, `parts`, `commit`, `files` or `remove` reaches the runtime
 *   while the form is not live or the field is read-only or disabled, and the stored answer is
 *   drawn back; a read-only radio, checkbox or select takes focus but no change, and says it is
 *   read-only (guards.ts), so read-only never has to mean disabled;
 * - the hooks' order and guards: select, render, after (every draw), ready (budgeted), connect;
 *   a hook that throws is reported (`datum-binding-error`) and the drawing falls back to Datum's;
 * - the mounted guard: nothing is built, drawn, focused, written or emitted after `unmount`;
 * - focus on a field (`focusField`): the adapter's or the binding's target, the deep active
 *   element checked afterwards, the wrapper on a miss.
 *
 * Everything else plugs in as a {@link LiveFeature} the host lists in `features`: per-kind field
 * state (fields), the summary, tabs, data grids, steps, journey pages, chrome, notices, files,
 * tooltips, the host's design-system assets. A feature adds field state, patches field events,
 * draws a container kind, fills a region of the form, opens what hides a field, and hears every
 * draw and every field's connection, without editing this module or another feature. Without a
 * feature for a container kind its children are drawn plainly in its wrapper, never dropped.
 */
import type { EventBus } from "../../core/events/event-bus.js";
import { FormEventType } from "../../core/events/event-types.js";
import { createFormTextResolver, type FormTextCatalog } from "../../core/localization/form-texts.js";
import type { LanguagePack } from "../../core/localization/translations.js";
import type { ValidationMessageCatalog } from "../../core/localization/validation-messages.js";
import type { DataSourceResult, DataSourceSet } from "../../core/schema/contracts.js";
import type { ErrorPresentationConfiguration } from "../core/render-contracts.js";
import { GRID_COMPONENT_TYPE, readGridColumnWidths } from "../../core/schema/grid.js";
import { countCharacters } from "../../core/schema/length-limits.js";
import { ownValue } from "../../core/state/form-state.js";
import { stringifyComponentPath } from "../../core/tree/component-path.js";
import { kindOf } from "../../registry/kinds.js";
import { workedOutNoteId, type RenderComponentModel } from "../core/component-model.js";
import { componentTextOf } from "./component-text.js";
import type { JourneyRenderKit } from "../core/journey-render-kit.js";
import {
  foldPresentation,
  type PresentationField,
  type PresentationGroup,
  type PresentationNode,
  type PresentationReveal,
  type PresentationTree
} from "../core/presentation-tree.js";
import type { RenderOutput } from "../core/render-orchestrator.js";
import { buildRuntimeRenderOutput, type RenderableRuntime, type RuntimeRenderOptions } from "../core/runtime-render-bridge.js";
import { scalarText } from "../core/scalar-text.js";
import type { DrawingCapabilityId } from "../../registry/capabilities/drawing-capabilities.js";
import {
  BINDING_ERROR_EVENT,
  capabilityOf,
  drawingKindsOf,
  fieldCapabilitiesOf,
  needsKindsEntry,
  usedCapabilities,
  usedContainerCapabilities,
  resolveAdapter,
  tooltipIdOf,
  type Adapter,
  type AdapterKind,
  type AdapterSource,
  type AdapterTest,
  type BindingErrorDetail,
  type DateFieldState,
  type DateParts,
  type DesignSystemSideEffect,
  type FieldAdapter,
  type FieldEvents,
  type FieldSource,
  type FieldState,
  type FormBusy,
  type FormDrawState,
  type GroupAdapter,
  type GroupItem,
  type GroupState,
  type LiveAssets,
  type LiveBinding,
  type LiveMode,
  type ResolvedAdapter,
  type TextFieldState,
  type View,
  type Words
} from "./contract.js";
import { errorFieldOf } from "./error-target.js";
import { installReadOnlyGuard, markReadOnly } from "./guards.js";
import { html, ifDefined, nothing, render, repeat, type TemplateResult } from "./lit.js";

// ── What the renderer needs of the runtime ─────────────────────────────────────────────────

/** What the renderer needs of the engine's runtime; `FormRuntime` is one. */
export interface LiveRuntime extends RenderableRuntime {
  events(): EventBus;
  /** The definition, for its `kinds` map. */
  definition?(): { kinds?: Readonly<Record<string, string>> | undefined };
  setValue(path: string, value: unknown, options?: { interim?: boolean }): void;
  /** Records what the control knows that the stored value cannot say: a number box holding unreadable text. */
  setInputState?(path: string, state: { readonly badInput?: boolean } | undefined): void;
  commitValue?(path: string): void;
  /** Checks one answer as it is left; the runtime decides whether this commit checks at all (`validateOn`). */
  validatePath?(path: string): Promise<unknown>;
  /** Checks the whole form: what Enter in a form's one text box does (the browser's implicit submission). */
  validate?(): Promise<unknown>;
  /** Composes a date from its typed parts, writes it and records what a date typed in part lacks. */
  setDateParts?(path: string, parts: { readonly year?: string; readonly month?: string; readonly day?: string }, options?: { interim?: boolean }): string;
  /** Each data grid's row bounds as its formulas came to. */
  dataGridRowBounds?(): Readonly<Record<string, { minRows: number; maxRows: number | undefined }>>;
}

// ── Extension points ───────────────────────────────────────────────────────────────────────

/** The places around the body a feature may fill, in drawn order. */
export const FORM_REGIONS = ["alerts", "header", "languages", "summary-top", "page-header", "page-actions", "summary-bottom", "footer", "live"] as const;
export type FormRegion = (typeof FORM_REGIONS)[number];

/** Every node the renderer draws but a field. */
export type ContainerNode = Exclude<PresentationNode, PresentationField>;

/** A field as one draw resolved it. */
export interface DrawnField {
  key: string;
  node: PresentationField;
  state: FieldState;
  /** Absent for a type nothing draws (the renderer's note stands in). */
  adapter: FieldAdapter | undefined;
  from: AdapterSource | "renderer";
  /** The type the adapter is registered under. */
  via: string;
}

/** What one draw did, for the features that act after it (focus, announcements). */
export interface DrawReport {
  /** 1 for the first draw. */
  draw: number;
  added: readonly string[];
  removed: readonly string[];
  updated: readonly string[];
  output: RenderOutput;
  tree: PresentationTree;
}

/** One hook call, as `trace` hears it. */
export interface TraceEntry {
  hook: "select" | "render" | "template" | "after" | "ready" | "connect" | "disconnect" | "focus" | "unmount";
  id?: string | undefined;
  t: number;
}

/** What the renderer gives every feature for the life of the mount. */
export interface LiveContext {
  readonly root: ShadowRoot;
  readonly runtime: LiveRuntime;
  readonly binding: LiveBinding;
  /** The Datum binding the fallbacks come from (the binding itself when drawing Datum's own). */
  readonly datum: LiveBinding;
  readonly mode: LiveMode;
  readonly options: Readonly<LiveMountOptions>;
  mounted(): boolean;
  /** The form element, once drawn. */
  form(): HTMLFormElement | null;
  /** The last output drawn, and its fold. */
  output(): RenderOutput | undefined;
  tree(): PresentationTree | undefined;
  /** The fields of the last draw, in drawn order. */
  fields(): readonly DrawnField[];
  field(key: string): DrawnField | undefined;
  wrapperOf(key: string): HTMLElement | undefined;
  /** Draws the last output again, now: for renderer state that changed (a tab chosen) where no answer did. */
  redraw(): void;
  /** Asks the runtime for a new output and draws it (coalesced with any change already asked for). */
  request(): void;
  /** Resolves once every change asked for so far is drawn and its new fields are ready. */
  updated(): Promise<void>;
  /** Dispatches `type` on the shadow root's host (bubbling, composed), while mounted. */
  emit(type: string, detail?: unknown): void;
  /** Reports a binding problem: `datum-binding-error` and the console. */
  error(detail: BindingErrorDetail): void;
  /** Says `message` on the console once per `key`. */
  warnOnce(key: string, message: string): void;
  /** Records what the form uses that the binding does not draw (`unsupported()`), once. */
  report(entry: string): void;
  /**
   * Records, once each, the capabilities a node uses (`used`) that the adapter drawing it answers
   * `none`: `<id>: <capability>` in `unsupported()` and a warning. What every container feature
   * calls once its adapter is chosen, as the renderer does for fields.
   */
  reportCapabilities(id: string, adapter: Pick<Adapter, "capabilities"> | undefined, used: readonly DrawingCapabilityId[]): void;
  /** Says which adapter drew a container this draw (`LiveForm.adapterOf`): a feature that draws a container kind records its own. */
  recordAdapter(key: string, entry: { from: AdapterSource | "renderer"; via: string; name?: string }): void;
  /** Runs a synchronous hook: a throw is reported once per hook and id, and `undefined` comes back. */
  call<T>(hook: string, id: string | undefined, run: () => T): T | undefined;
  /** The lookup chain (contract.ts `resolveAdapter`) over this mount's binding and Datum's. */
  resolve<A extends Adapter>(kind: A["kind"], type: string, base: string, state?: unknown): ResolvedAdapter<A> | undefined;
  /** Opens what hides the field (tabs, steps) and focuses it; `false` when the field is not drawn. */
  focusField(key: string): boolean;
  /** Focuses `element` and checks the deep active element landed inside `within` (default: the element). */
  focusElement(element: HTMLElement, within?: HTMLElement): boolean;
  /** Marks the form busy with `kind` (a module's navigation) or not. */
  setBusy(kind: FormBusy, on: boolean): void;
  /** The form's busy state as the next draw will see it. */
  busy(): FormBusy | undefined;
  /** Whether the form is drawn for printing: every paged container (steps, tabs) draws all its panels. */
  printing(): boolean;
  /** Draws the form for printing (or back): the print module calls it around `beforeprint` and `afterprint`. */
  setPrinting(on: boolean): void;
  /**
   * Takes the person to the first blocking error after a check that found some: the first
   * feature that owns error focus (`LiveFeature.focusErrors`) answers `true`, else the first
   * field in error takes focus, whatever step or tab hides it. `false` when nothing was in error.
   */
  focusErrors(): boolean;
  /**
   * Commits every answer still being typed, as if each field had been left. A move
   * the browser would not report as a change (Enter on a journey page) calls it first.
   */
  settleInput(): void;
  /** State a feature keeps for the life of the mount, made once. */
  memory<T>(owner: string, make: () => T): T;
  /** What was typed into a date's boxes, while the store still holds the answer it composed to. */
  typedParts(key: string, stored: string): DateParts | undefined;
  trace(hook: TraceEntry["hook"], id?: string): void;
}

/** What one draw gives the features it calls. */
export interface DrawContext {
  readonly live: LiveContext;
  readonly output: RenderOutput;
  readonly tree: PresentationTree;
  readonly form: FormDrawState;
  readonly words: Words;
  /** The `kinds` map the form is drawn with: the definition's, over the binding's own (`drawingKindsOf`). */
  readonly kinds: Readonly<Record<string, string>> | undefined;
  /** Draws nodes keyed: fields in their wrappers with their hooks, containers through their adapters. */
  nodes(nodes: readonly PresentationNode[]): TemplateResult;
  /** The same nodes, each drawn on its own and keyed (a list draws one item per child). `nodes` is these, keyed. */
  items(nodes: readonly PresentationNode[]): readonly GroupItem[];
  /**
   * A container's content in its wrapper: the DOM contract (`data-container-id`, `data-kind`), an
   * optional key handler, and `data-fallback` when `fallback` says Datum's adapter drew it inside
   * another binding (the binding's `fallbackTokens` apply under it).
   */
  container(node: ContainerNode, base: string, content: View, onKeydown?: (event: KeyboardEvent) => void, fallback?: boolean): TemplateResult;
  /**
   * A region's drawing by one of Datum's hooks inside another binding (a journey page's heading,
   * the receipt), in an element that lays nothing out and carries `data-fallback`, so the
   * binding's `fallbackTokens` tint it. The view as it is when the binding is Datum's own.
   */
  fallback(view: View): View;
  /** A group-shaped container's own words (its legend, hint, level, classes), with its slots drawn. */
  groupState(node: PresentationGroup, slots: GroupState["slots"]): GroupState;
}

/** What a feature adds to the form element itself. */
export interface FormDecor {
  classes?: readonly string[];
  attributes?: Readonly<Record<string, string>>;
}

/**
 * A module of the renderer. Every member is optional; the renderer calls them in `features`
 * order. A feature never edits another's output: it adds to the state, wraps the events, draws a
 * container kind or fills a region.
 */
export interface LiveFeature {
  readonly id: string;
  /**
   * Before the first draw (adopt the host's sheets, load scripts). A rejection fails the mount: an
   * alert takes the form's place. What it returns is its cleanup, run on unmount (at once when the
   * form was unmounted while it was preparing).
   */
  prepare?(live: LiveContext): void | (() => void) | Promise<void | (() => void)>;
  /** Once, before the first draw and after every `prepare`: listeners, runtime subscriptions. Returns its cleanup, run on unmount. */
  start?(live: LiveContext): void | (() => void);
  /** Adds to a field's state (per-kind state, a degraded capability folded in, a row's label hidden). */
  fieldState?(state: FieldState, node: PresentationField, draw: DrawContext): FieldState | void;
  /** Wraps a field's events (a list of choices to Datum's object of booleans, files). The renderer's write guard wraps the result. */
  fieldEvents?(on: FieldEvents, state: FieldState, node: PresentationField, draw: DrawContext): FieldEvents | void;
  /**
   * Draws something the renderer owns inside the field's wrapper, after the adapter's drawing
   * (the note under a field whose data source has not answered). Every feature's answer is drawn,
   * in `features` order. It is not part of the adapter's template, so a binding never sees it.
   */
  fieldExtra?(state: FieldState, node: PresentationField, draw: DrawContext): View | undefined;
  /** Draws a container kind (tabs, grid, steps, page); the first feature answering wins. */
  drawNode?(node: ContainerNode, draw: DrawContext): View | undefined;
  /** Fills a region of the form. */
  region?(region: FormRegion, draw: DrawContext): View | undefined;
  /** Opens what hides a node (a tab, a step); `true` when it changed what shows. */
  reveal?(steps: readonly PresentationReveal[], live: LiveContext): boolean;
  /** Classes and attributes on the form element itself (a frame around the form); every feature's are applied. */
  formDecor?(draw: DrawContext): FormDecor | undefined;
  /** Owns where focus goes when a check found errors (the summary); `true` when it took focus. The first feature answering `true` wins. */
  focusErrors?(live: LiveContext): boolean;
  /**
   * Takes focus for a first error whose owner is not a field (a data grid's own error, a cell
   * error no row owns): `componentId` is the owner. `true` when it took focus. Asked when no drawn
   * field holds the first error.
   */
  focusOwner?(componentId: string, live: LiveContext): boolean;
  /** After every draw, in the draw's task. */
  afterDraw?(report: DrawReport, live: LiveContext): void;
  /** A field's nodes are ready and connected: what lives as long as they do. Returns its cleanup. */
  connectField?(wrapper: HTMLElement, field: DrawnField, live: LiveContext): void | (() => void);
}

/** The builder canvas's hooks, template-typed. */
export interface CanvasHooks {
  /**
   * Wraps a field's drawing (selection, drop targets). `paperOnly`: the fold kept it though a
   * screen leaves it out as drawn on paper only (the presentation node's own mark).
   */
  decorateField?(model: RenderComponentModel, content: TemplateResult, paperOnly?: boolean): TemplateResult;
  /** Draws a container in place of its adapter's drawing, given each slot drawn; `paperOnly` as for {@link decorateField}. */
  renderContainer?(
    info: { model: RenderComponentModel; kind: AdapterKind; label: string | undefined; slots: ReadonlyMap<string, TemplateResult>; paperOnly?: boolean },
    drawn: TemplateResult
  ): TemplateResult | undefined;
  /** What an empty slot shows (a drop zone). */
  emptySlot?(info: { containerId: string; slotId: string }): View;
  /** Wraps a region's drawing (a journey page's heading and buttons, the canvas's step chrome); `undefined` keeps it. */
  decorateRegion?(region: FormRegion, view: View): View | undefined;
}

/**
 * What a host mounts a form with. `runtime`, `binding`, `datum`, `assets`, `mode`, `features`,
 * `host`, `readyBudgetMs` and `trace` are read once, at mount. Every other member is read at each
 * build or draw that needs it, so a host may hand an object whose members are getters over its own
 * settings (the form element does): after changing one it asks for a new build (`LiveForm.request`)
 * for the wording, the data sources, the error presentation and the journey kit, or a draw
 * (`LiveForm.redraw`) for the colour scheme, the canvas hooks, the grid rows and the hidden
 * components.
 */
export interface LiveMountOptions {
  runtime: LiveRuntime;
  binding: LiveBinding;
  /** The Datum binding, whose adapters draw what `binding` does not; left out, `binding` alone. */
  datum?: LiveBinding;
  /** The design system's files as the host serves them (the assets feature adopts them). */
  assets?: LiveAssets | undefined;
  mode?: LiveMode;
  /** The page's validation wording, over what the form authors. */
  messages?: ValidationMessageCatalog | undefined;
  /** The host's form texts, over the form's translations and the binding's pack. */
  texts?: FormTextCatalog | undefined;
  canvasHooks?: CanvasHooks | undefined;
  /** What draws a journey's pages (the journeys chunk's kit); without it a journey draws whole. */
  journeyKit?: JourneyRenderKit | undefined;
  dataSources?: DataSourceSet | undefined;
  /**
   * Whether the first draw waits for the data sources (`"all"`, bounded by their own timeouts).
   * Left out (`"none"`), a source still out after one turn of the event loop does not hold the
   * form back: it is drawn from the answers known so far, the fields still waiting drawn as
   * loading, and drawn again once they land. A later change never waits.
   */
  dataSourceWait?: "none" | "all" | undefined;
  /** Whether errors show on fields and in a summary, where the summary sits and whether the first error takes focus; the engine's defaults when left out. */
  errorPresentation?: ErrorPresentationConfiguration | undefined;
  /**
   * How a collection-bound container draws its rows: one per entry with its
   * buttons (`"entries"`, the default), or its template's children at their own ids as its one row
   * (`"template"`, what the builder canvas draws while editing).
   */
  dataGridRows?: "entries" | "template" | undefined;
  /**
   * Draws the components a rule is hiding (`visible: false` on their nodes) rather than leaving
   * them out: the builder canvas's affordance. A component drawn on paper only
   * (`print.on: "paper"`) is drawn with them, its node marked `paperOnly` as well.
   */
  includeHidden?: boolean | undefined;
  /**
   * The form's own heading level, its place in the page's outline (the host's `headingLevel`); 1
   * when left out. Containers head themselves from a level under it. The features that head
   * something of their own (chrome, summary, notices) take it in their own options.
   */
  headingLevel?: number | undefined;
  /** The renderer's modules. */
  features?: readonly LiveFeature[];
  colorScheme?: "light" | "dark" | undefined;
  /** Where `datum-*` events are dispatched; the shadow root's host when left out. */
  host?: EventTarget;
  /** How long a field's `ready` may take, in ms (3000). */
  readyBudgetMs?: number;
  /** Hears every hook call, in order. */
  trace?(entry: TraceEntry): void;
}

/** Which adapter drew one instance: where it came from, the type it is registered under, and its name. */
export interface DrawnBy {
  from: AdapterSource | "renderer";
  via: string;
  name?: string;
}

/** What {@link LiveForm.selfCheck} reports. */
export interface LiveSelfCheck {
  /** The binding's own check against the root (`designSystem.selfCheck`); empty when it has none or finds nothing. */
  problems: string[];
  /** The form's uses the binding does not draw, as {@link LiveForm.unsupported} lists them. */
  unsupported: string[];
  /** Each drawn instance's adapter, in drawn order: a field's key or a container's component id. */
  adapters: Array<DrawnBy & { key: string }>;
  /** What the design system changes outside the form's root, as the binding declares it (`designSystem.sideEffects`): reported, never a problem. */
  sideEffects: DesignSystemSideEffect[];
}

/** The mounted form. */
export interface LiveForm {
  readonly root: ShadowRoot;
  /** Resolves once the first draw is ready and shown; rejects when the form could not be drawn (an alert stands in its place). */
  readonly ready: Promise<void>;
  /** Resolves once every change so far is drawn and its new fields are ready. */
  updated(): Promise<void>;
  /** How many times the form has been drawn. */
  draws(): number;
  /**
   * What the form uses that the binding does not draw: `<component id>: <capability>` for a
   * capability a field or a container uses that its adapter answers `none`, `<component id>:
   * component "<type>"` for a type the binding has no adapter for (drawn by Datum's, else by the
   * renderer's note), and `<component id>: component "<type>" has no kinds entry` for one of the
   * binding's own types (`LiveBinding.kinds`) the definition's `kinds` map does not name.
   */
  unsupported(): string[];
  /** Which adapter drew an instance (a field's key, or a container's component id). */
  adapterOf(key: string): DrawnBy | undefined;
  /**
   * The drawing as it stands, checked now: what the binding's own check reports against the
   * root (`designSystem.selfCheck`, run again, guarded), what the form uses that the binding does
   * not draw (`unsupported()`), and which adapter drew each instance (`adapterOf`), in drawn
   * order. What a host or the builder reads to say how this form is drawn without mounting
   * anything of its own.
   */
  selfCheck(): LiveSelfCheck;
  /** Opens what hides a field and focuses it. */
  focusField(key: string): boolean;
  /**
   * Opens what hides the component with this id (the tabs and steps around it; for a step, its
   * own steps container on that step), moving no focus: what the builder canvas asks for the
   * component an author selected. `false` when the drawn form holds no such component.
   */
  reveal(componentId: string): boolean;
  /**
   * Takes the person to the first blocking error, as after a check that found some
   * (`LiveContext.focusErrors`): the summary or the first field in error. `false` when nothing
   * was in error.
   */
  focusErrors(): boolean;
  /**
   * Commits every answer still being typed, as if each field had been left: called
   * before the body goes inert for an agent session, so a half-typed answer is reported first.
   * Nothing when no answer is interim.
   */
  settleInput(): void;
  /** Marks the form busy with `kind` (a host's submission in flight: `submitting`) or not; drawn at once. */
  setBusy(kind: FormBusy, on: boolean): void;
  /** The last draw's fold (the tree of pages, containers and fields), for a host that checks what was drawn against what the form holds. */
  tree(): PresentationTree | undefined;
  /** The fields of the last draw, in drawn order. */
  fields(): readonly DrawnField[];
  /** Asks the runtime for a new output and draws it: after a host setting the build reads (its wording, its data sources) changed. */
  request(): void;
  /** Draws the last output again. */
  redraw(): void;
  /**
   * The drawing capabilities this form's binding answers for a field type or a data grid (the kind registry and
   * the adapter that would draw it, Datum's behind the binding; the definition's `kinds` map
   * read): what the builder's inspector offers. `undefined` for a type nothing draws.
   */
  capabilitiesOf(type: string): ReturnType<typeof fieldCapabilitiesOf>;
  /**
   * Releases every field, stops listening, undoes the binding's set-up and clears the root: the
   * root's adopted sheets go back to what they were before the mount (a design system's sheet
   * adopted while the form was mounted is taken away with the renderer's own).
   */
  unmount(): void;
}

// ── Constants ──────────────────────────────────────────────────────────────────────────────

/** The parts of a stored ISO `YYYY-MM-DD` date; empty strings for anything else. */
function isoDateParts(value: unknown): DateParts {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  return match ? { year: match[1] as string, month: match[2] as string, day: match[3] as string } : { year: "", month: "", day: "" };
}

/** The runtime changes that change what is drawn. */
const REDRAW_EVENTS: readonly string[] = [
  FormEventType.FORM_INITIALIZED,
  FormEventType.COMPONENT_CHANGED,
  FormEventType.RECOMPUTE_COMPLETED,
  FormEventType.ERRORS_CHANGED,
  FormEventType.VALIDATION_STARTED,
  FormEventType.VALIDATION_COMPLETED,
  FormEventType.VALIDATION_FAILED,
  FormEventType.VALIDATION_PENDING_CHANGED,
  FormEventType.NAVIGATION_COMPLETED,
  FormEventType.DRAFT_LOADED,
  FormEventType.LOCALE_CHANGED,
  FormEventType.JOURNEY_CHANGED,
  FormEventType.PAGE_CHANGED,
  FormEventType.PAGE_BLOCKED,
  FormEventType.JOURNEY_CHECK_STARTED,
  FormEventType.JOURNEY_CHECK_COMPLETED,
  FormEventType.COLLECTION_CHANGED,
  FormEventType.SUBMISSION_STARTED,
  FormEventType.SUBMISSION_COMPLETED,
  FormEventType.SUBMISSION_FAILED
];

/** Events after which no whole-form check is running any more: it completed or threw, or a later change overtook it. */
const VALIDATION_SETTLED_EVENTS: readonly string[] = [
  FormEventType.VALIDATION_COMPLETED,
  FormEventType.VALIDATION_FAILED,
  FormEventType.ERRORS_CHANGED,
  FormEventType.COMPONENT_CHANGED,
  FormEventType.SUBMISSION_COMPLETED,
  FormEventType.SUBMISSION_FAILED
];

const READY_BUDGET_MS = 3000;

/** The Datum container a container with no adapter of its own is drawn by. */
const FALLBACK_GROUP_TYPE = "fieldset";

/** The renderer's own structure; the look is the binding's. */
const STRUCTURE_CSS = `
:host { display: block; }
.datum-live[data-settling] { visibility: hidden; }
.datum-live-container { display: contents; }
.datum-live-fallback { display: contents; }
.datum-live-field { min-width: 0; }
.datum-live-unknown { border: 1px dashed currentColor; padding: 0.5rem 0.75rem; }
.datum-live-unknown > p { margin: 0; }
.datum-live-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.datum-live-source-note { margin: 0.25rem 0 0; font-size: var(--font-size-error, 12px); }
.datum-live-worked-out { margin: 0.25rem 0 0; font-size: var(--font-size-hint, 12px); color: var(--color-muted, #536b7f); }
.datum-live-source-note[data-source-error] { color: var(--color-error, #c53a3a); }
`;

// ── Small helpers ──────────────────────────────────────────────────────────────────────────

/** A stable number per adapter object, so a field drawn by another adapter is keyed apart. */
const adapterIds = new WeakMap<object, number>();
let nextAdapterId = 1;
function adapterIdOf(adapter: object): number {
  let id = adapterIds.get(adapter);
  if (id === undefined) {
    id = nextAdapterId;
    nextAdapterId += 1;
    adapterIds.set(adapter, id);
  }
  return id;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}

/** A source's state as a field's hook: loading, failed, or cut to the cap; nothing when it answered plainly. */
function sourceOf(model: RenderComponentModel): FieldSource | undefined {
  const state = model.optionState;
  if (state === undefined) {
    return undefined;
  }
  if (state.status === "loading" || state.status === "error") {
    return state.status;
  }
  return state.truncated !== undefined ? "truncated" : undefined;
}

/** The control the renderer focuses when neither the adapter nor the binding names one: the field's id, else its first control. */
function defaultFocusTarget(root: ShadowRoot, wrapper: HTMLElement, state: FieldState): HTMLElement | undefined {
  const byId = root.getElementById(state.id);
  if (byId instanceof HTMLElement && wrapper.contains(byId)) {
    return byId;
  }
  return wrapper.querySelector<HTMLElement>("input:not([type='hidden']), select, textarea, button, [tabindex]:not([tabindex='-1'])") ?? undefined;
}

/** The sheets the renderer adopts itself: its structure, the binding's own CSS, its fallback tokens for what Datum draws. */
function ownSheetsCss(binding: LiveBinding, datum: LiveBinding): string[] {
  const out = [STRUCTURE_CSS];
  if (datum !== binding && datum.css) {
    out.push(datum.css);
  }
  if (binding.css) {
    out.push(binding.css);
  }
  const tokens = Object.entries(binding.fallbackTokens ?? {}).filter(([name, value]) => /^--[A-Za-z0-9_-]+$/.test(name) && !/[;{}]/.test(value));
  if (datum !== binding && tokens.length > 0) {
    out.push(`[data-fallback] { ${tokens.map(([name, value]) => `${name}: ${value};`).join(" ")} }`);
  }
  return out;
}

/**
 * Adopts `sheets` into the root (constructable sheets where the browser has them, else `<style>`
 * elements placed first, where lit's part never reaches). Returns what undoes it.
 */
function adoptOwnSheets(root: ShadowRoot, sheets: readonly string[]): () => void {
  const adoptable =
    typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in root && typeof (CSSStyleSheet.prototype as { replaceSync?: unknown }).replaceSync === "function";
  if (adoptable) {
    try {
      const made = sheets.map((css) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        return sheet;
      });
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, ...made];
      return () => {
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => !made.includes(sheet));
      };
    } catch {
      // A browser that has the property but refuses the sheet: the elements below.
    }
  }
  const owner = root.ownerDocument ?? document;
  const elements = sheets.map((css) => {
    const style = owner.createElement("style");
    style.setAttribute("data-datum-live", "");
    style.textContent = css;
    return style;
  });
  root.prepend(...elements);
  return () => {
    for (const element of elements) {
      element.remove();
    }
  };
}

// ── mountLive ──────────────────────────────────────────────────────────────────────────────

export function mountLive(root: ShadowRoot, options: LiveMountOptions): LiveForm {
  const { runtime, binding } = options;
  const datum = options.datum ?? binding;
  const mode: LiveMode = options.mode ?? "interactive";
  const features = options.features ?? [];
  const host: EventTarget = options.host ?? root.host;
  const budgetMs = options.readyBudgetMs ?? READY_BUDGET_MS;
  const pack: LanguagePack | undefined = binding.texts !== undefined || binding.messages !== undefined ? { texts: binding.texts, messages: binding.messages } : undefined;

  // ── State the draws share ──
  let mounted = true;
  /** The form could not be drawn: no draw happens any more. */
  let failed = false;
  let draws = 0;
  let token = 0;
  let requested = false;
  let composing = false;
  let requestWhileComposing = false;
  let drawingNow = false;
  let redrawQueued = false;
  let building: Promise<void> = Promise.resolve();
  /** Each data source's last answer, so a build can be drawn from them while a source is out (`provisional`). */
  const answerMemo = new Map<string, DataSourceResult | undefined>();
  /** The draw running now is a provisional one. */
  let provisionalDraw = false;
  /** The first draw was a provisional one: `ready` waits for it alone, not for the sources. */
  let firstProvisional = false;
  let markFirstDrawn: () => void = () => undefined;
  const firstDrawn = new Promise<void>((done) => {
    markFirstDrawn = done;
  });
  /** The first draw's fields getting ready. */
  let firstSettle: Promise<void> = Promise.resolve();
  const settles = new Set<Promise<void>>();
  let lastOutput: RenderOutput | undefined;
  let lastTree: PresentationTree | undefined;
  let lastFields: DrawnField[] = [];
  const fieldsByKey = new Map<string, DrawnField>();
  const drawnBy = new Map<string, DrawnBy>();
  interface Instance {
    adapterId: number;
    wrapper: HTMLElement;
    cleanups: Array<() => void>;
    connected: boolean;
    /** Its choice controls carry the renderer's `aria-readonly` (guards.ts). */
    readOnlyMarked: boolean;
  }
  const instances = new Map<string, Instance>();
  const unsupported = new Set<string>();
  const warned = new Set<string>();
  const reportedHooks = new Set<string>();
  const memories = new Map<string, unknown>();
  const typed = new Map<string, { parts: DateParts; composed: string; path: string }>();
  /** True while the renderer writes a date's typed parts itself: that write is not the host's. */
  let writingParts = false;
  /** The value paths written interim (typed in, not yet left): only these are reported as committed. */
  const interim = new Set<string>();
  const busyFlags = new Set<FormBusy>();
  /** The form's body was locked (`inert`) by the last draw: a submission was in flight. */
  let locked = false;
  /** What had focus when the lock came, put back when it lifts unless something took focus meanwhile. */
  let lockedFocus: { element: HTMLElement; key: string | null } | undefined;
  let validating = false;
  /** The form is drawn for printing (`setPrinting`). */
  let printing = false;
  /** The attributes the features' `formDecor` put on the form element last draw, to remove those that go. */
  let decorAttributes: string[] = [];
  /** The first draw stays hidden until its fields are ready (or the budget runs out). */
  let settlingFirst = true;
  /** Shown above the form when part of it did not get ready in time. */
  let partlyShown = false;
  const stops: Array<() => void> = [];

  const trace = (hook: TraceEntry["hook"], id?: string): void => {
    options.trace?.({ hook, id, t: typeof performance !== "undefined" ? performance.now() : Date.now() });
  };

  /**
   * The events raised while a draw runs, dispatched once it ends: a host listener runs then, so one
   * that unmounts (or redraws) never does it in the middle of a draw.
   */
  const heldEvents: Array<{ type: string; detail: unknown }> = [];

  const emit = (type: string, detail: unknown = {}): void => {
    if (!mounted) {
      return;
    }
    if (drawingNow) {
      heldEvents.push({ type, detail });
      return;
    }
    host.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  };

  /** Dispatches the events a draw held, in order; none once a listener has unmounted the form. */
  const releaseHeldEvents = (): void => {
    for (let next = heldEvents.shift(); next !== undefined; next = heldEvents.shift()) {
      if (!mounted) {
        heldEvents.length = 0;
        return;
      }
      host.dispatchEvent(new CustomEvent(next.type, { detail: next.detail, bubbles: true, composed: true }));
    }
  };

  const error = (detail: BindingErrorDetail): void => {
    console.error(`[binding ${binding.id}] ${detail.hook}${detail.id !== undefined ? ` on "${detail.id}"` : ""}: ${detail.message}`);
    emit(BINDING_ERROR_EVENT, detail);
  };

  const warnOnce = (key: string, message: string): void => {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[binding ${binding.id}] ${message}`);
    }
  };

  const report = (entry: string): void => {
    unsupported.add(entry);
  };

  const reportCapabilities = (id: string, adapter: Pick<Adapter, "capabilities"> | undefined, used: readonly DrawingCapabilityId[]): void => {
    for (const capability of used) {
      if (capabilityOf(adapter, capability) !== "none") {
        continue;
      }
      const entry = `${id}: ${capability}`;
      if (!unsupported.has(entry)) {
        report(entry);
        warnOnce(`cap:${entry}`, `"${id}" uses "${capability}", which this binding does not draw.`);
      }
    }
  };

  /** Ids a binding-written field names in `describedBy` and nothing in the form carries, reported once each. */
  const missingIds = new Set<string>();

  /** A synchronous hook: a throw reported once per hook and id; a promise where none may be warned about once. */
  function call<T>(hook: string, id: string | undefined, run: () => T): T | undefined {
    try {
      const result = run();
      if (isThenable(result)) {
        warnOnce(`async:${hook}`, `"${hook}" returned a promise. It must finish before the draw is painted.`);
      }
      return result;
    } catch (thrown) {
      const key = `${id ?? ""}:${hook}`;
      if (!reportedHooks.has(key)) {
        reportedHooks.add(key);
        error({ hook, ...(id !== undefined ? { id } : {}), message: messageOf(thrown) });
      }
      return undefined;
    }
  }

  /** An adapter's `when` run as a hook: one that throws is reported (hook `when`) and does not hold, so the next adapter draws. */
  const whenHolds: AdapterTest = (adapter, state) => {
    const key = (state as { key?: unknown } | null | undefined)?.key;
    return call("when", typeof key === "string" ? key : undefined, () => adapter.when(state)) === true;
  };

  const resolve = <A extends Adapter>(kind: A["kind"], type: string, base: string, state?: unknown): ResolvedAdapter<A> | undefined =>
    resolveAdapter<A>(binding, datum, kind, type, base, state, whenHolds);

  const words = (): Words => {
    const locale = runtime.state().locale;
    return createFormTextResolver(locale, options.texts, runtime.translationCatalog?.(), undefined, { translations: runtime.translations?.(), pack });
  };

  const formElement = (): HTMLFormElement | null => {
    for (const child of Array.from(root.children)) {
      if (child instanceof HTMLFormElement && child.classList.contains("datum-live")) {
        return child;
      }
    }
    return null;
  };

  const wrapperOf = (key: string): HTMLElement | undefined => instances.get(key)?.wrapper;

  function busy(): FormBusy | undefined {
    if (busyFlags.has("submitting") || runtime.state().submission.status === "submitting") {
      return "submitting";
    }
    if (busyFlags.has("navigating") || lastOutput?.meta.journey?.pending !== undefined) {
      return "navigating";
    }
    if (busyFlags.has("validating") || validating) {
      return "validating";
    }
    return undefined;
  }

  /** The first feature that owns error focus takes it; else the first field in error, opened and focused. */
  function focusErrors(): boolean {
    if (!mounted || lastOutput === undefined) {
      return false;
    }
    for (const feature of features) {
      if (feature.focusErrors && call(`${feature.id}.focusErrors`, undefined, () => feature.focusErrors?.(context)) === true) {
        return true;
      }
    }
    const target = lastOutput.meta.firstErrorFocus;
    if (target === undefined) {
      return false;
    }
    // The field at the error's own path (a data grid's row, not its first), else the owner that is no field.
    const field = errorFieldOf(lastFields, target);
    if (field !== undefined) {
      return focusField(field.key);
    }
    const owner = target.targetComponentId ?? target.componentId;
    for (const feature of features) {
      if (feature.focusOwner && call(`${feature.id}.focusOwner`, owner, () => feature.focusOwner?.(owner, context)) === true) {
        return true;
      }
    }
    return false;
  }

  /** Focuses `element` and checks that focus landed inside `within`. */
  function focusElement(element: HTMLElement, within: HTMLElement = element): boolean {
    if (!mounted) {
      return false;
    }
    element.focus();
    const active = root.activeElement;
    return active !== null && (active === within || within.contains(active));
  }

  function focusField(key: string): boolean {
    if (!mounted || lastOutput === undefined) {
      return false;
    }
    const field = fieldsByKey.get(key);
    if (!field) {
      return false;
    }
    if (field.state.reveal.length > 0) {
      let changed = false;
      for (const feature of features) {
        if (feature.reveal && call("reveal", key, () => feature.reveal?.(field.state.reveal, context)) === true) {
          changed = true;
        }
      }
      if (changed) {
        redraw();
      }
    }
    const current = fieldsByKey.get(key) ?? field;
    const wrapper = wrapperOf(key);
    if (!wrapper) {
      return false;
    }
    trace("focus", key);
    const adapter = current.adapter;
    const named =
      adapter?.focusTarget !== undefined
        ? () => adapter.focusTarget?.(wrapper, current.state)
        : binding.focusTarget !== undefined
          ? () => binding.focusTarget?.(wrapper, current.state)
          : undefined;
    const target = (named ? call("focus", key, named) : undefined) ?? defaultFocusTarget(root, wrapper, current.state);
    if (target && focusElement(target, wrapper)) {
      return true;
    }
    // No control to take it, or focus did not land: the wrapper takes it.
    wrapper.tabIndex = -1;
    wrapper.focus();
    if (target) {
      error({ hook: "focus", id: key, message: "focus did not land in the field; its wrapper took it" });
    }
    return true;
  }

  /**
   * The tabs and steps that hide the component `componentId` in the last tree, outermost first
   * (for a step, its own steps container on that step); `undefined` when the tree holds none.
   */
  function revealOf(componentId: string): PresentationReveal[] | undefined {
    const visit = (nodes: readonly PresentationNode[]): PresentationReveal[] | undefined => {
      for (const node of nodes) {
        if (node.kind !== "page" && node.id === componentId) {
          return node.reveal;
        }
        let inner: readonly PresentationNode[];
        switch (node.kind) {
          case "field":
            continue;
          case "group":
          case "page":
            inner = node.children;
            break;
          case "tabs":
            inner = node.tabs.flatMap((tab) => tab.children);
            break;
          case "grid":
            inner = node.rows.flatMap((row) => row.cells.flatMap((cell) => cell.children));
            break;
          case "steps": {
            const step = node.steps.find((candidate) => candidate.id === componentId);
            if (step) {
              return [...node.reveal, { kind: "step", stepsId: node.id, stepId: step.id }];
            }
            inner = [...node.steps.flatMap((candidate) => candidate.children), ...node.others];
            break;
          }
        }
        const found = visit(inner);
        if (found) {
          return found;
        }
      }
      return undefined;
    };
    return lastTree ? visit(lastTree.nodes) : undefined;
  }

  /** Opens what hides a component, moving no focus (`LiveForm.reveal`). */
  function revealComponent(componentId: string): boolean {
    if (!mounted || failed) {
      return false;
    }
    const steps = revealOf(componentId);
    if (steps === undefined) {
      return false;
    }
    if (steps.length > 0) {
      let changed = false;
      for (const feature of features) {
        if (feature.reveal && call("reveal", componentId, () => feature.reveal?.(steps, context)) === true) {
          changed = true;
        }
      }
      if (changed) {
        redraw();
      }
    }
    return true;
  }

  // ── Building and drawing ──

  function renderOptions(): RuntimeRenderOptions {
    return {
      ...(options.journeyKit ? { journeyKit: options.journeyKit } : {}),
      ...(options.dataSources ? { dataSources: options.dataSources } : {}),
      ...(options.errorPresentation ? { errorPresentation: options.errorPresentation } : {}),
      // Notices are drawn under their own id, so the controls may be described by it.
      accessibilityOptions: { describeNotices: true },
      wording: {
        ...(options.messages ? { messages: options.messages } : {}),
        ...(options.texts ? { texts: options.texts } : {}),
        ...(pack ? { pack } : {})
      }
    };
  }

  /** Asks for a new output; the events of one change come in one task and make one build. */
  function request(): void {
    if (!mounted || failed) {
      return;
    }
    if (composing) {
      // Nothing is written into a box while an input method is composing in it.
      requestWhileComposing = true;
      return;
    }
    if (requested) {
      return;
    }
    requested = true;
    queueMicrotask(() => {
      requested = false;
      build();
    });
  }

  function build(): void {
    if (!mounted || failed) {
      return;
    }
    const mine = ++token;
    const renderMode = mode === "readonly" ? "readonly" : "interactive";
    let answered = false;
    /** The runtime's output; a runtime that throws before the build has a promise (its `errors()` broken) rejects it the same way. */
    const outputOf = (provisional: boolean): Promise<RenderOutput> => {
      try {
        return buildRuntimeRenderOutput(runtime, renderMode, { ...renderOptions(), answerMemo, ...(provisional ? { provisional: true } : {}) });
      } catch (thrown) {
        return Promise.reject(thrown);
      }
    };
    const next = outputOf(false).then(
      (output) => {
        answered = true;
        // A newer build carries this one's change; nothing after unmount.
        if (mine === token && mounted && !failed) {
          draw(output);
        }
      },
      (thrown: unknown) => {
        answered = true;
        throw thrown;
      }
    );
    // A data source slow to answer must not hide what the change did (nor, unless the host asked
    // to wait, the form itself): after one turn of the event loop, a build from the answers known
    // so far is drawn, the fields still waiting drawn as loading, until this one lands.
    if (draws > 0 || options.dataSourceWait !== "all") {
      setTimeout(() => {
        if (answered || mine !== token || !mounted || failed) {
          return;
        }
        outputOf(true).then(
          (output) => {
            if (!answered && mine === token && mounted && !failed) {
              provisionalDraw = true;
              try {
                draw(output);
              } finally {
                provisionalDraw = false;
              }
            }
          },
          () => undefined
        );
      }, 0);
    }
    building = next.catch((thrown: unknown) => {
      if (mounted && draws > 0) {
        error({ hook: "render", message: messageOf(thrown) });
      }
      throw thrown;
    });
    // The first build's failure is the mount's to report; a later one is reported above.
    building.catch(() => undefined);
  }

  /** Draws the last output again, now. */
  function redraw(): void {
    if (mounted && !failed && lastOutput) {
      draw(lastOutput);
    }
  }

  async function updated(): Promise<void> {
    for (let rounds = 0; rounds < 100; rounds += 1) {
      const seenBuild = building;
      await seenBuild.catch(() => undefined);
      // A change asked for in the same task builds on the next microtask.
      await Promise.resolve();
      const waiting = [...settles];
      await Promise.all(waiting);
      if (seenBuild === building && !requested && settles.size === 0) {
        return;
      }
    }
  }

  /** Releases the instances this draw does not keep (gone, or drawn by another adapter), while their nodes exist. */
  function releaseLeaving(staying: ReadonlyMap<string, number>): string[] {
    const removed: string[] = [];
    for (const [key, instance] of instances) {
      if (staying.get(key) !== instance.adapterId) {
        removed.push(key);
        release(key, instance);
      }
    }
    return removed;
  }

  function release(key: string, instance: Instance): void {
    instances.delete(key);
    if (instance.connected) {
      trace("disconnect", key);
    }
    for (const cleanup of instance.cleanups.splice(0).reverse()) {
      call("disconnect", key, cleanup);
    }
  }

  /** The `ready` of each new field (its adapter's, else the binding's), budgeted; then `after` once more and `connect`. */
  function settle(added: readonly DrawnField[], first: boolean): Promise<void> {
    if (!mounted) {
      return Promise.resolve();
    }
    let shared: Promise<unknown> | undefined;
    const bindingReady = (): Promise<unknown> => (shared ??= Promise.resolve().then(() => binding.ready?.(root)));
    const waits = added.map((field) => {
      const instance = instances.get(field.key);
      if (!instance) {
        return Promise.resolve();
      }
      trace("ready", field.key);
      const ready = field.adapter?.ready
        ? Promise.resolve().then(() => field.adapter?.ready?.(instance.wrapper))
        : field.adapter
          ? bindingReady()
          : Promise.resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<"late">((done) => {
        timer = setTimeout(() => done("late"), budgetMs);
      });
      return Promise.race([
        ready.then(
          () => "ready" as const,
          (thrown: unknown) => {
            error({ hook: "ready", id: field.key, message: messageOf(thrown) });
            return "failed" as const;
          }
        ),
        budget
      ]).then((outcome) => {
        clearTimeout(timer);
        if (!mounted || instances.get(field.key) !== instance) {
          return;
        }
        if (outcome === "late") {
          error({ hook: "ready", id: field.key, message: `not ready within ${budgetMs} ms; shown as it is` });
          if (first) {
            partlyShown = true;
          }
        }
        connect(field.key, instance);
      });
    });
    return Promise.all(waits).then(() => {
      if (!mounted) {
        return;
      }
      if (first && settlingFirst) {
        settlingFirst = false;
        formElement()?.removeAttribute("data-settling");
        if (partlyShown) {
          // The alert that part of the form did not get ready, drawn with the form shown.
          redraw();
        }
      }
    });
  }

  function connect(key: string, instance: Instance): void {
    const field = fieldsByKey.get(key);
    if (!field) {
      return;
    }
    const adapter = field.adapter;
    if (adapter?.after) {
      call("after", key, () => adapter.after?.(instance.wrapper, field.state));
    }
    // A component that drew its controls only now (it upgraded while the field got ready) has them marked too.
    markReadOnlyOf(field, instance);
    trace("connect", key);
    const keep = (cleanup: unknown): void => {
      if (typeof cleanup === "function") {
        instance.cleanups.push(cleanup as () => void);
      }
    };
    if (adapter?.guard) {
      keep(call("guard", key, () => adapter.guard?.(instance.wrapper)));
    }
    if (adapter?.connect) {
      keep(call("connect", key, () => adapter.connect?.(instance.wrapper, field.state)));
    }
    for (const feature of features) {
      if (feature.connectField) {
        keep(call(`${feature.id}.connectField`, key, () => feature.connectField?.(instance.wrapper, field, context)));
      }
    }
    instance.connected = true;
  }

  function track(promise: Promise<void>): void {
    settles.add(promise);
    void promise.finally(() => settles.delete(promise));
  }

  // ── Field state and events ──

  function baseFieldState(node: PresentationField, d: DrawContext): FieldState {
    const model = node.model;
    const a11y = model.accessibility;
    const showErrors = d.output.meta.presentation.showInlineErrors;
    const errors = showErrors ? [...(model.errorMessages ?? [])] : [];
    const notices = (model.notices ?? []).map((notice) => ({ code: notice.code, severity: notice.severity, message: notice.message }));
    const description = typeof model.description === "string" && model.description.trim() !== "" ? model.description : undefined;
    const hintId = description !== undefined ? (a11y.descriptionId ?? `${a11y.fieldId}__description`) : undefined;
    const errorId = errors.length > 0 ? (a11y.errorId ?? `${a11y.fieldId}__error`) : undefined;
    // The worked-out line is its own element under the engine's id (the adapter's, else the renderer's).
    const workedOutText = model.workedOut === true ? d.words("workedOut") : "";
    const workedOutId = workedOutText !== "" ? workedOutNoteId(a11y.fieldId) : undefined;
    const describedBy = a11y.ariaDescribedBy.filter((id) => (id !== a11y.errorId || errorId !== undefined) && (id !== workedOutNoteId(a11y.fieldId) || workedOutId !== undefined));
    if (hintId !== undefined && !describedBy.includes(hintId)) {
      describedBy.unshift(hintId);
    }
    if (workedOutId !== undefined && !describedBy.includes(workedOutId)) {
      describedBy.splice(hintId !== undefined ? describedBy.indexOf(hintId) + 1 : 0, 0, workedOutId);
    }
    if (errorId !== undefined && !describedBy.includes(errorId)) {
      describedBy.push(errorId);
    }
    const value = scalarText(model.value);
    const kind = kindOf(node.base)?.kind;
    const row = model.row;
    const source = sourceOf(model);
    const state: FieldState = {
      key: node.key,
      componentId: model.id,
      type: node.type,
      base: node.base,
      ...(kind !== undefined ? { kind } : {}),
      id: a11y.fieldId,
      name: a11y.fieldId,
      valuePath: model.valuePath,
      label: model.label,
      labelId: a11y.labelId,
      hideLabel: model.hideLabel,
      ...(hintId !== undefined && description !== undefined ? { hint: description, hintId } : {}),
      ...(workedOutId !== undefined ? { workedOut: workedOutText, workedOutId } : {}),
      value,
      answer: model.value,
      required: a11y.required,
      readOnly: model.readOnly || mode === "readonly",
      disabled: model.disabled || mode === "disabled",
      invalid: errors.length > 0,
      errors,
      ...(errors.length > 0 ? { message: errors.join(" ") } : {}),
      ...(errorId !== undefined ? { errorId } : {}),
      notices,
      ...(notices.length > 0 ? { noticeId: a11y.noticeId ?? `${a11y.fieldId}__notice` } : {}),
      describedBy,
      pending: model.pending === true,
      ...(source !== undefined ? { source } : {}),
      busy: d.form.busy,
      overLimit: model.characterCount === true && model.maxLength !== undefined && countCharacters(value) > model.maxLength,
      locale: d.form.locale,
      dir: d.form.dir,
      classNames: model.classNames,
      ...(row !== undefined
        ? {
            row: {
              index: row.index,
              label: node.rowLabel ?? "",
              ...(row.rowKey !== undefined ? { rowKey: row.rowKey } : {}),
              collectionPath: row.collectionPath,
              ownerId: row.ownerId
            }
          }
        : {}),
      reveal: node.reveal,
      mode,
      words: d.words,
      text: componentTextOf(model.node, d.form.locale, d.words.words),
      model
    };
    return state;
  }

  /**
   * The state after the adapter is chosen: what the adapter draws only in a reduced form folded
   * into the hint (a degraded tooltip, a degraded pending word), the ids of what it does not
   * draw left out of `describedBy`.
   */
  function stateForAdapter(state: FieldState, adapter: FieldAdapter): FieldState {
    let next = state;
    const folded: string[] = [];
    const tooltip = (state as TextFieldState).tooltip ?? state.model.tooltip;
    const foldsTooltip = tooltip !== undefined && tooltip !== "" && capabilityOf(adapter, "tooltip") === "degraded";
    if (foldsTooltip) {
      folded.push(tooltip);
    }
    if (state.pending && capabilityOf(adapter, "pending") === "degraded") {
      folded.push(state.words("fieldPending"));
    }
    // A component that words its own description takes the worked-out line in its hint.
    const foldsWorkedOut = state.workedOut !== undefined && capabilityOf(adapter, "workedOut") === "degraded";
    if (foldsWorkedOut) {
      folded.push(state.workedOut as string);
    }
    if (folded.length > 0) {
      const hintId = state.hintId ?? `${state.id}__description`;
      next = {
        ...next,
        hint: [state.hint, ...folded].filter((part): part is string => part !== undefined && part !== "").join(" "),
        hintId,
        describedBy: next.describedBy.includes(hintId) ? next.describedBy : [hintId, ...next.describedBy]
      };
      if (foldsTooltip) {
        delete (next as TextFieldState).tooltip;
      }
      if (foldsWorkedOut) {
        const { workedOut: _line, workedOutId: lineId, ...rest } = next;
        next = { ...rest, describedBy: next.describedBy.filter((id) => id !== lineId) };
      }
    }
    if (tooltip !== undefined && tooltip !== "" && capabilityOf(adapter, "tooltip") === "drawn") {
      // The bubble is a description of the control, read after the field's own description.
      const id = tooltipIdOf(state.id);
      if (!next.describedBy.includes(id)) {
        const at = state.hintId !== undefined ? next.describedBy.indexOf(state.hintId) + 1 : 0;
        const ids = [...next.describedBy];
        ids.splice(at, 0, id);
        next = { ...next, describedBy: ids };
      }
    }
    const drops: string[] = [];
    const countId = state.model.accessibility.countId;
    if (countId !== undefined && capabilityOf(adapter, "characterCount") === "none") {
      drops.push(countId);
    }
    if (state.noticeId !== undefined && capabilityOf(adapter, "notice") === "none") {
      drops.push(state.noticeId);
    }
    if (drops.length > 0) {
      next = { ...next, describedBy: next.describedBy.filter((id) => !drops.includes(id)) };
    }
    return next;
  }

  /** The leave-field check for `path`; the runtime's `validateOn` decides whether it checks at all. */
  function checkLeft(path: string, key: string): void {
    const check = runtime.validatePath?.(path);
    if (check) {
      check.catch((thrown: unknown) => error({ hook: "validatePath", id: key, message: messageOf(thrown) }));
    }
  }

  /** Reports `path` as committed when it was being typed in, once; nothing for a path never written interim. */
  function commitInterim(path: string): boolean {
    if (!interim.delete(path)) {
      return false;
    }
    runtime.commitValue?.(path);
    return true;
  }

  /**
   * The form's own submit (Enter in a form with one text box): never navigates. A journey page's
   * Enter is the journey module's; elsewhere it checks the form and takes the person to the first
   * error, as the old element's submit did.
   */
  function onSubmit(event: Event): void {
    event.preventDefault();
    if (!mounted || failed || mode !== "interactive" || busy() === "submitting" || lastOutput?.meta.journey !== undefined) {
      return;
    }
    const check = runtime.validate?.();
    if (check) {
      check.then(
        () => updated().then(() => (mounted ? focusErrors() : false)),
        (thrown: unknown) => error({ hook: "validate", message: messageOf(thrown) })
      ).catch(() => undefined);
    }
  }

  /** Commits every answer still being typed (`LiveForm.settleInput`). */
  function settleInput(): void {
    if (!mounted || failed) {
      return;
    }
    for (const path of [...interim]) {
      commitInterim(path);
    }
  }

  /**
   * The parts a date's boxes report, with each box the person left alone read from the answer
   * when something other than the person wrote it since the boxes were drawn. A draw held while an
   * input method composes in one box leaves its siblings showing what was there before a runtime
   * write (`setValue` on the same date); reported as they stand, they would undo the write. A box
   * still holding what the last draw put in it is untouched, so its part comes from the stored
   * answer; one that differs was typed, and stands. While the only writes since the draw are the
   * person's own (the typed parts compose to what is stored), the boxes are reported as they are.
   */
  function freshDateParts(key: string, path: string, reported: DateParts): DateParts {
    const drawn = fieldsByKey.get(key)?.state;
    if (!drawn) {
      return reported;
    }
    const value = ownValue(runtime.state().values, path);
    const stored = typeof value === "string" ? value : "";
    const own = typed.get(key);
    if (own !== undefined ? own.composed === stored : stored === drawn.value) {
      return reported;
    }
    const drawnParts = (drawn as Partial<DateFieldState>).parts ?? isoDateParts(drawn.value);
    const current = isoDateParts(stored);
    const pick = (part: keyof DateParts): string => (reported[part] !== drawnParts[part] ? reported[part] : current[part]);
    return { year: pick("year"), month: pick("month"), day: pick("day") };
  }

  /**
   * The renderer's own writes for a field, before the features wrap them. A write made while
   * typing is interim and enters the path in `interim`; a final one (a pick) takes it out, since
   * what it wrote is what the person meant. `commit` reports a typed answer as committed and
   * runs the leave-field check either way.
   */
  function writesFor(state: FieldState): FieldEvents {
    const path = state.valuePath;
    const key = state.key;
    const note = (isInterim: boolean): void => {
      if (isInterim) {
        interim.add(path);
      } else {
        interim.delete(path);
      }
    };
    return {
      input: (value, inputOptions) => {
        const isInterim = inputOptions?.interim === true;
        note(isInterim);
        runtime.setValue(path, value, isInterim ? { interim: true } : undefined);
        // After the write, which forgets what the control said.
        if (inputOptions?.badInput === true) {
          runtime.setInputState?.(path, { badInput: true });
        }
      },
      parts: (reported, partsOptions) => {
        const isInterim = partsOptions?.interim === true;
        note(isInterim);
        const parts = freshDateParts(key, path, reported);
        writingParts = true;
        let composed: string;
        try {
          composed = runtime.setDateParts
            ? runtime.setDateParts(path, parts, isInterim ? { interim: true } : undefined)
            : (() => {
                const whole = parts.year.trim() !== "" && parts.month.trim() !== "" && parts.day.trim() !== "";
                const answer = whole ? `${parts.year.trim().padStart(4, "0")}-${parts.month.trim().padStart(2, "0")}-${parts.day.trim().padStart(2, "0")}` : "";
                runtime.setValue(path, answer, isInterim ? { interim: true } : undefined);
                return answer;
              })();
        } finally {
          writingParts = false;
        }
        if (parts.year.trim() !== "" || parts.month.trim() !== "" || parts.day.trim() !== "") {
          typed.set(key, { parts: { year: parts.year.trim(), month: parts.month.trim(), day: parts.day.trim() }, composed, path });
        } else {
          typed.delete(key);
        }
      },
      commit: () => {
        commitInterim(path);
        checkLeft(path, key);
      }
    };
  }

  /**
   * The write guard around a field's events: nothing reaches the runtime after unmount, while the
   * form is not live, or while the field (as last drawn) is read-only or disabled; a refused
   * write draws the stored answer back.
   */
  function guarded(on: FieldEvents, key: string): FieldEvents {
    const takes = (): boolean => {
      if (!mounted || failed) {
        return false;
      }
      const current = fieldsByKey.get(key)?.state;
      // A submission in flight takes no answer: the fields are inert, and a browser without `inert` is refused here.
      return mode === "interactive" && busy() !== "submitting" && current !== undefined && !current.readOnly && !current.disabled;
    };
    const refuse = (drawBack: boolean): boolean => {
      if (takes()) {
        return false;
      }
      if (drawBack) {
        redraw();
      }
      return true;
    };
    const out: FieldEvents = {
      input: (value, inputOptions) => {
        if (!refuse(true)) {
          on.input(value, inputOptions);
        }
      },
      parts: (parts, partsOptions) => {
        if (!refuse(true)) {
          on.parts(parts, partsOptions);
        }
      },
      commit: () => {
        if (!refuse(false)) {
          on.commit();
        }
      }
    };
    if (on.files) {
      const files = on.files.bind(on);
      out.files = (list) => {
        if (!refuse(true)) {
          files(list);
        }
      };
    }
    if (on.remove) {
      const remove = on.remove.bind(on);
      out.remove = (id) => {
        if (!refuse(true)) {
          remove(id);
        }
      };
    }
    if (on.download) {
      const download = on.download.bind(on);
      // Asking for an attachment writes nothing: allowed on a read-only field.
      out.download = (id) => {
        if (mounted) {
          download(id);
        }
      };
    }
    return out;
  }

  // ── The tree ──

  interface Item {
    key: string;
    template: View;
  }

  function list(items: readonly Item[]): TemplateResult {
    return html`${repeat(items, (item) => item.key, (item) => item.template)}`;
  }

  /** A drawn node as one keyed item of its container. */
  function itemOf(item: Item): GroupItem {
    return { key: item.key, content: html`${item.template}` };
  }

  /** The items drawn keyed by the renderer, for an adapter that draws one element per child. */
  function eachItemOf(items: readonly GroupItem[]): GroupState["eachItem"] {
    return (draw) => html`${repeat(items, (item) => item.key, (item) => draw(item))}`;
  }

  /** The renderer's note in place of a component nothing draws. */
  function unknownNote(type: string, d: DrawContext): TemplateResult {
    return html`<div class="datum-live-unknown" role="note">
      <p><strong>${d.words("unknownComponent", { type })}</strong></p>
      <p>${d.words("unknownComponentHint")}</p>
    </div>`;
  }

  /** Records a type the binding does not draw (Datum's adapter draws it, or the renderer's note), and warns once per type. */
  function reportUnbound(componentId: string, type: string, drawnBy: "datum" | "nothing"): void {
    report(`${componentId}: component "${type}"`);
    warnOnce(
      `type:${type}`,
      drawnBy === "datum"
        ? `No adapter of this binding draws "${type}" (component "${componentId}"): Datum's adapter draws it.`
        : `Nothing draws "${type}" (component "${componentId}"): a note stands in its place. Give the binding an adapter for it (extendBinding), or remove the component.`
    );
  }

  function drawField(node: PresentationField, d: DrawContext, drawn: DrawnField[]): Item {
    trace("select", node.key);
    let state = baseFieldState(node, d);
    for (const feature of features) {
      if (feature.fieldState) {
        state = call(`${feature.id}.fieldState`, node.key, () => feature.fieldState?.(state, node, d)) ?? state;
      }
    }
    let resolved = resolve<FieldAdapter>("field", node.type, node.base, state);
    let content: TemplateResult | undefined;
    let used: FieldState = state;
    while (resolved && content === undefined) {
      const adapter = resolved.adapter;
      const adapted = stateForAdapter(state, adapter);
      let on: FieldEvents = writesFor(adapted);
      for (const feature of features) {
        if (feature.fieldEvents) {
          const current = on;
          on = call(`${feature.id}.fieldEvents`, node.key, () => feature.fieldEvents?.(current, adapted, node, d)) ?? current;
        }
      }
      const events = guarded(on, node.key);
      trace("template", node.key);
      content = call("template", node.key, () => adapter.template(adapted, events));
      if (content !== undefined) {
        used = adapted;
        break;
      }
      // The binding's template threw: Datum's draws the field, if it has another for it.
      const fallback = datum !== binding ? resolveAdapter<FieldAdapter>(datum, undefined, "field", node.type, node.base, state, whenHolds) : undefined;
      resolved = fallback && fallback.adapter !== adapter ? { ...fallback, from: fallback.from === "binding" ? "datum" : "datum-base" } : undefined;
    }
    const fallbackDrawn = resolved !== undefined && (resolved.from === "datum" || resolved.from === "datum-base");
    if (resolved === undefined || content === undefined) {
      reportUnbound(node.id, node.type, "nothing");
    } else {
      if (fallbackDrawn) {
        reportUnbound(node.id, node.type, "datum");
      }
      reportCapabilities(node.id, resolved.adapter, usedCapabilities(used));
    }
    const adapter = resolved !== undefined && content !== undefined ? resolved.adapter : undefined;
    const record: DrawnField = {
      key: node.key,
      node,
      state: used,
      adapter,
      from: adapter && resolved ? resolved.from : "renderer",
      via: adapter && resolved ? resolved.via : node.type
    };
    drawn.push(record);
    drawnBy.set(node.key, { from: record.from, via: record.via, ...(adapter?.name !== undefined ? { name: adapter.name } : {}) });
    const known = adapter !== undefined && content !== undefined;
    let inner: TemplateResult = known ? (content as TemplateResult) : unknownNote(node.type, d);
    const canvas = options.canvasHooks?.decorateField;
    if (canvas) {
      inner = call("decorateField", node.key, () => canvas(node.model, inner, node.paperOnly === true)) ?? inner;
    }
    // What the renderer itself draws in the wrapper, after the adapter's drawing: the worked-out
    // line an adapter does not draw (it keeps the id `describedBy` names), then the features'.
    const extras: View[] = [];
    if (used.workedOut !== undefined && used.workedOutId !== undefined && (!known || capabilityOf(adapter, "workedOut") !== "drawn")) {
      extras.push(html`<p class="datum-live-worked-out" id=${used.workedOutId} data-worked-out>${used.workedOut}</p>`);
    }
    for (const feature of features) {
      if (feature.fieldExtra) {
        const view = call(`${feature.id}.fieldExtra`, node.key, () => feature.fieldExtra?.(used, node, d));
        if (view !== undefined && view !== nothing) {
          extras.push(view);
        }
      }
    }
    const classes = ["datum-live-field", ...used.classNames].join(" ");
    const template = html`<div
      class=${classes}
      data-component-id=${used.componentId}
      data-value-path=${used.valuePath}
      data-instance=${used.key}
      data-kind=${known ? used.base : "unknown"}
      ?data-required=${used.required}
      ?data-invalid=${used.invalid}
      ?data-readonly=${used.readOnly}
      ?data-disabled=${used.disabled}
      ?data-over-limit=${used.overLimit}
      data-source=${ifDefined(used.source)}
      ?data-pending=${used.pending}
      aria-busy=${ifDefined(used.pending || used.source === "loading" ? "true" : undefined)}
      ?data-fallback=${fallbackDrawn}
    >${inner}${extras}</div>`;
    return { key: `${node.key}@${adapter ? adapterIdOf(adapter) : "unknown"}`, template };
  }

  function groupStateOf(node: PresentationGroup, slots: GroupState["slots"], d: DrawContext, given?: readonly GroupItem[]): GroupState {
    // Without the children drawn one by one, a slot is an item.
    const items = given ?? slots.map((slot) => ({ key: slot.slotId, content: slot.content }));
    const hintId = node.hint !== undefined ? `${node.model.accessibility.fieldId}__description` : undefined;
    // A layout grid's authored column spans: the cells' widths out of the twelve tracks.
    const spans = node.base === GRID_COMPONENT_TYPE ? readGridColumnWidths(node.model.node.configuration) : undefined;
    return {
      id: node.id,
      key: node.key,
      type: node.type,
      base: node.base,
      ...(node.legend !== undefined ? { legend: node.legend } : {}),
      ...(node.hint !== undefined ? { hint: node.hint } : {}),
      ...(hintId !== undefined ? { hintId } : {}),
      hideLegend: node.hideLegend,
      ...(node.legendMark !== undefined ? { legendMark: node.legendMark } : {}),
      level: node.level,
      layout: node.layout,
      ...(spans !== undefined ? { spans } : {}),
      classNames: node.classNames,
      model: node.model,
      slots,
      items,
      eachItem: eachItemOf(items),
      locale: d.form.locale,
      dir: d.form.dir,
      words: d.words,
      text: componentTextOf(node.model.node, d.form.locale, d.words.words)
    };
  }

  function containerWrapper(node: ContainerNode, base: string, content: View, onKeydown?: (event: KeyboardEvent) => void, fallback = false): TemplateResult {
    return html`<div class="datum-live-container" data-container-id=${node.id} data-kind=${base} ?data-fallback=${fallback && datum !== binding} @keydown=${onKeydown ?? nothing}>${content}</div>`;
  }

  /** A region Datum's hook drew inside another binding, tinted by the binding's `fallbackTokens`. */
  function fallbackRegion(view: View): View {
    return datum === binding || view === nothing ? view : html`<div class="datum-live-fallback" data-fallback>${view}</div>`;
  }

  function drawGroup(node: PresentationGroup, d: DrawContext): Item {
    const empty = options.canvasHooks?.emptySlot;
    // Every child is drawn once, on its own: a slot is its children keyed, a list's items are the same drawings.
    const slotItems = node.slots.map((slot) =>
      slot.children.length === 0 && empty
        ? [{ key: `${slot.slotId}@empty`, content: html`${call("emptySlot", node.key, () => empty({ containerId: node.id, slotId: slot.slotId })) ?? nothing}` }]
        : d.items(slot.children)
    );
    const slots = node.slots.map((slot, index) => ({
      slotId: slot.slotId,
      content: html`${repeat(slotItems[index] ?? [], (item) => item.key, (item) => item.content)}`
    }));
    const children = html`${slots.map((slot) => slot.content)}`;
    const state = groupStateOf(node, slots, d, slotItems.flat());
    let resolved = node.unknown === true ? undefined : resolve<GroupAdapter>("group", node.type, node.base, state);
    let fromFallback = false;
    if (!resolved) {
      // A container no adapter draws is drawn by Datum's container adapter, never flattened.
      reportUnbound(node.id, node.type, "datum");
      resolved = resolveAdapter<GroupAdapter>(datum, undefined, "group", FALLBACK_GROUP_TYPE, FALLBACK_GROUP_TYPE, state, whenHolds);
      fromFallback = true;
    } else if (resolved.from === "datum" || resolved.from === "datum-base") {
      reportUnbound(node.id, node.type, "datum");
    }
    let drawn: TemplateResult | undefined;
    if (resolved) {
      const adapter = resolved.adapter;
      drawn = call("template", node.key, () => adapter.template(state, children));
      if (drawn === undefined && datum !== binding && !fromFallback) {
        const fallback = resolveAdapter<GroupAdapter>(datum, undefined, "group", node.type, node.base, state, whenHolds) ?? resolveAdapter<GroupAdapter>(datum, undefined, "group", FALLBACK_GROUP_TYPE, FALLBACK_GROUP_TYPE, state, whenHolds);
        if (fallback && fallback.adapter !== adapter) {
          drawn = call("template", node.key, () => fallback.adapter.template(state, children));
          resolved = { ...fallback, from: "datum" };
        }
      }
    }
    const from: AdapterSource | "renderer" = resolved && drawn !== undefined ? (fromFallback ? "datum" : resolved.from) : "renderer";
    drawnBy.set(node.key, resolved && drawn !== undefined ? { from, via: resolved.via, ...(resolved.adapter.name !== undefined ? { name: resolved.adapter.name } : {}) } : { from: "renderer", via: node.type });
    if (resolved && drawn !== undefined) {
      reportCapabilities(node.id, resolved.adapter, usedContainerCapabilities("group", state));
    }
    let inner: TemplateResult = drawn ?? html`<div class="datum-live-group">${children}</div>`;
    const canvas = options.canvasHooks?.renderContainer;
    if (canvas) {
      inner =
        call("renderContainer", node.key, () =>
          canvas({ model: node.model, kind: "group", label: node.legend, slots: new Map(slots.map((slot) => [slot.slotId, slot.content])), paperOnly: node.paperOnly === true }, inner)
        ) ?? inner;
    }
    return { key: `${node.key}@group`, template: containerWrapper(node, node.base, inner, undefined, from === "datum" || from === "datum-base") };
  }

  /** A container kind no feature draws: its content plainly, in its wrapper, so nothing is lost. */
  function drawPlain(node: ContainerNode, d: DrawContext): View {
    // A journey page is its components: its heading and buttons are regions (the journey page module).
    if (node.kind !== "page") {
      warnOnce(`plain:${node.kind}`, `No renderer module draws "${node.kind}" containers: their content is drawn plainly.`);
    }
    switch (node.kind) {
      case "tabs":
        return containerWrapper(node, node.base, html`${node.tabs.map((tab) => d.nodes(tab.children))}`);
      case "steps":
        return containerWrapper(node, "steps", html`${node.steps.filter((step) => step.shown).map((step) => d.nodes(step.children))}${d.nodes(node.others)}`);
      case "grid":
        return containerWrapper(node, node.base, html`${node.rows.map((row) => html`${row.cells.map((cell) => d.nodes(cell.children))}`)}`);
      case "page":
        return d.nodes(node.children);
      case "group":
        return nothing;
    }
  }

  function drawNode(node: PresentationNode, d: DrawContext, drawn: DrawnField[]): Item {
    if (node.kind === "field") {
      return drawField(node, d, drawn);
    }
    for (const feature of features) {
      if (feature.drawNode) {
        const view = call(`${feature.id}.drawNode`, node.key, () => feature.drawNode?.(node, d));
        if (view !== undefined) {
          return { key: `${node.key}@${node.kind}`, template: view };
        }
      }
    }
    if (node.kind === "group") {
      return drawGroup(node, d);
    }
    return { key: `${node.key}@${node.kind}`, template: drawPlain(node, d) };
  }

  function formClassOf(d: DrawContext, decor: FormDecor): string {
    const own = binding.formClass;
    const extra = typeof own === "function" ? call("formClass", undefined, () => own({ colorScheme: d.form.colorScheme, locale: d.form.locale })) : own;
    const classes = ["datum-live", ...(typeof extra === "string" && extra.trim() !== "" ? [extra.trim()] : []), ...(decor.classes ?? [])];
    return classes.join(" ");
  }

  /** What the features put on the form element itself (a frame), merged in `features` order. */
  function decorOf(d: DrawContext): FormDecor {
    const classes: string[] = [];
    const attributes: Record<string, string> = {};
    for (const feature of features) {
      if (feature.formDecor) {
        const decor = call(`${feature.id}.formDecor`, undefined, () => feature.formDecor?.(d));
        classes.push(...(decor?.classes ?? []));
        Object.assign(attributes, decor?.attributes ?? {});
      }
    }
    return { classes, attributes };
  }

  /** Puts the decorated attributes on the form, taking off those an earlier draw put on that this one does not. */
  function applyDecorAttributes(form: HTMLFormElement | null, attributes: Readonly<Record<string, string>>): void {
    for (const name of decorAttributes) {
      if (!(name in attributes)) {
        form?.removeAttribute(name);
      }
    }
    decorAttributes = Object.keys(attributes);
    for (const [name, value] of Object.entries(attributes)) {
      form?.setAttribute(name, value);
    }
  }

  /**
   * A region's views, keyed by the feature that drew each: one feature's view appearing or going
   * away leaves the nodes of the others (and the focus in them) where they are.
   */
  function regionOf(region: FormRegion, d: DrawContext): View {
    const views: Array<{ key: string; view: View }> = [];
    if (region === "alerts" && partlyShown) {
      views.push({ key: "\u0000renderer:partly-shown", view: html`<p class="datum-live-alert" role="alert">${d.words("formPartlyShown")}</p>` });
    }
    const seen = new Map<string, number>();
    for (const feature of features) {
      if (feature.region) {
        const view = call(`${feature.id}.region`, region, () => feature.region?.(region, d));
        if (view !== undefined && view !== nothing) {
          // Two features under one id keep apart by their order among those that share it.
          const count = seen.get(feature.id) ?? 0;
          seen.set(feature.id, count + 1);
          views.push({ key: count === 0 ? `feature:${feature.id}` : `feature:${feature.id}#${count}`, view });
        }
      }
    }
    if (views.length === 0) {
      return nothing;
    }
    const view = html`${repeat(views, (entry) => entry.key, (entry) => entry.view)}`;
    const decorate = options.canvasHooks?.decorateRegion;
    return decorate ? (call("decorateRegion", region, () => decorate(region, view)) ?? view) : view;
  }

  /**
   * `aria-readonly` on the field's choice controls while it is read-only (guards.ts), off again
   * once it is not: after every draw, and once more when the field is ready, since a design
   * system's component draws the controls in its shadow root only once it has upgraded.
   */
  function markReadOnlyOf(field: DrawnField, instance: Instance): void {
    const readOnly = field.state.readOnly && !field.state.disabled;
    if (readOnly || instance.readOnlyMarked) {
      instance.readOnlyMarked = markReadOnly(instance.wrapper, readOnly);
    }
  }

  /**
   * For a field whose ids its binding's markup writes (`idsWrittenBy: "binding"`): each id in
   * `describedBy` is carried by an element of the form, else the control is described by nothing
   * there. One that is not is reported once.
   */
  function checkIds(field: DrawnField): void {
    for (const id of field.state.describedBy) {
      const seen = `${field.key}\u0000${id}`;
      if (missingIds.has(seen) || root.getElementById(id) !== null) {
        continue;
      }
      missingIds.add(seen);
      error({ hook: "ids", id: field.key, message: `the field names "${id}" in describedBy, and nothing in the form carries that id: draw it, or answer the capability it belongs to "none"` });
    }
  }

  /** Records each component of one of the binding's own types the definition's `kinds` map does not name, once. */
  function reportMissingKinds(output: RenderOutput, definitionKinds: Readonly<Record<string, string>> | undefined): void {
    if (binding.kinds === undefined) {
      return;
    }
    const visit = (model: RenderComponentModel): void => {
      if (needsKindsEntry(binding, definitionKinds, model.type)) {
        const entry = `${model.id}: component "${model.type}" has no kinds entry`;
        if (!unsupported.has(entry)) {
          report(entry);
          warnOnce(
            `kinds:${model.type}`,
            `"${model.type}" (component "${model.id}") is this binding's own type, and the definition's kinds map does not name it: it is drawn as "${binding.kinds?.[model.type]}", but validation and the server read it as an unknown type. Add "kinds": { "${model.type}": "${binding.kinds?.[model.type]}" } to the definition.`
          );
        }
      }
      for (const entry of model.rows?.entries ?? []) {
        entry.forEach(visit);
      }
    };
    output.components.forEach(visit);
  }

  /** Every field wrapper the root holds now, by instance key. */
  function collectWrappers(): Map<string, HTMLElement> {
    const out = new Map<string, HTMLElement>();
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(".datum-live-field[data-instance]"))) {
      const key = element.getAttribute("data-instance");
      if (key !== null && !out.has(key)) {
        out.set(key, element);
      }
    }
    return out;
  }

  /**
   * A submission in flight locks the body: `inert` on every field and container the
   * form holds at its top level takes them out of focus and pointer reach (the header and footer
   * regions lock themselves). Lifted, focus goes back to the control that had it when the lock
   * came, unless something took it meanwhile (the first error, a notice).
   */
  function applySubmissionLock(form: HTMLFormElement | null, on: boolean): void {
    if (form) {
      for (const child of Array.from(form.children)) {
        if (child.matches(".datum-live-field, .datum-live-container, .datum-live-unknown")) {
          child.toggleAttribute("inert", on);
        }
      }
    }
    const lifted = locked && !on;
    const snapshot = lockedFocus;
    locked = on;
    if (!lifted) {
      return;
    }
    lockedFocus = undefined;
    if (snapshot === undefined || root.activeElement !== null) {
      return;
    }
    if (snapshot.element.isConnected) {
      snapshot.element.focus();
    } else if (snapshot.key !== null) {
      focusField(snapshot.key);
    }
  }

  function draw(output: RenderOutput): void {
    if (!mounted || failed) {
      return;
    }
    if (drawingNow) {
      redrawQueued = true;
      return;
    }
    if (composing && draws > 0) {
      // Nothing is written into a box while an input method is composing in it: this output (a
      // build that was already out, its provisional twin, a redraw) is dropped, and the end of the
      // composition asks for a fresh build.
      requestWhileComposing = true;
      return;
    }
    drawingNow = true;
    try {
      drawOnce(output);
    } finally {
      drawingNow = false;
      releaseHeldEvents();
    }
    if (redrawQueued) {
      redrawQueued = false;
      redraw();
    }
  }

  function drawOnce(output: RenderOutput): void {
    lastOutput = output;
    const state = runtime.state();
    const locale = state.locale;
    const definitionKinds = runtime.definition?.().kinds;
    // The binding's own tier-2 types stand under the definition's map in the drawing.
    const kinds = drawingKindsOf(binding, definitionKinds);
    reportMissingKinds(output, definitionKinds);
    const tree = foldPresentation(output, {
      locale,
      ...(options.texts ? { texts: options.texts } : {}),
      ...(pack ? { bindingPack: pack } : {}),
      translations: runtime.translations?.(),
      translationCatalog: runtime.translationCatalog?.(),
      kinds,
      ...(options.journeyKit ? { journeyKit: options.journeyKit } : {}),
      ...(runtime.dataGridRowBounds ? { dataGridRowBounds: runtime.dataGridRowBounds() } : {}),
      ...(options.includeHidden === true ? { includeHidden: true } : {}),
      // A screen: a component drawn on paper only is left out, as a hidden one is.
      surface: "screen",
      ...(options.headingLevel !== undefined ? { headingLevel: options.headingLevel } : {}),
      // The builder canvas draws an empty container: it is where the first component is dropped.
      ...(options.canvasHooks !== undefined ? { keepEmpty: true } : {}),
      ...(options.dataGridRows === "template" ? { dataGridRows: "template" as const } : {}),
      // A container a binding draws although the engine does not know it is no unknown one.
      isKnownContainer: (type) => resolve("group", type, type) !== undefined
    });
    lastTree = tree;
    drawnBy.clear();
    // The fold's words: the host's texts (a journey page's over them), the form's translations,
    // the binding's pack, the engine's English.
    const textWords = tree.text;
    const formState: FormDrawState = {
      mode,
      locale,
      dir: output.meta.textDirection,
      busy: busy(),
      colorScheme: options.colorScheme ?? "light",
      printing,
      words: textWords
    };
    if (formState.busy === "submitting" && !locked) {
      // Before the draw takes the control out of reach: it is what the person gets back when the lock lifts.
      const active = root.activeElement;
      lockedFocus = active instanceof HTMLElement ? { element: active, key: active.closest("[data-instance]")?.getAttribute("data-instance") ?? null } : undefined;
    }
    const drawn: DrawnField[] = [];
    const d: DrawContext = {
      live: context,
      output,
      tree,
      form: formState,
      words: textWords,
      kinds,
      nodes: (nodes) => list(nodes.map((node) => drawNode(node, d, drawn))),
      items: (nodes) => nodes.map((node) => itemOf(drawNode(node, d, drawn))),
      container: containerWrapper,
      fallback: fallbackRegion,
      groupState: (node, slots) => groupStateOf(node, slots, d)
    };
    const body = d.nodes(tree.nodes);
    // A hook may unmount the form (its events wait for the draw's end, its own code does not):
    // nothing is drawn, made or called after that.
    if (!mounted) {
      return;
    }
    // The state the guard and the after hooks read is this draw's.
    const previous = new Map(fieldsByKey);
    fieldsByKey.clear();
    for (const field of drawn) {
      fieldsByKey.set(field.key, field);
    }
    const staying = new Map(drawn.flatMap((field) => (field.adapter ? [[field.key, adapterIdOf(field.adapter)] as const] : [[field.key, 0] as const])));
    const removed = releaseLeaving(staying);
    trace("render");
    const decor = decorOf(d);
    // The instances let go and the form's decor ran hooks too.
    if (!mounted) {
      return;
    }
    render(
      html`<form
        class=${formClassOf(d, decor)}
        novalidate
        dir=${formState.dir}
        lang=${locale}
        data-mode=${mode}
        aria-busy=${ifDefined(formState.busy !== undefined ? "true" : undefined)}
        @submit=${onSubmit}
      >${regionOf("alerts", d)}${regionOf("header", d)}${regionOf("languages", d)}${regionOf("summary-top", d)}${regionOf("page-header", d)}${body}${regionOf("page-actions", d)}${regionOf("summary-bottom", d)}${regionOf("footer", d)}${regionOf("live", d)}</form>`,
      root
    );
    if (!mounted) {
      // A feature's region view unmounted the form while it was drawn.
      render(nothing, root);
      return;
    }
    draws += 1;
    const form = formElement();
    if (form) {
      form.toggleAttribute("data-settling", settlingFirst);
    }
    applyDecorAttributes(form, decor.attributes ?? {});
    applySubmissionLock(form, formState.busy === "submitting");
    const wrappers = collectWrappers();
    const added: DrawnField[] = [];
    for (const field of drawn) {
      if (!mounted) {
        return;
      }
      const wrapper = wrappers.get(field.key);
      if (!wrapper) {
        continue;
      }
      let instance = instances.get(field.key);
      if (instance && instance.wrapper !== wrapper) {
        // Its nodes were made again (a container around it changed adapter): a new instance.
        release(field.key, instance);
        instance = undefined;
      }
      if (!instance) {
        const key = field.key;
        // Read-only choice controls take focus but no change (guards.ts), whatever the binding draws.
        const guard = installReadOnlyGuard(wrapper, () => {
          const current = fieldsByKey.get(key)?.state;
          return mounted && current !== undefined && current.readOnly && !current.disabled;
        });
        instance = { adapterId: field.adapter ? adapterIdOf(field.adapter) : 0, wrapper, cleanups: [guard], connected: false, readOnlyMarked: false };
        instances.set(field.key, instance);
        added.push(field);
      }
      markReadOnlyOf(field, instance);
      const adapter = field.adapter;
      if (adapter?.after) {
        const at = instance;
        trace("after", field.key);
        call("after", field.key, () => adapter.after?.(at.wrapper, field.state));
      }
      if (adapter !== undefined && adapter.idsWrittenBy !== "component") {
        checkIds(field);
      }
    }
    if (!mounted) {
      return;
    }
    lastFields = drawn;
    const first = draws === 1;
    if (added.length > 0 || first) {
      const settling = settle(added, first);
      track(settling);
      if (first) {
        firstSettle = settling;
      }
    }
    if (first) {
      firstProvisional = provisionalDraw;
      markFirstDrawn();
    }
    const report: DrawReport = {
      draw: draws,
      added: added.map((field) => field.key),
      removed,
      updated: drawn.filter((field) => !added.includes(field) && previous.has(field.key)).map((field) => field.key),
      output,
      tree
    };
    for (const feature of features) {
      if (!mounted) {
        return;
      }
      if (feature.afterDraw) {
        call(`${feature.id}.afterDraw`, undefined, () => feature.afterDraw?.(report, context));
      }
    }
  }

  // ── The context every feature gets ──

  const context: LiveContext = {
    root,
    runtime,
    binding,
    datum,
    mode,
    options,
    mounted: () => mounted,
    form: formElement,
    output: () => lastOutput,
    tree: () => lastTree,
    fields: () => lastFields,
    field: (key) => fieldsByKey.get(key),
    wrapperOf,
    redraw,
    request,
    updated,
    emit,
    error,
    warnOnce,
    report,
    reportCapabilities,
    recordAdapter: (key, entry) => {
      drawnBy.set(key, entry);
    },
    call,
    resolve,
    focusField,
    focusElement,
    setBusy: (kind, on) => {
      const had = busyFlags.has(kind);
      if (on) {
        busyFlags.add(kind);
      } else {
        busyFlags.delete(kind);
      }
      if (had !== on) {
        redraw();
      }
    },
    busy,
    printing: () => printing,
    setPrinting: (on) => {
      if (printing !== on) {
        printing = on;
        redraw();
      }
    },
    focusErrors,
    settleInput,
    memory: <T>(owner: string, make: () => T): T => {
      if (!memories.has(owner)) {
        memories.set(owner, make());
      }
      return memories.get(owner) as T;
    },
    typedParts: (key, stored) => {
      const entry = typed.get(key);
      return entry !== undefined && entry.composed === stored ? entry.parts : undefined;
    },
    trace
  };

  // ── Listening ──

  function listen(): void {
    const events = runtime.events();
    for (const type of REDRAW_EVENTS) {
      stops.push(events.subscribe(type, request));
    }
    // A write to a date from anywhere but its own boxes replaces what was typed in them, even when
    // it writes the answer they compose to (the host clearing a half-typed date blanks the boxes).
    stops.push(
      events.subscribe(FormEventType.COMPONENT_CHANGED, (event) => {
        if (writingParts || typed.size === 0 || !event.path) {
          return;
        }
        const written = stringifyComponentPath(event.path);
        for (const [key, entry] of typed) {
          if (entry.path === written) {
            typed.delete(key);
          }
        }
      })
    );
    stops.push(
      events.subscribe(FormEventType.VALIDATION_STARTED, (event) => {
        // A whole-form check (no `paths`) makes the form busy; one field's check makes that field pending.
        const paths = (event.data as { paths?: unknown } | undefined)?.paths;
        if (!Array.isArray(paths)) {
          validating = true;
        }
      })
    );
    for (const type of VALIDATION_SETTLED_EVENTS) {
      stops.push(
        events.subscribe(type, (event) => {
          // The end of one field's check (`paths`) leaves a whole-form check running.
          const paths = (event.data as { paths?: unknown } | undefined)?.paths;
          const scoped = (type === FormEventType.VALIDATION_COMPLETED || type === FormEventType.VALIDATION_FAILED) && Array.isArray(paths);
          if (!scoped) {
            validating = false;
          }
        })
      );
    }
    const onCompositionStart = (): void => {
      composing = true;
    };
    const onCompositionEnd = (): void => {
      composing = false;
      if (requestWhileComposing) {
        requestWhileComposing = false;
        request();
      }
    };
    root.addEventListener("compositionstart", onCompositionStart);
    root.addEventListener("compositionend", onCompositionEnd);
    stops.push(() => {
      root.removeEventListener("compositionstart", onCompositionStart);
      root.removeEventListener("compositionend", onCompositionEnd);
    });
  }

  /** The form could not be drawn: an alert takes its place, the host hears why, and nothing draws again. */
  function failLoud(hook: string, thrown: unknown): void {
    failed = true;
    const detail: BindingErrorDetail = { hook, message: messageOf(thrown) };
    const url = (thrown as { url?: unknown } | null)?.url;
    if (typeof url === "string") {
      detail.url = url;
    }
    render(html`<p class="datum-live-alert" role="alert">${words()("formNotShown")}</p>`, root);
    error(detail);
  }

  /**
   * The binding's form-level start: the design system's own script started
   * scoped to the form. Called once per mount, after the first draw is ready, never on a redraw
   * (a design system's init is rarely idempotent); handed the form element as the scope, never
   * the shadow root (not an Element: a scoped init given it finds nothing and says nothing). What
   * it returns (or resolves to) is its cleanup, run on unmount; a start that throws or rejects is
   * reported as `datum-binding-error` (hook `connect`) and the form stays as drawn.
   */
  function connectForm(): void {
    const start = binding.connect;
    const form = formElement();
    if (!start || !form) {
      return;
    }
    const keep = (stop: unknown): void => {
      if (typeof stop !== "function") {
        return;
      }
      if (mounted) {
        stops.push(stop as () => void);
      } else {
        call("connect", undefined, () => (stop as () => void)());
      }
    };
    let result: unknown;
    try {
      result = start.call(binding, root, form);
    } catch (thrown) {
      error({ hook: "connect", message: messageOf(thrown) });
      return;
    }
    if (isThenable(result)) {
      Promise.resolve(result).then(keep, (thrown: unknown) => {
        if (mounted) {
          error({ hook: "connect", message: messageOf(thrown) });
        }
      });
      return;
    }
    keep(result);
  }

  // ── Mounting ──

  // The root's sheets before the form: what unmount leaves. A sheet a design system adopts while
  // the form is mounted (a Stencil library's shared sheet, adopted into the nearest shadow root
  // and never taken away) goes with the renderer's own, whichever binding drew.
  const sheetsBefore: ReadonlySet<CSSStyleSheet> | undefined = Array.isArray((root as { adoptedStyleSheets?: unknown }).adoptedStyleSheets) ? new Set(root.adoptedStyleSheets) : undefined;
  stops.push(() => {
    if (sheetsBefore !== undefined && Array.isArray((root as { adoptedStyleSheets?: unknown }).adoptedStyleSheets) && root.adoptedStyleSheets.some((sheet) => !sheetsBefore.has(sheet))) {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => sheetsBefore.has(sheet));
    }
  });
  const unadopt = adoptOwnSheets(root, ownSheetsCss(binding, datum));
  stops.push(unadopt);

  const ready = (async (): Promise<void> => {
    try {
      for (const feature of features) {
        if (feature.prepare) {
          const undo = await feature.prepare(context);
          if (typeof undo === "function") {
            if (mounted) {
              stops.push(undo);
            } else {
              undo();
            }
          }
        }
        if (!mounted) {
          return;
        }
      }
    } catch (thrown) {
      if (mounted) {
        failLoud("assets", thrown);
      }
      throw thrown;
    }
    for (const feature of features) {
      if (feature.start) {
        const stop = call(`${feature.id}.start`, undefined, () => feature.start?.(context));
        if (typeof stop === "function") {
          stops.push(stop);
        }
      }
    }
    listen();
    build();
    const firstBuild = building;
    try {
      // The first build, or a provisional draw while a data source is still out, whichever is first.
      await Promise.race([firstBuild, firstDrawn]);
    } catch (thrown) {
      if (mounted) {
        failLoud("render", thrown);
      }
      throw thrown;
    }
    if (draws > 0 && firstProvisional) {
      // Shown from the answers known so far: ready once its fields are, not when the sources answer.
      await firstSettle;
    } else {
      await updated();
    }
    if (!mounted) {
      return;
    }
    connectForm();
    const check = binding.designSystem?.selfCheck;
    if (check) {
      const problems = call("self-check", undefined, () => check.call(binding.designSystem, root)) ?? [];
      if (problems.length > 0) {
        error({ hook: "self-check", message: problems.join("; "), problems });
      }
    }
  })();
  // A host that never awaits `ready` must not see an unhandled rejection; one that does still gets it.
  ready.catch(() => undefined);

  return {
    root,
    ready,
    updated,
    draws: () => draws,
    unsupported: () => [...unsupported],
    adapterOf: (key) => drawnBy.get(key),
    selfCheck: () => {
      const check = binding.designSystem?.selfCheck;
      const problems = mounted && !failed && check ? (call("self-check", undefined, () => check.call(binding.designSystem, root)) ?? []) : [];
      return {
        problems: [...problems],
        unsupported: [...unsupported],
        adapters: [...drawnBy].map(([key, entry]) => ({ key, ...entry })),
        sideEffects: (binding.designSystem?.sideEffects ?? []).map((entry) => ({ target: entry.target, effect: entry.effect }))
      };
    },
    focusField,
    reveal: revealComponent,
    focusErrors,
    settleInput,
    setBusy: context.setBusy,
    tree: () => lastTree,
    fields: () => lastFields,
    request,
    redraw,
    capabilitiesOf: (type) => fieldCapabilitiesOf(binding, datum, type, runtime.definition?.().kinds),
    unmount: () => {
      if (!mounted) {
        return;
      }
      trace("unmount");
      for (const [key, instance] of [...instances]) {
        release(key, instance);
      }
      mounted = false;
      token += 1;
      for (const stop of stops.splice(0).reverse()) {
        try {
          stop();
        } catch (thrown) {
          console.error(`[binding ${binding.id}] a clean-up failed on unmount`, thrown);
        }
      }
      render(nothing, root);
      lastFields = [];
      fieldsByKey.clear();
      lastOutput = undefined;
      lastTree = undefined;
      typed.clear();
      interim.clear();
    }
  };
}
