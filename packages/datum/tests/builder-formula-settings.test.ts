import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import { DatumBuilderElement, type ComponentNode } from "@argusvane/datum-engine";

afterEach(() => {
  document.body.innerHTML = "";
});

function formRoot(configuration: Record<string, unknown> = {}): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Sample", ...configuration },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
  };
}

function mount(configuration?: Record<string, unknown>): DatumBuilderElement {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot(configuration), componentTypes: [{ type: "text", label: "Text" }] };
  document.body.append(element);
  return element;
}

function formPanel(element: DatumBuilderElement): ShadowRoot {
  const panel = element.shadowRoot!.querySelector("datum-builder-form-panel") as HTMLElement;
  if (panel.hidden) {
    element.shadowRoot!.querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
  }
  return panel.shadowRoot!;
}

const select = (panel: ShadowRoot): HTMLSelectElement => panel.querySelector<HTMLSelectElement>("[data-formula-errors]")!;
const hint = (panel: ShadowRoot): string => panel.querySelector("[data-formula-errors-hint]")!.textContent!;

function choose(panel: ShadowRoot, value: string): void {
  select(panel).value = value;
  select(panel).dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

// The default is Fail, Warn is the explicit opt-in for preview and staging.
describe("the Form panel's Formulas section", () => {
  it("shows Fail when the form sets nothing, with the two choices (fail first) and a line for the chosen one", () => {
    const element = mount();
    const panel = formPanel(element);
    expect(panel.querySelector('[data-inspector-section="formulas"] summary')!.textContent).toBe("Formulas");
    expect(select(panel).value).toBe("fail");
    expect([...select(panel).options].map((option) => option.value)).toEqual(["fail", "warn"]);
    expect(hint(panel)).toContain("refuses");
    expect(select(panel).getAttribute("aria-describedby")).toBe("formula-errors-hint");
  });

  it("shows what the form sets, and a word it does not know as the default", () => {
    const element = mount({ formulaErrors: "warn" });
    expect(select(formPanel(element)).value).toBe("warn");
    expect(hint(formPanel(element))).toContain("run log");
    document.body.innerHTML = "";
    const unknown = mount({ formulaErrors: "ignore" });
    expect(select(formPanel(unknown)).value).toBe("fail");
  });

  it("drafts a choice on the root and lands it with Save; Cancel forgets it", () => {
    const element = mount();
    const panel = formPanel(element);
    choose(panel, "warn");
    expect(element.controller.hasPendingChanges("root")).toBe(true);
    expect(hint(panel)).toContain("run log");
    expect(element.controller.getProperty("root", "formulaErrors")).toBeUndefined();
    panel.querySelector<HTMLElement>("[data-inspector-cancel]")!.click();
    expect(select(formPanel(element)).value).toBe("fail");
    expect(element.controller.hasPendingChanges("root")).toBe(false);

    choose(formPanel(element), "warn");
    formPanel(element).querySelector<HTMLElement>("[data-inspector-save]")!.click();
    expect(element.controller.getProperty("root", "formulaErrors")).toBe("warn");
    expect(select(formPanel(element)).value).toBe("warn");
  });

  it("writes nothing when the default is chosen over a form that sets nothing", () => {
    const element = mount();
    const panel = formPanel(element);
    choose(panel, "warn");
    choose(panel, "fail");
    expect(element.controller.hasPendingChanges("root")).toBe(false);
    expect(element.controller.getProperty("root", "formulaErrors")).toBeUndefined();
  });

  it("is not on a component's inspector", () => {
    const element = mount();
    element.controller.select("fullName");
    const inspector = element.shadowRoot!.querySelector("datum-builder-properties") as HTMLElement;
    expect(inspector.shadowRoot!.querySelector("[data-formula-errors]")).toBeNull();
  });
});
