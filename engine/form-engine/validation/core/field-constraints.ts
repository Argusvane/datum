import { kernelFormulaPolicy, kernelRegexRisky } from "../../core/expressions/compile.js";
import type { FormulaErrorPolicy } from "../../core/expressions/expression.js";
import { addressOf, resolveText, type FormTranslations, type TextSources, type TranslationCatalog } from "../../core/localization/translations.js";
import type { ValidationContext, ValidationResult, ValidationStage } from "../../core/schema/contracts.js";
import {
  kernelAnswerBoundCode,
  kernelAnswerBounds,
  kernelAnswerIsWrongShape,
  kernelAnswerKindCode,
  type DatePart,
  type FieldInputState
} from "../../core/schema/answer-kinds.js";
import { kernelKindBase } from "../../core/schema/component-kinds.js";
import { countCharacters, readLengthLimits } from "../../core/schema/length-limits.js";
import {
  FILE_COMPONENT_TYPE,
  formatFileSize,
  matchesAccept,
  readFileAttachments,
  readFileUploadConfiguration
} from "../../core/schema/file-upload.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { DATA_GRID_ROWS_CAP, dataGridSettingsOf, isDataGrid, normalizeDataGrids } from "../../core/schema/data-grid.js";
import type { DataGridSettings } from "../../core/schema/data-grid.js";
import { kernelFoldHoldsOwnAnswer } from "../../core/state/submittable-fold.js";
import { buildRowKeys, buildValuePaths, collectionPathOf } from "../../core/tree/data-scope.js";

/**
 * The validation every form gets for free: the constraints an author declares on a field
 * itself — `required`, `minLength` / `maxLength`, `pattern`, and a file field's size and type
 * limits — turned into one deterministic stage.
 *
 * It exists because these are *capabilities*, not host policy. A builder that offers a
 * "Pattern" box has promised the form will enforce it, and leaving each host to re-derive that
 * from the tree means the promise holds in one deployment and not the next. A host with richer
 * rules still adds its own stages; this one only covers what the component declares about
 * itself.
 *
 * Two identifiers are in play and they are deliberately different: a constraint *reads* the
 * value at its path (which a data-scoping `container` nests) and *reports* against the
 * component id (which the renderer, the error summary and focus management address).
 *
 * `required` is the one constraint a rule can add to: a field with
 * `rules.requiredWhen` is collected too (`requiredWhen: true`) — one that holds an answer of
 * its own and sits in no repeating section, the fold's own gates — and the stage holds it to
 * `required` while the runtime's `requiredComponents` says the rule holds — the runtime works
 * that out in its fold, over the submittable view, exactly as the validation kernel does. The
 * rule adds to the tick and never removes it. Without the map (a host running the stage
 * outside `FormRuntime`), the tick alone counts here; the sandbox still enforces the rule.
 *
 * Every `number` and `date` component is collected too, constraints or none: a
 * non-empty answer that is not a number raises `number`, one that is not a real calendar date
 * raises `date` — the kernel's own predicates (`core/schema/answer-kinds.ts`), so both sides
 * read an answer alike. Two more come from what the controls know and the value cannot say
 * (the context's `inputStates`, client-only): a date typed in part raises `dateIncomplete`
 * and a number box holding text the browser could not read raises `number`, each in place of
 * `required` for that empty answer.
 *
 * Four more readings hold the answer's shape and bounds, the
 * kernel's own, so both sides agree: a `text` or `textarea` answer that is not a string raises
 * `text`; a number or a date outside the component's declared `min` / `max` (inclusive) raises
 * `number.min` / `number.max` / `date.min` / `date.max`; a `file` answer that is not an
 * attachment, or an item of a list that is not, raises `file`; and more attachments than the
 * field takes (one unless `multiple`, else `maxFiles`, else 100) raises `fileCount`.
 *
 * A type that is not the engine's is read as the base the definition's `kinds` map gives it
 * (`FormDefinition.kinds`, `core/schema/component-kinds.ts`): a `gcds-date` mapped to `date` is
 * collected and checked as a date, typed-in-part included, exactly as the kernel checks it from
 * the same map. The map comes from the stage's `kinds` option, else from the context
 * (`FieldConstraintsContext.kinds`, which `FormRuntime` fills from its definition).
 *
 * A field inside a repeating section is held entry by entry: each entry the values carry
 * (`items[0].sku`) is checked at its own key, which the error's `path` names; a `required`
 * field is reported only for the entries missing it, a section without entries reports
 * nothing. The bare path is not read; the form's rows, the runtime's row API and a host's own
 * code write the entries. A data grid is such a section: its fields are checked per
 * entry, and its row count is held to its bounds — `rows.min` (`{ min, count }`) and `rows.max`
 * (`{ max, count }`) against the grid at its collection path, the count read as the kernel reads
 * it. Whether a hidden grid's count is reported is the runtime's hidden-error
 * filter's decision, as for every other error of this stage. A grid's bounds may be formulas
 * (`rules.minRows` / `rules.maxRows`): the runtime works them out over its settled view and
 * hands the stage the resolved numbers (the context's `dataGridRowBounds`, from
 * `resolveDataGridRowBounds`); without them the fixed bounds of the configuration stand.
 */

