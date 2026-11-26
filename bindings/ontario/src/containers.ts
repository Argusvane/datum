/**
 * The Ontario Design System group, data grid and steps on the engine's contract.
 *
 * - `fieldset`: the real `<ontario-fieldset>`, a legend and a slot. The children are slotted, so they
 *   stay in Datum's shadow root and every id, label and summary link inside reaches them as before. It
 *   has no hint, so the group's help is the design system's hint component, slotted first. The legend
 *   cannot be hidden (`hideLabel` unanswered: none). A top-level group takes the large legend. The
 *   `<fieldset>` is in the component's shadow root, where no id in the form's tree can be named, so the
 *   binding describes it by element reflection: by a copy of the hint out of sight (the hint
 *   component's own text is in yet another shadow root) and, for a grid, by its error (`describedFieldset`).
 * - `dataGrid`: Ontario has no table of inputs (`ontario-table` shows data), so the rows are stacked,
 *   each row an `<ontario-fieldset>` named by its number, its buttons real `<ontario-button>`s
 *   (`layouts: ["stacked"]`: the renderer keeps the cells' labels whatever layout the author chose). The
 *   row's name is always drawn, so `showRowNumbers: false` cannot be honoured (`rowNumbers: degraded`).
 * - `steps`: each step is a panel headed by the real `<ontario-step-indicator>` ("Step 2 of 3") over the
 *   step's name as a heading; Back and Continue are `<ontario-button>`s. Ontario has no step list to
 *   jump to, so no step is selectable.
 * No tabs: nothing in Ontario fits them, so Datum's own draw them in the design system's tokens
 * (`fallbackTokens`).
 *
 * Ontario's buttons take no `disabled` (its policy): a button that cannot be pressed now, or a busy
 * form, draws `aria-disabled` on the button inside (`busyButton`) and drops the press.
 */
import type { GridAdapter, GroupAdapter, StepsAdapter } from "../../../engine/form-engine/render/live/contract.js";
import { busyButton, headingOf, languageOf, type Hydrating, type Lit } from "./shared.js";

/**
 * A `ref` callback for an `<ontario-fieldset>`: its `<fieldset>` (in the component's shadow root) is
 * described by the elements of the form's tree with these ids, by element reflection. Run every draw
 * and again once the component has drawn itself; the children are committed after the element's own
 * parts, so the first draw is answered by the second run.
 */
const describedFieldset =
  (ids: ReadonlyArray<string | undefined>) =>
  (element: Element | undefined): void => {
    if (!element) {
      return;
    }
    const apply = (): void => {
      const box = element.shadowRoot?.querySelector("fieldset") as (HTMLElement & { ariaDescribedByElements?: readonly Element[] | null }) | null | undefined;
      if (!box || !("ariaDescribedByElements" in box)) {
        return;
      }
      const tree = element.getRootNode() as Document | ShadowRoot;
      const next = ids.flatMap((id) => {
        const found = id === undefined || id === "" ? null : tree.querySelector(`[id="${CSS.escape(id)}"]`);
        return found ? [found] : [];
      });
      const current = box.ariaDescribedByElements ?? [];
      if (next.length === current.length && next.every((described, index) => described === current[index])) {
        return;
      }
      box.ariaDescribedByElements = next.length === 0 ? null : next;
    };
    apply();
    void (element as Hydrating).componentOnReady?.().then(apply);
  };

