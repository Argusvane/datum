import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createJourneyBuilderMode, type JourneyBuilderMode } from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { JOURNEY_PAGES_SLOT, JOURNEY_ROUTES_SLOT } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { logicJourneyHostOf, registerLogicJourneyHost, watchLogicJourneyHost, type LogicJourneyHost, type LogicOpenRequest } from "../form-engine/builder/logic/logic-journey-host.js";
import type { BuilderModeContext } from "../form-engine/builder/web-component/builder-modes.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * How the Logic workspace edits a journey's Go to rules at the
 * mode's seam: the host the mode registers under the form's controller, what each write does to
 * the journey's own controller (one undo each, never the form's), where a new rule goes, and the
 * requests the map makes of the Logic surface.
 */

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        { id: "contactMethod", type: "select", configuration: { label: "Contact method" } },
        { id: "consent", type: "checkbox", configuration: { label: "I agree" } }
      ]
    }
  };
}

const phone: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "contactMethod" }, right: { kind: "literal", value: "phone" } };

function seed(): JourneyConfiguration {
  return {
    journeys: [
      {
        id: "intake",
        pages: [
          { id: "about", components: ["fullName", "contactMethod"], routes: [{ when: phone, to: "finish" }, { to: "more" }] },
          { id: "more", components: ["consent"] },
          { id: "finish" }
        ]
      },
      { id: "quick", pages: [{ id: "all", components: ["fullName"] }] }
    ]
  } as unknown as JourneyConfiguration;
}

interface Setup {
  form: BuilderController;
  mode: JourneyBuilderMode;
  host: LogicJourneyHost;
  events: Array<{ type: string; detail: unknown }>;
}

async function setup(): Promise<Setup> {
  const form = new BuilderController({ initialRoot: formRoot() });
  const mode = createJourneyBuilderMode({ form, journey: seed() });
  const events: Array<{ type: string; detail: unknown }> = [];
  const root = {
    dispatchEvent: (event: Event) => {
      events.push({ type: event.type, detail: (event as CustomEvent).detail });
      return true;
    }
  } as unknown as ShadowRoot;
  const context: BuilderModeContext = { host: {} as HTMLElement, root, showCanvasSurface: () => undefined };
  const host = logicJourneyHostOf(form)!;
  expect(await host.prepare()).toBe(true);
  await mode.activate?.(context);
  return { form, mode, host, events };
}

const routes = (mode: JourneyBuilderMode, journeyId = "intake", page = 0): Array<{ to: string; when?: unknown }> =>
  (mode.journeys.find((journey) => journey.id === journeyId)!.pages[page]!.routes ?? []) as Array<{ to: string; when?: unknown }>;

const routeNodes = (mode: JourneyBuilderMode): ComponentNode[] => mode.controller.snapshot().children![JOURNEY_PAGES_SLOT]![0]!.children![JOURNEY_ROUTES_SLOT]!;

/** One undo and then a second: the journey is as it was after the first, so the write was one step. */
function oneUndo(mode: JourneyBuilderMode): { first: string; second: string } {
  mode.controller.undo();
  const first = JSON.stringify(mode.journeys);
  mode.controller.undo();
  return { first, second: JSON.stringify(mode.journeys) };
}

