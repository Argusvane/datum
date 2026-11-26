import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { validateJourneyShape, type Journey, type JourneyPage, type JourneyPageEntry } from "../form-engine/core/schema/journey.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import {
  diagnoseJourney,
  diagnoseJourneys,
  journeyEmptyAnswer,
  journeyCertainWalk,
  type JourneyDiagnostic
} from "../form-engine/core/journey/journey-diagnostics.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage, isEmptyValue } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { kernelIsEmptyValue } from "../form-engine/core/schema/answer-kinds.js";
import { runKernel as kernelRun } from "../form-engine/validation/wasm/portable-kernel.js";
import { journeyOwnership } from "../form-engine/core/journey/journey-path.js";
import { APPLY_ABOVE, APPLY_BELOW, applyJourney, presentationForm, presentationRoot, publicVariant, workEmailAlias } from "./fixtures/presentation-form.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";

// A host hands the kernel the function table's signatures, as the in-process and sandbox hosts
// do: a tree's calls are checked against them like a formula's. These runs do the same.
const runKernel = (
  context: Parameters<typeof kernelRun>[0],
  validators: Parameters<typeof kernelRun>[1],
  functions?: Parameters<typeof kernelRun>[2],
  signatures: Parameters<typeof kernelRun>[3] = formulaFunctionSignatures(),
  cache?: Parameters<typeof kernelRun>[4]
): ReturnType<typeof kernelRun> => kernelRun(context, validators, functions, signatures, cache);

function field(id: string, type = "text", extra: Partial<ComponentNode> = {}): ComponentNode {
  // A choice offers the answers these tests give: the kernel holds a choice to its options.
  const options = type === "radio" || type === "select" ? { options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] } : {};
  return { id, type, configuration: { label: id, ...options }, ...extra };
}

function group(id: string, type: string, children: ComponentNode[], extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type, configuration: { label: id }, children: { content: children }, ...extra };
}

function eq(path: string, value: string | number | boolean | null): Expression {
  return { kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value } };
}

const tree = group("form", "form", [
  field("eligible", "radio"),
  field("name"),
  field("email"),
  group("extra", "fieldset", [field("income", "number")]),
  { id: "bye", type: "html", configuration: { content: "<p>Sorry.</p>" } }
]);

const start: JourneyPage = { id: "start", title: "Start", components: ["eligible"] };
const about: JourneyPage = { id: "about", title: "About you", components: ["name", "email"] };
const money: JourneyPage = { id: "money", title: "Money", components: ["extra"] };

function journeyOf(...pages: JourneyPage[]): Journey {
  return { id: "apply", pages };
}

function path(name: string): Expression {
  return { kind: "path", path: name };
}

function times2(name: string): Expression {
  return { kind: "arithmetic", operator: "multiply", left: path(name), right: { kind: "literal", value: 2 } };
}

function call(name: "sum" | "coalesce" | "concat" | "round", ...args: Expression[]): Expression {
  return { kind: "call", name, args };
}

/**
 * What every side refuses of `answers` given through `journey`: the fold the diagnostics must
 * agree with. The browser (told `role` by its host, when given) judges the submission; the
 * server judges what the browser sends — its envelope, calculations and defaults as the
 * browser worked them out — and the two must agree.
 */
async function refused(root: ComponentNode, journey: Journey, answers: Record<string, unknown>, role?: string): Promise<string[]> {
  const form = { id: "f", version: "1", root, journey: { journeys: [journey] } } as FormDefinition;
  const envelope = { form: { id: "f", version: "1" }, client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" } };
  const browser = (): FormRuntime => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
    const runtime = new FormRuntime(form, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(root)]),
      ...(role !== undefined ? { hostContext: { role } } : {})
    });
    for (const [key, value] of Object.entries(answers)) {
      runtime.setValue(key, value);
    }
    return runtime;
  };
  const keyed = (errors: ReadonlyArray<{ componentId?: string; code: string }>): string[] => errors.map((error) => `${error.componentId ?? "-"}:${error.code}`);
  const submitted = await browser().submit("submit", envelope);
  const sent = (submitted.accepted ? submitted : await browser().submit("send", envelope)).canonicalSubmission?.submission.values ?? answers;
  const server = runKernel({ formId: "f", values: sent, locale: "en", form: root, journey, ...(role !== undefined ? { externalData: { role } } : {}) }, []);
  expect(keyed(server.errors)).toEqual(keyed(submitted.errors));
  return keyed(submitted.errors);
}

