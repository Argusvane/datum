import { afterEach, describe, expect, it, vi } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { DataModelImporter } from "../form-engine/builder/data/data-model-import.js";
import { MAX_DATA_MODEL_INPUT } from "../form-engine/builder/data-model/read-input.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";

const form: ComponentDefinition = { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } };

/** A file input as the importer reads one: its `data-model-file` mark and a chosen file. */
const fileInput = (size: number, name = "big.json"): HTMLInputElement =>
  ({ hasAttribute: (attribute: string) => attribute === "data-model-file", files: [{ name, size }], value: "x" }) as unknown as HTMLInputElement;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the data model file import checks the size before reading", () => {
  it("says the file is too big and never opens a reader for it", () => {
    const reads: unknown[] = [];
    vi.stubGlobal("FileReader", class { public readAsText(file: unknown): void { reads.push(file); } });
    const said: string[] = [];
    const controller = new BuilderController({ initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } }, componentDefinitions: [form] });
    const importer = new DataModelImporter({
      controller: () => controller,
      canBuild: () => true,
      selectsRows: () => false,
      scope: () => undefined,
      paint: () => undefined,
      announce: (text) => said.push(text),
      built: () => undefined
    });
    // The cap counts characters; a UTF-8 character is at most 4 bytes, so only a file past that
    // many bytes cannot fit, and a file between the two is read and judged by its characters.
    const big = fileInput(MAX_DATA_MODEL_INPUT * 4 + 1);
    expect(importer.change(big)).toBe(true);
    expect(reads).toEqual([]);
    expect(said.at(-1)).toMatch(/up to 2 MB is read/);
    expect(big.value).toBe("");
    // A file within the cap is read, and so is one whose bytes pass the character cap (accents, CJK).
    expect(importer.change(fileInput(MAX_DATA_MODEL_INPUT))).toBe(true);
    expect(importer.change(fileInput(MAX_DATA_MODEL_INPUT + 1))).toBe(true);
    expect(reads).toHaveLength(2);
  });
});
