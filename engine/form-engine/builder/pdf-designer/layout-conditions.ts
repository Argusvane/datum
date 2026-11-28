/**
 * Authoring a PDF layout's condition in the builder: what the PDF mode's Rules tab
 * offers on a layout's root ("Print this layout when"), which form fields its field box
 * suggests, what its opening line says about the layout's place in the order, what the Form
 * panel's PDF group says in words, the advisory findings, and a form rename followed into
 * every layout's `when`.
 *
 * A layout's condition reads the form's answers as they would be submitted, keyed by component
 * id (`selectPdfLayout` in core, `selectPdfLayoutForValues` in the render layer): the view a
 * server holds, with no `row.`, `ancestor.`, `host.` or `component` scope. Layouts are tried in
 * list order; when none holds, the declared default prints. Nothing here blocks a Save:
 * a condition that cannot be evaluated never holds, the same in the browser and on a server,
 * so every finding is advice.
 *
 * Pure, static and free of work at import: the PDF mode is in the builder's bundle, and the
 * journey findings (`journey-diagnostics.ts`) are not — so this file reads the condition shape
 * from `core/expressions/condition-shape.ts`, never from them.
 */
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { isScopedExpressionPath } from "../../core/expressions/condition-shape.js";
import { journeyLeadingSegment } from "../../core/journey/journey-shared.js";
import { addressOf, type FormTranslations, type TextSources, resolveText } from "../../core/localization/translations.js";
import { PDF_TEMPLATE_COMPONENT_TYPE } from "../../render/pdf/pdf-template-constants.js";
import {
  PDF_DOCUMENT_COMPONENT_TYPE,
  PDF_FIELD_COMPONENT_TYPE,
  PDF_REPEAT_COMPONENT_TYPE,
  PDF_TABLE_COMPONENT_TYPE,
  pdfLayoutCandidates,
  readDefaultPdfLayoutId,
  readPdfLayoutCondition,
  type PdfConfiguration,
  type PdfLayoutDocument,
  type PdfMappingBinding,
  type PdfTemplateLayout
} from "../../core/schema/pdf-layout.js";
import { collectionPathOf, holdsData, isDataScopeContainer } from "../../core/tree/data-scope.js";
import { extractDependencies } from "../../rules/dependencies/dependency-extractor.js";
import type { BuilderController } from "../controller/builder-controller.js";
import { formulaFieldsOf, type FormulaField } from "../formula/formula-fields.js";
import { renameAnswerPath, renameFormulaPath, renameInRuleSource, unparsedFormulaNaming, type ValuePathMoves } from "../formula/rename.js";
import { conditionInWords } from "../property-editor/condition-words.js";
import type { InspectorChoice } from "../property-editor/inspector-model.js";
import type { RuleDescriptor } from "../property-editor/rules-model.js";
import { buildNestedTreeView, type NestedTreeNodeView } from "../tree-editor/nested-tree-view.js";
import { builderText, type BuilderTextCatalog, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import { effectivePdfDefaultLayoutId, pdfLayoutLabel, pdfLayoutsOf } from "./layout-catalog.js";

/** A layout's condition on its root's Rules tab: stored as the root's `when`, lifted to the layout's top level by the designers. */
function conditionRules(text?: BuilderTextOptions): readonly RuleDescriptor[] {
  return [
    {
      key: "when",
      label: builderText("pdf.rules.when", undefined, text),
      description: builderText("pdf.rules.whenHint", undefined, text),
      kind: "condition",
      target: { propertyPath: "when" }
    }
  ];
}

/** The English rules, the ones a layout's root offers without a catalog. */
export const PDF_LAYOUT_CONDITION_RULES: readonly RuleDescriptor[] = conditionRules();

const NO_RULES: readonly RuleDescriptor[] = [];

/**
 * The type of a populated form's root (`PDF_TEMPLATE_COMPONENT_TYPE`, render/pdf/pdf-template-constants.ts). Imported from
 * the leaf module, not the designer's component table (render/pdf/pdf-template-components.ts), which
 * belongs to the designer's chunk while the conditions are read by the shell before it is loaded.
 */
export const PDF_TEMPLATE_ROOT_TYPE = PDF_TEMPLATE_COMPONENT_TYPE;

/**
 * The rules a node of a PDF layout offers: the condition on a layout's root — a custom layout's
 * document or a populated form's template — and nothing anywhere else, so every other node keeps
 * having no Rules tab (nothing reads a layout node's `rules`).
 */
export function pdfLayoutRuleDescriptors(nodeType: string, text?: BuilderTextOptions): readonly RuleDescriptor[] {
  if (nodeType !== PDF_DOCUMENT_COMPONENT_TYPE && nodeType !== PDF_TEMPLATE_ROOT_TYPE) {
    return NO_RULES;
  }
  return text === undefined ? PDF_LAYOUT_CONDITION_RULES : conditionRules(text);
}

/** The form a layout's condition reads, and how its components are named. */
export interface PdfLayoutConditionContext {
  formRoot: ComponentNode;
  locale?: string | undefined;
  /** The definition's own translations: component and layout names word themselves through them. */
  translations?: FormTranslations | undefined;
  catalog?: TranslationCatalog | undefined;
  /** The host's builder texts per locale (`BuilderTextCatalog`); absent, English. */
  textCatalog?: BuilderTextCatalog | undefined;
  /** Which leaves carry no answer (a host's own static components). Absent: the engine's. */
  isValueless?: ((node: ComponentNode) => boolean) | undefined;
}

/** The builder's words for a context: its locale and the host's builder texts. */
function wordsOf(context: PdfLayoutConditionContext): BuilderTextOptions {
  return { locale: context.locale ?? "en", ...(context.textCatalog ? { catalog: context.textCatalog } : {}) };
}

/** The sources a name is translated from: the definition's map and the host's catalog. */
function sourcesOf(context: PdfLayoutConditionContext): TextSources {
  return { translations: context.translations, catalog: context.catalog };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A component's label in the builder's locale (its translation at `components › id › label`, else the string); `undefined` without one. */
function componentLabel(node: ComponentNode, context: PdfLayoutConditionContext): string | undefined {
  const label = isRecord(node.configuration) ? node.configuration.label : undefined;
  if (typeof label !== "string" || label.trim() === "") {
    return undefined;
  }
  const resolved = resolveText(label, addressOf.component(node.id, "label"), context.locale ?? "en", sourcesOf(context));
  return resolved.trim() === "" ? undefined : resolved;
}

/** "Province (province)"; the id alone when the component has no label of its own. */
function labelWithId(label: string | undefined, id: string, text: BuilderTextOptions): string {
  return label === undefined || label === id ? id : builderText("pdf.label.withId", { label, id }, text);
}

/**
 * What a condition's field box suggests on a layout's root: the form's answer-holding
 * components outside every repeating section — what a condition can read — in the outline's
 * order, each as "Label (id)", since a condition names fields by id. The panel's own fallback
 * would list the layout's nodes. A data-scoping container is left out, its fields listed: the
 * answers are keyed by component id, so the container's own id reads as nothing.
 */
export function pdfConditionFieldOptions(context: PdfLayoutConditionContext): InspectorChoice[] {
  const holds = context.isValueless ? { isValueless: context.isValueless } : {};
  const view = buildNestedTreeView(context.formRoot, undefined, context.locale ?? "en", (node) => componentLabel(node, context));
  const out: InspectorChoice[] = [];
  const visit = (entry: NestedTreeNodeView, inEntries: boolean): void => {
    const entries = inEntries || collectionPathOf(entry.node) !== undefined;
    if (entry.depth > 0 && !entries && holdsData(entry.node, holds) && !isDataScopeContainer(entry.node)) {
      out.push({ value: entry.id, label: labelWithId(componentLabel(entry.node, context), entry.id, wordsOf(context)) });
    }
    for (const slot of entry.slots) {
      for (const child of slot.children) {
        visit(child, entries);
      }
    }
  };
  visit(view, false);
  return out;
}

/**
 * The same components as {@link pdfConditionFieldOptions}, for the formula editor's chips and
 * suggestions: each with its kind and inline options, labelled for the builder's locale.
 */
export function pdfConditionFormulaFields(context: PdfLayoutConditionContext): FormulaField[] {
  const offered = new Set(pdfConditionFieldOptions(context).map((choice) => choice.value));
  return formulaFieldsOf(context.formRoot, {
    labelOf: (componentId) => {
      const node = indexForm(context.formRoot).nodes.get(componentId)?.node;
      return node ? componentLabel(node, context) : undefined;
    },
    ...(context.locale !== undefined ? { locale: context.locale } : {})
  }).filter((field) => offered.has(field.path));
}

/** Every component of the form under its id, with the repeating section it is an entry field of. */
interface FormIndex {
  rootId: string;
  nodes: Map<string, { node: ComponentNode; section: ComponentNode | undefined }>;
}

function indexForm(root: ComponentNode): FormIndex {
  const nodes: FormIndex["nodes"] = new Map();
  const visit = (node: ComponentNode, section: ComponentNode | undefined): void => {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, { node, section });
    }
    const inner = collectionPathOf(node) !== undefined ? node : section;
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        visit(child, inner);
      }
    }
  };
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      visit(child, undefined);
    }
  }
  return { rootId: root.id, nodes };
}

