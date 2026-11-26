// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { DataSourceSet } from "../form-engine/core/schema/contracts.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import {
  FORM_FEATURES,
  FORM_FEATURE_PRESETS,
  FORM_OPT_IN_FEATURES,
  defineDatumFormRendererElement,
  DATUM_FORM_RENDERER_TAG,
  formFeatureOn,
  parseFormFeatures,
  type DatumFormRendererElement
} from "../form-engine/render/web-component/form-renderer-element.js";
import { defineDatumFormHostElement, DATUM_FORM_HOST_TAG, type DatumFormHostElement } from "../form-engine/render/web-component/form-host-element.js";

/*
 * `features` on <datum-form-renderer> and <datum-form-host>: the same list, parsed by
 * the same module, with the same meaning it has on <datum-form>. Absent is today's behaviour;
 * present is only the listed capabilities, and a capability left out is ignored with one console
 * warning, its methods reject, and its code is never loaded. The PDF pipeline is counted through
 * a mock, so "never requested" is asserted, not assumed.
 */

const pdfService = vi.hoisted(() => ({ loads: 0 }));

vi.mock("../form-engine/render/pdf/pdf-service.js", () => {
  pdfService.loads += 1;
  return { renderFormPdf: async () => ({ bytes: new Uint8Array([37, 80, 68, 70]), warnings: [], fileName: "form.pdf", layoutId: "x", layoutChoice: "derived", pageCount: 1 }) };
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | null | undefined | false, tries = 100): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = read();
    if (value) {
      return value;
    }
    await wait(5);
  }
  throw new Error("never became true");
}

function plainForm(): FormDefinition {
  return {
    id: "plain",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "name", type: "text", configuration: { label: "Your name" } }] }
    }
  } as FormDefinition;
}

/** Two fields on two journey pages: the journey opens the form as a journey. */
function journeyForm(): FormDefinition {
  return {
    ...plainForm(),
    id: "flow-form",
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "first", type: "text", configuration: { label: "First answer" } },
          { id: "second", type: "text", configuration: { label: "Second answer" } }
        ]
      }
    },
    journey: {
      opensAs: "journey",
      defaultJourneyId: "flow",
      journeys: [
        {
          id: "flow",
          pages: [
            { id: "one", title: "Page one", components: ["first"] },
            { id: "two", title: "Page two", components: ["second"] }
          ]
        }
      ]
    }
  } as FormDefinition;
}

function runtimeFor(definition: FormDefinition): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

function mount(definition: FormDefinition, attributes: Record<string, string> = {}, setup?: (element: DatumFormRendererElement) => void) {
  defineDatumFormRendererElement();
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  const errors: Array<{ code: string; message: string }> = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail));
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  setup?.(element);
  element.runtime = runtimeFor(definition);
  document.body.append(element);
  return { element, errors, root: element.shadowRoot! };
}

async function painted(root: ShadowRoot): Promise<void> {
  await until(() => root.querySelector("form"));
  // A rebuild landing after the first paint (a provisional build, then the real one).
  await wait(20);
}

/** The first heading the form draws (a journey page's own, here: these forms have no title). */
const heading = (root: ShadowRoot): string | undefined => root.querySelector("h1, h2, h3, h4, h5, h6")?.textContent?.trim();

/** A button by its accessible name. */
const button = (root: ShadowRoot, name: string): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === name);

/** The language switcher: the one select that is no field's. */
const switcher = (root: ShadowRoot): HTMLSelectElement | undefined => Array.from(root.querySelectorAll("select")).find((select) => select.closest("[data-component-id]") === null);

/** The `[<tag>] Ignoring ...: the features list does not include ...` warnings logged so far. */
function ignored(warn: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): string[] {
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("Ignoring ") && line.includes("the features list does not include"));
}

