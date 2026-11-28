import { describe, expect, it } from "vitest";

import { diagnoseJourney, diagnoseJourneys, type JourneyDiagnostic } from "../form-engine/core/journey/journey-diagnostics.js";
import { journeyFormKeys, journeyOwnNodeRule, journeyOwnership, journeyTargetUsable } from "../form-engine/core/journey/journey-path.js";
import { validateJourneyShape, type Journey, type JourneyPage, type JourneyPageEntry, type PresentationNode } from "../form-engine/core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { runKernel as kernelRun } from "../form-engine/validation/wasm/portable-kernel.js";
import { buildJourneyMeta } from "../form-engine/render/core/journey-render.js";
import { APPLY_ABOVE, applyJourney, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";

// A host hands the kernel the function table's signatures, as the in-process and sandbox hosts
// do: a formula's calls are checked against them. These runs do the same.
const runKernel = (
  context: Parameters<typeof kernelRun>[0],
  validators: Parameters<typeof kernelRun>[1],
  functions?: Parameters<typeof kernelRun>[2],
  signatures: Parameters<typeof kernelRun>[3] = formulaFunctionSignatures(),
  cache?: Parameters<typeof kernelRun>[4]
): ReturnType<typeof kernelRun> => kernelRun(context, validators, functions, signatures, cache);

/**
 * The findings about a presentation's own nodes: every code the designer
 * for own nodes reads, where it is drawn (`ownNodeId`, `componentId`, `pageIndex`), and — for
 * each — that it says what the runtime and the kernel actually do: the shared ownership both
 * sides place by, the browser runtime's state and values, and the kernel's verdict.
 *
 * The fixture's form (`presentation-form.ts`): `email` (required), `name`, `annual_income` (a
 * required number inside the fieldset `money`), `approved_amount` (an optional number).
 */

function field(id: string, type = "text", extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type, configuration: { label: id }, ...extra };
}

function group(id: string, type: string, children: ComponentNode[], extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type, configuration: { label: id }, children: { content: children }, ...extra };
}

function read(name: string): string {
  return /^[A-Za-z_][\w.]*$/.test(name) ? name : `\`${name}\``;
}

function literal(value: string | number | boolean | null): string {
  return JSON.stringify(value);
}

function eq(path: string, value: string | number | boolean | null): string {
  return `${read(path)} = ${literal(value)}`;
}

function call(name: "sum" | "coalesce" | "concat", ...args: string[]): string {
  return `${name}(${args.join(", ")})`;
}

const own = (id: string, type = "text", configuration: Record<string, unknown> = { label: id }, extra: Record<string, unknown> = {}): JourneyPageEntry =>
  ({ id, type, configuration, ...extra }) as unknown as JourneyPageEntry;
const reference = (componentId: string): JourneyPageEntry => ({ type: "journey-field", configuration: { componentId } });
const workedOut = (id: string, to: string, value: string, extra: Record<string, unknown> = {}): JourneyPageEntry => own(id, "journey-value", { to, value }, extra);
const choices = (...values: string[]): Array<{ value: string; label: string }> => values.map((value) => ({ value, label: value }));

/** A journey `apply` of `pages`, then a page `rest` listing `rest` (by default the fields no worked-out value needs). */
function journeyOf(pages: JourneyPage[], rest: string[] = ["email", "name", "approved_amount"]): Journey {
  return { id: "apply", pages: [...pages, { id: "rest", title: "Rest", components: rest }] };
}

function page(id: string, ...components: JourneyPageEntry[]): JourneyPage {
  return { id, title: id, components };
}

function rootWith(...extra: ComponentNode[]): ComponentNode {
  const root = presentationRoot();
  root.children!.content!.push(...extra);
  return root;
}

function of(diagnostics: JourneyDiagnostic[], code: string): JourneyDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.code === code);
}

function only(diagnostics: JourneyDiagnostic[], code: string): JourneyDiagnostic {
  const found = of(diagnostics, code);
  expect(found, code).toHaveLength(1);
  return found[0] as JourneyDiagnostic;
}

function where(diagnostic: JourneyDiagnostic | undefined): Record<string, unknown> {
  const { severity, pageIndex, ownNodeId, componentId } = diagnostic ?? ({} as JourneyDiagnostic);
  return { severity, pageIndex, ownNodeId, componentId };
}

const envelope = { form: { id: "f", version: "1" }, client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" } };

/** The browser running `journey` over `root`, client side (the form's own field checks). */
function runtimeOf(root: ComponentNode, journey: Journey): FormRuntime {
  const form = { id: "f", version: "1", schemaVersion: "1", root, journey: { journeys: [journey] } } as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(root)]) });
}

/** What the browser sends: the values of an unvalidated submit. */
async function sent(runtime: FormRuntime): Promise<Record<string, unknown>> {
  return (await runtime.submit("send", envelope)).canonicalSubmission?.submission.values ?? {};
}

/** What the browser refuses on submit, and the kernel over what it sends: `componentId:code`, which must agree. */
async function refused(root: ComponentNode, journey: Journey, steps: (runtime: FormRuntime) => void): Promise<string[]> {
  const browser = runtimeOf(root, journey);
  steps(browser);
  const submitted = await browser.submit("submit", envelope);
  const kinds = browser.presentationIndex()?.kindOf ?? {};
  const keyed = (errors: ReadonlyArray<{ componentId?: string; code: string }>): string[] =>
    errors.filter((error) => error.componentId === undefined || !Object.hasOwn(kinds, error.componentId)).map((error) => `${error.componentId ?? "-"}:${error.code}`);
  const values = await sent(browser);
  const server = runKernel({ formId: "f", values, locale: "en", form: root, journey }, []);
  expect(keyed(server.errors)).toEqual(keyed(submitted.errors));
  return keyed(submitted.errors);
}

/** Types an answer into an own field (or an alias) where the runtime keeps it. */
function answer(runtime: FormRuntime, ownId: string, value: unknown): void {
  runtime.setValue(runtime.presentationValuePathOf(ownId) as string, value);
}

describe("ownNodeId: a finding about a node of the journey's own names it", () => {
  const OWN_CODES = [
    "presentation.entry-unusable",
    "field.id-clash",
    "field.unsupported-type",
    "field.data-binding",
    "map.unknown-target",
    "map.target-unusable",
    "map.target-conflict",
    "map.shape-mismatch",
    "map.options-not-subset",
    "map.reads-other-page",
    "map.sources-conditional",
    "map.target-hidden",
    "own.hides-form-field",
    "field.goes-nowhere",
    "rule.unknown-field"
  ];

  it("on every finding about an own node, at its position; never on one about a page, a route or a form component", () => {
    const root = rootWith(field("secret", "text", { configuration: { label: "Secret", hidden: true } }), field("pick", "radio", { configuration: { label: "Pick", options: choices("a", "b") } }));
    const journey = journeyOf([
      page(
        "first",
        own("loose", "number"),
        own("upload", "file"),
        own("shown_when", "text", { label: "Shown when", fills: "name" }, { rules: { visibleWhen: eq("approved_amount", 1) } }),
        own("box", "fieldset", { label: "Box" }, { children: { content: [reference("ghost"), own("alt", "number", { label: "Alt", fills: "secret" })] } }),
        own("pick_alias", "radio", { label: "Pick", fills: "pick", options: choices("a", "c") }),
        own("note", "html", { content: "<p>Hi</p>" }, { rules: { visibleWhen: eq("nobody", 1) } })
      )
    ]);
    journey.pages[0]!.routes = [{ when: eq("loose", 1), to: "rest" }];
    expect(validateJourneyShape(journey)).toEqual([]);
    const diagnostics = diagnoseJourney(root, journey);
    const ownIds = new Set(["loose", "upload", "shown_when", "box", "alt", "pick_alias", "note"]);
    const about = diagnostics.filter((diagnostic) => OWN_CODES.includes(diagnostic.code));
    expect(new Set(about.map((diagnostic) => diagnostic.code))).toEqual(
      new Set(["field.unsupported-type", "own.hides-form-field", "map.target-hidden", "map.shape-mismatch", "map.options-not-subset", "field.goes-nowhere", "rule.unknown-field"])
    );
    for (const diagnostic of about) {
      expect(ownIds.has(diagnostic.ownNodeId as string), diagnostic.code).toBe(true);
      expect(diagnostic.pageIndex, diagnostic.code).toBe(0);
      expect(diagnostic.pageId, diagnostic.code).toBe("first");
    }
    // A reference in an own layout: the layout that holds it, with the form component it names.
    expect(where(only(diagnostics, "page.unknown-component"))).toEqual({ severity: "error", pageIndex: 0, ownNodeId: "box", componentId: "ghost" });
    // About the route, or a form component: no own node.
    for (const code of ["condition.reads-presentation-field", "component.unassigned"]) {
      for (const diagnostic of of(diagnostics, code)) {
        expect(diagnostic.ownNodeId, code).toBeUndefined();
      }
    }
    expect(of(diagnostics, "condition.reads-presentation-field")).toHaveLength(1);
  });

  it("a reference in an own layout to a field of each entry of a section: page.entry-field on the layout", () => {
    const root = rootWith(group("people", "panel", [field("person")], { collection: { collectionPath: "people", itemFields: ["person"] } }));
    const journey = journeyOf([page("first", own("box", "fieldset", { label: "Box" }, { children: { content: [own("inner", "columns", { label: "Inner" }, { children: { content: [reference("person")] } })] } }))], [
      "email",
      "name",
      "money",
      "approved_amount",
      "people"
    ]);
    expect(where(only(diagnoseJourney(root, journey), "page.entry-field"))).toEqual({ severity: "warning", pageIndex: 0, ownNodeId: "inner", componentId: "person" });
  });
});

