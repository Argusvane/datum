// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuilderController, type BuilderBindingOption, type TranslatableText } from "../form-engine/builder/controller/builder-controller.js";
import { extendBinding } from "../form-engine/render/live/contract.js";
import { createDatumBinding } from "../form-engine/render/live/datum/options.js";
import { parseSimulatedOptions as fromModule } from "../form-engine/builder/controller/simulated-options.js";
import { parseSimulatedOptions as fromBarrel } from "../form-engine/builder/index.js";
import { createJourneyBuilderMode } from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { JOURNEY_ROOT_TYPE } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import type { DatumBuilderLanguagesElement } from "../form-engine/builder/languages/languages-surface.js";
import type { DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import type { BuilderMode } from "../form-engine/builder/web-component/builder-modes.js";
import {
  defineDatumBuilderElement,
  type BuilderAgentTryParts,
  type DatumBuilderElement
} from "../form-engine/builder/web-component/default-builder-element.js";
import { readJourneys } from "../form-engine/core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { LANGUAGES, languagesRoot } from "./fixtures/builder-languages.js";

/*
 * The shell's seams for the builder agent tools:
 * the preview theme and language as the View panel and the bar's switcher set them, the canvas's
 * Try it parts passed through, and what the Languages surface lists, read without the surface.
 * jsdom applies no shadow CSS: everything here is attributes, properties and events.
 */

defineDatumBuilderElement();

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
  };
}

async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("until(): condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const canvasOf = (element: DatumBuilderElement): DatumBuilderCanvasElement => element.shadowRoot!.querySelector(".canvas") as DatumBuilderCanvasElement;

async function mount(setup?: (element: DatumBuilderElement) => void): Promise<DatumBuilderElement> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot(), componentTypes: [{ type: "text", label: "Text" }] };
  setup?.(element);
  document.body.append(element);
  await until(() => canvasOf(element)?.previewRoot()?.querySelector(".db-node[data-component-id]"));
  return element;
}

/** The `builder-binding-change` events heard on the document (bubbling and composed). */
function bindingEvents(): Array<{ bindingId: string }> {
  const heard: Array<{ bindingId: string }> = [];
  const listener = (event: Event): void => {
    heard.push((event as CustomEvent<{ bindingId: string }>).detail);
  };
  document.addEventListener("builder-binding-change", listener);
  removals.push(() => document.removeEventListener("builder-binding-change", listener));
  return heard;
}
const removals: Array<() => void> = [];
afterEach(() => {
  for (const remove of removals.splice(0)) {
    remove();
  }
});

/** The bindings a host offers to pick from: Datum's own, and two design systems of its own. */
const datum = createDatumBinding();
const BINDINGS: BuilderBindingOption[] = [
  { id: "datum", label: "Datum" },
  { id: "plain", label: "Plain", binding: extendBinding(datum, { id: "plain", label: "Plain" }) },
  { id: "contrast", label: "High contrast", binding: extendBinding(datum, { id: "contrast", label: "High contrast" }) }
];

/**
 * A designer's mode put on the page (Journeys or PDF stand-in): its own controller, built as JBM
 * and PBM build theirs, with no bindings offered to it and the form's languages.
 */
async function enterDesigner(element: DatumBuilderElement, id = "pdf"): Promise<BuilderController> {
  const controller = new BuilderController({ initialRoot: { id: `${id}-root`, type: "form", configuration: {} }, localization: LANGUAGES });
  element.addMode({ id, label: id, controller });
  expect(element.setMode(id)).toBe(true);
  // The switch activates the mode asynchronously.
  await until(() => element.activeController === controller);
  return controller;
}

