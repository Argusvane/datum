import { describe, expect, it, vi } from "vitest";

import type { FormDefinition, ComponentNode } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime, FormulaError, compileFormDefinition, localCalendarDate, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { JsonWasmAbi } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { EventBus } from "../form-engine/core/events/event-bus.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import { WasmValidationHost, type WasmSubmissionOutcome, type WasmValidationRequest } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { Journey, JourneyPage } from "../form-engine/core/schema/journey.js";
import type { ComponentPath } from "../form-engine/core/schema/types.js";
import { parseComponentPath, stringifyComponentPath } from "../form-engine/core/tree/component-path.js";
import { buildValuePaths } from "../form-engine/core/tree/data-scope.js";
import { InMemoryDraftStore } from "../form-engine/persistence/local-storage/in-memory-draft-store.js";
import { presentationForm } from "./fixtures/presentation-form.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { ServerValidationRunner } from "../form-engine/validation/server/server-validation.js";
import { RegisteredClientDataSourceRuntime } from "../form-engine/data/client/registered-client-data-source-runtime.js";
import { DataSourceProviderRegistry } from "../form-engine/data/providers/data-source-provider-registry.js";
import { StaticDataSourceProvider } from "../form-engine/data/providers/static-data-source-provider.js";
import { DataSourceRegistry } from "../form-engine/registry/data-sources/data-source-registry.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import { PdfRenditionRegistry } from "../form-engine/registry/pdf/pdf-rendition-registry.js";
import { PluginRegistry } from "../form-engine/registry/plugins/plugin-registry.js";
import { ValidatorRegistry } from "../form-engine/registry/validators/validator-registry.js";
import { PluginPlatform } from "../form-engine/plugins/platform/plugin-platform.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { FormulaFunctionRegistry } from "../form-engine/registry/formula-functions/formula-function-registry.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";

function form(): FormDefinition {
  const root: ComponentNode = {
    id: "root",
    type: "container",
    configuration: {},
    children: {
      children: [{ id: "firstName", type: "text", configuration: {} }]
    }
  };

  return {
    id: "f1",
    version: "1",
    schemaVersion: "1",
    root,
    localization: { defaultLocale: "en-CA" }
  };
}

