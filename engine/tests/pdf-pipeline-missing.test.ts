// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { defineDatumFormRendererElement, DATUM_FORM_RENDERER_TAG, type DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/**
 * The PDF service is a chunk the renderer loads on the first PDF. A host may deploy
 * without it: the PDF rejects with a message that names the
 * file, `name` "ChunkLoadError" for a host element to recognise, and the failure is not cached,
 * so the next PDF asks again.
 */
const service = vi.hoisted(() => ({ present: false, loads: 0 }));

vi.mock("../form-engine/render/pdf/pdf-service.js", () => {
  service.loads += 1;
  if (!service.present) {
    throw new Error("Failed to fetch dynamically imported module");
  }
  return { renderFormPdf: async () => ({ bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }) };
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

describe("the renderer without its PDF service chunk", () => {
  it("rejects as a ChunkLoadError naming the file, and asks again on the next PDF", async () => {
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    element.runtime = runtime();
    element.pdfProvider = {} as never;
    document.body.append(element);

    const first = (await element.renderPdf().then(
      () => undefined,
      (error: unknown) => error
    )) as (Error & { cause?: unknown }) | undefined;
    expect(first).toBeInstanceOf(Error);
    if (!first) {
      return;
    }
    expect(first.name).toBe("ChunkLoadError");
    expect(first.message).toMatch(/^The PDF service \(datum-form-pdf-service-\*\.js\) could not be loaded: /);
    expect(first.cause).toBeInstanceOf(Error);
    const loadsAfterFirst = service.loads;

    // The file comes back (a redeploy, a network that recovered): the next PDF is made.
    service.present = true;
    const result = await element.renderPdf();
    expect(service.loads).toBeGreaterThan(loadsAfterFirst);
    expect(result?.bytes).toBeInstanceOf(Uint8Array);
  });
});
