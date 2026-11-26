import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import { diagnoseJourneys } from "../form-engine/core/journey/journey-diagnostics.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";

/**
 * What the kernel does with a form field a journey leaves out or routes around, pinned case by
 * case beside the whole form's verdict so the gap between the two is the thing under test.
 * Form rules always hold, so a field on no page is judged as the whole form judges it:
 *
 * - On no page: judged exactly as the whole form judges it — required, validated, its answer
 *   kept by its own behaviour.
 * - On a page the journey's routes skip: hidden, not required, answer dropped.
 *   The server replays the path from the answers, so a journey's own
 *   routing can still relax a form-Required field.
 * - Left out with a visibility rule reading `host.`: the earlier fold is kept on both sides
 *   (hidden, not required), since the server cannot evaluate the rule and must never be
 *   stricter than the browser (`rule.reads-host`).
 * - Hidden on the form with `hiddenRequiredBehavior: "required"`: the whole-form fold honours
 *   the opt-in, so the field is required when left out too.
 */

const path = (name: string): Expression => ({ kind: "path", path: name });
const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
const eq = (name: string, value: string | number | boolean | null): Expression => ({
  kind: "binary",
  operator: "eq",
  left: path(name),
  right: literal(value)
});

const text = (id: string, configuration: Record<string, unknown> = {}, rules?: ComponentNode["rules"]): ComponentNode => ({
  id,
  type: "text",
  configuration,
  ...(rules ? { rules } : {})
});
const form = (...children: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: children } });

const codes = (errors: readonly { componentId?: string; code: string }[]): string[] => errors.map((error) => `${error.componentId ?? "-"}:${error.code}`);

function run(root: ComponentNode, values: Record<string, unknown>, journey?: Journey): { errors: string[]; values?: Record<string, unknown> } {
  const outcome = runKernel({ formId: "f", values, locale: "en", form: root, ...(journey ? { journey } : {}) }, []);
  return outcome.values === undefined ? { errors: codes(outcome.errors) } : { errors: codes(outcome.errors), values: outcome.values };
}

function findings(root: ComponentNode, journey: Journey): string[] {
  return diagnoseJourneys({ root, journey: { journeys: [journey] } }).map((finding) => `${finding.severity}:${finding.code}`);
}

/** Asks only `a`; whatever else the form holds is on no page. */
const leavesOut: Journey = { id: "left", pages: [{ id: "p1", components: ["a"] }] };

