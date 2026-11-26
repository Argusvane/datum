// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import { createAnnouncerFeature } from "../form-engine/render/live/announcer.js";
import type { CharacterCount, FieldAdapter, TextFieldState } from "../form-engine/render/live/contract.js";
import { createDataGridFeature } from "../form-engine/render/live/data-grid.js";
import { createJourneyPageFeature } from "../form-engine/render/live/journey-page.js";
import { lit } from "../form-engine/render/live/lit.js";
import { createMediaLabelsFeature } from "../form-engine/render/live/media-labels.js";
import { createReadonlySizingFeature } from "../form-engine/render/live/readonly-sizing.js";
import type { LiveFeature } from "../form-engine/render/live/mount.js";
import { createSummaryFeature } from "../form-engine/render/live/summary.js";
import { createTabsFeature } from "../form-engine/render/live/tabs.js";
import { createBinding, definitionOf, inputOf, mounted, quiet, runtimeOf, settled, type, unmountAll, wrapper } from "./live-chrome-harness.js";

/*
 * Review fixes for the renderer's modules: the submission lock, the first error's row,
 * Enter on a journey page, the narrow tabs' contents links, the summary's placement, the count
 * announcer's repeated words, and the behaviours the renderer element owns (the redirect line, Enter in
 * a form with one box, media labels, a read-only textarea's size).
 */

afterEach(unmountAll);

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── The submission lock ─────────────────────────────────────────────────────────

describe("the submission lock", () => {
  const form = () => definitionOf([{ id: "a", type: "text", configuration: { label: "A" } }, { id: "b", type: "text", configuration: { label: "B" } }] as never);

  it("makes the body inert while a submission is in flight and refuses a keystroke", async () => {
    quiet();
    const m = await mounted(form(), { features: [] });
    m.live().setBusy("submitting", true);
    await settled(m.form);
    expect(wrapper(m.root, "a").hasAttribute("inert")).toBe(true);
    expect(wrapper(m.root, "b").hasAttribute("inert")).toBe(true);
    // A browser without `inert` still types: the write is refused and the stored answer drawn back.
    const box = inputOf(m.root, "a");
    type(box, "late");
    await settled(m.form);
    expect((m.runtime.state().values as Record<string, unknown>)["a"]).toBeUndefined();
    expect(inputOf(m.root, "a").value).toBe("");
    m.live().setBusy("submitting", false);
    await settled(m.form);
    expect(wrapper(m.root, "a").hasAttribute("inert")).toBe(false);
    type(inputOf(m.root, "a"), "now");
    await settled(m.form);
    expect((m.runtime.state().values as Record<string, unknown>)["a"]).toBe("now");
  });

  it("does not report a commit while locked, and takes the answer typed before the lock as it was", async () => {
    quiet();
    const m = await mounted(form(), { features: [] });
    const commit = vi.spyOn(m.runtime, "commitValue");
    type(inputOf(m.root, "a"), "typed");
    await settled(m.form);
    m.live().setBusy("submitting", true);
    await settled(m.form);
    inputOf(m.root, "a").dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    expect(commit).not.toHaveBeenCalled();
    expect((m.runtime.state().values as Record<string, unknown>)["a"]).toBe("typed");
  });

  it("gives focus back to the control that had it when the lock lifts, unless something took it", async () => {
    quiet();
    const m = await mounted(form(), { features: [] });
    const box = inputOf(m.root, "a");
    box.focus();
    expect(m.root.activeElement).toBe(box);
    m.live().setBusy("submitting", true);
    await settled(m.form);
    // The browser blurs a control that goes inert; jsdom does not.
    (m.root.activeElement as HTMLElement | null)?.blur();
    expect(m.root.activeElement).toBeNull();
    m.live().setBusy("submitting", false);
    await settled(m.form);
    expect(m.root.activeElement).toBe(inputOf(m.root, "a"));

    // Something else took focus meanwhile: it stays there.
    inputOf(m.root, "a").focus();
    m.live().setBusy("submitting", true);
    await settled(m.form);
    (m.root.activeElement as HTMLElement | null)?.blur();
    const other = inputOf(m.root, "b");
    other.focus();
    m.live().setBusy("submitting", false);
    await settled(m.form);
    expect(m.root.activeElement).toBe(other);
  });
});

// ── The first error's row ──────────────────────────────────────────────────────────────────

