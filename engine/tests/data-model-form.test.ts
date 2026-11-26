import { describe, expect, it } from "vitest";

import {
  dataModelFromForm,
  humanizeKey,
  indexDataModel,
  dataKeyFromName,
  assignKeys,
  type DataModelNode
} from "../form-engine/builder/data-model/index.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/** Every standard type, a data-scoping container, keys, a repeating section filed under a dotted path, a data grid. */
function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Order" },
    children: {
      content: [
        { id: "intro", type: "html", configuration: { html: "<p>Hi</p>" } },
        { id: "fullName", type: "text", configuration: { label: "Full name", required: true, pattern: "[A-Za-z ]+", minLength: 2, maxLength: 40 } },
        { id: "notes", type: "textarea", configuration: { label: "Notes" } },
        { id: "age", type: "number", configuration: { label: "Age", min: 0, max: 130 } },
        { id: "agree", type: "checkbox", configuration: { label: "I agree" }, rules: { requiredWhen: { kind: "literal", value: true } } },
        {
          id: "country",
          type: "select",
          configuration: { label: "Country", options: [{ value: "CA", label: "Canada" }, { value: "FR", label: "France" }] },
          rules: { defaultValue: { kind: "literal", value: "CA" } }
        },
        { id: "province", type: "radio", configuration: { label: "Province", data: { sourceId: "provinces" } } },
        { id: "contact", type: "checkboxes", configuration: { label: "Contact by", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } },
        { id: "born", type: "date", configuration: { label: "Born" } },
        { id: "scan", type: "file", configuration: { label: "Scan", storage: "base64" } },
        { id: "photos", type: "file", configuration: { label: "Photos", multiple: true } },
        {
          id: "details",
          type: "fieldset",
          configuration: { label: "Details" },
          children: {
            content: [
              {
                id: "billing_address",
                type: "container",
                configuration: { label: "Billing", dataKey: "billing" },
                children: { content: [{ id: "billing_street", type: "text", configuration: { label: "Street", dataKey: "street" } }] }
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
                collection: { collectionPath: "order.items" },
                children: {
                  content: [
                    { id: "item_name", type: "text", configuration: { label: "Item", dataKey: "name", required: true } },
                    { id: "qty", type: "number", configuration: { label: "Qty" } }
                  ]
                }
              }
            ]
          }
        },
        {
          id: "lines",
          type: "panel",
          configuration: { label: "Lines" },
          collection: { collectionPath: "shipment.lines" },
          children: { content: [{ id: "code", type: "text", configuration: {} }] }
        },
        {
          id: "grid",
          type: "dataGrid",
          configuration: { label: "Rows" },
          collection: { collectionPath: "rows" },
          children: { content: [{ id: "a", type: "number", configuration: { label: "A" } }] }
        },
        { id: "send", type: "button", configuration: { label: "Send" } }
      ]
    }
  };
}

const node = (path: string): DataModelNode => {
  const found = indexDataModel(dataModelFromForm(form())).get(path);
  if (!found) {
    throw new Error(`no node at ${path}`);
  }
  return found;
};

