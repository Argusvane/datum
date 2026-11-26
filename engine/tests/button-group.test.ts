// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import { journeyPageFormIds } from "../form-engine/core/schema/journey.js";
import type { JourneyView } from "../form-engine/core/journey/journey-types.js";
import {
  BUTTON_GROUP_CHILD_TYPES,
  BUTTON_GROUP_COMPONENT_TYPE,
  BUTTON_GROUP_SLOT_ID
} from "../form-engine/core/schema/button-group.js";
import { PDF_RENDITION_CATALOG } from "../form-engine/core/schema/pdf-renditions.js";
import { FormStateStore, type FormState } from "../form-engine/core/state/form-state.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { EventBus } from "../form-engine/core/events/event-bus.js";
import { buildDataPaths, buildValuePaths, holdsData } from "../form-engine/core/tree/data-scope.js";
import { classifyComponentForDataModel } from "../form-engine/builder/data-model/from-form.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildRenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import { buildRuntimeRenderOutput, type RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import { buildJourneyMeta, journeyPageComponents } from "../form-engine/render/core/journey-render.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { presentationForm } from "./fixtures/presentation-form.js";
import { DATUM_STYLES } from "../form-engine/render/live/datum/css.js";
import type { DatumControls } from "../form-engine/render/live/datum/options.js";
import { markupOf, unmountAll } from "./live-datum-parts-kit.js";
import { ENGINE_COMPONENT_TYPES } from "../form-engine/registry/engine-component-types.js";
import { deriveDefaultPdfLayout } from "../form-engine/render/pdf/default-layout.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { BUILT_IN_PDF_RENDITIONS } from "../form-engine/render/pdf/standard-renditions.js";
import type { PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import { canAcceptInSlot, createParentConstraintsResolverFromRegistry } from "../form-engine/builder/tree-editor/slot-constraints.js";
import {
  groupPaletteEntries,
  paletteGlyphName,
  paletteGroupForEntry
} from "../form-engine/builder/web-component/builder-shared.js";

/**
 * A `button-group` is a layout container for buttons. It draws a wrapping row the
 * stylesheet lays out (a `<div>`, or a `<ul>` of items under the Datum binding's
 * `controls.buttonGroup: "list"`), carries no data, prints nothing, and works inside every
 * other container.
 */

afterEach(unmountAll);

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

const submit = (id = "send"): ComponentNode => ({ id, type: "button", configuration: { label: "Send", action: "submit" } });
const later = (id = "later"): ComponentNode => ({ id, type: "button", configuration: { label: "Save for later", action: "download", variant: "link" } });

function group(children: ComponentNode[] = [submit(), later()], configuration: Record<string, unknown> = {}, id = "actions"): ComponentNode {
  return { id, type: BUTTON_GROUP_COMPONENT_TYPE, configuration, children: { [BUTTON_GROUP_SLOT_ID]: children } };
}

function form(children: ComponentNode[]): ComponentNode {
  return { id: "root", type: "form", configuration: {}, children: { content: children } };
}

async function render(
  root: ComponentNode,
  options: { mode?: "form" | "readonly"; controls?: DatumControls } = {}
): Promise<string> {
  unmountAll();
  return (await markupOf(root, { ...(options.mode ? { mode: options.mode as never } : {}), ...(options.controls ? { binding: { controls: options.controls } } : {}) })).html;
}

/** The markup of the element carrying `data-container-id="<id>"`, from its opening tag to the end of the string. */
function from(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at, `no ${marker}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at));
}

describe("button group markup", () => {
  it("draws a div of its buttons with the group's class, no inline style and no layout classes", async () => {
    const html = await render(form([group()]));
    const box = from(html, 'data-container-id="actions"');
    expect(box).toContain('<div class="datum-form__button-group"><div class="datum-live-field"');
    expect(box.indexOf('data-component-id="send"')).toBeLessThan(box.indexOf('data-component-id="later"'));
    expect(box).toContain('class="datum-form__button datum-form__button--link"');
    expect(box.slice(0, box.indexOf(">"))).not.toContain("style=");
    expect(html).not.toContain("datum-form__layout--");
    expect(html).not.toContain("<ul");
  });

  it("puts the author's classes beside its own", async () => {
    const html = await render(form([group(undefined, { cssClass: "acme-actions" })]));
    expect(html).toContain('<div class="datum-form__button-group acme-actions">');
  });

  it("draws a list of items under controls.buttonGroup \"list\"", async () => {
    const html = await render(form([group()]), { controls: { buttonGroup: "list" } });
    expect(html).toContain('<ul class="datum-form__button-group">');
    expect(html.match(/<li class="datum-form__button-group-item">/g)).toHaveLength(2);
    expect(html).toContain("</li></ul>");
    // The default stays a div.
    expect(await render(form([group()]), { controls: { buttonGroup: "div" } })).toContain('<div class="datum-form__button-group"');
  });

  it("draws no item for a hidden button, and nothing at all when every button is hidden", async () => {
    const hidden = (node: ComponentNode): ComponentNode => ({ ...node, configuration: { ...(node.configuration as object), hidden: true } });
    const one = await render(form([group([submit(), hidden(later())])]), { controls: { buttonGroup: "list" } });
    expect(one.match(/<li /g)).toHaveLength(1);
    expect(one).not.toContain('data-component-id="later"');
    const none = await render(form([{ id: "name", type: "text", configuration: { label: "Name" } }, group([hidden(submit())])]), { controls: { buttonGroup: "list" } });
    expect(none).not.toContain("<li");
  });

  it("still draws what a hand-written definition puts in it beside the buttons", async () => {
    const html = await render(form([group([submit(), { id: "note", type: "text", configuration: { label: "Note" } }])]));
    const box = from(html, 'data-container-id="actions"');
    expect(box).toContain('data-component-id="note"');
    expect(box.indexOf('data-component-id="send"')).toBeLessThan(box.indexOf('data-component-id="note"'));
  });

  it("is a type the engine draws", () => {
    expect(ENGINE_COMPONENT_TYPES.has(BUTTON_GROUP_COMPONENT_TYPE)).toBe(true);
  });

  it("works inside every other container: a fieldset, a panel, a tab, a step and a grid cell", async () => {
    const root = form([
      { id: "set", type: "fieldset", configuration: { label: "Set" }, children: { content: [group([submit("s1")], {}, "g1")] } },
      { id: "card", type: "panel", configuration: { label: "Card" }, children: { content: [group([submit("s2")], {}, "g2")] } },
      {
        id: "tabs",
        type: "tabs",
        configuration: { tabs: [{ id: "tab_1", label: "One" }] },
        children: { tab_1: [group([submit("s3")], {}, "g3")] }
      },
      {
        id: "steps",
        type: "steps",
        configuration: {},
        children: { content: [{ id: "step_1", type: "step", configuration: { label: "First" }, children: { content: [group([submit("s4")], {}, "g4")] } }] }
      },
      { id: "cols", type: "grid", configuration: { columns: 2 }, children: { column_2: [group([submit("s5")], {}, "g5")] } }
    ]);
    for (const controls of [undefined, { buttonGroup: "list" as const }]) {
      const html = await render(root, controls ? { controls } : {});
      const tag = controls ? "ul" : "div";
      for (const [id, button] of [["g1", "s1"], ["g2", "s2"], ["g3", "s3"], ["g4", "s4"], ["g5", "s5"]] as const) {
        const inside = from(html, `data-container-id="${id}"`);
        const at = inside.indexOf(`<${tag} class="datum-form__button-group">`);
        expect(at, id).toBeGreaterThan(-1);
        expect(inside.indexOf(`data-component-id="${button}"`)).toBeGreaterThan(at);
      }
    }
  });

  it("is laid out by the stylesheet: a wrapping flex row at the field gap", () => {
    expect(DATUM_STYLES).toContain(".datum-form__button-group");
    expect(DATUM_STYLES).toContain(".datum-form__button-group-item");
    expect(DATUM_STYLES).toMatch(/\.datum-form__button-group\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
  });
});

describe("a button group and the data", () => {
  it("adds no level to a path and claims no place, as a grid does not", () => {
    const root = form([
      {
        id: "applicant",
        type: "container",
        configuration: {},
        children: { content: [group([submit(), { id: "email", type: "text", configuration: {} }])] }
      }
    ]);
    const paths = buildValuePaths(root);
    expect(paths.get("email")).toBe("applicant.email");
    expect(buildDataPaths(root).get("email")).toBe("applicant.email");
    expect(holdsData(group())).toBe(false);
    expect(holdsData(submit())).toBe(false);
    // The builder's Data workspace reads it as a group, a hand-written one with no children map too.
    expect(classifyComponentForDataModel({ id: "g", type: BUTTON_GROUP_COMPONENT_TYPE, configuration: {} })).toEqual({ role: "group" });
  });
});

describe("a button group on paper", () => {
  function state(values: Record<string, unknown> = {}): FormState {
    return { ...new FormStateStore("en").snapshot(), values };
  }

  it("offers the children-only group rendition, in the catalog and the renderers alike", () => {
    expect(PDF_RENDITION_CATALOG[BUTTON_GROUP_COMPONENT_TYPE]).toEqual({ defaultRendition: "group", renditions: [{ id: "group", label: expect.any(String) }] });
    expect(BUILT_IN_PDF_RENDITIONS[BUTTON_GROUP_COMPONENT_TYPE]?.defaultRendition).toBe("group");
  });

  it("leaves nothing in the default layout: its buttons are dropped, anything else stays in place", () => {
    const root = form([{ id: "name", type: "text", configuration: { label: "Name" } }, group()]);
    const text = JSON.stringify(deriveDefaultPdfLayout(root));
    expect(text).not.toContain("actions");
    expect(text).not.toContain('"send"');
    const stray = JSON.stringify(deriveDefaultPdfLayout(form([group([submit(), { id: "note", type: "text", configuration: {} }])])));
    expect(stray).toContain('"componentId":"note"');
    expect(stray).not.toContain("sec-actions");
  });

  it("prints nothing and warns of nothing, in the default layout or bound under a panel in an authored one", async () => {
    const root = form([
      { id: "name", type: "text", configuration: { label: "Name" } },
      { id: "card", type: "panel", configuration: { label: "Card" }, children: { content: [group()] } },
      group(undefined, {}, "bottom")
    ]);
    const layout: PdfGeneratedLayout = {
      id: "l",
      kind: "generated",
      root: {
        id: "document",
        type: "pdf-document",
        configuration: {},
        children: { body: ["card", "bottom"].map((id) => ({ id: `f-${id}`, type: "pdf-field", configuration: { componentId: id } })) }
      }
    };
    for (const options of [{}, { layout, unknownComponents: "fail" as const }]) {
      const model = await buildPdfRenderModel(root, state({ name: "Ada" }), resolver, {}, options);
      expect(model.warnings.filter((warning) => warning.code === "component.unknown")).toEqual([]);
      const printed = JSON.stringify(model.document);
      expect(printed).not.toContain("Send");
      expect(printed).not.toContain("Save for later");
    }
  });
});

describe("a button group in the builder", () => {
  it("takes buttons alone in its slot", () => {
    const registry = new ComponentRegistry();
    registry.register({
      type: BUTTON_GROUP_COMPONENT_TYPE,
      version: "1.0.0",
      createDefault: () => group([]),
      capabilities: [],
      children: { slots: [{ id: BUTTON_GROUP_SLOT_ID, multiple: true, allowedTypes: [...BUTTON_GROUP_CHILD_TYPES] }] }
    });
    const constraints = createParentConstraintsResolverFromRegistry(registry);
    expect(canAcceptInSlot(group([]), submit(), BUTTON_GROUP_SLOT_ID, 0, constraints).ok).toBe(true);
    expect(canAcceptInSlot(group([]), later(), BUTTON_GROUP_SLOT_ID, 1, constraints).ok).toBe(true);
    expect(canAcceptInSlot(group([]), { id: "t", type: "text", configuration: {} }, BUTTON_GROUP_SLOT_ID, 0, constraints)).toEqual({
      ok: false,
      reason: `Child type text is not allowed in slot ${BUTTON_GROUP_SLOT_ID}`
    });
  });

  it("adds, refuses, moves, deletes and undoes through the controller like any container", () => {
    const def = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition =>
      ({ type, version: "1.0.0", createDefault: () => ({ id: type, type, configuration: {} }), capabilities: [], ...extra }) as ComponentDefinition;
    const ctrl = new BuilderController({
      componentTypes: [{ type: BUTTON_GROUP_COMPONENT_TYPE, label: "Button group" }],
      initialRoot: form([group(), { id: "name", type: "text", configuration: {} }]),
      componentDefinitions: [
        def("form", { children: { slots: [{ id: "content", multiple: true }] } }),
        def(BUTTON_GROUP_COMPONENT_TYPE, {
          createDefault: () => group([], {}, BUTTON_GROUP_COMPONENT_TYPE),
          children: { slots: [{ id: BUTTON_GROUP_SLOT_ID, multiple: true, allowedTypes: [...BUTTON_GROUP_CHILD_TYPES] }] }
        }),
        def("button"),
        def("text")
      ]
    });
    const kids = (id: string) => ctrl.snapshot().children!.content!.find((node) => node.id === id)?.children?.[BUTTON_GROUP_SLOT_ID]?.map((node) => node.id);
    ctrl.add(BUTTON_GROUP_COMPONENT_TYPE);
    const added = ctrl.selectedComponentId()!;
    expect(kids(added)).toEqual([]);
    ctrl.add("text", added, BUTTON_GROUP_SLOT_ID);
    expect(ctrl.dropError).toMatch(/not allowed/);
    expect(kids(added)).toEqual([]);
    const move = { getData: () => JSON.stringify({ kind: "existing-component", componentId: "later" }), setData: () => undefined };
    ctrl.applyDrop(move, added, BUTTON_GROUP_SLOT_ID, 0);
    expect(kids(added)).toEqual(["later"]);
    expect(kids("actions")).toEqual(["send"]);
    // A text field dropped into a group is refused the same way.
    ctrl.applyDrop({ getData: () => JSON.stringify({ kind: "existing-component", componentId: "name" }), setData: () => undefined }, added, BUTTON_GROUP_SLOT_ID, 0);
    expect(kids(added)).toEqual(["later"]);
    ctrl.undo();
    expect(kids("actions")).toEqual(["send", "later"]);
    // Deleting a group whose button is selected takes the selection with it.
    ctrl.select("send");
    ctrl.remove("actions");
    expect(kids("actions")).toBeUndefined();
    expect(ctrl.selectedComponentId()).toBeUndefined();
    ctrl.undo();
    expect(kids("actions")).toEqual(["send", "later"]);
  });

  it("sits in the palette's Layout group with the row glyph", () => {
    expect(paletteGroupForEntry({ type: BUTTON_GROUP_COMPONENT_TYPE })).toBe("Layout");
    expect(paletteGlyphName(BUTTON_GROUP_COMPONENT_TYPE)).toBe("container-row");
    const groups = groupPaletteEntries([
      { type: "grid", label: "Grid" },
      { type: BUTTON_GROUP_COMPONENT_TYPE, label: "Button group" },
      { type: "button", label: "Button" }
    ]);
    expect(groups.map((entry) => [entry.label, entry.entries.map((item) => item.type)])).toEqual([
      ["Layout", ["grid", BUTTON_GROUP_COMPONENT_TYPE]],
      ["Actions", ["button"]]
    ]);
  });

});

describe("a button group on a journey page, the peer's two checks", () => {
  const root = (): ComponentNode =>
    form([
      { id: "name", type: "text", configuration: { label: "Name" } },
      { id: "card", type: "fieldset", configuration: { label: "Finish" }, children: { content: [group()] } }
    ]);
  const journey = (components: string[]): Journey => ({ id: "apply", pages: [{ id: "one", components: ["name"] }, { id: "end", components }] });
  function view(components: string[]): JourneyView {
    const shape = journey(components);
    const page = shape.pages[1]!;
    return {
      journeyId: shape.id,
      journey: shape,
      pageId: page.id,
      page,
      kind: "questions",
      path: ["one", "end"],
      index: 1,
      total: 2,
      number: 2,
      completed: ["one"],
      frontierPageId: page.id,
      backPageId: "one",
      final: true,
      end: "end",
      members: journeyPageFormIds(page),
      pageOf: {},
      validation: { continue: "page", server: false, onUnavailable: "block" }
    };
  }
  function runtime(current: JourneyView): RenderableRuntime {
    const tree = root();
    const state = new FormStateStore("en");
    return {
      formRoot: () => tree,
      state: () => state.snapshot(),
      errors: () => [],
      effectiveStatesMap: () => new Map(),
      requiredMap: () => new Map(),
      componentTree: () => new ComponentTree(tree),
      resolveDataSource: async () => undefined,
      events: () => new EventBus(),
      journeyView: () => current
    };
  }

  it("finds a Submit inside a group the page lists, or inside a container holding it, so the page draws no second Submit", async () => {
    for (const members of [["actions"], ["card"], ["send"]]) {
      expect(buildJourneyMeta(root(), view(members), { locale: "en" }).hasOwnSubmit, members.join()).toBe(true);
      const output = await buildRuntimeRenderOutput(runtime(view(members)), "interactive");
      const submits = journeyPageComponents(output.components, view(members)).filter((model) => model.buttonAction === "submit");
      expect(submits, members.join()).toHaveLength(1);
      expect(output.meta.journey?.hasOwnSubmit, members.join()).toBe(true);
    }
  });

  it("finds a variant's own Submit inside an own group, and draws the group with it", async () => {
    const definition = presentationForm();
    const variant = definition.journey!.journeys![1]!;
    variant.pages[0]!.components = [
      ...variant.pages[0]!.components!,
      { id: "public_actions", type: BUTTON_GROUP_COMPONENT_TYPE, configuration: {}, children: { content: [{ id: "public_send", type: "button", configuration: { label: "Send", action: "submit" } }] } }
    ];
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]) });
    runtime.startJourney("public");
    const output = await buildRuntimeRenderOutput(runtime, "interactive");
    expect(output.meta.journey?.hasOwnSubmit).toBe(true);
    const page = journeyPageComponents(output.components, output.meta.journey!);
    expect(page.map((model) => model.id)).toEqual(expect.arrayContaining(["public_actions", "public_send"]));
    expect(page.find((model) => model.id === "public_send")?.parentId).toBe("public_actions");
    expect(page.filter((model) => model.buttonAction === "submit")).toHaveLength(1);
  });

  it("draws a listed group with its buttons, and a button listed alone without its group", async () => {
    const output = await buildRenderOutput({ mode: "interactive", root: root(), state: new FormStateStore("en").snapshot(), resolver });
    const whole = journeyPageComponents(output.components, { members: ["actions"] });
    expect(whole.map((model) => [model.id, model.parentId])).toEqual([
      ["root", undefined],
      ["actions", "root"],
      ["send", "actions"],
      ["later", "actions"]
    ]);
    const alone = journeyPageComponents(output.components, { members: ["send"] });
    expect(alone.map((model) => [model.id, model.parentId])).toEqual([
      ["root", undefined],
      ["send", "root"]
    ]);
    const shown = journeyPageComponents((await buildRuntimeRenderOutput(runtime(view(["send"])), "interactive")).components, { members: ["send"] });
    expect(shown.map((model) => model.id)).toContain("send");
    expect(shown.map((model) => model.id)).not.toContain("actions");
  });
});
