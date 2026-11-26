/**
 * A journey page: the heading, the description and the progress count above the page's
 * questions, and Back and Continue (Submit on the last page) under them. A {@link LiveFeature}
 * (`createJourneyPageFeature()`) the host lists in `features`; the page's components are drawn
 * by the renderer as any form's, and the binding's `page.heading` / `page.actions` (else Datum's,
 * {@link datumPage}) draw the rest from a {@link PageState}. The words, the progress and which
 * buttons the page has come from the presentation fold, so print and the PDF preview agree.
 *
 * What the renderer owns, whatever binding draws:
 * - the actions. Continue asks the runtime for the next page through `journeyAction` (it checks
 *   this page first, with the host's server when the page says so); on a refusal focus goes to the
 *   errors. The last page's Submit is the runtime's too: `journeyAction` names the intent and the
 *   renderer reports it as `datum-form-action` (`"submit"`, the form root's id and the journey),
 *   the route a form's own submit button takes; a last page with a submit or download button of
 *   its own presses that button instead. An exit page has no action: `PageState.next` is absent.
 *   Enter in a text box does what Continue does;
 * - busy. While a Continue is being worked out, or the host's server checks the page,
 *   `PageState.busy` is true: the buttons are drawn `aria-disabled` (never `disabled`), a press
 *   does nothing, and focus returns to the button pressed if the binding's button lost it;
 * - focus after a page change (`PAGE_CHANGED`): Continue, Back, a jump and a Check answers page's
 *   Change link put focus on the new page's heading (`PageState.headingId`), scrolled to the top of
 *   the view (back on the Check answers page after a Change, on the row that was changed:
 *   the Check answers kit, `JourneyReviewKit`, which draws that page's list); the runtime moving
 *   to the page holding an error takes the person to the error; starting or resuming leaves focus
 *   where it is. A page that draws no heading (hidden, or untitled) makes the form itself the
 *   place focus goes (`data-journey-page-focus`, `tabindex="-1"`), and so is the fallback when a
 *   binding's heading cannot take focus;
 * - `quietNextPageFocus()`: an agent's page move paints the page and leaves focus where it is.
 */
import { FormEventType, type PageChangedEventData } from "../../core/events/event-types.js";
import type { JourneyNavigationResult } from "../../core/journey/journey-types.js";
import { BUTTON_COMPONENT_TYPE, readButtonAction } from "../../core/schema/button.js";
import type { JourneyActionOutcome, JourneyActionPage } from "../../runtime/browser/journey/journey-action.js";
import type { PresentationPage } from "../core/presentation-tree.js";
import type { JourneyReviewKit } from "../core/journey-review-kit.js";
import type { LiveBinding, PageState } from "./contract.js";
import { datumPage } from "./datum/page.js";
import { html, nothing, type TemplateResult } from "./lit.js";
import type { DrawContext, FormRegion, LiveContext, LiveRuntime } from "./mount.js";
import type { SummaryTargetFeature } from "./summary.js";
import type { ErrorSummaryEntry } from "../core/error-summary.js";

const OWNER = "journey-page";

/** The action detail of `datum-form-action`, as the element reports a form's button. */
export interface JourneyFormActionDetail {
  componentId: string;
  action: "submit";
  journey: { journeyId: string; pageId: string };
}

/** What the renderer needs of the runtime for a journey page. */
export interface JourneyRuntime {
  journeyAction?(page: JourneyActionPage): Promise<JourneyActionOutcome>;
  previousPage?(): Promise<JourneyNavigationResult>;
}

/** The feature, with the call an agent's move makes before it moves. */
export interface JourneyPageFeature extends SummaryTargetFeature {
  /**
   * The next page change moves no focus and scrolls nothing (an agent never takes focus from
   * where the person left it). Nothing is quieted while focus is inside the form: it sits on the
   * page being left, which the move removes. One-shot: the next `PAGE_CHANGED` uses it up, and
   * the returned release ends it unused (call it when the agent's call settles).
   */
  quietNextPageFocus(): () => void;
  /**
   * Whether the page drawn is where the person was put after the page they asked for was refused:
   * a polite status line (`pageRedirected`) under the heading, until the next page change ends it.
   */
  setPageRedirected(on: boolean): void;
}

interface PageMemory {
  /** A page change awaiting the draw of its page. */
  queued: { pageId: string; direction: string } | undefined;
  quiet: boolean;
  generation: number;
  /** A Continue or Submit is out. */
  running: boolean;
  /** The page drawn is where a refused page request put the person. */
  redirected: boolean;
}

