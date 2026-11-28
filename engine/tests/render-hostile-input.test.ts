// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { scalarText } from "../form-engine/render/core/scalar-text.js";
import { printPageCss } from "../form-engine/render/print/document.js";
import type { PrintModel } from "../form-engine/render/print/model.js";
import { bodyHtml, definitionOf, drawDatum, markupOf, unmountAll } from "./live-datum-parts-kit.js";
import {
  defineDatumFormRendererElement,
  DATUM_FORM_RENDERER_TAG,
  type DatumFormRendererElement
} from "../form-engine/render/web-component/form-renderer-element.js";
import { extendBinding, type FieldAdapter } from "../form-engine/render/live/contract.js";
import { createDatumBinding } from "../form-engine/render/live/renderer.js";

afterEach(() => {
  unmountAll();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function formOf(content: unknown[]) {
  return { id: "root", type: "form", configuration: {}, children: { content } };
}

/** A runtime for `root` holding `values` as a stored draft: the one way an answer a field cannot hold gets in. */
async function runtimeHolding(root: unknown, values: Record<string, unknown>): Promise<FormRuntime> {
  const definition = { id: "f1", version: "1", schemaVersion: "1", root } as unknown as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
  await runtime.hydrateFromDraft({
    id: "d",
    formId: "f1",
    formVersion: "1",
    locale: "en",
    values,
    state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [] },
    runtime: { schemaVersion: "1", rendererVersion: "1" },
    updatedAt: 0
  } as never);
  return runtime;
}

/** The root's fields drawn by the Datum binding, holding `values` as a stored draft. */
async function drawn(root: unknown, values: Record<string, unknown> = {}): Promise<string> {
  unmountAll();
  const runtime = await runtimeHolding(root, values);
  return bodyHtml(await drawDatum(definitionOf([]), {}, { runtime }));
}

const poisoned = (): unknown[] => [
  JSON.parse('{"toString":"x"}'),
  JSON.parse('{"valueOf":1,"toString":2}'),
  [JSON.parse('{"toString":"x"}')],
  Object.create(null),
  { a: 1 },
  Symbol("s")
];

describe("a non-scalar answer in a scalar field", () => {
  it("is text only when it is a string, number, boolean or bigint", () => {
    expect(scalarText("a")).toBe("a");
    expect(scalarText(0)).toBe("0");
    expect(scalarText(false)).toBe("false");
    expect(scalarText(10n)).toBe("10");
    for (const value of [...poisoned(), undefined, null]) {
      expect(scalarText(value)).toBe("");
    }
  });

  it.each(["text", "textarea", "number", "date", "select", "radio"])("draws a %s field empty instead of throwing", async (type) => {
    const field = { id: "f", type, configuration: { label: "F", characterCount: true, maxLength: 10, options: [{ value: "a", label: "A" }] } };
    for (const value of poisoned()) {
      const html = await drawn(formOf([field]), { f: value });
      expect(typeof html).toBe("string");
      expect(html).not.toContain("[object Object]");
    }
  });

  it("draws the stored draft of a poisoned answer through a runtime", async () => {
    const runtime = await runtimeHolding(formOf([{ id: "name", type: "text", configuration: { label: "Name" } }]), { name: JSON.parse('{"toString":"x"}') });
    const m = await drawDatum(definitionOf([]), {}, { runtime });
    expect(m.root.querySelector<HTMLInputElement>("input")?.value).toBe("");
  });
});

describe("locale codes named like Object.prototype members", () => {
  it.each(["constructor", "__proto__", "valueOf", "hasOwnProperty"])("the language links draw the label for the code %s", async (code) => {
    const definition = definitionOf([{ id: "a", type: "text", configuration: { label: "A" } }], {
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code, label: "Other" }] }
    } as never, { chrome: { header: [{ id: "lang", type: "language-switcher" }] } });
    const m = await drawDatum(definition, { controls: { languageLinks: { names: { en: "English", fr: "Français" } } } });
    const html = bodyHtml(m);
    expect(html).toContain("Other");
    expect(html).toContain("English");
  });

  it("still names a language the map holds", async () => {
    const definition = definitionOf([{ id: "a", type: "text", configuration: { label: "A" } }], {
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "French" }] }
    } as never, { chrome: { header: [{ id: "lang", type: "language-switcher" }] } });
    const m = await drawDatum(definition, { controls: { languageLinks: { names: { fr: "Français" } } } });
    expect(bodyHtml(m)).toContain("Français");
  });
});

