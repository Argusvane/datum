/**
 * Renditions: the ways a component type can appear on paper, and how the one a
 * bound component takes is chosen.
 *
 * A rendition is a pure function from a node and a {@link PdfRenditionContext} to
 * {@link PdfBlock}s. The context is the engine's resolved view — the `RenderComponentModel`,
 * the value already formatted for paper, the label after any binding override, the style the
 * theme gives the type — so a rendition author never re-derives a label from `LocalizedText`
 * or an option's caption from its key.
 *
 * Where a rendition comes from, in the order a lookup tries them: the type's own definition
 * (`ComponentDefinition.pdf`), a plugin's
 * contribution for the type, the engine's built-in table. Which of a type's renditions a bound
 * component takes is the ladder in {@link resolveRenditionId}.
 */
import type { TextDirection } from "../../core/accessibility/accessibility-semantics.js";
import type {
  ComponentPdfDefinition,
  ComponentRenderer,
  PdfRenditionDeclaration,
  TranslationCatalog
} from "../../core/schema/contracts.js";
import type { FormTranslations } from "../../core/localization/translations.js";
import type { FileAttachment } from "../../core/schema/file-upload.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { ComponentRegistry } from "../../registry/components/component-registry.js";
import type { PdfRenditionRegistry } from "../../registry/pdf/pdf-rendition-registry.js";
import type { RenderComponentModel } from "../core/component-model.js";
import type { PdfAttachmentRelationship, PdfBlock, PdfImageResource } from "./pdf-document.js";
import type { PdfComponentStyle, ResolvedPdfTheme } from "./pdf-theme.js";
import type { PdfFormattedValue } from "./pdf-values.js";
import { BUILT_IN_PDF_RENDITIONS, GENERIC_PDF_RENDITION_ID } from "./standard-renditions.js";

/** What a `pdf-field` binding may say about how its component is drawn. */
export interface PdfBindingOptions {
  rendition?: string;
  /** A label to draw instead of the component's own; `false` draws none. */
  label?: string | false;
  /**
   * The AcroForm field name a `field` rendition uses. Default: the component's value path,
   * prefixed inside a repeat by the collection path and row (`items[0].email`); a name set
   * here is used as-is, with no row prefix.
   */
  widgetName?: string;
  style?: PdfComponentStyle;
  /**
   * For a `file` component: embed its uploaded files here. `undefined` follows the
   * instance's own `pdf.attach`; a boolean is the binding's decision either way.
   */
  attach?: boolean;
}

/** The words a rendition may need, resolved for the locale. */
export interface PdfRenditionTexts {
  yes: string;
  no: string;
  empty: string;
  /** The required marker after a label; `""` draws none. */
  required: string;
  /** The step tag above a step's heading ("Step {{n}} of {{total}}"); `""` draws none. */
  stepOf: string;
  /** The alt text of an unlabelled signature image. */
  signatureAlt?: string;
}

export interface PdfRenditionContext {
  model: RenderComponentModel;
  /** The value formatted for paper (option labels, file names, yes/no). */
  value: PdfFormattedValue;
  /** The label to draw, binding override applied; `undefined` means draw none. */
  label: string | undefined;
  binding: PdfBindingOptions;
  /** The theme's style for this type, binding style merged over it. */
  style: PdfComponentStyle;
  theme: ResolvedPdfTheme;
  texts: PdfRenditionTexts;
  locale: string;
  /**
   * The definition's own translations and the host's catalog, for the rare text a rendition
   * still meets raw — a tab's caption, read from the container's configuration rather than a
   * component model. Pass them with {@link locale} to `resolveText` at the text's address, as
   * the HTML shells do.
   */
  translations?: FormTranslations | undefined;
  translationCatalog?: TranslationCatalog | undefined;
  textDirection: TextDirection;
  /** The AcroForm field name a `field` rendition should use. */
  fieldName: string;
  /** Heading level a container's own heading takes here (2 at the top of the body). */
  headingLevel: number;
  /** A fresh block id, unique within the document. */
  nextId(suffix?: string): string;
  warn(code: string, message: string): void;
  /**
   * The blocks of a container component's children — one slot's, or every slot's in declared
   * order — rendered through their own renditions. Empty for a leaf.
   */
  children(slotId?: string): PdfBlock[];
  /** The child slot ids a container component occupies, in declared order. */
  slotIds(): string[];
  /**
   * For a component with a collection: its rows as the state holds them, each keyed by its
   * fields' keys within an entry — read a field's cell as `row[field.rowKey ?? field.id]`,
   * since a field with a data key is not stored under its id.
   */
  rows(): Array<Record<string, unknown>>;
  /** For a component with a collection: the leaf fields of one row, in authored order. */
  rowFields(): RenderComponentModel[];
  /** Formats another component's value the way {@link value} was formatted. */
  format(model: RenderComponentModel, value: unknown): PdfFormattedValue;
  /** Registers an image for the document and returns its resource id. */
  addImage(resource: PdfImageResource): string;
  /**
   * Queues an uploaded file for embedding as an associated file, the budget and
   * the document's dedupe applied. Default description: the label; default relationship:
   * `Supplement`. A plugin rendition's way to attach what it draws.
   */
  addAttachment(file: FileAttachment, options?: { description?: string; relationship?: PdfAttachmentRelationship }): void;
}

