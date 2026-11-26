import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import { EMAIL_PRESET_MESSAGE, EMAIL_PRESET_PATTERN, type ComponentNode, type FormDefinition } from "@argusvane/datum-engine";

import { sampleDefinition, until, withEngineWords } from "./helpers.js";
import { box, control, describedBy, headingText, noticeOf, summaryOf, type } from "./live-dom.js";

/**
 * In the element: the sentences a filler reads, the form's title, a calculated field, the Email
 * keyboard, the built-in confirmation and the PDF button checking the answers first.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mount(definition: FormDefinition, setup?: (element: DatumFormElement) => void): DatumFormElement {
  const element = document.createElement("datum-form");
  setup?.(element);
  element.definition = definition;
  document.body.append(element);
  return element;
}

async function painted(element: DatumFormElement): Promise<ShadowRoot> {
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  return element.renderer!.shadowRoot!;
}

function formWith(children: ComponentNode[], configuration: Record<string, unknown> = {}): FormDefinition {
  return { id: "f", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration, children: { content: children } } };
}

describe("a validation code is worded for the filler", () => {
  it("shows the built-in sentence in the summary and under the field, never the bare code", async () => {
    const element = mount(sampleDefinition());
    const form = await painted(element);
    await element.validate({ focus: false });
    await until(() => summaryOf(form));
    const summary = summaryOf(form)!.textContent ?? "";
    expect(summary).toContain("Full name: This field is required");
    expect(summary).not.toMatch(/Full name: required\b/);
    expect(describedBy(control(form, "fullName"))).toBe("This field is required");
  });

  it("honours the page's form.messages, as the demo page assigns it, in both languages", async () => {
    const element = mount(sampleDefinition(), (el) => {
      el.messages = { required: { default: "Needed here.", locales: { "fr-CA": "Requis ici." } } };
    });
    const form = await painted(element);
    await element.validate({ focus: false });
    await until(() => describedBy(control(form, "fullName")) === "Needed here.");
    expect(summaryOf(form)!.textContent).toContain("Full name: Needed here.");
    element.setLocale("fr-CA");
    await until(() => describedBy(control(form, "fullName")) === "Requis ici.");
  });

  it("words the built-in sentence in French when the form's `texts` translations word it", async () => {
    const element = mount(withEngineWords(sampleDefinition(), "fr", { messages: { required: "Ce champ est obligatoire" } }));
    const form = await painted(element);
    element.setLocale("fr-CA");
    await element.validate({ focus: false });
    await until(() => describedBy(control(form, "fullName")) === "Ce champ est obligatoire");
  });
});

describe("the form's title heads the live form", () => {
  it("draws the title typed in Form settings, once, and not when a Form title part already does", async () => {
    const element = mount(formWith([{ id: "a", type: "text", configuration: { label: "A" } }], { title: "Intake form" }));
    const form = await painted(element);
    expect(form.querySelectorAll("h1")).toHaveLength(1);
    expect(form.querySelector("h1")?.textContent).toBe("Intake form");

    const placed = mount(formWith([{ id: "a", type: "text", configuration: { label: "A" } }], { title: "Intake form", chrome: { header: [{ id: "title", type: "form-title" }] } }));
    const placedForm = await painted(placed);
    // The part draws the title, and the form's own heading does not repeat it.
    expect(placedForm.querySelector('[data-chrome-part="form-title"]')?.textContent).toBe("Intake form");
    expect(placedForm.querySelectorAll("h1")).toHaveLength(1);
    expect(placedForm.querySelector("h1")?.getAttribute("data-chrome-part")).toBe("form-title");
  });

  it("draws nothing for a form with no title", async () => {
    const form = await painted(mount(formWith([{ id: "a", type: "text", configuration: { label: "A" } }])));
    expect(form.querySelector("h1")).toBeNull();
  });
});

describe("a calculated field cannot be typed into", () => {
  it("renders the target of a calculation read-only, its neighbours editable", async () => {
    const form = await painted(
      mount(
        formWith([
          { id: "price", type: "number", configuration: { label: "Price" } },
          { id: "total", type: "number", configuration: { label: "Total" }, rules: { value: "price * 2" as never } }
        ])
      )
    );
    await until(() => box(form, "total"));
    expect(box(form, "total").hasAttribute("data-readonly")).toBe(true);
    expect(control(form, "total").hasAttribute("readonly")).toBe(true);
    expect(box(form, "price").hasAttribute("data-readonly")).toBe(false);
    expect(control(form, "price").hasAttribute("readonly")).toBe(false);
  });
});

describe("the Email keyboard is a device hint; the stored preset checks for an address", () => {
  const emailForm = (extra: Record<string, unknown> = {}): FormDefinition =>
    formWith([{ id: "email", type: "text", configuration: { label: "Email", inputmode: "email", ...extra } }]);

  it("takes abc when the definition has the keyboard and no pattern, as the server's kernel does", async () => {
    const element = mount(emailForm());
    const form = await painted(element);
    const box = control(form, "email");
    expect(box.getAttribute("inputmode")).toBe("email");
    expect(box.hasAttribute("pattern")).toBe(false);
    type(box, "abc");
    await until(() => element.values.email === "abc");
    expect(await element.validate({ focus: false })).toEqual([]);
  });

  it("refuses abc with the preset's sentence and accepts a@b.ca once the preset is stored", async () => {
    const element = mount(emailForm({ pattern: EMAIL_PRESET_PATTERN, patternMessage: EMAIL_PRESET_MESSAGE }));
    const form = await painted(element);
    const box = control(form, "email");
    type(box, "abc");
    await until(() => element.values.email === "abc");
    expect((await element.validate({ focus: false })).map((error) => error.code)).toEqual(["pattern"]);
    await until(() => describedBy(control(form, "email")) === "Enter an email address");
    type(control(form, "email"), "a@b.ca");
    await until(() => element.values.email === "a@b.ca");
    expect(await element.validate({ focus: false })).toEqual([]);
  });

  it("lets the author's pattern win", async () => {
    const element = mount(emailForm({ pattern: "[a-z]+", patternMessage: "Letters only" }));
    const form = await painted(element);
    type(control(form, "email"), "abc");
    await until(() => element.values.email === "abc");
    expect(await element.validate({ focus: false })).toEqual([]);
  });
});

describe("the built-in confirmation", () => {
  // The kind word in French is the form's `texts` translation (the engine words only English).
  const filled = (setup?: (element: DatumFormElement) => void): DatumFormElement =>
    mount(withEngineWords(sampleDefinition(), "fr", { texts: { noticeSuccess: "Succès : ", confirmationTitle: "Votre formulaire a été envoyé" } }), (el) => {
      el.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
      el.values = { fullName: "Ada Lovelace" };
      setup?.(el);
    });

  it("is off by default: an accepted submit leaves what follows to the page", async () => {
    const element = filled();
    const form = await painted(element);
    expect(element.confirmation).toBe(false);
    expect((await element.submit()).accepted).toBe(true);
    expect(element.notice).toBeUndefined();
    expect(noticeOf(form)).toBeNull();
  });

  it("shows a success message, focused, when the attribute is set", async () => {
    const element = filled((el) => el.setAttribute("confirmation", ""));
    const form = await painted(element);
    expect(element.confirmation).toBe(true);
    expect((await element.submit()).accepted).toBe(true);
    await until(() => noticeOf(form));
    // The default notice names its kind for assistive technology ahead of its title; a success is a status.
    expect(noticeOf(form)!.getAttribute("role")).toBe("status");
    expect(headingText(noticeOf(form))).toBe("Success: Your form was submitted");
    expect(noticeOf(form)!.querySelector("dd")).toBeNull();
    await until(() => form.activeElement === noticeOf(form));
    // French, from the same notice.
    element.setLocale("fr-CA");
    await until(() => headingText(noticeOf(form)) === "Succès : Votre formulaire a été envoyé");
  });

  it("stays quiet for the download route, which sends nothing", async () => {
    const element = filled((el) => el.setAttribute("confirmation", ""));
    const form = await painted(element);
    const downloads: unknown[] = [];
    element.addEventListener("datum-download", (event) => {
      event.preventDefault();
      downloads.push((event as CustomEvent).detail);
    });
    expect((await element.submitAndDownload()).accepted).toBe(true);
    expect(downloads).toHaveLength(1);
    expect(element.notice).toBeUndefined();
    expect(noticeOf(form)).toBeNull();
  });

  it("shows the reference the delivery's reply carries", async () => {
    const element = filled((el) => {
      el.confirmation = true;
      el.addEventListener("datum-submit", (event) => (event as CustomEvent).detail.waitUntil(Promise.resolve({ receipt: { reference: "GC-48213" } })));
    });
    const form = await painted(element);
    await element.submit();
    await until(() => noticeOf(form)?.querySelector("dd")?.textContent === "GC-48213");
    expect(noticeOf(form)!.querySelector("dt")?.textContent).toBe("Reference");
  });

  it("is worded by the page's texts and never replaces a receipt the page set itself", async () => {
    const worded = filled((el) => {
      el.confirmation = true;
      el.texts = { confirmationTitle: "All done", confirmationMessage: "See you soon." };
    });
    const wordedForm = await painted(worded);
    await worded.submit();
    await until(() => headingText(noticeOf(wordedForm)) === "Success: All done");

    const own = filled((el) => {
      el.confirmation = true;
      el.addEventListener("datum-submit", (event) => (event as CustomEvent).detail.waitUntil(Promise.resolve().then(() => el.setNotice({ title: "Mine" }))));
    });
    const ownForm = await painted(own);
    await own.submit();
    await until(() => headingText(noticeOf(ownForm)) === "Success: Mine");
  });

  it("shows nothing for a refused submit or a failed delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = mount(sampleDefinition(), (el) => el.setAttribute("confirmation", ""));
    await painted(refused);
    expect((await refused.submit()).accepted).toBe(false);
    expect(refused.notice).toBeUndefined();

    const failed = filled((el) => {
      el.confirmation = true;
      el.addEventListener("datum-submit", (event) => (event as CustomEvent).detail.waitUntil(Promise.reject(new Error("offline"))));
    });
    await painted(failed);
    await failed.submit();
    expect(failed.notice).toBeUndefined();

    // fetch() resolves on a 500: a reply that says it is not ok is a refused delivery too.
    const refusedReply = filled((el) => {
      el.confirmation = true;
      el.addEventListener("datum-submit", (event) => (event as CustomEvent).detail.waitUntil(Promise.resolve({ ok: false, status: 500 })));
    });
    await painted(refusedReply);
    await refusedReply.submit();
    expect(refusedReply.notice).toBeUndefined();
  });
});

describe("the PDF button checks the answers first", () => {
  const pdfForm = (): FormDefinition => ({
    ...sampleDefinition(),
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
          { id: "make-pdf", type: "button", configuration: { label: "PDF", action: "pdf" } }
        ]
      }
    }
  });

  async function pressed(values: Record<string, unknown>): Promise<{ element: DatumFormElement; form: ShadowRoot; renders: ReturnType<typeof vi.fn> }> {
    const element = mount(pdfForm(), (el) => {
      el.pdfSupport = { provider: {}, fonts: [] } as never;
      el.values = values;
    });
    const form = await painted(element);
    const renders = vi.fn(async () => ({ fileName: "form.pdf", bytes: new Uint8Array([1]) }));
    vi.spyOn(element.renderer!, "downloadPdf").mockImplementation(renders as never);
    form.querySelector<HTMLElement>('[data-button-action="pdf"]')!.click();
    return { element, form, renders };
  }

  it("shows the summary and makes no PDF while a required answer is missing", async () => {
    const { form, renders } = await pressed({});
    await until(() => summaryOf(form));
    expect(summaryOf(form)!.textContent).toContain("Full name");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(renders).not.toHaveBeenCalled();
  });

  it("makes the PDF once the answers are valid", async () => {
    const { renders } = await pressed({ fullName: "Ada Lovelace" });
    await until(() => renders.mock.calls.length === 1);
  });
});
