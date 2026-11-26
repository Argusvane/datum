/**
 * The structure of a definition, judged by the kernel. The `check` op of
 * `__datum_inspect` (`inspect.ts`) used to look at a definition's formulas only; every host that
 * saves or registers a definition now gets, beside them, the answer to "can the gate judge this
 * at all, and does it say what the author meant": ids and types, the places the answers would
 * be stored, the shapes of children, journeys, PDF layouts and localization, prototype-named
 * keys, and caps on size. A host refuses the definition on the verdict instead of discovering the
 * problem per submission (`journey.invalid`, `formula.invalid`, two fields silently sharing a key).
 *
 * Two kinds of finding, each `{ code, where, message?, limit? }` ({@link DefinitionProblem}):
 * a refusal goes to `structure` and makes the verdict `fail`; a warning goes to
 * `structureWarnings` and never changes it. `where` is the `root > slot > id` path of
 * `definition.tooDeep` (a component id the grammar does not allow is shown as `#<position>`),
 * `journey:<id>:page:<id>:route:<n>`, `pdf:<id>` or `definition.<key>`; at most 80 characters,
 * cut from the left. `message` is a fixed sentence built from the code and the limit; it never
 * quotes anything the author wrote, so it needs no redaction. Each list holds at most 200
 * problems and ends with `definition.problemsTruncated` when more were found.
 *
 * Cost: one walk collects at most `components + 1` entries of the form tree ({@link
 * kernelStructureCollect}) and stops there, so a definition past a size cap is answered with the
 * size problems alone, before any formula is compiled or any other rule read ("the size gate").
 *
 * This module mirrors, and does not import, the engine's `isValidComponentId`,
 * `isValidDataKey`/`findDataKeyProblems`, `duplicateComponentIds` and the envelope of
 * `validatePdfLayout`; `tests/definition-structure.test.ts` holds each copy to its original.
 *
 * Tunable policy, each piece behind one named function so it can be flipped in one
 * line: the caps ({@link kernelStructureLimits} and the two "large" thresholds); which of
 * the rules that refuse definitions the engine tolerates refuse and which warn
 * ({@link kernelStructureSeverity}). Whether the sandbox is unavailable at Save and the formula policy at
 * Save are the host's.
 *
 * Kernel-shaped (see `validation/wasm/portable-kernel.ts`): top-level `kernelStructure*`
 * function declarations that reference only each other, `kernelIsPlainRecord` and standard
 * globals; no module constants (the constants are zero-argument functions); nothing
 * nondeterministic; records keyed by author text are built without a prototype and read through
 * `hasOwnProperty`; trees are walked with explicit stacks. {@link STRUCTURE_FUNCTIONS} lists them
 * for the sandbox program. Pure: the same definition, `types` and parser answer the same bytes on
 * every host, and the definition handed in is never changed.
 */
import { kernelIsPlainRecord, kernelMaxComponentDepth, kernelRegexPatternMax } from "./compile.js";
import { kernelAnswerBounds } from "../schema/answer-kinds.js";
import { kernelIsEngineType, kernelIsKindBase, kernelKindBase } from "../schema/component-kinds.js";

/** One finding about a definition's structure; see the module comment. */
export interface DefinitionProblem {
  code: string;
  where: string;
  message?: string;
  limit?: number;
}

/** The constants in force, echoed in the `check` answer so a host can pin its own copies to the program's. */
export interface DefinitionLimits {
  depth: number;
  components: number;
  optionsPerComponent: number;
  optionsTotal: number;
  locales: number;
  journeys: number;
  pages: number;
  routesPerPage: number;
  pdfLayouts: number;
  problems: number;
}

/** What the structure pass answers. `sizeGate` is true when a cap was exceeded and nothing else was read. */
export interface StructureCheck {
  structure: DefinitionProblem[];
  structureWarnings: DefinitionProblem[];
  sizeGate: boolean;
}

/**
 * The caps. A definition past one
 * is refused with the matching `*.tooMany` code. 10,000
 * components keep the per-submission cost and the time budget (1 ms per KB) in step; the option
 * caps bound the allow-dictionary the run builds per choice question; the rest bound the walks
 * of journeys, locales and layouts. `problems` is the cap per list in the answer, not one of the caps.
 */
export function kernelStructureLimits(): DefinitionLimits {
  return {
    depth: kernelMaxComponentDepth(),
    components: 10000,
    optionsPerComponent: 2000,
    optionsTotal: 50000,
    locales: 64,
    journeys: 32,
    pages: 1000,
    routesPerPage: 64,
    pdfLayouts: 64,
    problems: 200
  };
}

/** Warning threshold: more components than this is `definition.components.large`. */
export function kernelStructureLargeComponents(): number {
  return 2500;
}

/** Warning threshold: more inline options than this on one component is `option.count.large`. */
export function kernelStructureLargeOptions(): number {
  return 500;
}

/**
 * One entry per rule that refuses definitions the engine would otherwise silently tolerate: `"refuse"`
 * puts the finding in `structure` (the verdict becomes `fail`), `"warn"` in `structureWarnings`.
 * A code not listed here has the severity its rule was written with. Flip one entry to change one
 * rule; the shipped-definition corpus (`tests/definition-structure-corpus.test.ts`) is the check
 * that no entry refuses a definition the repository ships.
 */
export function kernelStructureSeverity(code: string): string {
  switch (code) {
    case "component.id.invalid":
      return "refuse";
    case "component.dataKey.invalid":
      return "refuse";
    case "component.dataPath.duplicate":
      return "refuse";
    case "component.dataPath.conflict":
      return "refuse";
    case "pdf.invalid":
      return "refuse";
    case "pdf.layout.invalid":
      return "refuse";
    case "chrome.part.id.missing":
      return "refuse";
    case "chrome.part.id.duplicate":
      return "refuse";
    default:
      return "";
  }
}

/** The longest id, type, layout id or data key; also the longest definition id. */
export function kernelStructureNameMax(): number {
  return 128;
}

/** The longest collection path, which is free text and may hold dots. */
export function kernelStructurePathMax(): number {
  return 512;
}

/** The most characters all collection paths of a definition may hold together. */
export function kernelStructurePathsMax(): number {
  return 65536;
}

/**
 * Takes `length` characters of the paths budget (`budget.left`, from {@link kernelStructurePathsMax});
 * `false` once it is spent, after reporting `definition.paths.tooLong` once. A path that is not
 * placed costs nothing more, so a definition of long dotted paths cannot grow the places tree.
 */
export function kernelStructureSpendPath(
  log: { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number },
  budget: { left: number; over: boolean },
  length: number
): boolean {
  if (!budget.over && length <= budget.left) {
    budget.left -= length;
    return true;
  }
  if (!budget.over) {
    budget.over = true;
    kernelStructureAdd(log, "R", "definition.paths.tooLong", "definition", kernelStructurePathsMax());
  }
  return false;
}

/** The longest `version` (a host's stored form version column). */
export function kernelStructureVersionMax(): number {
  return 64;
}

/** The longest `where` in a problem. */
export function kernelStructureWhereMax(): number {
  return 80;
}

/** The longest locale code (the run reads a longer one as absent). */
export function kernelStructureLocaleMax(): number {
  return 35;
}

/** The most `types` a request may carry, and the longest of each (a host's list, not user data). */
export function kernelStructureTypesMax(): number {
  return 4096;
}

/** The names every JavaScript object has: plain-object host code reads them as data. */
export function kernelStructureProtoNames(): string[] {
  return [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "prototype"
  ];
}

/** The node keys the schema defines. */
export function kernelStructureNodeKeys(): string[] {
  return ["id", "type", "configuration", "rules", "collection", "children"];
}

/** The definition's top-level keys. */
export function kernelStructureDefinitionKeys(): string[] {
  // `tests` holds the form's own scenarios: the test op reads them, so they are read.
  // `kinds` maps a plugin's or a binding's types to their base engine types (`component-kinds.ts`).
  return ["id", "version", "schemaVersion", "metadata", "root", "localization", "accessibility", "pdf", "journey", "translations", "tests", "kinds"];
}

/** Whether a request's `types` is a list a host may send: at most 4,096 strings of at most 128 characters. */
export function kernelStructureTypesValid(types: unknown): boolean {
  if (!Array.isArray(types) || types.length > kernelStructureTypesMax()) {
    return false;
  }
  for (let t = 0; t < types.length; t += 1) {
    const one: unknown = types[t];
    if (typeof one !== "string" || one.length > kernelStructureNameMax()) {
      return false;
    }
  }
  return true;
}

/**
 * The fixed sentence for a code; built from the code and the limit only, and for a reserved id
 * from the reserved word it is, which is one of a fixed few and never other author text.
 */
