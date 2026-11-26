// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { defineDatumFormRendererElement, DATUM_FORM_RENDERER_TAG, type DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/**
 * The print pipeline is a chunk the renderer loads on the first `print()`, as the PDF service is.
 * A host may deploy without it: the print rejects with a message that names the file, `name`
 * "ChunkLoadError", and the failure is not cached, so the next print asks again.
 */
const pipeline = vi.hoisted(() => ({ present: false, loads: 0, presented: 0 }));

vi.mock("../form-engine/render/web-component/print-pipeline.js", () => {
  pipeline.loads += 1;
  if (!pipeline.present) {
    throw new Error("Failed to fetch dynamically imported module");
  }
  return {
    readPrintSource: async () => ({}),
    preparePrint: () => ({ html: "<p>printed</p>", theme: { id: "basic" } }),
    basicPrintTheme: { id: "basic" },
    presentPrintDocument: async () => {
      pipeline.presented += 1;
      return { frame: undefined };
    }
  };
});

afterEach(() => {
  document.body.innerHTML = "";
});

function runtime(): FormRuntime {
  const definition = {
    id: "f",
    version: "1",
    root: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }
  };
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition as never, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

describe("the renderer without its print pipeline chunk", () => {
  it("rejects as a ChunkLoadError naming the file, and asks again on the next print", async () => {
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    element.runtime = runtime();
    document.body.append(element);

    const first = (await element.print().then(
      () => undefined,
      (error: unknown) => error
    )) as (Error & { cause?: unknown }) | undefined;
    expect(first).toBeInstanceOf(Error);
    if (!first) {
      return;
    }
    expect(first.name).toBe("ChunkLoadError");
    expect(first.message).toMatch(/^The print pipeline \(datum-form-print-pipeline-\*\.js\) could not be loaded: /);
    expect(first.cause).toBeInstanceOf(Error);
    expect(pipeline.presented).toBe(0);
    const loadsAfterFirst = pipeline.loads;

    // The file comes back (a redeploy, a network that recovered): the next print loads it and prints.
    pipeline.present = true;
    await element.print();
    expect(pipeline.loads).toBeGreaterThan(loadsAfterFirst);
    expect(pipeline.presented).toBe(1);
  });
});
