import {
  BUILDER_FEATURES,
  BUILDER_FEATURE_PRESETS,
  assertAcyclicComponentTree,
  chromePartIdProblems,
  definitionSizeProblem,
  kernelStructureCheck,
  kernelStructureLimits,
  kernelStructureLocaleMax,
  kernelStructureMessage,
  validateJourneyShape, validatePdfLayout,
  type ComponentNode,
  type FormDefinition,
  type StorageLike
} from "@argusvane/datum-engine";

/**
 * DOM-optional base for this package's elements, for the same reason the engine has one:
 * `class X extends HTMLElement` is evaluated on import, and the entries here are imported by
 * Node tests and by tooling. In a non-DOM environment the classes are inert placeholders.
 */
const NoopElementBase = class {} as unknown as typeof HTMLElement;

export const ElementBase: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? NoopElementBase : HTMLElement;

export function canDefineCustomElements(): boolean {
  return typeof customElements !== "undefined";
}

/**
 * Detail of the `datum-error` event either element dispatches when configuration it was given
 * cannot be used. `code` is the stable name of the cause (`definition.too-large`,
 * `sandbox.unavailable`): a page matches on it, and
 * `message` is the words to show, free to change.
 */
export interface DatumErrorDetail {
  code: string;
  message: string;
  cause?: unknown;
}

/**
 * An error that knows its `datum-error` code. A function that throws where the element catches
 * it further out (an attribute parser, the fetch of a definition) names the cause here, so the
 * report carries the code and the catching site does not guess it from the message.
 */
export class DatumCodedError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DatumCodedError";
    this.code = code;
  }
}

/** The code an error was thrown with, or `fallback` for any other error. */
export function codeOf(error: unknown, fallback: string): string {
  return error instanceof DatumCodedError ? error.code : fallback;
}

/**
 * Detail of the `datum-warning` event: something the element took, but not whole. `code` names
 * what happened (`translations.dropped`: translation entries the builder left out when a form
 * loaded; `draft.dropped`: answers a restored draft held that the form cannot;
 * `src.superseded`: a builder's `src` form that arrived after the author edited, not loaded over
 * the edits); `count` and `addresses` (the first few, dotted) say how much and where.
 */
export interface DatumWarningDetail {
  message: string;
  code: string;
  count?: number;
  addresses?: string[];
}

/** Dispatches a `bubbles` + `composed` custom event from an element; returns `false` when cancelled. */
export function emit<T>(
  host: HTMLElement,
  type: string,
  detail: T,
  options: { cancelable?: boolean } = {}
): boolean {
  return host.dispatchEvent(
    new CustomEvent<T>(type, {
      detail,
      bubbles: true,
      composed: true,
      cancelable: options.cancelable ?? false
    })
  );
}

/**
 * Reports configuration the element cannot act on — malformed JSON in an attribute, an
 * unknown theme id, a definition that failed to load. Logged, so a page author sees it in the
 * console with no listener wired, and dispatched as `datum-error` for a page that wants to
 * show it. Never thrown: an exception out of an attribute callback would leave the element
 * half-configured.
 */
export function reportError(host: HTMLElement, code: string, message: string, cause?: unknown): void {
  const tag = host.tagName.toLowerCase();
  if (cause !== undefined) {
    console.error(`[${tag}] ${message}`, cause);
  } else {
    console.error(`[${tag}] ${message}`);
  }
  emit<DatumErrorDetail>(host, "datum-error", cause === undefined ? { code, message } : { code, message, cause });
}

/**
 * Reports something the element took, but not whole (a form loaded without some of its
 * translations): logged as a console warning and dispatched as `datum-warning`. Never thrown.
 */
export function reportWarning(host: HTMLElement, detail: DatumWarningDetail): void {
  console.warn(`[${host.tagName.toLowerCase()}] ${detail.message}`);
  emit<DatumWarningDetail>(host, "datum-warning", detail);
}

/**
 * Reports an id a registry could not resolve — once per element: the element
 * re-resolves on every registration, so a theme registered later makes the id resolve
 * silently, and the same unresolved id is not reported again until it has resolved in
 * between (the caller deletes the key from `reported` when it does).
 */
export function reportUnresolved(host: HTMLElement, reported: Set<string>, key: string, error: unknown, code: string): void {
  if (reported.has(key)) {
    return;
  }
  reported.add(key);
  reportError(host, code, error instanceof Error ? error.message : String(error), error);
}

