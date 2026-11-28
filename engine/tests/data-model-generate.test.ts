import { describe, expect, it } from "vitest";

import {
  compareDataModels,
  dataModelFromForm,
  dataModelFromJsonSchema,
  dataModelFromSample,
  generateComponents,
  indexDataModel,
  mappingFor,
  planAddMissing,
  planReplace,
  type DataModelNode,
  type GenerateOptions
} from "../form-engine/builder/data-model/index.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { BuilderWords } from "../form-engine/builder/logic/builder-texts.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import { buildValuePaths, findDataKeyProblems } from "../form-engine/core/tree/data-scope.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

const STANDARD = ["text", "textarea", "number", "checkbox", "select", "radio", "checkboxes", "date", "file", "container", "panel", "fieldset"];
const all = (type: string): boolean => STANDARD.includes(type);
const withGrid = (type: string): boolean => type === "dataGrid" || STANDARD.includes(type);
const only = (...types: string[]) => (type: string): boolean => types.includes(type);

const place = (node: Partial<DataModelNode> & Pick<DataModelNode, "kind">): DataModelNode => ({ key: "x", path: "x", ...node });

describe("which component a place becomes", () => {
  it("follows the mapping table", () => {
    const row = (node: Partial<DataModelNode> & Pick<DataModelNode, "kind">, inEntry = false) => {
      const mapping = mappingFor(place(node), all, inEntry);
      return [mapping.type, mapping.fit];
    };
    expect(row({ kind: "string" })).toEqual(["text", "exact"]);
    expect(row({ kind: "string", format: "multiline" })).toEqual(["textarea", "exact"]);
    expect(row({ kind: "string", maxLength: 500 })).toEqual(["textarea", "exact"]);
    expect(row({ kind: "string", format: "date" })).toEqual(["date", "exact"]);
    expect(row({ kind: "string", format: "date-time" })).toEqual(["text", "approximate"]);
    expect(row({ kind: "string", format: "email" })).toEqual(["text", "exact"]);
    expect(row({ kind: "string", options: [{ value: "a" }, { value: "b" }] })).toEqual(["radio", "exact"]);
    expect(row({ kind: "string", options: "abcdef".split("").map((value) => ({ value })) })).toEqual(["select", "exact"]);
    expect(row({ kind: "integer", options: [{ value: "1" }] })).toEqual(["radio", "approximate"]);
    expect(row({ kind: "boolean" })).toEqual(["checkbox", "exact"]);
    expect(row({ kind: "number" })).toEqual(["number", "exact"]);
    expect(row({ kind: "integer" })).toEqual(["number", "approximate"]);
    expect(row({ kind: "array", items: place({ kind: "string", options: [{ value: "a" }] }) })).toEqual(["checkboxes", "approximate"]);
    expect(row({ kind: "array", items: place({ kind: "string" }) })).toEqual(["textarea", "approximate"]);
    expect(row({ kind: "object", children: [] })).toEqual(["container", "exact"]);
    expect(row({ kind: "array", items: place({ kind: "object", children: [] }) })).toEqual(["panel", "approximate"]);
    expect(row({ kind: "array", items: place({ kind: "object", children: [] }) }, true)).toEqual([undefined, "unsupported"]);
    // A list of objects is a data grid where the form has the type, else the section it always was.
    const grid = mappingFor(place({ kind: "array", items: place({ kind: "object", children: [] }) }), withGrid);
    expect([grid.type, grid.fit, grid.notes]).toEqual(["dataGrid", "exact", []]);
    expect(row({ kind: "array", items: place({ kind: "array" }) })).toEqual([undefined, "unsupported"]);
    expect(row({ kind: "array" })).toEqual([undefined, "unsupported"]);
    expect(row({ kind: "array", items: place({ kind: "file" }) })).toEqual(["file", "exact"]);
    expect(row({ kind: "file" })).toEqual(["file", "exact"]);
    expect(row({ kind: "unknown" })).toEqual(["text", "approximate"]);
    expect(row({ kind: "null" })).toEqual(["text", "approximate"]);
  });

  it("falls back to what the builder has, and says so", () => {
    const date = mappingFor(place({ kind: "string", format: "date" }), only("text"));
    expect(date).toMatchObject({ type: "text", fit: "approximate" });
    expect(date.notes[0]!.code).toBe("fallback");
    expect(mappingFor(place({ kind: "object", children: [] }), only("text"))).toMatchObject({ fit: "unsupported" });
    expect(mappingFor(place({ kind: "array", items: place({ kind: "object" }) }), only("fieldset"))).toMatchObject({ type: "fieldset" });
  });
});

