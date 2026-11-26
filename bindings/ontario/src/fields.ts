/**
 * The Ontario Design System text, textarea, number, select, radios and checkboxes on the engine's
 * binding contract, each drawn with the design system's own component (`ontario-input`,
 * `ontario-textarea`, `ontario-dropdown-list`, `ontario-radio-buttons`, `ontario-checkboxes`).
 *
 * What the components give and do not give (the cause of most choices below):
 * - They draw the label, the "(required)" / "(optional)" flag, the hint and the error line themselves,
 *   told by property. The renderer owns the answer, validation, focus and the summary.
 * - No `disabled` or `readonly` (the design system's policy): set on the boxes inside after each draw.
 * - No prefix, suffix, placeholder (bar the select's empty first option) or character count, no
 *   `rows`/`maxlength`: the count is drawn beside the box and read out by the renderer.
 * - An option has no visible line of help, only an expander ("more information"); an option's hint is
 *   its expander's content. A field's tooltip is the same: the component's own field-level expander
 *   (`hint-expander`), worded by the form's help word, its content the tooltip.
 * - A text input's `type` is text, tel, email or password: a number is a text box with a numeric keyboard.
 *
 * Capabilities answered as data (drawn | degraded | none): notice and characterCount are drawn beside
 * the component; tooltip is drawn as the component's hint expander (help on demand, Ontario's way of
 * giving it), its words once more out of sight for the box to be described by; pending and workedOut
 * are degraded (the component words its own hint, so the renderer folds them into it); prefix, suffix,
 * placeholder and hideLabel are none.
 */
import { tooltipIdOf, type CheckboxesFieldState, type FieldAdapter, type FieldEvents, type FieldState, type NumberFieldState, type RadioFieldState, type SelectFieldState, type TextFieldState, type TextareaFieldState } from "../../../engine/form-engine/render/live/contract.js";
import { readTypedNumber } from "../../../engine/form-engine/render/live/index.js";
import { applyModes, boxesIn, captionOf, countOf, describedHint, hintJson, keepDescription, languageOf, messageOf, noticesOf, readyOf, reflectDescription, type Lit } from "./shared.js";

const TEXT_CAPABILITIES = {
  notice: "drawn",
  pending: "degraded",
  tooltip: "drawn",
  workedOut: "degraded",
  characterCount: "drawn"
} as const;

const GROUP_CAPABILITIES = { notice: "drawn", pending: "degraded", tooltip: "drawn", workedOut: "degraded" } as const;

/** The field's tooltip: the state's for a text box, the model's for the others. */
const tooltipOf = (s: FieldState): string | undefined => {
  const tooltip = (s as Partial<TextFieldState>).tooltip ?? s.model.tooltip;
  return tooltip === undefined || tooltip === "" ? undefined : tooltip;
};

/** `hint-expander` as the JSON string Ontario parses: the help word opens it, the tooltip is its content. */
const expanderOf = (s: FieldState): string | undefined => {
  const tooltip = tooltipOf(s);
  return tooltip === undefined ? undefined : JSON.stringify({ hint: s.words("tooltipHelp"), content: tooltip, hintContentType: "string" });
};

/** The fieldset inside a group component (radios, checkboxes), where its description lives. */
const groupBox = (field: HTMLElement, tag: string): HTMLElement | null => field.querySelector(tag)?.shadowRoot?.querySelector<HTMLElement>("fieldset") ?? null;