function codes(diagnostics: JourneyDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

function only(diagnostics: JourneyDiagnostic[], code: string): JourneyDiagnostic {
  const found = diagnostics.filter((diagnostic) => diagnostic.code === code);
  expect(found).toHaveLength(1);
  return found[0] as JourneyDiagnostic;
}

describe("diagnoseJourney", () => {
  it("finds nothing wrong with a well-formed journey", () => {
    const journey = journeyOf(
      { ...start, routes: [{ when: eq("eligible", "no"), to: "stop" }] },
      about,
      { ...money, routes: [{ to: "$end" }] },
      { id: "stop", kind: "exit", title: "Not eligible", components: ["bye"] }
    );
    expect(diagnoseJourney(tree, journey)).toEqual([]);
  });

  describe("errors", () => {
    it("journey.no-end: every path stops at an exit page", () => {
      const diagnostics = diagnoseJourney(tree, journeyOf(start, about, money, { id: "stop", kind: "exit", title: "Stop" }));
      const diagnostic = only(diagnostics, "journey.no-end");
      expect(diagnostic).toMatchObject({ severity: "error", journeyId: "apply" });
      expect(diagnostic.message).toBe('Every path through journey "apply" ends at an exit page, so it can never be submitted.');
      expect(codes(diagnostics)).toEqual(["journey.no-end"]);
    });

    it("journey.no-end: not when a route can pass over the exit page", () => {
      const stop: JourneyPage = { id: "stop", kind: "exit", title: "Stop" };
      expect(diagnoseJourney(tree, journeyOf({ ...start, routes: [{ when: eq("eligible", "yes"), to: "about" }] }, stop, about, money))).toEqual([]);
    });

    it("journey.no-end: a journey with no pages", () => {
      const diagnostics = diagnoseJourney(tree, journeyOf());
      expect(only(diagnostics, "journey.no-end").message).toBe('Journey "apply" has no pages, so there is nothing to submit from.');
    });

    it("page.duplicate-id", () => {
      const diagnostics = diagnoseJourney(tree, journeyOf(start, about, { ...money, id: "about" }));
      expect(codes(diagnostics)).toEqual(["page.duplicate-id"]);
      // Said of the page that repeats the id, by its position: the third page, not the second.
      expect(diagnostics[0]).toMatchObject({ severity: "error", pageId: "about", pageIndex: 2 });
    });

    it("page.id-is-component-id", () => {
      const diagnostics = diagnoseJourney(tree, journeyOf(start, { ...about, id: "email" }, money));
      expect(codes(diagnostics)).toEqual(["page.id-is-component-id"]);
      expect(diagnostics[0]).toMatchObject({ severity: "error", pageId: "email" });
    });

    it("page.unknown-component", () => {
      const diagnostics = diagnoseJourney(tree, journeyOf(start, { ...about, components: ["name", "email", "phone"] }, money));
      expect(codes(diagnostics)).toEqual(["page.unknown-component"]);
      expect(diagnostics[0]).toMatchObject({ severity: "error", pageId: "about", componentId: "phone" });
      expect(diagnostics[0]?.message).toBe('Page "about" lists phone, which is not a component of the form.');
    });

    it("page.root-component", () => {
      const diagnostics = diagnoseJourney(tree, journeyOf(start, { ...about, components: ["form", "name", "email"] }, money));
      expect(codes(diagnostics)).toEqual(["page.root-component"]);
      expect(diagnostics[0]).toMatchObject({ severity: "error", pageId: "about", componentId: "form" });
    });

    it("route.unknown-target", () => {
      const diagnostics = diagnoseJourney(tree, journeyOf({ ...start, routes: [{ when: eq("eligible", "no"), to: "nowhere" }] }, about, money));
      expect(codes(diagnostics)).toEqual(["route.unknown-target"]);
      expect(diagnostics[0]).toMatchObject({ severity: "error", pageId: "start", routeIndex: 0 });
    });

    it("route.backward: to an earlier page, or to the page itself", () => {
      const diagnostics = diagnoseJourney(
        tree,
        journeyOf(start, about, { ...money, routes: [{ when: eq("eligible", "yes"), to: "start" }, { when: eq("eligible", "no"), to: "money" }] })
      );
      expect(codes(diagnostics)).toEqual(["route.backward", "route.backward"]);
      expect(diagnostics.map((diagnostic) => diagnostic.routeIndex)).toEqual([0, 1]);
      expect(diagnostics[0]?.message).toBe('Route 1 of page "money" goes back to page "start"; routes only go forward, so it is ignored.');
      expect(diagnostics[1]?.message).toBe('Route 2 of page "money" goes to the page itself; routes only go forward, so it is ignored.');
    });

    it("condition.scope: row., ancestor., host. and component paths in a route's condition", () => {
      const diagnostics = diagnoseJourney(
        tree,
        journeyOf(
          { ...start, routes: [{ when: { kind: "logical", operator: "or", left: { kind: "path", path: "host.region" }, right: { kind: "path", path: "component" } }, to: "money" }] },
          about,
          { ...money, routes: [{ when: eq("row.sku", "A"), to: "$end" }, { when: eq("ancestor.items", 1), to: "$end" }] }
        )
      );
      expect(codes(diagnostics)).toEqual(["condition.scope", "condition.scope", "condition.scope", "condition.scope"]);
      expect(diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
      expect(diagnostics.map((diagnostic) => [diagnostic.pageId, diagnostic.routeIndex])).toEqual([["start", 0], ["start", 0], ["money", 0], ["money", 1]]);
    });

    it("condition.invalid: an operator, function or operand the evaluator does not know", () => {
      const diagnostics = diagnoseJourney(
        tree,
        journeyOf(
          { ...start, routes: [{ when: { kind: "binary", operator: "equals", left: { kind: "path", path: "eligible" }, right: { kind: "literal", value: "yes" } } as unknown as Expression, to: "money" }] },
          about,
          {
            ...money,
            routes: [
              { when: { kind: "call", name: "now", args: [] } as unknown as Expression, to: "$end" },
              { when: { kind: "unary", operator: "not" } as unknown as Expression, to: "$end" }
            ]
          }
        )
      );
      expect(codes(diagnostics)).toEqual(["condition.invalid", "condition.invalid", "condition.invalid"]);
      expect(diagnostics[0]).toMatchObject({ severity: "error", pageId: "start", routeIndex: 0 });
      expect(diagnostics[0]?.message).toBe('Route 1 of page "start" is not a condition the engine can evaluate, or a formula that does not parse.');
    });
  });

  describe("warnings", () => {
    it("component.unassigned: a visible, uncalculated component holding data, on no page", () => {
      const wider = group("form", "form", [
        field("eligible", "radio"),
        field("notes"),
        field("secret", "text", { configuration: { label: "secret", hidden: true } }),
        field("score", "number", { rules: { value: { kind: "literal", value: 1 } } }),
        field("send", "button"),
        group("panel", "fieldset", [field("phone")]),
        group("address", "container", [field("street"), field("city")]),
        group("items", "repeatingSection", [field("sku")], { collection: {} })
      ]);
      const diagnostics = diagnoseJourney(wider, journeyOf(start));
      // One per field left out, then the one summary of them.
      expect(codes(diagnostics)).toEqual([
        "component.unassigned",
        "component.unassigned",
        "component.unassigned",
        "component.unassigned",
        "presentation.fields-left-out"
      ]);
      expect(diagnostics.slice(0, 4).map((diagnostic) => diagnostic.componentId)).toEqual(["notes", "phone", "address", "items"]);
      expect(diagnostics[0]).toMatchObject({ severity: "warning", required: false });
      expect(diagnostics[0]?.message).toBe('notes is on no page of journey "apply", so the journey never asks for it.');
      expect(diagnostics[4]).toMatchObject({ severity: "warning", journeyId: "apply" });
      expect(diagnostics[4]?.componentId).toBeUndefined();
      // Named as the builder's tray lists them: phone by the fieldset it sits in, which holds no answer of its own.
      expect(diagnostics[4]?.message).toBe(
        '4 form fields are not asked in journey "apply": "notes", "panel", "address" and "items". The server still holds their answers to the form\'s rules.'
      );
    });

    it("presentation.fields-left-out: counted and named as the tray lists them, the first five by name and one \"and\"", () => {
      const wider = group("form", "form", [
        field("eligible", "radio"),
        group("panel", "fieldset", [field("phone"), field("mobile"), group("inner", "fieldset", [field("fax")])]),
        field("a"),
        field("b"),
        field("c"),
        field("d"),
        field("e")
      ]);
      const diagnostics = diagnoseJourney(wider, journeyOf(start));
      // Each field on no page is reported as it was; the summary counts the fieldset once, for everything in it.
      expect(diagnostics.filter((diagnostic) => diagnostic.code === "component.unassigned").map((diagnostic) => diagnostic.componentId)).toEqual([
        "phone",
        "mobile",
        "fax",
        "a",
        "b",
        "c",
        "d",
        "e"
      ]);
      expect(diagnostics.at(-1)?.message).toBe(
        '6 form fields are not asked in journey "apply": "panel", "a", "b", "c", "d" and 1 more. The server still holds their answers to the form\'s rules.'
      );
    });

    it("component.unassigned: an error for a field the form requires, by the tick or a Required-when rule", () => {
      const wider = group("form", "form", [
        field("eligible", "radio"),
        field("name", "text", { configuration: { label: "name", required: true } }),
        field("phone", "text", { rules: { requiredWhen: eq("eligible", "yes") } }),
        field("notes")
      ]);
      const diagnostics = diagnoseJourney(wider, journeyOf(start));
      expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.componentId, diagnostic.required])).toEqual([
        ["component.unassigned", "error", "name", true],
        ["component.unassigned", "error", "phone", true],
        ["component.unassigned", "warning", "notes", false],
        ["presentation.fields-left-out", "warning", undefined, undefined]
      ]);
      expect(diagnostics[0]?.message).toBe(
        'name is required by the form and on no page of journey "apply", so no submission through the journey can pass until it is asked.'
      );
      expect(diagnostics[0]?.requiredField).toBe("name");
      // A Required-when field blocks while its rule holds, and the wording says so.
      expect(diagnostics[1]?.message).toBe(
        'phone is required by the form when its rule holds and on no page of journey "apply", so no submission through the journey can pass while that rule holds, until it is asked.'
      );
      // The summary counts the optional ones alone.
      expect(diagnostics[3]?.message).toContain('1 form field is not asked in journey "apply": "notes". The server still holds its answer');
    });

    it("component.unassigned: a null Required-when rule is no rule, as the fold reads it", () => {
      const wider = group("form", "form", [field("eligible", "radio"), { ...field("opt"), rules: { requiredWhen: null } } as unknown as ComponentNode]);
      const diagnostics = diagnoseJourney(wider, journeyOf(start));
      expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.required])).toEqual([
        ["component.unassigned", "warning", false],
        ["presentation.fields-left-out", "warning", undefined]
      ]);
    });

    it("component.unassigned: a required field answered by a non-empty literal default is a warning, the rule met without asking; an empty or worked-out default lifts nothing", () => {
      const wider = group("form", "form", [
        field("eligible", "radio"),
        field("channel", "text", { configuration: { label: "channel", required: true }, rules: { defaultValue: { kind: "literal", value: "web" } } }),
        field("zero", "number", { configuration: { label: "zero", required: true }, rules: { defaultValue: { kind: "literal", value: 0 } } }),
        field("picks", "checkboxes", { configuration: { label: "picks", required: true }, rules: { defaultValue: { kind: "literal", value: { a: true } } as unknown as Expression } }),
        field("stamp", "text", { configuration: { label: "stamp", required: true }, rules: { defaultValue: { kind: "path", path: "host.today" } } }),
        field("blank", "text", { configuration: { label: "blank", required: true }, rules: { defaultValue: { kind: "literal", value: "" } } }),
        field("spaces", "text", { configuration: { label: "spaces", required: true }, rules: { defaultValue: { kind: "literal", value: "  " } } }),
        field("agree", "checkbox", { configuration: { label: "agree", required: true }, rules: { defaultValue: { kind: "literal", value: false } } }),
        field("none", "checkboxes", { configuration: { label: "none", required: true }, rules: { defaultValue: { kind: "literal", value: { a: false } } as unknown as Expression } })
      ]);
      const diagnostics = diagnoseJourney(wider, journeyOf(start));
      // A literal the fold reads as an answer (`isEmptyValue`: a 0, a ticked box) is submitted
      // unchanged and meets the rule. An empty one — blank or white space, `false` on a checkbox,
      // no box ticked — answers nothing, and every side refuses `required`. A default worked out
      // from other answers (`host.today` with no host, an unanswered field) may seed nothing, so it
      // is the error too, worded for what it needs.
      expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.componentId, diagnostic.required])).toEqual([
        ["component.unassigned", "warning", "channel", false],
        ["component.unassigned", "warning", "zero", false],
        ["component.unassigned", "warning", "picks", false],
        ["component.unassigned", "error", "stamp", true],
        ["component.unassigned", "error", "blank", true],
        ["component.unassigned", "error", "spaces", true],
        ["component.unassigned", "error", "agree", true],
        ["component.unassigned", "error", "none", true],
        ["presentation.fields-left-out", "warning", undefined, undefined]
      ]);
      expect(diagnostics[0]?.message).toBe(
        'channel is required by the form and on no page of journey "apply": its default answer is submitted unchanged, so the form\'s rule is met without asking.'
      );
      expect(diagnostics[3]?.message).toBe(
        'stamp is required by the form and on no page of journey "apply", so its default, worked out from other answers, must come to one, or no submission through the journey can pass until it is asked.'
      );
      expect(diagnostics[3]?.requiredField).toBe("stamp");
      expect(diagnostics[6]?.message).toBe('agree is required by the form and on no page of journey "apply", so no submission through the journey can pass until it is asked.');
      // Counted with the fields left out: the server still holds the default to the form's rules.
      expect(diagnostics[8]?.message).toContain('3 form fields are not asked in journey "apply": "channel", "zero" and "picks".');
    });

    it("reads an empty default as the fold reads an empty answer: journeyEmptyAnswer agrees with isEmptyValue and kernelIsEmptyValue", () => {
      const table: Array<[unknown, string]> = [
        [undefined, "text"],
        [null, "text"],
        ["", "text"],
        ["  ", "text"],
        ["x", "text"],
        [0, "number"],
        [Number.NaN, "number"],
        [[], "select"],
        [["a"], "select"],
        [false, "checkbox"],
        [true, "checkbox"],
        [false, "text"],
        [{ a: false }, "checkboxes"],
        [{ a: true }, "checkboxes"],
        [{}, "text"]
      ];
      for (const [value, type] of table) {
        expect(journeyEmptyAnswer(value, type), `${JSON.stringify(value)} as ${type}`).toBe(isEmptyValue(value, type));
        expect(journeyEmptyAnswer(value, type), `${JSON.stringify(value)} as ${type} (kernel)`).toBe(kernelIsEmptyValue(value, type));
      }
    });

    it("component.unassigned: a container reported whole is required when something shown in it is; a repeating section only for itself", () => {
      const scoped = group("address", "container", [field("street", "text", { configuration: { label: "street", required: true } }), field("city")], {
        configuration: { label: "address", scopeData: true }
      });
      const hiddenOnly = group("aside", "container", [field("code", "text", { configuration: { label: "code", required: true, hidden: true } })], {
        configuration: { label: "aside", scopeData: true }
      });
      const items = group("items", "repeatingSection", [field("sku", "text", { configuration: { label: "sku", required: true } })], { collection: {} });
      const wider = group("form", "form", [field("eligible", "radio"), scoped, hiddenOnly, items]);
      const unassigned = diagnoseJourney(wider, journeyOf(start)).filter((diagnostic) => diagnostic.code === "component.unassigned");
      expect(unassigned.map((diagnostic) => [diagnostic.componentId, diagnostic.required, diagnostic.requiredField])).toEqual([
        ["address", true, "street"],
        ["aside", false, undefined],
        ["items", false, undefined]
      ]);
      // The container's error names the field whose Required it is: what "Make it optional on the form" opens.
      expect(unassigned[0]?.message).toBe(
        'address is required by the form (street in it is) and on no page of journey "apply", so no submission through the journey can pass until it is asked.'
      );
    });

    it("component.unassigned: a required field whose visibility reads host. is a warning, not an error, and rule.reads-host says neither side holds it on no page", () => {
      const staff = eq("host.role", "staff");
      const wider = group("form", "form", [
        field("eligible", "radio"),
        field("staff_ref", "text", { configuration: { label: "staff_ref", required: true }, rules: { visibleWhen: staff } }),
        field("tucked", "text", { configuration: { label: "tucked", required: true, hidden: true }, rules: { visibleWhen: staff } }),
        group("box", "fieldset", [field("nested_ref", "text", { configuration: { label: "nested_ref", required: true } })], { rules: { visibleWhen: staff } }),
        field("plain_note", "text", { rules: { visibleWhen: staff } }),
        field("name", "text", { configuration: { label: "name", required: true }, rules: { visibleWhen: staff } })
      ]);
      const diagnostics = diagnoseJourney(wider, journeyOf(start, about));
      // On no page, a field whose visibility reads host. keeps the lenient fold on both sides
      // (the server cannot replay the host): neither side holds it to its Required, so the
      // finding is a warning that says the requirement is not enforced here — never a blocking
      // error, and never counted as a required field left out.
      const unassigned = diagnostics.filter((diagnostic) => diagnostic.code === "component.unassigned");
      expect(unassigned.map((diagnostic) => [diagnostic.componentId, diagnostic.severity, diagnostic.required, diagnostic.hostBound])).toEqual([
        ["staff_ref", "warning", false, true],
        ["tucked", "warning", false, true],
        ["nested_ref", "warning", false, true],
        ["plain_note", "warning", false, true]
      ]);
      expect(unassigned[0]?.message).toBe(
        'staff_ref is required by the form and on no page of journey "apply", and its visibility reads host., which the server cannot replay: neither side holds it to its rules there, so the form\'s requirement is not enforced through this journey.'
      );
      expect(unassigned[0]?.requiredField).toBeUndefined();
      // Through an ancestor's rule, the ancestor is named.
      expect(unassigned[2]?.message).toBe(
        'nested_ref is required by the form and on no page of journey "apply", and its visibility (through box) reads host., which the server cannot replay: neither side holds it to its rules there, so the form\'s requirement is not enforced through this journey.'
      );
      expect(unassigned[3]?.message).toBe(
        'plain_note is on no page of journey "apply", and its visibility reads host., which the server cannot replay: neither side holds it to its rules there.'
      );
      // Not in the summary of optional fields left out: the server does not hold these.
      expect(diagnostics.some((diagnostic) => diagnostic.code === "presentation.fields-left-out")).toBe(false);
      const hostRules = diagnostics.filter((diagnostic) => diagnostic.code === "rule.reads-host");
      expect(hostRules.map((diagnostic) => diagnostic.componentId)).toEqual(["staff_ref", "tucked", "box", "plain_note", "name"]);
      expect(hostRules[0]?.message).toBe(
        'The visibility rule of staff_ref reads host.role, which a server checking the submission does not have, and staff_ref is on no page of journey "apply": neither side holds it to its rules there — not required, not checked.'
      );
      expect(hostRules[2]?.message).toContain('box is on no page of journey "apply": neither side holds it to its rules there');
      // A field on a page keeps the whole form's words: the browser follows the host, the server treats it as shown.
      expect(hostRules[4]?.message).toBe(
        "The visibility rule of name reads host.role, which a server checking the submission does not have, so the server treats name as shown."
      );
    });

    it("component.unassigned: a required field on no page beside a listed one inside a host-shown fieldset is the same warning, and the fieldset's rule.reads-host names it", () => {
      const staff = eq("host.role", "staff");
      const wider = group("form", "form", [
        field("eligible", "radio"),
        group("hbox", "fieldset", [field("listed"), field("sibling", "text", { configuration: { label: "sibling", required: true } }), field("other")], { rules: { visibleWhen: staff } })
      ]);
      const diagnostics = diagnoseJourney(wider, journeyOf({ ...start, components: ["eligible", "listed"] }));
      expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.componentId, diagnostic.required, diagnostic.hostBound])).toEqual([
        ["component.unassigned", "warning", "sibling", false, true],
        ["component.unassigned", "warning", "other", false, true],
        ["rule.reads-host", "warning", "hbox", undefined, undefined]
      ]);
      expect(diagnostics[0]?.message).toBe(
        'sibling is required by the form and on no page of journey "apply", and its visibility (through hbox) reads host., which the server cannot replay: neither side holds it to its rules there, so the form\'s requirement is not enforced through this journey.'
      );
      // The box holds a listed field, so it keeps the whole form's difference — and names the fields on no page under it.
      expect(diagnostics[2]?.message).toBe(
        'The visibility rule of hbox reads host.role, which a server checking the submission does not have, so the server treats hbox as shown; "sibling" and "other" in it are on no page of journey "apply", so neither side holds them to their rules there.'
      );
    });

    it("component.unassigned: a hidden field that opts in to being required and validated is the error it is, itself or inside a hidden container; one that opts in to required alone, or not at all, is off screen", () => {
      const optIn = { hidden: true, required: true, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" };
      const wider = group("form", "form", [
        field("eligible", "radio"),
        field("case_no", "text", { configuration: { label: "case_no", ...optIn } }),
        field("secret", "text", { configuration: { label: "secret", required: true, hidden: true } }),
        // Required while hidden, but not validated while hidden: the fold holds such a field only
        // to the shape of its answer (the kernel's `shapeOnly`, the browser's hidden policy), so
        // `required` is never raised for it — no side refuses, and nothing is reported.
        field("half", "text", { configuration: { label: "half", required: true, hidden: true, hiddenRequiredBehavior: "required" } }),
        group("aside", "container", [field("code", "text", { configuration: { label: "code", ...optIn } })], { configuration: { label: "aside", scopeData: true } }),
        group("half_box", "container", [field("half_code", "text", { configuration: { label: "half_code", required: true, hidden: true, hiddenRequiredBehavior: "required" } })], {
          configuration: { label: "half_box", scopeData: true }
        }),
        group("wrap", "fieldset", [field("inner", "text", { configuration: { label: "inner", ...optIn } })], { configuration: { label: "wrap", hidden: true } }),
        group("half_wrap", "fieldset", [field("half_inner", "text", { configuration: { label: "half_inner", required: true, hiddenRequiredBehavior: "required" } })], {
          configuration: { label: "half_wrap", hidden: true }
        }),
        field("seeded", "text", { configuration: { label: "seeded", ...optIn }, rules: { defaultValue: { kind: "literal", value: "S-1" } } })
      ]);
      const diagnostics = diagnoseJourney(wider, journeyOf(start));
      // The fold holds an opt-in to its Required off screen, on the whole form and through the
      // journey alike, so leaving it out blocks every submission; the container is reported
      // whole with the field whose Required it is, and a hidden group's field for itself. One
      // answered by its default is met without asking and, off screen, reported as no field is;
      // a hidden field that does not opt in to both is off screen on both sides. `half_box`, a
      // data container holding only such a field, is on no page like any other.
      expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.componentId, diagnostic.required, diagnostic.requiredField])).toEqual([
        ["component.unassigned", "error", "case_no", true, "case_no"],
        ["component.unassigned", "error", "aside", true, "code"],
        ["component.unassigned", "warning", "half_box", false, undefined],
        ["component.unassigned", "error", "inner", true, "inner"],
        ["presentation.fields-left-out", "warning", undefined, undefined, undefined]
      ]);
      // No page can show a hidden field, so asking it would change nothing: the message says what does.
      expect(diagnostics[0]?.message).toBe(
        'case_no is required by the form while hidden and on no page of journey "apply", so no submission through the journey can pass unless the host or a default fills it — hidden on the form, no page can ask it.'
      );
      expect(diagnostics[1]?.message).toBe(
        'aside is required by the form (code in it is) while hidden and on no page of journey "apply", so no submission through the journey can pass unless the host or a default fills it — hidden on the form, no page can ask it.'
      );
      // Each says no page can ask the field (`hidden`), so the tray offers no "Ask it here" for it.
      expect(diagnostics.filter((diagnostic) => diagnostic.required).map((diagnostic) => diagnostic.hidden)).toEqual([true, true, true]);
    });

    it("component.unassigned: a data-scoping container whose only required field is host-bound is a warning naming it, and a plain required field beside one is the field the error names", () => {
      const staff = eq("host.role", "staff");
      const wider = group("form", "form", [
        field("eligible", "radio"),
        group("dscope", "container", [field("dsHost", "text", { configuration: { label: "dsHost", required: true }, rules: { visibleWhen: staff } }), field("dsPlain")], {
          configuration: { label: "dscope", scopeData: true }
        }),
        group(
          "dscope2",
          "container",
          [field("dsHost2", "text", { configuration: { label: "dsHost2", required: true }, rules: { visibleWhen: staff } }), field("dsReq2", "text", { configuration: { label: "dsReq2", required: true } })],
          { configuration: { label: "dscope2", scopeData: true } }
        ),
        group(
          "dscope3",
          "container",
          [group("sub", "fieldset", [field("deep", "text", { configuration: { label: "deep", required: true } })], { rules: { visibleWhen: staff } }), field("ruled", "text", { rules: { requiredWhen: staff } })],
          { configuration: { label: "dscope3", scopeData: true } }
        )
      ]);
      const diagnostics = diagnoseJourney(wider, journeyOf(start));
      const unassigned = diagnostics.filter((diagnostic) => diagnostic.code === "component.unassigned");
      // The fold keeps the lenient reading for `dsHost` through its own rule (the walk up from
      // the field), so every side accepts the container empty: a warning, never a blocking
      // error — and it is `dsReq2`, not `dsHost2`, that blocks `dscope2` and that "Make it
      // optional" must open. Through a host-shown fieldset in the container, or a Required-when
      // rule reading host., the same.
      expect(unassigned.map((diagnostic) => [diagnostic.componentId, diagnostic.severity, diagnostic.required, diagnostic.requiredField, diagnostic.hostBound])).toEqual([
        ["dscope", "warning", false, undefined, true],
        ["dscope2", "error", true, "dsReq2", undefined],
        ["dscope3", "warning", false, undefined, true]
      ]);
      expect(unassigned[0]?.message).toBe(
        'dscope is on no page of journey "apply", and dsHost in it is required by the form, but its visibility reads host., which the server cannot replay: neither side holds it to its rules there, so the form\'s requirement is not enforced through this journey.'
      );
      expect(unassigned[1]?.message).toBe(
        'dscope2 is required by the form (dsReq2 in it is) and on no page of journey "apply", so no submission through the journey can pass until it is asked.'
      );
      expect(unassigned[2]?.message).toBe(
        'dscope3 is on no page of journey "apply", and deep in it is required by the form, but its visibility (through sub) reads host., which the server cannot replay: neither side holds it to its rules there, so the form\'s requirement is not enforced through this journey.'
      );
      // Not counted among the fields the server still holds: the summary would claim what it cannot.
      expect(diagnostics.some((diagnostic) => diagnostic.code === "presentation.fields-left-out")).toBe(false);
    });

    it("component.unassigned: a field on no page whose Required-when rule reads host. is a warning, since neither side reads such a rule there, and rule.reads-host says so", () => {
      const staff = eq("host.role", "staff");
      const wider = group("form", "form", [
        field("eligible", "radio"),
        field("r", "text", { rules: { requiredWhen: staff } }),
        // The tick stands whatever the rule says: Required OR Required when.
        field("ticked", "text", { configuration: { label: "ticked", required: true }, rules: { requiredWhen: staff } }),
        field("named", "text", { rules: { requiredWhen: staff } })
      ]);
      const diagnostics = diagnoseJourney(wider, journeyOf(start, { ...about, components: ["named"] }));
      expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.componentId, diagnostic.required, diagnostic.hostBound])).toEqual([
        ["component.unassigned", "warning", "r", false, true],
        ["component.unassigned", "error", "ticked", true, undefined],
        ["rule.reads-host", "warning", "r", undefined, undefined],
        ["rule.reads-host", "warning", "ticked", undefined, undefined],
        ["rule.reads-host", "warning", "named", undefined, undefined]
      ]);
      expect(diagnostics[0]?.message).toBe(
        'r is required by the form when its rule holds and on no page of journey "apply", and that rule reads host., which the server cannot replay: neither side holds it to the rule there, so the form\'s requirement is not enforced through this journey.'
      );
      expect(diagnostics[2]?.message).toBe(
        'The required rule of r reads host.role, which a server checking the submission does not have, and r is on no page of journey "apply": neither side holds it to that rule there.'
      );
      // On a page the lenient direction applies: the browser follows the host, the server does not.
      expect(diagnostics[4]?.message).toBe("The required rule of named reads host.role, which a server checking the submission does not have, so the server does not hold named to it.");
    });

    it("component.unassigned: a hidden field with a rule that may show it is judged like a shown one", () => {
      const wider = group("form", "form", [
        field("eligible", "radio"),
        field("reveal", "text", { configuration: { label: "reveal", required: true, hidden: true }, rules: { visibleWhen: eq("eligible", "yes") } }),
        field("optional", "text", { configuration: { label: "optional", hidden: true }, rules: { visibleWhen: eq("eligible", "yes") } })
      ]);
      const diagnostics = diagnoseJourney(wider, journeyOf(start));
      expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.componentId, diagnostic.required])).toEqual([
        ["component.unassigned", "error", "reveal", true],
        ["component.unassigned", "warning", "optional", false],
        ["presentation.fields-left-out", "warning", undefined, undefined]
      ]);
    });

    describe("calc.input-left-out: a required calculation worked out from an input the journey never asks", () => {
      const required = { label: "total", required: true };
      const costForm = (cost: Partial<ComponentNode> = {}, total: Partial<ComponentNode> = {}): ComponentNode =>
        group("form", "form", [
          field("eligible", "radio"),
          field("cost", "number", cost),
          field("total", "number", { configuration: required, rules: { value: times2("cost") }, ...total })
        ]);
      const calc = (diagnostics: JourneyDiagnostic[]): JourneyDiagnostic[] => diagnostics.filter((diagnostic) => diagnostic.code === "calc.input-left-out");

      it("is an error on the input, naming the calculation, whether the calculated field is on a page or on none; asking the input clears it", async () => {
        const form = costForm();
        const leftOut = journeyOf(start);
        const diagnostics = diagnoseJourney(form, leftOut);
        // The calculated field itself is never reported as left out; its input is, and now blocks.
        expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.componentId, diagnostic.required, diagnostic.requiredField])).toEqual([
          ["component.unassigned", "warning", "cost", false, undefined],
          ["presentation.fields-left-out", "warning", undefined, undefined, undefined],
          ["calc.input-left-out", "error", "cost", true, "total"]
        ]);
        expect(diagnostics[2]?.message).toBe(
          'total is required by the form and worked out from cost, which journey "apply" never asks: it comes out empty, so no submission through the journey can pass until cost is asked.'
        );
        // Every side refuses it, as the fold reads a field on no page: what the error says.
        expect(await refused(form, leftOut, { eligible: "yes" })).toEqual(["total:required"]);

        // With the calculated field on the page, the same: its input is still never asked.
        const shown = journeyOf({ ...start, components: ["eligible", "total"] });
        expect(calc(diagnoseJourney(form, shown)).map((diagnostic) => [diagnostic.severity, diagnostic.componentId, diagnostic.requiredField])).toEqual([["error", "cost", "total"]]);
        expect(await refused(form, shown, { eligible: "yes" })).toEqual(["total:required"]);

        // Asking the input clears it, and a submission with it answered passes.
        const asked = journeyOf({ ...start, components: ["eligible", "cost"] });
        expect(diagnoseJourney(form, asked)).toEqual([]);
        expect(await refused(form, asked, { eligible: "yes", cost: 5 })).toEqual([]);
      });

      it("is a warning, in the words a default gets, when the input's non-empty literal default answers it", async () => {
        const form = costForm({ rules: { defaultValue: { kind: "literal", value: 3 } } });
        const found = calc(diagnoseJourney(form, journeyOf(start)));
        expect(found.map((diagnostic) => [diagnostic.severity, diagnostic.componentId, diagnostic.required, diagnostic.requiredField])).toEqual([["warning", "cost", false, undefined]]);
        expect(found[0]?.message).toBe(
          'total is required by the form and worked out from cost, which journey "apply" never asks: its default answer is submitted unchanged, so the form\'s rule is met without asking.'
        );
        // An empty default answers nothing: the error stands.
        const blank = costForm({ rules: { defaultValue: { kind: "literal", value: null } } });
        expect(calc(diagnoseJourney(blank, journeyOf(start))).map((diagnostic) => diagnostic.severity)).toEqual(["error"]);
      });

      it("stays the error when only the host decides whether the input is shown: on no page nobody can answer it, and every side refuses", async () => {
        const staff = eq("host.role", "staff");
        const form = costForm({ rules: { visibleWhen: staff } });
        const journey = journeyOf(start);
        const diagnostics = diagnoseJourney(form, journey);
        // The input's own finding is the host-bound warning (neither side holds *it* to its
        // rules); the calculation is held to its Required all the same, staff or not.
        expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.componentId, diagnostic.required, diagnostic.hostBound])).toEqual([
          ["component.unassigned", "warning", "cost", false, true],
          ["calc.input-left-out", "error", "cost", true, undefined],
          ["rule.reads-host", "warning", "cost", undefined, undefined]
        ]);
        for (const role of [undefined, "public", "staff"]) {
          expect(await refused(form, journey, { eligible: "yes" }, role)).toEqual(["total:required"]);
        }
      });

      it("says nothing when every input is asked, when the calculation comes to a value without the input, or when the form does not hold the calculated field to its Required here", async () => {
        const journey = journeyOf(start);
        // Every input on a page.
        expect(calc(diagnoseJourney(costForm(), journeyOf({ ...start, components: ["eligible", "cost", "total"] })))).toEqual([]);
        // A sum leaves out what is unanswered and a coalesce falls back: neither comes out empty.
        // (A sum over an answered text, `sum(cost, eligible)` with eligible "yes", is no answer since
        // arithmetic follows DMN FEEL; the fixture sums a number.)
        const summed = costForm({}, { rules: { value: call("sum", path("cost"), { kind: "literal", value: 1 }) } });
        expect(calc(diagnoseJourney(summed, journey))).toEqual([]);
        expect(await refused(summed, journey, { eligible: "yes" })).toEqual([]);
        const fallback = costForm({}, { rules: { value: call("coalesce", path("cost"), { kind: "literal", value: 0 }) } });
        expect(calc(diagnoseJourney(fallback, journey))).toEqual([]);
        expect(await refused(fallback, journey, { eligible: "yes" })).toEqual([]);
        // Not required; hidden for good without opting in; on no page with a visibility only the host decides.
        expect(calc(diagnoseJourney(costForm({}, { configuration: { label: "total" } }), journey))).toEqual([]);
        const hidden = costForm({}, { configuration: { ...required, hidden: true } });
        expect(calc(diagnoseJourney(hidden, journey))).toEqual([]);
        expect(await refused(hidden, journey, { eligible: "yes" })).toEqual([]);
        const hostShown = costForm({}, { rules: { value: times2("cost"), visibleWhen: eq("host.role", "staff") } });
        expect(calc(diagnoseJourney(hostShown, journey))).toEqual([]);
        expect(await refused(hostShown, journey, { eligible: "yes" })).toEqual([]);
        // …but on a page that visibility is the host's and the server's to differ on, and the input is still missing.
        expect(calc(diagnoseJourney(hostShown, journeyOf({ ...start, components: ["eligible", "total"] }))).map((diagnostic) => diagnostic.severity)).toEqual(["error"]);
        // An input hidden on the form for good is never asked on the whole form either: not this journey's doing.
        expect(calc(diagnoseJourney(costForm({ configuration: { label: "cost", hidden: true } }), journey))).toEqual([]);
      });

      it("follows a calculation it reads, names the container an input is left out with, and words a Required-when rule", async () => {
        const journey = journeyOf(start);
        // total <- mid <- cost: the input two calculations away is the one to ask.
        const chained = group("form", "form", [
          field("eligible", "radio"),
          field("cost", "number"),
          field("mid", "number", { rules: { value: times2("cost") } }),
          field("total", "number", { configuration: required, rules: { value: call("round", path("mid")) } })
        ]);
        expect(calc(diagnoseJourney(chained, journey)).map((diagnostic) => [diagnostic.componentId, diagnostic.requiredField])).toEqual([["cost", "total"]]);
        expect(await refused(chained, journey, { eligible: "yes" })).toEqual(["total:required"]);

        // The input sits in a data-scoping container left out whole: the container is what a page can ask.
        const scoped = group("form", "form", [
          field("eligible", "radio"),
          group("order", "container", [field("cost", "number"), field("note")], { configuration: { label: "order", scopeData: true } }),
          field("total", "number", { configuration: { label: "total" }, rules: { value: times2("cost"), requiredWhen: eq("eligible", "yes") } })
        ]);
        const found = calc(diagnoseJourney(scoped, journey));
        expect(found.map((diagnostic) => [diagnostic.severity, diagnostic.componentId, diagnostic.requiredField])).toEqual([["error", "order", "total"]]);
        expect(found[0]?.message).toBe(
          'total is required by the form when its rule holds and worked out from cost (in order), which journey "apply" never asks: it comes out empty, so no submission through the journey can pass while that rule holds, until order is asked.'
        );

        // Two inputs on no page: one finding each, both naming the one calculated field. A concat
        // comes out empty only when every part does.
        const two = group("form", "form", [
          field("eligible", "radio"),
          field("first"),
          field("last"),
          field("full", "text", { configuration: { label: "full", required: true }, rules: { value: call("concat", path("first"), path("last")) } })
        ]);
        expect(calc(diagnoseJourney(two, journey)).map((diagnostic) => [diagnostic.componentId, diagnostic.requiredField])).toEqual([
          ["first", "full"],
          ["last", "full"]
        ]);
        expect(calc(diagnoseJourney(two, journeyOf({ ...start, components: ["eligible", "first"] })))).toEqual([]);

        // A calculated checkbox is unticked — no answer — when its condition is false, so any
        // input the condition reads may leave it so; on any other field a condition always comes
        // to a value, true or false.
        const both: Expression = { kind: "logical", operator: "and", left: path("eligible"), right: path("second") };
        const ticked = (type: string): ComponentNode =>
          group("form", "form", [field("eligible", "radio"), field("second", "checkbox"), field("ok", type, { configuration: { label: "ok", required: true }, rules: { value: both } })]);
        expect(calc(diagnoseJourney(ticked("checkbox"), journey)).map((diagnostic) => [diagnostic.componentId, diagnostic.requiredField])).toEqual([["second", "ok"]]);
        expect(await refused(ticked("checkbox"), journey, { eligible: "yes" })).toEqual(["ok:required"]);
        expect(calc(diagnoseJourney(ticked("text"), journey))).toEqual([]);
        // A text field's answer is a string, and this calculation comes to a boolean: the
        // kernel refuses it as `text`.
        expect(await refused(ticked("text"), journey, { eligible: "yes" })).toEqual(["ok:text"]);
      });

      it("passes over a calculated field inside a container left out whole: its inputs decide, not the container", async () => {
        const form = group("form", "form", [
          field("eligible", "radio"),
          field("cost", "number"),
          group("sums", "container", [field("total", "number", { configuration: required, rules: { value: times2("cost") } })], { configuration: { label: "sums", scopeData: true } })
        ]);
        // Asked its input, the container left out blocks nothing: the calculation is worked out on no page too.
        const asked = journeyOf({ ...start, components: ["eligible", "cost"] });
        expect(diagnoseJourney(form, asked).map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.componentId, diagnostic.required])).toEqual([
          ["component.unassigned", "warning", "sums", false],
          ["presentation.fields-left-out", "warning", undefined, undefined]
        ]);
        expect(await refused(form, asked, { eligible: "yes", cost: 2 })).toEqual([]);
      });
    });

    describe("a required field hidden on the form for good, which no page can ask", () => {
      const optIn = { hidden: true, required: true, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" };
      const token = field("token", "text", { configuration: { label: "token", ...optIn } });
      const container = (...children: ComponentNode[]): ComponentNode => group("dc", "container", children, { configuration: { label: "dc", scopeData: true } });
      const shape = (diagnostics: JourneyDiagnostic[]): unknown[] =>
        diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .map((diagnostic) => [diagnostic.code, diagnostic.componentId, diagnostic.requiredField, diagnostic.hidden]);

      it("marks a shown container whose only blocking field is one, left out, and keeps the error standing once the container is on a page", async () => {
        const form = group("form", "form", [field("eligible", "radio"), container(token, field("other"))]);
        const leftOut = journeyOf(start);
        // Left out: the container is reported whole, and the finding says no page can ask the field.
        expect(shape(diagnoseJourney(form, leftOut))).toEqual([["component.unassigned", "dc", "token", true]]);
        expect(await refused(form, leftOut, { eligible: "yes" })).toEqual(["token:required"]);
        // On a page the container shows `other`, never `token`: every side still refuses, and the error says so.
        const placed = journeyOf({ ...start, components: ["eligible", "dc"] });
        const diagnostics = diagnoseJourney(form, placed);
        expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.componentId, diagnostic.required, diagnostic.requiredField, diagnostic.hidden])).toEqual([
          ["component.hidden-required", "error", "token", true, "token", true]
        ]);
        expect(diagnostics[0]?.message).toBe(
          'token is required by the form while hidden, and no page of journey "apply" can ask it — it is hidden on the form — so no submission through the journey can pass unless the host or a default fills it.'
        );
        expect(diagnostics[0]?.pageId).toBeUndefined();
        expect(await refused(form, placed, { eligible: "yes" })).toEqual(["token:required"]);
        // Listed by itself, the same.
        const form2 = group("form", "form", [field("eligible", "radio"), token]);
        expect(shape(diagnoseJourney(form2, journeyOf({ ...start, components: ["eligible", "token"] })))).toEqual([["component.hidden-required", "token", "token", true]]);
      });

      it("names the field a page can ask when the container holds one too, and says the hidden one on its own", async () => {
        const form = group("form", "form", [field("eligible", "radio"), container(token, field("name", "text", { configuration: { label: "name", required: true } }))]);
        // Asking the container helps with `name`, so that is the field the error names; `token` is its own error.
        expect(shape(diagnoseJourney(form, journeyOf(start)))).toEqual([
          ["component.unassigned", "dc", "name", undefined],
          ["component.hidden-required", "token", "token", true]
        ]);
        expect(shape(diagnoseJourney(form, journeyOf({ ...start, components: ["eligible", "dc"] })))).toEqual([["component.hidden-required", "token", "token", true]]);
      });

      it("says nothing on a page of one answered by its default, one that does not opt in to both, or one a rule may show", async () => {
        const seeded = field("seeded", "text", { configuration: { label: "seeded", ...optIn }, rules: { defaultValue: { kind: "literal", value: "S-1" } } });
        const half = field("half", "text", { configuration: { label: "half", hidden: true, required: true, hiddenRequiredBehavior: "required" } });
        const reveal = field("reveal", "text", { configuration: { label: "reveal", ...optIn }, rules: { visibleWhen: eq("eligible", "yes") } });
        const form = group("form", "form", [field("eligible", "radio"), container(seeded, half, reveal)]);
        expect(diagnoseJourney(form, journeyOf({ ...start, components: ["eligible", "dc"] }))).toEqual([]);
      });
    });

    it("presentation.fields-left-out: names five, then counts the rest; nothing when every field is asked", () => {
      const many = group("form", "form", [field("eligible", "radio"), ...["a", "b", "c", "d", "e", "f", "g"].map((id) => field(id))]);
      const summary = only(diagnoseJourney(many, journeyOf(start)), "presentation.fields-left-out");
      expect(summary.message).toContain('7 form fields are not asked in journey "apply": "a", "b", "c", "d", "e" and 2 more.');
      expect(codes(diagnoseJourney(tree, journeyOf(start, about, money)))).not.toContain("presentation.fields-left-out");
    });

    it("component.unassigned: not for the unlisted container of a listed field", () => {
      const wider = group("form", "form", [field("eligible", "radio"), group("address", "container", [field("street")])]);
      expect(diagnoseJourney(wider, journeyOf(start, { id: "where", title: "Where", components: ["street"] }))).toEqual([]);
    });

    it("component.multiple-pages: once for the component, not again for what it holds", () => {
      const diagnostics = diagnoseJourney(
        tree,
        journeyOf(start, { ...about, components: ["name", "email", "extra"] }, { ...money, components: ["extra", "name"] })
      );
      expect(codes(diagnostics)).toEqual(["component.multiple-pages", "component.multiple-pages"]);
      expect(diagnostics.map((diagnostic) => diagnostic.componentId)).toEqual(["name", "extra"]);
      expect(diagnostics[0]?.message).toContain('name is on pages "about" and "money"');
    });

    it("page.unreachable: a route jumps every path past the page", () => {
      const diagnostics = diagnoseJourney(tree, journeyOf({ ...start, routes: [{ to: "money" }] }, about, money));
      expect(codes(diagnostics)).toEqual(["page.unreachable"]);
      expect(diagnostics[0]).toMatchObject({ severity: "warning", pageId: "about" });
    });

    it("page.unreachable: not when a route can go around the page that jumps", () => {
      const hop: JourneyPage = { id: "hop", title: "Hop", components: ["email"], routes: [{ to: "money" }] };
      const journey = journeyOf({ ...start, routes: [{ when: eq("eligible", "no"), to: "about" }] }, hop, { ...about, components: ["name"] }, money);
      expect(codes(diagnoseJourney(tree, journey))).not.toContain("page.unreachable");
    });

    it("a questions page with nothing of the form on it: no finding, a path shows it", () => {
      const diagnostics = diagnoseJourney(
        tree,
        journeyOf(start, about, { ...money, routes: [{ when: eq("eligible", "yes"), to: "$end" }] }, { id: "blank", title: "Blank" }, { id: "stop", kind: "exit", title: "Stop" })
      );
      expect(codes(diagnostics)).toEqual([]);
    });

    it("page.no-title: no title, and nothing to borrow one from", () => {
      const unlabelled = group("form", "form", [field("eligible", "radio"), { id: "plain", type: "text", configuration: {} }, field("name"), field("email"), group("extra", "fieldset", [field("income")])]);
      const diagnostics = diagnoseJourney(
        unlabelled,
        journeyOf(
          { id: "start", components: ["eligible"] },
          { id: "quiet", components: ["plain"] },
          about,
          { ...money, routes: [{ when: eq("eligible", "yes"), to: "$end" }] },
          { id: "stop", kind: "exit" }
        )
      );
      expect(codes(diagnostics)).toEqual(["page.no-title", "page.no-title"]);
      expect(diagnostics.map((diagnostic) => diagnostic.pageId)).toEqual(["quiet", "stop"]);
    });

    it("page.no-title: not reported when the journey hides its page headings", () => {
      const unlabelled = group("form", "form", [field("eligible", "radio"), { id: "plain", type: "text", configuration: {} }, field("name"), field("email"), group("extra", "fieldset", [field("income")])]);
      const diagnostics = diagnoseJourney(unlabelled, {
        ...journeyOf({ id: "start", components: ["eligible"] }, { id: "quiet", components: ["plain"] }, about, { ...money, routes: [{ when: eq("eligible", "yes"), to: "$end" }] }, { id: "stop", kind: "exit" }),
        heading: "hidden"
      });
      expect(codes(diagnostics)).not.toContain("page.no-title");
    });

    it("route.shadowed: a route after one that always matches", () => {
      const diagnostics = diagnoseJourney(
        tree,
        journeyOf({ ...start, routes: [{ to: "start" }, { when: eq("eligible", "no"), to: "about" }, { to: "money" }, { to: "$end" }] }, about, money)
      );
      expect(codes(diagnostics)).toEqual(["route.backward", "route.shadowed"]);
      expect(only(diagnostics, "route.shadowed")).toMatchObject({ severity: "warning", pageId: "start", pageIndex: 0, routeIndex: 3 });
    });

    it("condition.unknown-field", () => {
      const diagnostics = diagnoseJourney(tree, journeyOf({ ...start, routes: [{ when: eq("nobody", "x"), to: "money" }] }, about, money));
      expect(codes(diagnostics)).toEqual(["condition.unknown-field"]);
      expect(diagnostics[0]).toMatchObject({ severity: "warning", pageId: "start", routeIndex: 0 });
    });

    it("condition.unknown-field: not for an entry key under a component", () => {
      const withItems = group("form", "form", [
        field("eligible", "radio"),
        group("items", "repeatingSection", [field("sku")], { collection: {} })
      ]);
      const journey = journeyOf({ ...start, routes: [{ when: eq("eligible", "no"), to: "$end" }] }, { id: "list", title: "Items", components: ["items"], routes: [{ when: eq("items[0].sku", "A"), to: "$end" }] });
      expect(diagnoseJourney(withItems, journey)).toEqual([]);
    });

    it("condition.reads-later-page: a route may read its own page, not a later one", () => {
      const diagnostics = diagnoseJourney(
        tree,
        journeyOf({ ...start, routes: [{ when: eq("eligible", "no"), to: "money" }, { when: eq("name", "x"), to: "money" }] }, about, money)
      );
      expect(codes(diagnostics)).toEqual(["condition.reads-later-page"]);
      expect(diagnostics[0]).toMatchObject({ pageId: "start", routeIndex: 1, componentId: "name" });
    });

    it("condition.reads-later-page: followed through calculations", () => {
      const calculated = group("form", "form", [
        field("eligible", "radio"),
        field("name"),
        field("email"),
        group("extra", "fieldset", [field("income", "number")]),
        field("total", "number", { rules: { value: { kind: "arithmetic", operator: "multiply", left: { kind: "path", path: "income" }, right: { kind: "literal", value: 12 } } } }),
        field("band", "number", { rules: { value: { kind: "path", path: "total" } } })
      ]);
      const diagnostics = diagnoseJourney(calculated, journeyOf({ ...start, routes: [{ when: eq("band", 1), to: "money" }] }, about, money));
      expect(codes(diagnostics)).toEqual(["condition.reads-later-page"]);
      expect(diagnostics[0]).toMatchObject({ pageId: "start", routeIndex: 0, componentId: "income" });
      expect(diagnostics[0]?.message).toBe(
        'Route 1 of page "start" reads band, calculated from income, which is asked only on page "money" or later, so it always reads as unanswered there.'
      );
    });

    it("calc.reads-branch: a calculation reading an answer some path leaves off", () => {
      const calculated = group("form", "form", [
        field("eligible", "radio"),
        field("name"),
        field("email"),
        group("extra", "fieldset", [field("income", "number")]),
        field("total", "number", { rules: { value: { kind: "call", name: "sum", args: [{ kind: "path", path: "income" }, { kind: "path", path: "eligible" }] } } })
      ]);
      const conditional = diagnoseJourney(calculated, journeyOf(start, { ...about, routes: [{ when: eq("eligible", "no"), to: "$end" }] }, money));
      expect(codes(conditional)).toEqual(["calc.reads-branch"]);
      expect(conditional[0]).toMatchObject({ severity: "warning", componentId: "total" });
      expect(conditional[0]?.message).toBe(
        "The calculation of total reads income, which some paths through the journey leave off, so total may be calculated without it."
      );

      const routedPast = diagnoseJourney(calculated, journeyOf({ ...start, routes: [{ when: eq("eligible", "no"), to: "about" }] }, money, about));
      expect(codes(routedPast)).toEqual(["calc.reads-branch"]);

      expect(diagnoseJourney(calculated, journeyOf(start, about, money))).toEqual([]);
    });

    it("calc.reads-branch: not when every path takes one of the answer's pages, or the calculation shares its page", () => {
      const calculated = group("form", "form", [
        field("eligible", "radio"),
        field("income", "number"),
        field("total", "number", { rules: { value: { kind: "path", path: "income" } } })
      ]);
      const eitherBranch = journeyOf(
        { ...start, routes: [{ when: eq("eligible", "no"), to: "low" }] },
        { id: "high", title: "High", components: ["income"], routes: [{ to: "$end" }] },
        { id: "low", title: "Low", components: ["income"] }
      );
      expect(codes(diagnoseJourney(calculated, eitherBranch))).toEqual(["component.multiple-pages"]);

      const samePage = journeyOf({ ...start, routes: [{ when: eq("eligible", "no"), to: "$end" }] }, { id: "money", title: "Money", components: ["income", "total"] });
      expect(diagnoseJourney(calculated, samePage)).toEqual([]);
    });

    it("page.entry-field: a field of each entry of a repeating section, listed on its own", () => {
      const withItems = group("form", "form", [field("eligible", "radio"), group("items", "repeatingSection", [field("sku")], { collection: {} })]);
      const diagnostics = diagnoseJourney(withItems, journeyOf(start, { id: "list", title: "Items", components: ["sku"] }));
      expect(codes(diagnostics)).toEqual(["page.entry-field"]);
      expect(diagnostics[0]).toMatchObject({ severity: "warning", pageId: "list", componentId: "sku" });
    });

    it("page.validation-server-deferred: a server check on a page that defers, set on the page or inherited", () => {
      const own = journeyOf(start, { ...about, validation: { continue: "defer", server: true } }, money);
      const diagnostics = diagnoseJourney(tree, own);
      expect(codes(diagnostics)).toEqual(["page.validation-server-deferred"]);
      expect(diagnostics[0]).toMatchObject({ severity: "warning", journeyId: "apply", pageId: "about" });
      expect(diagnostics[0]?.message).toBe(
        'Page "about" is not checked on Continue (the default is to move on and check at the end) yet asks the host\'s server to check it; a step is checked against the server on Continue only when its validation.continue is "page", so server is ignored there.'
      );

      // The journey's defaults, overridden key by key: only the pages left with both warn.
      const inherited: Journey = {
        ...journeyOf(start, { ...about, validation: { continue: "page" } }, money),
        validation: { continue: "defer", server: true }
      };
      expect(diagnoseJourney(tree, inherited).map((diagnostic) => [diagnostic.code, diagnostic.pageId])).toEqual([
        ["page.validation-server-deferred", "start"],
        ["page.validation-server-deferred", "money"]
      ]);
      // A deferred page with no server check, and a checked page that does not defer, are fine.
      expect(diagnoseJourney(tree, journeyOf({ ...start, validation: { continue: "defer" } }, { ...about, validation: { continue: "page", server: true } }, money))).toEqual([]);
    });

    it("page.validation-on-exit: validation settings on an exit page, which has no Continue", () => {
      const stop: JourneyPage = { id: "stop", kind: "exit", title: "Not eligible", components: ["bye"], validation: { server: true } };
      const journey = journeyOf({ ...start, routes: [{ when: eq("eligible", "no"), to: "stop" }] }, about, { ...money, routes: [{ to: "$end" }] }, stop);
      const diagnostics = diagnoseJourney(tree, journey);
      expect(codes(diagnostics)).toEqual(["page.validation-on-exit"]);
      expect(diagnostics[0]).toMatchObject({ severity: "warning", pageId: "stop" });
      // The journey's own defaults do not count against its exit pages.
      const { validation: _own, ...bare } = stop;
      const defaults: Journey = { ...journey, pages: [...journey.pages.slice(0, -1), bare], validation: { continue: "page", server: true } };
      expect(codes(diagnoseJourney(tree, defaults))).toEqual([]);
    });

    it("rule.reads-host: a visibility, enabled, read-only or required rule a server cannot evaluate", () => {
      const hosted = group("form", "form", [
        field("eligible", "radio", { rules: { visibleWhen: eq("host.region", "north") } }),
        field("name", "text", { rules: { enabledWhen: eq("host.role", "staff"), requiredWhen: eq("host.role", "public") } }),
        field("email", "text", { rules: { readonlyWhen: { kind: "path", path: "host.locked" } } }),
        group("extra", "fieldset", [field("income", "number")])
      ]);
      const diagnostics = diagnoseJourney(hosted, journeyOf(start, about, money));
      expect(codes(diagnostics)).toEqual(["rule.reads-host", "rule.reads-host", "rule.reads-host", "rule.reads-host"]);
      expect(diagnostics.map((diagnostic) => diagnostic.componentId)).toEqual(["eligible", "name", "name", "email"]);
      expect(diagnostics[0]?.message).toBe(
        "The visibility rule of eligible reads host.region, which a server checking the submission does not have, so the server treats eligible as shown."
      );
      // The kernel reads a host-bound required rule as false: the browser holds the field to it, the server does not.
      expect(diagnostics[2]?.message).toBe(
        "The required rule of name reads host.role, which a server checking the submission does not have, so the server does not hold name to it."
      );
    });
  });
});

