// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { createFormTextResolver } from "../form-engine/core/localization/form-texts.js";
import type {
  BindingFactory,
  DateFieldState,
  FieldAdapter,
  FieldEvents,
  GridAdapter,
  GridState,
  GroupAdapter,
  LiveBinding,
  TabsAdapter,
  TextFieldState,
  View
} from "../form-engine/render/live/contract.js";
import { drawingKindsOf, fieldCapabilitiesOf, gridLayoutFor, needsKindsEntry } from "../form-engine/render/live/contract.js";
import { createDataGridFeature } from "../form-engine/render/live/data-grid.js";
import { datePartsFocusTarget } from "../form-engine/render/live/datum/date.js";
import { createDatumBinding, createDatumFeatures, datumFieldStateBuilders } from "../form-engine/render/live/datum/options.js";
import { createFieldsFeature } from "../form-engine/render/live/fields.js";
import { markReadOnly } from "../form-engine/render/live/guards.js";
import { lit, type Lit } from "../form-engine/render/live/lit.js";
import type { LiveFeature } from "../form-engine/render/live/mount.js";
import { createSummaryFeature } from "../form-engine/render/live/summary.js";
import { createTabsFeature } from "../form-engine/render/live/tabs.js";
import { createBinding, definitionOf, mounted, quiet, runtimeOf, settled, unmountAll, wrapper } from "./live-chrome-harness.js";

/*
 * The contract changes needed to port GC Design System and GOV.UK onto the contract: the binding's date order, a grid adapter that draws no table, a binding's own tier-2
 * kinds, container capability answers, read-only marks through shadow roots, the ids a binding
 * writes, the sheets a design system leaves, Datum's tint on what Datum draws, the summary's
 * authored flag, the tab error word, `createBinding(lit, datum)` and a destructured `nothing`.
 */

afterEach(unmountAll);

const DATUM = createDatumBinding();

// ── createBinding(lit, datum) and a destructured `nothing` (compile-time) ──────────────────

/** A binding module as a design system writes one: lit destructured, Datum's date wrapped rather than copied. */
const factory: BindingFactory = (l: Lit, datum: LiveBinding) => {
  const { html, nothing } = l;
  const maybe = (text: string | undefined): View => (text === undefined ? nothing : html`<p>${text}</p>`);
  const datumDate = datum.components.date as FieldAdapter<DateFieldState>;
  const date: FieldAdapter<DateFieldState> = { ...datumDate, name: "wrapped-date", template: (s, on) => html`<div class="ds-date">${datumDate.template(s, on)}${maybe(s.hint)}</div>` };
  return { id: "ds", label: "DS", components: { date } };
};

describe("createBinding(lit, datum)", () => {
  it("hands a binding Datum's adapters to wrap, and a destructured nothing is a View", async () => {
    const binding = factory(lit, DATUM);
    const m = await mounted(definitionOf([{ id: "born", type: "date", configuration: { label: "Born", description: "Day first" } }]), { binding, datum: DATUM, features: createDatumFeatures() });
    expect(m.root.querySelector(".ds-date [data-value-part]")).not.toBeNull();
    expect(m.form.adapterOf("born")).toMatchObject({ from: "binding", name: "wrapped-date" });
    expect(m.form.unsupported()).toEqual([]);
  });
});

// ── Date part order ────────────────────────────────────────────────────────────────────────

/** A date adapter that records the state it was handed, and the events to report parts with. */
function recordingDate(seen: DateFieldState[], handed: FieldEvents[]): FieldAdapter<DateFieldState> {
  return {
    kind: "field",
    name: "ds-date",
    capabilities: { hideLabel: "drawn" },
    template: (s, on) => {
      seen.push(s);
      handed.push(on);
      return lit.html`<input id=${s.id} />`;
    }
  };
}

