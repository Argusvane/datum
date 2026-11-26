import { describe, expect, it } from "vitest";

import { BuilderController, dependentLines, dependentsHeading, dependentsOf, withoutDependents } from "../form-engine/builder/controller/builder-controller.js";
import type { OutsideDocument } from "../form-engine/core/localization/locale-documents.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { PDF_FIELD_COMPONENT_TYPE, PDF_REPEAT_COMPONENT_TYPE } from "../form-engine/core/schema/pdf-layout.js";
import { PDF_TABLE_COMPONENT_TYPE } from "../form-engine/core/schema/pdf-layout-table.js";

/**
 * What leans on a component, and the delete that clears it. The pure reader is
 * checked kind by kind; the controller's cascade is checked as ONE history entry that brings the
 * component and every reference back with one Undo.
 */

const def = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition =>
  ({ type, version: "1.0.0", capabilities: [], ...extra }) as unknown as ComponentDefinition;

const root = (): ComponentNode => ({
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "amount", type: "text", configuration: { label: "Amount" } },
      // Reads the amount twice over: a plain formula and the object form.
      { id: "reason", type: "text", configuration: { label: "Reason" }, rules: { visibleWhen: "amount > 100", requiredWhen: { formula: "amount > 5 and other = 1" }, enabledWhen: "other = 1" } as never },
      { id: "other", type: "text", configuration: { label: "Other" }, rules: { visibleWhen: "other_2 = 1" } as never },
      {
        id: "box",
        type: "group",
        configuration: { label: "Box" },
        children: { content: [{ id: "inside", type: "text", configuration: {} }, { id: "sibling_in_box", type: "text", configuration: {}, rules: { visibleWhen: "inside = 1" } as never }] }
      }
    ]
  }
});

const journeys = (): unknown => ({
  journeys: [
    {
      id: "apply",
      name: "Apply",
      pages: [
        {
          id: "one",
          title: "Start",
          components: [
            "amount",
            "other",
            { id: "alias", type: "text", configuration: { label: "Alias", fills: "amount" } },
            { id: "kept", type: "text", configuration: { label: "Kept" }, rules: { visibleWhen: "amount > 1", requiredWhen: "other = 1" } },
            { id: "sum", type: "journey-value", configuration: { to: "other", value: "alias + 1" } }
          ],
          routes: [{ when: "amount > 50", to: "two" }, { when: "other = 1", to: "two" }, { to: "two" }]
        },
        { id: "two", components: ["reason", { id: "r", type: "journey-field", configuration: { componentId: "amount" } }] }
      ]
    }
  ]
});

const pdf = (): unknown => ({
  layouts: [
    {
      id: "summary",
      kind: "generated",
      name: "Summary",
      when: "amount > 100",
      root: {
        id: "document",
        type: "pdf-document",
        configuration: {},
        children: {
          body: [
            { id: "f1", type: PDF_FIELD_COMPONENT_TYPE, configuration: { componentId: "amount" } },
            { id: "f2", type: PDF_FIELD_COMPONENT_TYPE, configuration: { componentId: "other" } },
            { id: "rep", type: PDF_REPEAT_COMPONENT_TYPE, configuration: { collectionPath: "amount" }, children: { body: [{ id: "deep", type: PDF_FIELD_COMPONENT_TYPE, configuration: { componentId: "other" } }] } },
            { id: "tab", type: PDF_TABLE_COMPONENT_TYPE, configuration: { collectionPath: "other" } }
          ]
        }
      }
    },
    {
      id: "official",
      kind: "template",
      name: "Official",
      template: { kind: "inline", base64: "" },
      fields: [
        { pdfField: "Name", source: { kind: "component", componentId: "amount" } },
        { pdfField: "Other", source: { kind: "component", componentId: "other" } },
        { pdfField: "Calc", source: { kind: "expression", expression: "amount * 2" } },
        { pdfField: "Lit", source: { kind: "literal", value: "x" } }
      ],
      areas: [
        { id: "a1", label: "Total", page: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, source: { kind: "path", path: "amount" } },
        { id: "a2", page: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, source: { kind: "component", componentId: "other" } }
      ]
    }
  ]
});

