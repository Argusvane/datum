/**
 * A journey's Check answers page in the live form (`kind: "review"`, after the GOV.UK check answers
 * pattern): the list of the person's answers between the page's heading and its own content (a
 * declaration), drawn by the binding's `review` hook, else Datum's own ({@link datumReview}). The
 * journey page module (`journey-page.ts`) calls in here; both sit in the journeys chunk, so a form
 * with no journey never carries this.
 *
 * What the renderer owns, whatever binding draws:
 * - the list (`render/core/journey-review.ts`): sections, rows, cards, wording and states;
 * - the links. Change and "Enter {{label}}" open the answer's step through the runtime with
 *   direction `"change"`; the runtime records the return, and Continue comes back. Focus then
 *   goes to the heading of the step opened, and on the way back to the row that was changed (its
 *   first link), else the page's heading;
 * - the error summary's links: an error on an answer the page lists goes to its row
 *   (`summaryTarget`), and the first error with no summary drawn takes focus there (`focusOwner`).
 */
import type { JourneyNavigationResult, JourneyView } from "../../core/journey/journey-types.js";
import type { ErrorSummaryEntry } from "../core/error-summary.js";
import { buildReviewModel, type ReviewAction, type ReviewModel, type ReviewRow } from "../core/journey-review.js";
import type { PresentationPage } from "../core/presentation-tree.js";
import type { RenderOutput } from "../core/render-orchestrator.js";
import type { LiveBinding, ReviewCardState, ReviewItemState, ReviewLinkState, ReviewRowState, ReviewState, View } from "./contract.js";
import { html, nothing, type TemplateResult } from "./lit.js";
import type { DrawContext, LiveContext, LiveRuntime } from "./mount.js";

const OWNER = "journey-review";

/** What the list needs of the runtime beyond the renderer's. */
interface ReviewRuntime {
  journeyView?(): JourneyView | undefined;
  goToPage?(pageId: string, options?: { direction?: "change" }): Promise<JourneyNavigationResult>;
}

interface ReviewMemory {
  /** The row a Change link left, until the person is back on its Check answers page. */
  returning: { reviewPageId: string; key: string } | undefined;
  /** Takes Datum's rules for the list away again; set once a Check answers page is first drawn. */
  sheet: (() => void) | undefined;
}

function memoryOf(live: LiveContext): ReviewMemory {
  return live.memory<ReviewMemory>(OWNER, () => ({ returning: undefined, sheet: undefined }));
}

const messageOf = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/** The id of a page's heading (`journey-page.ts` `pageHeadingId`): where a link to a step points. */
const headingIdOf = (pageId: string): string => `${pageId}__page-heading`;

/** The id a row or a card of the list carries: what the summary links to, and focus comes back to. */
export const reviewItemId = (reviewPageId: string, key: string): string => `${reviewPageId}__review-${key}`;

// ── The list, once per output ──────────────────────────────────────────────────────────────

const models = new WeakMap<RenderOutput, ReviewModel | null>();

/** The list the output's page shows; `undefined` unless it is a Check answers page. Built once per output. */
function reviewModelOf(draw: DrawContext): ReviewModel | undefined {
  const journey = draw.tree.page?.journey;
  if (journey?.kind !== "review") {
    return undefined;
  }
  const known = models.get(draw.output);
  if (known !== undefined) {
    return known ?? undefined;
  }
  const runtime = draw.live.runtime as LiveRuntime & ReviewRuntime;
  const view = runtime.journeyView?.();
  const model =
    view && view.pageId === journey.pageId
      ? buildReviewModel({
          view,
          components: draw.output.components,
          kinds: draw.kinds,
          locale: draw.form.locale,
          sources: { translations: runtime.translations?.(), catalog: runtime.translationCatalog?.() },
          text: draw.words
        })
      : undefined;
  models.set(draw.output, model ?? null);
  return model;
}

/** Focuses a row or a card: its first link, else the element itself. `false` when it is not drawn. */
function focusItem(live: LiveContext, id: string): boolean {
  const element = live.root.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  const link = element.querySelector<HTMLElement>("a[href]");
  if (link) {
    return live.focusElement(link, element);
  }
  element.tabIndex = -1;
  return live.focusElement(element);
}

