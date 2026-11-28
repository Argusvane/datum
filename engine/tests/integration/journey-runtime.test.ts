import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";
import type { Expression } from "../../form-engine/core/expressions/expression.js";
import type { Journey, JourneyConfiguration } from "../../form-engine/core/schema/journey.js";
import type { FormHooks } from "../../form-engine/core/events/hooks.js";
import { FormEventType } from "../../form-engine/core/events/event-types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { DEFAULT_VALIDATION_MESSAGES, resolveValidationMessage } from "../../form-engine/core/localization/validation-messages.js";
import type { FormDraft } from "../../form-engine/persistence/core/draft-store.js";
import { InMemoryDraftStore } from "../../form-engine/persistence/local-storage/in-memory-draft-store.js";
import {
  FormRuntime,
  type FormRuntimeDependencies
} from "../../form-engine/runtime/browser/form-runtime.js";
import { applyJourney as fixtureApplyJourney, presentationForm, workEmailAlias } from "../fixtures/presentation-form.js";
import type {
  WasmSubmissionContext,
  WasmSubmissionOutcome,
  WasmValidationHost,
  WasmValidationRequest
} from "../../form-engine/validation/wasm/wasm-validation-host.js";

/*
 * Journeys in FormRuntime: navigation policy, page validation, events and what a
 * submission carries. The checks against the host's server are journey-server-validation's.
 */

const path = (name: string): Expression => ({ kind: "path", path: name });
const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
const eq = (name: string, value: string | number | boolean): Expression => ({ kind: "binary", operator: "eq", left: path(name), right: literal(value) });
const neq = (name: string, value: string | number | boolean): Expression => ({ kind: "binary", operator: "neq", left: path(name), right: literal(value) });
const lt = (name: string, value: number): Expression => ({ kind: "binary", operator: "lt", left: path(name), right: literal(value) });

function root(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "age", type: "text", configuration: { required: true } },
        { id: "resident", type: "checkbox", configuration: {} },
        { id: "province", type: "text", configuration: { required: true } },
        {
          // A data-scoping container: its field is stored under it, at a data key.
          id: "abroad",
          type: "container",
          configuration: {},
          children: {
            content: [{ id: "country", type: "text", configuration: { required: true, dataKey: "nation" } }]
          }
        },
        { id: "notes", type: "text", configuration: { required: true } },
        // On no page: judged exactly as the whole form judges it — the form does not
        // require it, so its answer is kept and only its shape counts.
        { id: "reference", type: "text", configuration: { maxLength: 5 } }
      ]
    }
  };
}

/**
 * about -> (too young: exit) | residence (resident) | overseas (not resident) -> details -> end.
 */
function applyJourney(overrides: Partial<Journey> = {}): Journey {
  return {
    id: "apply",
    pages: [
      { id: "about", components: ["age", "resident"], routes: [{ when: lt("age", 18), to: "too-young" }, { when: neq("resident", true), to: "overseas" }] },
      { id: "residence", components: ["province"], routes: [{ to: "details" }] },
      { id: "overseas", components: ["abroad"] },
      { id: "details", components: ["notes"], routes: [{ to: "$end" }] },
      { id: "too-young", kind: "exit", title: "Sorry" }
    ],
    validation: { continue: "page" },
    ...overrides
  };
}

function shortJourney(): Journey {
  return { id: "short", pages: [{ id: "only", components: ["age", "resident", "notes"] }] };
}

function definition(journey: JourneyConfiguration = { journeys: [applyJourney(), shortJourney()] }): FormDefinition {
  return {
    id: "eligibility",
    version: "4",
    schemaVersion: "1",
    root: root(),
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
    journey
  };
}

function makeRuntime(
  options: Partial<FormRuntimeDependencies> & { form?: FormDefinition } = {}
): FormRuntime {
  const { form, ...deps } = options;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const shape = form ?? definition();
  return new FormRuntime(shape, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(shape.root)]),
    ...deps
  });
}

const envelope = {
  form: { id: "eligibility", version: "4" },
  client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" }
};

function recordEvents(runtime: FormRuntime, type: string): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  runtime.events().subscribe(type, (event) => seen.push(event.data as Record<string, unknown>));
  return seen;
}

/** Fills the resident branch and walks to the last page. */
async function walkResidentBranch(runtime: FormRuntime): Promise<void> {
  runtime.setValue("age", "30");
  runtime.setValue("resident", true);
  runtime.setValue("province", "ON");
  runtime.setValue("notes", "none");
  expect((await runtime.nextPage()).pageId).toBe("residence");
  expect((await runtime.nextPage()).pageId).toBe("details");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("journey runtime: opening", () => {
  it("opens the definition's default journey on its first page, synchronously", () => {
    const runtime = makeRuntime();
    const view = runtime.journeyView();
    expect(view).toMatchObject({
      journeyId: "apply",
      pageId: "about",
      kind: "questions",
      // Not resident (unanswered): the overseas branch.
      path: ["about", "overseas", "details"],
      index: 0,
      total: 3,
      number: 1,
      completed: [],
      frontierPageId: "about",
      final: false,
      end: "end",
      members: ["age", "resident"],
      validation: { continue: "page", server: false, onUnavailable: "block" }
    });
    expect(view?.backPageId).toBeUndefined();
    expect(view?.pageOf).toMatchObject({ age: "about", abroad: "overseas", country: "overseas", notes: "details" });
    expect(runtime.state().journey).toMatchObject({ journeyId: "apply", pageId: "about" });
    expect(runtime.journeys().map((journey) => journey.id)).toEqual(["apply", "short"]);
  });

  it("resolves the host's choice down the selection ladder", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const both = { journeys: [applyJourney(), shortJourney()] };

    // A journey by id.
    expect(makeRuntime({ journey: "short" }).journeyView()?.journeyId).toBe("short");
    // "form": the whole form on one page.
    expect(makeRuntime({ journey: "form" }).journeyView()).toBeUndefined();
    // "journey": the definition's default journey, even when the definition opens as a form.
    expect(makeRuntime({ form: definition({ ...both, opensAs: "form" }), journey: "journey" }).journeyView()?.journeyId).toBe("apply");
    // Absent: the definition decides — opensAs, then defaultJourneyId, then the first journey.
    expect(makeRuntime({ form: definition({ ...both, opensAs: "form" }) }).journeyView()).toBeUndefined();
    expect(makeRuntime({ form: definition({ ...both, defaultJourneyId: "short" }) }).journeyView()?.journeyId).toBe("short");
    expect(makeRuntime({ form: definition(both) }).journeyView()?.journeyId).toBe("apply");
    // A form with no journey is a form.
    const { journey: _journey, ...plain } = definition();
    expect(makeRuntime({ form: plain }).journeyView()).toBeUndefined();
    expect(makeRuntime({ form: definition({}) }).journeyView()).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();

    // An unknown id warns once and falls back to the definition's choice.
    const unknown = makeRuntime({ form: definition({ ...both, defaultJourneyId: "short" }), journey: "nope" });
    expect(unknown.journeyView()?.journeyId).toBe("short");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/no journey "nope"/);
    unknown.setValue("age", "40");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("honours a deep-linked page only when it is reachable", () => {
    expect(makeRuntime({ page: "about" }).journeyView()?.pageId).toBe("about");
    expect(makeRuntime({ page: "details" }).journeyView()?.pageId).toBe("about");
    expect(makeRuntime({ page: "nowhere" }).journeyView()?.pageId).toBe("about");
  });

  it("takes its journeys from a host-supplied configuration over the definition's (builder preview)", () => {
    let configuration: JourneyConfiguration = { journeys: [shortJourney()] };
    const runtime = makeRuntime({ journeyConfiguration: () => configuration });
    expect(runtime.journeyView()?.journeyId).toBe("short");

    configuration = { journeys: [applyJourney()] };
    runtime.refreshJourney();
    // The running journey has gone from the configuration: the whole form again.
    expect(runtime.journeyView()).toBeUndefined();
    expect(runtime.startJourney().pageId).toBe("about");
    expect(runtime.journeyView()?.journeyId).toBe("apply");
  });

  it("starts and leaves journeys, announcing each change", () => {
    const runtime = makeRuntime();
    const journeys = recordEvents(runtime, FormEventType.JOURNEY_CHANGED);
    const pages = recordEvents(runtime, FormEventType.PAGE_CHANGED);

    expect(runtime.startJourney("short")).toEqual({ ok: true, pageId: "only" });
    expect(runtime.startJourney("missing")).toEqual({ ok: false, reason: "no-journey" });
    runtime.leaveJourney();
    expect(runtime.journeyView()).toBeUndefined();
    expect(runtime.state().journey).toBeUndefined();

    expect(journeys).toEqual([
      { journeyId: "short", previousJourneyId: "apply" },
      { journeyId: null, previousJourneyId: "short" }
    ]);
    expect(pages).toEqual([{ journeyId: "short", fromPageId: null, toPageId: "only", direction: "start", index: 0, total: 1 }]);
  });
});

describe("journey runtime: navigation", () => {
  it("validates only the page on Continue and keeps the errors other pages hold", async () => {
    const runtime = makeRuntime();
    const blocked = recordEvents(runtime, FormEventType.PAGE_BLOCKED);

    const refused = await runtime.nextPage();
    expect(refused).toEqual({ ok: false, pageId: "about", reason: "validation" });
    expect(runtime.errors().map((error) => error.componentId)).toEqual(["age"]);
    expect(blocked).toEqual([{ journeyId: "apply", fromPageId: "about", reason: "validation" }]);

    runtime.setValue("age", "30");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "overseas" });
    expect(runtime.journeyView()).toMatchObject({ pageId: "overseas", completed: ["about"], backPageId: "about", number: 2 });

    // A whole-form validation finds the later page's error too; Continue here keeps it.
    await runtime.validate();
    expect(runtime.errors().map((error) => error.componentId).sort()).toEqual(["country", "notes"]);
    runtime.setValue("abroad.nation", "FR");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(runtime.errors().map((error) => error.componentId)).toEqual(["notes"]);
  });

  it("follows the path back, and refuses a jump past the furthest page reached", async () => {
    const runtime = makeRuntime();
    const pages = recordEvents(runtime, FormEventType.PAGE_CHANGED);
    runtime.setValue("age", "30");
    await runtime.nextPage();

    expect(await runtime.goToPage("details")).toEqual({ ok: false, pageId: "overseas", reason: "unreachable" });
    expect(await runtime.previousPage()).toEqual({ ok: true, pageId: "about" });
    expect(await runtime.previousPage()).toEqual({ ok: false, pageId: "about", reason: "at-start" });
    expect(await runtime.goToPage("overseas")).toEqual({ ok: true, pageId: "overseas" });

    // Back follows the path as the answers draw it now, not the pages visited.
    await runtime.goToPage("about");
    runtime.setValue("resident", true);
    await runtime.nextPage();
    expect(runtime.journeyView()?.pageId).toBe("residence");
    expect(runtime.journeyView()?.backPageId).toBe("about");

    expect(pages.map((entry) => [entry.toPageId, entry.direction])).toEqual([
      ["overseas", "forward"],
      ["about", "back"],
      ["overseas", "jump"],
      ["about", "jump"],
      ["residence", "forward"]
    ]);
    expect(pages[0]).toEqual({ journeyId: "apply", fromPageId: "about", toPageId: "overseas", direction: "forward", index: 1, total: 3 });
  });

  it("prunes completed pages when the answers reroute, and resumes on the path when the page leaves it", async () => {
    const runtime = makeRuntime();
    runtime.setValue("age", "30");
    await runtime.nextPage();
    runtime.setValue("abroad.nation", "FR");
    await runtime.nextPage();
    expect(runtime.journeyView()).toMatchObject({ pageId: "details", completed: ["about", "overseas"] });

    await runtime.goToPage("about");
    runtime.setValue("resident", true);
    expect(runtime.journeyView()).toMatchObject({
      pageId: "about",
      path: ["about", "residence", "details"],
      completed: ["about"],
      frontierPageId: "residence"
    });
    expect((await runtime.goToPage("details")).reason).toBe("unreachable");

    // Answers changed from outside take the page itself off the path: the journey resumes on
    // the last page before it that the path still takes.
    runtime.setValue("resident", false);
    await runtime.nextPage();
    expect(runtime.journeyView()?.pageId).toBe("overseas");
    const pages = recordEvents(runtime, FormEventType.PAGE_CHANGED);
    runtime.setValue("resident", true);
    expect(runtime.journeyView()?.pageId).toBe("residence");
    expect(pages).toEqual([{ journeyId: "apply", fromPageId: "overseas", toPageId: "residence", direction: "resume", index: 1, total: 3 }]);
  });

  it("lets a beforePageChange hook veto a move the person asked for, never one the runtime makes", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const hooks: FormHooks = {
      beforePageChange: [
        (context) => {
          seen.push({ ...context, values: undefined });
          if (context.toPageId === "details") {
            throw new Error("Not yet");
          }
        }
      ]
    };
    const runtime = makeRuntime({ hooks });
    runtime.setValue("age", "30");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "overseas" });
    runtime.setValue("abroad.nation", "FR");
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "vetoed", message: "Not yet" });
    expect(runtime.journeyView()?.completed).toEqual(["about"]);

    // An error move runs no hook.
    expect(await runtime.goToPage("details", { direction: "error" })).toEqual({ ok: true, pageId: "details" });
    expect(seen).toEqual([
      { journeyId: "apply", fromPageId: "about", toPageId: "overseas", direction: "forward", values: undefined },
      { journeyId: "apply", fromPageId: "overseas", toPageId: "details", direction: "forward", values: undefined }
    ]);
  });

  it("keeps the journey and its page across a locale change", async () => {
    const runtime = makeRuntime();
    runtime.setValue("age", "30");
    await runtime.nextPage();
    runtime.setLocale("fr");
    expect(runtime.state().locale).toBe("fr");
    expect(runtime.journeyView()).toMatchObject({ journeyId: "apply", pageId: "overseas", completed: ["about"] });
  });

  it("does not continue from an exit page, and refuses to submit a path that ends at one", async () => {
    const runtime = makeRuntime();
    runtime.setValue("age", "12");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "too-young" });
    expect(runtime.journeyView()).toMatchObject({ kind: "exit", final: true, end: "exit", path: ["about", "too-young"] });
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "too-young", reason: "exit" });

    const result = await runtime.submit("submit", envelope);
    expect(result.accepted).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(["journey.exit"]);
  });
});

