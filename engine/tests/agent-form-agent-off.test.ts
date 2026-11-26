import { describe, expect, it, vi } from "vitest";

import { createFormAgentTools } from "../form-engine/agent/form/tools.js";
import { runtimeAgentHost, type FormAgentHost } from "../form-engine/agent/form/host.js";
import { createAgentRegistrar, type AgentActionDetail } from "../form-engine/agent/registrar.js";
import type { AgentCatalogue, AgentRefusal } from "../form-engine/agent/tool-types.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import {
  AGENT_JOURNEY_FORM,
  AGENT_PARTICIPANTS_FORM,
  AGENT_SIGNING_BUTTON_FORM,
  AGENT_SINGLE_FORM,
  AGENT_STEPS_FORM,
  TRAVEL_CLAIM_FORM,
  TRAVEL_CLAIM_LAYOUTS,
  agentRuntime,
  agentSetup
} from "./fixtures/agent-form.js";

/**
 * The host and author switches over the renderer catalogue: the node host with `agentAccess: "definition"` reads the
 * root's `agentTools`; a sealed form answers the minimal `describe_form` and `agent-off { by }`
 * for everything else, the session pair included, with nothing read and nothing written; the
 * node host's default (`"always"`) keeps every fixture live. The element half (the attribute,
 * `datum-agent-tools.access`) is tested in the packages/datum package.
 */

type Row = Record<string, unknown>;

const AUTHOR_MESSAGE = "This form does not accept assistants: its author turned them off.";
const UNSET_MESSAGE =
  "This form does not accept assistants: this site lets them fill only forms whose author allowed it, and this form's author has not.";
const HINT = "Tell the person this form has to be filled in by them; do not fill it in any other way.";
const AUTHOR_GUIDANCE =
  "This form asks to be filled in by the person, not by an assistant: its author turned assistants off. Do not fill it or type into it for them; tell them it is theirs to complete.";
const UNSET_GUIDANCE =
  "This form asks to be filled in by the person: this site lets assistants fill only forms whose author allowed it, and this form's author has not. Do not fill it or type into it for them; tell them it is theirs to complete.";

/** The definition with the author's switch set to `value` (the key left out for `undefined`). */
function withAgentTools(definition: FormDefinition, value: unknown): FormDefinition {
  const configuration = { ...(definition.root.configuration as Row) };
  delete configuration.agentTools;
  if (value !== undefined) {
    configuration.agentTools = value;
  }
  return { ...definition, root: { ...definition.root, configuration } } as FormDefinition;
}

/** Every catalogue tool but describe_form, and the session pair, each with an input that would pass its schema. */
const OTHER_CALLS: Array<[string, Row]> = [
  ["get_answers", {}],
  ["get_options", { field: "items" }],
  ["check", {}],
  ["set_answers", { answers: { traveller: "Ana Silva" } }],
  ["edit_rows", { collection: "items", action: "add", rows: [{ sku: "Taxi" }] }],
  ["navigate", { to: "next" }],
  ["set_locale", { locale: "fr" }],
  ["submit", {}],
  ["undo_agent_changes", {}],
  ["drafts", { action: "save" }],
  ["download_pdf", {}],
  ["begin_session", { purpose: "Fill the claim" }],
  ["end_session", {}]
];

/**
 * A registration over the real catalogue whose tool bodies are counted, beside spies on the
 * host members the render-output memo is built from (`renderOptions`, `journeyKit`): a refused
 * call must run no body and build no memo.
 */
