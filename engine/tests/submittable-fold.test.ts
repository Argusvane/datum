import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import { JOURNEY_PATH_FUNCTIONS, journeyOwnership, journeyPath, journeyPlacements } from "../form-engine/core/journey/journey-path.js";
import * as journeyShared from "../form-engine/core/journey/journey-shared.js";
import type { JourneyPathInput, JourneyPlacement, JourneyTrace } from "../form-engine/core/journey/journey-types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SUBMITTABLE_FOLD_FUNCTIONS,
  kernelApplyValuePolicy,
  kernelFoldHoldsOwnAnswer,
  kernelFoldInSection,
  kernelFoldSubmittable,
  kernelFoldVisibilityReadsHost,
  kernelFoldRequiredReadsHost,
  kernelFoldRelaxUnreplayable,
  kernelFoldRowBounds,
  kernelCompiledRule,
  kernelRuleSkipped,
  kernelJsonAnswers,
  kernelJsonValue,
  kernelPlacedSemanticState,
  type KernelFoldInput,
  type KernelFoldResult
} from "../form-engine/core/state/submittable-fold.js";
import { buildComponentIdsByPath, buildValuePaths, holdsData, isDataScopeContainer } from "../form-engine/core/tree/data-scope.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { evaluateExpression } from "../form-engine/rules/evaluator/evaluator.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { RulesSemanticStateResolver } from "../form-engine/runtime/browser/runtime-orchestrator.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import {
  PORTABLE_KERNEL_FUNCTIONS,
  kernelCollectionOwners,
  kernelFoldSubmission,
  kernelNormalizeDataGrids,
  kernelTreeIndex,
  runKernel
} from "../form-engine/validation/wasm/portable-kernel.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { kernelCompileNode } from "../form-engine/core/expressions/compile.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import type { FormulaProblem } from "../form-engine/core/expressions/formula-types.js";

function field(id: string, configuration: Record<string, unknown> = {}, rules?: ComponentNode["rules"]): ComponentNode {
  const node: ComponentNode = { id, type: "text", configuration: { label: id, ...configuration } };
  if (rules !== undefined) {
    node.rules = rules;
  }
  return node;
}

function group(id: string, type: string, children: ComponentNode[], configuration: Record<string, unknown> = {}): ComponentNode {
  return { id, type, configuration: { label: id, ...configuration }, children: { content: children } };
}

function form(...children: ComponentNode[]): ComponentNode {
  return group("form", "form", children);
}

function eq(path: string, value: string | number | boolean | null): Expression {
  return { kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value } };
}

function neq(path: string, value: string | number | boolean | null): Expression {
  return { kind: "binary", operator: "neq", left: { kind: "path", path }, right: { kind: "literal", value } };
}

const EXCLUDE = { hiddenValueBehavior: "exclude-from-submission" };
const RETAIN = { hiddenValueBehavior: "retain" };

/**
 * The fold's input for a tree, built the way the browser runtime builds it: value paths and
 * their owners from `data-scope.ts`, and each node's own state from the runtime's rules
 * resolver over the view the fold hands it.
 */
function foldInput(root: ComponentNode, values: Record<string, unknown>, journey?: Journey, hostContext: Record<string, unknown> = {}): KernelFoldInput {
  const order: string[] = [];
  const nodeById: Record<string, ComponentNode> = {};
  const parentOf: Record<string, string> = {};
  const walk = (node: ComponentNode): void => {
    order.push(node.id);
    nodeById[node.id] = node;
    for (const children of Object.values(node.children ?? {})) {
      for (const child of children) {
        parentOf[child.id] = node.id;
        walk(child);
      }
    }
  };
  walk(root);

  const pathOf = Object.fromEntries(buildValuePaths(root));
  const idsByPath = Object.fromEntries(buildComponentIdsByPath(root));
  const resolver = new RulesSemanticStateResolver();
  const ancestorValuesFor = (componentId: string, pathValues: Record<string, unknown>): Record<string, unknown> => {
    const record: Record<string, unknown> = {};
    let parent = parentOf[componentId];
    while (parent !== undefined) {
      record[parent] = pathValues[pathOf[parent] ?? parent];
      parent = parentOf[parent];
    }
    return record;
  };
  const input: KernelFoldInput = {
    order,
    nodeById,
    parentOf,
    values,
    pathOf,
    idsByPath,
    resolve: (node, idValues, pathValues) =>
      resolver.resolve(node, {
        values: idValues,
        locale: "en",
        hostContext,
        valueOf: (componentId) => pathValues[pathOf[componentId] ?? componentId],
        ancestorValuesFor: (componentId) => ancestorValuesFor(componentId, pathValues)
      }),
    // The browser orchestrator's reading of a `requiredWhen`, over the same context — the host's included.
    ruleRequired: (node, idValues, pathValues) =>
      Boolean(
        evaluateExpression(node.rules?.requiredWhen as Expression, {
          values: idValues,
          hostContext,
          componentValue: pathValues[pathOf[node.id] ?? node.id],
          ancestorValues: ancestorValuesFor(node.id, pathValues)
        })
      )
  };
  if (journey !== undefined) {
    input.journey = {
      journey,
      ownership: journeyOwnership(root, journey),
      path: journeyPath,
      place: journeyPlacements,
      evaluate: (expression, idValues) => evaluateExpression(expression, { values: idValues })
    };
  }
  return input;
}

/**
 * The fold's records have no prototype (so a key such as `constructor` is a key like any
 * other); a strict comparison with a literal spreads one into an ordinary object first.
 */
function fold(root: ComponentNode, values: Record<string, unknown>, journey?: Journey, hostContext?: Record<string, unknown>): KernelFoldResult {
  return kernelFoldSubmittable(foldInput(root, values, journey, hostContext));
}

describe("kernelFoldSubmittable without a journey", () => {
  it("converges in one pass when nothing is hidden", () => {
    const root = form(field("name"), field("age"));
    const values = { name: "Ada", age: 36, "rows[0].x": 1 };
    const result = fold(root, values);
    expect(result.converged).toBe(true);
    expect(result.passes).toBe(1);
    expect({ ...result.submittable }).toStrictEqual(values);
    expect({ ...result.idValues }).toStrictEqual(values);
    expect(result.trace).toBeUndefined();
    expect(result.placements).toBeUndefined();
    expect(result.effective.name).toMatchObject({ visible: true, runValidation: true, requiredApplies: true, submitValue: true });
  });

  it("stops a hidden, excluded answer from feeding another field's visibility", () => {
    // `secret` is hidden and never submitted. Its answer used to show `follow` (one pass over
    // the raw answers); a server, which never sees `secret`, would hide it. The fold reads the
    // submittable view, so the browser hides it too.
    const root = form(
      field("secret", { hidden: true, ...EXCLUDE }),
      field("follow", EXCLUDE, { visibleWhen: eq("secret", "yes") })
    );
    const result = fold(root, { secret: "yes", follow: "shown?" });
    expect(result.effective.follow?.visible).toBe(false);
    expect(result.effective.follow?.runValidation).toBe(false);
    expect({ ...result.submittable }).toStrictEqual({});
    expect(result.converged).toBe(true);
    expect(result.passes).toBe(3);
  });

  it("follows the same through a field hidden by its own rule", () => {
    const root = form(
      field("mode"),
      field("detail", EXCLUDE, { visibleWhen: eq("mode", "detailed") }),
      field("note", EXCLUDE, { visibleWhen: eq("detail", "long") })
    );
    const hidden = fold(root, { mode: "simple", detail: "long", note: "n" });
    expect(hidden.effective.note?.visible).toBe(false);
    expect({ ...hidden.submittable }).toStrictEqual({ mode: "simple" });

    const shown = fold(root, { mode: "detailed", detail: "long", note: "n" });
    expect(shown.effective.note?.visible).toBe(true);
    expect({ ...shown.submittable }).toStrictEqual({ mode: "detailed", detail: "long", note: "n" });
  });

  it("gives up after ten passes when rules feed each other through hidden answers", () => {
    // Written with empty() so each rule is a real yes or no: a condition holds only for true (strict truthiness).
    const isEmpty = (id: string): Expression => ({ kind: "call", name: "empty", args: [{ kind: "path", path: id }] });
    const root = form(
      field("a", EXCLUDE, { visibleWhen: isEmpty("b") }),
      field("b", EXCLUDE, { visibleWhen: { kind: "unary", operator: "not", operand: isEmpty("a") } })
    );
    const result = fold(root, { a: 1, b: 1 });
    expect(result.converged).toBe(false);
    expect(result.passes).toBe(10);
  });
});

