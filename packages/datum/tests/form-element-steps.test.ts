import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import "../src/builder.js";
import type { DatumFormElement } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";

import { until } from "./helpers.js";
import { box, control, type } from "./live-dom.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function journey(): FormDefinition {
  return {
    id: "journey-form",
    version: "1.0.0",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Apply" },
      children: {
        content: [
          {
            id: "journey",
            type: "steps",
            configuration: {},
            children: {
              content: [
                { id: "about", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }] } },
                { id: "where", type: "step", configuration: { label: "Where you live" }, children: { content: [{ id: "city", type: "text", configuration: { label: "City", required: true } }] } },
                {
                  id: "review",
                  type: "step",
                  configuration: { label: "Review" },
                  children: { content: [{ id: "send", type: "button", configuration: { label: "Send", action: "submit" } }] }
                }
              ]
            }
          }
        ]
      }
    }
  };
}

function mount(): DatumFormElement {
  const element = document.createElement("datum-form") as DatumFormElement;
  element.definition = journey();
  document.body.append(element);
  return element;
}

async function paintedForm(element: DatumFormElement): Promise<ShadowRoot> {
  await until(() => element.renderer?.shadowRoot?.querySelector("[data-step-container]"));
  return element.renderer!.shadowRoot!;
}

const panels = (form: ShadowRoot) => Array.from(form.querySelectorAll<HTMLElement>("[data-step-panel]")).map((panel) => `${panel.dataset.stepPanel}:${panel.hidden ? "hidden" : "shown"}`);
const statuses = (form: ShadowRoot) => Array.from(form.querySelectorAll<HTMLElement>("[data-step-status]")).map((entry) => entry.dataset.stepStatus);
/** The progress line: the polite region that says which step of how many is showing. */
const progress = (form: ShadowRoot): string => [...form.querySelectorAll('[aria-live="polite"]')].find((region) => /Step \d+ of \d+/.test(region.textContent ?? ""))?.textContent ?? "";
/** The fields the form reports invalid (the state hook), by component id. */
const invalidIds = (form: ShadowRoot): string[] => [...form.querySelectorAll<HTMLElement>("[data-component-id][data-invalid]")].map((field) => field.dataset.componentId!);
const inSummary = (form: ShadowRoot): boolean => form.querySelector("[data-datum-summary]")?.contains(form.activeElement) === true;
/** A move is over once Continue and Back are no longer marked busy. */
const moveOver = (form: ShadowRoot): Promise<void> => until(() => form.querySelector('[data-step-next][aria-disabled="true"], [data-step-prev][aria-disabled="true"]') === null);
const isHeading = (element: Element | null): boolean => /^H[1-6]$/.test(element?.tagName ?? "");