/** The component a form-scoped path names: the id itself, else its leading segment (`applicants[0].name` names `applicants`). */
function componentOfPath(index: FormIndex, path: string): string | undefined {
  if (path !== index.rootId && index.nodes.has(path)) {
    return path;
  }
  const leading = journeyLeadingSegment(path);
  return leading !== path && leading !== index.rootId && index.nodes.has(leading) ? leading : undefined;
}

/** The advisories a layout's condition can raise; none holds a Save back. */
export type PdfLayoutFindingCode =
  | "pdf-layout.condition.invalid"
  | "pdf-layout.condition.scope"
  | "pdf-layout.condition.unknown-field"
  | "pdf-layout.condition.entry-field"
  | "pdf-layout.condition.shadowed"
  | "pdf-layout.condition.template-source"
  | "pdf-layout.default-conditional"
  | "pdf-layout.no-default";

export interface PdfLayoutFinding {
  code: PdfLayoutFindingCode;
  /** The layout it is about; absent for the definition as a whole (`pdf-layout.no-default`). */
  layoutId?: string | undefined;
  message: string;
}

/** A condition that holds whatever the answers: a literal the evaluator reads as true. */
function alwaysHolds(when: unknown): boolean {
  return isRecord(when) && when.kind === "literal" && Boolean(when.value);
}

