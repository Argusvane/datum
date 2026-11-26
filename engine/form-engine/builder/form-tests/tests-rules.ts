/**
 * Which rule decides a failed expectation (Open rule): the failure card
 * offers "Open rule" when the expectation reads something a rule of the target decides, and the
 * shell opens the Logic workspace on that component. The map runs from the
 * step code the judge reports to the rule key the expectation reads; whether a rule of that kind
 * exists on the component is read from the tree, so the button is offered only where there is a
 * rule to open.
 *
 * Kinds are the component's rule keys (`visibleWhen`, `requiredWhen`, ...) and `calculate` for
 * the rule that works an answer out (stored under `rules.value`): the vocabulary of the
 * `builder-tests-open-rule` event's `kind`.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import { buildValuePaths } from "../../core/tree/data-scope.js";
import type { FormTestStepResult } from "../../core/form-tests/form-test-types.js";

export type TestsRuleKind = "visibleWhen" | "requiredWhen" | "enabledWhen" | "readonlyWhen" | "validWhen" | "calculate";

/** The key a kind is stored under in a component's `rules`. */
const RULE_KEY: Record<TestsRuleKind, string> = {
  visibleWhen: "visibleWhen",
  requiredWhen: "requiredWhen",
  enabledWhen: "enabledWhen",
  readonlyWhen: "readonlyWhen",
  validWhen: "validWhen",
  calculate: "value"
};

/**
 * The rule kind a step code reads, or `undefined` when no rule of a component decides it (a
 * page, a verdict, a row count, a layout). `expect.error` and `expect.noError` are the checks of
 * a `validWhen` only when the error's code is `rule`: `params.code` carries it (an
 * `expect.error` step's `expected` is the code, so {@link decidingRuleOf} fills it in).
 */
export function decidingRuleKind(code: string, params?: Record<string, unknown>): TestsRuleKind | undefined {
  switch (code) {
    case "expect.visible":
    case "expect.hidden":
      return "visibleWhen";
    case "expect.required":
    case "expect.optional":
      return "requiredWhen";
    case "expect.enabled":
    case "expect.disabled":
      return "enabledWhen";
    case "expect.readonly":
    case "expect.editable":
      return "readonlyWhen";
    case "expect.error":
    case "expect.noError":
      return params !== undefined && params["code"] === "rule" ? "validWhen" : undefined;
    case "expect.value":
    case "expect.formula":
      return "calculate";
    default:
      return undefined;
  }
}

function findNode(node: ComponentNode, id: string): ComponentNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const group of Object.values(node.children ?? {})) {
    for (const child of group) {
      const found = findNode(child, id);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * Whether the component carries a rule of that kind. Read from the tree's `rules` as the Logic
 * model lists them (a rule that is absent or `null` is not one), which is cheaper than building
 * the whole model for a yes or no and cannot disagree with it.
 */
export function decidingRule(root: ComponentNode, componentId: string, kind: TestsRuleKind): boolean {
  const node = findNode(root, componentId);
  if (node === undefined || node.rules === undefined || node.rules === null) {
    return false;
  }
  const source = (node.rules as Record<string, unknown>)[RULE_KEY[kind]];
  return source !== undefined && source !== null;
}

/**
 * The component a value path names, with any row index dropped (`items[1].qty` is the `qty`
 * field of the section), or a component id given as it is. A path wins over an id, as in a test.
 */
export function componentIdOfPath(root: ComponentNode, path: string): string | undefined {
  const bare = path.replace(/\[\d+\]/g, "");
  for (const [id, valuePath] of buildValuePaths(root)) {
    if (id !== root.id && valuePath === bare) {
      return id;
    }
  }
  return findNode(root, path)?.id;
}

/**
 * The component and rule kind to open for a failed step, or `undefined` when there is no rule to
 * open: the code decides no rule, the step names no component (a formula), or the component has
 * no rule of that kind (a field that is required by its settings, not by a rule).
 */
export function decidingRuleOf(root: ComponentNode, step: FormTestStepResult): { componentId: string; kind: TestsRuleKind } | undefined {
  if (step.code === undefined) {
    return undefined;
  }
  let path = typeof step.params?.["path"] === "string" ? step.params["path"] : undefined;
  let errorCode: string | undefined;
  if (step.code === "expect.error") {
    errorCode = typeof step.expected === "string" ? step.expected : undefined;
  } else if (step.code === "expect.noError") {
    // The errors that stand: the first one a rule raised is the rule to open.
    const found = Array.isArray(step.actual) ? step.actual : [];
    for (const entry of found) {
      const record = entry as Record<string, unknown> | null;
      if (record !== null && typeof record === "object" && record["code"] === "rule") {
        errorCode = "rule";
        path ??= typeof record["path"] === "string" ? record["path"] : typeof record["componentId"] === "string" ? record["componentId"] : undefined;
        break;
      }
    }
  }
  const kind = decidingRuleKind(step.code, errorCode === undefined ? step.params : { ...step.params, code: errorCode });
  if (kind === undefined || path === undefined) {
    return undefined;
  }
  const componentId = componentIdOfPath(root, path);
  return componentId !== undefined && decidingRule(root, componentId, kind) ? { componentId, kind } : undefined;
}
