/**
 * The Fluent UI date. Tier 2: Datum's own date drawn in Fluent's elements and tokens, because
 * Fluent UI Web Components has no date input.
 *
 * The date is a `fieldset` with a `legend` (styled from Fluent's label tokens in css.ts), an
 * optional hint under it, and one `fluent-field label-position="above"` + `fluent-text-input`
 * (numeric keyboard, character width 2 / 2 / 4) per part, in the order Datum's date draws them: the
 * part order of Datum's binding (`datum.dateOrder`), which the date's state (`missingParts`) follows
 * too. This binding declares no `dateOrder` of its own. The error and notices are one message element
 * under the parts. The behaviour is Datum's: the renderer composes the stored `YYYY-MM-DD` from the
 * parts reported with `on.parts`, keeps a date typed in part as it was typed and says what is
 * missing; the field is left only when focus goes out of the whole group; focus is Datum's date
 * focus (`datum.components.date`), the first box still lacking, wrapped rather than copied.
 *
 * Each part's text input keeps the typed text across a redraw (`live`) and is named and described
 * on its inner box (shared.ts `describe`), the error describing every part while the date is invalid.
 */
import type { DateFieldState, DatePartName, DateParts, FieldAdapter, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { boxOf, describe, messagesOf, readyOf, setAttr, VISUALLY_HIDDEN, type Lit } from "./shared.js";

const TEXT_KEYS = { day: "dateDay", month: "dateMonth", year: "dateYear" } as const;
const SIZES: Record<DatePartName, number> = { day: 2, month: 2, year: 4 };
const DEFAULT_ORDER: readonly DatePartName[] = ["day", "month", "year"];

const isoParts = (value: string): DateParts => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? { year: match[1] as string, month: match[2] as string, day: match[3] as string } : { year: "", month: "", day: "" };
};

/** The three boxes' values as they stand (the host's `value` of each part's text input). */
const readParts = (group: Element): DateParts => {
  const read = (part: DatePartName): string => group.querySelector<HTMLElement & { value?: string }>(`[data-value-part="${part}"]`)?.value ?? "";
  return { year: read("year"), month: read("month"), day: read("day") };
};

export function createDate(lit: Lit, datum: LiveBinding): { date: FieldAdapter<DateFieldState> } {
  const { html, nothing, ifDefined, live } = lit;
  /** Datum's date: its focus target reads the boxes marked `data-value-part` in the order they stand. */
  const datumDate = datum.components.date as FieldAdapter<DateFieldState> | undefined;

  const partId = (s: DateFieldState, part: DatePartName): string => `${s.id}__${part}`;
  const partLabelId = (s: DateFieldState, part: DatePartName): string => `${s.id}__${part}-label`;

  const date: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "fluent-datum-date",
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", workedOut: "degraded", hideLabel: "drawn" },
    template(s, on) {
      const parts = s.parts ?? isoParts(s.value);
      const order = datum.dateOrder?.(s.locale) ?? DEFAULT_ORDER;
      const report = (event: Event, interim: boolean): void => {
        const group = (event.currentTarget as Element).closest("[data-date-parts]");
        if (group) {
          on.parts(readParts(group), interim ? { interim: true } : undefined);
        }
      };
      // The field is left only when focus goes out of the whole group: tabbing day to month checks nothing.
      const left = (event: FocusEvent): void => {
        const into = event.relatedTarget;
        if (!(into instanceof Node && (event.currentTarget as Element).contains(into))) {
          on.commit();
        }
      };
      const box = (part: DatePartName) => html`<fluent-field label-position="above" class=${`datum-fluent-date__part datum-fluent-date__part--${part}`}>
        <label slot="label" id=${partLabelId(s, part)} for=${partId(s, part)}>${s.words(TEXT_KEYS[part])}</label>
        <fluent-text-input
          slot="input"
          id=${partId(s, part)}
          name=${`${s.name}-${part}`}
          data-value-part=${part}
          type="text"
          size=${SIZES[part]}
          .value=${live(parts[part])}
          autocomplete=${ifDefined(s.model.autocomplete ? `${s.model.autocomplete}-${part}` : undefined)}
          ?disabled=${s.disabled}
          ?readonly=${s.readOnly}
          @input=${(event: Event) => report(event, true)}
          @change=${(event: Event) => report(event, false)}
        ></fluent-text-input>
      </fluent-field>`;
      const { hint: _hint, ...withoutHint } = s;
      const hint = s.hint !== undefined && s.hint !== "" ? messagesOf(lit, { ...s, errors: [], notices: [] }) : nothing;
      return html`<fieldset id=${s.id} class="datum-fluent-date" aria-invalid=${ifDefined(s.invalid ? "true" : undefined)} aria-describedby=${ifDefined(s.describedBy.length > 0 ? s.describedBy.join(" ") : undefined)}>
        <legend id=${s.labelId} class=${s.hideLabel ? VISUALLY_HIDDEN : nothing} ?data-required=${s.required}>${s.label}</legend>
        ${hint}
        <div class="datum-fluent-date__parts" data-date-parts @focusout=${left}>${order.map(box)}</div>
        ${messagesOf(lit, withoutHint)}
      </fieldset>`;
    },
    // Each part's inner box is named by its own label and described by the error; `inputmode` reaches no attribute of the component.
    after(field, s) {
      for (const part of datumDateOrder(datum, s.locale)) {
        const box = boxOf(field.querySelector(`[data-value-part="${part}"]`));
        setAttr(box, "inputmode", "numeric");
        describe(box, field, { labelId: partLabelId(s, part), describedBy: s.invalid && s.errorId !== undefined ? [s.errorId] : [], invalid: s.invalid });
      }
    },
    ready: readyOf(),
    // The first part the date still lacks, in the order drawn: Datum's own focus on part boxes (what was typed, even before a draw).
    focusTarget: (wrapper, s) => datumDate?.focusTarget?.(wrapper, s) ?? wrapper.querySelector<HTMLElement>("[data-value-part]")
  };

  return { date };
}

const datumDateOrder = (datum: LiveBinding, locale: string): readonly DatePartName[] => datum.dateOrder?.(locale) ?? DEFAULT_ORDER;
