import { describe, expect, it } from "vitest";

import { WasmValidationHost, type ComponentNode } from "@argusvane/datum-engine";

import { createQuickJsValidationHost } from "../src/index.js";
import { SLOW_FACTOR } from "./slow-machine.js";

// More kernel hardening on the real QuickJS program: what
// engine/tests/kernel-data-key-and-text-caps.test.ts asserts in-process, asserted where the program runs.
// A columns-shape grid is normalized first, so a cell's error names the field
// inside the row, and a choice in a row is reported as a section's field (index-free path, keys).

const form = (children: unknown[], configuration: Record<string, unknown> = {}): ComponentNode =>
  ({ id: "form", type: "form", configuration, children: { content: children } }) as unknown as ComponentNode;
const optionSnapshot = { restricted: [{ value: "ok", label: "Ok" }], s: [{ value: "1" }, { value: "2" }] };

async function runWith(host: WasmValidationHost, root: ComponentNode, values: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return host.run({ context: { formId: "f", values, locale: "en", form: root, optionSnapshot, ...extra } as never, policy: WasmValidationHost.STRICT_POLICY });
}

describe("the QuickJS program, kernel hardening, part two", async () => {
  const host = await createQuickJsValidationHost([]);
  // A roomier deadline for the tests that post thousands of rows or megabytes of text (the default one scales with the request and is tight under load).
  const roomy = await createQuickJsValidationHost([], { maxEvalMs: 8000 });

  it("a select sharing its data key with a number or a container is still held to its options; a text may share", async () => {
    const select = { id: "s", type: "select", configuration: { dataKey: "x", data: { sourceId: "restricted" } } };
    for (const type of ["number", "container"]) {
      const out = await runWith(host, form([{ id: "t", type, configuration: { dataKey: "x" } }, select]), { x: "evil" });
      expect(out.errors.map((e) => e.code), type).toContain("option.notAllowed");
    }
    const withText = await runWith(host, form([{ id: "t", type: "text", configuration: { dataKey: "x" } }, select]), { x: "evil" });
    expect(withText.errors).toEqual([]);
  });

  it("a plugin type's answer holding a nested object is refused", async () => {
    const root = form([{ id: "r", type: "rating", configuration: { data: { sourceId: "s" } } }]);
    expect((await runWith(host, root, { r: ["1", { evil: { deeper: [1, 2, 3] } }] })).errors.map((e) => e.code)).toEqual(["option.notAllowed"]);
    expect((await runWith(host, root, { r: { a: { x: 1 } } })).errors.map((e) => e.code)).toEqual(["option.notAllowed"]);
    expect((await runWith(host, root, { r: ["1", 2] })).errors).toEqual([]);
  });

  it("a data grid's cells are held to their column's constraints", async () => {
    const grid = {
      id: "g",
      type: "dataGrid",
      configuration: {},
      collection: { collectionPath: "orders" },
      children: {
        content: [
          { id: "c1", type: "text", configuration: { required: true, maxLength: 3, dataKey: "name" } },
          { id: "c2", type: "file", configuration: { maxFileSizeMb: 1, accept: ".pdf", dataKey: "doc" } }
        ]
      }
    };
    const out = await runWith(host, form([grid]), {
      "orders[0].name": "far-too-long",
      "orders[1].doc": { storage: "s", name: "a.exe", type: "x/y", size: 100 }
    });
    expect(out.errors.map((e) => [e.code, e.componentId, (e as { path?: string }).path])).toEqual([
      ["maxLength", "c1", "orders[0].name"],
      ["required", "c1", "orders[1].name"],
      ["fileType", "c2", "orders[1].doc"]
    ]);
  });

  // 3.5M astral characters run out of memory whatever the cap does; 2M settles, so the warning proves the cap.
  it("a long answer through text functions is read by its first 10,000 characters, with a text.truncated warning", async () => {
    const calls = ["substring(a, 1, 5)", "trim(a)", "startsWith(a, \"x\")", "endsWith(a, \"x\")", "padStart(a, 3, \"-\")", "text(a)", "upper(a)", "lower(a)", "contains(a, \"x\")"];
    const rules = calls.map((call, i) => ({ id: "r" + i, type: "text", configuration: {}, rules: { validWhen: "len(" + call + ") >= 0" } }));
    const root = form([{ id: "a", type: "text", configuration: {} }, ...rules], { formulaErrors: "warn" });
    const started = Date.now();
    const out = await runWith(roomy, root, { a: "\u{1F600}".repeat(2_000_000), ...Object.fromEntries(calls.map((_, i) => ["r" + i, "v"])) }, { optionSnapshot: undefined, logLevel: "warn" });
    expect(Date.now() - started).toBeLessThan(8000 * SLOW_FACTOR);
    const lines = (out.logs ?? []).map((l) => l.message);
    expect(lines.some((l) => /out of memory|interrupted/.test(l))).toBe(false);
    for (const name of ["substring", "trim", "startsWith", "endsWith", "padStart", "text", "upper", "lower", "contains"]) {
      expect(lines.some((l) => l.includes(name + ": the text is over the 10,000 character cap; its first 10,000 characters were used (text.truncated)")), name).toBe(true);
    }
  }, 60000);

  it("more data grid cells: an empty row is a row, a select in a row lists the cells it refused, the error list is capped", async () => {
    const grid = {
      id: "g",
      type: "dataGrid",
      configuration: {},
      collection: { collectionPath: "orders" },
      children: {
        content: [
          { id: "c1", type: "text", configuration: { required: true, dataKey: "name" } },
          { id: "c2", type: "select", configuration: { options: [{ value: "a", label: "A" }], dataKey: "pick" } }
        ]
      }
    };
    const root = form([grid]);
    const rows = await runWith(host, root, { orders: [{ name: "x", pick: "zzz" }, {}] }, { optionSnapshot: undefined });
    expect(rows.errors.map((e) => [e.code, e.path, e.parameters?.keys])).toEqual([
      ["option.notAllowed", "orders.pick", ["orders[0].pick"]],
      ["required", "orders[1].name", undefined]
    ]);
    // Rows past the row cap (500) are refused as a whole, so the 10,000 come from a wide grid at the cap.
    const wide = form([
      { ...grid, children: { content: Array.from({ length: 25 }, (_, at) => ({ id: `c${at}`, type: "text", configuration: { required: true, dataKey: `name${at}` } })) } }
    ]);
    const many = await runWith(roomy, wide, { orders: Array.from({ length: 500 }, () => ({})) }, { optionSnapshot: undefined });
    expect(many.errors).toHaveLength(10001);
    expect(many.errors[10000]).toMatchObject({ code: "errors.truncated", parameters: { shown: 10000 } });
  });

  it("line-wrapped base64 with an exact size is not a size lie", async () => {
    const root = form([{ id: "doc", type: "file", configuration: {} }]);
    const bytes = 400 * 1024;
    const plain = Buffer.alloc(bytes, 7).toString("base64");
    const data = (plain.match(/.{1,76}/g) ?? []).join("\n");
    const ok = await runWith(host, root, { doc: { storage: "base64", name: "a.bin", type: "application/octet-stream", size: bytes, data } }, { optionSnapshot: undefined });
    expect(ok.errors).toEqual([]);
    const lie = await runWith(host, root, { doc: { storage: "base64", name: "a.bin", type: "application/octet-stream", size: 100, data } }, { optionSnapshot: undefined });
    expect(lie.errors.map((e) => e.code)).toEqual(["file.sizeMismatch"]);
  });
});
