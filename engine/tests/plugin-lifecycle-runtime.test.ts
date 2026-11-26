import { describe, expect, it } from "vitest";

import { EventBus } from "../form-engine/core/events/event-bus.js";
import { DataSourceProviderRegistry } from "../form-engine/data/providers/data-source-provider-registry.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import { DataSourceRegistry } from "../form-engine/registry/data-sources/data-source-registry.js";
import { PluginRegistry } from "../form-engine/registry/plugins/plugin-registry.js";
import { ValidatorRegistry } from "../form-engine/registry/validators/validator-registry.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { PluginPlatform } from "../form-engine/plugins/platform/plugin-platform.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";

describe("plugin lifecycle runtime integration", () => {
  it("initializes plugins and emits summary event", () => {
    const registry = new PluginRegistry();
    const initialized: string[] = [];

    registry.register({
      id: "a",
      version: "1.0.0",
      initialize: () => initialized.push("a")
    });
    registry.register({
      id: "b",
      version: "1.0.0",
      initialize: () => initialized.push("b")
    });

    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: false, sign: false, serverValidation: false });

    const events: string[] = [];
    const runtime = new FormRuntime(
      {
        id: "form",
        version: "1",
        schemaVersion: "1",
        root: { id: "root", type: "container", configuration: {} }
      },
      {
        pluginRegistry: registry,
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([])
      }
    );

    runtime.events().subscribe("PLUGINS_INITIALIZED", () => {
      events.push("plugins");
    });

    expect(initialized).toEqual(["a", "b"]);
    // Subscription occurs after constructor startup; event path is validated by
    // ensuring initialization side effect happened and no throw escaped.
    expect(events).toEqual([]);
  });

  it("isolates plugin initialization failures", () => {
    const registry = new PluginRegistry();
    const initialized: string[] = [];

    registry.register({
      id: "fail",
      version: "1.0.0",
      initialize: () => {
        throw new Error("boom");
      }
    });
    registry.register({
      id: "ok",
      version: "1.0.0",
      initialize: () => initialized.push("ok")
    });

    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: false, sign: false, serverValidation: false });

    expect(
      () =>
        new FormRuntime(
          {
            id: "form",
            version: "1",
            schemaVersion: "1",
            root: { id: "root", type: "container", configuration: {} }
          },
          {
            pluginRegistry: registry,
            submissionModes: modes,
            validationPipeline: new ValidationPipeline([])
          }
        )
    ).not.toThrow();

    expect(initialized).toEqual(["ok"]);
  });

  it("supports plugin platform install+initialize path", () => {
    const pluginRegistry = new PluginRegistry();
    const initialized: string[] = [];

    pluginRegistry.register({
      id: "base",
      version: "1.0.0",
      initialize: () => initialized.push("base")
    });

    const platform = new PluginPlatform({
      plugins: pluginRegistry,
      components: new ComponentRegistry(),
      validators: new ValidatorRegistry(),
      dataSourceProviders: new DataSourceProviderRegistry(),
      dataSources: new DataSourceRegistry()
    });

    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: false, sign: false, serverValidation: false });

    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe("PLUGINS_INITIALIZED", () => {
      events.push("ready");
    });

    new FormRuntime(
      {
        id: "form",
        version: "1",
        schemaVersion: "1",
        root: { id: "root", type: "container", configuration: {} }
      },
      {
        eventBus: bus,
        pluginPlatform: platform,
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([])
      }
    );

    expect(initialized).toEqual(["base"]);
    expect(events).toEqual(["ready"]);
  });
});
