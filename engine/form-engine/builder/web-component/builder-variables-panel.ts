/**
 * The Variables panel: what an author may reference, listed beside the canvas by
 * the shell's activity strip — every field on the form with the reference that reaches its
 * answer, the fields of each repeating section as one of its entries sees them, and the fixed
 * names the engine supplies (the scopes and functions a rule may use; the page tokens and host
 * values a PDF text may use). Reference only: a click copies the reference to the clipboard
 * and says so; nothing here edits the form.
 *
 * The same form is described in two syntaxes. On the form side a rule addresses a field by its
 * id wherever it sits (`core/tree/data-scope.ts`), so the panel lists ids and the `row.` /
 * `ancestor.` / `host.` / `component` prefixes the evaluator reads. On a PDF layout a text
 * block, a signature caption or a mapped field's text reads `{{path}}` placeholders
 * (`render/pdf/template-text.ts`), where the form scope is keyed by value path — a field inside
 * a data-scoping container is `{{applicant.email}}` — so the panel lists value paths in braces,
 * the row aliases, the page tokens and `{{host.key}}`.
 *
 * Rules are formulas, so the functions a formula may call are listed as the function table
 * holds them (built-ins and the plugin functions a host wires), grouped as the table groups
 * them, each row its signature and summary; a click copies the call with its blanks, and a
 * field copies as the formula spells it (a name the grammar cannot take bare is backticked).
 *
 * A journey's conditions are a third syntax: the Rules tab's, narrowed to what a
 * journey may read — a field by its id, a repeating section by its id as a whole, and the
 * functions — since `row.`, `ancestor.`, `host.` and `component` paths are not available to it
 * (`core/journey/journey-diagnostics.ts`, `condition.scope`).
 *
 * A docked panel hears every controller change; this one repaints only when the tree's shape,
 * ids, labels or scoping changed, or the syntax did.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import { BUTTON_COMPONENT_TYPE } from "../../core/schema/button.js";
import { HTML_COMPONENT_TYPE } from "../../core/schema/static-html.js";
import { IMAGE_COMPONENT_TYPE } from "../../core/schema/image.js";
import { FORMULA_FUNCTION_TABLE, type FormulaFunctionRow } from "../../core/expressions/function-table.js";
import { FORMULA_FUNCTION_DOCS } from "../../core/expressions/function-docs.js";
import { feelName } from "../formula/feel-functions.js";
import { buildDataPaths, buildValuePaths, collectionPathOf as sectionPathOf, dataKeyOf } from "../../core/tree/data-scope.js";
import { JOURNEY_END, PRESENTATION_REFERENCE_TYPE, PRESENTATION_VALUE_TYPE } from "../../core/schema/journey.js";
import { builderText, type BuilderTextCatalog, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import { canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import type { NestedTreeNodeView } from "../tree-editor/nested-tree-view.js";
import { BuilderPanelElement } from "./builder-panels.js";
import type { BuilderController } from "../controller/builder-controller.js";
import { builderTokens, esc } from "./builder-shared.js";

export const DATUM_BUILDER_VARIABLES_PANEL_TAG = "datum-builder-variables-panel";

/**
 * How a reference is written: `rules` is the Rules tab's path syntax (`email`, `row.qty`,
 * `host.role`); `placeholders` is the PDF text syntax (`{{email}}`, `{{row.qty}}`, `{{page}}`);
 * `conditions` is a journey condition's: the form's answers by component id, with
 * no scoped paths.
 */
export type VariablesSyntax = "rules" | "placeholders" | "conditions";

/**
 * The workspace the panel sits in: Data lists the saved value
 * paths, Journeys adds the paths a journey's conditions read; the others keep the reference
 * for their syntax.
 */
export type VariablesWorkspace = "form" | "logic" | "data" | "languages" | "journeys" | "pdf" | "print";

export interface VariableEntry {
  /** What the author writes: `email`, `{{applicant.email}}`, `{{row.qty}}`, `roundTo(number, scale)`. */
  reference: string;
  /** What a click copies when that is not the reference as drawn (a function's call with blanks). */
  copy?: string;
  /** What it stands for: the component's label, or a word for a fixed name. */
  label: string;
  /** A second line: the component's type, or where the reference is valid. */
  note?: string;
}

export interface VariableGroup {
  /** `fields`, `collection:<path>`, `scopes`, `functions`, `page` or `host`. */
  id: string;
  title: string;
  /** A line under the title: where the group's references are valid. */
  note?: string;
  entries: VariableEntry[];
}

