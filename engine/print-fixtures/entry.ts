// Bundled by run.mjs for Node: builds every print fixture's document through the renderer's own
// print path (readPrintSource → preparePrint), as its answers, blank and filled (the paper form with the answers in), on each paper size.
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { setDefaultJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-default.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { setDefaultJourneyEngine } from "../form-engine/runtime/browser/journey-engine.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { normalizeDataGrids } from "../form-engine/core/schema/data-grid.js";
import { collectionEntryCount } from "../form-engine/render/core/component-model.js";
import { basicPrintTheme, datumPrintTheme, preparePrint, readPrintSource, type PrintRendition, type PrintTheme } from "../form-engine/render/print/index.js";
import { printFixtures, type PrintFixture } from "./fixtures.js";

setDefaultJourneyEngine(EagerJourneyEngine);
setDefaultJourneyRenderKit(EagerJourneyRenderKit);

export interface PrintCase {
  name: string;
  fixture: PrintFixture;
  rendition: PrintRendition;
  size: "A4" | "letter";
  theme: string;
  html: string;
}

function runtimeOf(fixture: PrintFixture): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(fixture.definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(normalizeDataGrids(fixture.definition.root))])
  });
  if (fixture.locale) {
    runtime.setLocale(fixture.locale);
  }
  for (const [path, value] of fixture.answers) {
    const row = /^([A-Za-z0-9_]+)\[(\d+)\]\./.exec(path);
    if (row) {
      const [, collection, index] = row as unknown as [string, string, string];
      while (collectionEntryCount(runtime.state().values, collection) <= Number(index)) {
        runtime.addRow(collection);
      }
    }
    runtime.setValue(path, value);
  }
  return runtime;
}

const THEMES: Record<string, PrintTheme> = { basic: basicPrintTheme, datum: datumPrintTheme };

export async function printCases(only?: readonly string[]): Promise<PrintCase[]> {
  const cases: PrintCase[] = [];
  for (const fixture of printFixtures()) {
    if (only && only.length > 0 && !only.includes(fixture.id)) {
      continue;
    }
    for (const rendition of ["answers", "blank", "filled"] as const) {
      for (const size of fixture.sizes ?? (["A4"] as const)) {
        // Datum's theme on the first size, the basic theme on the rest (and on the fallback).
        const themeId = size === "A4" ? "datum" : "basic";
        const runtime = runtimeOf(fixture);
        const source = await readPrintSource(runtime, {
          rendition,
          mode: fixture.mode ?? "interactive",
          render: { journeyKit: EagerJourneyRenderKit },
          page: { size }
        });
        const prepared = preparePrint(source, { theme: THEMES[themeId] });
        cases.push({ name: `${fixture.id}-${rendition}-${size}`, fixture, rendition, size, theme: prepared.theme, html: prepared.html });
      }
    }
  }
  return cases;
}
