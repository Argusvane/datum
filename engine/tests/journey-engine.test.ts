import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { Journey, JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import type { JourneyTrace } from "../form-engine/core/journey/journey-types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import {
  JOURNEY_ENGINE_MISSING,
  NoopJourneyEngine,
  defaultJourneyEngine,
  setDefaultJourneyEngine,
  type JourneyChecksHost,
  type JourneyEngine,
  type JourneyRuntimeHost,
  type PresentationOverlayHost
} from "../form-engine/runtime/browser/journey-engine.js";
import { JourneyNavigator } from "../form-engine/runtime/browser/journey/journey-navigation.js";
import { JourneyServerChecker } from "../form-engine/runtime/browser/journey/journey-server-checks.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { PresentationOverlayRunner } from "../form-engine/runtime/browser/journey/journey-presentation-overlay.js";
import { RuntimeOrchestrator } from "../form-engine/runtime/browser/runtime-orchestrator.js";
import { isPresentationKey } from "../form-engine/core/journey/presentation.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { EventBus } from "../form-engine/core/events/event-bus.js";
import { InMemoryDraftStore } from "../form-engine/persistence/local-storage/in-memory-draft-store.js";
import { presentationForm } from "./fixtures/presentation-form.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import * as engineRoot from "../form-engine/index.js";

/*
 * The journey seam: the Noop engine's contract, a runtime on it behaving as a plain
 * form does, the default-engine slot, and the eager engine's pure methods. The rest of the
 * journey suites run on the eager engine through tests/setup/journey-engine.ts; every test
 * here passes its engine explicitly.
 */

const path = (name: string): Expression => ({ kind: "path", path: name });
const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
const eq = (name: string, value: string | number | boolean): Expression => ({ kind: "binary", operator: "eq", left: path(name), right: literal(value) });

function root(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { required: true } },
        { id: "resident", type: "checkbox", configuration: {} },
        { id: "province", type: "text", configuration: { required: true } },
        { id: "notes", type: "text", configuration: {} }
      ]
    }
  };
}

function residentJourney(): Journey {
  return {
    id: "apply",
    pages: [
      { id: "about", components: ["name", "resident"], routes: [{ when: ({ ...eq("resident", true), operator: "neq" } as Expression), to: "details" }] },
      { id: "residence", components: ["province"] },
      { id: "details", components: ["notes"] }
    ]
  };
}

function plainForm(): FormDefinition {
  return { id: "plain", version: "1", schemaVersion: "1", root: root() };
}

function journeyForm(journey: JourneyConfiguration = { journeys: [residentJourney()] }): FormDefinition {
  return { ...plainForm(), id: "with-journeys", journey };
}

function build(shape: FormDefinition, deps: Partial<FormRuntimeDependencies> = {}): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(shape, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(shape.root)]),
    ...deps
  });
}

const envelope = {
  form: { id: "plain", version: "1" },
  client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NoopJourneyEngine contract", () => {
  it("has no journeys, whatever the configuration holds", () => {
    expect(NoopJourneyEngine.kind).toBe("none");
    const configuration: JourneyConfiguration = { journeys: [residentJourney()] };
    expect(NoopJourneyEngine.journeys(configuration)).toEqual([]);
    expect(NoopJourneyEngine.journeys(undefined)).toEqual([]);
    expect(NoopJourneyEngine.defaultJourney(configuration)).toBeUndefined();
  });

  it("opens the whole form, and still names a journey the host asked for and nobody has", () => {
    expect(NoopJourneyEngine.selection({ journeys: [residentJourney()] }, undefined)).toEqual({ selection: { kind: "form" } });
    expect(NoopJourneyEngine.selection(undefined, "form")).toEqual({ selection: { kind: "form" } });
    expect(NoopJourneyEngine.selection(undefined, "ghost")).toEqual({ selection: { kind: "form" }, unknownJourneyId: "ghost" });
  });

  it("answers the questions a running journey would, with nothing", () => {
    const trace: JourneyTrace = { pages: ["a"], end: "end", decisions: [] };
    expect(NoopJourneyEngine.frontier(trace, [])).toBeUndefined();
    expect(NoopJourneyEngine.reachable(trace, [], "a")).toBe(false);
    expect(NoopJourneyEngine.pageComponents({} as never, "a").size).toBe(0);
    expect(NoopJourneyEngine.restore({ id: "apply", page: "about", completed: [] }, [], false)).toEqual({ kind: "none" });
    expect(NoopJourneyEngine.workedOutTargets(undefined).size).toBe(0);
    expect(NoopJourneyEngine.landing(trace, [], "a", "a")).toEqual({});
    expect(NoopJourneyEngine.describe(undefined)).toBeUndefined();
  });

  it("refuses, with the engine-missing message, to plan or check what it cannot", () => {
    expect(() => NoopJourneyEngine.activate({ root: root(), journey: residentJourney(), definesKey: () => false, evaluate: () => undefined })).toThrow(
      JOURNEY_ENGINE_MISSING
    );
    expect(() => NoopJourneyEngine.serverCheck.key({} as never)).toThrow(JOURNEY_ENGINE_MISSING);
    expect(() => NoopJourneyEngine.renderRoot(root(), {} as never)).toThrow(JOURNEY_ENGINE_MISSING);
  });
});

