import { describe, expect, it } from "vitest";
import { sandboxProgramHost } from "./fixtures/sandbox-host.js";
import {
  FormRuntime,
  ServerValidationRunner,
  SubmissionModeRegistry,
  ValidationPipeline,
  createFieldConstraintsStage,
  findJourney,
  formulaFunctionSignatures,
  journeyOwnership,
  kernelPageComponentIds,
  runKernel,
  type CanonicalSubmission,
  type ComponentNode,
  type Expression,
  type FormDefinition,
  type Journey,
  type JourneyValidationRequest,
  type KernelValidator,
  type ServerValidationContext
} from "@argusvane/datum-engine";
import { APPLY_ABOVE, APPLY_BELOW, presentationForm } from "@argusvane/datum-engine/tests/fixtures/presentation-form";
import { DEFAULT_FONT_PACK, createInProcessPdfProvider, handlePdfRequest, loadFontPack } from "@argusvane/datum-pdf-kernel";

import {
  InMemorySubmissionStore,
  createKernelValidator,
  createProgramHostValidator,
  createProviderPdfRenderer,
  createSubmissionService,
  recordValuesOf,
  type SubmissionValidator
} from "../src/index.js";

/**
 * Receiving and validating the answers of a journey: the envelope names the journey
 * by id only, and the server works the path out again from the values.
 */

const eq = (path: string, value: string | boolean): Expression => ({
  kind: "binary",
  operator: "eq",
  left: { kind: "path", path },
  right: { kind: "literal", value }
});

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

function envelopeOf(values: Record<string, unknown>, journey?: unknown): CanonicalSubmission {
  return {
    versionContext: {
      form: { id: ELIGIBILITY.id, version: ELIGIBILITY.version },
      client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" }
    },
    submission: { locale: "en", values, ...(journey !== undefined ? { journey: journey as { id: string } } : {}) }
  };
}

/** The form opened as the whole form (`journey.opensAs: "form"`): a body that names no journey is judged whole. */
const wholeOf = (definition: FormDefinition): FormDefinition => ({ ...definition, journey: { ...definition.journey, opensAs: "form" } }) as FormDefinition;

const EMPLOYED = { resident: "yes", employed: true, employer: "ACME", business_name: "left over", email: "a@b.co" };

async function make(validator: SubmissionValidator = createKernelValidator(), definition: FormDefinition = ELIGIBILITY) {
  const store = new InMemorySubmissionStore();
  let n = 0;
  const service = createSubmissionService({ store, validator, ids: () => `rec-${++n}` });
  await service.register(definition);
  return { store, service };
}

describe("SubmissionService: journeys", () => {
  it("judges the answers against the path the journey takes, and keeps the document as delivered", async () => {
    const { service } = await make();
    const document = envelopeOf({ resident: "yes", employed: true, employer: "ACME", email: "a@b.co" }, { id: "apply" });
    const result = await service.receive({ submissionKey: crypto.randomUUID(), document });
    // business_name is required, but on a page the employed path skips.
    expect(result.errors).toEqual([]);
    expect(result.record.status).toBe("accepted");
    expect(result.record.document).toEqual(document);
  });

  it("refuses a journey the form does not have, before judging anything, and keeps the rejected record", async () => {
    const { service, store } = await make();
    const result = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(EMPLOYED, { id: "renew" }) });
    expect(result.record.status).toBe("rejected");
    expect(result.errors).toEqual([{ code: "journey.unknown", severity: "error", source: "server", parameters: { journey: "renew" } }]);
    expect((await store.listRecords({ filter: { status: "rejected" } })).total).toBe(1);
    // A journey id that is not a string is unknown too, not ignored.
    expect((await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(EMPLOYED, { id: 7 }) })).errors.map((error) => error.code)).toEqual(["journey.unknown"]);
    // An array is no journey object: unknown here as on every host.
    expect((await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(EMPLOYED, [] as never) })).errors.map((error) => error.code)).toEqual(["journey.unknown"]);
  });

  it("refuses a journey whose pages share an id, as it does any journey that fails the shape check", async () => {
    const store = new InMemorySubmissionStore();
    let n = 0;
    const service = createSubmissionService({ store, validator: createKernelValidator(), ids: () => `rec-${++n}` });
    const [apply] = ELIGIBILITY.journey!.journeys!;
    const broken = { ...ELIGIBILITY, journey: { journeys: [{ ...apply!, pages: [...apply!.pages, { id: "work", components: ["email"] }] }] } };
    // Registration refuses it now (the kernel's structural check) ...
    await expect(service.register(broken)).rejects.toMatchObject({ code: "invalid_definition" });
    // ... and a definition stored before that is still judged as it always was.
    const entry = await service.register(ELIGIBILITY);
    const { compiled: _compiled, ...bare } = entry;
    await store.putCatalogEntry({ ...bare, definition: broken });
    const result = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(EMPLOYED, { id: "apply" }) });
    expect(result.record.status).toBe("rejected");
    expect(result.errors.map((error) => error.code)).toEqual(["journey.unknown"]);
  });

  it("judges by the form's only journey when the envelope names none", async () => {
    const { service } = await make();
    const values = { resident: "yes", employed: true, employer: "ACME", email: "a@b.co" };
    // `{ id: null }` reads as none too, as on every host.
    for (const [index, journey] of [undefined, {}, null, { id: null }].entries()) {
      // business_name is required, but on a page the employed path skips: the journey's path decides.
      const result = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf({ ...values, employer: `ACME ${index}` }, journey) });
      expect(result.errors, JSON.stringify(journey)).toEqual([]);
      expect(result.record.status).toBe("accepted");
    }
    // The exit page holds for a body that leaves the journey out, as for one that names it.
    const exit = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf({ resident: "no" }) });
    expect(exit.errors.map((error) => error.code)).toEqual(["journey.exit"]);
  });

  it("judges by the declared default journey when there are several, and refuses with journey.required when none is declared", async () => {
    const [apply] = ELIGIBILITY.journey!.journeys!;
    const second = { id: "short", pages: [{ id: "all", components: ["resident", "business_name", "employer", "email"] }] };
    const several = (journey: Record<string, unknown>): FormDefinition => ({ ...ELIGIBILITY, journey: { journeys: [apply!, second], ...journey } }) as FormDefinition;
    const values = { resident: "yes", business_name: "Shop", employer: "ACME", email: "a@b.co" };

    const noDefault = await make(createKernelValidator(), several({}));
    const refused = await noDefault.service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(values) });
    expect(refused.record.status).toBe("rejected");
    expect(refused.errors).toEqual([{ code: "journey.required", severity: "error", source: "server" }]);
    expect((await noDefault.service.validate({ document: envelopeOf(values) })).errors.map((error) => error.code)).toEqual(["journey.required"]);
    // Naming one is still all it takes.
    expect((await noDefault.service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(values, { id: "short" }) })).record.status).toBe("accepted");

    // Declared: `short` judges the answers, its one page holding every question.
    const declared = await make(createKernelValidator(), several({ defaultJourneyId: "short" }));
    const judged = await declared.service.validate({ document: envelopeOf(values) });
    expect(judged).toEqual({ accepted: true, errors: [], journey: { pages: ["all"], end: "end" } });
    // A default that names no journey is no default.
    const stale = await make(createKernelValidator(), several({ defaultJourneyId: "gone" }));
    expect((await stale.service.validate({ document: envelopeOf(values) })).errors.map((error) => error.code)).toEqual(["journey.required"]);
  });

  it("keeps judging the whole form when the definition opens as a form (journey.opensAs form)", async () => {
    const { service } = await make(createKernelValidator(), wholeOf(ELIGIBILITY));
    for (const journey of [undefined, {}, null]) {
      const result = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf({ resident: "yes", employed: true, employer: "ACME", email: "a@b.co" }, journey) });
      expect(result.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["business_name:required"]);
    }
  });

  it("refuses a path that ends at an exit page", async () => {
    const { service } = await make();
    const result = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf({ resident: "no" }, { id: "apply" }) });
    expect(result.record.status).toBe("rejected");
    expect(result.errors).toEqual([{ code: "journey.exit", severity: "error", source: "server", parameters: { journey: "apply", page: "ineligible" } }]);
  });

  it("takes bare values with a journey id, and keeps the id in the envelope it records", async () => {
    const { service } = await make();
    const result = await service.receive({ submissionKey: crypto.randomUUID(), formId: "eligibility", formVersion: "1.0.0", values: { resident: "yes", business_name: "Shop", email: "a@b.co" }, journeyId: "apply" });
    expect(result.record.status).toBe("accepted");
    expect(result.record.document).toMatchObject({ submission: { journey: { id: "apply" } } });
  });
});

