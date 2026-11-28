// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { checkJourneyTree, indexJourneyTree } from "../form-engine/builder/journey-designer/journey-checks.js";
import { createJourneyMap, type JourneyMap, type JourneyMapContext, type JourneyMapEdit, type JourneyMapSubject } from "../form-engine/builder/journey-map/journey-map.js";
import { journeyMapGraph } from "../form-engine/builder/journey-map/journey-map-model.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { mapSource, mapWords } from "./flowmap-words.js";

/**
 * Editing on the map, at the map's own seam: what it asks of the mode
 * (`JourneyMapEdit`, `onOpen`), when each button is on, what the bar counts, which keys act. The
 * mode's side, one undo each on the journey's controller, is held by the builder-journey-map
 * suite in packages/datum. jsdom lays nothing out and may not focus SVG, so focus is read
 * from the roving tab stop.
 */

function eq(path: string, value: string): string {
  return `${path} = ${JSON.stringify(value)}`;
}

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "age", type: "number", configuration: { label: "Age" } },
      { id: "method", type: "radio", configuration: { label: "Contact method" } },
      { id: "name", type: "text", configuration: { label: "Full name" } },
      { id: "email", type: "text", configuration: { label: "Email" } }
    ]
  }
};

const FOUR: Journey = {
  id: "four",
  pages: [
    { id: "about", title: "About you", components: ["name"] },
    { id: "contact", title: "Contact", components: ["method"], routes: [{ when: eq("method", "phone"), to: "details" }] },
    { id: "updates", title: "Updates", components: ["email"] },
    { id: "details", title: "Details", components: ["age"] }
  ]
};

const ONE: Journey = { id: "one", pages: [{ id: "solo", title: "Solo", components: ["name"], routes: [{ to: "$end" }] }] };

interface Calls {
  edits: string[];
  opened: string[];
  selected: string[];
  errors: string[];
}

function edits(calls: Calls): JourneyMapEdit {
  return {
    addStep: (after) => calls.edits.push(`add:${after ?? ""}`),
    newRule: (from, to) => calls.edits.push(`rule:${from}>${to}`),
    moveStep: (id, delta) => calls.edits.push(`move:${id}:${delta}`),
    duplicateStep: (id) => calls.edits.push(`copy:${id}`),
    deleteStep: (id) => calls.edits.push(`delete:${id}`)
  };
}

/** A map on the page over `journey`, selection held by the test, with every hook recorded. */
function setup(journey: Journey, context: Partial<JourneyMapContext> = {}, findings?: { errors: number; warnings: number }) {
  const calls: Calls = { edits: [], opened: [], selected: [], errors: [] };
  let selection: string | undefined;
  let { view } = mapSource(FORM, journey);
  const shown = (): typeof view => (findings ? { ...view, check: { ...view.check, findings: { ...view.check.findings, ...findings } } } : view);
  const subject: JourneyMapSubject = { journeyId: journey.id, name: () => journey.id, view: shown, selected: () => selection };
  const scroller = document.createElement("div");
  document.body.append(scroller);
  const map: JourneyMap = createJourneyMap({
    layout: { direction: "down" },
    words: (name) => mapWords(FORM, name),
    scroller,
    edit: edits(calls),
    onOpen: (id) => calls.opened.push(id),
    onSelect: (id) => {
      calls.selected.push(id);
      selection = id;
      map.select(subject);
    },
    onError: (message) => calls.errors.push(message),
    ...context
  });
  scroller.append(map.element);
  map.show(subject);
  const steps = view.index.pages.map((page) => page.nodeId);
  const select = (id: string | undefined): void => {
    selection = id;
    map.select(subject);
  };
  /** The step `gone` taken out of the tree as the mode's delete does (every other node keeps its id), another view for the same subject, and the map told. Returns the steps left. */
  const remove = (gone: string): string[] => {
    const tree = structuredClone(view.tree);
    tree.children!.pages = tree.children!.pages!.filter((page) => page.id !== gone);
    view = { tree, index: indexJourneyTree(tree), check: checkJourneyTree(FORM, tree, journey.id) };
    map.refresh(subject);
    return view.index.pages.map((page) => page.nodeId);
  };
  return { map, calls, steps, select, remove, subject };
}

