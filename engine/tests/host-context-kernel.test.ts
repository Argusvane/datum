import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { JsonWasmAbi, WasmValidationHost } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * The server's host context (`context.hostContext`, sandbox ABI 4.1.0): with one, the kernel
 * judges every rule reading `host.` as the browser does; without one, exactly as before (the
 * rule skipped, the lenient reading). A key the context lacks reads as no answer.
 */

const root = (children: ComponentNode[]): ComponentNode => ({ id: "root", type: "form", configuration: {}, children: { content: children } }) as ComponentNode;

/** `admin_note` is shown to admins only and required; `level` is required when the host says so; `region` is worked out from the host. */
const FORM = root([
  { id: "name", type: "text", configuration: { label: "Name", required: true } },
  { id: "admin_note", type: "text", configuration: { label: "Admin note", required: true }, rules: { visibleWhen: 'host.role = "admin"' } },
  { id: "level", type: "text", configuration: { label: "Level" }, rules: { requiredWhen: "host.strict = true" } },
  { id: "code", type: "text", configuration: { label: "Code" }, rules: { validWhen: "code = host.code" } },
  { id: "region", type: "text", configuration: { label: "Region" }, rules: { value: 'coalesce(host.region, "none")' } }
] as ComponentNode[]);

const codes = (errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>): string[] => errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();

/** The run as a server hands it over: through the ABI's JSON, so the in-process kernel reads what a program reads. */
function run(values: Record<string, unknown>, hostContext?: unknown, extra: Record<string, unknown> = {}) {
  const context = { formId: "host", values, locale: "en", form: FORM, today: "2026-11-15", ...(hostContext !== undefined ? { hostContext } : {}), ...extra };
  const wire = new JsonWasmAbi().serializeContext(context as never, WasmValidationHost.STRICT_POLICY);
  return runKernel(JSON.parse(wire), []);
}

describe("the kernel with no host context judges as it always did", () => {
  it("skips every host. rule: the host-shown field is not required, the calculation is kept as sent and listed", () => {
    const outcome = run({ name: "N", region: "QC" });
    expect(codes(outcome.errors)).toEqual([]);
    expect(outcome.visibilitySkipped).toEqual(["admin_note"]);
    expect(outcome.clientDerived).toEqual(["region"]);
    expect(outcome.values).toEqual({ name: "N", region: "QC" });
  });

  it("reads a host context that is no object as absent, with a warning", () => {
    for (const bad of ["admin", 5, ["admin"], true]) {
      const outcome = run({ name: "N", region: "QC" }, bad, { logLevel: "warn" });
      expect(codes(outcome.errors), JSON.stringify(bad)).toEqual([]);
      expect(outcome.visibilitySkipped, JSON.stringify(bad)).toEqual(["admin_note"]);
      expect(outcome.logs?.some((entry) => entry.message === "context.hostContext is not an object; treated as absent"), JSON.stringify(bad)).toBe(true);
    }
    // null is no context, said nothing about.
    const none = run({ name: "N" }, null, { logLevel: "warn" });
    expect(none.visibilitySkipped).toEqual(["admin_note"]);
    expect(none.logs ?? []).toEqual([]);
  });
});

