// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../form-engine/core/events/event-bus.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { ValidationContext } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { Journey, JourneyPage } from "../form-engine/core/schema/journey.js";
import type { JourneyView } from "../form-engine/core/journey/journey-types.js";
import { journeyPageFormIds } from "../form-engine/core/schema/journey.js";
import type { FormError } from "../form-engine/core/errors/form-error.js";
import { EMAIL_PRESET_MESSAGE, EMAIL_PRESET_PATTERN } from "../form-engine/core/schema/control-hints.js";
import { DEFAULT_VALIDATION_MESSAGES } from "../form-engine/core/localization/validation-messages.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import { DEFAULT_FORM_TEXTS } from "../form-engine/core/localization/form-texts.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildRenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import type { ErrorWordingSources } from "../form-engine/render/core/error-wording.js";
import type { FormTranslations } from "../form-engine/core/localization/translations.js";
import { RuntimeOrchestrator } from "../form-engine/runtime/browser/runtime-orchestrator.js";
import { compileFormDefinition } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { markupOf, unmountAll } from "./live-datum-parts-kit.js";

afterEach(unmountAll);

/**
 * The defaults the renderer and the runtime bring so a new form reads right without further
 * authoring: sentences for validation codes, the form's title, a calculation's target read-only.
 * The keyboard validates nothing for an Email field (the inspector's Email preset writes a
 * pattern), and its tests pin browser/kernel parity on the stored definition.
 */

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

function formRoot(children: ComponentNode[], configuration: Record<string, unknown> = {}): ComponentNode {
  return { id: "root", type: "form", configuration, children: { content: children } };
}

function error(code: string, componentId: string, extra: Partial<FormError> = {}): FormError {
  return { code, componentId, stage: "field-constraints", source: "client", ...extra } as unknown as FormError;
}

/** What a render says for `errors`: the summary's lines and the messages under the fields, worded. */
async function body(
  root: ComponentNode,
  options: { translations?: FormTranslations; messages?: ErrorWordingSources["messages"] } = {},
  extra: { errors?: FormError[]; locale?: string } = {}
): Promise<string> {
  const output = await buildRenderOutput({
    mode: "interactive",
    root,
    state: new FormStateStore(extra.locale ?? "en").snapshot(),
    resolver,
    errors: extra.errors ?? [],
    ...(options.translations ? { translations: options.translations } : {}),
    ...(options.messages ? { wording: { messages: options.messages } } : {})
  });
  const summary = output.meta.errorSummary.entries.map((entry) => `<a>${entry.text}</a>`);
  const fields = output.components.flatMap((component) => (component.errorMessages ?? []).map((message) => `<p>${message}</p>`));
  return [...summary, ...fields].join(" ");
}

const NAME_REQUIRED = [error("required", "name")];

