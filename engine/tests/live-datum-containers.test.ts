// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { html } from "../form-engine/render/live/lit.js";
import { createDatumBinding } from "../form-engine/render/live/datum/options.js";
import { definitionOf, runtimeOf, settled, quiet, unmountAll, wrapper } from "./live-chrome-harness.js";
import { controlFacts, groupFacts, mountDatum, textOf } from "./live-datum-kit.js";

/*
 * Datum's containers (render/live/datum/groups.ts, tabs.ts, steps.ts, grid.ts), drawn through mountLive
 * and read as a person or a screen reader meets them: roles, names, ids, descriptions and states,
 * and the DOM contract (`data-container-id`, `data-kind`). Which tab or step shows, the keys, the buttons' presses and the focus
 * after them are the renderer's and have their own tests (live-tabs, live-steps, live-data-grid);
 * these hold what the Datum adapters draw, and the seams (`controls`) that change it.
 */

afterEach(unmountAll);

const text = (id: string, label = id.toUpperCase(), extra: Record<string, unknown> = {}) => ({ id, type: "text", configuration: { label, ...extra } });
const q = <T extends Element = HTMLElement>(scope: ParentNode, selector: string): T => scope.querySelector(selector) as T;
const all = <T extends Element = HTMLElement>(scope: ParentNode, selector: string): T[] => Array.from(scope.querySelectorAll<T>(selector));
const texts = (nodes: Element[]): string[] => nodes.map((node) => textOf(node));

// ── The generic group, panel, layout grid, step and button group ───────────────────────────

describe("groups: the fieldset", () => {
  const group = (configuration: Record<string, unknown> = {}, type = "fieldset") => ({
    id: "address",
    type,
    configuration: { label: "Address", description: "Where you live", ...configuration },
    children: { content: [text("street", "Street"), text("city", "City")] }
  });

  it("draws a fieldset named by its legend and described by its hint", async () => {
    quiet();
    const definition = definitionOf([group()] as never);
    const m = await mountDatum(definition);
    const strip = (facts: ReturnType<typeof groupFacts>) => facts.map(({ legend, name, describedText }) => ({ legend, name, describedText }));
    expect(strip(groupFacts(m.root))).toEqual([{ legend: "Address", name: "Address", describedText: ["Where you live"] }]);
    expect(controlFacts(m.root).map((c) => [c.id, c.name])).toEqual([
      ["street", "Street"],
      ["city", "City"]
    ]);
    // The container keeps its DOM contract; its fields keep theirs.
    expect(q(m.root, '[data-container-id="address"]').getAttribute("data-kind")).toBe("fieldset");
    expect(m.form.adapterOf("address")).toMatchObject({ from: "binding", name: "datum-group" });
  });

  it("draws the form's root as no group, labelled or not: the form is the <form>, and its name is not said again with every field", async () => {
    quiet();
    const labelled = definitionOf([text("name", "Name")] as never);
    (labelled.root as { configuration: Record<string, unknown> }).configuration = { label: "Agent steps", description: "About this form" };
    const m = await mountDatum(labelled);
    expect(groupFacts(m.root)).toEqual([]);
    expect(m.root.querySelector("fieldset, [role=group]")).toBeNull();
    // Datum draws the root itself: nothing is reported as drawn by a fallback.
    expect(m.form.unsupported()).toEqual([]);
    expect(q(m.root, `[data-container-id="${labelled.root.id}"]`).contains(q(m.root, "#name"))).toBe(true);

    // A root with no label is the form itself: no group, no legend; a hint alone has nothing to describe.
    const bare = definitionOf([text("name", "Name")] as never);
    const bareNew = await mountDatum(bare);
    expect(bareNew.root.querySelector("fieldset")).toBeNull();
    const hintOnly = definitionOf([text("name", "Name")] as never);
    (hintOnly.root as { configuration: Record<string, unknown> }).configuration = { description: "About this form" };
    expect((await mountDatum(hintOnly)).root.querySelector("fieldset")).toBeNull();
  });

  it("keeps the legend for assistive technology when the author hid it, and marks it required or optional", async () => {
    quiet();
    const m = await mountDatum(definitionOf([group({ hideLabel: true, legendMark: "required" })] as never));
    const legend = q(m.root, "legend");
    expect(legend.className).toContain("datum-form__visually-hidden");
    expect(textOf(legend)).toBe("Address *");
  });

  it("draws no element of its own for a group with no name, and one for a group with classes", async () => {
    quiet();
    const bare = await mountDatum(definitionOf([group({ label: undefined, description: undefined })] as never));
    expect(bare.root.querySelector("fieldset")).toBeNull();
    expect(bare.root.querySelector(".datum-form__layout")).toBeNull();
    expect(all(bare.root, ".datum-live-field")).toHaveLength(2);

    const classed = await mountDatum(definitionOf([group({ label: undefined, description: undefined, cssClass: "acme-block" })] as never));
    expect(q(classed.root, '[data-container-id="address"] > div').className).toBe("datum-form__layout datum-form__layout--stack acme-block");
  });

  it("describes the fieldset by nothing where the design system's groups are described by nothing", async () => {
    quiet();
    const m = await mountDatum(definitionOf([group()] as never), { containers: { controls: { groupDescription: "none" } } });
    expect(q(m.root, "fieldset").hasAttribute("aria-describedby")).toBe(false);
    expect(textOf(q(m.root, ".datum-form__group-description"))).toBe("Where you live");
  });
});