/** A Change (or Enter) link's press: opens its step, the row remembered for the way back. */
async function change(live: LiveContext, action: ReviewAction, reviewPageId: string, key: string, ownMove: () => void): Promise<void> {
  const runtime = live.runtime as LiveRuntime & ReviewRuntime;
  if (!runtime.goToPage || !live.mounted() || live.mode !== "interactive" || live.busy() !== undefined) {
    return;
  }
  ownMove();
  const memory = memoryOf(live);
  memory.returning = { reviewPageId, key };
  try {
    const result = await runtime.goToPage(action.pageId, { direction: "change" });
    if (!result.ok) {
      memory.returning = undefined;
    }
  } catch (thrown) {
    memory.returning = undefined;
    live.error({ hook: "journey", id: action.pageId, message: messageOf(thrown) });
  }
}

/** The binding's state of the list: ids, hrefs and presses on the model's rows. */
function reviewStateOf(draw: DrawContext, model: ReviewModel, headingLevel: number, ownMove: () => void): Omit<ReviewState, "content"> {
  const live = draw.live;
  // A read-only or disabled form draws no links: nothing there could take the person to a step.
  const interactive = live.mode === "interactive";
  const link = (action: ReviewAction | undefined, key: string, describedBy: string | undefined): ReviewLinkState | undefined =>
    action === undefined || !interactive
      ? undefined
      : {
          ...action,
          href: `#${headingIdOf(action.pageId)}`,
          ...(describedBy !== undefined ? { describedBy } : {}),
          go: () => void change(live, action, model.pageId, key, ownMove)
        };
  const rowState = (row: ReviewRow, key = row.key): ReviewRowState => {
    const id = reviewItemId(model.pageId, row.key);
    // A row in error: its links say why (the summary moves focus onto them).
    const errorId = `${id}__error`;
    const describedBy = row.errors.length > 0 ? errorId : undefined;
    const change = link(row.change, key, describedBy);
    const enter = link(row.enter, key, describedBy);
    return {
      id,
      key: row.key,
      componentId: row.componentId,
      pageId: row.pageId,
      label: row.label,
      value: row.value,
      status: row.status,
      errors: row.errors,
      errorId,
      ...(change ? { change } : {}),
      ...(enter ? { enter } : {})
    };
  };
  return {
    journeyId: model.journeyId,
    pageId: model.pageId,
    headingLevel,
    errorPrefix: draw.words("errorPrefix"),
    words: draw.words,
    sections: model.sections.map((section) => ({
      pageId: section.pageId,
      title: section.title,
      headingId: reviewItemId(model.pageId, `section-${section.pageId}`),
      items: section.items.map((item): ReviewItemState => {
        if (item.kind === "row") {
          return { kind: "row", ...rowState(item) };
        }
        const id = reviewItemId(model.pageId, item.key);
        const cardChange = link(item.change, item.key, item.errors.length > 0 ? `${id}__error` : undefined);
        const card: ReviewCardState = {
          id,
          key: item.key,
          componentId: item.componentId,
          index: item.index,
          pageId: item.pageId,
          title: item.title,
          // A card's rows bring focus back to the card: its Change is theirs.
          rows: item.rows.map((row) => rowState(row, item.key)),
          errors: item.errors,
          errorId: `${id}__error`,
          ...(cardChange ? { change: cardChange } : {})
        };
        return { kind: "card", ...card };
      })
    }))
  };
}

// ── Datum's drawing ────────────────────────────────────────────────────────────────────────

/** A heading at `level` (clamped to what HTML has). */
function heading(level: number, id: string | undefined, className: string, content: string): TemplateResult {
  const at = Math.min(6, Math.max(1, Math.round(Number.isFinite(level) ? level : 2)));
  const own = id ?? nothing;
  switch (at) {
    case 1:
      return html`<h1 id=${own} class=${className}>${content}</h1>`;
    case 2:
      return html`<h2 id=${own} class=${className}>${content}</h2>`;
    case 3:
      return html`<h3 id=${own} class=${className}>${content}</h3>`;
    case 4:
      return html`<h4 id=${own} class=${className}>${content}</h4>`;
    case 5:
      return html`<h5 id=${own} class=${className}>${content}</h5>`;
    default:
      return html`<h6 id=${own} class=${className}>${content}</h6>`;
  }
}

