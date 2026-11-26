import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormElement, LiveBinding } from "../src/form.js";
import type { ComponentNode, FormDefinition } from "@argusvane/datum-engine";

import { createDatumBinding } from "../../../engine/form-engine/render/live/renderer.js";
import { until } from "./helpers.js";
import { box, control, summaryOf, type } from "./live-dom.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function definitionOf(content: ComponentNode[]): FormDefinition {
  return {
    id: "reveal-form",
    version: "1.0.0",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
    root: { id: "root", type: "form", configuration: {}, children: { content } }
  };
}

async function mount(content: ComponentNode[], binding?: LiveBinding): Promise<{ element: DatumFormElement; root: ShadowRoot }> {
  const element = document.createElement("datum-form") as DatumFormElement;
  if (binding !== undefined) {
    element.binding = binding;
  }
  element.definition = definitionOf(content);
  document.body.append(element);
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  return { element, root: element.renderer!.shadowRoot! };
}

/** The summary's link to a field: the one whose text names it. */
function summaryLink(root: ShadowRoot, label: string): HTMLAnchorElement | undefined {
  return [...(summaryOf(root)?.querySelectorAll("a") ?? [])].find((link) => link.textContent?.includes(label));
}

/** Waits for the draw the last write caused. */
const drawn = (element: DatumFormElement): Promise<unknown> => element.renderer!.painted();

const STEPS: ComponentNode[] = [
  {
    id: "journey",
    type: "steps",
    configuration: {},
    children: {
      content: [
        { id: "step_1", type: "step", configuration: { label: "Where do you live?" }, children: { content: [{ id: "postcode", type: "text", configuration: { label: "Postcode", required: true } }] } },
        { id: "step_2", type: "step", configuration: { label: "How can we contact you?" }, children: { content: [{ id: "phone", type: "text", configuration: { label: "Phone number", required: true } }] } }
      ]
    }
  }
];

const TABS: ComponentNode[] = [
  {
    id: "period",
    type: "tabs",
    configuration: { tabs: [{ id: "day", label: "Past day" }, { id: "week", label: "Past week" }] },
    children: {
      day: [{ id: "dayNote", type: "text", configuration: { label: "Day note" } }],
      week: [{ id: "weekNote", type: "text", configuration: { label: "Week note", required: true } }]
    }
  }
];

/**
 * A summary link, or the first error, sends a person to a field on a step or a tab the form is
 * not showing: that step or tab opens first and the field takes focus.
 */
describe("<datum-form> focus on a field the form is not showing", () => {
  it("opens the step a summary link's field is on, then focuses it", async () => {
    const { element, root } = await mount(STEPS);
    type(control(root, "postcode"), "SW1A 1AA");
    root.querySelector<HTMLElement>("[data-step-next]")!.click();
    const panel = (id: string) => root.querySelector<HTMLElement>(`[data-step-panel="${id}"]`)!;
    await until(() => panel("step_1").hidden && !panel("step_2").hidden);
    // The host's server finds the step-one answer wrong after all.
    element.setErrors([{ componentId: "postcode", code: "server", message: "Enter a real postcode" }]);
    await until(() => summaryLink(root, "Postcode"));
    summaryLink(root, "Postcode")!.click();
    await until(() => !panel("step_1").hidden && root.activeElement === control(root, "postcode"));
    expect(panel("step_2").hidden).toBe(true);
  });

  it("opens the tab a summary link's field is on, then focuses it", async () => {
    const { element, root } = await mount(TABS);
    const panel = (slot: string) => root.querySelector<HTMLElement>(`[data-tab-panel="${slot}"]`)!;
    await until(() => panel("week")?.hidden);
    element.setErrors([{ componentId: "weekNote", code: "required" }]);
    await until(() => summaryLink(root, "Week note"));
    summaryLink(root, "Week note")!.click();
    await until(() => !panel("week").hidden && root.activeElement === control(root, "weekNote"));
  });
});

describe("<datum-form> a file upload", () => {
  const FILE: ComponentNode[] = [{ id: "upload", type: "file", configuration: { label: "Upload a file", storage: "base64" } }];

  // The drag and press hooks (data-file-drop-status, data-file-button) are the renderer's behaviour for any
  // adapter that draws them; live-files.test.ts in the engine covers them with an adapter that does.
  it("marks no press or drag announcement under a binding whose face has neither hook", async () => {
    const { root } = await mount(FILE);
    expect(root.querySelector("[data-file-drop-status]")).toBeNull();
    const input = root.querySelector<HTMLInputElement>("input[type=file]")!;
    input.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true, clientX: 0, clientY: 0 }));
    expect(box(root, "upload").hasAttribute("data-file-press")).toBe(false);
  });
});

/**
 * A date drawn as parts (day / month / year inputs) holds no value until it is whole, so a repaint
 * another field's answer brings must not draw its boxes empty: the engine keeps what was typed.
 */
