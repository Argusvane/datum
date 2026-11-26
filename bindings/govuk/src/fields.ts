/**
 * GOV.UK Frontend's leaf components as adapters for the engine contract: text field, textarea,
 * number, select, radios, checkboxes, a single checkbox, date input and button.
 *
 * Markup is what GOV.UK's own templates write before any script runs
 * (govuk-frontend/dist/govuk/components/<name>/template-*.html). Datum owns what GOV.UK leaves
 * to a service: the answer, the checks, the words (errors, the "(optional)" marker, the count),
 * focus, the read-only guards and the state hooks. So an adapter here:
 *
 * - draws every id the state names (hint, error, notice, count limit) and writes
 *   `aria-describedby` from `state.describedBy`, never assembling an IDREF of its own;
 * - reports typed values (`on.input`, interim while typing), settled ones and leaving a field
 *   (`on.commit`), and never writes a read-only state as `disabled` (the renderer's guards stop
 *   a read-only radio, checkbox or select; text-like controls take `readonly`);
 * - marks the OPTIONAL fields with the form's "(optional)" word and never the required ones, as
 *   GOV.UK does, and sets neither `required` nor `aria-required` (GOV.UK's templates have no such
 *   parameter) and no `aria-invalid` (the error message and its id carry the state);
 * - leaves GOV.UK's scripted behaviour to the renderer, drawing the markup the script would leave
 *   (character count, conditional reveal) rather than the `data-module` that starts it: those
 *   scripts look elements up through `document` and fail inside a shadow root (measured in headless Chrome).
 *   Only `govuk-button` is marked for the scoped start (`connect`, scripts.ts).
 *
 * Warnings and info (`state.notices`) are never drawn as errors: a warning is GOV.UK's warning
 * text, info its inset text. Tooltip and pending are `degraded`: the renderer folds the help and
 * the "Checking this answer" word into the hint (GOV.UK has no tooltip).
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

/** The first control of a field, for a summary link: GOV.UK links an error to the first control of the field. */
export function firstControl(field: HTMLElement): HTMLElement | null {
  return field.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea");
}