describe("groups: the panel", () => {
  const panel = (configuration: Record<string, unknown> = {}) => ({
    id: "card",
    type: "panel",
    configuration: { label: "Details", ...configuration },
    children: { content: [text("a")] }
  });

  it("draws a section named by its heading, one level under the form", async () => {
    quiet();
    const m = await mountDatum(definitionOf([panel()] as never));
    const section = q(m.root, "section");
    expect(section.getAttribute("aria-labelledby")).toBe("card__group-label");
    // The heading that names it is a level under the form's own (an h1 by default).
    const heading = q(m.root, `[id="${section.getAttribute("aria-labelledby")}"]`);
    expect(heading.tagName).toBe("H2");
    expect(textOf(heading)).toBe("Details");
    expect(textOf(q(m.root, ".datum-form__panel-title"))).toBe("Details");
    expect(q(m.root, ".datum-form__panel-body").querySelector("input")).not.toBeNull();
  });

  it("is a plain card, not a region, where the design system draws it so", async () => {
    quiet();
    const m = await mountDatum(definitionOf([panel()] as never), { containers: { controls: { panelRegion: "none" } } });
    expect(q(m.root, "section").hasAttribute("aria-labelledby")).toBe(false);
  });

  it("draws no header for a panel with no name and keeps the author's classes", async () => {
    quiet();
    const m = await mountDatum(definitionOf([panel({ label: undefined, cssClass: "acme" })] as never));
    expect(m.root.querySelector(".datum-form__panel-header")).toBeNull();
    expect(q(m.root, "section").className).toBe("datum-form__panel acme");
  });

  it.each(["panel-plain", "panel-outlined", "panel-shaded", "panel-card"])("draws the look %s as a class on the same section, the heading still a real heading", async (look) => {
    quiet();
    const m = await mountDatum(definitionOf([panel({ cssClass: `acme ${look}` })] as never));
    const section = q(m.root, "section");
    expect(section.className).toBe(`datum-form__panel acme ${look}`);
    expect(section.getAttribute("aria-labelledby")).toBe("card__group-label");
    expect(q(m.root, "#card__group-label").tagName).toBe("H2");
    expect(q(m.root, ".datum-form__panel-body").querySelector("input")).not.toBeNull();
  });

  it("draws only the last look of a hand-written list (the one paper and the Style tab pick), the other classes untouched", async () => {
    quiet();
    const classOf = async (cssClass: string): Promise<string> => q((await mountDatum(definitionOf([panel({ cssClass })] as never))).root, "section").className;
    expect(await classOf("panel-shaded acme panel-card")).toBe("datum-form__panel acme panel-card");
    expect(await classOf("panel-card panel-shaded")).toBe("datum-form__panel panel-shaded");
    expect(await classOf("acme panel-outlined")).toBe("datum-form__panel acme panel-outlined");
  });

  it("styles the three looks beside the card, which the default panel keeps", async () => {
    const sheet = String(createDatumBinding().css);
    for (const look of ["panel-plain", "panel-outlined", "panel-shaded"]) {
      expect(sheet).toContain(`.datum-form__panel.${look}`);
    }
    // No look class is the card: no rule for it, the panel's own rule is the card.
    expect(sheet).not.toContain(".datum-form__panel.panel-card");
    expect(sheet).toMatch(/\.datum-form__panel\.panel-plain \{[^}]*overflow: visible/);
    expect(sheet).toMatch(/\.datum-form__panel\.panel-plain > \.datum-form__panel-body \{ padding: 0/);
  });
});

describe("groups: the layout grid", () => {
  const grid = (configuration: Record<string, unknown>) => ({
    id: "cols",
    type: "grid",
    configuration: { label: "Name", ...configuration },
    children: { column_1: [text("first", "First")], column_2: [text("last", "Last")], column_3: [text("title", "Title")] }
  });

  it("draws one cell per column, equal columns that fit the width", async () => {
    quiet();
    const m = await mountDatum(definitionOf([grid({ columns: 3 })] as never));
    const box = q(m.root, ".datum-form__layout--grid");
    expect(box.getAttribute("data-columns")).toBe("3");
    expect(box.getAttribute("data-fit")).toBe("auto");
    expect(box.hasAttribute("data-column-widths")).toBe(false);
    expect(all(m.root, ".datum-form__grid-column").map((cell) => cell.getAttribute("data-grid-column"))).toEqual(["column_1", "column_2", "column_3"]);
    // The legend is the group's, outside the grid.
    expect(textOf(q(m.root, "fieldset > legend"))).toBe("Name");
    expect(q(m.root, "fieldset > .datum-form__layout--grid")).not.toBeNull();
  });

  it("gives each cell its authored span of the twelve tracks", async () => {
    quiet();
    const m = await mountDatum(definitionOf([grid({ columns: "6,4,2" })] as never));
    const box = q(m.root, ".datum-form__layout--grid");
    expect(box.getAttribute("data-column-widths")).toBe("6,4,2");
    expect(box.hasAttribute("data-fit")).toBe(false);
    expect(all(m.root, ".datum-form__grid-column").map((cell) => cell.style.getPropertyValue("--datum-grid-span"))).toEqual(["6", "4", "2"]);
  });
});

describe("groups: a step outside a steps container", () => {
  it("is a section headed by its label, its heading the target for focus", async () => {
    quiet();
    const step = { id: "lone", type: "step", configuration: { label: "About you" }, children: { content: [text("a")] } };
    const m = await mountDatum(definitionOf([step] as never));
    const heading = q(m.root, ".datum-form__step-heading");
    expect(heading.tagName).toBe("H2");
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(textOf(heading)).toBe("About you");
    expect(q(m.root, "section").getAttribute("aria-labelledby")).toBe(heading.id);
  });
});

describe("groups: the button group", () => {
  const buttons = (configuration: Record<string, unknown> = {}) => ({
    id: "actions",
    type: "button-group",
    configuration,
    children: {
      content: [
        { id: "send", type: "button", configuration: { label: "Send", action: "submit" } },
        { id: "later", type: "button", configuration: { label: "Save for later", action: "download", variant: "link" } }
      ]
    }
  });

  it("draws a box of its buttons in order, with the author's classes", async () => {
    quiet();
    const m = await mountDatum(definitionOf([buttons({ cssClass: "acme-actions" })] as never));
    const box = q(m.root, ".datum-form__button-group");
    expect(box.tagName).toBe("DIV");
    expect(box.className).toBe("datum-form__button-group acme-actions");
    expect(texts(all(box, "button"))).toEqual(["Send", "Save for later"]);
    // Plain buttons (the host runs the action), the link variant drawn as Datum's link button.
    expect(all(box, "button").map((b) => [b.getAttribute("type"), b.className])).toEqual([
      ["button", "datum-form__button"],
      ["button", "datum-form__button datum-form__button--link"]
    ]);
  });

  it("draws a list of items where the design system draws the buttons so", async () => {
    quiet();
    const m = await mountDatum(definitionOf([buttons()] as never), { containers: { controls: { buttonGroup: "list" } } });
    expect(q(m.root, "ul.datum-form__button-group")).not.toBeNull();
    expect(all(m.root, "ul.datum-form__button-group > li.datum-form__button-group-item")).toHaveLength(2);
    expect(texts(all(m.root, "ul.datum-form__button-group > li button"))).toEqual(["Send", "Save for later"]);
  });

  it("draws no item for a hidden button", async () => {
    quiet();
    const hidden = buttons({});
    (hidden.children.content[1] as { configuration: Record<string, unknown> }).configuration["hidden"] = true;
    const m = await mountDatum(definitionOf([hidden] as never), { containers: { controls: { buttonGroup: "list" } } });
    expect(all(m.root, "li")).toHaveLength(1);
  });
});

// ── Tabs ───────────────────────────────────────────────────────────────────────────────────

describe("tabs", () => {
  const tabs = (configuration: Record<string, unknown> = {}) => ({
    id: "t",
    type: "tabs",
    configuration: { label: "Sections", tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }, { id: "three" }], ...configuration },
    children: { one: [text("a")], two: [text("b")], three: [text("c")] }
  });
  const tabFacts = (scope: ParentNode) => ({
    tabs: all(scope, '[role="tab"]').map((tab) => ({ id: tab.id, text: textOf(tab), controls: tab.getAttribute("aria-controls"), selected: tab.getAttribute("aria-selected"), tabindex: tab.getAttribute("tabindex") })),
    panels: all(scope, '[role="tabpanel"]').map((panel) => ({ id: panel.id, labelledBy: panel.getAttribute("aria-labelledby"), hidden: panel.hasAttribute("hidden") })),
    list: all(scope, '[role="tablist"]').length
  });

  it("draws a tab strip of one tab per panel, each tab controlling the panel it names, the first selected", async () => {
    quiet();
    const m = await mountDatum(definitionOf([tabs()] as never));
    expect(tabFacts(m.root)).toEqual({
      tabs: [
        { id: "t__tab-one", text: "One", controls: "t__panel-one", selected: "true", tabindex: "0" },
        { id: "t__tab-two", text: "Two", controls: "t__panel-two", selected: "false", tabindex: "-1" },
        { id: "t__tab-three", text: "Tab 3", controls: "t__panel-three", selected: "false", tabindex: "-1" }
      ],
      panels: [
        { id: "t__panel-one", labelledBy: "t__tab-one", hidden: false },
        { id: "t__panel-two", labelledBy: "t__tab-two", hidden: true },
        { id: "t__panel-three", labelledBy: "t__tab-three", hidden: true }
      ],
      list: 1
    });
    expect(m.form.adapterOf("t")).toMatchObject({ from: "binding", name: "datum-tabs" });
  });

  it("marks a tab holding an error, and keeps the author's classes on the root", async () => {
    quiet();
    const required = tabs({ cssClass: "acme-tabs" });
    (required.children.two[0] as { configuration: Record<string, unknown> }).configuration["required"] = true;
    const definition = definitionOf([required] as never);
    const runtime = runtimeOf(definition);
    const m = await mountDatum(definition, { runtime });
    await runtime.validate();
    await settled(m.form);
    expect(q(m.root, ".datum-form__tabs").className).toBe("datum-form__tabs acme-tabs");
    expect(all(m.root, "[data-has-errors]").map((tab) => tab.id)).toEqual(["t__tab-two"]);
  });

  it("draws every tab headed, in order, in a review", async () => {
    quiet();
    const m = await mountDatum(definitionOf([tabs()] as never), { mode: "readonly" });
    expect(all(m.root, '[role="tab"]')).toHaveLength(0);
    expect(texts(all(m.root, ".datum-form__panel-title"))).toEqual(["One", "Two", "Tab 3"]);
    // Each section is a region named by its heading.
    expect(all(m.root, "section.datum-form__tabs-section").map((section) => textOf(q(m.root, `[id="${section.getAttribute("aria-labelledby")}"]`)))).toEqual(["One", "Two", "Tab 3"]);
    const unnamed = await mountDatum(definitionOf([tabs()] as never), { mode: "readonly", containers: { controls: { panelRegion: "none" } } });
    expect(all(unnamed.root, "section.datum-form__tabs-section").every((section) => !section.hasAttribute("aria-labelledby"))).toBe(true);
  });

  it("draws a contents list over the stacked panels in the narrow view", async () => {
    quiet();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: () => void) {}
        observe(): void {
          queueMicrotask(this.callback);
        }
        disconnect(): void {}
      }
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 300, height: 100, top: 0, left: 0, right: 300, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    const binding = (await import("./live-datum-kit.js")).datumBinding();
    const narrow = { ...binding, tabsNarrowBelow: 600 };
    const { mounted } = await import("./live-chrome-harness.js");
    const { datumFeatures } = await import("./live-datum-kit.js");
    const m = await mounted(definitionOf([tabs()] as never), { binding: narrow, datum: narrow, features: datumFeatures() });
    await settled(m.form);
    const root = q(m.root, ".datum-form__tabs--responsive");
    expect(root.getAttribute("data-tabs-view")).toBe("contents");
    expect(texts(all(root, "ul.datum-form__tablist a"))).toEqual(["One", "Two", "Tab 3"]);
    expect(textOf(q(root, ".datum-form__tabs-title"))).toBe("Contents");
    expect(all(root, ".datum-form__tabpanel").every((panel) => !panel.hasAttribute("hidden") && panel.querySelector(".datum-form__tabpanel-heading") !== null)).toBe(true);
  });
});

