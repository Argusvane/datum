import { describe, expect, it } from "vitest";

import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import { buildRuntimeRenderOutput, type RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import { registerPdfRenderMode } from "../form-engine/render/pdf/pdf-render-mode.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { defineDataSources } from "../form-engine/data/host/data-source-set.js";
import { presentationForm } from "./fixtures/presentation-form.js";

function fixture(locale: string): { runtime: RenderableRuntime; state: FormState } {
  const form: ComponentNode = {
    id: "intake",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [{ id: "name", type: "text", configuration: { label: "Name" } }]
    }
  };
  const state: FormState = {
    values: { name: "Ada" },
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale
  };
  const runtime: RenderableRuntime = {
    formRoot: () => form,
    state: () => state,
    errors: () => [],
    effectiveStatesMap: () => new Map(),
    requiredMap: () => new Map(),
    componentTree: () => new ComponentTree(form),
    resolveDataSource: async () => undefined,
    // The definition's own translations: the French for the label.
    translations: () => ({ fr: { components: { name: { label: { text: "Nom", source: "x" } } } } })
  };
  return { runtime, state };
}

function labelOf(output: Awaited<ReturnType<typeof buildRuntimeRenderOutput>>, id: string): string | undefined {
  return output.mode === "readonly" ? output.components.find((component) => component.id === id)?.label : undefined;
}

describe("buildRuntimeRenderOutput — locale", () => {
  it("renders in the runtime's locale unless one is asked for, and never writes the runtime's state", async () => {
    const { runtime, state } = fixture("en");

    const own = await buildRuntimeRenderOutput(runtime, "readonly");
    expect(labelOf(own, "name")).toBe("Name");
    expect(own.meta.textDirection).toBe("ltr");

    const french = await buildRuntimeRenderOutput(runtime, "readonly", { locale: "fr" });
    expect(labelOf(french, "name")).toBe("Nom");
    expect(state.locale).toBe("en");

    // Text direction follows the locale rendered, not the one the form is in.
    const arabic = await buildRuntimeRenderOutput(runtime, "readonly", { locale: "ar" });
    expect(arabic.meta.textDirection).toBe("rtl");
  });

  it("reads focusFirstError from the runtime's accessibility block, beneath the host's own errorPresentation", async () => {
    const { runtime } = fixture("en");
    const without = await buildRuntimeRenderOutput(runtime, "interactive");
    expect(without.meta.presentation.focusFirstError).toBe(true);

    const off = { ...runtime, accessibility: () => ({ focusFirstError: false }) };
    expect((await buildRuntimeRenderOutput(off, "interactive")).meta.presentation.focusFirstError).toBe(false);

    const host = { showComponentErrors: true, showErrorSummary: true, focusFirstError: true };
    expect((await buildRuntimeRenderOutput(off, "interactive", { errorPresentation: host })).meta.presentation.focusFirstError).toBe(true);

    // Anything but a boolean is not a setting.
    const odd = { ...runtime, accessibility: () => ({ focusFirstError: "false" as unknown as boolean }) };
    expect((await buildRuntimeRenderOutput(odd, "interactive")).meta.presentation.focusFirstError).toBe(true);
  });

  it("asking for the locale the form is already in changes nothing", async () => {
    const { runtime } = fixture("fr");
    const output = await buildRuntimeRenderOutput(runtime, "readonly", { locale: "fr" });
    expect(labelOf(output, "name")).toBe("Nom");
  });
});

