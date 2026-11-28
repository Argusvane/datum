import { describe, expect, it, vi } from "vitest";

import type { AgentProvenance, BeforeSubmitHookContext } from "../form-engine/core/events/hooks.js";
import type { FormDraft } from "../form-engine/persistence/core/draft-store.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { InMemoryDraftStore } from "../form-engine/persistence/local-storage/in-memory-draft-store.js";
import { AGENT_SINGLE_FORM, AGENT_VERSION_CONTEXT, TRAVEL_CLAIM_FORM, agentRuntime, agentSetup, bigForm, personTypes } from "./fixtures/agent-form.js";

/**
 * The renderer catalogue's provenance account: its
 * guarantees through the node host, each a test; the runtime handing the frozen account
 * to both submit hooks and never to the canonical envelope; and the attestation recipe,
 * whose hook refusal the `submit` tool relays with its own hint. The element's half (the
 * flags that survive a detach, `datum-submit.detail.agent`, `datum-pdf`) is covered elsewhere.
 */

type Row = Record<string, unknown>;

const VERSION = { form: { id: "travel-claim", version: "1.0.0" }, client: { runtimeVersion: "t", rendererVersion: "t", schemaVersion: "1.0.0" } };
const FILLED = { traveller: "Ana Lopez", amount: 120 };

/** Every object key anywhere in a value, JSON text included. */
function keysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        keysDeep(JSON.parse(text), into);
      } catch {
        // Not JSON.
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

/** The single form with `other` dropped from the submission while hidden (the hidden-value policy the submittable filter follows). */
function withExcludedOther(): FormDefinition {
  const content = (AGENT_SINGLE_FORM.root.children as { content: ComponentNode[] }).content.map((node) =>
    node.id === "other" ? { ...node, configuration: { ...(node.configuration as Record<string, unknown>), hiddenValueBehavior: "exclude-from-submission" } } : node
  );
  return { ...AGENT_SINGLE_FORM, root: { ...AGENT_SINGLE_FORM.root, children: { content } } };
}

function hookRecorder(): { seen: Array<BeforeSubmitHookContext["agent"]>; hooks: { beforeSubmit: Array<(context: BeforeSubmitHookContext) => void> } } {
  const seen: Array<BeforeSubmitHookContext["agent"]> = [];
  return {
    seen,
    hooks: {
      beforeSubmit: [
        (context) => {
          seen.push(context.agent);
        }
      ]
    }
  };
}

describe("no account where the agent tools were never registered", () => {
  it("a runtime nobody registered submits with no agent in the hooks; a registered one answers involved: false until the agent writes", async () => {
    const recorder = hookRecorder();
    const bare = agentRuntime(TRAVEL_CLAIM_FORM, { hooks: recorder.hooks });
    personTypes(bare, FILLED);
    await bare.submit("embed", VERSION, {});
    expect(recorder.seen).toEqual([undefined]);

    const setup = agentSetup(TRAVEL_CLAIM_FORM);
    personTypes(setup.runtime, FILLED);
    expect(setup.registration.provenance("page")).toEqual({
      version: 1,
      involved: false,
      paths: [],
      tables: [],
      complete: true,
      submittedBy: "page",
      sessions: 0,
      sessionOpen: false
    });
  });
});

describe("involved is sticky", () => {
  it("survives the person overwriting the answer, an accepted submit, a rebuild, a draft restore and the tools leaving", async () => {
    const store = new InMemoryDraftStore();
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store } });
    await setup.ok("set_answers", { answers: { traveller: "Ana Lopez" } });
    const account = (): AgentProvenance => setup.registration.provenance("page") as AgentProvenance;
    expect(account()).toMatchObject({ involved: true, paths: ["traveller"] });
    expect(typeof account().lastWriteAt).toBe("number");
    personTypes(setup.runtime, { traveller: "Ana L.", amount: 5 });
    expect(account()).toMatchObject({ involved: true, paths: [] });
    await setup.runtime.submit("embed", VERSION, {});
    expect(setup.runtime.state().submission.status).toBe("submitted");
    expect(account().involved).toBe(true);
    setup.registration.runtimeReplaced();
    expect(account().involved).toBe(true);
    await store.save({
      id: "claim-ana",
      formId: "travel-claim",
      formVersion: AGENT_VERSION_CONTEXT.formVersion,
      runtime: { schemaVersion: AGENT_VERSION_CONTEXT.schemaVersion, rendererVersion: AGENT_VERSION_CONTEXT.rendererVersion },
      locale: "en",
      values: { traveller: "Bea" },
      state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [] },
      updatedAt: 1
    } satisfies FormDraft);
    await setup.ok("drafts", { action: "restore", replaceAnswers: true });
    expect(account().involved).toBe(true);
    setup.registration.unregister();
    expect(account().involved).toBe(true);
  });

  it("a page move or a language switch alone does not involve the agent (no answer changed)", async () => {
    const setup = agentSetup(TRAVEL_CLAIM_FORM);
    await setup.ok("set_locale", { locale: "fr" });
    expect(setup.registration.provenance("page")?.involved).toBe(false);
  });
});

