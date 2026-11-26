import { describe, expect, it } from "vitest";
import type { FormDefinition } from "@argusvane/datum-engine";
import { createWebAuthnSigningProvider, normalizeSigningFormat, signedCanonicalOf } from "@argusvane/datum-engine";

import { createSoftwareAuthenticator } from "../../../engine/tests/webauthn-fixture.js";
import { InMemorySubmissionStore, catalogKeyOf, createKernelValidator, createSubmissionService, recordValuesOf, statusOf, type SubmissionStore, type SubmissionValidator } from "../src/index.js";

const form = (id: string, version: string, required = false, extra: Record<string, unknown> = {}): FormDefinition => ({
  id,
  version,
  schemaVersion: "1",
  root: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { required, ...extra } }] } }
});
const env = (id = "f", version = "1", values: Record<string, unknown> = { name: "x" }, locale: unknown = "en") => ({
  versionContext: { form: { id, version }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
  submission: { locale, values }
});
const make = (validator: SubmissionValidator = createKernelValidator()) => createSubmissionService({ store: new InMemorySubmissionStore(), validator });
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as { code?: string });

describe("submission service hardening", () => {
  it("refuses a verdict whose digest is not the delivered document's, and sends the sandbox the document", async () => {
    const seen: unknown[] = [];
    const liar: SubmissionValidator = {
      id: "liar",
      async validate(context) {
        seen.push(context);
        return { errors: [], values: { name: "x" }, digest: "0".repeat(64), canonical: '{"other":1}' } as never;
      }
    };
    const service = make(liar);
    await service.register(form("f", "1"));
    expect(await refusal(service.receive({ submissionKey: crypto.randomUUID(), document: env() as never }))).toMatchObject({ code: "validator_unavailable" });
    expect((seen[0] as { document?: unknown }).document).toEqual(env());
  });

  it("judges only the current version of a form unless the older one was registered open", async () => {
    const service = make();
    await service.register(form("f", "1"));
    await service.register(form("f", "2", true));
    const error = await refusal(service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "1", {}) as never }));
    expect(error).toMatchObject({ code: "version_superseded" });
    expect(statusOf(error as never)).toBe(409);
    expect((await service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "2", {}) as never })).record.status).toBe("rejected");
    await service.register(form("f", "1"), undefined, { open: true });
    expect((await service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "1", {}) as never })).record.status).toBe("accepted");
  });

  it("refuses unknown siblings of a signed wrapper's payload, and a wrapper without signatures or format", async () => {
    const service = make();
    await service.register(form("f", "1", false, { maxLength: 5 }));
    const format = { scope: "envelope", placement: "wrapper", digest: "sha-256", canonicalization: "jcs" };
    const smuggled = { ...env("f", "1", { name: "WAY TOO LONG A NAME" }), payload: env(), signatures: [], format };
    expect(await refusal(service.receive({ submissionKey: crypto.randomUUID(), document: smuggled as never }))).toMatchObject({ code: "bad_document" });
    expect(await refusal(service.receive({ submissionKey: crypto.randomUUID(), document: { payload: env() } as never }))).toMatchObject({ code: "bad_document" });
    expect(await refusal(service.receive({ submissionKey: crypto.randomUUID(), document: { payload: env(), signatures: [] } as never }))).toMatchObject({ code: "bad_document" });
    const ok = await service.receive({ submissionKey: crypto.randomUUID(), document: { payload: env(), signatures: [], format } as never });
    expect(recordValuesOf(ok.record)).toEqual({ name: "x" });
  });

  it("holds a locale to a short tag", async () => {
    const service = make();
    await service.register(form("f", "1"));
    for (const locale of [{ x: 1 }, "x".repeat(1_000_000), "<script>alert(1)</script> ../x"]) {
      expect(await refusal(service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "1", { name: "a" }, locale) as never }))).toMatchObject({ code: "bad_document" });
    }
    expect((await service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "1", { name: "a" }, "fr-CA") as never })).record.status).toBe("accepted");
  });

  it("keys 'x@1' version '0' apart from 'x' version '1@0'", async () => {
    const service = make();
    const victim = await service.register(form("x@1", "0", true));
    const shadow = await service.register(form("x", "1@0", false));
    expect(shadow.key).not.toBe(victim.key);
    expect((await service.receive({ submissionKey: crypto.randomUUID(), document: env("x@1", "0", {}) as never })).record.status).toBe("rejected");
  });

  it("says in the stored summary what a signature covers", async () => {
    const rp = "localhost";
    const origin = "http://localhost:5173";
    const authenticator = await createSoftwareAuthenticator({ rpId: rp, origin });
    const provider = createWebAuthnSigningProvider({ rpId: rp, credentials: () => [authenticator.record()], credentialsContainer: authenticator.container() });
    const service = createSubmissionService({
      store: new InMemorySubmissionStore(),
      validator: createKernelValidator(),
      envelopeVerifier: { credentials: (id) => (id === authenticator.id ? { publicKey: authenticator.publicKey, algorithm: authenticator.algorithm } : undefined), expectedOrigins: [origin], rpId: rp, requireUserVerification: false }
    });
    await service.register(form("f", "1"));
    await service.register(form("f", "2"), undefined, { open: true });
    const format = normalizeSigningFormat({ scope: "values", placement: "wrapper" });
    const [signature] = await provider.sign({ canonical: signedCanonicalOf(env("f", "1") as never, "values"), participants: [], modeId: "m", format });
    const r = await service.receive({ submissionKey: crypto.randomUUID(), document: { format, payload: env("f", "2"), signatures: [signature!] } as never });
    expect(r.record.signatures?.envelope).toEqual({ count: 1, status: "valid", scope: "values" });
  });

  it("orders versions by number, not registration order, and recovers when the newer one is deleted", async () => {
    const service = make();
    await service.register(form("f", "2.0.0"));
    await service.register(form("f", "1.0.0")); // listed after the newer one, still the older
    expect(await refusal(service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "1.0.0") as never }))).toMatchObject({ code: "version_superseded" });
    expect((await service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "2.0.0") as never })).record.status).toBe("accepted");
    await service.register(form("f", "10.0.0"));
    expect(await refusal(service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "2.0.0") as never }))).toMatchObject({ code: "version_superseded" });
    await service.deleteEntry(catalogKeyOf("f", "10.0.0"));
    expect((await service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "2.0.0") as never })).record.status).toBe("accepted");
    await service.deleteEntry(catalogKeyOf("f", "2.0.0"));
    expect((await service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "1.0.0") as never })).record.status).toBe("accepted");
  });

  it("falls back to registration order when versions do not parse", async () => {
    const service = make();
    await service.register(form("f", "spring"));
    await service.register(form("f", "summer"));
    expect(await refusal(service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "spring") as never }))).toMatchObject({ code: "version_superseded" });
    expect((await service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "summer") as never })).record.status).toBe("accepted");
  });

  it("answers bad_document, never a TypeError, to a document without its envelope parts", async () => {
    const service = make();
    await service.register(form("f", "1"));
    const format = { scope: "envelope", placement: "wrapper", digest: "sha-256", canonicalization: "jcs" };
    const bad: Record<string, unknown> = {
      empty: {},
      strPayload: { payload: "x", signatures: [], format },
      emptyPayload: { payload: {}, signatures: [], format },
      noSubmission: { versionContext: env().versionContext },
      noValues: { versionContext: env().versionContext, submission: { locale: "en" } },
      arrayValues: { versionContext: env().versionContext, submission: { locale: "en", values: [] } },
      noForm: { versionContext: {}, submission: { locale: "en", values: {} } },
      numericId: { versionContext: { form: { id: 1, version: "1" } }, submission: { locale: "en", values: {} } },
      list: [],
      nothing: null
    };
    for (const [name, document] of Object.entries(bad)) {
      const error = await refusal(service.receive({ submissionKey: crypto.randomUUID(), document: document as never }));
      expect(error, name).toMatchObject({ code: "bad_document" });
      expect(statusOf(error as never), name).toBe(400);
    }
  });

  it("keeps one record for an attempt delivered again, even at once, and answers the retry with it", async () => {
    const store = new InMemorySubmissionStore();
    let n = 0;
    const service = createSubmissionService({ store, validator: createKernelValidator(), ids: () => `r${++n}` });
    await service.register(form("f", "1"));
    const a = await service.receive({ submissionKey: "attempt-a", document: env() as never });
    const b = await service.receive({ submissionKey: "attempt-a", document: env() as never });
    expect(b.record.id).toBe(a.record.id);
    expect(b.record.digest).toBe(a.record.digest);
    expect(b.errors).toEqual([]);
    // Two of a kind in flight together share one run.
    const [c, d] = await Promise.all([service.receive({ submissionKey: "attempt-c", document: env("f", "1", { name: "y" }) as never }), service.receive({ submissionKey: "attempt-c", document: env("f", "1", { name: "y" }) as never })]);
    expect(d.record.id).toBe(c.record.id);
    expect(await store.countRecords()).toBe(2);
    // Another attempt with the same answers is another record; a rejected delivery is kept each time it is sent.
    expect((await service.receive({ submissionKey: "attempt-e", document: env() as never })).record.id).not.toBe(a.record.id);
    await service.register(form("g", "1", true));
    const first = await service.receive({ submissionKey: "attempt-g", document: env("g", "1", { name: "" }) as never });
    const second = await service.receive({ submissionKey: "attempt-g", document: env("g", "1", { name: "" }) as never });
    expect([first.record.status, second.record.status]).toEqual(["rejected", "rejected"]);
    expect(second.record.id).not.toBe(first.record.id);
  });

  it("refuses a body past maxBodyBytes (default 1 MiB) with payload_too_large, a 413, and keeps nothing", async () => {
    const store = new InMemorySubmissionStore();
    const service = createSubmissionService({ store, validator: createKernelValidator() });
    await service.register(form("f", "1"));
    const big = env("f", "1", { name: "x".repeat(1024 * 1024) });
    for (const call of [() => service.receive({ submissionKey: crypto.randomUUID(), document: big as never }), () => service.validate({ document: big as never }), () => service.receive({ submissionKey: crypto.randomUUID(), formId: "f", formVersion: "1", values: big.submission.values })]) {
      const error = await refusal(call());
      expect(error).toMatchObject({ code: "payload_too_large" });
      expect(statusOf(error as never)).toBe(413);
    }
    expect(await store.countRecords()).toBe(0);
    // Bytes, not characters: 400 three-byte characters are 1,200 bytes.
    const small = createSubmissionService({ store: new InMemorySubmissionStore(), validator: createKernelValidator(), maxBodyBytes: 1000 });
    await small.register(form("f", "1"));
    expect(await refusal(small.receive({ submissionKey: crypto.randomUUID(), document: env("f", "1", { name: "€".repeat(400) }) as never }))).toMatchObject({ code: "payload_too_large" });
    expect((await small.receive({ submissionKey: crypto.randomUUID(), document: env("f", "1", { name: "€".repeat(100) }) as never })).record.status).toBe("accepted");
    // The limit is the host's to move.
    const wide = createSubmissionService({ store: new InMemorySubmissionStore(), validator: createKernelValidator(), maxBodyBytes: Infinity });
    await wide.register(form("f", "1"));
    expect((await wide.receive({ submissionKey: crypto.randomUUID(), document: big as never })).record.status).toBe("accepted");
  });

  it("measures a bare delivery whole and holds its locale to a language tag", async () => {
    const store = new InMemorySubmissionStore();
    const service = createSubmissionService({ store, validator: createKernelValidator() });
    await service.register(form("f", "1"));
    const huge = "x".repeat(5_000_000);
    for (const extra of [{ locale: huge }, { journeyId: huge }]) {
      const error = await refusal(service.receive({ submissionKey: crypto.randomUUID(), formId: "f", formVersion: "1", values: { name: "a" }, ...extra }));
      expect(error).toMatchObject({ code: "payload_too_large" });
    }
    // Under the cap, a locale that is no tag is a bad document on a bare delivery as on an enveloped one.
    expect(await refusal(service.receive({ submissionKey: crypto.randomUUID(), formId: "f", formVersion: "1", values: { name: "a" }, locale: "x".repeat(40) }))).toMatchObject({ code: "bad_document" });
    expect(await store.countRecords()).toBe(0);
    expect((await service.receive({ submissionKey: crypto.randomUUID(), formId: "f", formVersion: "1", values: { name: "a" }, locale: "fr-CA" })).record.locale).toBe("fr-CA");
  });

  it("checks the record the store returns before treating it as the replay", async () => {
    const inner = new InMemorySubmissionStore();
    const naive = Object.create(inner) as SubmissionStore;
    // A host store that ignores the key filter answers the newest accepted record of the form.
    (naive as unknown as { listRecords: SubmissionStore["listRecords"] }).listRecords = (options) => {
      const { submissionKey: _ignored, ...filter } = (options?.filter ?? {}) as Record<string, unknown>;
      return inner.listRecords({ ...options, filter } as never);
    };
    const service = createSubmissionService({ store: naive, validator: createKernelValidator() });
    await service.register(form("f", "1"));
    const first = await service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "1", { name: "first" }) as never });
    const second = await service.receive({ submissionKey: crypto.randomUUID(), document: env("f", "1", { name: "second" }) as never });
    expect(second.record.id).not.toBe(first.record.id);
    expect(await inner.countRecords()).toBe(2);
  });

  it("answers a verdict past the sandbox's cap under its own code, a 503 with the other failed runs, never a 422", async () => {
    const tooBig: SubmissionValidator = {
      id: "too-big",
      async validate() {
        throw Object.assign(new Error("outcome.tooLarge: the sandbox answered with 9236198 characters; a run's outcome is at most 8388608"), { code: "outcome_too_large" });
      }
    };
    const store = new InMemorySubmissionStore();
    const service = createSubmissionService({ store, validator: tooBig });
    await service.register(form("f", "1"));
    for (const call of [() => service.receive({ submissionKey: crypto.randomUUID(), document: env() as never }), () => service.validate({ document: env() as never })]) {
      const error = await refusal(call());
      expect(error).toMatchObject({ code: "outcome_too_large" });
      expect(statusOf(error as never)).toBe(503);
    }
    expect(await store.countRecords()).toBe(0);
    // Any other throw from the sandbox stays an outage.
    const broken = createSubmissionService({ store: new InMemorySubmissionStore(), validator: { id: "broken", async validate() { throw new Error("boom"); } } });
    await broken.register(form("f", "1"));
    expect(await refusal(broken.receive({ submissionKey: crypto.randomUUID(), document: env() as never }))).toMatchObject({ code: "validator_unavailable" });
  });

  it("keeps the delivered document raw and the judged values folded: record.document is the signed input, record.values the fold", async () => {
    const lit = (value: unknown) => ({ kind: "literal", value });
    const path = (p: string) => ({ kind: "path", path: p });
    const journeyed = {
      id: "j9",
      version: "1",
      schemaVersion: "1",
      root: { id: "form", type: "form", configuration: {}, children: { content: [
        { id: "employed", type: "checkbox", configuration: {} },
        { id: "employer", type: "text", configuration: { required: true, maxLength: 5 } },
        { id: "email", type: "text", configuration: { required: true } }
      ] } },
      journey: { journeys: [{ id: "j", pages: [
        { id: "a", components: ["employed"], routes: [{ when: { kind: "binary", operator: "eq", left: path("employed"), right: lit(true) }, to: "b" }, { to: "c" }] },
        { id: "b", components: ["employer"], routes: [{ to: "c" }] },
        { id: "c", components: ["email"], routes: [{ to: "$end" }] }
      ] }] }
    } as unknown as FormDefinition;
    const service = make();
    await service.register(journeyed);
    const document = { ...env("j9", "1", { employed: false, employer: "X".repeat(5000), email: "a@b.c" }), submission: { locale: "en", journey: "j", values: { employed: false, employer: "X".repeat(5000), email: "a@b.c" } } };
    const { record } = await service.receive({ submissionKey: crypto.randomUUID(), document: document as never });
    expect(record.status).toBe("accepted");
    // The fold drops the answer of the page the path skipped from what the record judged...
    expect(Object.keys(recordValuesOf(record))).toEqual(["employed", "email"]);
    // ...and the document is what was delivered, byte for byte, because its digest and signatures cover it.
    expect(record.document).toEqual(document);
    expect(JSON.stringify(record.document)).toContain("X".repeat(5000));
  });
});

