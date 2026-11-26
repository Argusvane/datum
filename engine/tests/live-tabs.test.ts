// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TabsAdapter } from "../form-engine/render/live/contract.js";
import { lit } from "../form-engine/render/live/lit.js";
import { createTabsFeature } from "../form-engine/render/live/tabs.js";
import { createBinding, definitionOf, inputOf, mounted, quiet, settled, type, unmountAll, wrapper } from "./live-chrome-harness.js";

/*
 * The tabs container (render/live/tabs.ts): which tab shows and the keys are the
 * renderer's, whatever binding draws the strip. jsdom has no ResizeObserver: the narrow-view
 * case stubs it (and the form's box) in the test, never in the source.
 */

afterEach(unmountAll);

const tabsForm = (extra: Record<string, unknown> = {}) =>
  definitionOf(
    [
      {
        id: "t",
        type: "tabs",
        configuration: { label: "Sections", tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }, { id: "three" }] },
        children: {
          one: [{ id: "a", type: "text", configuration: { label: "A" } }],
          two: [{ id: "b", type: "text", configuration: { label: "B", required: true } }],
          three: [{ id: "c", type: "text", configuration: { label: "C" } }]
        }
      }
    ],
    extra
  );

const tab = (root: ShadowRoot, slot: string): HTMLElement => root.getElementById(`t__tab-${slot}`) as HTMLElement;
const panel = (root: ShadowRoot, slot: string): HTMLElement => root.getElementById(`t__panel-${slot}`) as HTMLElement;
const shown = (root: ShadowRoot): string[] => ["one", "two", "three"].filter((slot) => !panel(root, slot).hidden);
const press = (element: HTMLElement, key: string): void => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
};

describe("tabs: which tab shows", () => {
  it("draws every panel, shows the first, and keeps each field's nodes and answer while its tab is shut", async () => {
    quiet();
    const m = await mounted(tabsForm(), { features: [createTabsFeature()] });
    expect(["one", "two", "three"].every((slot) => panel(m.root, slot) !== null)).toBe(true);
    expect(shown(m.root)).toEqual(["one"]);
    expect(tab(m.root, "one").getAttribute("aria-selected")).toBe("true");
    expect(tab(m.root, "two").getAttribute("tabindex")).toBe("-1");
    expect(m.root.querySelector('[data-container-id="t"]')?.getAttribute("data-kind")).toBe("tabs");
    // An untitled tab is named by its place.
    expect(tab(m.root, "three").textContent?.trim()).toBe("Tab 3");
    expect(m.form.adapterOf("t")).toMatchObject({ from: "renderer", via: "tabs", name: "datum-tabs" });

    const field = inputOf(m.root, "a");
    type(field, "typed");
    await settled(m.form);
    tab(m.root, "two").click();
    expect(shown(m.root)).toEqual(["two"]);
    tab(m.root, "one").click();
    expect(shown(m.root)).toEqual(["one"]);
    expect(inputOf(m.root, "a")).toBe(field);
    expect(field.value).toBe("typed");
    // A draw for another reason keeps the chosen tab.
    tab(m.root, "three").click();
    type(inputOf(m.root, "c"), "x");
    await settled(m.form);
    expect(shown(m.root)).toEqual(["three"]);
  });

  it("marks the tab that holds blocking errors, counted per tab", async () => {
    quiet();
    const m = await mounted(tabsForm(), { features: [createTabsFeature()] });
    await m.runtime.validate();
    await settled(m.form);
    expect(tab(m.root, "two").getAttribute("data-has-errors")).toBe("true");
    expect(tab(m.root, "one").hasAttribute("data-has-errors")).toBe(false);
  });

  it("opens the tab a field sits in when focus is asked for it, and on a reveal for an error", async () => {
    quiet();
    const m = await mounted(tabsForm(), { features: [createTabsFeature()] });
    expect(m.form.focusField("b")).toBe(true);
    expect(shown(m.root)).toEqual(["two"]);
    expect(m.root.activeElement).toBe(inputOf(m.root, "b"));
    expect(m.live().fields().find((f) => f.key === "c")?.state.reveal).toEqual([{ kind: "tab", tabsId: "t", slotId: "three" }]);
    m.form.focusField("c");
    expect(shown(m.root)).toEqual(["three"]);
    // Already open: nothing redrawn for it.
    const draws = m.form.draws();
    m.form.focusField("c");
    expect(m.form.draws()).toBe(draws);
  });

  it("reveals a field's tab without taking focus: focus stays where the person or the host left it", async () => {
    quiet();
    const m = await mounted(tabsForm(), { features: [createTabsFeature()] });
    // `reveal` is what the builder canvas asks on every selection and an agent asks while a person
    // types: opening what hides a component is not a request to fill it in.
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(m.form.reveal("b")).toBe(true);
    expect(shown(m.root)).toEqual(["two"]);
    expect(m.root.activeElement).toBeNull();
    expect(document.activeElement).toBe(outside);
    // Inside the form, too: a field with focus keeps it while another tab opens.
    const a = inputOf(m.root, "a");
    tab(m.root, "one").click();
    a.focus();
    expect(m.form.reveal("c")).toBe(true);
    expect(shown(m.root)).toEqual(["three"]);
    expect(m.root.activeElement).not.toBe(inputOf(m.root, "c"));
    // A component the form does not hold: nothing to open.
    expect(m.form.reveal("nope")).toBe(false);
    outside.remove();
  });
});