// ── Steps ──────────────────────────────────────────────────────────────────────────────────

describe("steps", () => {
  const steps = (configuration: Record<string, unknown> = {}) => ({
    id: "journey",
    type: "steps",
    configuration,
    children: {
      content: [
        { id: "who", type: "step", configuration: { label: "About you" }, children: { content: [text("name", "Name")] } },
        { id: "where", type: "step", configuration: { label: "Where" }, children: { content: [text("city", "City")] } },
        { id: "done", type: "step", configuration: { label: "Done" }, children: { content: [text("note", "Note")] } }
      ]
    }
  });
  const stepFacts = (scope: ParentNode) => ({
    entries: all(scope, ".datum-form__step").map((entry) => ({ status: entry.getAttribute("data-step-status"), current: entry.getAttribute("aria-current"), text: textOf(entry), button: entry.querySelector("button") !== null })),
    progress: textOf(q(scope, ".datum-form__step-progress-text")),
    current: textOf(q(scope, ".datum-form__step-current")),
    panels: all(scope, ".datum-form__step-panel").map((panel) => ({ hidden: panel.hasAttribute("hidden"), step: panel.getAttribute("data-step-panel"), named: panel.hasAttribute("aria-labelledby"), heading: textOf(q(panel, ".datum-form__step-heading")), level: q(panel, ".datum-form__step-heading").tagName })),
    actions: texts(all(scope, ".datum-form__step-actions button"))
  });

  it("draws the indicator, one named panel per step with the first shown, and Continue", async () => {
    quiet();
    const m = await mountDatum(definitionOf([steps()] as never));
    const strip = (facts: ReturnType<typeof stepFacts>) => ({ ...facts, panels: facts.panels.map(({ hidden, step, named, heading }) => ({ hidden, step, named, heading })) });
    expect(strip(stepFacts(m.root))).toEqual({
      entries: [
        { status: "active", current: "step", text: "1About you", button: true },
        { status: "upcoming", current: null, text: "2Where not completed", button: true },
        { status: "upcoming", current: null, text: "3Done not completed", button: true }
      ],
      progress: "Step 1 of 3",
      current: "About you",
      panels: [
        { hidden: false, step: "who", named: true, heading: "Step 1 of 3: About you" },
        { hidden: true, step: "where", named: true, heading: "Step 2 of 3: Where" },
        { hidden: true, step: "done", named: true, heading: "Step 3 of 3: Done" }
      ],
      actions: ["Continue"]
    });
    expect(stepFacts(m.root).progress).toBe("Step 1 of 3");
    expect(stepFacts(m.root).actions).toEqual(["Continue"]);
    expect(q(m.root, ".datum-form__step-continue").hasAttribute("data-step-next")).toBe(true);
    expect(m.form.adapterOf("journey")).toMatchObject({ from: "binding", name: "datum-steps" });
  });

  it("opens the next step on Continue and then offers Back, the entries following", async () => {
    quiet();
    const m = await mountDatum(definitionOf([steps()] as never));
    q(m.root, ".datum-form__step-continue").click();
    await settled(m.form);
    expect(stepFacts(m.root).entries.map((entry) => entry.status)).toEqual(["completed", "active", "upcoming"]);
    expect(stepFacts(m.root).actions).toEqual(["Back", "Continue"]);
    expect(stepFacts(m.root).panels.map((panel) => panel.hidden)).toEqual([true, false, true]);
    expect(q(m.root, '.datum-form__step[data-step-status="completed"]').textContent).toContain("completed");
    // An upcoming entry is not a way to skip ahead.
    expect(q(m.root, '.datum-form__step[data-step-status="upcoming"] button').getAttribute("aria-disabled")).toBe("true");
  });

  it("draws every step headed and nothing else in a review", async () => {
    quiet();
    const m = await mountDatum(definitionOf([steps()] as never), { mode: "readonly" });
    expect(m.root.querySelector(".datum-form__step-indicator")).toBeNull();
    expect(m.root.querySelector(".datum-form__step-actions")).toBeNull();
    expect(texts(all(m.root, ".datum-form__step-heading"))).toEqual(["Step 1 of 3: About you", "Step 2 of 3: Where", "Step 3 of 3: Done"]);
    expect(all(m.root, ".datum-form__step-panel").every((panel) => !panel.hasAttribute("hidden"))).toBe(true);
  });

  it("follows the design system's controls: static entries, plain pages, the progress line before the list, Continue before Back", async () => {
    quiet();
    const controls = { stepSegments: "text", stepPages: "plain", stepProgress: "beforeList", actionOrder: "nextFirst" } as const;
    const m = await mountDatum(definitionOf([steps()] as never), { containers: { controls } });
    q(m.root, ".datum-form__step-continue").click();
    await settled(m.form);
    // Static text: no button, no role; the current segment is `aria-current="true"`.
    expect(all(m.root, ".datum-form__step button")).toHaveLength(0);
    expect(q(m.root, '.datum-form__step[data-step-status="active"]').getAttribute("aria-current")).toBe("true");
    // Pages: a plain caption, no live region, no region landmarks.
    expect(q(m.root, ".datum-form__step-progress").tagName).toBe("SPAN");
    expect(all(m.root, ".datum-form__step-panel").some((panel) => panel.hasAttribute("aria-labelledby"))).toBe(false);
    // Order.
    expect(Array.from(q(m.root, ".datum-form__step-indicator").children).map((child) => child.className.split(" ")[0])).toEqual(["datum-form__step-progress", "datum-form__step-list"]);
    expect(stepFacts(m.root).actions).toEqual(["Continue", "Back"]);
  });

  it("splits the step's tag around its number so a stylesheet can circle it", async () => {
    quiet();
    const m = await mountDatum(definitionOf([steps()] as never));
    const tag = q(m.root, ".datum-form__step-panel .datum-form__step-tag");
    expect(textOf(q(tag, ".datum-form__step-tag-lead"))).toBe("Step");
    expect(textOf(q(tag, ".datum-form__step-tag-number"))).toBe("1");
    expect(textOf(q(tag, ".datum-form__step-tag-rest"))).toBe("of 3");
  });
});

