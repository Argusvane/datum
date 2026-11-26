/**
 * The two tiers of the Alberta Design System date.
 *
 * Tier 2, the `date` adapter: Datum's own date drawn in the design system's pieces. A fieldset
 * whose legend, help text and error message are written the way `goa-form-item` writes them
 * (Alberta's tokens, css.ts) around three real controls, each in a compact `goa-form-item`: a month
 * dropdown, a day box and a year box (`goa-dropdown`, `goa-input`). The behaviour stays Datum's: the
 * renderer composes the stored `YYYY-MM-DD` from the parts the adapter reports (`on.parts`), keeps a
 * date typed in part as it was typed and says what is missing. The group is named and described in
 * the form's own tree, so a screen reader reads the legend, the help text and the error with the
 * boxes. The order is month, day, year, the design system's own.
 *
 * Tier 2, the `goa-date-picker` type (kinds: `goa-date-picker` -> `date`): the official
 * `<goa-date-picker type="input">`, for a form that wants the design system's own component. It is
 * drastically different from Datum's date: it says a date only when it is whole ("" otherwise), and
 * the parts the person typed never leave it, so the adapter reads them from its inner controls. It
 * ships in the package's FormPlugin (plugin.ts); under any other binding the lookup chain draws the
 * base, `date`.
 */
import type { DateFieldState, DateParts, FieldAdapter } from "../../../engine/form-engine/render/live/contract.js";
import { bool, detailOf, formItem, noticesOf, readyWhen, requirementOf, type Goa, type Lit } from "./shared.js";
import { choiceGuard } from "./fields.js";

type PartName = "day" | "month" | "year";

/** The tier-2 type this package offers beside the engine's: it reads as a `date` (the definition's `kinds` map). */
export const ALBERTA_DATE_TYPE = "goa-date-picker";

/** Alberta's date picker draws month, day, year whatever the language. */
export const albertaDateOrder = (): readonly PartName[] => ["month", "day", "year"];

const TEXT_KEYS = { day: "dateDay", month: "dateMonth", year: "dateYear" } as const;

const isoParts = (value: string): DateParts => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? { year: match[1] as string, month: match[2] as string, day: match[3] as string } : { year: "", month: "", day: "" };
};

const monthNames = (locale: string): string[] => {
  const format = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  return Array.from({ length: 12 }, (_, index) => format.format(new Date(Date.UTC(2000, index, 1))));
};

/** The control inside one part of the date: the native box (or select) a goa-input / goa-dropdown draws. */
const controlOf = (field: HTMLElement, part: PartName): HTMLInputElement | HTMLSelectElement | null =>
  (field.querySelector(`[data-value-part="${part}"]`)?.shadowRoot?.querySelector<HTMLInputElement | HTMLSelectElement>("input, select") ?? null);

const readParts = (field: HTMLElement): DateParts => ({ year: controlOf(field, "year")?.value.trim() ?? "", month: controlOf(field, "month")?.value.trim() ?? "", day: controlOf(field, "day")?.value.trim() ?? "" });

/** The picker draws its parts with props, not attributes (`name` is a property of the inner goa-input, never an attribute): they are found by that property. */
const partOf = (picker: Goa, tag: string, name: string): (Goa & { value?: unknown }) | undefined =>
  Array.from(picker.shadowRoot?.querySelectorAll<Goa & { name?: string }>(tag) ?? []).find((element) => element.name === name);

/** What the picker shows now: its month dropdown's value, its day and year boxes' text. */
function shownParts(picker: Goa): DateParts {
  const box = (name: string): string => (partOf(picker, "goa-input", name)?.shadowRoot?.querySelector<HTMLInputElement>("input")?.value ?? "").trim();
  const month = String(partOf(picker, "goa-dropdown", "month")?.value ?? "");
  return { year: box("year"), month: month === "0" ? "" : month, day: box("day") };
}

/** Whole numbers compare as numbers ("05" and "5" are the same month). */
const same = (a: string, b: string): boolean => a === b || (/^\d+$/.test(a) && /^\d+$/.test(b) && Number(a) === Number(b));

