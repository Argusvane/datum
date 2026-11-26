// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { buildInspectorModel, drawnInspectorModel, type BuilderDrawingSource, type InspectorDrawnBy } from "../form-engine/builder/property-editor/inspector-model.js";
import {
  DATUM_BUILDER_CANVAS_TAG,
  DATUM_BUILDER_PROPERTIES_TAG,
  defineBuilderPanels,
  type DatumBuilderCanvasElement,
  type DatumBuilderPropertiesElement
} from "../form-engine/builder/web-component/builder-panels.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { extendBinding, fieldCapabilitiesOf, type FieldAdapter, type LiveBinding } from "../form-engine/render/live/contract.js";
import { createDatumGridAdapter } from "../form-engine/render/live/datum/grid.js";
import { html } from "../form-engine/render/live/lit.js";
import { registerBinding } from "../form-engine/render/live/binding-registry.js";
import { createDatumBinding } from "../form-engine/render/live/renderer.js";
import type { DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";
import { AGENT_BUILDER_DEFINITIONS } from "./fixtures/agent-builder-definitions.js";
import { agentBuilder, okOf } from "./fixtures/agent-builder.js";

/**
 * The inspector and the drawing: it names the adapter that draws the selection
 * (`live.adapterOf`), leaves out the boxes for settings the binding does not draw
 * (`live.capabilitiesOf`, `none`), keeps a box whose setting still holds a value with a note, and
 * notes a setting drawn in a reduced form (`degraded`).
 */

defineBuilderPanels();

afterEach(() => {
  document.body.innerHTML = "";
});

const form = (): ComponentNode =>
  ({
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Full name", tooltip: "As on your passport" } },
        { id: "city", type: "text", configuration: { label: "City" } },
        { id: "box", type: "fieldset", configuration: { label: "Group" }, children: { content: [] } }
      ]
    }
  }) as ComponentNode;

const source = (answers: Record<string, string> | undefined, adapters: Record<string, InspectorDrawnBy> = {}): BuilderDrawingSource => ({
  adapterOf: (id) => adapters[id],
  capabilitiesOf: (type) => (type === "text" && answers !== undefined ? { answers: answers as never } : undefined),
  bindingLabel: () => "Acme DS"
});

/** The boxes the properties panel draws for `id`. */
const paths = (controller: BuilderController, id: string): string[] =>
  drawnInspectorModel(controller.inspectorModel(id)!).sections.flatMap((section) => section.fields.map((field) => field.propertyPath));
/** Every setting the model knows for `id`, drawn or not. */
const known = (controller: BuilderController, id: string): string[] => controller.inspectorModel(id)!.sections.flatMap((section) => section.fields.map((field) => field.propertyPath));