function memoryOf(live: LiveContext): PageMemory {
  return live.memory<PageMemory>(OWNER, () => ({ queued: undefined, quiet: false, generation: 0, running: false, redirected: false }));
}

const messageOf = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/** The id of a page's heading: what focus goes to after a page change. */
export const pageHeadingId = (pageId: string): string => `${pageId}__page-heading`;

// ── Datum's own page chrome ────────────────────────────────────────────────────────────────

// Datum's heading block and buttons live with the Datum binding (`datum/page.ts`).
export { datumPage };

function pageHookOf(live: LiveContext): NonNullable<LiveBinding["page"]> {
  return live.binding.page ?? live.datum.page ?? datumPage;
}

// ── Focus ──────────────────────────────────────────────────────────────────────────────────

/** Whether the page's heading is drawn: shown by the journey, and the page has a title. */
const headingDrawn = (page: PresentationPage): boolean => page.heading === "shown" && page.title !== "";

/** Moves focus to the page's heading, else the form; scrolled to the top of the view. */
function focusPage(live: LiveContext, page: PresentationPage): void {
  const form = live.form();
  const heading = live.root.getElementById(pageHeadingId(page.id));
  const target = heading instanceof HTMLElement ? heading : form;
  if (target === null) {
    return;
  }
  target.focus();
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "start" });
  }
  const active = live.root.activeElement;
  if (target !== form && form !== null && (active === null || !(active === target || target.contains(active)))) {
    // The binding's heading cannot take focus: the form does, and the host hears of it.
    form.tabIndex = -1;
    form.focus();
    live.error({ hook: "focus", id: page.id, message: "focus did not land on the page heading; the form took it" });
  }
}

// ── Actions ────────────────────────────────────────────────────────────────────────────────

/** The page's own submit button (else its download one), whose press the last page's action is. */
function ownSubmitButton(live: LiveContext): HTMLElement | undefined {
  const buttons = live.fields().filter((field) => field.node.base === BUTTON_COMPONENT_TYPE && !field.state.disabled);
  const action = (name: string) => buttons.find((field) => readButtonAction(field.state.model.node.configuration) === name);
  const field = action("submit") ?? action("download");
  const wrapper = field ? live.wrapperOf(field.key) : undefined;
  if (!wrapper) {
    return undefined;
  }
  return wrapper.querySelector<HTMLElement>("button, [role='button'], input[type='submit'], input[type='button'], a[href]") ?? (wrapper.firstElementChild instanceof HTMLElement ? wrapper.firstElementChild : undefined);
}

/** Continue, or Submit on the last page: through the runtime, which decides what the action comes to. */
async function forward(live: LiveContext, page: PresentationPage): Promise<void> {
  const journey = page.journey;
  const runtime = live.runtime as LiveRuntime & JourneyRuntime;
  const memory = memoryOf(live);
  if (!journey || !runtime.journeyAction || !live.mounted() || live.mode !== "interactive" || memory.running || live.busy() !== undefined) {
    return;
  }
  // The person's own move: an agent's unused quiet must not swallow its focus.
  memory.quiet = false;
  const active = live.root.activeElement;
  const pressed = active instanceof HTMLElement ? active : undefined;
  memory.running = true;
  // A Continue is worked out (the page checked, the host's server asked): the page says so while it is.
  const navigating = journey.kind === "questions" && !journey.final;
  if (navigating) {
    live.setBusy("navigating", true);
  }
  let outcome: JourneyActionOutcome = { kind: "idle" };
  try {
    outcome = await runtime.journeyAction({ journeyId: journey.journeyId, pageId: journey.pageId, kind: journey.kind, final: journey.final, hasOwnSubmit: journey.hasOwnSubmit, pending: journey.pending });
  } catch (thrown) {
    live.error({ hook: "journey", id: journey.pageId, message: messageOf(thrown) });
  } finally {
    memory.running = false;
    if (navigating) {
      live.setBusy("navigating", false);
    }
  }
  if (!live.mounted()) {
    return;
  }
  /** The page stayed and the button pressed lost focus while it was busy (a design system's button that can only be disabled): put it back. */
  const restorePressed = (): void => {
    if (live.tree()?.page?.id === page.id && pressed?.isConnected && live.root.activeElement === null) {
      pressed.focus();
    }
  };
  switch (outcome.kind) {
    case "moved": {
      await live.updated();
      if (!live.mounted()) {
        return;
      }
      if (!outcome.result.ok) {
        live.focusErrors();
      } else {
        restorePressed();
      }
      return;
    }
    case "own-submit":
      ownSubmitButton(live)?.click();
      return;
    case "submit": {
      const rootId = live.output()?.components.find((model) => model.parentId === undefined)?.id ?? live.runtime.formRoot().id;
      const detail: JourneyFormActionDetail = { componentId: rootId, action: "submit", journey: { journeyId: outcome.journeyId, pageId: outcome.pageId } };
      live.emit("datum-form-action", detail);
      return;
    }
    default:
      await live.updated();
      if (live.mounted()) {
        restorePressed();
      }
      return;
  }
}