describe("kernelFoldSubmittable with a journey", () => {
  /** An eligibility question, a conditional page holding a section with a keyed field under a keyed container, and a last page. */
  const root = form(
    field("eligible"),
    group("extra", "fieldset", [group("details", "container", [field("income", { dataKey: "amount" })], { dataKey: "info" })]),
    field("name")
  );
  const journey: Journey = {
    id: "apply",
    pages: [
      { id: "start", components: ["eligible"], routes: [{ when: neq("eligible", "yes"), to: "last" }] },
      { id: "more", components: ["extra"] },
      { id: "last", components: ["name"] }
    ]
  };

  it("leaves an off-path section's answers out of the submission, under a container and a data key", () => {
    const result = fold(root, { eligible: "no", "info.amount": 500, name: "Ada" }, journey);
    expect(result.trace?.pages).toEqual(["start", "last"]);
    expect(result.placements).toMatchObject({ extra: "off", details: "off", income: "off", eligible: "on", name: "on" });
    expect({ ...result.submittable }).toStrictEqual({ eligible: "no", name: "Ada" });
    expect({ ...result.idValues }).toStrictEqual({ eligible: "no", name: "Ada" });
    expect(result.effective.income).toMatchObject({ visible: false, runValidation: false, requiredApplies: false, submitValue: false });
    expect(result.semantic.income?.hiddenValueBehavior).toBe("exclude-from-submission");
  });

  it("submits the section's answers once the path takes its page", () => {
    const result = fold(root, { eligible: "yes", "info.amount": 500, name: "Ada" }, journey);
    expect(result.trace?.pages).toEqual(["start", "more", "last"]);
    expect({ ...result.submittable }).toStrictEqual({ eligible: "yes", "info.amount": 500, name: "Ada" });
    expect(result.idValues.income).toBe(500);
    expect(result.effective.income).toMatchObject({ visible: true, runValidation: true });
  });

  it("keeps off-path answers by the journey's offPathValues, unless the component says otherwise", () => {
    const retained = fold(root, { eligible: "no", "info.amount": 500, name: "Ada" }, { ...journey, offPathValues: "retain" });
    expect({ ...retained.submittable }).toStrictEqual({ eligible: "no", "info.amount": 500, name: "Ada" });
    expect(retained.effective.income?.runValidation).toBe(false);

    const cleared = form(
      field("eligible"),
      group("extra", "fieldset", [group("details", "container", [field("income", { dataKey: "amount", hiddenValueBehavior: "clear" })], { dataKey: "info" })]),
      field("name")
    );
    const result = fold(cleared, { eligible: "no", "info.amount": 500, name: "Ada" }, { ...journey, offPathValues: "retain" });
    expect({ ...result.submittable }).toStrictEqual({ eligible: "no", "info.amount": undefined, name: "Ada" });
    expect("info.amount" in result.submittable).toBe(true);
  });

  // A component on no page is not folded to hidden, nor left unvalidated or unrequired.
  // Form rules always hold: such a component is folded
  // exactly as the whole form folds it — bar one whose visibility (its own rule's or an
  // ancestor's) reads `host.`, which gets a lenient fold on both sides, since the
  // server cannot replay the host.
  describe("folds a component on no page as the whole form would", () => {
    const only: Journey = { id: "short", pages: [{ id: "only", components: ["eligible"] }] };
    const staff = eq("host.role", "staff");

    it("keeps its own visibility, requiredness and value behaviour", () => {
      const tree = form(
        field("eligible"),
        field("reference", { required: true }),
        field("scratch", EXCLUDE),
        field("secret", EXCLUDE, { visibleWhen: eq("eligible", "never") }),
        field("kept", RETAIN, { visibleWhen: eq("eligible", "never") })
      );
      const result = fold(tree, { eligible: "yes", reference: "R-1", scratch: "s", secret: "x", kept: "k" }, only);
      expect(result.placements).toMatchObject({ reference: "unassigned", scratch: "unassigned", secret: "unassigned", kept: "unassigned" });
      // Shown on the form, so shown here: required, validated, submitted — `scratch` too, whatever it says about hiding.
      expect(result.effective.reference).toMatchObject({ visible: true, requiredApplies: true, runValidation: true, submitValue: true });
      expect(result.required.reference).toBe(true);
      expect(result.effective.scratch).toMatchObject({ visible: true, submitValue: true });
      // Hidden by its own rule on the form, so hidden here: its own value behaviour decides.
      expect(result.effective.secret).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: false });
      expect(result.effective.kept).toMatchObject({ visible: false, requiredApplies: false, submitValue: true });
      expect({ ...result.submittable }).toStrictEqual({ eligible: "yes", reference: "R-1", scratch: "s", kept: "k" });
      // The same fold the whole form gives these answers.
      const whole = fold(tree, { eligible: "yes", reference: "R-1", scratch: "s", secret: "x", kept: "k" });
      for (const id of ["reference", "scratch", "secret", "kept"]) {
        expect(result.effective[id], id).toEqual(whole.effective[id]);
      }
    });

    it("holds a hidden field that opts in to being required and validated", () => {
      const tree = form(field("eligible"), field("reference", { hidden: true, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" }));
      const result = fold(tree, { eligible: "yes" }, only);
      expect(result.placements?.reference).toBe("unassigned");
      expect(result.effective.reference).toMatchObject({ visible: false, requiredApplies: true, runValidation: true, submitValue: true });
      expect(result.effective.reference).toEqual(fold(tree, { eligible: "yes" }).effective.reference);
    });

    it("keeps the earlier lenient fold for a field whose own visibility reads host.: hidden, unchecked and not required on both sides, its answer by its own behaviour", () => {
      const tree = form(field("eligible"), field("staff_ref", { required: true }, { visibleWhen: staff }), field("staff_note", EXCLUDE, { visibleWhen: staff }));
      // A server has no host context: on the whole form it leaves the rule unevaluated and
      // requires `staff_ref`, while the browser follows the host. A field on no page is on no
      // screen, so the two sides would part on a verdict nobody can act on; both keep the
      // lenient fold instead — hidden, skipped, not required, its answer kept by its own
      // behaviour (retained, or excluded when it says so), whatever the host says.
      const lenient = { visible: false, disabled: false, readonly: false, hiddenValueBehavior: "retain", hiddenValidationBehavior: "skip", hiddenRequiredBehavior: "not-required" };
      for (const role of ["staff", "public"]) {
        const result = fold(tree, { eligible: "yes", staff_ref: "S-1", staff_note: "n" }, only, { role });
        expect(result.placements, role).toMatchObject({ staff_ref: "unassigned", staff_note: "unassigned" });
        expect(result.semantic.staff_ref, role).toEqual(lenient);
        expect(result.semantic.staff_note, role).toEqual({ ...lenient, hiddenValueBehavior: "exclude-from-submission" });
        expect(result.effective.staff_ref, role).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: true });
        expect(result.effective.staff_note, role).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: false });
        expect({ ...result.submittable }, role).toStrictEqual({ eligible: "yes", staff_ref: "S-1" });
      }
      // The browser's whole form follows the host — shown and required for staff, hidden for the
      // public — and a server's whole form requires it whatever the host says. The journey is
      // laxer than that server (a known gap), but the same on every side.
      expect(fold(tree, { eligible: "yes" }, undefined, { role: "staff" }).effective.staff_ref).toMatchObject({ visible: true, requiredApplies: true });
      expect(fold(tree, { eligible: "yes" }, undefined, { role: "public" }).effective.staff_ref).toMatchObject({ visible: false, requiredApplies: false });
      // An opt-in does not lift it: the lenient fold is the earlier fold, whole.
      const configured = form(
        field("eligible"),
        field("staff_ref", { required: true, hidden: true, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" }, { visibleWhen: staff })
      );
      expect(fold(configured, { eligible: "yes" }, only, { role: "staff" }).effective.staff_ref).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: true });
      expect(fold(configured, { eligible: "yes" }).effective.staff_ref).toMatchObject({ visible: false, requiredApplies: true, runValidation: true });
    });

    it("reads an ancestor's host-bound visibility the same way: a field on no page under a host-shown fieldset is hidden and unchecked on both sides, whether the fieldset holds a listed field or is on no page itself", () => {
      // `box` is structural (its `shown` is on a page); `ref` beside it is on no page. Before,
      // `ref` followed the box — required for staff in the browser, required on a server that
      // cannot evaluate the rule, not required for the public in the browser: a browser that
      // accepted for the public sent what every server refused.
      const tree = form(field("eligible"), group("box", "fieldset", [field("shown", { required: true }), field("ref", { required: true })], {}));
      (tree.children!.content![1] as ComponentNode).rules = { visibleWhen: staff };
      const journey: Journey = { id: "short", pages: [{ id: "only", components: ["eligible", "shown"] }] };
      for (const role of ["staff", "public"]) {
        const result = fold(tree, { eligible: "yes", shown: "s", ref: "r" }, journey, { role });
        expect(result.placements, role).toMatchObject({ shown: "on", ref: "unassigned" });
        expect(result.placements?.box, role).toBeUndefined();
        // The structural box keeps its own state, host rule evaluated, and `shown` follows it as on the whole form…
        const whole = fold(tree, { eligible: "yes", shown: "s", ref: "r" }, undefined, { role });
        for (const id of ["box", "shown"]) {
          expect(result.effective[id], `${role} ${id}`).toEqual(whole.effective[id]);
        }
        expect(result.effective.shown, role).toMatchObject({ visible: role === "staff", requiredApplies: role === "staff" });
        // …while `ref`, on no page, is hidden and not required whatever the host says, its answer retained
        // (the lenient fold's fallback). `shown` follows the box: its answer is sent while the box shows it
        // and left out, by the hidden default, when the box does not.
        expect(result.effective.ref, role).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: true });
        expect({ ...result.submittable }, role).toStrictEqual({ eligible: "yes", ...(role === "staff" ? { shown: "s" } : {}), ref: "r" });
      }

      // The same fieldset on no page itself: lenient for it and for its field.
      const loose = form(field("eligible"), group("box", "fieldset", [field("ref", { required: true })], {}));
      (loose.children!.content![1] as ComponentNode).rules = { visibleWhen: staff };
      for (const role of ["staff", "public"]) {
        const both = fold(loose, { eligible: "yes" }, only, { role });
        expect(both.placements, role).toMatchObject({ box: "unassigned", ref: "unassigned" });
        expect(both.effective.box?.visible, role).toBe(false);
        expect(both.effective.ref, role).toMatchObject({ visible: false, requiredApplies: false, runValidation: false });
      }
      // A fieldset on no page with no host rule, and its field: the whole form's fold, as for any other.
      const plain = form(field("eligible"), group("box", "fieldset", [field("ref", { required: true })], {}));
      expect(fold(plain, { eligible: "yes" }, only, { role: "public" }).effective.ref).toMatchObject({ visible: true, requiredApplies: true, runValidation: true });
    });

    it("reads no Required-when rule reading host. on a field on no page, on either side: the tick alone counts there, while the browser's whole form and a page still follow the host", () => {
      const tree = form(
        field("eligible"),
        field("ruled", {}, { requiredWhen: staff }),
        field("ticked", { required: true }, { requiredWhen: staff }),
        field("listed", {}, { requiredWhen: staff }),
        field("plain", {}, { requiredWhen: eq("eligible", "yes") })
      );
      const lists: Journey = { id: "short", pages: [{ id: "only", components: ["eligible", "listed"] }] };
      // A browser told the host would hold the person to `ruled` on a field no page shows, and
      // the kernel never reads a rule reading host., so the server would accept the
      // same envelope: a verdict nobody can act on. Neither side reads the rule there.
      const journeyed = fold(tree, { eligible: "yes" }, lists, { role: "staff" });
      expect(journeyed.placements).toMatchObject({ ruled: "unassigned", ticked: "unassigned", plain: "unassigned", listed: "on" });
      expect({ ...journeyed.required }).toStrictEqual({ eligible: false, ruled: false, ticked: true, listed: true, plain: true });
      // Still shown and validated: only the host-read rule is left unread, not the field's other rules.
      expect(journeyed.effective.ruled).toMatchObject({ visible: true, runValidation: true, requiredApplies: true });
      // On the whole form, and on a page, the rule is read as written: the browser follows the host.
      expect(fold(tree, { eligible: "yes" }, undefined, { role: "staff" }).required.ruled).toBe(true);
      expect(fold(tree, { eligible: "yes" }, undefined, { role: "public" }).required.ruled).toBe(false);
      expect(fold(tree, { eligible: "yes" }, lists, { role: "public" }).required.listed).toBe(false);
    });

    it("leaves a field on a skipped page as it was: hidden, withheld, not required", () => {
      const tree = form(field("eligible"), field("extra", { required: true }), field("name"));
      const journey: Journey = {
        id: "apply",
        pages: [
          { id: "start", components: ["eligible"], routes: [{ when: neq("eligible", "yes"), to: "last" }] },
          { id: "more", components: ["extra"] },
          { id: "last", components: ["name"] }
        ]
      };
      const result = fold(tree, { eligible: "no", extra: "stale", name: "Ada" }, journey);
      expect(result.placements?.extra).toBe("off");
      expect(result.effective.extra).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: false });
      expect({ ...result.submittable }).toStrictEqual({ eligible: "no", name: "Ada" });
    });

    it("gives a one-page journey listing every component the whole form's fold", () => {
      const tree = form(
        field("mode"),
        field("detail", { required: true, ...EXCLUDE }, { visibleWhen: eq("mode", "detailed") }),
        group("box", "fieldset", [field("inner", {}, { requiredWhen: eq("mode", "detailed") })]),
        field("staffy", {}, { visibleWhen: staff })
      );
      const everything: Journey = { id: "all", pages: [{ id: "one", components: ["mode", "detail", "box", "staffy"] }] };
      for (const values of [{ mode: "detailed", detail: "d" }, { mode: "simple", detail: "d", inner: "i" }, {}]) {
        const whole = fold(tree, values, undefined, { role: "staff" });
        const one = fold(tree, values, everything, { role: "staff" });
        expect({ ...one.effective }, JSON.stringify(values)).toEqual({ ...whole.effective });
        expect({ ...one.submittable }, JSON.stringify(values)).toEqual({ ...whole.submittable });
        expect({ ...one.required }, JSON.stringify(values)).toEqual({ ...whole.required });
        expect({ ...one.idValues }, JSON.stringify(values)).toEqual({ ...whole.idValues });
      }
    });
  });

  it("tells a component whose own visibility, or an ancestor's, reads host. from every other", () => {
    const staff = eq("host.role", "staff");
    const tree = form(
      field("plain"),
      field("own", {}, { visibleWhen: staff }),
      field("tucked", { hidden: true }, { visibleWhen: staff }),
      field("other", {}, { enabledWhen: staff, readonlyWhen: staff, requiredWhen: staff }),
      group("box", "fieldset", [field("inner"), group("deeper", "fieldset", [field("leaf", {}, { visibleWhen: eq("plain", "x") })], {})], {}),
      group("clear", "fieldset", [field("inside", {}, { visibleWhen: eq("plain", "x") })], {}),
      { id: "constructor", type: "text", configuration: {}, rules: null } as unknown as ComponentNode,
      { id: "toString", type: "text", configuration: {}, rules: { visibleWhen: null } } as unknown as ComponentNode
    );
    // The host path inside a logical expression counts like a bare one.
    (tree.children!.content![4] as ComponentNode).rules = { visibleWhen: { kind: "logical", operator: "and", left: eq("plain", "x"), right: staff } };
    const input = foldInput(tree, {});
    const reads = (id: string): boolean => kernelFoldVisibilityReadsHost(id, input.nodeById, input.parentOf);
    expect(reads("plain")).toBe(false);
    expect(reads("own")).toBe(true);
    expect(reads("tucked")).toBe(true);
    expect(reads("box")).toBe(true);
    // The whole ancestor chain counts, however deep, and whatever the node's own rule reads.
    expect(reads("inner")).toBe(true);
    expect(reads("deeper")).toBe(true);
    expect(reads("leaf")).toBe(true);
    expect(reads("clear")).toBe(false);
    expect(reads("inside")).toBe(false);
    // Only visibility counts: enabled, read-only and required rules reading host. are covered elsewhere.
    expect(reads("other")).toBe(false);
    // A hand-written null rules block or rule is no rule; a node named after a prototype member is a node; an unknown id reads nothing.
    expect(reads("constructor")).toBe(false);
    expect(reads("toString")).toBe(false);
    expect(reads("hasOwnProperty")).toBe(false);
  });

  it("places a component: on keeps its own state, on no page too unless its visibility reads host., off folds to hidden", () => {
    const bare = { visible: true, disabled: true, readonly: false };
    const own = { ...bare, hiddenValueBehavior: "clear" as const };
    expect(kernelPlacedSemanticState(own, undefined, undefined, false)).toBe(own);
    expect(kernelPlacedSemanticState(own, undefined, undefined, true)).toBe(own);
    expect(kernelPlacedSemanticState(own, "on", undefined, false)).toBe(own);
    expect(kernelPlacedSemanticState(own, "on", undefined, true)).toBe(own);
    expect(kernelPlacedSemanticState(own, "unassigned", "retain", false)).toBe(own);
    const hidden = { visible: false, disabled: true, readonly: false, hiddenValidationBehavior: "skip", hiddenRequiredBehavior: "not-required" };
    // On no page with a host-bound visibility: the earlier fold — hidden, unchecked, not
    // required, the answer by the node's own behaviour, else retained; never the journey's
    // `offPathValues`, and never the node's own opt-ins.
    expect(kernelPlacedSemanticState(own, "unassigned", "exclude-from-submission", true)).toEqual({ ...hidden, hiddenValueBehavior: "clear" });
    expect(kernelPlacedSemanticState(bare, "unassigned", "exclude-from-submission", true)).toEqual({ ...hidden, hiddenValueBehavior: "retain" });
    expect(
      kernelPlacedSemanticState({ ...bare, visible: false, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" }, "unassigned", undefined, true)
    ).toEqual({ ...hidden, hiddenValueBehavior: "retain" });
    expect(kernelPlacedSemanticState(own, "off", "retain", false)).toEqual({ ...hidden, hiddenValueBehavior: "clear" });
    expect(kernelPlacedSemanticState(bare, "off", "retain", false)).toEqual({ ...hidden, hiddenValueBehavior: "retain" });
    expect(kernelPlacedSemanticState(bare, "off", undefined, true)).toEqual({ ...hidden, hiddenValueBehavior: "exclude-from-submission" });
  });

  describe("agrees with a server that only sees the submission", () => {
    // (a) A field hidden by its own rule and excluded from submission cannot steer a route.
    const routed = form(
      field("gate"),
      field("flag", EXCLUDE, { visibleWhen: eq("gate", "show") }),
      field("q2"),
      field("q3")
    );
    const routes: Journey = {
      id: "routes",
      pages: [
        { id: "p1", components: ["gate", "flag"], routes: [{ when: eq("flag", "yes"), to: "p3" }] },
        { id: "p2", components: ["q2"] },
        { id: "p3", components: ["q3"] }
      ]
    };

    it("does not take a route fed by a self-hidden, excluded field", () => {
      const result = fold(routed, { gate: "hide", flag: "yes", q2: "b", q3: "c" }, routes);
      expect(result.trace?.pages).toEqual(["p1", "p2", "p3"]);
      expect(result.trace?.decisions[0]).toEqual({ kind: "next", pageId: "p1", to: "p2" });
      expect({ ...result.submittable }).toStrictEqual({ gate: "hide", q2: "b", q3: "c" });

      const shown = fold(routed, { gate: "show", flag: "yes", q2: "b", q3: "c" }, routes);
      expect(shown.trace?.pages).toEqual(["p1", "p3"]);
      expect({ ...shown.submittable }).toStrictEqual({ gate: "show", flag: "yes", q3: "c" });
    });

    // (b) An answer left on a page the path skips reads as absent everywhere, not just in the path.
    const pets = form(
      field("has_pet"),
      field("pet"),
      field("pet_name", EXCLUDE, { visibleWhen: eq("pet", "dog") }),
      field("other")
    );
    const petJourney: Journey = {
      id: "pets",
      pages: [
        { id: "p1", components: ["has_pet"], routes: [{ when: neq("has_pet", "yes"), to: "p3" }] },
        { id: "p2", components: ["pet"] },
        { id: "p3", components: ["pet_name", "other"] }
      ]
    };

    it("evaluates a later field's visibility as if a skipped page's stale answer were absent", () => {
      const result = fold(pets, { has_pet: "no", pet: "dog", pet_name: "Rex", other: "o" }, petJourney);
      expect(result.trace?.pages).toEqual(["p1", "p3"]);
      expect(result.effective.pet_name).toMatchObject({ visible: false, runValidation: false, requiredApplies: false });
      expect({ ...result.submittable }).toStrictEqual({ has_pet: "no", other: "o" });

      const taken = fold(pets, { has_pet: "yes", pet: "dog", pet_name: "Rex", other: "o" }, petJourney);
      expect(taken.effective.pet_name?.visible).toBe(true);
      expect({ ...taken.submittable }).toStrictEqual({ has_pet: "yes", pet: "dog", pet_name: "Rex", other: "o" });
    });

    // (c) A field listed on a page of its own, inside a section on a page the path skips: the
    // field is on the path, so the skipped section must not hide it — nor drop from the
    // submission the answer its page's route has just read.
    const nested = form(
      field("q"),
      group("section", "fieldset", [field("fast", EXCLUDE), field("slow")]),
      field("z")
    );
    const nestedJourney: Journey = {
      id: "nested",
      pages: [
        { id: "p1", components: ["q", "fast"], routes: [{ when: eq("fast", "go"), to: "p3" }] },
        { id: "p2", components: ["section"] },
        { id: "p3", components: ["z"] }
      ]
    };

    it("keeps a component on the path shown inside an ancestor the path skips", () => {
      const result = fold(nested, { q: "a", fast: "go", slow: "s", z: "z" }, nestedJourney);
      expect(result.trace?.pages).toEqual(["p1", "p3"]);
      expect({ ...result.placements }).toStrictEqual({ q: "on", fast: "on", slow: "off", z: "on" });
      expect(result.effective.fast).toMatchObject({ visible: true, runValidation: true, submitValue: true });
      expect(result.effective.slow).toMatchObject({ visible: false, submitValue: false });
      expect({ ...result.submittable }).toStrictEqual({ q: "a", fast: "go", z: "z" });
    });

    const cases: Array<[string, ComponentNode, Record<string, unknown>, Journey | undefined]> = [
      ["a listed field inside a skipped section", nested, { q: "a", fast: "go", slow: "s", z: "z" }, nestedJourney],
      ["a hidden excluded field without a journey", form(field("secret", { hidden: true, ...EXCLUDE }), field("follow", EXCLUDE, { visibleWhen: eq("secret", "yes") })), { secret: "yes", follow: "x" }, undefined],
      ["an off-path section under a keyed container", root, { eligible: "no", "info.amount": 500, name: "Ada" }, journey],
      ["an on-path section under a keyed container", root, { eligible: "yes", "info.amount": 500, name: "Ada" }, journey],
      ["off-path answers cleared", root, { eligible: "no", "info.amount": 500, name: "Ada" }, { ...journey, offPathValues: "clear" }],
      ["a self-hidden field feeding a route", routed, { gate: "hide", flag: "yes", q2: "b", q3: "c" }, routes],
      ["a stale answer on a skipped page", pets, { has_pet: "no", pet: "dog", pet_name: "Rex", other: "o" }, petJourney],
      ["a taken branch", pets, { has_pet: "yes", pet: "cat", pet_name: "Tom", other: "o" }, petJourney]
    ];

    it.each(cases)("lands on the same fold from the submission alone: %s", (_name, tree, values, activeJourney) => {
      const browser = fold(tree, values, activeJourney);
      // What the server holds is the submission's JSON: a cleared answer (`undefined`) never arrives.
      const sent = kernelJsonAnswers(browser.submittable);
      const server = fold(tree, sent, activeJourney);
      expect(browser.converged).toBe(true);
      expect(server.converged).toBe(true);
      expect(server.passes).toBe(1);
      expect(server.effective).toStrictEqual(browser.effective);
      expect(server.trace).toStrictEqual(browser.trace);
      expect(server.placements).toStrictEqual(browser.placements);
      expect(server.submittable).toStrictEqual(sent);
      expect(server.idValues).toStrictEqual(browser.idValues);
    });
  });
});

