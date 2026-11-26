import { describe, expect, it } from "vitest";
import type { CanonicalSubmission, FormDefinition, TranslationCatalog, WasmSubmissionContext } from "@argusvane/datum-engine";

import { InMemorySubmissionStore, createKernelValidator, createSubmissionService } from "../src/index.js";

/**
 * The host's translation catalog reaches the sandbox beside the definition's map: as the context's `catalog` when it holds
 * something, and not at all when it is absent or empty.
 */

const FORM: FormDefinition = {
  id: "name",
  version: "1",
  schemaVersion: "1",
  root: {
    id: "form",
    type: "form",
    configuration: { title: "Name" },
    children: { content: [{ id: "given", type: "text-input", configuration: { label: "Given" } }] }
  }
};

const envelope: CanonicalSubmission = {
  versionContext: { form: { id: FORM.id, version: FORM.version }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
  submission: { locale: "fr-CA", values: { given: "Ada" } }
};

async function contextFor(translationCatalog: TranslationCatalog | undefined): Promise<WasmSubmissionContext & { catalog?: unknown }> {
  const sent: WasmSubmissionContext[] = [];
  const inner = createKernelValidator();
  const service = createSubmissionService({
    store: new InMemorySubmissionStore(),
    validator: { id: "spy", validate: (context) => (sent.push(context), inner.validate(context)) },
    ...(translationCatalog !== undefined ? { translationCatalog } : {})
  });
  await service.register(FORM);
  const verdict = await service.validate({ document: envelope });
  expect(verdict.accepted).toBe(true);
  return sent[0] as WasmSubmissionContext & { catalog?: unknown };
}

describe("host translation catalog in the run context", () => {
  it("carries catalog when the dependency is set and non-empty", async () => {
    const catalog = { "fr-CA": { form: { title: "Nom" } } } as unknown as TranslationCatalog;
    const context = await contextFor(catalog);
    expect(context.catalog).toEqual(catalog);
  });

  it.each([
    ["absent", undefined],
    ["empty", {} as TranslationCatalog]
  ] as const)("has no catalog key when the catalog is %s", async (_name, catalog) => {
    const context = await contextFor(catalog);
    expect("catalog" in context).toBe(false);
  });
});
