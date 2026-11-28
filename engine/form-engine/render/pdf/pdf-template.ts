/**
 * Filling an existing PDF (template layouts and areas): the engine resolves
 * every field mapping and every area to a plain value here, so what crosses to the kernel is
 * `pdfField → value` and `area → value` and nothing else — no expressions, no component ids,
 * no locale.
 */
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import { pdfFillTextAddress } from "./pdf-text-addresses.js";
import { resolveText, type FormTranslations, type TextAddress } from "../../core/localization/translations.js";
import { isDataGrid } from "../../core/schema/data-grid.js";
import { FILE_COMPONENT_TYPE } from "../../core/schema/file-upload.js";
import {
  pdfRuleExpression,
  readPdfValueMap,
  resolvePdfAreaDraw,
  resolvePdfAreaFields,
  type PdfMappingBinding,
  type PdfTemplateFillOptions,
  type PdfTemplateLayout,
  type PdfTemplateSource,
  type PdfValueFormat,
  type ResolvedPdfAreaDraw,
  type ResolvedPdfAreaField
} from "../../core/schema/pdf-layout.js";
import type { RuleEvaluationContext } from "../../rules/evaluator/evaluator.js";
import type { RenderComponentModel } from "../core/component-model.js";
import { scalarText } from "../core/scalar-text.js";
import type { PdfSignatureSettings } from "./pdf-abi.js";
import type { PdfDocumentAttachment, PdfDocumentConformance, PdfWarning } from "./pdf-document.js";
import type { PdfThemeColors, PdfTypography } from "./pdf-theme.js";
import { PdfModelIndex, formatPdfPlainValue, formatPdfValue, isMaskedPdfAnswer, stripAnswerBidi, type PdfValueTexts } from "./pdf-values.js";
import { PDF_ANSWER_MASK } from "./standard-renditions.js";
import { evaluateTemplateExpression, pdfRegexCache, renderTemplateText } from "./template-text.js";

/** What an AcroForm field can be set to: text, a checkbox state, one option, or several. */
export type PdfFillValue = string | boolean | string[] | null;

/** An area of the template resolved to the value the kernel draws into it. */
export interface PdfFillArea {
  id: string;
  label?: string;
  /** 1-based. */
  page: number;
  /** Points from the page's left and top edges. */
  rect: { x: number; y: number; width: number; height: number };
  value: PdfFillValue;
  draw: ResolvedPdfAreaDraw;
  /** Present: the kernel creates a transparent AcroForm widget here and fills it with `value`. */
  field?: ResolvedPdfAreaField;
}

export interface PdfFillPlan {
  layoutId: string;
  template: PdfTemplateSource;
  values: Record<string, PdfFillValue>;
  /** Empty for a template with fields alone. */
  areas: PdfFillArea[];
  options: Required<PdfTemplateFillOptions>;
  /** The archival profile to keep through the fill; absent: fill as any PDF. */
  conformance?: PdfDocumentConformance;
  /** Uploaded files to embed in the filled document; absent: none. */
  attachments?: PdfDocumentAttachment[];
  /** How the host is to seal the filled document; absent: the request alone says. */
  signature?: PdfSignatureSettings;
  /** The theme the plan was built under: what a content area draws with when its own `draw` says nothing. */
  typography: PdfTypography;
  colors: PdfThemeColors;
}

export const DEFAULT_TEMPLATE_FILL_OPTIONS: Required<PdfTemplateFillOptions> = {
  flatten: false,
  readOnly: false,
  appearances: "regenerate"
};

export function resolveTemplateFillOptions(options: PdfTemplateFillOptions | undefined): Required<PdfTemplateFillOptions> {
  return {
    flatten: options?.flatten === true,
    readOnly: options?.readOnly === true,
    appearances: options?.appearances === "viewer" ? "viewer" : "regenerate"
  };
}