describe("diagnoseJourneys", () => {
  it("diagnoses each journey, and journeys sharing an id", () => {
    const clean = journeyOf(start, about, money);
    const broken: Journey = { id: "apply", pages: [start, about, { ...money, components: ["ghost", "extra"] }] };
    const diagnostics = diagnoseJourneys({ root: tree, journey: { journeys: [clean, broken, { id: "junk" }] } });
    expect(codes(diagnostics)).toEqual(["journey.duplicate-id", "page.unknown-component"]);
    expect(diagnostics[0]).toMatchObject({ severity: "error", journeyId: "apply" });
    expect(diagnostics[0]?.message).toBe('Two journeys have the id "apply"; only the first can be opened.');
  });

  it("finds nothing in a definition without journeys", () => {
    expect(diagnoseJourneys({ root: tree })).toEqual([]);
    expect(diagnoseJourneys({ root: tree, journey: "none" })).toEqual([]);
  });
});

/**
 * Presentations: pages holding nodes of their own beside the component ids. The
 * findings read the one ownership the browser and the server share, so what a page references,
 * fills or works out is on that page for every check; a node a usability rule ignores is said
 * once per entry; and nothing a hand-written page holds makes the diagnostics throw.
 */
describe("diagnoseJourney over pages holding nodes of their own", () => {
  const root = presentationRoot();
  const reference = (componentId: string): JourneyPageEntry => ({ type: "journey-field", configuration: { componentId } });
  const own = (id: string, type = "text", configuration: Record<string, unknown> = { label: id }, extra: Record<string, unknown> = {}): JourneyPageEntry =>
    ({ id, type, configuration, ...extra }) as unknown as JourneyPageEntry;
  const workedOut = (id: string, to: string): JourneyPageEntry => own(id, "journey-value", { to, value: { kind: "path", path: "m1" } });
  /** A journey asking every field of the fixture's form, plus `entries` on a page of their own, first. */
  const withEntries = (...entries: JourneyPageEntry[]): Journey => ({
    id: "apply",
    pages: [
      { id: "own", title: "Own", components: entries },
      { id: "rest", title: "Rest", components: ["email", "name", "money", "approved_amount"] }
    ]
  });
  const unusable = (diagnostics: JourneyDiagnostic[]): Array<Record<"severity" | "pageId" | "pageIndex" | "entryId" | "rule", unknown>> =>
    diagnostics
      .filter((diagnostic) => diagnostic.code === "presentation.entry-unusable")
      .map(({ severity, pageId, pageIndex, entryId, rule }) => ({ severity, pageId, pageIndex, entryId, rule }));
  /** The findings a usability rule stands behind (they carry its letter), where the designer draws them. */
  const ruled = (diagnostics: JourneyDiagnostic[]): Array<Record<"code" | "severity" | "pageIndex" | "ownNodeId" | "componentId" | "rule", unknown>> =>
    diagnostics
      .filter((diagnostic) => diagnostic.rule !== undefined)
      .map(({ code, severity, pageIndex, ownNodeId, componentId, rule }) => ({ code, severity, pageIndex, ownNodeId, componentId, rule }));

  it("counts a form field an alias fills, a worked-out value sets or a reference shows as asked, never as left out", () => {
    // `apply`: email through an alias, annual_income worked out (its fieldset on no page), approved_amount listed; `name` is asked nowhere.
    const diagnostics = diagnoseJourney(root, applyJourney());
    expect(diagnostics.map(({ code, severity, componentId, required }) => [code, severity, componentId, required])).toEqual([
      // The route reads the value the browser works out: said, not refused.
      ["condition.reads-client-derived", "warning", "annual_income", undefined],
      ["component.unassigned", "warning", "name", false],
      ["presentation.fields-left-out", "warning", undefined, undefined]
    ]);
    // As both sides judge it: answers given through the journey pass, with no own answer sent.
    for (const values of [APPLY_BELOW, APPLY_ABOVE]) {
      expect(runKernel({ formId: "f", values, locale: "en", form: root, journey: applyJourney() }, []).errors).toEqual([]);
    }

    // `public`: email and name through references in an own layout; the required annual_income is left out, and said so.
    const variant = diagnoseJourney(root, publicVariant());
    expect(variant.map(({ code, severity, componentId, required }) => [code, severity, componentId, required])).toEqual([
      ["component.unassigned", "error", "annual_income", true],
      ["component.unassigned", "warning", "approved_amount", false],
      ["presentation.fields-left-out", "warning", undefined, undefined]
    ]);
    expect(runKernel({ formId: "f", values: { email: "ada@example.org" }, locale: "en", form: root, journey: publicVariant() }, []).errors.map((error) => `${error.componentId}:${error.code}`)).toEqual([
      "annual_income:required"
    ]);
  });

  it("reads where a field stands from the shared ownership: take the alias's `fills` away and the field is left out again", () => {
    const journey = applyJourney();
    const { fills: _fills, ...plain } = workEmailAlias().configuration as Record<string, unknown>;
    journey.pages[0]!.components = [{ ...workEmailAlias(), configuration: plain }];
    const diagnostics = diagnoseJourney(root, journey);
    expect(diagnostics.filter((diagnostic) => diagnostic.componentId === "email").map(({ code, severity, required }) => [code, severity, required])).toEqual([
      ["component.unassigned", "error", true]
    ]);
    // The page still shows its own field, and its heading is its own.
    expect(codes(diagnostics)).not.toContain("page.no-title");
  });

  it("page.unknown-component, page.root-component and page.entry-field: a reference at the top of a page reads as the id does", () => {
    const sectioned = group("form", "form", [
      field("email"),
      group("people", "panel", [field("person")], { collection: { collectionPath: "people", itemFields: ["person"] } })
    ]);
    const journey: Journey = {
      id: "apply",
      pages: [{ id: "p", title: "P", components: [reference("email"), reference("ghost"), reference("form"), reference("person"), reference("people")] }]
    };
    expect(validateJourneyShape(journey)).toEqual([]);
    const diagnostics = diagnoseJourney(sectioned, journey);
    expect(diagnostics.map(({ code, severity, componentId, pageIndex }) => [code, severity, componentId, pageIndex])).toEqual([
      ["page.unknown-component", "error", "ghost", 0],
      ["page.root-component", "error", "form", 0],
      ["page.entry-field", "warning", "person", 0]
    ]);
    expect(diagnostics[0]?.message).toBe('Page "p" lists ghost, which is not a component of the form.');
  });

  describe("what a usability rule ignores: an error on the node, under the code that says why", () => {
    const sectioned = (): ComponentNode => {
      const tree = presentationRoot();
      tree.children!.content!.push(
        group("people", "panel", [field("person")], { collection: { collectionPath: "people", itemFields: ["person"] } }),
        field("total", "number", { rules: { value: { kind: "literal", value: 1 } } })
      );
      return tree;
    };
    // [name, entries, code, rule, ownNodeId, componentId, message]
    const cases: Array<[string, JourneyPageEntry[], string, string, string, string | undefined, string]> = [
      [
        "A: an id a component cannot have",
        [own("2nd place")],
        "presentation.entry-unusable",
        "A",
        "2nd place",
        undefined,
        '2nd place on page "own" has an id a component cannot have (a letter first, then letters, digits, _ or -), so the page does not show it.'
      ],
      [
        "A: the id of a form component",
        [own("email")],
        "field.id-clash",
        "A",
        "email",
        undefined,
        'email on page "own" has the id of a component of the form; a node of the journey\'s own needs an id of its own, so the page does not show it.'
      ],
      [
        "A: the id of an earlier own node, which drops the entry holding the later one",
        [own("note"), own("box", "fieldset", { label: "Box" }, { children: { content: [own("note")] } })],
        "field.id-clash",
        "A",
        "note",
        undefined,
        'note (in box) on page "own" has the id of an earlier node of the journey\'s own; each needs an id of its own, so the page does not show box, which holds it.'
      ],
      [
        "B: a type a presentation cannot hold",
        [own("upload", "file")],
        "field.unsupported-type",
        "B",
        "upload",
        undefined,
        'upload on page "own" is a file, which a journey\'s page cannot hold as its own (no repeating section, data grid, file, signature or steps), so the page does not show it.'
      ],
      [
        "C: a data binding of its own",
        [own("scoped", "container", { label: "Scoped" })],
        "field.data-binding",
        "C",
        "scoped",
        undefined,
        'scoped on page "own" binds data of its own (a collection, a data path or key, or a container that scopes data), which a node of the journey\'s own cannot, so the page does not show it.'
      ],
      [
        "D: a reference naming no form component, skipped by itself — on the layout holding it",
        [own("box", "fieldset", { label: "Box" }, { children: { content: [reference("ghost"), reference("name")] } })],
        "page.unknown-component",
        "D",
        "box",
        "ghost",
        'A reference in box on page "own" shows ghost, which is not a component of the form, so it is skipped: nothing is drawn in its place.'
      ],
      [
        "D: a reference to the form itself",
        [own("box", "fieldset", { label: "Box" }, { children: { content: [reference("form"), reference("name")] } })],
        "page.root-component",
        "D",
        "box",
        "form",
        'A reference in box on page "own" shows the form itself (form), so it is skipped: nothing is drawn in its place.'
      ],
      [
        "E: an alias whose target the form does not have",
        [own("alt", "text", { label: "Alt", fills: "ghost" })],
        "map.unknown-target",
        "E",
        "alt",
        "ghost",
        'alt on page "own" is set to fill ghost, which is not a component of the form, so it fills nothing: its answer stays in the browser, and the form field is not asked through it.'
      ],
      [
        "E: an alias whose target is inside a repeating section",
        [own("alt", "text", { label: "Alt", fills: "person" })],
        "map.target-unusable",
        "E",
        "alt",
        "person",
        'alt on page "own" is set to fill person, which is inside people (a repeating section or a data grid), so it fills nothing: its answer stays in the browser, and the form field is not asked through it.'
      ],
      [
        "E: an alias whose target the form calculates",
        [own("alt", "number", { label: "Alt", fills: "total" })],
        "map.target-unusable",
        "E",
        "alt",
        "total",
        'alt on page "own" is set to fill total, which the form calculates itself, so it fills nothing: its answer stays in the browser, and the form field is not asked through it.'
      ],
      [
        "E: a worked-out value whose target holds no answer",
        [own("m1", "number"), workedOut("sum", "money")],
        "map.target-unusable",
        "E",
        "sum",
        "money",
        'sum on page "own" works out money, which holds no answer of its own (a fieldset), so it is ignored: the page does not show it.'
      ],
      [
        "E: a worked-out value whose target the form does not have",
        [own("m1", "number"), workedOut("sum", "ghost")],
        "map.unknown-target",
        "E",
        "sum",
        "ghost",
        'sum on page "own" works out ghost, which is not a component of the form, so it is ignored: the page does not show it.'
      ],
      [
        "F: `fills` on a node that holds no answer itself",
        [own("words", "html", { content: "<p>Hello</p>", fills: "name" })],
        "presentation.entry-unusable",
        "F",
        "words",
        undefined,
        'words on page "own" is set to fill name but holds no answer itself (a html), so it fills nothing: its answer stays in the browser, and the form field is not asked through it.'
      ],
      [
        "G: a worked-out value whose target the journey places elsewhere",
        [own("m1", "number"), workedOut("sum", "name")],
        "map.target-conflict",
        "G",
        "sum",
        "name",
        'sum on page "own" works out name, which the journey already asks or shows on a page, so it is ignored: a worked-out field must be placed by nothing else.'
      ],
      [
        "G: an alias and a worked-out value on one field",
        [own("m1", "number"), workedOut("sum", "annual_income"), own("income_alias", "number", { label: "Income", fills: "annual_income" })],
        "map.target-conflict",
        "G",
        "sum",
        "annual_income",
        'sum on page "own" works out annual_income, which income_alias already fills, so it is ignored: a worked-out field must be placed by nothing else.'
      ]
    ];

    it.each(cases)("%s", (_name, entries, code, rule, ownNodeId, componentId, message) => {
      const journey = withEntries(...entries);
      expect(validateJourneyShape(journey)).toEqual([]);
      const diagnostics = diagnoseJourney(sectioned(), journey);
      expect(ruled(diagnostics)).toEqual([{ code, severity: "error", pageIndex: 0, ownNodeId, componentId, rule }]);
      const [finding] = diagnostics.filter((diagnostic) => diagnostic.rule !== undefined);
      expect(finding).toMatchObject({ pageId: "own", message });
      // Only `presentation.entry-unusable` carries the entry's id (here the node itself); the others say which node alone.
      expect(finding?.entryId).toBe(code === "presentation.entry-unusable" ? ownNodeId : undefined);
    });

    it("H: a journey holding nodes of its own whose id a component could not have — said once per entry", () => {
      const journey: Journey = { ...withEntries(own("note"), own("box", "fieldset", { label: "Box" }, { children: { content: [own("inner"), own("inner_2")] } })), id: "staff view" };
      expect(validateJourneyShape(journey)).toEqual([]);
      const diagnostics = diagnoseJourney(root, journey);
      expect(unusable(diagnostics)).toEqual([
        { severity: "error", pageId: "own", pageIndex: 0, entryId: "note", rule: "H" },
        { severity: "error", pageId: "own", pageIndex: 0, entryId: "box", rule: "H" }
      ]);
      expect(diagnostics.filter((diagnostic) => diagnostic.rule === "H").map((diagnostic) => diagnostic.ownNodeId)).toEqual(["note", "box"]);
      expect(diagnostics.filter((diagnostic) => diagnostic.code === "presentation.entry-unusable").map((diagnostic) => diagnostic.message)).toEqual([
        'note on page "own" is a node of the journey\'s own, and a journey holding such nodes needs an id a component could have (a letter first, then letters, digits, _ or -), which "staff view" is not, so the page does not show it.',
        'box on page "own" is a node of the journey\'s own, and a journey holding such nodes needs an id a component could have (a letter first, then letters, digits, _ or -), which "staff view" is not, so the page does not show it.'
      ]);
    });

    it("I: an own field whose answer would live at a key the form's data uses", () => {
      const tree = presentationRoot();
      tree.children!.content!.push(group("rows", "repeatingSection", [field("sku")], { collection: { collectionPath: "@apply.items" } }));
      const diagnostics = diagnoseJourney(tree, withEntries(own("fine"), own("box", "fieldset", { label: "Box" }, { children: { content: [own("items", "textarea")] } })));
      expect(unusable(diagnostics)).toEqual([{ severity: "error", pageId: "own", pageIndex: 0, entryId: "box", rule: "I" }]);
      // Drawn on the node that breaks it, inside the entry; the form's own key is said on the form, as a warning (the error is the clash).
      expect(only(diagnostics, "presentation.entry-unusable").ownNodeId).toBe("items");
      expect(only(diagnostics, "data-key.reserved-prefix")).toMatchObject({ severity: "warning", componentId: "rows" });
      expect(only(diagnostics, "presentation.entry-unusable").message).toBe(
        'items (in box) on page "own" would keep its answer at @apply.items, a key the form\'s own data already uses, so the answer would be sent as a form value; give it another id, so the page does not show box, which holds it.'
      );
    });

    it("G: the second worked-out value for one field names the first", () => {
      const journey: Journey = {
        id: "apply",
        pages: [
          { id: "own", title: "Own", components: [own("m1", "number"), workedOut("first", "annual_income"), workedOut("second", "annual_income")] },
          { id: "rest", title: "Rest", components: ["email", "name", "approved_amount"] }
        ]
      };
      const diagnostics = diagnoseJourney(root, journey);
      expect(ruled(diagnostics)).toEqual([{ code: "map.target-conflict", severity: "error", pageIndex: 0, ownNodeId: "second", componentId: "annual_income", rule: "G" }]);
      expect(only(diagnostics, "map.target-conflict").message).toBe(
        'second on page "own" works out annual_income, which first already works out, so it is ignored: a worked-out field must be placed by nothing else.'
      );
      // The first places the required field, so nothing is left out.
      expect(codes(diagnostics)).toEqual(["map.target-conflict"]);
    });

    it("says each thing wrong in an entry in use on its node, and only why a dropped entry is dropped", () => {
      const box = own("box", "fieldset", { label: "Box" }, { children: { content: [reference("ghost"), own("alt", "text", { fills: "nope" }), reference("form")] } });
      const partial = diagnoseJourney(root, withEntries(box, own("fine", "html", { content: "<p>Fine</p>" })));
      expect(ruled(partial)).toEqual([
        { code: "page.unknown-component", severity: "error", pageIndex: 0, ownNodeId: "box", componentId: "ghost", rule: "D" },
        { code: "map.unknown-target", severity: "error", pageIndex: 0, ownNodeId: "alt", componentId: "nope", rule: "E" },
        { code: "page.root-component", severity: "error", pageIndex: 0, ownNodeId: "box", componentId: "form", rule: "D" }
      ]);
      expect(only(partial, "map.unknown-target").message).toBe(
        'alt (in box) on page "own" is set to fill nope, which is not a component of the form, so it fills nothing: its answer stays in the browser, and the form field is not asked through it.'
      );
      // Dropped whole for the file in it: the bad reference beside it is beside the point.
      const dropped = own("box", "fieldset", { label: "Box" }, { children: { content: [reference("ghost"), own("upload", "file")] } });
      const whole = diagnoseJourney(root, withEntries(dropped));
      expect(ruled(whole)).toEqual([{ code: "field.unsupported-type", severity: "error", pageIndex: 0, ownNodeId: "upload", componentId: undefined, rule: "B" }]);
      expect(only(whole, "field.unsupported-type").message).toBe(
        'upload (in box) on page "own" is a file, which a journey\'s page cannot hold as its own (no repeating section, data grid, file, signature or steps), so the page does not show box, which holds it.'
      );
      // Every entry of the page ignored: nothing on it, and nothing more said of the page.
      expect(whole.map((diagnostic) => diagnostic.code)).toEqual(["field.unsupported-type"]);
      // Every node that drops it is said, each on its own node.
      const twice = own("box", "fieldset", { label: "Box" }, { children: { content: [own("upload", "file"), own("email"), own("bound", "text", { dataKey: "x" })] } });
      expect(ruled(diagnoseJourney(root, withEntries(twice))).map(({ code, ownNodeId, rule }) => [code, ownNodeId, rule])).toEqual([
        ["field.unsupported-type", "upload", "B"],
        ["field.id-clash", "email", "A"],
        ["field.data-binding", "bound", "C"]
      ]);
    });

    it("agrees with the ownership both sides share about which entries are in use", () => {
      const journey = withEntries(
        own("fine"),
        own("email"),
        own("upload", "file"),
        own("alt", "text", { fills: "ghost" }),
        own("box", "fieldset", { label: "Box" }, { children: { content: [reference("ghost"), own("inner")] } }),
        own("fine")
      );
      const ownership = journeyOwnership(root, journey);
      // In use: the plain field, the alias that fills nothing (a plain own field), and the layout with its usable node.
      expect(ownership.membersOf.own).toEqual(["fine", "alt", "box"]);
      const diagnostics = diagnoseJourney(root, journey);
      expect(ruled(diagnostics).map(({ code, ownNodeId, rule }) => [code, ownNodeId, rule])).toEqual([
        ["field.id-clash", "email", "A"],
        ["field.unsupported-type", "upload", "B"],
        ["map.unknown-target", "alt", "E"],
        ["page.unknown-component", "box", "D"],
        ["field.id-clash", "fine", "A"]
      ]);
      // Exactly the entries the ownership leaves out are said to be dropped ("so the page does not show").
      const droppedSaid = diagnostics.filter((diagnostic) => diagnostic.message.includes("so the page does not show")).map((diagnostic) => diagnostic.ownNodeId);
      expect(droppedSaid).toEqual(["email", "upload", "fine"]);
      expect(ownership.membersOf.own).not.toContain("email");
      expect(ownership.membersOf.own).not.toContain("upload");
      // The second `fine` is dropped: the page holds the first alone.
      expect(ownership.membersOf.own!.filter((member) => member === "fine")).toHaveLength(1);
    });
  });

  it("says nothing of a page that shows nothing: one whose own entries only fill hidden fields is shown all the same", () => {
    const hidden = presentationRoot();
    hidden.children!.content!.push(field("secret", "text", { configuration: { label: "Secret", hidden: true } }));
    const paragraph = own("words", "html", { content: "<p>Read this first.</p>" });
    const fillsHidden = own("alias", "text", { label: "Alias", fills: "secret" });
    const rest: JourneyPage = { id: "rest", title: "Rest", components: ["email", "name", "money", "approved_amount"] };
    const page = (...entries: JourneyPageEntry[]): Journey => ({ id: "apply", pages: [{ id: "own", title: "Own", components: entries }, rest] });

    expect(codes(diagnoseJourney(hidden, page(paragraph)))).toEqual([]);
    // Beside content of its own, a hidden target does not empty the page (the alias itself never shows: said).
    expect(codes(diagnoseJourney(hidden, page(fillsHidden, paragraph)))).toEqual(["map.target-hidden"]);
    expect(codes(diagnoseJourney(hidden, page(fillsHidden)))).toEqual(["map.target-hidden"]);
    expect(codes(diagnoseJourney(hidden, page(own("box", "fieldset", { label: "Box" }, { children: { content: [reference("secret")] } }))))).toEqual([]);
  });

  it("page.no-title: borrows an own entry's label, else — a worked-out value with no label alone — the label of the field it works out", () => {
    const untitled = (entry: JourneyPageEntry, ...more: JourneyPageEntry[]): Journey => ({
      id: "apply",
      pages: [{ id: "own", components: [entry, ...more] }, { id: "rest", title: "Rest", components: ["name", "money", "approved_amount"] }]
    });
    expect(codes(diagnoseJourney(root, untitled(own("work_email", "text", { label: "Work email", fills: "email" }))))).toEqual([]);
    // An alias with no label of its own borrows nothing: the runtime draws no heading for the page (journey-diagnostics-own-nodes.test.ts holds the two to one heading).
    expect(codes(diagnoseJourney(root, untitled(own("work_email", "text", { fills: "email" }))))).toEqual(["page.no-title"]);
    const bare = diagnoseJourney(root, untitled(own("words", "html", { content: "<p>Hi</p>" }), own("work_email", "text", { label: "Work email", fills: "email" })));
    expect(codes(bare)).toEqual(["page.no-title"]);
    expect(bare[0]?.message).toBe('Page "own" has no title, and its first component, words, has no label to borrow, so it is shown without a heading. Give the page a title.');
  });

  it("component.multiple-pages: a field filled through aliases on two pages is on both", () => {
    const journey: Journey = {
      id: "apply",
      pages: [
        { id: "work", title: "Work", components: [own("work_email", "text", { label: "Work email", fills: "email" })] },
        { id: "home", title: "Home", components: [own("home_email", "text", { label: "Home email", fills: "email" })] },
        { id: "rest", title: "Rest", components: ["name", "money", "approved_amount"] }
      ]
    };
    const diagnostics = diagnoseJourney(root, journey);
    expect(codes(diagnostics)).toEqual(["component.multiple-pages"]);
    expect(diagnostics[0]).toMatchObject({ severity: "warning", componentId: "email" });
    expect(diagnostics[0]?.message).toContain('email is on pages "work" and "home".');
  });

  describe("condition.reads-presentation-field: a route's condition reading a field of the journey's own", () => {
    it("is an error for an own id and for a key under @, naming the form field to read instead", () => {
      const journey = applyJourney();
      journey.pages[0]!.routes = [{ when: eq("work_email", "x"), to: "assist" }];
      journey.pages[1]!.routes = [
        { when: { kind: "binary", operator: "gt", left: path("m1"), right: { kind: "literal", value: 0 } }, to: "assist" },
        { when: { kind: "binary", operator: "gt", left: path("@apply.income_total"), right: { kind: "literal", value: 0 } }, to: "assist" },
        { when: eq("@other.thing", "x"), to: "assist" },
        { to: "$end" }
      ];
      const diagnostics = diagnoseJourney(root, journey).filter((diagnostic) => diagnostic.code.startsWith("condition."));
      expect(diagnostics.map(({ code, severity, pageId, pageIndex, routeIndex }) => [code, severity, pageId, pageIndex, routeIndex])).toEqual([
        ["condition.reads-presentation-field", "error", "details", 0, 0],
        ["condition.reads-presentation-field", "error", "income", 1, 0],
        ["condition.reads-presentation-field", "error", "income", 1, 1],
        ["condition.reads-presentation-field", "error", "income", 1, 2]
      ]);
      expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
        'Route 1 of page "details" reads work_email, a field of journey "apply"\'s own: a condition reads the form\'s answers only, on the server as in the browser, so it always reads as unanswered. Read email, the form field it fills, instead.',
        'Route 1 of page "income" reads m1, a field of journey "apply"\'s own: a condition reads the form\'s answers only, on the server as in the browser, so it always reads as unanswered. Read a form field instead.',
        'Route 2 of page "income" reads @apply.income_total, where the browser keeps the answer of a field the journey\'s pages own: a condition reads the form\'s answers only, on the server as in the browser, so it always reads as unanswered. Read annual_income, the form field it works out, instead.',
        'Route 3 of page "income" reads @other.thing, where the browser keeps the answer of a field the journey\'s pages own: a condition reads the form\'s answers only, on the server as in the browser, so it always reads as unanswered. Read a form field instead.'
      ]);
    });

    it("leaves a form field's own id, and an id nothing has, as they were", () => {
      // An own node spelled like a form field is ignored (rule A): the path still reads the form's.
      const journey = withEntries(own("name"), own("extra"));
      journey.pages[1]!.routes = [{ when: eq("name", "x"), to: "$end" }, { when: eq("nobody", "x"), to: "$end" }];
      const diagnostics = diagnoseJourney(root, journey).filter((diagnostic) => diagnostic.code.startsWith("condition."));
      expect(diagnostics.map(({ code, severity, routeIndex }) => [code, severity, routeIndex])).toEqual([["condition.unknown-field", "warning", 1]]);
    });

    it("holds for a journey of component ids alone: a key under @ is never a form answer", () => {
      const journey = journeyOf({ ...start, routes: [{ when: eq("@apply.m1", "x"), to: "money" }] }, about, money);
      const diagnostics = diagnoseJourney(tree, journey);
      expect(diagnostics.map(({ code, severity, pageId }) => [code, severity, pageId])).toEqual([["condition.reads-presentation-field", "error", "start"]]);
    });
  });

  it("rule.reads-presentation-field: a form rule or calculation reading an own id, or this journey's key under @", () => {
    const ruled = presentationRoot();
    const [email, name, , approved] = ruled.children!.content as ComponentNode[];
    name!.rules = { visibleWhen: eq("m1", 1), requiredWhen: eq("email", "x") };
    approved!.rules = { value: call("sum", path("@apply.m2"), path("@apply.m2"), path("annual_income")), defaultValue: path("@other.m1") };
    email!.rules = { enabledWhen: eq("work_email", "x") };
    const diagnostics = diagnoseJourney(ruled, applyJourney()).filter((diagnostic) => diagnostic.code === "rule.reads-presentation-field");
    expect(diagnostics.map(({ severity, componentId }) => [severity, componentId])).toEqual([
      ["error", "email"],
      ["error", "name"],
      ["error", "approved_amount"]
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'The enabled rule of email reads work_email, a field of journey "apply"\'s own: the form\'s rules read the form\'s answers only, so it always reads as unanswered — read email, the form field it fills, instead.',
      'The visibility rule of name reads m1, a field of journey "apply"\'s own: the form\'s rules read the form\'s answers only, so it always reads as unanswered.',
      'The calculation of approved_amount reads @apply.m2, where the browser keeps the answer of a field the journey\'s pages own: the form\'s rules read the form\'s answers only, so it always reads as unanswered.'
    ]);
    // Another journey over the same form owns none of those ids: nothing of its own is read.
    expect(codes(diagnoseJourney(ruled, publicVariant()))).not.toContain("rule.reads-presentation-field");
  });

  it("never throws, whatever a hand-written page holds", () => {
    // Not what the shape check lets through: the diagnostics are still asked directly by a host.
    let deep: Record<string, unknown> = { id: "leaf", type: "text" };
    for (let depth = 0; depth < 5000; depth += 1) {
      deep = { id: `level${depth}`, type: "fieldset", children: { content: [deep] } };
    }
    const odd = [
      null,
      7,
      [],
      {},
      { type: 5 },
      { id: 7, type: "text" },
      { id: "cfg", type: "text", configuration: "words", rules: 3 },
      { id: "kids", type: "fieldset", children: { content: [null, 3, { type: 5 }, { type: "journey-field" }, { type: "journey-field", configuration: "x" }], other: "nonsense" } },
      { id: "val", type: "journey-value" },
      { id: "val2", type: "journey-value", configuration: { to: 9, value: 1 } },
      { id: "fill", type: "text", configuration: { fills: 12 } },
      { id: "__proto__", type: "text" },
      { id: "constructor", type: "text", configuration: { fills: "toString" } },
      { type: "journey-field" },
      { type: "journey-field", configuration: { componentId: 4 } },
      deep
    ] as unknown as JourneyPageEntry[];
    const journey: Journey = {
      id: "apply",
      pages: [
        { id: "odd", components: odd, routes: [{ when: eq("constructor", "x"), to: "rest" }, { when: eq("__proto__", "x"), to: "rest" }] },
        { id: "rest", title: "Rest", components: ["email", "name", "money", "approved_amount"] }
      ]
    };
    let diagnostics: JourneyDiagnostic[] = [];
    expect(() => {
      diagnostics = diagnoseJourney(root, journey);
    }).not.toThrow();
    expect(diagnostics.every((diagnostic) => typeof diagnostic.message === "string" && diagnostic.message.length > 0)).toBe(true);
    // The deep layout is in use, all 5000 levels of it; the rest is said once each.
    expect(journeyOwnership(root, journey).membersOf.odd).toContain("level4999");
    expect(unusable(diagnostics).length).toBeGreaterThan(5);
  });

  it("diagnoseJourneys: reads every presentation of a definition", () => {
    const diagnostics = diagnoseJourneys(presentationForm());
    expect(diagnostics.map(({ journeyId, code, severity }) => [journeyId, code, severity])).toEqual([
      ["apply", "condition.reads-client-derived", "warning"],
      ["apply", "component.unassigned", "warning"],
      ["apply", "presentation.fields-left-out", "warning"],
      ["public", "component.unassigned", "error"],
      ["public", "component.unassigned", "warning"],
      ["public", "presentation.fields-left-out", "warning"]
    ]);
  });
});

