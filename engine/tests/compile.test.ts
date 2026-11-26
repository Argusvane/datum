import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { ComponentNode, ComponentRules, FormDefinition } from "../form-engine/core/schema/types.js";
import type { FormulaFunctionSignature, FormulaParseResult, FormulaProblem } from "../form-engine/core/expressions/formula-types.js";
import {
  kernelCompileRulesOf,
  COMPILE_FUNCTIONS,
  kernelCompileDefinition,
  kernelCompileRules,
  kernelFormulaPolicy,
  kernelRegexRisky,
  kernelRegexStepsMax,
  kernelRegexEscape,
  kernelRegexQuantifier,
  kernelRegexPatternMax,
  kernelRiskGuardParser,
  kernelRiskyMatchesIn,
  kernelIsSecretRule,
  kernelHoldsSecretSource,
  kernelRuleExpression,
  kernelRuleRun,
  kernelRuleRunsOn,
  kernelStripSecretRules,
  kernelStripSecretJourney,
  publicDefinition,
  type FormulaParser
} from "../form-engine/core/expressions/compile.js";
import { readJourneys, validateJourneyShape } from "../form-engine/core/schema/journey.js";
import { kernelIsJourney } from "../form-engine/validation/wasm/portable-kernel.js";
import { kernelPublicDefinition } from "../form-engine/core/expressions/inspect.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { isEvaluableExpression } from "../form-engine/core/expressions/condition-shape.js";
import { isExpression } from "../form-engine/builder/property-editor/rules-model.js";
import { FORMULA_FUNCTION_TABLE } from "../form-engine/core/expressions/function-table.js";
import {
  kernelCallResultKind,
  kernelConditionKind,
  kernelConditionWarnings,
  kernelIsRuleKey,
  kernelIsServerRuleKey,
  kernelProblemRunsOnServer,
  kernelTreeReadsRow
} from "../form-engine/core/expressions/compile.js";

/**
 * A stub parser with three readings: blank → no expression; `!!` anywhere → a failure whose span
 * is the `!!`; `<path> = "<text>"` → an equality; anything else → a path. Enough to tell a
 * compiled tree from its source and to place a problem.
 */
const stubParser: FormulaParser = (text): FormulaParseResult => {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: true, expression: undefined, paths: [] };
  }
  const bad = text.indexOf("!!");
  if (bad >= 0) {
    return { ok: false, code: "unexpected", params: { token: "!!" }, message: "Unexpected !!", start: bad, end: bad + 2 };
  }
  const match = /^([\w.]+)\s*=\s*"([^"]*)"$/.exec(trimmed);
  if (match) {
    const path = match[1] ?? "";
    const literal = match[2] ?? "";
    const expression: Expression = {
      kind: "binary",
      operator: "eq",
      left: { kind: "path", path },
      right: { kind: "literal", value: literal }
    };
    return { ok: true, expression, paths: [{ path, start: 0, end: path.length }] };
  }
  return { ok: true, expression: { kind: "path", path: trimmed }, paths: [{ path: trimmed, start: 0, end: trimmed.length }] };
};

const signatures: FormulaFunctionSignature[] = [{ name: "upper", min: 1, max: 1 }];

const emailPath: Expression = { kind: "path", path: "email" };

function field(id: string, extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type: "text", configuration: { label: id }, ...extra };
}

function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

describe("kernelRuleExpression", () => {
  it("reads a string, a tree and the object form to the same tree", () => {
    const fromString = kernelRuleExpression("email", stubParser, signatures);
    const fromTree = kernelRuleExpression(emailPath, stubParser, signatures);
    const fromFormula = kernelRuleExpression({ formula: "email" }, stubParser, signatures);
    const fromExpression = kernelRuleExpression({ expression: emailPath, run: "server" }, stubParser, signatures);
    expect(fromString).toEqual(emailPath);
    expect(fromTree).toBe(emailPath);
    expect(fromFormula).toEqual(emailPath);
    expect(fromExpression).toBe(emailPath);
  });

  it("prefers the object form's expression over its formula", () => {
    const tree: Expression = { kind: "literal", value: true };
    expect(kernelRuleExpression({ formula: "email", expression: tree }, stubParser, signatures)).toBe(tree);
  });

  it("hands the signatures to the parser", () => {
    let seen: FormulaFunctionSignature[] | undefined;
    const spy: FormulaParser = (text, given) => {
      seen = given;
      return stubParser(text, given);
    };
    kernelRuleExpression("email", spy, signatures);
    expect(seen).toBe(signatures);
  });

  it("is undefined for a failed parse, a blank formula and any other shape", () => {
    expect(kernelRuleExpression("a !! b", stubParser, signatures)).toBeUndefined();
    expect(kernelRuleExpression({ formula: "!!" }, stubParser, signatures)).toBeUndefined();
    expect(kernelRuleExpression("   ", stubParser, signatures)).toBeUndefined();
    expect(kernelRuleExpression({ run: "server" }, stubParser, signatures)).toBeUndefined();
    expect(kernelRuleExpression({ expression: "email" }, stubParser, signatures)).toBeUndefined();
    expect(kernelRuleExpression(42, stubParser, signatures)).toBeUndefined();
    expect(kernelRuleExpression(null, stubParser, signatures)).toBeUndefined();
    expect(kernelRuleExpression([emailPath], stubParser, signatures)).toBeUndefined();
    expect(kernelRuleExpression(undefined, stubParser, signatures)).toBeUndefined();
  });
});

describe("kernelRuleRun and kernelRuleRunsOn", () => {
  it("reads the scope word from the object form and defaults everything else to both", () => {
    expect(kernelRuleRun("email")).toBe("both");
    expect(kernelRuleRun(emailPath)).toBe("both");
    expect(kernelRuleRun({ formula: "email" })).toBe("both");
    expect(kernelRuleRun({ formula: "email", run: "both" })).toBe("both");
    expect(kernelRuleRun({ formula: "email", run: "browser" })).toBe("browser");
    expect(kernelRuleRun({ formula: "email", run: "server" })).toBe("server");
    expect(kernelRuleRun({ formula: "email", run: "server-secret" })).toBe("server-secret");
    expect(kernelRuleRun({ formula: "email", run: "client" })).toBe("both");
    expect(kernelRuleRun({ formula: "email", run: 1 })).toBe("both");
    expect(kernelRuleRun({ kind: "path", path: "x", run: "server" })).toBe("both");
    expect(kernelRuleRun(undefined)).toBe("both");
  });

  const scopes = ["both", "browser", "server", "server-secret"] as const;
  const sharedKeys = ["visibleWhen", "requiredWhen", "enabledWhen", "readonlyWhen", "value"] as const;
  const browserKeys = ["defaultValue", "filter", "navigationGating"] as const;

  it("runs shared keys per scope on each side", () => {
    const browser = { both: true, browser: true, server: false, "server-secret": false };
    const server = { both: true, browser: false, server: true, "server-secret": true };
    for (const key of sharedKeys) {
      for (const scope of scopes) {
        const source = { formula: "email", run: scope };
        expect(kernelRuleRunsOn(source, key, "browser"), `${key} ${scope} browser`).toBe(browser[scope]);
        expect(kernelRuleRunsOn(source, key, "server"), `${key} ${scope} server`).toBe(server[scope]);
      }
      expect(kernelRuleRunsOn("email", key, "browser")).toBe(true);
      expect(kernelRuleRunsOn("email", key, "server")).toBe(true);
      expect(kernelRuleRunsOn(emailPath, key, "browser")).toBe(true);
      expect(kernelRuleRunsOn(emailPath, key, "server")).toBe(true);
    }
  });

  it("runs browser-only keys in the browser alone whatever the scope says", () => {
    for (const key of browserKeys) {
      for (const scope of scopes) {
        const source = { formula: "email", run: scope };
        expect(kernelRuleRunsOn(source, key, "browser"), `${key} ${scope} browser`).toBe(true);
        expect(kernelRuleRunsOn(source, key, "server"), `${key} ${scope} server`).toBe(false);
      }
      expect(kernelRuleRunsOn("email", key, "browser")).toBe(true);
      expect(kernelRuleRunsOn("email", key, "server")).toBe(false);
      expect(kernelRuleRunsOn(emailPath, key, "browser")).toBe(true);
      expect(kernelRuleRunsOn(emailPath, key, "server")).toBe(false);
    }
  });
});

describe("kernelCompileRulesOf", () => {
  it("keeps a node's rules that are not a record as written and reports them, so the shape checks refuse the node as before", () => {
    const problems: FormulaProblem[] = [];
    expect(kernelCompileRulesOf(null, "rules:f", true, kernelParseFormula, formulaFunctionSignatures(), [])).toBeNull();
    for (const rules of [[], "visible", 7]) {
      problems.length = 0;
      const kept = kernelCompileRulesOf(rules, "rules:f", true, kernelParseFormula, formulaFunctionSignatures(), problems);
      expect(kept).toBe(rules);
      expect(problems.map((problem) => [problem.where, problem.code, problem.params?.key])).toEqual([["rules:f", "invalidRule", "rules"]]);
    }
    problems.length = 0;
    const compiled = kernelCompileRulesOf({ visibleWhen: "a = 1" }, "rules:f", true, kernelParseFormula, formulaFunctionSignatures(), problems);
    expect(problems).toEqual([]);
    expect((compiled as Record<string, unknown>).visibleWhen).toMatchObject({ kind: "binary", operator: "eq" });
  });
});

