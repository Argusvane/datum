// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { PRINT_FRAME_ATTR } from "../form-engine/render/web-component/print-frame.js";
import {
  DATUM_FORM_RENDERER_TAG,
  defineDatumFormRendererElement,
  type DatumFormRendererElement
} from "../form-engine/render/web-component/form-renderer-element.js";

/*
 * A print that is no longer wanted opens no dialog: one whose element left the page before it
 * was presented, and one a newer print() superseded while its frame waited for its fonts (a
 * print theme without a self-check asks `datum-print` before the frame, so only the token checked
 * after the wait stops the dialog).
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const frames = (): HTMLIFrameElement[] => [...document.querySelectorAll<HTMLIFrameElement>(`iframe[${PRINT_FRAME_ATTR}]`)];

function runtimeOf(): FormRuntime {
  const form = {
    id: "intake",
    version: "1",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }] },
    root: { id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }
  } as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

async function mounted(): Promise<DatumFormRendererElement> {
  defineDatumFormRendererElement();
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  element.runtime = runtimeOf();
  document.body.append(element);
  await element.painted();
  return element;
}

/** Stubs each new frame's print(); `fontsMs` makes the frame's fonts take that long to be ready. */
function stubFramePrint(printed: () => void, fontsMs?: number): () => void {
  const observer = new MutationObserver(() => {
    for (const frame of frames()) {
      const marked = frame as HTMLIFrameElement & { stubbed?: boolean };
      if (frame.contentWindow && !marked.stubbed) {
        marked.stubbed = true;
        frame.contentWindow.print = printed;
        if (fontsMs !== undefined) {
          Object.defineProperty(frame.contentDocument!, "fonts", { value: { ready: new Promise((done) => setTimeout(done, fontsMs)) } });
        }
      }
    }
  });
  observer.observe(document.body, { childList: true });
  return () => observer.disconnect();
}

describe("a print no longer wanted", () => {
  it("opens no dialog, dispatches no datum-print and leaves no frame when the element leaves the page in the same task", async () => {
    const element = await mounted();
    const printed = vi.fn();
    const seen = vi.fn();
    element.addEventListener("datum-print", seen);
    const stop = stubFramePrint(printed);
    try {
      const print = element.print();
      element.remove();
      await print;
    } finally {
      stop();
    }
    expect(printed).not.toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
    expect(frames()).toHaveLength(0);
  });

  it("still prints when the element is only moved within one task", async () => {
    const element = await mounted();
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    const printed = vi.fn();
    const stop = stubFramePrint(printed);
    try {
      const print = element.print();
      elsewhere.append(element);
      await print;
    } finally {
      stop();
    }
    expect(printed).toHaveBeenCalledTimes(1);
  });

  it("opens one dialog when a newer print() supersedes one waiting on its frame's fonts", async () => {
    const element = await mounted();
    const printed = vi.fn();
    const stop = stubFramePrint(printed, 200);
    try {
      const first = element.print();
      while (frames().length === 0) {
        await new Promise((done) => setTimeout(done, 5));
      }
      const second = element.print();
      await Promise.all([first, second]);
    } finally {
      stop();
    }
    expect(printed).toHaveBeenCalledTimes(1);
    expect(frames()).toHaveLength(1);
  });
});
