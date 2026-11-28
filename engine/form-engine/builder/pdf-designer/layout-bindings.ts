/**
 * The form fields a PDF layout reads that the form no longer has.
 * A layout binds to the form by component id and by data path: a generated layout's fields,
 * repeats and tables, a populated form's field mappings and drawn areas. Deleting a component
 * on the Form side leaves those bindings standing and printing blank, and nothing said so; the
 * PDF layouts overview lists what is returned here as the layout's problems.
 *
 * Pure and static, over the definition as it stands: the overview repaints on every form change,
 * so a deleted field shows at once and an Undo that brings it back clears the problem. A source
 * is looked at the way the designer reads it (`missingFromSource` in the template designer): a
 * `component` by its id, a `path` or a formula by the leading name of each path it reads.
 */
import { isScopedExpressionPath } from "../../core/expressions/condition-shape.js";
import { kernelRuleExpression } from "../../core/expressions/compile.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import { journeyLeadingSegment } from "../../core/journey/journey-shared.js";
import type { PdfConfiguration } from "../../core/schema/pdf-layout.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { collectionPathOf, dataKeyOf } from "../../core/tree/data-scope.js";
import { extractDependencies } from "../../rules/dependencies/dependency-extractor.js";
import { pdfLayoutsOf } from "./layout-catalog.js";

/** One binding of a layout whose field the form does not have. */
export interface MissingBinding {
  layoutId: string;
  /** The name the layout reads that the form lacks: a component id, or the leading name of a path. */
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The node types of a generated layout that bind to the form, and the configuration key each binds by. */
const GENERATED_BINDINGS: Readonly<Record<string, { key: string; by: "id" | "path" }>> = {
  "pdf-field": { key: "componentId", by: "id" },
  "pdf-repeat": { key: "collectionPath", by: "path" },
  "pdf-table": { key: "collectionPath", by: "path" }
};

const SIGNATURES = /* @__PURE__ */ formulaFunctionSignatures();

/** The value paths a formula source reads; none for one that does not parse (it prints blank on its own, and the designer says so). */
function formulaPaths(expression: unknown): string[] {
  const tree = kernelRuleExpression(expression, kernelParseFormula, SIGNATURES);
  return tree === undefined ? [] : [...extractDependencies(tree)];
}

/**
 * The bindings of every layout in `configuration` that name something `formRoot` does not hold,
 * once per layout and name, in the order the layouts and their bindings come.
 */
export function missingLayoutBindings(formRoot: ComponentNode, configuration: PdfConfiguration | undefined): MissingBinding[] {
  const ids = new Set<string>();
  // The names a path may lead with: an id, a data key, or where a section keeps its entries.
  const names = new Set<string>();
  const visit = (node: ComponentNode): void => {
    ids.add(node.id);
    names.add(node.id);
    names.add(dataKeyOf(node));
    const collection = collectionPathOf(node);
    if (collection !== undefined) {
      names.add(journeyLeadingSegment(collection));
    }
    for (const group of Object.values(node.children ?? {})) {
      group.forEach(visit);
    }
  };
  visit(formRoot);

  const out: MissingBinding[] = [];
  for (const layout of pdfLayoutsOf(configuration)) {
    const seen = new Set<string>();
    const lack = (name: string): void => {
      if (name !== "" && !seen.has(name)) {
        seen.add(name);
        out.push({ layoutId: layout.id, name });
      }
    };
    const checkPath = (path: unknown): void => {
      if (typeof path !== "string") {
        return;
      }
      const leading = journeyLeadingSegment(path);
      // `row.` and the host and ancestor scopes name no field of this form.
      if (leading !== "" && !isScopedExpressionPath(path) && !names.has(leading)) {
        lack(leading);
      }
    };
    const checkSource = (source: unknown): void => {
      if (!isRecord(source)) {
        return;
      }
      if (source.kind === "component" && typeof source.componentId === "string" && !ids.has(source.componentId)) {
        lack(source.componentId);
      } else if (source.kind === "path") {
        checkPath(source.path);
      } else if (source.kind === "expression") {
        formulaPaths(source.expression).forEach(checkPath);
      }
    };
    if (layout.kind === "generated") {
      const walk = (node: ComponentNode): void => {
        const binding = GENERATED_BINDINGS[node.type];
        const bound = binding && isRecord(node.configuration) ? node.configuration[binding.key] : undefined;
        if (binding && typeof bound === "string" && bound !== "") {
          if (binding.by === "id") {
            if (!ids.has(bound)) {
              lack(bound);
            }
          } else {
            checkPath(bound);
          }
        }
        for (const group of Object.values(node.children ?? {})) {
          group.forEach(walk);
        }
      };
      walk(layout.root);
    } else {
      for (const mapping of layout.fields) {
        checkSource(mapping.source);
      }
      for (const area of layout.areas ?? []) {
        checkSource(area.source);
      }
    }
  }
  return out;
}
