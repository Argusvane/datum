import { describe, expect, it } from "vitest";

import { BuilderWords } from "../form-engine/builder/logic/builder-texts.js";
import {
  dataModelFromJsonSchema,
  dataModelFromSample,
  detectDataModelSource,
  indexDataModel,
  patternForForm,
  readDataModelInput,
  jsonErrorOffset,
  MAX_DATA_MODEL_INPUT,
  MAX_SCHEMA_NODES,
  type DataModel
} from "../form-engine/builder/data-model/index.js";

const at = (model: DataModel, path: string) => indexDataModel(model).get(path);

describe("reading a JSON sample", () => {
  const sample = {
    name: "Ada",
    email: "ada@example.com",
    site: "https://example.com",
    born: "1815-12-10",
    updated: "2026-01-31T09:30:00Z",
    bio: "Line one\nLine two",
    age: 36,
    active: true,
    nickname: null,
    tags: ["math", "engines"],
    address: { street: "1 Main", city: "London" },
    items: [
      { sku: "A1", qty: 2 },
      { sku: "B2", qty: 5, note: "fragile" },
      { sku: "C3", qty: null }
    ],
    empty: [],
    odd: [1, "two"],
    scan: { storage: "base64", name: "scan.pdf", type: "application/pdf", size: 10, data: "" },
    "first name": "Ada",
    "first_name": "A."
  };

  it("reads the kind and format each value shows", () => {
    const model = dataModelFromSample(sample);
    expect(model.source).toBe("sample");
    expect(at(model, "name")).toMatchObject({ kind: "string" });
    expect(at(model, "name")!.format).toBeUndefined();
    expect(at(model, "email")).toMatchObject({ kind: "string", format: "email" });
    expect(at(model, "site")).toMatchObject({ kind: "string", format: "uri" });
    expect(at(model, "born")).toMatchObject({ kind: "string", format: "date" });
    expect(at(model, "updated")).toMatchObject({ kind: "string", format: "date-time" });
    expect(at(model, "bio")).toMatchObject({ kind: "string", format: "multiline" });
    expect(at(model, "age")).toMatchObject({ kind: "number" });
    expect(at(model, "active")).toMatchObject({ kind: "boolean" });
    expect(at(model, "nickname")).toMatchObject({ kind: "null" });
    expect(at(model, "tags")).toMatchObject({ kind: "array", items: { kind: "string" } });
    expect(at(model, "address.city")).toMatchObject({ kind: "string" });
    expect(at(model, "scan")).toMatchObject({ kind: "file" });
    // A sample never says what is required.
    expect([...indexDataModel(model).values()].some((node) => node.required)).toBe(false);
  });

  it("merges every entry of a list: keys any entry has, null making a kind nullable", () => {
    const model = dataModelFromSample(sample);
    expect(at(model, "items[]")!.children!.map((child) => child.key)).toEqual(["sku", "qty", "note"]);
    expect(at(model, "items[].qty")).toMatchObject({ kind: "number", nullable: true });
    expect(at(model, "empty")!.notes?.[0]?.code).toBe("empty-list");
    expect(at(model, "odd[]")).toMatchObject({ kind: "unknown" });
    expect(at(model, "odd[]")!.notes?.[0]?.message).toContain("number, string");
  });

  it("makes keys usable and unique, keeping what the sample called them", () => {
    const model = dataModelFromSample(sample);
    expect(at(model, "first_name")).toMatchObject({ sourceKey: "first name" });
    expect(at(model, "first_name_2")).toMatchObject({ sourceKey: "first_name" });
  });

  it("wants only agreeing formats, and ignores empty values when they agree", () => {
    const model = dataModelFromSample({ list: [{ when: "2026-01-01" }, { when: "" }, { when: "2026-02-02" }], mixed: [{ at: "2026-01-01" }, { at: "soon" }] });
    expect(at(model, "list[].when")!.format).toBe("date");
    expect(at(model, "mixed[].at")!.format).toBeUndefined();
  });

  it("refuses anything but an object at the top", () => {
    expect(() => dataModelFromSample([1, 2])).toThrow(/object at the top/);
    expect(() => dataModelFromSample("text")).toThrow(/object at the top/);
  });
});