describe("form runtime", () => {
  it("runs validation hooks and emits events in order", async () => {
    const trace: string[] = [];
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        {
          id: "field",
          version: "1.0.0",
          validate: () => {
            trace.push("stage");
            return { errors: [] };
          }
        }
      ]),
      hooks: {
        beforeValidation: [
          async () => {
            trace.push("before");
          }
        ],
        afterValidation: [
          async () => {
            trace.push("after");
          }
        ]
      }
    });

    runtime.events().subscribe("VALIDATION_STARTED", () => trace.push("event:start"));
    runtime.events().subscribe("VALIDATION_COMPLETED", () => trace.push("event:done"));

    await runtime.validate();

    expect(trace).toEqual(["event:start", "before", "stage", "after", "event:done"]);
  });

  it("changes locale without resetting values", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ])
    });

    runtime.setValue("firstName", "Ada");
    runtime.setLocale("fr-CA");

    const state = runtime.state();
    expect(state.values.firstName).toBe("Ada");
    expect(state.locale).toBe("fr-CA");
  });

  it("rejects setLocale for a locale outside supportedLocales", () => {
    // Labelled entries and the pre-label string shape side by side: both are allow-list codes.
    const restricted: FormDefinition = {
      ...form(),
      localization: {
        defaultLocale: "en-CA",
        supportedLocales: [{ code: "en-CA", label: "English (Canada)" }, { code: "fr-CA" }]
      }
    };
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(restricted, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([])
    });

    expect(() => runtime.setLocale("de-DE")).toThrow(/Locale "de-DE" is not supported/);
    // A supported locale still works, whichever shape declared it.
    runtime.setLocale("fr-CA");
    expect(runtime.state().locale).toBe("fr-CA");
    runtime.setLocale("en-CA");
    expect(runtime.state().locale).toBe("en-CA");
  });

  it("re-validates the fields showing errors after a locale switch, and only those", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });
    const def = form();
    (def.root.children!.children as ComponentNode[]).push({ id: "other", type: "text", configuration: {} });
    def.localization = { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] };
    const seen: string[] = [];
    const runtime = new FormRuntime(def, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        {
          id: "custom",
          version: "1.0.0",
          validate: (context) => {
            seen.push(context.locale ?? "");
            return {
              errors: [
                {
                  code: "custom.bad",
                  stage: "custom",
                  source: "custom",
                  severity: "error",
                  componentId: "firstName",
                  message: context.locale === "fr" ? "Mauvais" : "Bad"
                },
                {
                  code: "custom.other",
                  stage: "custom",
                  source: "custom",
                  severity: "error",
                  componentId: "other",
                  message: "Other"
                }
              ]
            };
          }
        }
      ])
    });
    await runtime.validate({ scope: "firstName" });
    expect(runtime.errors().map((e) => e.componentId)).toEqual(["firstName"]);
    runtime.setLocale("fr");
    // The shown field's validator ran again under the new locale; the untouched one stayed out.
    await vi.waitFor(() => expect(seen).toEqual(["en", "fr"]));
    expect(runtime.errors().map((e) => e.componentId)).toEqual(["firstName"]);
  });

  it("drops a superseded re-validation and reports a rejected one", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });
    const def = form();
    def.localization = { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] };
    const releases: Array<() => void> = [];
    let reject = false;
    const runtime = new FormRuntime(def, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        {
          id: "custom",
          version: "1.0.0",
          validate: async (context) => {
            if (releases.length < 2 && context.locale !== "en") {
              await new Promise<void>((resolve) => releases.push(resolve));
            }
            if (reject && context.locale === "en") {
              throw new Error("boom");
            }
            return {
              errors: [
                { code: "custom.bad", stage: "custom", source: "custom", severity: "error", componentId: "firstName", parameters: { message: `bad ${context.locale}` } }
              ]
            };
          }
        }
      ])
    });
    await runtime.validate({ scope: "firstName" });
    runtime.setLocale("fr");
    runtime.setLocale("en");
    await vi.waitFor(() => expect(releases.length).toBe(1));
    // The en run finishes first; the older fr run, released last, must not overwrite it.
    releases[0]!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.errors().map((e) => e.parameters?.message)).toEqual(["bad en"]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reject = true;
    runtime.setLocale("fr");
    runtime.setLocale("en");
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(String(spy.mock.calls[0]![0])).toContain("boom");
    spy.mockRestore();
  });

  it("uses a host-supplied translation catalog, available immediately", () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });

    // The host sources translations however it likes (fetch, bundle, database) and hands
    // the finished catalog in as configuration; the runtime never fetches anything.
    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([]),
      translationCatalog: { "fr-CA": { components: { name: { label: "Nom" } } } }
    });

    // Ready synchronously: render output built right after construction already has it.
    expect(runtime.translationCatalog()).toEqual({ "fr-CA": { components: { name: { label: "Nom" } } } });
  });

  it("has no translation catalog when the host supplies none", () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([])
    });
    // Keyed LocalizedText values then resolve from inline locales / default only.
    expect(runtime.translationCatalog()).toBeUndefined();
  });

  it("blocks submit when validation has errors", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "strict", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        {
          id: "field",
          version: "1.0.0",
          validate: () => ({
            errors: [
              {
                code: "validation.required",
                componentId: "firstName",
                stage: "field",
                source: "client"
              }
            ]
          })
        }
      ])
    });

    const result = await runtime.submit("strict", {
      form: { id: "f1", version: "1" },
      client: {
        runtimeVersion: "0.1.0",
        rendererVersion: "0.1.0",
        schemaVersion: "1"
      }
    });

    expect(result.accepted).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("validates one step's subtree alone when scoped, replaces what an earlier run stored, and records a completed step", async () => {
    const stepped: FormDefinition = {
      id: "f2",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            {
              id: "journey",
              type: "steps",
              configuration: {},
              children: {
                content: [
                  { id: "about", type: "step", configuration: { label: "About" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }] } },
                  { id: "where", type: "step", configuration: { label: "Where" }, children: { content: [{ id: "city", type: "text", configuration: { label: "City", required: true } }] } }
                ]
              }
            }
          ]
        }
      },
      localization: { defaultLocale: "en" }
    };
    const runtime = new FormRuntime(stepped, {
      submissionModes: new SubmissionModeRegistry(),
      validationPipeline: new ValidationPipeline([
        {
          id: "field",
          version: "1.0.0",
          validate: (context) => ({
            errors: ["name", "city"]
              .filter((id) => !context.values[id])
              .map((id) => ({ code: "validation.required", componentId: id, stage: "field" as const, source: "client" as const }))
          })
        }
      ])
    });
    // Unscoped: both steps' fields are reported.
    expect((await runtime.validate()).map((error) => error.componentId)).toEqual(["name", "city"]);
    // Scoped to the first step: its own field alone, and the store holds only that.
    expect((await runtime.validate({ scope: "about" })).map((error) => error.componentId)).toEqual(["name"]);
    expect(runtime.errors().map((error) => error.componentId)).toEqual(["name"]);
    runtime.setValue("name", "Ada");
    expect(await runtime.validate({ scope: "about" })).toEqual([]);
    expect(runtime.state().validation.valid).toBe(true);
    // Completed and navigated on: the state the indicator draws from.
    runtime.markStepCompleted("about");
    expect((await runtime.navigate("where")).ok).toBe(true);
    const navigation = runtime.state().navigation;
    expect(navigation.currentStepId).toBe("where");
    expect([...navigation.completedSteps]).toEqual(["about"]);
    expect([...navigation.visitedSteps]).toEqual(["where"]);
    // A step that is not one: refused, as before.
    expect((await runtime.navigate("name")).ok).toBe(false);
  });

  it("accepts submit and emits canonical payload", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      hooks: {
        transformValues: [
          async (values) => ({ ...values, submittedBy: "runtime-test" })
        ]
      }
    });

    runtime.setValue("firstName", "Ada");

    const result = await runtime.submit("normal", {
      form: { id: "f1", version: "1" },
      client: {
        runtimeVersion: "0.1.0",
        rendererVersion: "0.1.0",
        schemaVersion: "1"
      }
    });

    expect(result.accepted).toBe(true);
    expect(result.canonicalSubmission?.submission.values.submittedBy).toBe("runtime-test");
  });

  it("hydrates runtime state from draft and emits draft event", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: true, sign: false, serverValidation: false });

    const observed: string[] = [];
    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      hooks: {
        afterDraftLoad: [
          async ({ draftId }) => {
            observed.push(`hook:${draftId}`);
          }
        ]
      }
    });

    runtime.events().subscribe("DRAFT_LOADED", () => observed.push("event:draft"));

    await runtime.hydrateFromDraft({
      id: "d1",
      formId: "f1",
      formVersion: "1",
      runtime: { schemaVersion: "1", rendererVersion: "0.1.0" },
      locale: "fr-CA",
      values: { firstName: "Ada" },
      state: {
        mode: "wizard",
        currentStep: "step1",
        touched: ["firstName"],
        dirty: ["firstName"],
        visitedSteps: ["step1"],
        completedSteps: []
      },
      updatedAt: 1
    });

    const state = runtime.state();
    expect(state.values.firstName).toBe("Ada");
    expect(state.locale).toBe("fr-CA");
    expect(state.touched.has("firstName")).toBe(true);
    expect(state.navigation.currentStepId).toBe("step1");
    expect(observed).toEqual(["hook:d1", "event:draft"]);
  });

  it("blocks submit when wasm validation fails", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "strict", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      wasmValidationHost: createInProcessWasmValidationHost({
        id: "deterministic",
        version: "1.0.0",
        validate: () => ({
          errors: [
            {
              code: "validation.blockedByWasm",
              stage: "wasm",
              source: "wasm"
            }
          ]
        })
      })
    });

    runtime.setValue("firstName", "Ada");
    const result = await runtime.submit("strict", {
      form: { id: "f1", version: "1" },
      client: {
        runtimeVersion: "0.1.0",
        rendererVersion: "0.1.0",
        schemaVersion: "1"
      }
    });

    expect(result.accepted).toBe(false);
    expect(result.errors[0]?.source).toBe("wasm");
  });

  it("blocks submit when server validation fails", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "strict", validate: true, sign: false, serverValidation: true });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      serverValidationRunner: new ServerValidationRunner([
        {
          id: "eligibility",
          version: "1.0.0",
          validate: async () => ({
            errors: [
              {
                code: "server.ineligible",
                stage: "server",
                source: "server"
              }
            ]
          })
        }
      ])
    });

    runtime.setValue("firstName", "Ada");
    const result = await runtime.submit("strict", {
      form: { id: "f1", version: "1" },
      client: {
        runtimeVersion: "0.1.0",
        rendererVersion: "0.1.0",
        schemaVersion: "1"
      }
    });

    expect(result.accepted).toBe(false);
    expect(result.errors[0]?.source).toBe("server");
  });

  it("resolves component data source with runtime locale and values", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: false, sign: false, serverValidation: false });

    const defs = new DataSourceRegistry();
    defs.register({ id: "countries", providerId: "static", version: "1.0.0" });

    const providers = new DataSourceProviderRegistry();
    providers.register(
      new StaticDataSourceProvider("static", [
        { value: "CA", label: "Canada" },
        { value: "US", label: "United States" }
      ])
    );

    const runtime = new FormRuntime(
      {
        id: "f-data",
        version: "1",
        schemaVersion: "1",
        localization: { defaultLocale: "en-CA" },
        root: {
          id: "root",
          type: "container",
          configuration: {},
          children: {
            children: [
              {
                id: "country",
                type: "select",
                configuration: { data: { sourceId: "countries" } }
              }
            ]
          }
        }
      },
      {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([]),
        dataSources: new RegisteredClientDataSourceRuntime(defs, providers)
      }
    );

    runtime.setValue("country", "CA");
    const result = await runtime.resolveDataSource({ componentId: "country" });

    expect(result?.items).toHaveLength(2);
    expect(result?.items[0]?.value).toBe("CA");
  });

  it("throws when component has data source but runtime is not configured", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: false, sign: false, serverValidation: false });

    const runtime = new FormRuntime(
      {
        id: "f-data",
        version: "1",
        schemaVersion: "1",
        localization: { defaultLocale: "en-CA" },
        root: {
          id: "root",
          type: "container",
          configuration: {},
          children: {
            children: [
              {
                id: "country",
                type: "select",
                configuration: { data: { sourceId: "countries" } }
              }
            ]
          }
        }
      },
      {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([])
      }
    );

    await expect(runtime.resolveDataSource({ componentId: "country" })).rejects.toThrow(
      /not configured/
    );
  });

  it("returns undefined when component has no data source configuration", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: false, sign: false, serverValidation: false });

    const defs = new DataSourceRegistry();
    const providers = new DataSourceProviderRegistry();
    const runtime = new FormRuntime(
      {
        id: "f-data",
        version: "1",
        schemaVersion: "1",
        localization: { defaultLocale: "en-CA" },
        root: {
          id: "root",
          type: "container",
          configuration: {},
          children: {
            children: [{ id: "country", type: "select", configuration: {} }]
          }
        }
      },
      {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([]),
        dataSources: new RegisteredClientDataSourceRuntime(defs, providers)
      }
    );

    const result = await runtime.resolveDataSource({ componentId: "country" });
    expect(result).toBeUndefined();
  });

  it("throws when resolveDataSource targets unknown component", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: false, sign: false, serverValidation: false });

    const defs = new DataSourceRegistry();
    const providers = new DataSourceProviderRegistry();
    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([]),
      dataSources: new RegisteredClientDataSourceRuntime(defs, providers)
    });

    await expect(runtime.resolveDataSource({ componentId: "missing" })).rejects.toThrow(
      /Component not found/
    );
  });

  const submitEnvelope = {
    form: { id: "f1", version: "1" },
    client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" }
  };

  it("stores wasm errors and publishes ERRORS_CHANGED so renderers display them", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "strict", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      wasmValidationHost: createInProcessWasmValidationHost({
        id: "custom",
        version: "1.0.0",
        validate: () => ({
          errors: [
            {
              code: "custom.rejected",
              componentId: "firstName",
              path: "firstName",
              stage: "plugin",
              source: "custom"
            }
          ]
        })
      })
    });

    const errorCounts: number[] = [];
    runtime.events().subscribe("ERRORS_CHANGED", (event) => {
      errorCounts.push((event.data as { errorCount: number }).errorCount);
    });

    runtime.setValue("firstName", "Ada");
    const result = await runtime.submit("strict", submitEnvelope);

    expect(result.accepted).toBe(false);
    // The error contract reaches the renderer's pull model: the store holds it and
    // ERRORS_CHANGED fired for it (after validate()'s own empty publication).
    expect(runtime.errors().map((error) => error.code)).toEqual(["custom.rejected"]);
    expect(runtime.errors()[0]?.componentId).toBe("firstName");
    expect(errorCounts).toEqual([0, 1]);
  });

  it("submits the sandbox's sanitized values: schema-unknown keys are stripped", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      wasmValidationHost: createInProcessWasmValidationHost({
        id: "clean",
        version: "1.0.0",
        validate: () => ({ errors: [] })
      })
    });

    runtime.setValue("firstName", "Ada");
    runtime.setValue("notInSchema", "should-vanish");
    const result = await runtime.submit("normal", submitEnvelope);

    expect(result.accepted).toBe(true);
    expect(result.canonicalSubmission?.submission.values).toEqual({ firstName: "Ada" });
  });

  it("validates locally first and never reaches the wasm stage when local validation fails", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "strict", validate: true, sign: false, serverValidation: false });

    const stageOrder: string[] = [];
    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        {
          id: "field",
          version: "1.0.0",
          validate: (ctx) => {
            stageOrder.push("local");
            return {
              errors:
                typeof ctx.values.firstName === "string" && ctx.values.firstName.length > 0
                  ? []
                  : [
                      {
                        code: "required",
                        componentId: "firstName",
                        path: "firstName",
                        stage: "field",
                        source: "client" as const
                      }
                    ]
            };
          }
        }
      ]),
      wasmValidationHost: createInProcessWasmValidationHost({
        id: "spy",
        version: "1.0.0",
        validate: () => {
          stageOrder.push("wasm");
          return { errors: [] };
        }
      })
    });

    // Local validation fails: the wasm stage must never run.
    const rejected = await runtime.submit("strict", submitEnvelope);
    expect(rejected.accepted).toBe(false);
    expect(rejected.errors[0]?.source).toBe("client");
    expect(stageOrder).toEqual(["local"]);

    // Local validation passes: the wasm stage runs, strictly after it.
    runtime.setValue("firstName", "Ada");
    const accepted = await runtime.submit("strict", submitEnvelope);
    expect(accepted.accepted).toBe(true);
    expect(stageOrder).toEqual(["local", "local", "wasm"]);
  });

  it("publishes WASM_VALIDATION_COMPLETED with the request/response exchange", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      wasmValidationHost: createInProcessWasmValidationHost({
        id: "gate",
        version: "1.0.0",
        validate: (ctx) => ({
          errors:
            ctx.values.firstName === "boom"
              ? [{ code: "custom.boom", componentId: "firstName", path: "firstName", stage: "plugin", source: "custom" as const }]
              : []
        })
      })
    });

    const exchanges: Array<Record<string, unknown>> = [];
    runtime.events().subscribe("WASM_VALIDATION_COMPLETED", (event) => {
      exchanges.push(event.data as Record<string, unknown>);
    });

    runtime.setValue("firstName", "Ada");
    runtime.setValue("rogue", "stripped");
    await runtime.submit("normal", submitEnvelope);

    expect(exchanges).toHaveLength(1);
    const accepted = exchanges[0]!;
    expect(accepted.blocked).toBe(false);
    expect(accepted.unknownFields).toBe("strip");
    expect(accepted.modeId).toBe("normal");
    expect((accepted.requestValues as Record<string, unknown>).rogue).toBe("stripped");
    expect((accepted.response as { values?: Record<string, unknown> }).values).toEqual({
      firstName: "Ada"
    });
    expect(typeof accepted.durationMs).toBe("number");

    runtime.setValue("firstName", "boom");
    await runtime.submit("normal", submitEnvelope);
    const blocked = exchanges[1]!;
    expect(blocked.blocked).toBe(true);
    expect((blocked.response as { errors: Array<{ code: string }> }).errors[0]?.code).toBe(
      "custom.boom"
    );
  });

  it("carries the sandbox's run log out at the level the host asks for, per submit or as a default", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: true, sign: false, serverValidation: false });
    const chatty = createInProcessWasmValidationHost({
      id: "chatty",
      version: "1.0.0",
      validate: (ctx) => {
        ctx.log?.debug("looked at", { firstName: ctx.values.firstName });
        return { errors: [] };
      }
    });
    const pipeline = new ValidationPipeline([{ id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }]);

    const runtime = new FormRuntime(form(), { submissionModes: modes, validationPipeline: pipeline, wasmValidationHost: chatty });
    const exchanges: Array<Record<string, unknown>> = [];
    runtime.events().subscribe("WASM_VALIDATION_COMPLETED", (event) => {
      exchanges.push(event.data as Record<string, unknown>);
    });
    runtime.setValue("firstName", "Ada");

    // The default keeps warnings and errors alone: a run that behaves returns no log.
    await runtime.submit("normal", submitEnvelope);
    expect((exchanges[0]!.response as { logs?: unknown }).logs).toBeUndefined();
    expect(exchanges[0]!.logLevel).toBeUndefined();

    // Per call: the kernel's steps around what the rule said, its data intact.
    await runtime.submit("normal", submitEnvelope, { wasmLogLevel: "debug" });
    expect(exchanges[1]!.logLevel).toBe("debug");
    const logs = (exchanges[1]!.response as { logs: Array<{ level: string; message: string; data?: unknown }> }).logs;
    expect(logs[0]?.message).toMatch(/^run: schema /);
    expect(logs.find((entry) => entry.message === "looked at")).toEqual({ level: "debug", message: "looked at", data: { firstName: "Ada" } });
    expect(logs.at(-1)).toEqual({ level: "info", message: "accepted: 0 error(s), 1 value(s)" });

    // As a runtime default, applied to every submit.
    const verbose = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: pipeline,
      wasmValidationHost: chatty,
      wasmLogLevel: "info"
    });
    const seen: Array<Record<string, unknown>> = [];
    verbose.events().subscribe("WASM_VALIDATION_COMPLETED", (event) => {
      seen.push(event.data as Record<string, unknown>);
    });
    verbose.setValue("firstName", "Ada");
    await verbose.submit("normal", submitEnvelope);
    expect(seen[0]!.logLevel).toBe("info");
    expect((seen[0]!.response as { logs: unknown }).logs).toEqual([{ level: "info", message: "accepted: 0 error(s), 1 value(s)" }]);
  });

  it("makes the unknown-fields policy configurable per submission (and as a runtime default)", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      wasmValidationHost: createInProcessWasmValidationHost({
        id: "clean",
        version: "1.0.0",
        validate: () => ({ errors: [] })
      })
    });

    runtime.setValue("firstName", "Ada");
    runtime.setValue("notInSchema", "value");

    // Default: strip.
    const stripped = await runtime.submit("normal", submitEnvelope);
    expect(stripped.accepted).toBe(true);
    expect(stripped.canonicalSubmission?.submission.values).toEqual({ firstName: "Ada" });

    // Per-call override: keep.
    const kept = await runtime.submit("normal", submitEnvelope, { wasmUnknownFields: "keep" });
    expect(kept.accepted).toBe(true);
    expect(kept.canonicalSubmission?.submission.values).toEqual({
      firstName: "Ada",
      notInSchema: "value"
    });

    // Per-call override: reject blocks with the contract error.
    const rejected = await runtime.submit("normal", submitEnvelope, { wasmUnknownFields: "reject" });
    expect(rejected.accepted).toBe(false);
    expect(rejected.errors.map((error) => error.code)).toEqual(["unknown_field"]);
    expect(rejected.errors[0]?.parameters).toEqual({ field: "notInSchema" });

    // Runtime-level default, no per-call option needed.
    const lenientRuntime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      wasmValidationHost: createInProcessWasmValidationHost({
        id: "clean",
        version: "1.0.0",
        validate: () => ({ errors: [] })
      }),
      wasmUnknownFields: "keep"
    });
    lenientRuntime.setValue("firstName", "Ada");
    lenientRuntime.setValue("notInSchema", "value");
    const byDefault = await lenientRuntime.submit("normal", submitEnvelope);
    expect(byDefault.canonicalSubmission?.submission.values).toEqual({
      firstName: "Ada",
      notInSchema: "value"
    });
  });

  it("injects host-resolved external data into the wasm context under the allowlist", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "strict", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      wasmValidationHost: createInProcessWasmValidationHost({
        id: "membership",
        version: "1.0.0",
        validate: (ctx) => {
          const allowed = (ctx.externalData?.allowedNames ?? []) as string[];
          return {
            errors: allowed.includes(ctx.values.firstName as string)
              ? []
              : [
                  {
                    code: "custom.notAllowed",
                    componentId: "firstName",
                    path: "firstName",
                    stage: "plugin",
                    source: "custom"
                  }
                ]
          };
        }
      }),
      wasmExternalDataProvider: async () => ({ allowedNames: ["Ada", "Grace"] }),
      wasmPolicy: {
        ...WasmValidationHost.STRICT_POLICY,
        allowedExternalDataKeys: ["allowedNames"]
      }
    });

    runtime.setValue("firstName", "Linus");
    const rejected = await runtime.submit("strict", submitEnvelope);
    expect(rejected.accepted).toBe(false);
    expect(rejected.errors[0]?.code).toBe("custom.notAllowed");

    runtime.setValue("firstName", "Ada");
    const accepted = await runtime.submit("strict", submitEnvelope);
    expect(accepted.accepted).toBe(true);
  });

  it("rejects at the ABI when injected external data is not allowlisted, failing closed", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "strict", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      wasmValidationHost: createInProcessWasmValidationHost({
        id: "clean",
        version: "1.0.0",
        validate: () => ({ errors: [] })
      }),
      wasmExternalDataProvider: async () => ({ secretToken: "abc" }),
      wasmPolicy: { ...WasmValidationHost.STRICT_POLICY, allowedExternalDataKeys: ["publicRate"] }
    });

    runtime.setValue("firstName", "Ada");
    const result = await runtime.submit("strict", submitEnvelope);

    expect(result.accepted).toBe(false);
    expect(result.errors[0]?.code).toBe("wasm.execution_error");
    expect(runtime.errors()[0]?.code).toBe("wasm.execution_error");
  });

  it("fails closed when the wasm host throws instead of rejecting the submit promise", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "strict", validate: true, sign: false, serverValidation: false });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      wasmValidationHost: createInProcessWasmValidationHost({
        id: "broken",
        version: "1.0.0",
        validate: () => {
          throw new Error("sandbox exploded");
        }
      })
    });

    runtime.setValue("firstName", "Ada");
    const result = await runtime.submit("strict", submitEnvelope);

    expect(result.accepted).toBe(false);
    // The kernel catches a validator that throws and blocks the run with
    // `validator.failed`, so the outcome (and a document's digest) still comes back.
    expect(result.errors[0]?.code).toBe("validator.failed");
    expect(result.errors[0]?.source).toBe("wasm");
  });

  it("stores server validation errors for display, like the wasm stage", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "strict", validate: true, sign: false, serverValidation: true });

    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ]),
      serverValidationRunner: new ServerValidationRunner([
        {
          id: "eligibility",
          version: "1.0.0",
          validate: async () => ({
            errors: [
              {
                code: "server.ineligible",
                componentId: "firstName",
                path: "firstName",
                stage: "server",
                source: "server"
              }
            ]
          })
        }
      ])
    });

    runtime.setValue("firstName", "Ada");
    const result = await runtime.submit("strict", submitEnvelope);

    expect(result.accepted).toBe(false);
    expect(runtime.errors().map((error) => error.code)).toEqual(["server.ineligible"]);
  });

  it("stores host-supplied errors for display, until the next validation replaces them", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        { id: "field", version: "1.0.0", validate: () => ({ errors: [] }) }
      ])
    });
    const announced: number[] = [];
    runtime.events().subscribe("ERRORS_CHANGED", (event) => {
      announced.push((event.data as { errorCount: number }).errorCount);
    });

    // A server's verdict after delivery: one field it rejected, and one the form as a whole.
    const stored = runtime.setErrors([
      { componentId: "firstName", code: "taken", message: "Already registered." },
      { code: "delivery.partial", severity: "warning", source: "custom" }
    ]);

    expect(stored).toEqual([
      {
        id: "host_0",
        code: "taken",
        message: "Already registered.",
        componentId: "firstName",
        stage: "host",
        source: "server"
      },
      { id: "host_1", code: "delivery.partial", stage: "host", source: "custom", severity: "warning" }
    ]);
    expect(runtime.errors()).toEqual(stored);
    expect(runtime.state().validation.valid).toBe(false);
    expect(announced).toEqual([2]);

    // Validating again is the pipeline's verdict: the host's errors are gone.
    await runtime.validate();
    expect(runtime.errors()).toEqual([]);
    expect(runtime.state().validation.valid).toBe(true);

    // Non-blocking host errors leave the form valid; an empty list clears.
    runtime.setErrors([{ code: "note", severity: "info" }]);
    expect(runtime.state().validation.valid).toBe(true);
    runtime.setErrors([]);
    expect(runtime.errors()).toEqual([]);
    expect(announced).toEqual([2, 0, 1, 0]);
  });

  it("reads PDF layouts from the definition, or live from a host-supplied source", () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });
    const deps = { submissionModes: modes, validationPipeline: new ValidationPipeline([]) };
    const layoutA = { id: "a", kind: "generated" as const, root: { id: "document", type: "pdf-document", configuration: {} } };
    const layoutB = { ...layoutA, id: "b" };

    const fromDefinition = new FormRuntime({ ...form(), pdf: { layouts: [layoutA] } }, deps);
    expect(fromDefinition.pdfConfiguration()?.layouts?.map((layout) => layout.id)).toEqual(["a"]);

    let current = { layouts: [layoutA] };
    const live = new FormRuntime({ ...form(), pdf: { layouts: [layoutB] } }, { ...deps, pdfConfiguration: () => current });
    expect(live.pdfConfiguration()?.layouts?.map((layout) => layout.id)).toEqual(["a"]);
    current = { layouts: [layoutA, layoutB] };
    expect(live.pdfConfiguration()?.layouts?.map((layout) => layout.id)).toEqual(["a", "b"]);

    const fixed = new FormRuntime(form(), { ...deps, pdfConfiguration: { layouts: [layoutB], defaultLayoutId: "b" } });
    expect(fixed.pdfConfiguration()?.defaultLayoutId).toBe("b");
  });

  it("names its component registry and the platform's PDF renditions as where a PDF looks for renditions", () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });
    const deps = { submissionModes: modes, validationPipeline: new ValidationPipeline([]) };

    const bare = new FormRuntime(form(), deps);
    expect(bare.pdfRenditionSources()).toEqual({ components: undefined, renditions: undefined });

    const componentRegistry = new ComponentRegistry();
    const pdfRenditions = new PdfRenditionRegistry();
    const plugins = new PluginRegistry();
    plugins.register({
      id: "moods",
      version: "1.0.0",
      pdfRenditions: [{ componentType: "mood", rendition: { id: "emoji", render: () => [] } }]
    });
    const pluginPlatform = new PluginPlatform({
      plugins,
      components: new ComponentRegistry(),
      validators: new ValidatorRegistry(),
      dataSourceProviders: new DataSourceProviderRegistry(),
      dataSources: new DataSourceRegistry(),
      pdfRenditions
    });
    const wired = new FormRuntime(form(), { ...deps, componentRegistry, pluginPlatform });
    const sources = wired.pdfRenditionSources();
    expect(sources.components).toBe(componentRegistry);
    expect(sources.renditions).toBe(pdfRenditions);
    // The platform installed the plugin on construction, so its contribution is already there.
    expect(sources.renditions!.list("mood").map((rendition) => rendition.id)).toEqual(["emoji"]);
  });
});

