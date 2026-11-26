import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * "Required when" on the Rules tab is offered only where the fold reads it: a field
 * that holds an answer of its own, outside a repeating section, whose type offers Required. A
 * rule already on any other node stays on the tab under a note saying it is never enforced, so
 * the author can see it and take it off; a rule reading `host.` gets a note saying only the
 * browser checks it. The tab never promises a check that is not made.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const byName = { kind: "path", path: "fullName" } as const;
const hostRule = {
  kind: "binary",
  operator: "eq",
  left: { kind: "path", path: "host.role" },
  right: { kind: "literal", value: "staff" }
} as const;

function definition(): FormDefinition {
  const base = sampleDefinition();
  base.root.children!.content!.push(
    { id: "blurb", type: "html", configuration: { tag: "div", content: "<p>Read this.</p>" } },
    { id: "notice", type: "html", configuration: { tag: "div", content: "<p>Read this too.</p>" }, rules: { requiredWhen: byName } },
    { id: "staffNote", type: "text", configuration: { label: "Staff note" }, rules: { requiredWhen: hostRule } },
    // Nodes that hold no data, one of them carrying a calculation from before.
    { id: "greeting", type: "html", configuration: { tag: "p", content: "<p>Thanks</p>" }, rules: { value: byName } },
    { id: "go", type: "button", configuration: { label: "Go" } },
    { id: "plainGroup", type: "fieldset", configuration: { label: "Group" }, children: { content: [] } },
    {
      id: "items",
      type: "fieldset",
      configuration: { label: "Items" },
      collection: { itemFields: ["sku", "qty"], collectionPath: "items" },
      children: {
        content: [
          { id: "sku", type: "text", configuration: { label: "SKU" }, rules: { requiredWhen: byName } },
          { id: "qty", type: "text", configuration: { label: "Qty" } }
        ]
      }
    },
    // A data grid is a repeating section for these guards, through its collection binding.
    {
      id: "dependants",
      type: "dataGrid",
      configuration: { label: "Dependants" },
      collection: { collectionPath: "dependants" },
      children: {
        content: [
          { id: "depName", type: "text", configuration: { label: "Name" }, rules: { requiredWhen: byName } },
          { id: "depAge", type: "number", configuration: { label: "Age" } }
        ]
      }
    }
  );
  return base;
}

async function mount(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const inspector = (element: DatumFormBuilderElement): ShadowRoot =>
  element.builder!.shadowRoot!.querySelector("datum-builder-properties")!.shadowRoot!;

/**
 * Selects `id` and waits for the inspector to show it. The panel keeps its tab across a
 * selection change (a Rules tab stays open), and the id box lives on Properties, so the
 * helper moves there first; a fresh mount under a loaded runner can take a few seconds.
 */
async function select(element: DatumFormBuilderElement, id: string): Promise<void> {
  element.builder!.controller.select(id);
  await until(() => inspector(element).querySelector('[data-inspector-tab="properties"]'), 10_000);
  const properties = inspector(element).querySelector<HTMLButtonElement>('[data-inspector-tab="properties"]')!;
  if (!properties.classList.contains("active")) {
    properties.click();
  }
  await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === id, 10_000);
}

/** Opens the Rules tab for the selection and returns the rule keys it offers, in order. */
async function rulesOffered(element: DatumFormBuilderElement): Promise<string[]> {
  const root = inspector(element);
  root.querySelector<HTMLButtonElement>('[data-inspector-tab="rules"]')!.click();
  await until(() => root.querySelector('[data-inspector-tab="rules"].active') && root.querySelector("[data-rule-section]"), 10_000);
  return [...root.querySelectorAll<HTMLElement>("[data-rule-section]")].map((section) => section.dataset.ruleSection!);
}

const requiredWhenNotes = (element: DatumFormBuilderElement): Array<{ id: string; severity: string | undefined; text: string }> =>
  [...inspector(element).querySelectorAll<HTMLElement>('[data-note="rules:requiredWhen"]')].map((note) => ({
    id: note.id,
    severity: note.dataset.severity,
    text: note.textContent ?? ""
  }));

