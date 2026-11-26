// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineDatumBuilderElement, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import type { FormTestConfiguration } from "../form-engine/core/form-tests/form-test-types.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { renameInTests } from "../form-engine/builder/form-tests/tests-rename.js";
import type { BuilderMode } from "../form-engine/builder/web-component/builder-modes.js";
import { PANEL_DRAWER_WIDTHS, clearPanelMemory, panelMemoryKey, panelMemoryStore, readPanelMemory, writePanelMemory } from "../form-engine/builder/web-component/panel-memory.js";

/*
 * The Tests panel's place in the shell: a strip item behind the `tests`
 * feature, a lazy panel on the form's controller, the failing count on the item, Open rule going
 * to Logic, and a rename followed in the scenarios. The chunk's own behaviour is tested with the
 * panel; here the loader is the real one except where a case stands in for the rename seam.
 */

let renameStub: ((tests: FormTestConfiguration | undefined, from: string, to: string, signatures: unknown, options?: { kind?: string }) => FormTestConfiguration | undefined) | undefined;
/** The chunk's pins seam: stands in for the coverage module so the shell's feed is tested on its own. */
let pinsStub: { parseTestsEntries: (tests: FormTestConfiguration) => unknown[]; testsPinsOf: (...args: unknown[]) => ReadonlyMap<string, Array<{ id: string; name: string }>> } | undefined;
/** Makes the page look as if the chunk was never fetched, whatever an earlier case in this file loaded. */
let chunkNotLoaded = false;
/** Holds the chunk's load back while set, for a case where something happens before it lands. */
let loadGate: Promise<void> | undefined;
let loads = 0;

/** The chunk as the shell sees it: the real one with the stubs a case set laid over it. */
function stubbed<T extends object>(real: T): T {
  return { ...real, ...(renameStub ? { renameInTests: renameStub } : {}), ...(pinsStub ?? {}) };
}

vi.mock("../form-engine/builder/web-component/tests-panel-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../form-engine/builder/web-component/tests-panel-loader.js")>();
  return {
    ...actual,
    loadTestsPanel: async () => {
      loads += 1;
      if (loadGate) {
        await loadGate;
      }
      return stubbed(await actual.loadTestsPanel());
    },
    // The shell reads the loaded chunk synchronously once it has one: the same stubs lie over it.
    testsPanelLoaded: () => {
      const real = actual.testsPanelLoaded();
      return real && !chunkNotLoaded ? stubbed(real) : undefined;
    }
  };
});

defineDatumBuilderElement();

afterEach(() => {
  document.body.innerHTML = "";
  renameStub = undefined;
  pinsStub = undefined;
  chunkNotLoaded = false;
  loadGate = undefined;
  loads = 0;
});

const TESTS: FormTestConfiguration = { scenarios: [{ id: "test-1", source: 'test "Name is shown"\n  expect fullName visible\n' }] };

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
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

async function mount(setup?: (element: DatumBuilderElement) => void): Promise<DatumBuilderElement> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot(), componentTypes: [{ type: "text", label: "Text" }] };
  setup?.(element);
  document.body.append(element);
  await until(() => element.shadowRoot?.querySelector("[data-tests-panel-item]"));
  return element;
}

const shell = (element: DatumBuilderElement): ShadowRoot => element.shadowRoot!;
const item = (element: DatumBuilderElement): HTMLButtonElement => shell(element).querySelector<HTMLButtonElement>("[data-tests-panel-item]")!;
const host = (element: DatumBuilderElement): HTMLElement => shell(element).querySelector<HTMLElement>(".slot.tests")!;

/** Opens the panel from the strip and waits until its chunk is wired. */
async function openPanel(element: DatumBuilderElement): Promise<HTMLElement> {
  item(element).click();
  await until(() => customElements.get("datum-builder-tests-panel") && typeof (host(element) as unknown as { suspendPaints?: unknown }).suspendPaints === "function");
  return host(element);
}

function status(failed: number): CustomEvent {
  return new CustomEvent("builder-tests-status", {
    detail: { failed, summary: { total: 3, passed: 3 - failed, failed, skipped: 0, error: 0, invalid: 0 } }
  });
}

describe("the Tests strip item", () => {
  it("is on the strip with the catalog's words and the tests feature behind it", async () => {
    const element = await mount();
    expect(item(element).getAttribute("aria-label")).toBe("Tests");
    expect(item(element).dataset.tip).toBe("Tests: scenarios that pin the form's rules");
    expect(item(element).hidden).toBe(false);
    // Tests are the form's, whichever workspace the author is in.
    expect(item(element).dataset.workspaces).toBe("form logic data journeys pdf print");
  });

  it("goes with the feature: minimal leaves it off, and naming it brings it back", async () => {
    const element = await mount((el) => el.setAttribute("features", "minimal"));
    expect(item(element).hidden).toBe(true);
    element.setAttribute("features", "minimal tests");
    expect(item(element).hidden).toBe(false);
  });

  it("opens the side panel on a click and upgrades the lazy element", async () => {
    const element = await mount();
    expect(host(element).hidden).toBe(true);
    const panel = await openPanel(element);
    expect(element.panel).toBe("tests");
    expect(panel.hidden).toBe(false);
    expect(item(element).getAttribute("aria-selected")).toBe("true");
    expect(customElements.get("datum-builder-tests-panel")).toBeDefined();
  });

  it("opens the drawer at its own width: the wrap names the open panel and the sheet widens it for Tests", async () => {
    const element = await mount();
    const wrap = shell(element).querySelector<HTMLElement>(".wrap")!;
    expect(wrap.dataset.openPanel).not.toBe("tests");
    await openPanel(element);
    expect(wrap.dataset.openPanel).toBe("tests");
    expect(PANEL_DRAWER_WIDTHS.tests).toBe(360);
    const sheet = shell(element).querySelector("style")!.textContent ?? "";
    expect(sheet).toContain('.wrap[data-open-panel="tests"] { --db-side-w: 360px; }');
    // Nothing is written on the wrap itself: a width the author dragged goes there and outranks the sheet.
    expect(wrap.style.getPropertyValue("--db-side-w")).toBe("");
    shell(element).querySelector<HTMLButtonElement>("[data-strip] [role=tab][data-panel=outline]")!.click();
    expect(wrap.dataset.openPanel).toBe("outline");
  });

  it("keeps a remembered width on the wrap over the panel's own", async () => {
    const key = "tests-shell-memory-width";
    writePanelMemory(key, { panel: "tests", propsCollapsed: false, sideWidth: 320 });
    const element = await mount((el) => el.setAttribute("persist-panels", key));
    const wrap = shell(element).querySelector<HTMLElement>(".wrap")!;
    expect(wrap.dataset.openPanel).toBe("tests");
    expect(wrap.style.getPropertyValue("--db-side-w")).toBe("320px");
    clearPanelMemory(key);
  });

  it("hands the panel the form's controller, not another mode's", async () => {
    const element = await mount();
    const panel = (await openPanel(element)) as unknown as { controller: unknown };
    expect(panel.controller).toBe(element.controller);
  });
});

