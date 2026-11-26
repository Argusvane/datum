import { describe, expect, it } from "vitest";

import {
  JOURNEY_END,
  PRESENTATION_REFERENCE_TYPE,
  PRESENTATION_VALUE_TYPE,
  findJourney,
  isPresentationEntry,
  isPresentationReference,
  journeyEndValidation,
  journeyHasOwnNodes,
  journeyPageFormIds,
  journeyPageKind,
  journeyPageValidation,
  journeyReviewSettings,
  readDefaultJourneyId,
  readJourneyConfiguration,
  readJourneys,
  resolveJourneySelection,
  validateJourneyShape,
  type Journey,
  type JourneyConfiguration,
  type JourneyPageEntry
} from "../form-engine/core/schema/journey.js";
import { kernelIsJourney, kernelIsPresentationNode, runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { applyJourney, incomeExpression, presentationForm, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";

const apply: Journey = { id: "apply", pages: [{ id: "start", components: ["name"] }] };
const renew: Journey = { id: "renew", pages: [{ id: "lookup", components: ["number"] }] };

function definitionWith(journey: JourneyConfiguration | unknown): { journey?: unknown } {
  return { journey };
}

describe("journey readers", () => {
  it("read nothing from a definition without journeys, or with junk where they go", () => {
    expect(readJourneys(undefined)).toEqual([]);
    expect(readJourneys({})).toEqual([]);
    expect(readJourneys(definitionWith("journeys"))).toEqual([]);
    expect(readJourneys(definitionWith([apply]))).toEqual([]);
    expect(readJourneys(definitionWith({ journeys: "apply" }))).toEqual([]);
    expect(readJourneyConfiguration(undefined)).toEqual({ journeys: [] });
    expect(readDefaultJourneyId(definitionWith(null))).toBeUndefined();
  });

  it("keep the usable journeys, in order, and drop the rest", () => {
    const definition = definitionWith({
      journeys: [null, apply, { pages: [] }, { id: "broken", pages: "none" }, renew, 7]
    });
    expect(readJourneys(definition).map((journey) => journey.id)).toEqual(["apply", "renew"]);
  });

  it("read the default and opensAs only when they are what they should be", () => {
    expect(readJourneyConfiguration(definitionWith({ journeys: [apply], defaultJourneyId: "apply", opensAs: "form" }))).toEqual({
      journeys: [apply],
      defaultJourneyId: "apply",
      opensAs: "form"
    });
    expect(readJourneyConfiguration(definitionWith({ journeys: [apply], defaultJourneyId: 3, opensAs: "wizard" }))).toEqual({
      journeys: [apply]
    });
    expect(readDefaultJourneyId(definitionWith({ defaultJourneyId: "" }))).toBeUndefined();
    expect(readDefaultJourneyId(definitionWith({ defaultJourneyId: "renew" }))).toBe("renew");
  });
});

describe("validateJourneyShape", () => {
  it("accepts a well-formed journey, validation settings included", () => {
    expect(
      validateJourneyShape({
        id: "apply",
        offPathValues: "retain",
        progress: "count",
        validation: { continue: "defer", server: true, onUnavailable: "continue", end: "server" },
        pages: [
          {
            id: "start",
            kind: "questions",
            components: ["name"],
            routes: [{ to: JOURNEY_END }, { when: { kind: "path", path: "name" }, to: "next" }],
            validation: { continue: "page", server: false }
          },
          { id: "stop", kind: "exit" }
        ]
      })
    ).toEqual([]);
  });

  it("says what is wrong with the journey itself", () => {
    expect(validateJourneyShape("apply")).toEqual(["a journey must be an object"]);
    expect(validateJourneyShape([])).toEqual(["a journey must be an object"]);
    expect(validateJourneyShape({ pages: [] })).toEqual(["a journey needs an id"]);
    expect(validateJourneyShape({ id: "apply" })).toEqual(['journey "apply" needs a pages list']);
    expect(validateJourneyShape({ id: "", pages: {} })).toEqual(["a journey needs an id", "journey needs a pages list"]);
    expect(validateJourneyShape({ id: "apply", pages: [], offPathValues: "hide", progress: "bar" })).toEqual([
      'journey "apply" offPathValues must be "retain", "clear" or "exclude-from-submission"',
      'journey "apply" progress must be "none" or "count"'
    ]);
    expect(validateJourneyShape({ id: "apply", pages: [], validation: "strict" })).toEqual([
      'journey "apply".validation must be an object'
    ]);
    expect(
      validateJourneyShape({ id: "apply", pages: [], validation: { continue: "skip", server: "yes", onUnavailable: "wait", end: "both" } })
    ).toEqual([
      'journey "apply".validation.continue must be "page" or "defer"',
      'journey "apply".validation.server must be a boolean',
      'journey "apply".validation.onUnavailable must be "block" or "continue"',
      'journey "apply".validation.end must be "client" or "server"'
    ]);
  });

  it("says what is wrong with each page and route", () => {
    const problems = validateJourneyShape({
      id: "apply",
      pages: [
        "start",
        { kind: "questions" },
        { id: "a", kind: "summary", components: "name" },
        { id: "b", components: ["name", 3], when: 7 },
        { id: "c", routes: { to: "d" } },
        { id: "d", routes: [{ to: "" }, { when: { value: true }, to: "e" }, null] },
        { id: "e", validation: { end: "server" } }
      ]
    });
    expect(problems).toEqual([
      'journey "apply" page 1 must be an object',
      'journey "apply" page 2 needs an id',
      'journey "apply" page 3 has an unknown kind',
      'journey "apply" page 3 components must be a list of component ids and nodes',
      'journey "apply" page 4 components must be a list of component ids and nodes',
      'journey "apply" page 4 has a when, but a page has no condition of its own; branch with a route on the page before it',
      'journey "apply" page 5 routes must be a list',
      'journey "apply" page 6 route 1 needs a target',
      'journey "apply" page 6 route 2 when must be an expression',
      'journey "apply" page 6 route 3 needs a target',
      'journey "apply" page 7.validation.end is set on the journey, not on a page'
    ]);
  });
});

describe("validateJourneyShape: page ids are unique", () => {
  it("rejects two pages sharing an id, in the shape check and the kernel alike", () => {
    const journey = { id: "j", pages: [{ id: "p", components: ["a"] }, { id: "q" }, { id: "p", components: ["b"] }] };
    const problems = validateJourneyShape(journey);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('repeats the page id "p"');
    expect(kernelIsJourney(journey)).toBe(false);
    expect(validateJourneyShape({ id: "j", pages: [{ id: "p" }, { id: "q" }] })).toEqual([]);
  });
});

describe("validateJourneyShape: a page has no condition of its own", () => {
  it("rejects a page carrying a when, whatever it holds, in the shape check and the kernel alike", () => {
    for (const when of [{ kind: "literal", value: true }, "name = \"x\"", { formula: "true" }, 7, null, ""]) {
      const journey = { id: "j", pages: [{ id: "p", components: ["a"] }, { id: "q", components: ["b"], when }] };
      expect(validateJourneyShape(journey)).toEqual([
        'journey "j" page 2 has a when, but a page has no condition of its own; branch with a route on the page before it'
      ]);
      expect(kernelIsJourney(journey)).toBe(false);
      expect(readJourneys(definitionWith({ journeys: [journey] }))).toEqual([]);
    }
  });

  it("accepts the same branching written as a route on the page before", () => {
    const journey = { id: "j", pages: [{ id: "p", components: ["a"], routes: [{ when: { kind: "literal", value: false }, to: "r" }] }, { id: "q", components: ["b"] }, { id: "r" }] };
    expect(validateJourneyShape(journey)).toEqual([]);
    expect(kernelIsJourney(journey)).toBe(true);
  });
});

describe("findJourney", () => {
  const definition = definitionWith({ journeys: [apply, renew], defaultJourneyId: "renew" });

  it("finds a journey by id, and nothing for an id the definition does not have", () => {
    expect(findJourney(definition, "apply")).toBe(apply);
    expect(findJourney(definition, "missing")).toBeUndefined();
  });

  it("falls back to the default, then to the first journey", () => {
    expect(findJourney(definition)?.id).toBe("renew");
    expect(findJourney(definitionWith({ journeys: [apply, renew], defaultJourneyId: "gone" }))?.id).toBe("apply");
    expect(findJourney(definitionWith({ journeys: [apply, renew] }))?.id).toBe("apply");
    expect(findJourney(definitionWith({ journeys: [] }))).toBeUndefined();
    expect(findJourney(undefined)).toBeUndefined();
  });
});

describe("resolveJourneySelection", () => {
  const journeys = definitionWith({ journeys: [apply, renew], defaultJourneyId: "renew" });
  const opensAsForm = definitionWith({ journeys: [apply, renew], defaultJourneyId: "renew", opensAs: "form" });
  const none = definitionWith({ journeys: [] });

  it("opens the journey a host names", () => {
    expect(resolveJourneySelection(journeys, "apply")).toEqual({ selection: { kind: "journey", journeyId: "apply" } });
    expect(resolveJourneySelection(opensAsForm, "apply")).toEqual({ selection: { kind: "journey", journeyId: "apply" } });
  });

  it("falls back to the definition's choice for a journey it does not have, and says so", () => {
    expect(resolveJourneySelection(journeys, "missing")).toEqual({
      selection: { kind: "journey", journeyId: "renew" },
      unknownJourneyId: "missing"
    });
    expect(resolveJourneySelection(opensAsForm, "missing")).toEqual({
      selection: { kind: "form" },
      unknownJourneyId: "missing"
    });
    expect(resolveJourneySelection(none, "missing")).toEqual({ selection: { kind: "form" }, unknownJourneyId: "missing" });
  });

  it("opens the whole form for \"form\"", () => {
    expect(resolveJourneySelection(journeys, "form")).toEqual({ selection: { kind: "form" } });
    expect(resolveJourneySelection(none, "form")).toEqual({ selection: { kind: "form" } });
  });

  it("opens the default journey for \"journey\", even when the definition opens as a form", () => {
    expect(resolveJourneySelection(journeys, "journey")).toEqual({ selection: { kind: "journey", journeyId: "renew" } });
    expect(resolveJourneySelection(opensAsForm, "journey")).toEqual({ selection: { kind: "journey", journeyId: "renew" } });
    expect(resolveJourneySelection(none, "journey")).toEqual({ selection: { kind: "form" } });
  });

  it("lets the definition decide when the host does not: opensAs, then the default, then the first", () => {
    expect(resolveJourneySelection(journeys)).toEqual({ selection: { kind: "journey", journeyId: "renew" } });
    expect(resolveJourneySelection(journeys, "")).toEqual({ selection: { kind: "journey", journeyId: "renew" } });
    expect(resolveJourneySelection(opensAsForm)).toEqual({ selection: { kind: "form" } });
    expect(resolveJourneySelection(definitionWith({ journeys: [apply, renew], opensAs: "journey" }))).toEqual({
      selection: { kind: "journey", journeyId: "apply" }
    });
    expect(resolveJourneySelection(definitionWith({ journeys: [apply, renew], defaultJourneyId: "gone" }))).toEqual({
      selection: { kind: "journey", journeyId: "apply" }
    });
  });

  it("opens the whole form when the definition has no journeys", () => {
    expect(resolveJourneySelection(none)).toEqual({ selection: { kind: "form" } });
    expect(resolveJourneySelection(undefined)).toEqual({ selection: { kind: "form" } });
    expect(resolveJourneySelection({})).toEqual({ selection: { kind: "form" } });
  });
});

describe("journey validation settings", () => {
  it("fill in the defaults when neither the journey nor the page says", () => {
    expect(journeyPageValidation(apply, apply.pages[0])).toEqual({ continue: "defer", server: false, onUnavailable: "block" });
    expect(journeyPageValidation(apply, undefined)).toEqual({ continue: "defer", server: false, onUnavailable: "block" });
    expect(journeyEndValidation(apply)).toBe("client");
  });

  it("take the page's own settings over the journey's, key by key", () => {
    const journey: Journey = {
      id: "apply",
      validation: { continue: "defer", server: true, end: "server" },
      pages: [
        { id: "a" },
        { id: "b", validation: { continue: "page" } },
        { id: "c", validation: { server: false, onUnavailable: "continue" } }
      ]
    };
    expect(journeyPageValidation(journey, journey.pages[0])).toEqual({ continue: "defer", server: true, onUnavailable: "block" });
    expect(journeyPageValidation(journey, journey.pages[1])).toEqual({ continue: "page", server: true, onUnavailable: "block" });
    expect(journeyPageValidation(journey, journey.pages[2])).toEqual({ continue: "defer", server: false, onUnavailable: "continue" });
    expect(journeyEndValidation(journey)).toBe("server");
  });

  it("read a page's kind as questions unless it says exit or review", () => {
    expect(journeyPageKind({ id: "a" })).toBe("questions");
    expect(journeyPageKind({ id: "a", kind: "exit" })).toBe("exit");
    expect(journeyPageKind({ id: "a", kind: "review" })).toBe("review");
    expect(journeyPageKind({ id: "a", kind: "summary" as never })).toBe("questions");
  });
});

/**
 * Nodes a presentation owns: a page's `components` may hold objects beside the ids
 * of form components. The shape check is what decides whether a journey is read at all — the
 * browser drops a malformed one (`readJourneys`), the kernel refuses it (`journey.invalid`) —
 * so both sides must accept exactly the same shapes.
 */
const expression = incomeExpression();
const reference = (componentId: unknown = "email", extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "journey-field",
  configuration: { componentId },
  ...extra
});
const own = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "own", type: "text", ...extra });
const layout = (children: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "box", type: "fieldset", children, ...extra });
const workedOut = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "total",
  type: "journey-value",
  configuration: { to: "annual_income", value: expression },
  ...extra
});
/** A journey whose one page holds `entries`. */
const holding = (...entries: unknown[]): unknown => ({ id: "j", pages: [{ id: "p", components: entries }] });

