/**
 * The GC Design System text and number fields on the engine's binding contract.
 *
 * Datum's `text` and `number` drawn with GC Design System's own components, in two adapters each
 * that the renderer picks between by `when`: the real `<gcds-input>` for the usual field (a number
 * is `type="number"`), and, for a field with a prefix or suffix that `<gcds-input>` cannot draw, a
 * field built from GC Design System's label, hint and error-message components around a native box.
 *
 * Capabilities are answered as data (drawn | degraded | none):
 * - hint, autocomplete, inputmode: the component draws them (no capability: always).
 * - tooltip, pending, workedOut: degraded, folded into the hint by the renderer.
 * - notice: degraded, drawn beside the component with hint styling (gcds-notice and gcds-alert are
 *   page banners with a heading, which does not belong inside a field).
 * - characterCount: drawn beside the component; the renderer's announcer reads it out.
 * - prefix, suffix: drawn by the second adapter; placeholder: none (GC Design System has none).
 */
import type { FieldAdapter, NumberFieldState, TextFieldState } from "../../../engine/form-engine/render/live/contract.js";
import { boxesIn, hintOf, keepDescription, languageOf, messageOf, noticesOf, readyOf, reflectDescription, valueOf, type Hydrating, type Lit } from "./shared.js";

type TextAdapter = FieldAdapter<TextFieldState>;
type NumberAdapter = FieldAdapter<NumberFieldState>;

/** The box inside a field: the native one the binding drew, else the one inside gcds-input. */
const boxOf = (field: HTMLElement): HTMLInputElement | null => field.querySelector<HTMLInputElement>(".datum-gcds-affix > input") ?? (boxesIn(field, "gcds-input")[0] as HTMLInputElement | undefined) ?? null;

const CAPABILITIES = {
  notice: "degraded",
  pending: "degraded",
  tooltip: "degraded",
  // The components word their own hint, so the renderer folds the worked-out line into it.
  workedOut: "degraded",
  characterCount: "drawn",
  prefix: "drawn",
  suffix: "drawn",
  hideLabel: "drawn",
  placeholder: "none"
} as const;

/** What a number box reports: a number for what reads as one, the empty string for none, `badInput` for text the browser could not read. */
const numberReport = (host: HTMLElement, box: HTMLInputElement | null | undefined): { value: number | string; badInput?: boolean } => {
  const text = String((host as HTMLElement & { value?: unknown }).value ?? box?.value ?? "");
  if (text === "") {
    return box?.validity.badInput ? { value: "", badInput: true } : { value: "" };
  }
  const number = Number(text);
  return { value: Number.isFinite(number) ? number : text };
};

/** Whether the box's text already stands for the stored number ("0002" for 2): left as typed, so the caret keeps its place. */
const standsFor = (typed: string, stored: string): boolean => (typed === "" || stored === "" ? typed === stored : Number(typed) === Number(stored));