describe("building components from a model", () => {
  const options: GenerateOptions = { hasType: all };

  it("keys each component to its place, taking parents' keys into an id only on a clash", () => {
    const model = dataModelFromSample({
      name: "Ada",
      shipping: { street: "1 Main", city: "London" },
      billing: { street: "2 High", city: "Leeds" },
      items: [{ name: "Widget", qty: 2 }],
      "first name": "Ada"
    });
    const { components, skipped } = generateComponents(model.root.children!, options);
    expect(skipped).toEqual([]);
    const [name, shipping, billing, items, firstName] = components.map((component) => component.node);
    expect(name).toMatchObject({ id: "name", type: "text", configuration: { label: "Name" } });
    expect(name!.configuration).not.toHaveProperty("dataKey");
    expect(shipping!.children!.content!.map((node) => [node.id, (node.configuration as { dataKey?: string }).dataKey])).toEqual([
      ["street", undefined],
      ["city", undefined]
    ]);
    expect(billing!.children!.content!.map((node) => [node.id, (node.configuration as { dataKey?: string }).dataKey])).toEqual([
      ["billing_street", "street"],
      ["billing_city", "city"]
    ]);
    expect(items).toMatchObject({
      id: "items",
      type: "panel",
      configuration: { label: "Items" },
      collection: { itemFields: ["items_name", "qty"] },
      children: { content: [{ id: "items_name", configuration: { dataKey: "name" } }, { id: "qty", type: "number" }] }
    });
    expect(items!.collection).not.toHaveProperty("collectionPath");
    expect(firstName).toMatchObject({ id: "first_name", configuration: { label: "First name" } });

    // Built into one form, every answer lands exactly where the sample has it.
    const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: components.map((component) => component.node) } };
    const paths = buildValuePaths(root);
    expect(paths.get("billing_street")).toBe("billing.street");
    expect(paths.get("street")).toBe("shipping.street");
    expect(findDataKeyProblems(root)).toEqual([]);
  });

  it("gives a key that is a reserved word an id of its own, keeping the key as the data key", () => {
    const model = dataModelFromSample({ host: "a", row: "b", component: "c", ancestor: "d" });
    const { components, skipped } = generateComponents(model.root.children!, options);
    expect(skipped).toEqual([]);
    expect(components.map((component) => [component.node.id, (component.node.configuration as { dataKey?: string }).dataKey])).toEqual([
      ["host_field", "host"],
      ["row_field", "row"],
      ["component_field", "component"],
      ["ancestor_field", "ancestor"]
    ]);
  });

  it("carries the schema's words, choices, bounds and requirements into the configuration", () => {
    const model = dataModelFromJsonSchema({
      type: "object",
      required: ["status", "email", "tags", "agree", "nick", "profile"],
      properties: {
        status: { title: "Status", enum: ["in_progress", "done"], default: "done" },
        email: { type: "string", format: "email", maxLength: 80, pattern: "^\\S+@\\S+$" },
        tags: { type: "array", items: { enum: ["a", "b"] }, minItems: 1 },
        agree: { type: "boolean" },
        nick: { type: ["string", "null"] },
        age: { type: "integer", minimum: 0, maximum: 130 },
        profile: { type: "object", properties: { bio: { type: "string", description: "About you" } } },
        orders: { type: "array", items: { type: "object", required: ["sku"], properties: { sku: { type: "string" } } } }
      }
    });
    const nodes = Object.fromEntries(generateComponents(model.root.children!, options).components.map((component) => [component.node.id, component.node]));
    expect(nodes.status).toMatchObject({
      type: "radio",
      configuration: { label: "Status", required: true, options: [{ value: "in_progress", label: "In progress" }, { value: "done", label: "Done" }] },
      rules: { defaultValue: "\"done\"" }
    });
    expect(nodes.email).toMatchObject({ type: "text", configuration: { required: true, maxLength: 80, pattern: "\\S+@\\S+", autocomplete: "email", inputmode: "email" } });
    expect(nodes.tags).toMatchObject({ type: "checkboxes", configuration: { required: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } });
    // A required checkbox would have to be ticked; null is allowed, so nothing is required.
    expect(nodes.agree!.configuration).not.toHaveProperty("required");
    expect(nodes.nick!.configuration).not.toHaveProperty("required");
    expect(nodes.age).toMatchObject({ type: "number", configuration: { min: 0, max: 130 } });
    // A container holds no answer of its own to require.
    expect(nodes.profile!.configuration).not.toHaveProperty("required");
    expect(nodes.profile!.children!.content![0]).toMatchObject({ id: "bio", configuration: { description: "About you" } });
    // Nothing is required inside an entry: the form checks it outside any.
    expect(nodes.orders!.children!.content![0]!.configuration).not.toHaveProperty("required");
  });

  it("files a list under an object by its whole path, and reports what it cannot build", () => {
    const model = dataModelFromSample({ order: { items: [{ sku: "A" }], matrix: [[1]], empty: [] } });
    const { components, skipped } = generateComponents(model.root.children!, options);
    const order = components[0]!.node;
    expect(order.children!.content![0]).toMatchObject({ id: "items", collection: { collectionPath: "order.items" } });
    expect(skipped.map((entry) => entry.path)).toEqual(["order.matrix", "order.empty"]);
  });

  it("builds a list of objects as a data grid that keeps its rows at the path and lists no item fields", () => {
    const model = dataModelFromSample({ order: { items: [{ name: "Pen", qty: 2 }] }, people: [{ first: "Ada" }] });
    const { components, skipped } = generateComponents(model.root.children!, { hasType: withGrid });
    expect(skipped).toEqual([]);
    const [order, people] = components.map((component) => component.node);
    const items = order!.children!.content![0]!;
    expect(items).toMatchObject({
      id: "items",
      type: "dataGrid",
      configuration: { label: "Items" },
      collection: { collectionPath: "order.items" },
      children: { content: [{ id: "name", type: "text" }, { id: "qty", type: "number" }] }
    });
    expect(items.collection).not.toHaveProperty("itemFields");
    expect(people).toMatchObject({ id: "people", type: "dataGrid", collection: { collectionPath: "people" } });
    expect(people!.collection).not.toHaveProperty("itemFields");
    // The components then read back as the same collection, so the form describes the sample.
    const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: components.map((component) => component.node) } };
    expect(dataModelFromForm(root).root.children!.map((child) => child.path)).toEqual(["order", "people"]);
    expect(findDataKeyProblems(root)).toEqual([]);
  });

  it("starts each component from its type's default when there is one", () => {
    const template = (type: string): ComponentNode | undefined =>
      type === "file" ? { id: "file", type: "file", configuration: { label: "File upload", storage: "base64" } } : undefined;
    const model = dataModelFromSample({ scan: { storage: "base64", name: "a.pdf", type: "application/pdf", size: 1 } });
    const [scan] = generateComponents(model.root.children!, { hasType: all, template }).components;
    expect(scan!.node).toEqual({ id: "scan", type: "file", configuration: { label: "Scan", storage: "base64" } });
  });
});

