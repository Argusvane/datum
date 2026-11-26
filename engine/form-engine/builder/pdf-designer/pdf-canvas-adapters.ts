/**
 * The PDF layout tree's design-time faces on the builder canvas, as adapters of the
 * live renderer: the canvas draws a layout tree through `<datum-form-renderer>` under
 * the designer's binding ({@link createPdfDesignerBinding}: Datum's look with the sheet's rules),
 * and these adapters are what each PDF type draws there. The builder lays them over the binding
 * (`canvasComponents`), so the controller's definitions carry no drawing of their own.
 *
 * - The document root draws the page-shaped sheet: its header and footer bands and the body, each
 *   a slot the renderer drew (an empty one draws the canvas's drop zone). The renderer wraps
 *   every container in its own `data-container-id` element, so no face writes one.
 * - A section, a table, a repeat and a box draw their frame around the slots they hold.
 * - A `pdf-field` draws a chip naming the bound component and its rendition, over the bound
 *   component's own read-only drawing (`fieldPreview`, a {@link renderFieldPreview} element the
 *   designer built over the sample answers), or a placeholder when there is none.
 * - Text, a rule, a spacer, an image, a signature block and a page break draw their stand-ins.
 *
 * Every face reads its node's configuration from the render model (`state.model.node`) and its
 * words from the builder's catalog (`texts`); a node's own text (a section's label, a text block)
 * is worded at `pdf › layoutId › nodes › <node id> › <property>`. Nothing here writes a
 * state hook or the DOM contract: the renderer's wrapper carries both.
 *
 * In the PDF designer's chunk; nothing here runs at import.
 */
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { addressOf, resolveText, type FormTranslations } from "../../core/localization/translations.js";
import {
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
  pdfPageDimensions,
  pdfTableRowSlotIds,
  readPdfBoxAnchor,
  readPdfTableSpec,
  resolvePdfPageSetup
} from "../../core/schema/pdf-layout.js";
import type { PdfBindableCollection, PdfBindableComponent, PdfComponentText } from "../../render/pdf/pdf-components.js";
import { PDF_DESIGNER_CSS, PDF_DESIGNER_THEME_ID } from "../../render/pdf/pdf-designer-styles.js";
import { readColor } from "../../render/pdf/pdf-render-model.js";
import type { AdapterEntry, FieldAdapter, FieldState, GroupAdapter, GroupState, LiveBinding, View } from "../../render/live/contract.js";
import { createDatumBinding } from "../../render/live/datum/options.js";
import { html, ifDefined, nothing, type TemplateResult } from "../../render/live/lit.js";
import { builderText } from "./pdf-texts-en.js";

/** The faces' words in English, from the designer's table, for a caller that hands none. */
const english: PdfComponentText = (key, params) => builderText(key, params);

export interface PdfCanvasOptions {
  /** The form's components a `pdf-field` may bind: a bound field's chip names its label. */
  formComponents?: readonly PdfBindableComponent[] | undefined;
  /** The form's collections: a table or a repeat over a path that names none says so. Absent: not checked. */
  collections?: readonly PdfBindableCollection[] | undefined;
  /** A bound component's read-only drawing, read at each draw; `undefined` shows a placeholder. */
  fieldPreview?: ((componentId: string) => HTMLElement | undefined) | undefined;
  /** The builder's words, in its locale; English when absent. */
  texts?: PdfComponentText | undefined;
  /** The locale a node's own text is worded in. Default `"en"`. */
  locale?: string | undefined;
  /**
   * The definition's own translations and the layout the canvas draws: a face words a
   * node's text at `pdf › layoutId › nodes › <node id> › <property>`. Without a `layoutId` the
   * faces show the authored string, which is what a layout not yet in a form has.
   */
  translations?: FormTranslations | undefined;
  layoutId?: string | undefined;
  /** The host's translation catalog; an entry there wins over the definition's, as at render time. */
  translationCatalog?: TranslationCatalog | undefined;
}

