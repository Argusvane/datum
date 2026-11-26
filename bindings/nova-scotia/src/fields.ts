/**
 * The Nova Scotia UI Pattern Library's leaf components as adapters for the engine contract: text
 * field, textarea, number, select, radios, checkboxes, a single checkbox, date and button.
 *
 * Markup is what the library's own snippets write (nsgov/patternlibrary, forms/*.html and
 * buttons/*.html at commit 663c256): a `form-group` holding a `control-label`, a `form-control`,
 * and a `help-block` for the hint and for the error; the state is `has-error` / `has-warning` on the
 * group, with Font Awesome's glyph beside the control. The library ships no script, so there is
 * nothing to start and nothing to scope: every component is its plain HTML and CSS. It has no
 * date, so the date is three boxes in the library's own label and box markup.
 *
 * Datum owns the answer, the checks, the words, focus, the read-only guards and the state hooks.
 * So an adapter here:
 *
 * - draws every id the state names (hint, worked-out line, error, notice, count limit) and writes
 *   `aria-describedby` from `state.describedBy`, never assembling an IDREF of its own;
 * - marks the REQUIRED fields (the library marks neither; its Drupal forms mark the required ones)
 *   with an asterisk and `aria-required`, and the invalid ones with `aria-invalid`;
 * - reports typed values (`on.input`, interim while typing), settled ones and leaving a field
 *   (`on.commit`), and never writes a read-only state as `disabled`.
 *
 * Warnings and info (`state.notices`) are never drawn as errors: a warning is the library's
 * warning colour and `fa-exclamation-triangle` (forms/form-group-has-warning.html), info a
 * `help-block` with `fa-info-circle` (feedback/feedback-info.html); the severity word is read first.
 * Tooltip and pending are `degraded`: the renderer folds the help and the "Checking this answer"
 * word into the hint (the library has neither).
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
import { cls, describedByOf, spellcheckOf } from "./shared.js";

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

  /** The asterisk of a required field, the form's `required` word with its title. */
  const requiredMark = (s: Pick<FieldState, "required" | "words">): View => {
    const mark = s.required ? s.words("required") : "";
    return mark === "" ? nothing : html` <abbr title=${s.words("requiredTitle")} class="datum-ns-required">${mark}</abbr>`;
  };

  const label = (s: FieldState): View =>
    html`<label class=${cls("control-label", s.hideLabel && "sr-only")} for=${s.id}>${s.label}${requiredMark(s)}</label>`;

  /** A group of choices (or a date) is named by a legend drawn as the library's label. */
  const legend = (s: FieldState): View =>
    html`<legend id=${s.labelId} class=${cls("control-label", s.hideLabel && "sr-only")}>${s.label}${requiredMark(s)}</legend>`;

  const hint = (s: FieldState): View =>
    s.hint !== undefined && s.hint !== "" ? html`<div id=${ifDefined(s.hintId)} class="help-block">${s.hint}</div>` : nothing;

  /** A journey page's line saying the value is worked out from other answers: the library's help block, under the id `describedBy` names after the hint. */
  const workedOut = (s: FieldState): View =>
    s.workedOut !== undefined && s.workedOutId !== undefined ? html`<div id=${s.workedOutId} class="help-block" data-worked-out>${s.workedOut}</div>` : nothing;

  const hiddenPrefix = (s: FieldState): View => {
    const prefix = s.words("errorPrefix");
    return prefix === "" ? nothing : html`<span class="sr-only">${prefix} </span>`;
  };

  /** The library's error: a help block under the control (the group carries `has-error`). */
  const error = (s: FieldState): View =>
    s.errors.length === 0 || s.errorId === undefined ? nothing : html`<div id=${s.errorId} class="help-block">${hiddenPrefix(s)}${s.errors.join("; ")}</div>`;

  /** The same message in a group of choices: the glyph the library puts beside a control goes in front of the words. */
  const choiceError = (s: FieldState): View =>
    s.errors.length === 0 || s.errorId === undefined
      ? nothing
      : html`<div id=${s.errorId} class="help-block datum-ns-choice-error"><i class="fa fa-exclamation-circle" aria-hidden="true"></i>${hiddenPrefix(s)}${s.errors.join("; ")}</div>`;

  const warned = (s: FieldState): boolean => s.errors.length === 0 && s.notices.some((notice) => notice.severity === "warning");

  /** The glyph beside a control: the library draws one for an error and for a warning. */
  const glyph = (s: FieldState): View =>
    s.errors.length > 0
      ? html` <i class="fa fa-exclamation-circle" aria-hidden="true"></i>`
      : warned(s)
        ? html` <i class="fa fa-exclamation-triangle" aria-hidden="true"></i>`
        : nothing;

  /**
   * Warnings and info, in the library's own pieces and never in its error styling: a warning is its
   * warning colour and glyph, info a help block with the info glyph. Both sit under the id the
   * control is described by; neither is announced as an alert, neither marks the field invalid.
   */
  const notices = (s: FieldState): View =>
    s.notices.length === 0 || s.noticeId === undefined
      ? nothing
      : html`<div id=${s.noticeId} data-notices>${s.notices.map(
          (notice) => html`<div class=${cls("help-block", "datum-ns-notice", `datum-ns-notice--${notice.severity}`)} data-severity=${notice.severity}><i class=${notice.severity === "warning" ? "fa fa-exclamation-triangle" : "fa fa-info-circle"} aria-hidden="true"></i><span class="sr-only">${s.words(notice.severity === "warning" ? "noticeWarning" : "noticeInfo")}</span>${notice.message}</div>`
        )}</div>`;

  /**
   * A count as the renderer reports it: the limit sentence read to assistive technology (it is the
   * field's description, under the id the state names), the status shown and hidden from screen
   * readers since it changes on every keystroke. The renderer counts and announces.
   */
  const count = (c: CharacterCount | undefined): View =>
    c === undefined
      ? nothing
      : html`<div id=${c.limitId} class="sr-only">${c.limit}</div><div class=${cls("help-block", c.over && "datum-ns-count--over")} aria-hidden="true" data-count-status>${c.status}</div>`;

  const groupClass = (s: FieldState, ...more: Array<string | false | undefined>): string =>
    cls("form-group", s.errors.length > 0 ? "has-error" : warned(s) && "has-warning", ...more);

  const flag = (on: boolean): "true" | typeof nothing => (on ? "true" : nothing);

  /** What a text box and a textarea share: the label, the box and its glyph, then hint, worked-out line, notices, count, error. */
  const textField = (s: TextFieldState, control: View): TemplateResult =>
    html`<div class=${groupClass(s)}>${label(s)}${control}${glyph(s)}${hint(s)}${workedOut(s)}${error(s)}${notices(s)}${count(s.characterCount)}</div>`;

  /** A box's affixes, as Bootstrap's input group holds them. */
  const affixed = (s: TextFieldState, input: View): View =>
    s.prefix !== undefined || s.suffix !== undefined
      ? html`<div class="input-group">${s.prefix !== undefined ? html`<span class="input-group-addon" aria-hidden="true">${s.prefix}</span>` : nothing}${input}${s.suffix !== undefined ? html`<span class="input-group-addon" aria-hidden="true">${s.suffix}</span>` : nothing}</div>`
      : input;

  // ── Text ───────────────────────────────────────────────────────────────────────────────────

  const text: FieldAdapter<TextFieldState> = {
    kind: "field",
    name: "nova-scotia-text",
    // The library's input group, help block, warning colour and glyphs draw these; it has no tooltip or loading pattern.
    // The count is a help block with the renderer counting and announcing (`countsCharacters: "renderer"`).
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", prefix: "drawn", suffix: "drawn", characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      return textField(
        s,
        affixed(
          s,
          html`<input
            class="form-control"
            id=${s.id}
            name=${s.name}
            type="text"
            .value=${live(s.value)}
            placeholder=${ifDefined(s.placeholder)}
            minlength=${ifDefined(s.minLength)}
            pattern=${ifDefined(s.pattern)}
            autocomplete=${ifDefined(s.autocomplete)}
            inputmode=${ifDefined(s.inputMode)}
            spellcheck=${ifDefined(spellcheckOf(s.spellcheck))}
            aria-describedby=${ifDefined(describedByOf(s.describedBy))}
            aria-required=${flag(s.required)}
            aria-invalid=${flag(s.invalid)}
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
    name: "nova-scotia-textarea",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      return textField(
        s,
        html`<textarea
          class="form-control"
          id=${s.id}
          name=${s.name}
          rows=${s.rows ?? 5}
          cols="60"
          .value=${live(s.value)}
          placeholder=${ifDefined(s.placeholder)}
          minlength=${ifDefined(s.minLength)}
          autocomplete=${ifDefined(s.autocomplete)}
          spellcheck=${ifDefined(spellcheckOf(s.spellcheck))}
          aria-describedby=${ifDefined(describedByOf(s.describedBy))}
          aria-required=${flag(s.required)}
          aria-invalid=${flag(s.invalid)}
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
  // The library's number field is a type="number" box (forms/form-input-number.html).

  /** A number box already parses for us: a float is reported as a number, empty (cleared, or holding text the browser cannot read) as "" and flagged `badInput`. */
  const reported = (input: HTMLInputElement): { value: number | string; badInput?: boolean } => {
    if (input.validity?.badInput === true) {
      return { value: "", badInput: true };
    }
    return { value: input.value === "" ? "" : Number(input.value) };
  };

  const number: FieldAdapter<NumberFieldState> = {
    kind: "field",
    name: "nova-scotia-number",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", prefix: "drawn", suffix: "drawn", hideLabel: "drawn", placeholder: "drawn" },
    template(s, on) {
      const leave = leaving(on);
      return textField(
        s,
        affixed(
          s,
          html`<input
            class="form-control"
            id=${s.id}
            name=${s.name}
            type="number"
            placeholder=${ifDefined(s.placeholder)}
            min=${ifDefined(s.min)}
            max=${ifDefined(s.max)}
            step=${ifDefined(s.step)}
            autocomplete=${ifDefined(s.autocomplete)}
            inputmode=${ifDefined(s.inputMode)}
            spellcheck=${ifDefined(spellcheckOf(s.spellcheck))}
            aria-describedby=${ifDefined(describedByOf(s.describedBy))}
            aria-required=${flag(s.required)}
            aria-invalid=${flag(s.invalid)}
            ?disabled=${s.disabled}
            ?readonly=${s.readOnly}
            @input=${(event: Event) => {
              const { value, badInput } = reported(event.target as HTMLInputElement);
              on.input(value, { interim: true, ...(badInput ? { badInput: true } : {}) });
            }}
            @change=${leave.change}
            @blur=${leave.blur}
            @focus=${leave.focus}
          />`
        )
      );
    },
    // The text is written here, not bound: Chrome redraws a number box from its number when the value is written, which drops the "." or "-" typed on the way to "12.5". The value is set only when the box does not already stand for the stored number.
    after(field, s) {
      const box = field.querySelector<HTMLInputElement>("input");
      if (box && box.value !== s.value && !(s.value !== "" && box.value.trim() !== "" && Number(box.value) === Number(s.value))) {
        box.value = s.value;
      }
    }
  };

  // ── Select ─────────────────────────────────────────────────────────────────────────────────

  const select: FieldAdapter<SelectFieldState> = {
    kind: "field",
    name: "nova-scotia-select",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      return html`<div class=${groupClass(s)}>
        ${label(s)}<select
          class="form-control"
          id=${s.id}
          name=${s.name}
          aria-describedby=${ifDefined(describedByOf(s.describedBy))}
          aria-required=${flag(s.required)}
          aria-invalid=${flag(s.invalid)}
          ?disabled=${s.disabled}
          @change=${(event: Event) => {
            on.input((event.target as HTMLSelectElement).value);
            on.commit();
          }}
        >
          <option value="" .selected=${live(s.value === "")}>${s.emptyLabel}</option>
          ${s.options.map((option) => html`<option value=${option.value} .selected=${live(option.checked)}>${option.label}</option>`)}
        </select>${glyph(s)}${hint(s)}${workedOut(s)}${error(s)}${notices(s)}
      </div>`;
    }
    // Read-only: the renderer's guard stops the popup and the keys, and marks the select aria-readonly.
  };

  // ── Radios and checkboxes ──────────────────────────────────────────────────────────────────

  const optionHint = (option: ChoiceOption): View =>
    option.hint !== undefined && option.hintId !== undefined ? html`<div id=${option.hintId} class="help-block">${option.hint}</div>` : nothing;

  /**
   * The fieldset a choice group draws: legend, hint, worked-out line, error, the items, notices. A
   * plain fieldset: while a radio group is read-only the renderer gives it the `radiogroup` role,
   * which carries `aria-readonly`.
   */
  const choiceGroup = (s: FieldState, items: View): TemplateResult =>
    html`<fieldset class=${groupClass(s)} aria-describedby=${ifDefined(describedByOf(s.describedBy))}>
      ${legend(s)}${hint(s)}${workedOut(s)}${choiceError(s)}${items}${notices(s)}
    </fieldset>`;

  const radio: FieldAdapter<RadioFieldState> = {
    kind: "field",
    name: "nova-scotia-radios",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      // The conditional reveal is Datum's rules (a dependent field is drawn after the group).
      return choiceGroup(
        s,
        html`${s.options.map(
          (option) => html`<div class="radio">
            <label for=${option.id}><input
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
            /> ${option.label}</label>
            ${optionHint(option)}
          </div>`
        )}`
      );
    }
  };

  const checkboxes: FieldAdapter<CheckboxesFieldState> = {
    kind: "field",
    name: "nova-scotia-checkboxes",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      return choiceGroup(
        s,
        html`${s.options.map(
          (option) => html`<div class="checkbox">
            <label for=${option.id}><input
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
                const boxes = Array.from(group?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? []);
                on.input(boxes.filter((box) => box.checked).map((box) => box.value));
                on.commit();
              }}
            /> ${option.label}</label>
            ${optionHint(option)}
          </div>`
        )}`
      );
    }
  };

  /** A lone checkbox: the library's checkbox label (forms/form-checkbox.html), the option's words in it. */
  const checkbox: FieldAdapter<CheckboxFieldState> = {
    kind: "field",
    name: "nova-scotia-checkbox",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      return html`<div class=${groupClass(s)}>
        <div class="checkbox">
          <label for=${s.id}><input
            id=${s.id}
            name=${s.name}
            type="checkbox"
            .checked=${live(s.checked)}
            aria-describedby=${ifDefined(describedByOf(s.describedBy))}
            aria-required=${flag(s.required)}
            aria-invalid=${flag(s.invalid)}
            ?disabled=${s.disabled}
            @change=${(event: Event) => {
              on.input((event.target as HTMLInputElement).checked);
              on.commit();
            }}
          /> ${s.hideLabel ? html`<span class="sr-only">${s.label}</span>` : s.label}${requiredMark(s)}</label>
        </div>
        ${hint(s)}${workedOut(s)}${error(s)}${notices(s)}
      </div>`;
    }
  };

  // ── Date ───────────────────────────────────────────────────────────────────────────────────
  // The library has no date: three boxes in its label and box markup.

  const PARTS = ["day", "month", "year"] as const;
  type Part = (typeof PARTS)[number];
  const SIZE: Record<Part, number> = { day: 3, month: 3, year: 5 };
  const PART_WORD = { day: "dateDay", month: "dateMonth", year: "dateYear" } as const;

  const readParts = (group: Element | null): DateParts => {
    const read = (part: Part): string => group?.querySelector<HTMLInputElement>(`[data-value-part="${part}"]`)?.value ?? "";
    return { year: read("year"), month: read("month"), day: read("day") };
  };

  const date: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "nova-scotia-date",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
    template(s, on) {
      const report = (event: Event, interim: boolean): void => {
        on.parts(readParts((event.currentTarget as Element).closest(".datum-ns-date")), interim ? { interim: true } : undefined);
      };
      // The field is left only when focus goes out of the whole date: tabbing day to month checks nothing.
      const left = (event: FocusEvent): void => {
        const into = event.relatedTarget;
        if (!(into instanceof Node && (event.currentTarget as Element).contains(into))) {
          on.commit();
        }
      };
      const item = (part: Part): View => html`<div class="datum-ns-date-part">
        <label class="control-label" for="${s.id}__${part}">${s.words(PART_WORD[part])}</label>
        <input
          class="form-control"
          id="${s.id}__${part}"
          name="${s.name}-${part}"
          type="text"
          inputmode="numeric"
          size=${SIZE[part]}
          data-value-part=${part}
          .value=${live(s.parts[part])}
          aria-invalid=${flag(s.errors.length > 0 && (s.missingParts.length === 0 || s.missingParts.includes(part)))}
          ?disabled=${s.disabled}
          ?readonly=${s.readOnly}
          @input=${(event: Event) => report(event, true)}
          @change=${(event: Event) => report(event, false)}
        />
      </div>`;
      return html`<fieldset class=${groupClass(s)} aria-describedby=${ifDefined(describedByOf(s.describedBy))}>
        ${legend(s)}${hint(s)}${workedOut(s)}${choiceError(s)}
        <div class="datum-ns-date" id=${s.id} @focusout=${left}>${PARTS.map(item)}</div>
        ${notices(s)}
      </fieldset>`;
    },
    // The first box the date still lacks, else the day: Datum's own focus on part boxes, wrapped (the boxes are marked `data-value-part`, day first).
    focusTarget: (field, s) => datumDate?.focusTarget?.(field, s) ?? field.querySelector<HTMLElement>('[data-value-part="day"]')
  };

  // ── Button ─────────────────────────────────────────────────────────────────────────────────

  /** The library's button classes (buttons/*.html): Datum's variants and sizes mapped to them. */
  const buttonVariant = (variant: string | undefined): string => {
    switch (variant) {
      case "primary":
        return "btn-primary";
      case "start":
      case "success":
        return "btn-success";
      case "secondary":
      case "light":
        return "btn-clear";
      case "danger":
        return "btn-danger";
      case "warning":
        return "btn-warning";
      case "info":
        return "btn-info";
      case "link":
        return "btn-link";
      default:
        return "btn-default";
    }
  };
  const buttonSize = (size: string | undefined, variant: string | undefined): string | false =>
    size === "lg" || size === "large" || variant === "start" ? "btn-lg" : size === "sm" || size === "small" ? "btn-sm" : size === "xs" ? "btn-xs" : false;

  const button: FieldAdapter<FieldState> = {
    kind: "field",
    name: "nova-scotia-button",
    capabilities: {},
    template(s) {
      const given = s as Partial<ButtonFieldState>;
      const model = s.model;
      const variant = given.variant ?? model.buttonVariant;
      const action = given.action ?? model.buttonAction;
      const size = given.size ?? model.buttonSize;
      const working = s.busy === "submitting" || s.busy === "navigating";
      // A press is the renderer's (`data-button-action`, heard as `datum-form-action`).
      return html`<button
        type="button"
        class=${cls("btn", buttonVariant(variant), buttonSize(size, variant))}
        data-button-action=${ifDefined(action)}
        data-button-signature=${ifDefined(model.buttonSignature)}
        ?disabled=${s.disabled || s.readOnly}
        aria-disabled=${action !== undefined && working ? "true" : nothing}
      >${s.label}</button>`;
    }
  };

  return { text, textarea, number, select, radio, checkboxes, checkbox, date, button };
}
