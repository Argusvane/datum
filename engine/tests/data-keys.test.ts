import { describe, expect, it } from "vitest";

import {
  buildComponentIdsByPath,
  buildDataPaths,
  buildRowKeys,
  buildValuePaths,
  collectionPathOf,
  dataKeyOf,
  dataKeyProblemOf,
  findDataKeyProblems,
  isValidDataKey,
  valuesByComponentId
} from "../form-engine/core/tree/data-scope.js";
import { EventBus } from "../form-engine/core/events/event-bus.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { parseComponentPath } from "../form-engine/core/tree/component-path.js";
import { RuntimeOrchestrator } from "../form-engine/runtime/browser/runtime-orchestrator.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { collectFieldConstraints } from "../form-engine/validation/core/field-constraints.js";
import { evaluateExpression } from "../form-engine/rules/evaluator/evaluator.js";
import {
  kernelKnownValuePaths,
  kernelRunFieldConstraints,
  kernelSanitizeValues,
  kernelValuePaths
} from "../form-engine/validation/wasm/portable-kernel.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { walkPdfBlocks, runsText, type PdfBlock } from "../form-engine/render/pdf/pdf-document.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";

/**
 * Shipping and billing addresses that repeat their keys, a top-level `name` next to the
 * entries' own `name`, and a list of entries filed under an object (`order.items`) — the
 * shapes a pasted JSON sample needs and ids alone cannot give.
 */
function keyedForm(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Order" },
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name", required: true } },
        {
          id: "shipping",
          type: "container",
          configuration: { label: "Shipping" },
          children: {
            content: [
              { id: "street", type: "text", configuration: { label: "Street" } },
              {
                id: "shipping_geo",
                type: "container",
                configuration: { label: "Where", dataKey: "geo" },
                children: { content: [{ id: "shipping_city", type: "text", configuration: { label: "City", dataKey: "city" } }] }
              }
            ]
          }
        },
        {
          id: "billing_address",
          type: "container",
          configuration: { label: "Billing", dataKey: "billing" },
          children: {
            content: [
              { id: "billing_street", type: "text", configuration: { label: "Street", dataKey: "street", required: true, minLength: 3 } },
              {
                id: "billing_geo",
                type: "container",
                configuration: { label: "Where", dataKey: "geo" },
                children: { content: [{ id: "billing_city", type: "text", configuration: { label: "City", dataKey: "city" } }] }
              }
            ]
          }
        },
        {
          id: "order",
          type: "container",
          configuration: { label: "Order" },
          children: {
            content: [
              {
                id: "order_items",
                type: "panel",
                configuration: { label: "Items" },
                collection: { collectionPath: "order.items", itemFields: ["item_name", "qty"] },
                children: {
                  content: [
                    { id: "item_name", type: "text", configuration: { label: "Item", dataKey: "name" } },
                    { id: "qty", type: "number", configuration: { label: "Qty" } },
                    {
                      id: "item_size",
                      type: "container",
                      configuration: { label: "Size", dataKey: "size" },
                      children: { content: [{ id: "width", type: "number", configuration: { label: "Width" } }] }
                    }
                  ]
                }
              }
            ]
          }
        },
        { id: "send", type: "button", configuration: { label: "Send", action: "submit" } },
        { id: "intro", type: "html", configuration: { html: "<p>Hi</p>" } }
      ]
    }
  };
}

function withChildren(children: ComponentNode[]): ComponentNode {
  return { id: "root", type: "form", configuration: {}, children: { content: children } };
}

describe("data keys: the grammar", () => {
  it("takes the path-segment grammar and refuses digits alone", () => {
    for (const key of ["street", "first_name", "e-mail", "Line2", "_id", "2fa"]) {
      expect(isValidDataKey(key)).toBe(true);
      expect(dataKeyProblemOf(key)).toBeUndefined();
    }
    for (const key of ["first name", "a.b", "items[0]", "ünï", "12", ""]) {
      expect(isValidDataKey(key)).toBe(false);
    }
    expect(isValidDataKey(3)).toBe(false);
    expect(dataKeyProblemOf("12")).toMatch(/digits alone/);
    expect(dataKeyProblemOf("a.b")).toMatch(/letters, digits/);
    expect(dataKeyProblemOf(7)).toMatch(/text/);
    // Unset is not a problem: the id is the segment.
    expect(dataKeyProblemOf(undefined)).toBeUndefined();
    expect(dataKeyProblemOf("")).toBeUndefined();
  });

  it("falls back to the id for an unset or unusable key", () => {
    expect(dataKeyOf({ id: "a", type: "text", configuration: {} })).toBe("a");
    expect(dataKeyOf({ id: "a", type: "text", configuration: { dataKey: "b" } })).toBe("b");
    expect(dataKeyOf({ id: "a", type: "text", configuration: { dataKey: "b c" } })).toBe("a");
    expect(dataKeyOf({ id: "a", type: "text", configuration: { dataKey: "99" } })).toBe("a");
    expect(dataKeyOf({ id: "a", type: "text", configuration: null })).toBe("a");
  });

  it("finds a section's entries at its collection path as written, else its id", () => {
    expect(collectionPathOf({ id: "a", type: "panel", configuration: {} })).toBeUndefined();
    expect(collectionPathOf({ id: "a", type: "panel", configuration: {}, collection: {} })).toBe("a");
    expect(collectionPathOf({ id: "a", type: "panel", configuration: {}, collection: { collectionPath: "" } })).toBe("a");
    expect(collectionPathOf({ id: "a", type: "panel", configuration: {}, collection: { collectionPath: "order.items" } })).toBe("order.items");
  });
});