describe("kernelCompileRules", () => {
  it("compiles a string, a tree and the object form alike", () => {
    const problems: FormulaProblem[] = [];
    const rules = {
      visibleWhen: "email",
      requiredWhen: emailPath,
      enabledWhen: { formula: "email" },
      readonlyWhen: { formula: "email", run: "server" },
      value: { expression: emailPath, formula: "ignored", run: "server-secret" }
    };
    const before = snapshot(rules);
    const compiled = kernelCompileRules(rules, "rules:f", true, stubParser, signatures, problems);
    expect(snapshot(rules)).toBe(before);
    expect(problems).toEqual([]);
    expect(compiled).toEqual({
      visibleWhen: emailPath,
      requiredWhen: emailPath,
      enabledWhen: { expression: emailPath },
      readonlyWhen: { expression: emailPath, run: "server" },
      value: { expression: emailPath, run: "server-secret" }
    });
    expect(compiled.requiredWhen).toBe(emailPath);
    expect("formula" in (compiled.value as object)).toBe(false);
    expect("run" in (compiled.enabledWhen as object)).toBe(false);
  });

  it("drops a key whose formula fails and reports it with its span and text", () => {
    const problems: FormulaProblem[] = [];
    const compiled = kernelCompileRules(
      { visibleWhen: "email", requiredWhen: "name !! here", value: { formula: "x !!" } },
      "rules:f",
      true,
      stubParser,
      signatures,
      problems
    );
    expect(Object.keys(compiled)).toEqual(["visibleWhen"]);
    expect(problems).toEqual([
      { where: "rules:f:requiredWhen", code: "unexpected", message: "Unexpected !!", params: { token: "!!" }, start: 5, end: 7, text: "name !! here" },
      { where: "rules:f:value", code: "unexpected", message: "Unexpected !!", params: { token: "!!" }, start: 2, end: 4, text: "x !!" }
    ]);
  });

  it("drops a blank formula, a null or undefined rule and an unknown run word without a problem", () => {
    const problems: FormulaProblem[] = [];
    const compiled = kernelCompileRules(
      { visibleWhen: "  ", requiredWhen: null, enabledWhen: undefined, readonlyWhen: { formula: "   " }, value: { formula: "email", run: "nowhere" } },
      "rules:f",
      true,
      stubParser,
      signatures,
      problems
    );
    expect(problems).toEqual([]);
    expect(compiled).toEqual({ value: { expression: emailPath } });
  });

  it("reports a rule that is neither a formula, a tree nor the object form as invalidRule and drops the key", () => {
    const odd: Record<string, unknown> = {
      visibleWhen: true,
      requiredWhen: {},
      enabledWhen: 1,
      readonlyWhen: [true],
      value: { kind: 5 },
      defaultValue: { run: "server" },
      filter: { expression: "email" },
      navigationGating: false
    };
    const problems: FormulaProblem[] = [];
    const compiled = kernelCompileRules(odd, "rules:f", true, stubParser, signatures, problems);
    expect(compiled).toEqual({});
    expect(problems.map((problem) => [problem.where, problem.code, problem.params])).toEqual([
      ["rules:f:visibleWhen", "invalidRule", { key: "visibleWhen", got: "boolean" }],
      ["rules:f:requiredWhen", "invalidRule", { key: "requiredWhen", got: "object" }],
      ["rules:f:enabledWhen", "invalidRule", { key: "enabledWhen", got: "number" }],
      ["rules:f:readonlyWhen", "invalidRule", { key: "readonlyWhen", got: "array" }],
      ["rules:f:value", "invalidRule", { key: "value", got: "object" }],
      ["rules:f:defaultValue", "invalidRule", { key: "defaultValue", got: "object" }],
      ["rules:f:filter", "invalidRule", { key: "filter", got: "object" }],
      ["rules:f:navigationGating", "invalidRule", { key: "navigationGating", got: "boolean" }]
    ]);
    for (const problem of problems) {
      expect(problem.message).toContain("formula");
      expect(problem.text).toBeUndefined();
    }
  });

  it("compiles only the eight ComponentRules keys and copies any other key under rules as written", () => {
    const note = { author: "x" };
    const problems: FormulaProblem[] = [];
    const compiled = kernelCompileRules(
      { visibleWhen: "email", note: "kept?", comment: "a !! b", meta: note, flag: 7 },
      "rules:f",
      true,
      stubParser,
      signatures,
      problems
    );
    expect(problems).toEqual([]);
    expect(compiled).toEqual({ visibleWhen: emailPath, note: "kept?", comment: "a !! b", meta: note, flag: 7 });
    expect(compiled.meta).toBe(note);
  });

  it("refuses a server scope on every key when the site is not a form component (serverAllowed false)", () => {
    const problems: FormulaProblem[] = [];
    const compiled = kernelCompileRules(
      {
        visibleWhen: { formula: "email", run: "server" },
        value: { expression: emailPath, run: "server-secret" },
        requiredWhen: { formula: "email", run: "browser" },
        enabledWhen: { formula: "email", run: "both" },
        readonlyWhen: "email"
      },
      "journey:j:node:n",
      false,
      stubParser,
      signatures,
      problems
    );
    expect(compiled).toEqual({
      visibleWhen: { expression: emailPath, run: "both" },
      value: { expression: emailPath, run: "both" },
      requiredWhen: { expression: emailPath, run: "browser" },
      enabledWhen: { expression: emailPath, run: "both" },
      readonlyWhen: emailPath
    });
    expect(problems.map((problem) => [problem.where, problem.code, problem.params, problem.start, problem.end, problem.text])).toEqual([
      ["journey:j:node:n:visibleWhen", "runScope", { key: "visibleWhen", run: "server" }, 0, 5, "email"],
      ["journey:j:node:n:value", "runScope", { key: "value", run: "server-secret" }, 0, 0, ""]
    ]);
  });

  it("reports a server scope on a browser-only key and keeps the rule on both sides", () => {
    const problems: FormulaProblem[] = [];
    const compiled = kernelCompileRules(
      {
        defaultValue: { formula: "email", run: "server" },
        filter: { expression: emailPath, run: "server-secret" },
        navigationGating: { formula: "email", run: "browser" }
      },
      "rules:f",
      true,
      stubParser,
      signatures,
      problems
    );
    expect(compiled).toEqual({
      defaultValue: { expression: emailPath, run: "both" },
      filter: { expression: emailPath, run: "both" },
      navigationGating: { expression: emailPath, run: "browser" }
    });
    expect(problems.map((problem) => [problem.where, problem.code, problem.params, problem.start, problem.end, problem.text])).toEqual([
      ["rules:f:defaultValue", "runScope", { key: "defaultValue", run: "server" }, 0, 5, "email"],
      ["rules:f:filter", "runScope", { key: "filter", run: "server-secret" }, 0, 0, ""]
    ]);
    expect(problems[0]?.message).toContain("defaultValue");
  });

  it("returns an empty record for anything that is not a record", () => {
    const problems: FormulaProblem[] = [];
    expect(kernelCompileRules(undefined, "rules:f", true, stubParser, signatures, problems)).toEqual({});
    expect(kernelCompileRules("email", "rules:f", true, stubParser, signatures, problems)).toEqual({});
    expect(kernelCompileRules([emailPath], "rules:f", true, stubParser, signatures, problems)).toEqual({});
    expect(problems).toEqual([]);
  });
});

function definitionFixture(): FormDefinition {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: { title: "Fixture" },
    children: {
      default: [
        field("email", { rules: { visibleWhen: "session", requiredWhen: { formula: "email !! x", run: "server" } } as unknown as ComponentRules }),
        {
          id: "group",
          type: "fieldset",
          configuration: {},
          rules: { visibleWhen: emailPath },
          children: { default: [field("name", { rules: { value: { formula: "upper !! name" } } as unknown as ComponentRules })] }
        }
      ]
    }
  };
  return {
    id: "fixture",
    version: "1",
    schemaVersion: "1",
    root,
    journey: {
      journeys: [
        {
          id: "apply",
          pages: [
            {
              id: "start",
              components: [
                "email",
                { id: "own", type: "text", configuration: {}, rules: { visibleWhen: "own !!" } },
                {
                  id: "box",
                  type: "fieldset",
                  configuration: {},
                  children: { default: [{ id: "total", type: "journey-value", configuration: { to: "name", value: "nested !!" } }] }
                },
                { id: "worked", type: "journey-value", configuration: { to: "name", value: "email" } }
              ],
              routes: [{ to: "end", when: "route !!" }, { to: "end" }, { to: "start", when: 'session = "both"' }]
            }
          ]
        }
      ]
    },
    pdf: {
      layouts: [
        { id: "copy", kind: "generated", when: "layout !!" },
        {
          id: "filled",
          kind: "template",
          when: "email",
          template: { kind: "inline", data: "" },
          fields: [
            { name: "a", source: { kind: "component", componentId: "email" } },
            { name: "b", source: { kind: "expression", expression: "field !!" } }
          ],
          areas: [{ id: "area", page: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, source: { kind: "expression", expression: { formula: "area !!" } } }]
        }
      ]
    }
  } as unknown as FormDefinition;
}

