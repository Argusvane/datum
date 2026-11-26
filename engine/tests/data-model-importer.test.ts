import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { DataModelImporter, type BuilderDataModelApplyDetail, type DataModelImporterHost } from "../form-engine/builder/data/data-model-import.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";

/**
 * The import the Data workspace's dialog draws:
 * the text read and laid over the form, the actions it offers, and a build as one undo step.
 * The host here is a stand-in: no frame is drawn, so only the importer's own state is read.
 */

const leaf = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: { label: `${type} field` } }),
  capabilities: standardFieldCapabilities(),
  ...extra
});
const box = (type: string): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: { label: type }, children: { content: [] } }),
  capabilities: [],
  children: { slots: [{ id: "content", multiple: true }] }
});
const DEFINITIONS: ComponentDefinition[] = [
  box("form"),
  ...["text", "textarea", "number", "checkbox", "select", "radio", "checkboxes", "date"].map((type) => leaf(type)),
  box("container"),
  box("panel"),
  leaf("button", { capabilities: standardFieldCapabilities({ required: false }) })
];

function controllerWith(...ids: string[]): BuilderController {
  return new BuilderController({
    initialRoot: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [...ids.map((id) => ({ id, type: "text", configuration: { label: id } })), { id: "send", type: "button", configuration: { label: "Send" } }]
      }
    },
    componentDefinitions: DEFINITIONS
  });
}

interface Harness {
  importer: DataModelImporter;
  built: Array<{ detail: BuilderDataModelApplyDetail; message: string }>;
  said: string[];
}

function harness(controller: BuilderController, overrides: Partial<DataModelImporterHost> = {}): Harness {
  const built: Harness["built"] = [];
  const said: string[] = [];
  const importer = new DataModelImporter({
    controller: () => controller,
    canBuild: () => true,
    selectsRows: () => false,
    scope: () => undefined,
    paint: () => undefined,
    announce: (text) => said.push(text),
    built: (detail, message) => built.push({ detail, message }),
    ...overrides
  });
  return { importer, built, said };
}

/** A button as the importer reads one: its data attributes. */
const button = (name: string): HTMLElement => ({ dataset: { [name]: "" } }) as unknown as HTMLElement;
const ids = (controller: BuilderController): string[] => (controller.snapshot().children?.content ?? []).map((node) => node.id);