/** A link's words: the visible text, then the rest of its name visually hidden. */
export function reviewLinkWords(link: ReviewLinkState, hiddenClass: string): TemplateResult {
  if (link.reordered) {
    return html`<span aria-hidden="true">${link.text}</span><span class=${hiddenClass}>${link.hidden}</span>`;
  }
  return html`${link.text}${link.hidden !== "" ? html`<span class=${hiddenClass}>${link.hidden}</span>` : nothing}`;
}

/** An answer's lines, a line break between each. */
export function reviewValueLines(value: string): TemplateResult {
  return html`${value.split("\n").map((line, at) => (at === 0 ? html`${line}` : html`<br />${line}`))}`;
}

function datumLink(link: ReviewLinkState, className: string): TemplateResult {
  return html`<a
    class=${className}
    href=${link.href}
    aria-describedby=${link.describedBy ?? nothing}
    @click=${(event: Event) => {
      event.preventDefault();
      link.go();
    }}
    >${reviewLinkWords(link, "datum-form__visually-hidden")}</a
  >`;
}

function datumErrors(errors: readonly string[], id: string, prefix: string): View {
  return errors.length > 0
    ? html`<span id=${id} class="datum-form__review-error">${errors.map(
        (message) => html`<span class="datum-form__review-error-line">${prefix !== "" ? html`<span class="datum-form__visually-hidden">${prefix} </span>` : nothing}${message}</span>`
      )}</span>`
    : nothing;
}

function datumRow(row: ReviewRowState, prefix: string): TemplateResult {
  const invalid = row.errors.length > 0;
  return html`<div
    class=${`datum-form__review-row${invalid ? " datum-form__review-row--error" : ""}${row.change ? "" : " datum-form__review-row--no-actions"}`}
    id=${row.id}
    part="review-row"
    data-review-row=${row.key}
    data-status=${row.status}
  >
    <dt class="datum-form__review-key">${row.label}</dt>
    <dd class="datum-form__review-value">${datumErrors(row.errors, row.errorId, prefix)}${row.enter ? datumLink(row.enter, "datum-form__review-enter") : reviewValueLines(row.value)}</dd>
    ${row.change ? html`<dd class="datum-form__review-actions">${datumLink(row.change, "datum-form__review-change")}</dd>` : nothing}
  </div>`;
}

/** Consecutive rows in one list, a card between: the items as drawn. */
export function reviewRuns(items: readonly ReviewItemState[]): Array<{ rows: Array<ReviewItemState & { kind: "row" }> } | { card: ReviewItemState & { kind: "card" } }> {
  const out: Array<{ rows: Array<ReviewItemState & { kind: "row" }> } | { card: ReviewItemState & { kind: "card" } }> = [];
  for (const item of items) {
    if (item.kind === "card") {
      out.push({ card: item });
      continue;
    }
    const last = out[out.length - 1];
    if (last !== undefined && "rows" in last) {
      last.rows.push(item);
    } else {
      out.push({ rows: [item] });
    }
  }
  return out;
}

/** Datum's Check answers list: a heading per step, its answers as a description list, a data grid's rows as cards. */
export function datumReview(state: Omit<ReviewState, "content">): TemplateResult {
  const prefix = state.errorPrefix;
  return html`<div class="datum-form__review" part="review" data-journey-review>
    ${state.sections.map(
      (section) => html`<div class="datum-form__review-section" data-review-section=${section.pageId}>
        ${heading(state.headingLevel, section.headingId, "datum-form__review-heading", section.title)}
        ${reviewRuns(section.items).map((run) =>
          "rows" in run
            ? html`<dl class="datum-form__review-list">${run.rows.map((row) => datumRow(row, prefix))}</dl>`
            : html`<div class="datum-form__review-card" id=${run.card.id} part="review-card" data-review-card=${run.card.key}>
                <div class="datum-form__review-card-head">
                  ${heading(state.headingLevel + 1, undefined, "datum-form__review-card-title", run.card.title)}
                  ${run.card.change ? datumLink(run.card.change, "datum-form__review-change") : nothing}
                </div>
                ${datumErrors(run.card.errors, run.card.errorId, prefix)}
                ${run.card.rows.length > 0 ? html`<dl class="datum-form__review-list">${run.card.rows.map((row) => datumRow(row, prefix))}</dl>` : nothing}
              </div>`
        )}
      </div>`
    )}
  </div>`;
}

