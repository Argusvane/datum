import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import { DatumBuilderElement, type ComponentNode } from "../src/builder.js";
import type { AdapterEntry, BuilderTrySubmitDetail, LiveBinding, TryItServerChecks } from "@argusvane/datum-engine";
import {
  BuilderController,
  BuilderPreviewRuntime,
  type BuilderMode,
  type BuilderModeContext,
  type BuilderTrySession,
  type ComponentDefinition,
  type FormError,
  type PdfGeneratedLayout,
  type PdfRenderProvider
} from "@argusvane/datum-engine";

// The one lit-html the engine carries: a face is a template of it.
import { lit } from "../../../engine/form-engine/render/live/lit.js";

import { until } from "./helpers.js";

/**
 * Submit in Try it against the Settings panel's stand-in server, and Try it's WebAssembly
 * validation part: the inner builder, which lends no validator of its own.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Sample" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
        { id: "submit", type: "button", configuration: { label: "Send", action: "submit" } }
      ]
    }
  };
}

type Canvas = HTMLElement & { previewing: boolean; serverChecks: unknown };

const canvasEl = (element: DatumBuilderElement): Canvas => element.shadowRoot!.querySelector("datum-builder-canvas") as Canvas;
const canvas = (element: DatumBuilderElement): ShadowRoot => canvasEl(element).shadowRoot!;
const renderer = (element: DatumBuilderElement) =>
  canvas(element).querySelector("[data-preview]") as HTMLElement & {
    mode: string;
    submitting: boolean;
    submittingPlacement: string[] | undefined;
    texts: { submitting?: string } | undefined;
    notice: { kind?: string; title?: string; message?: string; placement?: string[]; details?: Array<{ label: string; value: string }> } | undefined;
    shadowRoot: ShadowRoot;
  };

async function mount(): Promise<DatumBuilderElement> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot() };
  document.body.append(element);
  await until(() => element.shadowRoot?.querySelector("datum-builder-canvas")?.shadowRoot?.querySelector(".canvas-page"));
  return element;
}

async function trying(element?: DatumBuilderElement): Promise<{ element: DatumBuilderElement; panel: HTMLElement }> {
  const mounted = element ?? (await mount());
  canvasEl(mounted).previewing = true;
  const panel = canvas(mounted).querySelector<HTMLElement>("[data-try-panel]")!;
  await until(() => !panel.hidden && panel.querySelector("[data-try-check]"));
  return { element: mounted, panel };
}

async function typeName(element: DatumBuilderElement, value: string): Promise<void> {
  await until(() => renderer(element).shadowRoot.querySelector('[data-component-id="fullName"] input'));
  const input = renderer(element).shadowRoot.querySelector<HTMLInputElement>('[data-component-id="fullName"] input')!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  await until(() => element.controller && (canvasEl(element) as unknown as { previewRuntime(): { state(): { values: Record<string, unknown> } } }).previewRuntime().state().values.fullName === value);
}

async function pressSubmit(element: DatumBuilderElement): Promise<void> {
  const button = (): HTMLElement | null => renderer(element).shadowRoot.querySelector<HTMLElement>('[data-button-action="submit"]');
  await until(() => button());
  button()!.click();
}

function submits(element: DatumBuilderElement): BuilderTrySubmitDetail[] {
  const seen: BuilderTrySubmitDetail[] = [];
  element.addEventListener("builder-try-submit", (event) => seen.push((event as CustomEvent<BuilderTrySubmitDetail>).detail));
  return seen;
}

describe("Submitting in Try it, on the Settings panel", () => {
  it("draws every setting from the controller and writes an edit back, a placement keeping one end", async () => {
    const element = await mount();
    const section = element.shadowRoot!.querySelector<HTMLElement>("[data-settings-panel] [data-settings-submit]")!;
    expect(section.querySelector("h3")!.textContent).toBe("Submitting in Try it");
    expect(section.textContent).toContain("a stand-in for the page's server. The form keeps none of it.");
    // After Language, before Data sources.
    const sections = [...element.shadowRoot!.querySelectorAll<HTMLElement>("[data-settings-panel] .settings-section")].map((entry) => entry.querySelector("h3")!.textContent);
    expect(sections).toEqual(["Language", "Submitting in Try it", "Host values", "Data sources"]);
    const control = <T extends HTMLElement>(path: string): T => section.querySelector<T>(`[data-try-setting="${path}"]`)!;
    expect(control<HTMLSelectElement>("outcome").value).toBe("accept");
    expect(control<HTMLInputElement>("delayMs").value).toBe("800");
    expect(control<HTMLInputElement>("receipt.title").value).toBe("Thank you");
    expect(control<HTMLInputElement>("receipt.referencePattern").value).toBe("DT-{n}");
    expect(control<HTMLInputElement>("refusalMessage").value).toBe("The server refused the form.");
    // Every control is labelled.
    for (const entry of section.querySelectorAll<HTMLInputElement>("input, select")) {
      expect(entry.closest("label"), entry.outerHTML).not.toBeNull();
    }

    const outcome = control<HTMLSelectElement>("outcome");
    outcome.value = "refuse";
    outcome.dispatchEvent(new Event("change", { bubbles: true }));
    expect(element.controller.trySubmission().outcome).toBe("refuse");
    const delay = control<HTMLInputElement>("delayMs");
    delay.value = "99999";
    delay.dispatchEvent(new Event("change", { bubbles: true }));
    expect(element.controller.trySubmission().delayMs).toBe(10_000);
    expect(delay.value).toBe("10000");
    const title = control<HTMLInputElement>("receipt.title");
    title.value = "Merci";
    title.dispatchEvent(new Event("change", { bubbles: true }));
    expect(element.controller.trySubmission().receipt.title).toBe("Merci");
    expect(element.controller.trySubmission().receipt.message).toBe("We have your answers.");

    const ends = section.querySelectorAll<HTMLInputElement>('[data-try-placement="receipt.placement"] input');
    ends[1]!.checked = true;
    ends[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(element.controller.trySubmission().receipt.placement).toEqual(["top", "bottom"]);
    ends[0]!.checked = false;
    ends[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(element.controller.trySubmission().receipt.placement).toEqual(["bottom"]);
    // The last end cleared stays ticked.
    ends[1]!.checked = false;
    ends[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ends[1]!.checked).toBe(true);
    expect(element.controller.trySubmission().receipt.placement).toEqual(["bottom"]);

    // The controller's own change is drawn.
    element.controller.setTrySubmission({ afterAccept: "readonly", statusText: "Sending" });
    await until(() => control<HTMLSelectElement>("afterAccept").value === "readonly");
    expect(control<HTMLInputElement>("statusText").value).toBe("Sending");
  });
});

describe("Submit in Try it", () => {
  it("puts the checks' problems on the form and lists them, with no receipt", async () => {
    const element = await mount();
    const seen = submits(element);
    const { panel } = await trying(element);
    expect(panel.querySelector("[data-try-submit]")!.textContent).toContain("Not yet");
    await pressSubmit(element);
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ outcome: "invalid", answers: {} });
    expect(renderer(element).notice).toBeUndefined();
    expect(renderer(element).submitting).toBe(false);
    await until(() => renderer(element).shadowRoot.querySelector("[data-datum-summary] [role=alert]"));
    expect(renderer(element).shadowRoot.querySelector('[data-component-id="fullName"]')!.textContent).toMatch(/required/i);
    expect(panel.querySelector("[data-try-submit]")!.textContent).toContain("1 problem");
    expect(panel.querySelector<HTMLElement>(".try-problem")!.dataset.tryGoto).toBe("fullName");

    // A field's error goes once its value changes.
    await typeName(element, "Ada");
    await until(() => !renderer(element).shadowRoot.querySelector("[data-datum-summary] [role=alert]"));
  });

  it("shows Submitting… for the delay, then the receipt with a reference made from the pattern", async () => {
    const element = await mount();
    element.controller.setTrySubmission({ delayMs: 60, statusText: "Sending now", statusPlacement: ["bottom"], receipt: { referencePattern: "REF-{n}", placement: ["top", "bottom"] } });
    const seen = submits(element);
    const { panel } = await trying(element);
    await typeName(element, "Ada");
    await pressSubmit(element);
    await until(() => renderer(element).submitting);
    expect(renderer(element).submittingPlacement).toEqual(["bottom"]);
    expect(renderer(element).texts).toEqual({ submitting: "Sending now" });
    expect(panel.querySelector("[data-try-submit]")!.textContent).toBe("Submitting…");
    // One at a time: a second press while it runs is ignored.
    await pressSubmit(element);
    await until(() => seen.length === 1);
    expect(renderer(element).submitting).toBe(false);
    const notice = renderer(element).notice!;
    expect(notice.kind).toBe("success");
    expect(notice.title).toBe("Thank you");
    expect(notice.message).toBe("We have your answers.");
    expect(notice.placement).toEqual(["top", "bottom"]);
    expect(notice.details![0]!.label).toBe("Confirmation number");
    expect(notice.details![0]!.value).toMatch(/^REF-\d{6}$/);
    expect(seen[0]).toEqual({ outcome: "accepted", answers: { fullName: "Ada" }, reference: notice.details![0]!.value });
    await until(() => renderer(element).shadowRoot.querySelector("[role=status][tabindex='-1']"));
    expect(panel.querySelector("[data-try-submit]")!.textContent).toContain(`Accepted · ${notice.details![0]!.value}`);
    expect(panel.querySelector("[data-try-submit] time")).not.toBeNull();
    // Editable after, by default.
    expect(renderer(element).mode).toBe("interactive");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toHaveLength(1);
  });

  it("shows the answers read only after an accepted submit when set, and Fill in clears the receipt", async () => {
    const element = await mount();
    element.controller.setTrySubmission({ delayMs: 0, afterAccept: "readonly" });
    const { panel } = await trying(element);
    await typeName(element, "Ada");
    await pressSubmit(element);
    await until(() => renderer(element).notice);
    expect(renderer(element).mode).toBe("readonly");
    expect(panel.querySelector('[data-try-mode="readonly"]')!.getAttribute("aria-checked")).toBe("true");
    panel.querySelector<HTMLButtonElement>('[data-try-mode="interactive"]')!.click();
    expect(renderer(element).mode).toBe("interactive");
    expect(renderer(element).notice).toBeUndefined();
  });

  it("puts a refusal and a failure on the form as the form's own error", async () => {
    const element = await mount();
    element.controller.setTrySubmission({ delayMs: 0, outcome: "refuse", refusalMessage: "Not today." });
    const seen = submits(element);
    const { panel } = await trying(element);
    await typeName(element, "Ada");
    await pressSubmit(element);
    await until(() => seen.length === 1);
    expect(seen[0]!.outcome).toBe("refused");
    expect(renderer(element).notice).toBeUndefined();
    const preview = (canvasEl(element) as unknown as { previewRuntime(): { errors(): Array<{ componentId?: string; message?: string; source: string }> } }).previewRuntime();
    expect(preview.errors()).toEqual([expect.objectContaining({ message: "Not today.", source: "server" })]);
    expect(preview.errors()[0]!.componentId).toBeUndefined();
    await until(() => renderer(element).shadowRoot.querySelector("[data-datum-summary] [role=alert]")?.textContent?.includes("Not today."));
    expect(panel.querySelector("[data-try-submit]")!.textContent).toContain("Refused");

    element.controller.setTrySubmission({ outcome: "fail" });
    await pressSubmit(element);
    await until(() => seen.length === 2);
    expect(seen[1]!.outcome).toBe("failed");
    expect(preview.errors()).toEqual([expect.objectContaining({ message: "The form could not be sent. Try again.", source: "server" })]);
    expect(panel.querySelector("[data-try-submit]")!.textContent).toContain("Could not be sent");
  });

  it("clears the receipt, the errors and the status line on Back to editing, and drops a submit in flight", async () => {
    const element = await mount();
    element.controller.setTrySubmission({ delayMs: 0 });
    const seen = submits(element);
    await trying(element);
    await pressSubmit(element);
    await until(() => seen.length === 1);
    const preview = (canvasEl(element) as unknown as { previewRuntime(): { errors(): unknown[] } }).previewRuntime();
    expect(preview.errors().length).toBe(1);
    canvasEl(element).previewing = false;
    expect(preview.errors()).toEqual([]);

    await trying(element);
    await typeName(element, "Ada");
    element.controller.setTrySubmission({ delayMs: 5000 });
    await pressSubmit(element);
    await until(() => renderer(element).submitting);
    canvasEl(element).previewing = false;
    expect(renderer(element).submitting).toBe(false);
    expect(renderer(element).notice).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("does nothing on Submit while editing", async () => {
    const element = await mount();
    const seen = submits(element);
    await until(() => renderer(element).shadowRoot.querySelector('[data-button-action="submit"]'));
    renderer(element).dispatchEvent(new CustomEvent("datum-form-action", { detail: { componentId: "submit", action: "submit" }, bubbles: true, composed: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([]);
  });
});

describe("WebAssembly validation in Try it", () => {
  const sandbox = (label = "Test sandbox", calls: Array<Record<string, unknown>> = []): TryItServerChecks => ({
    label,
    run: async ({ answers }) => {
      calls.push(answers);
      return { errors: [{ code: "required", componentId: "fullName", stage: "kernel", source: "wasm" }] };
    }
  });
  const toggle = (panel: HTMLElement): HTMLInputElement => panel.querySelector<HTMLInputElement>("[data-try-server]")!;
  const status = (panel: HTMLElement): string => panel.querySelector("[data-try-wasm-status]")!.textContent!;

  it("says so, its toggle disabled, when the page provides none", async () => {
    const { panel } = await trying();
    expect(panel.querySelector("[data-try-wasm]")!.textContent).toContain("WebAssembly validation");
    expect(toggle(panel).closest("label")!.textContent).toContain("Run the WebAssembly validator (the server's checks)");
    expect(toggle(panel).disabled).toBe(true);
    expect(toggle(panel).checked).toBe(false);
    expect(status(panel)).toBe("Not available: the page provides no WebAssembly validator.");
  });

  it("loads a lent loader the first time it is turned on, once, and runs it", async () => {
    const element = await mount();
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: Array<Record<string, unknown>> = [];
    element.serverChecks = async () => {
      loads += 1;
      await gate;
      return sandbox("Kernel", calls);
    };
    const { panel } = await trying(element);
    expect(loads).toBe(0);
    expect(toggle(panel).disabled).toBe(false);
    toggle(panel).click();
    await until(() => status(panel) === "Loading the WebAssembly validator…");
    expect(toggle(panel).disabled).toBe(true);
    release();
    await until(() => status(panel) === "Ready: Kernel." && [...panel.querySelectorAll(".try-subtitle")].some((title) => title.textContent === "On the server") && !panel.textContent!.includes("Checking…"));
    expect(toggle(panel).checked).toBe(true);
    expect(calls).toEqual([{}]);
    // Off and on again: no second load.
    toggle(panel).click();
    toggle(panel).click();
    await until(() => calls.length === 2);
    expect(loads).toBe(1);

    // Submit runs it too: its problems go on the form.
    await typeName(element, "Ada");
    const seen = submits(element);
    await pressSubmit(element);
    await until(() => seen.length === 1);
    expect(seen[0]!.outcome).toBe("invalid");
    expect(calls.at(-1)).toEqual({ fullName: "Ada" });
  });

  it("says why a loader failed, the toggle off, and loads again on Try again", async () => {
    const element = await mount();
    let fail = true;
    element.serverChecks = async () => {
      if (fail) {
        throw new Error("datum-wasm.js was not found beside the builder");
      }
      return sandbox("Kernel");
    };
    const { panel } = await trying(element);
    toggle(panel).click();
    await until(() => status(panel).startsWith("Not available:"));
    expect(status(panel)).toBe("Not available: datum-wasm.js was not found beside the builder");
    expect(toggle(panel).checked).toBe(false);
    const retry = panel.querySelector<HTMLButtonElement>("[data-try-wasm-retry]")!;
    expect(retry.textContent).toBe("Try again");
    fail = false;
    retry.click();
    await until(() => status(panel) === "Ready: Kernel.");
    expect(toggle(panel).checked).toBe(true);
    expect(panel.querySelector("[data-try-wasm-retry]")).toBeNull();
  });

  it("takes a host's checks in hand as before", async () => {
    const element = await mount();
    const calls: Array<Record<string, unknown>> = [];
    element.serverChecks = sandbox("Test sandbox", calls);
    const { panel } = await trying(element);
    expect(status(panel)).toBe("Ready: Test sandbox.");
    toggle(panel).click();
    await until(() => [...panel.querySelectorAll(".try-subtitle")].some((title) => title.textContent === "On the server") && !panel.textContent!.includes("Checking…"));
    expect(calls).toEqual([{}]);
    expect([...panel.querySelectorAll<HTMLElement>(".try-problem")].map((entry) => entry.dataset.tryGoto)).toContain("fullName");
  });
});

/** A designer's tree for the fake mode: what Try it puts away while it tries the form. */
function layoutRoot(): ComponentNode {
  return {
    id: "layout",
    type: "form",
    configuration: { title: "Layout" },
    children: {
      content: [
        { id: "note", type: "text", configuration: { label: "Note", required: true } },
        { id: "card", type: "note-card", configuration: {} }
      ]
    }
  };
}