const el = (map: JourneyMap, selector: string): HTMLElement | null => map.element.querySelector<HTMLElement>(selector);
const card = (map: JourneyMap, id: string): Element => map.element.querySelector(`[data-map-item="${id}"]`)!;
const sel = (map: JourneyMap, action: string): HTMLButtonElement => map.element.querySelector<HTMLButtonElement>(`[data-map-sel="${action}"]`)!;
const zone = (map: JourneyMap): HTMLElement => el(map, "[data-map-selzone]")!;
const status = (map: JourneyMap): string => el(map, "[data-map-status]")!.textContent!;
const tabStop = (map: JourneyMap): string[] => [...map.element.querySelectorAll('[data-map-stage] [data-map-item][tabindex="0"]')].map((each) => each.getAttribute("data-map-item")!);

function click(target: Element): void {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
}

function key(target: Element, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the map's bar when it can edit", () => {
  it("has Add step and New rule, named, in the toolbar's one tab stop, and the selected step's bar only with a step selected", () => {
    const { map, steps, select } = setup(FOUR);
    expect(map.element.hasAttribute("data-editable")).toBe(true);
    const add = el(map, "[data-map-add]")!;
    const rule = el(map, "[data-map-rule]")!;
    expect([add.textContent, rule.textContent]).toEqual(["Add step", "New rule"]);
    expect(add.tagName).toBe("BUTTON");
    // After the zoom, all one toolbar with one tab stop; no button of the bar sends the map to another view.
    const buttons = [...map.element.querySelectorAll<HTMLButtonElement>("[data-map-bar] button")];
    // The worded tool, then the accent action that adds, at the end of the pill.
    expect(buttons.indexOf(rule as HTMLButtonElement)).toBeLessThan(buttons.indexOf(add as HTMLButtonElement));
    expect(buttons.indexOf(add as HTMLButtonElement)).toBe(buttons.length - 1);
    expect(map.element.querySelector("[data-map-show]")).toBeNull();
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);

    // Nothing selected: Add step says the end, New rule is off, no bar.
    expect(add.title).toBe("Add an empty step at the end");
    expect(rule.getAttribute("aria-disabled")).toBe("true");
    expect(zone(map).hidden).toBe(true);

    select(steps[1]);
    expect(add.title).toBe("Add an empty step after the selected one");
    expect(rule.getAttribute("aria-disabled")).toBe("false");
    expect(zone(map).hidden).toBe(false);
    expect(el(map, "[data-map-selbar]")!.getAttribute("aria-label")).toBe("Selected step: Contact");
    expect(el(map, "[data-map-selname]")!.textContent).toBe("Contact");

    // Start and End are not steps.
    select("$start");
    expect(zone(map).hidden).toBe(true);
    select(undefined);
    expect(zone(map).hidden).toBe(true);
  });

  it("asks the mode for each change by node, and never writes anything itself", () => {
    const { map, calls, steps, select } = setup(FOUR);
    const picture = map.element.querySelector("svg")!;
    click(el(map, "[data-map-add]")!);
    select(steps[1]);
    click(el(map, "[data-map-add]")!);
    click(el(map, "[data-map-rule]")!);
    click(sel(map, "up"));
    click(sel(map, "down"));
    click(sel(map, "duplicate"));
    click(sel(map, "open"));
    click(sel(map, "delete"));
    expect(calls.edits).toEqual([
      "add:",
      `add:${steps[1]}`,
      `rule:${steps[1]}>${steps[2]}`,
      `move:${steps[1]}:-1`,
      `move:${steps[1]}:1`,
      `copy:${steps[1]}`,
      `delete:${steps[1]}`
    ]);
    expect(calls.opened).toEqual([steps[1]]);
    // The journey was not changed by any of it (the mode does, and the map draws again then).
    expect(map.element.querySelector("svg")).toBe(picture);
  });

  it("is in the step a route or a question belongs to when one of those is selected", () => {
    const { map, calls, steps, select, subject } = setup(FOUR);
    const { view } = mapSource(FORM, FOUR);
    const route = view.tree.children!.pages![1]!.children!.routes![0]!.id;
    select(route);
    expect(zone(map).hidden).toBe(false);
    expect(el(map, "[data-map-selname]")!.textContent).toBe("Contact");
    click(el(map, "[data-map-rule]")!);
    expect(calls.edits).toEqual([`rule:${steps[1]}>${steps[2]}`]);
    // A question on the third step.
    const question = view.tree.children!.pages![2]!.children!.content![0]!.id;
    select(question);
    expect(el(map, "[data-map-selname]")!.textContent).toBe("Updates");
    expect(subject.selected()).toBe(question);
  });

  it("turns Move up off on the first step, Move down on the last, Delete and New rule on the last step or the only step", () => {
    const { map, steps, select } = setup(FOUR);
    select(steps[0]);
    expect([sel(map, "up").disabled, sel(map, "down").disabled, sel(map, "delete").disabled]).toEqual([true, false, false]);
    expect(el(map, "[data-map-rule]")!.getAttribute("aria-disabled")).toBe("false");
    select(steps[3]);
    expect([sel(map, "up").disabled, sel(map, "down").disabled, sel(map, "delete").disabled]).toEqual([false, true, false]);
    // The last step has nothing after it to go to.
    expect(el(map, "[data-map-rule]")!.getAttribute("aria-disabled")).toBe("true");
    expect(el(map, "[data-map-rule]")!.title).toBe("Select a step that is not the last to add a rule from it");

    const only = setup(ONE);
    only.select(only.steps[0]);
    expect([sel(only.map, "up").disabled, sel(only.map, "down").disabled, sel(only.map, "delete").disabled]).toEqual([true, true, true]);
    expect(sel(only.map, "delete").getAttribute("data-tip")).toBe("A journey keeps at least one step");
    click(sel(only.map, "delete"));
    click(sel(only.map, "up"));
    // Duplicate and Open stay on: there is a step to copy and to open.
    expect([sel(only.map, "duplicate").disabled, sel(only.map, "open").disabled]).toEqual([false, false]);
    expect(only.calls.edits).toEqual([]);
    // Delete says what it does once there is a second step to keep.
    expect(sel(map, "delete").getAttribute("data-tip")).toBe("Delete this step");
  });

  it("gives every control a name, and keeps the bar one tab stop that the arrows walk", () => {
    const { map, steps, select } = setup(FOUR);
    select(steps[0]);
    const buttons = [...map.element.querySelectorAll<HTMLButtonElement>("[data-map-sel]")];
    expect(buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Open", "Move up", "Move down", "Duplicate", "Delete"]);
    for (const button of map.element.querySelectorAll("[data-map-bar] button, [data-map-sel]")) {
      expect((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()).not.toBe("");
    }
    expect(el(map, "[data-map-selbar]")!.getAttribute("role")).toBe("toolbar");
    const stops = (): string[] => buttons.filter((button) => button.tabIndex === 0).map((button) => button.dataset.mapSel!);
    expect(stops()).toHaveLength(1);
    // Move up is off on the first step: the arrows skip it.
    key(sel(map, "open"), "ArrowRight");
    expect(stops()).toEqual(["down"]);
    key(sel(map, "down"), "End");
    expect(stops()).toEqual(["delete"]);
    key(sel(map, "delete"), "ArrowRight");
    expect(stops()).toEqual(["open"]);
    key(sel(map, "open"), "ArrowLeft");
    expect(stops()).toEqual(["delete"]);
    // A button that goes off cannot keep the stop.
    select(steps[3]);
    expect(buttons.filter((button) => button.tabIndex === 0 && button.disabled)).toEqual([]);
    expect(stops()).toHaveLength(1);
    // Escape goes back to the step.
    key(sel(map, "delete"), "Escape");
    expect(tabStop(map)).toEqual([steps[3]]);
  });
});

