import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import type { CanonicalSubmission } from "../../form-engine/core/submission/canonical-submission.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { PluginRegistry } from "../../form-engine/registry/plugins/plugin-registry.js";
import { ComponentRegistry } from "../../form-engine/registry/components/component-registry.js";
import { ValidatorRegistry } from "../../form-engine/registry/validators/validator-registry.js";
import { DataSourceProviderRegistry } from "../../form-engine/data/providers/data-source-provider-registry.js";
import { DataSourceRegistry } from "../../form-engine/registry/data-sources/data-source-registry.js";
import { SubmissionHandlerRegistry } from "../../form-engine/registry/submission/submission-handler-registry.js";
import { PluginPlatform } from "../../form-engine/plugins/platform/plugin-platform.js";

const form: FormDefinition = {
  id: "f1",
  version: "1",
  schemaVersion: "1",
  root: { id: "root", type: "form", configuration: {}, children: { content: [] } }
};

const clientCtx = () => ({
  form: { id: "f1", version: "1" },
  client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" }
});

function registries() {
  return {
    plugins: new PluginRegistry(),
    components: new ComponentRegistry(),
    validators: new ValidatorRegistry(),
    dataSourceProviders: new DataSourceProviderRegistry(),
    dataSources: new DataSourceRegistry(),
    submissionHandlers: new SubmissionHandlerRegistry()
  };
}

function modes() {
  const registry = new SubmissionModeRegistry();
  registry.register({ id: "m", validate: false, sign: false, serverValidation: false });
  return registry;
}

describe("submission handler delivery integration", () => {
  it("delivers the canonical submission to a plugin-contributed handler", async () => {
    const regs = registries();
    const delivered: CanonicalSubmission[] = [];
    regs.plugins.register({
      id: "delivery",
      version: "1.0.0",
      submissionHandlers: [
        {
          id: "webhook",
          version: "1.0.0",
          handle: (submission) => {
            delivered.push(submission);
          }
        }
      ]
    });

    const runtime = new FormRuntime(form, {
      submissionModes: modes(),
      validationPipeline: new ValidationPipeline([]),
      pluginPlatform: new PluginPlatform(regs)
    });

    const result = await runtime.submit("m", clientCtx());

    expect(result.accepted).toBe(true);
    expect(result.handlerErrors).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.submission.values).toEqual({});
  });

  it("isolates a throwing handler: submission stays accepted, failure is reported", async () => {
    const regs = registries();
    regs.plugins.register({
      id: "delivery",
      version: "1.0.0",
      submissionHandlers: [
        {
          id: "flaky-webhook",
          version: "1.0.0",
          handle: () => {
            throw new Error("503 from delivery endpoint");
          }
        }
      ]
    });

    const runtime = new FormRuntime(form, {
      submissionModes: modes(),
      validationPipeline: new ValidationPipeline([]),
      pluginPlatform: new PluginPlatform(regs)
    });

    const failures: unknown[] = [];
    runtime.events().subscribe("SUBMISSION_HANDLER_FAILED", (event) => failures.push(event.data));

    const result = await runtime.submit("m", clientCtx());

    expect(result.accepted).toBe(true);
    expect(result.handlerErrors).toEqual([
      { id: "flaky-webhook", message: "503 from delivery endpoint" }
    ]);
    expect(failures).toEqual([
      { modeId: "m", handlerId: "flaky-webhook", message: "503 from delivery endpoint" }
    ]);
  });

  it("runs handlers registered directly via submissionHandlerRegistry", async () => {
    const registry = new SubmissionHandlerRegistry();
    let calls = 0;
    registry.register({
      id: "host-handler",
      version: "1.0.0",
      handle: () => {
        calls += 1;
      }
    });

    const runtime = new FormRuntime(form, {
      submissionModes: modes(),
      validationPipeline: new ValidationPipeline([]),
      submissionHandlerRegistry: registry
    });

    const result = await runtime.submit("m", clientCtx());

    expect(result.accepted).toBe(true);
    expect(calls).toBe(1);
  });
});