describe("the tests property", () => {
  it("round-trips through the controller, silently and with no undo step", async () => {
    const element = await mount();
    const changes: string[] = [];
    element.addEventListener("builder-change", (event) => changes.push((event as CustomEvent<{ reason: string }>).detail.reason));
    const could = element.controller.canUndo();
    element.tests = TESTS;
    expect(element.tests).toEqual(TESTS);
    expect(element.controller.tests()).toEqual(TESTS);
    expect(changes).toEqual([]);
    expect(element.controller.canUndo()).toBe(could);
    element.tests = undefined;
    expect(element.tests).toBeUndefined();
  });

  it("is an edit when the panel changes it: the host hears builder-change and can read it back", async () => {
    const element = await mount();
    const reasons: string[] = [];
    element.addEventListener("builder-change", (event) => reasons.push((event as CustomEvent<{ reason: string }>).detail.reason));
    element.controller.setTests(TESTS);
    expect(reasons).toEqual(["edit"]);
    expect(element.tests).toEqual(TESTS);
  });
});

describe("the failing count", () => {
  it("draws on the item when tests fail, names it in words, and goes at zero", async () => {
    const element = await mount();
    const panel = await openPanel(element);
    panel.dispatchEvent(status(2));
    const badge = item(element).querySelector<HTMLElement>(".strip-count");
    expect(badge?.textContent).toBe("2");
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    expect(item(element).getAttribute("aria-label")).toBe("Tests, 2 problems");
    panel.dispatchEvent(status(1));
    expect(item(element).querySelector(".strip-count")?.textContent).toBe("1");
    expect(item(element).getAttribute("aria-label")).toBe("Tests, 1 problem");
    panel.dispatchEvent(status(0));
    expect(item(element).querySelector(".strip-count")).toBeNull();
    expect(item(element).getAttribute("aria-label")).toBe("Tests");
  });

  it("keeps the count in the item's name when the words change", async () => {
    const element = await mount();
    const panel = await openPanel(element);
    panel.dispatchEvent(status(2));
    element.textCatalog = { en: { "shell.panel.tests.label": "Checks" } };
    expect(item(element).querySelector(".strip-count")?.textContent).toBe("2");
    expect(item(element).getAttribute("aria-label")).toBe("Checks, 2 problems");
  });
});

describe("what the panel offers that other features own", () => {
  it("offers Show me only with Try it, and Open rule only with Logic", async () => {
    const element = await mount((el) => el.setAttribute("features", "minimal tests"));
    const panel = (await openPanel(element)) as unknown as { showOnCanvas: unknown; openRuleAvailable: boolean };
    expect(panel.showOnCanvas).toBeUndefined();
    expect(panel.openRuleAvailable).toBe(false);
    element.setAttribute("features", "minimal tests try-it logic");
    expect(typeof panel.showOnCanvas).toBe("function");
    expect(panel.openRuleAvailable).toBe(true);
  });
});

describe("Show me from a workspace without the canvas", () => {
  it("brings the Form workspace back with the Tests panel open, then shows", async () => {
    const element = await mount();
    const panel = (await openPanel(element)) as unknown as { showOnCanvas: (showing: unknown) => void };
    const canvas = shell(element).querySelector("datum-builder-canvas") as unknown as { showScenario?: (value: unknown) => void };
    const show = vi.fn();
    canvas.showScenario = show;
    expect(element.setWorkspace("logic")).toBe(true);
    expect(element.workspace).toBe("logic");
    const showing = { name: "x", step: 1, steps: 1, line: 2, values: {}, onStep: () => undefined, onStop: vi.fn() };
    panel.showOnCanvas(showing);
    expect(element.workspace).toBe("form");
    expect(element.panel).toBe("tests");
    expect(show).toHaveBeenCalledWith(showing);
    expect(showing.onStop).not.toHaveBeenCalled();
  });
});

describe("a leave held for the panel's edit", () => {
  it("opens the panel when it asks to be shown", async () => {
    const element = await mount();
    const panel = await openPanel(element);
    element.panel = undefined;
    expect(element.panel).toBeUndefined();
    panel.dispatchEvent(new CustomEvent("builder-tests-reveal", { bubbles: true, composed: true }));
    expect(element.panel).toBe("tests");
    expect(panel.hidden).toBe(false);
  });
});

describe("Open rule", () => {
  it("switches to Logic and asks its surface to open the component's rule once it is there", async () => {
    const element = await mount();
    const panel = await openPanel(element);
    const detail = { componentId: "fullName", kind: "visibleWhen" };
    panel.dispatchEvent(new CustomEvent("builder-tests-open-rule", { detail }));
    expect(element.workspace).toBe("logic");
    await until(() => shell(element).querySelector("datum-builder-logic"));
    // The surface is up: a second request reaches it directly.
    const logic = shell(element).querySelector("datum-builder-logic") as unknown as { openRuleFor(id: string): void };
    const open = vi.fn();
    logic.openRuleFor = open;
    panel.dispatchEvent(new CustomEvent("builder-tests-open-rule", { detail }));
    // The rule key the expectation reads goes with it, so a field with several rules opens the one the test is about.
    expect(open).toHaveBeenCalledWith("fullName", "visibleWhen");
  });

  it("asks for the field's first rule when the panel names no kind", async () => {
    const element = await mount();
    const panel = await openPanel(element);
    panel.dispatchEvent(new CustomEvent("builder-tests-open-rule", { detail: { componentId: "fullName" } }));
    await until(() => shell(element).querySelector("datum-builder-logic"));
    const logic = shell(element).querySelector("datum-builder-logic") as unknown as { openRuleFor(id: string, kind?: string): void };
    const open = vi.fn();
    logic.openRuleFor = open;
    element.setWorkspace("form");
    panel.dispatchEvent(new CustomEvent("builder-tests-open-rule", { detail: { componentId: "fullName" } }));
    expect(open).toHaveBeenCalledWith("fullName");
  });

  it("ignores a request that names no component", async () => {
    const element = await mount();
    const panel = await openPanel(element);
    panel.dispatchEvent(new CustomEvent("builder-tests-open-rule", { detail: {} }));
    expect(element.workspace).toBe("form");
  });
});

