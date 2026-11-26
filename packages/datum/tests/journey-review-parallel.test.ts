import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * A journey with a page of kind `review` asks for the Check
 * answers chunk while the journeys chunk is still on its way, not after it. The journeys chunk is
 * held here; the Check answers chunk must be imported all the same. A file of its own, because the
 * chunks load once per page and the neighbouring file needs them unloaded.
 */

const chunks = vi.hoisted(() => ({ reviewImports: 0, engineImports: 0, gate: undefined as Promise<void> | undefined }));
vi.mock("../src/journey-review-chunk.js", async (importActual) => {
  chunks.reviewImports += 1;
  return importActual();
});
vi.mock("../src/journey-engine-chunk.js", async (importActual) => {
  chunks.engineImports += 1;
  await chunks.gate;
  return importActual();
});

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import { EagerJourneyRenderKit, type FormDefinition } from "@argusvane/datum-engine";

import { until } from "./helpers.js";

const definition: FormDefinition = {
  id: "reviewing",
  version: "1.0.0",
  schemaVersion: "1",
  root: { id: "root", type: "form", configuration: { title: "Parallel" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } },
  journey: {
    journeys: [
      {
        id: "apply",
        pages: [
          { id: "first", title: "First page", components: ["name"] },
          { id: "check", kind: "review", title: "Check your answers" }
        ]
      }
    ]
  }
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<datum-form> fetches the Check answers chunk beside the journeys chunk", () => {
  it("asks for the Check answers chunk while the journeys chunk is held, then builds once both are in", async () => {
    let release!: () => void;
    chunks.gate = new Promise<void>((resolve) => (release = resolve));
    try {
      const element = document.createElement("datum-form") as DatumFormElement;
      element.definition = definition;
      document.body.append(element);
      await until(() => chunks.engineImports > 0);
      await until(() => chunks.reviewImports > 0);
      expect(element.runtime).toBeUndefined();
      release();
      await element.ready;
      expect(element.renderer!.journeyKit).toBe(EagerJourneyRenderKit);
    } finally {
      release();
    }
  });
});
