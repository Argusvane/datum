/**
 * The PDF mode adapter: a pure model builder from the semantic tree, a
 * state snapshot and a layout to a {@link PdfDocument} — or, for a template layout, to the
 * values that fill it. Like the other adapters it resolves options through the bridge
 * and builds `RenderComponentModel`s with `readOnlyByMode: true`; unlike them it
 * then walks a *second* tree, the layout, binding form components into it.
 *
 * Everything that needs the form — labels, option captions, visibility, expressions, repeats,
 * rendition choice — is decided here. The kernel receives literal text and structure.
 */
import type { TextDirection } from "../../core/accessibility/accessibility-semantics.js";
import { isRtlLocale, resolveLocalizedText } from "../../core/localization/localized-text.js";
import { addressOf, resolveText, type TextSources } from "../../core/localization/translations.js";
import { pdfLayoutTextAddress, pdfNodeTextAddress } from "./pdf-text-addresses.js";
import type { LocalizedText, ThemeFontFace } from "../../core/schema/contracts.js";
import type { Expression, FormulaErrorPolicy } from "../../core/expressions/expression.js";
import { kernelCompileDefinition, kernelFormulaPolicy } from "../../core/expressions/compile.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import type { FormulaProblem } from "../../core/expressions/formula-types.js";
import { FILE_COMPONENT_TYPE, readFileAttachments } from "../../core/schema/file-upload.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { FormState } from "../../core/state/form-state.js";
import { kernelJsonAnswers } from "../../core/state/submittable-fold.js";
import {
  DEFAULT_PDF_ATTACHMENT_NAME,
  DEFAULT_PDF_ATTACHMENT_POLICY,
  PDF_BOX_COMPONENT_TYPE,
  PDF_DOCUMENT_BODY_SLOT,
  PDF_DOCUMENT_COMPONENT_TYPE,
  PDF_DOCUMENT_FOOTER_SLOT,
  PDF_DOCUMENT_HEADER_SLOT,
  PDF_FIELD_COMPONENT_TYPE,
  PDF_IMAGE_COMPONENT_TYPE,
  PDF_PAGE_BREAK_COMPONENT_TYPE,
  PDF_REPEAT_COMPONENT_TYPE,
  PDF_RULE_COMPONENT_TYPE,
  PDF_SECTION_COMPONENT_TYPE,
  PDF_SIGNATURE_COMPONENT_TYPE,
  PDF_SPACER_COMPONENT_TYPE,
  PDF_TABLE_COMPONENT_TYPE,
  PDF_TEXT_COMPONENT_TYPE,
  isPdfTemplateLayout,
  pdfFormulaSignatures,
  pdfTableRowSlotIds,
  readComponentPdfOptions,
  readPdfBoxAnchor,
  readPdfTableSpec,
  builtinProfileOf,
  pdfAPart,
  resolvePdfAccessibility,
  resolvePdfAttachmentPolicy,
  resolvePdfConformance,
  resolvePdfPageSetup,
  type PdfAttachmentPolicy,
  type PdfAttachmentPolicyOptions,
  type PdfConfiguration,
  type PdfGeneratedLayout,
  type PdfLayoutChoice,
  type PdfLayoutDocument,
  type PdfLayoutSelection,
  type PdfOutputIntentConfiguration,
  type PdfTemplateLayout,
  type ResolvedPdfConformance,
  type ResolvedPdfPageSetup
} from "../../core/schema/pdf-layout.js";
import { resolvePdfSignatureConfiguration } from "../../core/schema/pdf-signature-configuration.js";
import { kernelStableStringify } from "../../validation/wasm/portable-kernel.js";
import type { RuleEvaluationContext } from "../../rules/evaluator/evaluator.js";
import {
  buildComponentModels,
  flattenComponentTree,
  type RenderComponentModel,
  type RenderModelContext
} from "../core/component-model.js";
import { resolveOptionStatesForTree, type DataSourceResolver } from "../core/component-options.js";
import { readLegendMark } from "../../core/schema/legend-mark.js";
import { configuredSlotIds } from "../core/tab-slots.js";
import { deriveDefaultPdfLayout } from "./default-layout.js";
import { selectPdfLayoutForValues, type PdfFormulaFunctions } from "./pdf-layout-selection.js";
import { DEFAULT_PDF_UNKNOWN_COMPONENT_POLICY, PdfKernelError, type PdfSignatureSettings, type PdfUnknownComponentPolicy } from "./pdf-abi.js";
import type {
  PdfAnchoredBox,
  PdfAttachment,
  PdfBlock,
  PdfBoxBlock,
  PdfDocument,
  PdfDocumentAttachment,
  PdfDocumentConformance,
  PdfImageResource,
  PdfOutputIntent,
  PdfTableCell,
  PdfTableRow,
  PdfTextRun,
  PdfWarning
} from "./pdf-document.js";
import { DEFAULT_PDF_RENDER_LIMITS, PDF_DOCUMENT_MODEL_VERSION, PDF_RENDER_LIMIT_CEILING, pdfRenderLimitsOverCeiling, resolvePdfRenderLimits, runsText, walkPdfBlocks, pdfBlocksPrint } from "./pdf-document.js";
import { PdfAttachmentCollector, collectFormAttachments } from "./pdf-attachments.js";
import { bytesToBase64 } from "./pdf-provider.js";
import {
  asPdfRenderer,
  createPdfRenditionResolver,
  resolveRenditionId,
  type PdfBindingOptions,
  type PdfRenditionContext,
  type PdfRenditionResolver,
  type PdfRenditionTexts
} from "./pdf-renditions.js";
import {
  pdfStyleWarning,
  pdfThemeChoiceFor,
  readPdfComponentStyle,
  resolvePdfTheme,
  selectPdfTheme,
  themeFontFaces,
  type PdfBindingSuggestion,
  type PdfComponentStyle,
  type PdfThemeDefinition,
  type PdfThemeLookup,
  type ResolvedPdfTheme
} from "./pdf-theme.js";
import { dataGridDefaultRendition } from "../../core/schema/pdf-renditions.js";
import { normalizeDataGrids } from "../../core/schema/data-grid.js";
import { withBaseTypes } from "../../registry/kinds.js";
import { STEP_COMPONENT_TYPE, STEPS_COMPONENT_TYPE } from "../../core/schema/steps.js";
import { collectionPathOf } from "../../core/tree/data-scope.js";
import { PdfModelIndex, formatPdfValue, isMaskedPdfAnswer, readCollectionRows, stripAnswerBidi, type PdfFormattedValue } from "./pdf-values.js";
import { resolveFieldMappings, resolveTemplateFillOptions, type PdfFillPlan } from "./pdf-template.js";
import {
  COLLECTION_PDF_RENDITIONS,
  GENERIC_CONTAINER_PDF_RENDITIONS,
  GENERIC_LEAF_PDF_RENDITIONS,
  PDF_ANSWER_MASK
} from "./standard-renditions.js";
import { evaluateTemplateExpression, pdfRegexCache, renderTemplateText, templateSegmentsToRuns } from "./template-text.js";

export interface PdfRenderModelOptions {
  /** The layout to render. Wins over `pdf` + `layoutId`, and no condition is tried. */
  layout?: PdfLayoutDocument | undefined;
  /** The definition's `pdf` block, for finding a layout by id, by its condition, or as the default. */
  pdf?: PdfConfiguration | undefined;
  /** An explicit choice from `pdf`: it wins over every layout's `when`. */
  layoutId?: string | undefined;
  /**
   * The answers a layout's `when` reads when neither `layout` nor `layoutId` is given: the submittable view keyed by value path — a browser runtime's
   * `submittableValues()`. Absent: the state's values, which on a server are already the
   * judged answers a submission carried. Only the choice of layout reads these; what prints
   * is always the state's.
   */
  selectionValues?: Record<string, unknown> | undefined;
  /**
   * The host's default PDF theme, for a document that names none. A theme of another target is
   * refused with a `theme.notPdf` warning (see `selectPdfTheme`).
   */
  theme?: PdfThemeDefinition | undefined;
  /**
   * The binding the form is drawn by and the PDF theme it suggests. Read only when nothing else
   * names a PDF theme: the document then prints under the suggestion rather than the engine's
   * own look. Nothing is derived from the binding's look.
   */
  binding?: PdfBindingSuggestion | undefined;
  /** Render under this registered theme, whatever the layout says (see `selectPdfTheme`). */
  themeId?: string | undefined;
  /** Finds a theme by id, for `themeId` and the layout's `theme`; absent, every id is unknown. */
  resolveTheme?: PdfThemeLookup | undefined;
  renditions?: PdfRenditionResolver | undefined;
  /**
   * The form's title for metadata and the derived layout, as the host words it (host data, so a
   * `LocalizedText`). Absent: the root's `configuration.title`, translated at `form › title`.
   */
  title?: LocalizedText | undefined;
  /** Host values reachable as `host.<key>` in templates and expressions. */
  hostContext?: Record<string, unknown> | undefined;
  /** A bound component whose type offers no rendition: draw and say nothing, warn, or refuse. Default `warn`. */
  unknownComponents?: PdfUnknownComponentPolicy | undefined;
  /** The budget for the uploaded files the document embeds, over the layout's own. */
  attachments?: PdfAttachmentPolicyOptions | undefined;
  /**
   * The calendar day (`YYYY-MM-DD`) `today()` reads in a layout's `when`, a rule and an
   * expression source. Absent: a clock-reading rule evaluates to no answer and never holds.
   */
  today?: string | undefined;
  /**
   * What to do with a rule the parser rejects: `fail` (the default) throws
   * `PdfKernelError` with the `formula_invalid` code; `warn`, the explicit opt-in, drops it
   * and reports `formula.invalid`. Over the form's own `configuration.formulaErrors`.
   */
  formulaErrors?: FormulaErrorPolicy | undefined;
  /**
   * `"allow"` lets a literal `matches` pattern of a catastrophic shape compile (a repeat of a
   * repeat, a repeated back-reference); default `"refuse"`: the rule is a `pattern.risky` problem,
   * judged by `formulaErrors` like one that does not parse.
   */
  riskyPatterns?: "refuse" | "allow" | undefined;
  /** The plugin functions a formula may call beside the built-ins: a plugin platform's registry, or the PDF program's. */
  functions?: PdfFormulaFunctions | undefined;
  /**
   * The definition's `kinds` map (`FormDefinition.kinds`): a component of a type it names is
   * printed as its base engine type (a `gcds-date` as a date), with no plugin or binding code.
   */
  kinds?: Readonly<Record<string, string>> | undefined;
}

