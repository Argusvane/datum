// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuilderController } from "../../form-engine/builder/controller/builder-controller.js";
import { DATUM_BUILDER_CANVAS_TAG, defineBuilderPanels, type DatumBuilderCanvasElement } from "../../form-engine/builder/web-component/builder-panels.js";
import { defineBuilderTestsPanel, TESTS_RUN_AS_I_EDIT_KEY } from "../../form-engine/builder/web-component/builder-tests-panel.js";
import type { ComponentNode } from "../../form-engine/core/schema/types.js";

/**
 * Record and Assert this over the real canvas and the real panel. The
 * panel suite drives a fake canvas whose snapshot has no side effect; the real one sends what it
 * holds back when asked for a snapshot, which is what these pin.
 */

defineBuilderPanels();
defineBuilderTestsPanel();

beforeEach(() => {
  // Node 22's own localStorage global shadows jsdom's: a store of the test's own.
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => void items.delete(key),
    setItem: (key: string, value: string) => void items.set(key, String(value))
  } satisfies Storage);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read: () => unknown, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (read()) {
      return;
    }
    await wait(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Panel = HTMLElement & {
  controller?: BuilderController;
  definition?: () => unknown;
  recordOnCanvas?: (listener: (event: unknown) => void) => () => void;
  assertSnapshot?: () => unknown;
  testsEditorLoader?: () => Promise<never>;
  whenIdle(): Promise<void>;
  recording: boolean;
  recordingReady(): void;
};

const FORM = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "first", type: "text", configuration: { label: "First" } },
      { id: "last", type: "text", configuration: { label: "Last" } },
      { id: "subscribe", type: "checkbox", configuration: { label: "Subscribe" } },
      { id: "newsletter", type: "text", configuration: { label: "Newsletter email" }, rules: { visibleWhen: "subscribe = true" } }
    ]
  }
} as ComponentNode;

/** A form whose rule reads the clock: `adult` shows for an applicant born 18 years or more ago. */
const CLOCK_FORM = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "first", type: "text", configuration: { label: "First" } },
      { id: "born", type: "date", configuration: { label: "Born" } },
      { id: "adult", type: "text", configuration: { label: "Adult" }, rules: { visibleWhen: "age(born) >= 18" } }
    ]
  }
} as ComponentNode;

/** The author's calendar day, as the canvas lends it to a recording. */
function localDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * The canvas and the panel side by side, Record pressed on entry `a`. `ready` wires what the
 * shell does with the canvas's `canvas-record-change` `ready` (the Try it chunk arrived after
 * Record started): the panel's `recordingReady`. Without it the panel falls back as before.
 */
async function mount(options: { root?: ComponentNode; ready?: boolean } = {}): Promise<{ canvas: DatumBuilderCanvasElement; panel: Panel; shadow: ShadowRoot }> {
  localStorage.setItem(TESTS_RUN_AS_I_EDIT_KEY, "false");
  const root = options.root ?? FORM;
  const controller = new BuilderController({ initialRoot: root });
  controller.setTests({ scenarios: [{ id: "a", source: 'test "a"\n  set first = "x"\n' }] }, { silent: true });
  const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
  canvas.controller = controller;
  document.body.append(canvas);
  const panel = document.createElement("datum-builder-tests-panel") as Panel;
  panel.testsEditorLoader = () => Promise.reject(new Error("the box, not CodeMirror"));
  panel.definition = () => ({ id: "f", version: "1", schemaVersion: "1", root: controller.snapshot(), tests: controller.tests() });
  panel.recordOnCanvas = (listener) => canvas.recordTry(listener as Parameters<DatumBuilderCanvasElement["recordTry"]>[0]);
  panel.assertSnapshot = () => canvas.assertSnapshot();
  panel.controller = controller;
  if (options.ready) {
    canvas.addEventListener("canvas-record-change", (event) => {
      const detail = (event as CustomEvent<{ recording?: boolean; ready?: boolean }>).detail;
      if (detail?.recording === true && detail.ready === true) {
        panel.recordingReady();
      }
    });
  }
  document.body.append(panel);
  await panel.whenIdle();
  const shadow = panel.shadowRoot!;
  shadow.querySelector<HTMLElement>('[data-tests-entry="a"]')!.click();
  await wait(10);
  shadow.querySelector<HTMLElement>("[data-tests-record]")!.click();
  await until(() => canvas.shadowRoot!.querySelector("[data-try-record-stop]"), "the bar's Stop recording");
  return { canvas, panel, shadow };
}

/**
 * Focus leaving the form: the recorder reads where it went a tick later (a repaint puts it back),
 * and once more on the next task when it is on nothing (a theme puts it back a task late).
 */
