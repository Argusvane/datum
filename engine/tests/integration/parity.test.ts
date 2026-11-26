import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  layerValidationMessages,
  readValidationMessages,
  resolveValidationMessage,
  type ValidationMessageCatalog
} from "../../form-engine/core/localization/validation-messages.js";
import type { FormTranslations } from "../../form-engine/core/localization/translations.js";
import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { kernelFormTestOpCatalogs, kernelFormTestOpMessage, runKernel } from "../../form-engine/validation/wasm/portable-kernel.js";

import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { createInProcessWasmValidationHost } from "../../form-engine/validation/wasm/in-process-host.js";
import { ServerValidationRunner } from "../../form-engine/validation/server/server-validation.js";
import { createBrowserAdapter } from "../../form-engine/validation/parity/browser-adapter.js";
import { createWasmAdapter } from "../../form-engine/validation/parity/wasm-adapter.js";
import { createServerAdapter } from "../../form-engine/validation/parity/server-adapter.js";
import { runParity } from "../../form-engine/validation/parity/parity-runner.js";
import {
  coreDeterministicValidator,
  coreValidationRoot,
  coreValidationStage,
  coreValidationVectors
} from "../../form-engine/validation/parity/vectors.js";
import type { DeterministicRuntimeAdapter } from "../../form-engine/validation/parity/runtime-adapter.js";

function browser(): DeterministicRuntimeAdapter {
  return createBrowserAdapter(new ValidationPipeline([coreValidationStage]));
}

function wasm(): DeterministicRuntimeAdapter {
  return createWasmAdapter(
    createInProcessWasmValidationHost({
      id: "core",
      version: "1.0.0",
      validate: coreDeterministicValidator
    }),
    coreValidationRoot
  );
}

function server(): DeterministicRuntimeAdapter {
  return createServerAdapter(
    new ServerValidationRunner([
      {
        id: "core",
        version: "1.0.0",
        validate: async (ctx) => coreDeterministicValidator(ctx.validationContext)
      }
    ])
  );
}

describe("cross-runtime deterministic parity", () => {
  it("browser, wasm, and server adapters agree on every core vector", async () => {
    const report = await runParity(coreValidationVectors, [browser(), wasm(), server()]);
    expect(report.mismatches).toEqual([]);
    expect(report.matched).toBe(report.checked);
    expect(report.checked).toBe(coreValidationVectors.length);
  });

  it("never hands the sandbox the browser's requiredComponents through the wasm adapter", async () => {
    const seen: string[][] = [];
    const adapter = createWasmAdapter(
      createInProcessWasmValidationHost({
        id: "spy",
        version: "1.0.0",
        validate: (context) => {
          seen.push(Object.keys(context).sort());
          return { errors: [] };
        }
      }),
      coreValidationRoot
    );
    await adapter.run({ formId: "f", values: { email: "a@b.co" }, locale: "en", requiredComponents: { email: true } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("requiredComponents");
    expect(seen[0]).toContain("values");
  });

  it("detects and reports a divergent adapter", async () => {
    const divergent: DeterministicRuntimeAdapter = {
      id: "server",
      run: () => ({ errors: [{ code: "phantom", stage: "field", source: "server" }] })
    };

    const report = await runParity(coreValidationVectors, [browser(), wasm(), divergent]);
    expect(report.mismatches.length).toBeGreaterThan(0);
    expect(report.mismatches[0]?.signatures).toHaveProperty("server");
    expect(report.mismatches[0]?.signatures).toHaveProperty("browser");
  });
});

describe("the browser validator and the kernel word a message from the definition's map alike", () => {
  const intake = JSON.parse(readFileSync(new URL("../fixtures/customer-intake.translations.json", import.meta.url), "utf8")) as FormDefinition;
  const translations = intake.translations as FormTranslations;

  /** The browser's wording: the field's catalog over its containers' over the form's, each worded for `locale` through the map. */
  function browserCatalog(id: string, locale: string): ValidationMessageCatalog | undefined {
    const sources = { translations };
    let found: ValidationMessageCatalog | undefined;
    const walk = (node: ComponentNode, inherited: ValidationMessageCatalog | undefined): void => {
      const layered = layerValidationMessages(readValidationMessages(node.configuration, { ownerId: node === intake.root ? undefined : node.id, locale, sources }), inherited);
      if (node.id === id) {
        found = layered;
      }
      for (const children of Object.values(node.children ?? {})) {
        for (const child of children) {
          walk(child, layered);
        }
      }
    };
    walk(intake.root, undefined);
    return found;
  }

  for (const [locale, expected] of [
    ["en", "Enter your full name."],
    ["fr-CA", "Entrez votre nom complet."],
    // No Spanish words for the message in the map: the default.
    ["es", "Enter your full name."]
  ] as const) {
    it(`required on fullName in ${locale}`, async () => {
      const stage = createFieldConstraintsStage(intake.root);
      const browserErrors = (await stage.validate({ formId: intake.id, values: {}, locale })).errors.filter((error) => error.componentId === "fullName");
      const kernelErrors = runKernel({ formId: intake.id, form: intake.root, values: {}, locale, translations }, []).errors.filter((error) => error.componentId === "fullName");
      expect(browserErrors.map((error) => error.code)).toEqual(["required"]);
      expect(kernelErrors.map((error) => error.code)).toEqual(["required"]);
      const browserWords = resolveValidationMessage(browserErrors[0]!, browserCatalog("fullName", locale), locale);
      const kernelWords = kernelFormTestOpMessage(kernelErrors[0]! as never, kernelFormTestOpCatalogs(intake.root, locale, translations).fullName, locale);
      expect(kernelWords).toBe(browserWords);
      expect(kernelWords).toBe(expected);
    });
  }

  // The stage is built with no textSources (as every caller builds it); the run's context
  // carries the map, as FormRuntime's validationContext does.
  for (const [locale, expected] of [
    ["en", "Enter an email address."],
    ["fr-CA", "Entrez une adresse courriel."]
  ] as const) {
    it(`a pattern's parameters.message on newsletterEmail in ${locale}`, async () => {
      const values = { fullName: "x", newsletterEmail: "nope" };
      const stage = createFieldConstraintsStage(intake.root);
      const browserErrors = (await stage.validate({ formId: intake.id, values, locale, translations } as never)).errors.filter((error) => error.componentId === "newsletterEmail");
      const kernelErrors = runKernel({ formId: intake.id, form: intake.root, values, locale, translations }, []).errors.filter((error) => error.componentId === "newsletterEmail");
      expect(browserErrors.map((error) => error.code)).toEqual(["pattern"]);
      expect(kernelErrors.map((error) => error.code)).toEqual(["pattern"]);
      expect(kernelErrors[0]?.parameters?.message).toBe(expected);
      expect(browserErrors[0]?.parameters?.message).toBe(kernelErrors[0]?.parameters?.message);
    });
  }
});
