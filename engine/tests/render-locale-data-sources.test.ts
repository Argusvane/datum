import { describe, expect, it } from "vitest";

import type { DataSourceRuntime, DataSourceResult, DataSourceSet } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { buildPrintModel } from "../form-engine/render/print/model.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";

const root: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: { content: [{ id: "country", type: "select", configuration: { label: "Country", data: { sourceId: "countries" } } }] }
};
const definition = {
  id: "f",
  version: "1",
  schemaVersion: "1",
  root,
  localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] }
} as FormDefinition;

/** A source that answers in the locale it is asked in, and records each one. */
function countries(asked: string[]) {
  return async (_query: unknown, context: { locale?: string } | undefined): Promise<DataSourceResult> => {
    asked.push(context?.locale ?? "");
    return { items: [{ value: "de", label: context?.locale === "fr" ? "Allemagne" : "Germany" }] };
  };
}

function runtimeWith(dataSources?: DataSourceRuntime): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(root)]),
    ...(dataSources ? { dataSources } : {})
  });
}

const labelOf = (output: Awaited<ReturnType<typeof buildRuntimeRenderOutput>>): string | undefined =>
  output.components.find((component) => component.id === "country")?.optionState?.items[0]?.label;

describe("a render in another locale than the runtime's", () => {
  it("asks the host's data sources in the render's locale, and keeps the answer under it", async () => {
    const asked: string[] = [];
    const load = countries(asked);
    const dataSources: DataSourceSet = { has: (id) => id === "countries", ids: () => ["countries"], load: (_id, query, context) => load(query, context) };
    const memo = new Map<string, DataSourceResult | undefined>();
    const output = await buildRuntimeRenderOutput(runtimeWith(), "readonly", { locale: "fr", dataSources, answerMemo: memo });
    expect(asked).toEqual(["fr"]);
    expect(labelOf(output)).toBe("Allemagne");
    expect(memo.get("fr\u0000country")?.items[0]?.label).toBe("Allemagne");
  });

  it("asks the runtime's own data sources in the render's locale", async () => {
    const asked: string[] = [];
    const load = countries(asked);
    const runtime = runtimeWith({ load: (_id, query, context) => load(query, context) });
    const output = await buildRuntimeRenderOutput(runtime, "readonly", { locale: "fr" });
    expect(asked).toEqual(["fr"]);
    expect(labelOf(output)).toBe("Allemagne");
    expect(runtime.state().locale).toBe("en");
    // Without a locale of its own, the render asks in the runtime's.
    asked.length = 0;
    expect(labelOf(await buildRuntimeRenderOutput(runtime, "readonly"))).toBe("Germany");
    expect(asked).toEqual(["en"]);
  });

  it("prints a copy in another language with the source's answers in that language", async () => {
    const asked: string[] = [];
    const load = countries(asked);
    const dataSources: DataSourceSet = { has: (id) => id === "countries", ids: () => ["countries"], load: (_id, query, context) => load(query, context) };
    const runtime = runtimeWith();
    runtime.setValue("country", "de");
    const model = await buildPrintModel(runtime, { mode: "readonly", locale: "fr", render: { dataSources } });
    expect(asked).toEqual(["fr"]);
    const printed = JSON.stringify(model);
    expect(printed).toContain("Allemagne");
    expect(printed).not.toContain("Germany");
  });
});