/** `layers` layouts, one inside the other, around `innermost`. */
function nested(layers: number, innermost: unknown): unknown {
  let node: unknown = innermost;
  for (let depth = layers; depth > 0; depth -= 1) {
    node = { id: `layer_${depth}`, type: "fieldset", children: { content: [node] } };
  }
  return node;
}

/** Every shape a page entry may take: both checks accept each. */
const WELL_FORMED: Array<[string, unknown]> = [
  ["a component id", "email"],
  ["an own field", own()],
  ["an own field with a configuration and rules", own({ configuration: { label: "Own", required: true }, rules: { visibleWhen: { kind: "literal", value: true } } })],
  ["an own field with empty records", own({ configuration: {}, rules: {}, children: {} })],
  ["an alias", own({ configuration: { fills: "email" } })],
  ["a worked-out value", workedOut()],
  ["a worked-out value with a label", workedOut({ configuration: { to: "annual_income", value: expression, label: "Annual income" } })],
  ["a worked-out value that also names a field to fill (checked alike, never read)", workedOut({ configuration: { to: "annual_income", value: expression, fills: "email" } })],
  ["a reference at the top of a page", reference()],
  ["a reference with an id of any kind (ignored)", reference("email", { id: 7 })],
  ["a reference with rules (ignored)", reference("email", { rules: "anything" })],
  ["a layout holding references and own nodes", layout({ content: [reference("email"), reference("name"), own({ id: "note", type: "html" })] })],
  ["a layout with several slots, one empty", layout({ left: [own()], right: [] })],
  ["a layout inside a layout", layout({ content: [{ id: "inner", type: "grid", children: { content: [reference("name"), workedOut()] } }] })],
  ["a node with keys the engine does not know", own({ collection: { itemFields: [] }, anything: [1, 2, 3] })],
  ["a type the engine does not know", { id: "odd", type: "custom-widget" }],
  ["an id off the component-id grammar (a usability matter, not a shape)", own({ id: "9 lives" })]
];