export interface VariablesModel {
  syntax: VariablesSyntax;
  /** The line under the panel's head: what the references are for. */
  intro: string;
  /** A link the intro ends with (the formula reference), on the syntaxes that write formulas. */
  introLink?: { label: string; href: string };
  groups: VariableGroup[];
}

/** Detail of `builder-variable-pick`: a reference the author clicked. */
export interface BuilderVariablePickDetail {
  reference: string;
  syntax: VariablesSyntax;
  /** Whether the reference was handed to the clipboard (a page without one gets the event alone). */
  copied: boolean;
}

/** Types that carry no answer, so no reference reaches anything. */
const VALUELESS_TYPES: ReadonlySet<string> = new Set([BUTTON_COMPONENT_TYPE, HTML_COMPONENT_TYPE, IMAGE_COMPONENT_TYPE]);

/** The row aliases a PDF repeat supplies (`render/pdf/template-text.ts`, `ROW_ALIASES`). */
const rowAliases = (text: BuilderTextOptions | undefined): VariableEntry[] => [
  { reference: "{{rowNumber}}", label: builderText("variables.alias.rowNumber", undefined, text), note: builderText("variables.alias.rowNumber.note", undefined, text) },
  { reference: "{{rowIndex}}", label: builderText("variables.alias.rowIndex", undefined, text), note: builderText("variables.alias.rowIndex.note", undefined, text) },
  { reference: "{{rowCount}}", label: builderText("variables.alias.rowCount", undefined, text) }
];

const ruleScopes = (text: BuilderTextOptions | undefined): VariableEntry[] => [
  { reference: "component", label: builderText("variables.scope.component", undefined, text) },
  { reference: "component.part", label: builderText("variables.scope.part", undefined, text), note: builderText("variables.scope.part.note", undefined, text) },
  { reference: "row.key", label: builderText("variables.scope.row", undefined, text), note: builderText("variables.scope.row.note", undefined, text) },
  { reference: "ancestor.containerId", label: builderText("variables.scope.ancestor", undefined, text) },
  { reference: "host.key", label: builderText("variables.scope.host", undefined, text), note: "hostContext" }
];

/**
 * One function a formula may call: a row of the function table with its words. Built-ins come
 * from {@link builtInFunctionRows}; a host adds the plugin functions it wired (a `group` the
 * table does not know draws as "Plugins").
 */
export interface VariablesFunction {
  name: string;
  /** Parameter names in order; an optional one ends in `?`. */
  params: readonly string[];
  variadic?: boolean | undefined;
  group: string;
  summary?: string | undefined;
}

/** The built-in functions as the panel lists them: the table's rows with their summaries. */
export function builtInFunctionRows(): VariablesFunction[] {
  return FORMULA_FUNCTION_TABLE.map((row: FormulaFunctionRow) => ({
    name: row.name,
    params: row.params,
    ...(row.variadic ? { variadic: true } : {}),
    group: row.group,
    ...(FORMULA_FUNCTION_DOCS[row.name] ? { summary: FORMULA_FUNCTION_DOCS[row.name]!.summary } : {})
  }));
}

/** The table's groups, in the order the panel lists them, with the words that head them. */
const FUNCTION_GROUPS: ReadonlyArray<{ id: string; title: BuilderTextKey }> = [
  { id: "logic", title: "variables.group.logic" },
  { id: "text", title: "variables.group.text" },
  { id: "number", title: "variables.group.number" },
  { id: "list", title: "variables.group.list" },
  { id: "date", title: "variables.group.date" },
  { id: "scope", title: "variables.group.scope" }
];

/** Where a function's group is not one the table names (a plugin's own). */
const PLUGIN_FUNCTION_GROUP = { id: "plugins", title: "variables.group.plugins" } as const;

/** A call as it reads: `roundTo(number, scale)`, an optional parameter marked `?`, a repeating one `…`. */
export function functionSignature(row: VariablesFunction): string {
  const params = row.params.map((param, index) => (row.variadic && index === row.params.length - 1 ? `${param}, …` : param));
  return `${row.name}(${params.join(", ")})`;
}

/** What a click copies: the call with a blank (its parameter's name) where each argument goes; optional ones left out. */
export function functionCall(row: VariablesFunction): string {
  return `${row.name}(${row.params.filter((param) => !param.endsWith("?")).join(", ")})`;
}

/** How a field is written in a formula (see `feelName`). */
export const feelPath = feelName;