describe("date part order: the drawing binding's dateOrder", () => {
  const dateForm = () => definitionOf([{ id: "born", type: "date", configuration: { label: "Born" } }]);

  /** Mounts the form under a binding whose date adapter records its state, types only the year, and says what the state lacked. */
  async function missingAfterYear(extra: Partial<LiveBinding>) {
    const seen: DateFieldState[] = [];
    const handed: FieldEvents[] = [];
    const binding = createBinding(lit, { ...extra, components: { ...createBinding(lit).components, date: recordingDate(seen, handed) } });
    const m = await mounted(dateForm(), { binding, datum: DATUM, features: [createFieldsFeature(datumFieldStateBuilders())] });
    handed.at(-1)?.parts({ year: "2026", month: "", day: "" }, { interim: true });
    // A date typed in part stores nothing yet: the next draw (here asked for) hands the parts typed.
    m.live().redraw();
    await settled(m.form);
    return seen.at(-1)?.missingParts;
  }

  it("follows the binding's order for a date its adapter draws", async () => {
    expect(await missingAfterYear({ dateOrder: (locale) => (locale.startsWith("en") ? ["month", "day", "year"] : ["day", "month", "year"]) })).toEqual(["month", "day"]);
  });

  it("keeps Datum's order for a binding that declares none, and for a date Datum's adapter draws", async () => {
    expect(await missingAfterYear({})).toEqual(["day", "month"]);
    // The binding declares month first but has no date adapter: Datum's draws it, in Datum's order.
    const seen: DateFieldState[] = [];
    const datumDate = DATUM.components.date as FieldAdapter<DateFieldState>;
    const recorded: FieldAdapter<DateFieldState> = { ...datumDate, template: (s, on) => (seen.push(s), datumDate.template(s, on)) };
    const datum: LiveBinding = { ...DATUM, components: { ...DATUM.components, date: recorded } };
    const ds: LiveBinding = { ...createBinding(lit), dateOrder: () => ["month", "day", "year"] };
    const m = await mounted(dateForm(), { binding: ds, datum, features: createDatumFeatures() });
    const year = m.root.querySelector<HTMLInputElement>('[data-value-part="year"]') as HTMLInputElement;
    year.value = "2026";
    year.dispatchEvent(new Event("input", { bubbles: true }));
    m.live().redraw();
    await settled(m.form);
    expect(seen.at(-1)?.missingParts).toEqual(["day", "month"]);
  });

  it("gives the Datum binding's fieldOrder.date to the date's state with no feature options", async () => {
    const datum = createDatumBinding({ fieldOrder: { date: ["year", "month", "day"] } });
    expect(datum.dateOrder?.("en")).toEqual(["year", "month", "day"]);
    const m = await mounted(dateForm(), { binding: datum, datum, features: createDatumFeatures() });
    const order = Array.from(m.root.querySelectorAll<HTMLElement>("[data-value-part]")).map((box) => box.dataset.valuePart);
    expect(order).toEqual(["year", "month", "day"]);
    const day = m.root.querySelector<HTMLInputElement>('[data-value-part="day"]') as HTMLInputElement;
    day.value = "14";
    day.dispatchEvent(new Event("input", { bubbles: true }));
    await settled(m.form);
    // Focus goes to the first part lacking, as drawn: the year.
    expect(m.form.focusField("born")).toBe(true);
    expect((m.root.activeElement as HTMLElement | null)?.dataset.valuePart).toBe("year");
  });

  it("finds the first empty box in the order the boxes stand (Datum's date focus, reusable by any binding)", () => {
    const field = document.createElement("div");
    field.innerHTML = `<input data-value-part="month" value="05"><input data-value-part="day"><input data-value-part="year">`;
    expect(datePartsFocusTarget(field)?.dataset.valuePart).toBe("day");
    (field.querySelector('[data-value-part="day"]') as HTMLInputElement).value = "14";
    (field.querySelector('[data-value-part="year"]') as HTMLInputElement).value = "2026";
    expect(datePartsFocusTarget(field)?.dataset.valuePart).toBe("month");
  });
});

// ── A grid adapter that draws no table ─────────────────────────────────────────────────────

