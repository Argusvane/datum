import { describe, expect, it } from "vitest";

import { BuilderController, type BuilderChangeEvent } from "../form-engine/builder/controller/builder-controller.js";
import { moveValuePathsInTests } from "../form-engine/builder/form-tests/tests-rename.js";
import { moveValuePath, renameRowKeysInRuleSource, rowKeyMoveOf } from "../form-engine/builder/formula/rename.js";
import type { BuilderMutationEvent } from "../form-engine/builder/tree-editor/tree-editor.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A data key or a container's key moves where answers are stored, and what reads
 * them by value path follows as a rename does: the rules inside a grid row (`row.<key>`), the
 * scenarios, a PDF layout's sources, in the same step of the history as the edit.
 */

const holder = (type: string, slot = "content"): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: {}, children: { [slot]: [] } }),
  capabilities: [],
  children: { slots: [{ id: slot, multiple: true }] }
});
const DEFS: ComponentDefinition[] = [
  holder("form"),
  holder("container"),
  holder("dataGrid"),
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: {} }), capabilities: standardFieldCapabilities() }
];

function make(qtyRules: Record<string, string> = { requiredWhen: 'row.sku != ""' }): BuilderController {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "applicant", type: "container", configuration: {}, children: { content: [{ id: "email", type: "text", configuration: {} }] } },
        {
          id: "items",
          type: "dataGrid",
          configuration: {},
          collection: { collectionPath: "items" },
          children: {
            content: [
              { id: "sku", type: "text", configuration: {} },
              { id: "qty", type: "text", configuration: {}, rules: qtyRules }
            ]
          }
        }
      ]
    }
  };
  return new BuilderController({ componentDefinitions: DEFS, initialRoot: root });
}

const qtyRules = (ctrl: BuilderController) => ctrl.snapshot().children?.content?.[1]?.children?.content?.[1]?.rules;