describe("kernelCompileDefinition", () => {
  it("compiles every site into a copy and leaves the inputs untouched", () => {
    const definition = definitionFixture();
    const before = snapshot(definition);
    const compiled = kernelCompileDefinition(definition.root, definition.journey, definition.pdf, stubParser, signatures);
    expect(snapshot(definition)).toBe(before);
    const { root, journey, pdf } = compiled.definition;
    expect(root).not.toBe(definition.root);
    expect(root.children).not.toBe(definition.root.children);
    expect(root.children?.default).not.toBe(definition.root.children?.default);
    expect(journey).not.toBe(definition.journey);
    expect(pdf).not.toBe(definition.pdf);

    const email = root.children!.default![0]!;
    expect(email.configuration).toBe(definition.root.children!.default![0]!.configuration);
    expect(email.rules).toEqual({ visibleWhen: { kind: "path", path: "session" } });
    const group = root.children!.default![1]!;
    expect(group.rules?.visibleWhen).toBe(emailPath);
    expect(group.children!.default![0]!.rules).toEqual({});

    const compiledJourney = journey as { journeys: Array<{ pages: Array<Record<string, unknown>> }> };
    const page = compiledJourney.journeys[0]!.pages[0]!;
    expect("when" in page).toBe(false);
    const entries = page.components as Array<Record<string, unknown>>;
    expect(entries[0]).toBe("email");
    expect(entries[1]!.rules).toEqual({});
    const nested = (entries[2]!.children as { default: Array<Record<string, unknown>> }).default[0]!;
    expect(nested.configuration).toEqual({ to: "name" });
    expect(entries[3]!.configuration).toEqual({ to: "name", value: emailPath });
    const routes = page.routes as Array<Record<string, unknown>>;
    expect(routes[0]).toEqual({ to: "end" });
    expect(routes[1]).toEqual({ to: "end" });
    expect(routes[2]).toEqual({
      to: "start",
      when: { kind: "binary", operator: "eq", left: { kind: "path", path: "session" }, right: { kind: "literal", value: "both" } }
    });

    const compiledPdf = pdf as { layouts: Array<Record<string, unknown>> };
    expect("when" in compiledPdf.layouts[0]!).toBe(false);
    expect(compiledPdf.layouts[1]!.when).toEqual(emailPath);
    const fields = compiledPdf.layouts[1]!.fields as Array<Record<string, unknown>>;
    expect(fields[0]).toBe((definition.pdf as { layouts: Array<{ fields: unknown[] }> }).layouts[1]!.fields[0]!);
    expect(fields[1]).toEqual({ name: "b", source: { kind: "expression" } });
    const areas = compiledPdf.layouts[1]!.areas as Array<Record<string, unknown>>;
    expect(areas[0]!.source).toEqual({ kind: "expression" });
  });

  it("lists the problems in document order with where, span and text", () => {
    const definition = definitionFixture();
    const compiled = kernelCompileDefinition(definition.root, definition.journey, definition.pdf, stubParser, signatures);
    expect(compiled.problems.map((problem) => [problem.where, problem.start, problem.end, problem.text])).toEqual([
      ["rules:email:requiredWhen", 6, 8, "email !! x"],
      ["rules:name:value", 6, 8, "upper !! name"],
      ["journey:apply:node:own:visibleWhen", 4, 6, "own !!"],
      ["journey:apply:node:total", 7, 9, "nested !!"],
      ["journey:apply:page:start:route:0", 6, 8, "route !!"],
      ["pdf:copy", 7, 9, "layout !!"],
      ["pdf:filled:field:1", 6, 8, "field !!"],
      ["pdf:filled:area:0", 5, 7, "area !!"]
    ]);
    for (const problem of compiled.problems) {
      expect(problem.code).toBe("unexpected");
      expect(problem.params).toEqual({ token: "!!" });
      expect(problem.message).toBe("Unexpected !!");
    }
  });

  it("leaves a page's own when as written, compiled or reported by nothing: a page has no condition, and the shape check refuses it", () => {
    for (const when of ["page !!", "email", { formula: "email", run: "server-secret" }, true, null]) {
      const journey = { journeys: [{ id: "j", pages: [{ id: "p", when, components: [] }] }] };
      const compiled = kernelCompileDefinition(field("email"), journey, undefined, stubParser, signatures);
      expect(compiled.problems, JSON.stringify(when)).toEqual([]);
      expect(compiled.warnings, JSON.stringify(when)).toEqual([]);
      const page = (compiled.definition.journey as { journeys: Array<{ pages: Array<Record<string, unknown>> }> }).journeys[0]!.pages[0]!;
      expect(page.when, JSON.stringify(when)).toEqual(when);
    }
  });

  it("passes journey and pdf through when absent or not the expected shape", () => {
    const root = field("only");
    expect(kernelCompileDefinition(root, undefined, undefined, stubParser, signatures)).toEqual({
      definition: { root, journey: undefined, pdf: undefined },
      problems: [],
      warnings: []
    });
    const odd = { journeys: "none" };
    expect(kernelCompileDefinition(root, odd, "pdf", stubParser, signatures).definition.journey).toBe(odd);
    expect(kernelCompileDefinition(root, odd, "pdf", stubParser, signatures).definition.pdf).toBe("pdf");
  });

  it("walks the form tree in document order with an explicit stack: a tree 3,000 deep compiles", () => {
    let deep: ComponentNode = field("bottom", { rules: { visibleWhen: "bottom !!" } as unknown as ComponentRules });
    for (let level = 0; level < 3000; level += 1) {
      deep = { id: `layer_${level}`, type: "fieldset", configuration: {}, children: { content: [deep] } };
    }
    const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { default: [deep, field("after", { rules: { value: "after !!" } as unknown as ComponentRules })] } };
    const compiled = kernelCompileDefinition(root, undefined, undefined, stubParser, signatures);
    expect(compiled.problems.map((problem) => problem.where)).toEqual(["rules:bottom:visibleWhen", "rules:after:value"]);
    let node: ComponentNode | undefined = compiled.definition.root.children?.default?.[0];
    let depth = 0;
    while (node !== undefined && node.id !== "bottom") {
      depth += 1;
      node = node.children?.content?.[0];
    }
    expect(depth).toBe(3000);
    expect(node?.rules).toEqual({});
    expect(root.children?.default?.[0]?.children?.content?.[0]?.id).toBe("layer_2998");
  });

  it("lists problems in pre-order: a nested child before the next sibling", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        first: [
          {
            id: "a",
            type: "fieldset",
            configuration: {},
            rules: { visibleWhen: "a !!" } as unknown as ComponentRules,
            children: { default: [field("a1", { rules: { visibleWhen: "a1 !!" } as unknown as ComponentRules }), field("a2", { rules: { visibleWhen: "a2 !!" } as unknown as ComponentRules })] }
          },
          field("b", { rules: { visibleWhen: "b !!" } as unknown as ComponentRules })
        ],
        second: [field("c", { rules: { visibleWhen: "c !!" } as unknown as ComponentRules })]
      }
    };
    const compiled = kernelCompileDefinition(root, undefined, undefined, stubParser, signatures);
    expect(compiled.problems.map((problem) => problem.where)).toEqual([
      "rules:a:visibleWhen",
      "rules:a1:visibleWhen",
      "rules:a2:visibleWhen",
      "rules:b:visibleWhen",
      "rules:c:visibleWhen"
    ]);
    expect(compiled.definition.root.children?.first?.map((node) => node.id)).toEqual(["a", "b"]);
    expect(compiled.definition.root.children?.first?.[0]?.children?.default?.map((node) => node.id)).toEqual(["a1", "a2"]);
  });

  it("walks a journey's own layout 3,000 deep with an explicit stack and compiles the bottom node", () => {
    let deep: Record<string, unknown> = { id: "bottom", type: "text", configuration: { fills: "email" }, rules: { visibleWhen: "own !!" } };
    for (let level = 0; level < 3000; level += 1) {
      deep = { id: `layer_${level}`, type: "fieldset", configuration: {}, children: { content: [deep] } };
    }
    const journey = { journeys: [{ id: "deep", pages: [{ id: "p", components: [deep, "email"] }] }] };
    const compiled = kernelCompileDefinition(field("email"), journey, undefined, stubParser, signatures);
    expect(compiled.problems.map((problem) => problem.where)).toEqual(["journey:deep:node:bottom:visibleWhen"]);
    const page = (compiled.definition.journey as { journeys: Array<{ pages: Array<{ components: unknown[] }> }> }).journeys[0]!.pages[0]!;
    let node = page.components[0] as Record<string, unknown> | undefined;
    let depth = 0;
    while (node !== undefined && node.id !== "bottom") {
      depth += 1;
      node = (node.children as { content: Array<Record<string, unknown>> } | undefined)?.content[0];
    }
    expect(depth).toBe(3000);
    expect(node?.rules).toEqual({});
    expect(page.components[1]).toBe("email");
  });
});

