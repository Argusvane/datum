import { describe, expect, it } from "vitest";

import { buildRenderOutput, hasRenderModeAdapter } from "../form-engine/render/core/render-orchestrator.js";
import { registerPdfRenderMode } from "../form-engine/render/pdf/pdf-render-mode.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { FormError } from "../form-engine/core/errors/form-error.js";
import { journeyPageFormIds, type Journey } from "../form-engine/core/schema/journey.js";
import type { JourneyView } from "../form-engine/core/journey/journey-types.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";

const resolver: DataSourceResolver = {
  resolveDataSource: async ({ componentId }) => {
    if (componentId === "country") {
      return { items: [{ value: "CA", label: "Canada" }] };
    }
    return undefined;
  }
};

function state(): FormState {
  return {
    values: { country: "CA", notes: "hello" },
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    locale: "en-CA",
    navigation: {
      mode: "wizard",
      currentStepId: "step1",
      visitedSteps: new Set(["step1"]),
      completedSteps: new Set(["step1"])
    }
  };
}

function root() {
  return {
    id: "root",
    type: "container",
    configuration: {},
    children: {
      children: [
        {
          id: "step1",
          type: "step",
          configuration: {},
          children: {
            children: [
              {
                id: "country",
                type: "select",
                configuration: { data: { sourceId: "countries" } }
              }
            ]
          }
        },
        {
          id: "notes",
          type: "text",
          configuration: {}
        }
      ]
    }
  };
}

describe("render orchestrator", () => {
  it("builds interactive output", async () => {
    const output = await buildRenderOutput({
      mode: "interactive",
      root: root(),
      state: state(),
      resolver
    });

    expect(output.mode).toBe("interactive");
    expect(output.components.some((component) => component.optionState.status === "ready")).toBe(
      true
    );
  });

  it("builds readonly output", async () => {
    const output = await buildRenderOutput({
      mode: "readonly",
      root: root(),
      state: state(),
      resolver
    });

    expect(output.mode).toBe("readonly");
    expect(output.components.every((component) => component.readOnly)).toBe(true);
  });

  it("resolves a host catalog entry for a label's address over the definition's own translation", async () => {
    const tree = {
      id: "root",
      type: "container",
      configuration: {},
      children: {
        children: [{ id: "notes", type: "text", configuration: { label: "Notes" } }]
      }
    };

    const output = await buildRenderOutput({
      mode: "interactive",
      root: tree,
      state: state(),
      resolver,
      translations: { en: { components: { notes: { label: { text: "Notes (map)", source: "x" } } } } },
      translationCatalog: { en: { components: { notes: { label: "Notes (catalog)" } } } }
    });

    const notesModel = output.components.find((component) => component.id === "notes");
    expect(notesModel?.label).toBe("Notes (catalog)");
  });

  it("builds the PDF document model for mode pdf once the pipeline has registered its adapter", async () => {
    const request = { mode: "pdf" as const, root: root(), state: state(), resolver };
    // The orchestrator does not carry the PDF model builder: until the pipeline registers the
    // mode, asking for it says so rather than rendering nothing.
    if (!hasRenderModeAdapter("pdf")) {
      await expect(buildRenderOutput(request)).rejects.toThrow(/PDF pipeline/);
    }
    registerPdfRenderMode();
    registerPdfRenderMode(); // idempotent
    expect(hasRenderModeAdapter("pdf")).toBe(true);
    const output = await buildRenderOutput(request);
    expect(output.mode).toBe("pdf");
    if (output.mode !== "pdf") {
      return;
    }
    expect(output.layoutKind).toBe("derived");
    expect(output.document?.blocks.length).toBeGreaterThan(0);
    expect(output.meta.textDirection).toBe("ltr");
  });

  it("throws for a render mode it does not know, the retired wizard mode among them", async () => {
    for (const mode of ["hologram", "wizard"]) {
      await expect(
        buildRenderOutput({
          mode: mode as unknown as "pdf",
          root: root(),
          state: state(),
          resolver
        })
      ).rejects.toThrow(/not implemented/);
    }
  });
});

