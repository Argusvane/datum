import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";
import type { Expression } from "../../form-engine/core/expressions/expression.js";
import type { Journey, JourneyConfiguration, JourneyPage } from "../../form-engine/core/schema/journey.js";
import type {
  JourneyServerValidator,
  JourneyValidationRequest,
  JourneyValidationResponse
} from "../../form-engine/core/journey/journey-types.js";
import type { ValidationStage } from "../../form-engine/core/schema/contracts.js";
import type { FormHooks } from "../../form-engine/core/events/hooks.js";
import { FormEventType } from "../../form-engine/core/events/event-types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import type { SigningProvider } from "../../form-engine/core/submission/signing.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { FormRuntime, type FormRuntimeDependencies } from "../../form-engine/runtime/browser/form-runtime.js";
import type {
  WasmSubmissionOutcome,
  WasmValidationHost,
  WasmValidationRequest
} from "../../form-engine/validation/wasm/wasm-validation-host.js";

/*
 * A journey's checks against the host's server: a page's on Continue and the
 * journey's at its end — what is asked, when, what a reply or its absence means, what is
 * remembered and what is shown.
 */

const path = (name: string): Expression => ({ kind: "path", path: name });
const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
const eq = (name: string, value: string | number | boolean): Expression => ({ kind: "binary", operator: "eq", left: path(name), right: literal(value) });
const neq = (name: string, value: string | number | boolean): Expression => ({ kind: "binary", operator: "neq", left: path(name), right: literal(value) });

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
          // A data-scoping container whose field is stored at a data key: `abroad.nation`.
          id: "abroad",
          type: "container",
          configuration: {},
          children: {
            content: [{ id: "country", type: "text", configuration: { required: true, dataKey: "nation" } }]
          }
        },
        { id: "notes", type: "text", configuration: { required: true } },
        // On no page: never validated, and its answer is submitted.
        { id: "reference", type: "text", configuration: {} }
      ]
    }
  };
}

/** about -> residence (resident) | overseas (not resident) -> details. */
function journeyWith(pages: { overseas?: Partial<JourneyPage>; details?: Partial<JourneyPage> } = {}, overrides: Partial<Journey> = {}): Journey {
  return {
    id: "apply",
    pages: [
      { id: "about", components: ["age", "resident"], routes: [{ when: neq("resident", true), to: "overseas" }] },
      { id: "residence", components: ["province"], routes: [{ to: "details" }] },
      { id: "overseas", components: ["abroad"], ...pages.overseas },
      { id: "details", components: ["notes"], ...pages.details }
    ],
    ...overrides,
    validation: { continue: "page", ...overrides.validation }
  };
}

function definition(journey: Journey): FormDefinition {
  return {
    id: "eligibility",
    version: "4",
    schemaVersion: "1",
    root: root(),
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
    journey: { journeys: [journey] }
  };
}

const serverPage = (validation: NonNullable<JourneyPage["validation"]> = { server: true }): Journey => journeyWith({ overseas: { validation } });