describe("run scopes outside a form component's five kernel rules", () => {
  function scoped(): FormDefinition {
    return {
      id: "scoped",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          default: [
            field("ok", { rules: { visibleWhen: { formula: "email", run: "server" }, value: { formula: "email", run: "server-secret" } } as unknown as ComponentRules }),
            field("bo", { rules: { defaultValue: { formula: "email", run: "server-secret" } } as unknown as ComponentRules })
          ]
        }
      },
      journey: {
        journeys: [
          {
            id: "j",
            pages: [
              {
                id: "p",
                components: [
                  { id: "own", type: "text", configuration: {}, rules: { visibleWhen: { formula: "email", run: "server-secret" }, requiredWhen: { formula: "email", run: "browser" } } },
                  { id: "worked", type: "journey-value", configuration: { to: "email", value: { formula: "email", run: "server" } } }
                ],
                routes: [{ to: "p", when: { formula: "email", run: "server" } }]
              }
            ]
          }
        ]
      },
      pdf: {
        layouts: [
          {
            id: "l",
            kind: "template",
            when: { formula: "email", run: "server-secret" },
            template: { kind: "inline", data: "" },
            fields: [{ name: "a", source: { kind: "expression", expression: { formula: "email", run: "server" } } }],
            areas: [{ id: "area", page: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, source: { kind: "expression", expression: { expression: emailPath, run: "server-secret" } } }]
          }
        ]
      }
    } as unknown as FormDefinition;
  }

  it("accepts server scopes on a form component's five rules only, reporting runScope everywhere else and running the rule on both sides", () => {
    const definition = scoped();
    const before = snapshot(definition);
    const compiled = kernelCompileDefinition(definition.root, definition.journey, definition.pdf, stubParser, signatures);
    expect(snapshot(definition)).toBe(before);
    expect(compiled.problems.map((problem) => [problem.where, problem.code, problem.params])).toEqual([
      ["rules:bo:defaultValue", "runScope", { key: "defaultValue", run: "server-secret" }],
      ["journey:j:node:own:visibleWhen", "runScope", { key: "visibleWhen", run: "server-secret" }],
      ["journey:j:node:worked", "runScope", { key: "value", run: "server" }],
      ["journey:j:page:p:route:0", "runScope", { key: "when", run: "server" }],
      ["pdf:l", "runScope", { key: "when", run: "server-secret" }],
      ["pdf:l:field:0", "runScope", { key: "expression", run: "server" }],
      ["pdf:l:area:0", "runScope", { key: "expression", run: "server-secret" }]
    ]);
    const ok = compiled.definition.root.children!.default![0]!;
    expect(ok.rules).toEqual({ visibleWhen: { expression: emailPath, run: "server" }, value: { expression: emailPath, run: "server-secret" } });
    const bo = compiled.definition.root.children!.default![1]!;
    expect(bo.rules).toEqual({ defaultValue: { expression: emailPath, run: "both" } });
    const page = (compiled.definition.journey as { journeys: Array<{ pages: Array<Record<string, unknown>> }> }).journeys[0]!.pages[0]!;
    const entries = page.components as Array<Record<string, unknown>>;
    expect(entries[0]!.rules).toEqual({ visibleWhen: { expression: emailPath, run: "both" }, requiredWhen: { expression: emailPath, run: "browser" } });
    expect(entries[1]!.configuration).toEqual({ to: "email", value: emailPath });
    expect((page.routes as Array<Record<string, unknown>>)[0]).toEqual({ to: "p", when: emailPath });
    const layout = (compiled.definition.pdf as { layouts: Array<Record<string, unknown>> }).layouts[0]!;
    expect(layout.when).toEqual(emailPath);
    expect((layout.fields as Array<{ source: unknown }>)[0]!.source).toEqual({ kind: "expression", expression: emailPath });
    expect((layout.areas as Array<{ source: unknown }>)[0]!.source).toEqual({ kind: "expression", expression: emailPath });
  });

  it("keeps a when, a worked-out value or a source that is of no shape as written, reported as invalidRule", () => {
    const journey = {
      journeys: [{ id: "j", pages: [{ id: "p", components: [{ id: "w", type: "journey-value", configuration: { to: "email", value: 5 } }], routes: [{ to: "p", when: {} }] }] }]
    };
    const pdf = { layouts: [{ id: "l", kind: "generated", when: [emailPath], fields: [{ name: "a", source: { kind: "expression", expression: 1 } }] }] };
    const compiled = kernelCompileDefinition(field("email"), journey, pdf, stubParser, signatures);
    expect(compiled.problems.map((problem) => [problem.where, problem.code, problem.params])).toEqual([
      ["journey:j:node:w", "invalidRule", { key: "value", got: "number" }],
      ["journey:j:page:p:route:0", "invalidRule", { key: "when", got: "object" }],
      ["pdf:l", "invalidRule", { key: "when", got: "array" }],
      ["pdf:l:field:0", "invalidRule", { key: "expression", got: "number" }]
    ]);
    const page = (compiled.definition.journey as { journeys: Array<{ pages: Array<Record<string, unknown>> }> }).journeys[0]!.pages[0]!;
    expect((page.components as Array<Record<string, unknown>>)[0]!.configuration).toEqual({ to: "email", value: 5 });
    expect((page.routes as Array<Record<string, unknown>>)[0]).toEqual({ to: "p", when: {} });
    const layout = (compiled.definition.pdf as { layouts: Array<Record<string, unknown>> }).layouts[0]!;
    expect(layout.when).toEqual([emailPath]);
    expect((layout.fields as Array<{ source: unknown }>)[0]!.source).toEqual({ kind: "expression", expression: 1 });
  });

  it("a cleared when (null) and a blank formula are dropped from the copy without a problem", () => {
    const journey = { journeys: [{ id: "j", pages: [{ id: "p", components: [], routes: [{ to: "p", when: "  " }] }] }] };
    const compiled = kernelCompileDefinition(field("email"), journey, { layouts: [{ id: "l", kind: "generated", when: null }] }, stubParser, signatures);
    expect(compiled.problems).toEqual([]);
    const page = (compiled.definition.journey as { journeys: Array<{ pages: Array<Record<string, unknown>> }> }).journeys[0]!.pages[0]!;
    expect("when" in page).toBe(false);
    expect((page.routes as Array<Record<string, unknown>>)[0]).toEqual({ to: "p" });
    expect("when" in (compiled.definition.pdf as { layouts: Array<Record<string, unknown>> }).layouts[0]!).toBe(false);
  });

  it("the strip honours exactly what the compile honours: a browser-only key or a journey or PDF site is never secret", () => {
    const definition = scoped();
    const served = publicDefinition(definition);
    const ok = served.root.children!.default![0]!;
    expect(ok.rules).toEqual({ visibleWhen: { formula: "email", run: "server" } });
    const bo = served.root.children!.default![1]!;
    expect(bo.rules).toEqual({ defaultValue: { formula: "email", run: "server-secret" } });
    // A journey or PDF site may not take a server scope, but a value marked secret there is still not
    // served (SEC-06): the own node's `visibleWhen` and the layout `when` and
    // area source are gone; what is not marked secret stays as written.
    const journeyText = JSON.stringify(served.journey);
    const pdfText = JSON.stringify(served.pdf);
    expect(journeyText + pdfText).not.toContain("server-secret");
    const page = (served.journey as unknown as { journeys: Array<{ pages: Array<Record<string, unknown>> }> }).journeys[0]!.pages[0]!;
    expect("when" in page).toBe(false);
    expect((page.components as Array<Record<string, unknown>>)[0]!.rules).toEqual({ requiredWhen: { formula: "email", run: "browser" } });
    expect(page.routes).toEqual([{ to: "p", when: { formula: "email", run: "server" } }]);
    const layout = (served.pdf as unknown as { layouts: Array<Record<string, unknown>> }).layouts[0]!;
    expect("when" in layout).toBe(false);
    expect((layout.fields as Array<{ source: unknown }>)[0]!.source).toEqual({ kind: "expression", expression: { formula: "email", run: "server" } });
    expect((layout.areas as Array<{ source: unknown }>)[0]!.source).toEqual({ kind: "expression" });
    expect(kernelHoldsSecretSource(definition.journey)).toBe(true);
    expect(kernelHoldsSecretSource(served.journey)).toBe(false);
    expect(kernelHoldsSecretSource(served.pdf)).toBe(false);
    expect(kernelIsSecretRule("visibleWhen", { formula: "x", run: "server-secret" })).toBe(true);
    expect(kernelIsSecretRule("value", { expression: emailPath, run: "server-secret" })).toBe(true);
    expect(kernelIsSecretRule("defaultValue", { formula: "x", run: "server-secret" })).toBe(false);
    expect(kernelIsSecretRule("filter", { formula: "x", run: "server-secret" })).toBe(false);
    expect(kernelIsSecretRule("navigationGating", { formula: "x", run: "server-secret" })).toBe(false);
    expect(kernelIsSecretRule("note", { formula: "x", run: "server-secret" })).toBe(false);
    expect(kernelIsSecretRule("visibleWhen", { run: "server-secret" })).toBe(false);
    expect(kernelIsSecretRule("visibleWhen", { formula: "x", run: "server" })).toBe(false);
  });

  it("the strip copies a 3,000-deep tree and keeps non-rule keys under rules as written", () => {
    let deep: ComponentNode = field("bottom", { rules: { value: { formula: "a", run: "server-secret" }, note: "kept" } as unknown as ComponentRules });
    for (let level = 0; level < 3000; level += 1) {
      deep = { id: `layer_${level}`, type: "fieldset", configuration: {}, children: { content: [deep] } };
    }
    const stripped = kernelStripSecretRules(deep);
    let node: ComponentNode | undefined = stripped;
    while (node !== undefined && node.id !== "bottom") {
      node = node.children?.content?.[0];
    }
    expect(node?.rules).toEqual({ note: "kept" });
  });
});

describe("with the real parser", () => {
  it("kernelParseFormula fits the FormulaParser argument and compiles string rules to trees", () => {
    const parse: FormulaParser = kernelParseFormula;
    const problems: FormulaProblem[] = [];
    const compiled = kernelCompileRules(
      { visibleWhen: "age >= 18", value: { formula: "upper(name)", run: "server" }, requiredWhen: "upper(" },
      "rules:f",
      true,
      parse,
      formulaFunctionSignatures(),
      problems
    );
    expect(Object.keys(compiled).sort()).toEqual(["value", "visibleWhen"]);
    expect(compiled.visibleWhen).toEqual({ kind: "binary", operator: "gte", left: { kind: "path", path: "age" }, right: { kind: "literal", value: 18 } });
    expect(compiled.value).toEqual({ expression: { kind: "call", name: "upper", args: [{ kind: "path", path: "name" }] }, run: "server" });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.where).toBe("rules:f:requiredWhen");
    expect(problems[0]?.text).toBe("upper(");
    expect(typeof problems[0]?.start).toBe("number");
    expect(typeof problems[0]?.end).toBe("number");
    expect(typeof problems[0]?.message).toBe("string");
  });
});

describe("kernelFormulaPolicy", () => {
  // The default is fail; a value that is neither word is no word.
  it("takes the host's word, else the form's, else fail", () => {
    expect(kernelFormulaPolicy({ formulaErrors: "warn" }, "ignore")).toBe("warn");
    expect(kernelFormulaPolicy({ formulaErrors: "fail" }, "warn")).toBe("warn");
    expect(kernelFormulaPolicy({ formulaErrors: "ignore" }, undefined)).toBe("fail");
    expect(kernelFormulaPolicy({ formulaErrors: "fail" }, undefined)).toBe("fail");
    expect(kernelFormulaPolicy({ formulaErrors: "warn" }, "loud")).toBe("warn");
    expect(kernelFormulaPolicy({ formulaErrors: "warn" }, null)).toBe("warn");
    expect(kernelFormulaPolicy({ formulaErrors: "shout" }, undefined)).toBe("fail");
    expect(kernelFormulaPolicy({}, undefined)).toBe("fail");
    expect(kernelFormulaPolicy(undefined, undefined)).toBe("fail");
    expect(kernelFormulaPolicy("warn", undefined)).toBe("fail");
    expect(kernelFormulaPolicy(undefined, "fail")).toBe("fail");
  });
});

describe("kernelStripSecretRules and publicDefinition", () => {
  const secretRoot = (): ComponentNode =>
    ({
      id: "root",
      type: "form",
      configuration: {},
      rules: { visibleWhen: { formula: "secret", run: "server-secret" } },
      children: {
        default: [
          field("score", {
            rules: {
              value: { formula: "a + b", run: "server-secret" },
              visibleWhen: { formula: "email", run: "server" },
              requiredWhen: { formula: "email", run: "browser" },
              enabledWhen: "email",
              readonlyWhen: emailPath
            } as unknown as ComponentRules
          }),
          { id: "box", type: "fieldset", configuration: { legend: "Box" }, children: { default: [field("plain")] } }
        ]
      }
    }) as unknown as ComponentNode;

  it("removes only the secret rules and keeps every other run entry", () => {
    const root = secretRoot();
    const before = snapshot(root);
    const stripped = kernelStripSecretRules(root);
    expect(snapshot(root)).toBe(before);
    expect(stripped).not.toBe(root);
    expect(stripped.rules).toEqual({});
    const score = stripped.children!.default![0]!;
    expect(score.rules).toEqual({
      visibleWhen: { formula: "email", run: "server" },
      requiredWhen: { formula: "email", run: "browser" },
      enabledWhen: "email",
      readonlyWhen: emailPath
    });
    expect(score.configuration).toBe(root.children!.default![0]!.configuration);
    const box = stripped.children!.default![1]!;
    expect(box).toEqual(root.children!.default![1]!);
    expect(box).not.toBe(root.children!.default![1]!);
    expect(box.children!.default![0]!.rules).toBeUndefined();
  });

  it("publicDefinition strips the root and leaves a journey and pdf with no secret value as written", () => {
    const definition = {
      id: "f",
      version: "1",
      schemaVersion: "1",
      root: secretRoot(),
      journey: { journeys: [] },
      pdf: { layouts: [] }
    } as unknown as FormDefinition;
    const before = snapshot(definition);
    const served = publicDefinition(definition);
    expect(snapshot(definition)).toBe(before);
    expect(served).not.toBe(definition);
    expect(served.root.rules).toEqual({});
    expect(served.journey).toEqual(definition.journey);
    expect(served.pdf).toEqual(definition.pdf);
    expect(snapshot(served)).not.toContain("server-secret");
  });
});

