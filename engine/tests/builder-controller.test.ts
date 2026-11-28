import { describe, expect, it } from "vitest";

import {
  BuilderController,
  paletteEntriesOf,
  type BuilderChangeEvent
} from "../form-engine/builder/controller/builder-controller.js";
import { languagesController } from "./fixtures/builder-languages.js";
import { localeDisplayName } from "../form-engine/core/localization/supported-locales.js";
import { addressOf, sourceHash, writeTranslation, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode, ComponentRules } from "../form-engine/core/schema/types.js";
import { BUILDER_DRAG_MIME_TYPE } from "../form-engine/builder/drag-drop/html5-drag-drop.js";
import type { LiveBinding } from "../form-engine/render/live/contract.js";

const def = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition =>
  ({ type, version: "1.0.0", ...extra }) as unknown as ComponentDefinition;

function controller(root?: ComponentNode) {
  return new BuilderController({
    componentTypes: [
      { type: "text", label: "Text" },
      { type: "number", label: "Number" }
    ],
    initialRoot: root ?? { id: "root", type: "form", configuration: {}, children: { content: [] } },
    componentDefinitions: [
      def("form", { children: { slots: [{ id: "content", multiple: true }] } }),
      def("fieldset", { children: { slots: [{ id: "body", multiple: true, max: 1, allowedTypes: ["text"] }] } }),
      // A grid's slots follow its configuration, so the definition declares none statically.
      def("grid", { children: { slots: [] } }),
      def("text"),
      def("number")
    ]
  });
}

const field = (id: string): ComponentNode => ({ id, type: "text", configuration: {} });

/** A form holding one grid, `g`, with the given columns and children. */
function gridForm(columns: number, children: Record<string, ComponentNode[]>): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: { content: [{ id: "g", type: "grid", configuration: { columns }, children }] }
  };
}

function gridChildren(ctrl: BuilderController): Record<string, string[]> {
  const grid = ctrl.snapshot().children?.content?.[0];
  return Object.fromEntries(
    Object.entries(grid?.children ?? {}).map(([slotId, group]) => [slotId, group.map((n) => n.id)])
  );
}

