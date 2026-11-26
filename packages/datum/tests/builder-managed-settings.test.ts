import { afterEach, describe, expect, it } from "vitest";
import "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { sampleDefinition, until } from "./helpers.js";

// A host that strips an author's data.answersFree marks it managed.
afterEach(() => {
  document.body.innerHTML = "";
});

function definition(): FormDefinition {
  const base = sampleDefinition();
  const content = (base.root.children as unknown as Record<string, Array<Record<string, unknown>>>).content!;
  content.push({ id: "pick", type: "select", configuration: { label: "Pick", data: { sourceId: "cities" } } });
  return base;
}

async function inspectPick(attributes: Record<string, string>): Promise<ShadowRoot> {
  const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
  element.definition = definition();
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  element.controller!.select("pick");
  const root = element.builder!.shadowRoot!.querySelector("datum-builder-properties")!.shadowRoot!;
  await until(() => root.querySelector("[data-inspector-tab]"));
  return root;
}

describe("managed-settings", () => {
  it("shows the free-text switch by default", async () => {
    const root = await inspectPick({});
    await until(() => root.querySelector('[data-prop="data.answersFree"]'));
    expect(root.querySelector("[data-managed-setting]")).toBeNull();
  });

  it("replaces the switch with a managed-by-the-site note for answersFree", async () => {
    const root = await inspectPick({ "managed-settings": "answersFree" });
    await until(() => root.querySelector('[data-managed-setting="data.answersFree"]'));
    expect(root.querySelector('[data-prop="data.answersFree"]')).toBeNull();
    expect(root.querySelector('[data-managed-setting="data.answersFree"]')!.textContent).toContain("Managed by the site.");
  });

  // The Form panel's Browser assistants section is a managed row, not a select.
  it("draws the managed row for agentTools in the Form panel, with no select", async () => {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.definition = definition();
    element.setAttribute("managed-settings", "agentTools");
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const shell = element.builder!.shadowRoot!;
    const panel = shell.querySelector("datum-builder-form-panel") as HTMLElement;
    if (panel.hidden) {
      shell.querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
    }
    await until(() => panel.shadowRoot?.querySelector('[data-inspector-section="assistants"]'));
    const root = panel.shadowRoot!;
    expect(root.querySelector('[data-managed-setting="agentTools"]')!.textContent).toContain("Managed by the site.");
    expect(root.querySelector("[data-agent-tools]")).toBeNull();
    expect(root.querySelector('[data-inspector-section="assistants"] select')).toBeNull();
  });
});