describe("counts on the bar", () => {
  it("say steps, then errors and warnings only when there are some, singular and plural", () => {
    const none = setup(FOUR, {}, { errors: 0, warnings: 0 });
    expect(status(none.map)).toBe("4 steps");
    const one = setup(ONE, {}, { errors: 1, warnings: 1 });
    expect(status(one.map)).toBe("1 step · 1 error · 1 warning");
    const many = setup(FOUR, {}, { errors: 3, warnings: 2 });
    expect(status(many.map)).toBe("4 steps · 3 errors · 2 warnings");
    const errorsOnly = setup(FOUR, {}, { errors: 3, warnings: 0 });
    expect(status(errorsOnly.map)).toBe("4 steps · 3 errors");
    const warningsOnly = setup(FOUR, {}, { errors: 0, warnings: 1 });
    expect(status(warningsOnly.map)).toBe("4 steps · 1 warning");
  });

  it("come from the journey's own findings, in the graph, and the announcement keeps the longer line", () => {
    const { view, flow } = mapSource(FORM, FOUR);
    const graph = journeyMapGraph({ ...view, check: { ...view.check, findings: { ...view.check.findings, errors: 2, warnings: 0 } } }, flow, mapWords(FORM, "four"));
    expect(graph.bar).toBe("4 steps · 2 errors");
    expect(graph.status).toMatch(/^4 steps · 1 branch point · /);
    // The read-only map reads the same counts.
    const { map } = setup(FOUR, { readOnly: true }, { errors: 1, warnings: 0 });
    expect(status(map)).toBe("4 steps · 1 error");
  });
});

