import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

// The Form panel's Browser assistants row: root.configuration.agentTools
// as "Not set" / "Allowed" / "Not on this form", drafted on the root, removed when Not set is saved.
function definition(configuration: Record<string, unknown> = {}): FormDefinition {
  const base = sampleDefinition();
  base.root.configuration = { ...(base.root.configuration as Record<string, unknown> | undefined), ...configuration };
  return base;
}

async function mount(configuration?: Record<string, unknown>, attributes: Record<string, string> = {}): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
  element.definition = definition(configuration);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;

/** The Form panel's shadow root, opened first: a panel behind its strip item does not paint. */
async function formPanel(element: DatumFormBuilderElement): Promise<ShadowRoot> {
  const panel = shell(element).querySelector("datum-builder-form-panel") as HTMLElement;
  if (panel.hidden) {
    shell(element).querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
  }
  await until(() => panel.shadowRoot?.querySelector(".panel"));
  return panel.shadowRoot!;
}

const select = (panel: ShadowRoot): HTMLSelectElement => panel.querySelector<HTMLSelectElement>("[data-agent-tools]")!;
const hint = (panel: ShadowRoot): string => panel.querySelector("[data-agent-tools-hint]")!.textContent!;
const draft = (element: DatumFormBuilderElement): unknown => element.builder!.activeController.draftProperty("root", "agentTools");
const committed = (element: DatumFormBuilderElement): Record<string, unknown> => element.controller!.snapshot().configuration as Record<string, unknown>;