describe("BuilderController", () => {
  it("adds components and notifies change listeners", () => {
    const ctrl = controller();
    const reasons: string[] = [];
    ctrl.on("change", (e) => reasons.push(e.reason));

    ctrl.add("text");
    expect(ctrl.snapshot().children?.content).toHaveLength(1);
    expect(reasons).toContain("add");
    expect(ctrl.selectedComponentId()).toBeDefined();
  });

  it("keeps its component definitions when a later setOptions opens another form without them", () => {
    const ctrl = controller();
    expect(ctrl.hasComponentType("bogus")).toBe(false);
    ctrl.setOptions({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "group", type: "fieldset", configuration: {}, children: { body: [] } }] } }
    });
    expect(ctrl.hasComponentType("bogus")).toBe(false);
    ctrl.add("number", "group", "body");
    expect(ctrl.dropError).toMatch(/not allowed in slot/i);

    // An empty list is what takes the definitions away.
    ctrl.setOptions({ componentDefinitions: [] });
    expect(ctrl.hasComponentType("bogus")).toBe(true);
  });

  it("enforces registry slot constraints and surfaces dropError instead of throwing", () => {
    const ctrl = controller({
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "group", type: "fieldset", configuration: {}, children: { body: [] } }] }
    });

    ctrl.add("number", "group", "body");
    expect(ctrl.dropError).toMatch(/not allowed in slot/i);
    ctrl.add("text", "group", "body");
    expect(ctrl.dropError).toBeUndefined();
    ctrl.add("text", "group", "body"); // exceeds max:1
    expect(ctrl.dropError).toMatch(/max/i);
  });

  it("routes property edits through undoable commands", () => {
    const ctrl = controller();
    ctrl.add("text");
    const id = ctrl.selectedComponentId()!;

    ctrl.setProperty(id, "label", "Renamed");
    expect(ctrl.inspectorModel()?.sections[0]?.fields.find((f) => f.propertyPath === "label")?.value).toBe(
      "Renamed"
    );
    ctrl.undo();
    expect(ctrl.selectedNode()?.configuration).toMatchObject({ label: "Untitled field" });
  });

  it("validates id renames", () => {
    const ctrl = controller();
    ctrl.add("text");
    ctrl.add("text");
    const [first] = ctrl.snapshot().children!.content!;
    ctrl.renameId(first!.id, "");
    expect(ctrl.idError).toMatch(/required/i);
    ctrl.renameId(first!.id, ctrl.snapshot().children!.content![1]!.id);
    expect(ctrl.idError).toMatch(/already exists/i);
    ctrl.renameId(first!.id, "cleanId");
    expect(ctrl.idError).toBeUndefined();
    expect(ctrl.snapshot().children!.content![0]!.id).toBe("cleanId");
  });

  it("emits mutation events and supports undo/redo", () => {
    const ctrl = controller();
    const actions: string[] = [];
    ctrl.on("mutation", (m) => actions.push(m.action));

    ctrl.add("text");
    expect(actions).toContain("execute");
    ctrl.undo();
    expect(ctrl.snapshot().children?.content).toHaveLength(0);
    ctrl.redo();
    expect(ctrl.snapshot().children?.content).toHaveLength(1);
    expect(actions).toEqual(expect.arrayContaining(["execute", "undo", "redo"]));
  });

  it("can select the form root to expose form-level properties (no label / required)", () => {
    const ctrl = controller({
      id: "root",
      type: "form",
      configuration: { title: "Customer Intake" },
      children: { content: [] }
    });
    expect(ctrl.isRootSelected()).toBe(false);

    ctrl.select(ctrl.rootId());
    expect(ctrl.isRootSelected()).toBe(true);
    expect(ctrl.selectedNode()?.type).toBe("form");

    const fields = ctrl.inspectorModel()?.sections[0]?.fields ?? [];
    expect(fields.map((f) => f.propertyPath)).toEqual(["title", "description"]);
    expect(fields.find((f) => f.propertyPath === "title")?.value).toBe("Customer Intake");

    ctrl.setProperty(ctrl.rootId(), "title", "Renamed Form");
    expect(ctrl.selectedNode()?.configuration).toMatchObject({ title: "Renamed Form" });
  });

  it("words node labels in the canvas tree view through the form's translations, keyed by the controller's locale", () => {
    const ctrl = controller({
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "name",
            type: "text",
            configuration: { label: "Name" }
          }
        ]
      }
    });
    ctrl.setOptions({ translations: { "fr-CA": { components: { name: { label: { text: "Nom", source: sourceHash("Name") } } } } } });

    expect(ctrl.currentLocale()).toBe("en");
    expect(ctrl.treeView().slots[0]?.children[0]?.label).toBe("Name");

    ctrl.setOptions({ locale: "fr-CA" });
    expect(ctrl.currentLocale()).toBe("fr-CA");
    expect(ctrl.treeView().slots[0]?.children[0]?.label).toBe("Nom");
  });

  it("emits a change event for a locale-only setOptions call (so panels repaint), but not redundantly", () => {
    const ctrl = controller();
    const reasons: string[] = [];
    ctrl.on("change", (e) => reasons.push(e.reason));

    ctrl.setOptions({ locale: "fr-CA" });
    expect(reasons).toEqual(["edit"]);

    // Setting the same locale again is a no-op: no spurious change event.
    ctrl.setOptions({ locale: "fr-CA" });
    expect(reasons).toEqual(["edit"]);
  });

  function dataTransferWith(payload: unknown) {
    const store = new Map<string, string>([
      ["application/x-datum-builder-drag", JSON.stringify(payload)]
    ]);
    return { setData: (k: string, v: string) => store.set(k, v), getData: (k: string) => store.get(k) ?? "" };
  }

  it("reorders an existing component within its slot", () => {
    const ctrl = controller();
    ctrl.add("text");
    ctrl.add("text");
    ctrl.add("text");
    const ids = ctrl.snapshot().children!.content!.map((n) => n.id);

    // Move the first card to the end.
    ctrl.applyDrop(dataTransferWith({ kind: "existing-component", componentId: ids[0] }), "root", "content", 3);
    expect(ctrl.snapshot().children!.content!.map((n) => n.id)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("treats a drop onto a component's own position as a no-op", () => {
    const ctrl = controller();
    ctrl.add("text");
    ctrl.add("text");
    const ids = ctrl.snapshot().children!.content!.map((n) => n.id);
    const before = ctrl.canUndo();

    // index === currentIndex and index === currentIndex + 1 are both no-ops.
    ctrl.applyDrop(dataTransferWith({ kind: "existing-component", componentId: ids[0] }), "root", "content", 0);
    ctrl.applyDrop(dataTransferWith({ kind: "existing-component", componentId: ids[0] }), "root", "content", 1);
    expect(ctrl.snapshot().children!.content!.map((n) => n.id)).toEqual(ids);
    expect(ctrl.canUndo()).toBe(before);
  });

  describe("binding preview", () => {
    const binding = (id: string): LiveBinding => ({ id, label: id, components: {} });
    const light = binding("light");
    const dark = binding("dark");

    function offered() {
      const ctrl = controller();
      ctrl.setOptions({
        availableBindings: [
          { id: "light", label: "Light", binding: light },
          { id: "dark", label: "Dark", binding: dark },
          // Datum's own look is a real choice too.
          { id: "datum", label: "Datum" }
        ]
      });
      return ctrl;
    }

    it("draws with a chosen binding and reports it as a preview, not an edit", () => {
      const ctrl = offered();
      const reasons: string[] = [];
      ctrl.on("change", (event) => reasons.push(event.reason));

      ctrl.setBindingId("dark");

      expect(ctrl.canvasBinding()).toBe(dark);
      expect(ctrl.bindingId()).toBe("dark");
      // A host that rebuilt its runtime here would wipe whatever is typed into the form; the
      // tree is untouched, so the change says so.
      expect(reasons).toEqual(["preview"]);
      expect(ctrl.snapshot().children?.content).toHaveLength(0);
    });

    it("lets the host fix the sheet's width from the tree, read over what the canvas previews", () => {
      const ctrl = controller();
      const reasons: string[] = [];
      ctrl.on("change", (event) => reasons.push(event.reason));
      // Without a host's say the sheet is the author's.
      expect(ctrl.sheetWidth()).toBeUndefined();

      const width = (root: ComponentNode): number | undefined =>
        (root.configuration as { width?: number } | undefined)?.width;
      ctrl.setOptions({ sheetWidth: width });
      // Restyles the canvas without touching the tree: a preview change, not an edit.
      expect(reasons).toEqual(["preview"]);
      expect(ctrl.sheetWidth()).toBeUndefined();

      ctrl.setProperty("root", "width", 500);
      expect(ctrl.sheetWidth()).toBe(500);
      // Read over the previewed tree: an inspector edit not yet saved already moves the sheet,
      // while the committed tree a host persists still says what Save wrote.
      ctrl.select("root");
      ctrl.setDraftProperty("root", "width", 640);
      expect(ctrl.sheetWidth()).toBe(640);
      expect(ctrl.getProperty("root", "width")).toBe(500);
      ctrl.discardDraft("root");
      expect(ctrl.sheetWidth()).toBe(500);

      // A width the sheet cannot take is no width: the canvas falls back to the author's.
      ctrl.setProperty("root", "width", 0);
      expect(ctrl.sheetWidth()).toBeUndefined();
      ctrl.setProperty("root", "width", Number.NaN);
      expect(ctrl.sheetWidth()).toBeUndefined();

      // Taking the option back hands the sheet to the author again.
      reasons.length = 0;
      ctrl.setOptions({ sheetWidth: undefined });
      expect(reasons).toEqual(["preview"]);
      expect(ctrl.sheetWidth()).toBeUndefined();
    });

    it("treats Datum's entry as a real choice: the canvas draws with Datum's own binding", () => {
      const ctrl = offered();
      ctrl.setBindingId("dark");
      ctrl.setBindingId("datum");
      expect(ctrl.bindingId()).toBe("datum");
      expect(ctrl.canvasBinding()).toBeUndefined();
    });

    it("ignores an id it was never offered", () => {
      const ctrl = offered();
      ctrl.setBindingId("dark");
      const reasons: string[] = [];
      ctrl.on("change", (event) => reasons.push(event.reason));

      ctrl.setBindingId("nonexistent");

      expect(ctrl.bindingId()).toBe("dark");
      expect(reasons).toEqual([]);
    });

    it("follows a binding the host sets itself, so the picker never lies", () => {
      const ctrl = offered();
      ctrl.setOptions({ binding: dark });
      expect(ctrl.bindingId()).toBe("dark");
      ctrl.setOptions({ binding: "light" });
      expect(ctrl.bindingId()).toBe("light");
      expect(ctrl.canvasBinding()).toBe(light);
      // One outside the offered list leaves the picker with nothing to show.
      ctrl.setOptions({ binding: binding("other") });
      expect(ctrl.bindingId()).toBeUndefined();
    });

    it("forgets a pick the host stops offering", () => {
      const ctrl = offered();
      ctrl.setBindingId("dark");
      ctrl.setOptions({ availableBindings: [{ id: "light", label: "Light", binding: light }] });
      expect(ctrl.bindingId()).toBeUndefined();
      expect(ctrl.canvasBinding()).toBeUndefined();
    });
  });

  describe("cssClass validation against the binding's classes", () => {
    const declaring = (id: string, cssClasses: string[]): LiveBinding => ({ id, label: id, components: {}, cssClasses });
    const themed = () => {
      const ctrl = controller();
      ctrl.setOptions({ binding: declaring("demo", ["wide", "highlight"]) });
      return ctrl;
    };

    it("exposes the binding's class vocabulary", () => {
      // Its own classes, and the shared panel looks every binding accepts, in addition.
      expect(themed().cssClassNames()).toEqual(["wide", "highlight", "panel-plain", "panel-outlined", "panel-shaded", "panel-card"]);
      // A binding that declares none, no vocabulary — and therefore nothing to validate against.
      expect(controller().cssClassNames()).toEqual([]);
    });

    it("warns about an undeclared class while typing, but still commits it", () => {
      const ctrl = themed();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;

      ctrl.setDraftProperty(id, "cssClass", "wide off-theme");
      expect(ctrl.cssClassWarning).toBe('"off-theme" is not one of the binding\'s classes.');
      expect(ctrl.cssClassError).toBeUndefined();
      // Advisory, not a refusal: the save lands, and the note stays visible after it.
      expect(ctrl.commitDraft(id)).toBe(true);
      expect(ctrl.getProperty(id, "cssClass")).toBe("wide off-theme");
      expect(ctrl.cssClassWarning).toBe('"off-theme" is not one of the binding\'s classes.');

      ctrl.setDraftProperty(id, "cssClass", "wide highlight");
      expect(ctrl.cssClassWarning).toBeUndefined();
      expect(ctrl.commitDraft(id)).toBe(true);
      expect(ctrl.getProperty(id, "cssClass")).toBe("wide highlight");
    });

    it("words the class-name check in the builder's catalog once lent its words", () => {
      const ctrl = themed();
      ctrl.setTextWords({ locale: "fr", catalog: { fr: { "themeClasses.invalid.other": "{list} ne sont pas des noms de classe valides." } } });
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;
      ctrl.setDraftProperty(id, "cssClass", 'x" onload="y');
      expect(ctrl.cssClassError).toMatch(/ne sont pas des noms de classe valides/);
      ctrl.setTextWords({});
      ctrl.setDraftProperty(id, "cssClass", 'x" onload="z');
      expect(ctrl.cssClassError).toMatch(/not a valid class name/);
    });

    it("words the problems it already listed in the new language once lent other words", () => {
      const ctrl = themed();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;
      ctrl.setDraftProperty(id, "cssClass", "bad!class");
      expect(ctrl.problemsOf(id).find((problem) => problem.target === "cssClass")?.message).toBe('"bad!class" is not a valid class name.');
      ctrl.setTextWords({ locale: "fr", catalog: { fr: { "themeClasses.invalid.one": "FR: {list} invalide." } } });
      expect(ctrl.cssClassError).toBe('FR: "bad!class" invalide.');
      expect(ctrl.problemsOf(id).find((problem) => problem.target === "cssClass")?.message).toBe('FR: "bad!class" invalide.');
    });

    it("refuses to commit a malformed token — the renderer would drop it silently", () => {
      const ctrl = themed();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;

      ctrl.setDraftProperty(id, "cssClass", 'x" onload="y');
      expect(ctrl.cssClassError).toMatch(/not a valid class name/);
      // Refused like a bad id: the draft survives, the tree is untouched.
      expect(ctrl.commitDraft(id)).toBe(false);
      expect(ctrl.getProperty(id, "cssClass")).toBeUndefined();
    });

    it("accepts any well-formed class when the binding declares no classes", () => {
      const ctrl = controller();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;
      ctrl.setDraftProperty(id, "cssClass", "host-page-class");
      expect(ctrl.cssClassError).toBeUndefined();
      expect(ctrl.cssClassWarning).toBeUndefined();
    });

    it("re-checks when the binding changes and when the selection moves", () => {
      const ctrl = themed();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;
      ctrl.setDraftProperty(id, "cssClass", "wide");
      ctrl.commitDraft(id);

      // Swapping to a binding that never declares "wide" flags the committed value too.
      ctrl.setOptions({ binding: declaring("other", ["narrow"]) });
      expect(ctrl.cssClassWarning).toBe('"wide" is not one of the binding\'s classes.');

      // The note follows the selection, like idError does.
      ctrl.select(undefined);
      expect(ctrl.cssClassWarning).toBeUndefined();
      ctrl.select(id);
      expect(ctrl.cssClassWarning).toBe('"wide" is not one of the binding\'s classes.');
    });

    it("drops the notes with the draft on discard", () => {
      const ctrl = themed();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;
      ctrl.setDraftProperty(id, "cssClass", "off-theme");
      expect(ctrl.cssClassWarning).toBeDefined();
      ctrl.discardDraft(id);
      expect(ctrl.cssClassWarning).toBeUndefined();
    });
  });

  describe("property drafts", () => {
    it("buffers edits away from the tree and writes them on commit", () => {
      const ctrl = controller();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;

      ctrl.setDraftProperty(id, "label", "Full name");
      expect(ctrl.hasPendingChanges()).toBe(true);
      // The draft is what the panel and the canvas preview read...
      expect(ctrl.editedNode()?.configuration).toMatchObject({ label: "Full name" });
      expect(
        (ctrl.previewSnapshot().children!.content![0]!.configuration as { label: string }).label
      ).toBe("Full name");
      // ...while the committed tree, which is what a host persists, is untouched.
      expect(ctrl.snapshot().children!.content![0]!.configuration).toMatchObject({
        label: "Untitled field"
      });

      expect(ctrl.commitDraft()).toBe(true);
      expect(ctrl.snapshot().children!.content![0]!.configuration).toMatchObject({
        label: "Full name"
      });
      expect(ctrl.hasPendingChanges()).toBe(false);
    });

    it("counts an edit taken back as no edit: a box ticked then unticked, a label typed back, keys in another order", () => {
      const ctrl = controller();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;
      // Unset in the form: ticking writes the switch, unticking leaves nothing to apply.
      ctrl.setDraftProperty(id, "disabled", true);
      expect(ctrl.hasPendingChanges(id)).toBe(true);
      ctrl.setDraftProperty(id, "disabled", false);
      expect(ctrl.hasPendingChanges(id)).toBe(false);
      expect(ctrl.editedNode(id)?.configuration).not.toHaveProperty("disabled");
      // An empty box over an unset property is unset too.
      ctrl.setDraftProperty(id, "placeholder", "x");
      ctrl.setDraftProperty(id, "placeholder", "");
      expect(ctrl.hasPendingChanges(id)).toBe(false);
      // A saved value typed back is the saved value.
      ctrl.setDraftProperty(id, "label", "Changed");
      expect(ctrl.hasPendingChanges(id)).toBe(true);
      ctrl.setDraftProperty(id, "label", "Untitled field");
      expect(ctrl.hasPendingChanges(id)).toBe(false);
      // An object written back with its keys in another order is the same object.
      ctrl.setProperty(id, "data", { sourceId: "a", filter: "b" });
      ctrl.setDraftProperty(id, "data", { filter: "b", sourceId: "a" });
      expect(ctrl.hasPendingChanges(id)).toBe(false);
      // Unticking a switch that was saved on is an edit.
      ctrl.setProperty(id, "disabled", true);
      ctrl.setDraftProperty(id, "disabled", false);
      expect(ctrl.hasPendingChanges(id)).toBe(true);
    });

    it("discards a draft without touching the undo history", () => {
      const ctrl = controller();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;
      ctrl.setDraftProperty(id, "label", "Abandoned");
      ctrl.discardDraft();

      expect(ctrl.hasPendingChanges()).toBe(false);
      expect(ctrl.editedNode()?.configuration).toMatchObject({ label: "Untitled field" });
      // `add` is still the only undoable step — the tree never saw the draft.
      ctrl.undo();
      expect(ctrl.snapshot().children?.content).toHaveLength(0);
    });

    it("commits a whole editing session as one undo entry", () => {
      const ctrl = controller();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;
      for (const value of ["F", "Fu", "Full name"]) {
        ctrl.setDraftProperty(id, "label", value);
      }
      ctrl.setDraftProperty(id, "required", true);
      ctrl.commitDraft();

      ctrl.undo();
      expect(ctrl.snapshot().children!.content![0]!.configuration).toMatchObject({
        label: "Untitled field"
      });
      expect(ctrl.snapshot().children!.content![0]!.configuration).not.toHaveProperty("required");
    });

    it("keeps drafts per component, so checking another field loses nothing", () => {
      const ctrl = controller();
      ctrl.add("text");
      const first = ctrl.selectedComponentId()!;
      ctrl.setDraftProperty(first, "label", "In progress");

      ctrl.add("number");
      const second = ctrl.selectedComponentId()!;
      // Per component: the new selection is clean, the one left behind still holds its draft —
      // which is what the no-argument "is anything unsaved" form reports.
      expect(ctrl.hasPendingChanges(second)).toBe(false);
      expect(ctrl.hasPendingChanges()).toBe(true);
      ctrl.select(first);
      expect(ctrl.hasPendingChanges(first)).toBe(true);
      expect(ctrl.editedNode()?.configuration).toMatchObject({ label: "In progress" });
    });

    it("refuses to commit an unusable id, keeping the draft rather than dropping it", () => {
      const ctrl = controller();
      ctrl.add("text");
      ctrl.add("text");
      const [first, second] = ctrl.snapshot().children!.content!.map((n) => n.id);
      ctrl.select(first!);

      ctrl.setDraftId(first!, second!);
      expect(ctrl.idError).toMatch(/already exists/i);
      expect(ctrl.commitDraft()).toBe(false);
      expect(ctrl.hasPendingChanges()).toBe(true);

      ctrl.setDraftId(first!, "customer_name");
      expect(ctrl.idError).toBeUndefined();
      expect(ctrl.commitDraft()).toBe(true);
      expect(ctrl.snapshot().children!.content![0]!.id).toBe("customer_name");
    });

    it("takes a removed component's draft with it, descendants included", () => {
      const ctrl = controller({
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            {
              id: "group",
              type: "fieldset",
              configuration: {},
              children: { body: [{ id: "inner", type: "text", configuration: {} }] }
            }
          ]
        }
      });
      ctrl.setDraftProperty("inner", "label", "Orphan");
      ctrl.remove("group");
      // A draft for a component that no longer exists would be committed onto nothing.
      expect(ctrl.previewSnapshot().children?.content).toHaveLength(0);
      expect(ctrl.hasPendingChanges("inner")).toBe(false);
    });

    it("does not spend an undo entry on a draft nothing changed in", () => {
      const ctrl = controller();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;
      ctrl.setDraftProperty(id, "label", "Untitled field"); // the value it already had
      expect(ctrl.hasPendingChanges()).toBe(false);
      ctrl.commitDraft();

      ctrl.undo();
      expect(ctrl.snapshot().children?.content).toHaveLength(0);
    });
  });

  describe("rules", () => {
    it("edits rules through the draft, alongside configuration, in one commit", () => {
      const ctrl = controller();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;

      ctrl.setDraftProperty(id, "label", "Email");
      ctrl.setDraftRules(id, { visibleWhen: { kind: "path", path: "opt_in" } });
      expect(ctrl.draftRules(id)).toEqual({ visibleWhen: { kind: "path", path: "opt_in" } });
      expect(ctrl.snapshot().children!.content![0]!.rules).toBeUndefined();

      ctrl.commitDraft();
      const saved = ctrl.snapshot().children!.content![0]!;
      expect(saved.configuration).toMatchObject({ label: "Email" });
      expect(saved.rules).toEqual({ visibleWhen: { kind: "path", path: "opt_in" } });

      // One entry: configuration and rules land together.
      ctrl.undo();
      expect(ctrl.snapshot().children!.content![0]!.rules).toBeUndefined();
    });

    it("removes the rules key entirely once the last rule is cleared", () => {
      const ctrl = controller({
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            {
              id: "email",
              type: "text",
              configuration: {},
              rules: { visibleWhen: { kind: "path", path: "opt_in" } }
            }
          ]
        }
      });
      ctrl.select("email");
      ctrl.setDraftRules("email", undefined);
      ctrl.commitDraft();
      // Not `rules: {}` — a component the author cleared reads back like one that never had any.
      expect(ctrl.snapshot().children!.content![0]).not.toHaveProperty("rules");
    });
  });

  describe("localization configuration (FormDefinition.localization)", () => {
    const SEEDED_LOCALES = [
      { code: "en", label: "English" },
      { code: "fr-CA", label: "Français (Canada)" }
    ];
    const seeded = () =>
      new BuilderController({
        initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } },
        localization: { defaultLocale: "en", supportedLocales: SEEDED_LOCALES }
      });

    it("seeds from options and exposes the committed value for the host to persist", () => {
      const ctrl = seeded();
      expect(ctrl.localization()).toEqual({ defaultLocale: "en", supportedLocales: SEEDED_LOCALES });
      // A defensive copy: mutating what came back must not reach the controller.
      ctrl.localization()!.supportedLocales!.push({ code: "xx" });
      expect(ctrl.localization()?.supportedLocales).toEqual(SEEDED_LOCALES);
    });

    it("writes the languages straight through setLocalization: committed at once, no draft to save or discard", () => {
      const ctrl = seeded();
      ctrl.select(ctrl.rootId());
      const next = {
        defaultLocale: "fr-CA",
        supportedLocales: [...SEEDED_LOCALES, { code: "ar-EG", label: "العربية (مصر)" }]
      };
      ctrl.setLocalization(next);

      // Nothing pends: the languages are not the root draft's, and the committed value moved.
      expect(ctrl.hasPendingChanges()).toBe(false);
      expect(ctrl.localization()).toEqual(next);
      expect(ctrl.canUndo()).toBe(true);

      // A discard has nothing of the languages to throw away.
      ctrl.discardDraft();
      expect(ctrl.localization()).toEqual(next);
    });

    it("spends an undo entry of its own on a setLocalization, and Undo and Redo move the languages", () => {
      const ctrl = seeded();
      ctrl.setLocalization({ supportedLocales: [{ code: "en", label: "English" }] });
      expect(ctrl.localization()).toEqual({ supportedLocales: [{ code: "en", label: "English" }] });
      expect(ctrl.canUndo()).toBe(true);
      ctrl.undo();
      expect(ctrl.localization()).toEqual({ defaultLocale: "en", supportedLocales: SEEDED_LOCALES });
      ctrl.redo();
      expect(ctrl.localization()).toEqual({ supportedLocales: [{ code: "en", label: "English" }] });
    });

    it("leaves non-root drafts untouched by localization state", () => {
      const ctrl = seeded();
      ctrl.add("text");
      const id = ctrl.selectedComponentId()!;
      ctrl.setDraftProperty(id, "label", "Name");
      ctrl.commitDraft();
      // The field's draft never carried localization, so committing it changes nothing there.
      expect(ctrl.localization()).toEqual({ defaultLocale: "en", supportedLocales: SEEDED_LOCALES });
      expect(ctrl.hasPendingChanges(id)).toBe(false);
    });

    it("normalizes on the way in: an emptied configuration collapses to undefined", () => {
      const ctrl = seeded();
      ctrl.setLocalization({ supportedLocales: [], defaultLocale: "" });
      expect(ctrl.localization()).toBeUndefined();
    });

    it("trims codes and drops repeats and blank labels", () => {
      const ctrl = seeded();
      ctrl.setLocalization({
        supportedLocales: [{ code: "en" }, { code: " fr-CA " }, { code: "en" }, { code: "ar-EG", label: "  " }]
      });
      // An entry with no label is stored without one.
      expect(ctrl.localization()).toEqual({
        supportedLocales: [{ code: "en" }, { code: "fr-CA" }, { code: "ar-EG" }]
      });
    });

    it("trims a label's whitespace: setLocalization is a write of record", () => {
      const ctrl = seeded();
      ctrl.setLocalization({ supportedLocales: [{ code: "en", label: "  English  " }] });
      expect(ctrl.localization()?.supportedLocales).toEqual([{ code: "en", label: "English" }]);
    });

    it("derives the canvas locale options from the form's supportedLocales, under their labels", () => {
      const ctrl = seeded();
      expect(ctrl.localeOptions()).toEqual([
        { code: "en", label: "English" },
        { code: "fr-CA", label: "Français (Canada)" }
      ]);

      ctrl.setLocalization({ supportedLocales: [{ code: "ar-EG" }, { code: "en", label: "English" }] });
      // The committed list drives the switcher, in the form's order; an
      // unlabelled locale is named in its own language, never left as a bare code.
      expect(ctrl.localeOptions()).toEqual([
        { code: "ar-EG", label: localeDisplayName("ar-EG") },
        { code: "en", label: "English" }
      ]);
      expect(localeDisplayName("ar-EG")).not.toBe("ar-EG");
    });

    it("offers no locales at all when the form declares no localization", () => {
      const ctrl = new BuilderController({
        initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } }
      });
      expect(ctrl.localization()).toBeUndefined();
      // Nothing for the canvas switcher to offer: a single-language form is not asked to configure localization.
      expect(ctrl.localeOptions()).toEqual([]);
    });

    it("supports the direct host path (setLocalization) beside an open root draft, which it leaves alone", () => {
      const ctrl = seeded();
      ctrl.select(ctrl.rootId());
      ctrl.setDraftProperty(ctrl.rootId(), "title", "Drafting");
      ctrl.setLocalization({ supportedLocales: [{ code: "en" }] });
      expect(ctrl.localization()).toEqual({ supportedLocales: [{ code: "en" }] });
      // The title edit still pends; the languages are no part of the draft.
      expect(ctrl.hasPendingChanges()).toBe(true);
      ctrl.commitDraft();
      expect(ctrl.localization()).toEqual({ supportedLocales: [{ code: "en" }] });
      expect(ctrl.selectedNode()?.configuration).toMatchObject({ title: "Drafting" });
    });

    it("declares the locales silently for a caller that repaints itself, beside an open root draft", () => {
      const ctrl = seeded();
      ctrl.select(ctrl.rootId());
      ctrl.setDraftProperty(ctrl.rootId(), "title", "Drafting");
      const reasons: string[] = [];
      ctrl.on("change", (event) => reasons.push(event.reason));
      ctrl.setLocalization({ supportedLocales: [{ code: "en" }, { code: "fr-CA" }] }, { silent: true });
      expect(reasons).toEqual([]);
      expect(ctrl.localeOptions().map((entry) => entry.code)).toEqual(["en", "fr-CA"]);
      // A Save writes the title and drops nothing: the draft never carried the languages.
      ctrl.commitDraft();
      expect(ctrl.localization()?.supportedLocales?.length).toBe(2);
    });

    describe("removing a supported locale", () => {
      const ARABIC = { code: "ar-EG", label: "العربية" };
      const LOCALIZED_ROOT: ComponentNode = {
        id: "root",
        type: "form",
        configuration: { title: "Intake" },
        children: {
          content: [
            { id: "name", type: "text", configuration: { label: "Name" } },
            { id: "note", type: "text", configuration: { label: "Notes" } }
          ]
        }
      };
      /** The form's French and Arabic, written with the module's own writer. */
      const TRANSLATIONS = ((): FormTranslations => {
        let map: FormTranslations = {};
        map = writeTranslation(map, "fr-CA", addressOf.form("title"), "Admission", "Intake");
        map = writeTranslation(map, "fr-CA", addressOf.component("name", "label"), "Nom", "Name");
        map = writeTranslation(map, "ar-EG", addressOf.component("name", "label"), "الاسم", "Name");
        return map;
      })();
      const localized = () =>
        new BuilderController({
          initialRoot: structuredClone(LOCALIZED_ROOT),
          localization: { defaultLocale: "en", supportedLocales: [...SEEDED_LOCALES, ARABIC] },
          translations: structuredClone(TRANSLATIONS)
        });
      /** Removes fr-CA the way the Languages workspace's Remove does (one committed step). */
      const dropFrench = (ctrl: BuilderController): void => {
        expect(ctrl.localizationActions.removeLocale("fr-CA")).toBe(true);
      };
      const listen = (ctrl: BuilderController): BuilderChangeEvent[] => {
        const events: BuilderChangeEvent[] = [];
        ctrl.on("change", (event) => events.push(event));
        return events;
      };
      const content = (ctrl: BuilderController): ComponentNode[] => ctrl.snapshot().children!.content!;

      it("counts, before the removal, the translations a language holds", () => {
        const ctrl = localized();
        // The root's own title counts, alongside every field's text.
        expect(ctrl.localeTranslationCount(["fr-CA"])).toBe(2);
        expect(ctrl.localeTranslationCount(["fr-CA", "ar-EG"])).toBe(3);
        // Nothing has happened: it is a question, not an edit.
        expect(ctrl.translations()).toEqual(TRANSLATIONS);
        expect(content(ctrl)[0]!.configuration).toEqual(LOCALIZED_ROOT.children!.content![0]!.configuration);
      });

      it("counts the journeys' and layouts' translations too: they are in the same map", () => {
        const ctrl = localized();
        ctrl.replaceTranslations(writeTranslation(ctrl.translations(), "fr-CA", addressOf.journey("apply", "name"), "Demande", "Apply"), { silent: true });
        ctrl.replaceTranslations(writeTranslation(ctrl.translations(), "fr-CA", addressOf.pdf("copy", ["name"]), "Copie", "Copy"), { silent: true });
        expect(ctrl.localeTranslationCount(["fr-CA"])).toBe(4);
      });

      it("takes no translation with a relabel, a reorder or an addition", () => {
        const ctrl = localized();
        expect(ctrl.localizationActions.relabelLocale("fr-CA", "Français")).toBe(true);
        expect(ctrl.localizationActions.addLocale("es")).toBe(true);
        const declared = ctrl.localization()!;
        ctrl.setLocalization({ ...declared, supportedLocales: [...(declared.supportedLocales ?? [])].reverse() });
        expect(ctrl.localization()?.supportedLocales?.[0]).toMatchObject({ code: "es" });
        expect(ctrl.translations()).toEqual(TRANSLATIONS);
        expect(content(ctrl)[0]!.configuration).toEqual(LOCALIZED_ROOT.children!.content![0]!.configuration);
      });

      it("removes that locale's translations with it, as one undoable edit", () => {
        const ctrl = localized();
        dropFrench(ctrl);

        // The strings are untouched; the map loses the language.
        expect(ctrl.snapshot().configuration).toEqual({ title: "Intake" });
        expect(content(ctrl)[0]!.configuration).toEqual({ label: "Name" });
        expect(Object.keys(ctrl.translations() ?? {})).toEqual(["ar-EG"]);
        expect(ctrl.localization()?.supportedLocales).toEqual([{ code: "en", label: "English" }, ARABIC]);

        // One undo brings every translation back, the root's included, and the language with them.
        expect(ctrl.canUndo()).toBe(true);
        ctrl.undo();
        expect(ctrl.translations()).toEqual(TRANSLATIONS);
        expect(ctrl.canUndo()).toBe(false);
        expect(ctrl.localization()?.supportedLocales).toEqual([{ code: "en", label: "English" }, { code: "fr-CA", label: "Français (Canada)" }, ARABIC]);
      });

      it("removes a locale no text was translated in, and the removal is an undo entry of its own", () => {
        const ctrl = seeded();
        expect(ctrl.localeTranslationCount(["fr-CA"])).toBe(0);
        expect(ctrl.localizationActions.removeLocale("fr-CA")).toBe(true);
        // The language itself is an edit: Undo brings it back.
        expect(ctrl.canUndo()).toBe(true);
        ctrl.undo();
        expect(ctrl.localization()?.supportedLocales?.map((entry) => (typeof entry === "string" ? entry : entry.code))).toEqual(["en", "fr-CA"]);
      });

      it("has no change event field for a removed locale: a host reads the definition's localization", () => {
        const ctrl = localized();
        const events = listen(ctrl);
        dropFrench(ctrl);
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((event) => !("removedLocales" in event))).toBe(true);
      });

      it("keeps another component's open draft as it is: its Save writes strings, never a language back", () => {
        const ctrl = localized();
        ctrl.select("name");
        ctrl.setDraftProperty("name", "description", "Typed, not saved");
        dropFrench(ctrl);

        ctrl.select("name");
        expect(ctrl.hasPendingChanges("name")).toBe(true);
        ctrl.commitDraft("name");
        expect(content(ctrl)[0]!.configuration).toEqual({ label: "Name", description: "Typed, not saved" });
        expect(Object.keys(ctrl.translations() ?? {})).toEqual(["ar-EG"]);
      });
    });
  });

  it("lists every translatable text of the form, declared or written, with the address its translations live at", () => {
    const ctrl = new BuilderController({
      initialRoot: {
        id: "root",
        type: "form",
        configuration: { title: "Intake" },
        children: {
          content: [
            {
              id: "container_2",
              type: "container",
              configuration: {},
              children: {
                content: [{ id: "input_4", type: "text", configuration: { label: "Name" } }]
              }
            }
          ]
        }
      },
      localization: { supportedLocales: [{ code: "fr-CA", label: "Français" }] },
      translations: { "fr-CA": { form: { title: { text: "Admission", source: sourceHash("Intake") } } } }
    });
    const texts = ctrl.translatableTexts();
    // Tree order, the root's own texts first; a text the component declares but nobody wrote
    // (the description) is listed with an empty default, so an editor can offer it.
    expect(texts.map((text) => `${text.componentId}.${text.propertyPath}`)).toEqual([
      "root.title",
      "root.description",
      "container_2.label",
      "container_2.description",
      "input_4.label",
      "input_4.description"
    ]);
    expect(texts[0]).toMatchObject({ componentLabel: "Intake", label: "Form title", default: "Intake", address: addressOf.form("title") });
    // A component with nothing written names itself by id.
    expect(texts[2]).toMatchObject({ componentLabel: "container_2", default: "" });
    // A text lives at its component's id, however deep the container nests it.
    expect(texts[4]).toMatchObject({ componentLabel: "Name", label: "Label", default: "Name", address: addressOf.component("input_4", "label") });
    expect(texts[5]).toMatchObject({ default: "", address: addressOf.component("input_4", "description") });
    // Committed, not drafted: an unsaved edit is not what the translations are made against.
    ctrl.select("input_4");
    ctrl.setDraftProperty("input_4", "label", "Full name");
    expect(ctrl.translatableTexts()[4]?.default).toBe("Name");
  });

  it("applies template drops targeting a nested slot", () => {
    const ctrl = controller({
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "group", type: "fieldset", configuration: {}, children: { body: [] } }] }
    });
    const store = new Map<string, string>();
    const dt = {
      setData: (k: string, v: string) => store.set(k, v),
      getData: (k: string) => store.get(k) ?? ""
    };
    store.set(
      "application/x-datum-builder-drag",
      JSON.stringify({ kind: "template-component", component: { id: "seed", type: "text", configuration: {} } })
    );

    ctrl.applyDrop(dt, "group", "body", 0);
    expect(ctrl.snapshot().children?.content?.[0]?.children?.body).toHaveLength(1);
  });
});