/** JSON from an attribute value; throws with the attribute named so the report is actionable. */
export function parseJsonAttribute<T>(name: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new DatumCodedError(
      "attribute.invalid-json",
      `The ${name} attribute is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** A comma- or whitespace-separated attribute value as a list of tokens. */
export function parseList(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Identity for a form the page did not name: what `datum-builder-change` carries until the host sets one. */
export const DEFAULT_FORM_IDENTITY = {
  id: "form",
  version: "1.0.0",
  schemaVersion: "1"
} as const;

/** An empty form root, for a builder started without a definition. */
export function emptyFormRoot(): ComponentNode {
  return { id: "root", type: "form", configuration: {}, children: { content: [] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isComponentNode(value: unknown): value is ComponentNode {
  return isRecord(value) && typeof value.id === "string" && typeof value.type === "string";
}

/**
 * A `FormDefinition` from whatever the page handed over: a full definition (identity fields
 * filled in when missing), or a bare component tree whose root is the form (wrapped in the
 * default identity). Anything else throws, naming what was wrong.
 */
export function toFormDefinition(input: unknown): FormDefinition {
  if (isComponentNode(input) && input.type === "form" && !("root" in input)) {
    return { ...DEFAULT_FORM_IDENTITY, root: input };
  }
  if (!isRecord(input)) {
    throw new Error("A form definition must be an object with a `root` component tree");
  }
  if (!isComponentNode(input.root)) {
    throw new Error("A form definition's `root` must be a component node with `id` and `type`");
  }
  const definition = input as Partial<FormDefinition> & { root: ComponentNode };
  return {
    ...definition,
    id: typeof definition.id === "string" && definition.id ? definition.id : DEFAULT_FORM_IDENTITY.id,
    version:
      typeof definition.version === "string" && definition.version
        ? definition.version
        : DEFAULT_FORM_IDENTITY.version,
    schemaVersion:
      typeof definition.schemaVersion === "string" && definition.schemaVersion
        ? definition.schemaVersion
        : DEFAULT_FORM_IDENTITY.schemaVersion,
    root: definition.root
  };
}

/**
 * The first thing in a definition that would stop the builder taking it, located and in words
 * a person can act on; `undefined` when there is none. `toFormDefinition` checks only the
 * outline; a file someone chose (the builder's Open) is checked with this as well, before it
 * replaces the form: every component node down the tree, the root being the form, and the
 * shapes of the languages, the PDF layouts and the journeys. What a journey or a layout
 * refers to is not checked here: one that points at nothing still opens.
 */
export function formDefinitionProblem(definition: FormDefinition): string | undefined {
  const tree = definitionTreeProblem(definition);
  if (tree) {
    return tree;
  }
  const record = definition as unknown as Record<string, unknown>;
  return localizationProblem(record.localization) ?? pdfProblem(record.pdf) ?? journeyProblem(record.journey);
}

/**
 * What no route may bring into the builder, however it arrives (Open, the `definition` setter,
 * `src`, a host's config): a tree deeper than the server reads or its own ancestor, and the
 * refusals of the server's structure pass (sizes past a cap, an id the form cannot address, a
 * prototype-named key). A definition with a layout or a journey
 * the builder cannot use still loads: its side leaves that out and says so.
 */
export function definitionLoadProblem(definition: FormDefinition): string | undefined {
  return depthProblem(definition) ?? nestingProblem(definition) ?? structureProblem(definition as unknown as Record<string, unknown>);
}

/**
 * What the form's tree must be on every route it arrives by: within the depth and cycle limits,
 * every component node a node (an object with an id and a type, its configuration an object, its
 * slots lists of nodes), the root the form, then the server's structure refusals. The limits come
 * first so a deep tree is told so rather than overflowing the walk. Nothing about the sides: a
 * layout or a journey the builder cannot use leaves its side out, as {@link definitionLoadProblem}
 * says.
 */
export function definitionTreeProblem(definition: FormDefinition): string | undefined {
  return definitionShapeProblem(definition) ?? nestingProblem(definition) ?? structureProblem(definition as unknown as Record<string, unknown>);
}

/**
 * The most levels of records and lists a value in the form may nest: what a host reads of a
 * request (the QuickJS limit), and what the builder's controller refuses at load. Components
 * stop at {@link kernelStructureLimits}; the settings, rules and layouts inside them have no
 * such cap of their own, so a file could hold a tree the controller then throws on.
 */
const VALUE_NESTING_MAX = 320;

/** The parts of the definition the builder walks whole: the tree and the two sides it keeps. */
const NESTING_PARTS = ["root", "journey", "pdf"] as const;

/**
 * Whether a part of the definition nests past {@link VALUE_NESTING_MAX} levels, counted without
 * recursion and told at the door, as the other tree limits are, rather than as the controller's
 * throw once the builder is already taking the form.
 */
function nestingProblem(definition: FormDefinition): string | undefined {
  const record = definition as unknown as Record<string, unknown>;
  for (const part of NESTING_PARTS) {
    const stack: Array<{ node: unknown; depth: number }> = [{ node: record[part], depth: 1 }];
    while (stack.length > 0) {
      const { node, depth } = stack.pop() as { node: unknown; depth: number };
      if (typeof node !== "object" || node === null) {
        continue;
      }
      if (depth > VALUE_NESTING_MAX) {
        return `The form nests more than ${VALUE_NESTING_MAX} levels deep (rules, settings and components together; here in ${part === "root" ? "the components" : `the ${part} block`}), so it cannot be opened.`;
      }
      for (const member of Array.isArray(node) ? node : Object.values(node)) {
        stack.push({ node: member, depth: depth + 1 });
      }
    }
  }
  return undefined;
}

/**
 * The shape half of {@link definitionTreeProblem}, which the form element runs on every
 * definition it is given: the depth and cycle limits, every component node a node, the root the
 * form. The server's structure refusals stay the builder's (they pull the structure pass into
 * the bundle, which the form's budget does not carry): a form that the server would refuse is
 * drawn, and the refusal is the server's to say.
 */
export function definitionShapeProblem(definition: FormDefinition): string | undefined {
  if (!isRecord(definition)) {
    return "A form definition must be an object with a `root` component tree";
  }
  const limits = depthProblem(definition);
  if (limits) {
    return limits;
  }
  const rootProblem = componentNodeProblem(definition.root, "root");
  if (rootProblem) {
    return rootProblem;
  }
  if (definition.root.type !== "form") {
    return `root must be the form (type "form"), not "${definition.root.type}"`;
  }
  return undefined;
}

/** The side blocks a setter takes as a whole: the problem with a journeys block, as Open words it. */
export function journeyConfigurationProblem(definition: FormDefinition, journey: unknown): string | undefined {
  // `null` clears the side, as `undefined` does: the setter drops it rather than refusing a shape.
  if (journey === undefined || journey === null) {
    return undefined;
  }
  return journeyProblem(journey) ?? definitionLoadProblem({ ...definition, journey } as FormDefinition);
}

/** The problem with a PDF block a setter takes as a whole, as Open words it. */
export function pdfConfigurationProblem(definition: FormDefinition, pdf: unknown): string | undefined {
  if (pdf === undefined || pdf === null) {
    return undefined;
  }
  return pdfProblem(pdf) ?? definitionLoadProblem({ ...definition, pdf } as FormDefinition);
}

/** The depth and cycle limits of a definition, before any walk that recurses can overflow. */
function depthProblem(definition: FormDefinition): string | undefined {
  // The depth the server reads at most, counted without recursion: a tree deeper than that is
  // refused here, before any walk below can overflow the stack.
  const deep = definitionDepthProblem(definition.root, (definition as { journey?: unknown }).journey);
  // The walks recurse: a node that is its own ancestor is named first, not left to a RangeError.
  if (isRecord(definition.root)) {
    try {
      assertAcyclicComponentTree(definition.root);
    } catch (error) {
      if (!(error instanceof RangeError)) {
        return error instanceof Error ? error.message : String(error);
      }
    }
  }
  return deep;
}

/** The most levels the server reads (`kernelMaxComponentDepth`); counted with an explicit stack, so a deep file is refused, never a RangeError. */
function definitionDepthProblem(root: unknown, journey?: unknown): string | undefined {
  const limit = kernelStructureLimits().depth;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 1 }];
  // A journey page's own nodes (objects in `pages[].components`) are measured apart, each from level 1, as the server does.
  const journeys = isRecord(journey) && Array.isArray(journey.journeys) ? journey.journeys : [];
  for (const one of journeys) {
    for (const page of isRecord(one) && Array.isArray(one.pages) ? one.pages : []) {
      for (const entry of isRecord(page) && Array.isArray(page.components) ? page.components : []) {
        if (isRecord(entry)) {
          stack.push({ node: entry, depth: 1 });
        }
      }
    }
  }
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (!isRecord(node) || !isRecord(node.children)) {
      continue;
    }
    if (depth >= limit) {
      return `Components nest more than ${limit} levels deep: the validator reads at most ${limit}.`;
    }
    for (const group of Object.values(node.children)) {
      if (Array.isArray(group)) {
        for (const child of group) {
          stack.push({ node: child, depth: depth + 1 });
        }
      }
    }
  }
  return undefined;
}

/**
 * The refusals of the server's structure pass that a builder must not
 * take either: a size past a cap, a component id the form cannot address, a prototype-named key
 * The same function a host's Save runs, in this tab, before the
 * canvas is built; the other findings of the pass stay the Problems list's. Two components under
 * one id are among those: the form opens and the Problems list names the twins, since an author
 * can only put that right with the form in front of them.
 */
const STRUCTURE_REFUSALS = /\.tooMany$|^definition\.tooManyComponents$|^component\.id\.invalid$|\.prototype$|\.tooLong$/;

function structureProblem(definition: Record<string, unknown>): string | undefined {
  const found = kernelStructureCheck(definition, undefined);
  const refusal = found.structure.find((entry) => found.sizeGate || STRUCTURE_REFUSALS.test(entry.code));
  if (!refusal) {
    return undefined;
  }
  return `${refusal.where}: ${refusal.message ?? kernelStructureMessage(refusal.code, refusal.limit)}`;
}

/** The first thing wrong with `value` as a component node at `path`, walking its children; nothing when it is one. */
function componentNodeProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) {
    return `${path} must be a component node object`;
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    return `${path}.id must be a non-empty string`;
  }
  if (typeof value.type !== "string" || value.type.trim() === "") {
    return `${path}.type must be a non-empty string`;
  }
  if (value.configuration !== undefined && !isRecord(value.configuration)) {
    return `${path}.configuration must be an object`;
  }
  if (value.children === undefined) {
    return undefined;
  }
  if (!isRecord(value.children)) {
    return `${path}.children must map slot ids to lists of component nodes`;
  }
  for (const [slotId, group] of Object.entries(value.children)) {
    if (!Array.isArray(group)) {
      return `${path}.children.${slotId} must be a list of component nodes`;
    }
    for (let index = 0; index < group.length; index += 1) {
      const problem = componentNodeProblem(group[index], `${path}.children.${slotId}[${index}]`);
      if (problem) {
        return problem;
      }
    }
  }
  return undefined;
}

function localizationProblem(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return "localization must be an object";
  }
  if (value.defaultLocale !== undefined && typeof value.defaultLocale !== "string") {
    return "localization.defaultLocale must be a locale code";
  }
  // The length the panel, a rename and an import hold a code to (the server reads a longer one as absent).
  if (typeof value.defaultLocale === "string" && value.defaultLocale.trim().length > kernelStructureLocaleMax()) {
    return `localization.defaultLocale is longer than ${kernelStructureLocaleMax()} characters`;
  }
  if (value.supportedLocales === undefined) {
    return undefined;
  }
  if (!Array.isArray(value.supportedLocales)) {
    return "localization.supportedLocales must be a list of locales";
  }
  const index = value.supportedLocales.findIndex(
    (entry: unknown) => !(isRecord(entry) && typeof entry.code === "string")
  );
  if (index >= 0) {
    return `localization.supportedLocales[${index}] must be { code, label? }`;
  }
  const long = value.supportedLocales.findIndex(
    (entry: unknown) => (entry as { code: string }).code.trim().length > kernelStructureLocaleMax()
  );
  return long < 0 ? undefined : `localization.supportedLocales[${long}] is longer than ${kernelStructureLocaleMax()} characters`;
}

/**
 * The first chrome part (the header and footer the form root carries) whose id cannot key a
 * translation: none, `__proto__`-style, or shared with another part, in words; `undefined` when
 * every part has one of its own. Not a reason to refuse the form: the canvas draws such a part in
 * the form's own language and the Header & footer panel gives it an id, so the element tells the
 * page and loads it.
 */
export function chromePartProblem(definition: FormDefinition): string | undefined {
  const root: unknown = (definition as { root?: unknown }).root;
  const found = chromePartIdProblems(isRecord(root) ? root.configuration : undefined)[0];
  if (!found) {
    return undefined;
  }
  const place = `chrome ${found.region} part ${found.position.map((index) => index + 1).join(".")}`;
  switch (found.code) {
    case "missing":
      return `${place} has no id`;
    case "unsafe":
      return `${place} has an id that cannot be used${found.id ? ` ("${found.id}")` : ""}`;
    default:
      return `${place} has the id "${found.id ?? ""}", which more than one part carries`;
  }
}

function pdfProblem(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return "pdf must be an object";
  }
  if (value.layouts !== undefined) {
    if (!Array.isArray(value.layouts)) {
      return "pdf.layouts must be a list of layouts";
    }
    for (let index = 0; index < value.layouts.length; index += 1) {
      const problems = validatePdfLayout(value.layouts[index]);
      if (problems.length > 0) {
        return `pdf.layouts[${index}]: ${problems.join("; ")}`;
      }
    }
  }
  if (value.defaultLayoutId !== undefined && typeof value.defaultLayoutId !== "string") {
    return "pdf.defaultLayoutId must be a layout id";
  }
  return undefined;
}

/** The journeys block, each journey checked for shape by `validateJourneyShape`. */
function journeyProblem(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return "journey must be an object";
  }
  if (value.journeys !== undefined) {
    if (!Array.isArray(value.journeys)) {
      return "journey.journeys must be a list of journeys";
    }
    for (let index = 0; index < value.journeys.length; index += 1) {
      const problems = validateJourneyShape(value.journeys[index]);
      if (problems.length > 0) {
        return `journey.journeys[${index}]: ${problems.join("; ")}`;
      }
    }
  }
  if (value.defaultJourneyId !== undefined && typeof value.defaultJourneyId !== "string") {
    return "journey.defaultJourneyId must be a journey id";
  }
  if (value.opensAs !== undefined && value.opensAs !== "journey" && value.opensAs !== "form") {
    return 'journey.opensAs must be "journey" or "form"';
  }
  return undefined;
}

/**
 * The words of a builder `features` value that name no part and no preset, in the order written
 * and lower-cased, each once; `-<part>` (a part left out) is known when the part is. Such a word
 * is left out of the list (a typo can only narrow what exists), so the page is told which.
 */
export function unknownBuilderFeatureTokens(value: string | readonly string[] | null | undefined): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const known = new Set<string>([...BUILDER_FEATURES, ...BUILDER_FEATURE_PRESETS, ...BUILDER_FEATURES.map((feature) => `-${feature}`)]);
  const words = (typeof value === "string" ? value.split(/[\s,]+/) : value.flatMap((entry) => String(entry).split(/[\s,]+/)))
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== "" && !known.has(word));
  return [...new Set(words)];
}

/**
 * The longest form definition either element reads, in UTF-8 bytes, from `src` and from the
 * builder's Open: the 2 MiB every other import is held to (options, data models, language
 * files). A page that keeps larger forms raises it with `max-definition-bytes`.
 */
export const MAX_DEFINITION_BYTES = 2 * 1024 * 1024;

/** The UTF-8 length of `text`, counted without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      // A surrogate pair is one code point of four bytes.
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** The `max-definition-bytes` attribute: a whole number of bytes above zero. */
export function toDefinitionByteLimit(value: string): number {
  const trimmed = value.trim();
  const bytes = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new DatumCodedError("max-definition-bytes.invalid", `max-definition-bytes must be a whole number of bytes above 0, not "${value}"`);
  }
  return bytes;
}

/** Whether `value` can stand as a definition byte cap (a whole number above zero). */
export function isDefinitionByteLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Fetches and parses a JSON document, failing with the HTTP status when the response is not 2xx
 * and, before anything is parsed, when the body is longer than `maxBytes` (UTF-8 bytes): a
 * declared length past it is refused unread, and a body is read only as far as the cap. Given
 * as a function, the cap is read when the response arrives and as each chunk does, so a cap the
 * page sets after asking (an attribute written after `src` in the markup) still applies.
 */
export async function fetchJson(url: string, maxBytes: number | (() => number) = MAX_DEFINITION_BYTES): Promise<unknown> {
  const cap = typeof maxBytes === "function" ? maxBytes : () => maxBytes;
  const response = await fetch(url);
  if (!response.ok) {
    throw new DatumCodedError("definition.load", `${response.status} ${response.statusText}`.trim());
  }
  const declared = Number(response.headers?.get("content-length") ?? Number.NaN);
  const early = Number.isFinite(declared) ? definitionSizeProblem(declared, cap()) : undefined;
  if (early) {
    throw new DatumCodedError("definition.too-large", early);
  }
  const text = await readCapped(response, cap);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new DatumCodedError("definition.invalid", error instanceof Error ? error.message : String(error));
  }
}

/** The body as text, read no further than the cap past which it is refused. */
async function readCapped(response: Response, cap: () => number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    const problem = definitionSizeProblem(utf8Length(text), cap());
    if (problem) {
      throw new DatumCodedError("definition.too-large", problem);
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    const maxBytes = cap();
    if (received > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new DatumCodedError("definition.too-large", definitionSizeProblem(received, maxBytes, true)!);
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
}

/**
 * The origins `allow-origins` lists (space-separated; each word a URL whose origin counts, so
 * `https://cdn.example` and `https://cdn.example/assets/` name the same one), and the words that
 * name no origin (`*`, a bare host, `data:`), which are left out.
 */
export function allowedOrigins(raw: string | null | undefined): { origins: Set<string>; unusable: string[] } {
  const origins = new Set<string>();
  const unusable: string[] = [];
  for (const word of (raw ?? "").split(/\s+/)) {
    if (word === "") {
      continue;
    }
    let origin = "null";
    try {
      origin = new URL(word).origin;
    } catch {
      // Not a URL: told below.
    }
    if (origin === "null") {
      unusable.push(word);
    } else {
      origins.add(origin);
    }
  }
  return { origins, unusable };
}

/** The `allow-origins` words that name no origin, in words; `undefined` when every word names one. */
export function allowOriginsProblem(raw: string | null | undefined): string | undefined {
  const { unusable } = allowedOrigins(raw);
  if (unusable.length === 0) {
    return undefined;
  }
  return `allow-origins lists origins as URLs (https://cdn.example); ${unusable.map((word) => JSON.stringify(word)).join(", ")} ${unusable.length === 1 ? "names" : "name"} none and ${unusable.length === 1 ? "is" : "are"} left out`;
}

/**
 * The URL a module attribute (`wasm`, `pdf`, `pdf-pages`) names, resolved against the page;
 * `undefined` for the words that name none (blank, `auto` for the bundle's own file, `off`).
 */
export function moduleAttributeUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "auto" || trimmed === "off") {
    return undefined;
  }
  return new URL(trimmed, document.baseURI).href;
}