describe("a runtime on the Noop engine (a form without journeys)", () => {
  it("answers the journey methods as a plain form does", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const noop = build(plainForm(), { journeyEngine: NoopJourneyEngine });
    const eager = build(plainForm(), { journeyEngine: EagerJourneyEngine });
    for (const runtime of [noop, eager]) {
      expect(runtime.journeys()).toEqual([]);
      expect(runtime.journeyView()).toBeUndefined();
      expect(runtime.presentationIndex()).toBeUndefined();
      expect(runtime.presentationValues()).toEqual({});
      expect(runtime.journeyRenderRoot()).toBeUndefined();
      expect(runtime.startJourney()).toEqual({ ok: false, reason: "no-journey" });
      expect(runtime.startJourney("apply")).toEqual({ ok: false, reason: "no-journey" });
      expect(await runtime.nextPage()).toEqual({ ok: false, reason: "no-journey" });
      expect(await runtime.previousPage()).toEqual({ ok: false, reason: "no-journey" });
      expect(await runtime.goToPage("any")).toEqual({ ok: false, reason: "no-journey" });
      expect(runtime.state().journey).toBeUndefined();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("validates, drafts and submits exactly as the eager engine's runtime does", async () => {
    const run = async (journeyEngine: JourneyEngine): Promise<unknown> => {
      const runtime = build(plainForm(), { journeyEngine });
      runtime.setValue("name", "Ada");
      const invalid = await runtime.validate();
      runtime.setValue("province", "ON");
      const result = await runtime.submit("submit", envelope);
      return {
        invalid: invalid.map((error) => [error.code, error.componentId]),
        accepted: result.accepted,
        values: runtime.formValues(),
        journey: runtime.state().journey ?? null,
        submission: result.canonicalSubmission?.submission ?? null
      };
    };
    expect(await run(NoopJourneyEngine)).toEqual(await run(EagerJourneyEngine));
  });

  it("says once that a definition's journeys are ignored, and runs it as one page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = build(journeyForm(), { journeyEngine: NoopJourneyEngine });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("no journey engine");
    expect(runtime.journeys()).toEqual([]);
    expect(runtime.journeyView()).toBeUndefined();
    expect(runtime.startJourney()).toEqual({ ok: false, reason: "no-journey" });
    runtime.setValue("name", "Ada");
    expect(runtime.formValues()).toEqual({ name: "Ada" });
    await runtime.validate();
    // The whole form is judged: the field the journey would have put on a later page counts.
    expect(runtime.errors().map((error) => error.componentId)).toContain("province");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("the Noop warning follows what the host asked", () => {
  it("is silent when the host chose the whole form, and fires for a named journey or no choice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    build(journeyForm(), { journeyEngine: NoopJourneyEngine, journey: "form" });
    expect(warn).not.toHaveBeenCalled();
    build(journeyForm(), { journeyEngine: NoopJourneyEngine, journey: "apply" });
    build(journeyForm(), { journeyEngine: NoopJourneyEngine });
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("no journey engine"))).toHaveLength(2);
  });
});

describe("the default engine slot", () => {
  it("is what the setup registered, is replaced on request, and a runtime reads it at construction", () => {
    // The vitest setup registered the eager engine for the rest of the suite.
    expect(defaultJourneyEngine()).toBe(EagerJourneyEngine);
    const previous = defaultJourneyEngine();
    try {
      setDefaultJourneyEngine(NoopJourneyEngine);
      expect(defaultJourneyEngine()).toBe(NoopJourneyEngine);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(build(journeyForm()).journeyView()).toBeUndefined();
      expect(build(journeyForm(), { journeyEngine: EagerJourneyEngine }).journeyView()?.journeyId).toBe("apply");
      setDefaultJourneyEngine(EagerJourneyEngine);
      expect(build(journeyForm()).journeyView()?.journeyId).toBe("apply");
    } finally {
      setDefaultJourneyEngine(previous);
    }
  });

  it("is exported by the engine package without being registered by importing it", () => {
    expect(engineRoot.EagerJourneyEngine).toBe(EagerJourneyEngine);
    expect(engineRoot.NoopJourneyEngine).toBe(NoopJourneyEngine);
    expect(engineRoot.setDefaultJourneyEngine).toBe(setDefaultJourneyEngine);
  });
});

describe("EagerJourneyEngine: pure methods", () => {
  const configuration: JourneyConfiguration = { journeys: [residentJourney()] };
  const active = () =>
    EagerJourneyEngine.activate({ root: root(), journey: residentJourney(), definesKey: () => false, evaluate: () => undefined });

  it("reads journeys, the default and the selection ladder", () => {
    expect(EagerJourneyEngine.kind).toBe("journeys");
    expect(EagerJourneyEngine.journeys(configuration).map((journey) => journey.id)).toEqual(["apply"]);
    expect(EagerJourneyEngine.journeys(undefined)).toEqual([]);
    expect(EagerJourneyEngine.defaultJourney(configuration)?.id).toBe("apply");
    expect(EagerJourneyEngine.selection(configuration, undefined)).toEqual({ selection: { kind: "journey", journeyId: "apply" } });
    expect(EagerJourneyEngine.selection(configuration, "form")).toEqual({ selection: { kind: "form" } });
    expect(EagerJourneyEngine.selection(configuration, "ghost").unknownJourneyId).toBe("ghost");
  });

  it("activates a journey: ownership, and a fold that carries the path and placement functions", () => {
    const plan = active();
    expect(plan.journey.id).toBe("apply");
    expect(plan.ownership.membersOf["about"]).toEqual(["name", "resident"]);
    expect(plan.presentation).toBeUndefined();
    expect(plan.ownStage).toBeUndefined();
    const fold = plan.fold as unknown as Record<string, unknown>;
    expect(typeof fold.path).toBe("function");
    expect(typeof fold.place).toBe("function");
    expect(fold.ownership).toBe(plan.ownership);
    expect(describeOf(plan)).toEqual({ journeyId: "apply" });
    expect(EagerJourneyEngine.describe(undefined)).toBeUndefined();
  });

  it("answers the page, the frontier, reachability and a move's re-check over a trace", () => {
    const plan = active();
    const trace: JourneyTrace = { pages: ["about", "details"], end: "end", decisions: [] };
    const view = EagerJourneyEngine.view({
      journey: plan.journey,
      ownership: plan.ownership,
      pageId: "about",
      completedPages: new Set<string>(),
      trace
    });
    expect(view).toMatchObject({
      journeyId: "apply",
      pageId: "about",
      kind: "questions",
      path: ["about", "details"],
      index: 0,
      total: 2,
      number: 1,
      completed: [],
      frontierPageId: "about",
      final: false,
      members: ["name", "resident"],
      validation: { continue: "defer", server: false, onUnavailable: "block" }
    });
    expect(view?.backPageId).toBeUndefined();
    expect(view?.pageOf).toMatchObject({ name: "about", notes: "details" });
    // A page off the path has no view.
    expect(EagerJourneyEngine.view({ journey: plan.journey, ownership: plan.ownership, pageId: "residence", completedPages: new Set(), trace })).toBeUndefined();

    expect(EagerJourneyEngine.frontier(trace, [])).toBe("about");
    expect(EagerJourneyEngine.frontier(trace, ["about"])).toBe("details");
    expect(EagerJourneyEngine.reachable(trace, [], "details")).toBe(false);
    expect(EagerJourneyEngine.reachable(trace, ["about"], "details")).toBe(true);

    const move = (to: string, direction: "forward" | "back" | "jump", completed: string[] = []) =>
      EagerJourneyEngine.moveHolds({ view: { ...(view as NonNullable<typeof view>), completed }, trace, to, direction });
    expect(move("details", "forward")).toBe(true);
    expect(move("residence", "forward")).toBe(false);
    expect(move("details", "back")).toBe(false);
    expect(move("details", "jump")).toBe(false);
    expect(move("details", "jump", ["about"])).toBe(true);
  });

  it("lists what a page holds, validation settings and the render root", () => {
    const plan = active();
    expect([...EagerJourneyEngine.pageComponents(plan.ownership, "residence")]).toEqual(["province"]);
    expect(EagerJourneyEngine.pageValidation(plan.journey, plan.journey.pages[0])).toEqual({ continue: "defer", server: false, onUnavailable: "block" });
    expect(EagerJourneyEngine.endValidation(plan.journey)).toBe("client");
  });

  it("works out what a draft restores to and where it lands", () => {
    const journeys = [residentJourney()];
    expect(EagerJourneyEngine.restore({ id: "apply", page: "details", completed: ["about"], written: { a: 1 } }, journeys, false)).toEqual({
      kind: "restore",
      journeyId: "apply",
      pageId: "details",
      completedPages: ["about"],
      written: { a: 1 }
    });
    expect(EagerJourneyEngine.restore({ id: "apply", page: "details", completed: [], written: [1] }, journeys, false)).toMatchObject({ written: undefined });
    expect(EagerJourneyEngine.restore({ id: "gone", page: "x", completed: [] }, journeys, true)).toEqual({ kind: "restart" });
    expect(EagerJourneyEngine.restore(undefined, journeys, false)).toEqual({ kind: "none" });

    const trace: JourneyTrace = { pages: ["about", "residence", "details"], end: "end", decisions: [] };
    // The draft's page is out of reach: the frontier; the wanted page is reachable once the draft reaches it.
    expect(EagerJourneyEngine.landing(trace, ["about"], "details", "residence")).toEqual({ frontier: "residence", wanted: "residence" });
    expect(EagerJourneyEngine.landing(trace, ["about", "residence"], "details", undefined)).toEqual({});
    expect(EagerJourneyEngine.landing(trace, [], "about", "details")).toEqual({});
  });

  it("a review page: counted in the counter, final, and the way back from a Change link", () => {
    const journey: Journey = {
      id: "apply",
      pages: [...residentJourney().pages, { id: "check", kind: "review", title: "Check your answers" }]
    };
    const plan = EagerJourneyEngine.activate({ root: root(), journey, definesKey: () => false, evaluate: () => undefined });
    const trace: JourneyTrace = { pages: ["about", "residence", "details", "check"], end: "end", decisions: [] };
    const viewOf = (pageId: string, completed: string[], returnTo?: string) =>
      EagerJourneyEngine.view({ journey, ownership: plan.ownership, pageId, completedPages: new Set(completed), trace, returnTo }) as NonNullable<ReturnType<typeof EagerJourneyEngine.view>>;
    const review = viewOf("check", ["about", "residence", "details"]);
    expect(review).toMatchObject({ kind: "review", index: 3, number: 4, total: 4, final: true, members: [], backPageId: "details" });
    expect(review.returning).toBeUndefined();
    // Every page before it completed: Continue and Back from a changed page return to it.
    const changed = viewOf("residence", ["about", "residence", "details"], "check");
    expect(changed.returning).toEqual({ reviewPageId: "check", nextPageId: "check" });
    expect(changed.backPageId).toBe("check");
    expect(changed.final).toBe(false);
    expect(changed.number).toBe(2);
    // A page the changed answers put on the path, not completed yet, comes first.
    expect(viewOf("about", ["about", "details"], "check").returning).toEqual({ reviewPageId: "check", nextPageId: "residence" });
    expect(viewOf("about", ["about", "details"], "check").backPageId).toBe("residence");
    // On that page, not completed: Continue returns, Back is the ordinary Back.
    const added = viewOf("residence", ["about", "details"], "check");
    expect(added.returning).toEqual({ reviewPageId: "check", nextPageId: "check" });
    expect(added.backPageId).toBe("about");
    // No return without a review page by that id on the path, nor on the review page itself.
    expect(viewOf("residence", ["about"], "details").returning).toBeUndefined();
    expect(viewOf("check", ["about"], "check").returning).toBeUndefined();
    expect(EagerJourneyEngine.view({ journey, ownership: plan.ownership, pageId: "about", completedPages: new Set(), trace: { ...trace, pages: ["about", "details"] }, returnTo: "check" })?.returning).toBeUndefined();

    const holds = (view: typeof review, to: string, direction: "forward" | "back" | "jump" | "change") => EagerJourneyEngine.moveHolds({ view, trace, to, direction });
    expect(holds(review, "residence", "change")).toBe(true);
    // Only to a page completed, or the first one not yet completed.
    expect(holds(review, "check", "change")).toBe(false);
    expect(holds(viewOf("check", ["about"]), "details", "change")).toBe(false);
    expect(holds(viewOf("check", ["about"]), "residence", "change")).toBe(true);
    expect(holds(viewOf("check", ["about", "details"]), "details", "change")).toBe(true);
    expect(holds(added, "about", "back")).toBe(true);
    // A Change link is a review page's alone.
    expect(holds(viewOf("details", ["about", "residence"]), "about", "change")).toBe(false);
    expect(holds(changed, "check", "forward")).toBe(true);
    expect(holds(changed, "details", "forward")).toBe(false);
    expect(holds(changed, "check", "back")).toBe(true);
    expect(holds(changed, "about", "back")).toBe(false);

    expect(EagerJourneyEngine.restore({ id: "apply", page: "residence", completed: ["about"], returnTo: "check" }, [journey], false)).toMatchObject({ returnTo: "check" });
    expect(EagerJourneyEngine.restore({ id: "apply", page: "residence", completed: ["about"], returnTo: 3 }, [journey], false)).toMatchObject({ returnTo: undefined });
  });

  it("keys a server check the same whatever order its answers were set in", () => {
    const base = { formId: "f", formVersion: "1", journeyId: "apply", scope: "page" as const, pageId: "about", locale: "en" };
    const a = EagerJourneyEngine.serverCheck.key({ ...base, values: { x: 1, y: 2 } });
    const b = EagerJourneyEngine.serverCheck.key({ ...base, values: { y: 2, x: 1 } });
    const c = EagerJourneyEngine.serverCheck.key({ ...base, values: { x: 1, y: 3 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(EagerJourneyEngine.serverCheck.stableJson({ b: 1, a: 2 })).toBe(EagerJourneyEngine.serverCheck.stableJson({ a: 2, b: 1 }));
    expect(EagerJourneyEngine.serverCheck.classifyFailure({ status: 404 }, false)).toEqual({ outcome: "unavailable", reason: "server-error", status: 404 });
    expect(EagerJourneyEngine.serverCheck.classifyFailure(new Error("down"), false)).toEqual({ outcome: "unavailable", reason: "network" });
    expect(EagerJourneyEngine.serverCheck.outcomeOf([])).toBe("clean");
    expect(EagerJourneyEngine.serverCheck.outcomeOf([{ severity: "warning" }])).toBe("warnings");
    expect(EagerJourneyEngine.serverCheck.outcomeOf([{}])).toBe("invalid");
    const kept = EagerJourneyEngine.serverCheck.scopeToPage([{ code: "a", componentId: "name" }, { code: "b", componentId: "other" }, { code: "c" }, { code: "d", componentId: "gone" }], new Set(["name"]), (id) => id === "name" || id === "other");
    expect(kept.map((error) => error.code)).toEqual(["a", "c", "d"]);
  });
});

/** A module's source, read beside the test. */
function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("the journey's moves are the engine's", () => {
  it("the Noop engine's moves answer as a runtime with no journey configured, and refuse what only a journey reaches", async () => {
    const asked: string[] = [];
    const host = {
      engine: NoopJourneyEngine,
      journeys: () => {
        asked.push("journeys");
        return [];
      },
      journeyConfiguration: () => {
        asked.push("configuration");
        return undefined;
      }
    } as unknown as JourneyRuntimeHost;
    const moves = NoopJourneyEngine.navigation(host);
    expect(moves.active()).toBeUndefined();
    expect(moves.trace()).toBeUndefined();
    expect(moves.view()).toBeUndefined();
    expect(moves.start("apply", {})).toEqual({ ok: false, reason: "no-journey" });
    expect(moves.start(undefined, { pageId: "about" })).toEqual({ ok: false, reason: "no-journey" });
    // Read as a runtime with an engine reads them: a host's override is compiled, and its problems said, alike.
    expect(asked).toEqual(["journeys", "configuration"]);
    expect(await moves.nextPage()).toEqual({ ok: false, reason: "no-journey" });
    expect(await moves.previousPage()).toEqual({ ok: false, reason: "no-journey" });
    expect(await moves.goToPage("about", {})).toEqual({ ok: false, reason: "no-journey" });
    expect(moves.pageComponents("about").size).toBe(0);
    expect(() => moves.leave()).not.toThrow();
    expect(() => moves.reconcile()).not.toThrow();
    // A draft's journey is never put back (the draft is revalidated as a whole form), and a
    // state with none saves none; an error moves no page, and its components are not even read.
    expect(moves.restoreFromDraft({ id: "apply", page: "about", completed: [] })).toBe(false);
    expect(moves.draftJourney(undefined)).toBeUndefined();
    const read = vi.fn(() => ["name"]);
    moves.revealErrorPage(read);
    expect(read).not.toHaveBeenCalled();
    expect(await moves.ownFieldErrors({ values: {}, locale: "en" })).toEqual([]);
    expect(() => moves.completedPagesScope()).toThrow(JOURNEY_ENGINE_MISSING);
  });

  it("the eager engine binds a navigator per runtime", () => {
    const host = { engine: EagerJourneyEngine } as unknown as JourneyRuntimeHost;
    const one = EagerJourneyEngine.navigation(host);
    expect(one).toBeInstanceOf(JourneyNavigator);
    expect(EagerJourneyEngine.navigation(host)).not.toBe(one);
  });

  it("only the eager engine reaches the moves' module, and the moves import no journey function", () => {
    const runtime = sourceOf("../form-engine/runtime/browser/form-runtime.ts");
    const seam = sourceOf("../form-engine/runtime/browser/journey-engine.ts");
    const eager = sourceOf("../form-engine/runtime/browser/journey-engine-eager.ts");
    const moves = sourceOf("../form-engine/runtime/browser/journey/journey-navigation.ts");
    expect(runtime).not.toMatch(/journey-navigation/);
    // The runtime and its orchestrator reach no path engine module (the shared helpers only).
    expect(runtime).not.toMatch(/from\s+"[^"]*journey-path(?:\.js)?"/);
    expect(sourceOf("../form-engine/runtime/browser/runtime-orchestrator.ts")).not.toMatch(/from\s+"[^"]*journey-path(?:\.js)?"/);
    expect(seam).not.toMatch(/^import\s+(?!type\b)[^;]*journey-navigation/m);
    expect(eager).toMatch(/^import \{ JourneyNavigator \} from "\.\/journey\/journey-navigation\.js";$/m);
    // Every pure answer is asked of the engine the host hands over: the path engine, the
    // presentation and the server-check helpers are never imported by the moves.
    expect(moves).not.toMatch(/from\s+"[^"]*\/journey\/(?:journey-path|presentation|journey-server-check)(?:\.js)?"/);
    expect(moves).not.toMatch(/from\s+"[^"]*journey-engine-eager/);
  });

  it("moves at once when no beforePageChange hook is set, and after the hooks otherwise", async () => {
    const twoPages: Journey = { id: "apply", pages: [{ id: "about", components: ["name", "resident"] }, { id: "details", components: ["notes"] }] };
    const runtime = build(journeyForm({ journeys: [twoPages] }), { journeyEngine: EagerJourneyEngine, journey: "apply" });
    runtime.startJourney("apply");
    expect(runtime.journeyView()?.pageId).toBe("about");
    const error = runtime.goToPage("details", { direction: "error" });
    expect(runtime.journeyView()?.pageId).toBe("details");
    expect(await error).toEqual({ ok: true, pageId: "details" });
    const back = runtime.previousPage();
    // No hook: the move is made in the same turn, as before the moves were the engine's.
    expect(runtime.journeyView()?.pageId).toBe("about");
    expect(await back).toEqual({ ok: true, pageId: "about" });

    const seen: unknown[] = [];
    const hooked = build(journeyForm({ journeys: [twoPages] }), {
      journeyEngine: EagerJourneyEngine,
      journey: "apply",
      hooks: {
        beforePageChange: [
          (context) => {
            seen.push(context);
            if (context.direction === "jump") {
              throw new Error("Not now");
            }
          }
        ]
      }
    });
    hooked.setValue("name", "Ada");
    const forward = hooked.nextPage();
    expect(hooked.journeyView()?.pageId).toBe("about");
    expect(await forward).toEqual({ ok: true, pageId: "details" });
    expect(seen).toEqual([{ journeyId: "apply", fromPageId: "about", toPageId: "details", direction: "forward", values: { name: "Ada" } }]);
    expect(Object.keys(seen[0] as object)).toEqual(["journeyId", "fromPageId", "toPageId", "direction", "values"]);
    expect(await hooked.previousPage()).toEqual({ ok: true, pageId: "about" });
    expect(await hooked.goToPage("details")).toEqual({ ok: false, reason: "vetoed", pageId: "about", message: "Not now" });
    expect(hooked.journeyView()?.pageId).toBe("about");
  });
});

describe("the journey's checks against the host's server are the engine's", () => {
  it("the Noop engine's checks have nothing out and nothing to refuse, and refuse what only a journey reaches", async () => {
    const checks = NoopJourneyEngine.checks({ engine: NoopJourneyEngine } as unknown as JourneyChecksHost);
    expect(checks.pending()).toBeUndefined();
    expect(await checks.checkEnd(undefined, undefined, {}, "1", false)).toBeUndefined();
    expect(() => checks.callOff("cancelled")).not.toThrow();
    expect(() => checks.forget()).not.toThrow();
    expect(() => checks.setValidator(undefined)).not.toThrow();
    expect(() => checks.checkPage({} as never, "about", "block")).toThrow(JOURNEY_ENGINE_MISSING);
    // One value for every runtime on the Noop engine: it holds no state.
    expect(NoopJourneyEngine.checks({} as unknown as JourneyChecksHost)).toBe(checks);
  });

  it("the eager engine binds a checker per runtime, which reads its dependencies once", () => {
    const host = { engine: EagerJourneyEngine, validator: undefined, timeoutMs: 5 } as unknown as JourneyChecksHost;
    const one = EagerJourneyEngine.checks(host);
    expect(one).toBeInstanceOf(JourneyServerChecker);
    expect(EagerJourneyEngine.checks(host)).not.toBe(one);
    expect(one.pending()).toBeUndefined();
  });

  it("only the eager engine reaches the checks' module, which imports no journey function and not the runtime", () => {
    const runtime = sourceOf("../form-engine/runtime/browser/form-runtime.ts");
    const seam = sourceOf("../form-engine/runtime/browser/journey-engine.ts");
    const eager = sourceOf("../form-engine/runtime/browser/journey-engine-eager.ts");
    const checker = sourceOf("../form-engine/runtime/browser/journey/journey-server-checks.ts");
    expect(runtime).not.toMatch(/journey-server-checks/);
    expect(seam).not.toMatch(/^import\s+(?!type\b)[^;]*journey-server-checks/m);
    expect(eager).toMatch(/^import \{ JourneyServerChecker \} from "\.\/journey\/journey-server-checks\.js";$/m);
    expect(checker).not.toMatch(/from\s+"[^"]*\/journey\/(?:journey-path|presentation|journey-server-check)(?:\.js)?"/);
    expect(checker).not.toMatch(/from\s+"[^"]*(?:form-runtime|journey-engine-eager)/);
    // The check's own bookkeeping left the runtime with it.
    for (const name of ["raceAbort", "SERVER_UNAVAILABLE_CODE", "PendingServerCheck", "cleanPageChecks", "warnedPageChecks", "missingValidatorReported"]) {
      expect(runtime).not.toContain(name);
      expect(checker).toContain(name);
    }
  });

  it("the checker spells the runtime's blocking rule alike", () => {
    const rule = /function isBlocking\(error: \{ severity\?: string \| undefined \}\): boolean \{\n([^}]*)\n\}/;
    const own = rule.exec(sourceOf("../form-engine/runtime/browser/form-runtime.ts"));
    const spelt = rule.exec(sourceOf("../form-engine/runtime/browser/journey/journey-server-checks.ts"));
    expect(own).not.toBeNull();
    expect(spelt?.[1]).toBe(own?.[1]);
  });

  it("a page's check asks the validator set after the build, and a journey without one counts as unavailable", async () => {
    const twoPages: Journey = {
      id: "apply",
      pages: [{ id: "about", components: ["name", "resident"], validation: { continue: "page", server: true, onUnavailable: "block" } }, { id: "details", components: ["notes"] }]
    };
    const runtime = build(journeyForm({ journeys: [twoPages] }), { journeyEngine: EagerJourneyEngine, journey: "apply" });
    runtime.setValue("name", "Ada");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runtime.nextPage()).toMatchObject({ ok: false, reason: "server-unavailable" });
    expect(error).toHaveBeenCalledTimes(1);
    const asked: unknown[] = [];
    runtime.setJourneyServerValidator(async (request) => {
      asked.push(request.pageId);
      return { errors: [] };
    });
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(asked).toEqual(["about"]);
  });
});

/** The modules a source imports by value (an `import type` is not one), with the names it takes. */
function valueImports(source: string): Array<{ from: string; names: string }> {
  const found: Array<{ from: string; names: string }> = [];
  for (const match of source.matchAll(/^import\s+(?!type\b)([\s\S]*?)\s+from\s+"([^"]+)";/gm)) {
    found.push({ from: match[2] as string, names: (match[1] as string).replace(/\s+/g, " ").trim() });
  }
  return found;
}

