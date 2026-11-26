import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FORMULA_FUNCTION_NAMES,
  InProcessWasmHostAdapter,
  JsonWasmAbi,
  WASM_ABI_VERSION,
  WasmValidationHost,
  stableStringify,
  type DefinitionInspectResponse,
  type FormDefinition,
  type WasmPluginModule,
  type WasmValidatorInstance
} from "@argusvane/datum-engine";
import { kernelStructureLimits } from "@argusvane/datum-engine/testing";

import { QuickJsWasmHostAdapter, buildSandboxProgram, createQuickJsValidationHost, toSourcePlugin } from "../src/index.js";
import { FORMULA_TYPO, formulaJourney, formulaPlugin, formulaRoot, formulaRootWithTypo } from "./fixtures/formula-form.js";

/**
 * The introspection entry point through the real sandbox (`__datum_inspect`) against the
 * in-process adapter: the three ops answer byte-identical canonical JSON over the formula fixture,
 * with and without its plugin wired, and the refusals agree too.
 */

function definition(root = formulaRoot()): FormDefinition {
  return { id: "formulas", version: "1", schemaVersion: "1", root, journey: { journeys: [formulaJourney()] } };
}

function request(op: string, extra: Record<string, unknown> = {}, form: FormDefinition = definition()): string {
  return stableStringify({ abi: WASM_ABI_VERSION, op, definition: form, ...extra });
}

interface Pair {
  inProcess: WasmValidatorInstance;
  quickJs: WasmValidatorInstance;
}

async function instantiate(plugins: readonly WasmPluginModule[]): Promise<Pair> {
  const abi = new JsonWasmAbi();
  const inProcess = new InProcessWasmHostAdapter().instantiate(plugins, abi);
  const quickJs = await new QuickJsWasmHostAdapter().instantiate(
    plugins.map((plugin) => ("source" in plugin ? plugin : toSourcePlugin(plugin))),
    abi
  );
  return { inProcess, quickJs };
}

async function both(pair: Pair, serialized: string): Promise<{ text: string; answer: DefinitionInspectResponse }> {
  const fromKernel = await pair.inProcess.inspect!(serialized);
  const fromSandbox = await pair.quickJs.inspect!(serialized);
  expect(fromSandbox).toBe(fromKernel);
  return { text: fromKernel, answer: JSON.parse(fromKernel) as DefinitionInspectResponse };
}

