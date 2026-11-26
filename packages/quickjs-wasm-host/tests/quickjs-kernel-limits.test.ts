import { describe, expect, it } from "vitest";

import { JsonWasmAbi, WasmValidationHost, WASM_ABI_VERSION, stableStringify, type ComponentNode } from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter, createQuickJsValidationHost } from "../src/index.js";
import { SLOW_FACTOR } from "./slow-machine.js";

// Kernel hardening on the real QuickJS program: what the in-process tests in
// engine/tests/kernel-limits-and-secrecy.test.ts and portable-options.test.ts assert, asserted
// again where the program runs inside the sandbox.

const SECRET = "ZZSECRETZZ";
const form = (children: unknown[], configuration: Record<string, unknown> = {}): ComponentNode =>
  ({ id: "form", type: "form", configuration, children: { content: children } }) as unknown as ComponentNode;
const text = (id: string, rules: Record<string, unknown> = {}, configuration: Record<string, unknown> = {}) => ({ id, type: "text", configuration, rules });
const pick = { id: "pick", type: "select", configuration: { data: { sourceId: "restricted" } } };
const addr = { id: "addr", type: "container", configuration: {}, children: { default: [pick] } };
const optionSnapshot = { restricted: [{ value: "ok", label: "Ok" }] };

async function runWith(host: WasmValidationHost, root: ComponentNode, values: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return host.run({ context: { formId: "f", values, locale: "en", form: root, optionSnapshot, ...extra } as never, policy: WasmValidationHost.STRICT_POLICY });
}

