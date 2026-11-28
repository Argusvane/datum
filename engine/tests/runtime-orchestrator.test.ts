import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../form-engine/core/events/event-bus.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { RuntimeOrchestrator, type RecomputeResult } from "../form-engine/runtime/browser/runtime-orchestrator.js";
import { compileFormDefinition } from "../form-engine/runtime/browser/form-runtime.js";
import { applyHiddenValuePolicy } from "../form-engine/core/state/hidden-value-policy.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { Expression, RuleSource } from "../form-engine/core/expressions/expression.js";
import type { FormulaFunctionSignature } from "../form-engine/core/expressions/formula-types.js";
import type { Journey, JourneyPage, PresentationNode } from "../form-engine/core/schema/journey.js";
import { journeyOwnership, journeyPath, journeyPlacements } from "../form-engine/core/journey/journey-path.js";
import { buildPresentationIndex, type PresentationIndex } from "../form-engine/core/journey/presentation.js";
import { parseComponentPath } from "../form-engine/core/tree/component-path.js";
import { evaluateExpression } from "../form-engine/rules/evaluator/evaluator.js";
import { kernelDefinesKey, kernelKnownKeyShapes } from "../form-engine/validation/wasm/portable-kernel.js";
import { applyJourney, presentationRoot } from "./fixtures/presentation-form.js";

function tree(): ComponentTree {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "visibleField", type: "text", configuration: {} },
        {
          id: "hiddenGroup",
          type: "container",
          configuration: { hidden: true },
          children: {
            content: [
              {
                id: "childOfHidden",
                type: "text",
                configuration: { hiddenValueBehavior: "exclude-from-submission" }
              }
            ]
          }
        }
      ]
    }
  };
  return new ComponentTree(root);
}

describe("RuntimeOrchestrator", () => {
  it("computes effective state with ancestor visibility folding", () => {
    const bus = new EventBus();
    const orchestrator = new RuntimeOrchestrator(tree(), { eventBus: bus, formId: "f1" });
    const store = new FormStateStore("en");

    orchestrator.recompute(store.snapshot());

    expect(orchestrator.effectiveStateFor("visibleField")?.visible).toBe(true);
    expect(orchestrator.effectiveStateFor("hiddenGroup")?.visible).toBe(false);
    // Child inherits the hidden ancestor.
    expect(orchestrator.effectiveStateFor("childOfHidden")?.visible).toBe(false);
    expect(orchestrator.effectiveStateFor("childOfHidden")?.runValidation).toBe(false);
  });

  it("applies hidden-value policy to the effective value view", () => {
    const bus = new EventBus();
    const orchestrator = new RuntimeOrchestrator(tree(), { eventBus: bus, formId: "f1" });
    const store = new FormStateStore("en");
    store.setValue({ segments: [{ key: "visibleField" }] }, "keep");
    store.setValue({ segments: [{ key: "childOfHidden" }] }, "drop");

    orchestrator.recompute(store.snapshot());
    const effective = orchestrator.effectiveValues();

    expect(effective.visibleField).toBe("keep");
    // exclude-from-submission on a hidden node removes the key entirely.
    expect("childOfHidden" in effective).toBe(false);
  });

  it("publishes RECOMPUTE_COMPLETED with the changed paths", () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe(FormEventType.RECOMPUTE_COMPLETED, (event) => events.push(event.data));

    const orchestrator = new RuntimeOrchestrator(tree(), { eventBus: bus, formId: "f1" });
    orchestrator.recompute(new FormStateStore("en").snapshot(), ["visibleField"]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ changedPaths: ["visibleField"] });
  });
});

describe("RuntimeOrchestrator: whose state judges a value key", () => {
  it("names a repeating section for its entries wherever its collection path puts them", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: {} },
          {
            id: "items",
            type: "repeatingSection",
            configuration: {},
            collection: { collectionPath: "order_lines" },
            children: { content: [{ id: "sku", type: "text", configuration: {} }] }
          },
          {
            id: "order",
            type: "container",
            configuration: {},
            children: {
              content: [
                {
                  id: "order_items",
                  type: "repeatingSection",
                  configuration: {},
                  collection: { collectionPath: "order.items" },
                  children: { content: [{ id: "code", type: "text", configuration: {} }] }
                }
              ]
            }
          },
          { id: "notes", type: "repeatingSection", configuration: {}, collection: {}, children: { content: [] } }
        ]
      }
    };
    const orchestrator = new RuntimeOrchestrator(new ComponentTree(root), { eventBus: new EventBus(), formId: "f1" });
    expect(orchestrator.collectionOwnerOf("name")).toBeUndefined();
    expect(orchestrator.collectionOwnerOf("order_lines[0].sku")).toBe("items");
    expect(orchestrator.collectionOwnerOf("order_lines")).toBe("items");
    expect(orchestrator.collectionOwnerOf("order.items[2].code")).toBe("order_items");
    expect(orchestrator.collectionOwnerOf("notes[0].text")).toBe("notes");
    // A key no section holds, and one named like a prototype member: nobody's.
    expect(orchestrator.collectionOwnerOf("extra[0].x")).toBeUndefined();
    expect(orchestrator.collectionOwnerOf("constructor[0].x")).toBeUndefined();
    // The one a value path names is unchanged.
    expect(orchestrator.componentIdForPath("order_lines[0].sku")).toBeUndefined();

    // The hidden-value policy judges an entry by its section, after its owner and before its
    // leading segment (the fold's order): `order.items[0].code` by `order_items`, not `order`.
    const hiddenSection = { visible: false, disabled: false, readonly: false, runValidation: false, requiredApplies: false, submitValue: false, clearValue: false };
    const shown = { ...hiddenSection, visible: true, runValidation: true, requiredApplies: true, submitValue: true };
    const states = new Map([
      ["name", shown],
      ["items", hiddenSection],
      ["order", shown],
      ["order_items", hiddenSection]
    ]);
    expect(
      applyHiddenValuePolicy(
        { name: "n", "order_lines[0].sku": "a", "order.items[0].code": "b", "extra[0].x": "c" },
        states,
        (path) => orchestrator.componentIdForPath(path),
        (key) => orchestrator.collectionOwnerOf(key)
      )
    ).toEqual({ name: "n", "extra[0].x": "c" });
  });

  it("reads a component's own value by own key only: `constructor` unanswered is empty", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "constructor",
            type: "text",
            // Retains: the rule reads the field's own answer, which a hidden-and-left-out default would take back from it the moment the rule hid it.
            configuration: { hiddenValueBehavior: "retain" },
            // empty(component), not `not component`: a condition holds only for true (strict truthiness), so "answered" no longer reads as a yes.
            rules: { visibleWhen: "empty(component)" }
          }
        ]
      }
    };
    const orchestrator = new RuntimeOrchestrator(new ComponentTree(root), { eventBus: new EventBus(), formId: "f1" });
    const store = new FormStateStore("en");
    orchestrator.recompute(store.snapshot());
    expect(orchestrator.effectiveStateFor("constructor")?.visible).toBe(true);
    store.setValue({ segments: [{ key: "constructor" }] }, "answered");
    orchestrator.recompute(store.snapshot());
    expect(orchestrator.effectiveStateFor("constructor")?.visible).toBe(false);
  });
});

