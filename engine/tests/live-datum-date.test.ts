// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatumDateAdapter, normalizeDatePartOrder, parseIsoDateParts } from "../form-engine/render/live/datum/date.js";
import { createNumberAdapter, createTextAdapter } from "../form-engine/render/live/datum/text-fields.js";
import { resolveFieldOptions } from "../form-engine/render/live/datum/field-scaffold.js";
import { createBinding, definitionOf, runtimeOf, settled, quiet, unmountAll, wrapper } from "./live-chrome-harness.js";
import { alertsOf, controlFacts, groupFacts, mountDatum, textOf, type ControlFacts } from "./live-datum-kit.js";

/*
 * Datum's date (render/live/datum/date.ts) and number (text-fields.ts), drawn through mountLive with
 * the Datum adapters and read as a person or a screen reader meets them: the controls with their
 * names, ids, descriptions and states. The date's seams (the parts' order,
 * the month control, the field order, the controls) each change the drawn tree.
 */

afterEach(unmountAll);

const dateField = (configuration: Record<string, unknown> = {}) => ({
  id: "born",
  type: "date",
  configuration: { label: "Date of birth", description: "For example, 7 3 2024", required: true, ...configuration }
});
/** A text-like box as a screen reader meets it: `facts` over a box with nothing set. */
const box = (facts: Partial<ControlFacts>): ControlFacts => ({
  tag: "input",
  type: "text",
  id: null,
  name: "",
  describedBy: [],
  describedText: [],
  invalid: "false",
  required: null,
  disabled: false,
  readOnly: false,
  value: "",
  min: null,
  max: null,
  inputMode: null,
  autocomplete: null,
  ...facts
});
const form = (...children: Array<ReturnType<typeof dateField> | Record<string, unknown>>) => definitionOf(children as never);

const part = (root: ShadowRoot, name: string): HTMLInputElement => wrapper(root, "born").querySelector(`[data-value-part="${name}"]`) as HTMLInputElement;
const typeIn = (element: HTMLInputElement, value: string): void => {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
};
const change = (element: HTMLElement): void => {
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
};

describe("date: the browser's own box", () => {
  it("draws the browser's date box with its bounds, name, description and states", async () => {
    quiet();
    const definition = form(dateField({ min: "2020-01-01", max: "2030-12-31" }));
    const runtime = runtimeOf(definition);
    runtime.setValue("born", "2024-03-07");
    const m = await mountDatum(definition, { runtime, date: { control: "native" } });
    const native = { type: "date", id: "born", name: "Date of birth *", required: "true", min: "2020-01-01", max: "2030-12-31" };
    expect(controlFacts(m.root)).toEqual([box({ ...native, describedBy: ["born__description"], describedText: ["For example, 7 3 2024"], value: "2024-03-07" })]);
    await runtime.validate();
    runtime.setValue("born", "");
    await runtime.validate();
    await settled(m.form);
    expect(controlFacts(m.root)).toEqual([
      box({ ...native, describedBy: ["born__description", "born__error"], describedText: ["For example, 7 3 2024", "This field is required"], invalid: "true" })
    ]);
    expect(alertsOf(m.root)).toEqual(["This field is required"]);
  });

  it("reports the whole answer as the box is typed in, and settles it when the box is left", async () => {
    quiet();
    const m = await mountDatum(form(dateField()), { date: { control: "native" } });
    const box = m.root.querySelector("input") as HTMLInputElement;
    typeIn(box, "2024-03-07");
    await settled(m.form);
    expect(m.runtime.state().values["born"]).toBe("2024-03-07");
    expect(m.root.querySelector('[data-value-part]')).toBeNull();
  });
});

