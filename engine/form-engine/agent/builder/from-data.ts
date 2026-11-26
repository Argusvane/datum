/**
 * `fromData` for `add_components` and `replace_form`: the Data workspace's import without its DOM. A JSON sample of the answers, or a JSON
 * Schema, is read into a data model, compared with the form, planned into components by the
 * importer's own planner and handed back as a plan the two write tools place through the
 * controller's guarded `request*` methods, so a field the assistant adds is the one the Data
 * workspace would add.
 *
 * The planner (`builder/data/data-model-plan.ts`) is never imported here: it is fetched through
 * `host.loadDataModelKit()` the first time a call needs it, and a failed fetch answers the
 * retryable `chunk-unavailable { what: "data-model" }`. This module reads and plans;
 * the tools do the writing (the person's prompt and drafts, the writing flag, the undo step).
 *
 * What the importer does not check and this does, because an assistant is not looking at the
 * preview: every generated pattern goes through the kernel's risky-pattern reader and a risky
 * one is dropped with a warning (`patternForForm` does not run it), the plan is held to the
 * same node caps as a hand-written `components` list, and the form it would leave must pass the
 * structure limits the server enforces.
 */
import { kernelRegexRisky } from "../../core/expressions/compile.js";
import { ComponentTree } from "../../core/tree/component-tree.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { InsertComponentEntry } from "../../builder/controller/builder-controller.js";
import { ToolRefusal } from "../tool-types.js";
import { MAX_NODES, MAX_TOP_LEVEL, structureProblem, structureRefusal, subtreeIds, subtreeNodes, type ComponentPlan, type PlannedRow } from "./components.js";
import type { BuilderCallScope, BuilderToolsShared } from "./context.js";
import type { DataModelKit } from "./host.js";
import { badInput, isRecord, tooLarge } from "./properties.js";
import type { DataModelReport } from "./types.js";

/** The caps of the report's lists. */
const ADDED_CAP = 200;
const KIND_DIFFERS_CAP = 50;
const SKIPPED_CAP = 50;
const NOTES_CAP = 20;

type Input = Record<string, unknown>;
type DataModel = ReturnType<DataModelKit["formDataModel"]>;
type Comparison = ReturnType<DataModelKit["compareDataModels"]>;

/** What {@link planFromData} hands the tool. */
export interface FromDataPlan {
  /** The nodes in the shape the shared result helpers read (ids, rows, warnings; no lints). */
  plan: ComponentPlan;
  /** The report the result carries as `dataModel`. */
  report: DataModelReport;
  /** Add: the importer's insert thunk, planned again from the committed tree when the insert runs. */
  entries(): InsertComponentEntry[];
  /** Replace: the importer's replace thunk, planned again when the replace runs. */
  nodes(): ComponentNode[];
  /** Replace: the root's closing buttons that stay after the new content. */
  keep: string[];
  /** Nothing to place: an add whose places the form already holds, a replace of data that describes no place. */
  empty: boolean;
}

/** `components` and `fromData` are exactly one of the two. */
export function usesFromData(input: Input): boolean {
  const hasComponents = input.components !== undefined;
  const hasData = input.fromData !== undefined;
  if (hasComponents === hasData) {
    throw badInput([{ key: "components", expected: "components or fromData, not both and not neither" }]);
  }
  return hasData;
}

function chunkRefusal(): ToolRefusal {
  return new ToolRefusal("chunk-unavailable", "The data-model reader could not be loaded.", "Try once more; if it fails again the host removed that file: tell the person.", { what: "data-model", state: "failed" });
}

/** The kit, once per page; any failure to have it is the same retryable answer. */
async function loadKit(shared: BuilderToolsShared): Promise<DataModelKit> {
  const load = shared.host.loadDataModelKit;
  if (load === undefined) {
    throw chunkRefusal();
  }
  try {
    return await load.call(shared.host);
  } catch {
    throw chunkRefusal();
  }
}

/** The data as the reader takes it: text, as given or as JSON of what was given. */
function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    throw badInput([{ key: "fromData", expected: "JSON data: an object, or text that holds JSON" }]);
  }
}

function kindText(node: { kind: string; format?: string | undefined }): string {
  return node.format !== undefined ? `${node.kind} (${node.format})` : node.kind;
}

/**
 * Drops every generated pattern the kernel's risky-pattern reader refuses, in place, and says
 * which. Walked with an explicit stack: a deep plan is answered, never a RangeError.
 */
