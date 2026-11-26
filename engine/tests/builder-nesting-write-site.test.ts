import { describe, expect, it } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { NESTING_MAX, nestsPast } from "../form-engine/core/tree/nesting.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The nesting limit is the form's, counted from its root: a value is measured where it lands
 * (the component it is written to, and the path under it), so nothing the builder writes makes
 * a form it would refuse to open again.
 */

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "container", version: "1.0.0", createDefault: () => ({ id: "container", type: "container", configuration: {}, children: { content: [] } }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() }
];

/** A right-nested `and` chain: `levels + 1` levels of records, built without recursion. */
const chain = (levels: number): unknown => {
  let node: unknown = { kind: "path", path: "a" };
  for (let i = 0; i < levels; i += 1) {
    node = { kind: "logical", operator: "and", left: { kind: "path", path: "a" }, right: node };
  }
  return node;
};

// `b` sits one component down: its record is level 4 (root 1, children 2, the slot's list 3),
// its configuration 5, so a value written at `configuration.label` starts at level 6 and may
// itself nest 315 levels: chain(314) fits exactly, chain(315) is one too many.
const FITS = NESTING_MAX - 6;
const root = (): ComponentNode => ({
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "b", type: "text", configuration: {} },
      { id: "box", type: "container", configuration: {}, children: { content: [{ id: "inner", type: "text", configuration: {} }] } }
    ]
  }
});
const make = () => new BuilderController({ initialRoot: root(), componentDefinitions: DEFS });
const reopens = (c: BuilderController) => () => new BuilderController({ initialRoot: c.snapshot(), componentDefinitions: DEFS });

describe("a configuration value is measured where it lands", () => {
  it("setProperty takes a value that just fits and refuses one level more, leaving the form as it was", () => {
    const c = make();
    expect(() => c.setProperty("b", "label", chain(FITS + 1))).toThrow(/nests more than 320 levels/);
    expect(c.canUndo()).toBe(false);
    c.setProperty("b", "label", chain(FITS));
    expect(nestsPast(c.snapshot())).toBe(false);
    expect(reopens(c)).not.toThrow();
  });

  it("counts the path under the component and the component's own depth", () => {
    const c = make();
    // Two more segments under configuration take two levels from the value.
    expect(() => c.setProperty("b", "a.b.label", chain(FITS - 1))).toThrow(/nests more than/);
    c.setProperty("b", "a.b.label", chain(FITS - 2));
    // One container further down costs three levels (children, the slot's list, the node).
    expect(() => c.setProperty("inner", "label", chain(FITS - 2))).toThrow(/nests more than/);
    c.setProperty("inner", "label", chain(FITS - 3));
    expect(reopens(c)).not.toThrow();
  });

  it("setPropertyUnrecorded and setProperties refuse the same", () => {
    const c = make();
    expect(() => c.setPropertyUnrecorded("b", "label", chain(FITS + 1))).toThrow(/nests more than/);
    expect(() => c.setProperties([{ componentId: "b", propertyPath: "label", value: chain(FITS + 1) }])).toThrow(/nests more than/);
    // A rule key sits where a top-level setting does: rules (5), the rule (6).
    expect(() => c.setProperties([{ componentId: "b", propertyPath: "visibleWhen", value: chain(FITS + 1), target: "rules" }])).toThrow(/nests more than/);
    expect(c.canUndo()).toBe(false);
    c.setProperties([
      { componentId: "b", propertyPath: "label", value: chain(FITS) },
      { componentId: "inner", propertyPath: "visibleWhen", value: chain(FITS - 3), target: "rules" }
    ]);
    expect(reopens(c)).not.toThrow();
  });

  it("refuses a children map that would put a node past the limit", () => {
    const c = make();
    const deep = (levels: number) => ({ content: [{ id: "x", type: "text", configuration: { label: chain(levels) } }] });
    // children (5), list (6), x (7), configuration (8), label value from 9.
    expect(() => c.setProperties([{ componentId: "b", propertyPath: "children", value: deep(NESTING_MAX - 8), target: "children" }])).toThrow(/nests more than/);
    expect(c.canUndo()).toBe(false);
    // One level less lands exactly on the limit and is taken.
    c.setProperties([{ componentId: "b", propertyPath: "children", value: deep(NESTING_MAX - 9), target: "children" }]);
    expect(c.canUndo()).toBe(true);
    expect(nestsPast(c.snapshot())).toBe(false);
    expect(reopens(c)).not.toThrow();
  });

  it("setProperties names an unknown id before it measures the value", () => {
    const c = make();
    expect(() => c.setProperties([{ componentId: "nope", propertyPath: "label", value: chain(400) }])).toThrow(/Component not found: nope/);
    expect(() => c.setProperties([{ componentId: "nope", propertyPath: "visibleWhen", value: chain(400), target: "rules" }])).toThrow(/Component not found: nope/);
    expect(c.canUndo()).toBe(false);
  });

  it("setDraftProperty refuses it before Save, so a committed draft always reopens", () => {
    const c = make();
    c.select("b");
    expect(() => c.setDraftProperty("b", "label", chain(FITS + 1))).toThrow(/nests more than/);
    c.setDraftProperty("b", "label", chain(FITS));
    expect(c.commitDraft("b")).toBe(true);
    expect(reopens(c)).not.toThrow();
  });
});