describe("data keys: where answers live", () => {
  it("places each answer by the keys of its scopes and its own key, repeating keys across objects", () => {
    const paths = buildValuePaths(keyedForm());
    expect(paths.get("name")).toBe("name");
    expect(paths.get("street")).toBe("shipping.street");
    expect(paths.get("shipping_city")).toBe("shipping.geo.city");
    expect(paths.get("billing_street")).toBe("billing.street");
    expect(paths.get("billing_city")).toBe("billing.geo.city");
    // A section adds no level to the path a field's own control reads.
    expect(paths.get("item_name")).toBe("order.name");
    expect(paths.get("root")).toBe("root");
  });

  it("describes the document: a section's entries at its collection path, their fields under []", () => {
    const paths = buildDataPaths(keyedForm());
    expect(paths.get("billing_street")).toBe("billing.street");
    expect(paths.get("order_items")).toBe("order.items");
    expect(paths.get("item_name")).toBe("order.items[].name");
    expect(paths.get("width")).toBe("order.items[].size.width");
  });

  it("keys each field of an entry within the entry, and nothing outside a section", () => {
    const keys = buildRowKeys(keyedForm());
    expect(keys.get("item_name")).toBe("name");
    expect(keys.get("qty")).toBe("qty");
    expect(keys.get("item_size")).toBe("size");
    expect(keys.get("width")).toBe("size.width");
    expect(keys.has("name")).toBe(false);
    expect(keys.has("order_items")).toBe(false);
  });

  it("maps each path to the components storing there, leaving out groups and valueless leaves", () => {
    const byPath = buildComponentIdsByPath(keyedForm());
    expect(byPath.get("billing.street")).toEqual(["billing_street"]);
    expect(byPath.get("billing")).toEqual(["billing_address"]);
    expect(byPath.has("send")).toBe(false);
    expect(byPath.has("intro")).toBe(false);
    expect(byPath.has("root")).toBe(false);

    const clash = buildComponentIdsByPath(
      withChildren([
        { id: "a", type: "text", configuration: { dataKey: "same" } },
        { id: "b", type: "text", configuration: { dataKey: "same" } }
      ])
    );
    expect(clash.get("same")).toEqual(["a", "b"]);
  });

  it("re-keys answers by component id for rules, a component's own answer winning over a stray key", () => {
    const byPath = buildComponentIdsByPath(keyedForm());
    const values = valuesByComponentId(
      { "billing.street": "Main", "shipping.street": "Side", street: "stray", "order.items[0].name": "Widget" },
      byPath
    );
    expect(values.billing_street).toBe("Main");
    // `street` is the shipping field's id: its own answer, not the stray top-level key.
    expect(values.street).toBe("Side");
    expect(values["order.items[0].name"]).toBe("Widget");
  });
});

