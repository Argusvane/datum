/**
 * The words of a form's PDF layouts as translatable texts: what the Languages
 * workspace lists under PDF — each layout's name, document title, attachment description and
 * signature reason, the headings and static text of a generated layout's body, and the text a
 * template's field or area is filled from. Pure over the `pdf` block, so the mode stays a thin
 * owner of its catalog.
 *
 * Every text is a plain string in the form's default language, kept in the layout; its
 * translations are the definition's map (`translations.ts`, kind `pdf`), which this module
 * never reads or writes. A text is addressed by the layout's own ids and property names, never an
 * index (`pdfTextAddress` below), and the table of paths is:
 *
 * - the layout: `name`, `accessibility › title`, `conformance › attachment › description`,
 *   `signature › reason`;
 * - a node of a generated layout: `nodes › <node id> › <property>` (`label` on a section, a
 *   field's label override and a signature's caption; `text`; `emptyText`; `alt`);
 * - a template's mapping: `fields › <AcroForm field name> › text`, `areas › <area id> › text`.
 *
 * Each layout is a group of its own, `pdf.<layoutId>`; a node is `pdf.<layoutId>.<nodeId>`; a
 * template's mappings `pdf.<layoutId>.fields` / `.areas`, the property path being
 * `<key>.source.text`. The group and path are how a row is named in the workspace; the address is
 * how the map keys it.
 */
import { setPathValue, type OutsideDefaultEdit, type OutsideText } from "../../core/localization/locale-documents.js";
import { isSafeSegment, resolveText, type FormTranslations, type TextAddress, type TextSources, type TranslationPrefix } from "../../core/localization/translations.js";
import { pdfFillTextAddress, pdfLayoutTextAddress, pdfNodeTextAddress } from "../../render/pdf/pdf-text-addresses.js";
import type { PdfConfiguration, PdfLayoutDocument } from "../../core/schema/pdf-layout.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { builderText, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import type { TranslatableText } from "../controller/builder-controller.js";
import type { RenamedTextId } from "../controller/translation-rules.js";
import type { BuilderCommand } from "../history/command-history.js";

/** The localized-text property each PDF component type declares in its inspector (render/pdf/pdf-components.ts). */
const NODE_TEXTS: Readonly<Record<string, ReadonlyArray<{ propertyPath: string; label: BuilderTextKey }>>> = {
  "pdf-section": [{ propertyPath: "label", label: "languages.pdf.heading" }],
  "pdf-text": [{ propertyPath: "text", label: "languages.pdf.text" }],
  "pdf-field": [{ propertyPath: "label", label: "languages.pdf.fieldLabel" }],
  "pdf-repeat": [{ propertyPath: "emptyText", label: "languages.pdf.emptyText" }],
  "pdf-image": [{ propertyPath: "alt", label: "languages.pdf.alt" }],
  "pdf-signature": [{ propertyPath: "label", label: "languages.pdf.caption" }]
};

/** The texts every layout kind carries on the layout itself. */
const LAYOUT_TEXTS: ReadonlyArray<{ propertyPath: string; label: BuilderTextKey }> = [
  { propertyPath: "name", label: "languages.pdf.name" },
  { propertyPath: "accessibility.title", label: "languages.pdf.title" },
  { propertyPath: "conformance.attachment.description", label: "languages.pdf.attachment" },
  { propertyPath: "signature.reason", label: "languages.pdf.reason" }
];

