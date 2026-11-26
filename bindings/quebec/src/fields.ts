/**
 * The Québec design system's leaf components as adapters for the engine contract: text box,
 * textarea, number, radios, checkboxes, a single checkbox, a date and button, each in the
 * toolkit's own markup, and the select in both tiers.
 *
 * Tier 1, the toolkit's official component where its behaviour fits Datum's:
 * - `qc-textfield` wraps the `<input>` / `<textarea>` written inside it (text, textarea, number, and
 *   the three parts of a date, which the toolkit has no component for);
 * - `qc-choice-group` wraps the `<label><input><span>` options (radios, checkboxes);
 * - `qc-checkbox` wraps one checkbox;
 * - `button.qc-button` is the toolkit's button (a class, no component).
 *
 * Tier 2 (select.ts): `qc-select` is a custom listbox (a button and a list in its own shadow
 * root, the native `<select>` hidden), a drastically different control, so the default `select`
 * is Datum's native select in the toolkit's face and the official component is the package type
 * `qc-select` (base `select`, plugin.ts).
 *
 * What is different about this design system, and what the adapters do about it:
 * - The components MOVE their label, description, count and error beside the wrapped control
 *   and clear their own `invalid` when the person types. Datum decides when an error stands, so
 *   `invalid` is bound as a property through `live()`: it is written again whenever the element
 *   disagrees.
 * - Label, description and error text are inserted as HTML by the toolkit: every string handed to
 *   them is escaped.
 * - The components write `aria-describedby` themselves, with ids that exist in the form's tree
 *   (`idsWrittenBy: "component"`); Datum adds the ids the toolkit does not know (a field's
 *   notices, a count's limit sentence). `qc-choice-group` and `qc-checkbox` draw their error in
 *   their own shadow tree, whose ids a slotted control cannot name, so the help text and the
 *   errors also describe the group as its `aria-description`.
 * - The toolkit reads the page language from `<html lang>`, not from the form: its own words follow
 *   the host. The binding always hands it Datum's words (`invalid-text`, `label`, the count).
 * - The count is the toolkit's `.qc-textfield-charcount` drawn by the adapter and counted and
 *   announced by the renderer: `qc-textfield max-length` counts from its own `input` listener, so
 *   it speaks on every keystroke and goes stale when Datum writes the value.
 * - No prefix, no suffix, no group or option hint, no hidden group legend, no tabs, no steps, no
 *   table of inputs: answered `none` (or drawn in the toolkit's classes), never faked.
 */
import type {
  ButtonFieldState,
  CharacterCount,
  CheckboxesFieldState,
  CheckboxFieldState,
  ChoiceOption,
  DateFieldState,
  DateParts,
  FieldAdapter,
  FieldEvents,
  FieldState,
  LiveBinding,
  NumberFieldState,
  RadioFieldState,
  TextareaFieldState,
  TextFieldState,
  View
} from "../../../engine/form-engine/render/live/contract.js";
import { readTypedNumber } from "../../../engine/form-engine/render/live/index.js";
import type { TemplateResult } from "../../../engine/form-engine/render/live/lit.js";
import { addDescribedBy, cls, describeGroup, describeText, keepGroup, description, errorText, esc, formError, hasClass, keepIds, labelText, notices, readOnlyGuard, readyWhen, sizeOf, type Lit } from "./shared.js";

/**
 * What every field of this binding answers about the capabilities the toolkit offers around a field.
 * The tooltip is folded into the description (`degraded`), although the toolkit documents a
 * `qc-tooltip` in a field's label: inside the form's shadow root its `description-id` finds nothing
 * (it looks the id up with `document.getElementById`), so only its `description` attribute, inserted
 * as HTML, could carry the words; on a window narrower than the toolkit's small breakpoint (the
 * window's width, not the form's) it opens as a modal `<dialog>` and writes `overflow: hidden` on the
 * host page's `<body>`; each one adds a `resize` listener on `window` that is never removed (an
 * unmounted form would leave it listening); and its button, an `<a role="button">` inside the
 * `<label>`, would join the field's accessible name while nothing describes the field by the help.
 */