describe("a rename in the form", () => {
  it("rewrites the scenarios through the chunk's seam, as one more edit", async () => {
    const marked: FormTestConfiguration = { scenarios: [{ id: "test-1", source: 'test "Name is shown"\n  expect fullName2 visible\n' }] };
    const calls: unknown[][] = [];
    renameStub = (...args) => {
      calls.push(args);
      return marked;
    };
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    const set = vi.spyOn(element.controller, "setTests");
    element.controller.select("fullName");
    element.controller.setDraftId("fullName", "fullName2");
    expect(element.controller.commitDraft("fullName")).toBe(true);
    await until(() => set.mock.calls.length > 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 3)).toEqual([TESTS, "fullName", "fullName2"]);
    // The signatures in force: none wired here, so the built-ins alone.
    expect(calls[0]![3]).toEqual([]);
    expect(set).toHaveBeenCalledWith(marked);
    expect(element.tests).toEqual(marked);
  });

  it("follows two quick renames in order, the second seeing the first's result", async () => {
    const seen: string[] = [];
    renameStub = (tests, from, to) => {
      seen.push(`${from}>${to}:${tests?.scenarios[0]?.source}`);
      return { scenarios: [{ id: "test-1", source: `${to}` }] };
    };
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    element.controller.select("fullName");
    element.controller.setDraftId("fullName", "a");
    element.controller.commitDraft("fullName");
    element.controller.select("a");
    element.controller.setDraftId("a", "b");
    element.controller.commitDraft("a");
    await until(() => seen.length === 2);
    expect(seen[0]).toBe(`fullName>a:${TESTS.scenarios[0]!.source}`);
    expect(seen[1]).toBe("a>b:a");
  });

  it("does nothing, and loads nothing, when the form has no scenarios", async () => {
    const calls: unknown[] = [];
    renameStub = (...args) => {
      calls.push(args);
      return undefined;
    };
    const element = await mount();
    element.controller.select("fullName");
    element.controller.setDraftId("fullName", "other");
    element.controller.commitDraft("fullName");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual([]);
    expect(element.tests).toBeUndefined();
  });

  it("fetches nothing where the tests feature is off", async () => {
    const calls: unknown[] = [];
    renameStub = (...args) => {
      calls.push(args);
      return undefined;
    };
    const errors: unknown[] = [];
    const element = await mount((el) => {
      el.setAttribute("features", "minimal");
      el.tests = TESTS;
    });
    element.addEventListener("datum-error", (event) => errors.push(event));
    element.controller.select("fullName");
    element.controller.setDraftId("fullName", "other");
    element.controller.commitDraft("fullName");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(loads).toBe(0);
    expect(calls).toEqual([]);
    expect(errors).toEqual([]);
    expect(element.tests).toEqual(TESTS);
  });

  it("leaves the scenarios alone for a component with a data key, whose value path does not move", async () => {
    const calls: unknown[] = [];
    renameStub = (...args) => {
      calls.push(args);
      return { scenarios: [] };
    };
    const element = await mount((el) => {
      const root = formRoot();
      (root.children!.content![0]!.configuration as Record<string, unknown>).dataKey = "fullName";
      el.options = { initialRoot: root, componentTypes: [{ type: "text", label: "Text" }] };
      el.tests = TESTS;
    });
    element.controller.select("fullName");
    element.controller.setDraftId("fullName", "other");
    element.controller.commitDraft("fullName");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual([]);
    expect(element.tests).toEqual(TESTS);
  });

  it("drops a follow whose chunk lands after another form was opened", async () => {
    const calls: unknown[] = [];
    renameStub = (...args) => {
      calls.push(args);
      return { scenarios: [{ id: "test-1", source: "rewritten" }] };
    };
    let release: () => void = () => undefined;
    loadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    element.controller.select("fullName");
    element.controller.setDraftId("fullName", "other");
    element.controller.commitDraft("fullName");
    await until(() => loads > 0);
    // Another form comes in while the chunk is on its way, with tests of its own.
    element.controller.setOptions({ initialRoot: formRoot() });
    const next: FormTestConfiguration = { scenarios: [{ id: "test-9", source: 'test "other"\n  expect fullName visible' }] };
    element.tests = next;
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual([]);
    expect(element.tests).toEqual(next);
  });

  it("leaves the scenarios as they were when the seam returns nothing", async () => {
    renameStub = () => undefined;
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    const set = vi.spyOn(element.controller, "setTests");
    element.controller.select("fullName");
    element.controller.setDraftId("fullName", "other");
    element.controller.commitDraft("fullName");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(set).not.toHaveBeenCalled();
    expect(element.tests).toEqual(TESTS);
  });
});

describe("a rename and a move of the data are one step with the scenarios they rewrite", () => {
  const sourceOf = (element: DatumBuilderElement): string => element.tests?.scenarios[0]?.source ?? "";

  it("one Undo puts back the id and the scenarios together, Redo renames both again, and neither is followed again", async () => {
    let follows = 0;
    renameStub = (tests, from, to, signatures, options) => {
      follows += 1;
      return renameInTests(tests, from, to, signatures as Parameters<typeof renameInTests>[3], options as Parameters<typeof renameInTests>[4]);
    };
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    const ctrl = element.controller;
    ctrl.renameId("fullName", "fullName2");
    await until(() => sourceOf(element).includes("expect fullName2 visible"));
    expect(follows).toBe(1);

    ctrl.undo();
    expect(ctrl.snapshot().children?.content?.[0]?.id).toBe("fullName");
    expect(sourceOf(element)).toBe(TESTS.scenarios[0]!.source);
    expect(ctrl.canUndo()).toBe(false);
    // The undone rename's entry held the scenarios: the shell does not rewrite them a second time.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(follows).toBe(1);
    expect(sourceOf(element)).toBe(TESTS.scenarios[0]!.source);

    ctrl.redo();
    expect(ctrl.snapshot().children?.content?.[0]?.id).toBe("fullName2");
    expect(sourceOf(element)).toContain("expect fullName2 visible");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(follows).toBe(1);
  });

  it("a data key edit tells each mode where the data went at once, and the scenarios follow in the edit's step", async () => {
    const moved: unknown[] = [];
    const element = await mount((el) => {
      el.tests = { scenarios: [{ id: "test-1", source: 'test "Name is kept"\n  set fullName = "Ada"\n' }] };
    });
    const mode: BuilderMode = {
      id: "paper",
      label: "Paper",
      controller: new BuilderController({ initialRoot: formRoot() }),
      formDataMoved: (moves) => moved.push(moves)
    };
    element.addMode(mode);
    const ctrl = element.controller;
    ctrl.setProperty("fullName", "dataKey", "name");
    // At once, as a rename reaches the modes: before the scenarios' chunk has answered.
    expect(moved).toEqual([[{ from: "fullName", to: "name" }]]);
    await until(() => sourceOf(element).includes("set name ="));

    ctrl.undo();
    expect(ctrl.getProperty("fullName", "dataKey")).toBeUndefined();
    expect(sourceOf(element)).toContain("set fullName =");
    expect(ctrl.canUndo()).toBe(false);
  });

  it("a data move with nothing to rewrite in the scenarios spends no step of its own", async () => {
    const element = await mount((el) => {
      el.tests = { scenarios: [{ id: "test-1", source: 'test "Other"\n  set other = 1\n' }] };
    });
    const set = vi.spyOn(element.controller, "setTests");
    element.controller.setProperty("fullName", "dataKey", "name");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(set).not.toHaveBeenCalled();
    element.controller.undo();
    expect(element.controller.canUndo()).toBe(false);
  });
});