describe("the one features model", () => {
  it("is the module <datum-form> reads: the same tokens, presets and order", () => {
    expect(FORM_FEATURES).toEqual(["journeys", "print", "translations", "data-sources", "drafts", "server-validation", "signing", "pdf", "wasm", "agent"]);
    expect(parseFormFeatures("pdf, Journeys  drafts").features).toEqual(["journeys", "drafts", "pdf"]);
    expect(parseFormFeatures("minimal").features).toEqual([]);
    expect(parseFormFeatures("all").features).toEqual(FORM_FEATURE_PRESETS.all);
  });

  it("keeps agent opt-in: not in all, never implied by an absent list, on only when named", () => {
    expect(FORM_OPT_IN_FEATURES).toEqual(["agent"]);
    expect(FORM_FEATURE_PRESETS.all).not.toContain("agent");
    expect(FORM_FEATURE_PRESETS.all).toEqual(FORM_FEATURES.filter((feature) => feature !== "agent"));
    expect(parseFormFeatures("all").features).not.toContain("agent");
    expect(parseFormFeatures("all agent").features).toContain("agent");
    expect(parseFormFeatures("all agent").features).toEqual(FORM_FEATURES);
    expect(parseFormFeatures("agent").features).toEqual(["agent"]);

    expect(formFeatureOn(undefined, "agent")).toBe(false);
    expect(formFeatureOn(undefined, "pdf")).toBe(true);
    expect(formFeatureOn(parseFormFeatures("all").features, "agent")).toBe(false);
    expect(formFeatureOn(parseFormFeatures("all agent").features, "agent")).toBe(true);
    expect(formFeatureOn(parseFormFeatures("minimal").features, "pdf")).toBe(false);
  });
});

