/**
 * Datum's adapters for the choice fields: radios, a group of checkboxes, a lone checkbox and a
 * select. Drawn as lit templates over the field's
 * state, with `datum-form__*` classes and the ids and ARIA wiring the stylesheet and the renderer
 * rely on. The renderer owns the answer: a radio or
 * a select reports the value picked, a group of checkboxes reports the list of values chosen
 * (the fields module turns it into Datum's object of one boolean per option), a lone checkbox a
 * boolean; each is final (never interim), and is followed by `on.commit()` since a pick is the
 * field being settled.
 */
import { html, ifDefined, live } from "../lit.js";
import type { Adapter, ChoiceOption, CheckboxesFieldState, CheckboxFieldState, FieldAdapter, FieldState, RadioFieldState, SelectFieldState, View } from "../contract.js";
import {
  ariaStates,
  assembleParts,
  controlClassNames,
  describedByAttr,
  descriptionView,
  errorBeforeControl,
  errorView,
  fieldClassNames,
  labelView,
  legendView,
  resolveFieldOptions,
  tooltipTextOf,
  type DatumFieldOptions,
  type DatumFieldOptionsInput
} from "./field-scaffold.js";
import { drawPart } from "./parts.js";

/**
 * Only a disabled field disables its choices. Radios, checkboxes and a select have no
 * `readonly` attribute: a read-only one stays focusable and drawn as it is live, and the renderer
 * refuses the change and marks it `aria-readonly` (guards.ts).
 */
function locked(state: FieldState): boolean {
  return state.disabled;
}

/** The first control to take focus: the picked one, else the first. */
function firstControl(field: HTMLElement): HTMLElement | null {
  return field.querySelector<HTMLElement>("input:checked") ?? field.querySelector<HTMLElement>("input, select");
}

// ── Option rows ────────────────────────────────────────────────────────────────────────────

/**
 * An option's accessible wiring. Without a hint the option is named by its row's label. With one,
 * the label and the hint stack in a column beside the box, the input names itself by the label
 * alone (the wrapping `<label>` would fold the hint into its name) and the hint describes it;
 * under `optionHint: "named"` the hint is part of the name instead. `errorId` is the group's error
 * line while the group is invalid (`choiceState: "each"`): it describes the option too.
 */
function optionWiring(option: ChoiceOption, errorId: string | undefined, named: boolean): { labelledby: string | undefined; describedby: string | undefined } {
  if (option.hint === undefined || option.hintId === undefined) {
    return { labelledby: undefined, describedby: errorId };
  }
  const labelId = `${option.id}__label`;
  if (named) {
    return { labelledby: `${labelId} ${option.hintId}`, describedby: errorId };
  }
  return { labelledby: labelId, describedby: errorId ? `${option.hintId} ${errorId}` : option.hintId };
}

/** An option row's text: the label alone, or the label and its hint in a column. */
function optionText(option: ChoiceOption): View {
  if (option.hint === undefined || option.hintId === undefined) {
    return html`<span>${option.label}</span>`;
  }
  return html`<span class="datum-form__option-text"
    ><span id=${`${option.id}__label`}>${option.label}</span><span id=${option.hintId} class="datum-form__option-hint">${option.hint}</span></span
  >`;
}

interface GroupParts {
  options: readonly ChoiceOption[];
  inputs: (option: ChoiceOption, wiring: ReturnType<typeof optionWiring>, optionState: { invalid: string | undefined; required: string | undefined }) => View;
}

/** The group's options as rows, each a label around its input and text. */
function optionRows(state: FieldState, kind: "radio" | "checkbox", options: DatumFieldOptions, parts: GroupParts): View[] {
  const each = options.controls.choiceState === "each";
  const aria = ariaStates(state, options);
  const optionState = each ? aria : { invalid: undefined, required: undefined };
  const optionErrorId = each && state.errors.length > 0 && state.invalid ? state.errorId : undefined;
  const disabled = locked(state);
  return parts.options.map((option) => {
    const wiring = optionWiring(option, optionErrorId, options.controls.optionHint === "named");
    const input = parts.inputs(option, wiring, optionState);
    const text = optionText(option);
    const drawn = html`<label class=${`datum-form__${kind}-option${disabled ? ` datum-form__${kind}-option--disabled` : ""}`} for=${option.id}>${input}${text}</label>`;
    return drawPart(options.parts, "optionRow", { state, kind, option, input, text, disabled, default: drawn });
  });
}