function readConfig(node: ComponentNode | undefined): Record<string, unknown> {
  const configuration = node?.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>) : {};
}

/** How a face reads one text of a layout node: the authored string, worded for the canvas's locale. */
type NodeWords = (node: ComponentNode, property: string) => string | undefined;

function nodeWords(options: PdfCanvasOptions): NodeWords {
  const locale = options.locale ?? "en";
  const { layoutId } = options;
  return (node, property) => {
    const authored = readConfig(node)[property];
    if (typeof authored !== "string") {
      return undefined;
    }
    return layoutId === undefined
      ? authored
      : resolveText(authored, addressOf.pdf(layoutId, ["nodes", node.id, property]), locale, {
          translations: options.translations,
          catalog: options.translationCatalog
        });
  };
}

/** A container's node as the render model holds it; a bare one when the renderer gave none. */
function groupNode(state: GroupState): ComponentNode {
  return state.model?.node ?? { id: state.id, type: state.type, configuration: {} };
}

/** One slot's drawing, or nothing when the container has no such slot. */
function slotOf(state: GroupState, slotId: string): View {
  return state.slots.find((slot) => slot.slotId === slotId)?.content ?? nothing;
}

/** Template placeholders as chips, the rest as text. */
function templateText(textValue: string): TemplateResult {
  return html`${textValue
    .split(/(\{\{[^{}]+\}\})/g)
    .filter((part) => part !== "")
    .map((part) => (/^\{\{[^{}]+\}\}$/.test(part) ? html`<span class="datum-pdf-token">${part}</span>` : part))}`;
}

/** True when the form is known (a collections list was given) and the path names none of its collections. */
function collectionMissing(options: PdfCanvasOptions, path: string): boolean {
  return options.collections !== undefined && !options.collections.some((collection) => collection.path === path);
}

function group(name: string, template: (state: GroupState) => TemplateResult): GroupAdapter {
  return { kind: "group", name, template: (state) => template(state) };
}

function leaf(name: string, template: (state: FieldState) => TemplateResult): FieldAdapter {
  return { kind: "field", name, template: (state) => template(state) };
}

// ── Containers ─────────────────────────────────────────────────────────────────────────────

function documentFace(t: PdfComponentText): GroupAdapter {
  return group("pdf-document", (state) => {
    const config = readConfig(groupNode(state));
    const setup = resolvePdfPageSetup(config.page);
    const { width, height } = pdfPageDimensions(setup);
    const fraction = (points: number): string => (points / width).toFixed(4);
    const band = (slotId: string, points: number | undefined, extra: "header" | "footer"): TemplateResult =>
      html`<div class="datum-pdf-page__band datum-pdf-page__band--${extra}" style=${`--datum-pdf-band:${fraction(points ?? 0)}`}><span class="datum-pdf-page__band-label"
          >${t(extra === "header" ? "pdfComponent.face.header" : "pdfComponent.face.footer")}</span
        >${slotOf(state, slotId)}</div>`;
    const style = [
      `--datum-pdf-ratio:${(height / width).toFixed(4)}`,
      `--datum-pdf-margin-top:${fraction(setup.margins.top)}`,
      `--datum-pdf-margin-right:${fraction(setup.margins.right)}`,
      `--datum-pdf-margin-bottom:${fraction(setup.margins.bottom)}`,
      `--datum-pdf-margin-left:${fraction(setup.margins.left)}`
    ].join(";");
    return html`<div class="datum-pdf-sheet"><div class="datum-pdf-page" style=${style}>${band(PDF_DOCUMENT_HEADER_SLOT, setup.header?.height, "header")}<div class="datum-pdf-page__body"
          >${slotOf(state, PDF_DOCUMENT_BODY_SLOT)}</div
        >${band(PDF_DOCUMENT_FOOTER_SLOT, setup.footer?.height, "footer")}</div></div>`;
  });
}