describe("data keys: problems", () => {
  it("finds none on a well-keyed form", () => {
    expect(findDataKeyProblems(keyedForm())).toEqual([]);
  });

  it("reports an unusable key, two answers in one place, and a place nested under one that cannot hold it", () => {
    const problems = findDataKeyProblems(
      withChildren([
        { id: "a", type: "text", configuration: { dataKey: "bad key" } },
        { id: "b", type: "text", configuration: { dataKey: "shared" } },
        { id: "c", type: "number", configuration: { dataKey: "shared" } },
        { id: "d", type: "text", configuration: { dataKey: "addr" } },
        { id: "addr_box", type: "container", configuration: { dataKey: "addr" }, children: { content: [{ id: "city", type: "text", configuration: {} }] } }
      ])
    );
    // The object's field is not reported again: the duplicate at addr already says it.
    expect(problems.map((problem) => [problem.code, problem.path, problem.componentIds])).toEqual([
      ["invalid-key", "a", ["a"]],
      ["duplicate-path", "shared", ["b", "c"]],
      ["duplicate-path", "addr", ["d", "addr_box"]]
    ]);
    expect(problems[1]!.message).toContain("b and c");

    const nestedUnderField = findDataKeyProblems(
      withChildren([
        { id: "addr", type: "text", configuration: {} },
        { id: "addr_box", type: "container", configuration: { dataKey: "place" }, children: { content: [{ id: "city", type: "text", configuration: {} }] } },
        { id: "note", type: "text", configuration: { dataKey: "addr" } }
      ])
    );
    expect(nestedUnderField.map((problem) => [problem.code, problem.path])).toEqual([["duplicate-path", "addr"]]);

    const underAValue = findDataKeyProblems(
      withChildren([
        { id: "place", type: "text", configuration: {} },
        {
          id: "wrapper",
          type: "fieldset",
          configuration: {},
          children: { content: [{ id: "deep", type: "container", configuration: { dataKey: "inner" }, children: { content: [] } }] }
        }
      ])
    );
    expect(underAValue).toEqual([]);
  });

  it("reports a place nested under a single answer", () => {
    const tree = withChildren([
      { id: "place", type: "text", configuration: {} },
      { id: "place_parts", type: "container", configuration: { dataKey: "parts" }, children: { content: [] } }
    ]);
    expect(findDataKeyProblems(tree)).toEqual([]);
    // A section filed under a text answer's path.
    const conflict = findDataKeyProblems(
      withChildren([
        { id: "place", type: "text", configuration: {} },
        { id: "rows", type: "panel", configuration: {}, collection: { collectionPath: "place.rows" }, children: { content: [] } }
      ])
    );
    expect(conflict.map((problem) => [problem.code, problem.path, problem.componentIds])).toEqual([["path-conflict", "place.rows", ["place", "rows"]]]);
    expect(conflict[0]!.message).toBe("rows cannot be stored at place.rows: place stores a single answer at place.");
  });

  it("lets two data-scoping containers share an object, and flags only their clashing fields", () => {
    const split = withChildren([
      { id: "tab1", type: "container", configuration: { dataKey: "applicant" }, children: { content: [{ id: "given", type: "text", configuration: {} }] } },
      { id: "tab2", type: "container", configuration: { dataKey: "applicant" }, children: { content: [{ id: "family", type: "text", configuration: {} }] } }
    ]);
    expect(findDataKeyProblems(split)).toEqual([]);

    const clashing = withChildren([
      { id: "tab1", type: "container", configuration: { dataKey: "applicant" }, children: { content: [{ id: "given", type: "text", configuration: {} }] } },
      { id: "tab2", type: "container", configuration: { dataKey: "applicant" }, children: { content: [{ id: "given2", type: "text", configuration: { dataKey: "given" } }] } }
    ]);
    expect(findDataKeyProblems(clashing).map((problem) => [problem.code, problem.path])).toEqual([["duplicate-path", "applicant.given"]]);
  });

  it("treats a list and an object at one place as a conflict, and a section's own entries as its", () => {
    const problems = findDataKeyProblems(
      withChildren([
        { id: "items", type: "panel", configuration: {}, collection: {}, children: { content: [{ id: "sku", type: "text", configuration: {} }] } },
        { id: "items_obj", type: "container", configuration: { dataKey: "items" }, children: { content: [{ id: "x", type: "text", configuration: {} }] } }
      ])
    );
    // One report: the fields under the shared place follow from it.
    expect(problems.map((problem) => [problem.code, problem.path])).toEqual([["duplicate-path", "items"]]);
  });

  it("lets a caller say which leaves carry no answer", () => {
    const tree = withChildren([
      { id: "a", type: "note", configuration: { dataKey: "k" } },
      { id: "b", type: "text", configuration: { dataKey: "k" } }
    ]);
    expect(findDataKeyProblems(tree)).toHaveLength(1);
    expect(findDataKeyProblems(tree, { isValueless: (node) => node.type === "note" })).toEqual([]);
  });
});