describe("journey runtime: what is validated and submitted", () => {
  it("leaves an off-path answer out of the submission, under a data key too, and keeps it for the person", async () => {
    const runtime = makeRuntime();
    runtime.setValue("abroad.nation", "FR");
    await walkResidentBranch(runtime);

    const result = await runtime.submit("submit", envelope);
    expect(result.accepted).toBe(true);
    const submission = result.canonicalSubmission?.submission;
    expect(submission?.journey).toEqual({ id: "apply" });
    expect(submission?.values).toEqual({ age: "30", resident: true, province: "ON", notes: "none" });
    // Stored all the same: switching back to the branch brings it back.
    expect(runtime.state().values["abroad.nation"]).toBe("FR");
    runtime.setValue("resident", false);
    expect(runtime.effectiveState("country")?.visible).toBe(true);
  });

  it("judges a component on no page as the whole form does: not required here, its answer kept and checked; required on the form, it blocks", async () => {
    // A component on no page is judged like the whole form judges it, not hidden.
    const runtime = makeRuntime();
    expect(runtime.effectiveState("reference")).toMatchObject({ visible: true, runValidation: true, requiredApplies: true });
    expect(runtime.isRequired("reference")).toBe(false);
    await walkResidentBranch(runtime);
    const empty = await runtime.submit("submit", envelope);
    expect(empty.accepted).toBe(true);

    runtime.setValue("reference", "R-1");
    const kept = await runtime.submit("submit", envelope);
    expect(kept.canonicalSubmission?.submission.values.reference).toBe("R-1");
    runtime.setValue("reference", "far too long");
    const checked = await runtime.submit("submit", envelope);
    expect(checked.accepted).toBe(false);
    expect(checked.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["reference:maxLength"]);

    // The form requires it: the journey, which leaves it off every page, cannot relax that.
    const strict = definition();
    const reference = strict.root.children!.content!.find((node) => node.id === "reference")!;
    reference.configuration = { ...(reference.configuration as Record<string, unknown>), required: true };
    const held = makeRuntime({ form: strict });
    expect(held.isRequired("reference")).toBe(true);
    await walkResidentBranch(held);
    const blocked = await held.submit("submit", envelope);
    expect(blocked.accepted).toBe(false);
    expect(blocked.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["reference:required"]);
    // No page on the path holds the error, so the person stays where they are; the summary says it.
    expect(held.journeyView()?.pageId).toBe("details");
    held.setValue("reference", "R-1");
    expect((await held.submit("submit", envelope)).accepted).toBe(true);
  });

  it("carries no journey in a submission made on one page", async () => {
    const runtime = makeRuntime({ journey: "form" });
    for (const [key, value] of Object.entries({ age: "30", province: "ON", "abroad.nation": "FR", notes: "n", reference: "R" })) {
      runtime.setValue(key, value);
    }
    const result = await runtime.submit("submit", envelope);
    expect(result.accepted).toBe(true);
    expect(result.canonicalSubmission?.submission).not.toHaveProperty("journey");
  });

  it("moves a submit's errors to the earliest page holding one", async () => {
    const runtime = makeRuntime();
    await walkResidentBranch(runtime);
    const pages = recordEvents(runtime, FormEventType.PAGE_CHANGED);
    runtime.setValue("province", "");
    runtime.setValue("notes", "");

    const result = await runtime.submit("submit", envelope);
    expect(result.accepted).toBe(false);
    expect(runtime.journeyView()?.pageId).toBe("residence");
    expect(pages).toEqual([{ journeyId: "apply", fromPageId: "details", toPageId: "residence", direction: "error", index: 1, total: 3 }]);
    expect(runtime.errors().map((error) => error.componentId).sort()).toEqual(["notes", "province"]);
  });

  it("shows a host's error on an off-path field without moving, and moves to an on-path one", async () => {
    const runtime = makeRuntime();
    await walkResidentBranch(runtime);

    runtime.setErrors([{ code: "server.flag", componentId: "country" }]);
    expect(runtime.errors().map((error) => error.code)).toEqual(["server.flag"]);
    expect(runtime.journeyView()?.pageId).toBe("details");

    runtime.setErrors([{ code: "server.flag", path: "province" }]);
    expect(runtime.journeyView()?.pageId).toBe("residence");
  });

  it("validates the whole path with validate(), and one page with validate({ page })", async () => {
    const runtime = makeRuntime();
    await runtime.validate();
    // Off the path (residence): not validated. On no page (reference): judged as on the form, which does not require it.
    expect(runtime.errors().map((error) => error.componentId).sort()).toEqual(["age", "country", "notes"]);

    await runtime.validate({ page: "details" });
    expect(runtime.errors().map((error) => error.componentId).sort()).toEqual(["age", "country", "notes"]);
    runtime.setValue("notes", "done");
    await runtime.validate({ page: "details" });
    expect(runtime.errors().map((error) => error.componentId).sort()).toEqual(["age", "country"]);
  });

  it("hands the sandbox what the envelope will carry, with the journey, and fails closed on a filtered block", async () => {
    const requests: WasmSubmissionContext[] = [];
    const recording = {
      run: async (request: WasmValidationRequest): Promise<WasmSubmissionOutcome> => {
        requests.push(request.context);
        return { errors: [], values: request.context.values };
      }
    } as unknown as WasmValidationHost;
    const runtime = makeRuntime({ wasmValidationHost: recording });
    runtime.setValue("abroad.nation", "FR");
    await walkResidentBranch(runtime);
    expect((await runtime.submit("submit", envelope)).accepted).toBe(true);
    expect(requests[0]?.values).toEqual({ age: "30", resident: true, province: "ON", notes: "none" });
    expect(requests[0]?.journey?.id).toBe("apply");

    // A sandbox that blocks on an off-path field — a plugin that did not know the path — and
    // so returned no sanitized values: its error is filtered, and nothing is left to submit.
    const blocking = {
      run: async (): Promise<WasmSubmissionOutcome> => ({
        errors: [{ code: "plugin.flag", componentId: "country", path: "abroad.nation", stage: "plugin", source: "custom" }]
      })
    } as unknown as WasmValidationHost;
    const closed = makeRuntime({ wasmValidationHost: blocking });
    await walkResidentBranch(closed);
    const result = await closed.submit("submit", envelope);
    expect(result.accepted).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(["wasm.values-missing"]);
  });
});

