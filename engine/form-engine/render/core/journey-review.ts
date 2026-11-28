import type { JourneyView } from "../../core/journey/journey-types.js";
import type { FormTextResolver } from "../../core/localization/form-texts.js";
import { addressOf, resolveText, type TextSources } from "../../core/localization/translations.js";
import { journeyPageKind, journeyReviewSettings, PRESENTATION_REFERENCE_TYPE, PRESENTATION_VALUE_TYPE } from "../../core/schema/journey.js";
import { baseTypeOf } from "../../registry/kinds.js";
import { ANSWER_MASK, answerTextOf, MASKED_ANSWER_TYPES } from "../print/field-answer.js";
import type { RenderComponentModel } from "./component-model.js";
import { rowHeadingOf } from "./error-wording.js";

/**
 * A journey's Check answers page (`kind: "review"`, after the GOV.UK check answers pattern) as
 * data: what the page lists, worded, before any binding draws it. Pure: read off the runtime's
 * {@link JourneyView} and the render output's component models, so the live form, a test and an
 * agent read the same list.
 *
 * - A section per step on the person's path, in path order, headed by the step's title (else its
 *   first answer's label); a Check answers or exit page has none, and a section with nothing to
 *   list is left out.
 * - A row per answer the step asks, in the order it draws them: a field the step lists, the form
 *   field a reference names or an alias fills, each field inside a container it lists. A field is
 *   listed once, under the earliest step on the path that asks it (`view.pageOf`). A field a rule
 *   hides (with everything inside it), a field off the path and a journey's own field (one the form
 *   does not hold) are never listed; nor is anything with no answer to show (a button, a picture,
 *   static content).
 * - A row's wording is the page's `review.labels` entry for it (worded for the locale), else the
 *   field's label; an answer asked through an alias is worded, required and in error as the alias
 *   (the question the person was asked). Its value is the answer as print words it
 *   ({@link answerTextOf}); a password's is a mask ({@link REVIEW_MASK}). A required
 *   answer not given is `missing`: no value, and an `enter` link ("Enter {{label}}") to its step. An
 *   optional one is `notProvided` ("Not provided"), or not listed when `review.emptyOptional` says
 *   `"omit"` (unless it is in error). Its blocking errors, worded, are `errors`.
 * - A Change link (`change`) on every row with an answer or none given, unless `review.change` is
 *   `false`: visible `text` ("Change"), and `hidden`, the rest of its name (" Landlord's name"),
 *   for a visually hidden span.
 * - A data grid (or another collection-bound container) is a card per row, titled by its row
 *   heading (`rowHeadingOf`), its fields as rows and its one Change on the card. A grid with no
 *   rows is one row of its own (`missing` when it is required).
 */

/** Whether a row holds an answer, lacks a required one, or lacks an optional one. */
export type ReviewRowStatus = "answered" | "missing" | "notProvided";

/** A link that opens a step of the journey with direction `"change"`. */
export interface ReviewAction {
  /** The step it opens. */
  pageId: string;
  /** What the link shows ("Change", "Enter landlord's name"). */
  text: string;
  /** The rest of its name, visually hidden after `text` (" Landlord's name"); empty when `text` is the whole name. */
  hidden: string;
  /** Its whole accessible name ("Change Landlord's name"). */
  name: string;
  /**
   * The wording does not start with `text` (a language that puts the label first): draw `text`
   * hidden from assistive technology and `hidden`, here the whole name, visually hidden.
   */
  reordered: boolean;
}

export interface ReviewRow {
  kind: "row";
  /** Unique within the list: the answer's value path (`people[1].name` inside a grid's row). */
  key: string;
  componentId: string;
  valuePath: string;
  /** The step the answer is given on: where its links go. */
  pageId: string;
  /** The row's wording: the page's `review.labels` entry, else the field's label. */
  label: string;
  /** The answer as text, lines split by `\n`; `notProvided`'s words for a blank optional answer; empty when missing. */
  value: string;
  status: ReviewRowStatus;
  /** Its blocking errors, worded. */
  errors: string[];
  change?: ReviewAction;
  /** On a `missing` row: the link that goes to the question ("Enter landlord's name"). */
  enter?: ReviewAction;
}

