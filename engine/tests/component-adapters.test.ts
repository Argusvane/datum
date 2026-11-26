// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import { componentAdapterProblem, componentDrawingOf, isComponentAdapter, withComponentDrawing } from "../form-engine/plugins/component-adapters.js";
import { createDatumBinding } from "../form-engine/render/live/datum/options.js";
import type { FieldAdapter, FieldState } from "../form-engine/render/live/contract.js";
import { html, lit } from "../form-engine/render/live/lit.js";
import { defineDatumFormRendererElement, DATUM_FORM_RENDERER_TAG, type DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/*
 * A host's or a plugin's own component type is drawn by its definition's adapter:
 * `ComponentDefinition.adapter` laid over the binding the form is drawn with, its `css` after the
 * binding's rules. The form element reads the definitions from its runtime's component registry.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | null | undefined | false, tries = 200): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = read();
    if (value) {
      return value;
    }
    await wait(5);
  }
  throw new Error("never became true");
}

/** Stars as buttons: each press answers the field with its number. */
const ratingAdapter: FieldAdapter = {
  kind: "field",
  name: "test-rating",
  template: (state: FieldState, on) => {
    const selected = Number(state.answer) || 0;
    return html`<div class="rating" role="group" aria-labelledby=${state.labelId}>
      <span id=${state.labelId}>${state.label}</span>
      ${[1, 2, 3].map((value) => html`<button type="button" class=${value <= selected ? "rating__star is-on" : "rating__star"} @click=${() => on.input(value)}>${value}</button>`)}
    </div>`;
  }
};

function ratingDefinition(extra: Partial<ComponentDefinition> = {}): ComponentDefinition {
  return {
    type: "rating",
    version: "1.0.0",
    createDefault: () => ({ id: "rating", type: "rating", configuration: { label: "Rating" } }),
    capabilities: [],
    adapter: ratingAdapter,
    ...extra
  };
}

describe("componentDrawingOf", () => {
  it("takes each definition's adapter by type and its stylesheets in order", () => {
    const drawing = componentDrawingOf([ratingDefinition({ css: [".rating { gap: 1px; }"] }), { ...ratingDefinition(), type: "plain", adapter: undefined, css: [".plain {}"] }]);
    expect(Object.keys(drawing.adapters)).toEqual(["rating"]);
    expect(drawing.adapters.rating).toBe(ratingAdapter);
    expect(drawing.css).toEqual([".rating { gap: 1px; }", ".plain {}"]);
  });

  it("leaves out an adapter of another shape and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bad = { ...ratingDefinition(), type: "bad-shape", adapter: "<b>string</b>" as unknown };
    const drawing = componentDrawingOf([bad, bad]);
    expect(drawing.adapters).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('Component "bad-shape" is not drawn by its definition');
  });

  it("calls an adapter factory with the host's lit and Datum binding, and leaves it out without them", () => {
    const datum = createDatumBinding();
    const seen: unknown[] = [];
    const factory = (given: typeof lit, base: typeof datum) => {
      seen.push(given, base);
      return ratingAdapter;
    };
    expect(componentDrawingOf([ratingDefinition({ adapter: factory })]).adapters).toEqual({});
    const drawing = componentDrawingOf([ratingDefinition({ adapter: factory })], { lit, datum });
    expect(drawing.adapters.rating).toBe(ratingAdapter);
    expect(seen).toEqual([lit, datum]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const throwing = componentDrawingOf([{ ...ratingDefinition(), type: "throws", adapter: () => { throw new Error("no lit here"); } }], { lit, datum });
    expect(throwing.adapters).toEqual({});
    expect(String(warn.mock.calls[0]?.[0])).toContain("its adapter factory threw (no lit here)");
  });

  it("names what is wrong with an adapter", () => {
    expect(componentAdapterProblem(undefined)).toBeUndefined();
    expect(componentAdapterProblem(ratingAdapter)).toBeUndefined();
    expect(componentAdapterProblem([ratingAdapter, { ...ratingAdapter, when: () => true }])).toBeUndefined();
    expect(componentAdapterProblem([])).toBe("adapter must not be an empty list");
    expect(componentAdapterProblem([ratingAdapter, { kind: "field" }])).toMatch(/^adapter\[1\] must be an adapter/);
    expect(componentAdapterProblem({ kind: "widget", template: () => html`` })).toMatch(/^adapter must be an adapter/);
    expect(isComponentAdapter({ kind: "group", template: () => html`` })).toBe(true);
  });
});

describe("withComponentDrawing", () => {
  it("lays the adapters over the binding's own, keeps the binding's id, and adds the stylesheets after its css", () => {
    const binding = createDatumBinding();
    const own = createDatumBinding().components.text;
    const drawing = componentDrawingOf([ratingDefinition({ css: [".rating {}"] }), { ...ratingDefinition(), type: "text", adapter: ratingAdapter }]);
    const laid = withComponentDrawing(binding, drawing);
    expect(laid.id).toBe(binding.id);
    expect(laid.components.rating).toBe(ratingAdapter);
    expect(laid.components.text).toBe(ratingAdapter);
    expect(own).not.toBe(ratingAdapter);
    expect(laid.css?.endsWith(".rating {}")).toBe(true);
    expect(laid.css?.startsWith(binding.css ?? "")).toBe(true);
    // The same object for the same pair; the stylesheets left out on request.
    expect(withComponentDrawing(binding, drawing)).toBe(laid);
    const adaptersOnly = withComponentDrawing(binding, drawing, { css: false });
    expect(adaptersOnly.css).toBe(binding.css);
    expect(adaptersOnly.components.rating).toBe(ratingAdapter);
  });

  it("is the binding itself when the drawing adds nothing", () => {
    const binding = createDatumBinding();
    expect(withComponentDrawing(binding, undefined)).toBe(binding);
    expect(withComponentDrawing(binding, componentDrawingOf([]))).toBe(binding);
  });
});

describe("the builder controller's drawing of its definitions", () => {
  it("is the definitions' adapters, the same object until the definitions change", async () => {
    const { BuilderController } = await import("../form-engine/builder/controller/builder-controller.js");
    const form: ComponentDefinition = { type: "form", version: "1.0.0", createDefault: () => ({ id: "root", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } } as ComponentDefinition;
    const ctrl = new BuilderController({ componentDefinitions: [form, ratingDefinition()] });
    const drawing = ctrl.componentDrawing();
    expect(drawing?.adapters.rating).toBe(ratingAdapter);
    expect(ctrl.componentDrawing()).toBe(drawing);
    ctrl.setOptions({ componentDefinitions: [form] });
    expect(ctrl.componentDrawing()).toBeUndefined();
  });
});

describe("<datum-form-renderer> draws the runtime's own component types", () => {
  function runtimeWith(definitions: ComponentDefinition[]): FormRuntime {
    const definition = {
      id: "rated",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: { content: [{ id: "stars", type: "rating", configuration: { label: "How was it?" } }] }
      }
    } as FormDefinition;
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const componentRegistry = new ComponentRegistry();
    for (const entry of definitions) {
      componentRegistry.register(entry);
    }
    return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]), componentRegistry });
  }

  function mount(runtime: FormRuntime): DatumFormRendererElement {
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    element.runtime = runtime;
    document.body.append(element);
    return element;
  }

  it("draws a host type with its definition's adapter, and the adapter's writes answer the field", async () => {
    const runtime = runtimeWith([ratingDefinition({ css: [".rating__star.is-on { font-weight: bold; }"] })]);
    const element = mount(runtime);
    const stars = await until(() => {
      const found = element.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-component-id="stars"] .rating__star');
      return found && found.length === 3 ? found : undefined;
    });
    expect(element.shadowRoot?.querySelector('[data-component-id="stars"] [role="note"]')).toBeNull();
    expect(element.shadowRoot?.querySelector('[data-component-id="stars"]')?.getAttribute("data-kind")).toBe("rating");
    expect(element.live?.adapterOf("stars")?.name).toBe("test-rating");
    expect(element.drawnBinding.id).toBe("datum");
    stars[1]?.click();
    expect(runtime.state().values.stars).toBe(2);
    await until(() => element.shadowRoot?.querySelectorAll(".rating__star.is-on").length === 2);
  });

  it("shows the unknown-component note for a type its definition gives no adapter", async () => {
    const element = mount(runtimeWith([ratingDefinition({ adapter: undefined })]));
    const note = await until(() => element.shadowRoot?.querySelector('[data-component-id="stars"] [role="note"]'));
    expect(note.textContent).toContain("rating");
  });
});