function sectionFace(words: NodeWords): GroupAdapter {
  return group("pdf-section", (state) => {
    const node = groupNode(state);
    const label = words(node, "label");
    return html`<section class="datum-pdf-section">${label && readConfig(node).hideLabel !== true ? html`<div class="datum-pdf-section__heading">${label}</div>` : nothing}${slotOf(state, "content")}</section>`;
  });
}

function tableFace(options: PdfCanvasOptions, t: PdfComponentText): GroupAdapter {
  return group("pdf-table", (state) => {
    const configuration = groupNode(state).configuration;
    const spec = readPdfTableSpec(configuration);
    const total = spec.widths ? spec.widths.reduce((a, b) => a + b, 0) : 0;
    const rows: TemplateResult[] = [];
    for (let row = 1; row <= spec.rows; row += 1) {
      const cells = pdfTableRowSlotIds(configuration, row).map((slotId, index) => {
        const width = spec.widths && total > 0 ? `width:${(((spec.widths[index] ?? 0) / total) * 100).toFixed(2)}%` : undefined;
        return html`<td data-cell=${slotId} style=${ifDefined(width)}>${slotOf(state, slotId)}</td>`;
      });
      rows.push(html`<tr class=${ifDefined(spec.header && row === 1 ? "datum-pdf-table__header" : undefined)}>${cells}</tr>`);
    }
    const path = spec.collectionPath;
    const missing = path !== undefined && collectionMissing(options, path);
    const caption = path
      ? html`<caption class=${missing ? "datum-pdf-table__caption datum-pdf-table__caption--unbound" : "datum-pdf-table__caption"}>${t(missing ? "pdfComponent.face.tableUnbound" : "pdfComponent.face.tableRepeats", { path })}</caption>`
      : nothing;
    return html`<table class="datum-pdf-table datum-pdf-table--${spec.borders}">${caption}<tbody>${rows}</tbody></table>`;
  });
}

function repeatFace(options: PdfCanvasOptions, t: PdfComponentText): GroupAdapter {
  return group("pdf-repeat", (state) => {
    const config = readConfig(groupNode(state));
    const path = typeof config.collectionPath === "string" && config.collectionPath.trim() !== "" ? config.collectionPath : undefined;
    const chip = path
      ? collectionMissing(options, path)
        ? html`<span class="datum-pdf-chip datum-pdf-field__chip--unbound">${t("pdfComponent.face.repeatUnbound", { path })}</span>`
        : html`<span class="datum-pdf-chip">${t("pdfComponent.face.repeatEach", { path })}</span>`
      : html`<span class="datum-pdf-chip datum-pdf-field__chip--unbound">${t("pdfComponent.face.repeatNone")}</span>`;
    return html`<div class="datum-pdf-repeat">${chip}${slotOf(state, "row")}</div>`;
  });
}

function boxFace(t: PdfComponentText): GroupAdapter {
  return group("pdf-box", (state) => {
    const node = groupNode(state);
    const config = readConfig(node);
    const anchor = readPdfBoxAnchor(node.configuration);
    // Colours reach the style only as `#rgb`-style hex (readColor), so nothing can break out of the declaration.
    const border = config.border !== false ? `${typeof config.borderWidth === "number" ? config.borderWidth : 0.75}px solid ${readColor(config.borderColor) ?? "#999999"}` : "0";
    const fill = readColor(config.fill);
    const padding = typeof config.padding === "number" && Number.isFinite(config.padding) ? config.padding : 6;
    const style = `border:${border};${fill ? `background:${fill};` : ""}padding:${padding}px`;
    const chip = anchor
      ? html`<span class="datum-pdf-chip">${t("pdfComponent.face.boxPinned", { page: String(anchor.page), x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height })}</span>`
      : nothing;
    return html`<div class=${anchor ? "datum-pdf-box datum-pdf-box--anchored" : "datum-pdf-box"} style=${style}>${chip}${slotOf(state, "content")}</div>`;
  });
}

// ── Leaves ─────────────────────────────────────────────────────────────────────────────────