export function kernelStructureMessage(code: string, limit: number | undefined, word?: string): string {
  const cap = limit === undefined ? "" : String(limit);
  switch (code) {
    case "definition.id.invalid":
      return 'The definition needs an "id" of 1 to ' + kernelStructureNameMax() + " characters.";
    case "definition.version.invalid":
      return 'The definition needs a "version" text.';
    case "definition.version.tooLong":
      return "The version may be at most " + cap + " characters.";
    case "definition.schemaVersion.invalid":
      return 'The definition needs a "schemaVersion" text.';
    case "definition.root.type":
      return 'The root component must have type "form".';
    case "definition.section.invalid":
      return "This part of the definition must be an object.";
    case "definition.key.unknown":
      return "The definition has a key this version does not read.";
    case "definition.key.prototype":
      return "A key named __proto__ is not allowed.";
    case "definition.components.large":
      return "The form has more than " + cap + " components; consider splitting it.";
    case "definition.tooManyComponents":
      return "The definition may have at most " + cap + " components.";
    case "component.notRecord":
      return "A child entry must be an object.";
    case "component.children.invalid":
      return "A component's children are lists of components, one list per slot.";
    case "component.configuration.invalid":
      return "A component's configuration must be an object.";
    case "component.collection.invalid":
      return "A component's collection must be an object with a text collectionPath.";
    case "component.key.unknown":
      return "A component has a key this version does not read.";
    case "component.id.invalid":
      return "A component id starts with a letter and uses letters, digits, _ or - only (at most " + kernelStructureNameMax() + " characters).";
    case "component.id.duplicate":
      return "Another component already has this id.";
    case "component.id.prototypeName":
      return "This id is also a name every object has; some hosts read it wrongly.";
    case "component.id.reserved":
      return '"' + word + '" cannot be a component id: it is a reserved word (component, host, row, ancestor, constructor and prototype are).';
    case "component.limits.inverted":
      return "The minimum is above the maximum, so the form ignores both; swap them or remove one.";
    case "component.type.invalid":
      return "A component needs a type of 1 to " + kernelStructureNameMax() + " characters.";
    case "component.type.unknown":
      return "This host cannot draw a component of this type.";
    case "component.dataKey.invalid":
      return "A data key uses letters, digits, _ or - only, not digits alone (at most " + kernelStructureNameMax() + " characters).";
    case "component.dataKey.prototype":
      return "The name __proto__ is not allowed as a data key or a path.";
    case "component.dataKey.prototypeName":
      return "This data key is also a name every object has; some hosts read it wrongly.";
    case "component.path.tooLong":
      return "A collection path or data path may be at most " + cap + " characters.";
    case "definition.paths.tooLong":
      return "All collection paths and data paths together may be at most " + cap + " characters.";
    case "component.pattern.tooLong":
      return "A pattern may be at most " + cap + " characters.";
    case "chrome.part.id.missing":
      return "A header or footer part needs an id of its own, the key its translations are kept under.";
    case "chrome.part.id.duplicate":
      return "Another header or footer part has this id; neither can be translated.";
    case "component.pattern.invalid":
      return "This pattern does not compile, so no answer can match it.";
    case "component.dataGrid.bounds":
      return "A data grid's minimum rows, maximum rows and rows to start with are whole numbers from 0 to " + cap + ", the minimum no more than the maximum.";
    case "component.dataGrid.boundsRule":
      return "A minimum or maximum rows formula is read on a data grid only; on this component it does nothing.";
    case "component.dataPath.duplicate":
      return "Two components would store their answers in one place; give one another data key.";
    case "component.dataPath.conflict":
      return "This component would be stored inside a place that cannot hold it.";
    case "option.list.invalid":
      return "The options of a component must be a list.";
    case "option.entry.invalid":
      return "An option needs a text value; the form draws it without the entry.";
    case "option.value.duplicate":
      return "Two options have the same value.";
    case "option.count.large":
      return "More than " + cap + " options in one list; consider a data source.";
    case "option.tooMany":
      return "One component may have at most " + cap + " inline options.";
    case "option.total.tooMany":
      return "The definition may have at most " + cap + " inline options in all.";
    case "localization.invalid":
      return "The localization needs locale codes such as en or fr-CA, in a list.";
    case "localization.locale.duplicate":
      return "A locale is listed twice.";
    case "localization.defaultLocale.unknown":
      return "The default locale is not one of the supported locales.";
    case "localization.tooMany":
      return "A form may support at most " + cap + " locales.";
    case "journey.invalid":
      return "A journey needs an id and a list of pages in the shape the runtime reads.";
    case "journey.id.duplicate":
      return "Two journeys have the same id.";
    case "journey.id.reserved":
      return '"' + word + '" cannot be a journey id: it is a reserved name, and texts kept under it could not be translated (__proto__, constructor and prototype are).';
    case "journey.page.id.reserved":
      return '"' + word + '" cannot be a page id: it is a reserved name, and texts kept under it could not be translated (__proto__, constructor and prototype are).';
    case "journey.page.duplicateId":
      return "Two pages of one journey have the same id.";
    case "journey.page.when":
      return "A page has no condition of its own; branch with a route on the page before it.";
    case "journey.route.unknownTarget":
      return "A route names a page this journey does not have; the runtime ignores it.";
    case "journey.route.backward":
      return "A route goes to an earlier page or its own page; the runtime ignores it.";
    case "journey.page.unknownComponent":
      return "A page names a component the form does not have.";
    case "journey.page.idIsComponentId":
      return "A page id is also a component id.";
    case "journey.tooMany":
      return "A form may have at most " + cap + " journeys.";
    case "journey.page.tooMany":
      return "The journeys may have at most " + cap + " pages in all.";
    case "journey.route.tooMany":
      return "A page may have at most " + cap + " routes.";
    case "pdf.invalid":
      return "The PDF configuration needs a list of layouts.";
    case "pdf.layout.invalid":
      return "A PDF layout needs an id, a kind (generated or template) and its root or template source.";
    case "pdf.layout.duplicateId":
      return "Two PDF layouts have the same id.";
    case "pdf.layout.id.reserved":
      return '"' + word + '" cannot be a PDF layout id: it is a reserved name, and texts kept under it could not be translated (__proto__, constructor and prototype are).';
    case "pdf.layout.idTooLong":
      return "A PDF layout id may be at most " + cap + " characters.";
    case "pdf.defaultLayoutId.unknown":
      return "The default PDF layout is not one of the layouts.";
    case "pdf.tooMany":
      return "A form may have at most " + cap + " PDF layouts.";
    case "kinds.invalid":
      return "The kinds map must be an object from a component type to the engine type it is read as.";
    case "kinds.tooMany":
      return "The kinds map may name at most " + cap + " types.";
    case "kinds.type.invalid":
      return "A type in the kinds map needs 1 to " + kernelStructureNameMax() + " characters.";
    case "kinds.type.engine":
      return "The kinds map names one of the engine's own types; an engine type is always read as itself.";
    case "kinds.base.invalid":
      return "A type in the kinds map needs as its base an engine component type that holds an answer (a field such as text, number, date, select or checkbox) or a plain container (fieldset, panel or tabs).";
    case "validateOn.invalid":
      return "validateOn is \"submit\" or \"commitAfterError\"; any other value is read as \"commitAfterError\".";
    case "definition.problemsTruncated":
      return "More problems were found than are listed.";
    default:
      return "The definition has a problem (" + code + ").";
  }
}

/** The keeper of the two lists and the counts of problems left out of them. */
export function kernelStructureNewLog(): { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number } {
  return { structure: [], warnings: [], leftOut: 0, leftOutWarnings: 0 };
}

/** A string cut to `max` characters, from the left, with `...` standing for what was cut. */
export function kernelStructureCut(text: string, max: number): string {
  return text.length <= max ? text : "..." + text.slice(text.length - (max - 3));
}

/**
 * Records one problem. `severity` is the rule's own (`"R"` refuse, `"W"` warn); a code with an entry in that table takes that entry instead. The 201st entry of a list is `definition.problemsTruncated`
 * (filled in by {@link kernelStructureFinish}); later problems are only counted. `where` is the
 * text or a function that builds it, called only for a problem that is kept: past the cap nothing
 * is built (a problem-bearing definition at depth 32 would otherwise cost a path per problem).
 * `word` is the reserved word a `*.reserved` problem names in its message.
 */
export function kernelStructureAdd(
  log: { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number },
  severity: string,
  code: string,
  where: string | (() => string),
  limit?: number,
  word?: string
): void {
  const override = kernelStructureSeverity(code);
  const refuse = override === "" ? severity === "R" : override === "refuse";
  const list = refuse ? log.structure : log.warnings;
  const cap = kernelStructureLimits().problems;
  if (list.length >= cap) {
    if (list.length === cap) {
      list.push({ code: "definition.problemsTruncated", where: "", limit: cap });
    }
    if (refuse) {
      log.leftOut += 1;
    } else {
      log.leftOutWarnings += 1;
    }
    return;
  }
  const problem: DefinitionProblem = { code, where: kernelStructureCut(typeof where === "string" ? where : where(), kernelStructureWhereMax()), message: kernelStructureMessage(code, limit, word) };
  if (limit !== undefined) {
    problem.limit = limit;
  }
  list.push(problem);
}

/** Fills in the truncation markers: "N more problems were left out". */
export function kernelStructureFinish(log: { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number }): void {
  const lists = [log.structure, log.warnings];
  const counts = [log.leftOut, log.leftOutWarnings];
  for (let l = 0; l < 2; l += 1) {
    const list = lists[l] as DefinitionProblem[];
    const last = list[list.length - 1];
    if (last !== undefined && last.code === "definition.problemsTruncated") {
      last.message = String(counts[l]) + " more problems were left out";
    }
  }
}