describe("buildRuntimeRenderOutput — a presentation's own nodes", () => {
  function runtimeFor(journeyId: string | undefined, dataSources?: FormRuntimeDependencies["dataSources"]): FormRuntime {
    const definition = presentationForm();
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
      ...(dataSources ? { dataSources } : {})
    });
    if (journeyId === undefined) {
      runtime.leaveJourney();
    } else {
      runtime.startJourney(journeyId);
    }
    return runtime;
  }

  /** Every id a render output's models carry. */
  const ids = (output: { components?: unknown }): string[] =>
    Array.isArray(output.components) ? (output.components as Array<{ id: string }>).map((model) => model.id) : [];
  const OWN = ["work_email", "m1", "m2", "m3", "income_total", "contact", "public_note"];

  it("draws a live page from the combined root, and the whole form, a review, a printed copy and a PDF from the form's alone", async () => {
    const runtime = runtimeFor("apply");
    runtime.setValue("email", "ada@example.org");
    runtime.setValue("@apply.m1", 40000);
    const live = await buildRuntimeRenderOutput(runtime, "interactive");
    expect(ids(live)).toEqual(expect.arrayContaining(["work_email", "m1", "income_total", "@apply"]));

    // A review (and so a printed copy, which is the review's rendition) and a PDF: the form alone.
    const review = await buildRuntimeRenderOutput(runtime, "readonly");
    expect(ids(review)).toEqual(["form", "email", "name", "money", "annual_income", "approved_amount"]);
    registerPdfRenderMode();
    const pdf = await buildRuntimeRenderOutput(runtime, "pdf");
    const printed = JSON.stringify(pdf);
    for (const id of [...OWN, "@apply", "journey-field", "Work email", "Month 1"]) {
      expect(printed, id).not.toContain(id);
    }
    expect(printed).toContain("annual_income");
    expect(Object.keys(pdf.meta.containersById)).not.toContain("@apply");

    // The whole form, with no journey running.
    const whole = await buildRuntimeRenderOutput(runtimeFor(undefined), "interactive");
    expect(ids(whole)).toEqual(["form", "email", "name", "money", "annual_income", "approved_amount"]);
    expect("journey" in whole.meta).toBe(false);
  });

  it("prints no own answer in a PDF — a template's path, text and expression, a generated layout's text — while the live page still reads it", async () => {
    const runtime = runtimeFor("apply");
    runtime.setValue("email", "ada@example.org");
    runtime.setValue("@apply.m1", 41234);
    registerPdfRenderMode();
    const template = {
      id: "t",
      kind: "template",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
      fields: [
        { pdfField: "ByPath", source: { kind: "path", path: "@apply.m1" } },
        { pdfField: "ByText", source: { kind: "template", text: "{{@apply.m1}}" } },
        { pdfField: "ByExpr", source: { kind: "expression", expression: { kind: "path", path: "@apply.m1" } } },
        { pdfField: "Email", source: { kind: "path", path: "email" } }
      ]
    };
    const filled = await buildRuntimeRenderOutput(runtime, "pdf", { pdf: { layout: template as never } });
    const fill = JSON.stringify((filled as { fill?: unknown }).fill);
    expect(fill).not.toContain("41234");
    // The form's answers print as ever.
    expect(fill).toContain("ada@example.org");
    const generated = {
      id: "g",
      kind: "generated",
      name: "Letter",
      root: {
        id: "document",
        type: "pdf-document",
        configuration: {},
        children: { body: [{ id: "t", type: "pdf-text", configuration: { text: "Month one: {{@apply.m1}}; email: {{email}}" } }] }
      }
    };
    const letter = JSON.stringify(((await buildRuntimeRenderOutput(runtime, "pdf", { pdf: { layout: generated as never } })) as { document?: unknown }).document);
    expect(letter).not.toContain("41234");
    expect(letter).toContain("email: ada@example.org");
    // The page being filled in is where the answer lives.
    await runtime.nextPage();
    const live = await buildRuntimeRenderOutput(runtime, "interactive");
    expect(live.components.find((model) => model.id === "m1")?.value).toBe(41234);
  });

  it("shows an alias's error on the form field it fills in a review, once, and no other own node's", async () => {
    const definition = presentationForm();
    const income = definition.journey!.journeys![0]!.pages[1]!;
    (income.components![0] as { configuration: Record<string, unknown> }).configuration.required = true;
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)])
    });
    runtime.startJourney("apply");
    const result = await runtime.submit("submit", {
      form: { id: "presentation", version: "1.0.0" },
      client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1.0.0" }
    });
    expect(result.accepted).toBe(false);
    expect(runtime.errors().map((error) => `${error.componentId}:${error.code}`).sort()).toEqual([
      "annual_income:required",
      "email:required",
      "m1:required",
      "work_email:required"
    ]);
    const review = await buildRuntimeRenderOutput(runtime, "readonly");
    expect(review.meta.errorSummary).toMatchObject({ total: 2, byComponent: { email: 1, annual_income: 1 }, formErrors: [] });
    expect(review.components.find((model) => model.id === "email")?.errors.map((error) => error.code)).toEqual(["required"]);
    const summarised = review.meta.errorSummary.entries.map((entry) => entry.componentId);
    for (const id of ["m1", "work_email"]) {
      expect(summarised, id).not.toContain(id);
    }
    expect(summarised).toContain("email");
    // The live page keeps them where it draws them: the blocked submit opened the alias's page.
    expect(runtime.journeyView()?.pageId).toBe("details");
    const live = await buildRuntimeRenderOutput(runtime, "interactive");
    expect(live.meta.errorSummary.byComponent).toMatchObject({ work_email: 1 });
  });

  it("puts a form field's errors under the alias standing for it, once, with the summary's link and first focus on it", async () => {
    const runtime = runtimeFor("apply");
    expect(await runtime.nextPage()).toMatchObject({ ok: false, reason: "validation" });
    // The form field's Required and the alias's own, both `required`.
    expect(runtime.errors().map((error) => `${error.componentId}:${error.code}`).sort()).toEqual(["email:required", "work_email:required"]);
    const output = await buildRuntimeRenderOutput(runtime, "interactive");
    expect(output.meta.errorSummary).toMatchObject({ total: 1, byComponent: { work_email: 1 }, formErrors: [] });
    expect(output.meta.firstErrorFocus?.componentId).toBe("work_email");
    expect(output.meta.errorSummary.entries.map((entry) => entry.componentId)).toEqual(["work_email"]);
    expect(output.components.find((model) => model.id === "work_email")?.errors).toHaveLength(1);
  });

  it("puts a worked-out field's errors under its copy", async () => {
    const runtime = runtimeFor("apply");
    runtime.setValue("email", "ada@example.org");
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    // The page is the last on the path while nothing routes on: its check is the submit's.
    await runtime.submit("submit", {
      form: { id: "presentation", version: "1.0.0" },
      client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1.0.0" }
    });
    expect(runtime.journeyView()?.pageId).toBe("income");
    expect(runtime.errors().map((error) => `${error.componentId}:${error.code}`)).toEqual(["annual_income:required"]);
    const output = await buildRuntimeRenderOutput(runtime, "interactive");
    expect(output.meta.errorSummary.byComponent).toEqual({ income_total: 1 });
    expect(output.components.find((model) => model.id === "income_total")?.errors.map((error) => error.code)).toEqual(["required"]);
  });

  it("hands a host's data source the form's values, never a presentation's own answers, and asks it for form fields and worked-out copies alone", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const definition = presentationForm();
    const variant = definition.journey!.journeys![1]!;
    definition.root.children!.content!.push(
      { id: "topic", type: "select", configuration: { label: "Topic", data: { sourceId: "topics" } } },
      { id: "shelf", type: "select", configuration: { label: "Shelf", data: { sourceId: "topics" } } }
    );
    variant.pages[0]!.components!.push(
      "topic",
      { id: "nickname", type: "text", configuration: { label: "Nickname" } },
      // An own field naming a source draws its inline options alone (a v1 limit): the host's set is not asked for it.
      { id: "own_topic", type: "select", configuration: { label: "Own topic", data: { sourceId: "topics" }, options: [{ value: "z", label: "Zed" }] } },
      // A worked-out value's copy is drawn with its form field's options, from the host's set.
      { id: "shelf_copy", type: "journey-value", configuration: { to: "shelf", value: { kind: "path", path: "nickname" } } }
    );
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
    runtime.startJourney("public");
    runtime.setValue("name", "Ada");
    runtime.setValue("@public.nickname", "Addy");
    const topics = defineDataSources({
      topics: async (_request, context) => {
        contexts.push(context.values ?? {});
        return [{ value: "a", label: "Alpha" }];
      }
    });
    const output = await buildRuntimeRenderOutput(runtime, "interactive", { dataSources: topics });
    expect(output.components.find((model) => model.id === "topic")?.optionState).toMatchObject({ status: "ready" });
    expect(output.components.find((model) => model.id === "shelf_copy")?.optionState).toMatchObject({ status: "ready", items: [{ value: "a", label: "Alpha" }] });
    expect(output.components.find((model) => model.id === "own_topic")?.optionState).toMatchObject({ status: "ready", items: [{ value: "z", label: "Zed" }] });
    expect(contexts.length).toBeGreaterThan(0);
    for (const values of contexts) {
      expect(values).toMatchObject({ name: "Ada" });
      expect(Object.keys(values).some((key) => key.startsWith("@"))).toBe(false);
    }
  });
});