describe("keys", () => {
  it("Enter on a step selects and opens it; on anything else it only selects; Space only selects", () => {
    const { map, calls, steps } = setup(FOUR);
    key(card(map, steps[1]!), "Enter");
    expect(calls.selected).toEqual([steps[1]]);
    expect(calls.opened).toEqual([steps[1]]);
    key(card(map, steps[2]!), " ");
    expect(calls.selected).toEqual([steps[1], steps[2]]);
    expect(calls.opened).toEqual([steps[1]]);
    key(card(map, "$start"), "Enter");
    expect(calls.opened).toEqual([steps[1]]);
    // Shift+Enter is Enter: there is no other view left to show a step in.
    const again = setup(FOUR);
    key(card(again.map, again.steps[0]!), "Enter", { shiftKey: true });
    expect(again.calls.selected).toEqual([again.steps[0]]);
    expect(again.calls.opened).toEqual([again.steps[0]]);
  });

  it("Delete or Backspace on a step deletes it; not the only step, not a chip, not with Ctrl", () => {
    const { map, calls, steps } = setup(FOUR);
    const route = map.element.querySelector("[data-map-item^='journey-route']")!.getAttribute("data-map-item")!;
    expect(key(card(map, steps[2]!), "Delete").defaultPrevented).toBe(true);
    expect(key(card(map, steps[3]!), "Backspace").defaultPrevented).toBe(true);
    expect(key(card(map, route), "Delete").defaultPrevented).toBe(false);
    expect(key(card(map, "$end"), "Delete").defaultPrevented).toBe(false);
    expect(key(card(map, steps[0]!), "Delete", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(calls.edits).toEqual([`delete:${steps[2]}`, `delete:${steps[3]}`]);

    const only = setup(ONE);
    expect(key(card(only.map, only.steps[0]!), "Delete").defaultPrevented).toBe(false);
    expect(only.calls.edits).toEqual([]);
  });

  it("keeps the walk keys as they were", () => {
    const { map, steps } = setup(FOUR);
    key(card(map, "$start"), "ArrowDown");
    expect(tabStop(map)).toEqual([steps[0]]);
    key(card(map, steps[0]!), "End");
    expect(tabStop(map)).toEqual(["$end"]);
    key(card(map, "$end"), "Home");
    expect(tabStop(map)).toEqual(["$start"]);
  });
});

describe("focus after a delete", () => {
  it("goes to the step that took the place, once it is drawn gone; a deletion the author declined moves nothing", async () => {
    const { map, calls, steps, select, remove } = setup(FOUR);
    select(steps[1]);
    click(sel(map, "delete"));
    expect(calls.edits).toEqual([`delete:${steps[1]}`]);
    // Not deleted yet (the confirmation is up): nothing moves, and a redraw that still has it moves nothing.
    expect(tabStop(map)).not.toContain(steps[2]);
    map.refresh();
    await Promise.resolve();
    expect(tabStop(map)).not.toContain(steps[2]);
    // The journey as the mode writes it once confirmed: the step gone. The one after it is second now.
    const after = remove(steps[1]!);
    await Promise.resolve();
    await Promise.resolve();
    expect(map.element.querySelector(`[data-map-item="${steps[1]}"]`)).toBeNull();
    expect(tabStop(map)).toEqual([after[1]]);
  });

  it("goes to the one before when the last step was deleted", async () => {
    const { map, steps, select, remove } = setup(FOUR);
    select(steps[3]);
    click(sel(map, "delete"));
    const after = remove(steps[3]!);
    await Promise.resolve();
    await Promise.resolve();
    expect(tabStop(map)).toEqual([after[2]]);
  });
});

describe("opening a rule from the map", () => {
  const routeItem = (map: JourneyMap): Element => map.element.querySelector("[data-map-item^='journey-route'][data-edge]")!;
  const opened = (): { rules: string[]; hook: Pick<JourneyMapContext, "onOpenRule"> } => {
    const rules: string[] = [];
    return { rules, hook: { onOpenRule: (id) => rules.push(id) } };
  };

  it("a click on a rule's label selects its route and opens it in the Logic editor; a step, Start and End only select", () => {
    const { rules, hook } = opened();
    const { map, calls, steps } = setup(FOUR, hook);
    const chip = routeItem(map);
    const id = chip.getAttribute("data-map-item")!;
    click(chip);
    expect(calls.selected).toEqual([id]);
    expect(rules).toEqual([id]);
    click(card(map, steps[1]!));
    click(card(map, "$start"));
    click(card(map, "$end"));
    expect(rules).toEqual([id]);
    expect(calls.selected).toHaveLength(4);
  });

  it("Enter on a rule's label opens it too, after selecting it; Space only selects", () => {
    const { rules, hook } = opened();
    const { map, calls } = setup(FOUR, hook);
    const chip = routeItem(map);
    const id = chip.getAttribute("data-map-item")!;
    key(chip, " ");
    expect(rules).toEqual([]);
    key(chip, "Enter");
    expect(calls.selected).toEqual([id, id]);
    expect(rules).toEqual([id]);
    // A step still opens as a step, and asks nothing of the rule hook.
    key(card(map, map.element.querySelector("[data-map-item^='journey-page']")!.getAttribute("data-map-item")!), "Enter");
    expect(rules).toEqual([id]);
    expect(calls.opened).toHaveLength(1);
  });

  it("opens a rule the step never tries, from its stub", () => {
    const { rules, hook } = opened();
    const { map } = setup({ id: "two", pages: [{ id: "a", components: ["name"], routes: [{ to: "$end" }, { to: "$end" }] }] }, hook);
    const stub = map.element.querySelector("[data-stub]")!;
    expect(stub).not.toBeNull();
    click(stub);
    expect(rules).toEqual([stub.getAttribute("data-map-item")]);
  });

  it("a double click on a rule's label opens no step: the first click already left for Logic; a step's double click opens it", () => {
    const { rules, hook } = opened();
    const { map, calls, steps } = setup(FOUR, hook);
    const chip = routeItem(map);
    click(chip);
    chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true }));
    expect(rules).toHaveLength(1);
    expect(calls.opened).toEqual([]);
    card(map, steps[1]!).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true }));
    expect(calls.opened).toEqual([steps[1]]);
  });

  it("leaves out New rule and only selects a rule's label while the shell has no Logic workspace", () => {
    const { rules, hook } = opened();
    let available = false;
    const { map, calls, steps, select } = setup(FOUR, { ...hook, rulesEditable: () => available });
    select(steps[0]);
    expect(el(map, "[data-map-rule]")!.hidden).toBe(true);
    const chip = routeItem(map);
    click(chip);
    expect(calls.selected).toContain(chip.getAttribute("data-map-item"));
    expect(rules).toEqual([]);
    // A rule is no step: a double click on its label opens nothing either.
    chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true }));
    expect(calls.opened).toEqual([]);
    // The workspace back (the features list changed): the next draw offers New rule again, a click opens.
    available = true;
    select(steps[1]);
    expect(el(map, "[data-map-rule]")!.hidden).toBe(false);
    click(chip);
    expect(rules).toHaveLength(1);
  });

  it("asks nothing of a map that cannot edit, or that was given no hook, and reports a hook that throws", () => {
    const readOnly = opened();
    const looking = setup(FOUR, { readOnly: true, ...readOnly.hook });
    click(routeItem(looking.map));
    key(routeItem(looking.map), "Enter");
    expect(readOnly.rules).toEqual([]);
    const none = setup(FOUR);
    click(routeItem(none.map));
    expect(none.calls.errors).toEqual([]);
    const throwing = setup(FOUR, {
      onOpenRule: () => {
        throw new Error("refused");
      }
    });
    click(routeItem(throwing.map));
    expect(throwing.calls.errors).toEqual(["The map could not change the journey"]);
  });
});

