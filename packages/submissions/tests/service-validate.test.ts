import { describe, expect, it } from "vitest";
import {
  FormRuntime,
  ServerValidationRunner,
  SubmissionModeRegistry,
  WASM_ABI_VERSION,
  ValidationPipeline,
  createFieldConstraintsStage,
  type CanonicalSubmission,
  type FormDefinition,
  type KernelValidator,
  type ServerValidationContext,
  type ValidationResult
} from "@argusvane/datum-engine";

import {
  InMemorySubmissionStore,
  SUBMISSION_ROUTES,
  createKernelValidator,
  createProgramHostValidator,
  createSubmissionService,
  isSubmissionOutcome,
  errorResponse,
  parseValidateRequest,
  receiveResponse,
  errorsBody,
  statusOf,
  validateResponse,
  validationBody,
  type SubmissionSettings,
  type SubmissionValidator
} from "../src/index.js";

/**
 * Checking answers without keeping them: `validate` gives `receive`'s verdict — the
 * sandbox's, then the server's hooks' — for the whole submission, a journey, or one page of it,
 * and writes nothing.
 */

const eq = (path: string, value: string | boolean): string => `${path} = ${JSON.stringify(value)}`;

const ELIGIBILITY: FormDefinition = {
  id: "eligibility",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: { title: "Eligibility" },
    children: {
      content: [
        { id: "resident", type: "select", configuration: { required: true } },
        { id: "employed", type: "checkbox", configuration: {} },
        { id: "business_name", type: "text", configuration: { required: true } },
        { id: "employer", type: "text", configuration: { required: true } },
        { id: "email", type: "text", configuration: { required: true } },
        { id: "exit_message", type: "html", configuration: {} }
      ]
    }
  },
  journey: {
    journeys: [
      {
        id: "apply",
        pages: [
          { id: "residency", components: ["resident"], routes: [{ when: eq("resident", "no"), to: "ineligible" }] },
          { id: "work", components: ["employed"], routes: [{ when: eq("employed", true), to: "employment" }] },
          { id: "self", components: ["business_name"], routes: [{ to: "contact" }] },
          { id: "employment", components: ["employer"] },
          { id: "contact", components: ["email"], routes: [{ to: "$end" }] },
          { id: "ineligible", kind: "exit", components: ["exit_message"] }
        ]
      }
    ]
  }
};

type HookErrors = ValidationResult["errors"];

/** A server whose one hook records what it was handed and answers what `respond` says. */
async function make(options: { respond?: (context: ServerValidationContext) => HookErrors; validator?: SubmissionValidator } = {}) {
  const calls: ServerValidationContext[] = [];
  const runner = new ServerValidationRunner([
    {
      id: "recording",
      version: "1.0.0",
      async validate(context) {
        calls.push(context);
        return { errors: options.respond ? options.respond(context) : [] };
      }
    }
  ]);
  const store = new InMemorySubmissionStore();
  let n = 0;
  const service = createSubmissionService({
    store,
    validator: options.validator ?? createKernelValidator(),
    ids: () => `rec-${++n}`,
    serverValidationRunner: runner,
    serverServicesProvider: () => ({ registry: "the server's own" })
  });
  await service.register(ELIGIBILITY);
  return { store, service, calls };
}

const SELF_EMPLOYED = { resident: "yes", business_name: "Shop", email: "a@b.co" };

/** Bare values, as a journey's check sends them; `null` names no journey. */
function bare(values: Record<string, unknown>, journeyId: string | null = "apply") {
  return { formId: "eligibility", formVersion: "1.0.0", values, locale: "en", ...(journeyId !== null ? { journeyId } : {}) };
}

function envelopeOf(values: Record<string, unknown>): CanonicalSubmission {
  return {
    versionContext: {
      form: { id: ELIGIBILITY.id, version: ELIGIBILITY.version },
      client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" }
    },
    submission: { locale: "en", values, journey: { id: "apply" } }
  };
}

function codes(errors: ReadonlyArray<{ code: string; componentId?: string; severity?: string }>): string[] {
  return errors.map((error) => `${error.componentId ?? "-"}:${error.code}${error.severity && error.severity !== "error" ? `(${error.severity})` : ""}`);
}