describe("field.id-clash, field.unsupported-type, field.data-binding: what a page cannot hold as its own", () => {
  it("field.id-clash on a page's id or the designer's prefix is an error the runtime does not share: the node is still drawn", () => {
    for (const id of ["rest", "journey", "journey-field_1"]) {
      const journey = journeyOf([page("first", own(id, "html", { content: "<p>Hi</p>" }))]);
      const diagnostics = diagnoseJourney(presentationRoot(), journey);
      const clash = only(diagnostics, "field.id-clash");
      expect(where(clash), id).toEqual({ severity: "error", pageIndex: 0, ownNodeId: id, componentId: undefined });
      // Not a usability rule: both sides keep the node.
      expect(clash.rule, id).toBeUndefined();
      expect(journeyOwnership(presentationRoot(), journey).membersOf.first, id).toEqual([id]);
      expect(runtimeOf(presentationRoot(), journey).presentationIndex()?.kindOf[id], id).toBe("content");
    }
    expect(only(diagnoseJourney(presentationRoot(), journeyOf([page("first", own("rest", "html", { content: "<p>Hi</p>" }))])), "field.id-clash").message).toBe(
      'rest on page "first" has the id of a page of the journey ("rest"); a node of the journey\'s own needs an id no page has, as the texts of both are translated by their id.'
    );
    expect(only(diagnoseJourney(presentationRoot(), journeyOf([page("first", own("journey-page_2", "html", { content: "<p>Hi</p>" }))])), "field.id-clash").message).toBe(
      'journey-page_2 on page "first" has an id starting with "journey", which the designer keeps for its own nodes; give it another id.'
    );
    // "journeys" is not the prefix.
    expect(of(diagnoseJourney(presentationRoot(), journeyOf([page("first", own("journeys", "html", { content: "<p>Hi</p>" }))])), "field.id-clash")).toEqual([]);
  });

  it("field.id-clash on a form id or an earlier own id fires exactly when the shared rule A drops the entry", () => {
    const journey = journeyOf([page("first", own("seen", "html", { content: "x" }), own("name", "html", { content: "x" }), own("seen", "html", { content: "y" }))]);
    const diagnostics = diagnoseJourney(presentationRoot(), journey);
    expect(of(diagnostics, "field.id-clash").map((diagnostic) => [diagnostic.ownNodeId, diagnostic.rule])).toEqual([
      ["name", "A"],
      ["seen", "A"]
    ]);
    expect(journeyOwnership(presentationRoot(), journey).membersOf.first).toEqual(["seen"]);
  });

  it("field.unsupported-type fires exactly when the shared rule says B, and the runtime draws nothing of the entry", () => {
    for (const type of ["repeatingSection", "dataGrid", "file", "signature", "steps", "step", "wizard", "wizardStep", "text", "fieldset", "html"]) {
      const node = own("thing", type, { label: "Thing" }) as unknown as PresentationNode;
      const rule = journeyOwnNodeRule(node, journeyFormIds(), Object.create(null) as Record<string, true>, "apply", journeyFormKeys(presentationRoot()));
      const journey = journeyOf([page("first", node as unknown as JourneyPageEntry, own("words", "html", { content: "x" }))]);
      const diagnostics = diagnoseJourney(presentationRoot(), journey);
      expect(of(diagnostics, "field.unsupported-type").length, type).toBe(rule === "B" ? 1 : 0);
      expect(journeyOwnership(presentationRoot(), journey).membersOf.first?.includes("thing"), type).toBe(rule !== "B");
      expect(runtimeOf(presentationRoot(), journey).presentationIndex()?.nodeById.thing === undefined, type).toBe(rule === "B");
    }
  });

  it("field.data-binding fires exactly when the shared rule says C", () => {
    const cases: Array<[string, JourneyPageEntry]> = [
      ["a data key", own("bound", "text", { label: "Bound", dataKey: "x" })],
      ["a collection", own("bound", "panel", { label: "Bound" }, { collection: { collectionPath: "x" }, children: { content: [] } })],
      ["a container that scopes data", own("bound", "container", { label: "Bound" }, { children: { content: [] } })],
      ["a container that does not", own("bound", "container", { label: "Bound", scopeData: false }, { children: { content: [own("inside", "html", { content: "x" })] } })]
    ];
    for (const [name, entry] of cases) {
      const rule = journeyOwnNodeRule(entry as unknown as PresentationNode, journeyFormIds(), Object.create(null) as Record<string, true>, "apply", journeyFormKeys(presentationRoot()));
      const journey = journeyOf([page("first", entry, own("words", "html", { content: "x" }))]);
      const diagnostics = diagnoseJourney(presentationRoot(), journey);
      expect(of(diagnostics, "field.data-binding").map((diagnostic) => [diagnostic.ownNodeId, diagnostic.rule]), name).toEqual(rule === "C" ? [["bound", "C"]] : []);
      expect(journeyOwnership(presentationRoot(), journey).membersOf.first?.includes("bound"), name).toBe(rule !== "C");
    }
  });
});

describe("presentation.entry-unusable and a reference in an own layout naming nothing: what the remaining rules ignore", () => {
  it("rules A (an id outside the grammar), H and I drop the entry on both sides; rule F leaves the node content; rule D skips the reference alone", () => {
    const keyed = rootWith(group("rows", "repeatingSection", [field("sku")], { collection: { collectionPath: "@apply.items" } }));
    const cases: Array<[string, ComponentNode, Journey, string, string | undefined]> = [
      ["A", presentationRoot(), journeyOf([page("first", own("2nd", "html", { content: "x" }), own("fine", "html", { content: "x" }))]), "2nd", undefined],
      ["H", presentationRoot(), { ...journeyOf([page("first", own("fine", "html", { content: "x" }))]), id: "staff view" }, "fine", undefined],
      ["I", keyed, journeyOf([page("first", own("items", "textarea"), own("fine", "html", { content: "x" }))]), "items", undefined],
      ["F", presentationRoot(), journeyOf([page("first", own("words", "html", { content: "x", fills: "name" }))]), "words", "content"]
    ];
    for (const [rule, root, journey, id, kind] of cases) {
      const finding = only(diagnoseJourney(root, journey), "presentation.entry-unusable");
      expect([finding.severity, finding.rule, finding.ownNodeId, finding.entryId], rule).toEqual(["error", rule, id, id]);
      const ownership = journeyOwnership(root, journey);
      expect(ownership.membersOf.first?.includes(id) ?? false, rule).toBe(kind !== undefined);
      expect(ownership.aliasOf?.[id], rule).toBeUndefined();
      expect(runtimeOf(root, journey).presentationIndex()?.kindOf[id], rule).toBe(kind);
    }
    const dangling = journeyOf([page("first", own("box", "fieldset", { label: "Box" }, { children: { content: [reference("ghost"), reference("approved_amount")] } }))], ["email", "name", "money"]);
    const finding = only(diagnoseJourney(presentationRoot(), dangling), "page.unknown-component");
    expect({ ...where(finding), rule: finding.rule }).toEqual({ severity: "error", pageIndex: 0, ownNodeId: "box", componentId: "ghost", rule: "D" });
    expect(journeyOwnership(presentationRoot(), dangling).pagesOf.approved_amount).toEqual(["first"]);
    const index = runtimeOf(presentationRoot(), dangling).presentationIndex();
    expect(Object.values(index?.referenceOf ?? {}).map((placeholder) => placeholder.componentId)).toEqual(["approved_amount"]);
  });
});

/** The form's component ids, as the shared rules read them. */
function journeyFormIds(): Record<string, unknown> {
  const ids = Object.create(null) as Record<string, unknown>;
  const stack = [presentationRoot()];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    ids[node.id] = node;
    for (const group of Object.values(node.children ?? {})) {
      stack.push(...group);
    }
  }
  return ids;
}