/** A type only the designer's tree has: the form drawn without the designer's adapters would warn about it. */
const NOTE_CARD: ComponentDefinition = {
  type: "note-card",
  version: "1.0.0",
  createDefault: () => ({ id: "card", type: "note-card", configuration: {} }),
  capabilities: []
};

/** The designer's face for it: an adapter the mode lays over its binding (`canvasComponents`). */
const NOTE_CARD_FACE = {
  kind: "field",
  name: "note card",
  template: (state: { model: { node: { id: string } } }) => lit.html`<p data-note-card>${state.model.node.id}</p>`
} as unknown as AdapterEntry;

/** The designer's own binding, unlike the form's. */
const MODE_BINDING: LiveBinding = { id: "mode-binding", label: "Mode binding", components: {} };

interface FakeTryMode {
  mode: BuilderMode;
  controller: BuilderController;
  surface: HTMLElement;
  /** The answers each session was seeded with. */
  seeds: Array<Record<string, unknown>>;
  sessions: Array<BuilderTrySession & { disposed: boolean; restarts: number; runtime: BuilderPreviewRuntime }>;
  actions: string[];
  previews: unknown[];
  /** The context each Preview PDF was handed. */
  contexts: Array<{ workspace: string }>;
  /** What the next session's Submit finds. */
  problems: Array<{ componentId?: string; label: string; message: string }>;
  /** The errors the next session's Submit puts on its form, as a journey's validate does. */
  marks: FormError[];
}