// --- Presentations -------------------------------------------------------------

/** `name == value`, read by component id. */
const nameIs = (value: string): string => `name = ${JSON.stringify(value)}`;

interface PresentationHarness {
  store: FormStateStore;
  orchestrator: RuntimeOrchestrator;
  index: PresentationIndex;
  set(path: string, value: unknown): RecomputeResult;
  recompute(): RecomputeResult;
  values(): Record<string, unknown>;
  written(): Record<string, unknown> | undefined;
}

/** An orchestrator over the shared presentation fixture, wired to a store as `FormRuntime` wires its own. */
function presentationHarness(options: { root?: ComponentNode; journey?: Journey; store?: FormStateStore; signatures?: FormulaFunctionSignature[] } = {}): PresentationHarness {
  // Compiled first, as `FormRuntime` compiles its definition: the orchestrator and the fold read the compiled copy.
  const compiled = compileFormDefinition({
    id: "presentation",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: options.root ?? presentationRoot(),
    journey: { journeys: [options.journey ?? applyJourney()] }
  }, { signatures: options.signatures ?? [] }).definition;
  const root = compiled.root;
  const journey = compiled.journey?.journeys?.[0] as Journey;
  const ownership = journeyOwnership(root, journey);
  const shapes = kernelKnownKeyShapes(root);
  const index = buildPresentationIndex(root, journey, ownership, (key) => kernelDefinesKey(shapes, key)) as PresentationIndex;
  const store = options.store ?? new FormStateStore("en");
  if (options.store === undefined) {
    store.startJourney(journey.id, journey.pages[0]?.id ?? "");
  }
  const orchestrator = new RuntimeOrchestrator(new ComponentTree(root), {
    eventBus: new EventBus(),
    formId: "presentation",
    applyComputedValue: (path, value) => store.setComputedValue(parseComponentPath(path), value),
    journey: () => ({ journey, ownership, path: journeyPath, place: journeyPlacements, evaluate: (expression, values) => evaluateExpression(expression, { values }) }),
    presentation: () => index,
    recordWritten: (targetPath, value, held) => store.setJourneyWritten(targetPath, value, held)
  });
  const recompute = (): RecomputeResult => orchestrator.recompute(store.snapshot());
  return {
    store,
    orchestrator,
    index,
    recompute,
    set: (path, value) => {
      store.setValue(parseComponentPath(path), value);
      return recompute();
    },
    values: () => store.snapshot().values,
    written: () => store.snapshot().journey?.written
  };
}

/** The fixture's journey with changes to its pages, by id. */
function applyWith(changes: Record<string, Partial<JourneyPage>>): Journey {
  const journey = applyJourney();
  return { ...journey, pages: journey.pages.map((page) => ({ ...page, ...(changes[page.id] ?? {}) })) };
}

/** The fixture's `income` page with one of its own fields changed. */
function incomeWith(id: string, change: Record<string, unknown>): Journey {
  const entries = (applyJourney().pages[1]?.components ?? []).map((entry) => (typeof entry !== "string" && entry.id === id ? { ...entry, ...change } : entry));
  return applyWith({ income: { components: entries } });
}

describe("RuntimeOrchestrator: the form pipeline never sees a presentation's own answers", () => {
  it("takes every `@` key the form does not define out of the form values, whatever journey runs or none", () => {
    const { orchestrator } = presentationHarness();
    expect(orchestrator.isPresentationKey("@apply.m1")).toBe(true);
    expect(orchestrator.isPresentationKey("@public.note")).toBe(true);
    expect(orchestrator.isPresentationKey("email")).toBe(false);
    expect(orchestrator.formValues({ email: "a@b.co", "@apply.m1": 1, "@public.note": "x", "@": 2 })).toEqual({ email: "a@b.co" });

    // No journey, no index: the keys an earlier presentation left are as far from the pipeline.
    const bare = new RuntimeOrchestrator(new ComponentTree(presentationRoot()), { eventBus: new EventBus(), formId: "f" });
    const store = new FormStateStore("en");
    store.setValue(parseComponentPath("@apply.m1"), 7);
    store.setValue(parseComponentPath("name"), "Ada");
    bare.recompute(store.snapshot());
    expect(bare.effectiveValues()).toEqual({ name: "Ada" });

    // A form that defines an `@` key keeps it: a hand-written collection path, say.
    const defining = presentationRoot();
    defining.children?.content?.push({ id: "rows", type: "repeatingSection", configuration: {}, collection: { collectionPath: "@rows" }, children: { content: [{ id: "sku", type: "text", configuration: {} }] } });
    const keeps = new RuntimeOrchestrator(new ComponentTree(defining), { eventBus: new EventBus(), formId: "f" });
    expect(keeps.isPresentationKey("@rows[0].sku")).toBe(false);
    expect(keeps.formValues({ "@rows[0].sku": "A1", "@apply.m1": 1 })).toEqual({ "@rows[0].sku": "A1" });
  });

  it("gives a form calculation that reads an own answer nothing to read, and keeps the own answers out of the submittable view", () => {
    const root = presentationRoot();
    root.children?.content?.push({ id: "first_month", type: "number", configuration: {}, rules: { value: "sum(`@apply.m1`)" } });
    const harness = presentationHarness({ root });
    harness.set("@apply.m1", 12000);
    expect(harness.values().first_month).toBe(0);
    expect(harness.values()["@apply.m1"]).toBe(12000);
    expect(harness.orchestrator.effectiveValues()).toEqual({ annual_income: 12000, first_month: 0 });
    expect(harness.orchestrator.effectiveValuesById()).toEqual({ annual_income: 12000, first_month: 0 });
  });
});

