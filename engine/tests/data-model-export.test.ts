import { describe, expect, it } from "vitest";

import {
  JSON_SCHEMA_DIALECT,
  compareDataModels,
  dataModelExample,
  dataModelFromForm,
  dataModelToJsonSchema,
  readDataModelInput
} from "../form-engine/builder/data-model/index.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/** Every standard value type, a keyed container, a section under a dotted path, and a required-when rule. */
function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name", required: true, pattern: "[A-Za-z ]+", minLength: 2 } },
        { id: "notes", type: "textarea", configuration: { label: "Notes" } },
        { id: "age", type: "number", configuration: { label: "Age", min: 0 } },
        { id: "agree", type: "checkbox", configuration: { label: "Agree" }, rules: { requiredWhen: "true" } },
        { id: "country", type: "select", configuration: { label: "Country", options: [{ value: "CA", label: "Canada" }, { value: "FR", label: "France" }] } },
        { id: "size", type: "radio", configuration: { label: "Size", options: [{ value: "s" }, { value: "m" }] } },
        { id: "source", type: "radio", configuration: { label: "Source", data: { sourceId: "sources" } } },
        { id: "contact", type: "checkboxes", configuration: { label: "Contact", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } },
        { id: "topics", type: "checkboxes", configuration: { label: "Topics", data: { sourceId: "topics" } } },
        { id: "born", type: "date", configuration: { label: "Born" } },
        { id: "scan", type: "file", configuration: { label: "Scan" } },
        { id: "photos", type: "file", configuration: { label: "Photos", multiple: true } },
        {
          id: "billing_address",
          type: "container",
          configuration: { label: "Billing", dataKey: "billing" },
          children: { content: [{ id: "billing_street", type: "text", configuration: { label: "Street", dataKey: "street", required: true } }] }
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
                children: { content: [{ id: "item_name", type: "text", configuration: { label: "Item", dataKey: "name" } }, { id: "qty", type: "number", configuration: {} }] }
              }
            ]
          }
        },
        { id: "send", type: "button", configuration: { label: "Send" } }
      ]
    }
  };
}

describe("a data model as a JSON Schema", () => {
  it("writes the nested document the form's answers describe", () => {
    const schema = dataModelToJsonSchema(dataModelFromForm(form()));
    expect(schema.$schema).toBe(JSON_SCHEMA_DIALECT);
    expect(schema.title).toBe("Intake");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["fullName"]);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["fullName", "notes", "age", "agree", "country", "size", "source", "contact", "topics", "born", "scan", "photos", "billing", "order"]);
    expect(properties.fullName).toEqual({ title: "Full name", type: "string", pattern: "^(?:[A-Za-z ]+)$", minLength: 2 });
    expect(properties.age).toEqual({ title: "Age", type: "number", minimum: 0 });
    expect(properties.agree).toEqual({ title: "Agree", description: "Required when a rule of the form says so.", type: "boolean" });
    expect(properties.country).toEqual({
      title: "Country",
      type: "string",
      oneOf: [
        { const: "CA", title: "Canada" },
        { const: "FR", title: "France" }
      ]
    });
    expect(properties.size).toEqual({ title: "Size", type: "string", enum: ["s", "m"] });
    expect(properties.source).toEqual({ title: "Source", type: "string" });
    expect(properties.contact).toEqual({
      title: "Contact",
      type: "object",
      properties: { email: { title: "Email", type: "boolean" }, phone: { title: "Phone", type: "boolean" } },
      required: ["email", "phone"],
      additionalProperties: false
    });
    expect(properties.topics).toEqual({ title: "Topics", type: "object", additionalProperties: { type: "boolean" } });
    expect(properties.born).toEqual({ title: "Born", type: "string", format: "date" });
    expect(properties.scan).toEqual({ title: "Scan", $ref: "#/$defs/attachment" });
    expect(properties.photos).toEqual({ title: "Photos", type: "array", items: { $ref: "#/$defs/attachment" } });
    expect(properties.billing).toMatchObject({ type: "object", required: ["street"], properties: { street: { type: "string" } } });
    expect(properties.order).toMatchObject({
      type: "object",
      properties: { items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, qty: { type: "number" } } } } }
    });
    expect(schema.$defs).toMatchObject({ attachment: { required: ["storage", "name", "type", "size"] } });
  });

  it("shows one document the model allows", () => {
    const example = dataModelExample(dataModelFromForm(form()));
    expect(example).toEqual({
      fullName: "text",
      notes: "text",
      age: 0,
      agree: false,
      country: "CA",
      size: "s",
      source: "text",
      contact: { email: false, phone: false },
      topics: {},
      born: "2026-01-31",
      scan: { storage: "base64", name: "document.pdf", type: "application/pdf", size: 0 },
      photos: [{ storage: "base64", name: "document.pdf", type: "application/pdf", size: 0 }],
      billing: { street: "text" },
      order: { items: [{ name: "text", qty: 0 }] }
    });
  });

  it("reads back as the same model: every place present, none new, none differing", () => {
    const formModel = dataModelFromForm(form());
    const read = readDataModelInput(JSON.stringify(dataModelToJsonSchema(formModel)));
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.readAs).toBe("schema");
    const comparison = compareDataModels(formModel, read.model);
    expect(comparison.counts).toMatchObject({ new: 0, "kind-differs": 0, "form-only": 0 });
    expect(comparison.entries.every((entry) => entry.status === "present")).toBe(true);
    // Required and choices survive the trip.
    expect(comparison.byPath.get("billing.street")?.incoming?.required).toBe(true);
    expect(comparison.byPath.get("country")?.incoming?.options).toEqual([{ value: "CA", label: "Canada" }, { value: "FR", label: "France" }]);
    expect(comparison.byPath.get("fullName")?.incoming?.pattern).toBe("[A-Za-z ]+");
  });
});