/** Shapes neither check may let through: each drops the journey in the browser and refuses it in the kernel. */
const MALFORMED: Array<[string, unknown]> = [
  ["an entry that is a number", 7],
  ["an entry that is null", null],
  ["an entry that is a list", ["email"]],
  ["an entry that is a boolean", true],
  ["a node with no type", { id: "own" }],
  ["a node with an empty type", { id: "own", type: "" }],
  ["a node whose type is not a string", { id: "own", type: 3 }],
  ["a node with no id", { type: "text" }],
  ["a node with an empty id", own({ id: "" })],
  ["a node whose id is not a string", own({ id: 4 })],
  ["a configuration that is a string", own({ configuration: "label" })],
  ["a configuration that is null", own({ configuration: null })],
  ["a configuration that is a list", own({ configuration: [] })],
  ["rules that are a list", own({ rules: [] })],
  ["rules that are null", own({ rules: null })],
  ["rules that are a string", own({ rules: "visible" })],
  ["children that are a list", layout([own()])],
  ["children that are null", layout(null)],
  ["children that are a string", layout("content")],
  ["a slot that is not a list", layout({ content: own() })],
  ["a slot that is null", layout({ content: null })],
  ["one slot a list, the next not", layout({ left: [], right: "own" })],
  ["a child that is a component id (inside a layout a form component is a reference)", layout({ content: ["email"] })],
  ["a child that is null", layout({ content: [null] })],
  ["a child with no type", layout({ content: [{ id: "inner" }] })],
  ["a child with no id", layout({ content: [{ type: "text" }] })],
  ["a fills that is a number", own({ configuration: { fills: 3 } })],
  ["a fills that is empty", own({ configuration: { fills: "" } })],
  ["a fills that is null", own({ configuration: { fills: null } })],
  ["a fills that is a list", own({ configuration: { fills: ["email"] } })],
  ["a reference with no configuration", { type: "journey-field" }],
  ["a reference whose configuration is a list", { type: "journey-field", configuration: [] }],
  ["a reference with no component id", { type: "journey-field", configuration: {} }],
  ["a reference with an empty component id", reference("")],
  ["a reference whose component id is not a string", reference(12)],
  ["a reference with children", reference("email", { children: {} })],
  ["a reference with children, inside a layout", layout({ content: [reference("email", { children: { content: [] } })] })],
  ["a worked-out value with no configuration", { id: "total", type: "journey-value" }],
  ["a worked-out value with no target", workedOut({ configuration: { value: expression } })],
  ["a worked-out value with an empty target", workedOut({ configuration: { to: "", value: expression } })],
  ["a worked-out value whose target is not a string", workedOut({ configuration: { to: 5, value: expression } })],
  ["a worked-out value with no expression", workedOut({ configuration: { to: "annual_income" } })],
  ["a worked-out value whose expression is text", workedOut({ configuration: { to: "annual_income", value: 7 } })],
  ["a worked-out value whose expression has no kind", workedOut({ configuration: { to: "annual_income", value: { path: "m1" } } })],
  ["a worked-out value whose expression is a list", workedOut({ configuration: { to: "annual_income", value: [expression] } })],
  ["a worked-out value with children", workedOut({ children: {} })],
  ["a worked-out value with no id", { type: "journey-value", configuration: { to: "annual_income", value: expression } }],
  ["a worked-out value with an empty fills", workedOut({ configuration: { to: "annual_income", value: expression, fills: "" } })],
  ["a malformed node three layouts down", nested(3, { id: "deep" })],
  ["a malformed reference three layouts down", nested(3, reference(""))]
];