export interface FieldMappingContext {
  modelsById: ReadonlyMap<string, RenderComponentModel>;
  values: Record<string, unknown>;
  locale: string;
  /** The definition's own translations, with the host's catalog below. */
  translations?: FormTranslations | undefined;
  translationCatalog?: TranslationCatalog | undefined;
  texts: PdfValueTexts;
  hostContext?: Record<string, unknown> | undefined;
  /** The calendar day (`YYYY-MM-DD`) `today()` reads in an expression source. Absent: it reads as no answer. */
  today?: string | undefined;
  /** Plugin functions an expression source may call beside the built-ins. */
  functions?: RuleEvaluationContext["functions"] | undefined;
  /** `"allow"` lets a `matches` pattern of a catastrophic shape run in an expression source; default `"refuse"`. */
  riskyPatterns?: "refuse" | "allow" | undefined;
  /** The cache the expressions of one resolution share; made by {@link resolveFieldMappings}. */
  regexCache?: Record<string, unknown> | undefined;
  /** The components by id, value path and indexed entry path; made by {@link resolveFieldMappings}. */
  modelIndex?: PdfModelIndex | undefined;
}

function applyFormat(value: PdfFillValue, format: PdfValueFormat | undefined, texts: PdfValueTexts): PdfFillValue {
  if (!format || value === null) {
    return value;
  }
  if (format.kind === "boolean") {
    const [yes, no] = (format.pattern ?? `${texts.yes}|${texts.no}`).split("|");
    const truthy = value === true || value === "true" || (Array.isArray(value) && value.length > 0);
    return truthy ? (yes ?? texts.yes) : (no ?? texts.no);
  }
  if (format.kind === "number") {
    // No answer stays no answer: `Number("")` is 0, which would print an empty field as "0.00".
    const first = Array.isArray(value) ? value[0] : value;
    if (first === undefined || (typeof first === "string" && first.trim() === "")) {
      return value;
    }
    const number = typeof first === "number" ? first : Number(first);
    if (!Number.isFinite(number)) {
      return value;
    }
    const decimals = format.pattern !== undefined ? Number(format.pattern) : Number.NaN;
    return Number.isInteger(decimals) && decimals >= 0 && decimals <= 20 ? number.toFixed(decimals) : String(number);
  }
  // `text` and `date` pass through: dates stay ISO, the only spelling every host writes the same way.
  return value;
}

/**
 * Answers translated to the PDF's values by a binding's `values` map, remembering the
 * answers nothing maps. A string, number or array element is looked up by its text; a boolean by
 * `"true"` / `"false"` and, with no such key, kept as it is (a map for a Yes/No radio need not say
 * what a checkbox's other state means). A `checkboxes` answer — an object of picked keys — is
 * translated key by key. An answer no key names passes through unchanged, and only a non-empty
 * one is remembered as unmapped.
 */
class ValueTranslator {
  readonly unmapped: string[] = [];

  constructor(private readonly map: ReadonlyMap<string, string>) {}

  private text(value: string): string {
    const mapped = this.map.get(value);
    if (mapped !== undefined) {
      return mapped;
    }
    if (value !== "" && !this.unmapped.includes(value)) {
      this.unmapped.push(value);
    }
    return value;
  }

  translate(value: unknown): unknown {
    if (value === undefined || value === null) {
      return value;
    }
    if (typeof value === "boolean") {
      return this.map.get(String(value)) ?? value;
    }
    if (typeof value === "string") {
      return this.text(value);
    }
    if (typeof value === "number") {
      const key = String(value);
      const mapped = this.text(key);
      return this.map.has(key) ? mapped : value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => (typeof entry === "string" || typeof entry === "number" ? this.text(String(entry)) : entry));
    }
    if (typeof value === "object") {
      // A `checkboxes` answer: the picked keys are the answers. Only they are carried, translated
      // (an unpicked key renamed onto a picked one would otherwise clear it), and the result is
      // built from a list rather than assigned by key, so no inherited name is ever read or set.
      const picked: Array<[string, unknown]> = [];
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if ((value as Record<string, unknown>)[key] === true) {
          picked.push([this.text(key), true]);
        }
      }
      return Object.fromEntries(picked);
    }
    return value;
  }
}