describe("journey runtime: the submittable view", () => {
  it("lets no rule read an answer that is hidden and excluded from the submission", () => {
    // Without any journey: the change applies to every form, since a server never sees such an answer.
    const shape: FormDefinition = {
      id: "view",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "gate", type: "checkbox", configuration: {} },
            {
              id: "secret",
              type: "text",
              configuration: { hiddenValueBehavior: "exclude-from-submission" },
              rules: { visibleWhen: eq("gate", true) }
            },
            { id: "echo", type: "text", configuration: {}, rules: { visibleWhen: eq("secret", "open") } }
          ]
        }
      }
    };
    const runtime = makeRuntime({ form: shape });
    runtime.setValue("gate", true);
    runtime.setValue("secret", "open");
    expect(runtime.effectiveState("echo")?.visible).toBe(true);

    // The answer stays stored, but hidden and excluded it no longer shows `echo`.
    runtime.setValue("gate", false);
    expect(runtime.state().values.secret).toBe("open");
    expect(runtime.effectiveState("echo")?.visible).toBe(false);
  });
});

describe("journey runtime: per-page validation policy", () => {
  it("moves on from a deferred page and surfaces its errors at the end", async () => {
    const runtime = makeRuntime({
      form: definition({ journeys: [applyJourney({ validation: { continue: "defer" } })] })
    });
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "overseas" });
    expect(runtime.errors()).toEqual([]);
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(runtime.journeyView()?.completed).toEqual(["about", "overseas"]);

    const result = await runtime.submit("submit", envelope);
    expect(result.accepted).toBe(false);
    expect(runtime.journeyView()?.pageId).toBe("about");
    expect(runtime.errors().map((error) => error.componentId).sort()).toEqual(["age", "country", "notes"]);
  });

  it("lets a page override the journey's policy", async () => {
    const journey = applyJourney({ validation: { continue: "defer" } });
    journey.pages[2] = { ...journey.pages[2]!, validation: { continue: "page" } };
    const runtime = makeRuntime({ form: definition({ journeys: [journey] }) });
    expect(runtime.journeyView()?.validation.continue).toBe("defer");
    await runtime.nextPage();
    expect(runtime.journeyView()?.validation.continue).toBe("page");
    expect((await runtime.nextPage()).reason).toBe("validation");
  });

  it("validates a deferred page that holds an error that blocks, so a fix can be confirmed", async () => {
    const runtime = makeRuntime({
      form: definition({ journeys: [applyJourney({ validation: { continue: "defer" } })] })
    });
    runtime.setValue("age", "30");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "overseas" });
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });

    // The submit finds the deferred page's error and goes back to it.
    runtime.setValue("notes", "none");
    expect((await runtime.submit("submit", envelope)).accepted).toBe(false);
    expect(runtime.journeyView()?.pageId).toBe("overseas");

    // Now Continue validates it: unfixed it stays, fixed it moves on.
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "validation" });
    runtime.setValue("abroad.nation", "FR");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(runtime.errors()).toEqual([]);
  });

  it("ignores a server check on a deferred page", async () => {
    const asked: unknown[] = [];
    const journey = applyJourney();
    journey.pages[2] = { ...journey.pages[2]!, validation: { continue: "defer", server: true } };
    const runtime = makeRuntime({
      form: definition({ journeys: [journey] }),
      journeyServerValidator: async (request) => {
        asked.push(request);
        return { errors: [] };
      }
    });
    runtime.setValue("age", "30");
    await runtime.nextPage();
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(asked).toEqual([]);
  });
});

describe("journey runtime: moves the hooks approved, once the path has changed under them", () => {
  /** A `beforePageChange` hook held open, as an autosave awaiting the network is. */
  function heldHooks(): { hooks: FormHooks; hold: () => { entered: Promise<void>; release: () => void } } {
    let holding: { entered: () => void; gate: Promise<void> } | undefined;
    return {
      hooks: {
        beforePageChange: [
          async () => {
            const held = holding;
            if (held) {
              held.entered();
              await held.gate;
            }
          }
        ]
      },
      hold: () => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const enteredPromise = new Promise<void>((resolve) => {
          entered = resolve;
        });
        holding = { entered, gate };
        return {
          entered: enteredPromise,
          release: () => {
            holding = undefined;
            release();
          }
        };
      }
    };
  }

  it("refuses Continue, Back and a jump whose target the rerouted path no longer takes there", async () => {
    const { hooks, hold } = heldHooks();
    const runtime = makeRuntime({ hooks });
    const blocked = recordEvents(runtime, FormEventType.PAGE_BLOCKED);
    runtime.setValue("age", "30");
    runtime.setValue("resident", true);

    // Continue to "residence", and the person unticks resident while the hook is out.
    const forward = hold();
    const continuing = runtime.nextPage();
    await forward.entered;
    runtime.setValue("resident", false);
    forward.release();
    expect(await continuing).toEqual({ ok: false, pageId: "about", reason: "cancelled" });
    expect(runtime.journeyView()).toMatchObject({ pageId: "about", path: ["about", "overseas", "details"], completed: [] });
    expect(blocked.at(-1)).toEqual({ journeyId: "apply", fromPageId: "about", toPageId: "residence", reason: "cancelled" });
    // Continue again asks the hooks about the page the path takes now.
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "overseas" });

    // Back from "details" to "residence", rerouted under the hook to "overseas".
    await runtime.previousPage();
    runtime.setValue("resident", true);
    runtime.setValue("province", "ON");
    runtime.setValue("notes", "none");
    expect((await runtime.nextPage()).pageId).toBe("residence");
    expect((await runtime.nextPage()).pageId).toBe("details");
    const back = hold();
    const going = runtime.previousPage();
    await back.entered;
    runtime.setValue("resident", false);
    back.release();
    expect(await going).toEqual({ ok: false, pageId: "details", reason: "cancelled" });
    expect(runtime.journeyView()).toMatchObject({ pageId: "details", backPageId: "overseas" });

    // A jump to a page the path then leaves.
    runtime.setValue("resident", true);
    const jump = hold();
    const jumping = runtime.goToPage("residence");
    await jump.entered;
    runtime.setValue("resident", false);
    jump.release();
    expect(await jumping).toEqual({ ok: false, pageId: "details", reason: "cancelled" });
    expect(runtime.journeyView()?.pageId).toBe("details");
  });
});

describe("journey runtime: a deep-linked page", () => {
  function draftOf(completed: string[], page: string): FormDraft {
    return {
      id: "resume",
      formId: "eligibility",
      formVersion: "4",
      runtime: { schemaVersion: "1", rendererVersion: "0.1.0" },
      locale: "en",
      values: { age: "30", "abroad.nation": "FR" },
      state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [], journey: { id: "apply", page, completed } },
      updatedAt: 0
    };
  }

  it("opens on it once a draft restored before the first move reaches it", async () => {
    // Nothing is completed at the start: the first page opens, and the link waits.
    const linked = makeRuntime({ page: "details" });
    expect(linked.journeyView()?.pageId).toBe("about");
    const pages = recordEvents(linked, FormEventType.PAGE_CHANGED);
    await linked.hydrateFromDraft(draftOf(["about", "overseas"], "overseas"));
    expect(linked.journeyView()?.pageId).toBe("details");
    expect(pages).toEqual([{ journeyId: "apply", fromPageId: "about", toPageId: "details", direction: "resume", index: 2, total: 3 }]);

    // Without a link, the draft's own page.
    const plain = makeRuntime();
    await plain.hydrateFromDraft(draftOf(["about", "overseas"], "overseas"));
    expect(plain.journeyView()?.pageId).toBe("overseas");

    // A link the draft's completed pages do not reach: the draft's own page.
    const tooFar = makeRuntime({ page: "details" });
    await tooFar.hydrateFromDraft(draftOf(["about"], "overseas"));
    expect(tooFar.journeyView()?.pageId).toBe("overseas");

    // The person's first move forgets it.
    const moved = makeRuntime({ page: "details" });
    moved.setValue("age", "30");
    expect((await moved.nextPage()).pageId).toBe("overseas");
    await moved.previousPage();
    await moved.hydrateFromDraft(draftOf(["about", "overseas"], "about"));
    expect(moved.journeyView()?.pageId).toBe("about");
  });
});

