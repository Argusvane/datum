import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage, isEmptyValue } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { kernelFormTestServerAnswerFor, kernelRunFieldConstraints } from "../form-engine/validation/wasm/portable-kernel.js";
import { kernelIsEmptyValue } from "../form-engine/core/schema/answer-kinds.js";
import { journeyEmptyAnswer } from "../form-engine/core/journey/journey-diagnostics.js";
import { checkboxAnswer, checkboxesAnswer } from "../form-engine/core/state/answer-shape.js";
import type { FormDraft } from "../form-engine/persistence/core/draft-store.js";

function root(children: ComponentNode[]): ComponentNode {
  return { id: "root", type: "form", configuration: {}, children: { content: children } };
}

const PETS = { options: [{ value: "cat", label: "Cat" }, { value: "dog", label: "Dog" }] };

function definition(children: ComponentNode[], journey?: FormDefinition["journey"]): FormDefinition {
  return { id: "f", version: "1", schemaVersion: "1", root: root(children), ...(journey ? { journey } : {}) } as FormDefinition;
}

/** A browser: the field-constraints stage (unless `kernelOnly`), and with `sandboxed` the in-process kernel as its sandbox. */
function runtimeOf(form: FormDefinition, sandboxed = false, kernelOnly = false): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline(kernelOnly ? [] : [createFieldConstraintsStage(form.root)]),
    ...(sandboxed ? { wasmValidationHost: createInProcessWasmValidationHost([]) } : {})
  });
}

const SUBMIT_CONTEXT = { form: { id: "f", version: "1" }, client: { runtimeVersion: "0", rendererVersion: "0", schemaVersion: "1" } };

function draftOf(values: Record<string, unknown>): FormDraft {
  return {
    id: "d",
    formId: "f",
    formVersion: "1",
    runtime: { schemaVersion: "1", rendererVersion: "1" },
    locale: "en",
    values,
    state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [] },
    updatedAt: 1
  } as unknown as FormDraft;
}

const SHAPES = definition([
  { id: "agree", type: "checkbox", configuration: {} },
  { id: "pets", type: "checkboxes", configuration: PETS },
  { id: "tags", type: "checkboxes", configuration: {} },
  {
    id: "items",
    type: "dataGrid",
    configuration: {},
    children: {
      content: [
        { id: "sku", type: "text", configuration: {} },
        { id: "gift", type: "checkbox", configuration: {} }
      ]
    }
  }
] as ComponentNode[]);