describe("the first error in a data grid", () => {
  const gridForm = (configuration: Record<string, unknown> = {}) =>
    definitionOf([
      {
        id: "items",
        type: "dataGrid",
        configuration: { label: "Items", initialRows: 0, layout: "table", ...configuration },
        collection: { collectionPath: "items" },
        children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU", required: true } }] }
      }
    ] as never);
  const skuInputs = (root: ShadowRoot): HTMLInputElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('.datum-live-field[data-kind="text"]')).map((w) => w.querySelector("input") as HTMLInputElement);

  it("focuses the row that holds the error, not the first row (errorFocus field)", async () => {
    quiet();
    const definition = gridForm();
    const runtime = runtimeOf(definition);
    runtime.addRows("items", [{ sku: "A" }, { sku: "" }, { sku: "C" }]);
    const m = await mounted(definition, { runtime, binding: createBinding(lit, { errorFocus: "field" }), features: [createSummaryFeature(), createDataGridFeature()] });
    await runtime.validate();
    await settled(m.form);
    expect(m.live().output()?.meta.firstErrorFocus).toMatchObject({ targetPath: "items[1].sku", targetComponentId: "sku" });
    expect(m.live().focusErrors()).toBe(true);
    expect(m.root.activeElement).toBe(skuInputs(m.root)[1]);
  });

  it("focuses the row without a summary too", async () => {
    quiet();
    const definition = gridForm();
    const runtime = runtimeOf(definition);
    runtime.addRows("items", [{ sku: "A" }, { sku: "B" }, { sku: "" }]);
    const m = await mounted(definition, { runtime, features: [createDataGridFeature()] });
    await runtime.validate();
    await settled(m.form);
    expect(m.live().focusErrors()).toBe(true);
    expect(m.root.activeElement).toBe(skuInputs(m.root)[2]);
  });

  it("takes a grid's own error to its Add button, else its first row control", async () => {
    quiet();
    const definition = gridForm({ minRows: 1 });
    const runtime = runtimeOf(definition);
    runtime.setValues({ items: [] });
    const m = await mounted(definition, { runtime, features: [createDataGridFeature()] });
    await runtime.validate();
    await settled(m.form);
    expect(m.live().output()?.meta.firstErrorFocus).toMatchObject({ componentId: "items", targetComponentId: "items" });
    expect(m.live().focusErrors()).toBe(true);
    expect(m.root.activeElement?.id).toBe("items__add");

    // Too many rows: the Add button cannot be pressed, and the first row control takes it.
    const full = gridForm({ maxRows: 1 });
    const fullRuntime = runtimeOf(full);
    fullRuntime.setValues({ items: [{ sku: "A" }, { sku: "B" }] });
    const f = await mounted(full, { runtime: fullRuntime, features: [createDataGridFeature()] });
    await fullRuntime.validate();
    await settled(f.form);
    expect(f.live().output()?.meta.firstErrorFocus?.targetComponentId).toBe("items");
    expect(f.live().focusErrors()).toBe(true);
    expect(f.root.activeElement).toBe(skuInputs(f.root)[0]);
  });

  it("a summary link for a grid's own error goes the same way", async () => {
    quiet();
    const definition = gridForm({ minRows: 1 });
    const runtime = runtimeOf(definition);
    runtime.setValues({ items: [] });
    const m = await mounted(definition, { runtime, features: [createSummaryFeature(), createDataGridFeature()] });
    await runtime.validate();
    await settled(m.form);
    const link = m.root.querySelector<HTMLAnchorElement>(".datum-live-summary a");
    expect(link).not.toBeNull();
    link?.click();
    expect(m.root.activeElement?.id).toBe("items__add");
  });
});

// ── Enter on a journey page ────────────────────────────────────────────────────────────────

