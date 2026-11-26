/**
 * What Datum's field adapters share: the field's shell and its four parts (label, description,
 * control, error), the classes the Datum stylesheet is written against, the ARIA states, and the
 * order the parts stand in. These are the drawing choices a design system's markup differs in,
 * the options `controls` and `fieldOrder` of the Datum binding (`options.ts`); a form drawn with
 * none reads as Datum's own.
 *
 * The markup: the elements, the `datum-form__*` classes, the ids and `aria-*` wiring. What the renderer owns is not drawn
 * here: the field's wrapper (`data-component-id`, `data-value-path`, the state hooks, the
 * author's classes), the write guard, the errors' wording and the count announcer.
 */
import { html, ifDefined, nothing, type TemplateResult } from "../lit.js";
import { noticesView } from "../notices.js";
import { tooltipIdOf, type CharacterCount, type FieldEvents, type FieldState, type TextFieldState, type View } from "../contract.js";
import { drawPart, normalizeParts, type DatumParts } from "./parts.js";

// ── Options ────────────────────────────────────────────────────────────────────────────────

/** The four parts of a field, in the order a binding could set. */
export type FieldPart = "label" | "description" | "control" | "error";

/** The engine's own order: the one a form with no `fieldOrder` is drawn in. */
export const DEFAULT_FIELD_ORDER: readonly FieldPart[] = Object.freeze<FieldPart[]>(["label", "description", "control", "error"]);

/**
 * The native-control choices a design system's markup differs in (design systems tell a
 * service not to use `<input type="number">`, put a choice group's state on each option, or
 * leave a group undescribed). Names and meanings are those of `DatumControls`.
 */
export interface DatumFieldControls {
  /** Which box a `number` component draws: a text box with a number keyboard (Datum's own, the `datum` binding's), or the browser's number box. */
  number: "number" | "text";
  /** How many rows a textarea opens with. */
  textareaRows: number;
  /** Whether a select's empty option stays in its list (`listed`) or is only its caption (`hidden`). */
  selectPlaceholder: "hidden" | "listed";
  /** `drawn` puts the select in a face that carries a chevron. */
  selectChevron: "native" | "drawn";
  /** A choice group's state on the group (`group`), or on each option as well (`each`). */
  choiceState: "group" | "each";
  /** Which of the required and invalid states the controls and groups carry as ARIA states. */
  ariaStates: "marked" | "required" | "none";
  /** An option's hint describes it (`described`) or is part of its name (`named`). */
  optionHint: "described" | "named";
  /** Whether a choice group is described by its hint and error. */
  groupDescription: "described" | "none";
  /** A choice group's error after its options (`last`, in the field order) or between its legend and its options. */
  groupError: "last" | "afterLegend";
  /** An inline error is an alert, or plain text (the summary is then the page's one alert). */
  inlineErrors: "alert" | "plain";
}

export const DEFAULT_FIELD_CONTROLS: Readonly<DatumFieldControls> = Object.freeze({
  number: "text",
  textareaRows: 4,
  selectPlaceholder: "hidden",
  selectChevron: "native",
  choiceState: "group",
  ariaStates: "marked",
  optionHint: "described",
  groupDescription: "described",
  groupError: "last",
  inlineErrors: "alert"
});

/** What a host hands the Datum binding for its field adapters; anything left out keeps the default. */
export interface DatumFieldOptionsInput {
  controls?: Partial<DatumFieldControls>;
  fieldOrder?: readonly string[];
  /** The host's part templates (`parts.ts`): the marks, the help mark, the inline error, the option rows. */
  parts?: DatumParts;
}

/** The options as the adapters read them: every choice resolved. */
export interface DatumFieldOptions {
  controls: Readonly<DatumFieldControls>;
  fieldOrder: readonly FieldPart[];
  parts?: Readonly<DatumParts> | undefined;
}

/**
 * A declared order of named parts validated against `defaults` (every part, in the default
 * order): unknown names and repeats are dropped, and an order that does not name every part once
 * is `defaults` itself. The field's parts and a date's boxes are ordered this way.
 */
