import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import {
  INSPECT_FUNCTIONS,
  kernelExprInventory,
  kernelInspectAbi,
  kernelInspectAbiAccepts,
  kernelInspectDefinition,
  kernelInspectParse,
  kernelPublicDefinition,
  kernelRulesInventory,
  type DefinitionInspectResponse
} from "../form-engine/core/expressions/inspect.js";
import { publicDefinition } from "../form-engine/core/expressions/compile.js";
import { kernelStructureLimits } from "../form-engine/core/expressions/definition-structure.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { FORMULA_FUNCTION_NAMES, formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { WASM_ABI_VERSION, stableStringify } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { PORTABLE_KERNEL_FUNCTIONS, kernelRunInspect, runInspect } from "../form-engine/validation/wasm/portable-kernel.js";

/**
 * The introspection entry point (`__datum_inspect`): what a host that cannot run the
 * engine asks of a definition before it serves or stores it. Three ops over one request shape,
 * each pure and deterministic; kernel-shaped so the sandbox and the in-process adapter answer
 * the same bytes.
 */

const signatures = formulaFunctionSignatures();
const builtins = [...FORMULA_FUNCTION_NAMES];
const parse = kernelParseFormula;

function node(id: string, type: string, rules?: ComponentNode["rules"], configuration: Record<string, unknown> = {}): ComponentNode {
  return rules === undefined ? { id, type, configuration } : { id, type, configuration, rules };
}

/** A form with a secret rule, a server calculation on `host.`, a browser-only key with a bad scope, a typo, and a nested rule. */
function definition(configuration: Record<string, unknown> = {}): FormDefinition {
  return {
    id: "apply",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration,
      children: {
        content: [
          node("employed", "checkbox"),
          node("income", "number"),
          node("dob", "date"),
          node("reason", "text", {
            requiredWhen: { formula: "employed = true and income > 1000", run: "server-secret" },
            visibleWhen: "not(empty(employed))"
          }),
          node("tax", "number", { value: { formula: "roundTo(regionTax(income, host.region), 2)", run: "server" } }),
          node("note", "text", { visibleWhen: "age(dob) >= 18", defaultValue: { formula: 'upper("x")', run: "server" } }),
          node("bad", "text", { value: "roundTo(income, 2" }),
          {
            id: "box",
            type: "container",
            configuration: {},
            children: { content: [node("inner", "text", { enabledWhen: "income between 1 and 10 or rowIndex() = 0" })] }
          }
        ]
      }
    },
    journey: {
      journeys: [
        {
          id: "j",
          pages: [
            {
              id: "p1",
              components: [
                "employed",
                { id: "own", type: "journey-value", configuration: { value: "sum(income, 1)" }, rules: { visibleWhen: "len(reason) > 0" } }
              ],
              routes: [{ to: "p2", when: 'contains(reason, "x")' }, { to: "p2", when: 'today() >= @"2027-01-01"' }]
            },
            { id: "p2", components: ["reason"] }
          ]
        }
      ]
    } as unknown as NonNullable<FormDefinition["journey"]>,
    pdf: {
      layouts: [
        {
          id: "L",
          kind: "template",
          template: { storage: "base64", data: "AA==" },
          when: "isNumber(income)",
          fields: [{ target: "f1", source: { kind: "expression", expression: "text(income)" } }],
          areas: [{ id: "a1", source: { kind: "expression", expression: "join(selected(employed), \",\")" } }]
        }
      ]
    } as unknown as NonNullable<FormDefinition["pdf"]>
  };
}

function request(op: string, extra: Record<string, unknown> = {}, form: FormDefinition = definition()): Record<string, unknown> {
  return { abi: WASM_ABI_VERSION, op, definition: form, ...extra };
}

