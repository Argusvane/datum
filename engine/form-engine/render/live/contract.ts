/**
 * The binding contract: what a binding hands the live renderer (`mount.ts`) and what the
 * renderer hands each adapter. A binding draws leaf markup only, in its design system's own
 * vocabulary; everything Datum owns (the answers, the rules, validation and its wording, focus,
 * the state hooks, read-only and disabled, rows, tabs, pages) stays the renderer's.
 *
 * - A binding module exports `createBinding(lit, datum)` ({@link BindingFactory}); the host passes
 *   the renderer's one lit namespace (`lit.ts`), so a binding never imports lit by specifier and
 *   needs it only as a type, and the Datum binding, so a binding wraps or patches one of Datum's
 *   adapters rather than copying it.
 * - Adapters are looked up by component type with the chain binding[type] -> binding[base] ->
 *   datum[type] -> datum[base] ({@link resolveAdapter}): `base` is the engine type the
 *   definition's `kinds` map reads a design system's own type as (`registry/kinds.ts`). Each
 *   adapter says which node it draws (`kind`), so a field adapter is never asked to draw a
 *   container under the same type.
 * - Capabilities are data: per drawing capability (`registry/capabilities/drawing-capabilities.ts`)
 *   an adapter answers `drawn`, `degraded` or `none` (unanswered is `none`), plus behaviour flags
 *   saying who runs the keys and who counts characters. The renderer reads every answer: a field's
 *   and a container's capability answered `none` and used is recorded in `unsupported()`.
 * - A binding's own tier-2 types and the engine type each reads as (`LiveBinding.kinds`) stand
 *   under the definition's `kinds` map in the drawing; a form that uses one without the
 *   definition's entry is drawn as the base and reported, since only the definition's map reaches
 *   validation and the server.
 * - Adapters receive pre-worded state: blocking errors only in `errors`, warnings and info as
 *   `notices`, ids that exist in `describedBy`, the form's words in `words`. No adapter words
 *   anything, assembles an IDREF (unless its component writes the ids itself, `idsWrittenBy`)
 *   or writes a state hook ({@link STATE_HOOKS}).
 * - Lifecycle per field: select -> render (template) -> after (every draw) -> ready (new fields,
 *   budgeted) -> connect (returns its cleanup, run when the field leaves or the form unmounts).
 *
 * Types and pure functions only: nothing here draws, and nothing reaches lit at run time.
 */
import type { FormTextResolver } from "../../core/localization/form-texts.js";
import type { LanguagePackTable } from "../../core/localization/translations.js";
import {
  appliesToKind,
  DRAWING_CAPABILITIES,
  type DrawingCapabilityId,
  type DrawingSupport
} from "../../registry/capabilities/drawing-capabilities.js";
import { baseTypeOf, containerBaseOf, kindOf, type FieldKind } from "../../registry/kinds.js";
import type { LayoutSpec, RenderComponentModel } from "../core/component-model.js";
import type { ReviewAction, ReviewRowStatus } from "../core/journey-review.js";
import type { PresentationReveal } from "../core/presentation-tree.js";
import type { PdfThemeDefinition } from "../pdf/pdf-theme-defaults.js";
import type { StepStatus } from "../../core/schema/steps.js";
import type { FormNoticeKind } from "../../core/submission/form-notice.js";
import type { FormFrameDefinition } from "./datum/frames.js";
import type { Lit, Nothing, TemplateResult } from "./lit.js";

// ── Factory ────────────────────────────────────────────────────────────────────────────────

/**
 * A binding module's one export: the binding, drawn with the lit namespace the host passes in.
 * `datum` is the Datum binding the host mounts behind it as the fallback (`LiveMountOptions.datum`,
 * the same object): a binding takes one of its adapters to wrap or patch (`{ ...datum.components.date,
 * template }`, `datum.components.date.focusTarget`), never copies one. A binding that needs none of
 * Datum's ignores it.
 */
export type BindingFactory = (lit: Lit, datum: LiveBinding) => LiveBinding;

/** What a binding module looks like to a host that loads it (`import("./my-binding.js")`). */
export interface BindingModule {
  createBinding: BindingFactory;
}

/** A template, or nothing drawn. `lit.nothing` is one, destructured or not ({@link Nothing}). */
export type View = TemplateResult | Nothing;

// ── Capabilities ───────────────────────────────────────────────────────────────────────────

/** Which node an adapter draws: a leaf (an input, a button, static content), or one of the containers. */
export type AdapterKind = "field" | "group" | "tabs" | "grid" | "steps";

/**
 * An adapter's answers per drawing capability; a capability left out is `none`.
 *
 * - `drawn`: the adapter draws what the state carries for it, as authored, and the renderer adds
 *   the behaviour it owns for it. A count the adapter draws (its limit sentence under
 *   `characterCount.limitId`, its status) is `drawn` whoever counts: with
 *   `behaviour.countsCharacters: "renderer"` (the default) the renderer's announcer reads it out,
 *   and it speaks only for a count answered `drawn`.
 * - `degraded`: drawn in a reduced form, which the renderer may complete: a tooltip or a pending
 *   word folded into the hint, a notice drawn as hint-styled text with its severity word, row
 *   numbers that cannot be turned off. A degraded count is drawn but not announced. A design
 *   system's scripted component left on its no-JavaScript baseline is `degraded` only when
 *   what it draws is reduced; one whose markup is drawn as its script leaves it, with the
 *   behaviour the renderer's (the count, the reveal), is `drawn`.
 * - `none`: not drawn. The renderer leaves the capability's id out of `describedBy` and records
 *   `<component id>: <capability>` in `unsupported()` when the form uses it.
 */
export type CapabilityAnswers = Readonly<Partial<Record<DrawingCapabilityId, DrawingSupport>>>;

/**
 * Who does what beside the drawing, where the renderer would otherwise do it. Datum's code-point
 * count and its over-limit error always apply whatever `countsCharacters` says, and no adapter
 * writes `maxlength`. Who draws an error message is not a flag: the renderer draws none, so
 * whatever an adapter draws (its own markup, a component's property) is the field's only one.
 */
export interface AdapterBehaviour {
  /** Who runs the keys of a composite (tabs, a listbox): the component, or the renderer. */
  keyboard?: "component" | "renderer";
  /** Who counts and announces a counted field: the component, or the renderer's announcer. */
  countsCharacters?: "component" | "renderer";
}

/** The behaviour an adapter has when it says nothing. */
export const DEFAULT_BEHAVIOUR: Readonly<Required<AdapterBehaviour>> = Object.freeze({
  keyboard: "renderer",
  countsCharacters: "renderer"
});

/** The answer an adapter gives for one capability: what it says, else `none`. */
export function capabilityOf(adapter: Pick<AdapterBase, "capabilities"> | undefined, capability: DrawingCapabilityId): DrawingSupport {
  return adapter?.capabilities?.[capability] ?? "none";
}

/**
 * An adapter's answer for every drawing capability that applies to `kind` (a capability the
 * registry does not ask of that kind is left out): what the builder's inspector shows, hides
 * (`none`) or notes (`degraded`).
 */
export function capabilityAnswers(adapter: Pick<AdapterBase, "capabilities"> | undefined, kind: FieldKind): Record<DrawingCapabilityId, DrawingSupport> {
  const out = {} as Record<DrawingCapabilityId, DrawingSupport>;
  for (const capability of DRAWING_CAPABILITIES) {
    if (capability.kinds.includes(kind)) {
      out[capability.id] = capabilityOf(adapter, capability.id);
    }
  }
  return out;
}

/** An adapter's behaviour with the defaults filled in. */
export function behaviourOf(adapter: Pick<AdapterBase, "behaviour"> | undefined): Required<AdapterBehaviour> {
  return { ...DEFAULT_BEHAVIOUR, ...(adapter?.behaviour ?? {}) };
}

// ── Words ──────────────────────────────────────────────────────────────────────────────────