describe("a data key edit moves what reads the data, in one step", () => {
  it("a row field's key: the change says where the data went, the row's rules follow, Undo puts both back", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    const mutations: BuilderMutationEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.on("mutation", (event) => mutations.push(event));
    ctrl.setProperty("sku", "dataKey", "code");
    expect(changes.at(-1)?.dataMoved).toEqual([{ from: "items[].sku", to: "items[].code" }]);
    expect(qtyRules(ctrl)).toEqual({ requiredWhen: 'row.code != ""' });
    expect(mutations).toHaveLength(1);
    ctrl.undo();
    expect(ctrl.getProperty("sku", "dataKey")).toBeUndefined();
    expect(qtyRules(ctrl)).toEqual({ requiredWhen: 'row.sku != ""' });
    expect(ctrl.canUndo()).toBe(false);
    ctrl.redo();
    expect(qtyRules(ctrl)).toEqual({ requiredWhen: 'row.code != ""' });
  });

  it("a container's key, saved from the inspector: every field under it moves", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.select("applicant");
    ctrl.setDraftProperty("applicant", "dataKey", "contact");
    expect(ctrl.commitDraft("applicant")).toBe(true);
    expect(changes.at(-1)?.dataMoved).toEqual([
      { from: "applicant", to: "contact" },
      { from: "applicant.email", to: "contact.email" }
    ]);
  });

  it("takes the scenarios' rewrite, made a moment later, into the same step", () => {
    const ctrl = make();
    ctrl.setTests({ scenarios: [{ id: "test-1", source: 'test "one"\n  set applicant.email = "a@b.c"\n' }] });
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.setProperty("applicant", "dataKey", "contact");
    const moves = changes.at(-1)!.dataMoved!;
    const next = moveValuePathsInTests(ctrl.tests(), moves, [])!;
    expect(next.scenarios[0]?.source).toContain("set contact.email =");
    expect(ctrl.followRename(moves[0]!, () => ctrl.setTests(next))).toBe(true);
    ctrl.undo();
    expect(ctrl.tests()?.scenarios[0]?.source).toContain("set applicant.email =");
    expect(ctrl.getProperty("applicant", "dataKey")).toBeUndefined();
  });

  it("two keys swapped in one edit: each rule in the row reads where its data went", () => {
    const ctrl = make({ requiredWhen: 'row.sku = "a" and row.qty = "b"' });
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.setProperties([
      { componentId: "sku", propertyPath: "dataKey", value: "qty" },
      { componentId: "qty", propertyPath: "dataKey", value: "sku" }
    ]);
    expect(changes.at(-1)?.dataMoved).toEqual([
      { from: "items[].sku", to: "items[].qty" },
      { from: "items[].qty", to: "items[].sku" }
    ]);
    // sku's answers are now stored under "qty" and qty's under "sku": the rule reads them there.
    expect(qtyRules(ctrl)).toEqual({ requiredWhen: 'row.qty = "a" and row.sku = "b"' });
    ctrl.undo();
    expect(qtyRules(ctrl)).toEqual({ requiredWhen: 'row.sku = "a" and row.qty = "b"' });
  });

  it("a Save with a new id and nothing else that moves data announces no move: the rename says it all", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.select("sku");
    ctrl.setDraftId("sku", "code");
    ctrl.setDraftProperty("sku", "label", "Code");
    expect(ctrl.commitDraft("sku")).toBe(true);
    expect(changes.at(-1)?.renamed).toMatchObject({ from: "sku", to: "code" });
    expect(changes.at(-1)?.dataMoved).toBeUndefined();
    expect(qtyRules(ctrl)).toEqual({ requiredWhen: 'row.code != ""' });
  });

  it("a Save that gives a field a new id and a new data key together: the row's rules read the new key, in the rename's step", () => {
    for (const [key, rule] of [
      [undefined, 'row.sku != ""'],
      ["sku_key", 'row.sku_key != ""']
    ] as const) {
      const ctrl = make({ requiredWhen: rule });
      if (key) {
        ctrl.setProperty("sku", "dataKey", key);
      }
      const steps = ctrl.canUndo();
      const changes: BuilderChangeEvent[] = [];
      ctrl.on("change", (event) => changes.push(event));
      ctrl.select("sku");
      ctrl.setDraftId("sku", "code");
      ctrl.setDraftProperty("sku", "dataKey", "code_key");
      expect(ctrl.commitDraft("sku")).toBe(true);
      expect(qtyRules(ctrl), key).toEqual({ requiredWhen: 'row.code_key != ""' });
      // The rename carries where the field's own data went, and so does the move the new id alone
      // does not explain, for the readers that follow by value path.
      expect(changes.at(-1)?.renamed).toMatchObject({ from: "sku", to: "code", dataPath: { from: `items[].${key ?? "sku"}`, to: "items[].code_key" } });
      expect(changes.at(-1)?.dataMoved).toEqual([{ from: `items[].${key ?? "sku"}`, to: "items[].code_key" }]);
      ctrl.undo();
      expect(qtyRules(ctrl), key).toEqual({ requiredWhen: rule });
      expect(ctrl.canUndo()).toBe(steps);
    }
  });

  it("a Save that renames a container and changes its key: the fields under it are announced as moved, and join the rename's step", () => {
    const ctrl = make();
    ctrl.setTests({ scenarios: [{ id: "test-1", source: 'test "one"\n  set applicant.email = "a@b.c"\n' }] });
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.select("applicant");
    ctrl.setDraftId("applicant", "person");
    ctrl.setDraftProperty("applicant", "dataKey", "contact");
    expect(ctrl.commitDraft("applicant")).toBe(true);
    const change = changes.at(-1)!;
    expect(change.renamed).toMatchObject({ from: "applicant", to: "person" });
    expect(change.dataMoved).toEqual([
      { from: "applicant", to: "contact" },
      { from: "applicant.email", to: "contact.email" }
    ]);
    // A component with a data key is followed by value path, not by its id.
    const next = moveValuePathsInTests(ctrl.tests(), change.dataMoved!, [])!;
    expect(next.scenarios[0]?.source).toContain("set contact.email =");
    expect(ctrl.followRename(change.dataMoved![0]!, () => ctrl.setTests(next))).toBe(true);
    ctrl.undo();
    expect(ctrl.tests()?.scenarios[0]?.source).toContain("set applicant.email =");
    expect(ctrl.snapshot().children?.content?.[0]?.id).toBe("applicant");
  });

  it("an edit that moves no data is an ordinary step, and announces no move", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.setProperty("sku", "label", "SKU");
    expect(changes.at(-1)?.dataMoved).toBeUndefined();
    expect(ctrl.followRename({ from: "items[].sku", to: "items[].sku" }, () => undefined)).toBe(false);
  });
});