function countedSetup(definition: FormDefinition) {
  const runtime = agentRuntime(definition);
  const host = runtimeAgentHost(runtime, { journeyKit: EagerJourneyRenderKit, agentAccess: "definition", pdf: { layouts: TRAVEL_CLAIM_LAYOUTS } });
  const renderOptions = vi.spyOn(host, "renderOptions");
  const journeyKit = vi.spyOn(host, "journeyKit");
  const ran: string[] = [];
  const factory = (seam: FormAgentHost): AgentCatalogue<FormAgentHost> => {
    const catalogue = createFormAgentTools(seam);
    return {
      ...catalogue,
      tools: catalogue.tools.map((tool) => ({
        ...tool,
        execute: (input: Record<string, unknown>, ctx: Parameters<typeof tool.execute>[1]) => {
          ran.push(tool.name);
          return tool.execute(input, ctx);
        }
      }))
    };
  };
  const registrar = createAgentRegistrar();
  const registration = registrar.registerForm({ host, catalogue: factory, signal: new AbortController().signal });
  const actions: AgentActionDetail[] = [];
  registrar.subscribe((event) => {
    if (event.type === "action") {
      actions.push(event.detail);
    }
  });
  return { runtime, host, registrar, registration, ran, renderOptions, journeyKit, actions };
}

describe("a sealed form (agent-access definition)", () => {
  it("agentTools off: the minimal describe_form, agent-off { by: author } for every other tool and the session pair, no body run and no memo built", async () => {
    const setup = countedSetup(withAgentTools(TRAVEL_CLAIM_FORM, "off"));
    const described = (await setup.registrar.execute("describe_form", {})) as unknown as Row;
    expect(described).toEqual({
      ok: true,
      tool: "describe_form",
      form: "form-1",
      revision: 1,
      toolset: "datum-form/1",
      title: "Agent travel-claim",
      locale: "en",
      agentAccess: "off",
      guidance: [AUTHOR_GUIDANCE]
    });
    expect(setup.ran).toEqual(["describe_form"]);
    for (const [name, input] of OTHER_CALLS) {
      const result = (await setup.registrar.execute(name, input)) as AgentRefusal;
      expect(result, name).toEqual({
        ok: false,
        tool: name,
        form: "form-1",
        revision: 1,
        code: "agent-off",
        retryable: false,
        message: AUTHOR_MESSAGE,
        hint: HINT,
        details: { by: "author" }
      });
    }
    // Only describe_form's own body ran, and it built no render-output memo.
    expect(setup.ran).toEqual(["describe_form"]);
    expect(setup.renderOptions).not.toHaveBeenCalled();
    expect(setup.journeyKit).not.toHaveBeenCalled();
    expect(setup.registration.access()).toEqual({ state: "sealed", by: "author" });
    // Every refusal is reported as a datum-agent-action, through the catalogue and to subscribers.
    expect(setup.actions.map((detail) => [detail.tool, detail.outcome])).toEqual([
      ["describe_form", { ok: true }],
      ...OTHER_CALLS.map(([name]) => [name, { ok: false, code: "agent-off" }])
    ]);
    const emitted = setup.host.calls.filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action");
    expect(emitted).toHaveLength(1 + OTHER_CALLS.length);
    // No session ever began: no banner, no inert.
    expect(setup.host.calls.filter((call) => call.method === "setSessionUi")).toEqual([]);
  });

  it("agentTools absent: the same with by unset and the unset texts", async () => {
    const setup = countedSetup(withAgentTools(TRAVEL_CLAIM_FORM, undefined));
    const described = (await setup.registrar.execute("describe_form", {})) as unknown as Row;
    expect(described).toMatchObject({ ok: true, agentAccess: "off", guidance: [UNSET_GUIDANCE] });
    expect(Object.keys(described).sort()).toEqual(["agentAccess", "form", "guidance", "locale", "ok", "revision", "title", "tool", "toolset"]);
    for (const [name, input] of OTHER_CALLS) {
      expect(await setup.registrar.execute(name, input), name).toMatchObject({
        ok: false,
        code: "agent-off",
        retryable: false,
        message: UNSET_MESSAGE,
        hint: HINT,
        details: { by: "unset" }
      });
    }
    expect(setup.ran).toEqual(["describe_form"]);
    expect(setup.renderOptions).not.toHaveBeenCalled();
  });

  it("reads an unknown word (maybe, true, Off) as not provided: sealed unset", async () => {
    for (const value of ["maybe", true, "Off"]) {
      const setup = agentSetup(withAgentTools(TRAVEL_CLAIM_FORM, value), { agentAccess: "definition" });
      expect(setup.registration.access(), String(value)).toEqual({ state: "sealed", by: "unset" });
      expect((await setup.refused("set_answers", { answers: { traveller: "Ana" } })).details).toEqual({ by: "unset" });
    }
  });

  it("the sealed describe_form keeps the title in the form's locale and the definition's id without a label", async () => {
    const labelled = withAgentTools(TRAVEL_CLAIM_FORM, "off");
    const french = {
      ...labelled,
      root: { ...labelled.root, configuration: { ...(labelled.root.configuration as Row), label: "Travel claim" } },
      // The French is the definition's map: the form's own `label` lives under `form`.
      translations: { fr: { form: { label: { text: "Note de frais", source: sourceHash("Travel claim") } } } }
    } as FormDefinition;
    const setup = agentSetup(french, { agentAccess: "definition" });
    setup.runtime.setLocale("fr");
    expect(await setup.ok("describe_form")).toMatchObject({ title: "Note de frais", locale: "fr", agentAccess: "off" });
    const unlabelled = withAgentTools(TRAVEL_CLAIM_FORM, "off");
    delete (unlabelled.root.configuration as Row).label;
    expect(await agentSetup(unlabelled, { agentAccess: "definition" }).ok("describe_form")).toMatchObject({ title: "travel-claim" });
  });
});

