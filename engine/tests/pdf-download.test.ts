// @vitest-environment jsdom
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProvenance } from "../form-engine/core/events/hooks.js";
import { downloadPdf, type DatumPdfDetail } from "../form-engine/render/web-component/pdf-download.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import {
  defineDatumFormRendererElement,
  DATUM_FORM_RENDERER_TAG,
  type DatumFormRendererElement
} from "../form-engine/render/web-component/form-renderer-element.js";

/*
 * Runs under jsdom for the renderer element's case. An environment without `URL.createObjectURL`
 * is itself the "this environment cannot make blob URLs" case. jsdom's URL class inherits Node's,
 * whose static `createObjectURL` accepts only Node's Blob, so the file shadows it with an own
 * `undefined` (a delete would only uncover the inherited one); the cases that need a download stub
 * it (and leave a no-op `revokeObjectURL` behind, since the revoke runs a second later).
 */

/** Every options object the PDF service was asked to render with (the renderer element's case). */
const service = vi.hoisted(() => ({ renderOptions: [] as Array<Record<string, unknown>> }));

vi.mock("../form-engine/render/pdf/pdf-service.js", () => ({
  renderFormPdf: async (_runtime: unknown, _context: unknown, options: Record<string, unknown>) => {
    service.renderOptions.push(options);
    return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [], fileName: "f-summary.pdf", layoutId: "summary", layoutChoice: "id", pageCount: 1 };
  }
}));

const urlStatics = URL as unknown as { createObjectURL: ((blob: Blob) => string) | undefined; revokeObjectURL?: (url: string) => void };
const hadOwnCreateObjectURL = Object.prototype.hasOwnProperty.call(URL, "createObjectURL");
const ownCreateObjectURL = hadOwnCreateObjectURL ? urlStatics.createObjectURL : undefined;
urlStatics.createObjectURL = undefined;
afterAll(() => {
  if (hadOwnCreateObjectURL) urlStatics.createObjectURL = ownCreateObjectURL;
  else delete (urlStatics as { createObjectURL?: unknown }).createObjectURL;
});

/** Makes blob URLs available, as a browser has them. */
function stubBlobUrls(): void {
  urlStatics.createObjectURL = () => "blob:stub-1";
  urlStatics.revokeObjectURL = () => undefined;
}

afterEach(() => {
  urlStatics.createObjectURL = undefined;
  document.body.innerHTML = "";
  service.renderOptions.length = 0;
});

/** A document that records the anchor a download stages, without a DOM. */
function fakeDocument() {
  const clicks: Array<{ href: string; download: string }> = [];
  const anchor = {
    href: "",
    download: "",
    click() {
      clicks.push({ href: this.href, download: this.download });
    },
    remove() {}
  };
  const doc = {
    createElement: () => anchor,
    body: { append: () => undefined }
  };
  return { doc: doc as unknown as Document, clicks };
}

const detail: DatumPdfDetail = {
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  fileName: "intake-default.pdf",
  layoutId: "default",
  pageCount: 1,
  warnings: []
};

const provenance: AgentProvenance = {
  version: 1,
  involved: true,
  paths: ["name"],
  tables: [],
  complete: true,
  submittedBy: "agent",
  sessions: 1,
  sessionOpen: true
};