describe("the data model a form describes", () => {
  it("places every answer where it is stored, and leaves out what stores none", () => {
    const model = dataModelFromForm(form());
    expect(model.source).toBe("form");
    expect(model.title).toBe("Order");
    expect(model.root.children!.map((child) => child.key)).toEqual([
      "fullName",
      "notes",
      "age",
      "agree",
      "country",
      "province",
      "contact",
      "born",
      "scan",
      "photos",
      "billing",
      "order",
      "shipment",
      "rows"
    ]);
    expect(indexDataModel(model).has("intro")).toBe(false);
    expect(indexDataModel(model).has("send")).toBe(false);
  });

  it("reads each type's kind, its constraints, its label and its choices", () => {
    expect(node("fullName")).toMatchObject({
      kind: "string",
      required: true,
      label: "Full name",
      pattern: "[A-Za-z ]+",
      minLength: 2,
      maxLength: 40,
      componentId: "fullName",
      componentType: "text"
    });
    expect(node("notes")).toMatchObject({ kind: "string", format: "multiline" });
    expect(node("age")).toMatchObject({ kind: "number", minimum: 0, maximum: 130 });
    expect(node("agree")).toMatchObject({ kind: "boolean", requiredWhen: true });
    expect(node("agree").required).toBeUndefined();
    expect(node("country")).toMatchObject({ kind: "string", default: "CA", options: [{ value: "CA", label: "Canada" }, { value: "FR", label: "France" }] });
    expect(node("province")).toMatchObject({ kind: "string", optionsSource: "provinces" });
    expect(node("contact")).toMatchObject({
      kind: "object",
      format: "flags",
      children: [
        { key: "email", kind: "boolean", label: "Email" },
        { key: "phone", kind: "boolean", label: "Phone" }
      ]
    });
    expect(node("born")).toMatchObject({ kind: "string", format: "date" });
    expect(node("scan")).toMatchObject({ kind: "file" });
    expect(node("photos")).toMatchObject({ kind: "array", items: { kind: "file" } });
  });

  it("nests under data-scoping containers by their keys, and says the component when the key is not its id", () => {
    expect(node("billing")).toMatchObject({ kind: "object", componentId: "billing_address", label: "Billing" });
    expect(node("billing.street")).toMatchObject({ kind: "string", componentId: "billing_street" });
  });

  it("files a section's entries at its collection path, under the container that holds it or an object nothing stands for", () => {
    const items = node("order.items");
    expect(items).toMatchObject({ kind: "array", componentId: "order_items", collectionPath: "order.items" });
    // The browser draws and collects a section's rows now, so no note says it cannot.
    expect(items.notes?.map((note) => note.code) ?? []).not.toContain("browser-section");
    expect(node("order.items[].name")).toMatchObject({ kind: "string", componentId: "item_name", required: true });
    expect(node("order.items[].name").notes?.map((note) => note.code)).toEqual(["required-in-entry"]);
    expect(node("order.items[].qty")).toMatchObject({ kind: "number" });

    expect(node("shipment")).toMatchObject({ kind: "object", implicit: true });
    expect(node("shipment").componentId).toBeUndefined();
    expect(node("shipment.lines").notes?.map((note) => note.code)).toEqual(["section-path"]);
    // A data grid reads as a collection like a section: rows at its collection path, its children the entry's fields.
    expect(node("rows")).toMatchObject({ kind: "array", componentId: "grid", componentType: "dataGrid", collectionPath: "rows" });
    expect(node("rows[].a")).toMatchObject({ kind: "number", label: "A", componentId: "a" });
  });

  it("notes a section filed away from the container it sits in", () => {
    const model = dataModelFromForm({
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "order",
            type: "container",
            configuration: {},
            children: { content: [{ id: "items", type: "panel", configuration: {}, collection: {}, children: { content: [] } }] }
          }
        ]
      }
    });
    const items = indexDataModel(model).get("items")!;
    expect(items.notes?.find((note) => note.code === "section-path")?.message).toBe(
      "Stored at items, not under order: a section's entries live at its collection path as written."
    );
  });

  it("marks the places two components would share", () => {
    const model = dataModelFromForm({
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "a", type: "text", configuration: { dataKey: "same" } }, { id: "b", type: "text", configuration: { dataKey: "same" } }] }
    });
    const [first, second] = model.root.children!;
    expect(first!.notes?.[0]).toMatchObject({ code: "duplicate-path", level: "warning" });
    expect(second!.notes?.[0]).toMatchObject({ code: "duplicate-path" });
  });

  it("lets a host classify its own types, and reads an unknown leaf as an answer of unknown kind", () => {
    const tree: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "stars", type: "rating-stars", configuration: { label: "Stars" } },
          { id: "card", type: "gcds-card", configuration: {}, children: { content: [{ id: "inside", type: "text", configuration: {} }] } }
        ]
      }
    };
    expect(indexDataModel(dataModelFromForm(tree)).get("stars")).toMatchObject({ kind: "unknown" });
    expect(indexDataModel(dataModelFromForm(tree)).get("inside")).toMatchObject({ kind: "string" });
    const hosted = dataModelFromForm(tree, { classify: (node) => (node.type === "rating-stars" ? { role: "value", kind: "integer" } : undefined) });
    expect(indexDataModel(hosted).get("stars")).toMatchObject({ kind: "integer" });
  });
});

describe("keys and words", () => {
  it("makes a usable key of any name, keeping usable ones as they are", () => {
    expect(dataKeyFromName("street")).toBe("street");
    expect(dataKeyFromName("_id")).toBe("_id");
    expect(dataKeyFromName("first name")).toBe("first_name");
    expect(dataKeyFromName(" Café ")).toBe("Cafe");
    expect(dataKeyFromName("a.b[0]")).toBe("a_b_0");
    expect(dataKeyFromName("2024")).toBe("_2024");
    expect(dataKeyFromName("!!!")).toBe("field");
  });

  it("keeps an object's keys unique, noting each one that changed", () => {
    const keys = assignKeys(["first name", "first_name", "ok"]);
    expect(keys.map((entry) => entry.key)).toEqual(["first_name", "first_name_2", "ok"]);
    expect(keys[0]!.note?.code).toBe("renamed");
    expect(keys[1]!.note?.message).toContain('"first_name_2"');
    expect(keys[2]!.note).toBeUndefined();
  });

  it("puts a key into words", () => {
    expect(humanizeKey("firstName")).toBe("First name");
    expect(humanizeKey("address_line_1")).toBe("Address line 1");
    expect(humanizeKey("postalCODE")).toBe("Postal CODE");
    expect(humanizeKey("SIN")).toBe("SIN");
    expect(humanizeKey("e-mail")).toBe("E mail");
  });
});
