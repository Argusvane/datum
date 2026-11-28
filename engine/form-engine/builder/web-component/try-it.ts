/**
 * The Try it panel, as a lazy chunk: while the canvas previews the form, a column of cards on its end
 * edge for testing what was built — the form shown filled in or read only, printed or as a
 * PDF; its answers as a submission carries them; the browser's checks on them, and the
 * server's when the host lends the builder a way to run them (a WebAssembly sandbox, loaded
 * the first time it is turned on); what the form's Submit last did.
 *
 * The markup, the checks, and the controller the canvas makes once the chunk is in (every
 * method that only runs while trying lives here, so the builder's main bundle carries none of it).
 * The seam types are `try-it-types.ts`'s, which stays in the main bundle.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import type { ValidationResult } from "../../core/schema/contracts.js";
import { ENGINE_VALIDATION_CODES, layerValidationMessages, readValidationMessages, resolveValidationMessage, type ValidationMessageCatalog } from "../../core/localization/validation-messages.js";
import { addressOf, resolveText, type TextSources } from "../../core/localization/translations.js";
import { createFieldConstraintsStage } from "../../validation/core/field-constraints.js";
import type { FormError } from "../../core/errors/form-error.js";
import type { BuilderController } from "../controller/builder-controller.js";
import { kernelJsonAnswers, kernelJsonValue } from "../../core/state/submittable-fold.js";
import { buildDataPaths, collectionPathOf, holdsData } from "../../core/tree/data-scope.js";
import { stringifyComponentPath } from "../../core/tree/component-path.js";
import { FormEventType, type PageBlockedEventData, type PageChangedEventData } from "../../core/events/event-types.js";
import type { FormEvent } from "../../core/events/event-bus.js";
import { TRY_SUBMISSION_FAILED_MESSAGE, trySubmissionReference } from "../controller/try-submission.js";
import { esc } from "./builder-shared.js";
import { starterSubmitButton } from "./starter-submit.js";
import type { BuilderWords } from "../logic/builder-texts.js";
import type { CanvasScenarioShowing, TestsAssertField, TestsAssertSnapshot, TestsRecordEvent, TestsRecordListener } from "../form-tests/tests-model.js";
import { areaWords, formatListText } from "./try-texts-en.js";
import type {
  BuilderTrySubmitDetail,
  TryCheckOutcome,
  TryCheckProblem,
  TryItOptions,
  TryItController,
  TryItServerChecks,
  TryPanelView,
  TrySessionPages,
  TrySubmitOutcome,
  TrySubmitStatus,
  TryWasmStatus
} from "./try-it-types.js";

// The view's type is declared beside the seam a mode's cards are drawn from.
export type { TryPanelView } from "./try-it-types.js";

/** The builder's words for the panel's own lines, in the builder's locale and catalog (English when absent). */
export interface TryItWordsOptions {
  words?: () => BuilderWords | undefined;
}

const ENGLISH_WORDS = areaWords();

/** Each given the canvas may leave unapplied, by the word the bar names it with. */
const GIVEN_WORDS = {
  today: "try.showing.given.today",
  locale: "try.showing.given.locale",
  options: "try.showing.given.options"
} as const;

/** A calendar day as `given today` takes it (`YYYY-MM-DD`). */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface CheckAnswersOptions {
  locale: string;
  required: ReadonlyMap<string, boolean>;
  hidden: (id: string) => boolean;
  /**
   * The components whose Validate rule (`rules.validWhen`) does not hold over the
   * tried answers, id -> `true`: the runtime's `invalidMap()`, handed to the same stage the
   * renderer feeds it. Absent, no `validWhen` is read, as for a form with none.
   */
  invalid?: Readonly<Record<string, boolean>>;
  /**
   * The form's `kinds` map (`BuilderController.definitionKinds()`): a plugin's or a binding's type
   * (`gcds-date`) is checked as its base engine type, as the form's runtime and the kernel check it
   * from the saved definition. Absent, such a type is checked as nothing.
   */
  kinds?: Readonly<Record<string, string>> | undefined;
  /** What a label resolves through in {@link checkAnswers} (the form's map, the host's catalog); absent, the authored label. */
  sources?: TextSources;
}

/** Whether a button anywhere in the tree submits the form (`action` `submit`, or `download`, which submits and saves the file). */
export function hasSubmitButton(node: ComponentNode): boolean {
  if (node.type === "button") {
    const action = (node.configuration as { action?: unknown } | undefined)?.action;
    if (action === "submit" || action === "download") {
      return true;
    }
  }
  return Object.values(node.children ?? {}).some((group) => (group ?? []).some((child) => hasSubmitButton(child)));
}

/** The browser's checks on the answers as errors, as the form's field rules make them; those on hidden components are left out. */
export function checkAnswerErrors(root: ComponentNode, answers: Record<string, unknown>, options: CheckAnswersOptions): ValidationResult["errors"] {
  const stage = createFieldConstraintsStage(root);
  const result = stage.validate({
    values: answers,
    formId: "try-it",
    locale: options.locale,
    requiredComponents: Object.fromEntries(options.required),
    invalidComponents: options.invalid,
    ...(options.kinds !== undefined ? { kinds: options.kinds } : {})
  }) as ValidationResult;
  return result.errors.filter((error) => error.componentId === undefined || !options.hidden(error.componentId));
}

/** A collection's entry key (`items[2].sku`) as the entry's index and the field within it; else `undefined`. */
function entryKeyIn(key: string, collectionPath: string): { index: number; field: string } | undefined {
  const at = key.startsWith(collectionPath) ? /^\[(0|[1-9]\d*)\]\.(.+)$/.exec(key.slice(collectionPath.length)) : null;
  return at ? { index: Number(at[1]), field: at[2] as string } : undefined;
}

/** Every collection-bound container of a tree (a data grid, a repeating section): its id and collection path. */
function collectionsIn(node: ComponentNode, found: Array<{ id: string; path: string }> = []): Array<{ id: string; path: string }> {
  const path = collectionPathOf(node);
  if (path !== undefined) {
    found.push({ id: node.id, path });
  }
  for (const children of Object.values(node.children ?? {})) {
    for (const child of children ?? []) {
      collectionsIn(child, found);
    }
  }
  return found;
}

/**
 * The preview's answers as a submission carries them: each collection's
 * drawn rows as one list at its path — a row nothing was typed into as `{}`, since the preview
 * keeps a key per field of a drawn row, `undefined` where empty — and every other answer as
 * kernel JSON. A collection with no row drawn is an empty list when its answers are sent
 * (`submits`), else left out, as the form's runtime posts it. `root` is the builder's tree,
 * whose grids are in the container shape since the controller loaded it.
 */
export function previewSubmissionAnswers(
  root: ComponentNode,
  values: Readonly<Record<string, unknown>>,
  submits: (componentId: string) => boolean
): Record<string, unknown> {
  const collections = collectionsIn(root);
  const rest: Record<string, unknown> = {};
  const lists = new Map<string, Record<string, unknown>[]>();
  for (const key of Object.keys(values)) {
    const value = values[key];
    let entry: { index: number; field: string } | undefined;
    const owner = collections.find((collection) => (entry = entryKeyIn(key, collection.path)) !== undefined);
    if (!owner || !entry) {
      rest[key] = value;
      continue;
    }
    const rows = lists.get(owner.path) ?? [];
    lists.set(owner.path, rows);
    while (rows.length <= entry.index) {
      rows.push({});
    }
    if (value !== undefined) {
      (rows[entry.index] as Record<string, unknown>)[entry.field] = value;
    }
  }
  // A record with no prototype (kernel JSON's), so `in` asks for its own keys only.
  const out = kernelJsonAnswers(rest);
  for (const collection of collections) {
    const rows = lists.get(collection.path);
    if (rows !== undefined || (submits(collection.id) && !(collection.path in out))) {
      out[collection.path] = kernelJsonValue(rows ?? []);
    }
  }
  return out;
}

/**
 * The preview's answers as the browser's checks read them, the form's runtime's way:
 * flat keys as kernel JSON, a drawn row's empty keys kept, so the row is counted against the
 * grid's bounds and its cells are checked.
 */
export function previewCheckedAnswers(root: ComponentNode, values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out = kernelJsonAnswers(values as Record<string, unknown>);
  const collections = collectionsIn(root);
  for (const key of Object.keys(values)) {
    if (values[key] === undefined && collections.some((collection) => entryKeyIn(key, collection.path) !== undefined)) {
      out[key] = undefined;
    }
  }
  return out;
}

/**
 * What the form's own texts resolve through while it is tried: the form's map from
 * its controller, then the host's catalog. Without a controller there is nothing to resolve
 * through and a label reads in the default language.
 */
function textSourcesOf(controller: BuilderController | undefined): TextSources {
  return controller ? { translations: controller.translations(), catalog: controller.translationCatalog() } : {};
}

/**
 * The form's `kinds` map as the host saves it: the controller's catalogue over the opened file's own
 * entries (`openedKinds`), so Try it, locally and in its server request, checks a type as the saved
 * file, the runtime and a server do, a type only the file names a base for included.
 */
function formKinds(controller: BuilderController | undefined): Record<string, string> | undefined {
  return controller?.definitionKinds(controller.openedKinds?.());
}

/** A component's label in the preview language: its translation if the sources hold one, else the authored label. */
function labelIn(node: ComponentNode, locale: string, sources: TextSources): string {
  const label = (node.configuration as { label?: unknown } | undefined)?.label;
  return typeof label === "string" ? resolveText(label, addressOf.component(node.id, "label"), locale, sources) : "";
}

/** The browser's checks on the answers, worded for the panel. */
export function checkAnswers(root: ComponentNode, answers: Record<string, unknown>, options: CheckAnswersOptions): TryCheckProblem[] {
  return describeProblems(root, checkAnswerErrors(root, answers, options), options.locale, ENGLISH_WORDS, options.sources);
}

/** Errors (the browser's or the server's) as the panel says them: the component's label, the form's own wording for the code. */
export function describeProblems(
  root: ComponentNode,
  errors: ValidationResult["errors"],
  locale: string,
  given: BuilderWords = ENGLISH_WORDS,
  sources: TextSources = {}
): TryCheckProblem[] {
  const words = areaWords(given);
  const catalog = readValidationMessages(root.configuration);
  const labels = new Map<string, string>();
  // As the renderer words an error: the component's own messages (and its patternMessage) over its containers' over the form's.
  const catalogs = new Map<string, ValidationMessageCatalog | undefined>();
  const walk = (node: ComponentNode, inherited?: ValidationMessageCatalog): void => {
    const layered = layerValidationMessages(readValidationMessages(node.configuration), inherited);
    catalogs.set(node.id, layered);
    const label = labelIn(node, locale, sources);
    labels.set(node.id, label && label.trim() ? label.trim() : node.id);
    for (const children of Object.values(node.children ?? {})) {
      for (const child of children) {
        walk(child, layered);
      }
    }
  };
  walk(root);
  return errors.map((error) => {
    const message = resolveValidationMessage(error, (error.componentId !== undefined ? catalogs.get(error.componentId) : undefined) ?? catalog, locale, sources);
    // Nothing words the code (the page's catalog does that for the live form): the engine's description of it.
    const described = message === error.code ? ENGINE_VALIDATION_CODES.find((entry) => entry.code === error.code)?.label : undefined;
    return {
      componentId: error.componentId,
      label: error.componentId !== undefined ? (labels.get(error.componentId) ?? error.componentId) : words.text("try.theForm"),
      message: described ?? message
    };
  });
}