describe("the pages every submittable path takes (journeyCertainWalk)", () => {
  const not = (path: string): Expression => ({ kind: "unary", operator: "not", operand: { kind: "path", path } }) as Expression;
  const form: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { required: true } },
        { id: "eligible", type: "checkbox", configuration: {} },
        { id: "partnerName", type: "text", configuration: { required: true } },
        { id: "notes", type: "text", configuration: { required: true } },
        { id: "remark", type: "text", configuration: {} }
      ]
    }
  };

  it("reads which pages every path that can be submitted takes, and where a new page would be", () => {
    const walk = journeyCertainWalk({
      id: "j",
      pages: [
        { id: "p1", components: ["fullName", "eligible"], routes: [{ when: not("eligible"), to: "stop" }, { to: "$end" }] },
        { id: "stop", kind: "exit", components: [] },
        { id: "late", components: ["notes"] }
      ]
    });
    // The way out at "stop" is never submitted; the way to the end skips "late".
    expect(walk).toEqual({ submittable: true, pages: [0], slots: [0] });
    // Branches that meet again: "partner" may be routed past, "end" never is; the places the
    // route passes are not certain, the ones before and after it are.
    expect(
      journeyCertainWalk({
        id: "j",
        pages: [
          { id: "p1", components: ["fullName"], routes: [{ when: { kind: "path", path: "eligible" } as Expression, to: "end" }] },
          { id: "partner", components: ["partnerName"] },
          { id: "end", components: ["notes"] }
        ]
      })
    ).toEqual({ submittable: true, pages: [0, 2], slots: [0, 3] });
    // A Check answers page ends every walk: no slot after it, and it is no page a field may go on.
    const declaration = { id: "declare", type: "paragraph", configuration: { text: "I confirm." } } as unknown as JourneyPageEntry;
    expect(journeyCertainWalk({ id: "j", pages: [{ id: "a", components: ["fullName"] }, { id: "check", kind: "review", components: [declaration] }] })).toEqual({
      submittable: true,
      pages: [0],
      slots: [0, 1]
    });
    expect(journeyCertainWalk({ id: "j", pages: [{ id: "a", components: ["fullName"] }, { id: "check", kind: "review" }, { id: "late", components: ["notes"] }] })).toEqual({
      submittable: true,
      pages: [0],
      slots: [0, 1]
    });
    // Nothing can be submitted: nothing is certain.
    expect(journeyCertainWalk({ id: "j", pages: [{ id: "p1", components: ["fullName"] }, { id: "bye", kind: "exit" }] })).toEqual({
      submittable: false,
      pages: [],
      slots: []
    });
  });
});

