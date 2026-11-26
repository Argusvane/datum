import type { Expression } from "../../core/expressions/expression.js";
import { kernelFindCalculationCycle } from "./calculation-cycle.js";
import { extractDependencies } from "./dependency-extractor.js";

/**
 * Maps rule dependencies to the components whose rules must be recomputed when a value
 * changes, and detects calculation cycles.
 *
 * Only form-scoped, non-prefixed dependency paths participate in `affectedBy` — `row.`,
 * `ancestor.`, `component`, and `host.` references are contextual and recomputed on every
 * pass regardless.
 */
export class DependencyGraph {
  /** dependency path -> component ids whose rules read it */
  private readonly dependents = new Map<string, Set<string>>();
  /** component id -> the form-scoped paths its rules read */
  private readonly reads = new Map<string, Set<string>>();
  /** component id -> component ids it consumes as calculation inputs */
  private readonly calcInputs = new Map<string, Set<string>>();

  public registerRule(componentId: string, expression: Expression, isCalculation = false): void {
    const deps = extractDependencies(expression);
    for (const dep of deps) {
      if (isContextualScope(dep)) {
        continue;
      }
      const rootId = leadingSegment(dep);
      addTo(this.dependents, rootId, componentId);
      addTo(this.reads, componentId, rootId);
      if (isCalculation) {
        addTo(this.calcInputs, componentId, rootId);
      }
    }
  }

  /** Component ids whose rules read any of the changed paths (direct + transitive calc). */
  public affectedBy(changedPaths: string[]): string[] {
    const result = new Set<string>();
    const queue = [...changedPaths.map(leadingSegment)];

    while (queue.length > 0) {
      const path = queue.shift();
      if (path === undefined) {
        continue;
      }
      for (const dependent of this.dependents.get(path) ?? []) {
        if (!result.has(dependent)) {
          result.add(dependent);
          // A calculation's output can feed another rule: follow the chain.
          queue.push(dependent);
        }
      }
    }

    return [...result];
  }

  public dependenciesOf(componentId: string): string[] {
    return [...(this.reads.get(componentId) ?? [])];
  }

  /**
   * Returns a calculation cycle as an ordered id list if one exists, else `undefined`.
   * A cycle means calc(A) reads B and calc(B) reads A (directly or transitively).
   */
  public findCalculationCycle(): string[] | undefined {
    // The same check the sandbox kernel names a non-settling recompute's cycle with.
    const ids = [...this.calcInputs.keys()];
    const inputs = ids.map((id) => [...(this.calcInputs.get(id) ?? [])]);
    return kernelFindCalculationCycle(ids, inputs);
  }
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
  } else {
    map.set(key, new Set([value]));
  }
}

function isContextualScope(path: string): boolean {
  return (
    path === "component" ||
    path.startsWith("component.") ||
    path.startsWith("row.") ||
    path.startsWith("ancestor.") ||
    path.startsWith("host.")
  );
}

function leadingSegment(pathKey: string): string {
  const bracket = pathKey.indexOf("[");
  const dot = pathKey.indexOf(".");
  const candidates = [bracket, dot].filter((index) => index >= 0);
  if (candidates.length === 0) {
    return pathKey;
  }
  return pathKey.slice(0, Math.min(...candidates));
}
