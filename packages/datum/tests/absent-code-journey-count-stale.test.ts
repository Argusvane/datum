import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The Journeys tab's problem count after a failed check: a count that an earlier
 * check worked out is cleared when a later one cannot run, so the badge never shows a number that
 * no longer describes the definition. Its own file because it stands in for the diagnostics.
 */
const checks = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/journey-diagnostics.ts", () => ({
  diagnoseJourneys: () => {
    checks.calls += 1;
    if (checks.calls > 1) {
      throw new Error("diagnostics failed");
    }
    return [{ severity: "error", journeyId: "apply", code: "x", message: "m" }];
  }
}));

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the journey problem count after a check that cannot run", { timeout: 20000 }, () => {
  it("clears the earlier count rather than keeping it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.setAttribute("pdf", "off");
    element.definition = { ...sampleDefinition(), journey: { journeys: [{ id: "apply", name: "Apply online", pages: [{ id: "p1", components: ["fullName"] }] }] } } as FormDefinition;
    document.body.append(element);
    await until(() => element.journeyMode !== undefined);
    // The first check works: one error is counted on the tab.
    element.controller!.addAfter("text", "fullName");
    await until(() => element.builder?.workspaceProblems.journeys === 1, 5000);
    // The next one throws: the number is gone, the badge draws nothing.
    element.controller!.addAfter("text", "fullName");
    await until(() => checks.calls >= 2, 5000);
    await until(() => element.builder?.workspaceProblems.journeys === undefined, 5000);
    expect(element.builder!.workspaceProblems).not.toHaveProperty("journeys");
  });
});