/**
 * The form's words for the locale, layered as the engine layers them: the host's texts, the
 * form's `texts` translations, the binding's language pack, then the engine's English. What an
 * adapter calls for a word it draws itself ("(optional)", a date's "Day", a notice's
 * "Warning: "); no word is written into a template.
 */
export type Words = FormTextResolver;

// ── Form state ─────────────────────────────────────────────────────────────────────────────

/** How a whole form is drawn: live; read-only (looks live, takes nothing, no summary); disabled (greyed out). */
export type LiveMode = "interactive" | "readonly" | "disabled";

/** What the form is busy with: the renderer sets `aria-busy` on the form, and button adapters draw `aria-disabled`. */
export type FormBusy = "submitting" | "validating" | "navigating";

/** The form as a whole, as one draw sees it. */
export interface FormDrawState {
  mode: LiveMode;
  locale: string;
  dir: "ltr" | "rtl";
  busy: FormBusy | undefined;
  colorScheme: "light" | "dark";
  /**
   * The form is being printed (`LiveContext.setPrinting`): a container that pages its content
   * (steps, tabs) draws every panel, headed and in order, with no indicator or buttons.
   */
  printing: boolean;
  words: Words;
}

// ── Field state ────────────────────────────────────────────────────────────────────────────

/** A warning or info message on a field: never blocking, never in the summary, never drawn as an error. */
export interface FieldNotice {
  code: string;
  severity: "warning" | "info";
  message: string;
}

/** Where a field drawn in a row of a collection sits. */
export interface FieldRow {
  /** 0-based. */
  index: number;
  /** The row's label ("Row 2", "Child 2"). */
  label: string;
  /** The row's stable identity, when the runtime keeps one. */
  rowKey?: string;
  collectionPath: string;
  /** The collection-bound container's component id. */
  ownerId: string;
}

/** Where a field's choices come from a data source that has not answered, failed, or was cut to the cap. */
export type FieldSource = "loading" | "error" | "truncated";

/**
 * What the renderer has resolved about one field, common to every adapter. Ids are the engine's
 * (`AccessibilitySemantics`); `describedBy` lists only ids this field's drawing carries (an id
 * for a capability the adapter answers `none` is left out).
 */
export interface FieldState {
  /** The instance: the component id, or a row-scoped key inside a row. Instances, wrappers and hooks go by it. */
  key: string;
  componentId: string;
  /** The type written on the component. */
  type: string;
  /** The engine type it is read as (itself for an engine type). */
  base: string;
  /** How its answer reads; absent for a type that holds no answer (a button, static HTML, an image). */
  kind?: FieldKind;
  /** The control's id: what a label's `for` names. */
  id: string;
  /** A name for a control that wants one (a radio group's shared name): unique per instance. */
  name: string;
  /** Where the answer is stored. */
  valuePath: string;
  label: string;
  labelId: string;
  hideLabel: boolean;
  /** Help text: the description (and what the renderer folds in for a capability the adapter answers `degraded`). */
  hint?: string;
  /** The id the hint must carry; present with `hint`. */
  hintId?: string;
  /**
   * On a journey page, the line saying the value is worked out from other answers (the
   * `workedOut` form text): an adapter answering `workedOut` `drawn` draws it as its own
   * element carrying `workedOutId`, which `describedBy` names after the hint. Otherwise the
   * renderer draws it in the field's wrapper after the adapter's drawing (`none`), or folds it into
   * the hint (`degraded`, for a component that words its own description).
   */
  workedOut?: string;
  /** The id the worked-out line carries; present with `workedOut`. */
  workedOutId?: string;
  /** The stored answer as text: `""` for no answer and for an answer that is no scalar. */
  value: string;
  /** The stored answer as it is. */
  answer: unknown;
  required: boolean;
  readOnly: boolean;
  disabled: boolean;
  /** A blocking error is shown on the field: what `aria-invalid` says. Warnings and info never set it. */
  invalid: boolean;
  /** The blocking errors, worded, when the form shows errors on fields; empty otherwise. */
  errors: readonly string[];
  /** `errors` joined, for a component that takes one message. */
  message?: string;
  /** The id the error message must carry; present when `errors` is not empty. */
  errorId?: string;
  /** Warnings and info, worded. */
  notices: readonly FieldNotice[];
  /** The id the notices must carry (`${id}__notice`); present when `notices` is not empty. */
  noticeId?: string;
  /** The ids that describe the control, in the engine's order: description, worked-out line, notices, count, error. */
  describedBy: readonly string[];
  /** An async check covering this field's answer is running. */
  pending: boolean;
  /** The state of a data source the field's choices come from, when it is not plainly answered. */
  source?: FieldSource;
  /** The form is busy (a submit, a whole-form check, a page change): a button draws `aria-disabled`. */
  busy: FormBusy | undefined;
  /** A counted field holds more characters than its limit. */
  overLimit: boolean;
  locale: string;
  dir: "ltr" | "rtl";
  /** The author's classes (`configuration.cssClass`); the renderer puts them on the field's wrapper. */
  classNames: readonly string[];
  /** In a row of a collection: which row. */
  row?: FieldRow;
  /** The tabs and steps that must be open for the field to be seen, outermost first. */
  reveal: readonly PresentationReveal[];
  mode: LiveMode;
  words: Words;
  /**
   * One of the component's own configuration texts (`configuration[property]`, a string in the
   * form's default language) worded for the locale: the form's translation at
   * `components › <id> › <property>`, the host catalog's over it, else the authored string. What a plugin's or a binding's adapter draws for a property of its own type (a
   * card's `title`); `undefined` when the component authors no such text.
   */
  text(property: string): string | undefined;
  /** The engine's model, for what no state member carries (a plugin type's own configuration). */
  model: RenderComponentModel;
}

/** A counted field's figures and the words Datum uses for them. */
export interface CharacterCount {
  max: number;
  count: number;
  /** Negative when over. */
  left: number;
  over: boolean;
  /** "You can enter up to 200 characters": told to assistive technology with the hint. */
  limit: string;
  /** The id the limit sentence carries (`describedBy` holds it). */
  limitId: string;
  /** "180 characters left" / "3 characters over limit": the visible count, and what is announced. */
  status: string;
}