function makeRuntime(
  journey: Journey,
  deps: Partial<FormRuntimeDependencies> & { stages?: ValidationStage[] } = {}
): FormRuntime {
  const { stages, ...rest } = deps;
  const form = definition(journey);
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  modes.register({ id: "signed", validate: true, sign: true, serverValidation: false });
  return new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root), ...(stages ?? [])]),
    ...rest
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A validator that records what it is asked and answers from `reply`. */
function recording(reply: (request: JourneyValidationRequest) => JourneyValidationResponse | Promise<JourneyValidationResponse> = () => ({ errors: [] })): {
  validator: JourneyServerValidator;
  requests: JourneyValidationRequest[];
} {
  const requests: JourneyValidationRequest[] = [];
  return {
    requests,
    validator: async (request) => {
      requests.push(request);
      return reply(request);
    }
  };
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** To the overseas page with its answer given. */
async function toOverseas(runtime: FormRuntime): Promise<void> {
  runtime.setValue("age", "30");
  expect((await runtime.nextPage()).pageId).toBe("overseas");
  runtime.setValue("abroad.nation", "FR");
}

/** Every page answered on the resident branch, on the last page. */
async function toDetails(runtime: FormRuntime): Promise<void> {
  runtime.setValue("age", "30");
  runtime.setValue("resident", true);
  runtime.setValue("province", "ON");
  runtime.setValue("notes", "none");
  expect((await runtime.nextPage()).pageId).toBe("residence");
  expect((await runtime.nextPage()).pageId).toBe("details");
}

const codesOf = (runtime: FormRuntime): Array<[string | undefined, string]> =>
  runtime.errors().map((error) => [error.componentId, error.code]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("journey server checks: the envelope handed beside the request", () => {
  it("hands the validator the submission envelope over the request's answers when a version context is given, and none without", async () => {
    const documents: unknown[] = [];
    const validator: JourneyServerValidator = async (_request, call) => {
      documents.push(call?.document);
      return { errors: [] };
    };
    const runtime = makeRuntime(serverPage(), { journeyServerValidator: validator, submissionVersionContext: envelope });
    runtime.setLocale("fr");
    await toOverseas(runtime);
    expect((await runtime.nextPage()).ok).toBe(true);
    expect(documents).toEqual([
      {
        versionContext: { form: { id: "eligibility", version: "4" }, client: { ...envelope.client, components: {}, plugins: {} } },
        submission: { locale: "fr", values: { age: "30", "abroad.nation": "FR" }, journey: { id: "apply" } }
      }
    ]);

    const bare = makeRuntime(serverPage(), { journeyServerValidator: validator });
    await toOverseas(bare);
    expect((await bare.nextPage()).ok).toBe(true);
    expect(documents[1]).toBeUndefined();
  });

  it("hands the end check the envelope the submit then emits", async () => {
    const documents: unknown[] = [];
    const validator: JourneyServerValidator = async (_request, call) => {
      documents.push(call?.document);
      return { errors: [] };
    };
    const runtime = makeRuntime(journeyWith({}, { validation: { end: "server" } }), { journeyServerValidator: validator, submissionVersionContext: envelope });
    await toDetails(runtime);
    const result = await runtime.submit("submit", envelope);
    expect(result.accepted).toBe(true);
    expect(documents).toEqual([result.canonicalSubmission]);
  });
});

describe("journey server checks: a page's, on Continue", () => {
  it("asks once the page's own checks pass, with every submittable answer and never a path", async () => {
    const { validator, requests } = recording();
    const runtime = makeRuntime(serverPage(), { journeyServerValidator: validator });
    const started = recordEvents(runtime, FormEventType.JOURNEY_CHECK_STARTED);
    const completed = recordEvents(runtime, FormEventType.JOURNEY_CHECK_COMPLETED);

    // The about page does not ask; the overseas page's own errors stop Continue before it asks.
    runtime.setValue("age", "30");
    await runtime.nextPage();
    expect((await runtime.nextPage()).reason).toBe("validation");
    expect(requests).toEqual([]);

    runtime.setValue("abroad.nation", "FR");
    runtime.setValue("province", "ON"); // Off the path: not submitted, so not sent.
    runtime.setValue("reference", "R-1"); // On no page: submitted, so sent.
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(requests).toEqual([
      {
        formId: "eligibility",
        formVersion: "4",
        journeyId: "apply",
        scope: "page",
        pageId: "overseas",
        values: { age: "30", "abroad.nation": "FR", reference: "R-1" },
        locale: "en"
      }
    ]);

    expect(started).toHaveLength(1);
    const key = started[0]?.key as string;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(started[0]).toEqual({ journeyId: "apply", scope: "page", pageId: "overseas", key });
    expect(completed).toEqual([
      {
        journeyId: "apply",
        scope: "page",
        pageId: "overseas",
        key,
        outcome: "clean",
        errorCount: 0,
        blockingErrorCount: 0,
        durationMs: expect.any(Number)
      }
    ]);
  });

  it("remembers a clean pass by the whole request, in memory only", async () => {
    const { validator, requests } = recording();
    const runtime = makeRuntime(serverPage(), { journeyServerValidator: validator });
    const started = recordEvents(runtime, FormEventType.JOURNEY_CHECK_STARTED);
    await toOverseas(runtime);
    await runtime.nextPage();
    expect(requests).toHaveLength(1);

    // The same request again: answered from memory, with no events.
    await runtime.previousPage();
    expect((await runtime.nextPage()).ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(started).toHaveLength(1);

    // Any submittable answer is part of the request, on the page or not; so is the locale.
    await runtime.previousPage();
    runtime.setValue("reference", "R-2");
    await runtime.nextPage();
    expect(requests).toHaveLength(2);
    await runtime.previousPage();
    runtime.setLocale("fr");
    await runtime.nextPage();
    expect(requests).toHaveLength(3);
    expect(requests[2]?.locale).toBe("fr");

    // An answer off the path is not: it is never sent.
    await runtime.previousPage();
    runtime.setValue("province", "QC");
    await runtime.nextPage();
    expect(requests).toHaveLength(3);

    // Nothing of it reaches the journey's state, which is what a draft saves.
    expect(Object.keys(runtime.state().journey ?? {}).sort()).toEqual(["completedPages", "journeyId", "pageId"]);
  });

  it("forgets what it passed on a new journey, leaving the journey, a new validator and a submission", async () => {
    const { validator, requests } = recording();
    const runtime = makeRuntime(serverPage(), { journeyServerValidator: validator });
    const again = async (): Promise<void> => {
      await runtime.goToPage("overseas");
      await runtime.nextPage();
    };
    await toOverseas(runtime);
    await runtime.nextPage();
    expect(requests).toHaveLength(1);

    runtime.startJourney("apply");
    await runtime.nextPage();
    await runtime.nextPage();
    expect(requests).toHaveLength(2);

    runtime.leaveJourney();
    runtime.startJourney();
    await runtime.nextPage();
    await runtime.nextPage();
    expect(requests).toHaveLength(3);

    runtime.setJourneyServerValidator(validator);
    await again();
    expect(requests).toHaveLength(4);
    await again();
    expect(requests).toHaveLength(4);

    runtime.setValue("notes", "done");
    expect((await runtime.submit("submit", envelope)).accepted).toBe(true);
    await again();
    expect(requests).toHaveLength(5);
  });

  it("stays on the page with the server's errors, kept to the page, beside the page's own warnings and other pages' errors", async () => {
    const hint: ValidationStage = {
      id: "hints",
      version: "1",
      validate: (context) => ({
        errors:
          context.values["abroad.nation"] === "FR"
            ? [{ code: "hint.check-spelling", componentId: "country", stage: "hints", source: "client", severity: "warning" }]
            : []
      })
    };
    const { validator } = recording(() => ({
      errors: [
        { code: "server.unknown-country", componentId: "country", message: "We do not recognise that country." },
        // Another page's component: not this page's business.
        { code: "server.notes", componentId: "notes" },
        // The form's as a whole: the page's, until the page changes.
        { code: "server.try-later" }
      ]
    }));
    const runtime = makeRuntime(serverPage(), { journeyServerValidator: validator, stages: [hint] });
    await toOverseas(runtime);
    runtime.setErrors([{ code: "host.note", componentId: "notes", severity: "warning" }]);

    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "server" });
    expect(runtime.errors().map((error) => [error.componentId, error.code, error.stage, error.source, error.severity])).toEqual([
      ["notes", "host.note", "host", "server", "warning"],
      ["country", "hint.check-spelling", "hints", "client", "warning"],
      ["country", "server.unknown-country", "journey-server", "server", undefined],
      [undefined, "server.try-later", "journey-server", "server", undefined]
    ]);
    expect(runtime.errors()[2]?.message).toBe("We do not recognise that country.");

    // Leaving the page drops the form-level error it owned; the field's error stays with it.
    await runtime.previousPage();
    expect(codesOf(runtime)).toEqual([
      ["notes", "host.note"],
      ["country", "hint.check-spelling"],
      ["country", "server.unknown-country"]
    ]);
  });

  it("reads a reply's field by componentId, field, or value path — a data key under a container, an entry of a section", async () => {
    const { validator } = recording(() => ({
      errors: [
        { code: "by.id", componentId: "country" },
        { code: "by.field", field: "country" } as never,
        { code: "by.path", path: "abroad.nation" },
        { code: "by.container-path", path: "abroad.other" }
      ]
    }));
    const runtime = makeRuntime(serverPage(), { journeyServerValidator: validator });
    await toOverseas(runtime);
    expect((await runtime.nextPage()).reason).toBe("server");
    expect(codesOf(runtime)).toEqual([
      ["country", "by.id"],
      ["country", "by.field"],
      ["country", "by.path"],
      ["abroad", "by.container-path"]
    ]);
  });

  it("stops once for warnings alone, and goes on when Continue is asked again with the same answers", async () => {
    const { validator, requests } = recording(() => ({
      errors: [{ code: "server.unusual", componentId: "country", severity: "warning" }]
    }));
    const runtime = makeRuntime(serverPage(), { journeyServerValidator: validator });
    const completed = recordEvents(runtime, FormEventType.JOURNEY_CHECK_COMPLETED);
    await toOverseas(runtime);

    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "warnings" });
    expect(codesOf(runtime)).toEqual([["country", "server.unusual"]]);
    expect(completed.at(-1)).toMatchObject({ outcome: "warnings", errorCount: 1, blockingErrorCount: 0 });

    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(requests).toHaveLength(1);

    // Other answers are another request: its warnings stop Continue once again.
    await runtime.previousPage();
    runtime.setValue("abroad.nation", "DE");
    expect((await runtime.nextPage()).reason).toBe("warnings");
    expect((await runtime.nextPage()).ok).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("counts no verdict as the server being unavailable, and blocks unless the page says to carry on", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let answer: () => Promise<JourneyValidationResponse> = () => Promise.reject(new Error("offline"));
    const runtime = makeRuntime(serverPage(), { journeyServerValidator: () => answer() });
    const completed = recordEvents(runtime, FormEventType.JOURNEY_CHECK_COMPLETED);
    await toOverseas(runtime);

    // The network.
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "server-unavailable" });
    expect(runtime.errors()).toEqual([
      {
        id: "journey_page_overseas_unavailable",
        code: "journey.server-unavailable",
        stage: "journey",
        source: "client",
        severity: "error",
        parameters: { scope: "page", pageId: "overseas", reason: "network" }
      }
    ]);
    expect(completed.at(-1)).toMatchObject({ outcome: "unavailable", reason: "network" });
    expect(completed.at(-1)).not.toHaveProperty("status");

    // A 5xx.
    answer = () => Promise.reject(httpError(503));
    expect((await runtime.nextPage()).reason).toBe("server-unavailable");
    expect(completed.at(-1)).toMatchObject({ outcome: "unavailable", reason: "server-error", status: 503 });
    expect(runtime.errors().map((entry) => entry.parameters)).toEqual([{ scope: "page", pageId: "overseas", reason: "server-error", status: 503 }]);

    // Something that is not a verdict.
    for (const reply of [{}, { errors: "none" }, { errors: [{ message: "no code" }] }, null]) {
      answer = () => Promise.resolve(reply as never);
      expect((await runtime.nextPage()).reason).toBe("server-unavailable");
      expect(completed.at(-1)).toMatchObject({ outcome: "unavailable", reason: "malformed" });
    }
    // A validator that throws rather than rejects.
    answer = () => {
      throw new Error("bug");
    };
    expect((await runtime.nextPage()).reason).toBe("server-unavailable");

    // An outage is the person's network, not the host's bug: the event says so, the console does not.
    expect(error).not.toHaveBeenCalled();

    // Continue is the retry.
    answer = () => Promise.resolve({ errors: [] });
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(runtime.errors()).toEqual([]);

    // A page that says to carry on does, and nothing is remembered: the next Continue asks again.
    const asked: string[] = [];
    const lenient = makeRuntime(serverPage({ server: true, onUnavailable: "continue" }), {
      journeyServerValidator: async () => {
        asked.push("asked");
        throw new Error("offline");
      }
    });
    const lenientEvents = recordEvents(lenient, FormEventType.JOURNEY_CHECK_COMPLETED);
    await toOverseas(lenient);
    expect(await lenient.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(lenient.errors()).toEqual([]);
    expect(lenientEvents.at(-1)).toMatchObject({ outcome: "unavailable", reason: "network", proceeded: true });
    await lenient.previousPage();
    await lenient.nextPage();
    expect(asked).toHaveLength(2);
  });

  it("gives up after the time limit, telling the validator to stop", async () => {
    let signal: AbortSignal | undefined;
    const runtime = makeRuntime(serverPage(), {
      journeyServerValidationTimeoutMs: 20,
      journeyServerValidator: (_request, options) => {
        signal = options?.signal;
        return new Promise<JourneyValidationResponse>(() => undefined);
      }
    });
    const completed = recordEvents(runtime, FormEventType.JOURNEY_CHECK_COMPLETED);
    await toOverseas(runtime);
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "server-unavailable" });
    expect(signal?.aborted).toBe(true);
    expect(completed.at(-1)).toMatchObject({ outcome: "unavailable", reason: "timeout" });
    expect(runtime.journeyView()?.pending).toBeUndefined();
  });

  it("counts a missing validator as unavailable and says once how to set one; a builder's preview is never checked", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = makeRuntime(serverPage());
    const completed = recordEvents(runtime, FormEventType.JOURNEY_CHECK_COMPLETED);
    await toOverseas(runtime);
    expect((await runtime.nextPage()).reason).toBe("server-unavailable");
    expect((await runtime.nextPage()).reason).toBe("server-unavailable");
    expect(completed.map((entry) => [entry.outcome, entry.reason, entry.status])).toEqual([
      ["unavailable", "missing", undefined],
      ["unavailable", "missing", undefined]
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/serverValidator.*validate-url/);

    // Set later, without a rebuild: the answers typed are kept, and the check runs.
    const { validator, requests } = recording();
    runtime.setJourneyServerValidator(validator);
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(requests).toHaveLength(1);

    // A preview is judged by no server: the server knows the registered definition, not the draft.
    const preview = recording();
    const previewing = makeRuntime(serverPage(), {
      journeyConfiguration: { journeys: [serverPage()] } satisfies JourneyConfiguration,
      journeyServerValidator: preview.validator
    });
    const previewEvents = recordEvents(previewing, FormEventType.JOURNEY_CHECK_STARTED);
    await toOverseas(previewing);
    expect((await previewing.nextPage()).ok).toBe(true);
    expect(preview.requests).toEqual([]);
    expect(previewEvents).toEqual([]);
  });

  it("stops Continue on every 4xx as on an outage, and lets onUnavailable: continue go on", async () => {
    for (const status of [400, 401, 403, 404, 410]) {
      const runtime = makeRuntime(serverPage(), { journeyServerValidator: () => Promise.reject(httpError(status)) });
      const completed = recordEvents(runtime, FormEventType.JOURNEY_CHECK_COMPLETED);
      await toOverseas(runtime);

      const moved = await runtime.nextPage();
      expect(moved.ok).toBe(false);
      expect(completed.at(-1)).toMatchObject({ outcome: "unavailable", reason: "server-error", status });
      expect(completed.at(-1)).not.toHaveProperty("proceeded");
      expect(runtime.errors().map((entry) => [entry.code, entry.parameters?.reason, entry.parameters?.status])).toEqual([
        ["journey.server-unavailable", "server-error", status]
      ]);
    }

    const carryOn = makeRuntime(serverPage({ server: true, onUnavailable: "continue" }), { journeyServerValidator: () => Promise.reject(httpError(403)) });
    const completed = recordEvents(carryOn, FormEventType.JOURNEY_CHECK_COMPLETED);
    await toOverseas(carryOn);
    expect(await carryOn.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(completed.at(-1)).toMatchObject({ outcome: "unavailable", status: 403, proceeded: true });
  });

  it("shows the check in flight, refuses a second Continue, and drops a verdict about answers since changed", async () => {
    const pending = deferred<JourneyValidationResponse>();
    let signal: AbortSignal | undefined;
    const runtime = makeRuntime(serverPage(), {
      journeyServerValidator: (_request, options) => {
        signal = options?.signal;
        return pending.promise;
      }
    });
    const completed = recordEvents(runtime, FormEventType.JOURNEY_CHECK_COMPLETED);
    await toOverseas(runtime);

    const first = runtime.nextPage();
    await vi.waitFor(() => expect(runtime.journeyView()?.pending).toBe("page"));
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "pending" });

    runtime.setValue("abroad.nation", "DE");
    expect(signal?.aborted).toBe(true);
    expect(runtime.journeyView()?.pending).toBeUndefined();
    expect(await first).toEqual({ ok: false, pageId: "overseas", reason: "stale" });
    pending.resolve({ errors: [{ code: "late", componentId: "country" }] });
    await Promise.resolve();
    expect(completed.map((entry) => entry.outcome)).toEqual(["stale"]);
    expect(runtime.errors()).toEqual([]);
  });

  it("is called off by Back, a jump or leaving the journey, and moves nothing when its verdict comes late", async () => {
    let pending = deferred<JourneyValidationResponse>();
    let signal: AbortSignal | undefined;
    const runtime = makeRuntime(serverPage(), {
      journeyServerValidator: (_request, options) => {
        signal = options?.signal;
        return pending.promise;
      }
    });
    const completed = recordEvents(runtime, FormEventType.JOURNEY_CHECK_COMPLETED);
    await toOverseas(runtime);

    const continuing = runtime.nextPage();
    await vi.waitFor(() => expect(runtime.journeyView()?.pending).toBe("page"));
    expect(await runtime.previousPage()).toEqual({ ok: true, pageId: "about" });
    expect(signal?.aborted).toBe(true);
    expect(await continuing).toEqual({ ok: false, pageId: "about", reason: "cancelled" });
    pending.resolve({ errors: [] });
    await Promise.resolve();
    expect(runtime.journeyView()?.pageId).toBe("about");
    expect(completed.map((entry) => entry.outcome)).toEqual(["cancelled"]);

    // A jump.
    pending = deferred<JourneyValidationResponse>();
    await runtime.goToPage("overseas");
    const jumping = runtime.nextPage();
    await vi.waitFor(() => expect(runtime.journeyView()?.pending).toBe("page"));
    expect((await runtime.goToPage("about")).ok).toBe(true);
    expect((await jumping).reason).toBe("cancelled");

    // Leaving the journey.
    pending = deferred<JourneyValidationResponse>();
    await runtime.goToPage("overseas");
    const leaving = runtime.nextPage();
    await vi.waitFor(() => expect(runtime.journeyView()?.pending).toBe("page"));
    runtime.leaveJourney();
    expect((await leaving).reason).toBe("cancelled");
    expect(completed.map((entry) => entry.outcome)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });
});

