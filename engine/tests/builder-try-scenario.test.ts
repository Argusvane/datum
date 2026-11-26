// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { CanvasScenarioShowing } from "../form-engine/builder/form-tests/tests-model.js";
import { DATUM_BUILDER_CANVAS_TAG, defineBuilderPanels, type DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import type { BuilderMode } from "../form-engine/builder/web-component/builder-modes.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * Show me on the canvas: the Tests panel hands the canvas a scenario's
 * step; the canvas turns Try it on, replaces the tried answers with the step's values, and the
 * Try bar says which step of which test is on show with Step back, Step forward and Stop showing.
 * The showing ends, the panel told once, on Back to editing and on an edit of the form under it.
 */

defineBuilderPanels();

afterEach(() => {
  document.body.innerHTML = "";
});

function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "full_name", type: "text", configuration: { label: "Full name" } },
        {
          id: "contact_method",
          type: "select",
          configuration: { label: "How to reach you", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] }
        },
        { id: "phone", type: "text", configuration: { label: "Phone" }, rules: { visibleWhen: 'contact_method = "phone"' } },
        { id: "greeting", type: "text", configuration: { label: "Greeting" }, rules: { value: '"Hello " & full_name' } }
      ]
    }
  };
}

async function until<T>(read: () => T, what = "the condition"): Promise<NonNullable<T>> {
  for (let i = 0; i < 200; i += 1) {
    const value = read();
    if (value) {
      return value as NonNullable<T>;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function mount(): { canvas: DatumBuilderCanvasElement; controller: BuilderController; root: ShadowRoot } {
  const controller = new BuilderController({ initialRoot: form() });
  const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
  canvas.controller = controller;
  document.body.append(canvas);
  return { canvas, controller, root: canvas.shadowRoot! };
}

function showing(overrides: Partial<CanvasScenarioShowing> = {}): CanvasScenarioShowing & { onStep: ReturnType<typeof vi.fn>; onStop: ReturnType<typeof vi.fn> } {
  return {
    name: "Phone shows for phone",
    step: 1,
    steps: 3,
    line: 2,
    values: { full_name: "Ada", contact_method: "phone" },
    onStep: vi.fn(),
    onStop: vi.fn(),
    ...overrides
  } as CanvasScenarioShowing & { onStep: ReturnType<typeof vi.fn>; onStop: ReturnType<typeof vi.fn> };
}

/** The bar's step control, once the Try it chunk is in and has drawn it. */
async function showingBar(root: ShadowRoot): Promise<HTMLElement> {
  return until(() => root.querySelector<HTMLElement>("[data-canvas-bar] [data-try-showing]"), "the Try bar's step control");
}

describe("Show me on the canvas", () => {
  it("turns Try it on and sets the step's values on the preview runtime", async () => {
    const { canvas, root } = mount();
    const preview = canvas.previewRuntime()!;
    preview.setValue("full_name", "typed before");
    const shown = showing({ values: { full_name: "Ada", contact_method: "phone", greeting: "nobody's", missing: "x", "@journey": "intro" } });
    canvas.showScenario(shown);
    expect(canvas.previewing).toBe(true);
    expect(canvas.scenarioShowing).toBe(shown);
    const state = preview.state();
    expect(state.values.full_name).toBe("Ada");
    expect(state.values.contact_method).toBe("phone");
    // A calculation, an id the tree lacks and the runtime's own keys are not answers to set.
    expect(state.dirty.has("greeting")).toBe(false);
    expect("missing" in state.values).toBe(false);
    expect(state.values["@journey"]).toBeUndefined();
    // The rules follow: the phone box shows for a phone answer.
    expect(preview.effectiveStatesMap().get("phone")?.visible).toBe(true);
    await showingBar(root);
    expect(shown.onStop).not.toHaveBeenCalled();
  });

  it("draws the step control in the Try bar: the label, Step back off at step 1, Step forward on", async () => {
    const { canvas, root } = mount();
    const shown = showing();
    canvas.showScenario(shown);
    const bar = await showingBar(root);
    const label = bar.querySelector<HTMLElement>("[data-try-showing-label]")!;
    expect(label.textContent).toBe("Showing step 1 of 3 · “Phone shows for phone”");
    expect(label.getAttribute("aria-live")).toBe("polite");
    const back = bar.querySelector<HTMLButtonElement>('[data-try-step="-1"]')!;
    const forward = bar.querySelector<HTMLButtonElement>('[data-try-step="1"]')!;
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(false);
    expect(back.getAttribute("aria-label")).toBe("Step back");
    expect(forward.getAttribute("aria-label")).toBe("Step forward");
    expect(bar.querySelector("[data-try-show-stop]")?.textContent).toBe("Stop showing");
    // Before Back to editing, which stays; the bar's "Previewing" gives the label its place.
    expect(bar.nextElementSibling?.hasAttribute("data-try-it")).toBe(true);
    expect(root.querySelector("[data-canvas-bar]")!.hasAttribute("data-try-showing-on")).toBe(true);

    forward.click();
    expect(shown.onStep).toHaveBeenCalledWith(1);
    back.click();
    expect(shown.onStep).toHaveBeenCalledTimes(1);
  });

  it("follows the panel's next step in place, the live region kept, Step forward off at the last", async () => {
    const { canvas, root } = mount();
    canvas.showScenario(showing());
    const bar = await showingBar(root);
    const label = bar.querySelector<HTMLElement>("[data-try-showing-label]")!;
    const next = showing({ step: 3, values: { full_name: "Grace" } });
    canvas.showScenario(next);
    expect(root.querySelector("[data-try-showing]")).toBe(bar);
    expect(bar.querySelector("[data-try-showing-label]")).toBe(label);
    expect(label.textContent).toBe("Showing step 3 of 3 · “Phone shows for phone”");
    expect(bar.querySelector<HTMLButtonElement>('[data-try-step="1"]')!.disabled).toBe(true);
    expect(bar.querySelector<HTMLButtonElement>('[data-try-step="-1"]')!.disabled).toBe(false);
    // The tried answers are the new step's alone: the earlier step's choice is gone.
    const values = canvas.previewRuntime()!.state().values;
    expect(values.full_name).toBe("Grace");
    expect(values.contact_method).toBeUndefined();
    bar.querySelector<HTMLButtonElement>('[data-try-step="-1"]')!.click();
    expect(next.onStep).toHaveBeenCalledWith(-1);
  });

  it("Stop showing tells the panel once and forgets the showing, Try it left on", async () => {
    const { canvas, root } = mount();
    const shown = showing();
    canvas.showScenario(shown);
    const bar = await showingBar(root);
    bar.querySelector<HTMLButtonElement>("[data-try-show-stop]")!.click();
    expect(shown.onStop).toHaveBeenCalledTimes(1);
    expect(canvas.scenarioShowing).toBeUndefined();
    expect(root.querySelector("[data-try-showing]")).toBeNull();
    expect(root.querySelector("[data-canvas-bar]")!.hasAttribute("data-try-showing-on")).toBe(false);
    expect(canvas.previewing).toBe(true);
  });

  it("showScenario(undefined) clears the bar's showing, keeps Try it on and the answers as set", async () => {
    const { canvas, root } = mount();
    const shown = showing();
    canvas.showScenario(shown);
    await showingBar(root);
    canvas.showScenario(undefined);
    expect(canvas.scenarioShowing).toBeUndefined();
    expect(root.querySelector("[data-try-showing]")).toBeNull();
    expect(canvas.previewing).toBe(true);
    expect(canvas.previewRuntime()!.state().values.full_name).toBe("Ada");
    expect(shown.onStop).not.toHaveBeenCalled();
  });

  it("ends on Back to editing, the panel told once even when its onStop ends the showing again", async () => {
    const { canvas, root } = mount();
    const shown = showing();
    shown.onStop.mockImplementation(() => canvas.showScenario(undefined));
    canvas.showScenario(shown);
    await showingBar(root);
    canvas.previewing = false;
    expect(shown.onStop).toHaveBeenCalledTimes(1);
    expect(canvas.scenarioShowing).toBeUndefined();
    expect(root.querySelector("[data-try-showing]")).toBeNull();
  });

  it("ends on an edit of the form under it, once, but not on a repaint or a selection", async () => {
    const { canvas, controller, root } = mount();
    const shown = showing();
    canvas.showScenario(shown);
    await showingBar(root);
    controller.select("full_name");
    controller.setPreviewWidth(375);
    expect(shown.onStop).not.toHaveBeenCalled();
    expect(canvas.scenarioShowing).toBe(shown);
    controller.setProperty("full_name", "label", "Your name");
    expect(shown.onStop).toHaveBeenCalledTimes(1);
    expect(canvas.scenarioShowing).toBeUndefined();
    controller.setProperty("full_name", "label", "Name");
    expect(shown.onStop).toHaveBeenCalledTimes(1);
  });

  it("replaces one showing with the next without telling the first to stop", async () => {
    const { canvas, root } = mount();
    const first = showing();
    const second = showing({ name: "Email is required for email", step: 2 });
    canvas.showScenario(first);
    await showingBar(root);
    canvas.showScenario(second);
    expect(first.onStop).not.toHaveBeenCalled();
    expect(canvas.scenarioShowing).toBe(second);
    canvas.previewing = false;
    expect(first.onStop).not.toHaveBeenCalled();
    expect(second.onStop).toHaveBeenCalledTimes(1);
  });

  it("names a journey scenario's page in the label", async () => {
    const { canvas, root } = mount();
    canvas.showScenario(showing({ page: "contact", step: 2 }));
    const bar = await showingBar(root);
    expect(bar.querySelector("[data-try-showing-label]")!.textContent).toBe("Showing step 2 of 3 · “Phone shows for phone” · page contact");
  });

  it("puts the focus on the step control when a showing starts, not when it moves", async () => {
    const { canvas, root } = mount();
    canvas.showScenario(showing());
    const bar = await showingBar(root);
    const forward = bar.querySelector<HTMLButtonElement>('[data-try-step="1"]')!;
    expect(root.activeElement).toBe(forward);
    const stop = bar.querySelector<HTMLButtonElement>("[data-try-show-stop]")!;
    stop.focus();
    canvas.showScenario(showing({ step: 2 }));
    expect(root.activeElement).toBe(stop);
  });

  it("draws as many rows as the step had, an empty one included", async () => {
    const controller = new BuilderController({
      initialRoot: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            {
              id: "items",
              type: "repeatingSection",
              configuration: { label: "Items" },
              collection: { itemFields: ["qty"] },
              children: { content: [{ id: "qty", type: "number", configuration: { label: "Quantity" } }] }
            }
          ]
        }
      } as ComponentNode
    });
    const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
    canvas.controller = controller;
    document.body.append(canvas);
    const add = vi.spyOn(canvas.previewRuntime()!, "addRow");
    canvas.showScenario(showing({ values: { "items[0].qty": 2 }, rows: { items: 2 } }));
    // Two rows wanted and none to start from: two added, then the answer goes into the first.
    expect(add).toHaveBeenCalledTimes(2);
    expect(canvas.previewRuntime()!.state().values["items[0].qty"]).toBe(2);
  });

  it("says the panel's note after the label (a stepping replay that could not run)", async () => {
    const { canvas, root } = mount();
    canvas.showScenario({ ...showing({ step: 2 }), note: "step 3 could not be replayed" } as CanvasScenarioShowing);
    const bar = await showingBar(root);
    expect(bar.querySelector("[data-try-showing-label]")!.textContent).toBe("Showing step 2 of 3 · “Phone shows for phone” · step 3 could not be replayed");
  });
});

