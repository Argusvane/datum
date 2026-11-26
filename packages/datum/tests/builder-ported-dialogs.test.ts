import { afterEach, describe, expect, it } from "vitest";

import type { DatumBuilderOptions } from "@argusvane/datum-engine";

import { standardComponentDefinitions, standardComponentTypes } from "../src/standard-components.js";
import { until } from "./helpers.js";
import { formOf, idsOf, keystroke, mountBuilder, previewOf, propsEl, propsOf, shellOf, textNode, toolbarOf } from "./builder-ported-fixture.js";

/*
 * The inspector's dialogs, the bar, the width controls and the panels' selection state: ported
 * from the retired demo app's builder tests so the builder's own suites keep them.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

type Bare = HTMLElement & {
  options: DatumBuilderOptions;
  value: unknown;
  controller: import("@argusvane/datum-engine").BuilderController;
  panel: string | undefined;
  undo(): void;
};

/** The bare `<datum-builder>` over the standard catalogue, as a host that wires the pieces itself mounts it. */
async function mountBare(options: DatumBuilderOptions): Promise<Bare> {
  const element = document.createElement("datum-builder") as Bare;
  document.body.append(element);
  element.options = { componentDefinitions: standardComponentDefinitions(), componentTypes: standardComponentTypes(), ...options };
  await until(() => (element.shadowRoot!.querySelector("datum-builder-canvas") as { previewRoot?(): ShadowRoot | undefined } | null)?.previewRoot?.()?.querySelector("form"));
  return element;
}

const emptyRoot = (configuration: Record<string, unknown> = {}) => ({ id: "root", type: "form", configuration, children: { content: [] } });