describe("a checkbox's answer is stored in the one shape every surface reads", () => {
  it("reads the text true and false as the booleans and keeps every other value as written", () => {
    expect(checkboxAnswer("true")).toBe(true);
    expect(checkboxAnswer("false")).toBe(false);
    for (const value of [true, false, 0, 1, "yes", "", "TRUE", null, undefined]) {
      expect(checkboxAnswer(value), String(value)).toBe(value);
    }
  });

  it("makes a checkbox group's list of picked values its record over the inline options", () => {
    expect(checkboxesAnswer(["cat"], ["cat", "dog"])).toEqual({ cat: true, dog: false });
    expect(checkboxesAnswer([], ["cat", "dog"])).toEqual({ cat: false, dog: false });
    // A value outside the options is ticked too, and a number picks its text.
    expect(checkboxesAnswer(["cat", "fish", 3], ["cat", "dog"])).toEqual({ cat: true, dog: false, fish: true, "3": true });
    // An option named `__proto__` is a key like any other.
    expect(Object.keys(checkboxesAnswer(["__proto__"], []) as object)).toEqual(["__proto__"]);
    // A list holding anything else, and every value that is no list, is kept as written.
    const odd = [{ value: "cat" }];
    expect(checkboxesAnswer(odd, ["cat"])).toBe(odd);
    expect(checkboxesAnswer({ cat: true }, ["cat"])).toEqual({ cat: true });
  });

  it("stores a checkbox's true and false text as the booleans through setValue and setValues", () => {
    const runtime = runtimeOf(SHAPES);
    runtime.setValue("agree", "true");
    expect(runtime.state().values.agree).toBe(true);
    runtime.setValue("agree", "false");
    expect(runtime.state().values.agree).toBe(false);
    expect(runtime.setValues({ agree: "true", "items[0].gift": "true" })).toEqual([]);
    expect(runtime.state().values.agree).toBe(true);
    expect(runtime.state().values["items[0].gift"]).toBe(true);
    // Neither refused nor guessed at: unticked everywhere, as written.
    runtime.setValue("agree", 1);
    expect(runtime.state().values.agree).toBe(1);
    runtime.setValue("agree", "yes");
    expect(runtime.state().values.agree).toBe("yes");
  });

  it("stores a checkbox group's list as its record through setValue, setValues and the rows", () => {
    const runtime = runtimeOf(SHAPES);
    runtime.setValue("pets", ["cat"]);
    expect(runtime.state().values.pets).toEqual({ cat: true, dog: false });
    runtime.setValues({ pets: ["dog"], tags: ["red"] });
    expect(runtime.state().values.pets).toEqual({ cat: false, dog: true });
    // A group whose options are not inline holds the values picked.
    expect(runtime.state().values.tags).toEqual({ red: true });
    runtime.setValue("items", [{ sku: "A", gift: "true" }, { sku: "B", gift: "false" }]);
    expect(runtime.state().values["items[0].gift"]).toBe(true);
    expect(runtime.state().values["items[1].gift"]).toBe(false);
    runtime.addRow("items", { sku: "C", gift: "true" });
    expect(runtime.state().values["items[2].gift"]).toBe(true);
  });

  it("publishes the stored shape, and a write of the same answer in another spelling changes nothing", () => {
    const runtime = runtimeOf(SHAPES);
    const changed: unknown[] = [];
    runtime.setValue("pets", { cat: true, dog: false });
    runtime.events().subscribe(FormEventType.COMPONENT_CHANGED, (event) => {
      changed.push((event.data as { value?: unknown } | undefined)?.value);
    });
    runtime.setValue("pets", ["cat"]);
    expect(changed).toEqual([]);
    runtime.setValue("pets", ["dog"]);
    expect(changed[0]).toEqual({ cat: false, dog: true });
  });

  it("restores a draft's checkbox text and checkbox group list in the stored shapes", async () => {
    const runtime = runtimeOf(SHAPES);
    const restored = await runtime.hydrateFromDraft(draftOf({ agree: "true", pets: ["dog"], "items[0].gift": "false", "items[0].sku": "A" }));
    expect(restored.dropped).toEqual([]);
    const values = runtime.state().values;
    expect(values.agree).toBe(true);
    expect(values.pets).toEqual({ cat: false, dog: true });
    expect(values["items[0].gift"]).toBe(false);
  });

  it("stores a form test's set of the text true on a checkbox as the boolean on the kernel's side too", () => {
    expect(kernelFormTestServerAnswerFor("checkbox", "true")).toBe(true);
    expect(kernelFormTestServerAnswerFor("checkbox", "false")).toBe(false);
    expect(kernelFormTestServerAnswerFor("text", "true")).toBe("true");
  });
});

