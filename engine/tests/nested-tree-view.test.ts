import { describe, expect, it } from "vitest";

import {
  buildNestedTreeView,
  flattenNestedTreeView
} from "../form-engine/builder/tree-editor/nested-tree-view.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { ParentConstraintsResolver } from "../form-engine/builder/tree-editor/slot-constraints.js";

const root: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { label: "Intake" },
  children: {
    content: [
      { id: "name", type: "text", configuration: { label: "Name" } },
      {
        id: "section",
        type: "container",
        configuration: {},
        children: {
          body: [{ id: "street", type: "text", configuration: {} }]
        }
      }
    ]
  }
};

const resolver: ParentConstraintsResolver = (type) =>
  type === "container"
    ? { children: { slots: [{ id: "body", multiple: true, allowedTypes: ["text"] }] } }
    : type === "form"
      ? { children: { slots: [{ id: "content", multiple: true }] } }
      : undefined;

describe("buildNestedTreeView", () => {
  it("names a node by the labeler it is given, falling back to its label, then its id", () => {
    const view = buildNestedTreeView(root, resolver, "en", (node) => (node.id === "section" ? "Address" : node.id === "name" ? "  " : undefined));
    const [name, section] = view.slots[0]!.children;
    expect(view.label).toBe("Intake");
    expect(name?.label).toBe("Name");
    expect(section?.label).toBe("Address");
    expect(section?.slots[0]?.children[0]?.label).toBe("street");
  });

  it("walks the tree recursively with per-slot children", () => {
    const view = buildNestedTreeView(root, resolver);
    expect(view.slots.map((s) => s.slotId)).toEqual(["content"]);

    const content = view.slots[0];
    expect(content?.children.map((c) => c.id)).toEqual(["name", "section"]);

    const section = content?.children[1];
    expect(section?.slots.map((s) => s.slotId)).toEqual(["body"]);
    expect(section?.slots[0]?.allowedTypes).toEqual(["text"]);
    expect(section?.slots[0]?.children[0]?.id).toBe("street");
    expect(section?.depth).toBe(1);
    expect(section?.slots[0]?.children[0]?.depth).toBe(2);
  });

  it("infers slots from existing children when no resolver is supplied", () => {
    const view = buildNestedTreeView(root);
    expect(view.slots.map((s) => s.slotId)).toEqual(["content"]);
    const section = view.slots[0]?.children[1];
    expect(section?.slots.map((s) => s.slotId)).toEqual(["body"]);
  });

  it("declares a grid's columns from its configuration, ahead of whatever the tree holds", () => {
    // The registry cannot declare a grid's slots — the list follows `configuration.columns` —
    // so the view reads them off the node. Left to right first, then any stray slot, so a
    // column with nothing in it yet is still a drop target in the right place.
    const grid: ComponentNode = {
      id: "g",
      type: "grid",
      configuration: { columns: 3 },
      children: {
        column_2: [{ id: "b", type: "text", configuration: {} }],
        content: [{ id: "old", type: "text", configuration: {} }]
      }
    };
    const tree: ComponentNode = { ...root, children: { content: [grid] } };
    const noGridSlots: ParentConstraintsResolver = (type) =>
      type === "grid" ? { children: { slots: [] } } : resolver(type);

    const view = buildNestedTreeView(tree, noGridSlots).slots[0]?.children[0];
    expect(view?.slots.map((s) => s.slotId)).toEqual(["column_1", "column_2", "column_3", "content"]);
    expect(view?.slots.every((s) => s.multiple)).toBe(true);
    expect(view?.slots[1]?.children[0]?.id).toBe("b");

    // A grid with no `children` key at all is still a container with three columns.
    const bare = buildNestedTreeView(
      { ...root, children: { content: [{ id: "g", type: "grid", configuration: { columns: 3 } }] } },
      noGridSlots
    ).slots[0]?.children[0];
    expect(bare?.slots.map((s) => s.slotId)).toEqual(["column_1", "column_2", "column_3"]);
  });

  it("words a label for the given locale through the form's translations, falling back to the default string then the node id", () => {
    const localizedRoot: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "name",
            type: "text",
            configuration: { label: "Name" }
          },
          { id: "untitled", type: "text", configuration: {} }
        ]
      }
    };
    const translations = { "fr-CA": { components: { name: { label: { text: "Nom", source: sourceHash("Name") } } } } };

    const en = buildNestedTreeView(localizedRoot, undefined, "en", undefined, { translations });
    expect(en.slots[0]?.children[0]?.label).toBe("Name");

    const fr = buildNestedTreeView(localizedRoot, undefined, "fr-CA", undefined, { translations });
    expect(fr.slots[0]?.children[0]?.label).toBe("Nom");
    // The host's catalog wins over the form's own for the same address.
    const hosted = buildNestedTreeView(localizedRoot, undefined, "fr-CA", undefined, { translations, catalog: { "fr-CA": { components: { name: { label: "Nom (hôte)" } } } } });
    expect(hosted.slots[0]?.children[0]?.label).toBe("Nom (hôte)");
    // Without translations the label is the string in the default language.
    expect(buildNestedTreeView(localizedRoot, undefined, "fr-CA").slots[0]?.children[0]?.label).toBe("Name");

    // No label at all still falls back to the node id, in any locale.
    expect(fr.slots[0]?.children[1]?.label).toBe("untitled");
  });

  it("flattens to parent/slot/index rows in document order", () => {
    const rows = flattenNestedTreeView(buildNestedTreeView(root, resolver));
    expect(rows.map((r) => [r.node.id, r.parentId, r.slotId, r.index])).toEqual([
      ["name", "root", "content", 0],
      ["section", "root", "content", 1],
      ["street", "section", "body", 0]
    ]);
  });
});