describe("journey runtime: repeating sections stored at their own collection path", () => {
  const orders = (): FormDefinition => ({
    id: "orders",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "kind", type: "select", configuration: { options: [{ value: "short", label: "short" }, { value: "full", label: "full" }, { value: "skip", label: "skip" }, { value: "next", label: "next" }, { value: "route", label: "route" }, { value: "summary", label: "summary" }, { value: "questions", label: "questions" }] } },
          {
            id: "items",
            type: "repeatingSection",
            configuration: {},
            collection: { collectionPath: "order_lines" },
            children: { content: [{ id: "sku", type: "text", configuration: {} }] }
          },
          {
            // What the data-model generator writes: a section inside a container, stored at a dotted path.
            id: "order",
            type: "container",
            configuration: {},
            children: {
              content: [
                {
                  id: "order_items",
                  type: "repeatingSection",
                  configuration: {},
                  collection: { collectionPath: "order.items" },
                  children: { content: [{ id: "code", type: "text", configuration: {} }] }
                }
              ]
            }
          }
        ]
      }
    },
    journey: {
      journeys: [
        {
          id: "buy",
          pages: [
            { id: "start", components: ["kind"], routes: [{ when: neq("kind", "full"), to: "$end" }] },
            { id: "full", components: ["items", "order_items"] }
          ]
        }
      ]
    }
  });

  it("leaves an abandoned branch's entries out of the sandbox's request and the submission", async () => {
    const requests: WasmSubmissionContext[] = [];
    const recording = {
      run: async (request: WasmValidationRequest): Promise<WasmSubmissionOutcome> => {
        requests.push(request.context);
        return { errors: [], values: request.context.values };
      }
    } as unknown as WasmValidationHost;
    const runtime = makeRuntime({ form: orders(), wasmValidationHost: recording });
    runtime.setValue("kind", "full");
    runtime.addRow("order_lines", { sku: "abandoned" });
    runtime.addRow("order.items", { code: "abandoned" });
    runtime.setValue("kind", "short");
    expect(runtime.journeyView()?.path).toEqual(["start"]);

    const result = await runtime.submit("submit", envelope);
    expect(result.accepted).toBe(true);
    expect(requests[0]?.values).toEqual({ kind: "short" });
    expect(result.canonicalSubmission?.submission.values).toEqual({ kind: "short" });
    // Kept for the person all the same.
    expect(runtime.state().values["order_lines[0].sku"]).toBe("abandoned");

    // On the path, they are sent.
    runtime.setValue("kind", "full");
    const taken = await runtime.submit("submit", envelope);
    // Each section's entries as one list at its collection path.
    expect(taken.canonicalSubmission?.submission.values).toEqual({
      kind: "full",
      order_lines: [{ sku: "abandoned" }],
      "order.items": [{ code: "abandoned" }]
    });
  });

  it("judges the entries as the section without a journey too: hidden and excluded, they are not sent", async () => {
    const shape: FormDefinition = {
      id: "lines",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "gate", type: "checkbox", configuration: {} },
            {
              id: "lines",
              type: "repeatingSection",
              configuration: { hiddenValueBehavior: "exclude-from-submission" },
              rules: { visibleWhen: eq("gate", true) },
              collection: { collectionPath: "line_data" },
              children: { content: [{ id: "line", type: "text", configuration: {} }] }
            }
          ]
        }
      }
    };
    const runtime = makeRuntime({ form: shape });
    runtime.setValue("gate", true);
    runtime.addRow("line_data", { line: "a" });
    runtime.setValue("gate", false);
    const result = await runtime.submit("submit", envelope);
    expect(result.canonicalSubmission?.submission.values).toEqual({ gate: false });
  });
});

describe("journey runtime: a fold that does not settle", () => {
  // `a` shows while `b` is empty, `b` while `a` is answered; both are excluded when hidden, so
  // with both answered each hides the other in turn and the fold never settles.
  const cycling = (journey?: Journey): FormDefinition => ({
    id: "cycle",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "a",
            type: "text",
            configuration: { required: true, hiddenValueBehavior: "exclude-from-submission" },
            // empty() keeps each rule a real yes or no: a condition holds only for true (strict truthiness).
            rules: { visibleWhen: { kind: "call", name: "empty", args: [path("b")] } }
          },
          { id: "b", type: "text", configuration: { hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: { kind: "unary", operator: "not", operand: { kind: "call", name: "empty", args: [path("a")] } } } },
          { id: "c", type: "text", configuration: {} },
          { id: "d", type: "text", configuration: {} }
        ]
      }
    },
    ...(journey ? { journey: { journeys: [journey] } } : {})
  });

  it("refuses the submit with fold.unsettled before the sandbox, and lets it through once an answer settles it", async () => {
    let asked = 0;
    const sandbox = {
      run: async (request: WasmValidationRequest): Promise<WasmSubmissionOutcome> => {
        asked += 1;
        return { errors: [], values: request.context.values };
      }
    } as unknown as WasmValidationHost;
    const runtime = makeRuntime({ form: cycling(), wasmValidationHost: sandbox });
    runtime.setValue("a", "x");
    runtime.setValue("b", "y");

    const refused = await runtime.submit("submit", envelope);
    expect(refused.accepted).toBe(false);
    expect(refused.errors.map((error) => [error.componentId, error.code, error.severity])).toEqual([[undefined, "fold.unsettled", "error"]]);
    expect(asked).toBe(0);
    expect(resolveValidationMessage(refused.errors[0]!, undefined, "en")).toBe(DEFAULT_VALIDATION_MESSAGES["fold.unsettled"]);
    expect(DEFAULT_VALIDATION_MESSAGES["fold.unsettled"]).toBeTruthy();

    runtime.setValue("b", "");
    const accepted = await runtime.submit("submit", envelope);
    expect(accepted.accepted).toBe(true);
    expect(asked).toBe(1);
  });

  it("refuses Continue on the page, with one form-level error however often it is asked", async () => {
    const runtime = makeRuntime({
      // `c` keeps the first page from being empty (and skipped) while both of the others are hidden.
      form: cycling({ id: "loop", validation: { continue: "page" }, pages: [{ id: "first", components: ["a", "b", "c"] }, { id: "second", components: ["d"] }] })
    });
    runtime.setValue("a", "x");
    runtime.setValue("b", "y");
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "first", reason: "validation" });
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "first", reason: "validation" });
    expect(runtime.errors().map((error) => [error.componentId, error.code])).toEqual([[undefined, "fold.unsettled"]]);

    runtime.setValue("b", "");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "second" });
    expect(runtime.errors()).toEqual([]);
  });
});

describe("journey runtime: errors kept to the path", () => {
  const codes = (runtime: FormRuntime): string[] => runtime.errors().map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();

  it("drops a page's errors once its components leave the path, announcing it", async () => {
    const runtime = makeRuntime();
    runtime.setValue("age", "30");
    runtime.setValue("resident", true);
    expect((await runtime.nextPage()).pageId).toBe("residence");
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "residence", reason: "validation" });
    expect(codes(runtime)).toEqual(["province:required"]);

    await runtime.previousPage();
    const changed = recordEvents(runtime, FormEventType.ERRORS_CHANGED);
    const pages = recordEvents(runtime, FormEventType.PAGE_CHANGED);
    runtime.setValue("resident", false);
    // Province is off the path: never validated, so its error is not the person's to fix.
    expect(runtime.errors()).toEqual([]);
    expect(changed).toEqual([{ errorCount: 0 }]);
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "overseas" });
    expect(runtime.errors()).toEqual([]);
    expect(pages.map((entry) => entry.toPageId)).toEqual(["overseas"]);
  });

  it("keeps a host's error on an off-path field until the path changes, and a server's on an answer still sent", async () => {
    const runtime = makeRuntime();
    await walkResidentBranch(runtime);
    runtime.setErrors([
      { code: "server.flag", componentId: "country" },
      { code: "server.reference", componentId: "reference" }
    ]);
    // The path is as it was: a page's validation leaves them be.
    await runtime.validate({ page: "details" });
    expect(codes(runtime)).toEqual(["country:server.flag", "reference:server.reference"]);

    // A reroute takes country onto the path: its error stands there.
    runtime.setValue("resident", false);
    expect(codes(runtime)).toEqual(["country:server.flag", "reference:server.reference"]);
    // And off it again, excluded from the submission: gone. The field on no page still submits: kept.
    runtime.setValue("resident", true);
    expect(codes(runtime)).toEqual(["reference:server.reference"]);
  });

  it("keeps the errors on required components another journey leaves off every page, and drops those its path skips, when it starts", async () => {
    const runtime = makeRuntime();
    await runtime.validate();
    expect(codes(runtime)).toEqual(["age:required", "country:required", "notes:required"]);
    // `short` asks for no country, but the form requires one: judged as the whole form,
    // the field stays required and its error stands.
    runtime.startJourney("short");
    expect(codes(runtime)).toEqual(["age:required", "country:required", "notes:required"]);
    // Back on `apply` as a resident, the country's page is off the path: that error goes.
    runtime.setValue("resident", true);
    runtime.startJourney("apply");
    expect(codes(runtime)).toEqual(["age:required", "notes:required"]);
  });
});

// --- Presentations: a journey that asks the form through nodes of its own --------

const presentationEnvelope = {
  form: { id: "presentation", version: "1.0.0" },
  client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1.0.0" }
};

function presentationRuntime(options: Partial<FormRuntimeDependencies> & { form?: FormDefinition; journeys?: Journey[] } = {}): FormRuntime {
  const { form, journeys, ...deps } = options;
  const shape: FormDefinition = form ?? { ...presentationForm(), localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] } };
  if (journeys !== undefined) {
    shape.journey = { journeys };
  }
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(shape, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(shape.root)]),
    ...deps
  });
}

/** `componentId:code` of every stored error, sorted. */
function errorCodes(runtime: FormRuntime): string[] {
  return runtime.errors().map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
}

/**
 * details: an alias, an own required field, and an own required field its own rule hides;
 * extra (only when the name says so): an own required field on a page the path may skip;
 * income: the fixture's.
 */
/** The fixture's journey, checking each page on Continue (the engine default moves on). */
function presentationApplyJourney(): Journey {
  return { ...fixtureApplyJourney(), validation: { continue: "page" } };
}

function guardedJourney(): Journey {
  const fixture = presentationApplyJourney();
  return {
    id: "apply",
    validation: { continue: "page" },
    pages: [
      {
        id: "details",
        components: [
          workEmailAlias(),
          { id: "nick", type: "text", configuration: { label: "Nickname", required: true, maxLength: 8 } },
          { id: "secret", type: "text", configuration: { label: "Secret", required: true }, rules: { visibleWhen: eq("nick", "show") } }
        ],
        routes: [{ when: neq("name", "more"), to: "income" }]
      },
      { id: "extra", components: [{ id: "more_info", type: "text", configuration: { label: "More", required: true } }] },
      { ...(fixture.pages[1] as Journey["pages"][number]), routes: [] }
    ]
  };
}