function dropRiskyPatterns(nodes: readonly ComponentNode[]): Set<string> {
  const dropped = new Set<string>();
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    const configuration = isRecord(node.configuration) ? (node.configuration as Record<string, unknown>) : undefined;
    const pattern = configuration?.pattern;
    if (configuration !== undefined && typeof pattern === "string" && kernelRegexRisky(pattern)) {
      delete configuration.pattern;
      dropped.add(pattern);
    }
    for (const group of Object.values(node.children ?? {})) {
      stack.push(...group);
    }
  }
  return dropped;
}

/** The rows `added` reports for a dry run, where each node would land. */
function plannedRows(scope: BuilderCallScope, entries: readonly InsertComponentEntry[], rootId: string, fresh: boolean): PlannedRow[] {
  const committed = scope.controller.snapshot();
  const counts = new Map<string, number>();
  const rows: PlannedRow[] = [];
  for (const entry of entries) {
    const parentId = entry.parentId ?? rootId;
    const slotId = entry.slotId ?? "content";
    const parent = subtreeNodes(committed).find((node) => node.id === parentId);
    const key = `${parentId}/${slotId}`;
    // A replace puts its nodes first in the slot; an add lands after what the slot holds.
    const at = entry.index ?? counts.get(key) ?? (fresh ? 0 : (parent?.children?.[slotId]?.length ?? 0));
    counts.set(key, at + 1);
    const stack: Array<{ node: ComponentNode; parentId: string; slotId: string; index: number }> = [{ node: entry.node, parentId, slotId, index: at }];
    while (stack.length > 0) {
      const next = stack.pop() as (typeof stack)[number];
      const configuration = isRecord(next.node.configuration) ? next.node.configuration : {};
      const label = typeof configuration.label === "string" ? configuration.label : next.node.id;
      rows.push({ id: next.node.id, type: next.node.type, label, parentId: next.parentId, slotId: next.slotId, index: next.index });
      const nested: Array<(typeof stack)[number]> = [];
      for (const [nestedSlot, group] of Object.entries(next.node.children ?? {})) {
        group.forEach((child, index) => nested.push({ node: child, parentId: next.node.id, slotId: nestedSlot, index }));
      }
      for (let at2 = nested.length - 1; at2 >= 0; at2 -= 1) {
        stack.push(nested[at2] as (typeof stack)[number]);
      }
    }
  }
  return rows;
}

/**
 * Reads `input.fromData` and plans what it would add (`mode: "add"`) or rebuild (`"replace"`).
 * Throws `feature-off`, `chunk-unavailable`, `data-unreadable`, `too-large` or
 * `structure-limit`; nothing is written. The caller has checked {@link usesFromData}.
 */
