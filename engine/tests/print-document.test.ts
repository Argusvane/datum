// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { normalizeDataGrids } from "../form-engine/core/schema/data-grid.js";
import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import {
  basicPrintTheme,
  buildPrintDocument,
  buildPrintModel,
  datumPrintTheme,
  escapePrintText,
  isSafeHtml,
  preparePrint,
  printHtml,
  printAnswerText,
  printModelOf,
  printPageCss,
  readPrintSource,
  type PrintField,
  type PrintGrid,
  type PrintModel,
  type PrintNode,
  type PrintSection,
  type PrintSourceOptions,
  type PrintTheme
} from "../form-engine/render/print/index.js";
import { presentPrintDocument, PRINT_FRAME_ATTR } from "../form-engine/render/web-component/print-frame.js";
import {
  DATUM_FORM_RENDERER_TAG,
  defineDatumFormRendererElement,
  type DatumFormRendererElement,
  type DatumPrintDetail
} from "../form-engine/render/web-component/form-renderer-element.js";

/**
 * Print: the print model from the presentation fold of the read-only output, every
 * answer worded; print themes that draw `printHtml` markup and nothing else; the document, which
 * runs no script; the frame, which checks a theme once its sheets are in and falls back to the
 * basic theme.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function definition(children: ComponentNode[], extra: Partial<FormDefinition> = {}, configuration: Record<string, unknown> = { title: "Intake" }): FormDefinition {
  return {
    id: "intake",
    version: "1",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }, { code: "ar-EG", label: "العربية" }] },
    root: { id: "root", type: "form", configuration, children: { content: children } },
    ...extra
  } as FormDefinition;
}

function runtimeOf(form: FormDefinition): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(normalizeDataGrids(form.root))])
  });
}

async function modelOf(runtime: FormRuntime, options: PrintSourceOptions = {}): Promise<PrintModel> {
  return buildPrintModel(runtime, { render: { journeyKit: EagerJourneyRenderKit }, ...options });
}

/** Every node, depth first. */
function all(nodes: readonly PrintNode[]): PrintNode[] {
  return nodes.flatMap((node) => [node, ...(node.kind === "group" || node.kind === "section" || node.kind === "run" ? all(node.children) : [])]);
}

const field = (model: PrintModel, id: string): PrintField => {
  const found = all(model.nodes).find((node): node is PrintField => node.kind === "field" && node.id === id);
  if (!found) {
    throw new Error(`no printed field ${id}`);
  }
  return found;
};

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

const intake: ComponentNode[] = [
  { id: "name", type: "text", configuration: { label: "Full name", description: "As on your passport", required: true } },
  { id: "amount", type: "number", configuration: { label: "Amount", prefix: "$", suffix: ".00" } },
  { id: "weight", type: "number", configuration: { label: "Weight", suffix: "kg" } },
  { id: "born", type: "date", configuration: { label: "Date of birth" } },
  {
    id: "colour",
    type: "radio",
    configuration: { label: "Colour", options: [{ value: "r", label: "Red" }, { value: "g", label: "Green", description: "Like grass" }] }
  },
  {
    id: "pets",
    type: "checkboxes",
    configuration: { label: "Pets", options: [{ value: "cat", label: "Cat" }, { value: "dog", label: "Dog" }] }
  },
  { id: "city", type: "select", configuration: { label: "City", options: [{ value: "ott", label: "Ottawa" }, { value: "tor", label: "Toronto" }] } },
  { id: "agree", type: "checkbox", configuration: { label: "I agree" } },
  { id: "notes", type: "textarea", configuration: { label: "Notes", rows: 3 } },
  { id: "doc", type: "file", configuration: { label: "Supporting document" } },
  { id: "send", type: "button", configuration: { label: "Submit", action: "submit" } }
];