describe("render orchestrator — a journey page's errors", () => {
  /** Two pages over the fixture: the step (and the select inside it) first, the notes second. */
  const JOURNEY: Journey = {
    id: "j",
    pages: [
      { id: "first", title: "First", components: ["step1"] },
      { id: "second", components: ["notes"] }
    ]
  };

  function view(pageId: "first" | "second"): JourneyView {
    const index = pageId === "first" ? 0 : 1;
    return {
      journeyId: "j",
      journey: JOURNEY,
      pageId,
      page: JOURNEY.pages[index]!,
      kind: "questions",
      path: ["first", "second"],
      index,
      total: 2,
      number: index + 1,
      completed: index === 0 ? [] : ["first"],
      frontierPageId: pageId,
      ...(index > 0 ? { backPageId: "first" } : {}),
      final: index === 1,
      end: "end",
      members: journeyPageFormIds(JOURNEY.pages[index]!),
      pageOf: { step1: "first", country: "first", notes: "second" },
      validation: { continue: "page", server: false, onUnavailable: "block" }
    };
  }

  const errors = [
    { code: "required", componentId: "notes", message: "Add a note", stage: "field", source: "client" },
    { code: "required", componentId: "country", message: "Pick a country", stage: "field", source: "client" },
    { code: "server", componentId: "elsewhere", message: "The server says no", stage: "server", source: "server" },
    { code: "form", message: "The form could not be sent", stage: "form", source: "client" }
  ] as unknown as FormError[];

  async function render(pageId: "first" | "second" | undefined, mode: "interactive" | "readonly" = "interactive") {
    return buildRenderOutput({
      mode,
      root: root(),
      state: state(),
      resolver,
      errors,
      componentTree: new ComponentTree(root()),
      ...(pageId ? { journey: view(pageId) } : {})
    });
  }

  it("keeps errors on the page's components, descendants included, and lists the rest as the form's", async () => {
    const output = await render("first");
    expect(output.meta.errorSummary.byComponent).toEqual({ country: 1 });
    expect(output.meta.errorSummary.formErrors.map((error) => error.code)).toEqual(["required", "server", "form"]);
    expect(output.meta.errorSummary.formErrors[0]?.componentId).toBe("notes");
    // Every error still counts: the summary heading says four, and takes focus when nothing on the page can.
    expect(output.meta.errorSummary.total).toBe(4);
    expect(output.meta.firstErrorFocus?.componentId).toBe("country");
    // Each component's own errors stay on its model, for the page that draws it.
    expect(output.components.find((model) => model.id === "notes")?.errors).toHaveLength(1);
  });

  it("has nothing on the page to focus when every error is elsewhere, so the summary takes it", async () => {
    const output = await render("second");
    expect(output.meta.errorSummary.byComponent).toEqual({ notes: 1 });
    const offPage = await buildRenderOutput({
      mode: "interactive",
      root: root(),
      state: state(),
      resolver,
      errors: errors.filter((error) => error.componentId !== "notes"),
      componentTree: new ComponentTree(root()),
      journey: view("second")
    });
    expect(offPage.meta.errorSummary.byComponent).toEqual({});
    expect(offPage.meta.errorSummary.total).toBe(3);
    expect(offPage.meta.firstErrorFocus).toBeUndefined();
  });

  it("carries the page it drew, and ignores the journey outside a live form", async () => {
    const live = await render("second");
    // No title, and a question with no label: the page has no heading, never its id.
    expect(live.meta.journey).toMatchObject({ journeyId: "j", pageId: "second", title: "", backPageId: "first", final: true, members: ["notes"] });
    const review = await render("second", "readonly");
    expect("journey" in review.meta).toBe(false);
    expect(review.meta.errorSummary.byComponent).toEqual({ notes: 1, country: 1, elsewhere: 1 });
    const whole = await render(undefined);
    expect(whole.meta.errorSummary.formErrors.map((error) => error.code)).toEqual(["form"]);
    expect(whole.meta.firstErrorFocus?.componentId).toBe("notes");
  });
});