describe("data grid: an adapter's layouts", () => {
  const gridForm = (layout: string) =>
    definitionOf([
      {
        id: "items",
        type: "dataGrid",
        configuration: { label: "Items", initialRows: 1, layout },
        collection: { collectionPath: "items" },
        children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
      }
    ]);

  function stackedGrid(seen: GridState[], layouts?: GridAdapter["layouts"]): GridAdapter {
    return {
      kind: "grid",
      name: "ds-grid",
      ...(layouts !== undefined ? { layouts } : {}),
      capabilities: { rowNumbers: "drawn", hideLabel: "drawn" },
      when: (s) => {
        seen.push(s);
        return true;
      },
      template: (s) => lit.html`<div class="ds-grid" data-layout=${s.layout}>${s.eachRow((row) => lit.html`<fieldset>${row.cells.map((cell) => cell.content)}</fieldset>`)}</div>`
    };
  }

  it("hands an adapter that draws no table the stacked layout, and keeps the cells' labels", async () => {
    const seen: GridState[] = [];
    const binding = createBinding(lit, { components: { ...createBinding(lit).components, dataGrid: stackedGrid(seen, ["stacked"]) } });
    const m = await mounted(gridForm("table"), { binding, features: [createDataGridFeature()] });
    expect(m.root.querySelector(".ds-grid")?.getAttribute("data-layout")).toBe("stacked");
    expect(wrapper(m.root, "sku").querySelector("label")?.hasAttribute("data-hidden")).toBe(false);
    // `when` is asked before the rows are drawn: the cells are still empty.
    expect(seen[0]?.rows[0]?.cells[0]?.content.strings.join("")).toBe("");
    for (const layout of ["auto", "stacked"]) {
      const again = await mounted(gridForm(layout), { binding, features: [createDataGridFeature()] });
      expect(again.root.querySelector(".ds-grid")?.getAttribute("data-layout")).toBe("stacked");
    }
  });

  it("keeps the table, and hides the cells' labels under it, for an adapter that draws one", async () => {
    const seen: GridState[] = [];
    const binding = createBinding(lit, { components: { ...createBinding(lit).components, dataGrid: stackedGrid(seen) } });
    const m = await mounted(gridForm("table"), { binding, features: [createDataGridFeature()] });
    expect(m.root.querySelector(".ds-grid")?.getAttribute("data-layout")).toBe("table");
    expect(wrapper(m.root, "sku").querySelector("label")?.getAttribute("data-hidden")).toBe("true");
    expect(gridLayoutFor({ layouts: ["table", "stacked"] }, "stacked")).toBe("stacked");
    expect(gridLayoutFor({ layouts: ["table"] }, "stacked")).toBe("table");
    expect(gridLayoutFor(undefined, "table")).toBe("table");
  });
});

// ── A binding's own tier-2 types ───────────────────────────────────────────────────────────

describe("a binding's own kinds", () => {
  const dsDate = (name: string): FieldAdapter<DateFieldState> => ({ kind: "field", name, template: (s) => lit.html`<input id=${s.id} />` });

  it("draws its type as the base under the definition's map, and reports a form that leaves the entry out", async () => {
    quiet();
    const binding = createBinding(lit, { kinds: { "ds-date": "date" }, components: { ...createBinding(lit).components, "ds-date": dsDate("ds-date-adapter") } });
    const without = await mounted(definitionOf([{ id: "start", type: "ds-date", configuration: { label: "Start" } }]), { binding, datum: DATUM, features: createDatumFeatures() });
    expect(wrapper(without.root, "start").getAttribute("data-kind")).toBe("date");
    expect(without.form.adapterOf("start")).toMatchObject({ from: "binding", name: "ds-date-adapter" });
    expect(without.form.unsupported()).toEqual(['start: component "ds-date" has no kinds entry']);

    const withEntry = await mounted(definitionOf([{ id: "start", type: "ds-date", configuration: { label: "Start" } }], { kinds: { "ds-date": "date" } }), { binding, datum: DATUM, features: createDatumFeatures() });
    expect(withEntry.form.unsupported()).toEqual([]);
  });

  it("stands under the definition's map, which wins, and reaches the inspector's capabilities", () => {
    const binding = createBinding(lit, { kinds: { "ds-date": "date", "ds-pick": "select" } });
    expect(drawingKindsOf(binding, { "ds-pick": "radio" })).toEqual({ "ds-date": "date", "ds-pick": "radio" });
    expect(drawingKindsOf({}, undefined)).toBeUndefined();
    expect(needsKindsEntry(binding, { "ds-pick": "radio" }, "ds-date")).toBe(true);
    expect(needsKindsEntry(binding, { "ds-date": "date" }, "ds-date")).toBe(false);
    expect(needsKindsEntry(binding, undefined, "text")).toBe(false);
    expect(fieldCapabilitiesOf(binding, DATUM, "ds-date")).toMatchObject({ kind: "date", from: "datum-base" });
  });
});