// A multi-step form navigates through the runtime, one step at a time.
describe("<datum-form> steps", () => {
  it("opens on the first step; Continue holds an invalid step and focuses its error, then advances a valid one, marking it completed and focusing the next heading", async () => {
    const element = mount();
    const form = await paintedForm(element);
    expect(panels(form)).toEqual(["about:shown", "where:hidden", "review:hidden"]);
    expect(statuses(form)).toEqual(["active", "upcoming", "upcoming"]);
    expect(progress(form)).toContain("Step 1 of 3");

    form.querySelector<HTMLElement>("[data-step-next]")!.click();
    // The step's own required field is reported; the form stays put.
    await until(() => invalidIds(form).length > 0);
    expect(panels(form)).toEqual(["about:shown", "where:hidden", "review:hidden"]);
    expect(box(form, "name").closest("[data-step-panel]")?.getAttribute("data-step-panel")).toBe("about");
    // The other step's required field is not: only the step in front of the person was checked.
    expect(invalidIds(form)).toEqual(["name"]);
    // Under Datum an invalid Continue moves focus to the error summary.
    await until(() => inSummary(form));

    type(control(form, "name"), "Ada");
    await until(() => element.runtime?.state().values.name === "Ada");
    form.querySelector<HTMLElement>("[data-step-next]")!.click();
    await until(() => panels(form).join() === "about:hidden,where:shown,review:hidden");
    expect(statuses(form)).toEqual(["completed", "active", "upcoming"]);
    expect(element.runtime?.state().navigation.currentStepId).toBe("where");
    expect([...(element.runtime?.state().navigation.completedSteps ?? [])]).toEqual(["about"]);
    expect(progress(form)).toContain("Step 2 of 3");
    // The errors of the step just left are gone with it.
    expect(invalidIds(form)).toEqual([]);
    // Focus moved to the new step's heading, which opens with the step's tag.
    await until(() => isHeading(form.activeElement));
    expect(form.activeElement?.textContent).toBe("Step 2 of 3: Where you live");
    // Back needs no check; a completed step can be reopened from the indicator too.
    form.querySelector<HTMLElement>("[data-step-prev]")!.click();
    await until(() => panels(form).join() === "about:shown,where:hidden,review:hidden");
    expect(statuses(form)).toEqual(["active", "visited", "upcoming"]);
    // An upcoming step is not a way to skip ahead.
    form.querySelector<HTMLElement>('[data-step-select="review"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(panels(form)).toEqual(["about:shown", "where:hidden", "review:hidden"]);
  });

  it("opens the step an error sits in when the whole form is validated from its last step", async () => {
    const element = mount();
    const form = await paintedForm(element);
    type(control(form, "name"), "Ada");
    await until(() => element.runtime?.state().values.name === "Ada");
    form.querySelector<HTMLElement>("[data-step-next]")!.click();
    await until(() => panels(form).join() === "about:hidden,where:shown,review:hidden");
    type(control(form, "city"), "Ottawa");
    await until(() => element.runtime?.state().values.city === "Ottawa");
    form.querySelector<HTMLElement>("[data-step-next]")!.click();
    await until(() => panels(form).join() === "about:hidden,where:hidden,review:shown");
    // The city is cleared behind the person's back (a rule, a host); Send validates everything.
    element.runtime!.setValue("city", "");
    form.querySelector<HTMLElement>('[data-button-action="submit"]')!.click();
    await until(() => panels(form).join() === "about:hidden,where:shown,review:hidden");
    await until(() => inSummary(form));
  });

  it("switches steps in place on the builder canvas, where Continue checks nothing", async () => {
    const builder = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    builder.definition = journey();
    document.body.append(builder);
    const canvas = () => builder.builder?.shadowRoot?.querySelector("datum-builder-canvas") as (HTMLElement & { previewRoot?: () => ShadowRoot | undefined }) | null;
    // The builder's first boot in a run loads its panels; give it room.
    await until(() => canvas()?.previewRoot?.()?.querySelector("[data-step-container]"), 15000);
    const preview = canvas()!.previewRoot!()!;
    expect(panels(preview)).toEqual(["about:shown", "where:hidden", "review:hidden"]);
    preview.querySelector<HTMLElement>("[data-step-next]")!.click();
    await until(() => panels(preview).join() === "about:hidden,where:shown,review:hidden");
    // The in-place switch keeps the progress line and the buttons on the step shown.
    expect(progress(preview)).toContain("Step 2 of 3");
    expect(progress(preview)).toContain("Where you live");
    await moveOver(preview);
    preview.querySelector<HTMLElement>('[data-step-select="review"]')!.click();
    await until(() => panels(preview).join() === "about:hidden,where:hidden,review:shown");
    expect(progress(preview)).toContain("Step 3 of 3");
    // Nothing past the last step: no Continue is drawn.
    expect(preview.querySelector("[data-step-next]")).toBeNull();
    await moveOver(preview);
    preview.querySelector<HTMLElement>('[data-step-select="about"]')!.click();
    await until(() => panels(preview).join() === "about:shown,where:hidden,review:hidden");
    expect(preview.querySelector('[aria-current="step"] [data-step-select]')?.getAttribute("data-step-select")).toBe("about");
    expect(progress(preview)).toContain("Step 1 of 3");
    expect(preview.querySelector("[data-step-next]")).not.toBeNull();
  });

  it("keeps the step the author opened across the canvas's repaints, and opens the step a selection or a dropped step lands on", async () => {
    const builder = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    builder.definition = journey();
    document.body.append(builder);
    const canvas = () => builder.builder?.shadowRoot?.querySelector("datum-builder-canvas") as (HTMLElement & { previewRoot?: () => ShadowRoot | undefined }) | null;
    await until(() => canvas()?.previewRoot?.()?.querySelector("[data-step-container]"), 15000);
    const preview = canvas()!.previewRoot!()!;
    const controller = builder.controller!;
    const labelOf = (id: string) => preview.querySelector(`.db-node[data-component-id="${id}"] label`)?.textContent ?? "";

    // The author opens the second step, then edits a component on the first: the repaint the
    // edit causes (a rebuild of the preview) leaves them where they were.
    preview.querySelector<HTMLElement>('[data-step-select="where"]')!.click();
    await until(() => panels(preview).join() === "about:hidden,where:shown,review:hidden");
    controller.setProperty("name", "label", "Your name");
    await until(() => labelOf("name").includes("Your name"));
    expect(panels(preview)).toEqual(["about:hidden", "where:shown", "review:hidden"]);
    // A selection-only repaint (the markup hooks redraw the selection chrome) too, when the
    // selection stays on that step.
    controller.select("city");
    await until(() => preview.querySelector('.db-node[data-component-id="city"]')?.classList.contains("db-selected"));
    expect(panels(preview)).toEqual(["about:hidden", "where:shown", "review:hidden"]);

    // Selecting a component on another step — from the tree, a click — opens that step.
    controller.select("name");
    await until(() => panels(preview).join() === "about:shown,where:hidden,review:hidden");
    // While an edit to the selected component leaves a step the author went to look at alone.
    preview.querySelector<HTMLElement>('[data-step-select="review"]')!.click();
    await until(() => panels(preview).join() === "about:hidden,where:hidden,review:shown");
    controller.setProperty("name", "label", "Full name");
    await until(() => labelOf("name").includes("Full name"));
    expect(panels(preview)).toEqual(["about:hidden", "where:hidden", "review:shown"]);

    // A step dropped into the container is never its first: it opens, drop zone and all,
    // rather than arriving hidden behind the step the container was showing.
    controller.add("step", "journey", "content");
    const added = controller.selectedComponentId()!;
    expect(added).not.toBe("review");
    await until(() => preview.querySelector(`[data-step-panel="${added}"]`));
    await until(() => panels(preview).join() === `about:hidden,where:hidden,review:hidden,${added}:shown`);
    expect(progress(preview)).toContain("Step 4 of 4");
    const zone = preview.querySelector<HTMLElement>(`[data-dropzone="true"][data-parent-id="${added}"]`);
    expect(zone).not.toBeNull();
    expect(zone!.closest<HTMLElement>("[data-step-panel]")?.hidden).toBe(false);
    // And a field dropped into that step is selected on a step already open: nothing moves.
    controller.add("text", added, "content");
    const field = controller.selectedComponentId()!;
    await until(() => preview.querySelector(`.db-node[data-component-id="${field}"]`));
    expect(panels(preview)).toEqual(["about:hidden", "where:hidden", "review:hidden", `${added}:shown`]);
  });
});

// A tabs container has no runtime state: the tab it shows lives in the markup alone, and a
// repaint — every keystroke is one — redraws the first tab. The renderer puts the shown tab
// back the way it puts the caret back.
describe("<datum-form> tabs across a repaint", () => {
  function tabbed(): FormDefinition {
    return {
      id: "tabbed-form",
      version: "1.0.0",
      schemaVersion: "1",
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            {
              id: "sections",
              type: "tabs",
              configuration: { tabs: [{ id: "tab_1", label: "First" }, { id: "tab_2", label: "Second" }] },
              children: {
                tab_1: [{ id: "first", type: "text", configuration: { label: "First field" } }],
                tab_2: [{ id: "second", type: "text", configuration: { label: "Second field" } }]
              }
            }
          ]
        }
      }
    };
  }
  const selectedTab = (form: ShadowRoot) => form.querySelector<HTMLElement>('[data-tab-select][aria-selected="true"]')?.dataset.tabSelect;

  it("keeps the tab being typed on, the caret with it", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    element.definition = tabbed();
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector('[data-tab-select="tab_2"]'));
    const form = element.renderer!.shadowRoot!;
    expect(selectedTab(form)).toBe("tab_1");
    form.querySelector<HTMLElement>('[data-tab-select="tab_2"]')!.click();
    expect(selectedTab(form)).toBe("tab_2");
    const second = control(form, "second");
    second.focus();
    type(second, "Ottawa");
    await until(() => element.runtime?.state().values.second === "Ottawa");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(selectedTab(form)).toBe("tab_2");
    expect(form.querySelector<HTMLElement>('[data-tab-panel="tab_2"]')?.hidden).toBe(false);
    expect(form.querySelector<HTMLElement>('[data-tab-panel="tab_1"]')?.hidden).toBe(true);
    expect(form.activeElement).toBe(control(form, "second"));
  });
});