describe("inspect: the ABI gate", () => {
  it("names the sandbox ABI the host module names", () => {
    expect(kernelInspectAbi()).toBe(WASM_ABI_VERSION);
  });

  it("accepts the program's own major up to its own version, refuses a newer one, another major and a malformed version", () => {
    expect(kernelInspectAbiAccepts("1.2.0", "1.2.0")).toBe(true);
    expect(kernelInspectAbiAccepts("1.0.0", "1.2.0")).toBe(true);
    expect(kernelInspectAbiAccepts("1.2.9", "1.2.0")).toBe(true);
    expect(kernelInspectAbiAccepts("1.3.0", "1.2.0")).toBe(false);
    expect(kernelInspectAbiAccepts("2.0.0", "1.2.0")).toBe(false);
    expect(kernelInspectAbiAccepts("0.9.0", "1.2.0")).toBe(false);
    expect(kernelInspectAbiAccepts("1.2", "1.2.0")).toBe(false);
    expect(kernelInspectAbiAccepts(undefined, "1.2.0")).toBe(false);
    expect(kernelInspectAbiAccepts(1.2, "1.2.0")).toBe(false);
  });

  it("answers abi_mismatch before reading anything else", () => {
    const missing = kernelInspectDefinition({ op: "public", definition: definition() }, parse, signatures, builtins);
    expect(missing).toEqual({ ok: false, error: { code: "abi_mismatch", message: expect.stringContaining("no ABI") } });
    const newer = kernelInspectDefinition({ abi: "1.2.0", op: "nope" }, parse, signatures, builtins);
    expect(newer).toMatchObject({ ok: false, error: { code: "abi_mismatch", message: expect.stringContaining("1.2.0") } });
  });
});

describe("inspect: the request shape", () => {
  it("refuses a request that is not an object, an unknown op, and a definition without a root", () => {
    expect(kernelInspectDefinition("public", parse, signatures, builtins)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(kernelInspectDefinition([], parse, signatures, builtins)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(kernelInspectDefinition(request("nope"), parse, signatures, builtins)).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: expect.stringContaining('"nope"') }
    });
    expect(kernelInspectDefinition({ abi: WASM_ABI_VERSION }, parse, signatures, builtins)).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: expect.stringContaining("op") }
    });
    expect(kernelInspectDefinition({ abi: WASM_ABI_VERSION, op: "public" }, parse, signatures, builtins)).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: expect.stringContaining("root") }
    });
    expect(kernelInspectDefinition({ abi: WASM_ABI_VERSION, op: "public", definition: { root: "form" } }, parse, signatures, builtins)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" }
    });
  });

  it("never throws out of runInspect: a definition that throws on read, and signatures of no shape", () => {
    const hostile = {
      abi: WASM_ABI_VERSION,
      op: "public",
      definition: {
        get root(): unknown {
          throw new Error("no root for you");
        }
      }
    };
    expect(runInspect(hostile, signatures, builtins)).toEqual({
      ok: false,
      error: { code: "invalid_request", message: expect.stringContaining("no root for you") }
    });
    expect(runInspect(request("check"), "nope" as unknown as undefined, builtins)).toMatchObject({ ok: true, op: "check" });
    expect(runInspect(null)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });
});

describe("inspect: public", () => {
  it("serves no tests: the author's scenarios never reach a browser", () => {
    const form = {
      ...definition(),
      tests: { scenarios: [{ id: "s1", source: 'test "a"\n  given host.role = "admin"' }] }
    } as unknown as FormDefinition;
    const answer = kernelInspectDefinition(request("public", {}, form), parse, signatures, builtins);
    expect(answer.ok).toBe(true);
    if (!answer.ok || answer.op !== "public") {
      throw new Error("not a public answer");
    }
    expect("tests" in answer.definition).toBe(false);
    expect("tests" in kernelPublicDefinition(form)).toBe(false);
    expect(JSON.stringify(answer.definition)).not.toContain("given host.role");
    expect(stableStringify(answer.definition)).toBe(stableStringify(publicDefinition(form)));
    // The author's object keeps its tests.
    expect("tests" in form).toBe(true);
  });

  it("strips exactly what publicDefinition strips and leaves the author's object, journey and pdf alone", () => {
    const form = definition();
    const before = JSON.stringify(form);
    const answer = kernelInspectDefinition(request("public", {}, form), parse, signatures, builtins);
    expect(answer.ok).toBe(true);
    if (!answer.ok || answer.op !== "public") {
      throw new Error("not a public answer");
    }
    expect(stableStringify(answer.definition)).toBe(stableStringify(publicDefinition(form)));
    expect(stableStringify(kernelPublicDefinition(form))).toBe(stableStringify(publicDefinition(form)));
    const served = JSON.stringify(answer.definition);
    expect(served).not.toContain("server-secret");
    expect(served).not.toContain("income > 1000");
    // The field stays, its other rule stays, a server rule that is not secret stays.
    const content = answer.definition.root.children?.content ?? [];
    const reason = content.find((one) => one.id === "reason");
    expect(reason?.rules).toEqual({ visibleWhen: "not(empty(employed))" });
    const tax = content.find((one) => one.id === "tax");
    expect(tax?.rules).toEqual({ value: { formula: "roundTo(regionTax(income, host.region), 2)", run: "server" } });
    expect(answer.definition.journey).toEqual(form.journey);
    expect(answer.definition.pdf).toEqual(form.pdf);
    expect(JSON.stringify(form)).toBe(before);
  });
});

