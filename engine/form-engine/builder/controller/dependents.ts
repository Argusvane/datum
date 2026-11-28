/**
 * What else in a form leans on a component, for the delete confirmation and its "Also remove
 * references" choice: the rules of other components that read
 * it, the journey pages that list or condition on it, and the PDF layouts that bind to it.
 *
 * Two pure functions over a {@link DependentsSource} (the tree, plus the journeys' and the
 * layouts' blocks as the modes hold them): {@link dependentsOf} says what depends on a
 * component and everything inside it, {@link withoutDependents} says what each owner of a
 * reference would hold with those references cleared. The controller turns the second into
 * one history entry together with the removal itself (`BuilderController.remove`), so the
 * component and its references come back with one Undo.
 *
 * What counts as a reference is what a rename already follows (`renameIdInRuleSource` and
 * `renameRowKeysInRuleSource`, the journeys' `journey-config-rename.ts`, the PDF `renamePdfLayoutConditions`), so the three
 * agree on what "names a component" means. The constants of the PDF node types are spelt out
 * rather than imported: the PDF schema's resolvers stay out of the controller, and
 * a test pins the spelling to the schema's.
 *
 * Pure, static and free of work at import.
 */
import type { ComponentNode, ComponentRules } from "../../core/schema/types.js";
import type { JourneyConfiguration } from "../../core/schema/journey.js";
import type { PdfConfiguration } from "../../core/schema/pdf-layout.js";
import { buildDataPaths, buildRowCollections, buildRowKeys } from "../../core/tree/data-scope.js";
import { formulaMentionsField, pathNamesField, renameFormulaPath, renameIdInRuleSource, renameRowKeysInRuleSource, unparsedFormulaNaming } from "../formula/rename.js";
import { builderPlural, builderText, type BuilderTextOptions } from "../logic/builder-texts.js";

/** What the dependents are read from: the form's tree, and the blocks the modes hold. */
export interface DependentsSource {
  root: ComponentNode;
  /** The journeys' block, when the form has the Journeys mode's. */
  journey?: JourneyConfiguration | undefined;
  /** The PDF layouts' block, when the form has the PDF mode's. */
  pdf?: PdfConfiguration | undefined;
}

/** A rule of another component that reads the component. */
export interface RuleDependent {
  kind: "rule";
  /** The component that holds the rule. */
  componentId: string;
  /** What the author sees it called: its label, else its id. */
  name: string;
  /** The rule's key (`visibleWhen`, `requiredWhen`, a calculation's). */
  rule: string;
}

/** A journey page that lists, fills from, or conditions on the component. */
export interface JourneyDependent {
  kind: "journey";
  journeyId: string;
  journeyName: string;
  pageId: string;
  pageName: string;
  /**
   * `question`: the page lists it. `fills`: a field the page owns is filled from it. `value`: a
   * worked-out value writes to it or reads it. `rule`: a field the page owns has a rule that
   * reads it. `route`: a route's condition.
   */
  where: "question" | "fills" | "value" | "rule" | "route";
}

/** A PDF layout bound to the component. */
export interface PdfDependent {
  kind: "pdf";
  layoutId: string;
  layoutName: string;
  /** `when`: the layout's condition. `node`: a field, repeat or table of a generated layout. `field`: a template's field mapping. `area`: a template's drawn area. `text`: a text block or signature caption writes `{{id}}`. */
  where: "when" | "node" | "field" | "area" | "text";
  /** The node id, AcroForm field name or area label, for the three that have one. */
  detail?: string;
}

export type Dependent = RuleDependent | JourneyDependent | PdfDependent;

/** What each owner holds once the references to a component are cleared. `undefined` blocks: unchanged. */
export interface WithoutDependents {
  /** The components whose rules change, with the rules they keep (`undefined`: none left). */
  rules: Array<{ componentId: string; rules: ComponentRules | undefined }>;
  /** The journeys' block rewritten; absent when no journey changes. */
  journey?: JourneyConfiguration;
  /** The layouts' block rewritten; absent when no layout changes. */
  pdf?: PdfConfiguration;
}