/** The compiled copies of what a PDF reads, with the warnings the policy asks for. */
export interface CompiledPdfDefinition {
  root: ComponentNode;
  pdf: PdfConfiguration | undefined;
  layout: PdfLayoutDocument | undefined;
  warnings: PdfWarning[];
}

/** The component a problem sits on, from a `where` of the form `rules:<id>:<key>`. */
function problemComponentId(problem: FormulaProblem): string | undefined {
  const match = /^rules:(.+):[^:]+$/.exec(problem.where);
  return match ? match[1] : undefined;
}

function problemMessage(problem: FormulaProblem): string {
  return `${problem.where}: ${problem.message}${problem.text !== undefined ? ` (in "${problem.text}")` : ""}`;
}

/**
 * The one compile point for a PDF (formulas): the form tree, the `pdf` block and a
 * layout handed over are compiled into copies whose formula strings are trees, through the
 * same parser the sandbox runs, with the plugin functions' names beside the built-ins. The
 * author's objects are never changed. The policy then applies: `fail` (the default, over
 * the form's `configuration.formulaErrors`) throws `PdfKernelError` with the `formula_invalid`
 * code; `warn`, the explicit opt-in, reports `formula.invalid` once per problem. A rule the parser
 * rejected is absent from the copies under every policy.
 */
export function compilePdfDefinition(
  root: ComponentNode,
  pdf: PdfConfiguration | undefined,
  layout: PdfLayoutDocument | undefined,
  options: {
    formulaErrors?: FormulaErrorPolicy | undefined;
    functions?: PdfFormulaFunctions | undefined;
    /** `"allow"` lets a literal `matches` pattern of a catastrophic shape compile; default `"refuse"`. */
    riskyPatterns?: "refuse" | "allow" | undefined;
    /** The definition's `kinds` map: a component of a type it names is read as its base engine type. */
    kinds?: Readonly<Record<string, string>> | undefined;
  } = {}
): CompiledPdfDefinition {
  const signatures = pdfFormulaSignatures(options.functions ? Object.keys(options.functions) : undefined);
  // A data grid written as columns is rewritten into children and a collection binding before
  // anything reads the tree: this is the one compile point both a browser host and
  // the server's program come through, so the PDF sees the shape the kernel and the form do.
  root = normalizeDataGrids(root);
  // A plugin's or a binding's type the definition's `kinds` map names is read as its base from
  // here on: every rendition, value format and unknown-component check below switches on types,
  // and prints a `gcds-date` as the date it is. A tree the map renames nothing in is kept as is.
  root = withBaseTypes(root, options.kinds);
  const compiled = kernelCompileDefinition(root, undefined, pdf, kernelParseFormula, signatures, options.riskyPatterns);
  const problems = [...compiled.problems];
  let compiledLayout = layout;
  if (layout) {
    const one = kernelCompileDefinition(root, undefined, { layouts: [layout] }, kernelParseFormula, signatures, options.riskyPatterns);
    compiledLayout = (one.definition.pdf as { layouts: PdfLayoutDocument[] }).layouts[0];
    problems.push(...one.problems.filter((problem) => !problem.where.startsWith("rules:")));
  }
  const policy = kernelFormulaPolicy(root.configuration, options.formulaErrors);
  if (problems.length > 0 && policy === "fail") {
    const first = problems[0]!;
    throw new PdfKernelError(
      "formula_invalid",
      `${problems.length === 1 ? "A formula" : `${problems.length} formulas`} could not be read${problems.length === 1 ? "" : "; the first"}: ${problemMessage(first)}`
    );
  }
  const warnings: PdfWarning[] =
    policy === "warn"
      ? problems.map((problem) => {
          const componentId = problemComponentId(problem);
          return { code: "formula.invalid", message: problemMessage(problem), ...(componentId !== undefined ? { componentId } : {}) };
        })
      : [];
  return {
    root: compiled.definition.root,
    pdf: compiled.definition.pdf as PdfConfiguration | undefined,
    layout: compiledLayout,
    warnings
  };
}

export interface PdfRenderModel {
  mode: "pdf";
  layoutId: string;
  /** The id of the PDF theme the document was rendered under (`datum-pdf` for the engine default). */
  themeId: string;
  /** `derived` when the form declared no layout and one was built from its tree. */
  layoutKind: "generated" | "template" | "derived";
  /** How the layout was chosen: handed over, asked for by id, by its condition, as the default, as the first, or derived. */
  layoutChoice: PdfLayoutChoice;
  /** For a generated or derived layout. */
  document?: PdfDocument;
  /** For a template layout. */
  fill?: PdfFillPlan;
  components: RenderComponentModel[];
  warnings: PdfWarning[];
  /** The faces the theme ships for the families it names (`assets.fonts`), for the host's font provider. */
  fontFaces: ThemeFontFace[];
}

/** The scope a repeating region gives the nodes inside it. */
interface RowScope {
  collectionPath: string;
  rowIndex: number;
  rowCount: number;
  rowValues: Record<string, unknown>;
  ancestorValues: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readConfig(node: ComponentNode): Record<string, unknown> {
  return isRecord(node.configuration) ? node.configuration : {};
}

/** A text a layout authors: a string in the form's default language. */
function readText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * A layout's text in `locale`, from the `pdf › <layoutId> › <path>` entry of the form's map or
 * the host's catalog, else the authored string. The path is built from the layout's own ids and
 * property names (see pdf-text-addresses.ts); never an index.
 */
function layoutText(authored: string | undefined, layoutId: string, propertyPath: string, locale: string, sources: TextSources): string | undefined {
  return authored === undefined ? undefined : resolveText(authored, pdfLayoutTextAddress(layoutId, propertyPath), locale, sources);
}

function readNumber(value: unknown, fallback: number, min = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

/** A hex colour (`#rgb` to `#rrggbbaa`), else `undefined`: the one colour the PDF reads, and the canvas draws. */
export function readColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined;
}

const hasPrintableContent = pdfBlocksPrint;

/** A 32-bit FNV-1a hash of a whole string: a key that finds candidates, never proof of equality. */
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

class LayoutRenderer {
  private readonly modelsById = new Map<string, RenderComponentModel>();
  /** The components by id, by value path and, for an entry's field, by its indexed path. */
  private readonly modelIndex: PdfModelIndex;
  private readonly nodesById = new Map<string, ComponentNode>();
  private readonly images: Record<string, PdfImageResource> = {};
  /** Image resource ids by URL, or by the type, length and hash of their bytes. */
  private readonly imageIds = new Map<string, string[]>();
  public readonly anchored: PdfAnchoredBox[] = [];
  public readonly warnings: PdfWarning[] = [];
  private counter = 0;
  private readonly texts: PdfRenditionTexts;
  /** Component ids already reported under the unknown-component policy; each is told once. */
  private readonly reportedUnknown = new Set<string>();
  /** Whether `text.bidiStripped` has been reported: once per document. */
  private bidiReported = false;
  /** The uploaded files the document embeds, deduped and budgeted. */
  private readonly attachmentCollector: PdfAttachmentCollector;
  /** The signature fields the layout's own `pdf-signature` blocks name. */
  public readonly signatureFields: string[] = [];
  /** The cache every expression of the document evaluates under: `matches` refuses a risky pattern. */
  private readonly regexCache: Record<string, unknown>;
  /** The headings that caption a section (a container's, a tab's, a layout section's): the ones the theme numbers and bands. */
  private readonly sectionHeadingIds = new Set<string>();

  constructor(
    private readonly root: ComponentNode,
    private readonly state: FormState,
    models: RenderComponentModel[],
    private readonly theme: ResolvedPdfTheme,
    private readonly renditions: PdfRenditionResolver,
    private readonly layoutDefaults: Record<string, string> | undefined,
    private readonly locale: string,
    private readonly translationCatalog: RenderModelContext["translationCatalog"],
    /** The definition's own translations, with the layout they are read for. */
    private readonly translations: RenderModelContext["translations"],
    private readonly layoutId: string,
    private readonly textDirection: TextDirection,
    private readonly hostContext: Record<string, unknown> | undefined,
    private readonly unknownComponents: PdfUnknownComponentPolicy = DEFAULT_PDF_UNKNOWN_COMPONENT_POLICY,
    private readonly attachmentPolicy: PdfAttachmentPolicy = DEFAULT_PDF_ATTACHMENT_POLICY,
    private readonly today: string | undefined = undefined,
    private readonly functions: PdfFormulaFunctions | undefined = undefined,
    riskyPatterns: "refuse" | "allow" | undefined = undefined
  ) {
    this.regexCache = pdfRegexCache(riskyPatterns);
    this.attachmentCollector = new PdfAttachmentCollector(attachmentPolicy, (warning) => this.warnings.push(warning));
    for (const model of models) {
      this.modelsById.set(model.id, model);
      this.nodesById.set(model.id, model.node);
    }
    // By value path too, for a binding or a placeholder that names one (see `PdfModelIndex`).
    this.modelIndex = new PdfModelIndex(models);
    this.texts = {
      yes: resolveLocalizedText(theme.texts.yes, locale) ?? "Yes",
      no: resolveLocalizedText(theme.texts.no, locale) ?? "No",
      empty: resolveLocalizedText(theme.texts.empty, locale) ?? "",
      required: resolveLocalizedText(theme.texts.required, locale) ?? "",
      stepOf: resolveLocalizedText(theme.texts.stepOf, locale) ?? "",
      signatureAlt: resolveLocalizedText(theme.texts.signatureAlt, locale) ?? "Signature"
    };
  }

