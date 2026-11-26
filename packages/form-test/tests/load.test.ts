import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { InputError, loadDefinitionFile, loadProgramFile, loadTestFile, sidecarPathOf, titleOf } from "../src/load.js";
import { workFolder } from "./helpers/io.js";
import { fixture } from "./helpers/paths.js";

const work = workFolder("datum-form-test-load-");
const FORM = JSON.stringify({ id: "f", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: { label: "A form" }, children: [] } });

describe("loading inputs", () => {
  it("names the sidecar after the definition's stem", () => {
    expect(sidecarPathOf("forms/intake.json")).toBe("forms/intake.datum-test");
    expect(sidecarPathOf("forms/intake.v2.json")).toBe("forms/intake.v2.datum-test");
    expect(sidecarPathOf("forms/intake")).toBe("forms/intake.datum-test");
  });

  it("reads the sidecar when it exists", () => {
    const input = loadDefinitionFile(fixture("main.json"));
    expect(input.path).toBe(fixture("main.json"));
    expect(input.definition.root).toBeTypeOf("object");
    expect(input.sources.map((source) => source.path)).toEqual([fixture("main.datum-test")]);
    expect(input.sources[0]?.text).toContain('test "');
  });

  it("reads no sidecar when there is none", () => {
    expect(loadDefinitionFile(fixture("clock.json")).sources).toEqual([]);
    const lone = work.file("lone.json", FORM);
    expect(loadDefinitionFile(lone).sources).toEqual([]);
  });

  it("ignores a folder where the sidecar would be", () => {
    const definition = work.file("folder.json", FORM);
    mkdirSync(join(work.dir, "folder.datum-test"), { recursive: true });
    expect(loadDefinitionFile(definition).sources).toEqual([]);
  });

  it.each<[string, string, RegExp]>([
    ["bad.json", "{ not json", /bad\.json is not JSON/],
    ["array.json", "[]", /array\.json is not a form definition: it is not a JSON object/],
    ["noroot.json", JSON.stringify({ id: "f" }), /noroot\.json is not a form definition: it has no "root"/],
    ["rootstring.json", JSON.stringify({ id: "f", root: "x" }), /rootstring\.json is not a form definition/]
  ])("refuses %s", (name, text, message) => {
    const path = work.file(name, text);
    expect(() => loadDefinitionFile(path)).toThrow(InputError);
    expect(() => loadDefinitionFile(path)).toThrow(message);
  });

  it("refuses a definition, test file or program that cannot be read", () => {
    expect(() => loadDefinitionFile(join(work.dir, "missing.json"))).toThrow(/cannot read the definition .*missing\.json: no such file/);
    expect(() => loadDefinitionFile(work.dir)).toThrow(/it is a folder/);
    expect(() => loadTestFile(join(work.dir, "missing.datum-test"))).toThrow(InputError);
    expect(() => loadProgramFile(join(work.dir, "missing.js"))).toThrow(/cannot read the sandbox program/);
  });

  it("refuses an empty program and keeps a real one's text", () => {
    expect(() => loadProgramFile(work.file("empty.js", "  \n"))).toThrow(/is empty/);
    const program = work.file("program.js", "var x = 1;\n");
    expect(loadProgramFile(program)).toEqual({ path: program, text: "var x = 1;\n" });
  });

  it("reads the form's title from the root label or the metadata", () => {
    const root = { id: "root", type: "form" };
    expect(titleOf({ root: { ...root, configuration: { label: "Plain" } } } as never)).toBe("Plain");
    expect(titleOf({ root, metadata: { name: "From metadata" } } as never)).toBe("From metadata");
    expect(titleOf({ title: "Stored title", root: { ...root, configuration: { label: "Plain" } } } as never)).toBe("Stored title");
    expect(titleOf({ root } as never)).toBeUndefined();
  });
});
