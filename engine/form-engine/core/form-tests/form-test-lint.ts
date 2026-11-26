import { normalizeDataGrids } from "../schema/data-grid.js";
import type { ComponentNode } from "../schema/types.js";
import { buildDataPaths, holdsData } from "../tree/data-scope.js";
import type { FormTestScenario } from "./form-test-types.js";

/**
 * Lints of a parsed scenario against the form it tests: advice beside a scenario that
 * still runs, never a parse problem and never a verdict. Only the builder's Tests panel and
 * `check_form` read them; neither driver does, and the sandbox's `test` op reports none.
 *
 * `tests.set.unknownPath`: a `set` names a path no component of the form stores an answer at
 * (a typo, a field renamed the scenario did not follow, a fieldset or a button). The step still
 * runs, as a test may send an unknown key on purpose to see the form strip it; the lint says
 * which path, so an accident is not a scenario that passes for the wrong reason.
 *
 * `tests.change.unknownPath`: a `change` names such a path. No Check answers step can list an
 * answer the form does not store, so the step is refused when it runs (`change.notListed`); the
 * lint says so as the line is written.
 */
export interface FormTestLint {
  code: "tests.set.unknownPath" | "tests.change.unknownPath";
  /** The step's 1-based line, and UTF-16 offsets of the path in the whole source (`start` inclusive, `end` exclusive). */
  line: number;
  start: number;
  end: number;
  params: { path: string };
}

/**
 * Where the form stores answers, as a test writes a path: `name`, `applicant.mail`, `items[].sku`
 * (a row's index read as `[]`), a repeating section or a data grid at its collection path. Only
 * the nodes that hold data (`holdsData`): a fieldset, a button or the root names no place.
 */
function knownPaths(root: ComponentNode): Set<string> {
  const normalized = normalizeDataGrids(root);
  const paths = buildDataPaths(normalized);
  const known = new Set<string>();
  const stack: ComponentNode[] = [normalized];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    if (node !== normalized && holdsData(node)) {
      const path = paths.get(node.id);
      if (path !== undefined) {
        known.add(path);
      }
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        stack.push(child);
      }
    }
  }
  return known;
}

/** The lints of `scenarios` against the form under `root`, in source order. */
export function formTestLints(scenarios: readonly FormTestScenario[], root: ComponentNode): FormTestLint[] {
  const known = knownPaths(root);
  const out: FormTestLint[] = [];
  for (const scenario of scenarios) {
    // Each step's path ref, in source order: a `set` or a `change` reads one path ref, its first on the line.
    let next = 0;
    for (const step of scenario.steps) {
      if (step.kind !== "set" && step.kind !== "change") {
        continue;
      }
      let at = next;
      while (at < scenario.refs.length) {
        const ref = scenario.refs[at] as FormTestScenario["refs"][number];
        if (ref.kind === "path" && ref.span.line === step.line && ref.text === step.path) {
          break;
        }
        at += 1;
      }
      const ref = scenario.refs[at];
      if (ref === undefined) {
        continue;
      }
      next = at + 1;
      if (!known.has(step.path.replace(/\[\d+\]/g, "[]"))) {
        out.push({ code: step.kind === "set" ? "tests.set.unknownPath" : "tests.change.unknownPath", line: step.line, start: ref.span.start, end: ref.span.end, params: { path: step.path } });
      }
    }
  }
  return out;
}