/** One row of a data grid: a card of its fields, titled by its row heading. */
export interface ReviewCard {
  kind: "card";
  /** Unique within the list: the row's entry path (`people[1]`). */
  key: string;
  /** The grid. */
  componentId: string;
  /** The row's position, 0-based. */
  index: number;
  pageId: string;
  title: string;
  /** Its fields, with no Change of their own. */
  rows: ReviewRow[];
  /** The grid's own blocking errors (its row count), on its first card. */
  errors: string[];
  change?: ReviewAction;
}

export type ReviewItem = ReviewRow | ReviewCard;

export interface ReviewSection {
  /** The step the section lists. */
  pageId: string;
  /** Its heading: the step's title, else its first answer's label. */
  title: string;
  items: ReviewItem[];
}

export interface ReviewModel {
  journeyId: string;
  /** The Check answers page. */
  pageId: string;
  sections: ReviewSection[];
}

export interface ReviewModelInput {
  view: JourneyView;
  /** The render output's models: every component of the form (the combined root's). */
  components: readonly RenderComponentModel[];
  kinds?: Readonly<Record<string, string>> | undefined;
  locale: string;
  sources: TextSources;
  /** The words the page is drawn in (the fold's resolver, the journey's texts over the host's). */
  text: FormTextResolver;
}