describe("map.unknown-target, map.target-unusable, map.target-conflict: what an alias fills and a worked-out value sets", () => {
  const targets = (): ComponentNode =>
    rootWith(
      field("words", "html"),
      field("total", "number", { rules: { value: literal(1) } }),
      group("people", "panel", [field("person")], { collection: { collectionPath: "people", itemFields: ["person"] } }),
      // A data grid as every reader reads it: a section bound at its collection path.
      { id: "grid", type: "dataGrid", configuration: { label: "Grid" }, collection: { collectionPath: "rows" }, children: { columns: [field("cell")] } }
    );
  const candidates = ["ghost", "form", "money", "words", "total", "person", "cell", "approved_amount", "name"];

  it("an alias's target: a finding exactly when the shared ownership ignores the alias, and its answer then stays at its @ key", () => {
    for (const target of candidates) {
      const root = targets();
      const journey = journeyOf([page("first", own("alt", "text", { label: "Alt", fills: target }))], ["email", "money"]);
      const diagnostics = diagnoseJourney(root, journey);
      const ownership = journeyOwnership(root, journey);
      const used = ownership.aliasOf?.alt === target;
      const found = [...of(diagnostics, "map.unknown-target"), ...of(diagnostics, "map.target-unusable")];
      expect(found.length, target).toBe(used ? 0 : 1);
      if (!used) {
        expect(found[0]?.code, target).toBe(target === "ghost" ? "map.unknown-target" : "map.target-unusable");
        expect({ ...where(found[0]), rule: found[0]?.rule }, target).toEqual({ severity: "error", pageIndex: 0, ownNodeId: "alt", componentId: target, rule: "E" });
      }
      expect(used, target).toBe(journeyTargetUsable(target, journeyFormIds2(root), parentsOf(root), "form"));
      const runtime = runtimeOf(root, journey);
      expect(runtime.presentationValuePathOf("alt"), target).toBe(used ? target : "@apply.alt");
    }
  });

  it("a worked-out value's target: a finding exactly when the shared ownership ignores it", () => {
    for (const target of candidates) {
      const root = targets();
      const journey = journeyOf([page("first", own("m1", "number"), workedOut("sum", target, read("m1")))], ["email", "money"]);
      const diagnostics = diagnoseJourney(root, journey);
      const used = journeyOwnership(root, journey).workedOutOf?.sum === target;
      const found = diagnostics.filter((diagnostic) => diagnostic.code.startsWith("map.") && diagnostic.ownNodeId === "sum" && diagnostic.rule !== undefined);
      expect(found.map((diagnostic) => diagnostic.code), target).toEqual(
        used ? [] : [target === "ghost" ? "map.unknown-target" : candidates.indexOf(target) < 7 ? "map.target-unusable" : "map.target-conflict"]
      );
      expect(runtimeOf(root, journey).presentationIndex()?.workedOutOf.sum?.targetId, target).toBe(used ? target : undefined);
    }
  });

  it("map.target-conflict: the later of two worked-out values, and a worked-out value beside an alias of its field — before it or after, on any page", () => {
    const twice = journeyOf([page("first", own("m1", "number"), workedOut("one", "annual_income", read("m1"))), page("second", own("m2", "number"), workedOut("two", "annual_income", read("m2")))]);
    const diagnostics = diagnoseJourney(presentationRoot(), twice);
    expect({ ...where(only(diagnostics, "map.target-conflict")), rule: only(diagnostics, "map.target-conflict").rule }).toEqual({
      severity: "error",
      pageIndex: 1,
      ownNodeId: "two",
      componentId: "annual_income",
      rule: "G"
    });
    expect({ ...journeyOwnership(presentationRoot(), twice).workedOutOf }).toEqual({ one: "annual_income" });

    const aliasAfter = journeyOf([page("first", own("m1", "number"), workedOut("one", "annual_income", read("m1"))), page("second", own("typed", "number", { label: "Income", fills: "annual_income" }))]);
    const conflict = only(diagnoseJourney(presentationRoot(), aliasAfter), "map.target-conflict");
    expect(where(conflict)).toEqual({ severity: "error", pageIndex: 0, ownNodeId: "one", componentId: "annual_income" });
    expect(conflict.message).toBe('one on page "first" works out annual_income, which typed already fills, so it is ignored: a worked-out field must be placed by nothing else.');
    expect({ ...journeyOwnership(presentationRoot(), aliasAfter).workedOutOf }).toEqual({});
    expect({ ...journeyOwnership(presentationRoot(), aliasAfter).aliasOf }).toEqual({ typed: "annual_income" });
  });
});

function journeyFormIds2(root: ComponentNode): Record<string, ComponentNode> {
  const ids = Object.create(null) as Record<string, ComponentNode>;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    ids[node.id] = node;
    for (const group of Object.values(node.children ?? {})) {
      stack.push(...group);
    }
  }
  return ids;
}

function parentsOf(root: ComponentNode): Record<string, string> {
  const parents = Object.create(null) as Record<string, string>;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        parents[child.id] = node.id;
        stack.push(child);
      }
    }
  }
  return parents;
}

describe("map.shape-mismatch and map.options-not-subset: an answer of another kind", () => {
  const typed = (): ComponentNode =>
    rootWith(
      field("start", "date"),
      field("agree", "checkbox"),
      field("colour", "radio", { configuration: { label: "Colour", options: choices("red", "blue") } }),
      field("toppings", "checkboxes", { configuration: { label: "Toppings", options: choices("cheese", "ham") } }),
      field("sourced", "select", { configuration: { label: "Sourced", data: { sourceId: "towns" } } })
    );
  const rest = ["email", "name", "money", "approved_amount", "start", "agree", "colour", "toppings", "sourced"];

  it("an alias of another shape than its field: an error, for every pair the shapes rule out", () => {
    const pairs: Array<[string, string, boolean]> = [
      ["text", "annual_income", true],
      ["number", "annual_income", false],
      ["number", "name", true],
      ["select", "name", false],
      ["date", "name", false],
      ["text", "start", true],
      ["date", "start", false],
      ["checkbox", "name", true],
      ["checkbox", "agree", false],
      ["text", "colour", true],
      ["select", "colour", false],
      ["radio", "toppings", true],
      ["checkboxes", "toppings", false],
      ["my-plugin-type", "name", false]
    ];
    for (const [type, target, mismatch] of pairs) {
      const journey = journeyOf([page("first", own("alias", type, { label: "Alias", fills: target }))], rest.filter((id) => id !== target));
      const diagnostics = diagnoseJourney(typed(), journey);
      expect(of(diagnostics, "map.shape-mismatch").map(where), `${type} -> ${target}`).toEqual(mismatch ? [{ severity: "error", pageIndex: 0, ownNodeId: "alias", componentId: target }] : []);
    }
    const message = only(diagnoseJourney(typed(), journeyOf([page("first", own("typed_income", "text", { label: "Income", fills: "annual_income" }))], ["email", "name", "approved_amount"])), "map.shape-mismatch").message;
    expect(message).toBe(
      'typed_income on page "first" asks for text but fills annual_income, which holds a number: the answer is stored as given, so annual_income gets an answer of another kind, which the form refuses unless it is a number. Make typed_income the same kind of field as annual_income.'
    );
  });

  it("parity: what a text alias of a number field takes is stored as typed, and both sides refuse it", async () => {
    const journey = journeyOf([page("first", own("typed_income", "text", { label: "Income", fills: "annual_income" }))], ["email", "name", "approved_amount"]);
    expect(
      await refused(presentationRoot(), journey, (runtime) => {
        runtime.setValue("email", "ada@example.org");
        answer(runtime, "typed_income", "about forty thousand");
      })
    ).toEqual(["annual_income:number"]);
  });

  it("a worked-out value whose expression comes to another shape than its field: an error, read from the expression", () => {
    const cases: Array<[string, string, string, boolean]> = [
      ["a sum into a number", "annual_income", call("sum", read("m1"), read("m2")), false],
      ["a sum into text", "name", call("sum", read("m1"), read("m2")), true],
      ["a concatenation into a number", "annual_income", call("concat", read("m1"), read("m2")), true],
      ["a comparison into a number", "annual_income", "m1 > 1", true],
      ["a comparison into a tick", "agree", "m1 > 1", false],
      ["a copy of a number field into a number", "annual_income", read("m1"), false],
      ["a copy of a text field into a number", "annual_income", read("note"), true],
      ["a coalesce of mixed shapes: cannot tell", "annual_income", call("coalesce", read("note"), read("m1")), false]
    ];
    for (const [name, target, value, mismatch] of cases) {
      const journey = journeyOf(
        [page("first", own("m1", "number"), own("m2", "number"), own("note", "text"), workedOut("result", target, value))],
        rest.filter((id) => id !== target && !(target === "annual_income" && id === "money"))
      );
      const diagnostics = diagnoseJourney(typed(), journey);
      expect(of(diagnostics, "map.shape-mismatch").map(where), name).toEqual(mismatch ? [{ severity: "error", pageIndex: 0, ownNodeId: "result", componentId: target }] : []);
    }
  });

  it("parity: a concatenation worked out into a number field is written as text, and both sides refuse it", async () => {
    const journey = journeyOf([page("first", own("a", "text"), own("b", "text"), workedOut("joined", "annual_income", call("concat", read("a"), read("b"))))], ["email", "name", "approved_amount"]);
    expect(of(diagnoseJourney(presentationRoot(), journey), "map.shape-mismatch")).toHaveLength(1);
    expect(
      await refused(presentationRoot(), journey, (runtime) => {
        runtime.setValue("email", "ada@example.org");
        answer(runtime, "a", "4");
        answer(runtime, "b", "x");
      })
    ).toEqual(["annual_income:number"]);
  });

  it("map.options-not-subset: a choice alias offering a choice its field does not have; none for a subset, a list from a data source, or another shape", () => {
    const cases: Array<[string, JourneyPageEntry, string[]]> = [
      ["a choice too many", own("pick", "radio", { label: "Pick", fills: "colour", options: choices("red", "green", "teal") }), ["green", "teal"]],
      ["a subset", own("pick", "select", { label: "Pick", fills: "colour", options: choices("blue") }), []],
      ["a list of ticks", own("pick", "checkboxes", { label: "Pick", fills: "toppings", options: choices("ham", "pineapple") }), ["pineapple"]],
      ["the field's list comes from a data source", own("pick", "select", { label: "Pick", fills: "sourced", options: choices("anything") }), []],
      ["another shape is said as such", own("pick", "radio", { label: "Pick", fills: "toppings", options: choices("olive") }), []]
    ];
    for (const [name, alias, extra] of cases) {
      const target = (alias as unknown as { configuration: { fills: string } }).configuration.fills;
      const journey = journeyOf([page("first", alias)], rest.filter((id) => id !== target));
      const diagnostics = diagnoseJourney(typed(), journey);
      const found = of(diagnostics, "map.options-not-subset");
      expect(found.map(where), name).toEqual(extra.length > 0 ? [{ severity: "error", pageIndex: 0, ownNodeId: "pick", componentId: target }] : []);
      for (const value of extra) {
        expect(found[0]?.message, name).toContain(`"${value}"`);
      }
    }
    expect(of(diagnoseJourney(typed(), journeyOf([page("first", own("pick", "radio", { label: "Pick", fills: "colour", options: choices("green") }))], rest.filter((id) => id !== "colour"))), "map.options-not-subset")[0]?.message).toBe(
      'pick on page "first" offers the choice "green", which colour does not have: a browser without the sandbox would send such an answer, but the server refuses it as option.notAllowed, and colour\'s own list cannot show it on the form, in a review or in a PDF. Keep the journey\'s list a subset of colour\'s options.'
    );
  });

  it("parity: an answer outside the field's list is sent by the browser, and refused by the kernel, which holds a choice to its options", async () => {
    const journey = journeyOf([page("first", own("pick", "radio", { label: "Pick", fills: "colour", options: choices("red", "green") }))], rest.filter((id) => id !== "colour"));
    const browser = runtimeOf(typed(), journey);
    browser.setValue("email", "ada@example.org");
    browser.setValue("annual_income", 10);
    answer(browser, "pick", "green");
    // The browser without a sandbox checks no option, and sends the answer as given.
    expect((await browser.submit("submit", envelope)).errors).toEqual([]);
    const values = await sent(browser);
    expect(values.colour).toBe("green");
    // The kernel holds colour to its own list: the server refuses what the alias offered.
    const server = runKernel({ formId: "f", values, locale: "en", form: typed(), journey }, []);
    expect(server.errors.map((error) => `${error.componentId ?? "-"}:${error.code}`)).toEqual(["colour:option.notAllowed"]);
  });
});