describe("a map that cannot edit", () => {
  it("shows no Add step, New rule or selection bar when read-only, even with the means", () => {
    const { map, calls, steps } = setup(FOUR, { readOnly: true });
    expect(map.element.hasAttribute("data-editable")).toBe(false);
    for (const selector of ["[data-map-add]", "[data-map-rule]", "[data-map-selzone]", "[data-map-selbar]", "[data-map-sel]", "[data-map-show]"]) {
      expect(el(map, selector)).toBeNull();
    }
    // Keys do nothing either.
    key(card(map, steps[1]!), "Enter");
    expect(key(card(map, steps[1]!), "Delete").defaultPrevented).toBe(false);
    expect(calls).toEqual({ edits: [], opened: [], selected: [], errors: [] });
  });

  it("shows none of it without the means to edit (a map that only selects), and its Enter only selects", () => {
    const calls: Calls = { edits: [], opened: [], selected: [], errors: [] };
    const scroller = document.createElement("div");
    document.body.append(scroller);
    const { view } = mapSource(FORM, FOUR);
    const map = createJourneyMap({ layout: { direction: "down" }, words: (name) => mapWords(FORM, name), onSelect: (id) => calls.selected.push(id), onOpen: (id) => calls.opened.push(id) });
    scroller.append(map.element);
    map.show({ journeyId: "four", name: () => "four", view: () => view, selected: () => undefined });
    expect(map.element.hasAttribute("data-editable")).toBe(false);
    expect(map.element.querySelector("[data-map-add], [data-map-rule], [data-map-selzone]")).toBeNull();
    const first = view.index.pages[0]!.nodeId;
    key(map.element.querySelector(`[data-map-item="${first}"]`)!, "Enter");
    key(map.element.querySelector(`[data-map-item="${first}"]`)!, "Delete");
    expect(calls).toMatchObject({ selected: [first], opened: [], edits: [] });
    // No button of the bar sends a map that cannot edit to another view.
    expect(map.element.querySelector("[data-map-show]")).toBeNull();
  });

  it("reports a hook that throws and goes on", () => {
    const { map, calls, steps, select } = setup(FOUR, {
      edit: {
        ...edits({ edits: [], opened: [], selected: [], errors: [] }),
        moveStep: () => {
          throw new Error("refused");
        }
      }
    });
    select(steps[1]);
    click(sel(map, "up"));
    expect(calls.errors).toEqual(["The map could not change the journey"]);
    click(sel(map, "down"));
    expect(calls.errors).toHaveLength(2);
  });
});
