/**
 * The Journeys designer's node types as `ComponentDefinition`s, so a journey is
 * edited by an ordinary `BuilderController`: slot constraints, the composed inspector, drafts,
 * undo and drag all apply unchanged. The tree they make is `journey-tree.ts`'s; what each type
 * edits is the part of a `Journey` its node stands for. A step is drawn on the canvas as the
 * person sees it (the Step view, `step-view.ts`), never from these definitions: they carry what
 * the outline and the inspector need.
 *
 * Besides the definitions, the hooks the mode gives each journey's controller: what the outline
 * calls a node, the ID row (the journey id on the root, none below), the pickers' choices (the
 * form's components for a question, every page for a route), the one problem that holds a
 * Save back — a page id the draft changes to one already taken — and the advisory
 * rest: the findings as notes under the boxes they are about, the Wording sections folded, the
 * page id box showing the id a blank one is written under. A hook reads the form and the journey
 * through a live context, never through the definitions, so a form edit changes what they say
 * without rebuilding the controller — which would take the journey's undo history with it.
 *
 * In the designer's lazy chunk; nothing here runs at import.
 */
import type { ComponentDefinition, PropertyEditorField } from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { addressOf, resolveText, type TextAddress, type TextSources } from "../../core/localization/translations.js";
import { JOURNEY_END, PRESENTATION_VALUE_TYPE } from "../../core/schema/journey.js";
import { collectionPathOf, holdsData } from "../../core/tree/data-scope.js";
import type { BuilderComponentType, BuilderIdRow, BuilderNote, BuilderProblem } from "../controller/builder-controller.js";
import type { InspectorChoice } from "../property-editor/inspector-model.js";
import { conditionInWords as conditionInWordsShared, conditionTerms, type ConditionTerms } from "../property-editor/condition-words.js";
import { JOURNEY_TEXT_FIELDS, journeyTextAddress } from "./journey-catalog.js";
import { BUILDER_TEXTS_EN, type BuilderTextCatalog, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import { JOURNEY_EN, builderPlural, builderText } from "./journey-texts-en.js";
import { writtenPageId, type JourneyCheck, type JourneyPageEntry, type JourneyTreeIndex } from "./journey-checks.js";
import {
  JOURNEY_CONTENT_SLOT,
  JOURNEY_FIELD_TYPE,
  JOURNEY_PAGE_TYPE,
  JOURNEY_PAGES_SLOT,
  JOURNEY_PALETTE_GROUP,
  JOURNEY_ROOT_TYPE,
  JOURNEY_ROUTE_TYPE,
  JOURNEY_ROUTES_SLOT
} from "./journey-mode-model.js";
import { journeyTreeOwnIds } from "./journey-references.js";
import { journeyReviewListing } from "./step-review.js";
import { emptyJourneyTree, journeyNodeTemplate } from "./journey-tree.js";

export { JOURNEY_PALETTE_GROUP };

/** One of the form's components, as the designer's faces and pickers name it. */
export interface JourneyFormComponent {
  id: string;
  /** Its label in the builder's locale; its id when it has none. */
  label: string;
  type: string;
  /** Holds other components (a panel, tabs, a repeating section). */
  container: boolean;
  /** For a container: the answer-holding components inside it, at any depth. */
  questions: number;
  /** Holds an answer of its own outside every repeating section: what a condition may read. */
  readable: boolean;
  /** The component holding it; absent at the top of the form. */
  parentId?: string | undefined;
}

/** The form a journey is built over, indexed once per form edit. */
export interface JourneyFormIndex {
  rootId: string;
  /** Every component but the root, by id. */
  components: ReadonlyMap<string, JourneyFormComponent>;
  /** The same, in document order. */
  order: readonly JourneyFormComponent[];
}

/** What the canvas and the pickers read about the journey on the page, as its tree stands (drafts laid over). */
export interface JourneyDesignView {
  tree: ComponentNode;
  index: JourneyTreeIndex;
  check: JourneyCheck;
  /** The form components the journey asks on no page (`unassignedMembers`): the tray, and "Add unassigned". */
  unassigned: readonly string[];
}

/** The live context the hooks and pickers read; see the module comment. */
export interface JourneyFacesContext {
  locale(): string;
  /**
   * What resolves a text in the builder's locale: the definition's translations and the host's
   * catalog, read live.
   */
  sources(): TextSources;
  /** The builder's own catalog per locale (`BuilderTextCatalog`); absent: English. */
  textCatalog?(): BuilderTextCatalog | undefined;
  form(): JourneyFormIndex;
  /** The form's tree, for what a Check answers step lists (`step-review.ts`). Absent: the step's list says nothing. */
  formRoot?(): ComponentNode;
  /** Which leaves carry no answer beyond the engine's own, for what a Check answers step lists. */
  isValueless?(node: ComponentNode): boolean;
  view(): JourneyDesignView;
  /** The catalog entry's id: the tree carries none. */
  journeyId(): string;
  /** Page node id -> the page id it was last written under, for a route whose page was deleted. */
  pageIds(): ReadonlyMap<string, string>;
  /*
   * Lent by the page-only fields' chunk, once it is in: what the outline and the ID
   * row say of a node of the journey's own.
   */
  ownLabel?(node: ComponentNode): string | undefined;
  ownIdRow?(node: ComponentNode): BuilderIdRow | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationOf(node: ComponentNode): Record<string, unknown> {
  return isRecord(node.configuration) ? node.configuration : {};
}

/**
 * A text in the builder's locale: the string given, or its translation at `address`;
 * `undefined` when it is not a string or is blank. No address: the default string as it is.
 */
function words(value: unknown, locale: string, sources: TextSources | undefined, address: TextAddress | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = address !== undefined ? resolveText(value, address, locale, sources ?? {}) : value;
  return text.trim() !== "" ? text : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The builder's words for a face or a picker: its locale and its catalog, read live. */
function wordsOf(context: { locale(): string; textCatalog?(): BuilderTextCatalog | undefined }): BuilderTextOptions {
  return { locale: context.locale(), catalog: context.textCatalog?.() };
}


// --- the form ------------------------------------------------------------------------------

/** Indexes the form a journey is built over: every component's label, type and what it holds. */
export function indexJourneyForm(root: ComponentNode, locale: string, sources?: TextSources): JourneyFormIndex {
  const components = new Map<string, JourneyFormComponent>();
  const order: JourneyFormComponent[] = [];
  const children = (node: ComponentNode): ComponentNode[] => Object.values(node.children ?? {}).flat();
  // The leaves that hold an answer: a group counts what is in it, not itself.
  const countQuestions = (node: ComponentNode): number =>
    children(node).reduce((sum, child) => sum + (children(child).length === 0 ? (holdsData(child) ? 1 : 0) : countQuestions(child)), 0);
  const visit = (node: ComponentNode, inEntries: boolean, parentId: string | undefined): void => {
    const container = children(node).length > 0;
    const component: JourneyFormComponent = {
      id: node.id,
      label: words(configurationOf(node).label, locale, sources, addressOf.component(node.id, "label")) ?? node.id,
      type: node.type,
      container,
      questions: container ? countQuestions(node) : 0,
      readable: !inEntries && holdsData(node) && collectionPathOf(node) === undefined,
      ...(parentId !== undefined ? { parentId } : {})
    };
    components.set(node.id, component);
    order.push(component);
    const entries = inEntries || collectionPathOf(node) !== undefined;
    for (const child of children(node)) {
      visit(child, entries, node.id);
    }
  };
  for (const child of children(root)) {
    visit(child, false, undefined);
  }
  return { rootId: root.id, components, order };
}

// --- words ---------------------------------------------------------------------------------

/**
 * A condition in words, the way the Rules tab reads it ("Contact method equals “mail”", else the
 * printed formula with labels), each field named by its label (`condition-words.ts`, shared
 * with the PDF layouts); `undefined` for a condition the engine cannot evaluate, which the
 * canvas calls a condition that never holds.
 */
export function conditionInWords(condition: unknown, form: JourneyFormIndex): string | undefined {
  return conditionInWordsShared(condition, (path) => form.components.get(path)?.label);
}

/**
 * The same words as {@link conditionInWords}, as terms: each field's label (its `subject`) and
 * its test ('equals “mail”'), joined by `join`; a formula the sentence cannot word is one term.
 * The flow map shortens a subject to fit a chip, never a test, so a chip always says
 * which answer takes the way.
 */
export function conditionTermsInWords(condition: unknown, form: JourneyFormIndex): ConditionTerms | undefined {
  return conditionTerms(condition, (path) => form.components.get(path)?.label);
}

/**
 * The label a page with no title borrows (as the runtime heads it and `page.no-title`
 * reads it): its first member's — a form component's, a node of the journey's own by its own
 * label, a worked-out value with no label at all by the form field it works out. An alias with
 * no label lends nothing, nor does a worked-out value labelled blank. `undefined` when nothing
 * on the page names one.
 */
function borrowedLabel(page: ComponentNode, form: JourneyFormIndex, locale: string, sources?: TextSources): string | undefined {
  // The first member that is not a question still to be chosen and that asks something: a
  // button (Submit, Download, Reset) or a leaf holding no answer lends no title, since a page is
  // named for what it asks, and a Submit that rides first must not head the page.
  const first = (page.children?.[JOURNEY_CONTENT_SLOT] ?? []).find((member) => {
    if (member.type !== JOURNEY_FIELD_TYPE) {
      return true;
    }
    const id = stringOf(configurationOf(member).componentId);
    if (id === "") {
      return false;
    }
    const component = form.components.get(id);
    return component === undefined || (component.type !== "button" && (component.container || component.readable));
  });
  if (first === undefined) {
    return undefined;
  }
  const configuration = configurationOf(first);
  const target =
    first.type === JOURNEY_FIELD_TYPE ? configuration.componentId : first.type === PRESENTATION_VALUE_TYPE && configuration.label === undefined ? configuration.to : undefined;
  return target !== undefined ? form.components.get(stringOf(target))?.label : words(configuration.label, locale, sources, addressOf.component(first.id, "label"));
}

/** What a page is called beside its number: its title, else its first member's label, else its id. */
export function pageName(page: JourneyPageEntry, form: JourneyFormIndex, locale: string, sources?: TextSources, journeyId?: string): string {
  return pageTitle(page, locale, sources, journeyId) ?? borrowedLabel(page.node, form, locale, sources) ?? page.pageId;
}

/** A page's own title in `locale` (its translation at `journeys › <journey id> › pages › <page id> › title`); none when blank. */
function pageTitle(page: JourneyPageEntry, locale: string, sources: TextSources | undefined, journeyId: string | undefined): string | undefined {
  return words(configurationOf(page.node).title, locale, sources, journeyId !== undefined ? addressOf.journeyPage(journeyId, page.pageId, "title") : undefined);
}

/** "Page 3 · Details". */
function pageReference(page: JourneyPageEntry, form: JourneyFormIndex, locale: string, sources?: TextSources, text?: BuilderTextOptions, journeyId?: string): string {
  return builderText("journey.designer.page.ref", { number: page.number, name: pageName(page, form, locale, sources, journeyId) }, text);
}

/**
 * The page a route with no page node of its own is written to, when a page is written under the
 * id it names — the file's unknown target, a deleted page's id or one typed, once a page takes it
 * (`journey-tree.ts`): read from the journey as written, so the card and the picker say where
 * the route goes, as the findings do, rather than calling the page missing.
 */
function pageByWrittenTarget(route: ComponentNode, view: JourneyDesignView): JourneyPageEntry | undefined {
  const written = view.check.journey;
  const placed = view.check.placement.pages;
  if (!written) {
    return undefined;
  }
  for (let index = 0; index < placed.length; index += 1) {
    const at = placed[index]?.routes.indexOf(route.id) ?? -1;
    if (at < 0) {
      continue;
    }
    const to = written.pages[index]?.routes?.[at]?.to;
    const page = to !== undefined && to !== JOURNEY_END ? placed.find((entry) => entry.pageId === to) : undefined;
    return page ? view.index.pageOf.get(page.nodeId) : undefined;
  }
  return undefined;
}

/** Where a route goes, in words, and what kind of target that is. */
function routeTarget(
  route: ComponentNode,
  context: JourneyFacesContext
): { text: string; kind: "page" | "end" | "missing" | "none" | "ignored" } {
  const configuration = configurationOf(route);
  const to = stringOf(configuration.to);
  const view = context.view();
  if (to === JOURNEY_END) {
    return { text: builderText("journey.designer.route.end", undefined, wordsOf(context)), kind: "end" };
  }
  const target = (to !== "" ? view.index.pages.find((page) => page.nodeId === to) : undefined) ?? pageByWrittenTarget(route, view);
  if (target) {
    const own = view.index.pageOf.get(route.id);
    const reference = pageReference(target, context.form(), context.locale(), context.sources(), wordsOf(context), context.journeyId());
    if (own && target.number <= own.number) {
      const detail = builderText(target.number === own.number ? "journey.designer.route.thisPage" : "journey.designer.route.earlierPage", undefined, wordsOf(context));
      return { text: builderText("journey.designer.route.ignored", { reference, detail }, wordsOf(context)), kind: "ignored" };
    }
    return { text: reference, kind: "page" };
  }
  const missing = to !== "" ? (context.pageIds().get(to) ?? to) : stringOf(configuration.missingTo);
  if (missing !== "") {
    return { text: builderText("journey.designer.route.missing", { page: missing }, wordsOf(context)), kind: "missing" };
  }
  return { text: builderText("journey.designer.route.none", undefined, wordsOf(context)), kind: "none" };
}

// --- the add popover's words ----------------------------------------------------------------

/**
 * The server's stake in every journey, said where one is made and where it is
 * shown: the server holds every answer to the form's rules,
 * asked or not, so a required field left out blocks every submission — unless its default
 * answers it (a non-empty literal the browser submits unchanged), or its visibility or its
 * Required-when rule is the host's to decide (a `host.` rule the server cannot replay: neither
 * side holds the field to it while it is left out). The findings say which is which.
 */
export const JOURNEY_STAKES_TEXT = builderText("journey.designer.stakes");

// --- definitions ---------------------------------------------------------------------------

function localized(id: string, propertyPath: string, label: string, description?: string): PropertyEditorField {
  return { id, type: "localized-text", propertyPath, label, ...(description !== undefined ? { description } : {}) };
}

/** A text box of the journey's or a page's editor, from the texts a host's catalog lists too (`JOURNEY_TEXT_FIELDS`). */
function textField(owner: keyof typeof JOURNEY_TEXT_FIELDS, id: string, text: BuilderTextOptions): PropertyEditorField {
  const field = JOURNEY_TEXT_FIELDS[owner].find((entry) => entry.id === id);
  if (!field) {
    throw new Error(`No journey text "${id}" on the ${owner}`);
  }
  return localized(field.id, field.propertyPath, choiceText(field.label, text), field.description === undefined ? undefined : choiceText(field.description, text));
}

/** A select whose choices come from {@link journeyFieldChoices}, so a value written out in full ("questions") shows as itself. */
function select(id: string, propertyPath: string, label: string, description?: string): PropertyEditorField {
  return { id, type: "select", propertyPath, label, ...(description !== undefined ? { description } : {}) };
}

interface SelectChoices {
  choices: readonly InspectorChoice[];
  /** A value that means what a blank choice means, shown as its own entry only when a file writes it out. */
  stated?: Readonly<Record<string, string>>;
}

const FOLLOW_JOURNEY = "journey.designer.ui.as-the-journey-says";

/**
 * The property path of the read-only list a Check answers step's inspector draws ("Answers
 * listed"): no configuration key, only the box's address. Its choices are the list, one group per
 * step; a choice with no value is a line of its own (the count, or what an empty list says).
 */
export const REVIEW_LISTED_PROPERTY = "review.listed";

/** The prefix of the box that words one row of a Check answers step (`review.labels.<component id>`). */
export const REVIEW_LABELS_PROPERTY = "review.labels";

/** The Wording box of one row of a Check answers step: its text is `review.labels.<id>`, blank restoring the field's own label. */
export function reviewRowField(componentId: string, label: string, text: BuilderTextOptions): PropertyEditorField {
  return {
    id: `review-label-${componentId}`,
    type: "localized-text",
    propertyPath: `${REVIEW_LABELS_PROPERTY}.${componentId}`,
    label: builderText("journey.designer.review.rowWording", { field: label }, text),
    description: builderText("journey.designer.review.rowWording.description", undefined, text)
  };
}

/** The fixed selects' choices, by field id (the dynamic ones, a question's component and a route's page, are built per node). */
const SELECT_CHOICES: Readonly<Record<string, SelectChoices>> = {
  // The counter is the engine's default: no setting counts the steps, and None turns it off.
  "journey-progress": {
    choices: [
      { value: "", label: "journey.designer.ui.count-the-pages-page-2-of-5" },
      { value: "none", label: "journey.designer.ui.none" }
    ],
    stated: { count: "journey.designer.ui.count-written-out" }
  },
  "journey-heading": {
    choices: [
      { value: "", label: "journey.designer.ui.shown" },
      { value: "hidden", label: "journey.designer.ui.hidden-the-form-s-title-heads-each-page" }
    ],
    stated: { shown: "journey.designer.ui.shown-written-out" }
  },
  "journey-off-path": {
    choices: [
      { value: "", label: "journey.designer.ui.kept-for-the-person-not-submitted" },
      { value: "retain", label: "journey.designer.ui.kept-and-submitted" },
      { value: "clear", label: "journey.designer.ui.cleared" }
    ],
    stated: { "exclude-from-submission": "journey.designer.ui.kept-for-the-person-not-submitted-written-out" }
  },
  "journey-continue": {
    choices: [
      { value: "", label: "journey.designer.ui.move-on-check-at-the-end" },
      { value: "page", label: "journey.designer.ui.check-each-page-on-continue" }
    ],
    stated: { defer: "journey.designer.ui.move-on-check-at-the-end-written-out" }
  },
  "journey-server": {
    choices: [
      { value: "", label: "journey.designer.ui.no" },
      { value: "true", label: "journey.designer.ui.yes-after-the-page-s-own-checks" }
    ],
    stated: { false: "journey.designer.ui.no-written-out" }
  },
  "journey-unavailable": {
    choices: [
      { value: "", label: "journey.designer.ui.stay-on-the-page-asking-to-try-again" },
      { value: "continue", label: "journey.designer.ui.go-on-without-the-server" }
    ],
    stated: { block: "journey.designer.ui.stay-on-the-page-written-out" }
  },
  "journey-end": {
    choices: [
      { value: "", label: "journey.designer.ui.in-the-browser-then-the-sandbox" },
      { value: "server", label: "journey.designer.ui.also-ask-the-host-s-server" }
    ],
    stated: { client: "journey.designer.ui.in-the-browser-then-the-sandbox-written-out" }
  },
  "page-kind": {
    choices: [
      { value: "", label: "journey.designer.ui.questions" },
      { value: "exit", label: "journey.designer.ui.exit-content-only-the-journey-stops-here" },
      { value: "review", label: "journey.designer.ui.check-answers" }
    ],
    stated: { questions: "journey.designer.ui.questions-written-out" }
  },
  "review-empty": {
    choices: [
      { value: "", label: "journey.designer.review.emptyNotProvided" },
      { value: "omit", label: "journey.designer.review.emptyOmit" }
    ],
    stated: { notProvided: "journey.designer.review.emptyNotProvided-written-out" }
  },
  "page-continue": {
    choices: [
      { value: "", label: FOLLOW_JOURNEY },
      { value: "page", label: "journey.designer.ui.check-the-page-on-continue" },
      { value: "defer", label: "journey.designer.ui.move-on-check-at-the-end" }
    ]
  },
  "page-server": {
    choices: [
      { value: "", label: FOLLOW_JOURNEY },
      { value: "true", label: "journey.designer.ui.ask-the-host-s-server" },
      { value: "false", label: "journey.designer.ui.do-not-ask-the-server" }
    ]
  },
  "page-unavailable": {
    choices: [
      { value: "", label: FOLLOW_JOURNEY },
      { value: "block", label: "journey.designer.ui.stay-on-the-page-asking-to-try-again" },
      { value: "continue", label: "journey.designer.ui.go-on-without-the-server" }
    ]
  }
};

function rootDefinition(context: JourneyFacesContext): ComponentDefinition {
  return {
    type: JOURNEY_ROOT_TYPE,
    version: "1.0.0",
    createDefault: () => emptyJourneyTree(),
    capabilities: [],
    children: { slots: [{ id: JOURNEY_PAGES_SLOT, multiple: true, allowedTypes: [JOURNEY_PAGE_TYPE], emptyHint: builderText("journey.designer.hint.pages", undefined, wordsOf(context)) }] },
    propertyEditor: {
      mode: "replace",
      fields: [
        textField("journey", "name", wordsOf(context)),
        select("journey-progress", "progress", builderText("journey.designer.ui.page-count", undefined, wordsOf(context)), builderText("journey.designer.ui.whether-each-questions-page-is-captioned-with-wher", undefined, wordsOf(context))),
        select("journey-heading", "heading", builderText("journey.designer.ui.page-heading", undefined, wordsOf(context)), builderText("journey.designer.ui.each-page-s-own-heading-with-the-form-s-title-as-a", undefined, wordsOf(context))),
        select("journey-off-path", "offPathValues", builderText("journey.designer.ui.answers-on-pages-the-path-skips", undefined, wordsOf(context)), builderText("journey.designer.ui.a-component-s-own-setting-for-hidden-answers-wins-", undefined, wordsOf(context))),
        select("journey-continue", "validation.continue", builderText("journey.designer.ui.checking-on-continue", undefined, wordsOf(context)), builderText("journey.designer.ui.every-page-unless-the-page-says-otherwise", undefined, wordsOf(context))),
        select("journey-server", "validation.server", builderText("journey.designer.ui.ask-the-host-s-server-on-continue", undefined, wordsOf(context)), builderText("journey.designer.ui.sends-every-answer-so-far-the-host-supplies-the-wa", undefined, wordsOf(context))),
        select("journey-unavailable", "validation.onUnavailable", builderText("journey.designer.ui.when-the-server-cannot-be-reached", undefined, wordsOf(context))),
        select("journey-end", "validation.end", builderText("journey.designer.ui.the-check-when-the-person-submits", undefined, wordsOf(context)), builderText("journey.designer.ui.a-preview-in-this-builder-never-asks-the-server", undefined, wordsOf(context))),
        textField("journey", "texts-back", wordsOf(context)),
        textField("journey", "texts-continue", wordsOf(context)),
        textField("journey", "texts-submit", wordsOf(context)),
        textField("journey", "texts-pageOf", wordsOf(context)),
        textField("journey", "texts-checking", wordsOf(context)),
        textField("journey", "texts-serverUnavailable", wordsOf(context))
      ],
      sections: [
        { id: "journey", title: builderText("journey.designer.ui.journey", undefined, wordsOf(context)), fieldIds: ["name", "journey-heading", "journey-progress", "journey-off-path"] },
        { id: "validation", title: builderText("journey.designer.ui.validation", undefined, wordsOf(context)), fieldIds: ["journey-continue", "journey-server", "journey-unavailable", "journey-end"] },
        {
          id: "wording",
          title: builderText("journey.designer.ui.wording", undefined, wordsOf(context)),
          fieldIds: ["texts-back", "texts-continue", "texts-submit", "texts-pageOf", "texts-checking", "texts-serverUnavailable"]
        }
      ]
    }
  };
}

/** A Check answers step's own boxes are drawn only while the step's kind is that. */
const REVIEW_ONLY = { propertyPath: "kind", equals: "review" } as const;

function pageDefinition(context: JourneyFacesContext, contentTypes: readonly string[]): ComponentDefinition {
  return {
    type: JOURNEY_PAGE_TYPE,
    version: "1.0.0",
    createDefault: () => journeyNodeTemplate(JOURNEY_PAGE_TYPE) as ComponentNode,
    capabilities: [],
    children: {
      slots: [
        { id: JOURNEY_CONTENT_SLOT, multiple: true, allowedTypes: [JOURNEY_FIELD_TYPE, ...contentTypes], emptyHint: builderText("journey.designer.hint.content", undefined, wordsOf(context)) },
        { id: JOURNEY_ROUTES_SLOT, multiple: true, allowedTypes: [JOURNEY_ROUTE_TYPE], emptyHint: builderText("journey.designer.hint.routes", undefined, wordsOf(context)) }
      ]
    },
    propertyEditor: {
      mode: "replace",
      fields: [
        {
          id: "pageId",
          type: "text",
          propertyPath: "pageId",
          label: builderText("journey.designer.ui.page-id", undefined, wordsOf(context)),
          description:
            builderText("journey.designer.ui.what-routes-and-a-submission-s-record-name-the-pag", undefined, wordsOf(context))
        },
        textField("page", "title", wordsOf(context)),
        textField("page", "description", wordsOf(context)),
        select("page-kind", "kind", builderText("journey.designer.ui.kind", undefined, wordsOf(context))),
        // The Check answers step's own settings, drawn only while it is one (`visibleWhen` reads the draft).
        {
          id: "review-listed",
          type: "custom",
          propertyPath: REVIEW_LISTED_PROPERTY,
          label: builderText("journey.designer.review.listed", undefined, wordsOf(context)),
          description: builderText("journey.designer.review.listed.description", undefined, wordsOf(context)),
          visibleWhen: REVIEW_ONLY
        },
        { ...select("review-empty", "review.emptyOptional", builderText("journey.designer.review.empty", undefined, wordsOf(context))), visibleWhen: REVIEW_ONLY },
        {
          id: "review-change",
          type: "boolean",
          propertyPath: "review.change",
          label: builderText("journey.designer.review.change", undefined, wordsOf(context)),
          description: builderText("journey.designer.review.change.description", undefined, wordsOf(context)),
          defaultValue: true,
          visibleWhen: REVIEW_ONLY
        },
        select("page-continue", "validation.continue", builderText("journey.designer.ui.checking-on-continue", undefined, wordsOf(context))),
        select("page-server", "validation.server", builderText("journey.designer.ui.ask-the-host-s-server-on-continue", undefined, wordsOf(context))),
        select("page-unavailable", "validation.onUnavailable", builderText("journey.designer.ui.when-the-server-cannot-be-reached", undefined, wordsOf(context))),
        textField("page", "texts-continue", wordsOf(context)),
        textField("page", "texts-submit", wordsOf(context)),
        textField("page", "texts-back", wordsOf(context))
      ],
      sections: [
        { id: "page", title: builderText("journey.designer.ui.page", undefined, wordsOf(context)), fieldIds: ["pageId", "title", "description", "page-kind"] },
        { id: "review", title: builderText("journey.designer.review.section", undefined, wordsOf(context)), fieldIds: ["review-listed", "review-empty", "review-change"], hideWhenEmpty: true },
        { id: "validation", title: builderText("journey.designer.ui.validation", undefined, wordsOf(context)), fieldIds: ["page-continue", "page-server", "page-unavailable"] },
        { id: "wording", title: builderText("journey.designer.ui.wording", undefined, wordsOf(context)), fieldIds: ["texts-continue", "texts-submit", "texts-back"] }
      ]
    }
  };
}

function questionDefinition(context: JourneyFacesContext): ComponentDefinition {
  return {
    type: JOURNEY_FIELD_TYPE,
    version: "1.0.0",
    createDefault: () => journeyNodeTemplate(JOURNEY_FIELD_TYPE) as ComponentNode,
    capabilities: [],
    propertyEditor: {
      mode: "replace",
      fields: [
        select("componentId", "componentId", builderText("journey.designer.ui.form-component", undefined, wordsOf(context)), builderText("journey.designer.ui.which-of-the-form-s-components-the-page-asks-a-gro", undefined, wordsOf(context)))
      ]
    }
  };
}

function routeDefinition(context: JourneyFacesContext): ComponentDefinition {
  return {
    type: JOURNEY_ROUTE_TYPE,
    version: "1.0.0",
    createDefault: () => journeyNodeTemplate(JOURNEY_ROUTE_TYPE) as ComponentNode,
    capabilities: [],
    propertyEditor: {
      mode: "replace",
      fields: [
        select("to", "to", builderText("journey.designer.ui.goes-to", undefined, wordsOf(context)), builderText("journey.designer.ui.where-the-person-goes-when-this-route-is-taken-rou", undefined, wordsOf(context)))
      ]
    }
  };
}

/**
 * What the designer's palette offers: pages, the form's fields and routes; the root is the
 * journey itself. The page-only chunk adds "Worked-out value" to the group and the page-only
 * fields after it. The Route arrow carries U+FE0E (text presentation): a theme whose
 * font stack names a colour emoji font (Bootstrap's does) would otherwise draw it as an emoji tile.
 */
export function journeyComponentTypes(text?: BuilderTextOptions): BuilderComponentType[] {
  return [
    { type: JOURNEY_PAGE_TYPE, label: builderText("journey.designer.palette.page", undefined, text), icon: "▭", group: JOURNEY_PALETTE_GROUP, inspectorTab: "step" },
    { type: JOURNEY_FIELD_TYPE, label: builderText("journey.designer.palette.field", undefined, text), icon: "?", group: JOURNEY_PALETTE_GROUP },
    { type: JOURNEY_ROUTE_TYPE, label: builderText("journey.designer.palette.route", undefined, text), icon: "↪︎", group: JOURNEY_PALETTE_GROUP }
  ];
}

/**
 * Every designer type's definition, the root included, with faces reading `context`; a page's
 * content takes `contentTypes` besides the form's fields (a worked-out value and the
 * page-only fields, whose definitions the page-only chunk brings).
 */
export function journeyComponentDefinitions(context: JourneyFacesContext, contentTypes: readonly string[] = []): ComponentDefinition[] {
  return [rootDefinition(context), pageDefinition(context, contentTypes), questionDefinition(context), routeDefinition(context)];
}

/**
 * What the mode's idle controller holds while the form has no journey: a
 * journey root with nothing to edit, and no palette. The canvas shows the empty state instead.
 */
export function journeyIdleDefinitions(): ComponentDefinition[] {
  return [
    {
      type: JOURNEY_ROOT_TYPE,
      version: "1.0.0",
      createDefault: () => emptyJourneyTree(),
      capabilities: [],
      children: { slots: [{ id: JOURNEY_PAGES_SLOT, multiple: true, allowedTypes: [JOURNEY_PAGE_TYPE] }] },
      propertyEditor: { mode: "none" }
    }
  ];
}

// --- the controller's hooks -----------------------------------------------------------------

/** `choices` with the stored value written out as its own entry, when it is one of `stated`. */
/** A choice's label: a builder key of the catalog (the fixed choices are keyed), in the builder's words. */
function choiceText(label: string, text: BuilderTextOptions): string {
  return label in JOURNEY_EN || label in BUILDER_TEXTS_EN ? builderText(label as BuilderTextKey, undefined, text) : label;
}

function withStated(entry: SelectChoices, stored: unknown, text: BuilderTextOptions): InspectorChoice[] {
  const choices = entry.choices.map((choice) => ({ ...choice, label: choiceText(choice.label, text) }));
  const value = stored === undefined || stored === null ? "" : String(stored);
  const stated = entry.stated?.[value];
  if (stated !== undefined && !choices.some((choice) => choice.value === value)) {
    choices.push({ value, label: choiceText(stated, text) });
  }
  return choices;
}

function readPath(node: ComponentNode, path: string): unknown {
  let cursor: unknown = node.configuration;
  for (const part of path.split(".")) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

/**
 * The choices of a designer select (`BuilderControllerOptions.fieldChoices`): a question's
 * form component (every component of the form, "Label (id)"), a route's page (every page — a
 * backward one marked ignored, as a hand-written file may hold one — and the end, with a route
 * to a page since deleted shown as the missing page it names, or as the page now written under
 * that id), and the fixed selects'.
 */
export function journeyFieldChoices(context: JourneyFacesContext, node: ComponentNode, field: PropertyEditorField): InspectorChoice[] | undefined {
  if (node.type === JOURNEY_PAGE_TYPE && field.propertyPath === REVIEW_LISTED_PROPERTY) {
    return reviewListedChoices(context, node);
  }
  if (node.type === JOURNEY_FIELD_TYPE && field.propertyPath === "componentId") {
    return [
      { value: "", label: builderText("journey.designer.choose", undefined, wordsOf(context)) },
      ...context.form().order.map((component) => ({ value: component.id, label: builderText("journey.designer.component.ref", { label: component.label, id: component.id }, wordsOf(context)) }))
    ];
  }
  if (node.type === JOURNEY_ROUTE_TYPE && field.propertyPath === "to") {
    const configuration = configurationOf(node);
    const to = stringOf(configuration.to);
    const missingTo = stringOf(configuration.missingTo);
    const view = context.view();
    const form = context.form();
    const own = view.index.pageOf.get(node.id);
    // A route with no page node of its own that is written to a page all the same (see pageByWrittenTarget).
    const byId = to === "" || !view.index.pages.some((page) => page.nodeId === to) ? pageByWrittenTarget(node, view) : undefined;
    const kept = byId ? builderText("journey.designer.route.kept", { page: pageReference(byId, form, context.locale(), context.sources(), wordsOf(context), context.journeyId()) }, wordsOf(context)) : undefined;
    const choices: InspectorChoice[] = [
      { value: "", label: to === "" && kept !== undefined ? kept : missingTo !== "" ? builderText("journey.designer.route.missingKept", { page: missingTo }, wordsOf(context)) : builderText("journey.designer.choose", undefined, wordsOf(context)) },
      ...view.index.pages.map((page) => {
        const reference = pageReference(page, form, context.locale(), context.sources(), wordsOf(context), context.journeyId());
        const behind = own !== undefined && page.number <= own.number;
        const detail = builderText(page.number === own?.number ? "journey.designer.route.thisPage" : "journey.designer.route.earlierChoice", undefined, wordsOf(context));
        return { value: page.nodeId, label: behind ? builderText("journey.designer.route.behind", { reference, detail }, wordsOf(context)) : reference };
      }),
      { value: JOURNEY_END, label: builderText("journey.designer.route.end", undefined, wordsOf(context)) }
    ];
    if (to !== "" && to !== JOURNEY_END && !view.index.pages.some((page) => page.nodeId === to)) {
      choices.splice(1, 0, { value: to, label: kept ?? builderText("journey.designer.route.missingChoice", { page: context.pageIds().get(to) ?? to }, wordsOf(context)) });
    }
    return choices;
  }
  const fixed = SELECT_CHOICES[field.id];
  return fixed ? withStated(fixed, readPath(node, field.propertyPath), wordsOf(context)) : undefined;
}

/**
 * What a Check answers step's inspector lists under "Answers listed": a line saying how many
 * (a choice with no value), then each step that asks one, named as the map names it, with the
 * answers it brings in the order the step draws them, worded as the row will be (the step's own
 * wording for the row, else the field's label). Read-only: the list is the steps' to change.
 */
function reviewListedChoices(context: JourneyFacesContext, node: ComponentNode): InspectorChoice[] {
  const text = wordsOf(context);
  if (configurationOf(node).kind !== "review") {
    return [];
  }
  const view = context.view();
  const root = context.formRoot?.();
  const listing = root ? journeyReviewListing(root, view.check.journey, { ownership: view.check.ownership, isValueless: context.isValueless }) : { steps: [], count: 0 };
  if (listing.count === 0) {
    return [{ value: "", label: builderText("journey.designer.review.listed.none", undefined, text) }];
  }
  const labels = isRecord(configurationOf(node).review) ? (configurationOf(node).review as Record<string, unknown>).labels : undefined;
  const form = context.form();
  const choices: InspectorChoice[] = [{ value: "", label: builderPlural("journey.designer.review.listed.count", listing.count, undefined, text) }];
  for (const step of listing.steps) {
    const entry = view.index.pages.find((candidate) => candidate.pageId === step.pageId);
    const group = entry ? pageName(entry, form, context.locale(), context.sources(), context.journeyId()) : step.pageId;
    for (const componentId of step.answers) {
      const own = isRecord(labels) ? words(labels[componentId], context.locale(), context.sources(), journeyTextAddress(context.journeyId(), `${REVIEW_LABELS_PROPERTY}.${componentId}`, writtenPageId(node))) : undefined;
      choices.push({ value: componentId, label: own ?? form.components.get(componentId)?.label ?? componentId, group });
    }
  }
  return choices;
}

/**
 * What holds a page's Save back (`BuilderControllerOptions.problems`): a page id the
 * end of a journey is named by, one another page of the journey already has, or a form
 * component's id. The controller counts each only while the draft changes `pageId`, so a clash
 * already in the file stays the advisory finding and never blocks an unrelated edit.
 */
export function journeyPageIdProblems(form: JourneyFormIndex, edited: ComponentNode, tree: ComponentNode, componentId: string, text?: BuilderTextOptions): BuilderProblem[] {
  if (edited.type !== JOURNEY_PAGE_TYPE) {
    return [];
  }
  const pageId = stringOf(configurationOf(edited).pageId);
  if (pageId.trim() === "") {
    return [];
  }
  if (pageId === JOURNEY_END) {
    return [{ target: "pageId", message: builderText("journey.designer.pageId.end", { end: JOURNEY_END }, text) }];
  }
  const pages = (tree.children?.[JOURNEY_PAGES_SLOT] ?? []).filter((page) => page.type === JOURNEY_PAGE_TYPE && page.id !== componentId);
  if (pages.some((page) => stringOf(configurationOf(page).pageId).trim() !== "" && writtenPageId(page) === pageId)) {
    return [{ target: "pageId", message: builderText("journey.designer.pageId.taken", { id: pageId }, text) }];
  }
  if (pageId === form.rootId || form.components.has(pageId)) {
    return [{ target: "pageId", message: builderText("journey.designer.pageId.component", { id: pageId }, text) }];
  }
  // A page-only field's texts are keyed by its id where a page's are.
  if (journeyTreeOwnIds(tree).includes(pageId)) {
    return [{ target: "pageId", message: builderText("journey.designer.pageId.field", { id: pageId }, text) }];
  }
  return [];
}

/** What the outline calls a designer node (`BuilderControllerOptions.nodeLabel`). */
export function journeyNodeLabel(context: JourneyFacesContext, node: ComponentNode): string | undefined {
  const form = context.form();
  const configuration = configurationOf(node);
  switch (node.type) {
    case JOURNEY_ROOT_TYPE:
      return words(configuration.name, context.locale(), context.sources(), addressOf.journey(context.journeyId(), "name")) ?? context.journeyId();
    case JOURNEY_PAGE_TYPE: {
      const page = context.view().index.pageOf.get(node.id);
      return page ? pageReference({ ...page, node }, form, context.locale(), context.sources(), wordsOf(context), context.journeyId()) : undefined;
    }
    case JOURNEY_FIELD_TYPE: {
      const componentId = stringOf(configuration.componentId);
      if (componentId === "") {
        return builderText("journey.designer.question.notChosen", undefined, wordsOf(context));
      }
      return form.components.get(componentId)?.label ?? `${componentId} (not in the form)`;
    }
    case JOURNEY_ROUTE_TYPE:
      return builderText("journey.designer.route.arrow", { target: routeTarget(node, context).text }, wordsOf(context));
    default:
      return context.ownLabel?.(node);
  }
}

/** The ID row (`BuilderControllerOptions.idRow`): the journey's id on the root, read-only; none below, whose ids are the builder's own. */
export function journeyIdRow(context: JourneyFacesContext, node: ComponentNode, place: { isRoot: boolean }): BuilderIdRow {
  if (place.isRoot || node.type === JOURNEY_ROOT_TYPE) {
    return {
      mode: "static",
      text: context.journeyId(),
      help: builderText("journey.designer.help.journeyId", undefined, wordsOf(context))
    };
  }
  return context.ownIdRow?.(node) ?? { mode: "hidden" };
}

/** Which box of a page's inspector a page finding is about; the others are said of the page as a whole. */
const PAGE_FINDING_BOXES: Readonly<Record<string, string>> = {
  "page.duplicate-id": "pageId",
  "page.id-is-component-id": "pageId",
  "page.no-title": "title",
  "page.validation-server-deferred": "validation.server",
  "page.validation-on-exit": "kind",
  "page.review-repeated": "kind",
  "page.review-not-last": "kind"
};

/**
 * The findings of the journey as a whole that belong to a box of the Journey panel: a later journey with the same id is
 * the ID's. The others the findings card at the top of the same panel says (`journey-findings.ts`), once, so no note
 * says them again.
 */
const ROOT_FINDING_BOXES: ReadonlySet<string> = new Set(["journey.duplicate-id"]);

/**
 * The journey's findings about a node as notes in its inspector (`BuilderControllerOptions.notes`): what its card says on the canvas, said again where it is put right — a page id's
 * under the Page id box, a question's under its form component, a route's under where it goes, and
 * the rest (a route's condition, which is edited in the Logic workspace, a page no path reaches,
 * the journey's own) above the sections. Advisory: only a page id the draft changes to a taken one
 * holds a Save back (`journeyPageIdProblems`), and that problem stands in for the note.
 */
export function journeyNotes(context: JourneyFacesContext, node: ComponentNode, componentId: string): BuilderNote[] {
  const findings = context.view().check.findings;
  const found = node.type === JOURNEY_ROOT_TYPE ? findings.root.filter((finding) => ROOT_FINDING_BOXES.has(finding.code)) : (findings.byNode.get(componentId) ?? []);
  return found.map((finding) => {
    // A route's condition findings name no box: its condition is edited in the Logic workspace,
    // not on a Rules tab, so the note stands above the inspector's sections.
    const target =
      node.type === JOURNEY_ROUTE_TYPE && finding.code.startsWith("condition.")
        ? undefined
        : node.type === JOURNEY_PAGE_TYPE
          ? PAGE_FINDING_BOXES[finding.code]
          : node.type === JOURNEY_FIELD_TYPE
            ? "componentId"
            : node.type === JOURNEY_ROUTE_TYPE
              ? "to"
              : undefined;
    return { ...(target !== undefined ? { target } : {}), message: finding.message, severity: finding.severity };
  });
}

/** The inspector sections that start folded (`BuilderControllerOptions.foldedSections`): the wording, which few journeys change. */
export function journeyFoldedSections(node: ComponentNode): readonly string[] | undefined {
  return node.type === JOURNEY_ROOT_TYPE || node.type === JOURNEY_PAGE_TYPE ? ["wording"] : undefined;
}

/**
 * Ghost text for an empty box (`BuilderControllerOptions.fieldPlaceholder`): a page's page id
 * left blank is written as its node id, so that is what the box shows.
 */
export function journeyFieldPlaceholder(node: ComponentNode, field: PropertyEditorField): string | undefined {
  return node.type === JOURNEY_PAGE_TYPE && field.propertyPath === "pageId" ? node.id : undefined;
}

/**
 * What "Remove missing" takes off the pages, in tree order: the questions of `tree` whose form
 * component the form no longer has (deleted, or never there) — at the top of a page, and inside
 * a layout of the journey's own — and the worked-out values whose form field is gone.
 * A question with no component chosen yet, or a worked-out value with no field, is not missing
 * anything, and one naming the form itself is a finding of its own. The controller removes them
 * as one undo step; one inside another it removes goes with it.
 */
export function journeyMissingQuestions(form: JourneyFormIndex, tree: ComponentNode): string[] {
  const missing: string[] = [];
  const gone = (componentId: string): boolean => componentId !== "" && componentId !== form.rootId && !form.components.has(componentId);
  for (const page of tree.children?.[JOURNEY_PAGES_SLOT] ?? []) {
    // A stack of its own, last first: tree order, however deep the journey's own layouts nest.
    const stack = [...(page.children?.[JOURNEY_CONTENT_SLOT] ?? [])].reverse();
    while (stack.length > 0) {
      const node = stack.pop() as ComponentNode;
      const configuration = configurationOf(node);
      if (node.type === JOURNEY_FIELD_TYPE ? gone(stringOf(configuration.componentId)) : node.type === PRESENTATION_VALUE_TYPE && gone(stringOf(configuration.to))) {
        missing.push(node.id);
        continue;
      }
      if (node.type !== JOURNEY_FIELD_TYPE) {
        const children = Object.values(node.children ?? {}).flat();
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push(children[index]!);
        }
      }
    }
  }
  return missing;
}