describe("the registry", () => {
  it("keeps a host per form controller, and lets one go only itself", () => {
    const a = {};
    const b = {};
    const host = {} as LogicJourneyHost;
    const other = {} as LogicJourneyHost;
    const off = registerLogicJourneyHost(a, host);
    expect(logicJourneyHostOf(a)).toBe(host);
    expect(logicJourneyHostOf(b)).toBeUndefined();
    expect(logicJourneyHostOf(undefined)).toBeUndefined();
    registerLogicJourneyHost(a, other);
    off();
    expect(logicJourneyHostOf(a)).toBe(other);
  });

  it("tells a watcher when a host is registered for the form, or leaves it, and no one else's", () => {
    const form = {};
    const elsewhere = {};
    const heard: string[] = [];
    const off = watchLogicJourneyHost(form, () => heard.push("form"));
    watchLogicJourneyHost(elsewhere, () => heard.push("elsewhere"));
    const leave = registerLogicJourneyHost(form, {} as LogicJourneyHost);
    expect(heard).toEqual(["form"]);
    leave();
    expect(heard).toEqual(["form", "form"]);
    // A host that was already replaced leaves quietly.
    const first = registerLogicJourneyHost(form, {} as LogicJourneyHost);
    registerLogicJourneyHost(form, {} as LogicJourneyHost);
    heard.length = 0;
    first();
    expect(heard).toEqual([]);
    off();
    registerLogicJourneyHost(form, {} as LogicJourneyHost);
    expect(heard).toEqual([]);
  });

  it("is made by the mode when it is, and gone when it is disposed", () => {
    const form = new BuilderController({ initialRoot: formRoot() });
    expect(logicJourneyHostOf(form)).toBeUndefined();
    const mode = createJourneyBuilderMode({ form, journey: seed() });
    expect(logicJourneyHostOf(form)).toBeDefined();
    mode.dispose?.();
    expect(logicJourneyHostOf(form)).toBeUndefined();
  });
});

describe("the host's reads", () => {
  it("lists the journeys, ready once the designer is in, and tells its listeners when either changes", async () => {
    const form = new BuilderController({ initialRoot: formRoot() });
    const mode = createJourneyBuilderMode({ form, journey: seed() });
    const host = logicJourneyHostOf(form)!;
    expect(host.journeys().map((journey) => journey.id)).toEqual(["intake", "quick"]);
    expect(host.ready()).toBe(false);
    const heard: number[] = [];
    const off = host.subscribe(() => heard.push(host.version()));
    const before = host.version();
    expect(await host.prepare()).toBe(true);
    expect(host.ready()).toBe(true);
    expect(host.version()).toBeGreaterThan(before);
    expect(heard.length).toBeGreaterThan(0);
    // The same array while nothing changed.
    expect(host.journeys()).toBe(host.journeys());
    // A write moves the version and tells the listener.
    heard.length = 0;
    expect(host.create({ journeyId: "intake", pageId: "more", to: "finish" })).toEqual({ journeyId: "intake", pageId: "more", routeIndex: 0 });
    expect(heard.length).toBeGreaterThan(0);
    off();
    mode.dispose?.();
  });
});