export function normalizePartOrder<P extends string>(order: readonly string[] | undefined, defaults: readonly P[]): readonly P[] {
  if (!order) {
    return defaults;
  }
  const out: P[] = [];
  for (const part of order) {
    if ((defaults as readonly string[]).includes(part) && !out.includes(part as P)) {
      out.push(part as P);
    }
  }
  return out.length === defaults.length ? out : defaults;
}

/** An order naming every part exactly once; anything else is the engine's whole order (a field with no control is a bug, not a layout). */
function normalizeOrder(order: readonly string[] | undefined): readonly FieldPart[] {
  return normalizePartOrder(order, DEFAULT_FIELD_ORDER);
}

/** The controls validated against the choices Datum knows, defaults filled in. */
function normalizeControls(controls: Partial<DatumFieldControls> | undefined): Readonly<DatumFieldControls> {
  if (!controls || typeof controls !== "object") {
    return DEFAULT_FIELD_CONTROLS;
  }
  const rows = controls.textareaRows;
  return {
    number: controls.number === "number" ? "number" : "text",
    textareaRows: typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : DEFAULT_FIELD_CONTROLS.textareaRows,
    selectPlaceholder: controls.selectPlaceholder === "listed" ? "listed" : "hidden",
    selectChevron: controls.selectChevron === "drawn" ? "drawn" : "native",
    choiceState: controls.choiceState === "each" ? "each" : "group",
    ariaStates: controls.ariaStates === "none" || controls.ariaStates === "required" ? controls.ariaStates : "marked",
    optionHint: controls.optionHint === "named" ? "named" : "described",
    groupDescription: controls.groupDescription === "none" ? "none" : "described",
    groupError: controls.groupError === "afterLegend" ? "afterLegend" : "last",
    inlineErrors: controls.inlineErrors === "plain" ? "plain" : "alert"
  };
}

export function resolveFieldOptions(input: DatumFieldOptionsInput | undefined): DatumFieldOptions {
  const parts = normalizeParts(input?.parts);
  return { controls: normalizeControls(input?.controls), fieldOrder: normalizeOrder(input?.fieldOrder), ...(parts ? { parts } : {}) };
}

/** `order` with the error moved to stand just before the control: a choice group's order under `groupError: "afterLegend"`. */
export function errorBeforeControl(order: readonly FieldPart[]): readonly FieldPart[] {
  const rest: FieldPart[] = order.filter((part) => part !== "error");
  rest.splice(rest.indexOf("control"), 0, "error");
  return rest;
}

// ── Classes ────────────────────────────────────────────────────────────────────────────────

/** The control kinds drawn as a boxed text-like control: one border, one radius, one fill. */
const BOX_CONTROL_KINDS: ReadonlySet<string> = new Set(["text", "number", "date", "textarea", "select"]);

/** The class list of a value-bearing control: the shared `datum-form__control`, its kind, and the box for the text-like kinds. */
export function controlClassNames(kind: string): string {
  return `datum-form__control datum-form__control--${kind}${BOX_CONTROL_KINDS.has(kind) ? " datum-form__control--box" : ""}`;
}

/**
 * The class list of a field's shell: the base, what the field holds (`--text`, `--select`, ...),
 * and its state as modifiers, so a stylesheet reaches the whole field (label, hint, error and
 * control) from one selector. The author's own classes are on the renderer's wrapper.
 */
export function fieldClassNames(state: FieldState, kind: string, base = "datum-form__field"): string {
  return [
    base,
    `datum-form__field--${kind}`,
    state.required ? "datum-form__field--required" : "",
    state.invalid ? "datum-form__field--invalid" : "",
    state.disabled ? "datum-form__field--disabled" : "",
    state.readOnly ? "datum-form__field--readonly" : "",
    state.overLimit ? "datum-form__field--over-limit" : ""
  ]
    .filter((name) => name !== "")
    .join(" ");
}

// ── ARIA ───────────────────────────────────────────────────────────────────────────────────

/** The required and invalid states as ARIA states, per `controls.ariaStates`; an attribute left out is `undefined`. */
export function ariaStates(state: FieldState, options: DatumFieldOptions): { invalid: string | undefined; required: string | undefined } {
  const mode = options.controls.ariaStates;
  return {
    invalid: mode === "marked" ? String(state.invalid) : undefined,
    required: mode !== "none" ? String(state.required) : undefined
  };
}