describe("map.reads-other-page and rule.unknown-field: what a worked-out value can read", () => {
  it("reading a form field or an own field of another page is an error; the browser reads its page's own fields alone", async () => {
    const journey = journeyOf(
      [
        page("first", own("bonus", "number"), own("work_email", "text", { label: "Work email", fills: "email" })),
        page("second", own("m1", "number"), own("name_alias", "text", { label: "Name", fills: "name" }), workedOut("total", "annual_income", call("sum", read("m1"), read("bonus"), read("approved_amount"), read("name"), read("ghost"))))
      ],
      ["approved_amount"]
    );
    const diagnostics = diagnoseJourney(presentationRoot(), journey);
    expect(of(diagnostics, "map.reads-other-page").map((diagnostic) => [diagnostic.severity, diagnostic.ownNodeId, diagnostic.componentId, diagnostic.pageIndex])).toEqual([
      ["error", "total", "annual_income", 1],
      ["error", "total", "annual_income", 1],
      ["error", "total", "annual_income", 1]
    ]);
    expect(of(diagnostics, "map.reads-other-page").map((diagnostic) => diagnostic.message)).toEqual([
      'total on page "second" works out annual_income from bonus, a field of page "first": a worked-out value reads only the journey\'s own fields on its page, so bonus always reads as unanswered there.',
      'total on page "second" works out annual_income from approved_amount, a form field: a worked-out value reads only the journey\'s own fields on its page, so approved_amount always reads as unanswered there.',
      'total on page "second" works out annual_income from name, a form field: a worked-out value reads only the journey\'s own fields on its page, so name always reads as unanswered there — read name_alias, which fills it on this page, instead.'
    ]);
    expect(where(only(diagnostics, "rule.unknown-field"))).toEqual({ severity: "warning", pageIndex: 1, ownNodeId: "total", componentId: "annual_income" });
    expect(only(diagnostics, "rule.unknown-field").message).toBe(
      'total on page "second" works out annual_income from ghost, which is neither a component of the form nor a field of journey "apply"\'s own, so it always reads as unanswered there.'
    );

    // The browser: what it reads is the page's own fields, and only they move the value.
    const runtime = runtimeOf(presentationRoot(), journey);
    expect(runtime.presentationIndex()?.workedOutOf.total?.sourceIds).toEqual(["m1", "name_alias"]);
    runtime.setValue("approved_amount", 1000);
    answer(runtime, "bonus", 500);
    answer(runtime, "m1", 7);
    expect(runtime.formValues().annual_income).toBe(7);
  });

  it("nothing for an expression over the page's own fields and aliases", () => {
    const fixture = diagnoseJourney(presentationRoot(), applyJourney());
    expect(of(fixture, "map.reads-other-page")).toEqual([]);
    expect(of(fixture, "rule.unknown-field")).toEqual([]);
  });
});

describe("map.sources-conditional: a required field worked out only from fields that may all be hidden", () => {
  const months = (m1Rule?: string, m2Rule?: string): Journey =>
    journeyOf(
      [
        page(
          "income",
          own("has_income", "checkbox", { label: "Any income?" }),
          own("m1", "number", { label: "Month 1" }, m1Rule !== undefined ? { rules: { visibleWhen: m1Rule } } : {}),
          own("m2", "number", { label: "Month 2" }, m2Rule !== undefined ? { rules: { visibleWhen: m2Rule } } : {}),
          workedOut("total", "annual_income", call("sum", read("m1"), read("m2")))
        )
      ],
      ["email", "name", "approved_amount"]
    );

  it("an error when every source read may be hidden; none while one always shows, or the field is optional", () => {
    const both = diagnoseJourney(presentationRoot(), months(eq("has_income", true), eq("has_income", true)));
    expect(where(only(both, "map.sources-conditional"))).toEqual({ severity: "error", pageIndex: 0, ownNodeId: "total", componentId: "annual_income" });
    expect(only(both, "map.sources-conditional").message).toBe(
      'annual_income is required by the form, and total on page "income" works it out from "m1" and "m2", each of which may be hidden: while they all are, nothing works annual_income out and the page shows it read-only, so the page cannot be passed. Let one of them always show, or ask annual_income on the page.'
    );
    expect(of(diagnoseJourney(presentationRoot(), months(eq("has_income", true))), "map.sources-conditional")).toEqual([]);
    const optional = presentationRoot();
    (optional.children!.content![2]!.children!.content![0]!.configuration as Record<string, unknown>).required = false;
    expect(of(diagnoseJourney(optional, months(eq("has_income", true), eq("has_income", true))), "map.sources-conditional")).toEqual([]);
    // The steering field is read by the sources' rules: it goes somewhere.
    expect(of(both, "field.goes-nowhere")).toEqual([]);
  });

  it("parity: with every source hidden nothing is worked out, and both sides refuse the required field", async () => {
    const journey = months(eq("has_income", true), eq("has_income", true));
    const steps = (ticked: boolean) => (runtime: FormRuntime): void => {
      runtime.setValue("email", "ada@example.org");
      answer(runtime, "has_income", ticked);
      answer(runtime, "m1", 100);
      answer(runtime, "m2", 200);
    };
    expect(await refused(presentationRoot(), journey, steps(false))).toEqual(["annual_income:required"]);
    expect(await refused(presentationRoot(), journey, steps(true))).toEqual([]);
  });
});

describe("own.hides-form-field and map.target-hidden: visibility that is not the own node's to decide", () => {
  const hiddenRoot = (): ComponentNode => rootWith(field("secret", "text", { configuration: { label: "Secret", hidden: true } }), field("maybe", "text", { rules: { visibleWhen: eq("name", "x") } }));

  it("own.hides-form-field: an alias, a worked-out value or a layout holding a reference with a visibility rule or set hidden — and the runtime shows it all the same", () => {
    const journey = journeyOf(
      [
        page(
          "first",
          own("work_email", "text", { label: "Work email", fills: "email" }, { rules: { visibleWhen: eq("name", "never") } }),
          own("box", "fieldset", { label: "Box", hidden: true }, { children: { content: [reference("approved_amount")] } }),
          own("m1", "number"),
          workedOut("total", "annual_income", read("m1"), { rules: { visibleWhen: eq("name", "never") } }),
          own("plain", "text", { label: "Plain" }, { rules: { visibleWhen: eq("name", "never") } })
        )
      ],
      ["name"]
    );
    const diagnostics = diagnoseJourney(presentationRoot(), journey);
    expect(of(diagnostics, "own.hides-form-field").map(where)).toEqual([
      { severity: "error", pageIndex: 0, ownNodeId: "work_email", componentId: "email" },
      { severity: "error", pageIndex: 0, ownNodeId: "box", componentId: "approved_amount" },
      { severity: "error", pageIndex: 0, ownNodeId: "total", componentId: "annual_income" }
    ]);
    expect(of(diagnostics, "own.hides-form-field")[1]?.message).toBe(
      'box on page "first" is set to be hidden, but it holds approved_amount, a form field: hiding it would hide a field the server still asks for, so the setting is ignored and it shows whenever its page does. Put the condition on the form field instead.'
    );
    const runtime = runtimeOf(presentationRoot(), journey);
    for (const id of ["work_email", "box", "total"]) {
      expect(runtime.effectiveState(id)?.visible, id).toBe(true);
    }
    // A plain own field's rule is its own to read: hidden, and nothing said.
    expect(runtime.effectiveState("plain")?.visible).toBe(false);
  });

  it("map.target-hidden: an alias or a worked-out value of a field hidden for good never shows — a warning; none for one a rule may show", () => {
    const journey = journeyOf(
      [page("first", own("alias", "text", { label: "Alias", fills: "secret" }), own("maybe_alias", "text", { label: "Maybe", fills: "maybe" }), own("m1", "number"), workedOut("worked", "secret", read("m1")))],
      ["email", "name", "money", "approved_amount"]
    );
    // The worked-out value is in conflict with the alias (rule G); give it a field of its own.
    const separate = journeyOf(
      [
        page("first", own("alias", "text", { label: "Alias", fills: "secret" }), own("maybe_alias", "text", { label: "Maybe", fills: "maybe" }), own("words", "html", { content: "<p>Hi</p>" })),
        page("second", own("m1", "number"), workedOut("worked", "hidden_total", read("m1")))
      ],
      ["email", "name", "money", "approved_amount"]
    );
    const root = rootWith(field("secret", "text", { configuration: { label: "Secret", hidden: true } }), field("maybe", "text", { rules: { visibleWhen: eq("name", "x") } }), field("hidden_total", "number", { configuration: { label: "Total", hidden: true } }));
    expect(of(diagnoseJourney(root, journey), "map.target-hidden").map((diagnostic) => diagnostic.ownNodeId)).toEqual(["alias"]);
    const diagnostics = diagnoseJourney(root, separate);
    expect(of(diagnostics, "map.target-hidden").map(where)).toEqual([
      { severity: "warning", pageIndex: 0, ownNodeId: "alias", componentId: "secret" },
      { severity: "warning", pageIndex: 1, ownNodeId: "worked", componentId: "hidden_total" }
    ]);
    const runtime = runtimeOf(root, separate);
    expect(journeyOwnership(root, separate).aliasOf?.alias).toBe("secret");
    // Both pages are on the path (each shows content of its own), and still neither node shows.
    expect(runtime.journeyView()?.path).toEqual(["first", "second", "rest"]);
    expect(runtime.effectiveState("alias")?.visible).toBe(false);
    expect(runtime.effectiveState("worked")?.visible).toBe(false);
    expect(runtime.effectiveState("words")?.visible).toBe(true);
  });
});

