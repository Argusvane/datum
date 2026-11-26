import { describe, expect, it } from "vitest";

import {
  CANVAS_PANEL_STYLES,
  assetChoiceOf,
  computeInsertionIndex,
  declaredSlotsByComponent,
  deleteConfirmHtml,
  groupPaletteEntries,
  idHelpText,
  insertionAxisForLayout,
  inspectorFooterHtml,
  identitySectionHtml,
  modeSettingsSectionHtml,
  paletteGlyphName,
  paletteGroupForEntry,
  paletteGroupsHtml,
  paletteHtml,
  paletteIconHtml,
  propertiesPanelHtml,
  hasStyleSections,
  STYLE_SECTION_IDS,
  ruleFieldOptions,
  ruleBoxDescription,
  ruleFeedbackHtml,
  rulesTabHtml,
  savedAsHelpText,
  slotEmptyHintsByComponent,
  treeTabHtml,
  unsavedChangesPromptHtml,
  type PropertiesPanelOptions
} from "../form-engine/builder/web-component/builder-shared.js";
import type { InspectorModel } from "../form-engine/builder/property-editor/inspector-model.js";
import { buildRuleEditorState } from "../form-engine/builder/property-editor/rules-model.js";
import { buildNestedTreeView } from "../form-engine/builder/tree-editor/nested-tree-view.js";
import { ICON_FALLBACK_CLASS, svgIconSet, type IconSet } from "../form-engine/render/icons/icon-set.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";

describe("computeInsertionIndex", () => {
  const rects = [
    { top: 0, height: 20, left: 0, width: 20 }, // midpoint 10
    { top: 20, height: 20, left: 20, width: 20 }, // midpoint 30
    { top: 40, height: 20, left: 40, width: 20 } // midpoint 50
  ];

  it("inserts before the first node whose midpoint the pointer is above", () => {
    expect(computeInsertionIndex(rects, 5)).toBe(0);
    expect(computeInsertionIndex(rects, 15)).toBe(1);
    expect(computeInsertionIndex(rects, 35)).toBe(2);
  });

  it("appends when the pointer is past every node", () => {
    expect(computeInsertionIndex(rects, 100)).toBe(3);
  });

  it("returns 0 for an empty dropzone", () => {
    expect(computeInsertionIndex([], 42)).toBe(0);
  });

  it("measures along the horizontal axis for a side-by-side layout", () => {
    // A `grid` lays children out across, where vertical midpoints would place the
    // marker in visibly the wrong slot.
    expect(computeInsertionIndex(rects, 5, "horizontal")).toBe(0);
    expect(computeInsertionIndex(rects, 35, "horizontal")).toBe(2);
    expect(computeInsertionIndex(rects, 100, "horizontal")).toBe(3);
  });

  it("maps a container's layout to the axis its children flow along", () => {
    expect(insertionAxisForLayout("stack")).toBe("vertical");
    expect(insertionAxisForLayout("grid")).toBe("horizontal");
  });
});

describe("slotEmptyHintsByComponent", () => {
  it("reads each declared slot's empty hint off the tree view, and skips slots with none", () => {
    const root: ComponentNode = {
      id: "root",
      type: "list",
      configuration: {},
      children: { items: [{ id: "inner", type: "list", configuration: {} }] }
    };
    const definition = {
      type: "list",
      version: "1.0.0",
      createDefault: () => ({ id: "list", type: "list", configuration: {} }),
      capabilities: [],
      children: {
        slots: [
          { id: "items", multiple: true, emptyHint: "Add an item." },
          { id: "footer", multiple: true }
        ]
      }
    };
    const hints = slotEmptyHintsByComponent(buildNestedTreeView(root, (type) => (type === "list" ? definition : undefined)));
    expect([...hints.keys()]).toEqual(["root", "inner"]);
    expect([...(hints.get("inner") ?? new Map()).entries()]).toEqual([["items", "Add an item."]]);
  });
});

describe("declaredSlotsByComponent", () => {
  it("records every container's slots, including nested and empty ones", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "leaf", type: "text", configuration: {} },
          {
            id: "outer",
            type: "fieldset",
            configuration: {},
            children: { content: [{ id: "inner", type: "fieldset", configuration: {}, children: { content: [] } }] }
          }
        ]
      }
    };

    const slots = declaredSlotsByComponent(buildNestedTreeView(root));
    expect(slots.get("root")).toEqual(["content"]);
    expect(slots.get("outer")).toEqual(["content"]);
    expect(slots.get("inner")).toEqual(["content"]);
    expect(slots.has("leaf")).toBe(false);
  });
});

describe("json tab", () => {
  const node: ComponentNode = {
    id: "email",
    type: "text",
    configuration: { label: "Email" },
    rules: { visibleWhen: { kind: "path", path: "opt_in" } }
  };

  it("shows the selected component's own subtree, rules included", () => {
    const html = propertiesPanelHtml(undefined, node, {
      tab: "json",
      treeView: buildNestedTreeView(node),
      hiddenIds: new Set(),
      idError: undefined,
      idEditable: true,
      isRoot: false
    });

    expect(html).toContain("&quot;id&quot;: &quot;email&quot;");
    // `rules` is a sibling of `configuration` and unreachable from the properties tab, so
    // this is the only place in the builder it is visible.
    expect(html).toContain("visibleWhen");
    // The <pre> is what the panel mounts the read-only editor over (json-viewer.ts).
    expect(html).toMatch(/^<pre data-json-view>/);
  });

  it("draws the JSON as a box to edit when the panel hands over its text, the problem under it", () => {
    const options = {
      tab: "json" as const,
      treeView: buildNestedTreeView(node),
      hiddenIds: new Set<string>(),
      idError: undefined,
      idEditable: true,
      isRoot: false
    };
    const clean = propertiesPanelHtml(undefined, node, { ...options, jsonEdit: { text: '{ "id": "email" }', label: "The component's JSON" } });
    expect(clean).toMatch(/^<textarea class="json-edit" data-json-view data-json-edit [^>]*aria-label="The component&#39;s JSON"/);
    expect(clean).toContain("&quot;id&quot;: &quot;email&quot;");
    expect(clean).not.toContain("aria-invalid");
    expect(clean).not.toContain("data-json-note");

    const broken = propertiesPanelHtml(undefined, node, {
      ...options,
      jsonEdit: { text: "{", label: "JSON", problem: { message: "The JSON ends too soon.", line: 1, column: 2 }, hasChildren: true }
    });
    expect(broken).toContain('<p class="json-note" data-json-note>Children are edited on the canvas.</p>');
    expect(broken).toContain('aria-invalid="true" aria-describedby="problem-json"');
    expect(broken).toContain('<p class="field-error json-error" id="problem-json" data-problem="json">Line 1, column 2: The JSON ends too soon.</p>');
  });

  it("says so when nothing is selected", () => {
    const html = propertiesPanelHtml(undefined, undefined, {
      tab: "json",
      treeView: buildNestedTreeView(node),
      hiddenIds: new Set(),
      idError: undefined,
      idEditable: true,
      isRoot: false
    });
    expect(html).toContain("Select a component to see its JSON.");
  });
});

describe("tree tab", () => {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: { label: "Form" },
    children: {
      content: [
        { id: "opt_in", type: "checkbox", configuration: { label: "Subscribe" } },
        { id: "email", type: "text", configuration: { label: "Email" } }
      ]
    }
  };

  it("lists every component as a selectable row, with delete on all but the root", () => {
    const html = treeTabHtml(buildNestedTreeView(root), {
      selectedId: undefined,
      hiddenIds: new Set()
    });
    expect(html).toContain('data-tree-select="opt_in"');
    expect(html).toContain('data-tree-delete="email"');
    expect(html).toContain('data-tree-select="root"');
    // The root cannot be removed, so it gets no delete control.
    expect(html).not.toContain('data-tree-delete="root"');
  });

  it("marks the components the canvas is hiding — the reason this list has to exist", () => {
    // A component whose visibleWhen is false is dropped from the canvas exactly as the live
    // form drops it, so this row is the only way left to select, edit or delete it.
    const html = treeTabHtml(buildNestedTreeView(root), {
      selectedId: "email",
      hiddenIds: new Set(["email"])
    });
    expect(html).toContain('<span class="tree-hidden">hidden</span>');
    expect(html).toContain('class="tree-select active" data-tree-select="email"');
  });
});