describe("paths are the agent's last writes among the submitted values", () => {
  it("lists agent-marked submitted keys, cells as paths, tables by collection, sorted; a hidden field is refused by the write guard, so never marked", async () => {
    const setup = agentSetup(TRAVEL_CLAIM_FORM);
    const result = await setup.ok("set_answers", { answers: { traveller: "Ana", amount: 12, items: [{ sku: "taxi", cost: 30 }], case_ref: "C-1" } });
    expect((result.refused as Row[]).map((entry) => [entry.path, (entry.details as Row).reason])).toEqual([["case_ref", "hidden"]]);
    const account = setup.registration.provenance("agent") as AgentProvenance;
    expect(account.paths).toEqual(["amount", "items[0].cost", "items[0].sku", "traveller"]);
    expect(account.tables).toEqual(["items"]);
    expect([...account.paths].sort()).toEqual(account.paths);
  });

  it("a path the hidden-value policy drops from the submission is not listed although the agent wrote it (the submittable filter)", async () => {
    // `other` is excluded from the submission while hidden; the agent reveals it, writes it, and
    // the person hides it again (a same-call reveal is refused, so two calls).
    const setup = agentSetup(withExcludedOther());
    await setup.ok("set_answers", { answers: { has_other: true, name: "Ana" } });
    await setup.ok("set_answers", { answers: { other: "x" } });
    expect(setup.registration.provenance("page")?.paths).toEqual(["has_other", "name", "other"]);
    personTypes(setup.runtime, { has_other: false });
    const submitted = Object.keys(setup.runtime.submittableValues());
    expect(submitted).not.toContain("other");
    const account = setup.registration.provenance("page") as AgentProvenance;
    // `other` is still marked the agent's; only the agent-marked keys among the submitted values are listed.
    expect(account.paths).toEqual(["name"]);
    expect(account.paths).toEqual(["name", "other"].filter((path) => submitted.includes(path)));
  });

  it("a person's later edit takes a path away; a table the person reshaped is no longer the agent's", async () => {
    const setup = agentSetup(TRAVEL_CLAIM_FORM);
    await setup.ok("set_answers", { answers: { traveller: "Ana", items: [{ sku: "taxi" }, { sku: "meal" }] } });
    personTypes(setup.runtime, { traveller: "Ana Lopez" });
    // The person removing a row makes the table theirs: its cells and the table.
    setup.runtime.removeRow("items", 1);
    const account = setup.registration.provenance("page") as AgentProvenance;
    expect(account.paths).toEqual([]);
    expect(account.tables).toEqual([]);
    // A row the person adds leaves the agent's cells the agent's (nobody changed them).
    const added = agentSetup(TRAVEL_CLAIM_FORM);
    await added.ok("set_answers", { answers: { items: [{ sku: "taxi" }] } });
    added.runtime.addRow("items", { sku: "meal" });
    expect(added.registration.provenance("page")).toMatchObject({ paths: ["items[0].sku"], tables: [] });
  });

  it("an agent undo gives each value back to the writer it had (writersBefore), so the person's answer is theirs again", async () => {
    const setup = agentSetup(TRAVEL_CLAIM_FORM);
    personTypes(setup.runtime, { traveller: "Ana" });
    await setup.ok("set_answers", { answers: { traveller: "Bea", amount: 7 } });
    expect(setup.registration.provenance("page")?.paths).toEqual(["amount", "traveller"]);
    await setup.ok("undo_agent_changes");
    expect(setup.runtime.formValues().traveller).toBe("Ana");
    expect(setup.registration.provenance("page")?.paths).toEqual([]);
    const answers = await setup.ok("get_answers");
    expect((answers.answers as Row[]).find((answer) => answer.path === "traveller")).toMatchObject({ value: "Ana", lastWriter: "other" });
  });

  it("more than 2 000 agent paths are cut at 2 000 and marked truncated", async () => {
    const setup = agentSetup(bigForm(2_005));
    for (let start = 0; start < 2_005; start += 200) {
      const answers: Row = {};
      for (let index = start; index < Math.min(start + 200, 2_005); index += 1) {
        answers[`field_${index}`] = "x";
      }
      await setup.ok("set_answers", { answers });
    }
    const account = setup.registration.provenance("agent") as AgentProvenance;
    expect(account.paths).toHaveLength(2_000);
    expect(account.truncated).toBe(true);
  }, 60_000);
});

