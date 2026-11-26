/**
 * A journey made from the form: the pages an author starts from, and the form's
 * components a journey leaves on no page. Authoring only, so it lives with the builder rather
 * than in `core/journey`, which holds the definition language and the functions the validation
 * sandbox splices.
 *
 * Every shape puts every question of the form on a page. A question on no page is one the
 * journey never asks, and the server accepts a submission through any declared journey,
 * so a journey that left questions off would let a client skip them —
 * required or not — unchecked. There is therefore no blank shape: the smallest journey is the
 * whole form on one page, which the author then splits.
 *
 * - `"sections"`: a page per part of the form. A top-level group (a fieldset, a panel, a
 *   data-scoping container, a repeating section) is one page listing the group; a `tabs`
 *   container gives a page per tab, and a `steps` container a page per step, each listing what
 *   the tab or step holds under its caption; a run of loose top-level fields is one page.
 * - `"questions"`: a page per question — each field that holds an answer, found at any depth,
 *   with a repeating section or a data grid kept whole, since a page cannot show one field of
 *   every entry.
 * - `"one-page"`: one page listing every top-level component.
 * - `"questions-one-page"`: the `"questions"` pages run together onto one page — every question
 *   found at any depth, lifted out of its groups, a repeating section or a data grid kept whole.
 *   The one-page shapes start a journey that looks like the form; each takes `title` when
 *   given (the form's own title, as the mode passes it).
 *
 * In the questions shapes and the sections shape, what asks nothing — static text, an image, a
 * hidden or calculated field — rides along with the page after it (with the run it sits in, for
 * loose fields), or with the last page when nothing follows. A button (Submit, Download, Reset)
 * is no question and no page's title wherever the form puts it: it rides with the last page —
 * the one page of the one-page shapes — so a Submit seeded first never opens page 1; the
 * root's closing buttons go there too, so its Submit is the form's own. Page ids are `page-1`, `page-2`, …, never the
 * id of a component of the form or one in `taken`.
 *
 * In the designer's lazy chunk; free of work at import.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import type { Journey, JourneyPage } from "../../core/schema/journey.js";
import { addressOf, type TextAddress } from "../../core/localization/translations.js";
import { STEP_COMPONENT_TYPE, STEPS_COMPONENT_TYPE } from "../../core/schema/steps.js";
import { kernelReadFlag } from "../../core/state/semantic-state.js";
import { holdsData, isDataScopeContainer } from "../../core/tree/data-scope.js";
import { journeyOwn, journeyOwnership } from "../../core/journey/journey-path.js";
import { TABS_COMPONENT_TYPE, readTabDescriptors, tabSlotIds } from "../../render/core/tab-slots.js";
import { trailingButtonIds } from "../data-model/generate.js";

/** How a journey made from the form divides it into pages. */
export type JourneyShape = "sections" | "questions" | "one-page" | "questions-one-page";

/** The shapes that make one page. */
export function isOnePageShape(shape: JourneyShape): boolean {
  return shape === "one-page" || shape === "questions-one-page";
}

export interface JourneyPagesFromFormOptions {
  shape: JourneyShape;
  /** Page ids no page may take, besides the ids of the form's own components. */
  taken?: Iterable<string>;
  /** Which leaves carry no answer. Absent: the engine's (a button, static HTML, an image, a signature). */
  isValueless?: ((node: ComponentNode) => boolean) | undefined;
  /** The one page's title, for the one-page shapes (a one-page start is titled as the form). Absent: none. */
  title?: string | undefined;
  /** Where the translations of `title` live (the form's own title), for a caller that carries them to the page. */
  titleFrom?: TextAddress | undefined;
  /**
   * Out: for each page that took its title from a text of the form, the page's id and the
   * address that text's translations live at. The title is a plain string, so what
   * the form said in other languages does not come with it; the caller copies those entries to
   * `journeys › <journey id> › pages › <page id> › title` (their `source` stays valid: the
   * default string is the same).
   */
  titleOrigins?: Array<{ pageId: string; from: TextAddress }> | undefined;
}