describe("a validation code is worded, never shown bare", () => {
  const root = formRoot([{ id: "name", type: "text", configuration: { label: "Full name", required: true } }]);

  it("shows the built-in sentence in the summary and under the field, not the code", async () => {
    const html = await body(root, {}, { errors: NAME_REQUIRED });
    expect(html).toContain(`Full name: ${DEFAULT_VALIDATION_MESSAGES.required}`);
    expect(html).not.toMatch(/Full name: required</);
    expect(html).toContain(`>${DEFAULT_VALIDATION_MESSAGES.required}<`);
  });

  it("words it in French for a French form whose `texts` translations word it", async () => {
    const translations = {
      fr: {
        texts: {
          form: { summaryEntry: { text: "{{label}} : {{message}}", source: sourceHash(DEFAULT_FORM_TEXTS.summaryEntry) } },
          messages: { required: { text: "Ce champ est obligatoire", source: sourceHash(DEFAULT_VALIDATION_MESSAGES.required ?? "") } }
        }
      }
    };
    const html = await body(root, { translations }, { errors: NAME_REQUIRED, locale: "fr-CA" });
    expect(html).toContain("Full name : Ce champ est obligatoire");
    expect(html).toContain(">Ce champ est obligatoire<");
    expect(html).not.toContain(DEFAULT_VALIDATION_MESSAGES.required);
    // Without them a French form reads the engine's English.
    expect(await body(root, {}, { errors: NAME_REQUIRED, locale: "fr-CA" })).toContain(`Full name: ${DEFAULT_VALIDATION_MESSAGES.required}`);
  });

  it("holds the order page over field over form over built-in", async () => {
    const field = { id: "name", type: "text", configuration: { label: "Full name", required: true, messages: { required: "Field says" } } };
    const withForm = formRoot([field], { messages: { required: "Form says" } });
    // The page's message outranks the field's own, which outranks the form's, which outranks the built-in.
    expect(await body(withForm, { messages: { required: "Page says" } }, { errors: NAME_REQUIRED })).toContain("Full name: Page says");
    expect(await body(withForm, { messages: { minLength: "Page says" } }, { errors: NAME_REQUIRED })).toContain("Full name: Field says");
    const formOnly = formRoot([{ id: "name", type: "text", configuration: { label: "Full name", required: true } }], { messages: { required: "Form says" } });
    expect(await body(formOnly, {}, { errors: NAME_REQUIRED })).toContain("Full name: Form says");
    expect(await body(root, { messages: { required: "Page says" } }, { errors: NAME_REQUIRED })).toContain("Full name: Page says");
    // The page's catalog as the demo page assigns it: a default and a French line.
    const demo = { required: { default: "This field is required.", locales: { "fr-CA": "Ce champ est requis." } } };
    expect(await body(root, { messages: demo }, { errors: NAME_REQUIRED })).toContain("Full name: This field is required.");
    expect(await body(root, { messages: demo }, { errors: NAME_REQUIRED, locale: "fr-CA" })).toContain("Full name: Ce champ est requis.");
  });

  it("words the limits with their numbers", async () => {
    const limited = formRoot([{ id: "code", type: "text", configuration: { label: "Code", minLength: 5 } }]);
    const html = await body(limited, {}, { errors: [error("minLength", "code", { parameters: { minLength: 5, length: 2 } })] });
    expect(html).toContain("Code: Enter at least 5 characters");
  });
});

describe("the target of a calculation the browser runs is read-only", () => {
  function orchestratorFor(children: ComponentNode[]): RuntimeOrchestrator {
    // The orchestrator reads the compiled copy, as the runtime hands it over.
    const { root } = compileFormDefinition({ id: "f", version: "1", schemaVersion: "1", root: formRoot(children) }).definition;
    const orchestrator = new RuntimeOrchestrator(new ComponentTree(root), { eventBus: new EventBus(), formId: "f" });
    orchestrator.recompute(new FormStateStore("en").snapshot());
    return orchestrator;
  }
  const sum = "1 + 2";

  it("reads a calculated field read-only and its neighbours editable", () => {
    const orchestrator = orchestratorFor([
      { id: "total", type: "number", configuration: {}, rules: { value: sum } },
      { id: "plain", type: "number", configuration: {} },
      { id: "defaulted", type: "number", configuration: {}, rules: { defaultValue: sum } }
    ]);
    expect(orchestrator.effectiveStateFor("total")?.readonly).toBe(true);
    expect(orchestrator.effectiveStateFor("plain")?.readonly).toBe(false);
    // A default is a starting point the person may change.
    expect(orchestrator.effectiveStateFor("defaulted")?.readonly).toBe(false);
  });

  it("keeps a calculation scoped to the server editable in the browser, which does not run it", () => {
    const orchestrator = orchestratorFor([{ id: "total", type: "number", configuration: {}, rules: { value: { formula: sum, run: "server" } } }]);
    expect(orchestrator.effectiveStateFor("total")?.readonly).toBe(false);
  });

  it("stays read-only whatever readonlyWhen says", () => {
    const never = "false";
    const orchestrator = orchestratorFor([{ id: "total", type: "number", configuration: {}, rules: { value: sum, readonlyWhen: never } }]);
    expect(orchestrator.effectiveStateFor("total")?.readonly).toBe(true);
  });
});