/**
 * Whether `id` has the shape of a component id: a letter, then letters, digits, `_` or `-`, at
 * most 128 characters. The grammar only: a reserved word has the shape and is refused by
 * {@link kernelStructureIsReservedComponentId}, with a message that names it.
 */
export function kernelStructureIsComponentId(id: unknown): boolean {
  return typeof id === "string" && id.length <= kernelStructureNameMax() && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id);
}

/**
 * Whether `id` is a word no component may take though it has the shape: a word a rule reads as a
 * scope (`component`, `host`, `row`, `ancestor`), so a component given one could never be read
 * by a rule, or a name the translations map cannot key (`constructor`, `prototype`). Mirrors `isReservedComponentId` (core/tree/component-id.ts); a component id only, as no
 * rule reads a layout, journey or page.
 */
export function kernelStructureIsReservedComponentId(id: unknown): boolean {
  switch (id) {
    case "component":
    case "host":
    case "row":
    case "ancestor":
    case "constructor":
    case "prototype":
      return true;
    default:
      return false;
  }
}

/**
 * Whether `id` is a name the translations map cannot key (`__proto__`, `constructor`,
 * `prototype`; `isSafeSegment` in core/localization/translations.ts): a PDF
 * layout, a journey or a page given one keeps texts that can never be translated.
 */
export function kernelStructureIsUnkeyableName(id: unknown): boolean {
  return id === "__proto__" || id === "constructor" || id === "prototype";
}

/**
 * Whether a component's limits contradict each other: `minLength` above `maxLength`, or a
 * number's or a date's `min` above its `max`, each read as the run reads it (a length a finite
 * number of at least one, floored; a bound as `kernelAnswerBounds` reads it for the type). The
 * run ignores such a pair, as no answer could meet both; the check says so.
 */
export function kernelStructureLimitsInverted(type: unknown, configuration: Record<string, unknown>): boolean {
  function length(key: string): number | null {
    const raw = kernelStructureOwn(configuration, key);
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return null;
    }
    const floored = Math.floor(raw);
    return floored >= 1 ? floored : null;
  }
  const minLength = length("minLength");
  const maxLength = length("maxLength");
  if (minLength !== null && maxLength !== null && minLength > maxLength) {
    return true;
  }
  if (type !== "number" && type !== "date") {
    return false;
  }
  const min = kernelAnswerBounds(type, { min: kernelStructureOwn(configuration, "min") }).min;
  const max = kernelAnswerBounds(type, { max: kernelStructureOwn(configuration, "max") }).max;
  return min !== null && max !== null && min > max;
}

/** Whether `key` may be a data key: the path-segment grammar, not digits alone, at most 128 characters. Mirrors `isValidDataKey`. */
export function kernelStructureIsDataKey(key: unknown): boolean {
  return typeof key === "string" && key.length <= kernelStructureNameMax() && /^[A-Za-z0-9_-]+$/.test(key) && !/^\d+$/.test(key);
}

/** Whether a field's `pattern` compiles as the run compiles it (unicode; the source alone, then anchored). */
export function kernelStructurePatternCompiles(source: string): boolean {
  try {
    new RegExp(source, "u");
    new RegExp("^(?:" + source + ")$", "u");
    return true;
  } catch (_error) {
    return false;
  }
}

/** Whether `name` is a name every object has ({@link kernelStructureProtoNames}, as a switch: no list is built per call). */
export function kernelStructureIsProtoName(name: unknown): boolean {
  switch (name) {
    case "constructor":
    case "toString":
    case "valueOf":
    case "hasOwnProperty":
    case "isPrototypeOf":
    case "propertyIsEnumerable":
    case "toLocaleString":
    case "__defineGetter__":
    case "__defineSetter__":
    case "__lookupGetter__":
    case "__lookupSetter__":
    case "prototype":
      return true;
    default:
      return false;
  }
}

/** Whether `holder` has an own key named `__proto__` (a JSON-parsed one is an own key). */
export function kernelStructureHasProtoKey(holder: unknown): boolean {
  return kernelIsPlainRecord(holder) && Object.prototype.hasOwnProperty.call(holder, "__proto__");
}

/** A member of a record that is its own, else `undefined`. */
export function kernelStructureOwn(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * The label of an entry in a `where`: its id when that fits the grammar and 64 characters, else
 * `#<position>`, so an author's odd id (a colon, a control character, a megabyte) never reaches
 * the answer.
 */
export function kernelStructureLabel(value: unknown, position: number): string {
  if (kernelIsPlainRecord(value) && typeof value.id === "string" && value.id.length <= 64 && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value.id)) {
    return value.id;
  }
  return "#" + position;
}

/** A slot name as it appears in a `where`: itself when it is plain and short, else `?`. */
export function kernelStructureSlotLabel(slot: string): string {
  return slot.length <= 32 && /^[A-Za-z0-9_-]+$/.test(slot) ? slot : "?";
}

/** The entries of one walk of a component tree; see {@link kernelStructureCollect}. */
export interface StructureEntries {
  nodes: unknown[];
  parent: number[];
  slot: string[];
  position: number[];
  /** The walk stopped at its limit: the tree has more entries than were collected. */
  truncated: boolean;
}

/**
 * Walks a tree in document order (a parent, then each slot's list in stored key order) with an
 * explicit stack of cursors, and collects at most `max` entries: a record node or a child entry
 * that is not one (so rule 9 can name it). Entry 0 is `root`. Stops at `max` entries and says so,
 * so a hostile tree costs `max` entries and no more, however many it has.
 */
export function kernelStructureCollect(root: unknown, max: number): StructureEntries {
  const entries: StructureEntries = { nodes: [], parent: [], slot: [], position: [], truncated: false };
  entries.nodes.push(root);
  entries.parent.push(-1);
  entries.slot.push("");
  entries.position.push(0);
  const frames: Array<{ owner: number; slots: string[]; k: number; list: unknown[] | undefined; i: number }> = [];
  function open(index: number): void {
    const node = entries.nodes[index];
    if (kernelIsPlainRecord(node) && kernelIsPlainRecord(node.children)) {
      frames.push({ owner: index, slots: Object.keys(node.children), k: 0, list: undefined, i: 0 });
    }
  }
  open(0);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1] as { owner: number; slots: string[]; k: number; list: unknown[] | undefined; i: number };
    if (frame.list === undefined || frame.i >= frame.list.length) {
      // Next slot whose value is a list.
      frame.list = undefined;
      const owner = entries.nodes[frame.owner] as Record<string, unknown>;
      const children = owner.children as Record<string, unknown>;
      while (frame.k < frame.slots.length && frame.list === undefined) {
        const candidate = children[frame.slots[frame.k] as string];
        frame.k += 1;
        if (Array.isArray(candidate)) {
          frame.list = candidate;
          frame.i = 0;
        }
      }
      if (frame.list === undefined) {
        frames.pop();
      }
      continue;
    }
    const position = frame.i;
    const value: unknown = frame.list[position];
    frame.i += 1;
    if (entries.nodes.length >= max) {
      entries.truncated = true;
      break;
    }
    const index = entries.nodes.length;
    entries.nodes.push(value);
    entries.parent.push(frame.owner);
    entries.slot.push(frame.slots[frame.k - 1] as string);
    entries.position.push(position);
    open(index);
  }
  return entries;
}

/** The `where` of entry `index`: `root`, then ` > slot > id` for each step down. */
export function kernelStructureWhere(entries: StructureEntries, index: number): string {
  const steps: string[] = [];
  let at = index;
  while (at > 0) {
    steps.push(kernelStructureSlotLabel(entries.slot[at] as string) + " > " + kernelStructureLabel(entries.nodes[at], entries.position[at] as number));
    at = entries.parent[at] as number;
  }
  let text = "root";
  for (let s = steps.length - 1; s >= 0; s -= 1) {
    text += " > " + (steps[s] as string);
  }
  return text;
}

/**
 * Counts the records of a tree (a journey page's own node, a PDF layout's root) up to `budget`:
 * returns `budget + 1` as soon as there are more. Cursors, not a pending list, so a node with a
 * million children costs `budget` steps.
 */
export function kernelStructureCountTree(root: unknown, budget: number): number {
  let count = 0;
  if (!kernelIsPlainRecord(root)) {
    return 0;
  }
  count = 1;
  const frames: Array<{ slots: string[]; children: Record<string, unknown>; k: number; list: unknown[] | undefined; i: number }> = [];
  function open(node: Record<string, unknown>): void {
    if (kernelIsPlainRecord(node.children)) {
      frames.push({ slots: Object.keys(node.children), children: node.children, k: 0, list: undefined, i: 0 });
    }
  }
  open(root);
  while (frames.length > 0 && count <= budget) {
    const frame = frames[frames.length - 1] as { slots: string[]; children: Record<string, unknown>; k: number; list: unknown[] | undefined; i: number };
    if (frame.list === undefined || frame.i >= frame.list.length) {
      frame.list = undefined;
      while (frame.k < frame.slots.length && frame.list === undefined) {
        const candidate = frame.children[frame.slots[frame.k] as string];
        frame.k += 1;
        if (Array.isArray(candidate)) {
          frame.list = candidate;
          frame.i = 0;
        }
      }
      if (frame.list === undefined) {
        frames.pop();
      }
      continue;
    }
    const value: unknown = frame.list[frame.i];
    frame.i += 1;
    if (kernelIsPlainRecord(value)) {
      count += 1;
      open(value);
    }
  }
  return count;
}