interface FakeOptions {
  /** The mode's id: "pdf" puts it on the PDF workspace; another is a host's own mode in the Form workspace. */
  id?: string;
  /** "none": no session (the shared preview is tried); "throws": one that will not start. */
  session?: "yes" | "none" | "throws";
  /** Held open until the test lets it finish. */
  activate?: Promise<void>;
  /** The surface zooms itself (a template's page viewer): every factor it is handed. */
  surfaceZoom?: Array<number | "fit">;
}

/**
 * A mode on the PDF workspace (its id is the PDF designer's) with a tree of its own, a tryable
 * surface, and every part of the Try it seam: a session over a runtime of its own,
 * a PDF, a card with an action.
 */
function fakeTryMode(options: FakeOptions = {}): FakeTryMode {
  const controller = new BuilderController();
  controller.setOptions({
    initialRoot: layoutRoot(),
    componentTypes: [{ type: "text", label: "Note" }, { type: "note-card", label: "Note card" }],
    componentDefinitions: [NOTE_CARD],
    binding: MODE_BINDING,
    canvasComponents: { "note-card": NOTE_CARD_FACE }
  });
  const surface = document.createElement("div");
  surface.setAttribute("data-fake-surface", "");
  const fake: FakeTryMode = { mode: undefined as unknown as BuilderMode, controller, surface, seeds: [], sessions: [], actions: [], previews: [], contexts: [], problems: [], marks: [] };
  const session = options.session ?? "yes";
  fake.mode = {
    id: options.id ?? "pdf",
    label: "PDF",
    controller,
    activate: async (context: BuilderModeContext) => {
      await options.activate;
      const zooms = options.surfaceZoom;
      context.showCanvasSurface(surface, zooms ? { tryable: true, zoomable: true, zoom: (to) => void zooms.push(to) } : { tryable: true });
    },
    tryIt: {
      ...(session === "none" ? {} : { session: (answers: Record<string, unknown>) => {
        if (session === "throws") {
          throw new Error("no session today");
        }
        fake.seeds.push(answers);
        const runtime = new BuilderPreviewRuntime(formRoot());
        for (const [key, value] of Object.entries(answers)) {
          runtime.setValue(key, value);
        }
        const made = {
          runtime,
          disposed: false,
          restarts: 0,
          answers: () => Object.fromEntries(Object.entries(runtime.state().values).filter(([, value]) => value !== undefined)),
          submit: async () => {
            if (fake.marks.length > 0) {
              runtime.setErrors(fake.marks);
            }
            return { problems: fake.problems };
          },
          refresh: () => undefined,
          restart: () => {
            made.restarts += 1;
            runtime.clearValues();
          },
          dispose: () => {
            made.disposed = true;
          }
        };
        fake.sessions.push(made);
        return made;
      } }),
      pdf: {
        label: () => "Letter · A4",
        preview: async (runtime, context) => {
          fake.previews.push(runtime);
          fake.contexts.push(context);
        }
      },
      cards: (view) => `<section class="try-card" data-fake-card><p>${view.answered ?? 0} tried</p><button type="button" class="btn" data-try-mode-action="restart">Restart</button></section>`,
      onTryClick: (action) => {
        fake.actions.push(action);
      }
    }
  };
  return fake;
}