describe("inspect: check", () => {
  it("lists the compile's problems in document order with the policy and the verdict", () => {
    // The default policy is fail.
    const answer = kernelInspectDefinition(request("check"), parse, signatures, builtins);
    expect(answer).toMatchObject({ ok: true, op: "check", policy: "fail", verdict: "fail" });
    if (!answer.ok || answer.op !== "check") {
      throw new Error("not a check answer");
    }
    expect(answer.problems.map((problem) => `${problem.where}:${problem.code}`)).toEqual(["rules:tax:value:unknownFunction", "rules:note:defaultValue:runScope", "rules:bad:value:unclosedParen"]);
  });

  it("resolves the policy from the request over the form's own, and the verdict from it", () => {
    expect(kernelInspectDefinition(request("check", { formulaErrors: "fail" }), parse, signatures, builtins)).toMatchObject({ policy: "fail", verdict: "fail" });
    // A word that is neither is no word: the form's own, else the default.
    // (The form's `tax` rule runs on the server with a function nobody wired, which the kernel refuses under every word: the verdict says fail.)
    expect(kernelInspectDefinition(request("check", { formulaErrors: "ignore" as never }), parse, signatures, builtins)).toMatchObject({ policy: "fail", verdict: "fail" });
    expect(kernelInspectDefinition(request("check", {}, definition({ formulaErrors: "fail" })), parse, signatures, builtins)).toMatchObject({ policy: "fail", verdict: "fail" });
    expect(kernelInspectDefinition(request("check", { formulaErrors: "warn" }, definition({ formulaErrors: "fail" })), parse, signatures, builtins)).toMatchObject({
      policy: "warn",
      verdict: "fail"
    });
    // A word that is not a policy is ignored, as the kernel's run ignores it: the default applies.
    expect(kernelInspectDefinition(request("check", { formulaErrors: "Fail" as never }), parse, signatures, builtins)).toMatchObject({ policy: "fail", verdict: "fail" });
  });

  it("says fail under warn for an unknown function on a server-run rule, warn for one the browser alone runs", () => {
    const withTax = (rules: ComponentNode["rules"]): FormDefinition => {
      const form = definition();
      form.root.children = { content: [node("income", "number"), node("tax", "number", rules)] };
      return form;
    };
    const check = (rules: ComponentNode["rules"]) =>
      kernelInspectDefinition(request("check", { formulaErrors: "warn" }, withTax(rules)), parse, signatures, builtins);
    expect(check({ value: { formula: "regionTax(income)", run: "server" } })).toMatchObject({ policy: "warn", verdict: "fail" });
    expect(check({ value: "regionTax(income)" })).toMatchObject({ policy: "warn", verdict: "fail" });
    expect(check({ value: { formula: "regionTax(income)", run: "browser" } })).toMatchObject({ policy: "warn", verdict: "warn" });
    // A browser-only key is the browser's whatever its run says.
    expect(check({ defaultValue: { formula: "regionTax(income)", run: "server" } })).toMatchObject({ policy: "warn", verdict: "warn" });
  });

  it("is ok under every policy when nothing is wrong, and the parser knows the plugins the host wired", () => {
    const wired = [...signatures, { name: "regionTax", min: 0, max: Number.POSITIVE_INFINITY }];
    const clean = definition();
    const content = clean.root.children?.content ?? [];
    clean.root.children = {
      content: content.filter((one) => one.id !== "bad" && one.id !== "note")
    };
    const answer = kernelInspectDefinition(request("check", { formulaErrors: "fail" }, clean), parse, wired, builtins);
    expect(answer).toEqual({
      ok: true,
      op: "check",
      problems: [],
      warnings: [],
      policy: "fail",
      structure: [],
      structureWarnings: [],
      limits: kernelStructureLimits(),
      verdict: "ok"
    });
  });

  // The compile's condition.notBoolean warnings ride beside problems.
  it("returns the condition warnings beside the problems, never changing the verdict, with secret rules redacted", () => {
    const wired = [...signatures, { name: "regionTax", min: 0, max: Number.POSITIVE_INFINITY }];
    const form = definition();
    const content = form.root.children?.content ?? [];
    form.root.children = {
      content: [
        ...content.filter((one) => one.id !== "bad" && one.id !== "note"),
        node("count", "text", { visibleWhen: "income + 1" }),
        node("hidden", "text", { requiredWhen: { formula: "income + 2", run: "server-secret" } })
      ]
    };
    const answer = kernelInspectDefinition(request("check", { formulaErrors: "fail" }, form), parse, wired, builtins);
    expect(answer).toMatchObject({ ok: true, op: "check", problems: [], policy: "fail", verdict: "ok" });
    const warnings = (answer as Extract<DefinitionInspectResponse, { op: "check" }>).warnings;
    expect(warnings).toEqual([
      expect.objectContaining({ where: "rules:count:visibleWhen", code: "condition.notBoolean", severity: "warning" }),
      { where: "rules:hidden:requiredWhen", code: "condition.notBoolean", message: "The details of this problem are withheld." }
    ]);
  });
});