/** Datum's rules for its list, adopted by the journeys chunk (the form's own sheet never carries them). */
export const REVIEW_CSS = `
  .datum-form__review { display: flex; flex-direction: column; gap: calc(2 * var(--spacing-field-gap, 12px)); max-width: var(--layout-max-width, none); min-width: 0; container-type: inline-size; container-name: datum-review; }
  .datum-form__review-heading { margin: 0 0 var(--spacing-group-gap, 6px); font-family: var(--font-family-heading, inherit); font-size: var(--font-size-heading, 17px); font-weight: var(--font-weight-heading, 600); line-height: var(--line-height-title, 1.25); }
  .datum-form__review-list { margin: 0; padding: 0; }
  .datum-form__review-row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) auto; gap: 4px 16px; padding: 8px 0; border-bottom: 1px solid var(--color-border, #c8cdd4); }
  .datum-form__review-row > dt, .datum-form__review-row > dd { margin: 0; min-width: 0; }
  .datum-form__review-row--no-actions { grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); }
  .datum-form__review-key { font-weight: var(--font-weight-label, 600); }
  .datum-form__review-value { overflow-wrap: anywhere; }
  .datum-form__review-row--error { border-left: 4px solid var(--color-error-border, var(--color-error, #b3261e)); padding-left: 12px; }
  .datum-form__review-error { display: block; color: var(--color-error, #b3261e); font-weight: 600; }
  .datum-form__review-error-line { display: block; }
  .datum-form__review a { color: var(--color-accent, #2f6feb); text-decoration: underline; }
  .datum-form__review a:focus-visible { outline: var(--focus-ring-width, 2px) solid var(--focus-ring-color, var(--color-accent, #2f6feb)); outline-offset: var(--focus-ring-offset, 2px); }
  .datum-form__review-card { border: 1px solid var(--color-border, #c8cdd4); border-radius: var(--radius-panel, 6px); overflow: hidden; }
  .datum-form__review-card + .datum-form__review-card, .datum-form__review-list + .datum-form__review-card, .datum-form__review-card + .datum-form__review-list { margin-top: 10px; }
  .datum-form__review-card-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 16px; padding: 8px 14px; background: var(--color-panel-header, var(--color-light, #eceef1)); }
  .datum-form__review-card-title { margin: 0; font-size: inherit; font-weight: var(--font-weight-label, 600); }
  .datum-form__review-card > .datum-form__review-error { padding: 8px 14px 0; }
  .datum-form__review-card > .datum-form__review-list { padding: 0 14px; }
  .datum-form__review-card .datum-form__review-row:last-child { border-bottom: 0; }
  @container datum-review (max-width: 480px) {
    .datum-form__review-row, .datum-form__review-row--no-actions { grid-template-columns: minmax(0, 1fr); }
  }
`;

// ── What the page module calls ─────────────────────────────────────────────────────────────

/**
 * Adopts Datum's rules for the list into the form's root; returns what takes them away. First,
 * on both paths (a constructed sheet, else a `<style>`): it is adopted after the host's
 * `extraStyles` sheet, which must stay last, and its rules name only the list's own classes.
 */
function adoptReviewSheet(root: ShadowRoot): () => void {
  try {
    if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in root && typeof (CSSStyleSheet.prototype as { replaceSync?: unknown }).replaceSync === "function") {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(REVIEW_CSS);
      root.adoptedStyleSheets = [sheet, ...root.adoptedStyleSheets];
      return () => {
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
      };
    }
  } catch {
    // A root that has the property but refuses the sheet: the element below.
  }
  const style = (root.ownerDocument ?? document).createElement("style");
  style.setAttribute("data-datum-live", "");
  style.textContent = REVIEW_CSS;
  root.prepend(style);
  return () => style.remove();
}

/**
 * Takes Datum's rules for the list away (the page module's cleanup, on unmount). They are adopted
 * on the first draw of a Check answers page, so a form that never shows one is drawn as without
 * journeys.
 */
export function stopReview(live: LiveContext): void {
  const memory = memoryOf(live);
  memory.sheet?.();
  memory.sheet = undefined;
}

