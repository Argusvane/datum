// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { buildRenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import { DATUM_FORM_RENDERER_TAG, defineDatumFormRendererElement, type DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";

const emptyResolver: DataSourceResolver = { resolveDataSource: async () => undefined };

/**
 * One tree exercising everything build mode must draw correctly: layout containers, a select
 * fed by a data source, a required field with a description, a stack container, and a field
 * gated on a sibling's value.
 */
const ROOT: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { label: "Intake" },
  children: {
    content: [
      {
        id: "full_name",
        type: "text",
        configuration: { label: "Full name", description: "As on your ID", required: true }
      },
      {
        id: "address",
        type: "grid",
        configuration: { columns: 3 },
        children: {
          column_1: [{ id: "street", type: "text", configuration: { label: "Street" } }],
          column_2: [{ id: "city", type: "text", configuration: { label: "City" } }]
        }
      },
      {
        id: "country",
        type: "select",
        configuration: { label: "Country", data: { sourceId: "countries" } }
      },
      {
        id: "prefs",
        type: "fieldset",
        configuration: { label: "Preferences" },
        children: {
          content: [
            { id: "opt_in", type: "checkbox", configuration: { label: "Subscribe" } },
            {
              id: "email",
              type: "text",
              configuration: { label: "Email" },
              rules: {
                visibleWhen: {
                  kind: "binary",
                  operator: "eq",
                  left: { kind: "path", path: "opt_in" },
                  right: { kind: "literal", value: true }
                }
              }
            }
          ]
        }
      }
    ]
  }
};

function form(children: ComponentNode[]): ComponentNode {
  return { id: "root", type: "form", configuration: {}, children: { content: children } };
}

const countries: DataSourceResolver = {
  resolveDataSource: async () => ({
    items: [
      { value: "CA", label: "Canada" },
      { value: "US", label: "United States" }
    ]
  })
};

defineDatumFormRendererElement();

afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * The preview drawn as the canvas draws it: the live renderer's element on the preview runtime,
 * read through the DOM contract (the field wrapper `data-component-id` and its state hooks).
 */
async function drawn(preview: BuilderPreviewRuntime): Promise<{ root: ShadowRoot; settle(): Promise<void> }> {
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  element.runtime = preview as never;
  document.body.append(element);
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.painted();
  };
  await settle();
  return { root: element.shadowRoot!, settle };
}

