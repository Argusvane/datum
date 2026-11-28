/**
 * The journey Try it runs: the journey on the page as a person would go
 * through it, on the Form canvas's own renderer (the canvas draws the form over this session's
 * runtime while Try it is on in the Journeys workspace) — a real runtime whose journeys are the
 * designer's tree as it stands, drafts included, so a condition or a route edited in the
 * inspector changes the path as it is typed.
 *
 * The runtime is the host's when it supplies one (`JourneyBuilderModeOptions.previewRuntime`:
 * `<datum-form-builder>` builds it as it builds its forms), else the engine's own — the form's field
 * constraints alone, no drafts, no plugins, no sandbox, which the Journey card says. Either way
 * it is handed the journeys through `journeyConfiguration`, which makes it a preview: no page
 * is checked against a server, which knows the registered definition, not the one being
 * edited — the card says that too. That configuration names pages by node id and is never
 * saved: the definition's own block is the mode's (`journeyConfiguration` there).
 *
 * Keeping it current:
 * - An edit to the journey, a draft keystroke included, re-reads it and works the path out again
 *   (`refreshJourney`): the answers typed stay, and so does the page.
 * - The journey the runtime runs names each page by its node id, not its page id, so the page
 *   the person is on is kept by its node while its id is typed — `startJourney` could
 *   not have put it back past the first page, since nothing is completed when a journey
 *   starts. Pages sharing an id stay two pages. Routes are read as the written journey reads
 *   them: to the first page with the target's id; a target no page has stays unknown. The
 *   configuration handed over keeps its identity while its content does, which is what the
 *   runtime caches the journey and its ownership by.
 * - A new form tree or new locales rebuild the runtime, the answers replayed and the page kept
 *   where the path still takes it; another locale is only switched to. The answers replayed
 *   include the presentation's own (under `@<journey id>`), never another's.
 * - The runtime's index of the journey's own nodes is the journey's: a new journey read on
 *   `refreshJourney` (another configuration object) is indexed afresh, so a page-only field
 *   added on the canvas is asked in the preview at once.
 * - Restart builds a new runtime with no answers.
 * - Try it starts with the canvas's one set of answers (`seed`), the ones
 *   typed alone (`typed`): a calculation or a default is worked out again, never made an answer
 *   tried. A rebuild and another journey carry over typed answers the same way. `answers()` is
 *   what a submission on this path carries (the submittable view: fields on skipped pages left
 *   out), which the Try panel's Submission data, checks and stand-in server read; the
 *   canvas takes the runtime's stored answers back itself when Try it ends.
 * - Submit is checked as a submit would check it (`submit()`): nothing is sent, the fields are
 *   marked as Continue marks them, and a problem on an earlier page (the journey's checks
 *   deferred to the end) takes the person to that page. `check()` marks nothing: it checks a
 *   scratch runtime holding the same answers, and lists the problems on the path so far.
 *
 * Nothing here draws the form: the canvas does, and keeps what happens in it to itself (a
 * Submit, a language switch, a link). What the Try panel says of the journey is the Journey
 * card (`card()`): the path so far, Restart, Open this step, what the last Submit or a link held
 * back said. Its markup lives here, in the chunk, so the builder's module carries none of it.
 *
 * A chunk of its own, which the designer loads ahead, once a journey is on
 * the page, and at the latest on the first Try it (`loadJourneyPreview` in
 * `journey-designer.ts`): the designer's chunk imports nothing from here but types, and this
 * one imports nothing of the designer's but types either — what it reads of `journey-checks.ts`
 * and `journey-components.ts` the designer lends it (`JourneyPreviewLent`), as it lends the
 * flow map its words. Nothing here runs at import.
 */
import { FormEventType } from "../../core/events/event-types.js";
import type { JourneyTrace, JourneyView } from "../../core/journey/journey-types.js";
import { addressOf, moveTranslations, resolveText, type FormTranslations, type TextSources } from "../../core/localization/translations.js";
import { readValidationMessages, resolveValidationMessage } from "../../core/localization/validation-messages.js";
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import { JOURNEY_END, type Journey, type JourneyConfiguration } from "../../core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import { kernelJsonAnswers } from "../../core/state/submittable-fold.js";
import { SubmissionModeRegistry } from "../../core/submission/submission-modes.js";
import { FormRuntime } from "../../runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../../validation/core/field-constraints.js";
import { ValidationPipeline } from "../../validation/core/validation-pipeline.js";
import type { BuilderController, FormIdentity } from "../controller/builder-controller.js";
import { esc } from "../web-component/builder-shared.js";
import type { TryCheckProblem } from "../web-component/try-it-types.js";
import type { JourneyPreviewRuntime, JourneyPreviewRuntimeRequest } from "./journey-builder-mode.js";
import type { indexJourneyTree, journeyFromTreePlaced } from "./journey-checks.js";
import type { JourneyFormIndex, pageName } from "./journey-components.js";
import { formTranslationsOf } from "./journey-texts.js";
import { tryMapState, type TryMapState } from "./journey-try-map.js";
import type { BuilderTextKey, BuilderTextOptions } from "../logic/builder-texts.js";
import { JOURNEY_PREVIEW_EN, builderPlural, builderText } from "./journey-preview-texts-en.js";

