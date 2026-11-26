/**
 * Datum's date: three boxes (day, month, year) in a fieldset, the pattern every government design
 * system prescribes in place of the browser's date picker. The renderer composes the one stored
 * `YYYY-MM-DD` answer from the parts the adapter reports (`on.parts`), keeps a date typed in part
 * as it was typed, and tells validation what is missing; the adapter only draws the boxes.
 * `control: "native"` draws the browser's own date box instead (the browser's own look): one `<input type="date">` that reports the whole answer (`on.input`).
 *
 * `createDatumDateAdapter(options)` is the seam: the parts' order, a fixed one or one by
 * locale; whether the month is a select of names or a two-digit box; the boxes' widths; a class
 * per part; the `autocomplete` base; a hidden hint per part. The words ("Day", "Month", "Year",
 * the select's first option, each part's hint) come from the form's texts. The label, description,
 * control and error stand in the order `fieldOrder` gives, and `controls` moves the ARIA states
 * (`ariaStates`, `groupDescription`, `groupError`, `inlineErrors`).
 *
 * Writes: a box reports all three parts as they stand on every keystroke (`interim`), and again
 * settled on `change`; the field is "left" (`on.commit()`) only when focus moves out of the whole
 * group, so tabbing from day to month checks nothing. Focus goes to the first part the date still
 * lacks, in the order drawn.
 */
import type { DateFieldState, DateParts, FieldAdapter, FieldEvents } from "../contract.js";
import type { FieldStateBuilder } from "../fields.js";
import { html, ifDefined, live, nothing, type TemplateResult } from "../lit.js";
import { monthNamesFor } from "./month-names.js";
import {
  ariaStates,
  assembleParts,
  controlClassNames,
  describedByAttr,
  descriptionView,
  errorBeforeControl,
  errorView,
  fieldClassNames,
  labelView,
  leaveListeners,
  legendView,
  normalizePartOrder,
  resolveFieldOptions,
  tooltipTextOf,
  type DatumFieldOptions
} from "./field-scaffold.js";
import { classes, configurationOf } from "./leaf-kit.js";

export type DatePartName = "day" | "month" | "year";

export interface DatumDateOptions {
  /** Three part boxes (the default), or the browser's date box. */
  control?: "parts" | "native" | undefined;
  /** The parts in reading order, or a function of the locale. Default: day, month, year. */
  order?: readonly DatePartName[] | ((locale: string) => readonly DatePartName[]) | undefined;
  /** The month control: a select of month names, or a two-digit text box (the default). */
  month?: "select" | "text" | undefined;
  /** A select's option text: the month's name alone, or numbered ("01 - January"). */
  monthLabel?: "long" | "numbered" | undefined;
  /** The text boxes' `size` (characters). Default: day 2, month 2, year 4. */
  sizes?: Partial<Record<DatePartName, number>> | undefined;
  /** An extra class per part wrapper, for a design system's own width classes. */
  partClass?: ((part: DatePartName) => string | undefined) | undefined;
  /** The `autocomplete` base the parts complete with (`bday` completes `bday-day`); the component's own wins. */
  autocomplete?: string | undefined;
  /** Each part described by a visually hidden hint of its own (`dateDayHint` ...), before the error. Default: off. */
  partHints?: boolean | undefined;
}

export const DEFAULT_DATE_PART_ORDER: readonly DatePartName[] = ["day", "month", "year"];

/** A declared order validated as a field's parts are: every part once, unknown names dropped, an incomplete one falls back. */
export function normalizeDatePartOrder(order: readonly string[] | undefined): readonly DatePartName[] {
  return normalizePartOrder(order, DEFAULT_DATE_PART_ORDER);
}

/** The parts of an ISO `YYYY-MM-DD` value; empty strings for anything else. */
export function parseIsoDateParts(value: unknown): DateParts {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  return match ? { year: match[1] as string, month: match[2] as string, day: match[3] as string } : { year: "", month: "", day: "" };
}

const TEXT_KEYS = { day: "dateDay", month: "dateMonth", year: "dateYear" } as const;
const HINT_KEYS = { day: "dateDayHint", month: "dateMonthHint", year: "dateYearHint" } as const;

