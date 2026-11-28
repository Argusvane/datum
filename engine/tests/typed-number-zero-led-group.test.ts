import { describe, expect, it } from "vitest";

import { coerceAnswer } from "../form-engine/agent/answers/index.js";
import type { RenderComponentModel } from "../form-engine/render/core/component-model.js";
import { readTypedNumber } from "../form-engine/render/web-component/typed-answers.js";

/*
 * A first group of digits led by a zero ("0,500", "00,500", "0.500" in German) is never a
 * grouping: the text is kept as typed, so validation names it, rather than read as 500.
 */

describe("a number typed with a first group led by a zero", () => {
  it("is not read as a grouped number", () => {
    expect(readTypedNumber("0,500", "en")).toBeUndefined();
    expect(readTypedNumber("0,001", "en")).toBeUndefined();
    expect(readTypedNumber("00,500", "en")).toBeUndefined();
    expect(readTypedNumber("000,000", "en")).toBeUndefined();
    expect(readTypedNumber("-0,500", "en")).toBeUndefined();
    expect(readTypedNumber("0 500", "en")).toBeUndefined();
    expect(readTypedNumber("0 500", "fr")).toBeUndefined();
    expect(readTypedNumber("0.500", "de")).toBeUndefined();
    expect(readTypedNumber("0.250", "es")).toBeUndefined();
    expect(readTypedNumber("0.500,5", "de")).toBeUndefined();
  });

  it("leaves a lone zero, a fraction and a real grouping read as before", () => {
    expect(readTypedNumber("0", "en")).toBe(0);
    expect(readTypedNumber("0.5", "en")).toBe(0.5);
    expect(readTypedNumber("0.500", "en")).toBe(0.5);
    expect(readTypedNumber("0,5", "de")).toBe(0.5);
    expect(readTypedNumber("0,500", "de")).toBe(0.5);
    expect(readTypedNumber("1,500", "en")).toBe(1500);
    expect(readTypedNumber("10,500", "en")).toBe(10500);
    expect(readTypedNumber("1.500", "de")).toBe(1500);
    expect(readTypedNumber("100 500", "fr")).toBe(100500);
  });

  it("is refused by an agent's answer write, naming what was typed", () => {
    const model = {} as RenderComponentModel;
    const options = { locale: "en", acceptsFreeText: false };
    const refused = coerceAnswer(model, "number", "0,500", "amount", options);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? undefined : refused.problem).toMatchObject({ path: "amount", got: "0,500" });
    expect(coerceAnswer(model, "number", "1,500", "amount", options)).toEqual({ ok: true, value: 1500, coerced: true });
  });
});