describe("SubmissionService.validate", () => {
  it("keeps nothing: no record, no blob, the catalog's counts unchanged", async () => {
    const { service, store } = await make({ respond: () => [{ code: "custom.note", stage: "hook", source: "server", severity: "warning" }] });
    await service.validate(bare(SELF_EMPLOYED));
    await service.validate(bare({ resident: "yes" }));
    await service.validate({ ...bare({ resident: "yes", business_name: "Shop" }), scope: "page", pageId: "self" });
    await service.validate({ ...bare(SELF_EMPLOYED), scope: "journey" });
    await service.validate({ document: envelopeOf(SELF_EMPLOYED) });
    expect((await store.listRecords()).total).toBe(0);
    expect((await service.listCatalog())[0]?.counts).toEqual({ accepted: 0, rejected: 0 });
  });

  it("answers a page check for the page's components and the form as a whole, never for later pages", async () => {
    const { service } = await make({
      respond: () => [
        { code: "custom.form", stage: "hook", source: "server", severity: "warning" },
        { code: "custom.email", componentId: "email", stage: "hook", source: "server" },
        { code: "custom.name", componentId: "business_name", stage: "hook", source: "server", severity: "warning" },
        { code: "custom.path", path: "email", stage: "hook", source: "server" }
      ]
    });
    // email is required, but on the contact page, which the person has not reached.
    const page = await service.validate({ ...bare({ resident: "yes" }), scope: "page", pageId: "self" });
    expect(page.accepted).toBe(false);
    expect(codes(page.errors)).toEqual(["business_name:required"]);

    const answered = await service.validate({ ...bare({ resident: "yes", business_name: "Shop" }), scope: "page", pageId: "self" });
    expect(answered.accepted).toBe(true);
    expect(codes(answered.errors)).toEqual(["-:custom.form(warning)", "business_name:custom.name(warning)"]);
    expect(answered.journey).toEqual({ pages: ["residency", "work", "self", "contact"], end: "end" });

    // The whole journey: the contact page's required email blocks, and the hooks never run.
    const journey = await service.validate({ ...bare({ resident: "yes", business_name: "Shop" }), scope: "journey" });
    expect(codes(journey.errors)).toEqual(["email:required"]);
  });

  it("leaves journey.exit out of a page check: an exit page is where Continue leads", async () => {
    const { service } = await make();
    const page = await service.validate({ ...bare({ resident: "no" }), scope: "page", pageId: "residency" });
    expect(page).toEqual({ accepted: true, errors: [], journey: { pages: ["residency", "ineligible"], end: "exit" } });
    const journey = await service.validate({ ...bare({ resident: "no" }), scope: "journey" });
    expect(journey.accepted).toBe(false);
    expect(codes(journey.errors)).toEqual(["-:journey.exit"]);
  });

  it("answers a page the server's path does not take with a clean verdict, and says which path it took", async () => {
    const { service, calls } = await make({ respond: () => [{ code: "custom.employer", componentId: "employer", stage: "hook", source: "server" }] });
    // employer is required and flagged by the hook, but the employment page is off this path.
    const verdict = await service.validate({ ...bare({ resident: "yes", employed: false, business_name: "Shop" }), scope: "page", pageId: "employment" });
    expect(verdict).toEqual({ accepted: true, errors: [], journey: { pages: ["residency", "work", "self", "contact"], end: "end" } });
    expect(calls).toHaveLength(1);
  });

  it("hands the hooks the scope of the check and every submittable answer the sandbox kept", async () => {
    const { service, calls } = await make();
    await service.validate({ ...bare({ resident: "yes", business_name: "Shop", employer: "stale", rogue: 1 }), scope: "page", pageId: "self" });
    expect(calls[0]?.scope).toEqual({ kind: "page", journeyId: "apply", pageId: "self", componentIds: ["business_name"] });
    // The employment page's stale answer is off the path, and the unknown key stripped.
    expect(calls[0]?.values).toEqual({ resident: "yes", business_name: "Shop" });
    expect(calls[0]?.validationContext).toEqual({ formId: "eligibility", values: { resident: "yes", business_name: "Shop" }, locale: "en" });
    expect(calls[0]?.services).toEqual({ registry: "the server's own" });
    expect(calls[0]?.environment).toBe("server");

    await service.validate({ ...bare(SELF_EMPLOYED), scope: "journey" });
    expect(calls[1]?.scope).toEqual({ kind: "journey", journeyId: "apply" });
    await service.validate(bare(SELF_EMPLOYED));
    expect(calls[2]?.scope).toEqual({ kind: "submission", journeyId: "apply" });
    await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(SELF_EMPLOYED) });
    expect(calls[3]?.scope).toEqual({ kind: "submission", journeyId: "apply" });
    expect(calls[3]?.values).toEqual(SELF_EMPLOYED);
  });

  it("skips the hooks when the sandbox already blocks in scope", async () => {
    const { service, calls } = await make();
    const blocked = await service.validate({ ...bare({ resident: "yes" }), scope: "journey" });
    expect(blocked.accepted).toBe(false);
    const page = await service.validate({ ...bare({ resident: "yes" }), scope: "page", pageId: "self" });
    expect(page.accepted).toBe(false);
    const received = await service.receive({ ...bare({ resident: "yes" }), submissionKey: crypto.randomUUID() });
    expect(received.record.status).toBe("rejected");
    expect(calls).toHaveLength(0);
    // A later page's error is out of a page check's scope, so the page's own hooks run.
    await service.validate({ ...bare({ resident: "yes" }), scope: "page", pageId: "residency" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a journey the form does not have as the verdict, for any scope, without running the hooks", async () => {
    const { service, calls } = await make();
    for (const scope of [{}, { scope: "journey" as const }, { scope: "page" as const, pageId: "residency" }]) {
      const verdict = await service.validate({ ...bare(SELF_EMPLOYED, "renew"), ...scope });
      expect(verdict).toEqual({ accepted: false, errors: [{ code: "journey.unknown", severity: "error", source: "server", parameters: { journey: "renew" } }] });
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed check as a bad document (400), and a form it does not know as unknown (404)", async () => {
    const { service } = await make();
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ["an unknown page", () => service.validate({ ...bare(SELF_EMPLOYED), scope: "page", pageId: "payment" })],
      ["a page check without a page", () => service.validate({ ...bare(SELF_EMPLOYED), scope: "page" })],
      ["a page with another scope", () => service.validate({ ...bare(SELF_EMPLOYED), scope: "journey", pageId: "self" })],
      ["a page without a scope", () => service.validate({ ...bare(SELF_EMPLOYED), pageId: "self" })],
      ["an unknown scope", () => service.validate({ ...bare(SELF_EMPLOYED), scope: "form" as never })]
    ];
    for (const [name, refusal] of refusals) {
      const error = await refusal().then(
        () => undefined,
        (reason: unknown) => reason as { code: string }
      );
      expect(error?.code, name).toBe("bad_document");
      expect(statusOf(error as { code: "bad_document" }), name).toBe(400);
    }
    await expect(service.validate({ ...bare(SELF_EMPLOYED), scope: "page", pageId: "payment" })).rejects.toThrow('Journey "apply" has no page "payment".');
    // A page check that names no journey is judged by the form's only one.
    expect((await service.validate({ ...bare(SELF_EMPLOYED, null), scope: "page", pageId: "self" })).journey).toEqual({ pages: ["residency", "work", "self", "contact"], end: "end" });
    await expect(service.validate({ formId: "other", formVersion: "1", values: {}, scope: "journey" })).rejects.toMatchObject({ code: "unknown_form" });
  });

  it("answers 503 when a hook throws, and keeps nothing, from validate and receive alike", async () => {
    const { service, store } = await make({
      respond: () => {
        throw new Error("registry offline");
      }
    });
    for (const call of [
      () => service.validate({ ...bare(SELF_EMPLOYED), scope: "journey" }),
      () => service.validate({ ...bare({ resident: "yes", business_name: "Shop" }), scope: "page", pageId: "self" }),
      () => service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(SELF_EMPLOYED) })
    ]) {
      const error = await call().then(
        () => undefined,
        (reason: unknown) => reason as { code: "validator_unavailable"; message: string }
      );
      expect(error?.code).toBe("validator_unavailable");
      expect(error?.message).toContain("registry offline");
      expect(statusOf(error!)).toBe(503);
    }
    expect((await store.listRecords()).total).toBe(0);
  });

  it("answers 503 when the sandbox itself throws", async () => {
    const broken: SubmissionValidator = {
      id: "broken",
      validate: () => Promise.reject(new Error("the sandbox ran out of memory"))
    };
    const { service, store } = await make({ validator: broken });
    await expect(service.validate(bare(SELF_EMPLOYED))).rejects.toMatchObject({ code: "validator_unavailable" });
    await expect(service.receive({ ...bare(SELF_EMPLOYED), submissionKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "validator_unavailable" });
    expect((await store.listRecords()).total).toBe(0);
  });
});