  /** A text of a layout node in the document's language: its authored string, or the translation at `pdf › layout › nodes › node › property`. */
  private nodeText(node: ComponentNode, property: string): string | undefined {
    const value = readText(readConfig(node)[property]);
    return value === undefined
      ? undefined
      : resolveText(value, pdfNodeTextAddress(this.layoutId, node.id, property), this.locale, { translations: this.translations, catalog: this.translationCatalog });
  }

  /**
   * Numbers and bands the section headings once the body is rendered, in reading
   * order — a child's heading is emitted before its parent's, so counting at emission would
   * number "1.1" before "1" exists. Counters run per level from the body's top level (2).
   */
  public decorateSections(blocks: readonly PdfBlock[]): void {
    const { numbered, band } = this.theme.headings;
    if (!numbered && band === "none") {
      return;
    }
    const counters: number[] = [];
    const inHeader = new Set<string>();
    walkPdfBlocks(blocks, (block) => {
      if (block.kind === "box" && block.header) {
        for (const inner of block.header.blocks) {
          inHeader.add(inner.id);
        }
      }
      if (block.kind !== "heading" || !this.sectionHeadingIds.has(block.id)) {
        return;
      }
      if (numbered) {
        const index = Math.max(0, block.level - 2);
        counters.length = index + 1;
        for (let level = 0; level < index; level += 1) {
          counters[level] ??= 1;
        }
        counters[index] = (counters[index] ?? 0) + 1;
        block.number = counters.join(".");
      }
      // A panel's caption already sits on the panel's own band.
      if (band !== "none" && !inHeader.has(block.id)) {
        block.band = true;
      }
    });
  }

  /** Remembers a rendition's own headings — the top-level ones and a panel header's — and tags the first with the step's line. */
  private markSectionHeadings(blocks: readonly PdfBlock[], tag: string | undefined): void {
    let first = true;
    for (const block of blocks) {
      const headings = block.kind === "heading" ? [block] : block.kind === "box" && block.header ? block.header.blocks.filter((inner) => inner.kind === "heading") : [];
      for (const heading of headings) {
        this.sectionHeadingIds.add(heading.id);
        if (first && tag !== undefined && heading.kind === "heading") {
          heading.tag = tag;
        }
        first = false;
      }
    }
  }

  /**
   * The AcroForm fields the document's widgets make, checked for names two owners share: a
   * field rendition's widget (named by its value path or the binding's `widgetName`) and a
   * `pdf-signature` block's `fieldName` live in one namespace, so a name a second owner takes
   * would make its widget part of the first's field, or fail. The first keeps the name and
   * `layout.duplicateWidgetName` names the second. One component's own widgets sharing a name
   * (the same component bound twice) are one field on purpose; two signature blocks are told
   * apart where they are drawn. Returns the names of the signature fields, for the layout's
   * signature settings to find the one they sign into.
   */
  public checkWidgetNames(blocks: readonly PdfBlock[]): string[] {
    // A name's first owner: the component whose widget took it, `undefined` for a signature block.
    const owners = new Map<string, string | undefined>();
    const signatures: string[] = [];
    const owner = (componentId: string | undefined): string => (componentId !== undefined ? `component "${componentId}"` : "a signature block");
    walkPdfBlocks(blocks, (block) => {
      if (block.kind !== "widget") {
        return;
      }
      const name = block.field.name;
      if (block.field.kind === "signature" && !signatures.includes(name)) {
        signatures.push(name);
      }
      if (!owners.has(name)) {
        owners.set(name, block.componentId);
        return;
      }
      const first = owners.get(name);
      if (first === block.componentId) {
        return;
      }
      this.warn(
        "layout.duplicateWidgetName",
        `The PDF field name "${name}" is taken by ${owner(first)} and again by ${owner(block.componentId)}; only the first is that field.`,
        block.componentId
      );
    });
    return signatures;
  }

  public resources(): PdfDocument["resources"] {
    return { images: { ...this.images } };
  }

  /** The uploaded files queued for embedding, in the order the layout met them. */
  public attachments(): PdfDocumentAttachment[] {
    return this.attachmentCollector.list();
  }

  private nextId(suffix = "block"): string {
    this.counter += 1;
    return `${suffix}-${this.counter}`;
  }

  private warn(code: string, message: string, componentId?: string): void {
    this.warnings.push({ code, message, ...(componentId ? { componentId } : {}) });
  }

  /**
   * The image resource for a picture, one per distinct picture: a URL by its text, bytes by their
   * whole content (a hash finds the candidates, the full data decides), so two pictures that share
   * a header and a size are never printed as one.
   */
  private addImage(resource: PdfImageResource): string {
    const key = "url" in resource ? `url:${resource.url}` : `data:${resource.type}:${resource.data.length}:${contentHash(resource.data)}`;
    const candidates = this.imageIds.get(key) ?? [];
    const existing = candidates.find((id) => {
      const held = this.images[id];
      return held !== undefined && ("url" in resource || ("data" in held && held.data === resource.data));
    });
    if (existing) {
      return existing;
    }
    const id = this.nextId("img");
    this.images[id] = resource;
    this.imageIds.set(key, [...candidates, id]);
    return id;
  }

  private ruleContext(scope: RowScope | undefined): RuleEvaluationContext {
    return {
      values: this.state.values,
      regexCache: this.regexCache,
      ...(this.today !== undefined ? { today: this.today } : {}),
      ...(this.functions ? { functions: this.functions } : {}),
      ...(scope
        ? {
            rowValues: scope.rowValues,
            ancestorValues: scope.ancestorValues,
            hostContext: {
              ...(this.hostContext ?? {}),
              rowIndex: scope.rowIndex,
              rowNumber: scope.rowIndex + 1,
              rowCount: scope.rowCount
            }
          }
        : this.hostContext
          ? { hostContext: this.hostContext }
          : {})
    };
  }

  /** The document's page setup, which a page break's own setup changes field by field. */
  public documentPage: ResolvedPdfPageSetup | undefined = undefined;

  /** The most characters of one answer drawn (the layout's `limits.answerChars`); `render.truncated` warns once per component. */
  public answerChars = DEFAULT_PDF_RENDER_LIMITS.answerChars;
  private readonly truncatedReported = new Set<string>();

  private format(model: RenderComponentModel, value: unknown): PdfFormattedValue {
    let formatted = formatPdfValue(model, this.texts, value, this.locale);
    if (formatted.text.length > this.answerChars) {
      // Cut first, then strip again: a cut can leave an isolate open that the whole text closed.
      const head = formatted.text.slice(0, this.answerChars).replace(/[\uD800-\uDBFF]$/, "");
      const balanced = stripAnswerBidi(head);
      formatted = { ...formatted, text: balanced + " [\u2026]", ...(balanced !== head ? { bidiStripped: true } : {}) };
      if (!this.truncatedReported.has(model.id)) {
        this.truncatedReported.add(model.id);
        this.warn("render.truncated", `The answer of "${model.id}" runs past ${this.answerChars} characters; the rest was left out of the PDF.`, model.id);
      }
    }
    if (formatted.bidiStripped && !this.bidiReported) {
      this.bidiReported = true;
      this.warn("text.bidiStripped", "Bidirectional embedding, override and isolate control characters typed into an answer were removed; they can reorder the text around them.", model.id);
    }
    return formatted;
  }

  private formatPath(path: string, raw: unknown, scope: RowScope | undefined): string | undefined {
    if (path.startsWith("row.") && scope) {
      // `{{row.<key>}}` names a field by its key within the entry, which is its id
      // unless it carries a data key.
      const key = path.slice(4);
      const model = this.modelIndex.rowField(scope.collectionPath, key) ?? this.modelsById.get(key);
      return model ? this.placeholderText(model, raw) : undefined;
    }
    // A path names a component by id or value path, or an entry's field by its indexed path
    // (`items[0].note`): the answer is formatted and cut to `limits.answerChars` as that field's.
    const id = path.startsWith("row.") ? path.slice(4) : path.startsWith("ancestor.") ? path.split(".").pop() ?? path : path;
    const model = this.modelIndex.at(id);
    return model ? this.placeholderText(model, raw) : undefined;
  }

  /** A component's answer as a placeholder prints it: formatted, and masked for a type whose answer is never printed back (a password), as its rendition masks it. */
  private placeholderText(model: RenderComponentModel, raw: unknown): string {
    const formatted = this.format(model, raw);
    return !formatted.empty && isMaskedPdfAnswer(model) ? PDF_ANSWER_MASK : formatted.text;
  }

  /** Text with placeholders resolved, as runs. */
  private templateRuns(text: string, scope: RowScope | undefined): PdfTextRun[] {
    const rendered = renderTemplateText(text, {
      ...this.ruleContext(scope),
      formatPath: (path, raw) => this.formatPath(path, raw, scope)
    });
    return templateSegmentsToRuns(rendered.segments);
  }

  // --- Form components through their renditions -------------------------------------------

  private styleFor(type: string, binding: PdfBindingOptions): PdfComponentStyle {
    const choice = pdfThemeChoiceFor(this.theme, type);
    return { ...(choice.style ?? {}), ...(binding.style ?? {}) };
  }

  /** The generic set a node falls to when its type offers nothing: by what the node is, not its type. */
  private genericRenditionsFor(node: ComponentNode) {
    return node.collection
      ? COLLECTION_PDF_RENDITIONS
      : node.children && Object.keys(node.children).length > 0
        ? GENERIC_CONTAINER_PDF_RENDITIONS
        : GENERIC_LEAF_PDF_RENDITIONS;
  }

