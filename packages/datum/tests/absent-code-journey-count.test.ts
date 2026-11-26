import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The Journeys tab's problem count: when the diagnostics chunk will not load the
 * badge stays absent, but the host hears of it, once however many changes follow. Its own file
 * because the diagnostics loader memoises a success for the page's life.
 */
const gone = vi.hoisted(() => ({ fail: 1, asked: 0 }));
vi.mock("../src/journey-diagnostics.ts", async (importOriginal) => {
  gone.asked += 1;
  if (gone.fail > 0) {
    gone.fail -= 1;
    throw new Error("journey diagnostics chunk gone");
  }
  return importOriginal();
});

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the journey problem count's diagnostics are missing", { timeout: 20000 }, () => {
  it("tells the host once, however many changes follow, and counts again when the chunk is back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const element = document.createElement("datum-form-builder");
    element.setAttribute("pdf", "off");
    element.definition = { ...sampleDefinition(), journey: { journeys: [{ id: "apply", name: "Apply online", pages: [{ id: "p1", components: ["fullName"] }] }] } } as FormDefinition;
    const errors: Array<{ message: string; cause: unknown }> = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string; cause: unknown }>).detail));
    document.body.append(element as DatumFormBuilderElement);
    await until(() => (element as DatumFormBuilderElement).journeyMode !== undefined);
    // Any change schedules the count; the first one finds the chunk gone.
    element.controller!.addAfter("text", "fullName");
    await until(() => errors.some((entry) => entry.message.includes("problem count")), 5000);
    expect(errors.filter((entry) => entry.message.includes("problem count"))).toHaveLength(1);
    expect(errors.find((entry) => entry.message.includes("problem count"))!.cause).toBeInstanceOf(Error);
    // The chunk is back for the next change (forgotten, not cached): counted, and no second report.
    element.controller!.addAfter("text", "fullName");
    await until(() => gone.asked >= 2, 5000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(errors.filter((entry) => entry.message.includes("problem count"))).toHaveLength(1);
  });
});
