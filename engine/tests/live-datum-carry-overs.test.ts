// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createDatumGroupAdapter } from "../form-engine/render/live/datum/groups.js";
import { createDatumBinding, createDatumFeatures } from "../form-engine/render/live/renderer.js";
import type { LiveMountOptions } from "../form-engine/render/live/mount.js";
import { definitionOf, mounted, runtimeOf, settled, unmountAll, wrapper, type Mounted } from "./live-chrome-harness.js";

/*
 * What the Datum binding draws for forms with these needs, mounted the way
 * the element mounts it (the real binding and its feature list, as both `binding` and `datum`):
 * the labelled form root is named by the `<form>`, a tab takes its own component's label, the
 * kernel's containers have adapters, a read-only textarea is sized by one module, a date written
 * while a box composes is not lost, and Datum drawing as itself never reports a type of its own
 * as one it lacks.
 */

afterEach(unmountAll);

const text = (id: string, label = id.toUpperCase(), extra: Record<string, unknown> = {}) => ({ id, type: "text", configuration: { label, ...extra } });
const q = <T extends Element = HTMLElement>(scope: ParentNode, selector: string): T => scope.querySelector(selector) as T;

function warnings(): string[] {
  return (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => String(call[0]));
}

async function mountAsDatum(definition: FormDefinition, options: Partial<LiveMountOptions> & { runtime?: FormRuntime } = {}): Promise<Mounted> {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const binding = createDatumBinding();
  return mounted(definition, { binding, datum: binding, features: createDatumFeatures(), ...options, runtime: options.runtime ?? runtimeOf(definition) });
}

const rootConfiguration = (definition: FormDefinition, configuration: Record<string, unknown>): FormDefinition => {
  (definition.root as { configuration: Record<string, unknown> }).configuration = configuration;
  return definition;
};