/** The function groups, as variable groups, in the table's order. */
function functionGroups(functions: readonly VariablesFunction[], syntax: VariablesSyntax, text?: BuilderTextOptions): VariableGroup[] {
  const known = new Set(FUNCTION_GROUPS.map((group) => group.id));
  const out: VariableGroup[] = [];
  for (const group of [...FUNCTION_GROUPS, PLUGIN_FUNCTION_GROUP]) {
    // A journey's condition reads no repeating section's entry, so its position functions are no use there.
    if (syntax === "conditions" && group.id === "scope") {
      continue;
    }
    const rows = functions.filter((row) => (group.id === PLUGIN_FUNCTION_GROUP.id ? !known.has(row.group) : row.group === group.id));
    if (rows.length === 0) {
      continue;
    }
    out.push({
      id: `functions:${group.id}`,
      title: builderText(group.title, undefined, text),
      entries: rows.map((row) => ({
        reference: functionSignature(row),
        copy: functionCall(row),
        label: row.summary ?? "",
        ...(row.variadic ? { note: builderText("variables.function.variadic", undefined, text) } : {})
      }))
    });
  }
  return out;
}

const pageTokens = (text: BuilderTextOptions | undefined): VariableEntry[] => [
  { reference: "{{page}}", label: builderText("variables.page.number", undefined, text) },
  { reference: "{{pages}}", label: builderText("variables.page.count", undefined, text) }
];

/** What a print header or footer slot reads beyond the form's values: the title, the print day, the receipt the host shows. */
const printTokens = (text: BuilderTextOptions | undefined): VariableEntry[] => [
  { reference: "{{title}}", label: builderText("variables.print.title", undefined, text) },
  { reference: "{{date}}", label: builderText("variables.print.date", undefined, text) },
  { reference: "{{receipt.reference}}", label: builderText("variables.print.receipt", undefined, text), note: "receipt.path" }
];

const INTRO_KEYS: Record<VariablesSyntax, BuilderTextKey> = {
  rules: "variables.intro.rules",
  placeholders: "variables.intro.placeholders",
  conditions: "variables.intro.conditions"
};

/** What a host can hand {@link buildVariablesModel}. */
export interface VariablesModelOptions {
  /** The functions a formula may call: the built-ins and any plugin functions the host wired. Default: the built-ins. */
  functions?: readonly VariablesFunction[] | undefined;
  /** Where the intro's link to the formula reference goes; unset, the intro has no link. */
  referenceHref?: string | undefined;
  /** The open journey's designer tree, in the Journeys workspace: its pages and the nodes it owns. */
  journeyView?: NestedTreeNodeView | undefined;
  /** The workspace the panel sits in; unset or one of the others, the syntax's own content. */
  workspace?: VariablesWorkspace | undefined;
  /** The builder's words (locale and catalog) for the per-workspace groups. */
  text?: BuilderTextOptions | undefined;
}

/** The designer-frame node types of a journey tree: not answers a condition can read. */
const JOURNEY_FRAME_TYPES: ReadonlySet<string> = new Set(["journey", "journey-page", "journey-route", PRESENTATION_REFERENCE_TYPE]);

function configurationOf(view: NestedTreeNodeView): Record<string, unknown> {
  const configuration = view.node.configuration as unknown;
  return typeof configuration === "object" && configuration !== null ? (configuration as Record<string, unknown>) : {};
}

