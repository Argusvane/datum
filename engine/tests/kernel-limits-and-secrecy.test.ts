import { describe, expect, it } from "vitest";

import { kernelStableStringify, runKernel, kernelRunInspect, type KernelValidator } from "../form-engine/validation/wasm/portable-kernel.js";
import { kernelSha256Hex, kernelUtf8Binary } from "../form-engine/validation/wasm/portable-kernel.js";
import { goldenCase } from "./golden-fixture.js";
import { WASM_ABI_VERSION } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { kernelCompileDefinition, kernelComponentTooDeep } from "../form-engine/core/expressions/compile.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { kernelCreateLog, kernelFinishLog } from "../form-engine/validation/wasm/portable-kernel.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

// Regression tests for kernel-side items that do not belong to one existing suite. The
// container-key bypass is in portable-options.test.ts, the list-cap helper in
// expression-evaluator.test.ts, the server-secret refusal beside the other tests in
// portable-kernel.test.ts.

const SECRET = "ZZSECRETZZ";
const signatures = [...formulaFunctionSignatures(), { name: "boom", min: 0, max: Number.POSITIVE_INFINITY }];
const node = (id: string, rules: Record<string, unknown> = {}, configuration: Record<string, unknown> = {}): ComponentNode =>
  ({ id, type: "text", configuration, rules }) as unknown as ComponentNode;
const form = (children: ComponentNode[], configuration: Record<string, unknown> = {}): ComponentNode =>
  ({ id: "form", type: "form", configuration, children: { content: children } }) as unknown as ComponentNode;
const run = (root: ComponentNode, values: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, validators: KernelValidator[] = [], functions?: Record<string, (args: unknown[]) => unknown>) =>
  runKernel({ formId: "f", values, locale: "en", form: root, ...extra } as never, validators, functions, signatures);

describe("a chain of lists that share structure is bounded", () => {
  it("settles at once, the link that crosses the cap giving no answer and one warning", () => {
    const links = Array.from({ length: 30 }, (_, k) => 29 - k).map((i) => node("l" + i, { value: i === 0 ? 'split("a,b", ",")' : `append(l${i - 1}, l${i - 1})` }));
    const outcome = run(form(links, { formulaErrors: "warn" }), {}, { logLevel: "warn" });
    expect(outcome.logs?.some((entry) => entry.message === "formula function: append: the result is over the 10000 item cap; no answer")).toBe(true);
  });
});

describe("a server-secret rule's text stays out of the outcome", () => {
  const secret = (formula: string) => ({ run: "server-secret", formula });
  const quiet = (outcome: unknown) => expect(JSON.stringify(outcome)).not.toContain(SECRET);

  it("withholds a risky pattern literal and an unknown function name, in errors and in logs", () => {
    for (const formula of [`matches(t, "^(a+)+$${SECRET}")`, `${SECRET}(t) = 1`]) {
      const outcome = run(form([node("t"), node("x", { requiredWhen: secret(formula) })], { formulaErrors: "fail" }), { t: "hello" }, { logLevel: "debug" });
      expect(outcome.errors.map((error) => error.code)).toContain("formula.invalid");
      quiet(outcome);
    }
  });

  it("withholds a plugin function's thrown message and its name", () => {
    const boom = (args: unknown[]): unknown => {
      throw new Error("msg " + String(args[0]));
    };
    for (const formulaErrors of ["fail", "warn"]) {
      const outcome = run(form([node("t"), node("x", { requiredWhen: secret(`boom("${SECRET}") = 1`) })], { formulaErrors }), { t: "hello" }, { logLevel: "debug" }, [], { boom });
      expect(JSON.stringify(outcome)).toContain("rules:x:requiredWhen");
      quiet(outcome);
    }
  });

  it("still names the problem on a rule that is not secret", () => {
    const outcome = run(form([node("t"), node("x", { requiredWhen: `${SECRET}(t) = 1` })], { formulaErrors: "fail" }), { t: "hello" });
    expect(JSON.stringify(outcome)).toContain(SECRET);
  });
});

