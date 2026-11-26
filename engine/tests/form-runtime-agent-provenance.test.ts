import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { AgentProvenance, AfterSubmitHookContext, BeforeDraftSaveHookContext, BeforeSubmitHookContext } from "../form-engine/core/events/hooks.js";
import type { FormEvent } from "../form-engine/core/events/event-bus.js";
import type { SigningProvider, SigningRequest } from "../form-engine/core/submission/signing.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { SubmissionHandlerRegistry } from "../form-engine/registry/submission/submission-handler-registry.js";
import { InMemoryDraftStore } from "../form-engine/persistence/local-storage/in-memory-draft-store.js";
import type { FormDraft } from "../form-engine/persistence/core/draft-store.js";

/*
 * The runtime's half of agent provenance: `submit(…, { agent })`
 * puts one frozen deep copy into the `beforeSubmit` and `afterSubmit` hook contexts and nowhere
 * else — not the canonical envelope, the signing request, the value transforms, a submission
 * handler, the runtime's events or a draft. Without `agent` the contexts carry no such key.
 */

const PROVENANCE_KEYS = ["agent", "involved", "paths", "submittedBy", "sessionOpen", "lastWriteAt"];

/** Every object key anywhere in a value, JSON text included (the signed canonical is a string). */
function keysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        keysDeep(JSON.parse(text), into);
      } catch {
        // Not JSON: no keys.
      }
    }
    return into;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => keysDeep(item, into));
    return into;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      keysDeep(item, into);
    }
  }
  return into;
}

function expectNoProvenance(value: unknown, where: string): void {
  const keys = keysDeep(value);
  for (const key of PROVENANCE_KEYS) {
    expect(keys.has(key), `${where} carries "${key}"`).toBe(false);
  }
  // The marker path below is a key the form does not have, so it can only come from the provenance.
  expect(JSON.stringify(value) ?? "", where).not.toContain("agent-only-marker");
}

function form(): FormDefinition {
  return {
    id: "f1",
    version: "2",
    schemaVersion: "1",
    localization: { defaultLocale: "en" },
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "declaration", type: "checkbox", configuration: { label: "I declare" } }
        ]
      }
    }
  } as FormDefinition;
}

const clientCtx = () => ({
  form: { id: "f1", version: "2" },
  client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" }
});

function provenance(): AgentProvenance {
  return {
    version: 1,
    involved: true,
    paths: ["agent-only-marker", "name"],
    tables: ["items"],
    complete: true,
    submittedBy: "agent",
    sessions: 2,
    sessionOpen: true,
    lastWriteAt: 1_700_000_000_000
  };
}

/** A runtime with every place a submission's data goes recorded. */
function recorded(extra: Partial<FormRuntimeDependencies> = {}) {
  const seen = {
    before: [] as BeforeSubmitHookContext[],
    after: [] as AfterSubmitHookContext[],
    transformInputs: [] as unknown[],
    signingRequests: [] as SigningRequest[],
    handled: [] as unknown[],
    events: [] as FormEvent[],
    draftSaveContexts: [] as BeforeDraftSaveHookContext[],
    savedDrafts: [] as FormDraft[],
    pushRefused: [] as boolean[]
  };
  const signer: SigningProvider = {
    id: "stub",
    sign: async (request) => {
      seen.signingRequests.push(structuredClone(request));
      return [{ signature: "sig", algorithm: "stub-256", signedAt: 0, participantId: "applicant" }];
    }
  };
  const handlers = new SubmissionHandlerRegistry();
  handlers.register({
    id: "deliver",
    version: "1.0.0",
    handle: (submission, context) => {
      seen.handled.push(structuredClone({ submission, context }));
    }
  });
  class RecordingStore extends InMemoryDraftStore {
    public override async save(draft: FormDraft): Promise<void> {
      seen.savedDrafts.push(structuredClone(draft));
      await super.save(draft);
    }
  }
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "plain", validate: true, sign: false, serverValidation: false });
  modes.register({ id: "signed", validate: true, sign: true, serverValidation: false });
  const runtime = new FormRuntime(form(), {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([]),
    signingProvider: signer,
    submissionHandlerRegistry: handlers,
    draftStore: new RecordingStore(),
    versionContext: { formVersion: "2", schemaVersion: "1", rendererVersion: "1.0.0" },
    hooks: {
      beforeSubmit: [
        (context) => {
          seen.before.push(context);
          // A hook cannot change what the next hook (or afterSubmit) reads.
          if (context.agent) {
            let refused = false;
            try {
              (context.agent.paths as string[]).push("smuggled");
            } catch (error) {
              refused = error instanceof TypeError;
            }
            seen.pushRefused.push(refused);
          }
        },
        (context) => {
          seen.before.push(context);
        }
      ],
      afterSubmit: [(context) => void seen.after.push(context)],
      transformValues: [
        (values) => {
          seen.transformInputs.push(structuredClone(values));
          return values;
        }
      ],
      beforeDraftSave: [(context) => void seen.draftSaveContexts.push(context)]
    },
    ...extra
  });
  runtime.events().subscribe("*", (event) => seen.events.push(event));
  return { runtime, seen };
}