describe("field.goes-nowhere: an own field kept in the browser only", () => {
  it("a warning for a field that fills nothing and feeds nothing — and its answer is indeed never sent", async () => {
    const journey = journeyOf([page("first", own("nickname", "text", { label: "Nickname" }), own("m1", "number"), workedOut("total", "annual_income", read("m1")))], ["email", "name", "approved_amount"]);
    const diagnostics = diagnoseJourney(presentationRoot(), journey);
    expect(of(diagnostics, "field.goes-nowhere").map(where)).toEqual([{ severity: "warning", pageIndex: 0, ownNodeId: "nickname", componentId: undefined }]);
    expect(only(diagnostics, "field.goes-nowhere").message).toBe(
      'nickname on page "first" fills no form field, and no worked-out value or rule of the journey reads it, so its answer is kept in the browser only: checked there and kept in drafts, never sent, printed or exported. That is allowed — to send it, set the form field it fills.'
    );
    const runtime = runtimeOf(presentationRoot(), journey);
    answer(runtime, "nickname", "Ada");
    answer(runtime, "m1", 5);
    expect(runtime.presentationValues()).toEqual({ nickname: "Ada", m1: 5 });
    const values = await sent(runtime);
    expect(Object.values(values)).not.toContain("Ada");
    expect(values.annual_income).toBe(5);
  });

  it("never for an alias the ownership uses, a source of a worked-out value, or a field an own rule reads", () => {
    for (const journey of [applyJourney(), publicVariant()]) {
      const diagnostics = diagnoseJourney(presentationRoot(), journey);
      const aliases = Object.keys(journeyOwnership(presentationRoot(), journey).aliasOf ?? {});
      expect(of(diagnostics, "field.goes-nowhere").filter((diagnostic) => aliases.includes(diagnostic.ownNodeId as string))).toEqual([]);
      expect(of(diagnostics, "field.goes-nowhere")).toEqual([]);
    }
    const steered = journeyOf([page("first", own("more", "checkbox", { label: "More?" }), own("words", "html", { content: "<p>More</p>" }, { rules: { visibleWhen: eq("more", true) } }))]);
    expect(of(diagnoseJourney(presentationRoot(), steered), "field.goes-nowhere")).toEqual([]);
    // A source on another page feeds nothing there: said (and the read itself, as map.reads-other-page).
    const elsewhere = journeyOf([page("first", own("m0", "number")), page("second", own("m1", "number"), workedOut("total", "annual_income", call("sum", read("m0"), read("m1"))))], ["email", "name", "approved_amount"]);
    const found = diagnoseJourney(presentationRoot(), elsewhere);
    expect(of(found, "field.goes-nowhere").map((diagnostic) => diagnostic.ownNodeId)).toEqual(["m0"]);
    expect(of(found, "map.reads-other-page")).toHaveLength(1);
  });
});

describe("condition.reads-client-derived: a path turning on a value worked out in the browser", () => {
  it("a warning on the route reading the worked-out field — the value the kernel lists as clientDerived", () => {
    const diagnostics = diagnoseJourney(presentationRoot(), applyJourney());
    const finding = only(diagnostics, "condition.reads-client-derived");
    expect({ ...where(finding), routeIndex: finding.routeIndex, pageId: finding.pageId }).toEqual({
      severity: "warning",
      pageIndex: 1,
      ownNodeId: undefined,
      componentId: "annual_income",
      routeIndex: 0,
      pageId: "income"
    });
    expect(runKernel({ formId: "f", values: APPLY_ABOVE, locale: "en", form: presentationRoot(), journey: applyJourney() }, []).clientDerived).toEqual(["annual_income"]);
  });

  it("through a form calculation that reads one, as the kernel's list follows it; never for an alias's field", () => {
    const root = rootWith(field("double", "number", { rules: { value: "annual_income * 2" } }));
    const journey = applyJourney();
    journey.pages[1]!.routes = [{ when: "double >= 1", to: "assist" }, { when: eq("email", "x"), to: "assist" }, { to: "$end" }];
    const diagnostics = diagnoseJourney(root, journey);
    const finding = only(diagnostics, "condition.reads-client-derived");
    expect([finding.componentId, finding.routeIndex]).toEqual(["annual_income", 0]);
    expect(finding.message).toBe(
      'Route 1 of page "income" reads double, calculated from annual_income, which journey "apply" works out in the browser (income_total on page "income"): the server keeps the value it is sent, held to the form\'s rules, but cannot work it out again, so the way the path goes rests on what the browser sent.'
    );
    const outcome = runKernel({ formId: "f", values: { ...APPLY_ABOVE, double: 120000 }, locale: "en", form: root, journey }, []);
    expect(outcome.clientDerived).toContain("annual_income");
    expect(outcome.clientDerived).toContain("double");
    expect(outcome.clientDerived).not.toContain("email");
  });
});

describe("a page that may draw nothing: on the path, with no finding of its own", () => {
  it("keeps a page whose own layout holds only a reference naming nothing, or whose own nodes a browser rule hides", () => {
    const journey = journeyOf([page("first", own("box", "fieldset", { label: "Box" }, { children: { content: [reference("ghost")] } }))]);
    expect(diagnoseJourney(presentationRoot(), journey).map((diagnostic) => diagnostic.code)).not.toContain("page.unreachable");
    expect(runtimeOf(presentationRoot(), journey).journeyView()?.path).toEqual(["first", "rest"]);
    const rules: Journey = {
      id: "apply",
      pages: [
        { id: "ask", title: "Ask", components: ["name", "email"] },
        page("maybe", own("words", "html", { content: "<p>Hi</p>" }, { rules: { visibleWhen: eq("name", "Ada") } })),
        { id: "rest", title: "Rest", components: ["money", "approved_amount"] }
      ]
    };
    const runtime = runtimeOf(presentationRoot(), rules);
    runtime.setValue("name", "Grace");
    expect(runtime.journeyView()?.path).toContain("maybe");
    expect(runtime.effectiveState("words")?.visible).toBe(false);
  });
});