describe("buildRuntimeRenderOutput — a worked-out copy's texts", () => {
  /** The form with a choice field `shelf`, French words for it, and a journey page that copies it, under the target's label or (with `ownLabel`) its own. */
  function copyRuntime(ownLabel?: string): FormRuntime {
    const definition = presentationForm();
    (definition.root.children!.content as ComponentNode[]).push({
      id: "shelf",
      type: "select",
      configuration: { label: "Shelf", description: "Pick one", options: [{ value: "a", label: "Alpha" }] }
    });
    definition.translations = {
      fr: {
        components: {
          shelf: {
            label: { text: "Étagère", source: "x" },
            description: { text: "Choisissez", source: "x" },
            options: { a: { label: { text: "Alpha FR", source: "x" } } }
          },
          shelf_copy: { label: { text: "Mon étagère", source: "x" } }
        }
      }
    } as never;
    const copy = (id: string, label?: string) => ({
      id,
      type: "journey-value" as const,
      configuration: { to: "shelf", value: { kind: "literal", value: "a" }, ...(label !== undefined ? { label } : {}) }
    });
    definition.journey!.journeys![0]!.pages[1]!.components!.push((ownLabel !== undefined ? copy("shelf_copy", ownLabel) : copy("shelf_copy")) as never);
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)])
    });
    runtime.startJourney("apply");
    return runtime;
  }

  async function modelsOf(runtime: FormRuntime) {
    runtime.setLocale("fr");
    runtime.setValue("email", "ada@example.org");
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    const output = await buildRuntimeRenderOutput(runtime, "interactive");
    return (id: string) => output.components.find((component) => component.id === id) as { label?: string; description?: string; optionState?: { items: Array<{ label: string }> } } | undefined;
  }

  it("words the inherited label, description and options at the target's address", async () => {
    const model = await modelsOf(copyRuntime());
    expect(model("shelf_copy")?.label).toBe("Étagère");
    expect(model("shelf_copy")?.description).toBe("Choisissez");
    expect(model("shelf_copy")?.optionState?.items.map((item) => item.label)).toEqual(["Alpha FR"]);
  });

  it("words a label the node authors at its own address, and the rest at the target's", async () => {
    const model = await modelsOf(copyRuntime("My shelf"));
    expect(model("shelf_copy")?.label).toBe("Mon étagère");
    expect(model("shelf_copy")?.description).toBe("Choisissez");
    expect(model("shelf_copy")?.optionState?.items.map((item) => item.label)).toEqual(["Alpha FR"]);
  });
});