describe("form runtime: a hidden answer that is still submitted keeps its shape", () => {
  const byEmail: NonNullable<ComponentNode["rules"]> = {
    visibleWhen: { kind: "binary", operator: "eq", left: { kind: "path", path: "by_email" }, right: { kind: "literal", value: true } }
  };

  function shapes(hiddenValueBehavior?: string): FormDefinition {
    const behaviour = hiddenValueBehavior !== undefined ? { hiddenValueBehavior } : {};
    return {
      id: "shapes",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "by_email", type: "checkbox", configuration: {} },
            {
              id: "email",
              type: "text",
              configuration: { required: true, maxLength: 20, pattern: "[^@]+@[^@]+", ...behaviour },
              rules: byEmail
            },
            { id: "upload", type: "file", configuration: { maxFileSizeMb: 1, accept: ".pdf", ...behaviour }, rules: byEmail }
          ]
        }
      }
    };
  }

  /** The field constraints, and a plugin's stage that flags the address whatever it holds. */
  function runtimeFor(shape: FormDefinition): FormRuntime {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    return new FormRuntime(shape, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([
        createFieldConstraintsStage(shape.root),
        {
          id: "plugin",
          version: "1",
          validate: () => ({ errors: [{ code: "plugin.flag", componentId: "email", stage: "plugin", source: "custom" }] })
        }
      ])
    });
  }

  const envelope = {
    form: { id: "shapes", version: "1" },
    client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" }
  };
  const executable = { storage: "base64", name: "evil.exe", type: "application/x-msdownload", size: 999999999, data: "" };
  const codes = (errors: ReadonlyArray<{ componentId?: string | undefined; code: string }>): string[] =>
    errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();

  it("holds a hidden, retained answer to its length, pattern, size and type — never to required or a plugin's check", async () => {
    const empty = runtimeFor(shapes("retain"));
    empty.setValue("by_email", false);
    expect((await empty.submit("submit", envelope)).accepted).toBe(true);

    const oversized = runtimeFor(shapes("retain"));
    oversized.setValue("by_email", false);
    oversized.setValue("email", "x".repeat(5000));
    oversized.setValue("upload", executable);
    const refused = await oversized.submit("submit", envelope);
    expect(refused.accepted).toBe(false);
    expect(codes(refused.errors)).toEqual(["upload:maxFileSize", "email:maxLength"].sort());

    const misshapen = runtimeFor(shapes("retain"));
    misshapen.setValue("email", "not an address");
    misshapen.setValue("upload", { ...executable, size: 10 });
    expect(codes((await misshapen.submit("submit", envelope)).errors)).toEqual(["email:pattern", "upload:fileType"]);

    // Shown, the plugin's check applies too.
    const shown = runtimeFor(shapes());
    shown.setValue("by_email", true);
    shown.setValue("email", "a@b.co");
    expect(codes((await shown.submit("submit", envelope)).errors)).toEqual(["email:plugin.flag"]);
  });

  it("holds nothing to a shape that is not submitted as given: cleared or excluded, which is also the default", async () => {
    for (const behaviour of ["clear", "exclude-from-submission", undefined]) {
      const runtime = runtimeFor(shapes(behaviour));
      runtime.setValue("by_email", false);
      runtime.setValue("email", "x".repeat(5000));
      runtime.setValue("upload", executable);
      expect((await runtime.submit("submit", envelope)).accepted, String(behaviour)).toBe(true);
    }
  });
});