/**
 * The context this stage reads: a {@link ValidationContext}, which carries the browser's
 * `invalidComponents`, component id -> `true` where the field's `rules.validWhen`
 * does not hold over the runtime's settled view — the fold's `invalid`, filled by `FormRuntime`
 * and by the builder's Try it beside `requiredComponents`. Browser-only like that map: it never
 * crosses to the sandbox, which works the rule out itself. Kept as a name for the stage's own
 * reading of the context; the field lives on `ValidationContext` itself.
 */
export type FieldConstraintsContext = ValidationContext & {
  /**
   * Grid id -> its row-count bounds once its formulas have spoken: what
   * `resolveDataGridRowBounds` (`core/schema/data-grid.ts`) gives for the grid over the
   * runtime's settled view. The stage counts the grid's rows against these in place of the
   * configuration's fixed bounds; a grid the record does not name (own keys only), or no record
   * at all, keeps the fixed bounds. Browser-only like `invalidComponents`: the sandbox works the
   * formulas out itself.
   */
  dataGridRowBounds?: Readonly<Record<string, Pick<DataGridSettings, "minRows" | "maxRows">>> | undefined;
  /**
   * The definition's own translations, set by `FormRuntime` from `form.translations`:
   * where the stage was given no `textSources`, a pattern's own message is worded from this map
   * for the run's locale, as the kernel words it from the run context's `translations`.
   */
  translations?: FormTranslations | undefined;
  /**
   * The host's translation catalog, set by `FormRuntime`
   * from its `translationCatalog` dependency: read beside `translations` where the stage was given
   * no `textSources`, and winning over the map under the same tag, as the kernel reads the run
   * context's `catalog`.
   */
  catalog?: TranslationCatalog | undefined;
  /**
   * The definition's `kinds` map (type -> engine base type), set by `FormRuntime` from
   * `form.kinds`: a stage built without the `kinds` option reads the form's types through it.
   */
  kinds?: Readonly<Record<string, string>> | undefined;
};

export interface FieldPatternConstraint {
  /** The regular expression source as authored. */
  source: string;
  /** The author's own message for a value that does not match, if they wrote one: a string in the form's default language. */
  message?: string | undefined;
}

/**
 * What a `file` field holds its attachments to (see `core/schema/file-upload.ts`). Checked
 * against the attachment envelope — name, type, size — which every storage kind records, so
 * the check reads the same whether the bytes are embedded or in a bucket.
 */
export interface FieldFileConstraint {
  /** Per-file ceiling in bytes. */
  maxFileSize?: number | undefined;
  /** Accept tokens (`.pdf`, `image/*`, `application/zip`); empty admits any type. */
  accept: string[];
  /**
   * Most attachments the field takes: one for a field that is not `multiple`, else
   * `configuration.maxFiles` (a whole number of 1 or more), else 100.
   */
  maxFiles: number;
}

export interface FieldConstraint {
  componentId: string;
  /** Where the value lives in form state — the component id unless a container nests it. */
  path: string;
  /** The static tick (`configuration.required`). */
  required: boolean;
  /**
   * Present when the component has a `rules.requiredWhen`: required while the
   * context's `requiredComponents` says the rule holds, on top of `required`.
   */
  requiredWhen?: true;
  /**
   * Present when the component has a `rules.validWhen` the fold reads: a non-empty
   * answer nothing else refused is refused with `rule` while the context's `invalidComponents`
   * names the component.
   */
  validWhen?: true;
  /** The component's type, which decides what counts as "empty", and whether a `number` or `date` answer is checked as one. */
  type: string;
  /**
   * The engine type the component is read as, present only when the definition's `kinds` map
   * gives `type` a base (a `gcds-date` read as a `date`); every check reads it in place of `type`.
   */
  base?: string | undefined;
  /** Fewest characters a non-empty value may have (see `core/schema/length-limits.ts`). */
  minLength?: number | undefined;
  /** Most characters a value may have. */
  maxLength?: number | undefined;
  pattern?: FieldPatternConstraint | undefined;
  /** A `file` field's limits: every file field has them, for the shape and the count of its answer. */
  file?: FieldFileConstraint | undefined;
  /** A number's or a date's declared bounds (`configuration.min` / `max`), inclusive; absent when it has none. */
  min?: number | string | undefined;
  max?: number | string | undefined;
  /**
   * Present for a field inside a repeating section: the section's collection path and where the
   * field's answer sits within an entry (`.sku`), so entry `n` keeps it at `items[n].sku`. The
   * stage then checks each entry's key, not `path`.
   */
  row?: { collection: string; suffix: string } | undefined;
  /**
   * Present for every data grid: its collection path and its fixed bounds as
   * `dataGridSettingsOf` reads them, the fallback when the context's `dataGridRowBounds` does not
   * name the grid; `minRule` / `maxRule` when the grid has the formula. `max` absent is no
   * maximum of the author's: the rows are then held to `DATA_GRID_ROWS_CAP`. The stage counts
   * the grid's rows, nothing else.
   */
  rows?:
    | { collection: string; min: number; max?: number | undefined; minRule?: true | undefined; maxRule?: true | undefined }
    | undefined;
}

