/**
 * The Journeys designer's own chrome, in plain DOM: the popover the bar's `+` opens
 * (a journey made from the form in one of its shapes — a page at a time or all on one page
 * — or a copy of the one on the page), and the surface the canvas shows while the form has
 * no journey. Drawn for `createJourneyBuilderMode`, inside a `<datum-builder>`'s shadow roots,
 * under the builder's own `--db-*` tokens so a builder theme restyles them.
 *
 * Both say what is at stake before a journey exists: any journey
 * saved into the form is one the server accepts a submission through, and the server
 * holds every answer to the form's rules, asked or not — which is why every shape puts every
 * question on a page, and there is no empty start.
 *
 * The markup is built by pure functions (`journeyAddPopoverHtml`, `journeyEmptyStateHtml`), so
 * what they say is tested without a DOM. In the designer's lazy chunk; nothing runs at import.
 */
import { escapeHtml } from "../../render/core/escape-html.js";
import { placePopover } from "../popover-place.js";
import type { JourneyShape } from "./journey-from-form.js";
import { JOURNEY_STAKES_TEXT } from "./journey-components.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { builderPlural, builderText } from "./journey-texts-en.js";

const esc = escapeHtml;

/** What the add popover makes: a journey from the form in a shape, or a copy of the journey on the page. */
export type JourneyAddChoice = JourneyShape | "blank" | "copy";


/*
 * The popover's host sits in the shell's root, which prints the shared patterns (menu, note) and
 * the confirm buttons but not the element-wide box rules, so its name box keeps its own; the
 * empty state is drawn in the canvas's root, which prints all of them, and is the shared
 * page-card (empty-state, is-page) with a primary button.
 */
export const JOURNEY_DESIGNER_PANEL_STYLES = `
  /* The popover under the bar's + button: the shared menu card, placed and sized here. */
  .jd-add {
    position: fixed; box-sizing: border-box;
    width: min(340px, calc(var(--db-shell-w, 100vw) - 16px));
    gap: var(--db-space-3); padding: var(--db-space-3);
    font: var(--db-text-md)/1.45 var(--db-font);
  }
  /* A section heading: sentence case, small and muted. */
  .jd-add h3 { margin: 0 0 var(--db-space-1); color: var(--db-ink-muted); font-size: var(--db-text-sm); font-weight: 600; letter-spacing: .02em; }
  .jd-add__name { display: grid; gap: var(--db-space-1); font-size: var(--db-text-md); font-weight: 500; }
  .jd-add__name input {
    box-sizing: border-box; width: 100%; min-height: var(--db-control-h); padding: 0 var(--db-space-3);
    border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-md);
    background: var(--db-surface); color: var(--db-ink); font: inherit; font-size: var(--db-text-base); font-weight: 400;
  }
  .jd-add__group { display: grid; gap: var(--db-space-half); }
  /* The page card's paragraphs are muted; the stakes are what the author must read, so they stay ink. */
  .empty-state > .note { color: var(--db-ink); }
`;

// --- the add popover -------------------------------------------------------------------------

/** What the add popover shows. */
export interface JourneyAddView {
  /** The name a journey made from the form gets unless the author types one: the box's placeholder. */
  name: string;
  /** A journey is on the page to copy. */
  canCopy: boolean;
  /** The form's answer-holding components, which every shape puts on a page. */
  questionCount: number;
  error?: string | undefined;
  /** The builder's words (locale and catalog); English when absent. */
  text?: BuilderTextOptions | undefined;
}

/** The ids the add popover's dialog is described by (`aria-describedby`); the empty state's paragraphs take none, so no id is used twice. */
const JOURNEY_ADD_STAKES_ID = "jd-add-stakes";
const JOURNEY_ADD_HINT_ID = "jd-add-hint";