describe("SubmissionService: a PDF layout chosen by a journey's answers", () => {
  it("never lets an answer on a branch the person left choose the layout", async () => {
    // not(empty(id)), not the bare path: a condition holds only for true (strict truthiness), so a text answer is no yes.
    const answered = (id: string): Expression => ({ kind: "unary", operator: "not", operand: { kind: "call", name: "empty", args: [{ kind: "path", path: id }] } });
    const doc = (id: string) => ({ id: `${id}-doc`, type: "pdf-document", configuration: {}, children: { body: [] } });
    // Tried in order: the self-employed copy when a business is named, the employee copy when an employer is.
    const definition: FormDefinition = {
      ...ELIGIBILITY,
      pdf: {
        layouts: [
          { id: "standard", kind: "generated", root: doc("standard") },
          { id: "self-employed", kind: "generated", when: answered("business_name"), root: doc("self-employed") },
          { id: "employee", kind: "generated", when: answered("employer"), root: doc("employee") }
        ],
        defaultLayoutId: "standard"
      }
    };
    const fonts = await loadFontPack({ entries: DEFAULT_FONT_PACK.filter((entry) => entry.id.startsWith("dejavu-sans")) });
    const service = createSubmissionService({
      store: new InMemorySubmissionStore(),
      validator: createKernelValidator(),
      pdf: createProviderPdfRenderer({ provider: createInProcessPdfProvider(), fonts, build: handlePdfRequest }),
      ids: (() => {
        let n = 0;
        return () => `rec-${++n}`;
      })()
    });
    await service.register(definition, { pdf: { enabled: true, sign: false, attachSubmission: false } });

    // The employed path skips the page that asks for a business: the answer left over from it
    // is delivered, withheld from the judged values, and so chooses nothing.
    const onJourney = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(EMPLOYED, { id: "apply" }) });
    expect(onJourney.record.status).toBe("accepted");
    expect(recordValuesOf(onJourney.record)).not.toHaveProperty("business_name");
    expect(onJourney.record.pdf).toMatchObject({ layoutId: "employee", layoutChoice: "condition" });

    // The same answers judged as the whole form keep the business, and its layout comes first.
    await service.register(wholeOf(definition), { pdf: { enabled: true, sign: false, attachSubmission: false } });
    const wholeForm = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(EMPLOYED) });
    expect(wholeForm.record.status).toBe("accepted");
    expect(wholeForm.record.pdf).toMatchObject({ layoutId: "self-employed", layoutChoice: "condition" });
  });
});