describe("kernelFoldSubmittable over a repeating section's own collection path", () => {
  const section = group("items", "repeatingSection", [field("sku")], EXCLUDE);
  section.collection = { itemFields: ["sku"], collectionPath: "order_lines" };
  section.rules = { visibleWhen: eq("kind", "full") };
  const root = form(field("kind"), section);
  const values = { kind: "short", "order_lines[0].sku": "abandoned", order_lines: [{ sku: "abandoned" }] };

  it("judges the entries by the section the collection owners name", () => {
    const input = foldInput(root, values);
    input.collectionOwners = { order_lines: "items" };
    expect({ ...kernelFoldSubmittable(input).submittable }).toStrictEqual({ kind: "short" });

    const shown = foldInput(root, { ...values, kind: "full" });
    shown.collectionOwners = { order_lines: "items" };
    expect({ ...kernelFoldSubmittable(shown).submittable }).toStrictEqual({ ...values, kind: "full" });
  });

  it("reads the owners off a journey's ownership when the input has none of its own", () => {
    const journey: Journey = { id: "order", pages: [{ id: "start", components: ["kind"], routes: [{ when: neq("kind", "full"), to: "$end" }] }, { id: "full", components: ["items"] }] };
    const plain = form(field("kind"), { ...section, configuration: { label: "items" }, rules: {} });
    expect({ ...fold(plain, values, journey).submittable }).toStrictEqual({ kind: "short" });
  });

  it("judges an entry by the section before the leading segment's container", () => {
    const nested = group("order_items", "repeatingSection", [field("sku")], EXCLUDE);
    nested.collection = { itemFields: ["sku"], collectionPath: "order.items" };
    nested.rules = { visibleWhen: eq("kind", "full") };
    const tree = form(field("kind"), group("order", "container", [nested]));
    const input = foldInput(tree, { kind: "short", "order.items[0].sku": "abandoned" });
    input.collectionOwners = { "order.items": "order_items" };
    expect({ ...kernelFoldSubmittable(input).submittable }).toStrictEqual({ kind: "short" });
  });
});

