/**
 * The layout a form gets when it declares none: the semantic
 * reinterpretation of the form tree for paper. Tabs and wizard steps become sequential
 * sections, a grid becomes a borderless table with its columns' fields side by side, a
 * collection stays bound as one component (its rendition draws the table; a data grid
 * is such a collection and takes no case of its own), buttons (and the
 * button groups around them) are dropped, and every other component is bound as it is. The result is an ordinary generated
 * layout — the same document a person could have authored — so a form owner can start from
 * it in the designer rather than from nothing.
 *
 * Pure and deterministic: the same tree always yields the same layout, ids included.
 */
import type { LocalizedText } from "../../core/schema/contracts.js";
import { resolveLocalizedText } from "../../core/localization/localized-text.js";
import { resolveText, type FormTranslations, type TextAddress, type TextSources, type TranslationCatalog } from "../../core/localization/translations.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { BUTTON_COMPONENT_TYPE } from "../../core/schema/button.js";
import { BUTTON_GROUP_COMPONENT_TYPE } from "../../core/schema/button-group.js";
import { normalizeDataGrids } from "../../core/schema/data-grid.js";
import {
  PDF_DOCUMENT_BODY_SLOT,
  PDF_DOCUMENT_COMPONENT_TYPE,
  PDF_DOCUMENT_FOOTER_SLOT,
  PDF_DOCUMENT_HEADER_SLOT,
  PDF_FIELD_COMPONENT_TYPE,
  PDF_SECTION_COMPONENT_TYPE,
  PDF_TABLE_COMPONENT_TYPE,
  PDF_TEXT_COMPONENT_TYPE,
  pdfTableSlotId,
  type PdfGeneratedLayout
} from "../../core/schema/pdf-layout.js";
import { STEP_COMPONENT_TYPE, STEPS_COMPONENT_TYPE } from "../../core/schema/steps.js";
import { LAYOUT_CONTAINER_TYPES } from "../../registry/engine-component-types.js";
import { readLegendMark } from "../../core/schema/legend-mark.js";
import { TABS_COMPONENT_TYPE, configuredSlotIds, readTabDescriptors } from "../core/tab-slots.js";
import { createFormTextResolver } from "../../core/localization/form-texts.js";
import { hasPlaceholders } from "../../core/text/placeholders.js";
import { DEFAULT_PDF_TEXTS } from "./pdf-theme.js";

export const DEFAULT_PDF_LAYOUT_ID = "default";

/** The titled container the engine draws as a panel on screen; it keeps its own rendition on paper. */
const PANEL_COMPONENT_TYPE = "panel";

export interface DefaultPdfLayoutOptions {
  id?: string;
  /**
   * The form's title, drawn as the first heading and in the footer, as it is to read (a host's
   * own wording of it, already in the language asked for). Absent: the root's `configuration.title`,
   * worded through the translations below.
   */
  title?: string | undefined;
  /**
   * The language the layout's texts are worded in, with the form's own translations and the
   * host's catalog. The derived layout is made for one render, so the texts it carries
   * are already in that language: they come from the form's components, whose translations live
   * under `components`, not from a layout of the `pdf` kind. Absent: the form's default language,
   * which is what the designer starts a layout from.
   */
  locale?: string | undefined;
  translations?: FormTranslations | undefined;
  translationCatalog?: TranslationCatalog | undefined;
  /** Leave the running footer (title, page numbers) out. */
  noFooter?: boolean;
  /**
   * The footer band's height in points. The engine sizes it to the theme's small type and
   * table padding when it derives the layout for a document; the default suits the kernel's
   * own type.
   */
  footerHeight?: number | undefined;
  /**
   * The footer's page-count wording (the PDF theme's `pageOf`, `{{page}}` and `{{pages}}`
   * filled when the page is drawn); absent, the engine's own.
   */
  pageOf?: LocalizedText | undefined;
}

function readConfig(node: ComponentNode): Record<string, unknown> {
  const configuration = node.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration)
    ? (configuration as Record<string, unknown>)
    : {};
}

/** A text the form authors, in the language asked for: the string in the default language, worded through the translations at `address`. */
type FormWords = (authored: unknown, address: TextAddress) => string | undefined;

/** A container's heading: its label, unless the author hid it (`hideLabel`), as the form hides it on screen. */
function readLabel(node: ComponentNode, words: FormWords): string | undefined {
  const config = readConfig(node);
  return config.hideLabel === true ? undefined : words(config.label, { kind: "components", owner: node.id, path: ["label"] });
}

/**
 * The form's title as a text block prints it: literally. A title is the form's words, never a
 * template, so one that reads like a placeholder (`Form {{ref}}`) is carried as a literal
 * expression, which prints as written rather than reading an answer; any other is plain text.
 */
