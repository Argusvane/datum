// Not type-checked with the package (it uses Node and the engine's sources): bundled for Node by print-check.mjs.
// Builds every print fixture of the engine (engine/print-fixtures: one form per class of paper bug) through the
// renderer's own print path, under the GCDS print theme and, beside it, the basic theme, for each rendition (answers, blank, filled).
import { EagerJourneyRenderKit } from "../../../engine/form-engine/render/core/journey-render-kit-eager.js";
import { setDefaultJourneyRenderKit } from "../../../engine/form-engine/render/core/journey-render-kit-default.js";
import { EagerJourneyEngine } from "../../../engine/form-engine/runtime/browser/journey-engine-eager.js";
import { setDefaultJourneyEngine } from "../../../engine/form-engine/runtime/browser/journey-engine.js";
import { FormRuntime } from "../../../engine/form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../../../engine/form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../../../engine/form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../../../engine/form-engine/validation/core/field-constraints.js";
import { normalizeDataGrids } from "../../../engine/form-engine/core/schema/data-grid.js";
import { collectionEntryCount } from "../../../engine/form-engine/render/core/component-model.js";
import { basicPrintTheme, preparePrint, readPrintSource } from "../../../engine/form-engine/render/print/index.js";
import { printFixtures, type PrintFixture } from "../../../engine/print-fixtures/fixtures.js";
import { gcdsPrintTheme } from "../print/index.js";

setDefaultJourneyEngine(EagerJourneyEngine);
setDefaultJourneyRenderKit(EagerJourneyRenderKit);

function runtimeOf(fixture: PrintFixture): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(fixture.definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(normalizeDataGrids(fixture.definition.root))]) });
  if (fixture.locale) runtime.setLocale(fixture.locale);
  for (const [path, value] of fixture.answers) {
    const row = /^([A-Za-z0-9_]+)\[(\d+)\]\./.exec(path);
    if (row) {
      const [, collection, index] = row as unknown as [string, string, string];
      while (collectionEntryCount(runtime.state().values, collection) <= Number(index)) runtime.addRow(collection);
    }
    runtime.setValue(path, value);
  }
  return runtime;
}

export async function printCases(stylesheet: string) {
  const cases = [];
  for (const fixture of printFixtures()) {
    for (const rendition of ["answers", "blank", "filled"] as const) {
      const source = await readPrintSource(runtimeOf(fixture), { rendition, mode: fixture.mode ?? "interactive", render: { journeyKit: EagerJourneyRenderKit }, page: { size: "letter" } });
      const gcds = preparePrint(source, { theme: gcdsPrintTheme, assets: { stylesheets: [{ url: stylesheet }] } });
      const basic = preparePrint(source, { theme: basicPrintTheme });
      cases.push({ name: `${fixture.id}-${rendition}`, rendition, expect: fixture.expect, locale: fixture.locale ?? "en", gcds: gcds.html, gcdsTheme: gcds.theme, fellBack: gcds.fellBack ?? null, basic: basic.html });
    }
  }
  return cases;
}