/** What the Journey card always says: the journey's pages ask no server here. */
export const JOURNEY_PREVIEW_SERVER_NOTE = JOURNEY_PREVIEW_EN["journey.preview.note.server"];

/** What the card says over the engine's own runtime, which knows none of the host's validators. */
export const JOURNEY_PREVIEW_ENGINE_NOTE = JOURNEY_PREVIEW_EN["journey.preview.note.engine"];

/** What a Submit at the end of the journey is answered with, once the answers pass. */
export const JOURNEY_PREVIEW_SUBMIT_TEXT = JOURNEY_PREVIEW_EN["journey.preview.submit"];

/** What a click on a link in the journey is answered with: the builder's tab stays put. */
export const JOURNEY_PREVIEW_LINK_TEXT = JOURNEY_PREVIEW_EN["journey.preview.link"];

/**
 * The Journey card's marker: `check-bundles` finds the try session's chunk by it,
 * so it is spelled here alone, never in the builder's module or the designer's chunk.
 */
const TRY_SESSION_MARK = "data-journey-try-session";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the preview reads of the designer's own modules, lent by the designer that loads this
 * chunk (`JOURNEY_PREVIEW_LENT`), as the flow map is lent its words: how the tree is written
 * and placed, and the cards' page names. Imported, they would tie this chunk to the designer's
 * by a static import — and a browser keeps a failed load of a module for the page's life, so a
 * designer's chunk fetched again after one (under another URL) would leave
 * this chunk unable to load until the page is reloaded.
 */
export interface JourneyPreviewLent {
  journeyFromTreePlaced: typeof journeyFromTreePlaced;
  indexJourneyTree: typeof indexJourneyTree;
  pageName: typeof pageName;
}

// --- the journey the preview runs ----------------------------------------------------------

export interface PreviewJourneyOptions {
  /** The entry's node id -> page id memory (`journey-tree.ts`), for a route whose page was deleted; read, never changed. */
  pageIds?: ReadonlyMap<string, string> | undefined;
  /** The entry's route-link memory (`journey-tree.ts`); read, never changed. */
  routeLinks?: ReadonlyMap<string, string> | undefined;
  /** Hears why the tree cannot be written (`validateJourneyShape`'s words). */
  onError?: ((problems: string[]) => void) | undefined;
}

/**
 * The journey the preview runs: the tree as `journeyFromTree` writes it, each page under its
 * node id (see the module comment), each route to the node of the first page carrying its
 * target's id. A target no page has stays unknown, never the node id of a page it happens to
 * spell. `undefined` when the tree cannot be written.
 */
export function previewJourney(lent: JourneyPreviewLent, tree: ComponentNode, journeyId: string, options: PreviewJourneyOptions = {}): Journey | undefined {
  const written = lent.journeyFromTreePlaced(tree, journeyId, {
    pageIds: new Map(options.pageIds ?? []),
    routeLinks: new Map(options.routeLinks ?? []),
    ...(options.onError ? { onError: options.onError } : {})
  });
  if (!written) {
    return undefined;
  }
  const { journey, placement } = written;
  const nodeIds = journey.pages.map((page, index) => placement.pages[index]?.nodeId || page.id);
  const taken = new Set(nodeIds);
  const nodeOf = new Map<string, string>();
  journey.pages.forEach((page, index) => {
    if (!nodeOf.has(page.id)) {
      nodeOf.set(page.id, nodeIds[index] as string);
    }
  });
  const target = (to: string): string => {
    if (to === JOURNEY_END) {
      return to;
    }
    const node = nodeOf.get(to);
    if (node !== undefined) {
      return node;
    }
    let unknown = to;
    while (taken.has(unknown)) {
      unknown = `${unknown}~missing`;
    }
    return unknown;
  };
  return {
    ...journey,
    pages: journey.pages.map((page, index) => ({
      ...page,
      id: nodeIds[index] as string,
      ...(page.routes ? { routes: page.routes.map((route) => ({ ...route, to: target(route.to) })) } : {})
    }))
  };
}

/**
 * Where the preview is, in words: the pages taken so far, each by its number on the canvas and
 * its name ("1 About you › 3 Details"), then the page's place among the path's questions pages
 * ("page 2 of 4") or that it is an exit page. A page the tree no longer holds (deleted while
 * the person was past it) goes by the page id it was written as (`pageIds`), never by its node
 * id, which is internal.
 */