describe("<datum-form> a date typed in part", () => {
  {
    it("keeps the parts typed so far when another field repaints the form", async () => {
      const { element, root } = await mount(
        [
          { id: "dob", type: "date", configuration: { label: "Date of birth" } },
          { id: "name", type: "text", configuration: { label: "Full name" } }
        ]
      );
      const part = (name: string) => box(root, "dob").querySelector<HTMLInputElement>(`[data-value-part="${name}"]`);
      type(part("day")!, "12");
      type(part("month")!, "10");
      // Another field's answer repaints the form; the date is still incomplete.
      type(control(root, "name"), "Sarah Philips");
      await until(() => element.values.name === "Sarah Philips");
      await drawn(element);
      expect(part("day")!.value).toBe("12");
      expect(part("month")!.value).toBe("10");
      expect(part("year")!.value).toBe("");
      // Finished, the date is the store's; emptied, nothing comes back.
      type(part("year")!, "1980");
      await until(() => (element.values as Record<string, unknown>).dob === "1980-10-12");
      for (const name of ["day", "month", "year"]) type(part(name)!, "");
      type(control(root, "name"), "Sarah");
      await until(() => element.values.name === "Sarah");
      await drawn(element);
      expect(part("day")!.value).toBe("");
      expect(part("month")!.value).toBe("");
    });

    it("keeps the year as typed, key by key, while each keystroke completes the date", async () => {
      const { element, root } = await mount([{ id: "dob", type: "date", configuration: { label: "Date of birth" } }]);
      const part = (name: string) => box(root, "dob").querySelector<HTMLInputElement>(`[data-value-part="${name}"]`)!;
      type(part("day"), "27");
      type(part("month"), "3");
      // Each digit of the year completes the date ("2" is stored as 0002-03-27) and repaints; the
      // box being typed in keeps what was typed, never the stored, padded year.
      part("year").focus();
      let typed = "";
      for (const key of "2007") {
        typed += key;
        const year = part("year");
        year.value = typed;
        year.setSelectionRange(typed.length, typed.length);
        year.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        await until(() => (element.values as Record<string, unknown>).dob === `${typed.padStart(4, "0")}-03-27`);
        await drawn(element);
        expect(part("year").value).toBe(typed);
        expect(part("year")).toBe(year);
      }
      expect((element.values as Record<string, unknown>).dob).toBe("2007-03-27");
    });

    it("keeps a text month it cannot read through a repaint, beside its error", async () => {
      const { element, root } = await mount(
        [
          { id: "dob", type: "date", configuration: { label: "Date of birth" } },
          { id: "name", type: "text", configuration: { label: "Full name" } }
        ]
      );
      const part = (name: string) => box(root, "dob").querySelector<HTMLInputElement>(`[data-value-part="${name}"]`);
      type(part("day")!, "12");
      type(part("month")!, "Fbz");
      type(part("year")!, "2026");
      await until(() => (element.values as Record<string, unknown>).dob === "2026-Fbz-12");
      // The store's "2026-Fbz-12" (not a real date) draws no boxes back; what was typed does.
      type(control(root, "name"), "Sarah Philips");
      await until(() => element.values.name === "Sarah Philips");
      await drawn(element);
      expect(part("day")!.value).toBe("12");
      expect(part("month")!.value).toBe("Fbz");
      expect(part("year")!.value).toBe("2026");
      // Put right, the date is the store's again.
      type(part("month")!, "2");
      await until(() => (element.values as Record<string, unknown>).dob === "2026-02-12");
      type(control(root, "name"), "Sarah");
      await until(() => element.values.name === "Sarah");
      await drawn(element);
      // The box keeps the month as the person typed it, beside the stored "02".
      expect(part("month")!.value).toBe("2");
    });

    it("stores a month typed as its name as its number, and a grouped number as a number", async () => {
      const { element, root } = await mount(
        [
          { id: "dob", type: "date", configuration: { label: "Date of birth" } },
          { id: "income", type: "number", configuration: { label: "Income" } }
        ]
      );
      const part = (name: string) => box(root, "dob").querySelector<HTMLInputElement>(`[data-value-part="${name}"]`);
      type(part("day")!, "12");
      type(part("month")!, "Feb");
      type(part("year")!, "2026");
      // Only the strict format is stored; validation never sees the name.
      await until(() => (element.values as Record<string, unknown>).dob === "2026-02-12");
      type(control(root, "income"), "1,250,000");
      await until(() => (element.values as Record<string, unknown>).income === 1250000);
      // What it cannot read stays as typed, for validation to call not a number.
      type(control(root, "income"), "12 kg");
      await until(() => (element.values as Record<string, unknown>).income === "12 kg");
    });
  }
});

describe("<datum-form> a number box holding text the browser cannot read", () => {
  it("keeps the box, and what was typed in it, across the repaints that follow", async () => {
    const { element, root } = await mount(
      [
        { id: "count", type: "number", configuration: { label: "How many?" } },
        { id: "name", type: "text", configuration: { label: "Full name" } }
      ],
      // The native number box is a binding's choice; Datum draws text.
      createDatumBinding({ controls: { number: "number" } })
    );
    // jsdom cannot hold "1e" in a number box: the box reports what Chrome reports for it, an
    // empty value with `validity.badInput`.
    const native = control(root, "count");
    Object.defineProperty(native, "validity", { configurable: true, value: { badInput: true } });
    native.value = "";
    native.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    native.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    // Another field's answer repaints the form: the number box is the same element, not a copy.
    type(control(root, "name"), "Sarah");
    await until(() => element.values.name === "Sarah");
    await drawn(element);
    expect(control(root, "count")).toBe(native);
  });
});
