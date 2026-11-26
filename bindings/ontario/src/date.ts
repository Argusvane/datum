/**
 * The two tiers of the Ontario Design System date.
 *
 * Tier 2, the `date` adapter: Datum's own date drawn in Ontario's HTML and tokens. The date is a
 * fieldset of Year / Month / Day text boxes, the pattern `ontario-date-input` draws, but the
 * behaviour stays Datum's: the renderer composes the stored `YYYY-MM-DD` from the parts the adapter
 * reports (`on.parts`), keeps a date typed in part as it was typed, says what is missing, and the
 * field is left only when focus goes out of the whole group. Why not the official component for every
 * date: `ontario-date-input` validates by itself when a box is blurred and has no property for an
 * error someone else found, so a Datum error (a rule, a date in the past, a date the form refused) has
 * nowhere to go; its value is a UTC timestamp, not the date. The look is Ontario's, restated in css.ts
 * from its tokens, since the component's own CSS lives in its shadow root. The order is Ontario's own:
 * year, month, day in every language (the binding's `dateOrder`). Focus is Datum's date's own
 * (`datum.components.date.focusTarget`, the first box lacking in the order drawn), wrapped, not copied.
 *
 * Tier 2, the `ontario-date` type (kinds: `ontario-date` -> `date`): the official
 * `<ontario-date-input>`, for a form that wants the design system's own component. Its own checks are
 * switched off (`dateValidator`), so Datum's is the only error, drawn beside it with Ontario's error
 * line. Under any other binding the lookup chain draws the base, `date`.
 */
import type { DateFieldState, DateParts, FieldAdapter, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { applyModes, boxesIn, captionOf, keepDescription, languageOf, messageOf, noticesOf, readyOf, reflectDescription, type Hydrating, type Lit } from "./shared.js";

type PartName = "day" | "month" | "year";

/** ontario-date-input's order: year, month, day. */
export const ontarioDateOrder = (): readonly PartName[] => ["year", "month", "day"];

/** The tier-2 type this package offers beside the engine's: it reads as a `date` (the definition's `kinds` map). */
export const ONTARIO_DATE_TYPE = "ontario-date";

const TEXT_KEYS = { day: "dateDay", month: "dateMonth", year: "dateYear" } as const;

const isoParts = (value: string): DateParts => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? { year: match[1] as string, month: match[2] as string, day: match[3] as string } : { year: "", month: "", day: "" };
};

/** The three boxes' values as they stand. */
const readParts = (group: Element): DateParts => {
  const read = (part: PartName): string => group.querySelector<HTMLInputElement>(`[data-value-part="${part}"]`)?.value ?? "";
  return { year: read("year"), month: read("month"), day: read("day") };
};

/**
 * The value ontario-date-input holds for a whole, real date: the ISO timestamp it computes itself
 * (`2026-05-14T00:00:00.000Z`), so a draw that echoes the parts back is equal to what the component holds
 * and `live()` writes nothing (a write would re-pad the box being typed in). Anything short of a real date
 * is "", which is also what the component holds for it.
 */