// ── The data grid ──────────────────────────────────────────────────────────────────────────

describe("data grid", () => {
  const grid = (configuration: Record<string, unknown> = {}) => ({
    id: "items",
    type: "dataGrid",
    configuration: { label: "Items", description: "What you bought", layout: "table", initialRows: 0, canReorder: false, ...configuration },
    children: { content: [text("sku", "SKU", { required: true }), text("qty", "Quantity")] }
  });
  const withRows = (configuration: Record<string, unknown>, count: number) => {
    const definition = definitionOf([grid(configuration)] as never);
    const runtime = runtimeOf(definition);
    runtime.addRows("items", Array.from({ length: count }, (_, at) => ({ sku: `S${at + 1}`, qty: `${at + 1}` })));
    return { definition, runtime };
  };
  const facts = (scope: ParentNode) => ({
    layout: q(scope, "fieldset.datum-form__datagrid").getAttribute("data-layout"),
    legend: textOf(q(scope, "fieldset.datum-form__datagrid > legend")),
    heads: texts(all(scope, ".datum-form__datagrid-colhead")),
    rowHeaders: texts(all(scope, "th.datum-form__datagrid-rownum")),
    rows: all(scope, "tbody > tr").map((row) => ({
      cells: all(row, ".datum-form__datagrid-cell").map((cell) => controlFacts(cell).map((c) => [c.id, c.value])),
      buttons: all(row, "button").map((button) => [textOf(button), (button as HTMLButtonElement).disabled, textOf(q(scope, `[id="${button.getAttribute("aria-describedby")}"]`))])
    })),
    add: all(scope, ".datum-form__datagrid-add").map((button) => [textOf(button), (button as HTMLButtonElement).disabled]),
    empty: all(scope, ".datum-form__datagrid-empty").map((node) => textOf(node))
  });

  it("draws a table: headings, a row header and cells per entry, the row's buttons named by their row, Add", async () => {
    quiet();
    const { definition, runtime } = withRows({}, 2);
    const m = await mountDatum(definition, { runtime });
    expect(facts(m.root)).toEqual({
      layout: "table",
      legend: "Items",
      heads: ["SKU *", "Quantity", "Actions"],
      rowHeaders: ["Row 1", "Row 2"],
      rows: [
        { cells: [[["sku-items_0__sku", "S1"]], [["qty-items_0__qty", "1"]]], buttons: [["Remove", false, "Row 1"]] },
        { cells: [[["sku-items_1__sku", "S2"]], [["qty-items_1__qty", "2"]]], buttons: [["Remove", false, "Row 2"]] }
      ],
      add: [["Add row", false]],
      empty: []
    });
    expect(facts(m.root)).toMatchObject({ layout: "table", heads: ["SKU *", "Quantity", "Actions"], rowHeaders: ["Row 1", "Row 2"], add: [["Add row", false]] });
    expect(facts(m.root).rows[0]?.buttons.map((button) => button[0])).toEqual(["Remove"]);
    expect(m.root.getElementById("items__add")).toBe(q(m.root, ".datum-form__datagrid-add"));
    expect(m.form.adapterOf("items")).toMatchObject({ from: "binding", name: "datum-grid" });
  });

  it("offers reorder buttons only where the grid has them, disabled at the ends", async () => {
    quiet();
    const { definition, runtime } = withRows({ canReorder: true }, 2);
    const m = await mountDatum(definition, { runtime });
    // Each button is described by its row.
    expect(facts(m.root).rows.map((row) => row.buttons.map((button) => button[2]))).toEqual([
      ["Row 1", "Row 1", "Row 1"],
      ["Row 2", "Row 2", "Row 2"]
    ]);
    expect(facts(m.root).rows.map((row) => row.buttons.map((button) => [button[0], button[1]]))).toEqual([
      [["Move up", true], ["Move down", false], ["Remove", false]],
      [["Move up", false], ["Move down", true], ["Remove", false]]
    ]);
  });

  it("stops Add at the maximum and Remove at the minimum, drawing the buttons disabled", async () => {
    quiet();
    const { definition, runtime } = withRows({ maxRows: 1, minRows: 1, initialRows: 1 }, 0);
    const m = await mountDatum(definition, { runtime });
    expect(facts(m.root).rows.map((row) => row.cells)).toEqual([[[["sku-items_0__sku", ""]], [["qty-items_0__qty", ""]]]]);
    expect(facts(m.root).add).toEqual([["Add row", true]]);
    expect(facts(m.root).rows[0]?.buttons).toEqual([["Remove", true, "Row 1"]]);
  });

  it("draws the empty line in place of the table, and keeps Add", async () => {
    quiet();
    const { definition, runtime } = withRows({}, 0);
    const m = await mountDatum(definition, { runtime });
    expect(facts(m.root)).toEqual({ layout: "table", legend: "Items", heads: [], rowHeaders: [], rows: [], add: [["Add row", false]], empty: ["No rows yet."] });
    expect(m.root.querySelector("table")).toBeNull();
  });

  it("names each row by a hidden span when the row numbers are off, and says so on the grid", async () => {
    quiet();
    const { definition, runtime } = withRows({ showRowNumbers: false }, 2);
    const m = await mountDatum(definition, { runtime });
    expect(q(m.root, "fieldset").getAttribute("data-row-numbers")).toBe("hidden");
    expect(facts(m.root).rowHeaders).toEqual([]);
    // The row's buttons are still described by the row's name.
    expect(facts(m.root).rows.map((row) => row.buttons)).toEqual([[["Remove", false, "Row 1"]], [["Remove", false, "Row 2"]]]);
  });

  it("draws the headings away when the grid shows none", async () => {
    quiet();
    const { definition, runtime } = withRows({ showHeader: false }, 1);
    const m = await mountDatum(definition, { runtime });
    expect(m.root.querySelector("thead")).toBeNull();
  });

  it("leaves the layout to the stylesheet: stacked and auto are the same DOM with another data-layout", async () => {
    quiet();
    const table = withRows({ layout: "table" }, 1);
    const stacked = withRows({ layout: "stacked" }, 1);
    const auto = withRows({ layout: "auto" }, 1);
    const mounts = await Promise.all([table, stacked, auto].map((fixture) => mountDatum(fixture.definition, { runtime: fixture.runtime })));
    expect(mounts.map((m) => q(m.root, "fieldset").getAttribute("data-layout"))).toEqual(["table", "stacked", "auto"]);
    expect(mounts.map((m) => q(m.root, "fieldset").getAttribute("data-columns"))).toEqual(["2", "2", "2"]);
    // One DOM: a table in each.
    expect(mounts.every((m) => m.root.querySelector("table") !== null)).toBe(true);
    // A cell's label is hidden under a table (the heading names it), kept stacked and left to the stylesheet under auto.
    const hidden = mounts.map((m) => all(m.root, ".datum-form__datagrid-cell .datum-form__label.datum-form__visually-hidden").length);
    expect(hidden).toEqual([2, 0, 0]);
  });

  it("draws a repeating section with the grid's rows whatever its container type", async () => {
    quiet();
    const section = { id: "kids", type: "fieldset", configuration: { label: "Children" }, collection: { collectionPath: "kids" }, children: { content: [text("nm", "Name")] } };
    const definition = definitionOf([section] as never);
    const runtime = runtimeOf(definition);
    runtime.addRows("kids", [{ nm: "A" }, { nm: "B" }]);
    const m = await mountDatum(definition, { runtime });
    expect(m.form.adapterOf("kids")).toMatchObject({ from: "binding", name: "datum-grid" });
    expect(all(m.root, "tbody > tr")).toHaveLength(2);
    expect(wrapper(m.root, "nm")).not.toBeNull();
  });
});