function make() {
  const ctrl = new BuilderController({
    initialRoot: root(),
    componentTypes: [{ type: "text", label: "Text" }],
    componentDefinitions: [
      def("form", { children: { slots: [{ id: "content", multiple: true }] } }),
      def("group", { children: { slots: [{ id: "content", multiple: true }] } }),
      def("text")
    ]
  });
  const state: Record<string, { value: unknown }> = { journeys: { value: journeys() }, pdf: { value: pdf() } };
  const documents: OutsideDocument[] = Object.entries(state).map(([id, held]) => ({
    id,
    read: () => held.value,
    write: (value) => {
      held.value = value;
    },
    texts: () => [],
    setDefaults: (value) => value
  }));
  ctrl.setOutsideDocuments(() => documents);
  return { ctrl, state };
}

const source = () => ({ root: root(), journey: journeys() as never, pdf: pdf() as never });

describe("dependentsOf", () => {
  it("finds a PDF repeat bound by a data path other than the component id (scoping container, data key)", () => {
    const tree: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "grp", type: "container", configuration: {}, children: { content: [{ id: "items", type: "text", configuration: {} }, { id: "keyed", type: "text", configuration: { dataKey: "k2" } }] } }] }
    };
    const layouts = (path: string): never =>
      ({ layouts: [{ id: "l", kind: "generated", name: "L", root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "rep", type: PDF_REPEAT_COMPONENT_TYPE, configuration: { collectionPath: path } }] } } }] }) as never;
    expect(dependentsOf({ root: tree, pdf: layouts("grp.items") }, "items").map((entry) => entry.kind)).toEqual(["pdf"]);
    expect(dependentsOf({ root: tree, pdf: layouts("grp.k2") }, "keyed").map((entry) => entry.kind)).toEqual(["pdf"]);
    expect(dependentsOf({ root: tree, pdf: layouts("grp.other") }, "items")).toEqual([]);
  });

  it("finds the rules of other components that read it, in any stored shape", () => {
    const found = dependentsOf({ root: root() }, "amount").filter((entry) => entry.kind === "rule");
    expect(found.map((entry) => entry.kind === "rule" && `${entry.componentId}:${entry.rule}`)).toEqual(["reason:visibleWhen", "reason:requiredWhen"]);
    // A rule that spells a longer id, or reads another field, is no dependent.
    expect(dependentsOf({ root: root() }, "other").filter((entry) => entry.kind === "rule").map((entry) => entry.kind === "rule" && `${entry.componentId}:${entry.rule}`)).toEqual(["reason:requiredWhen", "reason:enabledWhen"]);
  });

  it("finds journey pages that list it, fill from it, work out into it, route on it, or have a rule that reads it", () => {
    const found = dependentsOf(source(), "amount").filter((entry) => entry.kind === "journey");
    expect(found.map((entry) => entry.kind === "journey" && `${entry.pageId}:${entry.where}`).sort()).toEqual(
      ["one:question", "one:fills", "one:rule", "one:route", "two:question"].sort()
    );
    const other = dependentsOf(source(), "other").filter((entry) => entry.kind === "journey");
    expect(other.map((entry) => entry.kind === "journey" && `${entry.pageId}:${entry.where}`).sort()).toEqual(["one:question", "one:rule", "one:value", "one:route"].sort());
  });

  it("finds PDF layouts: a condition, generated nodes bound to it, a template's fields and areas", () => {
    const found = dependentsOf(source(), "amount").filter((entry) => entry.kind === "pdf");
    expect(found.map((entry) => entry.kind === "pdf" && `${entry.layoutId}:${entry.where}:${entry.detail ?? ""}`)).toEqual([
      "summary:when:",
      "summary:node:f1",
      "summary:node:rep",
      "official:field:Name",
      "official:field:Calc",
      "official:area:Total"
    ]);
    // A repeat's own binding counts, and what is bound inside it is cleared with it, not listed apart.
    expect(dependentsOf(source(), "other").filter((entry) => entry.kind === "pdf").map((entry) => entry.kind === "pdf" && `${entry.layoutId}:${entry.where}:${entry.detail ?? ""}`)).toEqual([
      "summary:node:f2",
      "summary:node:deep",
      "summary:node:tab",
      "official:field:Other",
      "official:area:a2"
    ]);
  });

  it("finds PDF text placeholders: a text block or a signature caption that writes the field", () => {
    const layouts = {
      layouts: [
        {
          id: "letter",
          kind: "generated",
          name: "Letter",
          root: {
            id: "document",
            type: "pdf-document",
            configuration: {},
            children: {
              body: [
                { id: "hello", type: "pdf-text", configuration: { text: "Dear {{ amount }}" } },
                { id: "tr", type: "pdf-text", configuration: { text: { default: "x", fr: "Cher {{amount}}" } } },
                { id: "sig", type: "pdf-signature", configuration: { label: "Signed {{amount.sub}}" } },
                { id: "other", type: "pdf-text", configuration: { text: "{{row.amount}} and {{amounts}}" } }
              ]
            }
          }
        }
      ]
    } as never;
    const found = dependentsOf({ root: root(), pdf: layouts }, "amount").filter((entry) => entry.kind === "pdf");
    expect(found.map((entry) => entry.kind === "pdf" && `${entry.where}:${entry.detail}`)).toEqual(["text:hello", "text:tr", "text:sig"]);
    expect(dependentLines(found, undefined)[0]).toContain("Letter");
  });

  it("reads a large subtree against many rules without a parse per id", () => {
    const children = Array.from({ length: 150 }, (_, at) => ({ id: `c${at}`, type: "text", configuration: {} }));
    const readers = Array.from({ length: 300 }, (_, at) => ({ id: `r${at}`, type: "text", configuration: {}, rules: { visibleWhen: `c${at % 150} > ${at} and amount = 1` } as never }));
    const tree: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "g", type: "group", configuration: {}, children: { content: children } }, ...readers] } };
    const started = performance.now();
    const found = dependentsOf({ root: tree }, "g");
    expect(found).toHaveLength(300);
    expect(performance.now() - started).toBeLessThan(400);
  });

  it("counts everything inside a deleted container as deleted too, and a rule inside the container about it as nothing", () => {
    const found = dependentsOf({ root: root() }, "box");
    // sibling_in_box reads `inside`, both go with the box: no dependent.
    expect(found).toEqual([]);
    const reading = root();
    reading.children!.content![0]!.rules = { visibleWhen: "inside = 1" } as never;
    expect(dependentsOf({ root: reading }, "box").map((entry) => entry.kind === "rule" && entry.componentId)).toEqual(["amount"]);
  });

  it("says nothing for a form with no references, and for a component that is not there", () => {
    expect(dependentsOf({ root: root() }, "reason")).toEqual([]);
    expect(dependentsOf({ root: root() }, "nope")).toEqual([]);
  });

  it("words each dependent, with a plural heading", () => {
    const found = dependentsOf(source(), "amount");
    const lines = dependentLines(found);
    expect(lines).toContain("Rule “visibleWhen” of Reason");
    expect(lines).toContain("Journey “Apply”, step “Start” lists it");
    expect(lines).toContain("PDF layout “Official”: the field Name is filled from it");
    expect(lines.every((line) => !line.includes("{"))).toBe(true);
    expect(dependentsHeading(1)).toBe("1 other place uses it:");
    expect(dependentsHeading(3)).toBe("3 other places use it:");
  });
});

