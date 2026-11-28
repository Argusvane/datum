import { describe, expect, it } from "vitest";
import { submissionEnvelopeOf, type CanonicalSubmission, type ComponentNode, type FormDefinition } from "@argusvane/datum-engine";

import {
  InMemorySubmissionStore,
  createKernelValidator,
  createSubmissionService,
  recordValuesOf,
  type SubmissionPdfRenderInput,
  type SubmissionPdfRenderer,
  type SubmissionRecord
} from "../src/index.js";

/**
 * What a record stands for: the delivered document is kept byte for byte, for its
 * digest and signatures, but the PDF, the exports and the statistics read the values the
 * verdict judged. A forged client can send an answer the fold withholds — off the path, or
 * hidden and excluded — which nothing validated; it must not be printed, exported or counted.
 */

const eq = (path: string, value: string | boolean): string => `${path} = ${JSON.stringify(value)}`;

const BUSINESS_NAME: ComponentNode = { id: "business_name", type: "text", configuration: { required: true, maxLength: 5, pattern: "[a-z]+" } };

function formWith(children: ComponentNode[], journey = true): FormDefinition {
  return {
    id: "apply-form",
    version: "1",
    schemaVersion: "1",
    root: { id: "form", type: "form", configuration: { title: "Apply" }, children: { content: children } },
    ...(journey
      ? {
          journey: {
            journeys: [
              {
                id: "apply",
                pages: [
                  { id: "work", components: ["employed"], routes: [{ when: eq("employed", true), to: "employment" }] },
                  { id: "self", components: ["business_name"], routes: [{ to: "$end" }] },
                  { id: "employment", components: ["employer"] }
                ]
              }
            ]
          }
        }
      : {})
  };
}

const JOURNEY_FORM = formWith([
  { id: "employed", type: "checkbox", configuration: {} },
  BUSINESS_NAME,
  { id: "employer", type: "text", configuration: { required: true } },
  { id: "age", type: "number", configuration: {}, rules: { value: "2026 - born" } },
  { id: "born", type: "number", configuration: {} }
]);

function envelopeOf(definition: FormDefinition, values: Record<string, unknown>, journeyId?: string): CanonicalSubmission {
  return {
    versionContext: {
      form: { id: definition.id, version: definition.version },
      client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" }
    },
    submission: { locale: "en", values, ...(journeyId !== undefined ? { journey: { id: journeyId } } : {}) }
  };
}

/** A renderer that only records what it was asked to print. */
function capturingRenderer(seen: SubmissionPdfRenderInput[]): SubmissionPdfRenderer {
  return {
    async render(input) {
      seen.push(input);
      return { bytes: new Uint8Array([37, 80, 68, 70]), pageCount: 1, layoutId: "default", layoutKind: "generated", signed: false, attached: [], warnings: [] };
    },
    async verify() {
      return { signatures: [], attachments: [], warnings: [] };
    },
    async inspect() {
      throw new Error("not used");
    }
  };
}

async function make(definition: FormDefinition) {
  const store = new InMemorySubmissionStore();
  const rendered: SubmissionPdfRenderInput[] = [];
  let n = 0;
  const service = createSubmissionService({ store, validator: createKernelValidator(), pdf: capturingRenderer(rendered), ids: () => `rec-${++n}` });
  await service.register(definition, { pdf: { enabled: true, sign: false, attachSubmission: false } });
  return { service, rendered };
}

const FORGED = "<script>" + "x".repeat(50000);