describe("form runtime: component ids named like Object.prototype members", () => {
  const envelope = {
    form: { id: "proto", version: "1" },
    client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" }
  };

  function runtimeFor(children: ComponentNode[]): FormRuntime {
    const shape: FormDefinition = {
      id: "proto",
      version: "1",
      schemaVersion: "1",
      root: { id: "root", type: "form", configuration: {}, children: { content: children } }
    };
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    return new FormRuntime(shape, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(shape.root)])
    });
  }

  it("reads an unanswered `constructor`, `toString` or `valueOf` as empty, as the kernel does", async () => {
    for (const id of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const runtime = runtimeFor([
        { id, type: "text", configuration: { required: true } },
        { id: "other", type: "text", configuration: {} }
      ]);
      runtime.setValue("other", "x");
      const result = await runtime.submit("submit", envelope);
      expect(result.errors.map((error) => `${error.componentId}:${error.code}`), id).toEqual([`${id}:required`]);
    }

    // A rule reading the component's own value sees nothing there either: shown, and required.
    const ruled = runtimeFor([
      {
        id: "constructor",
        type: "text",
        configuration: { required: true },
        rules: { visibleWhen: { kind: "unary", operator: "not", operand: { kind: "path", path: "component" } } }
      }
    ]);
    expect(ruled.effectiveState("constructor")?.visible).toBe(true);
    expect((await ruled.submit("submit", envelope)).errors.map((error) => error.code)).toEqual(["required"]);
  });

  it("applies a default to such a field, which never held an inherited value", () => {
    const runtime = runtimeFor([
      { id: "valueOf", type: "text", configuration: {}, rules: { defaultValue: { kind: "literal", value: "seeded" } } }
    ]);
    const values = runtime.state().values;
    expect(Object.prototype.hasOwnProperty.call(values, "valueOf")).toBe(true);
    expect(values.valueOf).toBe("seeded");
  });
});

// --- Presentations: own answers, aliases, and what leaves the browser ------------

const presentationEnvelope = {
  form: { id: "presentation", version: "1.0.0" },
  client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1.0.0" }
};

function presentationRuntime(deps: Partial<FormRuntimeDependencies> & { form?: FormDefinition } = {}): FormRuntime {
  const { form: given, ...rest } = deps;
  const definition = given ?? presentationForm();
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
  modes.register({ id: "server", validate: true, sign: false, serverValidation: true });
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
    ...rest
  });
}

/** The keys of `values` a presentation's own answer would live under. */
function ownKeysOf(values: unknown): string[] {
  return Object.keys((values ?? {}) as Record<string, unknown>).filter((key) => key.startsWith("@"));
}

describe("form runtime: a presentation's own answers and keys", () => {
  it("answers no data source for the running presentation's container, and still refuses a stranger", async () => {
    // The renderer asks for every node it draws, the synthetic `@<id>` container included.
    const runtime = presentationRuntime();
    expect(runtime.startJourney("public").ok).toBe(true);
    await expect(runtime.resolveDataSource({ componentId: "@public" })).resolves.toBeUndefined();
    await expect(runtime.resolveDataSource({ componentId: "@nobody" })).rejects.toThrow(/Component not found/);
  });

  it("stores an own field under `@<presentation>.<id>`: set, read, announced — and `@` leads the first segment only", () => {
    const runtime = presentationRuntime();
    const changes: Array<{ path: string; value: unknown }> = [];
    runtime.events().subscribe(FormEventType.COMPONENT_CHANGED, (event) =>
      changes.push({ path: stringifyComponentPath(event.path as ComponentPath), value: (event.data as { value: unknown }).value })
    );
    const committed: unknown[] = [];
    runtime.events().subscribe(FormEventType.COMPONENT_COMMITTED, (event) => committed.push((event.data as { value: unknown }).value));

    expect(runtime.presentationValuePathOf("m1")).toBe("@apply.m1");
    runtime.setValue("@apply.m1", 12000);
    runtime.commitValue("@apply.m1");
    expect(runtime.state().values["@apply.m1"]).toBe(12000);
    expect(runtime.state().dirty.has("@apply.m1")).toBe(true);
    expect(changes).toEqual([{ path: "@apply.m1", value: 12000 }]);
    expect(committed).toEqual([12000]);
    expect(runtime.presentationValues()).toEqual({ m1: 12000 });

    // The grammar: `@` opens a key, and only there.
    expect(parseComponentPath("@apply.m1").segments).toEqual([{ key: "@apply" }, { key: "m1" }]);
    expect(stringifyComponentPath(parseComponentPath("@apply.rows[2].sku"))).toBe("@apply.rows[2].sku");
    for (const bad of ["apply.@m1", "a@b", "@", "@@apply.m1", "@apply.@m1"]) {
      expect(() => parseComponentPath(bad), bad).toThrow(/Invalid path segment/);
    }
  });

  it("reads and writes an alias at the form field it fills: one answer, no second copy", () => {
    const runtime = presentationRuntime();
    const path = runtime.presentationValuePathOf("work_email");
    expect(path).toBe("email");
    runtime.setValue(path as string, "ada@example.org");
    expect(runtime.state().values).toEqual({ email: "ada@example.org" });
    // Not an own answer: it is the form's.
    expect(runtime.presentationValues()).toEqual({});
    expect(runtime.submittableValues()).toEqual({ email: "ada@example.org" });

    // A worked-out value's copy shows its target; its sources are own answers.
    expect(runtime.presentationValuePathOf("income_total")).toBe("annual_income");
    runtime.setValue("@apply.m2", 500);
    expect(runtime.state().values[runtime.presentationValuePathOf("income_total") as string]).toBe(500);
    expect(runtime.presentationValues()).toEqual({ m2: 500 });

    // Not a node of the running presentation: a form component, a stranger, another presentation's.
    for (const id of ["email", "annual_income", "nobody", "contact", "public_note"]) {
      expect(runtime.presentationValuePathOf(id), id).toBeUndefined();
    }
    // In the variant: its own paragraph has a path of its own, a reference's placeholder has none.
    expect(runtime.startJourney("public").ok).toBe(true);
    expect(runtime.presentationValuePathOf("public_note")).toBe("@public.public_note");
    expect(runtime.presentationValuePathOf("@public/ref-1")).toBeUndefined();
    expect(runtime.presentationValuePathOf("work_email")).toBeUndefined();
    expect(runtime.presentationValues()).toEqual({});
    // Left: nothing is a presentation's.
    runtime.leaveJourney();
    expect(runtime.presentationValuePathOf("public_note")).toBeUndefined();
    expect(runtime.presentationIndex()).toBeUndefined();
    // The answers given through `apply` are still held, under their own keys.
    expect(runtime.state().values["@apply.m2"]).toBe(500);
  });

  it("hands the renderer a root with the presentation's container in a last slot, only while a journey with nodes of its own runs", () => {
    const runtime = presentationRuntime();
    const drawn = runtime.journeyRenderRoot();
    expect(drawn?.root.id).toBe("form");
    expect(Object.keys(drawn?.root.children ?? {})).toEqual(["content", "@presentation"]);
    // The form's own slot is the form's own, untouched.
    expect(drawn?.root.children?.content).toBe(runtime.formRoot().children?.content);
    const container = drawn?.root.children?.["@presentation"]?.[0] as ComponentNode;
    expect(container).toMatchObject({ id: "@apply", type: "container" });
    expect(container.children?.content?.map((node) => `${node.id}:${node.type}`)).toEqual(["work_email:text", "m1:number", "m2:number", "m3:number", "income_total:number"]);
    // A worked-out value is a read-only copy of its target: the target's type and settings, its own label.
    expect(container.children?.content?.[4]).toEqual({
      id: "income_total",
      type: "number",
      configuration: { label: "Annual income", max: 1_000_000, readOnly: true, presentation: { kind: "worked-out", to: "annual_income" } }
    });
    // The tree's own path builder gives the own fields their keys.
    expect(buildValuePaths(drawn?.root as ComponentNode).get("m1")).toBe("@apply.m1");
    expect(drawn?.tree.find("m1")?.type).toBe("number");
    expect(drawn?.tree.parentOf("m1")?.id).toBe("@apply");
    expect(drawn?.tree.find("email")?.type).toBe("text");
    // One object per journey: a renderer may compare it.
    expect(runtime.journeyRenderRoot()).toBe(drawn);
    // The form's own root and tree are as they were.
    expect(Object.keys(runtime.formRoot().children ?? {})).toEqual(["content"]);
    expect(runtime.componentTree().find("m1")).toBeUndefined();

    // The variant: references inside an own layout are placeholders for the renderer to replace.
    runtime.startJourney("public");
    const variant = runtime.journeyRenderRoot()?.root.children?.["@presentation"]?.[0] as ComponentNode;
    expect(variant.id).toBe("@public");
    expect(variant.children?.content?.[0]).toEqual({
      id: "contact",
      type: "grid",
      configuration: { columns: 2 },
      children: {
        content: [
          { id: "@public/ref-1", type: "journey-field", configuration: { componentId: "email" } },
          { id: "@public/ref-2", type: "journey-field", configuration: { componentId: "name" } }
        ]
      }
    });
    expect(runtime.presentationIndex()?.referenceOf["@public/ref-2"]).toEqual({ id: "@public/ref-2", componentId: "name", pageId: "all" });

    // No journey, and a journey of component ids alone: the form's root is what is drawn.
    runtime.leaveJourney();
    expect(runtime.journeyRenderRoot()).toBeUndefined();
    const idsOnly = presentationRuntime({ form: { ...presentationForm(), journey: { journeys: [{ id: "plain", pages: [{ id: "one", components: ["email", "name", "money"] }] }] } } });
    expect(idsOnly.journeyView()?.journeyId).toBe("plain");
    expect(idsOnly.journeyRenderRoot()).toBeUndefined();
    expect(idsOnly.presentationIndex()).toBeUndefined();
    expect(idsOnly.journeyView()?.hosts).toBeUndefined();
  });

  it("resolves no data source for an own node, a worked-out copy's through its target, and still refuses a stranger", async () => {
    const defs = new DataSourceRegistry();
    defs.register({ id: "bands", providerId: "static", version: "1.0.0" });
    const providers = new DataSourceProviderRegistry();
    providers.register(new StaticDataSourceProvider("static", [{ value: "low", label: "Low" }]));
    const definition = presentationForm();
    (definition.root.children?.content?.[2]?.children?.content?.[0] as ComponentNode).configuration = { label: "Annual income", required: true, data: { sourceId: "bands" } };
    const runtime = presentationRuntime({ form: definition, dataSources: new RegisteredClientDataSourceRuntime(defs, providers) });
    expect(await runtime.resolveDataSource({ componentId: "m1" })).toBeUndefined();
    expect((await runtime.resolveDataSource({ componentId: "income_total" }))?.items).toEqual([{ value: "low", label: "Low" }]);
    await expect(runtime.resolveDataSource({ componentId: "nobody" })).rejects.toThrow(/Component not found/);
  });
});