describe("the inspector under a binding's capability answers", () => {
  it("shows every box when nothing lends it an answer", () => {
    const controller = new BuilderController({ initialRoot: form(), componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    expect(paths(controller, "city")).toEqual(expect.arrayContaining(["placeholder", "tooltip", "characterCount", "hideLabel"]));
    expect(controller.inspectorModel("city")!.drawing).toBeUndefined();
  });

  it("leaves out the box of a setting the binding does not draw, keeps the one that still holds a value, and notes a reduced one", () => {
    const controller = new BuilderController({ initialRoot: form(), componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    controller.setDrawingSource(source({ placeholder: "none", tooltip: "none", characterCount: "degraded", hideLabel: "drawn", prefix: "none" }));

    // No value: no box. Nothing for the author to set that the form would not show.
    const city = paths(controller, "city");
    expect(city).not.toContain("placeholder");
    expect(city).not.toContain("tooltip");
    expect(city).toEqual(expect.arrayContaining(["characterCount", "hideLabel", "label"]));
    // The model itself still knows them: only the panel's view leaves them out.
    expect(known(controller, "city")).toEqual(expect.arrayContaining(["placeholder", "tooltip"]));
    expect(controller.inspectorModel("city")!.drawing).toEqual({
      hidden: [
        { propertyPath: "placeholder", capability: "placeholder" },
        { propertyPath: "tooltip", capability: "tooltip" }
      ],
      kept: [],
      degraded: [{ propertyPath: "characterCount", capability: "characterCount" }]
    });

    // A value already there keeps its box, so it can be read and cleared, with a note that the form ignores it.
    const name = controller.inspectorModel("name")!;
    expect(name.sections.flatMap((section) => section.fields.map((field) => field.propertyPath))).toContain("tooltip");
    expect(name.drawing?.kept).toEqual([{ propertyPath: "tooltip", capability: "tooltip" }]);
    expect(controller.notesOf("name").find((note) => note.target === "tooltip")?.message).toBe("Acme DS does not draw this setting, so the form ignores it. The value stays in the form.");

    // A reduced setting stays, with a note that says how.
    expect(controller.notesOf("city").find((note) => note.target === "characterCount")?.message).toBe(
      "Acme DS draws the count, but a screen reader is not told as it changes."
    );
    // Hidden boxes carry no note: there is nothing to put one under.
    expect(controller.notesOf("city").some((note) => note.target === "placeholder")).toBe(false);
  });

  it("answers for fields and data grids only: a group container's boxes are all kept", () => {
    const controller = new BuilderController({ initialRoot: form(), componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    const before = paths(controller, "box");
    controller.setDrawingSource(source({ placeholder: "none", tooltip: "none" }));
    expect(paths(controller, "box")).toEqual(before);
  });

  it("drops a section whose boxes were all left out, and no other", () => {
    const node = { id: "x", type: "text", configuration: {} } as ComponentNode;
    const capability = {
      id: "sections",
      version: "1.0.0",
      configureEditor: () => ({
        fields: [
          { id: "placeholder", type: "text", propertyPath: "placeholder", label: "Placeholder" },
          { id: "tooltip", type: "text", propertyPath: "tooltip", label: "Tooltip" },
          { id: "label", type: "text", propertyPath: "label", label: "Label" }
        ],
        sections: [
          { id: "extras", title: "Extras", fieldIds: ["placeholder", "tooltip"] },
          { id: "main", title: "Main", fieldIds: ["label"] },
          { id: "bare", title: "Bare", fieldIds: [] }
        ]
      })
    };
    const plain = buildInspectorModel(node, [capability as never]);
    const answered = buildInspectorModel(node, [capability as never], undefined, "en", { drawing: { answers: { placeholder: "none", tooltip: "none" } } });
    expect(plain.sections.map((section) => section.id)).toEqual(["extras", "main", "bare"]);
    expect(answered.sections.map((section) => section.id)).toEqual(["extras", "main", "bare"]);
    expect(drawnInspectorModel(answered).sections.map((section) => section.id)).toEqual(["main", "bare"]);
    expect(drawnInspectorModel(plain)).toBe(plain);
  });
});

describe("a data grid's answers come from the binding's grid adapter", () => {
  const rowsCapability = {
    id: "rows",
    version: "1.0.0",
    configureEditor: () => ({
      fields: [
        { id: "label", type: "text", propertyPath: "label", label: "Label" },
        { id: "showRowNumbers", type: "checkbox", propertyPath: "showRowNumbers", label: "Show row numbers" }
      ]
    })
  };
  const grid = (configuration: Record<string, unknown>): ComponentNode => ({ id: "rows", type: "dataGrid", configuration, children: { content: [] } }) as ComponentNode;

  it("reads Datum's grid as drawing row numbers and its label, and a binding's grid that draws none as none", () => {
    const datum = createDatumBinding();
    expect(fieldCapabilitiesOf(datum, datum, "dataGrid")).toMatchObject({ kind: "collection", from: "binding", answers: { rowNumbers: "drawn", hideLabel: "drawn" } });
    const plain = extendBinding(datum, { id: "plain-grid", label: "Plain DS", components: { dataGrid: { ...createDatumGridAdapter(), capabilities: { hideLabel: "drawn" } } } });
    const answers = fieldCapabilitiesOf(plain, datum, "dataGrid");
    expect(answers).toMatchObject({ from: "binding", answers: { rowNumbers: "none", hideLabel: "drawn" } });

    // So "Show row numbers" is not drawn under it, and a grid that switched them on keeps the box, with its note.
    const hidden = buildInspectorModel(grid({}), [rowsCapability as never], undefined, "en", { drawing: answers! });
    expect(hidden.drawing?.hidden).toEqual([{ propertyPath: "showRowNumbers", capability: "rowNumbers" }]);
    expect(drawnInspectorModel(hidden).sections.flatMap((section) => section.fields.map((field) => field.propertyPath))).toEqual(["label"]);
    const kept = buildInspectorModel(grid({ showRowNumbers: true }), [rowsCapability as never], undefined, "en", { drawing: answers! });
    expect(kept.drawing?.kept).toEqual([{ propertyPath: "showRowNumbers", capability: "rowNumbers" }]);
  });
});

describe("an agent writing a setting the binding does not draw", () => {
  const write = async (answers: Record<string, string> | undefined) => {
    const builder = agentBuilder();
    if (answers !== undefined) {
      builder.controller.setDrawingSource(source(answers));
    }
    const result = okOf<{ warnings?: unknown[] }>(
      await builder.execute("set_properties", {
        edits: [
          { componentId: "email", propertyPath: "placeholder", value: "you@example.com" },
          { componentId: "email", propertyPath: "hideLabel", value: "true" }
        ]
      })
    );
    const email = builder.controller.snapshot().children?.content?.find((node) => node.id === "email");
    return { warnings: JSON.stringify(result.warnings ?? []), configuration: email?.configuration as Record<string, unknown> | undefined };
  };

  it("still knows the property, so it is neither warned about nor written as untyped text", async () => {
    const without = await write(undefined);
    const under = await write({ placeholder: "none", hideLabel: "none" });
    expect(under.warnings).not.toContain("unknown-property");
    expect(under.warnings).toBe(without.warnings);
    // The checkbox's value is read by its box's kind: "true" is the boolean, as without a binding.
    expect(under.configuration?.hideLabel).toBe(true);
    expect(under.configuration?.placeholder).toBe("you@example.com");
    expect(under.configuration).toEqual(without.configuration);
  });
});

describe("the inspector names the adapter that draws the selection", () => {
  const drawn = (adapter: InspectorDrawnBy | undefined): string | undefined => {
    const controller = new BuilderController({ initialRoot: form(), componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    controller.setDrawingSource(source(undefined, adapter === undefined ? {} : { city: adapter }));
    return controller.drawnByLine("city");
  };

  it.each([
    [{ from: "binding", via: "text", name: "acme-text" }, "Drawn by acme-text, from Acme DS."],
    [{ from: "binding-base", via: "text", name: "acme-text" }, "Drawn by acme-text, from Acme DS, as a text."],
    [{ from: "datum", via: "date", name: "datum-date" }, "Drawn by Datum’s datum-date: Acme DS has no component for this type."],
    [{ from: "datum-base", via: "date", name: "datum-date" }, "Drawn by Datum’s datum-date, as a date: Acme DS has no component for this type or its base."],
    [{ from: "renderer", via: "fancy" }, "Nothing draws this type: the form shows a note in its place."]
  ] as Array<[InspectorDrawnBy, string]>)("says it for %j", (adapter, line) => {
    expect(drawn(adapter)).toBe(line);
  });

  it("says nothing before the canvas has drawn it, without a source, or for the root", () => {
    expect(drawn(undefined)).toBeUndefined();
    const controller = new BuilderController({ initialRoot: form(), componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    expect(controller.drawnByLine("city")).toBeUndefined();
    controller.setDrawingSource(source(undefined, { root: { from: "binding", via: "form", name: "x" } }));
    expect(controller.drawnByLine("root")).toBeUndefined();
  });

  it("names the adapter by its type when it has no name", () => {
    expect(drawn({ from: "binding", via: "text" })).toBe("Drawn by text, from Acme DS.");
  });
});

// ── Through the canvas and the properties panel ────────────────────────────────────────────

const settle = async (renderer: DatumFormRendererElement): Promise<void> => {
  await renderer.painted();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A binding with its own text component, an honest `none` for tooltip and a `degraded` count. */
function acmeBinding(): LiveBinding {
  const text: FieldAdapter = {
    kind: "field",
    name: "acme-text",
    capabilities: { hideLabel: "drawn", characterCount: "degraded", placeholder: "none", tooltip: "none" },
    template: (s) => html`<label for=${s.id}>${s.label}</label><input id=${s.id} />`
  };
  return extendBinding(createDatumBinding(), { id: "acme", label: "Acme DS", components: { text } });
}

async function mount(binding: LiveBinding | undefined, selected: string) {
  const controller = new BuilderController({ initialRoot: form(), componentDefinitions: AGENT_BUILDER_DEFINITIONS, ...(binding ? { binding } : {}) });
  controller.select(selected);
  const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
  canvas.controller = controller;
  const panel = document.createElement(DATUM_BUILDER_PROPERTIES_TAG) as DatumBuilderPropertiesElement;
  panel.controller = controller;
  document.body.append(canvas, panel);
  const renderer = canvas.shadowRoot!.querySelector("[data-preview]") as DatumFormRendererElement;
  await settle(renderer);
  return { controller, canvas, panel, renderer };
}

describe("the canvas lends the inspector how the form is drawn", () => {
  it("draws the adapter's name in the panel once the form is drawn, and the boxes the binding draws", async () => {
    const { panel, renderer } = await mount(acmeBinding(), "city");
    const note = panel.shadowRoot!.querySelector("[data-inspector-drawn]");
    expect(note?.textContent).toBe("Drawn by acme-text, from Acme DS.");
    // The binding answers `none` for these two: no box.
    expect(panel.shadowRoot!.querySelector('[data-prop="placeholder"]')).toBeNull();
    expect(panel.shadowRoot!.querySelector('[data-prop="tooltip"]')).toBeNull();
    expect(panel.shadowRoot!.querySelector('[data-prop="characterCount"]')).not.toBeNull();
    // The element's own answers are what was read.
    expect(renderer.capabilitiesOf("text")?.answers.placeholder).toBe("none");
    expect(renderer.live?.adapterOf("city")).toMatchObject({ from: "binding", name: "acme-text" });
  });

  it("names Datum's adapter under Datum's binding and shows all its boxes", async () => {
    const { panel } = await mount(undefined, "city");
    expect(panel.shadowRoot!.querySelector("[data-inspector-drawn]")?.textContent).toMatch(/^Drawn by datum-text, from /);
    expect(panel.shadowRoot!.querySelector('[data-prop="placeholder"]')).not.toBeNull();
    expect(panel.shadowRoot!.querySelector('[data-prop="tooltip"]')).not.toBeNull();
  });

  it("draws the panel again when the picked binding changes how the selection is drawn", async () => {
    registerBinding(acmeBinding());
    const { controller, panel, renderer } = await mount(undefined, "city");
    expect(panel.shadowRoot!.querySelector('[data-prop="placeholder"]')).not.toBeNull();
    let heard = 0;
    controller.on("drawing", () => (heard += 1));
    controller.setOptions({ availableBindings: [{ id: "acme", label: "Acme DS" }] });
    controller.setBindingId("acme");
    await settle(renderer);
    await settle(renderer);
    expect(heard).toBeGreaterThan(0);
    expect(panel.shadowRoot!.querySelector("[data-inspector-drawn]")?.textContent).toBe("Drawn by acme-text, from Acme DS.");
    expect(panel.shadowRoot!.querySelector('[data-prop="placeholder"]')).toBeNull();
  });

  it("says nothing more when a draw moved nothing", async () => {
    const { controller, renderer } = await mount(acmeBinding(), "city");
    let heard = 0;
    controller.on("drawing", () => (heard += 1));
    controller.select("name");
    controller.select("city");
    await settle(renderer);
    // The selection went to a field the binding draws the same way and came back: at most one wake-up per real change.
    expect(heard).toBeLessThanOrEqual(2);
    const settled = heard;
    await settle(renderer);
    expect(heard).toBe(settled);
  });
});