describe("inspect: check does not echo a server-secret rule", () => {
  const LIT = "ZZ_SECRET_LITERAL_9912";
  function secretForm(formula: string, run = "server-secret"): FormDefinition {
    return {
      id: "secret",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            node("gate", "text"),
            node("r", "text", { requiredWhen: { formula, run } as never }),
            node("open", "text", { visibleWhen: `gate = "${LIT}-open" and (` })
          ]
        }
      }
    };
  }
  const problemsOf = (form: FormDefinition) => {
    const answer = kernelInspectDefinition(request("check", {}, form), parse, signatures, builtins);
    if (!answer.ok || answer.op !== "check") {
      throw new Error("not a check answer");
    }
    return answer.problems;
  };

  it.each([
    ["a formula that does not parse", `gate = "${LIT}" and (`],
    ["an unknown function over the literal", `secretFn("${LIT}")`]
  ])("%s on a secret rule keeps where and code, and loses the text, the span, the parameters and the message", (_name, formula) => {
    const problems = problemsOf(secretForm(formula));
    const mine = problems.find((problem) => problem.where === "rules:r:requiredWhen");
    expect(mine).toBeDefined();
    expect(Object.keys(mine!).sort()).toEqual(["code", "message", "where"]);
    expect(JSON.stringify(problems.filter((problem) => problem.where.startsWith("rules:r:")))).not.toContain(LIT);
    expect(JSON.stringify(mine)).not.toContain("secretFn");
  });

  it("leaves a problem on a rule that is not secret exactly as it was (text, span and message stay)", () => {
    const problems = problemsOf(secretForm(`gate = "${LIT}" and (`));
    const open = problems.find((problem) => problem.where === "rules:open:visibleWhen");
    expect(open).toMatchObject({ text: expect.stringContaining(LIT) });
    expect(open!.message).not.toContain("withheld");
  });

  it("does not redact a rule that only names the secret scope on a key the compile does not honour it on", () => {
    const form = secretForm(`gate = "${LIT}" and (`, "both");
    expect(problemsOf(form).find((problem) => problem.where === "rules:r:requiredWhen")).toMatchObject({ text: expect.stringContaining(LIT) });
  });

  it("answers the same bytes through the sandbox entry point", () => {
    const answer = JSON.stringify(runInspect(request("check", {}, secretForm(`gate = "${LIT}" and (`)), signatures, builtins));
    expect(answer).not.toContain(`${LIT}"`);
    expect(answer).toContain("rules:r:requiredWhen");
  });
});

