import { childrenOf, indexDataModel, type DataModel, type DataModelNode } from "./data-model.js";
import { mappingFor, type DataModelFit } from "./mapping.js";

/**
 * How a place in an incoming model stands against the form: `new` — the form has
 * nothing there; `present` — the form holds it, in a kind that can hold what comes in;
 * `kind-differs` — the form holds something else there; `form-only` — the form holds a place
 * the incoming model does not name.
 */
export type DataModelStatus = "new" | "present" | "kind-differs" | "form-only";

export interface DataModelComparisonEntry {
  path: string;
  status: DataModelStatus;
  /** For an incoming place: how well a component would hold it. */
  fit?: DataModelFit;
  incoming?: DataModelNode;
  form?: DataModelNode;
  /** The incoming place's parent (`""` for the document; `items[]` for an entry's field). */
  parentPath: string;
  /** Levels below the document, for drawing a tree. */
  depth: number;
  /** For a place whose kind differs: how many places below it were not compared. */
  hidden?: number;
}

export interface DataModelComparison {
  /** Incoming places in order, then the form's own at the end. */
  entries: DataModelComparisonEntry[];
  byPath: ReadonlyMap<string, DataModelComparisonEntry>;
  counts: Record<DataModelStatus | "unsupported", number>;
}

type Family = "string" | "number" | "boolean" | "object" | "flags" | "list" | "list-of-objects" | "file" | "files" | "any";

function familyOf(node: DataModelNode): Family {
  switch (node.kind) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return node.format === "flags" ? "flags" : "object";
    case "array":
      return node.items?.kind === "object" ? "list-of-objects" : node.items?.kind === "file" ? "files" : "list";
    case "file":
      return "file";
    default:
      return "any";
  }
}

/**
 * Whether the form's place can hold what comes in: the same kind, or the shape the builder
 * itself would have made for it — text for a list of plain values, one object of booleans for
 * a list of choices, a choice's text for a number choice.
 */
function holds(incoming: DataModelNode, form: DataModelNode): boolean {
  const wanted = familyOf(incoming);
  const held = familyOf(form);
  if (wanted === "any" || held === "any" || wanted === held) {
    return true;
  }
  if (wanted === "list" && (held === "string" || held === "flags")) {
    return true;
  }
  if ((wanted === "object" && held === "flags") || (wanted === "flags" && held === "object")) {
    return true;
  }
  if ((wanted === "file" && held === "files") || (wanted === "files" && held === "file")) {
    return true;
  }
  return wanted === "number" && held === "string" && (incoming.options?.length ?? 0) > 0;
}

function countBelow(node: DataModelNode): number {
  let count = 0;
  for (const child of childrenOf(node)) {
    count += (child.key === "" ? 0 : 1) + countBelow(child);
  }
  return count;
}

/**
 * Lays an incoming model over the form's, place by place (matched by path), saying which
 * places are new, which the form already holds, and which it holds as something else; then
 * the form's places the incoming model leaves out. `hasType` decides each incoming place's fit.
 */
export function compareDataModels(
  form: DataModel,
  incoming: DataModel,
  options: { hasType?: (type: string) => boolean } = {}
): DataModelComparison {
  const hasType = options.hasType ?? (() => true);
  const formIndex = indexDataModel(form);
  const entries: DataModelComparisonEntry[] = [];
  const seen = new Set<string>([""]);
  /** Places whose kinds differ: what the form holds below them is not the incoming model's either. */
  const differing = new Set<string>();

  const visit = (node: DataModelNode, parentPath: string, depth: number, underNew: boolean): void => {
    for (const child of childrenOf(node)) {
      if (child.key === "") {
        // A list's entry node: its places are compared, not the entry itself.
        seen.add(child.path);
        visit(child, child.path, depth, underNew);
        continue;
      }
      seen.add(child.path);
      const inEntry = child.path.includes("[]");
      const fit = mappingFor(child, hasType, inEntry).fit;
      const formNode = underNew ? undefined : formIndex.get(child.path);
      if (!formNode) {
        entries.push({ path: child.path, status: "new", fit, incoming: child, parentPath, depth });
        visit(child, child.path, depth + 1, true);
        continue;
      }
      if (!holds(child, formNode)) {
        differing.add(child.path);
        const hidden = countBelow(child);
        entries.push({ path: child.path, status: "kind-differs", fit, incoming: child, form: formNode, parentPath, depth, ...(hidden > 0 ? { hidden } : {}) });
        continue;
      }
      entries.push({ path: child.path, status: "present", fit, incoming: child, form: formNode, parentPath, depth });
      visit(child, child.path, depth + 1, false);
    }
  };
  visit(incoming.root, "", 0, false);

  // The form's own places the incoming model leaves out — the top of each, not what it holds.
  const formOnly = (node: DataModelNode, parentPath: string, depth: number): void => {
    for (const child of childrenOf(node)) {
      if (child.key === "") {
        formOnly(child, child.path, depth);
        continue;
      }
      if (differing.has(child.path)) {
        continue;
      }
      if (!seen.has(child.path) && child.componentId !== undefined) {
        entries.push({ path: child.path, status: "form-only", form: child, parentPath, depth });
        continue;
      }
      formOnly(child, child.path, depth + 1);
    }
  };
  formOnly(form.root, "", 0);

  const counts: Record<DataModelStatus | "unsupported", number> = { new: 0, present: 0, "kind-differs": 0, "form-only": 0, unsupported: 0 };
  const byPath = new Map<string, DataModelComparisonEntry>();
  for (const entry of entries) {
    counts[entry.status] += 1;
    if (entry.fit === "unsupported" && entry.status === "new") {
      counts.unsupported += 1;
    }
    if (!byPath.has(entry.path)) {
      byPath.set(entry.path, entry);
    }
  }
  return { entries, byPath, counts };
}