describe("SubmissionService.receive with the server's hooks", () => {
  it("runs them after the sandbox: an error refuses the record, a warning does not", async () => {
    const { service } = await make({
      respond: (context) =>
        context.values.business_name === "Taken Ltd"
          ? [{ code: "custom.nameTaken", componentId: "business_name", path: "business_name", stage: "hook", source: "server", parameters: { owner: "someone" } }]
          : [{ code: "custom.checkLater", componentId: "email", stage: "hook", source: "server", severity: "warning" }]
    });
    const refused = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf({ ...SELF_EMPLOYED, business_name: "Taken Ltd" }) });
    expect(refused.record.status).toBe("rejected");
    expect(refused.errors).toEqual([
      { code: "custom.nameTaken", componentId: "business_name", path: "business_name", severity: "error", source: "server", parameters: { owner: "someone" } }
    ]);
    expect(codes(refused.record.errors)).toEqual(["business_name:custom.nameTaken"]);

    const accepted = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(SELF_EMPLOYED) });
    expect(accepted.record.status).toBe("accepted");
    expect(accepted.receipt?.kind).toBe("success");
    expect(accepted.errors).toEqual([]);
    // The warning stays on the record for the Data tab to show.
    expect(codes(accepted.record.errors)).toEqual(["email:custom.checkLater(warning)"]);
  });

  it("refuses a body that asks for a check, and writes no record for it", async () => {
    const { service, store, calls } = await make();
    await expect(service.receive({ ...bare(SELF_EMPLOYED), scope: "page", pageId: "self", submissionKey: crypto.randomUUID() } as never)).rejects.toMatchObject({ code: "bad_document" });
    await expect(service.receive({ ...bare(SELF_EMPLOYED), scope: "journey", submissionKey: crypto.randomUUID() } as never)).rejects.toMatchObject({ code: "bad_document" });
    await expect(service.receive({ document: { ...envelopeOf(SELF_EMPLOYED), pageId: "self" }, submissionKey: crypto.randomUUID() } as never)).rejects.toMatchObject({ code: "bad_document" });
    expect((await store.listRecords()).total).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("warnings do not refuse", () => {
  // Only a blocking error refuses a submission. A verdict with only warnings
  // passes the browser and is accepted on receipt.
  const warnOnName: KernelValidator = (context) => ({
    errors: context.values.business_name === "Shop" ? [{ code: "custom.shortName", componentId: "business_name", stage: "plugin", source: "custom", severity: "warning" }] : []
  });

  it("accepts a verdict with only warnings in validate and receive alike, and reports the warnings", async () => {
    const { service } = await make({ validator: createKernelValidator([warnOnName]) });
    const checked = await service.validate(bare(SELF_EMPLOYED));
    expect(checked.accepted).toBe(true);
    expect(checked.errors).toEqual([{ code: "custom.shortName", componentId: "business_name", severity: "warning", source: "server" }]);
    const page = await service.validate({ ...bare({ resident: "yes", business_name: "Shop" }), scope: "page", pageId: "self" });
    expect(page.accepted).toBe(true);
    expect(codes(page.errors)).toEqual(["business_name:custom.shortName(warning)"]);

    const received = await service.receive({ ...bare(SELF_EMPLOYED), submissionKey: crypto.randomUUID() });
    expect(received.record.status).toBe("accepted");
    expect(codes(received.record.errors)).toEqual(["business_name:custom.shortName(warning)"]);
  });

  it("still refuses when a warning comes with an error", async () => {
    const { service } = await make({ validator: createKernelValidator([warnOnName]) });
    const verdict = await service.validate(bare({ resident: "yes", business_name: "Shop" }));
    expect(verdict.accepted).toBe(false);
    expect(codes(verdict.errors)).toEqual(["email:required", "business_name:custom.shortName(warning)"]);
    expect((await service.receive({ ...bare({ resident: "yes", business_name: "Shop" }), submissionKey: crypto.randomUUID() })).record.status).toBe("rejected");
  });
});

describe("a page check and the browser's Continue agree on Required when", () => {
  const REACH: FormDefinition = {
    id: "reach",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "contact", type: "radio", configuration: {} },
          { id: "phone", type: "text", configuration: {}, rules: { requiredWhen: eq("contact", "phone") } },
          { id: "staff_note", type: "text", configuration: {}, rules: { requiredWhen: eq("host.role", "staff") } },
          { id: "both", type: "text", configuration: { required: true }, rules: { requiredWhen: eq("contact", "never") } }
        ]
      }
    },
    journey: {
      journeys: [
        {
          id: "reach",
          pages: [
            { id: "how", components: ["contact", "phone", "staff_note"] },
            { id: "finish", components: ["both"], routes: [{ to: "$end" }] }
          ]
        }
      ]
    }
  };

  it("gives the page's verdict for phone on both sides, and leaves the later page's ticked field out of it", async () => {
    const store = new InMemorySubmissionStore();
    const service = createSubmissionService({ store, validator: createKernelValidator(), ids: () => "rec" });
    await service.register(REACH);
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ contact: "phone" }, ["phone:required"]],
      [{ contact: "phone", phone: "555 0100" }, []],
      [{ contact: "email" }, []]
    ];
    for (const [values, expected] of cases) {
      const label = JSON.stringify(values);
      const runtime = new FormRuntime(REACH, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(REACH.root)]) });
      for (const [key, value] of Object.entries(values)) {
        runtime.setValue(key, value);
      }
      const browser = await runtime.validate({ page: "how" });
      const server = await service.validate({ formId: "reach", formVersion: "1.0.0", values, locale: "en", journeyId: "reach", scope: "page", pageId: "how" });
      expect(codes(browser), `${label}: browser`).toEqual(expected);
      expect(codes(server.errors), `${label}: server`).toEqual(expected);
      expect(server.accepted, label).toBe(expected.length === 0);
      // The whole journey holds the ticked field on the later page, on both sides.
      expect(codes(await runtime.validate()), `${label}: browser, whole`).toEqual([...expected, "both:required"]);
      expect(codes((await service.validate({ formId: "reach", formVersion: "1.0.0", values, locale: "en", journeyId: "reach", scope: "journey" })).errors), `${label}: server, whole`).toEqual([
        ...expected,
        "both:required"
      ]);
    }
    // A host-bound rule: the browser with a host context asks on its page; the server, with none, does not.
    const hosted = new FormRuntime(REACH, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(REACH.root)]), hostContext: { role: "staff" } });
    hosted.setValue("contact", "email");
    expect(codes(await hosted.validate({ page: "how" }))).toEqual(["staff_note:required"]);
    const lenient = await service.validate({ formId: "reach", formVersion: "1.0.0", values: { contact: "email" }, locale: "en", journeyId: "reach", scope: "page", pageId: "how" });
    expect(lenient).toEqual({ accepted: true, errors: [], journey: { pages: ["how", "finish"], end: "end" } });
    expect((await store.listRecords()).total).toBe(0);
  });
});