describe("tabs: the keys", () => {
  it("moves between tabs on the arrow keys (wrapping), Home and End, focusing the tab it opens", async () => {
    quiet();
    const m = await mounted(tabsForm(), { features: [createTabsFeature()] });
    tab(m.root, "one").focus();
    press(tab(m.root, "one"), "ArrowRight");
    expect(shown(m.root)).toEqual(["two"]);
    expect(m.root.activeElement).toBe(tab(m.root, "two"));
    press(tab(m.root, "two"), "End");
    expect(shown(m.root)).toEqual(["three"]);
    press(tab(m.root, "three"), "ArrowRight");
    expect(shown(m.root)).toEqual(["one"]);
    press(tab(m.root, "one"), "ArrowLeft");
    expect(shown(m.root)).toEqual(["three"]);
    expect(m.root.activeElement).toBe(tab(m.root, "three"));
    press(tab(m.root, "three"), "Home");
    expect(shown(m.root)).toEqual(["one"]);
    // A key elsewhere in a panel is no tab key.
    press(inputOf(m.root, "a"), "ArrowRight");
    expect(shown(m.root)).toEqual(["one"]);
  });

  it("reverses the arrows in a right-to-left form", async () => {
    quiet();
    const m = await mounted(tabsForm({ localization: { defaultLocale: "ar", supportedLocales: [{ code: "ar", label: "العربية" }] } }), { features: [createTabsFeature()] });
    expect(m.root.querySelector("form")?.getAttribute("dir")).toBe("rtl");
    press(tab(m.root, "one"), "ArrowLeft");
    expect(shown(m.root)).toEqual(["two"]);
    press(tab(m.root, "two"), "ArrowRight");
    expect(shown(m.root)).toEqual(["one"]);
  });

  it("leaves the keys to a component that runs its own", async () => {
    quiet();
    const own: TabsAdapter = {
      kind: "tabs",
      name: "own-keys",
      behaviour: { keyboard: "component" },
      template: (s) => lit.html`<div role="tablist">${s.tabs.map((t) => lit.html`<button role="tab" id=${t.tabId} @click=${t.select}>${t.label}</button>`)}</div>${s.tabs.map((t) => lit.html`<div role="tabpanel" id=${t.panelId} ?hidden=${!t.selected}>${t.content}</div>`)}`
    };
    const m = await mounted(tabsForm(), { binding: createBinding(lit, { components: { ...createBinding(lit).components, tabs: own } }), features: [createTabsFeature()] });
    press(tab(m.root, "one"), "ArrowRight");
    expect(shown(m.root)).toEqual(["one"]);
    tab(m.root, "two").click();
    expect(shown(m.root)).toEqual(["two"]);
  });
});

