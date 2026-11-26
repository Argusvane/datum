import { afterEach, describe, expect, it } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { isPrototypeName, prototypeSegmentOf } from "../form-engine/core/tree/prototype-names.js";

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() }
];
const root = (): ComponentNode => ({
  id: "root",
  type: "form",
  configuration: { messages: {}, tabs: [{ label: "one" }] },
  children: { content: [{ id: "a", type: "text", configuration: { label: "a" } }] }
});
const make = () => new BuilderController({ initialRoot: root(), componentDefinitions: DEFS });
const polluted = (): boolean => ({} as Record<string, unknown>).polluted !== undefined;

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).polluted;
});

describe("prototype names in property paths", () => {
  it("matches whole segments only", () => {
    expect(["__proto__", "constructor", "prototype"].every(isPrototypeName)).toBe(true);
    expect(["__proto", "prototypes", "constructorName", ""].some(isPrototypeName)).toBe(false);
    expect(prototypeSegmentOf("messages.__proto__.polluted")).toBe("__proto__");
    expect(prototypeSegmentOf("tabs.0.label")).toBeUndefined();
  });

  describe("tree", () => {
    it("refuses a set or remove through a prototype segment and reads own keys only", () => {
      const tree = new ComponentTree(root());
      expect(() => tree.setConfigurationValue("a", "__proto__.polluted", "x")).toThrow(/reserved/);
      expect(() => tree.setConfigurationValue("a", "constructor.prototype.polluted", "x")).toThrow(/reserved/);
      expect(() => tree.setConfigurationValue("a", "__proto__", "x")).toThrow(/reserved/);
      (Object.prototype as Record<string, unknown>).polluted = "keep";
      expect(() => tree.removeConfigurationValue("a", "__proto__.polluted")).toThrow(/reserved/);
      expect(({} as Record<string, unknown>).polluted).toBe("keep");
      expect(tree.getConfigurationValue("a", "constructor")).toBeUndefined();
      expect(tree.getConfigurationValue("a", "label")).toBe("a");
    });
    it("keeps numeric list segments and lookalike names working", () => {
      const tree = new ComponentTree(root());
      tree.setConfigurationValue("root", "tabs.0.label", "two");
      tree.setConfigurationValue("a", "prototypes", 1);
      tree.setConfigurationValue("a", "constructorName", 2);
      expect(tree.getConfigurationValue("root", "tabs.0.label")).toBe("two");
      expect(tree.getConfigurationValue("a", "prototypes")).toBe(1);
      expect(tree.getConfigurationValue("a", "constructorName")).toBe(2);
    });
  });

  describe("controller", () => {
    it("setProperty refuses, including the undefined (delete) route", () => {
      const c = make();
      expect(() => c.setProperty("a", "__proto__.polluted", "x")).toThrow(/reserved/);
      expect(() => c.setProperty("root", "messages.__proto__.polluted", "x")).toThrow(/reserved/);
      expect(() => c.setProperty("a", "constructor.prototype.polluted", "x")).toThrow(/reserved/);
      (Object.prototype as Record<string, unknown>).polluted = "keep";
      expect(() => c.setProperty("a", "__proto__.polluted", undefined)).toThrow(/reserved/);
      expect(({} as Record<string, unknown>).polluted).toBe("keep");
      expect(c.canUndo()).toBe(false);
    });
    it("setPropertyUnrecorded refuses", () => {
      const c = make();
      expect(() => c.setPropertyUnrecorded("a", "__proto__.polluted", "x")).toThrow(/reserved/);
      expect(polluted()).toBe(false);
    });
    it("setDraftProperty refuses at the entry, draft and commit alike", () => {
      const c = make();
      c.select("a");
      expect(() => c.setDraftProperty("a", "__proto__.polluted", "x")).toThrow(/reserved/);
      expect(() => c.setDraftProperty("a", "__proto__", "x")).toThrow(/reserved/);
      expect(() => c.setDraftProperty("a", "constructor.prototype.polluted", "x")).toThrow(/reserved/);
      c.commitDraft("a");
      expect(polluted()).toBe(false);
      expect(c.draftProperty("a", "constructor")).toBeUndefined();
    });
    it("setProperties checks every path before writing any", () => {
      const c = make();
      expect(() =>
        c.setProperties([
          { componentId: "a", propertyPath: "label", value: "changed" },
          { componentId: "a", propertyPath: "__proto__.polluted", value: "x" }
        ])
      ).toThrow(/reserved/);
      expect(c.getProperty("a", "label")).toBe("a");
      expect(c.canUndo()).toBe(false);
      expect(polluted()).toBe(false);
    });
    it("setProperties refuses a rule named like a prototype member", () => {
      const c = make();
      expect(() => c.setProperties([{ componentId: "a", propertyPath: "__proto__", value: "true", target: "rules" }])).toThrow(/reserved/);
      expect(c.canUndo()).toBe(false);
    });
    it("a numeric list segment still writes", () => {
      const c = make();
      c.setProperty("root", "tabs.0.label", "two");
      expect(c.getProperty("root", "tabs.0.label")).toBe("two");
    });
  });
});