const wrapOf = (element: DatumBuilderElement): HTMLElement => element.shadowRoot!.querySelector<HTMLElement>("[data-shell=wrap]")!;
// The bar's "‹ Journeys" / "‹ Layouts": hidden by the wrap's stylesheet, not by script, while Try it is on.
const backOf = (element: DatumBuilderElement): HTMLElement => element.shadowRoot!.querySelector<HTMLElement>("[data-overview-back]")!;
const shared = (element: DatumBuilderElement) => (canvasEl(element) as unknown as { previewRuntime(): BuilderPreviewRuntime }).previewRuntime();
const drawn = (element: DatumBuilderElement, id: string): boolean => renderer(element).shadowRoot.querySelector(`[data-component-id="${id}"]`) !== null;

/** The builder on the fake mode's document, with Ada typed into the form beforehand. */
async function onFakeMode(options: FakeOptions = {}): Promise<{ element: DatumBuilderElement; fake: FakeTryMode }> {
  const element = await mount();
  shared(element).setValue("fullName", "Ada");
  const fake = fakeTryMode(options);
  element.addMode(fake.mode);
  element.setMode(fake.mode.id);
  await until(() => element.mode === fake.mode.id && drawn(element, "note"));
  return { element, fake };
}

async function tryOnFakeMode(element: DatumBuilderElement): Promise<HTMLElement> {
  canvas(element).querySelector<HTMLElement>("[data-try-it]")!.click();
  const panel = canvas(element).querySelector<HTMLElement>("[data-try-panel]")!;
  await until(() => !panel.hidden && panel.querySelector("[data-try-pdf-card]") && drawn(element, "fullName"));
  return panel;
}