export function createContainers(lit: Lit): { fieldset: GroupAdapter; dataGrid: GridAdapter; steps: StepsAdapter } {
  const { html, nothing, ifDefined, ref } = lit;

  /** The group's help: Ontario's hint component, and the same words out of sight under the id the state names, for the fieldset to be described by. */
  const hintOf = (s: { id: string; hint?: string | undefined; hintId?: string | undefined }) =>
    s.hint ? html`<ontario-hint-text hint=${s.hint}></ontario-hint-text><span hidden id=${hintIdOf(s)} data-hint-copy>${s.hint}</span>` : nothing;
  const hintIdOf = (s: { id: string; hintId?: string | undefined }): string => s.hintId ?? `${s.id}__description`;

  const fieldset: GroupAdapter = {
    kind: "group",
    name: "ontario-fieldset",
    capabilities: { hideLabel: "none" },
    template: (s, children) =>
      s.legend === undefined
        ? html`<div class="datum-ontario-group">${children}</div>`
        : html`<ontario-fieldset legend=${s.legend} legend-size=${s.level === 1 ? "large" : "default"} ${ref(describedFieldset([s.hint ? hintIdOf(s) : undefined]))}>
            ${hintOf(s)}<div class="datum-ontario-group">${children}</div>
          </ontario-fieldset>`
  };

  const dataGrid: GridAdapter = {
    kind: "grid",
    name: "ontario-stacked-grid",
    layouts: ["stacked"],
    capabilities: { rowNumbers: "degraded" },
    template: (s) => {
      const lang = languageOf(s.locale);
      // The row's name is in the button's accessible name (aria-label-text), so after a move or a removal the button still says the right row.
      const button = (offered: boolean, press: (() => void) | undefined, caption: string, row: { label: string; index: number }, action: string) =>
        offered
          ? html`<ontario-button
              type="secondary"
              label=${caption}
              aria-label-text=${`${caption}, ${row.label}`}
              data-row-action=${action}
              ${ref(busyButton(press === undefined))}
              @click=${() => press?.()}
            ></ontario-button>`
          : nothing;
      const rows = s.eachRow(
        (row) => html`<ontario-fieldset legend=${row.label} legend-size="default">
          <div class="datum-ontario-group">
            ${row.cells.map((cell) => cell.content)}
            <div class="datum-ontario-row-actions">
              ${button(s.offers.reorder, row.moveUp, s.captions.moveUp, row, "up")}
              ${button(s.offers.reorder, row.moveDown, s.captions.moveDown, row, "down")}
              ${button(s.offers.remove, row.remove, s.captions.remove, row, "remove")}
            </div>
          </div>
        </ontario-fieldset>`
      );
      const empty = s.rows.length === 0 ? html`<p class="datum-ontario-hint">${s.captions.empty}</p>` : nothing;
      const add = s.offers.add
        ? html`<div class="datum-ontario-row-actions"><ontario-button type="secondary" label=${s.captions.add} id=${s.addId} data-row-action="add" language=${lang} ${ref(busyButton(s.add === undefined))} @click=${() => s.add?.()}></ontario-button></div>`
        : nothing;
      const errorId = s.errorId ?? `${s.id}__error`;
      const error = s.errors.length > 0 ? html`<div role="alert" id=${errorId} class="datum-ontario-error"><ontario-icon-alert-error></ontario-icon-alert-error><div class="datum-ontario-error__content">${s.errors.join("; ")}</div></div>` : nothing;
      return s.legend === undefined
        ? html`<div class="datum-ontario-group">${error}${empty}${rows}${add}</div>`
        : html`<ontario-fieldset legend=${s.legend} legend-size=${s.level === 1 ? "large" : "default"} ${ref(describedFieldset([s.hint ? hintIdOf(s) : undefined, s.errors.length > 0 ? errorId : undefined]))}>
            ${hintOf(s)}<div class="datum-ontario-group">${error}${empty}${rows}${add}</div>
          </ontario-fieldset>`;
    }
  };

  const steps: StepsAdapter = {
    kind: "steps",
    name: "ontario-step-indicator",
    // A step's heading is drawn as a heading and can be kept for assistive technology only.
    capabilities: { hideLabel: "drawn" },
    template(state) {
      const lang = languageOf(state.locale);
      const heading = (step: { headingId: string; label: string; hideLabel: boolean }, level: number) =>
        headingOf(lit, level, { id: step.headingId, className: step.hideLabel ? `ontario-show-for-sr` : `ontario-h${Math.min(6, Math.max(1, level))}`, tabindex: "-1" }, step.label);
      if (state.flat || state.steps.length === 0) {
        return html`<div class="datum-ontario-steps" data-step-container=${state.id}>
          ${state.eachStep(
            (step) => html`<section class="datum-ontario-step" data-step-panel=${step.id} aria-labelledby=${step.headingId}>
              ${heading(step, Math.min(6, Math.max(2, state.level + 1)))}
              <div class="datum-ontario-group">${step.content}</div>
            </section>`
          )}${state.others}
        </div>`;
      }
      const total = state.steps.length;
      const level = Math.min(6, Math.max(2, state.level + 1));
      const panels = state.eachStep((step) => {
        const number = state.steps.indexOf(step) + 1;
        return html`<section class="datum-ontario-step" data-step-panel=${step.id} data-step-container=${state.id} aria-labelledby=${step.headingId} ?hidden=${!step.shown}>
          <ontario-step-indicator current-step=${number} number-of-steps=${total} language=${lang}></ontario-step-indicator>
          ${heading(step, level)}
          <div class="datum-ontario-group">${step.content}</div>
        </section>`;
      });
      // A busy form draws aria-disabled, never disabled, on the button inside (busyButton); the press is dropped here.
      const back = state.back;
      const next = state.next;
      return html`<div class="datum-ontario-steps" data-step-container=${state.id} data-step-active=${ifDefined(state.activeStepId ?? "")}>
        ${panels}${state.others}
        <div class="datum-ontario-page-actions">
          ${next ? html`<ontario-button type="primary" label=${next.label} data-step-next ${ref(busyButton(state.busy))} @click=${() => (state.busy ? undefined : next.go())}></ontario-button>` : nothing}
          ${back ? html`<ontario-button type="secondary" label=${back.label} data-step-prev ${ref(busyButton(state.busy))} @click=${() => (state.busy ? undefined : back.go())}></ontario-button>` : nothing}
        </div>
      </div>`;
    }
  };

  return { fieldset, dataGrid, steps };
}