// ── Containers' capability answers ─────────────────────────────────────────────────────────

describe("container capabilities", () => {
  const group = (capabilities: GroupAdapter["capabilities"]): GroupAdapter => ({ kind: "group", name: "ds-group", ...(capabilities !== undefined ? { capabilities } : {}), template: (s, children) => lit.html`<fieldset><legend>${s.legend}</legend>${children}</fieldset>` });
  const hiddenGroup = () =>
    definitionOf([{ id: "g", type: "fieldset", configuration: { label: "About you", hideLabel: true }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }]);

  it("records a hidden legend under an adapter that answers hideLabel none", async () => {
    quiet();
    const none = await mounted(hiddenGroup(), { binding: createBinding(lit, { components: { ...createBinding(lit).components, fieldset: group({}) } }) });
    expect(none.form.unsupported()).toEqual(["g: hideLabel"]);
    const drawn = await mounted(hiddenGroup(), { binding: createBinding(lit, { components: { ...createBinding(lit).components, fieldset: group({ hideLabel: "drawn" }) } }) });
    expect(drawn.form.unsupported()).toEqual([]);
  });

  it("asks the same of a tabs adapter, and Datum's own containers answer it", async () => {
    quiet();
    const tabsForm = definitionOf([
      {
        id: "t",
        type: "tabs",
        configuration: { label: "Sections", hideLabel: true, tabs: [{ id: "a", label: "A" }] },
        children: { a: [{ id: "name", type: "text", configuration: { label: "Name" } }] }
      }
    ]);
    const tabs: TabsAdapter = { kind: "tabs", name: "ds-tabs", template: (s) => lit.html`${s.tabs.map((tab) => tab.content)}` };
    const ds = await mounted(tabsForm, { binding: createBinding(lit, { components: { ...createBinding(lit).components, tabs } }), features: [createTabsFeature()] });
    expect(ds.form.unsupported()).toEqual(["t: hideLabel"]);
    const datum = await mounted(hiddenGroup(), { binding: DATUM, datum: DATUM, features: createDatumFeatures() });
    expect(datum.form.unsupported()).toEqual([]);
  });
});

// ── Read-only marks ────────────────────────────────────────────────────────────────────────