/**
 * The add popover's markup: a name, the one empty step a journey starts as, a copy of the
 * journey on the page, and what is at stake. A new journey asks nothing yet: its fields are
 * added from the Form fields panel, and the journey's findings say which of the form's
 * required fields it still leaves out.
 */
export function journeyAddPopoverHtml(view: JourneyAddView): string {
  const text = view.text;
  const hint = builderText("journey.designer.add.hint", undefined, text);
  return `
    <label class="jd-add__name">${esc(builderText("journey.designer.add.name", undefined, text))}
      <input type="text" data-journey-add-name value="" placeholder="${esc(view.name)}" autocomplete="off" spellcheck="false">
    </label>
    <div class="jd-add__group">
      <h3>${esc(builderText("journey.designer.add.start", undefined, text))}</h3>
      <button type="button" class="menu-item" data-journey-add="blank">${esc(builderText("journey.designer.add.empty", undefined, text))}</button>
    </div>
    ${
      view.canCopy
        ? `<div class="jd-add__group">
      <h3>${esc(builderText("journey.designer.add.onPageNow", undefined, text))}</h3>
      <button type="button" class="menu-item" data-journey-add="copy">${esc(builderText("journey.designer.add.copy", undefined, text))}</button>
    </div>`
        : ""
    }
    <p class="note" id="${JOURNEY_ADD_HINT_ID}">${esc(hint)}</p>
    <p class="note" data-tone="warning" id="${JOURNEY_ADD_STAKES_ID}" data-journey-add-stakes>${esc(JOURNEY_STAKES_TEXT)}</p>
    ${view.error ? `<p class="note" data-tone="error" data-journey-add-error>${esc(view.error)}</p>` : ""}`;
}

export interface JourneyAddPopoverContext {
  /** The placeholder name ("Journey", "Journey 2", …). */
  defaultName(): string;
  canCopy(): boolean;
  questionCount(): number;
  /** The builder's words (locale and catalog), read when the popover opens. */
  text?(): BuilderTextOptions | undefined;
  /**
   * The author chose; the popover has closed. `name` is what they typed, blank when nothing: a
   * journey from the form then takes the default name, a copy the catalog's. A throw is shown
   * in the popover, which opens again.
   */
  onChoose(choice: JourneyAddChoice, name: string): void | Promise<void>;
}

export interface JourneyAddPopover {
  /**
   * Opens under `anchor` (an overview's New, or the empty state's button); with none, at the top
   * of the shell. `onDismiss` is called when it closes with no journey chosen.
   */
  open(anchor: HTMLElement | undefined, options?: { onDismiss?(): void }): void;
  close(): void;
  readonly isOpen: boolean;
}

function isAddChoice(value: string | undefined): value is JourneyAddChoice {
  return value === "blank" || value === "copy";
}