describe("withoutDependents", () => {
  it("clears the rules, the pages' questions and route conditions, the layouts' bindings; the same objects where nothing reads it", () => {
    const cleared = withoutDependents(source(), "amount");
    expect(cleared.rules).toEqual([{ componentId: "reason", rules: { enabledWhen: "other = 1" } }]);
    const journey = cleared.journey as unknown as { journeys: Array<{ pages: Array<Record<string, unknown>> }> };
    const one = journey.journeys[0]!.pages[0]!;
    expect(one.components).toEqual([
      "other",
      { id: "kept", type: "text", configuration: { label: "Kept" }, rules: { requiredWhen: "other = 1" } },
      { id: "sum", type: "journey-value", configuration: { to: "other", value: "alias + 1" } }
    ].map((entry) => entry));
    expect(one.routes).toEqual([{ when: "other = 1", to: "two" }, { to: "two" }]);
    expect((journey.journeys[0]!.pages[1]!.components as unknown[])).toEqual(["reason"]);
    const layouts = (cleared.pdf as unknown as { layouts: Array<Record<string, unknown>> }).layouts;
    expect(layouts[0]!.when).toBeUndefined();
    const body = ((layouts[0]!.root as ComponentNode).children!.body ?? []).map((node) => node.id);
    expect(body).toEqual(["f2", "tab"]);
    expect((layouts[1]!.fields as Array<{ pdfField: string }>).map((entry) => entry.pdfField)).toEqual(["Other", "Lit"]);
    expect((layouts[1]!.areas as Array<{ id: string }>).map((entry) => entry.id)).toEqual(["a2"]);

    const none = withoutDependents(source(), "sibling_in_box");
    expect(none.rules).toEqual([]);
    expect(none.journey).toBeUndefined();
    expect(none.pdf).toBeUndefined();
  });
});