describe("the Email keyboard validates nothing; the explicit preset's pattern does", () => {
  const email = (configuration: Record<string, unknown>): ComponentNode => ({ id: "email", type: "text", configuration: { label: "Email", inputmode: "email", ...configuration } });
  const definitionOf = (...children: ComponentNode[]): FormDefinition => ({ id: "f", version: "1", schemaVersion: "1", root: formRoot(children) });
  /** The browser's verdict: the compiled definition through the field-constraints stage the renderer runs. */
  function errorsFor(definition: FormDefinition, values: Record<string, unknown>): Array<{ code: string; parameters?: Record<string, unknown> }> {
    const root = compileFormDefinition(definition).definition.root;
    const context: ValidationContext = { formId: "f", values, locale: "en" };
    return (createFieldConstraintsStage(root).validate(context) as { errors: Array<{ code: string }> }).errors;
  }
  /** The sandbox kernel's verdict over the AUTHOR's definition, as a server host runs it. */
  function kernelErrorsFor(definition: FormDefinition, values: Record<string, unknown>): Array<{ code: string }> {
    return runKernel({ formId: "f", values, locale: "en", form: definition.root }, []).errors as Array<{ code: string }>;
  }
  const codes = (errors: Array<{ code: string }>): string[] => errors.map((entry) => entry.code);

  it("leaves a definition with the Email keyboard and no pattern alone, so abc is fine in the browser and in the kernel", () => {
    const definition = definitionOf(email({}));
    expect(errorsFor(definition, { email: "abc" })).toEqual([]);
    expect(kernelErrorsFor(definition, { email: "abc" })).toEqual([]);
    // The compiled tree is the author's tree: no pattern, no message derived from the keyboard.
    const configuration = compileFormDefinition(definition).definition.root.children!.content![0]!.configuration as Record<string, unknown>;
    expect(configuration.pattern).toBeUndefined();
    expect(configuration.patternMessage).toBeUndefined();
  });

  it("draws no pattern attribute from the keyboard alone", async () => {
    unmountAll();
    const drawn = await markupOf(definitionOf(email({})).root);
    expect(drawn.html).toContain('inputmode="email"');
    expect(drawn.html).not.toContain("pattern=");
  });

  it("gives the browser and the kernel one verdict once the preset's pattern is stored", () => {
    const definition = definitionOf(email({ pattern: EMAIL_PRESET_PATTERN, patternMessage: EMAIL_PRESET_MESSAGE }));
    for (const [address, ok] of [
      ["a@b.ca", true],
      ["a@b.ca ", true],
      [" a@b.ca", true],
      ["abc", false],
      ["a@b", false],
      ["a b@c.ca", false],
      ["a@@b.ca", false],
      ["", true]
    ] as const) {
      const browser = codes(errorsFor(definition, { email: address }));
      expect(browser, address).toEqual(ok ? [] : ["pattern"]);
      expect(codes(kernelErrorsFor(definition, { email: address })), address).toEqual(browser);
    }
  });

  it("words the refusal Enter an email address, as a plain default-language string", () => {
    expect(EMAIL_PRESET_MESSAGE).toBe("Enter an email address");
  });

  it("lets the author's own pattern and message win over the preset's", () => {
    const definition = definitionOf(email({ pattern: "[a-z]+@corp\\.example", patternMessage: "Use your work address" }));
    expect(errorsFor(definition, { email: "a@b.ca" }).map((entry) => entry.code)).toEqual(["pattern"]);
    expect(errorsFor(definition, { email: "ada@corp.example" })).toEqual([]);
  });

  it("does not change the author's definition, other keyboards or other types", () => {
    const authored = definitionOf(email({}), { id: "tel", type: "text", configuration: { inputmode: "tel" } }, { id: "area", type: "textarea", configuration: { inputmode: "email" } });
    const before = JSON.stringify(authored);
    const compiled = compileFormDefinition(authored).definition.root.children!.content!;
    expect(JSON.stringify(authored)).toBe(before);
    for (const component of compiled) {
      expect((component.configuration as { pattern?: string }).pattern).toBeUndefined();
    }
  });
});