describe("the kernel with the server's host context judges host. rules definitively", () => {
  it("an admin must give the admin-only required field", () => {
    const outcome = run({ name: "N" }, { role: "admin" });
    expect(codes(outcome.errors)).toEqual(["admin_note:required"]);
    expect(outcome.visibilitySkipped).toBeUndefined();
  });

  it("a user is not asked for it, and an answer sent for it anyway is left out as hidden", () => {
    const outcome = run({ name: "N", admin_note: "forged" }, { role: "user" });
    expect(codes(outcome.errors)).toEqual([]);
    expect(outcome.visibilitySkipped).toBeUndefined();
    expect(outcome.values).toEqual({ name: "N", region: "none" });
  });

  it("reads a key the context lacks as no answer, never as undecided", () => {
    const outcome = run({ name: "N" }, {});
    expect(codes(outcome.errors)).toEqual([]);
    expect(outcome.visibilitySkipped).toBeUndefined();
    // The calculation is worked out over the missing key, not kept as sent.
    expect(outcome.clientDerived).toBeUndefined();
    expect(outcome.values).toEqual({ name: "N", region: "none" });
  });

  it("enforces a requiredWhen and a validWhen reading host.", () => {
    expect(codes(run({ name: "N" }, { strict: true }).errors)).toEqual(["level:required"]);
    expect(codes(run({ name: "N" }, { strict: false }).errors)).toEqual([]);
    expect(codes(run({ name: "N", code: "A1" }, { code: "B2" }).errors)).toEqual(["code:rule"]);
    expect(codes(run({ name: "N", code: "A1" }, { code: "A1" }).errors)).toEqual([]);
    // Without a context both are skipped, as before.
    expect(codes(run({ name: "N", code: "A1" }).errors)).toEqual([]);
  });

  it("works a calculation out from the context and replaces a forged one", () => {
    const outcome = run({ name: "N", region: "forged" }, { region: "QC" });
    expect(outcome.values).toEqual({ name: "N", region: "QC" });
    expect(outcome.clientDerived).toBeUndefined();
  });

  it("reads nested values by dotted path", () => {
    const nested = root([
      { id: "admin_note", type: "text", configuration: { label: "Admin note", required: true }, rules: { visibleWhen: 'host.user.role = "admin"' } }
    ] as ComponentNode[]);
    const outcome = runKernel({ formId: "host", values: {}, locale: "en", form: nested, hostContext: { user: { role: "admin" } } } as never, []);
    expect(codes(outcome.errors)).toEqual(["admin_note:required"]);
  });
});

describe("the host context crosses the ABI as JSON only", () => {
  it("refuses one JSON would reshape before the run", () => {
    const abi = new JsonWasmAbi();
    const base = { formId: "host", values: {}, locale: "en", form: FORM };
    expect(() => abi.serializeContext({ ...base, hostContext: { role: () => "admin" } } as never, WasmValidationHost.STRICT_POLICY)).toThrow(/host context/);
    expect(() => abi.serializeContext({ ...base, hostContext: { n: Number.NaN } } as never, WasmValidationHost.STRICT_POLICY)).toThrow(/host context/);
    expect(() => abi.serializeContext({ ...base, hostContext: { at: new Date(0) } } as never, WasmValidationHost.STRICT_POLICY)).toThrow(/host context/);
    expect(abi.serializeContext({ ...base, hostContext: { role: "admin" } } as never, WasmValidationHost.STRICT_POLICY)).toContain('"hostContext":{"role":"admin"}');
  });
});

describe("the browser and the server agree once both have the same host context", () => {
  const definition: FormDefinition = { id: "host", version: "1.0.0", schemaVersion: "1.0.0", root: FORM };
  const modes = (): SubmissionModeRegistry => {
    const registry = new SubmissionModeRegistry();
    registry.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    return registry;
  };
  const browser = (hostContext?: Record<string, unknown>): FormRuntime =>
    new FormRuntime(definition, {
      submissionModes: modes(),
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(FORM)]),
      ...(hostContext !== undefined ? { hostContext } : {})
    });

  for (const hostContext of [{ role: "admin" }, { role: "user", region: "ON" }, {}, { strict: true }]) {
    it(`agrees for ${JSON.stringify(hostContext)}`, async () => {
      const runtime = browser(hostContext);
      runtime.setValue("name", "N");
      const result = await runtime.submit("submit", { form: { id: "host", version: "1.0.0" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1.0.0" } });
      const server = run(runtime.formValues(), hostContext);
      expect(codes(server.errors)).toEqual(codes(result.errors));
      if (result.accepted) {
        expect(server.values).toEqual(result.canonicalSubmission!.submission.values);
      }
    });
  }

  it("setHostContext works the form out again in place, the answers staying", () => {
    const runtime = browser({ role: "user" });
    runtime.setValue("name", "N");
    expect(runtime.effectiveState("admin_note")?.visible).toBe(false);
    expect(runtime.formValues()["region"]).toBe("none");
    runtime.setHostContext({ role: "admin", region: "QC" });
    expect(runtime.effectiveState("admin_note")?.visible).toBe(true);
    expect(runtime.formValues()["region"]).toBe("QC");
    expect(runtime.formValues()["name"]).toBe("N");
    expect(runtime.hostContext()).toEqual({ role: "admin", region: "QC" });
    runtime.setHostContext(undefined);
    expect(runtime.effectiveState("admin_note")?.visible).toBe(false);
    expect(runtime.hostContext()).toBeUndefined();
  });
});
