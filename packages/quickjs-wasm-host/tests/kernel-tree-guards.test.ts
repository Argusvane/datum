import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InProcessWasmHostAdapter, JsonWasmAbi, WASM_ABI_VERSION, WasmValidationHost, stableStringify, type ComponentNode } from "@argusvane/datum-engine";

import { QuickJsExecutionError, createQuickJsValidationHost } from "../src/index.js";

/**
 * A rule written as an expression tree goes through the compile's guards in the sandbox as in
 * process: a function the server lacks refuses the run, a node the evaluator
 * cannot read is a typed `formula.invalid`, never a raw runtime error, and a tree nested past the
 * request limit is the host's typed `request_refused`, never a stack overflow while the request
 * is written.
 */

type Host = Awaited<ReturnType<typeof createQuickJsValidationHost>>;
let host: Host;

beforeAll(async () => {
  host = await createQuickJsValidationHost([]);
});
afterAll(() => {
  host.dispose();
});

const serverCall = { kind: "call", name: "serverCheck", args: [{ kind: "path", path: "a" }] };
const visibleTree = { kind: "binary", operator: "eq", left: serverCall, right: { kind: "literal", value: true } };

function form(rule: unknown): ComponentNode {
  return {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "a", type: "text", configuration: {} },
        { id: "b", type: "text", configuration: { required: true }, rules: { visibleWhen: rule } }
      ]
    }
  } as unknown as ComponentNode;
}

function chain(kind: "not" | "and", depth: number): unknown {
  let node: unknown = { kind: "path", path: "a" };
  for (let i = 0; i < depth; i += 1) {
    node = kind === "not" ? { kind: "unary", operator: "not", operand: node } : { kind: "logical", operator: "and", left: { kind: "path", path: "a" }, right: node };
  }
  return node;
}

async function both(root: ComponentNode): Promise<{ sandbox: string[]; inProcess: string[] }> {
  const context = { formId: "f", locale: "en", form: root, values: { a: "x" } };
  const sandbox = await host.run({ context: context as never, policy: WasmValidationHost.STRICT_POLICY });
  const instance = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());
  const inProcess = JSON.parse(instance.run(JSON.stringify(context)) as string) as { errors: Array<{ code: string; parameters?: { where?: string } }> };
  const codes = (errors: ReadonlyArray<{ code: string; parameters?: unknown }>): string[] =>
    errors.map((error) => error.code + ":" + String((error.parameters as { where?: string } | undefined)?.where ?? ""));
  return { sandbox: codes(sandbox.errors), inProcess: codes(inProcess.errors) };
}

describe("rule trees in the sandbox", () => {
  it("a function the server lacks, as a bare tree or the object form, is refused as the formula is", async () => {
    for (const rule of ['serverCheck(a) = true', visibleTree, { expression: visibleTree, run: "server" }]) {
      const answer = await both(form(rule));
      expect(answer.sandbox).toEqual(["formula.invalid:rules:b:visibleWhen"]);
      expect(answer.inProcess).toEqual(answer.sandbox);
    }
  });

  it.each([
    ["logical with no operands", { kind: "logical", operator: "and" }],
    ["unary with no operand", { kind: "unary", operator: "not" }],
    ["binary with a null left", { kind: "binary", operator: "eq", left: null, right: { kind: "literal", value: 1 } }],
    ["call with no args", { kind: "call", name: "sum" }],
    ["if with no cases", { kind: "if" }],
    ["if with a null case", { kind: "if", cases: [null] }]
  ])("a malformed tree (%s) is a typed refusal, and check fails", async (_name, rule) => {
    const answer = await both(form(rule));
    expect(answer.sandbox).toEqual(["formula.invalid:rules:b:visibleWhen"]);
    expect(answer.inProcess).toEqual(answer.sandbox);
    const check = (await host.inspect({ abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: form(rule) } } as never)) as { verdict: string };
    expect(check.verdict).toBe("fail");
  });

  it.each([
    ["not", 5000],
    ["not", 20000],
    ["and", 20000]
  ] as const)("a %s tree %i deep is the host's typed request_refused, never a stack overflow", async (kind, depth) => {
    const context = { formId: "f", locale: "en", form: form(chain(kind, depth)), values: { a: "x" } };
    const failure = await host.run({ context: context as never, policy: WasmValidationHost.STRICT_POLICY }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(QuickJsExecutionError);
    expect((failure as QuickJsExecutionError).code).toBe("request_refused");
    expect(stableStringify(context).length).toBeGreaterThan(depth * 30);
  });
});