describe("rules written whole are measured too", () => {
  // rules (5), the rule (6): the same budget as a top-level setting.
  const rules = (levels: number) => ({ visibleWhen: chain(levels) }) as never;

  it("setRules refuses past the limit in words, never with a stack overflow", () => {
    const c = make();
    expect(() => c.setRules("b", rules(FITS + 1))).toThrow(/nests more than 320 levels/);
    expect(() => c.setRules("b", rules(5000))).toThrow(/nests more than 320 levels/);
    expect(c.canUndo()).toBe(false);
    c.setRules("b", rules(FITS));
    expect(reopens(c)).not.toThrow();
  });

  it("setDraftRules refuses the same, so the Rules tab cannot commit an unopenable form", () => {
    const c = make();
    c.select("inner");
    expect(() => c.setDraftRules("inner", rules(FITS - 2))).toThrow(/nests more than/);
    expect(() => c.setDraftRules("inner", rules(5000))).toThrow(/nests more than/);
    c.setDraftRules("inner", rules(FITS - 3));
    expect(c.commitDraft("inner")).toBe(true);
    expect(reopens(c)).not.toThrow();
  });
});

describe("setOptions with a tree it cannot open", () => {
  it("refuses before it takes any of the new file's options", () => {
    const c = new BuilderController({
      initialRoot: root(),
      componentDefinitions: DEFS,
      identity: { id: "old", version: "1", schemaVersion: "1" },
      localization: { supportedLocales: [{ code: "en" }] }
    });
    const before = { identity: c.identity(), localization: c.localization(), translations: c.translations(), locale: c.currentLocale(), tree: c.snapshot() };
    const deep: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "z", type: "text", configuration: {}, rules: { visibleWhen: chain(5000) } as never }] } };
    expect(() =>
      c.setOptions({
        initialRoot: deep,
        identity: { id: "new", version: "9", schemaVersion: "1" },
        localization: { supportedLocales: [{ code: "fr" }], defaultLocale: "fr" },
        translations: { fr: { component: { b: { label: { text: "B", source: "0" } } } } } as never,
        locale: "fr"
      })
    ).toThrow(/nests more than 320 levels/);
    expect(c.identity()).toEqual(before.identity);
    expect(c.localization()).toEqual(before.localization);
    expect(c.translations()).toEqual(before.translations);
    expect(c.currentLocale()).toBe(before.locale);
    expect(c.snapshot()).toEqual(before.tree);
  });
});

describe("a draft is measured again where it is saved", () => {
  it("commitDraft refuses a draft that fit before its component moved deeper, and keeps it", () => {
    const c = make();
    c.select("b");
    // Fits on `b` one component down; one container further it is three levels too many.
    c.setDraftRules("b", { visibleWhen: chain(FITS) } as never);
    c.select("box");
    expect(c.move("b", { parentId: "box", slotId: "content", index: 0 })).toBe(true);
    c.select("b");
    expect(c.problemsOf("b")).toEqual([{ target: "rules:visibleWhen", message: expect.stringMatching(/nests more than 320 levels/) }]);
    expect(c.commitDraft("b")).toBe(false);
    expect(nestsPast(c.snapshot())).toBe(false);
    expect(reopens(c)).not.toThrow();
    // The draft is kept, so nothing typed is lost.
    expect(c.hasPendingChanges("b")).toBe(true);
  });

  it("the same for a setting, and a draft that still fits commits", () => {
    const c = make();
    c.select("b");
    c.setDraftProperty("b", "label", chain(FITS));
    c.select("box");
    expect(c.move("b", { parentId: "box", slotId: "content", index: 0 })).toBe(true);
    c.select("b");
    expect(c.problemsOf("b").map((problem) => problem.target)).toEqual(["label"]);
    expect(c.commitDraft("b")).toBe(false);
    c.setDraftProperty("b", "label", chain(FITS - 3));
    expect(c.problemsOf("b")).toEqual([]);
    expect(c.commitDraft("b")).toBe(true);
    expect(reopens(c)).not.toThrow();
  });
});

describe("a node far deeper than hosts read is refused in words before it is copied", () => {
  const deepNode = (id: string): ComponentNode => ({ id, type: "text", configuration: {}, rules: { visibleWhen: chain(5000) } as never });

  it("insertComponents", () => {
    const c = make();
    const before = c.snapshot();
    const result = c.insertComponents([{ node: deepNode("q"), parentId: "root", slotId: "content" }]);
    expect(result).toEqual({ ok: false, ids: [], error: expect.stringMatching(/nest more than 320 levels/) });
    expect(c.dropError).toBe(result.error);
    expect(c.snapshot()).toEqual(before);
    expect(c.canUndo()).toBe(false);
  });

  it("replaceComponent", () => {
    const c = make();
    const before = c.snapshot();
    const result = c.replaceComponent("b", deepNode("b"));
    expect(result).toEqual({ ok: false, ids: [], error: expect.stringMatching(/nest more than 320 levels/) });
    expect(c.dropError).toBe(result.error);
    expect(c.snapshot()).toEqual(before);
  });

  it("replaceContent", () => {
    const c = make();
    const before = c.snapshot();
    const result = c.replaceContent([deepNode("q")]);
    expect(result).toEqual({ ok: false, ids: [], error: expect.stringMatching(/nest more than 320 levels/) });
    expect(c.dropError).toBe(result.error);
    expect(c.snapshot()).toEqual(before);
  });
});
