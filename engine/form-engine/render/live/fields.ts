/**
 * Per-kind field state for the live renderer: what an adapter of a text box, a textarea, a number
 * box, a choice or a lone checkbox is handed beyond the common `FieldState` that mount.ts builds
 * (contract.ts `TextFieldState`, `RadioFieldState`, ...). One builder per engine base type, so a
 * design-system type read as its base (`gcds-input` as `text`) is handed the same state; every
 * builder reads the engine's render model and the form's words, and never the DOM.
 *
 * It is a {@link LiveFeature}: it adds to the state (`fieldState`) and turns what an adapter
 * reports into what the engine stores (`fieldEvents`: a list of chosen values becomes Datum's
 * object of one boolean per option; text typed in a box drawn for a number, reported with
 * `typed: "number"`, is read with the form's locale). A base type with no builder here keeps the common
 * state, so other groups (dates, files, buttons) add their builders through `createFieldsFeature`.
 */
import { kernelAnswerBounds } from "../../core/schema/answer-kinds.js";
import { countCharacters } from "../../core/schema/length-limits.js";
import { isValidPattern } from "../../core/schema/pattern-validity.js";
import type { PresentationField } from "../core/presentation-tree.js";
import type {
  CharacterCount,
  CheckboxesFieldState,
  CheckboxFieldState,
  ChoiceOption,
  FieldEvents,
  FieldState,
  NumberFieldState,
  RadioFieldState,
  SelectFieldState,
  TextareaFieldState,
  TextFieldState
} from "./contract.js";
import type { DrawContext, LiveFeature } from "./mount.js";
import { readTypedNumber } from "../web-component/typed-answers.js";

/** Builds the per-kind state of one field from its common state. */
export type FieldStateBuilder = (state: FieldState, node: PresentationField, draw: DrawContext) => FieldState;

function configurationOf(node: PresentationField): Record<string, unknown> {
  const configuration = node.model.node.configuration;
  return configuration !== null && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>) : {};
}

/** A configuration number: finite, or a numeric string; anything else is no bound. */
function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * The count a counted field shows, worded as the engine words it: the limit sentence
 * (told to assistive technology with the hint), and the count as it stands. An empty field shows
 * the whole limit left, or the `countEmpty` wording where the form has one.
 */
export function characterCountOf(state: FieldState): CharacterCount | undefined {
  const { model, words } = state;
  if (model.characterCount !== true || model.maxLength === undefined) {
    return undefined;
  }
  const max = model.maxLength;
  const count = countCharacters(state.value);
  const left = max - count;
  const params = { max, count, n: Math.abs(left) };
  const leftWords = words.plural("countLeft", Math.abs(left), params);
  return {
    max,
    count,
    left,
    over: left < 0,
    limit: words("countUpTo", params),
    limitId: model.accessibility.countId ?? `${state.id}__count`,
    status: count === 0 ? words("countEmpty", params) || leftWords : left < 0 ? words.plural("countOver", Math.abs(left), params) : leftWords
  };
}

/** What a single-line box and a number box share: ghost text, affixes, help and the browser's hints. */
function boxState(state: FieldState): Partial<TextFieldState> {
  const { model } = state;
  return {
    ...(model.placeholder ? { placeholder: model.placeholder } : {}),
    ...(model.prefix ? { prefix: model.prefix } : {}),
    ...(model.suffix ? { suffix: model.suffix } : {}),
    ...(model.tooltip ? { tooltip: model.tooltip } : {}),
    ...(model.autocomplete ? { autocomplete: model.autocomplete } : {}),
    ...(model.inputMode ? { inputMode: model.inputMode } : {}),
    ...(model.spellcheck !== undefined ? { spellcheck: model.spellcheck } : {})
  };
}

/** The limits and the pattern, hints for the browser that Datum's checks own (a pattern the browser could not compile is left out). */
function textHints(state: FieldState): Partial<TextFieldState> {
  const { model } = state;
  return {
    ...(model.minLength !== undefined ? { minLength: model.minLength } : {}),
    ...(model.maxLength !== undefined ? { maxLength: model.maxLength } : {}),
    ...(model.pattern !== undefined && isValidPattern(model.pattern) ? { pattern: model.pattern } : {})
  };
}

function textState(state: FieldState): TextFieldState {
  const count = characterCountOf(state);
  return { ...state, ...boxState(state), ...textHints(state), ...(count ? { characterCount: count } : {}) };
}

function textareaState(state: FieldState, node: PresentationField): TextareaFieldState {
  const rows = configurationOf(node).rows;
  const count = characterCountOf(state);
  const { prefix: _prefix, suffix: _suffix, ...box } = boxState(state);
  return {
    ...state,
    ...box,
    ...textHints(state),
    ...(count ? { characterCount: count } : {}),
    ...(typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? { rows: Math.floor(rows) } : {})
  };
}

/**
 * What text typed in a box drawn for a number stores (`on.input(text, { typed: "number" })`): the
 * number it reads as with the form's locale (typed answers), the empty string for an
 * emptied box, else the text as typed, so validation names what is wrong.
 */