describe("a secret value where no server scope is allowed is not served (SEC-06)", () => {
  const secret = { formula: "income > 1000 and ZZMARK(t)", run: "server-secret" };
  function formWith(extra: Record<string, unknown>, root: Record<string, unknown> = {}): FormDefinition {
    return {
      id: "f",
      version: "1",
      schemaVersion: "1",
      root: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "t", type: "text", configuration: {} }] }, ...root },
      ...extra
    } as unknown as FormDefinition;
  }
  const served = (definition: FormDefinition): string => JSON.stringify(publicDefinition(definition));

  it.each([
    ["a journey page when", formWith({ journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["t"], when: secret }] }] } })],
    ["a journey route when", formWith({ journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["t"], routes: [{ to: "$end", when: secret }] }] }] } })],
    ["a journey-value value", formWith({ journey: { journeys: [{ id: "j", pages: [{ id: "p", components: [{ id: "v", type: "journey-value", configuration: { to: "t", value: secret } }] }] }] } })],
    ["an own node rule", formWith({ journey: { journeys: [{ id: "j", pages: [{ id: "p", components: [{ id: "o", type: "text", configuration: {}, rules: { visibleWhen: secret } }] }] }] } })],
    ["a PDF layout when", formWith({ pdf: { layouts: [{ id: "l", kind: "generated", when: secret }] } })],
    ["a PDF field expression", formWith({ pdf: { layouts: [{ id: "l", kind: "template", fields: [{ pdfField: "a", source: { kind: "expression", expression: secret } }] }] } })],
    ["a children slot that is not a list", formWith({}, { children: { content: [], weird: { id: "w", type: "text", configuration: {}, rules: { requiredWhen: secret } } } })],
    ["a children slot nested in a slot that is not a list", formWith({}, { children: { weird: { id: "w", type: "container", children: { more: { id: "x", type: "text", rules: { visibleWhen: secret } } } } } })]
  ])("%s", (_name, definition) => {
    const before = snapshot(definition);
    expect(served(definition)).not.toContain("ZZMARK");
    expect(served(definition)).not.toContain("server-secret");
    expect(snapshot(definition)).toBe(before);
  });

  it("keeps a stripped page when as null, so the browser's copy is refused as the author's is on the server", () => {
    const journey = {
      journeys: [
        {
          id: "j",
          pages: [
            { id: "p", components: ["t"], routes: [{ to: "q" }] },
            { id: "q", components: ["t"], when: secret }
          ]
        }
      ]
    };
    const definition = formWith({ journey });
    const author = journey.journeys[0]!;
    expect(validateJourneyShape(author)).not.toEqual([]);
    expect(kernelIsJourney(author)).toBe(false);
    expect(readJourneys(definition)).toEqual([]);
    for (const copy of [publicDefinition(definition), kernelPublicDefinition(definition)]) {
      const served = (copy.journey as unknown as { journeys: Array<{ pages: Array<Record<string, unknown>> }> }).journeys[0]!;
      expect(served.pages[1]).toEqual({ id: "q", components: ["t"], when: null });
      expect(validateJourneyShape(served)).toEqual(validateJourneyShape(author));
      expect(kernelIsJourney(served)).toBe(false);
      expect(readJourneys(copy)).toEqual([]);
      expect(JSON.stringify(copy)).not.toContain("ZZMARK");
    }
    // Nothing else gains a placeholder: a page with no when, a stripped route when, a page that is not a record.
    const plain = kernelStripSecretJourney({ journeys: [{ id: "j", pages: [{ id: "p", routes: [{ to: "$end", when: secret }] }, 3] }, "x"] });
    expect(plain).toEqual({ journeys: [{ id: "j", pages: [{ id: "p", routes: [{ to: "$end" }] }, 3] }, "x"] });
    expect(kernelStripSecretJourney("x")).toBe("x");
  });

  it("keeps an own __proto__ key as a key and leaves the prototype alone", () => {
    const definition = JSON.parse(
      '{"id":"f","version":"1","schemaVersion":"1","root":{"id":"form","type":"form","configuration":{},"children":{"content":[],"__proto__":{"id":"w","type":"text"}}},"journey":{"journeys":[{"id":"j","pages":[{"id":"p","__proto__":{"keep":1}}]}]}}'
    ) as FormDefinition;
    const copy = publicDefinition(definition);
    expect(Object.keys(copy.root.children as object)).toEqual(["content", "__proto__"]);
    expect(Object.getPrototypeOf(copy.root.children)).toBe(Object.prototype);
    const page = (copy.journey as unknown as { journeys: Array<{ pages: object[] }> }).journeys[0]!.pages[0]!;
    expect(Object.keys(page)).toEqual(["id", "__proto__"]);
    expect(({} as { keep?: number }).keep).toBeUndefined();
  });
});

describe("COMPILE_FUNCTIONS", () => {
  it("lists every kernel function once, each a named top-level declaration free of a clock", () => {
    const names = COMPILE_FUNCTIONS.map((fn) => fn.name);
    expect(new Set(names).size).toBe(names.length);
    for (const fn of COMPILE_FUNCTIONS) {
      expect(fn.name.startsWith("kernel"), fn.name).toBe(true);
      const source = fn.toString();
      expect(source.startsWith("function "), fn.name).toBe(true);
      expect(/\bDate\b|\bIntl\b|Math\.random/.test(source), fn.name).toBe(false);
    }
    expect(names).toContain("kernelRuleExpression");
    expect(names).toContain("kernelRuleRun");
    expect(names).toContain("kernelRuleRunsOn");
    expect(names).toContain("kernelCompileRules");
    expect(names).toContain("kernelCompileDefinition");
    expect(names).toContain("kernelStripSecretRules");
    expect(names).toContain("kernelFormulaPolicy");
    expect(names).toContain("kernelCopyTree");
    expect(names).toContain("kernelCompileSite");
    expect(names).toContain("kernelIsSecretRule");
  });
});

describe("plugin function names in trees", () => {
  it("a call may name a plugin function without a cast, and the shape checks accept it when told the name", () => {
    const call: Expression = { kind: "call", name: "postcodeRegion", args: [{ kind: "path", path: "code" }] };
    expect(isEvaluableExpression(call)).toBe(false);
    expect(isEvaluableExpression(call, ["postcodeRegion"])).toBe(true);
    expect(isEvaluableExpression(call, new Set(["postcodeRegion"]))).toBe(true);
    expect(isEvaluableExpression({ kind: "call", name: "len", args: [call] }, ["postcodeRegion"])).toBe(true);
    expect(isEvaluableExpression({ kind: "call", name: "len", args: [call] }, ["other"])).toBe(false);
    expect(isEvaluableExpression({ kind: "call", name: "len", args: [{ kind: "path", path: "x" }] })).toBe(true);
    expect(isExpression(call)).toBe(false);
    expect(isExpression(call, ["postcodeRegion"])).toBe(true);
    expect(isExpression({ kind: "if", cases: [{ when: call, then: call }], else: call }, new Set(["postcodeRegion"]))).toBe(true);
    expect(isExpression({ kind: "if", cases: [{ when: call, then: call }], else: call })).toBe(false);
  });
});

describe("kernelCompileDefinition: parse refusals reported like arity", () => {
  it.each([
    ['dateAdd(@"2026-01-31", 1, "day")', "badUnit"],
    ['dateDiff(a, b, "Years")', "badUnit"],
    ["x < 1e999", "numberTooLarge"],
    ["x in [1...2]", "intervalDots"]
  ])("%s is a %s problem at its site", (formula, code) => {
    const root = { id: "form", type: "form", configuration: {}, children: { default: [{ id: "f", type: "text", configuration: {}, rules: { visibleWhen: formula } }] } } as unknown as ComponentNode;
    const compiled = kernelCompileDefinition(root, undefined, undefined, kernelParseFormula, formulaFunctionSignatures());
    expect(compiled.problems).toMatchObject([{ where: "rules:f:visibleWhen", code, text: formula }]);
    expect(compiled.problems[0]?.start).toBeTypeOf("number");
  });

  it("accepts a real unit, and a unit that is not a literal", () => {
    const root = {
      id: "form",
      type: "form",
      configuration: {},
      children: { default: [{ id: "f", type: "text", configuration: {}, rules: { visibleWhen: 'dateDiff(a, b, "years") > 1 and dateAdd(a, 1, unit) != null' } }] }
    } as unknown as ComponentNode;
    expect(kernelCompileDefinition(root, undefined, undefined, kernelParseFormula, formulaFunctionSignatures()).problems).toEqual([]);
  });
});

