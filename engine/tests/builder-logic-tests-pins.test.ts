// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineDatumBuilderElement, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import type { BuilderLogicOpenTestDetail, BuilderLogicWriteTestDetail, TestsPin, TestsPinsOf } from "../form-engine/builder/form-tests/tests-model.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/*
 * The Logic editor's "Pinned by" line and Open rule by kind. The
 * surface draws what the shell feeds it (`testsPins`) and raises two events; the shell's own feed
 * is covered with the shell (builder-tests-shell.test.ts). Here the surface is driven directly.
 */

defineDatumBuilderElement();

afterEach(() => {
  document.body.innerHTML = "";
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "subscribe", type: "checkbox", configuration: { label: "Subscribe" } },
        {
          id: "email",
          type: "text",
          configuration: { label: "Email" },
          rules: { visibleWhen: "subscribe", requiredWhen: "subscribe", validWhen: "subscribe" }
        }
      ]
    }
  };
}

async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("until(): condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface LogicSurface extends HTMLElement {
  testsPins: TestsPinsOf | undefined;
  openRuleFor(componentId: string, kind?: string): void;
}

async function mountInLogic(features?: string): Promise<{ element: DatumBuilderElement; surface: LogicSurface }> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot(), componentTypes: [{ type: "text", label: "Text" }, { type: "checkbox", label: "Checkbox" }] };
  if (features) {
    element.setAttribute("features", features);
  }
  document.body.append(element);
  await until(() => element.shadowRoot?.querySelector("[data-tests-panel-item]"));
  element.setWorkspace("logic");
  await until(() => element.shadowRoot?.querySelector("datum-builder-logic")?.shadowRoot?.querySelector("[data-logic-rule]"));
  return { element, surface: element.shadowRoot!.querySelector("datum-builder-logic") as LogicSurface };
}

const inside = (surface: LogicSurface): ShadowRoot => surface.shadowRoot!;
const editorKind = (surface: LogicSurface): string | null | undefined => inside(surface).querySelector("[data-logic-editor]")?.getAttribute("data-logic-kind");
const pinsLine = (surface: LogicSurface): HTMLElement | null => inside(surface).querySelector<HTMLElement>("[data-logic-pins]");
const SHOW_EMAIL = "form:email:visibleWhen";

function openCard(surface: LogicSurface, ruleId: string): void {
  inside(surface).querySelector<HTMLButtonElement>(`[data-logic-rule="${ruleId}"]`)!.click();
}

