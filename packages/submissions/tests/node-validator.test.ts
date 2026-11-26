import { describe, expect, it, vi } from "vitest";
import type { FormDefinition } from "@argusvane/datum-engine";

import { InMemorySubmissionStore, createKernelValidator, createSubmissionService } from "../src/index.js";
import { createQuickJsValidator } from "../src/node.js";

/** The sandbox as a Node server binds it (on a worker thread or the calling thread, a fresh sandbox per validation). */

const FORM: FormDefinition = {
  id: "f",
  version: "1",
  schemaVersion: "1",
  root: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { required: true } }] } }
};
const env = (values: Record<string, unknown>) => ({
  versionContext: { form: { id: "f", version: "1" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
  submission: { locale: "en", values }
});

describe("createQuickJsValidator (@argusvane/datum-submissions/node)", () => {
  it("judges on a worker thread by default, and with worker false on the calling thread, with the same verdicts", async () => {
    const worker = await createQuickJsValidator();
    const inline = await createQuickJsValidator({ worker: false });
    try {
      expect([worker.id, inline.id]).toEqual(["quickjs-worker", "quickjs"]);
      expect(worker.worker).toBeDefined();
      const verdicts: string[][] = [];
      for (const validator of [worker, inline, createKernelValidator()]) {
        const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator });
        await service.register(FORM);
        const bad = await service.receive({ submissionKey: crypto.randomUUID(), document: env({ name: "" }) as never });
        const good = await service.receive({ submissionKey: crypto.randomUUID(), document: env({ name: "Ada" }) as never });
        verdicts.push([bad.record.status, ...bad.errors.map((error) => error.code), good.record.status]);
      }
      expect(verdicts[0]).toEqual(["rejected", "required", "accepted"]);
      expect(verdicts[1]).toEqual(verdicts[0]);
      expect(verdicts[2]).toEqual(verdicts[0]);
    } finally {
      await worker.dispose();
      await inline.dispose();
    }
  }, 60_000);

  it.each(["killSlackMs", "bootTimeoutMs", "maxWasmHeapBytes", "maxOldGenerationSizeMb"] as const)(
    "refuses %s with worker false, naming it, since only the worker has it",
    async (name) => {
      await expect(createQuickJsValidator({ worker: false, [name]: 1000 })).rejects.toThrow(new RegExp(`"${name}".*only on the worker`));
    }
  );

  it("judges every delivery in a fresh sandbox, on a worker and on the calling thread: what a plugin kept or left behind is gone for the next", async () => {
    // The plugin rejects a delivery when it sees state an earlier one left: its own counter past 1, or a global.
    const plugins = [
      {
        id: "stateful",
        version: "1",
        source: `(function () { var count = 0; return { validators: [ function (c) { count += 1; var leaked = count > 1 || typeof globalThis.leftBehind !== "undefined"; try { globalThis.leftBehind = c.values.name; } catch (e) {} return { errors: leaked ? [{ code: "leaked", severity: "error", componentId: "name", message: "state from an earlier delivery" }] : [] }; } ] }; })()`
      }
    ];
    for (const worker of [true, false]) {
      const validator = await createQuickJsValidator({ worker, plugins });
      try {
        const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator });
        await service.register(FORM);
        const statuses: string[] = [];
        for (const name of ["Ada", "Grace", "Edsger"]) {
          const received = await service.receive({ submissionKey: crypto.randomUUID(), document: env({ name }) as never });
          statuses.push([received.record.status, ...received.errors.map((error) => error.code)].join(" "));
        }
        expect(statuses, `worker ${String(worker)}`).toEqual(["accepted", "accepted", "accepted"]);
      } finally {
        await validator.dispose();
      }
    }
  }, 60_000);

  it("keeps the service answering after a runaway plugin is killed: a 503 for that delivery, then verdicts again", async () => {
    const validator = await createQuickJsValidator({
      maxEvalMs: 200,
      killSlackMs: 200,
      plugins: [{ id: "spin", version: "1", source: `({ validators: [ (c) => { const s='x'.repeat(1e6); let n=0; for(let i=0;i<150&&c.values.name==='spin';i++){ n+=s.split('').length; } return {errors:[]}; } ] })` }]
    });
    try {
      const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator });
      await service.register(FORM);
      await expect(service.receive({ submissionKey: crypto.randomUUID(), document: env({ name: "spin" }) as never })).rejects.toMatchObject({ code: "validator_unavailable" });
      expect(validator.worker?.kills).toBe(1);
      expect((await service.receive({ submissionKey: crypto.randomUUID(), document: env({ name: "Ada" }) as never })).record.status).toBe("accepted");
    } finally {
      await validator.dispose();
    }
  }, 60_000);
});

describe("development-only validators", () => {
  it("logs one warning for the in-process kernel validator, however many services use it, and none for a QuickJS one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // A fresh module graph: the warning is once per process, and another test file may have used it.
      vi.resetModules();
      const fresh = await import("../src/index.js");
      const store = new fresh.InMemorySubmissionStore();
      fresh.createSubmissionService({ store, validator: fresh.createKernelValidator() });
      fresh.createSubmissionService({ store, validator: fresh.createKernelValidator() });
      const quickjs = await createQuickJsValidator();
      fresh.createSubmissionService({ store, validator: quickjs });
      await quickjs.dispose();
      const calls = warn.mock.calls.map((call) => String(call[0]));
      expect(calls.filter((text) => text.includes("in-process kernel validator"))).toHaveLength(1);
      expect(calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});
