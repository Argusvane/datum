/**
 * The two tiers of the GC Design System date.
 *
 * Tier 2, the `date` adapter: Datum's own date drawn in GC Design System's HTML and tokens. The
 * date is a fieldset of Month / Day / Year controls (the pattern `gcds-date-input` draws), but the
 * behaviour stays Datum's: the renderer composes the stored `YYYY-MM-DD` from the parts the
 * adapter reports (`on.parts`), keeps a date typed in part as it was typed, says what is missing,
 * and the field is left only when focus goes out of the whole group. The look is the design
 * system's tokens (css.ts), since GC Design System ships no component CSS without its script. The
 * order is the design system's own: month, day, year in English, day, month, year otherwise (the
 * binding's `dateOrder`, which the date's state follows). Focus is Datum's date's own
 * (`datum.components.date.focusTarget`, the first box lacking in the order drawn), wrapped, not copied.
 *
 * Tier 2, the `gcds-date` type (kinds: `gcds-date` -> `date`): the official `<gcds-date-input>`,
 * for a form that wants the design system's own component. Under any other binding the lookup
 * chain draws the base, `date`.
 */
import type { DateFieldState, DateParts, FieldAdapter, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { boxesIn, hintOf, keepDescription, languageOf, messageOf, noticesOf, reflectDescription, type Hydrating, type Lit } from "./shared.js";

type PartName = "day" | "month" | "year";

/** gcds-date-input's order: month, day, year in English; day, month, year otherwise. */
export const gcdsDateOrder = (locale: string): readonly PartName[] => (languageOf(locale) === "en" ? ["month", "day", "year"] : ["day", "month", "year"]);

/** The tier-2 type this package offers beside the engine's: it reads as a `date` (the definition's `kinds` map). */
export const GCDS_DATE_TYPE = "gcds-date";

const TEXT_KEYS = { day: "dateDay", month: "dateMonth", year: "dateYear" } as const;

const isoParts = (value: string): DateParts => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? { year: match[1] as string, month: match[2] as string, day: match[3] as string } : { year: "", month: "", day: "" };
};

const monthNames = (locale: string): string[] => {
  const format = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  return Array.from({ length: 12 }, (_, index) => format.format(new Date(Date.UTC(2000, index, 1))));
};

