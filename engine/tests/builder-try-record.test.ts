// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { TestsRecordEvent } from "../form-engine/builder/form-tests/tests-model.js";
import { DATUM_BUILDER_CANVAS_TAG, defineBuilderPanels, type DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { parseComponentPath } from "../form-engine/core/tree/component-path.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * Record on the canvas: the Tests panel hands the canvas a listener, the
 * canvas turns Try it on and the Try it chunk reports what the author does there as settled
 * events (an answer once it is settled, a row added or removed, a journey's move, Check now,
 * Submit's outcome), the Try bar reading "Recording" with Stop recording meanwhile. Back to
 * editing, Clear answers, the bar's Stop and the returned function end it.
 */

defineBuilderPanels();

afterEach(() => {
  document.body.innerHTML = "";
});

function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "full_name", type: "text", configuration: { label: "Full name", required: true } },
        {
          id: "contact_method",
          type: "select",
          configuration: { label: "How to reach you", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] }
        },
        { id: "phone", type: "text", configuration: { label: "Phone" }, rules: { visibleWhen: 'contact_method = "phone"', requiredWhen: 'contact_method = "phone"' } },
        { id: "greeting", type: "text", configuration: { label: "Greeting" }, rules: { value: '"Hello " & full_name' } },
        { id: "applicant", type: "text", configuration: { label: "Applicant", dataKey: "applicant_name" } },
        {
          id: "items",
          type: "repeatingSection",
          configuration: { label: "Items" },
          collection: { itemFields: ["qty"] },
          children: { content: [{ id: "qty", type: "number", configuration: { label: "Quantity" } }] }
        },
        { id: "submit", type: "button", configuration: { label: "Submit", action: "submit" } }
      ]
    }
  } as ComponentNode;
}