describe("the QuickJS program, kernel hardening", async () => {
  const host = await createQuickJsValidationHost([
    { id: "boomer", version: "1", source: `({ functions: { boom: (a) => { throw new Error("msg " + a[0]); } } })` },
    { id: "getter", version: "1", source: `({ validators: [ () => { var n = 0; return { get errors() { n += 1; return n === 1 ? [] : [{ nocode: true, severity: "error" }]; } }; } ] })` }
  ]);

  it("an object posted at a container key is judged like the flat key", async () => {
    const flat = await runWith(host, form([addr]), { "addr.pick": "evil" });
    expect(flat.errors.map((e) => e.code)).toEqual(["option.notAllowed"]);
    const nested = await runWith(host, form([addr]), { addr: { pick: "evil" } });
    expect(nested.errors.map((e) => e.code)).toEqual(["option.notAllowed"]);
    const fine = await runWith(host, form([addr]), { addr: { pick: "ok" } });
    expect(fine.errors).toEqual([]);
    expect(fine.values).toEqual({ "addr.pick": "ok" });
  });

  it("an object nested past the flattening cap is not stored", async () => {
    let inner: unknown = pick;
    for (let i = 20; i >= 0; i -= 1) inner = { id: "c" + i, type: "container", configuration: {}, children: { default: [inner] } };
    let cell: unknown = { pick: "evil" };
    for (let i = 20; i >= 0; i -= 1) cell = { ["c" + i]: cell };
    const out = await runWith(host, form([inner]), { c0: (cell as Record<string, unknown>).c0 });
    expect(JSON.stringify(out.values ?? null)).not.toContain("evil");
  });

  it("a shared-structure list chain settles with a warning instead of hanging the run", async () => {
    const chain = Array.from({ length: 30 }, (_, k) => 29 - k).map((i) => text("l" + i, { value: i === 0 ? 'split("a,b", ",")' : `append(l${i - 1}, l${i - 1})` }));
    // Its own host with a fixed budget: thirty rules resolved one a pass take a while on a loaded machine.
    const patient = await createQuickJsValidationHost([], { maxEvalMs: 20000 });
    const out = await runWith(patient, form(chain, { formulaErrors: "warn" }), {}, { logLevel: "warn" });
    expect(out.logs?.some((l) => /append: the result is over the 10000 item cap/.test(l.message))).toBe(true);
    patient.dispose();
  }, 60000);

  it("a server-secret rule's text, function name and thrown message stay out of the outcome", async () => {
    const secret = (formula: string) => ({ run: "server-secret", formula });
    const cases: Array<[string, string]> = [
      [`matches(t, "^(a+)+$${SECRET}")`, "fail"],
      [`${SECRET}(t) = 1`, "fail"],
      [`boom("${SECRET}") = 1`, "fail"],
      [`boom("${SECRET}") = 1`, "warn"]
    ];
    for (const [formula, formulaErrors] of cases) {
      const out = await runWith(host, form([text("t"), text("x", { requiredWhen: secret(formula) })], { formulaErrors }), { t: "hello", x: "v" }, { logLevel: "debug" });
      expect(JSON.stringify(out), formula).not.toContain(SECRET);
      expect(JSON.stringify(out), formula).toContain("rules:x:requiredWhen");
    }
  });

  it("a catastrophic field pattern is refused as risky, not run to the interrupt", async () => {
    const out = await runWith(host, form([text("t", {}, { pattern: "(a|a?)+" })], { formulaErrors: "fail" }), { t: "a".repeat(40) + "!" });
    expect(out.errors.map((e) => e.code)).toEqual(["pattern"]);
    expect(out.errors[0]?.parameters).toMatchObject({ risky: true });
  }, 30000);

  // The parsed-pattern check, in the sandbox's own copy of the kernel.
  it("wrapped and overlapping branches are risky, delimited word and domain patterns are not", async () => {
    const run = (pattern: string, answer: string) => runWith(host, form([text("t", {}, { pattern })], { formulaErrors: "fail" }), { t: answer });
    for (const pattern of ["^((a)|(a?))+$", "^(?:a|(?:a?))+$", "^(a|a)+$", "^(a|aa)+$", "^(\\d|\\d\\d)+$"]) {
      const out = await run(pattern, "a".repeat(30) + "!");
      expect(out.errors[0]?.parameters, pattern).toMatchObject({ risky: true });
    }
    for (const [pattern, answer] of [["^([a-z0-9-]+\\.){1,10}[a-z]{2,}$", "mail.example.org"], ["^(\\w+ ){0,9}\\w+$", "one two three"]] as const) {
      expect((await run(pattern, answer)).errors, pattern).toEqual([]);
    }
  }, 30000);

  // An unclosed \\u{ is answered at once rather than spinning the parse until the interrupt (which would fail the whole run); a modifier group does not hide a nested repeat.
  it("a pattern with an unclosed \\u{ is answered at once, and a modifier group does not hide a repeat of a repeat", async () => {
    const run = (pattern: string, answer: string) => runWith(host, form([text("t", {}, { pattern })], { formulaErrors: "fail" }), { t: answer });
    const started = Date.now();
    const open = await run("\\u{41", "A");
    expect(open.errors[0]?.code).toBe("pattern");
    expect(open.errors[0]?.parameters).toMatchObject({ invalid: true });
    expect(Date.now() - started).toBeLessThan(2000 * SLOW_FACTOR);
    for (const pattern of ["^(?i:(a+)+)$", "^(a{1,2})+$", "^a*a*a*a*b$"]) {
      const out = await run(pattern, "a".repeat(40) + "!");
      expect(out.errors[0]?.parameters, pattern).toMatchObject({ risky: true });
    }
    expect((await run("^\\p{L}+(?:[ '-]\\p{L}+)*$", "Anne-Marie O'Neil")).errors).toEqual([]);
  }, 30000);

  // These are refused as risky at once, not run (or analysed) until the interrupt, which would fail the whole run.
  it("astral, counted-group, cubic-email and 150-way alternation patterns are answered as risky, at once", async () => {
    const run = (pattern: string, answer: string) => runWith(host, form([text("t", {}, { pattern })], { formulaErrors: "fail" }), { t: answer });
    const alternation = (count: number) => "^(" + Array.from({ length: count }, (_, i) => "[" + String.fromCharCode(0x4e00 + i * 3) + "-" + String.fromCharCode(0x4e00 + i * 3 + 1) + "]").join("|") + ")+$";
    const cases: Array<[string, string]> = [
      ["^(\u{1F600}+)+$", "\u{1F600}".repeat(30) + "!"],
      ["^(a+){7}$", "a".repeat(60) + "!"],
      ["^(.*a){7}$", "a".repeat(60) + "!"],
      ["^\\S+@\\S+\\.\\S+$", "@.".repeat(1500) + " "],
      [alternation(150), "a"]
    ];
    for (const [pattern, answer] of cases) {
      const started = Date.now();
      const out = await run(pattern, answer);
      expect(out.errors[0]?.parameters, pattern.slice(0, 40)).toMatchObject({ risky: true });
      expect(Date.now() - started, pattern.slice(0, 40)).toBeLessThan(1500 * SLOW_FACTOR);
    }
    // Under the budget the alternation is read, passes, and runs.
    expect((await run(alternation(40), "\u4e00")).errors.map((e) => e.parameters)).not.toContainEqual(expect.objectContaining({ risky: true }));
  }, 60000);

  it("a scalar at a container's key is not stored, and a nested grid value is held to its flat spelling", async () => {
    const stripped = await runWith(host, form([addr]), { addr: "evil", "addr.pick": "ok" });
    expect(stripped.values).toEqual({ "addr.pick": "ok" });
    const rejected = await runWith(host, form([addr]), { addr: ["x"] }, { unknownFields: "reject" });
    expect(rejected.errors.map((e) => e.parameters)).toEqual([{ field: "addr" }]);
    const grid = { id: "g", type: "dataGrid", configuration: {}, collection: { collectionPath: "addr.g" }, children: { content: [text("c")] } };
    const tree = form([{ id: "addr", type: "container", configuration: {}, children: { default: [grid] } }]);
    const flat = await runWith(host, tree, { "addr.g": { c: "evil" } });
    const nested = await runWith(host, tree, { addr: { g: { c: "evil" } } });
    expect(nested.values).toEqual(flat.values);
    expect(JSON.stringify(nested.values ?? null)).not.toContain("evil");
  });

  it("a single journey as a host passes it is measured for depth", async () => {
    let own: Record<string, unknown> = { id: "leaf", type: "text", configuration: {} };
    for (let level = 59; level >= 1; level -= 1) own = { id: "o" + level, type: "group", configuration: {}, children: { content: [own] } };
    const out = await runWith(host, form([text("a")]), {}, { journey: { id: "j", pages: [{ id: "p", components: [own] }] } });
    expect(out.errors.map((e) => e.code)).toEqual(["definition.tooDeep"]);
  });

  it("a composed catastrophic pattern is refused at the call", async () => {
    const root = form([text("t"), text("x", { requiredWhen: 'matches(t, concat("^(a+)", "+$"))' })], { formulaErrors: "fail" });
    const out = await runWith(host, root, { t: "a".repeat(40) + "!" }, { logLevel: "warn" });
    expect(out.logs?.some((l) => /matches: the pattern repeats a repeat/.test(l.message))).toBe(true);
  }, 30000);

  it("a replace that would pass the cap is refused before it is built, with the cap's own warning", async () => {
    const root = form([text("t"), text("x", { validWhen: 'len(replace(t, "a", padStart("", 10000, "x"))) > 0' })], { formulaErrors: "warn" });
    const out = await runWith(host, root, { t: "a".repeat(10000), x: "v" }, { logLevel: "warn" });
    expect(out.logs?.some((l) => /replace: the text is over the 10,000 character cap/.test(l.message))).toBe(true);
    expect(out.logs?.some((l) => /out of memory/.test(l.message))).toBe(false);
  });

  it("a locale that is not a text is read as absent, not a raw TypeError", async () => {
    // The message's words per locale live in the definition's map, crossing as `translations`.
    const root = form([text("a", {}, { pattern: "^x$", patternMessage: "D" })]);
    const translations = { en: { components: { a: { patternMessage: { text: "E", source: "1hkaexf" } } } } };
    const out = await runWith(host, root, { a: "bad" }, { locale: 5, logLevel: "warn", translations });
    expect(out.errors.map((e) => e.code)).toEqual(["pattern"]);
    // Read as absent: the default locale, whose words the map gives.
    expect(out.errors[0]?.parameters).toMatchObject({ message: "E" });
  });

  it("a validator whose errors list changes between reads is judged on its first read", async () => {
    const out = await runWith(host, form([text("name")]), { name: "x" });
    expect(out.errors).toEqual([]);
  });

  it("a plugin's megabyte log lines do not make the outcome unreadable", async () => {
    const loud = await createQuickJsValidationHost([
      { id: "loud", version: "1", source: `({ validators: [ (c) => { const big = "x".repeat(1 << 20); for (let i = 0; i < 300; i++) c.log.error(big); return { errors: [] }; } ] })` }
    ], { maxEvalMs: 5000 });
    const out = await runWith(loud, form([]), {});
    expect(out.logs?.length).toBeGreaterThan(0);
    expect(out.logs?.every((l) => l.message.length <= 8192 + 20)).toBe(true);
    loud.dispose();
  }, 30000);

  it("a validWhen on a field inside a repeating section is warned about at compile", async () => {
    const root = form([
      { id: "items", type: "repeatingSection", configuration: {}, collection: { itemFields: ["qty"] }, children: { content: [{ id: "qty", type: "number", configuration: {}, rules: { validWhen: "component > 0" } }] } }
    ], { formulaErrors: "fail" });
    const out = await runWith(host, root, { "items[0].qty": -5 }, { logLevel: "warn" });
    expect(out.errors).toEqual([]);
    expect(out.logs?.some((l) => l.message.startsWith("formula warning: rules:qty:validWhen"))).toBe(true);
  });

  const rowsForm = form([{ id: "rows", type: "group", configuration: {}, collection: {}, children: { content: [text("sku", {}, { required: true })] } }]);

  it("20,000 rows are judged in linear time, valid or not", async () => {
    const big = await createQuickJsValidationHost([], { maxEvalMs: 60000, memoryLimitBytes: 512 * 1024 * 1024 });
    for (const sku of ["", "ok"]) {
      // Relative: 4x the rows costs about 4x (linear); the old quadratic walk cost about 16x.
      const warm = Array.from({ length: 5000 }, () => ({ sku }));
      const warmStarted = Date.now();
      await runWith(big, rowsForm, { rows: warm });
      const warmMs = Date.now() - warmStarted;
      const rows = Array.from({ length: 20000 }, () => ({ sku }));
      const started = Date.now();
      const out = await runWith(big, rowsForm, { rows });
      // The list is cut at 10,000 with an errors.truncated entry.
      expect(out.errors, JSON.stringify(sku)).toHaveLength(sku === "" ? 10001 : 0);
      // About 0.8 s here; it was 3.7 s (quadratic) before.
      expect(Date.now() - started).toBeLessThan(Math.max(2000, warmMs * 8 + 500));
    }
    big.dispose();
  }, 120000);

  it("more than 65,535 errors come back (cut at 10,000), not a RangeError", async () => {
    const big = await createQuickJsValidationHost([], { maxEvalMs: 120000, memoryLimitBytes: 768 * 1024 * 1024 });
    const rows = Array.from({ length: 70000 }, () => ({ sku: "" }));
    const out = await runWith(big, rowsForm, { rows });
    expect(out.errors).toHaveLength(10001);
    expect(out.errors[10000]?.code).toBe("errors.truncated");
    big.dispose();
  }, 180000);

  it("40 and 100 levels of components are refused with a typed error, 31 run", async () => {
    const nest = (levels: number): ComponentNode => {
      let inner: unknown = text("leaf", {}, { required: true });
      for (let level = levels - 1; level >= 1; level -= 1) inner = { id: "g" + level, type: "group", configuration: {}, children: { content: [inner] } };
      return form([inner]);
    };
    expect((await runWith(host, nest(31), {})).errors.map((e) => e.code)).toEqual(["required"]);
    for (const levels of [40, 100]) {
      const out = await runWith(host, nest(levels), {});
      expect(out.errors.map((e) => e.code), String(levels)).toEqual(["definition.tooDeep"]);
      expect(out.errors[0]?.parameters).toMatchObject({ limit: 32 });
    }
    const abi = new JsonWasmAbi();
    const instance = await new QuickJsWasmHostAdapter().instantiate([], abi);
    for (const op of ["public", "check", "inspect"]) {
      const answer = JSON.parse(await instance.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op, definition: { id: "f", version: "1", schemaVersion: "1", root: nest(100) } })));
      expect(answer, op).toMatchObject({ ok: false, error: { code: "definition.tooDeep" } });
    }
    instance.dispose?.();
  });
});