function configurationOf(node: ComponentNode): Record<string, unknown> {
  const configuration = node.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration)
    ? (configuration as Record<string, unknown>)
    : {};
}

function readPattern(node: ComponentNode): FieldPatternConstraint | undefined {
  const configuration = configurationOf(node);
  const source = configuration.pattern;
  if (typeof source !== "string" || source.length === 0) {
    return undefined;
  }
  const message = configuration.patternMessage;
  return { source, ...(typeof message === "string" ? { message } : {}) };
}

function readFileConstraint(node: ComponentNode, base: string, shapeChecks: boolean): FieldFileConstraint | undefined {
  if (base !== FILE_COMPONENT_TYPE) {
    return undefined;
  }
  const configuration = readFileUploadConfiguration(node.configuration);
  // Without a limit of its own a file field is collected only for the shape checks of the stage.
  if (!shapeChecks && configuration.maxFileSize === undefined && configuration.accept.length === 0) {
    return undefined;
  }
  const declared = configurationOf(node).maxFiles;
  const maxFiles = !configuration.multiple
    ? 1
    : typeof declared === "number" && Number.isFinite(declared) && declared >= 1
      ? Math.floor(declared)
      : 100;
  return {
    ...(configuration.maxFileSize !== undefined ? { maxFileSize: configuration.maxFileSize } : {}),
    accept: configuration.accept,
    maxFiles
  };
}

/**
 * The first thing wrong with a file field's answer, as the error to report: an answer (or a
 * list item) that is no attachment (`file`), more attachments than the field takes
 * (`fileCount`), then the first attachment that breaks the limits — size before type, one
 * error per field, the same one-complaint rule the text constraints follow. The size and type
 * parameters carry both the raw bytes (for a host formatting its own way) and a readable label
 * (for a catalog message that just wants "5 MB").
 */
function firstFileFailure(
  value: unknown,
  limits: FieldFileConstraint
): { code: string; parameters?: Record<string, unknown> } | undefined {
  const given = Array.isArray(value) ? value.length : 1;
  const attachments = readFileAttachments(value);
  if (attachments.length !== given) {
    return { code: "file" };
  }
  if (given > limits.maxFiles) {
    return { code: "fileCount", parameters: { count: given, maxFiles: limits.maxFiles } };
  }
  for (const attachment of attachments) {
    if (limits.maxFileSize !== undefined && attachment.size > limits.maxFileSize) {
      return {
        code: "maxFileSize",
        parameters: {
          file: attachment.name,
          size: attachment.size,
          maxFileSize: limits.maxFileSize,
          sizeLabel: formatFileSize(attachment.size),
          maxFileSizeLabel: formatFileSize(limits.maxFileSize)
        }
      };
    }
    if (!matchesAccept(attachment, limits.accept)) {
      return {
        code: "fileType",
        parameters: { file: attachment.name, type: attachment.type, accept: limits.accept.join(", ") }
      };
    }
  }
  return undefined;
}

export interface CollectFieldConstraintsOptions {
  /**
   * Also collect what holds an answer to its shape and nothing else: a `text`
   * or `textarea`, and a `file` field with no limit of its own. The stage sets it; a reader of
   * the declared constraints (the builder's lists of codes) leaves it off, since an author
   * declared nothing there.
   */
  shapeChecks?: boolean | undefined;
  /**
   * Where a component's answer is stored, when the tree's own value paths do not say: the
   * fields a presentation owns, where an alias reads the form field it fills and
   * every other field its `@<presentation id>.<id>` key. `undefined` for a component leaves
   * it at the path the tree gives it.
   */
  pathOf?: ((componentId: string) => string | undefined) | undefined;
  /**
   * The definition's `kinds` map (`FormDefinition.kinds`): a type it names is collected and
   * checked as its base engine type. Absent, every type is read as itself.
   */
  kinds?: Readonly<Record<string, string>> | undefined;
}

/**
 * Every declared constraint in the tree, in document order. Exported because a host that
 * builds its own pipeline (or a server re-validating a submission) needs the same reading of
 * the tree the stage uses, rather than a second interpretation of it.
 */
