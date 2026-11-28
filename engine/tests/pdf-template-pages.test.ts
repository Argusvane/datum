// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { createTemplatePageViewer } from "../form-engine/builder/pdf-designer/template-pages.js";
import type { PdfAreaRect } from "../form-engine/builder/pdf-designer/template-mode.js";
import type { PdfTemplateArea } from "../form-engine/core/schema/pdf-layout.js";
import type { PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";

const LETTER = { pages: [{ index: 1, width: 612, height: 792 }], fields: [] } as unknown as PdfTemplateInfo;

/** jsdom has no PointerEvent: a mouse event with the pointer fields the viewer reads. */
function pointer(type: string, target: Element, x: number, y: number): void {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}

/** A viewer showing one Letter page with `rect` as its selected area, and the rectangles it reported. */
function rig(rect: PdfAreaRect) {
  const changes: PdfAreaRect[] = [];
  const viewer = createTemplatePageViewer({
    escape: (value: string) => value,
    onSelect: () => undefined,
    onAreaCreate: () => undefined,
    onAreaChange: (_id, next) => changes.push(next),
    onAreaRemove: () => undefined,
    onFieldClick: () => undefined
  });
  document.body.append(viewer.element);
  viewer.setDocument(LETTER, undefined);
  const area = { id: "note", page: 1, rect } as PdfTemplateArea;
  viewer.setAreas([area], "note");
  const overlay = viewer.element.querySelector<SVGSVGElement>("svg.dpd-page__overlay")!;
  // The overlay's box is the page at the viewer's scale; jsdom puts it at the origin.
  const scale = Number(overlay.getAttribute("width")) / 612;
  /** Drags `handle` (or the box, `"move"`) by `dx`, `dy` page points. */
  const drag = (handle: string, dx: number, dy: number): void => {
    const target =
      handle === "move"
        ? overlay.querySelector("[data-area='note'] .dpd-area__box")!
        : overlay.querySelector(`[data-area='note'] [data-handle='${handle}']`)!;
    const startX = handle === "move" || !handle.includes("e") ? rect.x : rect.x + rect.width;
    const startY = rect.y;
    pointer("pointerdown", target, startX * scale, startY * scale);
    pointer("pointermove", overlay, (startX + dx) * scale, (startY + dy) * scale);
    pointer("pointerup", overlay, (startX + dx) * scale, (startY + dy) * scale);
  };
  return { viewer, changes, drag };
}

describe("createTemplatePageViewer drags", () => {
  it("stops a resized edge at the page's edge and leaves the opposite edge where it was", () => {
    const east = rig({ x: 500, y: 100, width: 50, height: 20 });
    east.drag("e", 200, 0);
    expect(east.changes.at(-1)).toEqual({ x: 500, y: 100, width: 112, height: 20 });
    east.viewer.dispose();

    const west = rig({ x: 10, y: 100, width: 50, height: 20 });
    west.drag("w", -30, 0);
    expect(west.changes.at(-1)).toEqual({ x: 0, y: 100, width: 60, height: 20 });
    west.viewer.dispose();

    const north = rig({ x: 100, y: 10, width: 50, height: 20 });
    north.drag("n", 0, -30);
    expect(north.changes.at(-1)).toEqual({ x: 100, y: 0, width: 50, height: 30 });
    north.viewer.dispose();
  });

  it("still slides a moved box back onto the page whole", () => {
    const moved = rig({ x: 500, y: 100, width: 50, height: 20 });
    moved.drag("move", 200, 0);
    expect(moved.changes.at(-1)).toEqual({ x: 562, y: 100, width: 50, height: 20 });
    moved.viewer.dispose();
  });
});