describe("formulas, if, the clock and run scopes", () => {
  const lit = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
  const fn = (name: string, ...args: Expression[]): Expression => ({ kind: "call", name, args }) as Expression;
  const ifExpr = (cases: Array<[Expression, Expression]>, otherwise?: Expression): Expression =>
    ({ kind: "if", cases: cases.map(([when, then]) => ({ when, then })), ...(otherwise !== undefined ? { else: otherwise } : {}) }) as Expression;
  /** The object form of a rule, as a definition writes one with a run scope. */
  const scoped = (expression: Expression, run: "both" | "browser" | "server" | "server-secret"): Expression => ({ expression, run }) as unknown as Expression;
  const formula = (text: string): Expression => text as unknown as Expression;
  const isToday = (day: string): Expression => ({ kind: "binary", operator: "eq", left: fn("today"), right: lit(day) });
  const of = (diagnostics: JourneyDiagnostic[], code: string): JourneyDiagnostic[] => diagnostics.filter((diagnostic) => diagnostic.code === code);

  describe("map.shape-mismatch reads a function's shape from the table and an if's from its branches", () => {
    const own = (id: string, type: string, configuration: Record<string, unknown>): JourneyPageEntry => ({ id, type, configuration }) as unknown as JourneyPageEntry;
    const workedOut = (to: string, value: Expression): JourneyPageEntry => own("calc", "journey-value", { to, value, label: "calc" });
    const typed = group("form", "form", [field("eligible", "radio"), field("name"), field("start", "date"), field("amount", "number")]);
    const mismatches = (to: string, value: Expression): number => {
      const first: JourneyPage = { id: "first", title: "First", components: [own("flag", "checkbox", { label: "flag" }), workedOut(to, value)] };
      const rest: JourneyPage = { id: "rest", title: "Rest", components: ["eligible", "name", "start", "amount"].filter((id) => id !== to) };
      return of(diagnoseJourney(typed, journeyOf(first, rest)), "map.shape-mismatch").length;
    };
    const flag = path("flag");

    it("an if whose branches agree on a number into a text field is a mismatch; disagreeing branches, or no else, cannot be told", () => {
      expect(mismatches("name", ifExpr([[flag, lit(1)]], lit(2)))).toBe(1);
      expect(mismatches("name", ifExpr([[flag, lit(1)], [eq("flag", false), lit(3)]], lit(2)))).toBe(1);
      expect(mismatches("name", ifExpr([[flag, lit(1)]], lit("x")))).toBe(0);
      expect(mismatches("name", ifExpr([[flag, lit(1)]]))).toBe(0);
      expect(mismatches("amount", ifExpr([[flag, lit(1)]], lit(2)))).toBe(0);
    });

    it("dateDiff into a date field is a mismatch; today() and date() into a date field are fine; a function returning anything cannot be told", () => {
      expect(mismatches("start", fn("dateDiff", lit("2026-01-01"), lit("2026-02-01"), lit("days")))).toBe(1);
      expect(mismatches("start", fn("today"))).toBe(0);
      expect(mismatches("start", fn("date", lit("2026-01-01")))).toBe(0);
      expect(mismatches("start", fn("dateAdd", fn("today"), lit(1), lit("days")))).toBe(0);
      expect(mismatches("name", fn("first", flag))).toBe(0);
      expect(mismatches("name", fn("split", lit("a,b"), lit(",")))).toBe(1);
      expect(mismatches("name", fn("sum", lit(1)))).toBe(1);
      expect(mismatches("name", fn("isWeekend", fn("today")))).toBe(1);
    });
  });

  describe("the clock", () => {
    it("rule.reads-clock once per component, naming every rule that reads today(); condition.reads-clock once per condition", () => {
      const form = group("form", "form", [
        field("eligible", "radio"),
        field("name", "text", { rules: { visibleWhen: isToday("2026-01-01"), value: fn("today") } }),
        field("email", "text", { rules: { enabledWhen: { kind: "binary", operator: "gt", left: fn("age", path("eligible")), right: lit(18) } } })
      ]);
      const diagnostics = diagnoseJourney(
        form,
        journeyOf({ ...start, routes: [{ when: isToday("2026-01-01"), to: "$end" }] }, { ...about, routes: [{ when: isToday("2026-01-02"), to: "$end" }] })
      );
      expect(of(diagnostics, "rule.reads-clock").map((diagnostic) => [diagnostic.severity, diagnostic.componentId, diagnostic.message])).toEqual([
        [
          "warning",
          "name",
          "The visibility rule and calculation of name read today(): the server judges it by its own clock, so a submission checked on another day may be judged differently."
        ],
        ["warning", "email", "The enabled rule of email reads today(): the server judges it by its own clock, so a submission checked on another day may be judged differently."]
      ]);
      expect(of(diagnostics, "condition.reads-clock").map((diagnostic) => [diagnostic.severity, diagnostic.pageId, diagnostic.routeIndex, diagnostic.message])).toEqual([
        ["warning", "start", 0, 'Route 1 of page "start" reads today(): the server judges it by its own clock, so a submission checked on another day may be judged differently.'],
        ["warning", "about", 0, 'Route 1 of page "about" reads today(): the server judges it by its own clock, so a submission checked on another day may be judged differently.']
      ]);
      expect(of(diagnostics, "rule.server-cannot-run")).toEqual([]);
    });
  });

  describe("calc.input-left-out through an if", () => {
    const costForm = (totalType: string): ComponentNode =>
      group("form", "form", [
        field("eligible", "radio"),
        field("cost", "number"),
        field("total", totalType, { configuration: { label: "total", required: true }, rules: { value: ifExpr([[fn("empty", path("cost")), lit(0)]], path("cost")) } })
      ]);

    it("is not raised for `if empty(cost) then 0 else cost` into a number (a branch comes to a value), and is raised on a checkbox (strict)", () => {
      expect(of(diagnoseJourney(costForm("number"), journeyOf(start)), "calc.input-left-out")).toEqual([]);
      const strict = of(diagnoseJourney(costForm("checkbox"), journeyOf(start)), "calc.input-left-out");
      expect(strict.map((diagnostic) => [diagnostic.severity, diagnostic.componentId, diagnostic.requiredField])).toEqual([["error", "cost", "total"]]);
      // Every branch wanting the input: raised in either mode.
      const both = group("form", "form", [
        field("eligible", "radio"),
        field("cost", "number"),
        field("total", "number", { configuration: { label: "total", required: true }, rules: { value: ifExpr([[eq("eligible", "yes"), times2("cost")]], path("cost")) } })
      ]);
      expect(of(diagnoseJourney(both, journeyOf(start)), "calc.input-left-out").map((diagnostic) => diagnostic.componentId)).toEqual(["cost"]);
    });
  });

  describe("run scopes", () => {
    const staff = eq("host.role", "staff");

    it("rule.server-cannot-run: an error for a server-only rule reading host., a warning for one reading only the clock; no rule.reads-host or rule.reads-clock beside them", () => {
      const form = group("form", "form", [
        field("eligible", "radio"),
        field("name", "text", { rules: { visibleWhen: scoped(staff, "server") } }),
        field("email", "text", { rules: { requiredWhen: scoped(isToday("2026-01-01"), "server-secret") } })
      ]);
      const diagnostics = diagnoseJourney(form, journeyOf(start, about));
      expect(of(diagnostics, "rule.server-cannot-run").map((diagnostic) => [diagnostic.severity, diagnostic.componentId, diagnostic.message])).toEqual([
        [
          "error",
          "name",
          "The visibility rule of name runs on the server only and reads host.role, which the server does not have, so it never runs: name behaves as if it had no visibility rule."
        ],
        [
          "warning",
          "email",
          "The required rule of email runs on the server only and reads today(): it runs only when the host gives the server the day, and is skipped otherwise, as if email had no required rule."
        ]
      ]);
      expect(of(diagnostics, "rule.reads-host")).toEqual([]);
      expect(of(diagnostics, "rule.reads-clock")).toEqual([]);
    });

    it("rule.browser-only-required once for a browser-only required rule; a browser-only rule reading host. is no rule.reads-host", () => {
      const form = group("form", "form", [
        field("eligible", "radio"),
        field("name", "text", { rules: { visibleWhen: scoped(staff, "browser"), requiredWhen: scoped(eq("eligible", "yes"), "browser") } }),
        field("email")
      ]);
      const diagnostics = diagnoseJourney(form, journeyOf(start, about));
      expect(of(diagnostics, "rule.browser-only-required").map((diagnostic) => [diagnostic.severity, diagnostic.componentId, diagnostic.message])).toEqual([
        ["warning", "name", "The required rule of name runs in the browser only, so the server does not enforce it: a submission that skips the answer passes there."]
      ]);
      expect(of(diagnostics, "rule.reads-host")).toEqual([]);
      expect(of(diagnostics, "rule.server-cannot-run")).toEqual([]);
    });

    it("rule.secret-reads-browser-hidden once per field a secret rule reads that a browser-only rule may hide, through an ancestor too", () => {
      const form = group("form", "form", [
        field("eligible", "radio"),
        field("name", "text", { rules: { visibleWhen: scoped(eq("eligible", "yes"), "browser") } }),
        group("extra", "fieldset", [field("income", "number")], { rules: { visibleWhen: scoped(eq("eligible", "yes"), "browser") } }),
        field("email", "text", {
          rules: {
            value: scoped(fn("concat", path("name"), path("name"), path("income")), "server-secret"),
            requiredWhen: scoped(eq("name", "x"), "server-secret"),
            readonlyWhen: scoped(eq("name", "x"), "server")
          }
        })
      ]);
      const diagnostics = diagnoseJourney(form, journeyOf(start, about, money));
      expect(of(diagnostics, "rule.secret-reads-browser-hidden").map((diagnostic) => [diagnostic.severity, diagnostic.componentId, diagnostic.message])).toEqual([
        [
          "warning",
          "email",
          "The secret required rule of email reads name, which a browser-only rule may hide: the server, which never runs that rule, reads the answer the browser kept or dropped by name's hidden-value behaviour."
        ],
        [
          "warning",
          "email",
          "The secret calculation of email reads income, which a browser-only rule may hide (through extra): the server, which never runs that rule, reads the answer the browser kept or dropped by income's hidden-value behaviour."
        ]
      ]);
    });
  });

  describe("string rules", () => {
    it("a formula rule is diagnosed as its tree is, with the same words", () => {
      const asTree = group("form", "form", [field("eligible", "radio"), field("name", "text", { rules: { visibleWhen: eq("host.region", "north") } }), field("email")]);
      const asText = group("form", "form", [field("eligible", "radio"), field("name", "text", { rules: { visibleWhen: formula('host.region = "north"') } }), field("email")]);
      const asObject = group("form", "form", [
        field("eligible", "radio"),
        field("name", "text", { rules: { visibleWhen: { formula: 'host.region = "north"', run: "both" } as unknown as Expression } }),
        field("email")
      ]);
      const expected = of(diagnoseJourney(asTree, journeyOf(start, about)), "rule.reads-host");
      expect(expected.map((diagnostic) => diagnostic.message)).toEqual([
        "The visibility rule of name reads host.region, which a server checking the submission does not have, so the server treats name as shown."
      ]);
      expect(diagnoseJourney(asText, journeyOf(start, about))).toEqual(diagnoseJourney(asTree, journeyOf(start, about)));
      expect(diagnoseJourney(asObject, journeyOf(start, about))).toEqual(diagnoseJourney(asTree, journeyOf(start, about)));
    });

    it("a formula condition that does not parse is condition.invalid; one that parses reads its fields as a tree does", () => {
      const broken = diagnoseJourney(tree, journeyOf({ ...start, routes: [{ when: formula("eligible = "), to: "money" }] }, about, money));
      expect(of(broken, "condition.invalid").map((diagnostic) => [diagnostic.pageId, diagnostic.message])).toEqual([
        ["start", 'Route 1 of page "start" is not a condition the engine can evaluate, or a formula that does not parse.']
      ]);
      const fine = diagnoseJourney(tree, journeyOf({ ...start, routes: [{ when: formula("ghost = 1 and today() > start"), to: "money" }] }, about, money));
      expect(of(fine, "condition.invalid")).toEqual([]);
      expect(of(fine, "condition.unknown-field").map((diagnostic) => diagnostic.message)).toEqual([
        'Route 1 of page "start" reads ghost, which is not a component of the form, so it always reads as unanswered.',
        'Route 1 of page "start" reads start, which is not a component of the form, so it always reads as unanswered.'
      ]);
      expect(of(fine, "condition.reads-clock")).toHaveLength(1);
    });
  });
});

