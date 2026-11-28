import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import { DatumBuilderElement, type ComponentNode, type DatumFormBuilderElement } from "../src/builder.js";
import { BuilderController, BuilderPreviewRuntime, type BuilderMode, type BuilderTrySession, type FormDefinition } from "@argusvane/datum-engine";

import { modesReady, sampleDefinition, until } from "./helpers.js";
import { inSummary } from "./live-dom.js";

/*
 * Try it's chunk: the panel's cards and the logic behind them load on the first Try it,
 * a failed load is said in the panel with Try again and asked for again, never remembered. The
 * behaviour of the loaded panel is builder-try-submit.test.ts's and builder-studio-bar.test.ts's.
 */

/** The chunk, as the canvas imports it: mocked by the first case alone. */
const TRY_MODULE = "../../../engine/form-engine/builder/web-component/try-it.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Sample" },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
  };
}

/**
 * The canvas's way in for an agent's Try it: `@internal` members, typed here
 * as these cases read them.
 */
interface CanvasAgentSeams {
  triedRuntime(): unknown;
  tryReady(): Promise<void>;
  tryPageIdOf(nodeId: string): string | undefined;
  tryNodeIdOf(pageId: string): string | undefined;
  focusedTriedPath(): string | undefined;
  tryChunkState(): "ready" | "loading" | "failed" | "off";
  agentTryCheck(): Promise<{ problems: Array<{ componentId?: string; label: string; message: string }>; server: string }>;
  agentTrySubmit(): Promise<{ outcome: string; answers: Record<string, unknown> } | { state: "busy" }>;
  onTrySubmit(listener: (outcome: { outcome: string }) => void): () => void;
  quietTriedPageFocus(): () => void;
  tryRecording(): boolean;
  tryShowing(): boolean;
  tryServerChecks(): "off" | "on";
}

type Canvas = HTMLElement &
  CanvasAgentSeams & {
    previewing: boolean;
    controller: unknown;
    canvasFeatures: { tryIt?: boolean; logic?: boolean };
    previewRuntime(): { errors(): unknown[] };
    /** Record and Show me, the Tests panel's own ways in, as these cases call them. */
    recordTry(listener: (event: unknown) => void): () => void;
    showScenario(
      showing:
        | { name: string; step: number; steps: number; line: number; values: Record<string, unknown>; onStep(delta: -1 | 1): void; onStop(): void }
        | undefined
    ): void;
  };

async function mount(): Promise<{ element: DatumBuilderElement; canvas: Canvas; root: ShadowRoot }> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot() };
  document.body.append(element);
  const canvas = (): Canvas | null => element.shadowRoot?.querySelector("datum-builder-canvas") as Canvas | null;
  await until(() => canvas()?.shadowRoot?.querySelector(".canvas-page"));
  return { element, canvas: canvas()!, root: canvas()!.shadowRoot! };
}

/** An import held until `release()`: the real chunk, handed over when the test says. */
function heldChunk(): { release(): void; mock(): void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return {
    release: open,
    mock: () => vi.doMock(TRY_MODULE, async () => {
      await gate;
      return vi.importActual(TRY_MODULE);
    })
  };
}