// ── Every container the engine has ─────────────────────────────────────────────────────────

describe("every container type", () => {
  it("is drawn by the Datum binding itself, with the DOM contract, and nothing is reported as unbound", async () => {
    quiet();
    const inside = (id: string) => [text(`${id}_a`, `${id} A`)];
    const definition = definitionOf([
      { id: "fs", type: "fieldset", configuration: { label: "Group" }, children: { content: inside("fs") } },
      { id: "ct", type: "container", configuration: {}, children: { content: inside("ct") } },
      { id: "pn", type: "panel", configuration: { label: "Panel" }, children: { content: inside("pn") } },
      { id: "gd", type: "grid", configuration: { columns: 2 }, children: { column_1: inside("gd"), column_2: [] } },
      { id: "st", type: "step", configuration: { label: "Lone step" }, children: { content: inside("st") } },
      { id: "bg", type: "button-group", configuration: {}, children: { content: [{ id: "bg_b", type: "button", configuration: { label: "Go", action: "submit" } }] } },
      { id: "tabs", type: "tabs", configuration: { tabs: [{ id: "x", label: "X" }] }, children: { x: inside("tabs") } },
      {
        id: "steps",
        type: "steps",
        configuration: {},
        children: { content: [{ id: "s1", type: "step", configuration: { label: "One" }, children: { content: inside("steps") } }] }
      },
      { id: "dg", type: "dataGrid", configuration: { label: "Rows", initialRows: 1 }, collection: { collectionPath: "dg" }, children: { content: inside("dg") } }
    ] as never);
    const m = await mountDatum(definition);
    expect(m.errors).toEqual([]);
    expect(m.form.unsupported()).toEqual([]);
    for (const id of ["fs", "ct", "pn", "gd", "st", "bg", "tabs", "steps", "dg"]) {
      const wrapperOf = m.root.querySelector(`[data-container-id="${id}"]`);
      expect(wrapperOf, id).not.toBeNull();
      expect(m.form.adapterOf(id)?.from, id).toBe("binding");
    }
    expect(m.root.querySelector(".datum-live-unknown")).toBeNull();
  });
});

