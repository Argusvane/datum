import { describe, expect, it } from "vitest";

import { buildInspectorModel } from "../form-engine/builder/property-editor/inspector-model.js";
import { optionsEditorHtml, propertiesPanelHtml, type OptionsEditorView } from "../form-engine/builder/web-component/builder-shared.js";
import { buildNestedTreeView } from "../form-engine/builder/tree-editor/nested-tree-view.js";
import { createDataSourceCapability } from "../form-engine/core/schema/data-source-capability.js";
import { createInlineOptionsCapability } from "../form-engine/core/schema/inline-options.js";
import { labelCapability, requiredCapability } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

const capabilities = [labelCapability, createDataSourceCapability(), createInlineOptionsCapability(), requiredCapability];

const radio: ComponentNode = {
  id: "answer",
  type: "radio",
  configuration: {
    label: "Answer",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" }
    ]
  }
};

describe("inspector model — Data section", () => {
  it("groups the source picker and the options row into a Data section after Content", () => {
    const model = buildInspectorModel(radio, capabilities, undefined, "en", { dataSourceIds: ["countries"] });
    expect(model.sections.map((section) => section.id)).toEqual(["content", "data", "validation"]);
    const data = model.sections.find((section) => section.id === "data")!;
    expect(data.title).toBe("Data");
    expect(data.fields.map((field) => [field.propertyPath, field.control])).toEqual([
      ["data.sourceId", "select"],
      // The free-answer switch sits between the picker and the inline options.
      ["data.answersFree", "checkbox"],
      ["options", "options"]
    ]);
  });

  it("offers the wired source ids in the picker, with none first", () => {
    const model = buildInspectorModel(
      { ...radio, configuration: { ...(radio.configuration as Record<string, unknown>), data: { sourceId: "countries" } } },
      capabilities,
      undefined,
      "en",
      { dataSourceIds: ["countries", "cities"] }
    );
    const picker = model.sections.flatMap((section) => section.fields).find((field) => field.propertyPath === "data.sourceId")!;
    expect(picker.choices.map((choice) => choice.value)).toEqual(["", "countries", "cities"]);
    expect(picker.value).toBe("countries");
  });

  it("falls back to a text box for the source id when the host wired no sources", () => {
    const model = buildInspectorModel(radio, capabilities);
    const picker = model.sections.flatMap((section) => section.fields).find((field) => field.propertyPath === "data.sourceId")!;
    expect(picker.control).toBe("text");
    expect(picker.choices).toEqual([]);
  });

  it("hands the options row the parsed list and the named source", () => {
    const model = buildInspectorModel(
      { ...radio, configuration: { ...(radio.configuration as Record<string, unknown>), data: { sourceId: "countries" } } },
      capabilities,
      undefined,
      "en"
    );
    const options = model.sections.flatMap((section) => section.fields).find((field) => field.control === "options")!;
    expect(options.optionsEditor).toEqual({
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" }
      ],
      sourceId: "countries"
    });
  });
});

describe("the Options row", () => {
  const panel = (node: ComponentNode) =>
    propertiesPanelHtml(buildInspectorModel(node, capabilities, undefined, "en", { dataSourceIds: ["countries"] }), node, {
      tab: "properties",
      treeView: buildNestedTreeView(node),
      hiddenIds: new Set<string>(),
      idError: undefined,
      idEditable: true,
      isRoot: false
    });

  it("offers the editor with a count when no data source is named", () => {
    const html = panel(radio);
    expect(html).toContain('<span data-options-count>2 options</span>');
    expect(html).toContain('data-options-edit="options"');
    expect(html).not.toContain("options-note");
  });

  it("names the source and offers no editor while one is set — the inline list is dead data then", () => {
    const sourced: ComponentNode = { ...radio, configuration: { ...(radio.configuration as Record<string, unknown>), data: { sourceId: "countries" } } };
    const html = panel(sourced);
    expect(html).toContain('<span class="options-summary" data-options-source="countries"><span data-options-count>From the data source <code>countries</code></span></span>');
    expect(html).not.toContain("data-options-edit");
    // The saved list is named, not dropped: clearing the source brings it straight back.
    expect(html).toContain('<p class="options-note">Clear the data source to author the options inline (2 options saved).</p>');
    const empty: ComponentNode = { ...sourced, configuration: { label: "Answer", data: { sourceId: "countries" } } };
    expect(panel(empty)).toContain('<p class="options-note">Clear the data source to author the options inline.</p>');
  });
});