describe("browser-only rules the server skips", () => {
  const rooted = (...children: ComponentNode[]): ComponentNode => group("form", "form", children);
  const browser = (formula: string) => ({ formula, run: "browser" }) as never;
  const codesOf = (root: ComponentNode, journey?: unknown): string[] =>
    diagnoseJourneys({ root, ...(journey !== undefined ? { journey } : {}) }).map((diagnostic) => `${diagnostic.code}@${diagnostic.componentId ?? "-"}`);

  it("a form without a journey reports a browser-only requiredWhen", () => {
    const root = rooted(field("a"), field("b", "text", { rules: { requiredWhen: browser('a = "x"') } }));
    expect(codesOf(root)).toEqual(["rule.browser-only-required@b"]);
  });

  it("a required field with a browser-only visibleWhen is reported, with and without a journey", () => {
    const root = rooted(field("a"), field("b", "text", { configuration: { required: true }, rules: { visibleWhen: browser('a = "x"') } }));
    const journey = { journeys: [{ id: "j", pages: [{ id: "p1", components: ["a", "b"] }] }] };
    expect(codesOf(root)).toEqual(["rule.browser-only-visibility@b"]);
    expect(codesOf(root, journey)).toContain("rule.browser-only-visibility@b");
  });

  it("an ancestor's browser-only visibleWhen is named through the ancestor, and an optional field is not reported", () => {
    const root = rooted(
      field("a"),
      group("box", "fieldset", [field("b", "text", { configuration: { required: true } }), field("c")], { rules: { visibleWhen: browser('a = "x"') } })
    );
    const found = diagnoseJourneys({ root });
    expect(found.map((diagnostic) => diagnostic.componentId)).toEqual(["b"]);
    expect(found[0]?.message).toContain("through box");
  });

  it("a server-run or absent visibleWhen reports nothing", () => {
    const root = rooted(field("a"), field("b", "text", { configuration: { required: true }, rules: { visibleWhen: { formula: 'a = "x"' } as never } }));
    expect(codesOf(root)).toEqual([]);
  });
});