describe("BuilderController — form identity (FormDefinition.id / version / schemaVersion)", () => {
  const IDENTITY = { id: "intake", version: "1.0.0", schemaVersion: "1" };
  const seeded = () =>
    new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } },
      identity: IDENTITY
    });

  it("seeds from options and exposes the committed value for the host to persist", () => {
    const ctrl = seeded();
    expect(ctrl.identity()).toEqual(IDENTITY);
    // A defensive copy: mutating what came back must not reach the controller.
    ctrl.identity()!.id = "changed";
    expect(ctrl.identity()?.id).toBe("intake");
    // Without one, there is nothing to edit: the panel shows no section, drafts ignore it.
    const bare = new BuilderController({ initialRoot: { id: "root", type: "form", configuration: {} } });
    expect(bare.identity()).toBeUndefined();
    bare.select(bare.rootId());
    bare.setDraftIdentity({ id: "x", version: "1", schemaVersion: "1" });
    expect(bare.draftIdentity()).toBeUndefined();
    expect(bare.hasPendingChanges()).toBe(false);
  });

  it("edits through the root draft: Save commits, Cancel discards, and nothing spends an undo entry", () => {
    const ctrl = seeded();
    ctrl.select(ctrl.rootId());
    ctrl.setDraftIdentity({ ...IDENTITY, id: "customer-intake", version: "2.0.0" });

    // Drafted, not committed — and the panel-facing view shows the draft.
    expect(ctrl.hasPendingChanges()).toBe(true);
    expect(ctrl.identity()?.id).toBe("intake");
    expect(ctrl.draftIdentity()).toEqual({ id: "customer-intake", version: "2.0.0", schemaVersion: "1" });

    expect(ctrl.commitDraft()).toBe(true);
    expect(ctrl.identity()).toEqual({ id: "customer-intake", version: "2.0.0", schemaVersion: "1" });
    expect(ctrl.hasPendingChanges()).toBe(false);
    // Definition-level state, outside the tree and outside the undo history.
    expect(ctrl.canUndo()).toBe(false);

    ctrl.setDraftIdentity({ ...IDENTITY, id: "thrown-away" });
    ctrl.discardDraft();
    expect(ctrl.identity()?.id).toBe("customer-intake");
    expect(ctrl.draftIdentity()?.id).toBe("customer-intake");
  });

  it("keeps whitespace while drafting, trims on Save, and a blank box keeps its committed value", () => {
    const ctrl = seeded();
    ctrl.select(ctrl.rootId());
    // Mid-typing: "1.0 " is on its way to "1.0 beta"; the panel repaints from the draft.
    ctrl.setDraftIdentity({ ...IDENTITY, version: "1.0 " });
    expect(ctrl.draftIdentity()?.version).toBe("1.0 ");
    ctrl.setDraftIdentity({ id: "  renamed  ", version: "   ", schemaVersion: "2" });
    ctrl.commitDraft();
    // A form with no version is not something a host can store or submit against.
    expect(ctrl.identity()).toEqual({ id: "renamed", version: "1.0.0", schemaVersion: "2" });
  });

  it("commits the identity alongside the root's own configuration in one Save", () => {
    const ctrl = seeded();
    ctrl.select(ctrl.rootId());
    ctrl.setDraftProperty(ctrl.rootId(), "title", "Intake");
    ctrl.setDraftIdentity({ ...IDENTITY, version: "1.1.0" });
    ctrl.commitDraft();
    expect(ctrl.selectedNode()?.configuration).toMatchObject({ title: "Intake" });
    expect(ctrl.identity()?.version).toBe("1.1.0");
    expect(ctrl.canUndo()).toBe(true);
  });

  it("takes a new identity from setOptions and the direct host path, keeping an open draft in step", () => {
    const ctrl = seeded();
    const changes: string[] = [];
    ctrl.on("change", (detail) => changes.push(detail.reason));

    ctrl.setOptions({ identity: { id: "loaded", version: "3.0.0", schemaVersion: "1" } });
    expect(ctrl.identity()).toEqual({ id: "loaded", version: "3.0.0", schemaVersion: "1" });
    expect(changes).toEqual(["edit"]);
    // The same identity again is not a change.
    ctrl.setOptions({ identity: { id: "loaded", version: "3.0.0", schemaVersion: "1" } });
    expect(changes).toEqual(["edit"]);

    ctrl.select(ctrl.rootId());
    ctrl.setDraftIdentity({ id: "loaded", version: "3.0.1", schemaVersion: "1" });
    ctrl.setIdentity({ id: "set-directly", version: "", schemaVersion: "1" }, { silent: true });
    // Direct writes trim and fall back like a Save; the draft follows so a later Save does not undo it.
    expect(ctrl.identity()).toEqual({ id: "set-directly", version: "3.0.0", schemaVersion: "1" });
    expect(ctrl.draftIdentity()).toEqual({ id: "set-directly", version: "3.0.0", schemaVersion: "1" });
    expect(ctrl.hasPendingChanges()).toBe(false);

    // `undefined` takes the section away again: nothing to edit, nothing pending.
    ctrl.setIdentity(undefined);
    expect(ctrl.identity()).toBeUndefined();
    expect(ctrl.draftIdentity()).toBeUndefined();
  });
});