function problemsHtml(problems: TryCheckProblem[] | undefined, none: string): string {
  if (problems === undefined) {
    return "";
  }
  if (problems.length === 0) {
    return `<p class="try-ok">${esc(none)}</p>`;
  }
  return `<ul class="try-problems">${problems
    .map(
      (problem) =>
        `<li>${
          problem.componentId !== undefined
            ? `<button type="button" class="try-problem" data-try-goto="${esc(problem.componentId)}"><strong>${esc(problem.label)}</strong> ${esc(problem.message)}</button>`
            : `<span class="try-problem"><strong>${esc(problem.label)}</strong> ${esc(problem.message)}</span>`
        }</li>`
    )
    .join("")}</ul>`;
}

function timeHtml(at: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `<time datetime="${esc(at.toISOString())}">${esc(time)}</time>`;
}

/** The Last submit line: what the form's Submit last did. */
function submitHtml(submit: TrySubmitStatus, words: BuilderWords): string {
  switch (submit.state) {
    case "none":
      return esc(words.text("try.submit.none"));
    case "submitting":
      return esc(words.text("try.submit.submitting"));
    case "accepted":
      return words.html("try.submit.accepted", {
        reference: submit.reference ? esc(words.text("try.submit.reference", { reference: submit.reference })) : "",
        time: timeHtml(submit.at)
      });
    case "refused":
      return words.html("try.submit.refused", { time: timeHtml(submit.at) });
    case "failed":
      return words.html("try.submit.failed", { time: timeHtml(submit.at) });
    case "invalid":
      return words.html("try.submit.invalid", { problems: esc(words.plural("problems.count", submit.count)), time: timeHtml(submit.at) });
  }
}

/** The WebAssembly validation part of Checks: its toggle, where it stands, Try again after a failed load. */
function wasmHtml(server: TryPanelView["server"], words: BuilderWords): string {
  const status = server.status;
  const checked = server.on || status === "loading";
  const disabled = status === "none" || status === "loading";
  const said =
    status === "none"
      ? words.text("try.wasm.none")
      : status === "idle"
        ? words.text("try.wasm.idle")
        : status === "loading"
          ? words.text("try.wasm.loading")
          : status === "ready"
            ? words.text("try.wasm.ready", { label: server.label })
            : words.text("try.wasm.failed", { reason: server.reason ?? words.text("try.wasm.didNotLoad") });
  return `
      <div class="try-wasm" role="group" aria-labelledby="try-wasm-title" data-try-wasm="${status}">
        <p class="try-subtitle" id="try-wasm-title">${esc(words.text("try.wasm.title"))}</p>
        <label class="try-toggle"><input type="checkbox" data-try-server aria-describedby="try-wasm-status"${checked ? " checked" : ""}${disabled ? " disabled" : ""}${
          status === "loading" ? ' aria-busy="true"' : ""
        }> ${esc(words.text("try.wasm.toggle"))}</label>
        <p class="${status === "failed" ? "try-error" : "try-note"}" id="try-wasm-status" data-try-wasm-status aria-live="polite">${esc(said)}</p>
        ${status === "failed" ? `<div class="try-actions"><button type="button" class="btn" data-try-wasm-retry>${esc(words.text("try.wasm.retry"))}</button></div>` : ""}
      </div>`;
}

/** Preview PDF, busy while it renders; `primary` on the PDF card, where it is the card's point. */
function pdfButtonHtml(view: TryPanelView, primary: boolean, words: BuilderWords): string {
  return `<button type="button" class="btn${primary ? " primary" : ""}" data-try-pdf${view.pdfBusy ? ' aria-busy="true" disabled' : ""}>${esc(words.text(view.pdfBusy ? "try.pdf.rendering" : "try.pdf.preview"))}</button>`;
}

/** The typed answers the PDF will print, in the PDF preview dialog's words. */
function typedAnswersText(count: number, words: BuilderWords): string {
  return count === 0 ? words.text("try.answers.none") : words.plural("try.answers", count);
}

/** Clear answers empties the one set of answers every workspace tries with. */
function clearAnswersHtml(words: BuilderWords): string {
  return `<button type="button" class="btn" data-try-clear>${esc(words.text("try.clear"))}</button>`;
}

/** The PDF card a mode's workspace leads with: the open layout, Preview PDF, the answers it will print. */
function pdfCardHtml(view: TryPanelView, label: string, words: BuilderWords): string {
  return `
    <section class="try-card" aria-labelledby="try-pdf-title" data-try-pdf-card>
      <h3 class="try-title" id="try-pdf-title">${esc(words.text("try.pdf.title"))}</h3>
      <p class="try-note" data-try-pdf-label>${esc(label)}</p>
      <div class="try-actions">${pdfButtonHtml(view, true, words)}${clearAnswersHtml(words)}</div>
      <p class="try-note" data-try-answered>${typedAnswersText(view.answered ?? 0, words)}</p>
      ${view.pdfError ? `<p class="try-error" role="alert">${esc(view.pdfError)}</p>` : ""}
    </section>`;
}

/** Puts the results sheet's grabber in step with the shell: its height and its words ride on attributes of the canvas host (the panel is redrawn from here, so they are read on every draw). */
function syncTryGrab(panel: HTMLElement): void {
  const host = (panel.getRootNode() as ShadowRoot).host;
  const grab = panel.querySelector<HTMLElement>("[data-try-grab]");
  if (!host || !grab) {
    return;
  }
  const tall = host.hasAttribute("data-results-tall");
  grab.setAttribute("aria-expanded", String(tall));
  const label = host.getAttribute(tall ? "data-grab-label-tall" : "data-grab-label");
  if (label) {
    grab.setAttribute("aria-label", label);
  }
}

/**
 * What the panel draws beyond the seam's view: whether the form being tried has no Submit button,
 * so the panel says so and offers to add one. Kept here, with the chunk, so the seam
 * types the main bundle carries stay as they were.
 */
export type TryPanelDrawn = TryPanelView & { noSubmit?: boolean | undefined };

/** The notice for a form nobody can submit, with the one-step way to add the button (see `addSubmitButton`). */
function noSubmitHtml(words: BuilderWords): string {
  return `
    <section class="try-card try-warning" role="status" data-try-no-submit>
      <p class="try-note try-warning-text">${esc(words.text("try.noSubmit.message"))}</p>
      <div class="try-actions"><button type="button" class="btn" data-try-add-submit>${esc(words.text("try.noSubmit.add"))}</button></div>
    </section>`;
}

export function tryPanelHtml(view: TryPanelDrawn, given: BuilderWords = ENGLISH_WORDS): string {
  const words = areaWords(given);
  const server = view.server;
  // With a PDF card, Preview PDF and Clear answers are its own; Show the form keeps Print.
  const pdfCard = view.pdfCard !== undefined && view.pdf;
  return `
    <div class="try-sheet-head">
      <h2 class="try-sheet-title" tabindex="-1" data-try-sheet-title>${esc(words.text("try.title"))}</h2>
      <button type="button" class="try-grab" data-try-grab aria-expanded="false" aria-label="${esc(words.text("try.grab"))}"></button>
      <button type="button" class="try-close" data-try-close aria-label="${esc(words.text("try.close"))}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>
    </div>
    ${pdfCard ? pdfCardHtml(view, view.pdfCard!, words) : ""}${view.modeCards ?? ""}
    <section class="try-card" aria-labelledby="try-show-title">
      <h3 class="try-title" id="try-show-title">${esc(words.text("try.show.title"))}</h3>
      <div class="seg try-modes" role="radiogroup" aria-labelledby="try-show-title">
        <button type="button" role="radio" data-try-mode="interactive" aria-checked="${view.mode === "interactive"}">${esc(words.text("try.mode.fill"))}</button>
        <button type="button" role="radio" data-try-mode="readonly" aria-checked="${view.mode === "readonly"}">${esc(words.text("try.mode.readonly"))}</button>
      </div>
      <div class="try-actions">
        <button type="button" class="btn" data-try-print>${esc(words.text("try.print"))}</button>
        ${view.pdf && !pdfCard ? pdfButtonHtml(view, false, words) : ""}${view.answered !== undefined && !pdfCard ? clearAnswersHtml(words) : ""}
      </div>
      ${view.pdfError && !pdfCard ? `<p class="try-error" role="alert">${esc(view.pdfError)}</p>` : ""}
    </section>
    ${view.noSubmit ? noSubmitHtml(words) : ""}
    <section class="try-card" aria-labelledby="try-submit-title">
      <h3 class="try-title" id="try-submit-title">${esc(words.text("try.submit.title"))}</h3>
      <p class="try-submit" data-try-submit="${view.submit.state}" role="status" aria-live="polite">${submitHtml(view.submit, words)}</p>
      <p class="try-note">${esc(words.text("try.submit.settings"))}</p>
    </section>
    <section class="try-card" aria-labelledby="try-checks-title">
      <div class="try-head"><h3 class="try-title" id="try-checks-title">${esc(words.text("try.checks.title"))}</h3><button type="button" class="btn" data-try-check>${esc(words.text("try.checks.now"))}</button></div>
      <label class="try-toggle"><input type="checkbox" data-try-live${view.live ? " checked" : ""}> ${esc(words.text("try.checks.live"))}</label>
      ${wasmHtml(server, words)}
      <div class="try-results" aria-live="polite" data-try-results>
        ${view.problems !== undefined ? `<p class="try-subtitle">${esc(words.text("try.browser"))}</p>${problemsHtml(view.problems, words.text("try.noProblems"))}` : ""}
        ${
          server.on
            ? server.busy
              ? `<p class="try-subtitle">${esc(words.text("try.server"))}</p><p class="try-note">${esc(words.text("try.server.checking"))}</p>`
              : server.failure
                ? `<p class="try-subtitle">${esc(words.text("try.server"))}</p><p class="try-error">${esc(server.failure)}</p>`
                : server.problems !== undefined
                  ? `<p class="try-subtitle">${esc(words.text("try.server"))}</p>${problemsHtml(server.problems, words.text("try.server.ok"))}`
                  : ""
            : ""
        }
      </div>
    </section>
    <section class="try-card try-card--data" aria-labelledby="try-data-title">
      <div class="try-head"><h3 class="try-title" id="try-data-title">${esc(words.text("try.data.title"))}</h3><button type="button" class="btn" data-try-copy>${esc(words.text("try.copy"))}</button></div>
      <p class="try-note">${esc(words.text("try.data.note"))}</p>
      <pre class="try-data" data-try-data tabindex="0" aria-labelledby="try-data-title">${esc(view.answers)}</pre>
    </section>`;
}


/** Where Try it's WebAssembly validator stands, with the checks once loaded and the load in flight. */
interface TryWasmState {
  status: TryWasmStatus;
  checks?: TryItServerChecks | undefined;
  reason?: string | undefined;
  loading?: Promise<TryItServerChecks | undefined> | undefined;
}

/** What Record reads a tree by: where each answer is stored, and which components' values are worked out. */
interface TryRecordIndex {
  /** Each value-bearing field, in the tree's order (Assert this lists them so). */
  fields: ComponentNode[];
  /** Component id -> its data path, a repeating section's entries marked `[]` (`items[].sku`). */
  dataPaths: Map<string, string>;
  /** Collection path -> the repeating section's (or data grid's) component id. */
  collections: Map<string, string>;
  /** Components whose value a calculation sets (`rules.value`): nobody's answer. */
  calculated: Set<string>;
  /** The component a value path (`items[0].sku`, `billing.street`) is the answer of. */
  byPath(path: string): string | undefined;
}