  /**
   * The unknown-component policy: a bound component whose type offers no rendition
   * at all — not built in, not contributed, not defined here — is drawn generically, and this
   * says so (`component.unknown`) or refuses (`unknown_component`), once per component. Called
   * before visibility is consulted, so the verdict follows the schema and the layout, not the
   * answers.
   */
  private checkKnown(model: RenderComponentModel, binding: PdfBindingOptions = {}): void {
    const node = model.node;
    if (this.unknownComponents === "ignore" || this.reportedUnknown.has(model.id) || this.renditions.catalog(node.type).length > 0) {
      return;
    }
    this.reportedUnknown.add(model.id);
    const generic = node.collection ? this.genericRenditionsFor(node).defaultRendition : this.genericRendition(node, binding).id;
    if (this.unknownComponents === "fail") {
      throw new PdfKernelError(
        "unknown_component",
        `Component "${model.id}" has type "${node.type}", which offers no PDF rendition here; register one for the type or set unknownComponents to "warn" or "ignore".`
      );
    }
    this.warn(
      "component.unknown",
      `Component "${model.id}" has type "${node.type}", which offers no PDF rendition here; the generic "${generic}" rendition was used.`,
      model.id
    );
  }

  private chooseRendition(model: RenderComponentModel, binding: PdfBindingOptions) {
    const node = model.node;
    const type = node.type;
    const themeChoice = this.theme.components[type]?.rendition;
    const themeWildcard = this.theme.components["*"]?.rendition;
    if (node.collection) {
      // A repeating component is its rows, whatever its type draws on screen: the binding may
      // name a rendition the type itself offers, otherwise the collection set applies.
      const own = binding.rendition !== undefined ? this.renditions.resolve(type, binding.rendition) : undefined;
      if (own) {
        return own;
      }
      // The rungs in order; a named one (not a wildcard) that asks for a rendition no collection
      // draws falls through with `rendition.unknown`, as a named rung does for any other component.
      const rungs: Array<[string, string | undefined, boolean]> = [
        ["binding", binding.rendition, true],
        ["instance", readComponentPdfOptions(node.configuration).rendition, true],
        ["layout", this.layoutDefaults?.[type], true],
        ["layout", this.layoutDefaults?.["*"], false],
        ["theme", themeChoice, true],
        ["theme", themeWildcard, false]
      ];
      let wanted: string | undefined;
      for (const [rung, candidate, named] of rungs) {
        if (candidate === undefined || candidate === "") {
          continue;
        }
        if (COLLECTION_PDF_RENDITIONS.renditions.some((r) => r.id === candidate)) {
          wanted = candidate;
          break;
        }
        if (named) {
          this.warn(
            "rendition.unknown",
            `The ${rung} asks for rendition "${candidate}" on the repeating "${type}" component, which draws its rows as ${COLLECTION_PDF_RENDITIONS.renditions.map((r) => `"${r.id}"`).join(" or ")} only.`,
            model.id
          );
        }
      }
      // Nothing chose: a data grid's own layout setting does, any other collection takes the table.
      return COLLECTION_PDF_RENDITIONS.renditions.find((r) => r.id === (wanted ?? dataGridDefaultRendition(node)))!;
    }
    // The rungs' warnings wait for the verdict: a binding's rendition the type does not offer
    // can still be drawn by the generic set below, and then it was not passed over.
    const pending: Array<[string, string]> = [];
    const id = resolveRenditionId(
      {
        type,
        binding: binding.rendition,
        instance: readComponentPdfOptions(node.configuration).rendition,
        layoutDefaults: this.layoutDefaults,
        theme: themeChoice,
        themeWildcard
      },
      this.renditions,
      (code, message) => pending.push([code, message])
    );
    const declared = id !== undefined ? this.renditions.resolve(type, id) : undefined;
    if (declared) {
      for (const [code, message] of pending) {
        this.warn(code, message, model.id);
      }
      return declared;
    }
    // Nothing the type offers applied: the generic rendition for what the node is.
    const generic = this.genericRendition(node, binding);
    // The binding's rung is the first to warn, when it named a rendition the type lacks: drawn
    // generically after all, it is not reported as passed over.
    const bindingDrawn = binding.rendition !== undefined && generic.id === binding.rendition && pending.length > 0;
    for (const [code, message] of bindingDrawn ? pending.slice(1) : pending) {
      this.warn(code, message, model.id);
    }
    return generic;
  }

  /** The generic rendition a node falls to: the binding's or a wildcard rung's when the generic set has it, else the set's default. */
  private genericRendition(node: ComponentNode, binding: PdfBindingOptions) {
    const fallback = this.genericRenditionsFor(node);
    const wanted = [binding.rendition, this.layoutDefaults?.["*"], this.theme.components["*"]?.rendition].find(
      (candidate) => candidate !== undefined && fallback.renditions.some((r) => r.id === candidate)
    );
    return fallback.renditions.find((r) => r.id === (wanted ?? fallback.defaultRendition))!;
  }

  public renderComponent(
    model: RenderComponentModel,
    binding: PdfBindingOptions,
    scope: RowScope | undefined,
    headingLevel: number,
    stepTag?: string
  ): PdfBlock[] {
    const node = model.node;
    if (readComponentPdfOptions(node.configuration).exclude) {
      return [];
    }
    this.checkKnown(model, binding);
    if (!model.visible) {
      return [];
    }
    // Inside an entry, a field of the entries takes the entry's answer, under the field's key
    // within it; an entry with nothing at that key has no answer. The model's own value is never
    // read there: a collection adds no path level, so it is whatever answer sits at the same bare
    // key outside the collection. A field outside any collection reads the entry's answer at its
    // id when the entry has one, else its own.
    const rowKey = model.rowKey ?? model.id;
    const rowValue =
      scope && model.rowKey !== undefined
        ? Object.prototype.hasOwnProperty.call(scope.rowValues, rowKey)
          ? scope.rowValues[rowKey]
          : undefined
        : scope && Object.prototype.hasOwnProperty.call(scope.rowValues, rowKey)
          ? scope.rowValues[rowKey]
          : model.value;
    const value = this.format(model, rowValue);
    const label =
      binding.label === false
        ? undefined
        : binding.label !== undefined
          ? binding.label
          : model.hideLabel
            ? undefined
            : model.label;
    const fieldName =
      binding.widgetName ??
      (scope ? `${scope.collectionPath}[${scope.rowIndex}].${model.rowKey ?? model.valuePath}` : model.valuePath);
    if (node.type === FILE_COMPONENT_TYPE && (binding.attach ?? readComponentPdfOptions(node.configuration).attach) === true) {
      // Whatever rendition draws it, the files themselves travel as associated files.
      for (const file of readFileAttachments(rowValue)) {
        this.attachmentCollector.add(file, model.id, label ?? model.label);
      }
    }
    if (node.collection && !scope) {
      // A collection's rendition formats its rows without rendering the fields in them: the
      // files those rows hold are gathered here, on the instance rung alone (a binding on the
      // collection says nothing about the files inside it). A repeat over the same rows adds
      // the same files, which the collector tells apart.
      collectFormAttachments(node, this.modelsById, this.state.values, this.attachmentCollector);
    }
    const declaration = this.chooseRendition(model, binding);

    const context: PdfRenditionContext = {
      // An entry's answer replaces the model's, its files included: a rendition reading the
      // attachments (an image of an uploaded picture) draws the entry's, not the template's.
      model:
        rowValue === model.value
          ? model
          : { ...model, value: rowValue, file: model.file ? { ...model.file, attachments: readFileAttachments(rowValue) } : model.file },
      value,
      label,
      binding,
      style: this.styleFor(node.type, binding),
      theme: this.theme,
      texts: this.texts,
      locale: this.locale,
      translations: this.translations,
      translationCatalog: this.translationCatalog,
      textDirection: this.textDirection,
      fieldName,
      headingLevel,
      nextId: (suffix) => this.nextId(suffix ?? node.type),
      warn: (code, message) => this.warn(code, message, model.id),
      children: (slotId) => this.renderChildren(node, slotId, scope, headingLevel + 1),
      slotIds: () => this.slotIdsOf(node),
      rows: () => readCollectionRows(this.state.values, collectionPathOf(node) ?? node.id),
      rowFields: () => this.rowFieldsOf(node),
      format: (other, otherValue) => this.format(other, otherValue),
      addImage: (resource) => this.addImage(resource),
      addAttachment: (file, options) =>
        this.attachmentCollector.add(file, model.id, options?.description ?? label ?? model.label, options?.relationship)
    };
    try {
      const blocks = asPdfRenderer(declaration.render)(node, context);
      if (node.children && Object.keys(node.children).length > 0) {
        this.markSectionHeadings(blocks, stepTag);
      }
      return blocks;
    } catch (error) {
      if (error instanceof PdfKernelError) {
        // The policy's own refusal (a row field a collection rendition asked for), not the rendition failing.
        throw error;
      }
      this.warn(
        "rendition.failed",
        `Rendition "${declaration.id}" failed on "${model.id}": ${error instanceof Error ? error.message : String(error)}`,
        model.id
      );
      return [];
    }
  }

  private slotIdsOf(node: ComponentNode): string[] {
    const children = node.children ?? {};
    const declared = configuredSlotIds(node);
    if (!declared) {
      return Object.keys(children);
    }
    return [...declared, ...Object.keys(children).filter((slotId) => !declared.includes(slotId))];
  }

  private renderChildren(node: ComponentNode, slotId: string | undefined, scope: RowScope | undefined, headingLevel: number): PdfBlock[] {
    const slots = slotId !== undefined ? [slotId] : this.slotIdsOf(node);
    const out: PdfBlock[] = [];
    for (const slot of slots) {
      const children = node.children?.[slot] ?? [];
      // A wizard's steps carry the theme's step line above their headings ("Step 2 of 3").
      const steps = node.type === STEPS_COMPONENT_TYPE && this.texts.stepOf !== "" ? children.filter((child) => child.type === STEP_COMPONENT_TYPE) : [];
      for (const child of children) {
        const model = this.modelsById.get(child.id);
        if (model) {
          const index = steps.indexOf(child);
          const tag = index >= 0 ? this.texts.stepOf.replace(/\{\{\s*n\s*\}\}/g, String(index + 1)).replace(/\{\{\s*total\s*\}\}/g, String(steps.length)) : undefined;
          out.push(...this.renderComponent(model, {}, scope, headingLevel, tag));
        }
      }
    }
    return out;
  }