describe("writes through the host", () => {
  it("changes a rule's target and condition together in one undo step on the journey's controller, and never writes the form", async () => {
    const { form, mode, host } = await setup();
    const formBefore = JSON.stringify(form.snapshot());
    const before = JSON.stringify(mode.journeys);
    expect(host.update({ journeyId: "intake", pageId: "about", routeIndex: 0 }, { to: "more", when: "contactMethod = \"post\"" })).toBe(true);
    expect(routes(mode)[0]).toEqual({ when: 'contactMethod = "post"', to: "more" });
    expect(JSON.stringify(form.snapshot())).toBe(formBefore);
    const undone = oneUndo(mode);
    expect(JSON.stringify(mode.journeys)).toBe(before);
    expect(undone.second).toBe(undone.first);
  });

  it("clears a condition with an empty text, so the rule always applies", async () => {
    const { mode, host } = await setup();
    expect(host.update({ journeyId: "intake", pageId: "about", routeIndex: 0 }, { when: "" })).toBe(true);
    expect(routes(mode)[0]).toEqual({ to: "finish" });
  });

  it("refuses a target the journey has no step for, writing nothing", async () => {
    const { mode, host } = await setup();
    const before = JSON.stringify(mode.journeys);
    expect(host.update({ journeyId: "intake", pageId: "about", routeIndex: 0 }, { to: "nowhere" })).toBe(false);
    expect(host.update({ journeyId: "intake", pageId: "about", routeIndex: 9 }, { to: "more" })).toBe(false);
    expect(host.update({ journeyId: "gone", pageId: "about", routeIndex: 0 }, { to: "more" })).toBe(false);
    expect(JSON.stringify(mode.journeys)).toBe(before);
  });

  it("adds a rule before the step's first rule with no condition, as one undo step, selected", async () => {
    const { mode, host } = await setup();
    const before = JSON.stringify(mode.journeys);
    const ref = host.create({ journeyId: "intake", pageId: "about", to: "$end", when: "consent" });
    expect(ref).toEqual({ journeyId: "intake", pageId: "about", routeIndex: 1 });
    expect(routes(mode).map((route) => [route.to, route.when])).toEqual([["finish", phone], ["$end", "consent"], ["more", undefined]]);
    expect(mode.controller.selectedComponentId()).toBe(routeNodes(mode)[1]!.id);
    const undone = oneUndo(mode);
    expect(JSON.stringify(mode.journeys)).toBe(before);
    expect(undone.second).toBe(undone.first);
  });

  it("adds a rule last when the step has none without a condition, and as the step's only rule when it has none", async () => {
    const { mode, host } = await setup();
    // A step with no routes: the new rule is its first.
    expect(host.create({ journeyId: "intake", pageId: "more", to: "finish" })).toEqual({ journeyId: "intake", pageId: "more", routeIndex: 0 });
    expect(routes(mode, "intake", 1)).toEqual([{ to: "finish" }]);
    // Take the step's unconditional rule away; then a new one goes last.
    expect(host.remove({ journeyId: "intake", pageId: "about", routeIndex: 1 })).toBe(true);
    expect(host.create({ journeyId: "intake", pageId: "about", to: "$end", when: "consent" })).toEqual({ journeyId: "intake", pageId: "about", routeIndex: 1 });
    expect(routes(mode).map((route) => route.to)).toEqual(["finish", "$end"]);
  });

  it("works on a journey that is not the one on the page, building its designer for the write", async () => {
    const { mode, host } = await setup();
    expect(mode.journeyId).toBe("intake");
    expect(host.create({ journeyId: "quick", pageId: "all", to: "$end", when: "consent" })).toEqual({ journeyId: "quick", pageId: "all", routeIndex: 0 });
    expect(routes(mode, "quick", 0)).toEqual([{ when: "consent", to: "$end" }]);
    expect(routes(mode, "intake", 0)).toHaveLength(2);
  });

  it("refuses to add a rule to a step or from a target the journey does not have", async () => {
    const { mode, host } = await setup();
    const before = JSON.stringify(mode.journeys);
    expect(host.create({ journeyId: "intake", pageId: "gone", to: "finish" })).toBeUndefined();
    expect(host.create({ journeyId: "intake", pageId: "about", to: "gone" })).toBeUndefined();
    expect(host.create({ journeyId: "gone", pageId: "about", to: "finish" })).toBeUndefined();
    expect(JSON.stringify(mode.journeys)).toBe(before);
  });

  it("moves a rule one place in the order the step tries them in, one undo step, and not past either end", async () => {
    const { mode, host } = await setup();
    const before = JSON.stringify(mode.journeys);
    expect(host.move({ journeyId: "intake", pageId: "about", routeIndex: 0 }, -1)).toBeUndefined();
    expect(host.move({ journeyId: "intake", pageId: "about", routeIndex: 1 }, 1)).toBeUndefined();
    expect(host.move({ journeyId: "intake", pageId: "about", routeIndex: 0 }, 1)).toEqual({ journeyId: "intake", pageId: "about", routeIndex: 1 });
    expect(routes(mode).map((route) => route.to)).toEqual(["more", "finish"]);
    expect(host.move({ journeyId: "intake", pageId: "about", routeIndex: 1 }, -1)).toEqual({ journeyId: "intake", pageId: "about", routeIndex: 0 });
    expect(routes(mode).map((route) => route.to)).toEqual(["finish", "more"]);
    mode.controller.undo();
    mode.controller.undo();
    expect(JSON.stringify(mode.journeys)).toBe(before);
  });

  it("moves past a route that has no target yet, which is not written and so not in the order", async () => {
    const { mode, host } = await setup();
    // A route with no target, between the two written ones (a blank route the designer's own Route adds).
    mode.controller.add("journey-route", mode.controller.snapshot().children![JOURNEY_PAGES_SLOT]![0]!.id, JOURNEY_ROUTES_SLOT);
    const slot = (): string[] => routeNodes(mode).map((node) => String((node.configuration as { to?: string }).to ?? ""));
    expect(slot()).toHaveLength(3);
    expect(host.move({ journeyId: "intake", pageId: "about", routeIndex: 0 }, 1)).toEqual({ journeyId: "intake", pageId: "about", routeIndex: 1 });
    expect(routes(mode).map((route) => route.to)).toEqual(["more", "finish"]);
  });

  it("removes a rule as one undo step", async () => {
    const { mode, host } = await setup();
    const before = JSON.stringify(mode.journeys);
    expect(host.remove({ journeyId: "intake", pageId: "about", routeIndex: 0 })).toBe(true);
    expect(routes(mode)).toEqual([{ to: "more" }]);
    const undone = oneUndo(mode);
    expect(JSON.stringify(mode.journeys)).toBe(before);
    expect(undone.second).toBe(undone.first);
    expect(host.remove({ journeyId: "intake", pageId: "about", routeIndex: 7 })).toBe(false);
  });

  it("selects a rule's route on the journey, so the map marks the rule being edited", async () => {
    const { mode, host } = await setup();
    host.select({ journeyId: "intake", pageId: "about", routeIndex: 1 });
    expect(mode.controller.selectedComponentId()).toBe(routeNodes(mode)[1]!.id);
    host.select({ journeyId: "intake", pageId: "about", routeIndex: 9 });
    expect(mode.controller.selectedComponentId()).toBe(mode.controller.snapshot().children![JOURNEY_PAGES_SLOT]![0]!.id);
  });

  it("writes nothing before the designer is loaded", async () => {
    const form = new BuilderController({ initialRoot: formRoot() });
    createJourneyBuilderMode({ form, journey: seed() });
    const host = logicJourneyHostOf(form)!;
    expect(host.ready()).toBe(false);
    expect(host.create({ journeyId: "intake", pageId: "about", to: "finish" })).toBeUndefined();
    expect(host.update({ journeyId: "intake", pageId: "about", routeIndex: 0 }, { to: "more" })).toBe(false);
    expect(host.remove({ journeyId: "intake", pageId: "about", routeIndex: 0 })).toBe(false);
    expect(host.move({ journeyId: "intake", pageId: "about", routeIndex: 0 }, 1)).toBeUndefined();
  });
});