describe("data keys: the runtime", () => {
  it("evaluates rules by component id against keyed answers, and applies the hidden policy to the keyed field", () => {
    const root = withChildren([
      {
        id: "billing_address",
        type: "container",
        configuration: { dataKey: "billing" },
        children: {
          content: [
            { id: "billing_street", type: "text", configuration: { dataKey: "street" } },
            {
              id: "billing_note",
              type: "text",
              configuration: { dataKey: "note", hiddenValueBehavior: "exclude-from-submission" },
              rules: { visibleWhen: 'billing_street = "Main"' }
            },
            {
              id: "billing_copy",
              type: "text",
              configuration: { dataKey: "copy" },
              rules: { value: "billing_street" }
            }
          ]
        }
      }
    ]);
    const orchestrator = new RuntimeOrchestrator(new ComponentTree(root), { eventBus: new EventBus(), formId: "f" });
    const store = new FormStateStore("en");
    store.setValue(parseComponentPath("billing.street"), "Side");
    store.setValue(parseComponentPath("billing.note"), "left at door");
    const result = orchestrator.recompute(store.snapshot());
    expect(orchestrator.effectiveStateFor("billing_note")?.visible).toBe(false);
    expect("billing.note" in orchestrator.effectiveValues()).toBe(false);
    // The calculation writes to its keyed path and reports its component id.
    expect(result.computedWrites).toEqual([{ componentId: "billing_copy", value: "Side" }]);

    store.setValue(parseComponentPath("billing.street"), "Main");
    orchestrator.recompute(store.snapshot());
    expect(orchestrator.effectiveStateFor("billing_note")?.visible).toBe(true);
    expect(orchestrator.effectiveValues()["billing.note"]).toBe("left at door");
  });

  it("mirrors a write under a dotted collection path into the section's entries", () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
    const definition: FormDefinition = { id: "f", version: "1", schemaVersion: "1", root: keyedForm(), localization: { defaultLocale: "en" } };
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
    runtime.addRow("order.items", {});
    runtime.setValue("order.items[0].name", "Widget");
    runtime.setValue("order.items[0].size.width", 3);
    expect(runtime.rows("order.items")[0]).toEqual({ name: "Widget", "size.width": 3 });
    // A structural change rewrites state from the entries, and the answers survive it.
    runtime.addRow("order.items", { name: "Gadget" });
    expect(runtime.state().values["order.items[0].name"]).toBe("Widget");
    expect(runtime.state().values["order.items[1].name"]).toBe("Gadget");
  });

  it("reads an entry's own dotted keys in the row scope, and an enclosing entry filed under a dotted path", () => {
    const context = {
      values: {},
      rowValues: { "size.width": 3, plain: { nested: 1 } },
      ancestorValues: { "order.items": { name: "Widget", "size.width": 4 } }
    };
    expect(evaluateExpression({ kind: "path", path: "row.size.width" }, context)).toBe(3);
    expect(evaluateExpression({ kind: "path", path: "row.plain.nested" }, context)).toBe(1);
    expect(evaluateExpression({ kind: "path", path: "ancestor.order.items.name" }, context)).toBe("Widget");
    expect(evaluateExpression({ kind: "path", path: "ancestor.order.items.size.width" }, context)).toBe(4);
    expect(evaluateExpression({ kind: "path", path: "row.missing" }, context)).toBeUndefined();
  });

  it("checks constraints at the keyed path", () => {
    const constraints = collectFieldConstraints(keyedForm());
    expect(constraints.find((constraint) => constraint.componentId === "billing_street")?.path).toBe("billing.street");
  });
});