describe("the shared data model import", () => {
  it("reads a sample, says what is new and what the form holds, and offers to add the missing fields", () => {
    const controller = controllerWith("name");
    const { importer } = harness(controller);
    importer.setText(JSON.stringify({ name: "Ada", phone: "555-0100", email: "ada@example.com" }));
    expect(importer.result()).toMatchObject({ ok: true, readAs: "sample" });
    expect(importer.comparison()?.counts).toMatchObject({ new: 2, present: 1 });
    const { html } = importer.results();
    expect(html).toContain("3 places, 2 new, 1 on the form.");
    expect(html).toContain("Add missing fields (2)");
    expect(html).toContain('data-model-entry-status="new"');
    expect(html).toContain("data-model-replace");
  });

  it("adds the missing fields as one undo step, and tells its host what it built", () => {
    const controller = controllerWith("name");
    const { importer, built, said } = harness(controller);
    importer.setText(JSON.stringify({ name: "Ada", phone: "555-0100" }));
    expect(importer.click(button("modelAdd"))).toBe(true);
    expect(ids(controller)).toEqual(["name", "phone", "send"]);
    expect(built).toEqual([
      { detail: { action: "add-missing", source: "sample", ids: ["phone"], skipped: [] }, message: "Added 1 component. Undo takes it all back in one step." }
    ]);
    expect(said.at(-1)).toBe("Added 1 component. Undo takes it all back in one step.");
    controller.undo();
    expect(ids(controller)).toEqual(["name", "send"]);
  });

  it("asks before Replace form contents, and replaces as one undo step, keeping the closing button", () => {
    const controller = controllerWith("name", "age");
    const { importer, built } = harness(controller);
    importer.setText(JSON.stringify({ title: "Dr", guests: 2 }));
    importer.click(button("modelReplace"));
    expect(importer.confirmingReplace).toBe(true);
    expect(importer.results().html).toContain("2 components go");
    importer.click(button("modelReplaceCancel"));
    expect(importer.confirmingReplace).toBe(false);
    expect(importer.results().html).not.toContain("data-model-confirm");

    importer.click(button("modelReplace"));
    importer.click(button("modelReplaceConfirm"));
    expect(ids(controller)).toEqual(["title", "guests", "send"]);
    expect(built[0]!.detail.action).toBe("replace");
    controller.undo();
    expect(ids(controller)).toEqual(["name", "age", "send"]);
  });

  it("builds nothing while the selection holds edits not applied, and says why", () => {
    const controller = controllerWith("name");
    controller.select("name");
    controller.setDraftProperty("name", "label", "Your name");
    const { importer, built } = harness(controller);
    importer.setText(JSON.stringify({ phone: "555-0100" }));
    importer.click(button("modelAdd"));
    expect(ids(controller)).toEqual(["name", "send"]);
    expect(built).toEqual([]);
    expect(importer.statusText).toMatch(/^Save or discard the selected component's edits first/);
    expect(controller.unsavedChangesPrompt()).toMatchObject({ componentId: "name", action: "add" });
  });

  it("offers Build form on an empty form, and no build where it may not build", () => {
    const empty = new BuilderController({ initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } }, componentDefinitions: DEFINITIONS });
    const { importer } = harness(empty);
    importer.setText(JSON.stringify({ name: "Ada" }));
    expect(importer.results().html).toContain("data-model-build");

    const elsewhere = harness(controllerWith("name"), { canBuild: () => false }).importer;
    elsewhere.setText(JSON.stringify({ phone: "x" }));
    expect(elsewhere.results().html).toContain("open the form&#39;s tab");
    expect(elsewhere.results().html).not.toContain("data-model-add");
  });

  it("reads a host's own types through the classifier it now imports: a value-holding one is on the form, one holding nothing is not", () => {
    const definitions: ComponentDefinition[] = [...DEFINITIONS, leaf("host-rating"), leaf("host-badge", { capabilities: [] })];
    const controller = new BuilderController({
      initialRoot: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "stars", type: "host-rating", configuration: { label: "Stars" } },
            { id: "flair", type: "host-badge", configuration: { label: "Flair" } },
            { id: "send", type: "button", configuration: { label: "Send" } }
          ]
        }
      },
      componentDefinitions: definitions
    });
    const { importer } = harness(controller);
    importer.setText(JSON.stringify({ stars: 4, flair: "x", mood: "ok" }));
    expect(importer.comparison()?.byPath.get("stars")?.status).toBe("present");
    expect(importer.comparison()?.byPath.get("flair")?.status).toBe("new");
    expect(importer.results().html).toContain("3 places, 2 new, 1 on the form.");
  });

  it("builds no field under an id the form claims beside its tree, through the generate options it now imports", () => {
    const controller = controllerWith("name");
    // What the Journeys mode claims while a page-only field holds the id.
    controller.setOptions({ claimedIds: () => ["phone"] }, { silent: true });
    const { importer, built } = harness(controller);
    importer.setText(JSON.stringify({ name: "Ada", phone: "555-0100" }));
    importer.click(button("modelAdd"));
    expect(ids(controller)).toEqual(["name", "phone_2", "send"]);
    expect(built[0]!.detail.ids).toEqual(["phone_2"]);
  });

  it("says where the text cannot be read, and reads it as the author says", () => {
    const controller = controllerWith("name");
    const { importer } = harness(controller);
    importer.setText('{ "a": ');
    expect(importer.result()).toMatchObject({ ok: false });
    expect(importer.results().html).toBe("");
    importer.setText(JSON.stringify({ type: "object", properties: { name: { type: "string" } } }));
    expect(importer.result()).toMatchObject({ ok: true, readAs: "schema" });
    importer.readAs = "sample";
    expect(importer.result()).toMatchObject({ ok: true, readAs: "sample" });
  });

  it("builds an empty form from a JSON Schema: the title, the required flag and an enum's options", () => {
    const empty = new BuilderController({ initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } }, componentDefinitions: DEFINITIONS });
    const { importer, built } = harness(empty);
    importer.setText(
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", title: "Your name" }, size: { enum: ["s", "m", "l"] } }
      })
    );
    expect(importer.results().html).toContain("data-model-build");
    expect(importer.click(button("modelBuild"))).toBe(true);
    const [name, size] = empty.snapshot().children!.content!;
    expect(name).toMatchObject({ id: "name", type: "text", configuration: { label: "Your name", required: true } });
    expect(size).toMatchObject({ id: "size", type: "radio", configuration: { options: [{ value: "s", label: "S" }, { value: "m", label: "M" }, { value: "l", label: "L" }] } });
    expect(built[0]!.detail.action).toBe("build");
  });

  it("builds a list of objects as a data grid that keeps its rows at the list's path, and undoes it in one step", () => {
    const controller = new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "fullName", type: "text", configuration: { label: "Name" } }] } },
      componentDefinitions: [...DEFINITIONS, box("dataGrid")]
    });
    const { importer } = harness(controller);
    importer.setText(JSON.stringify({ fullName: "Ada", dependants: [{ given: "Grace", born: "2010-01-02", age: 14 }] }));
    importer.click(button("modelAdd"));
    const grid = controller.snapshot().children!.content!.find((node) => node.id === "dependants")!;
    expect(grid.type).toBe("dataGrid");
    expect(grid.collection).toEqual({ collectionPath: "dependants" });
    expect(grid.children!.content!.map((node) => node.id)).toEqual(["given", "born", "age"]);
    // The form then describes the list as it did the sample: rows at the path, its fields below.
    expect(importer.comparison()?.entries.find((entry) => entry.path === "dependants[].age")?.status).toBe("present");
    controller.undo();
    expect(ids(controller)).toEqual(["fullName"]);
  });
});