describe("journey runtime: presentations — one lookup for a node's state", () => {
  it("Continue holds the page to its own fields, its alias's field and nothing an overlay hides or another page asks", async () => {
    const runtime = presentationRuntime({ journeys: [guardedJourney()] });
    expect(runtime.journeyView()).toMatchObject({ pageId: "details", path: ["details", "income"], members: ["work_email", "nick", "secret"] });

    expect(await runtime.nextPage()).toMatchObject({ ok: false, reason: "validation", pageId: "details" });
    // The form's own rule on the form field, the alias's own tick, the own field's — and neither
    // the field its own rule hides nor the one on the page the path skips.
    expect(errorCodes(runtime)).toEqual(["email:required", "nick:required", "work_email:required"]);
    expect(runtime.errors().find((error) => error.componentId === "nick")).toMatchObject({ stage: "presentation-fields", source: "client" });
    expect(runtime.errors().find((error) => error.componentId === "work_email")?.path).toEqual({ segments: [{ key: "email" }] });
    expect(runtime.effectiveState("secret")).toMatchObject({ visible: false, runValidation: false, requiredApplies: false });
    expect(runtime.effectiveState("more_info")).toMatchObject({ visible: false, runValidation: false });
    expect(runtime.isRequired("secret")).toBe(true);
    expect(runtime.requiredMap().get("more_info")).toBe(true);
    expect(runtime.effectiveStatesMap().get("nick")).toMatchObject({ visible: true, runValidation: true });

    // An own field's shape is held like a form field's.
    runtime.setValue("email", "ada@example.org");
    runtime.setValue("@apply.nick", "far too long a name");
    expect((await runtime.nextPage()).reason).toBe("validation");
    expect(errorCodes(runtime)).toEqual(["nick:maxLength"]);

    runtime.setValue("@apply.nick", "Ada");
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    expect(runtime.errors()).toEqual([]);

    // Shown by its own rule, the hidden field is held to its Required on Continue.
    await runtime.previousPage();
    runtime.setValue("@apply.nick", "show");
    expect(runtime.effectiveState("secret")?.visible).toBe(true);
    expect((await runtime.nextPage()).reason).toBe("validation");
    expect(errorCodes(runtime)).toEqual(["secret:required"]);
    // Hidden again, its error goes with it and the page may be left.
    runtime.setValue("@apply.nick", "Ada");
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    expect(runtime.errors()).toEqual([]);
  });

  it("a submit judges the whole path the same way: on-path own fields block, off-path and hidden ones never do", async () => {
    const runtime = presentationRuntime({ journeys: [guardedJourney()] });
    runtime.setValue("email", "ada@example.org");
    runtime.setValue("@apply.nick", "Ada");
    runtime.setValue("@apply.m1", 100);
    expect((await runtime.nextPage()).pageId).toBe("income");

    // `secret` is hidden by its rule and `more_info` is on a page the path skips: both required,
    // both empty, neither asked.
    const sent = await runtime.submit("submit", presentationEnvelope);
    expect(sent.errors).toEqual([]);
    expect(sent.accepted).toBe(true);
    expect(sent.canonicalSubmission?.submission.values).toEqual({ email: "ada@example.org", annual_income: 100 });

    // On the path, the same field blocks the submit and the person is taken to its page.
    runtime.setValue("name", "more");
    expect(runtime.journeyView()?.path).toEqual(["details", "extra", "income"]);
    const blocked = await runtime.submit("submit", presentationEnvelope);
    expect(blocked.accepted).toBe(false);
    expect(blocked.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["more_info:required"]);
    expect(runtime.journeyView()?.pageId).toBe("extra");

    // Off the path again: the stale-error sweep drops it, as it drops a form field's.
    runtime.setValue("name", "less");
    expect(runtime.errors()).toEqual([]);

    // Shown by its own rule, the hidden one blocks the submit too.
    runtime.setValue("@apply.nick", "show");
    const hidden = await runtime.submit("submit", presentationEnvelope);
    expect(hidden.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["secret:required"]);
    expect(runtime.journeyView()?.pageId).toBe("details");
    // Hidden again by its own rule, it no longer blocks: the next validation finds nothing (its
    // stored error waits for that run, as a form field's hidden by its own rule does).
    runtime.setValue("@apply.nick", "Ada");
    const again = await runtime.submit("submit", presentationEnvelope);
    expect(again.accepted).toBe(true);
    expect(runtime.errors()).toEqual([]);
  });

  it("validate({ page }) keeps the errors of own nodes, referenced fields and filled or worked-out fields on that page", async () => {
    const runtime = presentationRuntime();
    await runtime.validate({ page: "income" });
    // The worked-out field, judged by the form's own rule on the page that works it out.
    expect(errorCodes(runtime)).toEqual(["annual_income:required"]);
    await runtime.validate({ page: "details" });
    expect(errorCodes(runtime)).toEqual(["annual_income:required", "email:required", "work_email:required"]);
    // The whole path at once.
    await runtime.validate();
    expect(errorCodes(runtime)).toEqual(["annual_income:required", "email:required", "work_email:required"]);

    // The variant: its references' fields are the page's; the required field it leaves out is the form's.
    const variant = presentationRuntime({ journey: "public" });
    await variant.validate({ page: "all" });
    expect(errorCodes(variant)).toEqual(["email:required"]);
    await variant.validate();
    expect(errorCodes(variant)).toEqual(["annual_income:required", "email:required"]);
  });

  it("reports worked-out values that do not settle as one blocking form-level error, on Continue and on submit", async () => {
    const journey = presentationApplyJourney();
    const income = journey.pages[1] as Journey["pages"][number];
    income.components = (income.components ?? []).map((entry) =>
      typeof entry !== "string" && entry.id === "m2" ? { ...entry, rules: { visibleWhen: lt("annual_income", 100) } } : entry
    );
    const runtime = presentationRuntime({ journeys: [journey] });
    runtime.setValue("email", "ada@example.org");
    runtime.setValue("@apply.m1", 50);
    runtime.setValue("@apply.m2", 60);
    expect((await runtime.nextPage()).reason).toBe("validation");
    expect(runtime.errors()).toEqual([expect.objectContaining({ code: "map.unsettled", stage: "state", source: "client", severity: "error" })]);
    expect(runtime.errors()[0]?.componentId).toBeUndefined();
    expect(resolveValidationMessage(runtime.errors()[0]!, undefined, "en")).toBe(DEFAULT_VALIDATION_MESSAGES["map.unsettled"]);
    expect(DEFAULT_VALIDATION_MESSAGES["map.unsettled"]).toMatch(/could not be checked/);
    expect((await runtime.nextPage()).reason).toBe("validation");
    expect(runtime.errors()).toHaveLength(1);
    const refused = await runtime.submit("submit", presentationEnvelope);
    expect(refused.accepted).toBe(false);
    expect(refused.errors.map((error) => error.code)).toEqual(["map.unsettled"]);

    runtime.setValue("@apply.m2", 10);
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    expect(runtime.errors()).toEqual([]);
    expect((await runtime.submit("submit", presentationEnvelope)).accepted).toBe(true);
  });
});