export function createJourneyAddPopover(host: HTMLElement, context: JourneyAddPopoverContext): JourneyAddPopover {
  host.classList.add("jd-add", "menu");
  host.setAttribute("role", "dialog");
  // The stakes come after the choices, and focus starts in the Name box, whose Enter makes a
  // journey: the dialog names them as focus enters it.
  host.setAttribute("aria-describedby", `${JOURNEY_ADD_STAKES_ID} ${JOURNEY_ADD_HINT_ID}`);
  host.hidden = true;
  host.setAttribute("aria-label", builderText("journey.designer.new.label", undefined, context.text?.()));
  let anchorEl: HTMLElement | undefined;
  let error: string | undefined;
  let dismissed: (() => void) | undefined;

  const isOpen = (): boolean => !host.hidden;

  const render = (name: string): void => {
    host.innerHTML = journeyAddPopoverHtml({ name, canCopy: context.canCopy(), questionCount: context.questionCount(), error, text: context.text?.() });
  };

  const place = (): void => placePopover(host, anchorEl);

  const onWindowClick = (event: MouseEvent): void => {
    const path = event.composedPath();
    if (!path.includes(host) && !(anchorEl && path.includes(anchorEl))) {
      close();
    }
  };

  const open = (anchor: HTMLElement | undefined, options: { onDismiss?(): void } = {}): void => {
    anchorEl = anchor;
    dismissed = options.onDismiss;
    render(context.defaultName());
    error = undefined;
    place();
    host.hidden = false;
    host.querySelector<HTMLInputElement>("[data-journey-add-name]")?.focus();
    // On the next turn: the click that opened the popover must not close it.
    setTimeout(() => {
      if (isOpen()) {
        window.addEventListener("click", onWindowClick);
      }
    }, 0);
  };

  /** Closes; `chosen` says a journey is being made, so the flow has not been dismissed. */
  const close = (chosen = false): void => {
    if (host.hidden) {
      return;
    }
    host.hidden = true;
    window.removeEventListener("click", onWindowClick);
    const onDismiss = dismissed;
    dismissed = undefined;
    if (!chosen) {
      onDismiss?.();
    }
  };

  const choose = (choice: JourneyAddChoice): void => {
    const name = host.querySelector<HTMLInputElement>("[data-journey-add-name]")?.value.trim() ?? "";
    const onDismiss = dismissed;
    close(true);
    void Promise.resolve()
      .then(() => context.onChoose(choice, name))
      .catch((failure: unknown) => {
        // The journey could not be made: say why where the author asked for it.
        error = failure instanceof Error ? failure.message : String(failure);
        open(anchorEl, onDismiss ? { onDismiss } : {});
        error = undefined;
      });
  };

  host.addEventListener("click", (event) => {
    const choice = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-journey-add]")?.dataset.journeyAdd;
    if (isAddChoice(choice)) {
      choose(choice);
    }
  });
  host.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Escape") {
      event.preventDefault();
      close();
      anchorEl?.focus();
      return;
    }
    // Enter in the name box starts the empty journey, the one start there is.
    if (key === "Enter" && (event.target as HTMLElement | null)?.matches?.("[data-journey-add-name]")) {
      event.preventDefault();
      choose("blank");
    }
  });

  return {
    open,
    close: () => close(),
    get isOpen() {
      return isOpen();
    }
  };
}

// --- the empty state -------------------------------------------------------------------------

/** What the canvas says while the form has no journey. */
export function journeyEmptyStateHtml(view: { questionCount: number; text?: BuilderTextOptions | undefined }): string {
  const text = view.text;
  return `
    <h2>${esc(builderText("journey.designer.empty.title", undefined, text))}</h2>
    <p>${esc(builderText("journey.designer.empty.lead", undefined, text))}</p>
    <p>${esc(builderText("journey.designer.empty.form", { questions: builderPlural("journey.designer.questions", view.questionCount, undefined, text) }, text))}</p>
    <p class="note" data-tone="warning" data-journey-empty-stakes>${esc(builderText("journey.designer.stakes", undefined, text))}</p>
    <button type="button" class="btn primary" data-journey-empty-add>${esc(builderText("journey.designer.new.button", undefined, text))}</button>`;
}

export interface JourneyEmptyState {
  readonly element: HTMLElement;
  /** Redraws what it says (the form's question count). */
  update(view: { questionCount: number }): void;
}

/** The empty state's surface: its button opens the add popover under it. */
export function createJourneyEmptyState(context: { onAdd(anchor: HTMLElement): void; text?(): BuilderTextOptions | undefined }): JourneyEmptyState {
  const element = document.createElement("div");
  element.className = "empty-state is-page";
  element.setAttribute("data-journey-empty", "");
  element.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-journey-empty-add]");
    if (button) {
      context.onAdd(button);
    }
  });
  let drawn: string | undefined;
  return {
    element,
    update(view) {
      const html = journeyEmptyStateHtml({ ...view, text: context.text?.() });
      if (html !== drawn) {
        drawn = html;
        element.innerHTML = html;
      }
    }
  };
}
