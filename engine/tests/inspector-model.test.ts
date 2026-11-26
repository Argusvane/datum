import { describe, expect, it } from "vitest";

import { buildInspectorModel } from "../form-engine/builder/property-editor/inspector-model.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { PRINT_OPTION_FIELDS, printOptionsCapability } from "../form-engine/registry/capabilities/field-capabilities.js";
import type {
  CapabilityDefinition,
  PropertyEditorDefinition
} from "../form-engine/core/schema/contracts.js";

const node: ComponentNode = {
  id: "email",
  type: "text",
  configuration: { label: "Email", required: true, maxSuggestions: 120 }
};

describe("buildInspectorModel", () => {
  it("falls back to label/required when no capabilities contribute fields", () => {
    const model = buildInspectorModel(node);
    expect(model.mode).toBe("default");
    expect(model.nodeId).toBe("email");
    // A flat editor is gathered into the natural sections: text first, then where the answer
    // is stored, then validation.
    expect(model.sections.map((s) => s.id)).toEqual(["content", "data", "validation"]);
    const fields = model.sections.flatMap((s) => s.fields);
    expect(fields.map((f) => f.propertyPath)).toEqual(["label", "description", "dataKey", "hiddenValueBehavior", "required"]);
    // Blank, the key is the id, and the box says so.
    expect(fields.find((f) => f.propertyPath === "dataKey")).toMatchObject({ control: "text", placeholder: "email" });
    expect(fields.find((f) => f.propertyPath === "label")?.value).toBe("Email");
    expect(fields.find((f) => f.propertyPath === "required")?.control).toBe("checkbox");
    expect(fields.find((f) => f.propertyPath === "required")?.value).toBe(true);
  });

  it("composes capability-contributed fields and reads their current values", () => {
    const capability: CapabilityDefinition = {
      id: "text-input",
      version: "1.0.0",
      configureEditor: () => ({
        fields: [
          { id: "label", type: "text", propertyPath: "label", label: "Label" },
          {
            id: "maxSuggestions",
            type: "number",
            propertyPath: "maxSuggestions",
            label: "Max suggestions"
          }
        ]
      })
    } as unknown as CapabilityDefinition;

    const model = buildInspectorModel(node, [capability]);
    const fields = model.sections.flatMap((s) => s.fields);
    expect(fields.map((f) => f.propertyPath)).toEqual(["label", "maxSuggestions"]);
    expect(fields.find((f) => f.propertyPath === "maxSuggestions")).toMatchObject({
      control: "number",
      value: 120
    });
    // A field the natural groups do not recognise lands in the component's own Settings.
    expect(
      model.sections.find((s) => s.id === "settings")?.fields.map((f) => f.propertyPath)
    ).toEqual(["maxSuggestions"]);
  });

  it("groups a flat editor's fields into natural sections, skipping empty ones", () => {
    const capability: CapabilityDefinition = {
      id: "standard-ish",
      version: "1.0.0",
      configureEditor: () => ({
        fields: [
          { id: "label", type: "text", propertyPath: "label", label: "Label" },
          { id: "required", type: "boolean", propertyPath: "required", label: "Required" },
          { id: "disabled", type: "boolean", propertyPath: "disabled", label: "Disabled" },
          { id: "cssClass", type: "text", propertyPath: "cssClass", label: "CSS classes" },
          { id: "max", type: "number", propertyPath: "max", label: "Stars" }
        ]
      })
    } as unknown as CapabilityDefinition;

    const model = buildInspectorModel(node, [capability]);
    expect(model.sections.map((s) => ({ id: s.id, title: s.title }))).toEqual([
      { id: "content", title: "Content" },
      { id: "settings", title: "Settings" },
      { id: "validation", title: "Validation" },
      { id: "behavior", title: "Behavior" },
      { id: "presentation", title: "Presentation" }
    ]);
    expect(model.sections[1]?.fields.map((f) => f.propertyPath)).toEqual(["max"]);
    expect(model.sections[4]?.fields.map((f) => f.propertyPath)).toEqual(["cssClass"]);
  });

  it("gathers a data grid's row settings under their own Rows heading, after Content and before Behavior", () => {
    const grid: ComponentNode = {
      id: "people",
      type: "dataGrid",
      configuration: { label: "People", minRows: 1, maxRows: 5, canReorder: true },
      collection: { collectionPath: "people" }
    };
    const editor: PropertyEditorDefinition = {
      mode: "replace",
      fields: [
        { id: "label", type: "localized-text", propertyPath: "label", label: "Label" },
        {
          id: "layout",
          type: "select",
          propertyPath: "layout",
          label: "Layout",
          defaultValue: "auto",
          choices: [{ value: "auto", label: "Automatic" }, { value: "table", label: "Table" }, { value: "stacked", label: "Stacked" }]
        },
        { id: "canAdd", type: "boolean", propertyPath: "canAdd", label: "Add rows", defaultValue: true },
        { id: "addLabel", type: "localized-text", propertyPath: "addLabel", label: "Add button label" },
        { id: "canRemove", type: "boolean", propertyPath: "canRemove", label: "Remove rows", defaultValue: true },
        { id: "removeLabel", type: "localized-text", propertyPath: "removeLabel", label: "Remove button label" },
        { id: "canReorder", type: "boolean", propertyPath: "canReorder", label: "Reorder rows" },
        { id: "minRows", type: "number", propertyPath: "minRows", label: "Minimum rows" },
        { id: "maxRows", type: "number", propertyPath: "maxRows", label: "Maximum rows" },
        { id: "initialRows", type: "number", propertyPath: "initialRows", label: "Rows to start with" },
        { id: "emptyText", type: "localized-text", propertyPath: "emptyText", label: "Empty text" },
        { id: "disabled", type: "boolean", propertyPath: "disabled", label: "Disabled" }
      ]
    };
    const model = buildInspectorModel(grid, [], editor);
    expect(model.sections.map((s) => ({ id: s.id, title: s.title }))).toEqual([
      { id: "content", title: "Content" },
      { id: "rows", title: "Rows" },
      { id: "behavior", title: "Behavior" }
    ]);
    const rows = model.sections.find((s) => s.id === "rows")!;
    expect(rows.fields.map((f) => f.propertyPath)).toEqual([
      "layout", "canAdd", "addLabel", "canRemove", "removeLabel", "canReorder", "minRows", "maxRows", "initialRows", "emptyText"
    ]);
    // What the grid has not set shows the default it runs with; what it has set shows that.
    expect(rows.fields.find((f) => f.propertyPath === "layout")).toMatchObject({ control: "select", value: "auto" });
    expect(rows.fields.find((f) => f.propertyPath === "canAdd")).toMatchObject({ control: "checkbox", value: true });
    expect(rows.fields.find((f) => f.propertyPath === "canReorder")).toMatchObject({ value: true });
    expect(rows.fields.find((f) => f.propertyPath === "minRows")).toMatchObject({ control: "number", value: 1 });
    expect(rows.fields.find((f) => f.propertyPath === "maxRows")).toMatchObject({ control: "number", value: 5 });
    // The grid offers no Required: that belongs to the fields in its row.
    expect(model.sections.flatMap((s) => s.fields).some((f) => f.propertyPath === "required")).toBe(false);
  });

  it("offers Show column headings in a data grid's Rows section, and keeps those names out of Rows on any other type", () => {
    const editor: PropertyEditorDefinition = {
      mode: "replace",
      fields: [
        { id: "label", type: "localized-text", propertyPath: "label", label: "Label" },
        { id: "layout", type: "text", propertyPath: "layout", label: "Layout" },
        { id: "showHeader", type: "boolean", propertyPath: "showHeader", label: "Show column headings", defaultValue: true },
        { id: "emptyText", type: "localized-text", propertyPath: "emptyText", label: "Empty text" },
        { id: "maxRows", type: "number", propertyPath: "maxRows", label: "Maximum rows" }
      ]
    };
    const grid: ComponentNode = { id: "people", type: "dataGrid", configuration: { label: "People", showHeader: false }, collection: { collectionPath: "people" } };
    const gridRows = buildInspectorModel(grid, [], editor).sections.find((s) => s.id === "rows")!;
    expect(gridRows.fields.map((f) => f.propertyPath)).toEqual(["layout", "showHeader", "emptyText", "maxRows"]);
    expect(gridRows.fields.find((f) => f.propertyPath === "showHeader")).toMatchObject({ control: "checkbox", value: false });
    // The names are common ones (a PDF repeat's layout, emptyText, maxRows): by type, not by name.
    const other: ComponentNode = { id: "pdfRepeat", type: "pdfRepeat", configuration: { label: "Repeat" } };
    const otherModel = buildInspectorModel(other, [], editor);
    expect(otherModel.sections.some((s) => s.id === "rows")).toBe(false);
    expect(otherModel.sections.find((s) => s.id === "settings")!.fields.map((f) => f.propertyPath)).toEqual(["layout", "showHeader", "emptyText", "maxRows"]);
  });

  it("draws a localized-text field as a plain string: the default-language text, nothing else", () => {
    const capability: CapabilityDefinition = {
      id: "text-input",
      version: "1.0.0",
      configureEditor: () => ({
        fields: [{ id: "label", type: "localized-text", propertyPath: "label", label: "Label" }]
      })
    } as unknown as CapabilityDefinition;
    const field = buildInspectorModel({ id: "send", type: "button", configuration: { label: "Submit" } }, [capability]).sections[0]?.fields[0];
    expect(field?.control).toBe("localized-text");
    expect(field?.value).toBe("Submit");
    expect(field).not.toHaveProperty("localized");
  });

  it("leaves a text-declared field alone: a plain text box, whatever its value", () => {
    const capability: CapabilityDefinition = {
      id: "text-input",
      version: "1.0.0",
      configureEditor: () => ({
        fields: [{ id: "label", type: "text", propertyPath: "label", label: "Label" }]
      })
    } as unknown as CapabilityDefinition;

    const field = buildInspectorModel(node, [capability]).sections[0]?.fields[0];
    expect(field?.control).toBe("text");
    expect(field).not.toHaveProperty("localized");
  });

  it("gives a file-declared field the file control, its accept list and the stored envelope as the value", () => {
    const capability: CapabilityDefinition = {
      id: "icc",
      version: "1.0.0",
      configureEditor: () => ({
        fields: [{ id: "profile", type: "file", propertyPath: "conformance.outputIntent.profile", label: "Output intent profile", accept: ".icc,.icm" }]
      })
    } as unknown as CapabilityDefinition;
    const envelope = { storage: "base64", name: "org.icc", type: "application/vnd.iccprofile", size: 3, data: "AAAA" };
    const withFile: ComponentNode = { id: "doc", type: "pdf-document", configuration: { conformance: { outputIntent: { profile: envelope } } } };
    const field = buildInspectorModel(withFile, [capability]).sections[0]?.fields[0];
    expect(field?.control).toBe("file");
    expect(field?.accept).toBe(".icc,.icm");
    expect(field?.value).toEqual(envelope);
    const empty = buildInspectorModel({ id: "doc", type: "pdf-document", configuration: {} }, [capability]).sections[0]?.fields[0];
    expect(empty?.value).toBeUndefined();
    expect(empty?.accept).toBe(".icc,.icm");

    // Ready-made values come through with their labels resolved in the locale.
    const withChoices: CapabilityDefinition = {
      id: "icc-choices",
      version: "1.0.0",
      configureEditor: () => ({
        fields: [
          {
            id: "profile",
            type: "file",
            propertyPath: "conformance.outputIntent.profile",
            label: "Profile",
            assetChoices: [{ id: "builtin:gray", label: { default: "Gray", locales: { fr: "Gris" } }, group: { default: "Built in", locales: { fr: "Intégrés" } }, source: envelope }]
          }
        ]
      })
    } as unknown as CapabilityDefinition;
    const chosen = buildInspectorModel(withFile, [withChoices], undefined, "fr").sections[0]?.fields[0];
    expect(chosen?.assetChoices).toEqual([{ id: "builtin:gray", label: "Gris", group: "Intégrés", source: envelope }]);
  });

  it("uses form-level defaults (no label / required) for the form root", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { title: "Intake", description: "Tell us about you" }
    };
    const model = buildInspectorModel(root);
    expect(model.nodeType).toBe("form");
    expect(model.sections[0]?.title).toBe("Form settings");
    const paths = model.sections[0]?.fields.map((f) => f.propertyPath) ?? [];
    expect(paths).toEqual(["title", "description"]);
    expect(paths).not.toContain("label");
    expect(paths).not.toContain("required");
    expect(model.sections[0]?.fields.find((f) => f.propertyPath === "title")?.value).toBe("Intake");
  });

  it("gives the form root its validation messages under Validation, as a table-editor row", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {
        title: "Intake",
        // An entry whose text is not a string is no message: it is not listed.
        messages: { required: "Fill this in", minLength: "Too short", stray: { default: "Old shape", locales: {} } }
      }
    };
    const model = buildInspectorModel(root);
    expect(model.sections.map((section) => section.id)).toEqual(["content", "validation", "chrome"]);
    const validation = model.sections.find((section) => section.id === "validation");
    expect(validation?.fields.map((f) => [f.propertyPath, f.control])).toEqual([["messages", "messages"]]);
    const field = validation?.fields[0];
    expect(field?.label).toBe("Validation messages");
    expect(field?.messagesEditor).toEqual({
      entries: [
        { code: "required", text: "Fill this in" },
        { code: "minLength", text: "Too short" }
      ],
      scope: "form",
      // A root with no fields raises nothing yet; every engine code is on offer.
      usedCodes: [],
      engineCodes: expect.arrayContaining([expect.objectContaining({ code: "required" })]),
      hostCodes: [],
      // No host code names a message, so the page words nothing by default.
      defaults: {}
    });
    // A root with no messages still offers the row, empty.
    const bare = buildInspectorModel({ id: "root", type: "form", configuration: {} });
    expect(bare.sections.find((s) => s.id === "validation")?.fields[0]?.messagesEditor?.entries).toEqual([]);
  });

  it("gives the form root no Print section: the form's print settings are the Print workspace's", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { title: "Intake", print: { titleOnFirstPage: false, scale: 0.8, header: { end: "{{date}}" } } }
    };
    const model = buildInspectorModel(root);
    expect(model.sections.some((section) => section.id === "print")).toBe(false);
    const paths = model.sections.flatMap((section) => section.fields.map((field) => field.propertyPath));
    expect(paths.filter((path) => path.startsWith("print."))).toEqual([]);
    expect(buildInspectorModel(node).sections.some((section) => section.id === "print")).toBe(false);
  });

  describe("the On paper group", () => {
    const paperPaths = (model: ReturnType<typeof buildInspectorModel>): string[] =>
      model.sections.find((section) => section.id === "print")?.fields.map((field) => field.propertyPath) ?? [];
    const html: ComponentNode = { id: "intro", type: "html", configuration: { tag: "div", content: "<p>Hi</p>" } };
    const group: ComponentNode = { id: "about", type: "panel", configuration: { label: "About" }, children: { content: [html] } };

    it("is titled On paper and lists Shown, Start on a new page, then the rule behaviour and the note, for a field", () => {
      const model = buildInspectorModel(node, [printOptionsCapability]);
      const section = model.sections.find((entry) => entry.id === "print");
      expect(section?.title).toBe("On paper");
      expect(paperPaths(model)).toEqual(["print.on", "print.breakBefore", "print.show", "print.note"]);
      const fields = section?.fields ?? [];
      expect(fields.map((field) => field.label)).toEqual(["Shown", "Start on a new page", "When a rule hides it", "Note on paper"]);
      expect(fields[0]?.choices.map((choice) => choice.label)).toEqual(["On screen and on paper", "On screen only", "On paper only"]);
      expect(fields[1]?.control).toBe("checkbox");
      expect(fields[2]?.choices.map((choice) => choice.value)).toEqual(["", "always", "answered"]);
    });

    it("offers Keep together to a container and to no field", () => {
      expect(paperPaths(buildInspectorModel(group, [printOptionsCapability], { mode: "replace", fields: [...PRINT_OPTION_FIELDS] }))).toEqual([
        "print.on",
        "print.breakBefore",
        "print.keepTogether",
        "print.show",
        "print.note"
      ]);
      expect(paperPaths(buildInspectorModel(node, [printOptionsCapability]))).not.toContain("print.keepTogether");
      expect(paperPaths(buildInspectorModel(html, [printOptionsCapability]))).not.toContain("print.keepTogether");
    });

    it("disables On paper only, with the reason, for a component that holds an answer", () => {
      const paperChoice = (target: ComponentNode) =>
        buildInspectorModel(target, [printOptionsCapability]).sections.find((entry) => entry.id === "print")?.fields.find((field) => field.propertyPath === "print.on");
      const input = paperChoice(node);
      expect(input?.choices.find((choice) => choice.value === "paper")?.disabled).toBe(true);
      expect(input?.choices.find((choice) => choice.value === "screen")?.disabled).toBeUndefined();
      expect(input?.description).toContain("On paper only is not offered here");
      // Static content takes it, and a container of only static content too.
      expect(paperChoice(html)?.choices.some((choice) => choice.disabled === true)).toBe(false);
      expect(paperChoice(html)?.description).not.toContain("not offered");
      const withAnswer: ComponentNode = { ...group, children: { content: [html, node] } };
      const around = buildInspectorModel(withAnswer, [printOptionsCapability], { mode: "replace", fields: [...PRINT_OPTION_FIELDS] }).sections.find((entry) => entry.id === "print");
      expect(around?.fields.find((field) => field.propertyPath === "print.on")?.choices.find((choice) => choice.value === "paper")?.disabled).toBe(true);
    });

    it("reads a type through the kinds map, so a plugin's container takes Keep together and a plugin's input does not take paper", () => {
      const kinds = { "acme-card": "panel", "acme-pick": "select" };
      const card: ComponentNode = { id: "card", type: "acme-card", configuration: {}, children: { content: [] } };
      const pick: ComponentNode = { id: "pick", type: "acme-pick", configuration: {} };
      expect(paperPaths(buildInspectorModel(card, [printOptionsCapability], { mode: "replace", fields: [...PRINT_OPTION_FIELDS] }, "en", { kinds }))).toContain("print.keepTogether");
      const choice = buildInspectorModel(pick, [printOptionsCapability], undefined, "en", { kinds })
        .sections.find((entry) => entry.id === "print")
        ?.fields.find((field) => field.propertyPath === "print.on")
        ?.choices.find((entry) => entry.value === "paper");
      expect(choice?.disabled).toBe(true);
    });
  });

  it("returns mode 'none' with no sections when the component editor opts out", () => {
    const componentEditor = { mode: "none" } as unknown as PropertyEditorDefinition;
    const model = buildInspectorModel(node, [], componentEditor);
    expect(model.mode).toBe("none");
    expect(model.sections).toEqual([]);
  });

  it("resolves LocalizedText field labels/section titles to the given locale", () => {
    const capability: CapabilityDefinition = {
      id: "text-input",
      version: "1.0.0",
      configureEditor: () => ({
        fields: [
          {
            id: "label",
            type: "text",
            propertyPath: "label",
            label: { default: "Label", locales: { "fr-CA": "Étiquette" } }
          }
        ],
        sections: [
          {
            id: "basics",
            title: { default: "Basics", locales: { "fr-CA": "Fondamentaux" } },
            fieldIds: ["label"]
          }
        ]
      })
    } as unknown as CapabilityDefinition;

    const model = buildInspectorModel(node, [capability], undefined, "fr-CA");
    expect(model.sections[0]?.title).toBe("Fondamentaux");
    expect(model.sections[0]?.fields[0]?.label).toBe("Étiquette");

    const fallback = buildInspectorModel(node, [capability]);
    expect(fallback.sections[0]?.title).toBe("Basics");
    expect(fallback.sections[0]?.fields[0]?.label).toBe("Label");
  });

  it("honors explicit sections and their field ordering", () => {
    const capability: CapabilityDefinition = {
      id: "c",
      version: "1.0.0",
      configureEditor: () => ({
        fields: [
          { id: "label", type: "text", propertyPath: "label", label: "Label" },
          { id: "required", type: "boolean", propertyPath: "required", label: "Required" }
        ],
        sections: [{ id: "basics", title: "Basics", fieldIds: ["required", "label"] }]
      })
    } as unknown as CapabilityDefinition;

    const model = buildInspectorModel(node, [capability]);
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0]?.title).toBe("Basics");
    expect(model.sections[0]?.fields.map((f) => f.propertyPath)).toEqual(["required", "label"]);
  });
});