describe("options editor markup", () => {
  const view: OptionsEditorView = {
    path: "options",
    title: "Options — Answer",
    rows: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "" }
    ],
    newValue: "maybe",
    newLabel: "",
    error: undefined,
    sourceId: undefined,
    maximized: false
  };

  it("draws a key and a label for every row, with reorder and remove, and no language columns", () => {
    const html = optionsEditorHtml(view);
    expect(html).toContain('<dialog class="db-confirm db-options-editor" role="dialog" aria-labelledby="options-editor-title" data-options-dialog data-options-kind="options" data-options-path="options">');
    expect(html).toContain("Options — Answer");
    expect(html).not.toContain("data-option-locale");
    expect(html).toContain('data-option-row="0" data-option-part="value" aria-label="Key of option 1" value="yes"');
    expect(html).toContain('data-option-row="0" data-option-part="label" aria-label="Label of option 1" value="Yes"');
    // A blank label shows the key as its placeholder — what the form will display.
    expect(html).toContain('data-option-row="1" data-option-part="label" aria-label="Label of option 2" value="" placeholder="no"');
    // The first row cannot move up, the last cannot move down.
    expect(html).toContain('data-options-move="0:-1" aria-label="Move option 1 up" title="Move up" disabled');
    expect(html).toContain('data-options-move="1:1" aria-label="Move option 2 down" title="Move down" disabled');
    expect(html).toContain('data-options-remove="1"');
    expect(html).toContain('data-options-new="value" aria-label="New option key" placeholder="Key (stored value)" value="maybe"');
    expect(html).toContain("data-options-export");
    expect(html).toContain("data-options-import");
    expect(html).toContain('<input type="file" accept="application/json,.json" data-options-file hidden />');
    expect(html).toContain("data-options-apply");
  });

  it("says when a data source overrides the list, reports an error, and pins a moved window", () => {
    const html = optionsEditorHtml({
      ...view,
      rows: [],
      sourceId: "countries",
      error: 'Key "x" is used more than once.',
      frame: { left: 10, top: 20, width: 700, height: 400 }
    });
    expect(html).toContain("takes its options from the data source <code>countries</code>");
    expect(html).toContain('<p role="alert" class="db-options-error">Key &quot;x&quot; is used more than once.</p>');
    expect(html).toContain("No options yet — add one below, or import a list.");
    expect(html).toContain('style="inset: auto; margin: 0; left: 10px; top: 20px; width: 700px; height: 400px;"');
    expect(optionsEditorHtml({ ...view, maximized: true })).toContain('class="db-confirm db-options-editor maximized"');
  });

  it("escapes what it is handed", () => {
    const html = optionsEditorHtml({
      ...view,
      title: 'Options — <b>"x"</b>',
      rows: [{ value: 'a"b', label: "<i>" }]
    });
    expect(html).toContain("Options — &lt;b&gt;&quot;x&quot;&lt;/b&gt;");
    expect(html).toContain('value="a&quot;b"');
    expect(html).toContain('value="&lt;i&gt;"');
  });
});

describe("options editor — descriptions", () => {
  const view: OptionsEditorView = {
    path: "options",
    title: "Options — Account",
    rows: [
      { value: "personal", label: "Personal", description: "For you or your family" },
      { value: "business", label: "Business" }
    ],
    newValue: "",
    newLabel: "",
    error: undefined,
    sourceId: undefined,
    maximized: false
  };

  it("keeps the Description columns out of the way until asked, behind a pressed toggle", () => {
    const html = optionsEditorHtml(view);
    expect(html).toContain('data-options-descriptions aria-pressed="false"');
    expect(html).not.toContain('data-option-part="description"');
    expect(html).not.toContain('<th scope="col">Description</th>');
    // Nothing of the kind on the messages editor: a message has no help line.
    expect(optionsEditorHtml({ ...view, kind: "messages", rows: [] })).not.toContain("data-options-descriptions");
  });

  it("draws a description cell per row once the column is on", () => {
    const html = optionsEditorHtml({ ...view, showDescriptions: true });
    expect(html).toContain('data-options-descriptions aria-pressed="true"');
    expect(html).toContain('<th scope="col">Description</th>');
    expect(html).toContain('data-option-row="0" data-option-part="description" aria-label="Description of option 1" value="For you or your family"');
    expect(html).not.toContain("description-locale");
    expect(html).toContain('data-option-row="1" data-option-part="description" aria-label="Description of option 2" value=""');
    // The empty-list row spans the extra columns too.
    expect(optionsEditorHtml({ ...view, showDescriptions: true, rows: [] })).toContain('colspan="4"');
    expect(optionsEditorHtml({ ...view, rows: [] })).toContain('colspan="3"');
  });
});