describe("a component tree no run can walk, in the sandbox", () => {
  const text = (id: string): Record<string, unknown> => ({ id, type: "text", configuration: {} });
  const box = (id: string, content: unknown[]): Record<string, unknown> => ({ id, type: "container", configuration: {}, children: { content } });
  const root = (content: unknown[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content } }) as unknown as ComponentNode;

  it.each([
    ["a null entry", root([text("a"), null]), "definition.malformed"],
    ["a null slot", root([{ id: "g", type: "group", configuration: {}, collection: {}, children: { default: null } }]), "definition.malformed"],
    ["a child with its parent's id", root([box("a", [text("a")])]), "definition.idCycle"],
    ["a child with the form's id", root([text("form")]), "definition.idCycle"],
    ["a grandchild with its grandparent's id", root([box("a", [box("b", [text("a")])])]), "definition.idCycle"]
  ])("%s is a typed refusal on both hosts, never a runtime error or a deadline", async (_name, tree, code) => {
    const started = Date.now();
    const answer = await both(tree);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(answer.sandbox.map((entry) => entry.split(":")[0])).toEqual([code]);
    expect(answer.inProcess).toEqual(answer.sandbox);
  });

  const grid = (children: unknown): Record<string, unknown> => ({ id: "g", type: "dataGrid", collection: {}, configuration: {}, children });
  it.each([
    ["a slot that is text", { id: "form", type: "form", configuration: {}, children: { content: "abc" } }],
    ["a slot that is a number", { id: "form", type: "form", configuration: {}, children: { content: 5 } }],
    ["children that are a list", { id: "form", type: "form", configuration: {}, children: [text("a")] }],
    ["children that are text", { id: "form", type: "form", configuration: {}, children: "x" }],
    ["an entry that is a list", root([text("a"), [text("b")]])],
    ["an entry that is text", root([text("a"), "b"])],
    ["a data grid's null slot", root([grid({ content: null })])],
    ["a data grid's null entry", root([grid({ content: [text("c"), null] })])],
    ["a data grid's children that are a list", root([grid([text("c")])])],
    ["a data grid's slot that is text", root([grid({ content: "zz" })])],
    ["a null entry under a container", root([box("box", [null])])]
  ])("%s is definition.malformed on both hosts, and check fails it", async (_name, tree) => {
    const answer = await both(tree as unknown as ComponentNode);
    expect(answer.sandbox.map((entry) => entry.split(":")[0])).toEqual(["definition.malformed"]);
    expect(answer.inProcess).toEqual(answer.sandbox);
    const request = { abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: tree } };
    expect(JSON.parse(new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi()).inspect!(stableStringify(request)) as string).verdict).toBe("fail");
  });

  it.each([
    ["a child with its parent's id", root([box("a", [text("a")])]), "root > content > a > content > a"],
    ["a child with the form's id", root([text("form")]), "root > content > form"],
    ["a grandchild with its grandparent's id", root([box("a", [box("b", [text("a")])])]), "root > content > a > content > b > content > a"]
  ])("check fails %s as a repeated id, in the sandbox as in process", async (_name, tree, where) => {
    const request = { abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: tree } };
    const sandbox = (await host.inspect(request as never)) as { verdict: string; structure: Array<{ code: string; where: string }> };
    expect(sandbox.verdict).toBe("fail");
    expect(sandbox.structure.map((entry) => entry.code + "@" + entry.where)).toContain("component.id.duplicate@" + where);
    const inProcess = JSON.parse(new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi()).inspect!(stableStringify(request)) as string);
    expect(inProcess.structure).toEqual(sandbox.structure);
  });

  it("two cousins crossing ids put no id on its own chain: both hosts run them as repeated ids, alike", async () => {
    const answer = await both(root([box("x", [text("y")]), box("y", [text("x")])]));
    expect(answer.sandbox.filter((entry) => entry.startsWith("definition."))).toEqual([]);
    expect(answer.inProcess).toEqual(answer.sandbox);
  });
});