describe("read-only marks through shadow roots", () => {
  it("marks a select two shadow roots down, and a plain fieldset of radios as a read-only radio group", () => {
    const field = document.createElement("div");
    const outer = document.createElement("ds-date");
    field.append(outer);
    const inner = document.createElement("ds-select");
    outer.attachShadow({ mode: "open" }).append(inner);
    const select = document.createElement("select");
    inner.attachShadow({ mode: "open" }).append(select);
    const radios = document.createElement("ds-radios");
    field.append(radios);
    radios.attachShadow({ mode: "open" }).innerHTML = `<fieldset><legend>Way</legend><input type="radio" name="w" value="a"><input type="radio" name="w" value="b"></fieldset>`;
    const fieldset = radios.shadowRoot?.querySelector("fieldset") as HTMLFieldSetElement;
    // A fieldset of its own that holds no radios is left alone.
    const plain = document.createElement("fieldset");
    plain.innerHTML = `<input type="checkbox">`;
    field.append(plain);

    expect(markReadOnly(field, true)).toBe(true);
    expect(select.getAttribute("aria-readonly")).toBe("true");
    expect(fieldset.getAttribute("role")).toBe("radiogroup");
    expect(fieldset.getAttribute("aria-readonly")).toBe("true");
    expect(plain.hasAttribute("role")).toBe(false);
    expect(plain.querySelector("input")?.getAttribute("aria-readonly")).toBe("true");

    markReadOnly(field, false);
    expect(select.hasAttribute("aria-readonly")).toBe(false);
    expect(fieldset.hasAttribute("role")).toBe(false);
    expect(fieldset.hasAttribute("aria-readonly")).toBe(false);
  });

  it("leaves a radio group's own role alone, and only unmarks what it marked", () => {
    const field = document.createElement("div");
    field.innerHTML = `<fieldset role="radiogroup" aria-readonly="false"><input type="radio" name="w"></fieldset>`;
    const group = field.querySelector("fieldset") as HTMLFieldSetElement;
    markReadOnly(field, true);
    expect(group.getAttribute("aria-readonly")).toBe("false");
    markReadOnly(field, false);
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-readonly")).toBe("false");
  });

  it("marks the controls a component draws only once it is ready", async () => {
    const late: FieldAdapter = {
      kind: "field",
      name: "ds-late-select",
      template: (s) => lit.html`<ds-select id=${s.id}></ds-select>`,
      ready: async (field) => {
        const host = field.querySelector("ds-select") as HTMLElement;
        host.attachShadow({ mode: "open" }).innerHTML = `<select><option>A</option></select>`;
      }
    };
    const m = await mounted(definitionOf([{ id: "pick", type: "select", configuration: { label: "Pick", readOnly: true, options: [{ value: "a", label: "A" }] } }]), {
      binding: createBinding(lit, { components: { ...createBinding(lit).components, select: late } })
    });
    const select = wrapper(m.root, "pick").querySelector("ds-select")?.shadowRoot?.querySelector("select");
    expect(select?.getAttribute("aria-readonly")).toBe("true");
  });
});

// ── The ids a binding's markup writes ──────────────────────────────────────────────────────

describe("idsWrittenBy", () => {
  const forgetful = (idsWrittenBy?: "binding" | "component"): FieldAdapter<TextFieldState> => ({
    kind: "field",
    name: "ds-forgetful",
    ...(idsWrittenBy !== undefined ? { idsWrittenBy } : {}),
    // Draws the control described by the hint, and no hint.
    template: (s) => lit.html`<label for=${s.id}>${s.label}</label><input id=${s.id} aria-describedby=${s.describedBy.join(" ")} />`
  });
  const described = () => definitionOf([{ id: "name", type: "text", configuration: { label: "Name", description: "As on your passport" } }]);

  it("reports an id the state names that nothing in the form carries, once, for a binding-written field", async () => {
    quiet();
    const m = await mounted(described(), { binding: createBinding(lit, { components: { text: forgetful() } }) });
    m.live().redraw();
    expect(m.errors.filter((e) => e.hook === "ids")).toEqual([expect.objectContaining({ hook: "ids", id: "name", message: expect.stringContaining('"name__description"') })]);
  });

  it("asks nothing of a component that writes its own ids", async () => {
    const m = await mounted(described(), { binding: createBinding(lit, { components: { text: forgetful("component") } }) });
    expect(m.errors.filter((e) => e.hook === "ids")).toEqual([]);
  });
});

// ── Sheets a design system leaves ──────────────────────────────────────────────────────────

