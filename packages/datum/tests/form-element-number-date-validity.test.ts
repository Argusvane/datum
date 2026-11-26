import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormElement, LiveBinding } from "../src/form.js";
import type { ComponentNode, FormDefinition, FormError } from "@argusvane/datum-engine";

import { createDatumBinding } from "../../../engine/form-engine/render/live/renderer.js";
import { until } from "./helpers.js";
import { box, control, describedBy, type } from "./live-dom.js";

/**
 * In the element: what a number box or a date drawn as parts writes, and what the
 * form then says about it. A native number box cleared stores the empty answer (not 0), and one
 * holding text the browser cannot read says `number`; a date typed in part says
 * `dateIncomplete`, naming what is missing, in place of `required`.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function definitionOf(content: ComponentNode[]): FormDefinition {
  return {
    id: "validity-form",
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

function on(errors: readonly FormError[], componentId: string): FormError[] {
  return errors.filter((error) => error.componentId === componentId);
}

/** Datum draws a number as a text box; the native box is a binding's choice. */
const NATIVE_NUMBERS: LiveBinding = createDatumBinding({ controls: { number: "number" } });

const AGE: ComponentNode = { id: "age", type: "number", configuration: { label: "Age", required: true } };
const DOB: ComponentNode = { id: "dob", type: "date", configuration: { label: "Date of birth", required: true } };
const NAME: ComponentNode = { id: "name", type: "text", configuration: { label: "Full name" } };

describe("<datum-form> a native number box", () => {
  it("stores the empty answer when cleared, so Required still fires once it was filled", async () => {
    const { element, root } = await mount([AGE], NATIVE_NUMBERS);
    const age = (): HTMLInputElement => control(root, "age");
    expect(age().type).toBe("number");
    type(age(), "42");
    await until(() => element.values.age === 42);
    // Cleared: the empty answer is stored, not Number("") (0), so Required still fires.
    type(age(), "");
    await until(() => element.values.age === "");
    const errors = await element.validate({ focus: false });
    expect(on(errors, "age").map((error) => error.code)).toEqual(["required"]);
  });

  it("says number, not required, for text the browser cannot read, and forgets it once a number is typed", async () => {
    const { element, root } = await mount([AGE], NATIVE_NUMBERS);
    const age = (): HTMLInputElement => control(root, "age");
    type(age(), "5");
    await until(() => element.values.age === 5);
    // What Chrome reports for "1e": an empty value, marked bad input.
    const native = age();
    // As Chrome has it: unreadable text reads as "", and a number typed over it clears the flag.
    // The box itself survives the repaints that follow (it holds what no property can).
    Object.defineProperty(native, "validity", { configurable: true, get: () => ({ badInput: native.value === "" }) });
    type(native, "");
    await until(() => element.values.age === "");
    expect(element.runtime?.inputState("age")).toEqual({ badInput: true });
    const errors = await element.validate({ focus: false });
    expect(on(errors, "age").map((error) => [error.code, error.parameters])).toEqual([["number", { badInput: true }]]);
    await until(() => box(root, "age").hasAttribute("data-invalid") && describedBy(age()).includes("Enter a number"));

    type(age(), "7");
    await until(() => element.values.age === 7);
    expect(element.runtime?.inputState("age")).toBeUndefined();
    expect(on(await element.validate({ focus: false }), "age")).toEqual([]);
  });

  it("forgets what the box said once the host writes the answer, the empty one included", async () => {
    const { element, root } = await mount([{ id: "age", type: "number", configuration: { label: "Age" } }], NATIVE_NUMBERS);
    const native = control(root, "age");
    Object.defineProperty(native, "validity", { configurable: true, get: () => ({ badInput: true }) });
    type(native, "");
    // The box's own write keeps its word.
    expect(element.runtime?.inputState("age")).toEqual({ badInput: true });
    expect(on(await element.validate({ focus: false }), "age").map((error) => error.code)).toEqual(["number"]);
    // The host clears the field: its write replaces what the box said.
    element.runtime!.setValue("age", "");
    expect(element.runtime?.inputState("age")).toBeUndefined();
    expect(on(await element.validate({ focus: false }), "age")).toEqual([]);
  });
});

describe("<datum-form> a text box drawn for a number", () => {
  it("keeps text that is not a number as typed, and the form says so in the engine's words", async () => {
    const { element, root } = await mount([AGE]);
    const age = (): HTMLInputElement => control(root, "age");
    expect(age().type).toBe("text");
    type(age(), "abc");
    await until(() => element.values.age === "abc");
    const errors = await element.validate({ focus: false });
    expect(on(errors, "age").map((error) => error.code)).toEqual(["number"]);
    await until(() => box(root, "age").hasAttribute("data-invalid") && describedBy(age()).includes("Enter a number"));
    // A number typed as one is stored as one, and passes.
    type(age(), "12");
    await until(() => element.values.age === 12);
    expect(on(await element.validate({ focus: false }), "age")).toEqual([]);
  });
});