describe("Enter on a journey page", () => {
  it("settles the typed answer before the page moves", async () => {
    quiet();
    const journey = {
      id: "apply",
      progress: "count",
      pages: [
        { id: "one", title: "One", components: ["a"] },
        { id: "two", title: "Two", components: ["b"] }
      ]
    } as Journey;
    const definition = definitionOf(
      [
        { id: "a", type: "text", configuration: { label: "A" } },
        { id: "b", type: "text", configuration: { label: "B" } }
      ] as never,
      { journey: { journeys: [journey] } } as never
    );
    const runtime = runtimeOf(definition);
    runtime.startJourney("apply", {});
    const order: string[] = [];
    const commit = runtime.commitValue.bind(runtime);
    vi.spyOn(runtime, "commitValue").mockImplementation((path: string) => {
      order.push(`commit:${path}`);
      return commit(path);
    });
    const action = runtime.journeyAction.bind(runtime);
    vi.spyOn(runtime, "journeyAction").mockImplementation((page) => {
      order.push("journeyAction");
      return action(page);
    });
    const m = await mounted(definition, { runtime, features: [createSummaryFeature(), createJourneyPageFeature()] });
    const box = inputOf(m.root, "a");
    box.focus();
    type(box, "Ada");
    await settled(m.form);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true }));
    await settled(m.form);
    expect(order).toEqual(["commit:a", "journeyAction"]);
    expect(m.live().tree()?.page?.id).toBe("two");
  });
});

// ── The narrow tabs view ───────────────────────────────────────────────────────────────────

describe("the narrow tabs view", () => {
  const tabsForm = () =>
    definitionOf([
      {
        id: "t",
        type: "tabs",
        configuration: { label: "Sections", tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] },
        children: { one: [{ id: "a", type: "text", configuration: { label: "A" } }], two: [{ id: "b", type: "text", configuration: { label: "B" } }] }
      }
    ] as never);
  const stubWidth = (): void => {
    class FakeObserver {
      constructor(_callback: () => void) {}
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    vi.spyOn(HTMLFormElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: 400, height: 100, top: 0, left: 0, right: 400, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }));
  };

  it("takes a contents link to its panel: the heading has focus and the panel scrolls into view", async () => {
    quiet();
    stubWidth();
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const m = await mounted(tabsForm(), { binding: createBinding(lit, { tabsNarrowBelow: 641 }), features: [createTabsFeature()] });
    await settled(m.form);
    expect(m.root.querySelector("[data-tabs-view]")?.getAttribute("data-tabs-view")).toBe("contents");
    (m.root.getElementById("t__tab-two") as HTMLElement).click();
    const panel = m.root.getElementById("t__panel-two") as HTMLElement;
    expect(panel.contains(m.root.activeElement)).toBe(true);
    expect(scrolled).toContain(m.root.activeElement);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("keeps the strip on the builder canvas at any width", async () => {
    quiet();
    stubWidth();
    const m = await mounted(tabsForm(), { binding: createBinding(lit, { tabsNarrowBelow: 641 }), canvasHooks: {}, features: [createTabsFeature()] });
    await settled(m.form);
    expect(m.root.querySelector('[role="tablist"]')).not.toBeNull();
    expect(m.root.querySelector("[data-tabs-view]")).toBeNull();
  });
});

// ── The summary's placement ────────────────────────────────────────────────────────────────

