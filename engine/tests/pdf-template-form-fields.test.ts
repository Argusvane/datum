import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { GenerateOptions } from "../form-engine/builder/data-model/index.js";
import { bindableComponents } from "../form-engine/builder/pdf-designer/pdf-designer.js";
import { planTemplateFormFields, templateFieldsInReadingOrder } from "../form-engine/builder/pdf-designer/template-mode.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { PdfTemplateFieldInfo } from "../form-engine/render/pdf/pdf-abi.js";

/** A template field at a spot on a page (PDF space: y grows upwards). */
function field(name: string, kind: PdfTemplateFieldInfo["kind"], at?: { page: number; x: number; y: number }, extra: Partial<PdfTemplateFieldInfo> = {}): PdfTemplateFieldInfo {
  return {
    name,
    kind,
    readOnly: false,
    required: false,
    ...(at ? { page: at.page, rect: { x: at.x, y: at.y, width: 120, height: 20 } } : {}),
    ...extra
  };
}

function form(content: ComponentNode[]): ComponentNode {
  return { id: "root", type: "form", configuration: { title: "Intake" }, children: { content } };
}

const submit: ComponentNode = { id: "submit", type: "button", configuration: { label: "Send", action: "submit" } };

function generateOptions(controller: BuilderController): GenerateOptions {
  return { hasType: (type) => controller.hasComponentType(type), template: (type) => controller.componentTemplate(type) };
}

function plan(fields: PdfTemplateFieldInfo[], root: ComponentNode) {
  const controller = new BuilderController({ initialRoot: root });
  return planTemplateFormFields(fields, root, bindableComponents(root, "en"), generateOptions(controller));
}

describe("a template's fields in reading order", () => {
  it("reads page by page, rows top to bottom, left to right, and puts unplaced fields last", () => {
    const fields = [
      field("second-page", "text", { page: 2, x: 20, y: 700 }),
      field("unplaced", "text"),
      field("right", "text", { page: 1, x: 300, y: 702 }),
      field("lower", "text", { page: 1, x: 20, y: 600 }),
      field("left", "text", { page: 1, x: 20, y: 700 }),
      field("top", "text", { page: 1, x: 200, y: 760 })
    ];
    // "right" sits 2 points above "left": the same row, so left before right.
    expect(templateFieldsInReadingOrder(fields).map((entry) => entry.name)).toEqual(["top", "left", "right", "lower", "second-page", "unplaced"]);
  });
});

