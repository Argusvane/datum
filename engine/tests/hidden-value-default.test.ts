// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { PdfKernelRequest } from "../form-engine/render/pdf/pdf-abi.js";
import type { PdfRenderProvider } from "../form-engine/render/pdf/pdf-provider.js";
import { computeEffectiveNodeState, defaultHiddenValueBehaviorFor, DEFAULT_HIDDEN_VALUE_BEHAVIOR } from "../form-engine/core/state/effective-state.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { renderFormPdf } from "../form-engine/render/pdf/pdf-service.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { buildPrintModel, type PrintField, type PrintModel, type PrintNode } from "../form-engine/render/print/index.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import { buildLogicModel } from "../form-engine/builder/logic/logic-model.js";
import { InMemoryDraftStore } from "../form-engine/persistence/local-storage/in-memory-draft-store.js";

/**
 * A hidden field's answer is left out of the submission by default (`hiddenValueBehavior`
 * absent = `exclude-from-submission`): kept in the form's state, so showing the field again
 * shows it, and never sent, printed or put in a PDF while hidden. `retain` keeps and sends it,
 * `clear` sends it empty. The browser runtime and the sandbox kernel agree.
 */

type Behaviour = "retain" | "clear" | "exclude-from-submission" | undefined;

/** `detail` shows only while `more` is ticked. */
function form(behaviour: Behaviour, extra: Record<string, unknown> = {}): FormDefinition {
  return {
    id: "hidden-default",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Hidden" },
      children: {
        content: [
          { id: "more", type: "checkbox", configuration: { label: "Tell us more" } },
          {
            id: "detail",
            type: "text",
            configuration: { label: "Detail", ...(behaviour !== undefined ? { hiddenValueBehavior: behaviour } : {}), ...extra },
            rules: { visibleWhen: "more = true" }
          }
        ]
      }
    }
  } as FormDefinition;
}

function runtimeOf(definition: FormDefinition): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

const envelope = {
  form: { id: "hidden-default", version: "1" },
  client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" }
};

/** Typed while shown, then hidden. */
function typedThenHidden(behaviour: Behaviour): FormRuntime {
  const runtime = runtimeOf(form(behaviour));
  runtime.setValue("more", true);
  runtime.setValue("detail", "secret");
  runtime.setValue("more", false);
  return runtime;
}

const signatures = formulaFunctionSignatures();
/** The sandbox kernel's values for the same definition and the raw answers (a client that sent everything). */
function kernelValues(definition: FormDefinition, values: Record<string, unknown>): Record<string, unknown> | undefined {
  const outcome = runKernel({ formId: definition.id, values, locale: "en", form: definition.root } as never, [], undefined, signatures);
  // As the outcome crosses the boundary: JSON, where an entry holding no answer is no key.
  return outcome.values === undefined ? undefined : (JSON.parse(JSON.stringify(outcome.values)) as Record<string, unknown>);
}

describe("the default: a hidden field's answer is not sent", () => {
  it("names exclude-from-submission as the default, and keeps the sibling defaults", () => {
    expect(DEFAULT_HIDDEN_VALUE_BEHAVIOR).toBe("exclude-from-submission");
    const hidden = computeEffectiveNodeState({ visible: false, disabled: false, readonly: false }, []);
    expect(hidden).toMatchObject({ submitValue: false, clearValue: false, runValidation: false, requiredApplies: false });
    const shown = computeEffectiveNodeState({ visible: true, disabled: false, readonly: false }, []);
    expect(shown).toMatchObject({ submitValue: true, clearValue: false });
  });

  it("leaves the hidden answer out of what is submitted, and keeps it in the form's state", async () => {
    const runtime = typedThenHidden(undefined);
    expect(runtime.state().values.detail).toBe("secret");
    expect("detail" in runtime.submittableValues()).toBe(false);
    const result = await runtime.submit("submit", envelope);
    expect(result.accepted).toBe(true);
    expect(result.canonicalSubmission?.submission.values).toEqual({ more: false });
  });

  it("shows the answer again when the field is shown again, and sends it then", async () => {
    const runtime = typedThenHidden(undefined);
    runtime.setValue("more", true);
    expect(runtime.state().values.detail).toBe("secret");
    expect(runtime.submittableValues().detail).toBe("secret");
    expect((await runtime.submit("submit", envelope)).canonicalSubmission?.submission.values).toEqual({ more: true, detail: "secret" });
  });

  it("sends the answer when the field says retain", async () => {
    const runtime = typedThenHidden("retain");
    expect(runtime.submittableValues().detail).toBe("secret");
    expect((await runtime.submit("submit", envelope)).canonicalSubmission?.submission.values).toEqual({ more: false, detail: "secret" });
  });

  it("sends it empty when the field says clear, the form keeping what was typed", async () => {
    const runtime = typedThenHidden("clear");
    const view = runtime.submittableValues();
    expect("detail" in view && view.detail === undefined).toBe(true);
    expect(runtime.state().values.detail).toBe("secret");
    const sent = (await runtime.submit("submit", envelope)).canonicalSubmission?.submission.values as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(sent))).toEqual({ more: false });
    // Shown again, the answer is there to send.
    runtime.setValue("more", true);
    expect(runtime.submittableValues().detail).toBe("secret");
  });

  it("keeps and sends the hidden answer of a field that asks to be required or validated while hidden", () => {
    expect(defaultHiddenValueBehaviorFor({})).toBe("exclude-from-submission");
    expect(defaultHiddenValueBehaviorFor({ hiddenRequiredBehavior: "required" })).toBe("retain");
    expect(defaultHiddenValueBehaviorFor({ hiddenValidationBehavior: "validate" })).toBe("retain");
    expect(defaultHiddenValueBehaviorFor({ hiddenRequiredBehavior: "required", hiddenValueBehavior: "clear" })).toBe("retain");
    const runtime = runtimeOf(form(undefined, { hiddenRequiredBehavior: "required" }));
    runtime.setValue("more", true);
    runtime.setValue("detail", "kept");
    runtime.setValue("more", false);
    expect(runtime.submittableValues().detail).toBe("kept");
    // Its own setting still wins.
    const own = runtimeOf(form("exclude-from-submission", { hiddenRequiredBehavior: "required" }));
    own.setValue("detail", "typed");
    expect("detail" in own.submittableValues()).toBe(false);
  });
});