describe("inspect: the rules inventory", () => {
  it("lists every parseable component rule in document order with scope, reads, host, clock and functions", () => {
    const answer = kernelInspectDefinition(request("inspect"), parse, signatures, builtins);
    if (!answer.ok || answer.op !== "inspect") {
      throw new Error("not an inspect answer");
    }
    expect(answer.rules).toEqual([
      { componentId: "reason", key: "requiredWhen", run: "server-secret", reads: ["employed", "income"], readsHost: false, readsClock: false, functions: [] },
      { componentId: "reason", key: "visibleWhen", run: "both", reads: ["employed"], readsHost: false, readsClock: false, functions: ["empty"] },
      { componentId: "tax", key: "value", run: "server", reads: ["income"], readsHost: true, readsClock: false, functions: ["regionTax", "roundTo"] },
      { componentId: "note", key: "visibleWhen", run: "both", reads: ["dob"], readsHost: false, readsClock: true, functions: ["age"] },
      { componentId: "note", key: "defaultValue", run: "browser", reads: [], readsHost: false, readsClock: false, functions: ["upper"] },
      { componentId: "inner", key: "enabledWhen", run: "both", reads: ["income"], readsHost: false, readsClock: false, functions: ["rowIndex"] }
    ]);
    // `date` is the journey page's date literal (`@"2027-01-01"` parses to a `date()` call).
    expect(answer.functionsUsed).toEqual(["age", "contains", "date", "empty", "isNumber", "join", "len", "regionTax", "roundTo", "rowIndex", "selected", "sum", "text", "today", "upper"]);
    expect(answer.pluginsNeeded).toEqual(["regionTax"]);
  });

  it("lists a data grid's minRows and maxRows formulas as it lists a requiredWhen", () => {
    const form: FormDefinition = {
      id: "f",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "people", type: "number", configuration: {} },
            {
              id: "lines",
              type: "dataGrid",
              configuration: { minRows: 1 },
              collection: { collectionPath: "lines" },
              rules: { minRows: "people", maxRows: { formula: "max(people, 2) + host.extra", run: "server" } },
              children: { content: [{ id: "qty", type: "number", configuration: {} }] }
            } as unknown as ComponentNode
          ]
        }
      }
    };
    const inventory = kernelRulesInventory(form, parse, signatures, builtins);
    expect(inventory.rules).toEqual([
      { componentId: "lines", key: "minRows", run: "both", reads: ["people"], readsHost: false, readsClock: false, functions: [] },
      { componentId: "lines", key: "maxRows", run: "server", reads: ["people"], readsHost: true, readsClock: false, functions: ["max"] }
    ]);
  });

  it("keeps a plugin function in pluginsNeeded when the host wired it, since it is still no built-in", () => {
    const wired = [...signatures, { name: "regionTax", min: 0, max: Number.POSITIVE_INFINITY }];
    const withBuiltins = kernelRulesInventory(definition(), parse, wired, builtins);
    expect(withBuiltins.pluginsNeeded).toEqual(["regionTax"]);
    // Without the built-ins' names the signatures stand in, so a wired plugin reads as provided.
    const withoutBuiltins = kernelRulesInventory(definition(), parse, wired);
    expect(withoutBuiltins.pluginsNeeded).toEqual([]);
    expect(kernelRulesInventory(definition(), parse, signatures).pluginsNeeded).toEqual(["regionTax"]);
  });

  it("reads a formula calling an unknown function leniently, and a formula wrong otherwise not at all", () => {
    const lenient = kernelInspectParse("alpha(beta(1), gamma(2))", signatures, parse);
    expect(lenient.ok).toBe(true);
    if (lenient.ok) {
      expect(kernelExprInventory(lenient.expression).names).toEqual(["alpha", "beta", "gamma"]);
    }
    expect(kernelInspectParse("alpha(1", signatures, parse)).toMatchObject({ ok: false, code: "unclosedParen" });
    expect(kernelInspectParse("len(1, 2, 3)", signatures, parse)).toMatchObject({ ok: false, code: "arity" });
    // The strict parse the compile uses still refuses the unknown name.
    expect(parse("alpha(1)", signatures)).toMatchObject({ ok: false, code: "unknownFunction" });
  });

  it("inventories paths and names in reading order, every branch, repeats kept, as the evaluator's walkers read", () => {
    const expression: Expression = {
      kind: "if",
      cases: [
        {
          when: { kind: "logical", operator: "and", left: { kind: "path", path: "a" }, right: { kind: "call", name: "empty", args: [{ kind: "path", path: "host.b" }] } },
          then: { kind: "call", name: "today", args: [] }
        }
      ],
      else: { kind: "arithmetic", operator: "add", left: { kind: "path", path: "a" }, right: { kind: "unary", operator: "not", operand: { kind: "path", path: "row.c" } } }
    };
    expect(kernelExprInventory(expression)).toEqual({ paths: ["a", "host.b", "a", "row.c"], names: ["empty", "today"] });
    expect(kernelExprInventory(undefined)).toEqual({ paths: [], names: [] });
    expect(kernelExprInventory({ kind: "mystery" })).toEqual({ paths: [], names: [] });
  });

  it("lists form-scoped reads only, once each, and the scope prefixes set the flags", () => {
    const form = definition();
    form.root.children = {
      content: [
        node("x", "text", {
          visibleWhen: {
            kind: "logical",
            operator: "and",
            left: { kind: "binary", operator: "eq", left: { kind: "path", path: "a" }, right: { kind: "path", path: "a" } },
            right: {
              kind: "logical",
              operator: "or",
              left: { kind: "path", path: "row.b" },
              right: { kind: "logical", operator: "or", left: { kind: "path", path: "ancestor.c" }, right: { kind: "path", path: "component.value" } }
            }
          } as Expression
        })
      ]
    };
    const inventory = kernelRulesInventory(form, parse, signatures, builtins);
    expect(inventory.rules).toEqual([{ componentId: "x", key: "visibleWhen", run: "both", reads: ["a"], readsHost: false, readsClock: false, functions: [] }]);
  });

  it("skips a rule that is not a rule key, a rules block of no shape, and a node that is not a record", () => {
    const form = definition();
    form.root.children = {
      content: [
        { id: "x", type: "text", configuration: {}, rules: { note: "a host's own key", visibleWhen: "a = 1" } as unknown as NonNullable<ComponentNode["rules"]> },
        { id: "y", type: "text", configuration: {}, rules: [] as unknown as NonNullable<ComponentNode["rules"]> },
        7 as unknown as ComponentNode
      ]
    };
    const inventory = kernelRulesInventory(form, parse, signatures, builtins);
    expect(inventory.rules.map((rule) => `${rule.componentId}:${rule.key}`)).toEqual(["x:visibleWhen"]);
  });
});