describe("closing the panel ends a showing", () => {
  it("asks the canvas to stop showing when the panel is put away, and not before", async () => {
    const element = await mount();
    const canvas = shell(element).querySelector("datum-builder-canvas") as unknown as { showScenario?: (value: unknown) => void; scenarioShowing?: unknown };
    const show = vi.fn();
    canvas.showScenario = show;
    // The canvas class defines scenarioShowing as a getter, so the stand-in goes on the instance.
    const onStop = vi.fn();
    Object.defineProperty(canvas, "scenarioShowing", { configurable: true, get: () => ({ name: "x", onStop }) });
    await openPanel(element);
    expect(show).not.toHaveBeenCalled();
    element.panel = undefined;
    expect(show).toHaveBeenCalledWith(undefined);
    // The panel hears its showing ended, as it does from the canvas's own ending.
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("asks nothing of a canvas that is showing nothing", async () => {
    const element = await mount();
    const canvas = shell(element).querySelector("datum-builder-canvas") as unknown as { showScenario?: (value: unknown) => void };
    const show = vi.fn();
    canvas.showScenario = show;
    await openPanel(element);
    element.panel = undefined;
    expect(show).not.toHaveBeenCalled();
  });
});

// --- Record and Assert this -----------------------------------------------------------------------

/** What a rename seam stands in with: a block that differs from TESTS, so storing it is an edit. */
const MARKED: FormTestConfiguration = { scenarios: [{ id: "test-1", source: 'test "Name is shown"\n  expect fullName hidden\n' }] };

describe("a page or journey rename in the Journeys mode", () => {
  it("is followed as a page rewrite, one more edit, through the chunk's seam", async () => {
    const calls: unknown[][] = [];
    renameStub = (...args) => {
      calls.push(args);
      return MARKED;
    };
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    const set = vi.spyOn(element.controller, "setTests");
    element.followJourneyChange({ reason: "page-rename", renamed: { from: "intro", to: "start" } });
    await until(() => set.mock.calls.length > 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 3)).toEqual([TESTS, "intro", "start"]);
    expect(calls[0]![4]).toEqual({ kind: "page" });
    expect(set).toHaveBeenCalledWith(MARKED);
    expect(element.tests).toEqual(MARKED);
  });

  it("scopes a page rename to the journey it was made in, with the journey a scenario runs by default", async () => {
    const calls: unknown[][] = [];
    renameStub = (...args) => {
      calls.push(args);
      return MARKED;
    };
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    element.followJourneyChange({ reason: "page-rename", renamed: { journeyId: "adult", from: "details", to: "adult_details" } } as Parameters<DatumBuilderElement["followJourneyChange"]>[0]);
    await until(() => calls.length > 0);
    expect(calls[0]![4]).toMatchObject({ kind: "page", journeyId: "adult" });
  });

  it("is followed as a journey rewrite for a journey rename", async () => {
    const calls: unknown[][] = [];
    renameStub = (...args) => {
      calls.push(args);
      return MARKED;
    };
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    element.followJourneyChange({ reason: "journey-rename", renamed: { from: "signup", to: "enrol" } });
    await until(() => calls.length > 0);
    expect(calls[0]!.slice(0, 3)).toEqual([TESTS, "signup", "enrol"]);
    expect(calls[0]![4]).toEqual({ kind: "journey" });
  });

  it("waits behind a component rename, so both land in order", async () => {
    const seen: string[] = [];
    renameStub = (tests, from, to, _signatures, options) => {
      seen.push(`${options?.kind ?? "path"}:${from}>${to}`);
      return { scenarios: [{ id: "test-1", source: `${tests?.scenarios[0]?.source}${to}` }] };
    };
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    element.controller.select("fullName");
    element.controller.setDraftId("fullName", "a");
    element.controller.commitDraft("fullName");
    element.followJourneyChange({ reason: "page-rename", renamed: { from: "p", to: "q" } });
    await until(() => seen.length === 2);
    expect(seen).toEqual(["path:fullName>a", "page:p>q"]);
    expect(element.tests!.scenarios[0]!.source.endsWith("aq")).toBe(true);
  });

  it("ignores a change that is not a rename, a rename of nothing, and details with no ids", async () => {
    const calls: unknown[] = [];
    renameStub = (...args) => {
      calls.push(args);
      return MARKED;
    };
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    element.followJourneyChange({ reason: "journeys" });
    element.followJourneyChange({ reason: "edit", renamed: { from: "a", to: "b" } });
    element.followJourneyChange({ reason: "page-rename", renamed: { from: "a", to: "a" } });
    element.followJourneyChange({ reason: "page-rename", renamed: { from: 1, to: "b" } });
    element.followJourneyChange({ reason: "page-rename" });
    element.followJourneyChange(undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual([]);
    expect(element.tests).toEqual(TESTS);
  });

  it("loads nothing for a form with no scenarios, or where the tests feature is off", async () => {
    renameStub = () => MARKED;
    const empty = await mount();
    empty.followJourneyChange({ reason: "page-rename", renamed: { from: "a", to: "b" } });
    const off = await mount((el) => {
      el.setAttribute("features", "minimal");
      el.tests = TESTS;
    });
    off.followJourneyChange({ reason: "page-rename", renamed: { from: "a", to: "b" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(loads).toBe(0);
    expect(off.tests).toEqual(TESTS);
  });

  it("drops a follow whose chunk lands after another form was opened", async () => {
    const calls: unknown[] = [];
    renameStub = (...args) => {
      calls.push(args);
      return MARKED;
    };
    let release: () => void = () => undefined;
    loadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    element.followJourneyChange({ reason: "page-rename", renamed: { from: "a", to: "b" } });
    await until(() => loads > 0);
    element.controller.setOptions({ initialRoot: formRoot() });
    const next: FormTestConfiguration = { scenarios: [{ id: "test-9", source: 'test "other"\n  expect fullName visible' }] };
    element.tests = next;
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual([]);
    expect(element.tests).toEqual(next);
  });
});

describe("a rename the Journeys mode announces itself", () => {
  const announce = (element: DatumBuilderElement, detail: unknown): void => {
    // The mode dispatches on the root it was given; any element under the shell's root reaches the shell the same way.
    (shell(element).querySelector("datum-builder-canvas") as HTMLElement).dispatchEvent(new CustomEvent("builder-journey-rename", { detail, bubbles: true, composed: true }));
  };

  it("a page rename follows with no host code, as a page rewrite scoped to its journey", async () => {
    const calls: unknown[][] = [];
    renameStub = (...args) => {
      calls.push(args);
      return MARKED;
    };
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    announce(element, { kind: "page", journeyId: "adult", from: "details", to: "adult_details" });
    await until(() => calls.length > 0);
    expect(calls[0]!.slice(0, 3)).toEqual([TESTS, "details", "adult_details"]);
    expect(calls[0]![4]).toMatchObject({ kind: "page", journeyId: "adult" });
    expect(element.tests).toEqual(MARKED);
  });

  it("a journey rename follows as a journey rewrite", async () => {
    const calls: unknown[][] = [];
    renameStub = (...args) => {
      calls.push(args);
      return MARKED;
    };
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    announce(element, { kind: "journey", journeyId: "enrol", from: "signup", to: "enrol" });
    await until(() => calls.length > 0);
    expect(calls[0]!.slice(0, 3)).toEqual([TESTS, "signup", "enrol"]);
    expect(calls[0]![4]).toEqual({ kind: "journey" });
  });

  it("is applied once when a host also forwards the same rename: the second finds nothing to rewrite", async () => {
    // The chunk's rewrite as it behaves: a name that is no longer there is no change.
    const seen: string[] = [];
    renameStub = (tests, from, to) => {
      seen.push(`${from}>${to}`);
      const source = tests?.scenarios[0]?.source ?? "";
      return source.includes(from) ? { scenarios: [{ id: "test-1", source: source.split(from).join(to) }] } : undefined;
    };
    const element = await mount((el) => {
      el.tests = { scenarios: [{ id: "test-1", source: 'test "x"\n  go to intro' }] };
    });
    const set = vi.spyOn(element.controller, "setTests");
    announce(element, { kind: "page", journeyId: "j", from: "intro", to: "start" });
    element.followJourneyChange({ reason: "page-rename", renamed: { journeyId: "j", from: "intro", to: "start" } });
    await until(() => seen.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(set).toHaveBeenCalledTimes(1);
    expect(element.tests!.scenarios[0]!.source).toBe('test "x"\n  go to start');
  });

  it("ignores a detail that names no kind or no ids, and loads nothing with the tests feature off", async () => {
    renameStub = () => MARKED;
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    announce(element, { kind: "field", from: "a", to: "b" });
    announce(element, { kind: "page", from: 1, to: "b" });
    announce(element, undefined);
    const off = await mount((el) => {
      el.setAttribute("features", "minimal");
      el.tests = TESTS;
    });
    announce(off, { kind: "page", journeyId: "j", from: "a", to: "b" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(element.tests).toEqual(TESTS);
    expect(off.tests).toEqual(TESTS);
    expect(loads).toBe(0);
  });

  it("drops a follow whose chunk lands after another form was opened", async () => {
    const calls: unknown[] = [];
    renameStub = (...args) => {
      calls.push(args);
      return MARKED;
    };
    let release: () => void = () => undefined;
    loadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const element = await mount((el) => {
      el.tests = TESTS;
    });
    announce(element, { kind: "page", journeyId: "j", from: "a", to: "b" });
    await until(() => loads > 0);
    element.controller.setOptions({ initialRoot: formRoot() });
    const next: FormTestConfiguration = { scenarios: [{ id: "test-9", source: 'test "other"\n  expect fullName visible' }] };
    element.tests = next;
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual([]);
    expect(element.tests).toEqual(next);
  });
});

describe("the Tests panel remembered by persist-panels", () => {
  it("is on the remembered list: opening it writes it, and the record is read back", async () => {
    const key = "tests-shell-memory-1";
    const element = await mount((el) => el.setAttribute("persist-panels", key));
    item(element).click();
    expect(element.panel).toBe("tests");
    expect(readPanelMemory(key)?.panel).toBe("tests");
    clearPanelMemory(key);
  });

  it("puts the panel back open at load and tells it so, before it is shown", async () => {
    const key = "tests-shell-memory-2";
    writePanelMemory(key, { panel: "tests", propsCollapsed: false, workspace: "form" });
    const element = await mount((el) => el.setAttribute("persist-panels", key));
    const panel = (await (async () => {
      await until(() => customElements.get("datum-builder-tests-panel") && typeof (host(element) as unknown as { suspendPaints?: unknown }).suspendPaints === "function");
      return host(element);
    })()) as unknown as { restored?: boolean; hidden: boolean };
    expect(element.panel).toBe("tests");
    expect(panel.hidden).toBe(false);
    expect(panel.restored).toBe(true);
    clearPanelMemory(key);
  });

  it("does not mark a panel the author opens as restored", async () => {
    const element = await mount();
    const panel = (await openPanel(element)) as unknown as { restored?: boolean };
    expect(panel.restored).toBe(false);
  });

  it("does not carry the mark to a panel wired later, when another panel was the remembered one", async () => {
    const key = "tests-shell-memory-3";
    writePanelMemory(key, { panel: "outline", propsCollapsed: false, workspace: "form" });
    const element = await mount((el) => el.setAttribute("persist-panels", key));
    expect(element.panel).toBe("outline");
    const panel = (await openPanel(element)) as unknown as { restored?: boolean };
    expect(panel.restored).toBe(false);
    clearPanelMemory(key);
  });

  it("reads a record naming the Tests panel, and still refuses one naming something unknown", () => {
    const key = "tests-shell-memory-4";
    writePanelMemory(key, { panel: "tests", propsCollapsed: true, sideWidth: 320 });
    expect(readPanelMemory(key)).toEqual({ panel: "tests", propsCollapsed: true, sideWidth: 320 });
    panelMemoryStore().setItem(panelMemoryKey(key), JSON.stringify({ v: 1, panel: "tests-panel", propsCollapsed: false }));
    expect(readPanelMemory(key)).toBeUndefined();
    clearPanelMemory(key);
  });
});

describe("Record and Assert this ride on Try it", () => {
  interface RecordingPanel {
    recordOnCanvas?: (listener: (event: unknown) => void) => () => void;
    assertSnapshot?: () => unknown;
  }
  const canvasOf = (element: DatumBuilderElement): Record<string, unknown> => shell(element).querySelector("datum-builder-canvas") as unknown as Record<string, unknown>;

  it("hands the panel the canvas's recordTry and assertSnapshot while Try it is on, reaching the canvas when called", async () => {
    const element = await mount((el) => el.setAttribute("features", "minimal tests try-it"));
    const stop = vi.fn();
    const recordTry = vi.fn(() => stop);
    const snapshot = { fields: [] };
    const assertSnapshot = vi.fn(() => snapshot);
    const panel = (await openPanel(element)) as unknown as RecordingPanel;
    expect(typeof panel.recordOnCanvas).toBe("function");
    expect(typeof panel.assertSnapshot).toBe("function");
    // The canvas methods land on the canvas later than the panel is wired: the callbacks find them when they are called.
    Object.assign(canvasOf(element), { recordTry, assertSnapshot });
    const listener = vi.fn();
    const stopped = panel.recordOnCanvas!(listener);
    expect(recordTry).toHaveBeenCalledWith(listener);
    expect(stopped).toBe(stop);
    expect(panel.assertSnapshot!()).toBe(snapshot);
  });

  it("hands the panel neither without Try it, and takes them back when the feature goes", async () => {
    const element = await mount((el) => el.setAttribute("features", "minimal tests"));
    const panel = (await openPanel(element)) as unknown as RecordingPanel;
    expect(panel.recordOnCanvas).toBeUndefined();
    expect(panel.assertSnapshot).toBeUndefined();
    element.setAttribute("features", "minimal tests try-it");
    expect(typeof panel.recordOnCanvas).toBe("function");
    expect(typeof panel.assertSnapshot).toBe("function");
    element.setAttribute("features", "minimal tests");
    expect(panel.recordOnCanvas).toBeUndefined();
    expect(panel.assertSnapshot).toBeUndefined();
  });

  it("tells the panel to stop recording when the canvas ends one by itself (the bar's Stop, Clear answers)", async () => {
    const element = await mount((el) => el.setAttribute("features", "minimal tests try-it"));
    const panel = (await openPanel(element)) as unknown as { stopRecording?: () => void };
    const stopRecording = vi.fn();
    panel.stopRecording = stopRecording;
    const raise = (recording: boolean): void => {
      (canvasOf(element) as unknown as HTMLElement).dispatchEvent(new CustomEvent("canvas-record-change", { detail: { recording }, bubbles: true, composed: true }));
    };
    // A recording starting is not the panel's to stop; one ending is.
    raise(true);
    expect(stopRecording).not.toHaveBeenCalled();
    raise(false);
    expect(stopRecording).toHaveBeenCalledTimes(1);
  });

  it("tells the panel when the canvas's Try it chunk arrived after Record started, so it takes the form before the first step", async () => {
    const element = await mount((el) => el.setAttribute("features", "minimal tests try-it"));
    const panel = (await openPanel(element)) as unknown as { stopRecording?: () => void; recordingReady?: () => void };
    const stopRecording = vi.fn();
    const recordingReady = vi.fn();
    Object.assign(panel, { stopRecording, recordingReady });
    const raise = (detail: { recording: boolean; ready?: boolean }): void => {
      (canvasOf(element) as unknown as HTMLElement).dispatchEvent(new CustomEvent("canvas-record-change", { detail, bubbles: true, composed: true }));
    };
    raise({ recording: true });
    expect(recordingReady).not.toHaveBeenCalled();
    raise({ recording: true, ready: true });
    expect(recordingReady).toHaveBeenCalledTimes(1);
    expect(stopRecording).not.toHaveBeenCalled();
    // Still recording: the drawer keeps clear as before.
    expect(shell(element).querySelector("[data-tests-recording]")).not.toBeNull();
  });

  it("lends the panel the canvas's assertReady while Try it is on, so a paint builds no snapshot to ask", async () => {
    const element = await mount((el) => el.setAttribute("features", "minimal tests try-it"));
    const panel = (await openPanel(element)) as unknown as { assertReady?: () => boolean };
    expect(typeof panel.assertReady).toBe("function");
    expect(panel.assertReady!()).toBe(false);
    Object.defineProperty(canvasOf(element), "assertReady", { configurable: true, get: () => true });
    expect(panel.assertReady!()).toBe(true);
    element.setAttribute("features", "minimal tests");
    expect(panel.assertReady).toBeUndefined();
  });

  it("brings the Form workspace back before Record turns Try it on over a canvas that is put away", async () => {
    const element = await mount((el) => el.setAttribute("features", "minimal tests try-it logic"));
    const panel = (await openPanel(element)) as unknown as RecordingPanel;
    const recordTry = vi.fn(() => () => undefined);
    Object.assign(canvasOf(element), { recordTry, assertSnapshot: () => undefined });
    expect(element.setWorkspace("logic")).toBe(true);
    panel.recordOnCanvas!(() => undefined);
    expect(element.workspace).toBe("form");
    expect(element.panel).toBe("tests");
    expect(recordTry).toHaveBeenCalledTimes(1);
  });

  it("keeps the Tests drawer open beside Try it while it records, the canvas keeping clear of it", async () => {
    const element = await mount((el) => el.setAttribute("features", "minimal tests try-it"));
    const panel = (await openPanel(element)) as unknown as HTMLElement;
    const canvas = canvasOf(element) as unknown as HTMLElement;
    const wrap = shell(element).querySelector<HTMLElement>(".wrap")!;
    const raise = (type: string, detail: unknown): void => {
      canvas.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    };
    // Record starts: the panel says it records before the canvas turns Try it on.
    Object.defineProperty(panel, "recording", { configurable: true, get: () => true });
    raise("canvas-preview-change", { previewing: true });
    raise("canvas-record-change", { recording: true });
    expect(element.panel).toBe("tests");
    expect(wrap.hasAttribute("data-tests-recording")).toBe(true);
    expect(wrap.hasAttribute("data-side-collapsed")).toBe(false);
    raise("canvas-record-change", { recording: false });
    raise("canvas-preview-change", { previewing: false });
    expect(wrap.hasAttribute("data-tests-recording")).toBe(false);
    // Try it on with no recording folds the side column as before.
    Object.defineProperty(panel, "recording", { configurable: true, get: () => false });
    raise("canvas-preview-change", { previewing: true });
    expect(element.panel).toBeUndefined();
    expect(wrap.hasAttribute("data-side-collapsed")).toBe(true);
  });

  it("answers an inert stop and no snapshot while the canvas has no recording yet", async () => {
    const element = await mount((el) => el.setAttribute("features", "minimal tests try-it"));
    const canvas = canvasOf(element);
    // Whether or not the canvas role's methods exist in this tree, take them off the instance for the case.
    Object.defineProperty(canvas, "recordTry", { configurable: true, value: undefined });
    Object.defineProperty(canvas, "assertSnapshot", { configurable: true, value: undefined });
    const panel = (await openPanel(element)) as unknown as RecordingPanel;
    const stop = panel.recordOnCanvas!(() => undefined);
    expect(() => stop()).not.toThrow();
    expect(panel.assertSnapshot!()).toBeUndefined();
  });
});

describe("the Logic editor's Pinned-by buttons", () => {
  interface Stage4Panel {
    openEntry?: (id: string) => void;
    writeTestFor?: (ruleId: string) => void;
  }
  const raise = (element: DatumBuilderElement, type: string, detail: unknown): void => {
    host(element).dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  };

  it("opens the Tests panel on the entry when a pinned test is asked for", async () => {
    const element = await mount();
    const panel = (await openPanel(element)) as unknown as Stage4Panel;
    const openEntry = vi.fn();
    panel.openEntry = openEntry;
    element.panel = undefined;
    raise(element, "builder-logic-open-test", { entryId: "test-4" });
    await until(() => openEntry.mock.calls.length > 0);
    expect(element.panel).toBe("tests");
    expect(openEntry).toHaveBeenCalledWith("test-4");
  });

  it("opens the Tests panel and scaffolds for the rule when Write a test is asked for", async () => {
    const element = await mount();
    const panel = (await openPanel(element)) as unknown as Stage4Panel;
    const writeTestFor = vi.fn();
    panel.writeTestFor = writeTestFor;
    element.panel = undefined;
    raise(element, "builder-logic-write-test", { ruleId: "form:fullName:visibleWhen" });
    await until(() => writeTestFor.mock.calls.length > 0);
    expect(element.panel).toBe("tests");
    expect(writeTestFor).toHaveBeenCalledWith("form:fullName:visibleWhen");
  });

  it("loads the chunk first when the panel was never opened, then asks", async () => {
    const element = await mount();
    expect(host(element).hidden).toBe(true);
    raise(element, "builder-logic-write-test", { ruleId: "r1" });
    await until(() => customElements.get("datum-builder-tests-panel") && typeof (host(element) as unknown as { suspendPaints?: unknown }).suspendPaints === "function");
    const panel = host(element) as unknown as Stage4Panel;
    const writeTestFor = vi.fn();
    panel.writeTestFor = writeTestFor;
    // The ask was made before the stub went on; the next one reaches it.
    raise(element, "builder-logic-write-test", { ruleId: "r2" });
    await until(() => writeTestFor.mock.calls.length > 0);
    expect(writeTestFor).toHaveBeenCalledWith("r2");
    expect(element.panel).toBe("tests");
  });

  it("ignores a request without an id", async () => {
    const element = await mount();
    raise(element, "builder-logic-open-test", {});
    raise(element, "builder-logic-write-test", { ruleId: "" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(element.panel).not.toBe("tests");
  });

  it("does nothing where the Tests panel is off", async () => {
    const element = await mount((el) => el.setAttribute("features", "minimal logic"));
    raise(element, "builder-logic-open-test", { entryId: "test-1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(element.panel).not.toBe("tests");
    expect(loads).toBe(0);
  });
});

describe("the Logic surface's pins, fed by the shell", () => {
  const PINS = new Map([["form:fullName:visibleWhen", [{ id: "test-1", name: "Name is shown" }]]]);
  interface Surface extends HTMLElement {
    testsPins: ((ruleId: string) => ReadonlyArray<{ id: string; name: string }> | undefined) | undefined;
  }
  const surface = (element: DatumBuilderElement): Surface => shell(element).querySelector("datum-builder-logic") as Surface;

  async function mountInLogic(setup?: (element: DatumBuilderElement) => void): Promise<DatumBuilderElement> {
    const element = await mount(setup);
    element.setWorkspace("logic");
    await until(() => shell(element).querySelector("datum-builder-logic"));
    return element;
  }

  it("answers none, loading nothing, for a form with no scenarios", async () => {
    const element = await mountInLogic();
    expect(typeof surface(element).testsPins).toBe("function");
    expect(surface(element).testsPins!("anything")).toEqual([]);
    expect(loads).toBe(0);
  });

  it("reads the chunk once the form has scenarios and answers with the pins of the tests that pin each rule", async () => {
    const parse = vi.fn((tests: FormTestConfiguration) => tests.scenarios.map((entry) => ({ id: entry.id })));
    const pinsOf = vi.fn((..._args: unknown[]) => PINS);
    pinsStub = { parseTestsEntries: parse, testsPinsOf: pinsOf };
    const element = await mountInLogic((el) => {
      el.tests = TESTS;
    });
    await until(() => surface(element).testsPins !== undefined);
    expect(surface(element).testsPins!("form:fullName:visibleWhen")).toEqual([{ id: "test-1", name: "Name is shown" }]);
    // A rule no test reads is a known "none", not "unknown".
    expect(surface(element).testsPins!("form:fullName:requiredWhen")).toEqual([]);
    const [root, definition, entries, signatures] = pinsOf.mock.calls[0]!;
    expect((root as ComponentNode).id).toBe("root");
    expect((definition as { root: ComponentNode }).root).toBe(root);
    expect(entries).toEqual([{ id: "test-1" }]);
    expect(signatures).toEqual([]);
  });

  it("draws nothing until the chunk has answered", async () => {
    pinsStub = { parseTestsEntries: () => [], testsPinsOf: () => PINS };
    chunkNotLoaded = true;
    let release: () => void = () => undefined;
    loadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const element = await mountInLogic((el) => {
      el.tests = TESTS;
    });
    expect(surface(element).testsPins).toBeUndefined();
    release();
    await until(() => surface(element).testsPins !== undefined);
  });

  it("refreshes when the form or its tests change, and not when nothing did", async () => {
    const pinsOf = vi.fn((..._args: unknown[]) => PINS);
    pinsStub = { parseTestsEntries: () => [], testsPinsOf: pinsOf };
    const element = await mountInLogic((el) => {
      el.tests = TESTS;
    });
    await until(() => pinsOf.mock.calls.length === 1);
    // Away and back with nothing changed: the memo answers.
    element.setWorkspace("form");
    element.setWorkspace("logic");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pinsOf).toHaveBeenCalledTimes(1);
    // A scenario edited through the controller: read again.
    element.controller.setTests(MARKED);
    await until(() => pinsOf.mock.calls.length === 2);
    // A change to the tree: read again.
    element.controller.select("fullName");
    element.controller.setDraftId("fullName", "fullName3");
    element.controller.commitDraft("fullName");
    await until(() => pinsOf.mock.calls.length >= 3);
  });

  it("is a plain none again when the last scenario is removed", async () => {
    pinsStub = { parseTestsEntries: () => [], testsPinsOf: () => PINS };
    const element = await mountInLogic((el) => {
      el.tests = TESTS;
    });
    await until(() => surface(element).testsPins?.("form:fullName:visibleWhen")?.length === 1);
    element.controller.setTests({ scenarios: [] });
    await until(() => surface(element).testsPins?.("form:fullName:visibleWhen")?.length === 0);
  });

  it("feeds nothing where the tests feature is off", async () => {
    const element = await mountInLogic((el) => el.setAttribute("features", "minimal logic"));
    expect(surface(element).testsPins).toBeUndefined();
  });

  it("leaves the surface without pins when the chunk has no coverage to offer", async () => {
    const element = await mountInLogic((el) => {
      el.tests = TESTS;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The real chunk answers once the coverage module is in it; until then, and for a chunk that cannot, nothing is drawn.
    const pins = surface(element).testsPins;
    expect(pins === undefined || Array.isArray(pins("form:fullName:visibleWhen"))).toBe(true);
  });
});

describe("a follow-up of a step that was undone before it landed", () => {
  const sourceOf = (element: DatumBuilderElement): string => element.tests?.scenarios[0]?.source ?? "";
  const SET_NAME: FormTestConfiguration = { scenarios: [{ id: "test-1", source: 'test "Name is kept"\n  set fullName = "Ada"\n' }] };
  /** Everything the shell queued for the scenarios has run. */
  const settled = async (element: DatumBuilderElement): Promise<void> => {
    await (element as unknown as { testsRenameChain: Promise<void> }).testsRenameChain;
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const gate = (): (() => void) => {
    let release: () => void = () => undefined;
    loadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => release();
  };

  it("a rename undone before the chunk lands leaves the scenarios and the Redo; Redo renames both, one Undo puts both back", async () => {
    const element = await mount((el) => {
      el.tests = SET_NAME;
    });
    const ctrl = element.controller;
    const release = gate();
    ctrl.renameId("fullName", "fullName2");
    await until(() => loads > 0);
    ctrl.undo();
    release();
    await settled(element);
    expect(ctrl.snapshot().children?.content?.[0]?.id).toBe("fullName");
    expect(sourceOf(element)).toBe(SET_NAME.scenarios[0]!.source);
    expect(ctrl.canRedo()).toBe(true);
    expect(ctrl.canUndo()).toBe(false);

    ctrl.redo();
    await until(() => sourceOf(element).includes("set fullName2 ="));
    expect(ctrl.snapshot().children?.content?.[0]?.id).toBe("fullName2");
    ctrl.undo();
    expect(ctrl.snapshot().children?.content?.[0]?.id).toBe("fullName");
    expect(sourceOf(element)).toBe(SET_NAME.scenarios[0]!.source);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("a data key edit undone before the chunk lands leaves the scenarios and the Redo; Redo moves the scenarios with the data", async () => {
    const element = await mount((el) => {
      el.tests = SET_NAME;
    });
    const ctrl = element.controller;
    const release = gate();
    ctrl.setProperty("fullName", "dataKey", "name");
    await until(() => loads > 0);
    ctrl.undo();
    release();
    await settled(element);
    expect(ctrl.getProperty("fullName", "dataKey")).toBeUndefined();
    expect(sourceOf(element)).toBe(SET_NAME.scenarios[0]!.source);
    expect(ctrl.canRedo()).toBe(true);

    ctrl.redo();
    await until(() => sourceOf(element).includes("set name ="));
    expect(ctrl.getProperty("fullName", "dataKey")).toBe("name");
  });

  it("writes nothing for a follow the controller drops, and runs it again when the step is redone", async () => {
    const element = await mount((el) => {
      el.tests = SET_NAME;
    });
    const ctrl = element.controller;
    const follow = ctrl.followRename.bind(ctrl);
    // As the controller answers a follow whose rename was undone: false, and `run` never called.
    const spy = vi.spyOn(ctrl, "followRename").mockImplementationOnce(() => false);
    const set = vi.spyOn(ctrl, "setTests");
    const release = gate();
    ctrl.renameId("fullName", "fullName2");
    await until(() => loads > 0);
    ctrl.undo();
    release();
    await settled(element);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    expect(sourceOf(element)).toBe(SET_NAME.scenarios[0]!.source);

    spy.mockImplementation(follow);
    ctrl.redo();
    await until(() => sourceOf(element).includes("set fullName2 ="));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0]).toEqual({ from: "fullName", to: "fullName2" });
  });

  it("a dropped follow is forgotten once its step can no longer be redone", async () => {
    const element = await mount((el) => {
      el.tests = SET_NAME;
    });
    const ctrl = element.controller;
    const spy = vi.spyOn(ctrl, "followRename").mockImplementationOnce(() => false);
    const release = gate();
    ctrl.renameId("fullName", "fullName2");
    await until(() => loads > 0);
    ctrl.undo();
    release();
    await settled(element);
    // A new edit takes the Redo away; renaming the same way again is a rename of its own, followed once.
    ctrl.setProperty("fullName", "label", "Name");
    ctrl.renameId("fullName", "fullName2");
    await until(() => sourceOf(element).includes("set fullName2 ="));
    await settled(element);
    expect(spy).toHaveBeenCalledTimes(2);
    ctrl.undo();
    expect(sourceOf(element)).toBe(SET_NAME.scenarios[0]!.source);
    ctrl.redo();
    await settled(element);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a mode is told of a data move once: an Undo and a Redo of the edit tell it nothing again", async () => {
    const moved: unknown[] = [];
    const element = await mount((el) => {
      el.tests = SET_NAME;
    });
    element.addMode({
      id: "paper",
      label: "Paper",
      controller: new BuilderController({ initialRoot: formRoot() }),
      formDataMoved: (moves) => moved.push(moves)
    });
    const ctrl = element.controller;
    ctrl.setProperty("fullName", "dataKey", "name");
    await until(() => sourceOf(element).includes("set name ="));
    ctrl.undo();
    ctrl.redo();
    await settled(element);
    expect(moved).toEqual([[{ from: "fullName", to: "name" }]]);
    expect(sourceOf(element)).toContain("set name =");
    expect(ctrl.getProperty("fullName", "dataKey")).toBe("name");
  });
});

describe("a Save that changes the id and the data key together", () => {
  const sourceOf = (element: DatumBuilderElement): string => element.tests?.scenarios[0]?.source ?? "";

  it("the scenarios follow the data, not the id, in the Save's step", async () => {
    const tests: FormTestConfiguration = { scenarios: [{ id: "test-1", source: 'test "Name is kept"\n  set fullName = "Ada"\n' }] };
    const element = await mount((el) => {
      el.tests = tests;
    });
    const ctrl = element.controller;
    ctrl.select("fullName");
    ctrl.setDraftId("fullName", "person");
    ctrl.setDraftProperty("fullName", "dataKey", "name");
    expect(ctrl.commitDraft("fullName")).toBe(true);
    await until(() => sourceOf(element).includes("set name ="));
    expect(sourceOf(element)).not.toContain("person");

    ctrl.undo();
    expect(ctrl.snapshot().children?.content?.[0]?.id).toBe("fullName");
    expect(ctrl.getProperty("fullName", "dataKey")).toBeUndefined();
    expect(sourceOf(element)).toBe(tests.scenarios[0]!.source);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("a new id that drops the data key follows both the id and the data in the Save's step", async () => {
    const root = formRoot();
    (root.children!.content![0]!.configuration as Record<string, unknown>).dataKey = "name";
    const tests: FormTestConfiguration = { scenarios: [{ id: "test-1", source: 'test "Name is kept"\n  set name = "Ada"\n  expect fullName visible\n' }] };
    const element = await mount((el) => {
      el.options = { initialRoot: root, componentTypes: [{ type: "text", label: "Text" }] };
      el.tests = tests;
    });
    const ctrl = element.controller;
    ctrl.select("fullName");
    ctrl.setDraftId("fullName", "person");
    ctrl.setDraftProperty("fullName", "dataKey", undefined);
    expect(ctrl.commitDraft("fullName")).toBe(true);
    await until(() => sourceOf(element).includes("set person =") && sourceOf(element).includes("expect person visible"));

    ctrl.undo();
    expect(ctrl.snapshot().children?.content?.[0]?.id).toBe("fullName");
    expect(ctrl.getProperty("fullName", "dataKey")).toBe("name");
    expect(sourceOf(element)).toBe(tests.scenarios[0]!.source);
    expect(ctrl.canUndo()).toBe(false);
  });
});