describe("SubmissionService: the values a record stands for", () => {
  it("keeps a withheld off-path answer in the delivered document only: not in the values, the PDF, the exports or the statistics", async () => {
    const { service, rendered } = await make(JOURNEY_FORM);
    const document = envelopeOf(JOURNEY_FORM, { employed: true, employer: "ACME", business_name: FORGED }, "apply");
    const { record } = await service.receive({ submissionKey: crypto.randomUUID(), document });

    expect(record.status).toBe("accepted");
    // The delivered document, byte for byte: its digest and any signature cover it.
    expect(submissionEnvelopeOf(record.document).submission.values.business_name).toBe(FORGED);
    expect(record.values).toEqual({ employed: true, employer: "ACME" });
    expect(recordValuesOf(record)).toEqual({ employed: true, employer: "ACME" });
    expect(record.logs).toContainEqual(expect.objectContaining({ level: "warn", data: { fields: ["business_name"] } }));

    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.values).toEqual({ employed: true, employer: "ACME" });

    const csv = await service.exportRecords("apply-form@1", "csv");
    expect(csv.text).not.toContain("<script>");
    const json = await service.exportRecords("apply-form@1", "json");
    expect(json.text).not.toContain("<script>");
    const stats = await service.aggregate("apply-form@1", { fields: ["business_name"] });
    expect(JSON.stringify(stats)).not.toContain("<script>");
    expect(stats.completion.find((entry) => entry.field.componentId === "business_name")?.answered).toBe(0);
  });

  it("keeps the server's own calculations, not the submitted ones", async () => {
    const { service } = await make(JOURNEY_FORM);
    const { record } = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(JOURNEY_FORM, { employed: true, employer: "ACME", born: 1990, age: 7 }, "apply") });
    expect(record.status).toBe("accepted");
    expect(recordValuesOf(record)).toMatchObject({ born: 1990, age: 36 });
    expect(submissionEnvelopeOf(record.document).submission.values.age).toBe(7);
  });

  it("does the same with no journey: an answer hidden with no behaviour set is withheld (the default); one retained keeps its format", async () => {
    const excluded = formWith(
      [
        { id: "employed", type: "checkbox", configuration: {} },
        { ...BUSINESS_NAME, rules: { visibleWhen: eq("employed", false) } }
      ],
      false
    );
    const { service } = await make(excluded);
    const { record } = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(excluded, { employed: true, business_name: FORGED }) });
    expect(record.status).toBe("accepted");
    expect(record.values).toEqual({ employed: true });
    expect((await service.exportRecords("apply-form@1", "csv")).text).not.toContain("<script>");

    const retained = formWith(
      [
        { id: "employed", type: "checkbox", configuration: {} },
        { ...BUSINESS_NAME, configuration: { ...(BUSINESS_NAME.configuration as Record<string, unknown>), hiddenValueBehavior: "retain" }, rules: { visibleWhen: eq("employed", false) } }
      ],
      false
    );
    const strict = await make(retained);
    const refused = await strict.service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(retained, { employed: true, business_name: FORGED }) });
    expect(refused.record.status).toBe("rejected");
    expect(refused.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["business_name:maxLength"]);
    expect(strict.rendered).toHaveLength(0);
  });

  it("stores no hidden answer by default, and stores it when the field sets retain", async () => {
    const hiddenField = (configuration: Record<string, unknown>): ComponentNode => ({ id: "nickname", type: "text", configuration, rules: { visibleWhen: eq("employed", false) } });
    const byDefault = formWith([{ id: "employed", type: "checkbox", configuration: {} }, hiddenField({})], false);
    const left = await make(byDefault);
    const dropped = await left.service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(byDefault, { employed: true, nickname: "ace" }) });
    expect(dropped.record.status).toBe("accepted");
    expect(dropped.record.values).toEqual({ employed: true });
    expect(recordValuesOf(dropped.record)).toEqual({ employed: true });
    expect(left.rendered[0]?.values).toEqual({ employed: true });

    const retained = formWith([{ id: "employed", type: "checkbox", configuration: {} }, hiddenField({ hiddenValueBehavior: "retain" })], false);
    const kept = await make(retained);
    const sent = await kept.service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(retained, { employed: true, nickname: "ace" }) });
    expect(sent.record.status).toBe("accepted");
    expect(sent.record.values).toEqual({ employed: true, nickname: "ace" });
    expect(recordValuesOf(sent.record)).toEqual({ employed: true, nickname: "ace" });
    expect(kept.rendered[0]?.values).toEqual({ employed: true, nickname: "ace" });
  });

  it("reads a record refused before anything was judged (journey.unknown) from its document", () => {
    const unjudged: SubmissionRecord = {
      id: "unjudged",
      formId: "apply-form",
      formVersion: "1",
      receivedAt: "2026-09-01T00:00:00.000Z",
      status: "rejected",
      document: envelopeOf(JOURNEY_FORM, { employed: true, employer: "ACME" }),
      digest: "d",
      submissionKey: "k-unjudged",
      locale: "en",
      source: "api",
      errors: [{ code: "journey.unknown", stage: "journey", source: "server", parameters: { journey: "elsewhere" } }]
    };
    expect(recordValuesOf(unjudged)).toEqual({ employed: true, employer: "ACME" });
  });
});