describe("component.placed-twice: one form field placed twice on one page", () => {
  it("two aliases of one field, an alias beside its listing (or its container's), a reference beside a listing — a warning, once for the outermost", () => {
    const cases: Array<[string, JourneyPageEntry[], string[], string, string | undefined]> = [
      [
        "two aliases",
        [own("a1", "text", { label: "A", fills: "email" }), own("a2", "text", { label: "B", fills: "email" })],
        ["name", "money", "approved_amount"],
        'email is placed twice on page "first": filled by a1 and filled by a2. Each shows the same answer, so the page asks it more than once; place it once.',
        "a2"
      ],
      [
        "a listing and an alias",
        ["email", own("a1", "text", { label: "A", fills: "email" })],
        ["name", "money", "approved_amount"],
        'email is placed twice on page "first": listed on the page and filled by a1. Each shows the same answer, so the page asks it more than once; place it once.',
        "a1"
      ],
      [
        "a container listed and an alias of a field in it",
        ["money", own("typed", "number", { label: "Income", fills: "annual_income" })],
        ["email", "name", "approved_amount"],
        'annual_income is placed twice on page "first": listed on the page (inside money) and filled by typed. Each shows the same answer, so the page asks it more than once; place it once.',
        "typed"
      ],
      [
        "a reference beside a listing",
        ["approved_amount", own("box", "fieldset", { label: "Box" }, { children: { content: [reference("approved_amount")] } })],
        ["email", "name", "money"],
        'approved_amount is placed twice on page "first": listed on the page and shown by a reference in box. The page draws it once, where it comes first, and the other shows nothing; place it once.',
        "box"
      ]
    ];
    for (const [name, entries, rest, message, ownNodeId] of cases) {
      const journey = journeyOf([page("first", ...entries)], rest);
      const finding = only(diagnoseJourney(presentationRoot(), journey), "component.placed-twice");
      expect(finding.message, name).toBe(message);
      expect(finding.ownNodeId, name).toBe(ownNodeId);
      expect(finding.pageIndex, name).toBe(0);
    }
  });

  it("parity: the ownership places the field on the page once, while the page draws each alias", () => {
    const journey = journeyOf([page("first", own("a1", "text", { label: "A", fills: "email" }), own("a2", "text", { label: "B", fills: "email" }))], ["name", "money", "approved_amount"]);
    expect(journeyOwnership(presentationRoot(), journey).pagesOf.email).toEqual(["first"]);
    const index = runtimeOf(presentationRoot(), journey).presentationIndex();
    expect(index?.aliases.filter((alias) => alias.targetId === "email").map((alias) => [alias.nodeId, alias.pageId])).toEqual([
      ["a1", "first"],
      ["a2", "first"]
    ]);
    // Aliases on two pages are component.multiple-pages, as before; a journey of ids alone listing one twice says nothing new.
    expect(of(diagnoseJourney(presentationRoot(), { id: "apply", pages: [{ id: "first", title: "First", components: ["email", "email", "name", "money", "approved_amount"] }] }), "component.placed-twice")).toEqual([]);
  });
});

describe("rule.unknown-field: an own node's rule reading what it can never read", () => {
  it("a warning for a path naming nothing, a key under @, a worked-out value and a node that holds no answer; none for form fields and own fields on any page", () => {
    const journey = journeyOf(
      [
        page("first", own("m1", "number"), workedOut("total", "annual_income", read("m1")), own("words", "html", { content: "x" })),
        page(
          "second",
          own(
            "note",
            "text",
            { label: "Note" },
            {
              rules: {
                visibleWhen: `${eq("ghost", 1)} and ${eq("@apply.m1", 1)}`,
                requiredWhen: `${eq("total", 1)} or ${eq("words", 1)}`,
                enabledWhen: `${eq("m1", 1)} and ${eq("name", "x")}`,
                readonlyWhen: eq("host.role", "staff")
              }
            }
          )
        )
      ],
      ["email", "name", "approved_amount"]
    );
    const diagnostics = diagnoseJourney(presentationRoot(), journey);
    expect(of(diagnostics, "rule.unknown-field").map((diagnostic) => [diagnostic.severity, diagnostic.ownNodeId, diagnostic.pageIndex])).toEqual([
      ["warning", "note", 1],
      ["warning", "note", 1],
      ["warning", "note", 1],
      ["warning", "note", 1]
    ]);
    expect(of(diagnostics, "rule.unknown-field").map((diagnostic) => diagnostic.message)).toEqual([
      'The visibility rule of note on page "second" reads ghost, which is neither a component of the form nor a field of journey "apply"\'s own, so it always reads as unanswered.',
      'The visibility rule of note on page "second" reads @apply.m1, where the browser keeps an answer: the rules of the journey\'s own nodes read its fields by id, so it always reads as unanswered — read m1 instead.',
      'The required rule of note on page "second" reads total, a worked-out value, which holds no answer of its own, so it always reads as unanswered — read annual_income, the form field it works out, instead.',
      'The required rule of note on page "second" reads words, which holds no answer (a html), so it always reads as unanswered.'
    ]);
  });

  it("parity: the browser reads an own field by its id, never by its @ key", () => {
    const shownBy = (rule: string): Journey => journeyOf([page("first", own("m1", "number"), own("words", "html", { content: "x" }, { rules: { visibleWhen: rule } }))]);
    for (const [rule, shown] of [
      [eq("m1", 5), true],
      [eq("@apply.m1", 5), false]
    ] as Array<[string, boolean]>) {
      const journey = shownBy(rule);
      expect(of(diagnoseJourney(presentationRoot(), journey), "rule.unknown-field").length).toBe(shown ? 0 : 1);
      const runtime = runtimeOf(presentationRoot(), journey);
      answer(runtime, "m1", 5);
      expect(runtime.effectiveState("words")?.visible).toBe(shown);
    }
  });
});

describe("data-key.reserved-prefix: a key of the form's own data under @", () => {
  const atRoot = (): ComponentNode =>
    rootWith(
      field("keyed", "text", { configuration: { label: "Keyed", dataKey: "@keyed" } }),
      group("rows", "repeatingSection", [field("sku")], { collection: { collectionPath: "@apply.items" } }),
      { id: "grid", type: "dataGrid", configuration: { label: "Grid" }, collection: { collectionPath: "@grid" }, children: { columns: [field("cell")] } }
    );

  it("a warning on the component for a collection path, a data grid's included; never for a data key, which is no key at all", () => {
    const diagnostics = diagnoseJourney(atRoot(), applyJourney());
    expect(of(diagnostics, "data-key.reserved-prefix").map((diagnostic) => [diagnostic.severity, diagnostic.componentId, diagnostic.ownNodeId])).toEqual([
      ["warning", "rows", undefined],
      ["warning", "grid", undefined]
    ]);
    expect(only(diagnostics.filter((diagnostic) => diagnostic.componentId === "rows"), "data-key.reserved-prefix").message).toBe(
      'rows: its collection path "@apply.items" starts with @, as the keys a journey keeps its own fields\' answers under in the browser do (@ and its id). The form\'s values there are kept and sent as any others; but a page\'s own field whose answer would land on one of them is left off its page. Start it with a letter to keep the two apart.'
    );
    // As the browser reads it: the form's own key is a form value, not a presentation's answer.
    const index = runtimeOf(atRoot(), applyJourney()).presentationIndex();
    expect(journeyFormKeys(atRoot())["@apply.items"]).toBe(true);
    expect(index?.isPresentationKey("@apply.items")).toBe(false);
    expect(index?.isPresentationKey("@apply.m1")).toBe(true);
  });

  it("once per component over a definition's journeys, string-only ones too; each journey's own findings still say it", () => {
    const root = rootWith(group("rows", "repeatingSection", [field("sku")], { collection: { collectionPath: "@items" } }));
    const plain = (id: string): Journey => ({ id, pages: [{ id: `${id}_page`, title: "Page", components: ["email", "name", "money", "approved_amount", "rows"] }] });
    const definition = { root, journey: { journeys: [plain("one"), plain("two")] } };
    expect(of(diagnoseJourneys(definition), "data-key.reserved-prefix").map((diagnostic) => [diagnostic.severity, diagnostic.journeyId, diagnostic.componentId])).toEqual([
      ["warning", "one", "rows"]
    ]);
    expect(of(diagnoseJourney(root, plain("two")), "data-key.reserved-prefix")).toHaveLength(1);
  });

  it("parity: a form keyed under @ works — both sides keep and accept its values, through a journey of ids alone", async () => {
    const root = rootWith(group("rows", "repeatingSection", [field("sku")], { collection: { collectionPath: "@items" } }));
    const journey: Journey = { id: "plain", pages: [{ id: "all", title: "All", components: ["email", "name", "money", "approved_amount", "rows"] }] };
    const steps = (runtime: FormRuntime): void => {
      runtime.setValue("email", "ada@example.org");
      runtime.setValue("annual_income", 1);
    };
    expect(await refused(root, journey, steps)).toEqual([]);
    const browser = runtimeOf(root, journey);
    steps(browser);
    expect((await sent(browser)).email).toBe("ada@example.org");
    expect(of(diagnoseJourney(root, journey), "data-key.reserved-prefix").map((diagnostic) => diagnostic.severity)).toEqual(["warning"]);
  });

  it("nothing for a form without such keys", () => {
    expect(of(diagnoseJourney(presentationRoot(), applyJourney()), "data-key.reserved-prefix")).toEqual([]);
  });
});

