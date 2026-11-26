import { describe, expect, it } from "vitest";
import type { CanonicalSubmission, FormDefinition } from "@argusvane/datum-engine";

import { InMemorySubmissionStore, SubmissionServiceError, createKernelValidator, createProgramHostValidator, createSubmissionService, submissionDigest } from "../src/index.js";

/** A form with a required email, a scoped container and a repeating section — the kernel test's tree, given an identity. */
export const INTAKE: FormDefinition = {
  id: "intake",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "email", type: "text", configuration: { required: true, pattern: "[^@]+@[^@]+" } },
        { id: "notes", type: "textarea", configuration: { minLength: 3, maxLength: 60 } },
        {
          id: "applicant",
          type: "container",
          configuration: {},
          children: {
            content: [
              { id: "firstName", type: "text", configuration: { required: true } },
              { id: "consent", type: "checkbox", configuration: { required: true } }
            ]
          }
        }
      ]
    }
  }
};

export function envelopeOf(values: Record<string, unknown>, locale = "en"): CanonicalSubmission {
  return {
    versionContext: { form: { id: INTAKE.id, version: INTAKE.version }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" } },
    submission: { locale, values }
  };
}

export const GOOD_VALUES = { email: "ada@example.gov", notes: "hello", "applicant.firstName": "Ada", "applicant.consent": true };

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 15, 12, 0, tick++));
}

describe("SubmissionService: catalog and receive", () => {
  function make() {
    const store = new InMemorySubmissionStore();
    let n = 0;
    const service = createSubmissionService({ store, validator: createKernelValidator(), clock: fixedClock(), ids: () => `rec-${++n}` });
    return { store, service };
  }

  it("registers a definition under id@version, keeps its title and default settings, and re-registering keeps the registration time and settings", async () => {
    const { service } = make();
    const entry = await service.register(INTAKE);
    expect(entry).toMatchObject({ key: "intake@1.0.0", formId: "intake", formVersion: "1.0.0", title: "Intake", registeredAt: "2026-09-15T12:00:00.000Z" });
    expect(entry.settings).toEqual({ validation: { unknownFields: "strip", logLevel: "info" }, receipt: { title: "Submission received", message: "Your answers were validated and stored.", showRecordId: true } });

    const updated = await service.updateSettings(entry.key, { validation: { unknownFields: "reject" }, pdf: { enabled: true, sign: true }, receipt: { title: "Thanks" } });
    expect(updated.settings).toEqual({ validation: { unknownFields: "reject", logLevel: "info" }, pdf: { enabled: true, sign: true, attachSubmission: true }, receipt: { title: "Thanks", message: "Your answers were validated and stored.", showRecordId: true } });
    const again = await service.register({ ...INTAKE, root: { ...INTAKE.root, configuration: { title: "Intake v1" } } });
    expect(again.registeredAt).toBe("2026-09-15T12:00:00.000Z");
    expect(again.title).toBe("Intake v1");
    expect(again.settings.validation.unknownFields).toBe("reject");
    expect((await service.updateSettings(entry.key, { pdf: null })).settings.pdf).toBeUndefined();
    await expect(service.updateSettings("nobody@1", {})).rejects.toMatchObject({ code: "unknown_form" });
  });

  it("accepts a valid envelope: the sandbox's verdict, a digest, a receipt naming the record, and counts on the catalog", async () => {
    const { service, store } = make();
    await service.register(INTAKE);
    const document = envelopeOf({ ...GOOD_VALUES, rogue: "stripped" });
    const result = await service.receive({ submissionKey: crypto.randomUUID(), document }, { source: "renderer" });
    expect(result.errors).toEqual([]);
    expect(result.record).toMatchObject({ id: "rec-1", formId: "intake", formVersion: "1.0.0", status: "accepted", locale: "en", source: "renderer", errors: [], signatures: { envelope: { count: 0, status: "none" } } });
    expect(result.record.digest).toBe(submissionDigest(document));
    expect(result.record.digest).toMatch(/^[0-9a-f]{64}$/);
    // The record keeps the document as delivered — the unknown key included; the sandbox stripped it from what it judged.
    expect(result.record.document).toEqual(document);
    expect(result.record.logs?.some((entry) => entry.message.includes("unknown fields stripped"))).toBe(true);
    expect(result.receipt).toEqual({
      kind: "success",
      title: "Submission received",
      message: "Your answers were validated and stored.",
      details: [
        { label: "Record", value: "rec-1" },
        { label: "Digest", value: `${result.record.digest.slice(0, 16)}…` }
      ]
    });
    expect(await store.getRecord("rec-1")).toEqual(result.record);
    const [summary] = await service.listCatalog();
    expect(summary?.counts).toEqual({ accepted: 1, rejected: 0 });
  });

  it("rejects an invalid envelope with host errors the form can show, and keeps the rejected record", async () => {
    const { service } = make();
    await service.register(INTAKE);
    const result = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf({ email: "not-an-email", notes: "x" }) });
    expect(result.record.status).toBe("rejected");
    expect(result.receipt).toBeUndefined();
    const codes = result.errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
    // The kernel names the component, not the value path; the path travels beside it.
    expect(codes).toEqual(["consent:required", "firstName:required", "email:pattern", "notes:minLength"].sort());
    expect(result.errors.find((error) => error.componentId === "consent")?.path).toBe("applicant.consent");
    expect(result.errors[0]).toMatchObject({ source: "server", severity: "error" });
    expect((await service.listRecords({ filter: { status: "rejected" } })).total).toBe(1);
    expect((await service.listCatalog())[0]?.counts).toEqual({ accepted: 0, rejected: 1 });
  });

  it("takes bare values for a known form, applies the form's unknown-fields setting, and refuses a form it does not know", async () => {
    const { service } = make();
    const entry = await service.register(INTAKE, { validation: { unknownFields: "reject" } });
    const rejected = await service.receive({ submissionKey: crypto.randomUUID(), formId: "intake", formVersion: "1.0.0", values: { ...GOOD_VALUES, rogue: 1 }, locale: "fr" });
    expect(rejected.record.status).toBe("rejected");
    expect(rejected.errors).toEqual([{ code: "unknown_field", severity: "error", source: "server", parameters: { field: "rogue" } }]);
    expect(rejected.record.locale).toBe("fr");
    expect(rejected.record.document).toMatchObject({ versionContext: { form: { id: "intake", version: "1.0.0" }, client: { runtimeVersion: "server", schemaVersion: "1.0.0" } } });

    await service.updateSettings(entry.key, { validation: { unknownFields: "strip" } });
    expect((await service.receive({ submissionKey: crypto.randomUUID(), formId: "intake", formVersion: "1.0.0", values: { ...GOOD_VALUES, rogue: 1 } })).record.status).toBe("accepted");

    await expect(service.receive({ submissionKey: crypto.randomUUID(), document: { ...envelopeOf(GOOD_VALUES), versionContext: { ...envelopeOf(GOOD_VALUES).versionContext, form: { id: "intake", version: "9.0.0" } } } })).rejects.toBeInstanceOf(SubmissionServiceError);
    await expect(service.receive({ submissionKey: crypto.randomUUID(), formId: "other", formVersion: "1", values: {} })).rejects.toMatchObject({ code: "unknown_form", message: expect.stringContaining('"other"') });
  });

  it("judges through a program host the same way: __datum_run with the context as JSON", async () => {
    const calls: string[] = [];
    const host = {
      call(fn: string, argument: string): string {
        calls.push(fn);
        if (fn === "__datum_inspect") {
          return '{"ok":true,"op":"public"}';
        }
        const context = JSON.parse(argument) as { values: Record<string, unknown>; unknownFields?: string; logLevel?: string };
        expect(context).toMatchObject({ formId: "intake", unknownFields: "strip", logLevel: "info", locale: "en" });
        expect(context.values).toEqual(GOOD_VALUES);
        return JSON.stringify({ errors: [], values: context.values, digest: submissionDigest((context as { document?: never }).document as never) });
      }
    };
    const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator: createProgramHostValidator(host) });
    await service.register(INTAKE);
    const result = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GOOD_VALUES) });
    expect(result.record.status).toBe("accepted");
    // The program proves its ABI once, then judges.
    expect(calls).toEqual(["__datum_inspect", "__datum_run"]);
  });

  it("deletes records and entries, cascading when asked", async () => {
    const { service } = make();
    await service.register(INTAKE);
    await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GOOD_VALUES) });
    await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf({ ...GOOD_VALUES, notes: "another delivery" }) });
    await service.deleteRecord("rec-1");
    expect((await service.listRecords()).items.map((record) => record.id)).toEqual(["rec-2"]);
    await service.deleteEntry("intake@1.0.0", { cascade: true });
    expect(await service.getEntry("intake@1.0.0")).toBeUndefined();
    expect((await service.listRecords()).total).toBe(0);
  });
});