describe("BuilderController — grid columns", () => {
  it("drops into a specific column, stacks there, and leaves the other columns alone", () => {
    const ctrl = controller(gridForm(3, { column_1: [], column_2: [], column_3: [] }));

    ctrl.add("text", "g", "column_2");
    ctrl.add("text", "g", "column_2");
    expect(ctrl.dropError).toBeUndefined();
    const children = gridChildren(ctrl);
    expect(children.column_1).toEqual([]);
    expect(children.column_2).toHaveLength(2);
    expect(children.column_3).toEqual([]);
  });

  it("shows a drop zone for a new column the moment it is configured, before Save", () => {
    const ctrl = controller(gridForm(2, { column_1: [], column_2: [] }));
    ctrl.select("g");
    ctrl.setDraftProperty("g", "columns", 3);

    // The canvas previews from the draft, so the third column is already a target …
    const grid = ctrl.treeView().slots[0]?.children[0];
    expect(grid?.slots.map((s) => s.slotId)).toEqual(["column_1", "column_2", "column_3"]);
    // … while the committed tree, which a host persists, still says two.
    expect(ctrl.snapshot().children?.content?.[0]?.configuration).toEqual({ columns: 2 });
  });

  it("folds a removed column's fields into the last remaining one on Save, as one undo", () => {
    const ctrl = controller(
      gridForm(3, { column_1: [field("a")], column_2: [field("b")], column_3: [field("c"), field("d")] })
    );
    const commands: string[] = [];
    ctrl.on("mutation", (m) => commands.push(`${m.action}:${m.commandId}`));

    ctrl.select("g");
    ctrl.setDraftProperty("g", "columns", 2);
    expect(ctrl.commitDraft("g")).toBe(true);

    expect(ctrl.snapshot().children?.content?.[0]?.configuration).toEqual({ columns: 2 });
    // Nothing lost: the third column's fields join the second, after what was already there.
    expect(gridChildren(ctrl)).toEqual({ column_1: ["a"], column_2: ["b", "c", "d"] });
    // One history entry, reported as the edit it is.
    expect(commands).toEqual(["execute:EDIT_COMPONENT"]);

    ctrl.undo();
    expect(ctrl.snapshot().children?.content?.[0]?.configuration).toEqual({ columns: 3 });
    expect(gridChildren(ctrl)).toEqual({ column_1: ["a"], column_2: ["b"], column_3: ["c", "d"] });

    ctrl.redo();
    expect(gridChildren(ctrl)).toEqual({ column_1: ["a"], column_2: ["b", "c", "d"] });
  });

  it("folds through the direct setProperty path too", () => {
    const ctrl = controller(gridForm(2, { column_1: [field("a")], column_2: [field("b")] }));

    ctrl.setProperty("g", "columns", 1);
    expect(gridChildren(ctrl)).toEqual({ column_1: ["a", "b"] });

    ctrl.undo();
    expect(gridChildren(ctrl)).toEqual({ column_1: ["a"], column_2: ["b"] });
    expect(ctrl.snapshot().children?.content?.[0]?.configuration).toEqual({ columns: 2 });
  });

  it("spends no extra entry when the column count grows or the edit is not a grid's", () => {
    const ctrl = controller(gridForm(2, { column_1: [field("a")], column_2: [] }));
    const commands: string[] = [];
    ctrl.on("mutation", (m) => commands.push(m.commandId));

    ctrl.setProperty("g", "columns", 4);
    ctrl.setProperty("a", "label", "A");
    expect(commands).toEqual(["SET_PROPERTY", "SET_PROPERTY"]);
    expect(gridChildren(ctrl)).toEqual({ column_1: ["a"], column_2: [] });
  });

  it("takes the column count from a span list typed into Columns, and folds when it shrinks", () => {
    // One text box: "3/6/3" is three sized columns, "8/4" two — the count is the list's length.
    const ctrl = controller(gridForm(2, { column_1: [field("a")], column_2: [field("b")] }));
    ctrl.select("g");
    ctrl.setDraftProperty("g", "columns", "3/6/3");
    expect(ctrl.treeView().slots[0]?.children[0]?.slots.map((s) => s.slotId)).toEqual([
      "column_1",
      "column_2",
      "column_3"
    ]);
    expect(ctrl.commitDraft("g")).toBe(true);
    ctrl.add("text", "g", "column_3");
    expect(gridChildren(ctrl).column_3).toHaveLength(1);

    ctrl.setProperty("g", "columns", "8/4");
    expect(gridChildren(ctrl)).toEqual({ column_1: ["a"], column_2: ["b", "text_1"] });
    ctrl.undo();
    expect(gridChildren(ctrl).column_3).toEqual(["text_1"]);
  });
});