describe("drafts, error pages and presentations are the engine's", () => {
  const runtimeSource = (): string => sourceOf("../form-engine/runtime/browser/form-runtime.ts");
  const orchestratorSource = (): string => sourceOf("../form-engine/runtime/browser/runtime-orchestrator.ts");

  it("the runtime and its orchestrator take no journey function module by value: the shared readers alone", () => {
    const journeyModule = /\/core\/journey\/|\/core\/schema\/journey\.js$|journey-engine-eager|\/journey\/journey-/;
    const runtime = valueImports(runtimeSource()).filter((entry) => journeyModule.test(entry.from));
    // The one schema reader ("has journeys" stays synchronous in the entry); the rest of the module is types.
    expect(runtime).toEqual([{ from: "../../core/schema/journey.js", names: "{ readJourneys, type Journey, type JourneyConfiguration, type JourneyHostChoice }" }]);
    const orchestrator = valueImports(orchestratorSource()).filter((entry) => journeyModule.test(entry.from));
    // None at all: a data grid's rows follow it through its collection path like any section's,
    // so the shared grid-path reader is not imported.
    expect(orchestrator).toEqual([]);
    for (const source of [runtimeSource(), orchestratorSource()]) {
      expect(source).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+"[^"]*\/(?:journey-path|presentation|journey-server-check|journey-engine-eager)(?:\.js)?";/m);
    }
    // The orchestrator reaches the seam for the default engine only, never a module the engine loads.
    expect(valueImports(orchestratorSource()).filter((entry) => entry.from === "./journey-engine.js")).toEqual([
      { from: "./journey-engine.js", names: "{ defaultJourneyEngine, type JourneyEngine, type PresentationOverlay }" }
    ]);
  });

  it("the moved code left the runtime and the orchestrator, and the overlay imports no journey function", () => {
    const runtime = runtimeSource();
    for (const name of ["restoreJourneyFromDraft", "validateOwnFields", "errorHosts", "takeOpenPage", "lastJourneyTrace", "ownStage"]) {
      expect(runtime).not.toContain(name);
    }
    const orchestrator = orchestratorSource();
    for (const name of ["resolvePresentation", "runMappings", "ownAnswer", "MAPPING_ROUNDS", "OWN_HIDDEN", "lastReadable", "isEmptyValue", "journeyHoldsOwnAnswer"]) {
      expect(orchestrator).not.toContain(name);
    }
    const overlay = sourceOf("../form-engine/runtime/browser/journey/journey-presentation-overlay.ts");
    expect(overlay).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+"[^"]*\/journey\/(?:journey-path|presentation|journey-server-check)(?:\.js)?";/m);
    expect(overlay).not.toMatch(/from\s+"[^"]*(?:form-runtime|journey-engine-eager)/);
    expect(sourceOf("../form-engine/runtime/browser/journey-engine-eager.ts")).toMatch(
      /^import \{ PresentationOverlayRunner \} from "\.\/journey\/journey-presentation-overlay\.js";$/m
    );
    expect(sourceOf("../form-engine/runtime/browser/journey-engine.ts")).not.toMatch(/^import\s+(?!type\b)[^;]*journey-presentation-overlay/m);
  });

  it("the orchestrator spells a presentation's key as presentation.ts does", () => {
    const tree = new ComponentTree({
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "@rows", type: "text", configuration: {} }, { id: "email", type: "text", configuration: {} }] }
    });
    const orchestrator = new RuntimeOrchestrator(tree, { eventBus: new EventBus(), formId: "f", journeyEngine: NoopJourneyEngine });
    const defines = (key: string): boolean => orchestrator.definesKey(key);
    for (const key of ["@apply.m1", "@rows", "@rows[0]", "email", "apply.@m1", "@", "", "@constructor", "@public.note"]) {
      expect(orchestrator.isPresentationKey(key)).toBe(isPresentationKey(key, defines));
    }
  });

  it("the Noop engine's overlay has nothing to work out; the eager engine binds a runner per orchestrator", () => {
    const host = {} as PresentationOverlayHost;
    const noop = NoopJourneyEngine.presentationOverlay(host);
    expect(() => noop.forget()).not.toThrow();
    expect(() => noop.recompute({} as never)).toThrow(JOURNEY_ENGINE_MISSING);
    const one = EagerJourneyEngine.presentationOverlay(host);
    expect(one).toBeInstanceOf(PresentationOverlayRunner);
    expect(EagerJourneyEngine.presentationOverlay(host)).not.toBe(one);
  });

  it("an orchestrator asks its engine for the overlay once, when a presentation first runs, and never for a plain form", () => {
    const overlays = vi.fn(EagerJourneyEngine.presentationOverlay);
    const engine: JourneyEngine = { ...EagerJourneyEngine, presentationOverlay: overlays };
    const plain = build(plainForm(), { journeyEngine: engine });
    plain.setValue("name", "Ada");
    expect(overlays).not.toHaveBeenCalled();

    const runtime = build(presentationForm(), { journeyEngine: engine });
    expect(overlays).toHaveBeenCalledTimes(1);
    runtime.setValue("@apply.m1", 100);
    runtime.setValue("@apply.m2", 200);
    expect(runtime.state().values["annual_income"]).toBe(300);
    expect(runtime.state().journey?.written).toEqual({ annual_income: 300 });
    expect(overlays).toHaveBeenCalledTimes(1);
  });

  it("a journey's draft round-trips through the engine: put back, revalidated by its completed pages, saved alike", async () => {
    const store = new InMemoryDraftStore();
    const versionContext = { formVersion: "1.0.0", schemaVersion: "1.0.0", rendererVersion: "1" };
    const first = build(presentationForm(), { journeyEngine: EagerJourneyEngine, draftStore: store, versionContext });
    first.setValue("email", "ada@example.org");
    expect(await first.nextPage()).toEqual({ ok: true, pageId: "income" });
    first.setValue("@apply.m1", 20000);
    first.setValue("@apply.m2", 20000);
    first.setValue("@apply.m3", 20000);
    expect(await first.nextPage()).toEqual({ ok: true, pageId: "assist" });
    await first.saveDraft("d");
    const saved = await store.load("d");
    expect(saved.state.journey).toEqual({ id: "apply", page: "assist", completed: ["details", "income"], written: { annual_income: 60000 } });

    const again = build(presentationForm(), { journeyEngine: EagerJourneyEngine, draftStore: store, versionContext });
    await again.hydrateFromDraft(saved);
    expect(again.journeyView()?.pageId).toBe("assist");
    expect(again.errors()).toEqual([]);
    await again.saveDraft("d2");
    const resaved = await store.load("d2");
    expect({ ...resaved, id: "d", updatedAt: 0 }).toEqual({ ...saved, updatedAt: 0 });

    // On the Noop engine the journey is never put back: the draft is judged as a whole form.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plain = build(presentationForm(), { journeyEngine: NoopJourneyEngine, draftStore: store, versionContext });
    await plain.hydrateFromDraft(saved);
    expect(plain.journeyView()).toBeUndefined();
    await plain.saveDraft("d3");
    expect((await store.load("d3")).state.journey).toBeUndefined();
  });

  it("an error the host reports takes the person to the earliest page on the path holding it", async () => {
    const runtime = build(presentationForm(), { journeyEngine: EagerJourneyEngine });
    runtime.setValue("email", "ada@example.org");
    await runtime.nextPage();
    expect(runtime.journeyView()?.pageId).toBe("income");
    runtime.setErrors([{ code: "taken", path: "email" }]);
    expect(runtime.journeyView()?.pageId).toBe("details");
    // A warning moves nothing.
    runtime.setErrors([]);
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "income" });
    runtime.setErrors([{ code: "check", componentId: "email", severity: "warning" }]);
    expect(runtime.journeyView()?.pageId).toBe("income");
  });
});