/** The journeys of the definition's `journey` section, as written: a list, or `undefined` when there is none to read. */
export function kernelStructureJourneyList(definition: Record<string, unknown>): unknown[] | undefined {
  const section = definition.journey;
  if (kernelIsPlainRecord(section) && Array.isArray(section.journeys)) {
    return section.journeys;
  }
  return undefined;
}

/** The layouts of the definition's `pdf` section, as written: a list, or `undefined`. */
export function kernelStructureLayoutList(definition: Record<string, unknown>): unknown[] | undefined {
  const section = definition.pdf;
  if (kernelIsPlainRecord(section) && Array.isArray(section.layouts)) {
    return section.layouts;
  }
  return undefined;
}

/**
 * The size gate (rule 40): counts what the caps bound and records a problem for each cap passed.
 * `entries` are the form tree's (collected up to `components + 1`); the journey pages' own nodes
 * and the PDF layouts' trees add to the component count while the budget lasts. Reads lengths
 * only, never the elements of an option list. Returns how many components were counted.
 */
export function kernelStructureSizeGate(
  definition: Record<string, unknown>,
  entries: StructureEntries,
  log: { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number }
): { total: number; exceeded: boolean } {
  const limits = kernelStructureLimits();
  let exceeded = false;
  let total = 0;
  let optionsTotal = 0;
  for (let e = 0; e < entries.nodes.length; e += 1) {
    const node = entries.nodes[e];
    // The root form is not counted: 10,000 components are 10,000 below it.
    if (e > 0) {
      total += 1;
    }
    if (!kernelIsPlainRecord(node)) {
      continue;
    }
    const configuration = node.configuration;
    if (kernelIsPlainRecord(configuration) && Array.isArray(configuration.options)) {
      const length = configuration.options.length;
      optionsTotal += length;
      if (length > limits.optionsPerComponent) {
        exceeded = true;
        kernelStructureAdd(log, "R", "option.tooMany", () => kernelStructureWhere(entries, e), limits.optionsPerComponent);
      }
    }
  }
  if (entries.truncated || total > limits.components) {
    exceeded = true;
    kernelStructureAdd(log, "R", "definition.tooManyComponents", "definition", limits.components);
  } else {
    // Journey own nodes and PDF layout trees count towards the same cap, while the budget lasts.
    const journeys = kernelStructureJourneyList(definition);
    if (journeys !== undefined) {
      for (let j = 0; j < journeys.length && j <= limits.journeys && total <= limits.components; j += 1) {
        const journey: unknown = journeys[j];
        if (!kernelIsPlainRecord(journey) || !Array.isArray(journey.pages)) {
          continue;
        }
        for (let p = 0; p < journey.pages.length && p <= limits.pages && total <= limits.components; p += 1) {
          const page: unknown = journey.pages[p];
          if (!kernelIsPlainRecord(page) || !Array.isArray(page.components)) {
            continue;
          }
          for (let c = 0; c < page.components.length && total <= limits.components; c += 1) {
            total += kernelStructureCountTree(page.components[c], limits.components - total);
          }
        }
      }
    }
    const layouts = kernelStructureLayoutList(definition);
    if (layouts !== undefined) {
      for (let l = 0; l < layouts.length && l <= limits.pdfLayouts && total <= limits.components; l += 1) {
        const layout: unknown = layouts[l];
        if (kernelIsPlainRecord(layout)) {
          total += kernelStructureCountTree(layout.root, limits.components - total);
        }
      }
    }
    if (total > limits.components) {
      exceeded = true;
      kernelStructureAdd(log, "R", "definition.tooManyComponents", "definition", limits.components);
    }
  }
  if (optionsTotal > limits.optionsTotal) {
    exceeded = true;
    kernelStructureAdd(log, "R", "option.total.tooMany", "definition", limits.optionsTotal);
  }
  const localization = definition.localization;
  if (kernelIsPlainRecord(localization) && Array.isArray(localization.supportedLocales) && localization.supportedLocales.length > limits.locales) {
    exceeded = true;
    kernelStructureAdd(log, "R", "localization.tooMany", "localization", limits.locales);
  }
  const journeyList = kernelStructureJourneyList(definition);
  if (journeyList !== undefined) {
    if (journeyList.length > limits.journeys) {
      exceeded = true;
      kernelStructureAdd(log, "R", "journey.tooMany", "journey", limits.journeys);
    }
    let pages = 0;
    for (let j = 0; j < journeyList.length && j <= limits.journeys; j += 1) {
      const journey: unknown = journeyList[j];
      if (kernelIsPlainRecord(journey) && Array.isArray(journey.pages)) {
        pages += journey.pages.length;
        for (let p = 0; p < journey.pages.length && p <= limits.pages; p += 1) {
          const page: unknown = journey.pages[p];
          if (kernelIsPlainRecord(page) && Array.isArray(page.routes) && page.routes.length > limits.routesPerPage) {
            exceeded = true;
            kernelStructureAdd(log, "R", "journey.route.tooMany", "journey:" + kernelStructureLabel(journey, j) + ":page:" + kernelStructureLabel(page, p), limits.routesPerPage);
          }
        }
      }
    }
    if (pages > limits.pages) {
      exceeded = true;
      kernelStructureAdd(log, "R", "journey.page.tooMany", "journey", limits.pages);
    }
  }
  const layoutList = kernelStructureLayoutList(definition);
  if (layoutList !== undefined && layoutList.length > limits.pdfLayouts) {
    exceeded = true;
    kernelStructureAdd(log, "R", "pdf.tooMany", "pdf", limits.pdfLayouts);
  }
  return { total, exceeded };
}

/** Rules 1 to 8 for the definition itself: ids, versions, sections, unknown and prototype keys. */
export function kernelStructureEnvelope(definition: Record<string, unknown>, log: { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number }): void {
  const max = kernelStructureNameMax();
  if (typeof definition.id !== "string" || definition.id === "" || definition.id.length > max) {
    kernelStructureAdd(log, "R", "definition.id.invalid", "definition.id");
  }
  const version = definition.version;
  if (typeof version !== "string" || version === "") {
    kernelStructureAdd(log, "R", "definition.version.invalid", "definition.version");
  } else if (version.length > kernelStructureVersionMax()) {
    kernelStructureAdd(log, "R", "definition.version.tooLong", "definition.version", kernelStructureVersionMax());
  }
  if (typeof definition.schemaVersion !== "string" || definition.schemaVersion === "") {
    kernelStructureAdd(log, "R", "definition.schemaVersion.invalid", "definition.schemaVersion");
  }
  const root = definition.root;
  if (kernelIsPlainRecord(root) && root.type !== "form") {
    kernelStructureAdd(log, "R", "definition.root.type", "root");
  }
  const validateOn = kernelIsPlainRecord(root) && kernelIsPlainRecord(root.configuration) ? root.configuration.validateOn : undefined;
  if (validateOn !== undefined && validateOn !== null && validateOn !== "submit" && validateOn !== "commitAfterError") {
    kernelStructureAdd(log, "W", "validateOn.invalid", "root.configuration.validateOn");
  }
  const sections = ["metadata", "accessibility", "journey"];
  for (let s = 0; s < sections.length; s += 1) {
    const key = sections[s] as string;
    const value = definition[key];
    if (value !== undefined && value !== null && !kernelIsPlainRecord(value)) {
      kernelStructureAdd(log, "R", "definition.section.invalid", "definition." + key);
    }
  }
  const known = kernelStructureDefinitionKeys();
  const keys = Object.keys(definition);
  let unknown = false;
  for (let k = 0; k < keys.length; k += 1) {
    const key = keys[k] as string;
    if (key === "__proto__") {
      kernelStructureAdd(log, "R", "definition.key.prototype", "definition");
    } else if (known.indexOf(key) < 0) {
      unknown = true;
    }
  }
  if (unknown) {
    kernelStructureAdd(log, "W", "definition.key.unknown", "definition");
  }
}

/** A trie node of the places answers are stored at; see {@link kernelStructurePlaces}. */
export interface StructurePlace {
  parent: StructurePlace | null;
  piece: string;
  /** Built when the first child is added. */
  kids: Record<string, StructurePlace> | undefined;
  claims: Array<{ place: StructurePlace; kind: string; entry: number }>;
}

/** A new, empty place (the root of the trie is the empty path). */
export function kernelStructureNewPlace(parent: StructurePlace | null, piece: string): StructurePlace {
  return { parent, piece, kids: undefined, claims: [] };
}

/**
 * The place for `text` below `from`. A path is cut into pieces before every `.` or `[` that is not
 * its first character, so `items[].sku` is `items`, `[]`, `.sku` and a nearest-ancestor lookup is
 * a walk up the trie (the engine's `findDataKeyProblems` slices the string at each separator; this
 * costs the length of `text` once, however many places share a prefix). `atStart` says `text`
 * begins the whole path, so a separator at index 0 is not a cut.
 */