describe("a live form", () => {
  it("agentTools allowed under definition: live, describe_form says agentAccess on, writes run", async () => {
    const setup = agentSetup(withAgentTools(TRAVEL_CLAIM_FORM, "allowed"), { agentAccess: "definition" });
    expect(setup.registration.access()).toEqual({ state: "live" });
    const described = await setup.ok("describe_form");
    expect(described.agentAccess).toBe("on");
    expect(described.fields).toBeDefined();
    expect((await setup.ok("set_answers", { answers: { traveller: "Ana Silva" } })).written).toBeDefined();
    expect(setup.runtime.formValues().traveller).toBe("Ana Silva");
  });

  it("agent-access always with agentTools off: live (the host enforces over the author's off)", async () => {
    const setup = agentSetup(withAgentTools(TRAVEL_CLAIM_FORM, "off"), { agentAccess: "always" });
    expect(setup.registration.access()).toEqual({ state: "live" });
    expect((await setup.ok("describe_form")).agentAccess).toBe("on");
    await setup.ok("set_answers", { answers: { traveller: "Ana Silva" } });
  });

  it("the default node host (no option) is live over every fixture", async () => {
    for (const definition of [AGENT_JOURNEY_FORM, AGENT_STEPS_FORM, AGENT_SIGNING_BUTTON_FORM, AGENT_PARTICIPANTS_FORM, AGENT_SINGLE_FORM, TRAVEL_CLAIM_FORM]) {
      const setup = agentSetup(definition);
      expect(setup.host.agentAccess?.(), definition.id).toBe("always");
      expect(setup.registration.access(), definition.id).toEqual({ state: "live" });
      expect((await setup.ok("describe_form")).agentAccess, definition.id).toBe("on");
    }
  });
});