describe("SubmissionService: validate", () => {
  it("gives receive's verdict without storing a record", async () => {
    const { service, store } = await make();
    const clean = await service.validate({ document: envelopeOf({ resident: "yes", business_name: "Shop", email: "a@b.co" }, { id: "apply" }) });
    // With the path the server worked out, for the browser's diagnostics.
    expect(clean).toEqual({ accepted: true, errors: [], journey: { pages: ["residency", "work", "self", "contact"], end: "end" } });

    const blocked = await service.validate({ formId: "eligibility", formVersion: "1.0.0", values: { resident: "yes" }, journeyId: "apply" });
    expect(blocked.accepted).toBe(false);
    expect(blocked.errors).toEqual([
      { code: "required", componentId: "business_name", path: "business_name", severity: "error", source: "server" },
      { code: "required", componentId: "email", path: "email", severity: "error", source: "server" }
    ]);
    // The same errors receive gives for the same answers.
    const received = await service.receive({ submissionKey: crypto.randomUUID(), formId: "eligibility", formVersion: "1.0.0", values: { resident: "yes" }, journeyId: "apply" });
    expect(received.errors).toEqual(blocked.errors);
    expect((await store.listRecords()).total).toBe(1);

    expect((await service.validate({ document: envelopeOf(EMPLOYED, { id: "renew" }) })).errors.map((error) => error.code)).toEqual(["journey.unknown"]);
    await expect(service.validate({ formId: "other", formVersion: "1", values: {} })).rejects.toMatchObject({ code: "unknown_form" });
  });

  it("gives the same verdict through the sandbox program in QuickJS", async () => {
    const host = await sandboxProgramHost();
    try {
      const { service } = await make(createProgramHostValidator(host));
      const { service: inProcess } = await make();
      const cases: Array<[Record<string, unknown>, unknown]> = [
        [{ resident: "yes", employed: true, employer: "ACME", email: "a@b.co" }, { id: "apply" }],
        [{ resident: "yes" }, { id: "apply" }],
        [{ resident: "no" }, { id: "apply" }],
        [EMPLOYED, undefined]
      ];
      for (const [values, journey] of cases) {
        const document = envelopeOf(values, journey);
        expect(await service.validate({ document }), JSON.stringify(values)).toEqual(await inProcess.validate({ document }));
      }
      expect((await service.validate({ document: envelopeOf({ resident: "no" }, { id: "apply" }) })).errors.map((error) => error.code)).toEqual(["journey.exit"]);
    } finally {
      host.dispose();
    }
  });
});

/**
 * Required when: the same fixture the engine's and the QuickJS host's parity suites
 * use, received and validated here — in-process and through the sandbox program.
 */
const path = (name: string): Expression => ({ kind: "path", path: name });
const ratioKnown: Expression = { kind: "binary", operator: "neq", left: path("ratio"), right: { kind: "literal", value: null } };
const reachField = (id: string, configuration: Record<string, unknown> = {}, extra: Partial<ComponentNode> = {}): ComponentNode => ({ id, type: "text", configuration, ...extra });
const REACH: FormDefinition = {
  id: "reach",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: { title: "Reach" },
    children: {
      content: [
        reachField("contact", {}, { type: "radio" }),
        reachField("phone", {}, { rules: { requiredWhen: eq("contact", "phone") } }),
        reachField("gate", {}, { type: "checkbox" }),
        reachField("secret", { hiddenValueBehavior: "exclude-from-submission" }, { rules: { visibleWhen: eq("gate", true) } }),
        reachField("echo", {}, { rules: { requiredWhen: eq("secret", "open") } }),
        reachField("branch", {}, { type: "select" }),
        reachField("detail"),
        reachField("extra", {}, { rules: { requiredWhen: eq("detail", "yes") } }),
        { id: "billing", type: "container", configuration: {}, children: { content: [reachField("postcode", { dataKey: "code" }, { rules: { requiredWhen: eq("contact", "post") } })] } },
        reachField("staff_note", {}, { rules: { requiredWhen: eq("host.role", "staff") } }),
        reachField("both", { required: true }, { rules: { requiredWhen: eq("contact", "never") } }),
        reachField("income", {}, { type: "number" }),
        reachField("members", {}, { type: "number" }),
        reachField("ratio", {}, { type: "number", rules: { value: { kind: "arithmetic", operator: "divide", left: path("income"), right: path("members") } } }),
        reachField("per_head", {}, { rules: { requiredWhen: ratioKnown } })
      ]
    }
  },
  journey: {
    journeys: [
      {
        id: "reach",
        pages: [
          { id: "how", components: ["contact", "phone", "gate", "secret", "echo", "branch"], routes: [{ when: { kind: "unary", operator: "not", operand: eq("branch", "x") }, to: "finish" }] },
          { id: "detailed", components: ["detail"] },
          { id: "finish", components: ["extra", "billing", "staff_note", "both", "income", "members", "ratio", "per_head"], routes: [{ to: "$end" }] }
        ]
      }
    ]
  }
};
/**
 * As the browser's envelope carries them: the ticked field filled, no rule holding, and the
 * calculation as JSON carries its NaN (`null`) — a server given no `ratio` key at all cannot
 * reproduce it and `neq(ratio, null)` then reads an unanswered ratio as true.
 */
const REACHABLE = { contact: "email", both: "yes", ratio: null };
/** Answers and the errors every side gives for them, along the journey. */
const REACH_CASES: Array<[Record<string, unknown>, string[]]> = [
  [{ ...REACHABLE, contact: "phone" }, ["phone:required"]],
  [{ ...REACHABLE, contact: "phone", phone: "555 0100" }, []],
  [REACHABLE, []],
  [{ contact: "email", ratio: null }, ["both:required"]],
  [{ ...REACHABLE, gate: false, secret: "open" }, []],
  [{ ...REACHABLE, gate: true, secret: "open" }, ["echo:required"]],
  [{ ...REACHABLE, branch: "y", detail: "yes" }, []],
  [{ ...REACHABLE, branch: "x", detail: "yes" }, ["extra:required"]],
  [{ ...REACHABLE, contact: "post" }, ["postcode:required"]],
  [{ ...REACHABLE, contact: "post", "billing.code": "K1A 0B1" }, []],
  [{ ...REACHABLE, income: 1200 }, []],
  [{ ...REACHABLE, income: 1200, members: 3 }, ["per_head:required"]]
];

function reachEnvelope(values: Record<string, unknown>, journey?: { id: string }): CanonicalSubmission {
  return {
    versionContext: {
      form: { id: REACH.id, version: REACH.version },
      client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" }
    },
    submission: { locale: "en", values, ...(journey !== undefined ? { journey } : {}) }
  };
}

async function makeReach(validator: SubmissionValidator = createKernelValidator()) {
  const store = new InMemorySubmissionStore();
  let n = 0;
  const service = createSubmissionService({ store, validator, ids: () => `rec-${++n}` });
  await service.register(REACH);
  return { store, service };
}

