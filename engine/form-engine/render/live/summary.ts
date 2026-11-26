/**
 * The error summary and where focus goes after a check that found errors.
 *
 * The lines come from the render output's `errorSummary.entries` (blocking errors only, worded by
 * the engine: `render/core/error-summary.ts`); this module adds to each the `href` of the control it
 * goes to and a `focus()` that moves focus there. Wording, the heading's count, the form-level
 * lines and the order are the engine's. A binding draws the summary through `binding.summary`;
 * without one Datum's markup ({@link datumSummary}) stands.
 *
 * Focus on a link is the renderer's own `focusField`: the adapter's or the binding's focus target,
 * the deep active element checked afterwards, the field's wrapper taking focus on a miss, and a
 * `datum-binding-error {hook:"focus"}` when it did. A cell error no row owns goes to its grid's
 * Add button.
 *
 * Where focus goes after a check (`focusErrors`, called by `LiveContext.focusErrors()`):
 * - `binding.errorFocus` `"summary"` (the default), or a form whose author turned
 *   `focusFirstError` off: the summary. Under the binding's own setting the tab holding the first
 *   error is opened first, so the person lands on the summary with the field in front of them;
 *   an author who turned `focusFirstError` off asked for no movement beyond the summary, so
 *   nothing is opened then.
 * - `"field"`: the first field in error (the renderer's own, which opens what hides it), the
 *   summary when no field can take it.
 * - With no summary drawn the first field takes it either way.
 *
 * The summary element focus goes to is the first one in the summary carrying a `tabindex` (open
 * shadow roots too: a design system's summary element), else the summary's wrapper. A summary
 * element that is still drawing itself (an undefined custom element) is waited for a few frames
 * and focused when it has.
 *
 * A submit the runtime refused (`SUBMISSION_FAILED`) takes the same road once its errors are drawn.
 */
import { FormEventType } from "../../core/events/event-types.js";
import type { FormNoticePlacement } from "../../core/submission/form-notice.js";
import type { ErrorSummaryEntry, ErrorSummaryWording } from "../core/error-summary.js";
import type { LiveBinding, SummaryEntry, SummaryState } from "./contract.js";
import { focusGridOwner } from "./data-grid.js";
import { errorFieldOf } from "./error-target.js";
import { html, type TemplateResult } from "./lit.js";
import type { DrawContext, FormRegion, LiveContext, LiveFeature } from "./mount.js";

/** The attribute of the wrapper the summary is drawn in: focus falls back to it, and the renderer finds the summary by it (also written in the template). */
const SUMMARY_ATTRIBUTE = "data-datum-summary";
/** Frames an undefined summary element is waited for. */
const DRAW_WAIT_FRAMES = 10;

/** The summary's heading at `level` (clamped to what HTML has: a form nested deep still gets a real heading). */
function summaryHeading(level: number, id: string, text: string): TemplateResult {
  switch (Math.min(6, Math.max(1, Math.round(Number.isFinite(level) ? level : 2)))) {
    case 1:
      return html`<h1 id=${id} class="datum-live-summary__heading">${text}</h1>`;
    case 2:
      return html`<h2 id=${id} class="datum-live-summary__heading">${text}</h2>`;
    case 3:
      return html`<h3 id=${id} class="datum-live-summary__heading">${text}</h3>`;
    case 4:
      return html`<h4 id=${id} class="datum-live-summary__heading">${text}</h4>`;
    case 5:
      return html`<h5 id=${id} class="datum-live-summary__heading">${text}</h5>`;
    default:
      return html`<h6 id=${id} class="datum-live-summary__heading">${text}</h6>`;
  }
}

