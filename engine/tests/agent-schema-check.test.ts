import { describe, expect, it } from "vitest";
import { checkInput } from "../form-engine/agent/schema-check.js";

/**
 * The registrar's schema-subset check. Chrome validates nothing
 * against inputSchema, so every keyword the catalogues may use must be enforced
 * here, unknown keys must be dropped (not refused) and open objects must be left alone.
 */
const schema = {
  type: "object",
  properties: {
    field: { type: "string", maxLength: 10, description: "a path" },
    count: { type: "integer", minimum: 1, maximum: 5, description: "a count" },
    ratio: { type: "number", description: "a ratio" },
    flag: { type: "boolean", description: "a flag" },
    mode: { type: "string", enum: ["page", "form"], description: "a scope" },
    paths: { type: "array", items: { type: "string", maxLength: 4 }, description: "paths" },
    answers: { type: "object", description: "open: values keyed by path" },
    options: {
      type: "object",
      properties: { reveal: { type: "boolean", description: "reveal" } },
      required: ["reveal"],
      description: "closed"
    }
  },
  required: ["field"]
};

describe("checkInput: shape", () => {
  it("refuses a non-object input with one problem keyed by the empty string", () => {
    for (const input of [undefined, null, "text", 4, true, ["a"]]) {
      const checked = checkInput(schema, input);
      expect(checked.problems).toEqual([{ key: "", expected: "a JSON object" }]);
      expect(checked.input).toEqual({});
      expect(checked.ignoredKeys).toEqual([]);
    }
  });

  it("passes a valid input through untouched", () => {
    const input = { field: "a.b", count: 3, ratio: 0.5, flag: true, mode: "page", paths: ["x", "y"] };
    const checked = checkInput(schema, input);
    expect(checked.problems).toEqual([]);
    expect(checked.input).toEqual(input);
    expect(checked.ignoredKeys).toEqual([]);
  });

  it("drops unknown top-level keys and names them instead of refusing", () => {
    const checked = checkInput(schema, { field: "a", expectedRevison: 3, extra: null });
    expect(checked.problems).toEqual([]);
    expect(checked.input).toEqual({ field: "a" });
    expect(checked.ignoredKeys).toEqual(["expectedRevison", "extra"]);
  });
});

describe("checkInput: keywords", () => {
  it("reports a missing required key", () => {
    expect(checkInput(schema, {}).problems).toEqual([{ key: "field", expected: "required" }]);
  });

  it("checks every type of the subset", () => {
    const checked = checkInput(schema, { field: 1, count: 1.5, ratio: "x", flag: "yes", paths: "a", answers: [] });
    expect(checked.problems).toEqual([
      { key: "field", expected: "a string" },
      { key: "count", expected: "an integer" },
      { key: "ratio", expected: "a number" },
      { key: "flag", expected: "a boolean" },
      { key: "paths", expected: "an array" },
      { key: "answers", expected: "a JSON object" }
    ]);
  });

  it("treats null as the wrong type, not as absent", () => {
    expect(checkInput(schema, { field: null }).problems).toEqual([{ key: "field", expected: "a string" }]);
  });

  it("checks enum, integer bounds and string caps", () => {
    const checked = checkInput(schema, { field: "0123456789A", count: 9, mode: "steps" });
    expect(checked.problems).toEqual([
      { key: "field", expected: "at most 10 characters" },
      { key: "count", expected: "at most 5" },
      { key: "mode", expected: "one of: page, form" }
    ]);
    expect(checkInput(schema, { field: "a", count: 0 }).problems).toEqual([{ key: "count", expected: "at least 1" }]);
  });

  it("checks items.type and item caps per array entry", () => {
    const checked = checkInput(schema, { field: "a", paths: ["ok", 2, "too-long"] });
    expect(checked.problems).toEqual([
      { key: "paths[1]", expected: "a string" },
      { key: "paths[2]", expected: "at most 4 characters" }
    ]);
  });

  it("leaves the inside of an open object to the catalogue", () => {
    const answers = { "trip.city": 5, nested: { anything: [1, "x", null] } };
    const checked = checkInput(schema, { field: "a", answers });
    expect(checked.problems).toEqual([]);
    expect(checked.input.answers).toEqual(answers);
  });

  it("checks a closed nested object's listed properties and required keys", () => {
    expect(checkInput(schema, { field: "a", options: {} }).problems).toEqual([{ key: "options.reveal", expected: "required" }]);
    expect(checkInput(schema, { field: "a", options: { reveal: "no" } }).problems).toEqual([
      { key: "options.reveal", expected: "a boolean" }
    ]);
    expect(checkInput(schema, { field: "a", options: { reveal: true, extra: 1 } }).problems).toEqual([]);
  });

  it("collects every problem at once", () => {
    const checked = checkInput(schema, { count: "3", mode: "x", bogus: 1 });
    expect(checked.problems.map((problem) => problem.key)).toEqual(["field", "count", "mode"]);
    expect(checked.ignoredKeys).toEqual(["bogus"]);
  });

  it("accepts a schema without properties as fully open at the top level", () => {
    const checked = checkInput({ type: "object" }, { anything: 1 });
    expect(checked.problems).toEqual([]);
    expect(checked.input).toEqual({});
    expect(checked.ignoredKeys).toEqual(["anything"]);
  });
});