async function until<T>(read: () => T, what = "the condition"): Promise<NonNullable<T>> {
  for (let i = 0; i < 200; i += 1) {
    const value = read();
    if (value) {
      return value as NonNullable<T>;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function mount(): { canvas: DatumBuilderCanvasElement; controller: BuilderController; root: ShadowRoot } {
  const controller = new BuilderController({ initialRoot: form() });
  const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
  canvas.controller = controller;
  document.body.append(canvas);
  return { canvas, controller, root: canvas.shadowRoot! };
}

/** Starts a recording and waits for the Try it chunk to draw the bar's control. */
async function recording(): Promise<{ canvas: DatumBuilderCanvasElement; controller: BuilderController; root: ShadowRoot; events: TestsRecordEvent[]; stop: () => void; changes: Array<boolean | "ready"> }> {
  const mounted = mount();
  // `ready` is the start's second word, when the Try it chunk arrived after Record.
  const changes: Array<boolean | "ready"> = [];
  mounted.canvas.addEventListener("canvas-record-change", (event) => {
    const detail = (event as CustomEvent<{ recording: boolean; ready?: boolean }>).detail;
    changes.push(detail.ready === true ? "ready" : detail.recording);
  });
  const events: TestsRecordEvent[] = [];
  const stop = mounted.canvas.recordTry((event) => events.push(event));
  await until(() => mounted.root.querySelector("[data-canvas-bar] [data-try-record-stop]"), "the bar's Stop recording");
  return { ...mounted, events, stop, changes };
}

/**
 * Focus leaving the form: what settles an answer the preview cannot say is settled. The recorder
 * reads where focus went a tick later (a repaint puts it back into the same answer's control),
 * and once more on the next task when it is on nothing (a theme puts it back a task late).
 */
async function leaveControl(root: ShadowRoot): Promise<void> {
  root.querySelector("[data-preview]")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
  await settledLeave();
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The two tasks a leave to nothing is read over. */
async function settledLeave(): Promise<void> {
  await tick();
  await tick();
}

/** The canvas's preview renderer and its first control of `path` (inside the field's wrapper, the DOM contract), drawn by the real draw. */
async function controlOf(root: ShadowRoot, path: string): Promise<{ renderer: HTMLElement; control: HTMLInputElement }> {
  const renderer = root.querySelector<HTMLElement>("[data-preview]")!;
  const control = await until(() => renderer.shadowRoot?.querySelector<HTMLInputElement>(`[data-value-path="${path}"] input`), `the ${path} input`);
  return { renderer, control };
}

/** What a design system's own redraw does to the control typed into (a component drawn afresh): a new one of the same answer, focus put back in it. */
function repaint(control: HTMLInputElement, path: string): HTMLInputElement {
  const fresh = document.createElement("input");
  fresh.type = "text";
  fresh.dataset.componentId = path;
  control.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
  control.replaceWith(fresh);
  fresh.focus();
  fresh.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
  return fresh;
}

describe("Record on the canvas", () => {
  it("turns Try it on and says so in the bar: Recording, with Stop recording", async () => {
    const { canvas, root, changes } = await recording();
    expect(canvas.previewing).toBe(true);
    expect(canvas.recording).toBe(true);
    const bar = root.querySelector<HTMLElement>("[data-canvas-bar]")!;
    expect(bar.hasAttribute("data-try-recording-on")).toBe(true);
    expect(bar.querySelector("[data-try-recording-label]")!.textContent).toBe("Recording");
    expect(bar.querySelector("[data-try-recording-label]")!.getAttribute("role")).toBe("status");
    expect(bar.querySelector("[data-try-record-stop]")!.textContent).toBe("Stop recording");
    // Before Back to editing, as Show me's control is.
    expect(bar.querySelector("[data-try-recording]")!.nextElementSibling?.hasAttribute("data-try-it")).toBe(true);
    // Try it was off: the start, then the chunk's arrival.
    expect(changes).toEqual([true, "ready"]);
  });

  it("reports an answer once it is settled: held while it is written, sent when another field is or the control is left", async () => {
    const { canvas, root, events } = await recording();
    const preview = canvas.previewRuntime()!;
    preview.setValue("full_name", "A");
    preview.setValue("full_name", "Ad");
    preview.setValue("full_name", "Ada");
    expect(events).toEqual([]);
    preview.setValue("contact_method", "phone");
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }]);
    await leaveControl(root);
    expect(events.at(-1)).toEqual({ kind: "set", componentId: "contact_method", path: "contact_method", value: "phone" });
    // Left again with nothing new: no line.
    await leaveControl(root);
    expect(events).toHaveLength(2);
    // Emptied: a clear.
    preview.setValue("full_name", "");
    await leaveControl(root);
    expect(events.at(-1)).toEqual({ kind: "clear", componentId: "full_name", path: "full_name" });
  });

  it("takes the answers as they stand when it starts: the same value written again is no line", async () => {
    const { canvas, controller } = mount();
    void controller;
    const preview = canvas.previewRuntime()!;
    preview.setValue("full_name", "Ada");
    const events: TestsRecordEvent[] = [];
    canvas.recordTry((event) => events.push(event));
    await until(() => canvas.shadowRoot!.querySelector("[data-try-record-stop]"));
    preview.setValue("full_name", "Ada");
    await leaveControl(canvas.shadowRoot!);
    expect(events).toEqual([]);
  });

  it("skips a calculation's value, and names a field with a data key by its value path", async () => {
    const { canvas, root, events } = await recording();
    const preview = canvas.previewRuntime()!;
    preview.setValue("greeting", "Hi");
    await leaveControl(root);
    expect(events).toEqual([]);
    preview.setValue("applicant_name", "Grace");
    await leaveControl(root);
    expect(events).toEqual([{ kind: "set", componentId: "applicant", path: "applicant_name", value: "Grace" }]);
  });

  it("reports a row added or removed from the collection's row count, and a row's answer by its engine path", async () => {
    const { canvas, root, events } = await recording();
    const preview = canvas.previewRuntime()!;
    preview.addRow("items");
    expect(events).toEqual([{ kind: "addRow", componentId: "items", collection: "items", count: 1 }]);
    preview.setValue("items[0].qty", 3);
    await leaveControl(root);
    expect(events.at(-1)).toEqual({ kind: "set", componentId: "qty", path: "items[0].qty", value: 3 });
    preview.addRow("items");
    preview.removeRow("items", 0);
    // Which row went is read off the rows before and after (the panel's `index` ask).
    expect(events.slice(-2)).toEqual([
      { kind: "addRow", componentId: "items", collection: "items", count: 2 },
      { kind: "removeRow", componentId: "items", collection: "items", count: 1, index: 0 }
    ]);
    preview.setValue("items[0].qty", 5);
    preview.addRow("items");
    await leaveControl(root);
    preview.removeRow("items", 1);
    expect(events.at(-1)).toEqual({ kind: "removeRow", componentId: "items", collection: "items", count: 1, index: 1 });
  });

  it("settles a held answer on a runtime's commit, and at once on a write the runtime marks final", async () => {
    const { canvas, events } = await recording();
    const preview = canvas.previewRuntime()!;
    const bus = preview.events();
    preview.setValue("full_name", "Ada");
    bus.publish({ id: "c1", type: FormEventType.COMPONENT_COMMITTED, timestamp: 0, source: "runtime", formId: "f", path: parseComponentPath("full_name"), data: { value: "Ada" } });
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }]);
    preview.setValue("contact_method", "email");
    bus.publish({ id: "c2", type: FormEventType.COMPONENT_CHANGED, timestamp: 0, source: "runtime", formId: "f", path: parseComponentPath("contact_method"), data: { value: "email" } });
    expect(events.at(-1)).toEqual({ kind: "set", componentId: "contact_method", path: "contact_method", value: "email" });
  });

  it("reports a journey's moves by their direction: Continue, Back, a jump; a held-back Continue too", async () => {
    const { canvas, root, events } = await recording();
    const preview = canvas.previewRuntime()!;
    const bus = preview.events();
    const page = (direction: string, toPageId: string): void =>
      bus.publish({ id: direction, type: FormEventType.PAGE_CHANGED, timestamp: 0, source: "runtime", formId: "f", data: { journeyId: "j", fromPageId: "a", toPageId, direction, index: 0, total: 3 } });
    preview.setValue("full_name", "Ada");
    page("forward", "b");
    // What was typed before Continue comes first.
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }, { kind: "continue" }]);
    page("back", "a");
    page("jump", "c");
    page("start", "a");
    page("error", "b");
    expect(events.slice(2)).toEqual([{ kind: "back" }, { kind: "goTo", page: "c" }]);
    bus.publish({ id: "blocked", type: FormEventType.PAGE_BLOCKED, timestamp: 0, source: "runtime", formId: "f", data: { journeyId: "j", fromPageId: "a", reason: "validation" } });
    bus.publish({ id: "pending", type: FormEventType.PAGE_BLOCKED, timestamp: 0, source: "runtime", formId: "f", data: { journeyId: "j", fromPageId: "a", reason: "pending" } });
    expect(events.slice(4)).toEqual([{ kind: "continue" }]);
    void root;
  });

  it("reports a Change link as change <field>, naming the first answer the opened step asks", async () => {
    const { canvas, events } = await recording();
    const preview = canvas.previewRuntime()!;
    const bus = preview.events();
    const view = { members: ["contact_method", "full_name"], pageOf: { full_name: "a", contact_method: "a", other: "b" } };
    const change = (toPageId: string): void =>
      bus.publish({ id: `change-${toPageId}`, type: FormEventType.PAGE_CHANGED, timestamp: 0, source: "runtime", formId: "f", data: { journeyId: "j", fromPageId: "check", toPageId, direction: "change", index: 0, total: 3 } });
    (preview as unknown as { journeyView: () => unknown }).journeyView = () => view;
    change("a");
    expect(events).toEqual([{ kind: "change", path: "contact_method" }]);
    // A step that asks nothing the form holds says nothing: there is no row to name.
    change("nowhere");
    expect(events).toHaveLength(1);
  });

  it("reports Check now, and Submit with the stand-in's outcome", async () => {
    const { canvas, controller, root, events } = await recording();
    controller.setTrySubmission({ delayMs: 0, outcome: "accept" });
    const preview = canvas.previewRuntime()!;
    await until(() => root.querySelector<HTMLButtonElement>("[data-try-check]"), "Check now");
    preview.setValue("full_name", "Ada");
    root.querySelector<HTMLButtonElement>("[data-try-check]")!.click();
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }, { kind: "check" }]);
    const submitted = new Promise<void>((resolve) => canvas.addEventListener("builder-try-submit", () => resolve(), { once: true }));
    root.querySelector("[data-preview]")!.dispatchEvent(new CustomEvent("datum-form-action", { bubbles: true, composed: true, detail: { action: "submit" } }));
    await submitted;
    expect(events.at(-1)).toEqual({ kind: "submit", accepted: true });
    expect(canvas.assertSnapshot()?.lastSubmit).toBe("accepted");
    // A required field emptied: the checks refuse, nothing sent, not accepted.
    preview.setValue("full_name", "");
    const refused = new Promise<void>((resolve) => canvas.addEventListener("builder-try-submit", () => resolve(), { once: true }));
    root.querySelector("[data-preview]")!.dispatchEvent(new CustomEvent("datum-form-action", { bubbles: true, composed: true, detail: { action: "submit" } }));
    await refused;
    expect(events.slice(-2)).toEqual([{ kind: "clear", componentId: "full_name", path: "full_name" }, { kind: "submit", accepted: false }]);
    expect(canvas.assertSnapshot()?.lastSubmit).toBe("refused");
  });

  it("writes an answer settled while Submit is in flight after the submit, as it came after the press", async () => {
    const { canvas, controller, root, events } = await recording();
    // Long enough for a leave's two ticks and the repaints around them to come before it lands.
    controller.setTrySubmission({ delayMs: 200, outcome: "accept" });
    const preview = canvas.previewRuntime()!;
    preview.setValue("full_name", "Ada");
    const submitted = new Promise<void>((resolve) => canvas.addEventListener("builder-try-submit", () => resolve(), { once: true }));
    root.querySelector("[data-preview]")!.dispatchEvent(new CustomEvent("datum-form-action", { bubbles: true, composed: true, detail: { action: "submit" } }));
    const renderer = root.querySelector("[data-preview]") as unknown as { submitting?: boolean };
    await until(() => renderer.submitting === true, "Submitting…");
    // Typed during "Submitting…" and left: held for the submit's line.
    preview.setValue("applicant_name", "Bo");
    await leaveControl(root);
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }]);
    await submitted;
    expect(events).toEqual([
      { kind: "set", componentId: "full_name", path: "full_name", value: "Ada" },
      { kind: "submit", accepted: true },
      { kind: "set", componentId: "applicant", path: "applicant_name", value: "Bo" }
    ]);
  });

  it("writes no line for a field typed into and emptied again before it was left", async () => {
    const { canvas, root, events } = await recording();
    const preview = canvas.previewRuntime()!;
    preview.setValue("full_name", "A");
    preview.setValue("full_name", "");
    await leaveControl(root);
    expect(events).toEqual([]);
    // Answered, then emptied: that is a clear.
    preview.setValue("full_name", "Ada");
    await leaveControl(root);
    preview.setValue("full_name", "");
    await leaveControl(root);
    expect(events).toEqual([
      { kind: "set", componentId: "full_name", path: "full_name", value: "Ada" },
      { kind: "clear", componentId: "full_name", path: "full_name" }
    ]);
  });

  it("names the row that went though a row calculation changed since the recording started", async () => {
    const controller = new BuilderController({
      initialRoot: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            {
              id: "items",
              type: "repeatingSection",
              configuration: { label: "Items" },
              collection: { itemFields: ["qty", "line"] },
              children: {
                content: [
                  { id: "qty", type: "number", configuration: { label: "Qty" } },
                  { id: "line", type: "number", configuration: { label: "Line" }, rules: { value: "row.qty * 2" } }
                ]
              }
            }
          ]
        }
      } as ComponentNode
    });
    const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
    canvas.controller = controller;
    document.body.append(canvas);
    const preview = canvas.previewRuntime()!;
    preview.addRow("items");
    preview.addRow("items");
    preview.setValue("items[0].qty", 1);
    preview.setValue("items[1].qty", 7);
    const events: TestsRecordEvent[] = [];
    canvas.recordTry((event) => events.push(event));
    await until(() => canvas.shadowRoot!.querySelector("[data-try-record-stop]"));
    preview.setValue("items[0].qty", 5);
    await leaveControl(canvas.shadowRoot!);
    preview.removeRow("items", 1);
    expect(events.at(-1)).toMatchObject({ kind: "removeRow", collection: "items", count: 1, index: 1 });
  });

  it("ends on Back to editing: what it held back is sent, then nothing more; the bar's control goes", async () => {
    const { canvas, root, events, changes } = await recording();
    const preview = canvas.previewRuntime()!;
    preview.setValue("full_name", "Ada");
    canvas.previewing = false;
    expect(canvas.recording).toBe(false);
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }]);
    preview.setValue("full_name", "Grace");
    await leaveControl(root);
    expect(events).toHaveLength(1);
    expect(root.querySelector("[data-try-recording]")).toBeNull();
    expect(root.querySelector("[data-canvas-bar]")!.hasAttribute("data-try-recording-on")).toBe(false);
    expect(changes).toEqual([true, "ready", false]);
  });

  it("ends on Clear answers, since its lines no longer start from the same answers", async () => {
    const { canvas, root, events, changes } = await recording();
    const clear = await until(() => root.querySelector<HTMLButtonElement>("[data-try-clear]"), "Clear answers");
    clear.click();
    expect(canvas.recording).toBe(false);
    expect(changes).toEqual([true, "ready", false]);
    canvas.previewRuntime()!.setValue("full_name", "Ada");
    await leaveControl(root);
    expect(events).toEqual([]);
    // Try it stays on.
    expect(canvas.previewing).toBe(true);
  });

  it("ends on the bar's Stop recording and on the returned function; a second recording replaces the first", async () => {
    const first = await recording();
    first.root.querySelector<HTMLButtonElement>("[data-try-record-stop]")!.click();
    expect(first.canvas.recording).toBe(false);
    expect(first.root.querySelector("[data-try-recording]")).toBeNull();
    expect(first.canvas.previewing).toBe(true);

    const one: TestsRecordEvent[] = [];
    const two: TestsRecordEvent[] = [];
    const stopOne = first.canvas.recordTry((event) => one.push(event));
    const stopTwo = first.canvas.recordTry((event) => two.push(event));
    first.canvas.previewRuntime()!.setValue("full_name", "Ada");
    await leaveControl(first.root);
    expect(one).toEqual([]);
    expect(two).toHaveLength(1);
    // The replaced recording's stop ends nothing.
    stopOne();
    expect(first.canvas.recording).toBe(true);
    stopTwo();
    expect(first.canvas.recording).toBe(false);
    await until(() => first.root.querySelector("[data-try-recording]") === null, "the control gone");
  });
});