describe("downloadPdf", () => {
  it("announces datum-pdf and, uncancelled, stages a blob download under the file name", () => {
    stubBlobUrls();
    const target = new EventTarget();
    const seen: DatumPdfDetail[] = [];
    target.addEventListener("datum-pdf", (event) => seen.push((event as CustomEvent<DatumPdfDetail>).detail));
    const { doc, clicks } = fakeDocument();
    const result = downloadPdf(target, detail, { document: doc });
    expect(seen).toEqual([detail]);
    expect(result.downloaded).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.download).toBe("intake-default.pdf");
    expect(clicks[0]!.href).toMatch(/^blob:/);
  });

  it("saves nothing when a listener takes the bytes over, and says it was cancelled", () => {
    stubBlobUrls();
    const target = new EventTarget();
    target.addEventListener("datum-pdf", (event) => event.preventDefault());
    const { doc, clicks } = fakeDocument();
    const result = downloadPdf(target, detail, { document: doc });
    expect(result.downloaded).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(clicks).toEqual([]);
    expect(result.fileName).toBe("intake-default.pdf");
  });

  it("with no blob URLs, nothing is downloaded and nothing was cancelled: the file reached nobody", () => {
    expect(urlStatics.createObjectURL).toBeUndefined();
    const target = new EventTarget();
    let announced = 0;
    target.addEventListener("datum-pdf", () => {
      announced += 1;
    });
    const { doc, clicks } = fakeDocument();
    const result = downloadPdf(target, detail, { document: doc });
    expect(announced).toBe(1);
    expect(result.downloaded).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(clicks).toEqual([]);
  });

  it("puts trigger and agent on the detail when given, and leaves both keys off otherwise", () => {
    const target = new EventTarget();
    const seen: DatumPdfDetail[] = [];
    target.addEventListener("datum-pdf", (event) => {
      seen.push((event as CustomEvent<DatumPdfDetail>).detail);
      event.preventDefault();
    });
    const { doc } = fakeDocument();

    const asked = downloadPdf(target, detail, { document: doc, trigger: "agent", agent: provenance });
    const plain = downloadPdf(target, detail, { document: doc });

    expect(seen[0]!.trigger).toBe("agent");
    expect(seen[0]!.agent).toEqual(provenance);
    expect(asked.trigger).toBe("agent");
    expect(asked.agent).toEqual(provenance);
    expect("trigger" in seen[1]!).toBe(false);
    expect("agent" in seen[1]!).toBe(false);
    expect("trigger" in plain).toBe(false);
    expect("agent" in plain).toBe(false);
    // The caller's detail is not written to.
    expect("trigger" in detail).toBe(false);
  });
});

describe("the renderer element's downloadPdf", () => {
  function element(): DatumFormRendererElement {
    defineDatumFormRendererElement();
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const definition = {
      id: "f",
      version: "1",
      root: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }
    };
    const renderer = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    renderer.runtime = new FormRuntime(definition as never, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
    renderer.pdfProvider = {} as never;
    document.body.append(renderer);
    return renderer;
  }

  it("puts trigger and agent on datum-pdf and never into the render options", async () => {
    const renderer = element();
    const seen: DatumPdfDetail[] = [];
    renderer.addEventListener("datum-pdf", (event) => {
      seen.push((event as CustomEvent<DatumPdfDetail>).detail);
      event.preventDefault();
    });

    const result = await renderer.downloadPdf({ layoutId: "summary", locale: "en", trigger: "agent", agent: provenance });

    expect(service.renderOptions).toHaveLength(1);
    const rendered = service.renderOptions[0]!;
    expect(rendered.layoutId).toBe("summary");
    expect(rendered.locale).toBe("en");
    for (const key of ["trigger", "agent", "document"]) {
      expect(key in rendered, key).toBe(false);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.trigger).toBe("agent");
    expect(seen[0]!.agent).toEqual(provenance);
    expect(seen[0]!.layoutId).toBe("summary");
    expect(result?.cancelled).toBe(true);
    expect(result?.downloaded).toBe(false);
  });

  it("without them the detail and the render options are what they were", async () => {
    const renderer = element();
    const seen: DatumPdfDetail[] = [];
    renderer.addEventListener("datum-pdf", (event) => seen.push((event as CustomEvent<DatumPdfDetail>).detail));

    const result = await renderer.downloadPdf({ layoutId: "summary" });

    expect(service.renderOptions).toEqual([{ layoutId: "summary" }]);
    expect("trigger" in seen[0]!).toBe(false);
    expect("agent" in seen[0]!).toBe(false);
    // jsdom makes no blob URLs: not downloaded, and no listener cancelled it.
    expect(result?.downloaded).toBe(false);
    expect(result?.cancelled).toBe(false);
  });

  it("stages the file in its own document: the downloadPdf() function's document option is not the method's", async () => {
    stubBlobUrls();
    const renderer = element();
    const { doc, clicks } = fakeDocument();
    const staged: string[] = [];
    // The element's document hears the anchor's click; cancelling it keeps jsdom from navigating.
    const onClick = (event: Event): void => {
      staged.push((event.target as HTMLAnchorElement).download);
      event.preventDefault();
    };
    document.addEventListener("click", onClick);
    try {
      // @ts-expect-error -- `document` belongs to the function, not to the element's method.
      const result = await renderer.downloadPdf({ layoutId: "summary", document: doc });

      expect(result?.downloaded).toBe(true);
      expect(staged).toEqual(["f-summary.pdf"]);
      expect(clicks).toEqual([]);
    } finally {
      document.removeEventListener("click", onClick);
    }
  });
});
