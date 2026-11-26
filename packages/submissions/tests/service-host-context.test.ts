import { describe, expect, it } from "vitest";
import type { CanonicalSubmission, FormDefinition } from "@argusvane/datum-engine";

import {
  InMemorySubmissionStore,
  createKernelValidator,
  createSubmissionService,
  type SubmissionPdfRenderInput,
  type SubmissionPdfRenderer,
  type SubmissionValidator
} from "../src/index.js";

/**
 * The server supplies the values `host.` reads, per call (`receive(input, { hostContext })`,
 * `validate(input, { hostContext })`): the sandbox judges every such rule against them, and
 * without them judges as before. The browser's own host context never reaches the verdict: the
 * envelope does not carry it, and nothing here reads one from it.
 */

const FORM: FormDefinition = {
  id: "host-form",
  version: "1",
  schemaVersion: "1",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { required: true } },
        { id: "admin_note", type: "text", configuration: { required: true }, rules: { visibleWhen: 'host.role = "admin"' } },
        { id: "region", type: "text", configuration: {}, rules: { value: 'coalesce(host.region, "none")' } }
      ]
    }
  }
} as unknown as FormDefinition;

function envelope(values: Record<string, unknown>): CanonicalSubmission {
  return {
    versionContext: { form: { id: FORM.id, version: FORM.version }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } },
    submission: { locale: "en", values }
  };
}

function renderer(seen: SubmissionPdfRenderInput[]): SubmissionPdfRenderer {
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

async function make() {
  const contexts: Array<Record<string, unknown>> = [];
  const kernel = createKernelValidator();
  const validator: SubmissionValidator = {
    ...kernel,
    async validate(context) {
      contexts.push(context as unknown as Record<string, unknown>);
      return kernel.validate(context);
    }
  };
  const rendered: SubmissionPdfRenderInput[] = [];
  const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator, pdf: renderer(rendered) });
  await service.register(FORM, { pdf: { enabled: true, sign: false, attachSubmission: false } });
  return { service, contexts, rendered };
}

const codes = (errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>): string[] => errors.map((error) => `${error.componentId ?? "-"}:${error.code}`);

describe("SubmissionService: a host context per call", () => {
  it("validate judges host. rules with the server's context, and as before without one", async () => {
    const { service, contexts } = await make();
    const document = envelope({ name: "N" });
    const admin = await service.validate({ document }, { hostContext: { role: "admin" } });
    expect(admin.accepted).toBe(false);
    expect(admin.errors.map((error) => error.code)).toEqual(["required"]);
    expect(contexts.at(-1)?.["hostContext"]).toEqual({ role: "admin" });

    const user = await service.validate({ document }, { hostContext: { role: "user" } });
    expect(user.accepted).toBe(true);

    const none = await service.validate({ document });
    expect(none.accepted).toBe(true);
    expect("hostContext" in (contexts.at(-1) ?? {})).toBe(false);
  });

  it("receive keeps the server's own calculation over the context, and prints with the same context", async () => {
    const { service, rendered } = await make();
    const { record } = await service.receive({ submissionKey: crypto.randomUUID(), document: envelope({ name: "N", region: "forged" }) }, { hostContext: { role: "user", region: "QC" } });
    expect(record.status).toBe("accepted");
    expect(record.values).toEqual({ name: "N", region: "QC" });
    expect(record.clientDerived).toBeUndefined();
    expect(rendered.at(-1)?.hostContext).toEqual({ role: "user", region: "QC" });

    const refused = await service.receive({ submissionKey: crypto.randomUUID(), document: envelope({ name: "N" }) }, { hostContext: { role: "admin" } });
    expect(refused.record.status).toBe("rejected");
    expect(codes(refused.record.errors)).toEqual(["admin_note:required"]);

    // Without one: the calculation is kept as sent and listed, as before.
    const kept = await service.receive({ submissionKey: crypto.randomUUID(), document: envelope({ name: "N", region: "forged" }) });
    expect(kept.record.values).toEqual({ name: "N", region: "forged" });
    expect(kept.record.clientDerived).toEqual(["region"]);
  });

  it("copies the context through JSON and refuses one that is no object", async () => {
    const { service, contexts } = await make();
    const document = envelope({ name: "N" });
    await service.validate({ document }, { hostContext: { role: "user", drop: () => 1, n: Number.NaN } as never });
    expect(contexts.at(-1)?.["hostContext"]).toEqual({ role: "user", n: null });
    await expect(service.validate({ document }, { hostContext: "admin" as never })).rejects.toThrow(TypeError);
    await expect(service.validate({ document }, { hostContext: ["admin"] as never })).rejects.toThrow(TypeError);
  });
});