describe("complete is false once some agent writes cannot be traced", () => {
  it("after a rebuild and after a draft restore when the agent had written; true when it had not", async () => {
    const rebuilt = agentSetup(TRAVEL_CLAIM_FORM);
    await rebuilt.ok("set_answers", { answers: { traveller: "Ana" } });
    rebuilt.registration.runtimeReplaced();
    expect(rebuilt.registration.provenance("page")).toMatchObject({ involved: true, complete: false });

    const restored = agentSetup(TRAVEL_CLAIM_FORM, { drafts: {} });
    await restored.ok("set_answers", { answers: { traveller: "Ana" } });
    await restored.ok("drafts", { action: "save" });
    await restored.ok("drafts", { action: "restore", replaceAnswers: true });
    expect(restored.registration.provenance("page")).toMatchObject({ involved: true, complete: false, paths: [] });

    const clean = agentSetup(TRAVEL_CLAIM_FORM);
    clean.registration.runtimeReplaced();
    expect(clean.registration.provenance("page")).toMatchObject({ involved: false, complete: true });
  });
});

describe("the sessions: who started it, and the sessions seen", () => {
  it("the submit tool hands submittedBy agent; anything else on the page reads page; sessions counts begins, not resumes", async () => {
    const setup = agentSetup(TRAVEL_CLAIM_FORM);
    await setup.ok("begin_session", { purpose: "Filling the claim" });
    await setup.ok("begin_session", { purpose: "Still filling the claim" });
    expect(setup.registration.provenance("page")).toMatchObject({ sessions: 1, sessionOpen: true, submittedBy: "page" });
    await setup.ok("set_answers", { answers: FILLED });
    await setup.ok("end_session", { summary: "Filled the claim" });
    const submit = vi.spyOn(setup.runtime, "submit");
    await setup.ok("submit");
    const options = submit.mock.calls[0]?.[2] as { agent: AgentProvenance };
    expect(Object.keys(options)).toEqual(["agent"]);
    expect(options.agent).toMatchObject({ submittedBy: "agent", involved: true, sessions: 1, sessionOpen: false, complete: true, paths: ["amount", "traveller"] });
  });
});

describe("the runtime's half and the attestation recipe", () => {
  it("the agent's submit hands the hooks a frozen account and the canonical envelope carries none of it", async () => {
    const seen: Array<Readonly<AgentProvenance> | undefined> = [];
    const setup = agentSetup(TRAVEL_CLAIM_FORM, {
      hooks: {
        beforeSubmit: [
          (context) => {
            seen.push(context.agent);
          }
        ],
        afterSubmit: [
          (context) => {
            seen.push(context.agent);
          }
        ]
      }
    });
    await setup.ok("set_answers", { answers: FILLED });
    const submit = vi.spyOn(setup.runtime, "submit");
    const result = await setup.ok("submit");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(seen[0]).toMatchObject({ submittedBy: "agent", paths: ["amount", "traveller"] });
    const outcome = await (submit.mock.results[0]?.value as Promise<Row>);
    const keys = keysDeep(outcome);
    for (const key of ["involved", "paths", "submittedBy", "sessionOpen"]) {
      expect(keys.has(key), key).toBe(false);
    }
    expect(keysDeep(result).has("involved")).toBe(false);
  });

  it("a hook that refuses an agent-written declaration makes the submit tool relay the site's words to the person", async () => {
    const setup = agentSetup(TRAVEL_CLAIM_FORM, {
      hooks: {
        beforeSubmit: [
          (context) => {
            if (context.agent?.paths.includes("declaration") === true) {
              throw new Error("Please tick the declaration yourself.");
            }
          }
        ]
      }
    });
    await setup.ok("set_answers", { answers: { ...FILLED, declaration: true } });
    const refused = await setup.refused("submit");
    expect(refused).toMatchObject({
      code: "rejected",
      hint: "The site refused the submission with the message in details.errors; tell the person what it says and let them act. Do not change answers to get past it unless the person asks.",
      details: { refusedBy: "host", errors: [{ code: "hook", message: "Please tick the declaration yourself." }] }
    });
    // The refusal settled the submission back to idle, so nothing
    // is left in flight.
    expect(setup.runtime.state().submission.status).toBe("idle");
    // The person ticks it themselves: the declaration is theirs, and a submit through the tool
    // goes through (it no longer answers busy after the hook's refusal).
    personTypes(setup.runtime, { declaration: false });
    personTypes(setup.runtime, { declaration: true });
    const account = setup.registration.provenance("page") as AgentProvenance;
    expect(account.paths).not.toContain("declaration");
    const accepted = await setup.ok("submit");
    expect(accepted.status).toBe("accepted");
    expect(setup.runtime.state().submission.status).toBe("submitted");
  });
});
