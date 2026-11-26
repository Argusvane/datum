import { describe, expect, it } from "vitest";
import type { CanonicalSubmission, FormDefinition, WasmSubmissionContext } from "@argusvane/datum-engine";

import { InMemorySubmissionStore, createKernelValidator, createSubmissionService } from "../src/index.js";

/**
 * Localized data-source labels never cross the sandbox: a snapshot the host stores
 * or supplies is sent with plain-string labels in the submit locale, and judged by VALUES.
 */

const FORM: FormDefinition = {
  id: "pick",
  version: "1",
  schemaVersion: "1",
  root: {
    id: "form",
    type: "form",
    configuration: { title: "Pick" },
    children: { content: [{ id: "city", type: "select", configuration: { data: { sourceId: "cities" } } }] }
  }
};

const envelope = (locale: string): CanonicalSubmission => ({
  versionContext: { form: { id: FORM.id, version: FORM.version }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
  submission: { locale, values: { city: "ott" } }
});

const LOCALIZED = [{ value: "ott", label: { default: "Ottawa", locales: { fr: "Ottawa (fr)" } }, description: { default: "Capital", locales: { fr: "Capitale" } } }];

async function run(source: "registered" | "provider", locale: string) {
  const sent: WasmSubmissionContext[] = [];
  const inner = createKernelValidator();
  const service = createSubmissionService({
    store: new InMemorySubmissionStore(),
    validator: { id: "spy", validate: (context) => (sent.push(context), inner.validate(context)) },
    ...(source === "provider" ? { optionSnapshot: () => ({ cities: LOCALIZED as never }) } : {})
  });
  await service.register(FORM, source === "registered" ? { validation: { unknownFields: "strip", optionSnapshot: { cities: LOCALIZED as never } } } : undefined);
  const verdict = await service.validate({ document: envelope(locale) });
  return { verdict, sent: sent[0]?.optionSnapshot };
}

describe("option snapshot with localized labels", () => {
  it.each(["registered", "provider"] as const)("a %s snapshot is judged by value and sent with plain labels in the submit locale", async (source) => {
    const fr = await run(source, "fr");
    expect(fr.verdict.accepted).toBe(true);
    expect(fr.sent).toEqual({ cities: [{ value: "ott", label: "Ottawa (fr)", description: "Capitale" }] });
    const en = await run(source, "en");
    expect(en.sent).toEqual({ cities: [{ value: "ott", label: "Ottawa", description: "Capital" }] });
  });
});