export function createFields(lit: Lit, datum: LiveBinding) {
  const { html, svg, live, ifDefined, nothing } = lit;
  /** Datum's date: its focus target is the first part box lacking, in the order the boxes stand. */
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

  /** GOV.UK marks the optional fields, never the required ones; joined to the label as one text, as its markup does. */
  const optionalMark = (s: FieldState): string => {
    if (s.required || s.disabled) {
      return "";
    }
    const word = s.words("optional");
    return word === "" ? "" : ` ${word}`;
  };

  const label = (s: FieldState): View =>
    html`<label class=${cls("govuk-label", s.hideLabel && "govuk-visually-hidden")} for=${s.id}>${s.label + optionalMark(s)}</label>`;

  const legend = (s: FieldState): View =>
    html`<legend id=${s.labelId} class=${cls("govuk-fieldset__legend", s.hideLabel && "govuk-visually-hidden")}>${s.label + optionalMark(s)}</legend>`;

  const hint = (s: FieldState, extra?: string): View =>
    s.hint !== undefined && s.hint !== "" ? html`<div id=${ifDefined(s.hintId)} class=${cls("govuk-hint", extra)}>${s.hint}</div>` : nothing;

  /** A journey page's line saying the value is worked out from other answers: a hint under the id `describedBy` names after the hint. */
  const workedOut = (s: FieldState): View =>
    s.workedOut !== undefined && s.workedOutId !== undefined ? html`<div id=${s.workedOutId} class="govuk-hint" data-worked-out>${s.workedOut}</div>` : nothing;

  /** govuk-error-message, its "Error:" read before the words. */
  const error = (s: FieldState): View =>
    s.errors.length === 0 || s.errorId === undefined
      ? nothing
      : html`<p id=${s.errorId} class="govuk-error-message">${s.words("errorPrefix") === "" ? nothing : html`<span class="govuk-visually-hidden">${s.words("errorPrefix")}</span> `}${s.errors.join("; ")}</p>`;

  /**
   * Warnings and info, in GOV.UK's own components and never in its error styling: a warning is
   * warning text (the "!" icon, the severity word read first), info is inset text. Both sit
   * under the id the control is described by; neither is announced as an error.
   */
  const notices = (s: FieldState): View =>
    s.notices.length === 0 || s.noticeId === undefined
      ? nothing
      : html`<div id=${s.noticeId} class="datum-govuk-notices" data-notices>${s.notices.map((notice) =>
          notice.severity === "warning"
            ? html`<div class="govuk-warning-text" data-severity="warning"><span class="govuk-warning-text__icon" aria-hidden="true">!</span><strong class="govuk-warning-text__text"><span class="govuk-visually-hidden">${s.words("noticeWarning")}</span>${notice.message}</strong></div>`
            : html`<div class="govuk-inset-text" data-severity="info"><span class="govuk-visually-hidden">${s.words("noticeInfo")}</span>${notice.message}</div>`
        )}</div>`;

  /**
   * govuk-character-count as its script leaves it: the limit sentence visually hidden (it is the
   * field's description, under the id the state names), the status shown and hidden from screen
   * readers since it changes on every keystroke. The renderer counts and announces.
   */
  const count = (c: CharacterCount | undefined): View =>
    c === undefined
      ? nothing
      : html`<div id=${c.limitId} class="govuk-hint govuk-character-count__message govuk-visually-hidden">${c.limit}</div>
          <div class=${cls("govuk-character-count__message", "govuk-character-count__status", c.over ? "govuk-error-message" : "govuk-hint")} aria-hidden="true" data-count-status>${c.status}</div>`;

  const groupClass = (s: FieldState, ...more: Array<string | false | undefined>): string => cls("govuk-form-group", s.errors.length > 0 && "govuk-form-group--error", ...more);

  /** What a text box and a textarea share: label, hint, error, the box, notices, the count. */
  const textField = (s: TextFieldState, control: View): TemplateResult =>
    html`<div class=${groupClass(s, s.characterCount !== undefined && "govuk-character-count")}>${label(s)}${hint(s)}${workedOut(s)}${error(s)}${control}${notices(s)}${count(s.characterCount)}</div>`;

  const spellcheck = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : String(value));

  /** A box's affixes, as govuk-input__wrapper holds them. */
  const affixed = (s: TextFieldState, input: View): View =>
    s.prefix !== undefined || s.suffix !== undefined
      ? html`<div class="govuk-input__wrapper">${s.prefix !== undefined ? html`<div class="govuk-input__prefix" aria-hidden="true">${s.prefix}</div>` : nothing}${input}${s.suffix !== undefined ? html`<div class="govuk-input__suffix" aria-hidden="true">${s.suffix}</div>` : nothing}</div>`
      : input;

  // ── Text ───────────────────────────────────────────────────────────────────────────────────

  const text: FieldAdapter<TextFieldState> = {
    kind: "field",
    name: "govuk-text",
    // No placeholder (GOV.UK advises against one). The count is GOV.UK's markup as its script leaves
    // it, with the renderer counting and announcing (`countsCharacters: "renderer"`): drawn, since the
    // renderer's announcer speaks only for a count the adapter answers `drawn`.
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", prefix: "drawn", suffix: "drawn", characterCount: "drawn", hideLabel: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      return textField(
        s,
        affixed(
          s,
          html`<input
            class=${cls("govuk-input", s.errors.length > 0 && "govuk-input--error")}
            id=${s.id}
            name=${s.name}
            type="text"
            .value=${live(s.value)}
            minlength=${ifDefined(s.minLength)}
            pattern=${ifDefined(s.pattern)}
            autocomplete=${ifDefined(s.autocomplete)}
            inputmode=${ifDefined(s.inputMode)}
            spellcheck=${ifDefined(spellcheck(s.spellcheck))}
            aria-describedby=${ifDefined(describedByOf(s.describedBy))}
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
    name: "govuk-textarea",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", characterCount: "drawn", hideLabel: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      return textField(
        s,
        html`<textarea
          class=${cls("govuk-textarea", s.errors.length > 0 && "govuk-textarea--error")}
          id=${s.id}
          name=${s.name}
          rows=${s.rows ?? 5}
          .value=${live(s.value)}
          minlength=${ifDefined(s.minLength)}
          autocomplete=${ifDefined(s.autocomplete)}
          spellcheck=${ifDefined(spellcheck(s.spellcheck))}
          aria-describedby=${ifDefined(describedByOf(s.describedBy))}
          ?disabled=${s.disabled}
          ?readonly=${s.readOnly}
          @input=${(event: Event) => on.input((event.target as HTMLTextAreaElement).value, { interim: true })}
          @change=${leave.change}
          @blur=${leave.blur}
          @focus=${leave.focus}
        ></textarea>`
      );
    }
  };

  // ── Number ─────────────────────────────────────────────────────────────────────────────────
  // GOV.UK's guidance: a text input with a numeric keyboard, never type="number".

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
    name: "govuk-number",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", prefix: "drawn", suffix: "drawn", hideLabel: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      const whole = typeof s.step === "number" && Number.isInteger(s.step) && s.step > 0;
      return textField(
        s,
        affixed(
          s,
          html`<input
            class=${cls("govuk-input", s.errors.length > 0 && "govuk-input--error")}
            id=${s.id}
            name=${s.name}
            type="text"
            inputmode=${s.inputMode ?? (whole ? "numeric" : "decimal")}
            spellcheck=${spellcheck(s.spellcheck) ?? "false"}
            autocomplete=${ifDefined(s.autocomplete)}
            aria-describedby=${ifDefined(describedByOf(s.describedBy))}
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
      const box = field.querySelector<HTMLInputElement>("input");
      if (box && box.value !== s.value && !standsFor(box, s.value, s.locale)) {
        box.value = s.value;
      }
    }
  };

  // ── Select ─────────────────────────────────────────────────────────────────────────────────

  const select: FieldAdapter<SelectFieldState> = {
    kind: "field",
    name: "govuk-select",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      return html`<div class=${groupClass(s)}>
        ${label(s)}${hint(s)}${workedOut(s)}${error(s)}
        <select
          class=${cls("govuk-select", s.errors.length > 0 && "govuk-select--error")}
          id=${s.id}
          name=${s.name}
          aria-describedby=${ifDefined(describedByOf(s.describedBy))}
          ?disabled=${s.disabled}
          @change=${(event: Event) => {
            on.input((event.target as HTMLSelectElement).value);
            on.commit();
          }}
        >
          <option value="" .selected=${live(s.value === "")}>${s.emptyLabel}</option>
          ${s.options.map((option) => html`<option value=${option.value} .selected=${live(option.checked)}>${option.label}</option>`)}
        </select>
        ${notices(s)}
      </div>`;
    },
    // Read-only: the renderer's guard stops the popup and the keys, and marks the select aria-readonly.
  };

  // ── Radios and checkboxes ──────────────────────────────────────────────────────────────────

  const optionHint = (option: ChoiceOption, kind: "radios" | "checkboxes"): View =>
    option.hint !== undefined && option.hintId !== undefined ? html`<div id=${option.hintId} class=${`govuk-hint govuk-${kind}__hint`}>${option.hint}</div>` : nothing;

  /**
   * The fieldset a choice group draws: legend, hint, error, the items, notices. A plain fieldset,
   * as GOV.UK's template has it: while a radio group is read-only the renderer gives it the
   * `radiogroup` role, which carries `aria-readonly`.
   */
  const choiceGroup = (s: FieldState, items: View): TemplateResult =>
    html`<div class=${groupClass(s)}>
      <fieldset class="govuk-fieldset" aria-describedby=${ifDefined(describedByOf(s.describedBy))}>
        ${legend(s)}${hint(s)}${workedOut(s)}${error(s)}${items}${notices(s)}
      </fieldset>
    </div>`;

  const radio: FieldAdapter<RadioFieldState> = {
    kind: "field",
    name: "govuk-radios",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      // The conditional reveal is Datum's rules (a dependent field is drawn after the group), so no data-module here.
      return choiceGroup(
        s,
        html`<div class="govuk-radios">
          ${s.options.map(
            (option) => html`<div class="govuk-radios__item">
              <input
                class="govuk-radios__input"
                id=${option.id}
                name=${s.name}
                type="radio"
                value=${option.value}
                .checked=${live(option.checked)}
                aria-describedby=${ifDefined(option.hint !== undefined ? option.hintId : undefined)}
                ?disabled=${s.disabled}
                @change=${(event: Event) => {
                  if ((event.target as HTMLInputElement).checked) {
                    on.input(option.value);
                    on.commit();
                  }
                }}
              />
              <label class="govuk-label govuk-radios__label" for=${option.id}>${option.label}</label>
              ${optionHint(option, "radios")}
            </div>`
          )}
        </div>`
      );
    }
  };

  const checkboxes: FieldAdapter<CheckboxesFieldState> = {
    kind: "field",
    name: "govuk-checkboxes",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      return choiceGroup(
        s,
        html`<div class="govuk-checkboxes">
          ${s.options.map(
            (option) => html`<div class="govuk-checkboxes__item">
              <input
                class="govuk-checkboxes__input"
                id=${option.id}
                name=${s.name}
                type="checkbox"
                value=${option.value}
                .checked=${live(option.checked)}
                aria-describedby=${ifDefined(option.hint !== undefined ? option.hintId : undefined)}
                ?disabled=${s.disabled}
                @change=${(event: Event) => {
                  // The values chosen, read from the boxes as they stand: one change may follow another before a draw.
                  const group = (event.target as HTMLInputElement).closest(".govuk-checkboxes");
                  const boxes = Array.from(group?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? []);
                  on.input(boxes.filter((box) => box.checked).map((box) => box.value));
                  on.commit();
                }}
              />
              <label class="govuk-label govuk-checkboxes__label" for=${option.id}>${option.label}</label>
              ${optionHint(option, "checkboxes")}
            </div>`
          )}
        </div>`
      );
    }
  };

  /** A lone checkbox: one item of govuk-checkboxes, the label the option's words, no "(optional)". */
  const checkbox: FieldAdapter<CheckboxFieldState> = {
    kind: "field",
    name: "govuk-checkbox",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      return html`<div class=${groupClass(s)}>
        ${error(s)}
        <div class="govuk-checkboxes">
          <div class="govuk-checkboxes__item">
            <input
              class="govuk-checkboxes__input"
              id=${s.id}
              name=${s.name}
              type="checkbox"
              .checked=${live(s.checked)}
              aria-describedby=${ifDefined(describedByOf(s.describedBy))}
              ?disabled=${s.disabled}
              @change=${(event: Event) => {
                on.input((event.target as HTMLInputElement).checked);
                on.commit();
              }}
            />
            <label class=${cls("govuk-label", "govuk-checkboxes__label", s.hideLabel && "govuk-visually-hidden")} for=${s.id}>${s.label}</label>
            ${hint(s, "govuk-checkboxes__hint")}${workedOut(s)}
          </div>
        </div>
        ${notices(s)}
      </div>`;
    }
  };

  // ── Date ───────────────────────────────────────────────────────────────────────────────────

  const PARTS = ["day", "month", "year"] as const;
  type Part = (typeof PARTS)[number];
  const WIDTH: Record<Part, string> = { day: "govuk-input--width-2", month: "govuk-input--width-2", year: "govuk-input--width-4" };
  const PART_WORD = { day: "dateDay", month: "dateMonth", year: "dateYear" } as const;

  const readParts = (group: Element | null): DateParts => {
    const read = (part: Part): string => group?.querySelector<HTMLInputElement>(`[data-value-part="${part}"]`)?.value ?? "";
    return { year: read("year"), month: read("month"), day: read("day") };
  };

  const date: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "govuk-date",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      const report = (event: Event, interim: boolean): void => {
        on.parts(readParts((event.currentTarget as Element).closest(".govuk-date-input")), interim ? { interim: true } : undefined);
      };
      // An invalid date marks the boxes that need work: those it lacks, else every box.
      const marked = (part: Part): boolean => s.errors.length > 0 && (s.missingParts.length === 0 || s.missingParts.includes(part));
      // The field is left only when focus goes out of the whole date: tabbing day to month checks nothing.
      const left = (event: FocusEvent): void => {
        const into = event.relatedTarget;
        if (!(into instanceof Node && (event.currentTarget as Element).contains(into))) {
          on.commit();
        }
      };
      const item = (part: Part): View => html`<div class="govuk-date-input__item">
        <div class="govuk-form-group">
          <label class="govuk-label govuk-date-input__label" for="${s.id}__${part}">${s.words(PART_WORD[part])}</label>
          <input
            class=${cls("govuk-input", "govuk-date-input__input", WIDTH[part], marked(part) && "govuk-input--error")}
            id="${s.id}__${part}"
            name="${s.name}-${part}"
            type="text"
            inputmode="numeric"
            data-value-part=${part}
            .value=${live(s.parts[part])}
            ?disabled=${s.disabled}
            ?readonly=${s.readOnly}
            @input=${(event: Event) => report(event, true)}
            @change=${(event: Event) => report(event, false)}
          />
        </div>
      </div>`;
      return html`<div class=${groupClass(s)}>
        <fieldset class="govuk-fieldset" role="group" aria-describedby=${ifDefined(describedByOf(s.describedBy))}>
          ${legend(s)}${hint(s)}${workedOut(s)}${error(s)}
          <div class="govuk-date-input" id=${s.id} @focusout=${left}>${PARTS.map(item)}</div>
          ${notices(s)}
        </fieldset>
      </div>`;
    },
    // The first box the date still lacks, else the day: where GOV.UK's summary link to a date lands. Datum's
    // own focus on part boxes, wrapped (the boxes are marked `data-value-part`, day first).
    focusTarget: (field, s) => datumDate?.focusTarget?.(field, s) ?? field.querySelector<HTMLElement>('[data-value-part="day"]')
  };

  // ── Button ─────────────────────────────────────────────────────────────────────────────────

  /** The start button's arrow, as GOV.UK's template draws it. */
  const startIcon = svg`<svg class="govuk-button__start-icon" xmlns="http://www.w3.org/2000/svg" width="17.5" height="19" viewBox="0 0 33 40" aria-hidden="true" focusable="false"><path fill="currentColor" d="M0 0h13l20 20-20 20H0l20-20z"/></svg>`;

  const buttonVariant = (variant: string | undefined): string | false =>
    variant === "secondary" ? "govuk-button--secondary" : variant === "danger" || variant === "warning" ? "govuk-button--warning" : variant === "light" ? "govuk-button--inverse" : variant === "start" ? "govuk-button--start" : false;

  const button: FieldAdapter<FieldState> = {
    kind: "field",
    name: "govuk-button",
    capabilities: {},
    template(s) {
      const given = s as Partial<ButtonFieldState>;
      const model = s.model;
      const variant = given.variant ?? model.buttonVariant;
      const action = given.action ?? model.buttonAction;
      const working = s.busy === "submitting" || s.busy === "navigating";
      // A press is the renderer's (`data-button-action`, heard as `datum-form-action`); GOV.UK's Button script is started on it by `connect`.
      return html`<button
        type="button"
        class=${cls("govuk-button", buttonVariant(variant))}
        data-module="govuk-button"
        data-button-action=${ifDefined(action)}
        data-button-signature=${ifDefined(model.buttonSignature)}
        ?disabled=${s.disabled || s.readOnly}
        aria-disabled=${action !== undefined && working ? "true" : nothing}
      >${s.label}${variant === "start" ? startIcon : nothing}</button>`;
    }
  };

  return { text, textarea, number, select, radio, checkboxes, checkbox, date, button };
}