/** A hand-built stand-in for an id no one can have: renaming to it shows whether a source reads the id. */
const PROBE = "\u0001gone";

const PRESENTATION_REFERENCE = "journey-field";
const PRESENTATION_VALUE = "journey-value";
/** The rules of a node a journey page owns that read form paths (see `OWN_RULE_KEYS` in the journeys' rename). */
const OWN_RULE_KEYS: readonly string[] = ["visibleWhen", "enabledWhen", "readonlyWhen", "requiredWhen"];
/** The configuration key a generated layout's node binds to the form by, per node type. */
const PDF_BINDING_KEYS: Readonly<Record<string, string>> = {
  "pdf-field": "componentId",
  "pdf-repeat": "collectionPath",
  "pdf-table": "collectionPath"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The data paths of a subtree's ids, by the id set {@link subtreeIds} returned. A PDF repeat or
 * table binds by data path (`collectionPath`), and a component in a scoping container, with a
 * data key, or with its own collection path sits at a path other than its id (`grp.items` for
 * the id `items`), so the path readers match these as well as the ids.
 */
const DATA_PATHS = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();

/** `id` and every id inside it. */
function subtreeIds(root: ComponentNode, id: string): Set<string> {
  const result = subtreeIdsOnly(root, id);
  const paths = buildDataPaths(root);
  const pathSet = new Set<string>();
  for (const member of result) {
    const path = paths.get(member);
    if (path !== undefined && path !== member) {
      pathSet.add(path.replace(/\[\]/g, ""));
    }
  }
  DATA_PATHS.set(result, pathSet);
  return result;
}

function subtreeIdsOnly(root: ComponentNode, id: string): Set<string> {
  const found = new Set<string>([id]);
  const visit = (node: ComponentNode, inside: boolean): void => {
    const within = inside || node.id === id;
    if (within) {
      found.add(node.id);
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        visit(child, within);
      }
    }
  };
  visit(root, false);
  return found;
}

/** The formula texts a stored rule holds: the string itself, or the object form's `formula`. */
function formulaTexts(rule: unknown): string[] {
  if (typeof rule === "string") {
    return [rule];
  }
  return isRecord(rule) && typeof rule.formula === "string" ? [rule.formula] : [];
}

/**
 * Whether a stored rule (formula or object form) reads any of `ids`, or spells one in a
 * formula that does not parse. `rowKeys` are the keys, in the row the rule sits in, of the
 * fields among `ids`: a rule reads a field of its row as `row.<key>`, never as `row.<id>`. A
 * formula is looked at lexically first, once per id and without parsing, and only the ids it
 * spells are probed with a rename (a parse each), so a rule is not parsed once per id of a
 * large subtree.
 */
function ruleReads(rule: unknown, ids: ReadonlySet<string>, rowKeys: readonly string[] = []): boolean {
  if (rule === undefined || rule === null) {
    return false;
  }
  for (const text of formulaTexts(rule)) {
    for (const id of ids) {
      if (formulaMentionsField(text, id) && (renameIdInRuleSource(text, id, id + PROBE) !== text || unparsedFormulaNaming(text, id) !== undefined)) {
        return true;
      }
    }
    for (const key of rowKeys) {
      if (formulaMentionsField(text, key) && renameRowKeysInRuleSource(text, [{ from: key, to: key + PROBE }]) !== text) {
        return true;
      }
    }
  }
  return false;
}

/**
 * What a removal takes with the component: the ids of the subtree, the row each component sits
 * in, and the keys the subtree's fields have in each row. A rule inside a grid row reads the
 * fields of its row by key (`row.sku`), which is not their id when the field has a data key.
 */
export interface Removal {
  readonly ids: ReadonlySet<string>;
  readonly rows: ReadonlyMap<string, string>;
  readonly rowKeys: ReadonlyMap<string, readonly string[]>;
}