describe("a tree written as JSON is cut where the sandbox's request limit would cut it", () => {
  const leaf = { kind: "path", path: "a" };
  const leftChain = (terms: number): unknown => {
    let node: unknown = leaf;
    for (let i = 0; i < terms; i += 1) {
      node = { kind: "logical", operator: "and", left: node, right: leaf };
    }
    return node;
  };
  const calls = (levels: number): unknown => {
    let node: unknown = { kind: "literal", value: 1 };
    for (let i = 0; i < levels; i += 1) {
      node = { kind: "call", name: "abs", args: [node] };
    }
    return { kind: "binary", operator: "eq", left: node, right: { kind: "literal", value: 1 } };
  };
  const nots = (levels: number): unknown => {
    let node: unknown = leaf;
    for (let i = 1; i < levels; i += 1) {
      node = { kind: "unary", operator: "not", operand: node };
    }
    return node;
  };
  const checkOf = async (tree: ComponentNode): Promise<{ sandbox: string; inProcess: string }> => {
    const request = { abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: tree } };
    const sandbox = (await host.inspect(request as never)) as { verdict: string; problems: Array<{ code: string }> };
    const inProcess = JSON.parse(new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi()).inspect!(stableStringify(request)) as string);
    const said = (answer: { verdict: string; problems: Array<{ code: string }> }): string => answer.verdict + " " + answer.problems.map((problem) => problem.code).join(",");
    return { sandbox: said(sandbox), inProcess: said(inProcess) };
  };

  it.each([
    ["calls 150 deep", calls(150)],
    ["210 levels of not", nots(210)]
  ])("%s, within the request limit but past the cap: check fails tooDeep and the run refuses typed, on both hosts", async (_name, tree) => {
    expect(await checkOf(form(tree))).toEqual({ sandbox: "fail tooDeep", inProcess: "fail tooDeep" });
    const answer = await both(form(tree));
    expect(answer.sandbox).toEqual(["formula.invalid:rules:b:visibleWhen"]);
    expect(answer.inProcess).toEqual(answer.sandbox);
  });

  it.each([
    ["a left chain of 400 terms", leftChain(400)],
    ["a left chain of 3,000 terms", leftChain(3000)],
    ["calls 250 deep", calls(250)]
  ])("%s, past the request limit: the sandbox refuses the request and in process check and the run refuse it too", async (_name, tree) => {
    const request = { abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: form(tree) } };
    const refused = (failure: unknown): string => (failure instanceof QuickJsExecutionError ? failure.code : "answered");
    expect(await host.inspect(request as never).then(() => "answered", refused)).toBe("request_refused");
    const context = { formId: "f", locale: "en", form: form(tree), values: { a: "x" } };
    expect(await host.run({ context: context as never, policy: WasmValidationHost.STRICT_POLICY }).then(() => "answered", refused)).toBe("request_refused");
    const instance = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());
    const checked = JSON.parse(instance.inspect!(stableStringify(request)) as string) as { verdict: string; problems: Array<{ code: string }> };
    expect(checked.verdict + " " + checked.problems.map((problem) => problem.code).join(",")).toBe("fail tooDeep");
    const ran = JSON.parse(instance.run(JSON.stringify(context)) as string) as { errors: Array<{ code: string }> };
    expect(ran.errors.map((error) => error.code)).toEqual(["formula.invalid"]);
  });

  it("a tree at the cap, on a field 32 components deep, reaches the sandbox and runs as in process", async () => {
    // 200: the compile's cap on a tree written as JSON (`kernelExpressionMaxDepth`).
    let deepest: Record<string, unknown> = { id: "b", type: "text", configuration: { required: true }, rules: { visibleWhen: { expression: nots(200), run: "both" } } };
    for (let level = 31; level >= 2; level -= 1) {
      deepest = { id: "c" + level, type: "container", configuration: {}, children: { content: [deepest] } };
    }
    const tree = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "a", type: "text", configuration: {} }, deepest] } } as unknown as ComponentNode;
    expect(await checkOf(tree)).toEqual({ sandbox: "ok ", inProcess: "ok " });
    const answer = await both(tree);
    expect(answer.sandbox.filter((entry) => entry.startsWith("formula.") || entry.startsWith("definition."))).toEqual([]);
    expect(answer.inProcess).toEqual(answer.sandbox);
  });
});

describe("a field pattern that does not compile, in the sandbox", () => {
  const tree = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "code", type: "text", configuration: { pattern: "(?i)abc" } }] } } as unknown as ComponentNode;

  it("check fails it and the run refuses a non-empty answer, as in process", async () => {
    const request = { abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: tree } };
    const sandbox = (await host.inspect(request as never)) as { verdict: string; structure: Array<{ code: string; where: string }> };
    expect(sandbox.verdict).toBe("fail");
    expect(sandbox.structure.map((entry) => entry.code + "@" + entry.where)).toEqual(["component.pattern.invalid@root > content > code"]);
    const context = { formId: "f", locale: "en", form: tree, values: { code: "abc" } };
    const run = await host.run({ context: context as never, policy: WasmValidationHost.STRICT_POLICY });
    expect(run.errors.map((error) => error.code + ":" + JSON.stringify(error.parameters))).toEqual(['pattern:{"invalid":true,"pattern":"(?i)abc"}']);
    const inProcess = JSON.parse(new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi()).run(JSON.stringify(context)) as string) as { errors: unknown[] };
    expect(inProcess.errors).toEqual(JSON.parse(JSON.stringify(run.errors)));
  });
});