/** Back: the page before this one on the path; nothing is validated. */
async function back(live: LiveContext, page: PresentationPage): Promise<void> {
  const runtime = live.runtime as LiveRuntime & JourneyRuntime;
  const journey = page.journey;
  if (!journey || !runtime.previousPage || !live.mounted() || live.mode !== "interactive" || live.busy() === "submitting" || journey.pending === "journey") {
    return;
  }
  memoryOf(live).quiet = false;
  try {
    await runtime.previousPage();
  } catch (thrown) {
    live.error({ hook: "journey", id: journey.pageId, message: messageOf(thrown) });
  }
}

/** The input types a browser submits a form from on Enter. */
const IMPLICIT_SUBMIT_TYPES = new Set(["text", "search", "tel", "url", "email", "password", "number", "date", "datetime-local", "month", "week", "time"]);

// ── The page's state ───────────────────────────────────────────────────────────────────────

/** The host's heading level as a whole level HTML has (1 to 6); 1 for none or one that is no number. */
function headingLevelOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(6, Math.max(1, Math.round(value))) : 1;
}

function pageState(draw: DrawContext, page: PresentationPage): PageState | undefined {
  const journey = page.journey;
  if (!journey) {
    return undefined;
  }
  const live = draw.live;
  const shown = headingDrawn(page);
  const busy = draw.form.busy === "navigating" || draw.form.busy === "submitting" || journey.pending !== undefined;
  const interactive = live.mode === "interactive";
  const checking = draw.form.busy !== "submitting" ? page.checking : undefined;
  return {
    journeyId: journey.journeyId,
    pageId: journey.pageId,
    title: shown ? page.title : "",
    ...(page.description !== undefined ? { description: page.description } : {}),
    ...(shown && page.progress !== undefined ? { progress: page.progress } : {}),
    headingId: pageHeadingId(page.id),
    headingLevel: headingLevelOf(live.options.headingLevel),
    ...(interactive && page.back !== undefined ? { back: () => void back(live, page) } : {}),
    // An exit page has no action: nothing to press, nothing drawn.
    ...(interactive && page.action !== undefined ? { next: () => void forward(live, page) } : {}),
    backLabel: page.back?.label ?? draw.words("back"),
    nextLabel: page.action?.label ?? draw.words(journey.final ? "submit" : "continue"),
    final: journey.final,
    busy,
    ...(checking !== undefined ? { checking } : {}),
    ...(memoryOf(live).redirected ? { redirected: true } : {}),
    words: draw.words
  };
}

// ── The feature ────────────────────────────────────────────────────────────────────────────

/**
 * A journey page's heading, actions and focus as a renderer module. One feature object per mount.
 * `review` draws a Check answers page's list and routes its errors and focus to the rows
 * (`core/journey-review-kit.ts`); without it such a page is drawn as its heading, its own content and
 * its actions. It is handed in, never imported, so the code that draws the list can be a chunk of its
 * own (`<datum-form>` loads it for a journey with a page of kind `review`).
 */
