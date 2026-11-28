/**
 * The PDF designer over a populated-form layout: the template's own fields and the
 * areas drawn on its pages as a builder tree, so the mapping is edited the way everything else
 * in the builder is — a box selected on the page, its properties in the inspector, drafts
 * landed by Save, every edit undoable, the layout live in the catalog. This mirrors
 * `createPdfDesigner` for a custom layout: it hands `<datum-builder>` ordinary
 * `BuilderControllerOptions` and folds the tree back into a `PdfTemplateLayout`.
 *
 * The widgets come from the kernel's `inspect` op over the PDF; without an executor the tree
 * holds the root (the PDF and the fill options) and the areas, and the layout's field mappings
 * ride along untouched until the fields can be listed.
 */
import type { LocalizedText, PropertyEditorValueMap } from "../../core/schema/contracts.js";
import { addressOf, readTranslation, resolveText, type FormTranslations, type TextAddress, type TextSources, type TranslationCatalog } from "../../core/localization/translations.js";
import { readSourceId } from "../../core/schema/data-source-capability.js";
import { parseInlineOptions } from "../../core/schema/inline-options.js";
import type { RuleSource } from "../../core/expressions/expression.js";
import { DEFAULT_PDF_AREA_DRAW, pdfFieldNameProblem, readPdfValueMap, resolvePdfAreaFields, type PdfFieldMapping, type PdfFieldMappingSource, type PdfMappingBinding, type PdfTemplateArea, type PdfTemplateAreaDraw, type PdfTemplateAreaField, type PdfTemplateLayout, type PdfTemplateSource, type PdfValueFormat } from "../../core/schema/pdf-layout.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { PdfTemplateFieldInfo, PdfTemplateInfo } from "../../render/pdf/pdf-abi.js";
import type { PdfBindableComponent } from "../../render/pdf/pdf-components.js";
import { pdfFillTextAddress } from "../../render/pdf/pdf-text-addresses.js";
import type { PdfProfileOption, PdfTemplateOption } from "../../render/pdf/pdf-provider.js";
import {
  PDF_AREA_COMPONENT_TYPE,
  PDF_TEMPLATE_AREAS_SLOT,
  PDF_TEMPLATE_COMPONENT_TYPE,
  PDF_TEMPLATE_WIDGETS_SLOT,
  PDF_WIDGET_COMPONENT_TYPE,
  pdfTemplateComponentDefinitions,
  pdfTemplateComponentTypes,
  type PdfTemplateText
} from "../../render/pdf/pdf-template-components.js";
import type { BuilderController, BuilderControllerOptions, BuilderNote, BuilderProblem } from "../controller/builder-controller.js";
import { renameFormulaPath, renameInRuleSource, unparsedFormulaNaming, type ValuePathMoves } from "../formula/rename.js";
import { isScopedExpressionPath } from "../../core/expressions/condition-shape.js";
import { kernelRuleExpression } from "../../core/expressions/compile.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import { journeyLeadingSegment } from "../../core/journey/journey-shared.js";
import { buildDataPaths, collectionPathOf, dataKeyOf } from "../../core/tree/data-scope.js";
import { kernelFoldHoldsOwnAnswer } from "../../core/state/submittable-fold.js";
import type { BuilderTextCatalog, BuilderTextOptions } from "../logic/builder-texts.js";
import { builderPlural, builderText, formatListText } from "./pdf-texts-en.js";
import { formulaFieldsOf } from "../formula/formula-fields.js";
import { formulaEditorState } from "../formula/formula-textarea.js";
import { extractDependencies } from "../../rules/dependencies/dependency-extractor.js";
import { followBindingProperty, writeTreeRename, type TreeRenameOptions, type TreeRenameWrites } from "./layout-conditions.js";
import { bindableComponents } from "./pdf-designer.js";
import { clampAreaRect } from "./template-mode.js";

export interface PdfTemplateDesignerOptions {
  layout: PdfTemplateLayout;
  /** What the kernel said about the template's PDF; absent (no executor yet), the tree lists no widgets. */
  inspection?: PdfTemplateInfo | undefined;
  formRoot: ComponentNode;
  locale?: string | undefined;
  /** The definition's own translations: labels are worded through them, and a fill text's translations count as readings of the answers. */
  translations?: FormTranslations | undefined;
  translationCatalog?: TranslationCatalog | undefined;
  /** The host's builder texts per locale (`BuilderTextCatalog`); absent, English. */
  textCatalog?: BuilderTextCatalog | undefined;
  /** The PDFs the host offers authors, for the root's PDF picker. */
  hostTemplates?: readonly PdfTemplateOption[] | undefined;
  outputIntentProfiles?: readonly PdfProfileOption[] | undefined;
  /** The tree the layout is open in, when the designer is made again over it: each widget keeps the id that tree gave it. */
  tree?: ComponentNode | undefined;
}