function fieldFace(options: PdfCanvasOptions, t: PdfComponentText): FieldAdapter {
  // Each `pdf-field` shows its own copy of the bound component's drawing (two may bind one
  // component), kept while the designer's drawing is the same one so a redraw keeps its nodes.
  const copies = new Map<string, { source: HTMLElement; copy: Node }>();
  const copyFor = (key: string, source: HTMLElement): Node => {
    const kept = copies.get(key);
    if (kept && kept.source === source) {
      return kept.copy;
    }
    const copy = source.cloneNode(true);
    copies.set(key, { source, copy });
    return copy;
  };
  return leaf("pdf-field", (state) => {
    const config = readConfig(state.model.node);
    const componentId = typeof config.componentId === "string" ? config.componentId : "";
    const rendition = typeof config.rendition === "string" && config.rendition !== "" ? config.rendition : "default";
    if (componentId === "") {
      copies.delete(state.key);
      return html`<div class="datum-pdf-field"><span class="datum-pdf-field__chip datum-pdf-field__chip--unbound">${t("pdfComponent.face.fieldNone")}</span><div class="datum-pdf-placeholder">${t(
        "pdfComponent.face.fieldPick"
      )}</div></div>`;
    }
    const bound = options.formComponents?.find((component) => component.id === componentId);
    const preview = options.fieldPreview?.(componentId);
    if (preview === undefined) {
      copies.delete(state.key);
    }
    const chip = html`<span class=${bound ? "datum-pdf-field__chip" : "datum-pdf-field__chip datum-pdf-field__chip--unbound"}>${
      bound ? t("pdfComponent.face.fieldBound", { label: bound.label, rendition }) : t("pdfComponent.face.fieldMissing", { id: componentId })
    }</span>`;
    const body =
      preview !== undefined
        ? html`<div class="datum-pdf-field__preview">${copyFor(state.key, preview)}</div>`
        : html`<div class="datum-pdf-placeholder">${bound ? `${bound.label} (${bound.type})` : componentId}</div>`;
    return html`<div class="datum-pdf-field" data-bound=${componentId} data-rendition=${rendition}>${chip}${body}</div>`;
  });
}

function textFace(t: PdfComponentText, words: NodeWords): FieldAdapter {
  return leaf("pdf-text", (state) => {
    const node = state.model.node;
    const config = readConfig(node);
    const variant = typeof config.variant === "string" ? config.variant : "body";
    const align = config.align === "center" || config.align === "end" ? ` datum-pdf-text--${config.align}` : "";
    const className = `datum-pdf-text datum-pdf-text--${variant}${align}`;
    const written = words(node, "text") ?? "";
    const body =
      config.expression && typeof config.expression === "object"
        ? html`<span class="datum-pdf-token" title=${JSON.stringify(config.expression)}>${t("pdfComponent.face.expression")}</span>`
        : written !== ""
          ? templateText(written)
          : " ";
    switch (variant) {
      case "h1":
        return html`<h1 class=${className}>${body}</h1>`;
      case "h2":
        return html`<h2 class=${className}>${body}</h2>`;
      case "h3":
        return html`<h3 class=${className}>${body}</h3>`;
      default:
        return html`<p class=${className}>${body}</p>`;
    }
  });
}

const ruleFace: FieldAdapter = leaf("pdf-rule", () => html`<hr class="datum-pdf-rule">`);

const spacerFace: FieldAdapter = leaf("pdf-spacer", (state) => {
  const height = readConfig(state.model.node).height;
  return html`<div class="datum-pdf-spacer" style=${`height:${typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 12}px`}></div>`;
});

