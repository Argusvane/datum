// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { PRINT_FRAME_ATTR } from "../form-engine/render/web-component/print-frame.js";
import {
  DATUM_FORM_RENDERER_TAG,
  defineDatumFormRendererElement,
  type DatumFormRendererElement,
  type DatumPrintDetail
} from "../form-engine/render/web-component/form-renderer-element.js";

/*
 * The print frame's life around <datum-form-renderer>.print(): the chrome kept off the page, the
 * hidden frame removed on afterprint (also when the browser fires it inside print() itself), a
 * newer print() superseding one still building, and print() with nothing to print. The document's
 * content is asserted in print-document.test.ts; this is the lifecycle.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const frames = (): HTMLIFrameElement[] => [...document.querySelectorAll<HTMLIFrameElement>(`iframe[${PRINT_FRAME_ATTR}]`)];

/** A textarea, a file, two tabs and a button: everything the print rendition treats specially. */
function printForm(locale = "en"): FormDefinition {
  const content: ComponentNode[] = [
    { id: "notes", type: "textarea", configuration: { label: "Notes", rows: 2 } },
    { id: "doc", type: "file", configuration: { label: "Supporting document" } },
    {
      id: "sections",
      type: "tabs",
      configuration: { tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      children: {
        a: [{ id: "email", type: "text", configuration: { label: "Email" } }],
        b: [{ id: "phone", type: "text", configuration: { label: "Phone" } }]
      }
    },
    { id: "send", type: "button", configuration: { label: "Submit", action: "submit" } }
  ];
  return {
    id: "intake",
    version: "1",
    schemaVersion: "1",
    localization: { defaultLocale: locale, supportedLocales: [{ code: "en" }, { code: "fr-CA" }] },
    root: { id: "root", type: "form", configuration: { title: "Intake" }, children: { content } }
  } as FormDefinition;
}

function runtimeOf(form: FormDefinition): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

async function mounted(runtime = runtimeOf(printForm()), setup?: (element: DatumFormRendererElement) => void): Promise<{ element: DatumFormRendererElement; runtime: FormRuntime }> {
  defineDatumFormRendererElement();
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  setup?.(element);
  element.runtime = runtime;
  document.body.append(element);
  await element.painted();
  return { element, runtime };
}

/**
 * jsdom creates a frame's window the moment the frame is appended, and queues this observer's
 * notification at that same moment, ahead of print()'s own await: the stub is in place before the
 * renderer calls the frame's print().
 */
function stubFramePrint(printed: () => void): () => void {
  const observer = new MutationObserver(() => {
    for (const frame of frames()) {
      if (frame.contentWindow) {
        frame.contentWindow.print = printed;
      }
    }
  });
  observer.observe(document.body, { childList: true });
  return () => observer.disconnect();
}

describe("what print() leaves off the page", () => {
  it("keeps chrome off the printed page: no switcher, header or footer region in the document", async () => {
    const { element } = await mounted(runtimeOf(printForm()), (el) => {
      el.chrome = { header: [{ type: "language-switcher" }], footer: [{ type: "language-switcher" }] };
    });
    // The chrome is on the screen form ...
    expect(element.shadowRoot!.querySelector("select[data-locale-switch]")).not.toBeNull();

    const seen: string[] = [];
    element.addEventListener("datum-print", (event) => {
      event.preventDefault();
      seen.push((event as CustomEvent<DatumPrintDetail>).detail.html);
    });
    await element.print();

    // ... and not on paper. The stylesheet may still name the regions (it is the form's whole
    // stylesheet); no region element and no switcher is in the document itself.
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("data-locale-switch");
    expect(seen[0]).not.toContain('class="datum-form__header"');
    expect(seen[0]).not.toContain('class="datum-form__footer"');
    const printed = new DOMParser().parseFromString(seen[0]!, "text/html");
    expect(printed.querySelector("select")).toBeNull();
  });
});

describe("the print frame's life", () => {
  it("prints through a hidden frame holding the print document, and removes the frame on afterprint", async () => {
    const { element, runtime } = await mounted();
    runtime.setValue("notes", "line one\nline two");

    const printed = vi.fn();
    const stop = stubFramePrint(printed);
    try {
      await element.print();
    } finally {
      stop();
    }

    expect(printed).toHaveBeenCalledTimes(1);
    const [frame] = frames();
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute("aria-hidden")).toBe("true");
    const doc = frame!.contentDocument!;
    expect(doc.documentElement.lang).toBe("en");
    expect(doc.title).toBe("Intake");
    // An answer is text that wraps, never a control that clips it; a button never prints.
    expect(doc.querySelector("textarea")).toBeNull();
    expect(doc.querySelector('[data-component-id="notes"] .datum-print__answer, [data-component-id="notes"] .dp-answer')?.textContent).toBe("line one\nline two");
    expect(doc.querySelector('[data-component-id="send"]')).toBeNull();

    // Safari and Firefox fire afterprint after print() has returned: the frame is still there until then.
    expect(frames()).toHaveLength(1);
    frame!.contentWindow!.dispatchEvent(new Event("afterprint"));
    expect(frames()).toHaveLength(0);
  });

  it("removes the frame when afterprint fires inside print() itself, as Chrome does, and can print again", async () => {
    const { element } = await mounted();

    // Chrome runs the dialog inside print(): beforeprint, the dialog, afterprint, then return.
    const printed = vi.fn(function (this: Window) {
      this.dispatchEvent(new Event("afterprint"));
    });
    const stop = stubFramePrint(printed as unknown as () => void);
    try {
      await element.print();
      expect(printed).toHaveBeenCalledTimes(1);
      expect(frames()).toHaveLength(0);
      // Nothing stale is left behind: a second print opens a fresh frame and prints again.
      await element.print();
      expect(printed).toHaveBeenCalledTimes(2);
      expect(frames()).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("lets a newer print() supersede one still building its rendition", async () => {
    const { element } = await mounted();
    const seen = vi.fn((event: Event) => event.preventDefault());
    element.addEventListener("datum-print", seen);

    const first = element.print();
    await element.print();
    await first;

    // The older call resolved without presenting anything: one document, no frame.
    expect(seen).toHaveBeenCalledTimes(1);
    expect(frames()).toHaveLength(0);
  });

  it("opens one frame, not two, when a newer print() supersedes one that would have framed", async () => {
    const { element } = await mounted();
    const printed = vi.fn();
    const stop = stubFramePrint(printed);
    try {
      const first = element.print();
      await element.print();
      await first;
    } finally {
      stop();
    }
    expect(printed).toHaveBeenCalledTimes(1);
    expect(frames()).toHaveLength(1);
  });

  it("resolves at once with no runtime, dispatching nothing and opening no frame", async () => {
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    document.body.append(element);
    const seen = vi.fn();
    document.addEventListener("datum-print", seen);
    try {
      await element.print();
    } finally {
      document.removeEventListener("datum-print", seen);
    }
    expect(seen).not.toHaveBeenCalled();
    expect(frames()).toHaveLength(0);
  });
});