describe("render orchestrator — a presentation's nodes", () => {
  const presentationState = (values: Record<string, unknown>): FormState => ({ ...state(), values, navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() } });
  const own = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [{ id: "total", type: "number", configuration: { label: "Total" } }],
      "@presentation": [
        {
          id: "@p",
          type: "container",
          configuration: {},
          children: {
            content: [
              { id: "alias", type: "text", configuration: { label: "Alias" } },
              { id: "copy", type: "number", configuration: { label: "Total", readOnly: true, presentation: { kind: "worked-out", to: "total" } } },
              { id: "mine", type: "text", configuration: { label: "Mine" } }
            ]
          }
        }
      ]
    }
  };

  it("takes value-path overrides and worked-out copies: the model reads there and the copy is read-only whatever its state says", async () => {
    const output = await buildRenderOutput({
      mode: "interactive",
      root: own,
      state: presentationState({ total: 12, "@p.mine": "kept", "@p.alias": "never read" }),
      resolver,
      // The copy's state says editable (the form field's): it is drawn read-only all the same.
      effectiveStates: new Map([["copy", { visible: true, disabled: false, readonly: false } as never]]),
      valuePathOverrides: new Map([
        ["alias", "total"],
        ["copy", "total"]
      ]),
      workedOutComponents: new Set(["copy"])
    });
    const byId = new Map(output.components.map((model) => [model.id, model]));
    expect(byId.get("alias")).toMatchObject({ valuePath: "total", value: 12, readOnly: false });
    expect(byId.get("alias")?.workedOut).toBeUndefined();
    expect(byId.get("copy")).toMatchObject({ valuePath: "total", value: 12, readOnly: true, workedOut: true });
    expect(byId.get("copy")?.accessibility).toMatchObject({ readonly: true, ariaDescribedBy: ["copy__worked-out"] });
    // Without an override a node's path is the tree's: an own field under its `@` container.
    expect(byId.get("mine")).toMatchObject({ valuePath: "@p.mine", value: "kept" });
    // A review is built without them: every path is the tree's.
    const review = await buildRenderOutput({ mode: "readonly", root: own, state: presentationState({ total: 12 }), resolver });
    expect(review.components.find((model) => model.id === "alias")?.valuePath).toBe("@p.alias");
  });

  it("shows a form field's errors on the node standing for it on the page, once per code, in a live page only", async () => {
    const JOURNEY: Journey = { id: "p", pages: [{ id: "one", components: [] }] };
    const hosted: JourneyView = {
      journeyId: "p",
      journey: JOURNEY,
      pageId: "one",
      page: JOURNEY.pages[0]!,
      kind: "questions",
      path: ["one"],
      index: 0,
      total: 1,
      number: 1,
      completed: [],
      frontierPageId: "one",
      final: true,
      end: "end",
      members: ["alias", "copy"],
      pageOf: {},
      validation: { continue: "page", server: false, onUnavailable: "block" },
      hosts: { total: "copy", elsewhere: "alias" }
    };
    const pageErrors = [
      { id: "1", code: "required", componentId: "total", stage: "field", source: "client" },
      { id: "2", code: "required", componentId: "copy", stage: "presentation-fields", source: "client" },
      { id: "3", code: "max", componentId: "total", stage: "plugin", source: "custom" },
      { id: "4", code: "server", componentId: "elsewhere", stage: "server", source: "server" }
    ] as unknown as FormError[];
    const output = await buildRenderOutput({
      mode: "interactive",
      root: own,
      state: presentationState({}),
      resolver,
      errors: pageErrors,
      componentTree: new ComponentTree(own),
      journey: hosted
    });
    expect(output.components.find((model) => model.id === "copy")?.errors.map((error) => error.code)).toEqual(["required", "max"]);
    expect(output.components.find((model) => model.id === "total")?.errors).toEqual([]);
    expect(output.meta.errorSummary).toMatchObject({ total: 3, byComponent: { copy: 2, alias: 1 }, formErrors: [] });
    // In the page's drawn order: the alias stands first.
    expect(output.meta.firstErrorFocus?.componentId).toBe("alias");

    // A review draws the form: each error stays on the field it is about.
    const review = await buildRenderOutput({ mode: "readonly", root: own, state: presentationState({}), resolver, errors: pageErrors, journey: hosted });
    expect(review.meta.errorSummary.byComponent).toEqual({ total: 2, copy: 1, elsewhere: 1 });
  });
});
