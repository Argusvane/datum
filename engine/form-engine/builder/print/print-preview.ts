/**
 * The Print workspace's sheet: the real print document shown on screen at the paper's width, in
 * a same-origin frame written the way the print frame writes its own (`writePrintDocument`), so
 * the print theme's CSS reaches `html`, `body` and `@page` as it does on paper. A shadow root
 * could not hold it: a theme's rules for the document itself would match nothing there.
 *
 * - Two frames take turns: a new document is written into the one behind, its sheets and fonts
 *   waited for, measured, and only then shown in place of the other, so the sheet never goes
 *   empty or unstyled between two refreshes, and the scroll position (the surface's, outside the
 *   frames) stays where it was.
 * - The frame is as tall as its document, so it never scrolls by itself; the zoom is a
 *   transform on the sheet inside a box of the scaled size.
 * - The builder draws over the sheet: the estimated page starts (dashed), the author's own breaks
 *   (an accent line naming the component), the selected component's outline, and the running
 *   header and footer as strips at the sheet's top and bottom, since a screen draws no margin
 *   boxes.
 * - Measuring goes through one seam (`measure`), which reads the boxes the print document's own
 *   break rules name; a test environment with no layout hands its own.
 */
import { waitForPrintAssets, writePrintDocument } from "../../render/web-component/print-frame.js";
import type { PrintPageSize, PrintSlotPiece } from "../../render/print/index.js";
import type { PreparedPrint } from "../../render/print/document.js";
import type { PrintModel, PrintNode } from "../../render/print/model.js";
import { estimatePageStarts, type PrintBlock, type PrintPagination } from "./print-breaks.js";

/** The paper sizes the preview offers, in CSS px at 96 per inch. */
export const PRINT_PAPERS: Readonly<Record<"letter" | "A4", { width: number; height: number }>> = {
  letter: { width: 816, height: 1056 },
  A4: { width: 793.7, height: 1122.5 }
};

export type PrintPaper = keyof typeof PRINT_PAPERS;

/** What a measure of a written document reports: its height and its blocks, from the top of the content. */
export interface PrintMeasure {
  height: number;
  blocks: PrintBlock[];
}

/** The measuring seam: the document as written into the frame, its margin in px. */
export type PrintMeasurer = (doc: Document, margin: number) => PrintMeasure;

/** The boxes the print document never splits, and the ones the author's breaks mark. */
const BLOCK_SELECTOR = ".datum-print__field, .datum-print__content, .datum-print__notice, .datum-print__grid tr, .datum-print__keep-together, .datum-print__break-before";

/** A CSS length (`16mm`, `0.5in`, `40px`, `12pt`, `1cm`) in px; anything else is the default 16mm. */
export function cssLengthPx(value: string | undefined): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(mm|cm|in|px|pt)?\s*$/.exec(value ?? "");
  if (!match) {
    return (16 * 96) / 25.4;
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case "cm":
      return (amount * 96) / 2.54;
    case "in":
      return amount * 96;
    case "pt":
      return (amount * 96) / 72;
    case "px":
      return amount;
    default:
      return (amount * 96) / 25.4;
  }
}

/** The page size the preview asks the print for: the paper it shows. */
export function pageSizeOf(paper: PrintPaper): PrintPageSize {
  return paper;
}

/** The measure a browser gives: each block's box against the top of the body's content. */
export const measurePrintDocument: PrintMeasurer = (doc, margin) => {
  const body = doc.body;
  if (!body) {
    return { height: 0, blocks: [] };
  }
  const origin = body.getBoundingClientRect().top + margin;
  const blocks: PrintBlock[] = [];
  const measured = new Map<Element, PrintBlock>();
  for (const element of Array.from(body.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) {
      continue;
    }
    // The document's own rule: a break before the first thing of the form starts no blank sheet.
    const first = element.parentElement?.classList.contains("datum-print") === true && element.parentElement.firstElementChild === element;
    const componentId = element.getAttribute("data-component-id") ?? undefined;
    const block: PrintBlock = {
      top: rect.top - origin,
      height: rect.height,
      ...(element.classList.contains("datum-print__break-before") && !first ? { breakBefore: true } : {}),
      ...(componentId !== undefined ? { componentId } : {})
    };
    blocks.push(block);
    measured.set(element, block);
    // Document order puts an outer block before the ones inside it: the nearest measured ancestor holds this one.
    for (let up = element.parentElement; up && up !== body; up = up.parentElement) {
      const outer = measured.get(up);
      if (outer) {
        outer.container = true;
        break;
      }
    }
  }
  const height = Math.max(doc.documentElement?.scrollHeight ?? 0, body.scrollHeight ?? 0);
  return { height, blocks };
};