export interface PdfTemplateDesigner {
  /** What to hand `<datum-builder>` / `BuilderController`. */
  builderOptions: BuilderControllerOptions;
  /** The layout as the designer started with it. */
  layout: PdfTemplateLayout;
  inspection: PdfTemplateInfo | undefined;
  /**
   * The layout a builder tree stands for: the root's own settings, the mapped widgets, the
   * areas. The root's `when` is the layout's condition; a root key this designer
   * has no box for rides through as written, so a layout key it does not know is never lost.
   */
  layoutFrom(root: ComponentNode): PdfTemplateLayout;
  /** The node that stands for one of the template's fields, by the field's name. */
  widgetIdFor(pdfField: string): string | undefined;
  /** The template field a widget node stands for; `undefined` for anything else. */
  fieldNameOf(nodeId: string): string | undefined;
  /** The areas the tree holds, as the page viewer draws them (over `previewSnapshot()`, an unsaved rectangle shows). */
  areasOf(root: ComponentNode): PdfTemplateArea[];
  /** The names of the template's fields something fills. */
  mappedFieldsOf(root: ComponentNode): Set<string>;
  /**
   * The names of the template's fields filled from a component that `formIds` (default: the
   * form the designer was built over) does not hold — an undo on the Form tab, a field removed
   * there. Nothing fills them in a print, so Create form fields treats them as unmapped.
   */
  unresolvedFieldsOf(root: ComponentNode, formIds?: ReadonlySet<string>): Set<string>;
  /** The unresolved fields again, each with the first component id it is filled from and the form lacks (the page viewer's tooltip). */
  missingSourcesOf(root: ComponentNode, formIds?: ReadonlySet<string>): Map<string, string>;
  /** The widgets whose value map holds entries that match nothing now. */
  staleValueMapsOf(root: ComponentNode): StaleValueMapWidget[];
  /** Those widgets as one sentence for the layout's status; `undefined` when none. */
  staleSummary(root: ComponentNode): string | undefined;
  /**
   * How the layout's mapping stands against `formRoot` (default: the form the designer was built
   * over): the PDF fields filled from a field the form has, the form's fields nothing on the PDF
   * reads, and the fields whose answers and options do not line up. Read from
   * the same tree and the same Values basis the Preview and the Values notes use.
   */
  coverageOf(root: ComponentNode, formRoot?: ComponentNode): TemplateCoverage;
  /** What the inspector says about a widget or an area as it stands (see `BuilderControllerOptions.notes`). */
  notesFor(edited: ComponentNode, tree: ComponentNode, componentId: string): BuilderNote[];
  /** What holds an area's Save back (see `BuilderControllerOptions.problems`): a page the PDF lacks, a field name a PDF cannot hold. */
  problemsFor(edited: ComponentNode, tree: ComponentNode, componentId: string): BuilderProblem[];
  /** The form's components a widget or an area may be filled from. */
  components: PdfBindableComponent[];
}

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readConfig(node: ComponentNode): Record_ {
  return isRecord(node.configuration) ? node.configuration : {};
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** `widget_` plus the field's name, made an id: letters and digits, runs of anything else one underscore. */
export function widgetNodeId(pdfField: string, taken: ReadonlySet<string>): string {
  const slug = pdfField.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
  const base = `widget_${slug}`;
  if (!taken.has(base)) {
    return base;
  }
  let index = 2;
  while (taken.has(`${base}_${index}`)) {
    index += 1;
  }
  return `${base}_${index}`;
}

// --- stale value-map entries ---------------------------------------------------

/** What a widget's value map holds that matches nothing now. */
export interface StaleValueMapEntries {
  /** The keys that name an answer the source component no longer offers, in the map's order. */
  keys: string[];
  /** The distinct targets that are not an export value of the PDF field, in the map's order. */
  targets: string[];
  /** The entries a "Remove stale entries" would delete: those with a stale key or a stale target, by key. */
  remove: string[];
}

/**
 * The entries of a value map that no longer match. `rows` are the answers the source
 * component offers now, and `undefined` when they are not known at design time (a component
 * whose options come from a data source, a text box): such a map has no stale keys. `targets`
 * are the export options of the PDF field, `undefined` while the PDF has not been inspected: then
 * no target is stale. Nothing here changes the map; reporting is the caller's, deleting the author's.
 */
export function staleValueMapEntries(
  map: ReadonlyMap<string, string> | undefined,
  rows: ReadonlyArray<{ value: string }> | undefined,
  targets: ReadonlyArray<string> | undefined
): StaleValueMapEntries {
  const out: StaleValueMapEntries = { keys: [], targets: [], remove: [] };
  if (!map) {
    return out;
  }
  const answers = rows ? new Set(rows.map((row) => row.value)) : undefined;
  const exports = targets ? new Set(targets) : undefined;
  for (const [key, target] of map) {
    const staleKey = answers !== undefined && !answers.has(key);
    const staleTarget = exports !== undefined && !exports.has(target);
    if (staleKey) {
      out.keys.push(key);
    }
    if (staleTarget && !out.targets.includes(target)) {
      out.targets.push(target);
    }
    if (staleKey || staleTarget) {
      out.remove.push(key);
    }
  }
  return out;
}

/** How a populated form's mapping stands: what {@link PdfTemplateDesigner.coverageOf} returns. */
export interface TemplateCoverage {
  /** The PDF fields filled from something the form still has, in the template's order. */
  mapped: string[];
  /** The form's answer-holding fields no field or area of the PDF reads, labelled as the builder names them. */
  unplaced: Array<{ id: string; label: string }>;
  /** The PDF fields whose Values section warns: answers with no matching option, or entries that match nothing. */
  mismatched: string[];
}

/** One widget of a layout whose value map holds entries that no longer match. */
export interface StaleValueMapWidget extends StaleValueMapEntries {
  widgetId: string;
  pdfField: string;
}

// --- the mapping as node configuration ---------------------------------------------------

/** A binding's source, checked value, value map and format as the inspector edits them. */
function bindingToConfig(binding: PdfMappingBinding | undefined): Record_ {
  const out: Record_ = {};
  const source = binding?.source;
  if (!source) {
    out.source = { kind: "" };
  } else {
    switch (source.kind) {
      case "component":
        out.source = { kind: "component", componentId: source.componentId };
        break;
      case "template":
        out.source = { kind: "template", text: source.text };
        break;
      case "literal":
        // A null literal is the editor's own "nothing yet"; anything else keeps its type (a
        // `true` prints "Yes", a "true" prints the word), and the box shows it as text.
        out.source = source.value === null ? { kind: "" } : { kind: "literal", value: source.value };
        break;
      case "path":
        out.source = { kind: "path", path: source.path };
        break;
      case "expression":
        out.source = { kind: "expression", expression: source.expression };
        break;
      default:
        out.source = { kind: "" };
    }
  }
  if (binding?.checkedValue !== undefined) {
    out.checkedValue = binding.checkedValue;
  }
  const values = readPdfValueMap(binding?.values);
  if (values) {
    out.values = Object.fromEntries(values);
  }
  if (binding?.format) {
    out.format = { kind: binding.format.kind, ...(binding.format.pattern !== undefined ? { pattern: binding.format.pattern } : {}) };
  }
  return out;
}

/** The source the configuration names; `undefined` when nothing fills the widget or area. */
function sourceFromConfig(config: Record_): PdfFieldMappingSource | undefined {
  const source = isRecord(config.source) ? config.source : {};
  switch (source.kind) {
    case "component": {
      const componentId = nonEmpty(source.componentId);
      return componentId ? { kind: "component", componentId } : undefined;
    }
    case "template": {
      // A fill text is a string in the form's default language; its translations are the map's.
      const text = source.text;
      return typeof text === "string" && text.trim() !== "" ? { kind: "template", text } : undefined;
    }
    case "literal": {
      const value = source.value;
      return { kind: "literal", value: typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? value : "" };
    }
    case "path": {
      const path = nonEmpty(source.path);
      return path ? { kind: "path", path } : undefined;
    }
    case "expression":
      return source.expression !== undefined ? { kind: "expression", expression: source.expression as never } : undefined;
    default:
      return undefined;
  }
}

function bindingExtrasFromConfig(config: Record_): Pick<PdfMappingBinding, "checkedValue" | "format" | "values"> {
  const out: Pick<PdfMappingBinding, "checkedValue" | "format" | "values"> = {};
  const checked = nonEmpty(config.checkedValue);
  if (checked !== undefined) {
    out.checkedValue = checked;
  }
  // The value map: the entries that are text, and none at all when none are.
  const values = readPdfValueMap(config.values);
  if (values) {
    out.values = Object.fromEntries(values);
  }
  const format = isRecord(config.format) ? config.format : undefined;
  const kind = format?.kind;
  if (kind === "text" || kind === "number" || kind === "date" || kind === "boolean") {
    const pattern = nonEmpty(format?.pattern);
    out.format = { kind, ...(pattern !== undefined ? { pattern } : {}) } as PdfValueFormat;
  }
  return out;
}

/** An area's drawing choices with the defaults left out, as the layout stores them; `undefined` when all default. */
function drawFromConfig(value: unknown): PdfTemplateAreaDraw | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const defaults: Record<string, unknown> = DEFAULT_PDF_AREA_DRAW;
  const draw: Record_ = {};
  for (const key of ["kind", "fontSize", "align", "valign", "padding", "wrap", "bold", "color"] as const) {
    const entry = value[key];
    if (entry === undefined || entry === null || entry === "" || entry === defaults[key]) {
      continue;
    }
    draw[key] = entry;
  }
  return Object.keys(draw).length > 0 ? (draw as PdfTemplateAreaDraw) : undefined;
}