export interface JourneyFromFormOptions extends JourneyPagesFromFormOptions {
  /** The journey's id: the catalog's to make unique (`uniqueJourneyId`). */
  id: string;
  name?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A caption as written, unless it is blank or not a text at all (a definition text is a string). */
function worded(text: unknown): string | undefined {
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
}

/** A node's label, for the page that stands for it, and where its translations live. */
function labelOf(node: ComponentNode): TitleDraft | undefined {
  const title = worded(isRecord(node.configuration) ? node.configuration.label : undefined);
  return title !== undefined ? { title, from: addressOf.component(node.id, "label") } : undefined;
}

/** A page's title, and the address of the text of the form it was taken from (none: written for the page). */
interface TitleDraft {
  title: string;
  from?: TextAddress | undefined;
}

/** A tab's caption as a page's title; its translations live at `components › <container> › tabs › <tab id> › label`. */
function tabTitle(container: ComponentNode, tabId: string, label: unknown): TitleDraft | undefined {
  const title = worded(label);
  return title !== undefined ? { title, from: { kind: "components", owner: container.id, path: ["tabs", tabId, "label"] } } : undefined;
}

/**
 * The slots of `node` in the order the form shows them: a `tabs` container's in its tabs' order,
 * then any slot no tab declares (the form never shows it, but what it holds is still asked for);
 * any other node's in the order the tree holds them.
 */
function slotIdsOf(node: ComponentNode): string[] {
  const slots = Object.keys(node.children ?? {});
  if (node.type !== TABS_COMPONENT_TYPE) {
    return slots;
  }
  const declared = tabSlotIds(node);
  return [...declared, ...slots.filter((slot) => !declared.includes(slot))];
}

/** Every child of `node`, slot by slot in the order of {@link slotIdsOf}. */
function childrenOf(node: ComponentNode): ComponentNode[] {
  return slotIdsOf(node).flatMap((slot) => node.children?.[slot] ?? []);
}

function hasChildren(node: ComponentNode): boolean {
  return childrenOf(node).length > 0;
}

function collectIds(node: ComponentNode, into: Set<string>): void {
  into.add(node.id);
  for (const child of childrenOf(node)) {
    collectIds(child, into);
  }
}

/**
 * A list of entries: kept whole on one page, since a page cannot show one field of every
 * entry. A data grid is one through its collection binding, like a repeating section.
 */
function isEntries(node: ComponentNode): boolean {
  return node.collection !== undefined;
}

function isHidden(node: ComponentNode): boolean {
  return kernelReadFlag(node.configuration, "hidden");
}

function isCalculated(node: ComponentNode): boolean {
  return node.rules?.value !== undefined;
}

/** Group types that show nothing of their own once empty. */
const FRAME_TYPES: readonly string[] = [TABS_COMPONENT_TYPE, STEPS_COMPONENT_TYPE, STEP_COMPONENT_TYPE];

/** A group with nothing in it: no page lists it, since it has nothing to show or ask. */
function isEmptyGroup(node: ComponentNode): boolean {
  return (
    !hasChildren(node) &&
    !isEntries(node) &&
    (node.children !== undefined || FRAME_TYPES.includes(node.type) || isDataScopeContainer(node))
  );
}

interface DraftPage {
  components: string[];
  title?: TitleDraft | undefined;
}

/** Pages being laid out: riders wait for the next page, loose fields gather into one. */
class PageLayout {
  public readonly pages: DraftPage[] = [];
  private pending: string[] = [];
  private run: DraftPage | undefined;
  private closing: string[] = [];

  /**
   * A button (Submit, Download, Reset) asks nothing and is not a question, wherever the form
   * puts it: it waits for the end and rides with the last page, so it never opens page 1, never
   * titles a page and is never a page by itself.
   */
  public button(id: string): void {
    this.closing.push(id);
  }

  /** Asks nothing: joins the open run of loose fields, else waits for the next page. */
  public rider(id: string): void {
    if (this.run) {
      this.run.components.push(id);
    } else {
      this.pending.push(id);
    }
  }

  /** A loose field: joins the open run, or opens one. */
  public loose(id: string): void {
    if (this.run) {
      this.run.components.push(id);
      return;
    }
    this.run = { components: [...this.pending, id] };
    this.pending = [];
    this.pages.push(this.run);
  }

  /** A page of its own; closes any run. */
  public page(components: string[], title?: TitleDraft): void {
    this.run = undefined;
    this.pages.push({ components: [...this.pending, ...components], ...(title !== undefined ? { title } : {}) });
    this.pending = [];
  }