function choose(panel: ShadowRoot, value: string): void {
  select(panel).focus();
  select(panel).value = value;
  select(panel).dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

const deepActive = (): Element | null => {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
};

describe("the Form panel's Browser assistants section", () => {
  it("shows Not set when the form sets nothing, with the three choices in order and the Not set line", async () => {
    const element = await mount();
    const panel = await formPanel(element);
    expect(panel.querySelector('[data-inspector-section="assistants"] summary')!.textContent).toBe("Browser assistants");
    expect(select(panel).value).toBe("");
    expect([...select(panel).options].map((option) => option.value)).toEqual(["", "allowed", "off"]);
    expect(hint(panel)).toContain("Sites that follow the form's setting keep assistants off this form");
    expect(select(panel).getAttribute("aria-describedby")).toBe("agent-tools-hint agent-tools-note");
  });

  it("is drawn after the Formulas section", async () => {
    const panel = await formPanel(await mount());
    const ids = [...panel.querySelectorAll<HTMLElement>("[data-inspector-section]")].map((section) => section.dataset.inspectorSection);
    expect(ids.indexOf("assistants")).toBe(ids.indexOf("formulas") + 1);
  });

  it("shows what the form sets, and a word it does not know as Not set", async () => {
    const allowed = await mount({ agentTools: "allowed" });
    expect(select(await formPanel(allowed)).value).toBe("allowed");
    expect(hint(await formPanel(allowed))).toBe("Assistants may fill this form where the site offers them.");
    document.body.innerHTML = "";
    const off = await mount({ agentTools: "off" });
    expect(select(await formPanel(off)).value).toBe("off");
    document.body.innerHTML = "";
    const odd = await mount({ agentTools: "maybe" });
    expect(select(await formPanel(odd)).value).toBe("");
  });

  it("drafts a choice on the root and lands it with Save; Cancel forgets it", async () => {
    const element = await mount();
    const panel = await formPanel(element);
    choose(panel, "allowed");
    expect(element.controller!.hasPendingChanges("root")).toBe(true);
    expect(draft(element)).toBe("allowed");
    // The panel repaints on the draft and replaces the select, so query it again: it must show the drafted choice, not the committed one.
    const repainted = select(await formPanel(element));
    expect(repainted.value).toBe("allowed");
    expect([...repainted.options].filter((option) => option.hasAttribute("selected")).map((option) => option.value)).toEqual(["allowed"]);
    expect(committed(element).agentTools).toBeUndefined();
    (await formPanel(element)).querySelector<HTMLElement>("[data-inspector-cancel]")!.click();
    expect(select(await formPanel(element)).value).toBe("");
    expect(element.controller!.hasPendingChanges("root")).toBe(false);

    choose(await formPanel(element), "off");
    (await formPanel(element)).querySelector<HTMLElement>("[data-inspector-save]")!.click();
    expect(committed(element).agentTools).toBe("off");
    expect(select(await formPanel(element)).value).toBe("off");
  });

  it("undoes a saved choice in one step", async () => {
    const element = await mount();
    choose(await formPanel(element), "allowed");
    (await formPanel(element)).querySelector<HTMLElement>("[data-inspector-save]")!.click();
    expect(committed(element).agentTools).toBe("allowed");
    element.controller!.undo();
    expect("agentTools" in committed(element)).toBe(false);
    await until(() => select(element.builder!.shadowRoot!.querySelector("datum-builder-form-panel")!.shadowRoot!).value === "");
  });

  it("removes the key on Save when Not set is chosen over a committed off", async () => {
    const element = await mount({ agentTools: "off" });
    expect("agentTools" in committed(element)).toBe(true);
    const panel = await formPanel(element);
    choose(panel, "");
    expect(draft(element)).toBeUndefined();
    expect(element.controller!.hasPendingChanges("root")).toBe(true);
    (await formPanel(element)).querySelector<HTMLElement>("[data-inspector-save]")!.click();
    expect("agentTools" in committed(element)).toBe(false);
    expect(select(await formPanel(element)).value).toBe("");
  });

  it("writes nothing when Not set is chosen again over a form that sets nothing", async () => {
    const element = await mount();
    const panel = await formPanel(element);
    choose(panel, "allowed");
    choose(panel, "");
    expect(element.controller!.hasPendingChanges("root")).toBe(false);
    expect("agentTools" in committed(element)).toBe(false);
  });

  it("the line under the select follows the choice", async () => {
    const element = await mount();
    const panel = await formPanel(element);
    choose(panel, "off");
    expect(hint(await formPanel(element))).toContain("For forms the person must complete themselves");
    choose(await formPanel(element), "allowed");
    expect(hint(await formPanel(element))).toBe("Assistants may fill this form where the site offers them.");
    choose(await formPanel(element), "");
    expect(hint(await formPanel(element))).toContain("Sites that follow the form's setting keep assistants off this form");
  });

  it("keeps the focus on the select across a repaint", async () => {
    const element = await mount();
    const panel = await formPanel(element);
    choose(panel, "off");
    // A repaint of the panel (a locale-independent one: the strip toggles nothing here) must not drop the focus.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const active = deepActive();
    expect(active?.hasAttribute("data-agent-tools")).toBe(true);
    element.builder!.activeController.setDraftProperty("root", "title", "Another title");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(deepActive()?.hasAttribute("data-agent-tools")).toBe(true);
  });

  it("is not on a component's inspector", async () => {
    const element = await mount();
    element.controller!.select("fullName");
    const inspector = shell(element).querySelector("datum-builder-properties") as HTMLElement;
    await until(() => inspector.shadowRoot?.querySelector("[data-inspector-tab]"));
    expect(inspector.shadowRoot!.querySelector("[data-agent-tools]")).toBeNull();
    expect(inspector.shadowRoot!.querySelector('[data-inspector-section="assistants"]')).toBeNull();
  });

  it("is still drawn when the builder's features leave out logic, where the Formulas section is not", async () => {
    const element = await mount({}, { features: "minimal" });
    const panel = await formPanel(element);
    expect(panel.querySelector('[data-inspector-section="formulas"]')).toBeNull();
    expect(select(panel)).not.toBeNull();
    expect(select(panel).value).toBe("");
  });
});