/** Types into the drawn form's Full name box, whichever runtime is behind it. */
function typeInto(element: DatumBuilderElement, value: string): void {
  const input = renderer(element).shadowRoot.querySelector<HTMLInputElement>('[data-component-id="fullName"] input')!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

const rendererOf = (element: DatumBuilderElement) => renderer(element) as unknown as { runtime: unknown; drawnBinding: LiveBinding };

describe("Try it in a mode", () => {
  it("draws the form over the mode's session, the mode's PDF card and cards first, and puts the mode's tree back after", async () => {
    const warn = vi.spyOn(console, "warn");
    const { element, fake } = await onFakeMode();
    const page = canvas(element).querySelector<HTMLElement>(".canvas-page")!;
    expect(page.hasAttribute("data-surface")).toBe(true);
    // The designer's tree with its own binding and faces.
    await until(() => renderer(element).shadowRoot.querySelector("[data-note-card]"));
    expect(rendererOf(element).drawnBinding.id).toBe("mode-binding");
    expect(rendererOf(element).drawnBinding.components["note-card"]).toBe(NOTE_CARD_FACE);
    expect(backOf(element).hidden).toBe(false);

    const panel = await tryOnFakeMode(element);
    expect(wrapOf(element).hasAttribute("data-trying")).toBe(true);
    // The form's tree, by the session's runtime seeded from the one set of answers.
    expect(drawn(element, "note")).toBe(false);
    expect(fake.seeds).toEqual([{ fullName: "Ada" }]);
    const session = fake.sessions[0]!;
    expect(rendererOf(element).runtime).toBe(session.runtime);
    // The form's binding came with it, and not the designer's faces.
    expect(rendererOf(element).drawnBinding.id).toBe("datum");
    expect(rendererOf(element).drawnBinding.id).not.toBe("mode-binding");
    expect(rendererOf(element).drawnBinding.components["note-card"]).toBeUndefined();
    // The surface and the way back to the overview are put away meanwhile (the bar's button by the wrap's stylesheet).
    expect(page.hasAttribute("data-surface")).toBe(false);
    expect(canvas(element).querySelector<HTMLElement>("[data-canvas-surface]")!.hidden).toBe(true);
    expect(wrapOf(element).hasAttribute("data-trying")).toBe(true);

    // The PDF card first, then the mode's, then the standard ones.
    const cards = [...panel.querySelectorAll<HTMLElement>(".try-card")];
    expect(cards[0]!.hasAttribute("data-try-pdf-card")).toBe(true);
    expect(cards[1]!.hasAttribute("data-fake-card")).toBe(true);
    expect(cards[2]!.querySelector("#try-show-title")).not.toBeNull();
    expect(panel.querySelector("[data-try-pdf-label]")!.textContent).toBe("Letter · A4");
    expect(panel.querySelector("[data-try-answered]")!.textContent).toBe("1 typed answer");
    // Preview PDF and Clear answers are the PDF card's; Show the form keeps Print.
    expect(cards[2]!.querySelector("[data-try-pdf], [data-try-clear]")).toBeNull();
    expect(cards[0]!.querySelector("[data-try-pdf]")!.classList.contains("primary")).toBe(true);

    panel.querySelector<HTMLElement>('[data-try-mode-action="restart"]')!.click();
    expect(fake.actions).toEqual(["restart"]);
    panel.querySelector<HTMLElement>("[data-try-pdf]")!.click();
    await until(() => fake.previews.length === 1);
    expect(fake.previews[0]).toBe(session.runtime);
    expect(fake.contexts[0]).toEqual({ workspace: "pdf", root: element.shadowRoot });

    // Typing goes to the session's runtime, and the panel follows it; Back to editing keeps it.
    expect(panel.querySelector("[data-try-data]")!.textContent).toContain('"Ada"');
    typeInto(element, "Grace");
    await until(() => session.runtime.state().values.fullName === "Grace");
    await until(() => panel.querySelector("[data-try-data]")!.textContent!.includes('"Grace"'));
    expect(panel.querySelector("[data-try-answered]")!.textContent).toBe("1 typed answer");
    expect(shared(element).state().values.fullName).toBe("Ada");

    canvasEl(element).previewing = false;
    await until(() => drawn(element, "note"));
    expect(wrapOf(element).hasAttribute("data-trying")).toBe(false);
    expect(drawn(element, "fullName")).toBe(false);
    expect(rendererOf(element).runtime).toBe(shared(element));
    expect(rendererOf(element).drawnBinding.id).toBe("mode-binding");
    await until(() => renderer(element).shadowRoot.querySelector("[data-note-card]"));
    expect(warn.mock.calls.some((call) => String(call[0]).includes("Unknown component type"))).toBe(false);
    warn.mockRestore();
    // Back to editing takes the tried answers with it: the edit canvas is the form's own again.
    await until(() => shared(element).state().values.fullName === undefined);
    expect(element.triedAnswers()).toEqual({});
    expect(session.disposed).toBe(true);
    expect(page.hasAttribute("data-surface")).toBe(true);
    expect(canvas(element).querySelector<HTMLElement>("[data-canvas-surface]")!.hidden).toBe(false);
    expect(backOf(element).hidden).toBe(false);
  });

  it("submits through the session, its problems counted in Last submit", async () => {
    const { element, fake } = await onFakeMode();
    const seen = submits(element);
    const panel = await tryOnFakeMode(element);
    fake.problems = [{ componentId: "fullName", label: "Full name", message: "Say more." }];
    await pressSubmit(element);
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ outcome: "invalid", answers: { fullName: "Ada" } });
    expect(panel.querySelector("[data-try-submit]")!.textContent).toContain("1 problem");
  });

  it("keeps the marks the session's Submit made beside the server's, each said once", async () => {
    const { element, fake } = await onFakeMode();
    element.serverChecks = {
      label: "Test sandbox",
      run: async () => ({
        errors: [
          { code: "required", componentId: "fullName", stage: "kernel", source: "wasm" },
          { code: "pattern", componentId: "fullName", stage: "kernel", source: "wasm" }
        ]
      })
    };
    const seen = submits(element);
    const panel = await tryOnFakeMode(element);
    panel.querySelector<HTMLInputElement>("[data-try-server]")!.click();
    await until(() => !panel.textContent!.includes("Checking…") && panel.querySelector<HTMLInputElement>("[data-try-server]")!.checked);
    fake.problems = [{ componentId: "fullName", label: "Full name", message: "Required." }];
    fake.marks = [{ id: "journey_0", code: "required", componentId: "fullName", message: "Required.", stage: "client", source: "client" } as FormError];
    await pressSubmit(element);
    await until(() => seen.length === 1);
    const errors = fake.sessions[0]!.runtime.errors().map((error) => `${error.componentId}|${error.code}`);
    expect(errors).toEqual(["fullName|required", "fullName|pattern"]);
    expect(fake.sessions[0]!.runtime.errors()[0]!.id).toBe("journey_0");
  });

  it("clears the answers from the PDF card: the shared store emptied, the session started over", async () => {
    const { element, fake } = await onFakeMode();
    const panel = await tryOnFakeMode(element);
    panel.querySelector<HTMLElement>("[data-try-pdf-card] [data-try-clear]")!.click();
    expect(shared(element).state().values).toEqual({});
    expect(fake.sessions[0]!.restarts).toBe(1);
    expect(panel.querySelector("[data-try-answered]")!.textContent).toBe("No typed answers yet");
    expect(panel.querySelector("[data-try-data]")!.textContent).toBe("{}");
  });

  it("clears the answers from Show the form on the form's own canvas", async () => {
    const element = await mount();
    const { panel } = await trying(element);
    await typeName(element, "Ada");
    panel.querySelector<HTMLElement>("[data-try-clear]")!.click();
    expect(shared(element).state().values).toEqual({});
    expect(panel.querySelector("[data-try-data]")!.textContent).toBe("{}");
    await until(() => renderer(element).shadowRoot.querySelector<HTMLInputElement>('[data-component-id="fullName"] input')?.value === "");
  });

  it("offers Try it in the palette on a designer's document, through the unsaved-edits guard", async () => {
    const { element, fake } = await onFakeMode();
    fake.controller.select("note");
    fake.controller.setDraftProperty("note", "label", "Edited");
    await element.openPalette();
    const palette = element.shadowRoot!.querySelector("datum-builder-palette")!.shadowRoot!;
    const input = palette.querySelector<HTMLInputElement>("[data-palette-input]")!;
    input.value = "Try it";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    const labels = [...palette.querySelectorAll<HTMLElement>("[data-palette-option] .palette-label")].map((label) => label.textContent);
    expect(labels[0]).toBe("Try it: preview the form");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true }));
    // Held: the draft is asked about first.
    expect(fake.controller.unsavedChangesPrompt()?.action).toBe("leave");
    expect(canvasEl(element).previewing).toBe(false);
    fake.controller.answerUnsavedChangesPrompt("discard");
    expect(canvasEl(element).previewing).toBe(true);
    await until(() => drawn(element, "fullName"));
  });

  it("previews the PDF through the PDF mode from the Form workspace too, handing the canvas's renderer no catalog", async () => {
    const element = await mount();
    const fake = fakeTryMode();
    fake.mode.definitionPdf = () => ({ layouts: [] });
    element.addMode(fake.mode);
    // The PDF mode prints: the canvas's renderer is handed no layouts it could not resolve.
    expect(shared(element).pdfConfiguration()).toBeUndefined();
    const { panel } = await trying(element);
    expect(panel.querySelector("[data-try-pdf-card]")).toBeNull();
    panel.querySelector<HTMLElement>("[data-try-pdf]")!.click();
    await until(() => fake.previews.length === 1);
    expect(fake.previews[0]).toBe(shared(element));
    expect(fake.contexts[0]).toEqual({ workspace: "form", root: element.shadowRoot });
    expect(element.triedAnswers()).toEqual({});
  });

  it("prints the layout the answers choose through the fallback, from a host mode's catalog, on a page with no PDF mode", async () => {
    const layout = (id: string, when?: unknown): PdfGeneratedLayout =>
      ({
        id,
        kind: "generated",
        name: id,
        root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: `${id}-field`, type: "pdf-field", configuration: { componentId: "fullName" } }], header: [], footer: [] } },
        ...(when ? { when } : {})
      }) as PdfGeneratedLayout;
    const element = await mount();
    const host = fakeTryMode({ id: "notes", session: "none" });
    delete host.mode.tryIt!.pdf;
    host.mode.definitionPdf = () => ({
      layouts: [layout("ada", 'fullName = "Ada"'), layout("plain")],
      defaultLayoutId: "plain"
    });
    element.addMode(host.mode);
    const provider = {
      id: "fake",
      abiVersion: "1.0.0",
      render: async () => ({ bytes: new TextEncoder().encode("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" })
    } as unknown as PdfRenderProvider;
    element.tryPdf = { provider };
    const names: string[] = [];
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:try", configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true, writable: true });
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    try {
      const { panel } = await trying(element);
      const preview = async (count: number): Promise<void> => {
        panel.querySelector<HTMLElement>("[data-try-pdf]")!.click();
        await until(() => names.length === count && !panel.querySelector("[data-try-pdf][aria-busy]"));
      };
      // Like every other builder preview, Try it's PDF pins formulaErrors "warn".
      const printed = vi.spyOn(renderer(element) as unknown as { renderPdf(options?: unknown): Promise<unknown> }, "renderPdf");
      await preview(1);
      expect(printed).toHaveBeenCalledWith(expect.objectContaining({ formulaErrors: "warn" }));
      expect(names[0]).toContain("-plain-");
      await typeName(element, "Ada");
      await preview(2);
      expect(names[1]).toContain("-ada-");
      expect(panel.querySelector("[data-try-panel] .try-error, .try-error")).toBeNull();
    } finally {
      opened.mockRestore();
      clicked.mockRestore();
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
    }
  });

  it("tries a host's own mode in the Form workspace on its own tree, as before", async () => {
    const { element, fake } = await onFakeMode({ id: "notes" });
    canvas(element).querySelector<HTMLElement>("[data-try-it]")!.click();
    expect(canvasEl(element).previewing).toBe(true);
    expect(wrapOf(element).hasAttribute("data-trying")).toBe(true);
    await until(() => renderer(element).hasAttribute("data-previewing"));
    expect(drawn(element, "note")).toBe(true);
    expect(drawn(element, "fullName")).toBe(false);
    expect(fake.sessions).toHaveLength(0);
    expect(rendererOf(element).runtime).toBe(shared(element));
  });

  it("follows the canvas's own locale while the form is tried over a designer", async () => {
    const { element, fake } = await onFakeMode({ session: "none" });
    await tryOnFakeMode(element);
    expect(rendererOf(element).runtime).toBe(shared(element));
    fake.controller.setOptions({ locale: "fr" });
    await until(() => shared(element).state().locale === "fr");
    expect((rendererOf(element).runtime as BuilderPreviewRuntime).state().locale).toBe("fr");
  });

  it("keeps an answer cleared in the session cleared, and runs no live check on the designer's tree after", async () => {
    const { element, fake } = await onFakeMode();
    const panel = await tryOnFakeMode(element);
    const session = fake.sessions[0]!;
    // Checks as answers change: on, and one queued by a change just before Back to editing.
    panel.querySelector<HTMLInputElement>("[data-try-live]")!.click();
    await until(() => panel.querySelector("[data-try-results]")!.textContent!.includes("No problems."));
    session.runtime.setValue("fullName", undefined);
    canvasEl(element).previewing = false;
    await until(() => drawn(element, "note"));
    expect("fullName" in shared(element).state().values && shared(element).state().values.fullName !== undefined).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Back in Try it: the results are the form's, never the designer's required Note.
    await tryOnFakeMode(element);
    expect(panel.querySelector("[data-try-results]")!.textContent).not.toContain("Note");
  });

  it("hands a drawn empty grid row back with the rows around it, so the grid reopens as the person saw it", async () => {
    const { element, fake } = await onFakeMode();
    await tryOnFakeMode(element);
    const session = fake.sessions[0]!;
    // Back to editing empties the canvas's tried answers afterwards, so what the
    // session handed over is read at the hand-over itself.
    const handed: Array<Record<string, unknown>> = [];
    const replace = shared(element).replaceValues.bind(shared(element));
    shared(element).replaceValues = (values, dirty) => {
      handed.push(values);
      replace(values, dirty);
    };
    // A grid's rows live as flat keys: row 0 answered, row 1 drawn and left empty (its key holds undefined).
    session.runtime.setValue("items[0].sku", "A1");
    session.runtime.setValue("items[1].sku", undefined);
    canvasEl(element).previewing = false;
    await until(() => handed.length > 0);
    expect(handed[0]!["items[0].sku"]).toBe("A1");
    // The trailing empty row is still there: its key is, not only the answered rows'.
    expect(Object.keys(handed[0]!)).toContain("items[1].sku");
    expect(handed[0]!["items[1].sku"]).toBeUndefined();
  });

  it("tries the shared preview when the mode's session will not start, saying so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { element, fake } = await onFakeMode({ session: "throws" });
      await tryOnFakeMode(element);
      expect(rendererOf(element).runtime).toBe(shared(element));
      // Repaints (the designer's controller changing under Try it) do not try again.
      fake.controller.select("note");
      fake.controller.select("card");
      expect(warn.mock.calls.filter((call) => String(call[0]).includes("Try it did not start"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("ends Try it when the workspace changes and when the tried mode is removed", async () => {
    const { element, fake } = await onFakeMode();
    await tryOnFakeMode(element);
    element.setWorkspace("form");
    await until(() => element.mode === "form");
    expect(canvasEl(element).previewing).toBe(false);
    expect(wrapOf(element).hasAttribute("data-trying")).toBe(false);
    expect(fake.sessions[0]!.disposed).toBe(true);

    element.setMode("pdf");
    await until(() => element.mode === "pdf" && drawn(element, "note"));
    await tryOnFakeMode(element);
    element.removeMode("pdf");
    expect(canvasEl(element).previewing).toBe(false);
    expect(wrapOf(element).hasAttribute("data-trying")).toBe(false);
    expect(fake.sessions[1]!.disposed).toBe(true);
  });

  it("ends a Try it pressed while the designer was still activating", async () => {
    let finish!: () => void;
    const element = await mount();
    const fake = fakeTryMode({ activate: new Promise<void>((resolve) => (finish = resolve)) });
    element.addMode(fake.mode);
    element.setMode("pdf");
    // The form is still on the page: Try it starts there.
    canvasEl(element).previewing = true;
    expect(wrapOf(element).hasAttribute("data-trying")).toBe(true);
    finish();
    await until(() => element.mode === "pdf" && drawn(element, "note"));
    expect(canvasEl(element).previewing).toBe(false);
    expect(wrapOf(element).hasAttribute("data-trying")).toBe(false);
    expect(fake.sessions).toHaveLength(0);
  });

  it("ends Try it on a mode switch, either way, so data-trying never carries across", async () => {
    const { element, fake } = await onFakeMode();
    await tryOnFakeMode(element);
    element.setMode("form");
    await until(() => element.mode === "form");
    expect(canvasEl(element).previewing).toBe(false);
    expect(wrapOf(element).hasAttribute("data-trying")).toBe(false);
    expect(fake.sessions[0]!.disposed).toBe(true);
    await until(() => drawn(element, "fullName"));
    expect((renderer(element) as unknown as { runtime: unknown }).runtime).toBe(shared(element));

    // From the form's own Try it into the designer.
    await trying(element);
    expect(wrapOf(element).hasAttribute("data-trying")).toBe(true);
    element.setMode("pdf");
    await until(() => element.mode === "pdf" && drawn(element, "note"));
    expect(canvasEl(element).previewing).toBe(false);
    expect(wrapOf(element).hasAttribute("data-trying")).toBe(false);
  });

  it("keeps Cmd+Z in a field of the tried form the field's own; elsewhere on the canvas it undoes the designer", async () => {
    const { element, fake } = await onFakeMode();
    const label = (): unknown => (fake.controller.snapshot().children!.content![0]!.configuration as Record<string, unknown>).label;
    fake.controller.setProperty("note", "label", "Edited");
    expect(label()).toBe("Edited");
    const panel = await tryOnFakeMode(element);
    const undoKey = (target: EventTarget, key = "z"): void => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, composed: true, cancelable: true }));
    };
    const box = renderer(element).shadowRoot.querySelector<HTMLInputElement>('[data-component-id="fullName"] input')!;
    undoKey(box);
    undoKey(box, "y");
    expect(label()).toBe("Edited");
    undoKey(panel.querySelector<HTMLElement>("[data-try-check]")!);
    expect(label()).toBe("Note");
  });

  it("keeps a language switch in the form tried over a designer to that form", async () => {
    const { element, fake } = await onFakeMode();
    await tryOnFakeMode(element);
    const heard: string[] = [];
    const listen = (event: Event): void => void heard.push(event.type);
    element.addEventListener("datum-locale-applied", listen);
    try {
      renderer(element).dispatchEvent(new CustomEvent("datum-locale-applied", { detail: { locale: "fr-CA" }, bubbles: true, composed: true }));
      expect(heard).toEqual([]);
      expect(element.controller.currentLocale()).toBe("en");
      expect(fake.controller.currentLocale()).toBe("en");
    } finally {
      element.removeEventListener("datum-locale-applied", listen);
    }
  });

  it("opens no link of the tried form, a new tab's included, on the form's canvas and over a designer", async () => {
    const clickLinks = (element: DatumBuilderElement): boolean[] =>
      ["_self", "_blank"].map((target) => {
        const link = document.createElement("a");
        link.href = "https://example.com/";
        link.target = target;
        link.textContent = "Elsewhere";
        renderer(element).shadowRoot.append(link);
        const click = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
        link.dispatchEvent(click);
        link.remove();
        return click.defaultPrevented;
      });
    const element = await mount();
    await trying(element);
    expect(clickLinks(element)).toEqual([true, true]);
    document.body.innerHTML = "";
    const { element: designer } = await onFakeMode();
    await tryOnFakeMode(designer);
    expect(clickLinks(designer)).toEqual([true, true]);
  });

  it("gives the host the typed answers only, and clears them as Clear answers does", async () => {
    const { element, fake } = await onFakeMode();
    // A value the rules worked out is nobody's answer: only the typed one is handed on.
    shared(element).replaceValues({ fullName: "Ada", worked: "out" }, ["fullName"]);
    expect(element.triedAnswers()).toEqual({ fullName: "Ada" });
    await tryOnFakeMode(element);
    element.clearTriedAnswers();
    expect(element.triedAnswers()).toEqual({});
    expect(fake.sessions[0]!.restarts).toBe(1);
  });

  it("gives a self-zooming page viewer its zoom back after Try it, the form drawn at the sheet's own largest meanwhile", async () => {
    const zooms: Array<number | "fit"> = [];
    const { element } = await onFakeMode({ surfaceZoom: zooms });
    const canvasZoom = canvasEl(element) as unknown as { zoom: number; zoomTo(value: number): void };
    canvasZoom.zoomTo(4);
    expect(canvasZoom.zoom).toBe(4);
    expect(zooms.at(-1)).toBe(4);
    await tryOnFakeMode(element);
    expect(canvasZoom.zoom).toBe(2);
    canvasEl(element).previewing = false;
    await until(() => drawn(element, "note"));
    expect(canvasZoom.zoom).toBe(4);
    expect(zooms.at(-1)).toBe(4);
    expect(canvas(element).querySelector("[data-canvas-zoom-level]")!.textContent).toBe("400%");
  });
});