describe("setBindingForAgent", () => {
  it("sets the controller's binding and tells the host, as the View panel's picker does", async () => {
    const element = await mount((el) => {
      el.options = { availableBindings: BINDINGS };
    });
    const heard = bindingEvents();
    const setBindingId = vi.spyOn(element.activeController, "setBindingId");
    expect(element.setBindingForAgent("contrast")).toBe(true);
    expect(element.activeController.bindingId()).toBe("contrast");
    expect(setBindingId).toHaveBeenCalledWith("contrast");
    expect(heard).toEqual([{ bindingId: "contrast" }]);
    // The person's picker: the same two effects, through the same body.
    const picker = element.shadowRoot!.querySelector<HTMLSelectElement>("[data-binding]")!;
    picker.value = "plain";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(element.activeController.bindingId()).toBe("plain");
    expect(heard).toEqual([{ bindingId: "contrast" }, { bindingId: "plain" }]);
  });

  it("answers false for an id the builder does not offer, and changes nothing", async () => {
    const element = await mount((el) => {
      el.options = { availableBindings: BINDINGS };
    });
    expect(element.setBindingForAgent("plain")).toBe(true);
    const heard = bindingEvents();
    const setBindingId = vi.spyOn(element.activeController, "setBindingId");
    expect(element.setBindingForAgent("gcds")).toBe(false);
    expect(element.setBindingForAgent("PLAIN")).toBe(false);
    expect(element.activeController.bindingId()).toBe("plain");
    expect(setBindingId).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
  });

  it("draws with the host's own binding for '' or undefined, and the host hears the empty id", async () => {
    const element = await mount((el) => {
      el.options = { availableBindings: BINDINGS };
    });
    expect(element.setBindingForAgent("contrast")).toBe(true);
    const heard = bindingEvents();
    expect(element.setBindingForAgent("")).toBe(true);
    // The host gave no binding: Datum's, which the picker's "datum" entry stands for.
    expect(element.activeController.canvasBinding()).toBeUndefined();
    expect(element.activeController.bindingId()).toBe("datum");
    expect(element.setBindingForAgent(undefined)).toBe(true);
    expect(heard).toEqual([{ bindingId: "" }, { bindingId: "" }]);
  });

  it("leaves the picker claiming no entry while the canvas draws with a binding it does not list, so choosing one is a change", async () => {
    const element = await mount((el) => {
      el.options = { availableBindings: BINDINGS.slice(1), binding: extendBinding(datum, { id: "elsewhere", label: "Elsewhere" }) };
    });
    const picker = element.shadowRoot!.querySelector<HTMLSelectElement>("[data-binding]")!;
    await until(() => picker.options.length === 2);
    expect(picker.selectedIndex).toBe(-1);
    const heard = bindingEvents();
    picker.value = "plain";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(element.activeController.bindingId()).toBe("plain");
    expect(heard).toEqual([{ bindingId: "plain" }]);
    await until(() => picker.selectedIndex === 0);
  });

  it("draws the form's binding from Journeys or PDF, where the designer's controller is offered none", async () => {
    const element = await mount((el) => {
      el.options = { availableBindings: BINDINGS };
    });
    const designer = await enterDesigner(element);
    expect(designer.availableBindings()).toEqual([]);
    const heard = bindingEvents();
    expect(element.setBindingForAgent("contrast")).toBe(true);
    expect(element.controller.bindingId()).toBe("contrast");
    expect(designer.bindingId()).toBeUndefined();
    expect(heard).toEqual([{ bindingId: "contrast" }]);
    expect(element.setBindingForAgent("gcds")).toBe(false);
    expect(element.controller.bindingId()).toBe("contrast");
  });

  it("answers false for everything when the builder offers no bindings", async () => {
    const element = await mount();
    const heard = bindingEvents();
    expect(element.setBindingForAgent("plain")).toBe(false);
    expect(element.setBindingForAgent("")).toBe(false);
    expect(element.setBindingForAgent(undefined)).toBe(false);
    expect(heard).toEqual([]);
  });
});