describe("the Pinned-by line", () => {
  it("draws nothing while the shell has fed no pins", async () => {
    const { surface } = await mountInLogic("minimal logic");
    openCard(surface, SHOW_EMAIL);
    expect(editorKind(surface)).toBe("show");
    expect(surface.testsPins).toBeUndefined();
    expect(pinsLine(surface)).toBeNull();
  });

  it("names the tests that pin the open rule as buttons that carry their ids", async () => {
    const { surface } = await mountInLogic("minimal logic");
    const pins: TestsPin[] = [
      { id: "test-1", name: "Email is shown when subscribed" },
      { id: "test-4", name: "Email is hidden otherwise" }
    ];
    const lookup = vi.fn<TestsPinsOf>(() => pins);
    openCard(surface, SHOW_EMAIL);
    surface.testsPins = lookup;
    const line = pinsLine(surface)!;
    expect(line.querySelector(".row-label")!.textContent).toBe("Pinned by:");
    const buttons = [...line.querySelectorAll<HTMLButtonElement>("[data-logic-open-test]")];
    expect(buttons.map((button) => button.dataset.logicOpenTest)).toEqual(["test-1", "test-4"]);
    expect(buttons.map((button) => button.textContent)).toEqual(["Email is shown when subscribed", "Email is hidden otherwise"]);
    expect(buttons[0]!.title).toBe('Open the test "Email is shown when subscribed"');
    expect(line.querySelector("[data-logic-write-test]")).toBeNull();
    // The line asks about the open rule, by its id.
    expect(lookup).toHaveBeenCalledWith(SHOW_EMAIL);
  });

  it("raises builder-logic-open-test with the entry id, composed so the shell hears it", async () => {
    const { surface } = await mountInLogic("minimal logic");
    openCard(surface, SHOW_EMAIL);
    surface.testsPins = () => [{ id: "test-4", name: "Email is hidden otherwise" }];
    const heard: Array<{ detail: BuilderLogicOpenTestDetail; bubbles: boolean; composed: boolean }> = [];
    surface.addEventListener("builder-logic-open-test", (event) => {
      event.stopPropagation();
      heard.push({ detail: (event as CustomEvent<BuilderLogicOpenTestDetail>).detail, bubbles: event.bubbles, composed: event.composed });
    });
    pinsLine(surface)!.querySelector<HTMLButtonElement>("[data-logic-open-test]")!.click();
    expect(heard).toEqual([{ detail: { entryId: "test-4" }, bubbles: true, composed: true }]);
  });

  it("says no test pins the rule, with Write a test, when the answer is empty", async () => {
    const { surface } = await mountInLogic("minimal logic");
    openCard(surface, SHOW_EMAIL);
    surface.testsPins = () => [];
    const line = pinsLine(surface)!;
    expect(line.textContent).toContain("No test pins this rule.");
    expect(line.querySelector("[data-logic-open-test]")).toBeNull();
    const write = line.querySelector<HTMLButtonElement>("[data-logic-write-test]")!;
    expect(write.textContent).toBe("Write a test");
    expect(write.dataset.logicWriteTest).toBe(SHOW_EMAIL);
  });

  it("raises builder-logic-write-test with the rule id", async () => {
    const { surface } = await mountInLogic("minimal logic");
    openCard(surface, SHOW_EMAIL);
    surface.testsPins = () => [];
    const heard: BuilderLogicWriteTestDetail[] = [];
    surface.addEventListener("builder-logic-write-test", (event) => {
      event.stopPropagation();
      heard.push((event as CustomEvent<BuilderLogicWriteTestDetail>).detail);
      expect(event.bubbles && event.composed).toBe(true);
    });
    pinsLine(surface)!.querySelector<HTMLButtonElement>("[data-logic-write-test]")!.click();
    expect(heard).toEqual([{ ruleId: SHOW_EMAIL }]);
  });

  it("draws nothing for a rule that is not saved yet", async () => {
    const { surface } = await mountInLogic("minimal logic");
    surface.testsPins = () => [];
    inside(surface).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
    inside(surface).querySelector<HTMLButtonElement>('[data-logic-new-kind="show"]')!.click();
    expect(inside(surface).querySelector("[data-logic-editor]")).not.toBeNull();
    expect(pinsLine(surface)).toBeNull();
  });

  it("draws when the pins arrive after the rule is open, and goes when they are taken away", async () => {
    const { surface } = await mountInLogic("minimal logic");
    openCard(surface, SHOW_EMAIL);
    expect(pinsLine(surface)).toBeNull();
    surface.testsPins = () => [{ id: "test-1", name: "One" }];
    expect(pinsLine(surface)).not.toBeNull();
    surface.testsPins = undefined;
    expect(pinsLine(surface)).toBeNull();
  });

  it("is drawn in the shell's own words from the catalog", async () => {
    const { element, surface } = await mountInLogic("minimal logic");
    openCard(surface, SHOW_EMAIL);
    surface.testsPins = () => [];
    element.textCatalog = { en: { "logic.pins.none": "Nothing checks this.", "logic.pins.write": "Add a check" } };
    await until(() => pinsLine(surface)?.textContent?.includes("Nothing checks this."));
    expect(pinsLine(surface)!.querySelector("[data-logic-write-test]")!.textContent).toBe("Add a check");
  });
});

describe("the shell's feed", () => {
  it("answers none for a form with no scenarios, so Write a test is the way in", async () => {
    const { surface } = await mountInLogic("minimal logic tests");
    expect(typeof surface.testsPins).toBe("function");
    expect(surface.testsPins!(SHOW_EMAIL)).toEqual([]);
    openCard(surface, SHOW_EMAIL);
    expect(pinsLine(surface)!.textContent).toContain("No test pins this rule.");
  });

  it("feeds nothing where the Tests feature is off", async () => {
    const { surface } = await mountInLogic("minimal logic");
    expect(surface.testsPins).toBeUndefined();
  });
});

describe("Open rule by kind", () => {
  it("opens the rule of the key the Tests panel names, on a field with several", async () => {
    const { surface } = await mountInLogic("minimal logic");
    surface.openRuleFor("email", "requiredWhen");
    expect(editorKind(surface)).toBe("require");
    surface.openRuleFor("email", "validWhen");
    expect(editorKind(surface)).toBe("validate");
    surface.openRuleFor("email", "visibleWhen");
    expect(editorKind(surface)).toBe("show");
  });

  it("opens the first rule when no kind is named, or the field has none of that kind", async () => {
    const { surface } = await mountInLogic("minimal logic");
    surface.openRuleFor("email");
    const first = editorKind(surface);
    expect(first).toBeTruthy();
    surface.openRuleFor("email", "requiredWhen");
    expect(editorKind(surface)).toBe("require");
    // The field has no enabledWhen rule: Open rule still lands on one of its rules rather than nowhere.
    surface.openRuleFor("email", "enabledWhen");
    expect(editorKind(surface)).toBe(first);
  });

  it("takes a Logic kind as it is and ignores a key it does not know", async () => {
    const { surface } = await mountInLogic("minimal logic");
    surface.openRuleFor("email", "require");
    expect(editorKind(surface)).toBe("require");
    surface.openRuleFor("email", "constructor");
    expect(editorKind(surface)).toBeTruthy();
  });

  it("does nothing for a component with no rule", async () => {
    const { surface } = await mountInLogic("minimal logic");
    surface.openRuleFor("subscribe", "visibleWhen");
    expect(inside(surface).querySelector("[data-logic-editor]")).toBeNull();
  });
});