function describeOf(plan: ReturnType<JourneyEngine["activate"]>): { journeyId: string } | undefined {
  return EagerJourneyEngine.describe(plan);
}

describe("the presentation stage id is spelt the same in the runtime and the eager engine", () => {
  it("pins the duplicated literal", () => {
    const read = (file: string): string => readFileSync(new URL(`../form-engine/runtime/browser/${file}`, import.meta.url), "utf8");
    const literal = 'const PRESENTATION_STAGE_ID = "presentation-fields";';
    expect(read("form-runtime.ts")).toContain(literal);
    expect(read("journey-engine-eager.ts")).toContain(literal);
  });

  it("the Noop engine's stableJson gives the eager engine's text", () => {
    for (const value of [{ b: 1, a: [{ d: 2, c: null }] }, [3, { z: "x", y: true }], "s", 4, null, undefined]) {
      expect(NoopJourneyEngine.serverCheck.stableJson(value)).toBe(EagerJourneyEngine.serverCheck.stableJson(value));
    }
  });
});

describe("the own-field stage words a pattern message from the definition's map", () => {
  /** `apply` with a pattern on the alias `work_email`, the message the form's default-language string. */
  function patterned(): FormDefinition {
    const definition = presentationForm();
    const alias = definition.journey!.journeys![0]!.pages[0]!.components![0] as { configuration: Record<string, unknown> };
    alias.configuration = { ...alias.configuration, pattern: "^\\S+@\\S+$", patternMessage: "Enter a work email" };
    return definition;
  }
  const FRENCH = { fr: { components: { work_email: { patternMessage: { text: "Entrez un courriel de travail", source: sourceHash("Enter a work email") } } } } };

  async function errorsIn(locale: string, translations: typeof FRENCH | undefined, catalog?: object): Promise<string[]> {
    const runtime = build(patterned());
    runtime.startJourney("apply");
    const navigation = (runtime as unknown as { journeyNavigation: { ownFieldErrors(state: object): Promise<Array<{ code: string; parameters?: { message?: string } }>> } }).journeyNavigation;
    const errors = await navigation.ownFieldErrors({ values: { email: "not an email" }, locale, ...(translations ? { translations } : {}), ...(catalog ? { catalog } : {}) });
    return errors.filter((error) => error.code === "pattern").map((error) => error.parameters?.message ?? "");
  }

  it("words the message in the run's locale when the map is carried, and in the default language otherwise", async () => {
    expect(await errorsIn("fr", FRENCH)).toEqual(["Entrez un courriel de travail"]);
    expect(await errorsIn("en", FRENCH)).toEqual(["Enter a work email"]);
    expect(await errorsIn("fr", undefined)).toEqual(["Enter a work email"]);
  });

  it("words it from the host's catalog over the map under the same tag", async () => {
    const catalog = { "fr-CA": { components: { work_email: { patternMessage: "Courriel de travail (catalogue)" } } } };
    const mapFrCa = { "fr-CA": FRENCH.fr };
    expect(await errorsIn("fr-CA", mapFrCa as never, catalog)).toEqual(["Courriel de travail (catalogue)"]);
    // The catalog under the exact tag wins over the map under the primary subtag too.
    expect(await errorsIn("fr-CA", FRENCH, catalog)).toEqual(["Courriel de travail (catalogue)"]);
    // No catalog for the tag: the map words it.
    expect(await errorsIn("fr", FRENCH, catalog)).toEqual(["Entrez un courriel de travail"]);
  });

  it("the runtime hands a running journey's own stage the catalog it was constructed with", async () => {
    const catalog = { "fr-CA": { components: { work_email: { patternMessage: "Courriel de travail (catalogue)" } } } };
    const runtime = build(patterned(), { translationCatalog: catalog });
    runtime.startJourney("apply");
    runtime.setLocale("fr-CA");
    const spy = vi.spyOn((runtime as unknown as { journeyNavigation: { ownFieldErrors(state: object): Promise<unknown> } }).journeyNavigation, "ownFieldErrors");
    await runtime.validate();
    expect(spy).toHaveBeenCalled();
    expect((spy.mock.calls[0]![0] as { catalog?: unknown }).catalog).toEqual(catalog);
  });
});
