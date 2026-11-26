import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * What holds a component's Save back, asked per component: the Form panel asks about the root
 * and the inspector about the selection, and neither may be held back by the other's problem.
 */

const leaf = (type: string): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: {} }),
  capabilities: standardFieldCapabilities()
});

function controller(content: ComponentNode[]): BuilderController {
  return new BuilderController({
    initialRoot: { id: "root", type: "form", configuration: {}, children: { content } },
    componentDefinitions: [
      { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
      leaf("text")
    ]
  });
}

const text = (id: string, configuration: Record<string, unknown> = {}): ComponentNode => ({ id, type: "text", configuration });

describe("problems, per component", () => {
  it("lists a draft's unusable id, CSS class and data key, in the order the panel shows their boxes", () => {
    const ctrl = controller([text("city"), text("street"), text("zip")]);
    ctrl.select("street");
    ctrl.setDraftId("street", "city");
    ctrl.setDraftProperty("street", "cssClass", "2cols");
    ctrl.setDraftProperty("street", "dataKey", "zip");
    expect(ctrl.problemsOf("street")).toEqual([
      { target: "id", message: 'ID "city" already exists.' },
      { target: "cssClass", message: expect.stringContaining("is not a valid class name") },
      { target: "dataKey", message: expect.stringContaining("would store their answers in one place, zip") }
    ]);
  });

  it("never holds one component's Save back for another's problem", () => {
    const ctrl = controller([text("city"), text("street")]);
    ctrl.select("street");
    ctrl.setDraftId("street", "city");
    // An edit to the form's own settings, from the Form panel, beside the field's bad id.
    ctrl.setDraftProperty("root", "title", "Intake");
    expect(ctrl.problemsOf("street")).toHaveLength(1);
    expect(ctrl.problemsOf("root")).toEqual([]);
    expect(ctrl.commitDraft("root")).toBe(true);
    expect(ctrl.getProperty("root", "title")).toBe("Intake");
    // The field's own Save is still refused, and its problem still listed.
    expect(ctrl.commitDraft("street")).toBe(false);
    expect(ctrl.problemsOf("street")[0]).toMatchObject({ target: "id" });
  });

  it("follows the draft as it changes, and is empty once the draft is fixed or gone", () => {
    const ctrl = controller([text("city"), text("street")]);
    ctrl.select("street");
    ctrl.setDraftId("street", "city");
    expect(ctrl.problemsOf("street")).toHaveLength(1);
    ctrl.setDraftId("street", "road");
    expect(ctrl.problemsOf("street")).toEqual([]);
    ctrl.setDraftId("street", "city");
    ctrl.discardDraft("street");
    expect(ctrl.problemsOf("street")).toEqual([]);
    // A committed class the renderer would drop is a problem with or without a draft.
    const broken = controller([text("a", { cssClass: "2cols" })]);
    expect(broken.problemsOf("a").map((problem) => problem.target)).toEqual(["cssClass"]);
    expect(broken.problemsOf(undefined)).toEqual([]);
    expect(broken.problemsOf("nobody")).toEqual([]);
  });

  it("hands out copies, so a caller cannot edit what it is told", () => {
    const ctrl = controller([text("city"), text("street")]);
    ctrl.setDraftId("street", "city");
    ctrl.problemsOf("street")[0]!.message = "changed";
    expect(ctrl.problemsOf("street")[0]!.message).toBe('ID "city" already exists.');
  });
});

/**
 * A data grid's row bounds: said under their own boxes and refused at Save
 * like any other problem, but only for bounds the draft changes. The grid itself still reads
 * such a bound (`dataGridSettingsOf`), so a stored one is not a reason to hold up another edit.
 */
describe("a data grid's row bounds", () => {
  const gridDefinition: ComponentDefinition = {
    type: "dataGrid",
    version: "1.0.0",
    createDefault: () => ({ id: "dataGrid", type: "dataGrid", configuration: {}, collection: { collectionPath: "dataGrid" }, children: { content: [] } }),
    capabilities: [],
    children: { slots: [{ id: "content", multiple: true }] }
  };
  const gridController = (configuration: Record<string, unknown> = {}): BuilderController =>
    new BuilderController({
      initialRoot: {
        id: "root",
        type: "form",
        configuration: {},
        children: { content: [{ id: "people", type: "dataGrid", configuration, collection: { collectionPath: "people" }, children: { content: [text("name")] } }] }
      },
      componentDefinitions: [
        { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
        gridDefinition,
        leaf("text")
      ]
    });

  it("says a maximum below the minimum under the maximum, and refuses the save until it is mended", () => {
    const ctrl = gridController({ minRows: 2 });
    ctrl.select("people");
    ctrl.setDraftProperty("people", "maxRows", 1);
    expect(ctrl.problemsOf("people")).toEqual([{ target: "maxRows", message: expect.stringContaining("Maximum rows is below the minimum") }]);
    expect(ctrl.commitDraft("people")).toBe(false);
    ctrl.setDraftProperty("people", "maxRows", 2);
    expect(ctrl.problemsOf("people")).toEqual([]);
    expect(ctrl.commitDraft("people")).toBe(true);
    expect(ctrl.getProperty("people", "maxRows")).toBe(2);
  });

  it("flags a minimum raised past the stored maximum, though only the minimum changed", () => {
    const ctrl = gridController({ maxRows: 3 });
    ctrl.setDraftProperty("people", "minRows", 5);
    expect(ctrl.problemsOf("people").map((problem) => problem.target)).toEqual(["maxRows"]);
  });

  it("says a bound past 500 under its own box", () => {
    const ctrl = gridController();
    ctrl.setDraftProperty("people", "minRows", 501);
    ctrl.setDraftProperty("people", "maxRows", 9000);
    ctrl.setDraftProperty("people", "initialRows", 600);
    expect(ctrl.problemsOf("people")).toEqual([
      { target: "minRows", message: "At most 500." },
      { target: "maxRows", message: "At most 500." },
      { target: "initialRows", message: "At most 500." }
    ]);
    ctrl.setDraftProperty("people", "minRows", 500);
    ctrl.setDraftProperty("people", "maxRows", 500);
    ctrl.setDraftProperty("people", "initialRows", 3);
    expect(ctrl.problemsOf("people")).toEqual([]);
  });

  it("never holds up an edit to something else because of a bound already stored", () => {
    const ctrl = gridController({ minRows: 4, maxRows: 2 });
    expect(ctrl.problemsOf("people")).toEqual([]);
    ctrl.setDraftProperty("people", "label", "People");
    expect(ctrl.problemsOf("people")).toEqual([]);
    expect(ctrl.commitDraft("people")).toBe(true);
  });

  it("is empty for a field, whatever it holds", () => {
    const ctrl = gridController();
    ctrl.setDraftProperty("name", "minRows", 9);
    ctrl.setDraftProperty("name", "maxRows", 1);
    expect(ctrl.problemsOf("name")).toEqual([]);
  });
});
