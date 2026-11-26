// The host module of the binding tester: what the tester's page (page.js) imports to mount a form
// through the engine renderer (engine/form-engine/render/live) with the binding under test.
// Built by ../build.mjs together with that binding, so both share one copy of the engine and of lit.
//
// Nothing here knows a design system. The binding module exports `createBinding(lit, datum)` (the
// contract's BindingFactory); the page calls it with the renderer's one lit namespace and Datum's
// binding, and hands the result to `mountLive`. Datum's own binding stands behind it as the fallback,
// and Datum's feature list is the renderer's module set (assets, fields, summary, tabs, grid, steps ...).
import { SubmissionModeRegistry } from "../../../../engine/form-engine/core/submission/submission-modes.js";
import type { ValidationResult, ValidationStage } from "../../../../engine/form-engine/core/schema/contracts.js";
import type { FormDefinition } from "../../../../engine/form-engine/core/schema/types.js";
import { EagerJourneyRenderKit } from "../../../../engine/form-engine/render/core/journey-render-kit-eager.js";
import { EagerJourneyReviewKit } from "../../../../engine/form-engine/render/core/journey-review-kit-eager.js";
import { createJourneyPageFeature as createBareJourneyPageFeature } from "../../../../engine/form-engine/render/live/journey-page.js";
import { compileFormDefinition, FormRuntime } from "../../../../engine/form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../../../../engine/form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../../../../engine/form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../../../../engine/form-engine/validation/core/validation-pipeline.js";

export { lit } from "../../../../engine/form-engine/render/live/lit.js";
export { mountLive } from "../../../../engine/form-engine/render/live/mount.js";
export { createDatumBinding, createDatumFeatures } from "../../../../engine/form-engine/render/live/datum/options.js";
// A journey page's feature over the Check answers kit, as `EagerJourneyRenderKit.pageFeature` builds it:
// the bare `createJourneyPageFeature()` has no review code since the Check answers split, so a review
// page mounted with it draws no list and no binding's `review` hook runs.
export function createJourneyPageFeature(): ReturnType<typeof createBareJourneyPageFeature> {
  return createBareJourneyPageFeature(EagerJourneyReviewKit);
}
// CNV: the builder canvas's hooks (selection nodes, inert leaves, drop zones), which the tester lays over a fixture the way the builder does.
export { buildCanvasHooks } from "../../../../engine/form-engine/builder/web-component/canvas-hooks.js";
// PRT and PDF: the renderer's print path and the PDF theme ladder, for a binding's print and PDF themes.
export { basicPrintTheme, datumPrintTheme, preparePrint, readPrintSource } from "../../../../engine/form-engine/render/print/index.js";
export { resolvePdfTheme, selectPdfTheme } from "../../../../engine/form-engine/render/pdf/pdf-theme.js";
export { PdfThemeRegistry, pdfThemeLookup } from "../../../../engine/form-engine/render/pdf/pdf-theme-registry.js";

const pendingAnswers: Array<() => void> = [];

/**
 * A fixture's extra validation stage, from its spec:
 * - `advice:<severity>:<componentId>`: a warning or info (or an error) with the code `advice` on the
 *   field, worded by the field's `messages.advice`;
 * - `remote:<path>`: an async check of the answer at `path` that stays pending until {@link answerPending}.
 */
function stageOf(spec: string): ValidationStage {
  const [kind, a = "", b = ""] = spec.split(":");
  if (kind === "advice") {
    const severity = a as "warning" | "info" | "error";
    return { id: `advice-${b}-${severity}`, version: "1", validate: () => ({ errors: [{ code: "advice", componentId: b, path: b, severity, stage: `advice-${b}-${severity}`, source: "client" }] }) } as unknown as ValidationStage;
  }
  if (kind === "remote") {
    return { id: `remote-${a}`, version: "1", kind: "async", paths: () => [a], validate: () => new Promise<ValidationResult>((done) => pendingAnswers.push(() => done({ errors: [] } as unknown as ValidationResult))) } as unknown as ValidationStage;
  }
  throw new Error(`unknown fixture stage "${spec}"`);
}

/** Answers every async check a `remote:` stage holds pending. */
export function answerPending(): number {
  const answers = pendingAnswers.splice(0);
  for (const answer of answers) answer();
  return answers.length;
}

/** A runtime for a fixture form: field constraints (and the fixture's own stages) as the validation pipeline, one submission mode, the eager journey engine. */
export function createFormRuntime(definition: FormDefinition, config: { journeyEngine?: typeof EagerJourneyEngine; stages?: readonly string[] } = {}): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "check", validate: true, sign: false, serverValidation: false });
  const compiled = compileFormDefinition(definition, {}).definition;
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(compiled.root), ...(config.stages ?? []).map(stageOf)]),
    versionContext: { formVersion: definition.version, schemaVersion: definition.schemaVersion, rendererVersion: "binding-check" },
    ...(config.journeyEngine ? { journeyEngine: config.journeyEngine } : {})
  });
}

export async function loadJourneyEngine() {
  return { engine: EagerJourneyEngine, renderKit: EagerJourneyRenderKit };
}