describe("validateJourneyShape: nodes a presentation owns", () => {
  it("accepts the presentation fixture's journey and its variant, and readJourneys keeps them", () => {
    expect(validateJourneyShape(applyJourney())).toEqual([]);
    expect(validateJourneyShape(publicVariant())).toEqual([]);
    expect(readJourneys(presentationForm()).map((journey) => journey.id)).toEqual(["apply", "public"]);
    expect(findJourney(presentationForm(), "public")?.pages[0]?.components).toHaveLength(2);
  });

  it("accepts every well-formed entry, alone and beside the others", () => {
    for (const [label, entry] of WELL_FORMED) {
      expect(validateJourneyShape(holding(entry)), label).toEqual([]);
    }
    expect(validateJourneyShape(holding(...WELL_FORMED.map(([, entry]) => entry)))).toEqual([]);
  });

  it("says what is wrong with each malformed entry, and drops the journey that holds it", () => {
    for (const [label, entry] of MALFORMED) {
      const problems = validateJourneyShape(holding("email", entry));
      expect(problems.length, label).toBeGreaterThan(0);
      for (const problem of problems) {
        expect(problem, label).toMatch(/^journey "j" page 1 (components must be a list|component 2)/);
      }
      expect(readJourneys({ journey: { journeys: [holding("email", entry), { id: "kept", pages: [] }] } }).map((journey) => journey.id), label).toEqual(["kept"]);
    }
  });

  it("names the node and what it lacks, in document order", () => {
    expect(
      validateJourneyShape(
        holding(
          "email",
          { id: "own" },
          { type: "text", configuration: "x", rules: [] },
          own({ configuration: { fills: "" } }),
          { type: "journey-field", configuration: {}, children: {} },
          { id: "total", type: "journey-value", configuration: {}, children: {} },
          layout({ content: [{ id: "first", type: "text" }, { type: "text" }, reference("")], extra: "own", more: [null] }),
          layout([])
        )
      )
    ).toEqual([
      'journey "j" page 1 component 2 needs a type',
      'journey "j" page 1 component 3 needs an id',
      'journey "j" page 1 component 3 configuration must be an object',
      'journey "j" page 1 component 3 rules must be an object',
      'journey "j" page 1 component 4 fills must be the id of a form field',
      'journey "j" page 1 component 5 needs the id of the form component it shows (configuration.componentId)',
      'journey "j" page 1 component 5 is a reference to a form component and cannot hold children',
      'journey "j" page 1 component 6 needs the form field it works out (configuration.to)',
      'journey "j" page 1 component 6 needs an expression to work its value out with (configuration.value)',
      'journey "j" page 1 component 6 is a worked-out value and cannot hold children',
      'journey "j" page 1 component 7 children must be lists of nodes, by slot',
      'journey "j" page 1 component 7 content 2 needs an id',
      'journey "j" page 1 component 7 content 3 needs the id of the form component it shows (configuration.componentId)',
      'journey "j" page 1 component 7 more 1 must be an object',
      'journey "j" page 1 component 8 children must be lists of nodes, by slot'
    ]);
    // An entry that is neither an id nor a node is reported once for the page.
    expect(validateJourneyShape(holding("email", 7, null))).toEqual(['journey "j" page 1 components must be a list of component ids and nodes']);
  });

  it("reads a page nested thousands of layouts deep without running out of stack, on both sides", () => {
    const deep = holding(nested(20000, own({ id: "bottom" })));
    expect(validateJourneyShape(deep)).toEqual([]);
    expect(kernelIsJourney(deep)).toBe(true);
    const broken = holding(nested(20000, { id: "bottom" }));
    expect(validateJourneyShape(broken)).toHaveLength(1);
    expect(kernelIsJourney(broken)).toBe(false);
  });
});

