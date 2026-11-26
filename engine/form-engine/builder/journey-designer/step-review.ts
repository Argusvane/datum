/**
 * What the builder knows of a Check answers step (`kind: "review"`):
 * which answers the step will list, and the form copied under it so the real review drawing has
 * something to list while the step is edited.
 *
 * The step lists the answers given on the path, in path order, each under the earliest step that
 * asks it (`render/core/journey-review.ts`, `journeyReviewListed`). The builder has no path, only
 * the list order, so what it shows is what a person who passed every step would see. The rule is
 * the engine's, read again here in a few lines rather than imported: that module carries the
 * answer wording (print's), and the designer's chunk has no use for the rest. A test holds this
 * copy to the engine's on the shared fixtures (`journey-review-builder.test.ts`).
 *
 * - {@link journeyReviewListing}: the listed answers by step, for the inspector's "Answers
 *   listed" and the map's "n listed".
 * - {@link reviewAnswersForm}: the form's tree as the step's canvas carries it (rules stripped,
 *   the listed fields given a placeholder answer), so the drawing names every row and fills it.
 * - {@link reviewRowComponent}: the form component a drawn row stands for, for its Wording box.
 *
 * In the designer's chunk; nothing here runs at import.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import {
  PRESENTATION_REFERENCE_TYPE,
  PRESENTATION_VALUE_TYPE,
  journeyPageKind,
  type Journey,
  type PresentationNode
} from "../../core/schema/journey.js";
import { journeyEntryPlacesForm, journeyOwnership, journeyPageOfComponent } from "../../core/journey/journey-path.js";
import type { JourneyOwnership, JourneyTrace } from "../../core/journey/journey-types.js";
import { readInlineOptions } from "../../core/schema/inline-options.js";
import { collectionPathOf, createValuePathResolver, holdsData } from "../../core/tree/data-scope.js";

/** The slot of the step's drawn root that holds the form, which the review lists from and never draws. */
export const REVIEW_ANSWERS_SLOT = "review-answers";

/** The text a row's answer shows while the step is edited: a number, a date and a tick read as themselves. */
const PLACEHOLDER_DATE = "2026-01-15";
const PLACEHOLDER_NUMBER = 123;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an own node of a step places a form field: the engine drops such an entry whole on a Check answers step. */
export function reviewDropsEntry(node: ComponentNode): boolean {
  return journeyEntryPlacesForm(node as unknown as PresentationNode);
}

/**
 * Component id -> the earliest step of `journey` (in list order, the builder's stand-in for the
 * path) that asks it: the engine's `pageOf` as the person who passed every step would have it.
 */
export function reviewPageOf(formRoot: ComponentNode, journey: Journey, ownership?: JourneyOwnership): Record<string, string> {
  const owned = ownership ?? journeyOwnership(formRoot, journey);
  const trace: JourneyTrace = { pages: journey.pages.map((page) => page.id), end: "end", decisions: [] };
  return journeyPageOfComponent(owned, trace);
}

/** One questions step's top-level answers: the form components it lists, as the review takes them. */
export interface ReviewStepIds {
  pageId: string;
  /** The form components the step lists (a string, a reference, what an alias fills), once each, in its order. */
  ids: string[];
}

/** The form components each questions step lists for a Check answers step, in list order: `journeyReviewListed` over the list order. */
export function reviewListedIds(journey: Journey, pageOf: Readonly<Record<string, string>>): ReviewStepIds[] {
  const out: ReviewStepIds[] = [];
  const seen = new Set<string>();
  for (const page of journey.pages) {
    if (journeyPageKind(page) !== "questions") {
      continue;
    }
    const ids: string[] = [];
    const take = (id: unknown): void => {
      if (typeof id !== "string" || id === "" || !Object.prototype.hasOwnProperty.call(pageOf, id) || pageOf[id] !== page.id || seen.has(id)) {
        return;
      }
      seen.add(id);
      ids.push(id);
    };
    const visit = (entry: unknown): void => {
      if (typeof entry === "string") {
        take(entry);
        return;
      }
      const node = isRecord(entry) ? entry : {};
      const configuration = isRecord(node.configuration) ? node.configuration : {};
      // A reference names a form component; an alias fills one; a worked-out value is the journey's sum, not an answer.
      if (node.type === PRESENTATION_REFERENCE_TYPE) {
        take(configuration.componentId);
      } else if (node.type !== PRESENTATION_VALUE_TYPE) {
        take(configuration.fills);
      }
      for (const list of Object.values(isRecord(node.children) ? node.children : {})) {
        if (Array.isArray(list)) {
          list.forEach(visit);
        }
      }
    };
    (page.components ?? []).forEach(visit);
    out.push({ pageId: page.id, ids });
  }
  return out;
}

/** One step's part of the list: the answers the Check answers step shows for it. */
export interface ReviewListingStep {
  pageId: string;
  /** The form components holding the answers, in the order the step draws them; a repeating section or a data grid is one. */
  answers: string[];
}

export interface ReviewListing {
  steps: ReviewListingStep[];
  /** How many answers are listed in all. */
  count: number;
}

function formIndex(root: ComponentNode): Map<string, ComponentNode> {
  const byId = new Map<string, ComponentNode>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    if (!byId.has(node.id)) {
      byId.set(node.id, node);
    }
    stack.push(...Object.values(node.children ?? {}).flat());
  }
  return byId;
}