export function typedNumberAnswer(text: string, locale: string): number | string {
  if (text.trim() === "") {
    return "";
  }
  return readTypedNumber(text, locale) ?? text;
}

/** Whether `text` in a text box drawn for a number stands for the stored answer `stored` (`NumberFieldState.standsFor`). */
export function typedNumberStandsFor(text: string, stored: string, locale: string): boolean {
  if (text === stored) {
    return true;
  }
  if (stored.trim() === "" || text.trim() === "") {
    return false;
  }
  const typed = readTypedNumber(text, locale);
  return typed !== undefined && typed === Number(stored);
}

function numberState(state: FieldState, node: PresentationField): NumberFieldState {
  const configuration = configurationOf(node);
  // The bounds validation enforces, read as it reads them: an unreadable or inverted pair is no bound.
  const bounds = kernelAnswerBounds("number", configuration);
  const min = typeof bounds.min === "number" ? bounds.min : undefined;
  const max = typeof bounds.max === "number" ? bounds.max : undefined;
  const step = numberOf(configuration.step);
  const { value, locale } = state;
  return {
    ...state,
    ...boxState(state),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined && step > 0 ? { step } : {}),
    standsFor: (text: string) => typedNumberStandsFor(text, value, locale)
  };
}

/** The options a choice offers, from the inline list or the data source, with ids unique per option. */
function optionsOf(state: FieldState, node: PresentationField, checked: (value: string) => boolean): ChoiceOption[] {
  return node.model.optionState.items.map((item, index) => {
    const id = `${state.id}__${index}`;
    const hint = item.description?.trim();
    return {
      id,
      value: item.value,
      label: item.label,
      ...(hint ? { hint, hintId: `${id}__hint` } : {}),
      checked: checked(item.value)
    };
  });
}

function radioState(state: FieldState, node: PresentationField): RadioFieldState {
  return { ...state, options: optionsOf(state, node, (value) => value === state.value) };
}

function selectState(state: FieldState, node: PresentationField): SelectFieldState {
  const { model } = state;
  return {
    ...state,
    options: optionsOf(state, node, (value) => value === state.value),
    emptyLabel: model.placeholder ?? state.words("selectEmpty"),
    ...(model.placeholder ? { placeholder: model.placeholder } : {})
  };
}

/** The options a checkboxes answer picks: Datum's object of one boolean per option, or a list of chosen values. */
function pickedOf(answer: unknown): Record<string, unknown> {
  if (Array.isArray(answer)) {
    return Object.fromEntries(answer.map((value) => [String(value), true]));
  }
  return answer !== null && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
}

function checkboxesState(state: FieldState, node: PresentationField): CheckboxesFieldState {
  const picked = pickedOf(state.answer);
  const options = optionsOf(state, node, (value) => picked[value] === true);
  return { ...state, options, selected: options.filter((option) => option.checked).map((option) => option.value) };
}

function checkboxState(state: FieldState): CheckboxFieldState {
  // Only `true` is ticked: a stored "false", "no" or 1 is not the box's answer.
  return { ...state, checked: state.answer === true };
}

/** The builders for the engine types of the text-like and choice groups, by base type. */
export const FIELD_STATE_BUILDERS: Readonly<Record<string, FieldStateBuilder>> = Object.freeze({
  text: textState,
  textarea: textareaState,
  number: numberState,
  radio: radioState,
  select: selectState,
  checkboxes: checkboxesState,
  checkbox: checkboxState
});

/**
 * The renderer's field-state module. `builders` add to (or replace) the standard ones by base
 * type, for the groups another module owns.
 */
export function createFieldsFeature(builders: Readonly<Record<string, FieldStateBuilder>> = {}): LiveFeature {
  const all: Record<string, FieldStateBuilder> = { ...FIELD_STATE_BUILDERS, ...builders };
  return {
    id: "fields",

    fieldState(state, node, draw) {
      const build = Object.prototype.hasOwnProperty.call(all, node.base) ? all[node.base] : undefined;
      return build ? build(state, node, draw) : undefined;
    },

    fieldEvents(on, state, node): FieldEvents | void {
      if (node.base === "number") {
        // Text typed in a box drawn for a number: the renderer reads it, the same under every binding.
        return {
          ...on,
          input: (value, options) => {
            on.input(options?.typed === "number" && typeof value === "string" ? typedNumberAnswer(value, state.locale) : value, options);
          }
        };
      }
      if (node.base !== "checkboxes") {
        return undefined;
      }
      // A choice adapter reports the values chosen; Datum stores one boolean per option.
      const items = node.model.optionState.items;
      return {
        ...on,
        input: (value, options) => {
          if (!Array.isArray(value)) {
            on.input(value, options);
            return;
          }
          const chosen = new Set(value.map(String));
          on.input(Object.fromEntries(items.map((item) => [item.value, chosen.has(item.value)])), options);
        }
      };
    }
  };
}