describe("Required when on the Rules tab", () => {
  it("offers it to a field, with no note, and leaves it out for a static block that carries none", async () => {
    const element = await mount();
    await select(element, "fullName");
    expect(await rulesOffered(element)).toContain("requiredWhen");
    expect(requiredWhenNotes(element)).toEqual([]);

    await select(element, "blurb");
    const offered = await rulesOffered(element);
    expect(offered).not.toContain("requiredWhen");
    // Its other rules are what they were.
    expect(offered).toContain("visibleWhen");
    expect(offered).toContain("enabledWhen");
  });

  it("keeps a rule already on a static block on the tab, under a note that it is never enforced", async () => {
    const element = await mount();
    await select(element, "notice");
    expect(await rulesOffered(element)).toContain("requiredWhen");
    const notes = requiredWhenNotes(element);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe("note-rules-requiredWhen-0");
    expect(notes[0]!.severity).toBe("warning");
    expect(notes[0]!.text).toMatch(/^Never enforced: this component holds no answer of its own\./);
    // The rule is drawn as it stands, on, and its box is described by the note.
    const section = inspector(element).querySelector<HTMLElement>('[data-rule-section="requiredWhen"]')!;
    expect(section.querySelector(".rule-state")!.textContent).toBe("on");
    const box = section.querySelector<HTMLTextAreaElement>('[data-rule="requiredWhen"][data-rule-formula]')!;
    expect(box.getAttribute("aria-describedby")).toContain("note-rules-requiredWhen-0");
  });

  it("says a rule reading host. is checked only in the browser", async () => {
    const element = await mount();
    await select(element, "staffNote");
    expect(await rulesOffered(element)).toContain("requiredWhen");
    const notes = requiredWhenNotes(element);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe(
      "Checked only in the browser: a server checking the submission has no host.role, so it does not hold this component to the rule."
    );
    expect(notes[0]!.severity).toBe("warning");
  });

  it("leaves it out inside a repeating section, and notes a rule already there", async () => {
    const element = await mount();
    await select(element, "qty");
    expect(await rulesOffered(element)).not.toContain("requiredWhen");

    await select(element, "sku");
    expect(await rulesOffered(element)).toContain("requiredWhen");
    const notes = requiredWhenNotes(element);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toMatch(/^Not enforced inside a repeating section:/);
  });
});

describe("a data grid and Required when", () => {
  it("offers the grid no Required when of its own, and its fields the rule with the repeating-section note", async () => {
    const element = await mount();
    await select(element, "dependants");
    const offered = await rulesOffered(element);
    expect(offered).not.toContain("requiredWhen");
    // It holds its rows as a section does, so a calculation and a default stay offered.
    expect(offered).toEqual(expect.arrayContaining(["visibleWhen", "value", "defaultValue"]));

    await select(element, "depAge");
    expect(await rulesOffered(element)).not.toContain("requiredWhen");

    await select(element, "depName");
    expect(await rulesOffered(element)).toContain("requiredWhen");
    const notes = requiredWhenNotes(element);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toMatch(/^Not enforced inside a repeating section:/);
  });
});

describe("Calculated value and Default value on the Rules tab", () => {
  const valueNotes = (element: DatumFormBuilderElement, key: string): string[] =>
    [...inspector(element).querySelectorAll<HTMLElement>(`[data-note="rules:${key}"]`)].map((note) => note.textContent ?? "");

  it("offers them to a field and a group that stores data, and leaves them out for static HTML, a button and a plain group", async () => {
    const element = await mount();
    await select(element, "fullName");
    expect(await rulesOffered(element)).toEqual(expect.arrayContaining(["value", "defaultValue"]));
    await select(element, "items");
    expect(await rulesOffered(element)).toEqual(expect.arrayContaining(["value", "defaultValue"]));
    for (const id of ["blurb", "go", "plainGroup"]) {
      await select(element, id);
      const offered = await rulesOffered(element);
      expect(offered, id).not.toContain("value");
      expect(offered, id).not.toContain("defaultValue");
      expect(offered, id).toContain("visibleWhen");
    }
  });

  it("keeps a calculation already on a static block on the tab, under a note that it is never worked out", async () => {
    const element = await mount();
    await select(element, "greeting");
    const offered = await rulesOffered(element);
    // Both value rules stay while one is there, so it can be taken off.
    expect(offered).toEqual(expect.arrayContaining(["value", "defaultValue"]));
    expect(valueNotes(element, "value")).toEqual(["Never worked out: this component holds no data of its own, so there is nowhere to put the result. Turn it off."]);
    expect(valueNotes(element, "defaultValue")).toEqual([]);
  });
});