export function createFields(lit: Lit): {
  text: FieldAdapter<TextFieldState>;
  textarea: FieldAdapter<TextareaFieldState>;
  number: FieldAdapter<NumberFieldState>;
  select: FieldAdapter<SelectFieldState>;
  radio: FieldAdapter<RadioFieldState>;
  checkboxes: FieldAdapter<CheckboxesFieldState>;
} {
  const { html, ifDefined, live, nothing } = lit;

  /**
   * The tooltip's words out of sight, under the id the renderer names for a drawn tooltip
   * (`tooltipIdOf`): the expander's content is hidden until it is opened and lives in the
   * component's shadow root, so this copy is what the box is described by (`data-describes`), after the hint.
   */
  const tooltipCopy = (s: FieldState) => {
    const tooltip = tooltipOf(s);
    return tooltip === undefined ? nothing : html`<span hidden id=${tooltipIdOf(s.id)} data-describes data-tooltip-copy>${tooltip}</span>`;
  };

  const valueOf = (event: Event): string => String((event.currentTarget as HTMLElement & { value?: unknown }).value ?? "");

  /** Attributes Ontario has no prop for, set on the box inside after every draw. */
  const boxAttributes = (field: HTMLElement, tag: string, s: Partial<TextFieldState>): void => {
    for (const box of boxesIn(field, tag)) {
      if (box instanceof HTMLSelectElement) {
        continue;
      }
      const set = (name: string, value: string | undefined): void => (value === undefined ? box.removeAttribute(name) : box.setAttribute(name, value));
      set("spellcheck", s.spellcheck === undefined ? undefined : String(s.spellcheck));
      set("inputmode", s.inputMode);
      set("autocomplete", s.autocomplete);
    }
  };

  /** The component's own hint and error stay the component's; what Datum drew beside it joins the box's description. */
  const describe = (field: HTMLElement, tag: string, control: () => HTMLElement | null | undefined) => ({
    after: () => reflectDescription(field, field.querySelector(tag), control()),
    connect: () => keepDescription(field, () => field.querySelector(tag), control)
  });

  // ── Text ────────────────────────────────────────────────────────────────────────────────
  const text: FieldAdapter<TextFieldState> = {
    kind: "field",
    name: "ontario-input",
    capabilities: TEXT_CAPABILITIES,
    idsWrittenBy: "component",
    template: (s, on) => html`${describedHint(lit, s)}${tooltipCopy(s)}<ontario-input
        element-id=${s.id}
        name=${s.name}
        caption=${captionOf(s.label)}
        hint-text=${ifDefined(hintJson(s.hint))}
        hint-expander=${ifDefined(expanderOf(s))}
        .value=${live(s.value)}
        ?required=${s.required && !s.disabled}
        error-message=${ifDefined(messageOf(s.errors))}
        language=${languageOf(s.locale)}
        @input=${(event: Event) => on.input(valueOf(event), { interim: true })}
        @change=${() => on.commit()}
      ></ontario-input>${noticesOf(lit, s)}${countOf(lit, s)}`,
    after(field, s) {
      boxAttributes(field, "ontario-input", s);
      applyModes(field, "ontario-input", s);
      describe(field, "ontario-input", () => boxesIn(field, "ontario-input")[0]).after();
    },
    connect: (field) => describe(field, "ontario-input", () => boxesIn(field, "ontario-input")[0]).connect(),
    ready: readyOf("ontario-input"),
    focusTarget: (field) => boxesIn(field, "ontario-input")[0]
  };

  // ── Textarea ────────────────────────────────────────────────────────────────────────────
  const textarea: FieldAdapter<TextareaFieldState> = {
    kind: "field",
    name: "ontario-textarea",
    capabilities: TEXT_CAPABILITIES,
    idsWrittenBy: "component",
    template: (s, on) => html`${describedHint(lit, s)}${tooltipCopy(s)}<ontario-textarea
        element-id=${s.id}
        name=${s.name}
        caption=${captionOf(s.label)}
        hint-text=${ifDefined(hintJson(s.hint))}
        hint-expander=${ifDefined(expanderOf(s))}
        .value=${live(s.value)}
        ?required=${s.required && !s.disabled}
        error-message=${ifDefined(messageOf(s.errors))}
        language=${languageOf(s.locale)}
        @input=${(event: Event) => on.input(valueOf(event), { interim: true })}
        @change=${() => on.commit()}
      ></ontario-textarea>${noticesOf(lit, s)}${countOf(lit, s)}`,
    after(field, s) {
      boxAttributes(field, "ontario-textarea", s);
      applyModes(field, "ontario-textarea", s);
      describe(field, "ontario-textarea", () => boxesIn(field, "ontario-textarea")[0]).after();
    },
    connect: (field) => describe(field, "ontario-textarea", () => boxesIn(field, "ontario-textarea")[0]).connect(),
    ready: readyOf("ontario-textarea"),
    focusTarget: (field) => boxesIn(field, "ontario-textarea")[0]
  };

  // ── Number: a text box with a numeric keyboard (ontario-input has no type="number") ─────
  /** What the box reports: what reads as a number as one, an emptied box as "", else the text as typed (validation says what is wrong). */
  const reported = (typed: string, locale: string): number | string => (typed.trim() === "" ? "" : (readTypedNumber(typed.trim(), locale) ?? typed));
  /** The box's text already stands for the stored number ("0002", "1,000"): left as typed, so the caret keeps its place. */
  const standsFor = (typed: string, stored: string, locale: string): boolean => {
    if (typed.trim() === "" || stored === "") {
      return typed.trim() === stored;
    }
    return readTypedNumber(typed, locale) === Number(stored);
  };

  const number: FieldAdapter<NumberFieldState> = {
    kind: "field",
    name: "ontario-input-number",
    capabilities: TEXT_CAPABILITIES,
    idsWrittenBy: "component",
    template: (s, on) => html`${describedHint(lit, s)}${tooltipCopy(s)}<ontario-input
        element-id=${s.id}
        name=${s.name}
        caption=${captionOf(s.label)}
        hint-text=${ifDefined(hintJson(s.hint))}
        hint-expander=${ifDefined(expanderOf(s))}
        ?required=${s.required && !s.disabled}
        error-message=${ifDefined(messageOf(s.errors))}
        language=${languageOf(s.locale)}
        @input=${(event: Event) => on.input(reported(valueOf(event), s.locale), { interim: true })}
        @change=${() => on.commit()}
      ></ontario-input>${noticesOf(lit, s)}${countOf(lit, s)}`,
    // The text is written here, not bound: the box keeps what was typed while it stands for the stored number.
    after(field, s) {
      const host = field.querySelector<HTMLElement & { value?: string }>("ontario-input");
      const whole = typeof s.step === "number" && Number.isInteger(s.step) && s.step > 0;
      if (host && !standsFor(String(host.value ?? ""), s.value, s.locale)) {
        host.value = s.value;
      }
      boxAttributes(field, "ontario-input", { ...s, inputMode: s.inputMode ?? (whole ? "numeric" : "decimal") });
      applyModes(field, "ontario-input", s);
      describe(field, "ontario-input", () => boxesIn(field, "ontario-input")[0]).after();
    },
    connect: (field) => describe(field, "ontario-input", () => boxesIn(field, "ontario-input")[0]).connect(),
    ready: readyOf("ontario-input"),
    focusTarget: (field) => boxesIn(field, "ontario-input")[0]
  };

  // ── Select: ontario-dropdown-list, its options a JSON string ────────────────────────────
  const select: FieldAdapter<SelectFieldState> = {
    kind: "field",
    name: "ontario-dropdown-list",
    // The empty first option is the select's caption.
    capabilities: { ...TEXT_CAPABILITIES, placeholder: "drawn" },
    idsWrittenBy: "component",
    template: (s, on) => html`${describedHint(lit, s)}${tooltipCopy(s)}<ontario-dropdown-list
        element-id=${s.id}
        name=${s.name}
        caption=${captionOf(s.label)}
        hint-text=${ifDefined(hintJson(s.hint))}
        hint-expander=${ifDefined(expanderOf(s))}
        options=${JSON.stringify(s.options.map((option) => ({ value: option.value, label: option.label })))}
        is-empty-start-option=${s.emptyLabel}
        .value=${live(s.value)}
        ?required=${s.required && !s.disabled}
        error-message=${ifDefined(messageOf(s.errors))}
        language=${languageOf(s.locale)}
        @change=${(event: CustomEvent<{ value?: string }>) => {
          on.input(String(event.detail?.value ?? valueOf(event)));
          on.commit();
        }}
      ></ontario-dropdown-list>${noticesOf(lit, s)}`,
    after(field, s) {
      applyModes(field, "ontario-dropdown-list", s);
      describe(field, "ontario-dropdown-list", () => boxesIn(field, "ontario-dropdown-list")[0]).after();
    },
    connect: (field) => describe(field, "ontario-dropdown-list", () => boxesIn(field, "ontario-dropdown-list")[0]).connect(),
    ready: readyOf("ontario-dropdown-list"),
    focusTarget: (field) => boxesIn(field, "ontario-dropdown-list")[0]
  };

  // ── Radios and checkboxes: the option list a JSON string ────────────────────────────────
  /** An option as the component takes it: its id, value and label, and its help as the expander. */
  const optionOf = (option: { id: string; value: string; label: string; hint?: string }, help: string) => ({
    value: option.value,
    elementId: option.id,
    label: option.label,
    ...(option.hint ? { hintExpander: { hint: help, content: option.hint, hintContentType: "string" } } : {})
  });

  const radio: FieldAdapter<RadioFieldState> = {
    kind: "field",
    name: "ontario-radio-buttons",
    capabilities: GROUP_CAPABILITIES,
    idsWrittenBy: "component",
    template: (s, on) => html`${describedHint(lit, s)}${tooltipCopy(s)}<ontario-radio-buttons
        name=${s.name}
        caption=${captionOf(s.label)}
        hint-text=${ifDefined(hintJson(s.hint))}
        hint-expander=${ifDefined(expanderOf(s))}
        options=${JSON.stringify(s.options.map((option) => optionOf(option, s.words("tooltipHelp"))))}
        .value=${live(s.value)}
        ?required=${s.required && !s.disabled}
        error-message=${ifDefined(messageOf(s.errors))}
        language=${languageOf(s.locale)}
        @change=${(event: CustomEvent<{ value?: string }>) => {
          on.input(String(event.detail?.value ?? valueOf(event)));
          on.commit();
        }}
      ></ontario-radio-buttons>${noticesOf(lit, s)}`,
    after(field, s) {
      applyModes(field, "ontario-radio-buttons", s);
      reflectDescription(field, field.querySelector("ontario-radio-buttons"), groupBox(field, "ontario-radio-buttons"));
    },
    connect: (field) => keepDescription(field, () => field.querySelector("ontario-radio-buttons"), () => groupBox(field, "ontario-radio-buttons")),
    ready: readyOf("ontario-radio-buttons"),
    // A radio, never the group's fieldset: the checked one, else the first.
    focusTarget(field) {
      const inputs = boxesIn(field, "ontario-radio-buttons") as HTMLInputElement[];
      return inputs.find((input) => input.checked) ?? inputs[0];
    }
  };

  const checkboxes: FieldAdapter<CheckboxesFieldState> = {
    kind: "field",
    name: "ontario-checkboxes",
    capabilities: GROUP_CAPABILITIES,
    idsWrittenBy: "component",
    template: (s, on) => html`${describedHint(lit, s)}${tooltipCopy(s)}<ontario-checkboxes
        name=${s.name}
        caption=${captionOf(s.label)}
        hint-text=${ifDefined(hintJson(s.hint))}
        hint-expander=${ifDefined(expanderOf(s))}
        options=${JSON.stringify(s.options.map((option) => optionOf(option, s.words("tooltipHelp"))))}
        .value=${live(JSON.stringify(s.selected))}
        ?required=${s.required && !s.disabled}
        error-message=${ifDefined(messageOf(s.errors))}
        language=${languageOf(s.locale)}
        @change=${(event: CustomEvent<{ value?: string[] }>) => {
          on.input([...(event.detail?.value ?? [])]);
          on.commit();
        }}
      ></ontario-checkboxes>${noticesOf(lit, s)}`,
    after(field, s) {
      applyModes(field, "ontario-checkboxes", s);
      reflectDescription(field, field.querySelector("ontario-checkboxes"), groupBox(field, "ontario-checkboxes"));
    },
    connect: (field) => keepDescription(field, () => field.querySelector("ontario-checkboxes"), () => groupBox(field, "ontario-checkboxes")),
    ready: readyOf("ontario-checkboxes"),
    focusTarget(field) {
      const boxes = boxesIn(field, "ontario-checkboxes") as HTMLInputElement[];
      return boxes.find((box) => box.checked) ?? boxes[0];
    }
  };

  return { text, textarea, number, select, radio, checkboxes };
}

export type { FieldEvents };