describe("the browser runtime and the sandbox kernel agree on a hidden answer", () => {
  for (const behaviour of [undefined, "exclude-from-submission", "retain", "clear"] as const) {
    it(`for ${behaviour ?? "no setting (the default)"}`, async () => {
      const definition = form(behaviour);
      const runtime = typedThenHidden(behaviour);
      const browser = JSON.parse(JSON.stringify((await runtime.submit("submit", envelope)).canonicalSubmission?.submission.values ?? null)) as unknown;
      // The server is sent everything the person typed, the hidden answer too.
      const server = kernelValues(definition, { more: false, detail: "secret" });
      expect(server, String(behaviour)).toEqual(browser);
      expect(server && "detail" in server, String(behaviour)).toBe(behaviour === "retain");
    });
  }

  it("treats a calculation over a hidden, defaulted input as possibly withheld, and over a retained one as the person's", () => {
    const calc = (behaviour: Behaviour): FormDefinition => {
      const definition = form(behaviour);
      (definition.root.children!.content as ComponentNode[]).push({ id: "echo", type: "text", configuration: { label: "Echo" }, rules: { value: "detail" } });
      return definition;
    };
    // Nothing sent for `detail`: by default it may have been withheld, so the sent `echo` is kept as sent.
    expect(kernelValues(calc(undefined), { more: false, echo: "forged" })?.echo).toBe("forged");
    // Retained, the absence is the person's: the server works `echo` out again, to no answer.
    expect(kernelValues(calc("retain"), { more: false, echo: "forged" })?.echo).toBeUndefined();
  });
});