describe("reading a JSON Schema", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Applicant",
    type: "object",
    required: ["name", "status"],
    properties: {
      name: { type: "string", title: "Full name", minLength: 2, maxLength: 60, pattern: "^[A-Za-z ]+$" },
      status: { enum: ["new", "in_progress", "done"] },
      priority: { oneOf: [{ const: 1, title: "Low" }, { const: 2, title: "High" }] },
      nickname: { type: ["string", "null"] },
      maybe: { anyOf: [{ type: "integer", minimum: 1, maximum: 9 }, { type: "null" }] },
      born: { type: "string", format: "date" },
      home: { $ref: "#/$defs/address" },
      work: { $ref: "#/$defs/address", description: "Where you work" },
      both: { allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "boolean" } } }] },
      tags: { type: "array", items: { enum: ["red", "blue"] }, minItems: 1 },
      node: { $ref: "#/$defs/tree" },
      scan: { type: "string", contentEncoding: "base64" },
      attachment: { $ref: "#/$defs/attachment" },
      legacy: { type: "string", nullable: true },
      point: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] },
      flag: { type: "boolean", not: { const: false } },
      "first name": { type: "string" }
    },
    $defs: {
      address: { type: "object", properties: { street: { type: "string" }, city: { type: "string" } }, required: ["city"] },
      tree: { type: "object", properties: { label: { type: "string" }, child: { $ref: "#/$defs/tree" } } },
      attachment: { type: "object", properties: { storage: { type: "string" }, name: { type: "string" }, type: { type: "string" }, size: { type: "number" } } }
    }
  };

  it("reads types, required, titles, bounds and formats", () => {
    const model = dataModelFromJsonSchema(schema);
    expect(model.source).toBe("schema");
    expect(model.title).toBe("Applicant");
    expect(at(model, "name")).toMatchObject({ kind: "string", required: true, label: "Full name", minLength: 2, maxLength: 60, pattern: "[A-Za-z ]+" });
    expect(at(model, "nickname")).toMatchObject({ kind: "string", nullable: true });
    expect(at(model, "maybe")).toMatchObject({ kind: "integer", nullable: true, minimum: 1, maximum: 9 });
    expect(at(model, "born")).toMatchObject({ kind: "string", format: "date" });
    expect(at(model, "legacy")).toMatchObject({ kind: "string", nullable: true });
  });

  it("reads choices from enum and from a oneOf of consts, titles as labels", () => {
    const model = dataModelFromJsonSchema(schema);
    expect(at(model, "status")).toMatchObject({ kind: "string", required: true, options: [{ value: "new" }, { value: "in_progress" }, { value: "done" }] });
    expect(at(model, "priority")).toMatchObject({ kind: "integer", options: [{ value: "1", label: "Low" }, { value: "2", label: "High" }] });
    expect(at(model, "tags")).toMatchObject({ kind: "array", minItems: 1, items: { kind: "string", options: [{ value: "red" }, { value: "blue" }] } });
  });

  it("follows local references with their siblings, folds allOf, and stops at a cycle", () => {
    const model = dataModelFromJsonSchema(schema);
    expect(at(model, "home.city")).toMatchObject({ kind: "string", required: true });
    expect(at(model, "work")).toMatchObject({ kind: "object", description: "Where you work" });
    expect(at(model, "both.a")).toMatchObject({ kind: "string", required: true });
    expect(at(model, "both.b")).toMatchObject({ kind: "boolean" });
    expect(at(model, "node.label")).toMatchObject({ kind: "string" });
    expect(at(model, "node.child")).toMatchObject({ kind: "unknown" });
    expect(at(model, "node.child")!.notes?.[0]?.code).toBe("recursive");
  });

  it("reads files, and says what a form cannot hold", () => {
    const model = dataModelFromJsonSchema(schema);
    expect(at(model, "scan")).toMatchObject({ kind: "file" });
    expect(at(model, "scan")!.notes?.[0]?.code).toBe("base64-file");
    expect(at(model, "attachment")).toMatchObject({ kind: "file" });
    expect(at(model, "point")!.notes?.[0]?.code).toBe("tuple");
    expect(at(model, "first_name")).toMatchObject({ sourceKey: "first name" });
    expect(model.notes).toEqual([{ code: "ignored-keywords", level: "info", message: "Not read, as a form has nothing to hold them: not." }]);
  });

  it("refuses a schema that is not an object at the top", () => {
    expect(() => dataModelFromJsonSchema({ type: "string" })).toThrow(/object at the top/);
    expect(() => dataModelFromJsonSchema([])).toThrow(/must be an object/);
  });

  it("converts a pattern to the whole-answer reading the form uses", () => {
    expect(patternForForm("^[a-z]+$")).toEqual({ pattern: "[a-z]+" });
    expect(patternForForm("^(?:[a-z]+)$")).toEqual({ pattern: "[a-z]+" });
    expect(patternForForm("abc")).toEqual({ pattern: "[\\s\\S]*(?:abc)[\\s\\S]*" });
    expect(patternForForm("^abc")).toEqual({ pattern: "(?:abc)[\\s\\S]*" });
    // Anchors bind to the first and last branch only: starts with a, or ends with b.
    expect(patternForForm("^a|b$")).toEqual({ pattern: "(?:a)[\\s\\S]*|[\\s\\S]*(?:b)" });
    expect(patternForForm("^a$|^b$")).toEqual({ pattern: "a|b" });
    expect(patternForForm("a|(b|c)")).toEqual({ pattern: "[\\s\\S]*(?:a)[\\s\\S]*|[\\s\\S]*(?:(b|c))[\\s\\S]*" });
    // The form's reading accepts and refuses what the schema's does.
    for (const [schemaPattern, answers] of [
      ["^a|b$", ["axyz", "xyzb", "xbx", "ab"]],
      ["^a|b", ["axyz", "xbz", "xyz"]],
      ["x|^y$|z$", ["axb", "y", "ya", "az", "za"]]
    ] as const) {
      const form = new RegExp(`^(?:${patternForForm(schemaPattern).pattern})$`, "u");
      for (const answer of answers) {
        expect(form.test(answer), `${schemaPattern} on ${answer}`).toBe(new RegExp(schemaPattern, "u").test(answer));
      }
    }
    // Valid for a schema, but not under the Unicode mode the form compiles patterns in.
    expect(patternForForm("^\\a+$").note?.code).toBe("pattern-unusable");
    expect(patternForForm("^\\a+$").pattern).toBeUndefined();
  });
});