describe("inspect: data sources and their free answers", () => {
  it("lists the source a choice names on its path, and says when its answers are free", () => {
    const form: FormDefinition = {
      id: "f",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "city", type: "select", configuration: { data: { sourceId: "cities" } } },
            { id: "town", type: "select", configuration: { data: { sourceId: "towns", answersFree: true } } },
            { id: "loose", type: "select", configuration: { data: { sourceId: "x", answersFree: "yes" } } },
            { id: "name", type: "text", configuration: {} }
          ]
        }
      }
    };
    const answer = runInspect(request("inspect", {}, form), signatures, builtins);
    expect(answer).toMatchObject({ ok: true, op: "inspect" });
    if (answer.ok && answer.op === "inspect") {
      const sources = Object.fromEntries(answer.paths.map((entry) => [entry.path, entry.source]));
      expect(sources).toEqual({
        city: { id: "cities", free: false },
        town: { id: "towns", free: true },
        loose: { id: "x", free: false },
        name: undefined
      });
    }
  });
});

describe("inspect: determinism and depth", () => {
  it("answers the same bytes twice and leaves the definition unchanged", () => {
    const form = definition();
    const before = JSON.stringify(form);
    const first = stableStringify(kernelInspectDefinition(request("inspect", {}, form), parse, signatures, builtins));
    const second = stableStringify(kernelInspectDefinition(request("inspect", {}, form), parse, signatures, builtins));
    expect(first).toBe(second);
    expect(JSON.stringify(form)).toBe(before);
    const checked = stableStringify(runInspect(request("check", {}, form), signatures, builtins));
    expect(stableStringify(runInspect(request("check", {}, form), signatures, builtins))).toBe(checked);
  });

  it("inspects a tree 3,000 deep and a chain of 5,000 terms without recursion", () => {
    let leaf: ComponentNode = node("leaf", "text", { visibleWhen: "a = 1" });
    for (let depth = 0; depth < 3000; depth += 1) {
      leaf = { id: `c${depth}`, type: "container", configuration: {}, children: { content: [leaf] } };
    }
    // A chain leans left as deep as it is long. Written as a formula it travels as text and the
    // parser's tree is read at any depth; written as JSON it would be the compile's `tooDeep`.
    const deep = Array.from({ length: 5000 }, () => "a").join(" and ");
    const form: FormDefinition = {
      id: "deep",
      version: "1",
      schemaVersion: "1",
      root: { id: "form", type: "form", configuration: {}, children: { content: [leaf, node("tall", "text", { enabledWhen: deep })] } }
    };
    // The request is refused at the entry, before any walk; the
    // inventory itself still walks without recursion.
    for (const op of ["public", "check", "inspect"] as const) {
      const answer: DefinitionInspectResponse = runInspect(request(op, {}, form), signatures, builtins);
      expect(answer, op).toMatchObject({ ok: false, error: { code: "definition.tooDeep" } });
    }
    const inventory = kernelRulesInventory(form, parse, signatures, builtins);
    expect(inventory.rules.map((rule) => rule.componentId)).toEqual(["leaf", "tall"]);
    expect(inventory.rules[1]?.reads).toEqual(["a"]);
  });
});