/**
 * A `wasm` or `pdf` attribute's value with the URL it names made absolute against the page's base
 * as it is now ({@link moduleAttributeUrl}). The element checks the origin of this URL and stores
 * this URL, so what is checked is what is loaded: a `<base>` added to the page afterwards cannot
 * move a relative value elsewhere. A value that names no URL (`auto`, `off`, blank) or does not
 * parse is returned unchanged, for its own case to read or report.
 */
export function absoluteModuleAttribute(value: string): string {
  try {
    return moduleAttributeUrl(value) ?? value;
  } catch {
    return value;
  }
}

/**
 * Why an attribute may not use `url` (absolute, already resolved against the page): it is on
 * neither the page's own origin nor one `allow-origins` on `host` lists. Markup reaches places a
 * script does not (a CMS that lets editors write attributes, a sanitiser that passes custom
 * elements through), so an attribute that names code to import or an endpoint that receives
 * answers stays on the page's origin unless the page says otherwise; a URL with no origin
 * (`data:`, `javascript:`) is never taken. The properties are not held to this: a script that
 * assigns one already runs on the page. `undefined` when the URL may be used.
 */
export function attributeOriginProblem(host: HTMLElement, attribute: string, property: string, url: string): string | undefined {
  let origin: string;
  let scheme: string;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    scheme = parsed.protocol;
  } catch {
    return `The ${attribute} attribute was not used: "${url}" is not a URL.`;
  }
  if (origin !== "null") {
    const own = host.ownerDocument?.location?.origin ?? globalThis.location?.origin;
    if (origin === own || allowedOrigins(host.getAttribute("allow-origins")).origins.has(origin)) {
      return undefined;
    }
  }
  const where = origin === "null" ? `a ${scheme} URL` : `${origin}`;
  return `The ${attribute} attribute was not used: it names ${where}, and an attribute loads only from this page's origin or one allow-origins lists (the ${property} property may name any).`;
}

let cachedStorage: StorageLike | undefined;

/**
 * `window.localStorage`, probed once and cached, falling back to a process-lifetime in-memory
 * store when real storage is unavailable or throws (private browsing, a sandboxed frame).
 */
export function resolveStorage(): StorageLike {
  if (cachedStorage) {
    return cachedStorage;
  }
  try {
    const probeKey = "__datum_probe__";
    window.localStorage.setItem(probeKey, "1");
    window.localStorage.removeItem(probeKey);
    cachedStorage = window.localStorage;
  } catch {
    const memory = new Map<string, string>();
    cachedStorage = {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      }
    };
  }
  return cachedStorage;
}