export function collectFieldConstraints(authored: ComponentNode, options: CollectFieldConstraintsOptions = {}): FieldConstraint[] {
  // Every caller reads one shape: a grid with no collection binding is bound at its
  // id, as the kernel binds it, so a stage built
  // over an authored root (a host's pipeline, the builder's Try it) checks what the sandbox
  // checks. A tree with no such grid is read as handed in (`normalizeDataGrids` keeps it by identity).
  const root = normalizeDataGrids(authored);
  const valuePaths = buildValuePaths(root);
  const rowKeys = buildRowKeys(root);
  const pathOf = options.pathOf;
  const out: FieldConstraint[] = [];

  // Document order, with a stack of its own rather than recursion: a presentation's own layout
  // may nest deeper than the call stack goes, and the shape checks accept it.
  // `collection` is the nearest repeating section's collection path above the node, `blocked`
  // that a section above wrote it with brackets, which defines no key (the kernel's reading).
  const stack: Array<{ node: ComponentNode; inSection: boolean; collection: string | undefined; blocked: boolean }> = [
    { node: root, inSection: false, collection: undefined, blocked: false }
  ];
  while (stack.length > 0) {
    const { node, inSection, collection, blocked } = stack.pop() as {
      node: ComponentNode;
      inSection: boolean;
      collection: string | undefined;
      blocked: boolean;
    };
    // The form root holds no value, so none of these flags means anything on it.
    if (node.type !== "form") {
      const configuration = configurationOf(node);
      const pattern = readPattern(node);
      const lengths = readLengthLimits(configuration);
      const shapeChecks = options.shapeChecks === true;
      // The engine type the component is read as: its own, or its base in the definition's map.
      const base = kernelKindBase(node.type, options.kinds);
      const file = readFileConstraint(node, base, shapeChecks);
      const bounds = kernelAnswerBounds(base, configuration);
      const kind = kernelAnswerKindCode(base, undefined);
      const required = configuration.required === true;
      // The rule counts only where the fold reads it: on a component that holds an
      // answer of its own, outside a repeating section — the fold's own predicates, so the
      // codes `validationCodesRaisedBy` lists and the errors the stage raises cannot drift. A
      // group, a grid or a row field with the rule keeps its tick alone. Read by truthiness, as
      // every rule is: a hand-written `rules: null` or `requiredWhen: null` is no rule.
      const requiredWhen = Boolean(node.rules?.requiredWhen) && kernelFoldHoldsOwnAnswer(node) && !inSection;
      // A check across answers is read on the same components as `requiredWhen`.
      const validWhen = Boolean(node.rules?.validWhen) && kernelFoldHoldsOwnAnswer(node) && !inSection;
      if (
        required ||
        requiredWhen ||
        validWhen ||
        pattern ||
        lengths.minLength !== undefined ||
        lengths.maxLength !== undefined ||
        file ||
        // A number or a date is checked as one whatever else it declares, and so is
        // a text's answer for being text, for the stage.
        (kind !== null && (kind !== "text" || shapeChecks))
      ) {
        const rowKey = rowKeys.get(node.id);
        const row =
          collection !== undefined && !blocked && rowKey !== undefined && kernelFoldHoldsOwnAnswer(node)
            ? { collection, suffix: `.${rowKey}` }
            : undefined;
        out.push({
          componentId: node.id,
          path: pathOf?.(node.id) ?? valuePaths.get(node.id) ?? node.id,
          required,
          ...(requiredWhen ? { requiredWhen: true as const } : {}),
          ...(validWhen ? { validWhen: true as const } : {}),
          type: node.type,
          ...(base !== node.type ? { base } : {}),
          ...lengths,
          ...(pattern ? { pattern } : {}),
          ...(file ? { file } : {}),
          ...(bounds.min !== null ? { min: bounds.min } : {}),
          ...(bounds.max !== null ? { max: bounds.max } : {}),
          ...(row ? { row } : {})
        });
      }
    }
    const own = collectionPathOf(node);
    const below = own !== undefined ? own : collection;
    const bracketed = own !== undefined && (own.includes("[") || own.includes("]"));
    // A data grid's row count, after the grid's own constraints and before its
    // fields', as the kernel reports it; not for a path that defines no key. Every grid: one
    // with no maximum is held to the row cap (`DATA_GRID_ROWS_CAP`) when the rows are counted.
    if (isDataGrid(node) && own !== undefined && !bracketed && !blocked) {
      const settings = dataGridSettingsOf(node);
      // By truthiness, as every rule is read: `minRows: null` is no formula.
      const minRule = Boolean(node.rules?.minRows);
      const maxRule = Boolean(node.rules?.maxRows);
      out.push({
        componentId: node.id,
        path: own,
        required: false,
        type: node.type,
        rows: {
          collection: own,
          min: settings.minRows,
          ...(settings.maxRows !== undefined ? { max: settings.maxRows } : {}),
          ...(minRule ? { minRule: true as const } : {}),
          ...(maxRule ? { maxRule: true as const } : {})
        }
      });
    }
    const children: ComponentNode[] = [];
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        children.push(child);
      }
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index] as ComponentNode,
        inSection: inSection || node.collection !== undefined,
        collection: below,
        blocked: blocked || bracketed
      });
    }
  }
  return out;
}

/**
 * The error codes this stage can raise for the tree under `root` — each once, in the order
 * `ENGINE_VALIDATION_CODES` lists them — read from the same constraints
 * {@link collectFieldConstraints} enforces, so the builder's "codes this form uses"
 * and the errors it actually gets cannot drift apart. A single field passed as `root` yields
 * its own codes; a container, its children's; the form root, the whole form's. `kinds` is the
 * definition's map, so a type it gives a `number` or `date` base raises that base's codes.
 */