describe("a pattern built at run time is held to the risky-pattern check", () => {
  const composed = form([node("t"), node("x", { requiredWhen: 'matches(t, concat("^(a+)", "+$"))' })], { formulaErrors: "fail" });

  it("refuses a composed catastrophic pattern at the call, without running it", () => {
    const started = Date.now();
    const outcome = run(composed, { t: "a".repeat(40) + "!" }, { logLevel: "warn" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.logs?.some((entry) => /matches: the pattern repeats a repeat/.test(entry.message))).toBe(true);
  });

  it("lets it through when the host allows risky patterns, and for a safe composed pattern", () => {
    const allowed = run(form([node("t"), node("x", { requiredWhen: 'matches(t, concat("^(a+)", "+$"))' })]), { t: "aaa" }, { riskyPatterns: "allow", logLevel: "warn" });
    expect(allowed.logs ?? []).toEqual([]);
    const safe = run(form([node("t"), node("x", { requiredWhen: 'matches(t, concat("^a", "+$"))' })]), { t: "aaa", x: "" }, { logLevel: "warn" });
    expect(safe.errors.map((error) => error.code)).toEqual(["required"]);
  });

  it("flags a repeated group with an optional branch, and a heavily repeated group with an inner repeat, in a field pattern", () => {
    for (const pattern of ["(a|a?)+", "(.*a){16}"]) {
      const outcome = run(form([node("t", {}, { pattern })]), { t: "a".repeat(30) + "!" }, { logLevel: "warn" });
      expect(outcome.errors.map((error) => error.code), pattern).toEqual(["pattern"]);
      expect(outcome.errors[0]?.parameters, pattern).toMatchObject({ risky: true });
    }
    for (const pattern of ["(a|b)+", "(\\d{3}-){2}\\d{4}", "[A-Z]\\d[A-Z] ?\\d[A-Z]\\d", "(.*a){2}"]) {
      expect(run(form([node("t", {}, { pattern })]), { t: "x" }).errors[0]?.parameters, pattern).not.toMatchObject({ risky: true });
    }
  });
});

describe("replace checks its result before building it", () => {
  it("trips the cap with the cap's warning for a long replacement, and still replaces within it", () => {
    const root = form([node("t"), node("x", { validWhen: 'len(replace(t, "a", padStart("", 10000, "x"))) > 0' }), node("y", { value: 'replace(t, "a", "bb")' })], { formulaErrors: "warn" });
    const outcome = run(root, { t: "a".repeat(10000) }, { logLevel: "warn" });
    expect(outcome.logs?.some((entry) => /replace: the text is over the 10,000 character cap/.test(entry.message))).toBe(true);
    expect(run(root, { t: "aXa" }).values).toMatchObject({ y: "bbXbb" });
  });
});

describe("a locale that is not a short text is read as absent", () => {
  // The pattern message's words per locale live in the definition's map, which crosses as `translations`.
  const root = form([node("a", {}, { pattern: "^x$", patternMessage: "D" })]);
  const translations = {
    en: { components: { a: { patternMessage: { text: "E", source: "1hkaexf" } } } },
    fr: { components: { a: { patternMessage: { text: "F", source: "1hkaexf" } } } }
  };

  it("does not throw for a number, an object or an over-long text, and says so", () => {
    for (const locale of [5, { split: 1 }, ["en"], "x".repeat(36)]) {
      const outcome = run(root, { a: "bad" }, { locale, logLevel: "warn", translations });
      expect(outcome.errors.map((error) => error.code), JSON.stringify(locale)).toEqual(["pattern"]);
      expect(outcome.logs?.some((entry) => /context\.locale is not a text of at most 35 characters/.test(entry.message))).toBe(true);
    }
  });

  it("keeps a real locale, a long tag included", () => {
    expect(run(root, { a: "bad" }, { locale: "fr-CA", translations }).errors[0]?.parameters).toMatchObject({ message: "F" });
    expect(run(root, { a: "bad" }, { locale: "en", translations }).errors[0]?.parameters).toMatchObject({ message: "E" });
    expect(run(root, { a: "bad" }, { locale: "x".repeat(35), translations }).errors.map((error) => error.code)).toEqual(["pattern"]);
    // An unreadable locale is read as absent: the default locale's words, "en" here.
    expect(run(root, { a: "bad" }, { locale: 5, translations }).errors[0]?.parameters).toMatchObject({ message: "E" });
  });
});

describe("a validator's answer is copied once and the copy judged", () => {
  it("refuses an errors getter that changes between reads", () => {
    let reads = 0;
    const getter: KernelValidator = () =>
      ({
        get errors() {
          reads += 1;
          return reads === 1 ? [] : [{ nocode: true, severity: "error" }];
        }
      }) as never;
    const outcome = run(form([node("a")]), { a: "x" }, {}, [getter]);
    // The first look (the list judged) is the list kept, whatever a later look would say.
    expect(outcome.errors).toEqual([]);
  });

  it("copies an entry whose code is a getter, so the code judged is the code kept", () => {
    let reads = 0;
    const entry = {
      get code() {
        reads += 1;
        return reads === 1 ? "first" : 7;
      }
    };
    const outcome = run(form([node("a")]), { a: "x" }, {}, [() => ({ errors: [entry] }) as never]);
    expect(outcome.errors.map((error) => error.code)).toEqual(["first"]);
  });
});

describe("each run-log entry is capped, not only their number", () => {
  it("cuts a long message with a marker and replaces large data with a note of its size", () => {
    const log = kernelCreateLog("debug");
    log.error("x".repeat(1 << 20));
    log.info("short", { big: "y".repeat(20000) });
    log.info("small", { fine: 1 });
    log.warn("😀".repeat(5000));
    const entries = kernelFinishLog(log);
    expect(entries[0]?.message.length).toBe(8192 + "... [truncated]".length);
    expect(entries[0]?.message.endsWith("... [truncated]")).toBe(true);
    expect(entries[1]).toEqual({ level: "info", message: "short", data: { truncated: true, size: 20010 } });
    expect(entries[2]).toEqual({ level: "info", message: "small", data: { fine: 1 } });
    const cut = entries[3]?.message ?? "";
    expect(cut.endsWith("... [truncated]")).toBe(true);
    expect(/[\ud800-\udbff]$/.test(cut.slice(0, -"... [truncated]".length))).toBe(false);
  });

  it("holds a plugin's megabyte log lines to the cap in a run", () => {
    const loud: KernelValidator = (context) => {
      for (let i = 0; i < 300; i += 1) {
        context.log.error("x".repeat(1 << 20));
      }
      return { errors: [] };
    };
    const outcome = run(form([node("a")]), { a: "x" }, {}, [loud]);
    expect(JSON.stringify(outcome).length).toBeLessThan(2 * 1024 * 1024);
  });
});

describe("a validWhen on a field inside a repeating section is warned about", () => {
  const section = {
    id: "items",
    type: "repeatingSection",
    configuration: {},
    collection: { itemFields: ["qty"] },
    children: { content: [{ id: "qty", type: "number", configuration: {}, rules: { validWhen: "component > 0" } }] }
  } as unknown as ComponentNode;
  const root = form([{ id: "top", type: "number", configuration: {}, rules: { validWhen: "component > 0" } } as unknown as ComponentNode, section]);

  it("warns once, for the field in the section only, and refuses nothing", () => {
    const compiled = kernelCompileDefinition(root, undefined, undefined, kernelParseFormula, signatures, undefined);
    expect((compiled.warnings ?? []).map((warning) => [warning.where, warning.code, warning.severity])).toEqual([["rules:qty:validWhen", "rule.unsupportedScope", "warning"]]);
    const outcome = run(root, { top: 1, "items[0].qty": -5 }, { logLevel: "warn" });
    expect(outcome.errors).toEqual([]);
    expect(outcome.logs?.some((entry) => entry.message.startsWith("formula warning: rules:qty:validWhen"))).toBe(true);
  });
});

describe("the kernel's dictionaries are records of their own", () => {
  it("leaves the outcome's bytes exactly as they were", () => {
    const text = kernelStableStringify(goldenCase());
    // Pinned from the run before kernelRecord() replaced Object.create(null).
    expect(text.length).toBe(6369);
    expect(kernelSha256Hex(kernelUtf8Binary(text))).toBe("87990e35f18cb7d1df5237b05f889581f4c12708d02488b90ef13cf9081feb6f");
  });
});

describe("a run with more than 65,535 errors", () => {
  // The list is cut at 10,000 with an errors.truncated entry; it still must not throw at the spread.
  it("returns the first 10,000 and a truncation marker instead of throwing at the spread", () => {
    const root = form([{ id: "rows", type: "group", configuration: {}, collection: {}, children: { content: [node("sku", {}, { required: true })] } } as unknown as ComponentNode]);
    const rows = Array.from({ length: 70000 }, () => ({ sku: "" }));
    const outcome = run(root, { rows });
    expect(outcome.errors).toHaveLength(10001);
    expect(outcome.errors[0]?.code).toBe("required");
    expect(outcome.errors[10000]?.code).toBe("errors.truncated");
  });
});

describe("components nested past 32 levels are refused, not walked", () => {
  const nest = (levels: number): ComponentNode => {
    let inner: ComponentNode = node("leaf", {}, { required: true });
    for (let level = levels - 1; level >= 1; level -= 1) {
      inner = { id: "g" + level, type: "group", configuration: {}, children: { content: [inner] } } as unknown as ComponentNode;
    }
    return { id: "form", type: "form", configuration: {}, children: { content: [inner] } } as unknown as ComponentNode;
  };

  it("counts the root as level 1: 32 levels run, 33 are refused", () => {
    // form (1), g1..g30 (2..31), leaf (32)
    expect(run(nest(31), {}).errors.map((error) => error.code)).toEqual(["required"]);
    const refused = run(nest(32), { leaf: "x" });
    expect(refused.errors).toEqual([{ code: "definition.tooDeep", stage: "definition", source: "wasm", parameters: { where: expect.stringMatching(/^root > content > g1 > content > g2/), limit: 32 } }]);
    expect(refused.values).toBeUndefined();
  });

  it("refuses 40 and 100 levels with the typed error, in a run and in inspect", () => {
    for (const levels of [40, 100]) {
      const outcome = run(nest(levels), {});
      expect(outcome.errors.map((error) => error.code), String(levels)).toEqual(["definition.tooDeep"]);
      for (const op of ["public", "check", "inspect"]) {
        const answer = kernelRunInspect({ abi: WASM_ABI_VERSION, op, definition: { id: "f", version: "1", schemaVersion: "1", root: nest(levels) } });
        expect(answer, op).toMatchObject({ ok: false, error: { code: "definition.tooDeep" } });
      }
    }
    expect(kernelRunInspect({ abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: nest(31) } })).toMatchObject({ ok: true });
  });

  // An unbound data grid is bound at its id before the depth is
  // measured; the run, `check`, `inspect` and `public` all measure that tree, and no depth of tree
  // overflows the normalizer.
  it("measures an unbound data grid's row where it sits, and refuses a tree of any depth with an unbound grid in it", () => {
    const gridAt = (level: number): ComponentNode => {
      let inner = {
        id: "lines",
        type: "dataGrid",
        configuration: {},
        children: { content: [{ id: "sku", type: "text", configuration: { required: true } }] }
      } as unknown as ComponentNode;
      for (let at = level - 1; at >= 2; at -= 1) {
        inner = { id: "g" + at, type: "group", configuration: {}, children: { content: [inner] } } as unknown as ComponentNode;
      }
      return form([inner]);
    };
    const inspectOf = (op: string, root: ComponentNode) => kernelRunInspect({ abi: WASM_ABI_VERSION, op, definition: { id: "f", version: "1", schemaVersion: "1", root } });
    // The grid at level 31: its row's field at 32 — read, and its required cell checked.
    expect(run(gridAt(31), { lines: [{}] }).errors.map((error) => error.code)).toEqual(["required"]);
    for (const op of ["public", "check", "inspect"]) {
      expect(inspectOf(op, gridAt(31)), op).toMatchObject({ ok: true });
    }
    // The grid at level 32: its row's field at 33, refused everywhere the run is.
    const refused = run(gridAt(32), { lines: [{ sku: "A" }] });
    expect(refused.errors).toEqual([{ code: "definition.tooDeep", stage: "definition", source: "wasm", parameters: { where: expect.stringMatching(/ > lines > content > sku$/), limit: 32 } }]);
    for (const op of ["public", "check", "inspect"]) {
      expect(inspectOf(op, gridAt(32)), op).toMatchObject({ ok: false, error: { code: "definition.tooDeep" } });
    }
    // Thousands of levels above an unbound grid: the typed refusal, never a RangeError.
    for (const level of [100, 3000]) {
      expect(run(gridAt(level), {}).errors.map((error) => error.code), String(level)).toEqual(["definition.tooDeep"]);
      expect(inspectOf("check", gridAt(level)), String(level)).toMatchObject({ ok: false, error: { code: "definition.tooDeep" } });
    }
  });

  it("measures a journey page's own nodes apart, from level 1", () => {
    const own = (levels: number) => {
      let inner: Record<string, unknown> = { id: "leaf", type: "text", configuration: {} };
      for (let level = levels - 1; level >= 1; level -= 1) {
        inner = { id: "o" + level, type: "group", configuration: {}, children: { content: [inner] } };
      }
      return inner;
    };
    const journey = (levels: number) => ({ journeys: [{ id: "j", pages: [{ id: "p", components: [own(levels)] }] }] });
    expect(run(form([node("a")]), {}, { journey: journey(32) }).errors.map((error) => error.code)).not.toContain("definition.tooDeep");
    expect(run(form([node("a")]), {}, { journey: journey(33) }).errors.map((error) => error.code)).toContain("definition.tooDeep");
  });

  // Hosts pass one journey `{ id, pages }`, not the wrapper.
  it("measures a bare journey as a host passes it, as well as the wrapper", () => {
    const own = (levels: number) => {
      let inner: Record<string, unknown> = { id: "leaf", type: "text", configuration: {} };
      for (let level = levels - 1; level >= 1; level -= 1) {
        inner = { id: "o" + level, type: "group", configuration: {}, children: { content: [inner] } };
      }
      return inner;
    };
    const bare = (levels: number) => ({ id: "j", pages: [{ id: "p", components: [own(levels)] }] });
    const root = form([node("a")]);
    expect(kernelComponentTooDeep(root, bare(32))).toBeUndefined();
    expect(kernelComponentTooDeep(root, bare(33))).toMatch(/^o1 > content > o2/);
    expect(run(root, {}, { journey: bare(32) }).errors.map((error) => error.code)).not.toContain("definition.tooDeep");
    const outcome = run(root, {}, { journey: bare(60) });
    expect(outcome.errors.map((error) => error.code)).toEqual(["definition.tooDeep"]);
    expect(kernelComponentTooDeep(root, { journeys: [bare(60)] })).toBeDefined();
    // The journeys passed as a bare list are measured too.
    expect(kernelComponentTooDeep(root, [bare(32)])).toBeUndefined();
    expect(kernelComponentTooDeep(root, [bare(5), bare(33)])).toMatch(/^o1 > content > o2/);
    expect(kernelComponentTooDeep(root, "not a journey")).toBeUndefined();
    expect(kernelComponentTooDeep(root, null)).toBeUndefined();
  });
});

describe("the browser's compile refuses a form tree nested past the limit", () => {
  it("names where, with the same count as the sandbox", async () => {
    const { compileFormDefinition } = await import("../form-engine/runtime/browser/form-runtime.js");
    const nest = (levels: number): ComponentNode => {
      let inner: ComponentNode = node("leaf");
      for (let level = levels - 1; level >= 1; level -= 1) {
        inner = { id: "g" + level, type: "group", configuration: {}, children: { content: [inner] } } as unknown as ComponentNode;
      }
      return { id: "form", type: "form", configuration: {}, children: { content: [inner] } } as unknown as ComponentNode;
    };
    const definition = (root: ComponentNode) => ({ id: "f", version: "1", schemaVersion: "1", root }) as never;
    expect(() => compileFormDefinition(definition(nest(31)))).not.toThrow();
    expect(() => compileFormDefinition(definition(nest(32)))).toThrow(/Components nest more than 32 levels deep \(at root > content > g1/);
  });
});