describe("the summary's placement", () => {
  const required = () => definitionOf([{ id: "a", type: "text", configuration: { label: "A", required: true } }] as never);
  const drawn = (root: ShadowRoot): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(".datum-live-summary"));

  async function failed(placement: Array<"top" | "bottom"> | undefined, author?: "top" | "bottom") {
    const runtime = runtimeOf(required());
    const m = await mounted(required(), {
      runtime,
      features: [createSummaryFeature({ placement: () => placement })],
      ...(author ? { errorPresentation: { showComponentErrors: true, showErrorSummary: true, errorSummaryPosition: author } } : {})
    });
    await runtime.validate();
    await settled(m.form);
    return m;
  }

  it("defaults to the top", async () => {
    quiet();
    const m = await failed(undefined);
    expect(drawn(m.root)).toHaveLength(1);
    expect(m.root.querySelector("form")?.firstElementChild?.classList.contains("datum-live-summary")).toBe(true);
  });

  it("draws the bottom alone when the host asks for it", async () => {
    quiet();
    const m = await failed(["bottom"]);
    expect(drawn(m.root)).toHaveLength(1);
    expect(m.root.querySelector("form")?.lastElementChild?.classList.contains("datum-live-summary")).toBe(true);
    expect(drawn(m.root)[0]?.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("draws both ends with a non-alert echo at the bottom, and focus goes to the top copy", async () => {
    quiet();
    const m = await failed(["top", "bottom"]);
    const [top, bottom] = drawn(m.root);
    expect(drawn(m.root)).toHaveLength(2);
    expect(top?.querySelector('[role="alert"]')).not.toBeNull();
    expect(bottom?.querySelector('[role="alert"]')).toBeNull();
    expect(bottom?.hasAttribute("data-datum-summary")).toBe(false);
    const ids = Array.from(m.root.querySelectorAll("[id]")).map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(m.live().focusErrors()).toBe(true);
    expect(top?.contains(m.root.activeElement)).toBe(true);
  });

  it("draws none for an empty placement, and the first field takes focus", async () => {
    quiet();
    const m = await failed([]);
    expect(drawn(m.root)).toHaveLength(0);
    expect(m.live().focusErrors()).toBe(true);
    expect(m.root.activeElement).toBe(inputOf(m.root, "a"));
  });

  it("without a host setting, the form's own summary position stands", async () => {
    quiet();
    const m = await failed(undefined, "bottom");
    expect(m.root.querySelector("form")?.lastElementChild?.classList.contains("datum-live-summary")).toBe(true);
  });

  it("the host's setting wins over the form's own position", async () => {
    quiet();
    const m = await failed(["top"], "bottom");
    expect(m.root.querySelector("form")?.firstElementChild?.classList.contains("datum-live-summary")).toBe(true);
  });
});

// ── The count announcer ────────────────────────────────────────────────────────────────────

describe("the count announcer", () => {
  const DELAY = 40;
  const counts: LiveFeature = {
    id: "kit-counts",
    fieldState: (state) => {
      const max = 10;
      const count = [...(state as TextFieldState).value].length;
      const characterCount: CharacterCount = { max, count, left: max - count, over: count > max, limit: `Up to ${max}`, limitId: `${state.id}__count`, status: `${max - count} left` };
      return { ...state, characterCount } as TextFieldState;
    }
  };
  const countingBinding = () => {
    const base = createBinding(lit);
    const text = base.components?.text as FieldAdapter<TextFieldState>;
    return { ...base, components: { ...base.components, text: { ...text, capabilities: { ...text.capabilities, characterCount: "drawn" as const } } } };
  };

  it("announces a second field that reaches the words the first one did", async () => {
    quiet();
    const definition = definitionOf([
      { id: "bio", type: "text", configuration: { label: "Bio", maxLength: 10, characterCount: true } },
      { id: "other", type: "text", configuration: { label: "Other", maxLength: 10, characterCount: true } }
    ] as never);
    const m = await mounted(definition, { binding: countingBinding(), features: [counts, createAnnouncerFeature({ delayMs: DELAY })] });
    const region = () => m.root.querySelector<HTMLElement>("[data-count-announcer]") as HTMLElement;
    const writes: string[] = [];
    new MutationObserver(() => writes.push(region().textContent ?? "")).observe(region(), { childList: true, characterData: true, subtree: true });
    const first = inputOf(m.root, "bio");
    first.focus();
    type(first, "abc");
    await settled(m.form);
    await pause(DELAY * 3);
    const second = inputOf(m.root, "other");
    second.focus();
    type(second, "xyz");
    await settled(m.form);
    await pause(DELAY * 3);
    await pause(10);
    // Each pause writes the words into an emptied region: both are changes a screen reader reads.
    expect(writes.filter((text) => text === "7 left")).toHaveLength(2);
    expect(region().textContent).toBe("7 left");
  });
});

// ── What the renderer element owns ─────────────────────────────────────────────────────────────

describe("the redirect line of a journey page", () => {
  it("says the person was put on this page until the next page change", async () => {
    quiet();
    const journey = {
      id: "apply",
      progress: "count",
      pages: [
        { id: "one", title: "One", components: ["a"] },
        { id: "two", title: "Two", components: ["b"] }
      ]
    } as Journey;
    const definition = definitionOf(
      [
        { id: "a", type: "text", configuration: { label: "A" } },
        { id: "b", type: "text", configuration: { label: "B" } }
      ] as never,
      { journey: { journeys: [journey] } } as never
    );
    const runtime = runtimeOf(definition);
    runtime.startJourney("apply", {});
    const page = createJourneyPageFeature();
    const m = await mounted(definition, { runtime, features: [createSummaryFeature(), page] });
    expect(m.root.querySelector(".datum-form__journey-redirect")).toBeNull();
    page.setPageRedirected(true);
    await settled(m.form);
    const line = m.root.querySelector(".datum-form__journey-redirect");
    expect(line?.getAttribute("role")).toBe("status");
    expect(line?.textContent?.trim()).not.toBe("");
    await runtime.journeyAction({ journeyId: "apply", pageId: "one", kind: "questions", final: false, hasOwnSubmit: false, pending: undefined } as never);
    await settled(m.form);
    expect(m.live().tree()?.page?.id).toBe("two");
    expect(m.root.querySelector(".datum-form__journey-redirect")).toBeNull();
    // Gone for good: a redraw does not bring it back.
    m.form.redraw();
    await settled(m.form);
    expect(m.root.querySelector(".datum-form__journey-redirect")).toBeNull();
  });
});

describe("Enter in a form with one text box", () => {
  it("checks the form and takes the person to the first error", async () => {
    quiet();
    const definition = definitionOf([{ id: "a", type: "text", configuration: { label: "A", required: true } }] as never);
    const runtime = runtimeOf(definition);
    const validate = vi.spyOn(runtime, "validate");
    const m = await mounted(definition, { runtime, features: [createSummaryFeature()] });
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    m.root.querySelector("form")?.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    await settled(m.form);
    await pause(5);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(m.root.querySelector(".datum-live-summary")).not.toBeNull();
    expect(m.root.querySelector(".datum-live-summary")?.contains(m.root.activeElement)).toBe(true);
  });

  it("does nothing while a submission is in flight", async () => {
    quiet();
    const definition = definitionOf([{ id: "a", type: "text", configuration: { label: "A", required: true } }] as never);
    const runtime = runtimeOf(definition);
    const validate = vi.spyOn(runtime, "validate");
    const m = await mounted(definition, { runtime, features: [] });
    m.live().setBusy("submitting", true);
    m.root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settled(m.form);
    expect(validate).not.toHaveBeenCalled();
    // Keeps the event type in view for the traceability of SUBMISSION_FAILED users.
    expect(FormEventType.SUBMISSION_FAILED).toBeDefined();
  });
});

describe("labels that follow a media query", () => {
  it("sets the name the query picks, and sets it again when the query changes", async () => {
    quiet();
    const listeners: Array<() => void> = [];
    let fine = true;
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      get matches() {
        return fine;
      },
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.splice(listeners.indexOf(listener), 1)
    }));
    const base = createBinding(lit);
    const labelled: FieldAdapter<TextFieldState> = {
      kind: "field",
      name: "ds-labelled",
      template: (s) =>
        lit.html`<input id=${s.id} data-label-media="(hover: hover)" data-label-matches="Drag a file" data-label-otherwise="Choose a file" />`
    };
    const definition = definitionOf([{ id: "a", type: "text", configuration: { label: "A" } }] as never);
    const m = await mounted(definition, { binding: { ...base, components: { ...base.components, text: labelled as never } }, features: [createMediaLabelsFeature()] });
    await settled(m.form);
    expect(inputOf(m.root, "a").getAttribute("aria-label")).toBe("Drag a file");
    fine = false;
    for (const listener of [...listeners]) {
      listener();
    }
    expect(inputOf(m.root, "a").getAttribute("aria-label")).toBe("Choose a file");
    m.form.unmount();
    expect(listeners).toHaveLength(0);
  });
});

