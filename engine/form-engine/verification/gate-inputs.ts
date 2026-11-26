import type { ReleaseGateInput } from "./release-gates.js";
import { ValidationPipeline } from "../validation/core/validation-pipeline.js";
import type { WasmValidationHost } from "../validation/wasm/wasm-validation-host.js";
import { createInProcessWasmValidationHost } from "../validation/wasm/in-process-host.js";
import { ServerValidationRunner } from "../validation/server/server-validation.js";
import { createBrowserAdapter } from "../validation/parity/browser-adapter.js";
import { createWasmAdapter } from "../validation/parity/wasm-adapter.js";
import { createServerAdapter } from "../validation/parity/server-adapter.js";
import { runParity } from "../validation/parity/parity-runner.js";
import {
  coreDeterministicValidator,
  coreValidationRoot,
  coreValidationStage,
  coreValidationVectors
} from "../validation/parity/vectors.js";
import { buildRenderOutput } from "../render/core/render-orchestrator.js";
import { ComponentTree } from "../core/tree/component-tree.js";
import { FormStateStore } from "../core/state/form-state.js";
import { PluginRegistry } from "../registry/plugins/plugin-registry.js";
import { ComponentRegistry } from "../registry/components/component-registry.js";
import { ValidatorRegistry } from "../registry/validators/validator-registry.js";
import { BuilderThemeRegistry } from "../builder/web-component/builder-theme-registry.js";
import { PdfThemeRegistry } from "../render/pdf/pdf-theme-registry.js";
import { DataSourceRegistry } from "../registry/data-sources/data-source-registry.js";
import { DataSourceProviderRegistry } from "../data/providers/data-source-provider-registry.js";
import { PluginPlatform } from "../plugins/platform/plugin-platform.js";
import type { ComponentNode } from "../core/schema/types.js";
import type { DataSourceResolver } from "../render/core/component-options.js";
import { buildPdfRenderModel } from "../render/pdf/pdf-render-model.js";
import {
  NO_PDF_FONTS,
  buildPdfRenderRequest,
  pdfFontNeed,
  type PdfFontProvider,
  type PdfRenderProvider
} from "../render/pdf/pdf-provider.js";
import type { PdfDeterminismGate } from "./release-gates.js";

export interface GateInputOptions {
  /** Perf budget for a full render-model build over the sample tree. */
  renderBudgetMs?: number;
  /** Iterations for the perf micro-benchmark. */
  perfIterations?: number;
  /**
   * Overrides the wasm host used by the parity and sandbox-isolation checks — e.g. a real
   * QuickJS-backed host (`@argusvane/datum-quickjs-wasm-host`), proving the gates against an actual
   * sandbox. Defaults to the in-process reference adapter over the core validator; the
   * engine itself stays dependency-free.
   */
  wasmValidationHost?: WasmValidationHost;
  /**
   * A PDF provider for the `pdf-render-determinism` gate: the sample form is
   * rendered twice through it and the bytes must match. Without one the gate is reported as
   * not applicable, so the engine's own gates stay dependency-free.
   */
  pdfProvider?: PdfRenderProvider;
  /** Fonts for that render; default none (the standard 14). */
  pdfFonts?: PdfFontProvider;
}

function defaultCoreWasmHost(): WasmValidationHost {
  return createInProcessWasmValidationHost({
    id: "core",
    version: "1.0.0",
    validate: coreDeterministicValidator
  });
}

async function deterministicParityPasses(wasmHost?: WasmValidationHost): Promise<boolean> {
  const browser = createBrowserAdapter(new ValidationPipeline([coreValidationStage]));
  const wasm = createWasmAdapter(wasmHost ?? defaultCoreWasmHost(), coreValidationRoot);
  const server = createServerAdapter(
    new ServerValidationRunner([
      {
        id: "core",
        version: "1.0.0",
        validate: async (ctx) => coreDeterministicValidator(ctx.validationContext)
      }
    ])
  );
  const report = await runParity(coreValidationVectors, [browser, wasm, server]);
  return report.mismatches.length === 0;
}