describe("the form's history (the bar's Undo while Logic is on the page)", () => {
  it("records each write as a step of the form's own history, so the form's Undo and Redo take it back and put it again", async () => {
    const { form, mode, host } = await setup();
    const before = JSON.stringify(routes(mode));
    form.setProperties([{ componentId: "fullName", propertyPath: "label", value: "Name X" }]);
    expect(host.update({ journeyId: "intake", pageId: "about", routeIndex: 0 }, { to: "more", when: "not(consent)" })).toBe(true);
    const written = JSON.stringify(routes(mode));
    expect(written).not.toBe(before);
    // The form's Undo takes the rule back first, not the label.
    form.undo();
    expect(JSON.stringify(routes(mode))).toBe(before);
    expect((form.snapshot().children!.content![0]!.configuration as Record<string, unknown>).label).toBe("Name X");
    form.redo();
    expect(JSON.stringify(routes(mode))).toBe(written);
    // A create, a move and a remove are one step each.
    const ref = host.create({ journeyId: "intake", pageId: "about", to: "finish", when: "consent" })!;
    expect(routes(mode)).toHaveLength(3);
    form.undo();
    expect(routes(mode)).toHaveLength(2);
    expect(host.move({ journeyId: "intake", pageId: "about", routeIndex: 0 }, 1)).toBeDefined();
    form.undo();
    expect(JSON.stringify(routes(mode))).toBe(written);
    expect(host.remove({ journeyId: "intake", pageId: "about", routeIndex: 0 })).toBe(true);
    form.undo();
    expect(JSON.stringify(routes(mode))).toBe(written);
    expect(ref.journeyId).toBe("intake");
  });

  it("records no step for a write that changed nothing", async () => {
    const { form, host } = await setup();
    form.setProperties([{ componentId: "fullName", propertyPath: "label", value: "Name X" }]);
    expect(host.update({ journeyId: "intake", pageId: "about", routeIndex: 0 }, {})).toBe(true);
    form.undo();
    expect((form.snapshot().children!.content![0]!.configuration as Record<string, unknown>).label).not.toBe("Name X");
  });
});

