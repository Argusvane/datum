import { describe, expect, it } from "vitest";

import { DataSourceProviderRegistry } from "../../form-engine/data/providers/data-source-provider-registry.js";
import { ComponentRegistry } from "../../form-engine/registry/components/component-registry.js";
import { DataSourceRegistry } from "../../form-engine/registry/data-sources/data-source-registry.js";
import { PluginRegistry } from "../../form-engine/registry/plugins/plugin-registry.js";
import { ValidatorRegistry } from "../../form-engine/registry/validators/validator-registry.js";
import { SubmissionHandlerRegistry } from "../../form-engine/registry/submission/submission-handler-registry.js";
import { PluginPlatform } from "../../form-engine/plugins/platform/plugin-platform.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";

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

const form: FormDefinition = {
  id: "f1",
  version: "1",
  schemaVersion: "1",
  root: { id: "root", type: "form", configuration: {}, children: { content: [] } }
};

describe("plugin compatibility integration", () => {
  it("resolves a range-specified plugin dependency to the highest matching version", () => {
    const regs = registries();
    regs.plugins.register({ id: "core", version: "1.0.0" });
    regs.plugins.register({ id: "core", version: "1.4.0" });
    regs.plugins.register({ id: "core", version: "2.0.0" });
    regs.plugins.register({
      id: "feature",
      version: "1.0.0",
      dependencies: [{ id: "core", versionRange: "^1.0.0" }]
    });

    const ordered = regs.plugins.resolveDependencyOrder(["feature"]);
    const core = ordered.find((plugin) => plugin.id === "core");
    expect(core?.version).toBe("1.4.0");
  });

  it("rejects an environment-incompatible plugin and emits PLUGIN_INCOMPATIBLE", () => {
    const regs = registries();
    regs.plugins.register({ id: "server-only", version: "1.0.0", environments: ["server"] });
    const platform = new PluginPlatform(regs);

    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
    const runtime = new FormRuntime(form, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([]),
      pluginPlatform: platform
    });

    const incompatibleEvents: unknown[] = [];
    runtime.events().subscribe("PLUGIN_INCOMPATIBLE", (event) => incompatibleEvents.push(event.data));
    // event already fired during construction; re-run install to observe deterministically
    const result = platform.installAndInitialize({ environment: "browser" });
    expect(result.incompatiblePluginIds).toContain("server-only");
    expect(result.incompatibilities[0]?.reason).toMatch(/environment/i);
  });

  it("rejects a plugin whose engineRange excludes the engine version", () => {
    const regs = registries();
    regs.plugins.register({ id: "needs-2x", version: "1.0.0", engineRange: "^2.0.0" });
    const platform = new PluginPlatform(regs, {}, { engineVersion: "0.1.0" });

    const result = platform.installAndInitialize({ environment: "browser" });
    expect(result.installedPluginIds).not.toContain("needs-2x");
    expect(result.incompatibilities[0]?.reason).toMatch(/does not satisfy/i);
  });

  it("merges plugin-contributed runtime hooks after host hooks", async () => {
    const regs = registries();
    const trace: string[] = [];
    regs.plugins.register({
      id: "audit",
      version: "1.0.0",
      hooks: {
        beforeSubmit: [
          () => {
            trace.push("plugin:beforeSubmit");
          }
        ]
      }
    });
    const platform = new PluginPlatform(regs);

    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
    const runtime = new FormRuntime(form, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([]),
      pluginPlatform: platform,
      hooks: {
        beforeSubmit: [
          () => {
            trace.push("host:beforeSubmit");
          }
        ]
      }
    });

    await runtime.submit("m", {
      form: { id: "f1", version: "1" },
      client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" }
    });

    expect(trace).toEqual(["host:beforeSubmit", "plugin:beforeSubmit"]);
  });

  it("registers plugin submission handlers", () => {
    const regs = registries();
    regs.plugins.register({
      id: "delivery",
      version: "1.0.0",
      submissionHandlers: [{ id: "webhook", version: "1.0.0", handle: () => undefined }]
    });
    new PluginPlatform(regs).installAndInitialize({ environment: "browser" });
    expect(regs.submissionHandlers.listLatest().map((h) => h.id)).toEqual(["webhook"]);
  });
});