describe("journey server checks: what a server said stays said", () => {
  it("keeps a server's error on its field through the page's own validation until the answer changes", async () => {
    const runtime = makeRuntime(journeyWith());
    runtime.setValue("age", "30");
    runtime.setErrors([{ code: "server.duplicate", componentId: "age" }]);

    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "about", reason: "validation" });
    await runtime.validate({ page: "about" });
    expect(codesOf(runtime)).toEqual([["age", "server.duplicate"]]);

    runtime.setValue("age", "31");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "overseas" });
    expect(runtime.errors()).toEqual([]);

    // A host error that says it is not the server's is the page's to clear.
    await runtime.previousPage();
    runtime.setErrors([{ code: "host.check", componentId: "age", source: "client" }]);
    expect((await runtime.nextPage()).ok).toBe(true);
  });

  it("holds under a data key too, and a whole-form validation clears it for the submit to judge again", async () => {
    const runtime = makeRuntime(journeyWith());
    await toOverseas(runtime);
    runtime.setErrors([{ code: "server.embargo", componentId: "country", path: "abroad.nation" }]);
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "validation" });
    await runtime.validate();
    expect(codesOf(runtime)).toEqual([["notes", "required"]]);
  });

  it("is asked again, not blocked by its own earlier word, on a page that checks with the server", async () => {
    const { validator, requests } = recording();
    const runtime = makeRuntime(serverPage(), { journeyServerValidator: validator });
    await toOverseas(runtime);
    runtime.setErrors([{ code: "server.embargo", componentId: "country" }]);
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
    expect(requests).toHaveLength(1);
    expect(runtime.errors()).toEqual([]);
  });
});