/** The help text as a `title` for a group that is described by nothing (`groupDescription: "none"`), where the bubble's id would name no description. */
function groupTitle(state: FieldState, options: DatumFieldOptions): string | undefined {
  return options.controls.groupDescription === "none" ? tooltipTextOf(state) : undefined;
}

function groupDescribedBy(state: FieldState, options: DatumFieldOptions): string | undefined {
  return options.controls.groupDescription === "none" ? undefined : describedByAttr(state.describedBy);
}

// ── Radio ──────────────────────────────────────────────────────────────────────────────────

export function createRadioAdapter(options: DatumFieldOptions = resolveFieldOptions(undefined)): FieldAdapter<RadioFieldState> {
  return {
    kind: "field",
    name: "datum-radio",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "drawn", hideLabel: "drawn" },
    template: (state, on) => {
      const aria = ariaStates(state, options);
      const marked = options.controls.ariaStates === "marked";
      const disabled = locked(state);
      const rows = optionRows(state, "radio", options, {
        options: state.options,
        inputs: (option, wiring, optionState) => html`<input
          type="radio"
          id=${option.id}
          class=${controlClassNames("radio")}
          name=${state.name}
          value=${option.value}
          .checked=${live(option.checked)}
          ?disabled=${disabled}
          aria-invalid=${ifDefined(optionState.invalid)}
          aria-required=${ifDefined(optionState.required)}
          aria-labelledby=${ifDefined(wiring.labelledby)}
          aria-describedby=${ifDefined(wiring.describedby)}
          @change=${(event: Event) => {
            if ((event.target as HTMLInputElement).checked) {
              on.input(option.value);
              on.commit();
            }
          }}
        />`
      });
      const order = options.controls.groupError === "afterLegend" ? errorBeforeControl(options.fieldOrder) : options.fieldOrder;
      // A radio group is a `fieldset`/`legend` pair: a label names one control, a group names a set.
      return html`<fieldset
        id=${state.id}
        class=${fieldClassNames(state, "radio", "datum-form__field datum-form__radio-group")}
        role=${ifDefined(marked ? "radiogroup" : undefined)}
        aria-labelledby=${state.labelId}
        aria-invalid=${ifDefined(aria.invalid)}
        aria-describedby=${ifDefined(groupDescribedBy(state, options))}
        aria-required=${ifDefined(marked ? aria.required : undefined)}
        title=${ifDefined(groupTitle(state, options))}
      >
        ${assembleParts({ label: legendView(state, options), description: descriptionView(state), control: html`${rows}`, error: errorView(state, options) }, order, state)}
      </fieldset>`;
    },
    focusTarget: (field) => firstControl(field)
  };
}

// ── Checkboxes ─────────────────────────────────────────────────────────────────────────────

export function createCheckboxesAdapter(options: DatumFieldOptions = resolveFieldOptions(undefined)): FieldAdapter<CheckboxesFieldState> {
  return {
    kind: "field",
    name: "datum-checkboxes",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "drawn", hideLabel: "drawn" },
    template: (state, on) => {
      const aria = ariaStates(state, options);
      const disabled = locked(state);
      const rows = optionRows(state, "checkbox", options, {
        options: state.options,
        inputs: (option, wiring, optionState) => html`<input
          type="checkbox"
          id=${option.id}
          class=${controlClassNames("checkbox")}
          value=${option.value}
          .checked=${live(option.checked)}
          ?disabled=${disabled}
          aria-invalid=${ifDefined(optionState.invalid)}
          aria-required=${ifDefined(optionState.required)}
          aria-labelledby=${ifDefined(wiring.labelledby)}
          aria-describedby=${ifDefined(wiring.describedby)}
          @change=${(event: Event) => {
            // The values chosen, read from the boxes as they stand: one change may follow another before a draw.
            const group = (event.target as HTMLInputElement).closest("fieldset");
            const boxes = Array.from(group?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []);
            on.input(state.options.filter((_, index) => boxes[index]?.checked === true).map((entry) => entry.value));
            on.commit();
          }}
        />`
      });
      const order = options.controls.groupError === "afterLegend" ? errorBeforeControl(options.fieldOrder) : options.fieldOrder;
      // No aria-required on the group: a `group` has no required state, so the legend's marker is
      // announced instead (and each box carries the state under `choiceState: "each"`).
      return html`<fieldset
        id=${state.id}
        class=${fieldClassNames(state, "checkboxes", "datum-form__field datum-form__checkbox-group")}
        aria-labelledby=${state.labelId}
        aria-invalid=${ifDefined(aria.invalid)}
        aria-describedby=${ifDefined(groupDescribedBy(state, options))}
        title=${ifDefined(groupTitle(state, options))}
      >
        ${assembleParts({ label: legendView(state, options), description: descriptionView(state), control: html`${rows}`, error: errorView(state, options) }, order, state)}
      </fieldset>`;
    },
    focusTarget: (field) => firstControl(field)
  };
}