describe("the two-form listing", () => {
  it("lists a sealed form with its title, the counts zeroed, state off and by; form-required and form-unknown list the same rows", async () => {
    const registrar = createAgentRegistrar();
    const open = runtimeAgentHost(agentRuntime(withAgentTools(TRAVEL_CLAIM_FORM, "allowed")), { id: "travel-claim", agentAccess: "definition", journeyKit: EagerJourneyRenderKit });
    const closed = runtimeAgentHost(agentRuntime(withAgentTools(AGENT_SINGLE_FORM, "off")), { id: "declaration", agentAccess: "definition", journeyKit: EagerJourneyRenderKit });
    registrar.registerForm({ host: open, catalogue: createFormAgentTools, signal: new AbortController().signal });
    registrar.registerForm({ host: closed, catalogue: createFormAgentTools, signal: new AbortController().signal });
    const listing = (await registrar.execute("describe_form", {})) as unknown as Row;
    const rows = listing.forms as Row[];
    expect(rows[0]).toMatchObject({ form: "travel-claim", formId: "travel-claim", title: "Agent travel-claim", session: false });
    expect(rows[0]).not.toHaveProperty("state");
    expect(rows[1]).toEqual({ form: "declaration", title: "Agent single", fields: 0, pages: 0, locale: "", session: false, state: "off", by: "author" });
    const required = (await registrar.execute("set_answers", { answers: { traveller: "Ana" } })) as AgentRefusal;
    expect(required.code).toBe("form-required");
    expect((required.details as Row).forms).toEqual(rows);
    const unknown = (await registrar.execute("set_answers", { form: "nope", answers: { traveller: "Ana" } })) as AgentRefusal;
    expect(unknown.code).toBe("form-unknown");
    expect((unknown.details as Row).forms).toEqual(rows);
    // By handle: the sealed one refuses, the live one writes; a session on the sealed one is refused.
    expect(((await registrar.execute("set_answers", { form: "declaration", answers: { name: "Ana" } })) as AgentRefusal).code).toBe("agent-off");
    expect(((await registrar.execute("begin_session", { form: "declaration", purpose: "Fill it" })) as AgentRefusal).code).toBe("agent-off");
    expect((await registrar.execute("set_answers", { form: "travel-claim", answers: { traveller: "Ana" } })).ok).toBe(true);
  });
});

describe("gate order and flips", () => {
  it("judges readiness first: a loading sealed form answers form-not-ready, retryable", async () => {
    let build: "loading" | "ready" = "loading";
    const setup = agentSetup(withAgentTools(TRAVEL_CLAIM_FORM, "off"), { agentAccess: "definition", host: { buildState: () => build } });
    const loading = await setup.refused("set_answers", { answers: { traveller: "Ana" } });
    expect(loading).toMatchObject({ code: "form-not-ready", retryable: true, details: { state: "loading" } });
    expect((await setup.refused("describe_form")).code).toBe("form-not-ready");
    build = "ready";
    expect((await setup.refused("set_answers", { answers: { traveller: "Ana" } })).code).toBe("agent-off");
  });

  it("a definition swap through runtimeReplaced() then accessChanged() flips live and sealed and ends an open session rebuilt once", async () => {
    let current = agentRuntime(withAgentTools(TRAVEL_CLAIM_FORM, "allowed"));
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { agentAccess: "definition", host: { runtime: () => current } });
    await setup.ok("begin_session", { purpose: "Fill the claim" });
    const before = setup.registration.revision();
    current = agentRuntime(withAgentTools(TRAVEL_CLAIM_FORM, "off"));
    setup.registration.runtimeReplaced();
    setup.registration.accessChanged();
    expect(setup.registration.access()).toEqual({ state: "sealed", by: "author" });
    // runtimeReplaced bumped once and ended the session; the flip bumped once more and found no session.
    expect(setup.registration.revision()).toBe(before + 2);
    const ends = setup.host.calls.filter(
      (call) => call.method === "emit" && call.args[0] === "datum-agent-session" && (call.args[1] as Row).phase === "end"
    );
    expect(ends.map((call) => (call.args[1] as Row).reason)).toEqual(["rebuilt"]);
    const sealed = await setup.ok("describe_form");
    expect(sealed).toMatchObject({ agentAccess: "off", sessionEnded: { reason: "rebuilt", undone: 0 } });
    // And back: a swap to "allowed" goes live.
    current = agentRuntime(withAgentTools(TRAVEL_CLAIM_FORM, "allowed"));
    setup.registration.runtimeReplaced();
    setup.registration.accessChanged();
    expect((await setup.ok("describe_form")).agentAccess).toBe("on");
  });

  it("accessChanged() with no change bumps nothing", () => {
    const setup = agentSetup(withAgentTools(TRAVEL_CLAIM_FORM, "off"), { agentAccess: "definition" });
    const revision = setup.registration.revision();
    setup.registration.accessChanged();
    setup.registration.accessChanged();
    expect(setup.registration.revision()).toBe(revision);
  });

  it("a host policy flip (always ↔ definition) through accessChanged() needs no rebuild", async () => {
    let policy: "always" | "definition" = "always";
    const setup = agentSetup(withAgentTools(TRAVEL_CLAIM_FORM, "off"), { hostOverrides: { agentAccess: () => policy } });
    const runtime = setup.host.runtime();
    expect((await setup.ok("describe_form")).agentAccess).toBe("on");
    policy = "definition";
    setup.registration.accessChanged();
    expect((await setup.ok("describe_form")).agentAccess).toBe("off");
    policy = "always";
    setup.registration.accessChanged();
    expect((await setup.ok("describe_form")).agentAccess).toBe("on");
    expect(setup.host.runtime()).toBe(runtime);
  });

  it("a throwing access read is logged and answered sealed unset (fails closed)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const setup = agentSetup(withAgentTools(TRAVEL_CLAIM_FORM, "allowed"), {
      hostOverrides: {
        agentAccess: () => {
          throw new Error("policy gone");
        }
      }
    });
    expect(setup.registration.access()).toEqual({ state: "sealed", by: "unset" });
    expect((await setup.refused("set_answers", { answers: { traveller: "Ana" } })).details).toEqual({ by: "unset" });
    // describe_form, which the gate lets through, answers the minimal sealed result from the same
    // guarded read: never an `internal` refusal carrying the host's error text and a retry hint.
    const described = await setup.execute("describe_form", {});
    expect(described).toMatchObject({ ok: true, agentAccess: "off", guidance: [UNSET_GUIDANCE] });
    expect(JSON.stringify(described)).not.toContain("policy gone");
    expect(error).toHaveBeenCalledWith("[datum-agent] catalogue.access", expect.any(Error));
    error.mockRestore();
  });
});