function viewsOf(view: NestedTreeNodeView): NestedTreeNodeView[] {
  const out: NestedTreeNodeView[] = [];
  const walk = (node: NestedTreeNodeView): void => {
    for (const slot of node.slots) {
      for (const child of slot.children) {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(view);
  return out;
}

/**
 * The Data workspace's list: every answer the form saves at the path it is stored under (the
 * data key when it has one, else the id; a repeating section at its collection path), with the
 * component id and key beside it. No formula functions: nothing in Data takes a formula.
 */
function dataModel(view: NestedTreeNodeView, options: VariablesModelOptions): VariablesModel {
  const text = options.text;
  const paths = buildDataPaths(view.node);
  const entries: VariableEntry[] = [];
  for (const node of viewsOf(view)) {
    const isSection = node.node.collection !== undefined;
    if (!isSection && (VALUELESS_TYPES.has(node.type) || isContainer(node))) {
      continue;
    }
    const path = paths.get(node.id) ?? node.id;
    const key = dataKeyOf(node.node);
    entries.push({
      reference: path,
      label: node.label,
      note: isSection
        ? builderText("variables.data.section", undefined, text)
        : key === node.id
          ? builderText("variables.data.note.plain", { type: node.type }, text)
          : builderText("variables.data.note.key", { type: node.type, id: node.id, key }, text)
    });
  }
  return { syntax: "rules", intro: builderText("variables.data.intro", undefined, text), groups: [{ id: "values", title: builderText("variables.data.group", undefined, text), entries }] };
}

/** The groups a journey's conditions add in the Journeys workspace: pages and routes, then the journey's own nodes. */
function journeyGroups(view: NestedTreeNodeView | undefined, text: BuilderTextOptions | undefined): VariableGroup[] {
  const pages: VariableEntry[] = [];
  const own: VariableEntry[] = [];
  for (const node of view ? viewsOf(view) : []) {
    const configuration = configurationOf(node);
    if (node.type === "journey-page") {
      const id = typeof configuration.pageId === "string" && configuration.pageId !== "" ? configuration.pageId : node.id;
      pages.push({ reference: id, label: node.label, note: builderText("variables.journey.page", undefined, text) });
    } else if (node.type === PRESENTATION_VALUE_TYPE) {
      const target = typeof configuration.to === "string" ? configuration.to : "";
      if (target !== "") {
        own.push({ reference: feelName(target), label: node.label, note: builderText("variables.journey.own.worked", undefined, text) });
      }
    } else if (!JOURNEY_FRAME_TYPES.has(node.type) && !VALUELESS_TYPES.has(node.type) && !isContainer(node)) {
      const fills = typeof configuration.fills === "string" && configuration.fills !== "" ? configuration.fills : undefined;
      own.push({
        reference: feelName(node.id),
        label: node.label,
        note: fills !== undefined ? builderText("variables.journey.own.alias", { target: fills }, text) : builderText("variables.journey.own.field", { type: node.type }, text)
      });
    }
  }
  pages.push({ reference: JOURNEY_END, label: builderText("variables.journey.end", undefined, text) });
  return [
    { id: "journey:pages", title: builderText("variables.journey.pages", undefined, text), note: builderText("variables.journey.pages.note", undefined, text), entries: pages },
    ...(own.length > 0 ? [{ id: "journey:own", title: builderText("variables.journey.own", undefined, text), note: builderText("variables.journey.own.note", undefined, text), entries: own }] : [])
  ];
}

function isContainer(view: NestedTreeNodeView): boolean {
  return view.slots.length > 0 || Object.keys(view.node.children ?? {}).length > 0;
}

function collectionPathOf(node: ComponentNode): string {
  return sectionPathOf(node) ?? node.id;
}

/**
 * The leaves of a repeating section as one of its entries sees them: each field's path
 * relative to the section (a data-scoping container inside the entry adds its level), the
 * section's own nested sections left to their own groups.
 */
function rowFields(collection: NestedTreeNodeView): Array<{ path: string; view: NestedTreeNodeView }> {
  const relative = buildValuePaths(collection.node);
  const out: Array<{ path: string; view: NestedTreeNodeView }> = [];
  const walk = (view: NestedTreeNodeView): void => {
    for (const slot of view.slots) {
      for (const child of slot.children) {
        if (child.node.collection !== undefined || VALUELESS_TYPES.has(child.type)) {
          continue;
        }
        if (isContainer(child)) {
          walk(child);
          continue;
        }
        out.push({ path: relative.get(child.id) ?? child.id, view: child });
      }
    }
  };
  walk(collection);
  return out;
}

/**
 * The references the form offers, in the syntax asked for. Pure, so a host can draw its own
 * list from it and a test can read it without a DOM.
 */
export function buildVariablesModel(view: NestedTreeNodeView, syntax: VariablesSyntax, options: VariablesModelOptions = {}): VariablesModel {
  if (options.workspace === "data") {
    return dataModel(view, options);
  }
  const paths = buildValuePaths(view.node);
  const wrap = (path: string): string => (syntax === "placeholders" ? `{{${path}}}` : path);
  // A formula writes a field the way the grammar reads it; a placeholder writes its value path as is.
  const idRef = (id: string): string => (syntax === "placeholders" ? id : feelName(id));
  const fields: VariableEntry[] = [];
  const collections: VariableGroup[] = [];

  const visit = (node: NestedTreeNodeView, enclosing: NestedTreeNodeView | undefined): void => {
    for (const slot of node.slots) {
      for (const child of slot.children) {
        if (child.node.collection !== undefined) {
          // A journey condition reaches no entry of a section (no row. paths), only the section as a whole.
          if (syntax !== "conditions") {
            collections.push(collectionGroup(child, enclosing));
          }
          if (syntax !== "placeholders" && enclosing === undefined) {
            fields.push({ reference: idRef(child.id), label: child.label, note: builderText("variables.field.section", undefined, options.text) });
          }
          visit(child, child);
          continue;
        }
        if (VALUELESS_TYPES.has(child.type)) {
          continue;
        }
        if (isContainer(child)) {
          visit(child, enclosing);
          continue;
        }
        // A field inside a repeating section is reached through its entry, listed with the section.
        if (enclosing === undefined) {
          fields.push({ reference: wrap(syntax === "placeholders" ? (paths.get(child.id) ?? child.id) : idRef(child.id)), label: child.label, note: child.type });
        }
      }
    }
  };

  const collectionGroup = (collection: NestedTreeNodeView, enclosing: NestedTreeNodeView | undefined): VariableGroup => {
    const entries: VariableEntry[] = rowFields(collection).map(({ path, view: field }) => ({
      reference: wrap(syntax === "placeholders" ? `row.${path}` : feelName(`row.${path}`)),
      label: field.label,
      note: field.type
    }));
    if (syntax === "placeholders") {
      entries.push(...rowAliases(options.text));
      if (enclosing) {
        const outerPath = collectionPathOf(enclosing.node);
        for (const { path, view: field } of rowFields(enclosing)) {
          entries.push({ reference: `{{ancestor.${outerPath}.${path}}}`, label: field.label, note: builderText("variables.ancestor.note", { label: enclosing.label }, options.text) });
        }
      }
    }
    return {
      id: `collection:${collectionPathOf(collection.node)}`,
      title: builderText("variables.collection.title", { label: collection.label }, options.text),
      note: builderText(syntax === "placeholders" ? "variables.collection.note.placeholders" : "variables.collection.note.entry", undefined, options.text),
      entries
    };
  };

  visit(view, undefined);

  // A print slot reads the form's value paths, not a repeat's rows: no collection groups there.
  const printing = syntax === "placeholders" && options.workspace === "print";
  const groups: VariableGroup[] = [{ id: "fields", title: builderText("variables.group.fields", undefined, options.text), entries: fields }, ...(printing ? [] : collections)];
  const functions = options.functions ?? builtInFunctionRows();
  if (syntax === "rules") {
    groups.push({ id: "scopes", title: builderText("variables.group.scopes", undefined, options.text), entries: ruleScopes(options.text) }, ...functionGroups(functions, syntax, options.text));
  } else if (syntax === "conditions") {
    if (options.workspace === "journeys") {
      groups.push(...journeyGroups(options.journeyView, options.text));
    }
    groups.push(...functionGroups(functions, syntax, options.text));
  } else {
    groups.push(
      { id: "page", title: builderText("variables.group.page", undefined, options.text), note: builderText("variables.group.page.note", undefined, options.text), entries: pageTokens(options.text) },
      ...(printing ? [{ id: "print", title: builderText("variables.group.print", undefined, options.text), note: builderText("variables.group.print.note", undefined, options.text), entries: printTokens(options.text) }] : []),
      { id: "host", title: builderText("variables.group.host", undefined, options.text), entries: [{ reference: "{{host.key}}", label: builderText("variables.host.value", undefined, options.text), note: "hostContext" }] }
    );
  }
  // A link only where the host names a page: a default address would be dead in an embedding application.
  const link = syntax === "placeholders" || options.referenceHref === undefined ? undefined : { label: builderText("variables.link.reference", undefined, options.text), href: options.referenceHref };
  return { syntax, intro: builderText(printing ? "variables.intro.print" : INTRO_KEYS[syntax], undefined, options.text), ...(link ? { introLink: link } : {}), groups };
}

const VARIABLES_STYLES = `
  /* The title, the intro and the filter are one card pinned at the top; each group a card of the stack under it. */
  .variables-intro { margin: var(--db-space-1) 0 var(--db-space-3); line-height: 1.4; }
  .variables-filter { width: 100%; }
  .variables-filter::placeholder { color: var(--db-ink-subtle); }
  .variables-list { display: contents; }
  .variables-title { margin-bottom: var(--db-space-1); }
  .variables-note { margin: 0 0 var(--db-space-2); color: var(--db-ink-muted); font-size: var(--db-text-sm); }
  .variables-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--db-space-half); }
  /* A reference: a row that copies itself, hovered like any list row; just copied, the selected row's tint. */
  .variable {
    display: flex; flex-direction: column; align-items: flex-start; gap: var(--db-space-half); width: 100%; text-align: start;
    padding: var(--db-space-2); border: 0; border-radius: var(--db-radius-sm);
    background: transparent; color: var(--db-ink); font: inherit; cursor: pointer;
    transition: background var(--db-motion-fast) var(--db-ease);
  }
  .variable:hover { background: var(--db-surface-hover); }
  /* Inset, so the scrolling list never clips the ring. */
  .variable:focus-visible { outline: 2px solid var(--db-focus); outline-offset: -2px; }
  .variable[data-copied] { background: var(--db-accent-soft); color: var(--db-accent-text); }
  .variable-ref { font-family: var(--db-font-mono); font-size: var(--db-text-sm); word-break: break-all; }
  .variable-label { font-size: var(--db-text-md); }
  .variable-note { font-size: var(--db-text-xs); color: var(--db-ink-muted); }
  .variable[data-copied] .variable-note { color: inherit; }
  .variables-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

/** What the panel draws, flattened, so two paints that would look the same can be told apart cheaply. */
function treeSignature(view: NestedTreeNodeView): string {
  const parts: string[] = [];
  const walk = (node: NestedTreeNodeView, depth: number): void => {
    const scope = node.node.collection !== undefined ? `@${collectionPathOf(node.node)}` : node.type === "container" ? `#${String((node.node.configuration as { scopeData?: unknown } | undefined)?.scopeData)}` : "";
    // A data key moves a field's value path, which the placeholders list.
    const key = dataKeyOf(node.node);
    const own = configurationOf(node);
    const extra = [own.pageId, own.to, own.fills].filter((value) => typeof value === "string").join("|");
    parts.push(`${depth}:${node.id}:${node.type}:${node.label}${scope}${key === node.id ? "" : `~${key}`}${extra === "" ? "" : `^${extra}`}`);
    for (const slot of node.slots) {
      for (const child of slot.children) {
        walk(child, depth + 1);
      }
    }
  };
  walk(view, 0);
  return parts.join("\n");
}

function entryHtml(entry: VariableEntry, text?: BuilderTextOptions): string {
  const copy = entry.copy ?? entry.reference;
  return `<li><button type="button" class="variable" data-variable="${esc(copy)}" title="${esc(builderText("variables.copy", { reference: copy }, text))}">
      <code class="variable-ref">${esc(entry.reference)}</code>
      ${entry.label ? `<span class="variable-label">${esc(entry.label)}</span>` : ""}${entry.note ? `<span class="variable-note">${esc(entry.note)}</span>` : ""}
    </button></li>`;
}

function groupHtml(group: VariableGroup, text?: BuilderTextOptions): string {
  return `<section class="card variables-group" data-variables-group="${esc(group.id)}">
      <h3 class="card-heading variables-title">${esc(group.title)}</h3>
      ${group.note ? `<p class="variables-note">${esc(group.note)}</p>` : ""}
      ${group.entries.length > 0 ? `<ul class="variables-rows">${group.entries.map((entry) => entryHtml(entry, text)).join("")}</ul>` : `<div class="empty-state"><p>${esc(builderText("variables.noFields", undefined, text))}</p></div>`}
    </section>`;
}

export class DatumBuilderVariablesPanelElement extends BuilderPanelElement {
  private bound = false;
  private signature: string | undefined;
  private syntaxValue: VariablesSyntax | undefined;
  private modeSyntaxValue: VariablesSyntax | undefined;
  /** The filter box's text, kept across repaints. */
  private filter = "";
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  private functionsValue: readonly VariablesFunction[] | undefined;
  private referenceHrefValue: string | undefined;

  /**
   * The functions a formula may call, as the merged table holds them: the built-ins and the
   * plugin functions the host wired. Unset: the built-ins.
   */
  public set functions(value: readonly VariablesFunction[] | undefined) {
    this.functionsValue = value;
    this.signature = undefined;
    this.paint();
  }

  public get functions(): readonly VariablesFunction[] | undefined {
    return this.functionsValue;
  }

  /** Where the intro's "Formula reference" link goes; unset: the intro has no link. */
  public set referenceHref(value: string | undefined) {
    this.referenceHrefValue = value;
    this.signature = undefined;
    this.paint();
  }

  public get referenceHref(): string | undefined {
    return this.referenceHrefValue;
  }

  private modelOptions(): VariablesModelOptions {
    return {
      functions: this.functionsValue,
      referenceHref: this.referenceHrefValue,
      workspace: this.workspaceValue,
      journeyView: this.journeyCtrl?.treeView(),
      text: this.textOptions()
    };
  }

  /** The builder's locale and catalog, for every word the panel draws. */
  private textOptions(): BuilderTextOptions {
    return { locale: this.textLocaleValue, catalog: this.textCatalogValue };
  }

  private journeyCtrl: BuilderController | undefined;
  private journeyOff: Array<() => void> = [];

  /** The journey designer's controller while the Journeys workspace is on; the panel repaints when its tree changes. */
  public set journeyController(value: BuilderController | undefined) {
    if (this.journeyCtrl === value) {
      return;
    }
    for (const off of this.journeyOff) {
      off();
    }
    this.journeyOff = [];
    this.journeyCtrl = value;
    if (value) {
      this.journeyOff.push(value.on("change", () => this.paint()));
    }
    this.paint();
  }

  public get journeyController(): BuilderController | undefined {
    return this.journeyCtrl;
  }

  private workspaceValue: VariablesWorkspace | undefined;
  private textLocaleValue: string | undefined;
  private textCatalogValue: BuilderTextCatalog | undefined;

  /** The workspace the shell is in (set as it moves between them); Data and Journeys list their own content. */
  public set workspace(value: VariablesWorkspace | undefined) {
    if (this.workspaceValue === value) {
      return;
    }
    this.workspaceValue = value;
    this.paint();
  }

  public get workspace(): VariablesWorkspace | undefined {
    return this.workspaceValue;
  }

  /** The builder's own language for the per-workspace words. */
  public set textLocale(value: string | undefined) {
    this.textLocaleValue = value;
    this.signature = undefined;
    this.paint();
  }

  public set textCatalog(value: BuilderTextCatalog | undefined) {
    this.textCatalogValue = value;
    this.signature = undefined;
    this.paint();
  }

  /**
   * The syntax to list in. Unset, it follows the mode on the page: the form's (the primary
   * mode) is the Rules tab's path syntax; any other mode's — a PDF layout's — is the
   * placeholder syntax its text reads. A host listing for its own mode sets it outright.
   */
  public set syntax(value: VariablesSyntax | undefined) {
    if (this.syntaxValue === value) {
      return;
    }
    this.syntaxValue = value;
    this.paint();
  }

  public get syntax(): VariablesSyntax {
    return this.syntaxValue ?? this.modeSyntaxValue ?? (this.primaryValue ? "rules" : "placeholders");
  }

  /**
   * The syntax the mode on the page asks for (`BuilderMode.variables`), which the
   * shell sets as it moves between modes; {@link syntax}, set by a host, still wins. Unset:
   * the rule paths on the form, the placeholders elsewhere.
   */
  public set modeSyntax(value: VariablesSyntax | undefined) {
    if (this.modeSyntaxValue === value) {
      return;
    }
    this.modeSyntaxValue = value;
    this.paint();
  }

  public get modeSyntax(): VariablesSyntax | undefined {
    return this.modeSyntaxValue;
  }

  /** The references as the panel lists them now, for a host or a test; none without a controller. */
  public model(): VariablesModel | undefined {
    return this.ctrl ? buildVariablesModel(this.ctrl.treeView(), this.syntax, this.modelOptions()) : undefined;
  }

  /** The selection is no concern of the list: a reference is the same whichever component is picked. */
  protected override onSelectionChange(): void {}

  protected override onIconsChange(): void {
    this.signature = undefined;
    this.paint();
  }

  protected render(): void {
    if (!this.ctrl) {
      this.root.innerHTML = `<style>${builderTokens()}</style><div class="panel card-stack"><div class="card empty-state"><p>${esc(builderText("shell.noController", undefined, this.textOptions()))}</p></div></div>`;
      this.signature = undefined;
      return;
    }
    const view = this.ctrl.treeView();
    const syntax = this.syntax;
    const journeyView = this.workspaceValue === "journeys" ? this.journeyCtrl?.treeView() : undefined;
    const signature = `${syntax}\n${this.workspaceValue ?? ""}\n${treeSignature(view)}${journeyView ? `\n--\n${treeSignature(journeyView)}` : ""}`;
    if (signature === this.signature && this.root.querySelector("[data-variables-list]")) {
      return;
    }
    this.signature = signature;
    const model = buildVariablesModel(view, syntax, this.modelOptions());
    // The filter box keeps focus and its caret across the repaint an edit elsewhere causes.
    const focused = this.root.activeElement as HTMLInputElement | null;
    const filterFocused = focused?.hasAttribute("data-variables-filter") === true;
    const caret: [number | null, number | null] | undefined = filterFocused ? [focused!.selectionStart, focused!.selectionEnd] : undefined;
    this.root.innerHTML = `
      <style>${builderTokens()}${VARIABLES_STYLES}${this.iconCss()}</style>
      <div class="panel card-stack" data-variables-syntax="${syntax}">
        <div class="card is-pinned">
        <h2 class="card-title variables-head">${esc(builderText("variables.title", undefined, this.textOptions()))}</h2>
        <p class="card-lead variables-intro">${esc(model.intro)}${
          model.introLink ? ` <a class="link-btn variables-reference" data-variables-reference href="${esc(model.introLink.href)}" target="_blank" rel="noopener">${esc(model.introLink.label)}</a>` : ""
        }</p>
        <input class="variables-filter" type="search" data-variables-filter placeholder="${esc(builderText("variables.filter.placeholder", undefined, this.textOptions()))}" aria-label="${esc(builderText("variables.filter.label", undefined, this.textOptions()))}" value="${esc(this.filter)}" />
        </div>
        <div class="variables-list" data-variables-list>
          ${model.groups.map((group) => groupHtml(group, this.textOptions())).join("")}
          <p class="card empty" data-variables-none hidden>${esc(builderText("variables.none", undefined, this.textOptions()))}</p>
        </div>
        <div class="variables-status" role="status" aria-live="polite" data-variables-status></div>
      </div>`;
    this.bind();
    this.applyFilter();
    if (filterFocused) {
      const box = this.root.querySelector<HTMLInputElement>("[data-variables-filter]");
      box?.focus();
      if (box && caret && caret[0] !== null && caret[1] !== null) {
        box.setSelectionRange(caret[0], caret[1]);
      }
    }
  }

  /** Shows the rows whose reference or label holds the filter's text; a group with none left goes with them. */
  private applyFilter(): void {
    const needle = this.filter.trim().toLowerCase();
    let shown = 0;
    for (const group of this.root.querySelectorAll<HTMLElement>("[data-variables-group]")) {
      let inGroup = 0;
      for (const row of group.querySelectorAll<HTMLLIElement>(".variables-rows li")) {
        const match = needle === "" || (row.textContent ?? "").toLowerCase().includes(needle);
        row.hidden = !match;
        if (match) {
          inGroup += 1;
        }
      }
      // A group with no rows at all (no fields yet) stays while nothing is being filtered.
      const rows = group.querySelectorAll(".variables-rows li").length;
      group.hidden = needle !== "" && (rows === 0 || inGroup === 0);
      shown += inGroup;
    }
    const none = this.root.querySelector<HTMLElement>("[data-variables-none]");
    if (none) {
      none.hidden = !(needle !== "" && shown === 0);
    }
  }

  private pick(button: HTMLButtonElement): void {
    const reference = button.dataset.variable ?? "";
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    let written: Promise<void> | undefined;
    if (clipboard && typeof clipboard.writeText === "function") {
      try {
        written = clipboard.writeText(reference);
      } catch {
        written = undefined;
      }
    }
    const copied = written !== undefined;
    written?.catch(() => this.setStatus(builderText("variables.copyFailed", { reference }, this.textOptions())));
    this.setStatus(copied ? builderText("variables.copied", { reference }, this.textOptions()) : reference);
    for (const other of this.root.querySelectorAll<HTMLElement>("[data-copied]")) {
      other.removeAttribute("data-copied");
    }
    button.setAttribute("data-copied", "");
    if (this.copiedTimer !== undefined) {
      clearTimeout(this.copiedTimer);
    }
    this.copiedTimer = setTimeout(() => {
      button.removeAttribute("data-copied");
      this.copiedTimer = undefined;
    }, 1500);
    this.dispatchEvent(
      new CustomEvent<BuilderVariablePickDetail>("builder-variable-pick", {
        detail: { reference, syntax: this.syntax, copied },
        bubbles: true,
        composed: true
      })
    );
  }

  private setStatus(text: string): void {
    const status = this.root.querySelector<HTMLElement>("[data-variables-status]");
    if (status) {
      status.textContent = text;
    }
  }

  private bind(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.root.addEventListener("click", (event) => {
      const button = (event.target as Element).closest?.<HTMLButtonElement>("[data-variable]");
      if (button) {
        this.pick(button);
      }
    });
    this.root.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      if (target?.hasAttribute?.("data-variables-filter")) {
        this.filter = target.value;
        this.applyFilter();
      }
    });
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const off of this.journeyOff) {
      off();
    }
    this.journeyOff = [];
    this.journeyCtrl = undefined;
    if (this.copiedTimer !== undefined) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = undefined;
    }
  }
}

export function defineBuilderVariablesPanel(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_BUILDER_VARIABLES_PANEL_TAG)) {
    customElements.define(DATUM_BUILDER_VARIABLES_PANEL_TAG, DatumBuilderVariablesPanelElement);
  }
}
