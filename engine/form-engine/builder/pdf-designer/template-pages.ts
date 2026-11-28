/**
 * The template editor's page viewer: the template's pages, drawn by the host's
 * rasteriser when it has one and as blank sheets of the right size when it has not, with an
 * SVG overlay per page in the page's own point space. The overlay shows the AcroForm fields
 * the kernel found (click one to find its row) and the areas the author draws: drag on empty
 * paper to add one, drag an area to move it, its handles to resize it, arrows to nudge it,
 * Delete to remove it. Every rectangle the viewer reports is in points from the page's
 * top-left, the convention the layout stores.
 *
 * The element is built once and kept by the editor across its own redraws: the page images
 * are worth keeping, and a drag must not lose its target under a repaint. Nothing here
 * assumes a canvas, an `IntersectionObserver` or pointer capture — under jsdom the viewer
 * shows blank sheets and its pointer arithmetic still holds.
 */
import type { PdfTemplateArea } from "../../core/schema/pdf-layout.js";
import type { PdfTemplateInfo } from "../../render/pdf/pdf-abi.js";
import type { PdfPageRasterizer, PdfPageSet } from "../../render/pdf/pdf-pages.js";
import type { BuilderTextCatalog, BuilderTextOptions } from "../logic/builder-texts.js";
import { builderPlural, builderText } from "./pdf-texts-en.js";
import { clampAreaRect, templateFieldBoxesHtml, type PdfAreaRect } from "./template-mode.js";

export type TemplatePageViewerStatus = "empty" | "loading" | "images" | "blank";

export interface TemplatePageViewerOptions {
  /** Where the page pictures come from; absent, or failing, blank sheets. */
  rasterizer?: (() => Promise<PdfPageRasterizer | undefined>) | undefined;
  /** Attribute-safe escaping; the engine's `escapeHtml` does. */
  escape: (value: string) => string;
  /** An area was picked (or, `undefined`, the paper was clicked). */
  onSelect(id: string | undefined): void;
  /** A rectangle was drawn on empty paper. */
  onAreaCreate(create: { page: number; rect: PdfAreaRect }): void;
  /** An area was moved, resized or nudged. */
  onAreaChange(id: string, rect: PdfAreaRect): void;
  onAreaRemove(id: string): void;
  /** One of the template's own fields was clicked. */
  onFieldClick(name: string): void;
  /** The builder's locale, read as the viewer draws; absent, English. */
  locale?(): string | undefined;
  /** The host's builder texts per locale, read as the viewer draws; absent, English. */
  textCatalog?(): BuilderTextCatalog | undefined;
}