// ── The seams reach the containers ───────────────────────────────────────────────

describe("containers: the parts and the inline-error control", () => {
  const legendGroup = (type: string, configuration: Record<string, unknown> = {}) => ({
    id: "address",
    type,
    configuration: { label: "Address", legendMark: "required", ...configuration },
    children: { content: [text("street", "Street")] }
  });
  const underMin = async (containers: Parameters<typeof mountDatum>[1] extends infer O ? (O extends { containers?: infer C } ? C : never) : never) => {
    quiet();
    const definition = definitionOf([
      {
        id: "items",
        type: "dataGrid",
        configuration: { label: "Items", legendMark: "optional", layout: "table", initialRows: 0, canReorder: false, minRows: 1 },
        children: { content: [text("sku", "SKU")] }
      }
    ] as never);
    const runtime = runtimeOf(definition);
    runtime.setValues({ items: [] });
    const m = await mountDatum(definition, { runtime, containers });
    await runtime.validate();
    await settled(m.form);
    return m;
  };

  it("draws a fieldset's, a panel's and a layout grid's legend mark through the labelMarks part", async () => {
    quiet();
    const seen: Array<[boolean, boolean, string]> = [];
    const parts = {
      labelMarks: (part: { required: boolean; announced: boolean; marker: string }) => {
        seen.push([part.required, part.announced, part.marker]);
        return html`<abbr class="acme-mark">${part.marker}</abbr>`;
      }
    };
    for (const type of ["fieldset", "panel", "grid"]) {
      const m = await mountDatum(definitionOf([legendGroup(type)] as never), { containers: { parts } });
      expect(all(m.root, '[data-container-id="address"] abbr.acme-mark'), type).toHaveLength(1);
      expect(m.root.querySelector(".datum-form__required"), type).toBeNull();
      unmountAll();
    }
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((entry) => entry[0] && entry[1] && entry[2] === "*")).toBe(true);
    // Without the part: Datum's own mark.
    const plain = await mountDatum(definitionOf([legendGroup("fieldset")] as never));
    expect(all(plain.root, "legend .datum-form__required")).toHaveLength(1);
  });

  it("draws a data grid's legend mark and its own error through the parts, with the id the grid names", async () => {
    const m = await underMin({
      parts: {
        labelMarks: (part) => html` <abbr class="acme-mark">${part.marker}</abbr>`,
        errorMessage: (part) => html`<p id=${part.id} class="acme-error" role=${part.role ?? "none"}>${part.message}</p>`
      }
    });
    expect(all(m.root, "legend abbr.acme-mark")).toHaveLength(1);
    const error = q(m.root, "p.acme-error");
    expect(textOf(error)).toContain("rows");
    expect(error.getAttribute("role")).toBe("alert");
    expect(q(m.root, "fieldset.datum-form__datagrid").getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
    expect(m.root.querySelector("p.datum-form__error")).toBeNull();
  });

  it("draws a data grid's own error as plain text under inlineErrors: plain", async () => {
    const alerted = await underMin({});
    expect(q(alerted.root, "p.datum-form__error").getAttribute("role")).toBe("alert");
    unmountAll();
    const plain = await underMin({ controls: { inlineErrors: "plain" } });
    const error = q(plain.root, "p.datum-form__error");
    expect(textOf(error)).toContain("rows");
    expect(error.hasAttribute("role")).toBe(false);
  });
});