describe("Show me applies the scenario's givens", () => {
  function sourcedForm(): ComponentNode {
    const base = form();
    base.children!.content!.push({ id: "province", type: "select", configuration: { label: "Province", data: { sourceId: "provinces" } } } as ComponentNode);
    return base;
  }

  function mountSourced(): { canvas: DatumBuilderCanvasElement; controller: BuilderController; root: ShadowRoot } {
    const controller = new BuilderController({ initialRoot: sourcedForm() });
    const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
    canvas.controller = controller;
    document.body.append(canvas);
    return { canvas, controller, root: canvas.shadowRoot! };
  }

  it("puts a given list in the simulator for the field's source, and the one it found back on stop", async () => {
    const { canvas, controller } = mountSourced();
    controller.setSimulatedDataSource("provinces", [{ value: "BC", label: "British Columbia" }]);
    const shown = showing({ givens: { options: { province: ["ON", "QC"] } } });
    canvas.showScenario(shown);
    expect(controller.simulatedDataSources().get("provinces")).toEqual([
      { value: "ON", label: "ON" },
      { value: "QC", label: "QC" }
    ]);
    // A step of the same scenario keeps them.
    canvas.showScenario({ ...shown, step: 2 });
    expect(controller.simulatedDataSources().get("provinces")).toHaveLength(2);
    canvas.showScenario(undefined);
    expect(controller.simulatedDataSources().get("provinces")).toEqual([{ value: "BC", label: "British Columbia" }]);
  });

  it("takes a list off the simulator on Stop showing when there was none before", async () => {
    const { canvas, controller, root } = mountSourced();
    canvas.showScenario(showing({ givens: { options: { province: ["ON"] } } }));
    expect(controller.simulatedDataSources().has("provinces")).toBe(true);
    const bar = await showingBar(root);
    bar.querySelector<HTMLButtonElement>("[data-try-show-stop]")!.click();
    expect(controller.simulatedDataSources().has("provinces")).toBe(false);
  });

  it("shows the given language and day while shown, across a repaint, and puts the builder's back after", async () => {
    const { canvas, controller } = mount();
    const preview = canvas.previewRuntime()!;
    canvas.showScenario(showing({ givens: { locale: "fr", today: "2026-02-03" } }));
    expect(preview.state().locale).toBe("fr");
    expect(preview.today()).toBe("2026-02-03");
    // A selection repaints the canvas: the language shown stays the test's.
    controller.select("full_name");
    expect(preview.state().locale).toBe("fr");
    canvas.previewing = false;
    expect(preview.state().locale).toBe("en");
    expect(preview.today()).toBe("");
  });

  it("makes the rules read the given day (setToday recomputes)", () => {
    const controller = new BuilderController({
      initialRoot: {
        id: "root",
        type: "form",
        configuration: {},
        children: { content: [{ id: "late", type: "text", configuration: { label: "Late" }, rules: { visibleWhen: 'today() >= @"2026-06-01"' } }] }
      } as ComponentNode
    });
    const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
    canvas.controller = controller;
    document.body.append(canvas);
    const preview = canvas.previewRuntime()!;
    canvas.showScenario(showing({ values: {}, givens: { today: "2026-07-01" } }));
    expect(preview.effectiveStatesMap().get("late")?.visible).toBe(true);
    canvas.showScenario(showing({ values: {}, givens: { today: "2026-01-01" } }));
    expect(preview.effectiveStatesMap().get("late")?.visible).toBe(false);
  });

  it("names in the bar what it could not apply: a list for a field with no source", async () => {
    const { canvas, root, controller } = mount();
    canvas.showScenario(showing({ givens: { host: { role: "admin" }, options: { full_name: ["x"] }, locale: "fr" } }));
    const bar = await showingBar(root);
    expect(bar.querySelector("[data-try-showing-label]")!.textContent).toBe("Showing step 1 of 3 · “Phone shows for phone” · not applied here: the lists");
    expect(controller.simulatedDataSources().size).toBe(0);
  });

  describe("given host values", () => {
    function mountHosted(): { canvas: DatumBuilderCanvasElement; controller: BuilderController; root: ShadowRoot } {
      const controller = new BuilderController({
        initialRoot: {
          id: "root",
          type: "form",
          configuration: {},
          children: {
            content: [
              { id: "note", type: "text", configuration: { label: "Role note" }, rules: { visibleWhen: 'host.role = "admin"' } },
              { id: "unit", type: "text", configuration: { label: "Unit" }, rules: { visibleWhen: 'host.org.unit = "north"' } }
            ]
          }
        } as ComponentNode
      });
      const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
      canvas.controller = controller;
      document.body.append(canvas);
      return { canvas, controller, root: canvas.shadowRoot! };
    }
    const visible = (canvas: DatumBuilderCanvasElement, id: string): boolean | undefined => canvas.previewRuntime()!.effectiveStatesMap().get(id)?.visible;

    it("are the host values the rules read while shown, dotted names nested, and Try it's come back after", async () => {
      const { canvas, controller, root } = mountHosted();
      controller.setTryHostContext({ role: "admin" });
      canvas.previewing = true;
      expect(visible(canvas, "note")).toBe(true);
      canvas.showScenario(showing({ values: {}, givens: { host: { role: "user", "org.unit": "north" } } }));
      expect(canvas.previewRuntime()!.hostContext()).toEqual({ role: "user", org: { unit: "north" } });
      expect(visible(canvas, "note")).toBe(false);
      expect(visible(canvas, "unit")).toBe(true);
      // A repaint under the showing keeps the test's values, and a step of the same scenario does too.
      controller.select("note");
      expect(visible(canvas, "unit")).toBe(true);
      canvas.showScenario(showing({ values: {}, step: 2, givens: { host: { role: "user", "org.unit": "north" } } }));
      expect(visible(canvas, "unit")).toBe(true);
      // The bar names nothing as unapplied.
      const bar = await showingBar(root);
      expect(bar.querySelector("[data-try-showing-label]")!.textContent).toBe("Showing step 2 of 3 · “Phone shows for phone”");
      canvas.showScenario(undefined);
      expect(canvas.previewRuntime()!.hostContext()).toEqual({ role: "admin" });
      expect(visible(canvas, "note")).toBe(true);
      expect(visible(canvas, "unit")).toBe(false);
    });

    it("leave no host values behind when Try it had none", () => {
      const { canvas } = mountHosted();
      canvas.showScenario(showing({ values: {}, givens: { host: { role: "admin" } } }));
      expect(visible(canvas, "note")).toBe(true);
      canvas.previewing = false;
      expect(canvas.previewRuntime()!.hostContext()).toBeUndefined();
    });
  });

  it("says nothing more when every given was applied", async () => {
    const { canvas, root } = mountSourced();
    canvas.showScenario(showing({ givens: { options: { province: ["ON"] }, today: "2026-02-03" } }));
    const bar = await showingBar(root);
    expect(bar.querySelector("[data-try-showing-label]")!.textContent).toBe("Showing step 1 of 3 · “Phone shows for phone”");
  });
});

