// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { definitionOf, quiet, unmountAll } from "./live-chrome-harness.js";
import { mountDatum } from "./live-datum-kit.js";

/*
 * The browser's own number and date boxes carry the bounds validation enforces and no others: a
 * bound that is no number or no real date, or a minimum above the maximum, is no bound to
 * validation, so the box gets none either. A configured step is written on the number box.
 */

afterEach(unmountAll);

const attributesOf = async (type: "number" | "date", configuration: Record<string, unknown>): Promise<Record<string, string | null>> => {
  quiet();
  const definition = definitionOf([{ id: "f", type, configuration: { label: "Field", ...configuration } }] as never);
  const m = await mountDatum(definition, type === "number" ? { fields: { controls: { number: "number" } } } : { date: { control: "native" } });
  const box = m.root.querySelector("input") as HTMLInputElement;
  return { min: box.getAttribute("min"), max: box.getAttribute("max"), step: box.getAttribute("step") };
};

describe("native boxes: the bounds validation enforces", () => {
  it("writes a number's readable bounds and its step", async () => {
    expect(await attributesOf("number", { min: 1, max: "10", step: 0.5 })).toEqual({ min: "1", max: "10", step: "0.5" });
  });

  it("writes no bounds for an inverted pair on a number", async () => {
    expect(await attributesOf("number", { min: 10, max: 1 })).toEqual({ min: null, max: null, step: null });
  });

  it("writes no step that is not a positive number", async () => {
    expect((await attributesOf("number", { step: 0 })).step).toBeNull();
    expect((await attributesOf("number", { step: "any" })).step).toBeNull();
  });

  it("writes a date's real-date bounds only", async () => {
    expect(await attributesOf("date", { min: "2020-01-01", max: "2030-12-31" })).toEqual({ min: "2020-01-01", max: "2030-12-31", step: null });
    expect(await attributesOf("date", { min: "today", max: "2030-02-31" })).toEqual({ min: null, max: null, step: null });
  });

  it("writes no bounds for an inverted pair on a date", async () => {
    expect(await attributesOf("date", { min: "2030-01-01", max: "2020-01-01" })).toEqual({ min: null, max: null, step: null });
  });
});