describe("calc.input-left-out: empty literals and defaults from a page", () => {
  const withTotal = (value: string, type = "text"): ComponentNode =>
    rootWith(field("total", type, { configuration: { label: "Total", required: true }, rules: { value } }), field("base", "text"), field("rate", "text", { rules: { defaultValue: read("base") } }));
  const leavingOut = (...left: string[]): Journey => ({
    id: "apply",
    pages: [{ id: "all", title: "All", components: ["email", "name", "money", "approved_amount", "base", "rate", "total"].filter((id) => !left.includes(id)) }]
  });

  it("a literal that is empty for the field's type does not answer a concat or a coalesce: the input is still reported, and both sides refuse", async () => {
    for (const [name, value] of [
      ['concat(name, " ")', call("concat", read("name"), literal(" "))],
      ['concat(name, "")', call("concat", read("name"), literal(""))],
      ['coalesce(name, "")', call("coalesce", read("name"), literal(""))],
      ["coalesce(name, null)", call("coalesce", read("name"), literal(null))],
      ['concat(concat(name, " "), "")', call("concat", call("concat", read("name"), literal(" ")), literal(""))]
    ] as Array<[string, string]>) {
      const root = withTotal(value);
      const finding = only(diagnoseJourney(root, leavingOut("name")), "calc.input-left-out");
      expect([finding.severity, finding.componentId, finding.requiredField], name).toEqual(["error", "name", "total"]);
      expect(await refused(root, leavingOut("name"), (runtime) => {
        runtime.setValue("email", "ada@example.org");
        runtime.setValue("annual_income", 1);
        runtime.setValue("base", "b");
      }), name).toEqual(["total:required"]);
    }
  });

  it("a literal that is not empty still answers; an empty literal before the input makes the calculation empty whatever is asked, which is not the input's doing", async () => {
    for (const value of [call("concat", read("name"), literal("x")), call("coalesce", read("name"), literal("none")), call("coalesce", literal(""), read("name"))]) {
      expect(of(diagnoseJourney(withTotal(value), leavingOut("name")), "calc.input-left-out")).toEqual([]);
    }
    // coalesce("", name): empty even when name is asked and answered — every side refuses it, on the whole form too.
    const always = withTotal(call("coalesce", literal(""), read("name")));
    expect(await refused(always, leavingOut(), (runtime) => {
      runtime.setValue("email", "ada@example.org");
      runtime.setValue("annual_income", 1);
      runtime.setValue("name", "Ada");
      runtime.setValue("base", "b");
    })).toEqual(["total:required"]);
  });

  it("an input whose default is a plain path to an answer a page asks is a warning, not an error: every side accepts once that is answered", async () => {
    const root = withTotal(call("concat", read("rate"), literal("")));
    const finding = only(diagnoseJourney(root, leavingOut("rate")), "calc.input-left-out");
    expect([finding.severity, finding.componentId, finding.required]).toEqual(["warning", "rate", false]);
    expect(finding.message).toBe(
      'total is required by the form and worked out from rate, which journey "apply" never asks: its default is taken from base, which a page asks, so the form\'s rule is met once that is answered.'
    );
    expect(await refused(root, leavingOut("rate"), (runtime) => {
      runtime.setValue("email", "ada@example.org");
      runtime.setValue("annual_income", 1);
      runtime.setValue("base", "7");
    })).toEqual([]);
    // Its source on no page either: still the error.
    const both = only(diagnoseJourney(root, leavingOut("rate", "base")), "calc.input-left-out");
    expect([both.severity, both.componentId]).toEqual(["error", "rate"]);
  });
});

/**
 * Diagnostics for a journey's own nodes: each finding as the runtime and the kernel bear it out.
 */
describe("map.reads-no-source: a worked-out value reading none of its page's own fields", () => {
  const withFixed = (value: string, to = "annual_income", ...others: JourneyPageEntry[]): Journey =>
    journeyOf([page("first", ...others, workedOut("fixed", to, value))], ["email", "name", ...(to === "annual_income" ? ["approved_amount"] : ["money"])]);
  const steps = (...more: Array<(runtime: FormRuntime) => void>) => (runtime: FormRuntime): void => {
    runtime.setValue("email", "ada@example.org");
    for (const step of more) {
      step(runtime);
    }
  };

  it("an error into a field the form requires outright, on a page with no own field: never worked out, and both sides refuse every submission", async () => {
    for (const value of [literal(5), read("host.income")]) {
      const journey = withFixed(value);
      const diagnostics = diagnoseJourney(presentationRoot(), journey);
      expect(where(only(diagnostics, "map.reads-no-source"))).toEqual({ severity: "error", pageIndex: 0, ownNodeId: "fixed", componentId: "annual_income" });
      expect(only(diagnostics, "map.reads-no-source").message).toBe(
        'fixed on page "first" works out annual_income without reading any field of its page\'s own, and a worked-out value is worked out only once one of those is answered: this page has none, so annual_income is never worked out, and the form requires it, so no submission through the journey can pass. Work it out from a field the page asks, or ask annual_income on the page.'
      );
      expect(await refused(presentationRoot(), journey, steps())).toEqual(["annual_income:required"]);
    }
  });

  it("with an unrelated own field the page may leave unanswered: still an error — refused while it is, accepted once it is answered", async () => {
    const journey = withFixed(literal(5), "annual_income", own("note", "text", { label: "Note" }));
    const finding = only(diagnoseJourney(presentationRoot(), journey), "map.reads-no-source");
    expect(finding.severity).toBe("error");
    expect(finding.message).toBe(
      'fixed on page "first" works out annual_income without reading any field of its page\'s own, and a worked-out value is worked out only once one of those is answered: here "note", which it does not read and which may be left unanswered, so annual_income is not worked out until one of them is, and the form requires it, so until then no submission through the journey can pass. Work it out from a field the page asks, or ask annual_income on the page.'
    );
    expect(await refused(presentationRoot(), journey, steps())).toEqual(["annual_income:required"]);
    expect(await refused(presentationRoot(), journey, steps((runtime) => answer(runtime, "note", "hi")))).toEqual([]);
  });

  it("a warning into an optional or a Required-when field; nothing once the page holds an own field it asks for good, or the expression reads one", async () => {
    const optional = only(diagnoseJourney(presentationRoot(), withFixed(literal(5), "approved_amount")), "map.reads-no-source");
    expect([optional.severity, optional.componentId]).toEqual(["warning", "approved_amount"]);
    expect(optional.message.endsWith("so approved_amount is never worked out. Work it out from a field the page asks, or ask approved_amount on the page.")).toBe(true);
    const ruled = presentationRoot();
    const income = ruled.children!.content![2]!.children!.content![0]!;
    (income.configuration as Record<string, unknown>).required = false;
    income.rules = { requiredWhen: eq("name", "x") };
    const whenRuled = only(diagnoseJourney(ruled, withFixed(literal(5))), "map.reads-no-source");
    expect(whenRuled.severity).toBe("warning");
    expect(whenRuled.message).toContain("and the form requires it when its rule holds, so while that rule holds no submission through the journey can pass.");

    // A required own field that always shows is answered whenever the page is passed: worked out, and accepted.
    const asked = withFixed(literal(5), "annual_income", own("agree", "checkbox", { label: "Agree", required: true }));
    expect(of(diagnoseJourney(presentationRoot(), asked), "map.reads-no-source")).toEqual([]);
    expect(await refused(presentationRoot(), asked, steps((runtime) => answer(runtime, "agree", true)))).toEqual([]);
    // One that may hide is not sure to be: still the error.
    const hiding = withFixed(literal(5), "annual_income", own("agree", "checkbox", { label: "Agree", required: true }, { rules: { visibleWhen: eq("name", "x") } }));
    expect(only(diagnoseJourney(presentationRoot(), hiding), "map.reads-no-source").severity).toBe("error");
    // Reading an own field of the page: nothing here.
    expect(of(diagnoseJourney(presentationRoot(), withFixed(read("m1"), "annual_income", own("m1", "number"))), "map.reads-no-source")).toEqual([]);
  });
});

describe("map.sources-conditional under a Required-when rule: a warning — the rule may hold while every source hides, or never then", () => {
  const employment = (requiredWhen: string): ComponentNode =>
    rootWith(field("employed", "checkbox"), field("income", "number", { configuration: { label: "Income" }, rules: { requiredWhen } }));
  const journey = journeyOf(
    [
      page(
        "income_page",
        own("employed_alias", "checkbox", { label: "Are you employed?", fills: "employed" }),
        own("m1", "number", { label: "Month 1" }, { rules: { visibleWhen: eq("employed", true) } }),
        own("m2", "number", { label: "Month 2" }, { rules: { visibleWhen: eq("employed", true) } }),
        workedOut("total", "income", call("sum", read("m1"), read("m2")))
      )
    ],
    ["email", "name", "money", "approved_amount"]
  );
  const steps = (employed: boolean, name = "Ada") => (runtime: FormRuntime): void => {
    runtime.setValue("email", "ada@example.org");
    runtime.setValue("annual_income", 1);
    runtime.setValue("name", name);
    answer(runtime, "employed_alias", employed);
    if (employed) {
      answer(runtime, "m1", 10);
    }
  };

  it("a warning, not an error: the rule reading what hides the sources is never refused", async () => {
    const root = employment(eq("employed", true));
    const finding = only(diagnoseJourney(root, journey), "map.sources-conditional");
    expect(where(finding)).toEqual({ severity: "warning", pageIndex: 0, ownNodeId: "total", componentId: "income" });
    expect(finding.message).toBe(
      'income is required by the form when its rule holds, and total on page "income_page" works it out from "m1" and "m2", each of which may be hidden: whenever they all are while that rule holds, nothing works income out and the page shows it read-only, so the page cannot be passed — which never happens if they are hidden only while the rule does not hold. Let one of them always show, or ask income on the page.'
    );
    expect(await refused(root, journey, steps(false))).toEqual([]);
    expect(await refused(root, journey, steps(true))).toEqual([]);
  });

  it("a rule that holds while every source hides is refused on both sides: what the warning says may happen", async () => {
    const root = employment(eq("name", "x"));
    expect(only(diagnoseJourney(root, journey), "map.sources-conditional").severity).toBe("warning");
    expect(await refused(root, journey, steps(false, "x"))).toEqual(["income:required"]);
  });
});