export function journeyPreviewPath(
  lent: JourneyPreviewLent,
  view: Pick<JourneyView, "path" | "index" | "kind" | "number" | "total">,
  tree: ComponentNode,
  form: JourneyFormIndex,
  locale: string,
  sources?: TextSources,
  pageIds?: ReadonlyMap<string, string>,
  text?: BuilderTextOptions,
  journeyId?: string
): string {
  const index = lent.indexJourneyTree(tree);
  const label = (nodeId: string): string => previewStepLabel(lent, index, nodeId, form, locale, sources, pageIds, text, journeyId);
  const taken = view.path.slice(0, view.index + 1).map(label);
  const where = view.kind === "exit" ? builderText("journey.preview.path.exit", undefined, text) : builderText("journey.preview.path.page", { number: view.number, total: view.total }, text);
  return `${taken.join(" › ")} · ${where}`;
}

/**
 * One step by its number on the canvas and its name ("2 Owning or renting"), as the path line
 * and the Change note name it; a step the tree no longer holds goes by the page id it was
 * written as, never by its node id.
 */
function previewStepLabel(
  lent: JourneyPreviewLent,
  index: ReturnType<JourneyPreviewLent["indexJourneyTree"]>,
  nodeId: string,
  form: JourneyFormIndex,
  locale: string,
  sources: TextSources | undefined,
  pageIds: ReadonlyMap<string, string> | undefined,
  text: BuilderTextOptions | undefined,
  journeyId: string | undefined
): string {
  const page = index.pageOf.get(nodeId);
  return page && page.nodeId === nodeId
    ? `${page.number} ${lent.pageName(page, form, locale, sources, journeyId)}`
    : (pageIds?.get(nodeId) ?? builderText("journey.preview.path.gone", undefined, text));
}

/**
 * The engine's own runtime for a preview, where the host supplies none: the form as committed,
 * its field constraints the only validation, and nothing else — no drafts, no plugins, no
 * sandbox, no submission mode (the surface answers a Submit itself).
 */
export function createEnginePreviewRuntime(
  request: JourneyPreviewRuntimeRequest,
  options: { identity?: FormIdentity | undefined; translations?: TranslationCatalog | undefined; hostContext?: Record<string, unknown> | undefined } = {}
): FormRuntime {
  const definition: FormDefinition = {
    id: options.identity?.id ?? "journey-preview",
    version: options.identity?.version ?? "1.0.0",
    schemaVersion: options.identity?.schemaVersion ?? "1",
    root: request.root,
    ...(request.localization ? { localization: request.localization } : {}),
    ...(request.translations ? { translations: request.translations } : {})
  };
  return new FormRuntime(definition, {
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
    submissionModes: new SubmissionModeRegistry(),
    journeyConfiguration: request.journeyConfiguration,
    journey: request.journeyId,
    // A preview of a journey being edited opens whatever the author has typed.
    formulaErrors: "warn",
    ...(options.translations ? { translationCatalog: options.translations } : {}),
    ...(options.hostContext ? { hostContext: options.hostContext } : {})
  });
}

// --- the session -----------------------------------------------------------------------------

/** The journey a preview shows: one per built designer, so a designer built again is a new one. */
export interface JourneyPreviewSubject {
  readonly journeyId: string;
  /** The journey's tree as the canvas shows it, drafts laid over: its controller's `previewSnapshot()`. */
  tree(): ComponentNode;
  /** The entry's node id -> page id memory, read, never changed. */
  readonly pageIds: ReadonlyMap<string, string>;
  /** The entry's route-link memory, read, never changed. */
  readonly routeLinks?: ReadonlyMap<string, string> | undefined;
}

export interface JourneyPreviewSessionOptions {
  /** The builder's locale and catalog for the card's and the messages' words, read live; English when absent. */
  text?(): BuilderTextOptions | undefined;
  /** The shell's form controller: the form the preview runs, its locale and its locales. */
  form: BuilderController;
  /** What the preview reads of the designer's modules, lent by the designer. */
  lent: JourneyPreviewLent;
  /** The host's runtime for a preview; absent, the engine's own (`createEnginePreviewRuntime`). */
  runtime?: ((request: JourneyPreviewRuntimeRequest) => JourneyPreviewRuntime) | undefined;
  /** The host's catalog, for the engine's own runtime. */
  translations?: (() => TranslationCatalog | undefined) | undefined;
  /** The form's own translations, for the engine's own runtime and the path's words. Absent: the form controller's. */
  formTranslations?: (() => FormTranslations | undefined) | undefined;
  /** What the preview shows moved: another runtime, a page, the path, the journey re-read. */
  onUpdate?: (() => void) | undefined;
  /**
   * The journey moved in any way the map beside it marks (a step, a way taken, the journey
   * re-read), asked after every recompute whether or not the card changed: the mode sets the
   * map's state again from `mapState()`.
   */
  onPath?: (() => void) | undefined;
  onError?: ((message: string, cause?: unknown) => void) | undefined;
  /**
   * The answers the first runtime starts with: the canvas's one set, as kernel JSON.
   * A journey's own answers only to itself (`carried`); Restart starts with none.
   */
  seed?: Record<string, unknown> | undefined;
  /**
   * The seed's keys the person typed (its store's dirty set): only these are replayed, so a
   * calculation or a default is worked out again rather than becoming an answer tried. Absent:
   * all of the seed.
   */
  typed?: Iterable<string> | undefined;
  /** The form's index: the page names on the Journey card and the fields a problem names. Absent: ids. */
  formIndex?: (() => JourneyFormIndex) | undefined;
}