describe("data keys: the sandbox kernel", () => {
  it("derives the same value paths as the engine", () => {
    const engine = Object.fromEntries(buildValuePaths(keyedForm()));
    expect(kernelValuePaths(keyedForm())).toEqual(engine);
  });

  it("knows keyed paths and a section's entries where they live, whatever container sits above it", () => {
    const known = kernelKnownValuePaths(keyedForm());
    for (const path of ["name", "shipping.street", "shipping.geo.city", "billing.street", "billing.geo.city", "order.items", "order.items.name", "order.items.qty", "order.items.size.width"]) {
      expect(known[path], path).toBe(true);
    }
    // Not under the id-built paths any longer.
    expect(known["billing_address.billing_street"]).toBeUndefined();
    expect(known["order.order_items.item_name"]).toBeUndefined();
  });

  it("keeps keyed answers and drops what the schema does not define", () => {
    const values = {
      name: "Ada",
      "billing.street": "Main",
      "order.items[0].name": "Widget",
      "order.items[0].size.width": 3,
      billing_street: "id-keyed, dropped",
      "items[0].name": "wrong list, dropped"
    };
    expect(kernelSanitizeValues(values, keyedForm())).toEqual({
      name: "Ada",
      "billing.street": "Main",
      "order.items[0].name": "Widget",
      "order.items[0].size.width": 3
    });
  });

  it("places a section inside a container and a custom path as the runtime does", () => {
    const nested = withChildren([
      {
        id: "order",
        type: "container",
        configuration: {},
        children: {
          content: [
            { id: "items", type: "panel", configuration: {}, collection: {}, children: { content: [{ id: "sku", type: "text", configuration: {} }] } },
            { id: "lines", type: "panel", configuration: {}, collection: { collectionPath: "all_lines" }, children: { content: [{ id: "code", type: "text", configuration: {} }] } }
          ]
        }
      }
    ]);
    const known = kernelKnownValuePaths(nested);
    expect(known["items.sku"]).toBe(true);
    expect(known["all_lines.code"]).toBe(true);
    expect(known["order.items.sku"]).toBeUndefined();
  });

  it("falls back to the id for an unusable key, exactly as the engine does", () => {
    const tree = withChildren([
      { id: "a", type: "text", configuration: { dataKey: "no good" } },
      { id: "b", type: "text", configuration: { dataKey: "42" } }
    ]);
    expect(kernelValuePaths(tree)).toEqual(Object.fromEntries(buildValuePaths(tree)));
    expect(kernelKnownValuePaths(tree)).toEqual({ a: true, b: true });
  });

  it("checks constraints at the keyed path", () => {
    const errors = kernelRunFieldConstraints(keyedForm(), { name: "Ada", "billing.street": "ab" }, "en");
    expect(errors).toEqual([expect.objectContaining({ code: "minLength", componentId: "billing_street", path: "billing.street" })]);
    const missing = kernelRunFieldConstraints(keyedForm(), { name: "Ada" }, "en");
    expect(missing).toEqual([expect.objectContaining({ code: "required", componentId: "billing_street", path: "billing.street" })]);
  });
});

function pdfState(values: Record<string, unknown>): FormState {
  return {
    values,
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale: "en-CA"
  };
}

function blocksOf(blocks: PdfBlock[]): PdfBlock[] {
  const out: PdfBlock[] = [];
  walkPdfBlocks(blocks, (block) => out.push(block));
  return out;
}

describe("data keys: the PDF", () => {
  const values = {
    name: "Ada",
    "billing.street": "Main",
    "order.items[0].name": "Widget",
    "order.items[0].qty": 2,
    "order.items[1].name": "Gadget",
    "order.items[1].qty": 5
  };
  const noSources = { resolveDataSource: async () => undefined };

  it("fills a section's table from entries keyed by each field's key", async () => {
    const model = await buildPdfRenderModel(keyedForm(), pdfState(values), noSources);
    const table = blocksOf(model.document!.blocks).find((block) => block.kind === "table" && block.componentId === "order_items");
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") {
      return;
    }
    const text = (block: PdfBlock | undefined): string => (block && "runs" in block ? runsText(block.runs) : "");
    const cells = table.rows.map((row) => row.cells.slice(0, 2).map((cell) => text(cell.blocks[0])));
    expect(cells).toEqual([
      ["Widget", "2"],
      ["Gadget", "5"]
    ]);
  });

  it("reads {{row.<key>}}, and names an entry's field by its key", async () => {
    const layout: PdfGeneratedLayout = {
      id: "letter",
      kind: "generated",
      root: {
        id: "document",
        type: "pdf-document",
        configuration: {},
        children: {
          header: [],
          footer: [],
          body: [
            {
              id: "rep",
              type: "pdf-repeat",
              configuration: { collectionPath: "order.items" },
              children: {
                row: [
                  { id: "rt", type: "pdf-text", configuration: { text: "{{rowNumber}}. {{row.name}} x {{row.qty}}" } },
                  { id: "rf", type: "pdf-field", configuration: { componentId: "item_name", rendition: "field" } }
                ]
              }
            },
            { id: "top", type: "pdf-text", configuration: { text: "For {{name}} at {{billing.street}}" } }
          ]
        }
      }
    };
    const model = await buildPdfRenderModel(keyedForm(), pdfState(values), noSources, {}, { layout });
    const all = blocksOf(model.document!.blocks);
    const texts = all.filter((block) => block.kind === "paragraph").map((block) => (block.kind === "paragraph" ? runsText(block.runs) : ""));
    expect(texts).toContain("1. Widget x 2");
    expect(texts).toContain("2. Gadget x 5");
    expect(texts).toContain("For Ada at Main");
    const widgets = all.filter((block) => block.kind === "widget");
    expect(widgets).toMatchObject([
      { field: { name: "order.items[0].name", value: "Widget" } },
      { field: { name: "order.items[1].name", value: "Gadget" } }
    ]);
  });
});