describe("BuilderController — unsaved changes prompt", () => {
  /** Two fields, the first selected with an unsaved label edit. */
  function withDraft() {
    const ctrl = controller();
    ctrl.add("text");
    ctrl.add("number");
    const [first, second] = ctrl.snapshot().children!.content!.map((n) => n.id);
    ctrl.select(first!);
    ctrl.setDraftProperty(first!, "label", "In progress");
    return { ctrl, first: first!, second: second! };
  }

  function dropOf(payload: unknown) {
    const store = new Map<string, string>([
      ["application/x-datum-builder-drag", JSON.stringify(payload)]
    ]);
    return { setData: (k: string, v: string) => store.set(k, v), getData: (k: string) => store.get(k) ?? "" };
  }

  it("holds a selection change behind a prompt while the selection has unsaved edits", () => {
    const { ctrl, first, second } = withDraft();
    const reasons: string[] = [];
    ctrl.on("change", (e) => reasons.push(e.reason));

    expect(ctrl.requestSelect(second)).toBe(false);
    expect(ctrl.selectedComponentId()).toBe(first);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: first, action: "select" });
    // The panels repaint to show the prompt; nothing about the tree or the draft changed.
    expect(reasons).toEqual(["select"]);
    expect(ctrl.hasPendingChanges(first)).toBe(true);
    expect(ctrl.snapshot().children!.content![0]!.configuration).toMatchObject({ label: "Untitled field" });
  });

  it("selects at once when nothing is unsaved, and does not count re-selecting as leaving", () => {
    const ctrl = controller();
    ctrl.add("text");
    ctrl.add("number");
    const first = ctrl.snapshot().children!.content![0]!.id;
    expect(ctrl.requestSelect(first)).toBe(true);
    expect(ctrl.selectedComponentId()).toBe(first);

    ctrl.setDraftProperty(first, "label", "In progress");
    expect(ctrl.requestSelect(first)).toBe(true);
    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();
    // Putting the selection down is leaving it, though.
    expect(ctrl.requestSelect(undefined)).toBe(false);
    expect(ctrl.unsavedChangesPrompt()?.componentId).toBe(first);
  });

  it("saves and carries on", () => {
    const { ctrl, first, second } = withDraft();
    ctrl.requestSelect(second);
    ctrl.answerUnsavedChangesPrompt("save");

    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();
    expect(ctrl.selectedComponentId()).toBe(second);
    expect(ctrl.snapshot().children!.content![0]!.configuration).toMatchObject({ label: "In progress" });
    expect(ctrl.hasPendingChanges(first)).toBe(false);
  });

  it("discards and carries on, leaving the tree and the undo history untouched", () => {
    const { ctrl, first, second } = withDraft();
    const undoable = ctrl.canUndo();
    ctrl.requestSelect(second);
    ctrl.answerUnsavedChangesPrompt("discard");

    expect(ctrl.selectedComponentId()).toBe(second);
    expect(ctrl.snapshot().children!.content![0]!.configuration).toMatchObject({ label: "Untitled field" });
    expect(ctrl.hasPendingChanges(first)).toBe(false);
    expect(ctrl.canUndo()).toBe(undoable);
  });

  it("stays put, draft intact, when the author keeps editing", () => {
    const { ctrl, first, second } = withDraft();
    ctrl.requestSelect(second);
    ctrl.answerUnsavedChangesPrompt("stay");

    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();
    expect(ctrl.selectedComponentId()).toBe(first);
    expect(ctrl.editedNode()?.configuration).toMatchObject({ label: "In progress" });
  });

  it("does not move on when the save is refused", () => {
    const { ctrl, first, second } = withDraft();
    ctrl.setDraftId(first, second); // clashes with the other field's id
    ctrl.requestSelect(second);
    ctrl.answerUnsavedChangesPrompt("save");

    // Refused like any other save: the draft and the selection stay, the error shows.
    expect(ctrl.selectedComponentId()).toBe(first);
    expect(ctrl.idError).toBeDefined();
    expect(ctrl.hasPendingChanges(first)).toBe(true);
    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();
  });

  it("holds adding and dropping components the same way", () => {
    const { ctrl, first } = withDraft();
    expect(ctrl.requestAdd("text")).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: first, action: "add" });
    expect(ctrl.snapshot().children!.content).toHaveLength(2);
    ctrl.answerUnsavedChangesPrompt("save");
    expect(ctrl.snapshot().children!.content).toHaveLength(3);
    expect(ctrl.selectedComponentId()).toBe(ctrl.snapshot().children!.content![2]!.id);

    // Back on the first field with a fresh draft, a drop of another component waits too.
    ctrl.select(first);
    ctrl.setDraftProperty(first, "label", "Again");
    const ids = ctrl.snapshot().children!.content!.map((n) => n.id);
    ctrl.applyDrop(dropOf({ kind: "existing-component", componentId: ids[1] }), "root", "content", 3);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: first, action: "drop" });
    expect(ctrl.snapshot().children!.content!.map((n) => n.id)).toEqual(ids);
    ctrl.answerUnsavedChangesPrompt("discard");
    expect(ctrl.snapshot().children!.content!.map((n) => n.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(ctrl.selectedComponentId()).toBe(ids[1]);
  });

  it("moves the component being edited without asking — its draft goes with it", () => {
    const { ctrl, first } = withDraft();
    ctrl.applyDrop(dropOf({ kind: "existing-component", componentId: first }), "root", "content", 2);

    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();
    expect(ctrl.snapshot().children!.content!.map((n) => n.id)[1]).toBe(first);
    expect(ctrl.hasPendingChanges(first)).toBe(true);
  });

  it("edits the form root as a named subject, not as what the inspector falls back to", () => {
    const ctrl = controller({
      id: "root",
      type: "form",
      configuration: { title: "Customer Intake" },
      children: { content: [] }
    });
    ctrl.add("text");
    const field = ctrl.selectedComponentId()!;

    // Nothing selected means nothing for the inspector to show: the root is the Form panel's,
    // and that panel names it.
    ctrl.select(undefined);
    expect(ctrl.selectedComponentId()).toBeUndefined();
    expect(ctrl.isRootSelected()).toBe(false);
    expect(ctrl.editedNode()).toBeUndefined();
    expect(ctrl.inspectorModel()).toBeUndefined();
    expect(ctrl.editedNode(ctrl.rootId())?.type).toBe("form");
    expect(
      ctrl.inspectorModel(ctrl.rootId())?.sections[0]?.fields.map((f) => f.propertyPath)
    ).toContain("title");

    // The root's draft is reported by id, and by the no-argument "is anything unsaved" form.
    ctrl.setDraftProperty("root", "title", "Intake v2");
    expect(ctrl.hasPendingChanges("root")).toBe(true);
    expect(ctrl.hasPendingChanges()).toBe(true);
    expect(ctrl.hasPendingChanges(field)).toBe(false);

    // Clicking a field does not ask about it: the Form panel stays on screen with its own
    // Save and Cancel, so nothing is being walked away from.
    expect(ctrl.requestSelect(field)).toBe(true);
    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();
    expect(ctrl.selectedComponentId()).toBe(field);
    expect(ctrl.hasPendingChanges("root")).toBe(true);

    // Leaving the builder does, since it takes the panel away with everything else.
    let left = 0;
    expect(ctrl.requestLeave(() => left++)).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "root", action: "leave" });
    ctrl.answerUnsavedChangesPrompt("save");
    expect(left).toBe(1);
    expect(ctrl.snapshot().configuration).toMatchObject({ title: "Intake v2" });
  });

  it("holds a host leaving the builder the same way, and runs its departure once answered", () => {
    const { ctrl, first } = withDraft();
    let left = 0;

    expect(ctrl.requestLeave(() => left++)).toBe(false);
    expect(left).toBe(0);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: first, action: "leave" });

    // Keep editing: the host stays where it is, the draft untouched.
    ctrl.answerUnsavedChangesPrompt("stay");
    expect(left).toBe(0);
    expect(ctrl.hasPendingChanges(first)).toBe(true);

    // Save: the edit lands, then the host goes.
    expect(ctrl.requestLeave(() => left++)).toBe(false);
    ctrl.answerUnsavedChangesPrompt("save");
    expect(left).toBe(1);
    expect(ctrl.snapshot().children!.content![0]!.configuration).toMatchObject({ label: "In progress" });

    // Nothing unsaved: the departure runs at once, and no prompt is raised.
    expect(ctrl.requestLeave(() => left++)).toBe(true);
    expect(left).toBe(2);
    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();

    // Discard: the draft goes, the tree stays as saved, and the host goes too.
    ctrl.setDraftProperty(first, "label", "Second thoughts");
    expect(ctrl.requestLeave(() => left++)).toBe(false);
    ctrl.answerUnsavedChangesPrompt("discard");
    expect(left).toBe(3);
    expect(ctrl.hasPendingChanges(first)).toBe(false);
    expect(ctrl.snapshot().children!.content![0]!.configuration).toMatchObject({ label: "In progress" });
  });

  it("holds a leave for a guard's edits outside the tree once the draft is clean, and settles them through it", () => {
    const { ctrl, first } = withDraft();
    const guard = { pending: true, blocked: false, saves: 0, discards: 0 };
    ctrl.setLeaveGuard({
      pending: () => guard.pending,
      subject: () => ({ id: "paper", label: "Paper form", blocked: guard.blocked }),
      save: () => {
        guard.saves += 1;
        if (guard.blocked) {
          return false;
        }
        guard.pending = false;
        return true;
      },
      discard: () => {
        guard.discards += 1;
        guard.pending = false;
      }
    });
    let left = 0;

    // The tree's draft comes first: the prompt is the draft's, and Save lands it.
    expect(ctrl.requestLeave(() => left++)).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: first, action: "leave" });
    ctrl.answerUnsavedChangesPrompt("save");
    // …and the guard's edits hold the departure next, under the guard's own name.
    expect(left).toBe(0);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "paper", action: "leave", external: { id: "paper", label: "Paper form", blocked: false } });

    // Keep editing: nothing moves.
    ctrl.answerUnsavedChangesPrompt("stay");
    expect(left).toBe(0);
    expect(guard.saves + guard.discards).toBe(0);

    // A refused save keeps the author where they are, the edits intact; the prompt is down.
    guard.blocked = true;
    expect(ctrl.requestLeave(() => left++)).toBe(false);
    expect(ctrl.unsavedChangesPrompt()?.external?.blocked).toBe(true);
    ctrl.answerUnsavedChangesPrompt("save");
    expect(guard.saves).toBe(1);
    expect(left).toBe(0);
    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();

    // Discard: the guard drops its edits and the departure runs.
    expect(ctrl.requestLeave(() => left++)).toBe(false);
    ctrl.answerUnsavedChangesPrompt("discard");
    expect(guard.discards).toBe(1);
    expect(left).toBe(1);

    // Save, when it can: the guard lands its edits and the departure runs.
    guard.pending = true;
    guard.blocked = false;
    expect(ctrl.requestLeave(() => left++)).toBe(false);
    ctrl.answerUnsavedChangesPrompt("save");
    expect(guard.saves).toBe(2);
    expect(left).toBe(2);

    // Only leaving asks the guard: a tree action with a clean draft runs at once.
    guard.pending = true;
    expect(ctrl.requestSelect(undefined)).toBe(true);
    // And a guard removed is a guard no longer asked.
    ctrl.setLeaveGuard(undefined);
    expect(ctrl.requestLeave(() => left++)).toBe(true);
    expect(left).toBe(3);
  });

  it("forgets a held action when the selection moves by other means", () => {
    const { ctrl, second } = withDraft();
    ctrl.requestSelect(second);
    // A host driving the builder directly is not asked.
    ctrl.select(undefined);
    expect(ctrl.unsavedChangesPrompt()).toBeUndefined();
    expect(ctrl.selectedComponentId()).toBeUndefined();
  });

  describe("an action held while the Save renames the component it targets", () => {
    /** A fieldset `box`, selected, with an unsaved id `details`. */
    function renaming() {
      const ctrl = controller({
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "box", type: "fieldset", configuration: {}, children: { body: [] } },
            { id: "loose", type: "text", configuration: {} }
          ]
        }
      });
      ctrl.select("box");
      ctrl.setDraftId("box", "details");
      return ctrl;
    }
    const bodyOf = (ctrl: BuilderController) => ctrl.snapshot().children!.content![0]!;

    it("lands a held drop in the renamed container", () => {
      const ctrl = renaming();
      ctrl.applyDrop(dropOf(ctrl.dragPayloadForType("text")), "box", "body", 0);
      expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "box", action: "drop" });
      ctrl.answerUnsavedChangesPrompt("save");

      expect(ctrl.dropError).toBeUndefined();
      expect(bodyOf(ctrl).id).toBe("details");
      expect(bodyOf(ctrl).children!.body).toHaveLength(1);
    });

    it("adds and moves into the renamed container", () => {
      const added = renaming();
      expect(added.requestAdd("text", "box", "body")).toBe(false);
      added.answerUnsavedChangesPrompt("save");
      expect(added.dropError).toBeUndefined();
      expect(bodyOf(added).children!.body).toHaveLength(1);

      const moved = renaming();
      expect(moved.requestMove("loose", { parentId: "box", slotId: "body", index: 0 })).toBe(false);
      moved.answerUnsavedChangesPrompt("save");
      expect(moved.dropError).toBeUndefined();
      expect(bodyOf(moved).children!.body!.map((n) => n.id)).toEqual(["loose"]);

      const movedTo = renaming();
      expect(movedTo.requestMoveTo("loose", "box", 0, "body")).toBe(false);
      movedTo.answerUnsavedChangesPrompt("save");
      expect(movedTo.dropError).toBeUndefined();
      expect(bodyOf(movedTo).children!.body!.map((n) => n.id)).toEqual(["loose"]);
    });

    it("moves and duplicates the renamed component itself", () => {
      const moved = renaming();
      expect(moved.requestMoveBy("box", 1)).toBe(false);
      moved.answerUnsavedChangesPrompt("save");
      expect(moved.snapshot().children!.content!.map((n) => n.id)).toEqual(["loose", "details"]);

      const copied = renaming();
      expect(copied.requestDuplicate("box")).toBe(false);
      copied.answerUnsavedChangesPrompt("save");
      expect(copied.snapshot().children!.content).toHaveLength(3);
    });
  });
});

describe("BuilderController — host validation codes for the messages editor", () => {
  // The form's own messages: the Form panel's subject is the root, so the model
  // is asked for by id rather than read off an empty selection.
  const messagesRow = (ctrl: BuilderController) =>
    ctrl
      .inspectorModel(ctrl.rootId())
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.control === "messages");

  it("offers the codes the host named, after the engine's own, and follows a later setOptions", () => {
    const ctrl = controller();
    ctrl.setOptions({ validationCodes: ["taken", { code: "delivery.failed", label: "The form could not be sent." }] });
    // The form root's messages row lists the codes.
    expect(messagesRow(ctrl)?.messagesEditor?.scope).toBe("form");
    expect(messagesRow(ctrl)?.messagesEditor?.hostCodes).toEqual([
      { code: "taken", label: "Named by the page", parameters: [] },
      { code: "delivery.failed", label: "The form could not be sent.", parameters: [] }
    ]);
    expect(ctrl.validationCodes()).toEqual(["taken", { code: "delivery.failed", label: "The form could not be sent." }]);

    ctrl.setOptions({ validationCodes: ["other"] });
    expect(messagesRow(ctrl)?.messagesEditor?.hostCodes.map((entry) => entry.code)).toEqual(["other"]);
    // Left out of a later call, the codes stay as they were.
    ctrl.setOptions({ locale: "fr-CA" });
    expect(messagesRow(ctrl)?.messagesEditor?.hostCodes.map((entry) => entry.code)).toEqual(["other"]);
  });

  it("offers none by default", () => {
    expect(messagesRow(controller())?.messagesEditor?.hostCodes).toEqual([]);
  });
});

describe("paletteEntriesOf", () => {
  it("lists the definitions that declare a palette entry, in order, and skips the rest", () => {
    const entries = paletteEntriesOf([
      def("form", { children: { slots: [{ id: "content", multiple: true }] } }),
      def("rating", { palette: { label: "Rating", icon: "★", group: "Survey" } }),
      def("gcds-notice", { palette: { label: "Notice", group: "GC Design System" } }),
      def("plain", { palette: { label: "Plain" } })
    ]);
    expect(entries).toEqual([
      { type: "rating", label: "Rating", icon: "★", group: "Survey" },
      { type: "gcds-notice", label: "Notice", group: "GC Design System" },
      { type: "plain", label: "Plain" }
    ]);
    // What a controller lists from them, unchanged.
    const ctrl = new BuilderController({ componentTypes: entries, componentDefinitions: [] });
    expect(ctrl.componentTypes().map((entry) => entry.type)).toEqual(["rating", "gcds-notice", "plain"]);
  });
});

describe("unknown component types in the inspector", () => {
  it("flags a node whose type the registry cannot resolve, and nothing else", () => {
    const ctrl = controller({
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "score", type: "rating", configuration: {} }, { id: "name", type: "text", configuration: {} }] }
    });
    ctrl.select("score");
    expect(ctrl.inspectorModel()?.unknownType).toBe(true);
    ctrl.select("name");
    expect(ctrl.inspectorModel()?.unknownType).toBeUndefined();
    ctrl.select(undefined);
    expect(ctrl.inspectorModel()?.unknownType).toBeUndefined();
  });
});

describe("BuilderController — a binding that asks for every error to be worded (unwordedErrors)", () => {
  const form = (): ComponentNode => ({
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Where do you live?", required: true, maxLength: 20 } },
        { id: "worded", type: "text", configuration: { label: "Town", required: true, messages: { required: "Enter your town" } } },
        { id: "code", type: "text", configuration: { label: "Code", pattern: "^[0-9]+$", patternMessage: "Enter numbers only" } },
        { id: "plain", type: "text", configuration: { label: "Nickname" } },
        { id: "box", type: "fieldset", configuration: { messages: { required: "Answer every question in the box" } }, children: { body: [{ id: "inner", type: "text", configuration: { label: "Inner", required: true } }] } }
      ]
    }
  });
  const noted: LiveBinding = { id: "noted", label: "Noted", components: {}, unwordedErrors: "noted" };

  it("notes, under the messages box, each field whose checks raise an error nothing words — only while such a binding is chosen", () => {
    const ctrl = controller(form());
    expect(ctrl.notesOf("name")).toEqual([]);
    ctrl.setOptions({ binding: noted });
    const [note] = ctrl.notesOf("name");
    expect(note?.target).toBe("messages");
    expect(note?.message).toContain("A required value is missing; Text is longer than the maximum");
    // A field whose every check is worded — by itself, a pattern's own message, or a container above it — has no note.
    expect(ctrl.notesOf("worded")).toEqual([]);
    expect(ctrl.notesOf("code")).toEqual([]);
    expect(ctrl.notesOf("inner")).toEqual([]);
    // Nor a field with no checks, nor the form itself.
    expect(ctrl.notesOf("plain")).toEqual([]);
    expect(ctrl.notesOf("root")).toEqual([]);
    // The draft is what the note is about: wording the required error leaves the length.
    ctrl.select("name");
    ctrl.setDraftProperty("name", "messages", { required: "Enter where you live" });
    expect(ctrl.notesOf("name")[0]?.message).toContain("no message of its own for: Text is longer than the maximum.");
    // Advisory: never a problem, the Save goes through.
    expect(ctrl.problemsOf("name")).toEqual([]);
    expect(ctrl.commitDraft("name")).toBe(true);
    // Another binding: silent again.
    ctrl.setOptions({ binding: undefined });
    expect(ctrl.notesOf("code")).toEqual([]);
  });
});