/** A configuration as a record (never `null`, never an array). */
function settingsOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The form components each step on the path lists for a Check answers page, in path order and
 * each step's own order: a listed id, the component a reference names, the form field an alias
 * fills. A component under the earliest step holding it, once; a Check answers or exit step lists
 * none. Their subtrees are not walked here: what they hold is in the same section, less a field
 * an earlier step asks on its own (that step's answer, listed there).
 */
export function journeyReviewListed(view: Pick<JourneyView, "path" | "journey" | "pageOf">): Array<{ pageId: string; ids: string[]; askedBy: Record<string, string> }> {
  const out: Array<{ pageId: string; ids: string[]; askedBy: Record<string, string> }> = [];
  const seen = new Set<string>();
  for (const pageId of view.path) {
    const page = view.journey.pages.find((candidate) => candidate.id === pageId);
    if (!page || journeyPageKind(page) !== "questions") {
      continue;
    }
    const ids: string[] = [];
    // Form field id -> the alias that asks it on this step: the row is worded, required and in
    // error as the question the person was asked, not as the form field it fills.
    const askedBy = Object.create(null) as Record<string, string>;
    const take = (id: unknown, alias?: string): void => {
      if (typeof id !== "string" || id === "" || !Object.prototype.hasOwnProperty.call(view.pageOf, id) || view.pageOf[id] !== pageId) {
        return;
      }
      if (seen.has(id)) {
        // The step asks the field itself as well as through an alias: the field's own question.
        if (alias === undefined) {
          delete askedBy[id];
        }
        return;
      }
      seen.add(id);
      ids.push(id);
      if (alias !== undefined) {
        askedBy[id] = alias;
      }
    };
    const visit = (entry: unknown): void => {
      if (typeof entry === "string") {
        take(entry);
        return;
      }
      const node = settingsOf(entry);
      const configuration = settingsOf(node.configuration);
      // A reference names a form component; an alias fills one. A worked-out value is the
      // journey's sum, not the person's answer, and an own field is the journey's alone.
      if (node.type === PRESENTATION_REFERENCE_TYPE) {
        take(configuration.componentId);
      } else if (node.type !== PRESENTATION_VALUE_TYPE) {
        take(configuration.fills, typeof node.id === "string" && node.id !== "" && node.children === undefined ? node.id : undefined);
      }
      for (const list of Object.values(settingsOf(node.children))) {
        if (Array.isArray(list)) {
          list.forEach(visit);
        }
      }
    };
    (page.components ?? []).forEach(visit);
    out.push({ pageId, ids, askedBy });
  }
  return out;
}

/**
 * The component ids a Check answers page lists, in its order: the errors on them are the page's
 * (they are drawn in its rows). An answer asked through an alias brings the alias too: its own
 * Required names the alias.
 */
export function journeyReviewComponentIds(view: Pick<JourneyView, "path" | "journey" | "pageOf">): string[] {
  return journeyReviewListed(view).flatMap((entry) => entry.ids.flatMap((id) => (entry.askedBy[id] !== undefined ? [id, entry.askedBy[id] as string] : [id])));
}

/** The base types whose answer is never shown back: a password reads as a mask (print reads the same set). */
const MASKED_TYPES: ReadonlySet<string> = MASKED_ANSWER_TYPES;

/** What a given masked answer shows in its place. */
export const REVIEW_MASK = ANSWER_MASK;

/** A link's name split where the binding draws it: `text` visible, the rest visually hidden. */
export function reviewAction(pageId: string, text: string, name: string): ReviewAction {
  if (name === text) {
    return { pageId, text, hidden: "", name, reordered: false };
  }
  return name.startsWith(text) ? { pageId, text, hidden: name.slice(text.length), name, reordered: false } : { pageId, text, hidden: name, name, reordered: true };
}

/** The Check answers page's list for the page `input.view` shows; `undefined` unless it is a review page. */
export function buildReviewModel(input: ReviewModelInput): ReviewModel | undefined {
  const { view, locale, sources, text, kinds } = input;
  if (view.kind !== "review") {
    return undefined;
  }
  const settings = journeyReviewSettings(view.page);
  const byId = new Map(input.components.map((model) => [model.id, model]));
  const childrenOf = (models: readonly RenderComponentModel[]): Map<string, RenderComponentModel[]> => {
    const out = new Map<string, RenderComponentModel[]>();
    for (const model of models) {
      if (model.parentId !== undefined) {
        const list = out.get(model.parentId);
        if (list) {
          list.push(model);
        } else {
          out.set(model.parentId, [model]);
        }
      }
    }
    return out;
  };
  const formChildren = childrenOf(input.components);

  // The row's wording: the page's own, worded at `journeys › <id> › pages › <page> › review › labels › <component>`.
  const labelOf = (model: RenderComponentModel): string => {
    const own = Object.prototype.hasOwnProperty.call(settings.labels, model.id) ? settings.labels[model.id] : undefined;
    if (own !== undefined && own.trim() !== "") {
      const worded = resolveText(own, { kind: "journeys", owner: view.journeyId, path: ["pages", view.pageId, "review", "labels", model.id] }, locale, sources);
      if (worded !== undefined && worded.trim() !== "") {
        return worded;
      }
    }
    return model.label;
  };
  const change = (pageId: string, label: string): ReviewAction | undefined =>
    settings.change ? reviewAction(pageId, text("change"), text("changeHidden", { label })) : undefined;
  const blocking = (model: RenderComponentModel): string[] => (model.blockingErrors.length > 0 ? (model.errorMessages ?? []).filter((message) => message !== "") : []);

  /**
   * One answer's row; `undefined` for one with nothing to list. `asked` is the alias the step asks
   * it through: the row is the alias's (its label, its Required, its errors with the field's).
   */
  const rowOf = (model: RenderComponentModel, pageId: string, inCard: boolean, asked?: RenderComponentModel): ReviewRow | undefined => {
    const base = baseTypeOf(model.type, kinds);
    if (base === "html") {
      return undefined;
    }
    const answer = answerTextOf(model, base, locale);
    if (!answer) {
      return undefined;
    }
    const question = asked ?? model;
    const label = labelOf(question);
    const errors = asked !== undefined ? [...new Set([...blocking(asked), ...blocking(model)])] : blocking(model);
    const required = question.accessibility.required || model.accessibility.required;
    const status: ReviewRowStatus = !answer.empty ? "answered" : required ? "missing" : "notProvided";
    if (status === "notProvided" && settings.emptyOptional === "omit" && errors.length === 0) {
      return undefined;
    }
    // A password is never shown back, on a screen anyone at the device can read.
    const masked = MASKED_TYPES.has(base) || MASKED_TYPES.has(model.type);
    const row: ReviewRow = {
      kind: "row",
      key: model.valuePath,
      componentId: question.id,
      valuePath: model.valuePath,
      pageId,
      label,
      value: status === "answered" ? (masked ? REVIEW_MASK : answer.text) : status === "notProvided" ? text("notProvided") : "",
      status,
      errors
    };
    if (status === "missing") {
      // The way to the question is the link in the answer's place, Change or not.
      row.enter = reviewAction(pageId, text("enterAnswer", { label }), text("enterAnswer", { label }));
    } else if (!inCard) {
      const action = change(pageId, label);
      if (action) {
        row.change = action;
      }
    }
    return row;
  };

  /** A collection with no rows, as a row of its own (`missing` when it is required); `undefined` when omitted. */
  const emptyCollectionRow = (model: RenderComponentModel, pageId: string): ReviewRow | undefined => {
    const own = blocking(model);
    const required = model.accessibility.required;
    if (!required && settings.emptyOptional === "omit" && own.length === 0) {
      return undefined;
    }
    const label = labelOf(model);
    const row: ReviewRow = {
      kind: "row",
      key: model.valuePath,
      componentId: model.id,
      valuePath: model.valuePath,
      pageId,
      label,
      value: required ? "" : text("notProvided"),
      status: required ? "missing" : "notProvided",
      errors: own
    };
    if (required) {
      row.enter = reviewAction(pageId, text("enterAnswer", { label }), text("enterAnswer", { label }));
    } else {
      const action = change(pageId, label);
      if (action) {
        row.change = action;
      }
    }
    return row;
  };

  /**
   * The rows of one collection row (`entry`, of the collection `owner`), in a card: its fields,
   * through any container in it. A collection inside a row is one of those containers: the
   * renderer draws it as a plain group of the row, its binding ignored
   * (`component-model.ts` `buildRows`), so its fields are listed as the row's.
   */
  const entryRows = (owner: RenderComponentModel, entry: readonly RenderComponentModel[], pageId: string, rows: ReviewRow[]): void => {
    const inside = childrenOf(entry);
    const walkRow = (row: RenderComponentModel): void => {
      if (!row.visible) {
        return;
      }
      if (row.node.children !== undefined) {
        (inside.get(row.id) ?? []).forEach(walkRow);
        return;
      }
      const drawn = rowOf(row, pageId, true);
      if (drawn) {
        rows.push(drawn);
      }
    };
    (inside.get(owner.id) ?? []).forEach(walkRow);
  };

  /** A grid's cards, one per row; a grid with none is a row of its own. */
  const gridItems = (model: RenderComponentModel, pageId: string, out: ReviewItem[]): void => {
    const entries = model.rows?.entries ?? [];
    const own = blocking(model);
    if (entries.length === 0) {
      const row = emptyCollectionRow(model, pageId);
      if (row) {
        out.push(row);
      }
      return;
    }
    entries.forEach((entry, index) => {
      const title = rowHeadingOf(model.node, index + 1, locale, sources, text);
      const rows: ReviewRow[] = [];
      entryRows(model, entry, pageId, rows);
      const card: ReviewCard = {
        kind: "card",
        key: `${model.rows?.collectionPath ?? model.valuePath}[${index}]`,
        componentId: model.id,
        index,
        pageId,
        title,
        rows,
        errors: index === 0 ? own : []
      };
      const action = change(pageId, title);
      if (action) {
        card.change = action;
      }
      out.push(card);
    });
  };

  /** A listed component: its row, its grid's cards, or what a container holds, in the tree's order. */
  const walk = (model: RenderComponentModel, pageId: string, out: ReviewItem[], asked?: RenderComponentModel): void => {
    if (!model.visible) {
      return;
    }
    if (model.rows !== undefined) {
      gridItems(model, pageId, out);
      return;
    }
    if (model.node.children !== undefined) {
      // A field belongs to the earliest step on the path that asks it: one an earlier step lists
      // on its own is that step's answer, not this container's.
      (formChildren.get(model.id) ?? [])
        .filter((child) => !Object.prototype.hasOwnProperty.call(view.pageOf, child.id) || view.pageOf[child.id] === pageId)
        .forEach((child) => walk(child, pageId, out));
      return;
    }
    const row = rowOf(model, pageId, false, asked);
    if (row) {
      out.push(row);
    }
  };

  const sections: ReviewSection[] = [];
  for (const { pageId, ids, askedBy } of journeyReviewListed(view)) {
    const items: ReviewItem[] = [];
    for (const id of ids) {
      const model = byId.get(id);
      const aliasId = askedBy[id];
      const asked = aliasId !== undefined ? byId.get(aliasId) : undefined;
      // An alias its own rule hides was not asked: nor is the field it fills, on this step.
      if (model && model.parentId !== undefined && (asked === undefined || asked.visible)) {
        walk(model, pageId, items, asked);
      }
    }
    if (items.length === 0) {
      continue;
    }
    const page = view.journey.pages.find((candidate) => candidate.id === pageId);
    const authored = typeof page?.title === "string" ? resolveText(page.title, addressOf.journeyPage(view.journeyId, pageId, "title"), locale, sources) : undefined;
    const first = items[0] as ReviewItem;
    const title = authored !== undefined && authored.trim() !== "" ? authored : first.kind === "row" ? first.label : (byId.get(first.componentId)?.label ?? "");
    sections.push({ pageId, title, items });
  }
  return { journeyId: view.journeyId, pageId: view.pageId, sections };
}