describe("sandbox inspect: QuickJS and the in-process kernel answer the same bytes", () => {
  let bare: Pair;
  let wired: Pair;

  beforeAll(async () => {
    bare = await instantiate([]);
    wired = await instantiate([formulaPlugin()]);
  });

  afterAll(() => {
    bare.quickJs.dispose?.();
    wired.quickJs.dispose?.();
  });

  it("declares the entry point in the program", () => {
    const program = buildSandboxProgram();
    expect(program.split("var __datum_inspect = function (serializedRequest)").length - 1).toBe(1);
    expect(program).toContain('__datum_publish("__datum_inspect", __datum_inspect);');
    expect(program).toContain("__datum_builtin_names, __datum_functions, __datum_validators));");
  });

  it("public: the secret rule is gone, the field and every other rule stay, the author's definition is untouched", async () => {
    const form = definition();
    const before = JSON.stringify(form);
    const { text, answer } = await both(bare, request("public", {}, form));
    expect(answer).toMatchObject({ ok: true, op: "public" });
    if (!answer.ok || answer.op !== "public") {
      throw new Error("not a public answer");
    }
    expect(text).not.toContain("server-secret");
    expect(text).not.toContain("amount > 1000");
    const content = answer.definition.root.children?.content ?? [];
    const bigReason = content.find((node) => node.id === "big_reason");
    expect(bigReason).toBeDefined();
    expect(bigReason?.rules).toEqual({});
    expect(content.find((node) => node.id === "size")?.rules).toEqual({ value: { formula: 'if amount > 100 then "large" else "small"', run: "server" } });
    expect(content.find((node) => node.id === "local_note")?.rules).toEqual({ value: { formula: "upper(nickname)", run: "browser" } });
    expect(answer.definition.journey).toEqual(form.journey);
    expect(JSON.stringify(form)).toBe(before);
    // The same bytes whether or not the plugin is wired.
    expect((await both(wired, request("public", {}, form))).text).toBe(text);
  });

  it("check: a clean form is ok; the typo is a problem whose verdict follows the policy; an unwired plugin is a problem", async () => {
    const wiredClean = await both(wired, request("check"));
    expect(wiredClean.answer).toEqual({
      ok: true,
      op: "check",
      problems: [],
      warnings: [],
      policy: "fail",
      structure: [],
      // The fixture writes `options: ["a", "b", "c"]`: bare strings, which the renderer draws nothing for.
      structureWarnings: [expect.objectContaining({ code: "option.entry.invalid", where: "root > content > options" })],
      limits: kernelStructureLimits(),
      verdict: "ok"
    });

    const bareClean = await both(bare, request("check"));
    // The default policy is fail.
    expect(bareClean.answer).toMatchObject({ ok: true, op: "check", policy: "fail", verdict: "fail" });
    if (!bareClean.answer.ok || bareClean.answer.op !== "check") {
      throw new Error("not a check answer");
    }
    expect(bareClean.answer.problems).toEqual([expect.objectContaining({ where: "rules:tax:value", code: "unknownFunction", params: { name: "regionTax" } })]);

    // Under warn the unknown function on the server-run rule still refuses in the kernel, so check says fail.
    const bareWarned = await both(bare, request("check", { formulaErrors: "warn" }));
    expect(bareWarned.answer).toMatchObject({ ok: true, op: "check", policy: "warn", verdict: "fail" });

    const typo = await both(wired, request("check", {}, definition(formulaRootWithTypo())));
    expect(typo.answer).toMatchObject({ ok: true, op: "check", policy: "fail", verdict: "fail" });
    if (!typo.answer.ok || typo.answer.op !== "check") {
      throw new Error("not a check answer");
    }
    expect(typo.answer.problems).toEqual([expect.objectContaining({ where: "rules:total:value", code: "unclosedParen", text: FORMULA_TYPO })]);

    // A word that is neither is no word: the default.
    const unknownWord = await both(wired, request("check", { formulaErrors: "ignore" as never }, definition(formulaRootWithTypo())));
    expect(unknownWord.answer).toMatchObject({ policy: "fail", verdict: "fail" });
    const warned = await both(wired, request("check", { formulaErrors: "warn" }, definition(formulaRootWithTypo())));
    expect(warned.answer).toMatchObject({ policy: "warn", verdict: "warn" });
  });

  it("inspect: every built-in and the plugin function are used, the plugin is needed wired or not, and the rules carry their scopes", async () => {
    const { answer } = await both(bare, request("inspect"));
    expect(answer).toMatchObject({ ok: true, op: "inspect" });
    if (!answer.ok || answer.op !== "inspect") {
      throw new Error("not an inspect answer");
    }
    expect(answer.functionsUsed).toEqual([...FORMULA_FUNCTION_NAMES, "regionTax"].sort());
    expect(answer.pluginsNeeded).toEqual(["regionTax"]);

    const byId = new Map(answer.rules.map((rule) => [`${rule.componentId}:${rule.key}`, rule]));
    expect(byId.get("big_reason:requiredWhen")).toEqual({
      componentId: "big_reason",
      key: "requiredWhen",
      run: "server-secret",
      reads: ["amount"],
      readsHost: false,
      readsClock: false,
      functions: []
    });
    expect(byId.get("size:value")).toMatchObject({ run: "server", reads: ["amount"], functions: [] });
    expect(byId.get("local_note:value")).toMatchObject({ run: "browser", reads: ["nickname"], functions: ["upper"] });
    expect(byId.get("nickname_note:visibleWhen")).toMatchObject({ run: "browser", reads: ["nickname"], functions: ["empty"] });
    expect(byId.get("adult_note:visibleWhen")).toMatchObject({ run: "both", reads: ["dob"], readsClock: true, functions: ["age"] });
    expect(byId.get("tax:value")).toMatchObject({ run: "both", reads: ["amount", "region"], functions: ["regionTax", "roundTo"] });
    expect(byId.get("month_start:value")).toMatchObject({ reads: [], readsClock: true, functions: ["startOfMonth", "today"] });
    expect(byId.get("items_total:value")).toMatchObject({ reads: ["lines"], functions: ["pluck", "sum"] });
    expect(byId.get("line_label:value")).toMatchObject({ reads: [], functions: ["concat", "rowCount", "rowIndex", "text"] });
    // Document order: the inputs carry no rule, so the first rule is the first calculation's.
    expect(answer.rules[0]).toMatchObject({ componentId: "full_name", key: "value" });
    expect(answer.rules.map((rule) => rule.componentId).indexOf("line_label")).toBeGreaterThan(answer.rules.map((rule) => rule.componentId).indexOf("adult_note"));

    // Wired, the plugin still is no built-in: the same inventory, byte for byte.
    const viaWired = await both(wired, request("inspect"));
    expect(viaWired.answer).toEqual(answer);
  });

  it("refuses alike: a newer version, another major, an op of no shape, a request that is not an object", async () => {
    const newer = await both(bare, stableStringify({ abi: "4.2.0", op: "public", definition: definition() }));
    expect(newer.answer).toMatchObject({ ok: false, error: { code: "abi_mismatch" } });
    // Another major either way is refused; a request of the program's own version is answered.
    const otherMajor = await both(bare, stableStringify({ abi: "3.18.0", op: "public", definition: definition() }));
    expect(otherMajor.answer).toMatchObject({ ok: false, error: { code: "abi_mismatch" } });
    const own = await both(bare, stableStringify({ abi: "4.1.0", op: "public", definition: definition() }));
    expect(own.answer).toMatchObject({ ok: true, op: "public" });
    const none = await both(bare, stableStringify({ op: "public", definition: definition() }));
    expect(none.answer).toMatchObject({ ok: false, error: { code: "abi_mismatch" } });
    const badOp = await both(bare, request("nope"));
    expect(badOp.answer).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const noRoot = await both(bare, stableStringify({ abi: WASM_ABI_VERSION, op: "inspect", definition: { id: "x" } }));
    expect(noRoot.answer).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const list = await both(bare, "[1,2,3]");
    expect(list.answer).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("is reachable through WasmValidationHost.inspect over the QuickJS host", async () => {
    const host = await createQuickJsValidationHost([toSourcePlugin(formulaPlugin())]);
    try {
      const answer = await host.inspect({ op: "inspect", definition: definition() });
      expect(answer).toMatchObject({ ok: true, op: "inspect", pluginsNeeded: ["regionTax"] });
      const served = await host.inspect({ op: "public", definition: definition() });
      expect(JSON.stringify(served)).not.toContain("server-secret");
      expect(host).toBeInstanceOf(WasmValidationHost);
    } finally {
      host.dispose();
    }
  });
});

/**
 * The structural check: the real program answers the in-process kernel's bytes for the
 * structure lists, the size gate, the types request member and the secrets a public copy withholds.
 */
describe("sandbox inspect: the structure of a definition", () => {
  let pair: Pair;
  const MARK = "ZZ_QJS_MISPLACED_5521";
  const secret = { formula: `t = "${MARK}"`, run: "server-secret" };

  beforeAll(async () => {
    pair = await instantiate([]);
  });
  afterAll(() => {
    pair.quickJs.dispose?.();
  });

  const form = (content: unknown[], extra: Record<string, unknown> = {}, rootExtra: Record<string, unknown> = {}): FormDefinition =>
    ({ id: "f", version: "1", schemaVersion: "1", root: { id: "form", type: "form", configuration: {}, children: { content }, ...rootExtra }, ...extra }) as unknown as FormDefinition;
  const text = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "text", configuration: {}, ...extra });
  const tokens = (list: Array<{ code: string; where: string }> | undefined) => (list ?? []).map((problem) => `${problem.code}@${problem.where}`);

  it("answers the same bytes for a clean form, with the limits in force", async () => {
    const { answer } = await both(pair, request("check", {}, form([text("t")])));
    expect(answer).toMatchObject({ ok: true, op: "check", structure: [], structureWarnings: [], verdict: "ok", limits: { components: 10000, depth: 32, problems: 200 } });
  });

  it("refuses duplicate ids, a malformed journey and a shared stored place, and warns on the rest, identically", async () => {
    const definition = form([text("dup"), text("dup"), text("k1", { configuration: { dataKey: "k" } }), text("k2", { configuration: { dataKey: "k" } })], {
      journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["ghost"], routes: [{ to: "nowhere" }] }, { id: "p" }] }] },
      extra: 1
    });
    const { answer } = await both(pair, request("check", { types: ["text"] }, definition));
    if (!answer.ok || answer.op !== "check") {
      throw new Error("not a check answer");
    }
    expect(tokens(answer.structure)).toEqual([
      "component.id.duplicate@root > content > dup",
      "component.dataPath.duplicate@root > content > dup",
      "component.dataPath.duplicate@root > content > k2",
      "journey.invalid@journey:j",
      "journey.page.duplicateId@journey:j:page:p"
    ]);
    expect(tokens(answer.structureWarnings)).toEqual(["definition.key.unknown@definition"]);
    expect(answer.verdict).toBe("fail");
  });

  it("answers a definition past a size cap with the size problems alone, identically", async () => {
    const flat = form(Array.from({ length: 10001 }, (_, n) => text(`c${n}`)));
    const { answer } = await both(pair, request("check", {}, flat));
    expect(answer).toMatchObject({ ok: true, verdict: "fail", problems: [], structure: [{ code: "definition.tooManyComponents", limit: 10000 }] });
  }, 60_000);

  it("reads the types member: a type the host cannot draw warns; a malformed list is invalid_request", async () => {
    const definition = form([text("t"), { id: "x", type: "mystery", configuration: {} }]);
    const { answer } = await both(pair, request("check", { types: ["text"] }, definition));
    expect(answer).toMatchObject({ ok: true, structureWarnings: [{ code: "component.type.unknown", where: "root > content > x" }], verdict: "ok" });
    const bad = await both(pair, request("check", { types: [5] }, definition));
    expect(bad.answer).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("gives definition.tooDeep a where and a limit", async () => {
    let leaf: Record<string, unknown> = text("leaf");
    for (let level = 0; level < 40; level += 1) {
      leaf = { id: `c${level}`, type: "container", configuration: {}, children: { content: [leaf] } };
    }
    const { answer } = await both(pair, request("check", {}, form([leaf])));
    expect(answer).toMatchObject({ ok: false, error: { code: "definition.tooDeep", limit: 32, where: expect.stringContaining("root > content") } });
  });

  it("serves an own __proto__ key as a key and refuses it in check, identically", async () => {
    const text2 = '{"abi":"4.1.0","op":"check","definition":{"id":"f","version":"1","schemaVersion":"1","__proto__":{"x":1},"root":{"id":"form","type":"form","configuration":{},"children":{"content":[]}}}}';
    const { answer } = await both(pair, text2);
    expect(tokens((answer as { structure?: Array<{ code: string; where: string }> }).structure)).toEqual(["definition.key.prototype@definition"]);
  });

  it.each([
    ["a journey page when", form([text("t")], { journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["t"], when: secret }] }] } })],
    ["a journey route when", form([text("t")], { journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["t"], routes: [{ to: "$end", when: secret }] }] }] } })],
    ["a PDF layout when", form([text("t")], { pdf: { layouts: [{ id: "l", kind: "generated", when: secret }] } })],
    ["a children slot that is not a list", form([text("t")], {}, { children: { content: [text("t")], weird: text("w", { rules: { requiredWhen: secret } }) } })]
  ])("the public copy does not serve %s, and check names where without the text", async (_name, definition) => {
    const publicCopy = await both(pair, request("public", {}, definition));
    expect(publicCopy.text).not.toContain(MARK);
    expect(publicCopy.text).not.toContain("server-secret");
    const checked = await both(pair, request("check", {}, definition));
    expect(checked.text).not.toContain(MARK);
  });

  it("a request of the program's major is accepted and gets the full structure answer; another major is refused", async () => {
    const own = await both(pair, stableStringify({ abi: "4.1.0", op: "check", definition: form([text("dup"), text("dup")]) }));
    expect(own.answer).toMatchObject({ ok: true, verdict: "fail", structure: [{ code: "component.id.duplicate" }, { code: "component.dataPath.duplicate" }] });
    const newer = await both(pair, stableStringify({ abi: "5.0.0", op: "check", definition: form([text("a")]) }));
    expect(newer.answer).toMatchObject({ ok: false, error: { code: "abi_mismatch" } });
  });

  it("is deterministic: the same request twice, the same bytes", async () => {
    const request1 = request("check", {}, form([text("dup"), text("dup")]));
    const first = await both(pair, request1);
    const second = await both(pair, request1);
    expect(second.text).toBe(first.text);
  });
});