export function isoOf(parts: DateParts): string {
  const [year, month, day] = [parts.year, parts.month, parts.day].map((part) => (/^\d+$/.test(part) ? Number(part) : NaN)) as [number, number, number];
  if (!/^\d{4}$/.test(parts.year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return "";
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day ? date.toISOString() : "";
}

/** The check ontario-date-input runs on blur, answered "nothing wrong": Datum is the validator. */
const noCheck = (): { dayInvalid: boolean; monthInvalid: boolean; yearInvalid: boolean; errorMessage: string } => ({ dayInvalid: false, monthInvalid: false, yearInvalid: false, errorMessage: "" });

/** The parts last reported or drawn, per component: an event carries one part, the renderer wants all three. */
const lastParts = new WeakMap<Element, DateParts>();

let invalidSheet: CSSStyleSheet | undefined;
/** The invalid look inside the component (its stylesheet cannot be reached from outside). */
const invalid = (): CSSStyleSheet => {
  if (!invalidSheet) {
    invalidSheet = new CSSStyleSheet();
    invalidSheet.replaceSync(".datum-ontario-invalid { border: 0.125rem solid var(--ontario-colour-system-alert, #cd0000) !important; }");
  }
  return invalidSheet;
};

export function createDate(lit: Lit, datum: LiveBinding): { date: FieldAdapter<DateFieldState>; ontarioDate: FieldAdapter<DateFieldState> } {
  const { html, nothing, ifDefined, live } = lit;
  /** Datum's date: its focus target reads the boxes marked `data-value-part` in the order they stand. */
  const datumDate = datum.components.date as FieldAdapter<DateFieldState> | undefined;

  /** The error line as `ErrorMessage` draws it inside a component: Ontario's icon and the message. */
  const errorLine = (message: string | undefined, id?: string, describes = false) =>
    message === undefined
      ? nothing
      : html`<div role="alert" id=${ifDefined(id)} class="datum-ontario-error" data-describes=${describes ? "" : nothing}><ontario-icon-alert-error></ontario-icon-alert-error><div class="datum-ontario-error__content">${message}</div></div>`;

  // ── Tier 2: Datum's date in Ontario's HTML ─────────────────────────────────────────────
  const date: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "ontario-datum-date",
    // The worked-out line is drawn with the hint's styling, under the id the state names.
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", workedOut: "drawn" },
    template(s, on) {
      const parts = s.parts ?? isoParts(s.value);
      const invalidDate = s.invalid;
      const report = (event: Event, interim: boolean): void => {
        const group = (event.currentTarget as Element).closest("[data-date-parts]");
        if (group) {
          on.parts(readParts(group), interim ? { interim: true } : undefined);
        }
      };
      // The field is left only when focus goes out of the whole group: tabbing year to month checks nothing.
      const left = (event: FocusEvent): void => {
        const into = event.relatedTarget;
        if (!(into instanceof Node && (event.currentTarget as Element).contains(into))) {
          on.commit();
        }
      };
      const box = (part: PartName) =>
        html`<div class="datum-ontario-date__part"
          ><label class="datum-ontario-date__label" for=${`${s.id}__${part}`}>${s.words(TEXT_KEYS[part])}</label
          ><input
            id=${`${s.id}__${part}`}
            class=${invalidDate ? "datum-ontario-input datum-ontario-input--invalid" : "datum-ontario-input"}
            data-value-part=${part}
            type="text"
            inputmode="numeric"
            .value=${live(parts[part])}
            autocomplete=${ifDefined(s.model.autocomplete ? `${s.model.autocomplete}-${part}` : undefined)}
            ?required=${s.required}
            ?disabled=${s.disabled}
            ?readonly=${s.readOnly}
            aria-invalid=${ifDefined(invalidDate ? "true" : undefined)}
            @input=${(event: Event) => report(event, true)}
            @change=${(event: Event) => report(event, false)}
          /></div
        >`;
      const marker = s.words(s.required ? "required" : "optional");
      return html`<fieldset class="datum-ontario-date" role="group" aria-describedby=${ifDefined(s.describedBy.length > 0 ? s.describedBy.join(" ") : undefined)}>
        <legend id=${s.labelId} class="datum-ontario-legend">${s.label}${marker === "" ? nothing : html`<span class="datum-ontario-flag">${marker}</span>`}</legend>
        ${s.hint !== undefined && s.hintId !== undefined ? html`<p id=${s.hintId} class="datum-ontario-hint">${s.hint}</p>` : nothing}
        ${s.workedOut !== undefined && s.workedOutId !== undefined ? html`<p id=${s.workedOutId} class="datum-ontario-hint" data-worked-out>${s.workedOut}</p>` : nothing}
        ${s.errors.length > 0 ? errorLine(messageOf(s.errors), s.errorId) : nothing}
        <div class="datum-ontario-date__group" data-date-parts @focusout=${left}>${ontarioDateOrder().map(box)}</div>
        ${noticesOf(lit, s)}
      </fieldset>`;
    },
    ready: async (field) => {
      await Promise.all(Array.from(field.querySelectorAll<Hydrating>("ontario-icon-alert-error"), (element) => element.componentOnReady?.()));
    },
    // The first part the date still lacks, in the order drawn: Datum's own focus on part boxes (what was typed, even before a draw).
    focusTarget: (wrapper, s) => datumDate?.focusTarget?.(wrapper, s) ?? wrapper.querySelector<HTMLElement>("[data-value-part]")
  };

  // ── Tier 2: the official <ontario-date-input>, under its own type ──────────────────────
  /** The group inside the component, where its description lives, and the hint it draws there (the same shadow tree, so it can be named). */
  const groupOf = (field: HTMLElement): HTMLElement | null => field.querySelector("ontario-date-input")?.shadowRoot?.querySelector<HTMLElement>("fieldset") ?? null;
  const hintOf = (field: HTMLElement): Element[] => {
    const hint = field.querySelector("ontario-date-input")?.shadowRoot?.querySelector('p[id^="date-input-hint-"]');
    return hint ? [hint] : [];
  };
  const ontarioDate: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "ontario-date-input",
    // The component words its own hint, so the renderer folds the worked-out line into it.
    capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", workedOut: "degraded" },
    idsWrittenBy: "component",
    template: (s, on) => {
      const parts = s.parts ?? isoParts(s.value);
      const report = (event: Event) => {
        const host = event.currentTarget as Element;
        const detail = (event as CustomEvent<{ value: string; fieldType: PartName }>).detail;
        const next = { ...(lastParts.get(host) ?? parts), [detail.fieldType]: detail.value };
        lastParts.set(host, next);
        on.parts(next);
      };
      return html`<ontario-date-input
          element-id=${s.id}
          caption=${captionOf(s.label)}
          hint-text=${ifDefined(s.hint)}
          .value=${live(isoOf(parts))}
          .dateValidator=${noCheck}
          ?required=${s.required && !s.disabled}
          language=${languageOf(s.locale)}
          @inputOnInput=${report}
          @inputOnChange=${(event: Event) => {
            report(event);
            on.commit();
          }}
        ></ontario-date-input>${errorLine(messageOf(s.errors), undefined, true)}${noticesOf(lit, s)}`;
    },
    after(field, s) {
      const host = field.querySelector("ontario-date-input");
      if (host) {
        lastParts.set(host, { ...(s.parts ?? isoParts(s.value)) });
        // The invalid look, inside the component.
        const root = host.shadowRoot;
        if (root && !root.adoptedStyleSheets.includes(invalid())) {
          root.adoptedStyleSheets = [...root.adoptedStyleSheets, invalid()];
        }
      }
      applyModes(field, "ontario-date-input", s);
      for (const box of boxesIn(field, "ontario-date-input")) {
        box.classList.toggle("datum-ontario-invalid", s.errors.length > 0);
      }
      reflectDescription(field, host, groupOf(field), hintOf(field));
    },
    connect: (field) => keepDescription(field, () => field.querySelector("ontario-date-input"), () => groupOf(field), () => hintOf(field)),
    ready: readyOf("ontario-date-input"),
    focusTarget: (field) => boxesIn(field, "ontario-date-input")[0]
  };

  return { date, ontarioDate };
}
