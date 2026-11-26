// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import {
  defineBuilderTestsPanel,
  renameInTests,
  TESTS_RUN_AS_I_EDIT_KEY,
  type DatumBuilderTestsPanelElement
} from "../form-engine/builder/web-component/builder-tests-panel.js";
import { TESTS_PANEL_EN } from "../form-engine/builder/form-tests/tests-panel-texts-en.js";
import type {
  BuilderTestsOpenRuleDetail,
  BuilderTestsStatusDetail,
  CanvasScenarioShowing,
  TestsAssertField,
  TestsAssertSnapshot,
  TestsRecordEvent,
  TestsRecordListener
} from "../form-engine/builder/form-tests/tests-model.js";
import { untestedRules } from "../form-engine/builder/form-tests/tests-coverage.js";
import { createTestsRunner, testsPinsOf } from "../form-engine/builder/web-component/builder-tests-panel.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { FormTestConfiguration } from "../form-engine/core/form-tests/form-test-types.js";
import { FORM_TESTS_FAILING_SCENARIO, FORM_TESTS_FIXTURE_SCENARIOS, fixtureWithTests } from "./form-tests/fixtures/form-tests-fixture.js";

/**
 * The Tests panel element: the list with its dots, Run all and
 * Run as I edit; the editor view with its problems, Apply, New test and Remove; a failure with
 * its card, Accept new behaviour, Open rule and Show me. The panel runs the real runner on the
 * fixture form, so the dots are the browser driver's own readings of the shared corpus.
 */

const MAIN = FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === "main");

/** A scenario that fails on a field with a `requiredWhen` rule, over three steps (Open rule and Show me's steps). */
const EMAIL_SOURCE = ['test "email follows the way to reach you"', '  set contact_method = "phone"', "  expect email required", '  set applicant_name = "Ada"'].join("\n");

interface Mounted {
  el: DatumBuilderTestsPanelElement;
  ctrl: BuilderController;
  shadow: ShadowRoot;
  definition: FormDefinition;
  statuses: BuilderTestsStatusDetail[];
}

function mount(tests?: FormTestConfiguration, setup?: (el: DatumBuilderTestsPanelElement) => void, form: "main" | "clock" = "main"): Mounted {
  defineBuilderTestsPanel();
  const definition = fixtureWithTests(form);
  const ctrl = new BuilderController({ initialRoot: structuredClone(definition.root) });
  ctrl.setTests(tests ?? definition.tests, { silent: true });
  const el = document.createElement("datum-builder-tests-panel") as DatumBuilderTestsPanelElement;
  setup?.(el);
  // The plain box is the editor throughout, so what a test types is what the panel reads.
  el.testsEditorLoader = () => Promise.reject(new Error("no CodeMirror here"));
  el.definition = () => ({ ...definition, root: ctrl.snapshot() });
  const statuses: BuilderTestsStatusDetail[] = [];
  el.addEventListener("builder-tests-status", (event) => statuses.push((event as CustomEvent<BuilderTestsStatusDetail>).detail));
  el.controller = ctrl;
  document.body.append(el);
  return { el, ctrl, shadow: el.shadowRoot!, definition, statuses };
}

/** Lets fake time pass until the panel's run settles. */
async function idle(el: DatumBuilderTestsPanelElement): Promise<void> {
  let done = false;
  void el.whenIdle().then(() => {
    done = true;
  });
  for (let i = 0; i < 4000 && !done; i += 1) {
    await vi.advanceTimersByTimeAsync(5);
  }
  expect(done).toBe(true);
}

async function until(check: () => unknown): Promise<void> {
  for (let i = 0; i < 2000 && !check(); i += 1) {
    await vi.advanceTimersByTimeAsync(5);
  }
  expect(check()).toBeTruthy();
}

const q = <T extends Element = HTMLElement>(shadow: ShadowRoot, selector: string): T => shadow.querySelector<T>(selector) as T;
const click = (shadow: ShadowRoot, selector: string): void => q(shadow, selector).click();
const textarea = (shadow: ShadowRoot): HTMLTextAreaElement => q<HTMLTextAreaElement>(shadow, "textarea.tests-textarea");