describe("RuntimeOrchestrator: worked-out values", () => {
  it("writes the form field from the page's own fields once one is answered, without marking it dirty", () => {
    const harness = presentationHarness();
    expect(harness.recompute().mappingsSettled).toBe(true);
    expect("annual_income" in harness.values()).toBe(false);
    expect(harness.written()).toBeUndefined();

    const first = harness.set("@apply.m1", 1000);
    expect(harness.values().annual_income).toBe(1000);
    expect(harness.written()).toEqual({ annual_income: 1000 });
    expect(first.computedWrites).toEqual([{ componentId: "annual_income", value: 1000 }]);
    expect(first.mappingsSettled).toBe(true);
    expect(harness.store.snapshot().dirty.has("annual_income")).toBe(false);

    harness.set("@apply.m2", 2000);
    harness.set("@apply.m3", 500);
    expect(harness.values().annual_income).toBe(3500);
    expect(harness.written()).toEqual({ annual_income: 3500 });
    // The path turns on it in the same recompute: the route reads the form field.
    harness.set("@apply.m3", 60000);
    expect(harness.orchestrator.lastJourneyTrace()?.pages).toEqual(["details", "income", "assist"]);
    // A recompute with nothing changed writes nothing.
    expect(harness.recompute().computedWrites).toEqual([]);
  });

  it("clears the field only while it still holds what it wrote, and then forgets the write", () => {
    const harness = presentationHarness();
    harness.set("@apply.m1", 1000);
    harness.set("@apply.m1", undefined);
    expect(harness.values().annual_income).toBeUndefined();
    expect(harness.written()).toBeUndefined();

    // An empty text box, a blank string: unanswered alike.
    harness.set("@apply.m2", 40);
    expect(harness.values().annual_income).toBe(40);
    harness.set("@apply.m2", "  ");
    expect(harness.values().annual_income).toBeUndefined();

    // Changed by someone else since: no longer the mapping's to clear.
    harness.set("@apply.m1", 5);
    harness.store.setValue(parseComponentPath("annual_income"), 99);
    harness.set("@apply.m1", undefined);
    expect(harness.values().annual_income).toBe(99);
    expect(harness.written()).toBeUndefined();
  });

  it("leaves a prefilled or drafted answer alone while every source is empty, and takes the field over once one is answered", () => {
    const harness = presentationHarness();
    harness.set("annual_income", 40000);
    harness.recompute();
    expect(harness.values().annual_income).toBe(40000);
    expect(harness.written()).toBeUndefined();

    harness.set("@apply.m1", 7);
    expect(harness.values().annual_income).toBe(7);
    harness.set("@apply.m1", undefined);
    expect(harness.values().annual_income).toBeUndefined();
  });

  it("knows its own writes across a resume: `written` restored clears, `written` lost keeps the answer", () => {
    const before = presentationHarness();
    before.set("@apply.m1", 1200);
    const saved = JSON.parse(JSON.stringify({ values: before.values(), written: before.written() })) as { values: Record<string, unknown>; written: Record<string, unknown> };
    expect(saved).toEqual({ values: { "@apply.m1": 1200, annual_income: 1200 }, written: { annual_income: 1200 } });

    const resume = (written: Record<string, unknown> | undefined): PresentationHarness => {
      const store = new FormStateStore("en");
      store.hydrate({ values: saved.values, touched: [], dirty: [], locale: "en" });
      store.restoreJourney({ journeyId: "apply", pageId: "income", completedPages: ["details"], written });
      const harness = presentationHarness({ store });
      harness.recompute();
      return harness;
    };

    const resumed = resume(saved.written);
    // Recomputed from the same sources: the same value, still the mapping's own.
    expect(resumed.values().annual_income).toBe(1200);
    expect(resumed.written()).toEqual({ annual_income: 1200 });
    resumed.set("@apply.m1", undefined);
    expect(resumed.values().annual_income).toBeUndefined();

    // A draft from before the sources were answered: the value is somebody's answer.
    const store = new FormStateStore("en");
    store.hydrate({ values: { annual_income: 1200 }, touched: [], dirty: [], locale: "en" });
    store.restoreJourney({ journeyId: "apply", pageId: "income", completedPages: ["details"] });
    const foreign = presentationHarness({ store });
    foreign.recompute();
    foreign.recompute();
    expect(foreign.values().annual_income).toBe(1200);
    expect(foreign.written()).toBeUndefined();
  });

  it("starts a recompute from the sources the last one could read, so a keystroke settles in one round — until the answers are replaced wholesale", () => {
    const harness = presentationHarness();
    harness.recompute();
    const folds = vi.spyOn(harness.orchestrator as unknown as { foldOver: (...args: unknown[]) => unknown }, "foldOver");
    harness.set("@apply.m1", 1000);
    expect(folds).toHaveBeenCalledTimes(1);
    expect(harness.values().annual_income).toBe(1000);
    // Forgotten — a draft put in — the next recompute reads no source before the overlay has
    // shown it under the new answers: one round more, to the same result.
    folds.mockClear();
    harness.orchestrator.forgetReadable();
    harness.set("@apply.m1", 2000);
    expect(folds).toHaveBeenCalledTimes(2);
    expect(harness.values().annual_income).toBe(2000);
    expect(harness.written()).toEqual({ annual_income: 2000 });
    folds.mockRestore();
  });

  it("reads only the sources that show: a hidden own field is absent, and a page off the path stops its mappings", () => {
    const hiding = presentationHarness({ journey: incomeWith("m2", { rules: { visibleWhen: nameIs("all") } }) });
    hiding.set("@apply.m1", 10);
    hiding.set("@apply.m2", 20);
    expect(hiding.values().annual_income).toBe(10);
    expect(hiding.orchestrator.stateOf("m2")?.effective.visible).toBe(false);
    hiding.set("name", "all");
    expect(hiding.values().annual_income).toBe(30);
    hiding.set("name", "some");
    expect(hiding.values().annual_income).toBe(10);

    // `income` skipped: its own fields are not shown, so the value it wrote is cleared; the
    // own answers stay, and the page works it out again once it is back on the path.
    const skipping = presentationHarness({ journey: applyWith({ details: { routes: [{ when: 'name != "ask"', to: "assist" }] } }) });
    skipping.set("name", "ask");
    skipping.set("@apply.m1", 300);
    expect(skipping.values().annual_income).toBe(300);
    skipping.set("name", "skip");
    expect(skipping.orchestrator.lastJourneyTrace()?.pages).toEqual(["details", "assist"]);
    expect(skipping.values().annual_income).toBeUndefined();
    expect(skipping.values()["@apply.m1"]).toBe(300);
    skipping.set("name", "ask");
    expect(skipping.values().annual_income).toBe(300);
  });

  it("reports worked-out values that do not settle, and settles once an answer lets them", () => {
    // `m2` shows only while the total is under 100 — the field it is summed into.
    const below = "annual_income < 100";
    const harness = presentationHarness({ journey: incomeWith("m2", { rules: { visibleWhen: below } }) });
    harness.set("@apply.m1", 50);
    expect(harness.orchestrator.lastMappingsSettled()).toBe(true);
    const flipping = harness.set("@apply.m2", 60);
    expect(flipping.mappingsSettled).toBe(false);
    expect(harness.orchestrator.lastMappingsSettled()).toBe(false);
    // Asked again, it still does not settle: no round leaves a state the next accepts.
    expect(harness.recompute().mappingsSettled).toBe(false);

    const settled = harness.set("@apply.m2", 10);
    expect(settled.mappingsSettled).toBe(true);
    expect(harness.values().annual_income).toBe(60);
  });

  it("stores what an expression that throws, or comes to nothing, leaves: nothing", () => {
    const journey = applyJourney();
    const node = journey.pages[1]?.components?.[3] as PresentationNode;
    // A function the compile is told of and the browser has none of: evaluating it throws.
    node.configuration = { ...node.configuration, value: "no_such_function()" };
    const harness = presentationHarness({ journey, signatures: [{ name: "no_such_function", min: 0, max: 0 }] });
    harness.set("annual_income", 5);
    harness.set("@apply.m1", 1);
    expect(harness.values().annual_income).toBeUndefined();
  });
});