export function removalOf(root: ComponentNode, componentId: string): Removal {
  const ids = subtreeIds(root, componentId);
  const rows = buildRowCollections(root);
  const keyOf = buildRowKeys(root);
  const rowKeys = new Map<string, string[]>();
  for (const id of ids) {
    const row = rows.get(id);
    const key = keyOf.get(id);
    if (row !== undefined && key !== undefined) {
      rowKeys.set(row, [...(rowKeys.get(row) ?? []), key]);
    }
  }
  return { ids, rows, rowKeys };
}

/** The keys, in the row the component `nodeId` sits in, of the fields a removal takes. */
export function rowKeysOf(removal: Removal, nodeId: string): readonly string[] {
  const row = removal.rows.get(nodeId);
  return row === undefined ? [] : (removal.rowKeys.get(row) ?? []);
}

/**
 * Whether a form path (`address.city`, `row.amount`, `items[0].sku`) leads with one of `ids` or
 * their data paths. The data paths are held without entry marks, so an entry index in the path
 * (`[0]`, `[]`) is read past.
 */
function pathReads(path: unknown, ids: ReadonlySet<string>): boolean {
  if (typeof path !== "string") {
    return false;
  }
  const bare = path.replace(/\[\d*\]/g, "");
  for (const id of [...ids, ...(DATA_PATHS.get(ids) ?? [])]) {
    if (renameFormulaPath(path, id, id + PROBE) !== path || renameFormulaPath(bare, id, id + PROBE) !== bare) {
      return true;
    }
  }
  return false;
}

/** What the author reads a node as: its plain-text label, else its id. */
function nameOfNode(node: ComponentNode): string {
  const label = isRecord(node.configuration) ? node.configuration.label : undefined;
  return nameOfText(label) ?? node.id;
}

/** A name or title as the confirmation lists it: the string in the form's default language, `undefined` for anything else or blank. */
function nameOfText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function declaredJourneys(configuration: JourneyConfiguration | undefined): Array<Record<string, unknown>> {
  const declared = (configuration as { journeys?: unknown } | undefined)?.journeys;
  return Array.isArray(declared) ? declared.filter((entry): entry is Record<string, unknown> => isRecord(entry) && Array.isArray(entry.pages)) : [];
}

function declaredLayouts(configuration: PdfConfiguration | undefined): Array<Record<string, unknown>> {
  const declared = (configuration as { layouts?: unknown } | undefined)?.layouts;
  return Array.isArray(declared) ? declared.filter(isRecord) : [];
}

// --- reading --------------------------------------------------------------------------

/**
 * Everything outside `componentId` and what is inside it that names it: other components'
 * rules, journey pages, PDF layouts. A rule inside the subtree about the subtree goes with it
 * and is no dependent. In the order the form has them: the tree's, then the journeys', then
 * the layouts'; each place once per kind of reference.
 */
export function dependentsOf(source: DependentsSource, componentId: string): Dependent[] {
  const removal = removalOf(source.root, componentId);
  const { ids } = removal;
  return [...ruleDependents(source.root, removal), ...journeyDependents(source.journey, ids), ...pdfDependents(source.pdf, ids)];
}

function ruleDependents(root: ComponentNode, removal: Removal): RuleDependent[] {
  const out: RuleDependent[] = [];
  const visit = (node: ComponentNode): void => {
    if (!removal.ids.has(node.id) && isRecord(node.rules)) {
      const rowKeys = rowKeysOf(removal, node.id);
      for (const [rule, value] of Object.entries(node.rules)) {
        if (ruleReads(value, removal.ids, rowKeys)) {
          out.push({ kind: "rule", componentId: node.id, name: nameOfNode(node), rule });
        }
      }
    }
    for (const group of Object.values(node.children ?? {})) {
      group.forEach(visit);
    }
  };
  visit(root);
  return out;
}