describe("planning Add missing and Replace", () => {
  const formRoot = (): ComponentNode => ({
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: {} },
        { id: "address", type: "container", configuration: {}, children: { content: [{ id: "street", type: "text", configuration: {} }] } },
        { id: "items", type: "panel", configuration: {}, collection: {}, children: { content: [{ id: "sku", type: "text", configuration: {} }] } },
        { id: "note", type: "text", configuration: {} },
        { id: "reset", type: "button", configuration: {} },
        { id: "send", type: "button", configuration: {} }
      ]
    }
  });
  const incoming = dataModelFromSample({
    name: "Ada",
    email: "ada@example.com",
    address: { street: "1 Main", city: "London" },
    items: [{ sku: "A", qty: 2 }],
    note: { text: "object where the form has text" },
    extra: { a: 1 }
  });

  it("puts each new place under what holds its parent, before the closing buttons", () => {
    const formModel = dataModelFromForm(formRoot());
    const comparison = compareDataModels(formModel, incoming, { hasType: all });
    expect(comparison.entries.filter((entry) => entry.status === "kind-differs").map((entry) => entry.path)).toEqual(["note"]);
    const plan = planAddMissing(formRoot(), formModel, comparison, { hasType: all });
    expect(plan.entries.map((entry) => [entry.node.id, entry.parentId, entry.slotId, entry.index])).toEqual([
      ["email", "root", "content", 4],
      ["city", "address", "content", undefined],
      ["qty", "items", "content", undefined],
      ["extra", "root", "content", 5]
    ]);
    expect(plan.entries[3]!.node.children!.content!.map((node) => node.id)).toEqual(["a"]);
    expect(plan.added.map((entry) => entry.path)).toEqual(["email", "address.city", "items[].qty", "extra"]);
    expect(plan.skipped).toEqual([]);
  });

  it("adds a missing field to a data grid's row template, found by its collection path", () => {
    const formWithGrid: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "items", type: "dataGrid", configuration: {}, collection: { collectionPath: "items" }, children: { content: [{ id: "sku", type: "text", configuration: {} }] } }
        ]
      }
    };
    const formModel = dataModelFromForm(formWithGrid);
    const model = dataModelFromSample({ items: [{ sku: "A", qty: 2 }] });
    const plan = planAddMissing(formWithGrid, formModel, compareDataModels(formModel, model, { hasType: withGrid }), { hasType: withGrid });
    expect(plan.entries.map((entry) => [entry.node.id, entry.parentId, entry.slotId])).toEqual([["qty", "items", "content"]]);
    expect(plan.skipped).toEqual([]);
  });

  it("goes into the last step of a multi-step form, and skips a place with nowhere to go", () => {
    const stepped: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "steps",
            type: "steps",
            configuration: {},
            children: {
              content: [
                { id: "step_1", type: "step", configuration: {}, children: { content: [] } },
                { id: "step_2", type: "step", configuration: {}, children: { content: [] } }
              ]
            }
          },
          { id: "lines", type: "panel", configuration: {}, collection: { collectionPath: "shipment.lines" }, children: { content: [] } }
        ]
      }
    };
    const formModel = dataModelFromForm(stepped);
    const model = dataModelFromSample({ name: "Ada", shipment: { carrier: "UPS", lines: [{ code: "X" }] } });
    const plan = planAddMissing(stepped, formModel, compareDataModels(formModel, model, { hasType: all }), { hasType: all });
    expect(plan.entries.map((entry) => [entry.node.id, entry.parentId])).toEqual([
      ["name", "step_2"],
      ["code", "lines"]
    ]);
    expect(plan.skipped).toEqual([{ path: "shipment.carrier", reason: "No container on the form stands for shipment, so there is nowhere to put it." }]);
  });

  it("words a skipped place's reason in the builder's catalog", () => {
    const stepped: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "steps", type: "steps", configuration: {}, children: { content: [{ id: "step_1", type: "step", configuration: {}, children: { content: [] } }] } },
          { id: "lines", type: "panel", configuration: {}, collection: { collectionPath: "shipment.lines" }, children: { content: [] } }
        ]
      }
    };
    const formModel = dataModelFromForm(stepped);
    const model = dataModelFromSample({ shipment: { carrier: "UPS", lines: [{ code: "X" }] } });
    const words = new BuilderWords();
    words.locale = "fr";
    words.catalog = { fr: { "dataModel.gen.noContainer": "Aucun conteneur ne représente {path}." } };
    const plan = planAddMissing(stepped, formModel, compareDataModels(formModel, model, { hasType: all }), { hasType: all, text: words.options() });
    expect(plan.skipped).toEqual([{ path: "shipment.carrier", reason: "Aucun conteneur ne représente shipment." }]);
  });

  it("replaces everything but the closing buttons, and may reuse the ids it replaces", () => {
    const replacement = planReplace(formRoot(), incoming, { hasType: all });
    expect(replacement.keep).toEqual(["reset", "send"]);
    expect(replacement.nodes.map((node) => node.id)).toEqual(["name", "email", "address", "items", "note", "extra"]);
    expect(replacement.skipped).toEqual([]);
  });
});