export function kernelStructurePlaceAt(from: StructurePlace, text: string, atStart: boolean): StructurePlace {
  let place = from;
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const code = i < text.length ? text.charCodeAt(i) : -1;
    const boundary = i === text.length || ((code === 46 || code === 91) && (i > 0 || !atStart));
    if (!boundary || i === start) {
      continue;
    }
    const piece = text.slice(start, i);
    if (place.kids === undefined) {
      place.kids = Object.create(null) as Record<string, StructurePlace>;
    }
    let next: StructurePlace | undefined = place.kids[piece];
    if (next === undefined) {
      next = kernelStructureNewPlace(place, piece);
      place.kids[piece] = next;
    }
    place = next;
    start = i;
  }
  return place;
}

/**
 * The place for `segment` below `from`, joined with `separator` (`""` for the first segment of a
 * path, `"."` after it). The common segment holds no `.` or `[`, so it is one piece and costs two
 * searches; one that does is cut as {@link kernelStructurePlaceAt} cuts a path.
 */
export function kernelStructurePlaceChild(from: StructurePlace, separator: string, segment: string): StructurePlace {
  if (segment.indexOf(".") >= 0 || segment.indexOf("[") >= 0) {
    return kernelStructurePlaceAt(from, separator + segment, separator === "");
  }
  const piece = separator + segment;
  if (from.kids === undefined) {
    from.kids = Object.create(null) as Record<string, StructurePlace>;
  }
  let next: StructurePlace | undefined = from.kids[piece];
  if (next === undefined) {
    next = kernelStructureNewPlace(from, piece);
    from.kids[piece] = next;
  }
  return next;
}

/** Whether a place is stored at by two components of which one is not a data-scoping container. */
export function kernelStructurePlaceShared(place: StructurePlace): boolean {
  if (place.claims.length < 2) {
    return false;
  }
  for (let c = 0; c < place.claims.length; c += 1) {
    if ((place.claims[c] as { kind: string }).kind !== "object") {
      return true;
    }
  }
  return false;
}

/**
 * Whether a component holds an answer of its own: a copy of `kernelFoldHoldsOwnAnswer`
 * (`core/state/submittable-fold.ts`), which the module list of the kernel keeps in step.
 */
export function kernelStructureHoldsAnswer(node: Record<string, unknown>): boolean {
  if (node.collection !== undefined || node.children !== undefined) {
    return false;
  }
  switch (node.type) {
    case "form":
    case "fieldset":
    case "panel":
    case "grid":
    case "tabs":
    case "tab":
    case "steps":
    case "step":
    case "repeatingSection":
    case "dataGrid":
    case "container":
    case "button":
    case "html":
    case "image":
    case "signature":
      return false;
    default:
      return true;
  }
}

/** The most rows a data grid's bounds may name: `DATA_GRID_ROWS_CAP` (core/schema/data-grid.ts). */
export function kernelStructureGridRowsCap(): number {
  return 500;
}

/**
 * Whether a data grid's `minRows`, `maxRows` and `initialRows` are usable as written:
 * each absent or a whole number from 0 to {@link kernelStructureGridRowsCap}, and `minRows` no
 * more than `maxRows` when both are. What the builder flags under the Rows boxes; the form reads
 * an unusable one as `dataGridSettingsOf` does.
 */
export function kernelStructureGridBoundsUsable(configuration: Record<string, unknown>): boolean {
  const cap = kernelStructureGridRowsCap();
  const names = ["minRows", "maxRows", "initialRows"];
  for (let n = 0; n < names.length; n += 1) {
    const value = kernelStructureOwn(configuration, names[n] as string);
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > cap)) {
      return false;
    }
  }
  const min = kernelStructureOwn(configuration, "minRows");
  const max = kernelStructureOwn(configuration, "maxRows");
  return !(typeof min === "number" && typeof max === "number" && min > max);
}

/**
 * Walks the form tree once, in the order the entries were collected, and applies rules 9 to 27 to
 * each node (shapes, id, type, data key, options) while placing each component in the trie of
 * places its answer is stored at. Then reads the trie for rules 22 and 23: two components at one
 * place, one place nested under a place that cannot hold it.
 */