describe("Record tells a repaint's focus move from leaving the control", () => {
  /** The control focus is in inside the preview renderer. */
  function focused(renderer: HTMLElement): HTMLInputElement {
    return renderer.shadowRoot!.activeElement as HTMLInputElement;
  }

  it("holds an answer across the repaints that put focus back into a new control of it, and writes it once when focus leaves the form", async () => {
    const { canvas, root, events } = await recording();
    const preview = canvas.previewRuntime()!;
    const { renderer, control } = await controlOf(root, "full_name");
    control.focus();
    for (const typed of ["c", "ca", "cat", "cats"]) {
      preview.setValue("full_name", typed);
      repaint(focused(renderer), "full_name");
      await tick();
      expect(events).toEqual([]);
    }
    // The person leaves: focus goes to nothing (the page's body).
    const last = focused(renderer);
    expect(last).not.toBe(control);
    last.blur();
    last.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    expect(events).toEqual([]);
    await settledLeave();
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "cats" }]);
  });

  it("settles an answer at once when focus enters another field's control, and holds that field's", async () => {
    const { canvas, root, events } = await recording();
    const preview = canvas.previewRuntime()!;
    const { renderer, control } = await controlOf(root, "full_name");
    control.focus();
    preview.setValue("full_name", "Ada");
    repaint(focused(renderer), "full_name");
    const other = renderer.shadowRoot!.querySelector<HTMLSelectElement>('[data-value-path="contact_method"] select')!;
    focused(renderer).dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    other.focus();
    other.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }]);
    preview.setValue("contact_method", "phone");
    await tick();
    // Still in the second field: its answer waits.
    expect(events).toHaveLength(1);
    // A leave while focus is still in it is a repaint's: held.
    await leaveControl(root);
    expect(events).toHaveLength(1);
    focused(renderer).blur();
    await leaveControl(root);
    expect(events.at(-1)).toEqual({ kind: "set", componentId: "contact_method", path: "contact_method", value: "phone" });
  });

  it("settles an answer two ticks after focus leaves the control for nothing", async () => {
    const { canvas, root, events } = await recording();
    const preview = canvas.previewRuntime()!;
    const { renderer, control } = await controlOf(root, "full_name");
    control.focus();
    preview.setValue("full_name", "Ada");
    const now = focused(renderer);
    now.blur();
    now.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    expect(events).toEqual([]);
    // Focus on nothing is read once more on the next task (a theme may still put it back).
    await tick();
    expect(events).toEqual([]);
    await tick();
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }]);
  });

  it("settles an answer at once when focus leaves the form for another element of the page", async () => {
    const { canvas, root, events } = await recording();
    const preview = canvas.previewRuntime()!;
    const { renderer, control } = await controlOf(root, "full_name");
    control.focus();
    preview.setValue("full_name", "Ada");
    const outside = document.createElement("button");
    document.body.append(outside);
    const now = focused(renderer);
    outside.focus();
    now.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    await tick();
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }]);
  });

  it("holds an answer while a theme puts focus back a task after the repaint (a gcds-fieldset drawn afresh)", async () => {
    const { canvas, root, events } = await recording();
    const preview = canvas.previewRuntime()!;
    const { renderer, control } = await controlOf(root, "full_name");
    control.focus();
    preview.setValue("full_name", "Ada");
    // The renderer draws the write in place: the control keeps focus.
    await (renderer as HTMLElement & { painted(): Promise<void> }).painted();
    expect(focused(renderer)).toBe(control);
    expect(events).toEqual([]);
    // A design system's component drawn afresh: its removal blurs the control first, then its restore queues its own task.
    const now = focused(renderer);
    now.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    const fresh = document.createElement("input");
    fresh.type = "text";
    fresh.dataset.componentId = "full_name";
    now.replaceWith(fresh);
    expect(renderer.shadowRoot!.activeElement).toBeNull();
    setTimeout(() => {
      fresh.focus();
      fresh.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    }, 0);
    await settledLeave();
    await tick();
    expect(focused(renderer)).toBe(fresh);
    expect(events).toEqual([]);
    fresh.blur();
    await leaveControl(root);
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }]);
  });

  it("clears a leave's check still to come when the recording stops, having settled what it held", async () => {
    const { canvas, root, events, stop } = await recording();
    const preview = canvas.previewRuntime()!;
    const { renderer, control } = await controlOf(root, "full_name");
    control.focus();
    preview.setValue("full_name", "Ada");
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    try {
      focused(renderer).dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
      // The leave's one check, waiting for its tick.
      const checks = scheduled.mock.results.map((result) => result.value as unknown);
      expect(checks).toHaveLength(1);
      stop();
      expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }]);
      expect(cleared.mock.calls.map((call) => call[0] as unknown)).toContain(checks[0]);
    } finally {
      scheduled.mockRestore();
      cleared.mockRestore();
    }
    await settledLeave();
    expect(events).toHaveLength(1);
  });
});