describe("only true answers a checkbox, and only a record with a box ticked answers a group", () => {
  const CONSENT = root([
    { id: "consent", type: "checkbox", configuration: { label: "I agree", required: true } },
    { id: "topics", type: "checkboxes", configuration: { label: "Topics", required: true } }
  ] as ComponentNode[]);
  const stage = createFieldConstraintsStage(CONSENT);
  const clientCodes = (values: Record<string, unknown>): string[] =>
    (stage.validate({ formId: "f", values, locale: "en" }) as { errors: Array<{ componentId?: string; code: string }> }).errors.map(
      (error) => `${error.componentId}:${error.code}`
    );
  const kernelCodes = (values: Record<string, unknown>): string[] =>
    kernelRunFieldConstraints(CONSENT, values, "en").map((error) => `${error.componentId}:${error.code}`);

  it("refuses every value but true for a required checkbox, in the browser's stage and the kernel alike", () => {
    for (const value of [false, "false", "true", 0, 1, "yes", "", "  ", null, undefined]) {
      const values = { consent: value, topics: { news: true } };
      const label = JSON.stringify(value) ?? "undefined";
      expect(clientCodes(values), label).toEqual(["consent:required"]);
      expect(kernelCodes(values), label).toEqual(["consent:required"]);
    }
    expect(clientCodes({ consent: true, topics: { news: true } })).toEqual([]);
    expect(kernelCodes({ consent: true, topics: { news: true } })).toEqual([]);
  });

  it("reads a list or a text for a required checkbox group as nothing picked, on both sides", () => {
    for (const value of [["news"], "news", { news: false }, {}, true]) {
      const values = { consent: true, topics: value };
      const label = JSON.stringify(value);
      expect(clientCodes(values), label).toEqual(["topics:required"]);
      expect(kernelCodes(values), label).toEqual(["topics:required"]);
    }
  });

  it("reads emptiness alike in the stage, the kernel and the journey diagnostics", () => {
    const table: Array<[unknown, string]> = [
      [true, "checkbox"],
      [false, "checkbox"],
      ["true", "checkbox"],
      ["false", "checkbox"],
      [0, "checkbox"],
      [1, "checkbox"],
      ["yes", "checkbox"],
      [undefined, "checkbox"],
      [["a"], "checkboxes"],
      ["a", "checkboxes"],
      [{ a: true }, "checkboxes"],
      [{ a: false }, "checkboxes"],
      [false, "text"],
      [["a"], "select"]
    ];
    for (const [value, type] of table) {
      const label = `${JSON.stringify(value)} as ${type}`;
      const expected = !((type === "checkbox" && value === true) || (type === "checkboxes" && (value as { a?: unknown })?.a === true && !Array.isArray(value)) || type === "text" || type === "select");
      expect(isEmptyValue(value, type), label).toBe(expected);
      expect(kernelIsEmptyValue(value, type), `${label} (kernel)`).toBe(expected);
      expect(journeyEmptyAnswer(value, type), `${label} (diagnostics)`).toBe(expected);
    }
  });

  it("refuses a submit whose required consent box holds 0, with the sandboxed kernel, and accepts one written as the text true", async () => {
    const form = definition([{ id: "consent", type: "checkbox", configuration: { label: "I agree", required: true } }] as ComponentNode[]);
    const runtime = runtimeOf(form, true);
    runtime.setValue("consent", 0);
    const refused = await runtime.submit("submit", SUBMIT_CONTEXT);
    expect(refused.accepted).toBe(false);
    expect(runtime.errors().map((error) => `${error.componentId}:${error.code}`)).toContain("consent:required");
    runtime.setValue("consent", "true");
    const accepted = await runtime.submit("submit", SUBMIT_CONTEXT);
    expect(accepted.accepted).toBe(true);
    expect(accepted.canonicalSubmission?.submission.values).toMatchObject({ consent: true });
  });

  it("has the sandboxed kernel alone refuse a required consent box holding 0 or yes", async () => {
    const form = definition([{ id: "consent", type: "checkbox", configuration: { label: "I agree", required: true } }] as ComponentNode[]);
    for (const value of [0, "yes"]) {
      const runtime = runtimeOf(form, true, true);
      runtime.setValue("consent", value);
      const refused = await runtime.submit("submit", SUBMIT_CONTEXT);
      expect(refused.accepted, String(value)).toBe(false);
      expect(runtime.errors().map((error) => `${error.componentId}:${error.code}`), String(value)).toContain("consent:required");
    }
  });
});

describe("a journey's Continue reads a required answer as submit does", () => {
  const PAGES = {
    journeys: [
      {
        id: "j",
        validation: { continue: "page" },
        pages: [
          { id: "one", title: "You", components: ["name", "consent"] },
          { id: "check", kind: "review", title: "Check", components: [] }
        ]
      }
    ]
  } as unknown as FormDefinition["journey"];
  const FIELDS = [
    { id: "name", type: "text", configuration: { label: "Name", required: true } },
    { id: "consent", type: "checkbox", configuration: { label: "I agree", required: true } }
  ] as ComponentNode[];

  it("stays on a page whose required text holds only spaces, or whose required box holds anything but true", async () => {
    const runtime = runtimeOf(definition(FIELDS, PAGES));
    runtime.startJourney("j");
    runtime.setValue("name", "   ");
    runtime.setValue("consent", "yes");
    const stayed = await runtime.nextPage();
    expect(stayed).toMatchObject({ ok: false, pageId: "one", reason: "validation" });
    expect(runtime.errors().map((error) => `${error.componentId}:${error.code}`).sort()).toEqual(["consent:required", "name:required"]);
    runtime.setValue("name", "Ada");
    runtime.setValue("consent", "true");
    await expect(runtime.nextPage()).resolves.toMatchObject({ ok: true, pageId: "check" });
  });
});