/** The ids that describe the control, joined; nothing when there are none. */
export function describedByAttr(ids: readonly string[]): string | undefined {
  return ids.length > 0 ? ids.join(" ") : undefined;
}

// ── Parts ──────────────────────────────────────────────────────────────────────────────────

/** The field's help text: the tooltip the state carries, else the model's. */
export function tooltipTextOf(state: FieldState): string | undefined {
  const text = (state as Partial<TextFieldState>).tooltip ?? state.model.tooltip;
  return text !== undefined && text !== "" ? text : undefined;
}

/**
 * The "?" beside a label with its bubble: a focusable button named by the `tooltipHelp` text,
 * describing the control through the bubble's id (the renderer adds the id to `describedBy`).
 * `data-tooltip` and `data-tooltip-mark` are the marks the renderer's tooltip module runs the
 * dismissal by (contract.ts `TOOLTIP_ATTRIBUTE`, `TOOLTIP_MARK_ATTRIBUTE`).
 */
export function tooltipMark(state: FieldState, text: string, parts?: Readonly<DatumParts>): View {
  const id = tooltipIdOf(state.id);
  const label = state.words("tooltipHelp");
  const drawn = html` <span class="datum-form__tooltip" data-tooltip
    ><span class="datum-form__tooltip-mark" data-tooltip-mark tabindex="0" role="button" aria-label=${label} aria-describedby=${id}>?</span
    ><span id=${id} class="datum-form__tooltip-text" aria-hidden="true">${text}</span></span
  >`;
  return drawPart(parts, "tooltipMark", { state, tooltip: text, id, label, default: drawn });
}

/**
 * The marker after a label: the required one (`*` unless the form words it otherwise), or the
 * optional one when worded ("(optional)"). On a control's label it is hidden from assistive
 * technology (the required state is announced through ARIA); on a group's legend it is `announced`,
 * since a group carries no required state. Nothing when the wording is empty.
 */
export function marksView(state: FieldState, announced: boolean, parts?: Readonly<DatumParts>): View {
  const required = state.required;
  const marker = state.words(required ? "required" : "optional");
  const drawn =
    marker === ""
      ? nothing
      : html` <span class=${required ? "datum-form__required" : "datum-form__optional"} aria-hidden=${ifDefined(announced ? undefined : "true")}>${marker}</span>`;
  return drawPart(parts, "labelMarks", { state, required, announced, marker, default: drawn });
}

/**
 * A label's (or legend's) content with the id `aria-labelledby` names. The help mark is a
 * focusable button named "Help", so with a mark the id moves to an inner span holding the words
 * and the marker, and the mark follows outside the named span; without a mark the id stays on the
 * label element itself.
 */
function namedContent(state: FieldState, announced: boolean, parts: Readonly<DatumParts> | undefined): { outerId: string | undefined; content: TemplateResult } {
  const words = html`${state.label}${marksView(state, announced, parts)}`;
  const tip = tooltipTextOf(state);
  if (tip === undefined) {
    return { outerId: state.labelId, content: words };
  }
  return { outerId: undefined, content: html`<span id=${state.labelId}>${words}</span>${tooltipMark(state, tip, parts)}` };
}

function labelClass(state: FieldState): string {
  return state.hideLabel ? "datum-form__label datum-form__visually-hidden" : "datum-form__label";
}

/** The label of a single control: a span (the shell is the `<label for>`), its marker hidden from assistive technology under `marked`. */
export function labelView(state: FieldState, options: DatumFieldOptions): TemplateResult {
  const { outerId, content } = namedContent(state, options.controls.ariaStates !== "marked", options.parts);
  return html`<span id=${ifDefined(outerId)} class=${labelClass(state)}>${content}</span>`;
}

/** The legend of a choice group; its marker is always announced. */
export function legendView(state: FieldState, options?: Pick<DatumFieldOptions, "parts">): TemplateResult {
  const { outerId, content } = namedContent(state, true, options?.parts);
  return html`<legend id=${ifDefined(outerId)} class=${labelClass(state)}>${content}</legend>`;
}