  private rowFieldsOf(node: ComponentNode): RenderComponentModel[] {
    const out: RenderComponentModel[] = [];
    for (const descendant of flattenComponentTree(node).slice(1)) {
      if (descendant.children && Object.keys(descendant.children).length > 0) {
        continue;
      }
      const model = this.modelsById.get(descendant.id);
      if (model && model.type !== "button") {
        // A row field is formatted, not drawn through a rendition, but what it prints follows
        // the rules a drawn field does: one the PDF excludes is left out, and the policy (about
        // whether the type is known here at all) is consulted before visibility, which leaves
        // out a field hidden by `hidden` or its rules.
        if (readComponentPdfOptions(model.node.configuration).exclude) {
          continue;
        }
        this.checkKnown(model);
        if (!model.visible) {
          continue;
        }
        out.push(model);
      }
    }
    return out;
  }

  // --- The layout tree --------------------------------------------------------------------

  public renderSlot(node: ComponentNode, slotId: string, scope: RowScope | undefined, headingLevel: number): PdfBlock[] {
    return (node.children?.[slotId] ?? []).flatMap((child) => this.renderLayoutNode(child, scope, headingLevel));
  }

  private bindingOptions(node: ComponentNode): PdfBindingOptions {
    const config = readConfig(node);
    const binding: PdfBindingOptions = {};
    if (typeof config.rendition === "string" && config.rendition.trim() !== "") {
      binding.rendition = config.rendition;
    }
    if (config.hideLabel === true) {
      binding.label = false;
    } else {
      const label = this.nodeText(node, "label");
      if (label !== undefined && label !== "") {
        binding.label = label;
      }
    }
    if (typeof config.widgetName === "string" && config.widgetName.trim() !== "") {
      binding.widgetName = config.widgetName;
    }
    if (typeof config.attach === "boolean") {
      // A boolean either way is the binding's decision; absent, the instance's `pdf.attach` holds.
      binding.attach = config.attach;
    }
    if (isRecord(config.style)) {
      binding.style = readPdfComponentStyle(config.style, (key, expected) => this.warnings.push(pdfStyleWarning(`binding "${node.id}"`, key, expected, typeof config.componentId === "string" ? config.componentId : undefined)));
    }
    return binding;
  }

  public renderLayoutNode(node: ComponentNode, scope: RowScope | undefined, headingLevel: number): PdfBlock[] {
    const config = readConfig(node);
    switch (node.type) {
      case PDF_FIELD_COMPONENT_TYPE: {
        const componentId = typeof config.componentId === "string" ? config.componentId : "";
        const model = this.modelIndex.named(componentId);
        if (!model) {
          this.warn(
            "binding.unresolved",
            componentId === ""
              ? `Layout node "${node.id}" binds no form component.`
              : `Layout node "${node.id}" binds "${componentId}", which the form does not have.`
          );
          return [];
        }
        return this.renderComponent(model, this.bindingOptions(node), scope, headingLevel);
      }
      case PDF_TEXT_COMPONENT_TYPE:
        return this.renderText(node, scope);
      case PDF_SECTION_COMPONENT_TYPE:
        return this.renderSection(node, scope, headingLevel);
      case PDF_TABLE_COMPONENT_TYPE:
        return this.renderTable(node, scope, headingLevel);
      case PDF_REPEAT_COMPONENT_TYPE:
        return this.renderRepeat(node, scope, headingLevel);
      case PDF_BOX_COMPONENT_TYPE:
        return this.renderBox(node, scope, headingLevel);
      case PDF_RULE_COMPONENT_TYPE:
        return [
          {
            id: this.nextId("rule"),
            kind: "rule",
            artifact: true,
            thickness: readNumber(config.thickness, 0.75, 0.1),
            ...(readColor(config.color) ? { color: readColor(config.color)! } : {})
          }
        ];
      case PDF_SPACER_COMPONENT_TYPE:
        return [{ id: this.nextId("spacer"), kind: "spacer", artifact: true, height: readNumber(config.height, 12, 1) }];
      case PDF_IMAGE_COMPONENT_TYPE:
        return this.renderImage(node);
      case PDF_SIGNATURE_COMPONENT_TYPE:
        return this.renderSignature(node, scope);
      case PDF_PAGE_BREAK_COMPONENT_TYPE: {
        // A break's own setup changes what it names; the rest (margins, the header and footer
        // bands, the size or orientation it leaves out) stays the document's.
        const page: ResolvedPdfPageSetup | undefined =
          config.changePage === true && isRecord(config.page) ? resolvePdfPageSetup(overPageSetting(config.page, this.documentPage)) : undefined;
        return [{ id: this.nextId("break"), kind: "pageBreak", ...(page ? { page } : {}) }];
      }
      case PDF_DOCUMENT_COMPONENT_TYPE:
        this.warn("layout.nestedDocument", `Layout node "${node.id}" is a document inside a document; skipped.`);
        return [];
      default: {
        // A form component dropped straight into the layout tree binds itself.
        const model = this.modelsById.get(node.id);
        if (model) {
          return this.renderComponent(model, {}, scope, headingLevel);
        }
        this.warn("layout.unknownType", `Layout node "${node.id}" has type "${node.type}", which the PDF layout does not know; skipped.`);
        return [];
      }
    }
  }