export function kernelStructureNodes(
  entries: StructureEntries,
  types: string[] | undefined,
  log: { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number },
  kinds?: unknown
): { ids: Record<string, true> } {
  const ids = Object.create(null) as Record<string, true>;
  const typeSet = Object.create(null) as Record<string, true>;
  if (types !== undefined) {
    for (let t = 0; t < types.length; t += 1) {
      typeSet[types[t] as string] = true;
    }
  }
  const nodeKeys = kernelStructureNodeKeys();
  const nameMax = kernelStructureNameMax();
  const pathMax = kernelStructurePathMax();
  const pathBudget = { left: kernelStructurePathsMax(), over: false };
  const patternMax = kernelRegexPatternMax();
  const largeOptions = kernelStructureLargeOptions();
  const placeRoot = kernelStructureNewPlace(null, "");
  const childPrefix: Array<StructurePlace | undefined> = [];
  const slots: Array<{ place: StructurePlace; kind: string; entry: number }> = [];
  childPrefix.push(placeRoot);

  for (let e = 0; e < entries.nodes.length; e += 1) {
    const node = entries.nodes[e];
    if (!kernelIsPlainRecord(node)) {
      childPrefix.push(undefined);
      kernelStructureAdd(log, "R", "component.notRecord", () => kernelStructureWhere(entries, e));
      continue;
    }
    if (e > 0) {
      childPrefix.push(undefined);
    }

    // Shapes: keys, children, configuration, collection (rules 8 to 13).
    const keys = Object.keys(node);
    let unknownKey = false;
    for (let k = 0; k < keys.length; k += 1) {
      const key = keys[k] as string;
      if (key === "__proto__") {
        kernelStructureAdd(log, "R", "definition.key.prototype", () => kernelStructureWhere(entries, e));
      } else if (nodeKeys.indexOf(key) < 0) {
        unknownKey = true;
      }
    }
    if (unknownKey) {
      kernelStructureAdd(log, "W", "component.key.unknown", () => kernelStructureWhere(entries, e));
    }
    const children = node.children;
    if (children !== undefined && children !== null) {
      if (!kernelIsPlainRecord(children)) {
        kernelStructureAdd(log, "R", "component.children.invalid", () => kernelStructureWhere(entries, e));
      } else {
        const slotNames = Object.keys(children);
        let badSlot = false;
        for (let s = 0; s < slotNames.length; s += 1) {
          const name = slotNames[s] as string;
          if (name === "__proto__") {
            kernelStructureAdd(log, "R", "definition.key.prototype", () => kernelStructureWhere(entries, e));
          }
          if (!Array.isArray(children[name])) {
            badSlot = true;
          }
        }
        if (badSlot) {
          kernelStructureAdd(log, "R", "component.children.invalid", () => kernelStructureWhere(entries, e));
        }
      }
    }
    const configurationValue = node.configuration;
    const configuration = kernelIsPlainRecord(configurationValue) ? configurationValue : undefined;
    if (configurationValue !== undefined && configurationValue !== null && configuration === undefined) {
      kernelStructureAdd(log, "R", "component.configuration.invalid", () => kernelStructureWhere(entries, e));
    }
    const collectionValue = node.collection;
    let collectionPath: string | undefined = undefined;
    if (collectionValue !== undefined) {
      if (!kernelIsPlainRecord(collectionValue)) {
        kernelStructureAdd(log, "R", "component.collection.invalid", () => kernelStructureWhere(entries, e));
      } else {
        if (kernelStructureHasProtoKey(collectionValue)) {
          kernelStructureAdd(log, "R", "definition.key.prototype", () => kernelStructureWhere(entries, e));
        }
        if (collectionValue.collectionPath !== undefined && typeof collectionValue.collectionPath !== "string") {
          kernelStructureAdd(log, "R", "component.collection.invalid", () => kernelStructureWhere(entries, e));
        } else if (typeof collectionValue.collectionPath === "string") {
          collectionPath = collectionValue.collectionPath;
        }
      }
    }
    if (node.rules !== undefined && kernelStructureHasProtoKey(node.rules)) {
      kernelStructureAdd(log, "R", "definition.key.prototype", () => kernelStructureWhere(entries, e));
    }

    // Id (rules 14 to 16).
    const id = node.id;
    // A reserved word is named before the grammar is read: it has the shape, and the message says which word it is.
    if (kernelStructureIsReservedComponentId(id)) {
      kernelStructureAdd(log, "R", "component.id.reserved", () => kernelStructureWhere(entries, e), undefined, id as string);
    } else if (!kernelStructureIsComponentId(id)) {
      kernelStructureAdd(log, "R", "component.id.invalid", () => kernelStructureWhere(entries, e));
    } else if (kernelStructureIsProtoName(id)) {
      kernelStructureAdd(log, "W", "component.id.prototypeName", () => kernelStructureWhere(entries, e));
    }
    // A longer id is refused already and is not hashed or placed: a megabyte id costs its length once.
    if (typeof id === "string" && id.length <= nameMax) {
      if (Object.prototype.hasOwnProperty.call(ids, id)) {
        kernelStructureAdd(log, "R", "component.id.duplicate", () => kernelStructureWhere(entries, e));
      } else {
        ids[id] = true;
      }
    }

    // Type (rules 17 and 18).
    const type = node.type;
    if (typeof type !== "string" || type === "" || type.length > nameMax) {
      kernelStructureAdd(log, "R", "component.type.invalid", () => kernelStructureWhere(entries, e));
    } else if (types !== undefined && e > 0 && !Object.prototype.hasOwnProperty.call(typeSet, type)) {
      kernelStructureAdd(log, "W", "component.type.unknown", () => kernelStructureWhere(entries, e));
    }

    // Data key and paths (rules 19 to 21).
    const dataKey = configuration === undefined ? undefined : kernelStructureOwn(configuration, "dataKey");
    if (dataKey !== undefined && dataKey !== null && dataKey !== "") {
      if (!kernelStructureIsDataKey(dataKey)) {
        kernelStructureAdd(log, "R", "component.dataKey.invalid", () => kernelStructureWhere(entries, e));
      } else if (dataKey === "__proto__") {
        kernelStructureAdd(log, "R", "component.dataKey.prototype", () => kernelStructureWhere(entries, e));
      } else if (kernelStructureIsProtoName(dataKey)) {
        kernelStructureAdd(log, "W", "component.dataKey.prototypeName", () => kernelStructureWhere(entries, e));
      }
    }
    // A data grid's rows live at its collection path like a section's: one path to read.
    const text = collectionPath;
    if (text !== undefined) {
      if (text.length > pathMax) {
        kernelStructureAdd(log, "R", "component.path.tooLong", () => kernelStructureWhere(entries, e), pathMax);
      } else if (text === "__proto__") {
        kernelStructureAdd(log, "R", "component.dataKey.prototype", () => kernelStructureWhere(entries, e));
      } else if (kernelStructureIsProtoName(text)) {
        kernelStructureAdd(log, "W", "component.dataKey.prototypeName", () => kernelStructureWhere(entries, e));
      }
    }

    // A data grid's row bounds: whole numbers within the cap, the minimum no more than
    // the maximum. A warning: the form reads an unusable bound as its default and runs.
    if (type === "dataGrid" && configuration !== undefined && !kernelStructureGridBoundsUsable(configuration)) {
      kernelStructureAdd(log, "W", "component.dataGrid.bounds", () => kernelStructureWhere(entries, e), kernelStructureGridRowsCap());
    }
    // A row-bound formula (`rules.minRows` / `rules.maxRows`) is read on a data grid
    // only; on any other component nothing evaluates it. A warning: the form runs as written.
    // Read by truthiness, as the fold and the stage read every rule: `minRows: ""`, `0` or
    // `false` is no rule, so nothing is said about it.
    if (type !== "dataGrid" && kernelIsPlainRecord(node.rules)) {
      const minRule = kernelStructureOwn(node.rules, "minRows");
      const maxRule = kernelStructureOwn(node.rules, "maxRows");
      if (Boolean(minRule) || Boolean(maxRule)) {
        kernelStructureAdd(log, "W", "component.dataGrid.boundsRule", () => kernelStructureWhere(entries, e));
      }
    }

    // A pattern longer than the kernel reads: the run would treat it as risky and never run it.
    const patternText = configuration === undefined ? undefined : kernelStructureOwn(configuration, "pattern");
    if (typeof patternText === "string" && patternText.length > patternMax) {
      kernelStructureAdd(log, "R", "component.pattern.tooLong", () => kernelStructureWhere(entries, e), patternMax);
    } else if (typeof patternText === "string" && patternText !== "" && !kernelStructurePatternCompiles(patternText)) {
      // A pattern that does not compile (an inline flag such as `(?i)`, an unbalanced bracket):
      // no answer can be shown to match it, so under the default policy the run, in the browser
      // and at the server, refuses every non-empty answer the person gives.
      kernelStructureAdd(log, "R", "component.pattern.invalid", () => kernelStructureWhere(entries, e));
    }

    // Limits that contradict each other: the run ignores the pair, so the field has neither.
    if (e > 0 && configuration !== undefined && kernelStructureLimitsInverted(kernelKindBase(String(type), kinds), configuration)) {
      kernelStructureAdd(log, "W", "component.limits.inverted", () => kernelStructureWhere(entries, e));
    }

    // Options (rules 24 to 27).
    const options = configuration === undefined ? undefined : kernelStructureOwn(configuration, "options");
    if (options !== undefined && options !== null) {
      if (!Array.isArray(options)) {
        kernelStructureAdd(log, "W", "option.list.invalid", () => kernelStructureWhere(entries, e));
      } else {
        let badEntry = false;
        let duplicate = false;
        const seen = Object.create(null) as Record<string, true>;
        for (let o = 0; o < options.length; o += 1) {
          const option: unknown = options[o];
          if (
            !kernelIsPlainRecord(option) ||
            typeof option.value !== "string" ||
            (option.label !== undefined && typeof option.label !== "string" && !kernelIsPlainRecord(option.label)) ||
            (option.description !== undefined && typeof option.description !== "string" && !kernelIsPlainRecord(option.description))
          ) {
            badEntry = true;
            continue;
          }
          if (Object.prototype.hasOwnProperty.call(seen, option.value)) {
            duplicate = true;
          } else {
            seen[option.value] = true;
          }
        }
        if (badEntry) {
          kernelStructureAdd(log, "W", "option.entry.invalid", () => kernelStructureWhere(entries, e));
        }
        if (duplicate) {
          kernelStructureAdd(log, "W", "option.value.duplicate", () => kernelStructureWhere(entries, e));
        }
        if (options.length > largeOptions) {
          kernelStructureAdd(log, "W", "option.count.large", () => kernelStructureWhere(entries, e), largeOptions);
        }
      }
    }

    // The place this component's answer is stored at (the engine's findDataKeyProblems).
    let prefix: StructurePlace | undefined = e === 0 ? placeRoot : childPrefix[entries.parent[e] as number];
    if (e === 0) {
      childPrefix[0] = placeRoot;
      continue;
    }
    if (prefix === undefined) {
      prefix = placeRoot;
    }
    childPrefix[e] = prefix;
    if (typeof id !== "string" || id.length > nameMax) {
      continue;
    }
    const atRoot = prefix === placeRoot;
    if (node.collection !== undefined) {
      // Where a repeating section's entries live: its collection path as written, else its id.
      if (kernelIsPlainRecord(node.collection)) {
        const configured = collectionPath !== undefined && collectionPath.length > 0 ? collectionPath : id;
        if (configured.length > 0 && configured.length <= pathMax && (configured === id || kernelStructureSpendPath(log, pathBudget, configured.length))) {
          const place = kernelStructurePlaceAt(placeRoot, configured, true);
          const claim = { place, kind: "array", entry: e };
          slots.push(claim);
          place.claims.push(claim);
          childPrefix[e] = kernelStructurePlaceAt(place, "[]", false);
        }
      }
      continue;
    }
    const scopes = type === "container" && (configuration === undefined || configuration.scopeData !== false);
    if (!scopes && !kernelStructureHoldsAnswer(node)) {
      continue;
    }
    // The segment is the data key when it fits the grammar (any length, as the engine reads it), else the id.
    const segment = typeof dataKey === "string" && dataKey.length <= pathMax && /^[A-Za-z0-9_-]+$/.test(dataKey) && !/^\d+$/.test(dataKey) ? dataKey : id;
    if (segment === "" || segment.length > pathMax) {
      continue;
    }
    const own = atRoot ? kernelStructurePlaceChild(placeRoot, "", segment) : kernelStructurePlaceChild(prefix, ".", segment);
    const kind = scopes ? "object" : "value";
    const claim = { place: own, kind, entry: e };
    slots.push(claim);
    own.claims.push(claim);
    if (scopes) {
      childPrefix[e] = own;
    }
  }

  // Rule 22: two components at one place (reported at the first that conflicts with an earlier one).
  for (let s = 0; s < slots.length; s += 1) {
    const slot = slots[s] as { place: StructurePlace; kind: string; entry: number };
    const claims = slot.place.claims;
    if (claims.length < 2 || (claims[0] as { entry: number }).entry !== slot.entry) {
      continue;
    }
    if (kernelStructurePlaceShared(slot.place)) {
      let clash = -1;
      let earlierValue = (claims[0] as { kind: string }).kind !== "object";
      for (let c = 1; c < claims.length && clash < 0; c += 1) {
        const kind = (claims[c] as { kind: string }).kind;
        if (earlierValue || kind !== "object") {
          clash = c;
        }
        earlierValue = earlierValue || kind !== "object";
      }
      kernelStructureAdd(log, "R", "component.dataPath.duplicate", () => kernelStructureWhere(entries, (claims[clash < 0 ? 1 : clash] as { entry: number }).entry));
    }
  }
  // Rule 23: a place nested under the nearest place above it that cannot hold it.
  for (let s = 0; s < slots.length; s += 1) {
    const slot = slots[s] as { place: StructurePlace; kind: string; entry: number };
    let below: StructurePlace = slot.place;
    let above: StructurePlace | null = slot.place.parent;
    while (above !== null && above.claims.length === 0) {
      below = above;
      above = above.parent;
    }
    if (above === null || kernelStructurePlaceShared(above)) {
      continue;
    }
    const nestedAs = below.piece.charAt(0) === "." ? "object" : "array";
    let clashes = false;
    for (let c = 0; c < above.claims.length; c += 1) {
      if ((above.claims[c] as { kind: string }).kind !== nestedAs) {
        clashes = true;
      }
    }
    if (clashes && slot.place.claims[0] !== undefined) {
      kernelStructureAdd(log, "R", "component.dataPath.conflict", () => kernelStructureWhere(entries, slot.entry));
    }
  }
  return { ids };
}