describe("printHtml", () => {
  it("escapes every value that is not printHtml markup, and keeps the markup it made", () => {
    const inner = printHtml`<b>${"<i>"}</b>`;
    const out = printHtml`<p title="${`"x' & y`}">${"<script>alert(1)</script>"}${inner}${42}${null}${undefined}${false}${["a", printHtml`<br>`]}</p>`;
    expect(out.html).toBe('<p title="&quot;x&#39; &amp; y">&lt;script&gt;alert(1)&lt;/script&gt;<b>&lt;i&gt;</b>42a<br></p>');
    expect(isSafeHtml(out)).toBe(true);
    expect(String(out)).toBe(out.html);
  });

  it("refuses to be called as a function, refuses objects, and is not fooled by a look-alike", () => {
    expect(() => (printHtml as unknown as (s: string[]) => unknown)(["<p>"])).toThrow(/template tag/);
    expect(() => printHtml`${{ html: "<script>" } as never}`).toThrow(TypeError);
    expect(isSafeHtml({ html: "<script>", toString: () => "<script>" })).toBe(false);
    expect(escapePrintText(`<a href='x'>`)).toBe("&lt;a href=&#39;x&#39;&gt;");
  });
});

describe("the print model", () => {
  it("words every answer: choice labels, dates in the locale's words, affixes, files; buttons and errors never print", async () => {
    const runtime = runtimeOf(definition(intake));
    runtime.setValue("name", "Ada Lovelace");
    runtime.setValue("amount", 1250);
    runtime.setValue("weight", 70);
    runtime.setValue("born", "2026-03-15");
    runtime.setValue("colour", "g");
    runtime.setValue("pets", { cat: true, dog: false });
    runtime.setValue("city", "tor");
    runtime.setValue("agree", true);
    runtime.setValue("notes", "line one\nline two");
    runtime.setValue("doc", { storage: "base64", name: "scan.pdf", type: "application/pdf", size: 2048, data: "" });
    const model = await modelOf(runtime);

    expect(model.title).toBe("Intake");
    expect(model.lang).toBe("en");
    expect(model.dir).toBe("ltr");
    expect(model.rendition).toBe("answers");
    expect(model.words).toEqual({ notAnswered: "Not answered", chosen: "Chosen", rowNumber: "#", required: "*", pageNumber: "Page {{page}} of {{pages}}" });
    expect(field(model, "name")).toMatchObject({ label: "Full name", hint: "As on your passport", required: true, empty: false, answer: { shape: "text", text: "Ada Lovelace" } });
    expect(field(model, "amount").answer).toMatchObject({ text: "$1250.00" });
    expect(field(model, "weight").answer).toMatchObject({ text: "70 kg" });
    expect(field(model, "born").answer).toMatchObject({ shape: "text", text: "March 15, 2026" });
    expect(field(model, "colour").answer).toEqual({
      shape: "choices",
      multiple: false,
      single: false,
      options: [
        { label: "Red", chosen: false },
        { label: "Green", hint: "Like grass", chosen: true }
      ]
    });
    expect(field(model, "pets").answer).toMatchObject({ multiple: true, options: [{ label: "Cat", chosen: true }, { label: "Dog", chosen: false }] });
    expect(field(model, "city").answer).toMatchObject({ shape: "text", text: "Toronto" });
    expect(field(model, "agree")).toMatchObject({ empty: false, answer: { shape: "choices", single: true, options: [{ label: "I agree", chosen: true }] } });
    expect(field(model, "notes").answer).toMatchObject({ shape: "text", text: "line one\nline two", multiline: true, lines: 3 });
    expect(field(model, "doc").answer).toEqual({ shape: "files", names: ["scan.pdf"] });
    expect(all(model.nodes).some((node) => node.id === "send")).toBe(false);

    // A field left empty says so; errors never reach paper.
    runtime.setValue("name", "");
    await runtime.validate();
    expect(runtime.errors().some((error) => error.componentId === "name")).toBe(true);
    const again = await modelOf(runtime);
    expect(field(again, "name").empty).toBe(true);
    const html = buildPrintDocument(again);
    expect(html).toContain("Not answered");
    expect(html).not.toMatch(/required|is missing|aria-invalid|datum-form__error/i);
  });

  it("says an unanswered choice in words alone on the answers copy, and keeps its options on a blank or filled form", async () => {
    const runtime = runtimeOf(definition(intake));
    const part = (html: string, id: string): string => {
      const at = html.indexOf(`data-component-id="${id}"`);
      const next = html.indexOf("data-component-id=", at + 1);
      return html.slice(at, next === -1 ? undefined : next);
    };
    const answers = buildPrintDocument(await modelOf(runtime));
    for (const id of ["colour", "pets", "city"]) {
      expect(part(answers, id)).toContain("Not answered");
      expect(part(answers, id)).not.toContain("dp-choices");
    }
    // A lone checkbox is its own empty state: the box, no words.
    expect(part(answers, "agree")).toContain("dp-choices");
    expect(part(answers, "agree")).not.toContain("Not answered");
    for (const rendition of ["blank", "filled"] as const) {
      const paper = buildPrintDocument(await modelOf(runtime, { rendition }));
      expect(part(paper, "colour")).toContain("dp-choices");
      expect(part(paper, "colour")).not.toContain("Not answered");
    }
  });

  it("prints every tab, every step and every grid row as the form folds them, in order", async () => {
    const runtime = runtimeOf(
      definition([
        {
          id: "sections",
          type: "tabs",
          configuration: { tabs: [{ id: "a", label: "Contact" }, { id: "b" }] },
          children: {
            a: [{ id: "email", type: "text", configuration: { label: "Email" } }],
            b: [{ id: "phone", type: "text", configuration: { label: "Phone" } }]
          }
        },
        {
          id: "wizard",
          type: "steps",
          configuration: {},
          children: {
            content: [
              { id: "one", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "first", type: "text", configuration: { label: "First" } }] } },
              { id: "two", type: "step", configuration: {}, children: { content: [{ id: "second", type: "text", configuration: { label: "Second" } }] } }
            ]
          }
        },
        {
          id: "box",
          type: "fieldset",
          configuration: { label: "Address", description: "Where you live" },
          children: { content: [{ id: "street", type: "text", configuration: { label: "Street" } }] }
        },
        { id: "plain", type: "panel", configuration: {}, children: { content: [{ id: "loose", type: "text", configuration: { label: "Loose" } }] } },
        {
          id: "items",
          type: "dataGrid",
          configuration: { label: "Items", rowLabel: "Item {{n}}" },
          collection: { collectionPath: "items" },
          children: {
            content: [
              { id: "qty", type: "number", configuration: { label: "Quantity", required: true } },
              { id: "sku", type: "text", configuration: { label: "SKU" } }
            ]
          }
        }
      ])
    );
    runtime.setValue("items[0].qty", 3);
    runtime.setValue("items[0].sku", "A-1");
    runtime.addRow("items");
    runtime.setValue("items[1].qty", 5);
    const model = await modelOf(runtime);
    const sections = all(model.nodes).filter((node): node is PrintSection => node.kind === "section");
    expect(sections.map((section) => `${section.from}:${section.title}`)).toEqual(["tab:Contact", "tab:Tab 2", "step:About you", "step:Step 2"]);
    expect(sections[0]?.level).toBe(1);
    const group = all(model.nodes).find((node) => node.kind === "group");
    expect(group).toMatchObject({ id: "box", legend: "Address", hint: "Where you live", level: 1 });
    // The unnamed panel is no heading: its field joins the run.
    expect(model.nodes.some((node) => node.kind === "field" && node.id === "loose")).toBe(true);
    const grid = model.nodes.find((node): node is PrintGrid => node.kind === "grid")!;
    expect(grid.columns.map((column) => column.label)).toEqual(["Quantity", "SKU"]);
    expect(grid.rows.map((row) => [row.label, ...row.cells.map((cell) => (cell.answer.shape === "text" ? cell.answer.text : ""))])).toEqual([
      ["Item 1", "3", "A-1"],
      ["Item 2", "5", ""]
    ]);
    const doc = parse(buildPrintDocument(model));
    expect([...doc.querySelectorAll(".datum-print__grid tbody tr")].map((row) => row.textContent)).toEqual(["13A-1", "25"]);
    expect([...doc.querySelectorAll("h2, h3")].map((heading) => heading.textContent)).toEqual(["Contact", "Tab 2", "About you", "Step 2", "Address", "Items"]);
  });

  it("prints a blank form to fill in: every option unmarked, date parts in the locale's order, empty grid rows, the required mark", async () => {
    const runtime = runtimeOf(
      definition([
        ...intake,
        {
          id: "items",
          type: "dataGrid",
          configuration: { label: "Items" },
          collection: { collectionPath: "items" },
          children: { content: [{ id: "qty", type: "number", configuration: { label: "Quantity" } }] }
        }
      ])
    );
    runtime.setValue("name", "Ada");
    runtime.setValue("colour", "r");
    const model = await modelOf(runtime, { rendition: "blank" });
    expect(model.rendition).toBe("blank");
    expect(field(model, "name")).toMatchObject({ empty: true, answer: { text: "" } });
    expect(field(model, "colour").answer).toMatchObject({ options: [{ chosen: false }, { chosen: false }] });
    expect(field(model, "city").answer).toMatchObject({ shape: "choices", options: [{ label: "Ottawa" }, { label: "Toronto" }] });
    expect(field(model, "born").answer).toEqual({
      shape: "date-parts",
      parts: [
        { part: "month", label: "Month", size: 2 },
        { part: "day", label: "Day", size: 2 },
        { part: "year", label: "Year", size: 4 }
      ]
    });
    const grid = model.nodes.find((node): node is PrintGrid => node.kind === "grid")!;
    expect(grid.rows).toHaveLength(3);
    const html = buildPrintDocument(model);
    expect(html).not.toContain("Ada");
    expect(html).not.toContain("Not answered");
    const doc = parse(html);
    expect(doc.querySelector('[data-component-id="name"] .dp-req')?.textContent).toBe("*");
    expect(doc.querySelectorAll(".dp-lines")).not.toHaveLength(0);
    expect(doc.querySelector(".datum-print--blank")).not.toBeNull();

    const french = await modelOf(runtime, { rendition: "blank", locale: "fr" });
    expect((field(french, "born").answer as { parts: Array<{ part: string }> }).parts.map((part) => part.part)).toEqual(["day", "month", "year"]);
  });

  it("follows print.show on a live form and prints what it shows on a read-only one", async () => {
    const form = definition([
      { id: "subscribe", type: "checkbox", configuration: { label: "Subscribe" } },
      {
        id: "email",
        type: "text",
        configuration: { label: "Email", print: { show: "always", note: "Complete only if you ticked Subscribe." } },
        rules: { visibleWhen: "subscribe" }
      },
      { id: "phone", type: "text", configuration: { label: "Phone", print: { show: "always" } }, rules: { visibleWhen: "subscribe" } },
      { id: "office", type: "text", configuration: { label: "Office use only", print: { on: "screen" } } },
      { id: "reference", type: "text", configuration: { label: "Reference", print: { show: "answered" } } }
    ]);
    const runtime = runtimeOf(form);
    const live = await modelOf(runtime);
    const ids = (model: PrintModel): string[] => all(model.nodes).map((node) => node.id);
    expect(ids(live)).toEqual(["subscribe", "email", "phone"]);
    expect(field(live, "email").note).toBe("Complete only if you ticked Subscribe.");
    expect(field(live, "phone").note).toBe("Complete only if it applies to you.");
    runtime.setValue("reference", "A-123");
    runtime.setValue("subscribe", true);
    const answered = await modelOf(runtime);
    expect(ids(answered)).toEqual(["subscribe", "email", "phone", "reference"]);
    expect(field(answered, "email").note).toBeUndefined();

    // A blank form keeps an "only when answered" field, as the screen shows it.
    expect(ids(await modelOf(runtimeOf(form), { rendition: "blank" }))).toEqual(["subscribe", "email", "phone", "reference"]);
    // A read-only form prints what it shows, whatever `print.show` says; `on: "screen"` leaves "office" off still.
    expect(ids(await modelOf(runtimeOf(form), { mode: "readonly" }))).toEqual(["subscribe", "reference"]);
  });

  it("reads a container's print.show by what is inside it: answered when a field in it is, screen-only with all it holds, always with its note and its way out of a hidden group", async () => {
    const form = definition([
      { id: "married", type: "checkbox", configuration: { label: "Married" } },
      {
        id: "children",
        type: "fieldset",
        configuration: { label: "Children", print: { show: "answered" } },
        children: { content: [{ id: "child", type: "text", configuration: { label: "Child" } }] }
      },
      {
        id: "office",
        type: "fieldset",
        configuration: { label: "Office use", print: { on: "screen" } },
        children: { content: [{ id: "officer", type: "text", configuration: { label: "Officer", print: { show: "always" } } }] }
      },
      {
        id: "spouse",
        type: "fieldset",
        configuration: { label: "Spouse", print: { show: "always", note: "ONLY-IF-MARRIED" } },
        rules: { visibleWhen: "married" },
        children: { content: [{ id: "spouseName", type: "text", configuration: { label: "Spouse name" } }] }
      },
      {
        id: "assets",
        type: "dataGrid",
        configuration: { label: "Assets", print: { show: "always", note: "GRID-NOTE" } },
        rules: { visibleWhen: "married" },
        collection: { collectionPath: "assets" },
        children: { content: [{ id: "what", type: "text", configuration: { label: "What" } }] }
      },
      {
        id: "previous",
        type: "fieldset",
        configuration: { label: "Previous marriage" },
        rules: { visibleWhen: "married" },
        children: {
          content: [
            { id: "exName", type: "text", configuration: { label: "Former spouse", print: { show: "always" } } },
            { id: "exDate", type: "date", configuration: { label: "Divorced on" } }
          ]
        }
      }
    ]);
    const runtime = runtimeOf(form);
    const ids = (model: PrintModel): string[] => all(model.nodes).map((node) => node.id);
    // Nothing in "Children" is answered yet; "Office use" is on screen only, its "always" field with it.
    const before = await modelOf(runtime);
    expect(ids(before)).toEqual(["married", "spouse", "spouseName", "assets", "previous", "exName"]);
    runtime.setValue("child", "Ada Jr");
    const after = await modelOf(runtime);
    expect(ids(after)).toContain("children");
    expect(field(after, "child").answer).toMatchObject({ text: "Ada Jr" });
    // A hidden container printed "always" carries its note, a group and a grid alike.
    expect(all(after.nodes).find((node) => node.id === "spouse")).toMatchObject({ kind: "group", note: "ONLY-IF-MARRIED" });
    expect(after.nodes.find((node) => node.id === "assets")).toMatchObject({ kind: "grid", note: "GRID-NOTE" });
    const doc = parse(buildPrintDocument(after));
    expect(doc.querySelector('[data-component-id="spouse"] .dp-note')?.textContent).toBe("ONLY-IF-MARRIED");
    expect(doc.querySelector('[data-component-id="assets"] .dp-note')?.textContent).toBe("GRID-NOTE");
    // An "always" field inside a hidden group prints with its note, under the group's heading; its neighbours do not.
    expect(all(after.nodes).find((node) => node.id === "previous")).toMatchObject({ kind: "group", legend: "Previous marriage" });
    expect(field(after, "exName").note).toBe("Complete only if it applies to you.");
    expect(ids(after)).not.toContain("exDate");
    // Shown, nothing carries a note, and the group prints whole.
    runtime.setValue("married", true);
    const shown = await modelOf(runtime);
    expect(ids(shown)).toEqual(expect.arrayContaining(["exName", "exDate"]));
    expect(all(shown.nodes).find((node) => node.id === "spouse")).not.toHaveProperty("note");
    expect(field(shown, "exName").note).toBeUndefined();
  });

  it("prints a blank grid with at least the rows the form needs, and numbers in the locale's words", async () => {
    const runtime = runtimeOf(
      definition([
        {
          id: "many",
          type: "dataGrid",
          configuration: { label: "Many", minRows: 10 },
          collection: { collectionPath: "many" },
          children: { content: [{ id: "x", type: "text", configuration: { label: "X" } }] }
        },
        {
          id: "few",
          type: "dataGrid",
          configuration: { label: "Few", maxRows: 2 },
          collection: { collectionPath: "few" },
          children: { content: [{ id: "y", type: "text", configuration: { label: "Y" } }] }
        },
        { id: "price", type: "number", configuration: { label: "Price", suffix: "$" } },
        { id: "year", type: "number", configuration: { label: "Year" } },
        { id: "weight", type: "number", configuration: { label: "Weight", suffix: "kg" } }
      ])
    );
    const blank = await modelOf(runtime, { rendition: "blank" });
    const rows = (model: PrintModel, id: string): number => (model.nodes.find((node): node is PrintGrid => node.kind === "grid" && node.id === id)?.rows.length ?? -1);
    expect(rows(blank, "many")).toBe(10);
    expect(rows(blank, "few")).toBe(2);
    runtime.setValue("price", 1250.5);
    runtime.setValue("year", 2026);
    runtime.setValue("weight", "70.25");
    const english = await modelOf(runtime);
    expect(field(english, "price").answer).toMatchObject({ text: "1250.5$" });
    expect(field(english, "year").answer).toMatchObject({ text: "2026" });
    const french = await modelOf(runtime, { locale: "fr" });
    // The French decimal comma, the no-break space before a sign, no grouping, the stored precision.
    expect(field(french, "price").answer).toMatchObject({ text: "1250,5\u00a0$" });
    expect(field(french, "year").answer).toMatchObject({ text: "2026" });
    expect(field(french, "weight").answer).toMatchObject({ text: "70,25 kg" });
  });

  it("words the paper in the form's language from its translations, and the host's texts over them", async () => {
    const translations: FormTranslations = {
      fr: {
        form: { title: { text: "Demande", source: sourceHash("Intake") } },
        components: { name: { label: { text: "Nom complet", source: sourceHash("Full name") } } },
        texts: {
          form: {
            printEmpty: { text: "Aucune réponse", source: "x" },
            printPageNumber: { text: "Page {{page}} de {{pages}}", source: "x" },
            printChosen: { text: "Choisi", source: "x" },
            dateMonth: { text: "Mois", source: "x" }
          }
        }
      }
    } as unknown as FormTranslations;
    const runtime = runtimeOf(definition(intake, { translations }));
    runtime.setLocale("fr");
    runtime.setValue("born", "2026-03-15");
    const model = await modelOf(runtime);
    expect(model.lang).toBe("fr");
    expect(model.title).toBe("Demande");
    expect(field(model, "name").label).toBe("Nom complet");
    expect(field(model, "born").answer).toMatchObject({ text: "15 mars 2026" });
    expect(model.words).toMatchObject({ notAnswered: "Aucune réponse", chosen: "Choisi", pageNumber: "Page {{page}} de {{pages}}" });
    const html = buildPrintDocument(model);
    expect(html).toContain('content: "Page " counter(page) " de " counter(pages);');
    expect(html).toContain("Aucune réponse");
    // English is the only built-in wording: an untranslated key reads in English.
    expect(model.words.rowNumber).toBe("#");

    const host = await modelOf(runtime, { texts: { printEmpty: "—" } });
    expect(host.words.notAnswered).toBe("—");
  });

  it("prints the host's receipt above the fields", async () => {
    const model = await modelOf(runtimeOf(definition(intake)), {
      notice: { title: "Received", message: { default: "Thank you", locales: { fr: "Merci" } }, details: [{ label: "Confirmation number", value: "GC-48213" }] }
    });
    expect(model.notice).toEqual({ kind: "success", kindWord: "Success: ", title: "Received", message: "Thank you", details: [{ label: "Confirmation number", value: "GC-48213" }] });
    const doc = parse(buildPrintDocument(model));
    expect(doc.querySelector(".datum-print__notice")?.textContent).toContain("Confirmation numberGC-48213");
    expect(doc.querySelector(".datum-print__notice")!.compareDocumentPosition(doc.querySelector('[data-component-id="name"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the filled rendition", () => {
  const grid = {
    id: "items",
    type: "dataGrid",
    configuration: { label: "Items" },
    collection: { collectionPath: "items" },
    children: {
      content: [
        { id: "qty", type: "number", configuration: { label: "Quantity", suffix: "kg" } },
        { id: "sku", type: "text", configuration: { label: "SKU" } }
      ]
    }
  } satisfies ComponentNode;
  const form = (): FormDefinition => definition([...intake, grid, { id: "ref", type: "text", configuration: { label: "Reference" } }]);
  const answered = (): FormRuntime => {
    const runtime = runtimeOf(form());
    runtime.setValue("name", "Ada Lovelace");
    runtime.setValue("amount", 1250);
    runtime.setValue("weight", 70);
    runtime.setValue("born", "2026-03-15");
    runtime.setValue("colour", "g");
    runtime.setValue("pets", { cat: true, dog: false });
    runtime.setValue("city", "tor");
    runtime.setValue("agree", true);
    runtime.setValue("notes", "line one\nline two");
    runtime.setValue("doc", { storage: "base64", name: "scan.pdf", type: "application/pdf", size: 2048, data: "" });
    runtime.setValue("items[0].qty", 3);
    runtime.setValue("items[0].sku", "A-1");
    runtime.addRow("items");
    runtime.setValue("items[1].qty", 5);
    return runtime;
  };

  it("is the paper form's shapes with the answers in: the value without its affixes, a select's options with the chosen one marked, a date's parts with their values", async () => {
    const model = await modelOf(answered(), { rendition: "filled" });
    expect(model.rendition).toBe("filled");
    // Text and number: the value alone (a number in the locale's words), the affixes kept apart, the room a blank box leaves.
    expect(field(model, "name")).toMatchObject({ empty: false, answer: { shape: "text", text: "Ada Lovelace", lines: 1, multiline: false } });
    expect(field(model, "amount").answer).toEqual({ shape: "text", text: "1250", lines: 1, multiline: false, prefix: "$", suffix: ".00" });
    expect(field(model, "weight").answer).toEqual({ shape: "text", text: "70", lines: 1, multiline: false, suffix: "kg" });
    // A textarea keeps its rows as the minimum room.
    expect(field(model, "notes").answer).toMatchObject({ shape: "text", text: "line one\nline two", multiline: true, lines: 3 });
    expect(field(model, "city").answer).toEqual({
      shape: "choices",
      multiple: false,
      single: false,
      options: [
        { label: "Ottawa", chosen: false },
        { label: "Toronto", chosen: true }
      ]
    });
    // Radio, checkboxes, checkbox and file as the answers print has them.
    const plain = await modelOf(answered());
    for (const id of ["colour", "pets", "agree", "doc"]) {
      expect(field(model, id)).toEqual(field(plain, id));
    }
    expect(field(model, "doc").answer).toEqual({ shape: "files", names: ["scan.pdf"] });
    // The button prints no more than it does on the other renditions.
    expect(all(model.nodes).some((node) => node.id === "send")).toBe(false);
  });

  it("writes a date's parts in the locale's order, the month as the locale's name, and leaves an unanswered or unreadable date's boxes empty", async () => {
    const runtime = answered();
    expect(field(await modelOf(runtime, { rendition: "filled" }), "born").answer).toEqual({
      shape: "date-parts",
      parts: [
        { part: "month", label: "Month", size: 2, value: "March" },
        { part: "day", label: "Day", size: 2, value: "15" },
        { part: "year", label: "Year", size: 4, value: "2026" }
      ],
      text: "March 15, 2026"
    });
    const french = field(await modelOf(runtime, { rendition: "filled", locale: "fr" }), "born").answer as { parts: Array<{ part: string; value?: string }> };
    expect(french.parts.map((part) => [part.part, part.value])).toEqual([
      ["day", "15"],
      ["month", "mars"],
      ["year", "2026"]
    ]);
    runtime.setValue("born", "");
    const none = field(await modelOf(runtime, { rendition: "filled" }), "born");
    expect(none.empty).toBe(true);
    expect((none.answer as { parts: Array<{ value?: string }> }).parts.map((part) => part.value)).toEqual([undefined, undefined, undefined]);
    runtime.setValue("born", "2026-02-31");
    expect((field(await modelOf(runtime, { rendition: "filled" }), "born").answer as { parts: Array<{ value?: string }> }).parts.map((part) => part.value)).toEqual([undefined, undefined, undefined]);
  });

  it("writes all three of a date's boxes in the Gregorian calendar the stored date is in, even where the locale's own is another", async () => {
    const runtime = runtimeOf(definition([{ id: "born", type: "date", configuration: { label: "Born" } }]));
    runtime.setValue("born", "2026-03-15");
    for (const locale of ["fa", "fa-IR", "ps"]) {
      const answer = field(await modelOf(runtime, { rendition: "filled", locale }), "born").answer as { parts: Array<{ part: string; value?: string }>; text?: string };
      const byPart = Object.fromEntries(answer.parts.map((part) => [part.part, part.value]));
      // The month is Gregorian March (its own name, or the digit 3), never a Persian or Pashto-calendar month beside a Gregorian day and year.
      expect(byPart["day"], locale).toBe("15");
      expect(byPart["year"], locale).toBe("2026");
      expect(byPart["month"], locale).toMatch(/^(3|مارس|مارچ|مارچ)$/u);
      // The one-line date reads the same calendar: it holds the Gregorian year.
      expect(answer.text, locale).toMatch(/2026|۲۰۲۶/u);
    }
  });

  it("names the month in its own, standalone form, never the form a full date inflects it to", async () => {
    const runtime = runtimeOf(definition([{ id: "born", type: "date", configuration: { label: "Born" } }]));
    runtime.setValue("born", "2026-03-15");
    const month = async (locale: string): Promise<string | undefined> =>
      (field(await modelOf(runtime, { rendition: "filled", locale }), "born").answer as { parts: Array<{ part: string; value?: string }> }).parts.find((part) => part.part === "month")?.value;
    expect(await month("ru")).toBe("март");
    expect(await month("pl")).toBe("marzec");
    expect(await month("cs")).toBe("březen");
    // A locale that writes the month as a number has no name to give: digits.
    expect(await month("ja")).toBe("3");
  });

  it("keeps a stored select value that is not among its options, as a chosen option after the listed ones", async () => {
    const runtime = answered();
    runtime.setValue("city", "van");
    expect(field(await modelOf(runtime, { rendition: "filled" }), "city").answer).toEqual({
      shape: "choices",
      multiple: false,
      single: false,
      options: [
        { label: "Ottawa", chosen: false },
        { label: "Toronto", chosen: false },
        { label: "van", chosen: true }
      ]
    });
    // A listed value adds nothing, and an unanswered select adds no empty option.
    runtime.setValue("city", "tor");
    expect((field(await modelOf(runtime, { rendition: "filled" }), "city").answer as { options: unknown[] }).options).toHaveLength(2);
    runtime.setValue("city", "");
    expect((field(await modelOf(runtime, { rendition: "filled" }), "city").answer as { options: unknown[] }).options).toHaveLength(2);
  });

  it("words a filled date as one line wherever it is drawn as one: a grid cell, the answer text", async () => {
    const form = definition([
      {
        id: "events",
        type: "dataGrid",
        configuration: { label: "Events" },
        collection: { collectionPath: "events" },
        children: { content: [{ id: "on", type: "date", configuration: { label: "On" } }] }
      }
    ]);
    const runtime = runtimeOf(form);
    runtime.setValue("events[0].on", "2026-03-15");
    for (const [locale, words] of [
      ["en-US", "March 15, 2026"],
      ["ja", "2026年3月15日"]
    ] as const) {
      const model = await modelOf(runtime, { rendition: "filled", locale });
      const cell = (model.nodes.find((node): node is PrintGrid => node.kind === "grid")!.rows[0]!.cells[0])!;
      expect(printAnswerText(cell), locale).toBe(words);
      expect((cell.answer as { text?: string }).text, locale).toBe(words);
      for (const theme of [basicPrintTheme, datumPrintTheme]) {
        expect(parse(buildPrintDocument(model, { theme })).querySelector('[data-component-id="events"] tbody td')?.textContent, `${locale} ${theme.id}`).toBe(words);
      }
    }
    // An unreadable date has no words, in a cell as in the boxes.
    runtime.setValue("events[0].on", "2026-02-31");
    const bad = (await modelOf(runtime, { rendition: "filled" })).nodes.find((node): node is PrintGrid => node.kind === "grid")!.rows[0]!.cells[0]!;
    expect(printAnswerText(bad)).toBe("");
  });

  it("marks an unanswered field empty, leaves the required mark to the blank form, and prints the given grid rows only", async () => {
    const runtime = answered();
    const model = await modelOf(runtime, { rendition: "filled" });
    expect(field(model, "ref")).toMatchObject({ empty: true, answer: { shape: "text", text: "" } });
    const items = model.nodes.find((node): node is PrintGrid => node.kind === "grid")!;
    // Two given rows, no padding rows; the cells are built as the filled form builds a field.
    expect(items.rows.map((row) => row.cells.map((cell) => (cell.answer.shape === "text" ? [cell.answer.text, cell.answer.suffix, cell.empty] : []))))
      .toEqual([
        [["3", "kg", false], ["A-1", undefined, false]],
        [["5", "kg", false], ["", undefined, true]]
      ]);
    const blank = await modelOf(runtime, { rendition: "blank" });
    expect(blank.nodes.find((node): node is PrintGrid => node.kind === "grid")!.rows.length).toBe(3);
    // A grid nobody filled in prints the rows the form opens it with, as the answers print does, and no more.
    const untouched = runtimeOf(form());
    const rowsOf = async (rendition: "answers" | "filled"): Promise<number> => (await modelOf(untouched, { rendition })).nodes.find((node): node is PrintGrid => node.kind === "grid")!.rows.length;
    expect(await rowsOf("filled")).toBe(await rowsOf("answers"));
  });

  it("prints the components the answers print does: a field printed only when answered, a hidden one with its note", async () => {
    const live = definition([
      { id: "subscribe", type: "checkbox", configuration: { label: "Subscribe" } },
      { id: "email", type: "text", configuration: { label: "Email", print: { show: "always", note: "Only if subscribed." } }, rules: { visibleWhen: "subscribe" } },
      { id: "reference", type: "text", configuration: { label: "Reference", print: { show: "answered" } } }
    ]);
    const ids = async (rendition: "answers" | "filled", runtime: FormRuntime): Promise<string[]> => all((await modelOf(runtime, { rendition })).nodes).map((node) => node.id);
    const runtime = runtimeOf(live);
    expect(await ids("filled", runtime)).toEqual(await ids("answers", runtime));
    expect(await ids("filled", runtime)).toEqual(["subscribe", "email"]);
    expect(field(await modelOf(runtime, { rendition: "filled" }), "email").note).toBe("Only if subscribed.");
    runtime.setValue("reference", "A-1");
    expect(await ids("filled", runtime)).toEqual(["subscribe", "email", "reference"]);
  });

  it("keeps a plugin type's answer as text, as the answers print does", async () => {
    const runtime = runtimeOf(definition([{ id: "rating", type: "rating-stars", configuration: { label: "Rating" } }]));
    runtime.setValue("rating", "4");
    expect(field(await modelOf(runtime, { rendition: "filled" }), "rating").answer).toMatchObject({ shape: "text", text: "4" });
  });

  it("draws the answers inside the paper form's boxes, in the basic and the Datum theme", async () => {
    const model = await modelOf(answered(), { rendition: "filled" });
    for (const theme of [basicPrintTheme, datumPrintTheme]) {
      const html = buildPrintDocument(model, { theme });
      const doc = parse(html);
      expect(doc.querySelector(".datum-print--filled")).not.toBeNull();
      const in_ = (id: string, selector: string): string | undefined => doc.querySelector(`[data-component-id="${id}"] ${selector}`)?.textContent ?? undefined;
      expect(in_("name", ".dp-line--filled")).toBe("Ada Lovelace");
      // Affixes beside the box, never joined into it.
      expect(in_("amount", ".dp-line--filled")).toBe("1250");
      expect([...doc.querySelectorAll('[data-component-id="amount"] .dp-affixed > span')].map((node) => node.textContent)).toEqual(["$", ".00"]);
      // The date's parts, each with its value; the select's options, one marked.
      expect([...doc.querySelectorAll('[data-component-id="born"] .dp-date__part')].map((part) => part.textContent)).toEqual(["MonthMarch", "Day15", "Year2026"]);
      expect([...doc.querySelectorAll('[data-component-id="city"] .dp-choice')].map((choice) => choice.classList.contains("is-chosen"))).toEqual([false, true]);
      expect(in_("doc", ".dp-line--filled")).toBe("scan.pdf");
      // The grid: two rows, its cells drawn as a table's.
      expect([...doc.querySelectorAll('[data-component-id="items"] tbody tr')].map((row) => row.textContent)).toEqual(["13kgA-1", "25kg"]);
      // An unanswered field is an empty box, never the words; the required mark belongs to the blank form.
      expect(in_("ref", ".dp-line--filled")).toBe("");
      expect(html).not.toContain("Not answered");
      expect(doc.querySelector(".dp-req")).toBeNull();
      expect(doc.querySelectorAll(".dp-empty")).toHaveLength(0);
      // A grid with no rows given is an empty box, not the words.
      const bare = { ...model, nodes: model.nodes.map((node) => (node.kind === "grid" ? { ...node, rows: [] } : node)) };
      const bareDoc = parse(buildPrintDocument(bare, { theme }));
      expect(bareDoc.querySelector('[data-component-id="items"] table')).toBeNull();
      expect(bareDoc.querySelector('[data-component-id="items"] .dp-line--filled')?.textContent).toBe("");
      expect(bareDoc.querySelector('[data-component-id="items"]')?.textContent).not.toContain("Not answered");
    }
  });

  it("lets a box grow with its answer: a minimum height, never a fixed one, and a long unbroken string breaks", async () => {
    const runtime = runtimeOf(definition([{ id: "ref", type: "text", configuration: { label: "Reference", suffix: "kg" } }, { id: "notes", type: "textarea", configuration: { label: "Notes", rows: 3 } }]));
    const long = "x".repeat(400);
    runtime.setValue("ref", long);
    runtime.setValue("notes", `${long}\n${long}`);
    const model = await modelOf(runtime, { rendition: "filled" });
    for (const theme of [basicPrintTheme, datumPrintTheme]) {
      const html = buildPrintDocument(model, { theme });
      const doc = parse(html);
      // The whole string is in the markup, in a box that is allowed to grow.
      expect(doc.querySelector('[data-component-id="ref"] .dp-line--filled')?.textContent).toBe(long);
      expect(doc.querySelector('[data-component-id="notes"] .dp-line--filled')?.getAttribute("style")).toBe("--lines:3");
      const css = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
      const rule = /\.dp-line--filled \{([^}]*)\}/.exec(css)?.[1] ?? "";
      expect(rule).toContain("min-height: calc(var(--lines, 1) * 2.2em)");
      expect(rule).toContain("height: auto");
      expect(rule).toContain("overflow-wrap: anywhere");
      expect(rule).not.toMatch(/(^|[^-])height: [0-9]/);
      // On a filled form the box keeps a width worth writing in beside a long value, and a long affix wraps in its share of the line.
      expect(css).toMatch(/\.datum-print--filled \.dp-affixed \.dp-lines \{[^}]*min-width: 8em/);
      // A short sign is never squeezed onto two lines (it does not shrink); a long one wraps within its share.
      expect(css).toMatch(/\.datum-print--filled \.dp-affixed > span \{[^}]*flex: 0 0 auto[^}]*max-width: 40%[^}]*overflow-wrap: break-word/);
      expect(css).not.toMatch(/\.dp-affixed > span \{[^}]*white-space: nowrap/);
      // The blank form and the answers print keep the plain rules: no 8em minimum, no nowrap affix.
      expect(css).toMatch(/\.dp-affixed \.dp-lines \{ flex: 1; \}/);
      expect(css).not.toMatch(/(^|\n)\.dp-affixed[^{]*\{[^}]*(min-width|nowrap)/);
      // Answer boxes break a long word in every rendition.
      expect(html).toMatch(/\.datum-print__answer \{[^}]*overflow-wrap: anywhere/);
    }
  });
});

describe("a printed journey", () => {
  const journeyForm = (): FormDefinition =>
    definition(
      [
        { id: "name", type: "text", configuration: { label: "Name" } },
        { id: "kind", type: "radio", configuration: { label: "Kind", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } },
        { id: "extra", type: "text", configuration: { label: "Extra" } },
        { id: "phone", type: "text", configuration: { label: "Phone" } }
      ],
      {
        journey: {
          journeys: [
            {
              id: "apply",
              name: "Apply",
              pages: [
                { id: "first", title: "About you", components: ["name", "kind"], routes: [{ when: "kind != \"b\"", to: "last" }] },
                { id: "detour", title: "More", components: ["extra"] },
                { id: "last", components: [{ id: "ref", type: "journey-field", configuration: { componentId: "phone" } }] }
              ]
            }
          ]
        }
      } as unknown as Partial<FormDefinition>
    );

  it("prints the pages on the person's path as headed sections, in path order, whatever page is open", async () => {
    const runtime = runtimeOf(journeyForm());
    runtime.setValue("name", "Ada");
    expect(runtime.journeyView()?.pageId).toBe("first");
    const model = await modelOf(runtime);
    const sections = model.nodes as PrintSection[];
    // "More" is off the path; the untitled last page is headed by its first labelled component.
    expect(sections.map((section) => [section.from, section.title, section.children.map((child) => child.id)])).toEqual([
      ["page", "About you", ["name", "kind"]],
      ["page", "Phone", ["phone"]]
    ]);
    runtime.setValue("kind", "b");
    const detour = await modelOf(runtime);
    expect((detour.nodes as PrintSection[]).map((section) => section.title)).toEqual(["About you", "More", "Phone"]);
    expect(parse(buildPrintDocument(detour)).querySelectorAll(".dp-section--page")).toHaveLength(3);
  });

  it("keeps a screen-only container's fields off paper when a page lists them by id", async () => {
    const form = definition(
      [
        { id: "name", type: "text", configuration: { label: "Name" } },
        {
          id: "office",
          type: "fieldset",
          configuration: { label: "Office use", print: { on: "screen" } },
          children: { content: [{ id: "officer", type: "text", configuration: { label: "Officer" } }] }
        }
      ],
      { journey: { journeys: [{ id: "apply", name: "Apply", pages: [{ id: "only", title: "You", components: ["name", "officer"] }] }] } } as unknown as Partial<FormDefinition>
    );
    const runtime = runtimeOf(form);
    runtime.setValue("officer", "B-77");
    const model = await modelOf(runtime);
    expect(all(model.nodes).map((node) => node.id)).toEqual(["page:only", "name"]);
    expect(buildPrintDocument(model)).not.toContain("B-77");
  });

  it("prints an always field from a page off the path, with its note, in the journey's order, answers and blank alike", async () => {
    const form = journeyForm();
    const nodes = form.root.children!.content!;
    nodes.splice(2, 1, { id: "extra", type: "text", configuration: { label: "Extra", print: { show: "always", note: "Only for B." } } }, { id: "aside", type: "text", configuration: { label: "Aside" } });
    const pages = (form as unknown as { journey: { journeys: Array<{ pages: Array<{ components: unknown[] }> }> } }).journey.journeys[0]!.pages;
    pages[1]!.components = ["extra", "aside"];
    const runtime = runtimeOf(form);
    for (const rendition of ["answers", "blank"] as const) {
      const model = await modelOf(runtime, { rendition });
      const sections = model.nodes as PrintSection[];
      expect(sections.map((section) => [section.title, section.children.map((child) => child.id)])).toEqual([
        ["About you", ["name", "kind"]],
        ["More", ["extra"]],
        ["Phone", ["phone"]]
      ]);
      expect(field(model, "extra").note).toBe("Only for B.");
    }
    // A read-only form prints what it shows: the path alone.
    expect((await modelOf(runtime, { mode: "readonly" })).nodes.map((node) => (node as PrintSection).title)).toEqual(["About you", "Phone"]);
    // On the path, it prints as any field, with no note.
    runtime.setValue("kind", "b");
    const onPath = await modelOf(runtime);
    expect((onPath.nodes as PrintSection[]).map((section) => [section.title, section.children.map((child) => child.id)])).toEqual([
      ["About you", ["name", "kind"]],
      ["More", ["extra", "aside"]],
      ["Phone", ["phone"]]
    ]);
    expect(field(onPath, "extra").note).toBeUndefined();
  });
});

describe("a panel's look on paper", () => {
  const LOOKS = ["plain", "outlined", "shaded", "card"] as const;
  const panel = (id: string, cssClass: unknown, type = "panel"): ComponentNode => ({
    id,
    type,
    configuration: { label: `Box ${id}`, ...(cssClass !== undefined ? { cssClass } : {}) },
    children: { content: [{ id: `${id}-field`, type: "text", configuration: { label: `Field ${id}` } }] }
  });
  const groupOf = (model: PrintModel, id: string): PrintNode | undefined => all(model.nodes).find((node) => node.kind === "group" && node.id === id);
  const lookOf = (model: PrintModel, id: string): unknown => (groupOf(model, id) as { look?: unknown } | undefined)?.look;

  it("reaches the model for a panel only: the last look class wins, anything else is ignored, no class is no look", async () => {
    const model = await modelOf(
      runtimeOf(
        definition([
          ...LOOKS.map((look) => panel(look, `panel-${look}`)),
          panel("none", undefined),
          panel("other", "is-compact panel-wide"),
          panel("several", "panel-card panel-shaded"),
          panel("list", ["panel-outlined", "is-compact"]),
          panel("malformed", "panel-card bad;class panel-"),
          panel("fieldset", "panel-card", "fieldset")
        ])
      )
    );
    expect(LOOKS.map((look) => lookOf(model, look))).toEqual([...LOOKS]);
    expect(lookOf(model, "none")).toBeUndefined();
    expect(lookOf(model, "other")).toBeUndefined();
    expect(lookOf(model, "several")).toBe("shaded");
    expect(lookOf(model, "list")).toBe("outlined");
    expect(lookOf(model, "malformed")).toBe("card");
    // A fieldset with the same class gets none; "look" is no key of its group at all.
    expect(groupOf(model, "fieldset")).toBeDefined();
    expect("look" in (groupOf(model, "fieldset") as object)).toBe(false);
  });

  it("gives an unlabelled panel no look: it still dissolves into the run around it", async () => {
    const unlabelled: ComponentNode = {
      id: "bare",
      type: "panel",
      configuration: { cssClass: "panel-card" },
      children: { content: [{ id: "bare-field", type: "text", configuration: { label: "Bare" } }] }
    };
    const model = await modelOf(runtimeOf(definition([unlabelled])));
    expect(all(model.nodes).some((node) => node.kind === "group")).toBe(false);
    expect(model.nodes.some((node) => node.kind === "field" && node.id === "bare-field")).toBe(true);
  });

  it("is drawn by every theme in every rendition: the look class on the group's element, its rule in the sheet", async () => {
    for (const rendition of ["answers", "blank", "filled"] as const) {
      const model = await modelOf(runtimeOf(definition([...LOOKS.map((look) => panel(look, `panel-${look}`)), panel("none", undefined), panel("fieldset", "panel-card", "fieldset")])), { rendition });
      for (const theme of [basicPrintTheme, datumPrintTheme]) {
        const html = buildPrintDocument(model, { theme });
        const doc = parse(html);
        for (const look of LOOKS) {
          const element = doc.querySelector(`[data-component-id="${look}"] > section`);
          expect(element?.className, `${theme.id} ${rendition} ${look}`).toBe(`dp-group dp-group--${look}`);
        }
        expect(doc.querySelector('[data-component-id="none"] > section')?.className).toBe("dp-group");
        expect(doc.querySelector('[data-component-id="fieldset"] > section')?.className).toBe("dp-group");
        // The heading stays inside the box, and keeps its keep-with-next mark.
        expect(doc.querySelector('[data-component-id="card"] > section > h2.dp-heading.datum-print__keep')?.textContent).toBe("Box card");
        for (const look of ["outlined", "shaded", "card"]) {
          expect(theme.css, `${theme.id} sheet ${look}`).toContain(`.dp-group--${look}`);
        }
      }
    }
    const sheet = basicPrintTheme.css;
    expect(sheet).toMatch(/\.dp-group--outlined, \.dp-group--card \{ border: 1px solid/);
    expect(sheet).toMatch(/\.dp-group--shaded \{[^}]*background:[^}]*print-color-adjust: exact/);
    expect(sheet).toMatch(/\.dp-group--card > \.dp-heading \{[^}]*background:/);
    expect(sheet).toMatch(/box-decoration-break: clone/);
    expect(sheet).toMatch(/-webkit-box-decoration-break: clone/);
    // Datum's tokens: shaded has no border, the band sits on its sunken surface.
    expect(datumPrintTheme.css).toMatch(/\.dp-group--shaded \{ border: 0; background: #/);
    expect(datumPrintTheme.css).toMatch(/\.dp-group--card > \.dp-heading \{ background: #/);
  });
});

describe("the print document", () => {
  async function plainModel(configuration: Record<string, unknown> = { title: "Intake" }, locale?: string): Promise<PrintModel> {
    const runtime = runtimeOf(definition([{ id: "name", type: "text", configuration: { label: "Name" } }], {}, configuration));
    if (locale) {
      runtime.setLocale(locale);
    }
    return modelOf(runtime);
  }

  it("is a complete document that runs no script: CSP, lang and dir, the title, the page box with its running parts", async () => {
    const html = buildPrintDocument(await plainModel());
    expect(html.startsWith('<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8">')).toBe(true);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`);
    expect(html).toContain("<title>Intake</title>");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('@top-left { content: "Intake";');
    expect(html).toContain('@bottom-left { content: "Intake";');
    expect(html).toContain('@bottom-right { content: "Page " counter(page) " of " counter(pages);');
    expect(html).toContain("@page { margin: 16mm;");
    expect(html).not.toContain("zoom");
    const doc = parse(html);
    expect(doc.querySelector("h1.dp-title")?.textContent).toBe("Intake");
    expect(doc.body.getAttribute("data-print-theme")).toBe("basic");
    expect(doc.querySelector('.datum-print__field[data-component-id="name"]')).not.toBeNull();
  });

  it("follows the form's configuration.print and the host's paper; puts the running parts on the right for RTL", async () => {
    const off = await plainModel({ title: "Intake", print: { header: { start: "" }, footer: { start: "", end: "" }, titleOnFirstPage: false, scale: 0.8 } });
    const html = buildPrintDocument({ ...off, page: { ...off.page, size: "A4", margin: "10mm 12mm" } });
    expect(html).not.toContain("@top-");
    expect(html).not.toContain("@bottom-");
    expect(html).toContain("size: A4; margin: 10mm 12mm;");
    expect(html).toContain(".datum-print { zoom: 0.8; }");
    expect(parse(html).querySelector("h1")).toBeNull();
    expect(html).toContain("<title>Intake</title>");

    const rtl = buildPrintDocument(await plainModel({ title: "Intake" }, "ar-EG"));
    expect(rtl).toContain('<html lang="ar-EG" dir="rtl">');
    expect(rtl).toContain('@top-right { content: "Intake";');
    expect(rtl).toContain("@bottom-left { content: \"Page \"");

    // A margin that is no CSS length never reaches the page box.
    const source = await readPrintSource(runtimeOf(definition([])), { page: { margin: "1in; } body { color: red" } });
    expect(source.page.margin).toBe("16mm");
  });

  it("keeps a hostile title and answer inert: escaped in markup, a CSS string in the margin box", async () => {
    const runtime = runtimeOf(definition([{ id: "name", type: "text", configuration: { label: "Name" } }], {}, { title: 'Evil"; } body { color: red } x{\n</style><script>alert(1)</script>' }));
    runtime.setValue("name", '<img src=x onerror="alert(1)">');
    const html = buildPrintDocument(await modelOf(runtime));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain('content: "Evil\\"; } body { color: red } x{\\a \\3c /style>\\3c script>alert(1)\\3c /script>";');
  });

  it("links the host's stylesheets and fonts for a theme of the host's, never for Datum's own, and never a script", async () => {
    const model = await plainModel();
    const theme: PrintTheme = { id: "ds", label: "DS", css: ".x { color: red; } </style><b>", draw: {} };
    const assets = {
      fonts: [{ url: "fonts.css" }],
      stylesheets: [{ url: "https://cdn.example/ds.css", integrity: "sha384-abc" }, { url: "javascript:alert(1)" }],
      scripts: [{ url: "https://cdn.example/ds.js" }]
    };
    const html = buildPrintDocument(model, { theme, assets, base: "https://host.example/app/" });
    expect(html).toContain('<link rel="stylesheet" href="https://host.example/app/fonts.css"><link rel="stylesheet" href="https://cdn.example/ds.css" integrity="sha384-abc" crossorigin="anonymous">');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("ds.js");
    expect(html).toContain(".x { color: red; } <\\/style><b>");
    // The basic theme's sheet stands under the theme's, which draws with the basic drawers.
    expect(html.indexOf(".dp-field {")).toBeLessThan(html.indexOf(".x { color: red; }"));
    for (const own of [basicPrintTheme, datumPrintTheme]) {
      expect(buildPrintDocument(model, { theme: own, assets, base: "https://host.example/" })).not.toContain("<link");
    }
    expect(buildPrintDocument(model, { theme: datumPrintTheme })).toContain('data-print-theme="datum"');
  });

  it("refuses a drawer that hands back a raw string: the whole document prints with the basic theme, saying why", async () => {
    const runtime = runtimeOf(definition([{ id: "name", type: "text", configuration: { label: "Name" } }]));
    runtime.setValue("name", "<b>bold</b>");
    const source = await readPrintSource(runtime, { render: { journeyKit: EagerJourneyRenderKit } });
    const careless = { id: "careless", label: "Careless", css: ".careless {}", draw: { field: (f: PrintField) => `<p>${f.label}: ${(f.answer as { text: string }).text}</p>` } } as unknown as PrintTheme;
    const prepared = preparePrint(source, { theme: careless });
    expect(prepared.theme).toBe("basic");
    expect(prepared.fellBack).toEqual(['the "field" drawer of the "careless" print theme returned a raw string, not printHtml markup']);
    expect(prepared.html).not.toContain("<b>bold</b>");
    expect(prepared.html).not.toContain(".careless");

    const throwing: PrintTheme = { id: "broken", label: "Broken", css: "", draw: { title: () => { throw new Error("boom"); } } };
    expect(preparePrint(source, { theme: throwing }).fellBack).toEqual(['the "title" drawer of the "broken" print theme threw: boom']);

    // A theme that draws with printHtml prints as itself, its own words over the engine's.
    const careful: PrintTheme = {
      id: "careful",
      label: "Careful",
      css: "",
      texts: { printEmpty: "(blank)" },
      draw: { field: (f, { model }) => printHtml`<p class="careful">${f.label}: ${f.empty ? model.words.notAnswered : (f.answer as { text: string }).text}</p>` }
    };
    const own = preparePrint(source, { theme: careful });
    expect(own.theme).toBe("careful");
    expect(own.html).toContain('<p class="careful">Name: &lt;b&gt;bold&lt;/b&gt;</p>');
    runtime.setValue("name", "");
    expect(preparePrint(await readPrintSource(runtime), { theme: careful }).html).toContain("Name: (blank)");
    expect(printModelOf(await readPrintSource(runtime)).words.notAnswered).toBe("Not answered");
  });

  it("hands a theme the renderer's tag: a theme built apart from the engine draws through context.html, never its own copy", async () => {
    // A second instance of the tag's module, as a theme bundling its own copy of the engine would hold.
    // @ts-expect-error The query names a second instance of the module, which TypeScript cannot resolve.
    const copy = (await import("../form-engine/render/print/safe-html.js?theme-copy")) as typeof import("../form-engine/render/print/safe-html.js");
    expect(copy.printHtml).not.toBe(printHtml);
    const runtime = runtimeOf(definition([{ id: "name", type: "text", configuration: { label: "Name" } }]));
    runtime.setValue("name", "<b>bold</b>");
    const source = await readPrintSource(runtime, { render: { journeyKit: EagerJourneyRenderKit } });
    const bundled: PrintTheme = { id: "bundled", label: "Bundled", css: "", draw: { title: (title) => copy.printHtml`<h1 class="own">${title}</h1>` } };
    expect(preparePrint(source, { theme: bundled }).fellBack).toEqual(['the "title" drawer of the "bundled" print theme returned object, not printHtml markup']);
    const handed: PrintTheme = {
      id: "handed",
      label: "Handed",
      css: "",
      draw: {
        title: (title, { html }) => html`<h1 class="own">${title}</h1>`,
        group: (group, children, { html, heading }) => html`<section class="own-group">${group.legend !== undefined && heading(group.level, "own-heading", group.legend)}${children}</section>`,
        field: (f, { html, join, model }) => join([html`<p class="own-label">${f.label}</p>`, html`<p class="own-answer">${f.empty ? model.words.notAnswered : (f.answer as { text: string }).text}</p>`])
      }
    };
    const prepared = preparePrint(source, { theme: handed });
    expect(prepared.theme).toBe("handed");
    expect(prepared.fellBack).toBeUndefined();
    expect(prepared.html).toContain('<h1 class="own">Intake</h1>');
    expect(prepared.html).toContain('<p class="own-answer">&lt;b&gt;bold&lt;/b&gt;</p>');
  });

  it("draws a rendition only with a theme that declares it: one that does not falls back to the basic theme with the reason", async () => {
    const runtime = runtimeOf(definition([{ id: "name", type: "text", configuration: { label: "Name", suffix: "kg" } }]));
    runtime.setValue("name", "70");
    const drawn: PrintTheme = {
      id: "branchy",
      label: "Branchy",
      css: ".branchy {}",
      draw: { field: (f, { html }) => html`<p class="branchy">${f.label}: ${(f.answer as { text: string }).text}</p>` }
    };
    const filledSource = await readPrintSource(runtime, { render: { journeyKit: EagerJourneyRenderKit }, rendition: "filled" });
    // No `renditions`: it draws answers and blank, so a filled form is the basic theme's, with the reason.
    const fellBack = preparePrint(filledSource, { theme: drawn });
    expect(fellBack.theme).toBe("basic");
    expect(fellBack.fellBack).toEqual(['the "branchy" print theme does not draw the "filled" rendition (it declares "answers", "blank")']);
    expect(fellBack.html).not.toContain("branchy");
    for (const rendition of ["answers", "blank"] as const) {
      const prepared = preparePrint(await readPrintSource(runtime, { render: { journeyKit: EagerJourneyRenderKit }, rendition }), { theme: drawn });
      expect(prepared.theme, rendition).toBe("branchy");
      expect(prepared.fellBack, rendition).toBeUndefined();
    }
    // Declaring it, the theme draws it.
    const declared = preparePrint(filledSource, { theme: { ...drawn, renditions: ["answers", "blank", "filled"] } });
    expect(declared.theme).toBe("branchy");
    expect(declared.fellBack).toBeUndefined();
    expect(declared.html).toContain('<p class="branchy">Name: 70</p>');
    // Datum's own themes declare all three.
    for (const own of [basicPrintTheme, datumPrintTheme]) {
      expect(own.renditions).toEqual(["answers", "blank", "filled"]);
      expect(preparePrint(filledSource, { theme: own }).fellBack).toBeUndefined();
    }
  });
});