describe("the rules inside a row read by key, so they follow the key and never the id", () => {
  it("a Save that gives a row field a new id and keeps its stored key leaves the row's rules reading that key", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.select("sku");
    ctrl.setDraftId("sku", "code");
    ctrl.setDraftProperty("sku", "dataKey", "sku");
    expect(ctrl.commitDraft("sku")).toBe(true);
    expect(changes.at(-1)?.renamed).toMatchObject({ from: "sku", to: "code" });
    expect(changes.at(-1)?.dataMoved).toBeUndefined();
    expect(qtyRules(ctrl)).toEqual({ requiredWhen: 'row.sku != ""' });
    ctrl.undo();
    expect(qtyRules(ctrl)).toEqual({ requiredWhen: 'row.sku != ""' });
    expect(ctrl.canUndo()).toBe(false);
  });

  it("a rename of a field whose data key is its old id leaves the row's rules as they are", () => {
    const ctrl = make();
    ctrl.setProperty("sku", "dataKey", "sku");
    ctrl.renameId("sku", "code");
    expect(qtyRules(ctrl)).toEqual({ requiredWhen: 'row.sku != ""' });
  });

  it("a rename of a keyless field moves its key: the row's rules follow, and the change names them", () => {
    const ctrl = make();
    const changes: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => changes.push(event));
    ctrl.renameId("sku", "code");
    expect(qtyRules(ctrl)).toEqual({ requiredWhen: 'row.code != ""' });
    expect(changes.at(-1)?.renamed?.rules).toEqual(["qty"]);
    ctrl.undo();
    expect(qtyRules(ctrl)).toEqual({ requiredWhen: 'row.sku != ""' });
  });

  it("a container inside a row: its rename and its key move the keys under it, and the row's rules follow", () => {
    const build = (): BuilderController =>
      new BuilderController({
        componentDefinitions: DEFS,
        initialRoot: {
          id: "root",
          type: "form",
          configuration: {},
          children: {
            content: [
              {
                id: "items",
                type: "dataGrid",
                configuration: {},
                collection: { collectionPath: "items" },
                children: {
                  content: [
                    { id: "address", type: "container", configuration: {}, children: { content: [{ id: "city", type: "text", configuration: {} }] } },
                    { id: "qty", type: "text", configuration: {}, rules: { requiredWhen: 'row.address.city != ""' } }
                  ]
                }
              }
            ]
          }
        }
      });
    const rule = (ctrl: BuilderController) => ctrl.snapshot().children?.content?.[0]?.children?.content?.[1]?.rules;
    const renamed = build();
    renamed.renameId("address", "home");
    expect(rule(renamed)).toEqual({ requiredWhen: 'row.home.city != ""' });
    const keyed = build();
    keyed.setProperty("address", "dataKey", "where");
    expect(rule(keyed)).toEqual({ requiredWhen: 'row.where.city != ""' });
    keyed.undo();
    expect(rule(keyed)).toEqual({ requiredWhen: 'row.address.city != ""' });
  });
});