/** The three boxes' values as they stand. */
const readParts = (group: Element): DateParts => {
  const read = (part: PartName): string => group.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-value-part="${part}"]`)?.value ?? "";
  return { year: read("year"), month: read("month"), day: read("day") };
};

export function createDate(lit: Lit, datum: LiveBinding): { date: FieldAdapter<DateFieldState>; gcdsDate: FieldAdapter<DateFieldState> } {
  const { html, nothing, ifDefined, live } = lit;
  /** Datum's date: its focus target reads the boxes marked `data-value-part` in the order they stand. */
  const datumDate = datum.components.date as FieldAdapter<DateFieldState> | undefined;

  // ── Tier 2: Datum's date in GC Design System's HTML ────────────────────────────────────
  const date: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "gcds-datum-date",
    // The worked-out line is drawn with the hint's styling, under the id the state names.
    capabilities: { notice: "degraded", pending: "degraded", tooltip: "degraded", workedOut: "drawn", hideLabel: "drawn" },
    template(s, on) {
      const parts = s.parts ?? isoParts(s.value);
      const hint = hintOf(s);
      const invalid = s.invalid;
      // gcds-hint and gcds-error-message write their own ids (`hint-<id>`, `error-message-<id>`) in this same tree.
      const hintId = `hint-${s.id}`;
      const errorId = `error-message-${s.id}`;
      const partDescribedBy = invalid ? errorId : undefined;
      const describedBy = s.describedBy.map((id) => (id === s.hintId ? hintId : id === s.errorId ? errorId : id));
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
      const labelId = (part: PartName): string => `${s.id}__${part}-label`;
      const wrap = (part: PartName, control: ReturnType<typeof html>) =>
        html`<div class=${`datum-gcds-date__part datum-gcds-date__part--${part}`}
          ><label id=${labelId(part)} class="datum-gcds-date__label" for=${`${s.id}__${part}`}>${s.words(TEXT_KEYS[part])}</label>${control}</div
        >`;
      const box = (part: PartName) =>
        wrap(
          part,
          html`<input
            id=${`${s.id}__${part}`}
            class=${invalid ? "datum-gcds-date__control datum-gcds-date__control--invalid" : "datum-gcds-date__control"}
            data-value-part=${part}
            type="text"
            inputmode="numeric"
            size=${part === "year" ? 4 : 2}
            .value=${live(parts[part])}
            autocomplete=${ifDefined(s.model.autocomplete ? `${s.model.autocomplete}-${part}` : undefined)}
            ?disabled=${s.disabled}
            ?readonly=${s.readOnly}
            aria-invalid=${ifDefined(invalid ? "true" : undefined)}
            aria-describedby=${ifDefined(partDescribedBy)}
            @input=${(event: Event) => report(event, true)}
            @change=${(event: Event) => report(event, false)}
          />`
        );
      const monthSelect = () =>
        wrap(
          "month",
          html`<select
            id=${`${s.id}__month`}
            class=${invalid ? "datum-gcds-date__control datum-gcds-date__control--select datum-gcds-date__control--invalid" : "datum-gcds-date__control datum-gcds-date__control--select"}
            data-value-part="month"
            autocomplete=${ifDefined(s.model.autocomplete ? `${s.model.autocomplete}-month` : undefined)}
            ?disabled=${s.disabled}
            aria-invalid=${ifDefined(invalid ? "true" : undefined)}
            aria-describedby=${ifDefined(partDescribedBy)}
            @change=${(event: Event) => report(event, false)}
          >
            <option value="" disabled ?selected=${parts.month === ""}>${s.words("dateSelectMonth")}</option>
            ${monthNames(s.locale).map((name, index) => {
              const value = String(index + 1).padStart(2, "0");
              return html`<option value=${value} ?selected=${value === parts.month}>${name}</option>`;
            })}
          </select>`
        );
      const marker = s.words(s.required ? "required" : "optional");
      return html`<fieldset
        class=${invalid ? "datum-gcds-date datum-gcds-date--invalid" : "datum-gcds-date"}
        aria-describedby=${ifDefined(describedBy.length > 0 ? describedBy.join(" ") : undefined)}
      >
        <legend id=${s.labelId} class=${s.hideLabel ? "datum-gcds-date__legend datum-gcds-sr-only" : "datum-gcds-date__legend"}>${s.label}${marker === "" ? nothing : html` <span class="datum-gcds-date__marker">${marker}</span>`}</legend>
        ${hint !== undefined && s.hintId !== undefined ? html`<gcds-hint hint-id=${s.id}>${hint}</gcds-hint>` : nothing}
        ${s.workedOut !== undefined && s.workedOutId !== undefined ? html`<p id=${s.workedOutId} class="datum-gcds-hint" data-worked-out>${s.workedOut}</p>` : nothing}
        ${s.errors.length > 0 && s.errorId !== undefined ? html`<gcds-error-message message-id=${s.id}>${messageOf(s.errors)}</gcds-error-message>` : nothing}
        <div class="datum-gcds-date__parts" data-date-parts @focusout=${left}>${gcdsDateOrder(s.locale).map((part) => (part === "month" ? monthSelect() : box(part)))}</div>
        ${noticesOf(lit, s)}
      </fieldset>`;
    },
    // gcds-hint and gcds-error-message draw themselves: wait for this field's own, never the whole form.
    idsWrittenBy: "component",
    ready: async (field) => {
      await Promise.all(Array.from(field.querySelectorAll<Hydrating>("gcds-hint, gcds-error-message"), (element) => element.componentOnReady?.()));
    },
    // The first part the date still lacks, in the order drawn: Datum's own focus on part boxes (what was typed, even before a draw).
    focusTarget: (wrapper, s) => datumDate?.focusTarget?.(wrapper, s) ?? wrapper.querySelector<HTMLElement>("[data-value-part]")
  };

  // ── Tier 2: the official <gcds-date-input>, under its own type ─────────────────────────
  /** gcds-date-input's value, "YYYY-MM-DD" with empty parts where nothing was typed ("2026--05"). */
  const partsOfValue = (value: string): DateParts => {
    const [year = "", month = "", day = ""] = value.split("-");
    return { year, month, day };
  };

  const gcdsDate: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "gcds-date-input",
    capabilities: { notice: "degraded", pending: "degraded", tooltip: "degraded", workedOut: "degraded" },
    idsWrittenBy: "component",
    template: (s, on) => {
      // gcds-date-input's own format: two-digit month and day ("2026-05-14"), each part as typed otherwise.
      const pad = (part: string) => (/^\d$/.test(part) ? part.padStart(2, "0") : part);
      const parts = s.parts ?? isoParts(s.value);
      const month = pad(parts.month);
      const day = pad(parts.day);
      const value = parts.year || month || day ? `${parts.year}-${month}-${day}` : "";
      const report = (event: Event) => on.parts(partsOfValue(String((event.currentTarget as HTMLElement & { value?: unknown }).value ?? "")));
      return html`<gcds-date-input
          name=${s.name}
          legend=${s.label}
          format="full"
          hint=${ifDefined(hintOf(s))}
          error-message=${ifDefined(messageOf(s.errors))}
          .value=${live(value)}
          ?required=${s.required && !s.disabled}
          ?disabled=${s.disabled}
          lang=${languageOf(s.locale)}
          validate-on="other"
          @input=${report}
          @change=${(event: Event) => {
            report(event);
            on.commit();
          }}
        ></gcds-date-input>${noticesOf(lit, s)}`;
    },
    // No read-only on gcds-date-input: its day and year boxes take `readonly`. Its month is a select two
    // shadow roots down, which the renderer marks aria-readonly and guards itself.
    after(field, s) {
      reflectDescription(field, field.querySelector("gcds-date-input")?.shadowRoot?.querySelector<HTMLElement>("fieldset"));
      for (const box of boxesIn(field, "gcds-date-input")) {
        if (box instanceof HTMLInputElement) {
          box.readOnly = s.readOnly;
        }
      }
    },
    connect: (field) => keepDescription(field, () => field.querySelector("gcds-date-input")?.shadowRoot?.querySelector<HTMLElement>("fieldset")),
    ready: async (field) => {
      const host = field.querySelector("gcds-date-input") as Hydrating | null;
      await host?.componentOnReady?.();
      await Promise.all(Array.from(host?.shadowRoot?.querySelectorAll("*") ?? []).filter((element) => element.localName.startsWith("gcds-")).map((element) => (element as Hydrating).componentOnReady?.()));
    },
    // The first box: the month (a select in the full format).
    focusTarget: (field) => boxesIn(field, "gcds-date-input")[0] ?? null
  };

  return { date, gcdsDate };
}