describe("tabs: the binding's adapter", () => {
  it("draws with the binding's adapter, recorded as the binding's, and hands it the ids it must carry", async () => {
    quiet();
    let seen: { narrow: boolean; flat: boolean; ids: string[]; labels: string[] } | undefined;
    const adapter: TabsAdapter = {
      kind: "tabs",
      name: "ds-tabs",
      template: (s) => {
        seen = { narrow: s.narrow, flat: s.flat, ids: s.tabs.map((t) => `${t.tabId}|${t.panelId}`), labels: s.tabs.map((t) => t.label) };
        return lit.html`<ul class="ds-tabs">${s.tabs.map((t) => lit.html`<li><a id=${t.tabId} @click=${t.select}>${t.label}</a></li>`)}</ul>${s.tabs.map((t) => lit.html`<div id=${t.panelId} ?hidden=${!t.selected}>${t.content}</div>`)}`;
      }
    };
    const m = await mounted(tabsForm(), { binding: createBinding(lit, { components: { ...createBinding(lit).components, tabs: adapter } }), features: [createTabsFeature()] });
    expect(m.root.querySelector(".ds-tabs")).not.toBeNull();
    expect(seen).toEqual({ narrow: false, flat: false, ids: ["t__tab-one|t__panel-one", "t__tab-two|t__panel-two", "t__tab-three|t__panel-three"], labels: ["One", "Two", "Tab 3"] });
    expect(m.form.adapterOf("t")).toMatchObject({ from: "binding", via: "tabs", name: "ds-tabs" });
    expect(m.form.unsupported()).toEqual([]);
  });

  it("falls back to Datum's tabs when the binding's template throws, and says so for a binding with none", async () => {
    quiet();
    const broken: TabsAdapter = {
      kind: "tabs",
      name: "broken",
      template: () => {
        throw new Error("no tabs today");
      }
    };
    const m = await mounted(tabsForm(), { binding: createBinding(lit, { components: { ...createBinding(lit).components, tabs: broken } }), features: [createTabsFeature()] });
    expect(m.errors.map((e) => [e.hook, e.id])).toEqual([["template", "t"]]);
    expect(tab(m.root, "one")).not.toBeNull();
    expect(m.form.adapterOf("t")?.from).toBe("renderer");

    const bare = await mounted(tabsForm(), { features: [createTabsFeature()] });
    expect(bare.form.unsupported()).toEqual(['t: component "tabs"']);
  });
});

describe("tabs: the narrow view and the flat one", () => {
  it("takes the narrow view under the binding's breakpoint, as the form's width crosses it", async () => {
    quiet();
    let width = 500;
    let notify: (() => void) | undefined;
    class FakeObserver {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    vi.spyOn(HTMLFormElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width, height: 100, top: 0, left: 0, right: width, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }));
    const seen: boolean[] = [];
    const adapter: TabsAdapter = {
      kind: "tabs",
      template: (s) => {
        seen.push(s.narrow);
        return lit.html`<nav class=${s.narrow ? "list" : "strip"}>${s.tabs.map((t) => lit.html`<a id=${t.tabId} @click=${t.select}>${t.label}</a>`)}</nav>${s.tabs.map((t) => lit.html`<div id=${t.panelId} ?hidden=${!t.selected && !s.narrow}>${t.content}</div>`)}`;
      }
    };
    const m = await mounted(tabsForm(), { binding: createBinding(lit, { tabsNarrowBelow: 641, components: { ...createBinding(lit).components, tabs: adapter } }), features: [createTabsFeature()] });
    await settled(m.form);
    expect(m.root.querySelector("nav")?.className).toBe("list");
    // The arrow keys have no strip to run in the narrow view.
    press(m.root.getElementById("t__tab-one") as HTMLElement, "ArrowRight");
    expect(m.root.querySelector("nav")?.className).toBe("list");

    width = 900;
    notify?.();
    await settled(m.form);
    expect(m.root.querySelector("nav")?.className).toBe("strip");
    expect(seen).toContain(true);
    expect(seen[seen.length - 1]).toBe(false);

    // A binding that names no breakpoint keeps its strip at every width.
    const plain = await mounted(tabsForm(), { features: [createTabsFeature()] });
    expect(plain.root.querySelector('[role="tablist"]')).not.toBeNull();
  });

  it("draws every tab headed, in order, in a review and in a print", async () => {
    quiet();
    const review = await mounted(tabsForm(), { mode: "readonly", features: [createTabsFeature()] });
    expect(review.root.querySelector('[role="tablist"]')).toBeNull();
    expect(Array.from(review.root.querySelectorAll(".datum-form__panel-title")).map((h) => h.textContent)).toEqual(["One", "Two", "Tab 3"]);
    expect(wrapper(review.root, "b")).not.toBeNull();

    const live = await mounted(tabsForm(), { features: [createTabsFeature()] });
    expect(live.root.querySelector('[role="tablist"]')).not.toBeNull();
    live.live().setPrinting(true);
    await settled(live.form);
    expect(live.root.querySelector('[role="tablist"]')).toBeNull();
    expect(live.root.querySelectorAll(".datum-form__tabs-section")).toHaveLength(3);
    live.live().setPrinting(false);
    await settled(live.form);
    expect(live.root.querySelector('[role="tablist"]')).not.toBeNull();
    expect(shownTabs(live.root)).toEqual(["one"]);
  });
});

function shownTabs(root: ShadowRoot): string[] {
  return ["one", "two", "three"].filter((slot) => !(root.getElementById(`t__panel-${slot}`) as HTMLElement).hidden);
}