describe("the browser's shape check and the kernel's agree on every entry", () => {
  it("accepts the same well-formed entries", () => {
    for (const [label, entry] of WELL_FORMED) {
      expect(kernelIsJourney(holding(entry)), label).toBe(true);
      expect(validateJourneyShape(holding(entry)), label).toEqual([]);
      if (typeof entry !== "string") {
        expect(kernelIsPresentationNode(entry), label).toBe(true);
      }
    }
  });

  it("refuses the same malformed entries: the browser drops the journey, the kernel answers journey.invalid", () => {
    for (const [label, entry] of MALFORMED) {
      const journey = holding("email", entry);
      expect(validateJourneyShape(journey).length > 0, label).toBe(true);
      expect(kernelIsJourney(journey), label).toBe(false);
      expect(kernelIsPresentationNode(entry), label).toBe(false);
      const outcome = runKernel({ formId: "f", values: { email: "a@b.co", annual_income: 1 }, locale: "en", form: presentationRoot(), journey: journey as Journey, formulaErrors: "warn" }, []);
      expect(outcome.errors[0], label).toEqual({ code: "journey.invalid", stage: "journey", source: "wasm" });
      expect(outcome.values, label).toBeUndefined();
    }
  });

  it("agrees over every pair of entries, malformed ones at any position, and through JSON", () => {
    const entries = [...WELL_FORMED, ...MALFORMED].map(([, entry]) => entry);
    for (const first of entries) {
      for (const second of [entries[0], entries[3], entries[entries.length - 1]]) {
        for (const candidate of [holding(first, second), holding(second, first)]) {
          const accepted = validateJourneyShape(candidate).length === 0;
          expect(kernelIsJourney(candidate), JSON.stringify(candidate)).toBe(accepted);
          // What crosses the ABI is JSON: the verdict is the same on the other side.
          const crossed: unknown = JSON.parse(JSON.stringify(candidate));
          expect(kernelIsJourney(crossed), JSON.stringify(candidate)).toBe(validateJourneyShape(crossed).length === 0);
        }
      }
    }
  });

  it("reads a key holding undefined as absent, as JSON leaves it out", () => {
    const sparse = holding(own({ configuration: undefined, rules: undefined, children: undefined }), reference("email", { children: undefined }), workedOut({ children: undefined }));
    expect(validateJourneyShape(sparse)).toEqual([]);
    expect(kernelIsJourney(sparse)).toBe(true);
    expect(kernelIsJourney(JSON.parse(JSON.stringify(sparse)))).toBe(true);
  });
});