  private renderText(node: ComponentNode, scope: RowScope | undefined): PdfBlock[] {
    const config = readConfig(node);
    let runs: PdfTextRun[];
    if (isRecord(config.expression) && typeof config.expression.kind === "string") {
      runs = [{ text: evaluateTemplateExpression(config.expression as unknown as Expression, this.ruleContext(scope)) }];
    } else {
      const text = this.nodeText(node, "text") ?? "";
      runs = this.templateRuns(text, scope);
    }
    if (runs.every((run) => run.text === "" && !run.token)) {
      return [];
    }
    const align = config.align === "center" || config.align === "end" ? config.align : undefined;
    const variant = typeof config.variant === "string" ? config.variant : "body";
    const headingMatch = /^h([1-6])$/.exec(variant);
    if (headingMatch) {
      const level = Number(headingMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6;
      return [
        {
          id: this.nextId("text"),
          kind: "heading",
          level,
          runs,
          // The document title's rule: under a level-1 heading when the theme draws one.
          ...(level === 1 && this.theme.headings.titleRule ? { rule: true } : {}),
          ...(align ? { style: { align } } : {})
        }
      ];
    }
    const style: NonNullable<PdfBlock["style"]> = {};
    if (align) {
      style.align = align;
    }
    if (isRecord(config.style)) {
      const before = readNumber(config.style.spacingBefore, -1);
      const after = readNumber(config.style.spacingAfter, -1);
      if (before >= 0) {
        style.spacingBefore = before;
      }
      if (after >= 0) {
        style.spacingAfter = after;
      }
    }
    if (variant === "muted") {
      // The theme's small type when it has one, else the label size in the muted colour.
      const small = this.theme.typography.small;
      style.color = small?.color ?? this.theme.colors.muted;
      style.size = small?.size ?? this.theme.typography.label.size;
      if (small && small.family !== this.theme.typography.body.family) {
        style.family = small.family;
      }
    } else if (variant === "label") {
      style.size = this.theme.typography.label.size;
      runs = runs.map((run) => ({ ...run, bold: true }));
    }
    return [
      {
        id: this.nextId("text"),
        kind: "paragraph",
        runs,
        role: "P",
        ...(Object.keys(style).length > 0 ? { style } : {})
      }
    ];
  }

  private renderSection(node: ComponentNode, scope: RowScope | undefined, headingLevel: number): PdfBlock[] {
    const config = readConfig(node);
    const label = this.nodeText(node, "label");
    const hasHeading = label !== undefined && label !== "" && config.hideLabel !== true;
    const headingId = hasHeading ? this.nextId("section-heading") : undefined;
    const sectionId = this.nextId("section");
    const content = this.renderSlot(node, "content", scope, headingLevel + (hasHeading ? 1 : 0));
    // Skipped whole, heading included, when nothing in it prints (every field hidden by a rule, say).
    if (config.skipWhenEmpty === true && !hasPrintableContent(content)) {
      return [];
    }
    const blocks: PdfBlock[] = [];
    if (hasHeading && headingId !== undefined) {
      this.sectionHeadingIds.add(headingId);
      // A section that is a wizard's step (`step: { index, total }`) takes the theme's step line above its heading.
      const step = isRecord(config.step) ? config.step : undefined;
      const tag =
        step && this.texts.stepOf !== "" && typeof step.index === "number" && typeof step.total === "number"
          ? this.texts.stepOf.replace(/\{\{\s*n\s*\}\}/g, String(step.index)).replace(/\{\{\s*total\s*\}\}/g, String(step.total))
          : undefined;
      blocks.push({
        id: headingId,
        kind: "heading",
        level: Math.min(6, Math.max(1, headingLevel)) as 1 | 2 | 3 | 4 | 5 | 6,
        // A fieldset's required legend mark follows its words in the theme's required word, as on screen.
        runs: [{ text: label }, ...(readLegendMark(config) === "required" && this.texts.required !== "" ? [{ text: ` ${this.texts.required}`, bold: false }] : [])],
        keepWithNext: true,
        ...(tag !== undefined ? { tag } : {})
      });
    }
    blocks.push({
      id: sectionId,
      kind: "group",
      role: "Sect",
      blocks: content,
      keepTogether: config.keepTogether === true
    });
    return blocks;
  }

  private tableRow(node: ComponentNode, row: number, scope: RowScope | undefined, headingLevel: number, header: boolean): PdfTableRow {
    const cells: PdfTableCell[] = pdfTableRowSlotIds(node.configuration, row).map((slotId) => ({
      id: this.nextId("cell"),
      blocks: this.renderSlot(node, slotId, scope, headingLevel),
      ...(header ? { header: true } : {})
    }));
    return { id: this.nextId("row"), cells, keepTogether: true };
  }

  private renderTable(node: ComponentNode, scope: RowScope | undefined, headingLevel: number): PdfBlock[] {
    const spec = readPdfTableSpec(node.configuration);
    const columns = Array.from({ length: spec.columns }, (_, index) => ({
      width: spec.widths ? { fraction: spec.widths[index]! / spec.widths.reduce((a, b) => a + b, 0) } : { fraction: 1 / spec.columns }
    }));
    const header = spec.header ? this.tableRow(node, 1, scope, headingLevel, true) : undefined;
    const firstBodyRow = spec.header ? 2 : 1;
    let rows: PdfTableRow[];
    if (spec.collectionPath) {
      const data = readCollectionRows(this.state.values, spec.collectionPath);
      rows = data.map((rowValues, index) =>
        this.tableRow(
          node,
          firstBodyRow,
          this.rowScope(spec.collectionPath!, rowValues, index, data.length, scope),
          headingLevel,
          false
        )
      );
    } else {
      rows = [];
      for (let row = firstBodyRow; row <= spec.rows; row += 1) {
        rows.push(this.tableRow(node, row, scope, headingLevel, false));
      }
    }
    // Skipped when no body cell prints — a collection with no entries, or a grid whose fields
    // are all hidden — whatever captions the header row carries.
    if (readConfig(node).skipWhenEmpty === true && !rows.some((row) => row.cells.some((cell) => hasPrintableContent(cell.blocks)))) {
      return [];
    }
    // A table's own spacing, as a `pdf-text` or `pdf-box` carries it: `style.spacingBefore/After`.
    const config = readConfig(node);
    const style: NonNullable<PdfBlock["style"]> = {};
    if (isRecord(config.style)) {
      const before = readNumber(config.style.spacingBefore, -1);
      const after = readNumber(config.style.spacingAfter, -1);
      if (before >= 0) {
        style.spacingBefore = before;
      }
      if (after >= 0) {
        style.spacingAfter = after;
      }
    }
    return [
      {
        id: this.nextId("table"),
        kind: "table",
        role: spec.borders === "none" && !spec.header ? "Div" : "Table",
        columns,
        ...(header ? { header } : {}),
        rows,
        repeatHeader: !!header,
        borders: spec.borders,
        ...(Object.keys(style).length > 0 ? { style } : {})
      }
    ];
  }

  private rowScope(
    collectionPath: string,
    rowValues: Record<string, unknown>,
    rowIndex: number,
    rowCount: number,
    outer: RowScope | undefined
  ): RowScope {
    return {
      collectionPath,
      rowIndex,
      rowCount,
      rowValues,
      ancestorValues: outer ? { ...outer.ancestorValues, [outer.collectionPath]: outer.rowValues } : {}
    };
  }

  private renderRepeat(node: ComponentNode, scope: RowScope | undefined, headingLevel: number): PdfBlock[] {
    const config = readConfig(node);
    const collectionPath = typeof config.collectionPath === "string" ? config.collectionPath.trim() : "";
    if (collectionPath === "") {
      this.warn("repeat.unbound", `Repeat "${node.id}" names no collection.`);
      return [];
    }
    let rows = readCollectionRows(this.state.values, collectionPath);
    const maxRows = typeof config.maxRows === "number" && config.maxRows >= 1 ? Math.floor(config.maxRows) : undefined;
    if (maxRows !== undefined && rows.length > maxRows) {
      rows = rows.slice(0, maxRows);
    }
    if (rows.length === 0) {
      const emptyText = this.nodeText(node, "emptyText");
      return emptyText
        ? [{ id: this.nextId("repeat-empty"), kind: "paragraph", role: "P", runs: [{ text: emptyText }] }]
        : [];
    }
    return rows.map((rowValues, index) => ({
      id: this.nextId("repeat-row"),
      kind: "group",
      role: "Div",
      blocks: this.renderSlot(node, "row", this.rowScope(collectionPath, rowValues, index, rows.length, scope), headingLevel),
      keepTogether: config.keepRowTogether === true
    }));
  }

  private renderBox(node: ComponentNode, scope: RowScope | undefined, headingLevel: number): PdfBlock[] {
    const config = readConfig(node);
    const boxId = this.nextId("box");
    const content = this.renderSlot(node, "content", scope, headingLevel);
    // Skipped, border and fill included, when nothing in it prints; an empty anchored box is not pinned either.
    if (config.skipWhenEmpty === true && !hasPrintableContent(content)) {
      return [];
    }
    // The theme's box says what the node leaves unsaid: padding, border, corners, fill.
    const defaults = this.theme.box;
    const box: PdfBoxBlock = {
      id: boxId,
      kind: "box",
      role: "Div",
      blocks: content,
      padding: readNumber(config.padding, defaults.padding)
    };
    if (config.border !== false) {
      box.border = { width: readNumber(config.borderWidth, defaults.borderWidth, 0.1), color: readColor(config.borderColor) ?? this.theme.colors.border };
    }
    const radius = readNumber(config.radius, defaults.radius);
    if (radius > 0) {
      box.radius = radius;
    }
    const fill = readColor(config.fill) ?? defaults.fill;
    if (fill) {
      box.fill = fill;
    }
    const anchor = readPdfBoxAnchor(node.configuration);
    if (anchor) {
      this.anchored.push({ id: this.nextId("anchored"), anchor, box });
      return [];
    }
    return [box];
  }

  /**
   * A signature block the layout places on its own: a named signature field the
   * server (or a person) signs into, or a ruled line for a pen. Its caption takes the same
   * `{{path}}` templates `pdf-text` does.
   */
  private renderSignature(node: ComponentNode, scope: RowScope | undefined): PdfBlock[] {
    const config = readConfig(node);
    const caption = this.nodeText(node, "label");
    const label = caption ? runsText(this.templateRuns(caption, scope)) : undefined;
    if (config.mode === "line") {
      return [
        {
          id: this.nextId("signature-line"),
          kind: "labelValue",
          label: label ?? "",
          value: [],
          arrangement: "ruled",
          lines: 1
        }
      ];
    }
    const fieldName = typeof config.fieldName === "string" && config.fieldName.trim() !== "" ? config.fieldName.trim() : node.id;
    if (this.signatureFields.includes(fieldName)) {
      this.warn("layout.duplicateWidgetName", `Signature block "${node.id}" names the field "${fieldName}", which another block already uses; only the first is a field.`);
    }
    this.signatureFields.push(fieldName);
    const themed = pdfThemeChoiceFor(this.theme, PDF_SIGNATURE_COMPONENT_TYPE).style;
    const height = readNumber(config.height, themed?.widgetHeight ?? 40, 8);
    const width = typeof config.width === "number" && config.width > 0 ? config.width : undefined;
    return [
      {
        id: this.nextId("signature"),
        kind: "widget",
        field: { name: fieldName, kind: "signature", ...(label ? { tooltip: label } : {}) },
        ...(label ? { label, labelPosition: "above" } : {}),
        height,
        ...(width !== undefined ? { width } : {})
      }
    ];
  }

  private renderImage(node: ComponentNode): PdfBlock[] {
    const config = readConfig(node);
    const src = typeof config.src === "string" ? config.src.trim() : "";
    if (src === "") {
      return [];
    }
    const dataMatch = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/.exec(src);
    if (!dataMatch && !/^(https?:)?\/\//i.test(src) && !src.startsWith("/") && !src.startsWith("./")) {
      this.warn("image.unsafeUrl", `Image "${node.id}" has a URL the PDF will not fetch.`);
      return [];
    }
    const resourceId = this.addImage(
      dataMatch ? { type: dataMatch[1] as "image/png" | "image/jpeg", data: dataMatch[2]!.replace(/\s+/g, "") } : { url: src }
    );
    const alt = this.nodeText(node, "alt") ?? "";
    return [
      {
        id: this.nextId("image"),
        kind: "image",
        role: "Figure",
        resourceId,
        alt,
        ...(typeof config.width === "number" && config.width > 0 ? { width: config.width } : {}),
        ...(typeof config.height === "number" && config.height > 0 ? { height: config.height } : {})
      }
    ];
  }
}

/**
 * A page setting over another, field by field: what `over` sets wins, the rest is `under`'s, and
 * the margins merge side by side. Either may be absent or not a record (then the other stands).
 */
function overPageSetting(over: unknown, under: unknown): unknown {
  if (!isRecord(over)) {
    return under;
  }
  if (!isRecord(under)) {
    return over;
  }
  const merged: Record<string, unknown> = { ...under };
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  if (isRecord(over.margins) && isRecord(under.margins)) {
    const margins: Record<string, unknown> = { ...under.margins };
    for (const [side, value] of Object.entries(over.margins)) {
      if (value !== undefined) {
        margins[side] = value;
      }
    }
    merged.margins = margins;
  }
  return merged;
}

function readLayoutSetting<T>(layout: PdfGeneratedLayout, key: "page" | "accessibility" | "conformance" | "attachments" | "signature" | "limits" | "renditionDefaults" | "theme" | "name"): T | undefined {
  const own = (layout as unknown as Record<string, unknown>)[key];
  if (own !== undefined) {
    return own as T;
  }
  const root = isRecord(layout.root.configuration) ? layout.root.configuration : {};
  return root[key] as T | undefined;
}

/**
 * The layout's signature settings as the kernel takes them: the tolerant read,
 * the reason in the document's locale. `undefined` when the layout says nothing.
 */
function signatureSettings(
  setting: unknown,
  layoutId: string,
  locale: string,
  sources: TextSources,
  knownFields: readonly string[] | undefined,
  warnings: PdfWarning[]
): PdfSignatureSettings | undefined {
  const configuration = resolvePdfSignatureConfiguration(setting);
  if (!configuration) {
    return undefined;
  }
  const { reason, ...rest } = configuration;
  const resolvedReason = layoutText(reason, layoutId, "signature.reason", locale, sources);
  if (configuration.field !== undefined && knownFields !== undefined && !knownFields.includes(configuration.field)) {
    warnings.push({
      code: "signature.fieldMissing",
      message: `The layout signs into the field "${configuration.field}", but no pdf-signature block in it is named so; a new field will be made instead.`
    });
  }
  return { ...rest, ...(resolvedReason !== undefined && resolvedReason !== "" ? { reason: resolvedReason } : {}) };
}

/** The output intent as the kernel takes it: an inline profile resolved to bytes here, any other left for the host. */
function outputIntentFor(configuration: PdfOutputIntentConfiguration): PdfOutputIntent {
  const source = configuration.profile;
  // A built-in profile brings its own names as a set (the kernel has the bytes), unless the
  // layout names the condition itself; an uploaded one is named after its file.
  const builtin = configuration.identifier === undefined ? builtinProfileOf(source) : undefined;
  const identifier = configuration.identifier ?? builtin?.identifier ?? source.name.replace(/\.[^.]+$/, "");
  const registry = configuration.registry ?? builtin?.registry;
  return {
    profile: source.storage === "base64" && typeof source.data === "string" ? { data: source.data } : { source },
    identifier,
    info: configuration.info ?? builtin?.info ?? identifier,
    ...(registry ? { registry } : {})
  };
}

/**
 * The archival profile a layout asks for: the layout's own `conformance`, else the
 * theme's level and output condition — each tier on its own, so a layout may set the level
 * and inherit the theme's profile. `undefined` when neither asks for PDF/A.
 */
function resolveConformanceFor(
  setting: unknown,
  theme: ResolvedPdfTheme,
  warnings: PdfWarning[]
): { resolved: ResolvedPdfConformance; conformance: PdfDocumentConformance } | undefined {
  const declared = resolvePdfConformance(setting);
  const pdfa = declared?.pdfa ?? theme.pdfa;
  if (!pdfa) {
    return undefined;
  }
  const resolved: ResolvedPdfConformance = declared ?? { pdfa, attachData: false, attachment: { name: DEFAULT_PDF_ATTACHMENT_NAME } };
  const outputIntent = declared?.outputIntent ?? theme.outputIntent;
  if (isRecord(setting) && setting.attachData === true && pdfAPart(pdfa) !== 3) {
    warnings.push({
      code: "pdfa.attachments",
      message: `The submission data is only embedded under PDF/A-3; the layout asks for PDF/A-${pdfa}, so nothing was attached.`
    });
  }
  return {
    resolved,
    conformance: { pdfa, ...(outputIntent ? { outputIntent: outputIntentFor(outputIntent) } : {}) }
  };
}

/** The submission values as an associated file: stable-key JSON, so the same answers give the same bytes on every host. */
function submissionAttachment(
  root: ComponentNode,
  layoutId: string,
  locale: string,
  values: Record<string, unknown>,
  attachment: ResolvedPdfConformance["attachment"],
  sources: TextSources,
  fallbackDescription: LocalizedText | undefined
): PdfAttachment {
  const json = kernelStableStringify({ form: root.id, layout: layoutId, locale, values });
  return {
    name: attachment.name,
    mimeType: "application/json",
    // The layout's own description is a string translated under the layout; the theme's fallback is host data.
    description:
      layoutText(attachment.description, layoutId, "conformance.attachment.description", locale, sources) ??
      resolveLocalizedText(fallbackDescription, locale) ??
      "Submission data",
    relationship: "Data",
    data: bytesToBase64(new TextEncoder().encode(json))
  };
}

/** A layout's conformance with the submission attached when it asks for that. */
function documentConformance(
  layout: PdfGeneratedLayout | PdfTemplateLayout,
  setting: unknown,
  theme: ResolvedPdfTheme,
  root: ComponentNode,
  locale: string,
  values: Record<string, unknown>,
  sources: TextSources,
  warnings: PdfWarning[]
): PdfDocumentConformance | undefined {
  const found = resolveConformanceFor(setting, theme, warnings);
  if (!found) {
    return undefined;
  }
  if (!found.resolved.attachData) {
    return found.conformance;
  }
  return {
    ...found.conformance,
    attachments: [submissionAttachment(root, layout.id, locale, values, found.resolved.attachment, sources, theme.texts.attachmentDescription)]
  };
}

/**
 * What the choice of layout has to say: an id asked for that names no usable layout
 * (the form lacks it, or has it but cannot render it), and each condition that could not be
 * evaluated — counted as not holding, so the next layout, the default or the first printed.
 */
function layoutSelectionWarnings(selection: PdfLayoutSelection, layoutId: string | undefined): PdfWarning[] {
  const warnings: PdfWarning[] = [];
  if (!selection.layout && layoutId !== undefined) {
    warnings.push({ code: "layout.notFound", message: `The form has no usable PDF layout "${layoutId}"; a layout derived from the form was used.` });
  }
  for (const failure of selection.failed) {
    warnings.push(
      failure.reason === "invalid"
        ? { code: "layout.conditionInvalid", message: `The condition of PDF layout "${failure.layoutId}" is not one the evaluator can run; it counted as not holding.` }
        : { code: "layout.conditionFailed", message: `The condition of PDF layout "${failure.layoutId}" could not be evaluated (${failure.message ?? "unknown error"}); it counted as not holding.` }
    );
  }
  return warnings;
}

/**
 * A component whose option source failed (or had not answered) when the PDF was built prints
 * with no options to list: a checklist shows none of them, and a picked answer reads as its
 * stored value rather than its label. `options.unavailable` says so, once per component the PDF
 * does not leave out.
 */
function optionWarnings(components: readonly RenderComponentModel[]): PdfWarning[] {
  const warnings: PdfWarning[] = [];
  for (const model of components) {
    const status = model.optionState.status;
    if ((status !== "error" && status !== "loading") || readComponentPdfOptions(model.node.configuration).exclude) {
      continue;
    }
    const source = model.optionState.sourceId !== undefined ? ` "${model.optionState.sourceId}"` : "";
    const why =
      status === "loading"
        ? "had not answered"
        : `failed${model.optionState.error !== undefined && model.optionState.error !== "" ? ` (${model.optionState.error})` : ""}`;
    warnings.push({
      code: "options.unavailable",
      message: `The option source${source} of "${model.id}" ${why}; the PDF lists none of its options, and its answer prints as stored.`,
      componentId: model.id
    });
  }
  return warnings;
}

/**
 * The answers as printed: each read as the envelope's JSON carries it (`kernelJsonAnswers`), and
 * every collection holding a drawn row with no answer yet (its keys hold `undefined`, which JSON
 * leaves out) given its rows whole at its path too, `{}` for that row, so the row is
 * printed as the server's PDF of the same submission prints it — which reads the rows posted
 * whole — rather than collapsing into the next. A form whose rows all hold an answer, or that has
 * no collection, prints from the answers unchanged.
 */
function printedAnswers(root: ComponentNode, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...kernelJsonAnswers(values) };
  const paths = new Set<string>();
  const visit = (node: ComponentNode): void => {
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        const path = collectionPathOf(child);
        if (path !== undefined) {
          paths.add(path);
        }
        visit(child);
      }
    }
  };
  visit(root);
  for (const path of paths) {
    if (Object.prototype.hasOwnProperty.call(out, path)) {
      continue;
    }
    const prefix = `${path}[`;
    const rows = new Map<number, Record<string, unknown>>();
    for (const key of Object.keys(values)) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const close = key.indexOf("]", prefix.length);
      const digits = close > prefix.length ? key.slice(prefix.length, close) : "";
      if (!/^\d+$/.test(digits) || key.charAt(close + 1) !== "." || close + 2 >= key.length) {
        continue;
      }
      const index = Number(digits);
      const row = rows.get(index) ?? {};
      rows.set(index, row);
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        row[key.slice(close + 2)] = out[key];
      }
    }
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
    if (ordered.some((row) => Object.keys(row).length === 0)) {
      out[path] = ordered;
    }
  }
  return out;
}