describe("a PDF and a printed copy do not show an answer the submission leaves out", () => {
  const layout: PdfGeneratedLayout = {
    id: "letter",
    kind: "generated",
    root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "t", type: "pdf-text", configuration: { text: "Detail: [{{detail}}]" } }] } }
  };
  const withLayout = (behaviour: Behaviour): FormDefinition => ({ ...form(behaviour), pdf: { layouts: [layout], defaultLayoutId: "letter" } }) as FormDefinition;

  function provider(): PdfRenderProvider & { requests: PdfKernelRequest[] } {
    const requests: PdfKernelRequest[] = [];
    return {
      id: "fake",
      abiVersion: "1.0.0",
      requests,
      render: async (request) => {
        requests.push(request);
        return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), pageCount: 1, pages: [], warnings: [], providerId: "fake" };
      }
    };
  }
  const environment = { now: () => "2026-09-05T10:11:12.345Z", newDocumentId: () => "doc-1" };

  it("prints a path in a PDF's text only when the answer is sent", async () => {
    for (const [behaviour, printed] of [[undefined, false], ["exclude-from-submission", false], ["clear", false], ["retain", true]] as const) {
      const runtime = runtimeOf(withLayout(behaviour));
      runtime.setValue("more", true);
      runtime.setValue("detail", "secret");
      runtime.setValue("more", false);
      const fake = provider();
      await renderFormPdf(runtime, { provider: fake, environment });
      expect(JSON.stringify(fake.requests).includes("secret"), String(behaviour)).toBe(printed);
    }
    // Shown, the answer prints.
    const shown = runtimeOf(withLayout(undefined));
    shown.setValue("more", true);
    shown.setValue("detail", "secret");
    const fake = provider();
    await renderFormPdf(shown, { provider: fake, environment });
    expect(JSON.stringify(fake.requests)).toContain("secret");
  });

  it("reads the answers after the hidden-value policy for a PDF and a read-only copy, and every answer for the live form", async () => {
    const runtime = typedThenHidden(undefined);
    expect(runtime.printableValues()).toEqual({ more: false });
    const valueOf = async (mode: "interactive" | "readonly" | "pdf") =>
      (await buildRuntimeRenderOutput(runtime, mode, { journeyKit: EagerJourneyRenderKit })).components.find((model) => model.id === "detail")?.value;
    expect(await valueOf("interactive")).toBe("secret");
    expect(await valueOf("readonly")).toBeUndefined();
    expect(await valueOf("pdf")).toBeUndefined();
  });

  it("prints a field kept on paper while hidden without the answer it leaves out", async () => {
    const all = (nodes: readonly PrintNode[]): PrintNode[] => nodes.flatMap((node) => [node, ...(node.kind === "group" || node.kind === "section" ? all(node.children) : [])]);
    const printed = (model: PrintModel): PrintField => all(model.nodes).find((node): node is PrintField => node.kind === "field" && node.id === "detail")!;
    for (const [behaviour, empty] of [[undefined, true], ["retain", false]] as const) {
      const runtime = runtimeOf(form(behaviour, { print: { show: "always" } }));
      runtime.setValue("more", true);
      runtime.setValue("detail", "secret");
      runtime.setValue("more", false);
      const field = printed(await buildPrintModel(runtime, { render: { journeyKit: EagerJourneyRenderKit } }));
      expect(field.empty, String(behaviour)).toBe(empty);
      expect(JSON.stringify(field).includes("secret"), String(behaviour)).toBe(!empty);
    }
  });

  it("keeps every answer in a draft: a draft is the form's state, not a submission", async () => {
    const store = new InMemoryDraftStore();
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(form(undefined), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([]),
      draftStore: store,
      versionContext: { formVersion: "1", schemaVersion: "1", rendererVersion: "1.0.0" }
    });
    runtime.setValue("more", true);
    runtime.setValue("detail", "secret");
    runtime.setValue("more", false);
    await runtime.saveDraft("d1");
    expect((await store.load("d1"))?.values).toEqual({ more: false, detail: "secret" });
  });
});

describe("the inspector's When hidden row and the Logic workspace read and write one key", () => {
  const DEFS: ComponentDefinition[] = [
    { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
    { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() },
    { type: "checkbox", version: "1.0.0", createDefault: () => ({ id: "checkbox", type: "checkbox", configuration: { label: "Box" } }), capabilities: standardFieldCapabilities({ placeholder: false }) }
  ];
  const make = (): BuilderController =>
    new BuilderController({ initialRoot: form(undefined).root, componentDefinitions: DEFS, identity: { id: "hidden-default", version: "1", schemaVersion: "1" } });
  const row = (controller: BuilderController) => {
    const model = controller.inspectorModel("detail")!;
    const section = model.sections.find((entry) => entry.fields.some((field) => field.propertyPath === "hiddenValueBehavior"));
    return { section: section?.id, field: section?.fields.find((field) => field.propertyPath === "hiddenValueBehavior") };
  };

  it("offers the row under Data, beside the Data key, showing the default when nothing is stored", () => {
    const controller = make();
    const { section, field } = row(controller);
    expect(section).toBe("data");
    expect(field?.label).toBe("When hidden");
    expect(field?.control).toBe("select");
    expect(field?.value).toBe("exclude-from-submission");
    expect(field?.choices.map((choice) => choice.value)).toEqual(["exclude-from-submission", "retain", "clear"]);
    expect(field?.choices[0]?.label).toBe("Leave the answer out (default)");
  });

  it("writes the key only for a choice other than the default", () => {
    const controller = make();
    controller.select("detail");
    controller.setDraftProperty("detail", "hiddenValueBehavior", "retain");
    expect(controller.commitDraft("detail")).toBe(true);
    expect(controller.getProperty("detail", "hiddenValueBehavior")).toBe("retain");
    expect(row(controller).field?.value).toBe("retain");
    controller.setDraftProperty("detail", "hiddenValueBehavior", "exclude-from-submission");
    expect(controller.commitDraft("detail")).toBe(true);
    expect(controller.getProperty("detail", "hiddenValueBehavior")).toBeUndefined();
    expect(row(controller).field?.value).toBe("exclude-from-submission");
  });

  it("is the key the Logic workspace's show rule reads: both say the same for the same component", () => {
    const controller = make();
    controller.select("detail");
    const ruleOf = () => buildLogicModel(controller.snapshot()).rules.find((rule) => rule.id === "form:detail:visibleWhen");
    expect(ruleOf()?.hiddenValueBehavior).toBeUndefined();
    for (const choice of ["clear", "retain"] as const) {
      controller.setDraftProperty("detail", "hiddenValueBehavior", choice);
      controller.commitDraft("detail");
      expect(ruleOf()?.hiddenValueBehavior).toBe(choice);
      expect(row(controller).field?.value).toBe(choice);
    }
  });
});
