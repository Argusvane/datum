import { describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import { checkAnswerErrors, checkAnswers, createTryIt } from "../form-engine/builder/web-component/try-it.js";
import type { BuilderTrySubmitDetail } from "../form-engine/builder/web-component/try-it-types.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * Try it's Check now and Submit run the renderer's field-constraints stage over the tried
 * runtime's own fold: the Validate rule's `invalid` map goes in beside `required`,
 * so a rule the form enforces is a problem the checker lists, in the field's own words.
 */

const tree: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "number_1", type: "number", configuration: { label: "Total" } },
      {
        id: "number_3",
        type: "number",
        configuration: { label: "Part", messages: { rule: "The part cannot exceed the total." } },
        rules: { validWhen: "number_3 < number_1" }
      },
      { id: "show", type: "checkbox", configuration: { label: "Show" } },
      { id: "extra", type: "number", configuration: { label: "Extra" }, rules: { visibleWhen: "show = true", validWhen: "extra < 5" } }
    ]
  }
};

/** What Check now and Submit hand the checker, from a runtime holding `answers`. */
function check(answers: Record<string, unknown>, withInvalid = true) {
  const runtime = new BuilderPreviewRuntime(tree, { locale: "en" });
  for (const [id, value] of Object.entries(answers)) {
    runtime.setValue(id, value);
  }
  const states = runtime.effectiveStatesMap();
  const options = {
    locale: "en",
    required: runtime.requiredMap(),
    hidden: (id: string) => states.get(id)?.visible === false,
    ...(withInvalid ? { invalid: runtime.invalidMap() } : {})
  };
  return { errors: checkAnswerErrors(tree, answers, options), problems: checkAnswers(tree, answers, options) };
}

describe("Try it's checks read the Validate rule", () => {
  it("list a field whose validWhen fails, with the field's own rule message", () => {
    const { errors, problems } = check({ number_1: 4, number_3: 9 });
    expect(errors).toEqual([expect.objectContaining({ code: "rule", componentId: "number_3" })]);
    expect(problems).toEqual([{ componentId: "number_3", label: "Part", message: "The part cannot exceed the total." }]);
  });

  it("pass at valid answers", () => {
    expect(check({ number_1: 9, number_3: 4 }).errors).toEqual([]);
  });

  it("word a field with no rule message as the form does", () => {
    const plain: ComponentNode = {
      ...tree,
      children: { content: [{ id: "a", type: "number", configuration: { label: "A" }, rules: { validWhen: "a < 3" } }] }
    };
    const runtime = new BuilderPreviewRuntime(plain, { locale: "en" });
    runtime.setValue("a", 7);
    const options = { locale: "en", required: runtime.requiredMap(), hidden: () => false, invalid: runtime.invalidMap() };
    expect(checkAnswers(plain, { a: 7 }, options)).toEqual([{ componentId: "a", label: "A", message: "Check this answer" }]);
  });

  it("name a field by its label in the preview language when the sources hold one", () => {
    const plain: ComponentNode = {
      ...tree,
      children: { content: [{ id: "a", type: "number", configuration: { label: "Amount" }, rules: { validWhen: "a < 3" } }] }
    };
    const runtime = new BuilderPreviewRuntime(plain, { locale: "fr-CA" });
    runtime.setValue("a", 7);
    const translations = { "fr-CA": { components: { a: { label: { text: "Montant", source: "x" } } } } };
    const options = {
      locale: "fr-CA",
      required: runtime.requiredMap(),
      hidden: () => false,
      invalid: runtime.invalidMap(),
      sources: { translations, catalog: undefined }
    };
    expect(checkAnswers(plain, { a: 7 }, options).map((problem) => problem.label)).toEqual(["Montant"]);
    // Without the sources the authored (default-language) label shows.
    expect(checkAnswers(plain, { a: 7 }, { ...options, sources: {} }).map((problem) => problem.label)).toEqual(["Amount"]);
  });

  it("leave out a hidden field", () => {
    // "extra" fails its rule but "show" is off, so it is hidden.
    expect(check({ extra: 9 }).errors).toEqual([]);
    expect(check({ show: true, extra: 9 }).errors).toEqual([expect.objectContaining({ code: "rule", componentId: "extra" })]);
  });

  it("read no rule when the map is not handed over, and a form with none is unchanged", () => {
    expect(check({ number_1: 4, number_3: 9 }, false).errors).toEqual([]);
    const bare: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "n", type: "number", configuration: { required: true } }] } };
    const options = { locale: "en", required: new Map([["n", true]]), hidden: () => false };
    expect(checkAnswerErrors(bare, {}, options)).toEqual(checkAnswerErrors(bare, {}, { ...options, invalid: {} }));
  });
});