describe("remove with the references", () => {
  it("removes the component and clears every reference as ONE undo step; Undo restores all of it, Redo does it again", () => {
    const { ctrl, state } = make();
    const before = { tree: JSON.stringify(ctrl.snapshot()), journeys: structuredClone(state.journeys!.value), pdf: structuredClone(state.pdf!.value) };
    expect(ctrl.dependentsOf("amount").length).toBeGreaterThan(5);

    ctrl.remove("amount", { removeReferences: true });
    expect(ctrl.snapshot().children!.content!.map((node) => node.id)).not.toContain("amount");
    expect(ctrl.snapshot().children!.content!.find((node) => node.id === "reason")!.rules).toEqual({ enabledWhen: "other = 1" });
    expect(ctrl.dependentsOf("amount")).toEqual([]);
    expect(dependentsOf({ root: ctrl.snapshot(), journey: state.journeys!.value as never, pdf: state.pdf!.value as never }, "amount")).toEqual([]);
    const after = { tree: JSON.stringify(ctrl.snapshot()), journeys: structuredClone(state.journeys!.value), pdf: structuredClone(state.pdf!.value) };

    ctrl.undo();
    expect(JSON.stringify(ctrl.snapshot())).toBe(before.tree);
    expect(state.journeys!.value).toEqual(before.journeys);
    expect(state.pdf!.value).toEqual(before.pdf);
    // One step: a second Undo has nothing of this removal left to take back.
    expect(ctrl.canUndo()).toBe(false);

    ctrl.redo();
    expect(JSON.stringify(ctrl.snapshot())).toBe(after.tree);
    expect(state.journeys!.value).toEqual(after.journeys);
    expect(state.pdf!.value).toEqual(after.pdf);
  });

  it("leaves the references where they are without the choice: the delete itself is still allowed", () => {
    const { ctrl, state } = make();
    const journeysBefore = structuredClone(state.journeys!.value);
    ctrl.remove("amount");
    expect(ctrl.snapshot().children!.content!.map((node) => node.id)).not.toContain("amount");
    expect(ctrl.snapshot().children!.content!.find((node) => node.id === "reason")!.rules).toHaveProperty("visibleWhen");
    expect(state.journeys!.value).toEqual(journeysBefore);
    // The component is gone, so it has no dependents to ask for; the callers' references stay as written and
    // the builder flags them where it already marks a missing field.
    expect(ctrl.dependentsOf("amount")).toEqual([]);
    ctrl.undo();
    expect(ctrl.dependentsOf("amount").length).toBeGreaterThan(5);
  });

  it("clears the open drafts' rules too, so a later Save cannot write the reference back", () => {
    const { ctrl } = make();
    ctrl.select("reason");
    ctrl.setDraftProperty("reason", "label", "Why");
    ctrl.remove("amount", { removeReferences: true });
    ctrl.commitDraft("reason");
    expect(ctrl.snapshot().children!.content!.find((node) => node.id === "reason")!.rules).toEqual({ enabledWhen: "other = 1" });
  });

  it("treats a container's whole subtree as removed: rules about what is inside it go with it", () => {
    const { ctrl } = make();
    ctrl.remove("box", { removeReferences: true });
    expect(ctrl.snapshot().children!.content!.map((node) => node.id)).toEqual(["amount", "reason", "other"]);
    ctrl.undo();
    expect(ctrl.snapshot().children!.content!.map((node) => node.id)).toEqual(["amount", "reason", "other", "box"]);
  });
});