describe("BuilderController — undo and redo around a rename", () => {
  // A rename is a step of the history, with everything it rewrote: the steps before it are
  // undone after it, on the node under the id it had then, and redone before it.
  const ids = (ctrl: BuilderController): string[] => (ctrl.snapshot().children?.content ?? []).map((node) => node.id);

  it("takes back the rename, then an add made before it, and makes both again", () => {
    const ctrl = controller();
    ctrl.add("text");
    const added = ctrl.selectedComponentId()!;
    ctrl.setDraftId(added, "nickname");
    expect(ctrl.commitDraft(added)).toBe(true);
    expect(ids(ctrl)).toEqual(["nickname"]);
    expect(() => ctrl.undo()).not.toThrow();
    expect(ids(ctrl)).toEqual([added]);
    expect(() => ctrl.undo()).not.toThrow();
    expect(ctrl.dropError).toBeUndefined();
    expect(ids(ctrl)).toEqual([]);
    ctrl.redo();
    ctrl.redo();
    expect(ids(ctrl)).toEqual(["nickname"]);
  });

  it("takes back an edit saved with a rename in one Save as one step: the edit and the id go together", () => {
    const ctrl = controller({ id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } });
    ctrl.select("name");
    ctrl.setDraftProperty("name", "label", "Full name");
    ctrl.setDraftId("name", "fullname");
    expect(ctrl.commitDraft("name")).toBe(true);
    expect(ctrl.snapshot().children?.content).toEqual([{ id: "fullname", type: "text", configuration: { label: "Full name" } }]);
    ctrl.undo();
    expect(ctrl.dropError).toBeUndefined();
    expect(ctrl.snapshot().children?.content).toEqual([{ id: "name", type: "text", configuration: { label: "Name" } }]);
    expect(ctrl.canUndo()).toBe(false);
    ctrl.redo();
    expect(ctrl.snapshot().children?.content).toEqual([{ id: "fullname", type: "text", configuration: { label: "Full name" } }]);
  });

  it("follows a field into a group, and a group's children, step by step", () => {
    const ctrl = controller({ id: "root", type: "form", configuration: {}, children: { content: [] } });
    ctrl.insertComponents([{ node: { id: "box", type: "fieldset", configuration: {}, children: { body: [field("inner")] } } }]);
    ctrl.renameId("inner", "inside");
    ctrl.renameId("box", "group");
    ctrl.setProperty("inside", "label", "Inside");
    ctrl.undo();
    ctrl.undo();
    ctrl.undo();
    expect(ctrl.snapshot().children?.content?.[0]).toEqual({ id: "box", type: "fieldset", configuration: {}, children: { body: [field("inner")] } });
    ctrl.undo();
    expect(ids(ctrl)).toEqual([]);
    ctrl.redo();
    ctrl.redo();
    ctrl.redo();
    expect(ctrl.snapshot().children?.content?.[0]).toEqual({ id: "group", type: "fieldset", configuration: {}, children: { body: [field("inside")] } });
    expect(ctrl.dropError).toBeUndefined();
  });

  it("gives a freed id to another node and takes it back in order, so two nodes never share one", () => {
    const ctrl = controller({ id: "root", type: "form", configuration: {}, children: { content: [field("email")] } });
    ctrl.add("text");
    const added = ctrl.selectedComponentId()!;
    ctrl.remove("email");
    // The id is free now: the new field takes it.
    ctrl.renameId(added, "email");
    expect(ctrl.idError).toBeUndefined();
    ctrl.undo();
    expect(ids(ctrl)).toEqual([added]);
    ctrl.undo();
    expect(ids(ctrl)).toEqual(["email", added]);
    ctrl.redo();
    ctrl.redo();
    expect(ids(ctrl)).toEqual(["email"]);
    expect(ctrl.dropError).toBeUndefined();
  });

  it("never throws at the bar's Undo: a step the tree no longer matches is said on the canvas, and the steps before it go", () => {
    const ctrl = controller();
    ctrl.add("text");
    const first = ctrl.selectedComponentId()!;
    ctrl.add("text");
    const second = ctrl.selectedComponentId()!;
    // Taken out behind the history's back: its add cannot be taken back.
    (ctrl as unknown as { editor: { componentTree(): { remove(id: string): void } } }).editor.componentTree().remove(second);
    const changes: string[] = [];
    ctrl.on("change", (event) => changes.push(event.reason));
    expect(() => ctrl.undo()).not.toThrow();
    expect(ctrl.dropError).toBe(`This step could not be undone (Component not found: ${second}), nor can the ones before it.`);
    expect(changes).toEqual(["edit"]);
    expect(ids(ctrl)).toEqual([first]);
    expect(ctrl.canUndo()).toBe(false);
    ctrl.add("number");
    expect(ctrl.dropError).toBeUndefined();
  });

  const labelled = (id: string, label: string): ComponentNode => ({ id, type: "text", configuration: { label } });
  const form = (...content: ComponentNode[]): ComponentNode => ({ id: "root", type: "form", configuration: {}, children: { content } });
  const content = (ctrl: BuilderController): unknown => ctrl.snapshot().children?.content;

  it("puts a rebuilt form's field back under its own id once the rename of the new one is undone", () => {
    const ctrl = controller(form(labelled("email", "Old")));
    ctrl.replaceContent([labelled("email", "New, from a JSON sample")]);
    ctrl.renameId("email", "contact");
    ctrl.undo();
    expect(content(ctrl)).toEqual([labelled("email", "New, from a JSON sample")]);
    ctrl.undo();
    expect(content(ctrl)).toEqual([labelled("email", "Old")]);
    expect(ctrl.dropError).toBeUndefined();
    ctrl.redo();
    ctrl.redo();
    expect(content(ctrl)).toEqual([labelled("contact", "New, from a JSON sample")]);
  });

  it("drops the draft of a replaced field even when the new content reuses its id", () => {
    const ctrl = controller(form({ id: "email", type: "text", configuration: { label: "Old email", placeholder: "old@x" } }, labelled("name", "Name")));
    ctrl.select("email");
    // Typed and typed back: a draft with nothing pending, which the replace's guard lets through.
    ctrl.setDraftProperty("email", "label", "Changed");
    ctrl.setDraftProperty("email", "label", "Old email");
    // A draft left open on a field that is not selected any more.
    ctrl.setDraftProperty("name", "label", "Pending");
    ctrl.select("email");
    expect(ctrl.hasPendingChanges("email")).toBe(false);
    expect(ctrl.requestReplaceContent([{ id: "email", type: "number", configuration: { label: "Email from model" } }, labelled("name", "Name from model")])).toBe(true);

    const fresh = [{ id: "email", type: "number", configuration: { label: "Email from model" } }, labelled("name", "Name from model")];
    expect(content(ctrl)).toEqual(fresh);
    expect(ctrl.hasPendingChanges("email")).toBe(false);
    expect(ctrl.hasPendingChanges("name")).toBe(false);
    expect(ctrl.editedNode("email")?.configuration).toEqual({ label: "Email from model" });
    ctrl.commitDraft("email");
    ctrl.commitDraft("name");
    expect(content(ctrl)).toEqual(fresh);
  });

  it("renames the one of two nodes sharing a hand-written id it finds first, and undoes it on that one", () => {
    const ctrl = controller(form(labelled("dup", "A"), labelled("name", "Name"), labelled("dup", "B")));
    ctrl.remove("dup");
    ctrl.renameId("dup", "solo");
    ctrl.undo();
    expect(content(ctrl)).toEqual([labelled("name", "Name"), labelled("dup", "B")]);
    ctrl.undo();
    expect(content(ctrl)).toEqual([labelled("dup", "A"), labelled("name", "Name"), labelled("dup", "B")]);
    ctrl.redo();
    ctrl.redo();
    expect(content(ctrl)).toEqual([labelled("name", "Name"), labelled("solo", "B")]);
  });

  it("ends what can be redone, as any new step does", () => {
    const rebuilt = controller(form(field("a")));
    rebuilt.setProperty("a", "hint", "H");
    rebuilt.undo();
    rebuilt.renameId("a", "b");
    expect(rebuilt.canRedo()).toBe(false);
    expect(content(rebuilt)).toEqual([field("b")]);
  });

  it("drops the drafts of what Undo or Redo took away: a Redo brings the node back without them", () => {
    const ctrl = controller(form({ id: "name", type: "number", configuration: { label: "Name", min: 3 } }));
    ctrl.add("text");
    const added = ctrl.selectedComponentId()!;
    ctrl.setDraftProperty(added, "label", "Typed, never saved");
    ctrl.undo();
    ctrl.redo();
    expect(ctrl.hasPendingChanges(added)).toBe(false);
    expect(ctrl.hasPendingChanges()).toBe(false);
    // Nor does a field renamed to the freed id take the unsaved edits of the one undone.
    ctrl.undo();
    ctrl.renameId("name", added);
    expect(ctrl.hasPendingChanges(added)).toBe(false);
    expect(ctrl.commitDraft(added)).toBe(true);
    expect(content(ctrl)).toEqual([{ id: added, type: "number", configuration: { label: "Name", min: 3 } }]);
  });

  it("never hands a node renamed to an id the draft left under that id", () => {
    const ctrl = controller(form({ id: "name", type: "number", configuration: { label: "Name", min: 3 } }));
    ctrl.add("text");
    const added = ctrl.selectedComponentId()!;
    ctrl.setDraftProperty(added, "label", "Typed, never saved");
    // Taken out behind the controller's back: its draft is left under the freed id.
    (ctrl as unknown as { editor: { componentTree(): { remove(id: string): void } } }).editor.componentTree().remove(added);
    ctrl.renameId("name", added);
    expect(ctrl.hasPendingChanges(added)).toBe(false);
    expect(content(ctrl)).toEqual([{ id: added, type: "number", configuration: { label: "Name", min: 3 } }]);
  });

  it("follows a node through a children map written whole (a journey's follow-up), then renamed", () => {
    const ctrl = controller(form({ id: "box", type: "fieldset", configuration: {}, children: { body: [field("a")] } }, field("b")));
    const copy = structuredClone(ctrl.snapshot().children!);
    ctrl.setProperties([{ componentId: "root", propertyPath: "", value: { content: [copy.content![1]!, copy.content![0]!] }, target: "children" }]);
    ctrl.renameId("a", "x");
    ctrl.renameId("b", "y");
    expect(content(ctrl)).toEqual([field("y"), { id: "box", type: "fieldset", configuration: {}, children: { body: [field("x")] } }]);
    ctrl.undo();
    ctrl.undo();
    ctrl.undo();
    expect(content(ctrl)).toEqual([{ id: "box", type: "fieldset", configuration: {}, children: { body: [field("a")] } }, field("b")]);
    ctrl.redo();
    ctrl.redo();
    ctrl.redo();
    expect(content(ctrl)).toEqual([field("y"), { id: "box", type: "fieldset", configuration: {}, children: { body: [field("x")] } }]);
    expect(ctrl.dropError).toBeUndefined();
  });
  it("never throws at Undo or Redo for a listener that throws: the step is taken, the others hear it, the error is reported", () => {
    const ctrl = controller(form(field("a")));
    ctrl.setProperty("a", "hint", "H");
    const heard: string[] = [];
    ctrl.on("change", () => {
      throw new Error("change listener");
    });
    ctrl.on("mutation", () => {
      throw new Error("mutation listener");
    });
    ctrl.on("change", (event) => heard.push(event.reason));
    const reported: unknown[] = [];
    const host = globalThis as { reportError?: ((error: unknown) => void) | undefined };
    const before = host.reportError;
    host.reportError = (error) => reported.push((error as Error).message);
    try {
      expect(() => ctrl.undo()).not.toThrow();
      expect(content(ctrl)).toEqual([field("a")]);
      expect(ctrl.dropError).toBeUndefined();
      expect(() => ctrl.redo()).not.toThrow();
      expect(content(ctrl)).toEqual([{ id: "a", type: "text", configuration: { hint: "H" } }]);
    } finally {
      host.reportError = before;
    }
    expect(heard).toEqual(["edit", "edit"]);
    expect(reported).toEqual(["mutation listener", "change listener", "mutation listener", "change listener"]);
    expect(ctrl.canUndo()).toBe(true);
  });
});

describe("BuilderController — ids claimed beside the tree", () => {
  function claimedController(): BuilderController {
    const ctrl = controller({ id: "root", type: "form", configuration: {}, children: { content: [field("name")] } });
    ctrl.setOptions({ claimedIds: () => ["m1", "work_email"] }, { silent: true });
    return ctrl;
  }

  it("hands out the claimed ids for a planner to avoid", () => {
    expect(claimedController().claimedIds()).toEqual(["m1", "work_email"]);
    expect(controller().claimedIds()).toEqual([]);
  });

  it("refuses to insert a component, or one inside a subtree, under a claimed id — and places nothing", () => {
    const ctrl = claimedController();
    const result = ctrl.insertComponents([{ node: field("phone") }, { node: field("m1") }]);
    expect(result).toEqual({ ok: false, ids: [], error: 'ID "m1" is already used by a page-only field of a journey.' });
    expect(ctrl.dropError).toBe(result.error);
    expect(ctrl.insertComponents([{ node: { id: "box", type: "fieldset", configuration: {}, children: { body: [field("work_email")] } } }]).ok).toBe(false);
    expect(ctrl.snapshot().children?.content?.map((node) => node.id)).toEqual(["name"]);
    expect(ctrl.insertComponents([{ node: field("phone") }]).ok).toBe(true);
  });

  it("refuses to replace the form's contents with a claimed id, even one it replaces", () => {
    const ctrl = claimedController();
    expect(ctrl.replaceContent([field("title"), field("work_email")])).toMatchObject({ ok: false, error: 'ID "work_email" is already used by a page-only field of a journey.' });
    expect(ctrl.snapshot().children?.content?.map((node) => node.id)).toEqual(["name"]);
    expect(ctrl.replaceContent([field("title"), field("name")]).ok).toBe(true);
  });
});