export function validationCodesRaisedBy(root: ComponentNode, kinds?: Readonly<Record<string, string>>): string[] {
  const codes = new Set<string>();
  for (const constraint of collectFieldConstraints(root, kinds !== undefined ? { kinds } : {})) {
    const base = constraint.base ?? constraint.type;
    if (constraint.required || constraint.requiredWhen === true) {
      codes.add("required");
    }
    if (constraint.minLength !== undefined) {
      codes.add("minLength");
    }
    if (constraint.maxLength !== undefined) {
      codes.add("maxLength");
    }
    if (constraint.pattern) {
      codes.add("pattern");
    }
    if (constraint.file?.accept.length) {
      codes.add("fileType");
    }
    if (constraint.file?.maxFileSize !== undefined) {
      codes.add("maxFileSize");
    }
    // A number's answer is checked as a number, a date's as a date — and a date typed
    // in part. A number or a date has its bounds when it declares them. The codes
    // that only hold an answer to its shape (`text`, `file`, `fileCount`) are not listed: no
    // control writes such an answer and no author configures them.
    if (base === "number") {
      codes.add("number");
      if (constraint.min !== undefined) {
        codes.add("number.min");
      }
      if (constraint.max !== undefined) {
        codes.add("number.max");
      }
    } else if (base === "date") {
      codes.add("date");
      codes.add("dateIncomplete");
      if (constraint.min !== undefined) {
        codes.add("date.min");
      }
      if (constraint.max !== undefined) {
        codes.add("date.max");
      }
    }
    // A field's own check across answers.
    if (constraint.validWhen === true) {
      codes.add("rule");
    }
    // A data grid's row count.
    if (constraint.rows !== undefined) {
      if (constraint.rows.min > 0 || constraint.rows.minRule === true) {
        codes.add("rows.min");
      }
      if (constraint.rows.max !== undefined || constraint.rows.maxRule === true) {
        codes.add("rows.max");
      }
    }
  }
  const order = [
    "required",
    "minLength",
    "maxLength",
    "pattern",
    "fileType",
    "maxFileSize",
    "number",
    "number.min",
    "number.max",
    "date",
    "date.min",
    "date.max",
    "dateIncomplete",
    "rule",
    "rows.min",
    "rows.max"
  ];
  return order.filter((code) => codes.has(code));
}

/**
 * Whether a value counts as "not filled in". A lone checkbox is answered only by `true`: the
 * tick is the answer — that is what a consent box means — so `false`, and any other value
 * (`"false"`, `0`, `"yes"`), is a missing answer, while for every other type `false` is a value
 * like any other. A `checkboxes` group's value is an object of booleans with every option
 * present, so "nothing picked" arrives as an all-false object once the group has been touched —
 * which must mean exactly what `undefined` (never touched) means, or a required group would be
 * satisfiable by ticking and unticking a box. A group's answer that is no such object (a list,
 * a text) picks nothing, as the group draws no tick for it.
 *
 * A number that is not finite (`NaN`, `±Infinity` — a calculation that divided by an empty or
 * zero answer) is empty too: JSON carries it as `null`, so a server judging the envelope sees
 * no answer, and the browser must not accept what the server then refuses.
 */