describe("RuntimeOrchestrator: the overlay for a presentation's own nodes", () => {
  it("gives an own field its own rules' state on a page the path takes, and hides every own node of a page it skips", () => {
    const journey = incomeWith("m1", { configuration: { label: "Month 1", required: true } });
    const harness = presentationHarness({
      journey: { ...journey, pages: journey.pages.map((page) => (page.id === "details" ? { ...page, routes: [{ when: 'name != "ask"', to: "assist" }] } : page)) }
    });
    harness.set("name", "ask");
    expect(harness.orchestrator.stateOf("m1")).toMatchObject({
      effective: { visible: true, disabled: false, readonly: false, runValidation: true, requiredApplies: true, submitValue: false },
      required: true,
      own: { ownRequired: true }
    });
    expect(harness.orchestrator.stateOf("m2")?.required).toBe(false);
    harness.set("name", "skip");
    expect(harness.orchestrator.stateOf("m1")).toMatchObject({ effective: { visible: false, runValidation: false, requiredApplies: false, submitValue: false }, required: true });
    expect(harness.orchestrator.stateOf("income_total")?.effective.visible).toBe(false);
  });

  it("gives an alias and a worked-out value's copy the form field's state, the copy read-only", () => {
    const root = presentationRoot();
    const email = root.children?.content?.[0] as ComponentNode;
    email.configuration = { label: "Email", required: true, disabled: true };
    email.rules = { visibleWhen: nameIs("show") };
    const harness = presentationHarness({ root });
    harness.set("name", "hide");
    // Hidden with its target — and the page, holding nothing else, stays on the path, showing nothing.
    expect(harness.orchestrator.stateOf("work_email")?.effective).toMatchObject({ visible: false, disabled: true, runValidation: false });
    expect(harness.orchestrator.lastJourneyTrace()?.pages).toEqual(["details", "income"]);
    harness.set("name", "show");
    expect(harness.orchestrator.stateOf("work_email")?.effective).toEqual(harness.orchestrator.effectiveStateFor("email"));
    expect(harness.orchestrator.stateOf("work_email")?.effective).toMatchObject({ visible: true, disabled: true, submitValue: true });

    expect(harness.orchestrator.stateOf("income_total")?.effective).toEqual({ ...harness.orchestrator.effectiveStateFor("annual_income"), readonly: true });
    expect(harness.orchestrator.effectiveStateFor("annual_income")?.readonly).toBe(false);
    // The copy's marker is the form field's Required; it has none of its own to be held to.
    expect(harness.orchestrator.stateOf("income_total")).toMatchObject({ required: true, own: { ownRequired: false } });
  });

  it("marks an alias required by its own tick or rule, or by the form field's — and keeps the two apart", () => {
    const optionalTarget = presentationRoot();
    (optionalTarget.children?.content?.[0] as ComponentNode).configuration = { label: "Email" };
    const ticked = presentationHarness({ root: optionalTarget });
    ticked.recompute();
    expect(ticked.orchestrator.stateOf("work_email")).toMatchObject({ required: true, own: { ownRequired: true } });
    expect(ticked.orchestrator.isRequired("email")).toBe(false);

    const unticked = presentationHarness({ journey: applyWith({ details: { components: [{ id: "work_email", type: "text", configuration: { fills: "email" } }] } }) });
    unticked.recompute();
    expect(unticked.orchestrator.stateOf("work_email")).toMatchObject({ required: true, own: { ownRequired: false } });

    const byRule = presentationHarness({
      root: optionalTarget,
      journey: applyWith({ details: { components: [{ id: "work_email", type: "text", configuration: { fills: "email" }, rules: { requiredWhen: nameIs("must") } }] } })
    });
    byRule.recompute();
    expect(byRule.orchestrator.stateOf("work_email")?.required).toBe(false);
    byRule.set("name", "must");
    expect(byRule.orchestrator.stateOf("work_email")).toMatchObject({ required: true, own: { ownRequired: true } });
    // `rules: null`, hand-written, is no rule.
    const nullRules = presentationHarness({ root: optionalTarget, journey: applyWith({ details: { components: [{ id: "work_email", type: "text", configuration: { fills: "email" }, rules: null as unknown as Record<string, unknown> }] } }) });
    nullRules.recompute();
    expect(nullRules.orchestrator.stateOf("work_email")?.required).toBe(false);
  });

  it("evaluates own rules over the form's view plus the own answers by id, and never reads the visibility of a node mapped to the form", () => {
    const never = "false";
    const journey = applyWith({
      details: {
        components: [
          { id: "kind", type: "text", configuration: {} },
          { id: "extra", type: "text", configuration: { required: true }, rules: { visibleWhen: 'kind = "more"', enabledWhen: nameIs("Ada") } },
          { id: "work_email", type: "text", configuration: { fills: "email", hidden: true }, rules: { visibleWhen: never } },
          {
            id: "box",
            type: "fieldset",
            rules: { visibleWhen: never },
            children: { content: [{ type: "journey-field", configuration: { componentId: "name" } }, { id: "inside", type: "text" }] }
          },
          { id: "lonely", type: "fieldset", rules: { visibleWhen: never }, children: { content: [{ id: "within", type: "text", configuration: { required: true } }] } }
        ]
      }
    });
    const harness = presentationHarness({ journey });
    harness.recompute();
    expect(harness.orchestrator.stateOf("extra")?.effective).toMatchObject({ visible: false, disabled: true });
    harness.set("@apply.kind", "more");
    harness.set("name", "Ada");
    expect(harness.orchestrator.stateOf("extra")?.effective).toMatchObject({ visible: true, disabled: false });
    // An alias, and a layout holding a reference: shown whatever their own rules say.
    expect(harness.orchestrator.stateOf("work_email")?.effective.visible).toBe(true);
    expect(harness.orchestrator.stateOf("box")?.effective.visible).toBe(true);
    expect(harness.orchestrator.stateOf("inside")?.effective.visible).toBe(true);
    expect(harness.orchestrator.stateOf("@apply/ref-1")?.effective).toEqual(harness.orchestrator.effectiveStateFor("name"));
    // A layout of own content alone hides, and what it holds with it.
    expect(harness.orchestrator.stateOf("lonely")?.effective.visible).toBe(false);
    expect(harness.orchestrator.stateOf("within")?.effective).toMatchObject({ visible: false, runValidation: false, requiredApplies: false });
  });

  it("lays the own nodes after the form's in the merged maps, and keeps the form's own maps the form's", () => {
    const harness = presentationHarness();
    harness.recompute();
    const merged = [...harness.orchestrator.mergedEffectiveStates().keys()];
    expect(merged).toEqual(["form", "email", "name", "money", "annual_income", "approved_amount", "work_email", "m1", "m2", "m3", "income_total"]);
    expect([...harness.orchestrator.effectiveStates().keys()]).toEqual(["form", "email", "name", "money", "annual_income", "approved_amount"]);
    expect([...harness.orchestrator.mergedRequiredComponents()]).toEqual([
      ["email", true],
      ["name", false],
      ["money", false],
      ["annual_income", true],
      ["approved_amount", false],
      ["work_email", true],
      ["m1", false],
      ["m2", false],
      ["m3", false],
      ["income_total", true]
    ]);
    expect([...harness.orchestrator.requiredComponents().keys()]).toEqual(["email", "name", "money", "annual_income", "approved_amount"]);
    expect(harness.orchestrator.stateOf("nobody")).toBeUndefined();
    expect(harness.orchestrator.presentationStateOf("email")).toBeUndefined();
  });

  it("keeps its records free of a prototype: an own field called `isPrototypeOf` is a field like any other", () => {
    const journey = applyWith({
      income: {
        components: [
          { id: "isPrototypeOf", type: "number", configuration: { required: true } },
          { id: "toString", type: "number" },
          // Not an id at all (rule A): the entry is dropped, and nothing is polluted.
          { id: "__proto__", type: "number", configuration: { required: true } },
          { id: "income_total", type: "journey-value", configuration: { to: "annual_income", value: "sum(isPrototypeOf, toString)" } }
        ]
      }
    });
    const harness = presentationHarness({ journey });
    harness.recompute();
    expect(harness.index.order).toEqual(["work_email", "isPrototypeOf", "toString", "income_total"]);
    expect(harness.index.keyOf("isPrototypeOf")).toBe("@apply.isPrototypeOf");
    expect(harness.index.keyOf("__proto__")).toBeUndefined();
    expect(harness.index.keyOf("valueOf")).toBeUndefined();
    expect(harness.orchestrator.stateOf("isPrototypeOf")).toMatchObject({ required: true, effective: { visible: true } });
    expect(harness.orchestrator.stateOf("__proto__")).toBeUndefined();
    expect(harness.orchestrator.stateOf("hasOwnProperty")).toBeUndefined();
    // Unanswered, the sum is not written: an inherited member is no answer.
    expect("annual_income" in harness.values()).toBe(false);
    harness.set("@apply.isPrototypeOf", 3);
    harness.set("@apply.toString", 4);
    expect(harness.values().annual_income).toBe(7);
    expect(({} as Record<string, unknown>).required).toBeUndefined();
  });
});