// The diagnostics' recursive expression walks (`emptyFor`,
// `expressionShape`) read a left-deep chain with an explicit stack, as the evaluator and the
// dependency walk already do; a 20,000-term chain costs no call-stack depth.
describe("a 20,000-term chain in a journey", () => {
  const TERMS = 20_000;
  function chain(kind: "logical" | "arithmetic", from = "eligible"): Expression {
    let expression: Expression = path(from);
    for (let at = 0; at < TERMS; at += 1) {
      expression =
        kind === "logical"
          ? { kind: "logical", operator: "or", left: expression, right: eq("eligible", "no") }
          : { kind: "arithmetic", operator: "add", left: expression, right: { kind: "literal", value: 1 } };
    }
    return expression;
  }

  it("a route condition of 20,000 terms is diagnosed without overflowing", () => {
    const diagnostics = diagnoseJourney(tree, journeyOf({ ...start, routes: [{ when: chain("logical"), to: "stop" }] }, about, money, { id: "stop", kind: "exit", title: "Stop" }));
    expect(codes(diagnostics)).not.toContain("condition.invalid");
  });

  it("a required calculation of 20,000 terms names the input it is empty for, in the same order", () => {
    const wider = group("form", "form", [
      field("eligible", "radio"),
      field("name"),
      field("total", "number", { configuration: { label: "total", required: true }, rules: { value: chain("arithmetic", "name") } })
    ]);
    const diagnostics = diagnoseJourney(wider, journeyOf(start));
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "calc.input-left-out").map((diagnostic) => diagnostic.componentId)).toEqual(["name"]);
  });
});