describe("the form root's name", () => {
  it("names the <form> by the root's label, and draws the root as no group", async () => {
    const m = await mountAsDatum(rootConfiguration(definitionOf([text("name", "Name")] as never), { label: "Agent steps", description: "About this form" }));
    const form = q(m.root, "form");
    expect(form.getAttribute("aria-label")).toBe("Agent steps");
    expect(m.root.querySelector("fieldset, [role=group]")).toBeNull();
    expect(m.form.unsupported()).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it("names the form by a label the author hid, and by none the author did not give", async () => {
    const hidden = await mountAsDatum(rootConfiguration(definitionOf([text("name", "Name")] as never), { label: "Quiet title", hideLabel: true }));
    expect(q(hidden.root, "form").getAttribute("aria-label")).toBe("Quiet title");

    const bare = await mountAsDatum(definitionOf([text("name", "Name")] as never));
    expect(q(bare.root, "form").hasAttribute("aria-label")).toBe(false);
    const hintOnly = await mountAsDatum(rootConfiguration(definitionOf([text("name", "Name")] as never), { description: "About this form" }));
    expect(q(hintOnly.root, "form").hasAttribute("aria-label")).toBe(false);
  });

  it("keeps the frame beside the name, and takes the name away with the label", async () => {
    const definition = rootConfiguration(definitionOf([text("name", "Name")] as never), { label: "Agent steps", chrome: { frame: "outlined" } });
    const m = await mountAsDatum(definition);
    const form = q(m.root, "form");
    expect(form.getAttribute("aria-label")).toBe("Agent steps");
    expect(form.getAttribute("data-frame")).toBe("outlined");
    expect(form.className).toContain("datum-form--frame-outlined");
  });

  it("leaves the name to a root adapter that draws its own legend", async () => {
    const datum = createDatumBinding();
    const own = { ...datum, components: { ...datum.components, form: createDatumGroupAdapter() } };
    const definition = rootConfiguration(definitionOf([text("name", "Name")] as never), { label: "Agent steps" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const m = await mounted(definition, { binding: own, datum, features: createDatumFeatures(), runtime: runtimeOf(definition) });
    expect(q(m.root, "form").hasAttribute("aria-label")).toBe(false);
    expect(q(m.root, "legend").textContent).toBe("Agent steps");
  });
});

describe("a tab's own label", () => {
  const tabs = (descriptor: Record<string, unknown>, tab: Record<string, unknown>) => ({
    id: "t",
    type: "tabs",
    configuration: { label: "Sections", tabs: [{ id: "one", ...descriptor }] },
    children: { one: [{ id: "tab1", type: "tab", configuration: tab, children: { content: [text("n", "Name")] } }] }
  });
  const tabNames = (m: Mounted): string[] => Array.from(m.root.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim() ?? "");

  it("names a tab the descriptor leaves untitled by the tab component's label", async () => {
    expect(tabNames(await mountAsDatum(definitionOf([tabs({}, { label: "First" })] as never)))).toEqual(["First"]);
  });

  it("keeps the descriptor's label over the component's, and the place when neither has one", async () => {
    expect(tabNames(await mountAsDatum(definitionOf([tabs({ label: "Listed" }, { label: "First" })] as never)))).toEqual(["Listed"]);
    expect(tabNames(await mountAsDatum(definitionOf([tabs({}, {})] as never)))).toEqual(["Tab 1"]);
  });
});

describe("the kernel's containers", () => {
  const container = (type: string, id: string, label: string | undefined, children: unknown[]) => ({
    id,
    type,
    configuration: label === undefined ? {} : { label },
    children: { content: children }
  });

  it("draws a repeating section through Datum's group adapter, reporting nothing", async () => {
    const m = await mountAsDatum(definitionOf([container("repeatingSection", "rs", "Rows", [text("a", "A")])] as never));
    expect(m.form.unsupported()).toEqual([]);
    expect(warnings()).toEqual([]);
    expect(m.form.adapterOf("rs")).toMatchObject({ from: "binding", name: "datum-group" });
    // A named container is a fieldset named by its legend.
    expect(q(m.root, '[data-container-id="rs"] legend').textContent).toBe("Rows");
    expect(wrapper(m.root, "a")).not.toBeNull();
  });

  it("draws a container with no name as no element of its own", async () => {
    const m = await mountAsDatum(definitionOf([container("repeatingSection", "rs", undefined, [text("a", "A")])] as never));
    expect(m.root.querySelector('[data-container-id="rs"] fieldset')).toBeNull();
    expect(m.form.unsupported()).toEqual([]);
  });
});

describe("Datum drawing as itself", () => {
  it("reports no engine container type as one it lacks, whichever the form holds", async () => {
    const group = (type: string, id: string) => ({ id, type, configuration: { label: id }, children: { content: [text(`${id}_field`, `${id} field`)] } });
    const m = await mountAsDatum(
      definitionOf([
        group("fieldset", "fs"),
        group("container", "ct"),
        group("panel", "pn"),
        group("repeatingSection", "rs"),
        {
          id: "tabs1",
          type: "tabs",
          configuration: { tabs: [{ id: "a", label: "A" }] },
          children: { a: [{ id: "tab_a", type: "tab", configuration: { label: "A" }, children: { content: [text("in_tab", "In tab")] } }] }
        },
        { id: "bg", type: "button-group", configuration: {}, children: { content: [{ id: "go", type: "button", configuration: { label: "Go", action: "submit" } }] } }
      ] as never)
    );
    await settled(m.form);
    expect(warnings().filter((message) => message.includes("No adapter"))).toEqual([]);
    expect(m.form.unsupported()).toEqual([]);
    for (const id of ["fs_field", "rs_field", "in_tab"]) {
      expect(wrapper(m.root, id)).not.toBeNull();
    }
  });
});

describe("a read-only textarea's height", () => {
  it("is sized by one module: one observer and one measurement per box", async () => {
    const observers: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(readonly callback: ResizeObserverCallback) {}
        observe(element: Element): void {
          observers.push(element);
        }
        disconnect(): void {}
        unobserve(): void {}
      }
    );
    const reads = vi.fn(() => 120);
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: reads });
    try {
      const definition = definitionOf([{ id: "notes", type: "textarea", configuration: { label: "Notes", readOnly: true } }] as never);
      const runtime = runtimeOf(definition);
      runtime.setValue("notes", "one\ntwo\nthree");
      const m = await mountAsDatum(definition, { runtime });
      await settled(m.form);
      const box = q<HTMLTextAreaElement>(m.root, "textarea");
      expect(box.style.height).toBe("120px");
      expect(box.hasAttribute("data-readonly-sized")).toBe(true);
      expect(observers).toEqual([box]);
      const measured = reads.mock.calls.length;
      // A draw measures it once more, not twice (the adapter does not size it as well).
      runtime.setValue("notes", "one\ntwo\nthree\nfour");
      await settled(m.form);
      expect(reads.mock.calls.length - measured).toBeLessThanOrEqual(1);
      expect(observers).toEqual([box]);
    } finally {
      delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });
});

describe("a date written while a box composes", () => {
  const part = (m: Mounted, name: string): HTMLInputElement => wrapper(m.root, "born").querySelector(`[data-value-part="${name}"]`) as HTMLInputElement;
  const boxes = (m: Mounted): string[] => ["day", "month", "year"].map((name) => part(m, name).value);
  const fire = (box: HTMLElement, type: string): void => {
    box.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  };

  it("lands in the sibling boxes, and the composed day stays", async () => {
    const definition = definitionOf([{ id: "born", type: "date", configuration: { label: "Born" } }] as never);
    const m = await mountAsDatum(definition);
    const day = part(m, "day");
    day.focus();
    fire(day, "compositionstart");
    day.value = "12";
    fire(day, "input");
    m.runtime.setValue("born", "2026-05-06");
    await settled(m.form);
    // Nothing is written into the box that is composing.
    expect(boxes(m)).toEqual(["12", "", ""]);
    fire(day, "compositionend");
    fire(day, "input");
    await settled(m.form);
    expect(boxes(m)).toEqual(["12", "05", "2026"]);
    expect(m.runtime.state().values["born"]).toBe("2026-05-12");
  });

  it("keeps the boxes as they stand when only the person wrote", async () => {
    const definition = definitionOf([{ id: "born", type: "date", configuration: { label: "Born" } }] as never);
    const m = await mountAsDatum(definition);
    const day = part(m, "day");
    fire(day, "compositionstart");
    day.value = "7";
    fire(day, "input");
    fire(day, "compositionend");
    await settled(m.form);
    expect(boxes(m)).toEqual(["7", "", ""]);
    expect(m.runtime.state().values["born"]).toBeFalsy();
  });
});