describe("the print page's running title", () => {
  const modelWith = (title: string): PrintModel =>
    ({ title, dir: "ltr", page: { header: { start: [{ text: title }] }, footer: {}, titleOnFirstPage: true, journeyPageBreaks: false, scale: 1, size: "auto", margin: "16mm" }, words: { pageNumber: "Page {{page}} of {{pages}}" } }) as never;

  it.each(["\r", "\f", "\n", "\r\n", "\u0000", "\u000b", "\u007f"])("cannot end its CSS string with %j", (control) => {
    const css = printPageCss(modelWith(`A${control}} body{display:none} @page{ @top-left{content:"`), "");
    const inString = /content: "((?:[^"\\]|\\.)*)"/.exec(css)?.[0] ?? "";
    expect(inString).not.toBe("");
    // No raw control character is left in the string, and the injected rule is only text in it.
    expect(/[\u0000-\u001f\u007f]/.test(inString)).toBe(false);
    expect(css.replace(inString, "").match(/@page/g)).toHaveLength(1);
  });

  it("still writes a line break as a CSS newline", () => {
    const css = printPageCss(modelWith("one\r\ntwo\nthree"), "");
    expect(css).toContain('"one\\a two\\a three"');
  });
});

describe("a notice from the host", () => {
  const field = { id: "a", type: "text", configuration: { label: "A" } };
  const NOTICES: Record<string, unknown> = {
    numberValue: { kind: "info", message: "m", details: [{ label: "Number", value: 5 }] },
    objectValue: { kind: "info", message: "m", details: [{ label: "Object", value: { a: 1 } }] },
    nullDetail: { kind: "info", message: "m", details: [null, 5, "s", [], { label: "Kept", value: "v" }] },
    recordDetails: { kind: "info", message: "m", details: { a: 1 } },
    stringDetails: { kind: "info", message: "m", details: "abc" },
    nullTitle: { kind: "info", title: null, message: "m" },
    numberTitle: { kind: "info", title: 5, message: { default: 7 } },
    stringPlacement: { kind: "info", message: "m", placement: "bottom" },
    notAnObject: "oops"
  };

  async function withNotice(notice: unknown): Promise<string> {
    unmountAll();
    const m = await drawDatum(definitionOf([field as never]), {}, { featureOptions: { formNotices: { notice: () => notice as never } } });
    return bodyHtml(m);
  }

  it.each(Object.keys(NOTICES))("is drawn without throwing: %s", async (name) => {
    const html = await withNotice(NOTICES[name]);
    expect(typeof html).toBe("string");
    expect(html).not.toContain("[object Object]");
    expect(html).not.toContain("undefined");
  });

  it("draws the details it can read and skips the rest", async () => {
    const html = await withNotice(NOTICES.nullDetail);
    expect(html).toContain("Kept");
    expect(html.match(/datum-form__notice-detail(?![-\w])/g)).toHaveLength(1);
  });

  it("draws nothing for a notice that carries only its data, the receipt a printed form's header reads", async () => {
    expect(await withNotice({ kind: "info", message: "m" })).toContain("datum-form__notice");
    const html = await withNotice({ kind: "success", data: { reference: "GC-48213" } });
    expect(html).not.toContain("datum-form__notice");
    expect(html).not.toContain("GC-48213");
  });

  it("reads a number as its text and an object as nothing", async () => {
    expect(await withNotice(NOTICES.numberValue)).toMatch(/Number<\/dt>\s*<dd[^>]*>5</);
    expect(await withNotice(NOTICES.objectValue)).toMatch(/Object<\/dt>\s*<dd[^>]*><\/dd>/);
  });
});