describe("the print frame", () => {
  const frames = (): HTMLIFrameElement[] => [...document.querySelectorAll<HTMLIFrameElement>(`iframe[${PRINT_FRAME_ATTR}]`)];

  function stubPrint(): ReturnType<typeof vi.fn> {
    const printed = vi.fn();
    const observer = new MutationObserver(() => {
      for (const frame of frames()) {
        if (frame.contentWindow) {
          frame.contentWindow.print = printed;
        }
      }
    });
    observer.observe(document.body, { childList: true });
    return printed;
  }

  it("asks before it opens a frame when nothing needs checking, and opens none on a refusal", async () => {
    const asked = vi.fn(() => false);
    const result = await presentPrintDocument("<!doctype html><p>x</p>", document, { theme: "basic", beforePrint: asked });
    expect(asked).toHaveBeenCalledWith({ html: "<!doctype html><p>x</p>", theme: "basic" });
    expect(result.frame).toBeUndefined();
    expect(frames()).toHaveLength(0);
  });

  it("runs the theme's self-check once the document is in, prints the fallback when it fails, and says why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const printed = stubPrint();
    const seen: unknown[] = [];
    const result = await presentPrintDocument('<!doctype html><html><body><p class="ds">themed</p></body></html>', document, {
      theme: "ds",
      selfCheck: (doc) => (doc.querySelector(".ds") ? ["the --ds-* tokens are missing: no stylesheet was given"] : []),
      fallback: () => ({ html: "<!doctype html><html><body><p>basic</p></body></html>", theme: "basic" }),
      beforePrint: (presented) => {
        seen.push(presented);
        return true;
      }
    });
    expect(seen).toEqual([{ html: "<!doctype html><html><body><p>basic</p></body></html>", theme: "basic", fellBack: ["the --ds-* tokens are missing: no stylesheet was given"] }]);
    expect(printed).toHaveBeenCalledTimes(1);
    expect(result.frame?.contentDocument?.body.textContent).toBe("basic");
    expect(warn.mock.calls[0]?.[0]).toMatch(/"ds" print theme cannot print as it should .*printed with the "basic" print theme/);

    // A check that passes keeps the theme; a refusal after it removes the frame it opened.
    const kept = await presentPrintDocument("<!doctype html><p>themed</p>", document, { theme: "ds", selfCheck: () => [], fallback: () => ({ html: "", theme: "basic" }), beforePrint: () => false });
    expect(kept).toMatchObject({ theme: "ds" });
    expect(kept.frame).toBeUndefined();
    expect(frames().filter((frame) => frame !== result.frame)).toHaveLength(0);
  });

  it("builds the frame's document without an HTML sink in it: placed through CSSOM, its policy first, its sheets applied, its body brought in", async () => {
    stubPrint();
    const html =
      '<!doctype html><html lang="fr" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"><title>Demande</title>' +
      '<style>.a { font-weight: 600; }</style><style>.b { color: red; }</style></head><body data-print-theme="basic"><p class="a">Nom</p></body></html>';
    const result = await presentPrintDocument(html, document, { theme: "basic", selfCheck: () => [], fallback: () => ({ html, theme: "basic" }) });
    const frame = result.frame!;
    // Each property set through CSSOM, which a strict style-src allows (a style attribute in markup it refuses).
    expect(frame.style.position).toBe("fixed");
    expect(frame.style.left).toBe("-10000px");
    expect(frame.style.opacity).toBe("0");
    const doc = frame.contentDocument!;
    expect(doc.documentElement.lang).toBe("fr");
    expect(doc.documentElement.dir).toBe("rtl");
    expect(doc.title).toBe("Demande");
    expect(doc.head.firstElementChild?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(doc.body.getAttribute("data-print-theme")).toBe("basic");
    expect(doc.querySelector("p.a")?.textContent).toBe("Nom");
    // The sheets are adopted as constructed sheets, in order; no <style> element is placed.
    expect(doc.querySelectorAll("style")).toHaveLength(0);
    expect(doc.adoptedStyleSheets.map((sheet) => [...sheet.cssRules].map((rule) => rule.cssText).join(""))).toEqual([".a { font-weight: 600; }", ".b { color: red; }"]);
    expect(doc.defaultView!.getComputedStyle(doc.querySelector("p.a")!).fontWeight).toBe("600");
  });

  it("parses through the datum-print Trusted Types policy when the page has Trusted Types, and names it when the page refuses it", async () => {
    stubPrint();
    const created: string[] = [];
    const parsedThrough: unknown[] = [];
    const win = window as unknown as { trustedTypes?: unknown };
    const parseFromString = DOMParser.prototype.parseFromString;
    vi.spyOn(DOMParser.prototype, "parseFromString").mockImplementation(function (this: DOMParser, input: string, type: DOMParserSupportedType) {
      parsedThrough.push(input);
      return parseFromString.call(this, String(input), type);
    });
    win.trustedTypes = {
      createPolicy: (name: string, rules: { createHTML(input: string): string }) => {
        created.push(name);
        return { createHTML: (input: string) => ({ trusted: rules.createHTML(input), toString: () => rules.createHTML(input) }) };
      }
    };
    try {
      const result = await presentPrintDocument("<!doctype html><p>kept</p>", document, { selfCheck: () => [], fallback: () => ({ html: "", theme: "basic" }) });
      expect(created).toEqual(["datum-print"]);
      expect(parsedThrough[0]).toMatchObject({ trusted: "<!doctype html><p>kept</p>" });
      expect(result.frame?.contentDocument?.body.textContent).toBe("kept");
      // A second print reuses the policy: a second createPolicy of one name throws in a browser.
      await presentPrintDocument("<!doctype html><p>again</p>", document, { selfCheck: () => [], fallback: () => ({ html: "", theme: "basic" }) });
      expect(created).toEqual(["datum-print"]);
    } finally {
      delete win.trustedTypes;
    }

    // Another page, whose trusted-types directive leaves the policy out: print refuses, naming it.
    const host = document.createElement("iframe");
    document.body.append(host);
    const hostWindow = host.contentWindow as unknown as Window & { trustedTypes?: unknown; DOMParser: typeof DOMParser };
    hostWindow.trustedTypes = {
      createPolicy: () => {
        throw new TypeError("Policy datum-print disallowed.");
      }
    };
    vi.spyOn(hostWindow.DOMParser.prototype, "parseFromString").mockImplementation(() => {
      throw new TypeError("Failed to execute 'parseFromString' on 'DOMParser': This document requires 'TrustedHTML' assignment.");
    });
    await expect(presentPrintDocument("<!doctype html><p>x</p>", host.contentDocument!, { selfCheck: () => [] })).rejects.toThrow(/trusted-types lit-html datum-print/);
    expect(host.contentDocument!.querySelector(`iframe[${PRINT_FRAME_ATTR}]`)).toBeNull();
  });
});