/** Whether a node a journey page owns names the component, and how: the first reading, per node. */
function ownedNodeReads(node: Record<string, unknown>, ids: ReadonlySet<string>): JourneyDependent["where"][] {
  const found: JourneyDependent["where"][] = [];
  const configuration = isRecord(node.configuration) ? node.configuration : undefined;
  if (node.type === PRESENTATION_REFERENCE) {
    if (typeof configuration?.componentId === "string" && ids.has(configuration.componentId)) {
      found.push("question");
    }
    return found;
  }
  if (typeof configuration?.fills === "string" && ids.has(configuration.fills)) {
    found.push("fills");
  }
  if (node.type === PRESENTATION_VALUE && ((typeof configuration?.to === "string" && ids.has(configuration.to)) || ruleReads(configuration?.value, ids))) {
    found.push("value");
  }
  if (isRecord(node.rules) && OWN_RULE_KEYS.some((key) => ruleReads((node.rules as Record<string, unknown>)[key], ids))) {
    found.push("rule");
  }
  for (const held of Object.values(isRecord(node.children) ? node.children : {})) {
    for (const child of Array.isArray(held) ? held : []) {
      if (isRecord(child)) {
        found.push(...ownedNodeReads(child, ids));
      }
    }
  }
  return found;
}

function journeyDependents(configuration: JourneyConfiguration | undefined, ids: ReadonlySet<string>): JourneyDependent[] {
  const out: JourneyDependent[] = [];
  for (const journey of declaredJourneys(configuration)) {
    const journeyId = typeof journey.id === "string" ? journey.id : "";
    const journeyName = nameOfText(journey.name) ?? journeyId;
    for (const page of journey.pages as unknown[]) {
      if (!isRecord(page)) {
        continue;
      }
      const pageId = typeof page.id === "string" ? page.id : "";
      const pageName = nameOfText(page.title) ?? pageId;
      const wheres = new Set<JourneyDependent["where"]>();
      for (const entry of Array.isArray(page.components) ? page.components : []) {
        if (typeof entry === "string") {
          if (ids.has(entry)) {
            wheres.add("question");
          }
        } else if (isRecord(entry)) {
          ownedNodeReads(entry, ids).forEach((where) => wheres.add(where));
        }
      }
      if (Array.isArray(page.routes) && page.routes.some((route) => isRecord(route) && ruleReads(route.when, ids))) {
        wheres.add("route");
      }
      for (const where of wheres) {
        out.push({ kind: "journey", journeyId, journeyName, pageId, pageName, where });
      }
    }
  }
  return out;
}

/** Whether a generated layout's node (a field, repeat or table) binds to the subtree. */
function bindsTo(node: ComponentNode, ids: ReadonlySet<string>): boolean {
  const key = PDF_BINDING_KEYS[node.type];
  return key !== undefined && isRecord(node.configuration) && pathReads(node.configuration[key], ids);
}

/** The configuration key whose text takes `{{path}}` templates, per generated-layout node type. */
const PDF_TEMPLATE_TEXT_KEYS: Readonly<Record<string, string>> = { "pdf-text": "text", "pdf-signature": "label" };

/** Every text of a plain or localized value (the default and each translation). */
function textsOf(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return isRecord(value) ? Object.values(value).filter((entry): entry is string => typeof entry === "string") : [];
}

/** Whether a text block or signature caption writes `{{id}}` (or `{{id.sub}}`) for the subtree: it would print blank once the field is gone. */
function writesPlaceholder(node: ComponentNode, ids: ReadonlySet<string>): boolean {
  const key = PDF_TEMPLATE_TEXT_KEYS[node.type];
  if (key === undefined || !isRecord(node.configuration)) {
    return false;
  }
  return textsOf(node.configuration[key]).some((text) => {
    for (const match of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      const path = match[1]!;
      // `{{row.key}}` names a field of the repeat's entry, not of the form.
      if (path.startsWith("row.")) {
        continue;
      }
      const bare = path.replace(/\[\d*\]/g, "");
      for (const id of [...ids, ...(DATA_PATHS.get(ids) ?? [])]) {
        if (pathNamesField(path, id) || pathNamesField(bare, id)) {
          return true;
        }
      }
    }
    return false;
  });
}