async function wasmSandboxIsolationHolds(wasmHost?: WasmValidationHost): Promise<boolean> {
  const host = wasmHost ?? defaultCoreWasmHost();
  try {
    await host.run({
      context: { formId: "f", values: {}, form: coreValidationRoot },
      // @ts-expect-error deliberately widened policy
      policy: { allowNetwork: true, allowFilesystem: false, allowProcess: false, allowEnvironment: false }
    });
    return false;
  } catch {
    return true;
  }
}

function pluginFailureIsolationHolds(): boolean {
  const registries = {
    plugins: new PluginRegistry(),
    components: new ComponentRegistry(),
    validators: new ValidatorRegistry(),
    builderThemes: new BuilderThemeRegistry(),
    pdfThemes: new PdfThemeRegistry(),
    dataSourceProviders: new DataSourceProviderRegistry(),
    dataSources: new DataSourceRegistry()
  };
  registries.plugins.register({
    id: "broken",
    version: "1.0.0",
    initialize: () => {
      throw new Error("boom");
    }
  });
  registries.plugins.register({ id: "healthy", version: "1.0.0" });
  const result = new PluginPlatform(registries).installAndInitialize({ environment: "browser" });
  return (
    result.failedPluginIds.includes("broken") &&
    result.initializedPluginIds.includes("healthy")
  );
}

function sampleTree(fieldCount: number): ComponentNode {
  const fields: ComponentNode[] = [];
  for (let i = 0; i < fieldCount; i += 1) {
    fields.push({ id: `f${i}`, type: "text", configuration: { label: `Field ${i}` } });
  }
  return { id: "root", type: "form", configuration: {}, children: { content: fields } };
}

async function measureRenderMs(iterations: number): Promise<number> {
  const root = sampleTree(50);
  const tree = new ComponentTree(root);
  const state = new FormStateStore("en").snapshot();
  const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

  const start = Date.now();
  for (let i = 0; i < iterations; i += 1) {
    await buildRenderOutput({ mode: "interactive", root, state, resolver, componentTree: tree });
  }
  return (Date.now() - start) / iterations;
}

/** Renders the sample form twice through the provider with one fixed environment and compares the bytes. */
async function pdfRenderIsDeterministic(provider: PdfRenderProvider, fonts: PdfFontProvider): Promise<PdfDeterminismGate> {
  const root = sampleTree(8);
  const state = new FormStateStore("en").snapshot();
  const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };
  const model = await buildPdfRenderModel(root, state, resolver, {}, { title: "Release gate" });
  if (!model.document) {
    return { applicable: true, passed: false, providerId: provider.id };
  }
  const fontResources = await fonts.resolve(pdfFontNeed(model.document));
  const env = { createdAt: "2026-01-01T00:00:00.000Z", documentId: "release-gate", producer: "Datum release gates" };
  const request = buildPdfRenderRequest(model.document, fontResources, env);
  const first = await provider.render(request);
  const second = await provider.render(request);
  const same =
    first.bytes.length === second.bytes.length && first.bytes.every((byte, index) => byte === second.bytes[index]);
  return { applicable: true, passed: same && first.bytes.length > 0, providerId: provider.id };
}

/** Runs every real check the release gates consume and assembles a {@link ReleaseGateInput}. */
export async function collectReleaseGateInputs(
  options: GateInputOptions = {}
): Promise<ReleaseGateInput> {
  const iterations = options.perfIterations ?? 20;
  const renderBudgetMs = options.renderBudgetMs ?? 50;

  const [parityPassed, observedRenderMs, sandboxIsolationHolds, pdfRenderDeterminism] = await Promise.all([
    deterministicParityPasses(options.wasmValidationHost),
    measureRenderMs(iterations),
    wasmSandboxIsolationHolds(options.wasmValidationHost),
    options.pdfProvider
      ? pdfRenderIsDeterministic(options.pdfProvider, options.pdfFonts ?? NO_PDF_FONTS)
      : Promise.resolve<PdfDeterminismGate>({ applicable: false, passed: true })
  ]);

  return {
    deterministicVectorParityPassed: parityPassed,
    performanceBudgets: [
      { name: "render-model-build-50-fields", observedMs: observedRenderMs, budgetMs: renderBudgetMs }
    ],
    security: {
      wasmSandboxIsolation: sandboxIsolationHolds,
      pluginFailureIsolation: pluginFailureIsolationHolds()
    },
    pdfRenderDeterminism
  };
}
