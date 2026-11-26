import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { SubmissionVersionContext } from "../form-engine/core/submission/canonical-submission.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { SubmissionHandlerRegistry } from "../form-engine/registry/submission/submission-handler-registry.js";

/*
 * submitWaitsOnHost() is what a caller that joins submits at its own level (the <datum-form>
 * element) reads before joining: true only while the submission in flight waits on one of the
 * host's hooks, which may be the caller. Delivery is not a hook: a second click while the
 * handlers post still joins.
 */

type Hooks = NonNullable<FormRuntimeDependencies["hooks"]>;

const VERSION: SubmissionVersionContext = {
  form: { id: "f", version: "1.0.0" },
  client: { runtimeVersion: "test", rendererVersion: "test", schemaVersion: "1.0.0" }
};

function build(deps: Partial<FormRuntimeDependencies> = {}): FormRuntime {
  const form = {
    id: "f",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] }
    }
  } as unknown as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
    journeyEngine: EagerJourneyEngine,
    wasmValidationHost: createInProcessWasmValidationHost([]),
    ...deps
  } as FormRuntimeDependencies);
  runtime.setValue("name", "Ada");
  return runtime;
}

describe("FormRuntime.submitWaitsOnHost()", () => {
  for (const hook of ["beforeSubmit", "transformValues", "beforeValidation", "afterValidation", "afterSubmit"] as const) {
    it(`is true while a submission waits on a ${hook} hook, and false before and after`, async () => {
      let runtime!: FormRuntime;
      const seen: boolean[] = [];
      const call = async (values?: unknown): Promise<unknown> => {
        seen.push(runtime.submitWaitsOnHost());
        return values;
      };
      runtime = build({ hooks: { [hook]: [call] } as unknown as Hooks });
      expect(runtime.submitWaitsOnHost()).toBe(false);
      const result = await runtime.submit("submit", VERSION);
      expect(result.accepted).toBe(true);
      expect(seen).toEqual([true]);
      expect(runtime.submitWaitsOnHost()).toBe(false);
    });
  }

  it("is false while a hook runs outside a submission (a page's own validate)", async () => {
    let runtime!: FormRuntime;
    const seen: boolean[] = [];
    runtime = build({ hooks: { beforeValidation: [async () => void seen.push(runtime.submitWaitsOnHost())] } as Hooks });
    await runtime.validate();
    expect(seen).toEqual([false]);
  });

  it("is false while the submission's handlers deliver it, where a double click joins", async () => {
    let runtime!: FormRuntime;
    const seen: boolean[] = [];
    const handlers = new SubmissionHandlerRegistry();
    handlers.register({
      id: "watch",
      version: "1.0.0",
      handle: async () => {
        seen.push(runtime.submitWaitsOnHost());
      }
    } as Parameters<SubmissionHandlerRegistry["register"]>[0]);
    runtime = build({ submissionHandlerRegistry: handlers });
    expect((await runtime.submit("submit", VERSION)).accepted).toBe(true);
    expect(seen).toEqual([false]);
  });

  it("is false while a page's own validate() runs during delivery, where a double click joins", async () => {
    let openDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => (openDelivery = resolve));
    let delivering!: () => void;
    const inDelivery = new Promise<void>((resolve) => (delivering = resolve));
    let openHook!: () => void;
    const hookGate = new Promise<void>((resolve) => (openHook = resolve));
    let gateHook = false;
    const handlers = new SubmissionHandlerRegistry();
    handlers.register({
      id: "post",
      version: "1.0.0",
      handle: async () => {
        delivering();
        await delivery;
      }
    } as Parameters<SubmissionHandlerRegistry["register"]>[0]);
    const runtime = build({
      submissionHandlerRegistry: handlers,
      hooks: {
        beforeValidation: [
          async () => {
            if (gateHook) {
              await hookGate;
            }
          }
        ]
      } as Hooks
    });

    const first = runtime.submit("submit", VERSION);
    await inDelivery;
    expect(runtime.submitWaitsOnHost()).toBe(false);
    // The page (or an agent tool) validates meanwhile, with a slow hook.
    gateHook = true;
    const pageValidate = runtime.validate();
    await Promise.resolve();
    const waits = runtime.submitWaitsOnHost();
    // A second click on the same submit during delivery.
    const second = runtime.submit("submit", VERSION).then(
      () => "joined",
      (error: unknown) => (error as Error).name
    );
    openHook();
    openDelivery();
    await pageValidate;
    await first;
    expect(waits).toBe(false);
    expect(await second).toBe("joined");
  });

  it("is false for the next submission when a page's validate() outlived the last one", async () => {
    let openHook!: () => void;
    const hookGate = new Promise<void>((resolve) => (openHook = resolve));
    let gateHook = false;
    let runtime!: FormRuntime;
    const seen: boolean[] = [];
    const handlers = new SubmissionHandlerRegistry();
    let delivered = 0;
    handlers.register({
      id: "post",
      version: "1.0.0",
      handle: async () => {
        delivered += 1;
        if (delivered === 1) {
          // The page validates while the first submission delivers, and its hook is slow.
          gateHook = true;
          void runtime.validate();
          await Promise.resolve();
          gateHook = false;
        } else {
          seen.push(runtime.submitWaitsOnHost());
        }
      }
    } as Parameters<SubmissionHandlerRegistry["register"]>[0]);
    runtime = build({
      submissionHandlerRegistry: handlers,
      hooks: {
        beforeValidation: [
          async () => {
            if (gateHook) {
              await hookGate;
            }
          }
        ]
      } as Hooks
    });

    expect((await runtime.submit("submit", VERSION)).accepted).toBe(true);
    // The page's validate is still waiting on its hook: nothing of a submission is.
    expect(runtime.submitWaitsOnHost()).toBe(false);
    expect((await runtime.submit("submit", VERSION)).accepted).toBe(true);
    expect(seen).toEqual([false]);
    openHook();
  });

  it("is back to false when a hook throws", async () => {
    const runtime = build({
      hooks: {
        beforeSubmit: [
          async () => {
            throw new Error("no");
          }
        ]
      } as Hooks
    });
    await expect(runtime.submit("submit", VERSION)).rejects.toThrow("no");
    expect(runtime.submitWaitsOnHost()).toBe(false);
  });
});