describe("date: three boxes", () => {
  it("draws a group named by its legend and described by the hint, around one named box per part", async () => {
    quiet();
    const definition = form(dateField());
    const runtime = runtimeOf(definition);
    runtime.setValue("born", "2024-03-07");
    const m = await mountDatum(definition, { runtime });
    expect(controlFacts(m.root)).toEqual([
      box({ id: "born__day", name: "Day", value: "07", inputMode: "numeric" }),
      box({ id: "born__month", name: "Month", value: "03", inputMode: "numeric" }),
      box({ id: "born__year", name: "Year", value: "2024", inputMode: "numeric" })
    ]);
    expect(groupFacts(m.root)).toEqual([{ legend: "Date of birth *", name: "Date of birth *", describedBy: ["born__description"], describedText: ["For example, 7 3 2024"], invalid: "false" }]);
    expect(controlFacts(m.root).map((c) => [c.id, c.name, c.value, c.inputMode])).toEqual([
      ["born__day", "Day", "07", "numeric"],
      ["born__month", "Month", "03", "numeric"],
      ["born__year", "Year", "2024", "numeric"]
    ]);
    // The legend names the group with the required mark; the description is the group's.
    expect(groupFacts(m.root)[0]).toMatchObject({ legend: "Date of birth *", describedText: ["For example, 7 3 2024"] });
  });

  it("draws an error with the group invalid, each part described by the message, one alert", async () => {
    quiet();
    const runtime = runtimeOf(form(dateField()));
    const m = await mountDatum(form(dateField()), { runtime });
    await runtime.validate();
    await settled(m.form);
    const errored = { describedBy: ["born__error"], describedText: ["This field is required"], invalid: "true", inputMode: "numeric" };
    expect(controlFacts(m.root)).toEqual([box({ ...errored, id: "born__day", name: "Day" }), box({ ...errored, id: "born__month", name: "Month" }), box({ ...errored, id: "born__year", name: "Year" })]);
    expect(groupFacts(m.root)).toEqual([
      { legend: "Date of birth *", name: "Date of birth *", describedBy: ["born__description", "born__error"], describedText: ["For example, 7 3 2024", "This field is required"], invalid: "true" }
    ]);
    expect(alertsOf(m.root)).toEqual(["This field is required"]);
    expect(controlFacts(m.root).every((c) => c.invalid === "true" && c.describedBy.includes("born__error"))).toBe(true);
    // The renderer's hooks, not the adapter's.
    const hooks = wrapper(m.root, "born");
    expect(hooks.getAttribute("data-kind")).toBe("date");
    expect(hooks.hasAttribute("data-invalid")).toBe(true);
    expect(hooks.hasAttribute("data-required")).toBe(true);
  });

  it("hides the legend visually when the author hid it and keeps the group named", async () => {
    quiet();
    const m = await mountDatum(form(dateField({ hideLabel: true })));
    expect(m.root.querySelector("legend")?.className).toContain("datum-form__visually-hidden");
    expect(groupFacts(m.root)[0]?.legend).toBe("Date of birth *");
  });

  it("names the group by its words and describes it by the help bubble when it has a tooltip", async () => {
    quiet();
    const m = await mountDatum(form(dateField({ tooltip: "As on your passport" })));
    const fieldset = m.root.querySelector("fieldset") as HTMLElement;
    expect(fieldset.getAttribute("aria-labelledby")).toBe("born__label");
    // The bubble follows the description, as it does on every field.
    expect(fieldset.getAttribute("aria-describedby")).toBe("born__description born__tooltip");
    expect(m.root.querySelector("[data-tooltip]")).not.toBeNull();
    expect(m.root.getElementById("born__label")?.textContent).toBe("Date of birth *");
  });
});