/** The three boxes' values as they stand. */
function readParts(group: Element): DateParts {
  const read = (part: DatePartName): string => group.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-value-part="${part}"]`)?.value ?? "";
  return { year: read("year"), month: read("month"), day: read("day") };
}

/** The drawn order of the parts for a locale under `options`. */
function drawnOrder(options: DatumDateOptions, locale: string): readonly DatePartName[] {
  return normalizeDatePartOrder(typeof options.order === "function" ? options.order(locale) : options.order);
}

/**
 * The state of a date for the renderer's fields module (`createFieldsFeature({ date })`): the
 * parts as the boxes show them, which for a date typed in part is what was typed (the stored
 * answer is empty until all three are in), and the parts still lacking, in the order the
 * adapter draws them (focus goes to the first). That order is the `dateOrder` of the binding the
 * adapter drawing the date comes from (the binding's own, or Datum's standing behind it), so no
 * host configures it per binding; `order` stands in for a binding that declares none.
 */
export function createDatumDateStateBuilder(options: Pick<DatumDateOptions, "order"> = {}): FieldStateBuilder {
  return (state, node, draw) => {
    const parts = draw.live.typedParts(state.key, state.value) ?? parseIsoDateParts(state.value);
    const live = draw.live;
    const drawer = live.resolve<FieldAdapter>("field", node.type, node.base, state);
    const owner = drawer === undefined || drawer.from === "binding" || drawer.from === "binding-base" ? live.binding : live.datum;
    const declared = owner.dateOrder !== undefined ? live.call("dateOrder", state.key, () => owner.dateOrder?.(state.locale)) : undefined;
    const order = declared !== undefined ? normalizeDatePartOrder(declared) : drawnOrder(options, state.locale);
    const missingParts = order.filter((part) => parts[part].trim() === "");
    const dated: DateFieldState = { ...state, parts, missingParts };
    return dated;
  };
}

export function createDatumDateAdapter(
  options: DatumDateOptions = {},
  field: DatumFieldOptions = resolveFieldOptions(undefined)
): FieldAdapter<DateFieldState> {
  const monthControl = options.month === "select" ? "select" : "text";
  const monthLabel = options.monthLabel === "numbered" ? "numbered" : "long";
  const sizes: Record<DatePartName, number> = { day: options.sizes?.day ?? 2, month: options.sizes?.month ?? 2, year: options.sizes?.year ?? 4 };
  const orderFor = (locale: string): readonly DatePartName[] => drawnOrder(options, locale);
  const partsOf = (s: DateFieldState): DateParts => s.parts ?? parseIsoDateParts(s.value);
  const controls = field.controls;

  if (options.control === "native") {
    return {
      kind: "field",
      name: "datum-date-native",
      capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "drawn", hideLabel: "drawn" },
      template(s: DateFieldState, on: FieldEvents): TemplateResult {
        const aria = ariaStates(s, field);
        const leave = leaveListeners(on);
        const configuration = configurationOf(s);
        const bound = (key: string): string | undefined => {
          const value = configuration[key];
          return typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" && value.length > 0 ? value : undefined;
        };
        return html`<label class=${fieldClassNames(s, "date")} for=${s.id}
          >${assembleParts(
            {
              label: labelView(s, field),
              description: descriptionView(s),
              control: html`<input
                id=${s.id}
                class=${controlClassNames("date")}
                type="date"
                .value=${live(s.value)}
                min=${ifDefined(bound("min"))}
                max=${ifDefined(bound("max"))}
                aria-labelledby=${s.labelId}
                ?disabled=${s.disabled}
                ?readonly=${s.readOnly}
                aria-invalid=${ifDefined(aria.invalid)}
                aria-describedby=${ifDefined(describedByAttr(s.describedBy))}
                aria-required=${ifDefined(aria.required)}
                @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, { interim: true })}
                @change=${leave.change}
                @blur=${leave.blur}
                @focus=${leave.focus}
              />`,
              error: errorView(s, field)
            },
            field.fieldOrder,
            s
          )}</label
        >`;
      }
    };
  }

  return {
    kind: "field",
    name: "datum-date",
    capabilities: { notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "drawn", hideLabel: "drawn" },

    template(s: DateFieldState, on: FieldEvents): TemplateResult {
      const parts = partsOf(s);
      const aria = ariaStates(s, field);
      // The group's description (hint, notices, error) sits on the fieldset, unless the design
      // system's parts carry it ("required": each part is described by its own hint and the
      // error) or its groups are described by nothing.
      const groupUndescribed = controls.ariaStates === "required" || controls.groupDescription === "none";
      // An invalid date marks each part invalid and describes it by the message, so a screen
      // reader focused on "Day" hears what is wrong. Under "required" a part is still described
      // by its message but nothing is marked invalid; under "none" only the fieldset is described.
      const partErrorId = controls.ariaStates !== "none" && s.invalid ? s.errorId : undefined;
      // Read-only is `readonly` on the boxes, never `disabled`; the month select has no
      // `readonly`, so the renderer refuses its change and marks it `aria-readonly` (guards.ts).
      const locked = s.disabled;
      const autocompleteBase = s.model.autocomplete ?? options.autocomplete;
      const autocompleteFor = (part: DatePartName): string | undefined => (autocompleteBase ? `${autocompleteBase}-${part}` : undefined);
      const partHintId = (part: DatePartName): string => `${s.id}__${part}-hint`;
      const partDescribedBy = (part: DatePartName): string | undefined =>
        describedByAttr([...(options.partHints ? [partHintId(part)] : []), ...(partErrorId !== undefined ? [partErrorId] : [])]);
      const partLabelId = (part: DatePartName): string => `${s.id}__${part}-label`;

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

      // Each part names itself by its own label span: the wrapping <label> would otherwise fold
      // a select's option list into the month's accessible name.
      const wrap = (part: DatePartName, control: TemplateResult): TemplateResult =>
        html`<label class=${classes("datum-form__date-part", `datum-form__date-part--${part}`, options.partClass?.(part))} for=${`${s.id}__${part}`}
          ><span id=${partLabelId(part)} class="datum-form__date-part-label">${s.words(TEXT_KEYS[part])}</span
          >${options.partHints ? html`<span id=${partHintId(part)} class="datum-form__date-part-hint datum-form__visually-hidden">${s.words(HINT_KEYS[part])}</span>` : nothing}${control}</label
        >`;
      const box = (part: DatePartName): TemplateResult =>
        wrap(
          part,
          html`<input
            id=${`${s.id}__${part}`}
            class=${controlClassNames("text")}
            data-value-part=${part}
            type="text"
            inputmode="numeric"
            size=${sizes[part]}
            .value=${live(parts[part])}
            autocomplete=${ifDefined(autocompleteFor(part))}
            aria-labelledby=${partLabelId(part)}
            ?disabled=${locked}
            ?readonly=${s.readOnly}
            aria-invalid=${ifDefined(aria.invalid)}
            aria-describedby=${ifDefined(partDescribedBy(part))}
            @input=${(event: Event) => report(event, true)}
            @change=${(event: Event) => report(event, false)}
          />`
        );
      const monthSelect = (): TemplateResult => {
        const names = monthNamesFor(s.locale);
        return wrap(
          "month",
          html`<select
            id=${`${s.id}__month`}
            class=${controlClassNames("select")}
            data-value-part="month"
            autocomplete=${ifDefined(autocompleteFor("month"))}
            aria-labelledby=${partLabelId("month")}
            ?disabled=${locked}
            aria-invalid=${ifDefined(aria.invalid)}
            aria-describedby=${ifDefined(partDescribedBy("month"))}
            @change=${(event: Event) => report(event, false)}
          >
            <option value="" disabled .selected=${live(parts.month === "")}>${s.words("dateSelectMonth")}</option>
            ${names.map((name, index) => {
              const value = String(index + 1).padStart(2, "0");
              return html`<option value=${value} .selected=${live(value === parts.month)}>${monthLabel === "numbered" ? `${value} - ${name}` : name}</option>`;
            })}
          </select>`
        );
      };

      // The date is a fieldset of boxes, so a design system that puts a group's error under its legend puts the date's there too.
      const order = controls.groupError === "afterLegend" ? errorBeforeControl(field.fieldOrder) : field.fieldOrder;
      return html`<fieldset
        id=${s.id}
        class=${fieldClassNames(s, "date", "datum-form__field datum-form__date-group")}
        aria-labelledby=${tooltipTextOf(s) !== undefined ? s.labelId : nothing}
        aria-invalid=${ifDefined(aria.invalid)}
        aria-describedby=${groupUndescribed ? nothing : ifDefined(describedByAttr(s.describedBy))}
      >${assembleParts(
        {
          label: legendView(s, field),
          description: descriptionView(s),
          control: html`<div class="datum-form__date-parts" data-date-parts @focusout=${left}>${orderFor(s.locale).map((part) => (part === "month" && monthControl === "select" ? monthSelect() : box(part)))}</div>`,
          error: errorView(s, field)
        },
        order,
        s
      )}</fieldset>`;
    },

    focusTarget: datePartsFocusTarget
  };
}

/**
 * Where focus goes on a date drawn as part boxes: the first box the date still lacks, in the
 * order the boxes stand, else the first (an impossible day). Read from the boxes, which hold what
 * was typed even when no draw has followed. Any binding whose date draws its boxes marked
 * `data-value-part` (`day`, `month`, `year`) in the field's own tree takes it as it is
 * (`datum.components.date.focusTarget`).
 */
export function datePartsFocusTarget(wrapper: HTMLElement): HTMLElement | null {
  const boxes = Array.from(wrapper.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-value-part]"));
  return boxes.find((box) => box.value.trim() === "") ?? boxes[0] ?? null;
}

/** Datum's date with the engine's own choices: day, month, year; the month a two-digit box. */
export const datumDateAdapter: FieldAdapter<DateFieldState> = createDatumDateAdapter();