describe("form runtime: no presentation key leaves the browser", () => {
  it("keeps own answers out of every surface that is sent or handed to code that may send it, and in every one that stays", async () => {
    const seen: Record<string, unknown> = {};
    const record = (surface: string, values: unknown): void => {
      seen[surface] = JSON.parse(JSON.stringify(values ?? null));
    };

    // The fixture, with a data-sourced field, a server check on `details` and one at the end.
    const definition = presentationForm();
    definition.root.children?.content?.push({ id: "country", type: "select", configuration: { data: { sourceId: "countries" } } });
    const apply = definition.journey?.journeys?.[0] as Journey;
    apply.pages[0] = { ...(apply.pages[0] as JourneyPage), validation: { continue: "page", server: true } };
    apply.validation = { end: "server" };

    const defs = new DataSourceRegistry();
    defs.register({ id: "countries", providerId: "recording", version: "1.0.0" });
    const providers = new DataSourceProviderRegistry();
    providers.register({
      id: "recording",
      load: async (_request, context) => {
        record("data-source provider context", context.values);
        return { items: [] };
      }
    });
    const store = new InMemoryDraftStore();
    const sandbox = {
      run: async (request: WasmValidationRequest): Promise<WasmSubmissionOutcome> => {
        record("sandbox request", request.context.values);
        return { errors: [], values: request.context.values };
      }
    } as unknown as WasmValidationHost;

    const runtime = presentationRuntime({
      form: definition,
      wasmValidationHost: sandbox,
      wasmExternalDataProvider: async (context) => {
        record("sandbox external-data provider", context.values);
        return {};
      },
      serverValidationRunner: new ServerValidationRunner([
        {
          id: "recording",
          version: "1.0.0",
          validate: async (context) => {
            record("server validation runner values", context.values);
            record("server validation runner context", context.validationContext.values);
            return { errors: [{ code: "stop", stage: "server", source: "server" }] };
          }
        }
      ]),
      journeyServerValidator: async (request) => {
        record(`${request.scope} check request`, request.values);
        return { errors: [] };
      },
      dataSources: new RegisteredClientDataSourceRuntime(defs, providers),
      draftStore: store,
      versionContext: { formVersion: "1.0.0", schemaVersion: "1.0.0", rendererVersion: "1" },
      validationPipeline: new ValidationPipeline([
        createFieldConstraintsStage(definition.root),
        {
          id: "recording",
          version: "1.0.0",
          validate: (context) => {
            record("validation stage context", context.values);
            return { errors: [] };
          }
        }
      ]),
      hooks: {
        beforeValidation: [(context) => record("beforeValidation context", context.validationContext.values)],
        afterValidation: [(context) => record("afterValidation values", context.values)],
        beforeSubmit: [(context) => record("beforeSubmit context", context.values)],
        transformValues: [
          (values) => {
            record("transformValues input", values);
            // A transform cannot put one back in either.
            return { ...values, "@apply.forged": "x", "@public.forged": "y" };
          }
        ],
        afterSubmit: [(context) => record("afterSubmit values", context.values)],
        beforePageChange: [(context) => record("beforePageChange context", context.values)],
        beforeDraftSave: [(context) => record("beforeDraftSave context", context.values)],
        afterDraftLoad: [(context) => record("afterDraftLoad context", context.values)]
      }
    });
    const wasmEvents: Array<Record<string, unknown>> = [];
    runtime.events().subscribe(FormEventType.WASM_VALIDATION_COMPLETED, (event) => wasmEvents.push(event.data as Record<string, unknown>));
    const changed: string[] = [];
    runtime.events().subscribe(FormEventType.COMPONENT_CHANGED, (event) => changed.push(stringifyComponentPath(event.path as ComponentPath)));

    // Answers: the alias's through the form field's path, the month figures as own answers, and
    // one a presentation the person is not in left behind.
    runtime.setValue(runtime.presentationValuePathOf("work_email") as string, "ada@example.org");
    runtime.setValue("@apply.m1", 12000);
    runtime.setValue("@apply.m2", 12000);
    runtime.setValue("@apply.m3", 12000);
    runtime.setValue("@public.note", "left by another presentation");
    const OWN = ["@apply.m1", "@apply.m2", "@apply.m3", "@public.note"];

    expect((await runtime.nextPage()).pageId).toBe("income");
    await runtime.resolveDataSource({ componentId: "country" });
    await runtime.saveDraft("d1");
    const draft = await store.load("d1");
    const stopped = await runtime.submit("server", presentationEnvelope);
    expect(stopped.errors.map((error) => error.code)).toEqual(["stop"]);
    const sent = await runtime.submit("submit", presentationEnvelope);
    expect(sent.accepted).toBe(true);
    record("envelope", sent.canonicalSubmission?.submission.values);
    record("sandbox exchange event", wasmEvents[0]?.requestValues);
    record("effectiveValues", runtime.submittableValues());
    record("formValues", runtime.formValues());
    const unvalidated = await runtime.submit("send", presentationEnvelope);
    record("envelope, unvalidated mode", unvalidated.canonicalSubmission?.submission.values);

    // One assertion per surface: none holds a presentation key, and each was reached.
    const never = [
      "envelope",
      "envelope, unvalidated mode",
      "sandbox request",
      "sandbox exchange event",
      "sandbox external-data provider",
      "server validation runner values",
      "server validation runner context",
      "page check request",
      "journey check request",
      "beforeSubmit context",
      "transformValues input",
      "afterSubmit values",
      "validation stage context",
      "beforeValidation context",
      "afterValidation values",
      "data-source provider context",
      "beforePageChange context",
      "effectiveValues",
      "formValues"
    ];
    for (const surface of never) {
      expect(seen[surface], surface).not.toBeNull();
      expect(seen[surface], surface).toBeDefined();
      expect(ownKeysOf(seen[surface]), surface).toEqual([]);
    }
    expect(seen.envelope).toEqual({ email: "ada@example.org", annual_income: 36000 });
    expect(seen["sandbox request"]).toEqual({ email: "ada@example.org", annual_income: 36000 });
    expect(seen["page check request"]).toEqual({ email: "ada@example.org", annual_income: 36000 });
    expect(seen["journey check request"]).toEqual({ email: "ada@example.org", annual_income: 36000 });

    // And the ones that stay with the person do carry them.
    expect(ownKeysOf(draft.values)).toEqual(OWN);
    expect(ownKeysOf(seen["beforeDraftSave context"])).toEqual(OWN);
    expect(ownKeysOf(runtime.state().values)).toEqual(OWN);
    expect(changed.filter((path) => path.startsWith("@"))).toEqual(OWN);
    expect(runtime.presentationValues()).toEqual({ m1: 12000, m2: 12000, m3: 12000 });
    const reader = presentationRuntime({ form: definition, draftStore: store, versionContext: { formVersion: "1.0.0", schemaVersion: "1.0.0", rendererVersion: "1" }, hooks: { afterDraftLoad: [(context) => record("afterDraftLoad context", context.values)] } });
    await reader.hydrateFromDraft(draft);
    expect(ownKeysOf(seen["afterDraftLoad context"])).toEqual(OWN);
    expect(reader.presentationValues()).toEqual({ m1: 12000, m2: 12000, m3: 12000 });
  });
});

/**
 * Formulas in the runtime: the definition is compiled into a copy at construction
 * and the author's object never changes; a formula that does not parse is judged by the
 * policy; a rule scoped to the server is ignored here; the day comes from the host.
 */
