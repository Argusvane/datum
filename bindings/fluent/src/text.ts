/**
 * The Fluent UI text, number and textarea fields on the engine's binding contract.
 *
 * Tier 1, one adapter each: Fluent's `fluent-field` (label above, as Fluent's field documentation
 * writes a text input: field.stories.ts, `ComponentExamples`) with a `<label slot="label">`, the
 * control in its `input` slot, and the one message element (`messagesOf`) in its `message` slot.
 * The field draws the required asterisk from the control's `required`.
 *
 * - text: `fluent-text-input`. A prefix and a suffix are its own `start` and `end` slots (Fluent's
 *   `StartAndEndSlot` story writes `<span slot="start">$</span>`), so the same adapter draws them.
 * - number: `fluent-text-input` too, as a text box asking for a number keyboard (`inputmode`), the
 *   box Datum's own `controls.number: "text"` draws. The binding reads nothing: it hands the renderer
 *   the text as typed (`on.input(text, { typed: "number" })`), and the renderer reads it with the
 *   form's locale as Datum's own text-drawn number does ("1,000", or "2,5" and "1 000" in French, are
 *   numbers; "abc" is stored as typed and validation says it is no number). The box keeps what was
 *   typed while the renderer says it stands for the stored number (`state.standsFor`), so the caret
 *   keeps its place. Fluent's own `type="number"` is not used. Measured on 3.2.1: it reaches the
 *   inner box, but the component writes the box's value back on every `input` (its `value` setter),
 *   and a number box's value is "" while it holds text on the way to a number, so typing "-5" leaves
 *   "5", "1.5" leaves "51" and "1e3" leaves "3", and `validity.badInput` never shows. Fluent documents
 *   no number type (TextInputType: email, password, tel, text, url).
 * - textarea: `fluent-textarea` in the field's `input` slot (its own `label` slot left empty, so it
 *   hides its label). Fluent's textarea documentation labels it through its own slot with
 *   `fluent-label` and shows no hint or message; the field is Fluent's one documented place for a
 *   hint and a validation message, and the field's documentation offers it for any control. One field
 *   shape for every box keeps one message element, one asterisk and one labelling path.
 *
 * Capabilities: hint drawn; tooltip, pending and workedOut degraded (the renderer folds them into the
 * hint); notice drawn (its own piece of the message); characterCount drawn (the binding places the
 * words, the renderer counts and announces); placeholder drawn (Fluent's `placeholder`); prefix and
 * suffix drawn (text and number); hideLabel drawn (the label visually hidden).
 */
import type { FieldAdapter, NumberFieldState, TextareaFieldState, TextFieldState } from "../../../engine/form-engine/render/live/contract.js";
import { boxOf, describe, leaving, messagesOf, readyOf, setAttr, valueOf, VISUALLY_HIDDEN, type Lit } from "./shared.js";

type TextAdapter = FieldAdapter<TextFieldState>;
type NumberAdapter = FieldAdapter<NumberFieldState>;
type TextareaAdapter = FieldAdapter<TextareaFieldState>;

const CAPABILITIES = {
  notice: "drawn",
  pending: "degraded",
  tooltip: "degraded",
  workedOut: "degraded",
  characterCount: "drawn",
  placeholder: "drawn",
  prefix: "drawn",
  suffix: "drawn",
  hideLabel: "drawn"
} as const;

/** fluent-textarea has no start or end slot. */
const TEXTAREA_CAPABILITIES = { notice: "drawn", pending: "degraded", tooltip: "degraded", workedOut: "degraded", characterCount: "drawn", placeholder: "drawn", hideLabel: "drawn" } as const;

/** The keyboard a number asks for: digits alone for a whole-number step, a decimal keyboard otherwise. */
const numberKeyboard = (s: NumberFieldState): string => s.inputMode ?? (typeof s.step === "number" && Number.isInteger(s.step) && s.step > 0 ? "numeric" : "decimal");

type Host = HTMLElement & { value?: string };