describe("<datum-form-renderer>.print()", () => {
  const frames = (): HTMLIFrameElement[] => [...document.querySelectorAll<HTMLIFrameElement>(`iframe[${PRINT_FRAME_ATTR}]`)];

  async function mounted(form: FormDefinition, setup?: (element: DatumFormRendererElement) => void): Promise<{ element: DatumFormRendererElement; runtime: FormRuntime }> {
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    setup?.(element);
    const runtime = runtimeOf(form);
    element.runtime = runtime;
    document.body.append(element);
    await element.painted();
    return { element, runtime };
  }

  async function printed(element: DatumFormRendererElement, options?: Parameters<DatumFormRendererElement["print"]>[0]): Promise<DatumPrintDetail[]> {
    const seen: DatumPrintDetail[] = [];
    const listener = (event: Event): void => {
      event.preventDefault();
      seen.push((event as CustomEvent<DatumPrintDetail>).detail);
    };
    element.addEventListener("datum-print", listener);
    try {
      await element.print(options);
    } finally {
      element.removeEventListener("datum-print", listener);
    }
    return seen;
  }

  it("hands the print document to a datum-print listener with its theme, and opens no frame when the listener takes it", async () => {
    const { element, runtime } = await mounted(definition(intake));
    runtime.setValue("name", "Ada");
    const [detail] = await printed(element);
    expect(detail?.theme).toBe("basic");
    expect(detail?.fellBack).toBeUndefined();
    const doc = parse(detail!.html);
    expect(doc.querySelector('[data-component-id="name"] .dp-answer')?.textContent).toBe("Ada");
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toBe("script-src 'none'");
    expect(frames()).toHaveLength(0);
    // The element itself is untouched: still the live form.
    expect(element.shadowRoot!.querySelector<HTMLInputElement>('[data-component-id="name"] input')?.readOnly).toBe(false);
  });

  it("prints a blank form when asked, with the print theme set on the element and the host's paper", async () => {
    const { element, runtime } = await mounted(definition(intake), (el) => {
      el.printTheme = datumPrintTheme;
    });
    runtime.setValue("name", "Ada");
    const [detail] = await printed(element, { rendition: "blank", page: { size: "letter", margin: "0.5in" } });
    expect(detail?.theme).toBe("datum");
    expect(detail!.html).not.toContain("Ada");
    expect(detail!.html).toContain("size: letter; margin: 0.5in;");
    expect(parse(detail!.html).querySelector(".datum-print--blank")).not.toBeNull();
  });

  it("prints the paper form with the answers in it when asked for the filled rendition", async () => {
    const { element, runtime } = await mounted(definition(intake));
    runtime.setValue("name", "Ada");
    runtime.setValue("born", "2026-03-15");
    const [detail] = await printed(element, { rendition: "filled" });
    const doc = parse(detail!.html);
    expect(doc.querySelector(".datum-print--filled")).not.toBeNull();
    expect(doc.querySelector('[data-component-id="name"] .dp-line--filled')?.textContent).toBe("Ada");
    expect(doc.querySelector('[data-component-id="born"] .dp-date__part')?.textContent).toBe("MonthMarch");
    expect(detail!.html).not.toContain("Not answered");
  });

  it("falls back to the basic theme when the element's theme fails its self-check, and says so on datum-print", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const theme: PrintTheme = { id: "ds", label: "DS", css: "", draw: {}, selfCheck: () => ["no --ds-* tokens"] };
    const { element } = await mounted(definition(intake), (el) => {
      el.printTheme = theme;
    });
    const [detail] = await printed(element);
    expect(detail).toMatchObject({ theme: "basic", fellBack: ["no --ds-* tokens"] });
    expect(parse(detail!.html).body.getAttribute("data-print-theme")).toBe("basic");
    // The frame opened to run the check is gone once the listener took the document.
    expect(frames()).toHaveLength(0);
  });

  it("prints what a read-only form shows, and a journey's path pages from any page", async () => {
    const { element } = await mounted(
      definition(
        [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "phone", type: "text", configuration: { label: "Phone" } }
        ],
        { journey: { journeys: [{ id: "apply", name: "Apply", pages: [{ id: "first", title: "You", components: ["name"] }, { id: "second", title: "Reach you", components: ["phone"] }] }] } } as unknown as Partial<FormDefinition>
      ),
      (el) => {
        el.journeyKit = EagerJourneyRenderKit;
      }
    );
    // Only the first page is on screen; both are on paper, headed, in order.
    expect(element.shadowRoot!.querySelector('[data-component-id="phone"]')).toBeNull();
    const [detail] = await printed(element);
    const doc = parse(detail!.html);
    expect([...doc.querySelectorAll(".dp-section--page > .dp-heading")].map((heading) => heading.textContent)).toEqual(["You", "Reach you"]);
    expect(doc.querySelector('[data-component-id="phone"]')).not.toBeNull();
  });
});

