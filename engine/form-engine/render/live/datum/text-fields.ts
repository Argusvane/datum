/**
 * Datum's adapters for the text-like fields: a single-line text box (the type `email`, `tel`
 * and `url` are text with an input mode and an autocomplete token, `password` a text box a
 * plugin type reads as its base), a textarea with its count, and a number box. Drawn as lit templates over the field's
 * state, with `datum-form__*` classes and the ids and ARIA wiring the stylesheet and the renderer
 * rely on. The answer is the renderer's: an adapter reports what was
 * typed (`on.input`, interim while typing) and that the field was left (`on.commit`), and draws
 * what the state says.
 */
import { html, ifDefined, live } from "../lit.js";
import {
  type Adapter,
  type FieldAdapter,
  type FieldInputOptions,
  type FieldState,
  type NumberFieldState,
  type TextareaFieldState,
  type TextFieldState
} from "../contract.js";
import {
  affixedControl,
  ariaStates,
  assembleParts,
  controlClassNames,
  countView,
  describedByAttr,
  descriptionView,
  errorView,
  fieldClassNames,
  labelView,
  leaveListeners,
  resolveFieldOptions,
  type DatumFieldOptions,
  type DatumFieldOptionsInput
} from "./field-scaffold.js";

/**
 * Read-only is `readonly`, never `disabled`: a field a rule or the configuration
 * marks read-only, and every field of the read-only mode (a review), stays focusable, its value
 * can be selected and copied, and a screen reader reads it as read-only rather than unavailable.
 * Only a disabled field (or the disabled mode) is disabled.
 */
function lockedState(state: FieldState): { disabled: boolean; readonly: boolean } {
  return { disabled: state.disabled, readonly: state.readOnly };
}