describe("page entries and one-page journeys", () => {
  it("reads a page's form component ids: its string entries alone, in order", () => {
    expect(journeyPageFormIds({ components: ["a", own(), "b", reference("c")] as JourneyPageEntry[] })).toEqual(["a", "b"]);
    expect(journeyPageFormIds({})).toEqual([]);
    expect(journeyPageFormIds({ components: undefined })).toEqual([]);
    expect(applyJourney().pages.map(journeyPageFormIds)).toEqual([[], [], ["approved_amount"]]);
    // A page of ids reads as it always did.
    expect(journeyPageFormIds(apply.pages[0]!)).toEqual(["name"]);
  });

  it("tells a node the presentation owns from a component id, and a reference from an own node", () => {
    const entries = publicVariant().pages[0]!.components!;
    expect(entries.map(isPresentationEntry)).toEqual([true, true]);
    expect(isPresentationEntry("email")).toBe(false);
    const [contact] = entries;
    if (contact === undefined || typeof contact === "string" || isPresentationReference(contact)) {
      throw new Error("the fixture's first entry is an own layout");
    }
    expect((contact.children?.content ?? []).map(isPresentationReference)).toEqual([true, true]);
    expect(PRESENTATION_REFERENCE_TYPE).toBe("journey-field");
    expect(PRESENTATION_VALUE_TYPE).toBe("journey-value");
    expect(journeyHasOwnNodes(apply)).toBe(false);
    expect(journeyHasOwnNodes({ id: "j", pages: [{ id: "p" }, { id: "q", components: ["a", reference("a") as never] }] })).toBe(true);
  });

  it("keeps a journey's page heading as written: a presentation setting neither side checks", () => {
    for (const heading of ["hidden", "shown", "none", 3]) {
      const journey = { ...apply, heading } as unknown as Journey;
      expect(validateJourneyShape(journey), String(heading)).toEqual([]);
      expect(kernelIsJourney(journey), String(heading)).toBe(true);
      expect(readJourneys(definitionWith({ journeys: [journey] }))[0], String(heading)).toBe(journey);
    }
  });
});