/** One recording over one runtime: its listener, what it last reported and held back, and how to let go. */
interface TryRecorder {
  listener: TestsRecordListener;
  runtime: {
    events(): { subscribe(type: string, listener: (event: FormEvent) => void): () => void };
    state(): { values: unknown };
    formRoot(): ComponentNode;
    journeyView?(): { members: string[]; pageOf: Record<string, string> } | undefined;
  };
  index: TryRecordIndex;
  /** Value path -> the last value reported (or found when the recording started), as compared. */
  seen: Map<string, string>;
  /** Collection path -> its row count when last seen. */
  rows: Map<string, number>;
  /** Value path -> component id: answers written and not settled yet. */
  pending: Map<string, string>;
  /** Set while a Submit is in flight: what settles meanwhile waits so it is written after `submit`. */
  held?: TestsRecordEvent[] | undefined;
  stop: () => void;
}

function recordIndex(root: ComponentNode): TryRecordIndex {
  const dataPaths = buildDataPaths(root);
  const byDataPath = new Map<string, string>();
  for (const [id, path] of dataPaths) {
    if (!byDataPath.has(path)) {
      byDataPath.set(path, id);
    }
  }
  const fields: ComponentNode[] = [];
  const collections = new Map<string, string>();
  const calculated = new Set<string>();
  const walk = (node: ComponentNode): void => {
    const collection = collectionPathOf(node);
    if (collection !== undefined) {
      collections.set(collection, node.id);
    } else if (node !== root && node.children === undefined && holdsData(node)) {
      fields.push(node);
    }
    if (node.rules?.value !== undefined) {
      calculated.add(node.id);
    }
    for (const children of Object.values(node.children ?? {})) {
      for (const child of children ?? []) {
        walk(child);
      }
    }
  };
  walk(root);
  return {
    fields,
    dataPaths,
    collections,
    calculated,
    // A row's index is the engine's (`items[2].sku`); the tree knows the entry's field as `items[].sku`.
    byPath: (path) => byDataPath.get(path.replace(/\[\d+\]/g, "[]"))
  };
}

/** The value path an event is about: the preview names it as `componentId`, `FormRuntime` as a parsed `path`. */
function eventKey(event: FormEvent): string | undefined {
  if (event.path !== undefined) {
    return stringifyComponentPath(event.path);
  }
  return event.componentId;
}

/** A value as Record compares it: JSON, `undefined` its own word, so an untouched field and a cleared one are told apart from "". */
function settledKey(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value) ?? "undefined";
}

/** An answer that says nothing: what `clear` writes (a box emptied, every box of a group unticked, no pick). */
function isEmptyAnswer(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    const entries = Object.values(value as Record<string, unknown>);
    return entries.length > 0 && entries.every((entry) => entry === false);
  }
  return false;
}

/**
 * Each row of a collection as one comparable string, from values already compared as
 * {@link settledKey} gives them. `answered` leaves out a calculation's keys: Record never
 * reports them, so their last seen value is stale and would point at the wrong row.
 */
function rowSignatures(compared: ReadonlyMap<string, string>, path: string, count: number, answered: (key: string) => boolean): string[] {
  const rows: string[][] = Array.from({ length: count }, () => []);
  for (const [key, value] of compared) {
    if (!key.startsWith(`${path}[`) || !answered(key)) {
      continue;
    }
    const close = key.indexOf("]", path.length + 1);
    const index = Number(key.slice(path.length + 1, close));
    if (Number.isInteger(index) && index >= 0 && index < count) {
      (rows[index] as string[]).push(`${key.slice(close + 1)}=${value}`);
    }
  }
  return rows.map((row) => row.sort().join("|"));
}

/** How many rows a collection has: the runtime's own count when it keeps one (`FormRuntime.rows`), else the entries its answers hold a key for. */
function rowCount(runtime: { state(): { values: unknown } }, path: string): number {
  const own = (runtime as { rows?: (path: string) => unknown[] }).rows;
  if (typeof own === "function") {
    try {
      return own.call(runtime, path).length;
    } catch {
      /* not a collection it knows: counted from the answers */
    }
  }
  const values = runtime.state().values as Record<string, unknown>;
  let count = Array.isArray(values[path]) ? (values[path] as unknown[]).length : 0;
  const prefix = `${path}[`;
  for (const key of Object.keys(values)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const close = key.indexOf("]", prefix.length);
    const index = Number(key.slice(prefix.length, close));
    if (close > prefix.length && Number.isInteger(index) && index + 1 > count) {
      count = index + 1;
    }
  }
  return count;
}

/**
 * The Try it panel's logic, lifted out of the canvas so it loads with the
 * first Try it. The canvas makes one when the chunk is in and lends it what it owns
 * (the renderer, the preview, the controller, what a host lent) as functions, so none of it goes
 * stale; the state the panel keeps (live checks, the validator, the last submit) lives here.
 */