const codesOf = (errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>): string[] =>
  errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();

describe("SubmissionService: Required when", () => {
  it("holds a field to its rule on receive and validate alike: refused while empty and the rule holds, accepted otherwise", async () => {
    const { service, store } = await makeReach();
    for (const [values, expected] of REACH_CASES) {
      const label = JSON.stringify(values);
      const document = reachEnvelope(values, { id: "reach" });
      const verdict = await service.validate({ document });
      expect(codesOf(verdict.errors), label).toEqual(expected);
      expect(verdict.accepted, label).toBe(expected.length === 0);
      const received = await service.receive({ submissionKey: crypto.randomUUID(), document });
      expect(received.record.status, label).toBe(expected.length === 0 ? "accepted" : "rejected");
      expect(codesOf(received.errors), label).toEqual(expected);
    }
    expect((await store.listRecords()).total).toBe(REACH_CASES.length);
  });

  it("accepts a host-bound rule's empty answer, keeps an excluded answer out of the record, and holds the whole form to a stale answer a journey would skip", async () => {
    const { service } = await makeReach();
    // The server has no host context: `staff_note`'s rule is false here, so nothing is asked (the browser asks).
    const hosted = await service.receive({ submissionKey: crypto.randomUUID(), document: reachEnvelope(REACHABLE, { id: "reach" }) });
    expect(hosted.record.status).toBe("accepted");
    // `ratio` came to nothing: its optional inputs are on the path and omitted, so the server works it out
    // over the empty answers and stores no key, as for a form without a journey.
    expect(recordValuesOf(hosted.record)).toStrictEqual({ contact: "email", both: "yes" });
    // `secret` is hidden and excluded: not in the record, and read by no rule.
    const excluded = await service.receive({ submissionKey: crypto.randomUUID(), document: reachEnvelope({ ...REACHABLE, gate: false, secret: "open" }, { id: "reach" }) });
    expect(recordValuesOf(excluded.record)).not.toHaveProperty("secret");
    // Judged as the whole form, no page is skipped: the detail is on the path and `extra` is required.
    await service.register(wholeOf(REACH));
    const whole = await service.validate({ document: reachEnvelope({ ...REACHABLE, branch: "y", detail: "yes" }) });
    expect(codesOf(whole.errors)).toEqual(["extra:required"]);
  });

  it("gives the same verdicts through the sandbox program in QuickJS", async () => {
    const host = await sandboxProgramHost();
    try {
      const { service } = await makeReach(createProgramHostValidator(host));
      const { service: inProcess } = await makeReach();
      for (const [values, expected] of REACH_CASES) {
        const document = reachEnvelope(values, { id: "reach" });
        const verdict = await service.validate({ document });
        expect(verdict, JSON.stringify(values)).toEqual(await inProcess.validate({ document }));
        expect(codesOf(verdict.errors), JSON.stringify(values)).toEqual(expected);
        const received = await service.receive({ submissionKey: crypto.randomUUID(), document });
        expect(received.record.status, JSON.stringify(values)).toBe(expected.length === 0 ? "accepted" : "rejected");
      }
    } finally {
      host.dispose();
    }
  });
});

/**
 * Form rules always hold: the engine's and the QuickJS host's parity fixture, a
 * two-page journey that leaves most of the form off every page, received and validated here.
 * `ref` is required; `secret` hides itself and is excluded; `staff_ref` and, through its
 * fieldset, `nested_ref` are shown by the host; `opt_in` is hidden on the form and opts in to
 * being required and validated; `total` is worked out from `cost`; `code` has a pattern.
 * `extra` sits on a page the path may skip.
 */