describe("the follow-ups' rewrites", () => {
  it("renameRowKeysInRuleSource touches row reads of the keys only, each read once", () => {
    expect(renameRowKeysInRuleSource('row.sku != "" and sku = 1 and row.skus = 2', [{ from: "sku", to: "code" }])).toBe('row.code != "" and sku = 1 and row.skus = 2');
    expect(renameRowKeysInRuleSource({ kind: "path", path: "row.sku" }, [{ from: "sku", to: "code" }])).toEqual({ kind: "path", path: "row.code" });
    expect(
      renameRowKeysInRuleSource('row.sku = "a" and row.qty = "b"', [
        { from: "sku", to: "qty" },
        { from: "qty", to: "sku" }
      ])
    ).toBe('row.qty = "a" and row.sku = "b"');
  });

  it("moveValuePath moves a path once, by the most specific move that reaches it", () => {
    const swap = [
      { from: "items[].sku", to: "items[].qty" },
      { from: "items[].qty", to: "items[].sku" }
    ];
    expect(moveValuePath("items[3].sku", swap)).toBe("items[3].qty");
    expect(moveValuePath("items[3].qty", swap)).toBe("items[3].sku");
    // The grid's key and a row field's key changed in one edit: the row field's own move wins.
    const both = [
      { from: "items", to: "lines" },
      { from: "items[].sku", to: "lines[].code" },
      { from: "items[].qty", to: "lines[].qty" }
    ];
    expect(moveValuePath("items[0].sku", both)).toBe("lines[0].code");
    expect(moveValuePath("items[0].qty", both)).toBe("lines[0].qty");
    expect(moveValuePath("items", both)).toBe("lines");
    expect(moveValuePath("other", both)).toBe("other");
  });

  it("moveValuePathsInTests follows indexed paths and a row key of the moved collection", () => {
    const tests = { scenarios: [{ id: "t", source: 'test "rows"\n  add row to items with sku = "A"\n  set items[0].sku = "B"\n  expect items[0].sku = "B"\n' }] };
    const next = moveValuePathsInTests(tests, [{ from: "items[].sku", to: "items[].code" }], []);
    expect(next?.scenarios[0]?.source).toBe('test "rows"\n  add row to items with code = "A"\n  set items[0].code = "B"\n  expect items[0].code = "B"\n');
    expect(moveValuePathsInTests(tests, [{ from: "other", to: "else" }], [])).toBeUndefined();
  });

  it("moveValuePathsInTests follows a row key whose grid moved in the same edit, as the row's rules do", () => {
    const tests = { scenarios: [{ id: "t", source: 'test "rows"\n  add row to items with sku = "A"\n  expect items[0].sku = "A"\n' }] };
    const moves = [
      { from: "items", to: "lines" },
      { from: "items[].sku", to: "lines[].code" }
    ];
    expect(moveValuePathsInTests(tests, moves, [])?.scenarios[0]?.source).toBe('test "rows"\n  add row to lines with code = "A"\n  expect lines[0].code = "A"\n');
    expect(rowKeyMoveOf(moves[1]!)).toEqual({ collection: "lines", collectionBefore: "items", from: "sku", to: "code" });
    expect(renameRowKeysInRuleSource('row.sku != ""', [{ from: "sku", to: "code" }])).toBe('row.code != ""');
  });

  it("renameRowKeysInRuleSource reads a key under a container in the row by the most specific move", () => {
    expect(
      renameRowKeysInRuleSource('row.address.city != "" and row.address.zip != ""', [
        { from: "address", to: "home" },
        { from: "address.city", to: "town" }
      ])
    ).toBe('row.town != "" and row.home.zip != ""');
  });

  it("moveValuePathsInTests applies the moves of one edit as one map, so a swap stays a swap", () => {
    const tests = { scenarios: [{ id: "t", source: 'test "rows"\n  add row to items with sku = "A", qty = "B"\n  set items[0].sku = "C"\n  expect items[0].qty = "B"\n' }] };
    const next = moveValuePathsInTests(
      tests,
      [
        { from: "items[].sku", to: "items[].qty" },
        { from: "items[].qty", to: "items[].sku" }
      ],
      []
    );
    expect(next?.scenarios[0]?.source).toBe('test "rows"\n  add row to items with qty = "A", sku = "B"\n  set items[0].qty = "C"\n  expect items[0].sku = "B"\n');
  });
});