export function isEmptyValue(value: unknown, type: string): boolean {
  if (type === "checkbox") {
    return value !== true;
  }
  if (type === "checkboxes") {
    return value === null || typeof value !== "object" || Array.isArray(value) || !Object.values(value).some((entry) => entry === true);
  }
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

/**
 * What a control's input state says about an empty answer, before `required`: a
 * number box holding text the browser could not read is `number` (`badInput: true` marks it as
 * the browser's alone); a date typed in part is `dateIncomplete`, naming the parts still empty
 * in day-month-year order — as a phrase (`missing`: "month and year"), a key a theme can word
 * each case by (`missingKey`: "month-year") and the list (`missingParts`). A date missing no
 * part, or all three, is not incomplete: the answer is simply there, or empty.
 */
function inputStateFailure(
  type: string,
  state: FieldInputState | undefined
): { code: string; parameters: Record<string, unknown> } | undefined {
  if (type === "number" && state?.badInput === true) {
    return { code: "number", parameters: { badInput: true } };
  }
  const listed = type === "date" ? state?.incomplete?.missing : undefined;
  if (!Array.isArray(listed)) {
    return undefined;
  }
  const missingParts = (["day", "month", "year"] as DatePart[]).filter((part) => listed.includes(part));
  if (missingParts.length === 0 || missingParts.length === 3) {
    return undefined;
  }
  return {
    code: "dateIncomplete",
    parameters: { missing: missingParts.join(" and "), missingKey: missingParts.join("-"), missingParts }
  };
}

/**
 * Compiles an authored pattern, anchored.
 *
 * Anchoring matters: HTML's own `pattern` attribute (which `fieldHtml` emits as a hint) must
 * match the *whole* value, and a stage that used the same source unanchored would accept
 * values the browser rejects. One reading of the constraint, both places.
 *
 * Returns `undefined` for an expression this runtime cannot compile — validation is not the
 * place to report an authoring mistake, and failing every value because of a typo in the
 * builder would be worse than not enforcing it.
 */
export function compilePattern(source: string): RegExp | undefined {
  try {
    // The pattern alone first, as the kernel does: inside the anchors a stray `)` and `(` pair up.
    new RegExp(source, "u");
    return new RegExp(`^(?:${source})$`, "u");
  } catch {
    return undefined;
  }
}

export interface FieldConstraintsStageOptions extends CollectFieldConstraintsOptions {
  /** Stage id reported on each error. Defaults to `"field-constraints"`. */
  id?: string;
  version?: string;
  /**
   * What the stage does with a `pattern` of a catastrophic shape (a repeat of a repeat, a
   * repeated back-reference; `kernelRegexRisky`): `"refuse"` (the default) does not run it, as it
   * does not run one that cannot compile (the kernel logs it and, under `formulaErrors: "fail"`,
   * refuses the answer); `"allow"` runs it.
   */
  riskyPatterns?: "refuse" | "allow";
  /**
   * The policy for definition problems, as the kernel reads it: this, else the form's
   * own `configuration.formulaErrors`, else `fail`. Under `fail` a `pattern` the stage does not
   * run (one that cannot compile, or a refused risky one) cannot be shown to match, so a
   * non-empty answer fails it (`pattern`, `parameters.invalid: true`), exactly as the server
   * refuses it; under `warn` the check is skipped, as the server skips it.
   */
  formulaErrors?: FormulaErrorPolicy | undefined;
  /**
   * The definition's translations and the host's catalog: a pattern's own message is
   * worded for the context's locale from `components › <id> › patternMessage`. Absent, the
   * stage reads the definition's map and the host's catalog from the context
   * (`FieldConstraintsContext.translations`, `.catalog`); with neither, it is the default-language string.
   */
  textSources?: TextSources | undefined;
}

/**
 * A deterministic stage enforcing the `required` / `minLength` / `maxLength` / `pattern`
 * constraints declared in `root`, and a `file` field's `maxFileSizeMb` / `accept`.
 *
 * The tree is read once, when the stage is built: a form whose structure changes (the builder
 * editing it) gets a new stage, exactly as a host rebuilding its pipeline already does.
 *
 * One error per field, in that order of precedence: a blank value has nothing for a length or
 * a pattern to disagree with, and a value of the wrong length is told so before it is told it
 * looks wrong — two complaints about one box help nobody. A number or a date that is not one
 * is told so before its length or its pattern; an empty answer whose control says
 * more (the context's `inputStates`) is told that instead of `required`.
 *
 * Hidden fields are not exempted here. Whether a value a rule has hidden still counts is the
 * hidden-value policy's decision (`core/state/hidden-value-policy.ts`), which runs over the
 * values before validation sees them — so a policy that clears hidden values makes them empty
 * and a policy that keeps them means the author asked for them to be kept.
 *
 * A field's `rules.requiredWhen` counts through the context's `requiredComponents`:
 * required when its tick is set OR the map holds `true` under its id (own keys only, as the
 * values are read). `FormRuntime` fills the map from its recompute; without it the tick alone
 * counts. A field's `rules.validWhen` counts the same way, through `invalidComponents`
 * ({@link FieldConstraintsContext}): `rule`, last, for a non-empty answer; without the
 * map no `rule` is raised (the sandbox still enforces it).
 */
export function createFieldConstraintsStage(
  root: ComponentNode,
  options: FieldConstraintsStageOptions = {}
): ValidationStage {
  const stageId = options.id ?? "field-constraints";
  // A pattern the stage does not run fails a non-empty answer closed under the kernel's policy word.
  const failClosed = kernelFormulaPolicy(root.configuration, options.formulaErrors) === "fail";

  /**
   * The constraints of the tree read through one `kinds` map, with their patterns compiled and
   * the collections they read: worked out once per map rather than per validation run — the
   * tree cannot change without a new stage, and a form validates far more often than it is
   * edited. The stage's own `kinds` option wins; without it the context's map is read, so a
   * stage a host built from the root alone still reads the definition's types through it.
   */
  const prepare = (kinds: Readonly<Record<string, string>> | undefined) => {
    const constraints = collectFieldConstraints(root, {
      ...(options.pathOf !== undefined ? { pathOf: options.pathOf } : {}),
      ...(kinds !== undefined ? { kinds } : {}),
      shapeChecks: true
    });
    const risky = new Set<FieldConstraint>();
    const patterns = new Map<FieldConstraint, RegExp | undefined>(
      constraints
        .filter((constraint) => constraint.pattern)
        .map((constraint) => {
          if (options.riskyPatterns !== "allow" && kernelRegexRisky((constraint.pattern as FieldPatternConstraint).source)) {
            risky.add(constraint);
            return [constraint, undefined];
          }
          return [constraint, compilePattern((constraint.pattern as FieldPatternConstraint).source)];
        })
    );
    /** The collection paths some constraint reads entry by entry, or counts. */
    const collections = new Set<string>();
    for (const constraint of constraints) {
      if (constraint.row) {
        collections.add(constraint.row.collection);
      }
      if (constraint.rows) {
        collections.add(constraint.rows.collection);
      }
    }
    return { kinds, constraints, risky, patterns, collections };
  };
  let prepared = prepare(options.kinds);

  return {
    id: stageId,
    version: options.version ?? "1.0.0",
    validate: (context): ValidationResult => {
      const kinds = options.kinds ?? (context as FieldConstraintsContext).kinds;
      if (kinds !== prepared.kinds) {
        prepared = prepare(kinds);
      }
      const { constraints, risky, patterns, collections } = prepared;
      const errors: ValidationResult["errors"] = [];
      const byRule = context.requiredComponents;
      // The entries each section holds, worked out once and only when a row field is met.
      let entries: Map<string, number[]> | undefined;
      const entriesOf = (collection: string): number[] => {
        entries ??= rowIndexesOf(context.values, collections);
        return entries.get(collection) ?? [];
      };

      const byCheck = (context as FieldConstraintsContext).invalidComponents;
      // Every check of the field's own answer, then its check across answers: last,
      // for a non-empty answer nothing else refused, while `invalidComponents` names the field.
      // A row field never has one (the fold does not read the rule inside a section).
      const check = (constraint: FieldConstraint, path: string): void => {
        const raised = errors.length;
        checkOwn(constraint, path);
        if (
          constraint.validWhen !== true ||
          constraint.row !== undefined ||
          errors.length !== raised ||
          byCheck === undefined ||
          !Object.prototype.hasOwnProperty.call(byCheck, constraint.componentId) ||
          byCheck[constraint.componentId] !== true
        ) {
          return;
        }
        const value = Object.prototype.hasOwnProperty.call(context.values, path) ? context.values[path] : undefined;
        const base = constraint.base ?? constraint.type;
        if (isEmptyValue(value, base) && !kernelAnswerIsWrongShape(base, value)) {
          return;
        }
        errors.push({ code: "rule", componentId: constraint.componentId, path, stage: stageId, source: "client" });
      };

      const checkOwn = (constraint: FieldConstraint, path: string): void => {
        // Own keys only, as the validation kernel reads them: a field `constructor` left empty
        // is empty, never `Object.prototype.constructor`.
        const value = Object.prototype.hasOwnProperty.call(context.values, path) ? context.values[path] : undefined;
        // The engine type the component is read as (the definition's `kinds` map).
        const base = constraint.base ?? constraint.type;
        // An empty list for a text is no empty answer: it is the wrong shape.
        const empty = isEmptyValue(value, base) && !kernelAnswerIsWrongShape(base, value);
        // Required OR Required when: the rule adds to the tick, never removes it.
        const required =
          constraint.required ||
          (constraint.requiredWhen === true &&
            byRule !== undefined &&
            Object.prototype.hasOwnProperty.call(byRule, constraint.componentId) &&
            byRule[constraint.componentId] === true);

        // What the control knows and the empty answer cannot say, in place of `required`.
        const states = context.inputStates;
        const input =
          empty && states !== undefined && Object.prototype.hasOwnProperty.call(states, path)
            ? inputStateFailure(base, states[path])
            : undefined;
        if (input) {
          errors.push({
            code: input.code,
            componentId: constraint.componentId,
            path,
            stage: stageId,
            source: "client",
            parameters: input.parameters
          });
          return;
        }

        if (required && empty) {
          errors.push({
            code: "required",
            componentId: constraint.componentId,
            path,
            stage: stageId,
            source: "client"
          });
          return;
        }

        if (empty) {
          return;
        }

        // A number's answer is a number, a date's a real date, a text's a string,
        // before anything about its text.
        const kind = kernelAnswerKindCode(base, value);
        if (kind !== null) {
          errors.push({ code: kind, componentId: constraint.componentId, path, stage: stageId, source: "client" });
          return;
        }

        // A number or a date within its declared bounds, inclusive.
        const bound = kernelAnswerBoundCode(base, value, constraint.min ?? null, constraint.max ?? null);
        if (bound !== null) {
          errors.push({
            code: bound,
            componentId: constraint.componentId,
            path,
            stage: stageId,
            source: "client",
            parameters: bound.endsWith(".min") ? { min: constraint.min } : { max: constraint.max }
          });
          return;
        }

        // A file field's limits speak about its attachments, never about text.
        if (constraint.file) {
          const failure = firstFileFailure(value, constraint.file);
          if (failure) {
            errors.push({
              code: failure.code,
              componentId: constraint.componentId,
              path,
              stage: stageId,
              source: "client",
              ...(failure.parameters !== undefined ? { parameters: failure.parameters } : {})
            });
          }
          return;
        }

        // Length and pattern only speak about text there is some of.
        if (typeof value !== "string") {
          return;
        }

        const length = countCharacters(value);
        if (constraint.minLength !== undefined && length < constraint.minLength) {
          errors.push({
            code: "minLength",
            componentId: constraint.componentId,
            path,
            stage: stageId,
            source: "client",
            parameters: { minLength: constraint.minLength, length }
          });
          return;
        }
        if (constraint.maxLength !== undefined && length > constraint.maxLength) {
          errors.push({
            code: "maxLength",
            componentId: constraint.componentId,
            path,
            stage: stageId,
            source: "client",
            parameters: { maxLength: constraint.maxLength, length }
          });
          return;
        }

        const pattern = constraint.pattern;
        if (!pattern) {
          return;
        }
        const expression = patterns.get(constraint);
        const unenforceable = expression === undefined;
        if ((unenforceable && !failClosed) || (expression !== undefined && expression.test(value))) {
          return;
        }
        const message =
          pattern.message !== undefined
            ? resolveText(pattern.message, addressOf.component(constraint.componentId, "patternMessage"), context.locale ?? "en", options.textSources ?? { translations: (context as FieldConstraintsContext).translations, catalog: (context as FieldConstraintsContext).catalog })
            : undefined;
        errors.push({
          code: "pattern",
          componentId: constraint.componentId,
          path,
          stage: stageId,
          source: "client",
          parameters: {
            pattern: pattern.source,
            ...(unenforceable ? { invalid: true } : {}),
            ...(unenforceable && risky.has(constraint) ? { risky: true } : {}),
            ...(message !== undefined ? { message } : {})
          }
        });
      };

      /**
       * How many rows a grid holds, as the kernel counts them: its entries' indexes
       * when any flat key (`items[0].sku`) names one — the kernel drops a list posted beside its
       * own flat keys — else, rows posted whole, the length of a list of plain objects at the
       * collection path, an empty row (`{}`) counted.
       */
      const rowCountOf = (collection: string): number => {
        const indexes = entriesOf(collection);
        if (indexes.length > 0) {
          return indexes.length;
        }
        const posted = Object.prototype.hasOwnProperty.call(context.values, collection) ? context.values[collection] : undefined;
        return Array.isArray(posted) && posted.every((row) => row !== null && typeof row === "object" && !Array.isArray(row)) ? posted.length : 0;
      };

      // The bounds the runtime resolved from the grids' formulas, else the fixed ones.
      const resolvedBounds = (context as FieldConstraintsContext).dataGridRowBounds;
      for (const constraint of constraints) {
        if (constraint.rows) {
          const count = rowCountOf(constraint.rows.collection);
          const resolved =
            resolvedBounds !== undefined && Object.prototype.hasOwnProperty.call(resolvedBounds, constraint.componentId)
              ? resolvedBounds[constraint.componentId]
              : undefined;
          const min = resolved !== undefined ? resolved.minRows : constraint.rows.min;
          // No maximum, fixed or resolved: the row cap adding a row is held to, as the kernel holds it.
          const max = (resolved !== undefined ? resolved.maxRows : constraint.rows.max) ?? DATA_GRID_ROWS_CAP;
          if (count < min) {
            errors.push({
              code: "rows.min",
              componentId: constraint.componentId,
              path: constraint.path,
              stage: stageId,
              source: "client",
              parameters: { min, count }
            });
          } else if (count > max) {
            errors.push({
              code: "rows.max",
              componentId: constraint.componentId,
              path: constraint.path,
              stage: stageId,
              source: "client",
              parameters: { max, count }
            });
          }
          continue;
        }
        if (constraint.row) {
          // Each entry at its own key; a section with no entry has nothing to report.
          for (const at of entriesOf(constraint.row.collection)) {
            check(constraint, `${constraint.row.collection}[${at}]${constraint.row.suffix}`);
          }
        } else {
          check(constraint, constraint.path);
        }
      }
      return { errors };
    }
  };
}

/**
 * The entries each repeating section holds in `values`: collection path -> the entry indexes
 * some key carries, ascending and each once. A key is `collection[n].field` with `n` digits and
 * no leading zero, as the runtime writes them, for a collection in `collections`; the kernel's
 * `kernelRowIndexes` reads the same keys the same way. One pass over the keys.
 */
function rowIndexesOf(values: Record<string, unknown>, collections: ReadonlySet<string>): Map<string, number[]> {
  const seen = new Map<string, Set<number>>();
  for (const key of Object.keys(values)) {
    const open = key.indexOf("[");
    if (open < 1) {
      continue;
    }
    const collection = key.slice(0, open);
    if (!collections.has(collection)) {
      continue;
    }
    const close = key.indexOf("]", open);
    if (close < 0 || key.charAt(close + 1) !== "." || close + 2 >= key.length) {
      continue;
    }
    const digits = key.slice(open + 1, close);
    if (!/^(?:0|[1-9][0-9]*)$/.test(digits)) {
      continue;
    }
    let marks = seen.get(collection);
    if (marks === undefined) {
      marks = new Set<number>();
      seen.set(collection, marks);
    }
    marks.add(Number(digits));
  }
  const out = new Map<string, number[]>();
  for (const [collection, marks] of seen) {
    out.set(collection, [...marks].sort((a, b) => a - b));
  }
  return out;
}