describe("setPreviewLocale", () => {
  async function mountLanguages(): Promise<DatumBuilderElement> {
    return mount((el) => {
      el.options = { initialRoot: languagesRoot(), localization: LANGUAGES, componentTypes: [{ type: "text", label: "Text" }, { type: "radio", label: "Choice" }] };
    });
  }
  const switcherOf = (element: DatumBuilderElement): HTMLElement & { value: string } =>
    element.shadowRoot!.querySelector("[data-locale-select]") as HTMLElement & { value: string };

  it("follows the bar's locale-change path: the controller moves and the switcher agrees", async () => {
    const element = await mountLanguages();
    const follow = vi.spyOn(element as unknown as { followBarLocale(locale: string | undefined): void }, "followBarLocale");
    // The person's switch first, through the switcher's own select.
    const select = switcherOf(element).shadowRoot!.querySelector<HTMLSelectElement>("select")!;
    select.value = "fr";
    select.dispatchEvent(new Event("change"));
    expect(follow).toHaveBeenLastCalledWith("fr");
    expect(element.activeController.currentLocale()).toBe("fr");
    await until(() => switcherOf(element).value === "fr");
    // The assistant's: the same body on the form's controller, the same agreement.
    element.setPreviewLocale("en");
    expect(follow).toHaveBeenLastCalledWith("en", element.controller);
    expect(follow).toHaveBeenCalledTimes(2);
    expect(element.activeController.currentLocale()).toBe("en");
    await until(() => switcherOf(element).value === "en");
    // The form itself is not changed.
    expect(element.activeController.localization()).toEqual(LANGUAGES);
  });

  it("moves Languages with it when the surface is on the page", async () => {
    const element = await mountLanguages();
    element.setWorkspace("languages");
    await until(() => element.shadowRoot!.querySelector<DatumBuilderLanguagesElement>("datum-builder-languages")?.locale);
    const surface = element.shadowRoot!.querySelector<DatumBuilderLanguagesElement>("datum-builder-languages")!;
    expect(surface.locale).toBe("en");
    element.setPreviewLocale("fr");
    expect(surface.locale).toBe("fr");
    expect(element.activeController.currentLocale()).toBe("fr");
  });

  it("moves the form's language from PDF, never the layout's own controller", async () => {
    const element = await mountLanguages();
    element.setWorkspace("languages");
    await until(() => element.shadowRoot!.querySelector<DatumBuilderLanguagesElement>("datum-builder-languages")?.locale);
    const surface = element.shadowRoot!.querySelector<DatumBuilderLanguagesElement>("datum-builder-languages")!;
    const designer = await enterDesigner(element);
    // The person has no switcher there (an empty list hides it): the seam is not a back door to
    // the designer's controller.
    expect((switcherOf(element) as unknown as { locales: unknown[] }).locales).toEqual([]);
    const designerOptions = vi.spyOn(designer, "setOptions");
    element.setPreviewLocale("fr");
    expect(element.controller.currentLocale()).toBe("fr");
    expect(designer.currentLocale()).toBe("en");
    expect(designerOptions).not.toHaveBeenCalled();
    expect(surface.locale).toBe("fr");
    // Back on the form's tree, the switcher shows what the form is in.
    expect(element.setMode("form")).toBe(true);
    await until(() => element.activeController === element.controller && switcherOf(element).value === "fr");
    expect(element.activeController.currentLocale()).toBe("fr");
    expect(surface.locale).toBe("fr");
  });

  it("moves a journey on the page with the form, as the mode would on its next draw, and no edit", async () => {
    const element = await mountLanguages();
    const changes: unknown[] = [];
    const mode = createJourneyBuilderMode({
      form: element.controller,
      journey: { journeys: [{ id: "apply", name: "Apply", pages: [{ id: "about", components: ["name", "kind"] }] }] },
      onChange: (detail) => changes.push(detail)
    });
    element.addMode(mode);
    expect(element.setMode("journeys")).toBe(true);
    // The switch activates the mode (its designer chunk loads); the journey is then built on its controller.
    await until(() => element.activeController === mode.controller && mode.controller.snapshot().type === JOURNEY_ROOT_TYPE);
    const journey = mode.controller;
    expect(journey.currentLocale()).toBe("en");
    const reasons: string[] = [];
    const off = journey.on("change", (event) => reasons.push(event.reason));
    element.setPreviewLocale("fr");
    off();
    expect(element.controller.currentLocale()).toBe("fr");
    // The canvas on the page agrees with the form, now, not when the journey is next brought up.
    expect(mode.controller).toBe(journey);
    expect(journey.currentLocale()).toBe("fr");
    // Repainted, not edited: nothing for the mode to write or report.
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((reason) => reason === "preview")).toBe(true);
    expect(changes).toEqual([]);
    // The round trip through the form's tree keeps the two together.
    expect(element.setMode("form")).toBe(true);
    await until(() => element.activeController === element.controller);
    expect(element.setMode("journeys")).toBe(true);
    await until(() => element.activeController === journey);
    expect(journey.currentLocale()).toBe("fr");
    element.setPreviewLocale("en");
    expect(journey.currentLocale()).toBe("en");
    expect(element.controller.currentLocale()).toBe("en");
  });

  it("ignores an empty code, as the bar's path does", async () => {
    const element = await mountLanguages();
    const setOptions = vi.spyOn(element.activeController, "setOptions");
    element.setPreviewLocale("");
    expect(setOptions).not.toHaveBeenCalled();
    expect(element.activeController.currentLocale()).toBe("en");
  });
});