describe("form fields a journey leaves out or routes around", () => {
  it("requires a left-out field as the whole form does, keeps its answer and holds it to its format", () => {
    const root = form(text("a"), text("req", { required: true, maxLength: 3 }));
    expect(run(root, { a: "x" })).toEqual({ errors: ["req:required"] });

    // The same verdict on the journey: `required` holds for a field on no page.
    expect(run(root, { a: "x" }, leavesOut)).toEqual({ errors: ["req:required"] });
    // Not dropped: a client-sent answer is stored, and its shape is checked on the way in.
    expect(run(root, { a: "x", req: "ok" }, leavesOut)).toEqual({ errors: [], values: { a: "x", req: "ok" } });
    expect(run(root, { a: "x", req: "toolong" }, leavesOut)).toEqual({ errors: ["req:maxLength"] });

    // The builder names the left-out field; its severity for a required one is the builder half
    // of the diagnostics (an error), asserted with the diagnostics' own tests.
    expect(findings(root, leavesOut).some((finding) => finding.endsWith(":component.unassigned"))).toBe(true);
  });

  it("lets a journey's route, unconditional or conditional, relax a form-Required field, with only a warning from the builder", () => {
    const root = form(text("a"), text("req", { required: true }));
    const routeSkips: Journey = {
      id: "skip",
      pages: [
        { id: "p1", components: ["a"], routes: [{ to: "$end" }] },
        { id: "p2", components: ["req"] }
      ]
    };
    const conditionSkips: Journey = {
      id: "cond",
      pages: [
        { id: "p1", components: ["a"], routes: [{ when: ({ ...eq("a", "never"), operator: "neq" } as Expression), to: "$end" }] },
        { id: "p2", components: ["req"] }
      ]
    };
    expect(run(root, { a: "x" })).toEqual({ errors: ["req:required"] });

    // Off the path: not required, and an answer sent for it is withheld from the submission.
    expect(run(root, { a: "x", req: "sent anyway" }, routeSkips)).toEqual({ errors: [], values: { a: "x" } });
    expect(run(root, { a: "x", req: "sent anyway" }, conditionSkips)).toEqual({ errors: [], values: { a: "x" } });

    expect(findings(root, routeSkips)).toContain("warning:page.unreachable");
    expect(findings(root, routeSkips).some((finding) => finding.startsWith("error:"))).toBe(false);
    expect(findings(root, conditionSkips)).not.toContain("warning:component.unassigned");
    expect(findings(root, conditionSkips).some((finding) => finding.startsWith("error:"))).toBe(false);
  });

  it("keeps the lenient fold for a left-out field whose visibility reads host., its own rule's or an ancestor's", () => {
    const root = form(text("a"), text("staff_ref", { required: true }, { visibleWhen: eq("host.role", "staff") }));
    // The server cannot evaluate the host rule, so whole-form mode keeps the field visible but
    // no longer asks for it (a visibility the server cannot replay is
    // hidden for requiredness)…
    expect(run(root, { a: "x" })).toEqual({ errors: [], values: { a: "x" } });
    // …but on no page of a journey it keeps the earlier fold on both sides: hidden, not required,
    // not checked, its answer kept. The browser follows the host and the server cannot, so a
    // journey that judged the field by its rules would part the two sides on a field nobody
    // sees; leniency on both is the lesser evil, and the hole it leaves (a client may name such
    // a journey to skip a host-gated field the whole form requires) is documented.
    expect(run(root, { a: "x" }, leavesOut)).toEqual({ errors: [], values: { a: "x" } });
    expect(run(root, { a: "x", staff_ref: "S-1" }, leavesOut)).toEqual({ errors: [], values: { a: "x", staff_ref: "S-1" } });
    // Through an ancestor's visibility too — one on no page itself…
    const nested = form(text("a"), {
      id: "staff_box",
      type: "fieldset",
      configuration: {},
      rules: { visibleWhen: eq("host.role", "staff") },
      children: { content: [text("nested_ref", { required: true })] }
    });
    expect(run(nested, { a: "x" })).toEqual({ errors: [], values: { a: "x" } }); // not nested_ref:required
    expect(run(nested, { a: "x" }, leavesOut)).toEqual({ errors: [], values: { a: "x" } });
    // …or one that holds a listed field (the re-check's case: the box is structural, the sibling on no page).
    const boxed = form(text("a"), {
      id: "hbox",
      type: "fieldset",
      configuration: {},
      rules: { visibleWhen: eq("host.role", "staff") },
      children: { content: [text("listed"), text("sibling", { required: true })] }
    });
    const listsOne: Journey = { id: "left", pages: [{ id: "p1", components: ["a", "listed"] }] };
    expect(run(boxed, { a: "x" })).toEqual({ errors: [], values: { a: "x" } }); // not sibling:required
    expect(run(boxed, { a: "x" }, listsOne)).toEqual({ errors: [], values: { a: "x" } });
    // An opt-in does not lift the exception: the lenient fold is the earlier one, whole.
    const optIn = form(text("a"), text("seeded", { required: true, hidden: true, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" }, { visibleWhen: eq("host.role", "staff") }));
    expect(run(optIn, { a: "x" })).toEqual({ errors: ["seeded:required"] });
    expect(run(optIn, { a: "x" }, leavesOut)).toEqual({ errors: [], values: { a: "x" } });
    // The builder names each of these as a warning, never a blocking error.
    for (const [tree, journey] of [
      [root, leavesOut],
      [nested, leavesOut],
      [boxed, listsOne],
      [optIn, leavesOut]
    ] as const) {
      expect(findings(tree, journey)).toContain("warning:component.unassigned");
      expect(findings(tree, journey).some((finding) => finding.startsWith("error:"))).toBe(false);
    }
  });

  it("requires a left-out field that is hidden on the form yet opts into hidden required/validation, as the whole form does", () => {
    const root = form(
      text("a"),
      text("case_no", { hidden: true, required: true, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" })
    );
    expect(run(root, { a: "x" })).toEqual({ errors: ["case_no:required"] });
    // The opt-in holds on the journey too: a field on no page is required.
    expect(run(root, { a: "x" }, leavesOut)).toEqual({ errors: ["case_no:required"] });
    expect(run(root, { a: "x", case_no: "C-1" }, leavesOut)).toEqual({ errors: [], values: { a: "x", case_no: "C-1" } });
  });
});