/** Rules 28 and 29: the localization section. */
export function kernelStructureLocalization(definition: Record<string, unknown>, log: { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number }): void {
  const section = definition.localization;
  if (section === undefined || section === null) {
    return;
  }
  if (!kernelIsPlainRecord(section)) {
    kernelStructureAdd(log, "R", "localization.invalid", "localization");
    return;
  }
  function goodCode(code: unknown): boolean {
    return typeof code === "string" && code.length <= kernelStructureLocaleMax() && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(code);
  }
  const codes: string[] = [];
  const supported = section.supportedLocales;
  let duplicate = false;
  if (supported !== undefined && supported !== null) {
    if (!Array.isArray(supported)) {
      kernelStructureAdd(log, "R", "localization.invalid", "localization");
    } else {
      const seen = Object.create(null) as Record<string, true>;
      for (let s = 0; s < supported.length; s += 1) {
        const entry: unknown = supported[s];
        let code: unknown = undefined;
        let ok = false;
        if (kernelIsPlainRecord(entry)) {
          code = entry.code;
          ok = goodCode(entry.code) && (entry.label === undefined || typeof entry.label === "string");
        }
        if (!ok) {
          kernelStructureAdd(log, "R", "localization.invalid", "localization");
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(seen, code as string)) {
          duplicate = true;
        } else {
          seen[code as string] = true;
          codes.push(code as string);
        }
      }
    }
  }
  const defaultLocale = section.defaultLocale;
  if (defaultLocale !== undefined && defaultLocale !== null) {
    if (!goodCode(defaultLocale)) {
      kernelStructureAdd(log, "R", "localization.invalid", "localization");
    } else if (codes.length > 0 && codes.indexOf(defaultLocale as string) < 0) {
      kernelStructureAdd(log, "W", "localization.defaultLocale.unknown", "localization");
    }
  }
  if (duplicate) {
    kernelStructureAdd(log, "W", "localization.locale.duplicate", "localization");
  }
}

/**
 * The definition's `kinds` map (`FormDefinition.kinds`): a record of at most
 * {@link kernelStructureTypesMax} entries, each a type of 1 to {@link kernelStructureNameMax}
 * characters that is not an engine type, naming an answer-bearing engine type or a plain
 * container as its base (`kernelIsKindBase`). Each refusal is reported once, at
 * `definition.kinds`. The usable entries' types are returned, so the host's type list (rule 18)
 * counts them as known: such a type is drawn as its base, and validated as it when the base
 * holds an answer.
 */
export function kernelStructureKinds(definition: Record<string, unknown>, log: { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number }): string[] {
  const section = definition.kinds;
  const usable: string[] = [];
  if (section === undefined || section === null) {
    return usable;
  }
  if (!kernelIsPlainRecord(section)) {
    kernelStructureAdd(log, "R", "kinds.invalid", "definition.kinds");
    return usable;
  }
  const types = Object.keys(section);
  if (types.length > kernelStructureTypesMax()) {
    kernelStructureAdd(log, "R", "kinds.tooMany", "definition.kinds", kernelStructureTypesMax());
    return usable;
  }
  const seen = Object.create(null) as Record<string, true>;
  for (let t = 0; t < types.length; t += 1) {
    const type = types[t] as string;
    let code = "";
    if (type === "" || type.length > kernelStructureNameMax() || type === "__proto__") {
      code = "kinds.type.invalid";
    } else if (kernelIsEngineType(type)) {
      code = "kinds.type.engine";
    } else if (!kernelIsKindBase(section[type])) {
      code = "kinds.base.invalid";
    }
    if (code === "") {
      usable.push(type);
    } else if (seen[code] !== true) {
      seen[code] = true;
      kernelStructureAdd(log, "R", code, "definition.kinds");
    }
  }
  return usable;
}

/** Rules 30 to 36: the journeys. `isJourney` is the shape the run applies (`kernelIsJourney`). */
export function kernelStructureJourneys(
  definition: Record<string, unknown>,
  ids: Record<string, true>,
  rootId: unknown,
  isJourney: (value: unknown) => boolean,
  log: { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number }
): void {
  const section = definition.journey;
  if (!kernelIsPlainRecord(section)) {
    return;
  }
  if (kernelStructureHasProtoKey(section)) {
    kernelStructureAdd(log, "R", "definition.key.prototype", "journey");
  }
  const journeys = section.journeys;
  if (journeys === undefined || journeys === null) {
    return;
  }
  if (!Array.isArray(journeys)) {
    kernelStructureAdd(log, "R", "journey.invalid", "journey");
    return;
  }
  const limits = kernelStructureLimits();
  const seenJourneys = Object.create(null) as Record<string, true>;
  for (let j = 0; j < journeys.length && j <= limits.journeys; j += 1) {
    const journey: unknown = journeys[j];
    const holder = "journey:" + kernelStructureLabel(journey, j);
    if (!kernelIsPlainRecord(journey)) {
      kernelStructureAdd(log, "R", "journey.invalid", holder);
      continue;
    }
    if (kernelStructureIsUnkeyableName(journey.id)) {
      kernelStructureAdd(log, "R", "journey.id.reserved", holder, undefined, journey.id as string);
    }
    if (typeof journey.id === "string") {
      if (Object.prototype.hasOwnProperty.call(seenJourneys, journey.id)) {
        kernelStructureAdd(log, "R", "journey.id.duplicate", holder);
      } else {
        seenJourneys[journey.id] = true;
      }
    }
    const shaped = isJourney(journey);
    if (!shaped) {
      kernelStructureAdd(log, "R", "journey.invalid", holder);
    }
    const pages = journey.pages;
    if (!Array.isArray(pages)) {
      continue;
    }
    // Page ids: unique within the journey (the shape check refuses a repeat too).
    const pageIndex = Object.create(null) as Record<string, number>;
    for (let p = 0; p < pages.length && p <= limits.pages; p += 1) {
      const page: unknown = pages[p];
      // A page's own `when` is what makes the journey invalid (the shape check refuses it); say so
      // at the page, beside `journey.invalid`.
      if (kernelIsPlainRecord(page) && page.when !== undefined) {
        kernelStructureAdd(log, "R", "journey.page.when", holder + ":page:" + kernelStructureLabel(page, p));
      }
      if (!kernelIsPlainRecord(page) || typeof page.id !== "string") {
        continue;
      }
      if (kernelStructureIsUnkeyableName(page.id)) {
        kernelStructureAdd(log, "R", "journey.page.id.reserved", holder + ":page:" + kernelStructureLabel(page, p), undefined, page.id);
      }
      if (Object.prototype.hasOwnProperty.call(pageIndex, page.id)) {
        kernelStructureAdd(log, "R", "journey.page.duplicateId", holder + ":page:" + kernelStructureLabel(page, p));
      } else {
        pageIndex[page.id] = p;
      }
    }
    if (!shaped) {
      continue;
    }
    for (let p = 0; p < pages.length && p <= limits.pages; p += 1) {
      const page = pages[p] as Record<string, unknown>;
      const pageWhere = holder + ":page:" + kernelStructureLabel(page, p);
      if (typeof page.id === "string" && Object.prototype.hasOwnProperty.call(ids, page.id)) {
        kernelStructureAdd(log, "W", "journey.page.idIsComponentId", pageWhere);
      }
      if (Array.isArray(page.components)) {
        let unknownComponent = false;
        for (let c = 0; c < page.components.length; c += 1) {
          const entry: unknown = page.components[c];
          if (typeof entry === "string" && (!Object.prototype.hasOwnProperty.call(ids, entry) || entry === rootId)) {
            unknownComponent = true;
          }
        }
        if (unknownComponent) {
          kernelStructureAdd(log, "W", "journey.page.unknownComponent", pageWhere);
        }
      }
      if (Array.isArray(page.routes)) {
        for (let r = 0; r < page.routes.length && r <= limits.routesPerPage; r += 1) {
          const route: unknown = page.routes[r];
          if (!kernelIsPlainRecord(route) || typeof route.to !== "string" || route.to === "$end") {
            continue;
          }
          const routeWhere = pageWhere + ":route:" + r;
          if (!Object.prototype.hasOwnProperty.call(pageIndex, route.to)) {
            kernelStructureAdd(log, "W", "journey.route.unknownTarget", routeWhere);
          } else if ((pageIndex[route.to] as number) <= p) {
            kernelStructureAdd(log, "W", "journey.route.backward", routeWhere);
          }
        }
      }
    }
  }
}