describe("the validate route", () => {
  it("is listed, and answers 503 for a validator that is unavailable", () => {
    expect(SUBMISSION_ROUTES.find((route) => route.path === "/api/submissions/validate")).toMatchObject({ method: "POST", operation: "validate" });
    expect(statusOf({ code: "validator_unavailable" })).toBe(503);
  });

  it("answers the wire's verdict: blocking errors, then notes; field only when named, message only when given, never parameters", async () => {
    const { service } = await make({
      respond: () => [
        { code: "custom.nameTaken", componentId: "business_name", stage: "hook", source: "server", parameters: { owner: "someone@example.com" } },
        { code: "custom.form", stage: "hook", source: "server", severity: "warning" },
        { code: "custom.hint", componentId: "business_name", stage: "hook", source: "server", severity: "info" }
      ]
    });
    const verdict = await service.validate({ ...bare({ resident: "yes", business_name: "Shop" }), scope: "page", pageId: "self" });
    const said = (note: string) => verdict.errors.map((error) => ({ ...error, ...(error.severity === undefined || error.severity === "error" ? { message: note } : {}) }));
    const body = validationBody({ ...verdict, errors: said("Name taken") });
    expect(body).toEqual({
      accepted: false,
      errors: [{ field: "business_name", code: "custom.nameTaken", message: "Name taken" }],
      notes: [
        { code: "custom.form", severity: "warning" },
        { field: "business_name", code: "custom.hint", severity: "info" }
      ]
    });
    expect(JSON.stringify(body)).not.toContain("someone");
    expect("journey" in body).toBe(false);
    // `notes` is absent when there is nothing to say, never an empty list.
    expect(validationBody({ accepted: true, errors: [] })).toEqual({ accepted: true, errors: [] });
    expect(validateResponse({ accepted: true, errors: [] })).toEqual({ status: 200, body: { accepted: true, errors: [] } });
  });

  it("reads a check's request strictly: { document, scope, pageId? }, and refuses the rest as bad_document (400)", () => {
    const document = envelopeOf({ resident: "yes" });
    expect(parseValidateRequest({ document, scope: "journey" })).toEqual({ document, scope: "journey" });
    expect(parseValidateRequest({ document, scope: "page", pageId: "self" })).toEqual({ document, scope: "page", pageId: "self" });
    const refused: Array<[string, unknown]> = [
      ["no body", null],
      ["a list", []],
      ["the bare envelope", document],
      ["no document", { scope: "journey" }],
      ["a document that is no object", { document: "x", scope: "journey" }],
      ["no scope", { document }],
      ["an unknown scope", { document, scope: "form" }],
      ["a pageId with scope journey", { document, scope: "journey", pageId: "self" }],
      ["a page check without a page", { document, scope: "page" }],
      ["a page check with an empty page", { document, scope: "page", pageId: "" }]
    ];
    for (const [name, body] of refused) {
      let error: unknown;
      try {
        parseValidateRequest(body);
      } catch (reason) {
        error = reason;
      }
      expect(error, name).toMatchObject({ code: "bad_document" });
      expect(errorResponse(error), name).toEqual({ status: 400, body: { errors: [{ code: "bad_document" }] } });
    }
  });

  it("answers a run that gave no verdict as a 503 with the run's code, on validate and receive, and keeps nothing", async () => {
    for (const code of ["wasm.execution_error", "definition.tooDeep", "outcome_too_large"]) {
      const failing: SubmissionValidator = { id: "failing", validate: async () => ({ errors: [{ code, stage: "wasm", source: "wasm" }] }) as never };
      const { service, store } = await make({ validator: failing });
      for (const call of [() => service.validate({ ...bare(SELF_EMPLOYED), scope: "journey" }), () => service.receive({ ...bare(SELF_EMPLOYED), submissionKey: crypto.randomUUID() })]) {
        const error = await call().then(
          () => undefined,
          (reason: unknown) => reason
        );
        expect(error, code).toMatchObject({ code });
        expect(errorResponse(error), code).toEqual({ status: 503, body: { errors: [{ code }] } });
      }
      expect((await store.listRecords()).total, code).toBe(0);
    }
  });

  it("answers a host context the host got wrong as 503 server.unavailable, never a 500", async () => {
    const { service } = await make({});
    const error = await service.validate({ ...bare(SELF_EMPLOYED), scope: "journey" }, { hostContext: "admin" as never }).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(errorResponse(error)).toEqual({ status: 503, body: { errors: [{ code: "server.unavailable" }] } });
    expect(statusOf({ code: "server.unavailable" })).toBe(503);
    // Anything else is no refusal the service knows.
    expect(errorResponse(new Error("boom"))).toBeUndefined();
  });

  it("answers a delivery as 200 with the receipt, or 422 with the record's errors", async () => {
    const { service } = await make({});
    const accepted = await service.receive({ ...bare({ resident: "yes", business_name: "Shop", email: "a@b.ca" }), submissionKey: crypto.randomUUID() });
    expect(receiveResponse(accepted)).toMatchObject({ status: 200, body: { status: "accepted" } });
    const rejected = await service.receive({ ...bare({}), submissionKey: crypto.randomUUID() });
    expect(receiveResponse(rejected).status).toBe(422);
    expect(errorsBody([{ code: "form.custom" }, { code: "required", componentId: "name" }])).toEqual({ errors: [{ code: "form.custom" }, { field: "name", code: "required" }] });
    expect(JSON.stringify(errorsBody([{ code: "form.custom" }]))).toBe('{"errors":[{"code":"form.custom"}]}');
  });
});