const field = (root: ShadowRoot, id: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-component-id="${id}"]`);

// The canvas draws through the live renderer with the binding's own markup (builder-canvas-hooks.test.ts).
describe("builder preview model", () => {
  it("agrees with a live FormRuntime-shaped model on the same tree", async () => {
    // Guards the other direction: the preview's own model matches what the render pipeline
    // produces when a real runtime supplies effective state and requiredness.
    const preview = new BuilderPreviewRuntime(ROOT, { dataSourceResolver: countries });
    const fromPreview = await buildRuntimeRenderOutput(preview, "interactive");

    const fromPipeline = await buildRenderOutput({
      mode: "interactive",
      root: ROOT,
      state: new FormStateStore("en").snapshot(),
      resolver: countries,
      effectiveStates: preview.effectiveStatesMap(),
      requiredByComponent: preview.requiredMap(),
      componentTree: preview.componentTree()
    });

    // The models the renderer draws from are the same, field by field.
    expect(fromPreview).toEqual(fromPipeline);
  });
});

describe("BuilderPreviewRuntime", () => {
  it("keeps a ticked field's marker while its Required-when rule is false: Required OR Required when", async () => {
    const contactIs = (value: string) => ({
      kind: "binary" as const,
      operator: "eq" as const,
      left: { kind: "path" as const, path: "contact" },
      right: { kind: "literal" as const, value }
    });
    const tree = form([
      { id: "contact", type: "text", configuration: { label: "Contact" } },
      { id: "both", type: "text", configuration: { label: "Both", required: true }, rules: { requiredWhen: contactIs("never") } },
      { id: "phone", type: "text", configuration: { label: "Phone" }, rules: { requiredWhen: contactIs("phone") } }
    ]);
    const preview = new BuilderPreviewRuntime(tree);
    const { root, settle } = await drawn(preview);
    const required = (id: string): boolean => field(root, id)?.hasAttribute("data-required") === true;

    expect([...preview.requiredMap()]).toEqual([
      ["contact", false],
      ["both", true],
      ["phone", false]
    ]);
    expect(required("both")).toBe(true);
    expect(required("phone")).toBe(false);

    // The rule marks it required as the author fills the canvas in, exactly as the live form would.
    preview.setValue("contact", "phone");
    expect(preview.requiredMap().get("phone")).toBe(true);
    await settle();
    expect(required("both")).toBe(true);
    expect(required("phone")).toBe(true);
  });

  it("re-evaluates visibleWhen as the author fills the canvas in", async () => {
    const preview = new BuilderPreviewRuntime(ROOT);
    const { root, settle } = await drawn(preview);

    // The gated field starts hidden — dropped from the canvas exactly as the live form
    // drops it, which is what makes the Tree tab the way back to it.
    expect(field(root, "full_name")).not.toBeNull();
    expect(field(root, "email")).toBeNull();
    expect(preview.effectiveStatesMap().get("email")?.visible).toBe(false);

    preview.setValue("opt_in", true);
    await settle();
    expect(field(root, "email")?.querySelector("input")).not.toBeNull();
    expect(preview.effectiveStatesMap().get("email")?.visible).toBe(true);
  });

  it("keeps design-time values across a tree edit", () => {
    const preview = new BuilderPreviewRuntime(ROOT);
    preview.setValue("full_name", "Ada");

    // The kind of change a single keystroke in the property inspector produces.
    const edited = structuredClone(ROOT);
    (edited.children!["content"]![0]!.configuration as { label: string }).label = "Legal name";
    preview.setFormRoot(edited);

    expect(preview.state().values["full_name"]).toBe("Ada");
    expect(preview.formRoot()).toBe(edited);
  });

  it("publishes the events the renderer repaints on", () => {
    const preview = new BuilderPreviewRuntime(ROOT);
    const seen: string[] = [];
    preview.events().subscribe("*", (event) => seen.push(event.type));

    preview.setValue("opt_in", true);
    const edited = structuredClone(ROOT);
    (edited.children!["content"]![0]!.configuration as { label: string }).label = "Legal name";
    preview.setFormRoot(edited);

    expect(seen).toContain(FormEventType.COMPONENT_CHANGED);
    expect(seen).toContain(FormEventType.RECOMPUTE_COMPLETED);
    expect(seen).toContain(FormEventType.FORM_INITIALIZED);
  });

  it("ignores a tree that has not actually changed", () => {
    // The canvas hands over a fresh snapshot on every controller event, selection included.
    // Without this guard each one would rebuild the orchestrator and repaint the whole form.
    const preview = new BuilderPreviewRuntime(ROOT);
    const seen: string[] = [];
    preview.events().subscribe("*", (event) => seen.push(event.type));

    preview.setFormRoot(structuredClone(ROOT));

    expect(seen).toEqual([]);
  });

  it("keeps rendering the last coherent tree when an edit introduces a rule cycle", () => {
    const preview = new BuilderPreviewRuntime(ROOT);
    const cyclic = structuredClone(ROOT);
    cyclic.children!["content"]![0]!.rules = {
      value: { kind: "path", path: "city" }
    };
    cyclic.children!["content"]![1]!.children!["column_2"]![0]!.rules = {
      value: { kind: "path", path: "full_name" }
    };

    // Mid-edit a tree can be momentarily incoherent; the canvas must not go blank.
    expect(() => preview.setFormRoot(cyclic)).not.toThrow();
    expect(preview.formRoot()).toBe(ROOT);
  });

  it("reports no errors — validation is a host pipeline, not something a tree implies", () => {
    expect(new BuilderPreviewRuntime(ROOT).errors()).toEqual([]);
  });

  it("previews a select with only its placeholder when no resolver is supplied", async () => {
    const preview = new BuilderPreviewRuntime(ROOT, { dataSourceResolver: emptyResolver });
    const { root } = await drawn(preview);
    const options = [...(field(root, "country")?.querySelectorAll("option") ?? [])].map((option) => option.textContent?.trim());
    expect(options).toEqual(["Select…"]);
  });

  it("evaluates a rule reading today() on the day it is given, and on none without one", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [{ id: "soon", type: "text", configuration: { label: "Soon" }, rules: { visibleWhen: 'today() < "2027-01-01"' } }]
      }
    } as unknown as ComponentNode;
    expect(new BuilderPreviewRuntime(root, { today: "2026-10-07" }).effectiveStatesMap().get("soon")?.visible).toBe(true);
    expect(new BuilderPreviewRuntime(root, { today: "2028-01-01" }).effectiveStatesMap().get("soon")?.visible).toBe(false);
  });
});