export function createText(lit: Lit): { text: TextAdapter; number: NumberAdapter; textarea: TextareaAdapter } {
  const { html, nothing, ifDefined, live } = lit;

  const label = (s: TextFieldState) =>
    html`<label slot="label" id=${s.labelId} for=${s.id} class=${s.hideLabel ? VISUALLY_HIDDEN : nothing}>${s.label}</label>`;

  const affix = (slot: "start" | "end", text: string | undefined) => (text === undefined || text === "" ? nothing : html`<span slot=${slot}>${text}</span>`);

  const hostOf = (field: HTMLElement): Host | null => field.querySelector<Host>("fluent-text-input, fluent-textarea");

  /** A summary link lands on the component's host, which delegates focus to its box. */
  const focusTarget = (field: HTMLElement): HTMLElement | null => hostOf(field);

  /** What no attribute of the component reaches: `inputmode`, and Datum's label and description on the box. */
  const touch = (field: HTMLElement, s: TextFieldState, inputMode: string | undefined): void => {
    const box = boxOf(hostOf(field));
    setAttr(box, "inputmode", inputMode);
    describe(box, field, s);
  };

  const textInput = (s: TextFieldState, on: Parameters<TextAdapter["template"]>[1], kind: "text" | "number") => {
    const leave = leaving(on);
    return html`<fluent-field label-position="above">
      ${label(s)}
      <fluent-text-input
        slot="input"
        id=${s.id}
        name=${s.name}
        type="text"
        .value=${kind === "text" ? live(s.value) : nothing /* a number's value is written in after(); lit sets nothing once, as undefined */}
        placeholder=${ifDefined(s.placeholder)}
        autocomplete=${ifDefined(s.autocomplete)}
        minlength=${ifDefined(kind === "text" ? s.minLength : undefined)}
        pattern=${ifDefined(kind === "text" ? s.pattern : undefined)}
        spellcheck=${ifDefined(s.spellcheck === undefined ? (kind === "number" ? "false" : undefined) : String(s.spellcheck))}
        ?required=${s.required}
        ?disabled=${s.disabled}
        ?readonly=${s.readOnly}
        @input=${kind === "text"
          ? (event: Event) => on.input(valueOf(event), { interim: true })
          : (event: Event) => on.input(valueOf(event), { interim: true, typed: "number" })}
        @change=${leave.change}
        @blur=${leave.blur}
        @focus=${leave.focus}
        >${affix("start", s.prefix)}${affix("end", s.suffix)}</fluent-text-input
      >
      ${messagesOf(lit, s)}
    </fluent-field>`;
  };

  const text: TextAdapter = {
    kind: "field",
    name: "fluent-text-input",
    capabilities: CAPABILITIES,
    template: (s, on) => textInput(s, on, "text"),
    after: (field, s) => touch(field, s, s.inputMode),
    ready: readyOf(),
    focusTarget
  };

  const number: NumberAdapter = {
    kind: "field",
    name: "fluent-text-input-number",
    capabilities: CAPABILITIES,
    template: (s, on) => textInput(s, on, "number"),
    // The value is written here, not with `live()`: the box keeps what was typed while the renderer says it stands for the stored number.
    after(field, s) {
      const host = hostOf(field);
      if (host && !s.standsFor(String(host.value ?? ""))) {
        host.value = s.value;
      }
      touch(field, s, numberKeyboard(s));
    },
    ready: readyOf(),
    focusTarget
  };

  const textarea: TextareaAdapter = {
    kind: "field",
    name: "fluent-textarea",
    capabilities: TEXTAREA_CAPABILITIES,
    template: (s, on) => {
      const leave = leaving(on);
      return html`<fluent-field label-position="above">
        ${label(s)}
        <fluent-textarea
          slot="input"
          id=${s.id}
          name=${s.name}
          .value=${live(s.value)}
          placeholder=${ifDefined(s.placeholder)}
          autocomplete=${ifDefined(s.autocomplete)}
          minlength=${ifDefined(s.minLength)}
          ?spellcheck=${s.spellcheck === true}
          ?required=${s.required}
          ?disabled=${s.disabled}
          ?readonly=${s.readOnly}
          @input=${(event: Event) => on.input(valueOf(event), { interim: true })}
          @change=${leave.change}
          @blur=${leave.blur}
          @focus=${leave.focus}
        ></fluent-textarea>
        ${messagesOf(lit, s)}
      </fluent-field>`;
    },
    after: (field, s) => {
      const box = boxOf(hostOf(field));
      setAttr(box, "inputmode", s.inputMode);
      // The author's opening height. Fluent's textarea has no rows: its box is as tall as its `--min-block-size` (52px) whatever the inner box's `rows`,
      // so the rows reach the inner box and set that height (script-set, so a strict style-src holds): padding, border and `rows` lines of the box's own line height.
      const host = hostOf(field);
      setAttr(box, "rows", s.rows === undefined ? undefined : String(s.rows));
      if (host) {
        if (s.rows === undefined) {
          host.style.removeProperty("--min-block-size");
        } else {
          host.style.setProperty("--min-block-size", `calc(${s.rows} * var(--line-height) + 2 * var(--padding-block) + 2 * var(--border-width))`);
        }
      }
      // fluent-textarea binds `?spellcheck` (present or absent), and an absent one leaves the browser's default:
      // "false" is written on the box for the browser to stop checking.
      if (s.spellcheck === false) {
        setAttr(box, "spellcheck", "false");
      } else if (box?.getAttribute("spellcheck") === "false") {
        box.removeAttribute("spellcheck");
      }
      describe(box, field, s);
    },
    ready: readyOf(),
    focusTarget
  };

  return { text, number, textarea };
}