/** What the sheet says, in the surface's words. */
export interface PrintPreviewWords {
  /** The dashed line: "Page {page} starts about here". */
  estimated(page: number): string;
  /**
   * The accent line of an author's break: "New page: {label}". `sectionTitle` is the heading of a
   * tab's, step's or journey page's section when the break starts one (empty for an untitled
   * page): such a section has no component to name, and its id is internal.
   */
  forced(page: number, componentId: string | undefined, sectionTitle?: string): string;
  /** The frame's accessible name. */
  frameTitle(): string;
}

export interface PrintPreviewOptions {
  /** A click on a component of the sheet. */
  select(componentId: string): void;
  measure(): PrintMeasurer;
  words: PrintPreviewWords;
}

/** What the sheet shows after a write. */
export interface PrintShown {
  pagination: PrintPagination;
  height: number;
  /** Why the sheet shows the basic theme, not the chosen one: its drawers refused, or its self-check found these problems. */
  fellBack?: string[];
}

/** The pieces of a slot as one line of text, the counters as page `page` (the first by default) of `pages`. */
export function slotLine(pieces: readonly PrintSlotPiece[] | undefined, pages: number, page = 1): string {
  return (pieces ?? []).map((piece) => ("counter" in piece ? String(piece.counter === "pages" ? pages : page) : piece.text)).join("");
}

/**
 * The component an id drawn on the sheet stands for: its own, a repeating section's row
 * (`items#0`) and a tab's section (`tabs:slot`) for the component that holds them. A journey
 * page's section (`page:<id>`) is no component: `undefined`.
 */