/** An area's fillable-field choices: present when the author switched the field on. */
function fieldFromConfig(value: unknown): PdfTemplateAreaField | undefined {
  if (!isRecord(value) || value.enabled !== true) {
    return undefined;
  }
  const field: PdfTemplateAreaField = {};
  const name = nonEmpty(value.name);
  if (name !== undefined) {
    field.name = name;
  }
  if (value.required === true) {
    field.required = true;
  }
  if (value.readOnly === true) {
    field.readOnly = true;
  }
  const tooltip = nonEmpty(value.tooltip);
  if (tooltip !== undefined) {
    field.tooltip = tooltip;
  }
  return field;
}

/** A settings block without what means "not set": empty strings, `false`, `null`, and blocks left empty by that. */
function pruneDefaults(value: unknown): Record_ | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record_ = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || entry === "" || entry === false) {
      continue;
    }
    if (isRecord(entry)) {
      const nested = pruneDefaults(entry);
      if (nested && Object.keys(nested).length > 0) {
        out[key] = nested;
      }
      continue;
    }
    out[key] = entry;
  }
  return out;
}

/**
 * The signature block with its defaults left out, but its `appearance: false` kept: that asks
 * for an invisible signature, where leaving it out draws the default visible one.
 */
function pruneSignature(value: unknown): Record_ | undefined {
  const out = pruneDefaults(value);
  if (out && isRecord(value) && value.appearance === false) {
    out.appearance = false;
  }
  return out;
}

function readRect(value: unknown): PdfTemplateArea["rect"] {
  const rect = isRecord(value) ? value : {};
  const num = (entry: unknown, fallback: number): number => (typeof entry === "number" && Number.isFinite(entry) ? entry : fallback);
  return { x: num(rect.x, 0), y: num(rect.y, 0), width: num(rect.width, 72), height: num(rect.height, 18) };
}

type PageSize = { width: number; height: number };

function readPage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.round(value) : 1;
}

/** The rectangle kept on its page when the page is known (the viewer's drags go through the same clamp); as written otherwise. */
function placedRect(rect: PdfTemplateArea["rect"], page: PageSize | undefined): PdfTemplateArea["rect"] {
  return page ? clampAreaRect(rect, page) : rect;
}

function areaFromNode(node: ComponentNode, pageOf: (index: number) => PageSize | undefined = () => undefined): PdfTemplateArea {
  const config = readConfig(node);
  const page = readPage(config.page);
  const area: PdfTemplateArea = {
    id: node.id,
    page,
    rect: placedRect(readRect(config.rect), pageOf(page)),
    // An area nothing fills yet holds a null literal, the editor's empty source, so the
    // kernel draws the box (or the field) with nothing in it.
    source: sourceFromConfig(config) ?? { kind: "literal", value: null },
    ...bindingExtrasFromConfig(config)
  };
  const label = nonEmpty(config.label);
  if (label !== undefined) {
    area.label = label;
  }
  const draw = drawFromConfig(config.draw);
  if (draw) {
    area.draw = draw;
  }
  const field = fieldFromConfig(config.field);
  if (field) {
    area.field = field;
  }
  return area;
}

function areaToNode(area: PdfTemplateArea, pageOf: (index: number) => PageSize | undefined = () => undefined): ComponentNode {
  const { source: _source, checkedValue: _checked, values: _values, format: _format, ...rest } = area;
  return {
    id: area.id,
    type: PDF_AREA_COMPONENT_TYPE,
    configuration: {
      ...(rest.label !== undefined ? { label: rest.label } : {}),
      page: area.page,
      // Another PDF's pages (a swap, a layout written elsewhere): kept on the page it names.
      rect: { ...placedRect(area.rect, pageOf(area.page)) },
      ...bindingToConfig(area),
      ...(area.draw ? { draw: { ...area.draw } } : {}),
      ...(area.field ? { field: { enabled: true, ...area.field } } : {})
    }
  };
}