describe("SubmissionService: inspecting documents", () => {
  it("inspects a JSON document without storing it, naming the form, the digest and a matching record", async () => {
    const store = new InMemorySubmissionStore();
    const service = createSubmissionService({ store, validator: createKernelValidator(), ids: () => "rec-x" });
    await service.register(INTAKE);
    const document = envelopeOf(GOOD_VALUES);
    await service.receive({ submissionKey: crypto.randomUUID(), document });
    const inspection = await service.inspectDocument({ kind: "json", text: JSON.stringify(document) });
    expect(inspection).toMatchObject({ kind: "envelope", formKey: "intake@1.0.0", registered: true, recordId: "rec-x", digest: submissionDigest(document), envelope: { placement: "none", summary: { count: 0, status: "none" } } });
    expect((await store.listRecords()).total).toBe(1);

    const foreign = await service.inspectDocument({ kind: "json", text: JSON.stringify({ ...document, versionContext: { ...document.versionContext, form: { id: "other", version: "1" } } }) });
    expect(foreign).toMatchObject({ formKey: "other@1", registered: false });
    expect(foreign.recordId).toBeUndefined();

    expect(await service.inspectDocument({ kind: "json", text: JSON.stringify({ values: { a: 1 } }) })).toEqual({ kind: "bare" });
    await expect(service.inspectDocument({ kind: "json", text: "nope" })).rejects.toMatchObject({ code: "bad_document", message: expect.stringContaining("not valid JSON") });

    // A stored record's signatures, through the same report: a demo signature reads unverifiable.
    const signed = { ...document, signatures: [{ signature: "demo", algorithm: "demo-none", signedAt: 0, participantId: "submitter", format: { scope: "envelope", placement: "embedded", digest: "sha-256", canonicalization: "jcs" } }] } as CanonicalSubmission;
    const received = await service.receive({ submissionKey: crypto.randomUUID(), document: signed });
    expect(received.record.signatures?.envelope).toEqual({ count: 1, status: "unverifiable", scope: "envelope" });
    const record = await service.inspectRecord(received.record.id);
    expect(record.envelope.signatures[0]).toMatchObject({ provider: "demo", status: "unverifiable" });
    await expect(service.inspectRecord("missing")).rejects.toMatchObject({ code: "unknown_record" });
  });
});