describe("leaving a component with unsaved edits", () => {
  /** Two fields, the first selected with a label typed into the panel but not saved. */
  async function editedFirstField() {
    const element = await mountBuilder(formOf([textNode("first", "First"), textNode("second", "Second")]));
    const controller = element.builder!.controller;
    controller.select("first");
    await until(() => propsOf(element).querySelector('input[data-prop="label"]'));
    keystroke(propsOf(element).querySelector<HTMLInputElement>('input[data-prop="label"]')!, "Typed, not saved");
    expect(controller.hasPendingChanges()).toBe(true);
    const clickAway = (): void => {
      previewOf(element)!
        .querySelector<HTMLElement>('.db-node[data-component-id="second"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    };
    return { element, controller, props: propsOf(element), clickAway };
  }

  const labelsOf = (element: Awaited<ReturnType<typeof mountBuilder>>): string[] =>
    (element.builder!.controller.snapshot().children!.content as Array<{ configuration: { label?: string } }>).map((node) => node.configuration.label ?? "");

  it("asks before the palette adds a component on top of unsaved edits, and Save adds it after the selection", async () => {
    const { element, controller, props } = await editedFirstField();
    toolbarOf(element).querySelector<HTMLButtonElement>('[data-add-type="text"]')!.click();

    // Nothing added yet; the panel says why.
    expect(idsOf(element)).toHaveLength(2);
    expect(props.querySelector("[data-unsaved-prompt]")!.textContent).toContain("before adding a component");
    props.querySelector<HTMLButtonElement>("[data-unsaved-save]")!.click();
    expect(idsOf(element)).toHaveLength(3);
    expect(labelsOf(element)[0]).toBe("Typed, not saved");
    // Added after the selection, and selected.
    expect(controller.selectedComponentId()).toBe(idsOf(element)[1]);
    expect(controller.selectedComponentId()).not.toBe("first");
  });

  it("shows the delete confirmation as an open dialog focused on Cancel, holds Enter, and keeps the draft on Escape", async () => {
    const { element, controller, props } = await editedFirstField();
    props.querySelector<HTMLButtonElement>("[data-inspector-delete]")!.click();

    const dialog = props.querySelector<HTMLDialogElement>("dialog[data-delete-prompt]");
    expect(dialog?.open).toBe(true);
    expect(props.activeElement).toBe(props.querySelector("[data-confirm-cancel]"));

    // Enter belongs to the dialog's buttons while it is up: it must not save the draft behind
    // the prompt's back the way the panel's Enter-saves shortcut otherwise would.
    props.querySelector("[data-confirm-cancel]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(controller.hasPendingChanges("first")).toBe(true);
    expect(props.querySelector("dialog[data-delete-prompt]")).toBeTruthy();

    props.querySelector("[data-confirm-cancel]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(props.querySelector("dialog[data-delete-prompt]")).toBeNull();
    expect(idsOf(element)).toHaveLength(2);
    expect(controller.hasPendingChanges("first")).toBe(true);
  });

  it("brings a collapsed properties rail back so the prompt can be seen", async () => {
    const { element, props, clickAway } = await editedFirstField();
    const rail = propsEl(element);
    rail.collapsed = true;
    expect(props.querySelector("[data-inspector-save]")).toBeNull();

    clickAway();
    expect(rail.collapsed).toBe(false);
    expect(propsOf(element).querySelector("[data-unsaved-prompt]")).toBeTruthy();
  });
});

describe("the bar's undo and redo", () => {
  it("enables undo and redo by the controller's history, lands a click on the glyph, and redoes", async () => {
    const element = await mountBare({ initialRoot: emptyRoot() as never });
    const shell = element.shadowRoot!;
    const undo = (): HTMLButtonElement => shell.querySelector<HTMLButtonElement>("[data-undo]")!;
    const redo = (): HTMLButtonElement => shell.querySelector<HTMLButtonElement>("[data-redo]")!;
    const count = (): number => ((element.value as { children?: { content?: unknown[] } }).children?.content ?? []).length;

    // The palette panel is a palette and nothing else; its title stays as a visually hidden heading.
    const toolbar = shell.querySelector("datum-builder-toolbar")!.shadowRoot!;
    expect(toolbar.querySelector("[data-toolbar-action]")).toBeNull();
    expect(toolbar.querySelector("[data-panel-toggle]")).toBeNull();
    expect(toolbar.querySelector(".panel-title--hidden")?.textContent).toContain("Components");
    expect(undo().closest('[data-shell="bar"]')).toBeTruthy();

    // Icon buttons, enabled by the controller's history.
    expect(undo().querySelector("svg")).toBeTruthy();
    expect(undo().disabled).toBe(true);
    expect(redo().disabled).toBe(true);
    element.controller.add("text");
    expect(undo().disabled).toBe(false);
    expect(redo().disabled).toBe(true);

    // The click lands on the glyph, as a pointer's would.
    undo().querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(count()).toBe(0);
    expect(undo().disabled).toBe(true);
    expect(redo().disabled).toBe(false);

    redo().click();
    expect(count()).toBe(1);
    expect(redo().disabled).toBe(true);
  });
});

describe("the selection and the panels", () => {
  it("takes the inspector away when the selection is put down, and opens the Form panel when the root is selected outright", async () => {
    const element = await mountBare({ initialRoot: emptyRoot({ title: "Customer Intake" }) as never });
    // Queried afresh each time: a repaint of the wrapper rebuilds the shell's markup.
    const props = (): ShadowRoot => element.shadowRoot!.querySelector("datum-builder-properties")!.shadowRoot!;
    const wrap = (): HTMLElement => element.shadowRoot!.querySelector<HTMLElement>(".wrap")!;
    const preview = (): ShadowRoot => (element.shadowRoot!.querySelector("datum-builder-canvas") as unknown as { previewRoot(): ShadowRoot }).previewRoot();

    // A fresh builder has no selection, so the inspector draws nothing: form-level properties
    // are the strip's Form panel, which is always on the root.
    expect(element.controller.selectedComponentId()).toBeUndefined();
    expect(props().innerHTML).toBe("");
    expect(wrap().hasAttribute("data-no-selection")).toBe(true);

    element.controller.add("text");
    await until(() => props().querySelector('input[data-prop="label"]'));
    expect(props().querySelector('input[data-prop="title"]')).toBeNull();
    expect(wrap().hasAttribute("data-no-selection")).toBe(false);

    // The background belongs to no component: clicking it puts the selection down, and the
    // inspector's column goes with it.
    preview().querySelector("[data-db-root]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(element.controller.selectedComponentId()).toBeUndefined();
    expect(props().innerHTML).toBe("");
    expect(wrap().hasAttribute("data-no-selection")).toBe(true);

    // Selecting the root outright still outlines it, and opens the Form panel rather than the
    // inspector: the root is edited in one place.
    element.controller.select(element.controller.rootId());
    await until(() => preview().host.hasAttribute("data-db-root-selected"));
    expect(element.panel).toBe("form");
    expect(props().innerHTML).toBe("");
    expect(wrap().hasAttribute("data-no-selection")).toBe(true);
  });

  it("edits the form's own settings on the Form panel, which draws no label, required or id box for the root", async () => {
    const element = await mountBare({ initialRoot: emptyRoot({ title: "Customer Intake" }) as never });
    const canvas = element.shadowRoot!.querySelector("datum-builder-canvas")!.shadowRoot!;
    expect(canvas.querySelector("[data-select-root]")).toBeNull();

    const panel = element.shadowRoot!.querySelector("datum-builder-form-panel") as HTMLElement;
    if (panel.hidden) {
      element.shadowRoot!.querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
    }
    const form = panel.shadowRoot!;
    await until(() => form.querySelector('input[data-prop="title"]'));
    expect(form.querySelector<HTMLInputElement>('input[data-prop="title"]')!.value).toBe("Customer Intake");
    expect(form.querySelector('input[data-prop="label"]')).toBeNull();
    expect(form.querySelector('input[data-prop="required"]')).toBeNull();
    expect(form.querySelector('input[data-prop="id"]')).toBeNull();
  });

  it("offers the form root only the rules that cascade to its fields on the Form panel, and a field all nine", async () => {
    const element = await mountBuilder(formOf([textNode("name", "Name")]));
    const controller = element.builder!.controller;
    const sections = (root: ShadowRoot): Array<string | undefined> =>
      [...root.querySelectorAll<HTMLElement>("[data-rule-section]")].map((section) => section.dataset.ruleSection);

    controller.select("name");
    await until(() => propsOf(element).querySelector('[data-inspector-tab="rules"]'));
    propsOf(element).querySelector<HTMLButtonElement>('[data-inspector-tab="rules"]')!.click();
    // The gates and requirements, plus "Valid when" a field offers where the fold reads requiredWhen.
    expect(sections(propsOf(element))).toHaveLength(9);

    // The root's rules are the Form panel's: the visibility, enablement and read-only gates every descendant inherits.
    const panel = shellOf(element).querySelector("datum-builder-form-panel") as HTMLElement;
    if (panel.hidden) {
      shellOf(element).querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
    }
    await until(() => panel.shadowRoot!.querySelector('[data-inspector-tab="rules"]'));
    panel.shadowRoot!.querySelector<HTMLButtonElement>('[data-inspector-tab="rules"]')!.click();
    expect(sections(panel.shadowRoot!)).toEqual(["visibleWhen", "enabledWhen", "readonlyWhen"]);
    // The head says which tree's root it is, since two inspectors are on screen.
    expect(panel.shadowRoot!.querySelector(".inspector-head")!.textContent).toContain("Form");
    // The inspector beside it is still the selection's, untouched.
    expect(sections(propsOf(element))).toHaveLength(9);
  });
});

describe("the preview width", () => {
  const surface = (element: Bare): HTMLElement => element.shadowRoot!.querySelector("datum-builder-canvas")!.shadowRoot!.querySelector<HTMLElement>(".canvas-surface")!;

  it("previews the form at a chosen width without touching the form itself, and reads a width no device has as Custom", async () => {
    const element = await mountBare({ initialRoot: emptyRoot() as never });
    const select = element.shadowRoot!.querySelector<HTMLSelectElement>("[data-preview-width]")!;
    const readout = (): HTMLElement => element.shadowRoot!.querySelector<HTMLElement>("[data-width-readout]")!;
    expect(surface(element).style.width).toBe("");
    expect([...select.options].map((option) => option.value)).toContain("430");
    expect(select.selectedOptions[0]!.textContent).toBe("Fit page");

    // Picking a device makes the sheet that wide for real: width, not a max-width cap.
    select.value = "430";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(element.controller.previewWidth()).toBe(430);
    expect(surface(element).style.width).toBe("430px");
    expect(surface(element).style.maxWidth).toBe("none");
    // A constraint on the canvas, not an edit: the form itself is untouched.
    expect(element.value).toMatchObject({ id: "root", type: "form" });
    expect(readout().hidden).toBe(false);
    expect(readout().textContent).toBe("430px");

    element.controller.setPreviewWidth(517);
    expect(select.selectedOptions[0]!.textContent).toBe("Custom");
    expect(readout().textContent).toBe("517px");

    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(element.controller.previewWidth()).toBeUndefined();
    expect(surface(element).style.width).toBe("");
    expect(readout().hidden).toBe(true);
  });

  it("gives the sheet's width to the tree when the host fixes it, puts the width controls away, and hands the width back when the host lets go", async () => {
    // The PDF designer's page has no device to preview on: its width is the page's. The host
    // hands the builder a sheetWidth read off the tree; the canvas sizes the sheet from it and
    // hides the picker, readout and grips, since none of them could change anything.
    const element = await mountBare({
      initialRoot: emptyRoot({ width: 500 }) as never,
      sheetWidth: (root) => (root.configuration as { width?: number }).width
    });
    const panel = element.shadowRoot!.querySelector("datum-builder-canvas")!.shadowRoot!;
    const widthField = (): HTMLElement => element.shadowRoot!.querySelector<HTMLElement>("[data-width-field]")!;
    expect(surface(element).style.width).toBe("500px");
    expect(surface(element).style.maxWidth).toBe("none");
    // The width is the form's, with the sheet's padding around it: content-box, by the attribute.
    expect(surface(element).hasAttribute("data-sheet-fixed")).toBe(true);
    expect(panel.querySelector("style")!.textContent).toContain(".canvas-surface[data-sheet-fixed] { box-sizing: content-box; }");
    expect(widthField().hidden).toBe(true);
    expect(element.shadowRoot!.querySelector<HTMLElement>("[data-width-readout]")!.hidden).toBe(true);
    const grips = panel.querySelectorAll<HTMLElement>("[data-sheet-grip]");
    expect(grips).toHaveLength(2);
    for (const grip of grips) {
      expect(grip.hidden).toBe(true);
    }

    // The tree moves it, not the author: an edit to the root re-sizes the sheet...
    element.controller.setProperty("root", "width", 640);
    expect(surface(element).style.width).toBe("640px");
    // ...and a width the author (or host) chooses is set aside while the tree has the say.
    element.controller.setPreviewWidth(430);
    expect(surface(element).style.width).toBe("640px");
    expect(element.value).toMatchObject({ id: "root", configuration: { width: 640 } });

    // A host taking the option back hands the sheet to the author again, at their width.
    element.options = { sheetWidth: undefined };
    expect(surface(element).hasAttribute("data-sheet-fixed")).toBe(false);
    expect(surface(element).style.width).toBe("430px");
    expect(widthField().hidden).toBe(false);
    for (const grip of grips) {
      expect(grip.hidden).toBe(false);
    }
  });
});

describe("the page the form sits on", () => {
  it("sits the form on a centred sheet with the page showing around it", async () => {
    const element = await mountBare({ initialRoot: emptyRoot() as never });
    const panel = element.shadowRoot!.querySelector("datum-builder-canvas")!.shadowRoot!;

    // The panel is the page; the sheet is inside it, and the preview is inside the sheet.
    expect(panel.querySelector(".panel--canvas")).toBeTruthy();
    const page = panel.querySelector(".canvas-page")!;
    const sheet = page.querySelector(".canvas-surface")!;
    expect(sheet.querySelector("datum-form-renderer")).toBeTruthy();

    // Centred, bounded by the sheet width, and the page is the horizontal scroller for an over-wide sheet.
    const css = panel.querySelector("style")!.textContent ?? "";
    expect(css).toContain("max-width: var(--db-sheet-w, 860px)");
    expect(css).toContain("margin: 0 auto");
    expect(css).toContain("overflow: auto");
  });

  it("fills the window below the host's app bar in the page layout, with nothing measured from script", async () => {
    const element = await mountBare({ initialRoot: emptyRoot() as never });
    const css = element.shadowRoot!.querySelector("style")!.textContent ?? "";
    expect(css).toContain("top: var(--db-shell-top, 0px); left: 0; right: 0; bottom: 0;");
    const wrap = element.shadowRoot!.querySelector<HTMLElement>(".wrap")!;
    expect(wrap.dataset.layout).toBeUndefined();
    expect(wrap.style.getPropertyValue("--db-topbar-h")).toBe("");
    expect(wrap.style.getPropertyValue("--db-rail-top")).toBe("");
    // The columns beside the canvas, each sized by a token the resizers rewrite.
    expect(css).toContain("--db-strip-w: 52px;");
    expect(css).toContain("--db-side-w: 240px;");
    expect(css).toContain("--db-props-w: 300px;");
    expect(element.shadowRoot!.querySelectorAll("[data-resizer]").length).toBe(2);
  });
});