function widgetToNode(field: PdfTemplateFieldInfo, id: string, mapping: PdfFieldMapping | undefined): ComponentNode {
  return {
    id,
    type: PDF_WIDGET_COMPONENT_TYPE,
    configuration: {
      pdfField: field.name,
      // The outline and the inspector's heading read the node's label: the field's own name.
      label: field.name,
      kind: field.kind,
      ...(field.page !== undefined ? { page: field.page } : {}),
      ...(field.rect ? { rect: { ...field.rect } } : {}),
      ...bindingToConfig(mapping)
    }
  };
}

/** A template layout's keys that the tree holds as its structure, never as the root's settings. */
const TEMPLATE_LAYOUT_OWN_KEYS: ReadonlySet<string> = new Set(["id", "kind", "fields", "areas"]);

function childrenOf(root: ComponentNode, slot: string): ComponentNode[] {
  return root.children?.[slot] ?? [];
}

function findIn(root: ComponentNode, id: string): ComponentNode | undefined {
  if (root.id === id) {
    return root;
  }
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      const found = findIn(child, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** A configuration value by its dotted path (`field.name`). */
function readNested(node: ComponentNode, path: string): unknown {
  let value: unknown = node.configuration;
  for (const key of path.split(".")) {
    value = isRecord(value) ? value[key] : undefined;
  }
  return value;
}

export function createPdfTemplateDesigner(options: PdfTemplateDesignerOptions): PdfTemplateDesigner {
  const locale = options.locale ?? "en";
  const text: BuilderTextOptions = { locale, ...(options.textCatalog ? { catalog: options.textCatalog } : {}) };
  const layout = options.layout;
  const inspection = options.inspection;
  const textSources: TextSources = { translations: options.translations, catalog: options.translationCatalog };
  const components = bindableComponents(options.formRoot, locale, textSources);

  // One node per template field, in the order the template declares them, seeded from the
  // layout's mappings by field name — so a mapping over another PDF's field of the same name
  // carries over, and one naming a field this PDF lacks is left behind.
  const mappingByName = new Map(layout.fields.map((mapping) => [mapping.pdfField, mapping]));
  const widgetIds = new Map<string, string>();
  const taken = new Set<string>(["template", ...(layout.areas ?? []).map((area) => area.id)]);
  // Over a tree already open: its widgets' ids, by the field each names.
  const treeIds = new Map<string, string>();
  for (const node of options.tree ? childrenOf(options.tree, PDF_TEMPLATE_WIDGETS_SLOT) : []) {
    const name = readConfig(node).pdfField;
    if (typeof name === "string" && !treeIds.has(name)) {
      treeIds.set(name, node.id);
      taken.add(node.id);
    }
  }
  const widgets: ComponentNode[] = (inspection?.fields ?? []).map((field) => {
    const kept = treeIds.get(field.name);
    const id = kept !== undefined && !widgetIds.has(field.name) ? kept : widgetNodeId(field.name, taken);
    taken.add(id);
    widgetIds.set(field.name, id);
    return widgetToNode(field, id, mappingByName.get(field.name));
  });
  const pageOf = (index: number): PageSize | undefined => inspection?.pages.find((page) => page.index === index);
  const areas = (layout.areas ?? []).map((area) => areaToNode(area, pageOf));
  const formIds = new Set<string>();
  const formNodes = new Map<string, ComponentNode>();
  // The names a value path may lead with: an id, a data key or where a section keeps its entries.
  const dataNames = new Set<string>();
  const collectIds = (node: ComponentNode): void => {
    formIds.add(node.id);
    formNodes.set(node.id, node);
    dataNames.add(node.id);
    dataNames.add(dataKeyOf(node));
    const collection = collectionPathOf(node);
    if (collection !== undefined) {
      dataNames.add(journeyLeadingSegment(collection));
    }
    for (const group of Object.values(node.children ?? {})) {
      group.forEach(collectIds);
    }
  };
  collectIds(options.formRoot);
  // The saved paths, as the Data workspace lists them: the path each answer is stored under, with its name.
  const savedPaths = buildDataPaths(options.formRoot);
  const dataPathChoices = formulaFieldsOf(options.formRoot, { locale, dataPathOf: (id) => savedPaths.get(id) }).map((field) => ({ value: field.path, label: field.label }));
  const templateFieldNames = (inspection?.fields ?? []).map((field) => field.name);

  const { fields: _fields, areas: _areas, id: _id, kind: _kind, template, ...rootSettings } = layout;
  const root: ComponentNode = {
    id: "template",
    type: PDF_TEMPLATE_COMPONENT_TYPE,
    configuration: { ...rootSettings, template },
    children: { [PDF_TEMPLATE_WIDGETS_SLOT]: widgets, [PDF_TEMPLATE_AREAS_SLOT]: areas }
  };

  const texts: PdfTemplateText = (key, params) => builderText(key, params, text);
  const fieldInfo = new Map((inspection?.fields ?? []).map((field) => [field.name, field] as const));

  /**
   * What a widget's Values section works from: present for a PDF radio group,
   * dropdown or list (the kernel lists its export `options`) filled from a form component. The
   * component's answers are `rows` when they are known now — a checkbox (true / false) or inline
   * options with no data source — and `undefined` when they are not: a component whose options
   * come from a data source has none to list here, and the author types the map in the layout's
   * JSON (its keys are then never stale). `stale` is what the map holds that matches nothing.
   */
  const valueMapBasis = (
    widget: ComponentNode
  ): { rows: Array<{ value: string; label: LocalizedText }> | undefined; targets: string[]; stale: StaleValueMapEntries } | undefined => {
    const config = readConfig(widget);
    const info = typeof config.pdfField === "string" ? fieldInfo.get(config.pdfField) : undefined;
    if (!info || (info.kind !== "radio" && info.kind !== "dropdown" && info.kind !== "listbox") || !info.options || info.options.length === 0) {
      return undefined;
    }
    const componentId = isRecord(config.source) && config.source.kind === "component" ? nonEmpty(config.source.componentId) : undefined;
    const component = componentId !== undefined ? formNodes.get(componentId) : undefined;
    if (!component) {
      return undefined;
    }
    const componentConfig = readConfig(component);
    let rows: Array<{ value: string; label: LocalizedText }> | undefined;
    if (component.type === "checkbox") {
      rows = [
        { value: "true", label: texts("pdfTemplate.values.yes") },
        { value: "false", label: texts("pdfTemplate.values.no") }
      ];
    } else if (readSourceId(componentConfig) === undefined && Array.isArray(componentConfig.options)) {
      // A list that was emptied is still a list: every entry of the map is then stale. A
      // component with no `options` at all (a text box) has answers of any kind.
      rows = parseInlineOptions(componentConfig.options).map((option) => ({ value: option.value, label: resolveText(option.label, addressOf.option(component.id, option.value, "label"), locale, textSources) || option.value }));
    }
    return { rows, targets: info.options, stale: staleValueMapEntries(readPdfValueMap(config.values), rows, info.options) };
  };

  /**
   * What a widget's Values section translates: the answers of the component it is filled from
   * and the options of the PDF field. Not drawn without answers to list — unless entries are
   * left over (every option removed), which the section then names so they can be removed.
   */
  const valueMapFor = (widget: ComponentNode): PropertyEditorValueMap | undefined => {
    const basis = valueMapBasis(widget);
    if (!basis || !basis.rows || (basis.rows.length === 0 && basis.stale.remove.length === 0)) {
      return undefined;
    }
    const { rows, targets, stale } = basis;
    return {
      rows,
      targets: targets.map((value) => ({ value, label: value })),
      byOrder: Object.fromEntries(rows.slice(0, targets.length).map((row, index) => [row.value, targets[index]!])),
      sameLabel: texts("pdfTemplate.values.same"),
      byOrderLabel: texts("pdfTemplate.values.byOrder"),
      byOrderHint: texts("pdfTemplate.values.byOrder.hint"),
      ...(stale.remove.length > 0
        ? { stale: stale.remove, removeStaleLabel: texts("pdfTemplate.values.removeStale"), removeStaleHint: texts("pdfTemplate.values.removeStale.hint") }
        : {})
    };
  };

  const quoted = (items: string[]): string => formatListText(items.map((item) => `"${item}"`), { type: "conjunction", ...text });

  /**
   * The notices under the Values section: answers that name no option of the PDF field and have
   * no value set, then entries for options the form no longer has and targets the PDF
   * field does not list. Advisory, as ever: none holds Save back.
   */
  const valueMapNotes = (edited: ComponentNode): BuilderNote[] => {
    const spec = edited.type === PDF_WIDGET_COMPONENT_TYPE ? valueMapFor(edited) : undefined;
    if (!spec) {
      return [];
    }
    const notes: BuilderNote[] = [];
    const chosen = readPdfValueMap(readConfig(edited).values);
    const unmatched = spec.rows.filter((row) => !spec.targets.some((target) => target.value === row.value) && !chosen?.has(row.value));
    if (unmatched.length > 0) {
      const names = formatListText(
        unmatched.map((row) => `"${typeof row.label === "string" ? row.label : row.value}"`),
        { type: "conjunction", ...text }
      );
      notes.push({ target: "values", message: builderText("pdfTemplate.values.unmatched", { names }, text) });
    }
    const stale = valueMapBasis(edited)?.stale;
    if (stale && stale.keys.length > 0) {
      notes.push({ target: "values", message: builderText("pdfTemplate.values.staleKeys", { names: quoted(stale.keys) }, text) });
    }
    if (stale && stale.targets.length > 0) {
      notes.push({ target: "values", message: builderPlural("pdfTemplate.values.staleTargets", stale.targets.length, { names: quoted(stale.targets) }, text) });
    }
    return notes;
  };

  /** The widgets of `tree` (drafts laid over, when it is a preview) whose value map holds entries that match nothing now. */
  const staleValueMapsOf = (tree: ComponentNode): StaleValueMapWidget[] => {
    const out: StaleValueMapWidget[] = [];
    for (const widget of childrenOf(tree, PDF_TEMPLATE_WIDGETS_SLOT)) {
      const config = readConfig(widget);
      // Most widgets have no map: skipped before any lookup, as this runs on every draft keystroke.
      if (!isRecord(config.values) || typeof config.pdfField !== "string") {
        continue;
      }
      // Only where the Values section is drawn: that is where the note and the button are. A
      // component with a data source has neither, so its hand-written map is not called stale.
      const stale = valueMapFor(widget) ? valueMapBasis(widget)?.stale : undefined;
      if (stale && stale.remove.length > 0) {
        out.push({ widgetId: widget.id, pdfField: config.pdfField, ...stale });
      }
    }
    return out;
  };

  /** The sentence the layout's status shows for {@link staleValueMapsOf}; `undefined` when nothing is stale. */
  const staleSummary = (tree: ComponentNode): string | undefined => {
    const stale = staleValueMapsOf(tree);
    return stale.length === 0 ? undefined : builderPlural("pdfTemplate.values.staleLayout", stale.length, { names: quoted(stale.map((entry) => entry.pdfField)) }, text);
  };

  const definitions = pdfTemplateComponentDefinitions({
    valueMapFor,
    formComponents: components,
    hostTemplates: options.hostTemplates,
    outputIntentProfiles: options.outputIntentProfiles,
    signatureFields: inspection?.fields.filter((field) => field.kind === "signature").map((field) => field.name),
    locale,
    texts
  });

  const fieldsFrom = (tree: ComponentNode): PdfFieldMapping[] => {
    if (!inspection) {
      // Nothing listed the fields: the mappings ride along as they came.
      return layout.fields;
    }
    const out: PdfFieldMapping[] = [];
    for (const node of childrenOf(tree, PDF_TEMPLATE_WIDGETS_SLOT)) {
      const config = readConfig(node);
      const pdfField = nonEmpty(config.pdfField);
      const source = sourceFromConfig(config);
      if (!pdfField || !source) {
        continue;
      }
      const extras = bindingExtrasFromConfig(config);
      // A map the Values section cannot show is not kept: a widget no longer filled from a
      // component, or for a PDF field that is not a radio group, dropdown or list, would
      // otherwise go on translating answers with nothing in the inspector to say so.
      const kind = fieldInfo.get(pdfField)?.kind;
      if (extras.values && (source.kind !== "component" || (kind !== undefined && kind !== "radio" && kind !== "dropdown" && kind !== "listbox"))) {
        delete extras.values;
      }
      out.push({ pdfField, source, ...extras });
    }
    return out;
  };

  const layoutFrom = (tree: ComponentNode): PdfTemplateLayout => {
    const config = readConfig(tree);
    const { template: source, name, options: fill, accessibility, conformance, signature, attachments, when, ...unknown } = config;
    const next: PdfTemplateLayout = {
      id: layout.id,
      kind: "template",
      template: isRecord(source) ? (source as unknown as PdfTemplateSource) : layout.template,
      fields: fieldsFrom(tree)
    };
    // The root was seeded with every layout key but these four (`rootSettings` above): what is
    // left over is a key this designer has no box for — a later layout version's, a host's —
    // and it goes back as it came rather than vanish on the first edit.
    for (const [key, value] of Object.entries(unknown)) {
      if (value !== undefined && !TEMPLATE_LAYOUT_OWN_KEYS.has(key)) {
        (next as unknown as Record_)[key] = value;
      }
    }
    if (typeof name === "string" && name.trim() !== "") {
      next.name = name;
    }
    // The layout's condition, as written: one the evaluator cannot run never holds,
    // and is the author's to mend rather than the designer's to drop. Cleared, there is none.
    if (when !== undefined && when !== null) {
      next.when = when as RuleSource;
    }
    const areaList = childrenOf(tree, PDF_TEMPLATE_AREAS_SLOT).map((node) => areaFromNode(node, pageOf));
    if (areaList.length > 0) {
      next.areas = areaList;
    }
    // The settings blocks with their defaults left out: an option switched off, a level set
    // back to none, an empty name are the same as never set, and the layout says nothing.
    // A signature's `appearance: false` is the exception: it is a choice, not a default.
    for (const [key, value] of [
      ["options", pruneDefaults(fill)],
      ["accessibility", isRecord(accessibility) ? accessibility : undefined],
      ["conformance", pruneDefaults(conformance)],
      ["signature", pruneSignature(signature)],
      ["attachments", pruneDefaults(attachments)]
    ] as const) {
      if (isRecord(value) && Object.keys(value).length > 0) {
        (next as unknown as Record_)[key] = value;
      }
    }
    return next;
  };

  /** The name an area's fillable field is made under in this tree (as the print resolves them all together), or `undefined` for page content. */
  const areaFieldName = (tree: ComponentNode, edited: ComponentNode): string | undefined => {
    const nodes = childrenOf(tree, PDF_TEMPLATE_AREAS_SLOT).map((node) => (node.id === edited.id ? edited : node));
    const index = nodes.findIndex((node) => node.id === edited.id);
    return index < 0 ? undefined : resolvePdfAreaFields(nodes.map((node) => areaFromNode(node)))[index]?.name;
  };

  /** A field name the PDF's own fields already claim: the same name, or one on the same path. */
  const clashingTemplateField = (name: string): string | undefined =>
    templateFieldNames.find((field) => field === name || field.startsWith(`${name}.`) || name.startsWith(`${field}.`));

  /**
   * What a source reads that the form does not hold, said for the note: the component a
   * `component` source names, the leading name of a `path`, and those an `expression` reads.
   * `ids` is the form's ids when the caller holds a newer form than the designer was built over.
   */
  const missingFromSource = (source: PdfFieldMappingSource | undefined, ids: ReadonlySet<string> = formIds): string[] => {
    if (source === undefined) {
      return [];
    }
    const known = (name: string): boolean => ids.has(name) || dataNames.has(name);
    if (source.kind === "component") {
      return ids.has(source.componentId) ? [] : [source.componentId];
    }
    const paths = source.kind === "path" ? [source.path] : source.kind === "expression" ? readSourcePaths(source.expression) : [];
    const missing = new Set<string>();
    for (const path of paths) {
      const leading = journeyLeadingSegment(path);
      if (leading !== "" && !isScopedExpressionPath(path) && !known(leading)) {
        missing.add(leading);
      }
    }
    return [...missing];
  };

  /** The issues of a widget or an area as `edited` stands, each with the property it is about. */
  const issuesOf = (edited: ComponentNode, tree: ComponentNode, forProblems: boolean): Array<{ target: string; message: string }> => {
    const config = readConfig(edited);
    const issues: Array<{ target: string; message: string }> = [];
    const source = sourceFromConfig(config);
    if (!forProblems && source?.kind === "component" && !formIds.has(source.componentId)) {
      issues.push({
        target: "source.componentId",
        message: builderText("pdf.source.componentMissing", { id: source.componentId }, text)
      });
    } else if (!forProblems && (source?.kind === "path" || source?.kind === "expression")) {
      const missing = missingFromSource(source);
      if (missing.length > 0) {
        const names = formatListText(
          missing.map((name) => `"${name}"`),
          { type: "conjunction", ...text }
        );
        issues.push({
          target: source.kind === "path" ? "source.path" : "source.expression",
          message:
            source.kind === "path"
              ? builderText("pdf.source.path.unknown", { names }, text)
              : builderText("pdf.source.expression.unknown", { names }, text)
        });
      }
    }
    // A formula that does not read holds Save's way to it (as a rule's does); it prints blank on its own.
    if (forProblems && source?.kind === "expression" && typeof source.expression === "string" && source.expression.trim() !== "") {
      const parse = formulaEditorState(source.expression, { fields: [], signatures: SOURCE_SIGNATURES, scopes: [], locale: locale }).problems.find((problem) => problem.kind === "parse");
      if (parse) {
        issues.push({ target: "source.expression", message: parse.message });
      }
    }
    if (edited.type !== PDF_AREA_COMPONENT_TYPE) {
      return issues;
    }
    const page = readPage(config.page);
    if (inspection && !pageOf(page)) {
      issues.push({
        target: "page",
        message: builderPlural("pdf.page.outOfRange", inspection.pages.length, { page: String(page) }, text)
      });
    }
    const field = fieldFromConfig(config.field);
    if (field) {
      const typed = field.name !== undefined && field.name.trim() !== "";
      const problem = typed ? pdfFieldNameProblem(field.name!, (key, params) => builderText(key, params, text)) : undefined;
      if (problem) {
        issues.push({ target: "field.name", message: problem });
      } else {
        const name = areaFieldName(tree, edited);
        const clash = name !== undefined ? clashingTemplateField(name) : undefined;
        if (name !== undefined && clash !== undefined) {
          issues.push({
            target: typed ? "field.name" : "label",
            message: builderText("pdf.field.clash", { clash, name, fix: builderText(typed ? "pdf.field.clash.typeName" : "pdf.field.clash.rename", undefined, text) }, text)
          });
        }
      }
    }
    return issues;
  };

  /** The widgets of `tree` whose Values section warns now: answers no option takes, or entries that match nothing. */
  const mismatchedFieldsOf = (tree: ComponentNode): string[] => {
    const out: string[] = [];
    for (const widget of childrenOf(tree, PDF_TEMPLATE_WIDGETS_SLOT)) {
      const config = readConfig(widget);
      const spec = typeof config.pdfField === "string" ? valueMapFor(widget) : undefined;
      if (!spec || typeof config.pdfField !== "string") {
        continue;
      }
      const chosen = readPdfValueMap(config.values);
      const unmatched = spec.rows.some((row) => !spec.targets.some((target) => target.value === row.value) && !chosen?.has(row.value));
      const stale = valueMapBasis(widget)?.stale;
      if (unmatched || (stale !== undefined && (stale.keys.length > 0 || stale.targets.length > 0))) {
        out.push(config.pdfField);
      }
    }
    return out;
  };

  /** Whether a read path (`address.city`, an id) reaches the data path a form field is stored under. */
  const pathReaches = (read: string, stored: string): boolean => read === stored || stored.startsWith(`${read}.`) || stored.startsWith(`${read}[]`);

  const coverageOf = (tree: ComponentNode, formRoot: ComponentNode = options.formRoot): TemplateCoverage => {
    const ids = new Set<string>();
    const gather = (node: ComponentNode): void => {
      ids.add(node.id);
      Object.values(node.children ?? {}).forEach((group) => group.forEach(gather));
    };
    gather(formRoot);
    const mappings = fieldsFrom(tree);
    // What the layout reads, by id and by path: the mappings of the fields and of the areas drawn on the pages.
    const sources: Array<{ source: PdfFieldMappingSource | undefined; address: TextAddress }> = [
      ...mappings.map((mapping) => ({ source: mapping.source as PdfFieldMappingSource | undefined, address: pdfFillTextAddress(layout.id, "fields", mapping.pdfField) })),
      ...childrenOf(tree, PDF_TEMPLATE_AREAS_SLOT).map((node) => ({ source: sourceFromConfig(readConfig(node)), address: pdfFillTextAddress(layout.id, "areas", node.id) }))
    ];
    const readIds = new Set<string>();
    const readPaths = new Set<string>();
    for (const { source, address } of sources) {
      if (source?.kind === "component") {
        readIds.add(source.componentId);
      } else if (source?.kind === "path") {
        readPaths.add(source.path);
      } else if (source?.kind === "expression") {
        readSourcePaths(source.expression).forEach((path) => readPaths.add(path));
      } else if (source?.kind === "template") {
        // Every wording of the text: a translation may place an answer the default does not.
        const wordings = [source.text, ...Object.keys(options.translations ?? {}).flatMap((code) => readTranslation(options.translations, code, address)?.text ?? [])];
        for (const wording of wordings) {
          for (const match of wording.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
            readPaths.add(match[1]!);
          }
        }
      }
    }
    const stored = buildDataPaths(formRoot);
    const labels = new Map(bindableComponents(formRoot, locale, textSources).map((component) => [component.id, component.label] as const));
    const unplaced: TemplateCoverage["unplaced"] = [];
    for (const [id, label] of labels) {
      const node = findIn(formRoot, id);
      if (!node || !kernelFoldHoldsOwnAnswer(node) || readIds.has(id)) {
        continue;
      }
      const path = stored.get(id) ?? id;
      if (![...readPaths].some((read) => pathReaches(read, path) || read === id)) {
        unplaced.push({ id, label });
      }
    }
    return {
      mapped: mappings.filter((mapping) => missingFromSource(mapping.source, ids).length === 0).map((mapping) => mapping.pdfField),
      unplaced,
      mismatched: mismatchedFieldsOf(tree)
    };
  };

  return {
    builderOptions: {
      // The value-path box offers the saved paths the Data workspace lists; any other may be typed.
      fieldChoices: (_node, field) => (field.type === "path" ? dataPathChoices : undefined),
      // An area can be drawn once the pages are known; before that the palette is empty.
      componentTypes: inspection ? pdfTemplateComponentTypes(texts) : [],
      componentDefinitions: definitions,
      initialRoot: root,
      locale,
      // A rectangle typed in the inspector lands on its page, as a drag would (one Save, one undo).
      normalizeCommit: (edited) => {
        if (edited.type !== PDF_AREA_COMPONENT_TYPE) {
          return undefined;
        }
        const config = readConfig(edited);
        const page = pageOf(readPage(config.page));
        if (!page || !isRecord(config.rect)) {
          return undefined;
        }
        return { ...config, rect: clampAreaRect(readRect(config.rect), page) };
      }
    },
    layout,
    inspection,
    layoutFrom,
    widgetIdFor: (pdfField) => widgetIds.get(pdfField),
    fieldNameOf: (nodeId) => {
      for (const [name, id] of widgetIds) {
        if (id === nodeId) {
          return name;
        }
      }
      return undefined;
    },
    areasOf: (tree) => childrenOf(tree, PDF_TEMPLATE_AREAS_SLOT).map((node) => areaFromNode(node, pageOf)),
    mappedFieldsOf: (tree) => new Set(fieldsFrom(tree).map((mapping) => mapping.pdfField)),
    missingSourcesOf: (tree, ids = formIds) => {
      const missing = new Map<string, string>();
      for (const mapping of fieldsFrom(tree)) {
        const first = missingFromSource(mapping.source, ids)[0];
        if (first !== undefined) {
          missing.set(mapping.pdfField, first);
        }
      }
      return missing;
    },
    unresolvedFieldsOf: (tree, ids = formIds) =>
      new Set(
        fieldsFrom(tree)
          .filter((mapping) => missingFromSource(mapping.source, ids).length > 0)
          .map((mapping) => mapping.pdfField)
      ),
    staleValueMapsOf,
    staleSummary,
    coverageOf,
    notesFor: (edited, tree, componentId) => {
      const committed = findIn(tree, componentId);
      // What the committed node already has, and the draft leaves as it is: what the draft
      // changes is a problem, said once, under its box (`problemsFor`).
      const issues = issuesOf(edited, tree, false)
        // A path typed now is linted as it is typed; the rest say only what the committed node already has.
        .filter((issue) => issue.target === "source.path" || !committed || JSON.stringify(readNested(edited, issue.target) ?? null) === JSON.stringify(readNested(committed, issue.target) ?? null))
        .map((issue) => ({ target: issue.target, message: issue.message }));
      // The Values notice follows the draft as the map is edited, so it is not held to the committed node.
      return [...issues, ...valueMapNotes(edited)];
    },
    problemsFor: (edited, tree) => issuesOf(edited, tree, true),
    components
  };
}


const SOURCE_SIGNATURES = formulaFunctionSignatures();

/** The value paths an `expression` source reads; none for one that does not parse (it prints blank on its own). */
function readSourcePaths(expression: unknown): string[] {
  const tree = kernelRuleExpression(expression, kernelParseFormula, SOURCE_SIGNATURES);
  return tree === undefined ? [] : [...extractDependencies(tree)];
}

/** A field or area formula a form rename could not follow in an open template designer (it does not parse). */
export interface TemplateRenameUnparsed {
  /** The widget's or area's node id. */
  nodeId: string;
  formula: string;
}

/**
 * A form rename followed into an open template designer's tree: every widget and area whose
 * source is an `expression` has it rewritten through `renameInRuleSource`, a component or path
 * source by its id or its data's move, all of them together (one step of the tree's history,
 * or none with `unrecorded`, as the root's condition, `TreeRenameOptions`), and an unsaved
 * source in a node's draft is renamed too. A formula that spells the old id but does not parse
 * is left as written and listed.
 */
export function followRenameInTemplateTree(
  controller: BuilderController,
  from: string,
  to: string,
  dataPath?: ValuePathMoves,
  options: TreeRenameOptions = {}
): { changed: boolean; unparsed: TemplateRenameUnparsed[] } {
  const unparsed: TemplateRenameUnparsed[] = [];
  const writes: TreeRenameWrites = { committed: [], drafted: [] };
  let changed = false;
  const nodes: ComponentNode[] = [];
  const walk = (node: ComponentNode): void => {
    nodes.push(node);
    for (const list of Object.values(node.children ?? {})) {
      list.forEach(walk);
    }
  };
  walk(controller.snapshot());
  for (const node of nodes) {
    const config = isRecord(node.configuration) ? node.configuration : {};
    const committedSource = isRecord(config.source) && config.source.kind === "expression" ? config.source.expression : undefined;
    const drafted = controller.hasPendingChanges(node.id) ? controller.draftProperty(node.id, "source.expression") : committedSource;
    for (const text of new Set([committedSource, drafted])) {
      const naming = text === undefined ? undefined : unparsedFormulaNaming(text, from);
      if (naming !== undefined && !unparsed.some((entry) => entry.nodeId === node.id && entry.formula === naming)) {
        unparsed.push({ nodeId: node.id, formula: naming });
      }
    }
    // A component or path source follows too (the id or the leading name of the path).
    const sourceKind = isRecord(config.source) ? config.source.kind : undefined;
    if (sourceKind === "component" && followBindingProperty(controller, node, "source.componentId", "source.componentId", from, to, dataPath, writes)) {
      changed = true;
    } else if (sourceKind === "path" && followBindingProperty(controller, node, "source.path", "source.path", from, to, dataPath, writes)) {
      changed = true;
    }
    const nextCommitted = committedSource === undefined ? undefined : renameInRuleSource(committedSource, from, to);
    const nextDrafted = drafted === undefined ? undefined : renameInRuleSource(drafted, from, to);
    if (committedSource !== undefined && nextCommitted !== committedSource) {
      writes.committed.push({ componentId: node.id, propertyPath: "source.expression", value: nextCommitted });
      changed = true;
    }
    if (drafted !== committedSource && drafted !== undefined && nextDrafted !== drafted) {
      writes.drafted.push({ componentId: node.id, propertyPath: "source.expression", value: nextDrafted });
      changed = true;
    }
  }
  writeTreeRename(controller, writes, options);
  return { changed, unparsed };
}

// --- the words about a mapping --------------------------------------

/** Names shown in a summary before the rest are counted. */
const SUMMARY_NAMES = 4;

function namedList(names: readonly string[], words: BuilderTextOptions): string {
  const quotedNames = names.map((name) => `"${name}"`);
  return formatListText(
    quotedNames.length > SUMMARY_NAMES ? [...quotedNames.slice(0, SUMMARY_NAMES), builderText("pdf.fill.more", { count: quotedNames.length - SUMMARY_NAMES }, words)] : quotedNames,
    { ...words, type: "conjunction" }
  );
}

/**
 * The note after Suggest mappings: how many PDF fields are mapped (and how many of those this
 * time), which of the form's fields the PDF does not place, and the fields whose options do not
 * line up. Plain sentences, so it reads aloud as one; every count is from {@link TemplateCoverage},
 * the same data the Preview's report and the Values notes come from.
 */
export function mappingSummary(coverage: TemplateCoverage, suggested: number, words: BuilderTextOptions): string {
  const parts = [
    builderPlural("pdf.summary.map.mapped", coverage.mapped.length, undefined, words) +
      (suggested > 0 ? builderText("pdf.summary.map.new", { count: suggested }, words) : builderText("pdf.summary.map.none", undefined, words)),
    coverage.unplaced.length > 0
      ? builderPlural("pdf.summary.map.unplaced", coverage.unplaced.length, { names: namedList(coverage.unplaced.map((entry) => entry.label), words) }, words)
      : builderText("pdf.summary.map.unplaced.none", undefined, words),
    coverage.mismatched.length > 0
      ? builderPlural("pdf.summary.map.mismatch", coverage.mismatched.length, { names: namedList(coverage.mismatched, words) }, words)
      : builderText("pdf.summary.map.mismatch.none", undefined, words)
  ];
  return parts.join(" ");
}

/** What Create form fields says for a PDF that has no fillable fields at all (instead of "every field is filled already"). */
export function noFillableFieldsText(words: BuilderTextOptions): string {
  return builderText("pdf.summary.noFillable", undefined, words);
}