describe("Try it's chunk", () => {
  // First in the file on purpose, before anything loads the chunk: a load held open and then
  // refused is what the canvas reports on (an agent reads it), and the
  // refusal is forgotten, so the chunk is still to load for the case after.
  it("reports where the chunk stands: off with the feature off, loading while a load is out, failed after a refused one", async () => {
    const { canvas } = await mount();
    const state = (): string => canvas.tryChunkState();
    // Nothing asked for yet: the first Try it (or an agent's check) loads it.
    expect(state()).toBe("ready");
    canvas.canvasFeatures = { tryIt: false };
    expect(state()).toBe("off");
    canvas.canvasFeatures = { tryIt: true };
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    vi.doMock(TRY_MODULE, async () => {
      await gate;
      throw new Error("chunk missing");
    });
    try {
      canvas.previewing = true;
      expect(state()).toBe("loading");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state()).toBe("loading");
      // The feature off says off whatever the load is doing.
      canvas.canvasFeatures = { tryIt: false };
      expect(state()).toBe("off");
      canvas.canvasFeatures = { tryIt: true };
      open();
      await until(() => state() === "failed");
      canvas.previewing = false;
    } finally {
      vi.doUnmock(TRY_MODULE);
    }
  });

  // Still before anything loads it: an agent's call with the feature off must not be the first.
  it("asks for no chunk on an agent's check or Submit with the try-it feature off", async () => {
    const { element, canvas } = await mount();
    let asked = 0;
    vi.doMock(TRY_MODULE, () => {
      asked += 1;
      throw new Error("chunk missing");
    });
    const errors: unknown[] = [];
    element.addEventListener("datum-error", (event) => errors.push(event));
    try {
      canvas.canvasFeatures = { tryIt: false };
      canvas.previewing = true;
      await expect(canvas.agentTryCheck()).rejects.toThrow(/off/);
      await expect(canvas.agentTrySubmit()).rejects.toThrow(/off/);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(asked).toBe(0);
      expect(errors).toHaveLength(0);
      expect(canvas.tryChunkState()).toBe("off");
      canvas.previewing = false;
    } finally {
      vi.doUnmock(TRY_MODULE);
    }
  });

  // Before the chunk has loaded: the mock is what the first Try it meets. A failed load is
  // forgotten; the cases below load it (the held ones first, the plain load last, since a chunk
  // once in stays in for the module's life).
  it("says a failed load in the panel with Try again, asks again on each try, and moves focus with the retry", async () => {
    const { canvas, root } = await mount();
    let asked = 0;
    vi.doMock(TRY_MODULE, () => {
      asked += 1;
      throw new Error("chunk missing");
    });
    const panel = root.querySelector<HTMLElement>("[data-try-panel]")!;
    try {
      canvas.previewing = true;
      expect(panel.hidden).toBe(false);
      expect(panel.querySelector("[data-try-load]")?.textContent).toContain("Starting Try it…");
      await until(() => panel.querySelector('[data-try-load="failed"]'));
      expect(panel.textContent).toContain("Try it could not be loaded");
      expect(panel.querySelector(".try-card")).toBeNull();
      // A phone's Results sheet has its close from the first draw, loading and failed alike.
      expect(panel.querySelector("[data-try-close]")).not.toBeNull();
      expect(asked).toBe(1);

      // Try again asks the network again (and fails again while the chunk is missing).
      panel.querySelector<HTMLButtonElement>("[data-try-load-retry]")!.click();
      await until(() => asked === 2 && panel.querySelector('[data-try-load="failed"]'));
    } finally {
      vi.doUnmock(TRY_MODULE);
    }

    // The next Try again is held: focus rests on the note, then goes to the panel's first control.
    const held = heldChunk();
    held.mock();
    try {
      panel.querySelector<HTMLButtonElement>("[data-try-load-retry]")!.click();
      const note = panel.querySelector<HTMLElement>('[data-try-load="loading"]')!;
      expect(note.getAttribute("tabindex")).toBe("-1");
      expect(root.activeElement).toBe(note);
      held.release();
      await until(() => panel.querySelector(".try-card"));
      expect(panel.contains(root.activeElement)).toBe(true);
      expect(root.querySelectorAll("style[data-try-styles]")).toHaveLength(1);
    } finally {
      vi.doUnmock(TRY_MODULE);
    }
  });

  it("draws nothing and injects no style for a chunk that arrives after the author left Try it", async () => {
    const { canvas, root } = await mount();
    const held = heldChunk();
    held.mock();
    try {
      canvas.previewing = true;
      const panel = root.querySelector<HTMLElement>("[data-try-panel]")!;
      expect(panel.querySelector('[data-try-load="loading"]')).not.toBeNull();
      canvas.previewing = false;
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(panel.hidden).toBe(true);
      expect(panel.querySelector(".try-card")).toBeNull();
      expect(root.querySelector("style[data-try-styles]")).toBeNull();
    } finally {
      vi.doUnmock(TRY_MODULE);
    }
    canvas.previewing = true;
    await until(() => root.querySelector("[data-try-panel] .try-card"));
    expect(root.querySelectorAll("style[data-try-styles]")).toHaveLength(1);
  });

  it("drops a Submit queued while the chunk comes when the author has left Try it", async () => {
    const { element, canvas, root } = await mount();
    const seen: unknown[] = [];
    element.addEventListener("builder-try-submit", (event) => seen.push(event));
    const held = heldChunk();
    held.mock();
    try {
      canvas.previewing = true;
      const renderer = root.querySelector("[data-preview]") as HTMLElement & { shadowRoot: ShadowRoot };
      renderer.dispatchEvent(new CustomEvent("datum-form-action", { detail: { action: "submit" }, bubbles: true, composed: true }));
      const before = root.activeElement;
      canvas.previewing = false;
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seen).toHaveLength(0);
      expect(canvas.previewRuntime().errors()).toEqual([]);
      expect(root.activeElement).toBe(before);
    } finally {
      vi.doUnmock(TRY_MODULE);
    }
  });

  it("drops an agent's check or Submit queued while the chunk comes when the author has left Try it", async () => {
    const { element, canvas, root } = await mount();
    element.controller.setTrySubmission({ delayMs: 0, afterAccept: "readonly" });
    const seen: unknown[] = [];
    element.addEventListener("builder-try-submit", (event) => seen.push(event));
    const renderer = root.querySelector("[data-preview]") as HTMLElement & { notice: unknown; submitting: boolean; mode: string };
    const held = heldChunk();
    held.mock();
    try {
      canvas.previewing = true;
      const submitted = canvas.agentTrySubmit();
      const checked = canvas.agentTryCheck();
      // The person sees Try it come on and presses Back to editing before the chunk is in.
      canvas.previewing = false;
      held.release();
      await expect(submitted).rejects.toThrow(/ended before the Submit ran/);
      await expect(checked).rejects.toThrow(/ended before the check ran/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      // Nothing ran against the editing canvas: no Submit heard, no errors, no receipt, not busy.
      expect(seen).toHaveLength(0);
      expect(canvas.previewRuntime().errors()).toEqual([]);
      expect(renderer.notice).toBeUndefined();
      expect(renderer.submitting).toBe(false);
    } finally {
      vi.doUnmock(TRY_MODULE);
    }
    // Nor while Try it is off with the chunk in; and the next Try it opens as the author left it, not read only.
    await expect(canvas.agentTrySubmit()).rejects.toThrow(/not on/);
    expect(seen).toHaveLength(0);
    canvas.previewing = true;
    await until(() => root.querySelector("[data-try-panel] .try-card"));
    expect(renderer.mode).toBe("interactive");
  });

  it("shows a note while the chunk comes, then the cards, and styles them again after the canvas rebuilds", async () => {
    const { element, canvas, root } = await mount();
    canvas.previewing = true;
    const panel = root.querySelector<HTMLElement>("[data-try-panel]")!;
    expect(panel.querySelector('[data-try-load="loading"]')?.textContent).toBe("Starting Try it…");
    await until(() => panel.querySelector(".try-card"));
    expect(panel.querySelector("[data-try-check]")).not.toBeNull();

    canvas.previewing = false;
    expect(panel.hidden).toBe(true);
    canvas.previewing = true;
    await until(() => !panel.hidden && panel.querySelector(".try-card"));
    expect(root.querySelectorAll("style[data-try-styles]")).toHaveLength(1);

    // The canvas rebuilds its shadow root when its controller goes and comes back: the styles come back with the cards.
    canvas.previewing = false;
    const controller = canvas.controller;
    canvas.controller = undefined;
    canvas.controller = controller;
    canvas.previewing = true;
    const again = root.querySelector<HTMLElement>("[data-try-panel]")!;
    await until(() => !again.hidden && again.querySelector(".try-card"));
    expect(root.querySelectorAll("style[data-try-styles]")).toHaveLength(1);
    expect(element.isConnected).toBe(true);
  });
});