function componentValue(
  model: RenderComponentModel,
  mapping: PdfMappingBinding,
  context: FieldMappingContext,
  translator?: ValueTranslator | undefined
): PdfFillValue {
  if (!model.visible) {
    return null;
  }
  // The answer, as the PDF names it when the binding carries a value map: the checked value
  // below compares the mapped answer, and the choice, array and checkbox branches all read it.
  const raw = translator ? translator.translate(model.value) : model.value;
  // A boolean the map turned into text is a choice now (a Yes/No radio group), not a tick.
  const boolean = model.type === "checkbox" && !(typeof raw === "string" && raw !== model.value);
  if (mapping.checkedValue !== undefined) {
    // The answer that means "on". On, the field takes the checked value itself — a checkbox
    // is ticked by it, a radio group selects the option of that name; off is off whatever
    // the field, a box unticked or a group cleared. A ticked checkbox answer is on; any other
    // answer is on when it is, or contains, the checked value.
    const on = boolean
      ? raw === true || raw === "true"
      : (Array.isArray(raw) ? raw.map(scalarText) : raw === undefined || raw === null ? [] : [scalarText(raw)]).includes(mapping.checkedValue);
    return on ? mapping.checkedValue : false;
  }
  // An answer's text never carries the direction controls of `stripAnswerBidi`, in a list, a
  // choice or a picked key as in a scalar.
  if (model.type === "checkbox") {
    return boolean ? raw === true || raw === "true" : stripAnswerBidi(scalarText(raw));
  }
  if (Array.isArray(raw)) {
    return raw.map((entry) => stripAnswerBidi(scalarText(entry)));
  }
  if (raw && typeof raw === "object" && model.type === "checkboxes") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, picked]) => picked === true)
      .map(([key]) => stripAnswerBidi(key));
  }
  if (model.optionState.items.length > 0 && raw !== undefined && raw !== null && raw !== "") {
    // A choice keeps its stored value: the template's option export values are what it matches.
    return stripAnswerBidi(scalarText(raw));
  }
  const formatted = formatPdfValue(model, context.texts, raw);
  return formatted.empty ? null : formatted.text;
}

function modelIndexOf(context: FieldMappingContext): PdfModelIndex {
  return context.modelIndex ?? new PdfModelIndex(context.modelsById.values());
}

function nullIfEmpty(formatted: { text: string; empty: boolean }): PdfFillValue {
  return formatted.empty ? null : formatted.text;
}

function ruleContext(context: FieldMappingContext): RuleEvaluationContext {
  return {
    values: context.values,
    regexCache: context.regexCache ?? pdfRegexCache(context.riskyPatterns),
    ...(context.hostContext ? { hostContext: context.hostContext } : {}),
    ...(context.today !== undefined ? { today: context.today } : {}),
    ...(context.functions ? { functions: context.functions } : {})
  };
}

/**
 * One binding — a field's or an area's — resolved to its value, formatted. `subject` names it
 * in the warnings (`Field "Name"`, `Area "Signed on"`). A binding that cannot be resolved yields
 * `null` and a warning, never an exception: one bad mapping must not stop the other hundred.
 */