/**
 * Everything worth saying about the layouts' conditions over the form under `context.formRoot`,
 * in list order: a condition the engine cannot evaluate (it never holds), one that reads outside
 * the form's answers, names no component of the form, or names a field inside a repeating
 * section or the section itself (each always unanswered; `len()` of a section is 0 here); a
 * layout an earlier one's condition always pre-empts (after a Duplicate, say); a template
 * whose PDF the definition does not hold, once which layout prints depends on the answers; a
 * default with a condition of its own; and conditions with no declared default. At most one
 * finding per code and layout.
 */
export function pdfLayoutConditionFindings(context: PdfLayoutConditionContext, configuration: PdfConfiguration | undefined): PdfLayoutFinding[] {
  const layouts = pdfLayoutsOf(configuration);
  const out: PdfLayoutFinding[] = [];
  const index = indexForm(context.formRoot);
  const text = wordsOf(context);
  const nameOf = (layout: PdfLayoutDocument): string => builderText("pdf.layout.quoted", { name: pdfLayoutLabel(layout, context.locale ?? "en", sourcesOf(context)) }, text);
  const conditional = layouts.filter((layout) => readPdfLayoutCondition(layout) !== undefined);
  if (conditional.length === 0) {
    return out;
  }
  const seen = new Set<string>();
  const report = (code: PdfLayoutFindingCode, layout: PdfLayoutDocument | undefined, message: string): void => {
    const key = `${code}\u0000${layout?.id ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ code, ...(layout ? { layoutId: layout.id } : {}), message });
    }
  };

  layouts.forEach((layout, at) => {
    const condition = readPdfLayoutCondition(layout);
    if (!condition) {
      return;
    }
    const name = nameOf(layout);
    if (!condition.evaluable) {
      report("pdf-layout.condition.invalid", layout, builderText("pdf.finding.invalid", { name }, text));
    } else {
      for (const path of extractDependencies(condition.expression)) {
        if (isScopedExpressionPath(path)) {
          report(
            "pdf-layout.condition.scope",
            layout,
            builderText("pdf.finding.scope", { name, path }, text)
          );
          continue;
        }
        const componentId = componentOfPath(index, path);
        if (componentId === undefined) {
          report("pdf-layout.condition.unknown-field", layout, builderText("pdf.finding.unknownField", { name, path }, text));
          continue;
        }
        // Entries travel as instance keys (applicants[0].name), so neither a field of each entry
        // nor the section itself has a key of its own: len() of a section is 0 here, as in
        // every rule and calculation. An instance path does read its one key, so it passes.
        const entry = index.nodes.get(componentId);
        if (entry?.section !== undefined) {
          report(
            "pdf-layout.condition.entry-field",
            layout,
            builderText("pdf.finding.entryField", { name, id: componentId, section: entry.section.id }, text)
          );
        } else if (entry !== undefined && path === componentId && collectionPathOf(entry.node) !== undefined) {
          report(
            "pdf-layout.condition.entry-field",
            layout,
            builderText("pdf.finding.section", { name, id: componentId }, text)
          );
        }
      }
    }
    // An earlier layout whose condition always holds, or is this one's to the letter, is tried
    // first and wins: this one never prints by its condition.
    const written = JSON.stringify(layout.when);
    const earlier = layouts.slice(0, at).find((other) => {
      const shape = readPdfLayoutCondition(other);
      return shape?.evaluable === true && (alwaysHolds(other.when) || JSON.stringify(other.when) === written);
    });
    if (earlier && condition.evaluable) {
      report(
        "pdf-layout.condition.shadowed",
        layout,
        builderText(
          "pdf.finding.shadowed",
          {
            name,
            earlier: nameOf(earlier),
            holds: builderText(alwaysHolds(earlier.when) ? "pdf.finding.holds.always" : "pdf.finding.holds.same", undefined, text)
          },
          text
        )
      );
    }
  });

  // Which template prints now depends on the answers: a host must resolve every one that may.
  for (const layout of pdfLayoutCandidates({ pdf: configuration })) {
    if (layout.kind === "template" && layout.template.storage !== "base64") {
      report(
        "pdf-layout.condition.template-source",
        layout,
        builderText("pdf.finding.template", { name: nameOf(layout), storage: layout.template.storage, pdfName: layout.template.name }, text)
      );
    }
  }

  const declared = readDefaultPdfLayoutId({ pdf: configuration });
  const defaultLayout = declared !== undefined ? layouts.find((layout) => layout.id === declared) : undefined;
  if (defaultLayout && readPdfLayoutCondition(defaultLayout) !== undefined) {
    report(
      "pdf-layout.default-conditional",
      defaultLayout,
      builderText("pdf.finding.defaultConditional", { name: nameOf(defaultLayout) }, text)
    );
  }
  if (!defaultLayout && layouts[0]) {
    report(
      "pdf-layout.no-default",
      undefined,
      builderText("pdf.finding.noDefault", { name: nameOf(layouts[0]) }, text)
    );
  }
  return out;
}

const ORDINAL_KEYS: Record<string, BuilderTextKey> = {
  one: "pdf.ordinal.one",
  two: "pdf.ordinal.two",
  few: "pdf.ordinal.few",
  other: "pdf.ordinal.other"
};

/** "1st", "2nd", "3rd", "4th", "11th", "22nd": the locale's ordinal category picks the form. */
function ordinal(n: number, text: BuilderTextOptions): string {
  let category = "other";
  try {
    category = new Intl.PluralRules(text.locale ?? "en", { type: "ordinal" }).select(n);
  } catch {
    category = "other";
  }
  return builderText(ORDINAL_KEYS[category] ?? "pdf.ordinal.other", { n }, text);
}

/** What a condition reads, in words: "Province equals “QC”", the printed formula with labels, or how it cannot be put that way. */
function conditionWords(layout: PdfLayoutDocument, context: PdfLayoutConditionContext, index: FormIndex): string {
  const text = wordsOf(context);
  const condition = readPdfLayoutCondition(layout);
  if (!condition) {
    return builderText("pdf.condition.none", undefined, text);
  }
  if (!condition.evaluable) {
    return builderText("pdf.condition.never", undefined, text);
  }
  const words = conditionInWords(condition.expression, (path) => {
    const componentId = componentOfPath(index, path);
    const node = componentId !== undefined ? index.nodes.get(componentId)?.node : undefined;
    return node && componentId === path ? componentLabel(node, context) : undefined;
  });
  return words !== undefined ? builderText("pdf.condition.when", { words }, text) : builderText("pdf.condition.custom", undefined, text);
}

/**
 * The automatic order in words, for the Form panel's PDF group: "Chosen by the answers:
 * 1. Quebec copy, when Province equals “QC”. 2. Large print, when len(Applicants) > 2.
 * Otherwise: Standard." — or, with no condition anywhere, what a download that names no
 * layout prints.
 */
export function pdfLayoutOrderInWords(context: PdfLayoutConditionContext, configuration: PdfConfiguration | undefined): string {
  const layouts = pdfLayoutsOf(configuration);
  const locale = context.locale ?? "en";
  const text = wordsOf(context);
  const defaultId = effectivePdfDefaultLayoutId(configuration);
  const fallback = layouts.find((layout) => layout.id === defaultId);
  const fallbackName = fallback ? pdfLayoutLabel(fallback, locale, sourcesOf(context)) : builderText("pdf.layout.fromForm", undefined, text);
  const conditional = layouts.filter((layout) => readPdfLayoutCondition(layout) !== undefined);
  if (conditional.length === 0) {
    return builderText("pdf.order.none", { name: fallbackName }, text);
  }
  const index = indexForm(context.formRoot);
  const steps = conditional.map((layout, at) =>
    builderText("pdf.order.step", { index: at + 1, name: pdfLayoutLabel(layout, locale, sourcesOf(context)), condition: conditionWords(layout, context, index) }, text)
  );
  return builderText("pdf.order.chosen", { steps: steps.join(" "), name: fallbackName }, text);
}

/**
 * The Rules tab's opening line on a layout's root: what a condition reads, then where this
 * layout stands — "Its condition is tried 2nd of 3; when none holds, Standard prints." Read on
 * every paint, so it follows a move, a new default and other layouts' conditions.
 */
export function pdfLayoutRulesNote(context: PdfLayoutConditionContext, configuration: PdfConfiguration | undefined, layoutId: string | undefined): string {
  const text = wordsOf(context);
  const reads = builderText("pdf.rulesNote.reads", undefined, text);
  const layouts = pdfLayoutsOf(configuration);
  const layout = layouts.find((entry) => entry.id === layoutId);
  if (!layout) {
    return reads;
  }
  const locale = context.locale ?? "en";
  const defaultId = effectivePdfDefaultLayoutId(configuration);
  const fallback = layouts.find((entry) => entry.id === defaultId);
  const fallbackName = fallback ? pdfLayoutLabel(fallback, locale, sourcesOf(context)) : builderText("pdf.layout.fromForm", undefined, text);
  const conditional = layouts.filter((entry) => readPdfLayoutCondition(entry) !== undefined);
  const place = conditional.indexOf(layout);
  const isDefault = layout.id === defaultId;
  let where: string;
  if (place >= 0) {
    const tried = { ordinal: ordinal(place + 1, text), count: conditional.length };
    where = isDefault
      ? builderText("pdf.rulesNote.tried.default", tried, text)
      : builderText("pdf.rulesNote.tried", { ...tried, fallback: fallbackName }, text);
  } else if (isDefault) {
    where = builderText(conditional.length > 0 ? "pdf.rulesNote.defaultConditional" : "pdf.rulesNote.default", undefined, text);
  } else {
    where = builderText("pdf.rulesNote.byId", { fallback: fallbackName }, text);
  }
  return `${reads} ${where}`;
}

/**
 * `configuration` with the layout `layoutId`'s condition as `when` — as the Rules tab's draft
 * has it, say, so findings and words follow the author's typing before a Save. `undefined` or
 * `null` takes the condition away. The configuration itself when nothing changes.
 */
export function withPdfLayoutCondition(configuration: PdfConfiguration, layoutId: string, when: unknown): PdfConfiguration {
  const layouts = pdfLayoutsOf(configuration);
  const at = layouts.findIndex((layout) => layout.id === layoutId);
  const layout = layouts[at];
  if (!layout) {
    return configuration;
  }
  const cleared = when === undefined || when === null;
  if (cleared ? layout.when === undefined : JSON.stringify(layout.when) === JSON.stringify(when)) {
    return configuration;
  }
  const { when: _previous, ...rest } = layout;
  const next = (cleared ? rest : { ...rest, when }) as PdfLayoutDocument;
  return { ...configuration, layouts: layouts.map((entry, position) => (position === at ? next : entry)) };
}

/**
 * A form component renamed from `from` to `to`: every layout's `when` with the
 * paths that lead with `from` renamed (`renameInRuleSource`: a formula string over the parser's
 * spans, a tree through its path nodes), a template layout's field and area `expression`
 * sources the same way, and the ids of the layouts that changed. The configuration itself when
 * none did. PDF bindings follow too: a generated layout's `pdf-field` `componentId` and the
 * `collectionPath` of a `pdf-repeat` or `pdf-table`, a template layout's `component` and `path`
 * sources; nor is a `when` or an expression that names no such path rewritten. A formula the
 * parser rejects is left as written; `unparsed` lists those that spell the old id, for the
 * rename to report.
 */
export function renamePdfLayoutConditions(
  configuration: PdfConfiguration,
  from: string,
  to: string,
  dataPath?: ValuePathMoves
): { configuration: PdfConfiguration; renamed: string[]; unparsed: PdfRenameUnparsed[] } {
  const renamed: string[] = [];
  const unparsed: PdfRenameUnparsed[] = [];
  const layouts = pdfLayoutsOf(configuration).map((layout) => {
    let next: PdfLayoutDocument = layout;
    if (layout.when !== undefined) {
      const when = renameInRuleSource(layout.when, from, to);
      if (when !== layout.when) {
        next = { ...next, when };
      }
      const text = unparsedFormulaNaming(layout.when, from);
      if (text !== undefined) {
        unparsed.push({ layoutId: layout.id, where: "when", formula: text });
      }
    }
    if (layout.kind === "generated") {
      const root = renameBindingsInTree(layout.root, from, to, dataPath);
      if (root !== layout.root) {
        next = { ...next, root } as PdfLayoutDocument;
      }
    }
    if (layout.kind === "template") {
      const fields = renameExpressionSources(layout.fields, from, to, dataPath, (index, text) => unparsed.push({ layoutId: layout.id, where: `fields[${index}]`, formula: text }));
      const areas = layout.areas === undefined ? undefined : renameExpressionSources(layout.areas, from, to, dataPath, (index, text) => unparsed.push({ layoutId: layout.id, where: `areas[${index}]`, formula: text }));
      if (fields !== layout.fields || (areas !== undefined && areas !== layout.areas)) {
        next = { ...(next as PdfTemplateLayout), fields, ...(areas === undefined ? {} : { areas }) };
      }
    }
    if (next !== layout) {
      renamed.push(layout.id);
    }
    return next;
  });
  return renamed.length === 0 ? { configuration, renamed, unparsed } : { configuration: { ...configuration, layouts }, renamed, unparsed };
}

/** The configuration key a generated layout's node binds to the form by, per node type. */
const GENERATED_BINDING_KEYS: Readonly<Record<string, string>> = {
  [PDF_FIELD_COMPONENT_TYPE]: "componentId",
  [PDF_REPEAT_COMPONENT_TYPE]: "collectionPath",
  [PDF_TABLE_COMPONENT_TYPE]: "collectionPath"
};

/**
 * A binding value with `from` renamed to `to`: a component id exactly, a collection path or a
 * path source by the move of the data when the rename carries one (`dataPath`), else by its
 * leading name. A component id is no path, so the data's move never applies to it.
 */
function renameBinding(value: string, from: string, to: string, dataPath?: ValuePathMoves, key?: string): string {
  return key === "componentId" || key === "source.componentId" ? renameFormulaPath(value, from, to) : renameAnswerPath(value, from, to, dataPath);
}

/** `root` with the form-bound keys of its nodes (see {@link GENERATED_BINDING_KEYS}) renamed; the same node when none changes. */
function renameBindingsInTree(root: ComponentNode, from: string, to: string, dataPath?: ValuePathMoves): ComponentNode {
  let changed = false;
  let configuration = root.configuration;
  const key = GENERATED_BINDING_KEYS[root.type];
  if (key !== undefined && isRecord(configuration) && typeof configuration[key] === "string") {
    const renamed = renameBinding(configuration[key] as string, from, to, dataPath, key);
    if (renamed !== configuration[key]) {
      configuration = { ...configuration, [key]: renamed };
      changed = true;
    }
  }
  let children = root.children;
  if (children) {
    const next: Record<string, ComponentNode[]> = {};
    for (const [slot, list] of Object.entries(children)) {
      const mapped = list.map((child) => renameBindingsInTree(child, from, to, dataPath));
      if (mapped.some((child, at) => child !== list[at])) {
        changed = true;
      }
      next[slot] = mapped.some((child, at) => child !== list[at]) ? mapped : list;
    }
    children = changed ? next : children;
  }
  return changed ? { ...root, configuration: configuration as ComponentNode["configuration"], ...(children ? { children } : {}) } : root;
}

/** A formula in a layout the parser rejects while it spells the old id, left as written by {@link renamePdfLayoutConditions}. */
export interface PdfRenameUnparsed {
  layoutId: string;
  /** `when`, `fields[i]` or `areas[i]`. */
  where: string;
  formula: string;
}

/** `bindings` with every `expression` source renamed through `renameInRuleSource`; the same array when none changes. */
function renameExpressionSources<T extends PdfMappingBinding>(bindings: T[], from: string, to: string, dataPath: ValuePathMoves | undefined, report: (index: number, text: string) => void): T[] {
  let changed = false;
  const next = bindings.map((binding, index) => {
    const source = binding.source;
    if (isRecord(source) && source.kind === "component" && from !== to && source.componentId === from) {
      changed = true;
      return { ...binding, source: { ...source, componentId: to } };
    }
    if (isRecord(source) && source.kind === "path" && typeof source.path === "string" && renameAnswerPath(source.path, from, to, dataPath) !== source.path) {
      changed = true;
      return { ...binding, source: { ...source, path: renameAnswerPath(source.path, from, to, dataPath) } };
    }
    if (!isRecord(source) || source.kind !== "expression") {
      return binding;
    }
    const text = unparsedFormulaNaming(source.expression, from);
    if (text !== undefined) {
      report(index, text);
    }
    const expression = renameInRuleSource(source.expression, from, to);
    if (expression === source.expression) {
      return binding;
    }
    changed = true;
    return { ...binding, source: { ...source, expression } };
  });
  return changed ? next : bindings;
}

/** One value a rename's follow-up writes into an open tree: a node's property, by its path. */
export interface TreeRenameWrite {
  componentId: string;
  propertyPath: string;
  value: unknown;
}

/**
 * What a rename's follow-up writes into one open tree: the committed values, written together,
 * then the unsaved values of the drafts that hold their own (`setProperties` writes a committed
 * value into an open draft as well, so a draft with a value of its own gets it back, renamed).
 */
export interface TreeRenameWrites {
  committed: TreeRenameWrite[];
  drafted: TreeRenameWrite[];
}

/**
 * How a rename's follow-up writes into an open tree. By default the committed values are one
 * step of the tree's history. `unrecorded` writes them with no entry at all: the PDF mode's
 * follow-up of a form rename, which is a part of the rename's own step of the form's history,
 * so the form's Undo and Redo carry the tree, and the tree's own Undo never meets it.
 */
export interface TreeRenameOptions {
  unrecorded?: boolean;
}

/** Writes `writes` into `controller`'s tree as {@link TreeRenameOptions} says. Whether anything was written. */
export function writeTreeRename(controller: BuilderController, writes: TreeRenameWrites, options: TreeRenameOptions = {}): boolean {
  if (writes.committed.length > 0) {
    controller.setProperties(writes.committed, options.unrecorded ? { unrecorded: true } : {});
  }
  for (const draft of writes.drafted) {
    controller.setDraftProperty(draft.componentId, draft.propertyPath, draft.value);
  }
  return writes.committed.length > 0 || writes.drafted.length > 0;
}

/**
 * A form rename followed into one layout's open tree, where its condition rides on the root's
 * `when` and its fields name what they print: the committed condition and bindings
 * are rewritten in place, together (one step of the layout's history, or none with
 * `unrecorded`, {@link TreeRenameOptions}), and an unsaved condition the Rules tab holds is
 * renamed too rather than overwritten. The layout's other drafted edits stay as they were.
 * Whether anything was rewritten.
 */
export function followRenameInLayoutTree(controller: BuilderController, from: string, to: string, dataPath?: ValuePathMoves, options: TreeRenameOptions = {}): boolean {
  const writes: TreeRenameWrites = { committed: [], drafted: [] };
  const visit = (node: ComponentNode): void => {
    const key = GENERATED_BINDING_KEYS[node.type];
    if (key !== undefined) {
      followBindingProperty(controller, node, key, key, from, to, dataPath, writes);
    }
    for (const list of Object.values(node.children ?? {})) {
      list.forEach(visit);
    }
  };
  visit(controller.snapshot());
  const rootId = controller.rootId();
  const configuration = controller.snapshot().configuration;
  const committed = isRecord(configuration) ? configuration.when : undefined;
  const drafted = controller.hasPendingChanges(rootId) ? controller.draftProperty(rootId, "when") : committed;
  const ownDraft = JSON.stringify(drafted ?? null) !== JSON.stringify(committed ?? null);
  const nextCommitted = committed === undefined ? committed : renameInRuleSource(committed, from, to);
  const nextDrafted = drafted === undefined ? drafted : renameInRuleSource(drafted, from, to);
  if (nextCommitted !== committed) {
    writes.committed.push({ componentId: rootId, propertyPath: "when", value: nextCommitted });
  }
  if (ownDraft && (nextCommitted !== committed || nextDrafted !== drafted)) {
    writes.drafted.push({ componentId: rootId, propertyPath: "when", value: nextDrafted });
  }
  return writeTreeRename(controller, writes, options) || nextDrafted !== drafted;
}

/**
 * One bound property of `node` followed through a form rename: the committed value in place and
 * an unsaved one in the node's draft renamed with it, both added to `writes` (the caller writes
 * them, {@link writeTreeRename}); written at once, as one step of the layout's history, without
 * it. `key` is the configuration key the node stores it under, `property` the path the
 * controller edits it by (they differ for a template source: `source.componentId`). Whether
 * anything changed.
 */
export function followBindingProperty(
  controller: BuilderController,
  node: ComponentNode,
  key: string,
  property: string,
  from: string,
  to: string,
  dataPath?: ValuePathMoves,
  writes?: TreeRenameWrites
): boolean {
  const config = isRecord(node.configuration) ? node.configuration : {};
  const stored = property.includes(".") ? property.split(".").reduce<unknown>((value, part) => (isRecord(value) ? value[part] : undefined), config) : config[key];
  const committed = typeof stored === "string" ? stored : undefined;
  const draftValue = controller.hasPendingChanges(node.id) ? controller.draftProperty(node.id, property) : committed;
  const drafted = typeof draftValue === "string" ? draftValue : undefined;
  const own = writes ?? { committed: [], drafted: [] };
  let changed = false;
  if (committed !== undefined && renameBinding(committed, from, to, dataPath, key) !== committed) {
    own.committed.push({ componentId: node.id, propertyPath: property, value: renameBinding(committed, from, to, dataPath, key) });
    changed = true;
  }
  if (drafted !== undefined && drafted !== committed && renameBinding(drafted, from, to, dataPath, key) !== drafted) {
    own.drafted.push({ componentId: node.id, propertyPath: property, value: renameBinding(drafted, from, to, dataPath, key) });
    changed = true;
  }
  if (!writes) {
    writeTreeRename(controller, own);
  }
  return changed;
}