describe("journey runtime: presentations — error hosts, leaving, prefill and locale", () => {
  it("names the node that shows a form field's errors: the first alias that shows, else the worked-out copy, never beside the field itself", async () => {
    const runtime = presentationRuntime();
    expect({ ...runtime.journeyView()?.hosts }).toEqual({ email: "work_email" });
    expect(Object.getPrototypeOf(runtime.journeyView()?.hosts)).toBeNull();
    runtime.setValue("email", "ada@example.org");
    await runtime.nextPage();
    expect({ ...runtime.journeyView()?.hosts }).toEqual({ annual_income: "income_total" });

    // A server's and a host's errors keep naming the form field; the page they are on is the node's.
    runtime.setErrors([{ code: "taken", componentId: "email" }]);
    expect(runtime.journeyView()?.pageId).toBe("details");
    expect(runtime.errors()[0]).toMatchObject({ componentId: "email", code: "taken" });
    // A host naming an own answer by its key means the own field, on its page.
    runtime.setErrors([{ code: "odd", path: "@apply.m2" }]);
    expect(runtime.errors()[0]).toMatchObject({ componentId: "m2", code: "odd" });
    expect(runtime.journeyView()?.pageId).toBe("income");
    // A key of a presentation that is not running names nothing.
    runtime.setErrors([{ code: "odd", path: "@public.note" }]);
    expect(runtime.errors()[0]?.componentId).toBeUndefined();

    // Two aliases of one field on a page: the first that shows. The field listed beside them: none.
    const second = { id: "other_email", type: "text", configuration: { fills: "email" } };
    const twice = presentationRuntime({ journeys: [{ id: "apply", pages: [{ id: "details", components: [second, workEmailAlias(), "name"] }] }] });
    expect({ ...twice.journeyView()?.hosts }).toEqual({ email: "other_email" });
    const beside = presentationRuntime({ journeys: [{ id: "apply", pages: [{ id: "details", components: [workEmailAlias(), "email"] }] }] });
    expect({ ...beside.journeyView()?.hosts }).toEqual({});
    // References draw the field itself: the variant hosts nothing.
    const variant = presentationRuntime({ journey: "public" });
    expect({ ...variant.journeyView()?.hosts }).toEqual({});
    expect(variant.journeyView()?.members).toEqual(["contact", "public_note"]);
  });

  it("leaving a presentation clears its own errors, stops its worked-out values and leaves what they set as ordinary answers", async () => {
    const runtime = presentationRuntime();
    runtime.setValue("@apply.m1", 300);
    expect(runtime.state().journey?.written).toEqual({ annual_income: 300 });
    await runtime.validate();
    expect(errorCodes(runtime)).toEqual(["email:required", "work_email:required"]);

    runtime.leaveJourney();
    // The alias's own error went with it; the form's own rule on the form field stands.
    expect(errorCodes(runtime)).toEqual(["email:required"]);
    expect(runtime.state().journey).toBeUndefined();
    expect(runtime.state().values.annual_income).toBe(300);
    expect(runtime.effectiveState("m1")).toBeUndefined();
    expect(runtime.requiredMap().has("work_email")).toBe(false);
    expect([...runtime.effectiveStatesMap().keys()]).toEqual(["form", "email", "name", "money", "annual_income", "approved_amount"]);
    // The mappings stopped: a source changing, or emptied, moves nothing.
    runtime.setValue("@apply.m1", 999);
    expect(runtime.state().values.annual_income).toBe(300);
    runtime.setValue("@apply.m1", undefined);
    expect(runtime.state().values.annual_income).toBe(300);
    // And the whole form is judged with no own field in it.
    runtime.setValue("email", "ada@example.org");
    const whole = await runtime.submit("submit", presentationEnvelope);
    expect(whole.accepted).toBe(true);
    expect(whole.canonicalSubmission?.submission).toMatchObject({ values: { email: "ada@example.org", annual_income: 300 } });

    // Another journey starting clears them the same way, and an unsettled worked-out value too.
    const switching = presentationRuntime();
    await switching.validate();
    expect(errorCodes(switching)).toEqual(["annual_income:required", "email:required", "work_email:required"]);
    expect(switching.startJourney("public").ok).toBe(true);
    expect(errorCodes(switching)).toEqual(["annual_income:required", "email:required"]);
    expect(switching.state().journey?.written).toBeUndefined();
  });

  it("shows a prefilled field through its alias and its worked-out copy, and keeps it while the sources are empty", async () => {
    const runtime = presentationRuntime();
    // A host's prefill, set as any form value.
    runtime.setValue("email", "prefilled@example.org");
    runtime.setValue("annual_income", 40000);
    expect(runtime.state().values[runtime.presentationValuePathOf("work_email") as string]).toBe("prefilled@example.org");
    expect(runtime.state().values[runtime.presentationValuePathOf("income_total") as string]).toBe(40000);
    expect(runtime.state().journey?.written).toBeUndefined();
    // Nothing on the page was answered: Continue and the submit take the prefill as it is.
    expect((await runtime.nextPage()).pageId).toBe("income");
    const sent = await runtime.submit("submit", presentationEnvelope);
    expect(sent.accepted).toBe(true);
    expect(sent.canonicalSubmission?.submission.values).toEqual({ email: "prefilled@example.org", annual_income: 40000 });
    // Once a source is answered the page works the field out.
    runtime.setValue("@apply.m1", 10);
    expect(runtime.state().values.annual_income).toBe(10);
  });

  it("keeps the page, the own answers and the overlay across a locale change", async () => {
    const runtime = presentationRuntime();
    runtime.setValue("email", "ada@example.org");
    runtime.setValue("@apply.m1", 20000);
    await runtime.nextPage();
    runtime.setLocale("fr");
    expect(runtime.journeyView()).toMatchObject({ journeyId: "apply", pageId: "income", completed: ["details"] });
    expect(runtime.state().locale).toBe("fr");
    expect(runtime.presentationValues()).toEqual({ m1: 20000 });
    expect(runtime.state().values.annual_income).toBe(20000);
    expect(runtime.state().journey?.written).toEqual({ annual_income: 20000 });
    expect(runtime.effectiveState("income_total")).toMatchObject({ visible: true, readonly: true });
    expect({ ...runtime.journeyView()?.hosts }).toEqual({ annual_income: "income_total" });
  });

  it("treats own fields called `isPrototypeOf` and `toString` as fields, and drops one called `__proto__` without touching anything (`isPrototypeOf` and `prototype` are reserved ids)", async () => {
    const journey: Journey = {
      id: "apply",
      pages: [
        {
          id: "details",
          components: [
            workEmailAlias(),
            { id: "isPrototypeOf", type: "text", configuration: { required: true } },
            { id: "toString", type: "text", configuration: {}, rules: { visibleWhen: eq("isPrototypeOf", "show") } },
            // No id the grammar allows (rule A): ignored on both sides.
            { id: "__proto__", type: "text", configuration: { required: true } },
            "annual_income"
          ]
        }
      ]
    };
    const runtime = presentationRuntime({ journeys: [journey] });
    expect(runtime.journeyView()?.members).toEqual(["work_email", "isPrototypeOf", "toString", "annual_income"]);
    expect(runtime.presentationValuePathOf("isPrototypeOf")).toBe("@apply.isPrototypeOf");
    expect(runtime.presentationValuePathOf("__proto__")).toBeUndefined();
    expect(runtime.presentationValuePathOf("hasOwnProperty")).toBeUndefined();
    expect(runtime.effectiveState("isPrototypeOf")).toMatchObject({ visible: true });
    expect(runtime.effectiveState("toString")).toMatchObject({ visible: false });
    expect(runtime.effectiveState("__proto__")).toBeUndefined();
    expect(runtime.effectiveState("valueOf")).toBeUndefined();
    expect(runtime.isRequired("isPrototypeOf")).toBe(true);
    expect(runtime.isRequired("hasOwnProperty")).toBe(false);
    expect(runtime.requiredMap().get("isPrototypeOf")).toBe(true);
    expect(runtime.presentationValues()).toEqual({});
    expect(Object.keys(runtime.presentationValues())).toEqual([]);

    runtime.setValue("email", "ada@example.org");
    runtime.setValue("annual_income", 5);
    const blocked = await runtime.submit("submit", presentationEnvelope);
    expect(blocked.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["isPrototypeOf:required"]);
    runtime.setValue("@apply.isPrototypeOf", "show");
    expect(runtime.effectiveState("toString")?.visible).toBe(true);
    const values = runtime.presentationValues();
    expect(Object.keys(values)).toEqual(["isPrototypeOf"]);
    expect(Object.prototype.hasOwnProperty.call(values, "isPrototypeOf")).toBe(true);
    expect(values.isPrototypeOf).toBe("show");
    const sent = await runtime.submit("submit", presentationEnvelope);
    expect(sent.accepted).toBe(true);
    expect(sent.canonicalSubmission?.submission.values).toEqual({ email: "ada@example.org", annual_income: 5 });
    expect(({} as Record<string, unknown>).visible).toBeUndefined();
  });
});

/** The review's form: `email` hidden unless the name says "show", with its own opt-ins while hidden; an alias of it beside own content on `details`. */
function hiddenTargetForm(target: Record<string, unknown>, alias: Record<string, unknown>): FormDefinition {
  return {
    id: "probe",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "email", type: "text", configuration: { label: "Email", ...target }, rules: { visibleWhen: eq("name", "show") } }
        ]
      }
    },
    journey: {
      journeys: [
        {
          id: "apply",
          validation: { continue: "page" },
          pages: [
            {
              id: "details",
              components: [
                { id: "work_email", type: "text", configuration: { label: "Work email", fills: "email", ...alias } },
                // Own content, so the page is on the path whatever the field's visibility.
                { id: "intro", type: "html", configuration: { tag: "p", content: "Hello" } }
              ]
            },
            { id: "last", components: ["name"] }
          ]
        }
      ]
    }
  };
}

/** A resume of the fixture's journey on `income` from a hand-made draft. */
function presentationDraft(values: Record<string, unknown>, written?: Record<string, unknown>): FormDraft {
  return {
    id: "d",
    formId: "presentation",
    formVersion: "1.0.0",
    runtime: { schemaVersion: "1.0.0", rendererVersion: "1" },
    locale: "en",
    values,
    state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [], journey: { id: "apply", page: "income", completed: ["details"], ...(written !== undefined ? { written } : {}) } },
    updatedAt: 1
  };
}

/** The fixture's journey with `m2` given a visibility rule. */
function withM2Rule(visibleWhen: Expression): Journey {
  const journey = presentationApplyJourney();
  const income = journey.pages[1] as Journey["pages"][number];
  income.components = (income.components ?? []).map((entry) => (typeof entry !== "string" && entry.id === "m2" ? { ...entry, rules: { visibleWhen } } : entry));
  return journey;
}