describe("adopted sheets on unmount", () => {
  it("takes away every sheet adopted into the root while the form was mounted, and keeps the host's", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    let sheets: CSSStyleSheet[] = [];
    Object.defineProperty(root, "adoptedStyleSheets", { configurable: true, get: () => sheets, set: (value: CSSStyleSheet[]) => (sheets = [...value]) });
    const hosts = new CSSStyleSheet();
    root.adoptedStyleSheets = [hosts];
    // A design system that adopts its shared sheet into the nearest shadow root and never takes it away.
    const library = new CSSStyleSheet();
    const binding = createBinding(lit, { connect: (shadow) => void (shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, library]) });
    const { mountLive } = await import("../form-engine/render/live/mount.js");
    const form = mountLive(root, { runtime: runtimeOf(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }])), binding });
    await form.ready;
    expect(root.adoptedStyleSheets).toContain(library);
    expect(root.adoptedStyleSheets.length).toBeGreaterThan(2);
    form.unmount();
    expect(root.adoptedStyleSheets).toEqual([hosts]);
  });
});

// ── Datum's tint on what Datum draws ───────────────────────────────────────────────────────

describe("fallbackTokens reach what Datum draws", () => {
  const fieldsetForm = () => definitionOf([{ id: "g", type: "fieldset", configuration: { label: "About you" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }] } }]);

  it("marks a container and a region Datum draws inside another binding, and nothing under Datum's own", async () => {
    quiet();
    const ds = createBinding(lit, { fallbackTokens: { "--color-text": "#123456" } });
    const region: LiveFeature = { id: "probe-region", region: (where, draw) => (where === "header" ? draw.fallback(lit.html`<p class="probe">Datum's words</p>`) : undefined) };
    const m = await mounted(fieldsetForm(), { binding: ds, datum: DATUM, features: [...createDatumFeatures(), region] });
    expect(m.root.querySelector('[data-container-id="g"]')?.hasAttribute("data-fallback")).toBe(true);
    expect(m.root.querySelector(".probe")?.parentElement?.hasAttribute("data-fallback")).toBe(true);
    await m.runtime.validate();
    await settled(m.form);
    // The summary is Datum's: the binding draws none.
    expect(m.root.querySelector("[data-datum-summary]")?.hasAttribute("data-fallback")).toBe(true);

    const own = await mounted(fieldsetForm(), { binding: DATUM, datum: DATUM, features: [...createDatumFeatures(), region] });
    expect(own.root.querySelector('[data-container-id="g"]')?.hasAttribute("data-fallback")).toBe(false);
    expect(own.root.querySelector(".probe")?.parentElement?.hasAttribute("data-fallback")).toBe(false);
    expect(own.root.querySelector("[data-fallback]")).toBeNull();
  });

  it("leaves a container and a summary the binding draws untinted", async () => {
    const ds = createBinding(lit, {
      components: { ...createBinding(lit).components, fieldset: { kind: "group", name: "ds-group", template: (_s, children) => lit.html`<div>${children}</div>` } },
      summary: (entries) => lit.html`<ul>${entries.map((entry) => lit.html`<li>${entry.authored ? entry.message : entry.text}</li>`)}</ul>`
    });
    const m = await mounted(fieldsetForm(), { binding: ds, datum: DATUM, features: [createSummaryFeature()] });
    expect(m.root.querySelector('[data-container-id="g"]')?.hasAttribute("data-fallback")).toBe(false);
    await m.runtime.validate();
    await settled(m.form);
    const summary = m.root.querySelector("[data-datum-summary]");
    expect(summary?.hasAttribute("data-fallback")).toBe(false);
    // A default message is listed with its field's label.
    expect(summary?.textContent).toContain("Name: This field is required");
  });
});

// ── The tab error word ─────────────────────────────────────────────────────────────────────

describe("tabHasErrors", () => {
  it("words a tab's error count, counted", () => {
    const words = createFormTextResolver("en");
    expect(words.plural("tabHasErrors", 1, { count: 1 })).toBe("1 error");
    expect(words.plural("tabHasErrors", 3, { count: 3 })).toBe("3 errors");
  });
});