export function selectableId(id: string | null | undefined): string | undefined {
  if (typeof id !== "string" || id === "" || id.startsWith("page:")) {
    return undefined;
  }
  const own = id.split(/[#:]/, 1)[0]!;
  return own === "" ? undefined : own;
}

/**
 * What a click or the pointer on `target` selects: the nearest thing around it that stands for a
 * component, walking out past a page's section. One reading for the click and the hover ring, so
 * the ring outlines exactly what a click would select.
 */
export function selectableTarget(target: Element | null | undefined): string | undefined {
  let element: Element | null = target?.closest?.("[data-component-id]") ?? null;
  while (element) {
    const id = selectableId(element.getAttribute("data-component-id"));
    if (id !== undefined) {
      return id;
    }
    element = element.parentElement?.closest("[data-component-id]") ?? null;
  }
  return undefined;
}

/**
 * The heading of the section `id` names in `nodes` (a tab, a step, a journey page, or a repeating
 * section's row, whose group carries its "Row 2"), searched at every depth.
 */
function sectionTitleOf(nodes: readonly PrintNode[], id: string): string | undefined {
  for (const node of nodes) {
    if (node.kind === "section" && node.id === id) {
      return node.title;
    }
    if (node.kind === "group" && node.id === id) {
      return node.legend ?? "";
    }
    if (node.kind === "section" || node.kind === "group" || node.kind === "run") {
      const found = sectionTitleOf(node.children, id);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/** The ids of the step sections the steps container `container` printed as; a container draws no wrapper, only these. */
function stepSectionIdsOf(nodes: readonly PrintNode[], container: string): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === "section" || node.kind === "group" || node.kind === "run") {
      const own = node.kind === "section" && node.container === container ? [node.id] : [];
      return [...own, ...stepSectionIdsOf(node.children, container)];
    }
    return [];
  });
}

export class PrintPreview {
  private readonly frames: [HTMLIFrameElement, HTMLIFrameElement];
  private front = 0;
  private readonly overlay: HTMLElement;
  private readonly header: HTMLElement;
  private readonly footer: HTMLElement;
  private token = 0;
  private zoomValue = 1;
  private shownHeight = 0;
  private margin = 0;
  private paper: { width: number; height: number } = PRINT_PAPERS.letter;
  private selected: string | undefined;
  private hovered: string | undefined;
  private lastShown: PrintShown | undefined;
  private model: PreparedPrint["model"] | undefined;

  public constructor(
    private readonly box: HTMLElement,
    private readonly sheet: HTMLElement,
    private readonly options: PrintPreviewOptions
  ) {
    const doc = sheet.ownerDocument;
    const frame = (which: string): HTMLIFrameElement => {
      const element = doc.createElement("iframe");
      element.className = "sheet-frame";
      element.setAttribute("data-print-frame", which);
      element.setAttribute("title", options.words.frameTitle());
      element.setAttribute("tabindex", "-1");
      return element;
    };
    this.frames = [frame("a"), frame("b")];
    this.frames[1].setAttribute("data-print-frame-back", "");
    this.frames[1].setAttribute("aria-hidden", "true");
    this.overlay = doc.createElement("div");
    this.overlay.className = "sheet-overlay";
    this.overlay.setAttribute("data-print-overlay", "");
    this.overlay.setAttribute("aria-hidden", "true");
    this.header = doc.createElement("div");
    this.header.className = "strip strip--top";
    this.header.setAttribute("data-print-header", "");
    this.footer = doc.createElement("div");
    this.footer.className = "strip strip--bottom";
    this.footer.setAttribute("data-print-footer", "");
    sheet.replaceChildren(this.frames[0], this.frames[1], this.overlay, this.header, this.footer);
    this.applySize();
  }

  /** The frame on show (its document is the sheet's). */
  public get frame(): HTMLIFrameElement {
    return this.frames[this.front]!;
  }

  /** What the last write showed. */
  public get shown(): PrintShown | undefined {
    return this.lastShown;
  }

  public get zoom(): number {
    return this.zoomValue;
  }

  public set zoom(value: number) {
    const next = Number.isFinite(value) ? Math.min(2, Math.max(0.25, value)) : 1;
    if (next !== this.zoomValue) {
      this.zoomValue = next;
      this.applySize();
    }
  }

  /** The paper's width in px: what Fit fits to the space. */
  public get paperWidth(): number {
    return this.paper.width;
  }

  /**
   * Writes `prepared` into the frame behind, waits for its assets, measures it and puts it on
   * show. A newer `show` supersedes an older one still waiting: the older one draws nothing.
   */
  public async show(prepared: PreparedPrint, paper: PrintPaper): Promise<PrintShown | undefined> {
    const token = ++this.token;
    const back = this.frames[1 - this.front]!;
    const doc = back.contentDocument;
    const win = back.contentWindow;
    if (!doc || !win) {
      return undefined;
    }
    this.paper = PRINT_PAPERS[paper];
    let model: PrintModel = prepared.model;
    let fellBack = prepared.fellBack;
    this.margin = cssLengthPx(model.page.margin);
    // The frame behind is laid out at the paper's width while it is written and measured.
    this.applySize();
    writePrintDocument(doc, win, prepared.html, this.sheet.ownerDocument);
    await waitForPrintAssets(doc, 1500);
    if (token !== this.token) {
      return undefined;
    }
    // The sheet is what the print will be: a theme whose own check fails once its sheets and fonts
    // are in prints as the basic theme, so the sheet shows that one (as `presentPrintDocument` does).
    const problems = prepared.selfCheck?.(doc) ?? [];
    if (problems.length > 0 && prepared.fallback) {
      const basic = prepared.fallback();
      model = basic.model;
      fellBack = [...(prepared.fellBack ?? []), ...problems];
      this.margin = cssLengthPx(model.page.margin);
      this.applySize();
      writePrintDocument(doc, win, basic.html, this.sheet.ownerDocument);
      await waitForPrintAssets(doc, 1500);
      if (token !== this.token) {
        return undefined;
      }
    }
    // One listener however often the frame is written: the same function is added once.
    doc.addEventListener("click", this.clickListener, true);
    doc.addEventListener("mouseover", this.hoverListener, true);
    doc.addEventListener("mouseout", this.leaveListener, true);
    const measure = this.measureNow(doc);
    this.front = 1 - this.front;
    for (const [index, frame] of this.frames.entries()) {
      const shown = index === this.front;
      frame.toggleAttribute("data-print-frame-back", !shown);
      frame.toggleAttribute("aria-hidden", !shown);
      if (shown) {
        frame.removeAttribute("tabindex");
      } else {
        frame.setAttribute("tabindex", "-1");
      }
    }
    this.model = model;
    this.shownHeight = Math.max(measure.height, this.paper.height);
    this.lastShown = {
      pagination: estimatePageStarts(measure.blocks, this.pageContentHeight()),
      height: this.shownHeight,
      ...(fellBack !== undefined && fellBack.length > 0 ? { fellBack } : {})
    };
    this.applySize();
    this.drawOverlay();
    return this.lastShown;
  }

  /** Measures the document on show again (its fonts arrived, the space changed) and redraws the lines. */
  public remeasure(): void {
    const doc = this.frame.contentDocument;
    if (!doc || !this.model) {
      return;
    }
    const measure = this.measureNow(doc);
    this.shownHeight = Math.max(measure.height, this.paper.height);
    this.lastShown = {
      pagination: estimatePageStarts(measure.blocks, this.pageContentHeight()),
      height: this.shownHeight,
      ...(this.lastShown?.fellBack !== undefined ? { fellBack: this.lastShown.fellBack } : {})
    };
    this.applySize();
    this.drawOverlay();
  }

  /** The component outlined on the sheet; `undefined` for none. */
  public markSelected(componentId: string | undefined): void {
    this.selected = componentId;
    this.drawSelection();
  }

  /** The frames named again, in the words as they stand (the builder's language changed). */
  public retitle(): void {
    const title = this.options.words.frameTitle();
    for (const frame of this.frames) {
      if (frame.getAttribute("title") !== title) {
        frame.setAttribute("title", title);
      }
    }
  }

  /** Where `componentId`'s box starts on the sheet, in the sheet's own px (before the zoom); `undefined` when it is not on it. */
  public topOf(componentId: string): number | undefined {
    const doc = this.frame.contentDocument;
    if (!doc?.body) {
      return undefined;
    }
    const target = Array.from(doc.querySelectorAll<HTMLElement>("[data-component-id]")).find((element) => element.getAttribute("data-component-id") === componentId);
    return target ? target.getBoundingClientRect().top - doc.body.getBoundingClientRect().top : undefined;
  }

  /** The heading of the section (a tab, a step, a journey page) the shown model holds under `id`; `""` when it has none. */
  private sectionTitle(id: string): string {
    return (this.model ? sectionTitleOf(this.model.nodes, id) : undefined) ?? "";
  }

  private measureNow(doc: Document): PrintMeasure {
    try {
      return this.options.measure()(doc, this.margin);
    } catch {
      return { height: 0, blocks: [] };
    }
  }

  private pageContentHeight(): number {
    return this.paper.height - 2 * this.margin;
  }

  private readonly clickListener = (event: Event): void => this.onClick(event);

  private onClick(event: Event): void {
    const target = event.target as Element | null;
    // Nothing on the sheet is followed or worked: a link in static content included.
    event.preventDefault();
    const id = selectableTarget(target);
    if (id !== undefined) {
      this.options.select(id);
    }
  }

  private readonly hoverListener = (event: Event): void => {
    const target = event.target as Element | null;
    this.markHovered(selectableTarget(target));
  };

  /** The pointer left the sheet's document altogether (no element of it is entered next). */
  private readonly leaveListener = (event: Event): void => {
    if (!(event as MouseEvent).relatedTarget) {
      this.markHovered(undefined);
    }
  };

  /** The component a click would select, outlined as the canvas outlines the one under the pointer. */
  private markHovered(componentId: string | undefined): void {
    if (componentId === this.hovered) {
      return;
    }
    this.hovered = componentId;
    this.drawHover();
  }

  private applySize(): void {
    const width = this.paper.width;
    const height = Math.max(this.shownHeight, this.paper.height);
    this.sheet.style.width = `${width}px`;
    this.sheet.style.height = `${height}px`;
    this.sheet.style.transform = this.zoomValue === 1 ? "" : `scale(${this.zoomValue})`;
    this.box.style.width = `${width * this.zoomValue}px`;
    this.box.style.height = `${height * this.zoomValue}px`;
    this.header.style.height = `${this.margin}px`;
    this.footer.style.height = `${this.margin}px`;
  }

  private drawOverlay(): void {
    const doc = this.overlay.ownerDocument;
    const shown = this.lastShown;
    this.overlay.replaceChildren();
    if (!shown) {
      return;
    }
    for (const start of shown.pagination.starts) {
      const line = doc.createElement("div");
      line.className = start.forced ? "break-line break-line--forced" : "break-line";
      line.setAttribute("data-print-break", start.forced ? "forced" : "estimated");
      line.setAttribute("data-page", String(start.page));
      if (start.componentId !== undefined) {
        line.setAttribute("data-component-id", start.componentId);
      }
      line.style.top = `${this.margin + start.top}px`;
      const label = doc.createElement("span");
      label.className = "break-label";
      const section = start.forced && start.componentId !== undefined && /[:#]/.test(start.componentId) ? this.sectionTitle(start.componentId) : undefined;
      label.textContent = start.forced ? this.options.words.forced(start.page, section === undefined ? start.componentId : undefined, section) : this.options.words.estimated(start.page);
      line.append(label);
      this.overlay.append(line);
    }
    const model = this.model;
    const pages = shown.pagination.pages;
    const dir = model?.dir ?? "ltr";
    const lang = model?.lang;
    // The footer strip sits at the foot of the whole sheet, which is the last page's.
    const strip = (element: HTMLElement, band: { start?: readonly PrintSlotPiece[]; end?: readonly PrintSlotPiece[] } | undefined, page: number): void => {
      const start = slotLine(band?.start, pages, page);
      const end = slotLine(band?.end, pages, page);
      element.replaceChildren();
      // The strip's start side is the print's: the right margin boxes of a right-to-left form.
      if (element.dir !== dir) {
        element.dir = dir;
      }
      if (lang !== undefined && element.lang !== lang) {
        element.lang = lang;
      }
      element.hidden = start === "" && end === "";
      for (const [slot, text] of [["start", start], ["end", end]] as const) {
        const span = doc.createElement("span");
        span.setAttribute("data-slot", slot);
        span.textContent = text;
        element.append(span);
      }
    };
    strip(this.header, model?.page.header, 1);
    strip(this.footer, model?.page.footer, pages);
    this.drawSelection();
  }

  private drawSelection(): void {
    this.drawBox("data-print-selection", "selection-box", this.selected);
    this.drawHover();
  }

  /** The hover's dashed outline; none over the selected component, whose own outline says more. */
  private drawHover(): void {
    this.drawBox("data-print-hover", "hover-box", this.hovered !== this.selected ? this.hovered : undefined);
  }

  /** One box of the overlay over `id`'s place on the sheet, replacing the one drawn before; none for no id or a component not on the sheet. */
  private drawBox(mark: string, className: string, id: string | undefined): void {
    this.overlay.querySelector(`[${mark}]`)?.remove();
    const doc = this.frame.contentDocument;
    if (id === undefined || !doc?.body) {
      return;
    }
    const marked = Array.from(doc.querySelectorAll<HTMLElement>("[data-component-id]"));
    let targets = marked.filter((element) => element.getAttribute("data-component-id") === id);
    if (targets.length === 0) {
      // A tabs or steps container draws no wrapper of its own: a tabs section for each tab (`id:slot`),
      // a section carrying the step's own id for each step (the model names the container). The box spans them.
      const steps = new Set(this.model ? stepSectionIdsOf(this.model.nodes, id) : []);
      targets = marked.filter((element) => {
        const own = element.getAttribute("data-component-id");
        return own !== null && (own.startsWith(`${id}:`) || steps.has(own));
      });
    }
    if (targets.length === 0) {
      return;
    }
    const rects = targets.map((element) => element.getBoundingClientRect());
    const rect = {
      top: Math.min(...rects.map((r) => r.top)),
      left: Math.min(...rects.map((r) => r.left)),
      width: Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left)),
      height: Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top))
    };
    const origin = doc.body.getBoundingClientRect();
    const box = this.overlay.ownerDocument.createElement("div");
    box.className = className;
    box.setAttribute(mark, "");
    box.setAttribute("data-component-id", id);
    box.style.top = `${rect.top - origin.top}px`;
    box.style.left = `${rect.left - origin.left}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    this.overlay.append(box);
  }
}
