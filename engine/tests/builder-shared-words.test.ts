import { describe, expect, it } from "vitest";

import {
  deleteConfirmHtml,
  inspectorFooterHtml,
  optionsEditorHtml,
  paletteGroupsHtml,
  problemCountText,
  propertiesPanelHtml,
  treeTabHtml,
  unsavedChangesPromptHtml
} from "../form-engine/builder/web-component/builder-shared.js";
import type { BuilderTextOptions } from "../form-engine/builder/logic/builder-texts.js";

/** One overridden key in French: a catalog reaches every sentence a function draws. */
const fr = (entries: Record<string, string>): BuilderTextOptions => ({ locale: "fr", catalog: { fr: entries as never } });

describe("the shared panels' words (builder-shared)", () => {
  it("draws the delete confirmation in English as it always read, and in the catalog's words", () => {
    const pending = { componentId: "name", label: "Name", descendantCount: 3 };
    const html = deleteConfirmHtml(pending);
    expect(html).toContain("Delete this component?");
    expect(html).toContain("“Name” (<code>name</code>) and the 3 components inside it will be removed.");
    expect(deleteConfirmHtml({ ...pending, descendantCount: 1 })).toContain("and the 1 component inside it will be removed.");
    expect(deleteConfirmHtml({ ...pending, descendantCount: 0 })).toContain("(<code>name</code>) will be removed.");
    const french = deleteConfirmHtml(pending, fr({ "confirm.delete.title": "Supprimer ce composant ?", "common.cancel": "Annuler" }));
    expect(french).toContain("<h4>Supprimer ce composant ?</h4>");
    expect(french).toContain(">Annuler</button>");
  });

  it("words the unsaved-changes prompt, with its plurals and lists", () => {
    const prompt = unsavedChangesPromptHtml({ componentId: "a", label: "A", action: "leave", blocked: true, problems: ["x", "y"] });
    expect(prompt).toContain("Apply is unavailable until these are fixed; Keep editing takes you there:");
    expect(prompt).toContain("before leaving the builder.");
    // The third button says what it does, and the blocked note names it by the same words.
    expect(prompt).toMatch(/data-unsaved-stay>Keep editing</);
    expect(prompt).not.toMatch(/>Stay</);
    const french = unsavedChangesPromptHtml(
      { componentId: "a", label: "A", action: "leave", blocked: false },
      fr({ "confirm.unsaved.action.leave": "de quitter le constructeur", "confirm.unsaved.keep": "Rester" })
    );
    expect(french).toContain("de quitter le constructeur");
    expect(french).toContain(">Rester</button>");
  });

  it("words the keyed-text editor from the catalog, kind by kind", () => {
    const view = {
      kind: "messages" as const,
      path: "messages",
      title: "Messages",
      rows: [{ value: "required", label: "", seeded: true }],
      newValue: "",
      newLabel: "",
      error: undefined,
      sourceId: undefined,
      maximized: false
    };
    expect(optionsEditorHtml(view)).toContain('placeholder="Code (required, minLength, …)"');
    const html = optionsEditorHtml({ ...view, words: fr({ "optionsEditor.messages.addLabel": "Ajouter un message", "common.cancel": "Annuler" }) });
    expect(html).toContain(">Ajouter un message</button>");
    expect(html).toContain("data-options-cancel>Annuler</button>");
  });

  it("words the inspector footer, the empty states and the palette groups", () => {
    const footer = inspectorFooterHtml({ hasSelection: true, dirty: true, deletable: true, problems: [{ target: "a", label: "A", message: "m" }, { target: "b", label: "B", message: "n" }] });
    expect(footer).toContain("2 problems");
    expect(footer).toContain("Not applied");
    expect(problemCountText(1)).toBe("1 problem");
    const french = inspectorFooterHtml({ hasSelection: true, dirty: true, deletable: true, words: fr({ "problem.notApplied": "Non appliqué", "common.delete": "Supprimer" }) });
    expect(french).toContain(">Non appliqué</span>");
    expect(french).toContain(">Supprimer</button>");
    const tree = { selectedId: undefined, hiddenIds: new Set<string>(), words: fr({ "tree.note": "Tous les composants." }) };
    const view = { node: { id: "root", type: "form", configuration: {} }, id: "root", type: "form", label: "Form", depth: 0, slots: [] };
    expect(treeTabHtml(view as never, tree)).toContain("Tous les composants.");
    expect(propertiesPanelHtml(undefined, undefined, { tab: "properties", treeView: view as never, hiddenIds: new Set(), idEditable: true, isRoot: false })).toContain(
      "Select a component in the canvas to edit its properties."
    );
    expect(
      propertiesPanelHtml(undefined, undefined, { tab: "properties", treeView: view as never, hiddenIds: new Set(), idEditable: true, isRoot: false, words: fr({ "inspector.selectProperties": "Choisissez un composant." }) })
    ).toContain("Choisissez un composant.");
    const entries = [
      { type: "text", label: "Text" },
      { type: "grid", label: "Grid" }
    ];
    expect(paletteGroupsHtml(entries)).toContain(">Fields<");
    expect(paletteGroupsHtml(entries, new Set(), undefined, fr({ "paletteGroup.fields": "Champs" }))).toContain(">Champs<");
  });
});