function type(shadow: ShadowRoot, text: string): void {
  const box = textarea(shadow);
  box.value = text;
  box.setSelectionRange(text.length, text.length);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

function idOf(name: string): string {
  return `main-${MAIN.findIndex((entry) => entry.name === name) + 1}`;
}

/** A store standing in for the page's: Node 22's own `localStorage` global shadows jsdom's (the web components memory). */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => void items.delete(key),
    setItem: (key: string, value: string) => void items.set(key, String(value))
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the list", () => {
  it("draws one entry per scenario with an unrun dot, in the catalog's words", () => {
    const { shadow } = mount();
    expect(q(shadow, ".tests-head").textContent).toBe(TESTS_PANEL_EN["tests.panel.title"]);
    expect(q(shadow, "[data-tests-run-all]").textContent).toContain(TESTS_PANEL_EN["tests.panel.runAll"]);
    expect(q(shadow, "[data-tests-summary]").textContent).toBe(TESTS_PANEL_EN["tests.panel.notRun"]);
    const entries = [...shadow.querySelectorAll<HTMLElement>("[data-tests-entry]")];
    expect(entries.map((entry) => entry.querySelector(".tests-entry-name")?.textContent)).toEqual(MAIN.map((entry) => entry.name));
    for (const entry of entries) {
      expect(entry.dataset.status).toBe("unrun");
      const dot = entry.querySelector<HTMLElement>(".d")!;
      expect(dot.getAttribute("data-tone")).toBe("off");
      expect(dot.getAttribute("role")).toBe("img");
      expect(dot.getAttribute("aria-label")).toBeTruthy();
    }
    expect(q(shadow, "[data-tests-list]").getAttribute("role")).toBe("list");
    expect(q(shadow, "[data-tests-new]").textContent).toBe(TESTS_PANEL_EN["tests.panel.new"]);
    const toggle = q(shadow, "[data-tests-run-as-i-edit]");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("narrows to the names holding the filter's text, case aside", () => {
    const { shadow } = mount();
    const filter = q<HTMLInputElement>(shadow, "[data-tests-filter]");
    filter.value = "PET";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    const shown = [...shadow.querySelectorAll<HTMLLIElement>("[data-tests-row]")].filter((row) => !row.hidden).map((row) => row.querySelector(".tests-entry-name")?.textContent);
    expect(shown).toEqual(MAIN.filter((entry) => entry.name.toLowerCase().includes("pet")).map((entry) => entry.name));
    filter.value = "no such test";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    expect(q(shadow, "[data-tests-none]").hidden).toBe(false);
  });

  it("says how to start when the form has no tests", () => {
    const { shadow } = mount({ scenarios: [] });
    expect(q(shadow, "[data-tests-empty]").textContent).toBe(TESTS_PANEL_EN["tests.panel.empty"]);
    expect(shadow.querySelector("[data-tests-list]")).toBeNull();
  });
});

describe("Run all", () => {
  it("runs every entry; the dots are the browser's readings and the status event counts the failures", async () => {
    const { el, shadow, statuses } = mount();
    click(shadow, "[data-tests-run-all]");
    expect(shadow.querySelector("[data-tests-entry][data-status=\"running\"]")).not.toBeNull();
    await idle(el);
    for (const [index, expected] of MAIN.entries()) {
      const entry = q(shadow, `[data-tests-entry="main-${index + 1}"]`);
      expect(entry.dataset.status, expected.name).toBe(expected.expected.runtime);
    }
    const failed = MAIN.filter((entry) => entry.expected.runtime === "failed" || entry.expected.runtime === "error").length;
    expect(failed).toBeGreaterThan(0);
    const last = statuses.at(-1)!;
    expect(last.failed).toBe(failed);
    expect(last.summary.ranAt).toBeTypeOf("number");
    expect(q(shadow, "[data-tests-summary]").textContent).toMatch(/^Ran just now · \d+ passed, \d+ failed, \d+ skipped, \d+ could not run$/);
    expect(el.runsStarted).toBe(1);
  });
});

describe("Run as I edit", () => {
  it("reruns 400 ms after a committed edit, once for edits inside the window, never with the switch off", async () => {
    const { el, ctrl, shadow } = mount();
    await vi.advanceTimersByTimeAsync(400);
    await idle(el);
    expect(el.runsStarted).toBe(1);

    ctrl.setDraftProperty("age", "label", "Years");
    ctrl.commitDraft("age");
    await vi.advanceTimersByTimeAsync(399);
    expect(el.runsStarted).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(el.runsStarted).toBe(2);
    await idle(el);

    ctrl.setDraftProperty("age", "label", "Age again");
    ctrl.commitDraft("age");
    await vi.advanceTimersByTimeAsync(200);
    ctrl.setDraftProperty("age", "label", "Age at last");
    ctrl.commitDraft("age");
    await vi.advanceTimersByTimeAsync(399);
    expect(el.runsStarted).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(el.runsStarted).toBe(3);
    await idle(el);

    click(shadow, "[data-tests-run-as-i-edit]");
    expect(q(shadow, "[data-tests-run-as-i-edit]").getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(TESTS_RUN_AS_I_EDIT_KEY)).toBe("false");
    ctrl.remove("nickname");
    await vi.advanceTimersByTimeAsync(2000);
    expect(el.runsStarted).toBe(3);
    // What ran before the edit is kept, dimmed, until a run replaces it.
    expect(shadow.querySelector("[data-tests-entry][data-stale]")).not.toBeNull();
    // Three whole suite runs in one test: a loaded machine took it past the 5 s default.
  }, 30_000);

  it("reads the remembered switch, and runs nothing while hidden until shown", async () => {
    localStorage.setItem(TESTS_RUN_AS_I_EDIT_KEY, "false");
    const off = mount();
    expect(q(off.shadow, "[data-tests-run-as-i-edit]").getAttribute("aria-checked")).toBe("false");
    await vi.advanceTimersByTimeAsync(1000);
    expect(off.el.runsStarted).toBe(0);
    document.body.innerHTML = "";

    localStorage.clear();
    const { el } = mount();
    el.hidden = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(el.runsStarted).toBe(0);
    el.hidden = false;
    expect(el.runsStarted).toBe(1);
    await idle(el);
  });
});

describe("the editor view", () => {
  it("holds the source, shows a bad edit's problem under the box by line, and Apply writes one undo step", async () => {
    const { el, ctrl, shadow } = mount();
    const id = idOf("the nickname follows the details box");
    const source = MAIN.find((entry) => entry.name === "the nickname follows the details box")!.source;
    click(shadow, `[data-tests-entry="${id}"]`);
    expect(textarea(shadow).value).toBe(source);
    expect(q(shadow, "[data-tests-name]").textContent).toBe("the nickname follows the details box");
    expect(q<HTMLButtonElement>(shadow, "[data-tests-apply]").disabled).toBe(true);

    const bad = `${source}\n  frobnicate nickname`;
    type(shadow, bad);
    expect(q<HTMLButtonElement>(shadow, "[data-tests-apply]").disabled).toBe(false);
    expect(el.dirty).toBe(true);
    expect(ctrl.hasPendingLeaveGuard()).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    const problems = [...shadow.querySelectorAll<HTMLElement>("ul.tests-problems li [data-tests-problem]")];
    expect(problems).toHaveLength(1);
    const line = bad.split("\n").length;
    expect(problems[0]!.getAttribute("data-tests-problem")).toBe(String(line));
    expect(problems[0]!.textContent).toContain(String(line));
    // The box kept its text and its focus across the parse's repaint.
    expect(textarea(shadow).value).toBe(bad);

    const good = `${source}\n  expect nickname editable`;
    type(shadow, good);
    click(shadow, "[data-tests-apply]");
    expect(ctrl.tests()!.scenarios.find((entry) => entry.id === id)!.source).toBe(good);
    expect(el.dirty).toBe(false);
    expect(ctrl.hasPendingLeaveGuard()).toBe(false);
    expect(ctrl.canUndo()).toBe(true);
    // Apply turned itself off; the box has the focus back.
    expect(shadow.activeElement).toBe(textarea(shadow));
    ctrl.undo();
    expect(ctrl.tests()!.scenarios.find((entry) => entry.id === id)!.source).toBe(source);
    // The clean box follows the undo: it holds the stored text, with nothing unapplied to save over it.
    expect(textarea(shadow).value).toBe(source);
    expect(el.dirty).toBe(false);
    expect(ctrl.hasPendingLeaveGuard()).toBe(false);
    ctrl.redo();
    expect(textarea(shadow).value).toBe(good);
    await idle(el);
  });

  it("follows a rename of the field in the open, clean box, and keeps an author's own edit", () => {
    const { el, ctrl, shadow } = mount({ scenarios: [{ id: "a", source: 'test "a"\n  set age = 1' }] });
    click(shadow, '[data-tests-entry="a"]');
    ctrl.setTests(renameInTests(ctrl.tests(), "age", "years", []));
    expect(textarea(shadow).value).toBe('test "a"\n  set years = 1');
    expect(el.dirty).toBe(false);
    type(shadow, 'test "a"\n  set years = 2');
    ctrl.setTests({ scenarios: [{ id: "a", source: 'test "a"\n  set years = 3' }] });
    expect(textarea(shadow).value).toBe('test "a"\n  set years = 2');
    expect(el.dirty).toBe(true);
  });

  it("follows a host's own tests set, and runs it", async () => {
    const { el, ctrl, shadow } = mount({ scenarios: [{ id: "a", source: 'test "a"\n  expect age visible' }] });
    await vi.advanceTimersByTimeAsync(400);
    await idle(el);
    expect(el.runsStarted).toBe(1);
    click(shadow, '[data-tests-entry="a"]');
    ctrl.setTests({ scenarios: [{ id: "a", source: 'test "a"\n  expect age hidden' }] }, { silent: true });
    el.refresh();
    expect(textarea(shadow).value).toBe('test "a"\n  expect age hidden');
    await vi.advanceTimersByTimeAsync(400);
    expect(el.runsStarted).toBe(2);
    await idle(el);
  });

  it("applies on Ctrl+Enter", () => {
    const { ctrl, shadow } = mount();
    const id = "main-1";
    click(shadow, `[data-tests-entry="${id}"]`);
    const next = `${textarea(shadow).value}\n  expect page = intro`;
    type(shadow, next);
    textarea(shadow).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(ctrl.tests()!.scenarios[0]!.source).toBe(next);
  });

  it("says Not run yet once on a scenario that never ran, with its step count", () => {
    const { shadow } = mount();
    click(shadow, "[data-tests-new]");
    const status = q(shadow, "[data-tests-editor-status]").textContent ?? "";
    expect(status.startsWith(`${TESTS_PANEL_EN["tests.panel.notRun"]} · `)).toBe(true);
    expect(status.toLowerCase().split("not run yet")).toHaveLength(2);
    expect(status).toMatch(/steps?$/);
  });

  it("New test opens a seeded scenario and Apply appends test-1, then test-2", () => {
    const { ctrl, shadow } = mount();
    const count = ctrl.tests()!.scenarios.length;
    click(shadow, "[data-tests-new]");
    expect(textarea(shadow).value).toBe('test "New test"\n  ');
    expect(textarea(shadow).selectionStart).toBe(textarea(shadow).value.length);
    type(shadow, 'test "New test"\n  expect applicant_name visible');
    click(shadow, "[data-tests-apply]");
    const after = ctrl.tests()!.scenarios;
    expect(after).toHaveLength(count + 1);
    expect(after.at(-1)).toEqual({ id: "test-1", source: 'test "New test"\n  expect applicant_name visible' });
    // The view edits the stored entry now, in the same box.
    expect(q(shadow, "[data-tests-view]").getAttribute("data-tests-editing")).toBe("test-1");
    click(shadow, "[data-tests-close]");
    click(shadow, "[data-tests-new]");
    expect(textarea(shadow).value).toBe('test "New test 2"\n  ');
    click(shadow, "[data-tests-apply]");
    expect(ctrl.tests()!.scenarios.at(-1)!.id).toBe("test-2");
  });

  it("Remove asks first in place (the warning note, Cancel first and focused), then removes the entry", () => {
    const { ctrl, shadow } = mount();
    click(shadow, '[data-tests-entry="main-2"]');
    click(shadow, "[data-tests-remove]");
    const note = q(shadow, ".note.confirm[data-tone='warning']");
    expect(note.querySelector("p")!.textContent).toBe(TESTS_PANEL_EN["tests.panel.remove.confirm"]);
    expect([...note.querySelectorAll(".confirm-actions > button")].map((button) => button.hasAttribute("data-tests-remove-cancel") ? "cancel" : button.hasAttribute("data-tests-remove-confirm") ? "remove" : "?")).toEqual(["cancel", "remove"]);
    expect(q(shadow, "[data-tests-remove-confirm]").textContent).toBe(TESTS_PANEL_EN["tests.panel.remove"]);
    expect(shadow.activeElement).toBe(q(shadow, "[data-tests-remove-cancel]"));
    click(shadow, "[data-tests-remove-cancel]");
    expect(shadow.querySelector("[data-tests-remove-confirm]")).toBeNull();
    click(shadow, "[data-tests-remove]");
    click(shadow, "[data-tests-remove-confirm]");
    expect(ctrl.tests()!.scenarios.map((entry) => entry.id)).not.toContain("main-2");
    expect(q(shadow, "[data-tests-view]").getAttribute("data-tests-view")).toBe("list");
  });

  it("Close with an unapplied edit asks; Discard goes back to the list; the shell's leave prompt is the panel's to draw", () => {
    const { ctrl, shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    type(shadow, `${textarea(shadow).value}\n  check`);
    click(shadow, "[data-tests-close]");
    expect(shadow.querySelector("[data-unsaved-prompt]")).not.toBeNull();
    click(shadow, "[data-unsaved-stay]");
    expect(shadow.querySelector("[data-unsaved-prompt]")).toBeNull();
    expect(q(shadow, "[data-tests-view]").getAttribute("data-tests-view")).toBe("editor");

    let left = false;
    expect(ctrl.requestLeave(() => (left = true))).toBe(false);
    expect(ctrl.unsavedChangesPrompt()?.external?.id).toBe("tests-panel");
    expect(shadow.querySelector("[data-unsaved-prompt]")).not.toBeNull();
    click(shadow, "[data-unsaved-discard]");
    expect(left).toBe(true);
    expect(q(shadow, "[data-tests-view]").getAttribute("data-tests-view")).toBe("list");
    expect(ctrl.hasPendingLeaveGuard()).toBe(false);
  });

  it("swaps the CodeMirror editor in for the box when its chunk lands, keeping the text, and keeps the box when it fails", async () => {
    // jsdom has no layout: CodeMirror's reads of a Range's rects and its execCommand probe are stubbed, as the editor's own tests do.
    const restore: Array<() => void> = [];
    const range = Range.prototype as unknown as Record<string, unknown>;
    for (const name of ["getClientRects", "getBoundingClientRect"]) {
      if (typeof range[name] !== "function") {
        range[name] = name === "getClientRects" ? () => [] : () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
        restore.push(() => delete range[name]);
      }
    }
    const document_ = document as unknown as Record<string, unknown>;
    if (typeof document_.execCommand !== "function") {
      document_.execCommand = () => false;
      restore.push(() => delete document_.execCommand);
    }
    onTestFinished(() => {
      for (const undo of restore.splice(0)) {
        undo();
      }
    });
    const { el, shadow } = mount();
    el.testsEditorLoader = () => import("../form-engine/builder/form-tests/tests-editor-loader.js").then((module) => module.loadTestsEditor());
    click(shadow, '[data-tests-entry="main-1"]');
    expect(q(shadow, "[data-tests-editor]").getAttribute("data-tests-editor")).toBe("textarea");
    const typed = `${textarea(shadow).value}\n  check`;
    type(shadow, typed);
    vi.useRealTimers();
    for (let i = 0; i < 200 && shadow.querySelector('[data-tests-editor="codemirror"]') === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(shadow.querySelectorAll("[data-tests-editor]")).toHaveLength(1);
    expect(q(shadow, "[data-tests-editor]").getAttribute("data-tests-editor")).toBe("codemirror");
    expect(q(shadow, ".cm-content").textContent).toContain("check");
    expect(el.dirty).toBe(true);
    vi.useFakeTimers();

    click(shadow, "[data-tests-close]");
    click(shadow, "[data-unsaved-discard]");
    el.testsEditorLoader = () => Promise.reject(new Error("offline"));
    click(shadow, '[data-tests-entry="main-1"]');
    await vi.advanceTimersByTimeAsync(10);
    expect(q(shadow, "[data-tests-editor]").getAttribute("data-tests-editor")).toBe("textarea");
  });

  it("walks the Add step menu with the arrow keys and closes it with Escape, back on its button", () => {
    const { shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    q(shadow, "[data-tests-add-step]").focus();
    q(shadow, "[data-tests-add-step]").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const items = [...shadow.querySelectorAll<HTMLElement>("[data-tests-add-menu] [role=menuitem]")];
    expect(items.length).toBeGreaterThan(5);
    expect(shadow.activeElement).toBe(items[0]);
    items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(shadow.activeElement).toBe(items[1]);
    items[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(shadow.activeElement).toBe(items.at(-1));
    items.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(shadow.activeElement).toBe(items[0]);
    items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(shadow.querySelector("[data-tests-add-menu]")).toBeNull();
    expect(shadow.activeElement).toBe(q(shadow, "[data-tests-add-step]"));
  });

  it("Add step inserts the chosen line for the picked field", () => {
    const { shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    click(shadow, "[data-tests-add-step]");
    expect(q(shadow, "[data-tests-add-step]").getAttribute("aria-expanded")).toBe("true");
    expect(q(shadow, "[data-tests-add-menu]").getAttribute("role")).toBe("menu");
    const select = q<HTMLSelectElement>(shadow, "[data-tests-add-field]");
    select.value = "age";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const item = q(shadow, '[data-tests-add-line="set age = 0"]');
    expect(item.getAttribute("role")).toBe("menuitem");
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(shadow.querySelector("[data-tests-add-menu]")).toBeNull();
    click(shadow, "[data-tests-add-step]");
    // The picked field is remembered while the editor is open.
    expect(q<HTMLSelectElement>(shadow, "[data-tests-add-field]").value).toBe("age");
    click(shadow, '[data-tests-add-line="expect error on age: required"]');
    expect(textarea(shadow).value).toContain("\n  expect error on age: required");
    expect(shadow.querySelector("[data-tests-add-menu]")).toBeNull();
  });
});

describe("a set on a path the form stores nothing at", () => {
  const TYPO = 'test "typo"\n  set applicant_nmae = "Ada"\n  expect applicant_name visible';

  it("is a warning beside the scenario, naming the path, and the scenario still runs", async () => {
    const { el, shadow, statuses } = mount({ scenarios: [{ id: "a", source: TYPO }] });
    click(shadow, "[data-tests-run-all]");
    await idle(el);
    // It ran: a lint is advice, never a parse problem or a verdict.
    expect(q(shadow, '[data-tests-entry="a"]').dataset.status).toBe("passed");
    expect(statuses.at(-1)!.summary.invalid).toBe(0);
    click(shadow, '[data-tests-entry="a"]');
    const lints = [...shadow.querySelectorAll<HTMLElement>("ul.tests-problems li [data-tests-lint]")];
    expect(lints).toHaveLength(1);
    expect(lints[0]!.getAttribute("data-tests-lint")).toBe("tests.set.unknownPath");
    expect(lints[0]!.getAttribute("data-severity")).toBe("warning");
    expect(lints[0]!.getAttribute("data-tests-problem")).toBe("2");
    expect(lints[0]!.textContent).toBe("Line 2: No field stores an answer at applicant_nmae, so the form keeps nothing there; the step still runs.");
    // Its button goes to the line, as a problem's does.
    expect(lints[0]!.getAttribute("title")).toBe("Go to line 2");
    // The box marks the line as a warning and says why; a warning never makes the text invalid.
    expect(q(shadow, '.tests-cell[data-line="2"]').getAttribute("data-problem")).toBe("warning");
    expect(q(shadow, '.tests-cell[data-line="3"]').hasAttribute("data-problem")).toBe(false);
    expect(q(shadow, ".tests-box").hasAttribute("data-invalid")).toBe(false);
    const described = q(shadow, ".tests-box textarea").getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(shadow.getElementById(described!)?.textContent).toContain("No field stores an answer at applicant_nmae");
  });

  it("goes when the form gains the path, and comes with an edit that names an unknown one", async () => {
    const { el, ctrl, shadow } = mount({ scenarios: [{ id: "a", source: TYPO }] });
    click(shadow, '[data-tests-entry="a"]');
    expect(shadow.querySelectorAll("[data-tests-lint]")).toHaveLength(1);
    ctrl.renameId("applicant_name", "applicant_nmae");
    expect(shadow.querySelectorAll("[data-tests-lint]")).toHaveLength(0);
    // A known path, a row index read as the collection's entries: no lint; an unknown one typed in: one, after the parse.
    type(shadow, 'test "typo"\n  set applicant_nmae = "Ada"\n  set items[0].qty = 1\n  set nobody = 1');
    await vi.advanceTimersByTimeAsync(150);
    const lints = [...shadow.querySelectorAll<HTMLElement>("[data-tests-lint]")];
    expect(lints.map((lint) => lint.getAttribute("data-tests-problem"))).toEqual(["4"]);
    expect(lints[0]!.textContent).toContain("nobody");
    await idle(el);
  });

  it("lists nothing for a scenario whose every set names a field", () => {
    const { shadow } = mount({ scenarios: [{ id: "a", source: 'test "fine"\n  set applicant_name = "Ada"' }] });
    click(shadow, '[data-tests-entry="a"]');
    expect(shadow.querySelector("[data-tests-lint]")).toBeNull();
    expect(shadow.querySelector("ul.tests-problems")).toBeNull();
  });
});

describe("a failure", () => {
  it("shows the card with the worded sentence and both sides; Accept new behaviour rewrites the line in one undo step", async () => {
    const { el, ctrl, shadow } = mount();
    click(shadow, "[data-tests-run-all]");
    await idle(el);
    const id = idOf(FORM_TESTS_FAILING_SCENARIO);
    const before = ctrl.tests()!.scenarios.find((entry) => entry.id === id)!.source;
    click(shadow, `[data-tests-entry="${id}"]`);
    const card = q(shadow, "[data-tests-failure]");
    expect(card.querySelector(".wt")?.textContent).toContain("Line 2");
    expect(card.querySelector(".wt")?.textContent).toMatch(/Name/);
    expect(q(shadow, "[data-tests-expected]").textContent).not.toBe("");
    expect(q(shadow, "[data-tests-actual]").textContent).not.toBe("");
    // The name is required by its settings, not by a rule: nothing to open.
    expect(shadow.querySelector("[data-tests-open-rule]")).toBeNull();
    // No canvas takes a step here (a shell without Try it): Show me is not offered.
    expect(shadow.querySelector("[data-tests-show]")).toBeNull();
    expect(shadow.querySelector('.tests-cell[data-line="2"][data-status="failed"]')).not.toBeNull();

    click(shadow, "[data-tests-accept]");
    const after = ctrl.tests()!.scenarios.find((entry) => entry.id === id)!.source;
    expect(after.split("\n")[1]).toBe("  expect applicant_name required");
    expect(textarea(shadow).value).toBe(after);
    ctrl.undo();
    expect(ctrl.tests()!.scenarios.find((entry) => entry.id === id)!.source).toBe(before);
    expect(textarea(shadow).value).toBe(before);
    expect(el.dirty).toBe(false);
    await idle(el);
  });

  it("offers Open rule when the target has the rule, and Show me walks the steps on the canvas", async () => {
    const { el, ctrl, shadow } = mount({ scenarios: [{ id: "email", source: EMAIL_SOURCE }] });
    const shown: Array<CanvasScenarioShowing | undefined> = [];
    el.showOnCanvas = (showing) => shown.push(showing);
    const opened: BuilderTestsOpenRuleDetail[] = [];
    el.addEventListener("builder-tests-open-rule", (event) => opened.push((event as CustomEvent<BuilderTestsOpenRuleDetail>).detail));
    click(shadow, "[data-tests-run-all]");
    await idle(el);
    click(shadow, '[data-tests-entry="email"]');
    click(shadow, "[data-tests-open-rule]");
    expect(opened).toEqual([{ componentId: "email", kind: "requiredWhen" }]);

    click(shadow, "[data-tests-show]");
    await until(() => shown.length === 1);
    const first = shown[0]!;
    expect(first).toMatchObject({ name: "email follows the way to reach you", step: 2, steps: 3, line: 3 });
    expect(first.values.contact_method).toBe("phone");
    first.onStep(1);
    await until(() => shown.length === 2);
    expect(shown[1]).toMatchObject({ step: 3, line: 4 });
    expect(shown[1]!.values.applicant_name).toBe("Ada");
    shown[1]!.onStop();
    expect(shown[2]).toBeUndefined();
    expect(shown).toHaveLength(3);

    click(shadow, "[data-tests-show]");
    await until(() => shown.length === 4);
    // Try it taking the side column away hides the panel; that alone ends nothing (the shell decides).
    el.hidden = true;
    expect(shown).toHaveLength(4);
    ctrl.setDraftProperty("age", "label", "Years");
    ctrl.commitDraft("age");
    expect(shown).toHaveLength(5);
    expect(shown[4]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(400);
    await idle(el);
  });
});

/** A four-step scenario failing at its second step (line 3), for the Show me cases. */
const EMAIL_FOUR = `${EMAIL_SOURCE}\n  set age = 30`;

async function failingEditor(source = EMAIL_FOUR): Promise<Mounted & { shown: Array<CanvasScenarioShowing | undefined> }> {
  const mounted = mount({ scenarios: [{ id: "email", source }] });
  const shown: Array<CanvasScenarioShowing | undefined> = [];
  mounted.el.showOnCanvas = (showing) => shown.push(showing);
  click(mounted.shadow, "[data-tests-run-all]");
  await idle(mounted.el);
  click(mounted.shadow, '[data-tests-entry="email"]');
  return { ...mounted, shown };
}

describe("Show me while a replay is on its way", () => {
  it("shows nothing when the editor is closed before the replay lands", async () => {
    const { shadow, shown } = await failingEditor();
    click(shadow, "[data-tests-show]");
    click(shadow, "[data-tests-close]");
    await vi.advanceTimersByTimeAsync(500);
    expect(shown).toEqual([]);
  });

  it("builds a second quick Step forward on the first, and shows only the last", async () => {
    const { el, shown } = await failingEditor();
    el.shadowRoot!.querySelector<HTMLElement>("[data-tests-show]")!.click();
    await until(() => shown.length === 1);
    expect(shown[0]).toMatchObject({ step: 2, steps: 4 });
    shown[0]!.onStep(1);
    shown[0]!.onStep(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(shown.map((showing) => showing?.step)).toEqual([2, 4]);
  });

  it("Stop showing takes back the status line it put up", async () => {
    const { shadow, shown } = await failingEditor();
    click(shadow, "[data-tests-show]");
    await until(() => shown.length === 1);
    expect(q(shadow, "[data-tests-status]").textContent).toBe("Line 3 shown on the form.");
    shown[0]!.onStop();
    expect(q(shadow, "[data-tests-status]").textContent).toBe("");
  });

  it("keeps the last state on a step that cannot be replayed, says why in words, and tells the bar", async () => {
    const { el, shadow, shown, definition } = await failingEditor();
    click(shadow, "[data-tests-show]");
    await until(() => shown.length === 1);
    el.definition = () => {
      throw new Error("the host's definition is gone");
    };
    shown[0]!.onStep(1);
    await until(() => shown.length === 2);
    const status = q(shadow, "[data-tests-status]").textContent ?? "";
    expect(status).toMatch(/^Step 3 could not be shown: /);
    expect(status).not.toContain("scenario.driverFailed");
    // The state on show is the step-2 one, with the bar's note.
    expect(shown[1]).toMatchObject({ step: 2, note: status });
    el.definition = () => ({ ...definition, root: (el.controller as BuilderController).snapshot() });
  });

  it("hands the givens to the canvas to apply or name, and the rows over", async () => {
    const source = [
      'test "rows and host"',
      '  given host.role = "admin"',
      '  given today = @"2026-03-01"',
      '  given locale = "fr"',
      '  given options for province = ("ON", "QC")',
      "  given journey = none",
      "  add row to items",
      "  expect applicant_name optional"
    ].join("\n");
    const { shadow, shown } = await failingEditor(source);
    click(shadow, "[data-tests-show]");
    await until(() => shown.length === 1);
    // The note is the canvas's now: it names what it cannot apply. The panel hands every given over.
    expect(shown[0]!.note).toBeUndefined();
    expect(shown[0]!.givens).toEqual({ host: { role: "admin" }, today: "2026-03-01", locale: "fr", options: { province: ["ON", "QC"] } });
    expect(shown[0]!.rows?.items).toBe(1);
  });

  it("hands over no givens for a scenario that gives only its journey", async () => {
    const { shadow, shown } = await failingEditor();
    click(shadow, "[data-tests-show]");
    await until(() => shown.length === 1);
    expect(shown[0]!.givens).toBeUndefined();
  });
});

describe("runs and the panel's life", () => {
  it("does not restart a run on a still moment that changed nothing it reads", async () => {
    const { el, ctrl, shadow } = mount();
    click(shadow, "[data-tests-run-all]");
    expect(el.runsStarted).toBe(1);
    // An inspector keystroke is an edit of a draft: the committed form, which the run reads, has not moved.
    ctrl.setDraftProperty("age", "label", "Years");
    vi.advanceTimersByTime(400);
    expect(el.runsStarted).toBe(1);
    await idle(el);
  });

  it("stops running and painting when detached, and holds the prompt again when put back", async () => {
    const { el, ctrl, shadow } = mount();
    click(shadow, "[data-tests-run-all]");
    el.remove();
    await idle(el);
    expect(el.entriesShown.every((entry) => entry.result === undefined)).toBe(true);
    document.body.append(el);
    click(shadow, '[data-tests-entry="main-1"]');
    type(shadow, `${textarea(shadow).value}\n  check`);
    expect(ctrl.hasPendingLeaveGuard()).toBe(true);
    el.remove();
    expect(ctrl.hasPendingLeaveGuard()).toBe(false);
    document.body.append(el);
    expect(ctrl.hasPendingLeaveGuard()).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    await idle(el);
  });

  it("says how long ago it ran as it is when opened again", async () => {
    const { el, shadow } = mount();
    click(shadow, "[data-tests-run-all]");
    await idle(el);
    expect(q(shadow, "[data-tests-summary]").textContent).toMatch(/^Ran just now/);
    el.hidden = true;
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    el.hidden = false;
    expect(q(shadow, "[data-tests-summary]").textContent).toMatch(/^Ran 3 min ago/);
  });
});

describe("the leave guard beside Logic's", () => {
  const logicGuard = (pending: boolean) => ({
    pending: () => pending,
    subject: () => ({ id: "logic-rule", label: "Rule", blocked: false }),
    save: vi.fn(() => true),
    discard: vi.fn()
  });

  it("survives the Logic surface setting and clearing the slot, and a leave saves both", () => {
    const { ctrl, shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    const stored = ctrl.tests()!.scenarios[0]!.source;
    type(shadow, `${stored}\n  check`);
    // Logic connects (Open rule does this) and goes again.
    ctrl.setLeaveGuard(logicGuard(false));
    ctrl.setLeaveGuard(undefined);
    expect(ctrl.hasPendingLeaveGuard()).toBe(true);
    const logic = logicGuard(true);
    ctrl.setLeaveGuard(logic);
    let left = false;
    expect(ctrl.requestLeave(() => (left = true))).toBe(false);
    expect(ctrl.unsavedChangesPrompt()?.external?.id).toBe("tests-panel");
    click(shadow, "[data-unsaved-save]");
    expect(left).toBe(true);
    expect(ctrl.tests()!.scenarios[0]!.source).toBe(`${stored}\n  check`);
    expect(logic.save).toHaveBeenCalledTimes(1);
  });

  it("asks the shell to open the closed panel that holds the prompt", () => {
    const { el, ctrl, shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    type(shadow, `${textarea(shadow).value}\n  check`);
    const reveals: Event[] = [];
    el.addEventListener("builder-tests-reveal", (event) => reveals.push(event));
    el.hidden = true;
    ctrl.requestLeave(() => undefined);
    expect(reveals).toHaveLength(1);
  });
});

describe("what a screen reader hears, and where focus goes", () => {
  it("keeps one live region across the views, says a run's outcome there, and patches a focused row in place", async () => {
    const { el, shadow } = mount();
    const region = q(shadow, "[data-tests-status]");
    const row = q(shadow, '[data-tests-entry="main-2"]');
    row.focus();
    click(shadow, "[data-tests-run-all]");
    row.focus();
    await idle(el);
    expect(q(shadow, '[data-tests-entry="main-2"]')).toBe(row);
    expect(shadow.activeElement).toBe(row);
    expect(row.dataset.status).not.toBe("unrun");
    expect(region.textContent).toMatch(/^Ran just now · /);
    click(shadow, '[data-tests-entry="main-2"]');
    click(shadow, "[data-tests-remove]");
    click(shadow, "[data-tests-remove-confirm]");
    expect(q(shadow, "[data-tests-status]")).toBe(region);
    expect(region.textContent).toMatch(/^Removed /);
    await vi.advanceTimersByTimeAsync(400);
    await idle(el);
  });

  it("names an entry nothing names from the catalog", () => {
    const { shadow } = mount({ scenarios: [{ id: "blank", source: "  " }] });
    expect(q(shadow, '[data-tests-entry="blank"] .tests-entry-name').textContent).toBe(TESTS_PANEL_EN["tests.panel.untitled"]);
  });

  it("puts the Add step menu away when focus leaves it for another control", async () => {
    const { shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    click(shadow, "[data-tests-add-step]");
    const first = q(shadow, "[data-tests-add-menu] [role=menuitem]");
    first.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: q(shadow, "[data-tests-reference]") }));
    await Promise.resolve();
    expect(shadow.querySelector("[data-tests-add-menu]")).toBeNull();
  });
});

describe("Open rule without Logic", () => {
  it("is not drawn when the shell says there is no Logic to go to", async () => {
    const { el, shadow } = await failingEditor();
    expect(shadow.querySelector("[data-tests-open-rule]")).not.toBeNull();
    el.openRuleAvailable = false;
    expect(shadow.querySelector("[data-tests-open-rule]")).toBeNull();
  });
});

describe("the module", () => {
  it("re-exports the rename seam the shell calls", () => {
    expect(typeof renameInTests).toBe("function");
    const renamed = renameInTests({ scenarios: [{ id: "a", source: 'test "a"\n  set age = 1' }] }, "age", "years", []);
    expect(renamed?.scenarios[0]?.source).toBe('test "a"\n  set years = 1');
  });
});

// --- Record, Assert this, the Untested view, Write a test, the shown mark ----------------

const NOTHING_SHOWN: TestsAssertSnapshot = { fields: [] };

/** A stand-in for the real canvas: `recordTry` turns Try it on (a snapshot appears) and hands back its stop. */
function fakeCanvas(initial?: TestsAssertSnapshot) {
  const canvas = {
    listener: undefined as TestsRecordListener | undefined,
    stops: 0,
    current: initial as TestsAssertSnapshot | undefined,
    record: (listener: TestsRecordListener): (() => void) => {
      canvas.listener = listener;
      canvas.current ??= NOTHING_SHOWN;
      return () => {
        canvas.stops += 1;
        canvas.listener = undefined;
      };
    },
    snapshot: (): TestsAssertSnapshot | undefined => canvas.current,
    emit(event: TestsRecordEvent): void {
      canvas.listener?.(event);
    }
  };
  return canvas;
}

/**
 * The canvas as it is when Try it was off and its chunk is still on the way: `recordTry`
 * returns with no snapshot to give; the test sets `current` when the chunk "arrives".
 */
function lateCanvas() {
  const canvas = fakeCanvas();
  canvas.record = (listener: TestsRecordListener): (() => void) => {
    canvas.listener = listener;
    return () => {
      canvas.stops += 1;
      canvas.listener = undefined;
    };
  };
  return canvas;
}

/** A panel with Run as I edit off (no run's words in the status line), the fake canvas wired, editing entry `a`. */
function recordingPanel(source = 'test "a"\n  set age = 30\n\n', initial?: TestsAssertSnapshot, form: "main" | "clock" = "main", canvas: ReturnType<typeof fakeCanvas> = fakeCanvas(initial)) {
  localStorage.setItem(TESTS_RUN_AS_I_EDIT_KEY, "false");
  const mounted = mount({ scenarios: [{ id: "a", source }] }, undefined, form);
  mounted.el.recordOnCanvas = canvas.record;
  mounted.el.assertSnapshot = canvas.snapshot;
  click(mounted.shadow, '[data-tests-entry="a"]');
  return { ...mounted, canvas };
}

const status = (shadow: ShadowRoot): string => q(shadow, "[data-tests-status]").textContent ?? "";

describe("Record", () => {
  it("writes each settled event as a line after the test's last line, in order, in the language's literals", () => {
    const { el, ctrl, shadow, canvas } = recordingPanel();
    expect(shadow.querySelector("[data-tests-record]")?.textContent).toContain(TESTS_PANEL_EN["tests.panel.record"]);
    click(shadow, "[data-tests-record]");
    expect(el.recording).toBe(true);
    expect(canvas.listener).toBeDefined();
    const button = q(shadow, "[data-tests-record]");
    // One signal: the label changes, as the bar's control does; no pressed state besides it.
    expect(button.hasAttribute("aria-pressed")).toBe(false);
    expect(button.textContent).toBe(TESTS_PANEL_EN["tests.panel.record.stop"]);
    expect(button.hasAttribute("data-recording")).toBe(true);
    for (const event of [
      { kind: "set", componentId: "applicant_name", path: "applicant_name", value: "Ada" },
      { kind: "set", componentId: "topics", path: "topics", value: { news: true, offers: false, events: true } },
      { kind: "addRow", componentId: "items", collection: "items", count: 1 },
      { kind: "set", componentId: "qty", path: "items[0].qty", value: 2 },
      { kind: "set", componentId: "age", path: "age", value: null },
      { kind: "continue" },
      { kind: "goTo", page: "contact" },
      { kind: "back" },
      { kind: "check" },
      { kind: "submit", accepted: false }
    ] as TestsRecordEvent[]) {
      canvas.emit(event);
    }
    expect(textarea(shadow).value).toBe(
      [
        'test "a"',
        "  set age = 30",
        '  set applicant_name = "Ada"',
        '  set topics = ("news", "events")',
        "  add row to items",
        "  set items[0].qty = 2",
        "  clear age",
        "  continue",
        "  go to contact",
        "  back",
        "  check",
        "  submit",
        "",
        ""
      ].join("\n")
    );
    expect(status(shadow)).toBe("Recording · 10 lines");
    expect(q(shadow, "[data-tests-recording]").textContent).toBe("Recording · 10 lines");
    expect(el.dirty).toBe(true);
    // The lines are the box's own edit: Apply saves them, in one undo step.
    click(shadow, "[data-tests-apply]");
    expect(ctrl.tests()!.scenarios[0]!.source).toBe(textarea(shadow).value);
    expect(el.recording).toBe(true);
  });

  it("records nothing for a row removal and says so once", () => {
    const { shadow, canvas } = recordingPanel();
    click(shadow, "[data-tests-record]");
    const before = textarea(shadow).value;
    canvas.emit({ kind: "removeRow", componentId: "items", collection: "items", count: 0 });
    expect(textarea(shadow).value).toBe(before);
    expect(status(shadow)).toBe(TESTS_PANEL_EN["tests.panel.record.removeRow"]);
    canvas.emit({ kind: "continue" });
    expect(status(shadow)).toBe("Recording · 1 line");
    canvas.emit({ kind: "removeRow", componentId: "items", collection: "items", count: 0 });
    expect(status(shadow)).toBe("Recording · 1 line");
    canvas.emit({ kind: "set", componentId: "x", path: "nowhere", value: 1 });
    expect(status(shadow)).toBe(TESTS_PANEL_EN["tests.panel.record.refused.path"]);
  });

  it("ends on its own Stop, telling the canvas once; later events write nothing", () => {
    const { el, shadow, canvas } = recordingPanel();
    click(shadow, "[data-tests-record]");
    const listener = canvas.listener!;
    canvas.emit({ kind: "continue" });
    click(shadow, "[data-tests-record]");
    expect(el.recording).toBe(false);
    expect(canvas.stops).toBe(1);
    expect(status(shadow)).toBe("Recording stopped · 1 line added. Apply saves it.");
    const text = textarea(shadow).value;
    listener({ kind: "back" });
    expect(textarea(shadow).value).toBe(text);
    expect(q(shadow, "[data-tests-record]").textContent).toBe(TESTS_PANEL_EN["tests.panel.record"]);
    expect(q(shadow, "[data-tests-record]").hasAttribute("aria-pressed")).toBe(false);
    expect(q(shadow, "[data-tests-record]").hasAttribute("data-recording")).toBe(false);
    expect(shadow.querySelector("[data-tests-recording]")).toBeNull();
  });

  it("ends on Close and on a disconnect, telling the canvas each time", async () => {
    const run = recordingPanel();
    click(run.shadow, "[data-tests-record]");
    click(run.shadow, "[data-tests-close]");
    expect(run.el.recording).toBe(false);
    expect(run.canvas.stops).toBe(1);
    click(run.shadow, '[data-tests-entry="a"]');
    click(run.shadow, "[data-tests-record]");
    click(run.shadow, "[data-tests-close]");
    click(run.shadow, "[data-tests-run-all]");
    expect(run.canvas.stops).toBe(2);
    await idle(run.el);
    click(run.shadow, '[data-tests-entry="a"]');
    click(run.shadow, "[data-tests-record]");
    run.el.remove();
    expect(run.el.recording).toBe(false);
    expect(run.canvas.stops).toBe(3);
  });

  it("keeps recording through the form's opening run and Apply's run while the editor stays open", async () => {
    // Run as I edit on, Record pressed before the opening run's debounce is up (the builder
    // harness's cold sequence): neither run ends the recording, and the lines keep coming.
    const { el, shadow } = mount({ scenarios: [{ id: "a", source: 'test "a"\n  set age = 30' }] });
    const canvas = fakeCanvas();
    el.recordOnCanvas = canvas.record;
    el.assertSnapshot = canvas.snapshot;
    click(shadow, '[data-tests-entry="a"]');
    click(shadow, "[data-tests-record]");
    expect(el.recording).toBe(true);
    const before = el.runsStarted;
    await vi.advanceTimersByTimeAsync(400);
    expect(el.runsStarted).toBe(before + 1);
    await idle(el);
    expect(el.recording).toBe(true);
    expect(q(shadow, "[data-tests-record]").textContent).toBe(TESTS_PANEL_EN["tests.panel.record.stop"]);
    canvas.emit({ kind: "continue" });
    click(shadow, "[data-tests-apply]");
    expect(el.recording).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(el.runsStarted).toBe(before + 2);
    expect(el.recording).toBe(true);
    canvas.emit({ kind: "back" });
    expect(textarea(shadow).value).toContain("  back");
    await idle(el);
    expect(el.recording).toBe(true);
    expect(canvas.stops).toBe(0);
  });

  it("follows the canvas ending it (Back to editing) through the shell's stopRecording, and never reads the canvas on a paint", () => {
    const { el, shadow, canvas } = recordingPanel();
    let reads = 0;
    el.assertSnapshot = () => {
      reads += 1;
      return canvas.current;
    };
    click(shadow, "[data-tests-record]");
    reads = 0;
    // A paint while recording (the parse debounce after a typed line, a hide and show): the
    // canvas's snapshot sends what it holds back, so a paint must not ask for one.
    el.hidden = true;
    el.hidden = false;
    canvas.emit({ kind: "continue" });
    expect(reads).toBe(1);
    canvas.current = undefined;
    el.stopRecording();
    expect(el.recording).toBe(false);
    expect(canvas.stops).toBe(1);
    el.stopRecording();
    expect(canvas.stops).toBe(1);
    expect(q(shadow, "[data-tests-record]").textContent).toBe(TESTS_PANEL_EN["tests.panel.record"]);
  });

  it("writes the answer the canvas sends while it is told to stop, and stops it once though the stop echoes back", () => {
    const { el, shadow, canvas } = recordingPanel();
    // The canvas's stop sends the answer still held back (focus in the field), then says the
    // recording ended, which the shell turns into stopRecording.
    el.recordOnCanvas = (listener) => {
      canvas.listener = listener;
      return () => {
        canvas.stops += 1;
        listener({ kind: "set", componentId: "applicant_name", path: "applicant_name", value: "Ada" });
        el.stopRecording();
        canvas.listener = undefined;
      };
    };
    click(shadow, "[data-tests-record]");
    expect(el.recording).toBe(true);
    click(shadow, "[data-tests-record]");
    expect(el.recording).toBe(false);
    expect(canvas.stops).toBe(1);
    expect(textarea(shadow).value).toContain('  set applicant_name = "Ada"');
    expect(status(shadow)).toBe("Recording stopped · 1 line added. Apply saves it.");
  });

  it("ends when the shell takes the canvas's Record away, and offers Record only while it is lent", () => {
    const { el, shadow, canvas } = recordingPanel();
    click(shadow, "[data-tests-record]");
    el.recordOnCanvas = undefined;
    expect(el.recording).toBe(false);
    expect(canvas.stops).toBe(1);
    expect(shadow.querySelector("[data-tests-record]")).toBeNull();
    click(shadow, "[data-tests-close]");
    expect(shadow.querySelector("[data-tests-record-new]")).toBeNull();
  });

  it("Record a test opens a new working entry named Recorded <n> and records into it", () => {
    localStorage.setItem(TESTS_RUN_AS_I_EDIT_KEY, "false");
    const { el, ctrl, shadow } = mount({ scenarios: [{ id: "a", source: 'test "Recorded 1"\n  set age = 1' }] });
    const canvas = fakeCanvas();
    el.recordOnCanvas = canvas.record;
    el.assertSnapshot = canvas.snapshot;
    click(shadow, "[data-tests-record-new]");
    expect(el.recording).toBe(true);
    expect(q(shadow, "[data-tests-name]").textContent).toBe("Recorded 2");
    canvas.emit({ kind: "set", componentId: "age", path: "age", value: 30 });
    canvas.emit({ kind: "continue" });
    expect(textarea(shadow).value).toBe('test "Recorded 2"\n  set age = 30\n  continue\n  ');
    click(shadow, "[data-tests-apply]");
    expect(ctrl.tests()!.scenarios.map((entry) => entry.id)).toEqual(["a", "test-1"]);
    expect(ctrl.tests()!.scenarios[1]!.source).toBe('test "Recorded 2"\n  set age = 30\n  continue\n  ');
  });
});

describe("Record's given today lead line", () => {
  const CLOCK_SOURCE = 'test "a"\n  set event_date = @"2026-04-01"\n\n';

  it("leads a test of a form that reads the clock with the day Try it runs on, under the header, before any recorded line", () => {
    const { el, shadow, canvas } = recordingPanel(CLOCK_SOURCE, { fields: [], today: "2026-03-01" }, "clock");
    click(shadow, "[data-tests-record]");
    expect(textarea(shadow).value).toBe('test "a"\n  given today = @"2026-03-01"\n  set event_date = @"2026-04-01"\n\n');
    canvas.emit({ kind: "check" });
    expect(textarea(shadow).value).toBe('test "a"\n  given today = @"2026-03-01"\n  set event_date = @"2026-04-01"\n  check\n\n');
    expect(status(shadow)).toBe("Recording · 2 lines");
    expect(shadow.querySelector("[data-tests-record-no-day]")).toBeNull();
    // The lines parse: the given before the first step, as the language wants it.
    expect(el.dirty).toBe(true);
  });

  it("keeps a day the test already names, and writes none for a form that does not read the clock", () => {
    const named = recordingPanel('test "a"\n  given today = @"2025-01-01"\n  set event_date = @"2026-04-01"\n', { fields: [], today: "2026-03-01" }, "clock");
    click(named.shadow, "[data-tests-record]");
    expect(textarea(named.shadow).value).toBe('test "a"\n  given today = @"2025-01-01"\n  set event_date = @"2026-04-01"\n');
    named.el.remove();
    const plain = recordingPanel(undefined, { fields: [], today: "2026-03-01" });
    click(plain.shadow, "[data-tests-record]");
    expect(textarea(plain.shadow).value).toBe('test "a"\n  set age = 30\n\n');
  });

  it("says once that the day was not recorded when the canvas cannot say it (a session's runtime), and keeps it in view", () => {
    const { shadow, canvas } = recordingPanel(CLOCK_SOURCE, { fields: [] }, "clock");
    click(shadow, "[data-tests-record]");
    expect(textarea(shadow).value).toBe(CLOCK_SOURCE);
    expect(status(shadow)).toBe(`${TESTS_PANEL_EN["tests.panel.record.started"]} ${TESTS_PANEL_EN["tests.panel.record.noDay"]}`);
    expect(q(shadow, "[data-tests-record-no-day]").textContent).toBe(TESTS_PANEL_EN["tests.panel.record.noDay"]);
    canvas.emit({ kind: "check" });
    expect(status(shadow)).toBe("Recording · 1 line");
    expect(q(shadow, "[data-tests-record-no-day]").textContent).toBe(TESTS_PANEL_EN["tests.panel.record.noDay"]);
  });

  it("writes the line from the first snapshot the canvas gives when its chunk arrived after Record started", () => {
    const canvas = lateCanvas();
    const { shadow } = recordingPanel(CLOCK_SOURCE, undefined, "clock", canvas);
    click(shadow, "[data-tests-record]");
    expect(textarea(shadow).value).toBe(CLOCK_SOURCE);
    canvas.current = { fields: [], today: "2026-03-01" };
    canvas.emit({ kind: "check" });
    expect(textarea(shadow).value).toBe('test "a"\n  given today = @"2026-03-01"\n  set event_date = @"2026-04-01"\n  check\n\n');
    expect(status(shadow)).toBe("Recording · 2 lines");
  });

  it("says the day was not recorded with the first event when the late snapshot has none", () => {
    const canvas = lateCanvas();
    const { shadow } = recordingPanel(CLOCK_SOURCE, undefined, "clock", canvas);
    click(shadow, "[data-tests-record]");
    expect(status(shadow)).toBe(TESTS_PANEL_EN["tests.panel.record.started"]);
    canvas.current = { fields: [] };
    canvas.emit({ kind: "check" });
    expect(status(shadow)).toBe(`Recording · 1 line · ${TESTS_PANEL_EN["tests.panel.record.noDay"]}`);
    canvas.emit({ kind: "check" });
    expect(status(shadow)).toBe("Recording · 2 lines");
  });
});

function shownField(componentId: string, overrides: Partial<TestsAssertField> = {}): TestsAssertField {
  return { componentId, path: componentId, label: componentId, visible: true, required: false, enabled: true, readonly: false, errors: [], value: null, ...overrides };
}

describe("Assert this", () => {
  const before: TestsAssertSnapshot = { fields: [shownField("email", { label: "Email", required: true }), shownField("phone", { label: "Phone", visible: false }), shownField("age", { label: "Age" })], page: "contact" };
  const after: TestsAssertSnapshot = { fields: [shownField("email", { label: "Email" }), shownField("phone", { label: "Phone" }), shownField("age", { label: "Age" })], page: "contact", lastSubmit: "refused" };

  it("ticks the fields the last event changed and inserts the expected lines after the test's last line", () => {
    const { shadow, canvas } = recordingPanel(undefined, before);
    click(shadow, "[data-tests-record]");
    canvas.current = after;
    canvas.emit({ kind: "set", componentId: "contact_method", path: "contact_method", value: "phone" });
    click(shadow, "[data-tests-assert-open]");
    const pop = q(shadow, "[data-tests-assert]");
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.getAttribute("aria-modal")).toBe("false");
    expect(q(shadow, "[data-tests-assert-open]").getAttribute("aria-expanded")).toBe("true");
    const box = (id: string): HTMLInputElement => q<HTMLInputElement>(shadow, `[data-tests-assert-field="${id}"]`);
    expect([box("email").checked, box("phone").checked, box("age").checked]).toEqual([true, true, false]);
    // The page and the verdict are offered from the snapshot; the errors on show always.
    expect(shadow.querySelector('[data-tests-assert-extra="page"]')).not.toBeNull();
    expect(shadow.querySelector('[data-tests-assert-extra="verdict"]')).not.toBeNull();
    const verdict = q<HTMLInputElement>(shadow, '[data-tests-assert-extra="verdict"]');
    verdict.checked = true;
    verdict.dispatchEvent(new Event("change", { bubbles: true }));
    expect(q(shadow, "[data-tests-assert-insert]").textContent).toBe("Insert 4 lines");
    click(shadow, "[data-tests-assert-insert]");
    expect(shadow.querySelector("[data-tests-assert]")).toBeNull();
    expect(textarea(shadow).value).toBe(
      ['test "a"', "  set age = 30", '  set contact_method = "phone"', "  expect email optional", "  expect phone visible", "  expect no error on phone", "  expect refused", "", ""].join("\n")
    );
    expect(status(shadow)).toBe("4 lines added.");
    expect(shadow.activeElement).toBe(q(shadow, "[data-tests-assert-open]"));
  });

  it("narrows the fields by the search box, closes on Escape and on Cancel, focus back on Assert this", () => {
    const { shadow } = recordingPanel(undefined, after);
    click(shadow, "[data-tests-assert-open]");
    const search = q<HTMLInputElement>(shadow, "[data-tests-assert-search]");
    search.value = "ema";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const visible = [...shadow.querySelectorAll<HTMLLIElement>("[data-tests-assert-row]")].filter((row) => !row.hidden).map((row) => row.getAttribute("data-tests-assert-row"));
    expect(visible).toEqual(["email"]);
    // Ticking a field rewrites the popover, never the search text.
    const age = q<HTMLInputElement>(shadow, '[data-tests-assert-field="age"]');
    age.checked = true;
    age.dispatchEvent(new Event("change", { bubbles: true }));
    expect(q<HTMLInputElement>(shadow, "[data-tests-assert-search]").value).toBe("ema");
    expect(q(shadow, '[data-tests-assert-row="age"]').hidden).toBe(true);
    q(shadow, "[data-tests-assert-search]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(shadow.querySelector("[data-tests-assert]")).toBeNull();
    expect(shadow.activeElement).toBe(q(shadow, "[data-tests-assert-open]"));
    click(shadow, "[data-tests-assert-open]");
    click(shadow, "[data-tests-assert-cancel]");
    expect(shadow.querySelector("[data-tests-assert]")).toBeNull();
    expect(textarea(shadow).value).toBe('test "a"\n  set age = 30\n\n');
  });

  it("is offered only while Try it is on", () => {
    const { shadow, canvas } = recordingPanel();
    expect(shadow.querySelector("[data-tests-assert-open]")).toBeNull();
    canvas.current = after;
    click(shadow, "[data-tests-close]");
    click(shadow, '[data-tests-entry="a"]');
    expect(shadow.querySelector("[data-tests-assert-open]")).not.toBeNull();
  });

  it("ticks what the first step names when the canvas had no snapshot at the start, then what each later step moved", () => {
    const canvas = lateCanvas();
    const { shadow } = recordingPanel(undefined, undefined, "main", canvas);
    click(shadow, "[data-tests-record]");
    // The Try it chunk lands after record() returned: the snapshot appears only now, with the event in it.
    const phoneShown: TestsAssertSnapshot = { fields: [shownField("contact_method", { label: "How to reach you" }), shownField("phone", { label: "Phone" }), shownField("age", { label: "Age" })] };
    canvas.current = phoneShown;
    canvas.emit({ kind: "set", componentId: "contact_method", path: "contact_method", value: "phone" });
    click(shadow, "[data-tests-assert-open]");
    const ticked = (): Array<string | null> =>
      [...shadow.querySelectorAll<HTMLInputElement>("[data-tests-assert-field]")].filter((box) => box.checked).map((box) => box.getAttribute("data-tests-assert-field"));
    expect(ticked()).toEqual(["contact_method"]);
    expect(q(shadow, "[data-tests-assert-insert]").hasAttribute("disabled")).toBe(false);
    click(shadow, "[data-tests-assert-cancel]");
    // The second step has a before-state: what it moved is ticked, the field it names is not.
    canvas.current = { fields: [shownField("contact_method", { label: "How to reach you" }), shownField("phone", { label: "Phone", visible: false }), shownField("age", { label: "Age" })] };
    canvas.emit({ kind: "set", componentId: "contact_method", path: "contact_method", value: "email" });
    click(shadow, "[data-tests-assert-open]");
    expect(ticked()).toEqual(["phone"]);
  });

  it("takes the form before the first step when the canvas says its chunk arrived, so that step's reveal is ticked", () => {
    const canvas = lateCanvas();
    const { el, shadow } = recordingPanel(undefined, undefined, "main", canvas);
    click(shadow, "[data-tests-record]");
    // The chunk lands before any step: the shell hands the panel the canvas's `ready`.
    canvas.current = { fields: [shownField("contact_method", { label: "How to reach you" }), shownField("phone", { label: "Phone", visible: false }), shownField("age", { label: "Age" })] };
    el.recordingReady();
    canvas.current = { fields: [shownField("contact_method", { label: "How to reach you" }), shownField("phone", { label: "Phone" }), shownField("age", { label: "Age" })] };
    canvas.emit({ kind: "set", componentId: "contact_method", path: "contact_method", value: "phone" });
    click(shadow, "[data-tests-assert-open]");
    const ticked = [...shadow.querySelectorAll<HTMLInputElement>("[data-tests-assert-field]")].filter((box) => box.checked).map((box) => box.getAttribute("data-tests-assert-field"));
    expect(ticked).toEqual(["phone"]);
    // A second `ready` (or one after the first step) changes nothing.
    click(shadow, "[data-tests-assert-cancel]");
    canvas.current = { fields: [] };
    el.recordingReady();
    click(shadow, "[data-tests-assert-open]");
    expect(shadow.querySelectorAll("[data-tests-assert-field]").length).toBe(0);
  });

  it("asks the lent assertReady, not a whole snapshot, whether to offer Assert this on a paint", () => {
    const { el, shadow, canvas } = recordingPanel(undefined, after);
    let snapshots = 0;
    el.assertSnapshot = () => {
      snapshots += 1;
      return canvas.current;
    };
    let ready = false;
    el.assertReady = () => ready;
    click(shadow, "[data-tests-close]");
    click(shadow, '[data-tests-entry="a"]');
    expect(shadow.querySelector("[data-tests-assert-open]")).toBeNull();
    ready = true;
    click(shadow, "[data-tests-close]");
    click(shadow, '[data-tests-entry="a"]');
    expect(shadow.querySelector("[data-tests-assert-open]")).not.toBeNull();
    expect(snapshots).toBe(0);
    click(shadow, "[data-tests-assert-open]");
    expect(snapshots).toBe(1);
  });

  it("keys the rows of one repeating field by path: a tick on the second leaves the first, keeps the focus, and writes one line", () => {
    const rows: TestsAssertSnapshot = {
      fields: [shownField("qty", { path: "items[0].qty", label: "Quantity" }), shownField("qty", { path: "items[1].qty", label: "Quantity", visible: false })]
    };
    const { shadow } = recordingPanel(undefined, rows);
    click(shadow, "[data-tests-assert-open]");
    expect([...shadow.querySelectorAll("[data-tests-assert-row]")].map((row) => row.getAttribute("data-tests-assert-row"))).toEqual(["items[0].qty", "items[1].qty"]);
    const second = q<HTMLInputElement>(shadow, '[data-tests-assert-field="items[1].qty"]');
    second.focus();
    second.checked = true;
    second.dispatchEvent(new Event("change", { bubbles: true }));
    const box = (path: string): HTMLInputElement => q<HTMLInputElement>(shadow, `[data-tests-assert-field="${path}"]`);
    expect(box("items[0].qty").checked).toBe(false);
    expect(box("items[1].qty").checked).toBe(true);
    expect(shadow.activeElement).toBe(box("items[1].qty"));
    expect(q(shadow, "[data-tests-assert-insert]").textContent).toBe("Insert 1 line");
    click(shadow, "[data-tests-assert-insert]");
    expect(textarea(shadow).value).toBe('test "a"\n  set age = 30\n  expect items[1].qty hidden\n\n');
  });
});

/** One scenario that pins the phone's visibility rule and nothing else. */
const PHONE_PIN = 'test "phone"\n  given journey = none\n  set contact_method = "phone"\n  expect phone visible';

describe("the rules and their tests", () => {
  it("words the rules' sentences in the builder's language, as the Logic workspace does", () => {
    const catalog = { fr: { "rule.show.when": "Afficher {target} quand {condition}", "cond.eq": "{field} vaut {value}" } };
    const { el, ctrl, shadow, definition } = mount({ scenarios: [{ id: "p", source: PHONE_PIN }] }, (panel) => {
      panel.textLocale = "fr";
      panel.textCatalog = catalog;
    });
    click(shadow, "[data-tests-untested]");
    const phone = untestedRules(ctrl.snapshot(), definition, el.entriesShown, [], { locale: "fr", catalog }).rules.find((rule) => rule.kind === "show" && rule.target.id === "phone")!;
    expect(phone.sentence).toMatch(/^Afficher .+ quand .+ vaut /);
    const row = q(shadow, `[data-tests-rule="${phone.id}"]`);
    expect(row.querySelector(".tests-rule-text")?.textContent).toContain(phone.sentence);
    // The catalog-less reading (the command line's) stays English.
    expect(untestedRules(ctrl.snapshot(), definition, el.entriesShown, []).rules.find((rule) => rule.id === phone.id)!.sentence).toMatch(/^Show /);
  });

  it("counts the untested rules in the list's foot and lists every rule with its pins and Write a test", () => {
    const { el, ctrl, shadow, definition } = mount({ scenarios: [{ id: "p", source: PHONE_PIN }] });
    const entries = el.entriesShown;
    const expected = untestedRules(ctrl.snapshot(), definition, entries, []);
    expect(expected.tested).toBeGreaterThan(0);
    expect(expected.untested).toBeGreaterThan(0);
    expect(expected.rules.length).toBeGreaterThan(0);
    const line = q(shadow, "[data-tests-untested]").textContent ?? "";
    expect(line).toBe(`${expected.untested} of ${expected.rules.length} rules untested · Show`);
    click(shadow, "[data-tests-untested]");
    const rows = [...shadow.querySelectorAll<HTMLElement>("[data-tests-rule]")];
    expect(rows.map((row) => row.getAttribute("data-tests-rule"))).toEqual(expected.rules.map((rule) => rule.id));
    expect(rows.filter((row) => row.getAttribute("data-tested") === "false")).toHaveLength(expected.untested);
    const untested = rows.find((row) => row.getAttribute("data-tested") === "false")!;
    expect(untested.querySelector("[data-tests-rule-untested]")?.textContent).toBe(TESTS_PANEL_EN["tests.panel.untested.none"]);
    expect(rows.every((row) => row.querySelector("[data-tests-write-test]") !== null)).toBe(true);
    // A sentence that opens with its kind's verb does not say it twice ("Show Show ...").
    for (const row of rows) {
      const text = (row.querySelector(".tests-rule-text")?.textContent ?? "").toLowerCase();
      const [first, second] = text.split(/\s+/);
      expect(first !== undefined && first === second, text).toBe(false);
    }
    // A pin is a button that opens its entry in the editor.
    const pinned = rows.find((row) => row.getAttribute("data-tested") === "true")!;
    const pin = pinned.querySelector<HTMLElement>("[data-tests-open-entry]")!;
    const id = pin.getAttribute("data-tests-open-entry")!;
    expect(expected.pins.get(pinned.getAttribute("data-tests-rule")!)?.map((entry) => entry.id)).toContain(id);
    pin.click();
    expect(q(shadow, "[data-tests-view]").getAttribute("data-tests-editing")).toBe(id);
    click(shadow, "[data-tests-close]");
    click(shadow, "[data-tests-untested]");
    click(shadow, "[data-tests-untested-back]");
    expect(shadow.querySelector("[data-tests-entry]")).not.toBeNull();
  });

  it("recounts after a committed change of the block", () => {
    const { ctrl, shadow } = mount({ scenarios: [] });
    const line = (): string => q(shadow, "[data-tests-untested]").textContent ?? "";
    const before = line();
    ctrl.setTests({ scenarios: [{ id: "p", source: PHONE_PIN }] });
    expect(line()).not.toBe(before);
    const [untested, total] = before.match(/\d+/g)!.map(Number);
    expect(line()).toBe(`${untested! - 1} of ${total} rules untested · Show`);
  });

  it("Write a test appends the scaffold in one undo step, opens the first and runs it", async () => {
    const { el, ctrl, shadow } = mount({ scenarios: [] });
    await vi.advanceTimersByTimeAsync(400);
    await idle(el);
    const runs = el.runsStarted;
    click(shadow, "[data-tests-untested]");
    const row = shadow.querySelector<HTMLElement>('[data-tests-rule$=":phone:visibleWhen"]') ?? q(shadow, "[data-tests-rule]");
    click(shadow, `[data-tests-write-test="${row.getAttribute("data-tests-rule")}"]`);
    const written = ctrl.tests()!.scenarios;
    expect(written.length).toBeGreaterThan(0);
    expect(written.map((entry) => entry.id)).toEqual(written.map((_, at) => `test-${at + 1}`));
    expect(q(shadow, "[data-tests-view]").getAttribute("data-tests-editing")).toBe("test-1");
    expect(textarea(shadow).value).toBe(written[0]!.source);
    expect(status(shadow)).toMatch(/^Wrote \d tests? for the rule\.|pick/);
    ctrl.undo();
    expect(ctrl.tests()?.scenarios ?? []).toEqual([]);
    ctrl.redo();
    await vi.advanceTimersByTimeAsync(400);
    expect(el.runsStarted).toBeGreaterThan(runs);
    await idle(el);
  });

  it("names a written test apart from one that has its name", () => {
    localStorage.setItem(TESTS_RUN_AS_I_EDIT_KEY, "false");
    const { el, ctrl } = mount({ scenarios: [] });
    const rule = untestedRules(ctrl.snapshot(), fixtureWithTests("main"), [], []).rules.find((candidate) => candidate.kind === "show" || candidate.kind === "require")!;
    el.writeTestFor(rule.id);
    const first = ctrl.tests()!.scenarios.length;
    el.writeTestFor(rule.id);
    const names = createTestsRunner({ definition: () => undefined, root: () => ctrl.snapshot() })
      .parse(ctrl.tests())
      .map((entry) => entry.name);
    expect(names).toHaveLength(first * 2);
    expect(new Set(names).size).toBe(names.length);
    expect(names[first]).toBe(`${names[0]} (2)`);
  });

  it("re-exports the pins the shell feeds the Logic editor, from the runner's own parse", () => {
    const { ctrl, definition } = mount();
    const entries = createTestsRunner({ definition: () => definition, root: () => ctrl.snapshot() }).parse(ctrl.tests());
    const pins = testsPinsOf(ctrl.snapshot(), definition, entries, []);
    expect(pins.size).toBeGreaterThan(0);
  });
});

describe("openEntry and restored", () => {
  it("opens an entry by id, ignores an unknown one, and asks first over an unapplied edit", () => {
    const { el, shadow } = mount();
    el.openEntry("nothing-here");
    expect(shadow.querySelector("[data-tests-entry]")).not.toBeNull();
    el.openEntry("main-2");
    expect(q(shadow, "[data-tests-view]").getAttribute("data-tests-editing")).toBe("main-2");
    type(shadow, `${textarea(shadow).value}\n  check`);
    el.openEntry("main-3");
    expect(q(shadow, "[data-tests-view]").getAttribute("data-tests-editing")).toBe("main-2");
    expect(shadow.querySelector("dialog[data-prompt]")).not.toBeNull();
    click(shadow, "[data-unsaved-discard]");
    expect(q(shadow, "[data-tests-view]").getAttribute("data-tests-editing")).toBe("main-3");
  });

  it("skips the first opening run of a restored panel; an edit runs as always", async () => {
    const { el, ctrl } = mount(undefined, (panel) => {
      panel.restored = true;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(el.runsStarted).toBe(0);
    el.hidden = true;
    el.hidden = false;
    await vi.advanceTimersByTimeAsync(400);
    expect(el.runsStarted).toBe(0);
    ctrl.setDraftProperty("age", "label", "Years");
    ctrl.commitDraft("age");
    await vi.advanceTimersByTimeAsync(400);
    expect(el.runsStarted).toBe(1);
    await idle(el);
  });

  it("skips it when the restored panel is first shown after the run fell due while hidden", async () => {
    const { el, shadow } = mount(undefined, (panel) => {
      panel.restored = true;
      panel.hidden = true;
    });
    await vi.advanceTimersByTimeAsync(400);
    el.hidden = false;
    expect(el.runsStarted).toBe(0);
    expect(el.restored).toBe(false);
    click(shadow, "[data-tests-run-all]");
    expect(el.runsStarted).toBe(1);
    await idle(el);
  });
});

describe("the shown mark", () => {
  it("marks the line Show me is on in the box, and clears it when the showing ends", async () => {
    const { shadow, shown } = await failingEditor();
    const cell = (line: number): HTMLElement => q(shadow, `.tests-gutter .tests-cell[data-line="${line}"]`);
    expect(cell(3).classList.contains("tests-line--shown")).toBe(false);
    click(shadow, "[data-tests-show]");
    await until(() => shown.length === 1);
    expect(cell(3).classList.contains("tests-line--shown")).toBe(true);
    expect(cell(3).getAttribute("data-status")).toBe("failed");
    // The mark is a look (the gutter is hidden from assistive technology); the live region says the line.
    expect(cell(3).hasAttribute("aria-label")).toBe(false);
    expect(status(shadow)).toBe(TESTS_PANEL_EN["tests.panel.showing.line"].replace("{line}", "3").replace("{step}", "2").replace("{steps}", "4"));
    shown[0]!.onStep(1);
    await until(() => shown.length === 2);
    expect(cell(3).classList.contains("tests-line--shown")).toBe(false);
    expect(cell(4).classList.contains("tests-line--shown")).toBe(true);
    expect(status(shadow)).toBe("Line 4 shown on the form.");
    shown[1]!.onStop();
    expect(shadow.querySelectorAll(".tests-line--shown")).toHaveLength(0);
    expect(status(shadow)).toBe("");
  });
});

// --- the popovers fit the panel (Add step, Assert this) -------------------------------------------

describe("the popovers fit the panel's scroller", () => {
  const snapshot: TestsAssertSnapshot = { fields: [shownField("email", { label: "Email" }), shownField("age", { label: "Age" })], page: "contact" };

  /**
   * jsdom lays nothing out, so the rects are stubbed by class: the scroller spans 0..300; the popover's
   * top and the actions row's top move up with the scroller's scroll, as they would on a page.
   */
  function stubLayout(shadow: ShadowRoot, popTop: number, actionsTop: number) {
    const scroller = q(shadow, ".tests-in");
    const state = { scrollTop: 0, sets: [] as number[] };
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => state.scrollTop,
      set: (value: number) => {
        state.sets.push(value);
        state.scrollTop = value;
      }
    });
    const rect = (top: number, bottom: number): DOMRect => ({ top, bottom, left: 0, right: 200, width: 200, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("tests-in")) {
        return rect(0, 300);
      }
      if (this.classList.contains("tests-add-pop") || this.classList.contains("tests-assert-pop")) {
        return rect(popTop - state.scrollTop, popTop - state.scrollTop + 400);
      }
      if (this.classList.contains("tests-actions")) {
        return rect(actionsTop - state.scrollTop, actionsTop - state.scrollTop + 32);
      }
      return rect(0, 0);
    });
    onTestFinished(() => spy.mockRestore());
    return state;
  }

  it("hangs the Add step popover from the whole actions row and carries the full-width insets in the style sheet", async () => {
    const { TESTS_PANEL_STYLES } = await import("../form-engine/builder/form-tests/tests-panel-styles.js");
    const { shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    click(shadow, "[data-tests-add-step]");
    const row = q(shadow, ".tests-actions");
    expect(row.contains(q(shadow, "[data-tests-add-step]"))).toBe(true);
    expect(row.contains(q(shadow, ".tests-add-pop"))).toBe(true);
    expect(row.contains(q(shadow, "[data-tests-reference]"))).toBe(true);
    expect(TESTS_PANEL_STYLES).toMatch(/\.tests-add-pop \{[^}]*inset-inline: 0;[^}]*max-inline-size: 300px/);
    expect(TESTS_PANEL_STYLES).toMatch(/\.tests-assert-pop \{[^}]*inset-inline: 0;[^}]*max-inline-size: 320px/);
    expect(TESTS_PANEL_STYLES).toMatch(/\.tests-actions \{ position: relative; \}/);
    expect(TESTS_PANEL_STYLES).not.toMatch(/\.tests-add \{ position: relative/);
  });

  it("sets the Add step popover's height to the room under its top, and again when the panel scrolls", () => {
    const { shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    const layout = stubLayout(shadow, 80, 50);
    click(shadow, "[data-tests-add-step]");
    expect(q(shadow, ".tests-add-pop").style.maxBlockSize).toBe("212px");
    // Room enough: the panel is left where it is.
    expect(layout.sets).toEqual([]);
    layout.scrollTop = 40;
    q(shadow, ".tests-in").dispatchEvent(new Event("scroll"));
    expect(q(shadow, ".tests-add-pop").style.maxBlockSize).toBe("252px");
  });

  it("sets Assert this's height to the room under its top, and keeps it across a tick that rewrites the popover", () => {
    const { shadow } = recordingPanel(undefined, snapshot);
    const layout = stubLayout(shadow, 80, 50);
    click(shadow, "[data-tests-assert-open]");
    expect(q(shadow, ".tests-assert-pop").style.maxBlockSize).toBe("212px");
    const before = q(shadow, ".tests-assert-pop");
    before.scrollTop = 33;
    const age = q<HTMLInputElement>(shadow, '[data-tests-assert-field="age"]');
    age.checked = true;
    age.dispatchEvent(new Event("change", { bubbles: true }));
    const after = q(shadow, ".tests-assert-pop");
    // A new node, carrying the fitted height and the list's scroll across the rewrite before focus returns.
    expect(after).not.toBe(before);
    expect(after.style.maxBlockSize).toBe("212px");
    expect(after.scrollTop).toBe(33);
    expect(layout.sets).toEqual([]);
  });

  it("scrolls the panel once to bring the actions row to the top when the room is short, then measures again", () => {
    const { shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    const layout = stubLayout(shadow, 250, 200);
    click(shadow, "[data-tests-add-step]");
    // 250 - 0 - 8 = 242 would have been the room only after the shift: the row at 200 moved to 0.
    expect(layout.sets).toEqual([200]);
    expect(q(shadow, ".tests-add-pop").style.maxBlockSize).toBe("242px");
    // The owner's own scroll is not fought: a room under the floor after it (popover top 130, room 162) only resizes.
    layout.scrollTop = 120;
    q(shadow, ".tests-in").dispatchEvent(new Event("scroll"));
    expect(layout.sets).toEqual([200]);
    expect(q(shadow, ".tests-add-pop").style.maxBlockSize).toBe("162px");
  });

  it("ignores the scroll of the popover itself and of the editor, which move neither edge", () => {
    const { shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    const layout = stubLayout(shadow, 80, 50);
    click(shadow, "[data-tests-add-step]");
    layout.scrollTop = 40;
    q(shadow, ".tests-add-pop").dispatchEvent(new Event("scroll"));
    q(shadow, ".tests-editor-slot").dispatchEvent(new Event("scroll"));
    expect(q(shadow, ".tests-add-pop").style.maxBlockSize).toBe("212px");
    q(shadow, ".tests-in").dispatchEvent(new Event("scroll"));
    expect(q(shadow, ".tests-add-pop").style.maxBlockSize).toBe("252px");
  });

  it("refits when the scroller changes size without the window doing so, and follows a new scroller node", () => {
    const watchers: { observed: Element[]; disconnected: number; callback: () => void }[] = [];
    class FakeResizeObserver {
      private readonly watcher: (typeof watchers)[number];
      constructor(callback: () => void) {
        this.watcher = { observed: [], disconnected: 0, callback };
        watchers.push(this.watcher);
      }
      observe(target: Element): void {
        this.watcher.observed.push(target);
      }
      disconnect(): void {
        this.watcher.disconnected += 1;
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const onWindow = vi.spyOn(window, "addEventListener");
    onTestFinished(() => onWindow.mockRestore());
    const { shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    const scroller = q(shadow, ".tests-in");
    const layout = stubLayout(shadow, 80, 50);
    click(shadow, "[data-tests-add-step]");
    expect(watchers).toHaveLength(1);
    expect(watchers[0]!.observed).toEqual([scroller]);
    expect(onWindow).not.toHaveBeenCalledWith("resize", expect.anything());
    // The drawer shrinks under the popover: no scroll, no window resize, only the observer.
    layout.scrollTop = 40;
    watchers[0]!.callback();
    expect(q(shadow, ".tests-add-pop").style.maxBlockSize).toBe("252px");
    q(shadow, "[data-tests-add-menu] [role=menuitem]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(watchers[0]!.disconnected).toBeGreaterThan(0);
  });

  it("opens one popover at a time: Add step by the keyboard puts Assert this away", () => {
    const { shadow } = recordingPanel(undefined, snapshot);
    click(shadow, "[data-tests-assert-open]");
    expect(shadow.querySelector(".tests-assert-pop")).not.toBeNull();
    q(shadow, "[data-tests-add-step]").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(shadow.querySelector(".tests-assert-pop")).toBeNull();
    expect(shadow.querySelector(".tests-add-pop:not([hidden])")).not.toBeNull();
  });

  it("does the same for Assert this, anchored to the row above it", () => {
    const { shadow } = recordingPanel(undefined, snapshot);
    const layout = stubLayout(shadow, 250, 200);
    click(shadow, "[data-tests-assert-open]");
    expect(layout.sets).toEqual([200]);
    expect(q(shadow, ".tests-assert-pop").style.maxBlockSize).toBe("242px");
  });

  it("does nothing where nothing is laid out, and takes its listeners off when the popover closes", () => {
    const { shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    const spies = [
      vi.spyOn(shadow, "addEventListener"),
      vi.spyOn(shadow, "removeEventListener"),
      vi.spyOn(window, "addEventListener"),
      vi.spyOn(window, "removeEventListener")
    ];
    const [onShadowAdd, onShadow, onWindowAdd, onWindow] = spies as [(typeof spies)[0], (typeof spies)[0], (typeof spies)[0], (typeof spies)[0]];
    onTestFinished(() => spies.forEach((spy) => spy.mockRestore()));
    click(shadow, "[data-tests-add-step]");
    expect(q(shadow, ".tests-add-pop").style.maxBlockSize).toBe("");
    expect(onShadow).not.toHaveBeenCalledWith("scroll", expect.anything(), true);
    q(shadow, "[data-tests-add-menu] [role=menuitem]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    // The very functions that went on come off.
    const scrollOn = onShadowAdd.mock.calls.find((call) => call[0] === "scroll" && call[2] === true)?.[1];
    const resizeOn = onWindowAdd.mock.calls.find((call) => call[0] === "resize")?.[1];
    expect(scrollOn).toBeDefined();
    expect(resizeOn).toBeDefined();
    expect(onShadow).toHaveBeenCalledWith("scroll", scrollOn, true);
    expect(onWindow).toHaveBeenCalledWith("resize", resizeOn);
  });

  it("takes them off when the panel leaves the page with a popover open", () => {
    const { el, shadow } = mount();
    click(shadow, '[data-tests-entry="main-1"]');
    const onShadowAdd = vi.spyOn(shadow, "addEventListener");
    const onShadow = vi.spyOn(shadow, "removeEventListener");
    onTestFinished(() => {
      onShadowAdd.mockRestore();
      onShadow.mockRestore();
    });
    click(shadow, "[data-tests-add-step]");
    const scrollOn = onShadowAdd.mock.calls.find((call) => call[0] === "scroll" && call[2] === true)?.[1];
    expect(scrollOn).toBeDefined();
    el.remove();
    expect(onShadow).toHaveBeenCalledWith("scroll", scrollOn, true);
  });
});