describe("FormRuntime.submit with agent provenance", () => {
  it("puts one frozen deep copy into both hook contexts", async () => {
    const { runtime, seen } = recorded();
    runtime.setValue("name", "Ada");
    const agent = provenance();

    const result = await runtime.submit("signed", clientCtx(), { agent });

    expect(result.accepted).toBe(true);
    expect(seen.before).toHaveLength(2);
    expect(seen.after).toHaveLength(1);
    const before = seen.before[0]!.agent;
    expect(before).toEqual(provenance());
    // A copy, not the caller's object; the same copy for every hook and for afterSubmit.
    expect(before).not.toBe(agent);
    expect(seen.before[1]!.agent).toBe(before);
    expect(seen.after[0]!.agent).toBe(before);
    // Frozen, lists included: the first hook's push was refused and the second hook read the original list.
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before!.paths)).toBe(true);
    expect(Object.isFrozen(before!.tables)).toBe(true);
    expect(seen.pushRefused).toEqual([true]);
    expect(seen.before[1]!.agent!.paths).toEqual(["agent-only-marker", "name"]);
    // The contexts' `agent` is itself fixed, not only the object it holds.
    for (const context of [seen.before[0]!, seen.after[0]!]) {
      expect(Object.getOwnPropertyDescriptor(context, "agent")).toMatchObject({ enumerable: true, writable: false, configurable: false });
    }

    // The caller changing its own object after the call changes neither context.
    agent.paths.push("later");
    agent.involved = false;
    agent.tables.length = 0;
    expect(seen.after[0]!.agent).toEqual(provenance());
  });

  it("puts it nowhere else: not the submit result, the signing request, the transforms, a handler or an event", async () => {
    const { runtime, seen } = recorded();
    runtime.setValue("name", "Ada");

    const result = await runtime.submit("signed", clientCtx(), { agent: provenance() });

    expect(result.accepted).toBe(true);
    expect(seen.signingRequests).toHaveLength(1);
    expect(seen.handled).toHaveLength(1);
    expect(seen.transformInputs).toHaveLength(1);
    // The whole result, not only its envelope and signatures: it is what a host posts.
    expect(result.canonicalSubmission).toBeDefined();
    expect(result.signatures).toHaveLength(1);
    expectNoProvenance(result, "the submit result");
    expectNoProvenance(seen.signingRequests, "the signing request");
    expectNoProvenance(seen.transformInputs, "the transformValues input");
    expectNoProvenance(seen.handled, "the submission handler's submission and context");
    expectNoProvenance(seen.events.map((event) => event.data), "the runtime's events");
    // The hook contexts' values are the form's values, untouched by it.
    expect(seen.before[0]!.values).toEqual({ name: "Ada" });
    expectNoProvenance(seen.before[0]!.values, "the hook context's values");
  });

  it("puts it nowhere in the wrapper placement's signed document either", async () => {
    const { runtime, seen } = recorded({ signing: { placement: "wrapper" } });
    runtime.setValue("name", "Ada");

    const result = await runtime.submit("signed", clientCtx(), { agent: provenance() });

    expect(result.accepted).toBe(true);
    // The hooks had it, so its absence below is the runtime's doing.
    expect(seen.before[0]!.agent?.paths).toContain("agent-only-marker");
    // The document a host delivers under this placement: the envelope with the signatures beside it.
    expect(result.signed?.format.placement).toBe("wrapper");
    expect(result.signed?.signatures).toHaveLength(1);
    expectNoProvenance(result.signed, "the signed wrapper document");
    expectNoProvenance(result, "the wrapper submit result");
    expectNoProvenance(seen.signingRequests, "the wrapper signing request");
    expectNoProvenance(seen.handled, "the wrapper submission handler's submission and context");
  });

  it("a hook can neither delete nor replace context.agent: the attestation hook after it still refuses", async () => {
    const tries: Array<{ deleteRefused: boolean; replaceRefused: boolean }> = [];
    const refused = (attempt: () => void): boolean => {
      try {
        attempt();
        return false;
      } catch (error) {
        return error instanceof TypeError;
      }
    };
    const attest = recorded({
      hooks: {
        beforeSubmit: [
          (context) => {
            tries.push({
              deleteRefused: refused(() => {
                delete context.agent;
              }),
              replaceRefused: refused(() => {
                context.agent = { ...context.agent!, paths: [] };
              })
            });
          },
          // The attestation recipe.
          (context) => {
            if (context.agent?.paths.includes("declaration")) {
              throw new Error("Please tick the declaration yourself.");
            }
          }
        ]
      }
    });
    attest.runtime.setValue("declaration", true);

    await expect(
      attest.runtime.submit("plain", clientCtx(), { agent: { ...provenance(), paths: ["declaration"] } })
    ).rejects.toThrow("Please tick the declaration yourself.");
    expect(tries).toEqual([{ deleteRefused: true, replaceRefused: true }]);
    // The throw settles the submission back to idle before it reaches the caller.
    expect(attest.runtime.state().submission.status).toBe("idle");
  });

  it("a provenance that cannot be copied rejects before the submission begins", async () => {
    const { runtime, seen } = recorded();
    runtime.setValue("name", "Ada");
    // A function is not structured-cloneable: the copy throws a DataCloneError.
    const uncopyable = Object.assign(provenance(), { toJSON: () => ({}) });

    await expect(runtime.submit("plain", clientCtx(), { agent: uncopyable })).rejects.toThrow();

    // The form is not left mid-submission: nothing began, nothing was announced, no hook ran.
    expect(runtime.state().submission).toMatchObject({ status: "idle", attempts: 0 });
    expect(seen.events.filter((event) => event.id === "submission_started")).toEqual([]);
    expect(seen.before).toEqual([]);
    // And the next submit goes through.
    const next = await runtime.submit("plain", clientCtx(), { agent: provenance() });
    expect(next.accepted).toBe(true);
    expect(runtime.state().submission.status).toBe("submitted");
    expect(seen.events.filter((event) => event.id === "submission_started")).toHaveLength(1);
  });

  it("an unsigned submit and a refused one carry it in the hooks they reach", async () => {
    const { runtime, seen } = recorded();
    runtime.setValue("name", "Ada");
    const plain = await runtime.submit("plain", clientCtx(), { agent: { ...provenance(), submittedBy: "page" } });
    expect(plain.accepted).toBe(true);
    expect(seen.before[0]!.agent?.submittedBy).toBe("page");
    expect(seen.after[0]!.agent?.submittedBy).toBe("page");
    expectNoProvenance(plain.canonicalSubmission, "the unsigned canonical submission");

    // A beforeSubmit hook refusing (the attestation recipe) sees it and stops the submit.
    const attest = recorded({
      hooks: {
        beforeSubmit: [
          (context) => {
            if (context.agent?.paths.includes("declaration")) {
              throw new Error("Please tick the declaration yourself.");
            }
          }
        ]
      }
    });
    attest.runtime.setValue("declaration", true);
    await expect(
      attest.runtime.submit("plain", clientCtx(), { agent: { ...provenance(), paths: ["declaration"] } })
    ).rejects.toThrow("Please tick the declaration yourself.");
    // Back to idle, the attempt counted, not left submitting.
    expect(attest.runtime.state().submission).toMatchObject({ status: "idle", attempts: 1 });
  });

  it("a transformValues that throws settles back to idle and rethrows the same error", async () => {
    // The guards cover both throw sources; this pins the transforms' half and that the caller
    // receives the transform's own error object, not a wrapper.
    const err = new Error("transform broke");
    const { runtime, seen } = recorded({
      hooks: {
        transformValues: [
          () => {
            throw err;
          }
        ]
      }
    });
    runtime.setValue("name", "Ada");

    const thrown = await runtime.submit("plain", clientCtx(), { agent: provenance() }).catch((error: unknown) => error);

    expect(thrown).toBe(err);
    expect(runtime.state().submission).toMatchObject({ status: "idle", attempts: 1 });
    const failed = seen.events.filter((event) => event.id === "submission_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toEqual({ modeId: "plain", stage: "host" });
  });

  it("without agent, neither context has the key", async () => {
    const { runtime, seen } = recorded();
    runtime.setValue("name", "Ada");

    const result = await runtime.submit("signed", clientCtx());

    expect(result.accepted).toBe(true);
    expect(seen.before).toHaveLength(2);
    for (const context of [...seen.before, ...seen.after]) {
      expect("agent" in context).toBe(false);
    }
    expect(Object.keys(seen.after[0]!).sort()).toEqual(["modeId", "submissionId", "values"]);
  });

  it("a draft saved after an agent submit carries none of it (no provenance for drafts)", async () => {
    const { runtime, seen } = recorded();
    runtime.setValue("name", "Ada");
    await runtime.submit("plain", clientCtx(), { agent: provenance() });

    await runtime.saveDraft("draft-1");

    expect(seen.draftSaveContexts).toHaveLength(1);
    expect("agent" in seen.draftSaveContexts[0]!).toBe(false);
    expect(Object.keys(seen.draftSaveContexts[0]!).sort()).toEqual(["draftId", "values"]);
    expect(seen.savedDrafts).toHaveLength(1);
    expectNoProvenance(seen.savedDrafts[0], "the record the draft store received");
    expect(seen.savedDrafts[0]!.values).toEqual({ name: "Ada" });
  });
});