describe("review pages: Check answers", () => {
  const reviewJourney = (review?: unknown): unknown => ({
    id: "apply",
    pages: [
      { id: "start", components: ["name"] },
      { id: "check", kind: "review", ...(review !== undefined ? { review } : {}) }
    ]
  });

  it("accepts a review page, with or without its settings, on both sides", () => {
    const accepted: unknown[] = [
      undefined,
      {},
      { labels: { name: "Your name" } },
      { labels: {} },
      { emptyOptional: "notProvided" },
      { emptyOptional: "omit" },
      { change: false },
      { change: true },
      { labels: { name: "Name", __proto__: "x" }, emptyOptional: "omit", change: false }
    ];
    for (const review of accepted) {
      const journey = reviewJourney(review);
      expect(validateJourneyShape(journey), JSON.stringify(review)).toEqual([]);
      expect(kernelIsJourney(journey), JSON.stringify(review)).toBe(true);
      // As it crosses JSON on its way to a server.
      expect(kernelIsJourney(JSON.parse(JSON.stringify(journey))), JSON.stringify(review)).toBe(true);
    }
  });

  it("refuses malformed review settings identically on both sides", () => {
    const refused: Array<[unknown, string]> = [
      [null, 'journey "apply" page 2.review must be an object'],
      ["yes", 'journey "apply" page 2.review must be an object'],
      [[], 'journey "apply" page 2.review must be an object'],
      [{ labels: "Name" }, 'journey "apply" page 2.review.labels must map component ids to text'],
      [{ labels: ["Name"] }, 'journey "apply" page 2.review.labels must map component ids to text'],
      [{ labels: { name: 3 } }, 'journey "apply" page 2.review.labels must map component ids to text'],
      [{ labels: { name: { default: "Name" } } }, 'journey "apply" page 2.review.labels must map component ids to text'],
      [{ emptyOptional: "hide" }, 'journey "apply" page 2.review.emptyOptional must be "notProvided" or "omit"'],
      [{ emptyOptional: null }, 'journey "apply" page 2.review.emptyOptional must be "notProvided" or "omit"'],
      [{ change: "no" }, 'journey "apply" page 2.review.change must be a boolean']
    ];
    for (const [review, problem] of refused) {
      const journey = reviewJourney(review);
      expect(validateJourneyShape(journey), JSON.stringify(review)).toEqual([problem]);
      expect(kernelIsJourney(journey), JSON.stringify(review)).toBe(false);
    }
  });

  it("reads review settings on any kind of page, so a page whose kind changes keeps a usable block", () => {
    const journey = { id: "apply", pages: [{ id: "start", components: ["name"], review: { change: false } }] };
    expect(validateJourneyShape(journey)).toEqual([]);
    expect(kernelIsJourney(journey)).toBe(true);
    const broken = { id: "apply", pages: [{ id: "start", review: { change: 1 } }] };
    expect(validateJourneyShape(broken)).toEqual(['journey "apply" page 1.review.change must be a boolean']);
    expect(kernelIsJourney(broken)).toBe(false);
  });

  it("agrees with the kernel on every combination of the review keys", () => {
    const values: Record<string, unknown[]> = {
      labels: [undefined, {}, { a: "A" }, { a: 1 }, "A", null],
      emptyOptional: [undefined, "notProvided", "omit", "none", 0],
      change: [undefined, true, false, "true", null]
    };
    for (const labels of values.labels!) {
      for (const emptyOptional of values.emptyOptional!) {
        for (const change of values.change!) {
          const review: Record<string, unknown> = {};
          if (labels !== undefined) review.labels = labels;
          if (emptyOptional !== undefined) review.emptyOptional = emptyOptional;
          if (change !== undefined) review.change = change;
          const journey = reviewJourney(review);
          expect(kernelIsJourney(journey), JSON.stringify(review)).toBe(validateJourneyShape(journey).length === 0);
        }
      }
    }
  });

  it("fills in the defaults: Not provided, Change links shown, no wording of its own", () => {
    expect(journeyReviewSettings(undefined)).toEqual({ labels: {}, emptyOptional: "notProvided", change: true });
    expect(journeyReviewSettings({ id: "check", kind: "review" })).toEqual({ labels: {}, emptyOptional: "notProvided", change: true });
    const resolved = journeyReviewSettings({ id: "check", kind: "review", review: { labels: { tenure: "Own or rent" }, emptyOptional: "omit", change: false } });
    expect({ ...resolved.labels }).toEqual({ tenure: "Own or rent" });
    expect(resolved.emptyOptional).toBe("omit");
    expect(resolved.change).toBe(false);
    // A component called constructor reads its own wording or none.
    expect(journeyReviewSettings({ id: "check", kind: "review" }).labels.constructor).toBeUndefined();
  });
});