describe("form runtime: formulas, the policy, the day and the run scopes", () => {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "normal", validate: true, sign: false, serverValidation: false });
  const envelope = { form: { id: "f1", version: "1" }, client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" } };

  function definition(rules: Record<string, ComponentNode["rules"]>, configuration: Record<string, unknown> = {}): FormDefinition {
    return {
      id: "f1",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration,
        children: {
          // `flag` is a checkbox group's answer, so a list is one it may hold (a text field refuses one).
          content: Object.entries(rules).map(([id, own]) => ({ id, type: id === "dob" ? "date" : id === "flag" ? "checkboxes" : "text", configuration: {}, ...(own !== undefined ? { rules: own } : {}) }))
        }
      }
    };
  }

  function build(form: FormDefinition, deps: Partial<FormRuntimeDependencies> = {}): FormRuntime {
    return new FormRuntime(form, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
      ...deps
    });
  }

  it("reads a condition as holding only for true: a text, a number or an empty list neither shows, requires, enables nor makes read-only (strict truthiness)", () => {
    const form = definition({
      flag: undefined,
      shown: { visibleWhen: "flag" },
      needed: { requiredWhen: "flag" },
      editable: { enabledWhen: "flag" },
      locked: { readonlyWhen: "flag" },
      sized: { visibleWhen: "len(flag)" }
    });
    for (const [answer, holds] of [["yes", false], [1, false], [[], false], [true, true]] as const) {
      const runtime = build(form);
      runtime.setValue("flag", answer);
      const label = JSON.stringify(answer);
      expect(runtime.effectiveState("shown")?.visible, label).toBe(holds);
      expect(runtime.isRequired("needed"), label).toBe(holds);
      expect(runtime.effectiveState("editable")?.disabled, label).toBe(!holds);
      expect(runtime.effectiveState("locked")?.readonly, label).toBe(holds);
      // A condition that is no yes-or-no never holds, however full the answer; the compile warns about it, the run is not refused.
      expect(runtime.effectiveState("sized")?.visible, label).toBe(false);
    }
  });

  it("evaluates a string rule exactly as its tree, and defaults the policy to fail", () => {
    const tree: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "name" }, right: { kind: "literal", value: "Ada" } };
    const asTrees = build(definition({ name: undefined, greeting: { visibleWhen: tree, value: { kind: "call", name: "concat", args: [{ kind: "literal", value: "Hi " }, { kind: "path", path: "name" }] } } }));
    const asText = build(definition({ name: undefined, greeting: { visibleWhen: 'name = "Ada"', value: 'concat("Hi ", name)' } }));
    for (const runtime of [asTrees, asText]) {
      expect(runtime.formulaErrorPolicy()).toBe("fail");
      expect(runtime.formulaProblems()).toEqual([]);
      expect(runtime.effectiveState("greeting")?.visible).toBe(false);
      runtime.setValue("name", "Ada");
      expect(runtime.effectiveState("greeting")?.visible).toBe(true);
      expect(runtime.state().values.greeting).toBe("Hi Ada");
    }
    // The compiled root the runtime reads holds the same trees either way; the author's definition is handed back as given.
    expect(asText.formRoot().children?.content?.[1]?.rules).toEqual(asTrees.formRoot().children?.content?.[1]?.rules);
    expect(asText.definition().root.children?.content?.[1]?.rules).toEqual({ visibleWhen: 'name = "Ada"', value: 'concat("Hi ", name)' });
  });

  it("leaves the author's definition byte-identical through construction and submit, hands that very object back from definition(), and reads a compiled copy of its own", async () => {
    const form = definition({ name: undefined, greeting: { visibleWhen: 'name = "Ada"', value: { formula: 'concat("Hi ", name)', run: "both" } } });
    const before = JSON.stringify(form);
    const runtime = build(form, { wasmValidationHost: createInProcessWasmValidationHost([]) });
    expect(JSON.stringify(form)).toBe(before);
    // A host hashes or stores what it gets back: the same object it handed in, not a copy.
    expect(runtime.definition()).toBe(form);
    expect(runtime.definition().root).toBe(form.root);
    // The root the runtime reads is the compiled copy's: the tree's own nodes, every formula a tree.
    expect(runtime.formRoot()).not.toBe(form.root);
    expect(runtime.formRoot().children?.content?.[1]?.rules?.visibleWhen).toEqual(expect.objectContaining({ kind: "binary" }));
    expect(runtime.formRoot().children?.content?.[1]?.configuration).toBe(form.root.children?.content?.[1]?.configuration);
    runtime.setValue("name", "Ada");
    const result = await runtime.submit("normal", envelope);
    expect(result.accepted).toBe(true);
    expect(JSON.stringify(form)).toBe(before);
  });

  it("reads a journey as the kernel reads it: a malformed when is a formula problem on both sides, reported at the same place, and both sides keep or refuse the journey alike", () => {
    // A formula that does not parse is reported and dropped, and the journey kept; a value of no
    // shape is reported as invalidRule and kept as written, so the shape check refuses the journey
    // on both sides (dropped here, journey.invalid in the kernel). Never one side without the other.
    const cases: Array<[unknown, "kept" | "refused"]> = [
      ["bad formula (", "kept"],
      [7, "refused"]
    ];
    for (const [when, fate] of cases) {
      const form = definition({ name: undefined, note: undefined });
      form.journey = {
        journeys: [
          {
            id: "j",
            pages: [
              { id: "first", components: ["name"], routes: [{ to: "second", when: when as never }] },
              { id: "second", components: ["note"], routes: [{ to: "$end", when: when as never }] }
            ]
          }
        ]
      };
      const before = JSON.stringify(form);
      const label = JSON.stringify(when);
      // The default refuses; the warn opt-in keeps what can be kept.
      expect(() => build(form), label).toThrow(FormulaError);
      const runtime = build(form, { formulaErrors: "warn" });
      const where = runtime.formulaProblems().map((problem) => problem.where);
      expect(where, label).toEqual(["journey:j:page:first:route:0", "journey:j:page:second:route:0"]);
      expect(runtime.journeys().map((journey) => journey.id), label).toEqual(fate === "kept" ? ["j"] : []);
      if (fate === "kept") {
        expect(runtime.journeys()[0]?.pages.map((page) => page.routes?.[0]?.when), label).toEqual([undefined, undefined]);
      }
      expect(JSON.stringify(form), label).toBe(before);
      expect(() => build(form, { formulaErrors: "fail" }), label).toThrow(FormulaError);

      // The kernel, over the author's root and journey as a server holds them, reports the same problems at the same places.
      const context = { formId: "f1", values: {}, locale: "en", form: form.root, journey: form.journey?.journeys?.[0] as Journey };
      const warned = runKernel({ ...context, formulaErrors: "warn" }, [], undefined, formulaFunctionSignatures());
      expect(warned.errors.some((error) => error.code === "journey.invalid"), label).toBe(fate === "refused");
      expect(
        (warned.logs ?? []).filter((entry) => entry.message.startsWith("formula invalid: ")).map((entry) => entry.message.split(": ")[1]),
        label
      ).toEqual(where);
      const refused = runKernel({ ...context, formulaErrors: "fail" }, [], undefined, formulaFunctionSignatures());
      expect(refused.errors.map((error) => error.code), label).toEqual(["formula.invalid", "formula.invalid"]);
      expect(refused.errors.map((error) => error.parameters?.where), label).toEqual(where);
      expect(JSON.stringify(form), label).toBe(before);
    }
  });

  it("warns about a formula that does not parse, drops the rule, and publishes FORMULA_INVALID with the problems", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const published: unknown[] = [];
      const bus = new EventBus();
      bus.subscribe(FormEventType.FORMULA_INVALID, (event) => published.push(event.data));
      const form = definition({ a: { visibleWhen: "a = " }, b: { requiredWhen: { formula: "true", run: "both" } } });
      // The default refuses; warn is the explicit opt-in.
      expect(() => build(form)).toThrow(FormulaError);
      const runtime = build(form, { eventBus: bus, formulaErrors: "warn" });
      expect(runtime.formulaProblems()).toEqual([expect.objectContaining({ where: "rules:a:visibleWhen", code: "expectedValue", text: "a = " })]);
      expect(runtime.formulaErrorPolicy()).toBe("warn");
      expect(published).toEqual([{ problems: runtime.formulaProblems() }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/^\[FormRuntime\] Form "f1" definition: rules:a:visibleWhen: /);
      // The broken rule is absent, the sound one applies.
      expect(runtime.effectiveState("a")?.visible).toBe(true);
      expect(runtime.isRequired("b")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses the definition under fail, by default, from the host's word or the form's own setting, and reads a word that is neither as no word", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A word that is neither `warn` nor `fail` is no word: the default refuses.
      expect(() => build(definition({ a: { visibleWhen: "a = " } }), { formulaErrors: "ignore" as never })).toThrow(FormulaError);
      expect(() => build(definition({ a: { visibleWhen: "a = " } }, { formulaErrors: "ignore" }))).toThrow(FormulaError);

      // The default (nothing said by the host or the form) refuses.
      expect(() => build(definition({ a: { visibleWhen: "a = " } }))).toThrow(FormulaError);

      let thrown: unknown;
      try {
        build(definition({ a: { visibleWhen: "a = " } }), { formulaErrors: "fail" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(FormulaError);
      expect((thrown as FormulaError).formId).toBe("f1");
      expect((thrown as FormulaError).problems).toEqual([expect.objectContaining({ where: "rules:a:visibleWhen" })]);
      expect((thrown as FormulaError).message).toMatch(/1 formula problem: rules:a:visibleWhen: /);

      // The form's own setting, and the host's word over it.
      expect(() => build(definition({ a: { visibleWhen: "a = " } }, { formulaErrors: "fail" }))).toThrow(FormulaError);
      expect(build(definition({ a: { visibleWhen: "a = " } }, { formulaErrors: "fail" }), { formulaErrors: "warn" }).formulaErrorPolicy()).toBe("warn");
    } finally {
      warn.mockRestore();
    }
  });

  // A literal matches pattern that repeats a repeat is a formula problem, unless the host allows it.
  it("refuses a literal risky matches pattern as pattern.risky, drops it under warn, and compiles it when the host allows risky patterns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const risky = (): FormDefinition => definition({ a: { visibleWhen: 'matches(b, "(x+)+$")' } });
      expect(() => build(risky())).toThrow(FormulaError);
      let thrown: unknown;
      try {
        build(risky());
      } catch (error) {
        thrown = error;
      }
      expect((thrown as FormulaError).problems).toEqual([expect.objectContaining({ where: "rules:a:visibleWhen", code: "pattern.risky", params: { pattern: "(x+)+$" } })]);
      const warned = build(risky(), { formulaErrors: "warn" });
      expect(warned.formulaProblems()).toEqual([expect.objectContaining({ code: "pattern.risky" })]);
      expect(warned.effectiveState("a")?.visible).toBe(true);
      const allowed = build(risky(), { riskyPatterns: "allow" });
      expect(allowed.formulaProblems()).toEqual([]);
      expect(compileFormDefinition(risky()).problems).toHaveLength(1);
      expect(compileFormDefinition(risky(), { riskyPatterns: "allow" }).problems).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  // `condition.notBoolean` warnings are read at construction, one console line each.
  it("writes one console warning per condition that is provably no yes-or-no, and refuses nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runtime = build(definition({ a: { visibleWhen: "b + 1" }, b: { requiredWhen: "b > 1" } }));
      const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("condition"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("rules:a:visibleWhen");
      expect(runtime.formulaProblems()).toEqual([]);
      expect(runtime.effectiveState("a")?.visible).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("reports a server scope on a default as a problem and runs the default in the browser anyway", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const form = definition({ a: { defaultValue: { formula: '"start"', run: "server" } } });
      expect(() => build(form)).toThrow(FormulaError);
      const runtime = build(form, { formulaErrors: "warn" });
      expect(runtime.formulaProblems()).toEqual([expect.objectContaining({ where: "rules:a:defaultValue", code: "runScope", params: { key: "defaultValue", run: "server" } })]);
      expect(runtime.state().values.a).toBe("start");
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores a rule scoped to the server in the browser, and tells the sandbox the day and the policy at submit", async () => {
    const runtime = build(
      definition({
        secret: { visibleWhen: { formula: "false", run: "server-secret" }, requiredWhen: { formula: "true", run: "server" } },
        mine: { visibleWhen: { formula: "false", run: "browser" } }
      }),
      { today: "2026-10-07", formulaErrors: "warn" }
    );
    expect(runtime.effectiveState("secret")?.visible).toBe(true);
    expect(runtime.isRequired("secret")).toBe(false);
    expect(runtime.effectiveState("mine")?.visible).toBe(false);

    const contexts: Array<Record<string, unknown>> = [];
    const abi = new JsonWasmAbi();
    const host = new WasmValidationHost([], {
      abi,
      instance: {
        abiVersion: abi.version,
        run: (serialized) => {
          contexts.push(JSON.parse(serialized) as Record<string, unknown>);
          return abi.serializeOutcome({ errors: [], values: {} });
        }
      }
    });
    const submitting = build(definition({ name: undefined }), { today: "2026-10-07", formulaErrors: "warn", wasmValidationHost: host });
    await submitting.submit("normal", envelope);
    expect(contexts[0]).toMatchObject({ today: "2026-10-07", formulaErrors: "warn" });
    await submitting.submit("normal", envelope, { formulaErrors: "fail" });
    expect(contexts[1]).toMatchObject({ formulaErrors: "fail" });
    // Without a host's word the sandbox reads the form's own setting: nothing is sent.
    const silent = build(definition({ name: undefined }), { wasmValidationHost: host });
    await silent.submit("normal", envelope);
    expect(contexts[2]).not.toHaveProperty("formulaErrors");
    expect(contexts[2]?.today).toBe(localCalendarDate(new Date()));
  });

  describe("a plugin function that throws while a rule is evaluated", () => {
    const throwing = (): FormulaFunctionRegistry => {
      const registry = new FormulaFunctionRegistry();
      registry.register(
        {
          name: "boom",
          params: ["text"],
          summary: "",
          example: "",
          evaluate: () => {
            throw new Error("boom");
          }
        },
        "p"
      );
      return registry;
    };
    const rules = (configuration: Record<string, unknown> = {}) => {
      const form = definition({ name: undefined, b: { visibleWhen: "boom(name)" } }, configuration);
      (form.root.children!.content![1]! as { configuration: Record<string, unknown> }).configuration = { required: true };
      return form;
    };

    it("refuses the validation under fail, naming the rule and the function, as the sandbox does", async () => {
      const runtime = build(rules({ formulaErrors: "fail" }), { formulaFunctions: throwing() });
      const errors = await runtime.validate();
      const refused = errors.filter((error) => error.code === "formula.invalid");
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        stage: "definition",
        severity: "error",
        parameters: { where: "rules:b", function: "boom", message: 'function "boom" threw: boom' }
      });
      const result = await runtime.submit("normal", envelope);
      expect(result.accepted).toBe(false);
      expect(result.errors.some((error) => error.code === "formula.invalid")).toBe(true);
      expect(runtime.formulaErrorPolicy()).toBe("fail");
    });

    it("refuses under the default policy too (the default is fail)", async () => {
      const runtime = build(rules(), { formulaFunctions: throwing() });
      const errors = await runtime.validate();
      expect(errors.some((error) => error.code === "formula.invalid")).toBe(true);
      expect(runtime.formulaErrorPolicy()).toBe("fail");
    });

    it("says nothing under the explicit warn opt-in, and the rule reads nothing as before", async () => {
      const runtime = build(rules({ formulaErrors: "warn" }), { formulaFunctions: throwing() });
      const errors = await runtime.validate();
      expect(errors.some((error) => error.code === "formula.invalid")).toBe(false);
      expect(runtime.effectiveState("b")?.visible).toBe(false);
    });

    it("does not refuse when the function does not throw", async () => {
      const registry = new FormulaFunctionRegistry();
      registry.register({ name: "boom", params: ["text"], summary: "", example: "", evaluate: () => true }, "p");
      const runtime = build(rules({ formulaErrors: "fail" }), { formulaFunctions: registry });
      const errors = await runtime.validate();
      expect(errors.some((error) => error.code === "formula.invalid")).toBe(false);
    });
  });

  it("blocks on any severity but warning and info, as the kernel does", async () => {
    const stage = (severity: string) => ({
      id: `s_${severity}`,
      version: "1.0.0",
      validate: async () => ({ errors: [{ code: "x.bad", stage: "custom", source: "custom" as const, severity: severity as never }] })
    });
    for (const [severity, blocking] of [["Error", true], ["fatal", true], ["error", true], ["warning", false], ["info", false]] as const) {
      const form = definition({ name: undefined });
      const runtime = new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([stage(severity)]) });
      const result = await runtime.submit("normal", envelope);
      expect(result.accepted, severity).toBe(!blocking);
    }
  });

  it("drives a calculation and a visibility rule from a fixed day, read live from a function", () => {
    let day = "2026-10-07";
    const runtime = build(
      definition({
        dob: undefined,
        age: { value: "age(dob)" },
        adult: { visibleWhen: "age >= 18" },
        soon: { visibleWhen: 'today() < "2027-01-01"' }
      }),
      { today: () => day }
    );
    expect(runtime.today()).toBe("2026-10-07");
    runtime.setValue("dob", "2008-10-08");
    expect(runtime.state().values.age).toBe(17);
    expect(runtime.effectiveState("adult")?.visible).toBe(false);
    expect(runtime.effectiveState("soon")?.visible).toBe(true);
    day = "2027-03-01";
    expect(runtime.today()).toBe("2027-03-01");
    // Another answer, so the write recomputes (one of the answer already stored changes nothing):
    // eighteen on the new day, seventeen on the old one.
    runtime.setValue("dob", "2009-02-28");
    expect(runtime.state().values.age).toBe(18);
    expect(runtime.effectiveState("adult")?.visible).toBe(true);
    expect(runtime.effectiveState("soon")?.visible).toBe(false);
  });

  it("defaults the day to the local calendar date, never the UTC one", () => {
    const runtime = build(definition({ name: undefined }));
    expect(runtime.today()).toBe(localCalendarDate(new Date()));
    expect(runtime.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(localCalendarDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(localCalendarDate(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
    expect(localCalendarDate(new Date(999, 0, 1))).toBe("0999-01-01");
  });

  it("compiles a definition for a host: a copy with every formula a tree and the problems, the plugins' functions known", () => {
    const form = definition({ a: { visibleWhen: "shout(name) = \"ADA\"" }, b: { value: "b = " } });
    const unknown = compileFormDefinition(form);
    expect(unknown.problems.map((problem) => `${problem.where}:${problem.code}`)).toEqual(["rules:a:visibleWhen:unknownFunction", "rules:b:value:expectedValue"]);
    const known = compileFormDefinition(form, {
      plugins: [{ id: "p", version: "1.0.0", formulaFunctions: [{ name: "shout", params: ["text"], summary: "", example: "", evaluate: (args) => String(args[0]).toUpperCase() }] }]
    });
    expect(known.problems.map((problem) => problem.where)).toEqual(["rules:b:value"]);
    expect(known.definition.root.children?.content?.[0]?.rules?.visibleWhen).toMatchObject({ kind: "binary", operator: "eq" });
    expect(known.definition).not.toBe(form);
    expect(form.root.children?.content?.[0]?.rules?.visibleWhen).toBe('shout(name) = "ADA"');
  });
});

describe("form runtime: the plugins a platform installed ride in the submission's versionContext", () => {
  it("reports an installed platform plugin with its version under client.plugins", async () => {
    const plugins = new PluginRegistry();
    plugins.register({ id: "demo-double", version: "2.3.4" });
    const pluginPlatform = new PluginPlatform({
      plugins,
      components: new ComponentRegistry(),
      validators: new ValidatorRegistry(),
      dataSourceProviders: new DataSourceProviderRegistry(),
      dataSources: new DataSourceRegistry()
    });
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(form(), { submissionModes: modes, validationPipeline: new ValidationPipeline([]), pluginPlatform });
    const result = await runtime.submit("validate", {
      form: { id: "f1", version: "1" },
      client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" }
    });
    expect(result.canonicalSubmission?.versionContext.client.plugins).toEqual({ "demo-double": "2.3.4" });
  });
});

describe("FormRuntime batched writes", () => {
  const rowsForm = (): FormDefinition => ({
    id: "batched",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "first", type: "text", configuration: { label: "First" } },
          { id: "second", type: "text", configuration: { label: "Second" } },
          {
            id: "rows",
            type: "repeatingSection",
            configuration: { label: "Rows" },
            collection: { itemFields: ["rowText"] },
            children: { content: [{ id: "rowText", type: "text", configuration: { label: "Row text" } }] }
          }
        ]
      }
    }
  });

  it("setValues writes every answer with one recompute and reports the writes that threw", () => {
    const runtime = new FormRuntime(rowsForm(), {} as never);
    const recompute = vi.spyOn(runtime["orchestrator"], "recompute");
    const failed = runtime.setValues({ first: "a", second: "b", "bad[": "x" });
    expect(runtime.state().values.first).toBe("a");
    expect(runtime.state().values.second).toBe("b");
    expect(failed.map((item) => item.path)).toEqual(["bad["]);
    expect(recompute).toHaveBeenCalledTimes(1);
  });

  it("addRows appends all the rows with one sync, one event and one recompute, and keeps the row keys", () => {
    const runtime = new FormRuntime(rowsForm(), {} as never);
    const changes: unknown[] = [];
    runtime.events().subscribe(FormEventType.COLLECTION_CHANGED, (event) => changes.push(event.data));
    const recompute = vi.spyOn(runtime["orchestrator"], "recompute");
    const indices = runtime.addRows("rows", [{ rowText: "a" }, { rowText: "b" }, { rowText: "c" }]);
    expect(indices).toEqual([0, 1, 2]);
    expect(runtime.rows("rows").map((row) => row.rowText)).toEqual(["a", "b", "c"]);
    expect(runtime.state().values["rows[2].rowText"]).toBe("c");
    expect(changes).toEqual([{ collectionPath: "rows", action: "add", rowCount: 3 }]);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(runtime.addRows("rows", [])).toEqual([]);
    runtime.removeRow("rows", 1);
    expect(Object.keys(runtime.state().values).filter((key) => key.startsWith("rows["))).toEqual(["rows[0].rowText", "rows[1].rowText"]);
    expect(runtime.state().values["rows[1].rowText"]).toBe("c");
  });
});