describe("a read-only textarea", () => {
  const textareaBinding = () => {
    const base = createBinding(lit);
    const textarea: FieldAdapter<TextFieldState> = {
      kind: "field",
      name: "ds-textarea",
      template: (s) => lit.html`<textarea id=${s.id} .value=${lit.live(s.value)} ?readonly=${s.readOnly}></textarea>`
    };
    return { ...base, components: { ...base.components, textarea: textarea as never } };
  };
  const definition = () => definitionOf([{ id: "t", type: "textarea", configuration: { label: "Notes" } }] as never);

  it("grows to its content in a review, and is given its height back when it is editable", async () => {
    quiet();
    const proto = HTMLTextAreaElement.prototype;
    vi.spyOn(proto, "scrollHeight", "get").mockReturnValue(120);
    const review = await mounted(definition(), { mode: "readonly", binding: textareaBinding(), features: [createReadonlySizingFeature()] });
    await settled(review.form);
    const box = wrapper(review.root, "t").querySelector("textarea") as HTMLTextAreaElement;
    expect(box.style.height).toBe("120px");
    review.form.unmount();

    const editable = await mounted(definition(), { binding: textareaBinding(), features: [createReadonlySizingFeature()] });
    await settled(editable.form);
    const open = wrapper(editable.root, "t").querySelector("textarea") as HTMLTextAreaElement;
    expect(open.style.height).toBe("");
  });
});
