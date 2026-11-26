/**
 * The structure gate a bare controller writes under: what `definitionLoadProblem` refuses in packages/datum (`support.ts`), rebuilt from the
 * same kernel pass so `structure-limit` holds in the engine's tests. The element passes its own
 * function through `host.definitionProblem`, and this one is used only when it does not.
 *
 * Two parts, in the loader's order: the depth the server reads at most, counted with an
 * explicit stack so a deep tree is answered and never a RangeError; then the refusals of the
 * server's structure pass (a size past a cap, an id the form cannot address, a prototype-named
 * key, a name past its length). The pass's other findings are `check_form`'s warnings.
 */
import { kernelStructureCheck, kernelStructureLimits, kernelStructureMessage } from "../../core/expressions/definition-structure.js";
import type { FormDefinition } from "../../core/schema/types.js";

/** The same refusals `support.ts` keeps from the kernel pass. */
const STRUCTURE_REFUSALS = /\.tooMany$|^definition\.tooManyComponents$|^component\.id\.invalid$|\.prototype$|\.tooLong$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first level past the server's depth, as `definitionDepthProblem` words it; a journey page's own nodes measured from level 1. */
function depthProblem(root: unknown, journey: unknown): string | undefined {
  const limit = kernelStructureLimits().depth;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 1 }];
  const journeys = isRecord(journey) && Array.isArray(journey.journeys) ? journey.journeys : [];
  for (const one of journeys) {
    for (const page of isRecord(one) && Array.isArray(one.pages) ? one.pages : []) {
      for (const entry of isRecord(page) && Array.isArray(page.components) ? page.components : []) {
        if (isRecord(entry)) {
          stack.push({ node: entry, depth: 1 });
        }
      }
    }
  }
  // A node met twice is its own ancestor (or shared): measured once, so a cycle cannot loop.
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (!isRecord(node) || !isRecord(node.children) || seen.has(node)) {
      continue;
    }
    seen.add(node);
    if (depth >= limit) {
      return `Components nest more than ${limit} levels deep: the validator reads at most ${limit}.`;
    }
    for (const group of Object.values(node.children)) {
      if (Array.isArray(group)) {
        for (const child of group) {
          stack.push({ node: child, depth: depth + 1 });
        }
      }
    }
  }
  return undefined;
}

/** What would stop the builder taking `definition`, in words; `undefined` when nothing would. */
export function structureProblemOf(definition: FormDefinition): string | undefined {
  const record = definition as unknown as Record<string, unknown>;
  const deep = depthProblem(record.root, record.journey);
  if (deep !== undefined) {
    return deep;
  }
  const found = kernelStructureCheck(record, undefined);
  const refusal = found.structure.find((entry) => found.sizeGate || STRUCTURE_REFUSALS.test(entry.code));
  if (refusal === undefined) {
    return undefined;
  }
  return `${refusal.where}: ${refusal.message ?? kernelStructureMessage(refusal.code, refusal.limit)}`;
}
