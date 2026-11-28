import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { ComponentNode, FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The inspector wired to its model: Number's
 * Minimum and Maximum through the kept-live number box, what holds Apply back under its box,
 * the advice under Label and the calculated hint, the tab a new selection
 * opens on, Escape putting the footer back, the delete confirmation's references
 * and Enter in Label.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function definition(): FormDefinition {
  const base = sampleDefinition();
  base.root.children!.content!.splice(
    4,
    0,
    { id: "age", type: "number", configuration: { label: "Age" } },
    { id: "total", type: "number", configuration: { label: "Total" }, rules: { value: "1 + 1" } }
  );
  return base;
}

async function mount(form: FormDefinition = definition()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = form;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const inspectorEl = (element: DatumFormBuilderElement) =>
  shell(element).querySelector("datum-builder-properties")! as HTMLElement & { inspectorTab: string };
const inspector = (element: DatumFormBuilderElement): ShadowRoot => inspectorEl(element).shadowRoot!;
const canvas = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
const box = (element: DatumFormBuilderElement, path: string): HTMLInputElement =>
  inspector(element).querySelector<HTMLInputElement>(`input[data-prop="${path}"]`)!;
const apply = (element: DatumFormBuilderElement): HTMLButtonElement => inspector(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!;
const configOf = (element: DatumFormBuilderElement, id: string): Record<string, unknown> =>
  (element.builder!.controller.snapshot().children!.content!.find((node: ComponentNode) => node.id === id)!.configuration ?? {}) as Record<string, unknown>;

async function select(element: DatumFormBuilderElement, id: string): Promise<void> {
  element.builder!.controller.select(id);
  await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === id);
}

/** One keystroke's worth of text in a box, as the browser reports it. */
function keystroke(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function press(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
}

/** Counts the paints of every builder panel but the inspector, by their prototypes' `render`. */
function countOtherPaints(element: DatumFormBuilderElement): { count: () => number; restore: () => void } {
  const panels = [...shell(element).querySelectorAll("*")].filter(
    (node) => node.tagName.toLowerCase().startsWith("datum-builder-") && node.tagName.toLowerCase() !== "datum-builder-properties"
  );
  const protos = [...new Set(panels.map((panel) => Object.getPrototypeOf(panel) as { render?: () => void }))].filter(
    (proto) => typeof proto.render === "function"
  );
  let count = 0;
  const originals = protos.map((proto) => {
    const own = Object.prototype.hasOwnProperty.call(proto, "render");
    const original = proto.render!;
    proto.render = function (this: unknown) {
      count += 1;
      return original.call(this);
    };
    return { proto, own, original };
  });
  return {
    count: () => count,
    restore: () => {
      for (const entry of originals) {
        if (entry.own) {
          entry.proto.render = entry.original;
        } else {
          delete entry.proto.render;
        }
      }
    }
  };
}

describe("Number's Minimum and Maximum", () => {
  it("draws both boxes, keeps the live box through the paints a bound makes, and Escape shows the fresh copy", async () => {
    const element = await mount();
    await select(element, "age");
    const min = box(element, "min");
    expect(min.type).toBe("number");
    expect(box(element, "max").type).toBe("number");
    min.focus();
    keystroke(min, "5");
    keystroke(min, "50");
    const max = box(element, "max");
    max.focus();
    // "1" is below 50: the message comes, the panel paints, and the box typed in is the one kept.
    for (const text of ["1", "12", "123"]) {
      keystroke(max, text);
      expect(box(element, "max")).toBe(max);
      expect(inspector(element).activeElement).toBe(max);
    }
    expect(max.value).toBe("123");
    expect(element.builder!.controller.draftProperty("age", "max")).toBe(123);
    expect(element.builder!.controller.draftProperty("age", "min")).toBe(50);
    expect(apply(element).disabled).toBe(false);
    press(max, "Escape");
    // The draft is gone; the box now shows what the form holds (nothing), in the fresh copy.
    expect(element.builder!.controller.hasPendingChanges("age")).toBe(false);
    expect(box(element, "max").value).toBe("");
    expect(box(element, "min").value).toBe("");
    expect(inspector(element).querySelector("[data-not-applied]")).toBeNull();
  });

  it("stores a bound at min / max, and an emptied box drops the key at Apply", async () => {
    const form = definition();
    (form.root.children!.content!.find((node) => node.id === "age")!.configuration as Record<string, unknown>).min = 5;
    const element = await mount(form);
    await select(element, "age");
    expect(box(element, "min").value).toBe("5");
    keystroke(box(element, "max"), "9");
    apply(element).click();
    expect(configOf(element, "age")).toMatchObject({ min: 5, max: 9 });
    keystroke(box(element, "min"), "");
    apply(element).click();
    const stored = JSON.parse(JSON.stringify(configOf(element, "age"))) as Record<string, unknown>;
    expect("min" in stored).toBe(false);
    expect(stored.max).toBe(9);
  });
});

describe("what holds Apply back", () => {
  it("disables Apply for a Pattern that is no regular expression, says why under the box, and frees it once mended", async () => {
    const element = await mount();
    await select(element, "email");
    const others = countOtherPaints(element);
    try {
      const pattern = box(element, "pattern");
      pattern.focus();
      keystroke(pattern, "(");
      const message = inspector(element).querySelector<HTMLElement>("#problem-pattern")!;
      expect(message.textContent).toContain("not a valid regular expression");
      expect(message.closest(".property-row")).toBe(box(element, "pattern").closest(".property-row"));
      expect(box(element, "pattern").getAttribute("aria-invalid")).toBe("true");
      expect(box(element, "pattern").getAttribute("aria-describedby")).toContain("problem-pattern");
      expect(apply(element).disabled).toBe(true);
      // Discard stays, and the line above the buttons leads to the box.
      expect(inspector(element).querySelector<HTMLButtonElement>("[data-inspector-cancel]")!.disabled).toBe(false);
      expect(inspector(element).querySelector("[data-inspector-problems]")!.textContent).toContain("Pattern");
      // Enter does not apply it either: it goes to the box.
      press(box(element, "pattern"), "Enter");
      expect(element.builder!.controller.hasPendingChanges("email")).toBe(true);
      expect(configOf(element, "email").pattern).toBeUndefined();
      keystroke(box(element, "pattern"), "(a)");
      expect(inspector(element).querySelector("#problem-pattern")).toBeNull();
      expect(box(element, "pattern").hasAttribute("aria-invalid")).toBe(false);
      expect(apply(element).disabled).toBe(false);
      expect(inspector(element).activeElement).toBe(box(element, "pattern"));
      // Every keystroke was a live write: no other panel painted.
      expect(others.count()).toBe(0);
    } finally {
      others.restore();
    }
  });

  it("disables Apply for a Number's minimum above its maximum, under the Maximum box, until it is fixed", async () => {
    const element = await mount();
    await select(element, "age");
    keystroke(box(element, "min"), "10");
    keystroke(box(element, "max"), "5");
    const message = inspector(element).querySelector<HTMLElement>("#problem-max")!;
    expect(message.textContent).toContain("minimum is above the maximum");
    expect(message.closest(".property-row")).toBe(box(element, "max").closest(".property-row"));
    expect(box(element, "max").getAttribute("aria-invalid")).toBe("true");
    expect(apply(element).disabled).toBe(true);
    keystroke(box(element, "max"), "10");
    expect(inspector(element).querySelector("#problem-max")).toBeNull();
    expect(apply(element).disabled).toBe(false);
    apply(element).click();
    expect(configOf(element, "age")).toMatchObject({ min: 10, max: 10 });
  });
});

describe("advice under Label and the calculated hint", () => {
  it("warns under Label for an empty or untitled label without holding Apply or counting a problem", async () => {
    const element = await mount();
    await select(element, "email");
    const label = (): HTMLInputElement => box(element, "label");
    label().focus();
    keystroke(label(), "");
    const note = inspector(element).querySelector<HTMLElement>('[data-note="label"]')!;
    expect(note.textContent).toContain("has no label");
    expect(label().getAttribute("aria-describedby")).toContain(note.id);
    expect(label().hasAttribute("aria-invalid")).toBe(false);
    expect(inspector(element).querySelector("[data-inspector-problems]")).toBeNull();
    expect(apply(element).disabled).toBe(false);
    keystroke(label(), "Untitled field");
    expect(inspector(element).querySelector('[data-note="label"]')!.textContent).toBe("Give this field a label");
    keystroke(label(), "Email address");
    expect(inspector(element).querySelector('[data-note="label"]')).toBeNull();
    expect(inspector(element).activeElement).toBe(label());
  });

  it("says once, above the sections, that a rule calculates the answer", async () => {
    const element = await mount();
    await select(element, "total");
    const hints = [...inspector(element).querySelectorAll<HTMLElement>("[data-inspector-hint]")];
    expect(hints.map((hint) => hint.textContent)).toEqual(["Calculated by a rule - read-only to the filler"]);
    await select(element, "age");
    expect(inspector(element).querySelector("[data-inspector-hint]")).toBeNull();
  });
});

describe("the tab another component opens on", () => {
  it("opens another component on the Field tab, and keeps the tab for the same one", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    await select(element, "email");
    inspector(element).querySelector<HTMLElement>('[data-inspector-tab="json"]')!.click();
    expect(inspectorEl(element).inspectorTab).toBe("json");
    await select(element, "fullName");
    expect(inspectorEl(element).inspectorTab).toBe("properties");
    inspector(element).querySelector<HTMLElement>('[data-inspector-tab="json"]')!.click();
    // An edit, then the same component again, and the same after nothing was selected for a moment.
    controller.setDraftProperty("fullName", "placeholder", "Ada");
    controller.commitDraft("fullName");
    controller.select("fullName");
    expect(inspectorEl(element).inspectorTab).toBe("json");
    controller.select(undefined);
    controller.select("fullName");
    await until(() => inspector(element).querySelector("[data-json-view]"));
    expect(inspectorEl(element).inspectorTab).toBe("json");
    // The Rules tab asked for the new selection (the Logic workspace's way) is kept for it.
    controller.select("email");
    inspectorEl(element).inspectorTab = "rules";
    expect(inspectorEl(element).inspectorTab).toBe("rules");
    controller.select("email");
    expect(inspectorEl(element).inspectorTab).toBe("rules");
  });
});

describe("Escape and Discard put the footer back", () => {
  it("Escape in a box typed in live leaves no Not applied and a disabled Apply", async () => {
    const element = await mount();
    await select(element, "email");
    const label = box(element, "label");
    label.focus();
    keystroke(label, "Emailx");
    expect(inspector(element).querySelector("[data-not-applied]")).not.toBeNull();
    expect(apply(element).disabled).toBe(false);
    press(label, "Escape");
    expect(element.builder!.controller.hasPendingChanges("email")).toBe(false);
    expect(box(element, "label").value).toBe("Email");
    expect(inspector(element).querySelector("[data-not-applied]")).toBeNull();
    expect(apply(element).disabled).toBe(true);
    expect(inspector(element).querySelector<HTMLButtonElement>("[data-inspector-cancel]")!.disabled).toBe(true);
  });

  it("Discard pressed straight after typing does the same", async () => {
    const element = await mount();
    await select(element, "email");
    const label = box(element, "label");
    label.focus();
    keystroke(label, "Emailx");
    inspector(element).querySelector<HTMLButtonElement>("[data-inspector-cancel]")!.click();
    expect(element.builder!.controller.hasPendingChanges("email")).toBe(false);
    expect(box(element, "label").value).toBe("Email");
    expect(inspector(element).querySelector("[data-not-applied]")).toBeNull();
    expect(apply(element).disabled).toBe(true);
  });

  it("typing in Label paints no other panel", async () => {
    const element = await mount();
    await select(element, "email");
    const others = countOtherPaints(element);
    try {
      const label = box(element, "label");
      label.focus();
      for (const text of ["E", "Em", "Ema", ""]) {
        keystroke(label, text);
      }
      expect(others.count()).toBe(0);
      // The counter counts: leaving the box is one plain change, which the canvas draws. (The
      // empty label's warning repainted the inspector, so the box is the one drawn now.)
      box(element, "label").dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
      expect(others.count()).toBeGreaterThan(0);
    } finally {
      others.restore();
    }
  });
});

describe("the delete confirmation's references", () => {
  it("lists what reads the component, and Also remove references takes them in one undo step", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    await select(element, "subscribe");
    inspector(element).querySelector<HTMLButtonElement>("[data-inspector-delete]")!.click();
    const dialog = inspector(element).querySelector<HTMLElement>("[data-delete-prompt]")!;
    const lines = [...dialog.querySelectorAll<HTMLElement>("[data-confirm-dependents] li")].map((line) => line.textContent);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Email");
    expect(dialog.textContent).toContain("1 other place uses it");
    const also = dialog.querySelector<HTMLInputElement>("input[data-confirm-also-remove]")!;
    expect(also.checked).toBe(false);
    also.checked = true;
    dialog.querySelector<HTMLButtonElement>("[data-confirm-delete]")!.click();
    const content = (): ComponentNode[] => controller.snapshot().children!.content!;
    expect(content().some((node) => node.id === "subscribe")).toBe(false);
    expect(content().find((node) => node.id === "email")!.rules?.visibleWhen).toBeUndefined();
    controller.undo();
    expect(content().some((node) => node.id === "subscribe")).toBe(true);
    expect(content().find((node) => node.id === "email")!.rules).toEqual({ visibleWhen: "subscribe" });
  });

  it("leaves the references when the box stays unticked, and draws the plain dialog for a component nothing reads", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    await select(element, "age");
    inspector(element).querySelector<HTMLButtonElement>("[data-inspector-delete]")!.click();
    expect(inspector(element).querySelector("[data-confirm-dependents]")).toBeNull();
    expect(inspector(element).querySelector("input[data-confirm-also-remove]")).toBeNull();
    inspector(element).querySelector<HTMLButtonElement>("[data-confirm-cancel]")!.click();
    await select(element, "subscribe");
    inspector(element).querySelector<HTMLButtonElement>("[data-inspector-delete]")!.click();
    inspector(element).querySelector<HTMLButtonElement>("[data-confirm-delete]")!.click();
    const content = controller.snapshot().children!.content!;
    expect(content.some((node) => node.id === "subscribe")).toBe(false);
    expect(content.find((node) => node.id === "email")!.rules).toEqual({ visibleWhen: "subscribe" });
  });

  it("does the same from the canvas's own confirmation", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    controller.select("subscribe");
    await until(() => canvas(element).querySelector('[data-selection-action="delete"]'));
    canvas(element).querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
    const dialog = canvas(element).querySelector<HTMLElement>("[data-delete-prompt]")!;
    expect(dialog.querySelectorAll("[data-confirm-dependents] li")).toHaveLength(1);
    dialog.querySelector<HTMLInputElement>("input[data-confirm-also-remove]")!.checked = true;
    dialog.querySelector<HTMLButtonElement>("[data-confirm-delete]")!.click();
    const content = (): ComponentNode[] => controller.snapshot().children!.content!;
    expect(content().some((node) => node.id === "subscribe")).toBe(false);
    expect(content().find((node) => node.id === "email")!.rules?.visibleWhen).toBeUndefined();
    controller.undo();
    expect(content().some((node) => node.id === "subscribe")).toBe(true);
    expect(content().find((node) => node.id === "email")!.rules).toEqual({ visibleWhen: "subscribe" });
  });
});

describe("Enter in Label", () => {
  it("applies and moves on to the next control, never the box's ?", async () => {
    const element = await mount();
    await select(element, "email");
    const label = box(element, "label");
    label.focus();
    keystroke(label, "Email address");
    press(label, "Enter");
    expect(configOf(element, "email").label).toBe("Email address");
    const active = inspector(element).activeElement as HTMLElement | null;
    expect(active).not.toBeNull();
    expect(active).not.toBe(box(element, "label"));
    expect(active!.classList.contains("property-help-toggle")).toBe(false);
    expect(active!.matches("input, select, textarea, button")).toBe(true);
    // The control right after Label in the panel, as drawn.
    const controls = [...inspector(element).querySelectorAll<HTMLElement>(".inspector-body input, .inspector-body select, .inspector-body textarea, .inspector-body button")].filter(
      (control) => !control.classList.contains("property-help-toggle") && !(control as HTMLButtonElement).disabled
    );
    expect(controls[controls.indexOf(box(element, "label")) + 1]).toBe(active);
  });
});