describe("a binding's adapter that throws while the renderer element draws", () => {
  function formDefinition(): FormDefinition {
    return {
      id: "plain",
      version: "1",
      schemaVersion: "1",
      root: formOf([{ id: "name", type: "text", configuration: { label: "Your name" } }])
    } as unknown as FormDefinition;
  }

  function runtimeFor(definition: FormDefinition): FormRuntime {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
  }

  /** A binding whose text adapter throws while `breaking.on`; Datum's adapters stand behind it. */
  function breakingBinding(breaking: { on: boolean }) {
    const datum = createDatumBinding();
    const text = datum.components.text as FieldAdapter;
    return extendBinding(datum, {
      id: "breaking",
      label: "Breaking",
      components: {
        text: {
          ...text,
          template: (state, on) => {
            if (breaking.on) {
              throw new Error("an adapter broke");
            }
            return text.template(state, on);
          }
        } as FieldAdapter
      }
    });
  }

  function mount(breaking: { on: boolean }) {
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    const problems: Array<{ hook: string; id?: string; message: string }> = [];
    const errors: Array<{ message: string }> = [];
    element.addEventListener("datum-binding-error", (event) => problems.push((event as CustomEvent).detail));
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail));
    element.binding = breakingBinding(breaking);
    const runtime = runtimeFor(formDefinition());
    element.runtime = runtime;
    document.body.append(element);
    return { element, problems, errors, runtime, root: element.shadowRoot! };
  }

  const field = (root: ShadowRoot) => root.querySelector<HTMLElement>('[data-component-id="name"]');

  it("is reported once as datum-binding-error, Datum's adapter draws the field, and the field still takes answers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const breaking = { on: false };
    const { element, problems, errors, runtime, root } = mount(breaking);
    await element.painted();
    expect(field(root)?.querySelector("input")).not.toBeNull();
    expect(problems).toEqual([]);
    expect(element.live?.adapterOf("name")?.from).toBe("binding");

    breaking.on = true;
    runtime.setValue("name", "Ada");
    await element.painted();
    expect(problems).toEqual([expect.objectContaining({ hook: "template", id: "name", message: "an adapter broke" })]);
    // The form was drawn: no alert in its place, nothing on the host's general error channel.
    expect(errors).toEqual([]);
    expect(element.live?.adapterOf("name")?.from).toBe("datum");
    expect(field(root)?.hasAttribute("data-fallback")).toBe(true);

    // Every later draw throws the same way and is not reported again.
    runtime.setValue("name", "Grace");
    await element.painted();
    expect(problems).toHaveLength(1);

    // The field Datum drew still answers: a keystroke writes, leaving the field commits.
    const input = field(root)!.querySelector<HTMLInputElement>("input")!;
    const committed: unknown[] = [];
    runtime.events().subscribe(FormEventType.COMPONENT_COMMITTED, (event) => {
      committed.push(event);
    });
    input.value = "Hopper";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(runtime.formValues().name).toBe("Hopper");
    expect(committed).toHaveLength(1);
  });

  it("leaves every setter and a reconnect quiet: none throws, and the element keeps its form when it is moved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const breaking = { on: true };
    const { element, problems, root } = mount(breaking);
    await element.painted();
    expect(problems.map((problem) => problem.hook)).toEqual(["template"]);

    expect(() => {
      element.extraStyles = ".x { color: red; }";
      element.submitting = true;
      element.chrome = {} as never;
      element.messages = { required: "Needed" } as never;
    }).not.toThrow();
    await element.painted();
    expect(problems).toHaveLength(1);

    const live = element.live;
    expect(() => {
      element.remove();
      document.body.append(element);
    }).not.toThrow();
    await element.painted();
    expect(element.live).toBe(live);
    expect(field(root)).not.toBeNull();
  });
});
