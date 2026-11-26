import { describe, expect, it, vi } from "vitest";

// Passthrough spies: the service's own calls are counted; the kernel's calls inside runKernel are
// module-internal and are not.
vi.mock("@argusvane/datum-engine", async (original) => {
  const engine = await original<typeof import("@argusvane/datum-engine")>();
  return {
    ...engine,
    kernelPartitionValues: vi.fn(engine.kernelPartitionValues),
    kernelFoldSubmission: vi.fn(engine.kernelFoldSubmission)
  };
});

import {
  ServerValidationRunner,
  kernelFoldSubmission,
  kernelPartitionValues,
  type Expression,
  type FormDefinition,
  type ServerValidationContext
} from "@argusvane/datum-engine";

import { InMemorySubmissionStore, createKernelValidator, createSubmissionService, type SubmissionValidator } from "../src/index.js";

/**
 * The outcome keys (`reportFold`): `withheld`, `effectiveState`, `submittable` and `trace` are
 * what the sandbox's fold settled, so the service partitions and folds nothing again. An
 * outcome without them is one whose fold did not run: nothing is judged and nothing withheld.
 */

const eq = (path: string, value: string): Expression => ({
  kind: "binary",
  operator: "eq",
  left: { kind: "path", path },
  right: { kind: "literal", value }
});

const FORM: FormDefinition = {
  id: "keys",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "a", type: "text", configuration: {} },
        { id: "hid", type: "text", configuration: { required: true, hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: eq("a", "show") } },
        { id: "wiped", type: "text", configuration: { hiddenValueBehavior: "clear" }, rules: { visibleWhen: eq("a", "show") } },
        { id: "must", type: "text", configuration: { required: true } }
      ]
    }
  },
  journey: { journeys: [{ id: "j", pages: [{ id: "p1", components: ["a", "hid", "wiped", "must"], routes: [{ to: "$end" }] }] }] }
};

async function make(validator: SubmissionValidator, hook: (context: ServerValidationContext) => ServerValidationContext extends never ? never : Array<Record<string, unknown>>) {
  const handed: Array<Record<string, unknown>> = [];
  const service = createSubmissionService({
    store: new InMemorySubmissionStore(),
    validator,
    ids: () => "r1",
    serverValidationRunner: new ServerValidationRunner([
      {
        id: "hook",
        version: "1.0.0",
        async validate(context: ServerValidationContext) {
          handed.push({ ...context.values });
          return { errors: hook(context) as never };
        }
      }
    ])
  });
  await service.register(FORM);
  return { service, handed };
}

const input = (values: Record<string, unknown>) => ({ formId: "keys", formVersion: "1.0.0", values, locale: "en", journeyId: "j" });
const hookErrors = () => [
  { code: "hook.hidden", componentId: "hid", stage: "hook", source: "server" },
  { code: "hook.required", componentId: "hid", stage: "hook", source: "server" },
  { code: "hook.a", componentId: "a", stage: "hook", source: "server" }
];

describe("the outcome keys are the service's fold", () => {
  it("lists the withheld key and runs no second partition or fold, with the hook and the trace asked for", async () => {
    const { service } = await make(createKernelValidator(), hookErrors);
    vi.mocked(kernelPartitionValues).mockClear();
    vi.mocked(kernelFoldSubmission).mockClear();
    const result = await service.receive({ ...input({ a: "hide", hid: "secret", must: "x", stray: 1 }), submissionKey: crypto.randomUUID() });
    // The hook's errors on the hidden component are dropped by the outcome's effectiveState; the one on `a` stands.
    expect(result.record.errors.map((error) => error.code)).toEqual(["hook.a"]);
    expect(result.record.values).toEqual({ a: "hide", must: "x" });
    await service.validate({ ...input({ a: "hide", hid: "secret", must: "x" }), scope: "journey" });
    // The blocked run too: its judged values come in the outcome.
    await service.receive({ ...input({ a: "hide", hid: "secret" }), submissionKey: crypto.randomUUID() });
    expect(kernelPartitionValues).not.toHaveBeenCalled();
    expect(kernelFoldSubmission).not.toHaveBeenCalled();
  });

  it("answers an outcome whose fold did not run (a refused definition) with nothing judged and nothing withheld", async () => {
    const current = createKernelValidator();
    const refusing: SubmissionValidator = {
      id: "refusing",
      async validate(context) {
        // The document is named as the kernel names it; the fold's keys and the values are absent.
        const { digest, canonical } = (await current.validate(context)) as { digest?: string; canonical?: string };
        return { errors: [{ code: "definition.refused", stage: "definition", source: "wasm" }], digest, canonical } as never;
      }
    };
    const { service, handed } = await make(refusing, hookErrors);
    const result = await service.receive({ ...input({ a: "hide", hid: "secret", must: "x" }), submissionKey: crypto.randomUUID() });
    expect(result.record.status).toBe("rejected");
    expect(result.record.errors.map((error) => error.code)).toEqual(["definition.refused"]);
    expect(result.record.values ?? {}).toEqual({});
    expect((result.record.logs ?? []).map((entry) => entry.message)).not.toContainEqual(expect.stringMatching(/^values\.withheld/));
    // The verdict blocks, so the hook never runs.
    expect(handed).toEqual([]);
  });
});