function imageFace(t: PdfComponentText, words: NodeWords): FieldAdapter {
  return leaf("pdf-image", (state) => {
    const node = state.model.node;
    const config = readConfig(node);
    const src = typeof config.src === "string" ? config.src.trim() : "";
    const safe = /^(https?:\/\/|\/|\.\/|data:image\/(png|jpeg);base64,)/i.test(src);
    if (!safe) {
      return html`<div class="datum-pdf-placeholder">${t(src === "" ? "pdfComponent.face.imageNone" : "pdfComponent.face.imageUnsupported")}</div>`;
    }
    const width = typeof config.width === "number" && config.width > 0 ? String(Math.round(config.width * 1.333)) : undefined;
    return html`<img class="datum-pdf-image" src=${src} alt=${words(node, "alt") ?? ""} width=${ifDefined(width)}>`;
  });
}

/** A signature block: its caption over a boxed field name, or a line to sign on. */
function signatureFace(t: PdfComponentText, words: NodeWords): FieldAdapter {
  return leaf("pdf-signature", (state) => {
    const node = state.model.node;
    const config = readConfig(node);
    const caption = words(node, "label") ?? "";
    const captionView = caption ? html`<div class="datum-pdf-signature__label">${templateText(caption)}</div>` : nothing;
    if (config.mode === "line") {
      return html`<div class="datum-pdf-signature datum-pdf-signature--line">${captionView}<div class="datum-pdf-signature__rule"></div></div>`;
    }
    const fieldName = typeof config.fieldName === "string" && config.fieldName.trim() !== "" ? config.fieldName.trim() : node.id;
    const height = typeof config.height === "number" && config.height > 0 ? config.height : 40;
    const width = typeof config.width === "number" && config.width > 0 ? `width:${Math.round(config.width * 1.333)}px;` : "";
    return html`<div class="datum-pdf-signature">${captionView}<div class="datum-pdf-signature__box" style=${`height:${Math.round(height * 1.333)}px;${width}`}><span
          class="datum-pdf-signature__mark"
          >✎</span
        > ${t("pdfComponent.face.signatureField")} <span class="datum-pdf-chip">${fieldName}</span></div></div>`;
  });
}

function pageBreakFace(t: PdfComponentText): FieldAdapter {
  return leaf(
    "pdf-page-break",
    (state) => html`<div class="datum-pdf-break">${t(readConfig(state.model.node).changePage === true ? "pdfComponent.face.pageBreakChange" : "pdfComponent.face.pageBreak")}</div>`
  );
}

/** Every PDF layout type's face, the root's included, by type: what the canvas lays over its binding. */
export function pdfCanvasComponents(options: PdfCanvasOptions = {}): Record<string, AdapterEntry> {
  const t = options.texts ?? english;
  const words = nodeWords(options);
  return {
    [PDF_DOCUMENT_COMPONENT_TYPE]: documentFace(t),
    [PDF_SECTION_COMPONENT_TYPE]: sectionFace(words),
    [PDF_TABLE_COMPONENT_TYPE]: tableFace(options, t),
    [PDF_REPEAT_COMPONENT_TYPE]: repeatFace(options, t),
    [PDF_BOX_COMPONENT_TYPE]: boxFace(t),
    [PDF_FIELD_COMPONENT_TYPE]: fieldFace(options, t),
    [PDF_TEXT_COMPONENT_TYPE]: textFace(t, words),
    [PDF_RULE_COMPONENT_TYPE]: ruleFace,
    [PDF_SPACER_COMPONENT_TYPE]: spacerFace,
    [PDF_IMAGE_COMPONENT_TYPE]: imageFace(t, words),
    [PDF_SIGNATURE_COMPONENT_TYPE]: signatureFace(t, words),
    [PDF_PAGE_BREAK_COMPONENT_TYPE]: pageBreakFace(t)
  };
}

let designerBinding: LiveBinding | undefined;

/**
 * The binding the PDF designer's canvas draws under: Datum's look, with the sheet's rules
 * (`PDF_DESIGNER_CSS`) after its own. One per page; the faces come from {@link pdfCanvasComponents}.
 */
export function createPdfDesignerBinding(): LiveBinding {
  designerBinding ??= createDatumBinding({ id: PDF_DESIGNER_THEME_ID, label: "PDF designer", css: PDF_DESIGNER_CSS });
  return designerBinding;
}
