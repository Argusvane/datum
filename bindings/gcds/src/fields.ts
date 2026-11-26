/**
 * The GC Design System textarea, select, radios and checkboxes on the
 * engine's binding contract, each drawn with the design system's own component.
 *
 * What each tests of the contract:
 * - textarea: a component that counts characters itself, but only from a `maxlength` it enforces.
 *   Datum never writes `maxlength` (over-limit typing is allowed and raised as an error), so
 *   gcds-textarea's own count is unusable and the count is drawn beside it, as for gcds-input
 *   (`characterCount: drawn`, `countsCharacters: renderer`, the renderer's announcer reads it).
 * - select: options as the component's children; `placeholder` is the select's empty caption.
 * - radios: the answer is one string.
 * - checkboxes: the component holds the chosen values as a list; the renderer turns the list into
 *   Datum's one boolean per option (`fields.ts` in the renderer), the adapter only reports it.
 * - radios and checkboxes draw a group only from two options: gcds-radios refuses fewer (a render
 *   error, nothing drawn) and gcds-checkboxes turns one option into a lone checkbox that drops the
 *   question. Their `when` asks for two, so a list with fewer (one choice, or a data source still
 *   loading) falls to Datum's adapter, tinted and reported by `unsupported()`.
 * - checkbox: a lone checkbox is gcds-checkboxes with one option (its single-checkbox mode: the
 *   option's label, the hint and the error under it); the list it holds is reported as a boolean.
 */
import type { CheckboxesFieldState, CheckboxFieldState, FieldAdapter, RadioFieldState, SelectFieldState, TextareaFieldState } from "../../../engine/form-engine/render/live/contract.js";
import { boxesIn, hintOf, keepDescription, languageOf, messageOf, noticesOf, readyOf, reflectDescription, valueOf, type Lit } from "./shared.js";

/** The `fieldset` inside a group component (radios, checkboxes, date input), where its description lives. */
const groupBox = (field: HTMLElement, tag: string): HTMLElement | null => field.querySelector(tag)?.shadowRoot?.querySelector<HTMLElement>("fieldset") ?? null;

