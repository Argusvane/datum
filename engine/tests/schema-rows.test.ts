import { describe, expect, it } from "vitest";

import { buildSchemaTable, filterSchemaRows } from "../form-engine/builder/data/schema-rows.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";

/** The Data workspace's schema table: rows from the form's data model, with steps and journey pages. */

const text = (id: string, label: string, extra: Partial<ComponentNode> = {}): ComponentNode => ({
  id,
  type: "text",
  configuration: { label },
  ...extra
});

function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "wizard",
          type: "steps",
          configuration: {},
          children: {
            content: [
              {
                id: "applicant",
                type: "step",
                configuration: { label: "Applicant" },
                children: { content: [text("name", "Full name", { configuration: { label: "Full name", required: true, maxLength: 120, minLength: 2 } })] }
              },
              {
                id: "business",
                type: "step",
                configuration: { label: "Business details" },
                children: {
                  content: [
                    {
                      id: "structure",
                      type: "select",
                      configuration: {
                        label: "Business structure",
                        options: [
                          { value: "sole", label: "Sole proprietorship" },
                          { value: "partnership", label: "Partnership" },
                          { value: "corporation", label: "Corporation" }
                        ]
                      }
                    },
                    text("agent", "Registered agent", { rules: { visibleWhen: { kind: "binary", operator: "eq", left: { kind: "path", path: "structure" }, right: { kind: "literal", value: "partnership" } } } }),
                    { id: "employees", type: "number", configuration: { label: "Number of employees" } },
                    text("bn", "Business number", {
                      rules: { requiredWhen: { kind: "binary", operator: "gt", left: { kind: "path", path: "employees" }, right: { kind: "literal", value: 0 } } }
                    }),
                    { id: "fee", type: "number", configuration: { label: "Licence fee" }, rules: { value: { kind: "literal", value: 120 } } },
                    { id: "start", type: "date", configuration: { label: "Start date", dataKey: "start_date" } }
                  ]
                }
              }
            ]
          }
        }
      ]
    }
  };
}

describe("buildSchemaTable", () => {
  it("draws a row per stored answer, with where it is saved, its kind and whether it is required", () => {
    const table = buildSchemaTable(form());
    expect(table.rows.map((row) => [row.label, row.path, row.typeText, row.requiredText])).toEqual([
      ["Full name", "name", "Text, 2 to 120 characters", "Yes"],
      ["Business structure", "structure", "One of 3", "No"],
      ["Registered agent", "agent", "Text", "No"],
      ["Number of employees", "employees", "Number", "No"],
      ["Business number", "bn", "Text", "When Number of employees > 0"],
      ["Licence fee", "fee", "Number", "—"],
      ["Start date", "start_date", "Date", "No"]
    ]);
  });

  it("marks answers a rule shows and answers worked out", () => {
    const rows = buildSchemaTable(form()).rows;
    expect(rows.find((row) => row.componentId === "agent")!.badges.map((badge) => badge.text)).toEqual(["Shown by a rule"]);
    const fee = rows.find((row) => row.componentId === "fee")!;
    expect(fee.required).toBe("calculated");
    expect(fee.badges.map((badge) => badge.kind)).toEqual(["calculated"]);
  });

  it("puts each answer on its step, and filters by step", () => {
    const table = buildSchemaTable(form());
    expect(table.steps).toEqual([
      { id: "step:applicant", label: "Applicant" },
      { id: "step:business", label: "Business details" }
    ]);
    expect(filterSchemaRows(table, "step:applicant").map((row) => row.componentId)).toEqual(["name"]);
    expect(filterSchemaRows(table, "step:business")).toHaveLength(6);
    expect(filterSchemaRows(table, "all")).toHaveLength(7);
  });

  it("lists the journeys' pages and the answers each draws, subtrees included", () => {
    const definition = {
      id: "f",
      version: "1",
      root: form(),
      journey: {
        journeys: [
          {
            id: "apply",
            name: "Apply online",
            pages: [
              { id: "p1", title: "About you", components: ["name"] },
              { id: "p2", components: ["business"] }
            ]
          }
        ]
      }
    } as unknown as FormDefinition;
    const table = buildSchemaTable(form(), { definition });
    expect(table.pages).toEqual([
      { id: "page:apply/p1", label: "About you", group: "Apply online" },
      { id: "page:apply/p2", label: "Business details", group: "Apply online" }
    ]);
    expect(filterSchemaRows(table, "page:apply/p1").map((row) => row.componentId)).toEqual(["name"]);
    expect(filterSchemaRows(table, "page:apply/p2")).toHaveLength(6);
  });

  it("marks a repeating section's fields and names a group of ticks by its count", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "owners",
            type: "panel",
            configuration: { label: "Owners" },
            collection: { collectionPath: "owners" },
            children: { content: [text("ownerName", "Owner name")] }
          },
          {
            id: "services",
            type: "checkboxes",
            configuration: { label: "Services", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }
          }
        ]
      }
    } as ComponentNode;
    const rows = buildSchemaTable(root).rows;
    const owner = rows.find((row) => row.componentId === "ownerName")!;
    expect(owner.path).toBe("owners[].ownerName");
    expect(owner.typeText).toBe("Text, repeating");
    expect(rows.find((row) => row.componentId === "services")!.typeText).toBe("Any of 2");
    expect(rows.filter((row) => row.componentId === "services")).toHaveLength(1);
  });

  it("draws a row for an answer stored as a list of values: a multiselect, several files", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "tags",
            type: "multiselect",
            configuration: { label: "Tags", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }
          },
          { id: "docs", type: "file", configuration: { label: "Documents", multiple: true } },
          text("name", "Name")
        ]
      }
    } as ComponentNode;
    const rows = buildSchemaTable(root).rows;
    expect(rows.map((row) => [row.componentId, row.path, row.typeText])).toEqual([
      ["tags", "tags", "Any of 2"],
      ["docs", "docs", "List"],
      ["name", "name", "Text"]
    ]);
  });

  it("reads a list of values whose options come from a data source as any of a list", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "tags", type: "multiselect", configuration: { label: "Tags", data: { sourceId: "tagList" } } },
          { id: "size", type: "select", configuration: { label: "Size", data: { sourceId: "sizes" } } }
        ]
      }
    } as ComponentNode;
    expect(buildSchemaTable(root).rows.map((row) => [row.componentId, row.typeText])).toEqual([
      ["tags", "Any of a list"],
      ["size", "One of a list"]
    ]);
  });
});