describe("from a sample to a built form", () => {
  const leaf = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition => ({
    type,
    version: "1.0.0",
    createDefault: () => ({ id: type, type, configuration: { label: `${type} field` } }),
    capabilities: standardFieldCapabilities(),
    ...extra
  });
  const box = (type: string): ComponentDefinition => ({
    type,
    version: "1.0.0",
    createDefault: () => ({ id: type, type, configuration: { label: type }, children: { content: [] } }),
    capabilities: [],
    children: { slots: [{ id: "content", multiple: true }] }
  });
  const definitions: ComponentDefinition[] = [
    box("form"),
    ...["text", "textarea", "number", "checkbox", "select", "radio", "checkboxes", "date"].map((type) => leaf(type)),
    leaf("file", { createDefault: () => ({ id: "file", type: "file", configuration: { label: "File upload", storage: "base64" } }) }),
    box("container"),
    box("panel"),
    box("fieldset"),
    leaf("button", { capabilities: standardFieldCapabilities({ required: false }) })
  ];

  it("builds the form in one undo step, and the form then describes the sample", () => {
    const controller = new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "send", type: "button", configuration: { label: "Send" } }] } },
      componentDefinitions: definitions
    });
    const sample = dataModelFromSample({
      name: "Ada",
      email: "ada@example.com",
      born: "1815-12-10",
      bio: "Line one\nLine two",
      active: true,
      shipping: { street: "1 Main", geo: { city: "London" } },
      billing: { street: "2 High", geo: { city: "Leeds" } },
      order: { items: [{ name: "Widget", qty: 2, size: { width: 3 } }] },
      tags: ["math", "engines"],
      scan: { storage: "base64", name: "scan.pdf", type: "application/pdf", size: 10 }
    });
    const hasType = (type: string) => controller.hasComponentType(type);
    const options: GenerateOptions = { hasType, template: (type) => controller.componentTemplate(type) };
    const formModel = dataModelFromForm(controller.snapshot());
    const plan = planAddMissing(controller.snapshot(), formModel, compareDataModels(formModel, sample, { hasType }), options);
    expect(plan.skipped).toEqual([]);

    const result = controller.insertComponents(plan.entries);
    expect(result.ok).toBe(true);
    const built = controller.snapshot();
    expect(built.children!.content!.map((node) => node.id)).toEqual(["name", "email", "born", "bio", "active", "shipping", "billing", "order", "tags", "scan", "send"]);
    expect(findDataKeyProblems(built)).toEqual([]);

    // The built form describes the sample: every place present.
    const comparison = compareDataModels(dataModelFromForm(built), sample, { hasType });
    expect(comparison.counts).toMatchObject({ new: 0, "kind-differs": 0, "form-only": 0 });
    expect(indexDataModel(dataModelFromForm(built)).get("order.items[].size.width")).toMatchObject({ kind: "number" });
    expect(buildValuePaths(built).get("billing_geo")).toBe("billing.geo");

    // One undo takes it all back.
    controller.undo();
    expect(controller.snapshot().children!.content!.map((node) => node.id)).toEqual(["send"]);
  });
});