/** The nodes of a generated layout's tree that bind to the subtree. */
function boundNodes(node: ComponentNode, ids: ReadonlySet<string>): ComponentNode[] {
  return [...(bindsTo(node, ids) ? [node] : []), ...Object.values(node.children ?? {}).flatMap((group) => group.flatMap((child) => boundNodes(child, ids)))];
}

/** The nodes of a generated layout's tree whose text writes a placeholder for the subtree. */
function placeholderNodes(node: ComponentNode, ids: ReadonlySet<string>): ComponentNode[] {
  return [...(writesPlaceholder(node, ids) ? [node] : []), ...Object.values(node.children ?? {}).flatMap((group) => group.flatMap((child) => placeholderNodes(child, ids)))];
}

/** Whether a template mapping's source (field or area) draws on the subtree. */
function sourceReads(source: unknown, ids: ReadonlySet<string>): boolean {
  if (!isRecord(source)) {
    return false;
  }
  switch (source.kind) {
    case "component":
      return typeof source.componentId === "string" && ids.has(source.componentId);
    case "path":
      return pathReads(source.path, ids);
    case "expression":
      return ruleReads(source.expression, ids);
    default:
      return false;
  }
}

function pdfDependents(configuration: PdfConfiguration | undefined, ids: ReadonlySet<string>): PdfDependent[] {
  const out: PdfDependent[] = [];
  for (const layout of declaredLayouts(configuration)) {
    const layoutId = typeof layout.id === "string" ? layout.id : "";
    const layoutName = nameOfText(layout.name) ?? layoutId;
    const push = (where: PdfDependent["where"], detail?: string): void => {
      out.push({ kind: "pdf", layoutId, layoutName, where, ...(detail !== undefined ? { detail } : {}) });
    };
    if (ruleReads(layout.when, ids)) {
      push("when");
    }
    if (layout.kind === "generated" && isRecord(layout.root)) {
      for (const node of boundNodes(layout.root as unknown as ComponentNode, ids)) {
        push("node", node.id);
      }
      for (const node of placeholderNodes(layout.root as unknown as ComponentNode, ids)) {
        push("text", node.id);
      }
    }
    if (layout.kind === "template") {
      for (const field of Array.isArray(layout.fields) ? layout.fields : []) {
        if (isRecord(field) && sourceReads(field.source, ids)) {
          push("field", typeof field.pdfField === "string" ? field.pdfField : undefined);
        }
      }
      for (const area of Array.isArray(layout.areas) ? layout.areas : []) {
        if (isRecord(area) && sourceReads(area.source, ids)) {
          push("area", typeof area.label === "string" ? area.label : typeof area.id === "string" ? area.id : undefined);
        }
      }
    }
  }
  return out;
}

// --- clearing -------------------------------------------------------------------------

/**
 * `rules` without the ones that read any of `ids`: the same object when none does, `undefined`
 * when none is left. The controller applies it to the open drafts too, so a Save cannot write
 * a removed component's reference back.
 */
export function rulesWithout(rules: ComponentRules, ids: ReadonlySet<string>, rowKeys: readonly string[] = []): ComponentRules | undefined {
  const entries = Object.entries(rules);
  const kept = entries.filter(([, value]) => !ruleReads(value, ids, rowKeys));
  if (kept.length === entries.length) {
    return rules;
  }
  return kept.length === 0 ? undefined : (Object.fromEntries(kept) as ComponentRules);
}

/**
 * What the owners of the references hold once those are cleared (the "Also remove references"
 * choice). A rule that reads the component is removed; a journey page drops the question and
 * any field it owns that is filled from the component, loses a condition that reads it, and
 * loses a route whose condition does (a route with no condition is always taken, which is the
 * opposite of what it said); a generated layout drops the nodes bound to it; a template layout
 * unmaps the fields and removes the areas drawn from it, and loses a `when` that reads it.
 * Nothing else is touched: blocks and owners that read nothing come back as the same objects.
 */