describe("<datum-form-renderer features>: the attribute and the property", () => {
  it("is absent by default, reads back in a fixed order, and an empty list is the minimal list", () => {
    const { element } = mount(plainForm());
    expect(element.features).toBeUndefined();

    element.setAttribute("features", "pdf, Journeys");
    expect(element.features).toEqual(["journeys", "pdf"]);
    element.features = ["print", "journeys"];
    expect(element.features).toEqual(["journeys", "print"]);

    element.setAttribute("features", "");
    expect(element.features).toEqual([]);
    element.removeAttribute("features");
    expect(element.features).toBeUndefined();
  });

  it("reports a word that names nothing as datum-error and leaves it out", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { element, errors } = mount(plainForm(), { features: "pdf nonsense" });
    expect(element.features).toEqual(["pdf"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/no such feature or preset: "nonsense"/);
    expect(errors[0]!.code).toBe("features.unknown");
  });

  it("reports features=\"all\" without agent, and with it only when the list names it", async () => {
    const all = mount(plainForm(), { features: "all" });
    await painted(all.root);
    expect(all.element.features).toEqual(FORM_FEATURE_PRESETS.all);
    expect(all.element.features).not.toContain("agent");
    expect(all.errors).toEqual([]);

    const named = mount(plainForm(), { features: "all agent" });
    await painted(named.root);
    expect(named.element.features).toEqual(FORM_FEATURES);
    expect(named.element.features).toContain("agent");
    // The renderer knows the token (a word it does not know is a datum-error, as above) and
    // gates nothing with it.
    expect(named.errors).toEqual([]);
  });

  it("accepts the tokens the engine's renderer has nothing behind (drafts, server-validation, wasm) without a word", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { element, root } = mount(plainForm(), { features: "drafts server-validation wasm" });
    await painted(root);
    expect(element.features).toEqual(["drafts", "server-validation", "wasm"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("<datum-form-renderer features>: absent is today's behaviour", () => {
  it("draws a plain form to the same markup with the attribute absent, `all`, or `minimal`", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const absent = mount(plainForm());
    await painted(absent.root);
    const all = mount(plainForm(), { features: "all" });
    await painted(all.root);
    const minimal = mount(plainForm(), { features: "minimal" });
    await painted(minimal.root);

    expect(all.root.innerHTML).toBe(absent.root.innerHTML);
    expect(minimal.root.innerHTML).toBe(absent.root.innerHTML);
    expect(warn).not.toHaveBeenCalled();
  });

  it("draws a journey page with the attribute absent or listing journeys, and says nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const absent = mount(journeyForm());
    await painted(absent.root);
    expect(heading(absent.root)).toBe("Step 1 of 2: Page one");
    expect(absent.root.textContent).not.toContain("Second answer");

    const listed = mount(journeyForm(), { features: "journeys" });
    await painted(listed.root);
    expect(heading(listed.root)).toBe("Step 1 of 2: Page one");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("<datum-form-renderer features>: journeys", () => {
  it("left out, a journey definition is one page with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { element, errors, root } = mount(journeyForm(), { features: "minimal" });
    await painted(root);

    expect(heading(root)).toBeUndefined();
    expect(button(root, "Continue")).toBeUndefined();
    expect(root.textContent).toContain("First answer");
    expect(root.textContent).toContain("Second answer");
    expect(ignored(warn)).toHaveLength(1);
    expect(ignored(warn)[0]).toMatch(/^\[datum-form-renderer\] Ignoring the runtime's journey: the features list does not include "journeys"\.$/);
    expect(errors).toEqual([]);

    // Once per list, however often the form repaints.
    element.runtime!.setValue("first", "a");
    await wait(40);
    expect(ignored(warn)).toHaveLength(1);
  });

  it("draws the journey page again when the list gains journeys", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { element, root } = mount(journeyForm(), { features: "minimal" });
    await painted(root);
    expect(heading(root)).toBeUndefined();
    element.features = "journeys";
    await until(() => heading(root));
    expect(root.textContent).not.toContain("Second answer");
  });
});

describe("<datum-form-renderer features>: pdf", () => {
  it("left out, the PDF methods reject naming pdf, the layouts are none, the pipeline is never imported, and the provider is ignored with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const before = pdfService.loads;
    const { element, root } = mount(plainForm(), { features: "minimal" }, (el) => {
      el.pdfProvider = {} as never;
    });
    await painted(root);

    await expect(element.renderPdf()).rejects.toThrow(/renderPdf\(\) is not available.*"pdf"/);
    await expect(element.downloadPdf()).rejects.toThrow(/downloadPdf\(\) is not available.*"pdf"/);
    expect(element.pdfLayouts()).toEqual([]);
    expect(pdfService.loads).toBe(before);
    expect(ignored(warn)).toHaveLength(1);
    expect(ignored(warn)[0]).toContain("pdfProvider");
  });

  it("listed, the PDF is made through the pipeline chunk, loaded on the first PDF and not before", async () => {
    const before = pdfService.loads;
    const { element, root } = mount(plainForm(), { features: "pdf" }, (el) => {
      el.pdfProvider = {} as never;
    });
    await painted(root);
    expect(pdfService.loads).toBe(before);
    const result = await element.renderPdf();
    expect(result?.bytes).toBeInstanceOf(Uint8Array);
    expect(pdfService.loads).toBe(before + 1);
  });
});

describe("<datum-form-renderer features>: print", () => {
  it("left out, print() rejects naming print; listed, it presents the document (here: a host takes it over)", async () => {
    const left = mount(plainForm(), { features: "minimal" });
    await painted(left.root);
    await expect(left.element.print()).rejects.toThrow(/print\(\) is not available.*"print"/);

    const listed = mount(plainForm(), { features: "print" });
    await painted(listed.root);
    let html = "";
    listed.element.addEventListener("datum-print", (event) => {
      event.preventDefault();
      html = (event as CustomEvent<{ html: string }>).detail.html;
    });
    await listed.element.print();
    expect(html).toContain("Your name");
  });
});

describe("<datum-form-renderer features>: data-sources", () => {
  it("left out, the host's data sources are never asked, with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn(async () => ({ items: [{ value: "a", label: "A" }] }));
    const sources = { has: () => true, ids: () => ["cities"], load } as unknown as DataSourceSet;
    const definition = {
      ...plainForm(),
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: { content: [{ id: "city", type: "select", configuration: { label: "City", data: { sourceId: "cities" } } }] }
      }
    } as unknown as FormDefinition;

    const listed = mount(definition, { features: "data-sources" }, (el) => {
      el.dataSources = sources;
    });
    await painted(listed.root);
    expect(load).toHaveBeenCalled();
    load.mockClear();

    const left = mount(definition, { features: "minimal" }, (el) => {
      el.dataSources = sources;
    });
    await painted(left.root);
    expect(load).not.toHaveBeenCalled();
    expect(ignored(warn)).toHaveLength(1);
    expect(ignored(warn)[0]).toContain("dataSources");
  });
});

describe("<datum-form-renderer features>: translations", () => {
  const twoLocales = (): FormDefinition =>
    ({
      ...plainForm(),
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr-CA", label: "Français" }] }
    }) as FormDefinition;

  it("draws the language switcher the host asked for, and with translations left out draws none, with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const asked = (el: DatumFormRendererElement) => {
      el.chrome = { header: [{ type: "language-switcher" }] };
    };
    const absent = mount(twoLocales(), {}, asked);
    await painted(absent.root);
    expect(switcher(absent.root)).toBeDefined();

    const left = mount(twoLocales(), { features: "minimal" }, asked);
    await painted(left.root);
    expect(switcher(left.root)).toBeUndefined();
    expect(ignored(warn)).toHaveLength(1);
    expect(ignored(warn)[0]).toContain("language switcher");
  });
});

describe("<datum-form-host features>", () => {
  it("ignores the journey choice with one warning when journeys is left out, and honours it when listed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    host.setAttribute("features", "minimal");
    host.journey = "flow";
    const runtime = runtimeFor(plainForm());
    const start = vi.spyOn(runtime, "startJourney");
    host.runtime = runtime;
    document.body.append(host);
    host.journey = "flow";
    expect(start).not.toHaveBeenCalled();
    expect(ignored(warn)).toEqual(['[datum-form-host] Ignoring the journey setting: the features list does not include "journeys".']);

    // Listed, the choice is read again (this form has no such journey, which the host says as it always did).
    host.features = "journeys";
    expect(warn.mock.calls.some((call) => String(call[0]).includes('The form has no journey "flow"'))).toBe(true);
  });

  it("forwards the list, draws no Print button without print and no PDF button without pdf", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    host.pdfProvider = {} as never;
    host.runtime = runtimeFor(plainForm());
    host.setAttribute("features", "minimal");
    document.body.append(host);
    const root = host.shadowRoot!;
    expect(root.querySelector("datum-form-renderer")?.getAttribute("features")).toBe("minimal");
    expect(root.querySelector<HTMLElement>("[data-print]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-pdf]")?.hidden).toBe(true);

    host.features = "print pdf";
    expect(root.querySelector<HTMLElement>("[data-print]")?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-pdf]")?.hidden).toBe(false);

    host.removeAttribute("features");
    expect(root.querySelector("datum-form-renderer")?.hasAttribute("features")).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-print]")?.hidden).toBe(false);
  });

  it("treats an empty features attribute as the minimal list, not as absent", () => {
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    host.setAttribute("features", "");
    document.body.append(host);
    expect(host.shadowRoot!.querySelector("datum-form-renderer")?.getAttribute("features")).toBe("");
    expect(host.shadowRoot!.querySelector<HTMLElement>("[data-print]")?.hidden).toBe(true);
  });

  it("draws a journey runtime's form on one page with one warning when journeys is left out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    host.setAttribute("features", "minimal");
    host.runtime = runtimeFor(journeyForm());
    document.body.append(host);
    const inner = host.shadowRoot!.querySelector("datum-form-renderer") as DatumFormRendererElement;
    await painted(inner.shadowRoot!);

    expect(heading(inner.shadowRoot!)).toBeUndefined();
    expect(inner.shadowRoot!.textContent).toContain("Second answer");
    expect(ignored(warn)).toHaveLength(1);
  });
});