/*
 * An agent's way into Try it: the canvas's `@internal` members, each what the
 * person's own control does or reads. After the cases above, so the chunk is in.
 */
describe("the canvas's seams for an agent's Try it", () => {
  /** A form with a box to type in, a box that is no text box, and a Submit. */
  function agentRoot(): ComponentNode {
    return {
      id: "root",
      type: "form",
      configuration: { title: "Contact" },
      children: {
        content: [
          { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
          { id: "consent", type: "checkbox", configuration: { label: "I agree" } },
          { id: "send", type: "button", configuration: { label: "Send", action: "submit" } }
        ]
      }
    };
  }

  async function mountAgent(): Promise<{ element: DatumBuilderElement; canvas: Canvas; root: ShadowRoot }> {
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    element.options = { initialRoot: agentRoot() };
    document.body.append(element);
    const canvas = (): Canvas | null => element.shadowRoot?.querySelector("datum-builder-canvas") as Canvas | null;
    await until(() => canvas()?.shadowRoot?.querySelector(".canvas-page"));
    return { element, canvas: canvas()!, root: canvas()!.shadowRoot! };
  }

  /** The form tried, inside the canvas's renderer. */
  function triedForm(root: ShadowRoot): ShadowRoot {
    return (root.querySelector("[data-preview]") as HTMLElement).shadowRoot!;
  }

  it("says ready once this canvas's load of the chunk is in, loading while it is out", async () => {
    const { canvas, root } = await mountAgent();
    canvas.previewing = true;
    // The chunk is in for the page already; this canvas's controller is made a beat later.
    expect(canvas.tryChunkState()).toBe("loading");
    await until(() => root.querySelector("[data-try-panel] .try-card"));
    expect(canvas.tryChunkState()).toBe("ready");
    canvas.canvasFeatures = { tryIt: false };
    expect(canvas.tryChunkState()).toBe("off");
  });

  it("tries the preview on the form's own canvas, nothing while editing, and is ready once painted", async () => {
    const { canvas } = await mountAgent();
    expect(canvas.triedRuntime()).toBeUndefined();
    canvas.previewing = true;
    expect(canvas.triedRuntime()).toBe(canvas.previewRuntime());
    // No session: ready once the renderer has painted (its paint held here until the case lets
    // it go); pages go by their own ids.
    const renderer = (canvas.shadowRoot!.querySelector("[data-preview]") as HTMLElement & { painted(): Promise<void> })!;
    let paint!: () => void;
    const painting = new Promise<void>((resolve) => (paint = resolve));
    const painted = vi.spyOn(renderer, "painted").mockReturnValue(painting);
    let ready = false;
    const waiting = canvas.tryReady().then(() => {
      ready = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(painted).toHaveBeenCalled();
    expect(ready).toBe(false);
    paint();
    await waiting;
    expect(ready).toBe(true);
    painted.mockRestore();
    expect(canvas.tryPageIdOf("anything")).toBeUndefined();
    expect(canvas.tryNodeIdOf("anything")).toBeUndefined();
    canvas.previewing = false;
    expect(canvas.triedRuntime()).toBeUndefined();
  });

  it("tries the journey's own runtime during a journey Try it, and names its pages both ways", async () => {
    const definition: FormDefinition = {
      ...sampleDefinition(),
      journey: {
        journeys: [
          {
            id: "intake",
            name: "Intake",
            pages: [
              { id: "about", title: "About you", components: ["fullName"] },
              { id: "contact", title: "Keeping in touch", components: ["subscribe", "email"] }
            ]
          }
        ]
      }
    };
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.setAttribute("features", "-pdf");
    element.definition = definition;
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    await modesReady(element);
    const shellRoot = element.builder!.shadowRoot!;
    const canvas = shellRoot.querySelector("datum-builder-canvas") as Canvas;
    element.mode = "journeys";
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready && canvas.shadowRoot!.querySelector("[data-try-it]"));
    canvas.shadowRoot!.querySelector<HTMLElement>("[data-try-it]")!.click();
    await canvas.tryReady();
    const journeyRuntime = element.journeyMode!.previewRuntime;
    expect(journeyRuntime).toBeDefined();
    expect(canvas.triedRuntime()).toBe(journeyRuntime);
    expect(canvas.triedRuntime()).not.toBe(canvas.previewRuntime());
    // The preview runs each page under its designer node; the journey names it by its page id.
    const nodes = element.journeyMode!.controller.snapshot().children!.pages!.map((page) => page.id);
    expect(canvas.tryNodeIdOf("about")).toBe(nodes[0]);
    expect(canvas.tryNodeIdOf("contact")).toBe(nodes[1]);
    expect(canvas.tryPageIdOf(nodes[1]!)).toBe("contact");
    expect(canvas.tryNodeIdOf("nowhere")).toBeUndefined();
    expect(journeyRuntime!.journeyView()!.pageId).toBe(nodes[0]);
  });

  it("leaves focus in the chat when a journey Submit's server errors take the journey back to an earlier page", async () => {
    const definition: FormDefinition = {
      ...sampleDefinition(),
      journey: {
        journeys: [
          {
            id: "intake",
            name: "Intake",
            pages: [
              { id: "about", title: "About you", components: ["fullName"] },
              { id: "contact", title: "Keeping in touch", components: ["subscribe", "email"] }
            ]
          }
        ]
      }
    };
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.setAttribute("features", "-pdf");
    element.definition = definition;
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    await modesReady(element);
    const canvas = element.builder!.shadowRoot!.querySelector("datum-builder-canvas") as Canvas;
    // The person's server checks, in hand: the server faults Full name, on the journey's first page.
    element.builder!.serverChecks = {
      label: "Sandbox",
      run: async () => ({ errors: [{ componentId: "fullName", code: "domain", message: "Not on the list.", path: "fullName" }] as never })
    };
    // A journey is tried from a step: the Map view has no Try it, and its chunk arriving would end one started over its note.
    element.journeyMode!.view = "step";
    element.mode = "journeys";
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready && canvas.shadowRoot!.querySelector("[data-try-it]"));
    canvas.shadowRoot!.querySelector<HTMLElement>("[data-try-it]")!.click();
    await canvas.tryReady();
    const panel = canvas.shadowRoot!.querySelector<HTMLElement>("[data-try-panel]")!;
    const serverSwitch = (): HTMLInputElement | null => panel.querySelector<HTMLInputElement>("[data-try-server]");
    await until(() => panel.querySelector(".try-card") && serverSwitch() && !serverSwitch()!.disabled);
    serverSwitch()!.click();
    await until(() => canvas.tryServerChecks() === "on");
    // The person answered the first page and continued to the second.
    const runtime = canvas.triedRuntime() as { setValue(path: string, value: unknown): void; nextPage(): Promise<unknown>; journeyView(): { pageId: string } | undefined };
    runtime.setValue("fullName", "Ana");
    await runtime.nextPage();
    const renderer = canvas.shadowRoot!.querySelector("[data-preview]") as HTMLElement & { painted(): Promise<void> };
    await renderer.painted();
    expect(runtime.journeyView()!.pageId).toBe(canvas.tryNodeIdOf("contact"));

    // The person types in a chat beside the builder while an agent submits.
    const chat = document.createElement("input");
    document.body.append(chat);
    chat.focus();
    expect(await canvas.agentTrySubmit()).toMatchObject({ outcome: "invalid" });
    await renderer.painted();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await renderer.painted();
    // The server's error took the journey back to the page holding it (`setErrors`),
    // drawn, and focus stayed in the chat: the form took none.
    expect(runtime.journeyView()!.pageId).toBe(canvas.tryNodeIdOf("about"));
    expect(renderer.shadowRoot!.querySelector('[data-component-id="fullName"] input')).not.toBeNull();
    expect(renderer.shadowRoot!.activeElement).toBeNull();
    expect(document.activeElement).toBe(chat);
    // No quiet is left behind for the person's next page move: it takes focus to the new page.
    runtime.setValue("fullName", "Bea");
    await runtime.nextPage();
    await renderer.painted();
    await until(() => runtime.journeyView()!.pageId === canvas.tryNodeIdOf("contact") && renderer.shadowRoot!.activeElement !== null);
  });

  it("waits for a mode session's own ready() before it says Try it is ready", async () => {
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    element.options = { initialRoot: agentRoot() };
    document.body.append(element);
    await until(() => element.shadowRoot?.querySelector("datum-builder-canvas")?.shadowRoot?.querySelector(".canvas-page"));
    const canvas = element.shadowRoot!.querySelector("datum-builder-canvas") as Canvas;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const sessions: BuilderTrySession[] = [];
    const controller = new BuilderController();
    controller.setOptions({ initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "note", type: "text", configuration: { label: "Note" } }] } } });
    const surface = document.createElement("div");
    const mode: BuilderMode = {
      id: "pdf",
      label: "PDF",
      controller,
      activate: async (context) => {
        context.showCanvasSurface(surface, { tryable: true });
      },
      tryIt: {
        session: () => {
          const runtime = new BuilderPreviewRuntime(agentRoot());
          const made: BuilderTrySession = {
            runtime: runtime as never,
            answers: () => ({}),
            submit: async () => ({ problems: [] }),
            refresh: () => undefined,
            restart: () => undefined,
            dispose: () => undefined,
            ready: () => gate
          };
          sessions.push(made);
          return made;
        }
      }
    };
    element.addMode(mode);
    element.setMode("pdf");
    await until(() => element.mode === "pdf" && canvas.shadowRoot!.querySelector("[data-try-it]"));
    canvas.shadowRoot!.querySelector<HTMLElement>("[data-try-it]")!.click();
    await until(() => sessions.length === 1);
    expect(canvas.triedRuntime()).toBe(sessions[0]!.runtime);
    let ready = false;
    const waiting = canvas.tryReady().then(() => {
      ready = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ready).toBe(false);
    open();
    await waiting;
    expect(ready).toBe(true);
  });

  it("names the box the person types in on the form tried, only while the document has focus", async () => {
    const { canvas, root } = await mountAgent();
    canvas.previewing = true;
    await canvas.tryReady();
    const form = triedForm(root);
    await until(() => form.querySelector('[data-component-id="fullName"] input'));
    expect(canvas.focusedTriedPath()).toBeUndefined();
    form.querySelector<HTMLInputElement>('[data-component-id="fullName"] input')!.focus();
    expect(document.hasFocus()).toBe(true);
    expect(canvas.focusedTriedPath()).toBe("fullName");
    // The person is in another window (a browser side panel): not typing here.
    const away = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(canvas.focusedTriedPath()).toBeUndefined();
    away.mockRestore();
    // A box that is no text box (a checkbox) is not typing either.
    form.querySelector<HTMLInputElement>('[data-component-id="consent"] input')!.focus();
    expect(canvas.focusedTriedPath()).toBeUndefined();
    // Back to editing: nothing is tried.
    form.querySelector<HTMLInputElement>('[data-component-id="fullName"] input')?.focus();
    canvas.previewing = false;
    expect(canvas.focusedTriedPath()).toBeUndefined();
  });

  it("checks and submits as the panel does, the Submit leaving focus where the person is, heard by onTrySubmit", async () => {
    const { element, canvas, root } = await mountAgent();
    element.controller.setTrySubmission({ delayMs: 0 });
    const chat = document.createElement("input");
    document.body.append(chat);
    canvas.previewing = true;
    await until(() => root.querySelector("[data-try-panel] .try-card"));
    expect(canvas.tryRecording()).toBe(false);
    expect(canvas.tryShowing()).toBe(false);
    expect(canvas.tryServerChecks()).toBe("off");

    const checked = await canvas.agentTryCheck();
    expect(checked.server).toBe("off");
    expect(checked.problems).toEqual([expect.objectContaining({ componentId: "fullName", label: "Full name" })]);
    // Drawn for the person, as their own Check draws it.
    expect(root.querySelector("[data-try-panel]")!.textContent).toContain(checked.problems[0]!.message);

    const heard: string[] = [];
    const stop = canvas.onTrySubmit((outcome) => heard.push(outcome.outcome));
    chat.focus();
    const submitted = await canvas.agentTrySubmit();
    expect(submitted).toMatchObject({ outcome: "invalid" });
    expect(heard).toEqual(["invalid"]);
    expect(document.activeElement).toBe(chat);
    stop();
    // Once stopped, a later Submit is not heard.
    expect(await canvas.agentTrySubmit()).toMatchObject({ outcome: "invalid" });
    expect(heard).toEqual(["invalid"]);
  });

  it("moves focus to the first error as the person's Submit does while the person is in the form tried", async () => {
    const { element, canvas, root } = await mountAgent();
    element.controller.setTrySubmission({ delayMs: 0 });
    canvas.previewing = true;
    await until(() => root.querySelector("[data-try-panel] .try-card"));
    await canvas.tryReady();
    const form = triedForm(root);
    const box = (id: string): HTMLInputElement | null => form.querySelector<HTMLInputElement>(`[data-component-id="${id}"] input`);
    await until(() => box("consent"));
    // The person is in the form tried. The canvas sits inside the builder's shadow root, so the
    // page's active element is the builder: only the walk down through each shadow root finds
    // the person in the canvas.
    box("consent")!.focus();
    expect(document.activeElement).toBe(element);
    expect(document.hasFocus()).toBe(true);
    const renderer = root.querySelector("[data-preview]") as HTMLElement & { focusFirstError(): void };
    const first = vi.spyOn(renderer, "focusFirstError");
    expect(await canvas.agentTrySubmit()).toMatchObject({ outcome: "invalid" });
    expect(first).toHaveBeenCalledTimes(1);
    // Focus went to the error summary, as for the person's own press.
    await until(() => inSummary(form));
    first.mockRestore();
  });

  it("quiets the tried renderer's next page focus through its public quiet, handing back its release", async () => {
    const { canvas, root } = await mountAgent();
    canvas.previewing = true;
    await canvas.tryReady();
    const renderer = root.querySelector("[data-preview]") as HTMLElement & { quietNextPageFocus(): () => void };
    const quiet = vi.spyOn(renderer, "quietNextPageFocus");
    // The canvas asks the tried renderer (its public quiet) and hands back the renderer's own
    // release; what the quiet does to a page move is the element's, tested with the element.
    const release = canvas.quietTriedPageFocus();
    expect(quiet).toHaveBeenCalledTimes(1);
    expect(release).toBe(quiet.mock.results[0]!.value);
    expect(() => release()).not.toThrow();
    quiet.mockRestore();
  });

  it("says when the person records, shows a test's step, or turned the server's checks on", async () => {
    const { element, canvas, root } = await mountAgent();
    canvas.previewing = true;
    await until(() => root.querySelector("[data-try-panel] .try-card"));

    // Record: on until its stop.
    const stopRecording = canvas.recordTry(() => undefined);
    expect(canvas.tryRecording()).toBe(true);
    stopRecording();
    expect(canvas.tryRecording()).toBe(false);

    // Show me: on until the panel forgets it.
    canvas.showScenario({ name: "Happy path", step: 1, steps: 2, line: 1, values: { fullName: "Ana" }, onStep: () => undefined, onStop: () => undefined });
    expect(canvas.tryShowing()).toBe(true);
    canvas.showScenario(undefined);
    expect(canvas.tryShowing()).toBe(false);

    // The server's checks: the person's switch in the panel, read as the panel draws it.
    let land!: () => void;
    const landed = new Promise<void>((resolve) => (land = resolve));
    element.serverChecks = async () => {
      await landed;
      return { label: "Sandbox", run: async () => ({ errors: [] }) };
    };
    const panel = root.querySelector<HTMLElement>("[data-try-panel]")!;
    await until(() => panel.querySelector<HTMLInputElement>("[data-try-server]") && !panel.querySelector<HTMLInputElement>("[data-try-server]")!.disabled);
    expect(canvas.tryServerChecks()).toBe("off");
    panel.querySelector<HTMLInputElement>("[data-try-server]")!.click();
    // Loading: the switch is drawn on, and an agent reads it on.
    expect(panel.querySelector<HTMLInputElement>("[data-try-server]")!.checked).toBe(true);
    expect(canvas.tryServerChecks()).toBe("on");
    land();
    await until(() => !panel.querySelector('[data-try-wasm="loading"]'));
    expect(canvas.tryServerChecks()).toBe("on");
    expect((await canvas.agentTryCheck()).server).toBe("ran");
    panel.querySelector<HTMLInputElement>("[data-try-server]")!.click();
    expect(canvas.tryServerChecks()).toBe("off");
  });
});
