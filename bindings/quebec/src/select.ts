/**
 * The select, in its two tiers.
 *
 * `qc-select` is a custom listbox: the native `<select>` written inside it is hidden, and a button
 * and a list in the component's own shadow root stand for it, with search, multiple choice and its
 * own keys. That is drastically different from a Datum select (a native `<select>`: the browser's
 * list, its keys and its autofill), so by the binding author's judgement:
 *
 * - `select` (tier 2's drawing): Datum's native select in the toolkit's markup, label,
 *   `.qc-description`, `.qc-form-error` and the text field's box face from its tokens (css.ts);
 * - `qc-select`, the package type with base `select` (plugin.ts): the official component, with a
 *   guard of its own for read-only (the renderer's guard knows native selects), the button as the
 *   focus target, and the help text and errors as the description of the control it cannot name.
 *   Under another binding the lookup chain draws the base.
 *
 * The component reads its label, options and `selected` from the light DOM and inserts the label as
 * HTML (escaped here). It writes `invalid` away when the person types, so `invalid` is bound as a
 * property through `live()`.
 */
import type { FieldAdapter, SelectFieldState } from "../../../engine/form-engine/render/live/contract.js";
import { cls, describeText, description, errorText, esc, formError, labelText, notices, readOnlyGuard, readyWhen, type Lit } from "./shared.js";

const CAPABILITIES = { notice: "drawn", pending: "degraded", tooltip: "degraded", workedOut: "degraded", hideLabel: "drawn", placeholder: "drawn" } as const;

export function createSelects(lit: Lit) {
  const { html, live, ifDefined, nothing } = lit;

  const said = (s: SelectFieldState): string[] => [...s.errors, ...s.notices.map((notice) => notice.message)];

  // ── Tier 2's drawing: Datum's native select in the toolkit's face ─────────────────────────

  const select: FieldAdapter<SelectFieldState> = {
    kind: "field",
    name: "qc-select-native",
    capabilities: CAPABILITIES,
    template(s, on) {
      const invalid = s.errors.length > 0;
      return html`<div class=${cls("datum-qc-select", invalid && "datum-qc-select--invalid")}>
        ${s.hideLabel ? nothing : html`<label class="qc-label" for=${s.id}>${labelText(lit, s.label, s.required)}</label>`}
        ${description(lit, s)}
        <select
          id=${s.id}
          name=${s.name}
          class="datum-qc-select__control"
          aria-label=${ifDefined(s.hideLabel ? s.label : undefined)}
          aria-describedby=${ifDefined(s.describedBy.length > 0 ? s.describedBy.join(" ") : undefined)}
          aria-invalid=${s.invalid ? "true" : nothing}
          aria-required=${s.required ? "true" : nothing}
          ?disabled=${s.disabled}
          @change=${(event: Event) => {
            on.input((event.target as HTMLSelectElement).value);
            on.commit();
          }}
        >
          <option value="" .selected=${live(s.value === "")}>${s.emptyLabel}</option>
          ${s.options.map((option) => html`<option value=${option.value} .selected=${live(option.checked)}>${option.label}</option>`)}
        </select>
        ${formError(lit, s, "qc-xs-mt")}${notices(lit, s)}
      </div>`;
    }
    // Read-only: the renderer's guard stops the list and the keys of a native select, and marks it aria-readonly.
  };

  // ── The official component, the package type `qc-select` ──────────────────────────────────

  const nativeOf = (field: HTMLElement): HTMLSelectElement | null => field.querySelector<HTMLSelectElement>("qc-select > select");
  const buttonOf = (field: HTMLElement): HTMLElement | null => field.querySelector("qc-select")?.shadowRoot?.querySelector<HTMLElement>("button[role=combobox], button") ?? null;

  const listbox: FieldAdapter<SelectFieldState> = {
    kind: "field",
    name: "qc-select",
    capabilities: CAPABILITIES,
    // The error is drawn inside the component's shadow root, whose ids the native select cannot name.
    idsWrittenBy: "component",
    template: (s, on) => html`${description(lit, s, "datum-qc-select-description")}<qc-select
        label=${s.hideLabel ? nothing : esc(s.label)}
        placeholder=${esc(s.emptyLabel)}
        ?required=${s.required}
        ?disabled=${s.disabled}
        .invalid=${live(s.errors.length > 0)}
        invalid-text=${ifDefined(errorText(s))}
        ><select
          id=${s.id}
          name=${s.name}
          aria-label=${ifDefined(s.hideLabel ? s.label : undefined)}
          aria-describedby=${ifDefined(s.hint !== undefined && s.hint !== "" ? s.hintId : undefined)}
          ?disabled=${s.disabled}
          .value=${live(s.value)}
          @change=${(event: Event) => {
            on.input((event.target as HTMLSelectElement).value);
            on.commit();
          }}
        >
          <option value="" ?selected=${s.value === ""}>${s.emptyLabel}</option>
          ${s.options.map((option) => html`<option value=${option.value} ?selected=${option.checked}>${option.label}</option>`)}
        </select></qc-select
      >${notices(lit, s)}`,
    after(field, s) {
      const text = { hint: s.hint, errors: said(s) };
      describeText(buttonOf(field), text);
      describeText(nativeOf(field), text);
    },
    // qc-select's list and button are its own: the renderer's guard (a native select in the event's path) never sees them.
    guard: readOnlyGuard("qc-select"),
    // The native select is hidden by the component: focus goes to the button that stands for it.
    focusTarget: (field) => buttonOf(field) ?? nativeOf(field),
    ready: readyWhen("qc-select", (host) => host.shadowRoot?.querySelector("button") != null)
  };

  return { select, listbox };
}