/**
 * The list a Check answers page draws under its heading, by the binding's `review` hook, else
 * Datum's; `undefined` on every other page. `ownMove` is called on a link's press (the person's
 * own move: the page module's quiet focus must not swallow it).
 */
export function reviewView(draw: DrawContext, page: PresentationPage, headingLevel: number, ownMove: () => void): View | undefined {
  const model = page.journey?.kind === "review" ? reviewModelOf(draw) : undefined;
  if (!model || model.sections.length === 0) {
    return undefined;
  }
  const live = draw.live;
  const memory = memoryOf(live);
  memory.sheet ??= adoptReviewSheet(live.root);
  const base = reviewStateOf(draw, model, headingLevel + 1, ownMove);
  const content = datumReview(base);
  const state: ReviewState = { ...base, content };
  const hook: LiveBinding["review"] = live.binding.review ?? live.datum.review;
  if (hook === undefined) {
    return live.binding !== live.datum ? draw.fallback(content) : content;
  }
  const drawn = live.call("review", page.id, () => hook(state));
  // A throw falls back to Datum's own; Datum's inside another binding is tinted by its tokens.
  return drawn !== undefined && live.binding.review !== undefined ? drawn : draw.fallback(drawn ?? content);
}

/** Where a summary entry on a Check answers page goes: the row of the answer, else its grid's first card. */
export function reviewSummaryTarget(entry: ErrorSummaryEntry, draw: DrawContext): { href: string; focus(): void } | undefined {
  const model = reviewModelOf(draw);
  if (!model) {
    return undefined;
  }
  const key = reviewKeyOf(model, entry.targetPath, entry.componentId);
  if (key === undefined) {
    return undefined;
  }
  const id = reviewItemId(model.pageId, key);
  const live = draw.live;
  return { href: `#${id}`, focus: () => void focusItem(live, id) };
}

/** The key of the row (or card) that shows an answer at `valuePath` of `componentId`. */
function reviewKeyOf(model: ReviewModel, valuePath: string | undefined, componentId: string): string | undefined {
  let byComponent: string | undefined;
  for (const section of model.sections) {
    for (const item of section.items) {
      const rows = item.kind === "row" ? [item] : item.rows;
      for (const row of rows) {
        if (row.valuePath === valuePath) {
          return row.key;
        }
        if (byComponent === undefined && row.componentId === componentId) {
          byComponent = row.key;
        }
      }
      if (item.kind === "card" && byComponent === undefined && item.componentId === componentId) {
        byComponent = item.key;
      }
    }
  }
  return byComponent;
}

/** The first error's place when no summary takes focus: its row on a Check answers page. `false` when the page lists no such row. */
export function focusReviewOwner(componentId: string, live: LiveContext): boolean {
  const output = live.output();
  const tree = live.tree();
  if (!output || !tree || tree.page?.journey?.kind !== "review") {
    return false;
  }
  const model = models.get(output) ?? undefined;
  const key = model ? reviewKeyOf(model, output.meta.firstErrorFocus?.targetPath, componentId) : undefined;
  return model !== undefined && key !== undefined && focusItem(live, reviewItemId(model.pageId, key));
}

/**
 * Back on the Check answers page a Change link left: focus goes to the row that was changed (its
 * first link). `true` when it did; `false` (focus to the heading) when there was no such move or
 * the row is not drawn any more. The move is used up either way.
 */
export function focusReviewReturn(live: LiveContext, page: PresentationPage): boolean {
  const memory = memoryOf(live);
  const returning = memory.returning;
  if (!returning) {
    return false;
  }
  if (page.journey?.kind !== "review" || returning.reviewPageId !== page.journey.pageId) {
    // Off the way back (a jump, Back past the step, another Check answers page): the row is
    // forgotten, so a later arrival at the page by another way focuses its heading.
    const view = (live.runtime as LiveRuntime & ReviewRuntime).journeyView?.();
    if (page.journey?.kind === "review" || view?.returning?.reviewPageId !== returning.reviewPageId) {
      memory.returning = undefined;
    }
    return false;
  }
  memory.returning = undefined;
  return focusItem(live, reviewItemId(returning.reviewPageId, returning.key));
}