describe("journey runtime: presentations — regressions", () => {
  it("never lets a hidden alias's own Required or own checks block, whatever its form field opts in to while hidden", async () => {
    // Its own Required; the form field, not required, is validated and required while hidden.
    const required = hiddenTargetForm({ hiddenValidationBehavior: "validate", hiddenRequiredBehavior: "required" }, { required: true });
    const runtime = presentationRuntime({ form: required });
    runtime.setValue("name", "hide");
    expect(runtime.effectiveState("work_email")).toMatchObject({ visible: false, runValidation: false, requiredApplies: false });
    expect(runtime.isRequired("work_email")).toBe(true);
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "last" });
    expect(runtime.errors()).toEqual([]);
    const sent = await runtime.submit("submit", presentationEnvelope);
    expect(sent.errors).toEqual([]);
    expect(sent.accepted).toBe(true);
    // Shown with its field, it asks again.
    const shown = presentationRuntime({ form: required });
    shown.setValue("name", "show");
    expect((await shown.nextPage()).reason).toBe("validation");
    expect(errorCodes(shown)).toEqual(["work_email:required"]);

    // Its own length rule, over a long prefilled answer the form validates while hidden.
    const shaped = presentationRuntime({ form: hiddenTargetForm({ hiddenValidationBehavior: "validate" }, { maxLength: 5 }) });
    shaped.setValue("email", "much-too-long@example.org");
    shaped.setValue("name", "hide");
    expect(await shaped.nextPage()).toMatchObject({ ok: true, pageId: "last" });
    expect(shaped.errors()).toEqual([]);
    shaped.setValue("name", "show");
    await shaped.previousPage();
    expect((await shaped.nextPage()).reason).toBe("validation");
    expect(errorCodes(shaped)).toEqual(["work_email:maxLength"]);
  });

  it("hosts a form field's errors on an alias only while the alias shows: hidden with its field, the error is the summary's", async () => {
    // The form field keeps its own shape check while hidden: its error stands, with nobody to show it on the page.
    const form = hiddenTargetForm({ hiddenValidationBehavior: "validate", maxLength: 5 }, {});
    const runtime = presentationRuntime({ form });
    runtime.setValue("email", "much-too-long@example.org");
    runtime.setValue("name", "hide");
    await runtime.validate();
    expect(errorCodes(runtime)).toEqual(["email:maxLength"]);
    expect(runtime.journeyView()?.pageId).toBe("details");
    expect({ ...runtime.journeyView()?.hosts }).toEqual({});
    runtime.setValue("name", "show");
    expect({ ...runtime.journeyView()?.hosts }).toEqual({ email: "work_email" });
  });

  it("drops a server's error naming an own node by id once its answer changes, and keeps it while it does not", async () => {
    const runtime = presentationRuntime();
    runtime.setValue("email", "ada@example.org");
    expect((await runtime.nextPage()).pageId).toBe("income");
    runtime.setValue("@apply.m1", 60000);
    runtime.setErrors([{ code: "odd", componentId: "m1" }]);
    // Unchanged, it stands through the page's own validation.
    expect(await runtime.nextPage()).toMatchObject({ ok: false, reason: "validation" });
    expect(errorCodes(runtime)).toEqual(["m1:odd"]);
    runtime.setValue("@apply.m1", 70000);
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "assist" });
    expect(runtime.errors()).toEqual([]);

    // An alias named by id is read at the form field it fills.
    const alias = presentationRuntime();
    alias.setValue("email", "ada@example.org");
    alias.setErrors([{ code: "taken", componentId: "work_email" }]);
    expect(await alias.nextPage()).toMatchObject({ ok: false, reason: "validation" });
    alias.setValue("email", "other@example.org");
    expect(await alias.nextPage()).toMatchObject({ ok: true, pageId: "income" });
  });

  it("drops every error on an own node of the presentation left — a host's, a server's — when it is left or another starts", () => {
    const hostErrors = [
      { code: "odd", componentId: "m1" },
      { code: "taken", componentId: "work_email" },
      { code: "late", componentId: "income_total", source: "server" as const },
      { code: "x", componentId: "email" },
      { code: "form-level" }
    ];
    const switching = presentationRuntime();
    switching.setErrors(hostErrors);
    expect(errorCodes(switching)).toEqual(["-:form-level", "email:x", "income_total:late", "m1:odd", "work_email:taken"]);
    expect(switching.startJourney("public").ok).toBe(true);
    expect(errorCodes(switching)).toEqual(["-:form-level", "email:x"]);

    const leaving = presentationRuntime();
    leaving.setErrors(hostErrors);
    leaving.leaveJourney();
    expect(errorCodes(leaving)).toEqual(["-:form-level", "email:x"]);
  });

  it("works a resumed draft out from its own answers alone, never from the sources that showed before it was put in", async () => {
    // F3a: `m2` shows unless the name says "hide". The runtime starts over empty answers (m2
    // shown); the draft hides it, and its `annual_income` was typed, not worked out.
    const hiding = withM2Rule(neq("name", "hide"));
    const runtime = presentationRuntime({ journeys: [hiding] });
    expect(runtime.effectiveState("m2")?.visible).toBe(true);
    await runtime.hydrateFromDraft(presentationDraft({ email: "ada@example.org", name: "hide", "@apply.m2": 500, annual_income: 41000 }));
    expect(runtime.effectiveState("m2")?.visible).toBe(false);
    expect(runtime.state().values.annual_income).toBe(41000);
    expect(runtime.state().journey?.written).toBeUndefined();
    const sent = await runtime.submit("submit", presentationEnvelope);
    expect(sent.accepted).toBe(true);
    expect(sent.canonicalSubmission?.submission.values).toEqual({ email: "ada@example.org", name: "hide", annual_income: 41000 });

    // F3b: `m2` shows while the total is 100 or more — two answers settle. The draft holds the
    // one the person had (110, written by the page); a fresh runtime's empty start shows only m1.
    const circular = withM2Rule({ kind: "binary", operator: "gte", left: path("annual_income"), right: literal(100) });
    const resumed = presentationRuntime({ journeys: [circular] });
    await resumed.hydrateFromDraft(presentationDraft({ email: "ada@example.org", "@apply.m1": 50, "@apply.m2": 60, annual_income: 110 }, { annual_income: 110 }));
    expect(resumed.state().values.annual_income).toBe(110);
    expect(resumed.effectiveState("m2")?.visible).toBe(true);
    expect(resumed.state().journey?.written).toEqual({ annual_income: 110 });
  });

  it("keeps on resume only what a worked-out value of the running presentation still sets", async () => {
    const runtime = presentationRuntime();
    // `approved_amount` and `name` are no worked-out targets of `apply` (a node since removed, say).
    await runtime.hydrateFromDraft(
      presentationDraft({ email: "ada@example.org", "@apply.m1": 12000, annual_income: 12000, approved_amount: 500, name: "Ada" }, { annual_income: 12000, approved_amount: 500, name: "Ada" })
    );
    expect(runtime.state().journey?.written).toEqual({ annual_income: 12000 });
    expect(runtime.state().values).toMatchObject({ annual_income: 12000, approved_amount: 500, name: "Ada" });
    // Nothing on the page could clear the others: they are ordinary answers again.
    runtime.setValue("@apply.m1", undefined);
    expect(runtime.state().values).toMatchObject({ approved_amount: 500, name: "Ada" });
    expect(runtime.state().values.annual_income).toBeUndefined();
  });

  it("holds a worked-out value's form field to its own length rule once, on the form field, never again on the read-only copy", async () => {
    const form: FormDefinition = {
      id: "coded",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      root: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "code", type: "text", configuration: { label: "Code", maxLength: 4, pattern: "^[a-z]+$" } }] } },
      journey: {
        journeys: [
          {
            id: "apply",
            pages: [
              {
                id: "p",
                components: [
                  { id: "first", type: "text", configuration: {} },
                  { id: "second", type: "text", configuration: {} },
                  { id: "joined", type: "journey-value", configuration: { to: "code", value: { kind: "call", name: "concat", args: [path("first"), path("second")] } } }
                ]
              }
            ]
          }
        ]
      }
    };
    const runtime = presentationRuntime({ form });
    runtime.setValue("@apply.first", "abc");
    runtime.setValue("@apply.second", "de1");
    expect(runtime.state().values.code).toBe("abcde1");
    // The copy carries the rules to draw them (a length hint), and its own stage would find them broken.
    expect(runtime.presentationIndex()?.nodeById.joined?.configuration).toMatchObject({ maxLength: 4, pattern: "^[a-z]+$", readOnly: true });
    await runtime.validate();
    expect(errorCodes(runtime)).toEqual(["code:maxLength"]);
    expect(runtime.errors()[0]).toMatchObject({ stage: "field-constraints" });
    expect({ ...runtime.journeyView()?.hosts }).toEqual({ code: "joined" });
  });
});

describe("journey runtime: presentations — an own layout nested as deep as the shape checks accept", () => {
  it("runs a journey whose own layout nests 3,000 deep: the index, the own-field checks, Continue and the submit", async () => {
    let deep: Journey["pages"][number]["components"] extends (infer E)[] | undefined ? E : never = { id: "bottom", type: "text", configuration: { fills: "email", required: true } };
    for (let level = 0; level < 3000; level += 1) {
      deep = { id: `layer_${level}`, type: "fieldset", children: { content: [deep as never] } };
    }
    const runtime = presentationRuntime({ journeys: [{ id: "deep", pages: [{ id: "p", components: [deep, "annual_income"] }] }] });
    expect(runtime.journeyView()).toMatchObject({ journeyId: "deep", pageId: "p", hosts: {} });
    expect(runtime.presentationIndex()?.order).toHaveLength(3001);
    expect(runtime.presentationValuePathOf("bottom")).toBe("email");
    const refused = await runtime.submit("submit", presentationEnvelope);
    expect(refused.errors.map((error) => `${error.componentId}:${error.code}`).sort()).toEqual(["annual_income:required", "bottom:required", "email:required"]);
    runtime.setValue("email", "a@b.co");
    runtime.setValue("annual_income", 5);
    const sent = await runtime.submit("submit", presentationEnvelope);
    expect(sent.accepted).toBe(true);
    expect(sent.canonicalSubmission?.submission.values).toEqual({ email: "a@b.co", annual_income: 5 });
  });
});