export function withoutDependents(source: DependentsSource, componentId: string): WithoutDependents {
  const removal = removalOf(source.root, componentId);
  const { ids } = removal;
  const rules: WithoutDependents["rules"] = [];
  const visit = (node: ComponentNode): void => {
    if (!ids.has(node.id) && isRecord(node.rules)) {
      const kept = rulesWithout(node.rules as ComponentRules, ids, rowKeysOf(removal, node.id));
      if (kept !== node.rules) {
        rules.push({ componentId: node.id, rules: kept });
      }
    }
    for (const group of Object.values(node.children ?? {})) {
      group.forEach(visit);
    }
  };
  visit(source.root);
  const journey = clearJourneys(source.journey, ids);
  const pdf = clearLayouts(source.pdf, ids);
  return { rules, ...(journey !== source.journey && journey !== undefined ? { journey } : {}), ...(pdf !== source.pdf && pdf !== undefined ? { pdf } : {}) };
}

/** An owned node (or reference) of a page with what reads the subtree taken out; `undefined`: the node itself goes. */
function clearOwnedNode(node: unknown, ids: ReadonlySet<string>): unknown {
  if (!isRecord(node)) {
    return node;
  }
  const configuration = isRecord(node.configuration) ? node.configuration : undefined;
  if (node.type === PRESENTATION_REFERENCE) {
    return typeof configuration?.componentId === "string" && ids.has(configuration.componentId) ? undefined : node;
  }
  if (typeof configuration?.fills === "string" && ids.has(configuration.fills)) {
    return undefined;
  }
  if (node.type === PRESENTATION_VALUE && ((typeof configuration?.to === "string" && ids.has(configuration.to)) || ruleReads(configuration?.value, ids))) {
    return undefined;
  }
  let next: Record<string, unknown> = node;
  if (isRecord(node.rules)) {
    const rules = node.rules;
    const dropped = OWN_RULE_KEYS.filter((key) => ruleReads(rules[key], ids));
    if (dropped.length > 0) {
      const kept = Object.fromEntries(Object.entries(rules).filter(([key]) => !dropped.includes(key)));
      const { rules: _old, ...rest } = node;
      next = Object.keys(kept).length === 0 ? rest : { ...rest, rules: kept };
    }
  }
  if (isRecord(next.children)) {
    const children = next.children;
    let changed = false;
    const rewritten = Object.fromEntries(
      Object.entries(children).map(([slot, held]) => {
        if (!Array.isArray(held)) {
          return [slot, held];
        }
        const cleared = held.map((child) => clearOwnedNode(child, ids)).filter((child) => child !== undefined);
        changed ||= cleared.length !== held.length || cleared.some((child, at) => child !== held[at]);
        return [slot, cleared];
      })
    );
    if (changed) {
      next = { ...next, children: rewritten };
    }
  }
  return next;
}

function clearPage(page: Record<string, unknown>, ids: ReadonlySet<string>): Record<string, unknown> {
  let next: Record<string, unknown> = page;
  if (Array.isArray(page.components)) {
    const kept = page.components
      .map((entry) => (typeof entry === "string" ? (ids.has(entry) ? undefined : entry) : clearOwnedNode(entry, ids)))
      .filter((entry) => entry !== undefined);
    if (kept.length !== page.components.length || kept.some((entry, at) => entry !== (page.components as unknown[])[at])) {
      next = { ...next, components: kept };
    }
  }
  if (Array.isArray(page.routes) && page.routes.some((route) => isRecord(route) && ruleReads(route.when, ids))) {
    next = { ...next, routes: page.routes.filter((route) => !(isRecord(route) && ruleReads(route.when, ids))) };
  }
  return next;
}