// A condition holds only for true, so a condition that
// provably comes to something else is warned about (condition.notBoolean), never refused.
describe("kernelConditionKind and the condition.notBoolean warning", () => {
  const kindOf = (formula: string): string => {
    const parsed = kernelParseFormula(formula, formulaFunctionSignatures());
    if (!parsed.ok || parsed.expression === undefined) {
      throw new Error(`does not parse: ${formula}`);
    }
    return kernelConditionKind(parsed.expression);
  };

  it("keeps kernelCallResultKind in step with the function table's return kinds", () => {
    for (const row of FORMULA_FUNCTION_TABLE) {
      const expected = row.returns === "boolean" ? "boolean" : row.returns === "any" ? "unknown" : "other";
      expect(kernelCallResultKind(row.name), row.name).toBe(expected);
    }
    expect(kernelCallResultKind("somePluginFunction")).toBe("unknown");
  });

  it.each([
    ["a > 1", "boolean"],
    ["a = 1 and b != 2", "boolean"],
    ["not(a)", "boolean"],
    ["a between 1 and 5", "boolean"],
    ['a in ("x", "y")', "boolean"],
    ["a in [1..5]", "boolean"],
    ["true", "boolean"],
    ["false", "boolean"],
    ["empty(a)", "boolean"],
    ['contains(a, "x")', "boolean"],
    ["age(dob) >= 18", "boolean"],
    ["if a then true else false", "boolean"],
    ["if a then b > 1", "boolean"],
    ["if a then b > 1 else if c then d > 2 else true", "boolean"],
    ["isDate(a)", "boolean"],
    // Not provable from the tree: a bare field may be a yes-or-no checkbox; coalesce, first and last return any.
    ["consent", "unknown"],
    ["row.agreed", "unknown"],
    ["coalesce(a, true)", "unknown"],
    ["first(items)", "unknown"],
    ["if a then consent else true", "unknown"],
    ["somePlugin(a)", "unknown"]
  ])("reads %s as %s", (formula, kind) => {
    // A plugin function name needs a signature to parse.
    const parsed = kernelParseFormula(formula, [...formulaFunctionSignatures(), { name: "somePlugin", min: 0, max: 5 }]);
    expect(parsed.ok, formula).toBe(true);
    expect(kernelConditionKind(parsed.ok ? parsed.expression : undefined), formula).toBe(kind);
  });

  it.each([
    "1",
    '"yes"',
    "null",
    "a + 1",
    "a * 2 - 1",
    "len(a)",
    "upper(a)",
    "sum(items)",
    "today()",
    "age(dob)",
    "split(a, \",\")",
    "selected(group)",
    "if a then 1 else 2",
    "if a then true else 1",
    "if a then b > 1 else \"x\""
  ])("reads %s as other", (formula) => {
    expect(kindOf(formula), formula).toBe("other");
  });

  it("walks a 20,000-rung if chain and a 20,000-term chain without recursing", () => {
    let tree: Expression = { kind: "literal", value: true };
    for (let i = 0; i < 20000; i += 1) {
      tree = { kind: "if", cases: [{ when: { kind: "path", path: "a" }, then: tree }] } as Expression;
    }
    expect(kernelConditionKind(tree)).toBe("boolean");
    let chain: Expression = { kind: "path", path: "a0" };
    for (let i = 1; i < 20000; i += 1) {
      chain = { kind: "arithmetic", operator: "add", left: chain, right: { kind: "path", path: `a${i}` } } as Expression;
    }
    expect(kernelConditionKind(chain)).toBe("other");
  });

  const ruleSite = (id: string, rules: Record<string, unknown>): ComponentNode => ({ id, type: "text", configuration: {}, rules } as unknown as ComponentNode);

  it("warns, in document order, for every condition site that comes to something else, and leaves problems alone", () => {
    const root = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        default: [
          ruleSite("a", { visibleWhen: "len(name)", requiredWhen: "name = \"x\"", enabledWhen: { formula: "1 + 1", run: "both" }, readonlyWhen: "consent", value: "len(name)" }),
          { id: "g", type: "container", configuration: {}, children: { default: [ruleSite("b", { navigationGating: '"yes"' })] } },
          ruleSite("c", { visibleWhen: { kind: "literal", value: 5 } })
        ]
      }
    } as unknown as ComponentNode;
    const journey = {
      journeys: [
        {
          id: "j",
          pages: [
            { id: "p1", components: [], routes: [{ to: "p2", when: "name + 1" }, { to: "p3", when: "empty(name)" }, { to: "p3", when: "name" }] },
            { id: "p2", components: [{ id: "own", type: "journey-value", configuration: {}, rules: { visibleWhen: "sum(items)" } }], routes: [{ to: "$end", when: "upper(name)" }] }
          ]
        }
      ]
    };
    const pdf = { layouts: [{ id: "l1", when: "2" }, { id: "l2", when: "name = \"x\"" }] };
    const compiled = kernelCompileDefinition(root, journey, pdf, kernelParseFormula, formulaFunctionSignatures());
    expect(compiled.problems).toEqual([]);
    expect((compiled.warnings ?? []).map((w) => `${w.where} ${w.code} ${w.severity} ${JSON.stringify(w.params)}`)).toEqual([
      'rules:a:visibleWhen condition.notBoolean warning {"key":"visibleWhen"}',
      'rules:a:enabledWhen condition.notBoolean warning {"key":"enabledWhen"}',
      'rules:b:navigationGating condition.notBoolean warning {"key":"navigationGating"}',
      'rules:c:visibleWhen condition.notBoolean warning {"key":"visibleWhen"}',
      // Page p1's first route is arithmetic; its third, `when: "name"`, is a bare field (unknown, no warning).
      'journey:j:page:p1:route:0 condition.notBoolean warning {"key":"when"}',
      // Page p2's own node reads sum(items), and its route `when: upper(name)` is a text.
      'journey:j:node:own:visibleWhen condition.notBoolean warning {"key":"visibleWhen"}',
      'journey:j:page:p2:route:0 condition.notBoolean warning {"key":"when"}',
      'pdf:l1 condition.notBoolean warning {"key":"when"}'
    ]);
    expect(kernelConditionWarnings(compiled.definition.root, compiled.definition.journey, compiled.definition.pdf)).toEqual(compiled.warnings);
    expect(COMPILE_FUNCTIONS).toContain(kernelConditionWarnings);
    expect(COMPILE_FUNCTIONS).toContain(kernelConditionKind);
  });

  it("is quiet for a boolean or unprovable condition, a value rule, and a formula that did not parse", () => {
    const root = {
      id: "form",
      type: "form",
      configuration: {},
      children: { default: [ruleSite("a", { visibleWhen: "name = \"x\"", requiredWhen: "consent", enabledWhen: "coalesce(a, true)", value: "len(name)", defaultValue: "1" }), ruleSite("b", { visibleWhen: "len(" })] }
    } as unknown as ComponentNode;
    const compiled = kernelCompileDefinition(root, undefined, undefined, kernelParseFormula, formulaFunctionSignatures());
    expect(compiled.warnings).toEqual([]);
    expect(compiled.problems).toHaveLength(1);
  });
});