/** Datum's own summary: an alert box holding the heading (a level under the form's) and one link per line. */
export function datumSummary(entries: readonly SummaryEntry[], state: SummaryState): TemplateResult {
  const list = html`<ul class="datum-live-summary__list">
    ${state.formEntries.map((entry) => html`<li class="datum-live-summary__form-error">${entry.text}</li>`)}
    ${entries.map(
      (entry) =>
        html`<li>
          <a
            href=${entry.href}
            @click=${(event: Event) => {
              event.preventDefault();
              entry.focus();
            }}
            >${entry.text}</a
          >
        </li>`
    )}
  </ul>`;
  if (state.echo === true) {
    return html`<div class="datum-live-summary__box datum-live-summary__box--echo">${summaryHeading(state.headingLevel, state.headingId, state.heading)}${list}</div>`;
  }
  return html`<div role="alert" class="datum-live-summary__box" tabindex="-1" aria-labelledby=${state.headingId}>
    ${summaryHeading(state.headingLevel, state.headingId, state.heading)}${list}
  </div>`;
}

/** The summary hook that draws: the binding's, else Datum's own binding's, else {@link datumSummary}. */
function summaryHookOf(live: LiveContext): NonNullable<LiveBinding["summary"]> {
  return live.binding.summary ?? live.datum.summary ?? datumSummary;
}

/** Whether this draw shows a summary, and the entries it lists. */
function wording(draw: DrawContext): ErrorSummaryWording | undefined {
  const meta = draw.output.meta;
  // A review shows no summary (nothing to fix on it), nor does a form whose author turned it off.
  if (draw.live.mode === "readonly" || !meta.presentation.showSummary || meta.errorSummary.total === 0) {
    return undefined;
  }
  const { entries, formEntries, heading } = meta.errorSummary;
  return entries.length + formEntries.length === 0 ? undefined : { heading, formEntries, entries };
}

/**
 * A module that draws, itself, the place an entry of the summary goes to: a journey's Check answers
 * page lists the answers it is checking as rows, not fields (`render/live/journey-review.ts`).
 * Asked first, in `features` order; `undefined` leaves the entry to the field or the grid.
 */
export interface SummaryTargetFeature extends LiveFeature {
  summaryTarget?(entry: ErrorSummaryEntry, draw: DrawContext): { href: string; focus(): void } | undefined;
}

/** The first module that draws the place `entry` goes to (a Check answers row). */
function ownTarget(entry: ErrorSummaryEntry, draw: DrawContext): { href: string; focus(): void } | undefined {
  for (const feature of (draw.live.options.features ?? []) as readonly SummaryTargetFeature[]) {
    const target = feature.summaryTarget ? draw.live.call(`${feature.id}.summaryTarget`, entry.componentId, () => feature.summaryTarget?.(entry, draw)) : undefined;
    if (target !== undefined) {
      return target;
    }
  }
  return undefined;
}

/** The renderer's lines: the engine's entry, the control it links to, and the move to it. */
function summaryEntries(draw: DrawContext): SummaryEntry[] {
  const live = draw.live;
  const byId = new Map(draw.output.components.map((model) => [model.id, model]));
  return draw.output.meta.errorSummary.entries.map((entry) => {
    const own = ownTarget(entry, draw);
    if (own !== undefined) {
      return { href: own.href, targetPath: entry.targetPath, componentId: entry.componentId, label: entry.label, message: entry.message, text: entry.text, authored: entry.authored, focus: own.focus };
    }
    const field = draw.tree.fields.find((candidate) => candidate.model.valuePath === entry.targetPath);
    const owner = byId.get(entry.componentId);
    const control = field?.model.accessibility.fieldId ?? owner?.accessibility.fieldId ?? entry.componentId;
    return {
      href: `#${control}`,
      targetPath: entry.targetPath,
      componentId: entry.componentId,
      label: entry.label,
      message: entry.message,
      text: entry.text,
      authored: entry.authored,
      focus: () => focusEntry(live, entry)
    };
  });
}

/** Moves focus to the control an entry names: the field, else (a grid's own error, a cell error no row owns) the grid: its Add button where it can be pressed, else its first row control. */
function focusEntry(live: LiveContext, entry: ErrorSummaryEntry): void {
  const fields = live.fields();
  const field = fields.find((candidate) => candidate.state.valuePath === entry.targetPath) ?? fields.find((candidate) => candidate.state.componentId === entry.componentId && candidate.state.row === undefined);
  if (field) {
    live.focusField(field.key);
    return;
  }
  focusGridOwner(live, entry.componentId);
}