describe("FormRuntime data source timeout", () => {
  const selectForm = (): FormDefinition => ({
    id: "timed",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "country", type: "select", configuration: { data: { sourceId: "countries" } } }] }
    }
  });
  const modes = () => {
    const registry = new SubmissionModeRegistry();
    registry.register({ id: "normal", validate: false, sign: false, serverValidation: false });
    return registry;
  };
  const never = { load: () => new Promise<never>(() => undefined) };

  it("a source that never answers fails after dataSourceTimeoutMs naming the source, and publishes the failure", async () => {
    const runtime = new FormRuntime(selectForm(), {
      submissionModes: modes(),
      validationPipeline: new ValidationPipeline([]),
      dataSources: never,
      dataSourceTimeoutMs: 40
    });
    const failures: unknown[] = [];
    runtime.events().subscribe(FormEventType.DATA_SOURCE_RESOLVE_FAILED, (event) => failures.push(event.data));
    await expect(runtime.resolveDataSource({ componentId: "country" })).rejects.toThrow(/"countries" did not answer within 40 ms/);
    expect(failures).toEqual([expect.objectContaining({ componentId: "country", sourceId: "countries" })]);
  });

  it("a source that answers nothing has failed: the runtime throws instead of returning the no-source signal", async () => {
    const runtime = new FormRuntime(selectForm(), {
      submissionModes: modes(),
      validationPipeline: new ValidationPipeline([]),
      dataSources: { load: async () => undefined as never }
    });
    await expect(runtime.resolveDataSource({ componentId: "country" })).rejects.toThrow('The data source "countries" answered nothing');
  });

  it("an answer inside the limit is returned and leaves no timer behind; 0 means no limit", async () => {
    const answering = { load: async () => ({ items: [{ value: "CA", label: "Canada" }] }) };
    const timed = new FormRuntime(selectForm(), {
      submissionModes: modes(),
      validationPipeline: new ValidationPipeline([]),
      dataSources: answering,
      dataSourceTimeoutMs: 40
    });
    expect((await timed.resolveDataSource({ componentId: "country" }))?.items).toHaveLength(1);
    const unlimited = new FormRuntime(selectForm(), {
      submissionModes: modes(),
      validationPipeline: new ValidationPipeline([]),
      dataSources: { load: () => new Promise((resolve) => setTimeout(() => resolve({ items: [] }), 80)) },
      dataSourceTimeoutMs: 0
    });
    expect((await unlimited.resolveDataSource({ componentId: "country" }))?.items).toEqual([]);
  });
});