/** A text box. */
export interface TextFieldState extends FieldState {
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  tooltip?: string;
  characterCount?: CharacterCount;
  autocomplete?: string;
  inputMode?: string;
  spellcheck?: boolean;
  /** Hints for the browser; Datum runs the checks. Never written as `maxlength`. */
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface TextareaFieldState extends TextFieldState {
  /** How many lines the box opens with. */
  rows?: number;
}

export interface NumberFieldState extends TextFieldState {
  min?: number;
  max?: number;
  step?: number;
  /**
   * Whether `text` in a text box drawn for this number already stands for the stored answer
   * (`value` itself, or text the renderer reads with the form's locale as the stored number:
   * "1,000" for 1000, "2,5" in French for 2.5, "0002" for 2). Such a box is left as typed, so the
   * caret keeps its place; any other text is replaced with `value`. The renderer's reading, the
   * one `on.input(text, { typed: "number" })` stores with.
   */
  standsFor(text: string): boolean;
}

/** One choice. `id` is unique per option, for a label's `for` and a hint's id. */
export interface ChoiceOption {
  id: string;
  value: string;
  label: string;
  hint?: string;
  hintId?: string;
  /** Checked (radio, checkbox) or selected (select). */
  checked: boolean;
}

/** A choice of one: radios. */
export interface RadioFieldState extends FieldState {
  options: readonly ChoiceOption[];
}

/** A choice of one from a list that drops down. */
export interface SelectFieldState extends FieldState {
  options: readonly ChoiceOption[];
  /** The empty first option's words. */
  emptyLabel: string;
  placeholder?: string;
}

/**
 * Any number of choices. Datum stores one boolean per option; `selected` is the chosen values,
 * and the adapter reports the list back with `on.input`.
 */
export interface CheckboxesFieldState extends FieldState {
  options: readonly ChoiceOption[];
  selected: readonly string[];
}

/** A single checkbox. */
export interface CheckboxFieldState extends FieldState {
  checked: boolean;
}

/** A date's three parts as typed, each possibly empty. */
export interface DateParts {
  year: string;
  month: string;
  day: string;
}

/**
 * A date. Datum stores a whole `YYYY-MM-DD` or nothing; `parts` is what the boxes show, which
 * for a date typed in part is what was typed, not the empty answer stored.
 */
export interface DateFieldState extends FieldState {
  parts: DateParts;
  /**
   * The parts a date typed in part still lacks, in the order the adapter drawing it puts them
   * (`LiveBinding.dateOrder` of the binding that adapter came from; focus goes to the first).
   */
  missingParts: readonly DatePartName[];
}

/** One part of a date. */
export type DatePartName = keyof DateParts;

/** One stored attachment of a file field. */
export interface FileItem {
  id: string;
  name: string;
  size?: number;
  type?: string;
  /** The bytes are in the answer itself (base64), so the name can be offered as a download (`on.download`). */
  downloadable?: boolean;
}

/** A file field. */
export interface FileFieldState extends FieldState {
  files: readonly FileItem[];
  multiple: boolean;
  accept?: string;
}

/** A button. */
export interface ButtonFieldState extends FieldState {
  action: string | undefined;
  variant?: string;
  size?: string;
}

// ── Field events ───────────────────────────────────────────────────────────────────────────

/** How `on.input` hears a value. */
export interface FieldInputOptions {
  /** Written while the person types: the runtime hears a commit only when the field is left. */
  interim?: boolean;
  /** With an empty value: a native number box holds text the browser could not read. */
  badInput?: boolean;
  /**
   * `"number"`: the value is the text as typed in a text box drawn for a number field (a design
   * system's text input asking for a number keyboard), and the renderer reads it with the form's
   * locale, as Datum's own text-drawn number does: "1,000" and "1 000" are 1000, "2,5" in French
   * is 2.5. Text that reads as a number is stored as that number, an emptied box as the empty
   * string, and anything else as typed, so validation says "number" ("abc"). Pair it with
   * {@link NumberFieldState.standsFor} when the value is written back into the box. A binding
   * never reads the text itself: the reading is the renderer's, the same under every binding.
   * A native `type="number"` box reports its own number and needs none of this.
   */
  typed?: "number";
}

/**
 * How a field reports what the person did. The renderer drops every write (`input`, `parts`,
 * `commit`, `files`, `remove`) while the form is not live or the field is read-only or disabled,
 * and draws the stored answer back.
 */
export interface FieldEvents {
  /**
   * A new value, in the type the field reports (a string; a number for a number box; the chosen
   * values for checkboxes). `interim` while typing. `badInput` with an empty value: the box
   * holds text the browser could not read as a number, so validation says "number"
   * rather than "required". `typed: "number"` with the text as typed in a text box drawn for a
   * number: the renderer reads it (see {@link FieldInputOptions.typed}).
   */
  input(value: unknown, options?: FieldInputOptions): void;
  /**
   * A date's parts as typed: the renderer composes the answer, keeps a date typed in part, and
   * tells validation what is missing. `interim` while a box is being typed in, like `input`.
   */
  parts(parts: DateParts, options?: { interim?: boolean }): void;
  /**
   * The field was left or its value settled. The runtime hears it as a commit only when the
   * field was being typed in (an interim write came before), and the leave-field check
   * (`validatePath`, per the form's `validateOn`) runs either way.
   */
  commit(): void;
  /**
   * Files picked or dropped (a file field). The adapter reads `input.files` into an array, calls
   * this, and clears the input, so picking the same file again is heard.
   */
  files?(files: readonly File[]): void;
  /** An attachment removed (a file field). */
  remove?(id: string): void;
  /** An attachment asked for (a file field); allowed read-only. */
  download?(id: string): void;
}

// ── Adapters ───────────────────────────────────────────────────────────────────────────────

/** What every adapter has. */
export interface AdapterBase<State = unknown> {
  kind: AdapterKind;
  /** A name for the inspector and the conformance report. */
  name?: string;
  /**
   * When several adapters are given for one type, the first whose `when` holds draws; one
   * without `when` is the default. A field whose answer changes adapter between draws gets
   * new nodes. A `when` that throws is reported (`datum-binding-error`, hook `when`) and counts
   * as not holding.
   */
  when?(state: State): boolean;
  capabilities?: CapabilityAnswers;
  behaviour?: AdapterBehaviour;
}

/** Draws a leaf: an input, a choice, a date, a file field, a button, static content. */
export interface FieldAdapter<State extends FieldState = FieldState> extends AdapterBase<State> {
  kind: "field";
  template(state: State, on: FieldEvents): TemplateResult;
  /**
   * After every draw of the field, before it is painted, given its wrapper: a small touch no
   * attribute reaches. Runs again once `ready` resolves, so it must be safe to repeat.
   */
  after?(field: HTMLElement, state: State): void;
  /** Resolves when the field's component has drawn itself: the renderer waits, budgeted. Left out, the binding's `ready`. */
  ready?(field: HTMLElement): Promise<void>;
  /** Once, after `ready`: what lives as long as the field (a listener outside the template, a design system's scoped init). Returns its cleanup. */
  connect?(field: HTMLElement, state: State): (() => void) | void;
  /** Where focus goes (a summary link, an error, a new row), given the wrapper. Left out, the binding's, else the renderer's. */
  focusTarget?(field: HTMLElement, state: State): HTMLElement | null | undefined;
  /** A guard for a custom control the renderer's read-only guards cannot reach (a listbox of buttons). Returns its cleanup. */
  guard?(field: HTMLElement): (() => void) | void;
  /**
   * Who writes the ids the state names (`describedBy`: the hint, the notices, the count's limit,
   * the error): the binding's markup (the default), or the design system's component itself,
   * which writes ids of its own inside its shadow root (`hint-<id>`) and is told the words by
   * property. For `binding`, the renderer checks after every draw that each id in `describedBy`
   * is carried by an element of the form, and reports one that is not (`datum-binding-error`,
   * hook `ids`, once per field and id): a description the control names and nothing carries.
   */
  idsWrittenBy?: "binding" | "component";
}

/** A container's own words; never its children's, which come drawn. */
export interface GroupState {
  /** The component id. */
  id: string;
  key: string;
  type: string;
  base: string;
  /** Absent when the author gave no name: a plain group with nothing to read out. */
  legend?: string;
  hint?: string;
  hintId?: string;
  hideLegend: boolean;
  legendMark?: "required" | "optional";
  /** 1 for a container directly in the form or page; for a heading size. */
  level: number;
  layout: LayoutSpec;
  /** A layout grid's authored column spans out of 12 tracks (`6,4,2`), one per column in slot order; absent for equal columns. */
  spans?: readonly number[];
  classNames: readonly string[];
  /**
   * The engine's model, for what no state member carries (a plugin container's own
   * configuration, a design-time face's settings), as `FieldState.model` is for a field.
   */
  model?: RenderComponentModel;
  /** Every slot, drawn and keyed by the renderer, in drawn order. */
  slots: ReadonlyArray<{ slotId: string; content: TemplateResult }>;
  /** Every child on its own, drawn and keyed, across the slots in drawn order: a list draws one item per child (a button group as a `<ul>`). */
  items: readonly GroupItem[];
  /** Draws the items keyed by the renderer: use it rather than mapping `items`. */
  eachItem(draw: (item: GroupItem) => TemplateResult): TemplateResult;
  locale: string;
  dir: "ltr" | "rtl";
  words: Words;
  /** One of the container's own configuration texts worded for the locale, as `FieldState.text` words a field's. */
  text(property: string): string | undefined;
}

/** One child of a container, drawn: a field in its wrapper, or a container in its own. */
export interface GroupItem {
  /** The node's key; stable across draws. */
  key: string;
  content: TemplateResult;
}

/** Draws a container around its children, which the renderer drew; the adapter only says where they go. */
export interface GroupAdapter extends AdapterBase<GroupState> {
  kind: "group";
  template(state: GroupState, children: TemplateResult): TemplateResult;
  /**
   * For an adapter drawing the form root as no group: the renderer then names the `<form>`
   * element itself (`aria-label`) by the root's label, one name for the whole form instead of a
   * legend said again with each field. Left out, the adapter draws the root's name (a legend).
   */
  formLabelled?: true;
}

/** One tab as the renderer resolved it. */
export interface TabState {
  slotId: string;
  label: string;
  selected: boolean;
  /** The id the tab element must carry: the renderer runs the keys by it. */
  tabId: string;
  /** The id the panel must carry. */
  panelId: string;
  /**
   * Blocking errors inside the panel. Worded by the `tabHasErrors` form text, counted
   * (`words.plural("tabHasErrors", errorCount, { count: errorCount })`: "2 errors"), for a tab
   * that says it holds errors.
   */
  errorCount: number;
  /** Shows this tab. */
  select(): void;
  /** The panel's content, drawn and keyed. Every panel is drawn; all but the selected one hidden. */
  content: TemplateResult;
}

export interface TabsState extends Omit<GroupState, "slots" | "items" | "eachItem" | "layout" | "spans" | "legendMark"> {
  tabs: readonly TabState[];
  /** Below the width the tabs fit (`LiveBinding.tabsNarrowBelow`): the renderer's narrow view, a contents list over the stacked panels. */
  narrow: boolean;
  /**
   * Every tab is drawn headed by its label, in order, with no strip: a review (`readonly` mode)
   * or a print. Every `TabState.selected` is true and `select` does nothing.
   */
  flat: boolean;
}

/** Draws a tabs container. Which tab shows, the arrow keys and opening a tab for an error are the renderer's. */
export interface TabsAdapter extends AdapterBase<TabsState> {
  kind: "tabs";
  template(state: TabsState): TemplateResult;
}

/** One column of a data grid. */
export interface GridColumn {
  id: string;
  label: string;
  required: boolean;
  /** A width hint (a CSS length or fraction) from the column's configuration. */
  width?: string;
}

/** One cell: a column's components in this row, drawn. */
export interface GridCell {
  columnId: string;
  content: TemplateResult;
  /** The cell holds a container, not fields directly: its fields keep their labels, which name them inside it. */
  group?: boolean;
}

/** One row of a data grid. */
export interface GridRow {
  /** 0-based. */
  index: number;
  /** The row's identity, for keying. */
  key: string;
  label: string;
  cells: readonly GridCell[];
  /** Present when the row can be removed now. */
  remove?: () => void;
  moveUp?: () => void;
  moveDown?: () => void;
}

export interface GridState extends Omit<GroupState, "slots" | "items" | "eachItem" | "layout" | "spans"> {
  /**
   * The layout to draw: `table` for an author's `table` or `auto`, `stacked` for `stacked` and a
   * repeating section, and `stacked` whatever the author chose for an adapter that draws no table
   * (`GridAdapter.layouts`). In `table` the cells' fields come with their labels hidden (the
   * column headings name them); in `stacked` they keep them.
   */
  layout: GridLayout;
  /**
   * The author left the layout to the form (`auto`): a table while the grid is wide, stacked
   * when it is not. `layout` is then `table`; a binding that cannot change with the width draws
   * that, one that can (Datum's, by container query) draws the setting itself. Never true for an
   * adapter that draws no table.
   */
  responsive: boolean;
  columns: readonly GridColumn[];
  showHeader: boolean;
  showRowNumbers: boolean;
  rows: readonly GridRow[];
  /** Draws the rows keyed by the renderer: use it rather than mapping `rows`. */
  eachRow(draw: (row: GridRow) => TemplateResult): TemplateResult;
  /**
   * The row buttons the grid offers at all (a live form only). A button it offers but cannot
   * press now (`add`, `remove`, `moveUp`, `moveDown` absent: a bound, a locked grid) is drawn
   * disabled; one it does not offer is not drawn.
   */
  offers: { add: boolean; remove: boolean; reorder: boolean };
  /** Present when a row can be added now. */
  add?: () => void;
  /** The id the Add button must carry: focus goes to it when the last row is removed. */
  addId: string;
  captions: { add: string; remove: string; moveUp: string; moveDown: string; empty: string; actions: string };
  /** The grid's own blocking errors, then each cell error no drawn row owns, worded. */
  errors: readonly string[];
  errorId?: string;
}

/** How a data grid lays out its rows: a table under column headings, or one block per row. */
export type GridLayout = "table" | "stacked";

/**
 * Draws a data grid or a repeating section. Rows, bounds and focus after a row button are the
 * renderer's. The adapter is chosen before the rows are drawn (its `layouts` decide whether the
 * cells' labels are hidden), so its `when` sees the grid's state with every cell's `content`
 * still empty.
 */
export interface GridAdapter extends AdapterBase<GridState> {
  kind: "grid";
  /**
   * The layouts it draws; left out, both. One that draws no table (a design system with no table
   * of inputs: rows as stacked fieldsets) is handed `layout: "stacked"` whatever the author chose,
   * with the cells' labels kept, since no column heading would name them.
   */
  layouts?: readonly GridLayout[];
  template(state: GridState): TemplateResult;
}

/** One step of a steps container. */
export interface StepState {
  id: string;
  label: string;
  status: StepStatus;
  statusText: string;
  /** "Step 2 of 3". */
  tag: string;
  shown: boolean;
  hideLabel: boolean;
  classNames: readonly string[];
  /** The id the step's heading must carry (`tabindex="-1"`): focus goes to it when the step opens. */
  headingId: string;
  /** The step's components, drawn in a wrapper that holds the DOM contract (`data-container-id` is the step's id). */
  content: TemplateResult;
  /** Present when the step can be opened from the indicator: a step already reached (or any, on the builder canvas). */
  select?: () => void;
}

export interface StepsState extends Omit<GroupState, "slots" | "items" | "eachItem" | "layout" | "spans" | "legend" | "hint" | "hintId" | "hideLegend" | "legendMark"> {
  /** Every step, drawn: all but the shown one hidden by the adapter (`hidden`). Keyed by `eachStep`. */
  steps: readonly StepState[];
  /** Draws the steps keyed by the renderer: use it rather than mapping `steps`. */
  eachStep(draw: (step: StepState) => TemplateResult): TemplateResult;
  /**
   * Every step is drawn headed, in order, and the container draws no indicator, progress line or
   * buttons: a review (`readonly` mode) or a print. `back`, `next` and every `select` are absent.
   */
  flat: boolean;
  activeStepId: string | undefined;
  progress: string;
  /** What the container holds beside its steps, drawn. */
  others: TemplateResult;
  back?: { label: string; go(): void };
  next?: { label: string; go(): void };
  busy: boolean;
}

/** Draws a steps container: the indicator, the shown step and Back/Continue. Navigation and focus are the renderer's. */
export interface StepsAdapter extends AdapterBase<StepsState> {
  kind: "steps";
  template(state: StepsState): TemplateResult;
}

/**
 * Any adapter a binding's `components` holds. A field adapter typed for a narrower state
 * (`FieldAdapter<DateFieldState>`) is one of these: its hooks are methods, read bivariantly.
 */
export type Adapter = FieldAdapter | GroupAdapter | TabsAdapter | GridAdapter | StepsAdapter;

/** One type's entry in `components`: an adapter, or several told apart by `when`. */
export type AdapterEntry = Adapter | readonly Adapter[];

// ── Form-level hooks ───────────────────────────────────────────────────────────────────────

/** A journey page as the renderer resolved it for a binding to draw. */
export interface PageState {
  journeyId: string;
  pageId: string;
  /** Empty for a page that draws no heading. */
  title: string;
  description?: string;
  progress?: string;
  /** The id the heading must carry: focus goes to it after a page change. */
  headingId: string;
  /** The level the page's heading takes: the form's own (the host's `headingLevel`, 1 unless said), the page standing for the form. */
  headingLevel: number;
  back?: () => void;
  /** Continue, or Submit on the last page; absent on an exit page. */
  next?: () => void;
  backLabel: string;
  nextLabel: string;
  final: boolean;
  /** A Continue is being worked out: draw `aria-disabled`, never `disabled`. */
  busy: boolean;
  /** The words of the checking line while a server check is out. */
  checking?: string;
  /**
   * The page drawn is where the person was put after the page they asked for was refused: say so
   * politely (a status line with the `pageRedirected` words) under the heading, until the next move.
   */
  redirected?: boolean;
  words: Words;
}

/**
 * A link of a journey's Check answers page (`kind: "review"`): a row's Change, the card's Change,
 * or the "Enter {{label}}" that takes the place of a required answer not given. Draw an `<a>` with
 * `href`, showing `text`, then `hidden` in the design system's visually hidden span (when not
 * empty); when `reordered`, `text` is `aria-hidden` and `hidden` is the whole name. On a press,
 * `preventDefault()` then `go()`: the renderer opens the step (direction `"change"`).
 */
export interface ReviewLinkState extends ReviewAction {
  /** `#` and the heading id of the step it opens. */
  href: string;
  /** On a row (or card) in error: its `errorId`, for the link's `aria-describedby` (the summary focuses the link). */
  describedBy?: string;
  go(): void;
}

/** One answer of a Check answers page. Put `id` on the row's element: the error summary links to it, and focus comes back to it. */
export interface ReviewRowState {
  id: string;
  /** The answer's value path; unique within the list. */
  key: string;
  componentId: string;
  /** The step the answer is given on. */
  pageId: string;
  /** The row's wording (the page's `review.labels`, else the field's label). */
  label: string;
  /** The answer as text, lines split by `\n`; "Not provided" for a blank optional answer; empty when `missing`. */
  value: string;
  status: ReviewRowStatus;
  /** Its blocking errors, worded; drawn in the value cell, above the value, under `errorId`. */
  errors: readonly string[];
  errorId: string;
  /** Absent when the page says no Change links, on a `missing` row, on a card's row, and in a form that is not interactive. */
  change?: ReviewLinkState;
  /** On a `missing` row of an interactive form: the link drawn in the value's place. */
  enter?: ReviewLinkState;
}

/** One row of a data grid as a card: its title, its one Change, its fields as rows. Put `id` on the card's element. */
export interface ReviewCardState {
  id: string;
  key: string;
  /** The grid. */
  componentId: string;
  index: number;
  pageId: string;
  title: string;
  rows: readonly ReviewRowState[];
  /** The grid's own blocking errors (its row count), on its first card. */
  errors: readonly string[];
  errorId: string;
  change?: ReviewLinkState;
}

export type ReviewItemState = ({ kind: "row" } & ReviewRowState) | ({ kind: "card" } & ReviewCardState);

/** One step on the path: a heading over its answers. */
export interface ReviewSectionState {
  pageId: string;
  title: string;
  headingId: string;
  items: readonly ReviewItemState[];
}

/** A journey's Check answers list (`LiveBinding.review`), between the page's heading and its own content. */
export interface ReviewState {
  journeyId: string;
  pageId: string;
  sections: readonly ReviewSectionState[];
  /** A section heading's level: one under the page's heading (`PageState.headingLevel`). A card's title is one under it. */
  headingLevel: number;
  /** The hidden word read before an error ("Error:"); empty when unworded. */
  errorPrefix: string;
  /** Datum's own drawing of the list: wrap it, or return it for what the design system has no markup for. */
  content: View;
  words: Words;
}

/** One line of the error summary: the render output's entry, with where it links and how it focuses. */
export interface SummaryEntry {
  /** `#<control id>`. */
  href: string;
  targetPath: string;
  componentId: string;
  label: string;
  message: string | undefined;
  /** The line as Datum words it (`summaryEntry`). */
  text: string;
  /**
   * `message` is words written for this error by the form or its host (a field's, a container's
   * or the form's `messages`, the page's catalog, a message the error carries, an `error.<code>`
   * text of the form's translations or the page's texts), not a default wording (the engine's
   * own sentence, in English or translated, or a binding's language pack). A design system whose
   * summary lists a specific message alone and a generic one with its field's label (GOV.UK)
   * reads it.
   */
  authored: boolean;
  focus(): void;
}

export interface SummaryState {
  heading: string;
  /** Errors with no field on this page to go to, worded as text. */
  formEntries: ReadonlyArray<{ message: string; text: string }>;
  /** The id the summary's heading carries. */
  headingId: string;
  /** The level of the summary's heading: a level under the form's own (the host's `headingLevel`, 1 by default). */
  headingLevel: number;
  /**
   * The second copy of a summary placed at both ends: a visual echo with no alert role (the top
   * copy is the alert), never the place focus goes to. Its `headingId` is its own.
   */
  echo?: boolean;
  locale: string;
  words: Words;
}

/**
 * The host's receipt after a delivered submission, resolved for a binding to draw: the texts
 * already in the form's language, the kind said once for assistive technology, and whether this
 * copy is the visual echo of a receipt placed at both ends.
 */
export interface FormNoticeState {
  kind: FormNoticeKind;
  title?: string;
  message?: string;
  details: ReadonlyArray<{ label: string; value: string }>;
  /** The second copy of a receipt placed at both ends: aria-hidden, no role, never focused. */
  echo: boolean;
  /** An error receipt on the draw that first shows it: an alert. Every other draw of it is a status. */
  assertive: boolean;
  /** The level of the title: a level under the form's own heading. */
  headingLevel: number;
  /** The kind said once for assistive technology ("Success: "); empty where the form words none. */
  kindWord: string;
  words: Words;
}

/** The line that says a submission is in flight; `echo` is the second copy of one placed at both ends. */
export interface FormStatusState {
  message: string;
  echo: boolean;
  words: Words;
}

/** The sentence above the fields that explains the required marker ("Fields marked with * are required"). */
export interface RequiredNoteState {
  note: string;
  words: Words;
}

export interface LanguageSwitcherState {
  current: string;
  locales: ReadonlyArray<{ code: string; label: string }>;
  /** The control's label, worded for the page ("Language"); the part's own when the author gave one. */
  label: string;
  /** Keep the label for assistive technology only. */
  hideLabel: boolean;
  /** An id unique within the form for the control: what a label's `for` names. */
  controlId: string;
  /**
   * Switches the form to `code` (the runtime decides, and reports `datum-locale-applied` or
   * `datum-locale-rejected`). `false` when the form refused: put a select back to `current`.
   */
  switchTo(code: string): boolean;
  words: Words;
}

/** A picture part: its URL already checked, its text alternative resolved (empty for a decorative picture). */
export interface ChromeImage {
  src: string;
  alt: string;
  href?: string;
  width?: number;
  height?: number;
}

/**
 * A chrome part (header, footer, title, the form's own buttons) as the renderer resolved it: the
 * part's type, what it says, and `content`, the renderer's own drawing of it. An adapter draws
 * the part from the members its type carries, or wraps `content`.
 */
export interface ChromeState {
  /** The part's type: `language-switcher`, `image`, `heading`, `text`, `html`, `form-title`, `form-description`, `group`. */
  part: string;
  region: "header" | "footer";
  locale: string;
  dir: "ltr" | "rtl";
  busy: FormBusy | undefined;
  words: Words;
  /**
   * The form's own heading level, its place in the page's outline (the host's `headingLevel`, 1
   * unless said): the level a part that heads itself takes (a design system's header drawing the
   * form's name), and the one a heading under the form sits below. A `heading` or `form-title`
   * part's own level is `level`.
   */
  headingLevel: number;
  /** The resolved text of a `heading`, `text`, `form-title` or `form-description`. */
  text?: string;
  /** A heading's or the form title's level. */
  level?: 1 | 2 | 3;
  /** A `form-title` over a journey page's own heading: drawn as the caption, never a second heading. */
  caption?: boolean;
  image?: ChromeImage;
  /** An `html` part's markup, through the allowlist (`sanitizeStaticHtml`). */
  html?: string;
  /** A `group`: how it spreads its parts along the row, and lines them up across it. */
  justify?: "start" | "center" | "end" | "space-between";
  verticalAlign?: "start" | "center" | "end";
  /** The part's own content, drawn by the renderer. */
  content: View;
}

export interface ChromeAdapter {
  template(state: ChromeState): TemplateResult;
}

// ── Host assets ────────────────────────────────────────────────────────────────────────────

export interface AssetSource {
  url: string;
  /** Subresource integrity, checked on every fetch. */
  integrity?: string;
}

export interface ScriptSource extends AssetSource {
  /** Run as a classic script rather than a module. */
  classic?: boolean;
  /** Attributes for its `<script>` element, for a script that reads its own (`document.currentScript`). */
  attributes?: Readonly<Record<string, string>>;
}

/** The design system's files as the host serves them; never on the binding. */
export interface LiveAssets {
  stylesheets?: readonly AssetSource[];
  fonts?: readonly AssetSource[];
  scripts?: readonly ScriptSource[];
  /** The host page's root font size in px, when the design system's sheet expects another. */
  rootFontSize?: number;
}

// ── The binding ────────────────────────────────────────────────────────────────────────────

/** One change a design system's own code makes outside the form's shadow root (`LiveBinding.designSystem.sideEffects`). */
export interface DesignSystemSideEffect {
  /** What outside the form it touches: `<html lang>`, `<body> style.overflow`, `window`. */
  target: string;
  /** What it does and when, and what the binding does about it. */
  effect: string;
}

export interface LiveBinding {
  id: string;
  label: string;
  designSystem?: {
    name: string;
    /** The root font size in px the design system's stylesheet expects. */
    rootFontSize?: number;
    /** After the first draw is ready: what the binding relies on that the design system must have drawn. Each string is a problem. */
    selfCheck?(root: ShadowRoot): string[];
    /**
     * What the design system's own code changes outside the form's shadow root (Ontario's
     * language toggle writing `<html lang>`, a dialog writing `<body>`'s overflow): reported with
     * the self-check (`LiveSelfCheck.sideEffects`, the conformance suite's run header and
     * report), never as a problem.
     */
    sideEffects?: readonly DesignSystemSideEffect[];
  };
  /** By component type: Datum's engine types, and the binding's own tier-2 types (`gcds-date`). */
  components: Readonly<Record<string, AdapterEntry>>;
  /**
   * The binding's own tier-2 types and the engine type each reads as (`{ "gcds-date": "date" }`):
   * what its package offers beside the engine's types. The renderer draws with these under the
   * definition's own `kinds` map (an entry there wins), so `data-kind`, the state and the lookup
   * chain read the base; a type used without the definition's entry is reported in `unsupported()`
   * (`<component id>: component "<type>" has no kinds entry`), since only the definition's map
   * reaches validation, the sandbox and the PDF. The builder offers these types in its palette
   * under this binding, and writes the entry of each one a form uses into the definition's
   * `kinds` on save. An entry whose base is not an engine type maps nothing.
   */
  kinds?: Readonly<Record<string, string>>;
  /**
   * The order this binding's date adapters draw a date's parts in, by locale (GC Design System:
   * month, day, year in English): what `DateFieldState.missingParts` follows for a date one of its
   * adapters draws, so focus goes to the first part lacking as drawn. Left out, Datum's order (day,
   * month, year, or its `fieldOrder.date`).
   */
  dateOrder?(locale: string): readonly DatePartName[];
  /** Rules for what the binding draws itself, adopted after the host's stylesheets. */
  css?: string;
  /**
   * The frame presets this binding adds to the built-ins (seamless, outlined, paper), by frame id:
   * what `chrome.frame` may name under it and what a frame picker offers (a built-in id relabels
   * the built-in). The binding's `css` draws each under its class (`datum-form--frame-<id>`).
   * Datum's own binding carries the frames `createDatumBinding({ frame })` was given.
   */
  frames?: Readonly<Record<string, FormFrameDefinition>>;
  /** Classes on the form element itself; a function of the scheme and locale for a dark variant. */
  formClass?: string | ((context: { colorScheme: "light" | "dark"; locale: string }) => string);
  /** The binding's language pack: form text keys by locale, under the form's translations and over the engine's English. */
  texts?: LanguagePackTable;
  /** Validation messages by code, by locale: the same layer for the errors. */
  messages?: LanguagePackTable;
  /**
   * Datum tokens to the design system's values, for what Datum draws inside this binding: set on
   * every element the renderer marks `data-fallback`, which is a field wrapper, a container's
   * wrapper (`datum-live-container`) and a region of the form (a journey page's heading and
   * buttons, the chrome, the summary, the receipt) whenever Datum's adapter or hook draws it.
   */
  fallbackTokens?: Readonly<Record<string, string>>;
  /**
   * The PDF theme this binding suggests for the form's paper: an id the host's PDF theme
   * registry holds (`pdfThemes.register`), or the theme object a design-system package exports
   * beside its binding. Read only when nothing else names a PDF theme (the render call, the
   * layout, the host's default); left out, the form prints under `datum-pdf`. A suggestion,
   * never a derivation: nothing about the binding's look is turned into paper.
   */
  pdfTheme?: string | PdfThemeDefinition;
  /**
   * The id of the binding a picker offers as this one's dark look (a design system that ships its
   * dark mode as a separate binding). Datum's own dark look is no other binding: it is drawn while
   * the host's colour scheme is dark (`colorScheme`), so the Datum binding names none.
   */
  darkVariant?: string;
  /** Where focus goes after a validation that found errors: the summary (the default) or the first field in error. */
  errorFocus?: "summary" | "field";
  /** The form width in CSS px under which tabs take the narrow view (`TabsState.narrow`: a stacked list); left out, tabs keep their strip at every width. */
  tabsNarrowBelow?: number;
  /** The default focus target for this binding's field adapters. */
  focusTarget?(field: HTMLElement, state: FieldState): HTMLElement | null | undefined;
  /** The stand-in `ready` for an adapter without one. */
  ready?(root: ShadowRoot): Promise<void>;
  /**
   * The design system's own script started scoped to the form: called once per mount, after the
   * first draw is ready, never on a redraw. `form` is the scope to hand the design system's init
   * (GOV.UK `initAll({ scope: form })`): an Element inside the
   * shadow root, where `root` itself is not one. Returns (or resolves to) its cleanup, run on
   * unmount; a throw or a rejection is reported as `datum-binding-error` with hook `connect`.
   * Start only the components whose script touches nothing but its own root.
   *
   * A sheet a design system adopts into the form's shadow root while the form is mounted (a
   * Stencil library's shared sheet) needs no cleanup here: the renderer notes the root's adopted
   * sheets before it adopts its own and, on unmount, takes away every sheet added since.
   */
  connect?(root: ShadowRoot, form: HTMLFormElement): (() => void) | void | Promise<(() => void) | void>;
  /** The error summary from the renderer's entries. Left out, Datum's. */
  summary?(entries: readonly SummaryEntry[], state: SummaryState): TemplateResult;
  /** The host's receipt after a delivered submission. Left out, Datum's. */
  notice?(state: FormNoticeState): TemplateResult;
  /** The line that says a submission is in flight. Left out, Datum's. */
  status?(state: FormStatusState): TemplateResult;
  /** The sentence explaining the required marker. Left out, Datum's. */
  requiredNote?(state: RequiredNoteState): TemplateResult;
  /** A journey page's heading and buttons. Left out, Datum's. */
  page?: { heading(state: PageState): TemplateResult; actions(state: PageState): TemplateResult };
  /**
   * A journey's Check answers list (`kind: "review"`): a section per step, a row per answer with its
   * Change link, a card per data grid row. Left out, Datum's (`state.content`), drawn in the
   * journeys chunk.
   */
  review?(state: ReviewState): TemplateResult;
  /** The language switcher. Left out, Datum's. */
  languageSwitcher?(state: LanguageSwitcherState): TemplateResult;
  /** Chrome parts by part id. Left out, Datum's. */
  chrome?: Readonly<Record<string, ChromeAdapter>>;
  /**
   * Classes an author may put in `configuration.cssClass` under this binding: what the builder's
   * Style tab offers, and the vocabulary its class check notes a class outside of. An entry is a
   * bare class name or a {@link CssClassDeclaration} that says what the class is called, which
   * components it applies to and which classes it excludes.
   */
  cssClasses?: readonly CssClassEntry[];
  /**
   * What the builder says of an error an author left unworded under this binding: `"noted"` (a
   * design system that asks for each error to be written for its question, as GOV.UK does) puts a
   * note under the messages box naming each error the component's checks raise that no message
   * words. Left out, the engine's wording stands in silently.
   */
  unwordedErrors?: "noted";
}

/**
 * A class a binding gives a meaning to, declared with what the builder's Style tab needs to
 * offer it: a name an author reads, the components it applies to, and the set it belongs to.
 */
export interface CssClassDeclaration {
  /** The class token written into `configuration.cssClass`. */
  name: string;
  /** What the Style tab calls it; the class name when absent. */
  label?: string | undefined;
  /** One line under the label saying what it does. */
  description?: string | undefined;
  /**
   * The component types it applies to, each as written (`panel`, `gcds-card`) or as the type
   * they read as (`panel`); the Style tab offers it on those components only. Absent: any component.
   */
  types?: readonly string[] | undefined;
  /**
   * Classes that share a group are mutually exclusive on one component: choosing one takes the
   * others of the group away, and the Style tab draws them as one choice with a way back to none.
   */
  group?: string | undefined;
  /**
   * What the Style tab calls the group (its heading over the choices), for a group the builder
   * does not word itself; "Choose one" when absent. The panel looks' group is worded by the builder.
   */
  groupLabel?: string | undefined;
}

/** One entry of {@link LiveBinding.cssClasses}: a bare class name, or its declaration. */
export type CssClassEntry = string | CssClassDeclaration;

/**
 * A binding with some of its parts replaced or wrapped: a host changes one adapter without
 * copying the binding. A component override is an adapter (or a list), or a function of the
 * binding's own entry that returns one (wrap or patch it).
 */
export function extendBinding(
  binding: LiveBinding,
  overrides: Omit<Partial<LiveBinding>, "components"> & {
    components?: Readonly<Record<string, AdapterEntry | ((base: AdapterEntry | undefined) => AdapterEntry)>>;
  }
): LiveBinding {
  const { components: replaced, ...rest } = overrides;
  const components: Record<string, AdapterEntry> = { ...binding.components };
  for (const [type, entry] of Object.entries(replaced ?? {})) {
    components[type] = typeof entry === "function" ? entry(binding.components[type]) : entry;
  }
  return { ...binding, ...rest, components };
}

// ── Lookup ─────────────────────────────────────────────────────────────────────────────────

/** Which step of the chain an adapter came from. */
export type AdapterSource = "binding" | "binding-base" | "datum" | "datum-base";

export interface ResolvedAdapter<A extends Adapter = Adapter> {
  adapter: A;
  from: AdapterSource;
  /** The type it is registered under: the component's type, or its base. */
  via: string;
}

/**
 * Whether an adapter's `when` holds for `state`. The renderer passes one that runs `when` as a hook,
 * so a `when` that throws is reported and counts as not holding.
 */
export type AdapterTest = (adapter: { readonly name?: string | undefined; when(state: unknown): boolean }, state: unknown) => boolean;

const holds: AdapterTest = (adapter, state) => adapter.when(state) === true;

/** The adapter of `kind` to use from one entry: the first whose `when` holds, else the first without `when`. */
function pick<A extends Adapter>(entry: AdapterEntry | undefined, kind: AdapterKind, state: unknown, test: AdapterTest): A | undefined {
  if (entry === undefined) {
    return undefined;
  }
  const list = (Array.isArray(entry) ? entry : [entry]).filter((adapter): adapter is A => adapter !== null && typeof adapter === "object" && adapter.kind === kind);
  if (state !== undefined) {
    const matched = list.find((adapter) => typeof adapter.when === "function" && test(adapter as A & { when(state: unknown): boolean }, state));
    if (matched) {
      return matched;
    }
  }
  return list.find((adapter) => adapter.when === undefined);
}

/** Own entries only: a type called `constructor` reads no prototype's. */
function entryOf(binding: LiveBinding | undefined, type: string): AdapterEntry | undefined {
  const components = binding?.components;
  return components !== undefined && Object.prototype.hasOwnProperty.call(components, type) ? components[type] : undefined;
}

/**
 * The adapter that draws a node of `kind` and `type`: binding[type] -> binding[base] ->
 * datum[type] -> datum[base], each step skipped when it holds no adapter of that kind (or none
 * whose `when` holds and no default). `datum` is the Datum binding, whose adapters stand in for
 * what a design-system binding does not draw; when the binding is Datum's, pass it for both.
 * `test` says whether an adapter's `when` holds (default: it returns `true`); the renderer's
 * reports a `when` that throws and counts it as not holding, so the next adapter draws.
 * `undefined` when no step has one.
 */
export function resolveAdapter<A extends Adapter = Adapter>(
  binding: LiveBinding,
  datum: LiveBinding | undefined,
  kind: A["kind"],
  type: string,
  base: string,
  state?: unknown,
  test: AdapterTest = holds
): ResolvedAdapter<A> | undefined {
  // The Datum binding drawing as itself is one owner, not two.
  const owners: Array<[LiveBinding, AdapterSource, AdapterSource]> = [[binding, "binding", "binding-base"]];
  if (datum !== undefined && datum !== binding) {
    owners.push([datum, "datum", "datum-base"]);
  }
  for (const [owner, byType, byBase] of owners) {
    const own = pick<A>(entryOf(owner, type), kind, state, test);
    if (own) {
      return { adapter: own, from: byType, via: type };
    }
    if (base !== type) {
      const inherited = pick<A>(entryOf(owner, base), kind, state, test);
      if (inherited) {
        return { adapter: inherited, from: byBase, via: base };
      }
    }
  }
  return undefined;
}

/**
 * The `kinds` map a form is drawn with: the binding's own tier-2 types (`LiveBinding.kinds`) under
 * the definition's map, an entry there winning. `undefined` when neither has one.
 */
export function drawingKindsOf(
  binding: Pick<LiveBinding, "kinds"> | undefined,
  definitionKinds: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> | undefined {
  const own = binding?.kinds;
  if (own === undefined || own === null || typeof own !== "object" || Object.keys(own).length === 0) {
    return definitionKinds;
  }
  const out: Record<string, string> = {};
  for (const map of [own, definitionKinds ?? {}]) {
    for (const [type, base] of Object.entries(map)) {
      // Defined, not assigned: a type named `__proto__` is an entry, not a prototype.
      Object.defineProperty(out, type, { value: base, enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

/**
 * Whether `type` reads as an engine type only through the binding's own `kinds`: the definition
 * has no entry for it, so validation, the sandbox and the PDF do not know it.
 */
export function needsKindsEntry(
  binding: Pick<LiveBinding, "kinds"> | undefined,
  definitionKinds: Readonly<Record<string, string>> | undefined,
  type: string
): boolean {
  const own = binding?.kinds;
  if (own === undefined || !Object.prototype.hasOwnProperty.call(own, type)) {
    return false;
  }
  return definitionKinds === undefined || !Object.prototype.hasOwnProperty.call(definitionKinds, type);
}

/**
 * The layout a grid adapter draws for an authored `table` or `stacked`: the authored one when the
 * adapter draws it (`GridAdapter.layouts`, both when left out), else the one it draws.
 */
export function gridLayoutFor(adapter: Pick<GridAdapter, "layouts"> | undefined, wanted: GridLayout): GridLayout {
  const layouts = adapter?.layouts;
  if (layouts === undefined || layouts.length === 0 || layouts.includes(wanted)) {
    return wanted;
  }
  return layouts[0] as GridLayout;
}

/**
 * The drawing capabilities a container's state uses, each one the registry asks of its kind
 * (`group`, `collection`): a hidden legend over a named container (`hideLabel`), a hidden step
 * heading, row numbers. A container carries neither notices nor a tooltip, so neither is asked.
 */
export function usedContainerCapabilities(
  kind: "group" | "collection",
  state: { legend?: string | undefined; hideLegend?: boolean; showRowNumbers?: boolean; steps?: ReadonlyArray<{ hideLabel: boolean }> }
): DrawingCapabilityId[] {
  const used: DrawingCapabilityId[] = [];
  const hiddenLegend = state.hideLegend === true && state.legend !== undefined && state.legend !== "";
  if ((hiddenLegend || (state.steps ?? []).some((step) => step.hideLabel)) && appliesToKind("hideLabel", kind)) {
    used.push("hideLabel");
  }
  if (state.showRowNumbers === true && appliesToKind("rowNumbers", kind)) {
    used.push("rowNumbers");
  }
  return used;
}

/**
 * The base a node of `kind` and `type` is looked up under: a leaf's answer base, a container's
 * container base (`gcds-tabs`, base `tabs`), each from the definition's `kinds` map.
 */
export function lookupBaseOf(kind: AdapterKind, type: string, kinds: Readonly<Record<string, string>> | undefined): string {
  return kind === "field" ? baseTypeOf(type, kinds) : containerBaseOf(type, kinds);
}

/**
 * The capabilities a binding answers for a field type (no state: the default adapter), with the
 * field kind its base reads as: what the builder's inspector offers under this binding. A data
 * grid (kind `collection`) is answered by the binding's grid adapter, the one that draws its row
 * numbers and its label. `kinds` is the definition's map; the binding's own stand under it.
 * `undefined` for a type nothing draws, or one that holds no answer (a group container's).
 */
export function fieldCapabilitiesOf(
  binding: LiveBinding,
  datum: LiveBinding | undefined,
  type: string,
  kinds?: Readonly<Record<string, string>>
): { kind: FieldKind; from: AdapterSource; answers: Record<DrawingCapabilityId, DrawingSupport> } | undefined {
  const entry = kindOf(type, drawingKindsOf(binding, kinds));
  if (entry?.kind === undefined) {
    return undefined;
  }
  const resolved =
    entry.kind === "collection"
      ? resolveAdapter<GridAdapter>(binding, datum, "grid", type, containerBaseOf(type, drawingKindsOf(binding, kinds)))
      : resolveAdapter<FieldAdapter>(binding, datum, "field", type, entry.base);
  if (!resolved) {
    return undefined;
  }
  return { kind: entry.kind, from: resolved.from, answers: capabilityAnswers(resolved.adapter, entry.kind) };
}

/** The drawing capabilities a field's state uses, each one the registry asks of its kind. */
export function usedCapabilities(state: FieldState & Partial<Pick<TextFieldState, "tooltip" | "prefix" | "suffix" | "characterCount" | "placeholder">>): DrawingCapabilityId[] {
  const kind = state.kind;
  if (kind === undefined) {
    return [];
  }
  const model = state.model;
  const used: DrawingCapabilityId[] = [];
  const add = (capability: DrawingCapabilityId, present: boolean): void => {
    if (present && appliesToKind(capability, kind)) {
      used.push(capability);
    }
  };
  add("notice", state.notices.length > 0);
  add("pending", state.pending);
  add("tooltip", (state.tooltip ?? model.tooltip) !== undefined && (state.tooltip ?? model.tooltip) !== "");
  add("prefix", (state.prefix ?? model.prefix) !== undefined && (state.prefix ?? model.prefix) !== "");
  add("suffix", (state.suffix ?? model.suffix) !== undefined && (state.suffix ?? model.suffix) !== "");
  add("characterCount", state.characterCount !== undefined || (model.characterCount === true && model.maxLength !== undefined));
  add("hideLabel", state.hideLabel);
  add("placeholder", (state.placeholder ?? model.placeholder) !== undefined && (state.placeholder ?? model.placeholder) !== "");
  return used;
}

// ── DOM contract ───────────────────────────────────────────────────────────────────────────

/**
 * The attributes the renderer writes on every field wrapper, and only the renderer: bindings
 * never write them, and host or binding overrides never remove them. Boolean hooks are present
 * or absent; `data-kind` holds the base type (`date`, `radio`), `data-source` the source state.
 */
export const STATE_HOOKS = [
  "data-kind",
  "data-required",
  "data-invalid",
  "data-readonly",
  "data-disabled",
  "data-over-limit",
  "data-source",
  "data-pending"
] as const;

export type StateHook = (typeof STATE_HOOKS)[number];

/** On every field wrapper: the component id, and where its answer lives (a grid row's own path). */
export const FIELD_ID_ATTRIBUTE = "data-component-id";
export const VALUE_PATH_ATTRIBUTE = "data-value-path";
/** On every container's wrapper. */
export const CONTAINER_ID_ATTRIBUTE = "data-container-id";
/** The field wrapper's instance key (internal: how the renderer finds a field again). */
export const INSTANCE_ATTRIBUTE = "data-instance";

/**
 * Marks an adapter draws and the renderer's behaviour finds by (all inside a field's wrapper).
 * An adapter that draws one gets the behaviour; one that does not gets none, and nothing breaks.
 *
 * - File fields: the renderer sets `data-file-drag` on the wrapper while a file is dragged over
 *   it (the binding's CSS draws the state). A polite live region marked `data-file-status`
 *   (`data-file-announce` too, where picks are to be read out) is filled with what a pick or a
 *   removal did; one marked `data-file-drop-status` hears a drag entering and leaving. A press
 *   that starts inside an element marked `data-file-button` sets `data-file-press` on the
 *   wrapper until it ends.
 * - Tooltips: `data-tooltip` is the container of a mark (`data-tooltip-mark`, the focusable
 *   control) and its bubble. The renderer sets `data-dismissed` on the container while Escape or
 *   the mark's key has closed it, until pointer and focus have left; the binding's CSS shows the
 *   bubble on hover or focus unless it is dismissed.
 */
export const FILE_DRAG_ATTRIBUTE = "data-file-drag";
export const FILE_PRESS_ATTRIBUTE = "data-file-press";
export const FILE_STATUS_ATTRIBUTE = "data-file-status";
export const FILE_ANNOUNCE_ATTRIBUTE = "data-file-announce";
export const FILE_DROP_STATUS_ATTRIBUTE = "data-file-drop-status";
export const FILE_BUTTON_ATTRIBUTE = "data-file-button";
export const TOOLTIP_ATTRIBUTE = "data-tooltip";
export const TOOLTIP_MARK_ATTRIBUTE = "data-tooltip-mark";
export const TOOLTIP_DISMISSED_ATTRIBUTE = "data-dismissed";

/**
 * Buttons: a control an adapter draws for a `button` component carries `data-button-action` (the
 * configured action, on the element a press lands on) and, for a signed submit,
 * `data-button-signature`. The renderer's buttons module hears the press and reports it as
 * `datum-form-action` {componentId, action, signature?}; an adapter draws no handler of its own.
 */
export const BUTTON_ACTION_ATTRIBUTE = "data-button-action";
export const BUTTON_SIGNATURE_ATTRIBUTE = "data-button-signature";

/**
 * The id a drawn tooltip's bubble carries. The renderer adds it to `describedBy` (after the
 * description) for an adapter that answers tooltip `drawn`, so the help is a real description of
 * the control; the adapter puts it on the bubble.
 */
export function tooltipIdOf(fieldId: string): string {
  return `${fieldId}__tooltip`;
}

/** The event a binding problem is reported by, on the shadow root's host. */
export const BINDING_ERROR_EVENT = "datum-binding-error";

/** `datum-binding-error`'s detail. */
export interface BindingErrorDetail {
  /** The hook or stage that failed: `assets`, `render`, `when` (an adapter's `when` threw: it counted as not holding), `template`, `after`, `ready`, `connect`, `focus`, `self-check`, `ids` (a described-by id a binding-written field names and nothing carries), ... */
  hook: string;
  /** The field's instance key or the component id, when the problem is one field's. */
  id?: string;
  message: string;
  url?: string;
  problems?: readonly string[];
}
