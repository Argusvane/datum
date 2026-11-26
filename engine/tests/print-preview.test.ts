// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  PrintPreview,
  measurePrintDocument,
  selectableId,
  selectableTarget,
  type PrintMeasurer,
  type PrintPreviewWords
} from "../form-engine/builder/print/print-preview.js";
import type { PreparedPrint } from "../form-engine/render/print/document.js";
import type { PrintModel, PrintNode } from "../form-engine/render/print/model.js";

/**
 * The Print workspace's sheet: what it shows of the print document, what a click on it selects,
 * the names on its accent lines and its running strips. jsdom lays nothing out, so the measure is
 * the test's own where a layout would matter.
 */

const html = (label: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body><p data-marker>${label}</p></body></html>`;

function modelOf(extra: Partial<PrintModel> = {}, nodes: PrintNode[] = []): PrintModel {
  return {
    rendition: "answers",
    locale: "en",
    lang: "en",
    dir: "ltr",
    page: { size: "letter", margin: "16mm", titleOnFirstPage: true, scale: 1, journeyPageBreaks: false, header: { start: [{ text: "HEAD" }] }, footer: {} },
    nodes,
    words: { notAnswered: "", chosen: "", rowNumber: "", required: "", pageNumber: "" },
    text: (key: string) => key,
    ...extra
  } as unknown as PrintModel;
}

const preparedOf = (label: string, extra: Partial<PreparedPrint> = {}, model: PrintModel = modelOf()): PreparedPrint => ({ html: html(label), model, theme: "chosen", ...extra });

const noLayout: PrintMeasurer = () => ({ height: 0, blocks: [] });

let mounted: HTMLElement | undefined;

function mount(options: { words?: Partial<PrintPreviewWords>; measure?: PrintMeasurer; select?: (id: string) => void } = {}): PrintPreview {
  const box = document.createElement("div");
  const sheet = document.createElement("div");
  box.append(sheet);
  document.body.append(box);
  mounted = box;
  return new PrintPreview(box, sheet, {
    select: options.select ?? (() => undefined),
    measure: () => options.measure ?? noLayout,
    words: {
      estimated: (page) => `Page ${page}`,
      forced: (_page, id, title) => `New page: ${title ?? id ?? ""}`,
      frameTitle: () => "The printed form",
      ...options.words
    }
  });
}

afterEach(() => {
  mounted?.remove();
  mounted = undefined;
});

const bodyText = (preview: PrintPreview): string => preview.frame.contentDocument?.body.textContent?.trim() ?? "";

describe("the sheet's self-check", () => {
  it("shows the basic theme and says why, when the chosen theme's check finds problems", async () => {
    const preview = mount();
    let checked = 0;
    const basic = modelOf({ page: { ...modelOf().page, margin: "10mm" } });
    const shown = await preview.show(
      preparedOf("CHOSEN", {
        selfCheck: () => {
          checked += 1;
          return ["a font did not load"];
        },
        fallback: () => ({ html: html("BASIC"), model: basic, theme: "basic" })
      }),
      "letter"
    );
    expect(checked).toBe(1);
    expect(bodyText(preview)).toBe("BASIC");
    expect(shown?.fellBack).toEqual(["a font did not load"]);
  });

  it("keeps the chosen theme when its check is clean, and says nothing", async () => {
    const preview = mount();
    const shown = await preview.show(preparedOf("CHOSEN", { selfCheck: () => [], fallback: () => ({ html: html("BASIC"), model: modelOf(), theme: "basic" }) }), "letter");
    expect(bodyText(preview)).toBe("CHOSEN");
    expect(shown?.fellBack).toBeUndefined();
  });

  it("carries a refusal's reasons through, so the notice stays", async () => {
    const preview = mount();
    const shown = await preview.show(preparedOf("BASIC", { fellBack: ["the theme refused"] }), "letter");
    expect(shown?.fellBack).toEqual(["the theme refused"]);
  });
});

describe("what a click on the sheet selects", () => {
  it("names a repeating section's row and a tab's section by the component that holds them, and a journey page by nothing", () => {
    expect(selectableId("name")).toBe("name");
    expect(selectableId("items#0")).toBe("items");
    expect(selectableId("tabs1:tab-a")).toBe("tabs1");
    expect(selectableId("page:two")).toBeUndefined();
    expect(selectableId("")).toBeUndefined();
    expect(selectableId(null)).toBeUndefined();
  });

  it("walks out past a journey page's section to the component around it, and agrees for the click and the hover", async () => {
    const picked: string[] = [];
    const preview = mount({ select: (id) => picked.push(id) });
    await preview.show(preparedOf("x"), "letter");
    const doc = preview.frame.contentDocument!;
    doc.body.innerHTML = `<div data-component-id="household"><h2 data-component-id="page:two"><span id="heading">Two</span></h2></div>
      <div data-component-id="tabs1:tab-a"><span id="tab">A</span></div>
      <div data-component-id="items"><fieldset data-component-id="items#0"><legend id="row">Row 1</legend></fieldset></div>
      <p id="bare">Nothing</p>`;
    expect(selectableTarget(doc.getElementById("heading"))).toBe("household");
    expect(selectableTarget(doc.getElementById("tab"))).toBe("tabs1");
    expect(selectableTarget(doc.getElementById("row"))).toBe("items");
    expect(selectableTarget(doc.getElementById("bare"))).toBeUndefined();

    doc.getElementById("tab")!.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).MouseEvent("click", { bubbles: true, cancelable: true }));
    doc.getElementById("row")!.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(picked).toEqual(["tabs1", "items"]);
  });
});

describe("the accent lines and the strips", () => {
  const section = (id: string, title: string): PrintNode => ({ kind: "section", id, title, from: "page", level: 1, children: [] }) as unknown as PrintNode;
  const blocks = [
    { top: 0, height: 100, componentId: "name" },
    { top: 200, height: 100, breakBefore: true as const, componentId: "page:contact" },
    { top: 400, height: 100, breakBefore: true as const, componentId: "page:plain" },
    { top: 600, height: 100, breakBefore: true as const, componentId: "tabs1:tab-a" }
  ];

  it("names a section's break by its heading from the model, never by its internal id", async () => {
    const preview = mount({ measure: () => ({ height: 800, blocks }) });
    const tabs = { kind: "section", id: "tabs1:tab-a", title: "Details", from: "tab", level: 1, children: [] } as unknown as PrintNode;
    await preview.show(preparedOf("x", {}, modelOf({}, [section("page:contact", "Contact"), section("page:plain", ""), tabs])), "letter");
    const labels = [...preview.frame.ownerDocument.querySelectorAll('[data-print-break="forced"] .break-label')].map((label) => label.textContent);
    expect(labels).toEqual(["New page: Contact", "New page: ", "New page: Details"]);
  });

  it("names a repeating section's row break by the row's legend, never by its internal id", async () => {
    const preview = mount({ measure: () => ({ height: 800, blocks: [{ top: 0, height: 100, componentId: "lead" }, { top: 300, height: 100, breakBefore: true as const, componentId: "items#1" }] }) });
    const row = { kind: "group", id: "items#1", legend: "Row 2", level: 2, children: [] } as unknown as PrintNode;
    await preview.show(preparedOf("x", {}, modelOf({}, [row])), "letter");
    const labels = [...preview.frame.ownerDocument.querySelectorAll('[data-print-break="forced"] .break-label')].map((label) => label.textContent);
    expect(labels).toEqual(["New page: Row 2"]);
  });

  it("numbers the footer strip, at the sheet's foot, as the last page, and the header strip as the first", async () => {
    const preview = mount({ measure: () => ({ height: 1500, blocks: [{ top: 0, height: 100 }, { top: 500, height: 100, breakBefore: true as const }, { top: 1000, height: 100, breakBefore: true as const }] }) });
    const counters = [{ text: "Page " }, { counter: "page" }, { text: " of " }, { counter: "pages" }];
    const model = modelOf({ page: { ...modelOf().page, header: { start: counters }, footer: { start: counters } } } as unknown as Partial<PrintModel>);
    const shown = await preview.show(preparedOf("x", {}, model), "letter");
    const pages = shown!.pagination.pages;
    expect(pages).toBeGreaterThan(1);
    const text = (selector: string): string | null | undefined => preview.frame.ownerDocument.querySelector(selector)?.textContent;
    expect(text("[data-print-header]")).toBe(`Page 1 of ${pages}`);
    expect(text("[data-print-footer]")).toBe(`Page ${pages} of ${pages}`);
  });

  it("sets each strip's direction and language from the print, so a right-to-left form's start side is at the right", async () => {
    const preview = mount();
    await preview.show(preparedOf("x", {}, modelOf({ dir: "rtl", lang: "ar" })), "letter");
    const strip = preview.frame.ownerDocument.querySelector<HTMLElement>("[data-print-header]")!;
    expect(strip.getAttribute("dir")).toBe("rtl");
    expect(strip.getAttribute("lang")).toBe("ar");
    expect(preview.frame.ownerDocument.querySelector("[data-print-footer]")!.getAttribute("dir")).toBe("rtl");
    await preview.show(preparedOf("x", {}, modelOf()), "letter");
    expect(strip.getAttribute("dir")).toBe("ltr");
  });
});

describe("the hover and selection boxes", () => {
  const rectOf = (top: number, height: number): (() => DOMRect) => () => ({ top, height, left: 0, width: 100, right: 100, bottom: top + height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  const hover = (doc: Document, id: string): void => {
    doc.getElementById(id)!.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).MouseEvent("mouseover", { bubbles: true }));
  };

  it("outline a tab section, which has no wrapper of its own, over its sections' union", async () => {
    const preview = mount();
    await preview.show(preparedOf("x"), "letter");
    const doc = preview.frame.contentDocument!;
    doc.body.innerHTML = `<div data-component-id="tabs1:tab-a"><span id="a">A</span></div><div data-component-id="tabs1:tab-b"><span id="b">B</span></div>`;
    doc.body.getBoundingClientRect = rectOf(0, 200);
    const [first, second] = Array.from(doc.querySelectorAll<HTMLElement>("[data-component-id]"));
    first!.getBoundingClientRect = rectOf(0, 50);
    second!.getBoundingClientRect = rectOf(60, 40);
    hover(doc, "a");
    const box = preview.frame.ownerDocument.querySelector<HTMLElement>("[data-print-hover]");
    expect(box?.getAttribute("data-component-id")).toBe("tabs1");
    expect([box!.style.top, box!.style.height, box!.style.width]).toEqual(["0px", "100px", "100px"]);
    preview.markSelected("tabs1");
    const selection = preview.frame.ownerDocument.querySelector<HTMLElement>("[data-print-selection]");
    expect(selection?.getAttribute("data-component-id")).toBe("tabs1");
    expect([selection!.style.top, selection!.style.height]).toEqual(["0px", "100px"]);
  });

  it("outlines a steps container, which has no wrapper either, over its step sections", async () => {
    const preview = mount();
    const step = (id: string): PrintNode => ({ kind: "section", id, title: id, from: "step", container: "steps1", level: 1, children: [] }) as unknown as PrintNode;
    const other = { kind: "section", id: "elsewhere", title: "", from: "step", container: "steps2", level: 1, children: [] } as unknown as PrintNode;
    await preview.show(preparedOf("x", {}, modelOf({}, [step("s1"), step("s2"), other])), "letter");
    const doc = preview.frame.contentDocument!;
    doc.body.innerHTML = `<section data-component-id="s1"></section><section data-component-id="s2"></section><section data-component-id="elsewhere"></section>`;
    doc.body.getBoundingClientRect = rectOf(0, 300);
    const [one, two, three] = Array.from(doc.querySelectorAll<HTMLElement>("[data-component-id]"));
    one!.getBoundingClientRect = rectOf(10, 50);
    two!.getBoundingClientRect = rectOf(70, 30);
    three!.getBoundingClientRect = rectOf(200, 40);
    preview.markSelected("steps1");
    const selection = preview.frame.ownerDocument.querySelector<HTMLElement>("[data-print-selection]");
    expect(selection?.getAttribute("data-component-id")).toBe("steps1");
    expect([selection!.style.top, selection!.style.height]).toEqual(["10px", "90px"]);
  });
});

describe("measuring the document", () => {
  it("marks a block that has measured blocks inside it as a container", () => {
    const doc = document.implementation.createHTMLDocument("p");
    doc.body.innerHTML = `<div class="datum-print"><section class="datum-print__break-before" data-component-id="group"><div class="datum-print__field" data-component-id="a"></div><div class="datum-print__field" data-component-id="b"></div></section><div class="datum-print__field" data-component-id="c"></div></div>`;
    for (const element of Array.from(doc.querySelectorAll<HTMLElement>("*"))) {
      element.getBoundingClientRect = () => ({ top: 0, height: 10, left: 0, width: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    }
    const measured = measurePrintDocument(doc, 0);
    expect(measured.blocks.map((block) => [block.componentId, block.container === true])).toEqual([
      ["group", true],
      ["a", false],
      ["b", false],
      ["c", false]
    ]);
  });
});