describe("reading pasted text", () => {
  it("tells a schema from a sample", () => {
    expect(detectDataModelSource({ $schema: "x" })).toBe("schema");
    expect(detectDataModelSource({ type: "object", properties: {} })).toBe("schema");
    expect(detectDataModelSource({ properties: { a: { type: "string" } } })).toBe("schema");
    expect(detectDataModelSource({ type: "person", properties: { a: 1 } })).toBe("sample");
    expect(detectDataModelSource({ name: "Ada" })).toBe("sample");
  });

  it("reads as detected, or as told", () => {
    const schemaText = JSON.stringify({ type: "object", properties: { a: { type: "string" } } });
    const auto = readDataModelInput(schemaText);
    expect(auto).toMatchObject({ ok: true, readAs: "schema", detected: "schema" });
    const forced = readDataModelInput(schemaText, "sample");
    expect(forced).toMatchObject({ ok: true, readAs: "sample", detected: "schema" });
    if (forced.ok) {
      expect(indexDataModel(forced.model).get("properties.a.type")).toMatchObject({ kind: "string" });
    }
  });

  it("says where JSON goes wrong, and why a read failed", () => {
    expect(readDataModelInput("   ")).toEqual({ ok: false, empty: true });
    const broken = readDataModelInput('{\n  "a": 1,\n  "b": \n}');
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.error).toMatch(/not valid JSON/);
      expect(broken.line).toBe(4);
      expect(broken.column).toBeGreaterThanOrEqual(1);
    }
    expect(readDataModelInput("[1]")).toMatchObject({ ok: false, error: expect.stringMatching(/object at the top/) });
    expect(readDataModelInput(" ".repeat(MAX_DATA_MODEL_INPUT + 1) + "{}")).toMatchObject({ ok: false, error: expect.stringMatching(/MB is read/) });
  });

  it("words its read failures in the builder's catalog, English when the catalog says nothing", () => {
    const words = new BuilderWords();
    words.locale = "fr";
    words.catalog = { fr: { "dataModel.input.notJson": "Ce n'est pas du JSON valide : {message}" } };
    const broken = readDataModelInput('{\n  "a": 1,\n  "b": \n}', "auto", words);
    expect(broken).toMatchObject({ ok: false, line: 4, error: expect.stringMatching(/^Ce n'est pas du JSON valide : /) });
    expect(readDataModelInput("[1]", "auto", words)).toMatchObject({ ok: false, error: expect.stringMatching(/object at the top/) });
  });

  it("finds where JSON stops being JSON whatever the engine's message says", () => {
    expect(jsonErrorOffset('{"a": 1}')).toBeUndefined();
    expect(jsonErrorOffset('{"a": tru}')).toBe(6);
    expect(jsonErrorOffset('{"a": 1,}')).toBe(8);
    expect(jsonErrorOffset("[1, 2")).toBe(5);
    expect(jsonErrorOffset('{"a": 1} x')).toBe(9);
    expect(jsonErrorOffset("")).toBe(0);
  });

  it("notes a form definition pasted by mistake", () => {
    const read = readDataModelInput(JSON.stringify({ id: "f", root: { id: "root", type: "form", configuration: {} } }));
    expect(read.ok && read.model.notes[0]?.code).toBe("form-definition");
    // It names the control that opens it as a form: the bar's Open.
    expect(read.ok && read.model.notes[0]?.message).toContain("Open on the builder's bar");
  });
});

describe("a schema whose shared $refs fan out", () => {
  const fan = (levels: number): string => {
    const defs: Record<string, unknown> = {};
    for (let i = 0; i < levels; i += 1) {
      const next = { $ref: `#/$defs/d${i + 1}` };
      defs[`d${i}`] = { type: "object", properties: { a: next, b: next } };
    }
    defs[`d${levels}`] = { type: "string" };
    return JSON.stringify({ $schema: "x", $defs: defs, $ref: "#/$defs/d0" });
  };

  it("a moderate diamond still reads", () => {
    expect(readDataModelInput(fan(8), "schema").ok).toBe(true);
  });

  it("an exponential diamond is refused with a clear error, quickly, never expanded", () => {
    const started = Date.now();
    const out = readDataModelInput(fan(30), "schema");
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain(`${MAX_SCHEMA_NODES.toLocaleString("en-US")} places`);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