/** Rules 37 to 39: the PDF configuration's envelope (the rest is the PDF program's). */
export function kernelStructurePdf(definition: Record<string, unknown>, log: { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number }): void {
  const section = definition.pdf;
  if (section === undefined || section === null) {
    return;
  }
  if (!kernelIsPlainRecord(section)) {
    kernelStructureAdd(log, "R", "pdf.invalid", "pdf");
    return;
  }
  if (kernelStructureHasProtoKey(section)) {
    kernelStructureAdd(log, "R", "definition.key.prototype", "pdf");
  }
  const layouts = section.layouts;
  const names = Object.create(null) as Record<string, true>;
  if (layouts !== undefined && layouts !== null) {
    if (!Array.isArray(layouts)) {
      kernelStructureAdd(log, "R", "pdf.invalid", "pdf");
    } else {
      const limits = kernelStructureLimits();
      for (let l = 0; l < layouts.length && l <= limits.pdfLayouts; l += 1) {
        const layout: unknown = layouts[l];
        const where = "pdf:" + kernelStructureLabel(layout, l);
        if (!kernelIsPlainRecord(layout)) {
          kernelStructureAdd(log, "R", "pdf.layout.invalid", where);
          continue;
        }
        const id = layout.id;
        let sound = typeof id === "string" && id.trim() !== "";
        if (layout.kind === "generated") {
          const root = layout.root;
          sound = sound && kernelIsPlainRecord(root) && typeof root.id === "string" && typeof root.type === "string";
        } else if (layout.kind === "template") {
          const template = layout.template;
          sound = sound && kernelIsPlainRecord(template) && typeof template.storage === "string" && template.storage !== "";
        } else {
          sound = false;
        }
        if (!sound) {
          kernelStructureAdd(log, "R", "pdf.layout.invalid", where);
        }
        if (kernelStructureIsUnkeyableName(id)) {
          kernelStructureAdd(log, "R", "pdf.layout.id.reserved", where, undefined, id as string);
        }
        if (typeof id === "string") {
          if (id.length > kernelStructureNameMax()) {
            kernelStructureAdd(log, "R", "pdf.layout.idTooLong", where, kernelStructureNameMax());
          }
          if (Object.prototype.hasOwnProperty.call(names, id)) {
            kernelStructureAdd(log, "R", "pdf.layout.duplicateId", where);
          } else {
            names[id] = true;
          }
        }
      }
    }
  }
  const fallback = section.defaultLayoutId;
  if (fallback !== undefined && fallback !== null && (typeof fallback !== "string" || !Object.prototype.hasOwnProperty.call(names, fallback))) {
    kernelStructureAdd(log, "W", "pdf.defaultLayoutId.unknown", "pdf");
  }
}

/**
 * The ids of the form's authored chrome parts (`root.configuration.chrome`): the
 * key a part's translations live under, so every part, in the header, the footer and the groups
 * inside them (`parts`, 32 levels at most), needs one of its own. A part with no id, or one that
 * cannot key a translation (empty, `__proto__`, `constructor`, `prototype`, not a text), is
 * `chrome.part.id.missing`: the form draws it untranslated, or not at all. Every part of an id
 * more than one part carries is `chrome.part.id.duplicate`: which part a translation was written
 * for is not knowable, so each draws untranslated. `where` is the part's place,
 * `chrome:<region>:<index>[.<index>...]`, never its id.
 */
export function kernelStructureChromeIds(
  definition: Record<string, unknown>,
  log: { structure: DefinitionProblem[]; warnings: DefinitionProblem[]; leftOut: number; leftOutWarnings: number }
): void {
  const root = definition.root;
  const configuration = kernelIsPlainRecord(root) ? root.configuration : undefined;
  const chrome = kernelIsPlainRecord(configuration) ? kernelStructureOwn(configuration, "chrome") : undefined;
  if (!kernelIsPlainRecord(chrome)) {
    return;
  }
  const found: Array<{ id: unknown; where: string }> = [];
  const regions = ["header", "footer"];
  for (let r = 0; r < regions.length; r += 1) {
    const stack: Array<{ parts: unknown; where: string; depth: number }> = [
      { parts: kernelStructureOwn(chrome, regions[r] as string), where: "chrome:" + regions[r], depth: 1 }
    ];
    while (stack.length > 0) {
      const top = stack.pop() as { parts: unknown; where: string; depth: number };
      if (!Array.isArray(top.parts) || top.depth > kernelMaxComponentDepth()) {
        continue;
      }
      const pending: Array<{ parts: unknown; where: string; depth: number }> = [];
      for (let p = 0; p < top.parts.length; p += 1) {
        const part: unknown = top.parts[p];
        if (!kernelIsPlainRecord(part)) {
          continue;
        }
        const where = top.where + (top.depth === 1 ? ":" : ".") + p;
        found.push({ id: kernelStructureOwn(part, "id"), where });
        pending.push({ parts: kernelStructureOwn(part, "parts"), where, depth: top.depth + 1 });
      }
      // Document order: a group's parts before the next part.
      for (let q = pending.length - 1; q >= 0; q -= 1) {
        stack.push(pending[q] as { parts: unknown; where: string; depth: number });
      }
    }
  }
  const counts = Object.create(null) as Record<string, number>;
  const keyed: boolean[] = [];
  for (let f = 0; f < found.length; f += 1) {
    const id = (found[f] as { id: unknown }).id;
    const usable = typeof id === "string" && id !== "" && id !== "__proto__" && id !== "constructor" && id !== "prototype";
    keyed.push(usable);
    if (usable) {
      counts[id as string] = (Object.prototype.hasOwnProperty.call(counts, id as string) ? (counts[id as string] as number) : 0) + 1;
    }
  }
  for (let f = 0; f < found.length; f += 1) {
    const entry = found[f] as { id: unknown; where: string };
    if (!keyed[f]) {
      kernelStructureAdd(log, "R", "chrome.part.id.missing", entry.where);
    } else if ((counts[entry.id as string] as number) > 1) {
      kernelStructureAdd(log, "R", "chrome.part.id.duplicate", entry.where);
    }
  }
}

/**
 * The structure pass over a definition whose `root` is a record (the entry point checked that and
 * the depth). Collects the form tree up to the component cap, runs the size gate, and when no cap
 * is passed reads every rule in document order. `types` is the host's list of component types,
 * `undefined` when it sent none (rule 18 is then off); `isJourney` is the shape the run applies.
 */
export function kernelStructureCheck(definition: Record<string, unknown>, types: string[] | undefined, isJourney?: (value: unknown) => boolean): StructureCheck {
  const log = kernelStructureNewLog();
  const limits = kernelStructureLimits();
  const entries = kernelStructureCollect(definition.root, limits.components + 2);
  const gate = kernelStructureSizeGate(definition, entries, log);
  if (gate.exceeded) {
    kernelStructureFinish(log);
    return { structure: log.structure, structureWarnings: [], sizeGate: true };
  }
  kernelStructureEnvelope(definition, log);
  // A type the definition's `kinds` map gives a base is drawn as that base: known to the host.
  const mapped = kernelStructureKinds(definition, log);
  const found = kernelStructureNodes(entries, types !== undefined && mapped.length > 0 ? types.concat(mapped) : types, log, definition.kinds);
  kernelStructureLocalization(definition, log);
  kernelStructureChromeIds(definition, log);
  const shape =
    typeof isJourney === "function"
      ? isJourney
      : function (value: unknown): boolean {
          return kernelIsPlainRecord(value) && typeof value.id === "string" && value.id !== "" && Array.isArray(value.pages);
        };
  const root = definition.root;
  kernelStructureJourneys(definition, found.ids, kernelIsPlainRecord(root) ? root.id : undefined, shape, log);
  kernelStructurePdf(definition, log);
  if (gate.total > kernelStructureLargeComponents()) {
    kernelStructureAdd(log, "W", "definition.components.large", "definition", kernelStructureLargeComponents());
  }
  kernelStructureFinish(log);
  return { structure: log.structure, structureWarnings: log.warnings, sizeGate: false };
}

/** This module's kernel functions, for `PORTABLE_KERNEL_FUNCTIONS`. */
export const STRUCTURE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelStructureLimits,
  kernelStructureLargeComponents,
  kernelStructureLargeOptions,
  kernelStructureSeverity,
  kernelStructureNameMax,
  kernelStructurePathMax,
  kernelStructurePathsMax,
  kernelStructureSpendPath,
  kernelStructureVersionMax,
  kernelStructureWhereMax,
  kernelStructureLocaleMax,
  kernelStructureTypesMax,
  kernelStructureProtoNames,
  kernelStructureNodeKeys,
  kernelStructureDefinitionKeys,
  kernelStructureTypesValid,
  kernelStructureMessage,
  kernelStructureNewLog,
  kernelStructureCut,
  kernelStructureAdd,
  kernelStructureFinish,
  kernelStructureIsComponentId,
  kernelStructureIsReservedComponentId,
  kernelStructureIsUnkeyableName,
  kernelStructureLimitsInverted,
  kernelStructurePatternCompiles,
  kernelStructureIsDataKey,
  kernelStructureIsProtoName,
  kernelStructureHasProtoKey,
  kernelStructureOwn,
  kernelStructureLabel,
  kernelStructureSlotLabel,
  kernelStructureCollect,
  kernelStructureWhere,
  kernelStructureCountTree,
  kernelStructureJourneyList,
  kernelStructureLayoutList,
  kernelStructureSizeGate,
  kernelStructureEnvelope,
  kernelStructureNewPlace,
  kernelStructurePlaceAt,
  kernelStructurePlaceChild,
  kernelStructurePlaceShared,
  kernelStructureHoldsAnswer,
  kernelStructureGridRowsCap,
  kernelStructureGridBoundsUsable,
  kernelStructureNodes,
  kernelStructureLocalization,
  kernelStructureKinds,
  kernelStructureChromeIds,
  kernelStructureJourneys,
  kernelStructurePdf,
  kernelStructureCheck
];