describe("Show me on a mode's session", () => {
  function sessionCanvas(showPage?: (pageId: string) => void): { canvas: DatumBuilderCanvasElement; restart: ReturnType<typeof vi.fn> } {
    const { canvas, controller } = mount();
    const restart = vi.fn();
    const session = {
      get runtime() {
        return canvas.previewRuntime()! as never;
      },
      answers: () => ({}),
      submit: async () => ({ problems: [] }),
      refresh: () => undefined,
      restart,
      dispose: () => undefined,
      ...(showPage ? { showPage } : {})
    };
    const mode = { id: "fake-journeys", label: "Journeys", controller, tryIt: { session: () => session } } as unknown as BuilderMode;
    canvas.tryForm = { controller, mode, workspace: "journeys" };
    return { canvas, restart };
  }

  it("asks the session to go to the step's page, by its id when the showing carries one", () => {
    const showPage = vi.fn();
    const { canvas, restart } = sessionCanvas(showPage);
    canvas.showScenario({ ...showing(), page: "About you", pageId: "about" } as CanvasScenarioShowing);
    // Cleared first (a session starts over), then the page.
    expect(restart).toHaveBeenCalled();
    expect(showPage).toHaveBeenCalledWith("about");
    canvas.showScenario({ ...showing({ step: 2 }), page: "finish" });
    expect(showPage).toHaveBeenLastCalledWith("finish");
  });

  it("goes nowhere without a page, or with a session that offers no showPage", () => {
    const showPage = vi.fn();
    const { canvas } = sessionCanvas(showPage);
    canvas.showScenario(showing());
    expect(showPage).not.toHaveBeenCalled();
    document.body.innerHTML = "";
    const plain = sessionCanvas();
    expect(() => plain.canvas.showScenario(showing({ page: "about" }))).not.toThrow();
  });

  it("names the day and the language as not applied in a session, which runs a runtime of its own", async () => {
    const { canvas } = sessionCanvas(vi.fn());
    canvas.showScenario(showing({ givens: { today: "2026-02-03", locale: "fr" } }));
    expect(canvas.previewRuntime()!.today()).toBe("");
    const bar = await showingBar(canvas.shadowRoot!);
    expect(bar.querySelector("[data-try-showing-label]")!.textContent).toBe("Showing step 1 of 3 · “Phone shows for phone” · not applied here: the language and the day");
  });
});
