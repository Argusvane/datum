/**
 * Datum's steps container: an indicator (one entry per step with its status, and the
 * "Step n of total" line), the step panels, and Back and Continue. Which step shows, Continue's
 * check of the step on show, the move itself and the focus on the new step's heading are the
 * renderer's (`render/live/steps.ts`); this adapter draws what it hands over.
 *
 * - The indicator's entries are buttons naming a step (`data-step-select`); an upcoming one is
 *   `aria-disabled`, not a way to skip ahead. Under `stepSegments: "text"` an entry is static text
 *   (no role, no tab stop, nothing to press: Back is the way back), the current one `aria-current="true"`.
 * - Every panel is drawn, all but the shown one `hidden`. A panel is a region named by its heading
 *   (the step's tag, "Step 2 of 3" split around the number so a stylesheet can circle it, then the
 *   step's name); the heading is focusable, the target the renderer moves focus to. `stepPages:
 *   "plain"` draws sections under a plain caption instead, `panelRegion` / `stepRegion` "none"
 *   leaves a panel unnamed.
 * - The progress line stands after the list or before it (`stepProgress`), a polite live region
 *   so an in-page step change is heard; Back and Continue stand in the order `actionOrder` gives.
 *   While the form is busy both are `aria-disabled`, never `disabled`.
 * - A review or a print (`StepsState.flat`) draws every panel headed, in order, and nothing else.
 */
import type { StepsAdapter, StepsState, StepState } from "../contract.js";
import { html, ifDefined, nothing, type TemplateResult } from "../lit.js";
import { classes, heading, resolveContainerControls, type DatumContainerControls } from "./container-kit.js";
import { drawPart, type DatumParts } from "./parts.js";

export interface DatumStepsOptions {
  controls?: Partial<DatumContainerControls> | undefined;
  /** The host's part templates: `stepBack` draws the steps' Back (`parts.ts`). */
  parts?: Pick<DatumParts, "stepBack"> | undefined;
}

/** Stands in for the step's number while the `stepOf` words are split around it. */
const STEP_NUMBER_MARK = "\uE000";

/**
 * A step's tag: the `stepOf` words split around the number (`<span>Step</span> <span>2</span>
 * <span>of 3</span>`, so a stylesheet can hide the lead and circle the number), then the
 * visually hidden separator.
 */
function stepTag(state: StepsState, n: number): TemplateResult {
  const worded = state.words("stepOf", { n: STEP_NUMBER_MARK, total: state.steps.length });
  const separator = html`<span class="datum-form__step-tag-separator datum-form__visually-hidden">${state.words("stepTagSeparator")}</span>`;
  const at = worded.indexOf(STEP_NUMBER_MARK);
  if (at < 0) {
    return html`<span class="datum-form__step-tag">${worded}${separator}</span>`;
  }
  const before = worded.slice(0, at);
  const after = worded.slice(at + STEP_NUMBER_MARK.length);
  const lead = before.trimEnd();
  const rest = after.trimStart();
  return html`<span class="datum-form__step-tag">${lead ? html`<span class="datum-form__step-tag-lead">${lead}</span>${lead.length < before.length ? " " : ""}` : nothing}<span class="datum-form__step-tag-number">${n}</span>${rest ? html`${rest.length < after.length ? " " : ""}<span class="datum-form__step-tag-rest">${rest}</span>` : nothing}${separator}</span>`;
}