  /** Whatever still waits, then the closing buttons, onto the last page (or a page of their own). */
  public finish(trailing: readonly string[]): DraftPage[] {
    const leftover = [...this.pending, ...this.closing, ...trailing];
    this.pending = [];
    this.closing = [];
    this.run = undefined;
    if (leftover.length > 0) {
      const last = this.pages[this.pages.length - 1];
      if (last) {
        last.components.push(...leftover);
      } else {
        this.pages.push({ components: leftover });
      }
    }
    return this.pages;
  }
}

/** Whether a node holds an answer of its own, by the host's idea of which leaves carry none. */
type HoldsData = (node: ComponentNode) => boolean;

/** A button of any type: never a question and never a page's title. */
function isButton(node: ComponentNode): boolean {
  return node.type === "button";
}

function sectionsLayout(nodes: readonly ComponentNode[], layout: PageLayout, holds: HoldsData): void {
  const visit = (node: ComponentNode): void => {
    if (isButton(node) && !hasChildren(node)) {
      layout.button(node.id);
      return;
    }
    if (isHidden(node)) {
      layout.rider(node.id);
      return;
    }
    if (isEntries(node)) {
      layout.page([node.id]);
      return;
    }
    if (isEmptyGroup(node)) {
      return;
    }
    if (isDataScopeContainer(node)) {
      layout.page([node.id]);
      return;
    }
    if (node.type === TABS_COMPONENT_TYPE) {
      const labels = new Map(readTabDescriptors(node).map((tab) => [tab.id, tab.label]));
      for (const slotId of slotIdsOf(node)) {
        const content = node.children?.[slotId] ?? [];
        if (content.length > 0) {
          layout.page(
            content.map((child) => child.id),
            tabTitle(node, slotId, labels.get(slotId))
          );
        }
      }
      return;
    }
    if (node.type === STEPS_COMPONENT_TYPE) {
      for (const child of childrenOf(node)) {
        // A hidden step rides along like any hidden component: its caption titles no page.
        if (child.type !== STEP_COMPONENT_TYPE || !hasChildren(child) || isHidden(child)) {
          visit(child);
        } else {
          layout.page(
            childrenOf(child).map((grandchild) => grandchild.id),
            labelOf(child)
          );
        }
      }
      return;
    }
    if (hasChildren(node)) {
      layout.page([node.id]);
      return;
    }
    // A calculated field asks nothing: it rides along, as in the questions shape.
    if (holds(node) && !isCalculated(node)) {
      layout.loose(node.id);
      return;
    }
    layout.rider(node.id);
  };
  for (const node of nodes) {
    visit(node);
  }
}

function questionsLayout(nodes: readonly ComponentNode[], layout: PageLayout, holds: HoldsData): void {
  const visit = (node: ComponentNode): void => {
    if (isButton(node) && !hasChildren(node)) {
      layout.button(node.id);
      return;
    }
    if (isHidden(node)) {
      layout.rider(node.id);
      return;
    }
    if (isEntries(node)) {
      layout.page([node.id]);
      return;
    }
    if (hasChildren(node)) {
      for (const child of childrenOf(node)) {
        visit(child);
      }
      return;
    }
    if (isEmptyGroup(node)) {
      return;
    }
    if (holds(node) && !isCalculated(node)) {
      layout.page([node.id]);
      return;
    }
    layout.rider(node.id);
  };
  for (const node of nodes) {
    visit(node);
  }
}

/** The pages of a journey made from the form under `root`, in the shape asked for. None for an empty form. */
export function journeyPagesFromForm(root: ComponentNode, options: JourneyPagesFromFormOptions): JourneyPage[] {
  const holdsOptions = options.isValueless ? { isValueless: options.isValueless } : {};
  const holds: HoldsData = (node) => holdsData(node, holdsOptions);
  const top = childrenOf(root);

  let drafts: DraftPage[];
  if (options.shape === "one-page") {
    // The form's own order, but for its buttons: they close the page, as they do the other shapes.
    const asked = top.filter((node) => !isButton(node)).map((node) => node.id);
    const buttons = top.filter(isButton).map((node) => node.id);
    drafts = top.length > 0 ? [{ components: [...asked, ...buttons] }] : [];
  } else {
    const trailing = trailingButtonIds(top);
    const body = top.slice(0, top.length - trailing.length);
    const layout = new PageLayout();
    if (options.shape === "sections") {
      sectionsLayout(body, layout, holds);
    } else {
      questionsLayout(body, layout, holds);
    }
    drafts = layout.finish(trailing);
    if (options.shape === "questions-one-page" && drafts.length > 1) {
      // The questions pages run together: every question in the order the pages asked them.
      drafts = [{ components: drafts.flatMap((draft) => draft.components) }];
    }
  }
  const title = worded(options.title);
  if (title !== undefined && isOnePageShape(options.shape) && drafts[0] !== undefined) {
    drafts[0].title = { title, from: options.titleFrom };
  }

  const taken = new Set<string>(options.taken ?? []);
  collectIds(root, taken);
  let n = 0;
  const nextId = (): string => {
    do {
      n += 1;
    } while (taken.has(`page-${n}`));
    taken.add(`page-${n}`);
    return `page-${n}`;
  };
  return drafts.map((draft): JourneyPage => {
    const id = nextId();
    if (draft.title?.from !== undefined) {
      options.titleOrigins?.push({ pageId: id, from: draft.title.from });
    }
    return {
      id,
      ...(draft.title !== undefined ? { title: draft.title.title } : {}),
      components: draft.components
    };
  });
}

/** A journey made from the form under `root`: `journeyPagesFromForm`'s pages under the id and name given. */
export function journeyFromForm(root: ComponentNode, options: JourneyFromFormOptions): Journey {
  return {
    id: options.id,
    ...(options.name !== undefined ? { name: options.name } : {}),
    pages: journeyPagesFromForm(root, options)
  };
}

/**
 * The form's components `journey` asks on no page, in document order, as a page would list them:
 * what `diagnoseJourney` reports as `component.unassigned` — an answer-holding component with no
 * page, itself or above it — with a group none of whose contents is on a page given as the group
 * itself, so it comes with its heading (a step excepted: its steps container draws it).
 * Components hidden by their configuration with no rule to show them (and all under them),
 * calculated ones and ones that ask nothing are left out, as the diagnostics leave them; a
 * hidden component with a `visibleWhen` may be shown, so it is a question like any other, as
 * the diagnostics judge it. What "Add unassigned" puts on a page. A hidden field the diagnostics
 * still hold required (one opting in to being required and validated while hidden) is
 * not listed: no page can show it, so the tray draws it from its finding, with the fix that
 * helps.
 */
export function unassignedMembers(
  root: ComponentNode,
  journey: Journey,
  options: { isValueless?: ((node: ComponentNode) => boolean) | undefined } = {}
): string[] {
  const ownership = journeyOwnership(root, journey);
  const holdsOptions = options.isValueless ? { isValueless: options.isValueless } : {};
  const asks = (node: ComponentNode): boolean => holdsData(node, holdsOptions) && !isCalculated(node);
  // Off screen on both sides: hidden by its configuration with no rule to show it.
  const alwaysHidden = (node: ComponentNode): boolean => isHidden(node) && !(node.rules && node.rules.visibleWhen);
  // Whether anything under `node` would be reported: nothing under it is on a page by then.
  const asksWithin = (node: ComponentNode): boolean =>
    childrenOf(node).some((child) => !alwaysHidden(child) && (asks(child) || asksWithin(child)));

  const out: string[] = [];
  const visit = (node: ComponentNode): void => {
    const owners = journeyOwn(ownership.pagesOf, node.id);
    if ((owners !== undefined && owners.length > 0) || alwaysHidden(node)) {
      return;
    }
    if (journeyOwn(ownership.structural, node.id) !== true) {
      // A step is drawn by its steps container, so one on a page by itself would lose its
      // frame: its contents are listed instead.
      const collapses = node.type !== STEP_COMPONENT_TYPE && !holdsData(node, holdsOptions);
      if (asks(node) || (collapses && asksWithin(node))) {
        out.push(node.id);
        return;
      }
      if (!holdsData(node, holdsOptions) && node.type !== STEP_COMPONENT_TYPE) {
        return;
      }
    }
    for (const child of childrenOf(node)) {
      visit(child);
    }
  };
  for (const child of childrenOf(root)) {
    visit(child);
  }
  return out;
}
