/**
 * The U.S. Web Design System's leaf components as adapters for the engine contract: text field,
 * textarea, number, select, radios, checkboxes, a single checkbox, memorable date and button.
 *
 * Markup is what USWDS's own templates write (node_modules/uswds-3.14.0/packages/usa-<name>/src/*.twig
 * and packages/templates/usa-address-form.twig, the form USWDS itself builds from them). USWDS
 * ships its behaviour as one script that starts itself on `document.body`; a form in a shadow root
 * is out of its reach, so every component here is drawn as its no-JavaScript
 * baseline, or as its script leaves it where the renderer owns that behaviour (the character
 * count). Datum owns the answer, the checks, the words, focus, the read-only guards and the state
 * hooks. So an adapter here:
 *
 * - draws every id the state names (hint, error, notice, count limit) and writes
 *   `aria-describedby` from `state.describedBy`, never assembling an IDREF of its own;
 * - marks the REQUIRED fields with USWDS's asterisk (`abbr.usa-hint--required`, the form's
 *   `required` word) and sets `required`, as USWDS's address form does; `aria-invalid` says an
 *   error is shown;
 * - reports typed values (`on.input`, interim while typing), settled ones and leaving a field
 *   (`on.commit`), and never writes a read-only state as `disabled`.
 *
 * Warnings and info (`state.notices`) are never drawn as errors: a slim `usa-alert--warning` /
 * `usa-alert--info`, the severity word read first. Tooltip and pending are `degraded`: the
 * renderer folds the help and the "Checking this answer" word into the hint (USWDS's tooltip is
 * drawn by its script).
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

/** The first control of a field, for a summary link: USWDS's guidance links an error to the control. */
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

  /** USWDS's asterisk, `abbr[title=required]` (usa-address-form.twig), the form's `required` word. */
  const requiredMark = (s: Pick<FieldState, "required" | "words">): View => {
    const mark = s.required ? s.words("required") : "";
    return mark === "" ? nothing : html` <abbr title=${s.words("requiredTitle")} class="usa-hint usa-hint--required">${mark}</abbr>`;
  };

  const label = (s: FieldState, invalid: boolean): View =>
    html`<label class=${cls("usa-label", invalid && "usa-label--error", s.hideLabel && "usa-sr-only")} for=${s.id}>${s.label}${requiredMark(s)}</label>`;

  const legend = (s: FieldState): View =>
    html`<legend id=${s.labelId} class=${cls("usa-legend", s.hideLabel && "usa-sr-only")}>${s.label}${requiredMark(s)}</legend>`;

  const hint = (s: FieldState): View =>
    s.hint !== undefined && s.hint !== "" ? html`<span id=${ifDefined(s.hintId)} class="usa-hint">${s.hint}</span>` : nothing;

  /** usa-error-message with the `role="alert"` USWDS's templates give it (usa-input.twig, the form patterns). */
  const error = (s: FieldState): View =>
    s.errors.length === 0 || s.errorId === undefined ? nothing : html`<span id=${s.errorId} class="usa-error-message" role="alert">${s.errors.join("; ")}</span>`;

  /**
   * Warnings and info, in USWDS's own slim alerts and never in its error styling. Both sit under
   * the id the control is described by; neither is announced as an error: no role.
   */
  const notices = (s: FieldState): View =>
    s.notices.length === 0 || s.noticeId === undefined
      ? nothing
      : html`<div id=${s.noticeId} class="datum-usa-notices" data-notices>${s.notices.map(
          (notice) => html`<div class=${`usa-alert usa-alert--${notice.severity} usa-alert--slim`} data-severity=${notice.severity}><div class="usa-alert__body"><p class="usa-alert__text"><span class="usa-sr-only">${s.words(notice.severity === "warning" ? "noticeWarning" : "noticeInfo")}</span>${notice.message}</p></div></div>`
        )}</div>`;

  /**
   * usa-character-count as its script leaves it: the limit sentence visually hidden (it is the
   * field's description, under the id the state names), the status shown and hidden from screen
   * readers since it changes on every keystroke. The renderer counts and announces, so the script's
   * own live status is not drawn.
   */
  const count = (c: CharacterCount | undefined): View =>
    c === undefined
      ? nothing
      : html`<span id=${c.limitId} class="usa-character-count__message usa-sr-only">${c.limit}</span><div class=${cls("usa-character-count__status", "usa-hint", c.over && "usa-character-count__status--invalid")} aria-hidden="true" data-count-status>${c.status}</div>`;

  /** An error is shown, or the count is past its limit (USWDS's script styles that as an error as it is typed). */
  const invalidOf = (s: TextFieldState): boolean => s.errors.length > 0 || s.characterCount?.over === true;

  const groupClass = (invalid: boolean): string => cls("usa-form-group", invalid && "usa-form-group--error");

  /** What a text box and a textarea share: label, hint, error, the box, notices, the count. */
  const textField = (s: TextFieldState, control: View): TemplateResult => {
    const invalid = invalidOf(s);
    const group = html`<div class=${groupClass(invalid)}>${label(s, invalid)}${hint(s)}${error(s)}${control}${notices(s)}</div>`;
    return s.characterCount === undefined ? group : html`<div class="usa-character-count">${group}${count(s.characterCount)}</div>`;
  };

  const spellcheck = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : String(value));
  const flag = (on: boolean): "true" | typeof nothing => (on ? "true" : nothing);

  /** A box's affixes, as usa-input-group holds them. */
  const affixed = (s: TextFieldState, input: View): View =>
    s.prefix !== undefined || s.suffix !== undefined
      ? html`<div class=${cls("usa-input-group", invalidOf(s) && "usa-input-group--error")}>${s.prefix !== undefined ? html`<div class="usa-input-prefix" aria-hidden="true">${s.prefix}</div>` : nothing}${input}${s.suffix !== undefined ? html`<div class="usa-input-suffix" aria-hidden="true">${s.suffix}</div>` : nothing}</div>`
      : input;

  /** A box inside an input group carries no error border of its own: the group draws it. */
  const boxClass = (s: TextFieldState, base: string): string =>
    cls(base, s.characterCount !== undefined && "usa-character-count__field", invalidOf(s) && s.prefix === undefined && s.suffix === undefined && "usa-input--error");

  // ── Text ───────────────────────────────────────────────────────────────────────────────────

  const text: FieldAdapter<TextFieldState> = {
    kind: "field",
    name: "uswds-text",
    // USWDS's alert, input group and character-count markup are drawn as the DS writes them; its tooltip is a script's.
    // The count is drawn as USWDS's script leaves it, with the renderer counting and announcing (`countsCharacters: "renderer"`).
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", prefix: "drawn", suffix: "drawn", characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      return textField(
        s,
        affixed(
          s,
          html`<input
            class=${boxClass(s, "usa-input")}
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
    name: "uswds-textarea",
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      return textField(
        s,
        html`<textarea
          class=${boxClass(s, "usa-textarea")}
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
        ></textarea>`
      );
    }
  };

  // ── Number ─────────────────────────────────────────────────────────────────────────────────
  // USWDS's guidance: a text input with a numeric keyboard (`inputmode`), never type="number".

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
    name: "uswds-number",
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", prefix: "drawn", suffix: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      const whole = typeof s.step === "number" && Number.isInteger(s.step) && s.step > 0;
      return textField(
        s,
        affixed(
          s,
          html`<input
            class=${boxClass(s, "usa-input")}
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
      const box = field.querySelector<HTMLInputElement>("input.usa-input");
      if (box && box.value !== s.value && !standsFor(box, s.value, s.locale)) {
        box.value = s.value;
      }
    }
  };

  // ── Select ─────────────────────────────────────────────────────────────────────────────────

  const select: FieldAdapter<SelectFieldState> = {
    kind: "field",
    name: "uswds-select",
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn", placeholder: "drawn" },
    template(s, on) {
      const invalid = s.errors.length > 0;
      return html`<div class=${groupClass(invalid)}>
        ${label(s, invalid)}${hint(s)}${error(s)}
        <select
          class=${cls("usa-select", invalid && "usa-input--error")}
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
        ${notices(s)}
      </div>`;
    }
    // Read-only: the renderer's guard stops the popup and the keys, and marks the select aria-readonly.
  };

  // ── Radios and checkboxes ──────────────────────────────────────────────────────────────────

  /** An option's help, inside its label as USWDS writes `usa-radio__label-description`. */
  const optionHint = (option: ChoiceOption, kind: "radio" | "checkbox"): View =>
    option.hint !== undefined && option.hintId !== undefined ? html`<span id=${option.hintId} class=${`usa-${kind}__label-description`}>${option.hint}</span>` : nothing;

  /** The fieldset a choice group draws: legend, hint, error, the items, notices. While read-only the renderer gives a radio group the `radiogroup` role. */
  const choiceGroup = (s: FieldState, items: View): TemplateResult => {
    const invalid = s.errors.length > 0;
    return html`<div class=${groupClass(invalid)}>
      <fieldset class="usa-fieldset" aria-describedby=${ifDefined(describedByOf(s.describedBy))}>
        ${legend(s)}${hint(s)}${error(s)}${items}${notices(s)}
      </fieldset>
    </div>`;
  };

  const radio: FieldAdapter<RadioFieldState> = {
    kind: "field",
    name: "uswds-radios",
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      return choiceGroup(
        s,
        html`${s.options.map(
          (option) => html`<div class="usa-radio">
            <input
              class="usa-radio__input"
              id=${option.id}
              name=${s.name}
              type="radio"
              value=${option.value}
              .checked=${live(option.checked)}
              ?disabled=${s.disabled}
              @change=${(event: Event) => {
                if ((event.target as HTMLInputElement).checked) {
                  on.input(option.value);
                  on.commit();
                }
              }}
            />
            <label class="usa-radio__label" for=${option.id}>${option.label}${optionHint(option, "radio")}</label>
          </div>`
        )}`
      );
    },
    // The checked radio, else the first: where a summary link to a group lands. (One selector list would
    // match the first radio in tree order whichever is checked.)
    focusTarget: (field) => field.querySelector<HTMLElement>("input.usa-radio__input:checked") ?? field.querySelector<HTMLElement>("input.usa-radio__input")
  };

  const checkboxes: FieldAdapter<CheckboxesFieldState> = {
    kind: "field",
    name: "uswds-checkboxes",
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      return choiceGroup(
        s,
        html`${s.options.map(
          (option) => html`<div class="usa-checkbox">
            <input
              class="usa-checkbox__input"
              id=${option.id}
              name=${s.name}
              type="checkbox"
              value=${option.value}
              .checked=${live(option.checked)}
              ?disabled=${s.disabled}
              @change=${(event: Event) => {
                // The values chosen, read from the boxes as they stand: one change may follow another before a draw.
                const group = (event.target as HTMLInputElement).closest("fieldset");
                const boxes = Array.from(group?.querySelectorAll<HTMLInputElement>("input.usa-checkbox__input") ?? []);
                on.input(boxes.filter((box) => box.checked).map((box) => box.value));
                on.commit();
              }}
            />
            <label class="usa-checkbox__label" for=${option.id}>${option.label}${optionHint(option, "checkbox")}</label>
          </div>`
        )}`
      );
    }
  };

  /** A lone checkbox: one usa-checkbox, the label the option's words. */
  const checkbox: FieldAdapter<CheckboxFieldState> = {
    kind: "field",
    name: "uswds-checkbox",
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      const invalid = s.errors.length > 0;
      return html`<div class=${groupClass(invalid)}>
        ${error(s)}
        <div class="usa-checkbox">
          <input
            class="usa-checkbox__input"
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
          <label class=${cls("usa-checkbox__label", s.hideLabel && "usa-sr-only")} for=${s.id}>${s.label}${requiredMark(s)}${s.hint !== undefined && s.hint !== "" ? html`<span id=${ifDefined(s.hintId)} class="usa-checkbox__label-description">${s.hint}</span>` : nothing}</label>
        </div>
        ${notices(s)}
      </div>`;
    }
  };

  // ── Date: usa-memorable-date, month as a select, then day and year ──────────────────────────

  type Part = keyof DateParts;
  const PARTS = ["month", "day", "year"] as const satisfies readonly Part[];
  const PART_WORD = { month: "dateMonth", day: "dateDay", year: "dateYear" } as const;
  const PART_HINT = { month: "dateMonthHint", day: "dateDayHint", year: "dateYearHint" } as const;

  /** The months' names in the form's locale, as the platform words them (USWDS's lists are these: "January", "enero"). */
  const monthNames = (locale: string): string[] => {
    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
    } catch {
      format = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });
    }
    return Array.from({ length: 12 }, (_, index) => format.format(new Date(Date.UTC(2000, index, 1))));
  };

  const readParts = (group: Element | null): DateParts => {
    const read = (part: Part): string => group?.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-value-part="${part}"]`)?.value ?? "";
    return { year: read("year"), month: read("month"), day: read("day") };
  };

  const date: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "uswds-date",
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      const invalid = s.errors.length > 0;
      const report = (event: Event, interim: boolean): void => {
        on.parts(readParts((event.currentTarget as Element).closest(".usa-memorable-date")), interim ? { interim: true } : undefined);
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
      // The select's options are 1 to 12, unpadded, as USWDS writes them; the stored month may be padded.
      const month = s.parts.month === "" ? "" : String(Number(s.parts.month) || s.parts.month);
      const partHint = (part: Part): View => html`<span class="usa-hint usa-sr-only" id="${s.id}-${part}-hint">${s.words(PART_HINT[part])}</span>`;
      const partLabel = (part: Part): View => html`<label class="usa-label" for="${s.id}__${part}">${s.words(PART_WORD[part])}</label>`;
      const monthBox = html`<div class="usa-form-group usa-form-group--month usa-form-group--select">
        ${partLabel("month")}${partHint("month")}
        <select
          class=${cls("usa-select", marked("month") && "usa-input--error")}
          id="${s.id}__month"
          name="${s.name}-month"
          data-value-part="month"
          aria-describedby="${s.id}-month-hint"
          ?disabled=${s.disabled}
          @change=${(event: Event) => report(event, false)}
        >
          <option value="" .selected=${live(month === "")}>${s.words("dateSelectMonth")}</option>
          ${monthNames(s.locale).map((name, index) => html`<option value=${String(index + 1)} .selected=${live(month === String(index + 1))}>${name}</option>`)}
        </select>
      </div>`;
      const box = (part: "day" | "year"): View => html`<div class=${`usa-form-group usa-form-group--${part}`}>
        ${partLabel(part)}${partHint(part)}
        <input
          class=${cls("usa-input", marked(part) && "usa-input--error")}
          id="${s.id}__${part}"
          name="${s.name}-${part}"
          data-value-part=${part}
          aria-describedby="${s.id}-${part}-hint"
          minlength=${ifDefined(part === "year" ? 4 : undefined)}
          pattern="[0-9]*"
          inputmode="numeric"
          .value=${live(s.parts[part])}
          ?disabled=${s.disabled}
          ?readonly=${s.readOnly}
          @input=${(event: Event) => report(event, true)}
          @change=${(event: Event) => report(event, false)}
        />
      </div>`;
      // usa-memorable-date's own instructions stand in when the author wrote no hint; each box carries its own, so they are hidden from screen readers.
      const hasHint = s.hint !== undefined && s.hint !== "";
      return html`<div class=${groupClass(invalid)}>
        <fieldset class="usa-fieldset" aria-describedby=${ifDefined(describedByOf(s.describedBy))}>
          ${legend(s)}${hasHint ? hint(s) : html`<span class="usa-hint" aria-hidden="true" id="${s.id}-hint">${s.words("dateHint")}</span>`}${error(s)}
          <div class="usa-memorable-date" id=${s.id} @focusout=${left}>${monthBox}${box("day")}${box("year")}</div>
          ${notices(s)}
        </fieldset>
      </div>`;
    },
    // The first box the date still lacks, in the order the boxes stand (month, day, year): where a summary link to a date lands.
    focusTarget: (field, s) => datumDate?.focusTarget?.(field, s) ?? field.querySelector<HTMLElement>('[data-value-part="month"]')
  };

  // ── Button ─────────────────────────────────────────────────────────────────────────────────

  /** Datum's variants in USWDS's: secondary is the outline button, danger USWDS's red `secondary`, dark and light its gray `base`. */
  const buttonVariant = (variant: string | undefined): string | false =>
    variant === "secondary" || variant === "light" ? "usa-button--outline" : variant === "danger" || variant === "warning" ? "usa-button--secondary" : variant === "dark" ? "usa-button--base" : false;

  const button: FieldAdapter<FieldState> = {
    kind: "field",
    name: "uswds-button",
    capabilities: {},
    template(s) {
      const given = s as Partial<ButtonFieldState>;
      const model = s.model;
      const variant = given.variant ?? model.buttonVariant;
      const action = given.action ?? model.buttonAction;
      const working = s.busy === "submitting" || s.busy === "navigating";
      // A press is the renderer's (`data-button-action`, heard as `datum-form-action`).
      return html`<button
        type="button"
        class=${cls("usa-button", buttonVariant(variant), (given.size ?? model.buttonSize) === "lg" && "usa-button--big")}
        data-button-action=${ifDefined(action)}
        data-button-signature=${ifDefined(model.buttonSignature)}
        ?disabled=${s.disabled || s.readOnly}
        aria-disabled=${action !== undefined && working ? "true" : nothing}
      >${s.label}</button>`;
    }
  };

  return { text, textarea, number, select, radio, checkboxes, checkbox, date, button };
}
