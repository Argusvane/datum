import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { kernelFoldHoldsOwnAnswer } from "../form-engine/core/state/submittable-fold.js";
import { FORMULA_FUNCTION_NAMES, formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import {
  STRUCTURE_FUNCTIONS,
  kernelStructureHoldsAnswer,
  kernelStructureLimits,
  kernelStructureSeverity,
  kernelStructureCheck,
  kernelStructureAdd,
  kernelStructureNewLog,
  kernelStructureMessage,
  kernelStructurePathsMax
} from "../form-engine/core/expressions/definition-structure.js";
import type { DefinitionInspectResponse, DefinitionProblem } from "../form-engine/core/expressions/inspect.js";
import { duplicateComponentIds } from "../form-engine/core/tree/component-tree.js";
import { componentIdProblem, isReservedComponentId, isValidComponentId } from "../form-engine/core/tree/component-id.js";
import { findDataKeyProblems } from "../form-engine/core/tree/data-scope.js";
import { validateJourneyShape } from "../form-engine/core/schema/journey.js";
import { validatePdfLayout } from "../form-engine/core/schema/pdf-layout-read.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { normalizeDataGrids } from "../form-engine/core/schema/data-grid.js";
import { chromePartIdProblems } from "../form-engine/core/schema/form-chrome.js";
import { PORTABLE_KERNEL_FUNCTIONS, kernelIsJourney, runInspect } from "../form-engine/validation/wasm/portable-kernel.js";
import { WASM_ABI_VERSION, stableStringify } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * The kernel's structural check of a definition (`core/expressions/definition-structure.ts`):
 * one case per rule of the check's table, the caps at N and N + 1, the size gate, the output
 * bounds, prototype-named keys, determinism, secrecy and the parity of each mirrored rule with the
 * engine helper it copies.
 */

const signatures = formulaFunctionSignatures();
const builtins = [...FORMULA_FUNCTION_NAMES];

type Check = Extract<DefinitionInspectResponse, { op: "check" }>;
type Json = Record<string, any>;

function run(definition: unknown, extra: Record<string, unknown> = {}): DefinitionInspectResponse {
  return runInspect({ abi: WASM_ABI_VERSION, op: "check", definition, ...extra }, signatures, builtins);
}

function check(definition: unknown, extra: Record<string, unknown> = {}): Check {
  const answer = run(definition, extra);
  if (!answer.ok || answer.op !== "check") {
    throw new Error("not a check answer: " + JSON.stringify(answer));
  }
  return answer;
}

const tokens = (list: DefinitionProblem[]): string[] => list.map((problem) => `${problem.code}@${problem.where}`);

function field(id: string, type = "text", configuration: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Json {
  return { id, type, configuration, ...extra };
}

function form(content: unknown[] = [field("a")], extra: Json = {}, root: Json = {}): Json {
  return {
    id: "f",
    version: "1",
    schemaVersion: "1",
    root: { id: "form", type: "form", configuration: {}, children: { content }, ...root },
    ...extra
  };
}

/** A definition built from JSON text, so `__proto__` and repeated keys are as a host's parser leaves them. */
const fromText = (text: string): Json => JSON.parse(text) as Json;

describe("a clean definition", () => {
  it("has empty structure lists, the limits in force and verdict ok", () => {
    const answer = check(form([field("a"), field("b", "select", { options: [{ value: "x", label: "X" }] })]));
    expect(answer.structure).toEqual([]);
    expect(answer.structureWarnings).toEqual([]);
    expect(answer.limits).toEqual({
      depth: 32,
      components: 10000,
      optionsPerComponent: 2000,
      optionsTotal: 50000,
      locales: 64,
      journeys: 32,
      pages: 1000,
      routesPerPage: 64,
      pdfLayouts: 64,
      problems: 200
    });
    expect(answer.limits).toEqual(kernelStructureLimits());
    expect(answer.verdict).toBe("ok");
  });
});

describe("rules 1 to 8: the envelope", () => {
  it.each([
    ["1 id empty", { ...form(), id: "" }, "definition.id.invalid@definition.id"],
    ["1 id not text", { ...form(), id: 5 }, "definition.id.invalid@definition.id"],
    ["1 id 129 characters", { ...form(), id: "a".repeat(129) }, "definition.id.invalid@definition.id"],
    ["2 version missing", { ...form(), version: undefined }, "definition.version.invalid@definition.version"],
    ["2 version not text", { ...form(), version: 1 }, "definition.version.invalid@definition.version"],
    ["3 version 65 characters", { ...form(), version: "v".repeat(65) }, "definition.version.tooLong@definition.version"],
    ["4 schemaVersion empty", { ...form(), schemaVersion: "" }, "definition.schemaVersion.invalid@definition.schemaVersion"],
    ["5 root type", form([field("a")], {}, { type: "group" }), "definition.root.type@root"],
    ["6 metadata", { ...form(), metadata: 1 }, "definition.section.invalid@definition.metadata"],
    ["6 accessibility", { ...form(), accessibility: "x" }, "definition.section.invalid@definition.accessibility"],
    ["6 journey", { ...form(), journey: "x" }, "definition.section.invalid@definition.journey"],
    ["28 localization", { ...form(), localization: [] }, "localization.invalid@localization"],
    ["37 pdf", { ...form(), pdf: 5 }, "pdf.invalid@pdf"]
  ])("%s", (_name, definition, token) => {
    const answer = check(definition);
    expect(tokens(answer.structure)).toContain(token);
    expect(answer.verdict).toBe("fail");
  });

  it("3 version of exactly 64 characters is fine; null sections count as absent", () => {
    const answer = check({ ...form(), version: "v".repeat(64), metadata: null, localization: null, pdf: null, journey: null });
    expect(answer.structure).toEqual([]);
  });

  it("the version limit rides the problem", () => {
    expect(check({ ...form(), version: "v".repeat(65) }).structure[0]).toMatchObject({ code: "definition.version.tooLong", limit: 64 });
  });

  it("7 an unknown top-level key warns and does not refuse", () => {
    const answer = check({ ...form(), extra: 1 });
    expect(tokens(answer.structureWarnings)).toEqual(["definition.key.unknown@definition"]);
    expect(answer.structure).toEqual([]);
    expect(answer.verdict).toBe("ok");
  });

  it("an unknown validateOn word warns once and refuses nothing; the two words and an absent setting are silent", () => {
    const withValidateOn = (validateOn: unknown): Json => ({ ...form(), root: { ...form().root, configuration: { validateOn } } });
    const answer = check(withValidateOn("blur"));
    expect(tokens(answer.structureWarnings)).toEqual(["validateOn.invalid@root.configuration.validateOn"]);
    expect(answer.structure).toEqual([]);
    expect(answer.verdict).toBe("ok");
    expect(tokens(check(withValidateOn(5)).structureWarnings)).toEqual(["validateOn.invalid@root.configuration.validateOn"]);
    for (const word of ["submit", "commitAfterError", undefined, null]) {
      expect(check(withValidateOn(word)).structureWarnings).toEqual([]);
    }
  });
});

describe("rules 9 to 13: shapes", () => {
  it("9 a child entry that is not an object, named by position", () => {
    const answer = check(form([5, "x", null, [], field("ok")]));
    expect(tokens(answer.structure)).toEqual([
      "component.notRecord@root > content > #0",
      "component.notRecord@root > content > #1",
      "component.notRecord@root > content > #2",
      "component.notRecord@root > content > #3"
    ]);
  });

  it("10 children that are not an object, and a slot that is not a list", () => {
    expect(tokens(check(form([field("a", "text", {}, { children: [] })])).structure)).toEqual(["component.children.invalid@root > content > a"]);
    expect(tokens(check(form([field("a", "group", {}, { children: { content: "x" } })])).structure)).toEqual(["component.children.invalid@root > content > a"]);
    expect(tokens(check(form([], {}, { children: "x" })).structure)).toEqual(["component.children.invalid@root"]);
  });

  it("11 a configuration that is not an object; null is absent", () => {
    expect(tokens(check(form([field("a", "text", [] as never)])).structure)).toEqual(["component.configuration.invalid@root > content > a"]);
    expect(check(form([{ id: "a", type: "text", configuration: null }])).structure).toEqual([]);
  });

  it("12 a collection that is not an object, or with a collectionPath that is not text", () => {
    expect(tokens(check(form([field("a", "text", {}, { collection: 5 })])).structure)).toEqual(["component.collection.invalid@root > content > a"]);
    expect(tokens(check(form([field("a", "text", {}, { collection: { collectionPath: 5 } })])).structure)).toEqual(["component.collection.invalid@root > content > a"]);
  });

  it("13 an unknown node key warns", () => {
    const answer = check(form([field("a", "text", {}, { surprise: 1 })]));
    expect(tokens(answer.structureWarnings)).toEqual(["component.key.unknown@root > content > a"]);
    expect(answer.verdict).toBe("ok");
  });

  it("the where of a deep node reads like definition.tooDeep's, root > slot > id", () => {
    const answer = check(form([{ id: "box", type: "container", configuration: {}, children: { inner: [field("a", "text", {}, { surprise: 1 })] } }]));
    expect(tokens(answer.structureWarnings)).toEqual(["component.key.unknown@root > content > box > inner > a"]);
  });
});

describe("rules 14 to 18: ids and types", () => {
  it.each([
    ["starts with a digit", "1a"],
    ["has a space", "a b"],
    ["is empty", ""],
    ["has a colon", "a:b"],
    ["has a newline", "a\nb"],
    ["is 129 characters", "a".repeat(129)]
  ])("14 an id that %s is refused and named by position", (_name, id) => {
    const answer = check(form([field(id)]));
    expect(tokens(answer.structure)).toContain("component.id.invalid@root > content > #0");
    expect(answer.verdict).toBe("fail");
  });

  it("14 a missing and a numeric id", () => {
    expect(tokens(check(form([{ type: "text" }, { id: 5, type: "text" }])).structure)).toEqual(["component.id.invalid@root > content > #0", "component.id.invalid@root > content > #1"]);
  });

  it("14 an id of exactly 128 characters is fine", () => {
    expect(check(form([field("a".repeat(128))])).structure).toEqual([]);
  });

  it("15 a repeated id is reported at each later node, the first is canonical", () => {
    const answer = check(form([field("dup"), field("x"), field("dup"), { id: "box", type: "container", configuration: {}, children: { content: [field("dup")] } }]));
    expect(tokens(answer.structure.filter((problem) => problem.code === "component.id.duplicate"))).toEqual([
      "component.id.duplicate@root > content > dup",
      "component.id.duplicate@root > content > box > content > dup"
    ]);
    // The repeated id also means two fields at one stored place (rule 22).
    expect(answer.structure.some((problem) => problem.code === "component.dataPath.duplicate")).toBe(true);
  });

  it("15 the root's id counts", () => {
    expect(tokens(check(form([field("form")])).structure)).toEqual(["component.id.duplicate@root > content > form"]);
  });

  it("16 an id that is an Object.prototype member warns only; constructor and prototype are refused as reserved, as the engine refuses them", () => {
    const answer = check(form([field("constructor"), field("toString"), field("prototype"), field("hasOwnProperty")]));
    expect(tokens(answer.structure)).toEqual(["component.id.reserved@root > content > constructor", "component.id.reserved@root > content > prototype"]);
    expect(tokens(answer.structureWarnings)).toEqual([
      "component.id.prototypeName@root > content > toString",
      "component.id.prototypeName@root > content > hasOwnProperty"
    ]);
    expect(answer.verdict).toBe("fail");
  });

  it("14 the kernel's id rule is the engine's isValidComponentId, the reserved ids included", () => {
    for (const id of ["constructor", "prototype", "toString", "root", "a".repeat(128), "a".repeat(129), "a b", "1a", "__proto__"]) {
      const answer = check(form([field(id)]));
      const refused = answer.structure.some((problem) => problem.code === "component.id.invalid" || problem.code === "component.id.reserved");
      expect(refused, id.slice(0, 12)).toBe(!(isValidComponentId(id) && id.length <= 128));
    }
  });

  it("a definition carrying its own tests block draws no unknown-key warning", () => {
    const answer = check({ ...form([field("a")]), tests: { scenarios: [{ id: "s", source: "scenario s" }] } });
    expect(answer.structureWarnings.map((problem) => problem.code)).not.toContain("definition.key.unknown");
    expect(answer.verdict).toBe("ok");
  });

  it.each([
    ["missing", undefined],
    ["a number", 5],
    ["empty", ""],
    ["null", null],
    ["a list", []],
    ["an object", {}],
    ["129 characters", "t".repeat(129)]
  ])("17 a type that is %s is refused", (_name, type) => {
    const answer = check(form([{ id: "a", type, configuration: {} }]));
    expect(tokens(answer.structure)).toEqual(["component.type.invalid@root > content > a"]);
  });

  it("18 an unknown type warns only when the host sent types, never for the root", () => {
    const content = [field("a", "text"), field("b", "no-such-type")];
    expect(check(form(content)).structureWarnings).toEqual([]);
    const answer = check(form(content), { types: ["text"] });
    expect(tokens(answer.structureWarnings)).toEqual(["component.type.unknown@root > content > b"]);
    expect(answer.structure).toEqual([]);
    expect(answer.verdict).toBe("ok");
  });

  it("18 a request's types are a list of at most 4096 names of at most 128 characters, else invalid_request", () => {
    expect(run(form(), { types: Array.from({ length: 4096 }, (_, n) => `t${n}`) })).toMatchObject({ ok: true });
    expect(run(form(), { types: Array.from({ length: 4097 }, (_, n) => `t${n}`) })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(run(form(), { types: ["x".repeat(129)] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(run(form(), { types: [5] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(run(form(), { types: "text" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(run(form(), { types: null })).toMatchObject({ ok: true });
  });
});

describe("rules 19 to 23: data keys and the places answers are stored", () => {
  it.each([
    ["has a space", "a b"],
    ["is digits alone", "123"],
    ["is a number", 5],
    ["has a dot", "a.b"],
    ["is 129 characters", "k".repeat(129)]
  ])("19 a data key that %s is refused", (_name, dataKey) => {
    expect(tokens(check(form([field("a", "text", { dataKey })])).structure)).toEqual(["component.dataKey.invalid@root > content > a"]);
  });

  it("19 an unset key (undefined, null, empty) is fine", () => {
    expect(check(form([field("a", "text", { dataKey: "" }), field("b", "text", { dataKey: null })])).structure).toEqual([]);
  });

  it("20 __proto__ as a data key or a collection path is refused", () => {
    expect(tokens(check(form([field("a", "text", { dataKey: "__proto__" })])).structure)).toEqual(["component.dataKey.prototype@root > content > a"]);
    expect(tokens(check(form([field("a", "group", {}, { collection: { collectionPath: "__proto__" } })])).structure)).toEqual(["component.dataKey.prototype@root > content > a"]);
  });

  it("21 another Object.prototype name as a key warns only", () => {
    const answer = check(form([field("a", "text", { dataKey: "constructor" })]));
    expect(answer.structure).toEqual([]);
    expect(tokens(answer.structureWarnings)).toEqual(["component.dataKey.prototypeName@root > content > a"]);
  });

  it("a collection or grid path over 512 characters is refused", () => {
    expect(tokens(check(form([field("a", "group", {}, { collection: { collectionPath: "p".repeat(513) } })])).structure)).toEqual(["component.path.tooLong@root > content > a"]);
    expect(check(form([field("a", "group", {}, { collection: { collectionPath: "p".repeat(512) } })])).structure).toEqual([]);
  });

  it("22 two fields on one key, and a field with a sourced select (OPT-11), are refused at the later node", () => {
    expect(tokens(check(form([field("a", "text", { dataKey: "k" }), field("b", "text", { dataKey: "k" })])).structure)).toEqual(["component.dataPath.duplicate@root > content > b"]);
    const select = field("pick", "select", { dataKey: "k", data: { sourceId: "countries" } });
    expect(tokens(check(form([field("txt", "text", { dataKey: "k" }), select])).structure)).toEqual(["component.dataPath.duplicate@root > content > pick"]);
  });

  it("22 two data-scoping containers may share a key; a container and a field may not", () => {
    const box = (id: string) => ({ id, type: "container", configuration: { dataKey: "shared" }, children: { content: [field(`in_${id}`)] } });
    expect(check(form([box("one"), box("two")])).structure).toEqual([]);
    const answer = check(form([box("one"), field("clash", "text", { dataKey: "shared" })]));
    expect(tokens(answer.structure)).toEqual(["component.dataPath.duplicate@root > content > clash"]);
  });

  it("22 a purely visual container (scopeData false) adds no level, so a field inside shares the outer place", () => {
    const answer = check(form([field("a", "text", { dataKey: "k" }), { id: "v", type: "container", configuration: { scopeData: false }, children: { content: [field("b", "text", { dataKey: "k" })] } }]));
    expect(tokens(answer.structure)).toEqual(["component.dataPath.duplicate@root > content > v > content > b"]);
  });

  it("22 the same key in different containers is two places", () => {
    const box = (id: string) => ({ id, type: "container", configuration: {}, children: { content: [field(`in_${id}`, "text", { dataKey: "k" })] } });
    expect(check(form([box("one"), box("two")])).structure).toEqual([]);
  });

  it("22 a valueless component (button, html) claims no place", () => {
    expect(check(form([field("a", "text", { dataKey: "k" }), field("b", "button", { dataKey: "k" }), field("c", "html", { dataKey: "k" })])).structure).toEqual([]);
  });

  it("23 a place nested under a place that cannot hold it is refused at the nested node", () => {
    const section = field("rows", "repeatingSection", {}, { collection: { collectionPath: "a.b" }, children: { content: [field("cell")] } });
    expect(tokens(check(form([field("a"), section])).structure)).toEqual(["component.dataPath.conflict@root > content > rows"]);
  });

  it("23 a section's fields under its array are fine; a field named like the section is a duplicate", () => {
    const section = (path?: string) => field("items", "repeatingSection", {}, { collection: path === undefined ? {} : { collectionPath: path }, children: { content: [field("sku")] } });
    expect(check(form([section()])).structure).toEqual([]);
    expect(tokens(check(form([section(), field("other", "text", { dataKey: "items" })])).structure)).toEqual(["component.dataPath.duplicate@root > content > other"]);
  });

  it("23 a data grid at its collection path holds rows; a field at the same path is a duplicate", () => {
    const grid = (): Json => field("grid", "dataGrid", {}, { collection: { collectionPath: "orders" } });
    expect(check(form([grid(), field("x")])).structure).toEqual([]);
    expect(tokens(check(form([grid(), field("orders")])).structure)).toEqual(["component.dataPath.duplicate@root > content > orders"]);
  });
});

describe("rules 24 to 27: inline options warn", () => {
  it("24 options that are not a list", () => {
    expect(tokens(check(form([field("a", "select", { options: "x" })])).structureWarnings)).toEqual(["option.list.invalid@root > content > a"]);
  });

  it("25 an entry that is not { value: text }", () => {
    expect(tokens(check(form([field("a", "select", { options: [{ label: "x" }, 5] })])).structureWarnings)).toEqual(["option.entry.invalid@root > content > a"]);
    expect(tokens(check(form([field("a", "select", { options: [{ value: 5 }] })])).structureWarnings)).toEqual(["option.entry.invalid@root > content > a"]);
    expect(check(form([field("a", "select", { options: [{ value: "x", label: { default: "X" } }] })])).structureWarnings).toEqual([]);
  });

  it("26 two options with one value", () => {
    expect(tokens(check(form([field("a", "select", { options: [{ value: "x" }, { value: "x" }] })])).structureWarnings)).toEqual(["option.value.duplicate@root > content > a"]);
  });

  it("27 more than 500 options in one list", () => {
    const options = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `v${i}` }));
    expect(check(form([field("a", "select", { options: options(500) })])).structureWarnings).toEqual([]);
    const answer = check(form([field("a", "select", { options: options(501) })]));
    expect(answer.structureWarnings[0]).toMatchObject({ code: "option.count.large", where: "root > content > a", limit: 500 });
    expect(answer.verdict).toBe("ok");
  });
});

describe("rules 28 and 29: localization", () => {
  const withLocalization = (localization: unknown) => ({ ...form(), localization });

  it.each([
    ["supportedLocales not a list", { supportedLocales: "en" }],
    ["an entry that is a number", { supportedLocales: [5] }],
    ["a plain string entry", { supportedLocales: ["en"] }],
    ["a code with a space", { supportedLocales: [{ code: "x y" }] }],
    ["a code of 36 characters", { supportedLocales: [{ code: "a".repeat(36) }] }],
    ["a label that is not text", { supportedLocales: [{ code: "en", label: 5 }] }],
    ["a default that fails the grammar", { defaultLocale: "x y" }]
  ])("28 %s", (_name, localization) => {
    expect(tokens(check(withLocalization(localization)).structure)).toEqual(["localization.invalid@localization"]);
  });

  it("28 { code, label? } entries and a 35-character code are fine", () => {
    expect(check(withLocalization({ defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr-CA", label: "Français" }, { code: "zh-Hant-TW" }] })).structure).toEqual([]);
    expect(check(withLocalization({ supportedLocales: [{ code: "abcdefgh-abcdefgh-abcdefgh-abcdefgh".slice(0, 35).replace(/-$/, "a") }] })).structure).toEqual([]);
  });

  it("29 a repeated locale and a default that is not supported warn", () => {
    const answer = check(withLocalization({ defaultLocale: "de", supportedLocales: [{ code: "en" }, { code: "fr" }, { code: "en" }] }));
    expect(answer.structure).toEqual([]);
    expect(tokens(answer.structureWarnings)).toEqual(["localization.defaultLocale.unknown@localization", "localization.locale.duplicate@localization"]);
    expect(answer.verdict).toBe("ok");
  });
});

function journeyForm(journeys: unknown[], components: unknown[] = [field("a"), field("b")]): Json {
  return form(components, { journey: { journeys } });
}
const page = (id: string, extra: Json = {}): Json => ({ id, components: ["a"], ...extra });

describe("rules 30 to 36: journeys", () => {
  it("30 journeys not a list, a journey of no shape, a journey with no usable pages", () => {
    expect(tokens(check({ ...form(), journey: { journeys: "x" } }).structure)).toEqual(["journey.invalid@journey"]);
    expect(tokens(check(journeyForm([5])).structure)).toEqual(["journey.invalid@journey:#0"]);
    expect(tokens(check(journeyForm([{ id: "j" }])).structure)).toEqual(["journey.invalid@journey:j"]);
    expect(tokens(check(journeyForm([{ id: "j", pages: "x" }])).structure)).toEqual(["journey.invalid@journey:j"]);
    // A page's own when: the journey is invalid, and the page is named with the reason.
    expect(tokens(check(journeyForm([{ id: "j", pages: [page("p", { when: 5 })] }])).structure)).toEqual(["journey.invalid@journey:j", "journey.page.when@journey:j:page:p"]);
    for (const when of ["age > 1", { formula: "age > 1", run: "server-secret" }, null, ""]) {
      const answer = check(journeyForm([{ id: "j", pages: [page("a"), page("p", { when })] }]));
      expect(tokens(answer.structure), JSON.stringify(when)).toEqual(["journey.invalid@journey:j", "journey.page.when@journey:j:page:p"]);
      expect(answer.structure.find((problem) => problem.code === "journey.page.when")?.message).toBe(
        "A page has no condition of its own; branch with a route on the page before it."
      );
    }
    expect(tokens(check(journeyForm([{ id: "j", pages: [page("p", { routes: [{ to: "" }] })] }])).structure)).toEqual(["journey.invalid@journey:j"]);
  });

  it("31 two journeys with one id", () => {
    const j = { id: "j", pages: [page("p")] };
    expect(tokens(check(journeyForm([j, { ...j }])).structure)).toEqual(["journey.id.duplicate@journey:j"]);
  });

  it("32 two pages of one journey with one id (the run's shape check refuses it too)", () => {
    const answer = check(journeyForm([{ id: "j", pages: [page("p"), page("q"), page("p")] }]));
    expect(tokens(answer.structure)).toEqual(["journey.invalid@journey:j", "journey.page.duplicateId@journey:j:page:p"]);
  });

  it("33 and 34 a route to a missing page, to the same page or to an earlier one warns; $end and later pages do not", () => {
    const answer = check(
      journeyForm([
        {
          id: "j",
          pages: [
            page("a1", { routes: [{ to: "a3" }, { to: "$end" }, { to: "nowhere" }] }),
            page("a2", { routes: [{ to: "a1" }, { to: "a2" }] }),
            page("a3")
          ]
        }
      ])
    );
    expect(answer.structure).toEqual([]);
    expect(tokens(answer.structureWarnings)).toEqual([
      "journey.route.unknownTarget@journey:j:page:a1:route:2",
      "journey.route.backward@journey:j:page:a2:route:0",
      "journey.route.backward@journey:j:page:a2:route:1"
    ]);
    expect(answer.verdict).toBe("ok");
  });

  it("35 a page that names a component the form does not have, or the root", () => {
    expect(tokens(check(journeyForm([{ id: "j", pages: [page("p", { components: ["a", "ghost"] })] }])).structureWarnings)).toEqual(["journey.page.unknownComponent@journey:j:page:p"]);
    expect(tokens(check(journeyForm([{ id: "j", pages: [page("p", { components: ["form"] })] }])).structureWarnings)).toEqual(["journey.page.unknownComponent@journey:j:page:p"]);
  });

  it("36 a page id that is also a component id", () => {
    expect(tokens(check(journeyForm([{ id: "j", pages: [page("a")] }])).structureWarnings)).toEqual(["journey.page.idIsComponentId@journey:j:page:a"]);
  });

  it("a clean journey with a presentation node entry has no finding", () => {
    const entries = ["a", { id: "own", type: "journey-value", configuration: { to: "b", value: "1 + 1" } }, { type: "journey-field", configuration: { componentId: "b" } }];
    const answer = check(journeyForm([{ id: "j", pages: [page("p", { components: entries }), page("q", { components: ["b"] })] }]));
    expect(answer.structure).toEqual([]);
    expect(answer.structureWarnings).toEqual([]);
  });
});

describe("rules 37 to 39: PDF layouts", () => {
  const generated = (id: string, extra: Json = {}): Json => ({ id, kind: "generated", root: { id: `doc_${id}`, type: "pdf-document" }, ...extra });
  const template = (id: string): Json => ({ id, kind: "template", template: { storage: "base64", data: "AA==" }, fields: [] });
  const withLayouts = (layouts: unknown, extra: Json = {}) => ({ ...form(), pdf: { layouts, ...extra } });

  it("37 layouts not a list, a layout that is not an object, with no id, a bad kind, a missing root or template source", () => {
    expect(tokens(check(withLayouts("x")).structure)).toEqual(["pdf.invalid@pdf"]);
    expect(tokens(check(withLayouts([5])).structure)).toEqual(["pdf.layout.invalid@pdf:#0"]);
    expect(tokens(check(withLayouts([{ kind: "generated", root: { id: "d", type: "pdf-document" } }])).structure)).toEqual(["pdf.layout.invalid@pdf:#0"]);
    expect(tokens(check(withLayouts([{ id: "l" }])).structure)).toEqual(["pdf.layout.invalid@pdf:l"]);
    expect(tokens(check(withLayouts([{ id: "l", kind: "weird" }])).structure)).toEqual(["pdf.layout.invalid@pdf:l"]);
    expect(tokens(check(withLayouts([{ id: "l", kind: "generated" }])).structure)).toEqual(["pdf.layout.invalid@pdf:l"]);
    expect(tokens(check(withLayouts([{ id: "l", kind: "template" }])).structure)).toEqual(["pdf.layout.invalid@pdf:l"]);
  });

  it("37 a generated and a template layout in the shape the PDF program reads are fine", () => {
    expect(check(withLayouts([generated("g"), template("t")])).structure).toEqual([]);
  });

  it("38 a repeated layout id, and an id over 128 characters", () => {
    expect(tokens(check(withLayouts([generated("g"), generated("g")])).structure)).toEqual(["pdf.layout.duplicateId@pdf:g"]);
    const long = "l".repeat(129);
    const answer = check(withLayouts([generated(long)]));
    expect(tokens(answer.structure)).toEqual(["pdf.layout.idTooLong@pdf:#0"]);
    expect(answer.structure[0]).toMatchObject({ limit: 128 });
  });

  it("39 a default layout that names nothing warns", () => {
    const answer = check(withLayouts([generated("g")], { defaultLayoutId: "missing" }));
    expect(answer.structure).toEqual([]);
    expect(tokens(answer.structureWarnings)).toEqual(["pdf.defaultLayoutId.unknown@pdf"]);
    expect(check(withLayouts([generated("g")], { defaultLayoutId: "g" })).structureWarnings).toEqual([]);
  });
});

describe("rule 8: prototype-named keys", () => {
  it("an own __proto__ key as a top-level key, a node key, a slot, a rules key and a collection key is refused", () => {
    const text =
      '{"id":"f","version":"1","schemaVersion":"1","__proto__":{"x":1},' +
      '"root":{"id":"form","type":"form","configuration":{},"children":{"content":[' +
      '{"id":"a","type":"text","__proto__":{"y":1}},' +
      '{"id":"b","type":"text","rules":{"__proto__":"x"}},' +
      '{"id":"c","type":"group","collection":{"__proto__":1}}' +
      '],"__proto__":[]}}}';
    const definition = fromText(text);
    const before = JSON.stringify(definition);
    const answer = check(definition);
    expect(tokens(answer.structure)).toEqual([
      "definition.key.prototype@definition",
      "definition.key.prototype@root",
      "definition.key.prototype@root > content > a",
      "definition.key.prototype@root > content > b",
      "definition.key.prototype@root > content > c"
    ]);
    expect(JSON.stringify(definition)).toBe(before);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it("ids and data keys named like Object.prototype members are read as data, never as members", () => {
    const answer = check(form([field("isPrototypeOf"), field("toString", "text", { dataKey: "valueOf" })]));
    expect(answer.structure).toEqual([]);
    expect(answer.structureWarnings.map((problem) => problem.code).sort()).toEqual(["component.dataKey.prototypeName", "component.id.prototypeName", "component.id.prototypeName"]);
  });
});

describe("rule 40: size caps, at N and N + 1", () => {
  const flat = (n: number): Json => form(Array.from({ length: n }, (_, i) => field(`c${i}`)));
  const sizeCodes = (answer: Check) => answer.structure.map((problem) => problem.code);

  it("10,000 components are fine, 10,001 are refused with the formulas left uncompiled", () => {
    expect(check(flat(10000)).structure).toEqual([]);
    const answer = check({ ...flat(10001), root: { ...flat(10001).root } });
    expect(answer.structure).toEqual([expect.objectContaining({ code: "definition.tooManyComponents", where: "definition", limit: 10000 })]);
    expect(answer.verdict).toBe("fail");
    expect(answer.problems).toEqual([]);
    expect(answer.warnings).toEqual([]);
  });

  it("the size gate skips the formula compile: a broken formula is not reported past a cap", () => {
    const definition = flat(10001);
    definition.root.children.content[0].rules = { visibleWhen: "((" };
    expect(check(definition).problems).toEqual([]);
    const small = flat(3);
    small.root.children.content[0].rules = { visibleWhen: "((" };
    expect(check(small).problems.length).toBe(1);
  });

  it("the gate collects at most the cap's worth of nodes however large the tree is", () => {
    const calls = { count: 0 };
    const content = new Proxy(Array.from({ length: 50000 }, (_, i) => field(`c${i}`)), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          calls.count += 1;
        }
        return Reflect.get(target, key, receiver);
      }
    });
    const result = kernelStructureCheck({ id: "f", version: "1", schemaVersion: "1", root: { id: "form", type: "form", configuration: {}, children: { content } } }, undefined);
    expect(result.sizeGate).toBe(true);
    expect(calls.count).toBeLessThanOrEqual(10003);
  });

  it("2,000 options on one component are fine, 2,001 refused", () => {
    const options = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `v${i}` }));
    expect(check(form([field("s", "select", { options: options(2000) })])).structure).toEqual([]);
    expect(check(form([field("s", "select", { options: options(2001) })])).structure).toEqual([expect.objectContaining({ code: "option.tooMany", where: "root > content > s", limit: 2000 })]);
  });

  it("50,000 options in all are fine, 50,001 refused", () => {
    const selects = (extra: number) => {
      const list = Array.from({ length: 25 }, (_, s) => field(`s${s}`, "select", { options: Array.from({ length: 2000 }, (_, i) => ({ value: `v${i}` })) }));
      if (extra > 0) {
        list.push(field("more", "select", { options: Array.from({ length: extra }, (_, i) => ({ value: `m${i}` })) }));
      }
      return form(list);
    };
    expect(check(selects(0)).structure).toEqual([]);
    expect(sizeCodes(check(selects(1)))).toEqual(["option.total.tooMany"]);
  });

  it("64 locales are fine, 65 refused", () => {
    const locales = (n: number) => ({ ...form(), localization: { supportedLocales: Array.from({ length: n }, (_, i) => ({ code: `x${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}` })) } });
    expect(check(locales(64)).structure).toEqual([]);
    expect(sizeCodes(check(locales(65)))).toEqual(["localization.tooMany"]);
  });

  it("32 journeys are fine, 33 refused", () => {
    const journeys = (n: number) => journeyForm(Array.from({ length: n }, (_, i) => ({ id: `j${i}`, pages: [page(`p${i}`)] })));
    expect(check(journeys(32)).structure).toEqual([]);
    expect(sizeCodes(check(journeys(33)))).toEqual(["journey.tooMany"]);
  });

  it("1,000 pages in all are fine, 1,001 refused", () => {
    const pages = (n: number) => journeyForm([{ id: "j", pages: Array.from({ length: n }, (_, i) => page(`p${i}`)) }]);
    expect(check(pages(1000)).structure).toEqual([]);
    expect(sizeCodes(check(pages(1001)))).toEqual(["journey.page.tooMany"]);
  });

  it("64 routes on a page are fine, 65 refused", () => {
    const routes = (n: number) => journeyForm([{ id: "j", pages: [page("p", { routes: Array.from({ length: n }, () => ({ to: "$end" })) })] }]);
    expect(check(routes(64)).structure).toEqual([]);
    expect(check(routes(65)).structure).toEqual([expect.objectContaining({ code: "journey.route.tooMany", where: "journey:j:page:p", limit: 64 })]);
  });

  it("64 PDF layouts are fine, 65 refused", () => {
    const layouts = (n: number) => ({ ...form(), pdf: { layouts: Array.from({ length: n }, (_, i) => ({ id: `l${i}`, kind: "generated", root: { id: `d${i}`, type: "pdf-document" } })) } });
    expect(check(layouts(64)).structure).toEqual([]);
    expect(sizeCodes(check(layouts(65)))).toEqual(["pdf.tooMany"]);
  });

  it("journey own nodes and PDF layout trees count towards the component cap", () => {
    const own = Array.from({ length: 6000 }, (_, i) => ({ id: `o${i}`, type: "text", configuration: {} }));
    const definition = journeyForm([{ id: "j", pages: [page("p", { components: ["a", ...own] })] }], Array.from({ length: 5000 }, (_, i) => field(`c${i}`)));
    expect(sizeCodes(check(definition))).toEqual(["definition.tooManyComponents"]);
  });

  it("more than 2,500 components warn that the form is large", () => {
    const answer = check(form(Array.from({ length: 2501 }, (_, i) => field(`c${i}`))));
    expect(answer.structureWarnings).toEqual([expect.objectContaining({ code: "definition.components.large", limit: 2500 })]);
    expect(check(form(Array.from({ length: 2500 }, (_, i) => field(`c${i}`)))).structureWarnings).toEqual([]);
  });
});

describe("rule 41 and the output bounds", () => {
  it("9,000 duplicate ids give at most 200 problems and a marker, within 128 KiB", () => {
    const answer = check(form(Array.from({ length: 9000 }, () => field("dup"))));
    expect(answer.structure.length).toBe(201);
    // 8,999 repeated ids and the one place they share, less the 200 listed.
    expect(answer.structure[200]).toMatchObject({ code: "definition.problemsTruncated", where: "", limit: 200, message: "8800 more problems were left out" });
    expect(answer.structure[0]).toMatchObject({ code: "component.id.duplicate" });
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(128 * 1024);
    for (const problem of answer.structure) {
      expect(problem.where.length).toBeLessThanOrEqual(80);
    }
  });

  it("a 1 MiB id does not reach a where; the node is named by position", () => {
    const answer = check(form([field("x".repeat(1024 * 1024))]));
    expect(tokens(answer.structure)).toEqual(["component.id.invalid@root > content > #0"]);
    expect(JSON.stringify(answer).length).toBeLessThan(10000);
  });

  it("a where past 80 characters is cut from the left", () => {
    let node: Json = field("leaf", "text", {}, { surprise: 1 });
    for (let level = 0; level < 20; level += 1) {
      node = { id: `layer_number_${level}`, type: "container", configuration: {}, children: { content: [node] } };
    }
    const where = check(form([node])).structureWarnings[0]!.where;
    expect(where.length).toBe(80);
    expect(where.startsWith("...")).toBe(true);
    expect(where.endsWith("> leaf")).toBe(true);
  });

  it("warnings are capped like refusals", () => {
    const answer = check(form(Array.from({ length: 500 }, (_, i) => field(`c${i}`, "text", {}, { surprise: 1 }))));
    expect(answer.structureWarnings.length).toBe(201);
    expect(answer.structureWarnings[200]).toMatchObject({ code: "definition.problemsTruncated" });
  });

  it("ids and slot names with odd characters never reach an answer (no raw control characters)", () => {
    const answer = check(form([field("a\u0000b c"), { id: "x", type: "container", configuration: {}, children: { "s\nlot": [field("q", "text", {}, { surprise: 1 })] } }]));
    // eslint-disable-next-line no-control-regex
    expect(JSON.stringify(answer)).not.toMatch(new RegExp("[\\u0000-\\u001f\\u2028]"));
    expect(tokens(answer.structure)).toEqual(["component.id.invalid@root > content > #0"]);
    expect(tokens(answer.structureWarnings)).toEqual(["component.key.unknown@root > content > x > ? > q"]);
  });
});

// A `where` is built for a problem that is kept, never past the 200 cap.
describe("the cost of problems", () => {
  it("builds a where only for the problems it lists", () => {
    const log = kernelStructureNewLog();
    let built = 0;
    for (let n = 0; n < 5000; n += 1) {
      kernelStructureAdd(log, "R", "component.id.duplicate", () => {
        built += 1;
        return "root > content > x";
      });
    }
    expect(log.structure.length).toBe(201);
    expect(built).toBe(200);
    expect(log.leftOut).toBe(4800);
    // A plain text is still accepted.
    kernelStructureAdd(log, "W", "definition.key.unknown", "definition");
    expect(log.warnings[0]!.where).toBe("definition");
  });

  it("answers a problem-bearing definition 32 levels deep, with duplicate ids at every level, without a path per problem", () => {
    let node: Json = { id: "dup", type: "container", configuration: {}, children: { content: Array.from({ length: 250 }, () => field("dup")) } };
    for (let level = 0; level < 29; level += 1) {
      node = { id: "dup", type: "container", configuration: {}, children: { content: [node, field("dup")] } };
    }
    const started = Date.now();
    const answer = check(form([node]));
    expect(answer.structure.length).toBe(201);
    expect(answer.structure[0]!.where.length).toBeLessThanOrEqual(80);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("refuses collection and data paths past 64 KiB together, once, and stops placing them", () => {
    const path = (n: number): string => Array.from({ length: 60 }, (_, k) => `p${n}x${k}`).join(".");
    const sections = Array.from({ length: 200 }, (_, n) => field(`s${n}`, "group", { children: [] }, { collection: { collectionPath: path(n) } }));
    expect(path(0).length).toBeLessThanOrEqual(512);
    const answer = check(form(sections));
    expect(tokens(answer.structure).filter((token) => token.startsWith("definition.paths.tooLong"))).toEqual(["definition.paths.tooLong@definition"]);
    const one = check(form(sections.slice(0, 100)));
    expect(tokens(one.structure)).toEqual([]);
    expect(kernelStructurePathsMax()).toBe(65536);
  });

  it("refuses a field pattern past 2,000 characters", () => {
    expect(tokens(check(form([field("a", "text", { pattern: "a".repeat(2000) })])).structure)).toEqual([]);
    const answer = check(form([field("a", "text", { pattern: "a".repeat(2001) })]));
    expect(tokens(answer.structure)).toEqual(["component.pattern.tooLong@root > content > a"]);
    expect(answer.structure[0]).toMatchObject({ limit: 2000 });
    expect(answer.verdict).toBe("fail");
  });
});

describe("the verdict", () => {
  const brokenFormula = (word: string): Json => {
    const definition = form([field("a", "text", {}, { rules: { visibleWhen: "((" } }), field("dup"), field("dup")], {}, { configuration: { formulaErrors: word } });
    return definition;
  };

  it("a structure refusal is fail under every formula policy; warnings never change the verdict", () => {
    for (const word of ["fail", "warn"]) {
      expect(check(form([field("dup"), field("dup")], {}, { configuration: { formulaErrors: word } })).verdict, word).toBe("fail");
      expect(check(form([field("a")], { extra: 1 }, { configuration: { formulaErrors: word } })).verdict, word).toBe("ok");
    }
    expect(check(brokenFormula("warn")).verdict).toBe("fail");
    // The formula findings still ride beside the structure.
    expect(check(brokenFormula("warn")).problems.length).toBe(1);
  });

  it("a formula-only problem keeps its old verdict: warn under warn", () => {
    const definition = form([field("a", "text", {}, { rules: { visibleWhen: "((" } })], {}, { configuration: { formulaErrors: "warn" } });
    expect(check(definition)).toMatchObject({ verdict: "warn", structure: [] });
  });
});

describe("secrecy and determinism", () => {
  const MARK = "ZZ_STRUCT_SECRET_7731";

  it("a duplicate id on a component with a server-secret rule leaks neither the rule's text nor a function name", () => {
    const secret = { formula: `${MARK}(a) = 1 and a = "${MARK}"`, run: "server-secret" };
    const answer = check(form([field("a"), field("a", "text", {}, { rules: { requiredWhen: secret, visibleWhen: secret } })]));
    expect(tokens(answer.structure)).toEqual(["component.id.duplicate@root > content > a", "component.dataPath.duplicate@root > content > a"]);
    expect(JSON.stringify(answer)).not.toContain(MARK);
  });

  it("the same request twice answers the same bytes, and a frozen definition is not changed", () => {
    const definition = form([field("dup"), field("dup"), field("k", "text", { dataKey: "a b" })], { localization: { supportedLocales: [{ code: "en" }, { code: "en" }] } });
    const frozen = JSON.parse(JSON.stringify(definition)) as Json;
    const deepFreeze = (value: unknown): void => {
      if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(deepFreeze);
      }
    };
    deepFreeze(frozen);
    const first = stableStringify(run(definition));
    expect(stableStringify(run(definition))).toBe(first);
    expect(stableStringify(run(frozen))).toBe(first);
  });
});

describe("the rules that refuse what the engine tolerates today", () => {
  it("each is a refusal by default, flipped by one entry of kernelStructureSeverity", () => {
    for (const code of ["component.id.invalid", "component.dataKey.invalid", "component.dataPath.duplicate", "component.dataPath.conflict", "pdf.invalid", "pdf.layout.invalid"]) {
      expect(kernelStructureSeverity(code), code).toBe("refuse");
    }
    expect(kernelStructureSeverity("component.id.duplicate")).toBe("");
  });
});

describe("the kernel shape", () => {
  it("lists every function as a kernel-named declaration spliced into the portable kernel, with no clock, locale or randomness", () => {
    const forbidden = /\bDate\b|\bIntl\b|Math\.random|localeCompare/;
    for (const fn of STRUCTURE_FUNCTIONS) {
      expect(fn.name.startsWith("kernelStructure"), fn.name).toBe(true);
      expect(fn.toString().trimStart().startsWith("function "), fn.name).toBe(true);
      expect(fn.toString(), fn.name).not.toMatch(forbidden);
      expect(PORTABLE_KERNEL_FUNCTIONS, fn.name).toContain(fn);
    }
    const names = STRUCTURE_FUNCTIONS.map((fn) => fn.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("parity with the engine helpers the rules mirror", () => {
  /** A seeded generator, so the corpus is the same on every run. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  const IDS = ["a", "b", "c", "d", "name", "1x", "x y", "", "a-b", "a_b", "dup", "dup", "Z"];
  const KEYS = [undefined, undefined, undefined, "k", "k", "j", "a", "a", "a b", "123", "x.y", "ok_1", "", "name"];
  const TYPES = ["text", "text", "select", "container", "container", "group", "repeatingSection", "dataGrid", "button", "html", "fieldset", "checkbox"];

  function tree(next: () => number, size: number): ComponentNode {
    const pick = <T,>(list: T[]): T => list[Math.floor(next() * list.length)] as T;
    const nodes: ComponentNode[] = [];
    for (let n = 0; n < size; n += 1) {
      const type = pick(TYPES);
      const configuration: Record<string, unknown> = {};
      const key = pick(KEYS);
      if (key !== undefined) {
        configuration.dataKey = key;
      }
      if (type === "container" && next() < 0.2) {
        configuration.scopeData = false;
      }
      if (type === "dataGrid" && next() < 0.7) {
        configuration.dataPath = pick(["rows", "k", "a.b", "orders", "k.x", "a[0]"]);
      }
      const node: ComponentNode = { id: pick(IDS), type, configuration };
      if (type === "repeatingSection") {
        (node as { collection?: unknown }).collection = next() < 0.5 ? {} : { collectionPath: pick(["rows", "k", "a.b", "items", "k.x", "a[0]"]) };
      }
      nodes.push(node);
    }
    // Hang each node below an earlier one when that one can hold children.
    const root: ComponentNode = { id: "form", type: "form", configuration: {}, children: { content: [] } };
    const holders: ComponentNode[] = [root];
    for (const node of nodes) {
      const holder = pick(holders);
      const slot = (holder.children = holder.children ?? {});
      (slot.content = slot.content ?? []).push(node);
      if (["container", "group", "repeatingSection", "fieldset"].includes(node.type)) {
        node.children = { content: [] };
        holders.push(node);
      }
    }
    return root;
  }

  it("ids: rule 14 is !isValidComponentId, rule 15 is duplicateComponentIds, over 300 generated trees", () => {
    const next = random(7);
    for (let round = 0; round < 300; round += 1) {
      const root = tree(next, 3 + Math.floor(next() * 12));
      const answer = check({ id: "f", version: "1", schemaVersion: "1", root });
      const flat: ComponentNode[] = [];
      const walk = (node: ComponentNode): void => {
        flat.push(node);
        for (const list of Object.values(node.children ?? {})) {
          list.forEach(walk);
        }
      };
      walk(root);
      const invalid = flat.filter((node) => !isValidComponentId(node.id)).length;
      expect(answer.structure.filter((problem) => problem.code === "component.id.invalid").length, `round ${round}`).toBe(invalid);
      const repeated = flat.length - new Set(flat.map((node) => node.id)).size;
      expect(answer.structure.filter((problem) => problem.code === "component.id.duplicate").length, `round ${round}`).toBe(repeated);
      expect([...new Set(duplicateComponentIds(root))].length > 0, `round ${round}`).toBe(repeated > 0);
    }
  });

  it("data keys and places: rules 19, 22 and 23 match findDataKeyProblems over 400 generated trees", () => {
    const next = random(11);
    let sawDuplicate = 0;
    let sawConflict = 0;
    for (let round = 0; round < 400; round += 1) {
      const root = tree(next, 3 + Math.floor(next() * 12));
      // Unique valid ids isolate the data-key rules from the id rules.
      let counter = 0;
      const rename = (node: ComponentNode): void => {
        node.id = node === root ? "form" : `n${(counter += 1)}`;
        for (const list of Object.values(node.children ?? {})) {
          list.forEach(rename);
        }
      };
      rename(root);
      // `check` reads the definition as the run does, grids normalized; so does the engine side.
      const engine = findDataKeyProblems(normalizeDataGrids(root));
      const answer = check({ id: "f", version: "1", schemaVersion: "1", root });
      const count = (code: string) => answer.structure.filter((problem) => problem.code === code).length;
      expect(count("component.dataKey.invalid"), `round ${round} invalid`).toBe(engine.filter((problem) => problem.code === "invalid-key").length);
      expect(count("component.dataPath.duplicate"), `round ${round} duplicate`).toBe(engine.filter((problem) => problem.code === "duplicate-path").length);
      expect(count("component.dataPath.conflict"), `round ${round} conflict`).toBe(engine.filter((problem) => problem.code === "path-conflict").length);
      sawDuplicate += count("component.dataPath.duplicate");
      sawConflict += count("component.dataPath.conflict");
    }
    // The generator reaches both findings, or the comparison above proves little.
    expect(sawDuplicate).toBeGreaterThan(30);
    expect(sawConflict).toBeGreaterThan(5);
  });

  it("the leaf reading of 'holds an answer of its own' is kernelFoldHoldsOwnAnswer's", () => {
    for (const type of ["text", "select", "container", "group", "repeatingSection", "dataGrid", "button", "html", "image", "signature", "fieldset", "form", "custom-plugin"]) {
      for (const shape of [{}, { children: {} }, { collection: {} }]) {
        const node = { id: "n", type, configuration: {}, ...shape } as ComponentNode;
        expect(kernelStructureHoldsAnswer(node as never), `${type} ${JSON.stringify(shape)}`).toBe(kernelFoldHoldsOwnAnswer(node));
      }
    }
  });

  it("rule 30 is kernelIsJourney and validateJourneyShape (for the shapes the structure pass reads)", () => {
    const journeys: unknown[] = [
      { id: "j", pages: [page("p")] },
      { id: "j", pages: [] },
      { id: "", pages: [page("p")] },
      { pages: [page("p")] },
      { id: "j", pages: [page("p"), page("p")] },
      { id: "j", pages: [{ components: ["a"] }] },
      { id: "j", pages: [page("p", { when: 5 })] },
      { id: "j", pages: [page("p", { routes: [{ to: 5 }] })] },
      { id: "j", pages: [page("p", { components: [5] })] },
      { id: "j", pages: [page("p", { kind: "weird" })] },
      { id: "j", pages: [page("p")], progress: "sideways" },
      { id: "j", pages: [page("p", { validation: { continue: "maybe" } })] }
    ];
    for (const journey of journeys) {
      const answer = check(journeyForm([journey]));
      const refused = answer.structure.some((problem) => problem.code === "journey.invalid");
      expect(refused, JSON.stringify(journey)).toBe(!kernelIsJourney(journey));
      expect(refused, JSON.stringify(journey)).toBe(validateJourneyShape(journey).length > 0);
    }
  });

  it("rule 37 refuses only layouts validatePdfLayout also refuses", () => {
    const layouts: unknown[] = [
      { id: "g", kind: "generated", root: { id: "d", type: "pdf-document" } },
      { id: "t", kind: "template", template: { storage: "base64", data: "AA==" }, fields: [] },
      { id: "x", kind: "template", template: { storage: "" }, fields: [] },
      { id: " ", kind: "generated", root: { id: "d", type: "pdf-document" } },
      { kind: "generated", root: { id: "d", type: "pdf-document" } },
      { id: "n", kind: "generated" },
      { id: "n", kind: "other" },
      5
    ];
    for (const layout of layouts) {
      const refused = check({ ...form(), pdf: { layouts: [layout] } }).structure.some((problem) => problem.code === "pdf.layout.invalid");
      if (refused) {
        expect(validatePdfLayout(layout).length, JSON.stringify(layout)).toBeGreaterThan(0);
      }
      if (validatePdfLayout(layout).length === 0) {
        expect(refused, JSON.stringify(layout)).toBe(false);
      }
    }
  });
});

describe("a data grid in the check", () => {
  const grid = (configuration: Record<string, unknown>, extra: Json = {}): Json => ({
    id: "lines",
    type: "dataGrid",
    configuration,
    collection: { collectionPath: "lines" },
    children: { content: [field("sku")] },
    ...extra
  });

  it("warns, never refuses, on a row bound that is not a whole number from 0 to 500 or a minimum past the maximum", () => {
    for (const configuration of [{ minRows: -1 }, { maxRows: 501 }, { initialRows: 2.5 }, { minRows: "2" }, { minRows: 4, maxRows: 2 }, { maxRows: null }]) {
      const answer = check(form([grid(configuration)]));
      expect(tokens(answer.structureWarnings), JSON.stringify(configuration)).toEqual(["component.dataGrid.bounds@root > content > lines"]);
      expect(answer.structureWarnings[0]?.limit).toBe(500);
      expect(answer.verdict, JSON.stringify(configuration)).toBe("ok");
    }
    for (const configuration of [{}, { minRows: 0, maxRows: 500, initialRows: 3 }, { minRows: 2, maxRows: 2 }, { maxRows: 1 }]) {
      expect(check(form([grid(configuration)])).structureWarnings, JSON.stringify(configuration)).toEqual([]);
    }
    // Not a grid: the same keys mean nothing.
    expect(check(form([field("t", "text", { minRows: -1 })])).structureWarnings).toEqual([]);
  });

  it("warns, never refuses, on a minRows or maxRows formula on a component that is not a grid", () => {
    for (const rules of [{ minRows: "2" }, { maxRows: { formula: "3", run: "server" } }, { minRows: "1", maxRows: "4" }]) {
      const answer = check(form([field("t", "text", {}, { rules })]));
      expect(tokens(answer.structureWarnings), JSON.stringify(rules)).toEqual(["component.dataGrid.boundsRule@root > content > t"]);
      expect(answer.structureWarnings[0]?.message).toBe("A minimum or maximum rows formula is read on a data grid only; on this component it does nothing.");
      expect(answer.verdict).toBe("ok");
    }
    // On a grid, or cleared (null), nothing to say.
    expect(check(form([grid({}, { rules: { minRows: "2", maxRows: "4" } })])).structureWarnings).toEqual([]);
    expect(check(form([field("t", "text", {}, { rules: { minRows: null } })])).structureWarnings).toEqual([]);
    // Read by truthiness, as the fold and the stage read every rule: an empty text, 0 or false is no rule.
    for (const value of ["", 0, false, null]) {
      expect(check(form([field("t", "text", {}, { rules: { minRows: value, maxRows: value } })])).structureWarnings, JSON.stringify(value)).toEqual([]);
    }
    expect(tokens(check(form([field("t", "text", {}, { rules: { minRows: "", maxRows: 3 } })])).structureWarnings)).toEqual(["component.dataGrid.boundsRule@root > content > t"]);
  });

  it("places a grid's rows at its collection path, as a section's", () => {
    // Two grids on one path is the duplicate a section would be.
    const twice = check(form([grid({}), grid({}, { id: "again", children: { content: [field("sku2")] } })]));
    expect(tokens(twice.structure)).toEqual(["component.dataPath.duplicate@root > content > again"]);
  });
});

describe("chrome part ids: the key a part's translations live under", () => {
  const text = (id: unknown, words = "Hello"): Json => (id === undefined ? { type: "text", text: words } : { id, type: "text", text: words });
  const group = (id: unknown, parts: Json[]): Json => ({ id, type: "group", parts });
  const withChrome = (chrome: Json): Json => form([field("a")], {}, { configuration: { chrome } });

  it("a missing, unsafe or repeated id is a structure problem, across the header, the footer and groups, named by place", () => {
    const answer = check(
      withChrome({
        header: [text("x", "Welcome"), text(undefined), group("box", [text("constructor"), text("y")])],
        footer: [text("x", "Privacy notice"), text("")]
      })
    );
    expect(tokens(answer.structure)).toEqual([
      "chrome.part.id.duplicate@chrome:header:0",
      "chrome.part.id.missing@chrome:header:1",
      "chrome.part.id.missing@chrome:header:2.0",
      "chrome.part.id.duplicate@chrome:footer:0",
      "chrome.part.id.missing@chrome:footer:1"
    ]);
    expect(answer.verdict).toBe("fail");
  });

  it("unique safe ids pass, and the problems found are the reader's own (chromePartIdProblems)", () => {
    expect(check(withChrome({ header: [text("h1"), group("g", [text("g1")])], footer: [text("f1")] })).structure).toEqual([]);
    let state = 23;
    const next = (): number => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const ids = ["a", "b", "a", "", "__proto__", "prototype", undefined, 5, "c"];
    for (let round = 0; round < 200; round += 1) {
      const parts = (depth: number): Json[] =>
        Array.from({ length: Math.floor(next() * 4) }, () => (depth < 3 && next() < 0.3 ? group(ids[Math.floor(next() * ids.length)], parts(depth + 1)) : text(ids[Math.floor(next() * ids.length)])));
      const chrome = { header: parts(1), footer: parts(1) };
      const kernel = check(withChrome(chrome)).structure.filter((problem) => problem.code.startsWith("chrome.part.id."));
      const reader = chromePartIdProblems({ chrome });
      expect(kernel.length, `round ${round}`).toBe(reader.length);
      expect(kernel.filter((problem) => problem.code === "chrome.part.id.duplicate").length, `round ${round}`).toBe(reader.filter((problem) => problem.code === "repeated").length);
    }
  });
});

describe("reserved ids: the words a rule reads as a scope, and names the translations map cannot key", () => {
  const generated = (id: string): Json => ({ id, kind: "generated", root: { id: `doc_${id}`, type: "pdf-document" } });

  it.each(["component", "host", "row", "ancestor"])("a component id %s is refused as reserved, its message naming the word", (word) => {
    const answer = check(form([field("a"), field(word)]));
    expect(tokens(answer.structure)).toEqual([`component.id.reserved@root > content > ${word}`]);
    expect(answer.structure[0]?.message).toContain(`"${word}"`);
    expect(answer.verdict).toBe("fail");
  });

  it("a container or a grid named with one is refused too, and a longer id that only starts with one is not", () => {
    const answer = check(form([{ id: "row", type: "fieldset", configuration: {}, children: { content: [field("hosted"), field("rows"), field("Component")] } }]));
    expect(tokens(answer.structure)).toEqual(["component.id.reserved@root > content > row"]);
  });

  it("the scope words are the engine's reserved ids beyond the two the translations map cannot key (isReservedComponentId)", () => {
    for (const id of ["component", "host", "row", "ancestor", "constructor", "prototype", "toString", "rows", "Component"]) {
      const codes = check(form([field(id)])).structure.map((problem) => problem.code);
      expect(codes.includes("component.id.reserved") || codes.includes("component.id.invalid"), id).toBe(isReservedComponentId(id));
    }
  });

  it("constructor and prototype are reserved like the scope words, the message naming the word; toString stays a warning", () => {
    const answer = check(form([field("constructor"), field("toString"), field("prototype")]));
    expect(tokens(answer.structure)).toEqual(["component.id.reserved@root > content > constructor", "component.id.reserved@root > content > prototype"]);
    expect(answer.structure.map((problem) => problem.message)).toEqual([componentIdProblem("constructor"), componentIdProblem("prototype")]);
    expect(answer.structureWarnings.map((problem) => problem.code)).toEqual(["component.id.prototypeName"]);
  });

  it("component.id.invalid is the grammar only: a reserved word is never reported as invalid", () => {
    for (const word of ["component", "host", "row", "ancestor", "constructor", "prototype"]) {
      const answer = check(form([field(word)]));
      expect(answer.structure.map((problem) => problem.code), word).toEqual(["component.id.reserved"]);
    }
    expect(check(form([field("1a")])).structure.map((problem) => problem.code)).toEqual(["component.id.invalid"]);
  });

  it.each(["component", "host", "row", "ancestor", "constructor", "prototype"])("the kernel's sentence for the reserved component id %s is the builder's (componentIdProblem)", (word) => {
    expect(check(form([field(word)])).structure[0]?.message).toBe(componentIdProblem(word));
  });

  it.each(["constructor", "prototype", "__proto__"])("a PDF layout id %s is refused as reserved", (id) => {
    const answer = check({ ...form(), pdf: { layouts: [generated("ok"), generated(id)] } });
    expect(answer.structure.map((problem) => problem.code)).toEqual(["pdf.layout.id.reserved"]);
    expect(answer.structure[0]?.message).toContain(`"${id}"`);
    expect(answer.verdict).toBe("fail");
  });

  it.each(["constructor", "prototype", "__proto__"])("a journey id and a page id %s are refused as reserved", (id) => {
    const journey = check(journeyForm([{ id, pages: [page("p")] }]));
    expect(journey.structure.map((problem) => problem.code)).toEqual(["journey.id.reserved"]);
    expect(journey.structure[0]?.message).toContain(`"${id}"`);
    const pageAnswer = check(journeyForm([{ id: "j", pages: [page("p"), page(id)] }]));
    expect(pageAnswer.structure.map((problem) => problem.code)).toEqual(["journey.page.id.reserved"]);
    expect(pageAnswer.structure[0]?.where.startsWith("journey:j:page:")).toBe(true);
  });

  it("one sentence per reserved-id kind, the one kernelStructureMessage gives for the code and the word (the builder words its refusals with it)", () => {
    expect(check({ ...form(), pdf: { layouts: [generated("constructor")] } }).structure[0]?.message).toBe(
      '"constructor" cannot be a PDF layout id: it is a reserved name, and texts kept under it could not be translated (__proto__, constructor and prototype are).'
    );
    expect(check(journeyForm([{ id: "prototype", pages: [page("p")] }])).structure[0]?.message).toBe(kernelStructureMessage("journey.id.reserved", undefined, "prototype"));
    expect(check(journeyForm([{ id: "j", pages: [page("p"), page("__proto__")] }])).structure[0]?.message).toBe(kernelStructureMessage("journey.page.id.reserved", undefined, "__proto__"));
    expect(kernelStructureMessage("journey.page.id.reserved", undefined, "__proto__")).toBe(
      '"__proto__" cannot be a page id: it is a reserved name, and texts kept under it could not be translated (__proto__, constructor and prototype are).'
    );
    expect(kernelStructureMessage("component.id.reserved", undefined, "row")).toBe(componentIdProblem("row"));
  });

  it("the scope words are free as layout, journey and page ids: only component ids are read by rules", () => {
    expect(check({ ...form(), pdf: { layouts: [generated("row")] } }).structure).toEqual([]);
    expect(check(journeyForm([{ id: "host", pages: [page("component")] }])).structure).toEqual([]);
  });
});

describe("inverted limits: a minimum above its maximum warns, the run still ignores the pair", () => {
  it("minLength above maxLength on a text field warns once, naming the field", () => {
    const answer = check(form([field("a", "text", { minLength: 5, maxLength: 2 })]));
    expect(answer.structure).toEqual([]);
    expect(tokens(answer.structureWarnings)).toEqual(["component.limits.inverted@root > content > a"]);
    expect(answer.verdict).toBe("ok");
  });

  it("min above max on a number field, and on a date field, warns", () => {
    const answer = check(form([field("n", "number", { min: 10, max: 1 }), field("d", "date", { min: "2026-12-31", max: "2026-01-01" }), field("s", "number", { min: "10", max: "9" })]));
    expect(tokens(answer.structureWarnings)).toEqual([
      "component.limits.inverted@root > content > n",
      "component.limits.inverted@root > content > d",
      "component.limits.inverted@root > content > s"
    ]);
  });

  it("is read as the run reads the limits: equal, one-sided, unreadable or floored-equal pairs say nothing", () => {
    const answer = check(
      form([
        field("a", "text", { minLength: 3, maxLength: 3 }),
        field("b", "text", { minLength: 5 }),
        field("c", "text", { minLength: "9", maxLength: 2 }),
        field("e", "text", { minLength: 2.9, maxLength: 2.1 }),
        field("f", "text", { minLength: 0, maxLength: 2 }),
        field("g", "number", { min: 5, max: "x" }),
        field("h", "date", { min: "2026-02-30", max: "2026-01-01" }),
        field("i", "text", { min: 10, max: 1 })
      ])
    );
    expect(answer.structureWarnings).toEqual([]);
  });

  it("a field with both pairs inverted warns once", () => {
    const answer = check(form([field("n", "number", { min: 10, max: 1, minLength: 4, maxLength: 1 })]));
    expect(tokens(answer.structureWarnings)).toEqual(["component.limits.inverted@root > content > n"]);
  });
});