export type PdfRenditionRenderer = (node: ComponentNode, context: PdfRenditionContext) => PdfBlock[];

/** Narrows a declaration's `ComponentRenderer` to the PDF signature. */
export function asPdfRenderer(render: ComponentRenderer): PdfRenditionRenderer {
  return (node, context) => {
    const out = render(node, context);
    return Array.isArray(out) ? (out as PdfBlock[]) : [];
  };
}

export interface PdfRenditionResolver {
  /** Every rendition a type offers, definition first, then plugins, then built-ins; ids unique. */
  catalog(type: string): PdfRenditionDeclaration[];
  resolve(type: string, renditionId: string): PdfRenditionDeclaration | undefined;
  /**
   * The type's own default: definition, built-in table — or, for a type known
   * only through plugin contributions (one registered into the sandboxed program for a custom
   * component), the first contributed.
   */
  defaultRenditionId(type: string): string | undefined;
}

export interface PdfRenditionResolverOptions {
  components?: ComponentRegistry | undefined;
  renditions?: PdfRenditionRegistry | undefined;
  /** The engine's table by default; a host may extend or replace it. */
  builtIns?: Record<string, ComponentPdfDefinition> | undefined;
}

export function createPdfRenditionResolver(options: PdfRenditionResolverOptions = {}): PdfRenditionResolver {
  const builtIns = options.builtIns ?? BUILT_IN_PDF_RENDITIONS;
  const catalogCache = new Map<string, PdfRenditionDeclaration[]>();

  const definitionFor = (type: string) => {
    try {
      return options.components?.resolve(type);
    } catch {
      return undefined;
    }
  };

  const catalog = (type: string): PdfRenditionDeclaration[] => {
    const cached = catalogCache.get(type);
    if (cached) {
      return cached;
    }
    const seen = new Set<string>();
    const out: PdfRenditionDeclaration[] = [];
    const add = (declaration: PdfRenditionDeclaration): void => {
      if (seen.has(declaration.id)) {
        return;
      }
      seen.add(declaration.id);
      out.push(declaration);
    };
    const definition = definitionFor(type);
    for (const declaration of definition?.pdf?.renditions ?? []) {
      add(declaration);
    }
    for (const declaration of options.renditions?.list(type) ?? []) {
      add(declaration);
    }
    for (const declaration of builtIns[type]?.renditions ?? []) {
      add(declaration);
    }
    catalogCache.set(type, out);
    return out;
  };

  return {
    catalog,
    resolve(type, renditionId) {
      return catalog(type).find((declaration) => declaration.id === renditionId);
    },
    defaultRenditionId(type) {
      const definition = definitionFor(type);
      if (definition?.pdf?.defaultRendition) {
        return definition.pdf.defaultRendition;
      }
      return builtIns[type]?.defaultRendition ?? options.renditions?.list(type)[0]?.id;
    }
  };
}

/** The candidates for one bound component, one per rung of the ladder. */
export interface PdfRenditionChoice {
  type: string;
  /** `pdf-field.configuration.rendition`. */
  binding?: string | undefined;
  /** The form component's `configuration.pdf.rendition`. */
  instance?: string | undefined;
  /** `layout.renditionDefaults`, keyed by type with `"*"` as the wildcard. */
  layoutDefaults?: Record<string, string> | undefined;
  /** The theme's choice for this type, and its wildcard. */
  theme?: string | undefined;
  themeWildcard?: string | undefined;
}

/**
 * Which rendition a bound component takes: the binding, the instance, the
 * layout's defaults for the type then for `"*"`, the theme's choice for the type then for
 * `"*"`, the type's own default. A candidate named *for this type* that the type does not offer
 * is skipped with a `rendition.unknown` warning rather than failing the document; a wildcard
 * that does not apply to the type (`"*": "field"` meeting a container) is skipped quietly,
 * because the wildcard is an instruction to those it fits. `undefined` when nothing applies —
 * the caller then uses the generic rendition, so every component prints somehow.
 */
export function resolveRenditionId(
  choice: PdfRenditionChoice,
  resolver: PdfRenditionResolver,
  warn?: (code: string, message: string) => void
): string | undefined {
  const rungs: Array<[string, string | undefined, boolean]> = [
    ["binding", choice.binding, true],
    ["instance", choice.instance, true],
    ["layout", choice.layoutDefaults?.[choice.type], true],
    ["layout", choice.layoutDefaults?.["*"], false],
    ["theme", choice.theme, true],
    ["theme", choice.themeWildcard, false],
    ["definition", resolver.defaultRenditionId(choice.type), true]
  ];
  for (const [rung, candidate, named] of rungs) {
    if (candidate === undefined || candidate === "") {
      continue;
    }
    if (resolver.resolve(choice.type, candidate)) {
      return candidate;
    }
    if (named) {
      warn?.(
        "rendition.unknown",
        `The ${rung} asks for rendition "${candidate}" on a "${choice.type}" component, which offers none by that id.`
      );
    }
  }
  return undefined;
}

/** The generic rendition every type falls back to. */
export { GENERIC_PDF_RENDITION_ID };