/** The field's hint, with the id the control's description names. */
export function descriptionView(state: FieldState): View {
  const hint = state.hint !== undefined && state.hintId !== undefined ? html`<span id=${state.hintId} class="datum-form__description">${state.hint}</span>` : nothing;
  // A journey page's worked-out line, its own element under the id the control is described by.
  const workedOut =
    state.workedOut !== undefined && state.workedOutId !== undefined
      ? html`<span id=${state.workedOutId} class="datum-form__description datum-form__worked-out" data-worked-out>${state.workedOut}</span>`
      : nothing;
  return hint === nothing && workedOut === nothing ? nothing : html`${hint}${workedOut}`;
}

/** The inline error: an alert region unless the form's inline errors are `plain`, led by the hidden `errorPrefix` word where one is worded. */
export function errorView(state: FieldState, options: DatumFieldOptions): View {
  if (state.errors.length === 0 || state.errorId === undefined) {
    return nothing;
  }
  const prefix = state.words("errorPrefix");
  const role = options.controls.inlineErrors === "plain" ? undefined : "alert";
  const message = state.errors.join("; ");
  const drawn = html`<span id=${state.errorId} role=${ifDefined(role)} class="datum-form__error"
    >${prefix === "" ? nothing : html`<span class="datum-form__visually-hidden">${prefix} </span>`}${message}</span
  >`;
  return drawPart(options.parts, "errorMessage", { state, id: state.errorId, message, prefix, role, default: drawn });
}

/**
 * The character count under a text control: the limit sentence, visually hidden and
 * described to the control beside its description; the count as it stands, visible and hidden
 * from assistive technology (it changes on every keystroke). The one polite region that speaks
 * it once typing pauses is the renderer's.
 */
export function countView(state: FieldState, count: CharacterCount | undefined): View {
  if (!count) {
    return nothing;
  }
  return html`<span class=${count.over ? "datum-form__count datum-form__count--over" : "datum-form__count"} data-count-for=${state.id}
    ><span id=${count.limitId} class="datum-form__visually-hidden">${count.limit}</span
    ><span class="datum-form__count-status" aria-hidden="true">${count.status}</span></span
  >`;
}

/**
 * A single-line box between its prefix and suffix, each affix decorative
 * (`aria-hidden`); the control alone when the field has neither.
 */
export function affixedControl(prefix: string | undefined, suffix: string | undefined, control: TemplateResult): TemplateResult {
  if (!prefix && !suffix) {
    return control;
  }
  const affix = (kind: "prefix" | "suffix", text: string | undefined): View =>
    text ? html`<span class=${`datum-form__affix datum-form__affix--${kind}`} aria-hidden="true">${text}</span>` : nothing;
  return html`<span class="datum-form__control-group">${affix("prefix", prefix)}${control}${affix("suffix", suffix)}</span>`;
}

/** The field's four parts in `order`, then its notices (never errors, never in the summary). */
export function assembleParts(parts: Readonly<Record<FieldPart, View>>, order: readonly FieldPart[], state: FieldState): TemplateResult {
  return html`${order.map((part) => parts[part])}${noticesView(state)}`;
}

// ── Events ─────────────────────────────────────────────────────────────────────────────────

/**
 * The controls whose `change` just committed and whose `blur` is still to come. Module scope, keyed
 * by element: a redraw between the two events (a browser runs microtasks between them) swaps in new
 * listeners, and a set made per draw would forget the change and check the field a second time.
 */
const settled = new WeakSet<EventTarget>();

/**
 * The listeners that report a field as left. A control's `change` (its value settled) commits;
 * the `blur` that follows commits only when no `change` just did, so a field left unedited still
 * runs the leave-field check (the form's `validateOn`) and one left after an edit runs it once.
 */
export function leaveListeners(on: FieldEvents): { change: (event: Event) => void; blur: (event: Event) => void; focus: (event: Event) => void } {
  return {
    change: (event) => {
      if (event.target) {
        settled.add(event.target);
      }
      on.commit();
    },
    blur: (event) => {
      if (event.target && settled.delete(event.target)) {
        return;
      }
      on.commit();
    },
    focus: (event) => {
      if (event.target) {
        settled.delete(event.target);
      }
    }
  };
}