function clearJourneys(configuration: JourneyConfiguration | undefined, ids: ReadonlySet<string>): JourneyConfiguration | undefined {
  const declared = (configuration as { journeys?: unknown } | undefined)?.journeys;
  if (!Array.isArray(declared)) {
    return configuration;
  }
  let changed = false;
  const journeys = declared.map((journey: unknown) => {
    if (!isRecord(journey) || !Array.isArray(journey.pages)) {
      return journey;
    }
    const pages = journey.pages.map((page: unknown) => (isRecord(page) ? clearPage(page, ids) : page));
    if (pages.every((page, at) => page === (journey.pages as unknown[])[at])) {
      return journey;
    }
    changed = true;
    return { ...journey, pages };
  });
  return changed ? ({ ...configuration, journeys } as JourneyConfiguration) : configuration;
}

/** `node` with the subtree-bound nodes below it removed; the node itself when none is. */
function clearGeneratedTree(node: ComponentNode, ids: ReadonlySet<string>): ComponentNode {
  if (!node.children) {
    return node;
  }
  let changed = false;
  const children = Object.fromEntries(
    Object.entries(node.children).map(([slot, group]) => {
      const kept = group.filter((child) => !bindsTo(child, ids)).map((child) => clearGeneratedTree(child, ids));
      changed ||= kept.length !== group.length || kept.some((child, at) => child !== group[at]);
      return [slot, kept];
    })
  );
  return changed ? { ...node, children } : node;
}

function clearLayouts(configuration: PdfConfiguration | undefined, ids: ReadonlySet<string>): PdfConfiguration | undefined {
  const declared = (configuration as { layouts?: unknown } | undefined)?.layouts;
  if (!Array.isArray(declared)) {
    return configuration;
  }
  let changed = false;
  const layouts = declared.map((layout: unknown) => {
    if (!isRecord(layout)) {
      return layout;
    }
    let next: Record<string, unknown> = layout;
    if (layout.when !== undefined && ruleReads(layout.when, ids)) {
      const { when: _when, ...rest } = next;
      next = rest;
    }
    if (layout.kind === "generated" && isRecord(layout.root)) {
      const root = clearGeneratedTree(layout.root as unknown as ComponentNode, ids);
      if (root !== (layout.root as unknown)) {
        next = { ...next, root };
      }
    }
    if (layout.kind === "template") {
      if (Array.isArray(layout.fields) && layout.fields.some((field) => isRecord(field) && sourceReads(field.source, ids))) {
        next = { ...next, fields: layout.fields.filter((field) => !(isRecord(field) && sourceReads(field.source, ids))) };
      }
      if (Array.isArray(layout.areas) && layout.areas.some((area) => isRecord(area) && sourceReads(area.source, ids))) {
        next = { ...next, areas: layout.areas.filter((area) => !(isRecord(area) && sourceReads(area.source, ids))) };
      }
    }
    if (next !== layout) {
      changed = true;
    }
    return next;
  });
  return changed ? ({ ...configuration, layouts } as PdfConfiguration) : configuration;
}

// --- words ----------------------------------------------------------------------------

/**
 * One line per dependent, for the delete confirmation's list, in the builder's words
 * (`confirm.delete.dependents.*`). Rule and PDF lines say where; a journey line says which page.
 */
export function dependentLines(dependents: readonly Dependent[], words?: BuilderTextOptions): string[] {
  return dependents.map((dependent) => {
    switch (dependent.kind) {
      case "rule":
        return builderText("confirm.delete.dependents.rule", { rule: dependent.rule, name: dependent.name }, words);
      case "journey":
        return builderText(
          `confirm.delete.dependents.journey.${dependent.where}`,
          { journey: dependent.journeyName, page: dependent.pageName },
          words
        );
      case "pdf":
        return builderText(
          `confirm.delete.dependents.pdf.${dependent.where}`,
          { layout: dependent.layoutName, detail: dependent.detail ?? "" },
          words
        );
    }
  });
}

/** The heading over that list: "2 other places use it". */
export function dependentsHeading(count: number, words?: BuilderTextOptions): string {
  return builderPlural("confirm.delete.dependents", count, undefined, words);
}