describe("diagnoseJourney: Check answers pages", () => {
  const check: JourneyPage = { id: "check", kind: "review", title: "Check your answers" };
  const bye: JourneyPage = { id: "bye-page", kind: "exit", title: "Sorry", components: ["bye"] };
  const codes = (journey: Journey): JourneyDiagnostic[] => diagnoseJourney(tree, journey).filter((entry) => entry.code.startsWith("page.review-"));
  const everything = (journey: Journey): string[] => diagnoseJourney(tree, journey).map((entry) => entry.code);

  it("finds nothing wrong with one review page at the end, ending pages after it", () => {
    const start2: JourneyPage = { ...start, routes: [{ when: eq("eligible", "no"), to: "bye-page" }] };
    const journey = journeyOf(start2, about, money, check, bye);
    expect(codes(journey)).toEqual([]);
    // Never called unreachable or without an end, though it holds nothing.
    const all = everything(journey);
    expect(all).not.toContain("page.unreachable");
    expect(all).not.toContain("journey.no-end");
  });

  it("calls a second review page an error", () => {
    const again: JourneyPage = { id: "again", kind: "review", title: "Check again" };
    expect(codes(journeyOf(start, check, about, again))).toEqual([
      expect.objectContaining({ severity: "error", code: "page.review-not-last", pageId: "check", pageIndex: 1 }),
      expect.objectContaining({ severity: "error", code: "page.review-repeated", pageId: "again", pageIndex: 3 })
    ]);
  });

  it("calls a review page with a questions page after it an error, and the walk passes that page by", () => {
    const found = codes(journeyOf(start, check, about));
    expect(found).toEqual([expect.objectContaining({ severity: "error", code: "page.review-not-last", pageId: "check", pageIndex: 1 })]);
    expect(found[0]!.message).toContain('"about"');
    // The walk ends at it, so the page after it is reached by no path.
    expect(everything(journeyOf(start, check, about))).toContain("page.unreachable");
  });

  it("calls a route on a review page an error unless it goes to the end", () => {
    const routed: JourneyPage = { ...check, routes: [{ to: "$end" }, { when: eq("eligible", "no"), to: "bye-page" }] };
    expect(codes(journeyOf(start, about, routed, bye))).toEqual([
      expect.objectContaining({ severity: "error", code: "page.review-not-last", pageId: "check", routeIndex: 1 })
    ]);
  });

  it("warns of a route to the end that submits without passing the review page", () => {
    const early: JourneyPage = { ...start, routes: [{ when: eq("eligible", "no"), to: "$end" }] };
    const found = codes(journeyOf(early, about, money, check, bye));
    expect(found).toEqual([expect.objectContaining({ severity: "warning", code: "page.review-bypassed", pageId: early.id, pageIndex: 0, routeIndex: 0 })]);
    expect(found[0]!.message).toContain('"check"');
    // A route to the review page itself, or one to an ending, passes nothing by.
    expect(codes(journeyOf({ ...start, routes: [{ when: eq("eligible", "no"), to: "check" }] }, about, money, check, bye))).toEqual([]);
    expect(codes(journeyOf({ ...start, routes: [{ when: eq("eligible", "no"), to: "bye-page" }] }, about, money, check, bye))).toEqual([]);
    // A route after an unconditional one is never taken, so it is not named.
    expect(codes(journeyOf({ ...start, routes: [{ to: "check" }, { to: "$end" }] }, about, money, check, bye))).toEqual([]);
  });

  it("calls a page with nothing on it after it an error too: every page is shown, an empty one included", () => {
    const empty: JourneyPage = { id: "nothing", title: "Nothing", components: [] };
    expect(codes(journeyOf(start, check, empty, bye))).toEqual([expect.objectContaining({ severity: "error", code: "page.review-not-last", pageId: "check", pageIndex: 1 })]);
  });

  it("calls a form field placed on it an error: listed, referenced, filled or worked out", () => {
    const placing: JourneyPage = {
      ...check,
      components: [
        "name",
        { type: "journey-field", configuration: { componentId: "email" } },
        { id: "again", type: "text", configuration: { label: "Name again", fills: "name" } },
        { id: "declare", type: "checkbox", configuration: { label: "I confirm" } }
      ] as JourneyPageEntry[]
    };
    const found = codes(journeyOf(start, about, money, placing));
    expect(found.map((entry) => [entry.code, entry.componentId ?? entry.entryId])).toEqual([
      ["page.review-form-field", "name"],
      ["page.review-form-field", "email"],
      ["page.review-form-field", "again"]
    ]);
    expect(found.every((entry) => entry.severity === "error" && entry.pageId === "check")).toBe(true);
    // Its own content — the declaration — is fine.
    expect(diagnoseJourney(tree, journeyOf(start, about, money, { ...check, components: [{ id: "declare", type: "checkbox", configuration: { label: "I confirm" } }] as JourneyPageEntry[] })).filter((entry) => entry.severity === "error")).toEqual([]);
  });
});