export async function buildPdfRenderModel(
  authored: ComponentNode,
  held: FormState,
  resolver: DataSourceResolver,
  modelContext: Omit<RenderModelContext, "readOnlyByMode"> = {},
  options: PdfRenderModelOptions = {}
): Promise<PdfRenderModel> {
  // Formulas first: every rule the layouts and the tree carry as a string becomes a
  // tree in a copy, under the policy; the author's objects stay as they were. A tree compiled
  // already (a runtime's, the program's after its own compile) passes through unchanged.
  const compiled = compilePdfDefinition(authored, options.pdf, options.layout, {
    formulaErrors: options.formulaErrors,
    functions: options.functions,
    riskyPatterns: options.riskyPatterns,
    kinds: options.kinds
  });
  const root = compiled.root;
  // What prints reads the answers as the envelope carries them: a
  // calculation's `NaN` is JSON's `null` and prints as an unanswered value, as the server's PDF
  // of the same submission prints it; an `undefined` entry is absent. Answers that are JSON
  // already (a server's, a program's) come through as they are.
  const state: FormState = { ...held, values: printedAnswers(root, held.values) };
  const locale = modelContext.locale ?? state.locale;
  // Both sources of translations, the definition's map and the host's catalog (an entry there wins).
  const sources: TextSources = { translations: modelContext.translations, catalog: modelContext.translationCatalog };
  const optionStates = await resolveOptionStatesForTree(resolver, root, {}, {}, {
    locale,
    translations: modelContext.translations,
    translationCatalog: modelContext.translationCatalog
  });
  // The locale is passed on explicitly: a caller that left it off the context still gets the
  // component labels in the state's locale, the one every layout text is resolved in.
  const components = buildComponentModels(root, state, optionStates, { ...modelContext, locale, readOnlyByMode: true });
  const modelsById = new Map(components.map((model) => [model.id, model]));

  const rootConfig = isRecord(root.configuration) ? root.configuration : {};
  // The host's own wording of the title, else the form's, translated at `form › title`.
  const formTitle = readText(rootConfig.title);
  const declaredTitle =
    resolveLocalizedText(options.title, locale) ??
    (formTitle !== undefined ? resolveText(formTitle, addressOf.form("title"), locale, sources) : undefined);
  const title = declaredTitle ?? root.id;
  const textDirection: TextDirection = modelContext.accessibilityOptions?.textDirection ?? (isRtlLocale(locale) ? "rtl" : "ltr");

  // Which layout: the one handed over, else the one asked for by id, else the first
  // whose `when` holds on the submittable answers, else the default, else the first.
  const selection: PdfLayoutSelection | undefined = compiled.layout
    ? undefined
    : selectPdfLayoutForValues({ root, pdf: compiled.pdf }, options.selectionValues ?? state.values, {
        layoutId: options.layoutId,
        today: options.today,
        functions: options.functions,
        riskyPatterns: options.riskyPatterns
      });
  const declared = compiled.layout ?? selection?.layout;
  const layoutChoice: PdfLayoutChoice = selection?.choice ?? "given";
  const warnings: PdfWarning[] = [...compiled.warnings, ...(selection ? layoutSelectionWarnings(selection, options.layoutId) : []), ...optionWarnings(components)];

  // The theme: the call's id, the generated layout's `theme`, the host's default, the PDF theme
  // the form's binding suggests, the engine's.
  const layoutThemeId = declared && !isPdfTemplateLayout(declared) ? readLayoutSetting<unknown>(declared, "theme") : undefined;
  const themeSelection = selectPdfTheme({
    themeId: options.themeId,
    layoutThemeId: typeof layoutThemeId === "string" ? layoutThemeId : undefined,
    theme: options.theme,
    binding: options.binding,
    resolveTheme: options.resolveTheme
  });
  warnings.push(...themeSelection.warnings);
  const theme = resolvePdfTheme(themeSelection.theme, (warning) => warnings.push(warning));
  const texts = {
    yes: resolveLocalizedText(theme.texts.yes, locale) ?? "Yes",
    no: resolveLocalizedText(theme.texts.no, locale) ?? "No"
  };

  if (declared && isPdfTemplateLayout(declared)) {
    const resolved = resolveFieldMappings(declared, {
      modelsById,
      values: state.values,
      locale,
      translations: modelContext.translations,
      translationCatalog: modelContext.translationCatalog,
      texts,
      hostContext: options.hostContext,
      today: options.today,
      functions: options.functions,
      riskyPatterns: options.riskyPatterns
    });
    // A template keeps its own output intent: a file declares one PDF/A condition, and the
    // template's is the one its content was made for. Only the layout's own is worth a word;
    // a theme's is meant for the documents the theme generates.
    const conformance = documentConformance(declared, declared.conformance, theme, root, locale, state.values, sources, warnings);
    if (conformance?.outputIntent) {
      if (resolvePdfConformance(declared.conformance)?.outputIntent) {
        warnings.push({ code: "pdfa.outputIntent", message: "A template keeps the output intent it declares; the layout's outputIntent was not applied." });
      }
      delete conformance.outputIntent;
    }
    // A template has no bindings to walk: the form's own `file` components decide what is attached.
    const collector = new PdfAttachmentCollector(resolvePdfAttachmentPolicy(declared.attachments, options.attachments), (warning) => warnings.push(warning));
    collectFormAttachments(root, modelsById, state.values, collector);
    const attachments = collector.list();
    // A template's signature field is one of the PDF's own; whether it exists is the kernel's to say.
    const signature = signatureSettings(declared.signature, declared.id, locale, sources, undefined, warnings);
    return {
      mode: "pdf",
      layoutId: declared.id,
      themeId: theme.id,
      layoutKind: "template",
      layoutChoice,
      fill: {
        layoutId: declared.id,
        template: declared.template,
        values: resolved.values,
        areas: resolved.areas,
        options: resolveTemplateFillOptions(declared.options),
        ...(conformance ? { conformance } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(signature ? { signature } : {}),
        // The content areas draw in the theme's type and colours unless an area says otherwise.
        typography: theme.typography,
        colors: theme.colors
      },
      components,
      warnings: [...warnings, ...resolved.warnings],
      fontFaces: themeFontFaces(themeSelection.theme)
    };
  }

  // The derived footer's band fits one line of the theme's small type in a table row.
  const small = theme.typography.small ?? theme.typography.label;
  const footerHeight = Math.ceil(Math.max(theme.table.rowMinHeight, small.size * (small.lineHeight ?? 1.3) + 2 * theme.table.cellPadding) + 2);
  // A derived layout carries the form's own words, already in the language asked for: they are
  // translated under `components` and `form`, where the form keeps them, not under `pdf`.
  const layout: PdfGeneratedLayout =
    declared ??
    deriveDefaultPdfLayout(root, {
      title: declaredTitle !== "" ? declaredTitle : undefined,
      locale,
      translations: modelContext.translations,
      translationCatalog: modelContext.translationCatalog,
      footerHeight,
      pageOf: theme.texts.pageOf
    });
  const renditions = options.renditions ?? createPdfRenditionResolver();
  const layoutDefaults = readLayoutSetting<Record<string, string>>(layout, "renditionDefaults");
  const renderer = new LayoutRenderer(
    root,
    state,
    components,
    theme,
    renditions,
    isRecord(layoutDefaults) ? layoutDefaults : undefined,
    locale,
    modelContext.translationCatalog,
    modelContext.translations,
    layout.id,
    textDirection,
    options.hostContext,
    options.unknownComponents ?? DEFAULT_PDF_UNKNOWN_COMPONENT_POLICY,
    resolvePdfAttachmentPolicy(readLayoutSetting<unknown>(layout, "attachments"), options.attachments),
    options.today,
    options.functions,
    options.riskyPatterns
  );

  const limitsSetting = readLayoutSetting<unknown>(layout, "limits");
  const limits = resolvePdfRenderLimits(limitsSetting);
  renderer.answerChars = limits.answerChars;
  for (const key of pdfRenderLimitsOverCeiling(limitsSetting)) {
    warnings.push({
      code: "render.limitsCapped",
      message: `The layout asks for limits.${key} of ${(limitsSetting as Record<string, unknown>)[key]}; the most a render takes is ${PDF_RENDER_LIMIT_CEILING[key]}, which applied.`
    });
  }
  // Field by field: the layout's page over the theme's over the defaults, so a theme's paper
  // size and margins reach a layout that sets only its footer band (the derived one does).
  const page = resolvePdfPageSetup(overPageSetting(readLayoutSetting<unknown>(layout, "page"), theme.page));
  renderer.documentPage = page;
  const accessibilitySetting = readLayoutSetting<unknown>(layout, "accessibility");
  const accessibility = resolvePdfAccessibility(accessibilitySetting);
  const taggedDeclared = isRecord(accessibilitySetting) && typeof accessibilitySetting.tagged === "boolean";
  const tagged = taggedDeclared ? accessibility.tagged : (theme.tagged ?? accessibility.tagged);
  const conformance = documentConformance(
    layout,
    readLayoutSetting<unknown>(layout, "conformance"),
    theme,
    root,
    locale,
    state.values,
    sources,
    warnings
  );

  const body = renderer.renderSlot(layout.root, PDF_DOCUMENT_BODY_SLOT, undefined, 2);
  renderer.decorateSections(body);
  const header = renderer.renderSlot(layout.root, PDF_DOCUMENT_HEADER_SLOT, undefined, 6);
  const footer = renderer.renderSlot(layout.root, PDF_DOCUMENT_FOOTER_SLOT, undefined, 6);
  const attachments = renderer.attachments();
  // Every widget's field, the signature blocks' and a signature component's `field` rendition's alike.
  const signatureFields = renderer.checkWidgetNames([...body, ...renderer.anchored.map((entry) => entry.box), ...header, ...footer]);
  const signature = signatureSettings(readLayoutSetting<unknown>(layout, "signature"), layout.id, locale, sources, signatureFields, warnings);

  const documentTitle =
    layoutText(accessibility.title, layout.id, "accessibility.title", locale, sources) ??
    layoutText(readText(readLayoutSetting<unknown>(layout, "name")), layout.id, "name", locale, sources) ??
    title;

  const document: PdfDocument = {
    version: PDF_DOCUMENT_MODEL_VERSION,
    page,
    metadata: {
      title: documentTitle,
      lang: accessibility.lang ?? locale,
      textDirection
    },
    accessibility: { tagged, displayDocTitle: accessibility.displayDocTitle },
    ...(conformance ? { conformance } : {}),
    typography: theme.typography,
    colors: theme.colors,
    controls: theme.controls,
    choice: theme.choice,
    fields: theme.fields,
    headings: theme.headings,
    table: theme.table,
    box: theme.box,
    panel: theme.panel,
    list: theme.list,
    spacing: theme.spacing,
    ...(header.length > 0 ? { header } : {}),
    ...(footer.length > 0 ? { footer } : {}),
    blocks: body,
    anchored: renderer.anchored,
    resources: renderer.resources(),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(signature ? { signature } : {}),
    ...(limitsSetting !== undefined ? { limits } : {})
  };

  return {
    mode: "pdf",
    layoutId: layout.id,
    themeId: theme.id,
    layoutKind: declared ? "generated" : "derived",
    layoutChoice,
    document,
    components,
    warnings: [...warnings, ...renderer.warnings],
    fontFaces: themeFontFaces(themeSelection.theme)
  };
}