describe("kernelFoldSubmittable: a data grid's rows follow their grid", () => {
  const column = (id: string): ComponentNode => ({ id, type: "text", configuration: {} });
  /**
   * A grid whose id is not its collection path, hidden unless the order is a full one. It opens
   * with no rows (`initialRows: 0`), so the browser holds only the rows a test adds.
   */
  function gridForm(configuration: Record<string, unknown> = {}): ComponentNode {
    const grid: ComponentNode = {
      id: "orders_grid",
      type: "dataGrid",
      configuration: { label: "orders", initialRows: 0, ...configuration },
      collection: { collectionPath: "orders" },
      children: { content: [column("qty"), column("sku")] },
      rules: { visibleWhen: eq("kind", "full") }
    };
    return kernelNormalizeDataGrids(
      form(field("kind"), grid, field("rush", { required: true }, { visibleWhen: { kind: "binary", operator: "gt", left: { kind: "path", path: "orders[0].qty" }, right: { kind: "literal", value: 5 } } }), field("note"))
    );
  }
  const rows = { "orders[0].qty": 10, "orders[0].sku": "A1", "orders[1].qty": 1 };

  it("judges a row by the grid its collection path names, given among the collection owners", () => {
    const root = gridForm(EXCLUDE);
    const input = foldInput(root, { kind: "short", ...rows, orders: [{ qty: 10 }] });
    // Without the owner a row is judged by its leading segment, `orders`, which names no component: it passes.
    expect({ ...kernelFoldSubmittable(input).submittable }).toStrictEqual({ kind: "short", ...rows, orders: [{ qty: 10 }] });
    expect(kernelFoldSubmittable(input).effective.rush?.visible).toBe(true);

    input.collectionOwners = { orders: "orders_grid" };
    const hidden = kernelFoldSubmittable(input);
    expect({ ...hidden.submittable }).toStrictEqual({ kind: "short" });
    // Withheld, the row steers nothing: the field it would show stays hidden.
    expect(hidden.effective.rush).toMatchObject({ visible: false, requiredApplies: false });
    expect(hidden.converged).toBe(true);

    const shown = foldInput(root, { kind: "full", ...rows });
    shown.collectionOwners = { orders: "orders_grid" };
    expect({ ...kernelFoldSubmittable(shown).submittable }).toStrictEqual({ kind: "full", ...rows });
    expect(kernelFoldSubmittable(shown).effective.rush?.visible).toBe(true);
  });

  it("keeps the rows of a hidden grid that retains or clears by its own behaviour, as a section's entries", () => {
    const retained = foldInput(gridForm(RETAIN), { kind: "short", ...rows });
    retained.collectionOwners = { orders: "orders_grid" };
    expect({ ...kernelFoldSubmittable(retained).submittable }).toStrictEqual({ kind: "short", ...rows });
    const cleared = foldInput(gridForm({ hiddenValueBehavior: "clear" }), { kind: "short", ...rows });
    cleared.collectionOwners = { orders: "orders_grid" };
    expect({ ...kernelFoldSubmittable(cleared).submittable }).toStrictEqual({ kind: "short", "orders[0].qty": undefined, "orders[0].sku": undefined, "orders[1].qty": undefined });
  });

  it("reads the owners off a journey's ownership: a grid on a page the path skips submits no rows", () => {
    const root = kernelNormalizeDataGrids(form(field("kind"), { id: "orders_grid", type: "dataGrid", configuration: {}, collection: { collectionPath: "orders" }, children: { content: [column("qty")] } }, field("note")));
    const journey: Journey = { id: "order", pages: [{ id: "start", components: ["kind"], routes: [{ when: neq("kind", "full"), to: "end" }] }, { id: "full", components: ["orders_grid"] }, { id: "end", components: ["note"] }] };
    const skipped = fold(root, { kind: "short", ...rows, note: "n" }, journey);
    expect(skipped.trace?.pages).toEqual(["start", "end"]);
    expect({ ...skipped.submittable }).toStrictEqual({ kind: "short", note: "n" });
    expect({ ...fold(root, { kind: "full", ...rows, note: "n" }, journey).submittable }).toStrictEqual({ kind: "full", ...rows, note: "n" });
  });

  it("is what the browser runtime folds with: its orchestrator registers the grid's collection path, as the kernel does", async () => {
    const definitionOf = (root: ComponentNode, journey?: Journey): FormDefinition => ({ id: "grids", version: "1", schemaVersion: "1", root, ...(journey ? { journey: { journeys: [journey] } } : {}) });
    const runtimeOf = (definition: FormDefinition): FormRuntime => {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
      return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
    };
    const envelope = { form: { id: "grids", version: "1" }, client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" } };

    // Hidden by its own rule and excluded: the browser withholds the rows, and the field they would show stays hidden.
    const root = gridForm(EXCLUDE);
    expect({ ...kernelCollectionOwners(kernelTreeIndex(root)) }).toStrictEqual({ orders: "orders_grid" });
    const runtime = runtimeOf(definitionOf(root));
    runtime.setValue("kind", "full");
    runtime.addRow("orders", { qty: 10, sku: "A1" });
    expect(runtime.submittableValues()).toStrictEqual({ kind: "full", "orders[0].qty": 10, "orders[0].sku": "A1" });
    expect(runtime.effectiveState("rush")?.visible).toBe(true);
    runtime.setValue("kind", "short");
    expect(runtime.state().values).toMatchObject({ "orders[0].qty": 10 });
    expect(runtime.submittableValues()).toStrictEqual({ kind: "short" });
    expect(runtime.effectiveState("rush")).toMatchObject({ visible: false, requiredApplies: false });
    const sent = await runtime.submit("send", envelope);
    expect(sent.canonicalSubmission?.submission.values).toStrictEqual({ kind: "short" });
    // The kernel, handed the stored answers, lands on the same values; and over the envelope it changes nothing.
    const stored = runKernel({ formId: "grids", values: { ...runtime.state().values }, locale: "en", form: root }, []);
    expect(stored.errors).toEqual([]);
    expect(stored.values).toEqual({ kind: "short" });
    expect(kernelFoldSubmission(root, { kind: "short" }, undefined).submittable).toEqual({ kind: "short" });

    // On a page the path skips: the same, through the journey.
    const plain = form(field("kind"), { id: "orders_grid", type: "dataGrid", configuration: { initialRows: 0 }, collection: { collectionPath: "orders" }, children: { content: [column("qty"), column("sku")] } }, field("note"));
    const journey: Journey = { id: "order", pages: [{ id: "start", components: ["kind"], routes: [{ when: neq("kind", "full"), to: "end" }] }, { id: "full", components: ["orders_grid"] }, { id: "end", components: ["note"] }] };
    const journeyed = runtimeOf(definitionOf(plain, journey));
    journeyed.setValue("kind", "full");
    journeyed.addRow("orders", { qty: 2, sku: "B2" });
    expect(journeyed.submittableValues()).toStrictEqual({ kind: "full", "orders[0].qty": 2, "orders[0].sku": "B2" });
    journeyed.setValue("kind", "short");
    expect(journeyed.submittableValues()).toStrictEqual({ kind: "short" });
    const server = runKernel({ formId: "grids", values: { ...journeyed.state().values }, locale: "en", form: plain, journey }, []);
    expect(server.values).toEqual({ kind: "short" });
  });
});

describe("kernelFoldSubmittable over ids and keys named after Object.prototype members", () => {
  // The runtime hands the fold ordinary objects (`foldInput` builds them the same way), and a
  // submission may carry any key: none of them may read an inherited member.
  it("folds components called constructor and toString, and passes unowned keys such as __proto__ through", () => {
    const root = form(field("constructor", { required: true }), field("toString", { hidden: true, ...EXCLUDE }), field("valueOf", {}, { visibleWhen: eq("constructor", "c") }));
    const values = JSON.parse('{"constructor": "c", "toString": "t", "valueOf": 1, "__proto__": "p", "hasOwnProperty": "h"}') as Record<string, unknown>;
    const result = fold(root, values);
    expect(result.converged).toBe(true);
    expect(Object.keys(result.submittable)).toEqual(["constructor", "valueOf", "__proto__", "hasOwnProperty"]);
    expect(result.submittable.__proto__).toBe("p");
    expect(result.idValues.constructor).toBe("c");
    // Read through a `string` key: TypeScript types `.valueOf` on a record as Object's method.
    const state = (fold: KernelFoldResult, id: string) => fold.effective[id];
    expect(state(result, "valueOf")?.visible).toBe(true);
    expect(state(result, "toString")).toMatchObject({ visible: false, submitValue: false });
    expect(Object.keys(result.effective)).toEqual(["form", "constructor", "toString", "valueOf"]);

    // Unanswered, `constructor` reads as nothing — not as `Object` — so "not constructor" holds.
    const blank = form(field("constructor"), field("valueOf", {}, { visibleWhen: { kind: "unary", operator: "not", operand: { kind: "path", path: "constructor" } } }));
    const unanswered = fold(blank, { valueOf: 1 });
    expect(state(unanswered, "valueOf")?.visible).toBe(true);
    expect(unanswered.idValues.constructor).toBeUndefined();
  });

  it("works a journey's path out over pages and components with those names", () => {
    const root = form(field("valueOf"), field("toString", { required: true }), field("isPrototypeOf"));
    const journey: Journey = {
      id: "flow",
      pages: [
        { id: "constructor", components: ["valueOf"], routes: [{ when: neq("valueOf", "yes"), to: "$end" }] },
        { id: "__proto__", components: ["toString"] }
      ]
    };
    const off = fold(root, { valueOf: "no", toString: "t", isPrototypeOf: "i", constructor: "k" }, journey);
    expect(off.trace?.pages).toEqual(["constructor"]);
    expect({ ...off.placements }).toStrictEqual({ valueOf: "on", toString: "off", isPrototypeOf: "unassigned" });
    expect({ ...off.submittable }).toStrictEqual({ valueOf: "no", isPrototypeOf: "i", constructor: "k" });
    expect(off.effective.toString).toMatchObject({ runValidation: false, requiredApplies: false });

    const on = fold(root, { valueOf: "yes", toString: "t" }, journey);
    expect(on.trace?.pages).toEqual(["constructor", "__proto__"]);
    expect({ ...on.submittable }).toStrictEqual({ valueOf: "yes", toString: "t" });
  });
});

describe("kernelFoldSubmittable reads the answers as the envelope carries them (JSON semantics)", () => {
  it("reads a non-finite number as null and -0 as 0, and leaves an undefined entry out", () => {
    expect(kernelJsonValue(Number.NaN)).toBeNull();
    expect(kernelJsonValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(kernelJsonValue(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(Object.is(kernelJsonValue(-0), 0)).toBe(true);
    expect(kernelJsonValue([1, Number.NaN, undefined])).toEqual([1, null, null]);
    const nested = { a: 1, b: undefined, c: { d: Number.NaN, e: [Number.POSITIVE_INFINITY] } };
    expect(kernelJsonValue(nested)).toStrictEqual(JSON.parse(JSON.stringify(nested)));
    // Nothing to change: the value itself, so a file's record or a section's entries keep their identity.
    const file = { storage: "inline", name: "a.pdf", size: 3 };
    const entries = [file, { sku: "x" }];
    expect(kernelJsonValue(file)).toBe(file);
    expect(kernelJsonValue(entries)).toBe(entries);
    // A record rebuilt is an ordinary object, as JSON.parse makes one: an own __proto__ key stays a key.
    const odd = JSON.parse('{"__proto__": {"y": 1}}') as Record<string, unknown>;
    odd.x = Number.NaN;
    const rebuilt = kernelJsonValue(odd) as Record<string, unknown>;
    expect(Object.keys(rebuilt)).toEqual(["__proto__", "x"]);
    expect(rebuilt.x).toBeNull();
    expect(Object.getPrototypeOf(rebuilt)).toBe(Object.prototype);
    expect({ ...kernelJsonAnswers({ ratio: Number.NaN, gone: undefined, kept: "k" }) }).toStrictEqual({ ratio: null, kept: "k" });
  });

  it("lets a NaN answer steer visibility and a route only as the null a server reads", () => {
    const notNull: Expression = { kind: "binary", operator: "neq", left: { kind: "path", path: "ratio" }, right: { kind: "literal", value: null } };
    const root = form(field("ratio"), field("explain", EXCLUDE, { visibleWhen: notNull }), field("q2"), field("q3"));
    const journey: Journey = {
      id: "ratio",
      pages: [
        { id: "p1", components: ["ratio", "explain"], routes: [{ when: notNull, to: "p3" }] },
        { id: "p2", components: ["q2"] },
        { id: "p3", components: ["q3"] }
      ]
    };
    for (const active of [undefined, journey]) {
      const browser = fold(root, { ratio: Number.NaN, explain: "why", q2: "b", q3: "c" }, active);
      const server = fold(root, JSON.parse(JSON.stringify({ ratio: Number.NaN, explain: "why", q2: "b", q3: "c" })) as Record<string, unknown>, active);
      expect(browser.effective.explain?.visible).toBe(false);
      expect(browser.trace?.pages).toEqual(active ? ["p1", "p2", "p3"] : undefined);
      expect({ ...browser.submittable }).toStrictEqual({ ratio: null, q2: "b", q3: "c" });
      expect(server.effective).toStrictEqual(browser.effective);
      expect(server.trace).toStrictEqual(browser.trace);
      expect(server.submittable).toStrictEqual(browser.submittable);
    }
  });

  it("reads only the keys the schema defines when told which, and still submits the rest", () => {
    const root = form(field("name"), field("promo", {}, { visibleWhen: eq("campaign", "spring") }));
    const defined = new Set(["name", "promo"]);
    const input = { ...foldInput(root, { name: "Ada", campaign: "spring", promo: "P" }), defines: (key: string) => defined.has(key) };
    const result = kernelFoldSubmittable(input);
    expect(result.effective.promo?.visible).toBe(false);
    // `promo` is hidden and, by the default, left out of what the fold reads and submits.
    expect({ ...result.idValues }).toStrictEqual({ name: "Ada" });
    // The key no component owns passes through to the submission, for the caller's unknown-field policy.
    expect({ ...result.submittable }).toStrictEqual({ name: "Ada", campaign: "spring" });
    // Without the predicate it is read, as before.
    expect(fold(root, { name: "Ada", campaign: "spring" }).effective.promo?.visible).toBe(true);
  });
});

describe("kernelFoldSubmittable: requiredness over the settled view", () => {
  const byPhone = eq("contact", "phone");

  it("reads a rule over the settled view: an answer hidden and excluded does not make another field required", () => {
    const root = form(field("gate"), field("secret", EXCLUDE, { visibleWhen: eq("gate", true) }), field("echo", {}, { requiredWhen: eq("secret", "open") }));
    // Hidden and excluded, the answer is not on any server: the rule reads it as absent.
    expect(fold(root, { gate: false, secret: "open" }).required.echo).toBe(false);
    expect(fold(root, { gate: true, secret: "open" }).required.echo).toBe(true);
    expect(fold(root, { gate: true }).required.echo).toBe(false);
  });

  it("is Required OR Required when: the tick stays whatever the rule says, the root is absent, the record has no prototype", () => {
    const root = form(field("contact"), field("phone", {}, { requiredWhen: byPhone }), field("both", { required: true }, { requiredWhen: eq("contact", "never") }), field("free"));
    const result = fold(root, { contact: "phone" });
    expect({ ...result.required }).toStrictEqual({ contact: false, phone: true, both: true, free: false });
    expect(Object.keys(result.required)).toEqual(["contact", "phone", "both", "free"]);
    expect(Object.getPrototypeOf(result.required)).toBeNull();
    expect(fold(root, { contact: "email" }).required.phone).toBe(false);
    expect(fold(root, {}).required.both).toBe(true);
  });

  it("reads no rule on a node that holds no answer of its own: a data grid, a childless fieldset, an html block, a group with children", () => {
    const root = form(
      field("contact"),
      { id: "orders", type: "dataGrid", configuration: {}, rules: { requiredWhen: byPhone } },
      { id: "extra", type: "fieldset", configuration: {}, rules: { requiredWhen: byPhone } },
      { id: "note", type: "html", configuration: {}, rules: { requiredWhen: byPhone } },
      { ...group("details", "panel", [field("inner", {}, { requiredWhen: byPhone })]), rules: { requiredWhen: byPhone } },
      { id: "ticked", type: "fieldset", configuration: { required: true }, rules: { requiredWhen: eq("contact", "never") } }
    );
    const result = fold(root, { contact: "phone" });
    // Such a node's value is always empty: reading its rule would refuse every submission while it held.
    expect(result.required.orders).toBe(false);
    expect(result.required.extra).toBe(false);
    expect(result.required.note).toBe(false);
    expect(result.required.details).toBe(false);
    // The field inside a plain group is read; a group's own tick is kept as it is.
    expect(result.required.inner).toBe(true);
    expect(result.required.ticked).toBe(true);
  });

  it("reads no rule inside a repeating section: a row field keeps its tick alone", () => {
    const section: ComponentNode = {
      id: "items",
      type: "repeatingSection",
      configuration: {},
      collection: { itemFields: ["sku", "qty"] },
      rules: { requiredWhen: byPhone },
      children: { content: [field("sku", {}, { requiredWhen: byPhone }), group("cell", "panel", [field("qty", { required: true }, { requiredWhen: eq("contact", "never") })])] }
    };
    const root = form(field("contact"), section);
    const input = foldInput(root, { contact: "phone" });
    const result = kernelFoldSubmittable(input);
    expect(result.required.items).toBe(false);
    expect(result.required.sku).toBe(false);
    expect(result.required.qty).toBe(true);
    expect(kernelFoldInSection("sku", input.nodeById, input.parentOf)).toBe(true);
    expect(kernelFoldInSection("qty", input.nodeById, input.parentOf)).toBe(true);
    expect(kernelFoldInSection("items", input.nodeById, input.parentOf)).toBe(false);
    expect(kernelFoldInSection("contact", input.nodeById, input.parentOf)).toBe(false);
  });

  it("counts the tick alone without a ruleRequired callback", () => {
    const root = form(field("contact"), field("phone", {}, { requiredWhen: byPhone }), field("both", { required: true }));
    const input = foldInput(root, { contact: "phone" });
    delete input.ruleRequired;
    expect({ ...kernelFoldSubmittable(input).required }).toStrictEqual({ contact: false, phone: false, both: true });
  });

  it("reads a null rules block or a null requiredWhen as no rule, as every rule reader does, never as a crash", () => {
    const nullRules = { ...field("a"), rules: null } as unknown as ComponentNode;
    const nullRule = { ...field("b"), rules: { requiredWhen: null } } as unknown as ComponentNode;
    const root = form(field("contact"), nullRules, nullRule, { ...field("ticked", { required: true }), rules: null } as unknown as ComponentNode);
    const result = fold(root, { contact: "phone" });
    expect({ ...result.required }).toStrictEqual({ contact: false, a: false, b: false, ticked: true });
    expect(result.converged).toBe(true);
  });

  it("works requiredness out over the last view even when the fold does not settle", () => {
    // empty() keeps each rule a real yes or no: a condition holds only for true (strict truthiness).
    const isEmpty = (id: string): Expression => ({ kind: "call", name: "empty", args: [{ kind: "path", path: id }] });
    const root = form(
      field("a", EXCLUDE, { visibleWhen: isEmpty("b") }),
      field("b", EXCLUDE, { visibleWhen: { kind: "unary", operator: "not", operand: isEmpty("a") } }),
      field("d"),
      field("c", {}, { requiredWhen: eq("d", "yes") })
    );
    const result = fold(root, { a: 1, b: 1, d: "yes" });
    expect(result.converged).toBe(false);
    expect(result.required.c).toBe(true);
    expect(result.required.d).toBe(false);
  });

  it("agrees with holdsData on which components hold an answer of their own", () => {
    const groupTypes = ["form", "fieldset", "panel", "grid", "tabs", "tab", "steps", "step", "repeatingSection", "dataGrid", "container"];
    const valueless = ["button", "html", "image", "signature"];
    const fields = ["text", "number", "select", "radio", "checkbox", "checkboxes", "file", "date", "textarea", "custom-widget"];
    const nodes: ComponentNode[] = [
      ...groupTypes.map((type): ComponentNode => ({ id: `group-${type}`, type, configuration: {} })),
      { id: "visual", type: "container", configuration: { scopeData: false } },
      { id: "withChildren", type: "custom-group", configuration: {}, children: { content: [] } },
      { id: "items", type: "text", configuration: {}, collection: { itemFields: [] } },
      { id: "rows", type: "dataGrid", configuration: {}, collection: { collectionPath: "rows" }, children: { content: [] } },
      ...valueless.map((type): ComponentNode => ({ id: type, type, configuration: {} })),
      ...fields.map((type): ComponentNode => ({ id: type, type, configuration: {} }))
    ];
    for (const node of nodes) {
      const leaf = holdsData(node) && node.collection === undefined && !isDataScopeContainer(node);
      expect(kernelFoldHoldsOwnAnswer(node), node.id).toBe(leaf);
    }
    expect(nodes.filter(kernelFoldHoldsOwnAnswer).map((node) => node.id)).toEqual(fields);
  });
});

/**
 * Formulas, run scopes and the clock: what a compiled rule reads as, which
 * side skips which rule, and how a field on no page is folded when the server cannot replay
 * its rule for a reason beyond `host.`.
 */
describe("kernelCompiledRule and kernelRuleSkipped", () => {
  const tree = eq("a", 1);
  const clock: Expression = { kind: "binary", operator: "gte", left: { kind: "call", name: "today", args: [] }, right: { kind: "literal", value: "2026-01-01" } };
  const host: Expression = eq("host.region", "ca");

  it("reads a tree as it is, the object form's expression, and a formula string as no rule (compiled away before)", () => {
    expect(kernelCompiledRule(tree)).toBe(tree);
    expect(kernelCompiledRule({ expression: tree, run: "server" })).toBe(tree);
    expect(kernelCompiledRule({ formula: "a = 1" })).toBeUndefined();
    expect(kernelCompiledRule("a = 1")).toBeUndefined();
    expect(kernelCompiledRule(undefined)).toBeUndefined();
    expect(kernelCompiledRule(null)).toBeUndefined();
    expect(kernelCompiledRule(7)).toBeUndefined();
    expect(kernelCompiledRule([tree])).toBeUndefined();
  });

  it("skips by scope on each side, by host. and by a clock with no day on the server alone", () => {
    const both = { expression: tree };
    const browser = { expression: tree, run: "browser" };
    const server = { expression: tree, run: "server" };
    const secret = { expression: tree, run: "server-secret" };
    const today = "2026-10-07";
    const table: Array<[string, unknown, Expression, "browser" | "server", string | undefined, boolean]> = [
      ["both, browser", both, tree, "browser", today, false],
      ["both, server", both, tree, "server", today, false],
      ["tree alone, server", tree, tree, "server", undefined, false],
      ["browser scope, browser", browser, tree, "browser", today, false],
      ["browser scope, server", browser, tree, "server", today, true],
      ["server scope, browser", server, tree, "browser", today, true],
      ["server scope, server", server, tree, "server", today, false],
      ["secret scope, browser", secret, tree, "browser", today, true],
      ["secret scope, server", secret, tree, "server", today, false],
      ["host. read, browser", host, host, "browser", today, false],
      ["host. read, server", host, host, "server", today, true],
      ["clock, server with a day", clock, clock, "server", today, false],
      ["clock, server with no day", clock, clock, "server", undefined, true],
      ["clock, browser with no day", clock, clock, "browser", undefined, true],
      ["server scope and host., server", { expression: host, run: "server" }, host, "server", today, true]
    ];
    for (const [label, source, expression, side, day, skipped] of table) {
      expect(kernelRuleSkipped(source, expression, "visibleWhen", side, day), label).toBe(skipped);
    }
    // The browser-only keys are the browser's whatever the scope says, and never the server's.
    expect(kernelRuleSkipped(server, tree, "defaultValue", "browser", today)).toBe(false);
    expect(kernelRuleSkipped(both, tree, "defaultValue", "server", today)).toBe(true);
    expect(kernelRuleSkipped(both, tree, "navigationGating", "server", today)).toBe(true);
  });

  it("tells a field on no page whose rule the server cannot replay: host., a browser scope, or the clock with no day", () => {
    const root = form(
      field("by_host", {}, { visibleWhen: host }),
      field("by_browser", {}, { visibleWhen: { expression: tree, run: "browser" } }),
      field("by_server", {}, { visibleWhen: { expression: tree, run: "server" } }),
      field("by_clock", {}, { visibleWhen: clock }),
      field("plain", {}, { visibleWhen: tree }),
      field("needed_by_clock", {}, { requiredWhen: clock }),
      field("needed_by_browser", {}, { requiredWhen: { expression: tree, run: "browser" } }),
      field("needed_by_server", {}, { requiredWhen: { expression: tree, run: "server-secret" } })
    );
    const nodeById: Record<string, ComponentNode> = {};
    const parentOf: Record<string, string> = {};
    for (const child of root.children?.content ?? []) {
      nodeById[child.id] = child;
      parentOf[child.id] = root.id;
    }
    nodeById[root.id] = root;
    const reads = (id: string, today?: string): boolean => kernelFoldVisibilityReadsHost(id, nodeById, parentOf, today);
    expect(reads("by_host", "2026-10-07")).toBe(true);
    expect(reads("by_browser", "2026-10-07")).toBe(true);
    expect(reads("by_server", "2026-10-07")).toBe(false);
    expect(reads("plain", "2026-10-07")).toBe(false);
    expect(reads("by_clock", "2026-10-07")).toBe(false);
    expect(reads("by_clock")).toBe(true);
    const needed = (id: string, today?: string): boolean => kernelFoldRequiredReadsHost(nodeById[id] as ComponentNode, today);
    expect(needed("needed_by_clock", "2026-10-07")).toBe(false);
    expect(needed("needed_by_clock")).toBe(true);
    expect(needed("needed_by_browser", "2026-10-07")).toBe(true);
    expect(needed("needed_by_server", "2026-10-07")).toBe(false);
    expect(needed("plain")).toBe(false);
  });

  it("reads a rule still text through the compile module's reader, so the author's definition and its compiled copy agree on a host read", () => {
    const day = "2026-10-07";
    const root = form(
      field("by_host_text", {}, { visibleWhen: 'host.region = "west"' }),
      field("by_host_object", {}, { visibleWhen: { formula: 'host.region = "west"', run: "both" } }),
      field("by_host_call", {}, { visibleWhen: "len(host.region) > 0" }),
      field("by_browser_text", {}, { visibleWhen: { formula: "a = 1", run: "browser" } }),
      field("by_clock_text", {}, { visibleWhen: 'today() >= "2026-01-01"' }),
      field("plain_text", {}, { visibleWhen: "a = 1" }),
      field("broken_text", {}, { visibleWhen: "host.region = " }),
      group("hosted_box", "fieldset", [field("inside")], {}),
      field("needed_by_host_text", {}, { requiredWhen: 'host.region = "west"' }),
      field("needed_by_call", {}, { requiredWhen: "len(host.region) > 0" }),
      field("needed_plain_text", {}, { requiredWhen: "a = 1" })
    );
    (root.children?.content?.[7] as ComponentNode).rules = { visibleWhen: 'host.region = "west"' };
    const nodeById: Record<string, ComponentNode> = {};
    const parentOf: Record<string, string> = {};
    for (const child of root.children?.content ?? []) {
      nodeById[child.id] = child;
      parentOf[child.id] = root.id;
      for (const grandchild of child.children?.content ?? []) {
        nodeById[grandchild.id] = grandchild;
        parentOf[grandchild.id] = child.id;
      }
    }
    nodeById[root.id] = root;
    const signatures = formulaFunctionSignatures();
    const reads = (id: string, withSignatures: boolean): boolean => kernelFoldVisibilityReadsHost(id, nodeById, parentOf, day, withSignatures ? signatures : undefined);
    const needed = (id: string, withSignatures: boolean): boolean => kernelFoldRequiredReadsHost(nodeById[id] as ComponentNode, day, withSignatures ? signatures : undefined);
    for (const withSignatures of [false, true]) {
      expect(reads("by_host_text", withSignatures), String(withSignatures)).toBe(true);
      expect(reads("by_host_object", withSignatures), String(withSignatures)).toBe(true);
      expect(reads("by_browser_text", withSignatures), String(withSignatures)).toBe(true);
      expect(reads("inside", withSignatures), String(withSignatures)).toBe(true);
      expect(reads("by_clock_text", withSignatures), String(withSignatures)).toBe(false);
      expect(reads("plain_text", withSignatures), String(withSignatures)).toBe(false);
      // A formula that does not parse is no rule, as the compile reads it under every policy.
      expect(reads("broken_text", withSignatures), String(withSignatures)).toBe(false);
      expect(needed("needed_by_host_text", withSignatures), String(withSignatures)).toBe(true);
      expect(needed("needed_plain_text", withSignatures), String(withSignatures)).toBe(false);
    }
    // A call is checked against the signatures given: with none the parser knows no function, and the rule reads as none.
    expect(reads("by_host_call", false)).toBe(false);
    expect(reads("by_host_call", true)).toBe(true);
    expect(needed("needed_by_call", false)).toBe(false);
    expect(needed("needed_by_call", true)).toBe(true);
    // The same reading over the compiled copy: what the fold itself sees.
    const problems: FormulaProblem[] = [];
    const compiled = kernelCompileNode(root, kernelParseFormula, signatures, problems);
    expect(problems.map((problem) => problem.where)).toEqual(["rules:broken_text:visibleWhen"]);
    const compiledById: Record<string, ComponentNode> = {};
    for (const child of compiled.children?.content ?? []) {
      compiledById[child.id] = child;
      for (const grandchild of child.children?.content ?? []) {
        compiledById[grandchild.id] = grandchild;
      }
    }
    compiledById[compiled.id] = compiled;
    for (const id of ["by_host_text", "by_host_object", "by_host_call", "by_browser_text", "inside", "by_clock_text", "plain_text", "broken_text"]) {
      expect(kernelFoldVisibilityReadsHost(id, compiledById, parentOf, day), id).toBe(reads(id, true));
    }
    for (const id of ["needed_by_host_text", "needed_by_call", "needed_plain_text"]) {
      expect(kernelFoldRequiredReadsHost(compiledById[id] as ComponentNode, day), id).toBe(needed(id, true));
    }
  });

  it("hands the fold's day to the journey's evaluate, so a route condition on today() reads the recompute's day", () => {
    const root = form(field("a"), field("b"));
    const journey: Journey = {
      id: "j",
      pages: [
        { id: "first", components: ["a"], routes: [{ when: { ...clock, operator: "lt" } as Expression, to: "$end" }] },
        { id: "late", components: ["b"] }
      ]
    };
    const seen: Array<string | undefined> = [];
    const fold = kernelFoldSubmission(root, { a: 1, b: 2 }, journey, { today: "2026-10-07" });
    expect(fold.trace?.pages).toEqual(["first", "late"]);
    expect(fold.submittable).toEqual({ a: 1, b: 2 });
    const early = kernelFoldSubmission(root, { a: 1, b: 2 }, journey, { today: "2025-12-31" });
    expect(early.trace?.pages).toEqual(["first"]);
    expect(early.submittable).toEqual({ a: 1 });
    // The same through the fold's input directly: the third argument is the input's day.
    const input = foldInput(root, { a: 1, b: 2 }, journey);
    input.today = "2026-10-07";
    const evaluateWas = input.journey?.evaluate as (expression: Expression, values: Record<string, unknown>, today?: string) => unknown;
    (input.journey as { evaluate: unknown }).evaluate = (expression: Expression, values: Record<string, unknown>, today?: string) => {
      seen.push(today);
      return evaluateWas(expression, values, today);
    };
    kernelFoldSubmittable(input);
    // Once per pass of the fold, the same day each time.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((day) => day === "2026-10-07")).toBe(true);
  });
});

describe("kernelFoldRelaxUnreplayable: a visibility this side cannot replay is hidden for requiredness", () => {
  const clock: Expression = { kind: "binary", operator: "lt", left: { kind: "call", name: "year", args: [{ kind: "call", name: "today", args: [] }] }, right: { kind: "literal", value: 2000 } };
  const relax = (root: ComponentNode, today?: string) => {
    const index = kernelTreeIndex(root);
    const required = Object.create(null) as Record<string, boolean>;
    for (const id of index.order.slice(1)) {
      const node = index.nodeById[id] as ComponentNode;
      required[id] = (node.configuration as Record<string, unknown>).required === true;
    }
    const skipped = kernelFoldRelaxUnreplayable(index.order, index.nodeById, index.parentOf, required, today);
    return { skipped, required };
  };

  it("sets a required tick aside for a host., clock or browser-scoped visibility, naming only the nodes whose own rule was skipped", () => {
    const root = form(
      field("plain", { required: true }),
      field("hosted", { required: true }, { visibleWhen: eq("host.role", "staff") }),
      field("clocked", { required: true }, { visibleWhen: clock }),
      field("browsery", { required: true }, { visibleWhen: { expression: eq("plain", "x"), run: "browser" } }),
      field("replayable", { required: true }, { visibleWhen: eq("plain", "x") })
    );
    const { skipped, required } = relax(root);
    expect(skipped).toEqual(["hosted", "clocked", "browsery"]);
    expect(required).toEqual({ plain: true, hosted: false, clocked: false, browsery: false, replayable: true });
    // With a day the clock rule is replayable and the tick stands.
    const dated = relax(root, "2026-10-08");
    expect(dated.skipped).toEqual(["hosted", "browsery"]);
    expect(dated.required.clocked).toBe(true);
  });

  it("reaches everything under a skipped ancestor, parents before children, but not a field that opts into staying required", () => {
    const root = form(
      group("box", "fieldset", [field("inner", { required: true }), group("deep", "fieldset", [field("deeper", { required: true })]), field("stays", { required: true, hiddenRequiredBehavior: "required" })], {}),
      field("after", { required: true })
    );
    (root.children as { content: ComponentNode[] }).content[0]!.rules = { visibleWhen: eq("host.role", "staff") };
    const { skipped, required } = relax(root);
    expect(skipped).toEqual(["box"]);
    expect(required).toEqual({ box: false, inner: false, deep: false, deeper: false, stays: true, after: true });
  });

  it("leaves an unticked field alone and never reads the root", () => {
    const root = form(field("optional", {}, { visibleWhen: eq("host.role", "staff") }));
    root.rules = { visibleWhen: eq("host.role", "staff") };
    const { skipped, required } = relax(root);
    expect(skipped).toEqual(["optional"]);
    expect(required).toEqual({ optional: false });
  });
});

describe("SUBMITTABLE_FOLD_FUNCTIONS", () => {
  it("lists every exported function of the fold, each a top-level declaration", async () => {
    const module = (await import("../form-engine/core/state/submittable-fold.js")) as Record<string, unknown>;
    const exported = Object.entries(module)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(SUBMITTABLE_FOLD_FUNCTIONS.map((fn) => fn.name).sort()).toEqual(exported);
    for (const fn of SUBMITTABLE_FOLD_FUNCTIONS) {
      expect(fn.toString().startsWith(`function ${fn.name}(`)).toBe(true);
    }
  });
});

describe("kernelFoldSubmittable: the first pass converges without a second look when the policy changed nothing", () => {
  it("reports whether the hidden-value policy dropped or cleared an answer", () => {
    const state = (submitValue: boolean, clearValue: boolean) => ({ visible: true, disabled: false, readonly: false, runValidation: true, requiredApplies: true, submitValue, clearValue });
    const values = { a: 1, b: "two", "rows[0].x": 3 };
    const kept = { changed: false };
    const same = kernelApplyValuePolicy(values, { a: state(true, false), b: state(true, false) }, {}, undefined, kept);
    expect(kept.changed).toBe(false);
    expect({ ...same }).toStrictEqual(values);

    const dropped = { changed: false };
    expect({ ...kernelApplyValuePolicy(values, { a: state(false, false) }, {}, undefined, dropped) }).toStrictEqual({ b: "two", "rows[0].x": 3 });
    expect(dropped.changed).toBe(true);

    const cleared = { changed: false };
    const result = kernelApplyValuePolicy(values, { b: state(true, true) }, {}, undefined, cleared);
    expect(cleared.changed).toBe(true);
    expect(Object.keys(result)).toStrictEqual(["a", "b", "rows[0].x"]);
    expect(result.b).toBeUndefined();

    // No report asked for: the same result.
    expect({ ...kernelApplyValuePolicy(values, { a: state(false, false) }, {}) }).toStrictEqual({ b: "two", "rows[0].x": 3 });
  });

  it("converges in one pass with a hidden field whose answer is kept, and in more when an answer is dropped", () => {
    const root = form(field("mode"), field("detail", { hiddenValueBehavior: "retain" }, { visibleWhen: eq("mode", "detailed") }));
    const kept = fold(root, { mode: "simple", detail: "x" });
    expect(kept.effective.detail?.visible).toBe(false);
    expect({ ...kept.submittable }).toStrictEqual({ mode: "simple", detail: "x" });
    expect(kept.converged).toBe(true);
    expect(kept.passes).toBe(1);
    expect({ ...kept.idValues }).toStrictEqual({ mode: "simple", detail: "x" });

    const excluded = form(field("mode"), field("detail", EXCLUDE, { visibleWhen: eq("mode", "detailed") }));
    const dropped = fold(excluded, { mode: "simple", detail: "x" });
    expect({ ...dropped.submittable }).toStrictEqual({ mode: "simple" });
    expect(dropped.converged).toBe(true);
    expect(dropped.passes).toBe(2);
    expect({ ...dropped.idValues }).toStrictEqual({ mode: "simple" });
  });

  it("reads the view the rules saw, an undefined answer among them, as it did before", () => {
    const root = form(field("a"), field("b"));
    const result = fold(root, { a: undefined, b: 2 });
    expect(result.converged).toBe(true);
    expect(result.passes).toBe(1);
    expect({ ...result.idValues }).toStrictEqual({ b: 2 });
  });

  it("lists the fold's functions once each", () => {
    expect(new Set(SUBMITTABLE_FOLD_FUNCTIONS).size).toBe(SUBMITTABLE_FOLD_FUNCTIONS.length);
  });
});

// The fold takes the path engine as input, so a form without a journey folds without
// loading it, and the journey's walk is whatever the caller hands in: the browser's module
// function, the kernel's spliced one.
describe("kernelFoldSubmittable takes the path engine as input", () => {
  const root = form(field("eligible"), group("extra", "fieldset", [field("income")]), field("name"));
  const journey: Journey = {
    id: "apply",
    pages: [
      { id: "start", components: ["eligible"], routes: [{ when: neq("eligible", "yes"), to: "last" }] },
      { id: "more", components: ["extra"] },
      { id: "last", components: ["name"] }
    ]
  };
  const values = { eligible: "yes", income: 500, name: "Ada" };

  it("walks the path and places the components with the functions it is handed, and only those", () => {
    // The real engine takes the conditional page for these answers; the stub never does.
    expect(fold(root, values, journey).trace?.pages).toEqual(["start", "more", "last"]);

    const input = foldInput(root, values, journey);
    const fold0 = input.journey as NonNullable<KernelFoldInput["journey"]>;
    const stubTrace: JourneyTrace = { pages: ["start", "last"], end: "end", decisions: [] };
    const walked: Array<{ journey: Journey; input: JourneyPathInput }> = [];
    const placed: Array<{ trace: JourneyTrace }> = [];
    input.journey = {
      ...fold0,
      path: (asked, pathInput) => {
        walked.push({ journey: asked, input: pathInput });
        return stubTrace;
      },
      place: (ownership, trace) => {
        expect(ownership).toBe(fold0.ownership);
        placed.push({ trace });
        // A placement the real engine would never give: the section on, the field inside it off.
        const placements = Object.create(null) as Record<string, JourneyPlacement>;
        placements.eligible = "on";
        placements.extra = "on";
        placements.income = "off";
        placements.name = "off";
        return placements;
      }
    };
    const result = kernelFoldSubmittable(input);

    expect(result.trace).toBe(stubTrace);
    expect(walked.length).toBe(result.passes);
    expect(placed.length).toBe(result.passes);
    for (const call of walked) {
      expect(call.journey).toBe(journey);
      expect(call.input.ownership).toBe(fold0.ownership);
      // The walk reads the values re-keyed by id.
      expect(call.input.values.eligible).toBe("yes");
    }
    for (const call of placed) {
      expect(call.trace).toBe(stubTrace);
    }
    // What the stub placed is what the fold folded: `name` off the path, `income` off inside an
    // `extra` the stub keeps on.
    expect({ ...result.placements }).toStrictEqual({ eligible: "on", extra: "on", income: "off", name: "off" });
    expect(result.effective.name).toMatchObject({ visible: false, runValidation: false });
    expect(result.effective.income).toMatchObject({ visible: false, runValidation: false });
    expect(result.effective.eligible).toMatchObject({ visible: true });
  });

  it("folds a form without a journey to no trace and no placements", () => {
    const input = foldInput(root, values);
    expect(input.journey).toBeUndefined();
    const result = kernelFoldSubmittable(input);
    expect(result.trace).toBeUndefined();
    expect(result.placements).toBeUndefined();
  });

  it("hands back exactly what the real engine, passed through a wrapper, works out", () => {
    for (const answers of [values, { eligible: "no", income: 500, name: "Ada" }]) {
      const plain = fold(root, answers, journey);
      const input = foldInput(root, answers, journey);
      const fold0 = input.journey as NonNullable<KernelFoldInput["journey"]>;
      const traces: JourneyTrace[] = [];
      input.journey = {
        ...fold0,
        path: (asked, pathInput) => {
          const trace = journeyPath(asked, pathInput);
          traces.push(trace);
          return trace;
        },
        place: (ownership, trace) => journeyPlacements(ownership, trace)
      };
      const wrapped = kernelFoldSubmittable(input);
      expect(traces.length).toBe(wrapped.passes);
      expect(wrapped.trace).toBe(traces[traces.length - 1]);
      expect(JSON.stringify(wrapped)).toBe(JSON.stringify(plain));
    }
  });
});

/** A module's source, read beside the test. */
function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/** The names a module value-imports (type-only imports left out) from a specifier ending in `suffix`. */
function valueImportsFrom(source: string, suffix: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";/gm)) {
    if (match[1] === undefined && (match[3] as string).endsWith(suffix)) {
      for (const part of (match[2] as string).split(",")) {
        const name = part.trim().replace(/^type\s+/, "");
        if (name.length > 0 && !part.trim().startsWith("type ")) {
          names.push(name);
        }
      }
    }
  }
  for (const match of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gm)) {
    if ((match[1] as string).endsWith(suffix) && !/^import\s+\{/.test(match[0])) {
      names.push("<namespace or default>");
    }
  }
  return names.sort();
}

describe("the fold and the kernel's browser-reachable code import no path engine", () => {
  const PATH_ONLY = JOURNEY_PATH_FUNCTIONS.map((fn) => fn.name).filter((name) => !Object.hasOwn(journeyShared, name));

  it("the fold imports nothing from the path engine, statically or dynamically", () => {
    const source = sourceOf("../form-engine/core/state/submittable-fold.ts");
    expect(source).not.toMatch(/from\s+"[^"]*journey-path(?:\.js)?"/);
    expect(source).not.toMatch(/import\(\s*"[^"]*journey-path/);
    for (const fn of SUBMITTABLE_FOLD_FUNCTIONS) {
      for (const name of PATH_ONLY) {
        expect(fn.toString(), `${fn.name} reads ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });

  it("the kernel reads the path engine only in the server's fold and the splice list", () => {
    const source = sourceOf("../form-engine/validation/wasm/portable-kernel.ts");
    expect(valueImportsFrom(source, "/journey/journey-path.js")).toEqual(["JOURNEY_PATH_FUNCTIONS", "journeyOwnership", "journeyPath", "journeyPlacements", "journeyReachable", "journeyRuleTree"]);
    // The kernel's own functions, the spliced modules' too: only kernelFoldSubmission,
    // kernelJourneyClockPages (run by runKernel and the in-process host, never by a browser form)
    // kernelFormTestOpPerform (the `test` op, reached through `__datum_inspect` only; its `go to`
    // check reads `journeyReachable`) and kernelFormTestServerChange (the same op's
    // `change` line, whose reachability check reads `journeyReachable` too) name a path-only function.
    const pathFunctions = new Set<unknown>(JOURNEY_PATH_FUNCTIONS);
    const readers = PORTABLE_KERNEL_FUNCTIONS.filter((fn) => !pathFunctions.has(fn))
      .filter((fn) => PATH_ONLY.some((name) => new RegExp(`\\b${name}\\b`).test(fn.toString())))
      .map((fn) => fn.name);
    expect(readers).toEqual(["kernelJourneyClockPages", "kernelFoldSubmission", "kernelFormTestServerChange", "kernelFormTestOpPerform"]);
  });

  it("the shared helpers import types only, and the path engine splices each of them as it is", () => {
    const source = sourceOf("../form-engine/core/journey/journey-shared.ts");
    expect(source.match(/^import\s+(?!type\b).*$/gm) ?? []).toEqual([]);
    const shared = Object.entries(journeyShared).filter(([, value]) => typeof value === "function");
    expect(shared.map(([name]) => name).sort()).toEqual(["journeyCollectionPathOf", "journeyHoldsOwnAnswer", "journeyLeadingSegment", "journeyOwn"]);
    // The four are the module's only code: a local helper one of them called would be a plain
    // identifier, which the sandbox splice (the four alone) would leave dangling.
    const declared = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)/gm)].map((match) => match[1]).sort();
    expect(declared).toEqual(shared.map(([name]) => name).sort());
    expect(source.match(/^(?:export\s+)?(?:const|let|var|class)\s/gm) ?? []).toEqual([]);
    for (const [name, fn] of shared) {
      expect(JOURNEY_PATH_FUNCTIONS, name).toContain(fn);
      expect((fn as () => unknown).toString(), name).not.toMatch(/__vi(?:te)?_(?:ssr_)?import_\d+__/);
    }
  });
});

/**
 * A data grid's bound formulas: read over the settled view through the
 * caller's `ruleRowBound`, only on a grid, never for a rule reading `row.`; the result keeps its
 * shape for every form without one.
 */
describe("kernelFoldSubmittable: a data grid's bound formulas", () => {
  const people: Expression = { kind: "path", path: "people" };
  const readsRow: Expression = { kind: "path", path: "row.qty" };
  const gridOf = (id: string, rules: Record<string, unknown>, type = "dataGrid"): ComponentNode =>
    ({
      id,
      type,
      configuration: {},
      collection: { collectionPath: id },
      rules,
      children: { content: [{ id: id + "_qty", type: "number", configuration: {} }] }
    }) as unknown as ComponentNode;
  const formOf = (...children: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: children } });
  const withBounds = (root: ComponentNode, values: Record<string, unknown>, asked: string[] = []): KernelFoldResult => {
    const input = foldInput(root, values);
    input.ruleRowBound = (node, key, idValues) => {
      asked.push(node.id + ":" + key);
      return evaluateExpression(kernelCompiledRule(node.rules?.[key]) as Expression, { values: idValues });
    };
    return kernelFoldSubmittable(input);
  };

  it("reads each grid's minRows and maxRows over the settled view, in document order", () => {
    const root = formOf({ id: "people", type: "number", configuration: {} }, gridOf("a", { minRows: people }), gridOf("b", { maxRows: people, minRows: { expression: { kind: "literal", value: 2 } } }));
    const asked: string[] = [];
    const result = withBounds(root, { people: 3 }, asked);
    expect({ ...result.rowBounds }).toEqual({ a: { min: 3 }, b: { min: 2, max: 3 } });
    expect(asked).toEqual(["a:minRows", "b:minRows", "b:maxRows"]);
  });

  it("never asks for a bound that reads row., nor one on a component that is not a grid", () => {
    const asked: string[] = [];
    const root = formOf(gridOf("a", { minRows: readsRow, maxRows: people }), gridOf("sec", { minRows: people }, "container"));
    expect({ ...withBounds(root, { people: 4 }, asked).rowBounds }).toEqual({ a: { max: 4 } });
    expect(asked).toEqual(["a:maxRows"]);
    // Only row reads: nothing to list, and no rowBounds at all.
    expect(withBounds(formOf(gridOf("a", { minRows: readsRow })), {})).not.toHaveProperty("rowBounds");
  });

  it("leaves the result as it was without the caller's reader or without a bound rule", () => {
    const root = formOf({ id: "people", type: "number", configuration: {} }, gridOf("a", { minRows: people }));
    expect(fold(root, { people: 3 })).not.toHaveProperty("rowBounds");
    expect(withBounds(formOf(gridOf("a", {})), {})).not.toHaveProperty("rowBounds");
    expect(withBounds(formOf(gridOf("a", { minRows: null })), {})).not.toHaveProperty("rowBounds");
  });

  it("reads the view the hidden-value policy settled on: a hidden answer it clears is no input to a bound", () => {
    const hidden: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "show" }, right: { kind: "literal", value: true } };
    const root = formOf(
      { id: "show", type: "checkbox", configuration: {} },
      { id: "people", type: "number", configuration: { hiddenValueBehavior: "clear" }, rules: { visibleWhen: hidden } },
      gridOf("a", { minRows: people })
    );
    expect({ ...withBounds(root, { show: true, people: 3 }).rowBounds }).toEqual({ a: { min: 3 } });
    expect({ ...withBounds(root, { show: false, people: 3 }).rowBounds }).toEqual({ a: { min: undefined } });
  });

  it("is spliced", () => {
    expect(SUBMITTABLE_FOLD_FUNCTIONS).toContain(kernelFoldRowBounds);
    expect(kernelFoldRowBounds.toString().startsWith("function kernelFoldRowBounds(")).toBe(true);
  });
});