/** What `submit()` found: the problems holding the submission back, worded for the Try panel. */
export interface JourneySubmitOutcome {
  problems: TryCheckProblem[];
}

export interface JourneyPreviewSession {
  /** The journey shown, or last shown. */
  readonly subject: JourneyPreviewSubject | undefined;
  readonly runtime: JourneyPreviewRuntime | undefined;
  /** The runtime is the engine's own, not the host's. */
  readonly engine: boolean;
  /** Why the journey as it stands cannot run, when it cannot: the runtime keeps the last that could. */
  readonly problem: string | undefined;
  /** Whether the preview is on the page: while it is not, edits are only noted. */
  readonly visible: boolean;
  /** What the runtime runs: the journey with its pages under their node ids, alone and its own default. */
  journeyConfiguration(): JourneyConfiguration | undefined;
  /** Puts `subject` on the preview: the same one carries on (brought up to date); another starts, the answers carried over. */
  show(subject: JourneyPreviewSubject): void;
  hide(): void;
  /** The journey's tree changed (`subject`'s, when given): the path is worked out again, answers and page kept. */
  refresh(subject?: JourneyPreviewSubject): void;
  /** The form changed: a new tree or new locales rebuild the runtime, answers replayed; another locale is switched to. */
  formChanged(): void;
  /** A new runtime, no answers, the first page. */
  restart(): void;
  dispose(): void;
  /** What a submission on this path carries, as kernel JSON: the submittable view; `{}` with no runtime. */
  answers(): Record<string, unknown>;
  /** Checked as a submit checks it, nothing sent, the fields marked; a problem on an earlier page of the path takes the person there. */
  submit(): Promise<JourneySubmitOutcome>;
  /** The same checks, read-only: nothing marked, nothing moved; the problems on the pages taken so far and the form's own. */
  check(): Promise<TryCheckProblem[]>;
  /** A link in the journey was kept from opening: the Journey card says so. */
  linkHeld(): void;
  /** The Journey card's markup for the Try panel. */
  card(): string;
  /**
   * The step the person is on and the ways taken to it, as the map marks them: the
   * runtime's view and the decisions its path was worked out by. `undefined` while no step is
   * shown. Worked out on every call; the map writes nothing when it is the same.
   */
  mapState(): TryMapState | undefined;
}

/**
 * The answers a new runtime is given: every form answer, and the own answers of the
 * presentation it previews — kept under `@<its id>.<own id>`, which the runtime's index of that journey
 * reads back. Another presentation's own answers (`@<another id>`) are no answer of this one's.
 */