export function createText(lit: Lit): { text: TextAdapter[]; number: NumberAdapter[] } {
  const { html, nothing, ifDefined, live } = lit;

  /**
   * The count under the box, placed and worded as gcds-textarea draws its own: the limit sentence
   * for screen readers only (it carries the id Datum describes the control by), and the figure as
   * it stands, hidden from assistive technology (it changes on every keystroke). Reading the
   * count out once typing pauses is the renderer's announcer.
   */
  const countLine = (s: TextFieldState) =>
    s.characterCount === undefined
      ? nothing
      : html`<div class=${s.characterCount.over ? "datum-gcds-count datum-gcds-count--over" : "datum-gcds-count"}>
          <gcds-sr-only tag="span" id=${s.characterCount.limitId} data-describes>${s.characterCount.limit}</gcds-sr-only>
          <gcds-text aria-hidden="true" margin-bottom="0">${s.characterCount.status}</gcds-text>
        </div>`;

  const spell = (box: HTMLInputElement | null, s: TextFieldState): void => {
    if (!box) {
      return;
    }
    if (s.spellcheck === undefined) {
      box.removeAttribute("spellcheck");
    } else {
      box.setAttribute("spellcheck", String(s.spellcheck));
    }
  };

  /** Where a summary link lands: `<gcds-input>` delegates focus to its own box; the affixed field's box is the binding's. */
  const focusTarget = (field: HTMLElement): HTMLElement | null => field.querySelector<HTMLElement>("gcds-input") ?? boxOf(field);

  const connect = (field: HTMLElement): (() => void) => keepDescription(field, () => boxOf(field));

  /** gcds-label, gcds-hint and gcds-error-message draw themselves: wait for this field's own, never the whole form. */
  const readyAffixed = async (field: HTMLElement): Promise<void> => {
    await Promise.all(Array.from(field.querySelectorAll<Hydrating>("gcds-label, gcds-hint, gcds-error-message"), (element) => element.componentOnReady?.()));
  };

  /** The usual field: the real `<gcds-input>`. */
  const gcdsInput: TextAdapter = {
    kind: "field",
    name: "gcds-input",
    capabilities: CAPABILITIES,
    // gcds-input writes `hint-<id>` and `error-message-<id>` inside its shadow root.
    idsWrittenBy: "component",
    template: (s, on) => html`<gcds-input
        input-id=${s.id}
        name=${s.name}
        label=${s.label}
        ?hide-label=${s.hideLabel}
        hint=${ifDefined(hintOf(s))}
        .value=${live(s.value)}
        ?required=${s.required && !s.disabled}
        ?disabled=${s.disabled}
        ?readonly=${s.readOnly}
        error-message=${ifDefined(messageOf(s.errors))}
        minlength=${ifDefined(s.minLength)}
        pattern=${ifDefined(s.pattern)}
        autocomplete=${ifDefined(s.autocomplete)}
        inputmode=${ifDefined(s.inputMode)}
        lang=${languageOf(s.locale)}
        validate-on="other"
        @input=${(event: Event) => on.input(valueOf(event), { interim: true })}
        @change=${() => on.commit()}
      ></gcds-input>${noticesOf(lit, s)}${countLine(s)}`,
    // `<gcds-input>` has no spell-check setting, so the attribute goes on the box inside it.
    after(field, s) {
      const box = boxOf(field);
      spell(box, s);
      reflectDescription(field, box);
    },
    ready: readyOf("gcds-input"),
    connect,
    focusTarget
  };

  /** A field with a sign or a unit: GC Design System's label, hint and error pieces around a native box. */
  const affixed = (type: "text" | "number"): TextAdapter => ({
    kind: "field",
    name: type === "number" ? "gcds-affixed-number" : "gcds-affixed",
    when: (s) => s.prefix !== undefined || s.suffix !== undefined,
    capabilities: CAPABILITIES,
    // The ids are the ones gcds-hint and gcds-error-message write (`hint-<id>`, `error-message-<id>`) in this same tree.
    idsWrittenBy: "component",
    template(s, on) {
      const invalid = s.errors.length > 0;
      const hint = hintOf(s);
      // The component-written ids first, then the ones Datum names (the notices, the count's limit sentence).
      const describedBy = [hint ? `hint-${s.id}` : "", invalid ? `error-message-${s.id}` : "", ...s.describedBy.filter((id) => id === s.noticeId || id === s.characterCount?.limitId)].filter((id) => id !== "").join(" ");
      const affix = (text: string | undefined) => (text === undefined ? nothing : html`<span class="datum-gcds-affix__text" aria-hidden="true">${text}</span>`);
      const number = s as NumberFieldState;
      return html`<div class="datum-gcds-field">
        <gcds-label label=${s.label} label-for=${s.id} ?required=${s.required} ?hide-label=${s.hideLabel} lang=${languageOf(s.locale)}></gcds-label>
        ${hint ? html`<gcds-hint hint-id=${s.id}>${hint}</gcds-hint>` : nothing}
        ${invalid ? html`<gcds-error-message message-id=${s.id}>${messageOf(s.errors)}</gcds-error-message>` : nothing}
        <div class=${invalid ? "datum-gcds-affix datum-gcds-affix--invalid" : "datum-gcds-affix"}>
          ${affix(s.prefix)}
          <input
            id=${s.id}
            name=${s.name}
            type=${type}
            .value=${type === "number" ? nothing : live(s.value)}
            min=${ifDefined(type === "number" ? number.min : undefined)}
            max=${ifDefined(type === "number" ? number.max : undefined)}
            step=${ifDefined(type === "number" ? number.step : undefined)}
            minlength=${ifDefined(s.minLength)}
            pattern=${ifDefined(s.pattern)}
            autocomplete=${ifDefined(s.autocomplete)}
            inputmode=${ifDefined(s.inputMode)}
            spellcheck=${ifDefined(s.spellcheck === undefined ? undefined : String(s.spellcheck))}
            aria-describedby=${ifDefined(describedBy === "" ? undefined : describedBy)}
            aria-invalid=${ifDefined(s.invalid ? "true" : undefined)}
            ?required=${s.required}
            ?disabled=${s.disabled}
            ?readonly=${s.readOnly}
            @input=${(event: Event) => {
              const box = event.target as HTMLInputElement;
              if (type === "number") {
                const { value, badInput } = numberReport(box, box);
                on.input(value, badInput ? { interim: true, badInput } : { interim: true });
              } else {
                on.input(box.value, { interim: true });
              }
            }}
            @change=${() => on.commit()}
          />
          ${affix(s.suffix)}
        </div>
        ${noticesOf(lit, s)}${countLine(s)}
      </div>`;
    },
    // The box is the binding's own: the spell-check mark, and for a number the value (a number box keeps what was typed while it stands for the stored number).
    after(field, s) {
      const box = boxOf(field);
      spell(box, s);
      if (type === "number" && box && !standsFor(box.value, s.value)) {
        box.value = s.value;
      }
    },
    ready: readyAffixed,
    focusTarget
  });

  /** A number as `<gcds-input type="number">`: a number box keeps what was typed while it stands for the stored number, so its value is written in `after`. */
  const gcdsNumber: NumberAdapter = {
    kind: "field",
    name: "gcds-input-number",
    capabilities: CAPABILITIES,
    idsWrittenBy: "component",
    template: (s, on) => html`<gcds-input
        input-id=${s.id}
        name=${s.name}
        type="number"
        label=${s.label}
        ?hide-label=${s.hideLabel}
        hint=${ifDefined(hintOf(s))}
        ?required=${s.required && !s.disabled}
        ?disabled=${s.disabled}
        ?readonly=${s.readOnly}
        error-message=${ifDefined(messageOf(s.errors))}
        min=${ifDefined(s.min)}
        max=${ifDefined(s.max)}
        step=${ifDefined(s.step)}
        autocomplete=${ifDefined(s.autocomplete)}
        inputmode=${ifDefined(s.inputMode)}
        lang=${languageOf(s.locale)}
        validate-on="other"
        @input=${(event: Event) => {
          const host = event.currentTarget as HTMLElement;
          const { value, badInput } = numberReport(host, host.shadowRoot?.querySelector("input"));
          on.input(value, badInput ? { interim: true, badInput } : { interim: true });
        }}
        @change=${() => on.commit()}
      ></gcds-input>${noticesOf(lit, s)}`,
    after(field, s) {
      const host = field.querySelector<HTMLElement & { value?: string }>("gcds-input");
      const box = boxOf(field);
      spell(box, s);
      if (host && !standsFor(String(host.value ?? ""), s.value)) {
        host.value = s.value;
      }
      reflectDescription(field, box);
    },
    ready: readyOf("gcds-input"),
    connect,
    focusTarget
  };

  // The renderer tries the affixed field by its `when`, else the usual one.
  return { text: [affixed("text"), gcdsInput], number: [affixed("number") as unknown as NumberAdapter, gcdsNumber] };
}
