import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { SubmissionVersionContext } from "../form-engine/core/submission/canonical-submission.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";

const VERSION: SubmissionVersionContext = {
  form: { id: "f", version: "1.0.0" },
  client: { runtimeVersion: "test", rendererVersion: "test", schemaVersion: "1.0.0" }
};

function build(defaultLocale: unknown): FormRuntime {
  const definition = {
    id: "f",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    localization: { defaultLocale },
    root: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "a", type: "text", configuration: {} }] } }
  } as unknown as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) } as unknown as FormRuntimeDependencies);
}

describe("the form's starting locale", () => {
  for (const written of [5, { en: 1 }, "  ", null, ["fr"]]) {
    it(`reads a defaultLocale of ${JSON.stringify(written)} as absent`, async () => {
      const runtime = build(written);
      expect(runtime.state().locale).toBe("en");
      runtime.setValue("a", "x");
      const result = (await runtime.submit("submit", VERSION)) as { accepted: boolean; canonicalSubmission?: { submission?: { locale?: unknown } } };
      expect(result.accepted).toBe(true);
      expect(result.canonicalSubmission?.submission?.locale).toBe("en");
    });
  }

  it("keeps a written default, trimmed", () => {
    expect(build(" fr ").state().locale).toBe("fr");
  });
});