describe("what the path has at a step", () => {
  it("lists the components asked on the step and the steps before it, a layout standing for what is inside it; nothing known before the designer is built", async () => {
    const form = new BuilderController({ initialRoot: formRoot() });
    const mode = createJourneyBuilderMode({ form, journey: seed() });
    const host = logicJourneyHostOf(form)!;
    expect(host.askedThrough("intake", "about")).toBeUndefined();
    expect(await host.prepare()).toBe(true);
    expect([...host.askedThrough("intake", "about")!].sort()).toEqual(["contactMethod", "fullName"]);
    expect([...host.askedThrough("intake", "more")!].sort()).toEqual(["consent", "contactMethod", "fullName"]);
    expect(host.askedThrough("intake", "nowhere")).toBeUndefined();
    expect(host.askedThrough("nowhere", "about")).toBeUndefined();
    mode.dispose?.();
  });
});

describe("requests from the map", () => {
  /** What the mode's map hands the Logic surface when a rule label is clicked or New rule is pressed: asked here through the same private seam the map's hooks call. */
  const ask = (mode: JourneyBuilderMode, hook: "openRuleFromMap" | "newRuleFromMap", ...args: string[]): void =>
    (mode as unknown as Record<string, (...rest: string[]) => void>)[hook]!(...args);

  it("tells a surface that is listening at once, and asks the shell for the Logic workspace", async () => {
    const { mode, host, events } = await setup();
    const heard: LogicOpenRequest[] = [];
    host.onOpen((request) => heard.push(request));
    const tree = mode.controller.snapshot();
    const [about, more] = tree.children![JOURNEY_PAGES_SLOT]!;
    // The mode builds what it needs on its own: ensure the page's entry is the built one.
    expect(mode.ready).toBe(true);
    ask(mode, "openRuleFromMap", about!.children![JOURNEY_ROUTES_SLOT]![1]!.id);
    ask(mode, "newRuleFromMap", about!.id, more!.id);
    expect(heard).toEqual([
      { kind: "rule", ref: { journeyId: "intake", pageId: "about", routeIndex: 1 } },
      { kind: "new", journeyId: "intake", pageId: "about", to: "more" }
    ]);
    expect(events.filter((event) => event.type === "builder-open-workspace").map((event) => event.detail)).toEqual([{ workspace: "logic" }, { workspace: "logic" }]);
    expect(host.takePending()).toBeUndefined();
  });

  it("holds a request for the surface that is still loading, once, until it is taken", async () => {
    const { mode, host } = await setup();
    const about = mode.controller.snapshot().children![JOURNEY_PAGES_SLOT]![0]!;
    ask(mode, "openRuleFromMap", about.children![JOURNEY_ROUTES_SLOT]![0]!.id);
    expect(host.takePending()).toEqual({ kind: "rule", ref: { journeyId: "intake", pageId: "about", routeIndex: 0 } });
    expect(host.takePending()).toBeUndefined();
  });

  it("lets a request go stale: one older than a few seconds is not taken", async () => {
    const { mode, host } = await setup();
    const about = mode.controller.snapshot().children![JOURNEY_PAGES_SLOT]![0]!;
    const realNow = Date.now;
    try {
      ask(mode, "openRuleFromMap", about.children![JOURNEY_ROUTES_SLOT]![0]!.id);
      Date.now = () => realNow() + 60_000;
      expect(host.takePending()).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  it("asks nothing for a route that is not written (no target yet), or a node that is no route", async () => {
    const { mode, host, events } = await setup();
    const about = mode.controller.snapshot().children![JOURNEY_PAGES_SLOT]![0]!;
    mode.controller.add("journey-route", about.id, JOURNEY_ROUTES_SLOT);
    const blank = routeNodes(mode).find((node) => (node.configuration as { to?: string }).to === "")!;
    ask(mode, "openRuleFromMap", blank.id);
    ask(mode, "openRuleFromMap", about.id);
    ask(mode, "newRuleFromMap", about.id, "journey-page_99");
    expect(host.takePending()).toBeUndefined();
    expect(events).toEqual([]);
  });
});
