import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import { clearPanelMemory, panelMemoryStore, readPanelMemory, writePanelMemory } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  for (const key of ["t1", "t2", "t3", "default"]) {
    clearPanelMemory(key);
  }
});

async function mount(setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  setup?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  // This suite is about where the columns sit, not about what fills them, and the inspector
  // is only on screen while something is selected — so something is.
  const controller = element.builder!.activeController;
  controller.select(controller.snapshot().children!.content![0]!.id);
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const wrap = (element: DatumFormBuilderElement): HTMLElement => shell(element).querySelector<HTMLElement>(".wrap")!;
const properties = (element: DatumFormBuilderElement): HTMLElement & { collapsed: boolean } =>
  shell(element).querySelector("datum-builder-properties") as HTMLElement & { collapsed: boolean };
const stripTab = (element: DatumFormBuilderElement, panel: string): HTMLButtonElement =>
  shell(element).querySelector<HTMLButtonElement>(`[data-strip] [data-panel="${panel}"]`)!;
/** The folded inspector's stub button, which unfolds it; the open inspector has no fold control of its own. */
const inspectorToggle = (element: DatumFormBuilderElement): HTMLButtonElement =>
  properties(element).shadowRoot!.querySelector<HTMLButtonElement>("[data-panel-toggle]")!;

function dragResizer(element: DatumFormBuilderElement, kind: "side" | "props", delta: number): void {
  const grip = shell(element).querySelector<HTMLElement>(`[data-resizer="${kind}"]`)!;
  grip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, clientX: 100 }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 + delta }));
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: 100 + delta }));
}

/** Pretends the shell's wrap is `width` px wide, the way a real layout would, and tells the shell. */
function resizeTo(element: DatumFormBuilderElement, width: number): void {
  wrap(element).getBoundingClientRect = () =>
    ({ width, height: 700, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 700, toJSON: () => ({}) }) as DOMRect;
  window.dispatchEvent(new Event("resize"));
}

describe("remembered panels", () => {
  it("remembers the open panel and the dragged widths under persist-panels, and puts them back for the next shell with the key", async () => {
    const first = await mount((el) => el.setAttribute("persist-panels", "t1"));
    expect(first.persistPanels).toBe("t1");
    expect(first.builder!.persistPanels).toBe("t1");
    // Nothing was written by the shell merely coming up.
    expect(readPanelMemory("t1")).toBeUndefined();

    stripTab(first, "outline").click();
    expect(first.builder!.panel).toBe("outline");
    expect(readPanelMemory("t1")).toEqual({ panel: "outline", propsCollapsed: false, workspace: "form" });

    // The open inspector offers no fold of its own: it is a drawer that comes and
    // goes with the selection, so `propsCollapsed` is only ever a host's or a narrow shell's.
    expect(properties(first).shadowRoot!.querySelector("[data-panel-toggle]")).toBeNull();
    expect(properties(first).collapsed).toBe(false);

    // jsdom measures nothing, so the drag starts from the column's default width.
    dragResizer(first, "side", 60);
    expect(wrap(first).style.getPropertyValue("--db-side-w")).toBe("300px");
    expect(readPanelMemory("t1")).toEqual({ panel: "outline", sideWidth: 300, propsCollapsed: false, workspace: "form" });

    // Closing the side column is remembered as no panel.
    stripTab(first, "outline").click();
    expect(first.builder!.panel).toBeUndefined();
    expect(readPanelMemory("t1")?.panel).toBeNull();
    stripTab(first, "outline").click();

    first.remove();
    const second = await mount((el) => (el.persistPanels = "t1"));
    expect(second.getAttribute("persist-panels")).toBe("t1");
    expect(second.builder!.panel).toBe("outline");
    expect(wrap(second).hasAttribute("data-side-collapsed")).toBe(false);
    expect(properties(second).collapsed).toBe(false);
    expect(wrap(second).hasAttribute("data-props-collapsed")).toBe(false);
    expect(wrap(second).style.getPropertyValue("--db-side-w")).toBe("300px");
    expect(wrap(second).style.getPropertyValue("--db-props-w")).toBe("");
    // Putting a layout back writes nothing new.
    expect(readPanelMemory("t1")).toEqual({ panel: "outline", sideWidth: 300, propsCollapsed: false, workspace: "form" });
    second.remove();

    // Another key, and no key, start from the defaults.
    const third = await mount((el) => el.setAttribute("persist-panels", "t2"));
    // The form has components, so the palette is not opened over its canvas.
    expect(third.builder!.panel).toBeUndefined();
    expect(properties(third).collapsed).toBe(false);
    expect(wrap(third).style.getPropertyValue("--db-side-w")).toBe("");
    third.remove();
    const fourth = await mount();
    expect(fourth.persistPanels).toBeUndefined();
    stripTab(fourth, "outline").click();
    expect(readPanelMemory("default")).toBeUndefined();
  });

  it("ignores a record it cannot trust and takes an empty attribute as the default key", async () => {
    // Straight into the store the shell reads (localStorage where the page allows it, the engine's stand-in otherwise).
    panelMemoryStore().setItem("datum-builder:panels:default", "{broken");
    const element = await mount((el) => el.setAttribute("persist-panels", ""));
    expect(element.builder!.persistPanels).toBe("default");
    expect(element.builder!.panel).toBeUndefined();
    stripTab(element, "outline").click();
    expect(readPanelMemory("default")).toEqual({ panel: "outline", propsCollapsed: false, workspace: "form" });
  });
});