const COMMON = { notice: "drawn", pending: "degraded", tooltip: "degraded", workedOut: "degraded" } as const;

/** The control inside a `qc-textfield`, the one the toolkit wraps. */
const boxOf = (field: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null => field.querySelector<HTMLInputElement | HTMLTextAreaElement>("qc-textfield > input, qc-textfield > textarea");

/** The `<fieldset>` a `qc-choice-group` draws in its own shadow root: the group the options belong to. */
const groupOf = (field: HTMLElement): HTMLElement | null => field.querySelector("qc-choice-group")?.shadowRoot?.querySelector<HTMLElement>("fieldset") ?? null;

/** A text field has drawn when the toolkit has put its `aria-invalid` on the box (its effect has run). */
const textDrawn = (host: Element): boolean => host.querySelector("input, textarea")?.hasAttribute("aria-invalid") === true;

export function createFields(lit: Lit, datum: LiveBinding) {
  const { html, live, ifDefined, nothing } = lit;
  const datumDate = datum.components["date"] as FieldAdapter<DateFieldState> | undefined;

  /**
   * Leaving a field: a change commits, and a blur commits unless a change just did. Shared across
   * draws (a draw between the change and the blur must not make the blur commit a second time).
   */
  const settled = new WeakSet<EventTarget>();
  const leaving = (on: FieldEvents) => ({
    change: (event: Event): void => {
      if (event.target) {
        settled.add(event.target);
      }
      on.commit();
    },
    blur: (event: Event): void => {
      if (event.target && settled.delete(event.target)) {
        return;
      }
      on.commit();
    },
    focus: (event: Event): void => {
      if (event.target) {
        settled.delete(event.target);
      }
    }
  });

  const spellcheck = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : String(value));

  // ── The count and its limit sentence ───────────────────────────────────────────────────────

  /**
   * The toolkit's `.qc-textfield-charcount` with Datum's words, directly after the box (its size
   * rules read `input + .qc-textfield-charcount`), hidden from assistive technology since it changes
   * on every keystroke, and the limit sentence for assistive technology only: the field's
   * description, under the id Datum names. Counting and announcing are the renderer's.
   */
  const count = (c: CharacterCount | undefined): View =>
    c === undefined
      ? nothing
      : html`<div class=${cls("qc-textfield-charcount", c.over && "qc-max-reached")} aria-hidden="true" data-count-status>${c.status}</div><span id=${c.limitId} class="qc-sr-only">${c.limit}</span>`;

  // ── qc-textfield ───────────────────────────────────────────────────────────────────────────

  /**
   * The component around a box. The box is its first static child; the count and the notices come
   * after, in the order the component leaves them (it puts its own nodes beside the box).
   */
  const textfield = (s: TextFieldState, control: View, extra: View = nothing): TemplateResult =>
    html`<qc-textfield
      label=${s.hideLabel ? nothing : esc(s.label)}
      description=${ifDefined(s.hint === undefined || s.hint === "" ? undefined : esc(s.hint))}
      size=${ifDefined(sizeOf(s))}
      ?required=${s.required}
      ?disabled=${s.disabled}
      .invalid=${live(s.errors.length > 0)}
      invalid-text=${ifDefined(errorText(s))}
      >${control}${count(s.characterCount)}${extra}${notices(lit, s)}</qc-textfield
    >`;

  /** After every draw: the ids the toolkit does not know describe the box, and the box says how it is spelled. */
  const afterText = (field: HTMLElement, s: TextFieldState): void => {
    const box = boxOf(field);
    addDescribedBy(box, [s.noticeId, s.characterCount?.limitId]);
    if (box && s.hideLabel) {
      box.setAttribute("aria-label", s.label);
    }
  };
  const connectText = (field: HTMLElement): (() => void) => keepIds(() => boxOf(field));

  const text: FieldAdapter<TextFieldState> = {
    kind: "field",
    name: "qc-textfield",
    capabilities: { ...COMMON, characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    idsWrittenBy: "component",
    template(s, on) {
      const leave = leaving(on);
      return textfield(
        s,
        html`<input
          id=${s.id}
          name=${s.name}
          type="text"
          .value=${live(s.value)}
          placeholder=${ifDefined(s.placeholder)}
          minlength=${ifDefined(s.minLength)}
          pattern=${ifDefined(s.pattern)}
          autocomplete=${ifDefined(s.autocomplete)}
          inputmode=${ifDefined(s.inputMode)}
          spellcheck=${ifDefined(spellcheck(s.spellcheck))}
          ?disabled=${s.disabled}
          ?readonly=${s.readOnly}
          @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, { interim: true })}
          @change=${leave.change}
          @blur=${leave.blur}
          @focus=${leave.focus}
        />`
      );
    },
    after: afterText,
    connect: connectText,
    ready: readyWhen("qc-textfield", textDrawn)
  };

  const textarea: FieldAdapter<TextareaFieldState> = {
    kind: "field",
    name: "qc-textfield-textarea",
    capabilities: { ...COMMON, characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    idsWrittenBy: "component",
    template(s, on) {
      const leave = leaving(on);
      return textfield(
        s,
        html`<textarea
          id=${s.id}
          name=${s.name}
          rows=${s.rows ?? 4}
          .value=${live(s.value)}
          placeholder=${ifDefined(s.placeholder)}
          minlength=${ifDefined(s.minLength)}
          autocomplete=${ifDefined(s.autocomplete)}
          spellcheck=${ifDefined(spellcheck(s.spellcheck))}
          ?disabled=${s.disabled}
          ?readonly=${s.readOnly}
          @input=${(event: Event) => on.input((event.target as HTMLTextAreaElement).value, { interim: true })}
          @change=${leave.change}
          @blur=${leave.blur}
          @focus=${leave.focus}
        ></textarea>`
      );
    },
    after: afterText,
    connect: connectText,
    ready: readyWhen("qc-textfield", textDrawn)
  };

  // ── Number: a text box with a numeric keyboard, never type="number": the box keeps what was typed ──

  /** What the box reports: what reads as a number as one, an emptied box as "", else the text as typed (validation says what is wrong). */
  const reported = (input: HTMLInputElement, locale: string): number | string => {
    const typed = input.value.trim();
    return typed === "" ? "" : (readTypedNumber(typed, locale) ?? input.value);
  };
  /** The box's text already stands for the stored number ("0002", "1,000"): it is left as typed, so the caret keeps its place. */
  const standsFor = (input: HTMLInputElement, stored: string, locale: string): boolean => {
    if (stored === "" || input.value.trim() === "") {
      return false;
    }
    const typed = readTypedNumber(input.value, locale);
    return typed !== undefined && typed === Number(stored);
  };

  const number: FieldAdapter<NumberFieldState> = {
    kind: "field",
    name: "qc-textfield-number",
    capabilities: { ...COMMON, hideLabel: "drawn", placeholder: "drawn" },
    idsWrittenBy: "component",
    template(s, on) {
      const leave = leaving(on);
      const whole = typeof s.step === "number" && Number.isInteger(s.step) && s.step > 0;
      return textfield(
        s,
        html`<input
          id=${s.id}
          name=${s.name}
          type="text"
          inputmode=${s.inputMode ?? (whole ? "numeric" : "decimal")}
          spellcheck=${spellcheck(s.spellcheck) ?? "false"}
          placeholder=${ifDefined(s.placeholder)}
          autocomplete=${ifDefined(s.autocomplete)}
          ?disabled=${s.disabled}
          ?readonly=${s.readOnly}
          @input=${(event: Event) => on.input(reported(event.target as HTMLInputElement, s.locale), { interim: true })}
          @change=${leave.change}
          @blur=${leave.blur}
          @focus=${leave.focus}
        />`
      );
    },
    // The text is written here, not bound: the box keeps what was typed while it stands for the stored number.
    after(field, s) {
      afterText(field, s);
      const box = boxOf(field) as HTMLInputElement | null;
      if (box && box.value !== s.value && !standsFor(box, s.value, s.locale)) {
        box.value = s.value;
      }
    },
    connect: connectText,
    ready: readyWhen("qc-textfield", textDrawn)
  };

  // ── qc-choice-group: radios and checkboxes ─────────────────────────────────────────────────

  /** One option as the toolkit writes it: `label > input + span`; in selection-button mode the span is a `.qc-tile`. */
  const option = (s: RadioFieldState | CheckboxesFieldState, type: "radio" | "checkbox", item: ChoiceOption, change: (event: Event) => void): View => {
    const tile = hasClass(s, "qc-selection-button") || hasClass(s, "qc-selection-button-inline");
    const compact = hasClass(s, "qc-compact") || tile;
    const hint = item.hint !== undefined && item.hint !== "" ? item.hint : undefined;
    return html`<label class=${cls("qc-choicefield-label", tile && "qc-selection-button", tile && hasClass(s, "qc-selection-button-inline") && "qc-selection-button-inline")}
      ><input
        class=${cls("qc-choicefield", compact && "qc-compact", tile && "qc-selection-button")}
        id=${item.id}
        type=${type}
        name=${s.name}
        value=${item.value}
        .checked=${live(item.checked)}
        aria-describedby=${ifDefined(hint !== undefined ? item.hintId : undefined)}
        ?disabled=${s.disabled}
        @change=${change}
      /><span class=${tile ? "qc-tile" : nothing}
        >${tile
          ? html`<span class="qc-tile-text">${item.label}</span>${hint !== undefined ? html`<span id=${ifDefined(item.hintId)} class="qc-tile-description">${hint}</span>` : nothing}`
          : html`${item.label}${hint !== undefined ? html`<span id=${ifDefined(item.hintId)} class="qc-description datum-qc-option-hint">${hint}</span>` : nothing}`}</span
      ></label
    >`;
  };

  const choiceGroup = (s: RadioFieldState | CheckboxesFieldState, type: "radio" | "checkbox", change: (event: Event) => void): TemplateResult =>
    html`<qc-choice-group
        name=${s.name}
        legend=${esc(s.label)}
        ?required=${s.required}
        ?compact=${hasClass(s, "qc-compact")}
        ?selection-button=${hasClass(s, "qc-selection-button") || hasClass(s, "qc-selection-button-inline")}
        ?inline=${hasClass(s, "qc-selection-button-inline")}
        .invalid=${live(s.errors.length > 0)}
        invalid-text=${ifDefined(errorText(s))}
        >${description(lit, s)}${s.options.map((item) => option(s, type, item, change))}</qc-choice-group
      >${notices(lit, s)}`;

  /**
   * What describes the group: its help text, its errors and its notices. The error is drawn in the
   * toolkit's shadow tree, so the fieldset it draws names it by element reflection (shared.ts).
   */
  const describeChoice = (field: HTMLElement, s: RadioFieldState | CheckboxesFieldState): void =>
    describeGroup(field, groupOf(field), { ids: [s.hint !== undefined && s.hint !== "" ? s.hintId : undefined, s.noticeId], text: { hint: s.hint, errors: [...s.errors, ...s.notices.map((notice) => notice.message)] } });
  const connectChoice = (field: HTMLElement): (() => void) => keepGroup(field, () => field.querySelector("qc-choice-group"));

  const choiceDrawn = (host: Element): boolean => host.shadowRoot?.querySelector("fieldset") != null && host.querySelectorAll("input").length > 0;

  const radio: FieldAdapter<RadioFieldState> = {
    kind: "field",
    name: "qc-choice-group-radio",
    // The toolkit has no hidden legend, no group hint and no option hint of its own: the hints are its `.qc-description`.
    capabilities: { ...COMMON },
    idsWrittenBy: "component",
    template: (s, on) =>
      choiceGroup(s, "radio", (event) => {
        if ((event.target as HTMLInputElement).checked) {
          on.input((event.target as HTMLInputElement).value);
          on.commit();
        }
      }),
    after: describeChoice,
    connect: connectChoice,
    // The checked radio, else the first: where a summary link to a group lands.
    focusTarget: (field) => field.querySelector<HTMLElement>('qc-choice-group input[type="radio"]:checked, qc-choice-group input[type="radio"]'),
    ready: readyWhen("qc-choice-group", choiceDrawn)
  };

  const checkboxes: FieldAdapter<CheckboxesFieldState> = {
    kind: "field",
    name: "qc-choice-group-checkbox",
    capabilities: { ...COMMON },
    idsWrittenBy: "component",
    template: (s, on) =>
      choiceGroup(s, "checkbox", (event) => {
        // The values chosen, read from the boxes as they stand: one change may follow another before a draw.
        const group = (event.currentTarget as HTMLElement).closest("qc-choice-group");
        on.input(Array.from(group?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked') ?? [], (box) => box.value));
        on.commit();
      }),
    after: describeChoice,
    connect: connectChoice,
    focusTarget: (field) => field.querySelector<HTMLElement>('qc-choice-group input[type="checkbox"]:checked, qc-choice-group input[type="checkbox"]'),
    ready: readyWhen("qc-choice-group", choiceDrawn)
  };

  // ── qc-checkbox: a single checkbox ─────────────────────────────────────────────────────────

  const checkbox: FieldAdapter<CheckboxFieldState> = {
    kind: "field",
    name: "qc-checkbox",
    capabilities: { ...COMMON },
    idsWrittenBy: "component",
    template: (s, on) =>
      html`<qc-checkbox ?required=${s.required} ?compact=${hasClass(s, "qc-compact")} .invalid=${live(s.errors.length > 0)} invalid-text=${ifDefined(errorText(s))}
          ><label class="qc-choicefield-label"
            ><input
              class=${cls("qc-choicefield", hasClass(s, "qc-compact") && "qc-compact")}
              id=${s.id}
              name=${s.name}
              type="checkbox"
              aria-describedby=${ifDefined(s.hint !== undefined && s.hint !== "" ? s.hintId : undefined)}
              .checked=${live(s.checked)}
              ?disabled=${s.disabled}
              @change=${(event: Event) => {
                on.input((event.target as HTMLInputElement).checked);
                on.commit();
              }} /><span>${s.label}</span></label
          >${description(lit, s)}</qc-checkbox
        >${notices(lit, s)}`,
    // qc-checkbox takes no description (its `description` prop is not passed through by the custom element), so the hint is the toolkit's
    // `.qc-description` slotted under the label, in the form's tree, and the checkbox names it by id. Its error is drawn in the component's
    // own shadow tree, which a slotted control cannot name: the errors and notices are the checkbox's `aria-description`.
    after(field, s) {
      const input = field.querySelector("qc-checkbox > label > input");
      describeText(input, { errors: [...s.errors, ...s.notices.map((notice) => notice.message)] });
    },
    focusTarget: (field) => field.querySelector<HTMLElement>("qc-checkbox input"),
    ready: readyWhen("qc-checkbox", (host) => host.shadowRoot != null && host.querySelector("input") != null)
  };

  // ── Date: the toolkit has none, so day, month and year are three qc-textfields in a fieldset ──

  type Part = keyof DateParts;
  const PARTS = ["day", "month", "year"] as const satisfies readonly Part[];
  const PART_WORD = { day: "dateDay", month: "dateMonth", year: "dateYear" } as const;
  const PART_SIZE = { day: "xs", month: "xs", year: "sm" } as const;

  const readParts = (group: Element | null): DateParts => {
    const read = (part: Part): string => group?.querySelector<HTMLInputElement>(`[data-value-part="${part}"]`)?.value ?? "";
    return { year: read("year"), month: read("month"), day: read("day") };
  };

  const date: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "qc-date",
    capabilities: { ...COMMON },
    template(s, on) {
      const invalid = s.errors.length > 0;
      const report = (event: Event, interim: boolean): void => {
        on.parts(readParts((event.currentTarget as Element).closest(".qc-formfield-row")), interim ? { interim: true } : undefined);
      };
      // An invalid date marks the boxes that need work: those it lacks, else every box.
      const marked = (part: Part): boolean => invalid && (s.missingParts.length === 0 || s.missingParts.includes(part));
      // The field is left only when focus goes out of the whole date: tabbing day to year checks nothing.
      const left = (event: FocusEvent): void => {
        const into = event.relatedTarget;
        if (!(into instanceof Node && (event.currentTarget as Element).contains(into))) {
          on.commit();
        }
      };
      const box = (part: Part): View => html`<qc-textfield label=${esc(s.words(PART_WORD[part]))} size=${PART_SIZE[part]} ?disabled=${s.disabled} class=${marked(part) ? "datum-qc-invalid" : nothing}
        ><input
          id="${s.id}__${part}"
          name="${s.name}-${part}"
          type="text"
          data-value-part=${part}
          inputmode="numeric"
          autocomplete="off"
          aria-invalid=${marked(part) ? "true" : "false"}
          .value=${live(s.parts[part])}
          ?disabled=${s.disabled}
          ?readonly=${s.readOnly}
          @input=${(event: Event) => report(event, true)}
          @change=${(event: Event) => report(event, false)}
      /></qc-textfield>`;
      // The error sits in a wrapper that is always there, so a draw never swaps the boxes for new ones.
      return html`<div class=${invalid ? "qc-fieldset-invalid" : nothing}>
        <fieldset id=${s.id} class="qc-fieldset datum-qc-date" aria-describedby=${ifDefined(s.describedBy.length > 0 ? s.describedBy.join(" ") : undefined)} @focusout=${left}>
          <legend>${labelText(lit, s.label, s.required)}</legend>
          ${description(lit, s)}
          <div class="qc-formfield-row">${PARTS.map(box)}</div>
          ${formError(lit, s, "qc-xs-mt")}${notices(lit, s)}
        </fieldset>
      </div>`;
    },
    // The first box the date still lacks, in the order the boxes stand: where a summary link to a date lands.
    focusTarget: (field, s) => datumDate?.focusTarget?.(field, s) ?? field.querySelector<HTMLElement>('[data-value-part="day"]'),
    ready: readyWhen("qc-textfield", textDrawn)
  };

  // ── Button: the toolkit's `button.qc-button` ───────────────────────────────────────────────

  /** The toolkit's variants by the name Datum gives the variant; anything else is the primary button. */
  const buttonClass = (variant: string | undefined): string => {
    switch (variant) {
      case "secondary":
      case "light":
      case "dark":
        return "qc-secondary";
      case "tertiary":
      case "link":
        return "qc-tertiary";
      case "danger":
        return "qc-danger";
      default:
        return "qc-primary";
    }
  };

  const button: FieldAdapter<FieldState> = {
    kind: "field",
    name: "qc-button",
    capabilities: {},
    template(s) {
      const given = s as Partial<ButtonFieldState>;
      const model = s.model;
      const variant = given.variant ?? model.buttonVariant;
      const action = given.action ?? model.buttonAction;
      const size = given.size ?? model.buttonSize;
      const working = action !== undefined && (s.busy === "submitting" || s.busy === "navigating");
      // A press is the renderer's (`data-button-action`, heard as `datum-form-action`). Busy is aria-disabled with the toolkit's disabled look, never `disabled`: the button keeps its focus.
      return html`<button
        type="button"
        class=${cls("qc-button", buttonClass(variant), size === "sm" && "qc-compact", working && "qc-disabled")}
        data-button-action=${ifDefined(action)}
        data-button-signature=${ifDefined(model.buttonSignature)}
        ?disabled=${s.disabled || s.readOnly}
        aria-disabled=${working ? "true" : nothing}
      >${s.label}</button>`;
    }
  };

  return { text, textarea, number, radio, checkboxes, checkbox, date, button };
}