describe("a rename followed into the tree's rules", () => {
  const rules = (ctrl: BuilderController, id: string): unknown => ctrl.snapshot().children?.content?.find((node) => node.id === id)?.rules;
  const ruledForm = (...content: ComponentNode[]): ComponentNode => ({ id: "root", type: "form", configuration: {}, children: { content } });

  it("rewrites every rule of every component that reads the old id, in every shape and under every key, and nothing else", () => {
    const tree: ComponentNode = { kind: "binary", operator: "gt", left: { kind: "path", path: "amount" }, right: { kind: "literal", value: 2 } } as unknown as ComponentNode;
    const ctrl = controller(
      ruledForm(
        { id: "amount", type: "number", configuration: {}, rules: { requiredWhen: "amount > 0 or other = 1" } },
        {
          id: "b",
          type: "text",
          configuration: {},
          rules: {
            visibleWhen: "amount  = 1",
            requiredWhen: { formula: "amount > 2", run: "server" },
            enabledWhen: tree as never,
            readonlyWhen: "`amount` = 3",
            value: "amount.city",
            defaultValue: "row.amount + ancestor.amount",
            filter: "amounts = 1 and other = 'amount'",
            navigationGating: "other > 1"
          }
        },
        { id: "c", type: "text", configuration: {}, rules: { visibleWhen: "other = 1" } }
      )
    );
    const before = rules(ctrl, "c");
    const beforeB = rules(ctrl, "b") as Record<string, unknown>;
    const events: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => events.push(event));
    ctrl.renameId("amount", "total");
    expect(ctrl.idError).toBeUndefined();
    expect(rules(ctrl, "total")).toEqual({ requiredWhen: "total > 0 or other = 1" });
    expect(rules(ctrl, "b")).toEqual({
      visibleWhen: "total  = 1",
      requiredWhen: { formula: "total > 2", run: "server" },
      enabledWhen: { kind: "binary", operator: "gt", left: { kind: "path", path: "total" }, right: { kind: "literal", value: 2 } },
      readonlyWhen: "total = 3",
      value: "total.city",
      // A row read names a key within a grid's row, never an id: `amount` sits in no row, so no
      // key moved and `row.amount` stays (the rules inside a row follow its keys, not its ids).
      defaultValue: "row.amount + ancestor.total",
      filter: "amounts = 1 and other = 'amount'",
      navigationGating: "other > 1"
    });
    // The rules that named no such path are the very same strings.
    expect((rules(ctrl, "b") as Record<string, unknown>).filter).toBe(beforeB.filter);
    expect(rules(ctrl, "c")).toEqual(before);
    expect(events.at(-1)?.renamed).toEqual({ from: "amount", to: "total", rules: ["total", "b"] });
    expect(ctrl.renameNotes()).toEqual([]);
  });

  it("writes the follow-up into the rename's own step of the history: an Undo puts the id and every rule back together", () => {
    const ctrl = controller(
      ruledForm(
        { id: "amount", type: "number", configuration: {} },
        { id: "b", type: "text", configuration: {}, rules: { visibleWhen: "amount = 1" } },
        { id: "c", type: "text", configuration: {}, rules: { requiredWhen: "amount = 2" } }
      )
    );
    ctrl.setProperty("b", "label", "B");
    ctrl.renameId("amount", "total");
    expect(rules(ctrl, "b")).toEqual({ visibleWhen: "total = 1" });
    expect(rules(ctrl, "c")).toEqual({ requiredWhen: "total = 2" });
    ctrl.undo();
    expect(rules(ctrl, "b")).toEqual({ visibleWhen: "amount = 1" });
    expect(rules(ctrl, "c")).toEqual({ requiredWhen: "amount = 2" });
    expect(ctrl.snapshot().children?.content?.[0]?.id).toBe("amount");
    expect(ctrl.snapshot().children?.content?.[1]?.configuration).toEqual({ label: "B" });
    ctrl.undo();
    expect(ctrl.snapshot().children?.content?.[1]?.configuration).toEqual({});
    expect(ctrl.canUndo()).toBe(false);
    ctrl.redo();
    ctrl.redo();
    expect(ctrl.snapshot().children?.content?.[0]?.id).toBe("total");
    expect(rules(ctrl, "c")).toEqual({ requiredWhen: "total = 2" });
    expect(ctrl.dropError).toBeUndefined();
    // A rename that no rule reads is a step of its own all the same.
    ctrl.renameId("c", "d");
    expect(rules(ctrl, "d")).toEqual({ requiredWhen: "total = 2" });
    ctrl.undo();
    expect(rules(ctrl, "c")).toEqual({ requiredWhen: "total = 2" });
  });

  it("leaves the rules to the tree's owner when renameFollowsRules is false", () => {
    const ctrl = controller(ruledForm({ id: "amount", type: "number", configuration: {} }, { id: "b", type: "text", configuration: {}, rules: { visibleWhen: "amount = " } }));
    ctrl.setOptions({ renameFollowsRules: false }, { silent: true });
    const events: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => events.push(event));
    ctrl.renameId("amount", "total");
    expect(rules(ctrl, "b")).toEqual({ visibleWhen: "amount = " });
    expect(events.at(-1)?.renamed).toEqual({ from: "amount", to: "total" });
    expect(ctrl.renameNotes()).toEqual([]);
    // The rename is one step, the rules left out of it.
    ctrl.undo();
    expect(ctrl.snapshot().children?.content?.[0]?.id).toBe("amount");
    expect(rules(ctrl, "b")).toEqual({ visibleWhen: "amount = " });
    expect(ctrl.canUndo()).toBe(false);
  });

  it("leaves a formula that does not parse as written and reports it on the event and in renameNotes", () => {
    const ctrl = controller(
      ruledForm(
        { id: "amount", type: "number", configuration: {} },
        { id: "b", type: "text", configuration: {}, rules: { visibleWhen: "amount = ", requiredWhen: { formula: "amount > ", run: "server" }, value: "amount + 1" } }
      )
    );
    const events: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => events.push(event));
    ctrl.renameId("amount", "total");
    expect(rules(ctrl, "b")).toEqual({ visibleWhen: "amount = ", requiredWhen: { formula: "amount > ", run: "server" }, value: "total + 1" });
    const unparsed = [
      { componentId: "b", rule: "visibleWhen", from: "amount", to: "total", formula: "amount = " },
      { componentId: "b", rule: "requiredWhen", from: "amount", to: "total", formula: "amount > " }
    ];
    expect(events.at(-1)?.renamed).toEqual({ from: "amount", to: "total", rules: ["b"], unparsed });
    expect(ctrl.renameNotes()).toEqual(unparsed);
    // The next rename replaces the notes.
    ctrl.renameId("b", "c");
    expect(ctrl.renameNotes()).toEqual([]);
    expect(events.at(-1)?.renamed).toEqual({ from: "b", to: "c" });
  });

  it("follows the rename into an open draft's rules, and a Save of a drafted id rewrites the rest of the form", () => {
    const ctrl = controller(
      ruledForm(
        { id: "amount", type: "number", configuration: {}, rules: { requiredWhen: "amount > 0" } },
        { id: "b", type: "text", configuration: {}, rules: { visibleWhen: "amount = 1" } }
      )
    );
    ctrl.select("b");
    ctrl.setDraftRules("b", { visibleWhen: "amount = 1", enabledWhen: "amount = 2" });
    ctrl.select("amount");
    ctrl.setDraftId("amount", "total");
    expect(ctrl.commitDraft("amount")).toBe(true);
    expect(rules(ctrl, "total")).toEqual({ requiredWhen: "total > 0" });
    expect(rules(ctrl, "b")).toEqual({ visibleWhen: "total = 1" });
    expect(ctrl.draftRules("b")).toEqual({ visibleWhen: "total = 1", enabledWhen: "total = 2" });
    expect(ctrl.hasPendingChanges("b")).toBe(true);
  });

  it("holds a drafted rule property that does not parse at Save when the tree registers it as a rule target", () => {
    const ctrl = controller(ruledForm({ id: "b", type: "text", configuration: { when: "a = 1" } }));
    ctrl.setOptions({ ruleTargets: ["when"] });
    ctrl.setDraftProperty("b", "when", "a = ");
    expect(ctrl.problemsOf("b").map((problem) => problem.target)).toEqual(["rules:when"]);
    expect(ctrl.commitDraft("b")).toBe(false);
    expect(ctrl.getProperty("b", "when")).toBe("a = 1");
    ctrl.setDraftProperty("b", "when", "a = 2");
    expect(ctrl.problemsOf("b")).toEqual([]);
    expect(ctrl.commitDraft("b")).toBe(true);
    expect(ctrl.getProperty("b", "when")).toBe("a = 2");
    // Without the registration the controller leaves the property alone.
    const plain = controller(ruledForm({ id: "b", type: "text", configuration: { when: "a = 1" } }));
    plain.setDraftProperty("b", "when", "a = ");
    expect(plain.problemsOf("b")).toEqual([]);
  });
});

describe("copies, drafts, constraints, drops", () => {
  const text = (id: string): ComponentNode => ({ id, type: "text", configuration: { label: id } });
  const group = (id: string, type: string, kids: ComponentNode[], slot = "content"): ComponentNode => ({ id, type, configuration: {}, children: { [slot]: kids } });

  function make(content: ComponentNode[], extra: Partial<ConstructorParameters<typeof BuilderController>[0]> = {}): BuilderController {
    return new BuilderController({
      componentTypes: [
        { type: "text", label: "Text" },
        { type: "container", label: "Box" },
        { type: "steps", label: "Steps" }
      ],
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content } },
      componentDefinitions: [
        def("form", { children: { slots: [{ id: "content", multiple: true }] } }),
        def("container", { children: { slots: [{ id: "content", multiple: true }] } }),
        def("repeatingSection", { children: { slots: [{ id: "content", multiple: true }] } }),
        def("text")
      ],
      ...extra
    });
  }
  const node = (c: BuilderController, id: string): ComponentNode => {
    const all: ComponentNode[] = [];
    const walk = (n: ComponentNode): void => {
      all.push(n);
      Object.values(n.children ?? {}).flat().forEach(walk);
    };
    walk(c.snapshot());
    return all.find((n) => n.id === id) as ComponentNode;
  };
  const ids = (c: BuilderController): string[] => {
    const out: string[] = [];
    const walk = (n: ComponentNode): void => {
      out.push(n.id);
      Object.values(n.children ?? {}).flat().forEach(walk);
    };
    walk(c.snapshot());
    return out;
  };
  const state = (c: BuilderController): string => JSON.stringify({ tree: c.snapshot(), undo: c.canUndo(), redo: c.canRedo() });
  const drop = (c: BuilderController, payload: unknown, parentId = "root", slotId = "content", index = 0): void => {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    c.applyDrop({ setData: () => undefined, getData: (t) => (t === BUILDER_DRAG_MIME_TYPE ? raw : "") }, parentId, slotId, index);
  };

  it("setRules and setProperty keep copies; a caller mutating its objects afterwards does not reach redo", () => {
    const c = make([text("a")]);
    const rules: Record<string, unknown> = { requiredWhen: "x = 1" };
    c.setRules("a", rules as ComponentRules);
    const value = { list: [1] };
    c.setProperty("a", "extra", value);
    const applied = JSON.stringify(node(c, "a"));
    rules.requiredWhen = "MUTATED";
    value.list.push(9);
    c.undo();
    c.undo();
    c.redo();
    c.redo();
    expect(JSON.stringify(node(c, "a"))).toBe(applied);
  });

  it("setDraftProperty stores a copy, so a later mutation does not change what Save commits", () => {
    const c = make([text("a")]);
    const value = { list: [1] };
    c.select("a");
    c.setDraftProperty("a", "extra", value);
    value.list.push(5);
    c.commitDraft("a");
    expect((node(c, "a").configuration as { extra: unknown }).extra).toEqual({ list: [1] });
  });

  it("setRules keeps an open draft in step, so Save does not revert the direct write", () => {
    const c = make([text("a")]);
    c.select("a");
    c.setDraftProperty("a", "label", "Changed");
    c.setRules("a", { visibleWhen: "x = 1" } as ComponentRules);
    expect(c.commitDraft("a")).toBe(true);
    expect(node(c, "a").rules).toEqual({ visibleWhen: "x = 1" });
    expect((node(c, "a").configuration as { label: string }).label).toBe("Changed");
    c.setRules("a", undefined);
    expect(node(c, "a").rules).toBeUndefined();
  });

  it("renaming a row field follows the repeating section's collection.itemFields", () => {
    const section: ComponentNode = {
      id: "rows",
      type: "repeatingSection",
      configuration: {},
      collection: { collectionPath: "rows", itemFields: ["rowText", "other"] },
      children: { content: [text("rowText"), text("other")] }
    };
    const c = make([section]);
    c.renameId("rowText", "rowName");
    expect(node(c, "rows").collection?.itemFields).toEqual(["rowName", "other"]);
  });

  it("a leaf component takes no children by move, add or drop", () => {
    const c = make([text("a"), group("bx", "container", [text("inner")])]);
    const before = state(c);
    expect(c.move("bx", { parentId: "a", slotId: "content", index: 0 })).toBe(false);
    c.add("text", "a", "content");
    drop(c, { kind: "existing-component", componentId: "bx" }, "a", "content", 0);
    expect(state(c)).toBe(before);
    expect(node(c, "a").children).toBeUndefined();
  });

  it("containers keep taking children, in slots they declare and in ones they leave open", () => {
    const c = make([text("a"), group("bx", "container", [])]);
    expect(c.move("a", { parentId: "bx", slotId: "content", index: 0 })).toBe(true);
    expect(c.insertComponents([{ node: text("b"), parentId: "bx", slotId: "elsewhere" }]).ok).toBe(true);
  });

  it("a form node is never placed under the root", () => {
    const c = make([text("a")]);
    const result = c.insertComponents([{ node: { id: "form2", type: "form", configuration: {}, children: { content: [] } } }]);
    expect(result.ok).toBe(false);
    expect(ids(c)).toEqual(["root", "a"]);
  });

  it("a forged template drop with an unregistered type, a form type or no type creates nothing", () => {
    const c = make([text("a")]);
    const before = state(c);
    drop(c, { kind: "template-component", component: { id: "x", type: "totally-not-registered", configuration: {} } });
    drop(c, { kind: "template-component", component: { id: "x", type: "form", configuration: {} } });
    drop(c, { kind: "template-component", component: { id: "x", type: "steps", configuration: {} } });
    expect(state(c)).toBe(before);
  });

  it("a forged template carrying children takes the type's own, with ids unique in the form", () => {
    const c = make([text("a"), text("b")]);
    drop(c, {
      kind: "template-component",
      component: { id: "x", type: "container", configuration: { label: "Mine" }, children: { content: [{ id: "a", type: "text", configuration: {} }, { id: "b", type: "text", configuration: {} }] } }
    });
    const all = ids(c);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain("a");
    expect(all).toContain("b");
    const added = c.snapshot().children!.content![0]!;
    expect(added.type).toBe("container");
    expect(added.id).toMatch(/^container_\d+$/);
    expect(added.configuration).toEqual({ label: "Mine" });
    expect(added.children).toBeUndefined();
  });

  it("a palette drag payload still drops the new component", () => {
    const c = make([text("a")]);
    drop(c, c.dragPayloadForType("text"));
    expect(c.snapshot().children!.content!.map((n) => n.type)).toEqual(["text", "text"]);
  });

  it("a template payload with a null component or no type is ignored without throwing", () => {
    const c = make([text("a")]);
    const before = state(c);
    expect(() => drop(c, { kind: "template-component", component: null })).not.toThrow();
    expect(() => drop(c, { kind: "template-component", component: { configuration: {} } })).not.toThrow();
    expect(() => drop(c, "null")).not.toThrow();
    expect(state(c)).toBe(before);
  });
});