function resolveBinding(
  binding: PdfMappingBinding,
  subject: string,
  textAddress: TextAddress,
  context: FieldMappingContext,
  warnings: PdfWarning[]
): PdfFillValue {
  let value: PdfFillValue = null;
  const source = binding.source;
  // The binding's value map: a component source translates the raw answer inside
  // `componentValue`; any other source's resolved value is translated here, before the format.
  const map = readPdfValueMap(binding.values);
  const translator = map ? new ValueTranslator(map) : undefined;
  switch (source.kind) {
    case "component": {
      const model = context.modelsById.get(source.componentId);
      if (!model) {
        warnings.push({
          code: "mapping.unresolved",
          message: `${subject} maps to component "${source.componentId}", which the form does not have.`,
          componentId: source.componentId
        });
        break;
      }
      if (model.node.collection !== undefined || model.rowKey !== undefined) {
        // A repeating section or a component inside one has no single value: rows map one
        // path source (items[0].sku) per cell, so this prints blank.
        warnings.push({
          code: "mapping.collection",
          message: `${subject} maps to ${model.node.collection !== undefined ? (isDataGrid(model.node) ? "the data grid" : "the repeating section") : "a component inside a repeating section or data grid"} "${source.componentId}", which has no single value; it prints blank. Map each row cell with a path source such as "items[0].${model.rowKey ?? "field"}".`,
          componentId: source.componentId
        });
        break;
      }
      value = componentValue(model, binding, context, translator);
      break;
    }
    case "path": {
      const raw = context.values[source.path];
      // A path naming a file field (`applicant.doc`, `items[0].receipt`) writes the files' names
      // and sizes, as a component source does, never the envelope and its bytes.
      const model = modelIndexOf(context).at(source.path);
      value =
        raw === undefined || raw === null
          ? null
          : model?.type === FILE_COMPONENT_TYPE
            ? nullIfEmpty(formatPdfValue(model, context.texts, raw))
            : Array.isArray(raw)
              ? raw.map((entry) => stripAnswerBidi(scalarText(entry)))
              : formatPdfPlainValue(raw);
      break;
    }
    case "template": {
      const text = resolveText(source.text, textAddress, context.locale, { translations: context.translations, catalog: context.translationCatalog });
      const rendered = renderTemplateText(text, {
        ...ruleContext(context),
        // A placeholder names a component by id, by value path or by an entry's indexed path
        // (`items[0].pick`): its answer reads as that component's, an option's label, a file's name.
        formatPath: (path, raw) => {
          const model = modelIndexOf(context).at(path);
          if (!model) {
            return undefined;
          }
          // A password's answer is never written back in clear: the mask the renditions print.
          const formatted = formatPdfValue(model, context.texts, raw);
          return !formatted.empty && isMaskedPdfAnswer(model) ? PDF_ANSWER_MASK : formatted.text;
        }
      });
      value = rendered.segments.map((segment) => (segment.kind === "text" ? segment.text : "")).join("");
      break;
    }
    case "expression": {
      // The render model compiles the layout first, so a formula string has become a tree by
      // here; a direct caller's string is parsed on the spot, and one the parser rejects
      // prints blank with a word, as it does under the render model's `warn` policy.
      const expression = pdfRuleExpression(source.expression, context.functions ? Object.keys(context.functions) : undefined);
      if (expression === undefined) {
        warnings.push({ code: "formula.invalid", message: `${subject} has an expression source that could not be read; it prints blank.` });
        break;
      }
      value = evaluateTemplateExpression(expression, ruleContext(context));
      break;
    }
    case "literal": {
      value = source.value === null ? null : typeof source.value === "boolean" ? source.value : scalarText(source.value);
      break;
    }
    default:
      warnings.push({
        code: "mapping.unknownSource",
        message: `${subject} has a source of an unknown kind.`
      });
  }
  if (translator) {
    if (source.kind !== "component") {
      value = translator.translate(value) as PdfFillValue;
    }
    if (translator.unmapped.length > 0) {
      const names = translator.unmapped.map((entry) => `"${entry}"`).join(", ");
      warnings.push({
        code: "mapping.unmappedValue",
        message: `${subject} translates answers to PDF values, but nothing is mapped for ${names}; ${translator.unmapped.length === 1 ? "it is" : "they are"} written as the answer is.`,
        ...(source.kind === "component" ? { componentId: source.componentId } : {})
      });
    }
  }
  return applyFormat(value, binding.format, context.texts);
}

/**
 * Every mapping of a template layout resolved to the value the kernel writes into the field,
 * and every area to the value the kernel draws into it.
 */
export function resolveFieldMappings(
  layout: PdfTemplateLayout,
  given: FieldMappingContext
): { values: Record<string, PdfFillValue>; areas: PdfFillArea[]; warnings: PdfWarning[] } {
  const values: Record<string, PdfFillValue> = {};
  const areas: PdfFillArea[] = [];
  const warnings: PdfWarning[] = [];
  const context: FieldMappingContext = {
    ...given,
    regexCache: given.regexCache ?? pdfRegexCache(given.riskyPatterns),
    modelIndex: given.modelIndex ?? new PdfModelIndex(given.modelsById.values())
  };
  for (const mapping of layout.fields) {
    // A fill text is worded under the layout by the mapping's PDF field: `pdf › layout › fields › field › text`.
    values[mapping.pdfField] = resolveBinding(mapping, `Field "${mapping.pdfField}"`, pdfFillTextAddress(layout.id, "fields", mapping.pdfField), context, warnings);
  }
  const areaList = layout.areas ?? [];
  // Resolved together: a name taken from a label is made unique among the areas.
  const areaFields = resolvePdfAreaFields(areaList);
  areaList.forEach((area, index) => {
    const value = resolveBinding(area, `Area "${area.label ?? area.id}"`, pdfFillTextAddress(layout.id, "areas", area.id), context, warnings);
    const field = areaFields[index];
    areas.push({
      id: area.id,
      ...(area.label !== undefined ? { label: area.label } : {}),
      page: area.page,
      rect: { ...area.rect },
      value,
      draw: resolvePdfAreaDraw(area.draw),
      ...(field ? { field } : {})
    });
  });
  return { values, areas, warnings };
}
