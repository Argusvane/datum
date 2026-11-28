// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_VALIDATION_MESSAGES, ENGINE_VALIDATION_CODES, resolveValidationMessage } from "../form-engine/core/localization/validation-messages.js";
import { datePartsFocusTarget } from "../form-engine/render/live/datum/date.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { kernelFormTestOpEngineCodes, kernelFormTestOpMessagesEn } from "../form-engine/validation/wasm/portable-kernel.js";
import { definitionOf, runtimeOf, settled, quiet, unmountAll, wrapper } from "./live-chrome-harness.js";
import { alertsOf, mountDatum } from "./live-datum-kit.js";

/*
 * A date's year typed in fewer than four digits ("24") is no year: the runtime composes no answer
 * from it (nothing padded to 0024 is stored), records that the year was short, and validation asks
 * for four digits (`date.year`) in place of `required`, or of nothing on an optional date. A year
 * typed in four digits, leading zeros included, is taken as typed.
 */

afterEach(unmountAll);

const born = (configuration: Record<string, unknown> = {}) =>
  definitionOf([{ id: "born", type: "date", configuration: { label: "Date of birth", ...configuration } }] as never);

describe("a date's year typed short", () => {
  it("stores nothing and records the short year, for one to three digits", () => {
    for (const year of ["2", "24", "987"]) {
      const runtime = runtimeOf(born());
      expect(runtime.setDateParts("born", { year, month: "3", day: "5" })).toBe("");
      expect(runtime.state().values["born"] ?? "").toBe("");
      expect(runtime.inputState("born")).toEqual({ shortYear: true });
    }
  });

  it("takes four digits as typed, and forgets the short year once the year is whole", () => {
    const runtime = runtimeOf(born());
    runtime.setDateParts("born", { year: "24", month: "3", day: "5" });
    expect(runtime.setDateParts("born", { year: "2024", month: "3", day: "5" })).toBe("2024-03-05");
    expect(runtime.inputState("born")).toBeUndefined();
    expect(runtime.setDateParts("born", { year: "0024", month: "3", day: "5" })).toBe("0024-03-05");
    expect(runtime.inputState("born")).toBeUndefined();
  });

  it("says the parts still missing before it says the year is short", () => {
    const runtime = runtimeOf(born());
    runtime.setDateParts("born", { year: "24", month: "3", day: "" });
    expect(runtime.inputState("born")).toEqual({ incomplete: { missing: ["day"] } });
  });

  it("raises date.year in place of required, and on an optional date, through the stage", async () => {
    for (const required of [true, false]) {
      const definition = born({ required });
      const stage = createFieldConstraintsStage(definition.root);
      const result = await stage.validate({ formId: "f", values: { born: "" }, locale: "en", inputStates: { born: { shortYear: true } } });
      expect(result.errors.map((error) => error.code)).toEqual(["date.year"]);
    }
  });

  it("is told through the runtime's validation, and the server hears only the empty answer", async () => {
    const runtime = runtimeOf(born({ required: true }));
    runtime.setDateParts("born", { year: "24", month: "3", day: "5" });
    expect((await runtime.validate()).map((error) => error.code)).toEqual(["date.year"]);
    runtime.setDateParts("born", { year: "2024", month: "3", day: "5" });
    expect(await runtime.validate()).toEqual([]);
  });

  it("is an engine code worded in English, the same on the kernel's side", () => {
    expect(ENGINE_VALIDATION_CODES.find((entry) => entry.code === "date.year")).toEqual({ code: "date.year", label: "A date's year is not four digits", parameters: [] });
    expect(DEFAULT_VALIDATION_MESSAGES["date.year"]).toBe("Enter the year in four digits");
    expect(resolveValidationMessage({ code: "date.year" }, undefined, "en")).toBe("Enter the year in four digits");
    expect(kernelFormTestOpMessagesEn()["date.year"]).toBe("Enter the year in four digits");
    expect(kernelFormTestOpEngineCodes()).toContain("date.year");
  });
});

describe("a date's year typed short, in Datum's three boxes", () => {
  const part = (root: ShadowRoot, name: string): HTMLInputElement => wrapper(root, "born").querySelector(`[data-value-part="${name}"]`) as HTMLInputElement;
  const typeIn = (element: HTMLInputElement, value: string): void => {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };

  it("keeps the year as typed, stores nothing, and asks for four digits", async () => {
    quiet();
    const m = await mountDatum(born());
    typeIn(part(m.root, "day"), "5");
    typeIn(part(m.root, "month"), "3");
    typeIn(part(m.root, "year"), "24");
    await settled(m.form);
    expect(m.runtime.state().values["born"] ?? "").toBe("");
    expect(part(m.root, "year").value).toBe("24");
    await m.runtime.validate();
    await settled(m.form);
    expect(alertsOf(m.root)).toEqual(["Enter the year in four digits"]);
    // Focus goes to the year, the part to fix.
    expect(datePartsFocusTarget(wrapper(m.root, "born"))?.dataset.valuePart).toBe("year");
    typeIn(part(m.root, "year"), "2024");
    await settled(m.form);
    expect(m.runtime.state().values["born"]).toBe("2024-03-05");
    await m.runtime.validate();
    await settled(m.form);
    expect(alertsOf(m.root)).toEqual([]);
  });
});