describe("undo and redo discard the drafts of the components they change", () => {
  function twoFields() {
    const ctrl = controller({ id: "root", type: "form", configuration: {}, children: { content: [field("a"), field("b")] } });
    ctrl.setProperty("a", "label", "One");
    return ctrl;
  }

  it("does not let a later Save write the draft's stale copy over what undo restored", () => {
    const ctrl = twoFields();
    ctrl.select("a");
    ctrl.setDraftProperty("a", "label", "Two");
    expect(ctrl.hasPendingChanges("a")).toBe(true);
    ctrl.undo();
    expect(ctrl.hasPendingChanges("a")).toBe(false);
    ctrl.commitDraft("a");
    expect(ctrl.getProperty("a", "label")).toBeUndefined();
  });

  it("does the same for redo", () => {
    const ctrl = twoFields();
    ctrl.undo();
    ctrl.select("a");
    ctrl.setDraftProperty("a", "label", "Three");
    ctrl.redo();
    expect(ctrl.hasPendingChanges("a")).toBe(false);
    expect(ctrl.getProperty("a", "label")).toBe("One");
  });

  it("keeps the draft of a component the step leaves alone", () => {
    const ctrl = twoFields();
    ctrl.select("b");
    ctrl.setDraftProperty("b", "label", "Mine");
    ctrl.undo();
    expect(ctrl.hasPendingChanges("b")).toBe(true);
    expect(ctrl.commitDraft("b")).toBe(true);
    expect(ctrl.getProperty("b", "label")).toBe("Mine");
  });
});

describe("undo and redo of a property-only step re-set its paths into an open draft", () => {
  const OPTIONS = [{ value: "x", label: "X" }];

  /** Field `a` (label "One"), a label typed but not applied, then a dialog's Apply committed as one step under it. */
  function dialogUnderDraft() {
    const ctrl = controller({ id: "root", type: "form", configuration: {}, children: { content: [field("a"), field("b")] } });
    ctrl.setProperty("a", "label", "One");
    ctrl.select("a");
    ctrl.setDraftProperty("a", "label", "Typed");
    ctrl.setDraftProperty("a", "messages.pattern", "Use letters");
    ctrl.setProperties([
      { componentId: "a", propertyPath: "options", value: OPTIONS },
      { componentId: "a", propertyPath: "messages.required", value: "Answer this" }
    ]);
    return ctrl;
  }

  it("keeps the pending edits and puts the restored values in both the tree and the draft on Undo", () => {
    const ctrl = dialogUnderDraft();
    ctrl.undo();
    // The tree is as before the dialog's Apply.
    expect(ctrl.getProperty("a", "options")).toBeUndefined();
    expect(ctrl.getProperty("a", "messages")).toBeUndefined();
    expect(ctrl.getProperty("a", "label")).toBe("One");
    // The draft holds the same restored values, and still what was typed elsewhere.
    expect(ctrl.hasPendingChanges("a")).toBe(true);
    expect(ctrl.draftProperty("a", "options")).toBeUndefined();
    expect(ctrl.draftProperty("a", "messages")).toEqual({ pattern: "Use letters" });
    expect(ctrl.draftProperty("a", "label")).toBe("Typed");
    expect(ctrl.commitDraft("a")).toBe(true);
    expect(ctrl.snapshot().children?.content?.[0]?.configuration).toEqual({ label: "Typed", messages: { pattern: "Use letters" } });
  });

  it("does the same on Redo", () => {
    const ctrl = dialogUnderDraft();
    ctrl.undo();
    ctrl.redo();
    expect(ctrl.getProperty("a", "options")).toEqual(OPTIONS);
    expect(ctrl.getProperty("a", "label")).toBe("One");
    expect(ctrl.draftProperty("a", "options")).toEqual(OPTIONS);
    expect(ctrl.draftProperty("a", "messages")).toEqual({ pattern: "Use letters", required: "Answer this" });
    expect(ctrl.draftProperty("a", "label")).toBe("Typed");
    expect(ctrl.commitDraft("a")).toBe(true);
    expect(ctrl.snapshot().children?.content?.[0]?.configuration).toEqual({
      label: "Typed",
      options: OPTIONS,
      messages: { pattern: "Use letters", required: "Answer this" }
    });
  });

  it("re-sets a rule the step touched and keeps the rule the draft changed", () => {
    const ctrl = controller({ id: "root", type: "form", configuration: {}, children: { content: [field("a"), field("b")] } });
    ctrl.select("a");
    ctrl.setDraftRules("a", { requiredWhen: { kind: "path", path: "b" } } as ComponentRules);
    ctrl.setProperties([{ componentId: "a", propertyPath: "visibleWhen", value: { kind: "path", path: "b" }, target: "rules" }]);
    ctrl.undo();
    expect(ctrl.snapshot().children?.content?.[0]?.rules).toBeUndefined();
    expect(ctrl.draftRules("a")).toEqual({ requiredWhen: { kind: "path", path: "b" } });
    ctrl.redo();
    expect(ctrl.draftRules("a")).toEqual({ requiredWhen: { kind: "path", path: "b" }, visibleWhen: { kind: "path", path: "b" } });
  });

  it("still discards the draft when the step changed the tree's structure", () => {
    const ctrl = controller(gridForm(2, { column_1: [field("a")], column_2: [field("b")] }));
    // Two columns to one folds the children: the step moves components as well as setting a value.
    ctrl.setProperty("g", "columns", 1);
    ctrl.select("g");
    ctrl.setDraftProperty("g", "label", "Grid");
    ctrl.undo();
    expect(gridChildren(ctrl)).toEqual({ column_1: ["a"], column_2: ["b"] });
    expect(ctrl.hasPendingChanges("g")).toBe(false);
    expect(ctrl.draftProperty("g", "label")).toBeUndefined();
  });

  it("still discards the draft of a component the step takes away", () => {
    const ctrl = controller();
    ctrl.add("text");
    const id = ctrl.selectedComponentId()!;
    ctrl.setDraftProperty(id, "label", "New");
    ctrl.undo();
    expect(ctrl.hasPendingChanges()).toBe(false);
    ctrl.redo();
    expect(ctrl.hasPendingChanges(id)).toBe(false);
  });
});

describe("an add with no position keeps a seeded Submit last (new-user defect 1)", () => {
  const SUBMIT: ComponentNode = { id: "submit", type: "button", configuration: { label: "Submit", action: "submit" } };
  const content = (ctrl: BuilderController): string[] => (ctrl.snapshot().children?.content ?? []).map((node) => node.id);
  const fresh = (submit: ComponentNode = SUBMIT, before: ComponentNode[] = []) =>
    controller({ id: "root", type: "form", configuration: {}, children: { content: [...before, structuredClone(submit)] } });

  it("puts each new field before the Submit File > New seeded, one undo step each", () => {
    const ctrl = fresh();
    ctrl.add("text");
    const first = ctrl.selectedComponentId()!;
    expect(ctrl.requestAdd("number")).toBe(true);
    const second = ctrl.selectedComponentId()!;
    ctrl.addAfter("text");
    const third = ctrl.selectedComponentId()!;
    expect(content(ctrl)).toEqual([first, second, third, "submit"]);
    ctrl.undo();
    expect(content(ctrl)).toEqual([first, second, "submit"]);
  });

  it("adds at the end as before when the Submit was changed, moved off the end, or a position is named", () => {
    const edited = fresh({ ...SUBMIT, configuration: { label: "Send", action: "submit" } });
    edited.add("text");
    expect(content(edited)).toEqual(["submit", edited.selectedComponentId()]);

    const ruled = fresh({ ...SUBMIT, rules: { visibleWhen: { kind: "path", path: "a" } } as ComponentRules });
    ruled.add("text");
    expect(content(ruled)).toEqual(["submit", ruled.selectedComponentId()]);

    const moved = fresh(SUBMIT, []);
    moved.add("text");
    const a = moved.selectedComponentId()!;
    expect(moved.move("submit", { parentId: "root", slotId: "content", index: 0 })).toBe(true);
    moved.add("text");
    expect(content(moved)).toEqual(["submit", a, moved.selectedComponentId()]);

    const named = fresh();
    named.addAfter("text", "submit");
    expect(content(named)).toEqual(["submit", named.selectedComponentId()]);
  });

  // The canvas draws its "Drop components here" prompt under the starting Submit, so a drop on
  // the prompt names the place after the button.
  const dropped = (ctrl: BuilderController, index: number): string => {
    const store = new Map([["application/x-datum-builder-drag", JSON.stringify(ctrl.dragPayloadForType("text"))]]);
    ctrl.applyDrop({ setData: (k: string, v: string) => store.set(k, v), getData: (k: string) => store.get(k) ?? "" }, "root", "content", index);
    return ctrl.selectedComponentId()!;
  };

  it("puts the first component dropped under the starting Submit before it", () => {
    const ctrl = fresh();
    const first = dropped(ctrl, 1);
    expect(content(ctrl)).toEqual([first, "submit"]);
    // From then on a drop lands where it was dropped, after the Submit included.
    const second = dropped(ctrl, 2);
    expect(content(ctrl)).toEqual([first, "submit", second]);
  });

  it("leaves a drop under a Submit the author changed where it was dropped", () => {
    const edited = fresh({ ...SUBMIT, configuration: { label: "Send", action: "submit" } });
    const first = dropped(edited, 1);
    expect(content(edited)).toEqual(["submit", first]);
  });
});

describe("messages and untitled tabs", () => {
  it("lists the validation messages a component words, by their code", () => {
    const ctrl = languagesController();
    const messages = ctrl.translatableTexts().filter((text) => text.propertyPath.startsWith("messages."));
    expect(messages.map((text) => [text.componentId, text.propertyPath, text.default, text.address])).toEqual([
      ["root", "messages.required", "Answer this", addressOf.formMessage("required")],
      ["root", "messages.journey.exit", "You cannot send this form.", addressOf.formMessage("journey.exit")],
      ["name", "messages.required", "Enter your name", addressOf.message("name", "required")]
    ]);
  });

  it("notes a tab with no label as a warning that never holds a Save back", () => {
    const tabs: ComponentNode = {
      id: "tabs_1",
      type: "tabs",
      configuration: { tabs: [{ id: "a", label: "Details" }, { id: "b" }] },
      children: { a: [], b: [] }
    };
    const ctrl = controller({ id: "root", type: "form", configuration: {}, children: { content: [tabs] } });
    const notes = ctrl.notesOf("tabs_1");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ severity: "warning" });
    expect(notes[0]?.message).toContain("Tab 2");
    expect(ctrl.problemsOf("tabs_1")).toEqual([]);
    ctrl.setProperty("tabs_1", "tabs", [{ id: "a", label: "Details" }, { id: "b", label: "More" }]);
    expect(ctrl.notesOf("tabs_1")).toEqual([]);
  });

  it("resolves the frame labels through the catalog it was lent", () => {
    const ctrl = controller();
    expect(ctrl.translationCatalog()).toBeUndefined();
    ctrl.setTranslationCatalog(() => ({ en: { form: { title: "x" } } }));
    expect(ctrl.translationCatalog()).toEqual({ en: { form: { title: "x" } } });
    expect(ctrl.frameChoices().length).toBeGreaterThan(0);
  });
});

describe("a data grid entering the controller", () => {
  const unbound = (): ComponentNode => ({
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [{ id: "lines", type: "dataGrid", configuration: { label: "Lines" }, children: { content: [field("sku_cell")] } }, field("name")]
    }
  });

  it("binds an unbound grid at its id, whether the tree comes with the constructor or a later setOptions", () => {
    const ctrl = controller(unbound());
    const lines = ctrl.snapshot().children!.content![0]!;
    expect(lines.collection).toEqual({ collectionPath: "lines" });
    expect(lines.configuration).toEqual({ label: "Lines" });

    const later = controller();
    later.setOptions({ initialRoot: unbound() });
    expect(later.snapshot().children!.content![0]!.collection).toEqual({ collectionPath: "lines" });
    // The definition handed in is left as it was: the controller works on a copy.
    expect(unbound().children!.content![0]!.collection).toBeUndefined();
  });

  it("does not offer the grid a Required, and leaves a form with no grid exactly as given", () => {
    const ctrl = controller();
    expect(ctrl.typeOffersRequired("dataGrid")).toBe(false);
    const plain: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [field("a")] } };
    expect(controller(plain).snapshot()).toEqual(plain);
  });
});