describe("provenance on a sealed form (the engine half)", () => {
  it("every write tool refused leaves no journal entry, no agent mark and involved false", async () => {
    let policy: "always" | "definition" = "definition";
    const setup = agentSetup(withAgentTools(TRAVEL_CLAIM_FORM, "off"), { drafts: {}, host: { pdf: { layouts: TRAVEL_CLAIM_LAYOUTS } }, hostOverrides: { agentAccess: () => policy } });
    for (const [name, input] of OTHER_CALLS) {
      expect((await setup.execute(name, input)).ok, name).toBe(false);
    }
    expect(setup.runtime.formValues().traveller).toBeUndefined();
    expect(setup.registration.provenance("page")).toMatchObject({ involved: false, paths: [], tables: [], sessions: 0, sessionOpen: false });
    // Live again (the host enforces): the journal is empty and no answer is marked as the agent's.
    policy = "always";
    setup.registration.accessChanged();
    expect((await setup.refused("undo_agent_changes")).code).toBe("nothing-to-undo");
    const answers = await setup.ok("get_answers", { scope: "all", includeEmpty: true });
    expect(JSON.stringify(answers)).not.toContain('"lastWriter":"agent"');
  });

  it("a registration live then sealed keeps its account (involved, paths)", async () => {
    let policy: "always" | "definition" = "always";
    const setup = agentSetup(withAgentTools(TRAVEL_CLAIM_FORM, "off"), { hostOverrides: { agentAccess: () => policy } });
    await setup.ok("set_answers", { answers: { traveller: "Ana Silva" } });
    const live = setup.registration.provenance("page");
    expect(live).toMatchObject({ involved: true, paths: ["traveller"] });
    policy = "definition";
    setup.registration.accessChanged();
    expect(setup.registration.access()).toEqual({ state: "sealed", by: "author" });
    expect(setup.registration.provenance("page")).toEqual(live);
    // Sealed, undo is refused like every other write; the journal is kept for a later live period.
    expect((await setup.refused("undo_agent_changes")).code).toBe("agent-off");
    policy = "always";
    setup.registration.accessChanged();
    expect((await setup.ok("undo_agent_changes")).ok).toBe(true);
    expect(setup.runtime.formValues().traveller).toBeUndefined();
  });
});