export function createDatumStepsAdapter(options: DatumStepsOptions = {}): StepsAdapter {
  const controls = resolveContainerControls(options.controls);
  // Plain pages are sections under a caption; neither they, a panel set to none, nor a step region set to none is a landmark.
  const named = controls.stepPages !== "plain" && controls.panelRegion !== "none" && controls.stepRegion !== "none";

  const panel = (state: StepsState, step: StepState, index: number): TemplateResult =>
    html`<section
      class=${classes("datum-form__step-panel", ...step.classNames)}
      data-step-panel=${step.id}
      data-step-container=${state.id}
      aria-labelledby=${named ? step.headingId : nothing}
      ?hidden=${!step.shown}
    >${heading(
      state.level + 1,
      { id: step.headingId, className: classes("datum-form__step-heading", step.hideLabel && "datum-form__visually-hidden"), focusable: true },
      html`${stepTag(state, index + 1)}<span class="datum-form__step-heading-text">${step.label}</span>`
    )}<div class="datum-form__step-body">${step.content}</div></section>`;

  return {
    kind: "steps",
    name: "datum-steps",
    // A step's heading visually hidden, still its name.
    capabilities: { hideLabel: "drawn" },
    template(state: StepsState): TemplateResult {
      const rootClass = classes("datum-form__steps", ...state.classNames);
      const panels = html`<div class="datum-form__step-panels">${state.eachStep((step) => panel(state, step, state.steps.indexOf(step)))}${state.others}</div>`;
      if (state.flat || state.steps.length === 0) {
        return html`<div class=${rootClass} data-step-container=${state.id}>${panels}</div>`;
      }
      const activeIndex = Math.max(0, state.steps.findIndex((step) => step.shown));
      const textEntries = controls.stepSegments === "text";
      const entries = state.steps.map((step, index) => {
        const inner = html`<span class="datum-form__step-number" aria-hidden="true">${index + 1}</span><span class="datum-form__step-name">${step.label}</span>${step.statusText ? html`<span class="datum-form__visually-hidden"> ${step.statusText}</span>` : nothing}`;
        // Static text (usa-step-indicator's segment label): the current segment is marked `aria-current="true"`.
        if (textEntries) {
          return html`<li class=${`datum-form__step datum-form__step--${step.status}`} data-step-status=${step.status} aria-current=${step.status === "active" ? "true" : nothing}><span class="datum-form__step-label" data-step-entry=${step.id} data-step-container=${state.id}>${inner}</span></li>`;
        }
        return html`<li class=${`datum-form__step datum-form__step--${step.status}`} data-step-status=${step.status} aria-current=${step.status === "active" ? "step" : nothing}><button type="button" class="datum-form__step-label" data-step-select=${step.id} data-step-container=${state.id} aria-disabled=${step.status === "upcoming" ? "true" : nothing} @click=${() => step.select?.()}>${inner}</button></li>`;
      });
      // The progress line: a polite live region so an in-page step change is heard, or, where the steps are pages, a plain caption.
      const plain = controls.stepPages === "plain";
      const progress = html`<span class="datum-form__step-counter">${activeIndex + 1}</span><span class="datum-form__step-progress-text">${state.progress}</span><span class="datum-form__step-current">${state.steps[activeIndex]?.label ?? ""}</span>`;
      const line = plain ? html`<span class="datum-form__step-progress">${progress}</span>` : html`<p class="datum-form__step-progress" aria-live="polite">${progress}</p>`;
      const list = html`<ol class="datum-form__step-list">${entries}</ol>`;
      const stepBack = state.back;
      const back = stepBack
        ? drawPart(options.parts, "stepBack", {
            state,
            label: stepBack.label,
            go: () => stepBack.go(),
            busy: state.busy,
            default: html`<button type="button" class="datum-form__button datum-form__button--secondary datum-form__step-back" data-step-prev data-step-container=${state.id} aria-disabled=${state.busy ? "true" : nothing} @click=${() => stepBack.go()}>${stepBack.label}</button>`
          })
        : nothing;
      const next = state.next
        ? html`<button type="button" class="datum-form__button datum-form__step-continue" data-step-next data-step-container=${state.id} aria-disabled=${state.busy ? "true" : nothing} @click=${() => state.next?.go()}>${state.next.label}</button>`
        : nothing;
      return html`<div class=${rootClass} data-step-container=${state.id} data-step-active=${ifDefined(state.activeStepId ?? "")}>
        <div class="datum-form__step-indicator">${controls.stepProgress === "beforeList" ? html`${line}${list}` : html`${list}${line}`}</div>
        ${panels}
        <div class="datum-form__step-actions">${controls.actionOrder === "nextFirst" ? html`${next}${back}` : html`${back}${next}`}</div>
      </div>`;
    }
  };
}

/** Datum's steps container with the engine's own choices. */
export const datumStepsAdapter: StepsAdapter = createDatumStepsAdapter();