/** The suffix a template mapping's text sits under in the mapping itself. */
const FILL_SUFFIX = ".source.text";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readPath(owner: unknown, path: string): unknown {
  let cursor: unknown = owner;
  for (const part of path.split(".")) {
    if (!isRecord(cursor) && !Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** A node's configuration, `{}` when it has none. */
function configurationOf(node: ComponentNode): Record<string, unknown> {
  return isRecord(node.configuration) ? node.configuration : {};
}

/** Whether the map may hold the address (no unsafe segment, which a node id or a field name might be). */
function isKeyable(address: TextAddress): boolean {
  return isSafeSegment(address.owner) && address.path.every(isSafeSegment);
}

/** One text of a layout, with where it is kept in the layout and where its translations are. */
interface LayoutTextEntry {
  group: string;
  /** The row's label in the workspace's group heading, before the layout's name is added. */
  property: string;
  /** The inspector label's key. */
  label: BuilderTextKey | undefined;
  /** For a template fill: the mapping's name, for its label. */
  fillName?: string;
  address: TextAddress;
  default: string;
  /** The node the text sits on, for the group heading. */
  node?: ComponentNode;
  layout: PdfLayoutDocument;
}

/** Every text of every layout, written or not, in the order the layouts and their trees draw them. */
function layoutTextEntries(configuration: PdfConfiguration | undefined): LayoutTextEntry[] {
  const out: LayoutTextEntry[] = [];
  const add = (entry: LayoutTextEntry): void => {
    if (isKeyable(entry.address)) {
      out.push(entry);
    }
  };
  for (const layout of configuration?.layouts ?? []) {
    const group = `pdf.${layout.id}`;
    for (const entry of LAYOUT_TEXTS) {
      const value = readPath(layout, entry.propertyPath);
      add({ group, property: entry.propertyPath, label: entry.label, address: pdfLayoutTextAddress(layout.id, entry.propertyPath), default: typeof value === "string" ? value : "", layout });
    }
    if (layout.kind === "template") {
      for (const list of ["fields", "areas"] as const) {
        const mappings = list === "fields" ? layout.fields : (layout.areas ?? []);
        mappings.forEach((mapping, index) => {
          if (mapping.source.kind !== "template") {
            return;
          }
          const key = "pdfField" in mapping ? mapping.pdfField : mapping.id;
          add({
            group: `${group}.${list}`,
            property: `${key}${FILL_SUFFIX}`,
            label: undefined,
            fillName: "pdfField" in mapping ? mapping.pdfField : `${index + 1}`,
            address: pdfFillTextAddress(layout.id, list, key),
            default: typeof mapping.source.text === "string" ? mapping.source.text : "",
            layout
          });
        });
      }
      continue;
    }
    const visit = (node: ComponentNode): void => {
      for (const entry of NODE_TEXTS[node.type] ?? []) {
        const value = configurationOf(node)[entry.propertyPath];
        add({ group: `${group}.${node.id}`, property: entry.propertyPath, label: entry.label, address: pdfNodeTextAddress(layout.id, node.id, entry.propertyPath), default: typeof value === "string" ? value : "", node, layout });
      }
      for (const children of Object.values(node.children ?? {})) {
        children.forEach(visit);
      }
    };
    visit(layout.root);
  }
  return out;
}

/**
 * Every PDF layout text of `configuration` as the Languages workspace lists it: the group (the
 * layout, a node of it), the property, the inspector's name for it, the text in the default
 * language and the address its translations live at. `sources` word the layout's name in
 * `locale` for the group's heading.
 */
export function pdfLayoutTexts(configuration: PdfConfiguration | undefined, locale: string, sources: TextSources, text?: BuilderTextOptions): TranslatableText[] {
  const names = new Map<string, string>();
  const nameOf = (layout: PdfLayoutDocument): string => {
    let shown = names.get(layout.id);
    if (shown === undefined) {
      const worded = typeof layout.name === "string" ? resolveText(layout.name, pdfLayoutTextAddress(layout.id, "name"), locale, sources) : "";
      shown = worded.trim() !== "" ? worded : layout.id;
      names.set(layout.id, shown);
    }
    return shown;
  };
  return layoutTextEntries(configuration).map((entry) => {
    const groupLabel = builderText("languages.pdf.group", { name: nameOf(entry.layout) }, text);
    const componentLabel = entry.node
      ? `${groupLabel} · ${worded(entry.node, entry.property, locale, sources, entry.layout.id)}`
      : groupLabel;
    return {
      componentId: entry.group,
      componentLabel,
      propertyPath: entry.property,
      label: entry.label !== undefined ? builderText(entry.label, undefined, text) : builderText("languages.pdf.fill", { name: entry.fillName ?? entry.property }, text),
      default: entry.default,
      address: entry.address
    };
  });
}

/** What a node says in `locale`, for the group's heading; its id when it says nothing. */
function worded(node: ComponentNode, property: string, locale: string, sources: TextSources, layoutId: string): string {
  const authored = configurationOf(node)[property];
  const said = typeof authored === "string" ? resolveText(authored, pdfNodeTextAddress(layoutId, node.id, property), locale, sources) : "";
  return said.trim() !== "" ? said : node.id;
}

/** Every text of the layouts with its default, for the controller's Make default and Apply (`OutsideDocument.texts`). */
export function pdfOutsideTexts(configuration: PdfConfiguration | undefined): OutsideText[] {
  return layoutTextEntries(configuration).map((entry) => ({ address: entry.address, default: entry.default }));
}

/** Finds the node `id` below `node`. */
function findNode(node: ComponentNode, id: string): ComponentNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const children of Object.values(node.children ?? {})) {
    for (const child of children) {
      const found = findNode(child, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * `configuration` with the default strings of `edits` written (a copy: the input is untouched),
 * each at the place {@link pdfLayoutTexts} lists the address from. An edit whose layout, node or
 * mapping is no longer there, or that names a property no text sits at, is dropped; the input
 * itself comes back when nothing lands.
 */
export function setPdfLayoutDefaults(configuration: PdfConfiguration, edits: readonly OutsideDefaultEdit[]): PdfConfiguration {
  if (edits.length === 0) {
    return configuration;
  }
  const next = structuredClone(configuration);
  const layouts: PdfLayoutDocument[] = next.layouts ?? [];
  const layoutPaths = new Set(LAYOUT_TEXTS.map((entry) => entry.propertyPath));
  let landed = false;
  for (const { address, default: value } of edits) {
    if (address.kind !== "pdf" || address.owner === undefined) {
      continue;
    }
    const layout = layouts.find((entry) => entry.id === address.owner);
    if (!layout) {
      continue;
    }
    const path = address.path;
    if (layoutPaths.has(path.join("."))) {
      setPathValue(layout as unknown as Record<string, unknown>, path.join("."), value);
      landed = true;
    } else if (path[0] === "nodes" && path.length === 3 && layout.kind !== "template") {
      const node = findNode(layout.root, path[1]!);
      if (!node || !(NODE_TEXTS[node.type] ?? []).some((entry) => entry.propertyPath === path[2])) {
        continue;
      }
      const configuration: Record<string, unknown> = isRecord(node.configuration) ? node.configuration : {};
      node.configuration = configuration;
      setPathValue(configuration, path[2]!, value);
      landed = true;
    } else if ((path[0] === "fields" || path[0] === "areas") && path.length === 3 && path[2] === "text" && layout.kind === "template") {
      const mappings = path[0] === "fields" ? layout.fields : (layout.areas ?? []);
      const mapping = mappings.find((entry) => ("pdfField" in entry ? entry.pdfField : entry.id) === path[1]);
      if (mapping && mapping.source.kind === "template") {
        mapping.source = { kind: "template", text: value };
        landed = true;
      }
    }
  }
  return landed ? next : configuration;
}

/** The ids of a generated layout's nodes in reading order (the root first). */
function nodeIdsOf(layout: PdfLayoutDocument): string[] {
  if (layout.kind === "template") {
    return [];
  }
  const out: string[] = [];
  const visit = (node: ComponentNode): void => {
    out.push(node.id);
    for (const children of Object.values(node.children ?? {})) {
      children.forEach(visit);
    }
  };
  visit(layout.root);
  return out;
}

/** What an edit of a layout does to the addresses of its texts: what to prune and what to move. */
export interface LayoutTextChanges {
  prune: TranslationPrefix[];
  move: Array<{ from: TranslationPrefix; to: TranslationPrefix }>;
}

/**
 * What changing `before` into `after` (the same layout, edited in its designer) does to the
 * addresses its translations live at: a node, a field mapping or an area that is
 * gone takes its translations with it; a node whose id changed — the tree has the same shape
 * and exactly those ids differ, in place — takes them to its new id. A mapping whose fill text
 * is gone (its source is no longer a template) loses that text's entries too. Nothing in
 * `after` that `before` lacked is touched: a node added has no translation yet.
 */
export function layoutTextChanges(before: PdfLayoutDocument, after: PdfLayoutDocument): LayoutTextChanges {
  const owner = before.id;
  const changes: LayoutTextChanges = { prune: [], move: [] };
  const idsBefore = nodeIdsOf(before);
  const idsAfter = nodeIdsOf(after);
  const kept = new Set(idsAfter);
  const gone = idsBefore.filter((id) => !kept.has(id));
  const had = new Set(idsBefore);
  const added = idsAfter.filter((id) => !had.has(id));
  // A rename keeps the tree's shape: the same number of nodes, and every position whose id
  // differs holds an id that went at an id that came. Anything else is a deletion (and an add).
  const renamed = new Map<string, string>();
  if (gone.length > 0 && gone.length === added.length && idsBefore.length === idsAfter.length) {
    const goneSet = new Set(gone);
    const addedSet = new Set(added);
    const aligned = idsBefore.every((id, index) => id === idsAfter[index] || (goneSet.has(id) && addedSet.has(idsAfter[index]!)));
    if (aligned) {
      idsBefore.forEach((id, index) => {
        if (id !== idsAfter[index]) {
          renamed.set(id, idsAfter[index]!);
        }
      });
    }
  }
  for (const id of gone) {
    const to = renamed.get(id);
    if (to !== undefined) {
      changes.move.push({ from: { kind: "pdf", owner, path: ["nodes", id] }, to: { kind: "pdf", owner, path: ["nodes", to] } });
    } else {
      changes.prune.push({ kind: "pdf", owner, path: ["nodes", id] });
    }
  }
  // Fill texts of a template: an address that was listed before and is not now.
  const fillsAfter = new Set(layoutTextEntries({ layouts: [after] }).map((entry) => addressKey(entry.address)));
  for (const entry of layoutTextEntries({ layouts: [before] })) {
    if (entry.address.path[0] !== "nodes" && entry.address.path.length === 3 && (entry.address.path[0] === "fields" || entry.address.path[0] === "areas") && !fillsAfter.has(addressKey(entry.address))) {
      changes.prune.push({ kind: "pdf", owner, path: entry.address.path.slice(0, 2) });
    }
  }
  return changes;
}

function addressKey(address: TextAddress): string {
  return JSON.stringify([address.kind, address.owner, address.path]);
}

/** The definition's translations as the form's controller holds them now; `undefined` when it has none or is not there. */
export function formTranslationsOf(form: object | undefined): FormTranslations | undefined {
  return (form as FormTranslationsAccess | undefined)?.translations?.();
}

/**
 * Runs `rewrite` over the form's translations as one step of the form's history, when the
 * controller offers it. `alongside` is the layouts' block change composed into the same step and
 * `renamed` the re-keyed ids the change event announces (`BuilderController.rewriteTranslations`).
 * Whether a step was made: none when the map stays as it was.
 */
export function rewriteFormTranslations(
  form: object | undefined,
  rewrite: (map: FormTranslations) => FormTranslations,
  alongside?: BuilderCommand,
  renamed?: readonly RenamedTextId[]
): boolean {
  return (form as FormTranslationsAccess | undefined)?.rewriteTranslations?.(rewrite, alongside, renamed) === true;
}

/**
 * The map and how the mode reaches it. The definition's translations live on the form's
 * controller; the PDF mode reads them to word the canvas and the layout names, and rewrites them
 * (one step of the form's history) to prune or move addresses. Reached through this shape, as the
 * journeys mode reaches it, so a form controller that offers neither is simply left alone.
 */
export interface FormTranslationsAccess {
  translations?(): FormTranslations | undefined;
  rewriteTranslations?(rewrite: (map: FormTranslations) => FormTranslations, alongside?: BuilderCommand, renamed?: readonly RenamedTextId[]): boolean;
  /** A change the mode already made to its block, as a step of the form's history (`BuilderController.recordStep`). */
  recordStep?(command: BuilderCommand): void;
}

/** Records the layouts' block change `command` as a step of the form's history, when the controller offers it. */
export function recordFormStep(form: object | undefined, command: BuilderCommand): void {
  (form as FormTranslationsAccess | undefined)?.recordStep?.(command);
}