/**
 * The answers a Check answers step lists, by step (see the module comment): each listed
 * component brings the answer-holding leaves in it; a collection (a repeating section, a data
 * grid) is one answer, drawn as a card per row. Empty for a journey that cannot be written.
 */
export function journeyReviewListing(
  formRoot: ComponentNode,
  journey: Journey | undefined,
  options: { ownership?: JourneyOwnership | undefined; isValueless?: ((node: ComponentNode) => boolean) | undefined } = {}
): ReviewListing {
  if (!journey) {
    return { steps: [], count: 0 };
  }
  const pageOf = reviewPageOf(formRoot, journey, options.ownership);
  const byId = formIndex(formRoot);
  const holds = options.isValueless ? { isValueless: options.isValueless } : {};
  const steps: ReviewListingStep[] = [];
  let count = 0;
  for (const { pageId, ids } of reviewListedIds(journey, pageOf)) {
    const answers: string[] = [];
    const visit = (node: ComponentNode): void => {
      if (collectionPathOf(node) !== undefined) {
        answers.push(node.id);
        return;
      }
      const children = Object.values(node.children ?? {}).flat();
      if (children.length > 0) {
        children.forEach(visit);
      } else if (holdsData(node, holds)) {
        answers.push(node.id);
      }
    };
    for (const id of ids) {
      const node = byId.get(id);
      if (node) {
        visit(node);
      }
    }
    if (answers.length > 0) {
      steps.push({ pageId, answers });
      count += answers.length;
    }
  }
  return { steps, count };
}

/**
 * The answer a field shows on the canvas while the step is edited, as a literal a calculation
 * writes: the word for text, a tick for a checkbox, the first option of a choice, a date and a
 * number that read as such. `undefined` for a type whose answer cannot be a literal (a
 * checkbox group, a file, a signature): its row reads as one with no answer given.
 */
function placeholderOf(node: ComponentNode, word: string): string | number | boolean | undefined {
  switch (node.type) {
    case "checkbox":
      return true;
    case "number":
      return PLACEHOLDER_NUMBER;
    case "date":
      return PLACEHOLDER_DATE;
    case "checkboxes":
    case "file":
    case "signature":
    case "pdf-signature":
      return undefined;
    case "select":
    case "radio": {
      const first = readInlineOptions(node.configuration)[0];
      return first !== undefined ? first.value : word;
    }
    default:
      return word;
  }
}

/**
 * The form as the step's canvas carries it under {@link REVIEW_ANSWERS_SLOT}: every top-level
 * component copied with its subtree, rules stripped (the value paths of the form's own are what
 * the rows read), and each answer a listed component holds given a placeholder through a
 * calculation, so the real review drawing names the row and fills it. A component whose id is in
 * `taken` (the step's own nodes drew it) is left out with what it holds, so no id is drawn twice.
 * An answer inside a collection gets none: the rows of a repeating section are the answers' own.
 */
export function reviewAnswersForm(formRoot: ComponentNode, listed: ReadonlySet<string>, taken: ReadonlySet<string>, word: string): ComponentNode[] {
  const copy = (node: ComponentNode, under: boolean, inCollection: boolean): ComponentNode | undefined => {
    if (taken.has(node.id)) {
      return undefined;
    }
    const { rules: _rules, children, ...rest } = node;
    const out: ComponentNode = { ...rest, configuration: structuredClone(node.configuration ?? {}) } as ComponentNode;
    const below = under || listed.has(node.id);
    const collection = inCollection || collectionPathOf(node) !== undefined;
    if (children) {
      out.children = Object.fromEntries(
        Object.entries(children).map(([slot, held]) => [slot, held.flatMap((child) => copy(child, below, collection) ?? [])])
      );
    } else if (below && !collection && holdsData(node)) {
      const placeholder = placeholderOf(node, word);
      if (placeholder !== undefined) {
        out.rules = { value: { kind: "literal", value: placeholder } };
      }
    }
    return out;
  };
  return Object.values(formRoot.children ?? {})
    .flat()
    .flatMap((child) => copy(child, false, false) ?? []);
}

/**
 * The form component a drawn row of the Check answers step stands for: `key` is the row's value
 * path as the drawing ids it (`income`, `home.street`, `kids[1].kidName`). A field inside a
 * repeating section is stored as `kids[1].kidName` and its path in the form is its own key, so
 * an entry's index is dropped and the last segment compared. `undefined` for a card, which is a
 * row of a collection and has no wording of its own.
 */
export function reviewRowComponent(formRoot: ComponentNode, key: string): string | undefined {
  const resolve = createValuePathResolver(formRoot);
  const ids = [...formIndex(formRoot).values()].filter((node) => node.id !== formRoot.id && holdsData(node)).map((node) => node.id);
  const exact = ids.find((id) => resolve(id) === key);
  if (exact !== undefined) {
    return exact;
  }
  if (!/\[\d+\]\./.test(key)) {
    return undefined;
  }
  const leaf = key.slice(key.lastIndexOf(".") + 1);
  return ids.find((id) => resolve(id) === leaf);
}

/** The DOM id prefix the drawn rows of the Check answers step `pageId` carry (`render/live/journey-review.ts`, `reviewItemId`). */
export function reviewRowIdPrefix(pageId: string): string {
  return `${pageId}__review-`;
}