describe("the narrow layout", () => {
  it("puts both drawers away under 900px, shows one at a time, and comes back wide as it was", async () => {
    const element = await mount((el) => el.setAttribute("persist-panels", "t3"));
    const builder = element.builder!;
    stripTab(element, "outline").click();
    expect(readPanelMemory("t3")).toEqual({ panel: "outline", propsCollapsed: false, workspace: "form" });

    resizeTo(element, 600);
    expect(builder.narrowLayout).toBe(true);
    expect(wrap(element).hasAttribute("data-narrow")).toBe(true);
    expect(builder.panel).toBeUndefined();
    expect(wrap(element).hasAttribute("data-side-collapsed")).toBe(true);
    expect(properties(element).collapsed).toBe(true);
    expect(wrap(element).hasAttribute("data-props-collapsed")).toBe(true);
    // The drawers are a passing state: the wide layout stays what is remembered.
    expect(readPanelMemory("t3")).toEqual({ panel: "outline", propsCollapsed: false, workspace: "form" });

    // A panel opens as a drawer; the inspector stays folded.
    stripTab(element, "components").click();
    expect(builder.panel).toBe("components");
    expect(properties(element).collapsed).toBe(true);
    // The inspector opening from its stub puts the side column's drawer away.
    inspectorToggle(element).click();
    expect(properties(element).collapsed).toBe(false);
    expect(builder.panel).toBeUndefined();
    // And a panel opening again folds the inspector.
    stripTab(element, "outline").click();
    expect(builder.panel).toBe("outline");
    expect(properties(element).collapsed).toBe(true);
    expect(readPanelMemory("t3")).toEqual({ panel: "outline", propsCollapsed: false, workspace: "form" });

    // Wide again: the panels as they stood before the shell went narrow.
    resizeTo(element, 1300); // 1300: wide; 1200 is the medium tier, where one drawer sits beside the canvas.
    expect(builder.narrowLayout).toBe(false);
    expect(wrap(element).hasAttribute("data-narrow")).toBe(false);
    expect(builder.panel).toBe("outline");
    expect(properties(element).collapsed).toBe(false);
    expect(wrap(element).hasAttribute("data-props-collapsed")).toBe(false);
    // What is remembered is the wide layout as it stands, not the drawer the shell left.
    expect(readPanelMemory("t3")).toEqual({ panel: "outline", propsCollapsed: false, workspace: "form" });

    // A width the shell cannot measure (a detached element) is never narrow.
    resizeTo(element, 0);
    expect(builder.narrowLayout).toBe(false);
  });

  it("applies a remembered layout when it widens, when it came up narrow", async () => {
    // A record with the inspector folded: a host's doing, or one from before the inspector
    // lost its fold control; the shell still honours it.
    writePanelMemory("t3", { panel: "outline", propsCollapsed: true });

    const element = await mount((el) => el.setAttribute("persist-panels", "t3"));
    // The remembered layout is up, then the shell measures itself narrow.
    expect(element.builder!.panel).toBe("outline");
    resizeTo(element, 500);
    expect(element.builder!.panel).toBeUndefined();
    expect(properties(element).collapsed).toBe(true);
    resizeTo(element, 1000);
    expect(element.builder!.panel).toBe("outline");
    expect(properties(element).collapsed).toBe(true);
    expect(readPanelMemory("t3")).toEqual({ panel: "outline", propsCollapsed: true, workspace: "form" });
  });
});