describe("a sandbox that cannot give a verdict is unavailable (503), whatever form its failure takes", () => {
  const answering = (answer: unknown): SubmissionValidator => ({ id: "broken", validate: async () => answer as never });

  it.each([
    ["null", null],
    ["an empty object", {}],
    ["errors that is not a list", { errors: "none" }],
    ["a string", "ok"],
    ["a list", []],
    ["an error entry with no code", { errors: [null] }],
    ["values that is a list", { errors: [], values: [] }]
  ])("answers 503 and keeps nothing when the sandbox answers %s, from validate and receive alike", async (_name, answer) => {
    const { service, store, calls } = await make({ validator: answering(answer) });
    for (const call of [() => service.validate(bare(SELF_EMPLOYED)), () => service.receive({ ...bare(SELF_EMPLOYED), submissionKey: crypto.randomUUID() })]) {
      const error = await call().then(
        () => undefined,
        (reason: unknown) => reason as { code?: string; message?: string }
      );
      expect(error?.code).toBe("validator_unavailable");
      expect(error?.message).toContain("not a verdict");
      expect(statusOf(error as { code: "validator_unavailable" })).toBe(503);
    }
    expect((await store.listRecords()).total).toBe(0);
    // No hook ran over an answer that was no verdict.
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["404 on the program", () => new Error("fetch datum-sandbox-program.js: 404")],
    ["bad bytes the sandbox cannot compile", () => new SyntaxError("Unexpected token '<'")],
    ["no WebAssembly", () => new ReferenceError("WebAssembly is not defined")]
  ])("answers 503 and keeps nothing when the sandbox fails to start (%s)", async (_name, failure) => {
    const broken: SubmissionValidator = { id: "broken", validate: () => Promise.reject(failure()) };
    const { service, store } = await make({ validator: broken });
    await expect(service.validate(bare(SELF_EMPLOYED))).rejects.toMatchObject({ code: "validator_unavailable" });
    await expect(service.receive({ ...bare(SELF_EMPLOYED), submissionKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "validator_unavailable" });
    expect((await store.listRecords()).total).toBe(0);
  });

  it("a program host that throws, answers bytes that are not JSON, or answers JSON that is no verdict is the same refusal", async () => {
    const hosts = [
      {
        call(): string {
          throw new Error("__datum_run is not defined");
        }
      },
      { call: () => "<html>404</html>" },
      { call: () => "null" },
      { call: () => '{"errors":"none"}' },
      { call: () => '"ok"' }
    ];
    for (const host of hosts) {
      const { service, store } = await make({ validator: createProgramHostValidator(host, "quickjs", { checkProgramAbi: false }) });
      await expect(service.receive({ ...bare(SELF_EMPLOYED), submissionKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "validator_unavailable" });
      expect((await store.listRecords()).total).toBe(0);
    }
    const sound = createProgramHostValidator(currentProgram('{"errors":[],"values":{"email":"a@b.co"}}'));
    expect(await sound.validate({ formId: "eligibility", values: {}, form: ELIGIBILITY.root })).toEqual({ errors: [], values: { email: "a@b.co" } });
  });

  it("proves the program speaks this ABI once, before its first verdict, and refuses an older program that would still judge", async () => {
    // An older build's file still answers __datum_run with a verdict (it accepts everything) but
    // refuses the probe at this ABI: no submission is judged by it.
    const runs: string[] = [];
    const stale = {
      call(fn: string): string {
        runs.push(fn);
        return fn === "__datum_inspect" ? '{"ok":false,"error":{"code":"abi_mismatch","message":"older program"}}' : '{"errors":[]}';
      }
    };
    const { service, store } = await make({ validator: createProgramHostValidator(stale) });
    await expect(service.receive({ ...bare(SELF_EMPLOYED), submissionKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "validator_unavailable" });
    expect(runs).toEqual(["__datum_inspect"]);
    expect((await store.listRecords()).total).toBe(0);
    // A program with no inspect entry point at all (from before the probe existed) is refused alike.
    const noInspect = createProgramHostValidator({ call: (fn: string) => (fn === "__datum_inspect" ? JSON.stringify({ errors: [] }) : '{"errors":[]}') });
    await expect(noInspect.validate({ formId: "eligibility", values: {}, form: ELIGIBILITY.root })).rejects.toMatchObject({ code: "abi_mismatch" });
    // A current program answers the probe once; later verdicts go straight to __datum_run.
    const current = currentProgram('{"errors":[]}');
    const validator = createProgramHostValidator(current);
    for (let pass = 0; pass < 3; pass += 1) {
      await validator.validate({ formId: "eligibility", values: {}, form: ELIGIBILITY.root });
    }
    expect(current.calls).toEqual(["__datum_inspect", "__datum_run", "__datum_run", "__datum_run"]);
  });

  it("isSubmissionOutcome names the shape of a verdict", () => {
    expect(isSubmissionOutcome({ errors: [] })).toBe(true);
    expect(isSubmissionOutcome({ errors: [{ code: "required", componentId: "email" }], values: { a: 1 }, logs: [] })).toBe(true);
    for (const wrong of [null, undefined, "ok", 1, [], {}, { errors: "none" }, { errors: [1] }, { errors: [{ code: 1 }] }, { errors: [], values: null }, { errors: [], values: [] }]) {
      expect(isSubmissionOutcome(wrong), JSON.stringify(wrong)).toBe(false);
    }
  });
});

describe("SubmissionService: fail closed on the gate", () => {
  const GATE: FormDefinition = {
    id: "gate",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "a", type: "text", configuration: {} },
          { id: "staff_ref", type: "text", configuration: { required: true }, rules: { visibleWhen: 'host.role = "staff"' } }
        ]
      }
    }
  };

  async function gate(options: { validator?: SubmissionValidator; respond?: (context: ServerValidationContext) => HookErrors; definition?: FormDefinition; settings?: Partial<SubmissionSettings> } = {}) {
    const store = new InMemorySubmissionStore();
    let n = 0;
    const service = createSubmissionService({
      store,
      validator: options.validator ?? createKernelValidator(),
      ids: () => `gate-${++n}`,
      ...(options.respond
        ? { serverValidationRunner: new ServerValidationRunner([{ id: "hook", version: "1.0.0", validate: async (context: ServerValidationContext) => ({ errors: options.respond!(context) }) }]) }
        : {})
    });
    await service.register(options.definition ?? GATE, options.settings);
    return { service, store };
  }
  const input = (values: Record<string, unknown>) => ({ formId: "gate", formVersion: "1.0.0", values, locale: "en" });

  it.each([
    ["nothing (undefined)", (() => undefined) as unknown as KernelValidator],
    ["a promise (an async validator)", (async () => ({ errors: [] })) as unknown as KernelValidator],
    ["no errors list", (() => ({})) as unknown as KernelValidator],
    ["an entry with no code", (() => ({ errors: [{ severity: "error" }] })) as unknown as KernelValidator]
  ])("answers 503 and keeps nothing when a plugin validator returns %s, from validate and receive alike", async (_label, validator) => {
    const { service, store } = await gate({ validator: createKernelValidator([validator]) });
    for (const call of [() => service.validate(input({ a: "x" })), () => service.receive({ ...input({ a: "x" }), submissionKey: crypto.randomUUID() })]) {
      const error = await call().then(
        () => undefined,
        (reason: unknown) => reason as { code?: string; message?: string }
      );
      expect(error?.code).toBe("validator_unavailable");
      expect(error?.message).toContain("validator 1 returned");
      expect(statusOf(error as { code: "validator_unavailable" })).toBe(503);
    }
    expect((await store.listRecords()).total).toBe(0);
  });

  it("blocks a validator error whose severity nobody defined, and one from a hook, but not a warning or info", async () => {
    for (const severity of ["Error", "fatal", 1] as const) {
      const flagged = createKernelValidator([() => ({ errors: [{ code: "x.bad", stage: "validation", source: "wasm", severity: severity as never }] })]);
      const { service } = await gate({ validator: flagged });
      const result = await service.receive({ ...input({ a: "x" }), submissionKey: crypto.randomUUID() });
      expect(result.record.status, String(severity)).toBe("rejected");
    }
    for (const severity of ["Error", "fatal"] as const) {
      const { service } = await gate({ respond: () => [{ code: "hook.bad", stage: "hook", source: "server", severity: severity as never }] });
      expect((await service.receive({ ...input({ a: "x" }), submissionKey: crypto.randomUUID() })).record.status, String(severity)).toBe("rejected");
    }
    for (const severity of ["warning", "info"] as const) {
      const { service } = await gate({ respond: () => [{ code: "hook.note", stage: "hook", source: "server", severity }] });
      expect((await service.receive({ ...input({ a: "x" }), submissionKey: crypto.randomUUID() })).record.status, severity).toBe("accepted");
    }
  });

  it("lists the components whose visibility it could not replay on the verdict and the record, and does not demand them", async () => {
    const { service } = await gate();
    const verdict = await service.validate(input({ a: "x" }));
    expect(verdict.accepted).toBe(true);
    const result = await service.receive({ ...input({ a: "x" }), submissionKey: crypto.randomUUID() });
    expect(result.record.status).toBe("accepted");
    expect(result.record.visibilitySkipped).toEqual(["staff_ref"]);
    // Nothing skipped, nothing listed.
    const plain = await gate({ definition: { ...GATE, id: "gate", root: { ...GATE.root, children: { content: [{ id: "a", type: "text", configuration: {} }] } } } });
    expect((await plain.service.receive({ ...input({ a: "x" }), submissionKey: crypto.randomUUID() })).record.visibilitySkipped).toBeUndefined();
  });

  it("refuses a record whose server rule calls a function the server lacks, naming it, under the warn opt-in; the default and fail never register the form", async () => {
    const lacking: FormDefinition = {
      ...GATE,
      root: {
        ...GATE.root,
        children: { content: [{ id: "a", type: "text", configuration: {} }, { id: "b", type: "text", configuration: {}, rules: { requiredWhen: "regionOk(a)" } }] }
      }
    };
    // The default is fail: the form is not registered at all.
    await expect(gate({ definition: lacking })).rejects.toMatchObject({ code: "invalid_definition" });
    const { service, store } = await gate({ definition: lacking, settings: { validation: { unknownFields: "strip", formulaErrors: "warn" } } });
    const result = await service.receive({ ...input({ a: "bc" }), submissionKey: crypto.randomUUID() });
    expect(result.record.status).toBe("rejected");
    expect(result.record.errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    expect(result.record.errors[0]?.parameters).toMatchObject({ where: "rules:b:requiredWhen", function: "regionOk" });
    expect((await store.listRecords()).total).toBe(1);
  });
});

/** A stand-in for a current sandbox program: answers the ABI probe, then `verdict` to every run. */
function currentProgram(verdict: string): { calls: string[]; call(fn: string, argument: string): string } {
  const calls: string[] = [];
  return {
    calls,
    call(fn: string, argument: string): string {
      calls.push(fn);
      if (fn === "__datum_inspect") {
        const request = JSON.parse(argument) as { abi?: unknown; op?: unknown };
        return request.abi === WASM_ABI_VERSION && request.op === "public" ? '{"ok":true,"op":"public"}' : '{"ok":false}';
      }
      return verdict;
    }
  };
}
