/**
 * The GC Design System group, data grid and steps on the engine's contract.
 *
 * - `fieldset`: the real `<gcds-fieldset>`; the children are slotted, so they stay in Datum's
 *   shadow root and every id, label and summary link inside reaches them as before. It requires a
 *   legend and a heading size: a group with no name is a plain group, and the size follows how
 *   deep the group sits (a top-level group is an h2).
 * - `dataGrid`: GC Design System has no table of inputs, so the rows are stacked, each row a
 *   `<gcds-fieldset>` named by its number, its buttons real `<gcds-button>`s (`layouts:
 *   ["stacked"]`: the renderer keeps the cells' labels whatever layout the author chose). The rows,
 *   the bounds and the focus after a button are the renderer's. A grid's legend cannot be hidden
 *   (`hideLabel` unanswered: none, which the renderer reports).
 * - `steps`: each step is a panel headed by the real `<gcds-stepper>` ("Step 2 of 3" and the
 *   step's name, as a heading), Back and Continue are `<gcds-button>`s. The stepper's heading is
 *   h1 to h3 only, so a deeply nested steps container still heads at h3. GC Design System has no
 *   step list to jump to, so no step is selectable.
 * - `panel`: GC Design System has no panel, so it is a `<section>` named by a real `<gcds-heading>`
 *   (the level under the form's, as the fieldset's legend size is), its hint the design system's own
 *   `<gcds-hint>`, then the children. Plain by default (heading and fields, no box). The author's
 *   panel looks (`panel-outlined`, `panel-shaded`, `panel-card`, declared in `GCDS_PANEL_LOOKS`)
 *   are classes on the section; their CSS is in css.ts, written from the design system's tokens.
 * No tabs: nothing in GC Design System fits them, so Datum's own draw them in the design system's
 * tokens (`fallbackTokens`).
 */
import type { CssClassDeclaration, GridAdapter, GroupAdapter, StepsAdapter } from "../../../engine/form-engine/render/live/contract.js";
import { busyButton, languageOf, type Lit } from "./shared.js";

/**
 * The looks of a panel this binding draws: the engine's shared vocabulary (render/live/look-classes.ts,
 * restated here because the binding never imports the engine at run time; a test keeps the two equal).
 * The binding's default, with none ticked, is plain.
 */
const PANEL_LOOK_GROUP = "panel-look";
export const GCDS_PANEL_LOOKS: readonly CssClassDeclaration[] = [
  { name: "panel-plain", label: "Plain", description: "The heading with the fields under it: no border, no background, no header band.", types: ["panel"], group: PANEL_LOOK_GROUP },
  { name: "panel-outlined", label: "Outlined", description: "A border around the panel, with no header band and no fill.", types: ["panel"], group: PANEL_LOOK_GROUP },
  { name: "panel-shaded", label: "Shaded", description: "A light background behind the panel, with no border.", types: ["panel"], group: PANEL_LOOK_GROUP },
  { name: "panel-card", label: "Card", description: "A border, a header band behind the heading and a surface for the fields.", types: ["panel"], group: PANEL_LOOK_GROUP }
];

/** `classNames` with only the last panel look kept (the one paper and the Style tab pick): CSS cannot follow a class list's order, so two looks on one section would be decided by the sheet instead. Restated from the engine's `lastLookOnly`, as the looks are. */
function lastLookOnly(classNames: readonly string[]): string[] {
  const looks = new Set(GCDS_PANEL_LOOKS.map((look) => look.name));
  const last = classNames.reduce((found, name, index) => (looks.has(name) ? index : found), -1);
  return classNames.filter((name, index) => !looks.has(name) || index === last);
}