const staff = eq("host.role", "staff");
const LEFT_OUT: FormDefinition = {
  id: "short",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: { title: "Short" },
    children: {
      content: [
        reachField("resident", { required: true }, { type: "select" }),
        reachField("extra", { required: true }),
        reachField("ref", { required: true }),
        reachField("secret", { required: true, hiddenValueBehavior: "exclude-from-submission" }, { rules: { visibleWhen: eq("resident", "never") } }),
        reachField("staff_ref", { required: true }, { rules: { visibleWhen: staff } }),
        { id: "staff_box", type: "fieldset", configuration: {}, rules: { visibleWhen: staff }, children: { content: [reachField("nested_ref", { required: true })] } },
        reachField("opt_in", { hidden: true, required: true, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" }),
        reachField("cost", {}, { type: "number" }),
        reachField("total", {}, { type: "number", rules: { value: { kind: "arithmetic", operator: "multiply", left: path("cost"), right: { kind: "literal", value: 2 } } } }),
        reachField("code", { pattern: "[A-Z]{3}" })
      ]
    }
  },
  journey: {
    journeys: [
      {
        id: "short",
        pages: [
          { id: "start", components: ["resident"], routes: [{ when: { kind: "unary", operator: "not", operand: eq("resident", "yes") }, to: "$end" }] },
          { id: "more", components: ["extra"] }
        ]
      }
    ]
  }
};
const LEFT_OUT_FILLED = { resident: "no", ref: "R-1", opt_in: "O-1", staff_ref: "S-1", nested_ref: "N-1" };
/** Answers and the errors every side gives for them, along the journey. */
const LEFT_OUT_CASES: Array<[Record<string, unknown>, string[]]> = [
  [{ resident: "no" }, ["opt_in:required", "ref:required"]],
  [LEFT_OUT_FILLED, []],
  [{ ...LEFT_OUT_FILLED, secret: "x" }, []],
  // The host-bound ones keep the lenient fold on no page: the server cannot replay the host, so neither side asks.
  [{ resident: "no", ref: "R-1", opt_in: "O-1" }, []],
  [{ ...LEFT_OUT_FILLED, cost: 5 }, []],
  [{ ...LEFT_OUT_FILLED, code: "abc" }, ["code:pattern"]],
  [{ ...LEFT_OUT_FILLED, code: "ABC" }, []],
  [{ ...LEFT_OUT_FILLED, extra: "stale" }, []],
  [{ ...LEFT_OUT_FILLED, resident: "yes" }, ["extra:required"]]
];

function leftOutEnvelope(values: Record<string, unknown>, journey?: { id: string }): CanonicalSubmission {
  return {
    versionContext: {
      form: { id: LEFT_OUT.id, version: LEFT_OUT.version },
      client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" }
    },
    submission: { locale: "en", values, ...(journey !== undefined ? { journey } : {}) }
  };
}

async function makeLeftOut(validator: SubmissionValidator = createKernelValidator()) {
  const store = new InMemorySubmissionStore();
  let n = 0;
  const service = createSubmissionService({ store, validator, ids: () => `rec-${++n}` });
  await service.register(LEFT_OUT);
  return { store, service };
}

describe("SubmissionService: form rules always hold", () => {
  it("judges a field the journey leaves off every page as the whole form judges it, on receive and validate alike", async () => {
    const { service, store } = await makeLeftOut();
    for (const [values, expected] of LEFT_OUT_CASES) {
      const label = JSON.stringify(values);
      const document = leftOutEnvelope(values, { id: "short" });
      const verdict = await service.validate({ document });
      expect(codesOf(verdict.errors), label).toEqual(expected);
      expect(verdict.accepted, label).toBe(expected.length === 0);
      const received = await service.receive({ submissionKey: crypto.randomUUID(), document });
      expect(received.record.status, label).toBe(expected.length === 0 ? "accepted" : "rejected");
      expect(codesOf(received.errors), label).toEqual(expected);
    }
    expect((await store.listRecords()).total).toBe(LEFT_OUT_CASES.length);
  });

  it("keeps what the form keeps: the self-hidden answer out, the skipped page's withheld, the host-bound ones and the calculation in", async () => {
    const { service } = await makeLeftOut();
    const everything = await service.receive({ submissionKey: crypto.randomUUID(),
      document: leftOutEnvelope({ ...LEFT_OUT_FILLED, secret: "x", cost: 5, code: "ABC", extra: "stale" }, { id: "short" })
    });
    expect(everything.record.status).toBe("accepted");
    expect(recordValuesOf(everything.record)).toStrictEqual({ ...LEFT_OUT_FILLED, cost: 5, total: 10, code: "ABC" });
    // The whole form also asks for the skipped field. It does not ask for the host-bound ones
    // (a visibility the server cannot replay is hidden for requiredness,
    // and the verdict lists the skips); through the journey they are on no page and keep the
    // lenient fold, so the two agree.
    await service.register(wholeOf(LEFT_OUT));
    const whole = await service.validate({ document: leftOutEnvelope({ resident: "no", ref: "R-1", opt_in: "O-1" }) });
    expect(codesOf(whole.errors)).toEqual(["extra:required"]);
    const through = await service.validate({ document: leftOutEnvelope({ resident: "no", ref: "R-1", opt_in: "O-1" }, { id: "short" }) });
    expect(through.accepted).toBe(true);
  });

  it("gives the same verdicts through the sandbox program in QuickJS", async () => {
    const host = await sandboxProgramHost();
    try {
      const { service } = await makeLeftOut(createProgramHostValidator(host));
      const { service: inProcess } = await makeLeftOut();
      for (const [values, expected] of LEFT_OUT_CASES) {
        const document = leftOutEnvelope(values, { id: "short" });
        const verdict = await service.validate({ document });
        expect(verdict, JSON.stringify(values)).toEqual(await inProcess.validate({ document }));
        expect(codesOf(verdict.errors), JSON.stringify(values)).toEqual(expected);
        const received = await service.receive({ submissionKey: crypto.randomUUID(), document });
        expect(received.record.status, JSON.stringify(values)).toBe(expected.length === 0 ? "accepted" : "rejected");
      }
      const whole = await service.validate({ document: leftOutEnvelope(LEFT_OUT_FILLED) });
      expect(whole).toEqual(await inProcess.validate({ document: leftOutEnvelope(LEFT_OUT_FILLED) }));
    } finally {
      host.dispose();
    }
  });
});

/**
 * Presentations: the engine's shared fixture — a journey that asks the form through
 * an alias and a worked-out value, and a one-page variant over references in an own layout —
 * received and validated here. The envelope carries form values only, as an honest browser
 * sends them: the server works placement out again from the definition, and the path from the
 * values.
 */
const PRESENTATION = presentationForm();
// The ceiling is the field's own declared `max` (`number.max`); no plugin validator carries it.
const ceiling: KernelValidator = () => ({ errors: [] });

function presentationEnvelope(values: Record<string, unknown>, journeyId?: string): CanonicalSubmission {
  return {
    versionContext: {
      form: { id: PRESENTATION.id, version: PRESENTATION.version },
      client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" }
    },
    submission: { locale: "en", values, ...(journeyId !== undefined ? { journey: { id: journeyId } } : {}) }
  };
}

/** A server over the fixture, its one hook recording the scope it was handed. */
async function makePresentation(validator: SubmissionValidator = createKernelValidator([ceiling])) {
  const calls: ServerValidationContext[] = [];
  const store = new InMemorySubmissionStore();
  let n = 0;
  const service = createSubmissionService({
    store,
    validator,
    ids: () => `rec-${++n}`,
    serverValidationRunner: new ServerValidationRunner([
      {
        id: "recording",
        version: "1.0.0",
        async validate(context) {
          calls.push(context);
          return { errors: [] };
        }
      }
    ])
  });
  await service.register(PRESENTATION);
  return { store, service, calls };
}

/** Answers and what every side says of them, through the journey `apply`. */
const PRESENTATION_CASES: Array<[Record<string, unknown>, string[], string[] | undefined]> = [
  [{}, ["annual_income:required", "email:required"], undefined],
  [{ annual_income: 36000 }, ["email:required"], ["annual_income"]],
  [{ email: "ada@example.org" }, ["annual_income:required"], undefined],
  [APPLY_BELOW, [], ["annual_income"]],
  [APPLY_ABOVE, [], ["annual_income"]],
  [{ ...APPLY_BELOW, approved_amount: 500 }, [], ["annual_income"]],
  [{ email: "ada@example.org", annual_income: 1000001 }, ["annual_income:number.max"], ["annual_income"]],
  // What a forged client might add: an own answer's key, and keys spelled like own ids. Stripped.
  [{ ...APPLY_BELOW, "@apply.m1": 12000, m1: 12000, work_email: "x" }, [], ["annual_income"]]
];

describe("SubmissionService: presentations", () => {
  it("places the form's fields through the journey's own nodes: the alias's field and the worked-out one are asked, and the path turns on the worked-out one", async () => {
    const { service, store } = await makePresentation();
    for (const [values, expected] of PRESENTATION_CASES) {
      const label = JSON.stringify(values);
      const document = presentationEnvelope(values, "apply");
      const verdict = await service.validate({ document });
      expect(codesOf(verdict.errors), label).toEqual(expected);
      expect(verdict.accepted, label).toBe(expected.length === 0);
      const received = await service.receive({ submissionKey: crypto.randomUUID(), document });
      expect(received.record.status, label).toBe(expected.length === 0 ? "accepted" : "rejected");
      expect(codesOf(received.errors), label).toEqual(expected);
    }
    expect((await store.listRecords()).total).toBe(PRESENTATION_CASES.length);

    // The path the server works out: below the threshold the journey ends after `income`, from it up `assist` is asked.
    expect((await service.validate({ document: presentationEnvelope(APPLY_BELOW, "apply") })).journey).toEqual({ pages: ["details", "income"], end: "end" });
    expect((await service.validate({ document: presentationEnvelope(APPLY_ABOVE, "apply") })).journey).toEqual({ pages: ["details", "income", "assist"], end: "end" });
    // The record keeps the judged values: an answer left on the page the path skips is withheld, an own answer's key stripped.
    const stale = await service.receive({ submissionKey: crypto.randomUUID(), document: presentationEnvelope({ ...APPLY_BELOW, approved_amount: 500, "@apply.m1": 12000 }, "apply") });
    expect(recordValuesOf(stale.record)).toStrictEqual(APPLY_BELOW);
    expect(stale.record.document).toEqual(presentationEnvelope({ ...APPLY_BELOW, approved_amount: 500, "@apply.m1": 12000 }, "apply"));
  });

  it("judges what the variant leaves out as the whole form does, and places what its own layout references", async () => {
    const { service } = await makePresentation();
    const through = await service.validate({ document: presentationEnvelope({ email: "ada@example.org", name: "Ada" }, "public") });
    // Form rules always hold: `public` does not ask for the income the form requires.
    expect(codesOf(through.errors)).toEqual(["annual_income:required"]);
    expect(through.journey).toEqual({ pages: ["all"], end: "end" });
    const prefilled = await service.receive({ submissionKey: crypto.randomUUID(), document: presentationEnvelope({ email: "ada@example.org", annual_income: 5 }, "public") });
    expect(prefilled.record.status).toBe("accepted");
    // Nothing is worked out through the variant: the answer is the person's (or the host's).
    expect(prefilled.record.clientDerived).toBeUndefined();
    expect(codesOf((await service.validate({ document: presentationEnvelope({ annual_income: 5 }, "public") })).errors)).toEqual(["email:required"]);
  });

  it("records which answers were worked out in the browser: clientDerived on the record, and one line in its log", async () => {
    const { service } = await makePresentation();
    const accepted = await service.receive({ submissionKey: crypto.randomUUID(), document: presentationEnvelope(APPLY_ABOVE, "apply") });
    expect(accepted.record.status).toBe("accepted");
    expect(accepted.record.clientDerived).toEqual(["annual_income"]);
    expect(accepted.record.logs?.filter((entry) => entry.message.startsWith("values.client-derived"))).toEqual([
      {
        level: "info",
        message: "values.client-derived: answers worked out in the browser are kept as sent, held to the form's rules but not recomputed here",
        data: { fields: ["annual_income"] }
      }
    ]);
    // Each is among the values the record keeps.
    for (const path of accepted.record.clientDerived ?? []) {
      expect(recordValuesOf(accepted.record)).toHaveProperty([path]);
    }
    // A refused record says so too: the figure was judged, against the form's own ceiling.
    const refused = await service.receive({ submissionKey: crypto.randomUUID(), document: presentationEnvelope({ email: "ada@example.org", annual_income: 1000001 }, "apply") });
    expect(refused.record.status).toBe("rejected");
    expect(codesOf(refused.errors)).toEqual(["annual_income:number.max"]);
    expect(refused.record.clientDerived).toEqual(["annual_income"]);
    // Judged as the whole form, the same answers are the person's own: no list, no line.
    await service.register(wholeOf(PRESENTATION));
    const whole = await service.receive({ submissionKey: crypto.randomUUID(), document: presentationEnvelope(APPLY_ABOVE) });
    expect(whole.record.status).toBe("accepted");
    expect("clientDerived" in whole.record).toBe(false);
    expect(whole.record.logs?.some((entry) => entry.message.startsWith("values.client-derived")) ?? false).toBe(false);
    // Nothing else about a record changed: the same keys, with the list beside the values when there is one.
    expect(Object.keys(accepted.record).filter((key) => key !== "clientDerived")).toEqual(Object.keys(whole.record));
  });

  it("keeps a page's check to what the page places — the alias's field on its page, the worked-out field on its own — by the scope it always worked out", async () => {
    const { service, calls } = await makePresentation();
    const page = (pageId: string, values: Record<string, unknown>, journeyId = "apply") =>
      service.validate({ formId: PRESENTATION.id, formVersion: PRESENTATION.version, values, journeyId, scope: "page", pageId });
    // Nothing answered: each page reports only the form field it places.
    expect(codesOf((await page("details", {})).errors)).toEqual(["email:required"]);
    expect(codesOf((await page("income", {})).errors)).toEqual(["annual_income:required"]);
    expect((await page("assist", {})).errors).toEqual([]);
    expect(codesOf((await page("all", {}, "public")).errors)).toEqual(["email:required"]);
    // The worked-out field over the form's ceiling is the `income` page's to show, not the alias's page's.
    expect((await page("details", { email: "ada@example.org", annual_income: 1000001 })).errors).toEqual([]);
    expect(codesOf((await page("income", { email: "ada@example.org", annual_income: 1000001 })).errors)).toEqual(["annual_income:number.max"]);

    // The hooks are handed the same scope: the form components the page places, never an own node's id.
    calls.length = 0;
    await page("details", APPLY_ABOVE);
    await page("income", APPLY_ABOVE);
    await page("assist", APPLY_ABOVE);
    await page("all", { email: "ada@example.org", annual_income: 5 }, "public");
    expect(calls.map((call) => call.scope)).toEqual([
      { kind: "page", journeyId: "apply", pageId: "details", componentIds: ["email"] },
      { kind: "page", journeyId: "apply", pageId: "income", componentIds: ["annual_income"] },
      { kind: "page", journeyId: "apply", pageId: "assist", componentIds: ["approved_amount"] },
      { kind: "page", journeyId: "public", pageId: "all", componentIds: ["email", "name"] }
    ]);
    // …which is what the kernel answers a host that names the page (`context.page`), from the same ownership.
    for (const call of calls) {
      const journey = findJourney(PRESENTATION, call.scope?.journeyId);
      const outcome = runKernel({ formId: PRESENTATION.id, values: APPLY_ABOVE, locale: "en", form: PRESENTATION.root, journey: journey!, page: call.scope!.pageId! }, [], undefined, formulaFunctionSignatures());
      expect(outcome.pageComponentIds, call.scope?.pageId).toEqual(call.scope?.componentIds);
      expect(kernelPageComponentIds(journeyOwnership(PRESENTATION.root, journey!), call.scope!.pageId!), call.scope?.pageId).toEqual(call.scope?.componentIds);
    }
  });

  it("ignores an own entry of a journey whose id is outside the grammar (rule H), or whose answer would live at a key the form defines (rule I), as if it were not there — in-process and in QuickJS", async () => {
    const apply = PRESENTATION.journey!.journeys![0] as Journey;
    const idsOnly = (journey: Journey, id: string): Journey => ({ ...journey, id, pages: journey.pages.map((page) => ({ ...page, components: (page.components ?? []).filter((entry) => typeof entry === "string") })) });
    // H: `apply now` owns nothing — its alias and worked-out value place nothing, so `email` and
    // `annual_income` are judged as the whole form judges them.
    const spacedForm: FormDefinition = { ...presentationForm(), journey: { journeys: [{ ...apply, id: "apply now" }, idsOnly(apply, "apply_ids")] } };
    // I: the form keeps a section's entries at `@apply.m1`, where the own field `m1` would live.
    const keyedRoot = presentationForm().root;
    keyedRoot.children!.content!.push({ id: "sec", type: "repeatingSection", configuration: {}, collection: { collectionPath: "@apply.m1" }, children: { content: [{ id: "row_f", type: "text", configuration: {} }] } });
    const withoutM1: Journey = { ...apply, id: "apply_without", pages: apply.pages.map((page) => (page.id === "income" ? { ...page, components: (page.components ?? []).filter((entry) => typeof entry === "string" || entry.id !== "m1") } : page)) };
    const keyedForm: FormDefinition = { ...presentationForm(), root: keyedRoot, journey: { journeys: [apply, withoutM1] } };

    const host = await sandboxProgramHost();
    try {
      let n = 0;
      for (const [rule, definition, broken, without] of [
        ["H", spacedForm, "apply now", "apply_ids"],
        ["I", keyedForm, "apply", "apply_without"]
      ] as const) {
        for (const validator of [createKernelValidator([ceiling]), createProgramHostValidator(host)]) {
          const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator, ids: () => `rec-${++n}` });
          await service.register(definition);
          for (const [values] of PRESENTATION_CASES) {
            const label = `${rule}: ${JSON.stringify(values)}`;
            const judged = await service.validate({ document: presentationEnvelope(values, broken) });
            const expected = await service.validate({ document: presentationEnvelope(values, without) });
            expect({ accepted: judged.accepted, errors: codesOf(judged.errors), journey: judged.journey }, label).toEqual({ accepted: expected.accepted, errors: codesOf(expected.errors), journey: expected.journey });
            const received = await service.receive({ submissionKey: crypto.randomUUID(), document: presentationEnvelope(values, broken) });
            expect(recordValuesOf(received.record), label).toStrictEqual(recordValuesOf((await service.receive({ submissionKey: crypto.randomUUID(), document: presentationEnvelope(values, without) })).record));
            for (const pageId of ["details", "income", "assist"]) {
              const scoped = await service.validate({ formId: definition.id, formVersion: definition.version, values, journeyId: broken, scope: "page", pageId });
              const plain = await service.validate({ formId: definition.id, formVersion: definition.version, values, journeyId: without, scope: "page", pageId });
              expect(codesOf(scoped.errors), `${label}, ${pageId}`).toEqual(codesOf(plain.errors));
            }
          }
        }
      }
      // H in words: through `apply now` nothing is placed by an own node, so the two required fields stand on no page.
      expect(journeyOwnership(spacedForm.root, spacedForm.journey!.journeys![0] as Journey).pagesOf).toEqual({ approved_amount: ["assist"] });
    } finally {
      host.dispose();
    }
  });

  it("gives the same verdicts, records and page scopes through the sandbox program in QuickJS", async () => {
    const host = await sandboxProgramHost();
    try {
      const { service, calls } = await makePresentation(createProgramHostValidator(host));
      const { service: inProcess, calls: inProcessCalls } = await makePresentation();
      for (const [values, expected, derived] of PRESENTATION_CASES) {
        const label = JSON.stringify(values);
        for (const journeyId of ["apply", "public", undefined]) {
          const document = presentationEnvelope(values, journeyId);
          const verdict = await service.validate({ document });
          expect(verdict, `${journeyId}: ${label}`).toEqual(await inProcess.validate({ document }));
          const received = await service.receive({ submissionKey: crypto.randomUUID(), document });
          const reference = await inProcess.receive({ submissionKey: crypto.randomUUID(), document });
          expect(received.record.status, `${journeyId}: ${label}`).toBe(reference.record.status);
          expect(received.record.values, `${journeyId}: ${label}`).toEqual(reference.record.values);
          expect(received.record.clientDerived, `${journeyId}: ${label}`).toEqual(reference.record.clientDerived);
          if (journeyId === "apply") {
            expect(codesOf(verdict.errors), label).toEqual(expected);
            expect(received.record.clientDerived, label).toEqual(derived);
          }
        }
        for (const pageId of ["details", "income", "assist"]) {
          const check = { formId: PRESENTATION.id, formVersion: PRESENTATION.version, values, journeyId: "apply", scope: "page" as const, pageId };
          expect(await service.validate(check), `${pageId}: ${label}`).toEqual(await inProcess.validate(check));
        }
      }
      expect(calls.map((call) => call.scope)).toEqual(inProcessCalls.map((call) => call.scope));
    } finally {
      host.dispose();
    }
  });
});

