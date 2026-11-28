// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { dateAutocomplete } from "../form-engine/render/live/datum/date.js";
import { definitionOf, quiet, unmountAll } from "./live-chrome-harness.js";
import { mountDatum } from "./live-datum-kit.js";

/*
 * The `autocomplete` a Datum date writes: each part completes with the token's stem and its
 * suffix ("bday" gives "bday-day"), "off" and "on" are written as they are, a token already
 * naming a part is not suffixed twice, and the browser's date box carries the stem.
 */

afterEach(unmountAll);

const tokensDrawn = async (autocomplete: string, control: "parts" | "native", month?: "select"): Promise<Array<string | null>> => {
  quiet();
  const definition = definitionOf([{ id: "born", type: "date", configuration: { label: "Date of birth", autocomplete } }] as never);
  const m = await mountDatum(definition, { date: { control, ...(month ? { month } : {}) } });
  return Array.from(m.root.querySelectorAll("input, select")).map((element) => element.getAttribute("autocomplete"));
};

describe("date: autocomplete tokens", () => {
  it("writes off and on unchanged on every part", async () => {
    expect(await tokensDrawn("off", "parts")).toEqual(["off", "off", "off"]);
    expect(await tokensDrawn("on", "parts", "select")).toEqual(["on", "on", "on"]);
  });

  it("suffixes a token's stem once, whether or not it already names a part", async () => {
    expect(await tokensDrawn("bday", "parts")).toEqual(["bday-day", "bday-month", "bday-year"]);
    expect(await tokensDrawn("bday-day", "parts")).toEqual(["bday-day", "bday-month", "bday-year"]);
    expect(await tokensDrawn("section-a shipping bday", "parts")).toEqual(["section-a shipping bday-day", "section-a shipping bday-month", "section-a shipping bday-year"]);
  });

  it("writes the stem on the browser's date box", async () => {
    expect(await tokensDrawn("bday", "native")).toEqual(["bday"]);
    expect(await tokensDrawn("bday-year", "native")).toEqual(["bday"]);
    expect(await tokensDrawn("off", "native")).toEqual(["off"]);
  });

  it("reads a blank token as none", () => {
    expect(dateAutocomplete(undefined, "day")).toBeUndefined();
    expect(dateAutocomplete("  ", "day")).toBeUndefined();
  });
});