describe("date: the seams", () => {
  it("draws the parts in the order the locale gives, and a select of month names for the month", async () => {
    quiet();
    const order = (locale: string) => (locale === "en" ? (["month", "day", "year"] as const) : (["day", "month", "year"] as const));
    const m = await mountDatum(form(dateField()), { date: { order, month: "select", monthLabel: "numbered", sizes: { year: 5 }, partClass: (name) => `width-${name}`, autocomplete: "bday", partHints: true } });
    const runtime = m.runtime;
    runtime.setValue("born", "2024-03-07");
    await settled(m.form);
    const ids = controlFacts(m.root).map((c) => c.id);
    expect(ids).toEqual(["born__month", "born__day", "born__year"]);
    const month = m.root.querySelector("select") as HTMLSelectElement;
    expect(month.value).toBe("03");
    expect(Array.from(month.options).map((o) => o.textContent).slice(0, 3)).toEqual(["Select a month", "01 - January", "02 - February"]);
    expect(month.getAttribute("autocomplete")).toBe("bday-month");
    expect(part(m.root, "year").getAttribute("size")).toBe("5");
    expect(m.root.querySelector(".width-day")).not.toBeNull();
    // A hint of its own for each part, described before any error.
    expect(part(m.root, "day").getAttribute("aria-describedby")).toBe("born__day-hint");
  });

  it("keeps the month select on the stored month after the person has picked", async () => {
    quiet();
    const m = await mountDatum(form(dateField()), { date: { month: "select" } });
    const month = m.root.querySelector("select") as HTMLSelectElement;
    for (const value of ["03", "04"]) {
      month.value = value;
      month.dispatchEvent(new Event("change", { bubbles: true }));
      await settled(m.form);
    }
    expect(month.value).toBe("04");
    m.runtime.setValue("born", "2020-03-15");
    await settled(m.form);
    expect(part(m.root, "day").value).toBe("15");
    expect((m.root.querySelector("select") as HTMLSelectElement).value).toBe("03");
    m.runtime.setValue("born", "2021-12-01");
    await settled(m.form);
    expect((m.root.querySelector("select") as HTMLSelectElement).value).toBe("12");
  });

  it("gives the date's group the field id, so the summary link has a target", async () => {
    quiet();
    const m = await mountDatum(form(dateField()));
    const target = m.root.querySelector("#born");
    expect(target?.tagName).toBe("FIELDSET");
    expect(target?.contains(part(m.root, "day"))).toBe(true);
  });

  it("follows the field order the binding gives, and puts a group's error under its legend when asked", async () => {
    quiet();
    const m = await mountDatum(form(dateField()), { fields: { fieldOrder: ["label", "control", "description", "error"], controls: { groupError: "afterLegend" } } });
    await m.runtime.validate();
    await settled(m.form);
    const fieldset = m.root.querySelector("fieldset") as HTMLElement;
    const kinds = Array.from(fieldset.children).map((child) => child.className.split(" ")[0] || child.tagName.toLowerCase());
    // afterLegend: label, error, control, description.
    expect(kinds).toEqual(["datum-form__label", "datum-form__error", "datum-form__date-parts", "datum-form__description"]);
  });

  it("carries the ARIA states as the design system's controls say", async () => {
    quiet();
    const withControls = async (controls: Record<string, string>) => {
      const m = await mountDatum(form(dateField()), { fields: { controls } });
      await m.runtime.validate();
      await settled(m.form);
      return m;
    };
    const marked = await withControls({});
    expect(marked.root.querySelector("fieldset")?.getAttribute("aria-invalid")).toBe("true");
    expect(controlFacts(marked.root)[0]).toMatchObject({ invalid: "true", describedBy: ["born__error"] });

    // USWDS: each part described by the message, nothing marked invalid, the group described by nothing.
    const required = await withControls({ ariaStates: "required" });
    expect(required.root.querySelector("fieldset")?.hasAttribute("aria-invalid")).toBe(false);
    expect(required.root.querySelector("fieldset")?.hasAttribute("aria-describedby")).toBe(false);
    expect(controlFacts(required.root)[0]).toMatchObject({ invalid: null, describedBy: ["born__error"] });

    // GOV.UK: the group alone described, no part carries a state.
    const none = await withControls({ ariaStates: "none" });
    expect(none.root.querySelector("fieldset")?.hasAttribute("aria-invalid")).toBe(false);
    expect(none.root.querySelector("fieldset")?.getAttribute("aria-describedby")).toContain("born__error");
    expect(controlFacts(none.root)[0]).toMatchObject({ invalid: null, describedBy: [] });

    const plain = await withControls({ inlineErrors: "plain", groupDescription: "none" });
    expect(alertsOf(plain.root)).toEqual([]);
    expect(plain.root.querySelector("fieldset")?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("normalizes a declared order and reads a stored date", () => {
    expect(normalizeDatePartOrder(["year", "month", "day"])).toEqual(["year", "month", "day"]);
    expect(normalizeDatePartOrder(["year", "month"])).toEqual(["day", "month", "year"]);
    expect(normalizeDatePartOrder(["year", "year", "day", "month", "x"])).toEqual(["year", "day", "month"]);
    expect(parseIsoDateParts("2024-03-07")).toEqual({ year: "2024", month: "03", day: "07" });
    expect(parseIsoDateParts("soon")).toEqual({ year: "", month: "", day: "" });
  });
});

describe("date: the writes", () => {
  it("composes the answer from the parts, keeps a date typed in part, and checks the field only when it is left", async () => {
    quiet();
    const m = await mountDatum(form(dateField()));
    const check = vi.spyOn(m.runtime, "validatePath");
    typeIn(part(m.root, "day"), "7");
    await settled(m.form);
    // Typed in part: the box keeps what was typed, nothing is stored yet.
    expect(part(m.root, "day").value).toBe("7");
    expect(m.runtime.state().values["born"]).toBeFalsy();
    typeIn(part(m.root, "month"), "3");
    typeIn(part(m.root, "year"), "2024");
    await settled(m.form);
    expect(m.runtime.state().values["born"]).toBe("2024-03-07");
    expect(part(m.root, "day").value).toBe("7");

    // Moving between the parts leaves nothing; leaving the group does.
    const day = part(m.root, "day");
    const month = part(m.root, "month");
    change(day);
    day.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: month }));
    expect(check).not.toHaveBeenCalled();
    month.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: null }));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("blanks the boxes when the host writes the answer they compose to, a half-typed date cleared included", async () => {
    quiet();
    const m = await mountDatum(form(dateField({ required: false })));
    typeIn(part(m.root, "day"), "12");
    await settled(m.form);
    expect(part(m.root, "day").value).toBe("12");
    // The host clears the field: the empty answer is what the boxes already compose to, yet it replaces what was typed.
    m.runtime.setValue("born", "");
    await settled(m.form);
    m.form.redraw();
    await settled(m.form);
    expect(["day", "month", "year"].map((name) => part(m.root, name).value)).toEqual(["", "", ""]);
    // The person's own typing is not the host's: it keeps its boxes.
    typeIn(part(m.root, "day"), "5");
    await settled(m.form);
    expect(part(m.root, "day").value).toBe("5");
  });

  it("sends focus to the first part the date still lacks, in the order drawn", async () => {
    quiet();
    const order = ["month", "day", "year"] as const;
    const m = await mountDatum(form(dateField()), { date: { order } });
    expect(m.form.focusField("born")).toBe(true);
    expect(m.root.activeElement).toBe(part(m.root, "month"));
    typeIn(part(m.root, "month"), "3");
    await settled(m.form);
    expect(m.form.focusField("born")).toBe(true);
    expect(m.root.activeElement).toBe(part(m.root, "day"));
    typeIn(part(m.root, "day"), "7");
    await settled(m.form);
    expect(m.form.focusField("born")).toBe(true);
    expect(m.root.activeElement).toBe(part(m.root, "year"));
  });

  it("takes nothing in a review: every part read-only but focusable, the month select refused, a write dropped", async () => {
    quiet();
    const definition = form(dateField());
    const runtime = runtimeOf(definition);
    runtime.setValue("born", "2024-03-07");
    const m = await mountDatum(definition, { runtime, mode: "readonly", date: { month: "select" } });
    // Read-only is never disabled: the boxes are readonly, the select is aria-readonly.
    expect(controlFacts(m.root).every((c) => !c.disabled)).toBe(true);
    expect(controlFacts(m.root).filter((c) => c.tag === "input").every((c) => c.readOnly)).toBe(true);
    const month = part(m.root, "month") as unknown as HTMLSelectElement;
    expect(month.getAttribute("aria-readonly")).toBe("true");
    const key = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    month.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    part(m.root, "day").focus();
    expect(m.root.activeElement).toBe(part(m.root, "day"));
    typeIn(part(m.root, "day"), "9");
    await settled(m.form);
    expect(runtime.state().values["born"]).toBe("2024-03-07");
    expect(part(m.root, "day").value).toBe("07");
  });

  it("disables every part only for a disabled date", async () => {
    quiet();
    const definition = form(dateField({ disabled: true }));
    const m = await mountDatum(definition, { runtime: runtimeOf(definition), date: { month: "select" } });
    expect(controlFacts(m.root).every((c) => c.disabled)).toBe(true);
    expect((part(m.root, "month") as unknown as HTMLSelectElement).hasAttribute("aria-readonly")).toBe(false);
  });
});