describe("component palette", () => {
  it("gives every entry an icon in place of the old plus sign", () => {
    const html = paletteHtml([
      { type: "text", label: "Text" },
      { type: "fieldset", label: "Fieldset" },
      { type: "wildcard", label: "Wildcard" }
    ]);
    expect(html.match(/class="palette-icon[ "]/g)).toHaveLength(3);
    expect(html).not.toContain(">+ ");
    // A type the palette has no drawing for still gets a glyph, not a bare label.
    expect(html).toContain('data-add-type="wildcard"');
    expect(html.match(/<svg /g)).toHaveLength(3);
  });

  it("draws through the icon set it is given, falling back per name to the engine's drawing", () => {
    const set = svgIconSet("acme", { "field-text": { viewBox: "0 0 1 1", body: "<!--acme-text-->" } });
    const html = paletteHtml(
      [
        { type: "text", label: "Text" },
        { type: "gcds-date", label: "Date" }
      ],
      set
    );
    expect(html).toContain('class="palette-icon" viewBox="0 0 1 1" width="15"');
    expect(html).toContain("<!--acme-text-->");
    // The date entry is not the set's to draw: the engine's own glyph, marked as a fallback.
    expect(html.match(new RegExp(`class="palette-icon ${ICON_FALLBACK_CLASS}"`, "g"))).toHaveLength(1);
    // The same set reaches the grouped listing.
    expect(paletteGroupsHtml([{ type: "text", label: "Text" }], new Set(), set)).toContain("<!--acme-text-->");
    // The type-to-name table is the engine's, so a set never sees a host's type names.
    expect(paletteGlyphName("gcds-date")).toBe("field-date");
    expect(paletteGlyphName("tel")).toBe("field-phone");
    expect(paletteGlyphName("data-grid")).toBe("container-table");
    // The data grid's own type key is camel-case; the table lowercases it.
    expect(paletteGlyphName("dataGrid")).toBe("container-table");
    expect(paletteGlyphName("acme-mystery")).toBe("component");
  });

  it("escapes a host-supplied glyph rather than letting it carry markup", () => {
    const html = paletteHtml([{ type: "custom", label: "Custom", icon: '<img src=x onerror=1>' }]);
    expect(html).toContain("palette-icon--text");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("lands a vendor-prefixed type on the glyph its tail names, in the built-in style", () => {
    // `gcds-link` should look like every other palette entry, not like an escaped emoji.
    expect(paletteIconHtml({ type: "gcds-link" })).toBe(paletteIconHtml({ type: "link" }));
    expect(paletteIconHtml({ type: "gcds-error-summary" })).toBe(
      paletteIconHtml({ type: "summary" })
    );
    expect(paletteIconHtml({ type: "acme-date-picker" })).not.toContain("palette-icon--text");
    // A tail nothing recognises still gets the generic box.
    expect(paletteIconHtml({ type: "gcds-mystery" })).toBe(paletteIconHtml({ type: "unknown" }));
    // And an explicit host icon still wins, escaped as text.
    expect(paletteIconHtml({ type: "gcds-link", icon: "L" })).toContain("palette-icon--text");
  });

  it("draws each kind of component its own glyph with no icon set on the page, and lets a set win", () => {
    // The rail's first types are all fields: they must not read as five of the same thing.
    const rail = ["text", "textarea", "number", "date", "select", "radio", "checkboxes", "checkbox", "file", "signature", "fieldset", "panel"];
    const drawn = rail.map((type) => paletteIconHtml({ type }));
    expect(new Set(drawn).size).toBe(rail.length);
    for (const html of drawn) {
      expect(html).toContain('class="palette-icon datum-icon-fallback"');
      expect(html).toContain('stroke="currentColor"');
    }
    // A set that draws the name is used as it is; one that leaves it out gets the builder's drawing.
    const set: IconSet = { id: "acme", icon: (name) => (name === "field-date" ? "<!--acme-date-->" : undefined) };
    expect(paletteIconHtml({ type: "date" }, set)).toBe("<!--acme-date-->");
    expect(paletteIconHtml({ type: "text" }, set)).toBe(paletteIconHtml({ type: "text" }));
  });

  it("gathers types under natural headings, with declared groups and Other in their places", () => {
    const groups = groupPaletteEntries([
      { type: "widget", label: "Widget" }, // nothing recognises it -> Other, listed last
      { type: "rating", label: "Rating", group: "Custom" }, // declared beats inferred
      { type: "text", label: "Text" },
      { type: "date", label: "Date" },
      { type: "select", label: "Select" },
      { type: "fieldset", label: "Fieldset" },
      { type: "button", label: "Button" }
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      "Fields",
      "Choices",
      "Layout",
      "Actions",
      "Custom",
      "Other"
    ]);
    expect(groups[0]?.entries.map((e) => e.type)).toEqual(["text", "date"]);
    expect(groups.find((g) => g.label === "Custom")?.entries.map((e) => e.type)).toEqual(["rating"]);
  });

  it("files the data grid under Layout beside the other containers", () => {
    expect(paletteGroupForEntry({ type: "dataGrid" })).toBe("Layout");
    const groups = groupPaletteEntries([
      { type: "text", label: "Text" },
      { type: "button-group", label: "Button group" },
      { type: "dataGrid", label: "Data grid" }
    ]);
    expect(groups.find((g) => g.label === "Layout")?.entries.map((e) => e.type)).toEqual(["button-group", "dataGrid"]);
  });

  it("files a rating with the choices, not the typed fields", () => {
    // A rating is picked from a fixed set of marks, like a radio — so with no declared group
    // it lands under Choices rather than Fields.
    expect(paletteGroupForEntry({ type: "rating" })).toBe("Choices");
    const groups = groupPaletteEntries([
      { type: "text", label: "Text" },
      { type: "rating", label: "Rating" },
      { type: "select", label: "Select" }
    ]);
    expect(groups.find((g) => g.label === "Choices")?.entries.map((e) => e.type)).toEqual([
      "rating",
      "select"
    ]);
    expect(groups.find((g) => g.label === "Fields")?.entries.map((e) => e.type)).toEqual(["text"]);
  });

  it("renders groups as collapsibles, keeping only the named ones closed", () => {
    const types = [
      { type: "text", label: "Text" },
      { type: "fieldset", label: "Fieldset" }
    ];
    const html = paletteGroupsHtml(types, new Set(["Layout"]));
    expect(html).toContain('data-palette-group="Fields" open');
    expect(html).toContain('data-palette-group="Layout">');
    expect(html).not.toContain('data-palette-group="Layout" open');
    // The items themselves are unchanged — same buttons, same drag attributes.
    expect(html).toContain('data-add-type="text"');
    expect(html).toContain('data-palette-type="fieldset"');
  });

  it("drops the headings entirely when everything lands in one group", () => {
    const html = paletteGroupsHtml([
      { type: "text", label: "Text" },
      { type: "number", label: "Number" }
    ]);
    expect(html).not.toContain("palette-group");
    expect(html).toContain('data-add-type="number"');
  });
});

describe("the canvas's notice", () => {
  it("stays in view while the page scrolls, clear of the drawers over the page's edges", () => {
    const rule = /\[data-drop-error\] \{[^}]*\}/.exec(CANVAS_PANEL_STYLES)?.[0] ?? "";
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("top: 0");
    expect(rule).toMatch(/margin-left: min\(var\(--db-side-w, 0px\)/);
    expect(rule).toMatch(/margin-right: min\(var\(--db-props-w, 0px\)/);
  });
});

describe("delete confirmation", () => {
  it("names the component and how much goes with it", () => {
    const html = deleteConfirmHtml({
      componentId: "newsletter",
      label: "Newsletter",
      descendantCount: 2
    });
    expect(html).toContain("Delete this component?");
    expect(html).toContain("Newsletter");
    expect(html).toContain("the 2 components inside it");
    expect(html).toContain('data-confirm-delete="newsletter"');
    expect(html).toContain("data-confirm-cancel");
  });

  it("names a node whose id the inspector does not show by its label alone, and one with a static ID row by its text", () => {
    const internal = deleteConfirmHtml({ componentId: "journey-field_1", label: "Full name", descendantCount: 0, idShown: false });
    expect(internal).toContain("“Full name” will be removed.");
    expect(internal).not.toContain("journey-field_1</code>");
    expect(internal).toContain('data-confirm-delete="journey-field_1"');
    expect(deleteConfirmHtml({ componentId: "journey-page_2", label: "2 Details", descendantCount: 1, idShown: "details" })).toContain(
      "“2 Details” (<code>details</code>) and the 1 component inside it will be removed."
    );
  });

  it("says nothing about descendants for a leaf, and renders nothing when idle", () => {
    const html = deleteConfirmHtml({ componentId: "name", label: "Full name", descendantCount: 0 });
    expect(html).not.toContain("inside it");
    expect(deleteConfirmHtml(undefined)).toBe("");
  });
});

describe("inspector footer", () => {
  it("offers Apply, Discard and Delete once something is selected, saying what is not applied", () => {
    const html = inspectorFooterHtml({
      hasSelection: true,
      dirty: true,
      deletable: true
    });
    expect(html).toContain("data-inspector-save");
    expect(html).toContain("data-inspector-cancel");
    expect(html).toContain("data-inspector-delete");
    expect(html).toContain(">Not applied<");
    expect(html).toContain(">Apply</button>");
    expect(html).toContain(">Discard</button>");
    expect(html).not.toMatch(/data-inspector-save[^>]*disabled/);
    expect(html).not.toContain("data-inspector-problems");
  });

  it("disables Save and Cancel with nothing pending, and never Save for a problem: it counts them instead", () => {
    const clean = inspectorFooterHtml({
      hasSelection: true,
      dirty: false,
      deletable: true
    });
    expect(clean).toMatch(/data-inspector-save\s+disabled/);
    expect(clean).toMatch(/data-inspector-cancel\s+disabled/);
    expect(clean).not.toContain("Not applied");

    // A disabled Save cannot say why or be reached; it stays usable and leads to the problem.
    const one = inspectorFooterHtml({
      hasSelection: true,
      dirty: true,
      deletable: true,
      problems: [{ target: "id", label: "ID", message: 'ID "city" already exists.' }]
    });
    expect(one).not.toMatch(/data-inspector-save[^>]*disabled/);
    expect(one).not.toMatch(/data-inspector-cancel[^>]*disabled/);
    // One problem: its message on the line above Save, which goes straight to its box.
    expect(one).toMatch(/<button[^>]*data-inspector-problems[^>]*><span class="problem-summary__count">1 problem:<\/span> ID &quot;city&quot; already exists.<\/button>/);
    // Nothing to expand.
    expect(one).not.toContain("aria-expanded");
    expect(one).not.toContain("data-inspector-problem-list");

    const several = [
      { target: "id", label: "ID", message: 'ID "city" already exists.' },
      { target: "cssClass", label: "CSS classes", message: '"2cols" is not a valid class name.' }
    ];
    const closed = inspectorFooterHtml({ hasSelection: true, dirty: true, deletable: true, problems: several });
    expect(closed).toMatch(/aria-expanded="false"[^>]*><span class="problem-summary__count">2 problems</);
    expect(closed).not.toContain("data-problem-go");
    const open = inspectorFooterHtml({ hasSelection: true, dirty: true, deletable: true, problems: several, problemsOpen: true });
    expect(open).toMatch(/aria-expanded="true"/);
    expect([...open.matchAll(/data-problem-go="([^"]+)"/g)].map((match) => match[1])).toEqual(["id", "cssClass"]);
    // A message that names its box already stands alone; any other gets the box's name.
    expect(open).toContain('data-problem-go="id">ID &quot;city&quot; already exists.</button>');
    expect(open).toContain("<strong>CSS classes</strong> &quot;2cols&quot; is not a valid class name.");
  });

  it("gives the form root no delete control, and renders nothing with no selection", () => {
    expect(
      inspectorFooterHtml({ hasSelection: true, dirty: false, deletable: false })
    ).not.toContain("data-inspector-delete");
    expect(
      inspectorFooterHtml({ hasSelection: false, dirty: false, deletable: false })
    ).toBe("");
  });
});

describe("expression control", () => {
  const expression: Expression = {
    kind: "call",
    name: "concat",
    args: [{ kind: "path", path: "firstName" }, { kind: "literal", value: "!" }]
  };

  function panel(value: unknown, extra: Partial<PropertiesPanelOptions> = {}) {
    const node: ComponentNode = {
      id: "t1",
      type: "pdf-text",
      configuration: { text: "Hi", expression: value }
    };
    const model: InspectorModel = {
      mode: "replace",
      nodeId: "t1",
      nodeType: "pdf-text",
      sections: [
        {
          id: "content",
          title: "Content",
          fields: [
            {
              propertyPath: "expression",
              label: "Expression",
              description: "Replaces the text.",
              control: "expression",
              value,
              choices: []
            }
          ]
        }
      ]
    };
    return propertiesPanelHtml(model, node, {
      tab: "properties",
      treeView: buildNestedTreeView(node),
      hiddenIds: new Set(),
      idError: undefined,
      idEditable: true,
      isRoot: false,
      ...extra
    });
  }

  it("edits a stored expression as pretty-printed JSON, not as [object Object] in a text box", () => {
    const html = panel(expression);
    expect(html).toContain('<textarea class="rule-json" data-prop="expression" data-control="expression"');
    expect(html).toContain("&quot;name&quot;: &quot;concat&quot;");
    expect(html).not.toContain("[object Object]");
    expect(html).not.toContain('<input data-prop="expression"');
    expect(html).toContain("Replaces the text.");
  });

  it("shows a stored string as it is, so the residue of the old text box can be cleared", () => {
    expect(panel("firstName")).toContain(">firstName</textarea>");
  });

  it("renders an empty box with no value", () => {
    expect(panel(undefined)).toContain("></textarea>");
  });

  it("prefers the text being typed and shows its parse failure under the box", () => {
    const html = panel(expression, {
      expressionDrafts: new Map([["expression", "{ nope"]]),
      expressionErrors: new Map([["expression", "Unexpected token"]])
    });
    expect(html).toContain(">{ nope</textarea>");
    expect(html).not.toContain("&quot;name&quot;: &quot;concat&quot;");
    // The failure sits under the box, which is marked invalid and described by it.
    expect(html).toContain('<p class="field-error" id="problem-expression" data-problem="expression">Unexpected token</p>');
    expect(html).toMatch(/<textarea[^>]*data-prop="expression"[^>]*aria-invalid="true" aria-describedby="problem-expression"/);
  });
});

describe("rules tab", () => {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: { label: "Form" },
    children: {
      content: [
        { id: "opt_in", type: "checkbox", configuration: { label: "Subscribe" } },
        { id: "email", type: "text", configuration: { label: "Email" } }
      ]
    }
  };

  function tab(rule: unknown, extra: Partial<Parameters<typeof rulesTabHtml>[0]> = {}) {
    return rulesTabHtml({
      states: [buildRuleEditorState("visibleWhen", rule), buildRuleEditorState("value", undefined)],
      openRules: new Set(),
      errors: new Map(),
      ...extra
    });
  }

  it("renders a rule with no expression as off and collapsed, its Off pill pressed", () => {
    const html = tab(undefined);
    expect(html).toContain('data-rule-section="visibleWhen"');
    expect(html).toContain(">off<");
    expect(html).not.toContain('data-rule-section="visibleWhen" open');
    expect(html).toMatch(/class="seg-btn" aria-pressed="true"\s+data-rule="visibleWhen" data-rule-mode="off"/);
    expect(html).toMatch(/class="seg-btn" aria-pressed="false"\s+data-rule="visibleWhen" data-rule-mode="formula"/);
    // There is no Build or Expression mode: every rule is a formula.
    expect(html).not.toContain('data-rule-mode="simple"');
    expect(html).not.toContain('data-rule-mode="json"');
    // Off: no box, no Runs control.
    expect(html).not.toContain("data-rule-formula");
    expect(html).not.toContain("data-rule-run-menu");
  });

  it("opens a rule that is set as a formula in the plain box, the stored string as written", () => {
    const html = tab('opt_in = true  or  email = "x"');
    expect(html).toContain('data-rule-section="visibleWhen" open');
    expect(html).toMatch(/<textarea class="rule-formula-box" data-rule="visibleWhen" data-rule-formula rows="1"[^>]*>opt_in = true  or  email = &quot;x&quot;<\/textarea>/);
    expect(html).toMatch(/class="seg-btn" aria-pressed="true"\s+data-rule="visibleWhen" data-rule-mode="formula"/);
    // A condition is one line; a value rule's cases go one per line.
    expect(html).not.toContain("data-rule-multiline");
    expect(
      rulesTabHtml({ states: [buildRuleEditorState("value", "a + b")], openRules: new Set(), errors: new Map() })
    ).toMatch(/<textarea class="rule-formula-box" data-rule="value" data-rule-formula rows="3"[^>]*aria-multiline="true" data-rule-multiline/);
  });

  it("opens a legacy tree printed as a formula", () => {
    const html = tab({
      kind: "call",
      name: "contains",
      args: [{ kind: "path", path: "tags" }, { kind: "literal", value: "x" }]
    });
    expect(html).toContain(">contains(tags, &quot;x&quot;)</textarea>");
    expect(html).not.toContain("data-rule-json");
  });

  it("draws the Runs control: a menu of the four scopes with their consequences, the chosen one checked", () => {
    const html = tab({ formula: "opt_in", run: "server" });
    expect(html).toContain('<details class="rule-run" data-rule-run-menu="visibleWhen">');
    expect(html).toContain("Runs: Server only</summary>");
    expect(html).toMatch(/aria-checked="true"\s+data-rule="visibleWhen" data-rule-run="server"/);
    expect(html).toMatch(/aria-checked="false"\s+data-rule="visibleWhen" data-rule-run="both"/);
    expect(html).toContain("<b>Browser and server</b><span>Checked while filling and again when submitted</span>");
    expect(html).toContain("<b>Server only, secret</b><span>Also left out of the form sent to browsers</span>");
    expect(html).not.toContain("data-rule-secret-note");
    // Secret: the lock note under the box.
    const secret = tab({ formula: "opt_in", run: "server-secret" });
    expect(secret).toContain("Runs: Server only, secret</summary>");
    expect(secret).toContain('<p class="note" data-rule-secret-note>Try it shows the server');
  });

  it("fixes a browser-only key to a Browser chip that says why, and gives a mode's own rule no control", () => {
    const html = rulesTabHtml({
      states: [buildRuleEditorState("defaultValue", "coalesce(host.x, \"\")")],
      openRules: new Set(),
      errors: new Map()
    });
    expect(html).toContain('<span class="rule-run-fixed" data-rule-run-fixed="defaultValue" title="Defaults and option filters run in the browser by nature">Browser</span>');
    expect(html).not.toContain("data-rule-run-menu");
    const when = { key: "when", label: "Take this route when", description: "Reads earlier pages.", kind: "condition" as const, target: { propertyPath: "when" } };
    const page = rulesTabHtml({ states: [buildRuleEditorState(when, "a")], openRules: new Set(), errors: new Map() });
    expect(page).not.toContain("data-rule-run-menu");
    expect(page).not.toContain("data-rule-run-fixed");
  });

  it("draws everything under the box as one block the panel can refresh in place while the author types", () => {
    const state = { ...buildRuleEditorState("visibleWhen", "structur > 0"), warnings: ["No field is called structur. Did you mean Structure?"], examples: ["a = true"] };
    const options = { error: undefined, openInLogic: true, editorFailed: false, words: undefined, notes: [{ message: "Checked in the browser only.", severity: "warning" as const }] };
    const html = rulesTabHtml({ states: [state], openRules: new Set(), errors: new Map(), notes: new Map([["visibleWhen", options.notes]]), openInLogic: true });
    const feedback = ruleFeedbackHtml(state, options);
    expect(html).toContain(`<div class="rule-feedback" data-rule-feedback="visibleWhen">${feedback}</div>`);
    // The block holds the warning, the link and the note; the box is outside it, before it.
    expect(feedback).toContain('data-rule-warning="visibleWhen"');
    expect(feedback).toContain('data-open-workspace="logic"');
    expect(feedback).toContain('id="note-rules-visibleWhen-0"');
    expect(feedback).not.toContain("data-rule-formula");
    expect(html.indexOf("data-rule-formula-host")).toBeLessThan(html.indexOf("data-rule-feedback"));
    // How the box describes itself follows the same options: the notes, or the problem once there is one.
    expect(ruleBoxDescription("visibleWhen", options)).toEqual({ invalid: false, describedBy: "note-rules-visibleWhen-0" });
    expect(ruleBoxDescription("visibleWhen", { ...options, error: "Expected a value." })).toEqual({ invalid: true, describedBy: "problem-rules-visibleWhen" });
    expect(ruleBoxDescription("visibleWhen", { error: undefined })).toEqual({ invalid: false, describedBy: undefined });
    const withError = ruleFeedbackHtml(state, { ...options, error: "Expected a value." });
    expect(withError).toContain('<p class="rule-error" id="problem-rules-visibleWhen" data-problem="rules:visibleWhen">Expected a value.</p>');
    expect(withError).not.toContain("note-rules-visibleWhen-0");
    // A rule that is off draws nothing under its pills but the notes.
    expect(ruleFeedbackHtml(buildRuleEditorState("visibleWhen", undefined), options)).toBe('<p class="field-note" id="note-rules-visibleWhen-0" data-note="rules:visibleWhen" data-severity="warning">Checked in the browser only.</p>');
  });

  it("shows a parse failure against the rule it belongs to, under the box, and marks the box", () => {
    const html = rulesTabHtml({
      states: [buildRuleEditorState("visibleWhen", undefined, { mode: "formula", text: "opt_in +" })],
      openRules: new Set(["visibleWhen"]),
      errors: new Map([["visibleWhen", "Expected a value."]])
    });
    expect(html).toContain('<p class="rule-error" id="problem-rules-visibleWhen" data-problem="rules:visibleWhen">Expected a value.</p>');
    expect(html).toMatch(/<textarea[^>]*data-rule-formula[^>]*aria-invalid="true" aria-describedby="problem-rules-visibleWhen"/);
    expect(html).toContain(">opt_in +</textarea>");
    // The state's own problem (a stored formula that does not parse) is said the same way.
    expect(tab("opt_in +", { states: [buildRuleEditorState("visibleWhen", "opt_in +", { problem: "Expected a value." })] })).toContain(
      'data-problem="rules:visibleWhen">Expected a value.</p>'
    );
  });

  it("draws the Reads as line, warnings, the Try one chips, Open in Logic and the editor's Retry", () => {
    const html = rulesTabHtml({
      states: [
        {
          ...buildRuleEditorState("visibleWhen", 'employees > 0 or structure = "corp"'),
          reads: [
            { kind: "word", text: "shown when" },
            { kind: "field", text: "Number of employees" },
            { kind: "word", text: "is more than" },
            { kind: "value", text: "0" }
          ],
          warnings: ["No field is called structur. Did you mean Structure?"]
        },
        { ...buildRuleEditorState("value", undefined, { mode: "formula" }), examples: ['not(empty(Email))', "employees > 10"] }
      ],
      openRules: new Set(),
      errors: new Map(),
      openInLogic: true,
      editorFailed: true
    });
    expect(html).toContain('<p class="rule-reads" data-rule-reads><span class="rule-reads-label">Reads as</span><span>shown when</span><span class="ref-chip">Number of employees</span><span>is more than</span><span class="ref-chip val">0</span></p>');
    expect(html).toContain('<p class="rule-warning" data-rule-warning="visibleWhen">No field is called structur. Did you mean Structure?</p>');
    // Try one: only over an empty box.
    expect(html).not.toContain('data-rule="visibleWhen" data-rule-try');
    expect(html).toContain('<button type="button" class="try-chip" data-rule="value" data-rule-try="not(empty(Email))">not(empty(Email))</button>');
    expect(html).toContain('<button type="button" class="link-btn" data-open-workspace="logic">Open in Logic</button>');
    expect(html).toContain('<p class="rule-editor-failed" data-rule-editor-failed>The formula editor could not load; the plain box still works.');
    expect(html).toContain('data-rule="visibleWhen" data-rule-editor-retry>Retry</button>');
    // The form's words at the top, the Variables panel named.
    expect(html).toContain("<code>row.</code>");
    expect(rulesTabHtml({ states: [], openRules: new Set(), errors: new Map() })).not.toContain("Open in Logic");
  });

  it("lists a step's Go to rules in the rule rows' markup, each with Reads as and Open in Logic, the fall-through with neither link, New rule last", () => {
    const html = rulesTabHtml({
      states: [],
      openRules: new Set(),
      errors: new Map(),
      ways: {
        note: "Tried in order.",
        rows: [{ title: "1 · Go to <News>", reads: "Go to <News> when Subscribe is ticked", open: () => undefined }, { title: "Otherwise · Go to Plain", reads: "Go to Plain when no rule above holds" }],
        newRule: { label: "New rule", run: () => undefined }
      }
    });
    expect(html.replace(/\s+/g, " ")).toBe(
      '<p class="rules-note">Tried in order.</p>' +
        '<details class="rule" data-rule-section="way:0" open> <summary>1 · Go to &lt;News&gt;</summary> <div class="rule-body"><p class="rule-reads"><span class="rule-reads-label">Reads as</span><span>Go to &lt;News&gt; when Subscribe is ticked</span></p><p class="rule-links"><button type="button" class="link-btn" data-rule-way="0">Open in Logic</button></p></div> </details>' +
        '<details class="rule" data-rule-section="way:1" open> <summary>Otherwise · Go to Plain</summary> <div class="rule-body"><p class="rule-reads"><span class="rule-reads-label">Reads as</span><span>Go to Plain when no rule above holds</span></p></div> </details>' +
        '<p class="rule-links"><button type="button" class="link-btn" data-rule-way="new">New rule</button></p>'
    );
    // Nothing to type: no box, no Off | Formula.
    expect(html).not.toContain("data-rule-mode");
    expect(html).not.toContain("<textarea");
  });

  it("suggests the form's other fields, never the one being edited", () => {
    const options = ruleFieldOptions(buildNestedTreeView(root), "email");
    expect(options.map((option) => option.value)).toEqual(["opt_in"]);
    // The form root is not a field a rule can read.
    expect(options.some((option) => option.value === "root")).toBe(false);
  });
});

describe("a builder mode's seams on the panel", () => {
  const node: ComponentNode = { id: "journey-page_2", type: "journey-page", configuration: { pageId: "about" } };
  const model: InspectorModel = { mode: "replace", nodeId: node.id, nodeType: node.type, sections: [] };
  const panel = (extra: Partial<PropertiesPanelOptions>): string =>
    propertiesPanelHtml(model, node, {
      tab: "properties",
      treeView: buildNestedTreeView(node),
      hiddenIds: new Set(),
      idEditable: true,
      isRoot: false,
      ...extra
    });

  it("puts the mode's own line at the top of the Rules tab in place of the form's", () => {
    const when = { key: "when", label: "Take this route when", description: "Reads earlier pages.", kind: "condition" as const, target: { propertyPath: "when" } };
    const html = rulesTabHtml({
      states: [buildRuleEditorState(when, undefined)],
      openRules: new Set(),
      errors: new Map(),
      note: "row., ancestor. and host. are not available here."
    });
    expect(html).toContain('<p class="rules-note">row., ancestor. and host. are not available here.</p>');
    expect(html).not.toContain("<code>row.</code>");
    expect(html).toContain('data-rule-section="when"');
    expect(html).toContain("Reads earlier pages.");
  });

  it("draws the ID row as the tree's owner says: hidden, read-only with its own words, or the default", () => {
    expect(panel({ idRow: { mode: "hidden" } })).not.toContain('data-prop="id"');
    expect(panel({ idRow: { mode: "hidden" } })).not.toContain("<strong>ID</strong>");
    const fixed = panel({ idRow: { mode: "static", text: "short", help: "The journey's id, set when it was made." } });
    expect(fixed).not.toContain('data-prop="id"');
    expect(fixed).toContain('<span class="property-static">short</span>');
    expect(fixed).toContain("The journey&#39;s id, set when it was made.");
    // "edit" is the default, and the root stays read-only whatever the owner says.
    expect(panel({ idRow: { mode: "edit" } })).toContain('data-prop="id"');
    expect(panel({ idRow: { mode: "edit" }, idEditable: false })).not.toContain('data-prop="id"');
    expect(panel({})).toContain('data-prop="id"');
  });

  it("draws another mode's rows on the root, a section per mode, and nothing for a mode with none", () => {
    const group = {
      mode: "journeys",
      title: "Journeys",
      rows: [
        {
          id: "journeys.opensAs",
          label: "Opens as",
          description: "What a person sees first.",
          choices: [
            { value: "form", label: "The whole form" },
            { value: "journey", label: "About you" }
          ],
          value: "journey",
          note: "Default journey: About you",
          open: { label: "Open Journeys", document: "short" }
        }
      ]
    };
    const html = modeSettingsSectionHtml(group, true);
    expect(html).toContain('data-inspector-section="mode-journeys" data-mode-settings="journeys" open');
    expect(html).toContain("<summary>Journeys</summary>");
    // The description (what is at stake) and the note are read with the select.
    expect(html).toContain('<select data-root-setting="journeys.opensAs" aria-describedby="mode-setting-journeys-opensAs-desc mode-setting-journeys-opensAs-note">');
    expect(html).toContain('<p class="options-note" id="mode-setting-journeys-opensAs-desc">What a person sees first.</p>');
    expect(html).toContain('<option value="journey" selected>About you</option>');
    expect(html).toContain('id="mode-setting-journeys-opensAs-note" data-root-setting-note="journeys.opensAs">Default journey: About you</p>');
    const { description: _description, note: _note, ...bare } = group.rows[0]!;
    expect(modeSettingsSectionHtml({ ...group, rows: [bare] }, true)).toContain('<select data-root-setting="journeys.opensAs">');
    expect(html).toContain('data-root-setting-open="journeys" data-root-setting-document="short">Open Journeys</button>');
    // A value the choices do not hold still shows, marked, rather than being rewritten.
    expect(modeSettingsSectionHtml({ ...group, rows: [{ ...group.rows[0]!, value: "later" }] }, true)).toContain(
      '<option value="later" selected>later (unknown)</option>'
    );
    expect(modeSettingsSectionHtml({ ...group, rows: [] }, true)).toBe("");
    // The panel draws them on the root only.
    expect(panel({ isRoot: true, modeSettings: [group] })).toContain('data-mode-settings="journeys"');
    expect(panel({ isRoot: false, modeSettings: [group] })).not.toContain("data-mode-settings");
  });
});

describe("a builder mode's notes and folded sections on the panel", () => {
  const node: ComponentNode = { id: "journey-page_2", type: "journey-page", configuration: { pageId: "about" } };
  const field = (propertyPath: string, label: string, control: "text" | "select" | "expression" = "text") => ({
    propertyPath,
    label,
    description: undefined,
    control,
    value: "",
    choices: []
  });
  const model: InspectorModel = {
    mode: "replace",
    nodeId: node.id,
    nodeType: node.type,
    sections: [
      { id: "page", title: "Page", fields: [field("pageId", "Page id"), field("title", "Title")] },
      { id: "wording", title: "Wording", fields: [field("texts.continue", "Continue button")], folded: true },
      { id: "advanced", title: "Advanced", fields: [field("when", "Condition", "expression")] }
    ]
  };
  const panel = (extra: Partial<PropertiesPanelOptions>): string =>
    propertiesPanelHtml(model, node, {
      tab: "properties",
      treeView: buildNestedTreeView(node),
      hiddenIds: new Set(),
      idEditable: false,
      isRoot: false,
      ...extra
    });

  it("draws a note under the box it names, read with the box and never marking it invalid", () => {
    const html = panel({ notes: [{ target: "title", message: "Page \"about\" has no title.", severity: "warning" }] });
    expect(html).toContain('<p class="field-note" id="note-title-0" data-note="title" data-severity="warning">Page &quot;about&quot; has no title.</p>');
    expect(html).toMatch(/<input[^>]*data-prop="title"[^>]*aria-describedby="note-title-0"/);
    expect(html).not.toMatch(/<input[^>]*data-prop="title"[^>]*aria-invalid/);
    expect(html).not.toContain("data-inspector-notes");
    expect(html).not.toContain("field-error");
  });

  it("draws notes about no box it shows above the sections: the component's own, a rule's, one under a box drawn otherwise", () => {
    const html = panel({
      notes: [
        { message: "No path reaches this page.", severity: "warning" },
        { target: "rules:when", message: "The condition reads a later page.", severity: "warning" },
        { target: "when", message: "Not a box with a row." },
        { target: "nowhere", message: "About nothing drawn.", severity: "error" }
      ]
    });
    const block = html.slice(html.indexOf("data-inspector-notes"), html.indexOf("data-inspector-section"));
    for (const message of ["No path reaches this page.", "The condition reads a later page.", "Not a box with a row.", "About nothing drawn."]) {
      expect(block).toContain(message);
    }
    expect(block).toContain('data-severity="error">About nothing drawn.');
    // Nothing without notes, and nothing for a component with nothing to edit.
    expect(panel({})).not.toContain("data-inspector-notes");
  });

  it("lets a problem stand in for the note under the same box", () => {
    const html = panel({
      problems: [{ target: "pageId", message: "Another page of this journey has the id \"about\"." }],
      notes: [{ target: "pageId", message: "Two pages share this id." }]
    });
    expect(html).toContain('data-problem="pageId"');
    expect(html).not.toContain("Two pages share this id.");
  });

  it("starts a folded section folded, open once the author opens it, and leaves the rest open", () => {
    const folded = panel({});
    expect(folded).toContain('data-inspector-section="wording" data-folded>');
    expect(folded).toContain('data-inspector-section="page" open');
    const opened = panel({ openedSections: new Set(["wording"]) });
    expect(opened).toContain('data-inspector-section="wording" data-folded open');
    // Collapsing a section that starts open still works; opening one that starts open changes nothing.
    const collapsed = panel({ collapsedSections: new Set(["page"]), openedSections: new Set(["page"]) });
    expect(collapsed).toContain('data-inspector-section="page">');
  });

  it("draws a rule's notes under the rule on the Rules tab, and gives way to its parse error", () => {
    const when = { key: "when", label: "Take this route when", description: "Reads earlier pages.", kind: "condition" as const, target: { propertyPath: "when" } };
    const options = {
      states: [buildRuleEditorState(when, undefined)],
      openRules: new Set<string>(),
      errors: new Map<string, string>(),
      notes: new Map([["when", [{ message: "The condition reads a later page.", severity: "warning" as const }]]])
    };
    expect(rulesTabHtml(options)).toContain('data-note="rules:when" data-severity="warning">The condition reads a later page.</p>');
    expect(rulesTabHtml({ ...options, errors: new Map([["when", "Not JSON."]]) })).not.toContain("The condition reads a later page.");
  });
});

describe("properties panel tabs", () => {
  const node: ComponentNode = { id: "email", type: "text", configuration: { label: "Email" } };

  it("routes the rules tab, and says so when nothing is selected", () => {
    const rules = {
      states: [buildRuleEditorState("visibleWhen", undefined)],
      openRules: new Set<string>(),
      errors: new Map<string, string>()
    };
    expect(
      propertiesPanelHtml(undefined, node, {
        tab: "rules",
        treeView: buildNestedTreeView(node),
        hiddenIds: new Set(),
        idError: undefined,
        idEditable: true,
        isRoot: false,
        rules
      })
    ).toContain('data-rule-section="visibleWhen"');

    expect(
      propertiesPanelHtml(undefined, undefined, {
        tab: "rules",
        treeView: buildNestedTreeView(node),
        hiddenIds: new Set(),
        idError: undefined,
        idEditable: true,
        isRoot: false,
        rules
      })
    ).toContain("Select a component to edit its rules.");
  });
});

describe("properties tab sections", () => {
  const node: ComponentNode = {
    id: "email",
    type: "text",
    configuration: { label: "Email", cssClass: "wide" }
  };
  const model: InspectorModel = {
    mode: "default",
    nodeId: "email",
    nodeType: "text",
    sections: [
      {
        id: "content",
        title: "Content",
        fields: [
          {
            propertyPath: "label",
            label: "Label",
            description: undefined,
            control: "text",
            value: "Email",
            choices: []
          }
        ]
      },
      {
        id: "presentation",
        title: "Presentation",
        fields: [
          {
            propertyPath: "cssClass",
            label: "CSS classes",
            description: undefined,
            control: "text",
            value: "wide",
            choices: []
          }
        ]
      }
    ]
  };
  const baseOptions = {
    tab: "properties" as const,
    treeView: buildNestedTreeView(node),
    hiddenIds: new Set<string>(),
    idError: undefined,
    idEditable: true,
    isRoot: false
  };

  it("renders each section as a collapsible, open unless the author closed it", () => {
    const html = propertiesPanelHtml(model, node, {
      ...baseOptions,
      collapsedSections: new Set(["presentation"])
    });
    expect(html).toContain('data-inspector-section="content" open');
    expect(html).toContain('data-inspector-section="presentation">');
    expect(html).not.toContain('data-inspector-section="presentation" open');
    expect(html).toContain("<summary>Content</summary>");
  });

  it("draws the cssClass field as a plain box: no chips of the theme's classes under it", () => {
    const html = propertiesPanelHtml(model, node, baseOptions);
    expect(html).toContain('data-prop="cssClass"');
    expect(html).not.toContain("css-class-chip");
    expect(html).not.toContain("css-class-options");
    expect(html).not.toContain("data-css-class-suggest");
  });

  it("shows a blocking error under the field", () => {
    const html = propertiesPanelHtml(model, node, {
      ...baseOptions,
      cssClassError: '"2cols" is not a valid class name.'
    });
    // Under its own box, which is marked invalid and described by the message.
    expect(html).toContain('<p class="field-error" id="problem-cssClass" data-problem="cssClass">&quot;2cols&quot; is not a valid class name.</p>');
    expect(html).toMatch(/<input[^>]*data-prop="cssClass"[^>]*aria-describedby="problem-cssClass" aria-invalid="true"/);
    expect(html).not.toContain("css-class-chip");
  });

  it("shows an out-of-theme note as a warning, styled apart from an error", () => {
    const html = propertiesPanelHtml(model, node, {
      ...baseOptions,
      cssClassWarning: '"off-theme" is not defined by the active theme.'
    });
    expect(html).toContain('class="css-class-warning"');
    expect(html).toContain("is not defined by the active theme.");
    expect(html).not.toContain('class="rule-error"');
  });
});

describe("field help", () => {
  const node: ComponentNode = {
    id: "field",
    type: "pdf-field",
    configuration: { widgetName: "applicant_email", hideLabel: false, rendition: "field" }
  };
  const describedField = {
    propertyPath: "widgetName",
    label: "PDF field name",
    description: "Empty uses the component's value path.",
    control: "text" as const,
    value: "applicant_email",
    choices: []
  };
  const withFields = (fields: InspectorModel["sections"][number]["fields"]): InspectorModel => ({
    mode: "default",
    nodeId: "field",
    nodeType: "pdf-field",
    sections: [{ id: "settings", title: "Settings", fields }]
  });
  const baseOptions = {
    tab: "properties" as const,
    treeView: buildNestedTreeView(node),
    hiddenIds: new Set<string>(),
    idError: undefined,
    idEditable: true,
    isRoot: false
  };

  it("gives a described field a ? toggle wired to its help text, closed by default", () => {
    const html = propertiesPanelHtml(withFields([describedField]), node, baseOptions);
    expect(html).toContain('<div class="property-row property-row--help">');
    expect(html).toContain('<label for="prop-widgetName"><strong>PDF field name</strong></label>');
    expect(html).toContain('data-help-toggle="widgetName"');
    expect(html).toContain('aria-expanded="false" aria-controls="prop-widgetName-help"');
    expect(html).toContain(`aria-label="Help: PDF field name" title="Empty uses the component&#39;s value path."`);
    expect(html).toContain('data-prop="widgetName" data-control="text" id="prop-widgetName" aria-describedby="prop-widgetName-help"');
    expect(html).toContain(`<p class="property-help" id="prop-widgetName-help" hidden>Empty uses the component&#39;s value path.</p>`);
  });

  it("renders the help open when the author expanded it", () => {
    const html = propertiesPanelHtml(withFields([describedField]), node, {
      ...baseOptions,
      openHelp: new Set(["widgetName"])
    });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('<p class="property-help" id="prop-widgetName-help">');
    expect(html).not.toContain('id="prop-widgetName-help" hidden');
  });

  it("leaves a field without a description as the plain label-wrapped row", () => {
    const html = propertiesPanelHtml(withFields([{ ...describedField, description: undefined }]), node, baseOptions);
    expect(html).toContain('<label class="property-row"><strong>PDF field name</strong>');
    // The ID row above it has a "?" of its own; the field has none.
    expect(html).not.toContain("prop-widgetName-help");
    expect(html).not.toContain('data-help-toggle="widgetName"');
  });

  it("offers the same toggle on select, checkbox and localized-text controls", () => {
    const html = propertiesPanelHtml(
      withFields([
        {
          propertyPath: "rendition",
          label: "Rendition",
          description: "How this component appears here.",
          control: "select",
          value: "field",
          choices: [{ value: "field", label: "Field" }]
        },
        {
          propertyPath: "hideLabel",
          label: "Hide label",
          description: "Draws no label at all.",
          control: "checkbox",
          value: false,
          choices: []
        },
        {
          propertyPath: "label",
          label: "Label override",
          description: "Empty keeps the component's own label.",
          control: "localized-text",
          value: "",
          choices: []
        }
      ]),
      node,
      baseOptions
    );
    expect(html).toContain('<select data-prop="rendition" data-control="select" id="prop-rendition" aria-describedby="prop-rendition-help">');
    expect(html).toContain('data-prop="hideLabel" data-control="checkbox" id="prop-hideLabel" aria-describedby="prop-hideLabel-help" type="checkbox"');
    expect(html).toContain('data-control="localized-text" id="prop-label" aria-describedby="prop-label-help"');
    // The three fields' toggles, and the ID row's.
    expect(html.match(/data-help-toggle=/g)).toHaveLength(4);
    expect(html).toContain('data-help-toggle="id"');
  });

  it("derives a safe DOM id from a nested property path", () => {
    const html = propertiesPanelHtml(
      withFields([{ ...describedField, propertyPath: "style.font.size", label: "Font size" }]),
      node,
      baseOptions
    );
    expect(html).toContain('id="prop-style-font-size"');
    expect(html).toContain('data-help-toggle="style.font.size"');
  });
});

describe("the Field and Style tabs", () => {
  const field: ComponentNode = { id: "street", type: "text", configuration: { label: "Street" } };
  const box = (propertyPath: string, label: string) => ({ id: propertyPath, propertyPath, label, control: "text" as const, value: "" });
  const model = {
    mode: "default",
    nodeId: "street",
    nodeType: "text",
    sections: [
      { id: "content", title: "Content", fields: [box("label", "Label")] },
      { id: "presentation", title: "Presentation", fields: [box("cssClass", "CSS classes")] },
      { id: "pdf", title: "PDF", fields: [box("pdf.width", "Width")] }
    ]
  } as unknown as InspectorModel;
  const options: PropertiesPanelOptions = {
    tab: "properties",
    treeView: buildNestedTreeView(field),
    hiddenIds: new Set<string>(),
    idEditable: true,
    isRoot: false,
    dataPath: "street"
  };

  it("knows which models have style sections", () => {
    expect(hasStyleSections(model)).toBe(true);
    expect(hasStyleSections({ ...model, sections: [model.sections[0]!] })).toBe(false);
    expect(hasStyleSections(undefined)).toBe(false);
    expect([...STYLE_SECTION_IDS]).toEqual(["presentation", "pdf"]);
  });

  it("keeps the On paper group on the Field tab, last, when the panel offers Style", () => {
    const printing = {
      ...model,
      sections: [...model.sections.slice(0, 2), { id: "print", title: "On paper", fields: [box("print.breakBefore", "Start on a new page")] }, model.sections[2]!]
    } as unknown as InspectorModel;
    expect(hasStyleSections({ ...printing, sections: [printing.sections[0]!, printing.sections[2]!] })).toBe(false);
    const fieldTab = propertiesPanelHtml(printing, field, { ...options, splitStyle: true });
    expect(fieldTab).toContain('data-inspector-section="print"');
    expect(fieldTab.lastIndexOf('data-inspector-section="print"')).toBeGreaterThan(fieldTab.indexOf('data-inspector-section="content"'));
    const styleTab = propertiesPanelHtml(printing, field, { ...options, tab: "style", splitStyle: true });
    expect(styleTab).not.toContain('data-inspector-section="print"');
    expect(styleTab).toContain('data-inspector-section="presentation"');
  });

  it("keeps every section on Field until the panel offers Style, then splits them", () => {
    const all = propertiesPanelHtml(model, field, options);
    expect(all).toContain('data-inspector-section="presentation"');
    const fieldTab = propertiesPanelHtml(model, field, { ...options, splitStyle: true });
    expect(fieldTab).toContain('data-inspector-section="content"');
    expect(fieldTab).not.toContain('data-inspector-section="presentation"');
    expect(fieldTab).not.toContain('data-inspector-section="pdf"');
    expect(fieldTab).toContain("data-saved-as");
    const styleTab = propertiesPanelHtml(model, field, { ...options, splitStyle: true, tab: "style" });
    expect(styleTab).toContain('data-inspector-section="presentation"');
    expect(styleTab).toContain('data-inspector-section="pdf"');
    expect(styleTab).not.toContain('data-inspector-section="content"');
    expect(styleTab).not.toContain('data-prop="id"');
    expect(styleTab).not.toContain("data-saved-as");
  });

  it("says so when a component has no style options", () => {
    const plain = { ...model, sections: [model.sections[0]!] } as InspectorModel;
    expect(propertiesPanelHtml(plain, field, { ...options, tab: "style" })).toContain("This component has no style options.");
  });
});

describe("ID and Saves to help", () => {
  const field: ComponentNode = { id: "street", type: "text", configuration: { label: "Street", dataKey: "line1" } };
  const model: InspectorModel = { mode: "default", nodeId: "street", nodeType: "text", sections: [] };
  const baseOptions: PropertiesPanelOptions = {
    tab: "properties",
    treeView: buildNestedTreeView(field),
    hiddenIds: new Set<string>(),
    idEditable: true,
    isRoot: false
  };
  const container = (configuration: Record<string, unknown>): ComponentNode => ({
    id: "billing",
    type: "container",
    configuration,
    children: { content: [] }
  });
  const section: ComponentNode = {
    id: "items",
    type: "panel",
    configuration: {},
    collection: { collectionPath: "order.items" },
    children: { content: [] }
  };

  it("gives the ID box a ? whose note says the id is form-wide and how Saved as relates", () => {
    const html = propertiesPanelHtml(model, field, baseOptions);
    expect(html).toContain('<label for="prop-id"><strong>ID</strong></label>');
    expect(html).toMatch(/data-help-toggle="id"\s+aria-expanded="false" aria-controls="prop-id-help"\s+aria-label="Help: ID" title="This component&#39;s name/);
    expect(html).toContain('<input id="prop-id" data-prop="id" type="text" value="street" aria-describedby="prop-id-help" />');
    expect(html).toContain('<p class="property-help" id="prop-id-help" hidden>');
    expect(html).toContain("no two components can share one, even inside different containers");
    expect(html).toContain("If so, the Saved as line shows where.");
  });

  it("keeps a problem under the ID box, which names both the note and the problem", () => {
    const html = propertiesPanelHtml(model, field, {
      ...baseOptions,
      problems: [{ target: "id", message: 'ID "city" already exists.' }]
    });
    expect(html).toContain('aria-invalid="true" aria-describedby="prop-id-help problem-id"');
    expect(html).toContain('<p class="field-error" id="problem-id" data-problem="id">ID &quot;city&quot; already exists.</p>');
  });

  it("gives the Saves to line a ? saying where the answer is stored and how the path is made", () => {
    const html = propertiesPanelHtml(model, field, { ...baseOptions, dataPath: "billing.line1" });
    expect(html).toContain('<label for="prop-savedAs"><strong>Saves to</strong></label>');
    // A read-only box like the ID's, not disabled, so the path can be selected and copied; no data-prop, so it drafts nothing.
    expect(html).toContain('<input id="prop-savedAs" type="text" readonly value="billing.line1" aria-describedby="prop-savedAs-help" />');
    expect(html).not.toContain("saves-to");
    expect(html).toMatch(/data-help-toggle="savedAs"\s+aria-expanded="false" aria-controls="prop-savedAs-help"\s+aria-label="Help: Saves to"/);
    expect(html).toContain(
      '<p class="property-help" id="prop-savedAs-help" hidden>Where this answer is stored in the submitted data. The path joins the keys of the containers above it that nest data, then its own Data key, or its ID when it has none.'
    );
  });

  it("renders both notes open when the author expanded them", () => {
    const html = propertiesPanelHtml(model, field, {
      ...baseOptions,
      dataPath: "billing.line1",
      openHelp: new Set(["id", "savedAs"])
    });
    expect(html).toMatch(/data-help-toggle="id"\s+aria-expanded="true"/);
    expect(html).toMatch(/data-help-toggle="savedAs"\s+aria-expanded="true"/);
    expect(html).toContain('<p class="property-help" id="prop-id-help">');
    expect(html).toContain('<p class="property-help" id="prop-savedAs-help">');
  });

  it("draws the Saves to line even where the path is the id, but not on a PDF layout's tree", () => {
    expect(propertiesPanelHtml(model, field, { ...baseOptions, dataPath: "street" })).toContain('<input id="prop-savedAs" type="text" readonly value="street"');
    const layout = propertiesPanelHtml(model, field, { ...baseOptions, dataPath: "billing.line1", formTree: false });
    expect(layout).not.toContain("data-saved-as");
    expect(layout).toContain("A layout stores no answers of its own: it shows the form&#39;s.");
  });

  it("explains the form root's read-only ID", () => {
    const root: ComponentNode = { id: "form", type: "form", configuration: {}, children: { content: [field] } };
    const html = propertiesPanelHtml({ ...model, nodeId: "form", nodeType: "form" }, root, {
      ...baseOptions,
      idEditable: false,
      isRoot: true
    });
    expect(html).toContain('<span class="property-static">form</span>');
    expect(html).toContain('data-help-toggle="id"');
    expect(html).toContain("The form&#39;s own ID. No component in the form can take it.");
    expect(html).not.toContain('data-prop="id"');
  });

  it("says what each kind of component stores under its id", () => {
    const place = { isRoot: false, formTree: true };
    expect(idHelpText(field, place)).toContain("Its answer is stored under the ID too, unless it has a Data key");
    expect(idHelpText(container({}), place)).toContain("The answers inside it are nested under the ID too");
    expect(idHelpText(container({ scopeData: false }), place)).toMatch(/It stores no answer of its own\.$/);
    expect(idHelpText(section, place)).toContain("Its entries are stored as a list under the ID too, unless its collection path");
    expect(idHelpText({ id: "send", type: "button", configuration: {} }, place)).toMatch(/It stores no answer of its own\.$/);
  });

  it("says what a Saved as path is for each kind, numbering an entry's example", () => {
    expect(savedAsHelpText(field, "items[].sku")).toContain(
      "[] stands for each entry of the repeating section it sits in. A submission numbers them, as in items[0].sku."
    );
    expect(savedAsHelpText(field, "billing.line1")).not.toContain("[]");
    expect(savedAsHelpText(container({ dataKey: "bill" }), "bill")).toContain("as one object");
    expect(savedAsHelpText(section, "order.items")).toContain("as a list. It is the section's collection path");
    // A data grid is bound as a collection, so it gets the collection wording with no case of its own.
    const grid: ComponentNode = { id: "lines", type: "dataGrid", configuration: {}, collection: { collectionPath: "lines" }, children: { content: [] } };
    expect(savedAsHelpText(grid, "lines")).toContain("data grid's entries are stored");
    expect(idHelpText(grid, { isRoot: false, formTree: true })).toContain("Its entries are stored as a list under the ID too");
  });
});

describe("identity section (form-level)", () => {
  it("renders a box per identity field, filled with the drafted value", () => {
    const html = identitySectionHtml({ value: { id: "customer-intake", version: "1.2.0", schemaVersion: "1" } }, true);
    expect(html).toContain('data-inspector-section="identity" open');
    expect(html).toContain("<summary>Identity</summary>");
    expect(html).toContain('data-identity-field="id" value="customer-intake"');
    expect(html).toContain('data-identity-field="version" value="1.2.0"');
    expect(html).toContain('data-identity-field="schemaVersion" value="1"');
    // A blank box keeps its value on Save, and the section says so.
    expect(html).toContain("A blank box keeps its current value.");
  });

  it("escapes what it renders and folds like any other section", () => {
    const html = identitySectionHtml({ value: { id: 'a"b', version: "<1>", schemaVersion: "1" } }, false);
    expect(html).toContain('data-inspector-section="identity">');
    expect(html).not.toContain('data-inspector-section="identity" open');
    expect(html).toContain('value="a&quot;b"');
    expect(html).toContain('value="&lt;1&gt;"');
  });

  it("renders inside the properties panel for the form root only", () => {
    const root: ComponentNode = { id: "root", type: "form", configuration: {} };
    const model: InspectorModel = { mode: "default", nodeId: "root", nodeType: "form", sections: [] };
    const options = {
      tab: "properties" as const,
      treeView: buildNestedTreeView(root),
      hiddenIds: new Set<string>(),
      idError: undefined,
      idEditable: false,
      identity: { value: { id: "intake", version: "1.0.0", schemaVersion: "1" } }
    };
    const forRoot = propertiesPanelHtml(model, root, { ...options, isRoot: true });
    expect(forRoot).toContain('data-inspector-section="identity"');
    // The Form panel's Localization section: languages are Languages'.
    expect(forRoot).not.toContain('data-inspector-section="localization"');

    // Not on a field's inspector: the identity is the definition's, and only the Form selection edits it.
    const forField = propertiesPanelHtml(model, root, { ...options, isRoot: false, idEditable: true });
    expect(forField).not.toContain('data-inspector-section="identity"');

    // Nor on a root whose host handed the builder no identity to edit.
    const { identity: _none, ...withoutIdentity } = options;
    expect(propertiesPanelHtml(model, root, { ...withoutIdentity, isRoot: true })).not.toContain(
      'data-inspector-section="identity"'
    );
  });
});

describe("file control", () => {
  const BUILTIN_GRAY = { storage: "builtin", ref: "gray", name: "Gray gamma 2.2.icc", type: "application/vnd.iccprofile", size: 376 };
  const HOSTED = { storage: "asset", ref: "icc/fogra39", name: "FOGRA39.icc", type: "application/vnd.iccprofile", size: 1_800_000 };
  const CHOICES = [
    { id: "builtin:gray", label: "Gray gamma 2.2", group: "Built in", source: BUILTIN_GRAY },
    { id: "host:fogra39", label: "ISO Coated v2 (FOGRA39)", group: "From the host", source: HOSTED }
  ];

  function panel(value: unknown, extra: Partial<PropertiesPanelOptions> = {}, assetChoices?: typeof CHOICES) {
    const node: ComponentNode = {
      id: "doc",
      type: "pdf-document",
      configuration: { conformance: { outputIntent: { profile: value } } }
    };
    const model: InspectorModel = {
      mode: "replace",
      nodeId: "doc",
      nodeType: "pdf-document",
      sections: [
        {
          id: "content",
          title: "Content",
          fields: [
            {
              propertyPath: "conformance.outputIntent.profile",
              label: "Output intent profile (ICC)",
              description: "None: sRGB.",
              control: "file",
              accept: "application/vnd.iccprofile,.icc",
              value,
              choices: [],
              ...(assetChoices ? { assetChoices } : {})
            }
          ]
        }
      ]
    };
    return propertiesPanelHtml(model, node, {
      tab: "properties",
      treeView: buildNestedTreeView(node),
      hiddenIds: new Set(),
      idError: undefined,
      idEditable: true,
      isRoot: true,
      ...extra
    });
  }

  it("offers a picker over a hidden file input that accepts what the field declares, and says nothing is set", () => {
    const html = panel(undefined);
    expect(html).toContain('data-file-row="conformance.outputIntent.profile"');
    expect(html).toContain('<button type="button" class="btn" data-file-pick="conformance.outputIntent.profile">Choose…</button>');
    expect(html).toContain('data-prop="conformance.outputIntent.profile" data-control="file" type="file" accept="application/vnd.iccprofile,.icc" hidden');
    expect(html).toContain("<span data-file-summary>None</span>");
    expect(html).not.toContain("data-file-clear");
    expect(html).toContain("None: sRGB.");
  });

  it("summarises an inline file by name and size and offers to remove it; a host-stored one by its storage", () => {
    const inline = panel({ storage: "base64", name: "press.icc", type: "application/vnd.iccprofile", size: 557168, data: "AAAA" });
    expect(inline).toContain("<span data-file-summary>press.icc · 544 KB · kept in the form definition</span>");
    expect(inline).toContain('data-file-clear="conformance.outputIntent.profile"');
    const hosted = panel({ storage: "asset", name: "org.icc", type: "application/vnd.iccprofile", size: 3144, ref: "icc/org" });
    expect(hosted).toContain("<span data-file-summary>org.icc · provided by the host (asset)</span>");
  });

  it("offers ready-made values as a grouped select whose last entry uploads, and marks what is set", () => {
    const none = panel(undefined, {}, CHOICES);
    expect(none).toContain('<select data-file-choice="conformance.outputIntent.profile"');
    expect(none).toContain('<option value="" selected>None</option>');
    expect(none).toContain('<optgroup label="Built in"><option value="builtin:gray">Gray gamma 2.2</option></optgroup>');
    expect(none).toContain('<optgroup label="From the host"><option value="host:fogra39">ISO Coated v2 (FOGRA39)</option></optgroup>');
    expect(none).toContain('<option value="__upload">Upload a file…</option>');
    expect(none).not.toContain("data-file-pick");
    expect(none).not.toContain("__custom");

    const gray = panel({ ...BUILTIN_GRAY }, {}, CHOICES);
    expect(gray).toContain('<option value="builtin:gray" selected>Gray gamma 2.2</option>');
    expect(gray).toContain("<span data-file-summary>Gray gamma 2.2 · built in</span>");
    expect(gray).toContain("data-file-clear");
    expect(assetChoiceOf({ ...HOSTED }, CHOICES)?.id).toBe("host:fogra39");
    expect(assetChoiceOf({ storage: "asset", ref: "icc/other", name: "x", type: "", size: 1 }, CHOICES)).toBeUndefined();

    // An uploaded file is neither choice: it shows as its own, disabled entry, selected.
    const uploaded = panel({ storage: "base64", name: "press.icc", type: "", size: 2048, data: "AAAA" }, {}, CHOICES);
    expect(uploaded).toContain('<option value="__custom" selected disabled>press.icc · 2 KB · kept in the form definition</option>');
  });

  it("shows why the last pick was refused under the row", () => {
    const html = panel(undefined, { fileErrors: new Map([["conformance.outputIntent.profile", '"notes.txt" is not an ICC profile.']]) });
    expect(html).toContain('data-file-error="conformance.outputIntent.profile"');
    expect(html).toContain("is not an ICC profile.");
  });
});

describe("phone targets and the safe area", () => {
  it("pads the Header and footer panel's footer by the shell's safe-area token and sizes its rows for a finger", async () => {
    const { CHROME_PANEL_STYLES } = await import("../form-engine/builder/web-component/builder-chrome-panel.js");
    expect(CHROME_PANEL_STYLES).toContain(":host([data-phone]) .inspector-footer { padding-bottom: calc(var(--db-space-3) + var(--db-safe-bottom");
    expect(CHROME_PANEL_STYLES).toMatch(/\.db-chrome-check \{ min-height: var\(--db-density-control-h, 44px\)/);
    // The tick box is the shared 24px one (SHARED_CONTROL_STYLES) at every size: the panel draws none of its own.
    expect(CHROME_PANEL_STYLES).not.toContain('input[type="checkbox"]');
    expect(CHROME_PANEL_STYLES).not.toContain("`");
  });
});