describe("inspect: kernel shape", () => {
  it("lists every function as a kernel-named declaration spliced into the portable kernel, with no clock, locale or randomness", () => {
    const forbidden = /\bDate\b|\bIntl\b|Math\.random/;
    expect(INSPECT_FUNCTIONS.length).toBeGreaterThanOrEqual(10);
    for (const fn of INSPECT_FUNCTIONS) {
      expect(fn.name.startsWith("kernel"), fn.name).toBe(true);
      expect(fn.toString().trimStart().startsWith("function "), fn.name).toBe(true);
      expect(fn.toString(), fn.name).not.toMatch(forbidden);
      expect(PORTABLE_KERNEL_FUNCTIONS, fn.name).toContain(fn);
    }
    expect(PORTABLE_KERNEL_FUNCTIONS).toContain(kernelRunInspect);
    expect(runInspect).toBe(kernelRunInspect);
    expect(kernelRunInspect.toString()).not.toMatch(forbidden);
    const names = PORTABLE_KERNEL_FUNCTIONS.map((fn) => fn.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("inspect: a secret value where no server scope is allowed", () => {
  const MARK = "ZZ_MISPLACED_4410";
  const secret = { formula: `t = "${MARK}"`, run: "server-secret" };
  const form = (extra: Record<string, unknown>, children: Record<string, unknown> = { content: [node("t", "text")] }): FormDefinition =>
    ({ id: "f", version: "1", schemaVersion: "1", root: { id: "form", type: "form", configuration: {}, children }, ...extra }) as unknown as FormDefinition;
  const locations: Array<[string, FormDefinition]> = [
    ["a journey page when", form({ journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["t"], when: secret }] }] } })],
    ["a journey route when", form({ journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["t"], routes: [{ to: "$end", when: secret }] }] }] } })],
    ["a PDF layout when", form({ pdf: { layouts: [{ id: "l", kind: "generated", when: secret }] } })],
    ["a children slot that is not a list", form({}, { content: [node("t", "text")], weird: { id: "w", type: "text", configuration: {}, rules: { requiredWhen: secret } } })]
  ];

  it.each(locations)("public does not serve %s", (_name, definition) => {
    const answer = kernelInspectDefinition(request("public", {}, definition), parse, signatures, builtins);
    expect(answer.ok).toBe(true);
    expect(JSON.stringify(answer)).not.toContain(MARK);
    expect(JSON.stringify(answer)).not.toContain("server-secret");
    expect(stableStringify(answer.ok && answer.op === "public" ? answer.definition : null)).toBe(stableStringify(publicDefinition(definition)));
  });

  it("check names where and which code for a misplaced secret, never its text", () => {
    const definition = form({ journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["t"], routes: [{ to: "$end", when: secret }] }] }] }, pdf: { layouts: [{ id: "l", kind: "generated", when: secret }] } });
    const answer = kernelInspectDefinition(request("check", {}, definition), parse, signatures, builtins);
    expect(answer).toMatchObject({ ok: true, op: "check" });
    expect(JSON.stringify(answer)).not.toContain(MARK);
    const problems = (answer as Extract<DefinitionInspectResponse, { op: "check" }>).problems;
    expect(problems.map((problem) => `${problem.where}:${problem.code}`)).toEqual(["journey:j:page:p:route:0:runScope", "pdf:l:runScope"]);
  });
});
