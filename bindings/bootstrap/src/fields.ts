/**
 * Bootstrap's leaf components as adapters for the engine contract: text field, textarea, number,
 * select, radios, checkboxes, a single checkbox, a date and button.
 *
 * Markup is what Bootstrap's documentation writes for its forms (getbootstrap.com/docs/5.3/forms:
 * overview, form controls, select, checks and radios, input group, validation; the release ships
 * no templates, only Sass and script, so the markup is read from those pages and the compiled
 * stylesheet). Each field is a `div.mb-3` (Bootstrap's own spacing between fields), the label a
 * `form-label`, the control its `form-control` / `form-select` / `form-check-input`, the help
 * `form-text`, the problem `invalid-feedback` under a control marked `is-invalid`. Datum owns the
 * answer, the checks, the words, focus, the read-only guards and the state hooks. So an adapter
 * here:
 *
 * - draws every id the state names (hint, error, notice, count limit, worked-out line) and writes
 *   `aria-describedby` from `state.describedBy`, never assembling an IDREF of its own;
 * - marks the REQUIRED fields (the form's `required` word, Bootstrap's `text-danger`) and sets
 *   `required` on the control, as Bootstrap's validation examples do; `aria-invalid` says a
 *   blocking error is shown;
 * - reports typed values (`on.input`, interim while typing), settled ones and leaving a field
 *   (`on.commit`), and never writes a read-only state as `disabled`;
 * - starts none of Bootstrap's script: nothing here carries a `data-bs-*`
 *   attribute, so the script, if the host loads it, finds nothing to act on.
 *
 * Warnings and info (`state.notices`) are Bootstrap's alerts (`alert-warning`, `alert-info`),
 * never its error styling and never announced as alerts. A pending check is Bootstrap's spinner and
 * the form's word: `degraded`, so the renderer folds the word into the hint (the control's
 * description) and the spinner, hidden from assistive technology, stands in that line. A tooltip is
 * Bootstrap's script (Popper), so it is `degraded` too: the renderer folds the help into the hint.
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
  SelectFieldState,
  TextareaFieldState,
  TextFieldState,
  View
} from "../../../engine/form-engine/render/live/contract.js";
import type { Lit, TemplateResult } from "../../../engine/form-engine/render/live/lit.js";
import { readTypedNumber } from "../../../engine/form-engine/render/live/index.js";

/** A class list from names, skipping empty ones. */
export const cls = (...names: ReadonlyArray<string | false | undefined>): string => names.filter((name): name is string => typeof name === "string" && name !== "").join(" ");

/** `aria-describedby` from the ids that exist (the state's own list), else no attribute. */
export const describedByOf = (ids: readonly string[] | undefined): string | undefined => (ids !== undefined && ids.length > 0 ? ids.join(" ") : undefined);

/** The first control of a field, for a summary link: the control, or the first of a group. */
export function firstControl(field: HTMLElement): HTMLElement | null {
  return field.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea");
}