describe("FormRuntime hands the sandbox the option snapshot", () => {
  const selectForm = (): FormDefinition => ({
    id: "snap",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "country", type: "select", configuration: { data: { sourceId: "countries" } } },
          { id: "note", type: "text", configuration: {} }
        ]
      }
    }
  });
  const runWith = async (dataSources: FormRuntimeDependencies["dataSources"], country: string, form: FormDefinition = selectForm()) => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "normal", validate: true, sign: false, serverValidation: false });
    const contexts: Array<{ optionSnapshot?: unknown }> = [];
    const host = createInProcessWasmValidationHost({ id: "snap", version: "1.0.0", validate: () => ({ errors: [] }) });
    const run = host.run.bind(host);
    host.run = (request) => {
      contexts.push(request.context as { optionSnapshot?: unknown });
      return run(request);
    };
    const runtime = new FormRuntime(form, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([]),
      wasmValidationHost: host,
      ...(dataSources ? { dataSources } : {}),
      dataSourceTimeoutMs: 40
    });
    runtime.setValue("country", country);
    const result = await runtime.submit("normal", { form: { id: "snap", version: "1.0.0" }, client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" } });
    return { result, contexts };
  };
  const countries = { load: async () => ({ items: [{ value: "CA", label: "Canada" }] }) };

  it("sends each named source's list as optionSnapshot, and the answer in it is accepted", async () => {
    const { result, contexts } = await runWith(countries, "CA");
    expect(contexts[0]!.optionSnapshot).toEqual({ countries: [{ value: "CA", label: "Canada" }] });
    expect(result.accepted).toBe(true);
  });

  it("sends localized labels as plain strings, the answer judged by value", async () => {
    const localized = {
      load: async () => ({
        items: [{ value: "CA", label: { default: "Canada", locales: { en: "Canada (en)" } }, description: { default: "North" } }]
      })
    };
    const { result, contexts } = await runWith(localized, "CA");
    expect(contexts[0]!.optionSnapshot).toEqual({ countries: [{ value: "CA", label: "Canada (en)", description: "North" }] });
    expect(result.accepted).toBe(true);
  });

  it("refuses an answer outside the list the source gave", async () => {
    const { result } = await runWith(countries, "US");
    expect(result.accepted).toBe(false);
    expect(result.errors).toMatchObject([{ code: "option.notAllowed", componentId: "country" }]);
  });

  it.each<[string, FormRuntimeDependencies["dataSources"]]>([
    ["throws", { load: async () => { throw new Error("down"); } }],
    ["never answers", { load: () => new Promise<never>(() => undefined) }],
    ["answers something that is not a list", { load: async () => ({ items: "CA" }) as never }],
    ["is not wired at all", undefined]
  ])("leaves a source that %s out of the snapshot, so the answer is refused (fail closed)", async (_name, source) => {
    const { result, contexts } = await runWith(source, "CA");
    expect(contexts[0]!.optionSnapshot === undefined || !("countries" in (contexts[0]!.optionSnapshot as object))).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.errors).toMatchObject([{ code: "option.sourceUnavailable", componentId: "country" }]);
  });

  it("loads nothing for a source whose answers the author declared free, and accepts any text", async () => {
    const load = vi.fn(async () => ({ items: [{ value: "CA", label: "Canada" }] }));
    const free: FormDefinition = {
      ...selectForm(),
      root: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "country", type: "select", configuration: { data: { sourceId: "countries", answersFree: true } } }] } }
    };
    const { result, contexts } = await runWith({ load }, "Atlantis", free);
    expect(contexts[0]!.optionSnapshot).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(result.accepted).toBe(true);
  });

  it("sends no snapshot for a form that names no source, and loads nothing", async () => {
    const load = vi.fn(async () => ({ items: [] }));
    const inline: FormDefinition = {
      ...selectForm(),
      root: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "country", type: "select", configuration: { options: [{ value: "CA", label: "Canada" }] } }] } }
    };
    const { result, contexts } = await runWith({ load }, "CA", inline);
    expect(contexts[0]!.optionSnapshot).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(result.accepted).toBe(true);
  });
});

describe("recompute reads the live store without copying", () => {
  it("leaves a deep-frozen store untouched", () => {
    const runtime = new FormRuntime(form(), { validationPipeline: new ValidationPipeline([]), submissionModes: new SubmissionModeRegistry() });
    runtime.setValue("firstName", "Ada");
    const store = (runtime as unknown as { stateStore: { readView(): any } }).stateStore;
    const live = store.readView();
    const trap = (): never => {
      throw new Error("recompute wrote the store");
    };
    for (const set of [live.touched, live.dirty, live.navigation.visitedSteps, live.navigation.completedSteps] as Set<string>[]) {
      set.add = trap;
      set.delete = trap;
      set.clear = trap;
    }
    Object.freeze(live.values);
    Object.freeze(live.touched);
    Object.freeze(live.dirty);
    Object.freeze(live.navigation.visitedSteps);
    const before = JSON.stringify([live.values, [...live.dirty], [...live.touched]]);
    expect(() => (runtime as unknown as { recompute(paths?: string[]): void }).recompute(["firstName"])).not.toThrow();
    expect(JSON.stringify([live.values, [...live.dirty], [...live.touched]])).toBe(before);
  });

  it("hands out an independent snapshot", () => {
    const runtime = new FormRuntime(form(), { validationPipeline: new ValidationPipeline([]), submissionModes: new SubmissionModeRegistry() });
    runtime.setValue("firstName", "Ada");
    const taken = runtime.state();
    runtime.setValue("firstName", "Grace");
    expect(taken.values.firstName).toBe("Ada");
    expect(runtime.state().values.firstName).toBe("Grace");
    expect(taken.dirty).not.toBe(runtime.state().dirty);
  });
});

describe("the host's translation catalog words a pattern's message in both stages", () => {
  const envelope = {
    form: { id: "cat", version: "1" },
    client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" }
  };
  const shape: FormDefinition = {
    id: "cat",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "postcode", type: "text", configuration: { pattern: "[A-Z]\\d[A-Z] ?\\d[A-Z]\\d", patternMessage: "Use the form A1A 1A1" } }] }
    },
    translations: { "fr-CA": { components: { postcode: { patternMessage: { text: "Format A1A 1A1 (carte)", source: "x" } } } } }
  };
  const catalog = { "fr-CA": { components: { postcode: { patternMessage: "Format A1A 1A1 (catalogue)" } } } };

  async function patternMessage(options: { browser: boolean; wasm: boolean; catalog?: typeof catalog | undefined; host?: WasmValidationHost }): Promise<unknown> {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(shape, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline(options.browser ? [createFieldConstraintsStage(shape.root)] : []),
      ...(options.wasm ? { wasmValidationHost: options.host ?? createInProcessWasmValidationHost([]) } : {}),
      ...(options.catalog !== undefined ? { translationCatalog: options.catalog } : {})
    });
    runtime.setLocale("fr-CA");
    runtime.setValue("postcode", "nope");
    const result = await runtime.submit("submit", envelope);
    return result.errors.find((error) => error.code === "pattern")?.parameters?.message;
  }

  it("the browser stage words it from the catalog over the map, and from the map without one", async () => {
    expect(await patternMessage({ browser: true, wasm: false, catalog })).toBe("Format A1A 1A1 (catalogue)");
    expect(await patternMessage({ browser: true, wasm: false })).toBe("Format A1A 1A1 (carte)");
  });

  it("the sandbox run carries the catalog and words it the same way", async () => {
    expect(await patternMessage({ browser: false, wasm: true, catalog })).toBe("Format A1A 1A1 (catalogue)");
    expect(await patternMessage({ browser: false, wasm: true })).toBe("Format A1A 1A1 (carte)");
    expect(await patternMessage({ browser: false, wasm: true, catalog: {} as typeof catalog })).toBe("Format A1A 1A1 (carte)");
  });

  it("an empty catalog is left out of what the sandbox receives, a non-empty one is carried", async () => {
    const sent = async (given: typeof catalog | undefined): Promise<Record<string, unknown>> => {
      const host = createInProcessWasmValidationHost([]);
      const run = vi.spyOn(host, "run");
      await patternMessage({ browser: false, wasm: true, host, catalog: given });
      expect(run).toHaveBeenCalledTimes(1);
      return run.mock.calls[0]![0].context as unknown as Record<string, unknown>;
    };
    expect("catalog" in (await sent({} as typeof catalog))).toBe(false);
    expect("catalog" in (await sent(undefined))).toBe(false);
    expect((await sent(catalog)).catalog).toEqual(catalog);
  });

  it("a null catalog from a JavaScript embedder is no catalog: both sides word from the map", async () => {
    const none = null as never;
    expect(await patternMessage({ browser: true, wasm: false, catalog: none })).toBe("Format A1A 1A1 (carte)");
    expect(await patternMessage({ browser: false, wasm: true, catalog: none })).toBe("Format A1A 1A1 (carte)");
  });
});
