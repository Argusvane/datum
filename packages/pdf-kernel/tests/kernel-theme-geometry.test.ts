import { PDFDict, PDFName, PDFNumber, PDFRawStream, PDFString, decodePDFRawStream, type PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { PDF_KERNEL_FALLBACKS, type PdfBlock, type PdfDocument } from "@argusvane/datum-engine/render";
import { layoutDocument, type Drawable, type LayoutContext } from "../src/kernel/layout.js";
import { FontSet } from "../src/kernel/fonts.js";
import { layoutOnly, renderDocument } from "../src/kernel/render.js";
import { resolveLayoutSettings } from "../src/kernel/settings.js";
import { ENV, document, extractText, fonts, paragraph, reload } from "./helpers.js";

/** The theme geometry a document from the new engine carries: the form look at print size. */
const FORM_LOOK: Pick<PdfDocument, "controls" | "choice" | "fields" | "headings" | "table" | "box" | "panel" | "list" | "spacing"> = {
  controls: { borderWidth: 0.75, radius: 2, padding: 4, minHeight: 22, textareaRows: 3, fontSize: 10, valueFrame: "box", selectMark: "chevron" },
  choice: { size: 11, widgetSize: 11, borderWidth: 0.75, radius: 2, markStroke: 1.5, dotSize: 5, labelGap: 5, optionGap: 4, legendGap: 3, columns: 1 },
  fields: { labelToValue: 2, labelToControl: 2, labelToHint: 1, hintToControl: 3, hints: "shown", hintPosition: "afterLabel" },
  headings: { numbered: true, band: "surface", bandPadding: 3, titleRule: true, titleRuleWidth: 1 },
  table: { cellPadding: 4, borderWidth: 0.5, rowMinHeight: 12, headerWeight: 700 },
  box: { borderWidth: 0.75, padding: 6, radius: 2 },
  panel: { borderWidth: 0.75, radius: 2, padding: 6, headerPadding: 4 },
  list: { indent: 12, gap: 2, bullet: "•" },
  spacing: { ...PDF_KERNEL_FALLBACKS.spacing, labelValue: [0, 8], widget: [0, 8] }
};

/** Lays a document out and returns the first page's drawables, for geometry a PDF hides. */
async function drawables(doc: PdfDocument): Promise<Drawable[]> {
  const { PDFDocument } = await import("@cantoo/pdf-lib");
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const ctx: LayoutContext = {
    fonts: new FontSet(pdf, await fonts(), doc.typography.fallbacks ?? {}),
    typography: doc.typography,
    colors: doc.colors,
    settings: resolveLayoutSettings(doc),
    textDirection: doc.metadata.textDirection,
    images: new Map(),
    warnings: []
  };
  const laid = await layoutDocument(doc, ctx);
  return laid.pages[0]!.drawables;
}

/** A page's content streams, inflated and joined. */
function contentOf(pdf: PDFDocument, index = 0): string {
  const contents = pdf.getPage(index).node.Contents();
  const streams = contents instanceof PDFRawStream ? [contents] : (contents as unknown as { asArray(): unknown[] }).asArray();
  return streams
    .map((entry: unknown) => {
      const stream = pdf.context.lookup(entry as never) as PDFRawStream;
      return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
    })
    .join("\n");
}

const rects = (list: Drawable[]) => list.filter((entry): entry is Extract<Drawable, { kind: "rect" }> => entry.kind === "rect");
const lines = (list: Drawable[]) => list.filter((entry): entry is Extract<Drawable, { kind: "line" }> => entry.kind === "line");
const texts = (list: Drawable[]) => list.filter((entry): entry is Extract<Drawable, { kind: "text" }> => entry.kind === "text");
const marks = (list: Drawable[]) => list.filter((entry): entry is Extract<Drawable, { kind: "checkmark" }> => entry.kind === "checkmark");

describe("framed values", () => {
  it("draws the answer inside the theme's box: the column wide, rounded, filled and stroked, no shorter than the minimum", async () => {
    const doc = document([{ id: "v", kind: "labelValue", label: "Name", value: [{ text: "Ada" }], arrangement: "stacked", frame: true, control: "text" }], FORM_LOOK);
    const drawn = await drawables(doc);
    const [box] = rects(drawn);
    expect(box).toMatchObject({ rect: { x: 54, width: 612 - 108 }, fill: "#ffffff", stroke: { width: 0.75, color: "#999999" }, radius: 2 });
    expect(box!.rect.height).toBe(22);
    // The label sits above the box, the answer inside it.
    const [label, value] = texts(drawn);
    expect(label!.piece.text).toBe("Name");
    expect(value!.piece.text).toBe("Ada");
    expect(value!.x).toBe(54 + 4);
    expect(value!.baselineY).toBeGreaterThan(box!.rect.y);
    expect(value!.baselineY).toBeLessThan(box!.rect.y + box!.rect.height);
  });

  it("grows the box to the wrapped answer and a textarea's rows, never clipping", async () => {
    const long = "word ".repeat(120).trim();
    const doc = document(
      [
        { id: "a", kind: "labelValue", label: "Long", value: [{ text: long }], arrangement: "stacked", frame: true, control: "text" },
        { id: "b", kind: "labelValue", label: "Notes", value: [{ text: "one line" }], arrangement: "stacked", frame: true, control: "textarea" }
      ],
      FORM_LOOK
    );
    const drawn = await drawables(doc);
    const [longBox, notesBox] = rects(drawn);
    expect(longBox!.rect.height).toBeGreaterThan(22 + 13);
    // Three rows at 10pt × 1.35, plus the padding.
    expect(notesBox!.rect.height).toBeCloseTo(3 * 13.5 + 8, 3);
    const text = await extractText((await renderDocument(doc, await fonts(), ENV)).bytes);
    expect(text[0]).toContain("word word word");
  });

  it("moves a box that fits a page but not what is left of it to the next page, whole, with its label", async () => {
    const filler = Array.from({ length: 52 }, (_, index) => paragraph(`f${index}`, `Filler ${index}`));
    const doc = document([...filler, { id: "v", kind: "labelValue", label: "Tail", value: [{ text: "x\ny\nz" }], arrangement: "stacked", frame: true, control: "textarea" }], FORM_LOOK);
    const laid = await layoutOnly(doc, await fonts());
    const pagesWithValue = laid.pages.filter((page) => page.blockIds.includes("v"));
    expect(pagesWithValue).toHaveLength(1);
    expect(laid.warnings.map((warning) => warning.code)).not.toContain("frame.overflow");
  });

  it("flows an answer taller than a page without its frame and says so", async () => {
    const doc = document([{ id: "v", kind: "labelValue", label: "Essay", value: [{ text: "line\n".repeat(200) }], arrangement: "stacked", frame: true, control: "textarea" }], FORM_LOOK);
    const laid = await layoutOnly(doc, await fonts());
    expect(laid.warnings.map((warning) => warning.code)).toContain("frame.overflow");
    expect(laid.pages.length).toBeGreaterThan(1);
  });

  it("marks a select with a chevron, prints affixes with the value, and the required marker after the label at regular weight", async () => {
    const doc = document(
      [
        { id: "s", kind: "labelValue", label: "Province", labelSuffix: " *", value: [{ text: "BC" }], arrangement: "stacked", frame: true, control: "select" },
        { id: "m", kind: "labelValue", label: "Amount", prefix: "$", suffix: "CAD", value: [{ text: "1250" }], arrangement: "stacked", frame: true, control: "text" }
      ],
      FORM_LOOK
    );
    const drawn = await drawables(doc);
    // Two strokes make the chevron, at the box's end.
    const chevron = lines(drawn).filter((line) => line.blockId === "s");
    expect(chevron).toHaveLength(2);
    expect(chevron[0]!.x2).toBeGreaterThan(612 - 54 - 20);
    const pieces = texts(drawn).map((entry) => entry.piece);
    expect(pieces.map((piece) => piece.text)).toEqual(["Province", " *", "BC", "Amount", "$ ", "1250", " CAD"]);
    const marker = texts(drawn).find((entry) => entry.piece.text === " *")!;
    expect(marker.piece.font.weight).toBe(400);
    expect(texts(drawn).find((entry) => entry.piece.text === "Province")!.piece.font.weight).toBe(700);
  });

  it("prints a hint under the label, or under the control when the theme says so", async () => {
    const above = document([{ id: "v", kind: "labelValue", label: "Name", hint: "As on your ID", value: [{ text: "Ada" }], arrangement: "stacked", frame: true, control: "text" }], FORM_LOOK);
    const order = (drawn: Drawable[]) => texts(drawn).sort((a, b) => a.baselineY - b.baselineY).map((entry) => entry.piece.text);
    expect(order(await drawables(above))).toEqual(["Name", "As on your ID", "Ada"]);
    const below = { ...above, fields: { ...FORM_LOOK.fields!, hintPosition: "afterControl" as const } };
    expect(order(await drawables(below))).toEqual(["Name", "Ada", "As on your ID"]);
    const hint = texts(await drawables(above)).find((entry) => entry.piece.text === "As on your ID")!;
    expect(hint.piece.color).toBe("#555555");
  });

  it("keeps the label and value on one line for the inline arrangement, or in a label column when the theme gives one", async () => {
    const inline = document([{ id: "v", kind: "labelValue", label: "Name", value: [{ text: "Ada" }], arrangement: "inline" }], FORM_LOOK);
    const runTogether = texts(await drawables(inline));
    expect(new Set(runTogether.map((entry) => entry.baselineY)).size).toBe(1);
    const column = { ...inline, fields: { ...FORM_LOOK.fields!, inlineLabelWidth: { fraction: 0.25 } } };
    const columned = texts(await drawables(column));
    const label = columned.find((entry) => entry.piece.text === "Name")!;
    const value = columned.find((entry) => entry.piece.text === "Ada")!;
    expect(label.x).toBe(54);
    expect(value.x).toBeCloseTo(54 + 0.25 * (612 - 108), 3);
  });
});

describe("choice marks and columns", () => {
  it("draws radios as circles with a dot in the mark colour, check boxes as rounded squares, at the theme's size", async () => {
    const doc = document(
      [
        { id: "r", kind: "checklist", label: "Contact", marker: "radio", items: [{ label: "Email", checked: true }, { label: "Phone", checked: false }] },
        { id: "c", kind: "checkmark", label: "I agree", checked: true }
      ],
      { ...FORM_LOOK, colors: { ...PDF_KERNEL_FALLBACKS.colors, choiceMark: "#000000" } }
    );
    const drawn = await drawables(doc);
    const [email, phone, agree] = marks(drawn);
    expect(email).toMatchObject({ shape: "circle", checked: true, markColor: "#000000", dotSize: 5, borderWidth: 0.75, rect: { width: 11, height: 11 } });
    expect(phone).toMatchObject({ shape: "circle", checked: false });
    expect(agree).toMatchObject({ shape: "square", checked: true, radius: 2, markStroke: 1.5 });
    // A circle is drawn with Bézier curves, a square with a rectangle path.
    const content = contentOf(await reload((await renderDocument(doc, await fonts(), ENV)).bytes));
    expect(content).toMatch(/ c\n/);
  });

  it("lays options out in the theme's columns, row by row, and stacks them when the theme says one", async () => {
    const items = ["A", "B", "C", "D", "E"].map((label) => ({ label, checked: false }));
    const stacked = document([{ id: "l", kind: "checklist", items }], FORM_LOOK);
    const stackedTops = marks(await drawables(stacked)).map((mark) => mark.rect.y);
    expect(new Set(stackedTops).size).toBe(5);
    const twoUp = document([{ id: "l", kind: "checklist", items }], { ...FORM_LOOK, choice: { ...FORM_LOOK.choice!, columns: 2 } });
    const twoUpMarks = marks(await drawables(twoUp));
    expect(twoUpMarks.map((mark) => mark.rect.x)).toEqual([54, 54 + (612 - 108) / 2, 54, 54 + (612 - 108) / 2, 54]);
    expect(twoUpMarks[0]!.rect.y).toBe(twoUpMarks[1]!.rect.y);
    expect(twoUpMarks[2]!.rect.y).toBeGreaterThan(twoUpMarks[0]!.rect.y);
  });

  it("draws AcroForm choice widgets at the theme's widget size, with the control border", async () => {
    const doc = document(
      [
        { id: "cb", kind: "widget", label: "Agree", labelPosition: "after", field: { name: "agree", kind: "checkbox", value: true } },
        { id: "tx", kind: "widget", label: "Name", field: { name: "name", kind: "text", value: "Ada" } },
        { id: "ta", kind: "widget", label: "Notes", field: { name: "notes", kind: "multiline", value: "a\nb\nc\nd\ne" } }
      ],
      { ...FORM_LOOK, colors: { ...PDF_KERNEL_FALLBACKS.colors, controlBorder: "#333333" } }
    );
    const pdf = await reload((await renderDocument(doc, await fonts(), ENV)).bytes);
    const form = pdf.getForm();
    const widget = (name: string) => form.getField(name).acroField.getWidgets()[0]!;
    // pdf-lib grows a widget's rectangle by half its border on every side.
    expect(widget("agree").getRectangle().width).toBeCloseTo(11 + 0.75, 3);
    expect(widget("agree").getRectangle().height).toBeCloseTo(11 + 0.75, 3);
    expect(widget("name").getRectangle().height).toBeCloseTo(22 + 0.75, 3);
    // Five pre-filled lines outgrow the three rows the theme gives a textarea.
    expect(widget("notes").getRectangle().height).toBeCloseTo(5 * 13.5 + 8 + 0.75, 3);
    const mk = widget("name").dict.lookup(PDFName.of("MK"), PDFDict)!;
    const bc = mk.lookup(PDFName.of("BC")) as unknown as { asArray(): PDFNumber[] };
    expect(bc.asArray().map((entry) => Number(entry.asNumber().toFixed(2)))).toEqual([0.2, 0.2, 0.2]);
    const bs = widget("name").dict.lookup(PDFName.of("BS"), PDFDict)!;
    expect((bs.lookup(PDFName.of("W")) as PDFNumber).asNumber()).toBe(0.75);
    // The appearance is sized to the theme's body, not left to the viewer.
    const da = form.getField("name").acroField.dict.lookup(PDFName.of("DA")) as PDFString;
    expect(da.decodeText()).toContain("10 Tf");
  });
});

describe("headings, lists and panels", () => {
  it("numbers and bands section headings, rules the title, and tags a step", async () => {
    const doc = document(
      [
        { id: "t", kind: "heading", level: 1, runs: [{ text: "Form" }], rule: true },
        { id: "s", kind: "heading", level: 2, runs: [{ text: "Address" }], number: "1", band: true, tag: "Step 1 of 2" },
        paragraph("p", "body")
      ],
      FORM_LOOK
    );
    const drawn = await drawables(doc);
    const titleRule = lines(drawn).find((line) => line.blockId === "t")!;
    expect(titleRule).toMatchObject({ thickness: 1, color: "#999999", artifact: true });
    const band = rects(drawn).find((rect) => rect.blockId === "s")!;
    expect(band).toMatchObject({ fill: "#f2f2f2", artifact: true, rect: { x: 54, width: 612 - 108 } });
    const words = texts(drawn).map((entry) => entry.piece.text);
    // The number runs into the caption as one piece of the heading's type.
    expect(words).toEqual(["Form", "Step 1 of 2", "1  Address", "body"]);
    const tag = texts(drawn).find((entry) => entry.piece.text === "Step 1 of 2")!;
    const heading = texts(drawn).find((entry) => entry.piece.text === "1  Address")!;
    expect(tag.baselineY).toBeLessThan(heading.baselineY);
    expect(heading.baselineY).toBeGreaterThan(band.rect.y);
    expect(heading.baselineY).toBeLessThan(band.rect.y + band.rect.height);
  });

  it("draws a list with markers at the start and text at the hanging indent, nested lists indented once more", async () => {
    const doc = document(
      [
        {
          id: "l",
          kind: "list",
          ordered: true,
          items: [
            { runs: [{ text: "First" }] },
            { runs: [{ text: "Second" }], blocks: [{ id: "n", kind: "list", ordered: false, items: [{ runs: [{ text: "Inner" }] }] }] }
          ]
        }
      ],
      FORM_LOOK
    );
    const drawn = await drawables(doc);
    const byText = Object.fromEntries(texts(drawn).map((entry) => [entry.piece.text, entry.x]));
    expect(byText["1."]).toBe(54);
    expect(byText["First"]).toBe(54 + 12);
    expect(byText["2."]).toBe(54);
    expect(byText["–"]).toBe(54 + 12);
    expect(byText["Inner"]).toBe(54 + 24);
    const text = await extractText((await renderDocument(doc, await fonts(), ENV)).bytes);
    expect(text[0]).toContain("1. First 2. Second – Inner");
  });

  it("draws a panel as a titled box: the caption on its band, the children inside the border", async () => {
    const doc = document(
      [
        {
          id: "panel",
          kind: "box",
          border: { width: 0.75, color: "#999999" },
          padding: 6,
          radius: 2,
          header: { blocks: [{ id: "h", kind: "heading", level: 2, runs: [{ text: "Employment" }] }], fill: "#f2f2f2", padding: 4 },
          blocks: [paragraph("p", "Employer")]
        }
      ],
      FORM_LOOK
    );
    const drawn = await drawables(doc);
    const [outer, band] = rects(drawn);
    expect(outer).toMatchObject({ stroke: { width: 0.75, color: "#999999" }, radius: 2 });
    expect(band).toMatchObject({ fill: "#f2f2f2", artifact: true, rect: { y: outer!.rect.y } });
    expect(band!.rect.height).toBeLessThan(outer!.rect.height);
    const caption = texts(drawn).find((entry) => entry.piece.text === "Employment")!;
    const body = texts(drawn).find((entry) => entry.piece.text === "Employer")!;
    expect(caption.baselineY).toBeLessThan(band!.rect.y + band!.rect.height);
    expect(body.baselineY).toBeGreaterThan(band!.rect.y + band!.rect.height);
  });

  it("pads, borders and stripes a table as the theme says, weighting plain header runs", async () => {
    const rows = ["one", "two", "three"].map((text, index) => ({ id: `r${index}`, cells: [{ id: `c${index}`, blocks: [paragraph(`p${index}`, text)] }] }));
    const doc = document(
      [{ id: "t", kind: "table", columns: [{}], header: { id: "h", cells: [{ id: "hc", header: true, blocks: [paragraph("hp", "Head")] }] }, rows, repeatHeader: false, borders: "all" }],
      { ...FORM_LOOK, table: { cellPadding: 8, borderWidth: 1.5, rowMinHeight: 30, headerWeight: 700, headerFill: "#eeeeee", stripeFill: "#f8f8f8" } }
    );
    const drawn = await drawables(doc);
    const fills = rects(drawn).filter((rect) => rect.fill).map((rect) => rect.fill);
    expect(fills).toEqual(["#eeeeee", "#f8f8f8"]);
    const borders = rects(drawn).filter((rect) => rect.stroke);
    expect(borders.every((rect) => rect.stroke!.width === 1.5 && rect.rect.height >= 30)).toBe(true);
    const head = texts(drawn).find((entry) => entry.piece.text === "Head")!;
    expect(head.piece.font.weight).toBe(700);
    expect(head.x).toBe(54 + 8);
  });
});

describe("weights and transforms", () => {
  it("picks the nearest weight a family offers and uppercases what a style asks for", async () => {
    const doc = document(
      [
        { id: "l", kind: "labelValue", label: "Caption", value: [{ text: "value", weight: 600 }], arrangement: "stacked" },
        { id: "p", kind: "paragraph", runs: [{ text: "Shout", transform: "uppercase" }] }
      ],
      { typography: { ...PDF_KERNEL_FALLBACKS.typography, label: { family: "sans-serif", size: 8, weight: 700, transform: "uppercase" } } }
    );
    const drawn = await drawables(doc);
    const pieces = texts(drawn).map((entry) => entry.piece);
    expect(pieces.map((piece) => piece.text)).toEqual(["CAPTION", "value", "SHOUT"]);
    // DejaVu ships 400 and 700: a 600 asks for the nearer bold face.
    expect(pieces[1]!.font.weight).toBe(600);
    expect(pieces[1]!.font.font.name).not.toBe(pieces[2]!.font.font.name);
    const text = await extractText((await renderDocument(doc, await fonts(), ENV)).bytes);
    expect(text[0]).toContain("CAPTION");
  });
});