export async function planFromData(shared: BuilderToolsShared, scope: BuilderCallScope, input: Input, mode: "add" | "replace"): Promise<FromDataPlan> {
  const host = shared.host;
  if (!host.featureOn("data-model")) {
    throw new ToolRefusal("feature-off", "The data-model feature is off in this host.", "This page does not allow that; tell the person instead of retrying.", { feature: "data-model" });
  }
  const text = textOf(input.fromData);
  const readAs = input.readAs === "sample" || input.readAs === "schema" ? input.readAs : "auto";
  const kit = await loadKit(shared);
  const controller = scope.controller;
  const read = kit.readDataModelInput(text, readAs, scope.words);
  if (!read.ok) {
    const error = read.error ?? "The data is empty.";
    throw new ToolRefusal("data-unreadable", error, "Send a JSON object (a sample of the answers) or a JSON Schema whose top level is an object; fix the JSON at the line and column given.", {
      error,
      ...(read.line !== undefined ? { line: read.line } : {}),
      ...(read.column !== undefined ? { column: read.column } : {}),
      ...(read.empty === true ? { empty: true } : {})
    });
  }
  const model = read.model;
  const hasType = (type: string): boolean => controller.hasComponentType(type);
  const rootId = controller.rootId();

  // The comparison gives every incoming place its fit; an add reads the form's own, a replace
  // compares against nothing (every place is new).
  let comparison: Comparison;
  let entries: InsertComponentEntry[] = [];
  let nodes: ComponentNode[] = [];
  let keep: string[] = [];
  let added: Array<{ path: string; componentId: string; notes: Array<{ message: string }> }>;
  let skipped: Array<{ path: string; reason: string }>;
  if (mode === "add") {
    const planned = kit.planDataModelAdd(controller, model, scope.words);
    comparison = planned.comparison;
    entries = planned.entries;
    added = planned.added;
    skipped = planned.skipped;
  } else {
    const planned = kit.planDataModelReplace(controller, model, scope.words);
    comparison = kit.compareDataModels({ source: "form", root: { key: "", path: "", kind: "object", children: [] }, notes: [] } as DataModel, model, { hasType });
    nodes = planned.nodes;
    keep = planned.keep;
    added = planned.added;
    skipped = planned.skipped;
  }
  const placed: ComponentNode[] = mode === "add" ? entries.map((entry) => entry.node) : nodes;

  // Risky patterns: the importer's `patternForForm` never ran the kernel's check.
  const dropped = dropRiskyPatterns(placed);
  const warnings: string[] = [];
  const notes: string[] = model.notes.map((note) => note.message);
  if (dropped.size > 0) {
    for (const entry of comparison.entries) {
      const pattern = entry.incoming?.pattern;
      if (pattern !== undefined && dropped.has(pattern) && (mode === "replace" || entry.status === "new")) {
        const sentence = `pattern dropped on ${entry.path}: the risky-pattern check refuses it`;
        warnings.push(sentence);
        notes.push(sentence);
      }
    }
  }

  // The caps the import path lacks: the node caps of a hand-written list, then the server's
  // structure limits over the form the write would leave.
  const nodeCount = placed.reduce((sum, node) => sum + subtreeNodes(node).length, 0);
  if (placed.length > MAX_TOP_LEVEL) {
    throw tooLarge("fromData", MAX_TOP_LEVEL, placed.length);
  }
  if (nodeCount > MAX_NODES) {
    throw tooLarge("fromData", MAX_NODES, nodeCount);
  }
  const committed = controller.snapshot();
  let wouldBeRoot = committed;
  if (placed.length > 0) {
    try {
      const scratch = new ComponentTree(structuredClone(committed));
      if (mode === "add") {
        for (const entry of entries) {
          scratch.insert(structuredClone(entry.node), entry.parentId ?? rootId, entry.slotId ?? "content", entry.index);
        }
      } else {
        const live = committed.children ?? {};
        const kept = (live.content ?? []).filter((child) => keep.includes(child.id));
        scratch.replaceChildren(rootId, { ...live, content: [...structuredClone(nodes), ...kept] });
      }
      wouldBeRoot = scratch.getRoot();
    } catch {
      // The controller's own attempt reports why; the structure check below reads what could be built.
    }
    const problem = structureProblem(shared, wouldBeRoot);
    if (problem !== undefined) {
      throw structureRefusal(problem);
    }
  }

  const report: DataModelReport = {
    readAs: read.readAs,
    detected: read.detected,
    places: comparison.entries.filter((entry) => entry.incoming !== undefined).length,
    added: added.slice(0, ADDED_CAP).map((row) => {
      const top = placed.find((node) => node.id === row.componentId);
      const fit = comparison.byPath.get(row.path)?.fit === "approximate" ? "approximate" : "exact";
      const messages = row.notes.map((note) => note.message);
      return { path: row.path, componentId: row.componentId, type: top?.type ?? "", fit, ...(messages.length > 0 ? { notes: messages } : {}) };
    }),
    alreadyInForm: mode === "add" ? comparison.counts.present : 0,
    kindDiffers:
      mode === "add"
        ? comparison.entries
            .filter((entry) => entry.status === "kind-differs" && entry.incoming !== undefined && entry.form !== undefined)
            .slice(0, KIND_DIFFERS_CAP)
            .map((entry) => ({ path: entry.path, form: kindText(entry.form as { kind: string; format?: string }), incoming: kindText(entry.incoming as { kind: string; format?: string }) }))
        : [],
    skipped: skipped.slice(0, SKIPPED_CAP).map((row) => ({ path: row.path, reason: row.reason })),
    notes: notes.slice(0, NOTES_CAP)
  };
  if (added.length > ADDED_CAP) {
    report.notes = [...report.notes.slice(0, NOTES_CAP - 1), `added lists the first ${ADDED_CAP} of ${added.length} places`];
  }

  const rows = plannedRows(
    scope,
    mode === "add" ? entries : nodes.map((node) => ({ node, parentId: rootId, slotId: "content" })),
    rootId,
    mode === "replace"
  );
  const plan: ComponentPlan = {
    entries,
    nodes,
    ids: placed.map((node) => node.id),
    allIds: placed.flatMap((node) => subtreeIds(node)),
    generatedIds: {},
    rows,
    warnings,
    lints: [],
    wouldBeRoot
  };

  // The thunks plan again from the committed tree when the insert runs, as the importer's do
  // (the person may have saved or discarded something in between), with the same pattern drop.
  return {
    plan,
    report,
    entries: () => {
      const again = kit.planDataModelAdd(controller, model, scope.words).entries;
      dropRiskyPatterns(again.map((entry) => entry.node));
      return again;
    },
    nodes: () => {
      const again = kit.planDataModelReplace(controller, model, scope.words).nodes;
      dropRiskyPatterns(again);
      return again;
    },
    keep,
    empty: placed.length === 0
  };
}