export function createDate(lit: Lit): { date: FieldAdapter<DateFieldState>; datePicker: FieldAdapter<DateFieldState> } {
  const { html, nothing, ifDefined, live } = lit;

  // ── Tier 2: Datum's date in Alberta's pieces ───────────────────────────────────────────────
  const date: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "goa-datum-date",
    // The worked-out line is drawn with the help text's face, under the id the state names.
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", workedOut: "drawn", hideLabel: "drawn" },
    template(s, on) {
      const parts = s.parts ?? isoParts(s.value);
      const invalid = s.errors.length > 0;
      const report = (interim: boolean) => (event: Event): void => {
        const field = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-date-parts]");
        if (!field) {
          return;
        }
        const read = readParts(field);
        // The event's own part is the newest: a goa-input's text is read before the component's state catches up.
        const name = detailOf(event).name as PartName | undefined;
        if (name === "day" || name === "month" || name === "year") {
          read[name] = String(detailOf(event).value ?? "").trim();
        }
        on.parts(read, interim ? { interim: true } : undefined);
      };
      // The field is left only when focus goes out of the whole group: tabbing day to month checks nothing.
      const left = (event: FocusEvent): void => {
        const into = event.relatedTarget;
        if (!(into instanceof Node && (event.currentTarget as Element).contains(into))) {
          on.commit();
        }
      };
      const word = (part: PartName): string => s.words(TEXT_KEYS[part]);
      const requirement = requirementOf(s) === "required" ? s.words("required") : "";
      const box = (part: "day" | "year") =>
        html`<goa-form-item label=${word(part)} labelsize="compact" type="text-input"
          ><goa-input
            data-value-part=${part}
            name=${part}
            type="text"
            inputmode="numeric"
            width=${part === "year" ? "7ch" : "5ch"}
            .value=${live(parts[part])}
            autocomplete=${s.model.autocomplete ? `${s.model.autocomplete}-${part}` : ""}
            arialabel=${`${s.label} ${word(part)}`}
            error=${bool(invalid)}
            disabled=${bool(s.disabled)}
            readonly=${bool(s.readOnly)}
            @_change=${report(true)}
            @input=${(event: Event) => (event.composedPath()[0] instanceof HTMLInputElement ? report(true)(event) : undefined)}
          ></goa-input
        ></goa-form-item>`;
      const month = html`<goa-form-item label=${word("month")} labelsize="compact"
        ><goa-dropdown
          data-value-part="month"
          name="month"
          native="true"
          .value=${live(parts.month)}
          placeholder=${s.words("dateSelectMonth")}
          arialabel=${`${s.label} ${word("month")}`}
          error=${bool(invalid)}
          disabled=${bool(s.disabled)}
          @_change=${report(false)}
          ><goa-dropdown-item value="" label=${s.words("dateSelectMonth")}></goa-dropdown-item>${monthNames(s.locale).map((name, index) => html`<goa-dropdown-item value=${String(index + 1).padStart(2, "0")} label=${name}></goa-dropdown-item>`)}</goa-dropdown
        ></goa-form-item
      >`;
      return html`<fieldset class=${invalid ? "datum-goa-group datum-goa-date datum-goa-date--invalid" : "datum-goa-group datum-goa-date"} aria-describedby=${ifDefined(s.describedBy.length > 0 ? s.describedBy.join(" ") : undefined)}>
        <legend id=${s.labelId} class=${s.hideLabel ? "datum-goa-sr-only" : "datum-goa-label"}>${s.label}${requirement === "" ? nothing : html` <span class="datum-goa-requirement">${requirement}</span>`}</legend>
        ${s.errors.length > 0 && s.errorId !== undefined ? html`<div id=${s.errorId} class="datum-goa-error"><goa-icon type="warning" theme="filled" size="small"></goa-icon><span>${s.errors.join("; ")}</span></div>` : nothing}
        ${s.hint !== undefined && s.hint !== "" && s.hintId !== undefined ? html`<div id=${s.hintId} class="datum-goa-hint">${s.hint}</div>` : nothing}
        ${s.workedOut !== undefined && s.workedOutId !== undefined ? html`<div id=${s.workedOutId} class="datum-goa-hint" data-worked-out>${s.workedOut}</div>` : nothing}
        <div class="datum-goa-date__parts" data-date-parts @focusout=${left}>${albertaDateOrder().map((part) => (part === "month" ? month : box(part)))}</div>
        ${noticesOf(lit, s)}
      </fieldset>`;
    },
    guard: choiceGuard("goa-dropdown"),
    ready: async (field) => {
      await readyWhen("goa-input", "input")(field);
      await readyWhen("goa-dropdown", "select, input")(field);
    },
    // The first part the date still lacks, in the order drawn, else the first: read from the boxes, which hold what was typed even before a draw.
    focusTarget(field, s) {
      const order = albertaDateOrder();
      const lacking = s.missingParts?.[0];
      const part = lacking !== undefined ? lacking : order.find((name) => (controlOf(field, name)?.value.trim() ?? "") === "") ?? order[0];
      return (part !== undefined ? controlOf(field, part) : null) ?? controlOf(field, order[0] as PartName);
    }
  };

  // ── Tier 2: the official <goa-date-picker>, under its own type ─────────────────────────────
  const picker = (field: HTMLElement): (Goa & { __onParts?: (parts: DateParts) => void; value?: string }) | null => field.querySelector("goa-date-picker");

  const datePicker: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "goa-date-picker",
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", workedOut: "degraded", hideLabel: "drawn" },
    idsWrittenBy: "component",
    template: (s, on) =>
      formItem(
        lit,
        s,
        "",
        // No `value` here: the picker's own parts are written by `after`, only when they differ.
        html`<goa-date-picker
          name=${s.name}
          type="input"
          error=${bool(s.errors.length > 0)}
          disabled=${bool(s.disabled)}
          .__onParts=${on.parts}
          @_blur=${() => on.commit()}
        ></goa-date-picker>`,
        noticesOf(lit, s)
      ),
    guard: choiceGuard("goa-date-picker"),
    /**
     * The picker says "" until a date is whole, and its parts never leave it (it stops the inner
     * controls' `_change`). A capture listener on its shadow root hears them first and reports the
     * three parts; the renderer composes the answer.
     */
    connect(field) {
      const element = picker(field);
      const root = element?.shadowRoot;
      if (!element || !root) {
        return undefined;
      }
      const heard = (event: Event): void => {
        const name = detailOf(event).name;
        if (name !== "month" && name !== "day" && name !== "year") {
          return;
        }
        const parts = shownParts(element);
        // The event's own part is the newest: a goa-input's text is read before the component's state catches up.
        parts[name] = String(detailOf(event).value ?? "").trim();
        if (name === "month" && parts.month === "0") {
          parts.month = "";
        }
        element.__onParts?.(parts);
      };
      root.addEventListener("_change", heard, true);
      return () => root.removeEventListener("_change", heard, true);
    },
    after(field, s) {
      const element = picker(field);
      if (!element) {
        return;
      }
      const { year, month, day } = s.parts;
      const wanted = year !== "" && month !== "" && day !== "" ? `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : "";
      const shown = shownParts(element);
      const agrees = same(shown.year, year) && same(shown.month, month) && same(shown.day, day);
      // Written only when the picker disagrees with the answer: a date typed in part is kept as typed.
      // A part left out cannot be written (the picker takes a whole date), so only a whole date or none is.
      if (!agrees && (wanted !== "" || (year === "" && month === "" && day === ""))) {
        element.value = wanted;
      }
    },
    focusTarget: (field) => picker(field)?.shadowRoot?.querySelector<Goa>("goa-dropdown")?.shadowRoot?.querySelector<HTMLElement>("input, select") ?? null,
    ready: async (field) => {
      await readyWhen("goa-date-picker", "goa-form-item")(field);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };

  return { date, datePicker };
}