/** The summary's wrapper in the root, if one is drawn. */
function summaryBox(root: ShadowRoot): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[${SUMMARY_ATTRIBUTE}]`);
}

/** The first element inside `scope` that carries a tabindex, looking into open shadow roots `depth` levels down. */
function findTabindex(scope: ParentNode, depth: number): HTMLElement | undefined {
  for (const element of Array.from(scope.querySelectorAll<HTMLElement>("*"))) {
    if (element.hasAttribute("tabindex")) {
      return element;
    }
    if (depth > 0 && element.shadowRoot) {
      const inner = findTabindex(element.shadowRoot, depth - 1);
      if (inner) {
        return inner;
      }
    }
  }
  return undefined;
}

/** Whether an element of the summary has not drawn itself yet (an undefined custom element, or one with an empty shadow root). */
function stillDrawing(box: HTMLElement): boolean {
  return Array.from(box.querySelectorAll("*")).some((element) => element.localName.includes("-") && (customElements.get(element.localName) === undefined || element.shadowRoot?.childElementCount === 0));
}

function reducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : true;
  } catch {
    return true;
  }
}

/** Brings the summary's start into view, then focuses it without a second scroll (a summary taller than the viewport). */
function focusSummaryElement(target: HTMLElement): void {
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  }
  target.focus({ preventScroll: true });
}

function frame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });
}

/** Whether the shadow root's active element is `box` or inside it. */
function focusIsIn(live: LiveContext, box: HTMLElement): boolean {
  const active = live.root.activeElement;
  return active !== null && (active === box || box.contains(active));
}

/** Focuses the summary; true when focus landed in it. A box element still drawing itself is refocused once it has. */
function focusSummary(live: LiveContext, box: HTMLElement): boolean {
  let target = findTabindex(box, 2);
  if (target === undefined) {
    box.tabIndex = -1;
    target = box;
  }
  focusSummaryElement(target);
  if (!focusIsIn(live, box)) {
    // The summary's own element did not take it: the wrapper does.
    box.tabIndex = -1;
    focusSummaryElement(box);
    live.error({ hook: "focus", id: "summary", message: "focus did not land in the summary; its wrapper took it" });
  }
  if (stillDrawing(box)) {
    void refocusWhenDrawn(live, box, target);
  }
  return true;
}

/** Waits for the summary's design-system element to draw itself, then focuses the element that takes focus if nothing else has it. */
async function refocusWhenDrawn(live: LiveContext, box: HTMLElement, current: HTMLElement): Promise<void> {
  for (let waited = 0; waited < DRAW_WAIT_FRAMES && stillDrawing(box); waited += 1) {
    await frame();
    if (!live.mounted() || !box.isConnected) {
      return;
    }
  }
  const better = findTabindex(box, 2);
  const active = live.root.activeElement;
  // Only while focus is still where the first move put it (or nowhere): the person has not gone elsewhere.
  if (better !== undefined && better !== current && (active === null || active === box || active === current || box.contains(active))) {
    focusSummaryElement(better);
  }
}

/** Opens what hides the field of the first error (the tab it sits in), so the summary is read with the field in front of the person. */
function openFirstError(live: LiveContext): void {
  const field = errorFieldOf(live.fields(), live.output()?.meta.firstErrorFocus);
  if (field === undefined || field.state.reveal.length === 0) {
    return;
  }
  let changed = false;
  for (const feature of live.options.features ?? []) {
    if (feature.reveal && live.call(`${feature.id}.reveal`, field.key, () => feature.reveal?.(field.state.reveal, live)) === true) {
      changed = true;
    }
  }
  if (changed) {
    live.redraw();
  }
}

/** What the host gives the summary feature; read at every draw, so a later change shows on the next one. */
export interface SummaryOptions {
  /**
   * The ends of the form the summary goes at, as the host's `error-summary-placement` names them:
   * the top, the bottom, both (the bottom copy a non-alert echo), or none (`[]`: a page that
   * draws its own summary, or a design showing the inline messages alone). The host's setting
   * wins over the form's `presentation.summaryPosition`; absent, the author's position stands
   * (top by default).
   */
  placement?: () => readonly FormNoticePlacement[] | undefined;
  /** The form's own heading level, its place in the page's outline (the host's `headingLevel`); 1 when left out. The summary heads a level under it. */
  headingLevel?: () => number;
}

/** The ends the summary is drawn at this draw. */
function placesOf(options: SummaryOptions, draw: DrawContext): readonly FormNoticePlacement[] {
  const host = options.placement?.();
  if (host !== undefined) {
    return Array.isArray(host) ? host.filter((place) => place === "top" || place === "bottom") : [];
  }
  return [draw.output.meta.presentation.summaryPosition === "bottom" ? "bottom" : "top"];
}

/** The error summary and error focus as a renderer module. */
export function createSummaryFeature(options: SummaryOptions = {}): LiveFeature {
  return {
    id: "summary",
    start(live) {
      // A submit the runtime refused: its errors are drawn, then the person is taken to them.
      return live.runtime.events().subscribe(FormEventType.SUBMISSION_FAILED, () => {
        void live.updated().then(() => {
          if (live.mounted()) {
            live.focusErrors();
          }
        });
      });
    },
    region(region: FormRegion, draw: DrawContext) {
      if (region !== "summary-top" && region !== "summary-bottom") {
        return undefined;
      }
      const places = placesOf(options, draw);
      const position: FormNoticePlacement = region === "summary-bottom" ? "bottom" : "top";
      if (!places.includes(position)) {
        return undefined;
      }
      // Both ends: the top copy is the alert, the bottom one its echo.
      const echo = position === "bottom" && places.includes("top");
      const worded = wording(draw);
      if (worded === undefined) {
        return undefined;
      }
      const live = draw.live;
      const state: SummaryState = {
        heading: worded.heading,
        formEntries: worded.formEntries,
        headingId: `${live.runtime.formRoot().id}__summary-heading${echo ? "-echo" : ""}`,
        headingLevel: (options.headingLevel?.() ?? 1) + 1,
        ...(echo ? { echo: true } : {}),
        locale: draw.form.locale,
        words: draw.words
      };
      const entries = summaryEntries(draw);
      const hook = summaryHookOf(live);
      // A throw falls back to Datum's own summary: the form is never hidden for it.
      const drawn = live.call("summary", undefined, () => hook(entries, state));
      const view = drawn ?? datumSummary(entries, state);
      // Datum's summary inside another binding is tinted by its tokens.
      const fallback = live.binding !== live.datum && (drawn === undefined || live.binding.summary === undefined);
      // The echo is not the summary focus goes to: it carries no marker.
      return echo
        ? html`<div class="datum-live-summary datum-live-summary--echo" ?data-fallback=${fallback}>${view}</div>`
        : html`<div class="datum-live-summary" data-datum-summary ?data-fallback=${fallback}>${view}</div>`;
    },
    focusErrors(live) {
      const output = live.output();
      if (output === undefined || output.meta.errorSummary.total === 0) {
        return false;
      }
      const bindingFirst = (live.binding.errorFocus ?? "summary") === "summary";
      const allowed = output.meta.presentation.focusFirstError !== false;
      const box = summaryBox(live.root);
      if (bindingFirst || !allowed) {
        if (box === null) {
          return false;
        }
        if (bindingFirst && allowed) {
          openFirstError(live);
        }
        return focusSummary(live, box);
      }
      // The first field in error is the renderer's to focus; the summary only when none can take it.
      // The field at the error's own path (a data grid's row), else the grid that owns it: the renderer's default takes either.
      const target = output.meta.firstErrorFocus;
      if (errorFieldOf(live.fields(), target) !== undefined) {
        return false;
      }
      // A grid's own error (its row count, a cell error no row owns): the grid takes it, as it does without a summary.
      if (target !== undefined && focusGridOwner(live, target.targetComponentId ?? target.componentId)) {
        return true;
      }
      return box !== null ? focusSummary(live, box) : false;
    }
  };
}