describe("journey server checks: the journey's, at its end", () => {
  const endJourney = (validation: Journey["validation"] = { end: "server" }): Journey => journeyWith({}, { validation });

  it("runs after the sandbox, over the values the envelope carries, before the envelope is signed", async () => {
    const order: string[] = [];
    const { validator, requests } = recording((request) => {
      order.push(`server:${request.scope}`);
      return { errors: [] };
    });
    const wasm = {
      run: async (request: WasmValidationRequest): Promise<WasmSubmissionOutcome> => {
        order.push("wasm");
        return { errors: [], values: request.context.values };
      }
    } as unknown as WasmValidationHost;
    const signer: SigningProvider = {
      id: "stub",
      sign: async () => {
        order.push("sign");
        return [{ signature: "sig", algorithm: "none", signedAt: 0, participantId: "p" }];
      }
    };
    const hooks: FormHooks = {
      transformValues: [
        (values) => {
          order.push("transform");
          return { ...values, notes: `${String(values.notes)}!` };
        }
      ]
    };
    const runtime = makeRuntime(endJourney(), { journeyServerValidator: validator, wasmValidationHost: wasm, signingProvider: signer, hooks });
    runtime.setValue("abroad.nation", "FR"); // Off the path once resident: never sent.
    await toDetails(runtime);

    const result = await runtime.submit("signed", envelope);
    expect(result.accepted).toBe(true);
    expect(order).toEqual(["transform", "wasm", "server:journey", "sign"]);
    expect(requests).toEqual([
      {
        formId: "eligibility",
        formVersion: "4",
        journeyId: "apply",
        scope: "journey",
        values: result.canonicalSubmission?.submission.values,
        locale: "en"
      }
    ]);
    expect(requests[0]?.values).toEqual({ age: "30", resident: true, province: "ON", notes: "none!" });
  });

  it("moves a refusal to the earliest page holding it, and is never answered from memory", async () => {
    const { validator, requests } = recording(() => ({ errors: [{ code: "server.province-closed", componentId: "province" }] }));
    const runtime = makeRuntime(endJourney(), { journeyServerValidator: validator });
    const failed = recordEvents(runtime, FormEventType.SUBMISSION_FAILED);
    await toDetails(runtime);

    const refused = await runtime.submit("submit", envelope);
    expect(refused.accepted).toBe(false);
    expect(refused.errors.map((error) => [error.componentId, error.code, error.stage])).toEqual([["province", "server.province-closed", "journey-server"]]);
    expect(runtime.journeyView()?.pageId).toBe("residence");
    expect(failed.at(-1)).toEqual({ modeId: "submit", blockingErrorCount: 1, source: "journey-server", scope: "journey", outcome: "invalid" });

    // Its error stands on the page until the answer changes.
    expect((await runtime.nextPage()).reason).toBe("validation");
    await runtime.goToPage("details");
    await runtime.submit("submit", envelope);
    expect(requests).toHaveLength(2);
  });

  it("blocks when it cannot reach the server or gets a 4xx unless the journey says to carry on; warnings let it through", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = makeRuntime(endJourney(), { journeyServerValidator: () => Promise.reject(new Error("offline")) });
    await toDetails(down);
    const blocked = await down.submit("submit", envelope);
    expect(blocked.accepted).toBe(false);
    expect(blocked.errors).toEqual([
      {
        id: "journey_end_unavailable",
        code: "journey.server-unavailable",
        stage: "journey",
        source: "client",
        severity: "error",
        parameters: { scope: "journey", reason: "network" }
      }
    ]);

    // The page's own onUnavailable does not govern the end: the journey's does.
    const carryOn = makeRuntime(endJourney({ end: "server", onUnavailable: "continue" }), {
      journeyServerValidator: () => Promise.reject(new Error("offline"))
    });
    await toDetails(carryOn);
    expect((await carryOn.submit("submit", envelope)).accepted).toBe(true);

    const warned = makeRuntime(endJourney(), {
      journeyServerValidator: async () => ({ errors: [{ code: "server.note", componentId: "notes", severity: "warning" }] })
    });
    await toDetails(warned);
    expect((await warned.submit("submit", envelope)).accepted).toBe(true);

    // A 4xx is no verdict: the submission stops as on an outage.
    const refusing = makeRuntime(endJourney(), { journeyServerValidator: () => Promise.reject(httpError(422 + 1)) });
    await toDetails(refusing);
    const stopped = await refusing.submit("submit", envelope);
    expect(stopped.accepted).toBe(false);
    expect(stopped.errors.map((entry) => [entry.code, entry.parameters?.reason, entry.parameters?.status])).toEqual([
      ["journey.server-unavailable", "server-error", 423]
    ]);
  });

  it("counts a missing validator as unavailable; a download and a builder's preview skip the check", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unwired = makeRuntime(endJourney());
    await toDetails(unwired);
    const refused = await unwired.submit("submit", envelope);
    expect(refused.errors.map((entry) => [entry.code, entry.parameters?.reason])).toEqual([["journey.server-unavailable", "missing"]]);
    expect(error).toHaveBeenCalledTimes(1);

    // A download keeps the person's answers offline.
    const offline = makeRuntime(endJourney());
    const events = recordEvents(offline, FormEventType.JOURNEY_CHECK_STARTED);
    await toDetails(offline);
    expect((await offline.submit("submit", envelope, { journeyEndCheck: "skip" })).accepted).toBe(true);
    expect(events).toEqual([]);

    const preview = recording();
    const previewing = makeRuntime(endJourney(), {
      journeyConfiguration: { journeys: [endJourney()] },
      journeyServerValidator: preview.validator
    });
    await toDetails(previewing);
    expect((await previewing.submit("submit", envelope)).accepted).toBe(true);
    expect(preview.requests).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("checks a final page that asks for the server in its Continue's place, kept to the page", async () => {
    let reply: JourneyValidationResponse = { errors: [{ code: "server.notes", componentId: "notes" }] };
    const { validator, requests } = recording(() => reply);
    const runtime = makeRuntime(journeyWith({ details: { validation: { server: true } } }), { journeyServerValidator: validator });
    const started = recordEvents(runtime, FormEventType.JOURNEY_CHECK_STARTED);
    await toDetails(runtime);

    const refused = await runtime.submit("submit", envelope);
    expect(refused.accepted).toBe(false);
    expect(refused.errors.map((error) => [error.componentId, error.code])).toEqual([["notes", "server.notes"]]);
    expect(requests[0]).toMatchObject({ scope: "page", pageId: "details", values: { age: "30", resident: true, province: "ON", notes: "none" } });
    expect(started[0]).toMatchObject({ scope: "page", pageId: "details" });

    // Another page's error in the reply is not the final page's to judge.
    reply = { errors: [{ code: "server.province", componentId: "province" }] };
    runtime.setValue("notes", "fixed");
    expect((await runtime.submit("submit", envelope)).accepted).toBe(true);

    // Deferred, the page asks nothing.
    const deferredRuntime = makeRuntime(journeyWith({ details: { validation: { server: true, continue: "defer" } } }), { journeyServerValidator: validator });
    await toDetails(deferredRuntime);
    const before = requests.length;
    expect((await deferredRuntime.submit("submit", envelope)).accepted).toBe(true);
    expect(requests).toHaveLength(before);
  });

  it("cannot be called off: the page waits while it is out", async () => {
    const pending = deferred<JourneyValidationResponse>();
    let signal: AbortSignal | undefined;
    const runtime = makeRuntime(endJourney(), {
      journeyServerValidator: (_request, options) => {
        signal = options?.signal;
        return pending.promise;
      }
    });
    await toDetails(runtime);

    const submitting = runtime.submit("submit", envelope);
    await vi.waitFor(() => expect(runtime.journeyView()?.pending).toBe("journey"));
    expect(await runtime.previousPage()).toEqual({ ok: false, pageId: "details", reason: "pending" });
    expect(await runtime.goToPage("about")).toEqual({ ok: false, pageId: "details", reason: "pending" });
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "details", reason: "pending" });
    runtime.setValue("notes", "changed meanwhile");
    expect(signal?.aborted).toBe(false);

    pending.resolve({ errors: [] });
    const result = await submitting;
    expect(result.accepted).toBe(true);
    // The submit judged its snapshot.
    expect(result.canonicalSubmission?.submission.values.notes).toBe("none");
  });
});

