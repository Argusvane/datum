import { describe, expect, it } from "vitest";
import type { FormDefinition } from "@argusvane/datum-engine";

import { InMemorySubmissionStore, MAX_BODY_DEPTH, createKernelValidator, createSubmissionService, statusOf, type SubmissionValidator } from "../src/index.js";
import { createQuickJsValidator } from "../src/node.js";

/**
 * What a filler can send that the service must answer as theirs, the same on every validator: a
 * body nested past the depth the sandbox reads is a `bad_document` (400), never an outage (503) or a
 * raw stack overflow (500); a body near the size cap carrying an attachment is judged under the
 * default budget, never refused as an outage; and only the three inspect questions are answered.
 */

const FORM: FormDefinition = {
  id: "f",
  version: "1",
  schemaVersion: "1",
  root: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { required: true } }, { id: "upload", type: "file", configuration: {} }] } }
};
const env = (values: Record<string, unknown>) => ({
  versionContext: { form: { id: "f", version: "1" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
  submission: { locale: "en", values }
});
/** A list nested `depth` levels, built without recursion. */
const nested = (depth: number): unknown => {
  let value: unknown = [];
  for (let level = 1; level < depth; level += 1) {
    value = [value];
  }
  return value;
};
const STALE =
  'globalThis.__datum_register = function () { return 0; };globalThis.__datum_run = function () { return JSON.stringify({ errors: [] }); };globalThis.__datum_inspect = function (r) { var q = JSON.parse(r); var a = q.abi.split(".").map(Number); var p = "0.9.0".split(".").map(Number); return JSON.stringify(a[0] === p[0] && a[1] <= p[1] ? { ok: true, op: q.op } : { ok: false, error: { code: "abi_mismatch", message: "older program" } }); };"sandbox-ready";';

const refusal = (error: unknown): string => {
  const code = (error as { code?: string }).code;
  return `${code ?? (error as Error).name}:${code !== undefined ? statusOf(error as never) : 500}`;
};

async function eachValidator(body: (label: string, validator: SubmissionValidator) => Promise<void>): Promise<void> {
  for (const [label, make] of [
    ["quickjs-worker", () => createQuickJsValidator()],
    ["quickjs-inline", () => createQuickJsValidator({ worker: false })],
    ["kernel", async () => ({ ...createKernelValidator(), dispose: async () => undefined })]
  ] as const) {
    const validator = await make();
    try {
      await body(label, validator);
    } finally {
      await validator.dispose();
    }
  }
}

describe("the filler's bounds at the submissions service", () => {
  it("refuses an answer nested past the sandbox's depth as bad_document on every validator, and judges one just inside it", async () => {
    const seen: string[] = [];
    await eachValidator(async (label, validator) => {
      const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator });
      await service.register(FORM);
      for (const depth of [400, 200_000]) {
        const outcome = await service.receive({ submissionKey: crypto.randomUUID(), document: env({ name: "a", deep: nested(depth) }) as never }).then(() => "judged", refusal);
        seen.push(`${label} ${depth} ${outcome}`);
      }
      const bare = await service.receive({ submissionKey: crypto.randomUUID(), formId: "f", formVersion: "1", values: { name: "a", deep: nested(200_000) } }).then(() => "judged", refusal);
      seen.push(`${label} bare ${bare}`);
      // The envelope's own levels (the body, submission, values) and the answer's stay inside the bound.
      const inside = await service.receive({ submissionKey: crypto.randomUUID(), document: env({ name: "a", deep: nested(MAX_BODY_DEPTH - 4) }) as never });
      seen.push(`${label} inside ${inside.record.status}`);
      // The bound itself: three envelope levels over the answer's, so a body of exactly
      // MAX_BODY_DEPTH levels is judged and one level more is the filler's 400.
      const atBound = await service.receive({ submissionKey: crypto.randomUUID(), document: env({ name: "a", deep: nested(MAX_BODY_DEPTH - 3) }) as never }).then((result) => result.record.status, refusal);
      const pastBound = await service.receive({ submissionKey: crypto.randomUUID(), document: env({ name: "a", deep: nested(MAX_BODY_DEPTH - 2) }) as never }).then((result) => result.record.status, refusal);
      seen.push(`${label} at ${atBound}`, `${label} past ${pastBound}`);
    });
    // The bound sits under the sandbox's 320-level request limit with room for the context's own levels.
    expect(MAX_BODY_DEPTH).toBe(256);
    for (const label of ["quickjs-worker", "quickjs-inline", "kernel"]) {
      expect(seen.filter((line) => line.startsWith(label))).toEqual([
        `${label} 400 bad_document:400`,
        `${label} 200000 bad_document:400`,
        `${label} bare bad_document:400`,
        `${label} inside accepted`,
        `${label} at accepted`,
        `${label} past bad_document:400`
      ]);
    }
  }, 120_000);

  it("answers the sandbox refusing a request before it parsed it as the filler's bad_document, not an outage", async () => {
    const refusing: SubmissionValidator = {
      id: "refusing",
      validate: async () => {
        throw Object.assign(new Error("The request nests deeper than 320 levels; the sandbox refuses it before parsing"), { code: "request_refused" });
      }
    };
    const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator: refusing });
    await service.register(FORM);
    expect(await service.receive({ submissionKey: crypto.randomUUID(), document: env({ name: "a" }) as never }).then(() => "judged", refusal)).toBe("bad_document:400");
  });

  it("judges a body of about 900 KB (an attachment inline) under the default QuickJS budget, on a worker and on the calling thread", async () => {
    for (const worker of [true, false]) {
      const validator = await createQuickJsValidator({ worker });
      try {
        const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator });
        await service.register(FORM);
        const data = "A".repeat(900 * 1024);
        const upload = { storage: "inline", name: "scan.pdf", type: "application/pdf", size: Math.floor((data.length * 3) / 4), data };
        const received = await service.receive({ submissionKey: crypto.randomUUID(), document: env({ name: "Ada", upload }) as never });
        expect(received.record.status, `worker ${String(worker)}`).toBe("accepted");
      } finally {
        await validator.dispose();
      }
    }
  }, 120_000);

  it("answers only public, check and inspect: the test op is refused as bad_document", async () => {
    const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator: createKernelValidator() });
    await service.register(FORM);
    await expect(service.inspect("f@1", "test" as never)).rejects.toMatchObject({ code: "bad_document" });
    await expect(service.inspect("f@1", "check")).resolves.toMatchObject({ ok: true, op: "check" });
  });

  it("refuses to bind a program older than the ABI this package speaks, on a worker and on the calling thread", async () => {
    for (const worker of [true, false]) {
      await expect(createQuickJsValidator({ worker, program: STALE }), `worker ${String(worker)}`).rejects.toMatchObject({ code: "abi_mismatch" });
    }
  }, 60_000);
});