describe("<datum-form> a date drawn as parts", () => {
  const part = (root: ShadowRoot, name: string): HTMLInputElement => box(root, "dob").querySelector<HTMLInputElement>(`[data-value-part="${name}"]`)!;

  it("says date for a day the month does not have", async () => {
    const { element, root } = await mount([DOB]);
    type(part(root, "day"), "31");
    type(part(root, "month"), "2");
    type(part(root, "year"), "2026");
    await until(() => element.values.dob === "2026-02-31");
    const errors = await element.validate({ focus: false });
    expect(on(errors, "dob").map((error) => error.code)).toEqual(["date"]);
    // A real date passes.
    type(part(root, "day"), "28");
    await until(() => element.values.dob === "2026-02-28");
    expect(on(await element.validate({ focus: false }), "dob")).toEqual([]);
  });

  it("says dateIncomplete, naming the parts left, in place of required — and completing the date clears it", async () => {
    const { element, root } = await mount([DOB, NAME]);
    type(part(root, "day"), "12");
    expect(element.runtime?.inputState("dob")).toEqual({ incomplete: { missing: ["month", "year"] } });
    type(part(root, "month"), "10");
    expect(element.values.dob ?? "").toBe("");
    expect(element.runtime?.inputState("dob")).toEqual({ incomplete: { missing: ["year"] } });
    const errors = await element.validate({ focus: false });
    expect(on(errors, "dob").map((error) => [error.code, error.parameters])).toEqual([
      ["dateIncomplete", { missing: "year", missingKey: "year", missingParts: ["year"] }]
    ]);

    // Another field's answer repaints the form: the parts typed are still there, and so is the state.
    type(control(root, "name"), "Sarah Philips");
    await until(() => element.values.name === "Sarah Philips");
    expect(part(root, "day").value).toBe("12");
    expect(part(root, "month").value).toBe("10");
    expect(on(await element.validate({ focus: false }), "dob").map((error) => error.code)).toEqual(["dateIncomplete"]);

    // Finished: the date is the store's, and nothing is missing.
    type(part(root, "year"), "1980");
    await until(() => element.values.dob === "1980-10-12");
    expect(element.runtime?.inputState("dob")).toBeUndefined();
    expect(on(await element.validate({ focus: false }), "dob")).toEqual([]);

    // Emptied part by part: two parts left is incomplete, all three is simply empty — required.
    type(part(root, "year"), "");
    // The date's own write of the empty answer keeps what it says: the state follows the write.
    await until(() => (element.values.dob ?? "") === "");
    expect(element.runtime?.inputState("dob")).toEqual({ incomplete: { missing: ["year"] } });
    type(part(root, "month"), "");
    await until(() => (element.values.dob ?? "") === "");
    expect(on(await element.validate({ focus: false }), "dob").map((error) => [error.code, error.parameters?.missingKey])).toEqual([
      ["dateIncomplete", "month-year"]
    ]);
    type(part(root, "day"), "");
    expect(element.runtime?.inputState("dob")).toBeUndefined();
    expect(on(await element.validate({ focus: false }), "dob").map((error) => error.code)).toEqual(["required"]);
  });

  it("an optional date: its own partial write says dateIncomplete, and a host clearing the field replaces it", async () => {
    const optional: ComponentNode = { id: "dob", type: "date", configuration: { label: "Date of birth" } };
    const { element, root } = await mount([optional, NAME]);
    type(part(root, "day"), "12");
    expect(element.runtime?.inputState("dob")).toEqual({ incomplete: { missing: ["month", "year"] } });
    expect(on(await element.validate({ focus: false }), "dob").map((error) => [error.code, error.parameters?.missingKey])).toEqual([
      ["dateIncomplete", "month-year"]
    ]);

    // The host writes the empty answer: the boxes blank on the next paint, and nothing is said.
    element.runtime!.setValue("dob", "");
    expect(element.runtime?.inputState("dob")).toBeUndefined();
    type(control(root, "name"), "Sarah Philips");
    await until(() => element.values.name === "Sarah Philips");
    await until(() => ["day", "month", "year"].every((name) => part(root, name).value === ""));
    expect(on(await element.validate({ focus: false }), "dob")).toEqual([]);
    // And the form sends: nothing holds the submission back.
    const sent = await element.submit();
    expect(sent.accepted).toBe(true);
  });
});