describe("form fields for a template's fields", () => {
  it("builds a field per answer-holding PDF field, in reading order, before the closing buttons", () => {
    const root = form([{ id: "fullName", type: "text", configuration: { label: "Full name" } }, submit]);
    const result = plan(
      [
        field("Full Name", "text", { page: 1, x: 20, y: 740 }),
        field("topmostSubform[0].Page1[0].Email[0]", "text", { page: 1, x: 20, y: 700 }, { required: true, tooltip: "Email address" } as Partial<PdfTemplateFieldInfo>),
        field("Notes", "text", { page: 1, x: 20, y: 660 }, { multiline: true, maxLength: 500 }),
        field("Agree", "checkbox", { page: 1, x: 20, y: 620 }, { exportValues: ["Yes"], required: true }),
        field("Colour", "radio", { page: 1, x: 20, y: 580 }, { options: ["Red", "Green", "Blue", "Cyan", "Magenta", "Yellow"] }),
        field("Country", "dropdown", { page: 1, x: 20, y: 540 }, { options: ["CA", "FR"] }),
        field("Signature1", "signature", { page: 1, x: 20, y: 100 }),
        field("Print", "button", { page: 1, x: 300, y: 100 }),
        field("OfficeUse", "text", { page: 1, x: 20, y: 60 }, { readOnly: true })
      ],
      root
    );

    // "Full Name" matches the form's fullName, as Suggest mappings would: filled from it, nothing built.
    expect(result.matched).toBe(1);
    expect(result.mappings[0]).toEqual({ pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } });

    const built = result.entries.map((entry) => ({ id: entry.node.id, type: entry.node.type, index: entry.index, parent: entry.parentId }));
    expect(built).toEqual([
      { id: "Email", type: "text", index: 1, parent: "root" },
      { id: "Notes", type: "textarea", index: 2, parent: "root" },
      { id: "Agree", type: "checkbox", index: 3, parent: "root" },
      // A PDF radio group stays one, however many choices; a dropdown is a select, however few.
      { id: "Colour", type: "radio", index: 4, parent: "root" },
      { id: "Country", type: "select", index: 5, parent: "root" }
    ]);
    const [email, notes, agree, colour] = result.entries.map((entry) => entry.node.configuration as Record<string, unknown>);
    expect(email).toMatchObject({ label: "Email address", required: true });
    expect(notes).toMatchObject({ label: "Notes", maxLength: 500 });
    // A checkbox is never required: false is an answer.
    expect(agree).toMatchObject({ label: "Agree" });
    expect(agree!.required).toBeUndefined();
    expect((colour!.options as Array<{ value: string }>).map((option) => option.value)).toEqual(["Red", "Green", "Blue", "Cyan", "Magenta", "Yellow"]);

    expect(result.mappings.slice(1)).toEqual([
      { pdfField: "topmostSubform[0].Page1[0].Email[0]", source: { kind: "component", componentId: "Email" } },
      { pdfField: "Notes", source: { kind: "component", componentId: "Notes" } },
      { pdfField: "Agree", source: { kind: "component", componentId: "Agree" }, checkedValue: "Yes" },
      { pdfField: "Colour", source: { kind: "component", componentId: "Colour" } },
      { pdfField: "Country", source: { kind: "component", componentId: "Country" } }
    ]);
    expect(result.skipped.map((entry) => entry.pdfField)).toEqual(["Signature1", "Print", "OfficeUse"]);
    expect(result.skipped.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("keeps keys unique against the form and each other, and a long tooltip as the description with its first clause the label", () => {
    // Keys the form already stores under, on fields whose ids and labels match no PDF field.
    const root = form([
      { id: "taken", type: "text", configuration: { label: "Taken", dataKey: "f1_01" } },
      { id: "other", type: "text", configuration: { label: "Other", dataKey: "given" } },
      { id: "more", type: "text", configuration: { label: "More", dataKey: "given_2" } }
    ]);
    const longTip = "Enter the name exactly as it appears on the certificate issued to you, including any middle names.";
    const result = plan(
      [
        field("topmostSubform[0].Page1[0].f1_01[0]", "text", { page: 1, x: 20, y: 700 }),
        // Another box on another page: another question (one in the same box is the same one).
        field("topmostSubform[0].Page2[0].f1_01[0]", "text", { page: 2, x: 20, y: 650 }),
        field("given", "text", { page: 2, x: 20, y: 600 }, { tooltip: longTip } as Partial<PdfTemplateFieldInfo>)
      ],
      root
    );
    // "f1_01", "given" and "given_2" are keys on the form already: each built field takes the next free one.
    expect(result.entries.map((entry) => entry.node.id)).toEqual(["f1_01_2", "f1_01_3", "given_3"]);
    const given = result.entries[2]!.node.configuration as Record<string, unknown>;
    expect(given).toMatchObject({ label: "Enter the name exactly as it appears on the certificate issued to you", description: longTip });
    expect(result.entries.every((entry) => (entry.node.configuration as Record<string, unknown>).dataKey === undefined)).toBe(true);
  });

  it("puts the fields into the last step of a multi-step form", () => {
    const root = form([
      {
        id: "wizard",
        type: "steps",
        configuration: {},
        children: {
          content: [
            { id: "one", type: "step", configuration: { label: "One" }, children: { content: [] } },
            { id: "two", type: "step", configuration: { label: "Two" }, children: { content: [] } }
          ]
        }
      }
    ]);
    const result = plan([field("Name", "text", { page: 1, x: 20, y: 700 })], root);
    expect(result.entries).toEqual([expect.objectContaining({ parentId: "two", slotId: "content" })]);
    expect(result.entries[0]!.index).toBeUndefined();
  });
});

describe("several properties as one undo entry", () => {
  it("writes each value and takes them all back with one undo", () => {
    const controller = new BuilderController({
      initialRoot: form([
        { id: "a", type: "text", configuration: { label: "A" } },
        { id: "b", type: "text", configuration: { label: "B" } }
      ])
    });
    controller.setProperties([
      { componentId: "a", propertyPath: "label", value: "First" },
      { componentId: "b", propertyPath: "label", value: "Second" },
      { componentId: "b", propertyPath: "placeholder", value: "Type here" }
    ]);
    const labels = () => controller.snapshot().children!.content!.map((node) => node.configuration);
    expect(labels()).toEqual([{ label: "First" }, { label: "Second", placeholder: "Type here" }]);
    controller.undo();
    expect(labels()).toEqual([{ label: "A" }, { label: "B" }]);
  });

  it("checks every id before writing anything", () => {
    const controller = new BuilderController({ initialRoot: form([{ id: "a", type: "text", configuration: { label: "A" } }]) });
    expect(() =>
      controller.setProperties([
        { componentId: "a", propertyPath: "label", value: "First" },
        { componentId: "missing", propertyPath: "label", value: "Nope" }
      ])
    ).toThrow(/Component not found: missing/);
    expect(controller.snapshot().children!.content![0]!.configuration).toEqual({ label: "A" });
    expect(controller.canUndo()).toBe(false);
  });
});