/**
 * The browser's page check and the service's, for pages that ask the form through
 * nodes of their own: `FormRuntime.validate({ page })` over the answers as the browser holds
 * them — own answers under their `@` keys, the alias's at the form field — against
 * `service.validate({ scope: "page" })` over what the browser sends for that check, which holds
 * form values only. Every error on a form field is one both report, on the same page; the
 * browser adds only what its own fields ask.
 */
describe("SubmissionService: a page's check beside the browser's own", () => {
  function browser(service: Awaited<ReturnType<typeof makePresentation>>["service"], requests: JourneyValidationRequest[]) {
    const definition = presentationForm();
    // Every page is checked on Continue, and asks the server too: the default is to move on and
    // check at the end, and these tests are about the page check.
    (definition.journey!.journeys![0] as Journey).validation = { continue: "page", server: true };
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    return new FormRuntime(definition, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
      journeyServerValidator: async (request) => {
        requests.push(request);
        return service.validate(request);
      }
    });
  }
  const formCodes = (runtime: FormRuntime): string[] => {
    const kinds = runtime.presentationIndex()?.kindOf ?? {};
    return codesOf(runtime.errors().filter((error) => error.componentId === undefined || !Object.hasOwn(kinds, error.componentId)));
  };
  const ownCodes = (runtime: FormRuntime): string[] => {
    const kinds = runtime.presentationIndex()?.kindOf ?? {};
    return codesOf(runtime.errors().filter((error) => error.componentId !== undefined && Object.hasOwn(kinds, error.componentId)));
  };

  it("agrees page by page on the alias's field and the worked-out one, over form values alone", async () => {
    const { service } = await makePresentation();
    const requests: JourneyValidationRequest[] = [];
    const runtime = browser(service, requests);
    const page = (pageId: string) =>
      service.validate({ formId: PRESENTATION.id, formVersion: PRESENTATION.version, values: runtime.submittableValues(), journeyId: "apply", scope: "page", pageId });

    // Nothing answered: each page asks for the form field its own node places.
    await runtime.validate({ page: "details" });
    expect(formCodes(runtime)).toEqual(["email:required"]);
    expect(ownCodes(runtime)).toEqual(["work_email:required"]);
    expect(codesOf((await page("details")).errors)).toEqual(formCodes(runtime));
    await runtime.validate({ page: "income" });
    expect(formCodes(runtime)).toEqual(["annual_income:required", "email:required"]);
    expect(codesOf((await page("income")).errors)).toEqual(["annual_income:required"]);

    // Answered through the alias and the month fields: both sides pass both pages, and Continue
    // asks the server about form values only.
    runtime.setValue(runtime.presentationValuePathOf("work_email") as string, "ada@example.org");
    for (const month of ["m1", "m2", "m3"]) {
      runtime.setValue(`@apply.${month}`, 20000);
    }
    for (const pageId of ["details", "income"]) {
      // A page's run replaces that page's errors and keeps the other's until its own run.
      await runtime.validate({ page: pageId });
      expect((await page(pageId)).errors, pageId).toEqual([]);
    }
    expect(runtime.errors()).toEqual([]);
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    expect(requests).toEqual([
      { formId: "presentation", formVersion: "1.0.0", journeyId: "apply", scope: "page", pageId: "details", values: { email: "ada@example.org", annual_income: 60000 }, locale: "en" }
    ]);
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "assist" });
    expect(requests[1]).toMatchObject({ pageId: "income", values: { email: "ada@example.org", annual_income: 60000 } });
  });

  it("shows the ceiling's word on a worked-out field on the page that works it out, on the read-only copy", async () => {
    const { service } = await makePresentation();
    const requests: JourneyValidationRequest[] = [];
    const runtime = browser(service, requests);
    runtime.setValue("email", "ada@example.org");
    runtime.setValue("@apply.m1", 1000001);
    // The ceiling is the field's own declared `max`, which the browser's stage holds too
    // (no plugin rule, known to the server alone, holds it). The whole-form run
    // names the form field; `details` does not hold it, so that page passes and the server is asked.
    expect(await runtime.validate()).toEqual([expect.objectContaining({ code: "number.max", componentId: "annual_income", source: "client" })]);
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    // On `income` the browser refuses it before the server is asked: the error names the form
    // field, and the page shows it on the worked-out value's copy.
    expect(await runtime.nextPage()).toMatchObject({ ok: false, pageId: "income" });
    expect(runtime.errors()).toEqual([expect.objectContaining({ code: "number.max", componentId: "annual_income", source: "client" })]);
    expect({ ...runtime.journeyView()?.hosts }).toEqual({ annual_income: "income_total" });
    expect(requests.map((request) => [request.pageId, Object.keys(request.values)])).toEqual([["details", ["email", "annual_income"]]]);
    // A month changed: the field is worked out again, the word on the old figure goes,
    // and the page may be left.
    runtime.setValue("@apply.m1", 70000);
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "assist" });
    expect(runtime.errors()).toEqual([]);
  });
});