describe("ownNodeRepeat: own nodes sharing an id on one page", () => {
  it("the finding about a later one says how many come before it; the first's findings and other pages' carry none", () => {
    const diagnostics = diagnoseJourney(presentationRoot(), journeyOf([page("first", own("nick", "text", { label: "Nick" }), own("nick", "text", { label: "Nick again" }))]));
    expect(diagnostics.filter((diagnostic) => diagnostic.ownNodeId === "nick").map((diagnostic) => [diagnostic.code, diagnostic.ownNodeRepeat])).toEqual([
      ["field.goes-nowhere", undefined],
      ["field.id-clash", 1]
    ]);
    const apart = diagnoseJourney(presentationRoot(), journeyOf([page("first", own("nick", "text")), page("second", own("nick", "text"))]));
    expect(only(apart, "field.id-clash")).toMatchObject({ pageIndex: 1, ownNodeId: "nick" });
    expect(only(apart, "field.id-clash").ownNodeRepeat).toBeUndefined();
    // A node with no id is drawn on the node around it, and told apart as that node is.
    const nested = diagnoseJourney(
      presentationRoot(),
      journeyOf([page("first", own("box", "fieldset", { label: "Box" }, { children: { content: [own("inner", "text")] } }), own("box", "fieldset", { label: "Box" }, { children: { content: [{ type: "text", configuration: {} } as unknown as JourneyPageEntry] } }))])
    );
    expect(nested.filter((diagnostic) => diagnostic.ownNodeId === "box" && diagnostic.rule !== undefined).map((diagnostic) => [diagnostic.code, diagnostic.ownNodeRepeat])).toEqual([
      ["field.id-clash", 1],
      ["presentation.entry-unusable", 1]
    ]);
  });
});

describe("page.no-title as the runtime heads the page", () => {
  const heading = (journey: Journey): string => {
    const runtime = runtimeOf(presentationRoot(), journey);
    return buildJourneyMeta(runtime.journeyRenderRoot()!.root, runtime.journeyView()!, { locale: "en" }).title;
  };
  const untitled = (...entries: JourneyPageEntry[]): Journey => ({ id: "apply", pages: [{ id: "first", components: entries }, { id: "rest", title: "Rest", components: ["name", "approved_amount"] }] });

  it("said exactly when the runtime draws no heading for it (the page id is no heading): an alias with no label, a worked-out value labelled blank; never for a worked-out value with no label, which takes its field's", () => {
    for (const [journey, borrowed] of [
      [untitled(own("work_email", "text", { fills: "email" })), ""],
      [untitled(own("m1", "number", { label: "Month" }), workedOut("total", "annual_income", read("m1"))), "Month"],
      [untitled(own("total", "journey-value", { to: "annual_income", value: read("m1"), label: "" }), own("m1", "number")), ""],
      [untitled(own("total", "journey-value", { to: "annual_income", value: read("m1") }), own("m1", "number")), "Annual income"],
      [untitled(own("work_email", "text", { label: "Work email", fills: "email" })), "Work email"]
    ] as Array<[Journey, string]>) {
      expect(heading(journey), JSON.stringify(journey.pages[0])).toBe(borrowed);
      expect(of(diagnoseJourney(presentationRoot(), journey), "page.no-title").length, borrowed).toBe(borrowed === "" ? 1 : 0);
    }
  });
});

describe("calc.input-left-out: a coalesce stops at the first argument that comes to a value, empty or not", () => {
  const withTotal = (value: string, type: string): ComponentNode => rootWith(field("total", type, { configuration: { label: "Total", required: true }, rules: { value } }));
  const leavingName: Journey = { id: "apply", pages: [{ id: "all", title: "All", components: ["email", "money", "approved_amount", "total"] }] };
  const steps = (runtime: FormRuntime): void => {
    runtime.setValue("email", "ada@example.org");
    runtime.setValue("annual_income", 1);
  };
  const twice = "name * 2";

  it("an argument other than a bare path, missing its input, ends it empty: reported, and both sides refuse", async () => {
    for (const [name, value, type] of [['coalesce(concat(name), "x")', call("coalesce", call("concat", read("name")), literal("x")), "text"]] as Array<[string, string, string]>) {
      const root = withTotal(value, type);
      const finding = only(diagnoseJourney(root, leavingName), "calc.input-left-out");
      expect([finding.severity, finding.componentId, finding.requiredField], name).toEqual(["error", "name", "total"]);
      expect(await refused(root, leavingName, steps), name).toEqual(["total:required"]);
    }
  });

  it("a bare path, a coalesce of bare paths, or arithmetic over one reads as null and is passed over: nothing said, and both sides accept", async () => {
    for (const [name, value, type] of [
      ['coalesce(name, "x")', call("coalesce", read("name"), literal("x")), "text"],
      ['coalesce(coalesce(name), "x")', call("coalesce", call("coalesce", read("name")), literal("x")), "text"],
      // Arithmetic over a missing operand is no answer, never NaN: the coalesce goes on to 0, and total = 0 on both sides.
      ["coalesce(name * 2, 0)", call("coalesce", twice, literal(0)), "number"]
    ] as Array<[string, string, string]>) {
      const root = withTotal(value, type);
      expect(of(diagnoseJourney(root, leavingName), "calc.input-left-out"), name).toEqual([]);
      expect(await refused(root, leavingName, steps), name).toEqual([]);
    }
  });
});

describe("map.shape-mismatch: a worked-out copy of one source is held to the source's own shape", () => {
  it("text copied into a date field is an error, as an alias's would be — and both sides refuse the text", async () => {
    const root = rootWith(field("start", "date", { configuration: { label: "Start", required: true } }));
    const journey = journeyOf([page("first", own("typed", "text", { label: "Typed" }), workedOut("w", "start", read("typed")))], ["email", "name", "money", "approved_amount"]);
    const finding = only(diagnoseJourney(root, journey), "map.shape-mismatch");
    expect(where(finding)).toEqual({ severity: "error", pageIndex: 0, ownNodeId: "w", componentId: "start" });
    expect(finding.message).toBe(
      'w on page "first" copies typed, which asks for text, into start, which holds a date: the value is kept as worked out, so start gets an answer of another kind, which the form refuses unless it is a date. Make typed the same kind of field as start.'
    );
    expect(
      await refused(root, journey, (runtime) => {
        runtime.setValue("email", "ada@example.org");
        runtime.setValue("annual_income", 1);
        answer(runtime, "typed", "next tuesday");
      })
    ).toEqual(["start:date"]);
  });

  it("what an alias may fill, a copy may set: a date or a choice into text, a date into a date", () => {
    const root = rootWith(field("words", "text"), field("start", "date"));
    for (const [type, target, extra] of [
      ["date", "words", {}],
      ["select", "words", { options: choices("a") }],
      ["date", "start", {}]
    ] as Array<[string, string, Record<string, unknown>]>) {
      const journey = journeyOf([page("first", own("source", type, { label: "Source", ...extra }), workedOut("w", target, read("source")))], ["email", "name", "money", "approved_amount"]);
      expect(of(diagnoseJourney(root, journey), "map.shape-mismatch"), `${type} -> ${target}`).toEqual([]);
    }
  });
});

describe("field.goes-nowhere: a type the host says holds no answer, and only the rules the browser reads", () => {
  it("a plugin's valueless type is never said to go nowhere once the builder's isValueless says so", () => {
    const journey = journeyOf([page("first", own("help_link", "gcds-link", { text: "Help", href: "/help" }))]);
    expect(of(diagnoseJourney(presentationRoot(), journey), "field.goes-nowhere").map((diagnostic) => diagnostic.ownNodeId)).toEqual(["help_link"]);
    expect(of(diagnoseJourney(presentationRoot(), journey, { isValueless: (node) => node.type === "gcds-link" }), "field.goes-nowhere")).toEqual([]);
  });

  it("a field read only by a rule the browser never reads on that node goes nowhere; read by one it reads, it does not", () => {
    const toggle = own("toggle", "checkbox", { label: "Toggle" });
    const reads = (...entries: JourneyPageEntry[]): string[] =>
      of(diagnoseJourney(presentationRoot(), journeyOf([page("first", toggle, ...entries)], ["name", "approved_amount", "money"])), "field.goes-nowhere").map((diagnostic) => diagnostic.ownNodeId as string);
    const on = eq("toggle", true);
    // Never read: an alias's visibility, a worked-out value's, a layout's holding a form field.
    expect(reads(own("work_email", "text", { label: "Work email", fills: "email" }, { rules: { visibleWhen: on } }))).toEqual(["toggle"]);
    expect(reads(own("m1", "number", { label: "M" }), workedOut("total", "approved_amount", read("m1"), { rules: { visibleWhen: on } }))).toEqual(["toggle"]);
    expect(reads(own("box", "fieldset", { label: "Box" }, { rules: { visibleWhen: on }, children: { content: [reference("email")] } }))).toEqual(["toggle"]);
    // Read: an alias's Required-when, a field's visibility, a layout's enabled rule.
    expect(reads(own("work_email", "text", { label: "Work email", fills: "email" }, { rules: { requiredWhen: on } }))).toEqual([]);
    expect(reads(own("more", "text", { label: "More" }, { rules: { visibleWhen: on } }), "email").filter((id) => id === "toggle")).toEqual([]);
    expect(reads(own("box", "fieldset", { label: "Box" }, { rules: { enabledWhen: on }, children: { content: [reference("email")] } }))).toEqual([]);
    // As the runtime bears it out: the alias shows whatever the toggle says.
    const journey = journeyOf([page("first", toggle, own("work_email", "text", { label: "Work email", fills: "email" }, { rules: { visibleWhen: on } }))], ["name", "approved_amount", "money"]);
    const runtime = runtimeOf(presentationRoot(), journey);
    for (const ticked of [false, true]) {
      answer(runtime, "toggle", ticked);
      expect(runtime.effectiveState("work_email")?.visible).toBe(true);
    }
  });
});