/**
 * Formulas, run scopes and the clock in the browser: one day per recompute, the
 * plugins' functions on every rule context, a rule scoped to the server ignored here, and a
 * calculation that flips itself through its own answer refused as before.
 */
describe("RuntimeOrchestrator: the day, the functions and the run scopes", () => {
  const after = 'today() >= "2026-07-01"';
  /** `retained` names the fields that keep their answer while hidden: the default leaves it out of what other rules read. */
  function datedTree(rules: Record<string, ComponentNode["rules"]>, retained: string[] = []): ComponentTree {
    return new ComponentTree({
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: Object.entries(rules).map(([id, own]) => ({ id, type: "text", configuration: retained.includes(id) ? { hiddenValueBehavior: "retain" } : {}, ...(own !== undefined ? { rules: own } : {}) }))
      }
    });
  }

  it("reads the day once per recompute and hands it to every rule and calculation", () => {
    const days = ["2026-10-07", "2025-01-01"];
    const today = vi.fn(() => days.shift());
    const orchestrator = new RuntimeOrchestrator(datedTree({ late: { visibleWhen: after }, day: { value: "today()" }, gated: { requiredWhen: after } }), {
      eventBus: new EventBus(),
      formId: "f1",
      today
    });
    const store = new FormStateStore("en");
    orchestrator.recompute(store.snapshot());
    expect(today).toHaveBeenCalledTimes(1);
    expect(orchestrator.effectiveStateFor("late")?.visible).toBe(true);
    expect(orchestrator.isRequired("gated")).toBe(true);
    expect(orchestrator.effectiveValues().day).toBe("2026-10-07");
    orchestrator.recompute(store.snapshot());
    expect(today).toHaveBeenCalledTimes(2);
    expect(orchestrator.effectiveStateFor("late")?.visible).toBe(false);
    expect(orchestrator.isRequired("gated")).toBe(false);
    expect(orchestrator.effectiveValues().day).toBe("2025-01-01");
  });

  it("evaluates a clock rule as no day without a today dependency: today() is no answer", () => {
    const orchestrator = new RuntimeOrchestrator(datedTree({ late: { visibleWhen: after } }), { eventBus: new EventBus(), formId: "f1" });
    orchestrator.recompute(new FormStateStore("en").snapshot());
    expect(orchestrator.effectiveStateFor("late")?.visible).toBe(false);
  });

  it("ignores a rule scoped to the server, and applies one scoped to the browser or to both", () => {
    const hide = "false";
    const tree = datedTree({
      by_server: { visibleWhen: { formula: hide, run: "server" }, requiredWhen: { formula: "true", run: "server-secret" } },
      by_browser: { visibleWhen: { formula: hide, run: "browser" } },
      by_both: { visibleWhen: { formula: hide } },
      calc: { value: { formula: '"server"', run: "server" } },
      text_rule: { visibleWhen: "by_both = 1" }
    }, ["by_both"]); // text_rule reads by_both, which the hide rule hides: it must keep its answer to be read
    const orchestrator = new RuntimeOrchestrator(tree, { eventBus: new EventBus(), formId: "f1" });
    const store = new FormStateStore("en");
    store.setValue({ segments: [{ key: "calc" }] }, "sent");
    orchestrator.recompute(store.snapshot());
    expect(orchestrator.effectiveStateFor("by_server")?.visible).toBe(true);
    expect(orchestrator.isRequired("by_server")).toBe(false);
    expect(orchestrator.effectiveStateFor("by_browser")?.visible).toBe(false);
    expect(orchestrator.effectiveStateFor("by_both")?.visible).toBe(false);
    expect(orchestrator.effectiveValues().calc).toBe("sent");
    // A rule written as text is parsed here, once, and read like its tree.
    expect(orchestrator.effectiveStateFor("text_rule")?.visible).toBe(false);
    store.setValue({ segments: [{ key: "by_both" }] }, 1);
    orchestrator.recompute(store.snapshot());
    expect(orchestrator.effectiveStateFor("text_rule")?.visible).toBe(true);
  });

  it("puts the plugins' functions on every rule context", () => {
    // Compiled copies, as a `FormRuntime` that knows the plugin hands them over: the orchestrator reads the trees.
    const shout = { kind: "call", name: "shout", args: [{ kind: "path", path: "name" }] } as unknown as Expression;
    const shown = { kind: "binary", operator: "eq", left: shout, right: { kind: "literal", value: "ADA" } } as unknown as RuleSource;
    const orchestrator = new RuntimeOrchestrator(datedTree({ name: undefined, loud: { value: shout as unknown as RuleSource }, shown: { visibleWhen: shown } }), {
      eventBus: new EventBus(),
      formId: "f1",
      functions: { shout: (args) => String(args[0] ?? "").toUpperCase() }
    });
    const store = new FormStateStore("en");
    store.setValue({ segments: [{ key: "name" }] }, "Ada");
    orchestrator.recompute(store.snapshot());
    expect(orchestrator.effectiveValues().loud).toBe("ADA");
    expect(orchestrator.effectiveStateFor("shown")?.visible).toBe(true);
  });

  it("reads a plugin function's result that is not plain data as no answer, with one warning naming the function", () => {
    class Money {
      public readonly cents = 1;
    }
    const call = (name: string): RuleSource => ({ kind: "call", name, args: [] }) as unknown as RuleSource;
    const results: Record<string, () => unknown> = {
      nan: () => Number.NaN,
      later: () => Promise.resolve(1),
      fn: () => () => 1,
      when: () => new Date(0),
      money: () => new Money(),
      fine: () => ({ cents: 5 })
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const orchestrator = new RuntimeOrchestrator(
        datedTree({
          a: { value: call("nan") },
          b: { value: call("later") },
          c: { value: call("fn") },
          d: { value: call("when") },
          e: { value: call("money") },
          f: { visibleWhen: call("fine") },
          g: { visibleWhen: call("later") }
        }),
        { eventBus: new EventBus(), formId: "f1", functions: Object.fromEntries(Object.entries(results).map(([name, make]) => [name, () => make()])) }
      );
      const store = new FormStateStore("en");
      // Several recomputes, and nothing throws "did not converge": each result is no answer, stably.
      expect(() => orchestrator.recompute(store.snapshot())).not.toThrow();
      expect(() => orchestrator.recompute(store.snapshot())).not.toThrow();
      const values = orchestrator.effectiveValues();
      for (const id of ["a", "b", "c", "d", "e"]) {
        expect(values[id], id).toBeUndefined();
      }
      // A promise in a condition is no answer, so the field is not shown (it was always true before).
      expect(orchestrator.effectiveStateFor("g")?.visible).toBe(false);
      // A plain object is data: it passes through untouched, but it is not a yes (strict truthiness), so the field is not shown.
      expect(orchestrator.effectiveStateFor("f")?.visible).toBe(false);
      const lines = warn.mock.calls.map((callArgs) => String(callArgs[0]));
      for (const name of ["nan", "later", "fn", "when", "money"]) {
        expect(lines.filter((line) => line.includes(`"${name}"`)), name).toHaveLength(1);
      }
      expect(lines.filter((line) => line.includes('"fine"'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("says a size cap that tripped in a rule once, naming the function and the cap", () => {
    const long = 'padStart("a", 20000, "b")';
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const orchestrator = new RuntimeOrchestrator(datedTree({ padded: { value: long } }), { eventBus: new EventBus(), formId: "f1" });
      const store = new FormStateStore("en");
      orchestrator.recompute(store.snapshot());
      orchestrator.recompute(store.snapshot());
      const lines = warn.mock.calls.map((callArgs) => String(callArgs[0])).filter((line) => line.includes("padStart"));
      expect(lines).toEqual(["[FormRuntime] formula function: padStart: the length is clamped to the 10,000 character cap (text.truncated)"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("gives a calculation over an empty operand no answer: the field stays empty, and fills once the operand is typed", () => {
    // The demo fee rule, `employees * 2`, before Employees is answered: no answer, never NaN.
    const double = "employees * 2";
    const store = new FormStateStore("en");
    const orchestrator = new RuntimeOrchestrator(
      new ComponentTree({
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "employees", type: "number", configuration: {} },
            { id: "fee", type: "number", configuration: {}, rules: { value: double } },
            { id: "fee_known", type: "text", configuration: {}, rules: { visibleWhen: "fee != null" } }
          ]
        }
      }),
      // The runtime's wiring: a computed value lands in the store (`FormRuntime.applyComputedValue`).
      { eventBus: new EventBus(), formId: "f1", applyComputedValue: (id, value) => store.setComputedValue(parseComponentPath(id), value) }
    );
    const empty = orchestrator.recompute(store.snapshot());
    expect(empty.computedWrites).toEqual([]);
    expect("fee" in orchestrator.effectiveValues()).toBe(false);
    expect(orchestrator.effectiveValues().fee).toBeUndefined();
    expect(orchestrator.effectiveStateFor("fee_known")?.visible).toBe(false);

    store.setValue(parseComponentPath("employees"), 21);
    const typed = orchestrator.recompute(store.snapshot());
    expect(typed.computedWrites).toEqual([{ componentId: "fee", value: 42 }]);
    expect(orchestrator.effectiveValues().fee).toBe(42);
    expect(orchestrator.effectiveStateFor("fee_known")?.visible).toBe(true);

    // Cleared again: the answer goes, and nothing stored is NaN.
    store.setValue(parseComponentPath("employees"), "");
    const cleared = orchestrator.recompute(store.snapshot());
    expect(cleared.computedWrites).toEqual([{ componentId: "fee", value: undefined }]);
    expect(orchestrator.effectiveValues().fee).toBeUndefined();
    expect(store.snapshot().values.fee).toBeUndefined();
    expect(Object.values(store.snapshot().values).some((value) => typeof value === "number" && !Number.isFinite(value))).toBe(false);
    expect(orchestrator.effectiveStateFor("fee_known")?.visible).toBe(false);
  });

  it("refuses a calculation whose if flips itself through its own answer: it does not converge", () => {
    const flip = "if component = 1 then 2 else 1";
    const orchestrator = new RuntimeOrchestrator(datedTree({ flipper: { value: flip } }), { eventBus: new EventBus(), formId: "f1" });
    expect(() => orchestrator.recompute(new FormStateStore("en").snapshot())).toThrow(/did not converge/);
  });

  it("works calculations out in dependency order: a chain declared sources-last settles in two passes, whatever its length", () => {
    // k0 = k1 + 1 ... k(n-1) = tick(x) + 1: document order is the worst order. The count of
    // passes is the count of times the last link, which reads `tick`, is worked out.
    for (const n of [50, 200, 400]) {
      let passes = 0;
      const links: ComponentNode[] = [{ id: "x", type: "number", configuration: {} }];
      for (let i = 0; i < n; i += 1) {
        const rule: RuleSource =
          i === n - 1
            ? ({ kind: "arithmetic", operator: "add", left: { kind: "call", name: "tick", args: [{ kind: "path", path: "x" }] }, right: { kind: "literal", value: 1 } } as unknown as RuleSource)
            : `k${i + 1} + 1`;
        links.push({ id: `k${i}`, type: "number", configuration: {}, rules: { value: rule } } as ComponentNode);
      }
      const orchestrator = new RuntimeOrchestrator(new ComponentTree({ id: "root", type: "form", configuration: {}, children: { content: links } }), {
        eventBus: new EventBus(),
        formId: "f1",
        functions: { tick: (args) => { passes += 1; return args[0]; } }
      });
      const store = new FormStateStore("en");
      store.setValue(parseComponentPath("x"), 1);
      orchestrator.recompute(store.snapshot());
      expect(orchestrator.effectiveValues().k0).toBe(n + 1);
      expect(passes).toBeLessThanOrEqual(2);
    }
  });

  it("settles a calculation that returns a fresh list or object each pass", () => {
    const tree = new ComponentTree({
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "t", type: "text", configuration: {} },
          { id: "parts", type: "text", configuration: {}, rules: { value: 'split(t, ",")' } },
          { id: "shape", type: "text", configuration: {}, rules: { value: { kind: "call", name: "makeShape", args: [{ kind: "path", path: "t" }] } } },
          { id: "first", type: "text", configuration: {}, rules: { value: "first(parts)" } }
        ]
      }
    } as unknown as ComponentNode);
    const orchestrator = new RuntimeOrchestrator(tree, {
      eventBus: new EventBus(),
      formId: "f1",
      functions: { makeShape: (args) => ({ text: args[0], list: [1, 2] }) }
    });
    const store = new FormStateStore("en");
    store.setValue(parseComponentPath("t"), "a,b,c");
    expect(() => orchestrator.recompute(store.snapshot())).not.toThrow();
    expect(orchestrator.effectiveValues().parts).toEqual(["a", "b", "c"]);
    expect(orchestrator.effectiveValues().shape).toEqual({ text: "a,b,c", list: [1, 2] });
    expect(orchestrator.effectiveValues().first).toBe("a");
  });
});

describe("RuntimeOrchestrator: ancestors, views and the answers it is handed", () => {
  function nestedTree(): ComponentTree {
    return new ComponentTree({
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "outer",
            type: "container",
            configuration: {},
            children: { content: [{ id: "inner", type: "container", configuration: {}, children: { content: [{ id: "leaf", type: "text", configuration: {} }] } }] }
          },
          { id: "top", type: "text", configuration: {} }
        ]
      }
    } as unknown as ComponentNode);
  }

  /** A resolver that records what `ancestorValuesFor` hands a rule, per component. */
  function recordingResolver(seen: Record<string, Record<string, unknown>>) {
    return {
      resolve: (node: ComponentNode, context: { ancestorValuesFor(id: string): Record<string, unknown> }) => {
        seen[node.id] = context.ancestorValuesFor(node.id);
        return { visible: true, disabled: false, readonly: false, requiredApplies: true, runValidation: true, submitValue: true, clearValue: false } as never;
      }
    };
  }

  it("hands a rule its ancestors nearest first with their answers, without searching the tree for them", () => {
    const tree = nestedTree();
    const parentOf = vi.spyOn(tree, "parentOf");
    const ancestorsOf = vi.spyOn(tree, "ancestorsOf");
    const seen: Record<string, Record<string, unknown>> = {};
    const orchestrator = new RuntimeOrchestrator(tree, { eventBus: new EventBus(), formId: "f", semanticStateResolver: recordingResolver(seen) });
    const store = new FormStateStore("en");
    store.setValue(parseComponentPath("outer"), "O");
    store.setValue(parseComponentPath("outer.inner"), "I");
    parentOf.mockClear();
    ancestorsOf.mockClear();

    orchestrator.recompute(store.snapshot());

    expect(Object.keys(seen.leaf ?? {})).toEqual(["inner", "outer", "root"]);
    expect(seen.leaf).toEqual({ inner: "I", outer: "O", root: undefined });
    expect(Object.keys(seen.top ?? {})).toEqual(["root"]);
    expect(seen.root).toEqual({});
    // The same chain the tree gives.
    expect(Object.keys(seen.leaf ?? {})).toEqual(new ComponentTree(nestedTree().getRoot()).ancestorsOf("leaf").map((node) => node.id));
    expect(parentOf).not.toHaveBeenCalled();
    expect(ancestorsOf).not.toHaveBeenCalled();
  });

  it("reads an id the tree does not hold as having no ancestors", () => {
    const seen: Record<string, Record<string, unknown>> = {};
    let ask: ((id: string) => Record<string, unknown>) | undefined;
    const resolver = {
      resolve: (node: ComponentNode, context: { ancestorValuesFor(id: string): Record<string, unknown> }) => {
        ask = context.ancestorValuesFor;
        return recordingResolver(seen).resolve(node, context);
      }
    };
    const orchestrator = new RuntimeOrchestrator(nestedTree(), { eventBus: new EventBus(), formId: "f", semanticStateResolver: resolver });
    orchestrator.recompute(new FormStateStore("en").snapshot());
    expect(ask?.("nobody")).toEqual({});
    expect(ask?.("constructor")).toEqual({});
  });

  function deepFreezeState<T extends object>(state: T): T {
    const seen = new Set<object>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object" || seen.has(value) || value instanceof Set) {
        return;
      }
      seen.add(value);
      Object.freeze(value);
      for (const key of Object.keys(value)) {
        walk((value as Record<string, unknown>)[key]);
      }
    };
    walk(state);
    return state;
  }

  function calculatedTree(): ComponentTree {
    return new ComponentTree({
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "a", type: "number", configuration: {} },
          { id: "b", type: "number", configuration: {} },
          { id: "total", type: "number", configuration: {}, rules: { value: "a + b" } },
          { id: "note", type: "text", configuration: {}, rules: { defaultValue: '"n/a"' } }
        ]
      }
    } as unknown as ComponentNode);
  }

  it("never writes into the state it is handed: a calculation, a default and a presentation's keys all land in its own copy", () => {
    const orchestrator = new RuntimeOrchestrator(calculatedTree(), { eventBus: new EventBus(), formId: "f" });
    const store = new FormStateStore("en");
    store.setValue(parseComponentPath("a"), 2);
    store.setValue(parseComponentPath("b"), 3);
    store.setValue(parseComponentPath("@apply.m1"), 9);
    const state = deepFreezeState(store.snapshot());
    const before = JSON.parse(JSON.stringify(state.values)) as Record<string, unknown>;

    const result = orchestrator.recompute(state);

    expect(state.values).toEqual(before);
    expect(result.computedWrites).toEqual([
      { componentId: "total", value: 5 },
      { componentId: "note", value: "n/a" }
    ]);
    expect(orchestrator.effectiveValues()).toEqual({ a: 2, b: 3, total: 5, note: "n/a" });
  });

  it("reads the handed answers as they are when nothing writes into them, and still keeps a presentation's keys out", () => {
    const tree = new ComponentTree({
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "a", type: "text", configuration: {} }, { id: "b", type: "text", configuration: {}, rules: { visibleWhen: 'a = "x"' } }] }
    } as unknown as ComponentNode);
    const orchestrator = new RuntimeOrchestrator(tree, { eventBus: new EventBus(), formId: "f" });
    const store = new FormStateStore("en");
    store.setValue(parseComponentPath("a"), "x");
    store.setValue(parseComponentPath("b"), "kept");
    const plain = deepFreezeState(store.snapshot());
    orchestrator.recompute(plain);
    expect(orchestrator.effectiveStateFor("b")?.visible).toBe(true);
    expect(orchestrator.effectiveValues()).toEqual({ a: "x", b: "kept" });

    store.setValue(parseComponentPath("@apply.m1"), 1);
    const withOwn = deepFreezeState(store.snapshot());
    orchestrator.recompute(withOwn);
    expect(orchestrator.effectiveValues()).toEqual({ a: "x", b: "kept" });
    expect(Object.keys(withOwn.values)).toContain("@apply.m1");
  });

  it("never writes into the state a running presentation is handed: worked-out values go to the store and its journey record", () => {
    const harness = presentationHarness();
    harness.store.setValue(parseComponentPath("@apply.m1"), 12000);
    const state = deepFreezeState(harness.store.snapshot());
    const values = JSON.parse(JSON.stringify(state.values)) as Record<string, unknown>;
    const written = JSON.parse(JSON.stringify(state.journey?.written ?? {})) as Record<string, unknown>;

    const result = harness.orchestrator.recompute(state);

    expect(state.values).toEqual(values);
    expect(state.journey?.written ?? {}).toEqual(written);
    expect(result.mappingsSettled).toBe(true);
  });

  it("builds a recompute's maps and submittable copy when first read, from that recompute's own fold", () => {
    const orchestrator = new RuntimeOrchestrator(calculatedTree(), { eventBus: new EventBus(), formId: "f" });
    const store = new FormStateStore("en");
    store.setValue(parseComponentPath("a"), 1);
    store.setValue(parseComponentPath("b"), 1);
    const first = orchestrator.recompute(store.snapshot());
    store.setValue(parseComponentPath("a"), 10);
    const second = orchestrator.recompute(store.snapshot());

    expect(first.effectiveValues).toEqual({ a: 1, b: 1, total: 2, note: "n/a" });
    expect(first.effectiveValues).toBe(first.effectiveValues);
    expect(second.effectiveValues).toEqual({ a: 10, b: 1, total: 11, note: "n/a" });
    expect(second.effectiveValues).toEqual(orchestrator.effectiveValues());
    expect(second.effectiveStates).toBe(orchestrator.effectiveStates());
    expect(second.requiredByNode).toBe(orchestrator.requiredComponents());
    // Document order, every node the fold judged.
    expect([...second.effectiveStates.keys()]).toEqual(["root", "a", "b", "total", "note"]);
    expect([...second.requiredByNode.keys()]).toEqual(["a", "b", "total", "note"]);
    expect(orchestrator.effectiveStateFor("total")).toBe(second.effectiveStates.get("total"));
    expect(orchestrator.isRequired("a")).toBe(second.requiredByNode.get("a"));
    expect(orchestrator.isRequired("nobody")).toBe(false);
    expect(orchestrator.stateOf("nobody")).toBeUndefined();
  });

  it("reports the node count of the fold in RECOMPUTE_COMPLETED", () => {
    const bus = new EventBus();
    const counts: unknown[] = [];
    bus.subscribe(FormEventType.RECOMPUTE_COMPLETED, (event) => counts.push((event.data as { nodeCount: number }).nodeCount));
    const orchestrator = new RuntimeOrchestrator(calculatedTree(), { eventBus: bus, formId: "f" });
    orchestrator.recompute(new FormStateStore("en").snapshot());
    expect(counts).toEqual([5]);
    expect(orchestrator.effectiveStates().size).toBe(5);
  });
});
