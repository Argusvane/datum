// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { foldPresentation, type PresentationField } from "../form-engine/render/core/presentation-tree.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { extendBinding, type FieldAdapter, type GroupAdapter } from "../form-engine/render/live/contract.js";
import { renderFieldPreview } from "../form-engine/render/live/field-preview.js";
import { html } from "../form-engine/render/live/lit.js";
import { createDatumBinding } from "../form-engine/render/live/renderer.js";

/**
 * One field drawn on its own: `renderFieldPreview(node, locale)` over a field of the
 * presentation fold, the PDF designer's picture of a bound component, drawn read-only by the
 * binding's adapter into a detached element.
 */

function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Full name", description: "As on your passport", required: true } },
        { id: "agree", type: "checkbox", configuration: { label: "I agree" } },
        { id: "colour", type: "radio", configuration: { label: "Colour", options: [{ value: "r", label: "Red" }, { value: "g", label: "Green" }] } },
        { id: "born", type: "date", configuration: { label: "Born" } },
        { id: "stars", type: "x-rating", configuration: { label: "Rating" } }
      ]
    }
  } as ComponentNode;
}

/** The form's fields as the presentation fold has them, by component id: what the PDF designer previews. */
async function models(values: Record<string, unknown>, kinds?: Record<string, string>): Promise<Map<string, PresentationField>> {
  const runtime = new BuilderPreviewRuntime(form(), {});
  for (const [path, value] of Object.entries(values)) {
    runtime.setValue(path, value);
  }
  const output = await buildRuntimeRenderOutput(runtime, "readonly", {});
  const tree = foldPresentation(output, { locale: "en", includeHidden: true, ...(kinds !== undefined ? { kinds } : {}) });
  return new Map(tree.fields.map((field) => [field.model.id, field]));
}

describe("renderFieldPreview", () => {
  it("draws a field read-only through Datum's adapter, inert, with the state hooks and none of the DOM contract", async () => {
    const byId = await models({ name: "Ada" });
    const preview = renderFieldPreview(byId.get("name")!, "en");
    expect(preview.isConnected).toBe(false);
    expect(preview.hasAttribute("inert")).toBe(true);
    const input = preview.querySelector("input");
    expect(input?.value).toBe("Ada");
    expect(input?.readOnly).toBe(true);
    expect(preview.textContent).toContain("Full name");
    expect(preview.textContent).toContain("As on your passport");
    const wrapper = preview.querySelector(".datum-live-field");
    expect(wrapper?.getAttribute("data-kind")).toBe("text");
    expect(wrapper?.hasAttribute("data-required")).toBe(true);
    expect(wrapper?.hasAttribute("data-readonly")).toBe(true);
    expect(preview.querySelector("[data-component-id], [data-value-path], [data-instance]")).toBeNull();
    // No error is shown on a picture.
    expect(preview.querySelector("[aria-invalid='true']")).toBeNull();
  });

  it("draws a choice and a lone checkbox as answered, and a date in its parts", async () => {
    const byId = await models({ agree: true, colour: "g", born: "1990-04-02" });
    expect(renderFieldPreview(byId.get("agree")!, "en").querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    const radios = [...renderFieldPreview(byId.get("colour")!, "en").querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
    const date = renderFieldPreview(byId.get("born")!, "en");
    const parts = [...date.querySelectorAll<HTMLInputElement>("input")].map((box) => box.value);
    expect(parts).toEqual(expect.arrayContaining(["1990", "02"]));
  });

  it("draws with a binding's own adapter when given one, Datum's behind it", async () => {
    const byId = await models({ name: "Ada" });
    const own: FieldAdapter = { kind: "field", name: "own-text", template: (state) => html`<output class="own">${state.value}</output>` };
    const binding = extendBinding(createDatumBinding(), { id: "own", components: { text: own } });
    expect(renderFieldPreview(byId.get("name")!, "en", { binding }).querySelector("output.own")?.textContent).toBe("Ada");
    // A type the binding leaves to Datum is Datum's.
    expect(renderFieldPreview(byId.get("agree")!, "en", { binding }).querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it("previews a type nothing draws as its label and its answer", async () => {
    const byId = await models({ stars: "4" });
    const preview = renderFieldPreview(byId.get("stars")!, "en");
    expect(preview.querySelector(".datum-live-field")?.getAttribute("data-kind")).toBe("unknown");
    expect(preview.textContent).toContain("Rating");
    expect(preview.textContent).toContain("4");
  });

  it("draws a design system's own type as its base, because the fold read it so (the definition's kinds map)", async () => {
    const byId = await models({ stars: "4" }, { "x-rating": "text" });
    expect(byId.get("stars")).toMatchObject({ type: "x-rating", base: "text" });
    const preview = renderFieldPreview(byId.get("stars")!, "en");
    expect(preview.querySelector(".datum-live-field")?.getAttribute("data-kind")).toBe("text");
    expect(preview.querySelector("input")?.value).toBe("4");
  });

  it("falls back to the plain picture when an adapter throws", async () => {
    const byId = await models({ name: "Ada" });
    const broken: FieldAdapter = {
      kind: "field",
      template: () => {
        throw new Error("broken");
      }
    };
    const binding = extendBinding(createDatumBinding(), { components: { text: broken } });
    const preview = renderFieldPreview(byId.get("name")!, "en", { binding });
    expect(preview.textContent).toContain("Full name");
    expect(preview.textContent).toContain("Ada");
  });
});

describe("a design-time canvas's own root (the presentation fold)", () => {
  const tree = (label?: string): ComponentNode =>
    ({
      id: "sheet",
      type: "x-sheet",
      configuration: label !== undefined ? { label } : {},
      children: { body: [], header: [] }
    }) as ComponentNode;

  it("is folded as its group, unlabelled and empty, when the caller draws its type", async () => {
    const output = await buildRuntimeRenderOutput(new BuilderPreviewRuntime(tree(), {}), "readonly", {});
    const drawn = foldPresentation(output, { locale: "en", isKnownContainer: (type) => type === "x-sheet" });
    expect(drawn.nodes).toHaveLength(1);
    expect(drawn.nodes[0]).toMatchObject({ kind: "group", id: "sheet", type: "x-sheet" });
    expect((drawn.nodes[0] as { slots: Array<{ slotId: string }> }).slots.map((slot) => slot.slotId)).toEqual(["body", "header"]);
    // A form root, or a root of a type nobody draws, folds to its children as ever.
    expect(foldPresentation(output, { locale: "en" }).nodes).toEqual([]);
  });

  it("is drawn by its adapter in a mounted form", async () => {
    const face: GroupAdapter = { kind: "group", name: "sheet", template: (state) => html`<div class="sheet">${state.slots.map((slot) => html`<section data-slot=${slot.slotId}>${slot.content}</section>`)}</div>` };
    const binding = extendBinding(createDatumBinding(), { components: { "x-sheet": face } });
    const { mountLive, createDatumFeatures } = await import("../form-engine/render/live/renderer.js");
    const host = document.createElement("div");
    document.body.append(host);
    const live = mountLive(host.attachShadow({ mode: "open" }), { runtime: new BuilderPreviewRuntime(tree(), {}), binding, mode: "readonly", features: createDatumFeatures() });
    await live.ready;
    expect([...live.root.querySelectorAll("[data-container-id='sheet'] > .sheet > section")].map((section) => section.getAttribute("data-slot"))).toEqual(["body", "header"]);
    expect(live.adapterOf("sheet")).toMatchObject({ from: "binding", name: "sheet" });
    live.unmount();
    host.remove();
  });
});