describe("the print configuration on paper", () => {
  const ids = (model: PrintModel): string[] => all(model.nodes).map((node) => node.id);
  const nodeOf = (model: PrintModel, id: string): PrintNode => {
    const found = all(model.nodes).find((node) => node.id === id);
    if (!found) {
      throw new Error(`no printed node ${id}`);
    }
    return found;
  };

  it("prints a form with no print block exactly as the defaults say: the page box pinned whole", async () => {
    const model = await modelOf(runtimeOf(definition([{ id: "name", type: "text", configuration: { label: "Name" } }])));
    expect(model.rendition).toBe("answers");
    expect(model.page).toEqual({
      size: "auto",
      margin: "16mm",
      titleOnFirstPage: true,
      scale: 1,
      journeyPageBreaks: false,
      header: { start: [{ text: "Intake" }] },
      footer: { start: [{ text: "Intake" }], end: [{ text: "Page " }, { counter: "page" }, { text: " of " }, { counter: "pages" }] }
    });
    const box = basicPrintTheme.marginBox!;
    expect(printPageCss(model, box)).toBe(`
@page { margin: 16mm; @top-left { content: "Intake"; ${box} white-space: nowrap; } @bottom-left { content: "Intake"; ${box} white-space: nowrap; } @bottom-right { content: "Page " counter(page) " of " counter(pages); ${box} } }
html, body { margin: 0; padding: 0; background: #fff; color-scheme: light; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
/* On screen (a host that cancels datum-print and shows the document) the page margin is padding. */
@media screen { body { padding: 16mm; } }

/* A field never splits from its label or across a page. */
.datum-print__field, .datum-print__content, .datum-print__notice, .datum-print__grid tr { break-inside: avoid; page-break-inside: avoid; }
/* A heading, and what a theme marks .datum-print__keep (a group's heading and hint), stay with what follows. */
.datum-print h1, .datum-print h2, .datum-print h3, .datum-print h4, .datum-print h5, .datum-print h6, .datum-print__keep { break-after: avoid; page-break-after: avoid; }
/* A long answer wraps: never clipped, never one line past the margin. */
.datum-print__answer { white-space: pre-wrap; overflow-wrap: anywhere; orphans: 3; widows: 3; }
/* A table's head repeats on every page it runs onto; its columns share the page width. */
.datum-print__grid table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.datum-print__grid thead { display: table-header-group; }
.datum-print img { max-width: 100%; }
/* The author's breaks: a component that starts a new sheet (never a blank first one), a container kept on one sheet. */
.datum-print__break-before { break-before: page; page-break-before: always; }
.datum-print > .datum-print__break-before:first-child { break-before: auto; page-break-before: auto; }
.datum-print__keep-together { break-inside: avoid; page-break-inside: avoid; }
`);
    // No wrapper carries a break class it was not asked for.
    const html = buildPrintDocument(model);
    expect(parse(html).querySelector(".datum-print__break-before, .datum-print__keep-together")).toBeNull();
    expect(html).toContain('<div class="datum-print__field" data-component-id="name">');
  });

  it("words the page number line in the print's locale, and puts the bands on the other side for RTL", async () => {
    const runtime = runtimeOf(definition([{ id: "name", type: "text", configuration: { label: "Name" } }]));
    runtime.setLocale("ar-EG");
    const css = printPageCss(await modelOf(runtime), "");
    expect(css).toContain('@top-right { content: "Intake";  white-space: nowrap; }');
    expect(css).toContain('@bottom-right { content: "Intake";  white-space: nowrap; }');
    expect(css).toMatch(/@bottom-left \{ content: "[^"]*" counter\(page\)/);
  });

  it("puts a break before a component and keeps a container together: classes on the wrappers, rules in the sheet", async () => {
    const model = await modelOf(
      runtimeOf(
        definition([
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "intro", type: "html", configuration: { content: "<p>Part two</p>", print: { breakBefore: true } } },
          { id: "phone", type: "text", configuration: { label: "Phone", print: { breakBefore: true, keepTogether: true } } },
          {
            id: "address",
            type: "fieldset",
            configuration: { label: "Address", print: { breakBefore: true, keepTogether: true } },
            children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] }
          },
          {
            id: "assets",
            type: "dataGrid",
            configuration: { label: "Assets", print: { keepTogether: true } },
            collection: { collectionPath: "assets" },
            children: { content: [{ id: "what", type: "text", configuration: { label: "What" } }] }
          }
        ])
      )
    );
    expect(nodeOf(model, "intro")).toMatchObject({ kind: "content", breakBefore: true });
    // A field is never split anyway: keep-together is a container's.
    expect(nodeOf(model, "phone")).toMatchObject({ kind: "field", breakBefore: true });
    expect(nodeOf(model, "phone")).not.toHaveProperty("keepTogether");
    expect(nodeOf(model, "address")).toMatchObject({ kind: "group", breakBefore: true, keepTogether: true });
    expect(nodeOf(model, "assets")).toMatchObject({ kind: "grid", keepTogether: true });
    expect(nodeOf(model, "assets")).not.toHaveProperty("breakBefore");
    expect(nodeOf(model, "name")).not.toHaveProperty("breakBefore");
    for (const theme of [basicPrintTheme, datumPrintTheme]) {
      const doc = parse(buildPrintDocument(model, { theme }));
      expect(doc.querySelector('[data-component-id="intro"]')?.className).toBe("datum-print__content datum-print__break-before");
      expect(doc.querySelector('[data-component-id="phone"]')?.className).toBe("datum-print__field datum-print__break-before");
      expect(doc.querySelector('[data-component-id="address"]')?.className).toBe("datum-print__group datum-print__break-before datum-print__keep-together");
      expect(doc.querySelector('[data-component-id="assets"]')?.className).toBe("datum-print__grid datum-print__keep-together");
      expect(doc.querySelector('[data-component-id="name"]')?.className).toBe("datum-print__field");
      const sheet = [...doc.querySelectorAll("style")].at(-1)!.textContent!;
      expect(sheet).toContain(".datum-print__break-before { break-before: page; page-break-before: always; }");
      expect(sheet).toContain(".datum-print__keep-together { break-inside: avoid; page-break-inside: avoid; }");
      // A break before the very first thing on paper starts no blank sheet.
      expect(sheet).toContain(".datum-print > .datum-print__break-before:first-child { break-before: auto; page-break-before: auto; }");
    }
  });

  it("gives an unnamed group's break to its first node, and a tabs container's to its first tab", async () => {
    const model = await modelOf(
      runtimeOf(
        definition([
          { id: "name", type: "text", configuration: { label: "Name" } },
          {
            id: "bare",
            type: "fieldset",
            configuration: { print: { breakBefore: true } },
            children: { content: [{ id: "first", type: "text", configuration: { label: "First" } }, { id: "second", type: "text", configuration: { label: "Second" } }] }
          },
          {
            id: "tabs",
            type: "tabs",
            configuration: { tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }], print: { breakBefore: true } },
            children: { a: [{ id: "inA", type: "text", configuration: { label: "In A" } }], b: [{ id: "inB", type: "text", configuration: { label: "In B" } }] }
          }
        ])
      )
    );
    expect(ids(model)).not.toContain("bare");
    expect(nodeOf(model, "first")).toMatchObject({ breakBefore: true });
    expect(nodeOf(model, "second")).not.toHaveProperty("breakBefore");
    const tabSections = model.nodes.filter((node): node is PrintSection => node.kind === "section" && node.from === "tab");
    expect(tabSections.map((section) => section.breakBefore)).toEqual([true, undefined]);
  });

  it("keeps an unnamed group together in a run of its own, which the renderer draws; a tabs or steps container keeps nothing", async () => {
    const model = await modelOf(
      runtimeOf(
        definition([
          { id: "name", type: "text", configuration: { label: "Name" } },
          {
            id: "bare",
            type: "panel",
            configuration: { print: { breakBefore: true, keepTogether: true } },
            children: { content: [{ id: "first", type: "text", configuration: { label: "First" } }, { id: "second", type: "text", configuration: { label: "Second" } }] }
          },
          {
            id: "tabs",
            type: "tabs",
            configuration: { tabs: [{ id: "a", label: "A" }], print: { keepTogether: true } },
            children: { a: [{ id: "inA", type: "text", configuration: { label: "In A" } }] }
          },
          {
            id: "wizard",
            type: "steps",
            configuration: { print: { keepTogether: true } },
            children: { content: [{ id: "s1", type: "step", configuration: { label: "Step one", print: { keepTogether: true } }, children: { content: [{ id: "inS1", type: "text", configuration: { label: "In one" } }] } }] }
          }
        ])
      )
    );
    expect(nodeOf(model, "bare")).toMatchObject({ kind: "run", breakBefore: true, keepTogether: true });
    expect((nodeOf(model, "bare") as { children: PrintNode[] }).children.map((node) => node.id)).toEqual(["first", "second"]);
    expect(nodeOf(model, "first")).not.toHaveProperty("breakBefore");
    expect(all(model.nodes).filter((node) => node.kind === "section" && node.from === "tab").every((node) => !("keepTogether" in node))).toBe(true);
    expect(ids(model)).not.toContain("wizard");
    expect(nodeOf(model, "s1")).toMatchObject({ kind: "section", keepTogether: true });
    for (const theme of [basicPrintTheme, datumPrintTheme]) {
      const doc = parse(buildPrintDocument(model, { theme }));
      const run = doc.querySelector<HTMLElement>('[data-component-id="bare"]')!;
      expect(run.className).toBe("datum-print__run datum-print__break-before datum-print__keep-together");
      expect([...run.querySelectorAll("[data-component-id]")].map((element) => element.getAttribute("data-component-id"))).toEqual(["first", "second"]);
      expect(run.querySelector("legend, h2, h3")).toBeNull();
    }
  });

  it("never breaks before what leads the form, so the first sheet never holds the title or the receipt alone", async () => {
    const fields = (first: Record<string, unknown>): ComponentNode[] => [
      {
        id: "lead",
        type: "fieldset",
        configuration: { label: "Applicant", print: { breakBefore: true } },
        children: { content: [{ id: "name", type: "text", configuration: { label: "Name", print: { breakBefore: true } } }] }
      },
      { id: "phone", type: "text", configuration: { label: "Phone", print: first } }
    ];
    const model = await modelOf(runtimeOf(definition(fields({ breakBefore: true }))), { notice: { kind: "success", title: "Received", message: "Thank you" } });
    expect(model.notice).toBeDefined();
    expect(nodeOf(model, "lead")).not.toHaveProperty("breakBefore");
    expect(nodeOf(model, "name")).not.toHaveProperty("breakBefore");
    // A later one keeps its break.
    expect(nodeOf(model, "phone")).toMatchObject({ breakBefore: true });
    const doc = parse(buildPrintDocument(model));
    expect([...doc.querySelectorAll(".datum-print__break-before")].map((element) => element.getAttribute("data-component-id"))).toEqual(["phone"]);
  });

  it("moves a break on the first component of a named group, tab, step or journey page up to the container, so its heading never sits alone", async () => {
    const pages = { journey: { journeys: [{ id: "apply", name: "Apply", pages: [{ id: "one", title: "One", components: ["name"] }, { id: "two", title: "Two", components: ["household"] }] }] } } as unknown as Partial<FormDefinition>;
    const model = await modelOf(
      runtimeOf(
        definition(
          [
            { id: "name", type: "text", configuration: { label: "Name" } },
            {
              id: "household",
              type: "panel",
              configuration: { label: "Household" },
              children: {
                content: [
                  { id: "inner", type: "panel", configuration: { label: "Inner" }, children: { content: [{ id: "size", type: "text", configuration: { label: "Size", print: { breakBefore: true } } }, { id: "other", type: "text", configuration: { label: "Other" } }] } },
                  { id: "pets", type: "text", configuration: { label: "Pets" } }
                ]
              }
            }
          ],
          pages
        )
      )
    );
    // The chain of first children rises to the outermost container that is not the form's lead.
    const page = nodeOf(model, "page:two") as PrintSection;
    expect(page.breakBefore).toBe(true);
    expect(nodeOf(model, "household")).not.toHaveProperty("breakBefore");
    expect(nodeOf(model, "inner")).not.toHaveProperty("breakBefore");
    expect(nodeOf(model, "size")).not.toHaveProperty("breakBefore");
    // The page that leads the form never starts a sheet.
    expect(nodeOf(model, "page:one")).not.toHaveProperty("breakBefore");

    const plain = await modelOf(
      runtimeOf(
        definition([
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "household", type: "panel", configuration: { label: "Household" }, children: { content: [{ id: "size", type: "text", configuration: { label: "Size", print: { breakBefore: true } } }, { id: "other", type: "text", configuration: { label: "Other" } }] } },
          {
            id: "tabs",
            type: "tabs",
            configuration: { tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
            children: { a: [{ id: "inA", type: "text", configuration: { label: "In A" } }], b: [{ id: "inB", type: "text", configuration: { label: "In B", print: { breakBefore: true } } }] }
          }
        ])
      )
    );
    expect(nodeOf(plain, "household")).toMatchObject({ kind: "group", breakBefore: true });
    expect(nodeOf(plain, "size")).not.toHaveProperty("breakBefore");
    const tabSections = plain.nodes.filter((node): node is PrintSection => node.kind === "section" && node.from === "tab");
    expect(tabSections.map((section) => section.breakBefore)).toEqual([undefined, true]);
    expect(nodeOf(plain, "inB")).not.toHaveProperty("breakBefore");
  });

  it("starts each journey page after the first on a new sheet when the form asks", async () => {
    const pages = { journey: { journeys: [{ id: "apply", name: "Apply", pages: [{ id: "one", title: "One", components: ["name"] }, { id: "two", title: "Two", components: ["phone"] }, { id: "three", title: "Three", components: ["city"] }] }] } } as unknown as Partial<FormDefinition>;
    const fields: ComponentNode[] = [
      { id: "name", type: "text", configuration: { label: "Name" } },
      { id: "phone", type: "text", configuration: { label: "Phone" } },
      { id: "city", type: "text", configuration: { label: "City" } }
    ];
    const on = await modelOf(runtimeOf(definition(fields, pages, { title: "Intake", print: { journeyPageBreaks: true } })));
    expect(on.page.journeyPageBreaks).toBe(true);
    expect((on.nodes as PrintSection[]).map((section) => [section.id, section.breakBefore])).toEqual([
      ["page:one", undefined],
      ["page:two", true],
      ["page:three", true]
    ]);
    const doc = parse(buildPrintDocument(on));
    expect([...doc.querySelectorAll(".datum-print__break-before")].map((element) => element.getAttribute("data-component-id"))).toEqual(["page:two", "page:three"]);
    const off = await modelOf(runtimeOf(definition(fields, pages)));
    expect((off.nodes as PrintSection[]).some((section) => section.breakBefore)).toBe(false);
  });

  it("prints the form's default rendition when the call names none, and the call's when it does, offered or not", async () => {
    const form = definition([{ id: "name", type: "text", configuration: { label: "Name" } }], {}, { title: "Intake", print: { renditions: ["blank", "answers"], defaultRendition: "blank" } });
    expect((await modelOf(runtimeOf(form))).rendition).toBe("blank");
    expect((await modelOf(runtimeOf(form), { rendition: "answers" })).rendition).toBe("answers");
    expect((await modelOf(runtimeOf(form), { rendition: "filled" })).rendition).toBe("filled");
    // An unusable rendition is none: the default.
    expect((await modelOf(runtimeOf(form), { rendition: "poster" as never })).rendition).toBe("blank");
    const firstOffered = definition([], {}, { print: { renditions: ["filled", "answers"] } });
    expect((await readPrintSource(runtimeOf(firstOffered))).rendition).toBe("filled");
  });

  it("leaves a screen-only component off the model with everything in it, on a live and on a read-only print, in every rendition", async () => {
    const form = definition([
      { id: "name", type: "text", configuration: { label: "Name" } },
      { id: "hint", type: "html", configuration: { content: "<p>Tap to continue</p>", print: { on: "screen" } } },
      {
        id: "office",
        type: "panel",
        configuration: { label: "Office", print: { on: "screen" } },
        children: { content: [{ id: "officer", type: "text", configuration: { label: "Officer", print: { show: "always" } } }] }
      }
    ]);
    const runtime = runtimeOf(form);
    runtime.setValue("officer", "B-77");
    const live = await modelOf(runtime);
    expect(ids(live)).toEqual(["name"]);
    expect(buildPrintDocument(live)).not.toContain("B-77");
    for (const rendition of ["answers", "blank", "filled"] as const) {
      const readOnly = await modelOf(runtime, { mode: "readonly", rendition });
      expect(ids(readOnly)).toEqual(["name"]);
      expect(buildPrintDocument(readOnly)).not.toContain("B-77");
      expect(ids(await modelOf(runtime, { rendition }))).toEqual(["name"]);
    }
  });

  it("leaves a screen-only field off whatever else it asks, and a read-only print still ignores print.show", async () => {
    const form = definition([
      { id: "name", type: "checkbox", configuration: { label: "Name" } },
      // "answered" on a blank form prints as on screen, but never a screen-only field.
      { id: "office", type: "text", configuration: { label: "Office", print: { on: "screen", show: "answered" } } },
      { id: "always", type: "text", configuration: { label: "Always", print: { show: "always" } }, rules: { visibleWhen: "name" } }
    ]);
    const runtime = runtimeOf(form);
    expect(ids(await modelOf(runtime, { rendition: "blank" }))).toEqual(["name", "always"]);
    expect(ids(await modelOf(runtime, { rendition: "blank", mode: "readonly" }))).toEqual(["name"]);
    runtime.setValue("name", true);
    expect(ids(await modelOf(runtime, { mode: "readonly" }))).toEqual(["name", "always"]);
  });
});