function titleText(title: string): { text: string } | { expression: { kind: "literal"; value: string } } {
  return hasPlaceholders(title) ? { expression: { kind: "literal", value: title } } : { text: title };
}

function slotsOf(node: ComponentNode): Array<[string, ComponentNode[]]> {
  const children = node.children ?? {};
  const declared = configuredSlotIds(node);
  const order = declared ? [...declared, ...Object.keys(children).filter((id) => !declared.includes(id))] : Object.keys(children);
  return order.map((slotId) => [slotId, children[slotId] ?? []]);
}

function isContainer(node: ComponentNode): boolean {
  return !!node.children && Object.keys(node.children).length > 0;
}

/** Derives the paper layout of a form tree. */
export function deriveDefaultPdfLayout(authored: ComponentNode, options: DefaultPdfLayoutOptions = {}): PdfGeneratedLayout {
  const locale = options.locale;
  const sources: TextSources = { translations: options.translations, catalog: options.translationCatalog };
  const words: FormWords = (authored, address) => {
    if (typeof authored !== "string" || authored.length === 0) {
      return undefined;
    }
    return locale === undefined ? authored : resolveText(authored, address, locale, sources);
  };
  // The engine's own wording (an untitled tab's "Tab 2"), in the language asked for.
  const engineText = createFormTextResolver(locale ?? "en", undefined, options.translationCatalog, undefined, { translations: options.translations });
  // A tree handed over raw (a builder's, before its controller read it) may hold a grid with no
  // collection binding; it is bound at its id, so the grid binds below as any
  // collection does. The same tree when it holds none.
  const root = normalizeDataGrids(authored);
  const ids = new Set<string>();
  const unique = (candidate: string): string => {
    let id = candidate;
    let n = 2;
    while (ids.has(id)) {
      id = `${candidate}-${n}`;
      n += 1;
    }
    ids.add(id);
    return id;
  };

  const binding = (node: ComponentNode): ComponentNode => ({
    id: unique(`pdf-${node.id}`),
    type: PDF_FIELD_COMPONENT_TYPE,
    configuration: { componentId: node.id }
  });

  const section = (node: ComponentNode, label: string | undefined, content: ComponentNode[], step?: { index: number; total: number }): ComponentNode => {
    // A fieldset's legend mark travels to its section, so the heading carries the theme's required word as the legend does.
    const legendMark = step === undefined ? readLegendMark(node.configuration) : undefined;
    return {
      id: unique(`sec-${node.id}`),
      type: PDF_SECTION_COMPONENT_TYPE,
      // Skipped when nothing in it prints: a container a rule hides leaves no orphan heading.
      // A wizard's step keeps its place, so the theme's step line ("Step 2 of 3") can head it.
      configuration: { ...(label !== undefined ? { label } : { hideLabel: true }), skipWhenEmpty: true, ...(step ? { step } : {}), ...(legendMark !== undefined ? { legendMark } : {}) },
      children: { content }
    };
  };

  const convertChildren = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap((child) => convert(child));

  const convert = (node: ComponentNode): ComponentNode[] => {
    if (node.type === BUTTON_COMPONENT_TYPE) {
      return [];
    }
    // A button group is its children in place, never a section: its buttons print
    // nothing, so it leaves nothing behind — and neither it nor they reach the kernel.
    if (node.type === BUTTON_GROUP_COMPONENT_TYPE) {
      return convertChildren(slotsOf(node).flatMap(([, children]) => children));
    }
    // A collection is one bound component: its rendition draws the rows as a table.
    if (node.collection) {
      return [binding(node)];
    }
    if (!isContainer(node)) {
      return [binding(node)];
    }
    if (node.type === TABS_COMPONENT_TYPE) {
      const descriptors = readTabDescriptors(node);
      const tabs = slotsOf(node).map(([slotId, children], index) => {
        const descriptor = descriptors.find((tab) => tab.id === slotId);
        // A tab is worded under its container, by the tab's id (the slot), never its place.
        const caption = words(descriptor?.label, { kind: "components", owner: node.id, path: ["tabs", slotId, "label"] });
        // An untitled tab is named by the label of the `tab` component that is its whole content,
        // when the author gave it one, else by its place ("Tab 2"): never its slot id, as on screen.
        const lone = children.length === 1 && children[0]?.type === "tab" ? children[0] : undefined;
        const own = lone ? words(readConfig(lone).label, { kind: "components", owner: lone.id, path: ["label"] }) : undefined;
        return section({ ...node, id: `${node.id}-${slotId}` }, caption ?? own ?? engineText("tabFallback", { n: index + 1 }), convertChildren(children));
      });
      const label = readLabel(node, words);
      return label !== undefined ? [section(node, label, tabs)] : tabs;
    }
    if (LAYOUT_CONTAINER_TYPES.has(node.type)) {
      const slots = slotsOf(node);
      if (slots.length <= 1) {
        return convertChildren(slots.flatMap(([, children]) => children));
      }
      const cells: Record<string, ComponentNode[]> = {};
      slots.forEach(([, children], index) => {
        cells[pdfTableSlotId(1, index + 1)] = convertChildren(children);
      });
      const table: ComponentNode = {
        id: unique(`tbl-${node.id}`),
        type: PDF_TABLE_COMPONENT_TYPE,
        configuration: { rows: 1, columns: slots.length, header: false, borders: "none", skipWhenEmpty: true },
        children: cells
      };
      const label = readLabel(node, words);
      return label !== undefined ? [section(node, label, [table])] : [table];
    }
    if (node.type === STEPS_COMPONENT_TYPE) {
      // A wizard: one section per step, each knowing its place among the steps.
      const steps = slotsOf(node).flatMap(([, children]) => children).filter((child) => child.type === STEP_COMPONENT_TYPE);
      const converted = slotsOf(node).flatMap(([, children]) =>
        children.flatMap((child) => {
          const index = steps.indexOf(child);
          if (index < 0) {
            return convert(child);
          }
          const stepContent = convertChildren(slotsOf(child).flatMap(([, grandchildren]) => grandchildren));
          return [section(child, readLabel(child, words), stepContent, { index: index + 1, total: steps.length })];
        })
      );
      const label = readLabel(node, words);
      return label !== undefined ? [section(node, label, converted)] : converted;
    }
    if (node.type === PANEL_COMPONENT_TYPE) {
      // A panel stays the component it is: its rendition — a titled box under a theme that says so,
      // else a heading and its children — draws it, and nothing when its fields are all hidden.
      return [binding(node)];
    }
    // A fieldset, step, data-scoping container: a section when it has a heading, else its children in place.
    const content = convertChildren(slotsOf(node).flatMap(([, children]) => children));
    const label = readLabel(node, words);
    return label !== undefined ? [section(node, label, content)] : content;
  };

  const title = options.title ?? words(readConfig(root).title, { kind: "form", path: ["title"] });
  const body: ComponentNode[] = [];
  if (title !== undefined) {
    body.push({
      id: unique("title"),
      type: PDF_TEXT_COMPONENT_TYPE,
      configuration: { ...titleText(title), variant: "h1" }
    });
  }
  body.push(...convertChildren(slotsOf(root).flatMap(([, children]) => children)));

  // The running footer: the form's title at the start and the page count at the end, in the
  // small type — the title block's other half; a form with no title keeps the count centred.
  const noSpacing = { spacingBefore: 0, spacingAfter: 0 };
  const pages: ComponentNode = {
    id: unique("footer-pages"),
    type: PDF_TEXT_COMPONENT_TYPE,
    // The theme's wording is host data (a `LocalizedText`): worded for the language here, since a layout's own texts are strings.
    configuration: { text: resolveLocalizedText(options.pageOf ?? DEFAULT_PDF_TEXTS.pageOf, locale ?? ""), variant: "muted", align: title !== undefined ? "end" : "center", style: noSpacing }
  };
  const footer: ComponentNode[] = options.noFooter
    ? []
    : title !== undefined
      ? [
          {
            id: unique("footer"),
            type: PDF_TABLE_COMPONENT_TYPE,
            // No flow spacing inside a band: the table sits flush in the footer's box.
            configuration: { rows: 1, columns: 2, header: false, borders: "none", style: { spacingBefore: 0, spacingAfter: 0 } },
            children: {
              [pdfTableSlotId(1, 1)]: [
                { id: unique("footer-title"), type: PDF_TEXT_COMPONENT_TYPE, configuration: { ...titleText(title), variant: "muted", style: noSpacing } }
              ],
              [pdfTableSlotId(1, 2)]: [pages]
            }
          }
        ]
      : [pages];

  return {
    id: options.id ?? DEFAULT_PDF_LAYOUT_ID,
    kind: "generated",
    ...(title !== undefined ? { name: title } : {}),
    page: footer.length > 0 ? { footer: { height: options.footerHeight ?? 24 } } : {},
    root: {
      id: "document",
      type: PDF_DOCUMENT_COMPONENT_TYPE,
      configuration: {},
      children: {
        [PDF_DOCUMENT_BODY_SLOT]: body,
        [PDF_DOCUMENT_HEADER_SLOT]: [],
        [PDF_DOCUMENT_FOOTER_SLOT]: footer
      }
    }
  };
}
