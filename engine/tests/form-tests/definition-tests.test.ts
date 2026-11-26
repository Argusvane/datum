import { describe, expect, it } from "vitest";

import { publicDefinition } from "../../form-engine/core/expressions/compile.js";
import { readFormTests } from "../../form-engine/core/form-tests/form-test-read.js";
import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";

// `FormDefinition.tests`: read tolerantly like `readJourneys`, and
// dropped from the copy a host serves to a browser.

describe("readFormTests", () => {
  const read = (tests: unknown) => readFormTests({ tests });

  it("reads the entries of a well-formed block, id and source only", () => {
    expect(
      read({
        scenarios: [
          { id: "t1", source: 'test "a"\nset x = 1' },
          { id: "t2", source: "", extra: true }
        ]
      })
    ).toEqual([
      { id: "t1", source: 'test "a"\nset x = 1' },
      { id: "t2", source: "" }
    ]);
  });

  it("is empty when the definition, the block or the list is missing or malformed", () => {
    expect(readFormTests(undefined)).toEqual([]);
    expect(readFormTests({})).toEqual([]);
    for (const tests of [null, 5, "tests", [], [{ id: "a", source: "b" }], {}, { scenarios: null }, { scenarios: "x" }, { scenarios: { id: "a", source: "b" } }]) {
      expect(read(tests), JSON.stringify(tests)).toEqual([]);
    }
  });

  it("drops an entry without a string id or a string source", () => {
    expect(
      read({
        scenarios: [
          null,
          "text",
          5,
          [],
          {},
          { id: "a" },
          { source: "x" },
          { id: 1, source: "x" },
          { id: "b", source: 2 },
          { id: "", source: "x" },
          { id: "ok", source: "x" }
        ]
      })
    ).toEqual([{ id: "ok", source: "x" }]);
  });

  it("keeps the first of two entries with one id", () => {
    expect(
      read({
        scenarios: [
          { id: "a", source: "first" },
          { id: "b", source: "other" },
          { id: "a", source: "second" }
        ]
      })
    ).toEqual([
      { id: "a", source: "first" },
      { id: "b", source: "other" }
    ]);
  });

  it("treats ids such as constructor and __proto__ as any other", () => {
    const json = '{"scenarios":[{"id":"__proto__","source":"a"},{"id":"constructor","source":"b"},{"id":"toString","source":"c"},{"id":"__proto__","source":"d"}]}';
    expect(read(JSON.parse(json)).map((e) => `${e.id}=${e.source}`)).toEqual(["__proto__=a", "constructor=b", "toString=c"]);
  });

  it("returns copies, so editing the result never edits the definition", () => {
    const stored = { scenarios: [{ id: "a", source: "x" }] };
    const entries = readFormTests({ tests: stored });
    entries[0]!.source = "changed";
    expect(stored.scenarios[0]!.source).toBe("x");
  });
});

describe("publicDefinition and tests", () => {
  const root = (): ComponentNode =>
    ({
      id: "root",
      type: "form",
      configuration: {},
      rules: { visibleWhen: { formula: "secret", run: "server-secret" } },
      children: { default: [{ id: "name", type: "text-input", configuration: { label: "Name" } }] }
    }) as unknown as ComponentNode;

  const definition = (): FormDefinition =>
    ({
      id: "f",
      version: "1",
      schemaVersion: "1",
      root: root(),
      journey: { journeys: [] },
      pdf: { layouts: [] },
      tests: { scenarios: [{ id: "t1", source: 'test "a"\nexpect accepted' }] }
    }) as unknown as FormDefinition;

  it("leaves no tests key on the public copy", () => {
    const served = publicDefinition(definition());
    expect("tests" in served).toBe(false);
    expect(JSON.stringify(served)).not.toContain("expect accepted");
  });

  it("leaves root, journey and pdf as it does for a definition without tests", () => {
    const withTests = definition();
    const without = definition();
    delete (without as { tests?: unknown }).tests;
    const before = JSON.stringify(withTests);
    const served = publicDefinition(withTests);
    // The author's object is never changed: hosts hash it.
    expect(JSON.stringify(withTests)).toBe(before);
    expect(withTests.tests).toBeDefined();
    const reference = publicDefinition(without);
    expect(served).toEqual(reference);
    expect(served.root.rules).toEqual({});
    expect(served.journey).toEqual(withTests.journey);
    expect(served.pdf).toEqual(withTests.pdf);
  });

  it("copes with a definition that has no tests", () => {
    const plain = definition();
    delete (plain as { tests?: unknown }).tests;
    expect("tests" in publicDefinition(plain)).toBe(false);
  });
});