// ── Number ────────────────────────────────────────────────────────────────────────────────

const numberField = (configuration: Record<string, unknown> = {}) => ({
  id: "qty",
  type: "number",
  configuration: { label: "Quantity", description: "How many", required: true, min: 1, max: 10, ...configuration }
});

describe("number: the composed DOM", () => {
  it("draws a number as a number box and as a text box, named, described and bounded", async () => {
    quiet();
    const definition = definitionOf([numberField({ prefix: "#", suffix: "units", placeholder: "1" })] as never);
    const runtime = runtimeOf(definition);
    runtime.setValue("qty", 4);
    const m = await mountDatum(definition, { runtime, fields: { controls: { number: "number" } } });
    const quantity = { id: "qty", name: "Quantity *", describedBy: ["qty__description"], describedText: ["How many"], required: "true", value: "4" };
    expect(controlFacts(m.root)).toEqual([box({ ...quantity, type: "number", min: "1", max: "10" })]);
    expect(Array.from(m.root.querySelectorAll(".datum-form__affix")).map((a) => a.textContent)).toEqual(["#", "units"]);
    expect(wrapper(m.root, "qty").getAttribute("data-kind")).toBe("number");

    // Datum's own number is the text box (the binding's `controls.number`): the default.
    const textBox = await mountDatum(definition, { runtime });
    expect(controlFacts(textBox.root)).toEqual([box({ ...quantity, inputMode: "decimal" })]);
    expect(controlFacts(textBox.root)[0]).toMatchObject({ type: "text", inputMode: "decimal", min: null, max: null });
  });

  it("describes an invalid number by its error and marks it invalid, one alert", async () => {
    quiet();
    const definition = definitionOf([numberField()] as never);
    const runtime = runtimeOf(definition);
    const m = await mountDatum(definition, { runtime, fields: { controls: { number: "number" } } });
    await runtime.validate();
    await settled(m.form);
    expect(controlFacts(m.root)).toEqual([
      box({ type: "number", id: "qty", name: "Quantity *", describedBy: ["qty__description", "qty__error"], describedText: ["How many", "This field is required"], invalid: "true", required: "true", min: "1", max: "10" })
    ]);
    expect(alertsOf(m.root)).toEqual(["This field is required"]);
    expect(textOf(m.root.querySelector("label"))).toContain("Quantity");
  });

  it("is drawn by the shared adapters a design-system binding falls back to", () => {
    const options = resolveFieldOptions(undefined);
    expect(createNumberAdapter(options).kind).toBe("field");
    expect(createTextAdapter(options).kind).toBe("field");
    expect(createDatumDateAdapter().capabilities).toMatchObject({ tooltip: "drawn", notice: "drawn" });
    expect(createBinding).toBeTypeOf("function");
  });
});