describe("journey server checks: a reply the runtime cannot read", () => {
  it("counts a page's reply whose path the form cannot place as malformed, and never leaves the check pending", async () => {
    let reply: unknown = { errors: [{ code: "bad", path: "/notes" }] };
    const runtime = makeRuntime(serverPage(), { journeyServerValidator: async () => reply as JourneyValidationResponse });
    const completed = recordEvents(runtime, FormEventType.JOURNEY_CHECK_COMPLETED);
    await toOverseas(runtime);

    // A JSON Pointer (Ajv's `instancePath`) is no value path: no verdict, so the page's rule for
    // an unavailable server decides — and the check has ended either way.
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "server-unavailable" });
    expect(completed).toHaveLength(1);
    expect(completed.at(-1)).toMatchObject({ scope: "page", pageId: "overseas", outcome: "unavailable", reason: "malformed" });
    expect(runtime.journeyView()?.pending).toBeUndefined();

    // A reply that throws as it is read: the same, not a page stuck on "Checking…".
    reply = {
      get errors(): unknown {
        throw new Error("unreadable");
      }
    };
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "server-unavailable" });
    expect(completed).toHaveLength(2);
    expect(completed.at(-1)).toMatchObject({ outcome: "unavailable", reason: "malformed" });
    expect(runtime.journeyView()?.pending).toBeUndefined();

    reply = { errors: [] };
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
  });

  it("counts an end check's unreadable reply as the server unavailable, and leaves the journey free to move and submit", async () => {
    let reply: unknown = { errors: [{ code: "bad", path: "/notes" }] };
    const runtime = makeRuntime(journeyWith({}, { validation: { end: "server" } }), {
      journeyServerValidator: async () => reply as JourneyValidationResponse
    });
    const completed = recordEvents(runtime, FormEventType.JOURNEY_CHECK_COMPLETED);
    await toDetails(runtime);

    const refused = await runtime.submit("submit", envelope);
    expect(refused.accepted).toBe(false);
    expect(refused.errors.map((error) => [error.code, error.parameters?.reason])).toEqual([["journey.server-unavailable", "malformed"]]);
    expect(completed.at(-1)).toMatchObject({ scope: "journey", outcome: "unavailable", reason: "malformed" });
    expect(runtime.journeyView()?.pending).toBeUndefined();
    expect(runtime.state().submission.status).toBe("rejected");

    // Nothing holds the journey: Back, a jump and the next submit all work.
    expect(await runtime.previousPage()).toEqual({ ok: true, pageId: "residence" });
    expect(await runtime.goToPage("details")).toEqual({ ok: true, pageId: "details" });
    reply = { errors: [] };
    expect((await runtime.submit("submit", envelope)).accepted).toBe(true);
  });
});

