// @vitest-environment jsdom
/**
 * Regression tests for the builder loading untrusted JSON: the files and
 * clipboards another author can hand to the builder are capped and shaped before they are drawn.
 */
import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { readDataModelInput } from "../form-engine/builder/data-model/read-input.js";
import { BUILDER_DRAG_MIME_TYPE, MAX_DRAG_PAYLOAD_LENGTH, deserializeDragPayload } from "../form-engine/builder/drag-drop/html5-drag-drop.js";
import { BuilderWords } from "../form-engine/builder/logic/builder-texts.js";
import { parseSimulatedOptions } from "../form-engine/builder/controller/simulated-options.js";
import { parseValidationMessageCatalog } from "../form-engine/core/localization/validation-messages.js";
import { setPathValue } from "../form-engine/core/localization/locale-documents.js";
import { kernelStructureLimits } from "../form-engine/core/expressions/definition-structure.js";
import { MAX_IMPORTED_OPTIONS } from "../form-engine/core/schema/inline-options.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";

describe("a data-model sample is held to the schema reader's place cap", () => {
  it("refuses a sample describing more than 10,000 places, with a message", () => {
    const body = Array.from({ length: 10_050 }, (_, i) => `"k${i}":1`).join(",");
    const read = readDataModelInput(`{${body}}`, "sample");
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.error).toMatch(/10,000 places/);
  });
  it("reads an ordinary sample", () => {
    expect(readDataModelInput(`{"name":"Ada","tags":["a","b"]}`, "sample").ok).toBe(true);
  });
});

describe("a __proto__ code is an entry, not a prototype", () => {
  it("parseValidationMessageCatalog keeps it as an own key and does not change the prototype", () => {
    const catalog = parseValidationMessageCatalog(JSON.parse(`{"required":"Req","__proto__":{"default":"phantom"}}`)) as Record<string, unknown>;
    expect(Object.keys(catalog).sort()).toEqual(["__proto__", "required"]);
    expect((catalog as { default?: unknown }).default).toBeUndefined();
  });
});

describe("setPathValue refuses prototype-named segments", () => {
  it("writes nothing through __proto__, constructor or prototype", () => {
    const target: Record<string, unknown> = {};
    setPathValue(target, "__proto__.polluted", 1);
    setPathValue(target, "a.constructor.prototype.polluted", 1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(target).toEqual({});
    setPathValue(target, "a.b", 2);
    expect(target).toEqual({ a: { b: 2 } });
  });
});

describe("an options list from a paste is capped", () => {
  const words = new BuilderWords();
  it("refuses more than 2,000 lines or JSON entries, or more than 2 MiB", () => {
    const lines = Array.from({ length: MAX_IMPORTED_OPTIONS + 1 }, (_, i) => `v${i}`).join("\n");
    expect(typeof parseSimulatedOptions(lines, words)).toBe("string");
    const json = JSON.stringify(Array.from({ length: MAX_IMPORTED_OPTIONS + 1 }, (_, i) => ({ value: `v${i}` })));
    expect(typeof parseSimulatedOptions(json, words)).toBe("string");
    expect(typeof parseSimulatedOptions("x".repeat(2 * 1024 * 1024 + 1), words)).toBe("string");
  });
  it("holds the server's per-list cap, so an import is never one the next Save refuses", () => {
    expect(MAX_IMPORTED_OPTIONS).toBe(kernelStructureLimits().optionsPerComponent);
  });
  it("still reads an ordinary list", () => {
    expect(parseSimulatedOptions("a | Alpha\nb", words)).toEqual([
      { value: "a", label: "Alpha" },
      { value: "b", label: "b" }
    ]);
  });
});

const def = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition =>
  ({ type, version: "1.0.0", ...extra }) as unknown as ComponentDefinition;
const controller = (): BuilderController =>
  new BuilderController({
    componentTypes: [{ type: "text", label: "Text" }],
    initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } },
    componentDefinitions: [def("form", { children: { slots: [{ id: "content", multiple: true }] } }), def("text")]
  });
const transfer = (raw: string) => ({ setData: () => undefined, getData: (key: string) => (key === BUILDER_DRAG_MIME_TYPE ? raw : "") });

describe("a drag payload from another page is shaped", () => {
  it("is refused above the payload cap", () => {
    const huge = JSON.stringify({ kind: "template-component", component: { type: "text", configuration: { label: "A".repeat(MAX_DRAG_PAYLOAD_LENGTH) } } });
    expect(deserializeDragPayload(huge)).toBeUndefined();
  });
  it("keeps only the configuration keys the type's own template declares", () => {
    const c = controller();
    c.applyDrop(
      transfer(`{"kind":"template-component","component":{"type":"text","configuration":{"label":"Mine","extra":"x","__proto__":{"polluted":1}}}}`),
      "root",
      "content",
      0
    );
    const added = c.snapshot().children?.content?.[0]?.configuration as Record<string, unknown>;
    expect(added.label).toBe("Mine");
    expect(Object.keys(added)).toEqual(["label"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("a hostile sample's keys reach the data-model results as text", () => {
  it("makes no element out of a key or a note", async () => {
    const { dataModelPlaces, dataModelRowHtml } = await import("../form-engine/builder/data/data-model-import.js");
    const key = `"><img data-pwn=k src=x onerror=window.__pwn=1>`;
    const read = readDataModelInput(JSON.stringify({ [key]: 1, nested: { [key]: [null] } }), "sample");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const host = document.createElement("div");
    for (const { node, depth } of dataModelPlaces(read.model)) {
      host.insertAdjacentHTML("beforeend", dataModelRowHtml(node, depth, false, undefined));
    }
    expect(host.querySelector("[data-pwn], img")).toBeNull();
    expect(host.innerHTML).toContain("&lt;img");
  });
});