// A pattern with a catastrophic shape is refused at compile, and a host can allow it.
describe("kernelRegexRisky", () => {
  it.each([
    "(a+)+",
    "(a*)*",
    "(a+)*",
    "(\\w+\\s?)+",
    "((ab)+)+",
    "(?:x+)+$",
    "(a+){2,}",
    "(\\s*\\w+)*",
    "^(?:[a-z0-9]+[._-]?)+@",
    "(a)\\1+",
    "(a)\\1{2,}",
    "(?<n>a)\\k<n>*",
    "(x|y+)+"
  ])("flags %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(true);
  });

  // The check reads a parsed pattern, so wrapping a branch in a
  // group changes nothing; branches that can take the same text are risky, nullable branches too.
  it.each([
    "^((a)|(a?))+$",
    "^(?:a|(?:a?))+$",
    "^(a|a)+$",
    "^(a|aa)+$",
    "^(\\d|\\d\\d)+$",
    "^(a|a?)+$",
    "^(a|b|)+$",
    "^(a?|b)*$",
    "^(a?b?)*$",
    "^((a|a))+$",
    "^(?:x(a|a)y)+$",
    "^(?:(?:a|b)|(?:b|c))+$",
    "^(?:a|[ab])*$",
    "(a|)*",
    "(.*a){16}",
    "(.*a){3}",
    "(.*a)+$",
    "^(?:(?:a+)+)$"
  ])("flags the bypass shape %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(true);
  });

  // Linear patterns the count rule must not flag.
  it.each([
    "^([a-z0-9-]+\\.){1,10}[a-z]{2,}$",
    "^([A-Za-z]+ ){0,9}[A-Za-z]+$",
    "^(\\w+ ){0,9}\\w+$",
    "^(\\d+,){8}\\d+$",
    "^(\\d+[,;] ?){0,20}\\d+$",
    "^([A-Z][a-z]+ ?){1,10}$",
    "^(?:[a-z0-9]+(?:\\.[a-z0-9]+)*)@[a-z]+$",
    "^(?:\\.[a-z]+)*$",
    "^((a|b)?)+$",
    "^(ab|ac)+$",
    "^(foo|bar|baz)+$",
    "^(a|ab)+$",
    "(.*a){2}",
    "^(?=.*[A-Z])(?=.*\\d)(?=.*[^\\w\\s]).{8,}$",
    "^\\p{L}+(?: \\p{L}+){0,3}$"
  ])("does not flag the linear pattern %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(false);
  });

  it("reads classes, escapes and lookarounds the way a pattern writes them", () => {
    // [a-c] and [b-d] share b and c; [a-c] and [d-f] do not; \D and \d never do; \w and \s never do.
    expect(kernelRegexRisky("^(?:[a-c]|[b-d])+$")).toBe(true);
    expect(kernelRegexRisky("^(?:[a-c]|[d-f])+$")).toBe(false);
    expect(kernelRegexRisky("^(?:\\D|\\d)+$")).toBe(false);
    expect(kernelRegexRisky("^(?:\\w|\\s)+$")).toBe(false);
    expect(kernelRegexRisky("^(?:[^a]|b)+$")).toBe(true);
    expect(kernelRegexRisky("^(?:[^ab]|b)+$")).toBe(false);
    expect(kernelRegexRisky("^(?:\\u0061|a)+$")).toBe(true);
    expect(kernelRegexRisky("^(?:\\x61|b)+$")).toBe(false);
    // The inside of a lookahead is read for its own repeats and never as a branch of the loop.
    expect(kernelRegexRisky("^(?=(a+)+$)b")).toBe(true);
    expect(kernelRegexRisky("^(?:(?=a)b|c)+$")).toBe(false);
  });

  it("gives up on a source too big to read in 3,000 steps, and on groups nested past 32", () => {
    const wide = "^(?:" + Array.from({ length: 800 }, (_, n) => "w" + n + "x").join("|") + ")+$";
    expect(kernelRegexRisky(wide)).toBe(true);
    const few = "^(?:" + Array.from({ length: 40 }, (_, n) => "w" + n + "x").join("|") + ")+$";
    expect(kernelRegexRisky(few)).toBe(false);
    expect(kernelRegexRisky("(".repeat(32) + "a" + ")".repeat(32))).toBe(false);
    expect(kernelRegexRisky("(".repeat(33) + "a" + ")".repeat(33))).toBe(true);
  });

  it.each([
    "[A-Z]\\d[A-Z] ?\\d[A-Z]\\d",
    "(\\d+\\.)+",
    "^(\\d{3}-)*\\d{4}$",
    "(a+)?",
    "(a+){2}",
    "(ab)+",
    "a+b+",
    "(a|b)+",
    "\\(a+\\)+",
    "[(a+)+]",
    "(a)\\1?",
    "(a+)(b)?",
    "",
    "((",
    "(a+"
  ])("passes %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(false);
  });

  it("never throws, on the pathological and on junk, and is linear on a long source", () => {
    expect(kernelRegexRisky("\\")).toBe(false);
    expect(kernelRegexRisky("[")).toBe(false);
    expect(kernelRegexRisky("{")).toBe(false);
    expect(kernelRegexRisky("a{1,")).toBe(false);
    expect(kernelRegexRisky(undefined as unknown as string)).toBe(false);
    const deep = "(".repeat(20_000) + "a+" + ")".repeat(20_000) + "+";
    const started = Date.now();
    expect(kernelRegexRisky(deep)).toBe(true);
    // Past the 2,000 character cap a pattern is not read at all; under it a long one is linear.
    expect(kernelRegexRisky("a+".repeat(50_000))).toBe(true);
    expect(kernelRegexRisky("ab".repeat(1000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // An unclosed `\u{41` left the parse cursor at 0 for ever.
  it("reads an unclosed \\u{ escape as it is, and never loops", () => {
    const started = Date.now();
    for (const pattern of ["\\u{41", "[\\u{41]", "\\u{", "a\\u{41", "(\\u{41)+", "\\u{}", "\\u{4g}"]) {
      expect(kernelRegexRisky(pattern)).toBe(false);
      expect(kernelRegexEscape(pattern, pattern.indexOf("\\"), false)?.next ?? 99).toBeGreaterThan(pattern.indexOf("\\"));
    }
    expect(kernelRegexRisky("\\u{41}+")).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // The parse advances on every source (fuzz of tokens that could hang the reader, bounded).
  it("answers every random source made of pattern tokens", () => {
    const tokens = ["\\u{41", "\\u{", "\\u0041", "[", "]", "[^", "(", ")", "(?:", "(?i:", "(?<n>", "(?=", "?", "+", "*", "{", "}", "{2,3}", "{1,", "\\p{L}", "\\p{", "\\k<n>", "\\k<", "|", "a", "b", "\\d", "\\w", ",", "1", "\\", "^", "$", ".", "-", "\\1"];
    let state = 12345;
    const next = (): number => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const started = Date.now();
    for (let n = 0; n < 12_000; n += 1) {
      let source = "";
      const size = 1 + Math.floor(next() * 12);
      for (let t = 0; t < size; t += 1) {
        source += tokens[Math.floor(next() * tokens.length)] as string;
      }
      expect(typeof kernelRegexRisky(source)).toBe("boolean");
    }
    expect(Date.now() - started).toBeLessThan(8000);
  });

  // Regexp modifiers parse as groups; a source the reader cannot follow is risky when the engine reads it.
  it.each([
    "^(?i:(a+)+)$",
    "^(a+)+(?i:b)?$",
    "^(?-i:(a+)+)$",
    "^(?is-m:(\\w+\\s?)+)$",
    "^(?i:a)(?<n>(a+)+)$"
  ])("flags %s, which the parser alone could not read as a pattern", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(true);
  });

  it.each(["^(?i:abc)$", "^(?-i:[a-z]+)$", "^(?i:a|b)+$", "^(?s:.)$", "^(?i:[a-z]+)-(?i:\\d+)$"])("does not flag the linear pattern %s with modifier groups", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(false);
  });

  // Repeats with a bound that varies, and chains of overlapping unbounded repeats.
  it.each([
    "^(a{1,2})+$",
    "^(a{1,3})+$",
    "^(a{1,9})+$",
    "^(\\w{1,3})+$",
    "^(\\d{1,3})+$",
    "^([ab]{1,2})*$",
    "^(a{0,2})+$",
    "^(\\w{1,10}\\s?)+$",
    "^(\\d{1,3}\\.?)+$",
    "^(\\d{1,3},?)*$",
    "^([ab]a?)+\\s{0,5}$",
    "^(?:\\w{1,9})*$",
    "^a*a*a*a*a*a*a*b$",
    "^a*a*a*b$",
    "^.*a.*a.*a.*a.*a.*a$",
    "^.*a.*a.*a$",
    "^\\s*\\s*\\s*\\s*\\s*x$",
    "^\\d+\\d+\\d+\\d+\\d+x",
    "^[a-z]+[a-z]+[a-z]+[a-z]+!"
  ])("flags the variable-count or chained repeat %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(true);
  });

  it.each([
    "^a*a*b$",
    "^.+@.+\\.com$",
    "^[^,]*,[^,]*,[^,]*,[^,]*$",
    "^\\d+(\\.\\d+)?\\s*[a-z]*$",
    "^(\\d{3}-){1,2}\\d{4}$",
    "^(\\d{3}\\.?){1,3}$",
    "^([A-Z][a-z]{1,9} ?){1,10}$",
    "^(?:\\d{1,3}\\.){3}\\d{1,3}$",
    "^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$",
    "^\\+?\\d{1,3}[\\s-]?\\(?\\d{3}\\)?[\\s-]?\\d{3}[\\s-]?\\d{4}$"
  ])("does not flag the linear pattern %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(false);
  });

  // The `{` scan is linear, and a pattern past 2,000 characters is not read.
  it("is linear on a source of braces and refuses one past the cap", () => {
    const started = Date.now();
    expect(kernelRegexRisky("{".repeat(1999))).toBe(false);
    expect(kernelRegexRisky("{".repeat(2001))).toBe(true);
    expect(kernelRegexRisky("{".repeat(200_000))).toBe(true);
    expect(kernelRegexQuantifier("{".repeat(200_000), 0)).toBeNull();
    expect(kernelRegexQuantifier("{1,2}" + "{".repeat(100_000), 0)).toEqual({ min: 1, max: 2, next: 5 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(kernelRegexPatternMax()).toBe(2000);
  });

  // Unicode property escapes are sets, so name patterns are not "anything".
  it.each([
    "^\\p{L}+(?:[ '-]\\p{L}+)*$",
    "^\\p{L}+(?:[ \\-']\\p{L}+)*$",
    "^(?:\\p{Lu}\\p{Ll}+ ?)+$",
    "^\\p{Lu}\\p{Ll}+(?: \\p{Lu}\\p{Ll}+)*$",
    "^(?:\\p{N}+[,.])+\\p{N}+$",
    "^(?:[\\p{L}\\p{N}]+[\\p{P}\\p{Z}])*$",
    "^(?:\\p{Nd}+\\p{P})*\\p{Nd}$"
  ])("does not flag the property pattern %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(false);
  });

  it.each(["^(\\p{L}+)+$", "^(?:\\p{L}+\\p{Lu}?)+$", "^(?:[\\p{L}\\p{N}]+\\p{Nd}?)+$", "^(\\P{L}+)+$", "^(\\p{Script=Latin}+)+$", "^(?:\\p{L}+[ ]?)+$"])("still flags the overlapping property pattern %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(true);
  });

  it("is a kernel function in the splice list", () => {
    expect(COMPILE_FUNCTIONS).toContain(kernelRegexRisky);
    expect(COMPILE_FUNCTIONS).toContain(kernelRiskyMatchesIn);
    expect(COMPILE_FUNCTIONS).toContain(kernelRiskGuardParser);
  });
});

describe("kernelCompileDefinition: the riskyPatterns policy", () => {
  const formRoot = (visibleWhen: string): ComponentNode =>
    ({ id: "form", type: "form", configuration: {}, children: { default: [{ id: "f", type: "text", configuration: {}, rules: { visibleWhen } }] } }) as unknown as ComponentNode;
  const compile = (formula: string, policy?: unknown) =>
    kernelCompileDefinition(formRoot(formula), undefined, undefined, kernelParseFormula, formulaFunctionSignatures(), policy);

  it("refuses a literal risky matches pattern by default, at the word matches, naming the pattern", () => {
    const formula = 'name != "" and matches(name, "(a+)+$")';
    const compiled = compile(formula);
    expect(compiled.problems).toMatchObject([
      { where: "rules:f:visibleWhen", code: "pattern.risky", params: { pattern: "(a+)+$" }, start: formula.indexOf("matches"), end: formula.indexOf("matches") + 7, text: formula }
    ]);
    expect(compiled.problems[0]?.message).toContain("(a+)+$");
    // The rule is dropped, as one that does not parse is.
    expect((compiled.definition.root.children?.default?.[0] as ComponentNode).rules).toEqual({});
  });

  it("finds it nested in calls, ifs and logic, and 'refuse' reads as the default", () => {
    expect(compile('if matches(a, "(x*)*") then true else false', "refuse").problems).toHaveLength(1);
    expect(compile('not (b = 1 or upper(a) = "x" or sum(1, if c then matches(a, "(.+)+") else false) > 0)').problems).toHaveLength(1);
    expect(compile('matches(a, "(x+)+")', "anything else").problems).toHaveLength(1);
  });

  it("lets a host allow it, and leaves safe and non-literal patterns alone", () => {
    const formula = 'matches(name, "(a+)+$")';
    const allowed = compile(formula, "allow");
    expect(allowed.problems).toEqual([]);
    expect((allowed.definition.root.children?.default?.[0] as ComponentNode).rules?.visibleWhen).toMatchObject({ kind: "call", name: "matches" });
    expect(compile('matches(name, "[A-Z]\\d+")').problems).toEqual([]);
    expect(compile("matches(name, pattern)").problems).toEqual([]);
    expect(compile('contains(name, "(a+)+")').problems).toEqual([]);
  });

  it("applies to journeys and PDF layouts, and leaves a tree-written rule alone", () => {
    const journey = { journeys: [{ id: "j", pages: [{ id: "p", components: [], routes: [{ to: "$end", when: 'matches(a, "(a+)+")' }] }] }] };
    const pdf = { layouts: [{ id: "l", when: 'matches(a, "(a*)*")' }] };
    const compiled = kernelCompileDefinition(formRoot("true"), journey, pdf, kernelParseFormula, formulaFunctionSignatures());
    expect(compiled.problems.map((problem) => `${problem.where} ${problem.code}`)).toEqual(["journey:j:page:p:route:0 pattern.risky", "pdf:l pattern.risky"]);
    // A tree-written layout rule is looked at too, in a PDF; the other sites leave a tree alone.
    const tree = { kind: "call", name: "matches", args: [{ kind: "path", path: "a" }, { kind: "literal", value: "(a+)+" }] } as Expression;
    const treed = kernelCompileDefinition(formRoot("true"), undefined, { layouts: [{ id: "l", when: tree }] }, kernelParseFormula, formulaFunctionSignatures());
    expect(treed.problems.map((problem) => `${problem.where} ${problem.code}`)).toEqual(["pdf:l pattern.risky"]);
    expect((treed.definition.pdf as { layouts: { when?: unknown }[] }).layouts[0]?.when).toBeUndefined();
    expect(kernelCompileDefinition(formRoot("true"), undefined, { layouts: [{ id: "l", when: tree }] }, kernelParseFormula, formulaFunctionSignatures(), "allow").problems).toEqual([]);
  });
});

// Gaps in the regex reader: code points, short group repeats, the cubic email shape, the time budget.
describe("kernelRegexRisky: code points, short group repeats, the cubic email shape, the step budget", () => {
  // A quantifier binds to the whole astral character, however it is written.
  it.each(["^(😀+)+$", "^(😀*)*$", "^(\\ud83d\\ude00+)+$", "^(😀|\\u{1F600})+$", "^(?:[😀-😅]+)+$", "^(\\u{1F600}+)+$"])("flags the astral shape %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(true);
  });

  it.each(["^😀+$", "^(😀|😁)+$", "^[😀-😅]+$", "^(?:😀 ?)+$", "^\\ud83d\\ude00+$", "^(😀\\d)+$"])("does not flag the linear astral pattern %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(false);
  });

  // A group repeated 3 to 7 times is a polynomial of that degree when it holds an unbounded repeat.
  it.each(["^(a+){7}$", "^(a+){2,7}$", "^(.*a){7}$", "^(\\d+\\d?){1,7}$", "^(a*){5}b", "^(\\w+\\s?){1,7}$", "^(?:a+){3}$"])("flags the short group repeat %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(true);
  });

  it.each(["^(\\d{1,3}\\.){3}\\d{1,3}$", "^([a-z]{1,8}-){2,5}[a-z]+$", "^(\\d{3}-?){3}$", "^(a|b){3,7}$", "^(a|a){3}$", "^([A-Z][a-z]*){1,4}$", "^(\\d+,){2,5}\\d+$", "(a+){2}"])("does not flag the bounded or delimited group repeat %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(false);
  });

  // Three unbounded repeats where the last meets only the end are cubic on text that fails there.
  it.each(["^\\S+@\\S+\\.\\S+$", ".+@.+\\..+", "^.*a.*a.*$", "^\\w+\\s?\\w+\\s?\\w+$"])("flags the chain whose last repeat meets the end %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(true);
  });

  it.each(["^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", "\\s*[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\s*", ".+@.+\\.com", "^[a-z]+@\\d+\\.[a-z]+$", "^\\S+@[a-z]+\\.[a-z]+$"])("does not flag the stricter email %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(false);
  });

  // The analysis is bounded in time, not only in steps. A 150-way alternation of disjoint
  // classes (1,300 characters) used 22,000 steps and the whole 250 ms interrupt in QuickJS.
  it("reads a source in at most 3,000 steps: a small alternation passes, a 150-way one is risky", () => {
    expect(kernelRegexStepsMax()).toBe(3000);
    const alternation = (count: number): string => "^(" + Array.from({ length: count }, (_, i) => "[" + String.fromCharCode(0x4e00 + i * 3) + "-" + String.fromCharCode(0x4e00 + i * 3 + 1) + "]").join("|") + ")+$";
    expect(kernelRegexRisky(alternation(40))).toBe(false);
    expect(kernelRegexRisky(alternation(150))).toBe(true);
    // Property sets weigh more than a pair of characters: a few passes, a stack of them runs out.
    expect(kernelRegexRisky("^\\p{L}+(?: \\p{L}+)*$")).toBe(false);
    const heavy = "^(?:" + Array.from({ length: 8 }, (_, k) => "[" + Array.from({ length: 40 }, (_, i) => String.fromCharCode(0x4e00 + k * 1000 + i * 3) + "-" + String.fromCharCode(0x4e00 + k * 1000 + i * 3 + 1)).join("") + "]").join("|") + ")+$";
    expect(heavy.length).toBeLessThan(2000);
    expect(kernelRegexRisky(heavy)).toBe(true);
  });
});

