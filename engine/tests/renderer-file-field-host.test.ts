// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { ValidationStage } from "../form-engine/core/schema/contracts.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFileStorageResolver, type FileStorage } from "../form-engine/render/core/file-storage.js";
import {
  DATUM_FORM_RENDERER_TAG,
  defineDatumFormRendererElement,
  type DatumFormRendererElement
} from "../form-engine/render/web-component/form-renderer-element.js";

/*
 * A file field through <datum-form-renderer>, the host's side of it: the picker's fake path never
 * reaching state, a multi-file field storing through the host's storage kind (the context it is
 * handed, and no download offered for bytes the form does not hold), and a file the field's limits
 * reject worded through the page's messages, with {file} and {accept} filled in.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | null | undefined | false, tries = 300): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = read();
    if (value) {
      return value;
    }
    await wait(5);
  }
  throw new Error("never became true");
}

function fileForm(configuration: Record<string, unknown> = {}): FormDefinition {
  const content: ComponentNode[] = [{ id: "doc", type: "file", configuration: { label: "Supporting document", ...configuration } }];
  return { id: "files", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: {}, children: { content } } } as FormDefinition;
}

function runtimeOf(form: FormDefinition, stages: ValidationStage[] = []): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline(stages) });
}

async function mounted(runtime: FormRuntime, setup?: (element: DatumFormRendererElement) => void): Promise<{ element: DatumFormRendererElement; root: ShadowRoot }> {
  defineDatumFormRendererElement();
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  setup?.(element);
  element.runtime = runtime;
  document.body.append(element);
  await element.painted();
  return { element, root: element.shadowRoot! };
}

const box = (root: ShadowRoot, id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-component-id="${id}"]`)!;

/** Picks files in the field's native input, the way a person does. */
function pick(root: ShadowRoot, files: File[]): void {
  const input = box(root, "doc").querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

describe("a file field through the element", () => {
  it("never writes the picker's fake path into state when an input event reaches the file box", async () => {
    const runtime = runtimeOf(fileForm());
    const { root } = await mounted(runtime);
    const input = box(root, "doc").querySelector<HTMLInputElement>('input[type="file"]')!;
    // Browsers fire `input` for a file pick too; the text handler must not run on it.
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await wait(30);
    expect(runtime.state().values.doc).toBeUndefined();
  });

  it("appends to a multi-file field through the host's storage kind, handing it the field's whole configuration", async () => {
    const stored: Array<{ file: string; context: unknown }> = [];
    const s3: FileStorage = {
      kind: "s3",
      store: async (file, context) => {
        stored.push({ file: file.name, context });
        return { storage: "s3", name: file.name, type: file.type, size: file.size, url: `https://bucket/${file.name}` };
      }
    };
    const runtime = runtimeOf(fileForm({ storage: "s3", multiple: true, accept: "image/*" }));
    const { root } = await mounted(runtime, (el) => {
      el.fileStorage = createFileStorageResolver([s3]);
    });

    pick(root, [new File(["a"], "a.png", { type: "image/png" })]);
    await until(() => Array.isArray(runtime.state().values.doc) && (runtime.state().values.doc as unknown[]).length === 1);
    pick(root, [new File(["bb"], "b.png", { type: "image/png" })]);
    await until(() => (runtime.state().values.doc as unknown[] | undefined)?.length === 2);

    expect(runtime.state().values.doc).toEqual([
      { storage: "s3", name: "a.png", type: "image/png", size: 1, url: "https://bucket/a.png" },
      { storage: "s3", name: "b.png", type: "image/png", size: 2, url: "https://bucket/b.png" }
    ]);
    // The storage saw where the value goes and what the field allows.
    expect(stored[0]?.context).toEqual({
      componentId: "doc",
      valuePath: "doc",
      configuration: { storage: "s3", multiple: true, accept: ["image/*"], maxFileSize: undefined }
    });

    // Bytes that live elsewhere are listed by name, with no download the form cannot serve.
    await until(() => box(root, "doc").querySelectorAll("li").length === 2);
    expect(box(root, "doc").querySelector("li button:not([aria-label^='Remove'])")).toBeNull();
  });

  it("words a file the field's limits reject from the page's messages, with the file and what is accepted filled in", async () => {
    const form = fileForm({ accept: ".pdf", maxFileSizeMb: 1 });
    const runtime = runtimeOf(form, [createFieldConstraintsStage(form.root)]);
    const { element, root } = await mounted(runtime, (el) => {
      el.messages = { fileType: "“{file}” is not accepted here ({accept})." };
    });

    pick(root, [new File(["x"], "notes.txt", { type: "text/plain" })]);
    await until(() => runtime.state().values.doc);
    await element.validate();
    await until(() => {
      const control = box(root, "doc").querySelector("input");
      const described = control?.getAttribute("aria-describedby");
      return described !== null && described !== undefined && root.getElementById(described)?.textContent === "“notes.txt” is not accepted here (.pdf).";
    });
  });
});