// ── Single checkbox ────────────────────────────────────────────────────────────────────────

export function createCheckboxAdapter(options: DatumFieldOptions = resolveFieldOptions(undefined)): FieldAdapter<CheckboxFieldState> {
  return {
    kind: "field",
    name: "datum-checkbox",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "drawn", hideLabel: "drawn" },
    template: (state, on) => {
      const aria = ariaStates(state, options);
      // A lone checkbox is an option on its own: under `optionHint: "named"` its description is part
      // of its name, after the words, and only the rest (an error) describes it.
      const named = options.controls.optionHint === "named" && state.hintId !== undefined;
      const describedBy = named ? state.describedBy.filter((id) => id !== state.hintId) : state.describedBy;
      const labelledBy = named && state.hintId !== undefined ? `${state.labelId} ${state.hintId}` : state.labelId;
      return html`<label class=${fieldClassNames(state, "checkbox")} for=${state.id}
        >${assembleParts(
          {
            label: labelView(state, options),
            description: descriptionView(state),
            control: html`<input
              id=${state.id}
              class=${controlClassNames("checkbox")}
              type="checkbox"
              .checked=${live(state.checked)}
              ?disabled=${locked(state)}
              aria-labelledby=${labelledBy}
              aria-invalid=${ifDefined(aria.invalid)}
              aria-describedby=${ifDefined(describedByAttr(describedBy))}
              aria-required=${ifDefined(aria.required)}
              @change=${(event: Event) => {
                on.input((event.target as HTMLInputElement).checked);
                on.commit();
              }}
            />`,
            error: errorView(state, options)
          },
          options.fieldOrder,
          state
        )}</label
      >`;
    }
  };
}

// ── Select ─────────────────────────────────────────────────────────────────────────────────

export function createSelectAdapter(options: DatumFieldOptions = resolveFieldOptions(undefined)): FieldAdapter<SelectFieldState> {
  return {
    kind: "field",
    name: "datum-select",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template: (state, on) => {
      const aria = ariaStates(state, options);
      // An optional select keeps its empty option listed and choosable, so the answer can be
      // cleared; a required one lists it (disabled) only when the design system says so.
      const listed = !state.required || options.controls.selectPlaceholder === "listed";
      // The caption shows whenever no option is the answer: an empty one, or a value none of the
      // options carries (a prefill, an old draft), so choosing the first option is still a change.
      const unmatched = !state.options.some((option) => option.checked);
      // A select's placeholder is its empty option's caption rather than an attribute.
      const select = html`<select
        id=${state.id}
        class=${controlClassNames("select")}
        ?disabled=${locked(state)}
        aria-labelledby=${state.labelId}
        aria-invalid=${ifDefined(aria.invalid)}
        aria-describedby=${ifDefined(describedByAttr(state.describedBy))}
        aria-required=${ifDefined(aria.required)}
        @change=${(event: Event) => {
          on.input((event.target as HTMLSelectElement).value);
          on.commit();
        }}
      >
        <option value="" ?disabled=${state.required} ?hidden=${!listed} .selected=${live(unmatched)}>${state.emptyLabel}</option>
        ${state.options.map((option) => html`<option value=${option.value} .selected=${live(option.checked)}>${option.label}</option>`)}
      </select>`;
      // A drawn chevron needs an element to sit on: a select takes no pseudo-element, so the face
      // around it carries the glyph.
      const control = options.controls.selectChevron === "drawn" ? html`<span class="datum-form__select-face">${select}</span>` : select;
      return html`<label class=${fieldClassNames(state, "select")} for=${state.id}
        >${assembleParts(
          { label: labelView(state, options), description: descriptionView(state), control, error: errorView(state, options) },
          options.fieldOrder,
          state
        )}</label
      >`;
    }
  };
}

// ── The group ──────────────────────────────────────────────────────────────────────────────

/** The Datum adapters of the choice group, by the engine type they draw. */
export function datumChoiceComponents(input?: DatumFieldOptionsInput): Record<string, Adapter> {
  const options = resolveFieldOptions(input);
  return {
    radio: createRadioAdapter(options),
    checkboxes: createCheckboxesAdapter(options),
    checkbox: createCheckboxAdapter(options),
    select: createSelectAdapter(options)
  };
}