export function createFields(lit: Lit): {
  textarea: FieldAdapter<TextareaFieldState>;
  select: FieldAdapter<SelectFieldState>;
  radio: FieldAdapter<RadioFieldState>;
  checkboxes: FieldAdapter<CheckboxesFieldState>;
  checkbox: FieldAdapter<CheckboxFieldState>;
} {
  const { html, ifDefined, live } = lit;

  // ── Textarea ────────────────────────────────────────────────────────────────────────────
  const textarea: FieldAdapter<TextareaFieldState> = {
    kind: "field",
    name: "gcds-textarea",
    capabilities: { notice: "degraded", pending: "degraded", tooltip: "degraded", workedOut: "degraded", characterCount: "drawn", hideLabel: "drawn" },
    idsWrittenBy: "component",
    template: (s, on) => html`<gcds-textarea
        textarea-id=${s.id}
        name=${s.name}
        label=${s.label}
        ?hide-label=${s.hideLabel}
        hint=${ifDefined(hintOf(s))}
        error-message=${ifDefined(messageOf(s.errors))}
        .value=${live(s.value)}
        rows=${ifDefined(s.rows)}
        minlength=${ifDefined(s.minLength)}
        ?required=${s.required && !s.disabled}
        ?disabled=${s.disabled}
        lang=${languageOf(s.locale)}
        validate-on="other"
        @input=${(event: Event) => on.input(valueOf(event), { interim: true })}
        @change=${() => on.commit()}
      ></gcds-textarea>${noticesOf(lit, s)}${s.characterCount === undefined
        ? lit.nothing
        : html`<div class=${s.characterCount.over ? "datum-gcds-count datum-gcds-count--over" : "datum-gcds-count"}>
            <gcds-sr-only tag="span" id=${s.characterCount.limitId} data-describes>${s.characterCount.limit}</gcds-sr-only>
            <gcds-text aria-hidden="true" margin-bottom="0">${s.characterCount.status}</gcds-text>
          </div>`}`,
    // No `readonly` on gcds-textarea: set on its box. No spell-check setting either.
    after(field, s) {
      for (const box of boxesIn(field, "gcds-textarea")) {
        if (box instanceof HTMLTextAreaElement) {
          box.readOnly = s.readOnly;
          if (s.spellcheck === undefined) {
            box.removeAttribute("spellcheck");
          } else {
            box.setAttribute("spellcheck", String(s.spellcheck));
          }
          reflectDescription(field, box);
        }
      }
    },
    connect: (field) => keepDescription(field, () => boxesIn(field, "gcds-textarea")[0]),
    ready: readyOf("gcds-textarea"),
    focusTarget: (field) => field.querySelector<HTMLElement>("gcds-textarea")
  };

  // ── Select ──────────────────────────────────────────────────────────────────────────────
  const select: FieldAdapter<SelectFieldState> = {
    kind: "field",
    name: "gcds-select",
    capabilities: { notice: "degraded", pending: "degraded", tooltip: "degraded", workedOut: "degraded", hideLabel: "drawn", placeholder: "drawn" },
    idsWrittenBy: "component",
    template: (s, on) => html`<gcds-select
        select-id=${s.id}
        name=${s.name}
        label=${s.label}
        ?hide-label=${s.hideLabel}
        hint=${ifDefined(hintOf(s))}
        error-message=${ifDefined(messageOf(s.errors))}
        default-value=${s.emptyLabel}
        .value=${live(s.value)}
        ?required=${s.required && !s.disabled}
        ?disabled=${s.disabled}
        lang=${languageOf(s.locale)}
        validate-on="other"
        @change=${(event: Event) => {
          on.input(valueOf(event));
          on.commit();
        }}
      >${s.options.map((option) => html`<option value=${option.value}>${option.label}</option>`)}</gcds-select>${noticesOf(lit, s)}`,
    // A select has no read-only in HTML at all: the renderer's guard refuses its choices while read-only and
    // marks the select inside the component aria-readonly.
    after: (field) => reflectDescription(field, boxesIn(field, "gcds-select")[0]),
    connect: (field) => keepDescription(field, () => boxesIn(field, "gcds-select")[0]),
    ready: readyOf("gcds-select"),
    focusTarget: (field) => field.querySelector<HTMLElement>("gcds-select")
  };

  // ── Radios ──────────────────────────────────────────────────────────────────────────────
  const radio: FieldAdapter<RadioFieldState> = {
    kind: "field",
    name: "gcds-radios",
    // gcds-radios draws nothing for fewer than two options.
    when: (s) => s.options.length >= 2,
    capabilities: { notice: "degraded", pending: "degraded", tooltip: "degraded", workedOut: "degraded", hideLabel: "drawn" },
    idsWrittenBy: "component",
    template: (s, on) =>
      // `options` is a string so it is written again only when an option changes.
      html`<gcds-radios
        name=${s.name}
        legend=${s.label}
        ?hide-legend=${s.hideLabel}
        hint=${ifDefined(hintOf(s))}
        options=${JSON.stringify(s.options.map((o) => ({ id: o.id, label: o.label, value: o.value, ...(o.hint ? { hint: o.hint } : {}) })))}
        .value=${live(s.value)}
        ?required=${s.required && !s.disabled}
        ?disabled=${s.disabled}
        error-message=${ifDefined(messageOf(s.errors))}
        lang=${languageOf(s.locale)}
        validate-on="other"
        @input=${(event: Event) => on.input(valueOf(event))}
        @change=${() => on.commit()}
      ></gcds-radios>${noticesOf(lit, s)}`,
    // gcds-radios has no read-only: the renderer's guard refuses changes while the group is read-only, and its
    // plain fieldset takes the radiogroup role with aria-readonly from the renderer while it is.
    after: (field) => reflectDescription(field, groupBox(field, "gcds-radios")),
    connect: (field) => keepDescription(field, () => groupBox(field, "gcds-radios")),
    ready: readyOf("gcds-radios"),
    // A radio, never the group's fieldset, which is where the element itself sends focus.
    focusTarget(field) {
      const inputs = Array.from(field.querySelector("gcds-radios")?.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []);
      return inputs.find((input) => input.checked) ?? inputs[0] ?? null;
    }
  };

  // ── Checkboxes ──────────────────────────────────────────────────────────────────────────
  const checkboxes: FieldAdapter<CheckboxesFieldState> = {
    kind: "field",
    name: "gcds-checkboxes",
    // One option is gcds-checkboxes' lone checkbox, which drops the legend; none draws nothing.
    when: (s) => s.options.length >= 2,
    capabilities: { notice: "degraded", pending: "degraded", tooltip: "degraded", workedOut: "degraded", hideLabel: "drawn" },
    idsWrittenBy: "component",
    template: (s, on) => html`<gcds-checkboxes
        name=${s.name}
        legend=${s.label}
        ?hide-legend=${s.hideLabel}
        hint=${ifDefined(hintOf(s))}
        error-message=${ifDefined(messageOf(s.errors))}
        options=${JSON.stringify(s.options.map((option) => ({ id: option.id, label: option.label, value: option.value, ...(option.hint ? { hint: option.hint } : {}) })))}
        .value=${s.selected}
        ?required=${s.required && !s.disabled}
        ?disabled=${s.disabled}
        lang=${languageOf(s.locale)}
        validate-on="other"
        @input=${(event: Event) => on.input([...((event.currentTarget as HTMLElement & { value?: string[] }).value ?? [])])}
        @change=${() => on.commit()}
      ></gcds-checkboxes>${noticesOf(lit, s)}`,
    // The renderer marks the boxes inside the component aria-readonly while the field is read-only.
    after: (field) => reflectDescription(field, groupBox(field, "gcds-checkboxes")),
    connect: (field) => keepDescription(field, () => groupBox(field, "gcds-checkboxes")),
    ready: readyOf("gcds-checkboxes"),
    focusTarget(field) {
      const boxes = boxesIn(field, "gcds-checkboxes").filter((box): box is HTMLInputElement => box instanceof HTMLInputElement);
      return boxes.find((box) => box.checked) ?? boxes[0] ?? null;
    }
  };

  // ── Checkbox ────────────────────────────────────────────────────────────────────────────
  // gcds-checkboxes with one option is GC Design System's single checkbox: the field's label is the
  // option's, its hint is the option's (so the box is described by it), its error is drawn under it.
  const CHECKED = "on";
  const checkbox: FieldAdapter<CheckboxFieldState> = {
    kind: "field",
    name: "gcds-checkbox",
    capabilities: { notice: "degraded", pending: "degraded", tooltip: "degraded", workedOut: "degraded", hideLabel: "drawn" },
    idsWrittenBy: "component",
    template: (s, on) => {
      const hint = hintOf(s);
      return html`<gcds-checkboxes
        name=${s.name}
        ?hide-label=${s.hideLabel}
        hint=${ifDefined(hint)}
        error-message=${ifDefined(messageOf(s.errors))}
        options=${JSON.stringify([{ id: s.id, label: s.label, value: CHECKED, ...(hint !== undefined ? { hint } : {}) }])}
        .value=${s.checked ? [CHECKED] : []}
        ?required=${s.required && !s.disabled}
        ?disabled=${s.disabled}
        lang=${languageOf(s.locale)}
        validate-on="other"
        @input=${(event: Event) => {
          on.input(((event.currentTarget as HTMLElement & { value?: string[] }).value ?? []).includes(CHECKED));
          on.commit();
        }}
      ></gcds-checkboxes>${noticesOf(lit, s)}`;
    },
    // The renderer marks the box inside the component aria-readonly while the field is read-only.
    after: (field) => reflectDescription(field, boxesIn(field, "gcds-checkboxes")[0]),
    connect: (field) => keepDescription(field, () => boxesIn(field, "gcds-checkboxes")[0]),
    ready: readyOf("gcds-checkboxes"),
    focusTarget: (field) => boxesIn(field, "gcds-checkboxes")[0] ?? null
  };

  return { textarea, select, radio, checkboxes, checkbox };
}
