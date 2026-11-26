// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { defineDatumFormHostElement, DATUM_FORM_HOST_TAG, type DatumFormHostElement } from "../form-engine/render/web-component/form-host-element.js";

/**
 * `<datum-form-host>`'s PDF layout picker: shown with a provider, listing the runtime's live
 * layouts, starting on the form's default, leading with Automatic once a layout is conditional,
 * and keeping the person's own choice across refreshes while it is still offered.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const ROOT: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] } } as unknown as ComponentNode;

// A download that names no layout prints the first layout whose `when` holds.
const QUEBEC = { kind: "binary" as const, operator: "eq" as const, left: { kind: "path" as const, path: "fullName" }, right: { kind: "literal" as const, value: "QC" } };
type PickerLayout = { id: string; kind: "generated"; name: string; when?: typeof QUEBEC; root: ComponentNode };
const layoutOf = (id: string, when?: typeof QUEBEC): PickerLayout => ({
  id,
  kind: "generated",
  name: `Layout ${id.toUpperCase()}`,
  ...(when ? { when } : {}),
  root: { id: "document", type: "pdf-document", configuration: {} } as unknown as ComponentNode
});

type PdfBlock = { layouts: PickerLayout[]; defaultLayoutId?: string };

function runtimeWith(pdf: () => PdfBlock): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
  const form = { id: "f1", version: "1", schemaVersion: "1", root: ROOT, localization: { defaultLocale: "en" } } as unknown as FormDefinition;
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([]), pdfConfiguration: pdf as never });
}

const FAKE_PROVIDER = { id: "fake", abiVersion: "4.0.0", render: async () => ({}) } as unknown as NonNullable<DatumFormHostElement["pdfProvider"]>;

function newHost(): DatumFormHostElement {
  defineDatumFormHostElement();
  const el = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
  document.body.append(el);
  return el;
}

/** A host over a runtime whose PDF block is read live, with the renderer's downloadPdf stubbed to report what it was asked. */
function pickerHost(pdf: () => PdfBlock) {
  const el = newHost();
  el.runtime = runtimeWith(pdf);
  el.pdfProvider = FAKE_PROVIDER;
  const renderer = el.shadowRoot!.querySelector("datum-form-renderer") as unknown as { downloadPdf: (options: unknown) => Promise<unknown> };
  const asked = vi.spyOn(renderer, "downloadPdf").mockResolvedValue(undefined);
  const picker = el.shadowRoot!.querySelector<HTMLSelectElement>("[data-pdf-layout]")!;
  return { el, picker, asked };
}

const choose = (picker: HTMLSelectElement, value: string): void => {
  picker.value = value;
  picker.dispatchEvent(new Event("change"));
};

describe("the host's PDF layout picker", () => {
  it("shows the PDF button with a provider, lists the runtime's live layouts, and re-reads them on refreshPdfLayouts()", () => {
    let layouts = [layoutOf("a")];
    const el = newHost();
    el.runtime = runtimeWith(() => ({ layouts }));
    const button = el.shadowRoot!.querySelector<HTMLButtonElement>("[data-pdf]")!;
    const picker = el.shadowRoot!.querySelector<HTMLSelectElement>("[data-pdf-layout]")!;
    expect(button.hidden).toBe(true);

    el.pdfProvider = FAKE_PROVIDER;
    expect(button.hidden).toBe(false);
    // One layout is no choice: the picker stays hidden but knows it.
    expect(picker.hidden).toBe(true);
    expect(Array.from(picker.options).map((option) => option.value)).toEqual(["a"]);

    layouts = [...layouts, layoutOf("b")];
    el.refreshPdfLayouts();
    expect(Array.from(picker.options).map((option) => option.textContent)).toEqual(["Layout A", "Layout B"]);
    expect(picker.hidden).toBe(false);
  });

  it("starts on the form's default, not simply the first layout, and sends it", async () => {
    const { el, picker, asked } = pickerHost(() => ({ layouts: [layoutOf("a"), layoutOf("b")], defaultLayoutId: "b" }));
    expect(Array.from(picker.options).map((option) => option.value)).toEqual(["a", "b"]);
    expect(picker.value).toBe("b");
    expect(el.selectedPdfLayoutId).toBe("b");
    await el.downloadPdf();
    expect(asked).toHaveBeenLastCalledWith({ layoutId: "b" });
  });

  it("leads with Automatic once a layout is conditional, which names no layout so the answers choose", async () => {
    const { el, picker, asked } = pickerHost(() => ({ layouts: [layoutOf("a"), layoutOf("b", QUEBEC)], defaultLayoutId: "a" }));
    expect(Array.from(picker.options).map((option) => [option.value, option.textContent])).toEqual([
      ["", "Automatic (by the answers)"],
      ["a", "Layout A"],
      ["b", "Layout B"]
    ]);
    expect(picker.value).toBe("");
    expect(el.selectedPdfLayoutId).toBeUndefined();
    await el.downloadPdf();
    expect(asked).toHaveBeenLastCalledWith({});
    // A layout the person picks is sent by id.
    choose(picker, "b");
    await el.downloadPdf();
    expect(asked).toHaveBeenLastCalledWith({ layoutId: "b" });
  });

  it("turns to Automatic when a layout gains a when, rather than keep sending the default it had put there", async () => {
    let layouts = [layoutOf("a"), layoutOf("b")];
    const { el, picker, asked } = pickerHost(() => ({ layouts, defaultLayoutId: "a" }));
    expect(picker.value).toBe("a");

    layouts = [layoutOf("a"), layoutOf("b", QUEBEC)];
    el.refreshPdfLayouts();
    expect(picker.options[0]?.value).toBe("");
    expect(picker.value).toBe("");
    await el.downloadPdf();
    expect(asked).toHaveBeenLastCalledWith({});

    // Conditions gone again: no Automatic, and the picker is back on the default.
    layouts = [layoutOf("a"), layoutOf("b")];
    el.refreshPdfLayouts();
    expect(Array.from(picker.options).map((option) => option.value)).toEqual(["a", "b"]);
    expect(picker.value).toBe("a");
  });

  it("keeps the person's own choice across refreshes while it is offered, and lets it go when it is not", () => {
    let layouts = [layoutOf("a"), layoutOf("b"), layoutOf("c")];
    const { el, picker } = pickerHost(() => ({ layouts, defaultLayoutId: "a" }));
    choose(picker, "c");

    // A condition appears: the person's pick stands; Automatic is offered, not imposed.
    layouts = [layoutOf("a"), layoutOf("b", QUEBEC), layoutOf("c")];
    el.refreshPdfLayouts();
    expect(picker.value).toBe("c");
    expect(el.selectedPdfLayoutId).toBe("c");

    // Their layout goes: the picker falls back to Automatic, and forgets the pick.
    layouts = [layoutOf("a"), layoutOf("b", QUEBEC)];
    el.refreshPdfLayouts();
    expect(picker.value).toBe("");
    layouts = [layoutOf("a"), layoutOf("b", QUEBEC), layoutOf("c")];
    el.refreshPdfLayouts();
    expect(picker.value).toBe("");

    // Automatic chosen by the person is kept too, while a layout is conditional.
    choose(picker, "");
    el.refreshPdfLayouts();
    expect(picker.value).toBe("");
  });
});