describe("journey server checks: what counts as the server's word", () => {
  it("lets a server's error on a group, or on a field of a repeating section, go once the answers under it change", async () => {
    const shape: FormDefinition = {
      id: "grouped",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "name", type: "text", configuration: {} },
            {
              // Not data-scoping: its fields are stored at their own keys, nothing under `contact.`.
              id: "contact",
              type: "fieldset",
              configuration: {},
              children: { content: [{ id: "email", type: "text", configuration: {} }, { id: "phone", type: "text", configuration: {} }] }
            },
            {
              id: "items",
              type: "repeatingSection",
              configuration: {},
              collection: {},
              children: { content: [{ id: "sku", type: "text", configuration: {} }] }
            },
            { id: "done", type: "text", configuration: {} }
          ]
        }
      },
      journey: {
        journeys: [
          {
            id: "grouped",
            pages: [
              { id: "p1", components: ["name"] },
              { id: "p2", components: ["contact", "items"] },
              { id: "p3", components: ["done"] }
            ]
          }
        ]
      }
    };
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(shape, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(shape.root)])
    });
    expect((await runtime.nextPage()).pageId).toBe("p2");

    // "One of email or phone", said of the group.
    runtime.setErrors([{ code: "contact.one-of", componentId: "contact" }]);
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "p2", reason: "validation" });
    runtime.setValue("email", "a@b.co");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "p3" });
    expect(runtime.errors()).toEqual([]);

    // A field of the section's entries, named by its component alone: its answers are at `items[0].sku`.
    await runtime.previousPage();
    runtime.addRow("items", { sku: "X1" });
    runtime.setErrors([{ code: "sku.unknown", componentId: "sku" }]);
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "p2", reason: "validation" });
    // Another field's answer is not this one's.
    runtime.setValue("phone", "555");
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "p2", reason: "validation" });
    runtime.setValue("items[0].sku", "X2");
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "p3" });
    expect(runtime.errors()).toEqual([]);
  });

  it("tells the page's own stages from the server's word by where an error came from, never by its source", async () => {
    // A host's stage for a remote rule, which calls its findings the server's.
    const remote: ValidationStage = {
      id: "remote",
      version: "1",
      validate: (context) => ({
        errors:
          context.values["abroad.nation"] === "XX"
            ? [{ code: "country.taken", componentId: "country", stage: "remote", source: "server" }]
            : [{ code: "country.similar", componentId: "country", stage: "remote", source: "server", severity: "warning" }]
      })
    };
    const { validator, requests } = recording(() => ({ errors: [{ code: "server.unusual", componentId: "country", severity: "warning" }] }));
    const runtime = makeRuntime(serverPage(), { journeyServerValidator: validator, stages: [remote] });
    runtime.setValue("age", "30");
    expect((await runtime.nextPage()).pageId).toBe("overseas");

    // The page's own error blocks, and the server is not asked about answers the page refused.
    runtime.setValue("abroad.nation", "XX");
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "validation" });
    expect(requests).toEqual([]);
    expect(codesOf(runtime)).toEqual([["country", "country.taken"]]);

    // A reply of warnings is merged with the page's own, never wipes them.
    runtime.setValue("abroad.nation", "FR");
    expect(await runtime.nextPage()).toEqual({ ok: false, pageId: "overseas", reason: "warnings" });
    expect(requests).toHaveLength(1);
    expect(codesOf(runtime)).toEqual([
      ["country", "country.similar"],
      ["country", "server.unusual"]
    ]);
    expect(await runtime.nextPage()).toEqual({ ok: true, pageId: "details" });
  });
});