describe("Submit in Try it stops at a failing Validate rule", () => {
  /** A Try it with no panel drawn (the stub shadow root holds none): only its checks and events. */
  async function submitWith(answers: Record<string, unknown>): Promise<BuilderTrySubmitDetail[]> {
    const controller = new BuilderController({ initialRoot: tree });
    const preview = new BuilderPreviewRuntime(tree, { locale: "en" });
    for (const [id, value] of Object.entries(answers)) {
      preview.setValue(id, value);
    }
    const canvas = new EventTarget() as unknown as HTMLElement;
    const seen: BuilderTrySubmitDetail[] = [];
    canvas.addEventListener("builder-try-submit", (event) => seen.push((event as CustomEvent<BuilderTrySubmitDetail>).detail));
    const renderer = { notice: undefined, focusFirstError: () => undefined, revealComponent: () => undefined } as never;
    const tryIt = createTryIt({
      canvas,
      root: () => ({ querySelector: () => null }) as unknown as ShadowRoot,
      controller: () => controller,
      preview: () => preview,
      renderer: () => renderer,
      trySettings: () => controller,
      serverChecks: () => undefined,
      pdf: () => undefined,
      mode: () => "interactive",
      setMode: () => undefined
    });
    await tryIt.submit();
    return seen;
  }

  it("ends invalid at answers the rule refuses, nothing sent", async () => {
    expect((await submitWith({ number_1: 4, number_3: 9 })).map((detail) => detail.outcome)).toEqual(["invalid"]);
  });
});

describe("Try it flags a failing Validate rule in a mode session too", () => {
  /** A mode's session over a FormRuntime with no `check`: Check now falls back to the browser's field checks. */
  async function checkedInSession(answers: Record<string, unknown>): Promise<string> {
    const runtime = new FormRuntime({ id: "f", version: "1", schemaVersion: "1", root: tree, localization: { defaultLocale: "en" } }, {} as never);
    for (const [id, value] of Object.entries(answers)) {
      runtime.setValue(id, value);
    }
    expect(runtime.invalidMap().number_3 === true).toBe(answers.number_3 === 9);
    const controller = new BuilderController({ initialRoot: tree });
    const panel = { hidden: false, innerHTML: "", contains: () => false, querySelector: () => null, querySelectorAll: () => [], getRootNode: () => ({}) };
    const tryIt = createTryIt({
      canvas: new EventTarget() as unknown as HTMLElement,
      root: () => ({ querySelector: () => panel }) as unknown as ShadowRoot,
      controller: () => controller,
      preview: () => new BuilderPreviewRuntime(tree, { locale: "en" }),
      session: () => ({ runtime: runtime as never, answers: () => answers, submit: async () => ({ problems: [] }), refresh: () => undefined, restart: () => undefined, dispose: () => undefined }),
      renderer: () => ({}) as never,
      trySettings: () => controller,
      serverChecks: () => undefined,
      pdf: () => undefined,
      mode: () => "interactive",
      setMode: () => undefined
    });
    const hit = { dataset: { tryCheck: "" } } as unknown as HTMLElement;
    tryIt.click([hit]);
    await vi.waitFor(() => expect(panel.innerHTML).not.toBe(""));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return panel.innerHTML;
  }

  it("lists the field whose validWhen fails", async () => {
    expect(await checkedInSession({ number_1: 4, number_3: 9 })).toContain("The part cannot exceed the total.");
  });

  it("lists nothing at valid answers", async () => {
    expect(await checkedInSession({ number_1: 9, number_3: 4 })).not.toContain("The part cannot exceed the total.");
  });
});