function carried(values: Record<string, unknown>, journeyId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith("@") || key === `@${journeyId}` || key.startsWith(`@${journeyId}.`)) {
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

/**
 * The values the person typed: those whose key is in `dirty`, or inside a repeating
 * section whose rows they changed. A value a calculation or a default wrote is left for the next
 * runtime to work out again. With no `dirty`, every value.
 */
function typedValues(values: Record<string, unknown>, dirty: Iterable<string> | undefined): Record<string, unknown> {
  if (dirty === undefined) {
    return values;
  }
  const keys = [...dirty];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (keys.some((typed) => key === typed || key.startsWith(`${typed}[`) || key.startsWith(`${typed}.`))) {
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

/** What a runtime holds that the person typed: what a rebuild or another journey carries over. */
function typedOf(runtime: JourneyPreviewRuntime): Record<string, unknown> {
  const state = runtime.state();
  return typedValues(state.values, state.dirty);
}

/** A form's shape for the runtime: its committed tree and locales. */
function formKey(form: BuilderController): string {
  return JSON.stringify([form.snapshot(), form.localization() ?? null]);
}

/** A validation run's errors that hold a submission back. */
function blockingErrors(errors: unknown): Record<string, unknown>[] {
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.filter((error): error is Record<string, unknown> => isRecord(error) && (error.severity ?? "error") === "error");
}

/**
 * The earliest page on the path holding one of `errors`: where a submit takes the person,
 * so an answer left on an earlier page (the journey's checks deferred to the end)
 * is shown, not only counted. `undefined` when none is on a page of the path.
 */
function errorPageOf(errors: readonly Record<string, unknown>[], view: JourneyView | undefined): string | undefined {
  if (!view) {
    return undefined;
  }
  let earliest = -1;
  for (const error of errors) {
    const pageId = typeof error.componentId === "string" ? view.pageOf[error.componentId] : undefined;
    const at = pageId === undefined ? -1 : view.path.indexOf(pageId);
    if (at >= 0 && (earliest < 0 || at < earliest)) {
      earliest = at;
    }
  }
  return earliest >= 0 ? view.path[earliest] : undefined;
}

/** What a runtime stores, the host's included: its form values when it can say them apart, else every value. */
function storedValues(runtime: JourneyPreviewRuntime): Record<string, unknown> {
  const own = runtime as { formValues?(): Record<string, unknown> };
  return typeof own.formValues === "function" ? own.formValues() : runtime.state().values;
}

/** The runtime's upkeep for the journey Try it runs (see the module comment); needs no DOM. */
export function createJourneyPreviewSession(options: JourneyPreviewSessionOptions): JourneyPreviewSession {
  const words = (key: BuilderTextKey, params?: Record<string, string | number>): string => builderText(key, params, options.text?.());
  const form = options.form;
  /** The form's own translations: the session's, else the form controller's. */
  const formTranslations = (): FormTranslations | undefined => options.formTranslations?.() ?? formTranslationsOf(form);
  /** What resolves a text in the builder's locale: the form's translations under the host's catalog. */
  const sources = (): TextSources => ({ translations: formTranslations(), catalog: options.translations?.() });
  /**
   * The translations the preview's runtime reads. Its pages go by the designer's node ids, so a
   * page written under another id has its entries moved to its node id here, in the runtime's
   * copy only: the definition's map stays as it is.
   */
  const previewTranslations = (shown: JourneyPreviewSubject): FormTranslations | undefined => {
    let map = formTranslations();
    if (!map) {
      return undefined;
    }
    for (const [nodeId, pageId] of shown.pageIds) {
      if (nodeId !== pageId) {
        map = moveTranslations(map, { kind: "journeys", owner: shown.journeyId, path: ["pages", pageId] }, { kind: "journeys", owner: shown.journeyId, path: ["pages", nodeId] });
      }
    }
    return map;
  };
  let subject: JourneyPreviewSubject | undefined;
  let runtime: JourneyPreviewRuntime | undefined;
  let engine = false;
  let visible = false;
  /** The journey changed while the preview was off the page. */
  let stale = false;
  /** The form changed while the preview was off the page. */
  let formStale = false;
  let builtKey: string | undefined;
  let unsubscribe: Array<() => void> = [];
  /** The journey is to be read again: the tree changed while the preview was up, or a runtime is being built. */
  let unread = true;
  let configurationJson: string | undefined;
  let configuration: JourneyConfiguration | undefined;
  let problem: string | undefined;
  /** The first runtime's answers; spent once a runtime has started from them. */
  let seed = options.seed;
  /** What the Journey card says of the last Submit or link, and the page it was said on: moving on puts it away. */
  let notice: { text: string; pageId: string | undefined } | undefined;
  /** The card and the runtime as last reported (`onUpdate`). */
  let shownCard: string | undefined;
  let shownRuntime: JourneyPreviewRuntime | undefined;

  const update = (): void => {
    if (notice && runtime?.journeyView()?.pageId !== notice.pageId) {
      notice = undefined;
    }
    // The map beside the card follows the path whether or not the card's words moved.
    options.onPath?.();
    // Only when the Journey card or the runtime to draw changed: a keystroke's recompute that
    // moves neither redraws nothing (the canvas follows the answers typed itself).
    const card = cardHtml();
    if (card === shownCard && runtime === shownRuntime) {
      return;
    }
    shownCard = card;
    shownRuntime = runtime;
    options.onUpdate?.();
  };

  const say = (text: string, target: JourneyPreviewRuntime): void => {
    notice = { text, pageId: target.journeyView()?.pageId };
    update();
  };

  /**
   * A page-only field's label, from the journey's tree: its node id is internal, so a field neither the form nor the tree names is "a field of this journey".
   */
  const ownLabel = (nodeId: string, locale: string): string => {
    const stack: ComponentNode[] = subject ? [subject.tree()] : [];
    while (stack.length > 0) {
      const node = stack.pop() as ComponentNode;
      if (node.id === nodeId) {
        const written = (node.configuration as { label?: unknown } | undefined)?.label;
        const label = typeof written === "string" ? resolveText(written, addressOf.component(nodeId, "label"), locale, sources()) : undefined;
        return label?.trim() || words("journey.preview.ownField");
      }
      stack.push(...Object.values(node.children ?? {}).flat());
    }
    return words("journey.preview.ownField");
  };

  /** The errors in the Try panel's words: each field by its label, the message as the form words it. */
  const describe = (errors: readonly Record<string, unknown>[]): TryCheckProblem[] => {
    const index = options.formIndex?.();
    const catalog = readValidationMessages(form.snapshot().configuration);
    const locale = form.currentLocale();
    return errors.map((error) => {
      const componentId = typeof error.componentId === "string" ? error.componentId : undefined;
      return {
        componentId,
        label: componentId === undefined ? words("journey.preview.theForm") : (index?.components.get(componentId)?.label ?? ownLabel(componentId, locale)),
        message: resolveValidationMessage(error as Parameters<typeof resolveValidationMessage>[0], catalog, locale)
      };
    });
  };

  /** The journey's checks over its runtime, as a submit runs them (the fields marked); `undefined` when the runtime changed meanwhile (a restart). */
  const blocking = async (target: JourneyPreviewRuntime, checked: JourneyPreviewRuntime = target): Promise<Record<string, unknown>[] | undefined> => {
    let found: Record<string, unknown>[] = [];
    try {
      found = blockingErrors(await checked.validate());
    } catch (error) {
      options.onError?.(words("journey.preview.error.answers"), error);
    }
    return runtime === target ? found : undefined;
  };

  /** Read on every recompute: the journey is read again only after the tree changed, and keeps its identity while its content does. */
  const readConfiguration = (): JourneyConfiguration | undefined => {
    if (!unread || !subject) {
      return configuration;
    }
    unread = false;
    let problems: string[] = [];
    const journey = previewJourney(options.lent, subject.tree(), subject.journeyId, {
      pageIds: subject.pageIds,
      routeLinks: subject.routeLinks,
      onError: (found) => {
        problems = found;
      }
    });
    if (!journey) {
      // The last journey that could run stays running.
      problem = problems.join("; ");
      return configuration;
    }
    problem = undefined;
    const json = JSON.stringify(journey);
    if (json !== configurationJson) {
      configurationJson = json;
      configuration = { journeys: [journey], defaultJourneyId: journey.id };
    }
    return configuration;
  };

  const teardown = (): void => {
    for (const off of unsubscribe) {
      off();
    }
    unsubscribe = [];
  };

  /** A journey that could not start (unwritable, or no page applied) starts once it can. */
  const startIfIdle = (target: JourneyPreviewRuntime): void => {
    const shown = subject;
    if (shown && !target.journeyView() && readConfiguration()) {
      target.startJourney(shown.journeyId);
    }
  };

  /**
   * A runtime over the journey as it stands, in the builder's locale, `carry` replayed (typed
   * answers alone: a calculation or a default is worked out again) and the journey started: the
   * session's own, or a scratch one `check()` validates without marking the person's.
   */
  const open = (shown: JourneyPreviewSubject, carry: Record<string, unknown> | undefined): JourneyPreviewRuntime | undefined => {
    const locale = form.currentLocale();
    const request: JourneyPreviewRuntimeRequest = {
      journeyConfiguration: readConfiguration,
      journeyId: shown.journeyId,
      locale,
      root: form.snapshot(),
      localization: form.localization(),
      translations: previewTranslations(shown)
    };
    let next: JourneyPreviewRuntime;
    try {
      if (options.runtime) {
        next = options.runtime(request);
        engine = false;
        // A host's runtime takes Try it's host values when it can (`FormRuntime.setHostContext`), from its first state on.
        const hostContext = form.tryHostContext();
        if (hostContext) {
          (next as { setHostContext?(context: Record<string, unknown> | undefined): void }).setHostContext?.(hostContext);
        }
      } else {
        next = createEnginePreviewRuntime(request, { identity: form.identity(), translations: options.translations?.(), hostContext: form.tryHostContext() });
        engine = true;
      }
    } catch (error) {
      options.onError?.(words("journey.preview.error.start"), error);
      return undefined;
    }
    if (next.state().locale !== locale) {
      try {
        next.setLocale(locale);
      } catch {
        // A locale the form does not support: the preview runs in its default one.
      }
    }
    for (const [path, value] of Object.entries(carry ?? {})) {
      try {
        next.setValue(path, value);
      } catch {
        // An answer the form no longer has a place for is dropped.
      }
    }
    startIfIdle(next);
    return next;
  };

  const build = (carry: Record<string, unknown> | undefined, keepPage?: string): void => {
    teardown();
    const shown = subject;
    runtime = undefined;
    notice = undefined;
    stale = false;
    formStale = false;
    if (!shown) {
      update();
      return;
    }
    unread = true;
    configurationJson = undefined;
    configuration = undefined;
    readConfiguration();
    const next = open(shown, carry);
    if (!next) {
      builtKey = undefined;
      update();
      return;
    }
    runtime = next;
    builtKey = formKey(form);
    const events = next.events();
    for (const type of [FormEventType.JOURNEY_CHANGED, FormEventType.PAGE_CHANGED, FormEventType.PAGE_BLOCKED, FormEventType.RECOMPUTE_COMPLETED]) {
      unsubscribe.push(events.subscribe(type, update));
    }
    // Back on the page the person was on, where the path still takes them: an "error" move is
    // the runtime's way to any page of the path, at once and without hooks.
    const view = next.journeyView();
    if (keepPage !== undefined && view && view.pageId !== keepPage && view.path.includes(keepPage) && next.goToPage) {
      void next.goToPage(keepPage, { direction: "error" }).catch(() => undefined);
    }
    update();
  };

  const rebuildKeeping = (): void => {
    const previous = runtime;
    build(previous && subject ? carried(typedOf(previous), subject.journeyId) : undefined, previous?.journeyView()?.pageId);
  };

  const applyForm = (): void => {
    formStale = false;
    if (!runtime || formKey(form) !== builtKey) {
      rebuildKeeping();
      return;
    }
    const locale = form.currentLocale();
    if (runtime.state().locale !== locale) {
      try {
        runtime.setLocale(locale);
      } catch {
        // A locale the form does not support: the preview stays in the one it has.
      }
    }
    update();
  };

  const refreshNow = (): void => {
    stale = false;
    unread = true;
    const target = runtime;
    if (!target) {
      return;
    }
    target.refreshJourney();
    startIfIdle(target);
    update();
  };

  /** What the Journey card's path line says while no page is shown. */
  const idleText = (): string => {
    if (!runtime) {
      return subject ? words("journey.preview.couldNotStart") : "";
    }
    const running = readConfiguration()?.journeys?.[0];
    if (!running) {
      return words("journey.preview.cannotRun");
    }
    return running.pages.length === 0 ? words("journey.preview.noPages") : words("journey.preview.noPageApplies");
  };

  /**
   * What a Change link leaves the person to know: the step they are changing an
   * answer on and the step Continue returns to, both as the path line names a step.
   */
  const returningNote = (view: JourneyView, shown: JourneyPreviewSubject): string => {
    const returns = view.returning;
    const form = options.formIndex?.();
    if (!returns || !form) {
      return "";
    }
    const index = options.lent.indexJourneyTree(shown.tree());
    const label = (nodeId: string): string =>
      previewStepLabel(options.lent, index, nodeId, form, options.form.currentLocale(), sources(), shown.pageIds, options.text?.(), shown.journeyId);
    return words("journey.preview.returning", { step: label(view.pageId), review: label(returns.reviewPageId) });
  };

  /**
   * The Journey card. The notice line is always there, empty when there is nothing
   * to say, so what is said into it is announced. Pages go by their numbers and names, never by
   * node id.
   */
  const cardHtml = (): string => {
    const view = runtime?.journeyView();
    const shown = subject;
    const path =
      view && shown && options.formIndex
        ? journeyPreviewPath(options.lent, view, shown.tree(), options.formIndex(), form.currentLocale(), sources(), shown.pageIds, options.text?.(), shown.journeyId)
        : idleText();
    const status = engine ? `${JOURNEY_PREVIEW_SERVER_NOTE} ${JOURNEY_PREVIEW_ENGINE_NOTE}` : JOURNEY_PREVIEW_SERVER_NOTE;
    const returning = view?.returning && shown && options.formIndex ? returningNote(view, shown) : "";
    // The last version that could run is running only when there was one.
    const problemText =
      problem === undefined
        ? ""
        : configuration !== undefined
          ? words("journey.preview.problem.cannotRun", { problem })
          : words("journey.preview.problem.couldNotStart", { problem });
    return `
    <section class="try-card" aria-labelledby="try-journey-title" data-try-journey ${TRY_SESSION_MARK}>
      <div class="try-head"><h3 class="try-title" id="try-journey-title">${esc(words("journey.preview.title"))}</h3><button type="button" class="btn" data-try-mode-action="restart" data-try-journey-restart title="${esc(words("journey.preview.restart.title"))}"${shown ? "" : " disabled"}>${esc(words("journey.preview.restart"))}</button></div>
      ${shown ? `<div class="try-journey-map" data-try-journey-map></div>` : ""}
      <p class="try-note" data-try-journey-path>${esc(path)}</p>
      ${returning ? `<p class="try-note" data-try-journey-returning>${esc(returning)}</p>` : ""}
      ${problemText ? `<p class="try-error" data-try-journey-problem>${esc(problemText)}</p>` : ""}
      <p class="try-note" data-try-journey-notice role="status" aria-live="polite">${notice ? esc(notice.text) : ""}</p>
      <p class="try-note">${esc(status)}</p>
      <div class="try-actions"><button type="button" class="btn" data-try-mode-action="open-step" data-try-journey-show title="${esc(words("journey.preview.show.title"))}"${view ? "" : " disabled"}>${esc(words("journey.preview.show"))}</button></div>
    </section>`;
  };

  return {
    get subject() {
      return subject;
    },
    get runtime() {
      return runtime;
    },
    get engine() {
      return engine;
    },
    get problem() {
      return problem;
    },
    get visible() {
      return visible;
    },
    journeyConfiguration: readConfiguration,
    show(next) {
      visible = true;
      if (next !== subject || !runtime) {
        // Another journey, or another designer over it: the answers carry over — a journey's own
        // answers only to itself — the page does not. The first runtime starts from the seed.
        const from = runtime ? typedOf(runtime) : seed ? typedValues(seed, options.typed) : undefined;
        const carry = from ? carried(from, next.journeyId) : undefined;
        seed = undefined;
        subject = next;
        build(carry);
        return;
      }
      // What moved while it was off the page: the form first (a rebuild reads the journey
      // afresh too), then the journey.
      if (formStale) {
        applyForm();
      }
      if (stale) {
        refreshNow();
      }
      update();
    },
    hide() {
      visible = false;
    },
    refresh(changed) {
      if (changed !== undefined && changed !== subject) {
        return;
      }
      // Off the page the runtime keeps the journey it has, path and all, until it is shown.
      if (!visible || !runtime) {
        stale = true;
        return;
      }
      refreshNow();
    },
    formChanged() {
      if (!runtime) {
        return;
      }
      if (!visible) {
        formStale = true;
        return;
      }
      applyForm();
    },
    restart() {
      build(undefined);
    },
    dispose() {
      teardown();
      runtime = undefined;
      subject = undefined;
      visible = false;
    },
    answers() {
      const target = runtime as (JourneyPreviewRuntime & { submittableValues?(): Record<string, unknown> }) | undefined;
      if (!target) {
        return {};
      }
      // A host's runtime that cannot say the submittable view hands over every form value.
      return kernelJsonAnswers(typeof target.submittableValues === "function" ? target.submittableValues() : storedValues(target));
    },
    async submit() {
      const target = runtime;
      if (!target) {
        return { problems: [] };
      }
      const found = await blocking(target);
      if (found === undefined) {
        return { problems: [] };
      }
      if (found.length === 0) {
        say(JOURNEY_PREVIEW_SUBMIT_TEXT, target);
        return { problems: [] };
      }
      // Taken to the first page holding one, as a submit takes the person there.
      const view = target.journeyView();
      const errorPage = errorPageOf(found, view);
      if (errorPage !== undefined && errorPage !== view?.pageId && target.goToPage) {
        await target.goToPage(errorPage, { direction: "error" }).catch(() => undefined);
        if (runtime !== target) {
          return { problems: [] };
        }
      }
      say(builderPlural("journey.preview.notSubmitted", found.length, undefined, options.text?.()), target);
      return { problems: describe(found) };
    },
    async check() {
      // Read-only: `validate()` stores its errors and marks the fields, so the checks run on a
      // scratch runtime holding the same answers, and the person's form is left as it was. What
      // is listed is "on the path so far": the pages taken up to this one, and the form's own.
      const target = runtime;
      const shown = subject;
      const scratch = target && shown ? open(shown, typedOf(target)) : undefined;
      const found = target && scratch ? await blocking(target, scratch) : undefined;
      if (!found || !target) {
        return [];
      }
      const view = target.journeyView();
      const soFar = view ? new Set(view.path.slice(0, view.index + 1)) : undefined;
      return describe(
        found.filter((error) => {
          const page = typeof error.componentId === "string" ? view?.pageOf[error.componentId] : undefined;
          return soFar === undefined || typeof error.componentId !== "string" || (page !== undefined && soFar.has(page));
        })
      );
    },
    linkHeld() {
      if (runtime) {
        say(JOURNEY_PREVIEW_LINK_TEXT, runtime);
      }
    },
    card: () => cardHtml(),
    mapState() {
      const view = runtime?.journeyView();
      if (!view) {
        return undefined;
      }
      const trace: JourneyTrace | undefined = runtime?.journeyTrace?.();
      // The preview runs each page under its node id, which is the map's node: the pages and the
      // nodes are one list, read by position (`journey-try-map.ts`).
      const pages = view.journey.pages;
      return tryMapState({ pages, nodes: pages.map((page) => page.id), path: view.path, index: view.index, decisions: trace?.decisions });
    }
  };
}