/** The attribute for a hint that may be absent; `spellcheck` takes the words true and false. */
function spellcheckAttr(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

/** The keyboard a number drawn as a text box asks for: digits alone for a whole-number step, a decimal keyboard otherwise. */
function numberInputMode(state: NumberFieldState): "numeric" | "decimal" {
  const step = state.step;
  return typeof step === "number" && Number.isInteger(step) && step > 0 ? "numeric" : "decimal";
}

// ── Text ───────────────────────────────────────────────────────────────────────────────────

export function createTextAdapter(options: DatumFieldOptions = resolveFieldOptions(undefined)): FieldAdapter<TextFieldState> {
  return {
    kind: "field",
    name: "datum-text",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "drawn", prefix: "drawn", suffix: "drawn", characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template: (state, on) => {
      const { disabled, readonly } = lockedState(state);
      const aria = ariaStates(state, options);
      const leave = leaveListeners(on);
      const control = html`<input
        id=${state.id}
        class=${controlClassNames("text")}
        type="text"
        .value=${live(state.value)}
        placeholder=${ifDefined(state.placeholder)}
        pattern=${ifDefined(state.pattern)}
        minlength=${ifDefined(state.minLength)}
        autocomplete=${ifDefined(state.autocomplete)}
        inputmode=${ifDefined(state.inputMode)}
        spellcheck=${ifDefined(spellcheckAttr(state.spellcheck))}
        aria-labelledby=${state.labelId}
        ?disabled=${disabled}
        ?readonly=${readonly}
        aria-invalid=${ifDefined(aria.invalid)}
        aria-describedby=${ifDefined(describedByAttr(state.describedBy))}
        aria-required=${ifDefined(aria.required)}
        @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, { interim: true })}
        @change=${leave.change}
        @blur=${leave.blur}
        @focus=${leave.focus}
      />`;
      return html`<label class=${fieldClassNames(state, "text")} for=${state.id}
        >${assembleParts(
          {
            label: labelView(state, options),
            description: descriptionView(state),
            control: html`${affixedControl(state.prefix, state.suffix, control)}${countView(state, state.characterCount)}`,
            error: errorView(state, options)
          },
          options.fieldOrder,
          state
        )}</label
      >`;
    }
  };
}

// ── Textarea ───────────────────────────────────────────────────────────────────────────────

export function createTextareaAdapter(options: DatumFieldOptions = resolveFieldOptions(undefined)): FieldAdapter<TextareaFieldState> {
  return {
    kind: "field",
    name: "datum-textarea",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "drawn", characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template: (state, on) => {
      const { disabled, readonly } = lockedState(state);
      const aria = ariaStates(state, options);
      const leave = leaveListeners(on);
      // A read-only textarea opens at the value's line count: it shows an answer rather than inviting
      // one. Growing it to what wrapped is the renderer's readonly-sizing module, for every binding.
      const rows = state.readOnly ? Math.max(1, state.value.split("\n").length) : (state.rows ?? options.controls.textareaRows);
      return html`<label class=${fieldClassNames(state, "textarea")} for=${state.id}
        >${assembleParts(
          {
            label: labelView(state, options),
            description: descriptionView(state),
            control: html`<textarea
                id=${state.id}
                class=${controlClassNames("textarea")}
                rows=${rows}
                .value=${live(state.value)}
                placeholder=${ifDefined(state.placeholder)}
                minlength=${ifDefined(state.minLength)}
                autocomplete=${ifDefined(state.autocomplete)}
                inputmode=${ifDefined(state.inputMode)}
                spellcheck=${ifDefined(spellcheckAttr(state.spellcheck))}
                aria-labelledby=${state.labelId}
                ?disabled=${disabled}
                ?readonly=${readonly}
                aria-invalid=${ifDefined(aria.invalid)}
                aria-describedby=${ifDefined(describedByAttr(state.describedBy))}
                aria-required=${ifDefined(aria.required)}
                @input=${(event: Event) => on.input((event.target as HTMLTextAreaElement).value, { interim: true })}
                @change=${leave.change}
                @blur=${leave.blur}
                @focus=${leave.focus}
              ></textarea
              >${countView(state, state.characterCount)}`,
            error: errorView(state, options)
          },
          options.fieldOrder,
          state
        )}</label
      >`;
    }
  };
}

// ── Number ─────────────────────────────────────────────────────────────────────────────────

/**
 * The value a number box reports. A number box already parses for us: a float is reported as a
 * number, and empty (cleared, or holding text the browser cannot read: `badInput`) as the empty
 * string, never `Number("")`, which is 0. A text box drawn for a number reports its
 * text as typed with `typed: "number"`, and the renderer reads it with the form's locale
 * ("1,000", "2,5" in French), as it does for every binding's text-drawn number.
 */
function numberReport(input: HTMLInputElement): { value: number | string; options: FieldInputOptions } {
  if (input.type === "number") {
    if (input.validity?.badInput === true) {
      return { value: "", options: { interim: true, badInput: true } };
    }
    return { value: input.value === "" ? "" : Number(input.value), options: { interim: true } };
  }
  return { value: input.value, options: { interim: true, typed: "number" } };
}

/** Whether the box's text already stands for the stored number (typed "0002", "1,000"): it is then left as typed, so the caret keeps its place. */
function standsFor(input: HTMLInputElement, state: NumberFieldState): boolean {
  if (input.type !== "number") {
    return state.standsFor(input.value);
  }
  return state.value !== "" && input.value.trim() !== "" && Number(input.value) === Number(state.value);
}

export function createNumberAdapter(options: DatumFieldOptions = resolveFieldOptions(undefined)): FieldAdapter<NumberFieldState> {
  const asText = options.controls.number === "text";
  return {
    kind: "field",
    name: asText ? "datum-number-text" : "datum-number",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "drawn", prefix: "drawn", suffix: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template: (state, on) => {
      const { disabled, readonly } = lockedState(state);
      const aria = ariaStates(state, options);
      const leave = leaveListeners(on);
      const report = (event: Event): void => {
        const { value, options: reported } = numberReport(event.target as HTMLInputElement);
        on.input(value, reported);
      };
      // The value is written in `after`: the box keeps what was typed while it stands for the stored number.
      const control = html`<input
        id=${state.id}
        class=${controlClassNames("number")}
        type=${asText ? "text" : "number"}
        placeholder=${ifDefined(state.placeholder)}
        min=${ifDefined(asText ? undefined : state.min)}
        max=${ifDefined(asText ? undefined : state.max)}
        step=${ifDefined(asText ? undefined : state.step)}
        autocomplete=${ifDefined(state.autocomplete)}
        inputmode=${ifDefined(state.inputMode ?? (asText ? numberInputMode(state) : undefined))}
        spellcheck=${ifDefined(spellcheckAttr(state.spellcheck ?? (asText ? false : undefined)))}
        aria-labelledby=${state.labelId}
        ?disabled=${disabled}
        ?readonly=${readonly}
        aria-invalid=${ifDefined(aria.invalid)}
        aria-describedby=${ifDefined(describedByAttr(state.describedBy))}
        aria-required=${ifDefined(aria.required)}
        @input=${report}
        @change=${leave.change}
        @blur=${leave.blur}
        @focus=${leave.focus}
      />`;
      return html`<label class=${fieldClassNames(state, "number")} for=${state.id}
        >${assembleParts(
          {
            label: labelView(state, options),
            description: descriptionView(state),
            control: affixedControl(state.prefix, state.suffix, control),
            error: errorView(state, options)
          },
          options.fieldOrder,
          state
        )}</label
      >`;
    },
    // A number box cannot take `live()`: Chrome redraws a box from its number when the value is
    // written, which drops the "." or "-" typed on the way to "12.5" or "-5". The value is set
    // only when the box does not already stand for the stored number.
    after: (field, state) => {
      const box = field.querySelector<HTMLInputElement>("input");
      if (box && box.value !== state.value && !standsFor(box, state)) {
        box.value = state.value;
      }
    }
  };
}

// ── The group ──────────────────────────────────────────────────────────────────────────────

/** The Datum adapters of the text-like group, by the engine type they draw. */
export function datumTextComponents(input?: DatumFieldOptionsInput): Record<string, Adapter> {
  const options = resolveFieldOptions(input);
  return {
    text: createTextAdapter(options),
    textarea: createTextareaAdapter(options),
    number: createNumberAdapter(options)
  };
}
