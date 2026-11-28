import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { SubmissionVersionContext } from "../form-engine/core/submission/canonical-submission.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { DraftError, type FormDraft } from "../form-engine/persistence/core/draft-store.js";
import { parseDraftFile } from "../form-engine/persistence/file-draft/draft-file.js";
import { readDraft } from "../form-engine/runtime/browser/draft-read.js";

const VERSION: SubmissionVersionContext = {
  form: { id: "f", version: "1.0.0" },
  client: { runtimeVersion: "test", rendererVersion: "test", schemaVersion: "1.0.0" }
};

const fields = [
  { id: "name", type: "text", configuration: { label: "Name" } },
  { id: "city", type: "text", configuration: { label: "City" } }
];

function build(extra: Record<string, unknown> = {}, deps: Partial<FormRuntimeDependencies> = {}): FormRuntime {
  const form = {
    id: "f",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: { id: "form", type: "form", configuration: {}, children: { content: fields } },
    ...extra
  } as unknown as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
    journeyEngine: EagerJourneyEngine,
    ...deps
  } as FormRuntimeDependencies);
}

const bilingual = { localization: { defaultLocale: "en-CA", supportedLocales: [{ code: "en-CA" }, { code: "fr-CA" }] } };
const journeyed = {
  journey: {
    journeys: [
      {
        id: "main",
        pages: [
          { id: "p1", components: ["name"], routes: [{ to: "p2" }] },
          { id: "p2", components: ["city"], routes: [{ to: "$end" }] }
        ]
      }
    ]
  }
};

function draft(over: Record<string, unknown> = {}, state: Record<string, unknown> = {}): FormDraft {
  return {
    id: "d",
    formId: "f",
    formVersion: "1.0.0",
    runtime: { schemaVersion: "1.0.0", rendererVersion: "t" },
    locale: "en-CA",
    values: { name: "From draft" },
    state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [], ...state },
    updatedAt: 1,
    ...over
  } as unknown as FormDraft;
}

describe("a draft's locale", () => {
  it("falls back to the form's locale when the draft's is one the form no longer offers", async () => {
    const runtime = build(bilingual);
    for (const locale of ["xx", 5, undefined, ""]) {
      await runtime.hydrateFromDraft(draft({ locale }));
      expect(runtime.state().locale).toBe("en-CA");
    }
    expect(runtime.formValues().name).toBe("From draft");
    const result = await runtime.submit("submit", VERSION);
    expect(result.canonicalSubmission?.submission.locale).toBe("en-CA");
  });

  it("is matched as a locale tag is: case, underscore, primary subtag", async () => {
    const runtime = build(bilingual);
    await runtime.hydrateFromDraft(draft({ locale: "FR_ca" }));
    expect(runtime.state().locale).toBe("fr-CA");
    await runtime.hydrateFromDraft(draft({ locale: "fr" }));
    expect(runtime.state().locale).toBe("fr-CA");
  });

  it("keeps any tag on a form that declares no locales, and never a non-string", async () => {
    const runtime = build();
    const before = runtime.state().locale;
    await runtime.hydrateFromDraft(draft({ locale: "de-DE" }));
    expect(runtime.state().locale).toBe("de-DE");
    await runtime.hydrateFromDraft(draft({ locale: 7 }));
    expect(runtime.state().locale).toBe("de-DE");
    expect(before).not.toBe(7);
  });
});

describe("a draft's bookkeeping", () => {
  it("drops a malformed touched, dirty or current step and a list entry that is no string, and keeps the answers", async () => {
    const runtime = build();
    runtime.setValue("name", "Mine");
    await runtime.hydrateFromDraft(draft({}, { touched: 5, dirty: "name", visitedSteps: [2], completedSteps: [1, "s"], currentStep: 3 }));
    const state = runtime.state();
    expect(runtime.formValues().name).toBe("From draft");
    expect([...state.touched]).toEqual([]);
    expect([...state.dirty]).toEqual([]);
    expect(state.navigation.mode).toBe("normal");
    expect(state.navigation.currentStepId).toBeUndefined();
    expect([...state.navigation.visitedSteps]).toEqual([]);
    expect([...state.navigation.completedSteps]).toEqual(["s"]);
  });

  for (const journey of [null, "x", { id: 5, page: null, completed: "x" }]) {
    it(`restores the answers and starts the journey afresh on a journey block of ${JSON.stringify(journey)}`, async () => {
      const runtime = build(journeyed, { journey: "main" } as Partial<FormRuntimeDependencies>);
      await runtime.hydrateFromDraft(draft({ values: { name: "From draft", city: "Paris" } }, { journey }));
      expect(runtime.formValues()).toMatchObject({ name: "From draft", city: "Paris" });
      expect(runtime.journeyView()?.pageId).toBe("p1");
    });
  }

  it("keeps a journey block's good parts", async () => {
    const runtime = build(journeyed, { journey: "main" } as Partial<FormRuntimeDependencies>);
    await runtime.hydrateFromDraft(draft({ values: { name: "Ada", city: "Paris" } }, { journey: { id: "main", page: "p2", completed: ["p1", 5] } }));
    expect(runtime.journeyView()?.pageId).toBe("p2");
  });
});

describe("a draft that is no draft", () => {
  for (const [label, over] of [
    ["values as a list", { values: [] }],
    ["values as null", { values: null }],
    ["values as a string", { values: "x" }],
    ["no state", { state: undefined }],
    ["state as a string", { state: "x" }],
    ["a state without its mode", { state: { touched: [], dirty: [], visitedSteps: [], completedSteps: [] } }],
    ["a mode of neither kind", { state: { mode: "sideways", touched: [], dirty: [], visitedSteps: [], completedSteps: [] } }],
    ["a state without its visited steps", { state: { mode: "wizard", currentStep: "s1", touched: [], dirty: [], completedSteps: [] } }],
    ["completed steps that are no list", { state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: {} } }]
  ] as const) {
    it(`is refused with a DraftError before anything changes (${label})`, async () => {
      const runtime = build(bilingual);
      runtime.setValue("name", "Mine");
      runtime.setLocale("fr-CA");
      const failure = await runtime.hydrateFromDraft(draft(over as Record<string, unknown>)).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(DraftError);
      expect((failure as DraftError).code).toBe("draft.malformed");
      expect((failure as DraftError).message).toMatch(/^Draft is malformed: /);
      expect(runtime.formValues().name).toBe("Mine");
      expect(runtime.state().locale).toBe("fr-CA");
    });
  }
});

describe("a draft's journey block", () => {
  const blocks: unknown[] = [
    { id: "main", page: "p2", completed: ["p1", 5] },
    { id: "main", page: "p2", completed: ["p1"], written: {} },
    { id: "main", page: "p2", completed: ["p1"], written: { total: true }, clean: true },
    { id: "main", page: "p2", written: [] },
    { id: "", page: "p2" },
    "x"
  ];
  for (const block of blocks) {
    it(`reads ${JSON.stringify(block)} as a draft file reads it`, () => {
      const stored = draft({}, { journey: block });
      const fromFile = parseDraftFile(JSON.stringify(stored)).state.journey;
      expect(readDraft(stored, [], "en").journey).toEqual(fromFile);
    });
  }

  it("refuses a draft that is not a record as malformed", async () => {
    const runtime = build();
    const failure = await runtime.hydrateFromDraft(5 as unknown as FormDraft).then(
      () => undefined,
      (error: unknown) => error
    );
    expect((failure as DraftError).code).toBe("draft.malformed");
  });
});