describe("journey runtime: a Check answers page", () => {
  /** applyJourney with a review page `check` before the exit, checked at the end (the default). */
  function reviewJourney(): Journey {
    const pages = applyJourney().pages;
    return {
      id: "apply",
      pages: [
        ...pages.slice(0, 4).map((page) => (page.id === "details" ? { ...page, routes: [] } : page)),
        { id: "check", kind: "review", title: "Check your answers", components: [{ id: "declare", type: "paragraph", configuration: { text: "By sending you confirm the details are correct." } }] },
        pages[4]!
      ]
    };
  }
  const reviewForm = (): FormDefinition => definition({ journeys: [reviewJourney()] });

  /** Resident branch to the review page, every page continued from. */
  async function toReview(runtime: FormRuntime, notes = "none"): Promise<void> {
    runtime.setValue("age", "30");
    runtime.setValue("resident", true);
    expect((await runtime.nextPage()).pageId).toBe("residence");
    runtime.setValue("province", "ON");
    expect((await runtime.nextPage()).pageId).toBe("details");
    if (notes !== "") {
      runtime.setValue("notes", notes);
    }
    expect((await runtime.nextPage()).pageId).toBe("check");
  }

  it("is the last page: counted in the counter, never passed over, its action the submit", async () => {
    const runtime = makeRuntime({ form: reviewForm() });
    await toReview(runtime);
    const view = runtime.journeyView();
    expect(view).toMatchObject({ kind: "review", final: true, end: "end", path: ["about", "residence", "details", "check"], number: 4, total: 4, members: ["declare"] });
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "check", reason: "at-end" });
    expect(await runtime.journeyAction({ ...view!, hasOwnSubmit: false } as never)).toMatchObject({ kind: "submit", pageId: "check" });
    const result = await runtime.submit("submit", envelope);
    expect(result.accepted).toBe(true);
    expect(result.canonicalSubmission?.submission.values).toEqual({ age: "30", resident: true, province: "ON", notes: "none" });
  });

  it("a Change link goes back to a completed page, and Continue returns to the review page", async () => {
    const runtime = makeRuntime({ form: reviewForm() });
    await toReview(runtime);
    const pages = recordEvents(runtime, FormEventType.PAGE_CHANGED);
    expect(await runtime.goToPage("residence", { direction: "change" })).toEqual({ ok: true, pageId: "residence" });
    expect(runtime.state().journey?.returnTo).toBe("check");
    expect(runtime.journeyView()).toMatchObject({ pageId: "residence", final: false, returning: { reviewPageId: "check", nextPageId: "check" }, backPageId: "check" });
    runtime.setValue("province", "QC");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "check" });
    expect(runtime.state().journey?.returnTo).toBeUndefined();
    expect(runtime.journeyView()?.returning).toBeUndefined();
    expect(pages).toEqual([
      { journeyId: "apply", fromPageId: "check", toPageId: "residence", direction: "change", index: 1, total: 4, returnPageId: "check" },
      { journeyId: "apply", fromPageId: "residence", toPageId: "check", direction: "forward", index: 3, total: 4 }
    ]);
  });

  it("Back from a changed page returns to the review page too", async () => {
    const runtime = makeRuntime({ form: reviewForm() });
    await toReview(runtime);
    await runtime.goToPage("about", { direction: "change" });
    expect(await runtime.previousPage()).toEqual({ ok: true, pageId: "check" });
    expect(runtime.state().journey?.returnTo).toBeUndefined();
  });

  it("visits the pages a changed answer puts on the path before returning", async () => {
    const runtime = makeRuntime({ form: reviewForm() });
    await toReview(runtime);
    await runtime.goToPage("about", { direction: "change" });
    runtime.setValue("resident", false);
    expect(runtime.journeyView()?.path).toEqual(["about", "overseas", "details", "check"]);
    // Continue goes to the page newly on the path, not yet completed; the return still stands.
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "overseas" });
    expect(runtime.journeyView()?.returning).toEqual({ reviewPageId: "check", nextPageId: "check" });
    runtime.setValue("abroad.nation", "FR");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "check" });
    expect(runtime.state().journey?.returnTo).toBeUndefined();
    // Back from a changed page goes there as well, while one is still to visit.
    const again = makeRuntime({ form: reviewForm() });
    await toReview(again);
    await again.goToPage("about", { direction: "change" });
    again.setValue("resident", false);
    expect(await again.previousPage()).toEqual({ ok: true, pageId: "overseas" });
    expect(again.state().journey?.returnTo).toBe("check");
  });

  it("Back from a page the changed answers put on the path never leaves it behind unvisited", async () => {
    const runtime = makeRuntime({ form: reviewForm() });
    await toReview(runtime);
    await runtime.goToPage("about", { direction: "change" });
    runtime.setValue("resident", false);
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "overseas" });
    // Not completed: Back is the ordinary Back, and the return still stands.
    expect(runtime.journeyView()).toMatchObject({ pageId: "overseas", backPageId: "about", returning: { reviewPageId: "check", nextPageId: "check" } });
    expect(await runtime.previousPage()).toEqual({ ok: true, pageId: "about" });
    expect(runtime.state().journey?.returnTo).toBe("check");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "overseas" });
    runtime.setValue("abroad.nation", "FR");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "check" });
    expect(runtime.journeyView()?.completed).toEqual(["about", "overseas", "details"]);
  });

  it("a Change link opens a page an answer changed on the review page put on the path", async () => {
    const runtime = makeRuntime({ form: reviewForm() });
    await toReview(runtime);
    // A host or an agent changes an answer while the person is on the review page.
    runtime.setValue("resident", false);
    expect(runtime.journeyView()).toMatchObject({ pageId: "check", path: ["about", "overseas", "details", "check"], frontierPageId: "overseas" });
    const refused = await runtime.submit("submit", envelope);
    expect(refused.accepted).toBe(false);
    expect(runtime.journeyView()?.pageId).toBe("check");
    // The page holding the error is not completed, yet its Change link opens it, and Continue comes back.
    expect(await runtime.goToPage("overseas", { direction: "change" })).toEqual({ ok: true, pageId: "overseas" });
    expect(runtime.journeyView()?.returning).toEqual({ reviewPageId: "check", nextPageId: "check" });
    runtime.setValue("abroad.nation", "FR");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "check" });
    expect((await runtime.submit("submit", envelope)).accepted).toBe(true);
  });

  it("is refused away from a review page, and to a page not completed", async () => {
    const runtime = makeRuntime({ form: reviewForm() });
    runtime.setValue("age", "30");
    runtime.setValue("resident", true);
    await runtime.nextPage();
    expect(await runtime.goToPage("about", { direction: "change" })).toEqual({ ok: false, pageId: "residence", reason: "unreachable" });
    expect(runtime.state().journey?.returnTo).toBeUndefined();
    const reviewing = makeRuntime({ form: reviewForm() });
    await toReview(reviewing);
    expect(await reviewing.goToPage("overseas", { direction: "change" })).toEqual({ ok: false, pageId: "check", reason: "unreachable" });
    expect(await reviewing.goToPage("too-young", { direction: "change" })).toEqual({ ok: false, pageId: "check", reason: "unreachable" });
  });

  it("asks beforePageChange, with the direction change, which may veto it", async () => {
    const seen: string[] = [];
    const hooks: FormHooks = {
      beforePageChange: [
        (context) => {
          seen.push(`${context.direction}:${context.fromPageId}>${context.toPageId}`);
          if (context.toPageId === "about") {
            throw new Error("Not that one");
          }
        }
      ]
    };
    const runtime = makeRuntime({ form: reviewForm(), hooks });
    await toReview(runtime);
    seen.length = 0;
    expect(await runtime.goToPage("about", { direction: "change" })).toEqual({ ok: false, pageId: "check", reason: "vetoed", message: "Not that one" });
    expect(runtime.state().journey?.returnTo).toBeUndefined();
    expect(await runtime.goToPage("details", { direction: "change" })).toEqual({ ok: true, pageId: "details" });
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "check" });
    expect(seen).toEqual(["change:check>about", "change:check>details", "forward:details>check"]);
  });

  it("clears the return target on any other move: a jump, an error shown, a restart, a path that drops the review page", async () => {
    const jumped = makeRuntime({ form: reviewForm() });
    await toReview(jumped);
    await jumped.goToPage("details", { direction: "change" });
    expect(await jumped.goToPage("about")).toEqual({ ok: true, pageId: "about" });
    expect(jumped.state().journey?.returnTo).toBeUndefined();
    expect(await jumped.nextPage()).toEqual({ ok: true, pageId: "residence" });

    const shown = makeRuntime({ form: reviewForm() });
    await toReview(shown);
    await shown.goToPage("details", { direction: "change" });
    await shown.goToPage("about", { direction: "error" });
    expect(shown.state().journey?.returnTo).toBeUndefined();

    const restarted = makeRuntime({ form: reviewForm() });
    await toReview(restarted);
    await restarted.goToPage("details", { direction: "change" });
    restarted.startJourney("apply");
    expect(restarted.state().journey?.returnTo).toBeUndefined();

    const dropped = makeRuntime({ form: reviewForm() });
    await toReview(dropped);
    await dropped.goToPage("about", { direction: "change" });
    dropped.setValue("age", "12");
    expect(dropped.journeyView()?.path).toEqual(["about", "too-young"]);
    expect(dropped.state().journey?.returnTo).toBeUndefined();
    expect(dropped.journeyView()?.returning).toBeUndefined();
    expect(await dropped.nextPage()).toEqual({ ok: true, pageId: "too-young" });
  });

  it("stays on the review page when the send is refused, with the errors there to list", async () => {
    const runtime = makeRuntime({ form: reviewForm() });
    await toReview(runtime, "");
    const result = await runtime.submit("submit", envelope);
    expect(result.accepted).toBe(false);
    expect(result.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["notes:required"]);
    expect(runtime.journeyView()?.pageId).toBe("check");
    expect(runtime.errors().map((error) => `${error.componentId}:${error.code}`)).toEqual(["notes:required"]);
    // The error names a page the review lists: its Change link takes the person there, and back.
    expect(runtime.journeyView()?.pageOf.notes).toBe("details");
    expect(await runtime.goToPage("details", { direction: "change" })).toEqual({ ok: true, pageId: "details" });
    runtime.setValue("notes", "fixed");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "check" });
    expect((await runtime.submit("submit", envelope)).accepted).toBe(true);

    // Without a review page, the refused send takes the person to the page holding the error.
    const plain = makeRuntime({ form: definition({ journeys: [(({ validation: _validation, ...rest }) => rest)(applyJourney())] }) });
    plain.setValue("age", "30");
    plain.setValue("resident", true);
    await plain.nextPage();
    plain.setValue("province", "ON");
    await plain.nextPage();
    expect(plain.journeyView()?.pageId).toBe("details");
    await plain.goToPage("about");
    expect((await plain.submit("submit", envelope)).accepted).toBe(false);
    expect(plain.journeyView()?.pageId).toBe("details");
  });

  it("keeps the return target in a draft, and a resumed journey still returns", async () => {
    const versionContext = { formVersion: "4", schemaVersion: "1", rendererVersion: "0.1.0" };
    const store = new InMemoryDraftStore();
    const runtime = makeRuntime({ form: reviewForm(), draftStore: store, versionContext });
    await toReview(runtime);
    await runtime.goToPage("residence", { direction: "change" });
    await runtime.saveDraft("change");
    const draft = await store.load("change");
    expect(draft.state.journey).toEqual({ id: "apply", page: "residence", completed: ["about", "residence", "details"], returnTo: "check" });

    const resumed = makeRuntime({ form: reviewForm(), draftStore: store, versionContext });
    await resumed.hydrateFromDraft(draft);
    expect(resumed.journeyView()).toMatchObject({ pageId: "residence", returning: { reviewPageId: "check", nextPageId: "check" } });
    expect(resumed.state().journey?.returnTo).toBe("check");
    expect(await resumed.nextPage()).toEqual({ ok: true, pageId: "check" });

    // A return target that no longer holds is dropped on the way in: not a review page, or the draft is on it.
    const stale = makeRuntime({ form: reviewForm(), draftStore: store, versionContext });
    await stale.hydrateFromDraft({ ...draft, state: { ...draft.state, journey: { ...draft.state.journey!, returnTo: "details" } } });
    expect(stale.state().journey?.returnTo).toBeUndefined();
    const onIt = makeRuntime({ form: reviewForm(), draftStore: store, versionContext });
    await onIt.hydrateFromDraft({ ...draft, state: { ...draft.state, journey: { ...draft.state.journey!, page: "check" } } });
    expect(onIt.journeyView()?.pageId).toBe("check");
    expect(onIt.state().journey?.returnTo).toBeUndefined();
    // A draft saved with no return target says nothing of one.
    await onIt.saveDraft("plain");
    expect((await store.load("plain")).state.journey).toEqual({ id: "apply", page: "check", completed: ["about", "residence", "details"] });
  });
});