async function leave(canvas: DatumBuilderCanvasElement): Promise<void> {
  canvas.shadowRoot!.querySelector("[data-preview]")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Record over the real canvas", () => {
  it("records a value typed across the panel's parse paint once, as it was left", async () => {
    const { canvas, shadow } = await mount();
    const preview = canvas.previewRuntime()!;
    preview.setValue("first", "Jane");
    await leave(canvas);
    // Typing in the next field at once, still typing when the 150 ms parse paint comes.
    preview.setValue("last", "S");
    await wait(60);
    preview.setValue("last", "Sm");
    await wait(200);
    preview.setValue("last", "Smith");
    await leave(canvas);
    await wait(200);
    const text = shadow.querySelector<HTMLTextAreaElement>("textarea")!.value;
    expect(text.match(/set last/g)).toHaveLength(1);
    expect(text).toContain('  set last = "Smith"');
  });

  it("records a word typed one key at a time into the preview's control as one line, once focus leaves the form", async () => {
    const { canvas, shadow } = await mount();
    const renderer = canvas.shadowRoot!.querySelector<HTMLElement>("[data-preview]")!;
    let input: HTMLInputElement | null = null;
    await until(() => (input = renderer.shadowRoot?.querySelector<HTMLInputElement>('[data-value-path="first"] input') ?? null), "the first input");
    const clicked = input!;
    clicked.focus();
    for (const typed of ["c", "ca", "cat", "cats"]) {
      clicked.value = typed;
      clicked.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      await wait(30);
      // The renderer draws each key in place: the control typed into stays, and focus with it.
      expect(renderer.shadowRoot!.activeElement).toBe(clicked);
    }
    await wait(200);
    expect(shadow.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe('test "a"\n  set first = "x"\n');
    (renderer.shadowRoot!.activeElement as HTMLInputElement).blur();
    await leave(canvas);
    await wait(200);
    expect(shadow.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe('test "a"\n  set first = "x"\n  set first = "cats"\n');
  });

  it("ticks the field a ticked checkbox showed in Assert this", async () => {
    const { canvas, shadow } = await mount();
    const preview = canvas.previewRuntime()!;
    preview.setValue("first", "Jane");
    await leave(canvas);
    await wait(200);
    preview.setValue("subscribe", true);
    // Pressing Assert this moves focus out of the form first.
    await leave(canvas);
    shadow.querySelector<HTMLElement>("[data-tests-assert-open]")!.click();
    const picked = [...shadow.querySelectorAll<HTMLInputElement>("[data-tests-assert-field]")].filter((box) => box.checked).map((box) => box.getAttribute("data-tests-assert-field"));
    expect(picked).toContain("newsletter");
    expect(shadow.querySelector("[data-tests-assert-insert]")!.hasAttribute("disabled")).toBe(false);
  });

  it("ticks the field the first step names when Record turned Try it on before its chunk arrived", async () => {
    const { canvas, panel, shadow } = await mount();
    expect(panel.recording).toBe(true);
    canvas.previewRuntime()!.setValue("subscribe", true);
    await leave(canvas);
    shadow.querySelector<HTMLElement>("[data-tests-assert-open]")!.click();
    const picked = [...shadow.querySelectorAll<HTMLInputElement>("[data-tests-assert-field]")].filter((box) => box.checked).map((box) => box.getAttribute("data-tests-assert-field"));
    // The panel had no snapshot when Record started (the Try it chunk was still on its way), so the
    // first one already holds the step: the field it names is ticked, never nothing.
    expect(picked).toEqual(["subscribe"]);
    expect(shadow.querySelector("[data-tests-assert-insert]")!.hasAttribute("disabled")).toBe(false);
  });

  it("ticks what the first step revealed too when the canvas says its chunk arrived", async () => {
    const { canvas, panel, shadow } = await mount({ ready: true });
    expect(panel.recording).toBe(true);
    canvas.previewRuntime()!.setValue("subscribe", true);
    await leave(canvas);
    shadow.querySelector<HTMLElement>("[data-tests-assert-open]")!.click();
    const picked = [...shadow.querySelectorAll<HTMLInputElement>("[data-tests-assert-field]")].filter((box) => box.checked).map((box) => box.getAttribute("data-tests-assert-field"));
    // The form before the step was taken when the chunk landed, so the field the tick showed is what
    // moved (the tick itself is the recorded set line), as when Try it was already on.
    expect(picked).toEqual(["newsletter"]);
  });
});

describe("Record lends the canvas a day", () => {
  it("runs a clock-reading form on the author's day while it records, writes it as given today, and puts the day back", async () => {
    const { canvas, panel, shadow } = await mount({ root: CLOCK_FORM, ready: true });
    const preview = canvas.previewRuntime()!;
    const day = localDay();
    expect(preview.today()).toBe(day);
    await until(() => shadow.querySelector<HTMLTextAreaElement>("textarea")!.value.includes("given today"), "the given today line");
    expect(shadow.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(`test "a"\n  given today = @"${day}"\n  set first = "x"\n`);
    expect(shadow.querySelector("[data-tests-record-no-day]")).toBeNull();
    // The rules on screen read the day the line names.
    preview.setValue("born", "1990-05-05");
    await leave(canvas);
    expect(preview.effectiveStatesMap().get("adult")?.visible).toBe(true);
    shadow.querySelector<HTMLElement>("[data-tests-record]")!.click();
    expect(panel.recording).toBe(false);
    expect(preview.today()).toBe("");
  });

  it("leaves a preview that already has a day alone, and lends none for a form that is not recording", async () => {
    const { canvas, shadow } = await mount({ ready: true });
    const preview = canvas.previewRuntime()!;
    // Stopped and a day set by hand (Show me's given would be one): a new recording keeps it.
    shadow.querySelector<HTMLElement>("[data-tests-record]")!.click();
    expect(preview.today()).toBe("");
    preview.setToday("2026-03-01");
    shadow.querySelector<HTMLElement>("[data-tests-record]")!.click();
    expect(preview.today()).toBe("2026-03-01");
    shadow.querySelector<HTMLElement>("[data-tests-record]")!.click();
    expect(preview.today()).toBe("2026-03-01");
  });
});