describe("agentTryParts", () => {
  const NAMES = [
    "triedRuntime",
    "agentTryCheck",
    "agentTrySubmit",
    "quietTriedPageFocus",
    "focusedTriedPath",
    "tryReady",
    "tryPageIdOf",
    "tryNodeIdOf",
    "tryRecording",
    "tryShowing",
    "tryServerChecks",
    "onTrySubmit",
    "tryChunkState"
  ] as const satisfies ReadonlyArray<keyof BuilderAgentTryParts>;

  it("is undefined before the shell has drawn a canvas", () => {
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    expect(element.agentTryParts()).toBeUndefined();
  });

  it("hands every canvas member through, arguments and answers alike, tryChunkState included", async () => {
    const element = await mount();
    const parts = element.agentTryParts()!;
    expect(Object.keys(parts).sort()).toEqual([...NAMES].sort());
    const canvas = canvasOf(element) as unknown as Record<string, (...args: unknown[]) => unknown>;
    // onTrySubmit hears the canvas's event on the shell (its own case below).
    for (const name of NAMES.filter((each) => each !== "onTrySubmit")) {
      const answer = { from: name };
      const spy = vi.spyOn(canvas, name).mockReturnValue(answer);
      const args = name === "tryPageIdOf" || name === "tryNodeIdOf" ? ["node-or-page"] : [];
      expect((parts[name] as (...a: unknown[]) => unknown)(...args), name).toBe(answer);
      expect(spy, name).toHaveBeenCalledTimes(1);
      expect(spy, name).toHaveBeenCalledWith(...args);
    }
  });

  it("answers what the canvas answers, unmocked: the chunk state and no tried runtime while editing", async () => {
    const element = await mount();
    const parts = element.agentTryParts()!;
    expect(parts.tryChunkState()).toBe(canvasOf(element).tryChunkState());
    expect(parts.triedRuntime()).toBeUndefined();
    expect(parts.tryRecording()).toBe(false);
    const off = await mount((el) => {
      el.setAttribute("features", "form");
    });
    expect(off.agentTryParts()!.tryChunkState()).toBe("off");
  });

  it("reaches the canvas the shell has when called, after a reconnect rebuilds it", async () => {
    const element = await mount();
    const parts = element.agentTryParts()!;
    const first = canvasOf(element);
    element.remove();
    document.body.append(element);
    expect(canvasOf(element)).not.toBe(first);
    const spy = vi.spyOn(canvasOf(element), "tryChunkState").mockReturnValue("loading");
    expect(parts.tryChunkState()).toBe("loading");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("onTrySubmit hears the canvas's builder-try-submit, from a canvas rebuilt after it subscribed, until unsubscribed", async () => {
    const element = await mount();
    const parts = element.agentTryParts()!;
    const heard: unknown[] = [];
    const stop = parts.onTrySubmit((outcome) => heard.push(outcome));
    const submitFrom = (canvas: DatumBuilderCanvasElement, detail: object): void => {
      canvas.dispatchEvent(new CustomEvent("builder-try-submit", { detail, bubbles: true, composed: true }));
    };
    const first = { outcome: "accepted", from: "first" };
    submitFrom(canvasOf(element), first);
    expect(heard).toEqual([first]);
    // A page move rebuilds the shadow root: the subscription made before it still hears.
    const before = canvasOf(element);
    element.remove();
    document.body.append(element);
    expect(canvasOf(element)).not.toBe(before);
    const second = { outcome: "refused", from: "rebuilt" };
    submitFrom(canvasOf(element), second);
    expect(heard).toEqual([first, second]);
    stop();
    submitFrom(canvasOf(element), { outcome: "accepted", from: "after" });
    expect(heard).toEqual([first, second]);
  });
});

describe("agentLanguageInputs and agentLanguagesPending", () => {
  const journeyText: TranslatableText = {
    componentId: "journey.apply",
    componentLabel: "Apply",
    propertyPath: "name",
    label: "Journey name",
    default: "Apply",
    address: { kind: "journeys", owner: "apply", path: ["name"] }
  };
  const pdfText: TranslatableText = {
    componentId: "pdf.summary",
    componentLabel: "Summary",
    propertyPath: "title",
    label: "Title",
    default: "Summary",
    address: { kind: "pdf", owner: "summary", path: ["accessibility", "title"] }
  };
  const textsMode = (id: string, texts: Pick<BuilderMode, "translatableTexts" | "languageTexts">): BuilderMode => ({
    id,
    label: id,
    controller: new BuilderController({ initialRoot: { id: `${id}-root`, type: "form", configuration: {} } }),
    ...texts
  });

  async function mountLanguages(setup?: (element: DatumBuilderElement) => void): Promise<DatumBuilderElement> {
    return mount((el) => {
      el.options = { initialRoot: languagesRoot(), localization: LANGUAGES, componentTypes: [{ type: "text", label: "Text" }, { type: "radio", label: "Choice" }] };
      setup?.(el);
    });
  }

  it("returns what the shell feeds the Languages surface beyond the form: journeys, PDF texts and the host's catalog", async () => {
    // The host's catalog has the shape of the definition's map, with string leaves.
    const catalog = { fr: { form: { title: "Permis (catalogue)" } } };
    const element = await mountLanguages((el) => {
      el.translationsSource = () => ({ catalog });
    });
    element.addMode(textsMode("journeys", { translatableTexts: () => [journeyText] }));
    element.addMode(textsMode("pdf", { languageTexts: () => [pdfText] }));
    const inputs = element.agentLanguageInputs();
    // The header and footer texts are the form controller's own now, not the shell's to feed.
    expect(inputs).toEqual({ extraTexts: [journeyText], pdfTexts: [pdfText], catalog, notLoaded: [] });
    expect(element.translatableTexts().some((row) => row.address?.kind === "chrome")).toBe(true);
  });

  it("is the same without the surface ever on the page, and has no catalog key without a host catalog", async () => {
    const element = await mountLanguages();
    const inputs = element.agentLanguageInputs();
    expect("catalog" in inputs).toBe(false);
    expect(inputs).toEqual({ extraTexts: [], pdfTexts: [], notLoaded: [] });
  });

  it("reads the form's rows in Journeys or PDF too, never the designer's tree on the page", async () => {
    const element = await mountLanguages();
    const onForm = element.agentLanguageInputs();
    await enterDesigner(element);
    expect(element.activeController).not.toBe(element.controller);
    expect(element.agentLanguageInputs()).toEqual(onForm);
  });

  it("names a side whose documents the form holds while its mode is not registered", async () => {
    const bareDefinition: FormDefinition = { id: "permit", version: "1.0.0", schemaVersion: "1.0.0", root: languagesRoot() };
    // Shapes read tolerantly (readJourneys; the layouts only counted), so stand-ins do.
    const definition = {
      ...bareDefinition,
      journey: { journeys: [{ id: "apply", name: "Apply", pages: [{ id: "about", title: "About", components: ["name"] }] }] },
      pdf: { layouts: [{ id: "summary", kind: "generated" }] }
    } as unknown as FormDefinition;
    expect(readJourneys(definition)).toHaveLength(1);
    const element = await mountLanguages((el) => {
      el.logicDefinition = () => definition;
    });
    expect(element.agentLanguageInputs().notLoaded).toEqual(["journeys", "pdf"]);
    element.addMode(textsMode("journeys", { translatableTexts: () => [journeyText] }));
    expect(element.agentLanguageInputs().notLoaded).toEqual(["pdf"]);
    element.addMode(textsMode("pdf", { languageTexts: () => [pdfText] }));
    expect(element.agentLanguageInputs().notLoaded).toEqual([]);
    // A form with neither block has nothing missing, registered or not.
    const bare = await mountLanguages((el) => {
      el.logicDefinition = () => bareDefinition;
    });
    expect(bare.agentLanguageInputs().notLoaded).toEqual([]);
  });

  it("agentLanguagesPending: 0 without the surface, the surface's pendingCount with it", async () => {
    const element = await mountLanguages();
    expect(element.agentLanguagesPending()).toBe(0);
    element.setWorkspace("languages");
    await until(() => element.shadowRoot!.querySelector("datum-builder-languages")?.shadowRoot?.querySelector('[data-languages-cell="components/kind/label"][data-languages-locale="fr"]'));
    const surface = element.shadowRoot!.querySelector<DatumBuilderLanguagesElement>("datum-builder-languages")!;
    expect(element.agentLanguagesPending()).toBe(0);
    const cell = surface.shadowRoot!.querySelector<HTMLInputElement>('[data-languages-cell="components/kind/label"][data-languages-locale="fr"]')!;
    cell.focus();
    cell.value = "Genre";
    cell.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    expect(surface.pendingCount).toBe(1);
    expect(element.agentLanguagesPending()).toBe(surface.pendingCount);
  });
});

describe("parseSimulatedOptions", () => {
  it("is one function: the builder barrel's and the module's", () => {
    expect(fromBarrel).toBe(fromModule);
  });
});