export function createContainers(lit: Lit): { fieldset: GroupAdapter; panel: GroupAdapter; dataGrid: GridAdapter; steps: StepsAdapter } {
  const { html, nothing, ifDefined, ref } = lit;

  const fieldset: GroupAdapter = {
    kind: "group",
    name: "gcds-fieldset",
    // The legend can be neither hidden nor made optional; the hint is the component's.
    capabilities: { hideLabel: "none" },
    template: (s, children) =>
      s.legend === undefined
        ? html`<div class="datum-gcds-group">${children}</div>`
        : html`<gcds-fieldset legend=${s.legend} legend-size=${`h${Math.min(6, s.level + 1)}`} hint=${ifDefined(s.hint)} lang=${languageOf(s.locale)}>${children}</gcds-fieldset>`
  };

  const panel: GroupAdapter = {
    kind: "group",
    name: "gcds-panel",
    // A hidden heading stays the section's name, visually hidden; the hint is gcds-hint's.
    capabilities: { hideLabel: "drawn" },
    template: (s, children) => {
      const labelId = `${s.key}__group-label`;
      // gcds-hint writes its own id (`hint-<hint-id>`) in this same tree, so the key it is given is the instance's: a panel
      // repeated in a grid's rows shares its component id, and two hints with one id would make the description ambiguous.
      const hintKey = s.hintId ?? s.key;
      const hintId = `hint-${hintKey}`;
      const classNames = lastLookOnly(s.classNames);
      const band = classNames.includes("panel-card");
      const heading =
        s.legend === undefined
          ? nothing
          : html`<div class=${s.hideLegend ? "datum-gcds-sr-only" : "datum-gcds-panel__title"}>
              <gcds-heading tag=${`h${Math.min(6, s.level + 1)}`} id=${labelId} margin-top="0" margin-bottom=${ifDefined(band ? "0" : undefined)}>${s.legend}</gcds-heading>
            </div>`;
      const hinted = s.legend !== undefined && s.hint !== undefined && s.hint !== "";
      const hint = hinted ? html`<gcds-hint hint-id=${hintKey}>${s.hint}</gcds-hint>` : nothing;
      // A heading the author hid with no hint beside it leaves the header nothing to draw: the whole header is visually
      // hidden (the heading still names the section), so a card draws no empty band.
      const header = s.hideLegend && !hinted ? "datum-gcds-panel__header datum-gcds-sr-only" : "datum-gcds-panel__header";
      return html`<section
        class=${["datum-gcds-panel", ...classNames].join(" ")}
        aria-labelledby=${ifDefined(s.legend === undefined ? undefined : labelId)}
        aria-describedby=${ifDefined(hinted ? hintId : undefined)}
      >
        ${s.legend === undefined ? nothing : html`<div class=${header}>${heading}${hint}</div>`}
        <div class="datum-gcds-panel__body">${children}</div>
      </section>`;
    }
  };

  const dataGrid: GridAdapter = {
    kind: "grid",
    name: "gcds-stacked-grid",
    layouts: ["stacked"],
    // Every row is a gcds-fieldset and a fieldset must have its legend: the row's name is always drawn, so
    // `showRowNumbers: false` cannot be honoured. Honest answer: degraded.
    capabilities: { rowNumbers: "degraded" },
    template: (s) => {
      const size = (offset: number): string => `h${Math.min(6, s.level + offset)}`;
      // The row's name is slotted text, never aria-label on the host: gcds-button copies the host's aria-* to its
      // button only when it loads or is clicked, so after a move or a removal the button would still say the old row.
      const button = (offered: boolean, press: (() => void) | undefined, caption: string, role: string, row: { label: string; index: number }, action: string) =>
        offered
          ? html`<gcds-button
              type="button"
              button-role=${role}
              size="small"
              data-row-action=${action}
              ?disabled=${press === undefined}
              @click=${() => press?.()}
              >${caption}<gcds-sr-only tag="span">, ${row.label}</gcds-sr-only></gcds-button
            >`
          : nothing;
      const rows = s.eachRow(
        (row) => html`<gcds-fieldset legend=${row.label} legend-size=${size(2)}>
          ${row.cells.map((cell) => cell.content)}
          <div class="datum-gcds-row-actions">
            ${button(s.offers.reorder, row.moveUp, s.captions.moveUp, "secondary", row, "up")}
            ${button(s.offers.reorder, row.moveDown, s.captions.moveDown, "secondary", row, "down")}
            ${button(s.offers.remove, row.remove, s.captions.remove, "danger", row, "remove")}
          </div>
        </gcds-fieldset>`
      );
      const empty = s.rows.length === 0 ? html`<gcds-text>${s.captions.empty}</gcds-text>` : nothing;
      const add = s.offers.add
        ? html`<gcds-button type="button" button-role="secondary" id=${s.addId} data-row-action="add" ?disabled=${s.add === undefined} @click=${() => s.add?.()}>${s.captions.add}</gcds-button>`
        : nothing;
      const error = s.errors.length > 0 ? html`<gcds-error-message message-id=${s.id} id=${ifDefined(s.errorId)}>${s.errors.join("; ")}</gcds-error-message>` : nothing;
      return s.legend === undefined
        ? html`<div class="datum-gcds-group">${error}${empty}${rows}${add}</div>`
        : html`<gcds-fieldset legend=${s.legend} legend-size=${size(1)} hint=${ifDefined(s.hint)}>${error}${empty}${rows}${add}</gcds-fieldset>`;
    }
  };

  const steps: StepsAdapter = {
    kind: "steps",
    name: "gcds-stepper",
    // A step's heading is the stepper's own and is always shown.
    capabilities: {},
    template(state) {
      const lang = languageOf(state.locale);
      if (state.flat || state.steps.length === 0) {
        return html`<div class="datum-gcds-steps" data-step-container=${state.id}>
          ${state.eachStep(
            (step) => html`<section class="datum-gcds-step" data-step-panel=${step.id} aria-labelledby=${step.headingId}>
              <gcds-heading tag=${`h${Math.min(6, Math.max(2, state.level + 1))}`} id=${step.headingId} tabindex="-1">${step.label}</gcds-heading>
              ${step.content}
            </section>`
          )}${state.others}
        </div>`;
      }
      const tag = `h${Math.min(3, Math.max(1, state.level + 1))}`;
      const total = state.steps.length;
      const panels = state.eachStep((step) => {
        const number = state.steps.indexOf(step) + 1;
        return html`<section class="datum-gcds-step" data-step-panel=${step.id} data-step-container=${state.id} aria-labelledby=${step.headingId} ?hidden=${!step.shown}>
          <gcds-stepper current-step=${number} total-steps=${total} tag=${tag} lang=${lang}><span id=${step.headingId} tabindex="-1">${step.label}</span></gcds-stepper>
          ${step.content}
        </section>`;
      });
      // A busy form draws aria-disabled, never disabled, on the host and on the button inside it (busyButton: the component
      // copies the host's only on load and click); the press is dropped here.
      const back = state.back;
      const next = state.next;
      return html`<div class="datum-gcds-steps" data-step-container=${state.id} data-step-active=${ifDefined(state.activeStepId ?? "")}>
        ${panels}${state.others}
        <div class="datum-gcds-page-actions">
          ${back ? html`<gcds-button type="button" button-role="secondary" data-step-prev aria-disabled=${state.busy ? "true" : nothing} ${ref(busyButton(state.busy))} lang=${lang} @click=${() => (state.busy ? undefined : back.go())}>${back.label}</gcds-button>` : nothing}
          ${next ? html`<gcds-button type="button" data-step-next aria-disabled=${state.busy ? "true" : nothing} ${ref(busyButton(state.busy))} lang=${lang} @click=${() => (state.busy ? undefined : next.go())}>${next.label}</gcds-button>` : nothing}
        </div>
      </div>`;
    }
  };

  return { fieldset, panel, dataGrid, steps };
}