export function createFields(lit: Lit, datum: LiveBinding) {
  const { html, live, ifDefined, nothing } = lit;
  /** Datum's date: its focus target is the first part box lacking, in the order the boxes stand (boxes marked `data-value-part`). */
  const datumDate = datum.components.date as FieldAdapter<DateFieldState> | undefined;

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

  // ── The parts every field shares ───────────────────────────────────────────────────────────

  /**
   * The binding's required mark (Bootstrap documents none): the form's word in `text-danger`. On a
   * control's label it is hidden from assistive technology, the control's `required` says it; on a
   * group's legend it is `announced`, since a checkbox group and a date carry no required state.
   */
  const requiredMark = (s: Pick<FieldState, "required" | "words">, announced = false): View => {
    const mark = s.required ? s.words("required") : "";
    return mark === "" ? nothing : html` <span class="text-danger" aria-hidden=${announced ? nothing : "true"}>${mark}</span>`;
  };

  const label = (s: FieldState): View =>
    html`<label class=${cls("form-label", s.hideLabel && "visually-hidden")} for=${s.id}>${s.label}${requiredMark(s)}</label>`;

  /** A group's name, as Bootstrap's horizontal-form example writes a radio group's: `col-form-label pt-0`. Its mark is announced unless each control says required (radios). */
  const legend = (s: FieldState, announced = true): View =>
    html`<legend id=${s.labelId} class=${cls("col-form-label", "pt-0", s.hideLabel && "visually-hidden")}>${s.label}${requiredMark(s, announced)}</legend>`;

  /** Bootstrap's spinner while an async check on the answer runs, hidden from assistive technology: the form's word is in the hint beside it (the renderer folds it there). */
  const spinner = (s: FieldState): View =>
    s.pending ? html`<span class="spinner-border spinner-border-sm me-2" aria-hidden="true" data-pending-status></span>` : nothing;

  const hint = (s: FieldState): View =>
    s.hint !== undefined && s.hint !== "" ? html`<div id=${ifDefined(s.hintId)} class=${cls("form-text", s.pending && "d-flex align-items-center")}>${spinner(s)}${s.hint}</div>` : nothing;

  /** A journey page's line saying the value is worked out from other answers: form text under the id `describedBy` names after the hint. */
  const workedOut = (s: FieldState): View =>
    s.workedOut !== undefined && s.workedOutId !== undefined ? html`<div id=${s.workedOutId} class="form-text" data-worked-out>${s.workedOut}</div>` : nothing;

  /** `invalid-feedback` under an `is-invalid` control; `d-block` where the control is not its previous sibling (a group). */
  const error = (s: FieldState, always = false): View =>
    s.errors.length === 0 || s.errorId === undefined ? nothing : html`<div id=${s.errorId} class=${cls("invalid-feedback", always && "d-block")}>${s.errors.join("; ")}</div>`;

  /**
   * Warnings and info, in Bootstrap's alerts and never in its error styling. Both sit under the id
   * the control is described by; neither is announced as an error: no role.
   */
  const notices = (s: FieldState): View =>
    s.notices.length === 0 || s.noticeId === undefined
      ? nothing
      : html`<div id=${s.noticeId} class="mt-2" data-notices>${s.notices.map(
          (notice) => html`<div class=${`alert alert-${notice.severity} py-2 px-3 mb-2`} data-severity=${notice.severity}><span class="visually-hidden">${s.words(notice.severity === "warning" ? "noticeWarning" : "noticeInfo")}</span>${notice.message}</div>`
        )}</div>`;

  /**
   * The count: Bootstrap has none, so it is form text. The limit sentence is visually hidden (it is
   * the field's description, under the id the state names), the status shown and hidden from
   * screen readers since it changes on every keystroke. The renderer counts and announces.
   */
  const count = (c: CharacterCount | undefined): View =>
    c === undefined
      ? nothing
      : html`<div id=${c.limitId} class="visually-hidden">${c.limit}</div><div class=${cls("form-text", c.over && "text-danger")} aria-hidden="true" data-count-status>${c.status}</div>`;

  /** An error is shown, or the count is past its limit (the box is marked as Bootstrap marks an invalid one). */
  const invalidOf = (s: TextFieldState): boolean => s.errors.length > 0 || s.characterCount?.over === true;

  const spellcheck = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : String(value));
  const flag = (on: boolean): "true" | typeof nothing => (on ? "true" : nothing);

  /** A box with its affixes in `input-group`, the error inside the group after them. */
  const affixed = (s: TextFieldState, input: View): View =>
    s.prefix !== undefined || s.suffix !== undefined
      ? html`<div class=${cls("input-group", s.errors.length > 0 && "has-validation")}>${s.prefix !== undefined ? html`<span class="input-group-text" aria-hidden="true">${s.prefix}</span>` : nothing}${input}${s.suffix !== undefined ? html`<span class="input-group-text" aria-hidden="true">${s.suffix}</span>` : nothing}${error(s)}</div>`
      : html`${input}${error(s)}`;

  /** What a text box and a textarea share: label, the box (with its feedback), hint (with the pending spinner), worked-out line, notices, the count. */
  const textField = (s: TextFieldState, control: View): TemplateResult =>
    html`<div class="mb-3">${label(s)}${control}${hint(s)}${workedOut(s)}${notices(s)}${count(s.characterCount)}</div>`;

  // ── Text ───────────────────────────────────────────────────────────────────────────────────

  const text: FieldAdapter<TextFieldState> = {
    kind: "field",
    name: "bootstrap-text",
    // Bootstrap's alert and input group are drawn as the DS writes them; its tooltip is a script's; pending is its spinner beside the word the renderer folds into the hint.
    // The count is form text with the renderer counting and announcing (`countsCharacters: "renderer"`).
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", prefix: "drawn", suffix: "drawn", characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      return textField(
        s,
        affixed(
          s,
          html`<input
            class=${cls("form-control", invalidOf(s) && "is-invalid")}
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
            aria-describedby=${ifDefined(describedByOf(s.describedBy))}
            aria-invalid=${flag(s.invalid)}
            ?required=${s.required}
            ?disabled=${s.disabled}
            ?readonly=${s.readOnly}
            @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, { interim: true })}
            @change=${leave.change}
            @blur=${leave.blur}
            @focus=${leave.focus}
          />`
        )
      );
    }
  };

  // ── Textarea ───────────────────────────────────────────────────────────────────────────────

  const textarea: FieldAdapter<TextareaFieldState> = {
    kind: "field",
    name: "bootstrap-textarea",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      return textField(
        s,
        html`<textarea
          class=${cls("form-control", invalidOf(s) && "is-invalid")}
          id=${s.id}
          name=${s.name}
          rows=${ifDefined(s.rows)}
          .value=${live(s.value)}
          placeholder=${ifDefined(s.placeholder)}
          minlength=${ifDefined(s.minLength)}
          autocomplete=${ifDefined(s.autocomplete)}
          spellcheck=${ifDefined(spellcheck(s.spellcheck))}
          aria-describedby=${ifDefined(describedByOf(s.describedBy))}
          aria-invalid=${flag(s.invalid)}
          ?required=${s.required}
          ?disabled=${s.disabled}
          ?readonly=${s.readOnly}
          @input=${(event: Event) => on.input((event.target as HTMLTextAreaElement).value, { interim: true })}
          @change=${leave.change}
          @blur=${leave.blur}
          @focus=${leave.focus}
        ></textarea>${error(s)}`
      );
    }
  };

  // ── Number ─────────────────────────────────────────────────────────────────────────────────
  // A text box with a numeric keyboard (`inputmode`), never type="number": the box keeps what was typed.

  /** What a text box drawn for a number reports: what reads as a number as one, an emptied box as "", else the text as typed (validation says what is wrong). */
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
    name: "bootstrap-number",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", prefix: "drawn", suffix: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      const whole = typeof s.step === "number" && Number.isInteger(s.step) && s.step > 0;
      return textField(
        s,
        affixed(
          s,
          html`<input
            class=${cls("form-control", invalidOf(s) && "is-invalid")}
            id=${s.id}
            name=${s.name}
            type="text"
            inputmode=${s.inputMode ?? (whole ? "numeric" : "decimal")}
            spellcheck=${spellcheck(s.spellcheck) ?? "false"}
            placeholder=${ifDefined(s.placeholder)}
            autocomplete=${ifDefined(s.autocomplete)}
            aria-describedby=${ifDefined(describedByOf(s.describedBy))}
            aria-invalid=${flag(s.invalid)}
            ?required=${s.required}
            ?disabled=${s.disabled}
            ?readonly=${s.readOnly}
            @input=${(event: Event) => on.input(reported(event.target as HTMLInputElement, s.locale), { interim: true })}
            @change=${leave.change}
            @blur=${leave.blur}
            @focus=${leave.focus}
          />`
        )
      );
    },
    // The text is written here, not bound: the box keeps what was typed while it stands for the stored number.
    after(field, s) {
      const box = field.querySelector<HTMLInputElement>("input.form-control");
      if (box && box.value !== s.value && !standsFor(box, s.value, s.locale)) {
        box.value = s.value;
      }
    }
  };

  // ── Select ─────────────────────────────────────────────────────────────────────────────────

  const select: FieldAdapter<SelectFieldState> = {
    kind: "field",
    name: "bootstrap-select",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn", placeholder: "drawn" },
    template(s, on) {
      const invalid = s.errors.length > 0;
      return html`<div class="mb-3">
        ${label(s)}
        <select
          class=${cls("form-select", invalid && "is-invalid")}
          id=${s.id}
          name=${s.name}
          aria-describedby=${ifDefined(describedByOf(s.describedBy))}
          aria-invalid=${flag(s.invalid)}
          ?required=${s.required}
          ?disabled=${s.disabled}
          @change=${(event: Event) => {
            on.input((event.target as HTMLSelectElement).value);
            on.commit();
          }}
        >
          <option value="" .selected=${live(s.value === "")}>${s.emptyLabel}</option>
          ${s.options.map((option) => html`<option value=${option.value} .selected=${live(option.checked)}>${option.label}</option>`)}
        </select>
        ${error(s)}${hint(s)}${workedOut(s)}${notices(s)}
      </div>`;
    }
    // Read-only: the renderer's guard stops the popup and the keys, and marks the select aria-readonly.
  };

  // ── Radios and checkboxes ──────────────────────────────────────────────────────────────────

  /** An option's help, form text inside its `form-check` under the label (named by the control's `aria-describedby`). */
  const optionHint = (option: ChoiceOption): View =>
    option.hint !== undefined && option.hintId !== undefined ? html`<div id=${option.hintId} class="form-text mt-0">${option.hint}</div>` : nothing;

  /**
   * The fieldset a choice group draws: legend, hint, the items, notices. While read-only the
   * renderer gives a radio group the `radiogroup` role. The error is the last item's, as
   * Bootstrap's validation examples write it: `invalid-feedback` after the last `is-invalid` input.
   */
  const choiceGroup = (s: FieldState, items: readonly View[], eachRequired = false): TemplateResult =>
    html`<fieldset class="mb-3" aria-describedby=${ifDefined(describedByOf(s.describedBy))}>
      ${legend(s, !eachRequired)}${hint(s)}${workedOut(s)}${items.length > 0 ? items : error(s, true)}${notices(s)}
    </fieldset>`;

  const radio: FieldAdapter<RadioFieldState> = {
    kind: "field",
    name: "bootstrap-radios",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      const invalid = s.errors.length > 0;
      return choiceGroup(
        s,
        s.options.map(
          (option, at) => html`<div class="form-check">
            <input
              class=${cls("form-check-input", invalid && "is-invalid")}
              id=${option.id}
              name=${s.name}
              type="radio"
              value=${option.value}
              .checked=${live(option.checked)}
              aria-describedby=${ifDefined(option.hint !== undefined ? option.hintId : undefined)}
              ?required=${s.required}
              ?disabled=${s.disabled}
              @change=${(event: Event) => {
                if ((event.target as HTMLInputElement).checked) {
                  on.input(option.value);
                  on.commit();
                }
              }}
            />
            <label class="form-check-label" for=${option.id}>${option.label}</label>
            ${optionHint(option)}${at === s.options.length - 1 ? error(s) : nothing}
          </div>`
        ),
        // Each radio carries `required`, as Bootstrap's validation page writes it, so the legend's mark is hidden.
        true
      );
    },
    // The checked radio, else the first: where a summary link to a group lands (one selector list would return the first in tree order).
    focusTarget: (field) => field.querySelector<HTMLElement>("input.form-check-input:checked") ?? field.querySelector<HTMLElement>("input.form-check-input")
  };

  const checkboxes: FieldAdapter<CheckboxesFieldState> = {
    kind: "field",
    name: "bootstrap-checkboxes",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      const invalid = s.errors.length > 0;
      return choiceGroup(
        s,
        s.options.map(
          (option, at) => html`<div class="form-check">
            <input
              class=${cls("form-check-input", invalid && "is-invalid")}
              id=${option.id}
              name=${s.name}
              type="checkbox"
              value=${option.value}
              .checked=${live(option.checked)}
              aria-describedby=${ifDefined(option.hint !== undefined ? option.hintId : undefined)}
              ?disabled=${s.disabled}
              @change=${(event: Event) => {
                // The values chosen, read from the boxes as they stand: one change may follow another before a draw.
                const group = (event.target as HTMLInputElement).closest("fieldset");
                const boxes = Array.from(group?.querySelectorAll<HTMLInputElement>("input.form-check-input") ?? []);
                on.input(boxes.filter((box) => box.checked).map((box) => box.value));
                on.commit();
              }}
            />
            <label class="form-check-label" for=${option.id}>${option.label}</label>
            ${optionHint(option)}${at === s.options.length - 1 ? error(s) : nothing}
          </div>`
        )
      );
    }
  };

  /** A lone checkbox: one `form-check`, the label the option's words. */
  const checkbox: FieldAdapter<CheckboxFieldState> = {
    kind: "field",
    name: "bootstrap-checkbox",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      const invalid = s.errors.length > 0;
      return html`<div class="mb-3">
        <div class="form-check">
          <input
            class=${cls("form-check-input", invalid && "is-invalid")}
            id=${s.id}
            name=${s.name}
            type="checkbox"
            .checked=${live(s.checked)}
            aria-describedby=${ifDefined(describedByOf(s.describedBy))}
            aria-invalid=${flag(s.invalid)}
            ?required=${s.required}
            ?disabled=${s.disabled}
            @change=${(event: Event) => {
              on.input((event.target as HTMLInputElement).checked);
              on.commit();
            }}
          />
          <label class=${cls("form-check-label", s.hideLabel && "visually-hidden")} for=${s.id}>${s.label}${requiredMark(s)}</label>
          ${hint(s)}${workedOut(s)}${error(s)}${notices(s)}
        </div>
      </div>`;
    }
  };

  // ── Date: Bootstrap has none, so day, month and year are its form controls in its grid ─────

  type Part = keyof DateParts;
  const PARTS = ["day", "month", "year"] as const satisfies readonly Part[];
  const PART_WORD = { day: "dateDay", month: "dateMonth", year: "dateYear" } as const;
  const PART_COLUMN = { day: "col-3", month: "col-3", year: "col-4" } as const;

  const readParts = (group: Element | null): DateParts => {
    const read = (part: Part): string => group?.querySelector<HTMLInputElement>(`[data-value-part="${part}"]`)?.value ?? "";
    return { year: read("year"), month: read("month"), day: read("day") };
  };

  const date: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "bootstrap-date",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      const invalid = s.errors.length > 0;
      const report = (event: Event, interim: boolean): void => {
        on.parts(readParts((event.currentTarget as Element).closest(".row")), interim ? { interim: true } : undefined);
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
      const box = (part: Part): View => html`<div class=${PART_COLUMN[part]}>
        <label class="form-label" for="${s.id}__${part}">${s.words(PART_WORD[part])}</label>
        <input
          class=${cls("form-control", marked(part) && "is-invalid")}
          id="${s.id}__${part}"
          name="${s.name}-${part}"
          type="text"
          data-value-part=${part}
          inputmode="numeric"
          pattern="[0-9]*"
          autocomplete="off"
          .value=${live(s.parts[part])}
          ?disabled=${s.disabled}
          ?readonly=${s.readOnly}
          @input=${(event: Event) => report(event, true)}
          @change=${(event: Event) => report(event, false)}
        />
      </div>`;
      return html`<fieldset class="mb-3" aria-describedby=${ifDefined(describedByOf(s.describedBy))}>
        ${legend(s)}
        <div class="row g-2" id=${s.id} @focusout=${left}>${PARTS.map(box)}</div>
        ${error(s, true)}${hint(s)}${workedOut(s)}${notices(s)}
      </fieldset>`;
    },
    // The first box the date still lacks, in the order the boxes stand (day, month, year): where a summary link to a date lands.
    focusTarget: (field, s) => datumDate?.focusTarget?.(field, s) ?? field.querySelector<HTMLElement>('[data-value-part="day"]')
  };

  // ── Button ─────────────────────────────────────────────────────────────────────────────────

  /** Bootstrap's contextual buttons by the name Datum gives the variant; anything else is the primary button. */
  const VARIANTS = new Set(["primary", "secondary", "success", "danger", "warning", "info", "light", "dark", "link"]);
  const buttonVariant = (variant: string | undefined): string => `btn-${variant !== undefined && VARIANTS.has(variant) ? variant : "primary"}`;

  const button: FieldAdapter<FieldState> = {
    kind: "field",
    name: "bootstrap-button",
    capabilities: {},
    template(s) {
      const given = s as Partial<ButtonFieldState>;
      const model = s.model;
      const variant = given.variant ?? model.buttonVariant;
      const action = given.action ?? model.buttonAction;
      const size = given.size ?? model.buttonSize;
      const working = action !== undefined && (s.busy === "submitting" || s.busy === "navigating");
      // A press is the renderer's (`data-button-action`, heard as `datum-form-action`). Busy is aria-disabled with Bootstrap's `disabled` look, never `disabled`: the button keeps its focus.
      return html`<button
        type="button"
        class=${cls("btn", buttonVariant(variant), size === "lg" && "btn-lg", size === "sm" && "btn-sm", working && "disabled")}
        data-button-action=${ifDefined(action)}
        data-button-signature=${ifDefined(model.buttonSignature)}
        ?disabled=${s.disabled || s.readOnly}
        aria-disabled=${working ? "true" : nothing}
      >${s.label}</button>`;
    }
  };

  return { text, textarea, number, select, radio, checkboxes, checkbox, date, button };
}
