import { describe, expect, it } from "vitest";
import type { FormDefinition } from "@argusvane/datum-engine";

import { InMemorySubmissionStore, SUBMISSION_ROUTES, createKernelValidator, createSubmissionService, statusOf } from "../src/index.js";

const form = (id: string, version: string, required = false): FormDefinition => ({
  id,
  version,
  schemaVersion: "1",
  root: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { required } }] } }
});
const env = (values: Record<string, unknown> = { name: "yes" }, id = "f") => ({
  versionContext: { form: { id, version: "1" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
  submission: { locale: "en", values }
});
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as { code?: string });

function make() {
  const store = new InMemorySubmissionStore();
  let n = 0;
  const service = createSubmissionService({ store, validator: createKernelValidator(), ids: () => `r${++n}` });
  return { store, service };
}

describe("receive keys a delivery on the submission key the browser mints per submit", () => {
  it("keeps two people who give the same answers as two records", async () => {
    const { store, service } = make();
    await service.register(form("f", "1"));
    const alice = await service.receive({ document: env() as never, submissionKey: "6f1c1a52-0d6b-4f39-9a3e-1f0e1f6a0001" });
    const bob = await service.receive({ document: env() as never, submissionKey: "6f1c1a52-0d6b-4f39-9a3e-1f0e1f6a0002" });
    expect(bob.record.id).not.toBe(alice.record.id);
    expect(bob.record.digest).toBe(alice.record.digest);
    expect(await store.countRecords()).toBe(2);
    // The bare-values route is the same.
    const one = await service.receive({ formId: "f", formVersion: "1", values: { name: "no" }, submissionKey: "k-1" });
    const two = await service.receive({ formId: "f", formVersion: "1", values: { name: "no" }, submissionKey: "k-2" });
    expect(two.record.id).not.toBe(one.record.id);
    expect(await store.countRecords()).toBe(4);
  });

  it("answers a retry of the same attempt (same key, same document) with the first record, even at once", async () => {
    const { store, service } = make();
    await service.register(form("f", "1"));
    const first = await service.receive({ document: env() as never, submissionKey: "attempt-1" });
    const again = await service.receive({ document: env() as never, submissionKey: "attempt-1" });
    expect(again.record.id).toBe(first.record.id);
    expect(again.errors).toEqual([]);
    expect(again.receipt).toBeDefined();
    expect(first.record.submissionKey).toBe("attempt-1");
    const [c, d] = await Promise.all([
      service.receive({ document: env({ name: "y" }) as never, submissionKey: "attempt-2" }),
      service.receive({ document: env({ name: "y" }) as never, submissionKey: "attempt-2" })
    ]);
    expect(d.record.id).toBe(c.record.id);
    expect(await store.countRecords()).toBe(2);
  });

  it("refuses a known key with a different document (409 submission.keyConflict) and keeps nothing", async () => {
    const { store, service } = make();
    await service.register(form("f", "1"));
    await service.receive({ document: env() as never, submissionKey: "attempt-1" });
    const error = await refusal(service.receive({ document: env({ name: "someone else" }) as never, submissionKey: "attempt-1" }));
    expect(error).toMatchObject({ code: "submission.keyConflict" });
    expect(statusOf(error as never)).toBe(409);
    // Never answered with the stored record: a guessed key reads nothing.
    expect(JSON.stringify(error)).not.toContain("r1");
    // At once as well: the second waits for the first and is then refused.
    const [a, b] = await Promise.all([
      refusal(service.receive({ document: env({ name: "p" }) as never, submissionKey: "attempt-2" })),
      refusal(service.receive({ document: env({ name: "q" }) as never, submissionKey: "attempt-2" }))
    ]);
    expect([a?.code, b?.code]).toEqual([undefined, "submission.keyConflict"]);
    expect(await store.countRecords()).toBe(2);
    expect(SUBMISSION_ROUTES.find((route) => route.operation === "receive")?.responds).toContain("submission.keyConflict");
  });

  it("refuses a delivery without a usable key (400 bad_document) before anything is judged", async () => {
    const { store, service } = make();
    await service.register(form("f", "1"));
    for (const key of [undefined, "", 7, null, { a: 1 }, "x".repeat(129), " lead", "has space", "line\nbreak"]) {
      const withKey = key === undefined ? {} : { submissionKey: key };
      for (const input of [{ document: env(), ...withKey }, { formId: "f", formVersion: "1", values: { name: "a" }, ...withKey }]) {
        const error = await refusal(service.receive(input as never));
        expect(error, JSON.stringify(key)).toMatchObject({ code: "bad_document" });
        expect(statusOf(error as never)).toBe(400);
      }
    }
    expect(await store.countRecords()).toBe(0);
    // A UUID, and the 128-character ceiling, are keys.
    expect((await service.receive({ document: env() as never, submissionKey: "x".repeat(128) })).record.status).toBe("accepted");
  });

  it("refuses a known key with another document before judging it: an invalid one is 409 too, and nothing is kept", async () => {
    const { store, service } = make();
    await service.register(form("g", "1", true));
    await service.receive({ document: env({ name: "Ada" }, "g") as never, submissionKey: "attempt-1" });
    // The document fails the form's rule, yet the answer is the conflict, not the errors: every
    // host answers a known key the same way whatever the document holds.
    const error = await refusal(service.receive({ document: env({ name: "" }, "g") as never, submissionKey: "attempt-1" }));
    expect(error).toMatchObject({ code: "submission.keyConflict" });
    expect(statusOf(error as never)).toBe(409);
    expect(await store.countRecords()).toBe(1);
  });

  it("measures the body before it reads the key: an oversized delivery is 413 with a key or without", async () => {
    const store = new InMemorySubmissionStore();
    const service = createSubmissionService({ store, validator: createKernelValidator(), maxBodyBytes: 1024 });
    await service.register(form("f", "1"));
    const big = { name: "x".repeat(4096) };
    for (const withKey of [{}, { submissionKey: "" }, { submissionKey: "attempt-1" }]) {
      for (const input of [{ document: env(big), ...withKey }, { formId: "f", formVersion: "1", values: big, ...withKey }]) {
        const error = await refusal(service.receive(input as never));
        expect(error, JSON.stringify(withKey)).toMatchObject({ code: "payload_too_large" });
        expect(statusOf(error as never)).toBe(413);
      }
    }
    expect(await store.countRecords()).toBe(0);
  });

  it("knows a key only once a delivery under it was accepted: a refused attempt is kept each time and its key stays free", async () => {
    const { store, service } = make();
    await service.register(form("g", "1", true));
    const first = await service.receive({ document: env({ name: "" }, "g") as never, submissionKey: "attempt-1" });
    const second = await service.receive({ document: env({ name: "" }, "g") as never, submissionKey: "attempt-1" });
    expect([first.record.status, second.record.status]).toEqual(["rejected", "rejected"]);
    expect(second.record.id).not.toBe(first.record.id);
    const fixed = await service.receive({ document: env({ name: "Ada" }, "g") as never, submissionKey: "attempt-1" });
    expect(fixed.record.status).toBe("accepted");
    expect(await store.countRecords()).toBe(3);
  });

  it("keys per form version: the same key on another form is another record", async () => {
    const { store, service } = make();
    await service.register(form("f", "1"));
    await service.register(form("h", "1"));
    await service.receive({ document: env() as never, submissionKey: "shared" });
    const other = await service.receive({ document: env({ name: "yes" }, "h") as never, submissionKey: "shared" });
    expect(other.record.status).toBe("accepted");
    expect(await store.countRecords()).toBe(2);
  });

  it("asks no key of a check, which stores nothing", async () => {
    const { store, service } = make();
    await service.register(form("f", "1"));
    expect((await service.validate({ document: env() as never })).accepted).toBe(true);
    expect(await store.countRecords()).toBe(0);
  });
});