export interface TemplatePageViewer {
  readonly element: HTMLElement;
  /** The pages to show (none clears the viewer). `bytes` feed the rasteriser. */
  setDocument(inspection: PdfTemplateInfo | undefined, bytes: Uint8Array | undefined): void;
  /** Redraws the areas; `selectedId` gets the handles. */
  setAreas(areas: readonly PdfTemplateArea[], selectedId: string | undefined): void;
  /** Redraws the template's field boxes: filled when mapped, highlighted when focused. */
  setMapped(mapped: ReadonlySet<string>, focusedField: string | undefined, unresolved?: ReadonlyMap<string, string>): void;
  select(id: string | undefined): void;
  /** A zoom factor over the width that fits the column, or `"fit"`. */
  zoom(value: number | "fit"): void;
  status(): TemplatePageViewerStatus;
  dispose(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** The smallest rectangle a drag makes an area of, in points. */
const MIN_AREA = 4;
/** On-screen size of a resize handle. */
const HANDLE_PX = 8;
const NUDGE = 1;
const NUDGE_FAST = 10;
const RERENDER_DELAY_MS = 150;
/** What a column with no measurable width (jsdom) is taken to be. */
const FALLBACK_WIDTH = 300;

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

interface PageEntry {
  index: number;
  width: number;
  height: number;
  element: HTMLElement;
  overlay: SVGSVGElement;
  fields: SVGGElement;
  areas: SVGGElement;
  /** The picture, once one arrived: kept across zooms until the next one lands. */
  picture?: HTMLCanvasElement | HTMLImageElement;
  renderedScale?: number;
  rendering?: number;
}

type Drag =
  | { kind: "draw"; page: PageEntry; start: { x: number; y: number }; draft: SVGRectElement; rect: PdfAreaRect | undefined }
  | { kind: "move"; page: PageEntry; id: string; start: { x: number; y: number }; from: PdfAreaRect; rect: PdfAreaRect; moved: boolean }
  | { kind: "resize"; page: PageEntry; id: string; handle: Handle; start: { x: number; y: number }; from: PdfAreaRect; rect: PdfAreaRect; moved: boolean };

/**
 * `from` with the edges `handle` names moved by `dx`, `dy`, each stopped at the page's edge so
 * the edges the author did not drag stay where they were.
 */
function resized(from: PdfAreaRect, handle: Handle, dx: number, dy: number, page: { width: number; height: number }): PdfAreaRect {
  const within = (value: number, limit: number): number => Math.min(Math.max(0, value), limit);
  let left = from.x;
  let right = from.x + from.width;
  let top = from.y;
  let bottom = from.y + from.height;
  if (handle.includes("w")) {
    left = within(left + dx, page.width);
  }
  if (handle.includes("e")) {
    right = within(right + dx, page.width);
  }
  if (handle.includes("n")) {
    top = within(top + dy, page.height);
  }
  if (handle.includes("s")) {
    bottom = within(bottom + dy, page.height);
  }
  // A handle dragged past the opposite edge flips the box rather than folding it.
  return { x: Math.min(left, right), y: Math.min(top, bottom), width: Math.abs(right - left), height: Math.abs(bottom - top) };
}

function sameRect(a: PdfAreaRect, b: PdfAreaRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function setAttributes(element: Element, attributes: Record<string, string | number>): void {
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
}

/** `[data-x="…"]` with the value quoted for a selector (no `CSS.escape` under jsdom). */
function byAttribute(name: string, value: string): string {
  return `[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;
}

export function createTemplatePageViewer(options: TemplatePageViewerOptions): TemplatePageViewer {
  const words = (): BuilderTextOptions => {
    const catalog = options.textCatalog?.();
    return { locale: options.locale?.() ?? "en", ...(catalog ? { catalog } : {}) };
  };
  const element = document.createElement("div");
  element.className = "dpd-pages";
  element.setAttribute("data-template-pages", "");
  element.setAttribute("data-template-schematic", "");
  element.innerHTML = `
    <span class="dpd-pages__status" data-pages-status hidden></span>
    <div class="dpd-pages__scroll" data-pages-scroll></div>`;
  const scroll = element.querySelector<HTMLElement>("[data-pages-scroll]")!;
  const statusEl = element.querySelector<HTMLElement>("[data-pages-status]")!;

  let inspection: PdfTemplateInfo | undefined;
  let pages: PageEntry[] = [];
  let areas: readonly PdfTemplateArea[] = [];
  let selected: string | undefined;
  let mapped: ReadonlySet<string> = new Set();
  let unresolved: ReadonlyMap<string, string> = new Map();
  let focusedField: string | undefined;
  let zoomFactor = 1;
  let scale = 1;
  let status: TemplatePageViewerStatus = "empty";
  let pageSet: PdfPageSet | undefined;
  let documentToken = 0;
  let observer: IntersectionObserver | undefined;
  let rerenderTimer: ReturnType<typeof setTimeout> | undefined;
  let drag: Drag | undefined;
  const objectUrls: string[] = [];

  const setStatus = (next: TemplatePageViewerStatus, text: string): void => {
    status = next;
    element.setAttribute("data-pages-state", next);
    statusEl.textContent = text;
    // No text, no grid row: an empty status must not leave a gap above the pages.
    statusEl.hidden = text === "";
  };
  setStatus("empty", "");

  const fitScale = (): number => {
    const widest = pages.reduce((max, page) => Math.max(max, page.width), 0);
    if (widest === 0) {
      return 1;
    }
    const available = scroll.clientWidth || element.clientWidth || FALLBACK_WIDTH;
    // Room for the sheet's border and the scrollbar.
    return Math.max(0.05, (available - 18) / widest);
  };

  const pageAt = (index: number): PageEntry | undefined => pages.find((page) => page.index === index);

  /** Pointer position in the page's points: the overlay's box is the page at `scale`. */
  const pointOf = (page: PageEntry, event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = page.overlay.getBoundingClientRect();
    return { x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale };
  };

  const areaBox = (area: PdfTemplateArea): SVGGElement | null => {
    for (const page of pages) {
      const found = page.areas.querySelector<SVGGElement>(byAttribute("data-area", area.id));
      if (found) {
        return found;
      }
    }
    return null;
  };

  const handleSize = (): number => HANDLE_PX / scale;

  const areaHtml = (area: PdfTemplateArea, isSelected: boolean): string => {
    const esc = options.escape;
    // Numbers at the write site, whatever the layout held: these go into SVG attributes.
    const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    const rect = { x: finite(area.rect.x), y: finite(area.rect.y), width: finite(area.rect.width), height: finite(area.rect.height) };
    const check = area.draw?.kind === "check";
    const fillable = area.field !== undefined;
    const label = area.label ?? area.id;
    const fontSize = Math.min(9, Math.max(4, rect.height * 0.6));
    const handles = isSelected
      ? HANDLES.map((handle) => {
          const size = handleSize();
          const cx = handle.includes("w") ? rect.x : handle.includes("e") ? rect.x + rect.width : rect.x + rect.width / 2;
          const cy = handle.includes("n") ? rect.y : handle.includes("s") ? rect.y + rect.height : rect.y + rect.height / 2;
          return `<rect class="dpd-area__handle" data-handle="${handle}" x="${(cx - size / 2).toFixed(2)}" y="${(cy - size / 2).toFixed(2)}" width="${size.toFixed(2)}" height="${size.toFixed(2)}" vector-effect="non-scaling-stroke"></rect>`;
        }).join("")
      : "";
    const title = fillable ? builderText("pdf.area.field", { label, name: area.field?.name ?? label }, words()) : label;
    return `<g class="dpd-area${isSelected ? " is-selected" : ""}${check ? " dpd-area--check" : ""}${fillable ? " dpd-area--field" : ""}" data-area="${esc(area.id)}" role="button" aria-label="${esc(title)}">
      <rect class="dpd-area__box" x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" vector-effect="non-scaling-stroke"><title>${esc(title)}</title></rect>
      <text class="dpd-area__label" x="${(rect.x + 1.5).toFixed(2)}" y="${(rect.y + fontSize + 1).toFixed(2)}" font-size="${fontSize.toFixed(2)}">${esc(check ? "✓" : fillable ? `⌨ ${label}` : label)}</text>
      ${handles}
    </g>`;
  };

  const drawAreas = (): void => {
    for (const page of pages) {
      page.areas.innerHTML = areas
        .filter((area) => area.page === page.index)
        .map((area) => areaHtml(area, area.id === selected))
        .join("");
    }
  };

  const drawFields = (): void => {
    if (!inspection) {
      return;
    }
    for (const page of pages) {
      page.fields.innerHTML = templateFieldBoxesHtml(inspection, page.index, { mapped, unresolved, escape: options.escape, text: words() });
      if (focusedField !== undefined) {
        page.fields.querySelector(byAttribute("data-field", focusedField))?.classList.add("is-focused");
      }
    }
  };

  const applyScale = (): void => {
    scale = fitScale() * zoomFactor;
    for (const page of pages) {
      const width = page.width * scale;
      const height = page.height * scale;
      page.element.style.width = `${width}px`;
      page.element.style.height = `${height}px`;
      setAttributes(page.overlay, { width: width.toFixed(2), height: height.toFixed(2) });
      if (page.picture) {
        page.picture.style.width = `${width}px`;
        page.picture.style.height = `${height}px`;
      }
    }
    // Handles keep their on-screen size, so the selected area is redrawn at the new scale.
    drawAreas();
  };

  const revokeUrls = (): void => {
    for (const url of objectUrls.splice(0)) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Nothing to release (jsdom).
      }
    }
  };

  const closePageSet = (): void => {
    documentToken += 1;
    observer?.disconnect();
    observer = undefined;
    if (rerenderTimer !== undefined) {
      clearTimeout(rerenderTimer);
      rerenderTimer = undefined;
    }
    try {
      pageSet?.close();
    } catch {
      // A page set that failed to open has nothing to close.
    }
    pageSet = undefined;
    revokeUrls();
  };

  /** Draws one page's picture at the current scale, unless one at that scale is already up or under way. */
  const renderPage = async (page: PageEntry, token: number): Promise<void> => {
    const set = pageSet;
    if (!set || page.renderedScale === scale || page.rendering === scale) {
      return;
    }
    page.rendering = scale;
    const wanted = scale;
    try {
      const ratio = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
      const picture = await set.render(page.index, { scale: wanted * ratio });
      if (token !== documentToken || wanted !== scale) {
        // Zoomed or swapped out meanwhile: the next render, if any, is already queued.
        return;
      }
      let node: HTMLCanvasElement | HTMLImageElement;
      if (typeof HTMLCanvasElement !== "undefined" && picture instanceof HTMLCanvasElement) {
        node = picture;
      } else if (typeof Blob !== "undefined" && picture instanceof Blob) {
        const image = document.createElement("img");
        const url = URL.createObjectURL(picture);
        objectUrls.push(url);
        image.src = url;
        image.alt = "";
        node = image;
      } else {
        const bitmap = picture as ImageBitmap;
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        node = canvas;
      }
      node.className = "dpd-page__picture";
      node.style.width = `${page.width * scale}px`;
      node.style.height = `${page.height * scale}px`;
      node.setAttribute("aria-hidden", "true");
      page.picture?.remove();
      page.picture = node;
      page.element.insertBefore(node, page.overlay);
      page.renderedScale = wanted;
      if (status !== "images") {
        setStatus("images", builderPlural("pdf.pages.count", pages.length, undefined, words()));
      }
    } catch (failure) {
      if (token === documentToken && status === "loading") {
        setStatus("blank", builderText("pdf.pages.unavailable", { reason: failure instanceof Error ? failure.message : String(failure) }, words()));
      }
    } finally {
      if (page.rendering === wanted) {
        delete page.rendering;
      }
    }
  };

  const renderVisible = (token: number): void => {
    if (!pageSet) {
      return;
    }
    if (typeof IntersectionObserver === "function") {
      observer?.disconnect();
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const page = pages.find((candidate) => candidate.element === entry.target);
              if (page) {
                void renderPage(page, token);
              }
            }
          }
        },
        { root: scroll, rootMargin: "200px" }
      );
      for (const page of pages) {
        observer.observe(page.element);
      }
      return;
    }
    void (async () => {
      for (const page of pages) {
        await renderPage(page, token);
      }
    })();
  };

  const scheduleRerender = (): void => {
    if (!pageSet) {
      return;
    }
    if (rerenderTimer !== undefined) {
      clearTimeout(rerenderTimer);
    }
    const token = documentToken;
    rerenderTimer = setTimeout(() => {
      rerenderTimer = undefined;
      if (token !== documentToken) {
        return;
      }
      // Pages with a picture are redrawn at the new scale; the rest render as they scroll in.
      for (const page of pages) {
        if (page.picture) {
          void renderPage(page, token);
        }
      }
    }, RERENDER_DELAY_MS);
  };

  const openPictures = (bytes: Uint8Array | undefined, token: number): void => {
    if (!options.rasterizer || !bytes) {
      setStatus("blank", builderText("pdf.pages.blank", undefined, words()));
      return;
    }
    setStatus("loading", builderText("pdf.pages.drawing", undefined, words()));
    void (async () => {
      try {
        const rasterizer = await options.rasterizer!();
        if (token !== documentToken) {
          return;
        }
        if (!rasterizer) {
          setStatus("blank", builderText("pdf.pages.blank", undefined, words()));
          return;
        }
        const set = await rasterizer.open(bytes);
        if (token !== documentToken) {
          set.close();
          return;
        }
        pageSet = set;
        renderVisible(token);
      } catch (failure) {
        if (token === documentToken) {
          setStatus("blank", builderText("pdf.pages.unavailable", { reason: failure instanceof Error ? failure.message : String(failure) }, words()));
        }
      }
    })();
  };

  const buildPages = (): void => {
    scroll.innerHTML = "";
    pages = (inspection?.pages ?? []).map((page) => {
      const wrapper = document.createElement("div");
      wrapper.className = "dpd-page";
      wrapper.setAttribute("data-page", String(page.index));
      const overlay = document.createElementNS(SVG_NS, "svg");
      overlay.setAttribute("class", "dpd-page__overlay datum-pdf-schematic__page");
      overlay.setAttribute("viewBox", `0 0 ${page.width} ${page.height}`);
      overlay.setAttribute("data-page", String(page.index));
      overlay.setAttribute("tabindex", "0");
      overlay.setAttribute("role", "group");
      overlay.setAttribute("aria-label", builderText("pdf.page.drag", { page: page.index }, words()));
      const fields = document.createElementNS(SVG_NS, "g");
      fields.setAttribute("data-fields", "");
      const areasGroup = document.createElementNS(SVG_NS, "g");
      areasGroup.setAttribute("data-areas", "");
      overlay.append(fields, areasGroup);
      wrapper.append(overlay);
      scroll.append(wrapper);
      return { index: page.index, width: page.width, height: page.height, element: wrapper, overlay, fields, areas: areasGroup };
    });
  };

  // --- pointer interaction ---

  const endDrag = (event?: PointerEvent): void => {
    if (!drag) {
      return;
    }
    const current = drag;
    drag = undefined;
    if (event && typeof current.page.overlay.releasePointerCapture === "function") {
      try {
        current.page.overlay.releasePointerCapture(event.pointerId);
      } catch {
        // Not captured.
      }
    }
    if (current.kind === "draw") {
      current.draft.remove();
      if (current.rect && current.rect.width >= MIN_AREA && current.rect.height >= MIN_AREA) {
        options.onAreaCreate({ page: current.page.index, rect: current.rect });
      } else {
        options.onSelect(undefined);
      }
      return;
    }
    if (current.moved && !sameRect(current.from, current.rect)) {
      options.onAreaChange(current.id, current.rect);
    }
  };

  const onPointerDown = (page: PageEntry, event: PointerEvent): void => {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    const target = event.target as Element | null;
    const start = pointOf(page, event);
    const handleEl = target?.closest<SVGElement>("[data-handle]");
    const areaEl = target?.closest<SVGElement>("[data-area]");
    const fieldEl = target?.closest<SVGElement>("[data-field]");
    if (handleEl && areaEl) {
      const id = areaEl.getAttribute("data-area") ?? "";
      const area = areas.find((entry) => entry.id === id);
      if (!area) {
        return;
      }
      drag = { kind: "resize", page, id, handle: handleEl.getAttribute("data-handle") as Handle, start, from: { ...area.rect }, rect: { ...area.rect }, moved: false };
    } else if (areaEl) {
      const id = areaEl.getAttribute("data-area") ?? "";
      const area = areas.find((entry) => entry.id === id);
      if (!area) {
        return;
      }
      if (selected !== id) {
        selected = id;
        drawAreas();
        options.onSelect(id);
      }
      drag = { kind: "move", page, id, start, from: { ...area.rect }, rect: { ...area.rect }, moved: false };
    } else if (fieldEl) {
      const name = fieldEl.getAttribute("data-field");
      if (name !== null) {
        options.onFieldClick(name);
      }
      return;
    } else {
      const draft = document.createElementNS(SVG_NS, "rect");
      draft.setAttribute("class", "dpd-area__draft");
      draft.setAttribute("data-draft", "");
      draft.setAttribute("vector-effect", "non-scaling-stroke");
      page.overlay.append(draft);
      drag = { kind: "draw", page, start, draft, rect: undefined };
    }
    event.preventDefault();
    if (typeof page.overlay.setPointerCapture === "function") {
      try {
        page.overlay.setPointerCapture(event.pointerId);
      } catch {
        // No capture in this environment; the overlay's own move/up events still arrive.
      }
    }
    page.overlay.focus?.();
  };

  const onPointerMove = (page: PageEntry, event: PointerEvent): void => {
    if (!drag || drag.page !== page) {
      return;
    }
    const point = pointOf(page, event);
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    const size = { width: page.width, height: page.height };
    if (drag.kind === "draw") {
      const raw = {
        x: Math.min(drag.start.x, point.x),
        y: Math.min(drag.start.y, point.y),
        width: Math.abs(dx),
        height: Math.abs(dy)
      };
      drag.rect = clampAreaRect(raw, size, 0);
      setAttributes(drag.draft, { x: drag.rect.x, y: drag.rect.y, width: drag.rect.width, height: drag.rect.height });
      return;
    }
    const next = drag.kind === "move" ? { ...drag.from, x: drag.from.x + dx, y: drag.from.y + dy } : resized(drag.from, drag.handle, dx, dy, size);
    drag.rect = clampAreaRect(next, size);
    drag.moved = true;
    const group = page.areas.querySelector<SVGGElement>(byAttribute("data-area", drag.id));
    const box = group?.querySelector<SVGRectElement>(".dpd-area__box");
    if (box) {
      setAttributes(box, { x: drag.rect.x, y: drag.rect.y, width: drag.rect.width, height: drag.rect.height });
    }
    const label = group?.querySelector<SVGTextElement>(".dpd-area__label");
    if (label) {
      const fontSize = Number(label.getAttribute("font-size") ?? 8);
      setAttributes(label, { x: (drag.rect.x + 1.5).toFixed(2), y: (drag.rect.y + fontSize + 1).toFixed(2) });
    }
    if (group) {
      const rect = drag.rect;
      const handleSide = handleSize();
      for (const handle of group.querySelectorAll<SVGRectElement>("[data-handle]")) {
        const kind = handle.getAttribute("data-handle") ?? "";
        const cx = kind.includes("w") ? rect.x : kind.includes("e") ? rect.x + rect.width : rect.x + rect.width / 2;
        const cy = kind.includes("n") ? rect.y : kind.includes("s") ? rect.y + rect.height : rect.y + rect.height / 2;
        setAttributes(handle, { x: (cx - handleSide / 2).toFixed(2), y: (cy - handleSide / 2).toFixed(2) });
      }
    }
  };

  const onKeyDown = (page: PageEntry, event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      if (selected !== undefined) {
        selected = undefined;
        drawAreas();
        options.onSelect(undefined);
        event.preventDefault();
      }
      return;
    }
    if (selected === undefined) {
      return;
    }
    const area = areas.find((entry) => entry.id === selected);
    if (!area || area.page !== page.index) {
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      options.onAreaRemove(area.id);
      return;
    }
    const step = event.shiftKey ? NUDGE_FAST : NUDGE;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = delta[event.key];
    if (!move) {
      return;
    }
    event.preventDefault();
    const next = clampAreaRect({ ...area.rect, x: area.rect.x + move[0], y: area.rect.y + move[1] }, { width: page.width, height: page.height });
    if (!sameRect(next, area.rect)) {
      options.onAreaChange(area.id, next);
    }
  };

  scroll.addEventListener("pointerdown", (event) => {
    const overlay = (event.target as Element | null)?.closest<SVGSVGElement>(".dpd-page__overlay");
    const page = overlay ? pageAt(Number(overlay.getAttribute("data-page"))) : undefined;
    if (page) {
      onPointerDown(page, event);
    }
  });
  scroll.addEventListener("pointermove", (event) => {
    if (drag) {
      onPointerMove(drag.page, event);
    }
  });
  scroll.addEventListener("pointerup", (event) => endDrag(event));
  scroll.addEventListener("pointercancel", (event) => endDrag(event));
  scroll.addEventListener("keydown", (event) => {
    const overlay = (event.target as Element | null)?.closest<SVGSVGElement>(".dpd-page__overlay");
    const page = overlay ? pageAt(Number(overlay.getAttribute("data-page"))) : undefined;
    if (page) {
      onKeyDown(page, event);
    }
  });
  const zoom = (value: number | "fit"): void => {
    zoomFactor = value === "fit" ? 1 : Math.min(8, Math.max(0.25, value));
    applyScale();
    scheduleRerender();
  };

  const setDocument = (next: PdfTemplateInfo | undefined, bytes: Uint8Array | undefined): void => {
    closePageSet();
    const token = documentToken;
    inspection = next;
    selected = undefined;
    drag = undefined;
    buildPages();
    if (!next) {
      setStatus("empty", "");
      return;
    }
    applyScale();
    drawFields();
    drawAreas();
    openPictures(bytes, token);
  };

  // The fit follows the viewer's width: a surface built before it is on the page has none (the
  // fallback stands in), and a side panel opened or the inspector dragged wider changes it
  // later. A zoom is relative to the fit, so it holds across the refit.
  const refit = (): void => {
    if (pages.length === 0 || Math.abs(fitScale() * zoomFactor - scale) < 0.001) {
      return;
    }
    applyScale();
    scheduleRerender();
  };
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(refit) : undefined;
  resizeObserver?.observe(scroll);

  return {
    element,
    setDocument,
    setAreas: (next, selectedId) => {
      areas = next.map((area) => ({ ...area, rect: { ...area.rect } }));
      selected = selectedId !== undefined && areas.some((area) => area.id === selectedId) ? selectedId : undefined;
      drawAreas();
    },
    setMapped: (next, focused, missing = new Map()) => {
      mapped = next;
      unresolved = missing;
      focusedField = focused;
      drawFields();
    },
    select: (id) => {
      selected = id;
      drawAreas();
      const area = id === undefined ? undefined : areas.find((entry) => entry.id === id);
      if (area) {
        areaBox(area)?.scrollIntoView?.({ block: "nearest" });
      }
    },
    zoom,
    status: () => status,
    dispose: () => {
      resizeObserver?.disconnect();
      closePageSet();
      pages = [];
      scroll.innerHTML = "";
      element.remove();
    }
  };
}