/**
 * A data grid's bound formulas: `rules.minRows` / `rules.maxRows` compile as
 * the kernel-applied rules do, may take a server scope, and one that reads `row.` is warned
 * about as `rule.unsupportedScope` (it is never evaluated).
 */
describe("a data grid's bound formulas in the compile", () => {
  const parse: FormulaParser = kernelParseFormula;
  const grid = (rules: Record<string, unknown>): ComponentNode =>
    ({
      id: "lines",
      type: "dataGrid",
      configuration: {},
      collection: { collectionPath: "lines" },
      rules,
      children: { content: [{ id: "qty", type: "number", configuration: {} }] }
    }) as unknown as ComponentNode;
  const formOf = (...children: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: children } });

  it("compiles minRows and maxRows to trees, server scopes allowed, as the kernel-applied keys", () => {
    expect(kernelIsServerRuleKey("minRows")).toBe(true);
    expect(kernelIsServerRuleKey("maxRows")).toBe(true);
    expect(kernelIsRuleKey("minRows")).toBe(true);
    const compiled = kernelCompileDefinition(
      formOf({ id: "people", type: "number", configuration: {} }, grid({ minRows: "people", maxRows: { formula: "people + 2", run: "server" } })),
      undefined,
      undefined,
      parse,
      formulaFunctionSignatures()
    );
    expect(compiled.problems).toEqual([]);
    expect(compiled.warnings ?? []).toEqual([]);
    const rules = (compiled.definition.root.children?.content?.[1] as ComponentNode).rules as Record<string, unknown>;
    expect(rules.minRows).toEqual({ kind: "path", path: "people" });
    expect(rules.maxRows).toMatchObject({ run: "server", expression: { kind: "arithmetic" } });
  });

  it("reports a bound that does not parse at rules:<id>:<key>, a problem the server runs", () => {
    const root = formOf(grid({ minRows: "3 +" }));
    const compiled = kernelCompileDefinition(root, undefined, undefined, parse, formulaFunctionSignatures());
    expect(compiled.problems.map((problem) => problem.where)).toEqual(["rules:lines:minRows"]);
    expect(kernelProblemRunsOnServer({ nodeById: { lines: root.children?.content?.[0] as ComponentNode } }, "rules:lines:minRows")).toBe(true);
  });

  it("warns rule.unsupportedScope for a bound that reads row., wherever it reads it", () => {
    const compiled = kernelCompileDefinition(
      formOf(grid({ minRows: "if row.qty > 2 then 3 else 1", maxRows: "count(lines)" })),
      undefined,
      undefined,
      parse,
      formulaFunctionSignatures()
    );
    expect(compiled.problems).toEqual([]);
    expect((compiled.warnings ?? []).map((w) => `${w.where} ${w.code} ${w.severity} ${JSON.stringify(w.params)}`)).toEqual([
      'rules:lines:minRows rule.unsupportedScope warning {"key":"minRows"}'
    ]);
    expect(kernelConditionWarnings(compiled.definition.root, undefined, undefined)).toEqual(compiled.warnings);
  });

  it("reads row. through every branch and argument, never inside a literal", () => {
    const row: Expression = { kind: "path", path: "row.qty" };
    expect(kernelTreeReadsRow(row)).toBe(true);
    expect(kernelTreeReadsRow({ kind: "path", path: "row" })).toBe(true);
    expect(kernelTreeReadsRow({ kind: "path", path: "rows.qty" })).toBe(false);
    expect(kernelTreeReadsRow({ kind: "call", name: "max", args: [{ kind: "literal", value: 1 }, row] })).toBe(true);
    expect(kernelTreeReadsRow({ kind: "if", cases: [{ when: { kind: "literal", value: true }, then: { kind: "literal", value: 1 } }], else: row })).toBe(true);
    expect(kernelTreeReadsRow({ kind: "literal", value: { kind: "path", path: "row.qty" } })).toBe(false);
    expect(kernelTreeReadsRow(undefined)).toBe(false);
    expect(COMPILE_FUNCTIONS).toContain(kernelTreeReadsRow);
  });

  it("strips a server-secret bound from the public copy", () => {
    const root = formOf(grid({ minRows: { formula: "3", run: "server-secret" }, maxRows: "9" }));
    const rules = (kernelStripSecretRules(root).children?.content?.[0] as ComponentNode).rules as Record<string, unknown>;
    expect(rules).toEqual({ maxRows: "9" });
  });

  // rowIndex(), rowCount() and ancestor. have a value only inside a row, as row. does.
  it("reads rowIndex(), rowCount() and an ancestor. path as row reads, through every branch, never inside a literal", () => {
    const one: Expression = { kind: "literal", value: 1 };
    for (const tree of [
      { kind: "call", name: "rowIndex", args: [] },
      { kind: "call", name: "rowCount", args: [] },
      { kind: "path", path: "ancestor.qty" },
      { kind: "path", path: "ancestor" },
      { kind: "arithmetic", operator: "add", left: one, right: { kind: "call", name: "rowCount", args: [] } },
      { kind: "if", cases: [{ when: { kind: "path", path: "ancestor.kind" }, then: one }], else: one },
      { kind: "call", name: "max", args: [one, { kind: "call", name: "rowIndex", args: [] }] }
    ] as Expression[]) {
      expect(kernelTreeReadsRow(tree), JSON.stringify(tree)).toBe(true);
    }
    for (const tree of [
      { kind: "path", path: "ancestors.qty" },
      { kind: "path", path: "rowCount" },
      { kind: "call", name: "count", args: [{ kind: "path", path: "lines" }] },
      { kind: "literal", value: { kind: "call", name: "rowIndex", args: [] } }
    ] as unknown as Expression[]) {
      expect(kernelTreeReadsRow(tree), JSON.stringify(tree)).toBe(false);
    }
  });

  it("warns rule.unsupportedScope for a bound that reads rowIndex(), rowCount() or ancestor.", () => {
    const compiled = kernelCompileDefinition(
      formOf(grid({ minRows: "rowIndex() + 1", maxRows: "if ancestor.qty > 2 then rowCount() else 4" })),
      undefined,
      undefined,
      parse,
      formulaFunctionSignatures()
    );
    expect(compiled.problems).toEqual([]);
    expect((compiled.warnings ?? []).map((w) => `${w.where} ${w.code} ${JSON.stringify(w.params)}`)).toEqual([
      'rules:lines:minRows rule.unsupportedScope {"key":"minRows"}',
      'rules:lines:maxRows rule.unsupportedScope {"key":"maxRows"}'
    ]);
    expect(compiled.warnings?.[0]?.message).toBe(
      "A minRows formula belongs to the whole data grid and cannot read row., ancestor., rowIndex() or rowCount(); it is not evaluated, so the fixed bound stands"
    );
  });
});