export function createJourneyPageFeature(review?: JourneyReviewKit): JourneyPageFeature {
  let current: LiveContext | undefined;
  return {
    id: OWNER,
    start(live) {
      current = live;
      const memory = memoryOf(live);
      const stopEvents = live.runtime.events().subscribe(FormEventType.PAGE_CHANGED, (event) => {
        const data = event.data as PageChangedEventData | undefined;
        if (data && typeof data.toPageId === "string") {
          // An agent's move (quietNextPageFocus) paints the page and leaves focus where it is.
          const quiet = memory.quiet;
          memory.quiet = false;
          // The next navigation ends the redirect line.
          memory.redirected = false;
          memory.queued = quiet ? undefined : { pageId: data.toPageId, direction: data.direction };
        }
      });
      // Enter in a text box does what Continue does (what a browser's implicit submission would do).
      const onKeydown = (event: KeyboardEvent): void => {
        if (event.key !== "Enter" || event.defaultPrevented || event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
          return;
        }
        const page = live.tree()?.page;
        const origin = event.composedPath()[0];
        if (!page?.journey || !(origin instanceof HTMLInputElement) || !IMPLICIT_SUBMIT_TYPES.has(origin.type)) {
          return;
        }
        // A last page with a submit or download button of its own has no action of its own, and Enter presses that button.
        if (page.action === undefined && !(page.journey.final && page.journey.hasOwnSubmit)) {
          return;
        }
        // preventDefault also cancels the browser's change event: the typed answer is settled here, before the page moves.
        event.preventDefault();
        live.settleInput();
        void forward(live, page);
      };
      live.root.addEventListener("keydown", onKeydown as EventListener);
      return () => {
        stopEvents();
        review?.stop(live);
        live.root.removeEventListener("keydown", onKeydown as EventListener);
        if (current === live) {
          current = undefined;
        }
      };
    },
    region(region: FormRegion, draw: DrawContext) {
      if (region !== "page-header" && region !== "page-actions") {
        return undefined;
      }
      const page = draw.tree.page;
      const state = page ? pageState(draw, page) : undefined;
      if (!page || !state) {
        return undefined;
      }
      const live = draw.live;
      const hook = pageHookOf(live);
      // Datum's heading and buttons inside another binding are tinted by its tokens.
      const own = live.binding.page !== undefined;
      if (region === "page-header") {
        // A Check answers page's list sits under its heading (the person's own move clears a quiet focus).
        const list = review?.view(draw, page, state.headingLevel, () => {
          memoryOf(live).quiet = false;
        });
        if (state.title === "" && !state.description && state.redirected !== true) {
          return list;
        }
        const drawn = live.call("page.heading", page.id, () => hook.heading(state));
        const heading = drawn !== undefined && own ? drawn : draw.fallback(drawn ?? datumPage.heading(state));
        return list !== undefined ? html`${heading}${list}` : heading;
      }
      if (state.next === undefined && state.back === undefined && state.checking === undefined) {
        return undefined;
      }
      const actions = live.call("page.actions", page.id, () => hook.actions(state));
      return actions !== undefined && own ? actions : draw.fallback(actions ?? datumPage.actions(state));
    },
    formDecor(draw) {
      // A page with no heading drawn makes the form the place focus goes after a page change.
      const page = draw.tree.page;
      return page?.journey && !headingDrawn(page) ? { attributes: { "data-journey-page-focus": "", tabindex: "-1" } } : undefined;
    },
    afterDraw(report, live) {
      const memory = memoryOf(live);
      const page = report.tree.page;
      const queued = memory.queued;
      // A draw of another page (a build already in flight when the page changed) leaves the move queued for the next.
      if (!queued || !page || page.id !== queued.pageId) {
        return;
      }
      memory.queued = undefined;
      if (queued.direction === "error") {
        void live.updated().then(() => {
          if (live.mounted()) {
            live.focusErrors();
          }
        });
      } else if (queued.direction === "forward" || queued.direction === "back" || queued.direction === "jump" || queued.direction === "change") {
        void live.updated().then(() => {
          if (live.mounted() && live.tree()?.page?.id === page.id && review?.focusReturn(live, page) !== true) {
            focusPage(live, page);
          }
        });
      }
    },
    // A Check answers page lists answers as rows: an error on one links to, and focuses, its row.
    ...(review !== undefined
      ? {
          summaryTarget: (entry: ErrorSummaryEntry, draw: DrawContext) => review.summaryTarget(entry, draw),
          focusOwner: (componentId: string, live: LiveContext) => review.focusOwner(componentId, live)
        }
      : {}),
    setPageRedirected(on) {
      const live = current;
      if (!live) {
        return;
      }
      const memory = memoryOf(live);
      if (memory.redirected !== on) {
        memory.redirected = on;
        live.redraw();
      }
    },
    quietNextPageFocus() {
      const live = current;
      if (!live || live.root.activeElement) {
        return () => undefined;
      }
      const memory = memoryOf(live);
      memory.generation += 1;
      const generation = memory.generation;
      memory.quiet = true;
      memory.queued = undefined;
      return () => {
        if (memory.generation === generation) {
          memory.quiet = false;
        }
      };
    }
  };
}