describe("remove clears an open draft's reads of the removed fields", () => {
  const gridController = (qtyRules: Record<string, string> | undefined) => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "plain", type: "text", configuration: {} },
          {
            id: "orders",
            type: "group",
            configuration: {},
            collection: { collectionPath: "orders" },
            children: {
              content: [
                { id: "ref", type: "text", configuration: { dataKey: "sku" } },
                { id: "qty", type: "text", configuration: {}, ...(qtyRules ? { rules: qtyRules as never } : {}) }
              ]
            }
          }
        ]
      }
    };
    return new BuilderController({
      initialRoot: root,
      componentTypes: [{ type: "text", label: "Text" }],
      componentDefinitions: [
        def("form", { children: { slots: [{ id: "content", multiple: true }] } }),
        def("group", { children: { slots: [{ id: "content", multiple: true }] } }),
        def("text")
      ]
    });
  };
  const ruleOf = (ctrl: BuilderController, id: string) => {
    const find = (node: ComponentNode): ComponentNode | undefined =>
      node.id === id ? node : Object.values(node.children ?? {}).flat().map(find).find((found) => found !== undefined);
    return find(ctrl.snapshot())!.rules;
  };

  it("a draft's row.<key> read of a keyed field in the removed subtree goes with the field", () => {
    const ctrl = gridController({ visibleWhen: 'row.sku != ""' });
    ctrl.select("qty");
    ctrl.setDraftRules("qty", { visibleWhen: 'row.sku == "x"', requiredWhen: "true" });
    ctrl.remove("ref", { removeReferences: true });
    expect(ctrl.draftRules("qty")).toEqual({ requiredWhen: "true" });
    ctrl.commitDraft("qty");
    expect(ruleOf(ctrl, "qty")).toEqual({ requiredWhen: "true" });
  });

  it("a read only the draft holds is cleared too: the choice decides, not the tree's references", () => {
    const ctrl = gridController(undefined);
    ctrl.select("qty");
    ctrl.setDraftRules("qty", { visibleWhen: 'row.sku == "x"', requiredWhen: "true" });
    ctrl.remove("ref", { removeReferences: true });
    expect(ctrl.draftRules("qty")).toEqual({ requiredWhen: "true" });
    ctrl.commitDraft("qty");
    expect(ruleOf(ctrl, "qty")).toEqual({ requiredWhen: "true" });
  });

  it("a read of the removed id only the draft holds is cleared as well", () => {
    const ctrl = gridController(undefined);
    ctrl.select("plain");
    ctrl.setDraftRules("plain", { visibleWhen: "ref = 1", requiredWhen: "true" });
    ctrl.remove("ref", { removeReferences: true });
    expect(ctrl.draftRules("plain")).toEqual({ requiredWhen: "true" });
  });

  it("without the choice the draft keeps what it reads", () => {
    const ctrl = gridController(undefined);
    ctrl.select("qty");
    ctrl.setDraftRules("qty", { visibleWhen: 'row.sku == "x"' });
    ctrl.remove("ref");
    expect(ctrl.draftRules("qty")).toEqual({ visibleWhen: 'row.sku == "x"' });
  });
});

describe("a rule inside a grid row reads its fields by key", () => {
  const grid = (qtyRules: Record<string, string>): ComponentNode => ({
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
              { id: "code", type: "text", configuration: { dataKey: "sku" } },
              { id: "qty", type: "text", configuration: {}, rules: qtyRules as never },
              { id: "note", type: "text", configuration: {}, rules: { visibleWhen: 'row.code != ""' } as never }
            ]
          }
        },
        { id: "outside", type: "text", configuration: {}, rules: { visibleWhen: 'row.sku != ""' } as never }
      ]
    }
  });

  it("row.<key> is a read of the field stored under that key, wherever the id differs", () => {
    const found = dependentsOf({ root: grid({ requiredWhen: 'row.sku != ""' }) }, "code").filter((entry) => entry.kind === "rule");
    expect(found.map((entry) => entry.kind === "rule" && `${entry.componentId}:${entry.rule}`)).toEqual(["qty:requiredWhen"]);
  });

  it("row.<id> of a field with another key is no read of it", () => {
    // `note` reads row.code, a key the row does not have: removing the field leaves it alone.
    expect(dependentsOf({ root: grid({ requiredWhen: 'row.sku != ""' }) }, "code").some((entry) => entry.kind === "rule" && entry.componentId === "note")).toBe(false);
  });

  it("a keyless field's key is its id", () => {
    const keyless = grid({ requiredWhen: 'row.qty2 != ""' });
    expect(dependentsOf({ root: keyless }, "qty").filter((entry) => entry.kind === "rule")).toEqual([]);
    const reads = grid({ requiredWhen: 'row.code != ""' });
    reads.children!.content![0]!.children!.content![0]!.configuration = {};
    expect(dependentsOf({ root: reads }, "code").filter((entry) => entry.kind === "rule").map((entry) => entry.kind === "rule" && entry.componentId)).toEqual(["qty", "note"]);
  });

  it("the references cleared with the field are the same rules", () => {
    const cleared = withoutDependents({ root: grid({ requiredWhen: 'row.sku != ""', visibleWhen: "true" }) }, "code");
    expect(cleared.rules).toEqual([{ componentId: "qty", rules: { visibleWhen: "true" } }]);
  });
});