describe("Assert this on the canvas", () => {
  it("reads every field of the tried runtime: state, errors on show, value, value path and label", async () => {
    const { canvas, root } = await recording();
    const preview = canvas.previewRuntime()!;
    preview.setValue("contact_method", "phone");
    preview.setValue("applicant_name", "Grace");
    preview.addRow("items");
    preview.setValue("items[0].qty", 2);
    preview.setErrors([{ id: "e1", code: "required", componentId: "full_name", stage: "try", source: "client" }]);
    const snapshot = canvas.assertSnapshot()!;
    const byPath = new Map(snapshot.fields.map((field) => [field.path, field]));
    expect([...byPath.keys()]).toEqual(["full_name", "contact_method", "phone", "greeting", "applicant_name", "items[0].qty"]);
    expect(byPath.get("full_name")).toEqual({ componentId: "full_name", path: "full_name", label: "Full name", visible: true, required: true, enabled: true, readonly: false, errors: ["required"], value: undefined });
    expect(byPath.get("phone")).toMatchObject({ visible: true, required: true, errors: [] });
    expect(byPath.get("applicant_name")).toMatchObject({ componentId: "applicant", value: "Grace" });
    expect(byPath.get("items[0].qty")).toMatchObject({ componentId: "qty", label: "Quantity", value: 2 });
    expect(snapshot.page).toBeUndefined();
    expect(snapshot.lastSubmit).toBeUndefined();
    preview.setValue("contact_method", "email");
    expect(canvas.assertSnapshot()!.fields.find((field) => field.path === "phone")).toMatchObject({ visible: false, required: false });
    void root;
  });

  it("carries the preview's day as given today spells it, and none while the preview has no day", async () => {
    const { canvas, stop } = await recording();
    const preview = canvas.previewRuntime()!;
    // The canvas's preview has no day of its own: Record lends it the author's.
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(preview.today()).toBe(day);
    expect(canvas.assertSnapshot()!.today).toBe(day);
    preview.setToday("2026-03-01");
    expect(canvas.assertSnapshot()!.today).toBe("2026-03-01");
    // A preview with no day reads no clock: the snapshot says no day rather than a guessed one.
    preview.setToday(undefined);
    expect(canvas.assertSnapshot()!.today).toBeUndefined();
    expect("today" in canvas.assertSnapshot()!).toBe(false);
    stop();
    expect(preview.today()).toBe("");
  });

  it("puts back only the day it lent when the recording ends", async () => {
    const { canvas, stop } = await recording();
    const preview = canvas.previewRuntime()!;
    expect(preview.today()).not.toBe("");
    stop();
    expect(preview.today()).toBe("");
    // A day set while recording (a showing's given would be one) is not the lent one: it stays.
    const again = canvas.recordTry(() => undefined);
    preview.setToday("2026-03-01");
    again();
    expect(preview.today()).toBe("2026-03-01");
  });

  it("sends what a recording held back before it reads, and is undefined while Try it is off", async () => {
    const { canvas, events } = await recording();
    canvas.previewRuntime()!.setValue("full_name", "Ada");
    expect(events).toEqual([]);
    canvas.assertSnapshot();
    expect(events).toEqual([{ kind: "set", componentId: "full_name", path: "full_name", value: "Ada" }]);
    canvas.previewing = false;
    expect(canvas.assertSnapshot()).toBeUndefined();
  });
});