export function createTryIt(options: TryItOptions & TryItWordsOptions): TryItController {
  /** The builder's words, read on every use so a later catalog reaches a panel already made. */
  const words = (): BuilderWords => areaWords(options.words?.() ?? ENGLISH_WORDS);
  let live = false;
  let problems: TryCheckProblem[] | undefined;
  let server: { on: boolean; busy: boolean; problems?: TryCheckProblem[] | undefined; failure?: string | undefined } = { on: false, busy: false };
  let pdfBusy = false;
  let pdfError: string | undefined;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  /** The WebAssembly validator: none lent, a loader not called yet, loading, ready (kept), or failed. */
  let wasm: TryWasmState = startingWasm();
  let submitStatus: TrySubmitStatus = { state: "none" };
  let submitRun: object | undefined;
  /** The Submit in flight already has its line (a recording that ended or moved runtimes meanwhile wrote it). */
  let submitLined = false;
  /** Show me's step control in the canvas bar while a showing is drawn; see `syncShowing`. */
  let showingEl: HTMLElement | undefined;
  /** Record's control in the canvas bar while the canvas records; see `syncRecordingBar`. */
  let recordingEl: HTMLElement | undefined;
  /** The recording in progress, over the runtime tried when it started or last followed; see `syncRecording`. */
  let recorder: TryRecorder | undefined;

  function startingWasm(): TryWasmState {
    const value = options.serverChecks();
    return value === undefined ? { status: "none" } : typeof value === "function" ? { status: "idle" } : { status: "ready", checks: value };
  }

  /** The answers as a submission carries them: what the Try it panel shows and checks. */
  const answers = (): Record<string, unknown> => {
    // A mode's session runs the form its own way (a journey's submittable values).
    const session = options.session?.();
    if (session) {
      return session.answers();
    }
    const preview = options.preview();
    if (!preview) {
      return {};
    }
    // Rows as one list each, as the form posts them.
    const states = preview.effectiveStatesMap();
    return previewSubmissionAnswers(preview.formRoot(), preview.state().values as Record<string, unknown>, (id) => {
      const state = states.get(id);
      return state === undefined || (state.submitValue && !state.clearValue);
    });
  };

  /** The answers that say something: what "N answers tried" counts (the journey's own "@" keys aside). */
  const answeredCount = (): number => {
    // Typed answers only (the store's dirty keys): a calculation's or a default's value is nobody's answer.
    const dirty = triedRuntime()?.state().dirty;
    // A collection's rows are one list: typed when one of its entries was.
    const typed = (key: string): boolean => dirty === undefined || dirty.has(key) || [...dirty].some((path) => path.startsWith(`${key}[`));
    return Object.entries(answers()).filter(
      ([key, value]) => !key.startsWith("@") && typed(key) && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0)
    ).length;
  };

  /** The runtime the renderer draws while trying: the mode's session's, else the canvas's preview. */
  const triedRuntime = () => options.session?.()?.runtime ?? options.preview();

  /** Errors on the form being tried, through whichever runtime draws it (a session's may take none). */
  const putErrors = (errors: FormError[]): void => {
    const session = options.session?.();
    if (session) {
      (session.runtime as { setErrors?(errors: FormError[]): unknown }).setErrors?.(errors);
      return;
    }
    options.preview()?.setErrors(errors);
  };

  const panelOf = (): HTMLElement | null => options.root().querySelector<HTMLElement>("[data-try-panel]");

  /**
   * The form tried, when it is the form's own tree: the form's controller in the Form workspace, none in a
   * designer's or a host mode's, whose Submit is its own affair (a journey's last page submits).
   */
  const submitController = (): BuilderController | undefined => {
    const workspace = options.workspace?.();
    if (options.builderMode?.() !== undefined || (workspace !== undefined && workspace !== "form")) {
      return undefined;
    }
    return options.trySettings() ?? options.controller();
  };

  /** Whether the form on the canvas has no button that submits it: nobody could send what it collects. */
  function formHasNoSubmit(): boolean {
    const controller = submitController();
    return controller !== undefined && !hasSubmitButton(controller.snapshot()) && !opensAsJourney();
  }

  /**
   * Whether the form opens as a journey, asked of the shell, which holds the journeys' block. A
   * journey draws its own Submit on the last page, so the root tree lacking one says nothing then.
   */
  function opensAsJourney(): boolean {
    const answer = { journey: false };
    options.canvas.dispatchEvent(new CustomEvent("builder-query-opens-as-journey", { detail: answer }));
    return answer.journey;
  }

  /** The notice's Add: one Submit button at the end of the form, one undo step, past the unsaved-edits guard. */
  function addSubmitButton(): void {
    const controller = submitController();
    if (controller) {
      const { id, configuration } = starterSubmitButton();
      controller.requestAdd("button", undefined, undefined, { id, configuration: configuration as Record<string, unknown> });
      // The panel is drawn when Try it starts and on what it handles itself: the notice goes now the button is there.
      render();
    }
  }

  /**
   * The bar's step control while the canvas shows a test's step: in the
   * canvas bar, before Back to editing, with the bar's
   * "Previewing" giving it the room (`data-try-showing-on`, see the styles). Made once per
   * showing and updated in place, so the label's live region reads a step change out and a
   * focused Step button keeps its focus. Drawn whether or not the panel is on show (a surface
   * that hides the panel still has the bar); gone with the showing.
   */
  function syncShowing(): void {
    const showing = options.showing?.();
    // Nothing shown and nothing drawn: the canvas's DOM is not touched (Try it without Show me draws as it always did).
    if (!showing && !showingEl) {
      return;
    }
    const root = options.root();
    const active = (root as ShadowRoot).activeElement as HTMLElement | null;
    if (!showing) {
      const slot = showingEl!;
      showingEl = undefined;
      const bar = slot.parentElement;
      // Focus on a control that goes lands on Back to editing, beside where it was, not on the page.
      const hadFocus = active !== null && slot.contains(active);
      slot.remove();
      bar?.removeAttribute("data-try-showing-on");
      if (hadFocus) {
        bar?.querySelector<HTMLElement>("[data-try-it]")?.focus();
      }
      return;
    }
    const bar = root.querySelector<HTMLElement>("[data-canvas-bar]");
    if (!bar) {
      return;
    }
    // A showing that starts takes the focus: Show me's button went with the side column. A bar built again does not.
    const starting = !showingEl;
    if (!showingEl || showingEl.parentElement !== bar) {
      // A canvas whose bar was built again (another controller's first paint) gets a fresh control.
      showingEl?.remove();
      showingEl = showingSlot(bar);
    }
    const given = words();
    const made = showingEl;
    bar.setAttribute("data-try-showing-on", "");
    const params = { step: showing.step, steps: showing.steps, name: showing.name, ...(showing.page !== undefined ? { page: showing.page } : {}) };
    const label = given.text(showing.page !== undefined ? "try.showing.page" : "try.showing.label", params);
    // A replay that could not run is the panel's to word (it keeps the last state shown); the bar says it after the label.
    const note = (showing as CanvasScenarioShowing & { note?: unknown }).note;
    // The givens the canvas could not apply are its to name: a sentence after the panel's note.
    const unapplied = options.showingUnapplied?.() ?? [];
    const notes = [
      ...(typeof note === "string" && note.trim() !== "" ? [note] : []),
      ...(unapplied.length > 0
        ? [given.text("try.showing.notApplied", { givens: formatListText(unapplied.map((key) => given.text(GIVEN_WORDS[key])), { ...given.options(), type: "conjunction" }) })]
        : [])
    ];
    const text = [label, ...notes].join(" · ");
    const status = made.querySelector<HTMLElement>("[data-try-showing-label]")!;
    if (status.textContent !== text) {
      status.textContent = text;
    }
    // The label gives way first in a narrow bar: its whole text stays a hover away.
    status.title = text;
    const back = made.querySelector<HTMLButtonElement>('[data-try-step="-1"]')!;
    const forward = made.querySelector<HTMLButtonElement>('[data-try-step="1"]')!;
    const stop = made.querySelector<HTMLButtonElement>("[data-try-show-stop]")!;
    back.disabled = showing.step <= 1;
    forward.disabled = showing.step >= showing.steps;
    back.setAttribute("aria-label", given.text("try.showing.back"));
    forward.setAttribute("aria-label", given.text("try.showing.forward"));
    const stepWord = esc(given.text("try.showing.step"));
    const backHtml = `${chevronSvg("M15 18l-6-6 6-6")}<span>${stepWord}</span>`;
    const forwardHtml = `<span>${stepWord}</span>${chevronSvg("M9 18l6-6-6-6")}`;
    if (back.innerHTML !== backHtml) {
      back.innerHTML = backHtml;
    }
    if (forward.innerHTML !== forwardHtml) {
      forward.innerHTML = forwardHtml;
    }
    const stopText = given.text("try.showing.stop");
    if (stop.textContent !== stopText) {
      stop.textContent = stopText;
    }
    // A Step button that reached its end and had focus hands it to its neighbour, so the keyboard is never dropped on the page.
    if (active === back && back.disabled) {
      (forward.disabled ? stop : forward).focus();
    } else if (active === forward && forward.disabled) {
      (back.disabled ? stop : back).focus();
    } else if (starting) {
      (!forward.disabled ? forward : !back.disabled ? back : stop).focus();
    }
  }

  /** The step control's shell, put before Back to editing; its clicks go through {@link click}, as the panel's do. */
  function showingSlot(bar: HTMLElement): HTMLElement {
    const slot = document.createElement("span");
    slot.className = "try-showing";
    slot.setAttribute("data-try-showing", "");
    slot.innerHTML =
      '<span class="try-showing-dot" aria-hidden="true"></span>' +
      '<span class="try-showing-text" data-try-showing-label role="status" aria-live="polite"></span>' +
      '<button type="button" class="try-showing-btn" data-try-step="-1"></button>' +
      '<button type="button" class="try-showing-btn" data-try-step="1"></button>' +
      '<button type="button" class="try-showing-btn try-showing-stop" data-try-show-stop></button>';
    // The canvas routes only the panel's clicks to the chunk; the bar's own are taken here.
    slot.addEventListener("click", (event) => click(event.composedPath() as HTMLElement[]));
    bar.insertBefore(slot, bar.querySelector("[data-try-it]"));
    return slot;
  }

  /** The canvas's showing came, moved or went: the bar's control follows (the panel's cards do not depend on it). */
  function showingChanged(): void {
    syncShowing();
  }

  // --- Record and Assert this ------------------------------------------

  /**
   * Follows the canvas's recording: a listener that went has what was held back sent to it and
   * its runtime let go; a listener that came (or a runtime that took over, a journey's arriving
   * over the preview) is subscribed, the answers as they stand taken as where the lines start.
   */
  function syncRecording(): void {
    const listener = options.recording?.();
    const runtime = listener ? triedRuntime() : undefined;
    if (recorder && (recorder.listener !== listener || recorder.runtime !== runtime)) {
      const ending = recorder;
      flushRecording();
      // A Submit pressed and not answered yet is still a line, before what settled after it.
      release(ending, { kind: "submit", accepted: false });
      ending.stop();
      recorder = undefined;
      if (ending.listener === listener && runtime) {
        // The same recording over another runtime: it carries on from what that one holds.
        recorder = startRecorder(listener, runtime);
        return;
      }
    }
    if (listener && runtime && !recorder) {
      recorder = startRecorder(listener, runtime);
    }
  }

  /**
   * Subscribes a recording to a runtime's settled events. A write the runtime marks
   * interim (a keystroke) is held until the control is left (`COMPONENT_COMMITTED`, or focus
   * leaving a control of the form), another field is written, or anything else happens; the
   * builder's preview marks none and commits nothing, so every write of its is held that way.
   * A calculation's or a default's value is nobody's answer: no line for a component whose
   * `rules.value` sets it. A value equal to the last one reported (or the starting one) is no line.
   */
  function startRecorder(listener: TestsRecordListener, runtime: NonNullable<ReturnType<typeof triedRuntime>>): TryRecorder {
    const root = runtime.formRoot();
    const index = recordIndex(root);
    const values = runtime.state().values as Record<string, unknown>;
    const seen = new Map<string, string>();
    for (const [key, value] of Object.entries(values)) {
      seen.set(key, settledKey(value));
    }
    const rows = new Map<string, number>();
    for (const path of index.collections.keys()) {
      rows.set(path, rowCount(runtime, path));
    }
    const made: TryRecorder = { listener, runtime, index, seen, rows, pending: new Map(), stop: () => undefined };
    const bus = runtime.events();
    const offs = [
      bus.subscribe(FormEventType.COMPONENT_CHANGED, (event) => recordChange(made, event)),
      bus.subscribe(FormEventType.COMPONENT_COMMITTED, (event) => {
        const key = eventKey(event);
        if (key !== undefined && made.pending.has(key)) {
          made.pending.delete(key);
          settle(made, key, index.byPath(key));
        }
      }),
      bus.subscribe(FormEventType.PAGE_CHANGED, (event) => recordPage(made, event.data as PageChangedEventData | undefined)),
      bus.subscribe(FormEventType.PAGE_BLOCKED, (event) => {
        // A Continue the page's checks held back is a `continue` too: the test's next lines read the errors it showed.
        const reason = (event.data as PageBlockedEventData | undefined)?.reason;
        if (reason === "validation" || reason === "server" || reason === "server-unavailable" || reason === "warnings") {
          emit(made, { kind: "continue" });
        }
      })
    ];
    // Leaving a control is the person done with it, on a runtime that says so itself or not. A
    // repaint that puts focus back into a control of the same answer (the canvas's preview
    // repaints on every write) is no leave: focus entering another control settles the rest at
    // once, and focus going out is read a tick later, once the repaint has put it back or not
    // (two ticks when it is on nothing, for a theme that puts it back a task late).
    const renderer = options.renderer();
    const focusRoot: Node | undefined = renderer?.shadowRoot ?? renderer;
    let leaving: ReturnType<typeof setTimeout> | undefined;
    const entered = (event: Event): void => {
      const key = focusedKey(event.composedPath(), renderer);
      flushPending(made, key);
    };
    const check = (again: boolean): void => {
      leaving = undefined;
      const key = activeKey(renderer);
      // Focus on nothing may be a theme's yet to come back: a custom element drawn afresh around
      // the kept control (a gcds-fieldset) has it put back on a task of its own, queued after
      // this one. Read once more on the next task; focus elsewhere on the page is a leave now.
      if (key === undefined && !again && focusOnNothing(renderer)) {
        leaving = setTimeout(() => check(true), 0);
        return;
      }
      flushPending(made, key !== undefined && made.pending.has(key) ? key : undefined);
    };
    const left = (): void => {
      if (leaving === undefined) {
        leaving = setTimeout(() => check(false), 0);
      }
    };
    focusRoot?.addEventListener("focusin", entered);
    focusRoot?.addEventListener("focusout", left);
    // A leave dispatched at the renderer itself does not reach its shadow root's listeners.
    if (renderer && focusRoot !== renderer) {
      renderer.addEventListener("focusout", left);
    }
    made.stop = () => {
      for (const off of offs) {
        off();
      }
      if (leaving !== undefined) {
        clearTimeout(leaving);
        leaving = undefined;
      }
      focusRoot?.removeEventListener("focusin", entered);
      focusRoot?.removeEventListener("focusout", left);
      renderer?.removeEventListener("focusout", left);
      // The end of a recording settles what it held back (the callers have flushed already, as a rule).
      flushPending(made);
    };
    return made;
  }

  /**
   * The answer a focused element writes: its value path (`data-value-path`, else its component
   * id, as the renderer reads it), a composite part's (`data-value-part`) its group's. The first
   * element of `path` (a focus event's composed path, innermost first) inside the renderer that
   * names one: a theme's control drawn as a custom element is named by its host.
   */
  function focusedKey(path: EventTarget[], renderer: HTMLElement | undefined): string | undefined {
    for (const target of path) {
      if (target === renderer || target === renderer?.shadowRoot) {
        return undefined;
      }
      if (!(target instanceof HTMLElement)) {
        continue;
      }
      const part = target.dataset.valuePart !== undefined ? (target.closest("[data-compose]") as HTMLElement | null) : null;
      // The renderer names the field's wrapper (the DOM contract), not the control inside it.
      const owner = part ?? (target.closest<HTMLElement>("[data-value-path], [data-component-id]") ?? target);
      const key = owner.dataset.valuePath ?? owner.dataset.componentId;
      if (key !== undefined) {
        return key;
      }
    }
    return undefined;
  }

  /** The answer of the control focus is in inside the renderer, through nested shadow roots; none when focus is outside it. */
  function activeKey(renderer: HTMLElement | undefined): string | undefined {
    const chain: EventTarget[] = [];
    let active = renderer?.shadowRoot?.activeElement ?? null;
    while (active) {
      chain.unshift(active);
      active = active.shadowRoot?.activeElement ?? null;
    }
    return chain.length > 0 ? focusedKey(chain, renderer) : undefined;
  }

  /** Focus nowhere: not inside the renderer, and on the page's body (or nothing) rather than another element. */
  function focusOnNothing(renderer: HTMLElement | undefined): boolean {
    if (!renderer || renderer.shadowRoot?.activeElement) {
      return false;
    }
    const active = renderer.ownerDocument.activeElement;
    return active === null || active === renderer.ownerDocument.body;
  }

  /** One `COMPONENT_CHANGED`: a row added or removed at once, an answer held or settled. */
  function recordChange(made: TryRecorder, event: FormEvent): void {
    const key = eventKey(event);
    if (key === undefined || key.startsWith("@")) {
      return;
    }
    if (made.index.collections.has(key)) {
      flushPending(made);
      recordRows(made, key);
      return;
    }
    const componentId = made.index.byPath(key);
    if (componentId === undefined || made.index.calculated.has(componentId)) {
      return;
    }
    // Another field written: the one before is settled first, so the lines keep the order things were done in.
    flushPending(made, key);
    const data = event.data as { value?: unknown; interim?: unknown } | undefined;
    if (data !== undefined && data.interim !== true && "value" in data) {
      made.pending.delete(key);
      settle(made, key, componentId);
      return;
    }
    made.pending.set(key, componentId);
  }

  /** A collection's row count against the last one seen: one added or removed (a move is no line). */
  function recordRows(made: TryRecorder, path: string): void {
    const before = made.rows.get(path) ?? 0;
    const count = rowCount(made.runtime, path);
    made.rows.set(path, count);
    const values = made.runtime.state().values as Record<string, unknown>;
    // Which row went, read off the rows before and after: the first that differs (the last when all agree).
    const answered = (key: string): boolean => {
      const componentId = made.index.byPath(key);
      return componentId === undefined || !made.index.calculated.has(componentId);
    };
    const rowsBefore = rowSignatures(made.seen, path, before, answered);
    const rowsAfter = rowSignatures(new Map(Object.entries(values).map(([key, value]) => [key, settledKey(value)])), path, count, answered);
    let removed = rowsAfter.findIndex((signature, at) => signature !== rowsBefore[at]);
    if (removed < 0) {
      removed = count;
    }
    // The rows' answers moved with the rows: the lines go on from where they now stand.
    for (const key of [...made.seen.keys()]) {
      if (key.startsWith(`${path}[`)) {
        made.seen.delete(key);
      }
    }
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith(`${path}[`)) {
        made.seen.set(key, settledKey(value));
      }
    }
    const componentId = made.index.collections.get(path) as string;
    if (count > before) {
      emit(made, { kind: "addRow", componentId, collection: path, count });
    } else if (count < before) {
      // `index` (one row gone) is the panel's ask: additive beside the contract's `count`.
      emit(made, { kind: "removeRow", componentId, collection: path, count, ...(before - count === 1 ? { index: removed } : {}) } as TestsRecordEvent);
    }
  }

  /** A journey's move, by its direction: Continue, Back, a jump, a Change link; a start, a resume or an error's move are the runtime's. */
  function recordPage(made: TryRecorder, data: PageChangedEventData | undefined): void {
    if (!data) {
      return;
    }
    if (data.direction === "forward") {
      emit(made, { kind: "continue" });
    } else if (data.direction === "back") {
      emit(made, { kind: "back" });
    } else if (data.direction === "jump") {
      emit(made, { kind: "goTo", page: pageIdOf(data.toPageId) });
    } else if (data.direction === "change") {
      // A Change link on a Check answers step: the replay presses the row's link, so the Continue
      // that follows comes back to the review step. The press is not told which row it was, so the
      // line names the first answer the step asks; any row of the step opens the same step.
      const path = changedPath(made, data.toPageId);
      if (path !== undefined) {
        emit(made, { kind: "change", path });
      }
    }
  }

  /** The value path of the first answer the step asks (a repeating section's collection path for a row's field), else nothing. */
  function changedPath(made: TryRecorder, toPageId: string): string | undefined {
    const view = made.runtime.journeyView?.();
    if (view === undefined) {
      return undefined;
    }
    const asked = new Set(Object.keys(view.pageOf).filter((id) => view.pageOf[id] === toPageId));
    for (const id of [...view.members, ...asked]) {
      if (!asked.has(id) || made.index.calculated.has(id)) {
        continue;
      }
      const path = made.index.dataPaths.get(id);
      if (path !== undefined) {
        const row = path.indexOf("[]");
        return row < 0 ? path : path.slice(0, row);
      }
    }
    return undefined;
  }

  /** An answer settled: `set` with its value, `clear` when it is empty now; nothing when it is what was last reported. */
  function settle(made: TryRecorder, key: string, componentId: string | undefined): void {
    if (componentId === undefined) {
      return;
    }
    const value = (made.runtime.state().values as Record<string, unknown>)[key];
    const settledAs = settledKey(value);
    const prior = made.seen.get(key);
    if (prior === settledAs) {
      return;
    }
    made.seen.set(key, settledAs);
    // Typed into and emptied again before leaving it: the field says nothing, as before.
    if (isEmptyAnswer(value) && wasEmpty(prior)) {
      return;
    }
    deliver(made, isEmptyAnswer(value) ? { kind: "clear", componentId, path: key } : { kind: "set", componentId, path: key, value: kernelJsonValue(value) });
  }

  /** Whether a value Record last saw (as {@link settledKey} wrote it, or never seen) was an empty answer. */
  function wasEmpty(prior: string | undefined): boolean {
    if (prior === undefined || prior === "undefined") {
      return true;
    }
    try {
      return isEmptyAnswer(JSON.parse(prior));
    } catch {
      return false;
    }
  }

  /** Hands an event to the recording's listener; while a Submit is in flight it waits for the `submit` line. */
  function deliver(made: TryRecorder, event: TestsRecordEvent): void {
    if (made.held) {
      made.held.push(event);
      return;
    }
    made.listener(event);
  }

  /** The Submit in flight landed or went: its `submit` line, then what settled meanwhile. */
  function release(made: TryRecorder, submitted: TestsRecordEvent): void {
    const held = made.held;
    if (!held) {
      return;
    }
    made.held = undefined;
    submitLined = true;
    made.listener(submitted);
    for (const event of held) {
      made.listener(event);
    }
  }

  /** Everything held back is settled, but `except` (the field being written now). */
  function flushPending(made: TryRecorder, except?: string): void {
    for (const [key, componentId] of [...made.pending]) {
      if (key === except) {
        continue;
      }
      made.pending.delete(key);
      settle(made, key, componentId);
    }
  }

  /** What the recording in progress held back, sent now: before a move, a check, a submit, Assert this, the end. */
  function flushRecording(): void {
    if (recorder) {
      flushPending(recorder);
    }
  }

  /** An event other than an answer: what was held back goes first. */
  function emit(made: TryRecorder, event: TestsRecordEvent): void {
    flushPending(made);
    deliver(made, event);
  }

  /** The recording in progress hears `event`, after what it held back. */
  function record(event: TestsRecordEvent): void {
    if (recorder) {
      emit(recorder, event);
    }
  }

  /** A page the tried runtime names by an id of its own (a journey's node) as the journey names it. */
  function pageIdOf(runtimePageId: string): string {
    const session = options.session?.() as (ReturnType<NonNullable<TryItOptions["session"]>> & TrySessionPages) | undefined;
    return session?.pageIdOf?.(runtimePageId) ?? runtimePageId;
  }

  /**
   * The bar's Recording control while the canvas records: before Back to editing, as
   * Show me's step control is, with the bar's "Previewing" giving it the room. Made once per
   * recording; gone with it.
   */
  function syncRecordingBar(): void {
    const on = options.recording?.() !== undefined;
    if (!on && !recordingEl) {
      return;
    }
    const root = options.root();
    if (!on) {
      const slot = recordingEl!;
      recordingEl = undefined;
      const bar = slot.parentElement;
      const hadFocus = slot.contains((root as ShadowRoot).activeElement);
      slot.remove();
      bar?.removeAttribute("data-try-recording-on");
      if (hadFocus) {
        bar?.querySelector<HTMLElement>("[data-try-it]")?.focus();
      }
      return;
    }
    const bar = root.querySelector<HTMLElement>("[data-canvas-bar]");
    if (!bar) {
      return;
    }
    if (!recordingEl || recordingEl.parentElement !== bar) {
      recordingEl?.remove();
      const slot = document.createElement("span");
      slot.className = "try-recording";
      slot.setAttribute("data-try-recording", "");
      slot.innerHTML =
        '<span class="try-recording-dot" aria-hidden="true"></span>' +
        '<span class="try-recording-text" data-try-recording-label role="status" aria-live="polite"></span>' +
        '<button type="button" class="try-showing-btn try-showing-stop" data-try-record-stop></button>';
      slot.addEventListener("click", (event) => click(event.composedPath() as HTMLElement[]));
      bar.insertBefore(slot, bar.querySelector("[data-try-showing]") ?? bar.querySelector("[data-try-it]"));
      recordingEl = slot;
    }
    bar.setAttribute("data-try-recording-on", "");
    const given = words();
    const label = recordingEl.querySelector<HTMLElement>("[data-try-recording-label]")!;
    const labelText = given.text("try.recording.label");
    if (label.textContent !== labelText) {
      label.textContent = labelText;
    }
    const stop = recordingEl.querySelector<HTMLElement>("[data-try-record-stop]")!;
    const stopText = given.text("try.recording.stop");
    if (stop.textContent !== stopText) {
      stop.textContent = stopText;
    }
  }

  function recordingChanged(): void {
    syncRecording();
    syncRecordingBar();
  }

  /**
   * Assert this: every field of the tried runtime as it stands, by its value path
   * (data keys honoured, a row's field once per row), with its label in the canvas's language,
   * its state, the codes of the errors on show and its value; the page a journey is on; the
   * last Submit's verdict. What a recording held back is sent first, so its lines come before
   * the expectations written from this.
   */
  function assertSnapshot(): TestsAssertSnapshot | undefined {
    const runtime = triedRuntime();
    if (!runtime) {
      return undefined;
    }
    flushRecording();
    const root = runtime.formRoot();
    const index = recordIndex(root);
    const states = runtime.effectiveStatesMap();
    const required = runtime.requiredMap();
    const errors = runtime.errors();
    const values = runtime.state().values as Record<string, unknown>;
    const locale = options.controller()?.currentLocale() ?? "en";
    const sources = textSourcesOf(options.controller());
    const fields: TestsAssertField[] = [];
    const field = (node: ComponentNode, path: string): void => {
      const state = states.get(node.id);
      fields.push({
        componentId: node.id,
        path,
        label: labelIn(node, locale, sources) || node.id,
        visible: state?.visible ?? true,
        required: required.get(node.id) === true,
        enabled: !(state?.disabled ?? false),
        readonly: state?.readonly ?? false,
        errors: errors.filter((error) => (error.path !== undefined ? stringifyComponentPath(error.path) === path : error.componentId === node.id)).map((error) => error.code),
        value: kernelJsonValue(values[path])
      });
    };
    for (const node of index.fields) {
      const dataPath = index.dataPaths.get(node.id) as string;
      const at = dataPath.indexOf("[]");
      if (at < 0) {
        field(node, dataPath);
        continue;
      }
      // A row's field once per row the answers hold (the innermost section's rows).
      const collection = dataPath.slice(0, at);
      const rest = dataPath.slice(at + 2);
      if (rest.includes("[]")) {
        continue;
      }
      for (let row = 0; row < rowCount(runtime, collection); row += 1) {
        field(node, `${collection}[${row}]${rest}`);
      }
    }
    const view = (runtime as { journeyView?: () => { pageId?: string } | undefined }).journeyView?.();
    const verdict = submitStatus.state === "accepted" ? "accepted" : submitStatus.state === "refused" || submitStatus.state === "invalid" ? "refused" : undefined;
    // The day the rules read, for Record's `given today` lead line: the preview's, when
    // one is set; a mode's session keeps a clock of its own, and a preview with no day reads none.
    const day = options.session?.()?.runtime === undefined ? options.preview()?.today() : undefined;
    return {
      fields,
      ...(view?.pageId !== undefined ? { page: pageIdOf(view.pageId) } : {}),
      ...(verdict !== undefined ? { lastSubmit: verdict } : {}),
      ...(day !== undefined && ISO_DAY.test(day) ? { today: day } : {})
    };
  }

  /** Draws the Try it panel from its state, its focus kept on the control that had it. */
  function render(): void {
    const root = options.root();
    syncShowing();
    recordingChanged();
    const panel = panelOf();
    if (!panel || panel.hidden) {
      return;
    }
    const active = (root as ShadowRoot).activeElement as HTMLElement | null;
    const focusKey = active && panel.contains(active) ? Object.keys(active.dataset).find((key) => key.startsWith("try")) : undefined;
    const focusValue = focusKey ? active?.dataset[focusKey] : undefined;
    // The live regions are kept across the redraw, their content swapped, so a change is read out.
    const regions = ["data-try-submit", "data-try-wasm-status", "data-try-results", "data-try-journey-notice"];
    const kept = new Map(regions.map((attribute) => [attribute, panel.querySelector<HTMLElement>(`[${attribute}]`)]));
    const modeTry = options.builderMode?.()?.tryIt;
    const pdfMode = options.pdfMode?.()?.tryIt?.pdf;
    // The mode's kept nodes (the Journey card's map) are not drawn again: carried over below, with
    // what a detach would lose (focus, and the scroll of the node and of what scrolls inside it,
    // as the map's own window does).
    const carried = (modeTry?.kept ?? []).flatMap((attribute) => {
      const node = panel.querySelector<HTMLElement>(`[${attribute}]`);
      const scrolled = node ? [node, ...node.querySelectorAll("*")].filter((each) => each.scrollTop !== 0 || each.scrollLeft !== 0).map((each) => [each, each.scrollTop, each.scrollLeft] as const) : [];
      return node ? [{ attribute, node, scrolled, focus: active && node.contains(active) ? active : undefined }] : [];
    });
    const view: TryPanelDrawn = {
      noSubmit: formHasNoSubmit(),
      mode: options.mode(),
      answers: JSON.stringify(answers(), null, 2),
      live,
      problems,
      server: {
        status: wasm.status,
        label: wasm.checks?.label ?? "WebAssembly",
        reason: wasm.reason,
        ...server
      },
      submit: submitStatus,
      // The PDF mode's (its layouts, its dialog) or, on a page without one, the host's PDF support.
      pdf: pdfMode !== undefined || options.pdf() !== undefined,
      pdfBusy,
      pdfError,
      answered: answeredCount()
    };
    // The PDF card leads in the PDF workspace; elsewhere Show the form keeps Preview PDF.
    if (pdfMode && options.workspace?.() === "pdf") {
      view.pdfCard = pdfMode.label();
    }
    view.modeCards = modeTry?.cards?.(view);
    panel.innerHTML = tryPanelHtml(view, words());
    syncTryGrab(panel);
    for (const { attribute, node, scrolled, focus } of carried) {
      const fresh = panel.querySelector<HTMLElement>(`[${attribute}]`);
      if (!fresh) {
        continue;
      }
      fresh.replaceWith(node);
      for (const [each, top, left] of scrolled) {
        each.scrollTop = top;
        each.scrollLeft = left;
      }
      focus?.focus({ preventScroll: true });
    }
    for (const [attribute, before] of kept) {
      const fresh = panel.querySelector<HTMLElement>(`[${attribute}]`);
      if (!before || !fresh) {
        continue;
      }
      for (const name of before.getAttributeNames()) {
        if (!fresh.hasAttribute(name)) {
          before.removeAttribute(name);
        }
      }
      for (const name of fresh.getAttributeNames()) {
        before.setAttribute(name, fresh.getAttribute(name)!);
      }
      if (before.innerHTML !== fresh.innerHTML) {
        before.innerHTML = fresh.innerHTML;
      }
      fresh.replaceWith(before);
    }
    if (focusKey) {
      const attribute = `data-${focusKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      const again = [...panel.querySelectorAll<HTMLElement>(`[${attribute}]`)].find((el) => el.dataset[focusKey] === focusValue);
      again?.focus();
    }
    modeTry?.drawn?.(panel);
  }

  /** An answer changed in Try it: the data follows at once, the checks a beat later when they run as answers change. */
  function answersChanged(): void {
    const panel = panelOf();
    if (!panel || panel.hidden) {
      return;
    }
    const data = panel.querySelector<HTMLElement>("[data-try-data]");
    if (data) {
      data.textContent = JSON.stringify(answers(), null, 2);
    }
    const answered = panel.querySelector<HTMLElement>("[data-try-answered]");
    if (answered) {
      answered.textContent = typedAnswersText(answeredCount(), words());
    }
    if (live) {
      if (liveTimer !== undefined) {
        clearTimeout(liveTimer);
      }
      liveTimer = setTimeout(() => {
        liveTimer = undefined;
        void runChecks();
      }, 300);
    }
  }

  /** The browser's checks on the answers, and the server's when they are on. */
  async function runChecks(): Promise<void> {
    await checkNow();
  }

  /**
   * The checks' body (Check now, Check as answers change, an agent's check): the panel
   * drawn from what they found, and that returned. The problems are this run's own (a check
   * running beside it may replace the panel's), the browser's or the session's first, then the
   * server's lines not already said word for word. `chosen`: the person's switch was on while the
   * validator loaded (`checkForAgent`), so a load that was refused reads as failed, not off.
   */
  async function checkNow(chosen = false): Promise<TryCheckOutcome> {
    const controller = options.controller();
    const runtime = triedRuntime();
    if (!controller || !runtime) {
      return { problems: [], server: "off" };
    }
    const root = runtime.formRoot();
    const locale = controller.currentLocale();
    const tried = answers();
    const serverWasOn = chosen || server.on;
    // A mode's session checks its own way when it can (a journey's pages), without moving.
    const session = options.session?.();
    const found = session?.check ? await session.check() : describeProblems(root, browserErrors(root, tried), locale, words(), textSourcesOf(controller));
    problems = found;
    const serverErrors = await runServerChecks(root, tried, locale);
    // Worded as the server's card words them (`runServerChecks`), from this run's own answer.
    const serverFound = serverErrors !== undefined ? describeProblems(root, serverErrors, locale, words(), textSourcesOf(controller)) : [];
    render();
    const said = new Set(found.map((problem) => `${problem.componentId ?? ""}|${problem.message}`));
    return {
      problems: [...found, ...serverFound.filter((problem) => !said.has(`${problem.componentId ?? ""}|${problem.message}`))],
      server: serverErrors !== undefined ? "ran" : serverWasOn && (server.failure !== undefined || wasm.status === "failed") ? "failed" : "off"
    };
  }

  /**
   * An agent's Check: the person's own, once a validator the person turned on has
   * loaded. While it loads the panel draws the switch on (`wasmHtml`), so the check waits for the
   * load and then runs the server's checks, or reports them failed when the load was refused.
   * The person's Check now does not wait: it draws the browser's lines at once, and the load,
   * once in, checks again (`turnServerChecksOn`).
   */
  async function checkForAgent(): Promise<TryCheckOutcome> {
    const loading = wasm.status === "loading" ? wasm.loading : undefined;
    if (loading) {
      // `turnServerChecksOn` awaited this load first, so the switch is on by the time this resumes.
      await loading;
    }
    return checkNow(loading !== undefined);
  }

  /** The browser's checks on the answers, as Check now and Submit run them. */
  function browserErrors(root: ComponentNode, tried: Record<string, unknown>): ReturnType<typeof checkAnswerErrors> {
    // What is hidden and required is the tried runtime's: a session's, never the shared store's while it runs.
    const runtime = triedRuntime();
    if (!runtime) {
      return [];
    }
    const states = runtime.effectiveStatesMap();
    // The preview's rows are checked from their keys, an empty drawn row's included;
    // a session's answers are its runtime's own.
    const checked = options.session?.() ? tried : previewCheckedAnswers(root, runtime.state().values as Record<string, unknown>);
    return checkAnswerErrors(root, checked, {
      locale: options.controller()?.currentLocale() ?? "en",
      required: runtime.requiredMap(),
      // Which Validate rules fail: every session's runtime (the preview's or a mode's FormRuntime) lends the map.
      invalid: runtime.invalidMap?.() ?? {},
      hidden: (id) => states.get(id)?.visible === false,
      kinds: formKinds(options.controller())
    });
  }

  /**
   * The server's checks, when the WebAssembly validator is on and loaded: its problems kept for
   * the panel and returned; `undefined` when it is off, or did not run (the panel says why). A run
   * whose state was replaced while it ran (the checks turned off or taken away, the answers
   * cleared, another run started) keeps nothing and returns `undefined`.
   */
  async function runServerChecks(root: ComponentNode, tried: Record<string, unknown>, locale: string): Promise<ReturnType<typeof checkAnswerErrors> | undefined> {
    if (!server.on) {
      return undefined;
    }
    const checks = await loadServerChecks();
    if (!checks || !server.on) {
      return undefined;
    }
    const running: typeof server = { on: true, busy: true };
    server = running;
    render();
    try {
      const kinds = formKinds(options.controller());
      // The host values of Try it's Settings, so the server's checks judge a `host.` rule as the preview does.
      const hostContext = options.trySettings()?.tryHostContext();
      const outcome = await checks.run({ root, answers: tried, locale, ...(kinds !== undefined ? { kinds } : {}), ...(hostContext !== undefined ? { hostContext } : {}) });
      if (server !== running) {
        return undefined;
      }
      server = { on: true, busy: false, problems: describeProblems(root, outcome.errors, locale, words(), textSourcesOf(options.controller())) };
      return outcome.errors;
    } catch (error) {
      if (server === running) {
        server = { on: true, busy: false, failure: words().text("try.server.failed", { reason: error instanceof Error ? error.message : String(error) }) };
      }
      return undefined;
    }
  }

  /**
   * The WebAssembly validator, loading it the first time (a loader the host lent), kept once it
   * resolves. A rejection leaves it failed with the reason, the toggle off, until Try again.
   */
  function loadServerChecks(): Promise<TryItServerChecks | undefined> {
    if (wasm.status === "ready") {
      return Promise.resolve(wasm.checks);
    }
    if (wasm.loading) {
      return wasm.loading;
    }
    const source = options.serverChecks();
    if (typeof source !== "function") {
      return Promise.resolve(undefined);
    }
    const state: TryWasmState = { status: "loading" };
    state.loading = (async () => {
      try {
        const checks = await source();
        if (wasm === state) {
          wasm = { status: "ready", checks };
        }
        return checks;
      } catch (error) {
        if (wasm === state) {
          const reason = error instanceof Error ? error.message : String(error);
          wasm = { status: "failed", reason: reason.trim() ? reason : words().text("try.wasm.didNotLoad") };
          server = { on: false, busy: false };
        }
        return undefined;
      } finally {
        render();
      }
    })();
    wasm = state;
    render();
    return state.loading;
  }

  /** Turns the WebAssembly validator on (loading it first when it must) and checks with it. */
  async function turnServerChecksOn(): Promise<void> {
    if (wasm.status === "none") {
      return;
    }
    const checks = await loadServerChecks();
    if (!checks) {
      server = { on: false, busy: false };
      render();
      return;
    }
    server = { on: true, busy: false };
    await runChecks();
  }

  function finishSubmit(status: TrySubmitStatus, detail: BuilderTrySubmitDetail): BuilderTrySubmitDetail {
    submitRun = undefined;
    submitStatus = status;
    // Record: the outcome `builder-try-submit` carries, accepted only when the stand-in
    // accepted; what settled during the delay follows it, as it came after the press.
    const submitted: TestsRecordEvent = { kind: "submit", accepted: detail.outcome === "accepted" };
    if (recorder?.held) {
      release(recorder, submitted);
    } else if (!submitLined) {
      record(submitted);
    }
    render();
    options.canvas.dispatchEvent(new CustomEvent<BuilderTrySubmitDetail>("builder-try-submit", { detail, bubbles: true, composed: true }));
    return detail;
  }

  /**
   * The form's Submit in Try it: the browser's checks, and the server's when the
   * WebAssembly validator is on; problems go on the form and nothing is sent. Otherwise the form
   * shows "Submitting…" for the delay, then the stand-in server's answer: the receipt (read only
   * after, when set), a refusal or a failure as a form-level error. One at a time.
   */
  async function submit(): Promise<void> {
    await runSubmit(false);
  }

  /**
   * An agent's Submit: the person's own body, answering with what
   * `builder-try-submit` carries; quiet while the person's focus is outside the canvas.
   */
  async function submitForAgent(): Promise<TrySubmitOutcome | { state: "busy" }> {
    if (submitRun) {
      return { state: "busy" };
    }
    const ended = await runSubmit(!focusInCanvas());
    if (ended === "no-form") {
      throw new Error("Try it has no form to submit.");
    }
    if (ended === "dropped") {
      throw new Error("The Submit was dropped before the stand-in answered: Try it ended or its answers were cleared.");
    }
    return ended;
  }

  /**
   * Whether the person's focus is inside the canvas (its bar, the Try panel, the form tried), read
   * through each shadow root on the way down. There an agent's Submit moves focus as the person's
   * own Submit does; anywhere else (a chat beside the builder, the page's body) it leaves focus be.
   * A page without focus (the person in the browser's assistant panel, another window) is never
   * "inside", whatever it left focused: the rule `focusedTriedPath` reads.
   */
  function focusInCanvas(): boolean {
    if (typeof document === "undefined" || (typeof document.hasFocus === "function" && !document.hasFocus())) {
      return false;
    }
    const canvas = options.canvas;
    let active: Element | null | undefined = document.activeElement;
    while (active) {
      if (active === canvas || (typeof canvas.contains === "function" && canvas.contains(active))) {
        return true;
      }
      active = active.shadowRoot?.activeElement;
    }
    return false;
  }

  /**
   * Submit's body, the person's and an agent's: the detail it ended with, `"no-form"` when there
   * was nothing to submit (or a Submit already in flight), `"dropped"` when Back to editing or
   * Clear answers dropped it before the stand-in answered. `quiet` moves no focus and reveals
   * nothing: no first error, notice or field, and a session's page move takes no focus.
   */
  async function runSubmit(quiet: boolean): Promise<BuilderTrySubmitDetail | "no-form" | "dropped"> {
    const controller = options.controller();
    const preview = options.preview();
    const renderer = options.renderer();
    const settingsFrom = options.trySettings();
    if (!controller || !preview || !renderer || !settingsFrom || submitRun) {
      return "no-form";
    }
    const run = (submitRun = {});
    // What was typed before Submit was pressed is a line before it; what settles while it is in
    // flight waits for its line, which carries the outcome when it lands.
    flushRecording();
    submitLined = false;
    if (recorder) {
      recorder.held = [];
    }
    const settings = settingsFrom.trySubmission();
    renderer.notice = undefined;
    putErrors([]);
    submitStatus = { state: "submitting" };
    render();

    const root = (triedRuntime() ?? preview).formRoot();
    const locale = controller.currentLocale();
    const tried = answers();
    const session = options.session?.();
    if (session) {
      // The session validates its own way (a journey jumps to the first page with a problem);
      // the server's checks, when on, still read the answers as a submission carries them.
      // Quiet, that page move paints without taking focus (the renderer's own rule).
      const release = quiet ? (renderer as { quietNextPageFocus?(): () => void }).quietNextPageFocus?.() : undefined;
      let outcome: Awaited<ReturnType<typeof session.submit>>;
      try {
        outcome = await session.submit();
      } finally {
        release?.();
      }
      problems = outcome.problems;
      const serverErrors = (await runServerChecks(root, tried, locale)) ?? [];
      if (submitRun !== run) {
        return "dropped";
      }
      if (outcome.problems.length > 0 || serverErrors.length > 0) {
        if (serverErrors.length > 0) {
          // The marks the session's submit just made stay; the server's are added, each said once.
          const marks = session.runtime.errors();
          const said = new Set(marks.map((error) => `${error.componentId ?? ""}|${error.code}`));
          const added = toFormErrors(serverErrors).filter((error) => !said.has(`${error.componentId ?? ""}|${error.code}`));
          // A journey's runtime takes the person to the earliest page holding one of these
          // (`FormRuntime.setErrors`), a page move of its own after the session's
          // submit has settled and released its quiet: quiet, that move takes no focus either.
          const again = quiet ? (renderer as { quietNextPageFocus?(): () => void }).quietNextPageFocus?.() : undefined;
          try {
            putErrors([...marks, ...added]);
          } finally {
            again?.();
          }
          // Only the server found anything: the session did not move, so the field it names is shown.
          const first = added.find((error) => error.componentId !== undefined)?.componentId;
          if (outcome.problems.length === 0 && first !== undefined && !quiet) {
            renderer.revealComponent(first);
          }
        }
        const detail = finishSubmit({ state: "invalid", count: outcome.problems.length + serverErrors.length, at: new Date() }, { outcome: "invalid", answers: tried });
        // The first error takes focus, as on the form's own canvas; on the page the session moved to, once it is drawn.
        if (!quiet) {
          renderer.focusFirstError();
        }
        return detail;
      }
      return standIn(run, settings, tried, quiet);
    }
    const browser = browserErrors(root, tried);
    problems = describeProblems(root, browser, locale, words(), textSourcesOf(controller));
    const serverErrors = await runServerChecks(root, tried, locale);
    if (submitRun !== run) {
      return "dropped";
    }
    // The server's verdict on a field the browser already faulted for the same reason is said once.
    const said = new Set(browser.map((error) => `${error.componentId ?? ""}|${error.code}`));
    const found = [...browser, ...(serverErrors ?? []).filter((error) => !said.has(`${error.componentId ?? ""}|${error.code}`))];
    if (found.length > 0) {
      preview.setErrors(toFormErrors(found));
      const detail = finishSubmit({ state: "invalid", count: found.length, at: new Date() }, { outcome: "invalid", answers: tried });
      if (!quiet) {
        renderer.focusFirstError();
      }
      return detail;
    }
    return standIn(run, settings, tried, quiet);
  }

  /** The checks' errors as the form shows them, one id each. */
  function toFormErrors(found: ReturnType<typeof checkAnswerErrors>): FormError[] {
    return found.map(({ path, ...error }, index): FormError => {
      // A value path names the field when it has no row in it, as the runtime's host errors read it.
      const componentId = error.componentId ?? (path !== undefined && !path.includes("[") ? path.split(".").pop() : undefined);
      return { ...error, id: `try_${index}`, ...(componentId !== undefined ? { componentId } : {}) };
    });
  }

  /**
   * Past the checks: the form shows "Submitting…" for the delay, then the stand-in server's
   * answer, on whichever runtime is tried.
   */
  async function standIn(
    run: object,
    settings: ReturnType<BuilderController["trySubmission"]>,
    tried: Record<string, unknown>,
    quiet: boolean
  ): Promise<BuilderTrySubmitDetail | "no-form" | "dropped"> {
    const renderer = options.renderer();
    if (!renderer) {
      return "no-form";
    }
    renderer.submittingPlacement = settings.statusPlacement;
    renderer.texts = settings.statusText.trim() ? { submitting: settings.statusText.trim() } : undefined;
    renderer.submitting = true;
    await new Promise((resolve) => setTimeout(resolve, settings.delayMs));
    if (submitRun !== run) {
      return "dropped";
    }
    renderer.submitting = false;
    if (settings.outcome === "accept") {
      const receipt = settings.receipt;
      const reference = trySubmissionReference(receipt.referencePattern);
      renderer.notice = {
        kind: receipt.kind,
        placement: receipt.placement,
        ...(receipt.title.trim() ? { title: receipt.title.trim() } : {}),
        ...(receipt.message.trim() ? { message: receipt.message.trim() } : {}),
        ...(reference ? { details: [{ label: receipt.detailLabel.trim(), value: reference }] } : {})
      };
      if (settings.afterAccept === "readonly") {
        options.setMode("readonly");
      }
      const detail = finishSubmit({ state: "accepted", reference, at: new Date() }, { outcome: "accepted", answers: tried, ...(reference ? { reference } : {}) });
      if (!quiet) {
        renderer.focusNotice();
      }
      return detail;
    }
    const message = settings.outcome === "refuse" ? settings.refusalMessage.trim() || words().text("try.server.refused") : TRY_SUBMISSION_FAILED_MESSAGE;
    putErrors([{ id: "try_server", code: settings.outcome === "refuse" ? "refused" : "notSent", message, stage: "host", source: "server" }]);
    const detail = finishSubmit(
      settings.outcome === "refuse" ? { state: "refused", at: new Date() } : { state: "failed", at: new Date() },
      { outcome: settings.outcome === "refuse" ? "refused" : "failed", answers: tried }
    );
    if (!quiet) {
      renderer.focusFirstError();
    }
    return detail;
  }

  /** Back to editing, leaving Try it or Fill in: the submit's receipt, errors and status line go, and one in flight is dropped. */
  function clearSubmit(): void {
    submitRun = undefined;
    // A Submit dropped in flight was still pressed: its line, then what waited for it.
    if (recorder) {
      release(recorder, { kind: "submit", accepted: false });
    }
    // A live check still to come would run on whatever tree the canvas draws next (a designer's).
    if (liveTimer !== undefined) {
      clearTimeout(liveTimer);
      liveTimer = undefined;
    }
    const renderer = options.renderer();
    if (renderer) {
      if (renderer.submitting) {
        renderer.submitting = false;
      }
      if (renderer.notice !== undefined) {
        renderer.notice = undefined;
      }
    }
    options.preview()?.setErrors([]);
    if (options.session?.()) {
      putErrors([]);
    }
    if (submitStatus.state === "submitting") {
      submitStatus = { state: "none" };
    }
  }

  /** Preview PDF: the form with the answers tried, through the host's PDF provider, opened in a new tab. */
  async function previewPdf(): Promise<void> {
    const source = options.pdf();
    // The PDF mode's whenever the page has one, from any workspace (its layouts, shown in its
    // dialog); the host's support and the canvas's renderer only on a page without one.
    const modePdf = options.pdfMode?.()?.tryIt?.pdf;
    if ((!source && !modePdf) || pdfBusy) {
      return;
    }
    pdfBusy = true;
    pdfError = undefined;
    render();
    if (modePdf) {
      const runtime = triedRuntime();
      try {
        if (!runtime) {
          throw new Error(words().text("try.pdf.nothing"));
        }
        // The shell's root (the canvas lives in it): a PDF mode not on the page puts its dialog there.
        const shellRoot = options.canvas.getRootNode();
        await modePdf.preview(runtime, { workspace: options.workspace?.() ?? "form", ...(shellRoot instanceof ShadowRoot ? { root: shellRoot } : {}) });
      } catch (error) {
        pdfError = words().text("try.pdf.failed", { reason: error instanceof Error ? error.message : String(error) });
      } finally {
        pdfBusy = false;
        render();
      }
      return;
    }
    try {
      const renderer = options.renderer();
      if (renderer && typeof source === "function") {
        const support = await source();
        renderer.pdfProvider = support.provider;
        renderer.pdfFonts = support.fonts;
      }
      // Like every other builder preview, a formula being typed must not close the preview: pin warn.
      const result = await renderer?.renderPdf({ formulaErrors: "warn" });
      if (!result) {
        throw new Error(words().text("try.pdf.nothing"));
      }
      const url = URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: "application/pdf" }));
      const opened = typeof window !== "undefined" ? window.open(url, "_blank", "noopener") : null;
      if (!opened) {
        // A blocked window: the file comes as a download instead.
        const link = document.createElement("a");
        link.href = url;
        link.download = result.fileName;
        link.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      pdfError = words().text("try.pdf.failed", { reason: error instanceof Error ? error.message : String(error) });
    } finally {
      pdfBusy = false;
      render();
    }
  }

  /**
   * Clear answers: the one set of answers every workspace tries with is
   * emptied and a mode's session starts over; the last submit and the checks' findings go too,
   * being about answers no longer there.
   */
  function clearAnswers(): void {
    // A recording's lines start from the answers it found: cleared, they would not replay, so it ends.
    if (options.recording?.() !== undefined) {
      options.stopRecording?.();
    }
    clearSubmit();
    submitStatus = { state: "none" };
    problems = undefined;
    if (server.on) {
      server = { on: true, busy: false };
    }
    options.preview()?.clearValues();
    options.session?.()?.restart();
    render();
  }

  function click(path: HTMLElement[]): void {
    const hit = (key: string): HTMLElement | undefined => path.find((el) => el?.dataset?.[key] !== undefined);
    // Show me's step control: the panel replays and hands the canvas the next step; Stop is the canvas's to carry out.
    const step = hit("tryStep") as HTMLButtonElement | undefined;
    if (step) {
      const showing = options.showing?.();
      const delta = step.dataset.tryStep === "-1" ? -1 : step.dataset.tryStep === "1" ? 1 : undefined;
      if (showing && delta !== undefined && !step.disabled && (delta < 0 ? showing.step > 1 : showing.step < showing.steps)) {
        showing.onStep(delta);
      }
      return;
    }
    if (hit("tryRecordStop")) {
      options.stopRecording?.();
      return;
    }
    if (hit("tryShowStop")) {
      if (options.stopShowing) {
        options.stopShowing();
      } else {
        options.showing?.()?.onStop();
      }
      return;
    }
    // A mode's own cards: the action is the mode's to carry out.
    const modeAction = hit("tryModeAction")?.dataset.tryModeAction;
    if (modeAction !== undefined) {
      options.builderMode?.()?.tryIt?.onTryClick?.(modeAction);
      return;
    }
    if (hit("tryClear")) {
      clearAnswers();
      return;
    }
    if (hit("tryAddSubmit")) {
      addSubmitButton();
      return;
    }
    const mode = hit("tryMode")?.dataset.tryMode;
    if (mode === "interactive" || mode === "readonly") {
      if (mode === "interactive") {
        clearSubmit();
      }
      options.setMode(mode);
      render();
      return;
    }
    if (hit("tryPrint")) {
      void options.renderer()?.print();
      return;
    }
    if (hit("tryPdf")) {
      void previewPdf();
      return;
    }
    if (hit("tryCheck")) {
      record({ kind: "check" });
      void runChecks();
      return;
    }
    if (hit("tryCopy")) {
      const text = JSON.stringify(answers(), null, 2);
      void (typeof navigator !== "undefined" ? navigator.clipboard?.writeText?.(text) : undefined)?.catch?.(() => undefined);
      return;
    }
    if (hit("tryClose")) {
      options.canvas.dispatchEvent(new CustomEvent("canvas-results-close", { bubbles: true, composed: true }));
      return;
    }
    const goto = hit("tryGoto")?.dataset.tryGoto;
    if (goto) {
      // A phone's results sheet goes, so the field it points at is in view.
      options.canvas.dispatchEvent(new CustomEvent("canvas-results-close", { bubbles: true, composed: true }));
      const renderer = options.renderer();
      renderer?.revealComponent(goto);
      const control = renderer?.shadowRoot?.querySelector<HTMLElement>(`[data-component-id="${goto}"] :is(input, select, textarea, button)`);
      control?.focus();
      return;
    }
    const liveBox = hit("tryLive") as HTMLInputElement | undefined;
    if (liveBox && liveBox.type === "checkbox") {
      live = liveBox.checked;
      if (live) {
        void runChecks();
      }
      return;
    }
    if (hit("tryWasmRetry")) {
      wasm = { status: "idle" };
      void turnServerChecksOn();
      return;
    }
    const serverBox = hit("tryServer") as HTMLInputElement | undefined;
    if (serverBox && serverBox.type === "checkbox") {
      if (serverBox.checked) {
        void turnServerChecksOn();
      } else {
        server = { on: false, busy: false };
        render();
      }
    }
  }

  /** The host lent (or took away) the server's checks: the validator starts over, off unless the checks are in hand. */
  function serverChecksChanged(): void {
    wasm = startingWasm();
    // A loader not yet called must be turned on again; checks in hand stay on.
    if (wasm.status !== "ready") {
      server = { on: false, busy: false };
    }
    render();
  }

  return {
    render,
    answersChanged,
    click,
    submit,
    clearSubmit,
    serverChecksChanged,
    clearAnswers,
    showingChanged,
    recordingChanged,
    assertSnapshot,
    check: checkForAgent,
    submitForAgent,
    // What the person chose: the switch is drawn on while the validator they turned on loads.
    serverChecksOn: () => server.on || wasm.status === "loading"
  };
}

/** A chevron for the Step buttons, drawn as the canvas bar's own tools are (stroke, current colour). */
function chevronSvg(path: string): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"></path></svg>`;
}

/**
 * The cards' look. The panel's place (its column, the phone's Results sheet) is the canvas's own
 * stylesheet, so the panel sits right while this chunk loads; the canvas appends these to its
 * shadow root when the chunk arrives.
 */
export const TRY_PANEL_STYLES = `
  .try-card {
    pointer-events: auto; flex: none; display: grid; gap: var(--db-space-2); padding: var(--db-space-3) var(--db-space-4);
    background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card);
    border-radius: var(--db-radius-xl); box-shadow: var(--db-shadow-card);
  }
  /*
   * The Journey card's map: its counts line, then a window on the
   * real map (the map's stage, its scroller), which scrolls below that line and keeps the current
   * step in view. The height is fixed, so the map's fit reads the width alone; the card itself is
   * kept across redraws (see the panel's kept nodes).
   */
  .try-journey-map { block-size: 360px; display: flex; flex-direction: column; }
  .try-journey-map:empty { display: none; }
  .try-journey-map > [data-journey-map] { flex: 1; min-block-size: 0; width: auto; min-width: 0; display: flex; flex-direction: column; gap: var(--db-space-1); }
  .try-journey-map .jm-head { position: static; margin: 0; padding: 0; width: auto; max-width: none; background: none; border: 0; box-shadow: none; }
  .try-journey-map .jm-stage {
    position: relative; flex: 1; min-block-size: 0; overflow: auto; overscroll-behavior: contain;
    border: var(--db-border-w) solid var(--db-line-divider); border-radius: var(--db-radius-md); background: var(--db-backdrop);
  }
  .try-warning { background: var(--db-warn-soft); border-color: var(--db-warn-line); }
  .try-warning .try-warning-text { color: var(--db-warn); font-weight: 500; }
  .try-head { display: flex; align-items: center; justify-content: space-between; gap: var(--db-space-2); }
  .try-title { margin: 0; font-size: var(--db-text-md); font-weight: 600; }
  .try-subtitle { margin: var(--db-space-1) 0 0; font-size: var(--db-text-sm); font-weight: 600; color: var(--db-ink-muted); }
  .try-note { margin: 0; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
  /* Fill in or Read only: the shared segmented control (.seg), its two segments sharing the width. */
  .try-modes { display: flex; }
  .try-modes > button { flex: 1; }
  .try-actions { display: flex; flex-wrap: wrap; gap: var(--db-space-2); }
  .try-toggle { display: flex; align-items: center; gap: var(--db-space-2); min-block-size: 28px; font-size: var(--db-text-md); cursor: pointer; }
  .try-toggle:has(input:disabled) { cursor: default; color: var(--db-ink-muted); }
  .try-wasm { display: grid; gap: var(--db-space-1); padding-top: var(--db-space-2); border-top: var(--db-border-w) solid var(--db-line-divider); }
  .try-wasm .try-subtitle { margin: 0; }
  .try-submit { margin: 0; font-size: var(--db-text-md); font-variant-numeric: tabular-nums; }
  .try-submit[data-try-submit="accepted"] { color: var(--db-ok); }
  .try-submit:is([data-try-submit="refused"], [data-try-submit="failed"], [data-try-submit="invalid"]) { color: var(--db-danger); }
  .try-results { display: grid; gap: var(--db-space-1); }
  .try-problems { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--db-space-half); }
  .try-problem {
    appearance: none; display: block; width: 100%; text-align: start; padding: var(--db-space-1) var(--db-space-2); border: 0; border-radius: var(--db-radius-sm);
    background: var(--db-danger-soft); color: var(--db-danger); font: inherit; font-size: var(--db-text-sm);
  }
  button.try-problem { cursor: pointer; }
  button.try-problem:hover { text-decoration: underline; text-underline-offset: 2px; }
  .try-problem strong { color: var(--db-ink); margin-inline-end: var(--db-space-1); }
  .try-ok { margin: 0; font-size: var(--db-text-sm); color: var(--db-ok); }
  .try-error { margin: 0; font-size: var(--db-text-sm); color: var(--db-danger); }
  .try-data {
    margin: 0; max-height: 280px; overflow: auto; padding: var(--db-space-2) var(--db-space-3);
    background: var(--db-surface-sunken); border-radius: var(--db-radius-md);
    font-family: var(--db-font-mono); font-size: var(--db-text-sm); white-space: pre-wrap; word-break: break-word;
  }
  .try-data:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
  :host([data-phone]) .try-card { margin-bottom: var(--db-space-2); box-shadow: none; }
  /*
   * Show me's step control in the canvas bar, before Back to editing: the step on show
   * says itself in the bar's Previewing place, the label giving way first in a narrow bar.
   */
  .canvas-bar[data-try-showing-on] .canvas-previewing { display: none; }
  .try-showing {
    display: inline-flex; align-items: center; gap: 2px; min-width: 0; flex: 0 1 auto;
    padding-inline-end: var(--db-space-1); margin-inline-end: var(--db-space-1);
    border-inline-end: var(--db-border-w) solid var(--db-line-divider);
  }
  .try-showing-dot { flex: none; inline-size: 9px; block-size: 9px; margin-inline-start: var(--db-space-2); border-radius: 50%; background: var(--db-accent); }
  .try-showing-text {
    min-width: 0; max-width: 48ch; padding: 0 var(--db-space-2); font-weight: 500; color: var(--db-ink);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .try-showing-btn {
    display: inline-flex; align-items: center; gap: var(--db-space-1); flex: none; min-block-size: 32px; padding: 0 var(--db-space-2);
    border: 0; border-radius: var(--db-radius-pill); background: transparent; color: var(--db-ink-muted);
    font: inherit; font-weight: 500; cursor: pointer; transition: background-color var(--db-motion-fast) var(--db-ease);
  }
  .try-showing-btn:hover:not(:disabled) { background: var(--db-surface-hover); color: var(--db-ink); }
  .try-showing-btn:disabled { opacity: .4; cursor: default; }
  .try-showing-btn:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
  .try-showing-stop { color: var(--db-ink); }
  /* Back to editing keeps to one line beside the control (the phone run wrapped it). */
  .canvas-bar[data-try-showing-on] .canvas-try { white-space: nowrap; flex: none; }
  /* Record: the bar says it records, in the Previewing place, as Show me does. */
  .canvas-bar[data-try-recording-on] .canvas-previewing { display: none; }
  .canvas-bar[data-try-recording-on] .canvas-try { white-space: nowrap; flex: none; }
  .try-recording {
    display: inline-flex; align-items: center; gap: 2px; min-width: 0; flex: 0 1 auto;
    padding-inline-end: var(--db-space-1); margin-inline-end: var(--db-space-1);
    border-inline-end: var(--db-border-w) solid var(--db-line-divider);
  }
  .try-recording-dot { flex: none; inline-size: 9px; block-size: 9px; margin-inline-start: var(--db-space-2); border-radius: 50%; background: var(--db-danger); }
  .try-recording-text { min-width: 0; padding: 0 var(--db-space-2); font-weight: 500; color: var(--db-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /*
   * Below a phone-box bar (the 320 px phone's is about 304) the word would show as "Rec...": the
   * red dot and Stop recording carry it on screen, and the word stays for a screen reader, since
   * it is the live region that says the recording started.
   */
  @container db-canvas-bar (max-width: 339px) {
    .try-recording-text {
      position: absolute; inline-size: 1px; block-size: 1px; padding: 0; overflow: hidden;
      clip-path: inset(50%); white-space: nowrap;
    }
  }
  @container db-canvas-bar (max-width: 519px) {
    .try-showing-text { max-width: 16ch; }
    /* The Step buttons keep their chevrons and their aria-label; the word gives the label its room. */
    .try-showing-btn[data-try-step] span { display: none; }
  }
  @container db-canvas-bar (max-width: 299px) {
    .try-showing-text, .try-showing-dot { display: none; }
  }
`;
